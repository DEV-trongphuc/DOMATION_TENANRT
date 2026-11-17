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
  extracted: { phone: string | null; email: string | null }
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
      const botRow = await getOrCreateTenantBotConfig(client, ctx.tenantId);
      const botCfg = mapBotConfig(botRow);
      const extracted = extractContactEntitiesFromText(message);
      const rag = generateBotReplyFromRag(
        message,
        botCfg.bot_name,
        botCfg.brand_persona,
        botCfg.faq_rules,
        extracted
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
