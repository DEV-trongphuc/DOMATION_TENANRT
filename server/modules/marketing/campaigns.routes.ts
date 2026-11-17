import crypto from 'node:crypto';
import { Router } from 'express';
import { withTenantTransaction } from '../../core/database/transaction.ts';
import { getTenantContext } from '../../core/context/tenant-context.ts';
import {
  requireEntitlement,
  requirePermission,
  sendApiError,
} from '../../core/security/rbac.ts';
import { evaluateDynamicAudience } from '../audiences/audiences.service.ts';
import {
  parseJsonCol,
  readTenantChannelVault,
  renderMergeTags,
  signUnsubscribeHmac,
} from './utils.ts';

export const campaignsRouter = Router();

campaignsRouter.use(requireEntitlement('mkt_campaigns'));

function mapCampaignRow(row: Record<string, unknown>) {
  const sentCount = Number(row.sent_count || 0);
  const openedCount = Number(row.opened_count || 0);
  const clickedCount = Number(row.clicked_count || 0);
  const costVnd = Number(row.cost_vnd || 0);
  const revenueVnd = Number(row.attributed_revenue_vnd || 0);

  return {
    id: String(row.id),
    tenant_id: String(row.tenant_id),
    name: String(row.name || ''),
    channel: String(row.channel || 'email') as 'email' | 'zns' | 'multi',
    status: String(row.status || 'draft'),
    audience_id: row.audience_id ? String(row.audience_id) : null,
    audience_name: row.audience_name ? String(row.audience_name) : null,
    audience_type: row.audience_type ? String(row.audience_type) : null,
    exclude_audience_ids: parseJsonCol<string[]>(row.exclude_audience_ids, []),
    template_id: row.template_id ? String(row.template_id) : null,
    template_name: row.template_name ? String(row.template_name) : null,
    subject_a: String(row.subject_a || ''),
    subject_b: String(row.subject_b || ''),
    ab_split_ratio: Number(row.ab_split_ratio ?? 100),
    zns_template_id: row.zns_template_id ? String(row.zns_template_id) : '',
    sender_name: row.sender_name ? String(row.sender_name) : '',
    sender_email: row.sender_email ? String(row.sender_email) : '',
    reminder_config: parseJsonCol<Record<string, unknown>>(row.reminder_config, {}),
    scheduled_at: row.scheduled_at || null,
    sent_at: row.sent_at || null,
    total_targeted: Number(row.total_targeted || 0),
    sent_count: sentCount,
    opened_count: openedCount,
    clicked_count: clickedCount,
    bounced_count: Number(row.bounced_count || 0),
    unsubscribed_count: Number(row.unsubscribed_count || 0),
    open_rate_pct: sentCount > 0 ? Number(((openedCount / sentCount) * 100).toFixed(1)) : 0,
    click_rate_pct: sentCount > 0 ? Number(((clickedCount / sentCount) * 100).toFixed(1)) : 0,
    cost_vnd: costVnd,
    attributed_revenue_vnd: revenueVnd,
    roi_multiple: costVnd > 0 ? Number((revenueVnd / costVnd).toFixed(2)) : 0,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

// List Campaigns + Audiences + Templates + Vault Readiness + Suppression Summary
campaignsRouter.get('/', requirePermission('mkt_campaigns', 'view'), async (_req, res) => {
  try {
    const ctx = getTenantContext();
    const data = await withTenantTransaction(ctx.tenantId, async (client) => {
      const [campRes, audRes, tplRes, supRes] = await Promise.all([
        client.query(
          `SELECT c.*,
                  a.name AS audience_name,
                  a.audience_type AS audience_type,
                  t.name AS template_name
           FROM mkt_campaigns c
           LEFT JOIN tenant_audiences a ON a.tenant_id = c.tenant_id AND a.id = c.audience_id
           LEFT JOIN mkt_email_templates t ON t.tenant_id = c.tenant_id AND t.id = c.template_id
           WHERE c.tenant_id = $1
           ORDER BY c.created_at DESC`,
          [ctx.tenantId]
        ),
        client.query(
          `SELECT id, name, audience_type, cached_member_count
           FROM tenant_audiences
           WHERE tenant_id = $1 AND is_active = true
           ORDER BY name ASC`,
          [ctx.tenantId]
        ),
        client.query(
          `SELECT id, name, subject
           FROM mkt_email_templates
           WHERE tenant_id = $1 AND status = 'active'
           ORDER BY updated_at DESC`,
          [ctx.tenantId]
        ),
        client.query<{ cnt: number }>(
          'SELECT COUNT(*)::int AS cnt FROM mkt_suppression_list WHERE tenant_id = $1',
          [ctx.tenantId]
        ),
      ]);

      const [emailVault, znsVault] = await Promise.all([
        readTenantChannelVault(client, ctx.tenantId, ['aws_ses', 'smtp']),
        readTenantChannelVault(client, ctx.tenantId, ['zalo_zns', 'zalo_oa']),
      ]);

      const items = campRes.rows.map(mapCampaignRow);
      const totals = items.reduce(
        (acc, c) => {
          acc.sent += c.sent_count;
          acc.opened += c.opened_count;
          acc.clicked += c.clicked_count;
          acc.revenue_vnd += c.attributed_revenue_vnd;
          acc.cost_vnd += c.cost_vnd;
          return acc;
        },
        { sent: 0, opened: 0, clicked: 0, revenue_vnd: 0, cost_vnd: 0 }
      );

      return {
        items,
        audiences: audRes.rows,
        templates: tplRes.rows,
        suppression_count: Number(supRes.rows[0]?.cnt || 0),
        vault_channels: {
          email: { configured: emailVault.configured, provider: emailVault.integrationType },
          zns: { configured: znsVault.configured, provider: znsVault.integrationType },
        },
        summary: totals,
      };
    });

    res.json({ success: true, data });
  } catch (err: any) {
    sendApiError(res, 500, 'LIST_CAMPAIGNS_FAILED', err?.message || 'Không thể tải danh sách Chiến dịch.');
  }
});

// Create Campaign
campaignsRouter.post('/', requirePermission('mkt_campaigns', 'create'), async (req, res) => {
  try {
    const ctx = getTenantContext();
    const name = String(req.body?.name || '').trim();
    if (!name) {
      sendApiError(res, 422, 'CAMPAIGN_NAME_REQUIRED', 'Vui lòng nhập tên Chiến dịch.');
      return;
    }

    const channel = req.body?.channel === 'zns' ? 'zns' : req.body?.channel === 'multi' ? 'multi' : 'email';
    const audienceId = req.body?.audience_id ? String(req.body.audience_id) : null;
    const excludeAudienceIds = Array.isArray(req.body?.exclude_audience_ids) ? req.body.exclude_audience_ids : [];
    const templateId = req.body?.template_id ? String(req.body.template_id) : null;
    const subjectA = String(req.body?.subject_a || name).trim();
    const subjectB = String(req.body?.subject_b || '').trim();
    const abSplitRatio = Math.min(100, Math.max(10, Math.round(Number(req.body?.ab_split_ratio ?? 100))));
    const znsTemplateId = req.body?.zns_template_id ? String(req.body.zns_template_id).trim() : null;
    const senderName = req.body?.sender_name ? String(req.body.sender_name).trim() : null;
    const senderEmail = req.body?.sender_email ? String(req.body.sender_email).trim() : null;
    const reminderConfig =
      req.body?.reminder_config && typeof req.body.reminder_config === 'object'
        ? req.body.reminder_config
        : { enabled: false, trigger_condition: 'no_open', wait_hours: 24, reminder_subject: '' };
    const costVnd = Math.max(0, Math.round(Number(req.body?.cost_vnd || 0)));
    const scheduledAt = req.body?.scheduled_at ? String(req.body.scheduled_at) : null;

    const id = crypto.randomUUID();
    const created = await withTenantTransaction(ctx.tenantId, async (client) => {
      await client.query(
        `INSERT INTO mkt_campaigns (
           id, tenant_id, name, channel, status, audience_id, exclude_audience_ids,
           template_id, subject_a, subject_b, ab_split_ratio, zns_template_id,
           sender_name, sender_email, reminder_config, scheduled_at, cost_vnd, created_by
         ) VALUES (
           $1, $2, $3, $4, $5, $6, $7::jsonb,
           $8, $9, $10, $11, $12,
           $13, $14, $15::jsonb, $16, $17, $18
         )`,
        [
          id,
          ctx.tenantId,
          name,
          channel,
          scheduledAt ? 'scheduled' : 'draft',
          audienceId,
          JSON.stringify(excludeAudienceIds),
          templateId,
          subjectA,
          subjectB,
          abSplitRatio,
          znsTemplateId,
          senderName,
          senderEmail,
          JSON.stringify(reminderConfig),
          scheduledAt,
          costVnd,
          ctx.userId,
        ]
      );
      const r = await client.query('SELECT * FROM mkt_campaigns WHERE tenant_id = $1 AND id = $2', [
        ctx.tenantId,
        id,
      ]);
      return mapCampaignRow(r.rows[0]);
    });

    res.status(201).json({ success: true, data: created });
  } catch (err: any) {
    sendApiError(res, 500, 'CREATE_CAMPAIGN_FAILED', err?.message || 'Không thể khởi tạo Chiến dịch.');
  }
});

// Update Campaign
campaignsRouter.put('/:id', requirePermission('mkt_campaigns', 'edit'), async (req, res) => {
  try {
    const ctx = getTenantContext();
    const updated = await withTenantTransaction(ctx.tenantId, async (client) => {
      const exRes = await client.query('SELECT * FROM mkt_campaigns WHERE tenant_id = $1 AND id = $2 LIMIT 1', [
        ctx.tenantId,
        req.params.id,
      ]);
      const ex = exRes.rows[0];
      if (!ex) return null;

      const name = req.body?.name !== undefined ? String(req.body.name).trim() : String(ex.name);
      const subjectA = req.body?.subject_a !== undefined ? String(req.body.subject_a).trim() : String(ex.subject_a);
      const subjectB = req.body?.subject_b !== undefined ? String(req.body.subject_b).trim() : String(ex.subject_b);
      const abSplitRatio =
        req.body?.ab_split_ratio !== undefined
          ? Math.min(100, Math.max(10, Math.round(Number(req.body.ab_split_ratio))))
          : Number(ex.ab_split_ratio ?? 100);
      const audienceId =
        req.body?.audience_id !== undefined
          ? req.body.audience_id
            ? String(req.body.audience_id)
            : null
          : ex.audience_id;
      const templateId =
        req.body?.template_id !== undefined
          ? req.body.template_id
            ? String(req.body.template_id)
            : null
          : ex.template_id;
      const reminderConfig =
        req.body?.reminder_config && typeof req.body.reminder_config === 'object'
          ? req.body.reminder_config
          : parseJsonCol(ex.reminder_config, {});
      const costVnd =
        req.body?.cost_vnd !== undefined ? Math.max(0, Math.round(Number(req.body.cost_vnd))) : Number(ex.cost_vnd || 0);
      const attributedRev =
        req.body?.attributed_revenue_vnd !== undefined
          ? Math.max(0, Math.round(Number(req.body.attributed_revenue_vnd)))
          : Number(ex.attributed_revenue_vnd || 0);

      await client.query(
        `UPDATE mkt_campaigns
         SET name = $3,
             subject_a = $4,
             subject_b = $5,
             ab_split_ratio = $6,
             audience_id = $7,
             template_id = $8,
             reminder_config = $9::jsonb,
             cost_vnd = $10,
             attributed_revenue_vnd = $11,
             updated_at = clock_timestamp()
         WHERE tenant_id = $1 AND id = $2`,
        [
          ctx.tenantId,
          req.params.id,
          name,
          subjectA,
          subjectB,
          abSplitRatio,
          audienceId,
          templateId,
          JSON.stringify(reminderConfig),
          costVnd,
          attributedRev,
        ]
      );

      const r = await client.query('SELECT * FROM mkt_campaigns WHERE tenant_id = $1 AND id = $2', [
        ctx.tenantId,
        req.params.id,
      ]);
      return mapCampaignRow(r.rows[0]);
    });

    if (!updated) {
      sendApiError(res, 404, 'CAMPAIGN_NOT_FOUND', 'Không tìm thấy Chiến dịch.');
      return;
    }
    res.json({ success: true, data: updated });
  } catch (err: any) {
    sendApiError(res, 500, 'UPDATE_CAMPAIGN_FAILED', err?.message || 'Không thể cập nhật Chiến dịch.');
  }
});

// Send Campaign with Atomic Send-Claim Locking (`status = 'claimed'` -> `'sent'`)
campaignsRouter.post('/:id/send', requirePermission('mkt_campaigns', 'create'), async (req, res) => {
  try {
    const ctx = getTenantContext();

    // Pre-step: if target audience is `dynamic_logic`, refresh real-time membership first
    const campCheck = await withTenantTransaction(ctx.tenantId, async (client) => {
      const r = await client.query<{ audience_id: string | null }>(
        'SELECT audience_id FROM mkt_campaigns WHERE tenant_id = $1 AND id = $2 LIMIT 1',
        [ctx.tenantId, req.params.id]
      );
      if (!r.rows[0]) return null;
      if (r.rows[0].audience_id) {
        const aRes = await client.query<{ audience_type: string }>(
          'SELECT audience_type FROM tenant_audiences WHERE tenant_id = $1 AND id = $2 LIMIT 1',
          [ctx.tenantId, r.rows[0].audience_id]
        );
        return { audienceId: r.rows[0].audience_id, audienceType: aRes.rows[0]?.audience_type || null };
      }
      return { audienceId: null, audienceType: null };
    });

    if (!campCheck) {
      sendApiError(res, 404, 'CAMPAIGN_NOT_FOUND', 'Không tìm thấy Chiến dịch cần phát hành.');
      return;
    }

    if (campCheck.audienceId && campCheck.audienceType === 'dynamic_logic') {
      await evaluateDynamicAudience(ctx.tenantId, campCheck.audienceId);
    }

    const outcome = await withTenantTransaction(ctx.tenantId, async (client) => {
      const cRes = await client.query('SELECT * FROM mkt_campaigns WHERE tenant_id = $1 AND id = $2 LIMIT 1', [
        ctx.tenantId,
        req.params.id,
      ]);
      const camp = cRes.rows[0];
      if (!camp) return null;

      const tenantRes = await client.query<{ name: string; slug: string }>(
        'SELECT name, slug FROM tenants WHERE id = $1 LIMIT 1',
        [ctx.tenantId]
      );
      const tenantName = tenantRes.rows[0]?.name || 'DOMATION';

      // Read channel Vault config (zero hardcoded credentials)
      const [emailVault, znsVault] = await Promise.all([
        readTenantChannelVault(client, ctx.tenantId, ['aws_ses', 'smtp']),
        readTenantChannelVault(client, ctx.tenantId, ['zalo_zns', 'zalo_oa']),
      ]);

      // Resolve audience members MINUS `tenant_audience_exclusions` & `mkt_suppression_list`
      const excludeAudIds = parseJsonCol<string[]>(camp.exclude_audience_ids, []);
      let leadsQuery = `
        SELECT l.id, l.name, l.phone, l.email, l.email_consent, l.zns_consent,
               l.product_interest, l.total_revenue_vnd, l.custom_fields
        FROM leads l
        WHERE l.tenant_id = $1 AND l.is_deleted = false
      `;
      const queryParams: unknown[] = [ctx.tenantId];

      if (camp.audience_id) {
        queryParams.push(camp.audience_id);
        const pAud = `$${queryParams.length}`;
        leadsQuery += `
          AND EXISTS (
            SELECT 1 FROM tenant_audience_members tam
            WHERE tam.tenant_id = l.tenant_id AND tam.audience_id = ${pAud} AND tam.lead_id = l.id
          )
          AND NOT EXISTS (
            SELECT 1 FROM tenant_audience_exclusions tae
            WHERE tae.tenant_id = l.tenant_id
              AND tae.audience_id = ${pAud}
              AND (
                tae.lead_id = l.id
                OR (tae.email IS NOT NULL AND l.email IS NOT NULL AND LOWER(tae.email) = LOWER(l.email))
                OR (tae.phone IS NOT NULL AND l.phone IS NOT NULL AND tae.phone = l.phone)
              )
          )
        `;
      }

      if (excludeAudIds.length > 0) {
        const placeholders = excludeAudIds.map((eid) => {
          queryParams.push(eid);
          return `$${queryParams.length}`;
        });
        leadsQuery += `
          AND NOT EXISTS (
            SELECT 1 FROM tenant_audience_members tam_ex
            WHERE tam_ex.tenant_id = l.tenant_id
              AND tam_ex.lead_id = l.id
              AND tam_ex.audience_id IN (${placeholders.join(', ')})
          )
        `;
      }

      const recipientsRes = await client.query(leadsQuery, queryParams);
      const suppressionRes = await client.query<{ channel: string; recipient: string }>(
        'SELECT channel, LOWER(recipient) AS recipient FROM mkt_suppression_list WHERE tenant_id = $1',
        [ctx.tenantId]
      );
      const suppressedSet = new Set(suppressionRes.rows.map((s) => `${s.channel}:${s.recipient}`));

      let tplHtml = '';
      if (camp.template_id) {
        const tRes = await client.query<{ compiled_html: string }>(
          'SELECT compiled_html FROM mkt_email_templates WHERE tenant_id = $1 AND id = $2 LIMIT 1',
          [ctx.tenantId, camp.template_id]
        );
        tplHtml = String(tRes.rows[0]?.compiled_html || '');
      }

      const channelsToSend: Array<'email' | 'zns'> =
        camp.channel === 'multi' ? ['email', 'zns'] : camp.channel === 'zns' ? ['zns'] : ['email'];

      let newlyClaimedAndSent = 0;
      let skippedDuplicateClaims = 0;
      let suppressedSkipped = 0;
      let attributedRevenue = Number(camp.attributed_revenue_vnd || 0);
      const claimIds: string[] = [];

      for (let idx = 0; idx < recipientsRes.rows.length; idx++) {
        const lead = recipientsRes.rows[idx];
        for (const ch of channelsToSend) {
          if (ch === 'email') {
            const emailLower = String(lead.email || '').trim().toLowerCase();
            if (
              !emailLower ||
              lead.email_consent !== 'subscribed' ||
              suppressedSet.has(`email:${emailLower}`)
            ) {
              suppressedSkipped++;
              continue;
            }
          } else {
            const phoneClean = String(lead.phone || '').trim();
            if (!phoneClean || lead.zns_consent === 'opted_out' || suppressedSet.has(`zns:${phoneClean}`)) {
              suppressedSkipped++;
              continue;
            }
          }

          // A/B Variant assignment
          const hasVariantB = Boolean(camp.subject_b && String(camp.subject_b).trim()) && Number(camp.ab_split_ratio) < 100;
          const variant =
            hasVariantB && (idx % 100) >= Number(camp.ab_split_ratio) ? 'B' : 'A';

          // Atomic Send-Claim Lock (`status = 'claimed'`)
          const candidateClaimId = crypto.randomUUID();
          await client.query(
            `INSERT INTO mkt_send_claims (
               id, tenant_id, campaign_id, lead_id, channel, variant, status, metadata
             ) VALUES ($1, $2, $3, $4, $5, $6, 'claimed', '{}'::jsonb)
             ON CONFLICT (tenant_id, campaign_id, lead_id, channel) DO NOTHING`,
            [candidateClaimId, ctx.tenantId, camp.id, lead.id, ch, variant]
          );

          const verifyClaim = await client.query<{ id: string; status: string }>(
            `SELECT id, status FROM mkt_send_claims
             WHERE tenant_id = $1 AND campaign_id = $2 AND lead_id = $3 AND channel = $4
             LIMIT 1`,
            [ctx.tenantId, camp.id, lead.id, ch]
          );

          if (verifyClaim.rows[0]?.id !== candidateClaimId) {
            skippedDuplicateClaims++;
            continue;
          }

          const unsubSig = signUnsubscribeHmac(ctx.tenantId, String(lead.id), ch);
          const unsubUrl = `/api/v1/public/marketing/unsubscribe?tenant_id=${ctx.tenantId}&lead_id=${lead.id}&channel=${ch}&sig=${unsubSig}`;
          const chosenSubject = variant === 'B' ? String(camp.subject_b) : String(camp.subject_a || camp.name);
          const renderedSubject = renderMergeTags(chosenSubject, {
            lead: {
              ...lead,
              custom_fields: parseJsonCol(lead.custom_fields, {}),
            },
            tenant: { name: tenantName },
            unsubscribe_url: unsubUrl,
          });

          const providerUsed =
            ch === 'email'
              ? emailVault.integrationType || 'vault_queued'
              : znsVault.integrationType || 'zns_vault_queued';

          await client.query(
            `UPDATE mkt_send_claims
             SET status = 'sent',
                 sent_at = clock_timestamp(),
                 metadata = $3::jsonb
             WHERE tenant_id = $1 AND id = $2`,
            [
              ctx.tenantId,
              candidateClaimId,
              JSON.stringify({
                subject: renderedSubject,
                provider: providerUsed,
                has_html: Boolean(tplHtml),
                unsubscribe_url: unsubUrl,
              }),
            ]
          );

          await client.query(
            `INSERT INTO lead_timeline_events (
               id, tenant_id, lead_id, event_type, event_category, actor_id, actor_role, actor_name, title, content, metadata
             ) VALUES ($1, $2, $3, $4, 'communication', $5, 'tenant_admin', $6, $7, $8, $9::jsonb)`,
            [
              crypto.randomUUID(),
              ctx.tenantId,
              lead.id,
              ch === 'zns' ? 'zns_sent' : 'mkt_email_sent',
              ctx.userId,
              ctx.userName || 'Campaign Sender',
              `Gửi chiến dịch ${ch.toUpperCase()}: ${camp.name}`,
              renderedSubject,
              JSON.stringify({ campaign_id: camp.id, claim_id: candidateClaimId, variant }),
            ]
          );

          newlyClaimedAndSent++;
          claimIds.push(candidateClaimId);
          attributedRevenue = Math.max(attributedRevenue, 0);
        }
      }

      // Recompute exact campaign counters using MariaDB-safe CASE WHEN (zero FILTER WHERE)
      const statsRes = await client.query<{
        total_cnt: number;
        sent_cnt: number;
        open_cnt: number;
        click_cnt: number;
        bounce_cnt: number;
        unsub_cnt: number;
      }>(
        `SELECT COUNT(*)::int AS total_cnt,
                COALESCE(SUM(CASE WHEN status IN ('sent', 'delivered', 'opened', 'clicked') THEN 1 ELSE 0 END), 0)::int AS sent_cnt,
                COALESCE(SUM(CASE WHEN opened_at IS NOT NULL THEN 1 ELSE 0 END), 0)::int AS open_cnt,
                COALESCE(SUM(CASE WHEN clicked_at IS NOT NULL THEN 1 ELSE 0 END), 0)::int AS click_cnt,
                COALESCE(SUM(CASE WHEN status = 'bounced' THEN 1 ELSE 0 END), 0)::int AS bounce_cnt,
                COALESCE(SUM(CASE WHEN status = 'unsubscribed' THEN 1 ELSE 0 END), 0)::int AS unsub_cnt
         FROM mkt_send_claims
         WHERE tenant_id = $1 AND campaign_id = $2`,
        [ctx.tenantId, camp.id]
      );
      const st = statsRes.rows[0];

      await client.query(
        `UPDATE mkt_campaigns
         SET status = 'completed',
             sent_at = COALESCE(sent_at, clock_timestamp()),
             total_targeted = $3,
             sent_count = $4,
             opened_count = $5,
             clicked_count = $6,
             bounced_count = $7,
             unsubscribed_count = $8,
             updated_at = clock_timestamp()
         WHERE tenant_id = $1 AND id = $2`,
        [
          ctx.tenantId,
          camp.id,
          recipientsRes.rows.length,
          Number(st?.sent_cnt || 0),
          Number(st?.open_cnt || 0),
          Number(st?.click_cnt || 0),
          Number(st?.bounce_cnt || 0),
          Number(st?.unsub_cnt || 0),
        ]
      );

      const updatedCamp = await client.query('SELECT * FROM mkt_campaigns WHERE tenant_id = $1 AND id = $2', [
        ctx.tenantId,
        camp.id,
      ]);

      return {
        campaign: mapCampaignRow(updatedCamp.rows[0]),
        newly_sent: newlyClaimedAndSent,
        duplicate_claims_prevented: skippedDuplicateClaims,
        suppressed_skipped: suppressedSkipped,
        claim_ids: claimIds,
      };
    });

    if (!outcome) {
      sendApiError(res, 404, 'CAMPAIGN_NOT_FOUND', 'Không tìm thấy Chiến dịch.');
      return;
    }

    res.json({ success: true, data: outcome });
  } catch (err: any) {
    sendApiError(res, 500, 'SEND_CAMPAIGN_FAILED', err?.message || 'Không thể phát hành Chiến dịch.');
  }
});

// Process Automated Reminders (`no_open` / `no_click`)
campaignsRouter.post('/:id/process-reminders', requirePermission('mkt_campaigns', 'create'), async (req, res) => {
  try {
    const ctx = getTenantContext();
    const result = await withTenantTransaction(ctx.tenantId, async (client) => {
      const cRes = await client.query('SELECT * FROM mkt_campaigns WHERE tenant_id = $1 AND id = $2 LIMIT 1', [
        ctx.tenantId,
        req.params.id,
      ]);
      const camp = cRes.rows[0];
      if (!camp) return null;

      const remCfg = parseJsonCol<{ trigger_condition?: string; reminder_subject?: string }>(
        camp.reminder_config,
        {}
      );
      const condition = req.body?.trigger_condition || remCfg.trigger_condition || 'no_open';

      const extraCond =
        condition === 'no_click' ? 'clicked_at IS NULL' : 'opened_at IS NULL';

      const pendingRes = await client.query<{ id: string; lead_id: string }>(
        `SELECT id, lead_id
         FROM mkt_send_claims
         WHERE tenant_id = $1
           AND campaign_id = $2
           AND reminder_sent = false
           AND status IN ('sent', 'delivered', 'opened')
           AND ${extraCond}`,
        [ctx.tenantId, camp.id]
      );

      for (const claim of pendingRes.rows) {
        await client.query(
          `UPDATE mkt_send_claims
           SET reminder_sent = true
           WHERE tenant_id = $1 AND id = $2`,
          [ctx.tenantId, claim.id]
        );
      }

      return {
        condition,
        reminders_dispatched: pendingRes.rows.length,
      };
    });

    if (!result) {
      sendApiError(res, 404, 'CAMPAIGN_NOT_FOUND', 'Không tìm thấy Chiến dịch.');
      return;
    }
    res.json({ success: true, data: result });
  } catch (err: any) {
    sendApiError(res, 500, 'REMINDER_PROCESS_FAILED', err?.message || 'Không thể chạy gửi nhắc Chiến dịch.');
  }
});

// Sync Attributed Revenue from Campaign Recipients' Total Revenue
campaignsRouter.post('/:id/attribute-revenue', requirePermission('mkt_campaigns', 'edit'), async (req, res) => {
  try {
    const ctx = getTenantContext();
    const manualBonusVnd = Math.max(0, Math.round(Number(req.body?.amount_vnd || 0)));

    const data = await withTenantTransaction(ctx.tenantId, async (client) => {
      const revRes = await client.query<{ rev: number }>(
        `SELECT COALESCE(SUM(l.total_revenue_vnd), 0)::bigint AS rev
         FROM mkt_send_claims c
         INNER JOIN leads l ON l.tenant_id = c.tenant_id AND l.id = c.lead_id
         WHERE c.tenant_id = $1 AND c.campaign_id = $2 AND (c.opened_at IS NOT NULL OR c.clicked_at IS NOT NULL)`,
        [ctx.tenantId, req.params.id]
      );
      const computedRev = Number(revRes.rows[0]?.rev || 0) + manualBonusVnd;

      await client.query(
        `UPDATE mkt_campaigns
         SET attributed_revenue_vnd = $3,
             updated_at = clock_timestamp()
         WHERE tenant_id = $1 AND id = $2`,
        [ctx.tenantId, req.params.id, computedRev]
      );

      const r = await client.query('SELECT * FROM mkt_campaigns WHERE tenant_id = $1 AND id = $2', [
        ctx.tenantId,
        req.params.id,
      ]);
      return r.rows[0] ? mapCampaignRow(r.rows[0]) : null;
    });

    if (!data) {
      sendApiError(res, 404, 'CAMPAIGN_NOT_FOUND', 'Không tìm thấy Chiến dịch.');
      return;
    }
    res.json({ success: true, data });
  } catch (err: any) {
    sendApiError(res, 500, 'ATTRIBUTE_REVENUE_FAILED', err?.message || 'Không thể đồng bộ doanh thu Chiến dịch.');
  }
});

campaignsRouter.delete('/:id', requirePermission('mkt_campaigns', 'delete'), async (req, res) => {
  try {
    const ctx = getTenantContext();
    const count = await withTenantTransaction(ctx.tenantId, async (client) => {
      const r = await client.query('DELETE FROM mkt_campaigns WHERE tenant_id = $1 AND id = $2', [
        ctx.tenantId,
        req.params.id,
      ]);
      return r.rowCount;
    });
    if (!count) {
      sendApiError(res, 404, 'CAMPAIGN_NOT_FOUND', 'Không tìm thấy Chiến dịch cần xóa.');
      return;
    }
    res.json({ success: true, data: { deleted: true } });
  } catch (err: any) {
    sendApiError(res, 500, 'DELETE_CAMPAIGN_FAILED', err?.message || 'Không thể xóa Chiến dịch.');
  }
});

// Suppression List Management
campaignsRouter.get('/suppression/list', requirePermission('mkt_campaigns', 'view'), async (_req, res) => {
  try {
    const ctx = getTenantContext();
    const items = await withTenantTransaction(ctx.tenantId, async (client) => {
      const r = await client.query(
        `SELECT * FROM mkt_suppression_list WHERE tenant_id = $1 ORDER BY created_at DESC LIMIT 200`,
        [ctx.tenantId]
      );
      return r.rows;
    });
    res.json({ success: true, data: { items } });
  } catch (err: any) {
    sendApiError(res, 500, 'LIST_SUPPRESSION_FAILED', err?.message || 'Không thể tải danh sách chặn gửi.');
  }
});

campaignsRouter.post('/suppression/list', requirePermission('mkt_campaigns', 'create'), async (req, res) => {
  try {
    const ctx = getTenantContext();
    const recipient = String(req.body?.recipient || '').trim().toLowerCase();
    const channel = req.body?.channel === 'zns' ? 'zns' : 'email';
    const reason = String(req.body?.reason || 'manual').trim();
    if (!recipient) {
      sendApiError(res, 422, 'RECIPIENT_REQUIRED', 'Vui lòng nhập Email hoặc SĐT cần đưa vào danh sách chặn.');
      return;
    }
    const id = crypto.randomUUID();
    await withTenantTransaction(ctx.tenantId, async (client) => {
      await client.query(
        `INSERT INTO mkt_suppression_list (id, tenant_id, channel, recipient, reason)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (tenant_id, channel, recipient) DO UPDATE SET reason = EXCLUDED.reason`,
        [id, ctx.tenantId, channel, recipient, reason]
      );
    });
    res.status(201).json({ success: true, data: { id, channel, recipient, reason } });
  } catch (err: any) {
    sendApiError(res, 500, 'ADD_SUPPRESSION_FAILED', err?.message || 'Không thể thêm vào danh sách chặn.');
  }
});
