import type { DbClient } from '../../core/database/db-adapter.ts';
import type { TenantContext } from '../../core/context/tenant-context.ts';
import { getTenantMetaCached } from '../../core/settings/tenant-cache.ts';
import {
  renderTemplateString,
  resolveTenantBrandName,
  type TenantSettings,
} from '../../core/settings/tenant-settings.ts';
import {
  buildLegacyDateFilterFromParams,
  enrichLeadAssigneeAndRound,
  formatDateTimeVnSql,
  mapPgLeadRowToLegacy,
} from './legacy-helpers.ts';
import {
  ingestAndDistributeLead,
  matchesRoutingBranches,
} from '../../services/distribution.service.ts';
import { normalizePhoneE164 } from '../../services/phone.service.ts';
import { maskPhoneString, maskEmailString } from '../../core/security/pii-masker.ts';
import { withTenantTransaction } from '../../core/database/transaction.ts';
import {
  dispatchStageCapiEventDetached,
  resolveCapiEventForQualityOrStage,
} from '../../services/capi.service.ts';
import { renderEmailHtmlEnvelope, sendTenantEmailNotification } from '../../services/zalo-mail.service.ts';
import { emitDomainEvent } from '../../core/events/event-bus.ts';

const ADMIN_OR_MANAGER_ROLES = ['admin', 'tenant_admin', 'manager', 'super_admin'];

export async function handleLegacyCrmStandalone(
  action: string,
  _params: URLSearchParams,
  body: Record<string, any>,
  ctx: TenantContext,
  cfg: TenantSettings
): Promise<Record<string, any> | null> {
  if (action === 'manual_insert_lead') {
    const rawPhone = String(body.phone || '').trim();
    const rawName = String(body.name || 'Khách hàng').trim();
    const rawEmail = body.email ? String(body.email).trim() : undefined;
    const rawSource = String(body.source || cfg.default_lead_source || 'Nhập Tay Admin').trim();
    const rawNote = body.note ? String(body.note).trim() : undefined;
    const overrideCons = body.override_consultant_id ? String(body.override_consultant_id) : undefined;

    if (!rawPhone) {
      return { success: false, message: 'Vui lòng nhập số điện thoại khách hàng.' };
    }

    const res = await ingestAndDistributeLead(ctx.tenantId, {
      name: rawName,
      phone: rawPhone,
      email: rawEmail,
      source: rawSource,
      note: rawNote,
      force_assigned_to: overrideCons,
      custom_fields: {
        type: body.type || 'Manual',
        note: rawNote || '',
      },
    });

    await emitDomainEvent('lead.created', {
      tenantId: ctx.tenantId,
      leadId: res.leadId,
      status: res.status,
      source: rawSource,
      actorId: ctx.userId,
    });

    return {
      success: true,
      message: `Đã thêm Lead & điều phối (${res.assignedName || res.status}).`,
      data: res,
    };
  }

  if (action === 'update_lead_quality') {
    const leadId = String(body.lead_id || body.id || '').trim();
    const qualityStatus = String(body.quality_status || 'Pending').trim();
    const qualityNote = body.quality_note !== undefined ? String(body.quality_note) : null;
    if (!leadId) return { success: false, message: 'Thiếu ID khách hàng.' };

    const txOutcome = await withTenantTransaction(ctx.tenantId, async (client) => {
      if (ctx.userRole === 'sale' || ctx.isExternalAgency) {
        const ownerCheck = await client.query(
          'SELECT id, assigned_to FROM leads WHERE tenant_id = $1 AND id = $2 LIMIT 1',
          [ctx.tenantId, leadId]
        );
        if (!ownerCheck.rows.length) {
          return { error: { _status: 404, success: false, error: 'Lead not found' } };
        }
        if (ownerCheck.rows[0].assigned_to !== ctx.userId) {
          return { error: { _status: 403, success: false, error: 'Forbidden: you can only update leads assigned to you' } };
        }
      }

      const updRes = await client.query(
        `UPDATE leads
         SET quality_status = $3,
             quality_note = COALESCE($4, quality_note),
             last_engaged_at = clock_timestamp(),
             updated_at = clock_timestamp()
         WHERE tenant_id = $1 AND id = $2
         RETURNING *`,
        [ctx.tenantId, leadId, qualityStatus, qualityNote]
      );
      if (!updRes.rows[0]) {
        return { error: { _status: 404, success: false, error: 'Lead not found' } };
      }
      return { lead: updRes.rows[0] };
    });

    if ('error' in txOutcome && txOutcome.error) {
      return txOutcome.error;
    }

    const l = txOutcome.lead;
    const capiEvent = resolveCapiEventForQualityOrStage({
      qualityStatus,
      tenantSettings: cfg,
    });

    let capiDispatched = null;
    if (capiEvent) {
      const capiRes = await dispatchStageCapiEventDetached({
        tenantId: ctx.tenantId,
        tenantSlug: ctx.tenantSlug,
        eventName: capiEvent,
        tenantSettings: cfg,
        lead: {
          leadId: l.id,
          name: l.name,
          phone: l.phone,
          email: l.email,
          fbc: l.fbc,
          fbp: l.fbp,
          fbclid: l.fbclid,
          metaLeadId: l.meta_lead_id,
          dealValue: Number(l.total_revenue_vnd || 0) || undefined,
          customFields: l.custom_fields,
        },
        timelineAudit: {
          actorId: ctx.userId,
          actorRole: ctx.userRole,
          stageName: qualityStatus,
        },
      });
      capiDispatched = {
        event_name: capiRes.event_name,
        event_id: capiRes.event_id,
        status: capiRes.status,
        http_status: capiRes.status,
        status_label: capiRes.status_label,
        fbtrace_id: capiRes.fbtrace_id,
      };
    }

    await emitDomainEvent('lead.updated', {
      tenantId: ctx.tenantId,
      leadId: String(l.id),
      changedFields: ['quality_status'],
      actorId: ctx.userId,
    });

    return {
      success: true,
      message: 'Đã cập nhật chất lượng Lead.',
      capi_dispatched: capiDispatched,
    };
  }

  if (action === 'approve_held_lead') {
    if (!ADMIN_OR_MANAGER_ROLES.includes(ctx.userRole) || ctx.isExternalAgency) {
      return { _status: 403, success: false, error: 'Forbidden: manager or admin privileges required' };
    }
    const heldId = String(body.id || '').trim();
    const overrideRoundId = body.round_id ? String(body.round_id) : null;
    if (!heldId) return { success: false, message: 'Thiếu ID lead tạm giữ.' };

    const held = await withTenantTransaction(ctx.tenantId, async (client) => {
      const r = await client.query(
        'SELECT * FROM held_leads WHERE tenant_id = $1 AND id = $2 LIMIT 1',
        [ctx.tenantId, heldId]
      );
      return r.rows[0] || null;
    });

    if (!held) return { success: false, message: 'Không tìm thấy Lead tạm giữ.' };

    const ingested = await ingestAndDistributeLead(ctx.tenantId, {
      name: held.name || 'Khách hàng',
      phone: held.phone || '',
      email: held.email || undefined,
      source: held.source || 'AI Pre-screener',
      campaign: held.campaign || undefined,
      skip_gatekeeper: true,
      custom_fields: {
        ...(held.payload_json && typeof held.payload_json === 'object' ? held.payload_json : {}),
        approved_from_held_id: held.id,
        preferred_round_id: overrideRoundId || held.round_id || undefined,
      },
    });

    await withTenantTransaction(ctx.tenantId, async (client) => {
      await client.query(
        `UPDATE held_leads
         SET status = 'approved', resolved_by = $3, resolved_at = clock_timestamp(), updated_at = clock_timestamp()
         WHERE tenant_id = $1 AND id = $2`,
        [ctx.tenantId, heldId, ctx.userId]
      );
    });

    await emitDomainEvent('lead.created', {
      tenantId: ctx.tenantId,
      leadId: ingested.leadId,
      status: ingested.status,
      source: held.source || 'AI Pre-screener',
      actorId: ctx.userId,
    });

    return {
      success: true,
      message: `Đã duyệt Lead và phân bổ cho ${ingested.assignedName || 'Đại lý'}.`,
      data: ingested,
    };
  }

  return null;
}

export async function handleLegacyCrm(
  action: string,
  params: URLSearchParams,
  body: Record<string, any>,
  client: DbClient,
  ctx: TenantContext,
  cfg: TenantSettings
): Promise<Record<string, any> | null> {
  if (action === 'get_logs' || action === 'get_leads') {
    const page = Math.max(1, Number(params.get('page') || 1));
    const pageSize = Math.min(250, Math.max(1, Number(params.get('pageSize') || 50)));
    const offset = (page - 1) * pageSize;
    const dateFilter = buildLegacyDateFilterFromParams(params, 'Tháng này');
    const statusFilter = String(params.get('status') || 'all');
    const consultantFilter = String(params.get('consultant') || 'all');
    const roundFilter = String(params.get('round') || 'all');
    const searchFilter = String(params.get('search') || '').trim();
    const leadIdFilter = String(params.get('lead_id') || '').trim();
    const campaignIdFilter = String(params.get('campaign_id') || '').trim();
    const excludeStatus = String(params.get('exclude_status') || '');
    const qualityFilter = String(params.get('quality_status') || 'all');

    const qParams: unknown[] = [ctx.tenantId];
    const conds: string[] = ['l.tenant_id = $1', 'l.is_deleted = false'];

    if (!searchFilter && !leadIdFilter && !campaignIdFilter) {
      conds.push(`(${dateFilter.bindSql('l.created_at', qParams)})`);
    }

    if (leadIdFilter) {
      qParams.push(leadIdFilter);
      conds.push(`l.id::text = $${qParams.length}`);
    }

    if (campaignIdFilter) {
      qParams.push(campaignIdFilter);
      const cpIdx = qParams.length;
      conds.push(
        `(l.campaign_id = $${cpIdx} OR COALESCE(l.custom_fields->>'campaign_id', '') = $${cpIdx} OR COALESCE(l.campaign, '') ILIKE $${cpIdx})`
      );
    }

    if (ctx.userRole === 'sale') {
      qParams.push(ctx.userId);
      conds.push(`l.assigned_to = $${qParams.length}`);
    } else if (consultantFilter && consultantFilter !== 'all') {
      qParams.push(consultantFilter);
      conds.push(`(l.assigned_to::text = $${qParams.length} OR u.full_name ILIKE $${qParams.length})`);
    }

    if (excludeStatus === 'silent') {
      conds.push(`l.status != 'archived'`);
    }

    if (statusFilter && statusFilter !== 'all') {
      if (statusFilter === 'assigned') conds.push(`l.status = 'assigned'`);
      else if (statusFilter === 'compensation') {
        conds.push(`l.status = 'assigned' AND COALESCE(l.custom_fields->>'original_status','') IN ('compensated','compensation')`);
      } else if (statusFilter === 'duplicate') {
        conds.push(`(l.is_duplicate_reminder = true OR l.is_duplicated = true)`);
      } else if (statusFilter === 'silent') {
        conds.push(`l.status = 'archived'`);
      } else if (statusFilter === 'pending_work_hours' || statusFilter === 'pending') {
        conds.push(`l.status = 'unassigned_pending'`);
      } else if (statusFilter === 'rejected') conds.push(`l.status = 'rejected'`);
      else if (statusFilter === 'blacklisted') conds.push(`l.status = 'blacklisted'`);
      else if (statusFilter === 'pending_approval') conds.push(`l.status = 'pending_approval'`);
    }

    if (roundFilter && roundFilter !== 'all') {
      qParams.push(roundFilter);
      conds.push(`(l.round_id::text = $${qParams.length} OR r.name = $${qParams.length})`);
    }

    if (qualityFilter && qualityFilter !== 'all') {
      if (qualityFilter === 'unrated') {
        conds.push(`(l.quality_status IS NULL OR l.quality_status = '' OR l.quality_status = 'Pending')`);
      } else {
        qParams.push(qualityFilter);
        conds.push(`l.quality_status = $${qParams.length}`);
      }
    }

    if (searchFilter) {
      qParams.push(`%${searchFilter}%`);
      const pIdx = qParams.length;
      conds.push(
        `(l.name ILIKE $${pIdx} OR l.phone ILIKE $${pIdx} OR COALESCE(l.email,'') ILIKE $${pIdx} OR COALESCE(l.campaign,'') ILIKE $${pIdx} OR COALESCE(l.campaign_id,'') ILIKE $${pIdx} OR COALESCE(l.ad_id,'') ILIKE $${pIdx})`
      );
    }

    const whereSql = conds.join(' AND ');
    const countJoins: string[] = [];
    if (whereSql.includes('u.')) {
      countJoins.push('LEFT JOIN users u ON u.tenant_id = l.tenant_id AND u.id = l.assigned_to');
    }
    if (whereSql.includes('r.')) {
      countJoins.push('LEFT JOIN distribution_rounds r ON r.tenant_id = l.tenant_id AND r.id = l.round_id');
    }
    const countJoinSql = countJoins.length > 0 ? `\n         ${countJoins.join('\n         ')}` : '';

    const [rowsRes, cntRes] = await Promise.all([
      client.query(
        `SELECT l.*,
                u.full_name AS assigned_to_name, u.avatar_url AS assigned_to_avatar,
                r.name AS round_name,
                s.stage_name,
                l.custom_fields->>'ad_thumbnail_url' AS ad_thumbnail_url,
                l.custom_fields->>'ad_image_url' AS ad_image_url,
                l.custom_fields->>'ad_creative_title' AS ad_creative_title,
                l.custom_fields->>'ad_creative_body' AS ad_creative_body,
                l.custom_fields->>'ad_story_id' AS ad_story_id,
                (SELECT dr.status FROM data_reports dr WHERE dr.tenant_id = l.tenant_id AND dr.lead_id = l.id ORDER BY dr.created_at DESC LIMIT 1) AS report_status
         FROM leads l
         LEFT JOIN users u ON u.tenant_id = l.tenant_id AND u.id = l.assigned_to
         LEFT JOIN distribution_rounds r ON r.tenant_id = l.tenant_id AND r.id = l.round_id
         LEFT JOIN tenant_pipeline_stages s ON s.tenant_id = l.tenant_id AND s.id = l.stage_id
         WHERE ${whereSql}
         ORDER BY l.created_at DESC
         LIMIT $${qParams.length + 1} OFFSET $${qParams.length + 2}`,
        [...qParams, pageSize, offset]
      ),
      client.query<{ total: number }>(
        `SELECT COUNT(*)::int AS total
         FROM leads l${countJoinSql}
         WHERE ${whereSql}`,
        qParams
      ),
    ]);

    const adIds = Array.from(
      new Set(rowsRes.rows.map((row: any) => String(row.ad_id || '').trim()).filter(Boolean))
    );
    if (adIds.length > 0) {
      const adsRes = await client.query<{
        ad_id: string;
        thumbnail_url: string | null;
        image_url: string | null;
        creative_title: string | null;
        creative_body: string | null;
        story_id: string | null;
      }>(
        `SELECT ad_id, thumbnail_url, image_url, creative_title, creative_body, story_id
         FROM meta_ads_insights
         WHERE tenant_id = $1 AND ad_id = ANY($2::text[])
         ORDER BY date_stop DESC`,
        [ctx.tenantId, adIds]
      );
      const latestAdById = new Map<string, typeof adsRes.rows[number]>();
      for (const adRow of adsRes.rows) {
        if (!latestAdById.has(adRow.ad_id)) {
          latestAdById.set(adRow.ad_id, adRow);
        }
      }
      for (const row of rowsRes.rows as any[]) {
        const mai = row.ad_id ? latestAdById.get(String(row.ad_id).trim()) : undefined;
        if (mai) {
          row.ad_thumbnail_url = mai.thumbnail_url || row.ad_thumbnail_url;
          row.ad_image_url = mai.image_url || row.ad_image_url;
          row.ad_creative_title = mai.creative_title || row.ad_creative_title;
          row.ad_creative_body = mai.creative_body || row.ad_creative_body;
          row.ad_story_id = mai.story_id || row.ad_story_id;
        }
      }
    }

    await enrichLeadAssigneeAndRound(client, ctx.tenantId, rowsRes.rows);

    return {
      success: true,
      data: rowsRes.rows.map((row) => mapPgLeadRowToLegacy(row, ctx, cfg)),
      total_count: Number(cntRes.rows[0]?.total || 0),
    };
  }

  if (action === 'preview_routing') {
    const sourceVal = String(body.source || '');
    const noteVal = String(body.note || '');
    const customFields = body.custom_fields && typeof body.custom_fields === 'object' ? body.custom_fields : {};
    const rulesRes = await client.query(
      `SELECT rr.id, rr.rule_name, rr.priority, rr.round_id, rr.conditions_json, rr.condition_branches, rr.is_active,
              dr.name AS round_name
       FROM routing_rules rr
       LEFT JOIN distribution_rounds dr ON dr.tenant_id = rr.tenant_id AND dr.id = rr.round_id
       WHERE rr.tenant_id = $1 AND rr.is_active = true
       ORDER BY rr.priority ASC`,
      [ctx.tenantId]
    );

    const payload = {
      name: body.name || '',
      phone: body.phone || '',
      email: body.email || '',
      source: sourceVal,
      note: noteVal,
      ...customFields,
    };

    const matchedRule = rulesRes.rows.find((rule) =>
      matchesRoutingBranches(rule.condition_branches, rule.conditions_json, payload as any)
    );

    if (matchedRule) {
      return {
        success: true,
        matched: true,
        rule_id: matchedRule.id,
        rule_name: matchedRule.rule_name,
        round_id: matchedRule.round_id,
        round_name: matchedRule.round_name,
      };
    }

    const fallbackRound = await client.query(
      'SELECT id, name FROM distribution_rounds WHERE tenant_id = $1 AND is_active = true ORDER BY priority ASC LIMIT 1',
      [ctx.tenantId]
    );

    return {
      success: true,
      matched: false,
      round_id: fallbackRound.rows[0]?.id || null,
      round_name: fallbackRound.rows[0]?.name || 'Vòng mặc định',
    };
  }

  if (action === 'update_lead_fields') {
    const leadId = String(body.lead_id || body.id || '').trim();
    if (!leadId) return { success: false, message: 'Thiếu ID khách hàng.' };

    if (ctx.userRole === 'sale' || ctx.isExternalAgency) {
      const ownerCheck = await client.query(
        'SELECT id, assigned_to FROM leads WHERE tenant_id = $1 AND id = $2 LIMIT 1',
        [ctx.tenantId, leadId]
      );
      if (!ownerCheck.rows.length) {
        return { _status: 404, success: false, error: 'Lead not found' };
      }
      if (ownerCheck.rows[0].assigned_to !== ctx.userId) {
        return { _status: 403, success: false, error: 'Forbidden: you can only update leads assigned to you' };
      }
    }

    const curLeadRes = await client.query<{ custom_fields: Record<string, any> | null }>(
      'SELECT custom_fields FROM leads WHERE tenant_id = $1 AND id = $2 LIMIT 1',
      [ctx.tenantId, leadId]
    );
    const mergedCustomFields = {
      ...(curLeadRes.rows[0]?.custom_fields && typeof curLeadRes.rows[0].custom_fields === 'object'
        ? curLeadRes.rows[0].custom_fields
        : {}),
      ...(body.type !== undefined ? { type: body.type } : {}),
      ...(body.note !== undefined ? { note: body.note } : {}),
    };

    await client.query(
      `UPDATE leads
       SET name = COALESCE($3, name),
           phone = COALESCE($4, phone),
           email = COALESCE($5, email),
           source = COALESCE($6, source),
           custom_fields = $7::jsonb,
           updated_at = clock_timestamp()
       WHERE tenant_id = $1 AND id = $2`,
      [
        ctx.tenantId,
        leadId,
        body.name !== undefined ? String(body.name) : null,
        body.phone !== undefined ? String(body.phone) : null,
        body.email !== undefined ? String(body.email) : null,
        body.source !== undefined ? String(body.source) : null,
        JSON.stringify(mergedCustomFields),
      ]
    );
    return { success: true, message: 'Đã cập nhật thông tin khách hàng.' };
  }

  if (action === 'accept_lead') {
    const leadId = String(body.lead_id || body.id || '').trim();
    if (!leadId) return { success: false, message: 'Thiếu ID khách hàng.' };

    if (ctx.userRole === 'sale' || ctx.isExternalAgency) {
      const ownerCheck = await client.query(
        'SELECT id, assigned_to FROM leads WHERE tenant_id = $1 AND id = $2 LIMIT 1',
        [ctx.tenantId, leadId]
      );
      if (!ownerCheck.rows.length) {
        return { _status: 404, success: false, error: 'Lead not found' };
      }
      if (ownerCheck.rows[0].assigned_to !== ctx.userId) {
        return { _status: 403, success: false, error: 'Forbidden: you can only accept leads assigned to you' };
      }
    }

    const r = await client.query(
      `UPDATE leads
       SET is_accepted = true, accepted_at = COALESCE(accepted_at, clock_timestamp()), updated_at = clock_timestamp()
       WHERE tenant_id = $1 AND id = $2
       RETURNING id, name, phone, email`,
      [ctx.tenantId, leadId]
    );
    const row = r.rows[0];
    if (row && ctx.isExternalAgency) {
      row.phone = row.phone ? maskPhoneString(row.phone, cfg) : row.phone;
      if (cfg.pii_mask_email && row.email) {
        row.email = maskEmailString(row.email, cfg);
      }
    }
    return { success: true, data: row, lead: row, message: 'Đã xác nhận tiếp nhận Lead.' };
  }

  if (action === 'reassign_lead') {
    if (!ADMIN_OR_MANAGER_ROLES.includes(ctx.userRole) || ctx.isExternalAgency) {
      return { _status: 403, success: false, error: 'Forbidden: only managers or admins can reassign leads' };
    }
    const leadId = String(body.lead_id || body.id || '').trim();
    const newConsId = String(body.new_consultant_id || body.consultant_id || '').trim();
    if (!leadId || !newConsId) return { success: false, message: 'Thiếu ID Lead hoặc Đại lý đích.' };

    await client.query(
      `UPDATE leads
       SET assigned_to = $3, status = 'assigned', is_accepted = false, updated_at = clock_timestamp()
       WHERE tenant_id = $1 AND id = $2`,
      [ctx.tenantId, leadId, newConsId]
    );

    await client.query(
      `INSERT INTO lead_timeline_events (tenant_id, lead_id, event_type, event_category, actor_id, actor_role, actor_name, title, content)
       VALUES ($1, $2, 'reassigned', 'system', $3, $4, $5, 'Điều chuyển Đại lý phụ trách', $6)`,
      [ctx.tenantId, leadId, ctx.userId, ctx.userRole, ctx.userName || ctx.userEmail || 'Admin', `Admin đã điều chuyển sang đại lý ${newConsId}`]
    );

    return { success: true, message: 'Đã điều chuyển quyền chăm sóc Lead.' };
  }

  if (action === 'block_lead') {
    if (!ADMIN_OR_MANAGER_ROLES.includes(ctx.userRole) || ctx.isExternalAgency) {
      return { _status: 403, success: false, error: 'Forbidden: only managers or admins can block leads' };
    }
    const leadId = String(body.lead_id || body.id || '').trim();
    const reason = String(body.reason || 'Chặn thủ công bởi Quản trị viên').trim();
    if (!leadId) return { success: false, message: 'Thiếu ID Lead.' };

    const upd = await client.query<{ phone: string }>(
      `UPDATE leads SET status = 'blacklisted', updated_at = clock_timestamp()
       WHERE tenant_id = $1 AND id = $2
       RETURNING phone`,
      [ctx.tenantId, leadId]
    );
    const phone = upd.rows[0]?.phone;
    if (phone) {
      await client.query(
        `INSERT INTO blacklist_entries (tenant_id, entry_type, value, reason, created_by)
         VALUES ($1, 'phone', $2, $3, $4)
         ON CONFLICT DO NOTHING`,
        [ctx.tenantId, phone, reason, ctx.userId]
      );
    }
    return { success: true, message: 'Đã đưa khách hàng vào Danh sách đen (Blacklist).' };
  }

  if (action === 'check_lead_duplicate') {
    const input = String(params.get('input') || body.input || '').trim();
    if (!input) return { success: false, message: 'Thiếu SĐT hoặc Email cần kiểm tra.' };
    const e164 = normalizePhoneE164(input, { default_dial_code: cfg.default_dial_code });
    const digits = input.replace(/\D/g, '');
    const last9 = digits.length >= 9 ? digits.slice(-9) : digits;

    const r = await client.query(
      `SELECT l.id, l.name, l.phone, l.email, l.source, l.status, l.created_at,
              u.full_name AS assigned_to_name, dr.name AS round_name
       FROM leads l
       LEFT JOIN users u ON u.tenant_id = l.tenant_id AND u.id = l.assigned_to
       LEFT JOIN distribution_rounds dr ON dr.tenant_id = l.tenant_id AND dr.id = l.round_id
       WHERE l.tenant_id = $1 AND l.is_deleted = false
         AND (l.phone = $2 OR l.phone = $3 OR (length($4) >= 6 AND l.phone LIKE '%' || $4) OR LOWER(COALESCE(l.email,'')) = LOWER($2))
       ORDER BY l.created_at DESC
       LIMIT 20`,
      [ctx.tenantId, input, e164, last9]
    );

    return {
      success: true,
      is_duplicate: r.rows.length > 0,
      count: r.rows.length,
      history: r.rows.map((row) => ({
        ...row,
        created_at: formatDateTimeVnSql(row.created_at),
      })),
    };
  }

  if (action === 'get_unique_sources') {
    const r = await client.query<{ source: string }>(
      `SELECT DISTINCT COALESCE(NULLIF(trim(source),''), 'Webhook') AS source
       FROM leads
       WHERE tenant_id = $1 AND is_deleted = false
       ORDER BY source ASC
       LIMIT 50`,
      [ctx.tenantId]
    );
    return {
      success: true,
      data: r.rows.map((x) => x.source),
    };
  }

  if (action === 'get_sale_lead_timeline') {
    const leadId = String(params.get('lead_id') || '').trim();
    if (ctx.userRole === 'sale') {
      const ownerCheck = await client.query(
        'SELECT id, assigned_to FROM leads WHERE tenant_id = $1 AND id = $2 LIMIT 1',
        [ctx.tenantId, leadId]
      );
      if (!ownerCheck.rows.length) {
        return { _status: 404, success: false, error: 'Lead not found' };
      }
      if (ownerCheck.rows[0].assigned_to !== ctx.userId) {
        return { _status: 403, success: false, error: 'Forbidden: you can only view timeline for your assigned leads' };
      }
    }
    const r = await client.query(
      `SELECT id, event_type, event_category, actor_name, actor_role, title, content, metadata, created_at
       FROM lead_timeline_events
       WHERE tenant_id = $1 AND lead_id = $2
       ORDER BY created_at DESC`,
      [ctx.tenantId, leadId]
    );
    return {
      success: true,
      data: r.rows.map((row) => ({ ...row, created_at: formatDateTimeVnSql(row.created_at) })),
    };
  }

  if (action === 'get_lead_notification_status') {
    const leadId = String(params.get('lead_id') || body.lead_id || '').trim();
    const r = await client.query(
      `SELECT l.zalo_notify_status, l.email_notify_status, l.is_accepted, l.accepted_at, l.created_at,
              u.full_name AS consultant_name, u.email AS consultant_email, p.zalo_chat_id
       FROM leads l
       LEFT JOIN users u ON u.tenant_id = l.tenant_id AND u.id = l.assigned_to
       LEFT JOIN tenant_user_profiles p ON p.tenant_id = l.tenant_id AND p.user_id = l.assigned_to
       WHERE l.tenant_id = $1 AND l.id = $2
       LIMIT 1`,
      [ctx.tenantId, leadId]
    );
    const row = r.rows[0] || {};
    const zaloStatus = row.zalo_notify_status || (row.zalo_chat_id ? 'none' : 'no_zalo_config');
    const emailStatus = row.email_notify_status || 'none';
    const sentAt = formatDateTimeVnSql(row.created_at);
    const acceptedAt = formatDateTimeVnSql(row.accepted_at);

    return {
      success: true,
      data: {
        zalo_status: zaloStatus,
        email_status: emailStatus,
        is_accepted: Boolean(row.is_accepted),
        accepted_at: acceptedAt,
        sent_at: sentAt,
        consultant_name: row.consultant_name || '-',
        consultant_email: row.consultant_email || '-',
        has_zalo: Boolean(row.zalo_chat_id),
        email: {
          status: emailStatus,
          sent_at: sentAt,
          last_sent_at: sentAt,
          target: row.consultant_email || '-',
          id: null,
          error: null,
        },
        zalo: {
          status: zaloStatus,
          sent_at: sentAt,
          last_sent_at: sentAt,
          target: row.zalo_chat_id || '-',
          id: null,
          error: null,
        },
      },
    };
  }

  if (action === 'send_lead_reminder') {
    const leadId = String(body.lead_id || '').trim();
    const lRes = await client.query<{
      name: string;
      phone: string;
      source: string | null;
      assigned_email: string | null;
      assigned_name: string | null;
    }>(
      `SELECT l.name, l.phone, l.source, u.email AS assigned_email, u.full_name AS assigned_name
       FROM leads l
       LEFT JOIN users u ON u.tenant_id = l.tenant_id AND u.id = l.assigned_to
       WHERE l.tenant_id = $1 AND l.id = $2
       LIMIT 1`,
      [ctx.tenantId, leadId]
    );
    const lRow = lRes.rows[0];
    let emailNote = 'Đã ghi nhận lệnh nhắc nhở chăm sóc khách hàng.';
    if (lRow?.assigned_email) {
      const tMeta = await getTenantMetaCached(ctx.tenantId, client);
      const brandName = resolveTenantBrandName(cfg, tMeta);
      const slaWarnText = renderTemplateString(cfg.notification_templates.sla_warning_message, {
        brand_name: brandName,
        customer_name: lRow.name,
        phone: lRow.phone,
        sale_name: lRow.assigned_name || 'Chuyên viên',
        sla_minutes: cfg.default_sla_minutes,
        lead_id: `#${leadId.slice(0, 8)}`,
        lead_short_id: leadId.slice(0, 8),
      });
      const mailOut = await sendTenantEmailNotification({
        client,
        tenantId: ctx.tenantId,
        to: lRow.assigned_email,
        category: 'sla_alert',
        subject: `[Nhắc tiếp nhận Lead] ${lRow.name} (${lRow.phone})`,
        text: slaWarnText || `Xin chào ${lRow.assigned_name || 'Chuyên viên'}, Lead ${lRow.name} (${lRow.phone}) đang chờ bạn tiếp nhận & liên hệ ngay.`,
        html: renderEmailHtmlEnvelope({
          badge: 'NHẮC TIẾP NHẬN LEAD',
          accentColor: cfg.brand_email_accent_color || '#F59E0B',
          title: `Lead ${lRow.name} đang chờ tiếp nhận`,
          summaryText:
            slaWarnText ||
            `Xin chào ${lRow.assigned_name || 'Sale/Đại lý'}, Admin vừa gửi nhắc nhở ưu tiên liên hệ khách hàng này trong khung thời gian SLA.`,
          rows: [
            { label: 'Khách hàng', value: lRow.name },
            { label: 'Số điện thoại', value: lRow.phone },
            { label: 'Nguồn', value: lRow.source || 'Direct' },
          ],
          ctaLabel: 'Mở CRM Tiếp nhận ngay',
          ctaUrl: `https://domation.net/data/${ctx.tenantSlug}`,
        }),
        meta: { lead_id: leadId, action: 'send_lead_reminder' },
      }).catch(() => null);
      if (mailOut?.sent && mailOut.provider !== 'silent_guard') {
        emailNote = `Đã gửi email nhắc nhở tới ${lRow.assigned_email}.`;
      }
    }
    await client.query(
      `INSERT INTO lead_timeline_events (tenant_id, lead_id, event_type, event_category, actor_id, actor_role, actor_name, title, content)
       VALUES ($1, $2, 'reminder_sent', 'communication', $3, $4, $5, 'Gửi nhắc nhở tiếp nhận Lead', $6)`,
      [ctx.tenantId, leadId, ctx.userId, ctx.userRole, ctx.userName || ctx.userEmail || 'Admin', emailNote]
    );
    return { success: true, message: emailNote };
  }

  if (action === 'get_sale_portal_data') {
    const isUuid = (v: string) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v);
    const search = String(params.get('search') || '').trim();
    const roundId = String(params.get('round_id') || '').trim();
    const saleIdParam = String(params.get('sale_id') || '').trim();
    const targetUserId =
      ctx.userRole !== 'sale' && saleIdParam && isUuid(saleIdParam) ? saleIdParam : ctx.userId;

    const qParams: unknown[] = [ctx.tenantId, targetUserId];
    let extraWhere = '';
    const hasPortalDate = Boolean(
      params.get('since') ||
        params.get('until') ||
        params.get('start_date') ||
        params.get('end_date') ||
        params.get('date') ||
        params.get('date_mode')
    );
    if (hasPortalDate) {
      const portalDateFilter = buildLegacyDateFilterFromParams(
        params,
        'all',
        params.get('date') ? 'date' : 'date_mode'
      );
      if (portalDateFilter.preset !== 'all') {
        extraWhere += ` AND (${portalDateFilter.bindSql('l.created_at', qParams)})`;
      }
    }
    if (roundId && roundId !== 'all' && isUuid(roundId)) {
      qParams.push(roundId);
      extraWhere += ` AND l.round_id = $${qParams.length}`;
    }
    if (search) {
      qParams.push(`%${search}%`);
      extraWhere += ` AND (l.name ILIKE $${qParams.length} OR l.phone ILIKE $${qParams.length})`;
    }

    const [leadsRes, profRes, mgrsRes, roundsRes, consRes] = await Promise.all([
      client.query(
        `SELECT l.*, u.full_name AS assigned_to_name, u.avatar_url AS assigned_to_avatar,
                r.name AS round_name
         FROM leads l
         LEFT JOIN users u ON u.tenant_id = l.tenant_id AND u.id = l.assigned_to
         LEFT JOIN distribution_rounds r ON r.tenant_id = l.tenant_id AND r.id = l.round_id
         WHERE l.tenant_id = $1 AND l.assigned_to = $2 AND l.is_deleted = false AND l.status != 'archived'
           ${extraWhere}
         ORDER BY l.created_at DESC
         LIMIT 200`,
        qParams
      ),
      client.query(
        `SELECT u.id, u.full_name AS name, u.email, u.phone, u.avatar_url AS avatar,
                p.status, p.is_available, p.vacation_mode, p.work_schedule, p.zalo_chat_id
         FROM users u
         LEFT JOIN tenant_user_profiles p ON p.tenant_id = u.tenant_id AND p.user_id = u.id
         WHERE u.tenant_id = $1 AND u.id = $2
         LIMIT 1`,
        [ctx.tenantId, targetUserId]
      ),
      client.query(
        `SELECT id, consultant_user_id, name, email, phone, zalo_chat_id, zalo_verified, status
         FROM consultant_managers
         WHERE tenant_id = $1 AND consultant_user_id = $2
         ORDER BY created_at ASC`,
        [ctx.tenantId, targetUserId]
      ),
      client.query(
        'SELECT id, name AS round_name, is_active FROM distribution_rounds WHERE tenant_id = $1 ORDER BY priority ASC',
        [ctx.tenantId]
      ),
      client.query(
        `SELECT u.id, u.full_name AS name, u.email, u.avatar_url AS avatar
         FROM users u WHERE u.tenant_id = $1 AND u.role = 'sale' ORDER BY u.full_name ASC`,
        [ctx.tenantId]
      ),
    ]);

    await enrichLeadAssigneeAndRound(client, ctx.tenantId, leadsRes.rows);
    const mappedLeads = leadsRes.rows.map((row) => mapPgLeadRowToLegacy(row, ctx, cfg));
    const roundStatsMap = new Map<string, number>();
    for (const l of mappedLeads) {
      const rn = l.round_name || 'Khác';
      roundStatsMap.set(rn, (roundStatsMap.get(rn) || 0) + 1);
    }

    const tMeta = await getTenantMetaCached(ctx.tenantId, client);
    const configuredBotLink = String(tMeta?.rawSettings?.zalo_bot_link || '').trim() || 'https://zalo.me/';

    const hourlyCounts = Array(24).fill(0);
    for (const l of mappedLeads) {
      const hr = new Date(l.received_at || l.created_at || Date.now()).getHours();
      if (hr >= 0 && hr < 24) hourlyCounts[hr]++;
    }

    const portalPayload = {
      leads: mappedLeads,
      consultant_profile: profRes.rows[0] || null,
      consultant_managers: mgrsRes.rows,
      rounds: roundsRes.rows,
      consultants: consRes.rows,
      is_allowed_to_report: true,
      max_co_managers_per_consultant: cfg.max_co_managers_per_consultant,
      duplicate_check_months: Math.max(1, Math.round((cfg.duplicate_threshold_days || 180) / 30)),
      zalo_bot_link: configuredBotLink,
      stats: {
        total: mappedLeads.length,
        total_received: mappedLeads.length,
        accepted: mappedLeads.filter((l) => l.is_accepted).length,
        pending: mappedLeads.filter((l) => !l.is_accepted).length,
        tickets_total: 0,
        tickets_approved: 0,
        tickets_rejected: 0,
        tickets_pending: 0,
      },
      by_round: Array.from(roundStatsMap.entries()).map(([round_name, count]) => ({ round_name, count })),
      by_hour: hourlyCounts,
    };

    return {
      success: true,
      ...portalPayload,
      data: portalPayload,
    };
  }

  // ============================================================================
  // Gatekeeper Held Leads
  // ============================================================================
  if (action === 'get_held_leads') {
    const page = Math.max(1, Number(params.get('page') || 1));
    const pageSize = Math.min(100, Math.max(1, Number(params.get('pageSize') || 20)));
    const statusParam = String(params.get('status') || 'pending_approval');
    const search = String(params.get('search') || '').trim();
    const offset = (page - 1) * pageSize;

    const statusMap: Record<string, string> = {
      pending_approval: 'held',
      approved: 'approved',
      rejected: 'rejected',
      ai_pending: 'held',
      blacklisted: 'blacklisted',
    };
    const dbStatus = statusMap[statusParam] || 'held';

    const qParams: unknown[] = [ctx.tenantId, dbStatus];
    let searchSql = '';
    if (search) {
      qParams.push(`%${search}%`);
      searchSql = `AND (h.name ILIKE $${qParams.length} OR h.phone ILIKE $${qParams.length} OR COALESCE(h.email,'') ILIKE $${qParams.length})`;
    }
    const hasHeldDate = Boolean(
      params.get('since') || params.get('until') || params.get('start_date') || params.get('end_date') || params.get('date')
    );
    const heldDateFilter = hasHeldDate ? buildLegacyDateFilterFromParams(params, 'all') : null;
    if (heldDateFilter && heldDateFilter.preset !== 'all' && !search) {
      searchSql += ` AND (${heldDateFilter.bindSql('h.created_at', qParams)})`;
    }
    const countsParams: unknown[] = [ctx.tenantId];
    const countsDateWhere =
      heldDateFilter && heldDateFilter.preset !== 'all' && !search
        ? `AND (${heldDateFilter.bindSql('created_at', countsParams)})`
        : '';

    const [rowsRes, countsRes] = await Promise.all([
      client.query(
        `SELECT h.*, dr.name AS round_name
         FROM held_leads h
         LEFT JOIN distribution_rounds dr ON dr.tenant_id = h.tenant_id AND dr.id = h.round_id
         WHERE h.tenant_id = $1 AND h.status = $2 ${searchSql}
         ORDER BY h.created_at DESC
         LIMIT $${qParams.length + 1} OFFSET $${qParams.length + 2}`,
        [...qParams, pageSize, offset]
      ),
      client.query(
        `SELECT
           COALESCE(SUM(CASE WHEN status = 'held' THEN 1 ELSE 0 END), 0) AS queue,
           COALESCE(SUM(CASE WHEN status = 'approved' THEN 1 ELSE 0 END), 0) AS assigned,
           COALESCE(SUM(CASE WHEN status = 'rejected' THEN 1 ELSE 0 END), 0) AS substandard,
           COALESCE(SUM(CASE WHEN status = 'blacklisted' THEN 1 ELSE 0 END), 0) AS blacklisted
         FROM held_leads
         WHERE tenant_id = $1 ${countsDateWhere}`,
        countsParams
      ),
    ]);

    const shouldMaskHeld = ctx.isExternalAgency || ctx.userRole === 'sale';
    return {
      success: true,
      data: rowsRes.rows.map((h) => ({
        id: h.id,
        name: h.name || 'Khách hàng',
        phone: shouldMaskHeld && h.phone ? maskPhoneString(h.phone, cfg) : (h.phone || '-'),
        email: shouldMaskHeld && h.email ? (cfg.pii_mask_email ? maskEmailString(h.email, cfg) : h.email) : (h.email || '-'),
        source: h.source || '-',
        type: h.campaign || 'Lead',
        note: h.hold_reason || h.ai_evaluation || '',
        target_round_id: h.round_id || null,
        round_name: h.round_name || 'Chưa gắn vòng',
        ai_screener_status: h.ai_screener_status || 'pending',
        ai_evaluation: h.ai_evaluation || h.hold_reason || '',
        created_at: formatDateTimeVnSql(h.created_at),
      })),
      total_count: rowsRes.rows.length,
      counts: countsRes.rows[0] || { queue: 0, assigned: 0, substandard: 0, blacklisted: 0 },
    };
  }

  if (action === 'preview_held_lead_assignment') {
    const roundId = params.get('round_id') || '';
    const r = await client.query(
      `SELECT u.id, u.full_name AS name, rc.receive_ratio, rc.leads_received_in_round
       FROM round_consultants rc
       INNER JOIN users u ON u.tenant_id = rc.tenant_id AND u.id = rc.user_id
       WHERE rc.tenant_id = $1 ${roundId ? 'AND rc.round_id = $2' : ''}
       ORDER BY rc.leads_received_in_round ASC
       LIMIT 1`,
      roundId ? [ctx.tenantId, roundId] : [ctx.tenantId]
    );
    return {
      success: true,
      next_consultant: r.rows[0] || null,
    };
  }

  if (action === 'reject_held_lead') {
    if (!ADMIN_OR_MANAGER_ROLES.includes(ctx.userRole) || ctx.isExternalAgency) {
      return { _status: 403, success: false, error: 'Forbidden: manager or admin privileges required' };
    }
    const id = String(body.id || '').trim();
    await client.query(
      `UPDATE held_leads SET status = 'rejected', resolved_by = $3, resolved_at = clock_timestamp(), updated_at = clock_timestamp()
       WHERE tenant_id = $1 AND id = $2`,
      [ctx.tenantId, id, ctx.userId]
    );
    return { success: true, message: 'Đã chuyển Lead vào mục Dưới chuẩn.' };
  }

  if (action === 'blacklist_held_lead') {
    if (!ADMIN_OR_MANAGER_ROLES.includes(ctx.userRole) || ctx.isExternalAgency) {
      return { _status: 403, success: false, error: 'Forbidden: manager or admin privileges required' };
    }
    const id = String(body.id || '').trim();
    const upd = await client.query<{ phone: string }>(
      `UPDATE held_leads SET status = 'blacklisted', resolved_by = $3, resolved_at = clock_timestamp(), updated_at = clock_timestamp()
       WHERE tenant_id = $1 AND id = $2
       RETURNING phone`,
      [ctx.tenantId, id, ctx.userId]
    );
    if (upd.rows[0]?.phone) {
      await client.query(
        `INSERT INTO blacklist_entries (tenant_id, entry_type, value, reason, created_by)
         VALUES ($1, 'phone', $2, 'Chặn từ AI Pre-screener', $3) ON CONFLICT DO NOTHING`,
        [ctx.tenantId, upd.rows[0].phone, ctx.userId]
      );
    }
    return { success: true, message: 'Đã đưa số này vào Blacklist.' };
  }

  // ============================================================================
  // Error Tickets / Reports
  // ============================================================================
  if (action === 'get_reports') {
    const page = Math.max(1, Number(params.get('page') || 1));
    const pageSize = Math.min(100, Math.max(1, Number(params.get('pageSize') || 20)));
    const statusFilter = String(params.get('status') || 'all');
    const consultantFilter = String(params.get('consultant') || '');
    const roundFilter = String(params.get('round_id') || '');
    const offset = (page - 1) * pageSize;

    const qParams: unknown[] = [ctx.tenantId];
    const conds: string[] = ['dr.tenant_id = $1'];
    if (ctx.userRole === 'sale') {
      qParams.push(ctx.userId);
      conds.push(`dr.reporter_id = $${qParams.length}`);
    } else if (consultantFilter && consultantFilter !== 'all') {
      qParams.push(consultantFilter);
      conds.push(`dr.reporter_id::text = $${qParams.length}`);
    }
    if (statusFilter && statusFilter !== 'all') {
      qParams.push(statusFilter);
      conds.push(`dr.status = $${qParams.length}`);
    }
    if (roundFilter && roundFilter !== 'all') {
      qParams.push(roundFilter);
      conds.push(`l.round_id::text = $${qParams.length}`);
    }
    const hasReportDate = Boolean(
      params.get('since') || params.get('until') || params.get('start_date') || params.get('end_date') || params.get('date')
    );
    const reportDateFilter = hasReportDate ? buildLegacyDateFilterFromParams(params, 'all') : null;
    if (reportDateFilter && reportDateFilter.preset !== 'all') {
      conds.push(`(${reportDateFilter.bindSql('dr.created_at', qParams)})`);
    }
    const statsParams: unknown[] = [ctx.tenantId];
    const statsDateWhere =
      reportDateFilter && reportDateFilter.preset !== 'all'
        ? `AND (${reportDateFilter.bindSql('created_at', statsParams)})`
        : '';

    const whereSql = conds.join(' AND ');
    const [rowsRes, statsRes] = await Promise.all([
      client.query(
        `SELECT dr.*, l.name AS lead_name, l.phone AS lead_phone, l.email AS lead_email,
                l.source AS lead_source, l.status AS log_status, l.created_at AS log_received_at,
                l.custom_fields->>'note' AS lead_note, l.ai_screener_status, l.ai_evaluation,
                r.name AS round_name,
                rep.full_name AS consultant_name, rep.avatar_url AS consultant_avatar,
                res.full_name AS resolved_by_name, res.avatar_url AS resolved_by_avatar
         FROM data_reports dr
         LEFT JOIN leads l ON l.tenant_id = dr.tenant_id AND l.id = dr.lead_id
         LEFT JOIN distribution_rounds r ON r.tenant_id = l.tenant_id AND r.id = l.round_id
         LEFT JOIN users rep ON rep.tenant_id = dr.tenant_id AND rep.id = dr.reporter_id
         LEFT JOIN users res ON res.tenant_id = dr.tenant_id AND res.id = dr.resolved_by
         WHERE ${whereSql}
         ORDER BY dr.created_at DESC
         LIMIT $${qParams.length + 1} OFFSET $${qParams.length + 2}`,
        [...qParams, pageSize, offset]
      ),
      client.query(
        `SELECT
           COUNT(*) AS total,
           COALESCE(SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END), 0) AS pending,
           COALESCE(SUM(CASE WHEN status = 'approved' THEN 1 ELSE 0 END), 0) AS approved,
           COALESCE(SUM(CASE WHEN status = 'rejected' THEN 1 ELSE 0 END), 0) AS rejected
         FROM data_reports
         WHERE tenant_id = $1 ${statsDateWhere}`,
        statsParams
      ),
    ]);

    return {
      success: true,
      data: rowsRes.rows.map((r) => ({
        id: r.id,
        lead_id: r.lead_id,
        log_id: r.lead_id,
        consultant_id: r.reporter_id,
        consultant_name: r.consultant_name || 'Đại lý',
        consultant_avatar: r.consultant_avatar,
        lead_name: r.lead_name || 'Khách hàng',
        lead_phone: ctx.isExternalAgency && r.lead_phone ? maskPhoneString(r.lead_phone, cfg) : (r.lead_phone || '-'),
        phone: ctx.isExternalAgency && r.lead_phone ? maskPhoneString(r.lead_phone, cfg) : (r.lead_phone || '-'),
        lead_email: ctx.isExternalAgency && r.lead_email ? (cfg.pii_mask_email ? maskEmailString(r.lead_email, cfg) : r.lead_email) : (r.lead_email || '-'),
        lead_source: r.lead_source || '-',
        lead_type: r.round_name || 'Lead',
        lead_note: r.lead_note || '',
        log_status: r.log_status || 'assigned',
        log_received_at: formatDateTimeVnSql(r.log_received_at),
        round_name: r.round_name || '-',
        reason: r.reason,
        description: r.description || '',
        status: r.status,
        approval_reason: r.status === 'approved' ? r.resolution_note : null,
        reject_reason: r.status === 'rejected' ? r.resolution_note : null,
        resolved_by: r.resolved_by_name,
        resolved_by_avatar: r.resolved_by_avatar,
        resolved_at: formatDateTimeVnSql(r.updated_at),
        created_at: formatDateTimeVnSql(r.created_at),
        compensation_granted: Boolean(r.compensation_granted),
        ai_screener_status: r.ai_screener_status,
        ai_evaluation: r.ai_evaluation,
      })),
      total_count: Number(statsRes.rows[0]?.total || 0),
      stats: statsRes.rows[0] || { total: 0, pending: 0, approved: 0, rejected: 0 },
    };
  }

  if (action === 'submit_report') {
    const leadId = String(body.lead_id || '').trim();
    const reason = String(body.reason || 'Khách hàng không hợp lệ').trim();
    const desc = body.note || body.description ? String(body.note || body.description) : '';
    if (!leadId) return { success: false, message: 'Thiếu ID khách hàng.' };

    if (ctx.userRole === 'sale' || ctx.isExternalAgency) {
      const ownerCheck = await client.query(
        'SELECT id, assigned_to FROM leads WHERE tenant_id = $1 AND id = $2 LIMIT 1',
        [ctx.tenantId, leadId]
      );
      if (!ownerCheck.rows.length) {
        return { _status: 404, success: false, error: 'Lead not found' };
      }
      if (ownerCheck.rows[0].assigned_to !== ctx.userId) {
        return { _status: 403, success: false, error: 'Forbidden: you can only report errors for leads assigned to you' };
      }
    }
    const reporterId = (ctx.userRole === 'sale' || ctx.isExternalAgency) ? ctx.userId : (body.sale_id ? String(body.sale_id) : ctx.userId);

    const ins = await client.query(
      `INSERT INTO data_reports (tenant_id, lead_id, reporter_id, reason, description, status)
       VALUES ($1, $2, $3, $4, $5, 'pending')
       RETURNING *`,
      [ctx.tenantId, leadId, reporterId, reason, desc]
    );
    const adminRow = await client.query<{ email: string }>(
      `SELECT email FROM users WHERE tenant_id = $1 AND role = 'tenant_admin' ORDER BY created_at ASC LIMIT 1`,
      [ctx.tenantId]
    );
    const targetAdminEmail = adminRow.rows[0]?.email;
    if (targetAdminEmail) {
      const tMeta = await getTenantMetaCached(ctx.tenantId, client);
      const brandName = resolveTenantBrandName(cfg, tMeta);
      const renderedSubject =
        renderTemplateString(cfg.notification_templates.ticket_admin_subject, {
          brand_name: brandName,
          lead_id: `#${leadId.slice(0, 8)}`,
          lead_short_id: leadId.slice(0, 8),
          reason,
          sale_name: ctx.userName || 'Sale',
        }) || `[Ticket mới] Yêu cầu báo lỗi Lead #${leadId.slice(0, 8)}`;
      await sendTenantEmailNotification({
        client,
        tenantId: ctx.tenantId,
        to: targetAdminEmail,
        category: 'ticket_admin',
        subject: renderedSubject,
        text: `${ctx.userName || 'Sale'} vừa gửi Ticket báo lỗi: ${reason}. ${desc}`,
        meta: { ticket_id: ins.rows[0]?.id, lead_id: leadId, reason },
      }).catch(() => {});
    }
    return { success: true, data: ins.rows[0], message: 'Đã gửi Ticket báo lỗi thành công.' };
  }

  if (action === 'approve_report') {
    if (!ADMIN_OR_MANAGER_ROLES.includes(ctx.userRole) || ctx.isExternalAgency) {
      return { _status: 403, success: false, error: 'Forbidden: manager or admin privileges required to approve reports' };
    }
    const reportId = String(body.id || '').trim();
    const note = String(body.approval_reason || 'Đã duyệt đền bù theo chính sách').trim();
    const noComp = Boolean(body.no_compensation);

    const existingRep = await client.query<{ reporter_id: string }>(
      'SELECT reporter_id FROM data_reports WHERE tenant_id = $1 AND id = $2 LIMIT 1',
      [ctx.tenantId, reportId]
    );
    if (!existingRep.rows.length) {
      return { _status: 404, success: false, error: 'Report ticket not found' };
    }
    if (existingRep.rows[0].reporter_id === ctx.userId && !['super_admin', 'tenant_admin'].includes(ctx.userRole)) {
      return { _status: 403, success: false, error: 'Forbidden: cannot approve your own report ticket' };
    }

    const upd = await client.query(
      `UPDATE data_reports
       SET status = 'approved', resolved_by = $3, resolution_note = $4,
           compensation_granted = $5, updated_at = clock_timestamp()
       WHERE tenant_id = $1 AND id = $2
       RETURNING *`,
      [ctx.tenantId, reportId, ctx.userId, note, !noComp]
    );
    const rep = upd.rows[0];
    if (rep && !noComp && cfg.enable_compensation_credits) {
      const leadRow = await client.query<{ round_id: string | null }>(
        'SELECT round_id FROM leads WHERE tenant_id = $1 AND id = $2 LIMIT 1',
        [ctx.tenantId, rep.lead_id]
      );
      const roundId = leadRow.rows[0]?.round_id;
      if (roundId) {
        const inc = Math.max(1, Number(cfg.compensation_credits_per_ticket || 1));
        await client.query(
          `UPDATE round_consultants
           SET compensation_count = compensation_count + $4, updated_at = clock_timestamp()
           WHERE tenant_id = $1 AND round_id = $2 AND user_id = $3`,
          [ctx.tenantId, roundId, rep.reporter_id, inc]
        );
        await client.query(
          `INSERT INTO active_compensation_logs (tenant_id, round_id, consultant_user_id, admin_user_id, ticket_id, amount, reason, source_type)
           VALUES ($1, $2, $3, $4, $5, $6, $7, 'ticket')`,
          [ctx.tenantId, roundId, rep.reporter_id, ctx.userId, rep.id, inc, note]
        );
      }
    }
    if (rep?.reporter_id) {
      const sRes = await client.query<{ email: string }>(
        'SELECT email FROM users WHERE tenant_id = $1 AND id = $2 LIMIT 1',
        [ctx.tenantId, rep.reporter_id]
      );
      if (sRes.rows[0]?.email) {
        const tMeta = await getTenantMetaCached(ctx.tenantId, client);
        const brandName = resolveTenantBrandName(cfg, tMeta);
        const leadShortId = String(rep.lead_id || '').slice(0, 8);
        const renderedSubject =
          renderTemplateString(cfg.notification_templates.ticket_approved_subject, {
            brand_name: brandName,
            lead_id: `#${leadShortId}`,
            lead_short_id: leadShortId,
            note,
          }) || `[Đã duyệt Ticket] Hoàn lượt phân bổ Lead #${leadShortId}`;
        await sendTenantEmailNotification({
          client,
          tenantId: ctx.tenantId,
          to: sRes.rows[0].email,
          category: 'ticket_sale_success',
          subject: renderedSubject,
          text: `Ticket báo lỗi của bạn đã được chấp nhận. Ghi chú: ${note}`,
          meta: { ticket_id: rep.id, lead_id: rep.lead_id },
        }).catch(() => {});
      }
    }
    return { success: true, data: rep, message: 'Đã duyệt Ticket báo lỗi!' };
  }

  if (action === 'reject_report') {
    if (!ADMIN_OR_MANAGER_ROLES.includes(ctx.userRole) || ctx.isExternalAgency) {
      return { _status: 403, success: false, error: 'Forbidden: manager or admin privileges required to reject reports' };
    }
    const reportId = String(body.id || '').trim();
    const note = String(body.reject_reason || 'Không đủ điều kiện đền bù').trim();
    const upd = await client.query(
      `UPDATE data_reports
       SET status = 'rejected', resolved_by = $3, resolution_note = $4, updated_at = clock_timestamp()
       WHERE tenant_id = $1 AND id = $2
       RETURNING *`,
      [ctx.tenantId, reportId, ctx.userId, note]
    );
    const rep = upd.rows[0];
    if (rep?.reporter_id) {
      const sRes = await client.query<{ email: string }>(
        'SELECT email FROM users WHERE tenant_id = $1 AND id = $2 LIMIT 1',
        [ctx.tenantId, rep.reporter_id]
      );
      if (sRes.rows[0]?.email) {
        const tMeta = await getTenantMetaCached(ctx.tenantId, client);
        const brandName = resolveTenantBrandName(cfg, tMeta);
        const leadShortId = String(rep.lead_id || '').slice(0, 8);
        const renderedSubject =
          renderTemplateString(cfg.notification_templates.ticket_rejected_subject, {
            brand_name: brandName,
            lead_id: `#${leadShortId}`,
            lead_short_id: leadShortId,
            note,
          }) || `[Từ chối Ticket] Phiếu báo lỗi Lead #${leadShortId}`;
        await sendTenantEmailNotification({
          client,
          tenantId: ctx.tenantId,
          to: sRes.rows[0].email,
          category: 'ticket_sale_fail',
          subject: renderedSubject,
          text: `Ticket báo lỗi của bạn chưa đủ điều kiện phê duyệt. Lý do: ${note}`,
          meta: { ticket_id: rep.id, lead_id: rep.lead_id },
        }).catch(() => {});
      }
    }
    return { success: true, data: rep, message: 'Đã từ chối Ticket báo lỗi.' };
  }

  if (action === 'compensate_approved_no_comp') {
    if (!ADMIN_OR_MANAGER_ROLES.includes(ctx.userRole) || ctx.isExternalAgency) {
      return { _status: 403, success: false, error: 'Forbidden: manager or admin privileges required to compensate reports' };
    }
    const reportId = String(body.id || '').trim();
    const upd = await client.query(
      `UPDATE data_reports SET compensation_granted = true, updated_at = clock_timestamp()
       WHERE tenant_id = $1 AND id = $2 RETURNING *`,
      [ctx.tenantId, reportId]
    );
    return { success: true, data: upd.rows[0], message: 'Đã bổ sung đền bù lượt.' };
  }

  return null;
}
