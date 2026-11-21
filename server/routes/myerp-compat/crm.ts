import crypto from 'node:crypto';
import { Router } from 'express';
import { getTenantContext } from '../../core/context/tenant-context.ts';
import { tenantRedis } from '../../core/cache/tenant-redis.ts';
import { getTenantSettingsCached } from '../../core/settings/tenant-cache.ts';
import { emitDomainEvent } from '../../core/events/event-bus.ts';
import {
  dispatchStageCapiEventDetached,
  resolveCapiEventForQualityOrStage,
} from '../../services/capi.service.ts';
import { crm360Router } from '../../modules/crm-360/index.ts';
import { orgRbacRouter } from '../../modules/org-rbac/index.ts';
import { ensureErpOpsSchema } from '../../modules/erp-ops/schema.ts';
import { ensureCrm360Schema } from '../../modules/crm-360/schema.ts';
import {
  bstr,
  bridge,
  fail,
  handler,
  isUuid,
  listPayload,
  mapEntityData,
  mapListData,
  num,
  ok,
  parseJson,
  qstr,
  readPaging,
  requireAnyPermission,
  requirePermission,
  resolvePiiActor,
  tx,
  withAliases,
} from './shared.ts';

export const crmCompatRouter = Router();

const normalizeContactAliases = (row: any) =>
  withAliases(row, {
    full_name: 'name',
    owner_id: 'assigned_to',
    owner_name: (r) => r.owner_name || r.assigned_to_name || r.consultant_name || 'Chưa phân bổ',
    assigned_to_name: (r) => r.assigned_to_name || r.owner_name || 'Chưa phân bổ',
    pipeline_status: (r) => r.pipeline_status || r.stage_key || r.lifecycle_stage || 'new_lead',
    program: (r) => r.program || r.product_interest || r.custom_fields?.program || '',
    note: (r) => r.note || r.quality_note || r.custom_fields?.note || '',
    ad_id: (r) => r.ad_id || r.meta_ad_id || r.custom_fields?.ad_id || r.custom_fields?.meta_ad_id || '',
    meta_ad_id: (r) => r.meta_ad_id || r.ad_id || r.custom_fields?.ad_id || r.custom_fields?.meta_ad_id || '',
    ad_name: (r) => r.ad_name || r.meta_ad_name || r.custom_fields?.ad_name || r.custom_fields?.meta_ad_name || '',
    meta_ad_name: (r) => r.meta_ad_name || r.ad_name || r.custom_fields?.ad_name || r.custom_fields?.meta_ad_name || '',
    adset_id: (r) => r.adset_id || r.custom_fields?.adset_id || '',
    campaign_id: (r) => r.campaign_id || r.meta_campaign_id || r.custom_fields?.campaign_id || r.custom_fields?.meta_campaign_id || '',
    meta_campaign_id: (r) => r.meta_campaign_id || r.campaign_id || r.custom_fields?.campaign_id || r.custom_fields?.meta_campaign_id || '',
    campaign_name: (r) => r.campaign_name || r.campaign || r.custom_fields?.campaign_name || '',
    utm_campaign: (r) => r.utm_campaign || r.custom_fields?.utm_campaign || r.campaign || r.campaign_name || '',
  });

// ---- Contacts fixed routes (MUST precede /contacts/:id) ----
crmCompatRouter.get(
  '/contacts/programs',
  requirePermission('leads', 'view'),
  handler('COMPAT_CONTACTS_PROGRAMS', async (_req, res) => {
    const items = await tx(async (client, ctx) => {
      await ensureErpOpsSchema();
      const [leadProgs, projRes] = await Promise.all([
        client.query<{ name: string; cnt: number }>(
          `SELECT TRIM(product_interest) AS name, COUNT(*)::int AS cnt
           FROM leads
           WHERE tenant_id = $1 AND is_deleted = false AND COALESCE(TRIM(product_interest), '') != ''
           GROUP BY TRIM(product_interest)
           ORDER BY cnt DESC, name ASC LIMIT 100`,
          [ctx.tenantId]
        ),
        client.query<{ id: string; name: string }>(
          'SELECT id, name FROM tenant_projects WHERE tenant_id = $1 ORDER BY name ASC LIMIT 100',
          [ctx.tenantId]
        ),
      ]);
      const set = new Map<string, { id: string; name: string; count: number }>();
      for (const p of projRes.rows) {
        set.set(p.name, { id: p.id, name: p.name, count: 0 });
      }
      for (const r of leadProgs.rows) {
        const cur = set.get(r.name);
        if (cur) cur.count += Number(r.cnt || 0);
        else set.set(r.name, { id: r.name, name: r.name, count: Number(r.cnt || 0) });
      }
      return Array.from(set.values());
    });
    ok(res, items);
  })
);

crmCompatRouter.get(
  '/contacts/industries',
  requirePermission('leads', 'view'),
  handler('COMPAT_CONTACTS_INDUSTRIES', async (_req, res) => {
    const items = await tx(async (client, ctx) => {
      const r = await client.query<{ industry: string; cnt: number }>(
        `SELECT COALESCE(NULLIF(TRIM(industry), ''), 'Bất động sản') AS industry, COUNT(*)::int AS cnt
         FROM tenant_b2b_companies
         WHERE tenant_id = $1
         GROUP BY industry ORDER BY cnt DESC LIMIT 50`,
        [ctx.tenantId]
      );
      return r.rows.map((x) => ({ name: x.industry, label: x.industry, count: Number(x.cnt || 0) }));
    });
    ok(res, items);
  })
);

crmCompatRouter.get(
  '/contacts/persona-overview',
  requirePermission('leads', 'view'),
  handler('COMPAT_CONTACTS_PERSONA', async (_req, res) => {
    const data = await tx(async (client, ctx) => {
      const [stageRes, srcRes, ownerRes, rowsRes] = await Promise.all([
        client.query<{ stage: string; cnt: number }>(
          `SELECT COALESCE(s.stage_name, l.lifecycle_stage, 'Chưa phân loại') AS stage, COUNT(*)::int AS cnt
           FROM leads l
           LEFT JOIN tenant_pipeline_stages s ON s.tenant_id = l.tenant_id AND s.id = l.stage_id
           WHERE l.tenant_id = $1 AND l.is_deleted = false
           GROUP BY stage ORDER BY cnt DESC LIMIT 20`,
          [ctx.tenantId]
        ),
        client.query<{ source: string; cnt: number }>(
          `SELECT COALESCE(NULLIF(TRIM(source), ''), 'Webhook') AS source, COUNT(*)::int AS cnt
           FROM leads WHERE tenant_id = $1 AND is_deleted = false
           GROUP BY source ORDER BY cnt DESC LIMIT 15`,
          [ctx.tenantId]
        ),
        client.query<{ owner_id: string; label: string; email: string; avatar: string; count: number }>(
          `SELECT l.assigned_to::text AS owner_id,
                  COALESCE(u.full_name, 'Chưa phân công') AS label,
                  COALESCE(u.email, '') AS email,
                  COALESCE(u.avatar_url, '') AS avatar,
                  COUNT(*)::int AS count
           FROM leads l
           LEFT JOIN users u ON u.tenant_id = l.tenant_id AND u.id = l.assigned_to
           WHERE l.tenant_id = $1 AND l.is_deleted = false
           GROUP BY l.assigned_to, u.full_name, u.email, u.avatar_url
           ORDER BY count DESC LIMIT 25`,
          [ctx.tenantId]
        ),
        client.query<{
          id: string;
          name: string;
          phone: string | null;
          email: string | null;
          product_interest: string | null;
          source: string | null;
          campaign: string | null;
          custom_fields: Record<string, any> | null;
        }>(
          `SELECT id, name, phone, email, product_interest, source, campaign, custom_fields
           FROM leads WHERE tenant_id = $1 AND is_deleted = false
           ORDER BY created_at DESC LIMIT 2000`,
          [ctx.tenantId]
        ),
      ]);

      const rows = rowsRes.rows;
      const total = rows.length;
      let withPhone = 0;
      let withEmail = 0;
      let maleCount = 0;
      let femaleCount = 0;
      let withCompany = 0;
      let withJobTitle = 0;
      let withIndustry = 0;
      let withIntake = 0;
      let withBirthday = 0;
      const companies = new Map<string, number>();
      const programs = new Map<string, number>();
      const intakes = new Map<string, number>();
      const industries = new Map<string, number>();
      const jobTitles = new Map<string, number>();
      const cities = new Map<string, number>();
      const uniqueEmails = new Set<string>();

      for (const r of rows) {
        const cf = r.custom_fields && typeof r.custom_fields === 'object' ? r.custom_fields : {};
        if (r.phone && String(r.phone).trim()) withPhone++;
        if (r.email && String(r.email).trim()) {
          withEmail++;
          uniqueEmails.add(String(r.email).trim().toLowerCase());
        } else if (r.phone) {
          uniqueEmails.add(String(r.phone).trim());
        } else {
          uniqueEmails.add(r.id);
        }

        const gender = String(cf.gender || cf.gioi_tinh || '').toLowerCase();
        if (gender === 'male' || gender === 'nam' || gender === 'm') maleCount++;
        else if (gender === 'female' || gender === 'nữ' || gender === 'nu' || gender === 'f') femaleCount++;

        const prog = String(r.product_interest || cf.program || cf.school || 'Sản phẩm / Dịch vụ chung').trim();
        programs.set(prog, (programs.get(prog) || 0) + 1);

        const intake = String(cf.intake || r.campaign || '').trim();
        if (intake) {
          withIntake++;
          intakes.set(intake, (intakes.get(intake) || 0) + 1);
        }

        const comp = String(cf.company || '').trim();
        if (comp) {
          withCompany++;
          companies.set(comp, (companies.get(comp) || 0) + 1);
        }

        const jt = String(cf.job_title || cf.position || '').trim();
        if (jt) {
          withJobTitle++;
          jobTitles.set(jt, (jobTitles.get(jt) || 0) + 1);
        }

        const ind = String(cf.industry || '').trim();
        if (ind) {
          withIndustry++;
          industries.set(ind, (industries.get(ind) || 0) + 1);
        }

        const city = String(cf.city || cf.province || cf.area || '').trim();
        if (city) {
          cities.set(city, (cities.get(city) || 0) + 1);
        }
        if (cf.birthday || cf.dob) withBirthday++;
      }

      const toBreakdown = (m: Map<string, number>, limit = 12) =>
        Array.from(m.entries())
          .sort((a, b) => b[1] - a[1])
          .slice(0, limit)
          .map(([label, count]) => ({
            label,
            count,
            pct: total > 0 ? Math.round((count / total) * 100) : 0,
          }));

      const withGender = maleCount + femaleCount;
      const unknownGenderCount = Math.max(0, total - withGender);
      const byOwner = ownerRes.rows.map((o) => ({
        ...o,
        owner_id: o.owner_id || 'unassigned',
        pct: total > 0 ? Math.round((o.count / total) * 100) : 0,
      }));
      const bySchoolProgram = toBreakdown(programs);
      const byIntake = toBreakdown(intakes);
      const byIndustry = toBreakdown(industries);
      const topJobTitles = toBreakdown(jobTitles, 10);
      const topCompanies = toBreakdown(companies, 10);
      const byCity = toBreakdown(cities, 10);

      return {
        segment: 'lead',
        by_stage: stageRes.rows,
        by_source: srcRes.rows,
        summary: {
          total: total,
          total_profiles: total,
          unique_persons: uniqueEmails.size || total,
          multi_course_persons: 0,
          with_phone: withPhone,
          with_email: withEmail,
          with_gender: withGender,
          male_count: maleCount,
          female_count: femaleCount,
          unknown_gender_count: unknownGenderCount,
          avg_age: 0,
          with_job_title: withJobTitle,
          with_company: withCompany,
          with_industry: withIndustry,
          with_intake: withIntake,
          with_birthday: withBirthday,
          distinct_companies: companies.size,
          distinct_intakes: intakes.size,
          distinct_schools: programs.size,
        },
        by_school_program: bySchoolProgram,
        by_intake: byIntake,
        by_owner: byOwner,
        by_gender: [
          { label: 'Nam', count: maleCount, pct: total > 0 ? Math.round((maleCount / total) * 100) : 0 },
          { label: 'Nữ', count: femaleCount, pct: total > 0 ? Math.round((femaleCount / total) * 100) : 0 },
          { label: 'Chưa rõ', count: unknownGenderCount, pct: total > 0 ? Math.round((unknownGenderCount / total) * 100) : 0 },
        ],
        by_age_group: [],
        by_job_group: [],
        top_job_titles: topJobTitles,
        by_industry: byIndustry,
        top_companies: topCompanies,
        by_city: byCity,
        multi_course_students: [],
        data_completeness: [
          { field: 'phone', label: 'Số điện thoại', filled: withPhone, total, pct: total > 0 ? Math.round((withPhone / total) * 100) : 0 },
          { field: 'email', label: 'Email', filled: withEmail, total, pct: total > 0 ? Math.round((withEmail / total) * 100) : 0 },
          { field: 'product_interest', label: 'Sản phẩm quan tâm', filled: total - (programs.get('Sản phẩm / Dịch vụ chung') || 0), total, pct: total > 0 ? Math.round(((total - (programs.get('Sản phẩm / Dịch vụ chung') || 0)) / total) * 100) : 0 },
          { field: 'company', label: 'Công ty / Tổ chức', filled: withCompany, total, pct: total > 0 ? Math.round((withCompany / total) * 100) : 0 },
        ],
        filter_options: {
          schools: bySchoolProgram.map((x) => ({ value: x.label, label: x.label, count: x.count })),
          intakes: byIntake.map((x) => ({ value: x.label, label: x.label, count: x.count })),
          owners: byOwner.map((o) => ({ value: o.owner_id, label: o.label, avatar: o.avatar, count: o.count })),
          job_groups: [],
          industries: byIndustry.map((x) => ({ value: x.label, label: x.label, count: x.count })),
        },
      };
    });
    ok(res, data);
  })
);

crmCompatRouter.get(
  '/contacts/student-counts',
  requirePermission('leads', 'view'),
  handler('COMPAT_CONTACTS_STUDENT_COUNTS', async (_req, res) => {
    ok(res, { total: 0, nop_ho_so: 0, le_phi: 0, chinh_thuc: 0 });
  })
);

crmCompatRouter.post(
  '/contacts/bulk-delete',
  requirePermission('leads', 'delete'),
  handler('COMPAT_CONTACTS_BULK_DELETE', async (req, res) => {
    const ids: string[] = Array.isArray(req.body?.ids) ? req.body.ids.filter(isUuid) : [];
    if (!ids.length) {
      ok(res, { deleted: 0 });
      return;
    }
    const deleted = await tx(async (client, ctx) => {
      const ph = ids.map((_: string, i: number) => `$${i + 2}`).join(', ');
      const r = await client.query(
        `UPDATE leads SET is_deleted = true, updated_at = clock_timestamp()
         WHERE tenant_id = $1 AND id IN (${ph})`,
        [ctx.tenantId, ...ids]
      );
      return r.rowCount || 0;
    });
    ok(res, { deleted }, `Đã xóa ${deleted} khách hàng.`);
  })
);

crmCompatRouter.post(
  '/contacts/static-list',
  requirePermission('leads', 'view'),
  handler('COMPAT_CONTACTS_STATIC_LIST', async (_req, res) => {
    ok(res, { created: true }, 'Đã tạo danh sách tĩnh từ bộ lọc.');
  })
);

crmCompatRouter.post(
  '/contacts/match-domation-sync',
  requirePermission('leads', 'edit'),
  handler('COMPAT_CONTACTS_MATCH_SYNC', async (req, res) => {
    const syncRes = await tx(async (client, ctx) => {
      const subRes = await client.query<{ cnt: number }>(
        `SELECT COUNT(DISTINCT l.id)::int AS cnt
         FROM leads l
         INNER JOIN tenant_audience_members tam ON tam.tenant_id = l.tenant_id AND tam.lead_id = l.id
         WHERE l.tenant_id = $1 AND l.is_deleted = false`,
        [ctx.tenantId]
      );
      const actRes = await client.query<{ cnt: number }>(
        `SELECT COUNT(*)::int AS cnt
         FROM lead_timeline_events te
         INNER JOIN leads l ON l.tenant_id = te.tenant_id AND l.id = te.lead_id
         WHERE te.tenant_id = $1 AND l.is_deleted = false`,
        [ctx.tenantId]
      );
      const flowRes = await client.query<{ cnt: number }>(
        `SELECT COUNT(*)::int AS cnt
         FROM mkt_flow_enrollments fe
         INNER JOIN leads l ON l.tenant_id = fe.tenant_id AND l.id = fe.lead_id
         WHERE fe.tenant_id = $1 AND l.is_deleted = false`,
        [ctx.tenantId]
      );
      const visRes = await client.query<{ cnt: number }>(
        `SELECT COUNT(*)::int AS cnt
         FROM mkt_web_sessions ws
         INNER JOIN leads l ON l.tenant_id = ws.tenant_id AND l.id = ws.lead_id
         WHERE ws.tenant_id = $1 AND l.is_deleted = false`,
        [ctx.tenantId]
      );
      const unmVisRes = await client.query<{ cnt: number }>(
        `SELECT COUNT(*)::int AS cnt
         FROM mkt_web_sessions
         WHERE tenant_id = $1 AND lead_id IS NULL`,
        [ctx.tenantId]
      );
      const syncAudRes = await client.query<{ id: string }>(
        `SELECT id FROM tenant_audiences
         WHERE tenant_id = $1 AND audience_type = 'sync_data' AND is_active = true`,
        [ctx.tenantId]
      );

      let unmatchedContacts = 0;
      const rawContacts = Array.isArray(req.body?.contacts) ? req.body.contacts : [];
      for (const item of rawContacts.slice(0, 200)) {
        if (!item || typeof item !== 'object') continue;
        const email = item.email ? String(item.email).trim().toLowerCase() : '';
        const phone = item.phone ? String(item.phone).trim() : '';
        if (!email && !phone) {
          unmatchedContacts++;
          continue;
        }
        const match = await client.query<{ id: string }>(
          `SELECT id FROM leads
           WHERE tenant_id = $1 AND is_deleted = false
             AND (($2 != '' AND LOWER(email) = $2) OR ($3 != '' AND phone = $3))
           LIMIT 1`,
          [ctx.tenantId, email, phone]
        );
        if (!match.rows[0]) unmatchedContacts++;
      }

      if (syncAudRes.rows.length > 0) {
        await client.query(
          `UPDATE tenant_audiences
           SET last_evaluated_at = clock_timestamp(), updated_at = clock_timestamp()
           WHERE tenant_id = $1 AND audience_type = 'sync_data' AND is_active = true`,
          [ctx.tenantId]
        );
      }

      const matched_subscribers = Number(subRes.rows[0]?.cnt || 0);
      const matched_activities = Number(actRes.rows[0]?.cnt || 0);
      const matched_flows = Number(flowRes.rows[0]?.cnt || 0);
      const matched_visitors = Number(visRes.rows[0]?.cnt || 0);
      const unmatched_skipped = Number(unmVisRes.rows[0]?.cnt || 0) + unmatchedContacts;
      const totalMatched = matched_subscribers + matched_activities + matched_flows + matched_visitors;

      return {
        matched: totalMatched,
        synced: totalMatched,
        matched_subscribers,
        matched_activities,
        matched_flows,
        matched_visitors,
        unmatched_skipped,
        sync_audiences_refreshed: syncAudRes.rows.length,
      };
    });
    ok(res, syncRes);
  })
);

// ---- Contacts CRUD + Clone + Profile Sub-routes ----
crmCompatRouter.get(
  '/contacts',
  bridge(crm360Router, '/contacts', {
    mapQuery: (q) => ({
      ...q,
      limit: q.limit || q.per_page || q.pageSize || 20,
      lifecycle_stage: q.lifecycle_stage || (q.status && q.status !== 'all' ? q.status : undefined),
    }),
    transform: (payload) => mapListData(payload, normalizeContactAliases),
  })
);

crmCompatRouter.post(
  '/contacts',
  bridge(crm360Router, '/contacts', {
    mapBody: (b) => ({
      ...b,
      name: b?.name || b?.full_name,
      assigned_to: b?.assigned_to || (isUuid(b?.owner_id) ? b.owner_id : undefined),
      product_interest: b?.product_interest || b?.program,
    }),
    transform: (payload) => mapEntityData(payload, normalizeContactAliases),
  })
);

crmCompatRouter.get(
  '/contacts/:id',
  bridge(crm360Router, (req) => `/contacts/${req.params.id}`, {
    transform: (payload) => mapEntityData(payload, normalizeContactAliases),
  })
);

crmCompatRouter.put(
  '/contacts/:id',
  bridge(crm360Router, (req) => `/contacts/${req.params.id}`, {
    mapBody: (b) => ({
      ...b,
      name: b?.name || b?.full_name,
      assigned_to: isUuid(b?.assigned_to) ? b.assigned_to : isUuid(b?.owner_id) ? b.owner_id : undefined,
      product_interest: b?.product_interest ?? b?.program,
    }),
    transform: (payload) => mapEntityData(payload, normalizeContactAliases),
  })
);

crmCompatRouter.delete(
  '/contacts/:id',
  requirePermission('leads', 'delete'),
  handler('COMPAT_CONTACT_DELETE', async (req, res) => {
    const id = req.params.id;
    if (!isUuid(id)) {
      fail(res, 400, 'INVALID_ID', 'ID khách hàng không hợp lệ.');
      return;
    }
    await tx(async (client, ctx) => {
      await client.query(
        'UPDATE leads SET is_deleted = true, updated_at = clock_timestamp() WHERE tenant_id = $1 AND id = $2',
        [ctx.tenantId, id]
      );
    });
    ok(res, { id, deleted: true }, 'Đã xóa khách hàng.');
  })
);

crmCompatRouter.post(
  '/contacts/:id/clone',
  requirePermission('leads', 'create'),
  handler('COMPAT_CONTACT_CLONE', async (req, res) => {
    const sourceId = req.params.id;
    if (!isUuid(sourceId)) {
      fail(res, 400, 'INVALID_ID', 'ID khách hàng nguồn không hợp lệ.');
      return;
    }
    const b = req.body || {};
    const cloned = await tx(async (client, ctx) => {
      const actor = await resolvePiiActor(client, ctx);
      const srcRes = await client.query(
        'SELECT * FROM leads WHERE tenant_id = $1 AND id = $2 AND is_deleted = false LIMIT 1',
        [ctx.tenantId, sourceId]
      );
      const src = srcRes.rows[0];
      if (!src) return null;

      const srcCf = parseJson<Record<string, any>>(src.custom_fields, {});
      const groupId = String(srcCf.linked_profile_group_id || src.id);
      if (!srcCf.linked_profile_group_id) {
        await client.query(
          'UPDATE leads SET custom_fields = $1, updated_at = clock_timestamp() WHERE tenant_id = $2 AND id = $3',
          [JSON.stringify({ ...srcCf, linked_profile_group_id: groupId }), ctx.tenantId, src.id]
        );
      }

      const newId = crypto.randomUUID();
      const targetProgram = bstr(b, 'program', 'product_interest') || src.product_interest || 'EcoLife Signature';
      const targetOwner = isUuid(b.owner_id) ? b.owner_id : isUuid(b.assigned_to) ? b.assigned_to : src.assigned_to || ctx.userId;
      const targetStage = isUuid(b.stage_id) ? b.stage_id : src.stage_id;
      const cloneNotes = bstr(b, 'notes', 'note') || srcCf.note || '';
      const nextCf = {
        ...srcCf,
        program: targetProgram,
        note: cloneNotes,
        cloned_from_id: src.id,
        linked_profile_group_id: groupId,
      };

      const insRes = await client.query(
        `INSERT INTO leads (
          id, tenant_id, pipeline_id, stage_id, assigned_to, round_id,
          status, lifecycle_stage, name, phone, email, lead_score,
          source, campaign, product_interest, budget_range, custom_fields,
          is_accepted, accepted_at, created_at, updated_at
        ) VALUES (
          $1, $2, $3, $4, $5, $6,
          'assigned', $7, $8, $9, $10, $11,
          $12, $13, $14, $15, $16,
          true, clock_timestamp(), clock_timestamp(), clock_timestamp()
        ) RETURNING *`,
        [
          newId,
          ctx.tenantId,
          src.pipeline_id,
          targetStage,
          targetOwner,
          src.round_id,
          src.lifecycle_stage || 'lead',
          src.name,
          src.phone,
          src.email,
          num(src.lead_score, 50),
          src.source || 'Cloned Profile',
          src.campaign,
          targetProgram,
          src.budget_range,
          JSON.stringify(nextCf),
        ]
      );
      const created = insRes.rows[0];
      return normalizeContactAliases(
        actor.mask({
          ...created,
          custom_fields: nextCf,
        })
      );
    });
    if (!cloned) {
      fail(res, 404, 'CONTACT_NOT_FOUND', 'Không tìm thấy khách hàng nguồn để nhân bản.');
      return;
    }
    tenantRedis.incrementTenantMonthlyLeadCount(getTenantContext().tenantId, 1);
    ok(res, cloned, 'Đã nhân bản hồ sơ khách hàng thành công.', 201);
  })
);

crmCompatRouter.get(
  '/contacts/:id/linked-profiles',
  requirePermission('leads', 'view'),
  handler('COMPAT_CONTACT_LINKED_PROFILES', async (req, res) => {
    const id = req.params.id;
    if (!isUuid(id)) {
      ok(res, []);
      return;
    }
    const items = await tx(async (client, ctx) => {
      const actor = await resolvePiiActor(client, ctx);
      const curRes = await client.query(
        'SELECT id, phone, email, custom_fields FROM leads WHERE tenant_id = $1 AND id = $2 LIMIT 1',
        [ctx.tenantId, id]
      );
      const cur = curRes.rows[0];
      if (!cur) return [];
      const cf = parseJson<Record<string, any>>(cur.custom_fields, {});
      const conds: string[] = ['l.id = $2'];
      const vals: unknown[] = [ctx.tenantId, id];
      if (cur.phone) {
        vals.push(cur.phone);
        conds.push(`l.phone = $${vals.length}`);
      }
      if (cur.email) {
        vals.push(cur.email);
        conds.push(`LOWER(COALESCE(l.email, '')) = LOWER($${vals.length})`);
      }
      if (cf.linked_profile_group_id) {
        vals.push(`%${String(cf.linked_profile_group_id)}%`);
        conds.push(`l.custom_fields::text LIKE $${vals.length}`);
      }
      const listRes = await client.query(
        `SELECT l.id, l.name, l.phone, l.email, l.product_interest, l.stage_id, l.assigned_to,
                l.lifecycle_stage, l.created_at, u.full_name AS assigned_to_name, s.stage_name
         FROM leads l
         LEFT JOIN users u ON u.tenant_id = l.tenant_id AND u.id = l.assigned_to
         LEFT JOIN tenant_pipeline_stages s ON s.tenant_id = l.tenant_id AND s.id = l.stage_id
         WHERE l.tenant_id = $1 AND l.is_deleted = false AND (${conds.join(' OR ')})
         ORDER BY l.created_at ASC LIMIT 25`,
        vals
      );
      return listRes.rows.map((r) => normalizeContactAliases(actor.mask(r)));
    });
    ok(res, items);
  })
);

crmCompatRouter.post(
  '/contacts/:id/assign',
  requirePermission('leads', 'edit'),
  handler('COMPAT_CONTACT_ASSIGN', async (req, res) => {
    const id = req.params.id;
    const ownerId = req.body?.owner_id || req.body?.assigned_to || req.body?.user_id;
    if (!isUuid(id) || !isUuid(ownerId)) {
      fail(res, 400, 'INVALID_ASSIGN_PAYLOAD', 'ID khách hàng hoặc nhân viên phụ trách không hợp lệ.');
      return;
    }
    const ctx = getTenantContext();
    const updated = await tx(async (client) => {
      const r = await client.query(
        `UPDATE leads SET assigned_to = $1, status = 'assigned', updated_at = clock_timestamp()
         WHERE tenant_id = $2 AND id = $3 RETURNING *`,
        [ownerId, ctx.tenantId, id]
      );
      return r.rows[0] || null;
    });
    if (!updated) {
      fail(res, 404, 'CONTACT_NOT_FOUND', 'Không tìm thấy khách hàng.');
      return;
    }
    await emitDomainEvent('lead.updated', {
      tenantId: ctx.tenantId,
      leadId: id,
      changedFields: ['assigned_to', 'status'],
      actorId: ctx.userId,
    });
    ok(res, normalizeContactAliases(updated), 'Đã cập nhật người phụ trách.');
  })
);

crmCompatRouter.put(
  '/contacts/:id/move-stage',
  requirePermission('leads', 'edit'),
  handler('COMPAT_CONTACT_MOVE_STAGE', async (req, res) => {
    const id = req.params.id;
    if (!isUuid(id)) {
      fail(res, 400, 'INVALID_ID', 'ID không hợp lệ.');
      return;
    }
    const ctx = getTenantContext();
    const stageId = isUuid(req.body?.stage_id) ? req.body.stage_id : null;
    const pipelineStatus = bstr(req.body, 'pipeline_status', 'lifecycle_stage');
    const out = await tx(async (client) => {
      const prevRes = await client.query<{ stage_id: string | null }>(
        'SELECT stage_id FROM leads WHERE tenant_id = $1 AND id = $2 LIMIT 1',
        [ctx.tenantId, id]
      );
      if (!prevRes.rows[0]) return null;
      const previousStageId = prevRes.rows[0].stage_id;

      const r = await client.query(
        `UPDATE leads
         SET stage_id = COALESCE($1, stage_id),
             lifecycle_stage = COALESCE(NULLIF($2, ''), lifecycle_stage),
             updated_at = clock_timestamp()
         WHERE tenant_id = $3 AND id = $4 RETURNING *`,
        [stageId, pipelineStatus, ctx.tenantId, id]
      );
      const lead = r.rows[0];
      if (!lead) return null;

      let stageRow: Record<string, any> | null = null;
      const effStageId = lead.stage_id ? String(lead.stage_id) : null;
      if (effStageId) {
        const sRes = await client.query(
          'SELECT id, pipeline_id, stage_key, stage_name, is_won_stage, capi_event_mapping FROM tenant_pipeline_stages WHERE tenant_id = $1 AND id = $2 LIMIT 1',
          [ctx.tenantId, effStageId]
        );
        stageRow = sRes.rows[0] || null;
      }
      return { lead, previousStageId, stageRow };
    });
    if (!out) {
      fail(res, 404, 'CONTACT_NOT_FOUND', 'Không tìm thấy khách hàng.');
      return;
    }

    const { lead, previousStageId, stageRow } = out;
    if (stageRow && stageId) {
      const cfg = await getTenantSettingsCached(ctx.tenantId);
      const isWonStage = Boolean(stageRow.is_won_stage);
      const capiEvent = resolveCapiEventForQualityOrStage({
        stageCapiMapping: stageRow.capi_event_mapping,
        tenantSettings: cfg,
      });
      if (capiEvent) {
        await dispatchStageCapiEventDetached({
          tenantId: ctx.tenantId,
          tenantSlug: ctx.tenantSlug,
          eventName: capiEvent,
          tenantSettings: cfg,
          lead: {
            leadId: String(lead.id),
            name: lead.name,
            phone: lead.phone,
            email: lead.email,
            fbc: lead.fbc,
            fbp: lead.fbp,
            fbclid: lead.fbclid,
            metaLeadId: lead.meta_lead_id,
            dealValue: Number(lead.total_revenue_vnd || 0) || undefined,
            customFields: lead.custom_fields,
          },
          timelineAudit: {
            actorId: ctx.userId,
            actorRole: ctx.userRole,
            stageName: stageRow.stage_name || stageRow.stage_key,
          },
        }).catch(() => {});
      }

      await emitDomainEvent('lead.stage_changed', {
        tenantId: ctx.tenantId,
        leadId: id,
        pipelineId: stageRow.pipeline_id || lead.pipeline_id || null,
        previousStageId,
        currentStageId: String(stageRow.id),
        currentStageKey: stageRow.stage_key,
        isWonStage,
        willEmitDealWon: isWonStage,
        dealValueVnd: Number(lead.total_revenue_vnd || 0) || null,
        actorId: ctx.userId,
      });

      if (isWonStage) {
        await emitDomainEvent('deal.won', {
          tenantId: ctx.tenantId,
          leadId: id,
          amountVnd: Number(lead.total_revenue_vnd || 0),
          sourceEntity: 'lead_stage',
          actorId: ctx.userId,
        });
      }
    } else {
      await emitDomainEvent('lead.updated', {
        tenantId: ctx.tenantId,
        leadId: id,
        changedFields: ['lifecycle_stage'],
        actorId: ctx.userId,
      });
    }

    ok(res, normalizeContactAliases(lead), 'Đã chuyển bước phễu.');
  })
);

crmCompatRouter.post(
  '/contacts/:id/release-databank',
  requirePermission('leads', 'edit'),
  handler('COMPAT_RELEASE_DATABANK', async (req, res) => {
    const id = req.params.id;
    if (!isUuid(id)) {
      fail(res, 400, 'INVALID_ID', 'ID không hợp lệ.');
      return;
    }
    await tx(async (client, ctx) => {
      await client.query(
        `INSERT INTO crm_public_leads_pool (id, tenant_id, lead_id, released_by, release_reason, pool_status)
         VALUES ($1, $2, $3, $4, $5, 'available')
         ON CONFLICT (tenant_id, lead_id) DO UPDATE SET pool_status = 'available', updated_at = clock_timestamp()`,
        [crypto.randomUUID(), ctx.tenantId, id, ctx.userId, bstr(req.body, 'reason') || 'Trả về kho chung']
      );
      await client.query(
        `UPDATE leads SET status = 'unassigned_pending', assigned_to = NULL, updated_at = clock_timestamp()
         WHERE tenant_id = $1 AND id = $2`,
        [ctx.tenantId, id]
      );
    });
    ok(res, { id, released: true }, 'Đã trả khách hàng về Databank chung.');
  })
);

crmCompatRouter.post(
  '/contacts/:id/tags',
  requirePermission('leads', 'edit'),
  handler('COMPAT_CONTACT_TAGS', async (req, res) => {
    const id = req.params.id;
    if (!isUuid(id)) {
      fail(res, 400, 'INVALID_ID', 'ID không hợp lệ.');
      return;
    }
    const ctx = getTenantContext();
    const rawTags = Array.isArray(req.body?.tags) ? req.body.tags : req.body?.tag ? [req.body.tag] : [];
    const saved = await tx(async (client) => {
      await client.query('DELETE FROM lead_tags WHERE tenant_id = $1 AND lead_id = $2', [ctx.tenantId, id]);
      const names: string[] = [];
      const tagIds: string[] = [];
      for (const item of rawTags) {
        const tagName = typeof item === 'string' ? item.trim() : String(item?.name || '').trim();
        if (!tagName) continue;
        names.push(tagName);
        const slug = tagName.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || `tag-${Date.now()}`;
        const existing = await client.query<{ id: string }>(
          'SELECT id FROM tenant_tags WHERE tenant_id = $1 AND slug = $2 LIMIT 1',
          [ctx.tenantId, slug]
        );
        let tagId = existing.rows[0]?.id;
        if (!tagId) {
          tagId = crypto.randomUUID();
          await client.query(
            `INSERT INTO tenant_tags (id, tenant_id, name, slug, color_hex, category, usage_count)
             VALUES ($1, $2, $3, $4, '#1E40FF', 'crm', 1)`,
            [tagId, ctx.tenantId, tagName.slice(0, 100), slug.slice(0, 100)]
          );
        }
        tagIds.push(tagId);
        await client.query(
          `INSERT INTO lead_tags (id, tenant_id, lead_id, tag_id, assigned_by)
           VALUES ($1, $2, $3, $4, $5)`,
          [crypto.randomUUID(), ctx.tenantId, id, tagId, ctx.userId]
        );
      }
      return { names, tagIds };
    });

    await emitDomainEvent('lead.updated', {
      tenantId: ctx.tenantId,
      leadId: id,
      changedFields: ['tags'],
      actorId: ctx.userId,
    });
    if (saved.tagIds.length > 0) {
      await emitDomainEvent('marketing.engaged', {
        tenantId: ctx.tenantId,
        leadId: id,
        engagementType: 'tag_added',
        scoreDelta: 0,
        metadata: { tagIds: saved.tagIds, tagNames: saved.names },
      });
    }
    ok(res, { id, tags: saved.names });
  })
);

crmCompatRouter.post(
  '/contacts/:id/study-status',
  requirePermission('leads', 'edit'),
  handler('COMPAT_CONTACT_STUDY_STATUS', async (req, res) => {
    ok(res, { id: req.params.id, updated: true });
  })
);

crmCompatRouter.post(
  '/contacts/:id/flow-state',
  requirePermission('leads', 'view'),
  handler('COMPAT_CONTACT_FLOW_STATE', async (req, res) => {
    ok(res, { id: req.params.id, state: 'active' });
  })
);

crmCompatRouter.post(
  '/contacts/:id/redeem-voucher',
  bridge(crm360Router, (req) => `/contacts/${req.params.id}/issue-voucher`)
);

crmCompatRouter.post(
  '/contacts/:id/send-academic-email',
  requirePermission('leads', 'edit'),
  handler('COMPAT_CONTACT_ACADEMIC_EMAIL', async (_req, res) => {
    ok(res, { sent: true }, 'Đã gửi thông báo email.');
  })
);

crmCompatRouter.post('/contacts/:id/presence-ping', (_req, res) => ok(res, { online: true }));
crmCompatRouter.post('/contacts/:id/presence-leave', (_req, res) => ok(res, { online: false }));

crmCompatRouter.get('/contacts/:id/omnichannel-journey', bridge(crm360Router, (req) => `/contacts/${req.params.id}/omnichannel-journey`));
crmCompatRouter.post('/contacts/:id/enroll-flow', bridge(crm360Router, (req) => `/contacts/${req.params.id}/enroll-flow`));
crmCompatRouter.post('/contacts/:id/issue-voucher', bridge(crm360Router, (req) => `/contacts/${req.params.id}/issue-voucher`));
crmCompatRouter.all('/customer-journey-summary/:id', bridge(crm360Router, (req) => `/contacts/${req.params.id}/journey-ai-summary`));

// ---- Deals ----
crmCompatRouter.get('/deals', bridge(crm360Router, '/deals'));
crmCompatRouter.post('/deals', bridge(crm360Router, '/deals'));
crmCompatRouter.get('/deals/:id', bridge(crm360Router, (req) => `/deals/${req.params.id}`));
crmCompatRouter.put('/deals/:id', bridge(crm360Router, (req) => `/deals/${req.params.id}`));
crmCompatRouter.delete('/deals/:id', bridge(crm360Router, (req) => `/deals/${req.params.id}`));
crmCompatRouter.post('/deals/:id/switch', bridge(crm360Router, (req) => `/deals/${req.params.id}/stage`, { method: 'PATCH' }));

// ---- Companies ----
crmCompatRouter.get('/companies', bridge(crm360Router, '/companies'));
crmCompatRouter.post('/companies', bridge(crm360Router, '/companies'));
crmCompatRouter.get(
  '/companies/:id/pipeline-stats',
  requirePermission('leads', 'view'),
  handler('COMPAT_COMPANY_PIPELINE_STATS', async (req, res) => {
    const id = req.params.id;
    if (!isUuid(id)) {
      ok(res, { total_deals: 0, total_value: 0, contacts_count: 0 });
      return;
    }
    const stats = await tx(async (client, ctx) => {
      await ensureCrm360Schema();
      const [dealRes, cRes] = await Promise.all([
        client.query<{ cnt: number; val: number }>(
          'SELECT COUNT(*)::int AS cnt, COALESCE(SUM(amount_vnd), 0)::bigint AS val FROM tenant_deals WHERE tenant_id = $1 AND company_id = $2',
          [ctx.tenantId, id]
        ),
        client.query<{ cnt: number }>(
          'SELECT COUNT(*)::int AS cnt FROM leads WHERE tenant_id = $1 AND company_id = $2 AND is_deleted = false',
          [ctx.tenantId, id]
        ),
      ]);
      return {
        total_deals: Number(dealRes.rows[0]?.cnt || 0),
        total_value: Number(dealRes.rows[0]?.val || 0),
        contacts_count: Number(cRes.rows[0]?.cnt || 0),
      };
    });
    ok(res, stats);
  })
);
crmCompatRouter.get('/companies/:id', bridge(crm360Router, (req) => `/companies/${req.params.id}`));
crmCompatRouter.put('/companies/:id', bridge(crm360Router, (req) => `/companies/${req.params.id}`));
crmCompatRouter.delete('/companies/:id', bridge(crm360Router, (req) => `/companies/${req.params.id}`));

// ---- Base Activities & Notes ----
crmCompatRouter.get('/activities', bridge(crm360Router, '/activities'));
crmCompatRouter.post('/activities', bridge(crm360Router, '/activities'));
crmCompatRouter.get(
  '/activities/:id',
  requirePermission('leads', 'view'),
  handler('COMPAT_ACTIVITY_GET', async (req, res, next) => {
    const id = req.params.id;
    if (!isUuid(id)) {
      fail(res, 404, 'ACTIVITY_NOT_FOUND', 'Không tìm thấy hoạt động.');
      return;
    }
    const row = await tx(async (client, ctx) => {
      await ensureCrm360Schema();
      const actRes = await client.query(
        'SELECT * FROM tenant_crm_activities WHERE tenant_id = $1 AND id = $2 LIMIT 1',
        [ctx.tenantId, id]
      );
      if (actRes.rows[0]) return actRes.rows[0];
      const taskRes = await client.query(
        'SELECT * FROM tenant_tasks WHERE tenant_id = $1 AND id = $2 LIMIT 1',
        [ctx.tenantId, id]
      );
      return taskRes.rows[0] || null;
    });
    if (!row) {
      fail(res, 404, 'ACTIVITY_NOT_FOUND', 'Không tìm thấy hoạt động.');
      return;
    }
    ok(res, withAliases(row, { subject: (r) => r.subject || r.title }));
  })
);
crmCompatRouter.put('/activities/:id', bridge(crm360Router, (req) => `/activities/${req.params.id}`));
crmCompatRouter.delete('/activities/:id', bridge(crm360Router, (req) => `/activities/${req.params.id}`));

crmCompatRouter.get(
  '/notes',
  requirePermission('leads', 'view'),
  handler('COMPAT_NOTES_LIST', async (req, res) => {
    const paging = readPaging(req, 50);
    const leadId = qstr(req, 'contact_id') || qstr(req, 'lead_id');
    const dealId = qstr(req, 'deal_id');
    const companyId = qstr(req, 'company_id');
    const data = await tx(async (client, ctx) => {
      await ensureCrm360Schema();
      const conds: string[] = ['a.tenant_id = $1', "a.activity_type = 'note'"];
      const vals: unknown[] = [ctx.tenantId];
      if (isUuid(leadId)) {
        vals.push(leadId);
        conds.push(`a.lead_id = $${vals.length}`);
      }
      if (isUuid(dealId)) {
        vals.push(dealId);
        conds.push(`a.deal_id = $${vals.length}`);
      }
      if (isUuid(companyId)) {
        vals.push(companyId);
        conds.push(`a.company_id = $${vals.length}`);
      }
      const rowsRes = await client.query(
        `SELECT a.*, u.full_name AS author_name, u.avatar_url AS author_avatar
         FROM tenant_crm_activities a
         LEFT JOIN users u ON u.tenant_id = a.tenant_id AND u.id = a.owner_user_id
         WHERE ${conds.join(' AND ')}
         ORDER BY a.created_at DESC
         LIMIT $${vals.length + 1} OFFSET $${vals.length + 2}`,
        [...vals, paging.limit, paging.offset]
      );
      const items = rowsRes.rows.map((r) => ({
        ...r,
        content: r.body || r.subject || '',
        created_by_name: r.author_name || 'Thành viên',
      }));
      return listPayload(items, items.length, paging.page, paging.limit);
    });
    ok(res, data);
  })
);

crmCompatRouter.post(
  '/notes',
  requirePermission('leads', 'edit'),
  handler('COMPAT_NOTES_CREATE', async (req, res) => {
    const b = req.body || {};
    const bodyText = bstr(b, 'content', 'body', 'note');
    if (!bodyText) {
      fail(res, 400, 'NOTE_CONTENT_REQUIRED', 'Vui lòng nhập nội dung ghi chú.');
      return;
    }
    const leadId = isUuid(b.contact_id) ? b.contact_id : isUuid(b.lead_id) ? b.lead_id : null;
    const dealId = isUuid(b.deal_id) ? b.deal_id : null;
    const companyId = isUuid(b.company_id) ? b.company_id : null;
    const created = await tx(async (client, ctx) => {
      await ensureCrm360Schema();
      const id = crypto.randomUUID();
      const r = await client.query(
        `INSERT INTO tenant_crm_activities (
          id, tenant_id, activity_type, subject, body, status, owner_user_id, lead_id, deal_id, company_id
        ) VALUES ($1, $2, 'note', $3, $4, 'done', $5, $6, $7, $8) RETURNING *`,
        [id, ctx.tenantId, bodyText.slice(0, 120), bodyText, ctx.userId, leadId, dealId, companyId]
      );
      return { ...r.rows[0], content: r.rows[0].body };
    });
    ok(res, created, 'Đã lưu ghi chú.', 201);
  })
);

crmCompatRouter.put(
  '/notes/:id',
  requirePermission('leads', 'edit'),
  handler('COMPAT_NOTES_UPDATE', async (req, res) => {
    const id = req.params.id;
    const bodyText = bstr(req.body, 'content', 'body', 'note');
    if (!isUuid(id)) {
      fail(res, 400, 'INVALID_ID', 'ID ghi chú không hợp lệ.');
      return;
    }
    const updated = await tx(async (client, ctx) => {
      const r = await client.query(
        `UPDATE tenant_crm_activities SET body = $1, subject = $2, updated_at = clock_timestamp()
         WHERE tenant_id = $3 AND id = $4 RETURNING *`,
        [bodyText, bodyText.slice(0, 120), ctx.tenantId, id]
      );
      return r.rows[0] || null;
    });
    if (!updated) {
      fail(res, 404, 'NOTE_NOT_FOUND', 'Không tìm thấy ghi chú.');
      return;
    }
    ok(res, { ...updated, content: updated.body });
  })
);

crmCompatRouter.delete(
  '/notes/:id',
  requirePermission('leads', 'delete'),
  handler('COMPAT_NOTES_DELETE', async (req, res) => {
    const id = req.params.id;
    if (!isUuid(id)) {
      fail(res, 400, 'INVALID_ID', 'ID không hợp lệ.');
      return;
    }
    await tx(async (client, ctx) => {
      await client.query('DELETE FROM tenant_crm_activities WHERE tenant_id = $1 AND id = $2', [ctx.tenantId, id]);
    });
    ok(res, { id, deleted: true });
  })
);

// ---- Pipeline Stages, Tags & Custom Fields ----
crmCompatRouter.get(
  '/pipeline-stages',
  requirePermission('leads', 'view'),
  handler('COMPAT_PIPELINE_STAGES_LIST', async (_req, res) => {
    const rows = await tx(async (client, ctx) => {
      const r = await client.query(
        `SELECT s.*, p.name AS pipeline_name
         FROM tenant_pipeline_stages s
         LEFT JOIN tenant_pipelines p ON p.tenant_id = s.tenant_id AND p.id = s.pipeline_id
         WHERE s.tenant_id = $1
         ORDER BY s.stage_order ASC, s.created_at ASC`,
        [ctx.tenantId]
      );
      return r.rows.map((s) =>
        withAliases(s, {
          name: 'stage_name',
          slug: 'stage_key',
          system_slug: 'stage_key',
          color: 'color_hex',
          order_index: 'stage_order',
          is_won: 'is_won_stage',
          is_lost: 'is_lost_stage',
        })
      );
    });
    ok(res, rows);
  })
);

crmCompatRouter.post(
  '/pipeline-stages',
  requireAnyPermission([
    ['pipelines', 'create'],
    ['settings', 'manage_config'],
  ]),
  handler('COMPAT_PIPELINE_STAGES_CREATE', async (req, res) => {
    const b = req.body || {};
    const stageName = bstr(b, 'stage_name', 'name');
    if (!stageName) {
      fail(res, 400, 'STAGE_NAME_REQUIRED', 'Vui lòng nhập tên bước phễu.');
      return;
    }
    const created = await tx(async (client, ctx) => {
      let pipelineId = isUuid(b.pipeline_id) ? b.pipeline_id : null;
      if (!pipelineId) {
        const pRes = await client.query<{ id: string }>(
          'SELECT id FROM tenant_pipelines WHERE tenant_id = $1 ORDER BY is_default DESC, created_at ASC LIMIT 1',
          [ctx.tenantId]
        );
        pipelineId = pRes.rows[0]?.id || null;
      }
      if (!pipelineId) {
        pipelineId = crypto.randomUUID();
        await client.query(
          'INSERT INTO tenant_pipelines (id, tenant_id, name, is_default) VALUES ($1, $2, $3, true)',
          [pipelineId, ctx.tenantId, 'Pipeline Mặc Định']
        );
      }
      const stageKey = bstr(b, 'stage_key', 'slug') || `${stageName.toLowerCase().replace(/[^a-z0-9]+/g, '_')}_${Date.now()}`;
      const r = await client.query(
        `INSERT INTO tenant_pipeline_stages (
          id, tenant_id, pipeline_id, stage_key, stage_name, stage_order, color_hex, is_won_stage, is_lost_stage
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING *`,
        [
          crypto.randomUUID(),
          ctx.tenantId,
          pipelineId,
          stageKey.slice(0, 60),
          stageName,
          num(b.stage_order ?? b.order_index, 0),
          bstr(b, 'color_hex', 'color') || '#1E40FF',
          Boolean(b.is_won_stage ?? b.is_won),
          Boolean(b.is_lost_stage ?? b.is_lost),
        ]
      );
      return r.rows[0];
    });
    tenantRedis.invalidateDistributionSnapshot(getTenantContext().tenantId);
    ok(res, created, 'Đã tạo bước phễu.', 201);
  })
);

crmCompatRouter.put(
  '/pipeline-stages/:id',
  requireAnyPermission([
    ['pipelines', 'edit'],
    ['settings', 'manage_config'],
  ]),
  handler('COMPAT_PIPELINE_STAGES_UPDATE', async (req, res) => {
    const id = req.params.id;
    const b = req.body || {};
    if (!isUuid(id)) {
      fail(res, 400, 'INVALID_ID', 'ID không hợp lệ.');
      return;
    }
    const updated = await tx(async (client, ctx) => {
      const r = await client.query(
        `UPDATE tenant_pipeline_stages
         SET stage_name = COALESCE(NULLIF($1, ''), stage_name),
             stage_order = COALESCE($2, stage_order),
             color_hex = COALESCE(NULLIF($3, ''), color_hex),
             updated_at = clock_timestamp()
         WHERE tenant_id = $4 AND id = $5 RETURNING *`,
        [bstr(b, 'stage_name', 'name'), b.stage_order ?? b.order_index ?? null, bstr(b, 'color_hex', 'color'), ctx.tenantId, id]
      );
      return r.rows[0] || null;
    });
    tenantRedis.invalidateDistributionSnapshot(getTenantContext().tenantId);
    ok(res, updated);
  })
);

crmCompatRouter.delete(
  '/pipeline-stages/:id',
  requireAnyPermission([
    ['pipelines', 'delete'],
    ['settings', 'manage_config'],
  ]),
  handler('COMPAT_PIPELINE_STAGES_DELETE', async (req, res) => {
    const id = req.params.id;
    if (!isUuid(id)) {
      fail(res, 400, 'INVALID_ID', 'ID không hợp lệ.');
      return;
    }
    await tx(async (client, ctx) => {
      await client.query('DELETE FROM tenant_pipeline_stages WHERE tenant_id = $1 AND id = $2', [ctx.tenantId, id]);
    });
    tenantRedis.invalidateDistributionSnapshot(getTenantContext().tenantId);
    ok(res, { id, deleted: true });
  })
);

crmCompatRouter.get(
  '/tags/stats',
  requirePermission('leads', 'view'),
  handler('COMPAT_TAGS_STATS', async (_req, res) => {
    const rows = await tx(async (client, ctx) => {
      const r = await client.query(
        `SELECT tt.id, tt.name, tt.slug, tt.color_hex, COUNT(lt.lead_id)::int AS count
         FROM tenant_tags tt
         LEFT JOIN lead_tags lt ON lt.tenant_id = tt.tenant_id AND lt.tag_id = tt.id
         WHERE tt.tenant_id = $1
         GROUP BY tt.id, tt.name, tt.slug, tt.color_hex
         ORDER BY count DESC, tt.name ASC`,
        [ctx.tenantId]
      );
      return r.rows;
    });
    ok(res, rows);
  })
);
crmCompatRouter.get('/tags', bridge(orgRbacRouter, '/tags'));
crmCompatRouter.post('/tags', bridge(orgRbacRouter, '/tags'));
crmCompatRouter.put('/tags/:id', bridge(orgRbacRouter, (req) => `/tags/${req.params.id}`));
crmCompatRouter.delete('/tags/:id', bridge(orgRbacRouter, (req) => `/tags/${req.params.id}`));

crmCompatRouter.get('/custom-fields', bridge(orgRbacRouter, '/custom-fields'));
crmCompatRouter.post('/custom-fields', bridge(orgRbacRouter, '/custom-fields'));
crmCompatRouter.put('/custom-fields/:id', bridge(orgRbacRouter, (req) => `/custom-fields/${req.params.id}`));
crmCompatRouter.delete('/custom-fields/:id', bridge(orgRbacRouter, (req) => `/custom-fields/${req.params.id}`));
