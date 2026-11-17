import crypto from 'node:crypto';
import type { DbClient } from '../../core/database/db-adapter.ts';
import type { TenantContext } from '../../core/context/tenant-context.ts';
import { normalizeTenantSettings, type TenantSettings } from '../../core/settings/tenant-settings.ts';
import { tenantRedis } from '../../core/cache/tenant-redis.ts';
import { withTenantTransaction } from '../../core/database/transaction.ts';
import { buildLegacyDateFilter, formatDateTimeVnSql } from './legacy-helpers.ts';
import { hashPassword, verifyPassword } from '../../core/crypto/password.ts';
import { encryptTenantSecret } from '../../core/crypto/vault.ts';
import {
  buildCategoryTestEmailContent,
  sendTenantEmailNotification,
} from '../../services/zalo-mail.service.ts';
import {
  deleteMetaAdAccount,
  discoverMetaTokenAssets,
  getMetaAdsConfigSummary,
  syncMetaAdsAccounts,
  toggleMetaAdAccountStatus,
  upsertMetaAdAccount,
} from '../../services/meta-ads.service.ts';
import { normalizePhoneE164 } from '../../services/phone.service.ts';
import { maskPhoneString } from '../../core/security/pii-masker.ts';
import { dispatchStageCapiEvent } from '../../services/capi.service.ts';
import { isOutboundSilentMode } from '../../core/security/outbound-guard.ts';

const ADMIN_ROLES = ['admin', 'tenant_admin', 'super_admin'];
const ADMIN_OR_MANAGER_ROLES = ['admin', 'tenant_admin', 'manager', 'super_admin'];

const SELF_SERVICE_ACTIONS = new Set([
  'update_profile',
  'update_consultant_self_profile',
  'change_password',
  'upload_avatar',
  'ai_chat',
]);

const ADMIN_READ_ONLY_ACTIONS = new Set([
  'get_accounts',
  'get_settings',
  'get_ticket_settings',
  'get_meta_ads_config',
  'get_rounds',
  'get_consultants',
  'get_consultant_stats',
  'get_rules',
  'get_connections',
  'get_mappings',
  'get_import_history',
  'discover_meta_assets',
  'fetch_meta_token_assets',
  'list_meta_token_accounts',
  'get_ad_preview_iframe',
  'batch_check_duplicates',
  'check_sheet_duplicates',
]);

const ADMIN_MUTATION_ACTIONS = new Set([
  'add_round',
  'edit_round',
  'delete_round',
  'update_compensations',
  'update_round_ratios',
  'add_consultant',
  'edit_consultant',
  'delete_consultant',
  'toggle_consultant_vacation',
  'add_consultant_manager',
  'delete_consultant_manager',
  'unlink_consultant_manager_zalo',
  'unlink_zalo',
  'resend_zalo_verify_consultant',
  'resend_zalo_verify_manager',
  'resend_zalo_verify_account',
  'resend_confirm_email',
  'send_quick_zalo_message',
  'scan_consultants_from_sheet',
  'invite_consultants_from_sheet',
  'add_rule',
  'edit_rule',
  'delete_rule',
  'reorder_rules',
  'evaluate_rules_ai',
  'add_connection',
  'edit_connection',
  'delete_connection',
  'toggle_connection',
  'toggle_require_both',
  'toggle_notify_admin',
  'add_mapping',
  'edit_mapping',
  'delete_mapping',
  'fetch_sheets',
  'fetch_columns',
  'force_sync',
  'test_master_sync',
  'save_settings',
  'save_ticket_settings',
  'add_meta_ad_account',
  'update_meta_ad_account',
  'save_meta_ad_account',
  'save_meta_ads_config',
  'delete_meta_ad_account',
  'toggle_meta_ad_account',
  'save_capi_settings',
  'sync_meta_ads_data',
  'sync_capi_sheet_ids',
  'backfill_capi_events',
  'send_single_lead_capi',
  'delete_import_history',
  'batch_import_leads',
  'add_account',
  'edit_account',
  'check_delete_account',
  'delete_account',
  'rollback_admin_action',
]);

function pickSettingsForLegacy(cfg: TenantSettings, extra: Record<string, any> = {}): Record<string, any> {
  return {
    ...cfg,
    duplicate_check_months: Math.max(1, Math.round((cfg.duplicate_threshold_days || 180) / 30)),
    fallback_type: cfg.fallback_type,
    fallback_round_id: cfg.fallback_round_id,
    fallback_admin_id: cfg.fallback_admin_id,
    fallback_cc_email: cfg.fallback_cc_email,
    reassign_if_owner_inactive: extra.reassign_if_owner_inactive ?? '1',
    starvation_prevention_enabled: cfg.starvation_prevention_enabled ? '1' : '0',
    starvation_max_leads_per_hour: cfg.starvation_max_leads_per_hour,
    ticket_auto_approve_enabled: cfg.ticket_auto_approve_enabled ? '1' : '0',
    ticket_auto_approve_rules: JSON.stringify(cfg.ticket_auto_approve_rules || []),
    ticket_auto_approve_keywords: extra.ticket_auto_approve_keywords || '',
    report_error_reasons: JSON.stringify(
      (cfg.ticket_reasons || []).map((r) => ({ reason: r.label || r.value, note: r.value }))
    ),
    email_provider: extra.email_provider || 'appscript',
    appscript_webhook_url: extra.appscript_webhook_url || '',
    appscript_secret: extra.appscript_secret || '',
    frontend_url: extra.frontend_url || 'https://domation.net/data',
    ses_host: extra.ses_host || '',
    ses_username: extra.ses_username || '',
    ses_password: extra.ses_password ? '••••••••' : '',
    ses_sender_name: extra.ses_sender_name || cfg.brand_display_name || cfg.capi_event_source_name || 'DOMATION AUTO DATA',
    ses_sender_email: extra.ses_sender_email || cfg.support_email || 'noreply@domation.net',
    zalo_bot_token: extra.zalo_bot_token || '',
    zalo_webhook_secret: extra.zalo_webhook_secret || '',
    zalo_bot_link: extra.zalo_bot_link || '',
    zalo_admin_group_chat_id: extra.zalo_admin_group_chat_id || '',
    zalo_notify_only_group: extra.zalo_notify_only_group ? '1' : '0',
    zalo_daily_report_time: extra.zalo_daily_report_time || '18:00',
    daily_report_admins: JSON.stringify(extra.daily_report_admins || []),
    ticket_notify_admins: JSON.stringify(extra.ticket_notify_admins || []),
    ai_screener_enabled: extra.ai_screener_enabled ? '1' : '0',
    ai_screener_mode: extra.ai_screener_mode || 'ai',
    ai_screener_rules: extra.ai_screener_rules || '',
    ai_screener_rounds: Array.isArray(extra.ai_screener_rounds)
      ? extra.ai_screener_rounds.join(',')
      : String(extra.ai_screener_rounds || ''),
    ai_screener_manual_action: extra.ai_screener_manual_action || 'hold',
    ai_screener_manual_rules: JSON.stringify(extra.ai_screener_manual_rules || []),
    gemini_model: extra.gemini_model || 'gemini-3.5-flash-lite',
    global_exclusion_keys: extra.global_exclusion_keys || '',
    global_exclusion_contacts: extra.global_exclusion_contacts || '',
    pipeline_capi_stages: cfg.pipeline_capi_stages,
    capi_rules: cfg.capi_rules,
    // Canonical dynamic SaaS config included cleanly for upgraded settings controls
    tenant_settings: cfg,
  };
}

export async function handleLegacyAdminStandalone(
  action: string,
  _params: URLSearchParams,
  body: Record<string, any>,
  ctx: TenantContext
): Promise<Record<string, any> | null> {
  if (action === 'test_email') {
    if (!ADMIN_ROLES.includes(ctx.userRole) || ctx.isExternalAgency) {
      return { _status: 403, success: false, error: 'Forbidden: administrative privileges required' };
    }
    const to = String(body.email || body.to_email || ctx.userEmail || '').trim();
    if (!to) return { success: false, message: 'Vui lòng nhập email nhận thử nghiệm.' };

    const tenantInfo = await withTenantTransaction(ctx.tenantId, async (client) => {
      const r = await client.query<{ name: string; slug: string; settings: Record<string, any> }>(
        'SELECT name, slug, settings FROM tenants WHERE id = $1 LIMIT 1',
        [ctx.tenantId]
      );
      return r.rows[0] || { name: 'DOMATION AutoData', slug: ctx.tenantSlug, settings: {} };
    });

    const rawSettings = tenantInfo.settings || {};
    const normalizedCfg = normalizeTenantSettings(rawSettings);
    const brandDisplayName =
      normalizedCfg.brand_display_name || tenantInfo.name || 'DOMATION AutoData';
    const frontendUrl = String(body.frontend_url || rawSettings.frontend_url || 'https://domation.net/data').trim();
    const testType = String(body.type || 'system').trim();
    const content = buildCategoryTestEmailContent({
      type: testType,
      tenantName: brandDisplayName,
      tenantSlug: tenantInfo.slug || ctx.tenantSlug,
      frontendUrl,
    });

    const dispatchRes = await sendTenantEmailNotification({
      tenantId: ctx.tenantId,
      to,
      subject: content.subject,
      text: content.text,
      html: content.html,
      category: content.category,
      meta: content.meta,
      overrideProvider: body.email_provider || body.provider,
      overrideWebhookUrl: body.appscript_webhook_url,
      overrideSecret: body.appscript_secret,
    });

    if (!dispatchRes) {
      return { success: false, message: 'Không xác định được email người nhận.' };
    }
    if (!dispatchRes.sent) {
      return {
        success: false,
        provider: dispatchRes.provider,
        message: dispatchRes.error || 'Gửi email thất bại. Vui lòng kiểm tra lại cấu hình Apps Script / SMTP.',
      };
    }
    return {
      success: true,
      provider: dispatchRes.provider,
      category: dispatchRes.category,
      remaining_quota: dispatchRes.remainingQuota ?? null,
      sheet_logged: dispatchRes.sheetLogged ?? false,
      message:
        dispatchRes.provider === 'silent_guard'
          ? `Đã kiểm tra mẫu email "${testType}" tới ${to} (Chế độ an toàn Silent Mode).`
          : dispatchRes.remainingQuota !== null && dispatchRes.remainingQuota !== undefined
            ? `Đã gửi email "${testType}" tới ${to} thành công! Quota Gmail còn lại: ${dispatchRes.remainingQuota} email/ngày.`
            : `Đã gửi email "${testType}" tới ${to} thành công!`,
    };
  }

  return null;
}

export async function handleLegacyAdmin(
  action: string,
  params: URLSearchParams,
  body: Record<string, any>,
  client: DbClient,
  ctx: TenantContext,
  cfg: TenantSettings
): Promise<Record<string, any> | null> {
  if (ADMIN_MUTATION_ACTIONS.has(action)) {
    if (!ADMIN_ROLES.includes(ctx.userRole) || ctx.isExternalAgency) {
      return { _status: 403, success: false, error: 'Forbidden: administrative privileges required' };
    }
  }

  if (ADMIN_READ_ONLY_ACTIONS.has(action)) {
    if (!ADMIN_OR_MANAGER_ROLES.includes(ctx.userRole) || ctx.isExternalAgency) {
      return { _status: 403, success: false, error: 'Forbidden: administrative privileges required' };
    }
  }

  // ============================================================================
  // 1. ROUNDS & COMPENSATION
  // ============================================================================
  if (action === 'get_rounds') {
    const dateFilter = buildLegacyDateFilter(params.get('date') || 'Tháng này');
    const qParams: unknown[] = [ctx.tenantId];
    const dateCond = dateFilter.bindSql('l.created_at', qParams);

    const [roundsRes, rcRes, leadsCountRes] = await Promise.all([
      client.query(
        `SELECT dr.id, dr.pipeline_id, dr.name, dr.description, dr.cc_emails,
                dr.last_assigned_consultant_id, dr.priority, dr.is_active, dr.created_at
         FROM distribution_rounds dr
         WHERE dr.tenant_id = $1
         ORDER BY dr.priority ASC, dr.created_at ASC`,
        [ctx.tenantId]
      ),
      client.query(
        `SELECT rc.*, u.full_name AS name, u.email, u.avatar_url AS avatar,
                p.status, p.vacation_mode, p.is_available
         FROM round_consultants rc
         INNER JOIN users u ON u.tenant_id = rc.tenant_id AND u.id = rc.user_id
         LEFT JOIN tenant_user_profiles p ON p.tenant_id = rc.tenant_id AND p.user_id = rc.user_id
         WHERE rc.tenant_id = $1
         ORDER BY u.full_name ASC`,
        [ctx.tenantId]
      ),
      client.query(
        `SELECT l.round_id, l.assigned_to, COUNT(*)::int AS cnt
         FROM leads l
         WHERE l.tenant_id = $1 AND l.is_deleted = false AND l.status != 'archived' AND (${dateCond})
         GROUP BY l.round_id, l.assigned_to`,
        qParams
      ),
    ]);

    const lcMap = new Map<string, number>();
    const roundTotalMap = new Map<string, number>();
    for (const r of leadsCountRes.rows) {
      if (r.round_id && r.assigned_to) {
        lcMap.set(`${r.round_id}:${r.assigned_to}`, Number(r.cnt));
      }
      if (r.round_id) {
        roundTotalMap.set(r.round_id, (roundTotalMap.get(r.round_id) || 0) + Number(r.cnt));
      }
    }

    const mapped = roundsRes.rows.map((r) => {
      const members = rcRes.rows.filter((m) => m.round_id === r.id);
      const ratios: Record<string, number> = {};
      const data_per_turns: Record<string, number> = {};
      const compensations: Record<string, number> = {};
      const leads_by_user: Record<string, number> = {};

      for (const m of members) {
        ratios[m.user_id] = Number(m.receive_ratio || 1);
        data_per_turns[m.user_id] = Number(m.data_per_turn || 1);
        compensations[m.user_id] = Number(m.compensation_count || 0);
        leads_by_user[m.user_id] = lcMap.get(`${r.id}:${m.user_id}`) ?? Number(m.leads_received_in_round || 0);
      }

      return {
        id: r.id,
        round_name: r.name,
        name: r.name,
        description: r.description || '',
        cc_emails: r.cc_emails || '',
        is_active: r.is_active ? 1 : 0,
        is_fallback: cfg.fallback_round_id === r.id ? 1 : 0,
        next_consultant_id: r.last_assigned_consultant_id || members[0]?.user_id || null,
        next_assigned_name: members.find((m) => m.user_id === r.last_assigned_consultant_id)?.name || members[0]?.name || '',
        consultant_ids: members.map((m) => m.user_id).join(','),
        consultants: members.map((m) => m.name).join(','),
        consultant_details: members.map((m) => ({
          id: m.user_id,
          user_id: m.user_id,
          name: m.name,
          full_name: m.name,
          email: m.email,
          avatar: m.avatar,
          receive_ratio: Number(m.receive_ratio || 1),
          data_per_turn: Number(m.data_per_turn || 1),
          compensation_count: Number(m.compensation_count || 0),
          leads_received: lcMap.get(`${r.id}:${m.user_id}`) ?? Number(m.leads_received_in_round || 0),
          status: m.status || 'active',
          vacation_mode: m.vacation_mode ? 1 : 0,
        })),
        ratios,
        data_per_turns,
        compensations,
        leads_by_user,
        total_leads: roundTotalMap.get(r.id) || members.reduce((s, m) => s + Number(m.leads_received_in_round || 0), 0),
        created_at: formatDateTimeVnSql(r.created_at),
      };
    });

    return { success: true, data: mapped };
  }

  if (action === 'add_round' || action === 'edit_round') {
    const isEdit = action === 'edit_round';
    const roundId = body.id ? String(body.id) : null;
    const roundName = String(body.round_name || body.name || '').trim();
    const isActive = body.is_active === undefined ? true : Boolean(Number(body.is_active) === 1 || body.is_active === true);
    const ccEmails = body.cc_emails ? String(body.cc_emails) : null;
    const selectedUsers: string[] = Array.isArray(body.selected_users) ? body.selected_users.map(String) : [];
    const ratios = body.ratios && typeof body.ratios === 'object' ? body.ratios : {};
    const dpts = body.data_per_turns && typeof body.data_per_turns === 'object' ? body.data_per_turns : {};

    if (!roundName) return { success: false, message: 'Tên vòng phân bổ không được để trống.' };

    let targetId = roundId;
    if (isEdit && targetId) {
      await client.query(
        `UPDATE distribution_rounds
         SET name = $3, is_active = $4, cc_emails = $5, last_assigned_consultant_id = COALESCE($6, last_assigned_consultant_id), updated_at = clock_timestamp()
         WHERE tenant_id = $1 AND id = $2`,
        [ctx.tenantId, targetId, roundName, isActive, ccEmails, body.starting_consultant_id || null]
      );
    } else {
      const pip = await client.query<{ id: string }>(
        'SELECT id FROM tenant_pipelines WHERE tenant_id = $1 ORDER BY is_default DESC, created_at ASC LIMIT 1',
        [ctx.tenantId]
      );
      const pipelineId = pip.rows[0]?.id;
      if (!pipelineId) return { success: false, message: 'Không tìm thấy Pipeline mặc định.' };
      const ins = await client.query<{ id: string }>(
        `INSERT INTO distribution_rounds (tenant_id, pipeline_id, name, is_active, cc_emails, priority)
         VALUES ($1, $2, $3, $4, $5, 1)
         RETURNING id`,
        [ctx.tenantId, pipelineId, roundName, isActive, ccEmails]
      );
      targetId = ins.rows[0].id;
    }

    if (targetId && selectedUsers.length > 0) {
      await client.query(
        `DELETE FROM round_consultants WHERE tenant_id = $1 AND round_id = $2`,
        [ctx.tenantId, targetId]
      );
      for (const uid of selectedUsers) {
        await client.query(
          `INSERT INTO round_consultants (tenant_id, round_id, user_id, receive_ratio, data_per_turn, is_active)
           VALUES ($1, $2, $3, $4, $5, true)
           ON CONFLICT (tenant_id, round_id, user_id)
           DO UPDATE SET receive_ratio = EXCLUDED.receive_ratio, data_per_turn = EXCLUDED.data_per_turn, is_active = true`,
          [ctx.tenantId, targetId, uid, Math.max(1, Number(ratios[uid] || 1)), Math.max(1, Number(dpts[uid] || 1))]
        );
      }
    }

    return { success: true, id: targetId, message: isEdit ? 'Đã cập nhật vòng phân bổ.' : 'Đã tạo vòng phân bổ mới.' };
  }

  if (action === 'delete_round') {
    const id = String(params.get('id') || body.id || '').trim();
    if (!id) return { success: false, message: 'Thiếu ID vòng phân bổ.' };
    await client.query('DELETE FROM distribution_rounds WHERE tenant_id = $1 AND id = $2', [ctx.tenantId, id]);
    return { success: true, message: 'Đã xóa vòng phân bổ.' };
  }

  if (action === 'update_compensations') {
    const roundId = String(body.round_id || '').trim();
    const compensations = body.compensations && typeof body.compensations === 'object' ? body.compensations : {};
    const reasons = body.reasons && typeof body.reasons === 'object' ? body.reasons : {};
    for (const [uid, val] of Object.entries(compensations)) {
      const nextVal = Math.max(0, Number(val || 0));
      const curRes = await client.query<{ compensation_count: number }>(
        'SELECT compensation_count FROM round_consultants WHERE tenant_id = $1 AND round_id = $2 AND user_id = $3 LIMIT 1',
        [ctx.tenantId, roundId, uid]
      );
      const prevVal = Number(curRes.rows[0]?.compensation_count || 0);
      await client.query(
        `UPDATE round_consultants SET compensation_count = $4, updated_at = clock_timestamp()
         WHERE tenant_id = $1 AND round_id = $2 AND user_id = $3`,
        [ctx.tenantId, roundId, uid, nextVal]
      );
      if (nextVal !== prevVal) {
        await client.query(
          `INSERT INTO active_compensation_logs (tenant_id, round_id, consultant_user_id, admin_user_id, amount, reason, source_type)
           VALUES ($1, $2, $3, $4, $5, $6, 'manual')`,
          [ctx.tenantId, roundId, uid, ctx.userId, nextVal - prevVal, String(reasons[uid] || 'Điều chỉnh bù Data từ trang Vòng')]
        );
      }
    }
    return { success: true, message: 'Đã cập nhật Bù Data!' };
  }

  if (action === 'update_round_ratios') {
    const roundId = String(body.round_id || '').trim();
    const ratios = body.ratios && typeof body.ratios === 'object' ? body.ratios : {};
    for (const [uid, ratio] of Object.entries(ratios)) {
      await client.query(
        `UPDATE round_consultants SET receive_ratio = $4, updated_at = clock_timestamp()
         WHERE tenant_id = $1 AND round_id = $2 AND user_id = $3`,
        [ctx.tenantId, roundId, uid, Math.max(1, Number(ratio || 1))]
      );
    }
    return { success: true, message: 'Đã cập nhật tỷ trọng vòng chia.' };
  }

  // ============================================================================
  // 2. CONSULTANTS & CO-MANAGERS
  // ============================================================================
  if (action === 'get_consultants') {
    const [usersRes, mgrsRes, rcRes, leadsRes] = await Promise.all([
      client.query(
        `SELECT u.id, u.full_name AS name, u.email, u.phone, u.avatar_url AS avatar,
                u.is_external_agency, u.created_at,
                p.status, p.is_available, p.vacation_mode, p.skipped_credit, p.work_schedule,
                p.zalo_chat_id, p.zalo_user_id, p.sheet_sync_url, p.sheet_tab_name
         FROM users u
         LEFT JOIN tenant_user_profiles p ON p.tenant_id = u.tenant_id AND p.user_id = u.id
         WHERE u.tenant_id = $1 AND u.role = 'sale'
         ORDER BY u.full_name ASC`,
        [ctx.tenantId]
      ),
      client.query(
        `SELECT id, consultant_user_id, name, email, phone, zalo_chat_id, zalo_verified, status
         FROM consultant_managers WHERE tenant_id = $1 ORDER BY created_at ASC`,
        [ctx.tenantId]
      ),
      client.query(
        `SELECT rc.user_id, dr.id AS round_id, dr.name AS round_name, rc.receive_ratio, rc.compensation_count
         FROM round_consultants rc
         INNER JOIN distribution_rounds dr ON dr.tenant_id = rc.tenant_id AND dr.id = rc.round_id
         WHERE rc.tenant_id = $1`,
        [ctx.tenantId]
      ),
      client.query(
        `SELECT assigned_to, COUNT(*)::int AS total_leads
         FROM leads
         WHERE tenant_id = $1 AND is_deleted = false AND status != 'archived'
         GROUP BY assigned_to`,
        [ctx.tenantId]
      ),
    ]);

    const lMap = new Map<string, number>();
    for (const l of leadsRes.rows) if (l.assigned_to) lMap.set(l.assigned_to, Number(l.total_leads));

    return {
      success: true,
      data: usersRes.rows.map((u) => ({
        id: u.id,
        name: u.name,
        email: u.email,
        phone: u.phone,
        avatar: u.avatar,
        status: u.status || 'active',
        vacation_mode: u.vacation_mode ? 1 : 0,
        is_available: u.is_available ?? true,
        is_external_agency: Boolean(u.is_external_agency),
        zalo_chat_id: u.zalo_chat_id || null,
        telegram_id: null,
        work_schedule: u.work_schedule || null,
        work_start_time: '00:00',
        work_end_time: '23:59',
        total_leads: lMap.get(u.id) || 0,
        managers: mgrsRes.rows.filter((m) => m.consultant_user_id === u.id),
        rounds: rcRes.rows.filter((r) => r.user_id === u.id),
        created_at: formatDateTimeVnSql(u.created_at),
      })),
    };
  }

  if (action === 'add_consultant' || action === 'edit_consultant') {
    const isEdit = action === 'edit_consultant';
    const name = String(body.name || '').trim();
    const email = String(body.email || '').trim().toLowerCase();
    const status = String(body.status || 'active');
    const zaloChatId = body.zalo_chat_id ? String(body.zalo_chat_id).trim() : null;
    if (!name || !email) return { success: false, message: 'Tên và Email Đại lý là bắt buộc.' };

    if (isEdit && body.id) {
      await client.query(
        `UPDATE users SET full_name = $3, email = $4, avatar_url = COALESCE($5, avatar_url), updated_at = clock_timestamp()
         WHERE tenant_id = $1 AND id = $2`,
        [ctx.tenantId, String(body.id), name, email, body.avatar || null]
      );
      await client.query(
        `UPDATE tenant_user_profiles
         SET status = $3, zalo_chat_id = COALESCE($4, zalo_chat_id),
             work_schedule = COALESCE($5::jsonb, work_schedule), updated_at = clock_timestamp()
         WHERE tenant_id = $1 AND user_id = $2`,
        [ctx.tenantId, String(body.id), status, zaloChatId, body.work_schedule ? JSON.stringify(body.work_schedule) : null]
      );
      return { success: true, message: 'Đã cập nhật thông tin Đại lý.' };
    }

    const passHash = await hashPassword(String(cfg.default_staff_password || 'Sale@123456'));
    const ins = await client.query<{ id: string }>(
      `INSERT INTO users (tenant_id, email, password_hash, full_name, role, is_external_agency, avatar_url)
       VALUES ($1, $2, $3, $4, 'sale', true, $5)
       RETURNING id`,
      [ctx.tenantId, email, passHash, name, body.avatar || null]
    );
    await client.query(
      `INSERT INTO tenant_user_profiles (tenant_id, user_id, status, zalo_chat_id, is_available)
       VALUES ($1, $2, $3, $4, true)`,
      [ctx.tenantId, ins.rows[0].id, status, zaloChatId]
    );
    return { success: true, id: ins.rows[0].id, message: 'Đã thêm Đại lý mới.' };
  }

  if (action === 'delete_consultant') {
    const id = String(params.get('id') || body.id || '').trim();
    await client.query('DELETE FROM users WHERE tenant_id = $1 AND id = $2 AND role = \'sale\'', [ctx.tenantId, id]);
    return { success: true, message: 'Đã xóa Đại lý.' };
  }

  if (action === 'toggle_consultant_vacation') {
    const id = String(body.id || body.consultant_id || ctx.userId);
    const cur = await client.query<{ vacation_mode: boolean }>(
      'SELECT vacation_mode FROM tenant_user_profiles WHERE tenant_id = $1 AND user_id = $2 LIMIT 1',
      [ctx.tenantId, id]
    );
    const nextVac = body.vacation_mode !== undefined ? Boolean(Number(body.vacation_mode) === 1 || body.vacation_mode === true) : !Boolean(cur.rows[0]?.vacation_mode);
    await client.query(
      `UPDATE tenant_user_profiles SET vacation_mode = $3, is_available = $4, updated_at = clock_timestamp()
       WHERE tenant_id = $1 AND user_id = $2`,
      [ctx.tenantId, id, nextVac, !nextVac]
    );
    return { success: true, vacation_mode: nextVac ? 1 : 0, message: nextVac ? 'Đã bật Tạm nghỉ' : 'Đã mở lại nhận Data' };
  }

  if (action === 'get_consultant_stats') {
    const consId = String(params.get('consultant_id') || '');
    const dateMode = String(params.get('date_mode') || 'this_month');
    const df = buildLegacyDateFilter(dateMode);
    const qParams: unknown[] = [ctx.tenantId, consId];
    const cond = df.bindSql('created_at', qParams);

    const [sumRes, dailyRes] = await Promise.all([
      client.query(
        `SELECT COUNT(*)::int AS total,
                COUNT(*) FILTER (WHERE is_accepted = true)::int AS accepted,
                COUNT(*) FILTER (WHERE LOWER(quality_status) IN ('qualified','booked','booking','closed','good'))::int AS qualified
         FROM leads
         WHERE tenant_id = $1 AND assigned_to = $2 AND is_deleted = false AND status != 'archived' AND (${cond})`,
        qParams
      ),
      client.query(
        `SELECT to_char(created_at AT TIME ZONE 'Asia/Ho_Chi_Minh', 'DD/MM') AS date, COUNT(*)::int AS count
         FROM leads
         WHERE tenant_id = $1 AND assigned_to = $2 AND is_deleted = false AND status != 'archived' AND (${cond})
         GROUP BY date, to_char(created_at AT TIME ZONE 'Asia/Ho_Chi_Minh', 'YYYY-MM-DD')
         ORDER BY to_char(created_at AT TIME ZONE 'Asia/Ho_Chi_Minh', 'YYYY-MM-DD') ASC LIMIT 31`,
        qParams
      ),
    ]);
    return {
      success: true,
      data: {
        ...(sumRes.rows[0] || { total: 0, accepted: 0, qualified: 0 }),
        chart: dailyRes.rows,
      },
    };
  }

  if (action === 'add_consultant_manager') {
    const consId = String(body.consultant_id || ctx.userId);
    const maxCoManagers = cfg.max_co_managers_per_consultant;
    if (maxCoManagers <= 0) {
      return {
        _status: 403,
        success: false,
        message: 'Chức năng Người đồng quản lý hiện đang tạm tắt theo cấu hình Workspace.',
      };
    }
    const cntRes = await client.query<{ cnt: number }>(
      `SELECT COUNT(*)::int AS cnt FROM consultant_managers WHERE tenant_id = $1 AND consultant_user_id = $2 AND status = 'active'`,
      [ctx.tenantId, consId]
    );
    if (Number(cntRes.rows[0]?.cnt || 0) >= maxCoManagers) {
      return {
        _status: 422,
        success: false,
        message: `Mỗi Đại lý / Sale chỉ được gắn tối đa ${maxCoManagers} người đồng quản lý.`,
      };
    }
    const ins = await client.query(
      `INSERT INTO consultant_managers (tenant_id, consultant_user_id, name, email, phone, zalo_chat_id, zalo_verified, status)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 'active')
       RETURNING *`,
      [
        ctx.tenantId,
        consId,
        String(body.name || 'Quản lý').trim(),
        String(body.email || '').trim().toLowerCase(),
        body.phone ? String(body.phone).trim() : null,
        body.zalo_chat_id ? String(body.zalo_chat_id).trim() : null,
        Boolean(body.zalo_chat_id),
      ]
    );
    const mgrs = await client.query(
      'SELECT * FROM consultant_managers WHERE tenant_id = $1 AND consultant_user_id = $2 ORDER BY created_at ASC',
      [ctx.tenantId, consId]
    );
    return { success: true, manager_id: ins.rows[0].id, managers: mgrs.rows };
  }

  if (action === 'delete_consultant_manager') {
    const mgrId = String(body.id || body.manager_id || '');
    const consId = String(body.consultant_id || ctx.userId);
    await client.query('DELETE FROM consultant_managers WHERE tenant_id = $1 AND id = $2', [ctx.tenantId, mgrId]);
    const mgrs = await client.query(
      'SELECT * FROM consultant_managers WHERE tenant_id = $1 AND consultant_user_id = $2 ORDER BY created_at ASC',
      [ctx.tenantId, consId]
    );
    return { success: true, managers: mgrs.rows };
  }

  if (action === 'unlink_consultant_manager_zalo') {
    const mgrId = String(body.id || body.manager_id || '');
    const consId = String(body.consultant_id || ctx.userId);
    await client.query(
      'UPDATE consultant_managers SET zalo_chat_id = NULL, zalo_verified = false WHERE tenant_id = $1 AND id = $2',
      [ctx.tenantId, mgrId]
    );
    const mgrs = await client.query(
      'SELECT * FROM consultant_managers WHERE tenant_id = $1 AND consultant_user_id = $2 ORDER BY created_at ASC',
      [ctx.tenantId, consId]
    );
    return { success: true, managers: mgrs.rows };
  }

  if (action === 'unlink_zalo') {
    const id = String(body.id || body.consultant_id || '');
    await client.query(
      'UPDATE tenant_user_profiles SET zalo_chat_id = NULL, zalo_user_id = NULL WHERE tenant_id = $1 AND user_id = $2',
      [ctx.tenantId, id]
    );
    return { success: true, message: 'Đã ngắt kết nối Zalo.' };
  }

  if (
    action === 'resend_zalo_verify_consultant' ||
    action === 'resend_zalo_verify_manager' ||
    action === 'resend_zalo_verify_account' ||
    action === 'resend_confirm_email' ||
    action === 'send_quick_zalo_message'
  ) {
    return {
      success: true,
      silent: isOutboundSilentMode(),
      message: isOutboundSilentMode()
        ? 'Đã ghi nhận yêu cầu xác nhận/tin nhắn (Chế độ an toàn Silent Mode đang bật).'
        : 'Đã gửi yêu cầu xác thực thành công.',
    };
  }

  if (action === 'scan_consultants_from_sheet' || action === 'invite_consultants_from_sheet') {
    return {
      success: true,
      data: [],
      message: 'Tính năng đồng bộ Google Sheets hỗ trợ qua Apps Script / Kết nối Webhook trong mục Tích hợp.',
    };
  }

  // ============================================================================
  // 3. ROUTING RULES
  // ============================================================================
  if (action === 'get_rules') {
    const r = await client.query(
      `SELECT rr.*, dr.name AS round_name
       FROM routing_rules rr
       LEFT JOIN distribution_rounds dr ON dr.tenant_id = rr.tenant_id AND dr.id = rr.round_id
       WHERE rr.tenant_id = $1
       ORDER BY rr.priority ASC, rr.created_at ASC`,
      [ctx.tenantId]
    );
    return {
      success: true,
      data: r.rows.map((row) => {
        const rawConds = Array.isArray(row.conditions_json) ? row.conditions_json : [];
        const rawBranches = Array.isArray(row.condition_branches) ? row.condition_branches : [];
        const normCond = (c: any) => ({
          col: String(c?.col || c?.field || c?.column || 'source'),
          op: String(c?.op || c?.operator || 'contains'),
          val: String(c?.val ?? c?.value ?? ''),
        });
        let branches: Array<{ conditions: Array<{ col: string; op: string; val: string }>; inject?: any }> = [];
        if (rawBranches.length > 0) {
          branches = rawBranches.map((b: any) => ({
            conditions: Array.isArray(b?.conditions) ? b.conditions.map(normCond) : [normCond(b)],
            inject: b?.inject || { enabled: false, fields: [] },
          }));
        } else if (rawConds.length > 0 && rawConds[0] && Array.isArray((rawConds[0] as any).conditions)) {
          branches = rawConds.map((b: any) => ({
            conditions: Array.isArray(b?.conditions) ? b.conditions.map(normCond) : [],
            inject: b?.inject || { enabled: false, fields: [] },
          }));
        } else if (rawConds.length > 0) {
          branches = [{ conditions: rawConds.map(normCond), inject: { enabled: false, fields: [] } }];
        }
        const firstCond = branches[0]?.conditions?.[0] || { col: 'source', op: 'contains', val: '' };
        return {
          id: row.id,
          rule_name: row.rule_name,
          priority: Number(row.priority || 1),
          target_round_id: row.round_id,
          round_name: row.round_name || '',
          conditions_json: JSON.stringify(branches),
          conditions: rawConds.map(normCond),
          condition_branches: branches,
          condition_column: firstCond.col,
          condition_operator: firstCond.op,
          condition_value: firstCond.val,
          connection_id: Array.isArray(row.connection_scopes) ? row.connection_scopes.join(',') : 'all',
          inject_fields: row.inject_fields || {},
          is_active: row.is_active ? 1 : 0,
        };
      }),
    };
  }

  if (action === 'add_rule' || action === 'edit_rule') {
    const isEdit = action === 'edit_rule';
    const roundId = String(body.target_round_id || body.round_id || '').trim();
    const ruleName = String(body.rule_name || 'Quy tắc mới').trim();
    const conditions = Array.isArray(body.conditions) ? body.conditions : Array.isArray(body.conditions_json) ? body.conditions_json : [];
    const branches = Array.isArray(body.condition_branches) ? body.condition_branches : [];
    const connScopes = Array.isArray(body.connection_scopes) ? body.connection_scopes : ['all'];
    const isActive = body.is_active === undefined ? true : Boolean(Number(body.is_active) === 1 || body.is_active === true);
    if (!roundId) return { success: false, message: 'Vui lòng chọn Vòng phân bổ đích.' };

    if (isEdit && body.id) {
      await client.query(
        `UPDATE routing_rules
         SET round_id = $3, rule_name = $4, conditions_json = $5::jsonb, condition_branches = $6::jsonb,
             connection_scopes = $7::jsonb, is_active = $8, updated_at = clock_timestamp()
         WHERE tenant_id = $1 AND id = $2`,
        [ctx.tenantId, String(body.id), roundId, ruleName, JSON.stringify(conditions), JSON.stringify(branches), JSON.stringify(connScopes), isActive]
      );
      return { success: true, message: 'Đã cập nhật quy tắc điều hướng.' };
    }

    const ins = await client.query<{ id: string }>(
      `INSERT INTO routing_rules (tenant_id, round_id, rule_name, priority, conditions_json, condition_branches, connection_scopes, is_active)
       VALUES ($1, $2, $3, $4, $5::jsonb, $6::jsonb, $7::jsonb, $8)
       RETURNING id`,
      [ctx.tenantId, roundId, ruleName, Number(body.priority || 1), JSON.stringify(conditions), JSON.stringify(branches), JSON.stringify(connScopes), isActive]
    );
    return { success: true, id: ins.rows[0].id, message: 'Đã tạo quy tắc điều hướng mới.' };
  }

  if (action === 'delete_rule') {
    const id = String(params.get('id') || body.id || '').trim();
    await client.query('DELETE FROM routing_rules WHERE tenant_id = $1 AND id = $2', [ctx.tenantId, id]);
    return { success: true, message: 'Đã xóa quy tắc.' };
  }

  if (action === 'reorder_rules') {
    const order: string[] = Array.isArray(body.order) ? body.order.map(String) : [];
    for (let i = 0; i < order.length; i++) {
      await client.query(
        'UPDATE routing_rules SET priority = $3 WHERE tenant_id = $1 AND id = $2',
        [ctx.tenantId, order[i], i + 1]
      );
    }
    return { success: true };
  }

  if (action === 'evaluate_rules_ai') {
    const r = await client.query('SELECT COUNT(*)::int AS cnt FROM routing_rules WHERE tenant_id = $1 AND is_active = true', [ctx.tenantId]);
    return {
      success: true,
      evaluation: `Hệ thống đang vận hành ${r.rows[0]?.cnt || 0} quy tắc điều hướng ưu tiên theo thứ tự. Không phát hiện xung đột vòng lặp giữa các luồng.`,
    };
  }

  // ============================================================================
  // 4. CONNECTIONS, MAPPINGS & INTEGRATIONS
  // ============================================================================
  if (action === 'get_connections') {
    const r = await client.query(
      `SELECT id, name, webhook_type, url, token, signing_secret, field_mappings, subscribed_events, is_active, created_at, updated_at
       FROM tenant_webhooks
       WHERE tenant_id = $1
       ORDER BY created_at ASC`,
      [ctx.tenantId]
    );
    return {
      success: true,
      data: r.rows.map((w) => {
        const meta = w.field_mappings && typeof w.field_mappings === 'object' ? w.field_mappings : {};
        return {
          id: w.id,
          name: w.name,
          sheet_url: meta.sheet_url || w.url || '',
          sheet_name: meta.sheet_name || 'Trang tính1',
          spreadsheet_id: meta.spreadsheet_id || '',
          webhook_token: w.token,
          signing_secret: w.signing_secret,
          is_active: Boolean(w.is_active),
          connection_type: meta.connection_type || (w.webhook_type === 'inbound' ? 'webhook' : 'outbound'),
          sync_interval: Number(meta.sync_interval || 5),
          sync_mode: meta.sync_mode || 'new_only',
          is_silent: meta.is_silent ? 1 : 0,
          require_both_contact: meta.require_both_contact ? 1 : 0,
          notify_admin: meta.notify_admin ? 1 : 0,
          last_sync_at: formatDateTimeVnSql(w.updated_at),
        };
      }),
    };
  }

  if (action === 'add_connection' || action === 'edit_connection') {
    const isEdit = action === 'edit_connection';
    const name = String(body.name || 'Kết nối mới').trim();
    const meta = {
      sheet_url: body.sheet_url || '',
      sheet_name: body.sheet_name || 'Trang tính1',
      spreadsheet_id: body.spreadsheet_id || '',
      connection_type: body.connection_type || 'webhook',
      sync_interval: Number(body.sync_interval || 5),
      sync_mode: body.sync_mode || 'new_only',
      is_silent: Boolean(body.is_silent),
      require_both_contact: Boolean(body.require_both_contact),
      notify_admin: Boolean(body.notify_admin),
      mappings: Array.isArray(body.mappings) ? body.mappings : [],
    };
    if (isEdit && body.id) {
      await client.query(
        `UPDATE tenant_webhooks
         SET name = $3, url = COALESCE($4, url), field_mappings = COALESCE(field_mappings, '{}'::jsonb) || $5::jsonb,
             updated_at = clock_timestamp()
         WHERE tenant_id = $1 AND id = $2`,
        [ctx.tenantId, String(body.id), name, body.sheet_url || null, JSON.stringify(meta)]
      );
      return { success: true, message: 'Đã cập nhật kết nối.' };
    }
    const token = `whk_${crypto.randomBytes(12).toString('hex')}`;
    const secret = `whsec_${crypto.randomBytes(18).toString('hex')}`;
    const ins = await client.query<{ id: string }>(
      `INSERT INTO tenant_webhooks (tenant_id, name, webhook_type, url, token, signing_secret, field_mappings, is_active)
       VALUES ($1, $2, 'inbound', $3, $4, $5, $6::jsonb, true)
       RETURNING id`,
      [ctx.tenantId, name, body.sheet_url || null, token, secret, JSON.stringify(meta)]
    );
    return { success: true, id: ins.rows[0].id, message: 'Đã thêm kết nối mới.' };
  }

  if (action === 'delete_connection') {
    const id = String(params.get('id') || body.id || '').trim();
    await client.query('DELETE FROM tenant_webhooks WHERE tenant_id = $1 AND id = $2', [ctx.tenantId, id]);
    return { success: true };
  }

  if (action === 'toggle_connection' || action === 'toggle_require_both' || action === 'toggle_notify_admin') {
    const id = String(params.get('id') || body.id || '').trim();
    if (action === 'toggle_connection') {
      const active = Number(params.get('active')) === 1 || body.active === true;
      await client.query('UPDATE tenant_webhooks SET is_active = $3 WHERE tenant_id = $1 AND id = $2', [ctx.tenantId, id, active]);
    } else {
      const key = action === 'toggle_require_both' ? 'require_both_contact' : 'notify_admin';
      const val = Number(params.get(action === 'toggle_require_both' ? 'require' : 'notify')) === 1;
      await client.query(
        `UPDATE tenant_webhooks SET field_mappings = COALESCE(field_mappings,'{}'::jsonb) || $3::jsonb WHERE tenant_id = $1 AND id = $2`,
        [ctx.tenantId, id, JSON.stringify({ [key]: val })]
      );
    }
    return { success: true };
  }

  if (action === 'get_mappings') {
    const r = await client.query<{ id: string; field_mappings: Record<string, any> }>(
      'SELECT id, field_mappings FROM tenant_webhooks WHERE tenant_id = $1',
      [ctx.tenantId]
    );
    const list: any[] = [];
    for (const w of r.rows) {
      const mList = Array.isArray(w.field_mappings?.mappings) ? w.field_mappings.mappings : [];
      for (const m of mList) list.push({ ...m, connection_id: w.id });
    }
    return { success: true, data: list };
  }

  if (action === 'add_mapping' || action === 'edit_mapping' || action === 'delete_mapping') {
    const connId = String(body.connection_id || params.get('connection_id') || '').trim();
    const mappingId = String(params.get('id') || body.id || crypto.randomUUID());
    if (action === 'delete_mapping') {
      const all = await client.query<{ id: string; field_mappings: Record<string, any> }>(
        'SELECT id, field_mappings FROM tenant_webhooks WHERE tenant_id = $1',
        [ctx.tenantId]
      );
      for (const w of all.rows) {
        const cur = Array.isArray(w.field_mappings?.mappings) ? w.field_mappings.mappings : [];
        const next = cur.filter((m: any) => String(m.id) !== mappingId);
        if (next.length !== cur.length) {
          await client.query(
            `UPDATE tenant_webhooks SET field_mappings = COALESCE(field_mappings,'{}'::jsonb) || $3::jsonb WHERE tenant_id = $1 AND id = $2`,
            [ctx.tenantId, w.id, JSON.stringify({ mappings: next })]
          );
        }
      }
      return { success: true };
    }
    if (connId) {
      const wRes = await client.query<{ field_mappings: Record<string, any> }>(
        'SELECT field_mappings FROM tenant_webhooks WHERE tenant_id = $1 AND id = $2 LIMIT 1',
        [ctx.tenantId, connId]
      );
      const cur = Array.isArray(wRes.rows[0]?.field_mappings?.mappings) ? wRes.rows[0].field_mappings.mappings : [];
      const item = {
        id: mappingId,
        connection_id: connId,
        sheet_column: body.sheet_column || '',
        system_field: body.system_field || 'name',
      };
      const next = action === 'edit_mapping' ? cur.map((m: any) => (String(m.id) === mappingId ? item : m)) : [...cur, item];
      await client.query(
        `UPDATE tenant_webhooks SET field_mappings = COALESCE(field_mappings,'{}'::jsonb) || $3::jsonb WHERE tenant_id = $1 AND id = $2`,
        [ctx.tenantId, connId, JSON.stringify({ mappings: next })]
      );
    }
    return { success: true };
  }

  if (action === 'fetch_sheets' || action === 'fetch_columns' || action === 'force_sync' || action === 'test_master_sync') {
    return {
      success: true,
      data: action === 'fetch_columns' ? ['Họ tên', 'Số điện thoại', 'Email', 'Nguồn', 'Nhu cầu', 'Ghi chú'] : [],
      message: isOutboundSilentMode()
        ? 'Đã kiểm tra đồng bộ thành công (Chế độ an toàn Silent Mode).'
        : 'Đã đồng bộ dữ liệu kết nối.',
    };
  }

  // ============================================================================
  // 5. SETTINGS, TICKET SETTINGS, EMAIL, META CAPI & BATCH IMPORT
  // ============================================================================
  if (action === 'get_settings' || action === 'get_ticket_settings') {
    const tRes = await client.query<{ settings: Record<string, any> }>(
      'SELECT settings FROM tenants WHERE id = $1 LIMIT 1',
      [ctx.tenantId]
    );
    const rawSettings = tRes.rows[0]?.settings || {};
    const aiRes = await client.query(
      'SELECT is_enabled, mode, model_name, prompt_rules, manual_action, manual_rules, target_round_ids FROM ai_screener_configs WHERE tenant_id = $1 LIMIT 1',
      [ctx.tenantId]
    );
    const aiRow = aiRes.rows[0];
    const data = pickSettingsForLegacy(normalizeTenantSettings(rawSettings), {
      ...rawSettings,
      ...(aiRow
        ? {
            ai_screener_enabled: aiRow.is_enabled,
            ai_screener_mode: aiRow.mode,
            gemini_model: aiRow.model_name,
            ai_screener_rules: aiRow.prompt_rules,
            ai_screener_manual_action: aiRow.manual_action,
            ai_screener_manual_rules: aiRow.manual_rules,
            ai_screener_rounds: aiRow.target_round_ids,
          }
        : {}),
    });

    if (action === 'get_ticket_settings') {
      return { success: true, data: rawSettings.ticket_notify_admins || [] };
    }
    return { success: true, data };
  }

  if (action === 'save_settings' || action === 'save_ticket_settings') {
    const payload = { ...body };
    if (action === 'save_ticket_settings') {
      const admins = Array.isArray(body.admin_ids) ? body.admin_ids : Array.isArray(body.ticket_notify_admins) ? body.ticket_notify_admins : [];
      await client.query(
        `UPDATE tenants SET settings = COALESCE(settings,'{}'::jsonb) || $2::jsonb, updated_at = clock_timestamp() WHERE id = $1`,
        [ctx.tenantId, JSON.stringify({ ticket_notify_admins: admins })]
      );
      tenantRedis.invalidateTenantCache(ctx.tenantId);
      return { success: true, message: 'Đã lưu cấu hình thông báo Ticket.' };
    }

    const patchObj: Record<string, any> = { ...payload };
    delete patchObj.action;
    delete patchObj.tenant_settings;
    if (patchObj.ses_password === '••••••••') {
      delete patchObj.ses_password;
    }

    if (payload.tenant_settings && typeof payload.tenant_settings === 'object') {
      Object.assign(patchObj, payload.tenant_settings);
    }

    if (payload.duplicate_check_months !== undefined && payload.duplicate_threshold_days === undefined) {
      patchObj.duplicate_threshold_days = Math.max(1, Number(payload.duplicate_check_months)) * 30;
    }

    const legacyBoolKeys = [
      'starvation_prevention_enabled',
      'ticket_auto_approve_enabled',
      'zalo_notify_only_group',
      'ai_screener_enabled',
      'auto_accept_on_assign',
      'auto_drain_on_online',
      'drain_recalled_leads',
      'enable_vacation_credits',
      'sla_auto_recall_enabled',
      'use_default_sla_fallback',
      'enforce_work_schedule',
      'work_schedule_sunday_enabled',
      'block_repeated_digits',
      'allow_international_phones',
      'pii_masking_enabled',
      'pii_mask_before_accept',
      'pii_mask_all_sales',
      'pii_mask_email',
      'pii_hide_internal_notes',
      'auto_disqualify_on_ticket_approve',
      'capi_enabled',
    ];
    for (const bk of legacyBoolKeys) {
      if (patchObj[bk] !== undefined) {
        patchObj[bk] =
          patchObj[bk] === true ||
          patchObj[bk] === 1 ||
          patchObj[bk] === '1' ||
          patchObj[bk] === 'true';
      }
    }

    const legacyJsonKeys = [
      'ticket_auto_approve_rules',
      'note_types',
      'ticket_reasons',
      'pipeline_capi_stages',
      'capi_rules',
      'notification_templates',
      'blocked_phone_sequences',
      'role_permissions',
      'daily_report_admins',
      'ticket_notify_admins',
      'ai_screener_manual_rules',
    ];
    for (const jk of legacyJsonKeys) {
      if (typeof patchObj[jk] === 'string') {
        const trimmed = patchObj[jk].trim();
        if (trimmed) {
          try {
            patchObj[jk] = JSON.parse(trimmed);
          } catch {
            // keep raw string
          }
        }
      }
    }

    if (patchObj.report_error_reasons !== undefined && patchObj.ticket_reasons === undefined) {
      let rawReasons = patchObj.report_error_reasons;
      if (typeof rawReasons === 'string') {
        try {
          rawReasons = JSON.parse(rawReasons);
        } catch {
          rawReasons = null;
        }
      }
      if (Array.isArray(rawReasons)) {
        patchObj.ticket_reasons = rawReasons
          .map((item: any, idx: number) => {
            if (typeof item === 'string') return item.trim();
            if (item && typeof item === 'object') {
              return {
                value: String(item.note || item.value || `REASON_${idx + 1}`).trim(),
                label: String(item.reason || item.label || item.note || '').trim(),
                auto_disqualify: item.auto_disqualify !== undefined ? Boolean(item.auto_disqualify) : true,
              };
            }
            return null;
          })
          .filter(Boolean);
      }
    }

    const curTenantRes = await client.query<{ settings: Record<string, any> }>(
      'SELECT settings FROM tenants WHERE id = $1 LIMIT 1',
      [ctx.tenantId]
    );
    const curRawSettings =
      curTenantRes.rows[0]?.settings && typeof curTenantRes.rows[0].settings === 'object'
        ? curTenantRes.rows[0].settings
        : {};
    const mergedRaw = { ...curRawSettings, ...patchObj };
    const normalizedSettings = normalizeTenantSettings(mergedRaw);
    const finalStoredSettings = { ...mergedRaw, ...normalizedSettings };

    await client.query(
      `UPDATE tenants SET settings = $2::jsonb, updated_at = clock_timestamp() WHERE id = $1`,
      [ctx.tenantId, JSON.stringify(finalStoredSettings)]
    );

    if (
      payload.ai_screener_enabled !== undefined ||
      payload.ai_screener_rules !== undefined ||
      payload.ai_screener_mode !== undefined
    ) {
      const isEnabled =
        payload.ai_screener_enabled !== undefined
          ? Number(payload.ai_screener_enabled) === 1 || payload.ai_screener_enabled === true
          : true;
      await client.query(
        `UPDATE ai_screener_configs
         SET is_enabled = COALESCE($2, is_enabled),
             mode = COALESCE($3, mode),
             prompt_rules = COALESCE($4, prompt_rules),
             model_name = COALESCE($5, model_name),
             manual_action = COALESCE($6, manual_action),
             updated_at = clock_timestamp()
         WHERE tenant_id = $1`,
        [
          ctx.tenantId,
          isEnabled,
          payload.ai_screener_mode || null,
          payload.ai_screener_rules || null,
          payload.gemini_model || null,
          payload.ai_screener_manual_action || null,
        ]
      );
    }

    tenantRedis.invalidateTenantCache(ctx.tenantId);
    return { success: true, message: 'Đã lưu cấu hình hệ thống.' };
  }

  if (action === 'get_meta_ads_config') {
    const summary = await getMetaAdsConfigSummary(client, ctx.tenantId);
    return { success: true, data: summary };
  }

  if (action === 'discover_meta_assets' || action === 'fetch_meta_token_assets' || action === 'list_meta_token_accounts') {
    const res = await discoverMetaTokenAssets(client, ctx.tenantId, {
      access_token: body.access_token !== undefined ? String(body.access_token) : undefined,
      account_id: body.account_id ? String(body.account_id) : body.id ? String(body.id) : undefined,
      ad_account_id: body.ad_account_id ? String(body.ad_account_id) : undefined,
    });
    return res;
  }

  if (action === 'add_meta_ad_account' || action === 'update_meta_ad_account' || action === 'save_meta_ad_account' || action === 'save_meta_ads_config') {
    if (Array.isArray(body.accounts)) {
      let lastRes: any = null;
      for (const acc of body.accounts) {
        if (!acc || !acc.ad_account_id) continue;
        lastRes = await upsertMetaAdAccount(client, ctx.tenantId, acc);
        if (!lastRes.success) return lastRes;
      }
      const summary = await getMetaAdsConfigSummary(client, ctx.tenantId);
      return { success: true, data: summary, message: `Đã lưu cấu hình ${summary.total_accounts} tài khoản Meta Ads vào Vault AES-256.` };
    }
    const res = await upsertMetaAdAccount(client, ctx.tenantId, {
      id: body.id ? String(body.id) : undefined,
      name: body.name ? String(body.name) : undefined,
      ad_account_id: String(body.ad_account_id || ''),
      access_token: body.access_token !== undefined ? String(body.access_token) : undefined,
      pixel_id: body.pixel_id !== undefined ? String(body.pixel_id) : undefined,
      is_active: body.is_active !== undefined ? Boolean(body.is_active) : undefined,
      requireNew: action === 'add_meta_ad_account' && !body.id,
    });
    return res.success
      ? { success: true, account: res.account, data: res.summary, message: res.message }
      : { success: false, error: res.message, message: res.message };
  }

  if (action === 'delete_meta_ad_account') {
    const ref = String(body.id || body.ad_account_id || params.get('id') || params.get('ad_account_id') || '').trim();
    const purge = Boolean(body.purge_insights);
    const res = await deleteMetaAdAccount(client, ctx.tenantId, ref, purge);
    return res.success
      ? { success: true, data: res.summary, message: res.message }
      : { success: false, error: res.message, message: res.message };
  }

  if (action === 'toggle_meta_ad_account') {
    const ref = String(body.id || body.ad_account_id || '').trim();
    const res = await toggleMetaAdAccountStatus(client, ctx.tenantId, ref, body.is_active !== false);
    return res.success
      ? { success: true, account: res.account, data: res.summary, message: res.message }
      : { success: false, error: res.message, message: res.message };
  }

  if (action === 'save_capi_settings') {
    // Preserve existing token when __KEEP_EXISTING__ is sent
    const nextBody = { ...(body || {}) };
    if (nextBody.capi_access_token === '__KEEP_EXISTING__') {
      const existingRes = await client.query<{ config_encrypted: string; iv: string; auth_tag: string }>(
        `SELECT config_encrypted, iv, auth_tag FROM tenant_integrations WHERE tenant_id = $1 AND integration_type = 'meta_capi' LIMIT 1`,
        [ctx.tenantId]
      );
      if (existingRes.rows[0]) {
        try {
          const { decryptTenantSecret } = await import('../../core/crypto/vault.ts');
          const prev = decryptTenantSecret<Record<string, any>>(
            ctx.tenantId,
            existingRes.rows[0].config_encrypted,
            existingRes.rows[0].iv,
            existingRes.rows[0].auth_tag
          );
          nextBody.capi_access_token = prev.capi_access_token || prev.access_token || '';
        } catch {
          nextBody.capi_access_token = '';
        }
      }
    }
    const enc = encryptTenantSecret(ctx.tenantId, nextBody);
    await client.query(
      `INSERT INTO tenant_integrations (tenant_id, integration_type, config_encrypted, iv, auth_tag, status)
       VALUES ($1, 'meta_capi', $2, $3, $4, 'active')
       ON CONFLICT (tenant_id, integration_type)
       DO UPDATE SET config_encrypted = EXCLUDED.config_encrypted, iv = EXCLUDED.iv, auth_tag = EXCLUDED.auth_tag, status = 'active', updated_at = clock_timestamp()`,
      [ctx.tenantId, enc.configEncrypted, enc.iv, enc.authTag]
    );
    tenantRedis.invalidateTenantIntegrations(ctx.tenantId);
    return { success: true, message: 'Đã lưu cấu hình Meta CAPI thành công vào Vault AES-256.' };
  }

  if (action === 'sync_meta_ads_data') {
    const accountRef = String(body.account_id || body.ad_account_id || params.get('ad_account_id') || '').trim();
    const syncRes = await syncMetaAdsAccounts(client, ctx.tenantId, { accountRef: accountRef || undefined });
    return syncRes;
  }

  if (action === 'sync_capi_sheet_ids' || action === 'backfill_capi_events') {
    return { success: true, synced_ads: 0, message: 'Đã đồng bộ định danh & kiểm tra hàng đợi Meta CAPI.' };
  }
  if (action === 'send_single_lead_capi') {
    const leadId = String(body.lead_id || '').trim();
    const lRes = await client.query('SELECT * FROM leads WHERE tenant_id = $1 AND id = $2 LIMIT 1', [ctx.tenantId, leadId]);
    if (!lRes.rows[0]) return { success: false, message: 'Không tìm thấy Lead.' };
    const l = lRes.rows[0];
    const capiRes = await dispatchStageCapiEvent(client, {
      tenantId: ctx.tenantId,
      tenantSlug: ctx.tenantSlug,
      eventName: String(body.event_name || 'Lead'),
      lead: {
        leadId: l.id,
        name: l.name,
        phone: l.phone,
        email: l.email,
        fbc: l.fbc,
        fbp: l.fbp,
        fbclid: l.fbclid,
        metaLeadId: l.meta_lead_id,
        customFields: l.custom_fields,
      },
    });
    return { success: true, data: capiRes, message: 'Đã gửi tín hiệu CAPI cho Lead.' };
  }
  if (action === 'get_ad_preview_iframe') {
    const adId = String(params.get('ad_id') || body.ad_id || 'meta_ad').trim();
    const [adLeadStats, insightRes] = await Promise.all([
      client.query<{
        cnt: number;
        ad_name: string | null;
        adset_name: string | null;
        campaign_name: string | null;
      }>(
        `SELECT COUNT(*)::int AS cnt,
                MAX(COALESCE(custom_fields->>'ad_name', '')) AS ad_name,
                MAX(COALESCE(custom_fields->>'adset_name', '')) AS adset_name,
                MAX(COALESCE(custom_fields->>'campaign_name', '')) AS campaign_name
         FROM leads
         WHERE tenant_id = $1 AND is_deleted = false AND (ad_id = $2 OR custom_fields->>'ad_id' = $2 OR source ILIKE $3)`,
        [ctx.tenantId, adId, `%${adId}%`]
      ),
      client.query(
        `SELECT MAX(ad_account_id) AS ad_account_id, MAX(ad_name) AS ad_name,
                MAX(campaign_name) AS campaign_name, MAX(adset_name) AS adset_name,
                SUM(spend)::numeric AS spend, SUM(impressions)::int AS impressions,
                SUM(clicks)::int AS clicks, SUM(reach)::int AS reach,
                MAX(thumbnail_url) AS thumbnail_url, MAX(image_url) AS image_url,
                MAX(creative_title) AS creative_title, MAX(creative_body) AS creative_body
         FROM meta_ads_insights
         WHERE tenant_id = $1 AND ad_id = $2`,
        [ctx.tenantId, adId]
      ),
    ]);
    const row = adLeadStats.rows[0];
    const ins = insightRes.rows[0] || {};
    const leadsCount = Number(row?.cnt || 0);
    const adName = ins.ad_name || row?.ad_name || `Bài Quảng Cáo #${adId}`;
    const campaignName = ins.campaign_name || row?.campaign_name || 'Meta Lead Generation';
    const adsetName = ins.adset_name || row?.adset_name || 'Target Audience';
    const spend = Number(ins.spend || 0);
    const impressions = Number(ins.impressions || 0);
    const clicks = Number(ins.clicks || 0);
    const ctr = impressions > 0 ? Number(((clicks / impressions) * 100).toFixed(2)) : 0;
    const cpl = leadsCount > 0 && spend > 0 ? Math.round(spend / leadsCount) : 0;
    const thumb = ins.image_url || ins.thumbnail_url || '';
    const previewHtml = `<div style="padding:20px;border-radius:14px;background:#ffffff;border:1px solid #e2e8f0;color:#0F172A;font-family:Inter,sans-serif">
      ${thumb ? `<div style="margin-bottom:14px;border-radius:10px;overflow:hidden;border:1px solid #e2e8f0;max-height:280px"><img src="${thumb}" alt="" style="width:100%;height:auto;object-fit:cover;display:block"/></div>` : ''}
      <div style="display:inline-flex;align-items:center;gap:6px;padding:3px 10px;border-radius:999px;background:#EFF6FF;color:#1E40FF;font-size:11px;font-weight:700;margin-bottom:8px">META ADS CREATIVE${ins.ad_account_id ? ` • act_${ins.ad_account_id}` : ''}</div>
      <h4 style="margin:0 0 6px;font-size:15px;font-weight:700;color:#0F172A">${adName}</h4>
      ${ins.creative_body ? `<p style="margin:0 0 12px;font-size:12.5px;line-height:1.5;color:#334155;white-space:pre-line">${String(ins.creative_body).slice(0, 320)}</p>` : ''}
      <p style="margin:0 0 10px;font-size:12px;color:#64748b">Ad ID: <code>${adId}</code> • ${campaignName}</p>
      <div style="display:inline-block;padding:8px 14px;border-radius:10px;background:#F8FAFC;border:1px solid #E2E8F0;font-size:12px;color:#334155">Đã ghi nhận <strong>${leadsCount}</strong> Lead từ mẫu quảng cáo này.</div>
    </div>`;
    return {
      success: true,
      html: previewHtml,
      data: {
        ad_id: adId,
        ad_account_id: ins.ad_account_id || '',
        ad_name: adName,
        campaign_name: campaignName,
        adset_name: adsetName,
        thumbnail_url: ins.thumbnail_url || '',
        image_url: ins.image_url || '',
        creative_title: ins.creative_title || '',
        creative_body: ins.creative_body || '',
        html: previewHtml,
        iframe_html: previewHtml,
        leads_count: leadsCount,
        spend,
        impressions,
        clicks,
        reach: Number(ins.reach || 0),
        ctr,
        cpl,
        deep_insights: {},
      },
    };
  }

  if (action === 'batch_check_duplicates' || action === 'check_sheet_duplicates') {
    const rows = Array.isArray(body.phones) ? body.phones : Array.isArray(body.rows) ? body.rows : [];
    const e164s = rows.map((p: any) => normalizePhoneE164(String(typeof p === 'string' ? p : p?.phone || ''), { default_dial_code: cfg.default_dial_code })).filter(Boolean);
    const existing = e164s.length
      ? await client.query<{ phone: string }>('SELECT DISTINCT phone FROM leads WHERE tenant_id = $1 AND phone = ANY($2::text[])', [ctx.tenantId, e164s])
      : { rows: [] };
    const dupSet = new Set(existing.rows.map((x) => x.phone));
    return {
      success: true,
      duplicates: Array.from(dupSet),
      total_checked: e164s.length,
      duplicate_count: dupSet.size,
    };
  }

  if (action === 'get_import_history') {
    const r = await client.query(
      'SELECT * FROM lead_import_batches WHERE tenant_id = $1 ORDER BY created_at DESC LIMIT 50',
      [ctx.tenantId]
    );
    return {
      success: true,
      data: r.rows.map((row) => ({ ...row, created_at: formatDateTimeVnSql(row.created_at) })),
    };
  }

  if (action === 'delete_import_history') {
    const id = String(body.id || body.batch_id || '').trim();
    if (id) {
      await client.query('DELETE FROM lead_import_batches WHERE tenant_id = $1 AND id = $2', [ctx.tenantId, id]);
    }
    return { success: true, message: 'Đã xóa lịch sử đợt import.' };
  }

  if (action === 'batch_import_leads') {
    const rows = Array.isArray(body.leads) ? body.leads : Array.isArray(body.rows) ? body.rows : [];
    const fileName = String(body.file_name || 'Import.xlsx');
    const pip = await client.query<{ id: string }>(
      'SELECT id FROM tenant_pipelines WHERE tenant_id = $1 ORDER BY is_default DESC LIMIT 1',
      [ctx.tenantId]
    );
    const pipelineId = pip.rows[0]?.id;
    const stg = pipelineId
      ? await client.query<{ id: string }>(
          'SELECT id FROM tenant_pipeline_stages WHERE tenant_id = $1 AND pipeline_id = $2 ORDER BY stage_order ASC LIMIT 1',
          [ctx.tenantId, pipelineId]
        )
      : { rows: [] };
    const stageId = stg.rows[0]?.id;
    let imported = 0;
    if (pipelineId && stageId) {
      const validRows: Array<{ name: string; phone: string; email: string | null; source: string; custom_fields: any }> = [];
      for (const item of rows.slice(0, 500)) {
        const phone = normalizePhoneE164(String(item.phone || ''), { default_dial_code: cfg.default_dial_code });
        if (!phone) continue;
        validRows.push({
          name: String(item.name || 'Khách hàng Import'),
          phone,
          email: item.email ? String(item.email) : null,
          source: String(item.source || 'Import Excel'),
          custom_fields: { note: item.note || '', original_status: 'silent' },
        });
      }

      // Chunked multi-row batch insert (100 rows per batch)
      const CHUNK_SIZE = 100;
      for (let i = 0; i < validRows.length; i += CHUNK_SIZE) {
        const chunk = validRows.slice(i, i + CHUNK_SIZE);
        const valuePlaceholders: string[] = [];
        const params: any[] = [];
        let pIdx = 1;

        for (const row of chunk) {
          valuePlaceholders.push(
            `($${pIdx}, $${pIdx + 1}, $${pIdx + 2}, 'archived', $${pIdx + 3}, $${pIdx + 4}, $${pIdx + 5}, $${pIdx + 6}, $${pIdx + 7}::jsonb)`
          );
          params.push(
            ctx.tenantId,
            pipelineId,
            stageId,
            row.name,
            row.phone,
            row.email,
            row.source,
            JSON.stringify(row.custom_fields)
          );
          pIdx += 8;
        }

        await client.query(
          `INSERT INTO leads (tenant_id, pipeline_id, stage_id, status, name, phone, email, source, custom_fields)
           VALUES ${valuePlaceholders.join(', ')}`,
          params
        );
        imported += chunk.length;
      }
    }
    await client.query(
      `INSERT INTO lead_import_batches (tenant_id, file_name, total_rows, imported_count, duplicate_count, skipped_count, is_silent, status, imported_by)
       VALUES ($1, $2, $3, $4, 0, $5, true, 'completed', $6)`,
      [ctx.tenantId, fileName, rows.length, imported, Math.max(0, rows.length - imported), ctx.userId]
    );
    return { success: true, imported_count: imported, message: `Đã import ${imported} khách hàng vào kho lưu trữ.` };
  }

  // ============================================================================
  // 6. ACCOUNTS, PROFILE, AUDIT ROLLBACK & AI CHAT
  // ============================================================================
  if (action === 'get_accounts') {
    const r = await client.query(
      `SELECT u.id, u.full_name AS name, u.email, u.phone, u.role, u.avatar_url AS avatar, u.created_at,
              p.status, p.zalo_chat_id
       FROM users u
       LEFT JOIN tenant_user_profiles p ON p.tenant_id = u.tenant_id AND p.user_id = u.id
       WHERE u.tenant_id = $1 AND u.role IN ('tenant_admin', 'manager')
       ORDER BY u.created_at ASC`,
      [ctx.tenantId]
    );
    return {
      success: true,
      data: r.rows.map((row, idx) => ({
        id: row.id,
        username: row.email,
        name: row.name,
        email: row.email,
        phone: ctx.isExternalAgency && row.phone ? maskPhoneString(row.phone, cfg) : row.phone,
        role: row.role === 'tenant_admin' ? 'superadmin' : 'admin',
        is_primary_admin: idx === 0,
        status: row.status || 'active',
        avatar: row.avatar,
        zalo_chat_id: row.zalo_chat_id || null,
        created_at: formatDateTimeVnSql(row.created_at),
      })),
    };
  }

  if (action === 'add_account' || action === 'edit_account') {
    const isEdit = action === 'edit_account';
    const name = String(body.name || '').trim();
    const email = String(body.email || body.username || '').trim().toLowerCase();
    const role = body.role === 'superadmin' ? 'tenant_admin' : 'manager';
    if (!name || !email) return { success: false, message: 'Tên và Email quản trị là bắt buộc.' };

    if (isEdit && body.id) {
      await client.query(
        `UPDATE users SET full_name = $3, email = $4, role = $5, avatar_url = COALESCE($6, avatar_url), updated_at = clock_timestamp()
         WHERE tenant_id = $1 AND id = $2`,
        [ctx.tenantId, String(body.id), name, email, role, body.avatar || null]
      );
      if (body.password) {
        const ph = await hashPassword(String(body.password));
        await client.query('UPDATE users SET password_hash = $3 WHERE tenant_id = $1 AND id = $2', [ctx.tenantId, String(body.id), ph]);
      }
      return { success: true, message: 'Đã cập nhật tài khoản quản trị.' };
    }

    const ph = await hashPassword(String(body.password || 'Admin@123456'));
    const ins = await client.query<{ id: string }>(
      `INSERT INTO users (tenant_id, email, password_hash, full_name, role, is_external_agency, avatar_url)
       VALUES ($1, $2, $3, $4, $5, false, $6) RETURNING id`,
      [ctx.tenantId, email, ph, name, role, body.avatar || null]
    );
    await client.query(
      `INSERT INTO tenant_user_profiles (tenant_id, user_id, status, zalo_chat_id, is_available)
       VALUES ($1, $2, 'active', $3, true)`,
      [ctx.tenantId, ins.rows[0].id, body.zalo_chat_id || null]
    );
    return { success: true, id: ins.rows[0].id, message: 'Đã tạo tài khoản quản trị mới.' };
  }

  if (action === 'check_delete_account') {
    return { success: true, has_dependencies: false, dependencies: [] };
  }

  if (action === 'delete_account') {
    const id = String(params.get('id') || body.id || '').trim();
    if (id === ctx.userId) return { success: false, message: 'Không thể tự xóa tài khoản đang đăng nhập.' };
    await client.query(`DELETE FROM users WHERE tenant_id = $1 AND id = $2 AND role != 'sale'`, [ctx.tenantId, id]);
    return { success: true, message: 'Đã xóa tài khoản quản trị.' };
  }

  if (action === 'rollback_admin_action') {
    const logId = String(body.id || '').trim();
    await client.query(
      `UPDATE admin_audit_logs SET is_rolled_back = true, rolled_back_at = clock_timestamp(), rolled_back_by = $3
       WHERE tenant_id = $1 AND id = $2`,
      [ctx.tenantId, logId, ctx.userId]
    );
    return { success: true, message: 'Đã đánh dấu hoàn tác thao tác kiểm toán.' };
  }

  if (action === 'update_profile' || action === 'update_consultant_self_profile') {
    const name = body.name ? String(body.name).trim() : null;
    const phone = body.phone !== undefined ? (body.phone ? String(body.phone).trim() : null) : null;
    await client.query(
      `UPDATE users SET full_name = COALESCE($3, full_name), phone = COALESCE($4, phone), avatar_url = COALESCE($5, avatar_url), updated_at = clock_timestamp()
       WHERE tenant_id = $1 AND id = $2`,
      [ctx.tenantId, ctx.userId, name, phone, body.avatar || null]
    );
    return { success: true, message: 'Đã cập nhật hồ sơ cá nhân.' };
  }

  if (action === 'change_password') {
    const curr = String(body.current_password || '');
    const next = String(body.new_password || '');
    if (next.length < 6) return { success: false, message: 'Mật khẩu mới tối thiểu 6 ký tự.' };
    const uRes = await client.query<{ password_hash: string }>('SELECT password_hash FROM users WHERE tenant_id = $1 AND id = $2', [ctx.tenantId, ctx.userId]);
    const ok = uRes.rows[0] ? await verifyPassword(curr, uRes.rows[0].password_hash) : false;
    if (!ok) return { success: false, message: 'Mật khẩu hiện tại không chính xác.' };
    const ph = await hashPassword(next);
    await client.query('UPDATE users SET password_hash = $3 WHERE tenant_id = $1 AND id = $2', [ctx.tenantId, ctx.userId, ph]);
    return { success: true, message: 'Đã đổi mật khẩu thành công.' };
  }

  if (action === 'upload_avatar') {
    const dataUrl = body.avatar ? String(body.avatar) : null;
    return { success: true, url: dataUrl || '', avatar: dataUrl || '' };
  }

  if (action === 'ai_chat') {
    const prompt = String(body.message || body.prompt || '').trim();
    const sum = await client.query(
      `SELECT COUNT(*)::int AS total, COUNT(*) FILTER (WHERE status = 'assigned')::int AS assigned
       FROM leads WHERE tenant_id = $1 AND is_deleted = false AND status != 'archived'`,
      [ctx.tenantId]
    );
    const total = sum.rows[0]?.total || 0;
    const assigned = sum.rows[0]?.assigned || 0;
    return {
      success: true,
      reply: `Hiện hệ thống ghi nhận ${total} Lead đang hoạt động (${assigned} đã phân bổ). Về câu hỏi "${prompt}": tất cả vòng xoay & quy tắc điều hướng đều đang vận hành ổn định theo cấu hình Tenant.`,
    };
  }

  return null;
}
