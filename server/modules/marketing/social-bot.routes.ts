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
import { maskContactPiiIfDisallowed } from '../../core/security/pii-masker.ts';
import { emitDomainEvent } from '../../core/events/event-bus.ts';
import { runUnassignedLeadDrainer } from '../../cron/subroutines/lead-drainer.ts';
import {
  promoteLeadsToSaleRoundInTx,
  refreshAudienceCachedCount,
  upsertMasterContactInTx,
} from '../audiences/audiences.service.ts';
import {
  canUserUnmaskMarketingPii,
  parseJsonCol,
  readTenantChannelVault,
} from './utils.ts';

export const socialBotRouter = Router();

socialBotRouter.use(requireEntitlement('mkt_social_bot'));

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

  if (Array.isArray(trainingDocs)) {
    const tokens = lower
      .split(/\s+/)
      .map((w) => w.replace(/[^a-zA-Z0-9à-ỹ]/gi, ''))
      .filter((w) => w.length >= 4);
    for (const doc of trainingDocs) {
      const titleLower = String(doc.title || '').toLowerCase();
      const bodyText = String(doc.content_text || '').trim();
      if (!bodyText) continue;
      const bodyLower = bodyText.toLowerCase();
      const matchedTokens = tokens.filter((tk) => titleLower.includes(tk) || bodyLower.includes(tk));
      if (matchedTokens.length >= 2 || (titleLower && lower.includes(titleLower))) {
        return {
          reply: bodyText.slice(0, 420),
          matchedQuestion: String(doc.title || 'Knowledge Doc'),
        };
      }
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

      const [convRes, audRes, roundsRes, zaloVault, metaVault] = await Promise.all([
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
        readTenantChannelVault(client, ctx.tenantId, ['facebook_ads', 'meta_capi']),
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
        return {
          ...row,
          extracted_phone: masked.phone,
          extracted_email: masked.email,
        };
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

// Test AI Bot Studio Reply & Phone/Email Extraction
socialBotRouter.post('/bot-test', requirePermission('mkt_social_bot', 'view'), async (req, res) => {
  try {
    const ctx = getTenantContext();
    const message = String(req.body?.message || '').trim();
    if (!message) {
      sendApiError(res, 422, 'MESSAGE_REQUIRED', 'Vui lòng nhập tin nhắn khách hàng để kiểm thử AI Bot.');
      return;
    }

    const data = await withTenantTransaction(ctx.tenantId, async (client) => {
      const [botRow, docsRes] = await Promise.all([
        getOrCreateTenantBotConfig(client, ctx.tenantId),
        client.query(
          "SELECT title, content_text FROM mkt_ai_training_docs WHERE tenant_id = $1 AND status = 'indexed' ORDER BY updated_at DESC LIMIT 50",
          [ctx.tenantId]
        ),
      ]);
      const botCfg = mapBotConfig(botRow);
      const extracted = extractContactEntitiesFromText(message);
      const rag = generateBotReplyFromRag(
        message,
        botCfg.bot_name,
        botCfg.brand_persona,
        botCfg.faq_rules,
        extracted,
        docsRes.rows
      );
      return {
        bot_name: botCfg.bot_name,
        extracted_entities: extracted,
        matched_question: rag.matchedQuestion,
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

      return {
        conversation: conv,
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
          await client.query(
            `INSERT INTO tenant_audience_members (id, tenant_id, audience_id, lead_id, source_type, metadata)
             VALUES ($1, $2, $3, $4, 'social_bot', '{}'::jsonb)
             ON CONFLICT (tenant_id, audience_id, lead_id) DO NOTHING`,
            [crypto.randomUUID(), ctx.tenantId, botCfg.target_audience_id, leadId]
          );
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

      // Generate AI Bot reply if active and not paused
      let botReply: string | null = null;
      if (botCfg.is_active && !conv.bot_paused) {
        const rag = generateBotReplyFromRag(
          content,
          botCfg.bot_name,
          botCfg.brand_persona,
          botCfg.faq_rules,
          extracted
        );
        botReply = rag.reply;
        await client.query(
          `INSERT INTO mkt_social_messages (id, tenant_id, conversation_id, sender_type, sender_name, content, extracted_entities)
           VALUES ($1, $2, $3, 'bot', $4, $5, '{}'::jsonb)`,
          [crypto.randomUUID(), ctx.tenantId, conv.id, botCfg.bot_name, botReply]
        );
      }

      return {
        conversation_id: String(conv.id),
        lead_id: leadId,
        extracted_entities: extracted,
        bot_reply: botReply,
      };
    });

    if (drainAfterCommit) {
      await runUnassignedLeadDrainer(ctx.tenantId).catch(() => {});
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
      if (!convRes.rows[0]) return null;

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
          senderType === 'agent' ? ctx.userName || 'Chuyên viên CSKH' : convRes.rows[0].customer_name,
          content,
          JSON.stringify(extracted),
        ]
      );

      await client.query(
        `UPDATE mkt_social_conversations
         SET last_message_preview = $3,
             extracted_phone = COALESCE($4, extracted_phone),
             extracted_email = COALESCE($5, extracted_email),
             unread_count = CASE WHEN $6 = 0 THEN 0 ELSE unread_count + 1 END,
             last_message_at = clock_timestamp()
         WHERE tenant_id = $1 AND id = $2`,
        [ctx.tenantId, req.params.id, content.slice(0, 200), extracted.phone, extracted.email, senderType === 'agent' ? 0 : 1]
      );

      const r = await client.query('SELECT * FROM mkt_social_messages WHERE tenant_id = $1 AND id = $2', [
        ctx.tenantId,
        msgId,
      ]);
      return r.rows[0];
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
        await client.query(
          `INSERT INTO tenant_audience_members (id, tenant_id, audience_id, lead_id, source_type, metadata)
           VALUES ($1, $2, $3, $4, 'social_inbox', '{}'::jsonb)
           ON CONFLICT (tenant_id, audience_id, lead_id) DO NOTHING`,
          [crypto.randomUUID(), ctx.tenantId, audienceId, upserted.leadId]
        );
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
      const r = await client.query('SELECT * FROM mkt_social_conversations WHERE tenant_id = $1 AND id = $2', [
        ctx.tenantId,
        req.params.id,
      ]);
      return r.rows[0];
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
      return mapScenarioRow(r.rows[0]);
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
      return mapScenarioRow(r.rows[0]);
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

    const outcome = await withTenantTransaction(ctx.tenantId, async (client) => {
      const tplRes = templateId
        ? await client.query('SELECT * FROM mkt_zalo_templates WHERE tenant_id = $1 AND id = $2 LIMIT 1', [
            ctx.tenantId,
            templateId,
          ])
        : { rows: [] };
      const tpl = tplRes.rows[0];

      let sql = "SELECT id, name, phone, zns_consent FROM leads WHERE tenant_id = $1 AND is_deleted = false AND phone IS NOT NULL AND zns_consent != 'opted_out'";
      const params: unknown[] = [ctx.tenantId];
      if (audienceId) {
        params.push(audienceId);
        sql += ` AND id IN (SELECT lead_id FROM tenant_audience_members WHERE tenant_id = $1 AND audience_id = $2)`;
      } else if (rawLeadIds.length > 0) {
        const ph = rawLeadIds.map((lid) => {
          params.push(lid);
          return `$${params.length}`;
        });
        sql += ` AND id IN (${ph.join(', ')})`;
      }
      sql += ' LIMIT 200';

      const leadsRes = await client.query(sql, params);
      const dispatchedCount = leadsRes.rows.length;

      for (const lead of leadsRes.rows) {
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
            String(tpl?.content_body || req.body?.message || '').slice(0, 240),
            JSON.stringify({ template_id: templateId || null }),
          ]
        );
      }

      if (tpl) {
        await client.query(
          `UPDATE mkt_zalo_templates
           SET sent_count = sent_count + $3, delivered_count = delivered_count + $3, updated_at = clock_timestamp()
           WHERE tenant_id = $1 AND id = $2`,
          [ctx.tenantId, tpl.id, dispatchedCount]
        );
      }

      await client.query(
        'UPDATE mkt_zalo_oa_configs SET sent_today = sent_today + $2, updated_at = clock_timestamp() WHERE tenant_id = $1',
        [ctx.tenantId, dispatchedCount]
      );

      return {
        sent_count: dispatchedCount,
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
socialBotRouter.get('/training-docs', requirePermission('mkt_social_bot', 'view'), async (_req, res) => {
  try {
    const ctx = getTenantContext();
    const items = await withTenantTransaction(ctx.tenantId, async (client) => {
      const r = await client.query(
        'SELECT * FROM mkt_ai_training_docs WHERE tenant_id = $1 ORDER BY updated_at DESC',
        [ctx.tenantId]
      );
      return r.rows.map((row) => ({
        ...row,
        metadata: parseJsonCol(row.metadata_json, {}),
      }));
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
    const contentText = String(req.body?.content_text || '').trim();
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
