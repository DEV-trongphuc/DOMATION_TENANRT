import crypto from 'node:crypto';
import { Router } from 'express';
import { withTenantTransaction } from '../../core/database/transaction.ts';
import { getTenantContext } from '../../core/context/tenant-context.ts';
import { hashPassword, verifyPassword } from '../../core/crypto/password.ts';
import {
  requireEntitlement,
  requirePermission,
  requireTenantAuth,
  sendApiError,
} from '../../core/security/rbac.ts';
import {
  clampLimit,
  ensureErpOpsSchema,
  parseJsonSafe,
} from '../erp-ops/schema.ts';
import { ensureHrmApprovalsSchema } from '../hrm/schema.ts';

export const router = Router();

router.use(requireTenantAuth);
router.use(async (_req, _res, next) => {
  try {
    await Promise.all([ensureErpOpsSchema(), ensureHrmApprovalsSchema()]);
    next();
  } catch (err) {
    next(err);
  }
});

// ============================================================================
// 0. Personal Account Self-Service (`/my-account`) — Available on ALL 4 Packages
// ============================================================================
router.get('/my-account', async (_req, res) => {
  try {
    const ctx = getTenantContext();
    const data = await withTenantTransaction(ctx.tenantId, async (client) => {
      const [uRes, empRes, assetsRes, tenantRes] = await Promise.all([
        client.query(
          `SELECT id, full_name, email, phone, role, avatar_url, branch_id, department_id, team_id,
                  is_tenant_owner, last_login_at, created_at
           FROM users
           WHERE tenant_id = $1 AND id = $2
           LIMIT 1`,
          [ctx.tenantId, ctx.userId]
        ),
        client.query(
          `SELECT * FROM tenant_hr_employees
           WHERE tenant_id = $1 AND user_id = $2
           LIMIT 1`,
          [ctx.tenantId, ctx.userId]
        ),
        client.query(
          `SELECT a.*
           FROM tenant_hr_handover_assets a
           INNER JOIN tenant_hr_employees e ON e.tenant_id = a.tenant_id AND e.id = a.employee_id
           WHERE a.tenant_id = $1 AND e.user_id = $2
           ORDER BY a.handed_over_at DESC`,
          [ctx.tenantId, ctx.userId]
        ),
        client.query('SELECT name, settings FROM tenants WHERE id = $1 LIMIT 1', [ctx.tenantId]),
      ]);

      const u = uRes.rows[0] || {};
      const emp = empRes.rows[0] || null;
      const settings = parseJsonSafe<Record<string, unknown>>(tenantRes.rows[0]?.settings, {});
      const sigMap = parseJsonSafe<Record<string, string>>(settings.user_signatures, {});
      const twoFactorMap = parseJsonSafe<Record<string, boolean>>(settings.user_two_factor, {});

      return {
        user: {
          ...u,
          two_factor_enabled: Boolean(twoFactorMap[ctx.userId] ?? false),
          signature_url: sigMap[ctx.userId] || (emp ? (emp as Record<string, unknown>).signature_url : null) || null,
        },
        employee: emp,
        assigned_assets: assetsRes.rows,
        company_name: String(tenantRes.rows[0]?.name || 'Doanh nghiệp'),
      };
    });

    res.json({ success: true, data });
  } catch (err: any) {
    sendApiError(res, 500, 'GET_MY_ACCOUNT_FAILED', err?.message || 'Không thể tải hồ sơ cá nhân.');
  }
});

const updateMyAccountHandler = async (req: any, res: any) => {
  try {
    const ctx = getTenantContext();
    const b = req.body || {};

    const updated = await withTenantTransaction(ctx.tenantId, async (client) => {
      const fullName = b.full_name || b.name ? String(b.full_name || b.name).trim() : null;
      const phone = b.phone !== undefined ? (b.phone ? String(b.phone).trim() : null) : undefined;
      const avatarUrl = b.avatar_url || b.avatar ? String(b.avatar_url || b.avatar).trim() : undefined;

      if (fullName || phone !== undefined || avatarUrl !== undefined) {
        await client.query(
          `UPDATE users
           SET full_name = COALESCE($3, full_name),
               phone = CASE WHEN $4 = 1 THEN $5 ELSE phone END,
               avatar_url = CASE WHEN $6 = 1 THEN $7 ELSE avatar_url END,
               updated_at = clock_timestamp()
           WHERE tenant_id = $1 AND id = $2`,
          [
            ctx.tenantId,
            ctx.userId,
            fullName,
            phone !== undefined ? 1 : 0,
            phone ?? null,
            avatarUrl !== undefined ? 1 : 0,
            avatarUrl ?? null,
          ]
        );
      }

      // Sync optional employee HR self-service fields if employee record exists
      const empRes = await client.query<{ id: string }>(
        'SELECT id FROM tenant_hr_employees WHERE tenant_id = $1 AND user_id = $2 LIMIT 1',
        [ctx.tenantId, ctx.userId]
      );
      if (empRes.rows[0]) {
        await client.query(
          `UPDATE tenant_hr_employees
           SET full_name = COALESCE($3, full_name),
               phone = COALESCE($4, phone),
               id_card_number = COALESCE($5, id_card_number),
               bank_name = COALESCE($6, bank_name),
               bank_account_number = COALESCE($7, bank_account_number),
               address = COALESCE($8, address),
               updated_at = clock_timestamp()
           WHERE tenant_id = $1 AND id = $2`,
          [
            ctx.tenantId,
            empRes.rows[0].id,
            fullName,
            b.phone ? String(b.phone).trim() : null,
            b.citizen_id || b.id_card_number ? String(b.citizen_id || b.id_card_number).trim() : null,
            b.bank_name ? String(b.bank_name).trim() : null,
            b.bank_account || b.bank_account_number ? String(b.bank_account || b.bank_account_number).trim() : null,
            b.address ? String(b.address).trim() : null,
          ]
        );
      }

      if (typeof b.signature_url === 'string') {
        const tRes = await client.query<{ settings: unknown }>(
          'SELECT settings FROM tenants WHERE id = $1 LIMIT 1',
          [ctx.tenantId]
        );
        const settings = parseJsonSafe<Record<string, unknown>>(tRes.rows[0]?.settings, {});
        const sigMap = parseJsonSafe<Record<string, string>>(settings.user_signatures, {});
        sigMap[ctx.userId] = b.signature_url;
        settings.user_signatures = sigMap;
        await client.query(
          'UPDATE tenants SET settings = $2::jsonb, updated_at = clock_timestamp() WHERE id = $1',
          [ctx.tenantId, JSON.stringify(settings)]
        );
      }

      const fresh = await client.query(
        `SELECT id, full_name, email, phone, role, avatar_url, branch_id, department_id, is_tenant_owner
         FROM users WHERE tenant_id = $1 AND id = $2 LIMIT 1`,
        [ctx.tenantId, ctx.userId]
      );
      return {
        ...fresh.rows[0],
        signature_url: typeof b.signature_url === 'string' ? b.signature_url : undefined,
      };
    });

    res.json({ success: true, data: updated });
  } catch (err: any) {
    sendApiError(res, 500, 'UPDATE_MY_ACCOUNT_FAILED', err?.message || 'Không thể cập nhật thông tin tài khoản.');
  }
};

router.put('/my-account', updateMyAccountHandler);
router.patch('/my-account', updateMyAccountHandler);

router.post('/my-account/change-password', async (req, res) => {
  try {
    const ctx = getTenantContext();
    const oldPassword = String(req.body?.old_password || req.body?.oldPassword || '');
    const newPassword = String(req.body?.new_password || req.body?.newPassword || '');

    if (!oldPassword || newPassword.length < 8) {
      sendApiError(res, 422, 'INVALID_PASSWORD', 'Mật khẩu mới phải có tối thiểu 8 ký tự.');
      return;
    }

    const result = await withTenantTransaction(ctx.tenantId, async (client) => {
      const uRes = await client.query<{ id: string; password_hash: string }>(
        'SELECT id, password_hash FROM users WHERE tenant_id = $1 AND id = $2 LIMIT 1',
        [ctx.tenantId, ctx.userId]
      );
      if (!uRes.rows[0]) return { error: 'USER_NOT_FOUND' as const };
      const ok = await verifyPassword(oldPassword, uRes.rows[0].password_hash);
      if (!ok) return { error: 'WRONG_OLD_PASSWORD' as const };

      const nextHash = await hashPassword(newPassword);
      await client.query(
        'UPDATE users SET password_hash = $3, updated_at = clock_timestamp() WHERE tenant_id = $1 AND id = $2',
        [ctx.tenantId, ctx.userId, nextHash]
      );
      return { ok: true as const };
    });

    if ('error' in result) {
      if (result.error === 'WRONG_OLD_PASSWORD') {
        sendApiError(res, 403, 'WRONG_OLD_PASSWORD', 'Mật khẩu hiện tại không chính xác.');
        return;
      }
      sendApiError(res, 404, 'USER_NOT_FOUND', 'Không tìm thấy tài khoản.');
      return;
    }

    res.json({ success: true, data: { updated: true } });
  } catch (err: any) {
    sendApiError(res, 500, 'CHANGE_PASSWORD_FAILED', err?.message || 'Không thể đổi mật khẩu.');
  }
});

router.get('/my-account/activity-logs', async (_req, res) => {
  try {
    const ctx = getTenantContext();
    const items = await withTenantTransaction(ctx.tenantId, async (client) => {
      const r = await client.query(
        `SELECT id, action, entity_type, entity_id, details AS metadata, ip_address, created_at
         FROM admin_audit_logs
         WHERE tenant_id = $1 AND actor_id = $2
         ORDER BY created_at DESC
         LIMIT 50`,
        [ctx.tenantId, ctx.userId]
      );
      return r.rows.map((row) => ({
        ...row,
        metadata: parseJsonSafe(row.metadata, {}),
      }));
    });
    res.json({ success: true, data: { items } });
  } catch (err: any) {
    sendApiError(res, 500, 'LIST_ACTIVITY_LOGS_FAILED', err?.message || 'Không thể tải nhật ký hoạt động.');
  }
});

// Gate WorkChat channels, feed & kudos under `erp_workchat` entitlement
router.use(requireEntitlement('erp_workchat'));

export interface CommercialStickerPackMeta {
  id: string;
  name: string;
  count: number;
  is_mascot_pack?: boolean;
  sample_emojis: string[];
}

export interface QuickWorkStatusStickerMeta {
  id: string;
  label: string;
  badge_text: string;
  icon: string;
  tone: 'success' | 'primary' | 'warning' | 'danger' | 'info' | 'purple';
}

const COMMERCIAL_STICKER_PACKS: CommercialStickerPackMeta[] = [
  { id: 'ghost', name: 'Ghost Cute', count: 14, sample_emojis: ['👻', '✨', '💫', '🥳', '🎉', '🙌'] },
  { id: 'maruko', name: 'Maruko', count: 20, sample_emojis: ['😊', '🌸', '🍵', '🎶', '📚', '🌞'] },
  { id: 'smalldog', name: 'Cún Con Năng Động', count: 16, sample_emojis: ['🐶', '🐾', '🦴', '💛', '🏃', '🎾'] },
  { id: 'girl', name: 'Office Girl', count: 14, sample_emojis: ['👩‍💻', '☕', '📝', '💼', '💡', '🌟'] },
  { id: 'seal', name: 'Hải Cẩu Vui Vẻ', count: 8, sample_emojis: ['🦭', '🌊', '👏', '🐟', '💙', '😴'] },
  { id: 'meep', name: 'Meep Biểu Cảm', count: 16, sample_emojis: ['😎', '🤔', '🔥', '🚀', '👍', '🎯'] },
  { id: 'foxlove', name: 'Fox Love', count: 16, sample_emojis: ['🦊', '🧡', '🍀', '🎁', '💌', '🌈'] },
  { id: 'buffalo', name: 'Trâu Chăm Chỉ', count: 11, sample_emojis: ['🐃', '💪', '⚡', '🏆', '📈', '🌾'] },
  { id: 'minion', name: 'Minion Đồng Đội', count: 20, sample_emojis: ['🤩', '🍌', '🎊', '🤝', '🔔', '👑'] },
];

const OPTIONAL_MASCOT_PACK: CommercialStickerPackMeta = {
  id: 'ideas',
  name: 'Brand Mascot Pack',
  count: 48,
  is_mascot_pack: true,
  sample_emojis: ['🤖', '💙'],
};

const QUICK_WORK_STATUS_BADGES: QuickWorkStatusStickerMeta[] = [
  { id: 'da_duyet', label: 'Đã duyệt', badge_text: 'ĐÃ PHÊ DUYỆT', icon: '✅', tone: 'success' },
  { id: 'dang_xu_ly', label: 'Đang xử lý', badge_text: 'ĐANG XỬ LÝ', icon: '⚙️', tone: 'primary' },
  { id: 'can_gap', label: 'Cần gấp', badge_text: 'ƯU TIÊN KHẨN CẤP', icon: '🚨', tone: 'danger' },
  { id: 'hoan_thanh', label: 'Hoàn thành', badge_text: 'HOÀN THÀNH 100%', icon: '🏁', tone: 'success' },
  { id: 'chot_don', label: 'Chốt đơn', badge_text: 'CHỐT DEAL THÀNH CÔNG', icon: '🎯', tone: 'warning' },
  { id: 'hop_gap', label: 'Họp gấp', badge_text: 'MỜI HỌP NHANH', icon: '📅', tone: 'danger' },
  { id: 'nhac_deadline', label: 'Nhắc Deadline', badge_text: 'SẮP ĐẾN HẠN DEADLINE', icon: '⏳', tone: 'warning' },
  { id: 'xuat_sac', label: 'Xuất sắc', badge_text: 'KẾT QUẢ XUẤT SẮC', icon: '🌟', tone: 'purple' },
  { id: 'ok_nhat_tri', label: 'OK Nhất trí', badge_text: 'ĐỒNG Ý TRIỂN KHAI', icon: '👍', tone: 'primary' },
  { id: 'cam_on', label: 'Cảm ơn', badge_text: 'CẢM ƠN ĐỒNG ĐỘI', icon: '💖', tone: 'info' },
  { id: 'da_nhan_viec', label: 'Đã nhận việc', badge_text: 'ĐÃ TIẾP NHẬN YÊU CẦU', icon: '📌', tone: 'info' },
  { id: 'cho_phan_hoi', label: 'Chờ phản hồi', badge_text: 'ĐANG CHỜ XÁC NHẬN', icon: '💬', tone: 'warning' },
];

async function isTenantMascotEnabled(
  client: Parameters<Parameters<typeof withTenantTransaction>[1]>[0],
  tenantId: string
): Promise<boolean> {
  const r = await client.query<{ entitlements: unknown; settings: unknown }>(
    'SELECT entitlements, settings FROM tenants WHERE id = $1 LIMIT 1',
    [tenantId]
  );
  const ent = parseJsonSafe<Record<string, unknown>>(r.rows[0]?.entitlements, {});
  const settings = parseJsonSafe<Record<string, unknown>>(r.rows[0]?.settings, {});
  if (typeof ent.enable_ideas_mascot === 'boolean') return ent.enable_ideas_mascot;
  if (typeof settings.enable_ideas_mascot === 'boolean') return settings.enable_ideas_mascot;
  return false;
}

// ============================================================================
// 1. WorkChat Bootstrap (Channels + Mascot-Safe Sticker Packs + Presence + Staff)
// ============================================================================
router.get('/bootstrap', requirePermission('workchat', 'view'), async (_req, res) => {
  try {
    const ctx = getTenantContext();
    const data = await withTenantTransaction(ctx.tenantId, async (client) => {
      const enableIdeasMascot = await isTenantMascotEnabled(client, ctx.tenantId);

      // Auto-seed default company channel if tenant has 0 channels
      const chCheck = await client.query<{ id: string }>(
        'SELECT id FROM tenant_workchat_channels WHERE tenant_id = $1 LIMIT 1',
        [ctx.tenantId]
      );
      if (!chCheck.rows[0]) {
        const genId = crypto.randomUUID();
        await client.query(
          `INSERT INTO tenant_workchat_channels (
             id, tenant_id, name, channel_type, topic, created_by, last_message_preview
           ) VALUES ($1, $2, $3, 'announcement', $4, $5, $6)`,
          [
            genId,
            ctx.tenantId,
            'Kênh Chung Toàn Công Ty',
            'Thông báo điều hành & phối hợp liên phòng ban',
            ctx.userId,
            'Chào mừng đội ngũ đến với không gian WorkChat doanh nghiệp!',
          ]
        );
        await client.query(
          `INSERT INTO tenant_workchat_members (id, tenant_id, channel_id, user_id, member_role)
           VALUES ($1, $2, $3, $4, 'owner')
           ON CONFLICT (tenant_id, channel_id, user_id) DO NOTHING`,
          [crypto.randomUUID(), ctx.tenantId, genId, ctx.userId]
        );
      }

      // Touch actor presence as online
      await client.query(
        `INSERT INTO tenant_workchat_presence (id, tenant_id, user_id, status, last_seen_at)
         VALUES ($1, $2, $3, 'online', clock_timestamp())
         ON CONFLICT (tenant_id, user_id) DO UPDATE SET last_seen_at = clock_timestamp()`,
        [crypto.randomUUID(), ctx.tenantId, ctx.userId]
      );

      const [channelsRes, presenceRes, staffRes, deptsRes] = await Promise.all([
        client.query(
          `SELECT c.*,
                  d.name AS department_name,
                  p.name AS project_name,
                  (SELECT COUNT(*)::int FROM tenant_workchat_messages m WHERE m.tenant_id = c.tenant_id AND m.channel_id = c.id AND m.is_deleted = false) AS message_count
           FROM tenant_workchat_channels c
           LEFT JOIN tenant_departments d ON d.tenant_id = c.tenant_id AND d.id = c.department_id
           LEFT JOIN tenant_projects p ON p.tenant_id = c.tenant_id AND p.id = c.project_id
           WHERE c.tenant_id = $1 AND c.is_archived = false
           ORDER BY c.last_message_at DESC, c.created_at ASC`,
          [ctx.tenantId]
        ),
        client.query(
          `SELECT pr.user_id, pr.status, pr.status_text, pr.last_seen_at, u.full_name, u.role
           FROM tenant_workchat_presence pr
           INNER JOIN users u ON u.tenant_id = pr.tenant_id AND u.id = pr.user_id
           WHERE pr.tenant_id = $1`,
          [ctx.tenantId]
        ),
        client.query(
          `SELECT id, full_name, email, role, department_id, branch_id
           FROM users
           WHERE tenant_id = $1 AND is_system_bot = false
           ORDER BY full_name ASC`,
          [ctx.tenantId]
        ),
        client.query(
          'SELECT id, name, code FROM tenant_departments WHERE tenant_id = $1 AND is_active = true ORDER BY sort_order ASC',
          [ctx.tenantId]
        ),
      ]);

      const stickerPacks = enableIdeasMascot
        ? [OPTIONAL_MASCOT_PACK, ...COMMERCIAL_STICKER_PACKS]
        : [...COMMERCIAL_STICKER_PACKS];

      return {
        enable_ideas_mascot: enableIdeasMascot,
        sticker_packs: stickerPacks,
        work_status_badges: QUICK_WORK_STATUS_BADGES,
        channels: channelsRes.rows.map((c) => ({
          ...c,
          message_count: Number(c.message_count || 0),
        })),
        presence: presenceRes.rows,
        staff: staffRes.rows,
        departments: deptsRes.rows,
      };
    });

    res.json({ success: true, data });
  } catch (err: any) {
    sendApiError(res, 500, 'WORKCHAT_BOOTSTRAP_FAILED', err?.message || 'Không thể khởi tạo WorkChat.');
  }
});

// ============================================================================
// 2. Channels & Real-time Messages + Threads + Pins + Reactions + Search
// ============================================================================
router.get('/channels', requirePermission('workchat', 'view'), async (_req, res) => {
  try {
    const ctx = getTenantContext();
    const items = await withTenantTransaction(ctx.tenantId, async (client) => {
      const r = await client.query(
        `SELECT * FROM tenant_workchat_channels
         WHERE tenant_id = $1 AND is_archived = false
         ORDER BY last_message_at DESC, created_at ASC`,
        [ctx.tenantId]
      );
      return r.rows;
    });
    res.json({ success: true, data: { items } });
  } catch (err: any) {
    sendApiError(res, 500, 'LIST_CHANNELS_FAILED', err?.message || 'Không thể tải danh sách kênh chat.');
  }
});

router.post('/channels', requirePermission('workchat', 'create'), async (req, res) => {
  try {
    const ctx = getTenantContext();
    const body = req.body || {};
    const name = String(body.name || '').trim();
    if (!name) {
      sendApiError(res, 422, 'CHANNEL_NAME_REQUIRED', 'Vui lòng nhập tên kênh trò chuyện.');
      return;
    }

    const channelType = ['direct', 'department', 'project', 'group', 'announcement'].includes(
      String(body.channel_type)
    )
      ? String(body.channel_type)
      : 'group';

    const created = await withTenantTransaction(ctx.tenantId, async (client) => {
      const id = crypto.randomUUID();
      await client.query(
        `INSERT INTO tenant_workchat_channels (
           id, tenant_id, name, channel_type, topic, department_id, project_id, created_by
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [
          id,
          ctx.tenantId,
          name,
          channelType,
          body.topic ? String(body.topic) : null,
          body.department_id || null,
          body.project_id || null,
          ctx.userId,
        ]
      );

      const memberIds = new Set<string>([ctx.userId]);
      if (Array.isArray(body.member_user_ids)) {
        for (const uid of body.member_user_ids) {
          if (typeof uid === 'string' && uid.trim()) memberIds.add(uid.trim());
        }
      }
      for (const uid of memberIds) {
        await client.query(
          `INSERT INTO tenant_workchat_members (id, tenant_id, channel_id, user_id, member_role)
           VALUES ($1, $2, $3, $4, $5)
           ON CONFLICT (tenant_id, channel_id, user_id) DO NOTHING`,
          [crypto.randomUUID(), ctx.tenantId, id, uid, uid === ctx.userId ? 'owner' : 'member']
        );
      }

      const r = await client.query('SELECT * FROM tenant_workchat_channels WHERE tenant_id = $1 AND id = $2', [
        ctx.tenantId,
        id,
      ]);
      return r.rows[0];
    });

    res.status(201).json({ success: true, data: created });
  } catch (err: any) {
    sendApiError(res, 500, 'CREATE_CHANNEL_FAILED', err?.message || 'Không thể tạo kênh trò chuyện mới.');
  }
});

router.get('/channels/:id/messages', requirePermission('workchat', 'view'), async (req, res) => {
  try {
    const ctx = getTenantContext();
    const channelId = req.params.id;
    const pinnedOnly = req.query.pinned === 'true';
    const limit = clampLimit(req.query.limit, 100, 300);

    const data = await withTenantTransaction(ctx.tenantId, async (client) => {
      const ch = await client.query('SELECT * FROM tenant_workchat_channels WHERE tenant_id = $1 AND id = $2 LIMIT 1', [
        ctx.tenantId,
        channelId,
      ]);
      if (!ch.rows[0]) return null;

      let sql = `
        SELECT m.*,
               pm.sender_name AS parent_sender_name,
               pm.content AS parent_content
        FROM tenant_workchat_messages m
        LEFT JOIN tenant_workchat_messages pm ON pm.tenant_id = m.tenant_id AND pm.id = m.parent_message_id
        WHERE m.tenant_id = $1 AND m.channel_id = $2 AND m.is_deleted = false
      `;
      if (pinnedOnly) {
        sql += ' AND m.is_pinned = true';
      }
      sql += ` ORDER BY m.created_at ASC LIMIT ${limit}`;

      const r = await client.query(sql, [ctx.tenantId, channelId]);
      return {
        channel: ch.rows[0],
        items: r.rows.map((row) => ({
          ...row,
          attachments: parseJsonSafe(row.attachments_json, []),
          reactions: parseJsonSafe(row.reactions_json, {}),
        })),
      };
    });

    if (!data) {
      sendApiError(res, 404, 'CHANNEL_NOT_FOUND', 'Không tìm thấy kênh trò chuyện.');
      return;
    }
    res.json({ success: true, data });
  } catch (err: any) {
    sendApiError(res, 500, 'LIST_MESSAGES_FAILED', err?.message || 'Không thể tải tin nhắn kênh.');
  }
});

router.post('/channels/:id/messages', requirePermission('workchat', 'create'), async (req, res) => {
  try {
    const ctx = getTenantContext();
    const channelId = req.params.id;
    const body = req.body || {};

    const msgType = ['text', 'sticker', 'work_badge', 'attachment', 'card_link'].includes(String(body.message_type))
      ? String(body.message_type)
      : 'text';
    const content = String(body.content || '').trim();
    const stickerPackId = body.sticker_pack_id ? String(body.sticker_pack_id).trim().toLowerCase() : null;
    const stickerId = body.sticker_id ? String(body.sticker_id).trim() : null;
    const attachments = Array.isArray(body.attachments) ? body.attachments : [];

    if (!content && !stickerId && attachments.length === 0) {
      sendApiError(res, 422, 'EMPTY_MESSAGE', 'Nội dung tin nhắn không được để trống.');
      return;
    }

    const result = await withTenantTransaction(ctx.tenantId, async (client) => {
      const ch = await client.query('SELECT id FROM tenant_workchat_channels WHERE tenant_id = $1 AND id = $2 LIMIT 1', [
        ctx.tenantId,
        channelId,
      ]);
      if (!ch.rows[0]) return { error: 'CHANNEL_NOT_FOUND' as const };

      if (stickerPackId === 'ideas') {
        const allowMascot = await isTenantMascotEnabled(client, ctx.tenantId);
        if (!allowMascot) {
          return { error: 'MASCOT_PACK_DISABLED' as const };
        }
      }

      const id = crypto.randomUUID();
      const previewText =
        content ||
        (msgType === 'work_badge' ? `[Nhãn công việc] ${stickerId}` : msgType === 'sticker' ? '[Nhãn dán]' : '[Đính kèm]');

      await client.query(
        `INSERT INTO tenant_workchat_messages (
           id, tenant_id, channel_id, sender_user_id, sender_name, parent_message_id,
           message_type, content, sticker_pack_id, sticker_id, attachments_json
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::jsonb)`,
        [
          id,
          ctx.tenantId,
          channelId,
          ctx.userId,
          ctx.userName || 'Thành viên',
          body.parent_message_id || null,
          msgType,
          content || previewText,
          stickerPackId,
          stickerId,
          JSON.stringify(attachments),
        ]
      );

      await client.query(
        `UPDATE tenant_workchat_channels
         SET last_message_at = clock_timestamp(),
             last_message_preview = $3,
             updated_at = clock_timestamp()
         WHERE tenant_id = $1 AND id = $2`,
        [ctx.tenantId, channelId, previewText.slice(0, 240)]
      );

      const r = await client.query('SELECT * FROM tenant_workchat_messages WHERE tenant_id = $1 AND id = $2', [
        ctx.tenantId,
        id,
      ]);
      const row = r.rows[0];
      return {
        data: {
          ...row,
          attachments: parseJsonSafe(row.attachments_json, []),
          reactions: parseJsonSafe(row.reactions_json, {}),
        },
      };
    });

    if (result.error === 'CHANNEL_NOT_FOUND') {
      sendApiError(res, 404, 'CHANNEL_NOT_FOUND', 'Không tìm thấy kênh trò chuyện.');
      return;
    }
    if (result.error === 'MASCOT_PACK_DISABLED') {
      sendApiError(
        res,
        403,
        'MASCOT_PACK_DISABLED',
        'Bộ nhãn dán Mascot riêng hiện đang tắt cho doanh nghiệp này. Vui lòng sử dụng 9 bộ sticker thương mại hoặc 12 nhãn trạng thái công việc.'
      );
      return;
    }

    res.status(201).json({ success: true, data: result.data });
  } catch (err: any) {
    sendApiError(res, 500, 'SEND_MESSAGE_FAILED', err?.message || 'Không thể gửi tin nhắn.');
  }
});

router.patch('/messages/:id/pin', requirePermission('workchat', 'edit'), async (req, res) => {
  try {
    const ctx = getTenantContext();
    const msgId = req.params.id;

    const updated = await withTenantTransaction(ctx.tenantId, async (client) => {
      const cur = await client.query<{ id: string; is_pinned: boolean }>(
        'SELECT id, is_pinned FROM tenant_workchat_messages WHERE tenant_id = $1 AND id = $2 LIMIT 1',
        [ctx.tenantId, msgId]
      );
      if (!cur.rows[0]) return null;
      const nextPinned = req.body?.is_pinned !== undefined ? Boolean(req.body.is_pinned) : !cur.rows[0].is_pinned;
      await client.query(
        'UPDATE tenant_workchat_messages SET is_pinned = $3, updated_at = clock_timestamp() WHERE tenant_id = $1 AND id = $2',
        [ctx.tenantId, msgId, nextPinned]
      );
      return { id: msgId, is_pinned: nextPinned };
    });

    if (!updated) {
      sendApiError(res, 404, 'MESSAGE_NOT_FOUND', 'Không tìm thấy tin nhắn.');
      return;
    }
    res.json({ success: true, data: updated });
  } catch (err: any) {
    sendApiError(res, 500, 'PIN_MESSAGE_FAILED', err?.message || 'Không thể ghim tin nhắn.');
  }
});

router.post('/messages/:id/reactions', requirePermission('workchat', 'view'), async (req, res) => {
  try {
    const ctx = getTenantContext();
    const msgId = req.params.id;
    const emoji = String(req.body?.emoji || '👍').trim().slice(0, 12);

    const updated = await withTenantTransaction(ctx.tenantId, async (client) => {
      const cur = await client.query<{ id: string; reactions_json: unknown }>(
        'SELECT id, reactions_json FROM tenant_workchat_messages WHERE tenant_id = $1 AND id = $2 LIMIT 1',
        [ctx.tenantId, msgId]
      );
      if (!cur.rows[0]) return null;
      const map = parseJsonSafe<Record<string, string[]>>(cur.rows[0].reactions_json, {});
      const list = Array.isArray(map[emoji]) ? [...map[emoji]] : [];
      const idx = list.indexOf(ctx.userId);
      if (idx >= 0) {
        list.splice(idx, 1);
      } else {
        list.push(ctx.userId);
      }
      if (list.length === 0) {
        delete map[emoji];
      } else {
        map[emoji] = list;
      }

      await client.query(
        'UPDATE tenant_workchat_messages SET reactions_json = $3::jsonb, updated_at = clock_timestamp() WHERE tenant_id = $1 AND id = $2',
        [ctx.tenantId, msgId, JSON.stringify(map)]
      );
      return { id: msgId, reactions: map };
    });

    if (!updated) {
      sendApiError(res, 404, 'MESSAGE_NOT_FOUND', 'Không tìm thấy tin nhắn.');
      return;
    }
    res.json({ success: true, data: updated });
  } catch (err: any) {
    sendApiError(res, 500, 'REACTION_FAILED', err?.message || 'Không thể thả biểu cảm.');
  }
});

router.get('/messages/search', requirePermission('workchat', 'view'), async (req, res) => {
  try {
    const ctx = getTenantContext();
    const q = String(req.query.q || '').trim();
    if (!q) {
      res.json({ success: true, data: { items: [] } });
      return;
    }

    const items = await withTenantTransaction(ctx.tenantId, async (client) => {
      const r = await client.query(
        `SELECT m.*, c.name AS channel_name
         FROM tenant_workchat_messages m
         INNER JOIN tenant_workchat_channels c ON c.tenant_id = m.tenant_id AND c.id = m.channel_id
         WHERE m.tenant_id = $1
           AND m.is_deleted = false
           AND LOWER(m.content) LIKE LOWER($2)
         ORDER BY m.created_at DESC
         LIMIT 50`,
        [ctx.tenantId, `%${q}%`]
      );
      return r.rows;
    });

    res.json({ success: true, data: { items } });
  } catch (err: any) {
    sendApiError(res, 500, 'SEARCH_MESSAGES_FAILED', err?.message || 'Không thể tìm kiếm tin nhắn.');
  }
});

router.post('/presence/heartbeat', requirePermission('workchat', 'view'), async (req, res) => {
  try {
    const ctx = getTenantContext();
    const status = ['online', 'busy', 'away', 'offline'].includes(String(req.body?.status))
      ? String(req.body.status)
      : 'online';
    const statusText = req.body?.status_text ? String(req.body.status_text).slice(0, 120) : null;

    const data = await withTenantTransaction(ctx.tenantId, async (client) => {
      await client.query(
        `INSERT INTO tenant_workchat_presence (id, tenant_id, user_id, status, status_text, last_seen_at)
         VALUES ($1, $2, $3, $4, $5, clock_timestamp())
         ON CONFLICT (tenant_id, user_id) DO UPDATE
         SET status = EXCLUDED.status,
             status_text = EXCLUDED.status_text,
             last_seen_at = clock_timestamp()`,
        [crypto.randomUUID(), ctx.tenantId, ctx.userId, status, statusText]
      );
      return { user_id: ctx.userId, status, status_text: statusText };
    });

    res.json({ success: true, data });
  } catch (err: any) {
    sendApiError(res, 500, 'PRESENCE_UPDATE_FAILED', err?.message || 'Không thể cập nhật trạng thái trực tuyến.');
  }
});

// ============================================================================
// 2B. Media Vault, Wallpapers, Smart ERP Card Picker & Chat-to-Task
// ============================================================================
router.get('/channels/:id/vault', requirePermission('workchat', 'view'), async (req, res) => {
  try {
    const ctx = getTenantContext();
    const channelId = String(req.params.id);

    const vault = await withTenantTransaction(ctx.tenantId, async (client) => {
      const ch = await client.query(
        'SELECT id, name, channel_type, topic FROM tenant_workchat_channels WHERE tenant_id = $1 AND id = $2 LIMIT 1',
        [ctx.tenantId, channelId]
      );
      if (!ch.rows[0]) return null;

      const msgsRes = await client.query(
        `SELECT id, sender_name, message_type, content, attachments_json, is_pinned, created_at
         FROM tenant_workchat_messages
         WHERE tenant_id = $1 AND channel_id = $2 AND is_deleted = false
         ORDER BY created_at DESC
         LIMIT 300`,
        [ctx.tenantId, channelId]
      );

      const media: Array<Record<string, unknown>> = [];
      const files: Array<Record<string, unknown>> = [];
      const links: Array<Record<string, unknown>> = [];
      const erpCards: Array<Record<string, unknown>> = [];
      const pinned: Array<Record<string, unknown>> = [];

      const urlRegex = /https?:\/\/[^\s<>")]+/gi;

      for (const m of msgsRes.rows) {
        const atts = parseJsonSafe<Array<Record<string, unknown>>>(m.attachments_json, []);
        if (m.is_pinned) {
          pinned.push({
            message_id: m.id,
            sender_name: m.sender_name,
            content: m.content,
            created_at: m.created_at,
          });
        }
        if (m.message_type === 'card_link') {
          erpCards.push({
            message_id: m.id,
            sender_name: m.sender_name,
            content: m.content,
            attachments: atts,
            created_at: m.created_at,
          });
        }
        for (const a of atts) {
          const kind = String(a.kind || a.type || 'file').toLowerCase();
          const url = String(a.url || '');
          if (kind === 'image' || /\.(png|jpe?g|gif|webp)$/i.test(url)) {
            media.push({ ...a, message_id: m.id, sender_name: m.sender_name, created_at: m.created_at });
          } else if (kind === 'erp_card' || kind === 'task_card' || kind === 'voucher') {
            erpCards.push({ ...a, message_id: m.id, sender_name: m.sender_name, created_at: m.created_at });
          } else {
            files.push({ ...a, message_id: m.id, sender_name: m.sender_name, created_at: m.created_at });
          }
        }
        const matchedUrls = String(m.content || '').match(urlRegex) || [];
        for (const u of matchedUrls) {
          links.push({
            url: u,
            message_id: m.id,
            sender_name: m.sender_name,
            created_at: m.created_at,
          });
        }
      }

      return {
        channel: ch.rows[0],
        media,
        files,
        links,
        erp_cards: erpCards,
        pinned,
      };
    });

    if (!vault) {
      sendApiError(res, 404, 'CHANNEL_NOT_FOUND', 'Không tìm thấy kênh trò chuyện.');
      return;
    }

    res.json({ success: true, data: vault });
  } catch (err: any) {
    sendApiError(res, 500, 'CHANNEL_VAULT_FAILED', err?.message || 'Không thể tải kho lưu trữ kênh.');
  }
});

router.patch('/channels/:id/wallpaper', requirePermission('workchat', 'view'), async (req, res) => {
  try {
    const ctx = getTenantContext();
    const channelId = String(req.params.id);
    const wallpaperKey = String(req.body?.wallpaper_key || req.body?.wallpaper || 'sapphire_clean').trim();

    const saved = await withTenantTransaction(ctx.tenantId, async (client) => {
      const ch = await client.query('SELECT id FROM tenant_workchat_channels WHERE tenant_id = $1 AND id = $2 LIMIT 1', [
        ctx.tenantId,
        channelId,
      ]);
      if (!ch.rows[0]) return null;

      const tRes = await client.query<{ settings: unknown }>('SELECT settings FROM tenants WHERE id = $1 LIMIT 1', [
        ctx.tenantId,
      ]);
      const settings = parseJsonSafe<Record<string, unknown>>(tRes.rows[0]?.settings, {});
      const wpMap = parseJsonSafe<Record<string, string>>(settings.workchat_wallpapers, {});
      wpMap[`${ctx.userId}:${channelId}`] = wallpaperKey;
      wpMap[channelId] = wallpaperKey;
      settings.workchat_wallpapers = wpMap;

      await client.query(
        'UPDATE tenants SET settings = $2::jsonb, updated_at = clock_timestamp() WHERE id = $1',
        [ctx.tenantId, JSON.stringify(settings)]
      );
      return { channel_id: channelId, wallpaper_key: wallpaperKey };
    });

    if (!saved) {
      sendApiError(res, 404, 'CHANNEL_NOT_FOUND', 'Không tìm thấy kênh trò chuyện.');
      return;
    }
    res.json({ success: true, data: saved });
  } catch (err: any) {
    sendApiError(res, 500, 'SAVE_WALLPAPER_FAILED', err?.message || 'Không thể lưu hình nền trò chuyện.');
  }
});

router.get('/erp-cards', requirePermission('workchat', 'view'), async (req, res) => {
  try {
    const ctx = getTenantContext();
    const q = String(req.query.q || '').trim().toLowerCase();
    const cardType = String(req.query.type || 'all').trim().toLowerCase();

    const items = await withTenantTransaction(ctx.tenantId, async (client) => {
      const cards: Array<Record<string, unknown>> = [];

      if (cardType === 'all' || cardType === 'task') {
        const tRes = await client.query(
          `SELECT id, title, status_key AS status, priority, due_date
           FROM tenant_tasks
           WHERE tenant_id = $1
           ORDER BY created_at DESC LIMIT 15`,
          [ctx.tenantId]
        );
        for (const r of tRes.rows) {
          if (!q || String(r.title || '').toLowerCase().includes(q)) {
            cards.push({
              entity_type: 'task',
              entity_id: r.id,
              title: r.title,
              subtitle: `Công việc • ${r.status} (${r.priority})`,
              status: r.status,
              route: '/erp/projects',
            });
          }
        }
      }

      if (cardType === 'all' || cardType === 'approval') {
        const aRes = await client.query(
          `SELECT id, request_code, title, category, status, amount_vnd
           FROM tenant_approval_requests
           WHERE tenant_id = $1
           ORDER BY created_at DESC LIMIT 15`,
          [ctx.tenantId]
        );
        for (const r of aRes.rows) {
          if (!q || String(r.title || '').toLowerCase().includes(q) || String(r.request_code || '').toLowerCase().includes(q)) {
            cards.push({
              entity_type: 'approval',
              entity_id: r.id,
              code: r.request_code,
              title: r.title,
              subtitle: `Tờ trình ${r.request_code} • ${Number(r.amount_vnd || 0).toLocaleString('vi-VN')}₫`,
              status: r.status,
              route: '/erp/approvals',
            });
          }
        }
      }

      if (cardType === 'all' || cardType === 'deal') {
        const dRes = await client.query(
          `SELECT id, title, stage, amount_vnd
           FROM tenant_deals
           WHERE tenant_id = $1
           ORDER BY created_at DESC LIMIT 15`,
          [ctx.tenantId]
        );
        for (const r of dRes.rows) {
          if (!q || String(r.title || '').toLowerCase().includes(q)) {
            cards.push({
              entity_type: 'deal',
              entity_id: r.id,
              title: r.title,
              subtitle: `Cơ hội B2B • ${r.stage} • ${Number(r.amount_vnd || 0).toLocaleString('vi-VN')}₫`,
              status: r.stage,
              route: '/deals',
            });
          }
        }
      }

      if (cardType === 'all' || cardType === 'cooperation_slip') {
        const cRes = await client.query(
          `SELECT id, slip_code, title, status, expected_commission_vnd
           FROM tenant_cooperation_slips
           WHERE tenant_id = $1
           ORDER BY created_at DESC LIMIT 10`,
          [ctx.tenantId]
        );
        for (const r of cRes.rows) {
          if (!q || String(r.title || '').toLowerCase().includes(q)) {
            cards.push({
              entity_type: 'cooperation_slip',
              entity_id: r.id,
              code: r.slip_code,
              title: r.title,
              subtitle: `Phiếu hợp tác • Hoa hồng ${Number(r.expected_commission_vnd || 0).toLocaleString('vi-VN')}₫`,
              status: r.status,
              route: '/cooperation-slips',
            });
          }
        }
      }

      return cards.slice(0, 30);
    });

    res.json({ success: true, data: { items } });
  } catch (err: any) {
    sendApiError(res, 500, 'SEARCH_ERP_CARDS_FAILED', err?.message || 'Không thể tra cứu thẻ nghiệp vụ ERP.');
  }
});

router.post('/messages/:id/create-task', requirePermission('workchat', 'create'), async (req, res) => {
  try {
    const ctx = getTenantContext();
    const msgId = String(req.params.id);
    const b = req.body || {};

    const created = await withTenantTransaction(ctx.tenantId, async (client) => {
      const msgRes = await client.query(
        'SELECT * FROM tenant_workchat_messages WHERE tenant_id = $1 AND id = $2 LIMIT 1',
        [ctx.tenantId, msgId]
      );
      const msg = msgRes.rows[0];
      if (!msg) return null;

      // Resolve project_id from body, channel, or create/reuse default general project
      let projectId: string | null = b.project_id ? String(b.project_id) : null;
      if (!projectId) {
        const chRes = await client.query<{ project_id: string | null }>(
          'SELECT project_id FROM tenant_workchat_channels WHERE tenant_id = $1 AND id = $2 LIMIT 1',
          [ctx.tenantId, msg.channel_id]
        );
        projectId = chRes.rows[0]?.project_id || null;
      }
      if (!projectId) {
        const pRes = await client.query<{ id: string }>(
          'SELECT id FROM tenant_projects WHERE tenant_id = $1 ORDER BY created_at ASC LIMIT 1',
          [ctx.tenantId]
        );
        if (pRes.rows[0]) {
          projectId = pRes.rows[0].id;
        } else {
          projectId = crypto.randomUUID();
          await client.query(
            `INSERT INTO tenant_projects (id, tenant_id, code, name, status, owner_user_id)
             VALUES ($1, $2, 'PRJ-WORKCHAT', 'Công việc từ WorkChat', 'active', $3)`,
            [projectId, ctx.tenantId, ctx.userId]
          );
        }
      }

      const taskId = crypto.randomUUID();
      const title = String(b.title || msg.content || 'Công việc chuyển từ WorkChat').trim().slice(0, 240);
      const priority = ['low', 'medium', 'high', 'urgent'].includes(String(b.priority))
        ? String(b.priority)
        : 'medium';
      const assigneeId = b.assignee_user_id ? String(b.assignee_user_id) : ctx.userId;
      const dueDate = b.due_date ? String(b.due_date) : null;

      await client.query(
        `INSERT INTO tenant_tasks (
           id, tenant_id, project_id, title, description, status_key, priority, assignee_user_id, reporter_user_id, due_date
         ) VALUES ($1, $2, $3, $4, $5, 'todo', $6, $7, $8, $9)`,
        [
          taskId,
          ctx.tenantId,
          projectId,
          title,
          b.description ? String(b.description) : `Trích xuất từ tin nhắn WorkChat của ${msg.sender_name}: "${msg.content}"`,
          priority,
          assigneeId,
          ctx.userId,
          dueDate,
        ]
      );

      // Attach task_card reference onto the source chat message
      const curAtts = parseJsonSafe<Array<Record<string, unknown>>>(msg.attachments_json, []);
      curAtts.push({
        kind: 'task_card',
        task_id: taskId,
        title,
        priority,
        status: 'todo',
      });
      await client.query(
        'UPDATE tenant_workchat_messages SET attachments_json = $3::jsonb, updated_at = clock_timestamp() WHERE tenant_id = $1 AND id = $2',
        [ctx.tenantId, msgId, JSON.stringify(curAtts)]
      );

      const taskRow = await client.query('SELECT * FROM tenant_tasks WHERE tenant_id = $1 AND id = $2 LIMIT 1', [
        ctx.tenantId,
        taskId,
      ]);
      const row = taskRow.rows[0] || {};
      return {
        ...row,
        status: (row as Record<string, unknown>).status_key || 'todo',
      };
    });

    if (!created) {
      sendApiError(res, 404, 'MESSAGE_NOT_FOUND', 'Không tìm thấy tin nhắn cần tạo công việc.');
      return;
    }

    res.status(201).json({ success: true, data: created });
  } catch (err: any) {
    sendApiError(res, 500, 'CREATE_TASK_FROM_CHAT_FAILED', err?.message || 'Không thể tạo công việc từ tin nhắn.');
  }
});

// ============================================================================
// 3. Enterprise Internal Feed & Kudos Wall Leaderboard
// ============================================================================
router.get('/feed', requirePermission('workchat', 'view'), async (req, res) => {
  try {
    const ctx = getTenantContext();
    const departmentId = typeof req.query.department_id === 'string' ? req.query.department_id.trim() : '';
    const limit = clampLimit(req.query.limit, 40, 100);

    const items = await withTenantTransaction(ctx.tenantId, async (client) => {
      let sql = `
        SELECT fp.*,
               d.name AS department_name,
               b.name AS branch_name
        FROM tenant_feed_posts fp
        LEFT JOIN tenant_departments d ON d.tenant_id = fp.tenant_id AND d.id = fp.department_id
        LEFT JOIN tenant_branches b ON b.tenant_id = fp.tenant_id AND b.id = fp.branch_id
        WHERE fp.tenant_id = $1
      `;
      const params: unknown[] = [ctx.tenantId];
      if (departmentId && departmentId !== 'all') {
        sql += ' AND (fp.department_id IS NULL OR fp.department_id = $2)';
        params.push(departmentId);
      }
      sql += ` ORDER BY fp.is_pinned DESC, fp.created_at DESC LIMIT ${limit}`;

      const r = await client.query(sql, params);
      return r.rows.map((row) => ({
        ...row,
        likes_count: Number(row.likes_count || 0),
        comments_count: Number(row.comments_count || 0),
        attachments: parseJsonSafe(row.attachments_json, []),
        reactions: parseJsonSafe(row.reactions_json, {}),
      }));
    });

    res.json({ success: true, data: { items } });
  } catch (err: any) {
    sendApiError(res, 500, 'LIST_FEED_FAILED', err?.message || 'Không thể tải Bảng tin nội bộ.');
  }
});

router.post('/feed', requirePermission('workchat', 'create'), async (req, res) => {
  try {
    const ctx = getTenantContext();
    const body = req.body || {};
    const content = String(body.content || '').trim();
    if (!content) {
      sendApiError(res, 422, 'FEED_CONTENT_REQUIRED', 'Vui lòng nhập nội dung thông báo.');
      return;
    }

    const postType = ['announcement', 'update', 'policy', 'celebration'].includes(String(body.post_type))
      ? String(body.post_type)
      : 'announcement';

    const created = await withTenantTransaction(ctx.tenantId, async (client) => {
      const id = crypto.randomUUID();
      await client.query(
        `INSERT INTO tenant_feed_posts (
           id, tenant_id, author_user_id, author_name, title, content, post_type,
           branch_id, department_id, is_pinned, attachments_json
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::jsonb)`,
        [
          id,
          ctx.tenantId,
          ctx.userId,
          ctx.userName || 'Ban Điều Hành',
          body.title ? String(body.title).trim() : null,
          content,
          postType,
          body.branch_id || null,
          body.department_id || null,
          Boolean(body.is_pinned),
          JSON.stringify(Array.isArray(body.attachments) ? body.attachments : []),
        ]
      );
      const r = await client.query('SELECT * FROM tenant_feed_posts WHERE tenant_id = $1 AND id = $2', [
        ctx.tenantId,
        id,
      ]);
      return {
        ...r.rows[0],
        attachments: parseJsonSafe(r.rows[0].attachments_json, []),
        reactions: parseJsonSafe(r.rows[0].reactions_json, {}),
      };
    });

    res.status(201).json({ success: true, data: created });
  } catch (err: any) {
    sendApiError(res, 500, 'CREATE_FEED_POST_FAILED', err?.message || 'Không thể đăng bài lên Bảng tin nội bộ.');
  }
});

router.post('/feed/:id/like', requirePermission('workchat', 'view'), async (req, res) => {
  try {
    const ctx = getTenantContext();
    const postId = req.params.id;

    const updated = await withTenantTransaction(ctx.tenantId, async (client) => {
      const cur = await client.query<{ id: string; reactions_json: unknown }>(
        'SELECT id, reactions_json FROM tenant_feed_posts WHERE tenant_id = $1 AND id = $2 LIMIT 1',
        [ctx.tenantId, postId]
      );
      if (!cur.rows[0]) return null;
      const reactions = parseJsonSafe<Record<string, string[]>>(cur.rows[0].reactions_json, {});
      const likedBy = Array.isArray(reactions.likes) ? [...reactions.likes] : [];
      const idx = likedBy.indexOf(ctx.userId);
      if (idx >= 0) {
        likedBy.splice(idx, 1);
      } else {
        likedBy.push(ctx.userId);
      }
      reactions.likes = likedBy;
      const likesCount = likedBy.length;

      await client.query(
        `UPDATE tenant_feed_posts
         SET reactions_json = $3::jsonb,
             likes_count = $4,
             updated_at = clock_timestamp()
         WHERE tenant_id = $1 AND id = $2`,
        [ctx.tenantId, postId, JSON.stringify(reactions), likesCount]
      );
      return { id: postId, likes_count: likesCount, liked: idx < 0 };
    });

    if (!updated) {
      sendApiError(res, 404, 'FEED_POST_NOT_FOUND', 'Không tìm thấy bài viết.');
      return;
    }
    res.json({ success: true, data: updated });
  } catch (err: any) {
    sendApiError(res, 500, 'LIKE_FEED_FAILED', err?.message || 'Không thể tương tác bài viết.');
  }
});

router.post('/feed/:id/react', requirePermission('workchat', 'view'), async (req, res) => {
  try {
    const ctx = getTenantContext();
    const postId = String(req.params.id);
    const reactionType = ['like', 'love', 'haha', 'rocket', 'clap', 'flex'].includes(String(req.body?.reaction_type))
      ? String(req.body.reaction_type)
      : 'like';

    const updated = await withTenantTransaction(ctx.tenantId, async (client) => {
      const cur = await client.query<{ id: string; reactions_json: unknown }>(
        'SELECT id, reactions_json FROM tenant_feed_posts WHERE tenant_id = $1 AND id = $2 LIMIT 1',
        [ctx.tenantId, postId]
      );
      if (!cur.rows[0]) return null;
      const reactions = parseJsonSafe<Record<string, string[]>>(cur.rows[0].reactions_json, {});

      // Remove previous reaction from other buckets if user switched reaction type
      let toggledOff = false;
      for (const rKey of ['like', 'love', 'haha', 'rocket', 'clap', 'flex', 'likes']) {
        const bucket = Array.isArray(reactions[rKey]) ? [...reactions[rKey]] : [];
        const idx = bucket.indexOf(ctx.userId);
        if (idx >= 0) {
          if (rKey === reactionType) toggledOff = true;
          bucket.splice(idx, 1);
          if (bucket.length === 0) delete reactions[rKey];
          else reactions[rKey] = bucket;
        }
      }

      if (!toggledOff) {
        const nextBucket = Array.isArray(reactions[reactionType]) ? [...reactions[reactionType]] : [];
        nextBucket.push(ctx.userId);
        reactions[reactionType] = nextBucket;
      }

      let totalReactions = 0;
      const summary: Record<string, number> = {};
      for (const [k, arr] of Object.entries(reactions)) {
        if (Array.isArray(arr) && arr.length > 0) {
          summary[k] = arr.length;
          totalReactions += arr.length;
        }
      }

      await client.query(
        `UPDATE tenant_feed_posts
         SET reactions_json = $3::jsonb,
             likes_count = $4,
             updated_at = clock_timestamp()
         WHERE tenant_id = $1 AND id = $2`,
        [ctx.tenantId, postId, JSON.stringify(reactions), totalReactions]
      );
      return {
        id: postId,
        likes_count: totalReactions,
        user_reaction: toggledOff ? null : reactionType,
        reactions_summary: summary,
      };
    });

    if (!updated) {
      sendApiError(res, 404, 'FEED_POST_NOT_FOUND', 'Không tìm thấy bài viết.');
      return;
    }
    res.json({ success: true, data: updated });
  } catch (err: any) {
    sendApiError(res, 500, 'REACT_FEED_FAILED', err?.message || 'Không thể thả biểu cảm bài viết.');
  }
});

router.get('/feed/:id/comments', requirePermission('workchat', 'view'), async (req, res) => {
  try {
    const ctx = getTenantContext();
    const postId = req.params.id;
    const items = await withTenantTransaction(ctx.tenantId, async (client) => {
      const r = await client.query(
        'SELECT * FROM tenant_feed_comments WHERE tenant_id = $1 AND post_id = $2 ORDER BY created_at ASC',
        [ctx.tenantId, postId]
      );
      return r.rows;
    });
    res.json({ success: true, data: { items } });
  } catch (err: any) {
    sendApiError(res, 500, 'LIST_FEED_COMMENTS_FAILED', err?.message || 'Không thể tải bình luận.');
  }
});

router.post('/feed/:id/comments', requirePermission('workchat', 'create'), async (req, res) => {
  try {
    const ctx = getTenantContext();
    const postId = req.params.id;
    const content = String(req.body?.content || '').trim();
    if (!content) {
      sendApiError(res, 422, 'COMMENT_REQUIRED', 'Vui lòng nhập nội dung bình luận.');
      return;
    }

    const created = await withTenantTransaction(ctx.tenantId, async (client) => {
      const postCheck = await client.query('SELECT id FROM tenant_feed_posts WHERE tenant_id = $1 AND id = $2 LIMIT 1', [
        ctx.tenantId,
        postId,
      ]);
      if (!postCheck.rows[0]) return null;

      const id = crypto.randomUUID();
      await client.query(
        `INSERT INTO tenant_feed_comments (id, tenant_id, post_id, author_user_id, author_name, content)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [id, ctx.tenantId, postId, ctx.userId, ctx.userName || 'Thành viên', content]
      );
      await client.query(
        'UPDATE tenant_feed_posts SET comments_count = comments_count + 1, updated_at = clock_timestamp() WHERE tenant_id = $1 AND id = $2',
        [ctx.tenantId, postId]
      );
      const r = await client.query('SELECT * FROM tenant_feed_comments WHERE tenant_id = $1 AND id = $2', [
        ctx.tenantId,
        id,
      ]);
      return r.rows[0];
    });

    if (!created) {
      sendApiError(res, 404, 'FEED_POST_NOT_FOUND', 'Không tìm thấy bài viết.');
      return;
    }
    res.status(201).json({ success: true, data: created });
  } catch (err: any) {
    sendApiError(res, 500, 'CREATE_FEED_COMMENT_FAILED', err?.message || 'Không thể gửi bình luận.');
  }
});

router.get('/kudos', requirePermission('workchat', 'view'), async (_req, res) => {
  try {
    const ctx = getTenantContext();
    const data = await withTenantTransaction(ctx.tenantId, async (client) => {
      const [itemsRes, boardRes] = await Promise.all([
        client.query(
          `SELECT * FROM tenant_kudos_recognitions
           WHERE tenant_id = $1
           ORDER BY created_at DESC
           LIMIT 50`,
          [ctx.tenantId]
        ),
        client.query<{
          recipient_user_id: string;
          recipient_name: string;
          kudos_count: string | number;
          total_points: string | number;
        }>(
          `SELECT recipient_user_id,
                  MAX(recipient_name) AS recipient_name,
                  COUNT(*)::int AS kudos_count,
                  COALESCE(SUM(points), 0) AS total_points
           FROM tenant_kudos_recognitions
           WHERE tenant_id = $1
           GROUP BY recipient_user_id
           ORDER BY total_points DESC, kudos_count DESC
           LIMIT 15`,
          [ctx.tenantId]
        ),
      ]);

      return {
        items: itemsRes.rows,
        leaderboard: boardRes.rows.map((r, index) => ({
          rank: index + 1,
          user_id: r.recipient_user_id,
          full_name: r.recipient_name,
          kudos_count: Number(r.kudos_count || 0),
          total_points: Number(r.total_points || 0),
        })),
      };
    });

    res.json({ success: true, data });
  } catch (err: any) {
    sendApiError(res, 500, 'LIST_KUDOS_FAILED', err?.message || 'Không thể tải Bảng vàng Vinh danh.');
  }
});

router.post('/kudos', requirePermission('workchat', 'create'), async (req, res) => {
  try {
    const ctx = getTenantContext();
    const body = req.body || {};
    const recipientId = String(body.recipient_user_id || '').trim();
    const message = String(body.message || '').trim();
    if (!recipientId || !message) {
      sendApiError(res, 422, 'KUDOS_FIELDS_REQUIRED', 'Vui lòng chọn đồng nghiệp và nhập lời vinh danh.');
      return;
    }

    const created = await withTenantTransaction(ctx.tenantId, async (client) => {
      const uRes = await client.query<{ id: string; full_name: string }>(
        'SELECT id, full_name FROM users WHERE tenant_id = $1 AND id = $2 LIMIT 1',
        [ctx.tenantId, recipientId]
      );
      if (!uRes.rows[0]) return null;

      const id = crypto.randomUUID();
      const points = Math.max(5, Math.min(100, Math.round(Number(body.points || 10))));
      await client.query(
        `INSERT INTO tenant_kudos_recognitions (
           id, tenant_id, sender_user_id, sender_name, recipient_user_id, recipient_name,
           badge_key, badge_title, points, message
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
        [
          id,
          ctx.tenantId,
          ctx.userId,
          ctx.userName || 'Đồng nghiệp',
          recipientId,
          uRes.rows[0].full_name,
          body.badge_key || 'top_performer',
          body.badge_title || 'Tinh thần Đồng đội Xuất sắc',
          points,
          message,
        ]
      );
      const r = await client.query('SELECT * FROM tenant_kudos_recognitions WHERE tenant_id = $1 AND id = $2', [
        ctx.tenantId,
        id,
      ]);
      return r.rows[0];
    });

    if (!created) {
      sendApiError(res, 404, 'RECIPIENT_NOT_FOUND', 'Không tìm thấy nhân sự được vinh danh.');
      return;
    }
    res.status(201).json({ success: true, data: created });
  } catch (err: any) {
    sendApiError(res, 500, 'CREATE_KUDOS_FAILED', err?.message || 'Không thể gửi lời vinh danh.');
  }
});

export default router;
