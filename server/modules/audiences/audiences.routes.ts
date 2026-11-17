import crypto from 'node:crypto';
import { Router } from 'express';
import { withTenantTransaction } from '../../core/database/transaction.ts';
import { getTenantContext } from '../../core/context/tenant-context.ts';
import { tenantRedis } from '../../core/cache/tenant-redis.ts';
import { getTenantSettingsCached } from '../../core/settings/tenant-cache.ts';
import {
  buildGranularScopeWhereClause,
  requireEntitlement,
  requirePermission,
  requireTenantAuth,
  resolveUserEffectivePermissions,
  sendApiError,
} from '../../core/security/rbac.ts';
import { maskContactPiiIfDisallowed } from '../../core/security/pii-masker.ts';
import { emitDomainEvent } from '../../core/events/event-bus.ts';
import { runUnassignedLeadDrainer } from '../../cron/subroutines/lead-drainer.ts';
import { slugifyKeyLower } from '../org-rbac/org-rbac.service.ts';
import { compileSegmentWhereSql } from './segment-compiler.ts';
import {
  evaluateDynamicAudience,
  importRowsIntoAudience,
  parseCsvTextToRows,
  promoteLeadsToSaleRoundInTx,
  refreshAudienceCachedCount,
  splitAudienceIntoParts,
  upsertMasterContactInTx,
} from './audiences.service.ts';

export const audiencesRouter = Router();

audiencesRouter.use(requireTenantAuth);
audiencesRouter.use(requireEntitlement('audiences'));

// ============================================================================
// 1. Dynamic Segment Field Catalog (`/api/v1/audiences/field-catalog`)
// ============================================================================
audiencesRouter.get('/field-catalog', async (_req, res) => {
  try {
    const ctx = getTenantContext();
    const data = await withTenantTransaction(ctx.tenantId, async (client) => {
      const [pipelinesRes, stagesRes, customFieldsRes, roundsRes, tagsRes] = await Promise.all([
        client.query('SELECT id, name, is_default FROM tenant_pipelines WHERE tenant_id = $1 ORDER BY is_default DESC', [
          ctx.tenantId,
        ]),
        client.query(
          `SELECT id, pipeline_id, stage_key, stage_name, funnel_category, is_won_stage, is_lost_stage
           FROM tenant_pipeline_stages WHERE tenant_id = $1 ORDER BY stage_order ASC`,
          [ctx.tenantId]
        ),
        client.query(
          `SELECT DISTINCT field_key, field_label, field_type, options_json
           FROM tenant_pipeline_custom_fields WHERE tenant_id = $1 ORDER BY field_key ASC`,
          [ctx.tenantId]
        ),
        client.query('SELECT id, name, pipeline_id FROM distribution_rounds WHERE tenant_id = $1 ORDER BY priority ASC', [
          ctx.tenantId,
        ]),
        client.query('SELECT id, name, slug, color_hex FROM tenant_tags WHERE tenant_id = $1 ORDER BY name ASC', [
          ctx.tenantId,
        ]),
      ]);

      const standardFields = [
        { group: 'profile', key: 'name', label: 'Họ tên', type: 'text' },
        { group: 'profile', key: 'phone', label: 'Số điện thoại', type: 'text' },
        { group: 'profile', key: 'email', label: 'Email', type: 'text' },
        { group: 'profile', key: 'source', label: 'Nguồn thu thập', type: 'text' },
        { group: 'profile', key: 'campaign', label: 'Chiến dịch', type: 'text' },
        { group: 'profile', key: 'utm_source', label: 'UTM Source', type: 'text' },
        { group: 'profile', key: 'product_interest', label: 'Sản phẩm / Nhu cầu quan tâm', type: 'text' },
        {
          group: 'profile',
          key: 'lifecycle_stage',
          label: 'Giai đoạn vòng đời',
          type: 'select',
          options: ['subscriber', 'lead', 'mql', 'sql', 'opportunity', 'customer', 'evangelist', 'disqualified'],
        },
        { group: 'profile', key: 'lead_score', label: 'Điểm nóng (Lead Score)', type: 'number' },
        {
          group: 'profile',
          key: 'email_consent',
          label: 'Trạng thái nhận Email',
          type: 'select',
          options: ['subscribed', 'unsubscribed', 'bounced', 'complained'],
        },
        {
          group: 'profile',
          key: 'zns_consent',
          label: 'Trạng thái nhận Zalo ZNS',
          type: 'select',
          options: ['opted_in', 'opted_out'],
        },
        { group: 'profile', key: 'tag', label: 'Nhãn phân loại (Tag)', type: 'tag' },
        {
          group: 'crm',
          key: 'status',
          label: 'Trạng thái xử lý',
          type: 'select',
          options: ['marketing_nurture', 'unassigned_pending', 'assigned', 'recalled', 'archived'],
        },
        { group: 'crm', key: 'pipeline_id', label: 'Thuộc Pipeline', type: 'pipeline' },
        { group: 'crm', key: 'stage_id', label: 'Bước Pipeline (Stage)', type: 'stage' },
        {
          group: 'crm',
          key: 'funnel_category',
          label: 'Nhóm phễu chuẩn hóa',
          type: 'select',
          options: ['new_uncontacted', 'engaged_qualified', 'negotiation_proposal', 'closed_won', 'closed_lost', 'nurturing'],
        },
        { group: 'crm', key: 'sla_breached', label: 'Vi phạm SLA', type: 'boolean' },
        { group: 'crm', key: 'inactive_days', label: 'Số ngày chưa tương tác', type: 'number' },
        { group: 'marketing', key: 'opened_email', label: 'Đã mở Email Marketing', type: 'event' },
        { group: 'marketing', key: 'clicked_email', label: 'Đã click link trong Email', type: 'event' },
        { group: 'marketing', key: 'submitted_form', label: 'Đã điền Form đăng ký', type: 'event' },
        { group: 'marketing', key: 'completed_survey', label: 'Đã hoàn thành Khảo sát / Quiz', type: 'event' },
        { group: 'marketing', key: 'quiz_score', label: 'Điểm bài Quiz', type: 'number' },
        { group: 'marketing', key: 'visited_url', label: 'Đã truy cập trang Web', type: 'event' },
        { group: 'marketing', key: 'claimed_voucher', label: 'Đã nhận mã Voucher', type: 'event' },
        { group: 'revenue', key: 'total_revenue_vnd', label: 'Tổng doanh thu thực thu (VNĐ)', type: 'currency' },
        { group: 'revenue', key: 'is_won_stage', label: 'Đã chốt thành công (Won)', type: 'boolean' },
      ];

      const normalizedFields: Array<{
        key: string;
        label: string;
        layer: 'profile' | 'crm' | 'marketing' | 'revenue';
        valueType: 'text' | 'number' | 'select' | 'boolean';
        options?: Array<{ value: string; label: string }>;
      }> = standardFields.map((sf) => {
        const layer = sf.group as 'profile' | 'crm' | 'marketing' | 'revenue';
        if (sf.type === 'pipeline') {
          return {
            key: sf.key,
            label: sf.label,
            layer,
            valueType: 'select',
            options: pipelinesRes.rows.map((p: any) => ({ value: String(p.id), label: String(p.name) })),
          };
        }
        if (sf.type === 'stage') {
          return {
            key: sf.key,
            label: sf.label,
            layer,
            valueType: 'select',
            options: stagesRes.rows.map((s: any) => ({ value: String(s.id), label: String(s.stage_name) })),
          };
        }
        if (sf.type === 'tag') {
          return {
            key: sf.key,
            label: sf.label,
            layer,
            valueType: tagsRes.rows.length > 0 ? 'select' : 'text',
            options:
              tagsRes.rows.length > 0
                ? tagsRes.rows.map((t: any) => ({ value: String(t.slug || t.name), label: String(t.name) }))
                : undefined,
          };
        }
        if (sf.type === 'event' || sf.type === 'boolean') {
          return {
            key: sf.key,
            label: sf.label,
            layer,
            valueType: 'boolean',
            options: [
              { value: 'true', label: 'Có (True)' },
              { value: 'false', label: 'Không (False)' },
            ],
          };
        }
        if (sf.type === 'number' || sf.type === 'currency') {
          return {
            key: sf.key,
            label: sf.label,
            layer,
            valueType: 'number',
          };
        }
        if (sf.type === 'select' && Array.isArray(sf.options)) {
          return {
            key: sf.key,
            label: sf.label,
            layer,
            valueType: 'select',
            options: sf.options.map((o) => ({ value: String(o), label: String(o) })),
          };
        }
        return {
          key: sf.key,
          label: sf.label,
          layer,
          valueType: 'text',
        };
      });

      for (const cf of customFieldsRes.rows) {
        const cfOptions = Array.isArray(cf.options_json)
          ? cf.options_json.map((o: any) =>
              typeof o === 'object' && o !== null
                ? { value: String(o.value ?? o.label ?? ''), label: String(o.label ?? o.value ?? '') }
                : { value: String(o), label: String(o) }
            )
          : undefined;
        normalizedFields.push({
          key: `custom_fields.${cf.field_key}`,
          label: `${cf.field_label || cf.field_key} (Trường tùy chỉnh)`,
          layer: 'profile',
          valueType:
            cf.field_type === 'number'
              ? 'number'
              : cfOptions && cfOptions.length > 0
                ? 'select'
                : 'text',
          options: cfOptions,
        });
      }

      return {
        fields: normalizedFields,
        standard_fields: standardFields,
        pipelines: pipelinesRes.rows,
        stages: stagesRes.rows,
        custom_fields: customFieldsRes.rows.map((cf) => ({
          ...cf,
          filter_key: `custom_fields.${cf.field_key}`,
        })),
        rounds: roundsRes.rows,
        tags: tagsRes.rows,
      };
    });

    res.json({ success: true, data });
  } catch (err: any) {
    sendApiError(res, 500, 'FIELD_CATALOG_FAILED', err?.message || 'Không thể tải danh mục trường lọc Tệp Logic.');
  }
});

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function cleanParam(v: unknown): string | null {
  if (v === undefined || v === null) return null;
  const s = String(v).trim();
  if (!s || ['all', 'undefined', 'null'].includes(s.toLowerCase())) return null;
  return s;
}

function parseCriteriaInput(raw: unknown): unknown {
  if (typeof raw === 'string') {
    const trimmed = raw.trim();
    if (!trimmed) return [];
    try {
      return JSON.parse(trimmed);
    } catch {
      return [];
    }
  }
  return raw;
}

// ============================================================================
// 2. Live Preview for "Tệp Logic" AST (`POST /api/v1/audiences/preview`)
// ============================================================================
audiencesRouter.post('/preview', requirePermission('audiences', 'view'), async (req, res) => {
  try {
    const ctx = getTenantContext();
    const cfg = await getTenantSettingsCached(ctx.tenantId);
    const { filter_branches, criteria, groups, audience_id, exclude_audience_ids, limit = 20 } = req.body || {};
    const rawBranches = parseCriteriaInput(filter_branches ?? criteria ?? groups ?? []);
    const safeLimit = Math.min(100, Math.max(1, Number(limit || 20)));

    const data = await withTenantTransaction(ctx.tenantId, async (client) => {
      const rbac = await resolveUserEffectivePermissions(client, ctx.tenantId, ctx.userId);
      const canUnmask = Boolean(
        rbac.effectivePermissions.audiences?.actions.unmask_phone &&
          rbac.effectivePermissions.leads?.actions.unmask_phone
      );

      const compiled = compileSegmentWhereSql(ctx.tenantId, rawBranches, {
        audienceIdForExclusions: audience_id ? String(audience_id) : null,
        extraExcludeAudienceIds: Array.isArray(exclude_audience_ids) ? exclude_audience_ids : undefined,
      });

      const [cntRes, sampleRes] = await Promise.all([
        client.query<{ cnt: number }>(
          `SELECT COUNT(*)::int AS cnt
           FROM leads l
           LEFT JOIN tenant_pipeline_stages s ON s.tenant_id = l.tenant_id AND s.id = l.stage_id
           WHERE ${compiled.whereClause}`,
          compiled.params
        ),
        client.query(
          `SELECT l.id, l.name, l.phone, l.email, l.source, l.campaign, l.status,
                  l.lifecycle_stage, l.lead_score, l.email_consent, l.zns_consent,
                  l.total_revenue_vnd, l.custom_fields, l.last_engaged_at, l.created_at,
                  s.stage_name, s.color_hex
           FROM leads l
           LEFT JOIN tenant_pipeline_stages s ON s.tenant_id = l.tenant_id AND s.id = l.stage_id
           WHERE ${compiled.whereClause}
           ORDER BY l.lead_score DESC, l.created_at DESC
           LIMIT ${safeLimit}`,
          compiled.params
        ),
      ]);

      const maskedSamples = sampleRes.rows.map((row) => maskContactPiiIfDisallowed(row, canUnmask, cfg));
      const count = Number(cntRes.rows[0]?.cnt || 0);

      return {
        count,
        total: count,
        has_rules: compiled.hasRules,
        items: maskedSamples,
        sample_members: maskedSamples,
      };
    });

    res.json({ success: true, data });
  } catch (err: any) {
    sendApiError(res, 500, 'PREVIEW_SEGMENT_FAILED', err?.message || 'Không thể chạy thử điều kiện Tệp Logic.');
  }
});

// ============================================================================
// 3. Master Contact 360° Directory & Tags (`/contacts`, `/tags`)
// ============================================================================
audiencesRouter.get('/contacts', requirePermission('audiences', 'view'), async (req, res) => {
  try {
    const ctx = getTenantContext();
    const cfg = await getTenantSettingsCached(ctx.tenantId);
    const statusFilter = cleanParam(req.query.status);
    const lifecycleFilter = cleanParam(req.query.lifecycle_stage);
    const tagFilterRaw = cleanParam(req.query.tag_id) || cleanParam(req.query.tag);
    const salespersonFilter = cleanParam(req.query.salesperson);
    const listIdFilter = cleanParam(req.query.list_id);
    const segmentIdFilter = cleanParam(req.query.segment_id);
    const hasPhoneOnly = String(req.query.has_phone || '').trim() === '1';
    const sortParam = String(req.query.sort || '').trim().toLowerCase();
    const search = cleanParam(req.query.search);
    const page = Math.max(1, Number(req.query.page || 1));
    const limit = Math.min(200, Math.max(1, Number(req.query.limit || 50)));
    const offset = (page - 1) * limit;

    const data = await withTenantTransaction(ctx.tenantId, async (client) => {
      const rbac = await resolveUserEffectivePermissions(client, ctx.tenantId, ctx.userId);
      const audPerm = rbac.effectivePermissions.audiences;
      const canUnmask = Boolean(
        audPerm?.actions.unmask_phone && rbac.effectivePermissions.leads?.actions.unmask_phone
      );

      // Build data scope clause (allowing Marketing nurture contacts with `assigned_to IS NULL` when scope >= department/company)
      const scopeInfo = rbac.userOrg
        ? await buildGranularScopeWhereClause(client, ctx.tenantId, rbac.userOrg, audPerm?.scope || 'own', {
            tenantColumn: 'l.tenant_id',
            ownerColumn: 'l.assigned_to',
            startParamIndex: 1,
            allowUnassignedForManagers: true,
          })
        : { clause: 'l.tenant_id = $1', values: [ctx.tenantId] as unknown[], nextIndex: 2 };

      const params = [...scopeInfo.values];
      let where = `${scopeInfo.clause} AND l.is_deleted = false`;

      if (statusFilter) {
        params.push(statusFilter);
        where += ` AND l.status = $${params.length}`;
      }
      if (lifecycleFilter) {
        params.push(lifecycleFilter);
        where += ` AND l.lifecycle_stage = $${params.length}`;
      }
      if (tagFilterRaw) {
        const tagParts = tagFilterRaw
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean);
        if (tagParts.length > 0) {
          const tagLowerParts = tagParts.map((s) => s.toLowerCase());
          params.push(tagParts);
          const rawIdx = `$${params.length}`;
          params.push(tagLowerParts);
          const lowerIdx = `$${params.length}`;
          where += ` AND EXISTS (
            SELECT 1 FROM lead_tags lt
            INNER JOIN tenant_tags tt ON tt.tenant_id = lt.tenant_id AND tt.id = lt.tag_id
            WHERE lt.tenant_id = $1 AND lt.lead_id = l.id
              AND (lt.tag_id::text = ANY(${rawIdx}::text[]) OR LOWER(tt.slug) = ANY(${lowerIdx}::text[]) OR LOWER(tt.name) = ANY(${lowerIdx}::text[]))
          )`;
        }
      }
      if (salespersonFilter && UUID_REGEX.test(salespersonFilter)) {
        params.push(salespersonFilter);
        where += ` AND l.assigned_to = $${params.length}::uuid`;
      }
      if (hasPhoneOnly) {
        where += ` AND COALESCE(TRIM(l.phone), '') <> ''`;
      }
      if (listIdFilter && UUID_REGEX.test(listIdFilter)) {
        params.push(listIdFilter);
        where += ` AND EXISTS (SELECT 1 FROM tenant_audience_members tam_l WHERE tam_l.tenant_id = $1 AND tam_l.audience_id = $${params.length}::uuid AND tam_l.lead_id = l.id)`;
      }
      if (segmentIdFilter && UUID_REGEX.test(segmentIdFilter)) {
        const segRowRes = await client.query<{ audience_type: string; filter_branches: unknown }>(
          'SELECT audience_type, filter_branches FROM tenant_audiences WHERE tenant_id = $1 AND id = $2::uuid LIMIT 1',
          [ctx.tenantId, segmentIdFilter]
        );
        const segRow = segRowRes.rows[0];
        if (!segRow) {
          where += ' AND 1 = 0';
        } else if (segRow.audience_type === 'dynamic_logic') {
          const parsedBranches = parseCriteriaInput(segRow.filter_branches);
          const segCompiled = compileSegmentWhereSql(ctx.tenantId, parsedBranches);
          const matchedRes = await client.query<{ id: string }>(
            `SELECT l.id
             FROM leads l
             LEFT JOIN tenant_pipeline_stages s ON s.tenant_id = l.tenant_id AND s.id = l.stage_id
             WHERE ${segCompiled.whereClause}`,
            segCompiled.params
          );
          const matchedIds = matchedRes.rows.map((r) => String(r.id));
          if (matchedIds.length === 0) {
            where += ' AND 1 = 0';
          } else {
            params.push(matchedIds);
            where += ` AND l.id::text = ANY($${params.length}::text[])`;
          }
        } else {
          params.push(segmentIdFilter);
          where += ` AND EXISTS (SELECT 1 FROM tenant_audience_members tam_s WHERE tam_s.tenant_id = $1 AND tam_s.audience_id = $${params.length}::uuid AND tam_s.lead_id = l.id)`;
        }
      }
      if (search) {
        params.push(`%${search}%`);
        const pIdx = `$${params.length}`;
        where += ` AND (l.name ILIKE ${pIdx} OR COALESCE(l.phone, '') ILIKE ${pIdx} OR COALESCE(l.email, '') ILIKE ${pIdx} OR COALESCE(l.campaign, '') ILIKE ${pIdx})`;
      }

      const orderByClause =
        sortParam === 'oldest'
          ? 'l.created_at ASC'
          : sortParam === 'score_desc' || sortParam === 'lead_score'
            ? 'l.lead_score DESC NULLS LAST, l.created_at DESC'
            : 'l.created_at DESC';

      const [cntRes, rowsRes] = await Promise.all([
        client.query<{ total: number }>(`SELECT COUNT(*)::int AS total FROM leads l WHERE ${where}`, params),
        client.query(
          `SELECT l.id, l.pipeline_id, l.stage_id, l.assigned_to, l.status, l.lifecycle_stage,
                  l.name, l.phone, l.email, l.lead_score, l.email_consent, l.zns_consent,
                  l.total_revenue_vnd, l.source, l.campaign, l.product_interest, l.custom_fields,
                  l.last_engaged_at, l.created_at, l.updated_at,
                  s.stage_name, s.color_hex
           FROM leads l
           LEFT JOIN tenant_pipeline_stages s ON s.tenant_id = l.tenant_id AND s.id = l.stage_id
           WHERE ${where}
           ORDER BY ${orderByClause}
           LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
          [...params, limit, offset]
        ),
      ]);

      // Attach tags per contact in a single batch query
      const leadIds = rowsRes.rows.map((r) => r.id);
      const tagsMap = new Map<string, any[]>();
      if (leadIds.length > 0) {
        const placeholders = leadIds.map((_, i) => `$${i + 2}`).join(', ');
        const ltRes = await client.query(
          `SELECT lt.lead_id, tt.id, tt.name, tt.slug, tt.color_hex
           FROM lead_tags lt
           INNER JOIN tenant_tags tt ON tt.tenant_id = lt.tenant_id AND tt.id = lt.tag_id
           WHERE lt.tenant_id = $1 AND lt.lead_id IN (${placeholders})`,
          [ctx.tenantId, ...leadIds]
        );
        for (const t of ltRes.rows) {
          const arr = tagsMap.get(t.lead_id) || [];
          arr.push({ id: t.id, name: t.name, slug: t.slug, color_hex: t.color_hex });
          tagsMap.set(t.lead_id, arr);
        }
      }

      const items = rowsRes.rows.map((row) =>
        maskContactPiiIfDisallowed(
          {
            ...row,
            total_revenue_vnd: Number(row.total_revenue_vnd || 0),
            tags: tagsMap.get(row.id) || [],
          },
          canUnmask,
          cfg
        )
      );

      const total = Number(cntRes.rows[0]?.total || 0);
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
    sendApiError(res, 500, 'LIST_CONTACTS_FAILED', err?.message || 'Không thể tải danh bạ Master Contact 360°.');
  }
});

audiencesRouter.post('/contacts', requirePermission('audiences', 'create'), async (req, res) => {
  try {
    const ctx = getTenantContext();
    const cfg = await getTenantSettingsCached(ctx.tenantId);
    const b = req.body || {};
    const targetStatus: 'marketing_nurture' | 'unassigned_pending' =
      b.push_to_sale === true || b.status === 'unassigned_pending'
        ? 'unassigned_pending'
        : 'marketing_nurture';

    const out = await withTenantTransaction(ctx.tenantId, async (client) => {
      const upserted = await upsertMasterContactInTx(client, ctx.tenantId, b, {
        defaultStatus: targetStatus,
        defaultSource: b.source || 'Marketing Contact',
        dialCode: cfg.default_dial_code,
      });

      if (b.audience_id) {
        await client.query(
          `INSERT INTO tenant_audience_members (id, tenant_id, audience_id, lead_id, source_type, metadata)
           VALUES ($1, $2, $3, $4, 'manual', '{}'::jsonb)
           ON CONFLICT (tenant_id, audience_id, lead_id) DO NOTHING`,
          [crypto.randomUUID(), ctx.tenantId, b.audience_id, upserted.leadId]
        );
        await refreshAudienceCachedCount(client, ctx.tenantId, String(b.audience_id));
      }

      if (Array.isArray(b.tag_ids)) {
        for (const tid of b.tag_ids) {
          if (!tid) continue;
          await client.query(
            `INSERT INTO lead_tags (id, tenant_id, lead_id, tag_id, assigned_by)
             VALUES ($1, $2, $3, $4, $5)
             ON CONFLICT (tenant_id, lead_id, tag_id) DO NOTHING`,
            [crypto.randomUUID(), ctx.tenantId, upserted.leadId, tid, ctx.userId]
          );
        }
      }

      const r = await client.query('SELECT * FROM leads WHERE tenant_id = $1 AND id = $2', [
        ctx.tenantId,
        upserted.leadId,
      ]);
      return { contact: r.rows[0], created: upserted.created };
    });

    await emitDomainEvent(out.created ? 'lead.created' : 'lead.updated', {
      tenantId: ctx.tenantId,
      leadId: out.contact.id,
      status: out.contact.status,
      lifecycleStage: out.contact.lifecycle_stage,
      source: out.contact.source,
      actorId: ctx.userId,
    });

    if (targetStatus === 'unassigned_pending') {
      await runUnassignedLeadDrainer(ctx.tenantId).catch(() => {});
    }

    res.status(out.created ? 201 : 200).json({ success: true, data: out.contact });
  } catch (err: any) {
    if (err?.message === 'CONTACT_REQUIRES_PHONE_OR_EMAIL') {
      sendApiError(res, 422, 'CONTACT_REQUIRES_PHONE_OR_EMAIL', 'Khách hàng phải có ít nhất Số điện thoại hoặc Email hợp lệ.');
      return;
    }
    sendApiError(res, 500, 'CREATE_CONTACT_FAILED', err?.message || 'Không thể lưu hồ sơ khách hàng.');
  }
});

// Tags CRUD
audiencesRouter.get('/tags', async (_req, res) => {
  try {
    const ctx = getTenantContext();
    const rows = await withTenantTransaction(ctx.tenantId, async (client) => {
      const r = await client.query(
        `SELECT tt.*,
                (SELECT COUNT(*)::int FROM lead_tags lt WHERE lt.tenant_id = tt.tenant_id AND lt.tag_id = tt.id) AS usage_count
         FROM tenant_tags tt
         WHERE tt.tenant_id = $1
         ORDER BY tt.name ASC`,
        [ctx.tenantId]
      );
      return r.rows;
    });
    res.json({ success: true, data: rows });
  } catch (err: any) {
    sendApiError(res, 500, 'LIST_TAGS_FAILED', err?.message || 'Không thể tải danh sách nhãn (Tags).');
  }
});

audiencesRouter.post('/tags', requirePermission('audiences', 'create'), async (req, res) => {
  try {
    const ctx = getTenantContext();
    const b = req.body || {};
    const name = String(b.name || '').trim();
    if (!name) {
      sendApiError(res, 422, 'VALIDATION_ERROR', 'Tên nhãn không được để trống.');
      return;
    }
    const slug = slugifyKeyLower(b.slug || name, 'tag');
    const id = crypto.randomUUID();

    const saved = await withTenantTransaction(ctx.tenantId, async (client) => {
      await client.query(
        `INSERT INTO tenant_tags (id, tenant_id, name, slug, color_hex, category, description)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         ON CONFLICT (tenant_id, slug) DO UPDATE SET
           name = EXCLUDED.name,
           color_hex = EXCLUDED.color_hex,
           updated_at = clock_timestamp()`,
        [
          id,
          ctx.tenantId,
          name,
          slug,
          String(b.color_hex || '#1E40FF').trim(),
          String(b.category || 'general').trim(),
          b.description ? String(b.description).trim() : null,
        ]
      );
      const r = await client.query('SELECT * FROM tenant_tags WHERE tenant_id = $1 AND slug = $2 LIMIT 1', [
        ctx.tenantId,
        slug,
      ]);
      return r.rows[0];
    });
    res.status(201).json({ success: true, data: saved });
  } catch (err: any) {
    sendApiError(res, 500, 'CREATE_TAG_FAILED', err?.message || 'Không thể tạo nhãn.');
  }
});

const updateTagHandler = async (req: any, res: any) => {
  try {
    const ctx = getTenantContext();
    const b = req.body || {};
    const updated = await withTenantTransaction(ctx.tenantId, async (client) => {
      const r = await client.query(
        `UPDATE tenant_tags
         SET name = COALESCE($3, name),
             color_hex = COALESCE($4, color_hex),
             category = COALESCE($5, category),
             description = CASE WHEN $6::boolean THEN $7 ELSE description END,
             updated_at = clock_timestamp()
         WHERE tenant_id = $1 AND id = $2
         RETURNING *`,
        [
          ctx.tenantId,
          req.params.tagId,
          b.name ? String(b.name).trim() : null,
          b.color_hex ? String(b.color_hex).trim() : null,
          b.category ? String(b.category).trim() : null,
          b.description !== undefined,
          b.description ? String(b.description).trim() : null,
        ]
      );
      return r.rows[0] || null;
    });
    if (!updated) {
      sendApiError(res, 404, 'TAG_NOT_FOUND', 'Không tìm thấy nhãn.');
      return;
    }
    res.json({ success: true, data: updated });
  } catch (err: any) {
    sendApiError(res, 500, 'UPDATE_TAG_FAILED', err?.message || 'Không thể cập nhật nhãn.');
  }
};

audiencesRouter.put('/tags/:tagId', requirePermission('audiences', 'edit'), updateTagHandler);
audiencesRouter.patch('/tags/:tagId', requirePermission('audiences', 'edit'), updateTagHandler);

audiencesRouter.delete(['/tags/:tagId', '/tags'], requirePermission('audiences', 'delete'), async (req, res) => {
  try {
    const ctx = getTenantContext();
    const tagId = String(req.params.tagId || req.query.id || req.body?.id || '').trim();
    if (!tagId) {
      sendApiError(res, 422, 'MISSING_TAG_ID', 'Cần cung cấp ID nhãn cần xóa.');
      return;
    }
    await withTenantTransaction(ctx.tenantId, async (client) => {
      await client.query('DELETE FROM tenant_tags WHERE tenant_id = $1 AND id = $2', [ctx.tenantId, tagId]);
    });
    res.json({ success: true, data: { deleted: true, id: tagId } });
  } catch (err: any) {
    sendApiError(res, 500, 'DELETE_TAG_FAILED', err?.message || 'Không thể xóa nhãn.');
  }
});

audiencesRouter.post('/contacts/:leadId/tags', requirePermission('audiences', 'edit'), async (req, res) => {
  try {
    const ctx = getTenantContext();
    const leadId = req.params.leadId;
    const tagIds: string[] = Array.isArray(req.body?.tag_ids)
      ? req.body.tag_ids
      : req.body?.tag_id
        ? [req.body.tag_id]
        : [];
    await withTenantTransaction(ctx.tenantId, async (client) => {
      for (const tid of tagIds) {
        if (!tid) continue;
        await client.query(
          `INSERT INTO lead_tags (id, tenant_id, lead_id, tag_id, assigned_by)
           VALUES ($1, $2, $3, $4, $5)
           ON CONFLICT (tenant_id, lead_id, tag_id) DO NOTHING`,
          [crypto.randomUUID(), ctx.tenantId, leadId, String(tid), ctx.userId]
        );
      }
    });
    await emitDomainEvent('lead.updated', {
      tenantId: ctx.tenantId,
      leadId,
      changedFields: ['tags'],
      actorId: ctx.userId,
    });
    res.json({ success: true, data: { lead_id: leadId, tag_ids: tagIds } });
  } catch (err: any) {
    sendApiError(res, 500, 'ASSIGN_TAG_FAILED', err?.message || 'Không thể gắn nhãn cho khách hàng.');
  }
});

audiencesRouter.delete('/contacts/:leadId/tags/:tagId', requirePermission('audiences', 'edit'), async (req, res) => {
  try {
    const ctx = getTenantContext();
    await withTenantTransaction(ctx.tenantId, async (client) => {
      await client.query('DELETE FROM lead_tags WHERE tenant_id = $1 AND lead_id = $2 AND tag_id = $3', [
        ctx.tenantId,
        req.params.leadId,
        req.params.tagId,
      ]);
    });
    await emitDomainEvent('lead.updated', {
      tenantId: ctx.tenantId,
      leadId: req.params.leadId,
      changedFields: ['tags'],
      actorId: ctx.userId,
    });
    res.json({ success: true, data: { deleted: true } });
  } catch (err: any) {
    sendApiError(res, 500, 'REMOVE_TAG_FAILED', err?.message || 'Không thể gỡ nhãn khỏi khách hàng.');
  }
});

// ============================================================================
// 4. Audiences ("Tệp Data" & "Tệp Logic") CRUD & Operations
// ============================================================================
audiencesRouter.get('/', requirePermission('audiences', 'view'), async (req, res) => {
  try {
    const ctx = getTenantContext();
    const typeFilter = req.query.type || req.query.audience_type
      ? String(req.query.type || req.query.audience_type).trim()
      : null;
    const search = req.query.search ? String(req.query.search).trim() : null;

    const data = await withTenantTransaction(ctx.tenantId, async (client) => {
      const params: unknown[] = [ctx.tenantId];
      let where = 'a.tenant_id = $1';
      if (typeFilter) {
        params.push(typeFilter);
        where += ` AND a.audience_type = $${params.length}`;
      }
      if (search) {
        params.push(`%${search}%`);
        where += ` AND (a.name ILIKE $${params.length} OR COALESCE(a.description, '') ILIKE $${params.length})`;
      }

      const [audRes, sumRes] = await Promise.all([
        client.query(
          `SELECT a.*, dr.name AS target_round_name
           FROM tenant_audiences a
           LEFT JOIN distribution_rounds dr ON dr.tenant_id = a.tenant_id AND dr.id = a.target_round_id
           WHERE ${where}
           ORDER BY a.created_at DESC`,
          params
        ),
        client.query<{
          total_contacts: number;
          nurture_contacts: number;
          static_count: number;
          dynamic_count: number;
          tags_count: number;
        }>(
          `SELECT
             (SELECT COUNT(*)::int FROM leads WHERE tenant_id = $1 AND is_deleted = false) AS total_contacts,
             (SELECT COUNT(*)::int FROM leads WHERE tenant_id = $1 AND is_deleted = false AND status = 'marketing_nurture') AS nurture_contacts,
             (SELECT COUNT(*)::int FROM tenant_audiences WHERE tenant_id = $1 AND audience_type IN ('static_data', 'sync_data')) AS static_count,
             (SELECT COUNT(*)::int FROM tenant_audiences WHERE tenant_id = $1 AND audience_type = 'dynamic_logic') AS dynamic_count,
             (SELECT COUNT(*)::int FROM tenant_tags WHERE tenant_id = $1) AS tags_count`,
          [ctx.tenantId]
        ),
      ]);

      return {
        items: audRes.rows,
        summary: sumRes.rows[0] || {
          total_contacts: 0,
          nurture_contacts: 0,
          static_count: 0,
          dynamic_count: 0,
          tags_count: 0,
        },
      };
    });

    res.json({ success: true, data });
  } catch (err: any) {
    sendApiError(res, 500, 'LIST_AUDIENCES_FAILED', err?.message || 'Không thể tải danh sách Tệp khách hàng.');
  }
});

audiencesRouter.post('/', requirePermission('audiences', 'create'), async (req, res) => {
  try {
    const ctx = getTenantContext();
    const b = req.body || {};
    const name = String(b.name || '').trim();
    if (!name) {
      sendApiError(res, 422, 'VALIDATION_ERROR', 'Tên Tệp khách hàng không được để trống.');
      return;
    }

    const validTypes = new Set(['static_data', 'sync_data', 'dynamic_logic']);
    const parsedFilterBranches =
      b.filter_branches !== undefined
        ? parseCriteriaInput(b.filter_branches)
        : b.criteria !== undefined
          ? parseCriteriaInput(b.criteria)
          : [];
    const audType = validTypes.has(String(b.audience_type || ''))
      ? String(b.audience_type)
      : b.criteria !== undefined
        ? 'dynamic_logic'
        : 'static_data';
    const id = crypto.randomUUID();

    const created = await withTenantTransaction(ctx.tenantId, async (client) => {
      await client.query(
        `INSERT INTO tenant_audiences (
           id, tenant_id, name, description, audience_type, filter_branches, sync_config,
           cached_member_count, auto_push_to_sale_round, target_round_id, color_hex, is_active, created_by
         ) VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7::jsonb, 0, $8, $9, $10, $11, $12)`,
        [
          id,
          ctx.tenantId,
          name,
          b.description ? String(b.description).trim() : null,
          audType,
          JSON.stringify(parsedFilterBranches ?? []),
          JSON.stringify(b.sync_config && typeof b.sync_config === 'object' ? b.sync_config : {}),
          Boolean(b.auto_push_to_sale_round),
          b.target_round_id || null,
          String(b.color_hex || '#1E40FF').trim(),
          b.is_active !== false,
          ctx.userId,
        ]
      );

      // Optional initial static seeding (from explicit lead_ids or CRM filter)
      if (audType !== 'dynamic_logic') {
        const seedIds: string[] = Array.isArray(b.initial_lead_ids)
          ? b.initial_lead_ids
          : Array.isArray(b.lead_ids)
            ? b.lead_ids
            : [];
        if (b.crm_filter) {
          const crmCompiled = compileSegmentWhereSql(ctx.tenantId, b.crm_filter);
          if (crmCompiled.hasRules) {
            const matched = await client.query<{ id: string }>(
              `SELECT l.id FROM leads l
               LEFT JOIN tenant_pipeline_stages s ON s.tenant_id = l.tenant_id AND s.id = l.stage_id
               WHERE ${crmCompiled.whereClause}`,
              crmCompiled.params
            );
            for (const m of matched.rows) seedIds.push(m.id);
          }
        }
        for (const lid of Array.from(new Set(seedIds))) {
          if (!lid) continue;
          await client.query(
            `INSERT INTO tenant_audience_members (id, tenant_id, audience_id, lead_id, source_type, metadata)
             VALUES ($1, $2, $3, $4, $5, '{}'::jsonb)
             ON CONFLICT (tenant_id, audience_id, lead_id) DO NOTHING`,
            [crypto.randomUUID(), ctx.tenantId, id, String(lid), b.crm_filter ? 'crm_filter' : 'manual']
          );
        }
        await refreshAudienceCachedCount(client, ctx.tenantId, id);
      }

      const r = await client.query('SELECT * FROM tenant_audiences WHERE tenant_id = $1 AND id = $2', [
        ctx.tenantId,
        id,
      ]);
      return r.rows[0];
    });

    tenantRedis.invalidateDynamicAudienceCount(ctx.tenantId);
    if (audType === 'dynamic_logic') {
      const evalRes = await evaluateDynamicAudience(ctx.tenantId, id);
      created.cached_member_count = evalRes.total_count;
      created.evaluation = evalRes;
    }

    res.status(201).json({ success: true, data: created });
  } catch (err: any) {
    sendApiError(res, 500, 'CREATE_AUDIENCE_FAILED', err?.message || 'Không thể tạo Tệp khách hàng.');
  }
});

audiencesRouter.get('/:id', requirePermission('audiences', 'view'), async (req, res) => {
  try {
    const ctx = getTenantContext();
    const aud = await withTenantTransaction(ctx.tenantId, async (client) => {
      const r = await client.query(
        `SELECT a.*, dr.name AS target_round_name
         FROM tenant_audiences a
         LEFT JOIN distribution_rounds dr ON dr.tenant_id = a.tenant_id AND dr.id = a.target_round_id
         WHERE a.tenant_id = $1 AND a.id = $2
         LIMIT 1`,
        [ctx.tenantId, req.params.id]
      );
      return r.rows[0] || null;
    });
    if (!aud) {
      sendApiError(res, 404, 'AUDIENCE_NOT_FOUND', 'Không tìm thấy Tệp khách hàng.');
      return;
    }
    res.json({ success: true, data: aud });
  } catch (err: any) {
    sendApiError(res, 500, 'GET_AUDIENCE_FAILED', err?.message || 'Không thể tải chi tiết Tệp khách hàng.');
  }
});

const updateAudienceHandler = async (req: any, res: any) => {
  try {
    const ctx = getTenantContext();
    const b = req.body || {};
    const validTypes = new Set(['static_data', 'sync_data', 'dynamic_logic']);
    const parsedUpdateBranches =
      b.filter_branches !== undefined
        ? parseCriteriaInput(b.filter_branches)
        : b.criteria !== undefined
          ? parseCriteriaInput(b.criteria)
          : undefined;
    const nextType =
      b.audience_type && validTypes.has(String(b.audience_type))
        ? String(b.audience_type)
        : undefined;

    const updated = await withTenantTransaction(ctx.tenantId, async (client) => {
      const r = await client.query(
        `UPDATE tenant_audiences
         SET name = COALESCE($3, name),
             description = CASE WHEN $4::boolean THEN $5 ELSE description END,
             audience_type = COALESCE($6, audience_type),
             filter_branches = COALESCE($7::jsonb, filter_branches),
             sync_config = COALESCE($8::jsonb, sync_config),
             auto_push_to_sale_round = COALESCE($9, auto_push_to_sale_round),
             target_round_id = CASE WHEN $10::boolean THEN $11 ELSE target_round_id END,
             color_hex = COALESCE($12, color_hex),
             is_active = COALESCE($13, is_active),
             updated_at = clock_timestamp()
         WHERE tenant_id = $1 AND id = $2
         RETURNING *`,
        [
          ctx.tenantId,
          req.params.id,
          b.name ? String(b.name).trim() : null,
          b.description !== undefined,
          b.description ? String(b.description).trim() : null,
          nextType || null,
          parsedUpdateBranches !== undefined ? JSON.stringify(parsedUpdateBranches) : null,
          b.sync_config !== undefined ? JSON.stringify(b.sync_config) : null,
          typeof b.auto_push_to_sale_round === 'boolean' ? b.auto_push_to_sale_round : null,
          b.target_round_id !== undefined,
          b.target_round_id || null,
          b.color_hex ? String(b.color_hex).trim() : null,
          typeof b.is_active === 'boolean' ? b.is_active : null,
        ]
      );
      return r.rows[0] || null;
    });

    if (!updated) {
      sendApiError(res, 404, 'AUDIENCE_NOT_FOUND', 'Không tìm thấy Tệp khách hàng.');
      return;
    }

    tenantRedis.invalidateDynamicAudienceCount(ctx.tenantId);
    if (updated.audience_type === 'dynamic_logic') {
      const evalRes = await evaluateDynamicAudience(ctx.tenantId, updated.id);
      updated.cached_member_count = evalRes.total_count;
      updated.evaluation = evalRes;
    }

    res.json({ success: true, data: updated });
  } catch (err: any) {
    sendApiError(res, 500, 'UPDATE_AUDIENCE_FAILED', err?.message || 'Không thể cập nhật Tệp khách hàng.');
  }
};

audiencesRouter.put('/:id', requirePermission('audiences', 'edit'), updateAudienceHandler);
audiencesRouter.patch('/:id', requirePermission('audiences', 'edit'), updateAudienceHandler);

audiencesRouter.delete('/:id', requirePermission('audiences', 'delete'), async (req, res) => {
  try {
    const ctx = getTenantContext();
    await withTenantTransaction(ctx.tenantId, async (client) => {
      await client.query('DELETE FROM tenant_audiences WHERE tenant_id = $1 AND id = $2', [
        ctx.tenantId,
        req.params.id,
      ]);
    });
    tenantRedis.invalidateDynamicAudienceCount(ctx.tenantId);
    res.json({ success: true, data: { deleted: true, id: req.params.id } });
  } catch (err: any) {
    sendApiError(res, 500, 'DELETE_AUDIENCE_FAILED', err?.message || 'Không thể xóa Tệp khách hàng.');
  }
});

// Audience Members Listing, Adding & Removing
audiencesRouter.get('/:id/members', requirePermission('audiences', 'view'), async (req, res) => {
  try {
    const ctx = getTenantContext();
    const cfg = await getTenantSettingsCached(ctx.tenantId);
    const search = req.query.search ? String(req.query.search).trim() : null;
    const page = Math.max(1, Number(req.query.page || 1));
    const limit = Math.min(200, Math.max(1, Number(req.query.limit || 50)));
    const offset = (page - 1) * limit;

    const data = await withTenantTransaction(ctx.tenantId, async (client) => {
      const rbac = await resolveUserEffectivePermissions(client, ctx.tenantId, ctx.userId);
      const canUnmask = Boolean(
        rbac.effectivePermissions.audiences?.actions.unmask_phone &&
          rbac.effectivePermissions.leads?.actions.unmask_phone
      );

      const params: unknown[] = [ctx.tenantId, req.params.id];
      let where = 'tam.tenant_id = $1 AND tam.audience_id = $2 AND l.is_deleted = false';
      if (search) {
        params.push(`%${search}%`);
        const pS = `$${params.length}`;
        where += ` AND (l.name ILIKE ${pS} OR COALESCE(l.phone, '') ILIKE ${pS} OR COALESCE(l.email, '') ILIKE ${pS})`;
      }

      const [cntRes, rowsRes] = await Promise.all([
        client.query<{ total: number }>(
          `SELECT COUNT(*)::int AS total
           FROM tenant_audience_members tam
           INNER JOIN leads l ON l.tenant_id = tam.tenant_id AND l.id = tam.lead_id
           WHERE ${where}`,
          params
        ),
        client.query(
          `SELECT tam.joined_at, tam.source_type AS member_source_type,
                  l.id, l.name, l.phone, l.email, l.source, l.campaign, l.status,
                  l.lifecycle_stage, l.lead_score, l.email_consent, l.zns_consent,
                  l.total_revenue_vnd, l.custom_fields, l.last_engaged_at, l.created_at,
                  s.stage_name, s.color_hex
           FROM tenant_audience_members tam
           INNER JOIN leads l ON l.tenant_id = tam.tenant_id AND l.id = tam.lead_id
           LEFT JOIN tenant_pipeline_stages s ON s.tenant_id = l.tenant_id AND s.id = l.stage_id
           WHERE ${where}
           ORDER BY tam.joined_at DESC
           LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
          [...params, limit, offset]
        ),
      ]);

      const items = rowsRes.rows.map((row) =>
        maskContactPiiIfDisallowed(
          {
            ...row,
            total_revenue_vnd: Number(row.total_revenue_vnd || 0),
          },
          canUnmask,
          cfg
        )
      );

      const total = Number(cntRes.rows[0]?.total || 0);
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
    sendApiError(res, 500, 'LIST_AUDIENCE_MEMBERS_FAILED', err?.message || 'Không thể tải danh sách thành viên trong tệp.');
  }
});

audiencesRouter.post('/:id/members', requirePermission('audiences', 'edit'), async (req, res) => {
  try {
    const ctx = getTenantContext();
    const audienceId = req.params.id;
    const b = req.body || {};
    const leadIds: string[] = Array.isArray(b.lead_ids)
      ? b.lead_ids
      : b.lead_id
        ? [b.lead_id]
        : [];

    const result = await withTenantTransaction(ctx.tenantId, async (client) => {
      if (b.crm_filter) {
        const compiled = compileSegmentWhereSql(ctx.tenantId, b.crm_filter);
        if (compiled.hasRules) {
          const m = await client.query<{ id: string }>(
            `SELECT l.id FROM leads l
             LEFT JOIN tenant_pipeline_stages s ON s.tenant_id = l.tenant_id AND s.id = l.stage_id
             WHERE ${compiled.whereClause}`,
            compiled.params
          );
          for (const r of m.rows) leadIds.push(r.id);
        }
      }

      let added = 0;
      for (const lid of Array.from(new Set(leadIds))) {
        if (!lid) continue;
        const ins = await client.query(
          `INSERT INTO tenant_audience_members (id, tenant_id, audience_id, lead_id, source_type, metadata)
           VALUES ($1, $2, $3, $4, $5, '{}'::jsonb)
           ON CONFLICT (tenant_id, audience_id, lead_id) DO NOTHING`,
          [crypto.randomUUID(), ctx.tenantId, audienceId, String(lid), b.source_type || 'manual']
        );
        added += ins.rowCount || 0;
      }
      const total = await refreshAudienceCachedCount(client, ctx.tenantId, audienceId);
      return { added_count: added, cached_member_count: total };
    });

    res.json({ success: true, data: result });
  } catch (err: any) {
    sendApiError(res, 500, 'ADD_AUDIENCE_MEMBERS_FAILED', err?.message || 'Không thể thêm khách hàng vào tệp.');
  }
});

audiencesRouter.delete('/:id/members/:leadId', requirePermission('audiences', 'edit'), async (req, res) => {
  try {
    const ctx = getTenantContext();
    const total = await withTenantTransaction(ctx.tenantId, async (client) => {
      await client.query(
        'DELETE FROM tenant_audience_members WHERE tenant_id = $1 AND audience_id = $2 AND lead_id = $3',
        [ctx.tenantId, req.params.id, req.params.leadId]
      );
      return refreshAudienceCachedCount(client, ctx.tenantId, req.params.id);
    });
    res.json({ success: true, data: { deleted: true, cached_member_count: total } });
  } catch (err: any) {
    sendApiError(res, 500, 'REMOVE_AUDIENCE_MEMBER_FAILED', err?.message || 'Không thể xóa khách hàng khỏi tệp.');
  }
});

// Evaluate Dynamic Segment (`POST /:id/evaluate`)
audiencesRouter.post('/:id/evaluate', requirePermission('audiences', 'edit'), async (req, res) => {
  try {
    const ctx = getTenantContext();
    const out = await evaluateDynamicAudience(ctx.tenantId, req.params.id);
    res.json({ success: true, data: out });
  } catch (err: any) {
    if (err?.message === 'AUDIENCE_NOT_FOUND') {
      sendApiError(res, 404, 'AUDIENCE_NOT_FOUND', 'Không tìm thấy Tệp khách hàng.');
      return;
    }
    sendApiError(res, 500, 'EVALUATE_AUDIENCE_FAILED', err?.message || 'Không thể tính toán lại Tệp Logic.');
  }
});

// CSV / JSON Import into Master Contact `leads` + Audience (`POST /:id/import`)
audiencesRouter.post('/:id/import', requirePermission('audiences', 'import'), async (req, res) => {
  try {
    const ctx = getTenantContext();
    const b = req.body || {};
    let rows: Array<Record<string, any>> = [];
    if (Array.isArray(b.rows)) {
      rows = b.rows;
    } else if (Array.isArray(b.items)) {
      rows = b.items;
    } else if (typeof b.csv_text === 'string' && b.csv_text.trim()) {
      rows = parseCsvTextToRows(b.csv_text);
    }

    if (rows.length === 0) {
      sendApiError(res, 422, 'EMPTY_IMPORT_PAYLOAD', 'Không tìm thấy dữ liệu khách hàng hợp lệ để nhập.');
      return;
    }

    const summary = await importRowsIntoAudience(ctx.tenantId, req.params.id, rows, {
      status: b.status === 'unassigned_pending' ? 'unassigned_pending' : 'marketing_nurture',
      source: b.source,
      actorId: ctx.userId,
    });

    res.status(201).json({ success: true, data: summary });
  } catch (err: any) {
    if (err?.message === 'AUDIENCE_NOT_FOUND') {
      sendApiError(res, 404, 'AUDIENCE_NOT_FOUND', 'Không tìm thấy Tệp khách hàng.');
      return;
    }
    sendApiError(res, 500, 'AUDIENCE_IMPORT_FAILED', err?.message || 'Không thể nhập dữ liệu vào tệp.');
  }
});

// Random A/B Split (`POST /:id/split` & `POST /:id/ab-split`)
audiencesRouter.post(['/:id/split', '/:id/ab-split'], requirePermission('audiences', 'create'), async (req, res) => {
  try {
    const ctx = getTenantContext();
    const out = await splitAudienceIntoParts(ctx.tenantId, req.params.id, {
      ...(req.body || {}),
      actorId: ctx.userId,
    });
    res.status(201).json({ success: true, data: out });
  } catch (err: any) {
    if (err?.message === 'AUDIENCE_NOT_FOUND') {
      sendApiError(res, 404, 'AUDIENCE_NOT_FOUND', 'Không tìm thấy Tệp khách hàng cần tách.');
      return;
    }
    sendApiError(res, 500, 'AUDIENCE_SPLIT_FAILED', err?.message || 'Không thể tách tệp A/B.');
  }
});

// Exclusions (`GET | POST | DELETE /:id/exclusions`)
audiencesRouter.get('/:id/exclusions', requirePermission('audiences', 'view'), async (req, res) => {
  try {
    const ctx = getTenantContext();
    const rows = await withTenantTransaction(ctx.tenantId, async (client) => {
      const r = await client.query(
        `SELECT ex.*, l.name AS lead_name, ea.name AS excluded_audience_name
         FROM tenant_audience_exclusions ex
         LEFT JOIN leads l ON l.tenant_id = ex.tenant_id AND l.id = ex.lead_id
         LEFT JOIN tenant_audiences ea ON ea.tenant_id = ex.tenant_id AND ea.id = ex.excluded_audience_id
         WHERE ex.tenant_id = $1 AND ex.audience_id = $2
         ORDER BY ex.created_at DESC`,
        [ctx.tenantId, req.params.id]
      );
      return r.rows;
    });
    res.json({ success: true, data: rows });
  } catch (err: any) {
    sendApiError(res, 500, 'LIST_EXCLUSIONS_FAILED', err?.message || 'Không thể tải danh sách loại trừ.');
  }
});

audiencesRouter.post('/:id/exclusions', requirePermission('audiences', 'edit'), async (req, res) => {
  try {
    const ctx = getTenantContext();
    const b = req.body || {};
    if (!b.lead_id && !b.excluded_audience_id && !b.email && !b.phone) {
      sendApiError(res, 422, 'VALIDATION_ERROR', 'Cần chỉ định khách hàng, tệp loại trừ, email hoặc SĐT cần loại trừ.');
      return;
    }
    const id = crypto.randomUUID();
    const audType = await withTenantTransaction(ctx.tenantId, async (client) => {
      await client.query(
        `INSERT INTO tenant_audience_exclusions (
           id, tenant_id, audience_id, lead_id, excluded_audience_id, email, phone, reason, created_by
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
        [
          id,
          ctx.tenantId,
          req.params.id,
          b.lead_id || null,
          b.excluded_audience_id || null,
          b.email ? String(b.email).trim().toLowerCase() : null,
          b.phone ? String(b.phone).trim() : null,
          b.reason ? String(b.reason).trim() : null,
          ctx.userId,
        ]
      );
      if (b.lead_id) {
        await client.query(
          'DELETE FROM tenant_audience_members WHERE tenant_id = $1 AND audience_id = $2 AND lead_id = $3',
          [ctx.tenantId, req.params.id, b.lead_id]
        );
      }
      await refreshAudienceCachedCount(client, ctx.tenantId, req.params.id);
      const a = await client.query<{ audience_type: string }>(
        'SELECT audience_type FROM tenant_audiences WHERE tenant_id = $1 AND id = $2 LIMIT 1',
        [ctx.tenantId, req.params.id]
      );
      return a.rows[0]?.audience_type;
    });

    if (audType === 'dynamic_logic') {
      await evaluateDynamicAudience(ctx.tenantId, req.params.id);
    }

    res.status(201).json({ success: true, data: { id } });
  } catch (err: any) {
    sendApiError(res, 500, 'ADD_EXCLUSION_FAILED', err?.message || 'Không thể thêm quy tắc loại trừ.');
  }
});

audiencesRouter.delete(
  ['/:id/exclusions/:exclusionId', '/:id/exclusions'],
  requirePermission('audiences', 'edit'),
  async (req, res) => {
    try {
      const ctx = getTenantContext();
      const exclId = String(req.params.exclusionId || req.query.id || req.body?.id || '').trim();
      if (!exclId) {
        sendApiError(res, 422, 'MISSING_EXCLUSION_ID', 'Cần chỉ định ID loại trừ cần xóa.');
        return;
      }
      const audType = await withTenantTransaction(ctx.tenantId, async (client) => {
        await client.query(
          'DELETE FROM tenant_audience_exclusions WHERE tenant_id = $1 AND audience_id = $2 AND id = $3',
          [ctx.tenantId, req.params.id, exclId]
        );
        const a = await client.query<{ audience_type: string }>(
          'SELECT audience_type FROM tenant_audiences WHERE tenant_id = $1 AND id = $2 LIMIT 1',
          [ctx.tenantId, req.params.id]
        );
        return a.rows[0]?.audience_type;
      });
      if (audType === 'dynamic_logic') {
        await evaluateDynamicAudience(ctx.tenantId, req.params.id);
      }
      res.json({ success: true, data: { deleted: true, id: exclId } });
    } catch (err: any) {
      sendApiError(res, 500, 'DELETE_EXCLUSION_FAILED', err?.message || 'Không thể xóa mục loại trừ.');
    }
  }
);

// Push Audience Contacts to Sale Round (`POST /:id/push-to-sale`)
audiencesRouter.post('/:id/push-to-sale', requirePermission('audiences', 'assign'), async (req, res) => {
  try {
    const ctx = getTenantContext();
    const audienceId = req.params.id;
    const { round_id, pipeline_id, lead_ids } = req.body || {};

    const outcome = await withTenantTransaction(ctx.tenantId, async (client) => {
      const audRes = await client.query<{ id: string; name: string; target_round_id: string | null }>(
        'SELECT id, name, target_round_id FROM tenant_audiences WHERE tenant_id = $1 AND id = $2 LIMIT 1',
        [ctx.tenantId, audienceId]
      );
      const aud = audRes.rows[0];
      if (!aud) throw new Error('AUDIENCE_NOT_FOUND');

      let targetLeadIds: string[] = Array.isArray(lead_ids) ? lead_ids : [];
      if (targetLeadIds.length === 0) {
        const mRes = await client.query<{ lead_id: string }>(
          `SELECT tam.lead_id
           FROM tenant_audience_members tam
           INNER JOIN leads l ON l.tenant_id = tam.tenant_id AND l.id = tam.lead_id
           WHERE tam.tenant_id = $1 AND tam.audience_id = $2 AND l.is_deleted = false AND l.status = 'marketing_nurture'`,
          [ctx.tenantId, audienceId]
        );
        targetLeadIds = mRes.rows.map((r) => r.lead_id);
      }

      const promoted = await promoteLeadsToSaleRoundInTx(client, ctx.tenantId, targetLeadIds, {
        roundId: round_id || aud.target_round_id || null,
        pipelineId: pipeline_id || null,
        actorId: ctx.userId,
        actorName: ctx.userName || 'Admin',
        reasonTitle: `Đẩy chủ động từ Tệp "${aud.name}" sang Vòng chia Sale`,
      });

      return {
        audience_id: audienceId,
        promoted_count: promoted.length,
        promoted_lead_ids: promoted,
      };
    });

    let drainedCount = 0;
    if (outcome.promoted_count > 0) {
      drainedCount = await runUnassignedLeadDrainer(ctx.tenantId).catch(() => 0);
    }

    res.json({
      success: true,
      data: {
        ...outcome,
        immediately_assigned_count: drainedCount,
      },
    });
  } catch (err: any) {
    if (err?.message === 'AUDIENCE_NOT_FOUND') {
      sendApiError(res, 404, 'AUDIENCE_NOT_FOUND', 'Không tìm thấy Tệp khách hàng.');
      return;
    }
    sendApiError(res, 500, 'PUSH_TO_SALE_FAILED', err?.message || 'Không thể đẩy tệp sang Vòng chia Sale.');
  }
});
