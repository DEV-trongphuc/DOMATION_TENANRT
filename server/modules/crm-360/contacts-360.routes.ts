import crypto from 'node:crypto';
import { Router } from 'express';
import { withTenantTransaction } from '../../core/database/transaction.ts';
import { getTenantContext } from '../../core/context/tenant-context.ts';
import {
  buildGranularScopeWhereClause,
  requirePermission,
  sendApiError,
} from '../../core/security/rbac.ts';
import {
  maskContactPiiIfDisallowed,
  maskPiiInText,
} from '../../core/security/pii-masker.ts';
import { emitDomainEventDetached } from '../../core/events/event-bus.ts';
import {
  clampLimit,
  parseJsonSafe,
  resolveCrmActorContext,
} from './schema.ts';

export const contacts360Router = Router();

function slugifyTag(name: string): string {
  return (
    name
      .trim()
      .toLowerCase()
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '') || `tag-${Date.now()}`
  );
}

async function syncContactTagsInTx(
  client: Parameters<Parameters<typeof withTenantTransaction>[1]>[0],
  tenantId: string,
  leadId: string,
  rawTags: unknown,
  actorId: string
): Promise<string[]> {
  if (!Array.isArray(rawTags)) return [];
  const cleaned = Array.from(
    new Set(rawTags.map((t) => String(t || '').trim()).filter(Boolean))
  );

  await client.query('DELETE FROM lead_tags WHERE tenant_id = $1 AND lead_id = $2', [
    tenantId,
    leadId,
  ]);

  for (const tagName of cleaned) {
    const slug = slugifyTag(tagName);
    const existingTag = await client.query<{ id: string }>(
      'SELECT id FROM tenant_tags WHERE tenant_id = $1 AND slug = $2 LIMIT 1',
      [tenantId, slug]
    );
    let tagId = existingTag.rows[0]?.id;
    if (!tagId) {
      tagId = crypto.randomUUID();
      await client.query(
        `INSERT INTO tenant_tags (id, tenant_id, name, slug, color_hex, category, usage_count)
         VALUES ($1, $2, $3, $4, '#1E40FF', 'crm', 1)`,
        [tagId, tenantId, tagName.slice(0, 100), slug.slice(0, 100)]
      );
    }
    const ltId = crypto.randomUUID();
    await client.query(
      `INSERT INTO lead_tags (id, tenant_id, lead_id, tag_id, assigned_by)
       VALUES ($1, $2, $3, $4, $5)`,
      [ltId, tenantId, leadId, tagId, actorId]
    );
  }
  return cleaned;
}

// ============================================================================
// 1. Master Contact 360° Directory + Persona Rollup KPIs
// ============================================================================
contacts360Router.get(
  '/contacts',
  requirePermission('leads', 'view'),
  async (req, res) => {
    try {
      const ctx = getTenantContext();
      const page = Math.max(1, Number(req.query.page || 1));
      const limit = clampLimit(req.query.limit, 20, 100);
      const offset = (page - 1) * limit;
      const search = String(req.query.search || '').trim();
      const lifecycleStage = String(req.query.lifecycle_stage || '').trim();
      const pipelineId = String(req.query.pipeline_id || '').trim();
      const stageId = String(req.query.stage_id || '').trim();
      const ownerId = String(req.query.owner_id || '').trim();
      const companyId = String(req.query.company_id || '').trim();
      const tagFilter = String(req.query.tag || '').trim();
      const heatTier = String(req.query.heat_tier || '').trim();
      const uncontactedOnly = String(req.query.uncontacted_only || '') === '1';
      const dateFrom = String(req.query.date_from || '').trim();
      const dateTo = String(req.query.date_to || '').trim();

      const data = await withTenantTransaction(ctx.tenantId, async (client) => {
        const { rbac, canUnmaskLeads, tenantSettings } = await resolveCrmActorContext(
          client,
          ctx.tenantId,
          ctx.userId
        );
        const scope = rbac.effectivePermissions.leads?.scope || 'own';
        if (!rbac.userOrg) {
          return {
            items: [],
            total: 0,
            page,
            limit,
            can_unmask_phone: false,
            kpis: {
              total_contacts: 0,
              hot_mql_sql: 0,
              customers_count: 0,
              uncontacted_count: 0,
              total_revenue_vnd: 0,
            },
            pipelines: [],
            stages: [],
            tags: [],
            staff: [],
            companies: [],
          };
        }

        const scopeSql = await buildGranularScopeWhereClause(
          client,
          ctx.tenantId,
          rbac.userOrg,
          scope,
          {
            tenantColumn: 'l.tenant_id',
            ownerColumn: 'l.assigned_to',
            startParamIndex: 1,
            allowUnassignedForManagers: true,
          }
        );

        const conds: string[] = [scopeSql.clause, 'l.is_deleted = false'];
        const vals: unknown[] = [...scopeSql.values];
        let pIdx = scopeSql.nextIndex;

        if (search) {
          conds.push(
            `(LOWER(l.name) LIKE LOWER($${pIdx}) OR LOWER(COALESCE(l.phone, '')) LIKE LOWER($${pIdx}) OR LOWER(COALESCE(l.email, '')) LIKE LOWER($${pIdx}) OR LOWER(COALESCE(l.product_interest, '')) LIKE LOWER($${pIdx}) OR LOWER(COALESCE(comp.name, '')) LIKE LOWER($${pIdx}))`
          );
          vals.push(`%${search}%`);
          pIdx++;
        }
        if (lifecycleStage) {
          conds.push(`l.lifecycle_stage = $${pIdx}`);
          vals.push(lifecycleStage);
          pIdx++;
        }
        if (pipelineId) {
          conds.push(`l.pipeline_id = $${pIdx}`);
          vals.push(pipelineId);
          pIdx++;
        }
        if (stageId) {
          conds.push(`l.stage_id = $${pIdx}`);
          vals.push(stageId);
          pIdx++;
        }
        if (ownerId) {
          conds.push(`l.assigned_to = $${pIdx}`);
          vals.push(ownerId);
          pIdx++;
        }
        if (companyId) {
          conds.push(`l.company_id = $${pIdx}`);
          vals.push(companyId);
          pIdx++;
        }
        if (tagFilter) {
          conds.push(
            `EXISTS (SELECT 1 FROM lead_tags lt_f INNER JOIN tenant_tags tt_f ON tt_f.tenant_id = lt_f.tenant_id AND tt_f.id = lt_f.tag_id WHERE lt_f.tenant_id = l.tenant_id AND lt_f.lead_id = l.id AND (tt_f.name = $${pIdx} OR tt_f.slug = $${pIdx}))`
          );
          vals.push(tagFilter);
          pIdx++;
        }
        if (heatTier === 'hot') {
          conds.push('l.lead_score >= 75');
        } else if (heatTier === 'warm') {
          conds.push('l.lead_score >= 45 AND l.lead_score < 75');
        } else if (heatTier === 'cold') {
          conds.push('l.lead_score < 45');
        }
        if (uncontactedOnly) {
          conds.push('l.last_engaged_at IS NULL AND l.is_accepted = false');
        }
        if (dateFrom) {
          conds.push(`l.created_at >= $${pIdx}`);
          vals.push(dateFrom);
          pIdx++;
        }
        if (dateTo) {
          conds.push(`l.created_at <= $${pIdx}`);
          vals.push(`${dateTo}T23:59:59.999Z`);
          pIdx++;
        }

        const whereStr = conds.join(' AND ');

        const [kpiRes, rowsRes, pipelinesRes, stagesRes, tagsRes, staffRes, companiesRes] =
          await Promise.all([
            client.query<{
              total_contacts: string | number;
              hot_mql_sql: string | number;
              customers_count: string | number;
              uncontacted_count: string | number;
              total_revenue_vnd: string | number;
            }>(
              `SELECT COUNT(*) AS total_contacts,
                      COALESCE(SUM(CASE WHEN l.lead_score >= 60 OR l.lifecycle_stage IN ('mql', 'sql', 'opportunity') THEN 1 ELSE 0 END), 0) AS hot_mql_sql,
                      COALESCE(SUM(CASE WHEN l.lifecycle_stage IN ('customer', 'evangelist') THEN 1 ELSE 0 END), 0) AS customers_count,
                      COALESCE(SUM(CASE WHEN l.last_engaged_at IS NULL AND l.is_accepted = false THEN 1 ELSE 0 END), 0) AS uncontacted_count,
                      COALESCE(SUM(l.total_revenue_vnd), 0) AS total_revenue_vnd
               FROM leads l
               LEFT JOIN tenant_b2b_companies comp ON comp.tenant_id = l.tenant_id AND comp.id = l.company_id
               WHERE ${whereStr}`,
              vals
            ),
            client.query<Record<string, any>>(
              `SELECT l.id, l.name, l.phone, l.email, l.status, l.lifecycle_stage, l.lead_score,
                      l.email_consent, l.zns_consent, l.total_revenue_vnd, l.last_engaged_at,
                      l.source, l.campaign, l.product_interest, l.budget_range, l.pipeline_id, l.stage_id,
                      l.assigned_to, l.company_id, l.job_title, l.address, l.custom_fields, l.is_accepted,
                      l.sla_breached, l.created_at, l.updated_at,
                      u.full_name AS owner_name,
                      ps.stage_name, ps.color_hex AS stage_color,
                      comp.name AS company_name
               FROM leads l
               LEFT JOIN users u ON u.tenant_id = l.tenant_id AND u.id = l.assigned_to
               LEFT JOIN tenant_pipeline_stages ps ON ps.tenant_id = l.tenant_id AND ps.id = l.stage_id
               LEFT JOIN tenant_b2b_companies comp ON comp.tenant_id = l.tenant_id AND comp.id = l.company_id
               WHERE ${whereStr}
               ORDER BY l.created_at DESC
               LIMIT $${pIdx} OFFSET $${pIdx + 1}`,
              [...vals, limit, offset]
            ),
            client.query(
              'SELECT id, name, is_default FROM tenant_pipelines WHERE tenant_id = $1 ORDER BY is_default DESC, created_at ASC',
              [ctx.tenantId]
            ),
            client.query(
              'SELECT id, pipeline_id, stage_key, stage_name, color_hex, stage_order, is_won_stage, is_lost_stage FROM tenant_pipeline_stages WHERE tenant_id = $1 ORDER BY stage_order ASC',
              [ctx.tenantId]
            ),
            client.query(
              'SELECT id, name, slug, color_hex, category FROM tenant_tags WHERE tenant_id = $1 ORDER BY name ASC',
              [ctx.tenantId]
            ),
            client.query(
              'SELECT id, full_name, email, role FROM users WHERE tenant_id = $1 AND is_system_bot = false ORDER BY full_name ASC',
              [ctx.tenantId]
            ),
            client.query(
              'SELECT id, code, name, tier FROM tenant_b2b_companies WHERE tenant_id = $1 ORDER BY name ASC LIMIT 200',
              [ctx.tenantId]
            ),
          ]);

        const leadIds = rowsRes.rows.map((r) => String(r.id));
        const tagsByLead = new Map<string, Array<{ id: string; name: string; color_hex: string }>>();
        if (leadIds.length > 0) {
          const ph = leadIds.map((_, idx) => `$${idx + 2}`).join(', ');
          const ltRes = await client.query<{
            lead_id: string;
            tag_id: string;
            name: string;
            color_hex: string;
          }>(
            `SELECT lt.lead_id, tt.id AS tag_id, tt.name, tt.color_hex
             FROM lead_tags lt
             INNER JOIN tenant_tags tt ON tt.tenant_id = lt.tenant_id AND tt.id = lt.tag_id
             WHERE lt.tenant_id = $1 AND lt.lead_id IN (${ph})`,
            [ctx.tenantId, ...leadIds]
          );
          for (const row of ltRes.rows) {
            const arr = tagsByLead.get(row.lead_id) || [];
            arr.push({ id: row.tag_id, name: row.name, color_hex: row.color_hex });
            tagsByLead.set(row.lead_id, arr);
          }
        }

        const piiCfg = parseJsonSafe<Record<string, any>>(tenantSettings, {});
        const items = rowsRes.rows.map((r) => {
          const masked = maskContactPiiIfDisallowed(r, canUnmaskLeads, piiCfg);
          return {
            ...masked,
            custom_fields: parseJsonSafe(r.custom_fields, {}),
            tags: tagsByLead.get(String(r.id)) || [],
            total_revenue_vnd: Number(r.total_revenue_vnd || 0),
            lead_score: Number(r.lead_score || 0),
          };
        });

        const kRow = kpiRes.rows[0];
        return {
          items,
          total: Number(kRow?.total_contacts || 0),
          page,
          limit,
          can_unmask_phone: canUnmaskLeads,
          kpis: {
            total_contacts: Number(kRow?.total_contacts || 0),
            hot_mql_sql: Number(kRow?.hot_mql_sql || 0),
            customers_count: Number(kRow?.customers_count || 0),
            uncontacted_count: Number(kRow?.uncontacted_count || 0),
            total_revenue_vnd: Number(kRow?.total_revenue_vnd || 0),
          },
          pipelines: pipelinesRes.rows,
          stages: stagesRes.rows,
          tags: tagsRes.rows,
          staff: staffRes.rows,
          companies: companiesRes.rows,
        };
      });

      res.json({ success: true, data });
    } catch (err: any) {
      sendApiError(
        res,
        500,
        'CRM_CONTACTS_LIST_FAILED',
        err?.message || 'Không thể tải danh bạ khách hàng 360°.'
      );
    }
  }
);

// ============================================================================
// 2. Create Master Contact 360°
// ============================================================================
contacts360Router.post(
  '/contacts',
  requirePermission('leads', 'create'),
  async (req, res) => {
    try {
      const ctx = getTenantContext();
      const b = req.body || {};
      const name = String(b.name || b.full_name || '').trim();
      const phone = b.phone ? String(b.phone).trim() : null;
      const email = b.email ? String(b.email).trim().toLowerCase() : null;

      if (!name) {
        sendApiError(res, 400, 'INVALID_CONTACT_NAME', 'Vui lòng nhập họ tên khách hàng.');
        return;
      }
      if (!phone && !email) {
        sendApiError(
          res,
          400,
          'CONTACT_PHONE_OR_EMAIL_REQUIRED',
          'Khách hàng cần ít nhất Số điện thoại hoặc Email.'
        );
        return;
      }

      const created = await withTenantTransaction(ctx.tenantId, async (client) => {
        const { canUnmaskLeads, tenantSettings, actorName } = await resolveCrmActorContext(
          client,
          ctx.tenantId,
          ctx.userId
        );

        let pipelineId: string | null = b.pipeline_id ? String(b.pipeline_id) : null;
        let stageId: string | null = b.stage_id ? String(b.stage_id) : null;

        if (!pipelineId) {
          const defPipe = await client.query<{ id: string }>(
            'SELECT id FROM tenant_pipelines WHERE tenant_id = $1 ORDER BY is_default DESC, created_at ASC LIMIT 1',
            [ctx.tenantId]
          );
          pipelineId = defPipe.rows[0]?.id || null;
        }
        if (pipelineId && !stageId) {
          const defStage = await client.query<{ id: string }>(
            'SELECT id FROM tenant_pipeline_stages WHERE tenant_id = $1 AND pipeline_id = $2 ORDER BY stage_order ASC LIMIT 1',
            [ctx.tenantId, pipelineId]
          );
          stageId = defStage.rows[0]?.id || null;
        }

        const leadId = crypto.randomUUID();
        const lifecycleStage = String(b.lifecycle_stage || 'lead').trim();
        const assignedTo = b.assigned_to ? String(b.assigned_to) : ctx.userId;
        const customFieldsJson = JSON.stringify(
          b.custom_fields && typeof b.custom_fields === 'object' ? b.custom_fields : {}
        );

        await client.query(
          `INSERT INTO leads (
             id, tenant_id, pipeline_id, stage_id, assigned_to, status, lifecycle_stage,
             name, phone, email, lead_score, source, campaign, product_interest, budget_range,
             company_id, job_title, address, custom_fields, is_accepted, last_engaged_at
           ) VALUES (
             $1, $2, $3, $4, $5, 'assigned', $6,
             $7, $8, $9, $10, $11, $12, $13, $14,
             $15, $16, $17, $18, true, clock_timestamp()
           )`,
          [
            leadId,
            ctx.tenantId,
            pipelineId,
            stageId,
            assignedTo,
            lifecycleStage,
            name.slice(0, 150),
            phone,
            email,
            Math.max(0, Math.min(100, Number(b.lead_score ?? 25))),
            String(b.source || 'CRM Manual').slice(0, 100),
            b.campaign ? String(b.campaign).slice(0, 150) : null,
            b.product_interest ? String(b.product_interest).slice(0, 255) : null,
            b.budget_range ? String(b.budget_range).slice(0, 120) : null,
            b.company_id ? String(b.company_id) : null,
            b.job_title ? String(b.job_title).slice(0, 150) : null,
            b.address ? String(b.address) : null,
            customFieldsJson,
          ]
        );

        if (Array.isArray(b.tags) && b.tags.length > 0) {
          await syncContactTagsInTx(client, ctx.tenantId, leadId, b.tags, ctx.userId);
        }

        const evtId = crypto.randomUUID();
        await client.query(
          `INSERT INTO lead_timeline_events (
             id, tenant_id, lead_id, event_type, event_category, actor_id, actor_role, actor_name, title, content, metadata
           ) VALUES ($1, $2, $3, 'contact_created', 'system', $4, $5, $6, $7, $8, $9)`,
          [
            evtId,
            ctx.tenantId,
            leadId,
            ctx.userId,
            ctx.userRole || 'staff',
            actorName,
            'Khởi tạo hồ sơ Khách hàng 360°',
            b.notes ? String(b.notes) : `Tạo mới hồ sơ bởi ${actorName}`,
            JSON.stringify({ source: b.source || 'CRM Manual' }),
          ]
        );

        const rowRes = await client.query<Record<string, any>>(
          'SELECT * FROM leads WHERE tenant_id = $1 AND id = $2 LIMIT 1',
          [ctx.tenantId, leadId]
        );
        return maskContactPiiIfDisallowed(
          rowRes.rows[0],
          canUnmaskLeads,
          parseJsonSafe(tenantSettings, {})
        );
      });

      emitDomainEventDetached('lead.created', {
        tenantId: ctx.tenantId,
        leadId: String(created.id),
        status: String(created.status || 'assigned'),
        lifecycleStage: String(created.lifecycle_stage || 'lead'),
        source: String(created.source || 'CRM Manual'),
        actorId: ctx.userId,
      });

      res.status(201).json({ success: true, data: created });
    } catch (err: any) {
      sendApiError(
        res,
        500,
        'CRM_CONTACT_CREATE_FAILED',
        err?.message || 'Không thể tạo mới hồ sơ khách hàng.'
      );
    }
  }
);

// ============================================================================
// 3. Bulk Contact Operations + Save Filtered Selection as Static Audience
// ============================================================================
contacts360Router.post(
  '/contacts/bulk',
  requirePermission('leads', 'edit'),
  async (req, res) => {
    try {
      const ctx = getTenantContext();
      const b = req.body || {};
      const action = String(b.action || '').trim();
      const contactIds = Array.isArray(b.contact_ids)
        ? b.contact_ids.map((id: unknown) => String(id || '').trim()).filter(Boolean)
        : [];

      if (contactIds.length === 0) {
        sendApiError(res, 400, 'EMPTY_CONTACT_IDS', 'Vui lòng chọn ít nhất 1 khách hàng.');
        return;
      }

      const result = await withTenantTransaction(ctx.tenantId, async (client) => {
        const { rbac } = await resolveCrmActorContext(client, ctx.tenantId, ctx.userId);
        const scope = rbac.effectivePermissions.leads?.scope || 'own';
        const scopeSql = await buildGranularScopeWhereClause(
          client,
          ctx.tenantId,
          rbac.userOrg!,
          scope,
          {
            tenantColumn: 'l.tenant_id',
            ownerColumn: 'l.assigned_to',
            startParamIndex: 1,
            allowUnassignedForManagers: true,
          }
        );

        const idPlaceholders = contactIds
          .map((_: unknown, idx: number) => `$${scopeSql.nextIndex + idx}`)
          .join(', ');
        const allowedRes = await client.query<{ id: string }>(
          `SELECT l.id FROM leads l WHERE ${scopeSql.clause} AND l.id IN (${idPlaceholders})`,
          [...scopeSql.values, ...contactIds]
        );
        const allowedIds = allowedRes.rows.map((r) => r.id);
        if (allowedIds.length === 0) {
          return { affected: 0, audience_id: null };
        }

        if (action === 'update_lifecycle' && b.lifecycle_stage) {
          const ph = allowedIds.map((_, i) => `$${i + 3}`).join(', ');
          await client.query(
            `UPDATE leads SET lifecycle_stage = $2, updated_at = clock_timestamp()
             WHERE tenant_id = $1 AND id IN (${ph})`,
            [ctx.tenantId, String(b.lifecycle_stage), ...allowedIds]
          );
          return { affected: allowedIds.length, audience_id: null };
        }

        if (action === 'assign_owner' && b.owner_id) {
          const ph = allowedIds.map((_, i) => `$${i + 3}`).join(', ');
          await client.query(
            `UPDATE leads SET assigned_to = $2, updated_at = clock_timestamp()
             WHERE tenant_id = $1 AND id IN (${ph})`,
            [ctx.tenantId, String(b.owner_id), ...allowedIds]
          );
          return { affected: allowedIds.length, audience_id: null };
        }

        if (action === 'add_tag' && b.tag_name) {
          const tagName = String(b.tag_name).trim();
          const slug = slugifyTag(tagName);
          const tRes = await client.query<{ id: string }>(
            'SELECT id FROM tenant_tags WHERE tenant_id = $1 AND slug = $2 LIMIT 1',
            [ctx.tenantId, slug]
          );
          let tagId = tRes.rows[0]?.id;
          if (!tagId) {
            tagId = crypto.randomUUID();
            await client.query(
              `INSERT INTO tenant_tags (id, tenant_id, name, slug, color_hex, category, usage_count)
               VALUES ($1, $2, $3, $4, $5, 'crm', $6)`,
              [
                tagId,
                ctx.tenantId,
                tagName.slice(0, 100),
                slug.slice(0, 100),
                String(b.color_hex || '#1E40FF'),
                allowedIds.length,
              ]
            );
          }
          for (const lid of allowedIds) {
            const exists = await client.query(
              'SELECT id FROM lead_tags WHERE tenant_id = $1 AND lead_id = $2 AND tag_id = $3 LIMIT 1',
              [ctx.tenantId, lid, tagId]
            );
            if (exists.rows.length === 0) {
              await client.query(
                'INSERT INTO lead_tags (id, tenant_id, lead_id, tag_id, assigned_by) VALUES ($1, $2, $3, $4, $5)',
                [crypto.randomUUID(), ctx.tenantId, lid, tagId, ctx.userId]
              );
            }
          }
          return { affected: allowedIds.length, audience_id: null };
        }

        if (action === 'save_to_audience' && b.audience_name) {
          const audId = crypto.randomUUID();
          await client.query(
            `INSERT INTO tenant_audiences (
               id, tenant_id, name, description, audience_type, cached_member_count, color_hex, created_by
             ) VALUES ($1, $2, $3, $4, 'static_data', $5, '#1E40FF', $6)`,
            [
              audId,
              ctx.tenantId,
              String(b.audience_name).trim().slice(0, 200),
              String(b.description || 'Tệp khách hàng xuất từ Danh bạ CRM 360°'),
              allowedIds.length,
              ctx.userId,
            ]
          );
          for (const lid of allowedIds) {
            await client.query(
              `INSERT INTO tenant_audience_members (id, tenant_id, audience_id, lead_id, source_type)
               VALUES ($1, $2, $3, $4, 'crm_filter')`,
              [crypto.randomUUID(), ctx.tenantId, audId, lid]
            );
          }
          return { affected: allowedIds.length, audience_id: audId };
        }

        return { affected: 0, audience_id: null };
      });

      res.json({ success: true, data: result });
    } catch (err: any) {
      sendApiError(
        res,
        500,
        'CRM_BULK_ACTION_FAILED',
        err?.message || 'Không thể thực hiện thao tác hàng loạt.'
      );
    }
  }
);

// ============================================================================
// 4. CustomerProfileDrawer Full 360° Dossier (Tab 1 + Summary Counts)
// ============================================================================
contacts360Router.get(
  '/contacts/:id',
  requirePermission('leads', 'view'),
  async (req, res) => {
    try {
      const ctx = getTenantContext();
      const contactId = String(req.params.id || '').trim();

      const data = await withTenantTransaction(ctx.tenantId, async (client) => {
        const { rbac, canUnmaskLeads, tenantSettings } = await resolveCrmActorContext(
          client,
          ctx.tenantId,
          ctx.userId
        );
        const scope = rbac.effectivePermissions.leads?.scope || 'own';
        const scopeSql = await buildGranularScopeWhereClause(
          client,
          ctx.tenantId,
          rbac.userOrg!,
          scope,
          {
            tenantColumn: 'l.tenant_id',
            ownerColumn: 'l.assigned_to',
            startParamIndex: 1,
            allowUnassignedForManagers: true,
          }
        );

        const leadRes = await client.query<Record<string, any>>(
          `SELECT l.*, u.full_name AS owner_name,
                  ps.stage_name, ps.color_hex AS stage_color,
                  p.name AS pipeline_name,
                  comp.name AS company_name, comp.tax_code AS company_tax_code, comp.tier AS company_tier
           FROM leads l
           LEFT JOIN users u ON u.tenant_id = l.tenant_id AND u.id = l.assigned_to
           LEFT JOIN tenant_pipeline_stages ps ON ps.tenant_id = l.tenant_id AND ps.id = l.stage_id
           LEFT JOIN tenant_pipelines p ON p.tenant_id = l.tenant_id AND p.id = l.pipeline_id
           LEFT JOIN tenant_b2b_companies comp ON comp.tenant_id = l.tenant_id AND comp.id = l.company_id
           WHERE ${scopeSql.clause} AND l.id = $${scopeSql.nextIndex} AND l.is_deleted = false
           LIMIT 1`,
          [...scopeSql.values, contactId]
        );

        if (leadRes.rows.length === 0) return null;
        const rawLead = leadRes.rows[0];

        const [
          tagsRes,
          audiencesRes,
          customFieldsRes,
          pipelineFieldsRes,
          entityTabsRes,
          stagesRes,
          dealsCountRes,
          quotesCountRes,
          ordersCountRes,
          tasksCountRes,
          ticketsCountRes,
          filesCountRes,
        ] = await Promise.all([
          client.query(
            `SELECT tt.id, tt.name, tt.slug, tt.color_hex
             FROM lead_tags lt
             INNER JOIN tenant_tags tt ON tt.tenant_id = lt.tenant_id AND tt.id = lt.tag_id
             WHERE lt.tenant_id = $1 AND lt.lead_id = $2`,
            [ctx.tenantId, contactId]
          ),
          client.query(
            `SELECT a.id, a.name, a.audience_type, a.color_hex, am.joined_at
             FROM tenant_audience_members am
             INNER JOIN tenant_audiences a ON a.tenant_id = am.tenant_id AND a.id = am.audience_id
             WHERE am.tenant_id = $1 AND am.lead_id = $2`,
            [ctx.tenantId, contactId]
          ),
          client.query(
            `SELECT id, field_key, field_label, field_type, is_required, options_json, sort_order
             FROM tenant_custom_fields
             WHERE tenant_id = $1 AND entity_type IN ('contact', 'lead') AND is_active = true
             ORDER BY sort_order ASC, created_at ASC`,
            [ctx.tenantId]
          ),
          rawLead.pipeline_id
            ? client.query(
                `SELECT id, field_key, field_label, field_type, is_required, options_json
                 FROM tenant_pipeline_custom_fields
                 WHERE tenant_id = $1 AND pipeline_id = $2
                 ORDER BY created_at ASC`,
                [ctx.tenantId, rawLead.pipeline_id]
              )
            : Promise.resolve({ rows: [] as any[] }),
          client.query(
            `SELECT id, tab_key, COALESCE(NULLIF(tab_label, ''), label) AS tab_label, label,
                    icon_name, sort_order, fields_json, config_json, allowed_roles, allowed_role_ids
             FROM tenant_entity_tabs
             WHERE tenant_id = $1 AND entity_type IN ('contact', 'lead') AND is_active = true
             ORDER BY sort_order ASC, created_at ASC`,
            [ctx.tenantId]
          ),
          rawLead.pipeline_id
            ? client.query(
                `SELECT id, stage_key, stage_name, color_hex, stage_order, is_won_stage, is_lost_stage
                 FROM tenant_pipeline_stages
                 WHERE tenant_id = $1 AND pipeline_id = $2
                 ORDER BY stage_order ASC`,
                [ctx.tenantId, rawLead.pipeline_id]
              )
            : Promise.resolve({ rows: [] as any[] }),
          client.query<{ cnt: string | number }>(
            'SELECT COUNT(*) AS cnt FROM tenant_deals WHERE tenant_id = $1 AND lead_id = $2',
            [ctx.tenantId, contactId]
          ),
          client.query<{ cnt: string | number }>(
            'SELECT COUNT(*) AS cnt FROM tenant_quotes WHERE tenant_id = $1 AND lead_id = $2',
            [ctx.tenantId, contactId]
          ),
          client.query<{ cnt: string | number }>(
            'SELECT COUNT(*) AS cnt FROM tenant_sales_orders WHERE tenant_id = $1 AND lead_id = $2',
            [ctx.tenantId, contactId]
          ),
          client.query<{ cnt: string | number }>(
            'SELECT COUNT(*) AS cnt FROM tenant_tasks WHERE tenant_id = $1 AND lead_id = $2',
            [ctx.tenantId, contactId]
          ),
          client.query<{ cnt: string | number }>(
            'SELECT COUNT(*) AS cnt FROM tenant_helpdesk_tickets WHERE tenant_id = $1 AND lead_id = $2',
            [ctx.tenantId, contactId]
          ),
          client.query<{ cnt: string | number }>(
            "SELECT COUNT(*) AS cnt FROM tenant_contact_files WHERE tenant_id = $1 AND entity_type = 'contact' AND entity_id = $2",
            [ctx.tenantId, contactId]
          ),
        ]);

        const masked = maskContactPiiIfDisallowed(
          rawLead,
          canUnmaskLeads,
          parseJsonSafe(tenantSettings, {})
        );

        return {
          contact: {
            ...masked,
            custom_fields: parseJsonSafe(rawLead.custom_fields, {}),
            total_revenue_vnd: Number(rawLead.total_revenue_vnd || 0),
            lead_score: Number(rawLead.lead_score || 0),
            tags: tagsRes.rows,
            audiences: audiencesRes.rows,
          },
          can_unmask_phone: canUnmaskLeads,
          custom_field_defs: [
            ...customFieldsRes.rows.map((f: any) => ({
              ...f,
              options_json: parseJsonSafe(f.options_json, []),
            })),
            ...pipelineFieldsRes.rows.map((f: any) => ({
              ...f,
              options_json: parseJsonSafe(f.options_json, []),
            })),
          ],
          dynamic_entity_tabs: entityTabsRes.rows.map((t: any) => {
            const parsedFields = parseJsonSafe<any[]>(t.fields_json, []);
            const cfg = parseJsonSafe<Record<string, any>>(t.config_json, {});
            const fallbackFields = Array.isArray(cfg?.fields) ? cfg.fields : [];
            const parsedRoles = parseJsonSafe<any[]>(t.allowed_roles, []);
            const fallbackRoles = parseJsonSafe<any[]>(t.allowed_role_ids, []);
            return {
              ...t,
              tab_label: String(t.tab_label || t.label || ''),
              fields_json: parsedFields.length > 0 ? parsedFields : fallbackFields,
              allowed_roles: parsedRoles.length > 0 ? parsedRoles : fallbackRoles,
            };
          }),
          pipeline_stages: stagesRes.rows,
          counts: {
            deals: Number(dealsCountRes.rows[0]?.cnt || 0),
            quotes: Number(quotesCountRes.rows[0]?.cnt || 0),
            orders: Number(ordersCountRes.rows[0]?.cnt || 0),
            tasks: Number(tasksCountRes.rows[0]?.cnt || 0),
            tickets: Number(ticketsCountRes.rows[0]?.cnt || 0),
            files: Number(filesCountRes.rows[0]?.cnt || 0),
          },
        };
      });

      if (!data) {
        sendApiError(res, 404, 'CONTACT_NOT_FOUND', 'Không tìm thấy hồ sơ khách hàng.');
        return;
      }
      res.json({ success: true, data });
    } catch (err: any) {
      sendApiError(
        res,
        500,
        'CRM_CONTACT_GET_FAILED',
        err?.message || 'Không thể tải hồ sơ khách hàng 360°.'
      );
    }
  }
);

// ============================================================================
// 5. Update Contact 360° Overview, Custom Fields, Dynamic Tab Values & Tags
// ============================================================================
contacts360Router.put(
  '/contacts/:id',
  requirePermission('leads', 'edit'),
  async (req, res) => {
    try {
      const ctx = getTenantContext();
      const contactId = String(req.params.id || '').trim();
      const b = req.body || {};

      const updated = await withTenantTransaction(ctx.tenantId, async (client) => {
        const { rbac, canUnmaskLeads, tenantSettings, actorName } = await resolveCrmActorContext(
          client,
          ctx.tenantId,
          ctx.userId
        );
        const scope = rbac.effectivePermissions.leads?.scope || 'own';
        const scopeSql = await buildGranularScopeWhereClause(
          client,
          ctx.tenantId,
          rbac.userOrg!,
          scope,
          {
            tenantColumn: 'l.tenant_id',
            ownerColumn: 'l.assigned_to',
            startParamIndex: 1,
            allowUnassignedForManagers: true,
          }
        );

        const curRes = await client.query<Record<string, any>>(
          `SELECT l.* FROM leads l WHERE ${scopeSql.clause} AND l.id = $${scopeSql.nextIndex} LIMIT 1`,
          [...scopeSql.values, contactId]
        );
        if (curRes.rows.length === 0) return null;
        const cur = curRes.rows[0];

        const curCustom = parseJsonSafe<Record<string, unknown>>(cur.custom_fields, {});
        const nextCustom =
          b.custom_fields && typeof b.custom_fields === 'object'
            ? { ...curCustom, ...(b.custom_fields as Record<string, unknown>) }
            : curCustom;

        // Protect raw phone/email if actor cannot unmask and submitted masked characters ('*')
        let nextPhone = cur.phone;
        if (b.phone !== undefined) {
          const pStr = String(b.phone || '').trim();
          if (canUnmaskLeads || !pStr.includes('*')) {
            nextPhone = pStr || null;
          }
        }
        let nextEmail = cur.email;
        if (b.email !== undefined) {
          const eStr = String(b.email || '').trim().toLowerCase();
          if (canUnmaskLeads || !eStr.includes('*')) {
            nextEmail = eStr || null;
          }
        }

        const nextStageId = b.stage_id !== undefined ? (b.stage_id || null) : cur.stage_id;
        const stageChanged = Boolean(nextStageId && String(nextStageId) !== String(cur.stage_id || ''));

        await client.query(
          `UPDATE leads
           SET name = $3,
               phone = $4,
               email = $5,
               lifecycle_stage = $6,
               lead_score = $7,
               email_consent = $8,
               zns_consent = $9,
               source = $10,
               campaign = $11,
               product_interest = $12,
               budget_range = $13,
               pipeline_id = $14,
               stage_id = $15,
               assigned_to = $16,
               company_id = $17,
               job_title = $18,
               address = $19,
               custom_fields = $20,
               updated_at = clock_timestamp()
           WHERE tenant_id = $1 AND id = $2`,
          [
            ctx.tenantId,
            contactId,
            b.name !== undefined ? String(b.name).trim().slice(0, 150) : cur.name,
            nextPhone,
            nextEmail,
            b.lifecycle_stage !== undefined ? String(b.lifecycle_stage) : cur.lifecycle_stage,
            b.lead_score !== undefined
              ? Math.max(0, Math.min(100, Number(b.lead_score)))
              : Number(cur.lead_score || 0),
            b.email_consent !== undefined ? String(b.email_consent) : cur.email_consent,
            b.zns_consent !== undefined ? String(b.zns_consent) : cur.zns_consent,
            b.source !== undefined ? String(b.source).slice(0, 100) : cur.source,
            b.campaign !== undefined ? (b.campaign ? String(b.campaign).slice(0, 150) : null) : cur.campaign,
            b.product_interest !== undefined
              ? b.product_interest
                ? String(b.product_interest).slice(0, 255)
                : null
              : cur.product_interest,
            b.budget_range !== undefined
              ? b.budget_range
                ? String(b.budget_range).slice(0, 120)
                : null
              : cur.budget_range,
            b.pipeline_id !== undefined ? (b.pipeline_id || null) : cur.pipeline_id,
            nextStageId,
            b.assigned_to !== undefined ? (b.assigned_to || null) : cur.assigned_to,
            b.company_id !== undefined ? (b.company_id || null) : cur.company_id,
            b.job_title !== undefined ? (b.job_title ? String(b.job_title).slice(0, 150) : null) : cur.job_title,
            b.address !== undefined ? (b.address ? String(b.address) : null) : cur.address,
            JSON.stringify(nextCustom),
          ]
        );

        if (Array.isArray(b.tags)) {
          await syncContactTagsInTx(client, ctx.tenantId, contactId, b.tags, ctx.userId);
        }

        if (stageChanged && nextStageId) {
          await client.query(
            `INSERT INTO lead_timeline_events (
               id, tenant_id, lead_id, event_type, event_category, actor_id, actor_role, actor_name, title, content, metadata
             ) VALUES ($1, $2, $3, 'stage_transition', 'pipeline', $4, $5, $6, $7, $8, $9)`,
            [
              crypto.randomUUID(),
              ctx.tenantId,
              contactId,
              ctx.userId,
              ctx.userRole || 'staff',
              actorName,
              'Chuyển bước Pipeline từ Hồ sơ 360°',
              `Cập nhật bước phễu bởi ${actorName}`,
              JSON.stringify({ from_stage_id: cur.stage_id, to_stage_id: nextStageId }),
            ]
          );
        }

        const freshRes = await client.query<Record<string, any>>(
          'SELECT * FROM leads WHERE tenant_id = $1 AND id = $2 LIMIT 1',
          [ctx.tenantId, contactId]
        );
        return maskContactPiiIfDisallowed(
          freshRes.rows[0],
          canUnmaskLeads,
          parseJsonSafe(tenantSettings, {})
        );
      });

      if (!updated) {
        sendApiError(res, 404, 'CONTACT_NOT_FOUND', 'Không tìm thấy hồ sơ khách hàng.');
        return;
      }

      emitDomainEventDetached('lead.updated', {
        tenantId: ctx.tenantId,
        leadId: contactId,
        actorId: ctx.userId,
      });

      res.json({ success: true, data: updated });
    } catch (err: any) {
      sendApiError(
        res,
        500,
        'CRM_CONTACT_UPDATE_FAILED',
        err?.message || 'Không thể cập nhật thông tin khách hàng.'
      );
    }
  }
);

// ============================================================================
// 6. Tab 2: 360° Timeline & @Mention Notes (with 3-Version Edit History)
// ============================================================================
contacts360Router.get(
  '/contacts/:id/timeline',
  requirePermission('leads', 'view'),
  async (req, res) => {
    try {
      const ctx = getTenantContext();
      const contactId = String(req.params.id || '').trim();
      const categoryFilter = String(req.query.category || '').trim();

      const items = await withTenantTransaction(ctx.tenantId, async (client) => {
        const { canUnmaskLeads, tenantSettings } = await resolveCrmActorContext(
          client,
          ctx.tenantId,
          ctx.userId
        );
        const piiCfg = parseJsonSafe<Record<string, any>>(tenantSettings, {});

        const [tlRes, actRes] = await Promise.all([
          client.query<Record<string, any>>(
            `SELECT id, event_type, event_category, actor_id, actor_role, actor_name, title, content, metadata, created_at
             FROM lead_timeline_events
             WHERE tenant_id = $1 AND lead_id = $2
             ORDER BY created_at DESC
             LIMIT 100`,
            [ctx.tenantId, contactId]
          ),
          client.query<Record<string, any>>(
            `SELECT id, activity_type, subject, body, status, priority, due_date, owner_user_id, owner_name,
                    mentions_json, edit_history_json, metadata, created_at
             FROM tenant_crm_activities
             WHERE tenant_id = $1 AND lead_id = $2
             ORDER BY created_at DESC
             LIMIT 100`,
            [ctx.tenantId, contactId]
          ),
        ]);

        const merged = [
          ...tlRes.rows.map((r) => {
            const meta = parseJsonSafe<Record<string, any>>(r.metadata, {});
            return {
              id: r.id,
              source_table: 'timeline',
              event_type: r.event_type,
              category: r.event_category,
              actor_id: r.actor_id,
              actor_name: r.actor_name || r.actor_role,
              title: r.title,
              content: canUnmaskLeads ? r.content : maskPiiInText(r.content, piiCfg),
              mentions: Array.isArray(meta.mentions) ? meta.mentions : [],
              edit_history: Array.isArray(meta.edit_history) ? meta.edit_history : [],
              created_at: r.created_at,
            };
          }),
          ...actRes.rows.map((a) => ({
            id: a.id,
            source_table: 'crm_activity',
            event_type: a.activity_type,
            category: a.activity_type === 'note' ? 'note' : 'communication',
            actor_id: a.owner_user_id,
            actor_name: a.owner_name || 'Thành viên',
            title: a.subject,
            content: canUnmaskLeads ? a.body : maskPiiInText(a.body, piiCfg),
            status: a.status,
            priority: a.priority,
            due_date: a.due_date,
            mentions: parseJsonSafe(a.mentions_json, []),
            edit_history: parseJsonSafe(a.edit_history_json, []),
            created_at: a.created_at,
          })),
        ]
          .filter((item) => !categoryFilter || item.category === categoryFilter || item.event_type === categoryFilter)
          .sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime());

        return merged;
      });

      res.json({ success: true, data: { items } });
    } catch (err: any) {
      sendApiError(res, 500, 'CRM_TIMELINE_FAILED', err?.message || 'Không thể tải dòng thời gian 360°.');
    }
  }
);

contacts360Router.post(
  '/contacts/:id/timeline',
  requirePermission('leads', 'edit'),
  async (req, res) => {
    try {
      const ctx = getTenantContext();
      const contactId = String(req.params.id || '').trim();
      const b = req.body || {};
      const content = String(b.content || b.body || '').trim();
      const activityType = String(b.activity_type || b.event_type || 'note').trim();
      const subject = String(b.subject || b.title || (activityType === 'call' ? 'Ghi nhận cuộc gọi' : 'Ghi chú tư vấn 360°')).trim();

      if (!content && !subject) {
        sendApiError(res, 400, 'EMPTY_TIMELINE_NOTE', 'Vui lòng nhập nội dung ghi chú hoặc tương tác.');
        return;
      }

      const created = await withTenantTransaction(ctx.tenantId, async (client) => {
        const { actorName } = await resolveCrmActorContext(client, ctx.tenantId, ctx.userId);
        const mentions = Array.isArray(b.mentions) ? b.mentions : [];
        const actId = crypto.randomUUID();

        await client.query(
          `INSERT INTO tenant_crm_activities (
             id, tenant_id, activity_type, subject, body, status, priority, due_date,
             lead_id, owner_user_id, owner_name, mentions_json, edit_history_json, metadata, created_by
           ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, '[]', $13, $10)`,
          [
            actId,
            ctx.tenantId,
            activityType,
            subject.slice(0, 255),
            content,
            String(b.status || 'done'),
            String(b.priority || 'medium'),
            b.due_date || null,
            contactId,
            ctx.userId,
            actorName,
            JSON.stringify(mentions),
            JSON.stringify(b.metadata && typeof b.metadata === 'object' ? b.metadata : {}),
          ]
        );

        await client.query(
          'UPDATE leads SET last_engaged_at = clock_timestamp(), updated_at = clock_timestamp() WHERE tenant_id = $1 AND id = $2',
          [ctx.tenantId, contactId]
        );

        const rowRes = await client.query('SELECT * FROM tenant_crm_activities WHERE tenant_id = $1 AND id = $2 LIMIT 1', [
          ctx.tenantId,
          actId,
        ]);
        return rowRes.rows[0];
      });

      res.status(201).json({ success: true, data: created });
    } catch (err: any) {
      sendApiError(res, 500, 'CRM_TIMELINE_CREATE_FAILED', err?.message || 'Không thể lưu ghi chú 360°.');
    }
  }
);

contacts360Router.put(
  '/contacts/:id/timeline/:eventId',
  requirePermission('leads', 'edit'),
  async (req, res) => {
    try {
      const ctx = getTenantContext();
      const contactId = String(req.params.id || '').trim();
      const eventId = String(req.params.eventId || '').trim();
      const nextContent = String(req.body?.content || req.body?.body || '').trim();

      if (!nextContent) {
        sendApiError(res, 400, 'EMPTY_NOTE_CONTENT', 'Nội dung chỉnh sửa không được để trống.');
        return;
      }

      const updated = await withTenantTransaction(ctx.tenantId, async (client) => {
        const { actorName } = await resolveCrmActorContext(client, ctx.tenantId, ctx.userId);
        const curAct = await client.query<Record<string, any>>(
          'SELECT * FROM tenant_crm_activities WHERE tenant_id = $1 AND id = $2 AND lead_id = $3 LIMIT 1',
          [ctx.tenantId, eventId, contactId]
        );

        if (curAct.rows.length > 0) {
          const row = curAct.rows[0];
          const prevHistory = parseJsonSafe<any[]>(row.edit_history_json, []);
          const nextHistory = [
            {
              edited_by_id: ctx.userId,
              edited_by_name: actorName,
              edited_at: new Date().toISOString(),
              old_body: row.body,
              old_subject: row.subject,
            },
            ...prevHistory,
          ].slice(0, 3);

          await client.query(
            `UPDATE tenant_crm_activities
             SET body = $3, edit_history_json = $4, updated_at = clock_timestamp()
             WHERE tenant_id = $1 AND id = $2`,
            [ctx.tenantId, eventId, nextContent, JSON.stringify(nextHistory)]
          );
          return { id: eventId, content: nextContent, edit_history: nextHistory };
        }

        const curTl = await client.query<Record<string, any>>(
          'SELECT * FROM lead_timeline_events WHERE tenant_id = $1 AND id = $2 AND lead_id = $3 LIMIT 1',
          [ctx.tenantId, eventId, contactId]
        );
        if (curTl.rows.length === 0) return null;
        const tl = curTl.rows[0];
        const meta = parseJsonSafe<Record<string, any>>(tl.metadata, {});
        const prevHistory = Array.isArray(meta.edit_history) ? meta.edit_history : [];
        const nextHistory = [
          {
            edited_by_id: ctx.userId,
            edited_by_name: actorName,
            edited_at: new Date().toISOString(),
            old_body: tl.content,
          },
          ...prevHistory,
        ].slice(0, 3);

        await client.query(
          `UPDATE lead_timeline_events
           SET content = $3, metadata = $4
           WHERE tenant_id = $1 AND id = $2`,
          [ctx.tenantId, eventId, nextContent, JSON.stringify({ ...meta, edit_history: nextHistory })]
        );
        return { id: eventId, content: nextContent, edit_history: nextHistory };
      });

      if (!updated) {
        sendApiError(res, 404, 'TIMELINE_EVENT_NOT_FOUND', 'Không tìm thấy ghi chú cần chỉnh sửa.');
        return;
      }
      res.json({ success: true, data: updated });
    } catch (err: any) {
      sendApiError(res, 500, 'CRM_TIMELINE_EDIT_FAILED', err?.message || 'Không thể cập nhật ghi chú.');
    }
  }
);

// ============================================================================
// 7. Tab 3: Omnichannel Journey + Enroll Flow + Issue Voucher + DOM Agent AI
// ============================================================================
contacts360Router.get(
  '/contacts/:id/omnichannel-journey',
  requirePermission('leads', 'view'),
  async (req, res) => {
    try {
      const ctx = getTenantContext();
      const contactId = String(req.params.id || '').trim();

      const data = await withTenantTransaction(ctx.tenantId, async (client) => {
        const leadRes = await client.query<Record<string, any>>(
          'SELECT * FROM leads WHERE tenant_id = $1 AND id = $2 LIMIT 1',
          [ctx.tenantId, contactId]
        );
        if (leadRes.rows.length === 0) return null;
        const lead = leadRes.rows[0];

        const safeQuery = async (sql: string, params: unknown[]) => {
          try {
            const r = await client.query(sql, params);
            return r.rows;
          } catch {
            return [];
          }
        };

        const [
          emailClaims,
          flowEnrollments,
          surveyResponses,
          voucherCodes,
          webSessions,
          socialConversations,
          availableFlows,
          availableVouchers,
        ] = await Promise.all([
          safeQuery(
            `SELECT sc.id, sc.channel, sc.status, sc.sent_at, sc.opened_at, sc.clicked_at, c.name AS campaign_name
             FROM mkt_send_claims sc
             LEFT JOIN mkt_campaigns c ON c.tenant_id = sc.tenant_id AND c.id = sc.campaign_id
             WHERE sc.tenant_id = $1 AND sc.lead_id = $2
             ORDER BY sc.claimed_at DESC LIMIT 50`,
            [ctx.tenantId, contactId]
          ),
          safeQuery(
            `SELECT fe.id, fe.flow_id, fe.status, fe.current_step_id, fe.enrolled_at, fe.completed_at, f.name AS flow_name
             FROM mkt_flow_enrollments fe
             LEFT JOIN mkt_flows f ON f.tenant_id = fe.tenant_id AND f.id = fe.flow_id
             WHERE fe.tenant_id = $1 AND fe.lead_id = $2
             ORDER BY fe.enrolled_at DESC LIMIT 50`,
            [ctx.tenantId, contactId]
          ),
          safeQuery(
            `SELECT sr.id, sr.survey_id, sr.quiz_score, sr.nps_score, sr.answers_json, sr.created_at, s.title AS survey_title
             FROM mkt_survey_responses sr
             LEFT JOIN mkt_surveys s ON s.tenant_id = sr.tenant_id AND s.id = sr.survey_id
             WHERE sr.tenant_id = $1 AND sr.lead_id = $2
             ORDER BY sr.created_at DESC LIMIT 50`,
            [ctx.tenantId, contactId]
          ),
          safeQuery(
            `SELECT vc.id, vc.code, vc.status, vc.claimed_at, vc.redeemed_at, camp.name AS campaign_name, camp.discount_value
             FROM mkt_voucher_codes vc
             LEFT JOIN mkt_voucher_campaigns camp ON camp.tenant_id = vc.tenant_id AND camp.id = vc.campaign_id
             WHERE vc.tenant_id = $1 AND vc.assigned_lead_id = $2
             ORDER BY vc.created_at DESC LIMIT 50`,
            [ctx.tenantId, contactId]
          ),
          safeQuery(
            `SELECT id, visitor_id, landing_page, referrer, utm_source, utm_medium, utm_campaign, pageviews_count, duration_seconds, started_at
             FROM mkt_web_sessions
             WHERE tenant_id = $1 AND lead_id = $2
             ORDER BY started_at DESC LIMIT 50`,
            [ctx.tenantId, contactId]
          ),
          safeQuery(
            `SELECT id, channel, external_user_name, status, last_message_preview, last_message_at
             FROM mkt_social_conversations
             WHERE tenant_id = $1 AND lead_id = $2
             ORDER BY last_message_at DESC LIMIT 30`,
            [ctx.tenantId, contactId]
          ),
          safeQuery(
            "SELECT id, name, status FROM mkt_flows WHERE tenant_id = $1 AND status IN ('active', 'draft') ORDER BY created_at DESC LIMIT 50",
            [ctx.tenantId]
          ),
          safeQuery(
            'SELECT id, name, discount_type, discount_value FROM mkt_voucher_campaigns WHERE tenant_id = $1 ORDER BY created_at DESC LIMIT 50',
            [ctx.tenantId]
          ),
        ]);

        const filledFields = [
          lead.name,
          lead.phone,
          lead.email,
          lead.product_interest,
          lead.company_id,
          lead.job_title,
          lead.address,
        ].filter(Boolean).length;
        const completenessPct = Math.round((filledFields / 7) * 100);

        const touchpoints = [
          ...emailClaims.map((e: any) => ({
            id: `email-${e.id}`,
            channel: 'email',
            title: `Chiến dịch: ${e.campaign_name || 'Email/ZNS'}`,
            detail: e.clicked_at ? 'Đã click link' : e.opened_at ? 'Đã mở thư' : `Trạng thái: ${e.status}`,
            timestamp: e.clicked_at || e.opened_at || e.sent_at,
          })),
          ...flowEnrollments.map((f: any) => ({
            id: `flow-${f.id}`,
            channel: 'flow',
            title: `Automation Flow: ${f.flow_name || 'Kịch bản chăm sóc'}`,
            detail: `Trạng thái: ${f.status}`,
            timestamp: f.enrolled_at,
          })),
          ...surveyResponses.map((s: any) => ({
            id: `survey-${s.id}`,
            channel: 'survey',
            title: `Khảo sát: ${s.survey_title || 'Survey'}`,
            detail: `Điểm tương tác: ${s.quiz_score ?? 0}${s.nps_score != null ? ` • NPS: ${s.nps_score}` : ''}`,
            timestamp: s.created_at,
          })),
          ...voucherCodes.map((v: any) => ({
            id: `voucher-${v.id}`,
            channel: 'voucher',
            title: `Mã ưu đãi: ${v.code}`,
            detail: `${v.campaign_name || 'Chiến dịch Voucher'} • ${v.status}`,
            timestamp: v.redeemed_at || v.claimed_at,
          })),
          ...webSessions.map((w: any) => ({
            id: `web-${w.id}`,
            channel: 'web',
            title: `Truy cập Web: ${w.landing_page || '/'}`,
            detail: `UTM: ${w.utm_source || 'direct'} • ${w.pageviews_count || 1} trang (${w.duration_seconds || 0}s)`,
            timestamp: w.started_at,
          })),
        ].sort((a, b) => new Date(b.timestamp || 0).getTime() - new Date(a.timestamp || 0).getTime());

        return {
          completeness_pct: completenessPct,
          lead_score: Number(lead.lead_score || 0),
          lifecycle_stage: lead.lifecycle_stage,
          first_touch_source: lead.utm_source || lead.source || 'Direct',
          first_touch_campaign: lead.campaign || '—',
          touchpoints,
          email_claims: emailClaims,
          flow_enrollments: flowEnrollments,
          survey_responses: surveyResponses.map((s: any) => ({
            ...s,
            answers_json: parseJsonSafe(s.answers_json, {}),
          })),
          vouchers: voucherCodes,
          web_sessions: webSessions,
          conversations: socialConversations,
          available_flows: availableFlows,
          available_campaigns: availableVouchers,
        };
      });

      if (!data) {
        sendApiError(res, 404, 'CONTACT_NOT_FOUND', 'Không tìm thấy khách hàng.');
        return;
      }
      res.json({ success: true, data });
    } catch (err: any) {
      sendApiError(res, 500, 'CRM_JOURNEY_FAILED', err?.message || 'Không thể tải hành trình đa kênh.');
    }
  }
);

contacts360Router.post(
  '/contacts/:id/enroll-flow',
  requirePermission('leads', 'edit'),
  async (req, res) => {
    try {
      const ctx = getTenantContext();
      const contactId = String(req.params.id || '').trim();
      const flowName = String(req.body?.flow_name || 'Kịch bản chăm sóc tự động').trim();
      const note = String(req.body?.note || '').trim();

      const result = await withTenantTransaction(ctx.tenantId, async (client) => {
        const { actorName } = await resolveCrmActorContext(client, ctx.tenantId, ctx.userId);
        const evtId = crypto.randomUUID();
        await client.query(
          `INSERT INTO lead_timeline_events (
             id, tenant_id, lead_id, event_type, event_category, actor_id, actor_role, actor_name, title, content, metadata
           ) VALUES ($1, $2, $3, 'flow_enrolled', 'communication', $4, $5, $6, $7, $8, $9)`,
          [
            evtId,
            ctx.tenantId,
            contactId,
            ctx.userId,
            ctx.userRole || 'staff',
            actorName,
            `Đưa vào Automation Flow: ${flowName}`,
            note || `Kích hoạt thủ công từ Hành trình Đa kênh 360° bởi ${actorName}`,
            JSON.stringify({ flow_id: req.body?.flow_id || null, flow_name: flowName }),
          ]
        );
        return { event_id: evtId, flow_name: flowName };
      });

      emitDomainEventDetached('marketing.engaged', {
        tenantId: ctx.tenantId,
        leadId: contactId,
        engagementType: 'flow_manual_enroll',
        channel: 'email',
        scoreDelta: 5,
      });

      res.status(201).json({ success: true, data: result });
    } catch (err: any) {
      sendApiError(res, 500, 'CRM_FLOW_ENROLL_FAILED', err?.message || 'Không thể đưa khách hàng vào kịch bản.');
    }
  }
);

contacts360Router.post(
  '/contacts/:id/issue-voucher',
  requirePermission('leads', 'edit'),
  async (req, res) => {
    try {
      const ctx = getTenantContext();
      const contactId = String(req.params.id || '').trim();
      const code =
        String(req.body?.code || '').trim().toUpperCase() ||
        `DOM-${Math.random().toString(36).slice(2, 8).toUpperCase()}`;
      const discountValue = Number(req.body?.discount_value || 0);
      const note = String(req.body?.note || '').trim();

      const result = await withTenantTransaction(ctx.tenantId, async (client) => {
        const { actorName } = await resolveCrmActorContext(client, ctx.tenantId, ctx.userId);
        const evtId = crypto.randomUUID();
        await client.query(
          `INSERT INTO lead_timeline_events (
             id, tenant_id, lead_id, event_type, event_category, actor_id, actor_role, actor_name, title, content, metadata
           ) VALUES ($1, $2, $3, 'voucher_issued', 'communication', $4, $5, $6, $7, $8, $9)`,
          [
            evtId,
            ctx.tenantId,
            contactId,
            ctx.userId,
            ctx.userRole || 'staff',
            actorName,
            `Cấp mã ưu đãi cá nhân: ${code}`,
            note || `Giá trị ưu đãi: ${discountValue.toLocaleString('vi-VN')}₫`,
            JSON.stringify({ code, discount_value: discountValue }),
          ]
        );
        return { code, discount_value: discountValue, issued_at: new Date().toISOString() };
      });

      res.status(201).json({ success: true, data: result });
    } catch (err: any) {
      sendApiError(res, 500, 'CRM_ISSUE_VOUCHER_FAILED', err?.message || 'Không thể phát hành mã ưu đãi.');
    }
  }
);

contacts360Router.all(
  '/contacts/:id/journey-ai-summary',
  requirePermission('leads', 'view'),
  async (req, res) => {
    try {
      const ctx = getTenantContext();
      const contactId = String(req.params.id || '').trim();
      const forceAnalyze = req.method === 'POST' || String(req.query.analyze || '') === '1';

      const summary = await withTenantTransaction(ctx.tenantId, async (client) => {
        const leadRes = await client.query<Record<string, any>>(
          'SELECT * FROM leads WHERE tenant_id = $1 AND id = $2 LIMIT 1',
          [ctx.tenantId, contactId]
        );
        if (leadRes.rows.length === 0) return null;
        const lead = leadRes.rows[0];
        const customFields = parseJsonSafe<Record<string, any>>(lead.custom_fields, {});

        if (!forceAnalyze && customFields.dom_journey_ai) {
          return { ...customFields.dom_journey_ai, source: 'database_cached' };
        }

        const [dealsAgg, actAgg] = await Promise.all([
          client.query<{ deals_count: string | number; expected_rev: string | number }>(
            `SELECT COUNT(*) AS deals_count,
                    COALESCE(SUM(CASE WHEN stage != 'lost' THEN amount_vnd ELSE 0 END), 0) AS expected_rev
             FROM tenant_deals
             WHERE tenant_id = $1 AND lead_id = $2`,
            [ctx.tenantId, contactId]
          ),
          client.query<{ act_count: string | number }>(
            'SELECT COUNT(*) AS act_count FROM tenant_crm_activities WHERE tenant_id = $1 AND lead_id = $2',
            [ctx.tenantId, contactId]
          ),
        ]);

        const totalSpent = Number(lead.total_revenue_vnd || 0);
        const expectedRevenue = Number(dealsAgg.rows[0]?.expected_rev || 0);
        const dealsCount = Number(dealsAgg.rows[0]?.deals_count || 0);
        const actCount = Number(actAgg.rows[0]?.act_count || 0);
        const rawScore = Number(lead.lead_score || 0);
        const computedScore = Math.min(
          100,
          Math.max(
            rawScore,
            25 +
              (dealsCount > 0 ? 25 : 0) +
              (totalSpent > 0 ? 30 : 0) +
              Math.min(20, actCount * 4)
          )
        );
        const potentialLevel =
          computedScore >= 80
            ? 'Rất cao'
            : computedScore >= 60
            ? 'Cao'
            : computedScore >= 40
            ? 'Trung bình'
            : 'Thấp';

        const analysis = {
          summary: `DOM Agent đánh giá khách hàng ${lead.name} đang ở giai đoạn "${lead.lifecycle_stage || 'lead'}" với điểm tiềm năng ${computedScore}/100 (${potentialLevel}). Đã ghi nhận ${actCount} tương tác và ${dealsCount} cơ hội kinh doanh.`,
          key_needs: [
            lead.product_interest
              ? `Quan tâm trọng tâm: ${lead.product_interest}`
              : 'Cần khai thác thêm nhu cầu sản phẩm/dịch vụ cụ thể',
            lead.campaign ? `Nguồn chiến dịch: ${lead.campaign}` : `Nguồn tiếp cận: ${lead.source || 'Trực tiếp'}`,
          ],
          financial_status:
            totalSpent > 0
              ? `Đã thanh toán lũy kế ${totalSpent.toLocaleString('vi-VN')}₫ • Dự kiến mở rộng ${expectedRevenue.toLocaleString('vi-VN')}₫`
              : expectedRevenue > 0
              ? `Đang đàm phán cơ hội trị giá ${expectedRevenue.toLocaleString('vi-VN')}₫`
              : lead.budget_range
              ? `Ngân sách dự kiến: ${lead.budget_range}`
              : 'Chưa phát sinh giao dịch tài chính',
          potential_level: potentialLevel,
          potential_score: computedScore,
          next_best_actions: [
            actCount === 0
              ? 'Thực hiện cuộc gọi tư vấn đầu tiên trong vòng 15 phút để giữ nhiệt SLA'
              : 'Gửi Báo giá chi tiết & tài liệu Case Study qua Email/Zalo',
            dealsCount === 0
              ? 'Tạo Cơ hội (Deal) mới để theo dõi xác suất chốt trên bảng Kanban'
              : 'Đặt lịch hẹn Demo / Chốt điều khoản đặt cọc ngay trong tuần này',
          ],
          analyzed_at: new Date().toISOString(),
          source: 'dom_agent_generated',
          metrics: {
            total_spent: totalSpent,
            expected_revenue: expectedRevenue,
            deals_count: dealsCount,
            activities_count: actCount,
          },
        };

        if (forceAnalyze) {
          await client.query(
            'UPDATE leads SET custom_fields = $3, updated_at = clock_timestamp() WHERE tenant_id = $1 AND id = $2',
            [ctx.tenantId, contactId, JSON.stringify({ ...customFields, dom_journey_ai: analysis })]
          );
        }

        return analysis;
      });

      if (!summary) {
        sendApiError(res, 404, 'CONTACT_NOT_FOUND', 'Không tìm thấy khách hàng.');
        return;
      }
      res.json({ success: true, data: summary });
    } catch (err: any) {
      sendApiError(res, 500, 'DOM_AGENT_JOURNEY_FAILED', err?.message || 'DOM Agent không thể phân tích hành trình.');
    }
  }
);

// ============================================================================
// 8. Tab 4 & Tab 5: Multi-Deals + Stage History + Quotes/SO/Deposits/Invoices
// ============================================================================
contacts360Router.get(
  '/contacts/:id/commercial',
  requirePermission('leads', 'view'),
  async (req, res) => {
    try {
      const ctx = getTenantContext();
      const contactId = String(req.params.id || '').trim();

      const data = await withTenantTransaction(ctx.tenantId, async (client) => {
        const [dealsRes, historyRes, quotesRes, ordersRes, depositsRes, invoicesRes] =
          await Promise.all([
            client.query(
              `SELECT d.*, u.full_name AS owner_name, c.name AS company_name
               FROM tenant_deals d
               LEFT JOIN users u ON u.tenant_id = d.tenant_id AND u.id = d.owner_user_id
               LEFT JOIN tenant_b2b_companies c ON c.tenant_id = d.tenant_id AND c.id = d.company_id
               WHERE d.tenant_id = $1 AND d.lead_id = $2
               ORDER BY d.created_at DESC`,
              [ctx.tenantId, contactId]
            ),
            client.query(
              `SELECT h.*, d.title AS deal_title, d.deal_code
               FROM tenant_deal_stage_history h
               INNER JOIN tenant_deals d ON d.tenant_id = h.tenant_id AND d.id = h.deal_id
               WHERE h.tenant_id = $1 AND d.lead_id = $2
               ORDER BY h.created_at DESC
               LIMIT 100`,
              [ctx.tenantId, contactId]
            ),
            client.query(
              `SELECT * FROM tenant_quotes WHERE tenant_id = $1 AND lead_id = $2 ORDER BY created_at DESC`,
              [ctx.tenantId, contactId]
            ),
            client.query(
              `SELECT * FROM tenant_sales_orders WHERE tenant_id = $1 AND lead_id = $2 ORDER BY created_at DESC`,
              [ctx.tenantId, contactId]
            ),
            client.query(
              `SELECT * FROM tenant_deposits WHERE tenant_id = $1 AND lead_id = $2 ORDER BY created_at DESC`,
              [ctx.tenantId, contactId]
            ),
            client.query(
              `SELECT * FROM tenant_invoices WHERE tenant_id = $1 AND lead_id = $2 ORDER BY created_at DESC`,
              [ctx.tenantId, contactId]
            ),
          ]);

        return {
          deals: dealsRes.rows,
          stage_history: historyRes.rows,
          quotes: quotesRes.rows.map((q: any) => ({ ...q, items_json: parseJsonSafe(q.items_json, []) })),
          sales_orders: ordersRes.rows.map((o: any) => ({ ...o, items_json: parseJsonSafe(o.items_json, []) })),
          deposits: depositsRes.rows,
          invoices: invoicesRes.rows.map((inv: any) => ({ ...inv, items_json: parseJsonSafe(inv.items_json, []) })),
        };
      });

      res.json({ success: true, data });
    } catch (err: any) {
      sendApiError(res, 500, 'CRM_COMMERCIAL_TAB_FAILED', err?.message || 'Không thể tải dữ liệu giao dịch & tài chính.');
    }
  }
);

contacts360Router.post(
  '/contacts/:id/quick-quote',
  requirePermission('leads', 'edit'),
  async (req, res) => {
    try {
      const ctx = getTenantContext();
      const contactId = String(req.params.id || '').trim();
      const b = req.body || {};
      const title = String(b.title || 'Báo giá dịch vụ').trim();
      const totalVnd = Math.max(0, Math.round(Number(b.total_vnd || 0)));

      const quote = await withTenantTransaction(ctx.tenantId, async (client) => {
        const qId = crypto.randomUUID();
        const code = `BG-${Date.now().toString().slice(-6)}`;
        const items = Array.isArray(b.items) ? b.items : [{ name: title, qty: 1, unit_price_vnd: totalVnd }];
        await client.query(
          `INSERT INTO tenant_quotes (
             id, tenant_id, quote_code, title, lead_id, deal_id, company_id, status,
             items_json, subtotal_vnd, total_vnd, valid_until, terms_text, created_by
           ) VALUES ($1, $2, $3, $4, $5, $6, $7, 'sent', $8, $9, $9, $10, $11, $12)`,
          [
            qId,
            ctx.tenantId,
            code,
            title.slice(0, 255),
            contactId,
            b.deal_id || null,
            b.company_id || null,
            JSON.stringify(items),
            totalVnd,
            b.valid_until || null,
            b.terms_text || null,
            ctx.userId,
          ]
        );
        const r = await client.query('SELECT * FROM tenant_quotes WHERE tenant_id = $1 AND id = $2 LIMIT 1', [
          ctx.tenantId,
          qId,
        ]);
        return r.rows[0];
      });

      res.status(201).json({ success: true, data: quote });
    } catch (err: any) {
      sendApiError(res, 500, 'CRM_QUICK_QUOTE_FAILED', err?.message || 'Không thể tạo báo giá nhanh.');
    }
  }
);

contacts360Router.post(
  '/contacts/:id/quick-deposit',
  requirePermission('leads', 'edit'),
  async (req, res) => {
    try {
      const ctx = getTenantContext();
      const contactId = String(req.params.id || '').trim();
      const b = req.body || {};
      const amountVnd = Math.max(0, Math.round(Number(b.amount_vnd || 0)));

      const dep = await withTenantTransaction(ctx.tenantId, async (client) => {
        const leadRes = await client.query<{ name: string; company_id: string | null }>(
          'SELECT name, company_id FROM leads WHERE tenant_id = $1 AND id = $2 LIMIT 1',
          [ctx.tenantId, contactId]
        );
        const customerName = leadRes.rows[0]?.name || 'Khách hàng';
        const depId = crypto.randomUUID();
        const code = `COC-${Date.now().toString().slice(-6)}`;
        await client.query(
          `INSERT INTO tenant_deposits (
             id, tenant_id, deposit_code, lead_id, company_id, deal_id, customer_name,
             amount_vnd, payment_method, status, notes, received_by
           ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'received', $10, $11)`,
          [
            depId,
            ctx.tenantId,
            code,
            contactId,
            b.company_id || leadRes.rows[0]?.company_id || null,
            b.deal_id || null,
            customerName,
            amountVnd,
            String(b.payment_method || 'bank_transfer'),
            b.notes ? String(b.notes) : null,
            ctx.userId,
          ]
        );
        const r = await client.query('SELECT * FROM tenant_deposits WHERE tenant_id = $1 AND id = $2 LIMIT 1', [
          ctx.tenantId,
          depId,
        ]);
        return r.rows[0];
      });

      res.status(201).json({ success: true, data: dep });
    } catch (err: any) {
      sendApiError(res, 500, 'CRM_QUICK_DEPOSIT_FAILED', err?.message || 'Không thể ghi nhận đặt cọc.');
    }
  }
);

// ============================================================================
// 9. Tab 6 & Tab 7: Tasks/Tickets + Cloud Files + Dynamic Entity Tabs & Fields
// ============================================================================
contacts360Router.get(
  '/contacts/:id/tasks-tickets',
  requirePermission('leads', 'view'),
  async (req, res) => {
    try {
      const ctx = getTenantContext();
      const contactId = String(req.params.id || '').trim();

      const data = await withTenantTransaction(ctx.tenantId, async (client) => {
        const [tasksRes, activitiesRes, ticketsRes] = await Promise.all([
          client.query(
            `SELECT t.*, u.full_name AS assignee_name
             FROM tenant_tasks t
             LEFT JOIN users u ON u.tenant_id = t.tenant_id AND u.id = t.assignee_user_id
             WHERE t.tenant_id = $1 AND t.lead_id = $2
             ORDER BY t.created_at DESC`,
            [ctx.tenantId, contactId]
          ),
          client.query(
            `SELECT * FROM tenant_crm_activities
             WHERE tenant_id = $1 AND lead_id = $2
             ORDER BY created_at DESC LIMIT 50`,
            [ctx.tenantId, contactId]
          ),
          client.query(
            `SELECT tk.*, u.full_name AS assignee_name
             FROM tenant_helpdesk_tickets tk
             LEFT JOIN users u ON u.tenant_id = tk.tenant_id AND u.id = tk.assignee_user_id
             WHERE tk.tenant_id = $1 AND tk.lead_id = $2
             ORDER BY tk.created_at DESC`,
            [ctx.tenantId, contactId]
          ),
        ]);

        return {
          tasks: tasksRes.rows.map((t: any) => ({
            ...t,
            checklist_json: parseJsonSafe(t.checklist_json, []),
          })),
          activities: activitiesRes.rows,
          tickets: ticketsRes.rows,
        };
      });

      res.json({ success: true, data });
    } catch (err: any) {
      sendApiError(res, 500, 'CRM_TASKS_TICKETS_FAILED', err?.message || 'Không thể tải công việc & ticket.');
    }
  }
);

contacts360Router.get(
  '/contacts/:id/files',
  requirePermission('leads', 'view'),
  async (req, res) => {
    try {
      const ctx = getTenantContext();
      const contactId = String(req.params.id || '').trim();
      const items = await withTenantTransaction(ctx.tenantId, async (client) => {
        const r = await client.query(
          `SELECT * FROM tenant_contact_files
           WHERE tenant_id = $1 AND entity_type = 'contact' AND entity_id = $2
           ORDER BY created_at DESC`,
          [ctx.tenantId, contactId]
        );
        return r.rows;
      });
      res.json({ success: true, data: { items } });
    } catch (err: any) {
      sendApiError(res, 500, 'CRM_CONTACT_FILES_FAILED', err?.message || 'Không thể tải tài liệu khách hàng.');
    }
  }
);

contacts360Router.post(
  '/contacts/:id/files',
  requirePermission('leads', 'edit'),
  async (req, res) => {
    try {
      const ctx = getTenantContext();
      const contactId = String(req.params.id || '').trim();
      const b = req.body || {};
      const fileName = String(b.file_name || b.name || '').trim();
      const fileUrl = String(b.file_url || b.url || '').trim();
      if (!fileName || !fileUrl) {
        sendApiError(res, 400, 'INVALID_FILE_ATTACHMENT', 'Cần nhập tên tệp và đường dẫn tài liệu.');
        return;
      }

      const created = await withTenantTransaction(ctx.tenantId, async (client) => {
        const { actorName } = await resolveCrmActorContext(client, ctx.tenantId, ctx.userId);
        const fId = crypto.randomUUID();
        await client.query(
          `INSERT INTO tenant_contact_files (
             id, tenant_id, entity_type, entity_id, cloud_file_id, file_name, file_url,
             mime_type, size_bytes, category, uploaded_by, uploaded_by_name
           ) VALUES ($1, $2, 'contact', $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
          [
            fId,
            ctx.tenantId,
            contactId,
            b.cloud_file_id || null,
            fileName.slice(0, 255),
            fileUrl,
            String(b.mime_type || 'application/pdf'),
            Math.max(0, Math.round(Number(b.size_bytes || 0))),
            String(b.category || 'contract'),
            ctx.userId,
            actorName,
          ]
        );
        const r = await client.query('SELECT * FROM tenant_contact_files WHERE tenant_id = $1 AND id = $2 LIMIT 1', [
          ctx.tenantId,
          fId,
        ]);
        return r.rows[0];
      });

      res.status(201).json({ success: true, data: created });
    } catch (err: any) {
      sendApiError(res, 500, 'CRM_CONTACT_FILE_ADD_FAILED', err?.message || 'Không thể đính kèm tài liệu.');
    }
  }
);

contacts360Router.delete(
  '/contacts/:id/files/:fileId',
  requirePermission('leads', 'edit'),
  async (req, res) => {
    try {
      const ctx = getTenantContext();
      await withTenantTransaction(ctx.tenantId, async (client) => {
        await client.query(
          'DELETE FROM tenant_contact_files WHERE tenant_id = $1 AND entity_id = $2 AND id = $3',
          [ctx.tenantId, String(req.params.id), String(req.params.fileId)]
        );
      });
      res.json({ success: true, data: { deleted: true } });
    } catch (err: any) {
      sendApiError(res, 500, 'CRM_CONTACT_FILE_DELETE_FAILED', err?.message || 'Không thể gỡ tài liệu.');
    }
  }
);

// Dynamic Entity Tabs & Custom Fields Studio endpoints
contacts360Router.get(
  '/entity-tabs',
  requirePermission('leads', 'view'),
  async (req, res) => {
    try {
      const ctx = getTenantContext();
      const entityType = String(req.query.entity_type || 'contact').trim();
      const items = await withTenantTransaction(ctx.tenantId, async (client) => {
        const r = await client.query(
          `SELECT * FROM tenant_entity_tabs
           WHERE tenant_id = $1 AND entity_type = $2 AND is_active = true
           ORDER BY sort_order ASC, created_at ASC`,
          [ctx.tenantId, entityType]
        );
        return r.rows.map((row: any) => {
          const parsedFields = parseJsonSafe<any[]>(row.fields_json, []);
          const cfg = parseJsonSafe<Record<string, any>>(row.config_json, {});
          const fallbackFields = Array.isArray(cfg?.fields) ? cfg.fields : [];
          const parsedRoles = parseJsonSafe<any[]>(row.allowed_roles, []);
          const fallbackRoles = parseJsonSafe<any[]>(row.allowed_role_ids, []);
          return {
            ...row,
            tab_label: String(row.tab_label || row.label || ''),
            fields_json: parsedFields.length > 0 ? parsedFields : fallbackFields,
            allowed_roles: parsedRoles.length > 0 ? parsedRoles : fallbackRoles,
          };
        });
      });
      res.json({ success: true, data: { items } });
    } catch (err: any) {
      sendApiError(res, 500, 'CRM_ENTITY_TABS_GET_FAILED', err?.message || 'Không thể tải cấu hình Tab động.');
    }
  }
);

contacts360Router.post(
  '/entity-tabs',
  requirePermission('leads', 'manage_config'),
  async (req, res) => {
    try {
      const ctx = getTenantContext();
      const b = req.body || {};
      const tabLabel = String(b.tab_label || b.label || '').trim();
      if (!tabLabel) {
        sendApiError(res, 400, 'INVALID_TAB_LABEL', 'Tên tab động không được để trống.');
        return;
      }
      const tabKey = String(b.tab_key || slugifyTag(tabLabel)).slice(0, 64);
      const fieldsArr = Array.isArray(b.fields_json) ? b.fields_json : [];
      const rolesArr = Array.isArray(b.allowed_roles)
        ? b.allowed_roles
        : Array.isArray(b.allowed_role_ids)
          ? b.allowed_role_ids
          : [];
      const created = await withTenantTransaction(ctx.tenantId, async (client) => {
        const id = crypto.randomUUID();
        await client.query(
          `INSERT INTO tenant_entity_tabs (
             id, tenant_id, entity_type, tab_key, label, tab_label, icon_name, tab_type,
             sort_order, fields_json, config_json, allowed_roles, allowed_role_ids, is_active, created_by
           ) VALUES ($1, $2, $3, $4, $5, $6, $7, 'fields', $8, $9, $10, $11, $12, true, $13)`,
          [
            id,
            ctx.tenantId,
            String(b.entity_type || 'contact'),
            tabKey,
            tabLabel.slice(0, 140),
            tabLabel.slice(0, 150),
            String(b.icon_name || 'Layers'),
            Number(b.sort_order || 0),
            JSON.stringify(fieldsArr),
            JSON.stringify({ fields: fieldsArr }),
            JSON.stringify(rolesArr),
            JSON.stringify(rolesArr),
            ctx.userId,
          ]
        );
        const r = await client.query<Record<string, any>>(
          'SELECT * FROM tenant_entity_tabs WHERE tenant_id = $1 AND id = $2 LIMIT 1',
          [ctx.tenantId, id]
        );
        const row = r.rows[0] || {};
        return {
          ...row,
          tab_label: String(row.tab_label || row.label || tabLabel),
          fields_json: parseJsonSafe(row.fields_json, fieldsArr),
          allowed_roles: parseJsonSafe(row.allowed_roles, rolesArr),
        };
      });
      res.status(201).json({ success: true, data: created });
    } catch (err: any) {
      sendApiError(res, 500, 'CRM_ENTITY_TAB_CREATE_FAILED', err?.message || 'Không thể tạo Tab động.');
    }
  }
);
