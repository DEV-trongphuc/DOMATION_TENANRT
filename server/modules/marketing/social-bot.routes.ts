import crypto from 'node:crypto';
import { Router } from 'express';
import type { DbClient } from '../../core/database/db-adapter.ts';
import { withTenantTransaction } from '../../core/database/transaction.ts';
import { getTenantContext } from '../../core/context/tenant-context.ts';
import { getTenantSettingsCached } from '../../core/settings/tenant-cache.ts';
import {
  requireEntitlement,
  requirePermission,
  sendApiError,
} from '../../core/security/rbac.ts';
import { maskContactPiiIfDisallowed, sanitizeAvatarUrl } from '../../core/security/pii-masker.ts';
import { decryptTenantSecret, encryptTenantSecret } from '../../core/crypto/vault.ts';
import { tenantRedis } from '../../core/cache/tenant-redis.ts';
import { emitDomainEvent } from '../../core/events/event-bus.ts';
import { runUnassignedLeadDrainer } from '../../cron/subroutines/lead-drainer.ts';
import { dispatchZnsNotification } from './dispatchers.ts';
import { normalizePhoneE164 } from '../../services/phone.service.ts';
import {
  extractMetaPageConfigs,
  sendMetaMessengerMessage,
} from '../../services/meta-messenger.service.ts';
import {
  promoteLeadsToSaleRoundInTx,
  refreshAudienceCachedCount,
  upsertMasterContactInTx,
} from '../audiences/audiences.service.ts';
import {
  canUserUnmaskMarketingPii,
  getSuppressionMatchKeys,
  parseJsonCol,
  readTenantChannelVault,
} from './utils.ts';

export const socialBotRouter = Router();

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

socialBotRouter.use(requireEntitlement('mkt_social_bot'));

export interface ConversationHandoffState {
  assigned_agent_id: string | null;
  assigned_agent_name: string | null;
  handoff_reason: string | null;
  handoff_at: string | null;
  channel?: string;
}

async function readHandoffStateMap(
  client: DbClient,
  tenantId: string
): Promise<Record<string, ConversationHandoffState>> {
  const r = await client.query<{ settings: Record<string, unknown> }>(
    'SELECT settings FROM tenants WHERE id = $1 LIMIT 1',
    [tenantId]
  );
  const raw = r.rows[0]?.settings?.social_handoff_state;
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    return { ...(raw as Record<string, ConversationHandoffState>) };
  }
  return {};
}

async function writeConversationHandoffState(
  client: DbClient,
  tenantId: string,
  conversationId: string,
  state: ConversationHandoffState | null
): Promise<ConversationHandoffState> {
  const map = await readHandoffStateMap(client, tenantId);
  if (state === null) {
    delete map[conversationId];
  } else {
    map[conversationId] = state;
    // Keep map bounded to latest 500 entries
    const keys = Object.keys(map);
    if (keys.length > 500) {
      for (const k of keys.slice(0, keys.length - 500)) {
        delete map[k];
      }
    }
  }
  await client.query(
    `UPDATE tenants
     SET settings = COALESCE(settings, '{}'::jsonb) || $2::jsonb,
         updated_at = clock_timestamp()
     WHERE id = $1`,
    [tenantId, JSON.stringify({ social_handoff_state: map })]
  );
  return (
    state || {
      assigned_agent_id: null,
      assigned_agent_name: null,
      handoff_reason: null,
      handoff_at: null,
    }
  );
}

function hydrateConversationHandoff<T extends Record<string, unknown>>(
  row: T,
  handoffMap: Record<string, ConversationHandoffState>
): T & ConversationHandoffState {
  const cid = String(row.id || '');
  const st = handoffMap[cid];
  const paused = Boolean(row.bot_paused);
  return {
    ...row,
    bot_paused: paused,
    assigned_agent_id: paused ? (st?.assigned_agent_id ?? null) : null,
    assigned_agent_name: paused ? (st?.assigned_agent_name ?? null) : null,
    handoff_reason: paused ? (st?.handoff_reason ?? null) : null,
    handoff_at: paused ? (st?.handoff_at ?? null) : null,
  };
}

// Track recently processed webhook event IDs per tenant+conversation to prevent duplicate auto-replies
const RECENT_WEBHOOK_EVENTS = new Map<string, number>();
function isDuplicateWebhookEvent(key: string): boolean {
  const now = Date.now();
  // Prune stale entries > 5 minutes
  if (RECENT_WEBHOOK_EVENTS.size > 2000) {
    for (const [k, ts] of RECENT_WEBHOOK_EVENTS.entries()) {
      if (now - ts > 300_000) RECENT_WEBHOOK_EVENTS.delete(k);
    }
  }
  const prev = RECENT_WEBHOOK_EVENTS.get(key);
  if (prev && now - prev < 300_000) return true;
  RECENT_WEBHOOK_EVENTS.set(key, now);
  return false;
}

async function detectScenarioConflicts(
  client: DbClient,
  tenantId: string,
  candidate: { id?: string; channel: string; triggerType: string; keywords: string[]; isActive: boolean }
): Promise<Array<{ scenario_id: string; scenario_name: string; reason: string }>> {
  if (!candidate.isActive) return [];
  const res = await client.query<{
    id: string;
    name: string;
    channel: string;
    trigger_type: string;
    keywords_json: unknown;
  }>(
    `SELECT id, name, channel, trigger_type, keywords_json
     FROM mkt_automation_scenarios
     WHERE tenant_id = $1 AND is_active = true`,
    [tenantId]
  );
  const warnings: Array<{ scenario_id: string; scenario_name: string; reason: string }> = [];
  const candKws = new Set(candidate.keywords.map((k) => k.trim().toLowerCase()).filter(Boolean));
  const singletonTriggers = new Set(['welcome', 'ai_reply', 'holiday', 'after_hours', 'default_fallback']);

  for (const row of res.rows) {
    if (candidate.id && String(row.id) === String(candidate.id)) continue;
    const channelOverlap =
      row.channel === candidate.channel ||
      row.channel === 'omnichannel' ||
      candidate.channel === 'omnichannel';
    if (!channelOverlap) continue;

    if (singletonTriggers.has(candidate.triggerType) && row.trigger_type === candidate.triggerType) {
      warnings.push({
        scenario_id: String(row.id),
        scenario_name: String(row.name),
        reason: `Trùng loại kịch bản "${candidate.triggerType}" trên kênh ${row.channel}.`,
      });
    } else if (candidate.triggerType === 'keyword' && row.trigger_type === 'keyword' && candKws.size > 0) {
      const existingKws = parseJsonCol<string[]>(row.keywords_json, [])
        .map((k) => String(k || '').trim().toLowerCase())
        .filter(Boolean);
      const overlap = existingKws.filter((k) => candKws.has(k));
      if (overlap.length > 0) {
        warnings.push({
          scenario_id: String(row.id),
          scenario_name: String(row.name),
          reason: `Trùng từ khóa (${overlap.join(', ')}) trên kênh ${row.channel}.`,
        });
      }
    }
  }
  return warnings;
}

export interface FaqRuleItemDto {
  id: string;
  keywords: string[];
  question: string;
  answer: string;
}

export function extractContactEntitiesFromText(text: string): {
  phone: string | null;
  email: string | null;
} {
  const raw = String(text || '');
  const emailMatch = raw.match(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/);
  const cleanedForPhone = raw.replace(/[\s.-]+/g, '');
  const phoneMatch = cleanedForPhone.match(/(?:\+?84|0)(?:3|5|7|8|9)\d{8}/);
  return {
    phone: phoneMatch ? phoneMatch[0] : null,
    email: emailMatch ? emailMatch[0].toLowerCase() : null,
  };
}

export function generateBotReplyFromRag(
  messageText: string,
  botName: string,
  brandPersona: string,
  faqRules: FaqRuleItemDto[],
  extracted: { phone: string | null; email: string | null },
  trainingDocs?: Array<{ title?: string; content_text?: string }>
): { reply: string; matchedQuestion: string | null } {
  const lower = String(messageText || '').toLowerCase();

  for (const rule of faqRules) {
    const kws = Array.isArray(rule.keywords) ? rule.keywords : [];
    const hit =
      kws.some((k) => k && lower.includes(String(k).toLowerCase())) ||
      (rule.question && lower.includes(String(rule.question).toLowerCase().slice(0, 18)));
    if (hit && rule.answer) {
      return { reply: rule.answer, matchedQuestion: rule.question || null };
    }
  }

  if (Array.isArray(trainingDocs) && trainingDocs.length > 0) {
    const tokens = Array.from(
      new Set(
        lower
          .split(/[\s,.;:!?()[\]{}"'\/\\]+/)
          .map((w) => w.replace(/[^\p{L}\p{N}]/gu, ''))
          .filter((w) => w.length >= 2)
      )
    );

    let bestDoc: { title: string; bodyText: string; score: number } | null = null;
    for (const doc of trainingDocs) {
      const titleLower = String(doc.title || '').toLowerCase();
      const bodyText = String(doc.content_text || '').trim();
      if (!bodyText) continue;
      const bodyLower = bodyText.toLowerCase();

      const titleHits = tokens.filter((tk) => titleLower.includes(tk)).length;
      const bodyHits = tokens.filter((tk) => bodyLower.includes(tk)).length;
      const combinedHits = tokens.filter((tk) => titleLower.includes(tk) || bodyLower.includes(tk)).length;
      const fullTitleMatch = Boolean(titleLower && lower.includes(titleLower));

      const threshold = tokens.length <= 3 || titleHits > 0 ? 1 : 2;
      if (fullTitleMatch || combinedHits >= threshold) {
        const score = (fullTitleMatch ? 10 : 0) + titleHits * 3 + bodyHits * 2 + combinedHits;
        if (!bestDoc || score > bestDoc.score) {
          bestDoc = {
            title: String(doc.title || 'Knowledge Doc'),
            bodyText,
            score,
          };
        }
      }
    }

    if (bestDoc) {
      return {
        reply: bestDoc.bodyText.slice(0, 420),
        matchedQuestion: bestDoc.title,
      };
    }
  }

  if (extracted.phone || extracted.email) {
    return {
      reply: `Cảm ơn bạn! ${botName} đã ghi nhận thông tin liên hệ (${[extracted.phone, extracted.email].filter(Boolean).join(' • ')}) và chuyển cho chuyên viên tư vấn hỗ trợ ngay.`,
      matchedQuestion: 'auto_contact_capture',
    };
  }

  const personaPrefix = brandPersona ? `[${botName}] ` : '';
  return {
    reply: `${personaPrefix}Xin chào! Mình là ${botName}. Bạn vui lòng cho mình biết nhu cầu chi tiết hoặc để lại Số điện thoại / Email để đội ngũ gửi báo giá & ưu đãi phù hợp nhất nhé!`,
    matchedQuestion: null,
  };
}

export async function resolveBotReplyInTx(
  client: DbClient,
  tenantId: string,
  channel: string,
  messageText: string,
  botCfg: {
    bot_name: string;
    brand_persona: string;
    faq_rules: FaqRuleItemDto[];
  },
  extracted: { phone: string | null; email: string | null }
): Promise<{ reply: string; matchedQuestion: string | null; scenarioId: string | null }> {
  const lower = String(messageText || '').toLowerCase();

  // 1. Evaluate active keyword scenarios (`mkt_automation_scenarios`) matching channel or omnichannel
  const scenRes = await client.query<{
    id: string;
    name: string;
    keywords_json: unknown;
    nodes_json: unknown;
  }>(
    `SELECT id, name, keywords_json, nodes_json
     FROM mkt_automation_scenarios
     WHERE tenant_id = $1 AND is_active = true AND trigger_type = 'keyword'
       AND channel IN ($2, 'omnichannel')
     ORDER BY updated_at DESC
     LIMIT 50`,
    [tenantId, channel]
  );

  for (const scen of scenRes.rows) {
    const kws = parseJsonCol<string[]>(scen.keywords_json, []);
    const matched = kws.some((k) => {
      const kw = String(k || '').trim().toLowerCase();
      return kw.length > 0 && lower.includes(kw);
    });
    if (!matched) continue;

    await client.query(
      `UPDATE mkt_automation_scenarios
       SET matched_count = matched_count + 1, updated_at = clock_timestamp()
       WHERE tenant_id = $1 AND id = $2`,
      [tenantId, scen.id]
    );

    const nodes = parseJsonCol<Array<Record<string, unknown>>>(scen.nodes_json, []);
    let scenarioReply = '';
    for (const node of nodes) {
      const cfg = (node.config && typeof node.config === 'object' ? node.config : node.data) as
        | Record<string, unknown>
        | undefined;
      const candidate = String(
        cfg?.message || cfg?.text || cfg?.reply || cfg?.content || node.content || node.message || ''
      ).trim();
      if (candidate) {
        scenarioReply = candidate;
        break;
      }
    }

    if (scenarioReply) {
      return {
        reply: scenarioReply,
        matchedQuestion: `scenario:${String(scen.name)}`,
        scenarioId: String(scen.id),
      };
    }
  }

  // 2. Query indexed/trained RAG knowledge docs (`mkt_ai_training_docs`)
  const docsRes = await client.query<{ title: string; content_text: string }>(
    `SELECT title, content_text
     FROM mkt_ai_training_docs
     WHERE tenant_id = $1 AND status IN ('indexed', 'trained')
     ORDER BY updated_at DESC
     LIMIT 50`,
    [tenantId]
  );

  const rag = generateBotReplyFromRag(
    messageText,
    botCfg.bot_name,
    botCfg.brand_persona,
    botCfg.faq_rules,
    extracted,
    docsRes.rows
  );

  return {
    reply: rag.reply,
    matchedQuestion: rag.matchedQuestion,
    scenarioId: null,
  };
}

async function getOrCreateTenantBotConfig(client: DbClient, tenantId: string) {
  const existing = await client.query('SELECT * FROM mkt_ai_bot_configs WHERE tenant_id = $1 LIMIT 1', [tenantId]);
  if (existing.rows[0]) {
    return existing.rows[0];
  }
  const id = crypto.randomUUID();
  const defaultFaq: FaqRuleItemDto[] = [
    {
      id: 'faq_pricing',
      keywords: ['bảng giá', 'chi phí', 'bao nhiêu tiền', 'gói cước'],
      question: 'Bảng giá dịch vụ như thế nào?',
      answer: 'Hiện tại chúng tôi cung cấp các gói linh hoạt theo quy mô doanh nghiệp. Bạn để lại SĐT hoặc Email để nhận báo giá chi tiết kèm ưu đãi nhé!',
    },
    {
      id: 'faq_demo',
      keywords: ['dùng thử', 'demo', 'tư vấn'],
      question: 'Có hỗ trợ dùng thử hoặc demo trực tiếp không?',
      answer: 'Có ạ! Đội ngũ chuyên gia hỗ trợ Demo 1-1 và kích hoạt không gian trải nghiệm ngay trong 5 phút.',
    },
  ];
  await client.query(
    `INSERT INTO mkt_ai_bot_configs (
       id, tenant_id, bot_name, brand_persona, welcome_message,
       channels_json, faq_rules_json, auto_extract_contact, routing_mode, is_active
     ) VALUES (
       $1, $2, 'DOM Agent CSKH', 'Tận tâm, chuyên nghiệp, phản hồi ngắn gọn đúng trọng tâm.',
       'Xin chào! DOM Agent có thể hỗ trợ gì cho bạn hôm nay?',
       '["messenger","zalo_oa","web_chat"]'::jsonb, $3::jsonb, true, 'audience', true
     )
     ON CONFLICT (tenant_id) DO NOTHING`,
    [id, tenantId, JSON.stringify(defaultFaq)]
  );
  const reloaded = await client.query('SELECT * FROM mkt_ai_bot_configs WHERE tenant_id = $1 LIMIT 1', [tenantId]);
  return reloaded.rows[0];
}

function mapBotConfig(row: Record<string, unknown>) {
  return {
    id: String(row.id),
    bot_name: String(row.bot_name || 'DOM Agent CSKH'),
    brand_persona: String(row.brand_persona || ''),
    welcome_message: String(row.welcome_message || ''),
    channels: parseJsonCol<string[]>(row.channels_json, ['messenger', 'zalo_oa', 'web_chat']),
    faq_rules: parseJsonCol<FaqRuleItemDto[]>(row.faq_rules_json, []),
    auto_extract_contact: Boolean(row.auto_extract_contact),
    routing_mode: String(row.routing_mode || 'audience') as 'none' | 'audience' | 'sale_round',
    target_audience_id: row.target_audience_id ? String(row.target_audience_id) : null,
    distribution_round_id: row.distribution_round_id ? String(row.distribution_round_id) : null,
    is_active: Boolean(row.is_active),
    updated_at: row.updated_at,
  };
}

// Overview: Conversations + Bot Config + Vault Channel Status + Audiences + Sale Rounds
socialBotRouter.get('/', requirePermission('mkt_social_bot', 'view'), async (req, res) => {
  try {
    const ctx = getTenantContext();
    const cfg = await getTenantSettingsCached(ctx.tenantId);
    const channelFilter = req.query.channel ? String(req.query.channel) : '';

    const data = await withTenantTransaction(ctx.tenantId, async (client) => {
      const botRow = await getOrCreateTenantBotConfig(client, ctx.tenantId);
      const canUnmask = await canUserUnmaskMarketingPii(client, ctx.tenantId, ctx.userId);

      let convSql = `
        SELECT c.*, l.name AS lead_name, l.status AS lead_status, l.lead_score
        FROM mkt_social_conversations c
        LEFT JOIN leads l ON l.tenant_id = c.tenant_id AND l.id = c.lead_id
        WHERE c.tenant_id = $1
      `;
      const convParams: unknown[] = [ctx.tenantId];
      if (channelFilter && ['messenger', 'zalo_oa', 'web_chat'].includes(channelFilter)) {
        convParams.push(channelFilter);
        convSql += ` AND c.channel = $2`;
      }
      convSql += ` ORDER BY c.last_message_at DESC LIMIT 100`;

      const [convRes, audRes, roundsRes, zaloVault, metaVault, handoffMap] = await Promise.all([
        client.query(convSql, convParams),
        client.query(
          'SELECT id, name, audience_type FROM tenant_audiences WHERE tenant_id = $1 AND is_active = true ORDER BY name ASC',
          [ctx.tenantId]
        ),
        client.query(
          'SELECT id, name, pipeline_id FROM distribution_rounds WHERE tenant_id = $1 AND is_active = true ORDER BY priority ASC',
          [ctx.tenantId]
        ),
        readTenantChannelVault(client, ctx.tenantId, ['zalo_oa', 'zalo_zns', 'zalo_bot']),
        readTenantChannelVault(client, ctx.tenantId, ['meta_messenger', 'facebook_ads', 'meta_capi']),
        readHandoffStateMap(client, ctx.tenantId),
      ]);

      const conversations = convRes.rows.map((row) => {
        const masked = maskContactPiiIfDisallowed(
          {
            ...row,
            phone: row.extracted_phone,
            email: row.extracted_email,
          },
          canUnmask,
          cfg
        );
        return hydrateConversationHandoff(
          {
            ...row,
            customer_avatar: sanitizeAvatarUrl(row.customer_avatar),
            extracted_phone: masked.phone,
            extracted_email: masked.email,
          },
          handoffMap
        );
      });

      return {
        bot_config: mapBotConfig(botRow),
        conversations,
        audiences: audRes.rows,
        rounds: roundsRes.rows,
        vault_channels: {
          zalo_oa: { configured: zaloVault.configured, provider: zaloVault.integrationType },
          messenger: { configured: metaVault.configured, provider: metaVault.integrationType },
        },
      };
    });

    res.json({ success: true, data });
  } catch (err: any) {
    sendApiError(res, 500, 'SOCIAL_BOT_OVERVIEW_FAILED', err?.message || 'Không thể tải Hộp thư đa kênh & AI Bot Studio.');
  }
});

// Update AI Bot Studio Config (Tenant-Isolated Persona, FAQ/RAG Rules, Auto Contact Routing)
socialBotRouter.put('/bot-config', requirePermission('mkt_social_bot', 'edit'), async (req, res) => {
  try {
    const ctx = getTenantContext();
    const updated = await withTenantTransaction(ctx.tenantId, async (client) => {
      const ex = await getOrCreateTenantBotConfig(client, ctx.tenantId);

      const botName = req.body?.bot_name !== undefined ? String(req.body.bot_name).trim() : String(ex.bot_name);
      const brandPersona =
        req.body?.brand_persona !== undefined ? String(req.body.brand_persona).trim() : String(ex.brand_persona || '');
      const welcomeMessage =
        req.body?.welcome_message !== undefined
          ? String(req.body.welcome_message).trim()
          : String(ex.welcome_message || '');
      const channels = Array.isArray(req.body?.channels)
        ? req.body.channels
        : parseJsonCol(ex.channels_json, ['messenger', 'zalo_oa', 'web_chat']);
      const faqRules = Array.isArray(req.body?.faq_rules)
        ? req.body.faq_rules
        : parseJsonCol(ex.faq_rules_json, []);
      const autoExtract =
        req.body?.auto_extract_contact !== undefined
          ? Boolean(req.body.auto_extract_contact)
          : Boolean(ex.auto_extract_contact);
      const routingMode =
        req.body?.routing_mode && ['none', 'audience', 'sale_round'].includes(req.body.routing_mode)
          ? String(req.body.routing_mode)
          : String(ex.routing_mode || 'audience');
      const targetAudienceId =
        req.body?.target_audience_id !== undefined
          ? req.body.target_audience_id
            ? String(req.body.target_audience_id)
            : null
          : ex.target_audience_id;
      const distributionRoundId =
        req.body?.distribution_round_id !== undefined
          ? req.body.distribution_round_id
            ? String(req.body.distribution_round_id)
            : null
          : ex.distribution_round_id;
      const isActive =
        req.body?.is_active !== undefined ? Boolean(req.body.is_active) : Boolean(ex.is_active);

      await client.query(
        `UPDATE mkt_ai_bot_configs
         SET bot_name = $2,
             brand_persona = $3,
             welcome_message = $4,
             channels_json = $5::jsonb,
             faq_rules_json = $6::jsonb,
             auto_extract_contact = $7,
             routing_mode = $8,
             target_audience_id = $9,
             distribution_round_id = $10,
             is_active = $11,
             updated_at = clock_timestamp()
         WHERE tenant_id = $1`,
        [
          ctx.tenantId,
          botName,
          brandPersona,
          welcomeMessage,
          JSON.stringify(channels),
          JSON.stringify(faqRules),
          autoExtract,
          routingMode,
          targetAudienceId,
          distributionRoundId,
          isActive,
        ]
      );

      const r = await client.query('SELECT * FROM mkt_ai_bot_configs WHERE tenant_id = $1 LIMIT 1', [ctx.tenantId]);
      return mapBotConfig(r.rows[0]);
    });

    res.json({ success: true, data: updated });
  } catch (err: any) {
    sendApiError(res, 500, 'UPDATE_BOT_CONFIG_FAILED', err?.message || 'Không thể lưu cấu hình AI Bot Studio.');
  }
});

function maskSecretValue(val?: string | null): string {
  const s = String(val || '').trim();
  if (!s) return '';
  if (s.length <= 8) return '••••••••';
  return `${s.slice(0, 4)}••••${s.slice(-4)}`;
}

socialBotRouter.get('/messenger-config', requirePermission('mkt_social_bot', 'view'), async (_req, res) => {
  try {
    const ctx = getTenantContext();
    const data = await withTenantTransaction(ctx.tenantId, async (client) => {
      const vault = await readTenantChannelVault(client, ctx.tenantId, ['meta_messenger', 'facebook_ads', 'meta_capi']);
      const pages = extractMetaPageConfigs(vault.config).map((p) => ({
        page_id: p.page_id,
        page_name: p.page_name || '',
        app_id: p.app_id || '',
        page_access_token_masked: maskSecretValue(p.page_access_token),
        has_page_access_token: Boolean(p.page_access_token),
        app_secret_masked: maskSecretValue(p.app_secret),
        has_app_secret: Boolean(p.app_secret),
        verify_token_masked: maskSecretValue(p.verify_token),
        has_verify_token: Boolean(p.verify_token),
        status: p.status || 'active',
        mode: p.mode || 'live',
      }));
      return {
        configured: vault.configured,
        provider: vault.integrationType || 'meta_messenger',
        status: vault.status,
        pages,
      };
    });
    res.json({ success: true, data });
  } catch (err: any) {
    sendApiError(res, 500, 'GET_MESSENGER_CONFIG_FAILED', err?.message || 'Không thể tải cấu hình Meta Messenger.');
  }
});

socialBotRouter.put('/messenger-config', requirePermission('mkt_social_bot', 'edit'), async (req, res) => {
  try {
    const ctx = getTenantContext();
    const bodyObj = (req.body && typeof req.body === 'object' ? req.body : {}) as Record<string, unknown>;
    const rawPages = Array.isArray(bodyObj.pages)
      ? (bodyObj.pages as Array<Record<string, unknown>>)
      : bodyObj.page_id
        ? [bodyObj]
        : [];

    if (rawPages.length === 0) {
      sendApiError(res, 422, 'MESSENGER_PAGES_REQUIRED', 'Vui lòng cung cấp ít nhất 1 Facebook Page để cấu hình.');
      return;
    }

    const saved = await withTenantTransaction(ctx.tenantId, async (client) => {
      const existingRow = await client.query<{
        config_encrypted: string;
        iv: string;
        auth_tag: string;
      }>(
        `SELECT config_encrypted, iv, auth_tag
         FROM tenant_integrations
         WHERE tenant_id = $1 AND integration_type = 'meta_messenger'
         LIMIT 1`,
        [ctx.tenantId]
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
      const prevPages = extractMetaPageConfigs(prevDecrypted);
      const isPlaceholder = (v: unknown): boolean => {
        if (typeof v !== 'string') return false;
        const trimmed = v.trim();
        return trimmed === '' || trimmed === '__KEEP_EXISTING__' || trimmed.includes('••••') || trimmed.includes('***');
      };

      const normalizedPages = rawPages
        .map((raw) => {
          const pageId = String(raw.page_id || raw.id || '').trim();
          if (!pageId) return null;
          const prev = prevPages.find((p) => p.page_id === pageId);
          const nextToken = isPlaceholder(raw.page_access_token)
            ? prev?.page_access_token || ''
            : String(raw.page_access_token || '').trim();
          const nextSecret = isPlaceholder(raw.app_secret)
            ? prev?.app_secret || ''
            : String(raw.app_secret || '').trim();
          const nextVerify = isPlaceholder(raw.verify_token)
            ? prev?.verify_token || ''
            : String(raw.verify_token || '').trim();
          return {
            page_id: pageId,
            page_name: String(raw.page_name || prev?.page_name || `Page ${pageId}`).trim(),
            app_id: String(raw.app_id ?? prev?.app_id ?? '').trim(),
            page_access_token: nextToken,
            app_secret: nextSecret,
            verify_token: nextVerify,
            status: String(raw.status || prev?.status || 'active').trim(),
            mode: String(raw.mode || prev?.mode || 'live').trim(),
          };
        })
        .filter((p): p is NonNullable<typeof p> => Boolean(p));

      if (normalizedPages.length === 0) {
        return null;
      }

      const payload = {
        pages: normalizedPages,
        page_id: normalizedPages[0].page_id,
        page_access_token: normalizedPages[0].page_access_token,
        app_secret: normalizedPages[0].app_secret,
        verify_token: normalizedPages[0].verify_token,
      };
      const encrypted = encryptTenantSecret(ctx.tenantId, payload);

      await client.query(
        `INSERT INTO tenant_integrations (
           tenant_id, integration_type, config_encrypted, iv, auth_tag, status, last_synced_at
         ) VALUES ($1, 'meta_messenger', $2, $3, $4, 'active', clock_timestamp())
         ON CONFLICT (tenant_id, integration_type) DO UPDATE SET
           config_encrypted = EXCLUDED.config_encrypted,
           iv = EXCLUDED.iv,
           auth_tag = EXCLUDED.auth_tag,
           status = 'active',
           last_synced_at = clock_timestamp()`,
        [ctx.tenantId, encrypted.configEncrypted, encrypted.iv, encrypted.authTag]
      );

      return normalizedPages.map((p) => ({
        page_id: p.page_id,
        page_name: p.page_name,
        app_id: p.app_id,
        page_access_token_masked: maskSecretValue(p.page_access_token),
        has_page_access_token: Boolean(p.page_access_token),
        app_secret_masked: maskSecretValue(p.app_secret),
        has_app_secret: Boolean(p.app_secret),
        verify_token_masked: maskSecretValue(p.verify_token),
        has_verify_token: Boolean(p.verify_token),
        status: p.status,
        mode: p.mode,
      }));
    });

    if (!saved) {
      sendApiError(res, 422, 'INVALID_MESSENGER_PAGES', 'Thiếu page_id hợp lệ trong cấu hình Meta Messenger.');
      return;
    }

    tenantRedis.invalidateTenantIntegrations(ctx.tenantId, 'meta_messenger');
    res.json({
      success: true,
      data: {
        configured: true,
        provider: 'meta_messenger',
        pages: saved,
      },
    });
  } catch (err: any) {
    sendApiError(res, 500, 'SAVE_MESSENGER_CONFIG_FAILED', err?.message || 'Không thể lưu cấu hình Meta Messenger.');
  }
});

// Test AI Bot Studio Reply & Phone/Email Extraction
socialBotRouter.post('/bot-test', requirePermission('mkt_social_bot', 'view'), async (req, res) => {
  try {
    const ctx = getTenantContext();
    const message = String(req.body?.message || '').trim();
    const channel = ['messenger', 'zalo_oa', 'web_chat'].includes(String(req.body?.channel || ''))
      ? String(req.body.channel)
      : 'web_chat';
    if (!message) {
      sendApiError(res, 422, 'MESSAGE_REQUIRED', 'Vui lòng nhập tin nhắn khách hàng để kiểm thử AI Bot.');
      return;
    }

    const data = await withTenantTransaction(ctx.tenantId, async (client) => {
      const botRow = await getOrCreateTenantBotConfig(client, ctx.tenantId);
      const botCfg = mapBotConfig(botRow);
      const extracted = extractContactEntitiesFromText(message);
      const rag = await resolveBotReplyInTx(client, ctx.tenantId, channel, message, botCfg, extracted);
      return {
        bot_name: botCfg.bot_name,
        extracted_entities: extracted,
        matched_question: rag.matchedQuestion,
        scenario_id: rag.scenarioId,
        reply: rag.reply,
      };
    });

    res.json({ success: true, data });
  } catch (err: any) {
    sendApiError(res, 500, 'BOT_TEST_FAILED', err?.message || 'Không thể chạy thử phản hồi AI Bot.');
  }
});

// Get Conversation Messages + Customer 360° Timeline Drawer
socialBotRouter.get('/conversations/:id', requirePermission('mkt_social_bot', 'view'), async (req, res) => {
  try {
    const ctx = getTenantContext();
    const cfg = await getTenantSettingsCached(ctx.tenantId);

    const data = await withTenantTransaction(ctx.tenantId, async (client) => {
      const convRes = await client.query(
        'SELECT * FROM mkt_social_conversations WHERE tenant_id = $1 AND id = $2 LIMIT 1',
        [ctx.tenantId, req.params.id]
      );
      const conv = convRes.rows[0];
      if (!conv) return null;

      const canUnmask = await canUserUnmaskMarketingPii(client, ctx.tenantId, ctx.userId);
      const msgsRes = await client.query(
        `SELECT * FROM mkt_social_messages
         WHERE tenant_id = $1 AND conversation_id = $2
         ORDER BY created_at ASC
         LIMIT 200`,
        [ctx.tenantId, conv.id]
      );

      let customer360: Record<string, unknown> | null = null;
      let timeline: Array<Record<string, unknown>> = [];

      if (conv.lead_id) {
        const [leadRes, tlRes, tagsRes] = await Promise.all([
          client.query(
            `SELECT l.*, s.stage_name
             FROM leads l
             LEFT JOIN tenant_pipeline_stages s ON s.tenant_id = l.tenant_id AND s.id = l.stage_id
             WHERE l.tenant_id = $1 AND l.id = $2
             LIMIT 1`,
            [ctx.tenantId, conv.lead_id]
          ),
          client.query(
            `SELECT id, event_type, event_category, title, content, created_at
             FROM lead_timeline_events
             WHERE tenant_id = $1 AND lead_id = $2
             ORDER BY created_at DESC
             LIMIT 30`,
            [ctx.tenantId, conv.lead_id]
          ),
          client.query<{ name: string; color_hex: string }>(
            `SELECT tt.name, tt.color_hex
             FROM lead_tags lt
             INNER JOIN tenant_tags tt ON tt.tenant_id = lt.tenant_id AND tt.id = lt.tag_id
             WHERE lt.tenant_id = $1 AND lt.lead_id = $2`,
            [ctx.tenantId, conv.lead_id]
          ),
        ]);

        if (leadRes.rows[0]) {
          customer360 = {
            ...maskContactPiiIfDisallowed(leadRes.rows[0], canUnmask, cfg),
            tags: tagsRes.rows,
          };
        }
        timeline = tlRes.rows;
      }

      const handoffMap = await readHandoffStateMap(client, ctx.tenantId);
      return {
        conversation: hydrateConversationHandoff(conv, handoffMap),
        messages: msgsRes.rows.map((m) => ({
          ...m,
          extracted_entities: parseJsonCol(m.extracted_entities, {}),
        })),
        customer_360: customer360,
        timeline,
      };
    });

    if (!data) {
      sendApiError(res, 404, 'CONVERSATION_NOT_FOUND', 'Không tìm thấy hội thoại.');
      return;
    }
    res.json({ success: true, data });
  } catch (err: any) {
    sendApiError(res, 500, 'GET_CONVERSATION_FAILED', err?.message || 'Không thể tải chi tiết hội thoại & Hồ sơ 360°.');
  }
});

// Ingest / Simulate Customer Chat or Send Agent Reply (with Auto Phone/Email Extraction & Auto Routing)
socialBotRouter.post('/conversations', requirePermission('mkt_social_bot', 'create'), async (req, res) => {
  try {
    const ctx = getTenantContext();
    const cfg = await getTenantSettingsCached(ctx.tenantId);
    const channel =
      req.body?.channel === 'zalo_oa'
        ? 'zalo_oa'
        : req.body?.channel === 'web_chat'
          ? 'web_chat'
          : 'messenger';
    const customerName = String(req.body?.customer_name || 'Khách hàng Mới').trim();
    const externalThreadId = String(req.body?.external_thread_id || `th_${crypto.randomBytes(6).toString('hex')}`).trim();
    const content = String(req.body?.content || req.body?.message || '').trim();
    if (!content) {
      sendApiError(res, 422, 'MESSAGE_REQUIRED', 'Vui lòng nhập nội dung tin nhắn.');
      return;
    }

    let drainAfterCommit = false;
    let enteredAudienceId: string | null = null;
    const out = await withTenantTransaction(ctx.tenantId, async (client) => {
      const botRow = await getOrCreateTenantBotConfig(client, ctx.tenantId);
      const botCfg = mapBotConfig(botRow);
      const extracted = extractContactEntitiesFromText(content);

      const convCandidateId = crypto.randomUUID();
      await client.query(
        `INSERT INTO mkt_social_conversations (
           id, tenant_id, channel, external_thread_id, customer_name,
           extracted_phone, extracted_email, last_message_preview, unread_count
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 1)
         ON CONFLICT (tenant_id, channel, external_thread_id) DO UPDATE SET
           extracted_phone = COALESCE(EXCLUDED.extracted_phone, mkt_social_conversations.extracted_phone),
           extracted_email = COALESCE(EXCLUDED.extracted_email, mkt_social_conversations.extracted_email),
           last_message_preview = EXCLUDED.last_message_preview,
           last_message_at = clock_timestamp()`,
        [
          convCandidateId,
          ctx.tenantId,
          channel,
          externalThreadId,
          customerName,
          extracted.phone,
          extracted.email,
          content.slice(0, 200),
        ]
      );

      const convRes = await client.query(
        `SELECT * FROM mkt_social_conversations
         WHERE tenant_id = $1 AND channel = $2 AND external_thread_id = $3
         LIMIT 1`,
        [ctx.tenantId, channel, externalThreadId]
      );
      const conv = convRes.rows[0];
      const webhookEventId = String(req.body?.webhook_event_id || req.body?.external_message_id || '').trim();
      const duplicateWebhook =
        webhookEventId !== '' &&
        isDuplicateWebhookEvent(`${ctx.tenantId}:${channel}:${externalThreadId}:${webhookEventId}`);

      if (duplicateWebhook) {
        const handoffMap = await readHandoffStateMap(client, ctx.tenantId);
        const hydratedConv = hydrateConversationHandoff(conv, handoffMap);
        return {
          conversation_id: String(conv.id),
          channel,
          lead_id: conv.lead_id ? String(conv.lead_id) : null,
          extracted_entities: extracted,
          bot_reply: null,
          bot_paused: Boolean(conv.bot_paused),
          bot_suppressed_reason: 'duplicate_webhook_event',
          deduplicated: true,
          matched_question: null,
          scenario_id: null,
          assigned_agent_id: hydratedConv.assigned_agent_id,
          handoff_reason: hydratedConv.handoff_reason,
          handoff_at: hydratedConv.handoff_at,
        };
      }

      // Save customer message
      await client.query(
        `INSERT INTO mkt_social_messages (id, tenant_id, conversation_id, sender_type, sender_name, content, extracted_entities)
         VALUES ($1, $2, $3, 'customer', $4, $5, $6::jsonb)`,
        [crypto.randomUUID(), ctx.tenantId, conv.id, customerName, content, JSON.stringify(extracted)]
      );

      // Auto Contact Capture -> Master Contact + Audience / Sale Round!
      let leadId: string | null = conv.lead_id ? String(conv.lead_id) : null;
      if (botCfg.auto_extract_contact && (extracted.phone || extracted.email)) {
        const defaultStatus = botCfg.routing_mode === 'sale_round' ? 'unassigned_pending' : 'marketing_nurture';
        const upserted = await upsertMasterContactInTx(
          client,
          ctx.tenantId,
          {
            name: customerName,
            phone: extracted.phone || conv.extracted_phone,
            email: extracted.email || conv.extracted_email,
          },
          {
            defaultStatus,
            defaultSource: `Social Inbox (${channel})`,
            dialCode: cfg.default_dial_code,
          }
        );
        leadId = upserted.leadId;

        await client.query(
          'UPDATE mkt_social_conversations SET lead_id = $3, status = $4 WHERE tenant_id = $1 AND id = $2',
          [
            ctx.tenantId,
            conv.id,
            leadId,
            botCfg.routing_mode === 'sale_round' ? 'routed_to_sale' : 'open',
          ]
        );

        if (botCfg.target_audience_id) {
          const insAud = await client.query(
            `INSERT INTO tenant_audience_members (id, tenant_id, audience_id, lead_id, source_type, metadata)
             VALUES ($1, $2, $3, $4, 'social_bot', '{}'::jsonb)
             ON CONFLICT (tenant_id, audience_id, lead_id) DO NOTHING`,
            [crypto.randomUUID(), ctx.tenantId, botCfg.target_audience_id, leadId]
          );
          if ((insAud.rowCount || 0) > 0) {
            enteredAudienceId = String(botCfg.target_audience_id);
          }
          await refreshAudienceCachedCount(client, ctx.tenantId, botCfg.target_audience_id);
        }

        if (botCfg.routing_mode === 'sale_round') {
          const promoted = await promoteLeadsToSaleRoundInTx(client, ctx.tenantId, [leadId], {
            roundId: botCfg.distribution_round_id,
            actorId: ctx.userId,
            actorName: botCfg.bot_name,
            reasonTitle: `Thu thập SĐT/Email tự động từ ${channel.toUpperCase()} (${botCfg.bot_name})`,
          });
          if (promoted.length > 0 || defaultStatus === 'unassigned_pending') {
            drainAfterCommit = true;
          }
        }
      }

      // Generate AI Bot reply ONLY when active, NOT paused by human takeover, and channel enabled!
      let botReply: string | null = null;
      let matchedQuestion: string | null = null;
      let scenarioId: string | null = null;
      let botSuppressedReason: string | null = null;
      const isConvPaused = Boolean(conv.bot_paused);
      const channelEnabled = botCfg.channels.includes(channel);

      if (isConvPaused) {
        botSuppressedReason = 'human_takeover_paused';
      } else if (!botCfg.is_active) {
        botSuppressedReason = 'bot_globally_disabled';
      } else if (!channelEnabled) {
        botSuppressedReason = 'channel_disabled';
      } else {
        const rag = await resolveBotReplyInTx(client, ctx.tenantId, channel, content, botCfg, extracted);
        botReply = rag.reply;
        matchedQuestion = rag.matchedQuestion;
        scenarioId = rag.scenarioId;
        await client.query(
          `INSERT INTO mkt_social_messages (id, tenant_id, conversation_id, sender_type, sender_name, content, extracted_entities)
           VALUES ($1, $2, $3, 'bot', $4, $5, '{}'::jsonb)`,
          [crypto.randomUUID(), ctx.tenantId, conv.id, botCfg.bot_name, botReply]
        );
      }

      const handoffMap = await readHandoffStateMap(client, ctx.tenantId);
      const hydratedConv = hydrateConversationHandoff(conv, handoffMap);

      return {
        conversation_id: String(conv.id),
        channel,
        lead_id: leadId,
        extracted_entities: extracted,
        bot_reply: botReply,
        bot_paused: isConvPaused,
        bot_suppressed_reason: botSuppressedReason,
        matched_question: matchedQuestion,
        scenario_id: scenarioId,
        assigned_agent_id: hydratedConv.assigned_agent_id,
        handoff_reason: hydratedConv.handoff_reason,
        handoff_at: hydratedConv.handoff_at,
      };
    });

    if (drainAfterCommit) {
      await runUnassignedLeadDrainer(ctx.tenantId).catch(() => {});
    }
    if (enteredAudienceId && out.lead_id) {
      await emitDomainEvent('audience.entered', {
        tenantId: ctx.tenantId,
        audienceId: enteredAudienceId,
        audienceName: 'Social Inbox Audience',
        audienceType: 'static_list',
        leadId: out.lead_id,
      });
    }
    if (out.lead_id) {
      await emitDomainEvent('marketing.engaged', {
        tenantId: ctx.tenantId,
        leadId: out.lead_id,
        engagementType: 'webhook_received',
        channel: 'social',
        scoreDelta: 10,
      });
    }

    res.status(201).json({ success: true, data: out });
  } catch (err: any) {
    sendApiError(res, 500, 'SOCIAL_MESSAGE_INGEST_FAILED', err?.message || 'Không thể ghi nhận tin nhắn Social.');
  }
});

// Send Human Agent Reply inside Unified Inbox
socialBotRouter.post('/conversations/:id/messages', requirePermission('mkt_social_bot', 'create'), async (req, res) => {
  try {
    const ctx = getTenantContext();
    const content = String(req.body?.content || '').trim();
    const senderType = req.body?.sender_type === 'customer' ? 'customer' : 'agent';
    if (!content) {
      sendApiError(res, 422, 'CONTENT_REQUIRED', 'Vui lòng nhập nội dung phản hồi.');
      return;
    }

    const msg = await withTenantTransaction(ctx.tenantId, async (client) => {
      const convRes = await client.query(
        'SELECT * FROM mkt_social_conversations WHERE tenant_id = $1 AND id = $2 LIMIT 1',
        [ctx.tenantId, req.params.id]
      );
      const conv = convRes.rows[0];
      if (!conv) return null;

      let delivery: Record<string, unknown> | null = null;
      if (senderType === 'agent' && conv.channel === 'messenger' && conv.external_thread_id) {
        const sendRes = await sendMetaMessengerMessage({
          tenantId: ctx.tenantId,
          client,
          recipientPsid: String(conv.external_thread_id),
          text: content,
          messagingType: 'RESPONSE',
        });
        delivery = {
          sent: sendRes.sent,
          queued: Boolean(sendRes.queued),
          silent: Boolean(sendRes.silent),
          provider: sendRes.provider,
          external_message_id: sendRes.messageId,
          ...(sendRes.error ? { error: sendRes.error } : {}),
        };
      }

      const extracted = senderType === 'customer' ? extractContactEntitiesFromText(content) : { phone: null, email: null };
      const msgId = crypto.randomUUID();
      await client.query(
        `INSERT INTO mkt_social_messages (id, tenant_id, conversation_id, sender_type, sender_name, content, extracted_entities)
         VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb)`,
        [
          msgId,
          ctx.tenantId,
          req.params.id,
          senderType,
          senderType === 'agent' ? ctx.userName || 'Chuyên viên CSKH' : conv.customer_name,
          content,
          JSON.stringify(extracted),
        ]
      );

      const shouldAutoPause = senderType === 'agent' && req.body?.auto_pause_bot !== false;
      await client.query(
        `UPDATE mkt_social_conversations
         SET last_message_preview = $3,
             extracted_phone = COALESCE($4, extracted_phone),
             extracted_email = COALESCE($5, extracted_email),
             unread_count = CASE WHEN $6 = 0 THEN 0 ELSE unread_count + 1 END,
             bot_paused = CASE WHEN $7 = true THEN true ELSE bot_paused END,
             last_message_at = clock_timestamp()
         WHERE tenant_id = $1 AND id = $2`,
        [
          ctx.tenantId,
          req.params.id,
          content.slice(0, 200),
          extracted.phone,
          extracted.email,
          senderType === 'agent' ? 0 : 1,
          shouldAutoPause,
        ]
      );

      let handoffState: ConversationHandoffState | null = null;
      if (shouldAutoPause) {
        handoffState = await writeConversationHandoffState(client, ctx.tenantId, String(conv.id), {
          assigned_agent_id: ctx.userId,
          assigned_agent_name: ctx.userName || 'Chuyên viên CSKH',
          handoff_reason: String(req.body?.handoff_reason || 'Human agent manual reply takeover'),
          handoff_at: new Date().toISOString(),
          channel: String(conv.channel),
        });
      }

      // If a customer sends a follow-up message on an existing thread, evaluate AI/scenario auto-reply respecting bot_paused!
      let botReply: string | null = null;
      let botSuppressedReason: string | null = null;
      let scenarioId: string | null = null;
      if (senderType === 'customer') {
        const botRow = await getOrCreateTenantBotConfig(client, ctx.tenantId);
        const botCfg = mapBotConfig(botRow);
        if (Boolean(conv.bot_paused)) {
          botSuppressedReason = 'human_takeover_paused';
        } else if (!botCfg.is_active) {
          botSuppressedReason = 'bot_globally_disabled';
        } else if (!botCfg.channels.includes(String(conv.channel))) {
          botSuppressedReason = 'channel_disabled';
        } else {
          const rag = await resolveBotReplyInTx(client, ctx.tenantId, String(conv.channel), content, botCfg, extracted);
          botReply = rag.reply;
          scenarioId = rag.scenarioId;
          await client.query(
            `INSERT INTO mkt_social_messages (id, tenant_id, conversation_id, sender_type, sender_name, content, extracted_entities)
             VALUES ($1, $2, $3, 'bot', $4, $5, '{}'::jsonb)`,
            [crypto.randomUUID(), ctx.tenantId, conv.id, botCfg.bot_name, botReply]
          );
        }
      }

      const r = await client.query('SELECT * FROM mkt_social_messages WHERE tenant_id = $1 AND id = $2', [
        ctx.tenantId,
        msgId,
      ]);
      return {
        ...r.rows[0],
        bot_paused: shouldAutoPause ? true : Boolean(conv.bot_paused),
        bot_reply: botReply,
        bot_suppressed_reason: botSuppressedReason,
        scenario_id: scenarioId,
        ...(handoffState ? { handoff: handoffState } : {}),
        ...(delivery ? { delivery } : {}),
      };
    });

    if (!msg) {
      sendApiError(res, 404, 'CONVERSATION_NOT_FOUND', 'Không tìm thấy hội thoại.');
      return;
    }
    res.status(201).json({ success: true, data: msg });
  } catch (err: any) {
    sendApiError(res, 500, 'SEND_SOCIAL_REPLY_FAILED', err?.message || 'Không thể gửi tin nhắn phản hồi.');
  }
});

// 1-Click Push Extracted Chat Contact to `tenant_audiences` or Auto Data Sale Round
socialBotRouter.post('/conversations/:id/push-lead', requirePermission('mkt_social_bot', 'edit'), async (req, res) => {
  try {
    const ctx = getTenantContext();
    const cfg = await getTenantSettingsCached(ctx.tenantId);
    const mode = req.body?.mode === 'sale_round' ? 'sale_round' : 'audience';
    const audienceId = req.body?.audience_id ? String(req.body.audience_id) : null;
    const roundId = req.body?.round_id ? String(req.body.round_id) : null;

    let drainAfterCommit = false;
    let enteredAudienceId: string | null = null;
    const out = await withTenantTransaction(ctx.tenantId, async (client) => {
      const convRes = await client.query(
        'SELECT * FROM mkt_social_conversations WHERE tenant_id = $1 AND id = $2 LIMIT 1',
        [ctx.tenantId, req.params.id]
      );
      const conv = convRes.rows[0];
      if (!conv) return { err: 'NOT_FOUND' as const };

      const phone = req.body?.phone ? String(req.body.phone).trim() : conv.extracted_phone;
      const email = req.body?.email ? String(req.body.email).trim() : conv.extracted_email;
      if (!phone && !email) {
        return { err: 'MISSING_CONTACT' as const };
      }

      const defaultStatus = mode === 'sale_round' ? 'unassigned_pending' : 'marketing_nurture';
      const upserted = await upsertMasterContactInTx(
        client,
        ctx.tenantId,
        {
          name: req.body?.name || conv.customer_name,
          phone,
          email,
        },
        {
          defaultStatus,
          defaultSource: `Social Inbox (${conv.channel})`,
          dialCode: cfg.default_dial_code,
        }
      );

      await client.query(
        `UPDATE mkt_social_conversations
         SET lead_id = $3,
             extracted_phone = COALESCE($4, extracted_phone),
             extracted_email = COALESCE($5, extracted_email),
             status = $6
         WHERE tenant_id = $1 AND id = $2`,
        [
          ctx.tenantId,
          conv.id,
          upserted.leadId,
          phone || null,
          email || null,
          mode === 'sale_round' ? 'routed_to_sale' : 'open',
        ]
      );

      if (audienceId) {
        const insAud = await client.query(
          `INSERT INTO tenant_audience_members (id, tenant_id, audience_id, lead_id, source_type, metadata)
           VALUES ($1, $2, $3, $4, 'social_inbox', '{}'::jsonb)
           ON CONFLICT (tenant_id, audience_id, lead_id) DO NOTHING`,
          [crypto.randomUUID(), ctx.tenantId, audienceId, upserted.leadId]
        );
        if ((insAud.rowCount || 0) > 0) {
          enteredAudienceId = audienceId;
        }
        await refreshAudienceCachedCount(client, ctx.tenantId, audienceId);
      }

      if (mode === 'sale_round') {
        await promoteLeadsToSaleRoundInTx(client, ctx.tenantId, [upserted.leadId], {
          roundId,
          actorId: ctx.userId,
          actorName: ctx.userName || 'Social Inbox',
          reasonTitle: `Đẩy 1 chạm từ Hộp thư ${conv.channel.toUpperCase()} sang Vòng chia Sale Auto Data`,
        });
        drainAfterCommit = true;
      }

      return { err: null, lead_id: upserted.leadId, mode };
    });

    if (out.err === 'NOT_FOUND') {
      sendApiError(res, 404, 'CONVERSATION_NOT_FOUND', 'Không tìm thấy hội thoại.');
      return;
    }
    if (out.err === 'MISSING_CONTACT') {
      sendApiError(res, 422, 'CONTACT_REQUIRED', 'Chưa trích xuất được SĐT hoặc Email từ hội thoại này.');
      return;
    }

    if (drainAfterCommit) {
      await runUnassignedLeadDrainer(ctx.tenantId).catch(() => {});
    }
    if (enteredAudienceId && out.lead_id) {
      await emitDomainEvent('audience.entered', {
        tenantId: ctx.tenantId,
        audienceId: enteredAudienceId,
        audienceName: 'Social Inbox Audience',
        audienceType: 'static_list',
        leadId: out.lead_id,
      });
    }

    res.json({ success: true, data: out });
  } catch (err: any) {
    sendApiError(res, 500, 'PUSH_SOCIAL_LEAD_FAILED', err?.message || 'Không thể đẩy hồ sơ từ hộp thư Social.');
  }
});

// UnifiedChat: Toggle Human Takeover (`bot_paused`), Status (`open|resolved`) & Mark Read
socialBotRouter.patch('/conversations/:id', requirePermission('mkt_social_bot', 'edit'), async (req, res) => {
  try {
    const ctx = getTenantContext();
    const updated = await withTenantTransaction(ctx.tenantId, async (client) => {
      const exRes = await client.query(
        'SELECT * FROM mkt_social_conversations WHERE tenant_id = $1 AND id = $2 LIMIT 1',
        [ctx.tenantId, req.params.id]
      );
      const ex = exRes.rows[0];
      if (!ex) return null;

      const botPaused =
        req.body?.bot_paused !== undefined ? Boolean(req.body.bot_paused) : Boolean(ex.bot_paused);
      const status =
        req.body?.status !== undefined ? String(req.body.status) : String(ex.status || 'open');
      const unreadCount =
        req.body?.mark_read === true
          ? 0
          : req.body?.unread_count !== undefined
            ? Math.max(0, Number(req.body.unread_count))
            : Number(ex.unread_count || 0);

      await client.query(
        `UPDATE mkt_social_conversations
         SET bot_paused = $3, status = $4, unread_count = $5
         WHERE tenant_id = $1 AND id = $2`,
        [ctx.tenantId, req.params.id, botPaused, status, unreadCount]
      );

      if (req.body?.bot_paused !== undefined) {
        if (botPaused) {
          await writeConversationHandoffState(client, ctx.tenantId, String(ex.id), {
            assigned_agent_id: req.body?.assigned_agent_id ? String(req.body.assigned_agent_id) : ctx.userId,
            assigned_agent_name: req.body?.assigned_agent_name
              ? String(req.body.assigned_agent_name)
              : ctx.userName || 'Chuyên viên CSKH',
            handoff_reason: String(req.body?.handoff_reason || 'Human agent takeover').trim(),
            handoff_at: new Date().toISOString(),
            channel: String(ex.channel || 'messenger'),
          });
        } else {
          await writeConversationHandoffState(client, ctx.tenantId, String(ex.id), null);
        }
      }

      const [r, handoffMap] = await Promise.all([
        client.query('SELECT * FROM mkt_social_conversations WHERE tenant_id = $1 AND id = $2', [
          ctx.tenantId,
          req.params.id,
        ]),
        readHandoffStateMap(client, ctx.tenantId),
      ]);
      return hydrateConversationHandoff(r.rows[0], handoffMap);
    });

    if (!updated) {
      sendApiError(res, 404, 'CONVERSATION_NOT_FOUND', 'Không tìm thấy hội thoại.');
      return;
    }
    res.json({ success: true, data: updated });
  } catch (err: any) {
    sendApiError(res, 500, 'UPDATE_CONVERSATION_FAILED', err?.message || 'Không thể cập nhật trạng thái hội thoại.');
  }
});

// ScenarioCanvas & MetaScenarioModal (`mkt_automation_scenarios`) CRUD
function mapScenarioRow(row: Record<string, unknown>) {
  return {
    ...row,
    keywords: parseJsonCol<string[]>(row.keywords_json, []),
    nodes: parseJsonCol<Array<Record<string, unknown>>>(row.nodes_json, []),
    edges: parseJsonCol<Array<Record<string, unknown>>>(row.edges_json, []),
    settings: parseJsonCol<Record<string, unknown>>(row.settings_json, {}),
    is_active: Boolean(row.is_active),
    matched_count: Number(row.matched_count || 0),
    converted_count: Number(row.converted_count || 0),
  };
}

socialBotRouter.get('/scenarios', requirePermission('mkt_social_bot', 'view'), async (_req, res) => {
  try {
    const ctx = getTenantContext();
    const items = await withTenantTransaction(ctx.tenantId, async (client) => {
      const r = await client.query(
        'SELECT * FROM mkt_automation_scenarios WHERE tenant_id = $1 ORDER BY updated_at DESC',
        [ctx.tenantId]
      );
      return r.rows.map(mapScenarioRow);
    });
    res.json({ success: true, data: { items } });
  } catch (err: any) {
    sendApiError(res, 500, 'LIST_SCENARIOS_FAILED', err?.message || 'Không thể tải danh sách kịch bản Chatbot.');
  }
});

socialBotRouter.post('/scenarios', requirePermission('mkt_social_bot', 'create'), async (req, res) => {
  try {
    const ctx = getTenantContext();
    const name = String(req.body?.name || '').trim();
    if (!name) {
      sendApiError(res, 422, 'SCENARIO_NAME_REQUIRED', 'Vui lòng nhập tên kịch bản tự động.');
      return;
    }

    const channel = ['messenger', 'zalo_oa', 'web_chat', 'omnichannel'].includes(String(req.body?.channel || ''))
      ? String(req.body.channel)
      : 'messenger';
    const triggerType = String(req.body?.trigger_type || 'keyword').trim();
    const keywords = Array.isArray(req.body?.keywords) ? req.body.keywords.map(String) : [];
    const nodes = Array.isArray(req.body?.nodes) ? req.body.nodes : [];
    const edges = Array.isArray(req.body?.edges) ? req.body.edges : [];
    const settings = req.body?.settings && typeof req.body.settings === 'object' ? req.body.settings : {};
    const isActive = req.body?.is_active !== undefined ? Boolean(req.body.is_active) : true;
    const id = crypto.randomUUID();

    const created = await withTenantTransaction(ctx.tenantId, async (client) => {
      const conflicts = await detectScenarioConflicts(client, ctx.tenantId, {
        channel,
        triggerType,
        keywords,
        isActive,
      });
      await client.query(
        `INSERT INTO mkt_automation_scenarios (
           id, tenant_id, name, channel, trigger_type, keywords_json, nodes_json, edges_json, settings_json, is_active, created_by
         ) VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7::jsonb, $8::jsonb, $9::jsonb, $10, $11)`,
        [
          id,
          ctx.tenantId,
          name,
          channel,
          triggerType,
          JSON.stringify(keywords),
          JSON.stringify(nodes),
          JSON.stringify(edges),
          JSON.stringify(settings),
          isActive,
          ctx.userId,
        ]
      );
      const r = await client.query('SELECT * FROM mkt_automation_scenarios WHERE tenant_id = $1 AND id = $2', [
        ctx.tenantId,
        id,
      ]);
      return { ...mapScenarioRow(r.rows[0]), conflict_warnings: conflicts };
    });

    res.status(201).json({ success: true, data: created });
  } catch (err: any) {
    sendApiError(res, 500, 'CREATE_SCENARIO_FAILED', err?.message || 'Không thể tạo kịch bản tự động.');
  }
});

socialBotRouter.put('/scenarios/:id', requirePermission('mkt_social_bot', 'edit'), async (req, res) => {
  try {
    const ctx = getTenantContext();
    const updated = await withTenantTransaction(ctx.tenantId, async (client) => {
      const exRes = await client.query(
        'SELECT * FROM mkt_automation_scenarios WHERE tenant_id = $1 AND id = $2 LIMIT 1',
        [ctx.tenantId, req.params.id]
      );
      const ex = exRes.rows[0];
      if (!ex) return null;

      const name = req.body?.name !== undefined ? String(req.body.name).trim() : String(ex.name);
      const channel = req.body?.channel !== undefined ? String(req.body.channel) : String(ex.channel);
      const triggerType =
        req.body?.trigger_type !== undefined ? String(req.body.trigger_type) : String(ex.trigger_type);
      const keywords = Array.isArray(req.body?.keywords)
        ? req.body.keywords.map(String)
        : parseJsonCol(ex.keywords_json, []);
      const nodes = Array.isArray(req.body?.nodes) ? req.body.nodes : parseJsonCol(ex.nodes_json, []);
      const edges = Array.isArray(req.body?.edges) ? req.body.edges : parseJsonCol(ex.edges_json, []);
      const settings =
        req.body?.settings && typeof req.body.settings === 'object'
          ? req.body.settings
          : parseJsonCol(ex.settings_json, {});
      const isActive =
        req.body?.is_active !== undefined ? Boolean(req.body.is_active) : Boolean(ex.is_active);

      const conflicts = await detectScenarioConflicts(client, ctx.tenantId, {
        id: req.params.id,
        channel,
        triggerType,
        keywords,
        isActive,
      });

      await client.query(
        `UPDATE mkt_automation_scenarios
         SET name = $3, channel = $4, trigger_type = $5,
             keywords_json = $6::jsonb, nodes_json = $7::jsonb, edges_json = $8::jsonb,
             settings_json = $9::jsonb, is_active = $10, updated_at = clock_timestamp()
         WHERE tenant_id = $1 AND id = $2`,
        [
          ctx.tenantId,
          req.params.id,
          name,
          channel,
          triggerType,
          JSON.stringify(keywords),
          JSON.stringify(nodes),
          JSON.stringify(edges),
          JSON.stringify(settings),
          isActive,
        ]
      );
      const r = await client.query('SELECT * FROM mkt_automation_scenarios WHERE tenant_id = $1 AND id = $2', [
        ctx.tenantId,
        req.params.id,
      ]);
      return { ...mapScenarioRow(r.rows[0]), conflict_warnings: conflicts };
    });

    if (!updated) {
      sendApiError(res, 404, 'SCENARIO_NOT_FOUND', 'Không tìm thấy kịch bản tự động.');
      return;
    }
    res.json({ success: true, data: updated });
  } catch (err: any) {
    sendApiError(res, 500, 'UPDATE_SCENARIO_FAILED', err?.message || 'Không thể cập nhật kịch bản tự động.');
  }
});

socialBotRouter.delete('/scenarios/:id', requirePermission('mkt_social_bot', 'delete'), async (req, res) => {
  try {
    const ctx = getTenantContext();
    await withTenantTransaction(ctx.tenantId, async (client) => {
      await client.query('DELETE FROM mkt_automation_scenarios WHERE tenant_id = $1 AND id = $2', [
        ctx.tenantId,
        req.params.id,
      ]);
    });
    res.json({ success: true, data: { deleted: true } });
  } catch (err: any) {
    sendApiError(res, 500, 'DELETE_SCENARIO_FAILED', err?.message || 'Không thể xóa kịch bản tự động.');
  }
});

// ZaloOAManager (`mkt_zalo_oa_configs`), ZaloTemplateCreateModal (`mkt_zalo_templates`) & ZaloBroadcastTab
socialBotRouter.get('/zalo-oa', requirePermission('mkt_social_bot', 'view'), async (_req, res) => {
  try {
    const ctx = getTenantContext();
    const data = await withTenantTransaction(ctx.tenantId, async (client) => {
      const r = await client.query('SELECT * FROM mkt_zalo_oa_configs WHERE tenant_id = $1 LIMIT 1', [
        ctx.tenantId,
      ]);
      if (r.rows[0]) {
        return {
          ...r.rows[0],
          settings: parseJsonCol(r.rows[0].settings_json, {}),
        };
      }
      const vault = await readTenantChannelVault(client, ctx.tenantId, ['zalo_oa', 'zalo_zns']);
      return {
        id: null,
        oa_id: String(vault.config.oa_id || ''),
        oa_name: String(vault.config.oa_name || 'Zalo Official Account'),
        app_id: String(vault.config.app_id || ''),
        status: vault.configured ? 'connected' : 'sandbox',
        daily_quota: 1000,
        sent_today: 0,
        quality_rating: 'high',
        settings: {},
      };
    });
    res.json({ success: true, data });
  } catch (err: any) {
    sendApiError(res, 500, 'GET_ZALO_OA_FAILED', err?.message || 'Không thể tải cấu hình Zalo OA.');
  }
});

socialBotRouter.put('/zalo-oa', requirePermission('mkt_social_bot', 'edit'), async (req, res) => {
  try {
    const ctx = getTenantContext();
    const oaId = String(req.body?.oa_id || '').trim();
    const oaName = String(req.body?.oa_name || 'Zalo Official Account').trim();
    const appId = String(req.body?.app_id || '').trim();
    const dailyQuota = Math.max(10, Math.round(Number(req.body?.daily_quota || 1000)));
    const qualityRating = String(req.body?.quality_rating || 'high');
    const status = String(req.body?.status || 'connected');
    const settings = req.body?.settings && typeof req.body.settings === 'object' ? req.body.settings : {};

    const saved = await withTenantTransaction(ctx.tenantId, async (client) => {
      await client.query(
        `INSERT INTO mkt_zalo_oa_configs (
           id, tenant_id, oa_id, oa_name, app_id, status, daily_quota, quality_rating, settings_json
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb)
         ON CONFLICT (tenant_id) DO UPDATE SET
           oa_id = EXCLUDED.oa_id,
           oa_name = EXCLUDED.oa_name,
           app_id = EXCLUDED.app_id,
           status = EXCLUDED.status,
           daily_quota = EXCLUDED.daily_quota,
           quality_rating = EXCLUDED.quality_rating,
           settings_json = EXCLUDED.settings_json,
           updated_at = clock_timestamp()`,
        [
          crypto.randomUUID(),
          ctx.tenantId,
          oaId,
          oaName,
          appId,
          status,
          dailyQuota,
          qualityRating,
          JSON.stringify(settings),
        ]
      );
      const r = await client.query('SELECT * FROM mkt_zalo_oa_configs WHERE tenant_id = $1 LIMIT 1', [
        ctx.tenantId,
      ]);
      return r.rows[0];
    });

    res.json({ success: true, data: saved });
  } catch (err: any) {
    sendApiError(res, 500, 'SAVE_ZALO_OA_FAILED', err?.message || 'Không thể lưu cấu hình Zalo OA.');
  }
});

socialBotRouter.get('/zalo-templates', requirePermission('mkt_social_bot', 'view'), async (_req, res) => {
  try {
    const ctx = getTenantContext();
    const items = await withTenantTransaction(ctx.tenantId, async (client) => {
      const r = await client.query(
        'SELECT * FROM mkt_zalo_templates WHERE tenant_id = $1 ORDER BY updated_at DESC',
        [ctx.tenantId]
      );
      return r.rows.map((row) => ({
        ...row,
        params_schema: parseJsonCol(row.params_schema_json, []),
        buttons: parseJsonCol(row.buttons_json, []),
      }));
    });
    res.json({ success: true, data: { items } });
  } catch (err: any) {
    sendApiError(res, 500, 'LIST_ZALO_TEMPLATES_FAILED', err?.message || 'Không thể tải danh sách mẫu Zalo ZNS/ZBS.');
  }
});

socialBotRouter.post('/zalo-templates', requirePermission('mkt_social_bot', 'create'), async (req, res) => {
  try {
    const ctx = getTenantContext();
    const name = String(req.body?.name || '').trim();
    if (!name) {
      sendApiError(res, 422, 'ZALO_TEMPLATE_NAME_REQUIRED', 'Vui lòng nhập tên mẫu Zalo ZNS/ZBS.');
      return;
    }

    const templateCode =
      String(req.body?.template_code || '').trim() || `ZNS_${crypto.randomInt(100000, 999999)}`;
    const templateType = ['zns_transaction', 'zns_otp', 'zns_promotion', 'zbs_broadcast'].includes(
      String(req.body?.template_type || '')
    )
      ? String(req.body.template_type)
      : 'zns_transaction';
    const status = String(req.body?.status || 'approved');
    const priceVnd = Math.max(0, Math.round(Number(req.body?.price_vnd ?? 250)));
    const contentBody = String(req.body?.content_body || '').trim();
    const paramsSchema = Array.isArray(req.body?.params_schema) ? req.body.params_schema : [];
    const buttons = Array.isArray(req.body?.buttons) ? req.body.buttons : [];
    const oaId = req.body?.oa_id ? String(req.body.oa_id) : null;
    const id = crypto.randomUUID();

    const created = await withTenantTransaction(ctx.tenantId, async (client) => {
      await client.query(
        `INSERT INTO mkt_zalo_templates (
           id, tenant_id, oa_id, template_code, name, template_type, status,
           price_vnd, content_body, params_schema_json, buttons_json, created_by
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb, $11::jsonb, $12)`,
        [
          id,
          ctx.tenantId,
          oaId,
          templateCode,
          name,
          templateType,
          status,
          priceVnd,
          contentBody,
          JSON.stringify(paramsSchema),
          JSON.stringify(buttons),
          ctx.userId,
        ]
      );
      const r = await client.query('SELECT * FROM mkt_zalo_templates WHERE tenant_id = $1 AND id = $2', [
        ctx.tenantId,
        id,
      ]);
      return {
        ...r.rows[0],
        params_schema: parseJsonCol(r.rows[0].params_schema_json, []),
        buttons: parseJsonCol(r.rows[0].buttons_json, []),
      };
    });

    res.status(201).json({ success: true, data: created });
  } catch (err: any) {
    sendApiError(res, 500, 'CREATE_ZALO_TEMPLATE_FAILED', err?.message || 'Không thể tạo mẫu Zalo ZNS/ZBS.');
  }
});

socialBotRouter.put('/zalo-templates/:id', requirePermission('mkt_social_bot', 'edit'), async (req, res) => {
  try {
    const ctx = getTenantContext();
    const updated = await withTenantTransaction(ctx.tenantId, async (client) => {
      const exRes = await client.query(
        'SELECT * FROM mkt_zalo_templates WHERE tenant_id = $1 AND id = $2 LIMIT 1',
        [ctx.tenantId, req.params.id]
      );
      const ex = exRes.rows[0];
      if (!ex) return null;

      const name = req.body?.name !== undefined ? String(req.body.name).trim() : String(ex.name);
      const contentBody =
        req.body?.content_body !== undefined ? String(req.body.content_body) : String(ex.content_body || '');
      const status = req.body?.status !== undefined ? String(req.body.status) : String(ex.status);
      const paramsSchema = Array.isArray(req.body?.params_schema)
        ? req.body.params_schema
        : parseJsonCol(ex.params_schema_json, []);
      const buttons = Array.isArray(req.body?.buttons)
        ? req.body.buttons
        : parseJsonCol(ex.buttons_json, []);

      await client.query(
        `UPDATE mkt_zalo_templates
         SET name = $3, content_body = $4, status = $5,
             params_schema_json = $6::jsonb, buttons_json = $7::jsonb, updated_at = clock_timestamp()
         WHERE tenant_id = $1 AND id = $2`,
        [
          ctx.tenantId,
          req.params.id,
          name,
          contentBody,
          status,
          JSON.stringify(paramsSchema),
          JSON.stringify(buttons),
        ]
      );
      const r = await client.query('SELECT * FROM mkt_zalo_templates WHERE tenant_id = $1 AND id = $2', [
        ctx.tenantId,
        req.params.id,
      ]);
      return r.rows[0];
    });

    if (!updated) {
      sendApiError(res, 404, 'ZALO_TEMPLATE_NOT_FOUND', 'Không tìm thấy mẫu Zalo.');
      return;
    }
    res.json({ success: true, data: updated });
  } catch (err: any) {
    sendApiError(res, 500, 'UPDATE_ZALO_TEMPLATE_FAILED', err?.message || 'Không thể cập nhật mẫu Zalo.');
  }
});

socialBotRouter.delete('/zalo-templates/:id', requirePermission('mkt_social_bot', 'delete'), async (req, res) => {
  try {
    const ctx = getTenantContext();
    await withTenantTransaction(ctx.tenantId, async (client) => {
      await client.query('DELETE FROM mkt_zalo_templates WHERE tenant_id = $1 AND id = $2', [
        ctx.tenantId,
        req.params.id,
      ]);
    });
    res.json({ success: true, data: { deleted: true } });
  } catch (err: any) {
    sendApiError(res, 500, 'DELETE_ZALO_TEMPLATE_FAILED', err?.message || 'Không thể xóa mẫu Zalo.');
  }
});

socialBotRouter.post('/zalo-broadcast', requirePermission('mkt_social_bot', 'create'), async (req, res) => {
  try {
    const ctx = getTenantContext();
    const templateId = String(req.body?.template_id || '').trim();
    const audienceId = req.body?.audience_id ? String(req.body.audience_id).trim() : null;
    const rawLeadIds: string[] = Array.isArray(req.body?.lead_ids) ? req.body.lead_ids.map(String) : [];

    if (audienceId && !UUID_REGEX.test(audienceId)) {
      sendApiError(res, 400, 'INVALID_AUDIENCE_ID', 'audience_id không hợp lệ.');
      return;
    }
    const validLeadIds = rawLeadIds.map((x) => x.trim()).filter((x) => UUID_REGEX.test(x));
    const rawRecipients: Array<{
      phone?: string;
      name?: string;
      lead_id?: string;
      template_data?: Record<string, unknown>;
    }> = Array.isArray(req.body?.recipients) ? req.body.recipients : [];
    if (rawLeadIds.length > 0 && validLeadIds.length === 0 && !audienceId && rawRecipients.length === 0) {
      sendApiError(res, 400, 'INVALID_LEAD_IDS', 'Danh sách lead_ids không hợp lệ.');
      return;
    }

    const outcome = await withTenantTransaction(ctx.tenantId, async (client) => {
      const [tplRes, supRes] = await Promise.all([
        templateId
          ? client.query(
              'SELECT * FROM mkt_zalo_templates WHERE tenant_id = $1 AND (id::text = $2 OR template_code = $2) LIMIT 1',
              [ctx.tenantId, templateId]
            )
          : Promise.resolve({ rows: [] as Array<Record<string, unknown>> }),
        client.query<{ recipient: string }>(
          "SELECT recipient FROM mkt_suppression_list WHERE tenant_id = $1 AND channel = 'zns'",
          [ctx.tenantId]
        ),
      ]);
      const tpl = tplRes.rows[0];
      const suppressedPhones = new Set<string>();
      for (const s of supRes.rows) {
        for (const k of getSuppressionMatchKeys('zns', String(s.recipient || ''))) {
          suppressedPhones.add(k);
        }
      }

      type BroadcastTarget = {
        id: string | null;
        name: string | null;
        phone: string;
        extraTemplateData?: Record<string, unknown>;
      };
      const targets: BroadcastTarget[] = [];

      let skippedSuppressed = 0;

      if (rawRecipients.length > 0 && !audienceId && validLeadIds.length === 0) {
        for (const rec of rawRecipients.slice(0, 200)) {
          const recPhone = String(rec?.phone || '').trim();
          if (!recPhone) continue;
          const phoneVariants = Array.from(
            new Set([recPhone, ...getSuppressionMatchKeys('zns', recPhone)].map((v) => v.toLowerCase()).filter(Boolean))
          );
          const ph = phoneVariants.map((_, idx) => `$${idx + 2}`).join(', ');
          const matchedRes = await client.query<{
            id: string;
            name: string | null;
            zns_consent: string | null;
          }>(
            `SELECT id, name, zns_consent FROM leads
             WHERE tenant_id = $1 AND is_deleted = false AND LOWER(COALESCE(phone, '')) IN (${ph})
             LIMIT 1`,
            [ctx.tenantId, ...phoneVariants]
          );
          const matchedLead = matchedRes.rows[0];
          if (matchedLead?.zns_consent === 'opted_out') {
            skippedSuppressed++;
            continue;
          }
          targets.push({
            id: matchedLead?.id ? String(matchedLead.id) : rec?.lead_id ? String(rec.lead_id) : null,
            name: rec?.name ? String(rec.name) : matchedLead?.name || null,
            phone: recPhone,
            extraTemplateData:
              rec?.template_data && typeof rec.template_data === 'object' ? rec.template_data : undefined,
          });
        }
      } else {
        let sql =
          "SELECT id, name, phone, zns_consent FROM leads WHERE tenant_id = $1 AND is_deleted = false AND phone IS NOT NULL AND zns_consent != 'opted_out'";
        const params: unknown[] = [ctx.tenantId];
        if (audienceId) {
          params.push(audienceId);
          sql += ` AND id IN (SELECT lead_id FROM tenant_audience_members WHERE tenant_id = $1 AND audience_id = $2)`;
        } else if (validLeadIds.length > 0) {
          const ph = validLeadIds.map((lid) => {
            params.push(lid);
            return `$${params.length}`;
          });
          sql += ` AND id IN (${ph.join(', ')})`;
        }
        sql += ' LIMIT 200';

        const leadsRes = await client.query<{ id: string; name: string | null; phone: string }>(sql, params);
        for (const lead of leadsRes.rows) {
          targets.push({ id: String(lead.id), name: lead.name, phone: String(lead.phone || '') });
        }
      }

      let dispatchedCount = 0;
      let uncountedSentCount = 0;
      let failedCount = 0;
      const broadcastText = String(tpl?.content_body || req.body?.message || '');

      for (const lead of targets) {
        const rawPhone = String(lead.phone || '').trim();
        const phoneKeys = getSuppressionMatchKeys('zns', rawPhone);
        if (!rawPhone || phoneKeys.some((k) => suppressedPhones.has(k))) {
          skippedSuppressed++;
          continue;
        }

        const znsRes = await dispatchZnsNotification({
          tenantId: ctx.tenantId,
          client,
          phone: rawPhone,
          templateId: tpl?.template_code ? String(tpl.template_code) : templateId || null,
          templateData: {
            customer_name: lead.name || '',
            name: lead.name || '',
            ...(req.body?.template_data && typeof req.body.template_data === 'object' ? req.body.template_data : {}),
            ...(lead.extraTemplateData || {}),
          },
          message: broadcastText,
          leadId: lead.id || undefined,
        });

        if (!znsRes.sent) {
          failedCount++;
          continue;
        }

        dispatchedCount++;
        if (znsRes.silent || znsRes.queued) {
          uncountedSentCount++;
        }
        if (lead.id) {
          await client.query(
            `INSERT INTO lead_timeline_events (
               id, tenant_id, lead_id, event_type, event_category, actor_id, actor_role, actor_name, title, content, metadata
             ) VALUES ($1, $2, $3, 'zns_sent', 'communication', $4, 'tenant_admin', $5, $6, $7, $8::jsonb)`,
            [
              crypto.randomUUID(),
              ctx.tenantId,
              lead.id,
              ctx.userId,
              ctx.userName || 'Zalo Broadcast',
              `Gửi Zalo Broadcast: ${tpl?.name || req.body?.campaign_name || 'Thông báo Zalo OA'}`,
              broadcastText.slice(0, 240),
              JSON.stringify({
                template_id: templateId || null,
                provider: znsRes.provider,
                message_id: znsRes.messageId,
              }),
            ]
          );
        }
      }

      if (tpl && dispatchedCount > 0) {
        await client.query(
          `UPDATE mkt_zalo_templates
           SET sent_count = sent_count + $3, delivered_count = delivered_count + $3, updated_at = clock_timestamp()
           WHERE tenant_id = $1 AND id = $2`,
          [ctx.tenantId, tpl.id, dispatchedCount]
        );
      }

      if (uncountedSentCount > 0) {
        await client.query(
          'UPDATE mkt_zalo_oa_configs SET sent_today = sent_today + $2, updated_at = clock_timestamp() WHERE tenant_id = $1',
          [ctx.tenantId, uncountedSentCount]
        );
      }

      return {
        sent_count: dispatchedCount,
        skipped_suppressed: skippedSuppressed,
        suppressed_count: skippedSuppressed,
        failed_count: failedCount,
        estimated_cost_vnd: dispatchedCount * Number(tpl?.price_vnd || 250),
        template_name: tpl?.name || null,
      };
    });

    res.json({ success: true, data: outcome });
  } catch (err: any) {
    sendApiError(res, 500, 'ZALO_BROADCAST_FAILED', err?.message || 'Không thể phát hành chiến dịch Zalo Broadcast.');
  }
});

// AITraining: Customer Knowledge & Document RAG Studio (`mkt_ai_training_docs`)
socialBotRouter.get('/training-docs', requirePermission('mkt_social_bot', 'view'), async (req, res) => {
  try {
    const ctx = getTenantContext();
    const filterProp = typeof req.query?.property_id === 'string' ? req.query.property_id.trim().toLowerCase() : '';
    const searchQ = typeof req.query?.search === 'string' ? req.query.search.trim().toLowerCase() : '';
    const items = await withTenantTransaction(ctx.tenantId, async (client) => {
      const [r, propsRes] = await Promise.all([
        client.query(
          'SELECT * FROM mkt_ai_training_docs WHERE tenant_id = $1 ORDER BY updated_at DESC',
          [ctx.tenantId]
        ),
        filterProp && filterProp !== 'all'
          ? client.query<{ id: string; name: string | null; domain: string | null; site_key: string | null }>(
              'SELECT id, name, domain, site_key FROM mkt_web_properties WHERE tenant_id = $1 ORDER BY created_at ASC',
              [ctx.tenantId]
            )
          : Promise.resolve({ rows: [] as Array<{ id: string; name: string | null; domain: string | null; site_key: string | null }> }),
      ]);

      const props = propsRes.rows || [];
      const propUuids = new Set(props.map((p) => String(p.id).trim().toLowerCase()));
      const legacyToUuid = new Map<string, string>();
      const normDom = (d: unknown) =>
        String(d || '').trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/+$/, '');
      for (const p of props) {
        const pId = String(p.id).trim().toLowerCase();
        const sk = String(p.site_key || '').trim();
        if (sk) {
          legacyToUuid.set(sk.toLowerCase(), pId);
          const stripped = sk.replace(/^wp_[a-z0-9-]+_/i, '').trim().toLowerCase();
          if (stripped) legacyToUuid.set(stripped, pId);
        }
        const dom = normDom(p.domain);
        if (dom) legacyToUuid.set(dom, pId);
      }

      const primaryProp =
        props.find((p) => normDom(p.domain) === 'ideas.edu.vn') ||
        props.find((p) => String(p.name || '').trim().toLowerCase() === 'ideas.edu.vn') ||
        props.find((p) => normDom(p.domain).includes('ideas.edu.vn') && !normDom(p.domain).startsWith('ai.')) ||
        props.find((p) => normDom(p.domain).includes('ideas.edu.vn')) ||
        props[0];
      const primaryPropId = primaryProp ? String(primaryProp.id).trim().toLowerCase() : '';
      const resolvedFilterUuid = filterProp ? (propUuids.has(filterProp) ? filterProp : legacyToUuid.get(filterProp) || '') : '';

      return r.rows
        .map((row) => ({
          ...row,
          metadata: parseJsonCol(row.metadata_json, {}),
        }))
        .filter((row) => {
          if (filterProp && filterProp !== 'all') {
            const meta = (row.metadata || {}) as Record<string, unknown>;
            const rawProp = String(meta.property_id ?? meta.propertyId ?? '').trim().toLowerCase();
            if (rawProp !== filterProp) {
              if (!resolvedFilterUuid) return false;
              const mappedDocUuid =
                (rawProp && (propUuids.has(rawProp) ? rawProp : legacyToUuid.get(rawProp))) ||
                (rawProp.startsWith('chatbot_') || !rawProp || !propUuids.has(rawProp) ? primaryPropId : '');
              if (mappedDocUuid !== resolvedFilterUuid) return false;
            }
          }
          if (searchQ) {
            const hay = `${row.title || ''} ${row.content_text || ''} ${row.doc_type || ''}`.toLowerCase();
            if (!hay.includes(searchQ)) return false;
          }
          return true;
        });
    });
    res.json({ success: true, data: { items } });
  } catch (err: any) {
    sendApiError(res, 500, 'LIST_TRAINING_DOCS_FAILED', err?.message || 'Không thể tải kho tri thức huấn luyện AI.');
  }
});

socialBotRouter.post('/training-docs', requirePermission('mkt_social_bot', 'create'), async (req, res) => {
  try {
    const ctx = getTenantContext();
    const title = String(req.body?.title || '').trim();
    const contentText = String(req.body?.content_text ?? req.body?.content ?? '').trim();
    if (!title) {
      sendApiError(res, 422, 'DOC_TITLE_REQUIRED', 'Vui lòng nhập tiêu đề tài liệu tri thức.');
      return;
    }

    const docType = ['faq', 'pdf', 'url', 'policy', 'product'].includes(String(req.body?.doc_type || ''))
      ? String(req.body.doc_type)
      : 'faq';
    const sourceUrl = req.body?.source_url ? String(req.body.source_url).trim() : null;
    const tokenCount = Math.max(1, Math.ceil(contentText.length / 4));
    const chunkCount = Math.max(1, Math.ceil(contentText.length / 800));
    const id = crypto.randomUUID();

    const created = await withTenantTransaction(ctx.tenantId, async (client) => {
      await client.query(
        `INSERT INTO mkt_ai_training_docs (
           id, tenant_id, title, doc_type, source_url, content_text,
           chunk_count, token_count, status, metadata_json, created_by
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'indexed', $9::jsonb, $10)`,
        [
          id,
          ctx.tenantId,
          title,
          docType,
          sourceUrl,
          contentText,
          chunkCount,
          tokenCount,
          JSON.stringify(req.body?.metadata || {}),
          ctx.userId,
        ]
      );
      const r = await client.query('SELECT * FROM mkt_ai_training_docs WHERE tenant_id = $1 AND id = $2', [
        ctx.tenantId,
        id,
      ]);
      return r.rows[0];
    });

    res.status(201).json({ success: true, data: created });
  } catch (err: any) {
    sendApiError(res, 500, 'CREATE_TRAINING_DOC_FAILED', err?.message || 'Không thể nạp tài liệu huấn luyện AI.');
  }
});

socialBotRouter.put('/training-docs/:id', requirePermission('mkt_social_bot', 'edit'), async (req, res) => {
  try {
    const ctx = getTenantContext();
    const updated = await withTenantTransaction(ctx.tenantId, async (client) => {
      const exRes = await client.query(
        'SELECT * FROM mkt_ai_training_docs WHERE tenant_id = $1 AND id = $2 LIMIT 1',
        [ctx.tenantId, req.params.id]
      );
      const ex = exRes.rows[0];
      if (!ex) return null;

      const title = req.body?.title !== undefined ? String(req.body.title).trim() : String(ex.title);
      const contentText =
        req.body?.content_text !== undefined ? String(req.body.content_text) : String(ex.content_text || '');
      const status = req.body?.status !== undefined ? String(req.body.status) : String(ex.status || 'indexed');
      const tokenCount = Math.max(1, Math.ceil(contentText.length / 4));
      const chunkCount = Math.max(1, Math.ceil(contentText.length / 800));

      await client.query(
        `UPDATE mkt_ai_training_docs
         SET title = $3, content_text = $4, status = $5,
             token_count = $6, chunk_count = $7, updated_at = clock_timestamp()
         WHERE tenant_id = $1 AND id = $2`,
        [ctx.tenantId, req.params.id, title, contentText, status, tokenCount, chunkCount]
      );
      const r = await client.query('SELECT * FROM mkt_ai_training_docs WHERE tenant_id = $1 AND id = $2', [
        ctx.tenantId,
        req.params.id,
      ]);
      return r.rows[0];
    });

    if (!updated) {
      sendApiError(res, 404, 'DOC_NOT_FOUND', 'Không tìm thấy tài liệu huấn luyện.');
      return;
    }
    res.json({ success: true, data: updated });
  } catch (err: any) {
    sendApiError(res, 500, 'UPDATE_TRAINING_DOC_FAILED', err?.message || 'Không thể cập nhật tài liệu huấn luyện.');
  }
});

socialBotRouter.delete('/training-docs/:id', requirePermission('mkt_social_bot', 'delete'), async (req, res) => {
  try {
    const ctx = getTenantContext();
    await withTenantTransaction(ctx.tenantId, async (client) => {
      await client.query('DELETE FROM mkt_ai_training_docs WHERE tenant_id = $1 AND id = $2', [
        ctx.tenantId,
        req.params.id,
      ]);
    });
    res.json({ success: true, data: { deleted: true } });
  } catch (err: any) {
    sendApiError(res, 500, 'DELETE_TRAINING_DOC_FAILED', err?.message || 'Không thể xóa tài liệu huấn luyện.');
  }
});
