import crypto from 'node:crypto';
import { APP_CONFIG } from '../config.ts';
import { withTenantTransaction, withSystemPrivilege } from '../core/database/transaction.ts';
import { encryptTenantSecret, decryptTenantSecret } from '../core/crypto/vault.ts';
import { tenantRedis } from '../core/cache/tenant-redis.ts';
import { getTenantIntegrationCached, getTenantIntegrationsBatchCached, getTenantSettingsCached } from '../core/settings/tenant-cache.ts';
import { renderTemplateString } from '../core/settings/tenant-settings.ts';
import { chunkTextForChat } from './zalo-mail.service.ts';

export interface TelegramConfig {
  botToken?: string;
  chatId?: string;
  silentMode: boolean; // if true, zero HTTP requests to api.telegram.org
  enabled: boolean;
}

export interface TelegramNotificationResult {
  success: boolean;
  messageId?: number;
  silent: boolean;
  mocked: boolean;
  error?: string;
}

export interface TelegramVaultConfig {
  bot_token?: string;
  botToken?: string;
  chat_id?: string;
  chatId?: string;
  silent_mode?: boolean;
  silentMode?: boolean;
  enabled?: boolean;
}

export interface TelegramBotCommandInput {
  tenantId: string;
  chatId: string;
  text: string;
  senderTelegramId?: string | number;
  senderUsername?: string;
  senderName?: string;
  actorUserId?: string;
}

export interface TelegramBotCommandResult {
  handled: boolean;
  command: string;
  replyText: string;
  metadata?: Record<string, unknown>;
}

export type TelegramTransportFn = (payload: {
  chatId: string;
  text: string;
  parseMode?: 'HTML' | 'MarkdownV2' | string;
}) => Promise<{ messageId?: number; message_id?: number; ok?: boolean } | void>;

let customTelegramTransport: TelegramTransportFn | null = null;

/**
 * Configure mock/spy transport for unit and integration testing.
 * When set (and not in silent mode), outbound requests go to this function instead of api.telegram.org.
 */
export function setTelegramTransportForTesting(fn: TelegramTransportFn | null): void {
  customTelegramTransport = fn;
}

export function getTelegramTransportForTesting(): TelegramTransportFn | null {
  return customTelegramTransport;
}

function parseVaultBool(val: unknown): boolean {
  if (typeof val === 'boolean') return val;
  if (typeof val === 'number') return val !== 0;
  const low = String(val ?? '').trim().toLowerCase();
  if (low === 'false' || low === '0' || low === 'no' || low === 'off' || low === '') return false;
  if (low === 'true' || low === '1' || low === 'yes' || low === 'on') return true;
  return Boolean(val);
}

/**
 * Parses and resolves Telegram configuration:
 * Global kill-switches (TELEGRAM_SILENT_MODE='true', TELEGRAM_NOTIFY_ENABLED='false') take highest precedence,
 * followed by tenant Vault config, non-kill-switch env overrides, and APP_CONFIG defaults.
 */
export function getTelegramConfig(vaultConfig?: TelegramVaultConfig | null): TelegramConfig {
  const vaultSilent = vaultConfig?.silent_mode ?? vaultConfig?.silentMode;
  const silentMode =
    process.env.TELEGRAM_SILENT_MODE === 'true'
      ? true
      : vaultSilent !== undefined
        ? parseVaultBool(vaultSilent)
        : process.env.TELEGRAM_SILENT_MODE !== undefined
          ? process.env.TELEGRAM_SILENT_MODE === 'true'
          : APP_CONFIG.telegramSilentMode;

  const enabled =
    process.env.TELEGRAM_NOTIFY_ENABLED === 'false'
      ? false
      : vaultConfig?.enabled !== undefined
        ? parseVaultBool(vaultConfig.enabled)
        : process.env.TELEGRAM_NOTIFY_ENABLED !== undefined
          ? process.env.TELEGRAM_NOTIFY_ENABLED === 'true'
          : APP_CONFIG.telegramNotifyEnabled;

  const botToken = (
    vaultConfig?.bot_token ||
    vaultConfig?.botToken ||
    process.env.TELEGRAM_BOT_TOKEN ||
    APP_CONFIG.telegramBotToken ||
    ''
  ).trim();

  const chatId = (
    vaultConfig?.chat_id ||
    vaultConfig?.chatId ||
    process.env.TELEGRAM_CHAT_ID ||
    APP_CONFIG.telegramChatId ||
    ''
  ).trim();

  return {
    botToken: botToken || undefined,
    chatId: chatId || undefined,
    silentMode,
    enabled,
  };
}

export async function resolveTenantTelegramConfig(
  tenantId: string | null
): Promise<{ config: TelegramConfig; vaultConfig: TelegramVaultConfig | null }> {
  let vaultConfig: TelegramVaultConfig | null = null;
  if (tenantId) {
    try {
      const tgBatch = await getTenantIntegrationsBatchCached(tenantId, ['telegram_bot', 'telegram']);
      const cachedRow = tgBatch.telegram_bot || tgBatch.telegram;
      if (cachedRow && cachedRow.status === 'active') {
        vaultConfig = decryptTenantSecret<TelegramVaultConfig>(
          tenantId,
          cachedRow.config_encrypted,
          cachedRow.iv,
          cachedRow.auth_tag
        );
      }
    } catch {
      vaultConfig = null;
    }
  }
  return {
    config: getTelegramConfig(vaultConfig),
    vaultConfig,
  };
}

/**
 * Sends a Telegram bot notification using native Node.js fetch (zero external dependencies).
 *
 * CRITICAL REQUIREMENT (R2):
 * In silent/mock mode (TELEGRAM_SILENT_MODE=true or TELEGRAM_NOTIFY_ENABLED=false),
 * guarantees 100% silent execution: ZERO outbound HTTP requests to api.telegram.org.
 * Returns { success: true, silent: true, mocked: true }.
 */
export async function sendTelegramNotification(
  tenantId: string | null,
  text: string,
  options?: {
    chatId?: string;
    parseMode?: 'HTML' | 'MarkdownV2';
    silentOverride?: boolean;
    resolvedConfig?: TelegramConfig;
  }
): Promise<TelegramNotificationResult> {
  // 1-2. Resolve effective Telegram configuration (reuse pre-resolved config if provided)
  const config = options?.resolvedConfig ?? (await resolveTenantTelegramConfig(tenantId)).config;
  const targetChatId = (options?.chatId || config.chatId || '').trim();

  // 3. Determine if silent execution is enforced
  const isSilent =
    options?.silentOverride !== undefined
      ? options.silentOverride
      : (config.silentMode || !config.enabled);

  // CRITICAL REQUIREMENT (R2): Guarantee 100% silent execution when silent mode active
  if (isSilent) {
    return {
      success: true,
      silent: true,
      mocked: true,
    };
  }

  const chunks = chunkTextForChat(text, 4096);
  const partsToSend = chunks.length > 0 ? chunks : [String(text || '')];

  // 4. Test transport interception (if custom transport provided and not in silent mode)
  if (customTelegramTransport) {
    try {
      let lastMessageId = 1001;
      for (const chunk of partsToSend) {
        const res = await customTelegramTransport({
          chatId: targetChatId,
          text: chunk,
          parseMode: options?.parseMode,
        });
        lastMessageId = res?.message_id || res?.messageId || lastMessageId;
      }
      return {
        success: true,
        messageId: lastMessageId,
        silent: false,
        mocked: true,
      };
    } catch (err: any) {
      return {
        success: false,
        silent: false,
        mocked: true,
        error: err?.message || 'Mock transport failed',
      };
    }
  }

  // 5. Validation for real outbound dispatch
  if (!config.botToken) {
    return {
      success: false,
      silent: false,
      mocked: false,
      error: 'TELEGRAM_BOT_TOKEN is not configured.',
    };
  }

  if (!targetChatId) {
    return {
      success: false,
      silent: false,
      mocked: false,
      error: 'TELEGRAM_CHAT_ID is not configured and no chatId option was provided.',
    };
  }

  // 6. Native Node.js fetch outbound call to Telegram Bot API (chunked <= 4096 chars per Telegram limit)
  const url = `https://api.telegram.org/bot${config.botToken}/sendMessage`;
  let lastMessageId: number | undefined;
  for (const chunk of partsToSend) {
    const payload: Record<string, unknown> = {
      chat_id: targetChatId,
      text: chunk,
    };
    if (options?.parseMode) {
      payload.parse_mode = options.parseMode;
    }

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 10_000);

    try {
      const resp = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(payload),
        signal: controller.signal,
      });
      clearTimeout(timeoutId);

      const data = (await resp.json().catch(() => ({}))) as any;
      if (!resp.ok || !data.ok) {
        return {
          success: false,
          silent: false,
          mocked: false,
          error: data?.description || `Telegram API error: HTTP ${resp.status}`,
        };
      }
      if (data.result?.message_id !== undefined) {
        lastMessageId = data.result.message_id;
      }
    } catch (err: any) {
      clearTimeout(timeoutId);
      return {
        success: false,
        silent: false,
        mocked: false,
        error: err?.message || 'Failed to dispatch Telegram HTTP request',
      };
    }
  }

  return {
    success: true,
    messageId: lastMessageId,
    silent: false,
    mocked: false,
  };
}

/**
 * Handles interactive Telegram Bot commands:
 * - `/chatid`: Returns the current group/channel chat ID for easy setup onboarding.
 * - `/tiepnhan <leadId>`: Accepts the assigned lead and resolves stage SLA.
 * - `/baoloi <leadId> <noidung>`: Records an error/complaint ticket in data_reports.
 */
export async function processTelegramBotCommand(
  input: TelegramBotCommandInput
): Promise<TelegramBotCommandResult> {
  const rawText = (input.text || '').trim();
  const lower = rawText.toLowerCase();

  const tenantCfg = await getTenantSettingsCached(input.tenantId);

  // 1. `/chatid` or `/id`
  if (lower === '/chatid' || lower === '/id') {
    const renderedChatIdReply = renderTemplateString(
      tenantCfg.notification_templates.bot_chatid_reply,
      { chat_id: input.chatId }
    ).replace(/<\/?code>/gi, '');
    return {
      handled: true,
      command: '/chatid',
      replyText:
        renderedChatIdReply ||
        `Mã Chat ID của nhóm này là: ${input.chatId}. Hãy nhập mã này vào Cấu hình Telegram Bot.`,
      metadata: { chat_id: input.chatId },
    };
  }

  // Resolve dynamic command settings for this tenant (with fallback to default '/tiepnhan' and '/baoloi')
  const acceptCmd = (tenantCfg.telegram_accept_command || '/tiepnhan').trim();
  const reportCmd = (tenantCfg.telegram_report_command || '/baoloi').trim();
  const escapeRegex = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const acceptCmdPattern = escapeRegex(acceptCmd);
  const reportCmdPattern = escapeRegex(reportCmd);

  return await withTenantTransaction(input.tenantId, async (client) => {
    // Resolve actor from explicit actorUserId or bound profile
    const actorRes = input.actorUserId
      ? await client.query<{ id: string; full_name: string; role: string }>(
          `SELECT u.id, u.full_name, u.role
           FROM users u
           LEFT JOIN tenant_user_profiles p ON p.tenant_id = u.tenant_id AND p.user_id = u.id
           WHERE u.tenant_id = $1 AND u.id = $2 AND COALESCE(p.status, 'active') = 'active'
           LIMIT 1`,
          [input.tenantId, input.actorUserId]
        )
      : { rows: [] };

    const actor = actorRes.rows[0] || null;

    // 2. Dynamic accept command (e.g. `/tiepnhan [<leadId>]` or tenant-configured command)
    const acceptRegex = new RegExp(`^(?:${acceptCmdPattern}|\\/tiepnhan)(?:\\s+#?([0-9a-fA-F-]{6,36}))?$`, 'i');
    const acceptMatch = rawText.match(acceptRegex);
    if (acceptMatch) {
      const leadPrefix = acceptMatch[1];
      let lead: {
        id: string;
        name: string;
        stage_id: string;
        assigned_to: string | null;
        created_at: string;
      } | null = null;

      if (leadPrefix) {
        const leadRes = await client.query<{
          id: string;
          name: string;
          stage_id: string;
          assigned_to: string | null;
          created_at: string;
        }>(
          `SELECT id, name, stage_id, assigned_to, created_at
           FROM leads
           WHERE tenant_id = $1 AND id::text LIKE $2
           LIMIT 1`,
          [input.tenantId, `${leadPrefix}%`]
        );
        if (!leadRes.rows[0]) {
          return {
            handled: true,
            command: acceptCmd,
            replyText: `⚠️ Không tìm thấy khách hàng mã #${leadPrefix}.`,
          };
        }
        lead = leadRes.rows[0];
      } else {
        // Fallback to latest unaccepted lead assigned to actor or tenant
        const querySql = actor?.id
          ? `SELECT id, name, stage_id, assigned_to, created_at FROM leads
             WHERE tenant_id = $1 AND assigned_to = $2
             ORDER BY is_accepted ASC, created_at DESC
             LIMIT 1`
          : `SELECT id, name, stage_id, assigned_to, created_at FROM leads
             WHERE tenant_id = $1
             ORDER BY is_accepted ASC, created_at DESC
             LIMIT 1`;
        const params = actor?.id ? [input.tenantId, actor.id] : [input.tenantId];
        const res = await client.query<{
          id: string;
          name: string;
          stage_id: string;
          assigned_to: string | null;
          created_at: string;
        }>(querySql, params);
        lead = res.rows[0] || null;

        if (!lead) {
          return {
            handled: true,
            command: acceptCmd,
            replyText: '⚠️ Hiện chưa có khách hàng nào đang chờ tiếp nhận.',
          };
        }
      }

      if (actor && actor.role === 'sale' && lead.assigned_to && lead.assigned_to !== actor.id) {
        return {
          handled: true,
          command: acceptCmd,
          replyText: '⛔ Bạn chỉ được tiếp nhận khách hàng được phân bổ cho chính mình.',
        };
      }

      const latencySec = Math.max(1, Math.round((Date.now() - new Date(lead.created_at).getTime()) / 1000));

      await client.query(
        `UPDATE leads SET is_accepted = true, accepted_at = clock_timestamp(), updated_at = clock_timestamp()
         WHERE tenant_id = $1 AND id = $2`,
        [input.tenantId, lead.id]
      );
      await tenantRedis.zrem('sla_queue', `${lead.id}:${lead.stage_id}`, input.tenantId);

      const actorId = actor?.id || lead.assigned_to || null;
      const actorRole = actor?.role || 'sale';
      const actorName = actor?.full_name || input.senderName || 'Telegram User';

      await client.query(
        `INSERT INTO lead_timeline_events (
          tenant_id, lead_id, event_type, event_category, actor_id, actor_role, actor_name, title, content, metadata
        ) VALUES ($1, $2, 'lead_accepted_telegram', 'communication', $3, $4, $5, $6, $7, $8::jsonb)`,
        [
          input.tenantId,
          lead.id,
          actorId,
          actorRole,
          actorName,
          `Tiếp nhận khách hàng qua Telegram Bot (${latencySec}s)`,
          `Lệnh ${acceptCmd} từ Telegram Chat ID ${input.chatId}`,
          JSON.stringify({ latency_seconds: latencySec, chat_id: input.chatId }),
        ]
      );

      return {
        handled: true,
        command: acceptCmd,
        replyText: `✅ Bạn đã tiếp nhận khách hàng ${lead.name} thành công! Thời gian phản hồi: ${latencySec} giây.`,
        metadata: { lead_id: lead.id, latency_seconds: latencySec },
      };
    }

    // 3. Dynamic report command (e.g. `/baoloi <leadId> <noidung>` or tenant-configured command)
    const reportRegex = new RegExp(`^(?:${reportCmdPattern}|\\/baoloi)\\s+(.+)$`, 'i');
    const reportMatch = rawText.match(reportRegex);
    if (reportMatch) {
      const body = reportMatch[1].trim();
      const explicitHash = body.match(/^#([0-9a-fA-F-]{6,36})\s+(.+)$/);
      const hexCandidate = !explicitHash ? body.match(/^([0-9a-fA-F-]{6,36})\s+(.+)$/) : null;

      let targetLead: { id: string; name: string; assigned_to: string | null } | null = null;
      let reason = body;

      if (explicitHash) {
        const [, leadPrefix, parsedReason] = explicitHash;
        reason = parsedReason;
        const res = await client.query<{ id: string; name: string; assigned_to: string | null }>(
          `SELECT id, name, assigned_to FROM leads WHERE tenant_id = $1 AND id::text LIKE $2 LIMIT 1`,
          [input.tenantId, `${leadPrefix}%`]
        );
        if (!res.rows[0]) {
          return {
            handled: true,
            command: reportCmd,
            replyText: `⚠️ Không tìm thấy khách hàng mã #${leadPrefix}.`,
          };
        }
        targetLead = res.rows[0];
      } else if (hexCandidate) {
        const [, leadPrefix, parsedReason] = hexCandidate;
        const res = await client.query<{ id: string; name: string; assigned_to: string | null }>(
          `SELECT id, name, assigned_to FROM leads WHERE tenant_id = $1 AND id::text LIKE $2 LIMIT 1`,
          [input.tenantId, `${leadPrefix}%`]
        );
        if (res.rows[0]) {
          targetLead = res.rows[0];
          reason = parsedReason;
        } else if (/[0-9a-fA-F-]/.test(leadPrefix)) {
          return {
            handled: true,
            command: reportCmd,
            replyText: `⚠️ Không tìm thấy khách hàng mã #${leadPrefix}.`,
          };
        }
      }

      if (!targetLead) {
        // Fallback to latest lead
        const res = await client.query<{ id: string; name: string; assigned_to: string | null }>(
          `SELECT id, name, assigned_to FROM leads WHERE tenant_id = $1 ORDER BY created_at DESC LIMIT 1`,
          [input.tenantId]
        );
        targetLead = res.rows[0] || null;
        if (!targetLead) {
          return {
            handled: true,
            command: reportCmd,
            replyText: '⚠️ Không tìm thấy khách hàng nào để báo lỗi.',
          };
        }
      }

      let reporterId = targetLead.assigned_to || actor?.id || input.actorUserId || null;
      if (!reporterId) {
        const fallbackAdmin = await client.query<{ id: string }>(
          `SELECT id FROM users WHERE tenant_id = $1 ORDER BY created_at ASC LIMIT 1`,
          [input.tenantId]
        );
        reporterId = fallbackAdmin.rows[0]?.id || null;
      }
      if (!reporterId) {
        return {
          handled: true,
          command: reportCmd,
          replyText: '⚠️ Không xác định được nhân sự báo lỗi cho khách hàng này.',
        };
      }
      const cleanedReason = reason.trim();

      const tkRes = await client.query<{ id: string }>(
        `INSERT INTO data_reports (tenant_id, lead_id, reporter_id, reason, description, status)
         VALUES ($1, $2, $3, $4, $5, 'pending')
         RETURNING id`,
        [input.tenantId, targetLead.id, reporterId, 'Telegram_Report', cleanedReason]
      );
      const ticketId = tkRes.rows[0].id;

      await client.query(
        `INSERT INTO lead_timeline_events (
          tenant_id, lead_id, event_type, event_category, actor_id, actor_role, actor_name, title, content, metadata
        ) VALUES ($1, $2, 'lead_error_reported_telegram', 'support', $3, $4, $5, $6, $7, $8::jsonb)`,
        [
          input.tenantId,
          targetLead.id,
          reporterId,
          actor?.role || 'sale',
          actor?.full_name || input.senderName || 'Telegram User',
          `Báo lỗi số liệu qua Telegram Bot`,
          `Lý do: ${cleanedReason}`,
          JSON.stringify({ ticket_id: ticketId, chat_id: input.chatId }),
        ]
      );

      return {
        handled: true,
        command: reportCmd,
        replyText: `📝 Đã ghi nhận khiếu nại #${ticketId.slice(0, 8)} cho khách hàng ${targetLead.name}. Quản lý sẽ kiểm tra và xét duyệt bù số.`,
        metadata: { ticket_id: ticketId, lead_id: targetLead.id },
      };
    }

    return {
      handled: false,
      command: rawText.split(' ')[0] || '',
      replyText:
        renderTemplateString(tenantCfg.notification_templates.bot_help_reply, {
          accept_cmd: acceptCmd,
          report_cmd: reportCmd,
        }) ||
        `ℹ️ Lệnh không được nhận diện. Các lệnh khả dụng: /chatid, ${acceptCmd} <leadId>, ${reportCmd} <leadId> <noidung>`,
    };
  });
}
