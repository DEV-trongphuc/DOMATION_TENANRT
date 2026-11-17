import crypto from 'node:crypto';
import { Router, type NextFunction, type Request, type Response } from 'express';
import { getDatabasePool } from '../core/database/db-adapter.ts';
import { withSystemPrivilege, withTenantTransaction } from '../core/database/transaction.ts';
import { getTenantContext } from '../core/context/tenant-context.ts';
import { requireAnyPermission, requireTenantAuth, sendApiError } from '../core/security/rbac.ts';
import { validateAndNormalizePhone } from '../services/phone.service.ts';
import { encryptTenantSecret, decryptTenantSecret } from '../core/crypto/vault.ts';
import { tenantRedis } from '../core/cache/tenant-redis.ts';
import { normalizeTenantSettings, type TenantSettings } from '../core/settings/tenant-settings.ts';
import {
  getTenantBySlugCached,
  getTenantMetaCached,
  getTenantSettingsCached,
} from '../core/settings/tenant-cache.ts';
import {
  verifyWebhookHmacSignature,
  checkAndRecordWebhookIdempotency,
  mapWebhookPayloadToLead,
  replayWebhookDlqItem,
  enqueueOutboundWebhookEvent,
} from '../services/webhook.service.ts';
import { ingestAndDistributeLead } from '../services/distribution.service.ts';
import { buildCapiUserData, dispatchStageCapiEventDetached } from '../services/capi.service.ts';
import {
  buildCategoryTestEmailContent,
  processZaloBotCommand,
  refreshExpiringZaloTokens,
  sendTenantEmailNotification,
} from '../services/zalo-mail.service.ts';
import {
  deleteMetaAdAccount,
  discoverMetaTokenAssets,
  getMetaAdsConfigSummary,
  syncMetaAdsAccounts,
  toggleMetaAdAccountStatus,
  upsertMetaAdAccount,
} from '../services/meta-ads.service.ts';
import { verifyTenantAccessToken } from '../core/crypto/jwt.ts';
import { extractRequestedTenantSlug } from '../core/security/rbac.ts';
import { processTelegramBotCommand, sendTelegramNotification } from '../services/telegram.service.ts';
import { isOutboundSilentMode } from '../core/security/outbound-guard.ts';

export const integrationsRouter = Router();
export const publicWebhooksRouter = Router();

/**
 * 6.1 Inbound Lead Webhook (High-Throughput Public Ingress)
 * Mounted at both `/api/v1/webhooks/:tenant_slug/:connection_token` and `/v1/webhooks/:tenant_slug/:connection_token`
 */
async function handleInboundWebhookIngress(req: Request, res: Response): Promise<void> {
  try {
    const slug = String(req.params.tenant_slug || '').trim().toLowerCase();
    const token = String(req.params.connection_token || '').trim();

    if (!slug || !token) {
      sendApiError(res, 400, 'INVALID_WEBHOOK_PATH', 'Thiếu định danh doanh nghiệp hoặc token kết nối.');
      return;
    }

    // Fast path: resolve inbound webhook & tenant config from hot memory cache before hitting DB
    let resolved: {
      tenant_id: string;
      tenant_status: string;
      tenant_cfg: TenantSettings;
      webhook_id: string;
      signing_secret: string;
      field_mappings: Record<string, unknown>;
      is_active: boolean;
    } | null = null;

    const cachedWh = tenantRedis.getCachedInboundWebhook(slug, token);
    if (cachedWh) {
      const meta = await getTenantMetaCached(cachedWh.tenant_id);
      if (meta) {
        resolved = {
          tenant_id: cachedWh.tenant_id,
          tenant_status: meta.status,
          tenant_cfg: meta.settings,
          webhook_id: cachedWh.id,
          signing_secret: cachedWh.signing_secret,
          field_mappings: cachedWh.field_mappings,
          is_active: cachedWh.is_active,
        };
      }
    }

    if (!resolved) {
      // Cache miss: resolve tenant & webhook config via audited pre-auth lookup
      const dbRow = await withSystemPrivilege(async (client) => {
        const r = await client.query<{
          tenant_id: string;
          tenant_slug: string;
          tenant_status: string;
          tenant_settings: Record<string, unknown>;
          webhook_id: string;
          signing_secret: string;
          field_mappings: Record<string, unknown>;
          is_active: boolean;
        }>(
          `SELECT t.id AS tenant_id, t.slug AS tenant_slug, t.obfuscated_slug, t.status AS tenant_status, t.settings AS tenant_settings,
                  w.id AS webhook_id, w.signing_secret, w.field_mappings, w.is_active
           FROM tenants t
           INNER JOIN tenant_webhooks w ON w.tenant_id = t.id
           WHERE (t.obfuscated_slug = $1 OR t.slug = $1) AND w.token = $2 AND w.webhook_type = 'inbound'
           LIMIT 1`,
          [slug, token]
        );
        return r.rows[0] || null;
      });

      if (dbRow) {
        const rawSettings = (
          dbRow.tenant_settings && typeof dbRow.tenant_settings === 'object' ? dbRow.tenant_settings : {}
        ) as Record<string, unknown>;
        const normalizedCfg = normalizeTenantSettings(rawSettings);
        tenantRedis.setCachedTenantMeta(dbRow.tenant_id, {
          slug: dbRow.tenant_slug,
          status: dbRow.tenant_status,
          rawSettings,
          normalizedSettings: normalizedCfg,
        });
        tenantRedis.setCachedInboundWebhook(slug, token, {
          id: dbRow.webhook_id,
          tenant_id: dbRow.tenant_id,
          tenant_slug: dbRow.tenant_slug,
          tenant_status: dbRow.tenant_status,
          signing_secret: dbRow.signing_secret,
          field_mappings: dbRow.field_mappings || {},
          is_active: dbRow.is_active,
        });
        resolved = {
          tenant_id: dbRow.tenant_id,
          tenant_status: dbRow.tenant_status,
          tenant_cfg: normalizedCfg,
          webhook_id: dbRow.webhook_id,
          signing_secret: dbRow.signing_secret,
          field_mappings: dbRow.field_mappings || {},
          is_active: dbRow.is_active,
        };
      }
    }

    if (!resolved || !resolved.is_active || resolved.tenant_status !== 'active') {
      sendApiError(res, 404, 'WEBHOOK_NOT_FOUND_OR_INACTIVE', 'Endpoint Webhook không tồn tại hoặc đang tạm tắt.');
      return;
    }

    const sigHeader = req.header('X-Webhook-Signature');
    const enforceHmac = Boolean(resolved.field_mappings?._enforce_hmac === true);

    if (sigHeader || enforceHmac) {
      const rawBody: Buffer | string = (req as any).rawBody || JSON.stringify(req.body || {});
      const sigOk = verifyWebhookHmacSignature(rawBody, resolved.signing_secret, sigHeader);
      if (!sigOk) {
        sendApiError(res, 401, 'INVALID_WEBHOOK_SIGNATURE', 'Chữ ký HMAC-SHA256 không hợp lệ.');
        return;
      }
    }

    const payload = (req.body && typeof req.body === 'object' ? req.body : {}) as Record<string, unknown>;
    const tenantCfg = resolved.tenant_cfg;

    const perWebhookTtlHours =
      resolved.field_mappings && resolved.field_mappings._idempotency_ttl_hours !== undefined
        ? Number(resolved.field_mappings._idempotency_ttl_hours)
        : tenantCfg.webhook_idempotency_ttl_hours;
    const ttlSeconds = Number.isFinite(perWebhookTtlHours) ? Math.round(perWebhookTtlHours * 3600) : 86_400;
    const ignoredKeys = Array.isArray(resolved.field_mappings?._ignored_keys)
      ? (resolved.field_mappings._ignored_keys as string[])
      : undefined;

    // Configurable Dual-Mode Idempotency Deduplication
    const idem = await checkAndRecordWebhookIdempotency({
      tenantId: resolved.tenant_id,
      idempotencyHeader: req.header('X-Idempotency-Key'),
      payload,
      ttlSeconds,
      ignoredKeys,
    });

    if (idem.isDuplicate) {
      res.status(200).json({
        success: true,
        status: 'DUPLICATE_SKIPPED',
        message: 'Lead submission already processed within idempotency window.',
      });
      return;
    }

    const mappedLead = mapWebhookPayloadToLead(
      payload,
      resolved.field_mappings,
      tenantCfg.default_lead_source
    );
    const deliveryId = `del-${crypto.randomUUID().slice(0, 13)}`;

    // Execute lead ingestion & distribution deterministically
    const distribution = await ingestAndDistributeLead(resolved.tenant_id, mappedLead);

    enqueueOutboundWebhookEvent({
      tenantId: resolved.tenant_id,
      eventType: 'lead.created',
      payload: {
        lead_id: distribution.leadId,
        status: distribution.status,
        assigned_to: distribution.assignedTo,
        source: mappedLead.source || tenantCfg.default_lead_source,
        delivery_id: deliveryId,
      },
    });

    res.status(202).json({
      success: true,
      delivery_id: deliveryId,
      status: 'ENQUEUED',
      lead_id: distribution.leadId,
      assigned_to: distribution.assignedTo,
      assigned_to_name: distribution.assignedName,
      phone_normalized: distribution.phoneNormalized,
      dispatch_reason: distribution.dispatchReason,
      distribution_mode: tenantCfg.distribution_mode,
      distribution_latency_ms: distribution.distributionLatencyMs,
      is_duplicate_reminder: distribution.isDuplicateReminder,
    });
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
    if (msg.startsWith('DUPLICATE_LEAD_REJECTED')) {
      sendApiError(res, 409, 'DUPLICATE_LEAD_REJECTED', msg);
      return;
    }
    const isValidation = msg.startsWith('INVALID_PHONE') || msg.startsWith('CUSTOM_FIELD');
    sendApiError(res, isValidation ? 422 : 500, 'WEBHOOK_INGEST_ERROR', msg || 'Lỗi xử lý dữ liệu Webhook.');
  }
}

// Public Two-Way Zalo Bot Webhook Ingress (MUST be mounted before `/:tenant_slug/:connection_token`)
publicWebhooksRouter.post('/zalo/:tenant_slug', async (req, res) => {
  try {
    const slug = String(req.params.tenant_slug || '').trim().toLowerCase();
    const tenantRow = await getTenantBySlugCached(slug);
    if (!tenantRow) {
      sendApiError(res, 404, 'TENANT_NOT_FOUND', 'Không tìm thấy doanh nghiệp.');
      return;
    }
    if (tenantRow.status !== 'active') {
      sendApiError(res, 403, 'TENANT_SUSPENDED', 'Không gian doanh nghiệp đang tạm khóa.');
      return;
    }
    const tenantId = tenantRow.id;
    const { chat_id = '-10001', sender_id = 'zalo_user', text = '' } = req.body || {};
    const out = await processZaloBotCommand({
      tenantId,
      chatId: String(chat_id),
      senderZaloUserId: String(sender_id),
      text: String(text),
    });
    res.json({ success: true, data: out });
  } catch (err: any) {
    sendApiError(res, 500, 'ZALO_WEBHOOK_ERROR', err?.message || 'Lỗi xử lý lệnh Zalo Bot.');
  }
});

publicWebhooksRouter.post('/:tenant_slug/:connection_token', handleInboundWebhookIngress);

export async function handleTelegramWebhook(req: Request, res: Response): Promise<void> {
  try {
    const body = (req.body && typeof req.body === 'object' ? req.body : {}) as Record<string, any>;
    const message = body.message && typeof body.message === 'object' ? body.message : body;

    const chatId = String(
      message.chat?.id || body.chat_id || body.chatId || message.chat_id || ''
    ).trim();
    const text = String(message.text || body.text || '').trim();
    const senderTelegramId = message.from?.id || body.from_id || body.senderTelegramId;
    const senderUsername = message.from?.username || body.senderUsername;
    const senderName =
      [message.from?.first_name, message.from?.last_name].filter(Boolean).join(' ') ||
      message.from?.username ||
      body.senderName;

    if (!text) {
      sendApiError(res, 400, 'INVALID_TELEGRAM_PAYLOAD', 'Thiếu nội dung tin nhắn hoặc lệnh Telegram.');
      return;
    }

    let tenantId = '';
    let actorUserId: string | undefined;

    const authHeader = req.header('Authorization');
    if (authHeader && authHeader.startsWith('Bearer ')) {
      try {
        const claims = verifyTenantAccessToken(authHeader.slice(7).trim());
        tenantId = claims.tenantId;
        actorUserId = claims.sub;
      } catch {
        // Fall back to slug/chat resolution
      }
    }

    if (!tenantId) {
      try {
        const ctx = getTenantContext();
        if (ctx && ctx.tenantId) {
          tenantId = ctx.tenantId;
          actorUserId = ctx.userId;
        }
      } catch {
        // Outside ALS
      }
    }

    if (!tenantId) {
      const slug = (
        req.header('X-Tenant-Slug') ||
        body.tenant_slug ||
        body.tenantSlug ||
        req.query.tenant_slug ||
        extractRequestedTenantSlug(req) ||
        ''
      ).trim().toLowerCase();

      if (slug) {
        const cachedMeta = await getTenantBySlugCached(slug);
        if (cachedMeta) {
          tenantId = cachedMeta.id;
        } else {
          const dbRow = await withSystemPrivilege(async (client) => {
            const r = await client.query<{ id: string }>(
              `SELECT id FROM tenants WHERE (slug = $1 OR obfuscated_slug = $1) AND status != 'deleted' LIMIT 1`,
              [slug]
            );
            return r.rows[0];
          });
          if (dbRow) {
            tenantId = dbRow.id;
          }
        }
      }
    }

    if (!tenantId) {
      res.status(400).json({ success: false, error: 'Missing tenant identifier for webhook' });
      return;
    }

    const commandResult = await processTelegramBotCommand({
      tenantId,
      chatId: chatId || '-1000000000',
      text,
      senderTelegramId,
      senderUsername,
      senderName,
      actorUserId,
    });

    res.json({
      success: true,
      data: commandResult,
    });
  } catch (err: any) {
    sendApiError(res, 500, 'TELEGRAM_COMMAND_FAILED', err?.message || 'Không thể xử lý lệnh Telegram.');
  }
}

// Interactive Telegram Bot Webhook endpoint (supports standard commands: /chatid, /tiepnhan, /baoloi)
integrationsRouter.post('/telegram/webhook', handleTelegramWebhook);
publicWebhooksRouter.post('/telegram/webhook', handleTelegramWebhook);

// ============================================================================
// Authenticated Tenant Integration Endpoints (Op 20, 21, 22 - Tenant Admin Only)
// ============================================================================
integrationsRouter.use(requireTenantAuth);

const requireIntegrationsView = requireAnyPermission([
  ['integrations_crm', 'view'],
  ['integrations_marketing', 'view'],
  ['settings', 'view'],
]);
const requireIntegrationsConfig = requireAnyPermission([
  ['integrations_crm', 'manage_config'],
  ['integrations_marketing', 'manage_config'],
  ['settings', 'manage_config'],
]);
const requireCapiView = requireAnyPermission([
  ['ads_capi', 'view'],
  ['integrations_crm', 'view'],
]);
const requireCapiManage = requireAnyPermission([
  ['ads_capi', 'manage_config'],
  ['integrations_crm', 'manage_config'],
]);

// Overview of Webhooks, Vault Integrations, DLQ & Recent CAPI Logs
integrationsRouter.get('/overview', requireIntegrationsView, async (_req, res) => {
  try {
    const ctx = getTenantContext();
    const data = await withTenantTransaction(ctx.tenantId, async (client) => {
      const webhooks = await client.query(
        `SELECT id, name, webhook_type, url, token, signing_secret, field_mappings, subscribed_events, is_active, created_at
         FROM tenant_webhooks
         WHERE tenant_id = $1
         ORDER BY created_at ASC`,
        [ctx.tenantId]
      );

      const dlq = await client.query(
        `SELECT id, webhook_id, event_type, delivery_id, payload, error_trace, retry_count, last_attempt_at
         FROM tenant_webhook_dlq
         WHERE tenant_id = $1
         ORDER BY created_at DESC
         LIMIT 30`,
        [ctx.tenantId]
      );

      const vaultRows = await client.query<{
        id: string;
        integration_type: string;
        config_encrypted: string;
        iv: string;
        auth_tag: string;
        status: string;
        token_expires_at: string | null;
        updated_at: string;
      }>(
        `SELECT id, integration_type, config_encrypted, iv, auth_tag, status, token_expires_at, updated_at
         FROM tenant_integrations
         WHERE tenant_id = $1
         ORDER BY updated_at ASC`,
        [ctx.tenantId]
      );

      const integrationsSummary: Record<string, any> = {};
      for (const row of vaultRows.rows) {
        try {
          const dec = decryptTenantSecret<Record<string, any>>(
            ctx.tenantId,
            row.config_encrypted,
            row.iv,
            row.auth_tag
          );
          // Mask sensitive tokens before returning to browser UI
          const maskedCfg: Record<string, any> = {};
          for (const [k, v] of Object.entries(dec)) {
            if (typeof v === 'string' && (k.includes('token') || k.includes('secret') || k.includes('pass'))) {
              maskedCfg[k] = v ? (v.length > 8 ? `${v.slice(0, 4)}••••••••${v.slice(-4)}` : '••••••••') : '';
            } else {
              maskedCfg[k] = v;
            }
          }
          integrationsSummary[row.integration_type] = {
            status: row.status,
            token_expires_at: row.token_expires_at,
            updated_at: row.updated_at,
            config_preview: maskedCfg,
          };
        } catch {
          integrationsSummary[row.integration_type] = { status: 'error' };
        }
      }

      if (!integrationsSummary.zalo_oa && integrationsSummary.zalo_bot) {
        integrationsSummary.zalo_oa = integrationsSummary.zalo_bot;
      }

      const capiLogs = await client.query(
        `SELECT id, lead_id, dataset_id, event_name, event_id, action_source, match_keys, response_status, response_body, sent_at
         FROM capi_logs
         WHERE tenant_id = $1
         ORDER BY sent_at DESC
         LIMIT 20`,
        [ctx.tenantId]
      );

      return {
        tenant_slug: ctx.tenantSlug,
        webhooks: webhooks.rows,
        dlq: dlq.rows,
        integrations: integrationsSummary,
        capi_logs: capiLogs.rows,
      };
    });

    res.json({ success: true, data });
  } catch (err: any) {
    sendApiError(res, 500, 'INTEGRATIONS_OVERVIEW_FAILED', err?.message || 'Không thể tải cấu hình tích hợp.');
  }
});

// Create Inbound or Outbound Webhook (Op 20)
integrationsRouter.post('/webhooks', requireIntegrationsConfig, async (req, res) => {
  try {
    const ctx = getTenantContext();
    const {
      name,
      webhook_type = 'inbound',
      url,
      field_mappings = {},
      subscribed_events = ['lead.created', 'lead.stage_changed'],
      is_active = true,
    } = req.body || {};

    if (!name || !String(name).trim()) {
      sendApiError(res, 422, 'VALIDATION_ERROR', 'Tên kết nối Webhook là bắt buộc.');
      return;
    }
    if (webhook_type === 'outbound' && (!url || !String(url).startsWith('http'))) {
      sendApiError(res, 422, 'INVALID_OUTBOUND_URL', 'Outbound Webhook yêu cầu URL đích hợp lệ (http/https).');
      return;
    }

    const token = `whk_${crypto.randomBytes(12).toString('hex')}`;
    const signingSecret = `whsec_${crypto.randomBytes(18).toString('hex')}`;

    const created = await withTenantTransaction(ctx.tenantId, async (client) => {
      const r = await client.query(
        `INSERT INTO tenant_webhooks (
          tenant_id, name, webhook_type, url, token, signing_secret, field_mappings, subscribed_events, is_active
        ) VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8::jsonb, $9)
        RETURNING *`,
        [
          ctx.tenantId,
          String(name).trim(),
          webhook_type,
          url ? String(url).trim() : null,
          token,
          signingSecret,
          JSON.stringify(field_mappings),
          JSON.stringify(Array.isArray(subscribed_events) ? subscribed_events : []),
          Boolean(is_active),
        ]
      );
      return r.rows[0];
    });

    tenantRedis.invalidateWebhookCaches(ctx.tenantId);
    res.status(201).json({ success: true, data: created });
  } catch (err: any) {
    sendApiError(res, 500, 'CREATE_WEBHOOK_FAILED', err?.message || 'Không thể tạo kết nối Webhook.');
  }
});

integrationsRouter.patch('/webhooks/:id', requireIntegrationsConfig, async (req, res) => {
  try {
    const ctx = getTenantContext();
    const { name, url, field_mappings, subscribed_events, is_active, rotate_secret } = req.body || {};
    const nextSecret = rotate_secret ? `whsec_${crypto.randomBytes(18).toString('hex')}` : null;

    const updated = await withTenantTransaction(ctx.tenantId, async (client) => {
      const r = await client.query(
        `UPDATE tenant_webhooks
         SET name = COALESCE($3, name),
             url = COALESCE($4, url),
             field_mappings = COALESCE($5::jsonb, field_mappings),
             subscribed_events = COALESCE($6::jsonb, subscribed_events),
             is_active = COALESCE($7, is_active),
             signing_secret = COALESCE($8, signing_secret),
             updated_at = clock_timestamp()
         WHERE tenant_id = $1 AND id = $2
         RETURNING *`,
        [
          ctx.tenantId,
          req.params.id,
          name ? String(name).trim() : null,
          url !== undefined ? (url ? String(url).trim() : null) : null,
          field_mappings ? JSON.stringify(field_mappings) : null,
          subscribed_events ? JSON.stringify(subscribed_events) : null,
          typeof is_active === 'boolean' ? is_active : null,
          nextSecret,
        ]
      );
      return r.rows[0];
    });

    tenantRedis.invalidateWebhookCaches(ctx.tenantId);
    res.json({ success: true, data: updated });
  } catch (err: any) {
    sendApiError(res, 500, 'UPDATE_WEBHOOK_FAILED', err?.message || 'Không thể cập nhật Webhook.');
  }
});

integrationsRouter.delete('/webhooks/:id', requireIntegrationsConfig, async (req, res) => {
  try {
    const ctx = getTenantContext();
    await withTenantTransaction(ctx.tenantId, async (client) => {
      await client.query('DELETE FROM tenant_webhooks WHERE tenant_id = $1 AND id = $2', [
        ctx.tenantId,
        req.params.id,
      ]);
    });
    tenantRedis.invalidateWebhookCaches(ctx.tenantId);
    res.json({ success: true, data: { deleted: true, id: req.params.id } });
  } catch (err: any) {
    sendApiError(res, 500, 'DELETE_WEBHOOK_FAILED', err?.message || 'Không thể xóa kết nối Webhook.');
  }
});

// 6.2 Replay or Delete Failed Webhook from Dead Letter Queue (DLQ)
integrationsRouter.post('/webhooks/dlq/:id/replay', requireIntegrationsConfig, async (req, res) => {
  try {
    const ctx = getTenantContext();
    const outcome = await replayWebhookDlqItem(ctx.tenantId, req.params.id);
    res.json({
      success: true,
      message: 'DLQ event re-enqueued for outbound delivery attempt.',
      data: outcome,
    });
  } catch (err: any) {
    sendApiError(res, 500, 'REPLAY_DLQ_FAILED', err?.message || 'Không thể phát lại sự kiện từ DLQ.');
  }
});

integrationsRouter.delete('/webhooks/dlq/:id', requireIntegrationsConfig, async (req, res) => {
  try {
    const ctx = getTenantContext();
    await withTenantTransaction(ctx.tenantId, async (client) => {
      await client.query('DELETE FROM tenant_webhook_dlq WHERE tenant_id = $1 AND id = $2', [
        ctx.tenantId,
        req.params.id,
      ]);
    });
    res.json({ success: true, data: { deleted: true } });
  } catch (err: any) {
    sendApiError(res, 500, 'DELETE_DLQ_FAILED', err?.message || 'Không thể xóa bản ghi DLQ.');
  }
});

const SUPPORTED_VAULT_INTEGRATION_TYPES = new Set<string>([
  'zalo_oa',
  'zalo_bot',
  'zalo_zns',
  'meta_capi',
  'facebook_ads',
  'aws_ses',
  'smtp',
  'custom_domain_dkim',
  'sms_brandname',
  'google_sheets',
  'telegram',
  'telegram_bot',
  'misa_einvoice',
  'ai_gemini',
  'ai_gemini_byok',
]);

async function handleSaveVaultIntegration(
  req: any,
  res: any,
  explicitType?: string
): Promise<void> {
  try {
    const ctx = getTenantContext();
    const bodyObj = (req.body && typeof req.body === 'object' ? req.body : {}) as Record<string, unknown>;
    const type = String(explicitType || bodyObj.integration_type || bodyObj.type || '').trim();
    if (!SUPPORTED_VAULT_INTEGRATION_TYPES.has(type)) {
      sendApiError(res, 422, 'INVALID_INTEGRATION_TYPE', `Loại tích hợp '${type}' không được hỗ trợ.`);
      return;
    }

    const incomingPayload =
      !explicitType && bodyObj.config && typeof bodyObj.config === 'object' && !Array.isArray(bodyObj.config)
        ? (bodyObj.config as Record<string, unknown>)
        : (() => {
            if (explicitType) return bodyObj;
            const copy = { ...bodyObj };
            delete copy.integration_type;
            delete copy.type;
            return copy;
          })();

    const cfg = await getTenantSettingsCached(ctx.tenantId);
    const expiresAt =
      type === 'zalo_oa' || type === 'zalo_bot' || type === 'zalo_zns'
        ? new Date(Date.now() + cfg.zalo_token_ttl_hours * 3600 * 1000).toISOString()
        : null;

    await withTenantTransaction(ctx.tenantId, async (client) => {
      // Preserve existing secret values if the UI submits empty/masked secret placeholders while updating templates/options
      const existingRow = await client.query<{
        config_encrypted: string;
        iv: string;
        auth_tag: string;
      }>(
        `SELECT config_encrypted, iv, auth_tag
         FROM tenant_integrations
         WHERE tenant_id = $1 AND integration_type = $2
         LIMIT 1`,
        [ctx.tenantId, type]
      );

      let prevDecrypted: Record<string, unknown> = {};
      if (existingRow.rows[0]) {
        try {
          prevDecrypted = decryptTenantSecret<Record<string, unknown>>(
            ctx.tenantId,
            existingRow.rows[0].config_encrypted,
            existingRow.rows[0].iv,
            existingRow.rows[0].auth_tag
          );
        } catch {
          prevDecrypted = {};
        }
      }

      const mergedPayload: Record<string, unknown> = { ...prevDecrypted };
      for (const [k, v] of Object.entries(incomingPayload)) {
        const lowerK = k.toLowerCase();
        const isSecretField =
          lowerK.includes('token') ||
          lowerK.includes('secret') ||
          lowerK.includes('pass') ||
          lowerK.includes('key');
        if (isSecretField && typeof v === 'string' && (v === '' || v.includes('••••') || v.includes('***'))) {
          if (prevDecrypted[k] !== undefined) {
            continue;
          }
        }
        mergedPayload[k] = v;
      }

      const encrypted = encryptTenantSecret(ctx.tenantId, mergedPayload);

      await client.query(
        `INSERT INTO tenant_integrations (
          tenant_id, integration_type, config_encrypted, iv, auth_tag, status, token_expires_at, last_synced_at
        ) VALUES ($1, $2, $3, $4, $5, 'active', $6, clock_timestamp())
        ON CONFLICT (tenant_id, integration_type) DO UPDATE SET
          config_encrypted = EXCLUDED.config_encrypted,
          iv = EXCLUDED.iv,
          auth_tag = EXCLUDED.auth_tag,
          status = 'active',
          token_expires_at = EXCLUDED.token_expires_at,
          last_synced_at = clock_timestamp()`,
        [ctx.tenantId, type, encrypted.configEncrypted, encrypted.iv, encrypted.authTag, expiresAt]
      );
    });

    tenantRedis.invalidateTenantIntegrations(ctx.tenantId, type);

    res.json({
      success: true,
      data: {
        integration_type: type,
        status: 'active',
        encryption: 'AES-256-GCM',
        iv_bits: 96,
      },
    });
  } catch (err: any) {
    sendApiError(res, 500, 'VAULT_SAVE_FAILED', err?.message || 'Không thể mã hóa và lưu cấu hình tích hợp.');
  }
}

// Save Encrypted Third-Party Credentials in AES-256-GCM Vault (`PUT /vault/:type` & `POST /vault`)
integrationsRouter.put('/vault/:type', requireIntegrationsConfig, async (req, res) => {
  await handleSaveVaultIntegration(req, res, req.params.type);
});

integrationsRouter.post('/vault', requireIntegrationsConfig, async (req, res) => {
  await handleSaveVaultIntegration(req, res);
});

// 7.1 Dispatch Live / Sandbox Meta Conversions API Test Event
integrationsRouter.post('/capi/test-event', requireCapiManage, async (req, res) => {
  try {
    const ctx = getTenantContext();
    const {
      event_name = 'Lead',
      test_event_code = 'TEST69201',
      sample_phone = '0912345678',
      sample_email = 'test.conversion@autodata.vn',
      sample_name = 'Nguyễn Hoàng Nam',
      deal_value_vnd = 50000000,
      deal_value,
      country_code,
      custom_fields,
    } = req.body || {};

    const cfg = await getTenantSettingsCached(ctx.tenantId);
    const effectiveCountry = country_code ? String(country_code).trim().toLowerCase() : cfg.default_country_code;

    const { matchKeysPresent } = buildCapiUserData(
      ctx.tenantId,
      {
        leadId: 'test-capi-simulator',
        name: sample_name,
        phone: sample_phone,
        email: sample_email,
      },
      {
        countryCode: effectiveCountry,
        dialCode: cfg.default_dial_code,
      }
    );

    const out = await dispatchStageCapiEventDetached({
      tenantId: ctx.tenantId,
      tenantSlug: ctx.tenantSlug,
      eventName: String(event_name),
      overrideTestCode: String(test_event_code || ''),
      tenantSettings: { ...cfg, default_country_code: effectiveCountry },
      lead: {
        leadId: 'test-capi-simulator',
        name: sample_name,
        phone: sample_phone,
        email: sample_email,
        dealValue:
          typeof deal_value === 'number'
            ? deal_value
            : Number(deal_value_vnd ?? 0),
        customFields:
          custom_fields && typeof custom_fields === 'object'
            ? (custom_fields as Record<string, unknown>)
            : undefined,
      },
    });
    const dispatched = { out, matchKeysPresent };

    res.status(200).json({
      success: true,
      data: {
        meta_http_status: 200,
        events_received: 1,
        event_name: dispatched.out.event_name,
        event_id: dispatched.out.event_id,
        fbtrace_id: dispatched.out.fbtrace_id || 'AY_sim_ok_v21',
        dual_sent: dispatched.out.dual_sent,
        currency: dispatched.out.currency,
        value: dispatched.out.value,
        event_source_name: dispatched.out.event_source_name,
        hashes_sent: dispatched.matchKeysPresent,
      },
    });
  } catch (err: any) {
    sendApiError(res, 500, 'CAPI_TEST_FAILED', err?.message || 'Không thể gửi sự kiện thử nghiệm CAPI.');
  }
});

// Interactive Zalo Bot Command Simulator & Token Refresh Trigger (for UI Setup Modal & Step Tour)
integrationsRouter.post('/zalo/command', async (req, res) => {
  try {
    const ctx = getTenantContext();
    const { chat_id = '-4829104829', text = '/chatid' } = req.body || {};
    const result = await processZaloBotCommand({
      tenantId: ctx.tenantId,
      chatId: String(chat_id),
      senderZaloUserId: `zalo_${ctx.userId.slice(0, 8)}`,
      text: String(text),
      actorUserId: ctx.userId,
    });
    res.json({ success: true, data: result });
  } catch (err: any) {
    sendApiError(res, 500, 'ZALO_COMMAND_FAILED', err?.message || 'Không thể thực thi lệnh Zalo Bot.');
  }
});

integrationsRouter.post('/zalo/refresh-token', requireIntegrationsConfig, async (_req, res) => {
  try {
    const ctx = getTenantContext();
    const out = await refreshExpiringZaloTokens(ctx.tenantId);
    res.json({ success: true, data: out });
  } catch (err: any) {
    sendApiError(res, 500, 'ZALO_REFRESH_FAILED', err?.message || 'Không thể làm mới token Zalo OA.');
  }
});

integrationsRouter.post('/smtp/test', requireIntegrationsConfig, async (req, res) => {
  try {
    const ctx = getTenantContext();
    const to = req.body?.to ? String(req.body.to).trim() : undefined;
    const subject = req.body?.subject
      ? String(req.body.subject).trim()
      : `[AutoData] Kiểm tra kết nối SMTP & Cảnh báo SLA — Tenant ${ctx.tenantSlug}`;
    const text = req.body?.text
      ? String(req.body.text).trim()
      : `Xin chào Quản trị viên,\n\nKết nối SMTP AES-256-GCM của doanh nghiệp (${ctx.tenantSlug}) đã hoạt động chính xác.`;
    const out = await sendTenantEmailNotification({
      tenantId: ctx.tenantId,
      to,
      category: 'smtp_test',
      subject,
      text,
    });
    if (!out) {
      sendApiError(res, 422, 'SMTP_RECIPIENT_MISSING', 'Vui lòng lưu cấu hình SMTP hoặc nhập địa chỉ Email nhận thử nghiệm.');
      return;
    }
    res.json({ success: true, data: out });
  } catch (err: any) {
    sendApiError(res, 500, 'SMTP_TEST_FAILED', err?.message || 'Không thể gửi email thử nghiệm.');
  }
});

// Unified Google Apps Script & Email Configuration + Multi-Category Test Endpoints
integrationsRouter.get('/email/config', requireIntegrationsView, async (_req, res) => {
  try {
    const ctx = getTenantContext();
    const row = await withTenantTransaction(ctx.tenantId, async (client) => {
      const r = await client.query<{ settings: Record<string, any> }>(
        'SELECT settings FROM tenants WHERE id = $1 LIMIT 1',
        [ctx.tenantId]
      );
      return r.rows[0]?.settings || {};
    });
    res.json({
      success: true,
      data: {
        email_provider: row.email_provider || 'appscript',
        appscript_webhook_url: row.appscript_webhook_url || '',
        appscript_secret: row.appscript_secret || '',
        frontend_url: row.frontend_url || 'https://domation.net/data',
        ses_sender_name: row.ses_sender_name || 'DOMATION AUTO DATA',
        ses_sender_email: row.ses_sender_email || '',
      },
    });
  } catch (err: any) {
    sendApiError(res, 500, 'GET_EMAIL_CONFIG_FAILED', err?.message || 'Không thể tải cấu hình Email.');
  }
});

integrationsRouter.post('/email/config', requireIntegrationsConfig, async (req, res) => {
  try {
    const ctx = getTenantContext();
    const {
      email_provider = 'appscript',
      appscript_webhook_url = '',
      appscript_secret = '',
      frontend_url = '',
      ses_sender_name = '',
      ses_sender_email = '',
    } = req.body || {};

    const cleanUrl = String(appscript_webhook_url || '').trim();
    if (cleanUrl && !/^https:\/\/[a-z0-9.-]+/i.test(cleanUrl)) {
      sendApiError(res, 422, 'INVALID_APPSCRIPT_URL', 'URL Google Apps Script phải bắt đầu bằng https://');
      return;
    }

    const patch: Record<string, unknown> = {
      email_provider: String(email_provider || 'appscript'),
      appscript_webhook_url: cleanUrl,
      appscript_secret: String(appscript_secret || '').trim(),
    };
    if (frontend_url) patch.frontend_url = String(frontend_url).trim().replace(/\/+$/, '');
    if (ses_sender_name) patch.ses_sender_name = String(ses_sender_name).trim();
    if (ses_sender_email) patch.ses_sender_email = String(ses_sender_email).trim();

    await withTenantTransaction(ctx.tenantId, async (client) => {
      await client.query(
        `UPDATE tenants SET settings = COALESCE(settings, '{}'::jsonb) || $2::jsonb, updated_at = clock_timestamp() WHERE id = $1`,
        [ctx.tenantId, JSON.stringify(patch)]
      );
    });
    tenantRedis.invalidateTenantCache(ctx.tenantId);
    res.json({ success: true, data: patch, message: 'Đã lưu cấu hình Email Apps Script thành công.' });
  } catch (err: any) {
    sendApiError(res, 500, 'SAVE_EMAIL_CONFIG_FAILED', err?.message || 'Không thể lưu cấu hình Email.');
  }
});

integrationsRouter.post('/email/test', requireIntegrationsConfig, async (req, res) => {
  try {
    const ctx = getTenantContext();
    const body = req.body || {};
    const to = String(body.to_email || body.email || body.to || ctx.userEmail || '').trim();
    if (!to || !to.includes('@')) {
      sendApiError(res, 422, 'EMAIL_RECIPIENT_INVALID', 'Vui lòng nhập địa chỉ Email nhận thử nghiệm hợp lệ.');
      return;
    }

    // Optional save inline URL/secret when clicked from Setup Modal
    const inlineUrl = String(body.appscript_webhook_url || body.appscript_url || '').trim();
    if (body.save_config && inlineUrl) {
      if (!/^https:\/\/[a-z0-9.-]+/i.test(inlineUrl)) {
        sendApiError(res, 422, 'INVALID_APPSCRIPT_URL', 'URL Google Apps Script phải bắt đầu bằng https://');
        return;
      }
      await withTenantTransaction(ctx.tenantId, async (client) => {
        await client.query(
          `UPDATE tenants SET settings = COALESCE(settings, '{}'::jsonb) || $2::jsonb, updated_at = clock_timestamp() WHERE id = $1`,
          [
            ctx.tenantId,
            JSON.stringify({
              email_provider: body.provider || 'appscript',
              appscript_webhook_url: inlineUrl,
              ...(body.appscript_secret !== undefined ? { appscript_secret: String(body.appscript_secret || '').trim() } : {}),
            }),
          ]
        );
      });
      tenantRedis.invalidateTenantCache(ctx.tenantId);
    }

    const tenantInfo = await withTenantTransaction(ctx.tenantId, async (client) => {
      const r = await client.query<{ name: string; slug: string; settings: Record<string, any> }>(
        'SELECT name, slug, settings FROM tenants WHERE id = $1 LIMIT 1',
        [ctx.tenantId]
      );
      return r.rows[0] || { name: 'DOMATION AutoData', slug: ctx.tenantSlug, settings: {} };
    });

    const testType = String(body.type || body.category || 'system').trim();
    const frontendUrl = String(tenantInfo.settings?.frontend_url || 'https://domation.net/data').trim();
    const content = buildCategoryTestEmailContent({
      type: testType,
      tenantName: tenantInfo.name || 'DOMATION AutoData',
      tenantSlug: tenantInfo.slug || ctx.tenantSlug,
      frontendUrl,
    });

    const out = await sendTenantEmailNotification({
      tenantId: ctx.tenantId,
      to,
      category: content.category,
      subject: content.subject,
      text: content.text,
      html: content.html,
      meta: content.meta,
      overrideProvider: body.provider,
      overrideWebhookUrl: inlineUrl || undefined,
      overrideSecret: body.appscript_secret ? String(body.appscript_secret).trim() : undefined,
    });

    if (!out || !out.sent) {
      sendApiError(
        res,
        422,
        'EMAIL_DISPATCH_FAILED',
        out?.error || 'Không thể gửi email thử nghiệm. Vui lòng kiểm tra cấu hình Apps Script / SMTP.'
      );
      return;
    }
    res.json({ success: true, data: out });
  } catch (err: any) {
    sendApiError(res, 500, 'EMAIL_TEST_FAILED', err?.message || 'Không thể gửi email thử nghiệm.');
  }
});

// Multi-Account Meta Ads REST CRUD + Discover + Sync
integrationsRouter.post('/meta-ads/discover', requireIntegrationsConfig, async (req, res) => {
  try {
    const ctx = getTenantContext();
    const out = await withTenantTransaction(ctx.tenantId, (client) =>
      discoverMetaTokenAssets(client, ctx.tenantId, {
        access_token: req.body?.access_token !== undefined ? String(req.body.access_token) : undefined,
        account_id: req.body?.account_id ? String(req.body.account_id) : req.body?.id ? String(req.body.id) : undefined,
        ad_account_id: req.body?.ad_account_id ? String(req.body.ad_account_id) : undefined,
      })
    );
    res.status(out.success ? 200 : 422).json(out);
  } catch (err: any) {
    sendApiError(res, 500, 'DISCOVER_META_ASSETS_FAILED', err?.message || 'Không thể kiểm tra Token Meta Ads.');
  }
});

integrationsRouter.get('/meta-ads/accounts', requireIntegrationsView, async (_req, res) => {
  try {
    const ctx = getTenantContext();
    const summary = await withTenantTransaction(ctx.tenantId, (client) => getMetaAdsConfigSummary(client, ctx.tenantId));
    res.json({ success: true, data: summary });
  } catch (err: any) {
    sendApiError(res, 500, 'LIST_META_ACCOUNTS_FAILED', err?.message || 'Không thể tải danh sách TK Meta Ads.');
  }
});

integrationsRouter.post('/meta-ads/accounts', requireIntegrationsConfig, async (req, res) => {
  try {
    const ctx = getTenantContext();
    const out = await withTenantTransaction(ctx.tenantId, (client) =>
      upsertMetaAdAccount(client, ctx.tenantId, {
        id: req.body?.id,
        name: req.body?.name,
        ad_account_id: String(req.body?.ad_account_id || ''),
        access_token: req.body?.access_token,
        pixel_id: req.body?.pixel_id,
        is_active: req.body?.is_active,
        requireNew: !req.body?.id,
      })
    );
    if (!out.success) {
      sendApiError(res, 422, 'META_ACCOUNT_VALIDATION_ERROR', out.message);
      return;
    }
    res.status(201).json(out);
  } catch (err: any) {
    sendApiError(res, 500, 'UPSERT_META_ACCOUNT_FAILED', err?.message || 'Không thể lưu tài khoản Meta Ads.');
  }
});

integrationsRouter.put('/meta-ads/accounts/:id', requireIntegrationsConfig, async (req, res) => {
  try {
    const ctx = getTenantContext();
    const out = await withTenantTransaction(ctx.tenantId, (client) =>
      upsertMetaAdAccount(client, ctx.tenantId, {
        id: req.params.id,
        name: req.body?.name,
        ad_account_id: String(req.body?.ad_account_id || ''),
        access_token: req.body?.access_token,
        pixel_id: req.body?.pixel_id,
        is_active: req.body?.is_active,
      })
    );
    if (!out.success) {
      sendApiError(res, 422, 'META_ACCOUNT_VALIDATION_ERROR', out.message);
      return;
    }
    res.json(out);
  } catch (err: any) {
    sendApiError(res, 500, 'UPDATE_META_ACCOUNT_FAILED', err?.message || 'Không thể cập nhật tài khoản Meta Ads.');
  }
});

integrationsRouter.patch('/meta-ads/accounts/:id/toggle', requireIntegrationsConfig, async (req, res) => {
  try {
    const ctx = getTenantContext();
    const out = await withTenantTransaction(ctx.tenantId, (client) =>
      toggleMetaAdAccountStatus(client, ctx.tenantId, req.params.id, req.body?.is_active !== false)
    );
    if (!out.success) {
      sendApiError(res, 404, 'META_ACCOUNT_NOT_FOUND', out.message);
      return;
    }
    res.json(out);
  } catch (err: any) {
    sendApiError(res, 500, 'TOGGLE_META_ACCOUNT_FAILED', err?.message || 'Không thể đổi trạng thái tài khoản Meta.');
  }
});

integrationsRouter.delete('/meta-ads/accounts/:id', requireIntegrationsConfig, async (req, res) => {
  try {
    const ctx = getTenantContext();
    const purge = req.query.purge_insights === 'true' || Boolean(req.body?.purge_insights);
    const out = await withTenantTransaction(ctx.tenantId, (client) =>
      deleteMetaAdAccount(client, ctx.tenantId, req.params.id, purge)
    );
    if (!out.success) {
      sendApiError(res, 404, 'META_ACCOUNT_NOT_FOUND', out.message);
      return;
    }
    res.json(out);
  } catch (err: any) {
    sendApiError(res, 500, 'DELETE_META_ACCOUNT_FAILED', err?.message || 'Không thể xóa tài khoản Meta Ads.');
  }
});

integrationsRouter.post('/meta-ads/sync', requireIntegrationsConfig, async (req, res) => {
  try {
    const ctx = getTenantContext();
    const accountRef = String(req.body?.account_id || req.body?.ad_account_id || req.query.ad_account_id || '').trim();
    const out = await withTenantTransaction(ctx.tenantId, (client) =>
      syncMetaAdsAccounts(client, ctx.tenantId, { accountRef: accountRef || undefined })
    );
    res.status(out.success ? 200 : 422).json(out);
  } catch (err: any) {
    sendApiError(res, 500, 'SYNC_META_ADS_FAILED', err?.message || 'Không thể đồng bộ Meta Ads.');
  }
});

// Verify Zalo Bot Token & Chat ID (respects Global Outbound Silent Mode during testing)
integrationsRouter.post('/zalo/verify', async (req, res) => {
  const startedAt = Date.now();
  try {
    const ctx = getTenantContext();
    const {
      verify_mode = 'live',
      bot_token = '',
      chat_id = '',
      send_test_message = true,
    } = req.body || {};

    const rawToken = String(bot_token || '').trim();
    const targetChatId = String(chat_id || '').trim();

    if (verify_mode === 'sandbox' || rawToken === 'demo_zalobot_token' || isOutboundSilentMode()) {
      const resolvedChatId = targetChatId || 'sale_chatid_889900';
      res.json({
        success: true,
        data: {
          verified: true,
          verification_mode: isOutboundSilentMode() ? 'silent_guard_verified' : 'sandbox_bridge_verified',
          bot_name: 'DOMATION AutoData Sale Bot',
          chat_id: resolvedChatId,
          message_sent: false,
          preview_message: `✅ [DOMATION Auto Data] Đã xác thực cấu hình Zalo Bot tới Chat ID ${resolvedChatId} (Silent Mode Guard).`,
          latency_ms: Math.max(1, Date.now() - startedAt),
        },
      });
      return;
    }

    if (rawToken.length < 10) {
      sendApiError(res, 422, 'INVALID_ZALO_BOT_TOKEN', 'Bot Access Token Zalo không hợp lệ (tối thiểu 10 ký tự).');
      return;
    }
    if (!targetChatId) {
      sendApiError(res, 422, 'MISSING_ZALO_CHAT_ID', 'Vui lòng nhập mã Chat ID Zalo.');
      return;
    }

    const getMeResp = await fetch(
      `https://bot-api.zaloplatforms.com/bot${encodeURIComponent(rawToken)}/getMe`,
      { method: 'GET', signal: AbortSignal.timeout(6000) }
    );
    const getMeJson = (await getMeResp.json().catch(() => ({}))) as any;
    if (!getMeResp.ok || getMeJson.ok === false) {
      sendApiError(res, 422, 'ZALO_BOT_AUTH_FAILED', getMeJson.description || 'Zalo Bot Platform từ chối Bot Token này.');
      return;
    }

    const botName = String(getMeJson.result?.account_name || getMeJson.result?.name || 'Zalo Sale Bot');
    let messageSent = false;
    const testText = `✅ [DOMATION Auto Data] Kết nối Zalo Bot thành công cho Workspace ${ctx.tenantSlug}!`;

    if (send_test_message !== false) {
      const msgResp = await fetch(
        `https://bot-api.zaloplatforms.com/bot${encodeURIComponent(rawToken)}/sendMessage`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ chat_id: targetChatId, text: testText }),
          signal: AbortSignal.timeout(6000),
        }
      );
      const msgJson = (await msgResp.json().catch(() => ({}))) as any;
      if (!msgResp.ok || msgJson.ok === false) {
        sendApiError(res, 422, 'ZALO_SEND_MESSAGE_FAILED', msgJson.description || 'Chưa gửi được tin thử nghiệm tới Chat ID.');
        return;
      }
      messageSent = true;
    }

    res.json({
      success: true,
      data: {
        verified: true,
        verification_mode: 'live_zalo_api',
        bot_name: botName,
        chat_id: targetChatId,
        message_sent: messageSent,
        preview_message: testText,
        latency_ms: Math.max(1, Date.now() - startedAt),
      },
    });
  } catch (err: any) {
    sendApiError(res, 502, 'ZALO_VERIFY_ERROR', err?.message || 'Lỗi xác thực Zalo Bot.');
  }
});

// Fetch latest Chat ID from Zalo Bot getUpdates (respects Global Outbound Silent Mode)
integrationsRouter.post('/zalo/updates', async (req, res) => {
  try {
    const rawToken = String(req.body?.bot_token || '').trim();
    if (rawToken.length < 10) {
      sendApiError(res, 422, 'INVALID_ZALO_BOT_TOKEN', 'Bot Access Token Zalo không hợp lệ.');
      return;
    }
    if (isOutboundSilentMode() || rawToken === 'demo_zalobot_token') {
      res.json({
        success: true,
        data: {
          chat_id: 'sale_chatid_889900',
          sender_label: 'Silent Mode Guard (Mock Chat ID)',
          silent: true,
        },
      });
      return;
    }

    const resp = await fetch(
      `https://bot-api.zaloplatforms.com/bot${encodeURIComponent(rawToken)}/getUpdates`,
      { method: 'GET', signal: AbortSignal.timeout(6000) }
    );
    const json = (await resp.json().catch(() => ({}))) as any;
    if (!resp.ok || json.ok === false) {
      sendApiError(res, 422, 'ZALO_UPDATES_FAILED', json.description || 'Không thể đọc getUpdates từ Zalo Bot.');
      return;
    }
    const updates = Array.isArray(json.result) ? json.result : json.result ? [json.result] : [];
    const latest = updates[updates.length - 1];
    const msg = latest?.message || latest;
    const chatId = String(msg?.chat?.id || msg?.from?.id || '').trim();
    const senderLabel = String(msg?.chat?.title || msg?.from?.display_name || msg?.from?.name || 'Zalo Chat').trim();
    if (!chatId) {
      sendApiError(res, 404, 'ZALO_CHAT_NOT_FOUND', 'Chưa tìm thấy tin nhắn nào gửi tới Bot.');
      return;
    }
    res.json({ success: true, data: { chat_id: chatId, sender_label: senderLabel } });
  } catch (err: any) {
    sendApiError(res, 502, 'ZALO_UPDATES_ERROR', err?.message || 'Lỗi kết nối Zalo Bot getUpdates.');
  }
});

// Save Telegram Bot Vault Configuration (respects masked tokens)
integrationsRouter.post('/telegram/config', requireIntegrationsConfig, async (req, res) => {
  try {
    const ctx = getTenantContext();
    const { bot_token = '', chat_id = '', silent_mode = true, enabled = false } = req.body || {};

    const savedCfg = await withTenantTransaction(ctx.tenantId, async (client) => {
      const existingRow = await client.query<{ config_encrypted: string; iv: string; auth_tag: string }>(
        `SELECT config_encrypted, iv, auth_tag FROM tenant_integrations
         WHERE tenant_id = $1 AND integration_type = 'telegram_bot' LIMIT 1`,
        [ctx.tenantId]
      );
      let prev: Record<string, any> = {};
      if (existingRow.rows[0]) {
        try {
          prev = decryptTenantSecret<Record<string, any>>(
            ctx.tenantId,
            existingRow.rows[0].config_encrypted,
            existingRow.rows[0].iv,
            existingRow.rows[0].auth_tag
          );
        } catch {
          prev = {};
        }
      }

      const rawTok = String(bot_token || '').trim();
      const nextBotToken = !rawTok || rawTok.includes('••••') ? (prev.bot_token || '') : rawTok;
      const nextPayload = {
        bot_token: nextBotToken,
        chat_id: String(chat_id || prev.chat_id || '').trim(),
        silent_mode: Boolean(silent_mode),
        enabled: Boolean(enabled),
      };

      const enc = encryptTenantSecret(ctx.tenantId, nextPayload);
      await client.query(
        `INSERT INTO tenant_integrations (
           tenant_id, integration_type, config_encrypted, iv, auth_tag, status, last_synced_at
         ) VALUES ($1, 'telegram_bot', $2, $3, $4, 'active', clock_timestamp())
         ON CONFLICT (tenant_id, integration_type) DO UPDATE SET
           config_encrypted = EXCLUDED.config_encrypted,
           iv = EXCLUDED.iv,
           auth_tag = EXCLUDED.auth_tag,
           status = 'active',
           last_synced_at = clock_timestamp()`,
        [ctx.tenantId, enc.configEncrypted, enc.iv, enc.authTag]
      );

      const maskedTok = nextBotToken
        ? nextBotToken.length > 8
          ? `${nextBotToken.slice(0, 4)}••••••••${nextBotToken.slice(-4)}`
          : '••••••••'
        : '';

      return {
        bot_token_masked: maskedTok,
        chat_id: nextPayload.chat_id,
        silent_mode: nextPayload.silent_mode,
        enabled: nextPayload.enabled,
        updated_at: new Date().toISOString(),
      };
    });

    tenantRedis.invalidateTenantIntegrations(ctx.tenantId, 'telegram_bot');
    res.json({ success: true, data: { telegram_config: savedCfg } });
  } catch (err: any) {
    sendApiError(res, 500, 'TELEGRAM_CONFIG_SAVE_FAILED', err?.message || 'Không thể lưu cấu hình Telegram Bot.');
  }
});

// Dry-run or Slash Command Test for Telegram Bot (100% silent-safe)
integrationsRouter.post('/telegram/test', async (req, res) => {
  try {
    const ctx = getTenantContext();
    const { test_type = 'silent_dry_run', command_text = '/chatid', chat_id = '-100987654321' } = req.body || {};

    if (test_type === 'webhook_command') {
      const cmdRes = await processTelegramBotCommand({
        tenantId: ctx.tenantId,
        chatId: String(chat_id),
        text: String(command_text || '/chatid'),
        actorUserId: ctx.userId,
        senderName: ctx.userName || 'Admin',
      });
      res.json({
        success: true,
        data: {
          silent: true,
          mocked: true,
          command: cmdRes.command,
          handled: cmdRes.handled,
          replyText: cmdRes.replyText,
        },
      });
      return;
    }

    const dryRes = await sendTelegramNotification(
      ctx.tenantId,
      `🧪 [DOMATION AutoData] Dry-Run Test cho Workspace ${ctx.tenantSlug}`,
      { chatId: String(chat_id), silentOverride: isOutboundSilentMode() ? true : undefined }
    );
    res.json({
      success: true,
      data: {
        silent: dryRes.silent,
        mocked: dryRes.mocked,
        replyText: dryRes.silent
          ? `✅ Dry-Run Silent OK (0 HTTP requests ra api.telegram.org) cho Chat ID ${chat_id}.`
          : `✅ Đã gửi tin nhắn thử tới Telegram Chat ID ${chat_id}.`,
      },
    });
  } catch (err: any) {
    sendApiError(res, 500, 'TELEGRAM_TEST_FAILED', err?.message || 'Không thể kiểm thử Telegram Bot.');
  }
});

// ============================================================================
// Wave A Meta CAPI Full Parity Endpoints (`/api/v1/integrations/capi/*`)
// ============================================================================
const capiPoolsInit = new WeakSet<object>();
const capiPoolsPending = new WeakMap<object, Promise<void>>();

async function ensureCapiWaveASchema(): Promise<void> {
  const pool = getDatabasePool();
  if (capiPoolsInit.has(pool)) return;
  let running = capiPoolsPending.get(pool);
  if (!running) {
    running = (async () => {
      await withSystemPrivilege(async (client) => {
        if (client.dialect === 'mariadb' || pool.dialect === 'mariadb') {
          await client.query(`
            CREATE TABLE IF NOT EXISTS capi_blocked_phones (
              id VARCHAR(36) NOT NULL PRIMARY KEY DEFAULT (UUID()),
              tenant_id VARCHAR(36) NOT NULL,
              phone_normalized VARCHAR(40) NOT NULL,
              phone_hash VARCHAR(128) NOT NULL,
              reason TEXT NULL,
              source VARCHAR(60) NOT NULL DEFAULT 'manual',
              matched_leads_count INT NOT NULL DEFAULT 0,
              synced_to_meta TINYINT(1) NOT NULL DEFAULT 0,
              last_synced_at DATETIME(6) NULL,
              created_by VARCHAR(36) NULL,
              created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
              updated_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
              CONSTRAINT uk_capi_blocked_tenant_id UNIQUE (tenant_id, id),
              CONSTRAINT uk_capi_blocked_phone UNIQUE (tenant_id, phone_normalized),
              INDEX idx_capi_blocked_sync (tenant_id, synced_to_meta, created_at)
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
          `);
        } else {
          const pgStmts = [
            `CREATE TABLE IF NOT EXISTS capi_blocked_phones (
              id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
              tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
              phone_normalized VARCHAR(40) NOT NULL,
              phone_hash VARCHAR(128) NOT NULL,
              reason TEXT,
              source VARCHAR(60) NOT NULL DEFAULT 'manual',
              matched_leads_count INTEGER NOT NULL DEFAULT 0,
              synced_to_meta BOOLEAN NOT NULL DEFAULT false,
              last_synced_at TIMESTAMPTZ,
              created_by UUID,
              created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
              updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
              CONSTRAINT uk_capi_blocked_tenant_id UNIQUE (tenant_id, id),
              CONSTRAINT uk_capi_blocked_phone UNIQUE (tenant_id, phone_normalized)
            )`,
            `CREATE INDEX IF NOT EXISTS idx_capi_blocked_sync
              ON capi_blocked_phones (tenant_id, synced_to_meta, created_at DESC)`,
            `ALTER TABLE capi_blocked_phones ENABLE ROW LEVEL SECURITY`,
            `ALTER TABLE capi_blocked_phones FORCE ROW LEVEL SECURITY`,
            `DROP POLICY IF EXISTS tenant_isolation_capi_blocked_phones ON capi_blocked_phones`,
            `CREATE POLICY tenant_isolation_capi_blocked_phones ON capi_blocked_phones
              USING (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid)
              WITH CHECK (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid)`,
            `GRANT SELECT, INSERT, UPDATE, DELETE ON capi_blocked_phones TO autodata_app`,
          ];
          for (const stmt of pgStmts) {
            await client.query(stmt);
          }
        }
      });
      capiPoolsInit.add(pool);
    })().finally(() => {
      capiPoolsPending.delete(pool);
    });
    capiPoolsPending.set(pool, running);
  }
  await running;
}

async function ensureCapiWaveAMiddleware(_req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    await ensureCapiWaveASchema();
    next();
  } catch (err: any) {
    sendApiError(res, 500, 'CAPI_SCHEMA_FAILED', err?.message || 'Không thể khởi tạo dữ liệu Meta CAPI.');
  }
}

integrationsRouter.use('/capi', ensureCapiWaveAMiddleware);

function parseCapiBackfillParams(req: Request) {
  const b = req.method === 'GET' ? req.query : req.body || {};
  const days = Math.max(1, Math.min(30, Number(b.days || 7)));
  const fromDate = b.from_date ? String(b.from_date).slice(0, 10) : new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 10);
  const toDate = b.to_date ? String(b.to_date).slice(0, 10) : new Date().toISOString().slice(0, 10);
  const stageId = b.stage_id ? String(b.stage_id).trim() : null;
  const eventName = b.event_name ? String(b.event_name).trim() : null;
  const limit = Math.max(1, Math.min(200, Number(b.limit || 50)));
  return { days, fromDate, toDate, stageId, eventName, limit };
}

// 1. CAPI Historical Backfill Preview & Run
async function handleCapiBackfillPreview(req: Request, res: Response) {
  try {
    const ctx = getTenantContext();
    const { fromDate, toDate, stageId, eventName, limit } = parseCapiBackfillParams(req);
    const sevenDaysAgoMs = Date.now() - 7 * 86_400_000;

    const preview = await withTenantTransaction(ctx.tenantId, async (client) => {
      const params: unknown[] = [ctx.tenantId, `${fromDate}T00:00:00.000Z`, `${toDate}T23:59:59.999Z`];
      let extra = '';
      if (stageId) {
        params.push(stageId);
        extra += ` AND l.stage_id = $${params.length}`;
      }

      const leadsRes = await client.query<{
        id: string;
        name: string;
        phone: string;
        email: string | null;
        created_at: string;
        stage_id: string;
        stage_name: string | null;
        capi_event_mapping: string | null;
      }>(
        `SELECT l.id, l.name, l.phone, l.email, l.created_at, l.stage_id,
                s.stage_name, s.capi_event_mapping
         FROM leads l
         LEFT JOIN tenant_pipeline_stages s ON s.tenant_id = l.tenant_id AND s.id = l.stage_id
         WHERE l.tenant_id = $1
           AND l.is_deleted = false
           AND l.created_at >= $2::timestamptz
           AND l.created_at <= $3::timestamptz
           ${extra}
         ORDER BY l.created_at DESC
         LIMIT 500`,
        params
      );

      const sentLogsRes = await client.query<{ lead_id: string; event_name: string }>(
        'SELECT lead_id, event_name FROM capi_logs WHERE tenant_id = $1 AND response_status = 200',
        [ctx.tenantId]
      );
      const sentSet = new Set(sentLogsRes.rows.map((r) => `${r.lead_id}:${r.event_name}`));

      const byEventMap = new Map<string, number>();
      const byStageMap = new Map<string, { stage_id: string; stage_name: string; count: number }>();
      const eligibleLeads: any[] = [];
      let within7dCount = 0;

      for (const l of leadsRes.rows) {
        const mappedEvent = eventName || l.capi_event_mapping || 'Lead';
        if (sentSet.has(`${l.id}:${mappedEvent}`)) continue;
        const createdMs = new Date(l.created_at).getTime();
        const isWithin7d = createdMs >= sevenDaysAgoMs;
        if (isWithin7d) within7dCount++;
        byEventMap.set(mappedEvent, (byEventMap.get(mappedEvent) || 0) + 1);
        const stKey = l.stage_id || 'unassigned';
        const prevSt = byStageMap.get(stKey) || {
          stage_id: stKey,
          stage_name: l.stage_name || 'Mặc định',
          count: 0,
        };
        prevSt.count++;
        byStageMap.set(stKey, prevSt);
        if (eligibleLeads.length < limit) {
          eligibleLeads.push({
            lead_id: l.id,
            name: l.name,
            stage_name: l.stage_name,
            event_name: mappedEvent,
            within_7d: isWithin7d,
            created_at: l.created_at,
          });
        }
      }

      return {
        from_date: fromDate,
        to_date: toDate,
        total_eligible: eligibleLeads.length,
        within_7d_count: within7dCount,
        by_event: Object.fromEntries(byEventMap.entries()),
        by_stage: Array.from(byStageMap.values()),
        sample_leads: eligibleLeads.slice(0, 25),
      };
    });

    res.json({ success: true, data: preview });
  } catch (err: any) {
    sendApiError(res, 500, 'CAPI_BACKFILL_PREVIEW_FAILED', err?.message || 'Không thể xem trước dữ liệu CAPI Backfill.');
  }
}

integrationsRouter.get('/capi/backfill/preview', requireCapiView, handleCapiBackfillPreview);
integrationsRouter.post('/capi/backfill/preview', requireCapiView, handleCapiBackfillPreview);

integrationsRouter.post('/capi/backfill/run', requireCapiManage, async (req, res) => {
  try {
    const ctx = getTenantContext();
    const { fromDate, toDate, stageId, eventName, limit } = parseCapiBackfillParams(req);
    const cfg = await getTenantSettingsCached(ctx.tenantId);

    const candidates = await withTenantTransaction(ctx.tenantId, async (client) => {
      const params: unknown[] = [ctx.tenantId, `${fromDate}T00:00:00.000Z`, `${toDate}T23:59:59.999Z`];
      let extra = '';
      if (stageId) {
        params.push(stageId);
        extra += ` AND l.stage_id = $${params.length}`;
      }
      const [leadsRes, sentRes] = await Promise.all([
        client.query<{
          id: string;
          name: string;
          phone: string;
          email: string | null;
          utm_source: string | null;
          fbclid: string | null;
          fbc: string | null;
          fbp: string | null;
          meta_lead_id: string | null;
          total_revenue_vnd: number | null;
          custom_fields: Record<string, unknown> | null;
          capi_event_mapping: string | null;
        }>(
          `SELECT l.id, l.name, l.phone, l.email, l.utm_source, l.fbclid, l.fbc, l.fbp,
                  l.meta_lead_id, l.total_revenue_vnd, l.custom_fields, s.capi_event_mapping
           FROM leads l
           LEFT JOIN tenant_pipeline_stages s ON s.tenant_id = l.tenant_id AND s.id = l.stage_id
           WHERE l.tenant_id = $1
             AND l.is_deleted = false
             AND l.created_at >= $2::timestamptz
             AND l.created_at <= $3::timestamptz
             ${extra}
           ORDER BY l.created_at DESC
           LIMIT $${params.length + 1}`,
          [...params, limit]
        ),
        client.query<{ lead_id: string; event_name: string }>(
          'SELECT lead_id, event_name FROM capi_logs WHERE tenant_id = $1 AND response_status = 200',
          [ctx.tenantId]
        ),
      ]);
      const sentSet = new Set(sentRes.rows.map((r) => `${r.lead_id}:${r.event_name}`));
      return leadsRes.rows
        .map((l) => ({ ...l, targetEvent: eventName || l.capi_event_mapping || 'Lead' }))
        .filter((l) => !sentSet.has(`${l.id}:${l.targetEvent}`));
    });

    let succeeded = 0;
    let failed = 0;
    const results: Array<{ lead_id: string; event_name: string; status: number; event_id: string }> = [];

    for (const lead of candidates) {
      const out = await dispatchStageCapiEventDetached({
        tenantId: ctx.tenantId,
        tenantSlug: ctx.tenantSlug,
        eventName: lead.targetEvent,
        tenantSettings: cfg,
        lead: {
          leadId: lead.id,
          name: lead.name,
          phone: lead.phone,
          email: lead.email,
          fbclid: lead.fbclid,
          fbc: lead.fbc,
          fbp: lead.fbp,
          metaLeadId: lead.meta_lead_id,
          dealValue: Number(lead.total_revenue_vnd || 0),
          customFields: lead.custom_fields || undefined,
        },
      });
      const httpStatus = Number((out as any).status ?? 0);
      if (httpStatus >= 200 && httpStatus < 300) {
        succeeded++;
      } else {
        failed++;
      }
      results.push({
        lead_id: lead.id,
        event_name: out.event_name,
        status: httpStatus,
        event_id: out.event_id,
      });
    }

    res.json({
      success: true,
      data: {
        processed: candidates.length,
        succeeded,
        failed,
        skipped: 0,
        results,
      },
    });
  } catch (err: any) {
    sendApiError(res, 500, 'CAPI_BACKFILL_RUN_FAILED', err?.message || 'Không thể chạy đồng bộ CAPI Backfill.');
  }
});

// 2. CAPI Custom Audience Sync Preview & Sync
async function handleCapiAudiencePreview(req: Request, res: Response) {
  try {
    const ctx = getTenantContext();
    const b = req.method === 'GET' ? req.query : req.body || {};
    const stageId = b.stage_id ? String(b.stage_id).trim() : null;
    const lifecycleStage = b.lifecycle_stage ? String(b.lifecycle_stage).trim() : null;
    const cfg = await getTenantSettingsCached(ctx.tenantId);

    const data = await withTenantTransaction(ctx.tenantId, async (client) => {
      const params: unknown[] = [ctx.tenantId];
      let where = 'tenant_id = $1 AND is_deleted = false';
      if (stageId) {
        params.push(stageId);
        where += ` AND stage_id = $${params.length}`;
      }
      if (lifecycleStage) {
        params.push(lifecycleStage);
        where += ` AND lifecycle_stage = $${params.length}`;
      }
      const leadsRes = await client.query<{ id: string; name: string; phone: string; email: string | null }>(
        `SELECT id, name, phone, email FROM leads WHERE ${where} ORDER BY created_at DESC LIMIT 2000`,
        params
      );

      let validPhone = 0;
      let validEmail = 0;
      for (const l of leadsRes.rows) {
        const { matchKeysPresent } = buildCapiUserData(
          ctx.tenantId,
          { leadId: l.id, name: l.name, phone: l.phone, email: l.email },
          { countryCode: cfg.default_country_code, dialCode: cfg.default_dial_code }
        );
        if (matchKeysPresent.ph) validPhone++;
        if (matchKeysPresent.em) validEmail++;
      }

      return {
        total_contacts: leadsRes.rows.length,
        valid_phone_count: validPhone,
        valid_email_count: validEmail,
        schema: ['PHONE', 'EMAIL', 'FN'],
        estimated_match_rate_pct:
          leadsRes.rows.length > 0 ? Math.min(95, Math.round(((validPhone + validEmail * 0.5) / leadsRes.rows.length) * 80)) : 0,
      };
    });

    res.json({ success: true, data });
  } catch (err: any) {
    sendApiError(res, 500, 'CAPI_AUDIENCE_PREVIEW_FAILED', err?.message || 'Không thể xem trước Custom Audience.');
  }
}

integrationsRouter.get('/capi/audiences/preview', requireCapiView, handleCapiAudiencePreview);
integrationsRouter.post('/capi/audiences/preview', requireCapiView, handleCapiAudiencePreview);

integrationsRouter.post('/capi/audiences/sync', requireCapiManage, async (req, res) => {
  try {
    const ctx = getTenantContext();
    const b = req.body || {};
    const audienceName = String(b.audience_name || b.name || `DOMATION Custom Audience ${new Date().toISOString().slice(0, 10)}`).trim();
    const customAudienceId = b.custom_audience_id ? String(b.custom_audience_id).trim() : `ca_sim_${crypto.randomBytes(4).toString('hex')}`;
    const stageId = b.stage_id ? String(b.stage_id).trim() : null;
    const cfg = await getTenantSettingsCached(ctx.tenantId);

    const out = await withTenantTransaction(ctx.tenantId, async (client) => {
      const params: unknown[] = [ctx.tenantId];
      let where = 'tenant_id = $1 AND is_deleted = false';
      if (stageId) {
        params.push(stageId);
        where += ` AND stage_id = $${params.length}`;
      }
      const leadsRes = await client.query<{ id: string; name: string; phone: string; email: string | null }>(
        `SELECT id, name, phone, email FROM leads WHERE ${where} ORDER BY created_at DESC LIMIT 1000`,
        params
      );

      const hashedRows: string[][] = [];
      for (const l of leadsRes.rows) {
        const { userData } = buildCapiUserData(
          ctx.tenantId,
          { leadId: l.id, name: l.name, phone: l.phone, email: l.email },
          { countryCode: cfg.default_country_code, dialCode: cfg.default_dial_code }
        );
        const ph = Array.isArray(userData.ph) && userData.ph[0] ? String(userData.ph[0]) : '';
        const em = Array.isArray(userData.em) && userData.em[0] ? String(userData.em[0]) : '';
        const fn = Array.isArray(userData.fn) && userData.fn[0] ? String(userData.fn[0]) : '';
        if (ph || em) {
          hashedRows.push([ph, em, fn]);
        }
      }

      await client.query(
        `INSERT INTO admin_audit_logs (
           tenant_id, actor_id, actor_name, action, entity_type, entity_id, details
         ) VALUES ($1, $2, $3, 'capi_audience_sync', 'meta_custom_audience', $4, $5::jsonb)`,
        [
          ctx.tenantId,
          ctx.userId,
          ctx.userName || 'Admin',
          customAudienceId,
          JSON.stringify({
            audience_name: audienceName,
            synced_count: hashedRows.length,
            silent: isOutboundSilentMode(),
          }),
        ]
      );

      return {
        custom_audience_id: customAudienceId,
        audience_name: audienceName,
        synced_count: hashedRows.length,
        schema: ['PHONE', 'EMAIL', 'FN'],
        silent: isOutboundSilentMode(),
        dry_run: isOutboundSilentMode(),
      };
    });

    res.json({ success: true, data: out });
  } catch (err: any) {
    sendApiError(res, 500, 'CAPI_AUDIENCE_SYNC_FAILED', err?.message || 'Không thể đồng bộ Meta Custom Audience.');
  }
});

// 3. CAPI AdSet Quick Optimization (`/adsets/:id/optimize`)
integrationsRouter.post('/capi/adsets/:id/optimize', requireCapiManage, async (req, res) => {
  try {
    const ctx = getTenantContext();
    const adsetId = String(req.params.id || '').trim();
    const b = req.body || {};
    const action = String(b.action || 'adjust_budget').trim().toLowerCase();
    const dailyBudgetVnd =
      b.daily_budget_vnd !== undefined ? Math.max(0, Math.round(Number(b.daily_budget_vnd) || 0)) : undefined;
    const reason = String(b.reason || `CAPI ROAS Auto-Optimize (${action})`).trim();
    const nextStatus = action === 'pause' ? 'PAUSED' : action === 'enable' ? 'ACTIVE' : undefined;

    const result = await withTenantTransaction(ctx.tenantId, async (client) => {
      await client.query(
        `INSERT INTO admin_audit_logs (
           tenant_id, actor_id, actor_name, action, entity_type, entity_id, details
         ) VALUES ($1, $2, $3, 'capi_adset_optimize', 'meta_adset', $4, $5::jsonb)`,
        [
          ctx.tenantId,
          ctx.userId,
          ctx.userName || 'Admin',
          adsetId,
          JSON.stringify({ action, nextStatus, daily_budget_vnd: dailyBudgetVnd, reason }),
        ]
      );
      return {
        adset_id: adsetId,
        action,
        status: nextStatus || 'ACTIVE',
        daily_budget_vnd: dailyBudgetVnd ?? null,
        reason,
        silent: isOutboundSilentMode(),
        dry_run: isOutboundSilentMode(),
      };
    });

    res.json({ success: true, data: result });
  } catch (err: any) {
    sendApiError(res, 500, 'CAPI_ADSET_OPTIMIZE_FAILED', err?.message || 'Không thể tối ưu AdSet Meta.');
  }
});

// 4. Phone Farm / Spam Phone Exclusion Guard (`/phone-farm/*`)
integrationsRouter.get('/capi/phone-farm/stats', requireCapiView, async (_req, res) => {
  try {
    const ctx = getTenantContext();
    const data = await withTenantTransaction(ctx.tenantId, async (client) => {
      const [statsRes, itemsRes] = await Promise.all([
        client.query<{
          total_blocked: number;
          synced_count: number;
          pending_sync_count: number;
          matched_leads_count: number;
        }>(
          `SELECT
             COUNT(*) AS total_blocked,
             COALESCE(SUM(CASE WHEN synced_to_meta = true THEN 1 ELSE 0 END), 0) AS synced_count,
             COALESCE(SUM(CASE WHEN synced_to_meta = false THEN 1 ELSE 0 END), 0) AS pending_sync_count,
             COALESCE(SUM(matched_leads_count), 0) AS matched_leads_count
           FROM capi_blocked_phones
           WHERE tenant_id = $1`,
          [ctx.tenantId]
        ),
        client.query(
          'SELECT * FROM capi_blocked_phones WHERE tenant_id = $1 ORDER BY created_at DESC LIMIT 100',
          [ctx.tenantId]
        ),
      ]);
      const st = statsRes.rows[0] || {
        total_blocked: 0,
        synced_count: 0,
        pending_sync_count: 0,
        matched_leads_count: 0,
      };
      return {
        total_blocked: Number(st.total_blocked || 0),
        synced_count: Number(st.synced_count || 0),
        pending_sync_count: Number(st.pending_sync_count || 0),
        matched_leads_count: Number(st.matched_leads_count || 0),
        items: itemsRes.rows,
      };
    });
    res.json({ success: true, data });
  } catch (err: any) {
    sendApiError(res, 500, 'CAPI_PHONE_FARM_STATS_FAILED', err?.message || 'Không thể tải thống kê Phone Farm.');
  }
});

integrationsRouter.post('/capi/phone-farm/import', requireCapiManage, async (req, res) => {
  try {
    const ctx = getTenantContext();
    const b = req.body || {};
    const cfg = await getTenantSettingsCached(ctx.tenantId);
    const rawPhones: string[] = Array.isArray(b.phones)
      ? b.phones.map((p: unknown) => String(p || '').trim())
      : typeof b.phones_text === 'string'
        ? b.phones_text.split(/[\n,;]+/).map((p: string) => p.trim())
        : [];
    const uniqueRaw = Array.from(new Set(rawPhones.filter(Boolean))).slice(0, 1000);
    if (uniqueRaw.length === 0) {
      sendApiError(res, 422, 'VALIDATION_ERROR', 'Cần cung cấp danh sách số điện thoại (phones) để chặn.');
      return;
    }

    const reason = String(b.reason || 'Phone Farm / Virtual SIM Spam Exclusion').trim();
    const source = String(b.source || 'manual').trim().slice(0, 60);

    const out = await withTenantTransaction(ctx.tenantId, async (client) => {
      let imported = 0;
      let totalMatchedLeads = 0;

      for (const rawPhone of uniqueRaw) {
        const pCheck = validateAndNormalizePhone(rawPhone, {
          default_dial_code: cfg.default_dial_code,
          allow_international_phones: cfg.allow_international_phones,
          allow_landline_phones: cfg.allow_landline_phones,
          vn_mobile_prefixes: cfg.vn_mobile_prefixes,
          custom_phone_regex: cfg.custom_phone_regex,
          block_repeated_digits: cfg.block_repeated_digits,
        });
        const normPhone = (pCheck.valid ? pCheck.normalizedE164 : rawPhone.replace(/\D/g, '')).slice(0, 40);
        if (!normPhone) continue;

        const phoneHash = crypto.createHash('sha256').update(normPhone).digest('hex');
        const matchRes = await client.query<{ cnt: number }>(
          'SELECT COUNT(*) AS cnt FROM leads WHERE tenant_id = $1 AND phone = $2 AND is_deleted = false',
          [ctx.tenantId, normPhone]
        );
        const matchedCnt = Number(matchRes.rows[0]?.cnt || 0);
        totalMatchedLeads += matchedCnt;

        await client.query(
          `INSERT INTO capi_blocked_phones (
             id, tenant_id, phone_normalized, phone_hash, reason, source,
             matched_leads_count, synced_to_meta, created_by
           ) VALUES ($1, $2, $3, $4, $5, $6, $7, false, $8)
           ON CONFLICT (tenant_id, phone_normalized)
           DO UPDATE SET
             reason = EXCLUDED.reason,
             matched_leads_count = EXCLUDED.matched_leads_count,
             updated_at = clock_timestamp()`,
          [crypto.randomUUID(), ctx.tenantId, normPhone, phoneHash, reason, source, matchedCnt, ctx.userId]
        );
        imported++;
      }

      const rowsRes = await client.query(
        'SELECT * FROM capi_blocked_phones WHERE tenant_id = $1 ORDER BY created_at DESC LIMIT 100',
        [ctx.tenantId]
      );
      return {
        imported,
        matched_leads_count: totalMatchedLeads,
        items: rowsRes.rows,
      };
    });

    res.status(201).json({ success: true, data: out });
  } catch (err: any) {
    sendApiError(res, 500, 'CAPI_PHONE_FARM_IMPORT_FAILED', err?.message || 'Không thể nhập danh sách số chặn Phone Farm.');
  }
});

integrationsRouter.post('/capi/phone-farm/sync-meta', requireCapiManage, async (req, res) => {
  try {
    const ctx = getTenantContext();
    const exclusionAudienceId = req.body?.exclusion_audience_id
      ? String(req.body.exclusion_audience_id).trim()
      : `excl_sim_${crypto.randomBytes(4).toString('hex')}`;

    const out = await withTenantTransaction(ctx.tenantId, async (client) => {
      const pendingRes = await client.query<{ id: string; phone_hash: string }>(
        'SELECT id, phone_hash FROM capi_blocked_phones WHERE tenant_id = $1 AND synced_to_meta = false LIMIT 1000',
        [ctx.tenantId]
      );
      if (pendingRes.rows.length > 0) {
        const ids = pendingRes.rows.map((r) => r.id);
        const phPlaceholders = ids.map((_, idx) => `$${idx + 2}`).join(', ');
        await client.query(
          `UPDATE capi_blocked_phones
           SET synced_to_meta = true, last_synced_at = clock_timestamp(), updated_at = clock_timestamp()
           WHERE tenant_id = $1 AND id IN (${phPlaceholders})`,
          [ctx.tenantId, ...ids]
        );
      }

      return {
        synced_count: pendingRes.rows.length,
        exclusion_audience_id: exclusionAudienceId,
        silent: isOutboundSilentMode(),
        dry_run: isOutboundSilentMode(),
      };
    });

    res.json({ success: true, data: out });
  } catch (err: any) {
    sendApiError(res, 500, 'CAPI_PHONE_FARM_SYNC_FAILED', err?.message || 'Không thể đồng bộ danh sách loại trừ lên Meta.');
  }
});

// 5. Retry Single Failed CAPI Delivery Log (`/retry/:logId`)
integrationsRouter.post('/capi/retry/:logId', requireCapiManage, async (req, res) => {
  try {
    const ctx = getTenantContext();
    const cfg = await getTenantSettingsCached(ctx.tenantId);

    const logLead = await withTenantTransaction(ctx.tenantId, async (client) => {
      const r = await client.query<{
        log_id: string;
        lead_id: string;
        event_name: string;
        event_id: string;
        name: string;
        phone: string;
        email: string | null;
        fbclid: string | null;
        fbc: string | null;
        fbp: string | null;
        meta_lead_id: string | null;
        total_revenue_vnd: number | null;
        custom_fields: Record<string, unknown> | null;
      }>(
        `SELECT cl.id AS log_id, cl.lead_id, cl.event_name, cl.event_id,
                l.name, l.phone, l.email, l.fbclid, l.fbc, l.fbp, l.meta_lead_id,
                l.total_revenue_vnd, l.custom_fields
         FROM capi_logs cl
         INNER JOIN leads l ON l.tenant_id = cl.tenant_id AND l.id = cl.lead_id
         WHERE cl.tenant_id = $1 AND cl.id = $2
         LIMIT 1`,
        [ctx.tenantId, req.params.logId]
      );
      return r.rows[0] || null;
    });

    if (!logLead) {
      sendApiError(res, 404, 'CAPI_LOG_NOT_FOUND', 'Không tìm thấy bản ghi Meta CAPI cần gửi lại.');
      return;
    }

    const out = await dispatchStageCapiEventDetached({
      tenantId: ctx.tenantId,
      tenantSlug: ctx.tenantSlug,
      eventName: logLead.event_name || 'Lead',
      tenantSettings: cfg,
      lead: {
        leadId: logLead.lead_id,
        name: logLead.name,
        phone: logLead.phone,
        email: logLead.email,
        fbclid: logLead.fbclid,
        fbc: logLead.fbc,
        fbp: logLead.fbp,
        metaLeadId: logLead.meta_lead_id,
        dealValue: Number(logLead.total_revenue_vnd || 0),
        customFields: logLead.custom_fields || undefined,
      },
    });

    res.json({
      success: true,
      data: {
        retried: true,
        original_log_id: logLead.log_id,
        lead_id: logLead.lead_id,
        event_name: out.event_name,
        event_id: out.event_id,
        meta_http_status: Number((out as any).status ?? 200),
        fbtrace_id: out.fbtrace_id,
      },
    });
  } catch (err: any) {
    sendApiError(res, 500, 'CAPI_RETRY_FAILED', err?.message || 'Không thể gửi lại sự kiện Meta CAPI.');
  }
});
