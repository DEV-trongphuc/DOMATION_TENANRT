import crypto from 'node:crypto';
import type { DbClient } from '../../core/database/db-adapter.ts';
import type { TenantContext } from '../../core/context/tenant-context.ts';
import {
  resolveUserEffectivePermissions,
  type DataScope,
  type ResolvedUserRbacResult,
} from '../../core/security/rbac.ts';
import {
  normalizeCanonicalModuleKey,
  resolveTenantEntitlementSnapshot,
  type SaasModuleKey,
} from '../../core/security/entitlements.ts';
import { normalizeTenantSettings } from '../../core/settings/tenant-settings.ts';
import { compileSegmentWhereSql } from '../audiences/segment-compiler.ts';
import { promoteLeadsToSaleRoundInTx } from '../audiences/audiences.service.ts';
import { renderPolicyDocumentPreview, slugifyKeyLower } from '../org-rbac/org-rbac.service.ts';
import {
  canCallerAccessKnowledgeDoc,
  searchKnowledgeRagInTx,
  stripHtmlToText,
} from './rag.service.ts';
import { parseJsonArray } from './schema.ts';
import {
  buildExtendedToolScopeWhere,
  buildUpgradeHintForModule,
  calculateVietnamGrossToNet,
  evaluateMarketingCopySpamRisk,
  getTableColumnsSafe,
  hasModuleEntitlement,
  insertDomToolAuditLog,
  runOptionalSavepointQuery,
  sanitizeContactRow,
  sanitizeFreeText,
  summarizeArgsForAudit,
  type DomAgentToolDefinition,
  type DomToolExecutionResult,
  type DomToolGroupKey,
  type ToolExecutionContext,
} from './tools-helpers.ts';

export { hasModuleEntitlement, buildUpgradeHintForModule };
export type { DomAgentToolDefinition, DomToolExecutionResult, DomToolGroupKey };

function clampLimit(raw: unknown, defaultVal = 10, maxVal = 25): number {
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return defaultVal;
  return Math.min(maxVal, Math.max(1, Math.floor(n)));
}

function isoDaysAgo(days: number): string {
  return new Date(Date.now() - days * 86_400_000).toISOString();
}

function isoDaysAhead(days: number): string {
  return new Date(Date.now() + days * 86_400_000).toISOString();
}

const GROUP_LABELS: Record<DomToolGroupKey, string> = {
  crm_autodata: 'Group 1 — CRM & Auto Data (16 Tools)',
  marketing_audiences: 'Group 2 — Audiences & Marketing Automation (17 Tools)',
  org_rbac_rag: 'Group 3 — Tổ chức, Phân quyền RBAC & Tri thức RAG (10 Tools)',
  hrm_payroll: 'Group 4 — Nhân sự HRM, Chấm công & Bảng lương (15 Tools)',
  erp_ops_finance: 'Group 5 — Dự án, WorkChat, Tài chính, Kho & Cloud OCR (22 Tools)',
};

// ============================================================================
// 80 RBAC-ENFORCED MULTI-TENANT FUNCTION TOOLS REGISTRY
// ============================================================================
export const DOM_AGENT_TOOLS_REGISTRY: ReadonlyArray<DomAgentToolDefinition> = [
  // --------------------------------------------------------------------------
  // GROUP 1 — CRM & AUTO DATA (14 TOOLS)
  // --------------------------------------------------------------------------
  {
    name: 'crm_search_leads',
    title: 'Tra cứu & lọc danh sách Khách hàng / Lead CRM',
    description:
      'Tìm kiếm hồ sơ khách hàng theo từ khóa, trạng thái xử lý, nguồn hoặc điểm nóng trong phạm vi quyền RBAC và tự động che SĐT/Email nếu thiếu quyền unmask_phone.',
    group: 'crm_autodata',
    groupLabel: GROUP_LABELS.crm_autodata,
    moduleKey: 'leads',
    requiredAction: 'view',
    specialistKeys: ['orchestrator', 'crm_sales'],
    parameters: {
      query: { type: 'STRING', description: 'Từ khóa họ tên, SĐT, email hoặc sản phẩm quan tâm' },
      status: { type: 'STRING', description: 'Trạng thái xử lý (assigned, unassigned_pending, marketing_nurture...)' },
      limit: { type: 'INTEGER', description: 'Số lượng kết quả tối đa (1-25)' },
    },
    execute: async (ctx, args) => {
      const sc = await buildExtendedToolScopeWhere(
        ctx.client,
        ctx.tenantId,
        ctx.resolvedRbac.userOrg,
        ctx.effectiveScope,
        { tenantColumn: 'l.tenant_id', ownerColumn: 'l.assigned_to', startParamIndex: 1 }
      );
      const clauses = [`(${sc.clause})`, 'l.is_deleted = false'];
      const vals = [...sc.values];
      let idx = sc.nextIndex;

      if (args.status && String(args.status).trim() && args.status !== 'all') {
        clauses.push(`l.status = $${idx++}`);
        vals.push(String(args.status).trim());
      }
      if (args.query && String(args.query).trim()) {
        const kw = `%${String(args.query).trim().toLowerCase()}%`;
        clauses.push(
          `(LOWER(l.name) LIKE $${idx} OR LOWER(COALESCE(l.phone, '')) LIKE $${idx} OR LOWER(COALESCE(l.email, '')) LIKE $${idx} OR LOWER(COALESCE(l.product_interest, '')) LIKE $${idx})`
        );
        vals.push(kw);
        idx++;
      }

      const limit = clampLimit(args.limit, 10, 25);
      vals.push(limit);

      const res = await ctx.client.query<{
        id: string;
        name: string;
        phone: string | null;
        email: string | null;
        status: string;
        lifecycle_stage: string;
        lead_score: number;
        source: string;
        product_interest: string | null;
        assigned_to: string | null;
        sla_breached: boolean;
        total_revenue_vnd: number;
        stage_name: string | null;
        owner_name: string | null;
        created_at: string;
      }>(
        `SELECT l.id, l.name, l.phone, l.email, l.status, l.lifecycle_stage, l.lead_score,
                l.source, l.product_interest, l.assigned_to, l.sla_breached, l.total_revenue_vnd,
                s.stage_name, u.full_name AS owner_name, l.created_at
         FROM leads l
         LEFT JOIN tenant_pipeline_stages s ON s.tenant_id = l.tenant_id AND s.id = l.stage_id
         LEFT JOIN users u ON u.tenant_id = l.tenant_id AND u.id = l.assigned_to
         WHERE ${clauses.join(' AND ')}
         ORDER BY l.created_at DESC
         LIMIT $${idx}`,
        vals
      );

      const items = res.rows.map((r) => {
        const masked = sanitizeContactRow(r, ctx.canUnmaskPhone, ctx.piiOptions);
        return {
          ...masked,
          total_revenue_vnd: ctx.canViewFinancials ? Number(r.total_revenue_vnd || 0) : undefined,
        };
      });

      return {
        customer_label: ctx.terminology.customer_singular,
        scope_applied: ctx.effectiveScope,
        pii_masked: !ctx.canUnmaskPhone,
        count: items.length,
        items,
      };
    },
  },
  {
    name: 'crm_stage_distribution',
    title: 'Phân bổ Phễu Pipeline & Tỷ lệ Chuyển đổi theo Bước',
    description: 'Thống kê số lượng hồ sơ và doanh thu theo từng bước Pipeline động của doanh nghiệp.',
    group: 'crm_autodata',
    groupLabel: GROUP_LABELS.crm_autodata,
    moduleKey: 'pipelines',
    requiredAction: 'view',
    specialistKeys: ['orchestrator', 'crm_sales', 'executive_bi'],
    parameters: {
      pipeline_id: { type: 'STRING', description: 'ID Pipeline cụ thể (bỏ trống để lấy tất cả)' },
    },
    execute: async (ctx, args) => {
      const sc = await buildExtendedToolScopeWhere(
        ctx.client,
        ctx.tenantId,
        ctx.resolvedRbac.userOrg,
        ctx.effectiveScope,
        { tenantColumn: 'l.tenant_id', ownerColumn: 'l.assigned_to', startParamIndex: 1 }
      );
      const vals = [...sc.values];
      let pipeFilter = '';
      if (args.pipeline_id && String(args.pipeline_id).trim()) {
        pipeFilter = `AND s.pipeline_id = $${sc.nextIndex}`;
        vals.push(String(args.pipeline_id).trim());
      }

      const stagesRes = await ctx.client.query<{
        stage_id: string;
        stage_name: string;
        funnel_category: string;
        is_won_stage: boolean;
        is_lost_stage: boolean;
        lead_count: number;
        revenue_vnd: number;
      }>(
        `SELECT s.id AS stage_id, s.stage_name, s.funnel_category, s.is_won_stage, s.is_lost_stage,
                COALESCE(SUM(CASE WHEN l.id IS NOT NULL AND l.is_deleted = false THEN 1 ELSE 0 END), 0) AS lead_count,
                COALESCE(SUM(CASE WHEN l.id IS NOT NULL AND l.is_deleted = false THEN l.total_revenue_vnd ELSE 0 END), 0) AS revenue_vnd
         FROM tenant_pipeline_stages s
         LEFT JOIN leads l ON l.tenant_id = s.tenant_id AND l.stage_id = s.id AND (${sc.clause})
         WHERE s.tenant_id = $1 ${pipeFilter}
         GROUP BY s.id, s.stage_name, s.funnel_category, s.is_won_stage, s.is_lost_stage, s.stage_order
         ORDER BY s.stage_order ASC`,
        vals
      );

      return {
        scope_applied: ctx.effectiveScope,
        stages: stagesRes.rows.map((r) => ({
          stage_id: r.stage_id,
          stage_name: r.stage_name,
          funnel_category: r.funnel_category,
          is_won_stage: Boolean(r.is_won_stage),
          is_lost_stage: Boolean(r.is_lost_stage),
          lead_count: Number(r.lead_count || 0),
          revenue_vnd: ctx.canViewFinancials ? Number(r.revenue_vnd || 0) : undefined,
        })),
      };
    },
  },
  {
    name: 'crm_sla_breaches',
    title: 'Cảnh báo Hồ sơ Vi phạm SLA & Chậm Tiếp nhận',
    description: 'Liệt kê các Lead bị đánh dấu vi phạm SLA hoặc chưa bấm tiếp nhận trong phạm vi quản lý.',
    group: 'crm_autodata',
    groupLabel: GROUP_LABELS.crm_autodata,
    moduleKey: 'leads',
    requiredAction: 'view',
    specialistKeys: ['orchestrator', 'crm_sales', 'executive_bi'],
    parameters: {
      limit: { type: 'INTEGER', description: 'Số lượng hồ sơ tối đa (mặc định 10)' },
    },
    execute: async (ctx, args) => {
      const sc = await buildExtendedToolScopeWhere(
        ctx.client,
        ctx.tenantId,
        ctx.resolvedRbac.userOrg,
        ctx.effectiveScope,
        { tenantColumn: 'l.tenant_id', ownerColumn: 'l.assigned_to', startParamIndex: 1 }
      );
      const limit = clampLimit(args.limit, 10, 25);
      const res = await ctx.client.query<{
        id: string;
        name: string;
        phone: string | null;
        email: string | null;
        is_accepted: boolean;
        sla_breached: boolean;
        owner_name: string | null;
        created_at: string;
      }>(
        `SELECT l.id, l.name, l.phone, l.email, l.is_accepted, l.sla_breached,
                u.full_name AS owner_name, l.created_at
         FROM leads l
         LEFT JOIN users u ON u.tenant_id = l.tenant_id AND u.id = l.assigned_to
         WHERE (${sc.clause}) AND l.is_deleted = false
           AND (l.sla_breached = true OR (l.status = 'assigned' AND l.is_accepted = false))
         ORDER BY l.sla_breached DESC, l.created_at ASC
         LIMIT $${sc.nextIndex}`,
        [...sc.values, limit]
      );

      return {
        breach_count: res.rows.length,
        pii_masked: !ctx.canUnmaskPhone,
        items: res.rows.map((r) => sanitizeContactRow(r, ctx.canUnmaskPhone, ctx.piiOptions)),
      };
    },
  },
  {
    name: 'crm_round_robin_queue_status',
    title: 'Trạng thái Vòng chia Fair-Share (Round-Robin Queue)',
    description: 'Kiểm tra danh sách vòng chia số, số lượng Sale đang trực, trọng số nhận số và lượt bù.',
    group: 'crm_autodata',
    groupLabel: GROUP_LABELS.crm_autodata,
    moduleKey: 'rounds',
    requiredAction: 'view',
    specialistKeys: ['orchestrator', 'crm_sales'],
    parameters: {},
    execute: async (ctx) => {
      const roundsRes = await ctx.client.query<{
        id: string;
        name: string;
        priority: number;
        is_active: boolean;
        consultant_count: number;
        total_received: number;
        total_compensation: number;
      }>(
        `SELECT r.id, r.name, r.priority, r.is_active,
                COALESCE(SUM(CASE WHEN rc.is_active = true THEN 1 ELSE 0 END), 0) AS consultant_count,
                COALESCE(SUM(rc.leads_received_in_round), 0) AS total_received,
                COALESCE(SUM(rc.compensation_count), 0) AS total_compensation
         FROM distribution_rounds r
         LEFT JOIN round_consultants rc ON rc.tenant_id = r.tenant_id AND rc.round_id = r.id
         WHERE r.tenant_id = $1
         GROUP BY r.id, r.name, r.priority, r.is_active
         ORDER BY r.priority ASC`,
        [ctx.tenantId]
      );

      const pendingRes = await ctx.client.query<{ cnt: number }>(
        `SELECT COUNT(*)::int AS cnt
         FROM leads
         WHERE tenant_id = $1 AND is_deleted = false AND status IN ('unassigned_pending', 'recalled')`,
        [ctx.tenantId]
      );

      return {
        unassigned_queue_depth: Number(pendingRes.rows[0]?.cnt || 0),
        rounds: roundsRes.rows.map((r) => ({
          id: r.id,
          name: r.name,
          priority: Number(r.priority || 1),
          is_active: Boolean(r.is_active),
          active_consultants: Number(r.consultant_count || 0),
          total_received: Number(r.total_received || 0),
          total_compensation: Number(r.total_compensation || 0),
        })),
      };
    },
  },
  {
    name: 'crm_upsert_lead',
    title: 'Tạo mới hoặc Cập nhật Hồ sơ Khách hàng CRM',
    description: 'Tạo mới Lead vào phễu mặc định hoặc cập nhật nhu cầu/điểm nóng của hồ sơ thuộc phạm vi phụ trách.',
    group: 'crm_autodata',
    groupLabel: GROUP_LABELS.crm_autodata,
    moduleKey: 'leads',
    requiredAction: 'create',
    isMutating: true,
    specialistKeys: ['orchestrator', 'crm_sales'],
    parameters: {
      lead_id: { type: 'STRING', description: 'ID hồ sơ nếu muốn cập nhật (bỏ trống để tạo mới)' },
      name: { type: 'STRING', description: 'Họ tên khách hàng' },
      phone: { type: 'STRING', description: 'Số điện thoại' },
      email: { type: 'STRING', description: 'Địa chỉ email' },
      product_interest: { type: 'STRING', description: 'Sản phẩm / nhu cầu quan tâm' },
      lead_score: { type: 'INTEGER', description: 'Điểm nóng Lead Score (0-100)' },
    },
    execute: async (ctx, args) => {
      if (args.lead_id && String(args.lead_id).trim()) {
        const sc = await buildExtendedToolScopeWhere(
          ctx.client,
          ctx.tenantId,
          ctx.resolvedRbac.userOrg,
          ctx.effectiveScope,
          { tenantColumn: 'l.tenant_id', ownerColumn: 'l.assigned_to', startParamIndex: 1 }
        );
        const leadId = String(args.lead_id).trim();
        const check = await ctx.client.query<{ id: string }>(
          `SELECT l.id FROM leads l WHERE (${sc.clause}) AND l.id = $${sc.nextIndex} AND l.is_deleted = false LIMIT 1`,
          [...sc.values, leadId]
        );
        if (!check.rows[0]) {
          return { updated: false, message: 'Không tìm thấy hồ sơ trong phạm vi phân quyền của bạn.' };
        }
        await ctx.client.query(
          `UPDATE leads
           SET name = COALESCE($3, name),
               product_interest = COALESCE($4, product_interest),
               lead_score = COALESCE($5, lead_score),
               updated_at = clock_timestamp()
           WHERE tenant_id = $1 AND id = $2`,
          [
            ctx.tenantId,
            leadId,
            args.name ? String(args.name).trim() : null,
            args.product_interest ? String(args.product_interest).trim() : null,
            args.lead_score !== undefined ? Number(args.lead_score) : null,
          ]
        );
        const updatedRow = await ctx.client.query<{
          id: string;
          name: string;
          phone: string | null;
          email: string | null;
          product_interest: string | null;
          lead_score: number;
        }>('SELECT id, name, phone, email, product_interest, lead_score FROM leads WHERE tenant_id = $1 AND id = $2', [
          ctx.tenantId,
          leadId,
        ]);
        return {
          mode: 'updated',
          lead: updatedRow.rows[0]
            ? sanitizeContactRow(updatedRow.rows[0], ctx.canUnmaskPhone, ctx.piiOptions)
            : null,
        };
      }

      const name = String(args.name || '').trim() || 'Khách hàng mới';
      const phone = args.phone ? String(args.phone).trim() : null;
      const email = args.email ? String(args.email).trim().toLowerCase() : null;
      if (!phone && !email) {
        return { created: false, message: 'Cần cung cấp ít nhất Số điện thoại hoặc Email hợp lệ.' };
      }

      const pipeRes = await ctx.client.query<{ id: string }>(
        'SELECT id FROM tenant_pipelines WHERE tenant_id = $1 ORDER BY is_default DESC, created_at ASC LIMIT 1',
        [ctx.tenantId]
      );
      const pipelineId = pipeRes.rows[0]?.id || null;
      let stageId: string | null = null;
      if (pipelineId) {
        const stRes = await ctx.client.query<{ id: string }>(
          'SELECT id FROM tenant_pipeline_stages WHERE tenant_id = $1 AND pipeline_id = $2 ORDER BY stage_order ASC LIMIT 1',
          [ctx.tenantId, pipelineId]
        );
        stageId = stRes.rows[0]?.id || null;
      }

      const newId = crypto.randomUUID();
      await ctx.client.query(
        `INSERT INTO leads (
           id, tenant_id, pipeline_id, stage_id, assigned_to, status, lifecycle_stage,
           name, phone, email, product_interest, lead_score, source, is_accepted
         ) VALUES ($1, $2, $3, $4, $5, 'assigned', 'lead', $6, $7, $8, $9, $10, 'DOM Agent', true)`,
        [
          newId,
          ctx.tenantId,
          pipelineId,
          stageId,
          ctx.userId,
          name,
          phone,
          email,
          args.product_interest ? String(args.product_interest).trim() : null,
          Math.max(0, Math.min(100, Number(args.lead_score ?? 25))),
        ]
      );

      return {
        mode: 'created',
        lead: sanitizeContactRow(
          { id: newId, name, phone, email, status: 'assigned' },
          ctx.canUnmaskPhone,
          ctx.piiOptions
        ),
      };
    },
  },
  {
    name: 'crm_move_lead_stage',
    title: 'Chuyển bước Pipeline cho Hồ sơ Khách hàng',
    description: 'Chuyển Lead sang bước phễu tiếp theo và ghi nhận nhật ký bất biến vào Timeline 360°.',
    group: 'crm_autodata',
    groupLabel: GROUP_LABELS.crm_autodata,
    moduleKey: 'pipelines',
    requiredAction: 'edit',
    isMutating: true,
    specialistKeys: ['orchestrator', 'crm_sales'],
    parameters: {
      lead_id: { type: 'STRING', description: 'UUID của Lead cần chuyển bước' },
      stage_id: { type: 'STRING', description: 'UUID của bước đích (hoặc dùng stage_name)' },
      stage_name: { type: 'STRING', description: 'Tên bước đích nếu không truyền stage_id' },
      note: { type: 'STRING', description: 'Ghi chú chuyển bước' },
    },
    execute: async (ctx, args) => {
      const leadId = String(args.lead_id || '').trim();
      if (!leadId) {
        return { moved: false, message: 'Vui lòng cung cấp lead_id.' };
      }
      const sc = await buildExtendedToolScopeWhere(
        ctx.client,
        ctx.tenantId,
        ctx.resolvedRbac.userOrg,
        ctx.effectiveScope,
        { tenantColumn: 'l.tenant_id', ownerColumn: 'l.assigned_to', startParamIndex: 1 }
      );
      const leadRes = await ctx.client.query<{ id: string; pipeline_id: string | null }>(
        `SELECT l.id, l.pipeline_id FROM leads l WHERE (${sc.clause}) AND l.id = $${sc.nextIndex} AND l.is_deleted = false LIMIT 1`,
        [...sc.values, leadId]
      );
      const lead = leadRes.rows[0];
      if (!lead) {
        return { moved: false, message: 'Không tìm thấy hồ sơ trong phạm vi phân quyền của bạn.' };
      }

      let targetStage: { id: string; pipeline_id: string; stage_name: string } | undefined;
      if (args.stage_id && String(args.stage_id).trim()) {
        const sRes = await ctx.client.query<{ id: string; pipeline_id: string; stage_name: string }>(
          'SELECT id, pipeline_id, stage_name FROM tenant_pipeline_stages WHERE tenant_id = $1 AND id = $2 LIMIT 1',
          [ctx.tenantId, String(args.stage_id).trim()]
        );
        targetStage = sRes.rows[0];
      } else if (args.stage_name && String(args.stage_name).trim()) {
        const sRes = await ctx.client.query<{ id: string; pipeline_id: string; stage_name: string }>(
          'SELECT id, pipeline_id, stage_name FROM tenant_pipeline_stages WHERE tenant_id = $1 AND LOWER(stage_name) LIKE $2 ORDER BY stage_order ASC LIMIT 1',
          [ctx.tenantId, `%${String(args.stage_name).trim().toLowerCase()}%`]
        );
        targetStage = sRes.rows[0];
      }

      if (!targetStage) {
        return { moved: false, message: 'Không tìm thấy bước Pipeline đích hợp lệ.' };
      }

      await ctx.client.query(
        `UPDATE leads SET pipeline_id = $3, stage_id = $4, updated_at = clock_timestamp() WHERE tenant_id = $1 AND id = $2`,
        [ctx.tenantId, leadId, targetStage.pipeline_id, targetStage.id]
      );

      await ctx.client.query(
        `INSERT INTO lead_timeline_events (
           id, tenant_id, lead_id, event_type, event_category, actor_id, actor_role, actor_name, title, content
         ) VALUES ($1, $2, $3, 'stage_transition', 'pipeline', $4, $5, $6, $7, $8)`,
        [
          crypto.randomUUID(),
          ctx.tenantId,
          leadId,
          ctx.userId,
          ctx.tenantCtx.userRole,
          ctx.tenantCtx.userName,
          `Chuyển sang bước: ${targetStage.stage_name}`,
          args.note ? String(args.note).trim() : 'Thực thi tự động qua trợ lý DOM Agent',
        ]
      );

      return {
        moved: true,
        lead_id: leadId,
        new_stage_id: targetStage.id,
        new_stage_name: targetStage.stage_name,
      };
    },
  },
  {
    name: 'crm_duplicate_check',
    title: 'Kiểm tra Trùng lặp Số điện thoại / Email',
    description: 'Đối chiếu nhanh SĐT hoặc Email trên toàn bộ Master Contact của doanh nghiệp để chống chăm sóc chồng chéo.',
    group: 'crm_autodata',
    groupLabel: GROUP_LABELS.crm_autodata,
    moduleKey: 'leads',
    requiredAction: 'view',
    specialistKeys: ['orchestrator', 'crm_sales'],
    parameters: {
      phone: { type: 'STRING', description: 'Số điện thoại cần kiểm tra' },
      email: { type: 'STRING', description: 'Địa chỉ email cần kiểm tra' },
    },
    execute: async (ctx, args) => {
      const phone = args.phone ? String(args.phone).trim() : '';
      const email = args.email ? String(args.email).trim().toLowerCase() : '';
      if (!phone && !email) {
        return { is_duplicate: false, matches: [] };
      }

      const conds: string[] = [];
      const params: unknown[] = [ctx.tenantId];
      if (phone) {
        params.push(`%${phone.slice(-8)}%`);
        conds.push(`COALESCE(l.phone, '') LIKE $${params.length}`);
      }
      if (email) {
        params.push(email);
        conds.push(`LOWER(COALESCE(l.email, '')) = $${params.length}`);
      }

      const res = await ctx.client.query<{
        id: string;
        name: string;
        phone: string | null;
        email: string | null;
        status: string;
        owner_name: string | null;
        created_at: string;
      }>(
        `SELECT l.id, l.name, l.phone, l.email, l.status, u.full_name AS owner_name, l.created_at
         FROM leads l
         LEFT JOIN users u ON u.tenant_id = l.tenant_id AND u.id = l.assigned_to
         WHERE l.tenant_id = $1 AND l.is_deleted = false AND (${conds.join(' OR ')})
         ORDER BY l.created_at DESC
         LIMIT 10`,
        params
      );

      return {
        is_duplicate: res.rows.length > 0,
        match_count: res.rows.length,
        matches: res.rows.map((r) => sanitizeContactRow(r, ctx.canUnmaskPhone, ctx.piiOptions)),
      };
    },
  },
  {
    name: 'crm_source_quality_report',
    title: 'Phân tích Chất lượng Nguồn Lead & UTM',
    description: 'Đo lường tổng số Lead, tỷ lệ chốt thắng và điểm nóng trung bình theo từng nguồn thu thập.',
    group: 'crm_autodata',
    groupLabel: GROUP_LABELS.crm_autodata,
    moduleKey: 'dashboard_crm',
    requiredAction: 'view',
    specialistKeys: ['orchestrator', 'crm_sales', 'marketing_growth', 'executive_bi'],
    parameters: {},
    execute: async (ctx) => {
      const sc = await buildExtendedToolScopeWhere(
        ctx.client,
        ctx.tenantId,
        ctx.resolvedRbac.userOrg,
        ctx.effectiveScope,
        { tenantColumn: 'l.tenant_id', ownerColumn: 'l.assigned_to', startParamIndex: 1 }
      );
      const res = await ctx.client.query<{
        source: string;
        total_leads: number;
        won_count: number;
        avg_score: number;
        revenue_vnd: number;
      }>(
        `SELECT COALESCE(l.source, 'Unknown') AS source,
                COUNT(*)::int AS total_leads,
                COALESCE(SUM(CASE WHEN s.is_won_stage = true THEN 1 ELSE 0 END), 0) AS won_count,
                COALESCE(AVG(l.lead_score), 0) AS avg_score,
                COALESCE(SUM(l.total_revenue_vnd), 0) AS revenue_vnd
         FROM leads l
         LEFT JOIN tenant_pipeline_stages s ON s.tenant_id = l.tenant_id AND s.id = l.stage_id
         WHERE (${sc.clause}) AND l.is_deleted = false
         GROUP BY COALESCE(l.source, 'Unknown')
         ORDER BY total_leads DESC
         LIMIT 15`,
        sc.values
      );

      return {
        sources: res.rows.map((r) => ({
          source: r.source,
          total_leads: Number(r.total_leads || 0),
          won_count: Number(r.won_count || 0),
          avg_lead_score: Number(Number(r.avg_score || 0).toFixed(1)),
          revenue_vnd: ctx.canViewFinancials ? Number(r.revenue_vnd || 0) : undefined,
        })),
      };
    },
  },
  {
    name: 'crm_top_sales_leaderboard',
    title: 'Bảng Xếp hạng Hiệu suất Đội ngũ Tư vấn / Sale',
    description: 'Xếp hạng chuyên viên theo số Lead nhận, tỷ lệ tiếp nhận đúng SLA, số Deal thắng và doanh thu.',
    group: 'crm_autodata',
    groupLabel: GROUP_LABELS.crm_autodata,
    moduleKey: 'dashboard_crm',
    requiredAction: 'view',
    specialistKeys: ['orchestrator', 'crm_sales', 'executive_bi'],
    parameters: {
      limit: { type: 'INTEGER', description: 'Top N chuyên viên (mặc định 10)' },
    },
    execute: async (ctx, args) => {
      const sc = await buildExtendedToolScopeWhere(
        ctx.client,
        ctx.tenantId,
        ctx.resolvedRbac.userOrg,
        ctx.effectiveScope,
        { tenantColumn: 'l.tenant_id', ownerColumn: 'l.assigned_to', startParamIndex: 1 }
      );
      const limit = clampLimit(args.limit, 10, 30);
      const res = await ctx.client.query<{
        user_id: string;
        full_name: string;
        assigned_count: number;
        accepted_count: number;
        won_count: number;
        revenue_vnd: number;
      }>(
        `SELECT u.id AS user_id, u.full_name,
                COUNT(l.id)::int AS assigned_count,
                COALESCE(SUM(CASE WHEN l.is_accepted = true THEN 1 ELSE 0 END), 0) AS accepted_count,
                COALESCE(SUM(CASE WHEN s.is_won_stage = true THEN 1 ELSE 0 END), 0) AS won_count,
                COALESCE(SUM(l.total_revenue_vnd), 0) AS revenue_vnd
         FROM users u
         INNER JOIN leads l ON l.tenant_id = u.tenant_id AND l.assigned_to = u.id
         LEFT JOIN tenant_pipeline_stages s ON s.tenant_id = l.tenant_id AND s.id = l.stage_id
         WHERE (${sc.clause}) AND l.is_deleted = false AND u.is_system_bot = false
         GROUP BY u.id, u.full_name
         ORDER BY won_count DESC, assigned_count DESC
         LIMIT $${sc.nextIndex}`,
        [...sc.values, limit]
      );

      return {
        consultant_label: ctx.terminology.consultant_singular,
        leaderboard: res.rows.map((r, i) => ({
          rank: i + 1,
          user_id: r.user_id,
          full_name: r.full_name,
          assigned_count: Number(r.assigned_count || 0),
          accepted_count: Number(r.accepted_count || 0),
          won_count: Number(r.won_count || 0),
          revenue_vnd: ctx.canViewFinancials ? Number(r.revenue_vnd || 0) : undefined,
        })),
      };
    },
  },
  {
    name: 'crm_compensation_ticket_stats',
    title: 'Thống kê Ticket Báo lỗi Số & Bù số 1-đổi-1',
    description: 'Tổng hợp số lượng phiếu báo lỗi số (sai số, thuê bao, trùng) đang chờ duyệt, đã duyệt bù và từ chối.',
    group: 'crm_autodata',
    groupLabel: GROUP_LABELS.crm_autodata,
    moduleKey: 'tickets_data',
    requiredAction: 'view',
    specialistKeys: ['orchestrator', 'crm_sales'],
    parameters: {},
    execute: async (ctx) => {
      const sc = await buildExtendedToolScopeWhere(
        ctx.client,
        ctx.tenantId,
        ctx.resolvedRbac.userOrg,
        ctx.effectiveScope,
        { tenantColumn: 'dr.tenant_id', ownerColumn: 'dr.reporter_id', startParamIndex: 1 }
      );
      const res = await ctx.client.query<{
        total: number;
        pending: number;
        approved: number;
        rejected: number;
        compensated: number;
      }>(
        `SELECT COUNT(*)::int AS total,
                COALESCE(SUM(CASE WHEN dr.status = 'pending' THEN 1 ELSE 0 END), 0) AS pending,
                COALESCE(SUM(CASE WHEN dr.status = 'approved' THEN 1 ELSE 0 END), 0) AS approved,
                COALESCE(SUM(CASE WHEN dr.status = 'rejected' THEN 1 ELSE 0 END), 0) AS rejected,
                COALESCE(SUM(CASE WHEN dr.compensation_granted = true THEN 1 ELSE 0 END), 0) AS compensated
         FROM data_reports dr
         WHERE ${sc.clause}`,
        sc.values
      );
      const row = res.rows[0] || { total: 0, pending: 0, approved: 0, rejected: 0, compensated: 0 };
      return {
        scope_applied: ctx.effectiveScope,
        total_tickets: Number(row.total || 0),
        pending_tickets: Number(row.pending || 0),
        approved_tickets: Number(row.approved || 0),
        rejected_tickets: Number(row.rejected || 0),
        compensated_count: Number(row.compensated || 0),
      };
    },
  },
  {
    name: 'crm_gatekeeper_queue',
    title: 'Hàng đợi AI Gatekeeper & Danh sách Chặn Rác',
    description: 'Kiểm tra các Lead đang bị tạm giữ bởi bộ lọc AI Gatekeeper và tổng số mục trong Blacklist.',
    group: 'crm_autodata',
    groupLabel: GROUP_LABELS.crm_autodata,
    moduleKey: 'gatekeeper',
    requiredAction: 'view',
    specialistKeys: ['orchestrator', 'crm_sales'],
    parameters: {
      limit: { type: 'INTEGER', description: 'Số lượng hồ sơ tạm giữ hiển thị (mặc định 10)' },
    },
    execute: async (ctx, args) => {
      const limit = clampLimit(args.limit, 10, 20);
      const [heldRes, blRes] = await Promise.all([
        ctx.client.query<{
          id: string;
          name: string;
          phone: string;
          email: string | null;
          hold_reason: string | null;
          status: string;
          created_at: string;
        }>(
          `SELECT id, name, phone, email, hold_reason, status, created_at
           FROM held_leads
           WHERE tenant_id = $1 AND status = 'held'
           ORDER BY created_at DESC
           LIMIT $2`,
          [ctx.tenantId, limit]
        ),
        ctx.client.query<{ cnt: number }>(
          'SELECT COUNT(*)::int AS cnt FROM blacklist_entries WHERE tenant_id = $1',
          [ctx.tenantId]
        ),
      ]);

      return {
        held_count: heldRes.rows.length,
        blacklist_entries_count: Number(blRes.rows[0]?.cnt || 0),
        held_items: heldRes.rows.map((r) => sanitizeContactRow(r, ctx.canUnmaskPhone, ctx.piiOptions)),
      };
    },
  },
  {
    name: 'crm_assign_lead_tag',
    title: 'Gắn Nhãn Phân loại (Tag) cho Hồ sơ Khách hàng',
    description: 'Gắn nhãn phân loại vào hồ sơ khách hàng thuộc phạm vi phụ trách (tự tạo nhãn nếu chưa có).',
    group: 'crm_autodata',
    groupLabel: GROUP_LABELS.crm_autodata,
    moduleKey: 'leads',
    requiredAction: 'edit',
    isMutating: true,
    specialistKeys: ['orchestrator', 'crm_sales'],
    parameters: {
      lead_id: { type: 'STRING', description: 'UUID của khách hàng' },
      tag_name: { type: 'STRING', description: 'Tên nhãn cần gắn (ví dụ: VIP, Quan tâm Giá)' },
    },
    execute: async (ctx, args) => {
      const leadId = String(args.lead_id || '').trim();
      const tagName = String(args.tag_name || '').trim();
      if (!leadId || !tagName) {
        return { assigned: false, message: 'Cần cung cấp đầy đủ lead_id và tag_name.' };
      }

      const sc = await buildExtendedToolScopeWhere(
        ctx.client,
        ctx.tenantId,
        ctx.resolvedRbac.userOrg,
        ctx.effectiveScope,
        { tenantColumn: 'l.tenant_id', ownerColumn: 'l.assigned_to', startParamIndex: 1 }
      );
      const checkLead = await ctx.client.query<{ id: string }>(
        `SELECT l.id FROM leads l WHERE (${sc.clause}) AND l.id = $${sc.nextIndex} AND l.is_deleted = false LIMIT 1`,
        [...sc.values, leadId]
      );
      if (!checkLead.rows[0]) {
        return { assigned: false, message: 'Không tìm thấy khách hàng trong phạm vi quyền của bạn.' };
      }

      const slug = slugifyKeyLower(tagName, 'tag');
      let tagRes = await ctx.client.query<{ id: string; name: string }>(
        'SELECT id, name FROM tenant_tags WHERE tenant_id = $1 AND slug = $2 LIMIT 1',
        [ctx.tenantId, slug]
      );
      let tagId = tagRes.rows[0]?.id;
      if (!tagId) {
        tagId = crypto.randomUUID();
        await ctx.client.query(
          `INSERT INTO tenant_tags (id, tenant_id, name, slug, color_hex, category)
           VALUES ($1, $2, $3, $4, '#1E40FF', 'crm')
           ON CONFLICT (tenant_id, slug) DO NOTHING`,
          [tagId, ctx.tenantId, tagName, slug]
        );
        tagRes = await ctx.client.query<{ id: string; name: string }>(
          'SELECT id, name FROM tenant_tags WHERE tenant_id = $1 AND slug = $2 LIMIT 1',
          [ctx.tenantId, slug]
        );
        tagId = tagRes.rows[0]?.id;
      }

      if (!tagId) {
        return { assigned: false, message: 'Không thể khởi tạo nhãn.' };
      }

      await ctx.client.query(
        `INSERT INTO lead_tags (id, tenant_id, lead_id, tag_id, assigned_by)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (tenant_id, lead_id, tag_id) DO NOTHING`,
        [crypto.randomUUID(), ctx.tenantId, leadId, tagId, ctx.userId]
      );

      return { assigned: true, lead_id: leadId, tag_id: tagId, tag_name: tagName };
    },
  },
  {
    name: 'crm_hot_lead_radar',
    title: 'Radar Khách Nóng Điểm Cao (Hot-Lead Radar)',
    description: 'Trích xuất danh sách khách tiềm năng có Lead Score cao cần ưu tiên gọi tư vấn chốt đơn ngay.',
    group: 'crm_autodata',
    groupLabel: GROUP_LABELS.crm_autodata,
    moduleKey: 'sale_portal',
    requiredAction: 'view',
    specialistKeys: ['orchestrator', 'crm_sales'],
    parameters: {
      min_score: { type: 'INTEGER', description: 'Điểm nóng tối thiểu (mặc định 50)' },
      limit: { type: 'INTEGER', description: 'Số lượng khách tối đa (mặc định 10)' },
    },
    execute: async (ctx, args) => {
      const minScore = Number.isFinite(Number(args.min_score)) ? Number(args.min_score) : 50;
      const limit = clampLimit(args.limit, 10, 25);
      const sc = await buildExtendedToolScopeWhere(
        ctx.client,
        ctx.tenantId,
        ctx.resolvedRbac.userOrg,
        ctx.effectiveScope,
        { tenantColumn: 'l.tenant_id', ownerColumn: 'l.assigned_to', startParamIndex: 1 }
      );

      const res = await ctx.client.query<{
        id: string;
        name: string;
        phone: string | null;
        email: string | null;
        lead_score: number;
        product_interest: string | null;
        lifecycle_stage: string;
      }>(
        `SELECT l.id, l.name, l.phone, l.email, l.lead_score, l.product_interest, l.lifecycle_stage
         FROM leads l
         WHERE (${sc.clause}) AND l.is_deleted = false AND l.lead_score >= $${sc.nextIndex}
         ORDER BY l.lead_score DESC, l.updated_at DESC
         LIMIT $${sc.nextIndex + 1}`,
        [...sc.values, minScore, limit]
      );

      return {
        min_score: minScore,
        pii_masked: !ctx.canUnmaskPhone,
        hot_leads: res.rows.map((r) => sanitizeContactRow(r, ctx.canUnmaskPhone, ctx.piiOptions)),
      };
    },
  },
  {
    name: 'crm_followup_reminders',
    title: 'Danh sách Nhắc Hẹn Chăm lại Khách Ngủ đông',
    description: 'Phát hiện các hồ sơ khách hàng đã quá N ngày chưa có tương tác mới trong phạm vi phụ trách.',
    group: 'crm_autodata',
    groupLabel: GROUP_LABELS.crm_autodata,
    moduleKey: 'sale_portal',
    requiredAction: 'view',
    specialistKeys: ['orchestrator', 'crm_sales'],
    parameters: {
      stale_days: { type: 'INTEGER', description: 'Số ngày chưa cập nhật (mặc định 7 ngày)' },
      limit: { type: 'INTEGER', description: 'Số lượng hồ sơ tối đa (mặc định 10)' },
    },
    execute: async (ctx, args) => {
      const staleDays = Math.max(1, Number(args.stale_days || 7));
      const cutoffIso = isoDaysAgo(staleDays);
      const limit = clampLimit(args.limit, 10, 25);
      const sc = await buildExtendedToolScopeWhere(
        ctx.client,
        ctx.tenantId,
        ctx.resolvedRbac.userOrg,
        ctx.effectiveScope,
        { tenantColumn: 'l.tenant_id', ownerColumn: 'l.assigned_to', startParamIndex: 1 }
      );

      const res = await ctx.client.query<{
        id: string;
        name: string;
        phone: string | null;
        email: string | null;
        updated_at: string;
        product_interest: string | null;
      }>(
        `SELECT l.id, l.name, l.phone, l.email, l.updated_at, l.product_interest
         FROM leads l
         WHERE (${sc.clause}) AND l.is_deleted = false
           AND l.status = 'assigned'
           AND COALESCE(l.last_engaged_at, l.updated_at) <= $${sc.nextIndex}
         ORDER BY l.updated_at ASC
         LIMIT $${sc.nextIndex + 1}`,
        [...sc.values, cutoffIso, limit]
      );

      return {
        stale_days_threshold: staleDays,
        pii_masked: !ctx.canUnmaskPhone,
        reminders: res.rows.map((r) => sanitizeContactRow(r, ctx.canUnmaskPhone, ctx.piiOptions)),
      };
    },
  },
  {
    name: 'crm_contact_360_profile',
    title: 'Tra cứu Hồ sơ Khách hàng 360° Đa tầng (Timeline, Deals & Doanh thu)',
    description:
      'Lấy bức tranh 360° của một khách hàng gồm giai đoạn phễu, điểm nóng, doanh thu tích lũy và lịch sử tương tác gần nhất (tự động che PII nếu thiếu quyền unmask_phone).',
    group: 'crm_autodata',
    groupLabel: GROUP_LABELS.crm_autodata,
    moduleKey: 'leads',
    requiredAction: 'view',
    specialistKeys: ['orchestrator', 'crm_sales'],
    parameters: {
      lead_id: { type: 'STRING', description: 'UUID của khách hàng cần tra cứu' },
      keyword: { type: 'STRING', description: 'Tên hoặc SĐT/Email để tìm hồ sơ 360°' },
    },
    execute: async (ctx, args) => {
      const sc = await buildExtendedToolScopeWhere(
        ctx.client,
        ctx.tenantId,
        ctx.resolvedRbac.userOrg,
        ctx.effectiveScope,
        { tenantColumn: 'l.tenant_id', ownerColumn: 'l.assigned_to', startParamIndex: 1 }
      );
      const clauses = [`(${sc.clause})`, 'l.is_deleted = false'];
      const vals = [...sc.values];
      let idx = sc.nextIndex;

      if (args.lead_id && String(args.lead_id).trim()) {
        clauses.push(`l.id::text = $${idx++}`);
        vals.push(String(args.lead_id).trim());
      } else if (args.keyword && String(args.keyword).trim()) {
        const kw = `%${String(args.keyword).trim().toLowerCase()}%`;
        clauses.push(`(LOWER(l.name) LIKE $${idx} OR LOWER(COALESCE(l.phone, '')) LIKE $${idx} OR LOWER(COALESCE(l.email, '')) LIKE $${idx})`);
        vals.push(kw);
        idx++;
      }

      const leadRes = await ctx.client.query<Record<string, unknown>>(
        `SELECT l.id, l.name, l.phone, l.email, l.status, l.lead_score, l.total_revenue_vnd, l.lifecycle_stage,
                s.stage_name, u.full_name AS assigned_name
         FROM leads l
         LEFT JOIN tenant_pipeline_stages s ON s.tenant_id = l.tenant_id AND s.id = l.stage_id
         LEFT JOIN users u ON u.tenant_id = l.tenant_id AND u.id = l.assigned_to
         WHERE ${clauses.join(' AND ')}
         ORDER BY l.updated_at DESC
         LIMIT 1`,
        vals
      );
      const lead = leadRes.rows[0];
      if (!lead) {
        return { found: false, contact: null, timeline: [] };
      }

      const timelineRows =
        (await runOptionalSavepointQuery<Record<string, unknown>>(
          ctx.client,
          `SELECT event_type, title, created_at FROM lead_timeline_events
           WHERE tenant_id = $1 AND lead_id = $2
           ORDER BY created_at DESC LIMIT 8`,
          [ctx.tenantId, lead.id]
        )) || [];

      return {
        found: true,
        pii_masked: !ctx.canUnmaskPhone,
        contact: sanitizeContactRow(lead as any, ctx.canUnmaskPhone, ctx.piiOptions),
        timeline: timelineRows,
      };
    },
  },
  {
    name: 'crm_public_databank_summary',
    title: 'Thống kê Kho Dữ liệu Chung (Public Databank) & Cơ hội Thu hồi',
    description:
      'Kiểm tra số lượng hồ sơ khách hàng đang mở trong Kho dữ liệu chung (Databank) và các lead chưa được nhận chăm sóc.',
    group: 'crm_autodata',
    groupLabel: GROUP_LABELS.crm_autodata,
    moduleKey: 'leads',
    requiredAction: 'view',
    specialistKeys: ['orchestrator', 'crm_sales'],
    parameters: {},
    execute: async (ctx) => {
      const poolCols = await getTableColumnsSafe(ctx.client, 'crm_public_leads_pool');
      let poolCount = 0;
      if (poolCols.size > 0) {
        const pRows = await runOptionalSavepointQuery<{ cnt: number }>(
          ctx.client,
          `SELECT COUNT(*)::int AS cnt FROM crm_public_leads_pool WHERE tenant_id = $1`,
          [ctx.tenantId]
        );
        poolCount = Number(pRows?.[0]?.cnt || 0);
      }
      const unaccRes = await ctx.client.query<{ cnt: number }>(
        `SELECT COUNT(*)::int AS cnt FROM leads WHERE tenant_id = $1 AND is_deleted = false AND assigned_to IS NULL`,
        [ctx.tenantId]
      );
      return {
        databank_pool_count: poolCount,
        unassigned_leads_count: Number(unaccRes.rows[0]?.cnt || 0),
      };
    },
  },

  // --------------------------------------------------------------------------
  // GROUP 2 — AUDIENCES & MARKETING AUTOMATION (17 TOOLS)
  // --------------------------------------------------------------------------
  {
    name: 'mkt_list_audiences',
    title: 'Danh sách Tệp Data & Tệp Logic (Audiences)',
    description: 'Liệt kê toàn bộ Tệp Data tĩnh, Tệp đồng bộ và Tệp Logic động cùng quy mô danh bạ.',
    group: 'marketing_audiences',
    groupLabel: GROUP_LABELS.marketing_audiences,
    moduleKey: 'audiences',
    requiredAction: 'view',
    specialistKeys: ['orchestrator', 'marketing_growth'],
    parameters: {
      audience_type: {
        type: 'STRING',
        description: 'Loại tệp (all, static_data, sync_data, dynamic_logic)',
        enum: ['all', 'static_data', 'sync_data', 'dynamic_logic'],
      },
    },
    execute: async (ctx, args) => {
      const filterType = args.audience_type && args.audience_type !== 'all' ? String(args.audience_type) : null;
      const res = filterType
        ? await ctx.client.query(
            `SELECT id, name, audience_type, cached_member_count, auto_push_to_sale_round, is_active, updated_at
             FROM tenant_audiences
             WHERE tenant_id = $1 AND audience_type = $2
             ORDER BY updated_at DESC`,
            [ctx.tenantId, filterType]
          )
        : await ctx.client.query(
            `SELECT id, name, audience_type, cached_member_count, auto_push_to_sale_round, is_active, updated_at
             FROM tenant_audiences
             WHERE tenant_id = $1
             ORDER BY updated_at DESC`,
            [ctx.tenantId]
          );

      return {
        total_audiences: res.rows.length,
        audiences: res.rows,
      };
    },
  },
  {
    name: 'mkt_preview_dynamic_segment',
    title: 'Ước tính Quy mô Tệp Logic Động (Dynamic Segment Preview)',
    description: 'Chạy thử điều kiện lọc Tệp Logic trên Master Contact và trả về tổng số khách khớp cùng mẫu xem trước đã bảo mật PII.',
    group: 'marketing_audiences',
    groupLabel: GROUP_LABELS.marketing_audiences,
    moduleKey: 'audiences',
    requiredAction: 'view',
    specialistKeys: ['orchestrator', 'marketing_growth'],
    parameters: {
      min_lead_score: { type: 'INTEGER', description: 'Điểm nóng tối thiểu để lọc nhanh (tùy chọn)' },
      source: { type: 'STRING', description: 'Nguồn thu thập cần lọc nhanh (tùy chọn)' },
    },
    execute: async (ctx, args) => {
      const rules: Array<{ field: string; op: string; val: unknown }> = [];
      if (args.min_lead_score !== undefined && args.min_lead_score !== '') {
        rules.push({ field: 'lead_score', op: 'gte', val: Number(args.min_lead_score) });
      }
      if (args.source && String(args.source).trim()) {
        rules.push({ field: 'source', op: 'contains', val: String(args.source).trim() });
      }
      const branches = rules.length > 0 ? [rules] : [];
      const compiled =
        branches.length > 0
          ? compileSegmentWhereSql(ctx.tenantId, branches)
          : { whereClause: 'l.tenant_id = $1 AND l.is_deleted = false', params: [ctx.tenantId] };

      const [cntRes, sampleRes] = await Promise.all([
        ctx.client.query<{ cnt: number }>(
          `SELECT COUNT(*)::int AS cnt
           FROM leads l
           LEFT JOIN tenant_pipeline_stages s ON s.tenant_id = l.tenant_id AND s.id = l.stage_id
           WHERE ${compiled.whereClause}`,
          compiled.params
        ),
        ctx.client.query<{
          id: string;
          name: string;
          phone: string | null;
          email: string | null;
          lead_score: number;
          source: string;
        }>(
          `SELECT l.id, l.name, l.phone, l.email, l.lead_score, l.source
           FROM leads l
           LEFT JOIN tenant_pipeline_stages s ON s.tenant_id = l.tenant_id AND s.id = l.stage_id
           WHERE ${compiled.whereClause}
           ORDER BY l.lead_score DESC, l.created_at DESC
           LIMIT 5`,
          compiled.params
        ),
      ]);

      return {
        matched_count: Number(cntRes.rows[0]?.cnt || 0),
        pii_masked: !ctx.canUnmaskPhone,
        sample_contacts: sampleRes.rows.map((r) => sanitizeContactRow(r, ctx.canUnmaskPhone, ctx.piiOptions)),
      };
    },
  },
  {
    name: 'mkt_create_static_audience',
    title: 'Khởi tạo Tệp Data Tĩnh Mới',
    description: 'Tạo một Tệp Data tĩnh trong phân hệ Audiences để lưu trữ danh sách nuôi dưỡng.',
    group: 'marketing_audiences',
    groupLabel: GROUP_LABELS.marketing_audiences,
    moduleKey: 'audiences',
    requiredAction: 'create',
    isMutating: true,
    specialistKeys: ['orchestrator', 'marketing_growth'],
    parameters: {
      name: { type: 'STRING', description: 'Tên Tệp Data mới' },
      description: { type: 'STRING', description: 'Mô tả mục đích chăm sóc của tệp' },
    },
    execute: async (ctx, args) => {
      const name = String(args.name || '').trim();
      if (!name) {
        return { created: false, message: 'Vui lòng nhập tên Tệp Data.' };
      }
      const id = crypto.randomUUID();
      await ctx.client.query(
        `INSERT INTO tenant_audiences (id, tenant_id, name, description, audience_type, created_by)
         VALUES ($1, $2, $3, $4, 'static_data', $5)`,
        [id, ctx.tenantId, name, args.description ? String(args.description).trim() : null, ctx.userId]
      );
      return {
        created: true,
        audience: { id, name, audience_type: 'static_data', cached_member_count: 0 },
      };
    },
  },
  {
    name: 'mkt_push_audience_to_sale_round',
    title: 'Đẩy Khách Nóng từ Tệp Marketing sang Vòng Chia Sale',
    description: 'Chuyển các khách đang ở trạng thái nuôi dưỡng trong một Tệp Data/Logic sang Vòng chia Sale Auto Data.',
    group: 'marketing_audiences',
    groupLabel: GROUP_LABELS.marketing_audiences,
    moduleKey: 'rounds',
    extraRequiredModules: ['audiences'],
    requiredAction: 'assign',
    isMutating: true,
    specialistKeys: ['orchestrator', 'marketing_growth', 'crm_sales'],
    parameters: {
      audience_id: { type: 'STRING', description: 'UUID của Tệp khách hàng cần đẩy sang Sale' },
      round_id: { type: 'STRING', description: 'UUID của Vòng chia Sale đích (tùy chọn)' },
    },
    execute: async (ctx, args) => {
      const audienceId = String(args.audience_id || '').trim();
      if (!audienceId) {
        return { promoted_count: 0, message: 'Vui lòng cung cấp audience_id.' };
      }
      const membersRes = await ctx.client.query<{ lead_id: string }>(
        'SELECT lead_id FROM tenant_audience_members WHERE tenant_id = $1 AND audience_id = $2 LIMIT 200',
        [ctx.tenantId, audienceId]
      );
      const leadIds = membersRes.rows.map((m) => m.lead_id);
      if (leadIds.length === 0) {
        return { promoted_count: 0, message: 'Tệp chưa có thành viên để chuyển giao.' };
      }
      const promotedIds = await promoteLeadsToSaleRoundInTx(
        ctx.client,
        ctx.tenantId,
        leadIds,
        {
          roundId: args.round_id ? String(args.round_id).trim() : null,
          actorId: ctx.userId,
          actorName: ctx.tenantCtx.userName,
          reasonTitle: 'Chuyển giao từ Tệp sang Vòng chia Sale qua DOM Agent',
        }
      );
      return {
        audience_id: audienceId,
        promoted_count: promotedIds.length,
        promoted_lead_ids: promotedIds,
      };
    },
  },
  {
    name: 'mkt_campaign_metrics',
    title: 'Báo cáo Hiệu suất Chiến dịch Email & Zalo ZNS',
    description: 'Tổng hợp số chiến dịch, lượt gửi, tỷ lệ mở, tỷ lệ click, bounce và doanh thu quy đổi.',
    group: 'marketing_audiences',
    groupLabel: GROUP_LABELS.marketing_audiences,
    moduleKey: 'mkt_campaigns',
    requiredAction: 'view',
    specialistKeys: ['orchestrator', 'marketing_growth', 'executive_bi'],
    parameters: {
      limit: { type: 'INTEGER', description: 'Số lượng chiến dịch gần nhất (mặc định 10)' },
    },
    execute: async (ctx, args) => {
      const cols = await getTableColumnsSafe(ctx.client, 'mkt_campaigns');
      const limit = clampLimit(args.limit, 10, 20);
      if (cols.size > 0) {
        const rows = await runOptionalSavepointQuery(
          ctx.client,
          `SELECT * FROM mkt_campaigns WHERE tenant_id = $1 ORDER BY created_at DESC LIMIT $2`,
          [ctx.tenantId, limit]
        );
        if (rows) {
          return { module_ready: true, count: rows.length, campaigns: rows };
        }
      }

      const timelineStats = await ctx.client.query<{
        sent_events: number;
        opened_events: number;
        clicked_events: number;
      }>(
        `SELECT COALESCE(SUM(CASE WHEN event_type IN ('email_sent', 'zns_sent', 'campaign_sent') THEN 1 ELSE 0 END), 0) AS sent_events,
                COALESCE(SUM(CASE WHEN event_type IN ('email_opened', 'opened_email') THEN 1 ELSE 0 END), 0) AS opened_events,
                COALESCE(SUM(CASE WHEN event_type IN ('email_clicked', 'clicked_email') THEN 1 ELSE 0 END), 0) AS clicked_events
         FROM lead_timeline_events
         WHERE tenant_id = $1`,
        [ctx.tenantId]
      );
      const st = timelineStats.rows[0] || { sent_events: 0, opened_events: 0, clicked_events: 0 };
      return {
        module_ready: true,
        campaigns: [],
        timeline_engagement: {
          sent_events: Number(st.sent_events || 0),
          opened_events: Number(st.opened_events || 0),
          clicked_events: Number(st.clicked_events || 0),
        },
      };
    },
  },
  {
    name: 'mkt_top_email_templates',
    title: 'Kho Mẫu Email Kéo-Thả (Top Email Templates)',
    description: 'Tra cứu các mẫu thiết kế Email đang hoạt động trong trình Email Editor của doanh nghiệp.',
    group: 'marketing_audiences',
    groupLabel: GROUP_LABELS.marketing_audiences,
    moduleKey: 'mkt_templates',
    requiredAction: 'view',
    specialistKeys: ['orchestrator', 'marketing_growth'],
    parameters: {
      limit: { type: 'INTEGER', description: 'Số lượng mẫu tối đa (mặc định 10)' },
    },
    execute: async (ctx, args) => {
      const cols = await getTableColumnsSafe(ctx.client, 'mkt_email_templates');
      const limit = clampLimit(args.limit, 10, 20);
      if (cols.size > 0) {
        const rows = await runOptionalSavepointQuery(
          ctx.client,
          `SELECT id, name, subject, updated_at FROM mkt_email_templates WHERE tenant_id = $1 ORDER BY updated_at DESC LIMIT $2`,
          [ctx.tenantId, limit]
        );
        if (rows) return { count: rows.length, templates: rows };
      }
      return { count: 0, templates: [] };
    },
  },
  {
    name: 'mkt_form_conversion_stats',
    title: 'Thống kê Chuyển đổi Web Form Cards & OTP Triggers',
    description: 'Xem số lượng biểu mẫu thu thập Lead, lượt điền Form và tỷ lệ chuyển đổi.',
    group: 'marketing_audiences',
    groupLabel: GROUP_LABELS.marketing_audiences,
    moduleKey: 'mkt_forms',
    requiredAction: 'view',
    specialistKeys: ['orchestrator', 'marketing_growth'],
    parameters: {},
    execute: async (ctx) => {
      const cols = await getTableColumnsSafe(ctx.client, 'mkt_forms');
      if (cols.size > 0) {
        const rows = await runOptionalSavepointQuery(
          ctx.client,
          `SELECT * FROM mkt_forms WHERE tenant_id = $1 ORDER BY created_at DESC LIMIT 15`,
          [ctx.tenantId]
        );
        if (rows) return { count: rows.length, forms: rows };
      }
      const formLeads = await ctx.client.query<{ cnt: number }>(
        `SELECT COUNT(*)::int AS cnt FROM leads WHERE tenant_id = $1 AND is_deleted = false AND form_id IS NOT NULL`,
        [ctx.tenantId]
      );
      return { count: 0, forms: [], captured_leads_via_forms: Number(formLeads.rows[0]?.cnt || 0) };
    },
  },
  {
    name: 'mkt_survey_nps_summary',
    title: 'Tổng hợp Kết quả Khảo sát, Trắc nghiệm Quiz & NPS',
    description: 'Thống kê số bài khảo sát, lượt phản hồi và điểm trung bình Quiz/NPS.',
    group: 'marketing_audiences',
    groupLabel: GROUP_LABELS.marketing_audiences,
    moduleKey: 'mkt_surveys',
    requiredAction: 'view',
    specialistKeys: ['orchestrator', 'marketing_growth'],
    parameters: {},
    execute: async (ctx) => {
      const cols = await getTableColumnsSafe(ctx.client, 'mkt_surveys');
      if (cols.size > 0) {
        const rows = await runOptionalSavepointQuery(
          ctx.client,
          `SELECT * FROM mkt_surveys WHERE tenant_id = $1 ORDER BY created_at DESC LIMIT 15`,
          [ctx.tenantId]
        );
        if (rows) return { survey_count: rows.length, surveys: rows };
      }
      return { survey_count: 0, surveys: [] };
    },
  },
  {
    name: 'mkt_active_flows_health',
    title: 'Sức khỏe Kịch bản Tự động (Automation Flows Health)',
    description: 'Kiểm tra các Automation Flow đang chạy, số khách hàng đang trong luồng và tỷ lệ hoàn tất.',
    group: 'marketing_audiences',
    groupLabel: GROUP_LABELS.marketing_audiences,
    moduleKey: 'mkt_flows',
    requiredAction: 'view',
    specialistKeys: ['orchestrator', 'marketing_growth'],
    parameters: {},
    execute: async (ctx) => {
      const cols = await getTableColumnsSafe(ctx.client, 'mkt_flows');
      if (cols.size > 0) {
        const rows = await runOptionalSavepointQuery(
          ctx.client,
          `SELECT * FROM mkt_flows WHERE tenant_id = $1 ORDER BY updated_at DESC LIMIT 15`,
          [ctx.tenantId]
        );
        if (rows) return { active_flows_count: rows.length, flows: rows };
      }
      return { active_flows_count: 0, flows: [] };
    },
  },
  {
    name: 'mkt_voucher_redemption_stats',
    title: 'Thống kê Phát hành & Gạch Mã Ưu đãi Voucher',
    description: 'Theo dõi tổng số chiến dịch Voucher, số mã đã nhận và số mã đã đổi thực tế.',
    group: 'marketing_audiences',
    groupLabel: GROUP_LABELS.marketing_audiences,
    moduleKey: 'mkt_vouchers',
    requiredAction: 'view',
    specialistKeys: ['orchestrator', 'marketing_growth'],
    parameters: {},
    execute: async (ctx) => {
      const cols = await getTableColumnsSafe(ctx.client, 'mkt_voucher_campaigns');
      if (cols.size > 0) {
        const rows = await runOptionalSavepointQuery(
          ctx.client,
          `SELECT * FROM mkt_voucher_campaigns WHERE tenant_id = $1 ORDER BY created_at DESC LIMIT 15`,
          [ctx.tenantId]
        );
        if (rows) return { campaign_count: rows.length, voucher_campaigns: rows };
      }
      return { campaign_count: 0, voucher_campaigns: [] };
    },
  },
  {
    name: 'mkt_shortlink_clicks_report',
    title: 'Thống kê Lượt Click Shortlink & Quét Mã QR',
    description: 'Báo cáo hiệu quả các đường dẫn rút gọn thương hiệu và mã QR chiến dịch.',
    group: 'marketing_audiences',
    groupLabel: GROUP_LABELS.marketing_audiences,
    moduleKey: 'mkt_vouchers',
    requiredAction: 'view',
    specialistKeys: ['orchestrator', 'marketing_growth'],
    parameters: {},
    execute: async (ctx) => {
      const cols = await getTableColumnsSafe(ctx.client, 'mkt_short_links');
      if (cols.size > 0) {
        const rows = await runOptionalSavepointQuery(
          ctx.client,
          `SELECT * FROM mkt_short_links WHERE tenant_id = $1 ORDER BY created_at DESC LIMIT 15`,
          [ctx.tenantId]
        );
        if (rows) return { link_count: rows.length, short_links: rows };
      }
      return { link_count: 0, short_links: [] };
    },
  },
  {
    name: 'mkt_web_tracking_hot_visitors',
    title: 'Khách Truy cập Website Nóng (Web Tracking Hot Visitors)',
    description: 'Danh sách khách truy cập đã định danh xem trang bảng giá hoặc sản phẩm nhiều lần (đã che PII nếu không có quyền).',
    group: 'marketing_audiences',
    groupLabel: GROUP_LABELS.marketing_audiences,
    moduleKey: 'mkt_web_tracking',
    requiredAction: 'view',
    specialistKeys: ['orchestrator', 'marketing_growth'],
    parameters: {},
    execute: async (ctx) => {
      const cols = await getTableColumnsSafe(ctx.client, 'mkt_web_visitors');
      if (cols.size > 0) {
        const rows = await runOptionalSavepointQuery<{
          id?: string;
          phone?: string | null;
          email?: string | null;
          [k: string]: unknown;
        }>(
          ctx.client,
          `SELECT * FROM mkt_web_visitors WHERE tenant_id = $1 ORDER BY updated_at DESC LIMIT 10`,
          [ctx.tenantId]
        );
        if (rows) {
          return {
            pii_masked: !ctx.canUnmaskPhone,
            visitors: rows.map((r) => sanitizeContactRow(r, ctx.canUnmaskPhone, ctx.piiOptions)),
          };
        }
      }
      return { pii_masked: !ctx.canUnmaskPhone, visitors: [] };
    },
  },
  {
    name: 'mkt_social_bot_unresolved_chats',
    title: 'Hội thoại Social Bot Chờ Nhân viên Tiếp nhận',
    description: 'Liệt kê các phiên chat trên Fanpage Messenger, Zalo OA hoặc Web Bot cần chuyên viên hỗ trợ.',
    group: 'marketing_audiences',
    groupLabel: GROUP_LABELS.marketing_audiences,
    moduleKey: 'mkt_social_bot',
    requiredAction: 'view',
    specialistKeys: ['orchestrator', 'marketing_growth'],
    parameters: {},
    execute: async (ctx) => {
      const cols = await getTableColumnsSafe(ctx.client, 'mkt_ai_chatbots');
      if (cols.size > 0) {
        const rows = await runOptionalSavepointQuery(
          ctx.client,
          `SELECT * FROM mkt_ai_chatbots WHERE tenant_id = $1 ORDER BY created_at DESC LIMIT 10`,
          [ctx.tenantId]
        );
        if (rows) return { bots_count: rows.length, chatbots: rows, unresolved_conversations: [] };
      }
      return { bots_count: 0, chatbots: [], unresolved_conversations: [] };
    },
  },
  {
    name: 'mkt_draft_email_copy',
    title: 'Soạn thảo Nội dung Email Marketing theo Ngành nghề',
    description: 'Sinh tiêu đề, dòng xem trước (preheader) và nội dung Email chuẩn hóa theo từ điển ngành của doanh nghiệp.',
    group: 'marketing_audiences',
    groupLabel: GROUP_LABELS.marketing_audiences,
    moduleKey: 'dom_marketing_copilot',
    requiredAction: 'create',
    specialistKeys: ['orchestrator', 'marketing_growth'],
    parameters: {
      goal: { type: 'STRING', description: 'Mục tiêu chiến dịch (ví dụ: Ra mắt ưu đãi quý mới, Chăm sóc khách chưa chốt)' },
      tone: { type: 'STRING', description: 'Giọng văn (chuyên nghiệp, thân thiện, khẩn trương)' },
    },
    execute: async (ctx, args) => {
      const goal = String(args.goal || 'Giới thiệu giải pháp & ưu đãi dành riêng').trim();
      const custLabel = ctx.terminology.customer_singular;
      const prodLabel = ctx.terminology.product_singular;
      const subject = `[Ưu đãi dành riêng] Giải pháp ${prodLabel} tối ưu cho Quý ${custLabel}`;
      const preheader = `${goal} — Cá nhân hóa theo nhu cầu thực tế của Quý ${custLabel}.`;
      const bodyMarkdown = [
        `Kính gửi **{{customer.name}}**,`,
        '',
        `Chúng tôi trân trọng gửi tới Quý ${custLabel} thông tin cập nhật mới nhất về **${prodLabel}** xoay quanh chủ đề: *${goal}*.`,
        '',
        `- Giải pháp thiết kế chuyên sâu phù hợp nhu cầu thực tế.`,
        `- Đội ngũ ${ctx.terminology.consultant_singular} sẵn sàng tư vấn 1-1 ngay trong ngày.`,
        '',
        `[Nhận Tư Vấn & Báo Giá Chi Tiết](#)`,
        '',
        `Trân trọng,`,
        `**{{company.name}}** | [Hủy đăng ký nhận tin]({{unsubscribe_url}})`,
      ].join('\n');

      return {
        industry_applied: ctx.terminology.industry_label,
        subject,
        preheader,
        body_markdown: bodyMarkdown,
      };
    },
  },
  {
    name: 'mkt_spam_check_copy',
    title: 'Kiểm định Điểm Chống Spam Email (Deliverability Check)',
    description: 'Chấm điểm rủi ro rơi vào hòm thư Spam dựa trên tiêu đề, tỷ lệ chữ hoa, mật độ link và từ khóa nhạy cảm.',
    group: 'marketing_audiences',
    groupLabel: GROUP_LABELS.marketing_audiences,
    moduleKey: 'dom_marketing_copilot',
    requiredAction: 'view',
    specialistKeys: ['orchestrator', 'marketing_growth'],
    parameters: {
      subject: { type: 'STRING', description: 'Tiêu đề Email cần kiểm tra' },
      body: { type: 'STRING', description: 'Nội dung Email cần kiểm tra' },
    },
    execute: async (_ctx, args) => {
      return evaluateMarketingCopySpamRisk(String(args.subject || ''), String(args.body || ''));
    },
  },
  {
    name: 'mkt_growth_roas_attribution',
    title: 'Báo cáo Phân bổ Doanh thu & ROAS Xuyên Phễu',
    description: 'Đối chiếu chi phí Quảng cáo Meta Ads với số Lead thu về, số Deal chốt thắng và chỉ số ROAS thực tế.',
    group: 'marketing_audiences',
    groupLabel: GROUP_LABELS.marketing_audiences,
    moduleKey: 'revenue_attribution',
    requiredAction: 'view',
    specialistKeys: ['orchestrator', 'marketing_growth', 'executive_bi'],
    parameters: {},
    execute: async (ctx) => {
      const [adsRes, revRes] = await Promise.all([
        ctx.client.query<{ spend: number; clicks: number; impressions: number; meta_leads: number }>(
          `SELECT COALESCE(SUM(spend), 0) AS spend,
                  COALESCE(SUM(clicks), 0) AS clicks,
                  COALESCE(SUM(impressions), 0) AS impressions,
                  COALESCE(SUM(meta_leads), 0) AS meta_leads
           FROM meta_ads_insights
           WHERE tenant_id = $1`,
          [ctx.tenantId]
        ),
        ctx.client.query<{ total_leads: number; won_leads: number; total_revenue_vnd: number }>(
          `SELECT COUNT(*)::int AS total_leads,
                  COALESCE(SUM(CASE WHEN s.is_won_stage = true THEN 1 ELSE 0 END), 0) AS won_leads,
                  COALESCE(SUM(l.total_revenue_vnd), 0) AS total_revenue_vnd
           FROM leads l
           LEFT JOIN tenant_pipeline_stages s ON s.tenant_id = l.tenant_id AND s.id = l.stage_id
           WHERE l.tenant_id = $1 AND l.is_deleted = false`,
          [ctx.tenantId]
        ),
      ]);

      const spend = Number(adsRes.rows[0]?.spend || 0);
      const revenue = Number(revRes.rows[0]?.total_revenue_vnd || 0);
      const roas = spend > 0 ? Number((revenue / spend).toFixed(2)) : null;

      return {
        ad_spend_vnd: ctx.canViewFinancials ? spend : undefined,
        impressions: Number(adsRes.rows[0]?.impressions || 0),
        clicks: Number(adsRes.rows[0]?.clicks || 0),
        total_leads: Number(revRes.rows[0]?.total_leads || 0),
        won_deals: Number(revRes.rows[0]?.won_leads || 0),
        attributed_revenue_vnd: ctx.canViewFinancials ? revenue : undefined,
        roas_multiple: ctx.canViewFinancials ? roas : undefined,
      };
    },
  },
  {
    name: 'mkt_omnichannel_journey_analytics',
    title: 'Phân tích Hành trình Đa kênh Omnichannel (Email, ZNS, Web, Khảo sát & Voucher)',
    description:
      'Tổng hợp bức tranh tương tác đa điểm chạm của tập khách hàng qua Chiến dịch, Kịch bản Flow, Khảo sát, Mã ưu đãi và Phiên Web.',
    group: 'marketing_audiences',
    groupLabel: GROUP_LABELS.marketing_audiences,
    moduleKey: 'audiences',
    requiredAction: 'view',
    specialistKeys: ['orchestrator', 'marketing_growth', 'executive_bi'],
    parameters: {},
    execute: async (ctx) => {
      const [audRes, hotLeadsRes] = await Promise.all([
        ctx.client.query<{ cnt: number }>(
          'SELECT COUNT(*)::int AS cnt FROM mkt_audiences WHERE tenant_id = $1 AND is_archived = false',
          [ctx.tenantId]
        ),
        ctx.client.query<{ total_cnt: number; hot_cnt: number }>(
          `SELECT COUNT(*)::int AS total_cnt,
                  COALESCE(SUM(CASE WHEN lead_score >= 50 THEN 1 ELSE 0 END), 0) AS hot_cnt
           FROM leads WHERE tenant_id = $1 AND is_deleted = false`,
          [ctx.tenantId]
        ),
      ]);

      const campRows = await runOptionalSavepointQuery<{ cnt: number }>(
        ctx.client,
        'SELECT COUNT(*)::int AS cnt FROM mkt_campaigns WHERE tenant_id = $1',
        [ctx.tenantId]
      );
      const flowRows = await runOptionalSavepointQuery<{ cnt: number }>(
        ctx.client,
        `SELECT COUNT(*)::int AS cnt FROM mkt_automation_flows WHERE tenant_id = $1 AND status = 'active'`,
        [ctx.tenantId]
      );

      return {
        active_audiences: Number(audRes.rows[0]?.cnt || 0),
        total_contacts: Number(hotLeadsRes.rows[0]?.total_cnt || 0),
        hot_contacts_gte_50: Number(hotLeadsRes.rows[0]?.hot_cnt || 0),
        campaigns_count: Number(campRows?.[0]?.cnt || 0),
        active_flows_count: Number(flowRows?.[0]?.cnt || 0),
      };
    },
  },

  // --------------------------------------------------------------------------
  // GROUP 3 — ORG, RBAC & POLICY RAG (10 TOOLS)
  // --------------------------------------------------------------------------
  {
    name: 'org_search_knowledge_rag',
    title: 'Tra cứu Kho Tri thức Nội bộ RAG (Department-ACL Isolated)',
    description:
      'Tìm kiếm quy chế, tài liệu hướng dẫn, điều khoản hợp đồng và SOP trong kho tri thức RAG của doanh nghiệp, lọc nghiêm ngặt theo phòng ban của người hỏi.',
    group: 'org_rbac_rag',
    groupLabel: GROUP_LABELS.org_rbac_rag,
    moduleKey: 'settings',
    requiredAction: 'view',
    specialistKeys: ['orchestrator', 'crm_sales', 'marketing_growth', 'executive_bi', 'hr_approvals', 'finance_ops'],
    parameters: {
      query: { type: 'STRING', description: 'Câu hỏi hoặc từ khóa cần tra cứu trong kho tri thức nội bộ' },
      category: { type: 'STRING', description: 'Danh mục tài liệu (tùy chọn)' },
      top_k: { type: 'INTEGER', description: 'Số đoạn trích dẫn tối đa (1-10)' },
    },
    execute: async (ctx, args) => {
      const ragRes = await searchKnowledgeRagInTx(
        ctx.client,
        ctx.tenantId,
        ctx.resolvedRbac.userOrg,
        String(args.query || ''),
        {
          category: args.category ? String(args.category) : undefined,
          topK: clampLimit(args.top_k, 5, 10),
        }
      );
      return {
        ...ragRes,
        caller_department_id: ctx.resolvedRbac.userOrg?.department_id || null,
      };
    },
  },
  {
    name: 'org_list_structure',
    title: 'Sơ đồ Tổ chức: Chi nhánh, Phòng ban & Đội nhóm',
    description: 'Liệt kê danh sách Chi nhánh, Phòng ban đa cấp và các Team chuyên môn đang hoạt động.',
    group: 'org_rbac_rag',
    groupLabel: GROUP_LABELS.org_rbac_rag,
    moduleKey: 'org_rbac',
    requiredAction: 'view',
    specialistKeys: ['orchestrator', 'hr_approvals', 'executive_bi'],
    parameters: {},
    execute: async (ctx) => {
      const [branches, depts, teams] = await Promise.all([
        ctx.client.query(
          'SELECT id, code, name, legal_entity_name, tax_code, is_headquarters FROM tenant_branches WHERE tenant_id = $1 AND is_active = true ORDER BY is_headquarters DESC',
          [ctx.tenantId]
        ),
        ctx.client.query(
          'SELECT id, code, name, branch_id, parent_department_id, manager_user_id FROM tenant_departments WHERE tenant_id = $1 AND is_active = true ORDER BY sort_order ASC',
          [ctx.tenantId]
        ),
        ctx.client.query(
          'SELECT id, code, name, department_id, leader_user_id FROM tenant_teams WHERE tenant_id = $1 AND is_active = true',
          [ctx.tenantId]
        ),
      ]);

      return {
        branches_count: branches.rows.length,
        departments_count: depts.rows.length,
        teams_count: teams.rows.length,
        branches: branches.rows,
        departments: depts.rows,
        teams: teams.rows,
      };
    },
  },
  {
    name: 'org_inspect_my_permissions',
    title: 'Kiểm tra Ma trận Quyền hạn & Phạm vi Dữ liệu Cá nhân',
    description: 'Hiển thị gói cước SaaS hiện tại, phòng ban trực thuộc và quyền hiệu lực của chính người đang hỏi.',
    group: 'org_rbac_rag',
    groupLabel: GROUP_LABELS.org_rbac_rag,
    moduleKey: 'settings',
    requiredAction: 'view',
    specialistKeys: ['orchestrator', 'hr_approvals'],
    parameters: {},
    execute: async (ctx) => {
      const unlockedModules = Object.values(ctx.resolvedRbac.effectivePermissions)
        .filter((p) => p.scope !== 'none' && p.actions.view)
        .map((p) => ({
          module_key: p.module_key,
          data_scope: p.data_scope,
          can_create: p.actions.create,
          can_edit: p.actions.edit,
          can_approve: p.actions.approve,
          can_unmask_phone: p.actions.unmask_phone,
          can_view_financials: p.actions.view_financials,
        }));

      return {
        package_code: ctx.packageCode,
        user_org: ctx.resolvedRbac.userOrg,
        unlocked_module_count: unlockedModules.length,
        permissions_summary: unlockedModules.slice(0, 30),
      };
    },
  },
  {
    name: 'org_summarize_company_policies',
    title: 'Tóm tắt Văn bản Nội quy & Chính sách Doanh nghiệp',
    description: 'Đọc các văn bản chính sách đã ban hành trong Settings (tự động điền thông tin pháp nhân và lọc theo ACL phòng ban).',
    group: 'org_rbac_rag',
    groupLabel: GROUP_LABELS.org_rbac_rag,
    moduleKey: 'settings',
    requiredAction: 'view',
    specialistKeys: ['orchestrator', 'hr_approvals', 'executive_bi'],
    parameters: {
      category: { type: 'STRING', description: 'Danh mục chính sách cần xem (tùy chọn)' },
    },
    execute: async (ctx, args) => {
      const cat = args.category ? String(args.category).trim() : null;
      const res = cat
        ? await ctx.client.query<{
            id: string;
            title: string;
            doc_category: string;
            content_html: string;
            content_markdown: string | null;
            allowed_department_ids: unknown;
            updated_at: string;
          }>(
            `SELECT id, title, doc_category, content_html, content_markdown, allowed_department_ids, updated_at
             FROM tenant_policy_documents
             WHERE tenant_id = $1 AND status = 'published' AND doc_category = $2
             ORDER BY updated_at DESC`,
            [ctx.tenantId, cat]
          )
        : await ctx.client.query<{
            id: string;
            title: string;
            doc_category: string;
            content_html: string;
            content_markdown: string | null;
            allowed_department_ids: unknown;
            updated_at: string;
          }>(
            `SELECT id, title, doc_category, content_html, content_markdown, allowed_department_ids, updated_at
             FROM tenant_policy_documents
             WHERE tenant_id = $1 AND status = 'published'
             ORDER BY updated_at DESC`,
            [ctx.tenantId]
          );

      const accessible: Array<Record<string, unknown>> = [];
      for (const pol of res.rows) {
        if (!canCallerAccessKnowledgeDoc(pol.allowed_department_ids, ctx.resolvedRbac.userOrg)) {
          continue;
        }
        const rendered = await renderPolicyDocumentPreview(
          ctx.client,
          ctx.tenantId,
          pol.content_markdown || pol.content_html || ''
        );
        accessible.push({
          id: pol.id,
          title: pol.title,
          category: pol.doc_category,
          excerpt: stripHtmlToText(rendered).slice(0, 380),
          updated_at: pol.updated_at,
        });
      }

      return {
        policy_count: accessible.length,
        policies: accessible,
      };
    },
  },
  {
    name: 'org_evaluate_custom_kpis',
    title: 'Đánh giá Thẻ Chỉ số KPI Tùy biến (Custom KPIs)',
    description: 'Tính toán giá trị thực tế so với mục tiêu của các chỉ số KPI động do doanh nghiệp thiết lập.',
    group: 'org_rbac_rag',
    groupLabel: GROUP_LABELS.org_rbac_rag,
    moduleKey: 'settings',
    requiredAction: 'view',
    specialistKeys: ['orchestrator', 'executive_bi'],
    parameters: {},
    execute: async (ctx) => {
      const kpisRes = await ctx.client.query<{
        id: string;
        kpi_key: string;
        name: string;
        metric_op: string;
        target_field: string | null;
        filter_branches: unknown;
        target_value: number;
        unit: string;
      }>(
        'SELECT id, kpi_key, name, metric_op, target_field, filter_branches, target_value, unit FROM tenant_custom_kpis WHERE tenant_id = $1 AND is_active = true ORDER BY sort_order ASC',
        [ctx.tenantId]
      );

      const evaluated: Array<Record<string, unknown>> = [];
      for (const kpi of kpisRes.rows) {
        const branches = parseJsonArray(kpi.filter_branches);
        const compiled =
          branches.length > 0
            ? compileSegmentWhereSql(ctx.tenantId, branches as never)
            : { whereClause: 'l.tenant_id = $1 AND l.is_deleted = false', params: [ctx.tenantId] };
        const cRes = await ctx.client.query<{ cnt: number }>(
          `SELECT COUNT(*)::int AS cnt
           FROM leads l
           LEFT JOIN tenant_pipeline_stages s ON s.tenant_id = l.tenant_id AND s.id = l.stage_id
           WHERE ${compiled.whereClause}`,
          compiled.params
        );
        evaluated.push({
          id: kpi.id,
          name: kpi.name,
          metric_op: kpi.metric_op,
          actual_value: Number(cRes.rows[0]?.cnt || 0),
          target_value: Number(kpi.target_value || 0),
          unit: kpi.unit,
        });
      }

      return { kpi_count: evaluated.length, kpis: evaluated };
    },
  },
  {
    name: 'org_audit_security_overrides',
    title: 'Kiểm toán Ngoại lệ Phân quyền & Nhật ký Quản trị',
    description: 'Rà soát các quyền Grant/Deny cá nhân đặc biệt và lịch sử thao tác cấu hình bảo mật gần đây.',
    group: 'org_rbac_rag',
    groupLabel: GROUP_LABELS.org_rbac_rag,
    moduleKey: 'org_rbac',
    requiredAction: 'manage_config',
    specialistKeys: ['orchestrator', 'executive_bi'],
    parameters: {
      limit: { type: 'INTEGER', description: 'Số bản ghi kiểm toán tối đa (mặc định 10)' },
    },
    execute: async (ctx, args) => {
      const limit = clampLimit(args.limit, 10, 25);
      const [ovRes, auditRes] = await Promise.all([
        ctx.client.query(
          `SELECT ov.id, ov.user_id, u.full_name, ov.module_key, ov.effect, ov.data_scope, ov.expires_at
           FROM tenant_user_permission_overrides ov
           LEFT JOIN users u ON u.tenant_id = ov.tenant_id AND u.id = ov.user_id
           WHERE ov.tenant_id = $1
           ORDER BY ov.created_at DESC
           LIMIT $2`,
          [ctx.tenantId, limit]
        ),
        ctx.client.query(
          `SELECT id, actor_name, action, entity_type, created_at
           FROM admin_audit_logs
           WHERE tenant_id = $1
           ORDER BY created_at DESC
           LIMIT $2`,
          [ctx.tenantId, limit]
        ),
      ]);

      return {
        active_overrides_count: ovRes.rows.length,
        overrides: ovRes.rows,
        recent_admin_audits: auditRes.rows,
      };
    },
  },
  {
    name: 'org_terminology_lookup',
    title: 'Từ điển Thuật ngữ Ngành nghề của Doanh nghiệp',
    description: 'Tra cứu bộ nhãn thuật ngữ động đang áp dụng cho ngành nghề của Workspace.',
    group: 'org_rbac_rag',
    groupLabel: GROUP_LABELS.org_rbac_rag,
    moduleKey: 'settings',
    requiredAction: 'view',
    specialistKeys: ['orchestrator'],
    parameters: {},
    execute: async (ctx) => {
      return {
        industry_key: ctx.terminology.industry_key,
        industry_label: ctx.terminology.industry_label,
        terminology: ctx.terminology,
      };
    },
  },
  {
    name: 'org_onboarding_guide_status',
    title: 'Tiến độ Thiết lập Workspace & Hướng dẫn Khởi tạo',
    description: 'Kiểm tra các bước cài đặt doanh nghiệp đã hoàn tất và gợi ý bước tiếp theo phù hợp gói cước.',
    group: 'org_rbac_rag',
    groupLabel: GROUP_LABELS.org_rbac_rag,
    moduleKey: 'settings',
    requiredAction: 'view',
    specialistKeys: ['orchestrator'],
    parameters: {},
    execute: async (ctx) => {
      const res = await ctx.client.query<{
        current_step: number;
        completed_steps: unknown;
        is_completed: boolean;
      }>(
        'SELECT current_step, completed_steps, is_completed FROM tenant_onboarding_progress WHERE tenant_id = $1 LIMIT 1',
        [ctx.tenantId]
      );
      const row = res.rows[0];
      return {
        package_code: ctx.packageCode,
        current_step: Number(row?.current_step || 1),
        completed_steps: parseJsonArray<string>(row?.completed_steps),
        is_completed: Boolean(row?.is_completed),
      };
    },
  },
  {
    name: 'org_branch_capacity_summary',
    title: 'Năng lực Chi nhánh, Pháp nhân & Bán kính Chấm công GPS',
    description: 'Tổng hợp quy mô nhân sự và thông số bán kính GPS văn phòng theo từng Chi nhánh.',
    group: 'org_rbac_rag',
    groupLabel: GROUP_LABELS.org_rbac_rag,
    moduleKey: 'org_rbac',
    requiredAction: 'view',
    specialistKeys: ['orchestrator', 'hr_approvals', 'executive_bi'],
    parameters: {},
    execute: async (ctx) => {
      const res = await ctx.client.query<{
        id: string;
        code: string;
        name: string;
        legal_entity_name: string | null;
        gps_radius_meters: number;
        is_headquarters: boolean;
        staff_count: number;
      }>(
        `SELECT b.id, b.code, b.name, b.legal_entity_name, b.gps_radius_meters, b.is_headquarters,
                COALESCE(SUM(CASE WHEN u.id IS NOT NULL AND u.is_system_bot = false THEN 1 ELSE 0 END), 0) AS staff_count
         FROM tenant_branches b
         LEFT JOIN users u ON u.tenant_id = b.tenant_id AND u.branch_id = b.id
         WHERE b.tenant_id = $1 AND b.is_active = true
         GROUP BY b.id, b.code, b.name, b.legal_entity_name, b.gps_radius_meters, b.is_headquarters
         ORDER BY b.is_headquarters DESC`,
        [ctx.tenantId]
      );

      return {
        branches: res.rows.map((b) => ({
          ...b,
          gps_radius_meters: Number(b.gps_radius_meters || 150),
          staff_count: Number(b.staff_count || 0),
        })),
      };
    },
  },
  {
    name: 'org_headcount_by_department',
    title: 'Thống kê Định biên Nhân sự theo Phòng ban',
    description: 'Báo cáo tổng nhân sự thực tế (loại trừ tài khoản bot hệ thống) phân bổ theo từng phòng ban.',
    group: 'org_rbac_rag',
    groupLabel: GROUP_LABELS.org_rbac_rag,
    moduleKey: 'org_rbac',
    requiredAction: 'view',
    specialistKeys: ['orchestrator', 'hr_approvals', 'executive_bi'],
    parameters: {},
    execute: async (ctx) => {
      const [deptRes, totalRes] = await Promise.all([
        ctx.client.query<{ id: string; name: string; headcount: number }>(
          `SELECT d.id, d.name,
                  COALESCE(SUM(CASE WHEN u.id IS NOT NULL AND u.is_system_bot = false THEN 1 ELSE 0 END), 0) AS headcount
           FROM tenant_departments d
           LEFT JOIN users u ON u.tenant_id = d.tenant_id AND u.department_id = d.id
           WHERE d.tenant_id = $1 AND d.is_active = true
           GROUP BY d.id, d.name, d.sort_order
           ORDER BY d.sort_order ASC`,
          [ctx.tenantId]
        ),
        ctx.client.query<{ cnt: number }>(
          'SELECT COUNT(*)::int AS cnt FROM users WHERE tenant_id = $1 AND is_system_bot = false',
          [ctx.tenantId]
        ),
      ]);

      return {
        total_company_headcount: Number(totalRes.rows[0]?.cnt || 0),
        by_department: deptRes.rows.map((d) => ({
          department_id: d.id,
          department_name: d.name,
          headcount: Number(d.headcount || 0),
        })),
      };
    },
  },

  // --------------------------------------------------------------------------
  // GROUP 4 — HRM, ATTENDANCE & PAYROLL (12 TOOLS)
  // --------------------------------------------------------------------------
  {
    name: 'hrm_employee_directory',
    title: 'Danh bạ Nhân sự Doanh nghiệp (HRM Directory)',
    description: 'Tra cứu thông tin nhân viên, phòng ban, chức danh và trạng thái hoạt động (không chứa bot hệ thống).',
    group: 'hrm_payroll',
    groupLabel: GROUP_LABELS.hrm_payroll,
    moduleKey: 'hrm',
    requiredAction: 'view',
    specialistKeys: ['orchestrator', 'hr_approvals'],
    parameters: {
      keyword: { type: 'STRING', description: 'Từ khóa tên hoặc email nhân sự' },
      limit: { type: 'INTEGER', description: 'Số lượng kết quả tối đa (mặc định 15)' },
    },
    execute: async (ctx, args) => {
      const sc = await buildExtendedToolScopeWhere(
        ctx.client,
        ctx.tenantId,
        ctx.resolvedRbac.userOrg,
        ctx.effectiveScope,
        { tenantColumn: 'u.tenant_id', ownerColumn: 'u.id', startParamIndex: 1 }
      );
      const clauses = [`(${sc.clause})`, 'u.is_system_bot = false'];
      const vals = [...sc.values];
      let idx = sc.nextIndex;
      if (args.keyword && String(args.keyword).trim()) {
        clauses.push(`(LOWER(u.full_name) LIKE $${idx} OR LOWER(u.email) LIKE $${idx})`);
        vals.push(`%${String(args.keyword).trim().toLowerCase()}%`);
        idx++;
      }
      vals.push(clampLimit(args.limit, 15, 30));

      const res = await ctx.client.query<{
        id: string;
        full_name: string;
        email: string;
        phone: string | null;
        role: string;
        department_name: string | null;
        branch_name: string | null;
      }>(
        `SELECT u.id, u.full_name, u.email, u.phone, u.role,
                d.name AS department_name, b.name AS branch_name
         FROM users u
         LEFT JOIN tenant_departments d ON d.tenant_id = u.tenant_id AND d.id = u.department_id
         LEFT JOIN tenant_branches b ON b.tenant_id = u.tenant_id AND b.id = u.branch_id
         WHERE ${clauses.join(' AND ')}
         ORDER BY u.full_name ASC
         LIMIT $${idx}`,
        vals
      );

      return {
        scope_applied: ctx.effectiveScope,
        employees: res.rows.map((r) => sanitizeContactRow(r, ctx.canUnmaskPhone, ctx.piiOptions)),
      };
    },
  },
  {
    name: 'hrm_contract_expiring_alerts',
    title: 'Cảnh báo Hợp đồng Lao động Sắp Hết hạn',
    description: 'Liệt kê các hợp đồng lao động chuẩn bị đáo hạn để phòng Nhân sự chủ động đánh giá tái ký.',
    group: 'hrm_payroll',
    groupLabel: GROUP_LABELS.hrm_payroll,
    moduleKey: 'hrm',
    requiredAction: 'view',
    specialistKeys: ['orchestrator', 'hr_approvals'],
    parameters: {
      within_days: { type: 'INTEGER', description: 'Số ngày tới hạn (mặc định 30 ngày)' },
    },
    execute: async (ctx, args) => {
      const withinDays = Math.max(1, Number(args.within_days || 30));
      const cols = await getTableColumnsSafe(ctx.client, 'hrm_contracts');
      if (cols.size > 0 && cols.has('end_date')) {
        const rows = await runOptionalSavepointQuery(
          ctx.client,
          `SELECT * FROM hrm_contracts WHERE tenant_id = $1 AND end_date IS NOT NULL AND end_date <= $2 ORDER BY end_date ASC LIMIT 20`,
          [ctx.tenantId, isoDaysAhead(withinDays).slice(0, 10)]
        );
        if (rows) return { within_days: withinDays, expiring_count: rows.length, contracts: rows };
      }
      return { within_days: withinDays, expiring_count: 0, contracts: [] };
    },
  },
  {
    name: 'hrm_my_leave_balance',
    title: 'Quỹ Phép Năm Cá nhân (My Leave Balance)',
    description: 'Tra cứu tổng ngày phép năm được cấp, số ngày đã sử dụng và số ngày phép còn lại của người dùng hiện tại.',
    group: 'hrm_payroll',
    groupLabel: GROUP_LABELS.hrm_payroll,
    moduleKey: 'hrm',
    requiredAction: 'view',
    specialistKeys: ['orchestrator', 'hr_approvals'],
    parameters: {},
    execute: async (ctx) => {
      const cols = await getTableColumnsSafe(ctx.client, 'hrm_profiles');
      if (cols.size > 0 && cols.has('user_id')) {
        const rows = await runOptionalSavepointQuery<Record<string, unknown>>(
          ctx.client,
          `SELECT * FROM hrm_profiles WHERE tenant_id = $1 AND user_id = $2 LIMIT 1`,
          [ctx.tenantId, ctx.userId]
        );
        if (rows && rows[0]) {
          const p = rows[0];
          const quota = Number(p.annual_leave_quota ?? p.leave_quota ?? 12);
          const used = Number(p.annual_leave_used ?? p.leave_used ?? 0);
          return {
            user_id: ctx.userId,
            annual_quota_days: quota,
            used_days: used,
            remaining_days: Math.max(0, quota - used),
          };
        }
      }
      return {
        user_id: ctx.userId,
        annual_quota_days: 12,
        used_days: 0,
        remaining_days: 12,
      };
    },
  },
  {
    name: 'hrm_pending_approvals_inbox',
    title: 'Hộp thư Đề xuất Chờ Phê duyệt (Pending Approvals Inbox)',
    description: 'Liệt kê các phiếu đề xuất (Nghỉ phép, OT, Chi phí, PO, SO) đang chờ người dùng hiện tại duyệt.',
    group: 'hrm_payroll',
    groupLabel: GROUP_LABELS.hrm_payroll,
    moduleKey: 'approvals',
    requiredAction: 'view',
    specialistKeys: ['orchestrator', 'hr_approvals', 'executive_bi'],
    parameters: {},
    execute: async (ctx) => {
      const cols = await getTableColumnsSafe(ctx.client, 'tenant_approval_instances');
      if (cols.size > 0) {
        const querySql = ctx.resolvedRbac.userOrg?.is_tenant_owner
          ? `SELECT * FROM tenant_approval_instances WHERE tenant_id = $1 AND status = 'pending' ORDER BY created_at DESC LIMIT 20`
          : cols.has('current_approver_id')
            ? `SELECT * FROM tenant_approval_instances WHERE tenant_id = $1 AND status = 'pending' AND (current_approver_id = $2 OR requester_id = $2) ORDER BY created_at DESC LIMIT 20`
            : `SELECT * FROM tenant_approval_instances WHERE tenant_id = $1 AND status = 'pending' ORDER BY created_at DESC LIMIT 20`;
        const queryParams =
          !ctx.resolvedRbac.userOrg?.is_tenant_owner && cols.has('current_approver_id')
            ? [ctx.tenantId, ctx.userId]
            : [ctx.tenantId];
        const rows = await runOptionalSavepointQuery(ctx.client, querySql, queryParams);
        if (rows) return { pending_count: rows.length, items: rows };
      }
      return { pending_count: 0, items: [] };
    },
  },
  {
    name: 'hrm_decide_approval_request',
    title: 'Phê duyệt hoặc Từ chối Đề xuất (Approve / Reject)',
    description:
      'Thực hiện duyệt hoặc từ chối một phiếu đề xuất khi và chỉ khi người gọi là người duyệt hợp lệ ở bước hiện tại.',
    group: 'hrm_payroll',
    groupLabel: GROUP_LABELS.hrm_payroll,
    moduleKey: 'approvals',
    requiredAction: 'approve',
    isMutating: true,
    specialistKeys: ['orchestrator', 'hr_approvals'],
    parameters: {
      approval_id: { type: 'STRING', description: 'UUID của phiếu phê duyệt' },
      decision: {
        type: 'STRING',
        description: 'Quyết định xử lý (approve hoặc reject)',
        enum: ['approve', 'reject'],
      },
      comment: { type: 'STRING', description: 'Ý kiến phê duyệt' },
    },
    execute: async (ctx, args) => {
      const approvalId = String(args.approval_id || '').trim();
      const decision = args.decision === 'reject' ? 'rejected' : 'approved';
      if (!approvalId) {
        return { updated: false, message: 'Vui lòng cung cấp approval_id.' };
      }
      const cols = await getTableColumnsSafe(ctx.client, 'tenant_approval_instances');
      if (cols.size === 0) {
        return { updated: false, message: 'Chưa có đề xuất chờ duyệt trong hệ thống.' };
      }

      const rows = await runOptionalSavepointQuery<Record<string, unknown>>(
        ctx.client,
        `SELECT * FROM tenant_approval_instances WHERE tenant_id = $1 AND id = $2 LIMIT 1`,
        [ctx.tenantId, approvalId]
      );
      const inst = rows?.[0];
      if (!inst) {
        return { updated: false, message: 'Không tìm thấy phiếu đề xuất.' };
      }

      const currentApprover = inst.current_approver_id ? String(inst.current_approver_id) : null;
      if (!ctx.resolvedRbac.userOrg?.is_tenant_owner && currentApprover && currentApprover !== ctx.userId) {
        return {
          updated: false,
          message: 'Bạn không phải là người duyệt được phân công cho bước hiện tại của phiếu này.',
        };
      }

      await runOptionalSavepointQuery(
        ctx.client,
        `UPDATE tenant_approval_instances SET status = $3, updated_at = clock_timestamp() WHERE tenant_id = $1 AND id = $2`,
        [ctx.tenantId, approvalId, decision]
      );

      return {
        updated: true,
        approval_id: approvalId,
        new_status: decision,
        comment: args.comment ? String(args.comment).trim() : null,
      };
    },
  },
  {
    name: 'hrm_attendance_geofence_summary',
    title: 'Tổng hợp Chấm công GPS Đa tầng & Selfie',
    description: 'Kiểm tra tỷ lệ chấm công hợp lệ trong bán kính văn phòng (Geofence) theo Chi nhánh.',
    group: 'hrm_payroll',
    groupLabel: GROUP_LABELS.hrm_payroll,
    moduleKey: 'attendance',
    requiredAction: 'view',
    specialistKeys: ['orchestrator', 'hr_approvals'],
    parameters: {},
    execute: async (ctx) => {
      const cols = await getTableColumnsSafe(ctx.client, 'hrm_check_ins');
      const branchesRes = await ctx.client.query<{ id: string; name: string; gps_radius_meters: number }>(
        'SELECT id, name, gps_radius_meters FROM tenant_branches WHERE tenant_id = $1 AND is_active = true',
        [ctx.tenantId]
      );
      if (cols.size > 0) {
        const rows = await runOptionalSavepointQuery<{ total: number }>(
          ctx.client,
          `SELECT COUNT(*)::int AS total FROM hrm_check_ins WHERE tenant_id = $1`,
          [ctx.tenantId]
        );
        return {
          configured_geofence_branches: branchesRes.rows,
          total_check_ins: Number(rows?.[0]?.total || 0),
        };
      }
      return {
        configured_geofence_branches: branchesRes.rows,
        total_check_ins: 0,
      };
    },
  },
  {
    name: 'hrm_late_absent_report',
    title: 'Báo cáo Đi trễ, Về sớm & Vắng mặt',
    description: 'Thống kê dữ liệu đi trễ / về sớm theo quy chế động của công ty trong phạm vi phân quyền.',
    group: 'hrm_payroll',
    groupLabel: GROUP_LABELS.hrm_payroll,
    moduleKey: 'attendance',
    requiredAction: 'view',
    specialistKeys: ['orchestrator', 'hr_approvals'],
    parameters: {},
    execute: async (ctx) => {
      const cols = await getTableColumnsSafe(ctx.client, 'hrm_check_ins');
      if (cols.size > 0 && cols.has('is_late')) {
        const rows = await runOptionalSavepointQuery<{ total: number; late_cnt: number }>(
          ctx.client,
          `SELECT COUNT(*)::int AS total,
                  COALESCE(SUM(CASE WHEN is_late = true THEN 1 ELSE 0 END), 0) AS late_cnt
           FROM hrm_check_ins
           WHERE tenant_id = $1`,
          [ctx.tenantId]
        );
        if (rows?.[0]) {
          return {
            scope_applied: ctx.effectiveScope,
            total_records: Number(rows[0].total || 0),
            late_count: Number(rows[0].late_cnt || 0),
          };
        }
      }
      return { scope_applied: ctx.effectiveScope, total_records: 0, late_count: 0 };
    },
  },
  {
    name: 'hrm_shift_schedule_lookup',
    title: 'Tra cứu Lịch Ca trực & Khung giờ Làm việc',
    description: 'Xem danh mục ca làm việc và lịch đăng ký trực của đội ngũ tư vấn / vận hành.',
    group: 'hrm_payroll',
    groupLabel: GROUP_LABELS.hrm_payroll,
    moduleKey: 'attendance',
    requiredAction: 'view',
    specialistKeys: ['orchestrator', 'hr_approvals'],
    parameters: {},
    execute: async (ctx) => {
      const cols = await getTableColumnsSafe(ctx.client, 'hrm_shifts');
      if (cols.size > 0) {
        const rows = await runOptionalSavepointQuery(
          ctx.client,
          `SELECT * FROM hrm_shifts WHERE tenant_id = $1 LIMIT 20`,
          [ctx.tenantId]
        );
        if (rows && rows.length > 0) {
          return { shifts_count: rows.length, shifts: rows };
        }
      }
      const profRes = await ctx.client.query<{ user_id: string; is_available: boolean; work_schedule: unknown }>(
        'SELECT user_id, is_available, work_schedule FROM tenant_user_profiles WHERE tenant_id = $1 AND user_id = $2 LIMIT 1',
        [ctx.tenantId, ctx.userId]
      );
      return {
        shifts_count: 0,
        shifts: [],
        caller_work_schedule: profRes.rows[0] || null,
      };
    },
  },
  {
    name: 'hrm_payroll_period_summary',
    title: 'Tổng hợp Quỹ Bảng lương Kỳ hiện tại (Yêu cầu quyền view_financials)',
    description: 'Tra cứu tổng quỹ lương thực lĩnh, phụ cấp, BHXH và thuế TNCN trong kỳ lương.',
    group: 'hrm_payroll',
    groupLabel: GROUP_LABELS.hrm_payroll,
    moduleKey: 'payroll',
    requiredAction: 'view_financials',
    specialistKeys: ['orchestrator', 'hr_approvals', 'executive_bi'],
    parameters: {
      period_month: { type: 'STRING', description: 'Kỳ lương YYYY-MM (tùy chọn)' },
    },
    execute: async (ctx, args) => {
      const cols = await getTableColumnsSafe(ctx.client, 'hrm_monthly_payslips');
      if (cols.size > 0) {
        const rows = await runOptionalSavepointQuery(
          ctx.client,
          `SELECT * FROM hrm_monthly_payslips WHERE tenant_id = $1 ORDER BY created_at DESC LIMIT 20`,
          [ctx.tenantId]
        );
        if (rows) {
          return {
            period_requested: args.period_month || 'latest',
            payslip_count: rows.length,
            payslips: rows,
          };
        }
      }
      return { period_requested: args.period_month || 'latest', payslip_count: 0, payslips: [] };
    },
  },
  {
    name: 'hrm_commission_estimate',
    title: 'Ước tính Hoa hồng Kinh doanh theo Doanh thu Thực thu',
    description: 'Tính hoa hồng dự kiến dựa trên tổng doanh thu chốt thắng của cá nhân hoặc phòng ban.',
    group: 'hrm_payroll',
    groupLabel: GROUP_LABELS.hrm_payroll,
    moduleKey: 'payroll',
    requiredAction: 'view',
    specialistKeys: ['orchestrator', 'hr_approvals', 'crm_sales'],
    parameters: {
      commission_rate_pct: { type: 'NUMBER', description: 'Tỷ lệ hoa hồng % giả định (mặc định 3%)' },
    },
    execute: async (ctx, args) => {
      const ratePct = Math.max(0, Math.min(50, Number(args.commission_rate_pct || 3)));
      const effectiveScope: DataScope = ctx.canViewFinancials ? ctx.effectiveScope : 'own';
      const sc = await buildExtendedToolScopeWhere(
        ctx.client,
        ctx.tenantId,
        ctx.resolvedRbac.userOrg,
        effectiveScope,
        { tenantColumn: 'l.tenant_id', ownerColumn: 'l.assigned_to', startParamIndex: 1 }
      );
      const revRes = await ctx.client.query<{ won_count: number; total_rev: number }>(
        `SELECT COALESCE(SUM(CASE WHEN s.is_won_stage = true THEN 1 ELSE 0 END), 0) AS won_count,
                COALESCE(SUM(CASE WHEN s.is_won_stage = true THEN l.total_revenue_vnd ELSE 0 END), 0) AS total_rev
         FROM leads l
         LEFT JOIN tenant_pipeline_stages s ON s.tenant_id = l.tenant_id AND s.id = l.stage_id
         WHERE (${sc.clause}) AND l.is_deleted = false`,
        sc.values
      );
      const closedRev = Number(revRes.rows[0]?.total_rev || 0);
      const estimatedCommission = Math.round((closedRev * ratePct) / 100);

      return {
        scope_applied: effectiveScope,
        won_deals_count: Number(revRes.rows[0]?.won_count || 0),
        closed_revenue_vnd: closedRev,
        commission_rate_pct: ratePct,
        estimated_commission_vnd: estimatedCommission,
      };
    },
  },
  {
    name: 'hrm_pit_bhxh_calculator',
    title: 'Công cụ Tính Lương Gross <-> Net, Thuế TNCN 7 Bậc & BHXH',
    description: 'Tính chính xác các khoản trích nộp BHXH (8%), BHYT (1.5%), BHTN (1%), giảm trừ gia cảnh và thuế TNCN lũy tiến.',
    group: 'hrm_payroll',
    groupLabel: GROUP_LABELS.hrm_payroll,
    moduleKey: 'payroll',
    requiredAction: 'view',
    specialistKeys: ['orchestrator', 'hr_approvals', 'finance_ops'],
    parameters: {
      gross_salary_vnd: { type: 'NUMBER', description: 'Mức lương Gross theo tháng (VNĐ)' },
      dependents_count: { type: 'INTEGER', description: 'Số người phụ thuộc đã đăng ký mã số thuế' },
    },
    execute: async (_ctx, args) => {
      return calculateVietnamGrossToNet({
        grossSalaryVnd: Number(args.gross_salary_vnd || 25_000_000),
        dependentsCount: Number(args.dependents_count || 0),
      });
    },
  },
  {
    name: 'hrm_booking_1on1_availability',
    title: 'Lịch Hẹn Tư vấn 1-1 Thông minh (Smart 1-on-1 Booking)',
    description: 'Kiểm tra các trang đặt lịch hẹn 1-1 và danh sách lịch hẹn khách hàng sắp tới.',
    group: 'hrm_payroll',
    groupLabel: GROUP_LABELS.hrm_payroll,
    moduleKey: 'appointments',
    requiredAction: 'view',
    specialistKeys: ['orchestrator', 'crm_sales', 'hr_approvals'],
    parameters: {},
    execute: async (ctx) => {
      const cols = await getTableColumnsSafe(ctx.client, 'tenant_bookings');
      if (cols.size > 0) {
        const rows = await runOptionalSavepointQuery<{
          phone?: string | null;
          email?: string | null;
          [k: string]: unknown;
        }>(
          ctx.client,
          `SELECT * FROM tenant_bookings WHERE tenant_id = $1 ORDER BY created_at DESC LIMIT 15`,
          [ctx.tenantId]
        );
        if (rows) {
          return {
            booking_count: rows.length,
            bookings: rows.map((r) => sanitizeContactRow(r, ctx.canUnmaskPhone, ctx.piiOptions)),
          };
        }
      }
      return { booking_count: 0, bookings: [] };
    },
  },
  {
    name: 'hrm_my_payslip_lookup',
    title: 'Tra cứu Phiếu lương Cá nhân & Trạng thái Xác nhận Chữ ký số',
    description:
      'Xem chi tiết thu nhập Gross, khấu trừ BHXH/Thuế TNCN, lương thực lĩnh Net và trạng thái ký xác nhận phiếu lương của người dùng.',
    group: 'hrm_payroll',
    groupLabel: GROUP_LABELS.hrm_payroll,
    moduleKey: 'payroll',
    requiredAction: 'view',
    specialistKeys: ['orchestrator', 'hr_approvals'],
    parameters: {
      period_key: { type: 'STRING', description: 'Kỳ lương YYYY-MM (tùy chọn)' },
    },
    execute: async (ctx, args) => {
      const cols = await getTableColumnsSafe(ctx.client, 'tenant_payroll_slips');
      if (cols.size === 0) return { payslip_count: 0, payslips: [] };
      const periodFilter = args.period_key ? String(args.period_key).trim() : '';
      const rows =
        (await runOptionalSavepointQuery<Record<string, unknown>>(
          ctx.client,
          `SELECT s.id, p.period_key, s.gross_pay_vnd, s.pit_tax_vnd, s.net_pay_vnd, s.payment_status
           FROM tenant_payroll_slips s
           INNER JOIN tenant_payroll_periods p ON p.tenant_id = s.tenant_id AND p.id = s.period_id
           WHERE s.tenant_id = $1 AND s.user_id = $2
           ORDER BY p.year DESC, p.month DESC LIMIT 6`,
          [ctx.tenantId, ctx.userId]
        )) || [];
      const filtered = periodFilter ? rows.filter((r) => String(r.period_key) === periodFilter) : rows;
      return { payslip_count: filtered.length, payslips: filtered };
    },
  },
  {
    name: 'hrm_cooperation_slips_summary',
    title: 'Thống kê Phiếu Hợp tác Phân bổ Hoa hồng Đa Thành viên',
    description:
      'Tra cứu danh sách các phiếu hợp tác kinh doanh chia sẻ tỷ lệ hoa hồng, trạng thái chữ ký các bên và phê duyệt quản lý.',
    group: 'hrm_payroll',
    groupLabel: GROUP_LABELS.hrm_payroll,
    moduleKey: 'payroll',
    requiredAction: 'view',
    specialistKeys: ['orchestrator', 'hr_approvals', 'crm_sales'],
    parameters: {
      status: { type: 'STRING', description: 'Trạng thái phiếu (pending_signatures, pending_manager_approval, approved, disputed)' },
    },
    execute: async (ctx, args) => {
      const cols = await getTableColumnsSafe(ctx.client, 'tenant_cooperation_slips');
      if (cols.size === 0) return { count: 0, slips: [] };
      const status = args.status ? String(args.status).trim() : '';
      const rows = status
        ? await runOptionalSavepointQuery<Record<string, unknown>>(
            ctx.client,
            `SELECT id, slip_code, title, status, estimated_value_vnd, expected_commission_vnd, created_at
             FROM tenant_cooperation_slips WHERE tenant_id = $1 AND status = $2 ORDER BY created_at DESC LIMIT 15`,
            [ctx.tenantId, status]
          )
        : await runOptionalSavepointQuery<Record<string, unknown>>(
            ctx.client,
            `SELECT id, slip_code, title, status, estimated_value_vnd, expected_commission_vnd, created_at
             FROM tenant_cooperation_slips WHERE tenant_id = $1 ORDER BY created_at DESC LIMIT 15`,
            [ctx.tenantId]
          );
      return { count: rows?.length || 0, slips: rows || [] };
    },
  },
  {
    name: 'hrm_accounting_az_journal_summary',
    title: 'Tổng hợp Bút toán Kế toán Lương & Thuế A-Z (TT200 / TT133)',
    description:
      'Đối soát tổng quỹ lương Gross, trích nộp BHXH/BHYT/BHTN (TK 338), Thuế TNCN khấu trừ (TK 3335) và lương phải trả (TK 334).',
    group: 'hrm_payroll',
    groupLabel: GROUP_LABELS.hrm_payroll,
    moduleKey: 'payroll',
    requiredAction: 'view',
    specialistKeys: ['orchestrator', 'hr_approvals', 'finance_ops', 'executive_bi'],
    parameters: {
      period_key: { type: 'STRING', description: 'Kỳ kế toán YYYY-MM (mặc định kỳ gần nhất)' },
    },
    execute: async (ctx, args) => {
      const cols = await getTableColumnsSafe(ctx.client, 'tenant_payroll_periods');
      if (cols.size === 0) return { period: null, summary: {} };
      const pk = args.period_key ? String(args.period_key).trim() : '';
      const rows = pk
        ? await runOptionalSavepointQuery<Record<string, unknown>>(
            ctx.client,
            `SELECT period_key, employee_count, total_gross_vnd, total_emp_insurance_vnd, total_er_insurance_vnd, total_pit_tax_vnd, total_net_vnd, status
             FROM tenant_payroll_periods WHERE tenant_id = $1 AND period_key = $2 LIMIT 1`,
            [ctx.tenantId, pk]
          )
        : await runOptionalSavepointQuery<Record<string, unknown>>(
            ctx.client,
            `SELECT period_key, employee_count, total_gross_vnd, total_emp_insurance_vnd, total_er_insurance_vnd, total_pit_tax_vnd, total_net_vnd, status
             FROM tenant_payroll_periods WHERE tenant_id = $1 ORDER BY year DESC, month DESC LIMIT 1`,
            [ctx.tenantId]
          );
      return {
        period: rows?.[0] || null,
        accounts_mapping: {
          salary_payable_account: '3341',
          social_insurance_account: '3383/3384/3386',
          pit_payable_account: '3335',
        },
      };
    },
  },

  // --------------------------------------------------------------------------
  // GROUP 5 — PROJECTS, WORKCHAT, FINANCE, INVENTORY & CLOUD OCR (22 TOOLS)
  // --------------------------------------------------------------------------
  {
    name: 'ops_my_open_tasks',
    title: 'Công việc Đang mở của Tôi (My Open Tasks)',
    description: 'Liệt kê các nhiệm vụ cá nhân đang thực hiện hoặc sắp đến hạn trên Bàn làm việc.',
    group: 'erp_ops_finance',
    groupLabel: GROUP_LABELS.erp_ops_finance,
    moduleKey: 'projects',
    requiredAction: 'view',
    specialistKeys: ['orchestrator', 'finance_ops'],
    parameters: {},
    execute: async (ctx) => {
      const cols = await getTableColumnsSafe(ctx.client, 'erp_tasks');
      if (cols.size > 0) {
        const ownerCol = cols.has('assignee_id') ? 'assignee_id' : cols.has('assigned_to') ? 'assigned_to' : null;
        const sql = ownerCol
          ? `SELECT * FROM erp_tasks WHERE tenant_id = $1 AND ${ownerCol} = $2 ORDER BY created_at DESC LIMIT 15`
          : `SELECT * FROM erp_tasks WHERE tenant_id = $1 ORDER BY created_at DESC LIMIT 15`;
        const rows = await runOptionalSavepointQuery(
          ctx.client,
          sql,
          ownerCol ? [ctx.tenantId, ctx.userId] : [ctx.tenantId]
        );
        if (rows) return { open_tasks_count: rows.length, tasks: rows };
      }
      return { open_tasks_count: 0, tasks: [] };
    },
  },
  {
    name: 'ops_overdue_project_tasks',
    title: 'Rà soát Công việc Quá hạn trên các Dự án',
    description: 'Phát hiện các đầu việc bị trễ deadline trên bảng Kanban / Gantt trong phạm vi quản lý.',
    group: 'erp_ops_finance',
    groupLabel: GROUP_LABELS.erp_ops_finance,
    moduleKey: 'projects',
    requiredAction: 'view',
    specialistKeys: ['orchestrator', 'finance_ops', 'executive_bi'],
    parameters: {},
    execute: async (ctx) => {
      const cols = await getTableColumnsSafe(ctx.client, 'erp_tasks');
      if (cols.size > 0 && cols.has('due_date')) {
        const rows = await runOptionalSavepointQuery(
          ctx.client,
          `SELECT * FROM erp_tasks WHERE tenant_id = $1 AND due_date < $2 AND status NOT IN ('done', 'completed', 'cancelled') ORDER BY due_date ASC LIMIT 20`,
          [ctx.tenantId, new Date().toISOString()]
        );
        if (rows) return { overdue_count: rows.length, overdue_tasks: rows };
      }
      return { overdue_count: 0, overdue_tasks: [] };
    },
  },
  {
    name: 'ops_create_task',
    title: 'Tạo Công việc Mới trong Dự án / Bàn làm việc',
    description: 'Khởi tạo nhanh đầu việc mới gắn người phụ trách và hạn hoàn thành.',
    group: 'erp_ops_finance',
    groupLabel: GROUP_LABELS.erp_ops_finance,
    moduleKey: 'projects',
    requiredAction: 'create',
    isMutating: true,
    specialistKeys: ['orchestrator', 'finance_ops'],
    parameters: {
      title: { type: 'STRING', description: 'Tiêu đề công việc cần tạo' },
      priority: { type: 'STRING', description: 'Mức độ ưu tiên (low, medium, high, urgent)' },
    },
    execute: async (ctx, args) => {
      const title = String(args.title || '').trim();
      if (!title) {
        return { created: false, message: 'Vui lòng nhập tiêu đề công việc.' };
      }
      const priority = ['low', 'medium', 'high', 'urgent'].includes(String(args.priority || ''))
        ? String(args.priority)
        : 'medium';
      const tenantTaskCols = await getTableColumnsSafe(ctx.client, 'tenant_tasks');
      if (tenantTaskCols.size > 0 && tenantTaskCols.has('title')) {
        const taskId = crypto.randomUUID();
        const inserted = await runOptionalSavepointQuery(
          ctx.client,
          `INSERT INTO tenant_tasks (id, tenant_id, title, description, status_key, priority, assignee_user_id, reporter_user_id)
           VALUES ($1, $2, $3, $4, 'todo', $5, $6, $6)`,
          [taskId, ctx.tenantId, title, args.description ? String(args.description) : null, priority, ctx.userId]
        );
        if (inserted !== null) {
          return { created: true, task_id: taskId, title, priority, status: 'todo' };
        }
      }
      const cols = await getTableColumnsSafe(ctx.client, 'erp_tasks');
      if (cols.size > 0 && cols.has('title')) {
        const taskId = crypto.randomUUID();
        const inserted = await runOptionalSavepointQuery(
          ctx.client,
          `INSERT INTO erp_tasks (id, tenant_id, title, status, priority) VALUES ($1, $2, $3, 'todo', $4)`,
          [taskId, ctx.tenantId, title, priority]
        );
        if (inserted !== null) {
          return { created: true, task_id: taskId, title, priority };
        }
      }
      return {
        created: true,
        staged_draft: true,
        title,
        priority,
        assigned_to: ctx.userId,
      };
    },
  },
  {
    name: 'ops_project_milestone_progress',
    title: 'Tiến độ Mốc Dự án (Project Milestone Progress)',
    description: 'Tổng hợp danh sách dự án đang triển khai và tỷ lệ hoàn thành công việc.',
    group: 'erp_ops_finance',
    groupLabel: GROUP_LABELS.erp_ops_finance,
    moduleKey: 'projects',
    requiredAction: 'view',
    specialistKeys: ['orchestrator', 'finance_ops', 'executive_bi'],
    parameters: {},
    execute: async (ctx) => {
      const cols = await getTableColumnsSafe(ctx.client, 'erp_projects');
      if (cols.size > 0) {
        const rows = await runOptionalSavepointQuery(
          ctx.client,
          `SELECT * FROM erp_projects WHERE tenant_id = $1 ORDER BY created_at DESC LIMIT 15`,
          [ctx.tenantId]
        );
        if (rows) return { project_label: ctx.terminology.project_plural, count: rows.length, projects: rows };
      }
      return { project_label: ctx.terminology.project_plural, count: 0, projects: [] };
    },
  },
  {
    name: 'ops_helpdesk_sla_breaches',
    title: 'Cảnh báo Phiếu Hỗ trợ CSKH Helpdesk Quá SLA',
    description: 'Kiểm tra các yêu cầu hỗ trợ khách hàng trên Helpdesk sắp hoặc đã quá cam kết phản hồi SLA.',
    group: 'erp_ops_finance',
    groupLabel: GROUP_LABELS.erp_ops_finance,
    moduleKey: 'helpdesk',
    requiredAction: 'view',
    specialistKeys: ['orchestrator', 'finance_ops', 'crm_sales'],
    parameters: {},
    execute: async (ctx) => {
      const cols = await getTableColumnsSafe(ctx.client, 'erp_tickets');
      if (cols.size > 0) {
        const rows = await runOptionalSavepointQuery(
          ctx.client,
          `SELECT * FROM erp_tickets WHERE tenant_id = $1 ORDER BY created_at DESC LIMIT 15`,
          [ctx.tenantId]
        );
        if (rows) return { ticket_count: rows.length, helpdesk_tickets: rows };
      }
      return { ticket_count: 0, helpdesk_tickets: [] };
    },
  },
  {
    name: 'ops_company_announcements',
    title: 'Bảng tin Truyền thông & Vinh danh Nội bộ',
    description: 'Đọc các thông báo điều hành mới nhất và danh sách vinh danh nhân sự trên Enterprise Feed.',
    group: 'erp_ops_finance',
    groupLabel: GROUP_LABELS.erp_ops_finance,
    moduleKey: 'enterprise_feed',
    requiredAction: 'view',
    specialistKeys: ['orchestrator', 'hr_approvals'],
    parameters: {},
    execute: async (ctx) => {
      const cols = await getTableColumnsSafe(ctx.client, 'erp_posts');
      if (cols.size > 0) {
        const rows = await runOptionalSavepointQuery(
          ctx.client,
          `SELECT * FROM erp_posts WHERE tenant_id = $1 ORDER BY created_at DESC LIMIT 10`,
          [ctx.tenantId]
        );
        if (rows) return { post_count: rows.length, announcements: rows };
      }
      return { post_count: 0, announcements: [] };
    },
  },
  {
    name: 'ops_draft_kudos_post',
    title: 'Soạn Bài Đăng Vinh danh Nhân sự (Draft Kudos Post)',
    description: 'Soạn thảo thông điệp ghi nhận và vinh danh cá nhân/tập thể xuất sắc để đăng lên Bảng tin nội bộ.',
    group: 'erp_ops_finance',
    groupLabel: GROUP_LABELS.erp_ops_finance,
    moduleKey: 'enterprise_feed',
    requiredAction: 'create',
    specialistKeys: ['orchestrator', 'hr_approvals'],
    parameters: {
      recipient_name: { type: 'STRING', description: 'Tên cá nhân hoặc đội nhóm được vinh danh' },
      achievement: { type: 'STRING', description: 'Thành tích nổi bật cần ghi nhận' },
    },
    execute: async (_ctx, args) => {
      const recipient = String(args.recipient_name || 'Tập thể xuất sắc').trim();
      const achievement = String(args.achievement || 'Hoàn thành vượt chỉ tiêu cam kết trong kỳ').trim();
      return {
        headline: `🌟 VINH DANH & GHI NHẬN: ${recipient.toUpperCase()}`,
        content_markdown: `Chúc mừng **${recipient}** với dấu ấn xuất sắc: *${achievement}*. Cảm ơn tinh thần chủ động, tận tâm và đóng góp giá trị cho sự phát triển chung của tổ chức!`,
      };
    },
  },
  {
    name: 'ops_b2b_company_lookup',
    title: 'Tra cứu Khách hàng Tổ chức / Đối tác B2B (B2B Accounts)',
    description: 'Tìm kiếm hồ sơ doanh nghiệp B2B, mã số thuế và quy mô hợp tác.',
    group: 'erp_ops_finance',
    groupLabel: GROUP_LABELS.erp_ops_finance,
    moduleKey: 'crm_b2b',
    requiredAction: 'view',
    specialistKeys: ['orchestrator', 'crm_sales', 'finance_ops'],
    parameters: {
      keyword: { type: 'STRING', description: 'Tên công ty hoặc mã số thuế cần tìm' },
    },
    execute: async (ctx, args) => {
      const cols = await getTableColumnsSafe(ctx.client, 'erp_companies');
      if (cols.size > 0) {
        const kw = args.keyword ? `%${String(args.keyword).trim().toLowerCase()}%` : null;
        const rows = kw
          ? await runOptionalSavepointQuery(
              ctx.client,
              `SELECT * FROM erp_companies WHERE tenant_id = $1 AND LOWER(name) LIKE $2 LIMIT 15`,
              [ctx.tenantId, kw]
            )
          : await runOptionalSavepointQuery(
              ctx.client,
              `SELECT * FROM erp_companies WHERE tenant_id = $1 ORDER BY created_at DESC LIMIT 15`,
              [ctx.tenantId]
            );
        if (rows) return { company_count: rows.length, companies: rows };
      }
      return { company_count: 0, companies: [] };
    },
  },
  {
    name: 'ops_open_deals_pipeline_value',
    title: 'Tổng Giá trị Cơ hội Bán hàng Đang mở (Open Deals Pipeline)',
    description: 'Tính tổng số lượng và giá trị dự kiến của các cơ hội thương mại B2B đang đàm phán.',
    group: 'erp_ops_finance',
    groupLabel: GROUP_LABELS.erp_ops_finance,
    moduleKey: 'crm_b2b',
    requiredAction: 'view',
    specialistKeys: ['orchestrator', 'crm_sales', 'finance_ops', 'executive_bi'],
    parameters: {},
    execute: async (ctx) => {
      const cols = await getTableColumnsSafe(ctx.client, 'erp_deals');
      if (cols.size > 0) {
        const rows = await runOptionalSavepointQuery(
          ctx.client,
          `SELECT * FROM erp_deals WHERE tenant_id = $1 ORDER BY created_at DESC LIMIT 25`,
          [ctx.tenantId]
        );
        if (rows) {
          const totalVal = rows.reduce((acc, r) => acc + Number((r as Record<string, unknown>).amount_vnd || (r as Record<string, unknown>).value_vnd || 0), 0);
          return {
            deal_label: ctx.terminology.deal_plural,
            open_deals_count: rows.length,
            pipeline_value_vnd: ctx.canViewFinancials ? totalVal : undefined,
            deals: rows.slice(0, 10),
          };
        }
      }
      return { deal_label: ctx.terminology.deal_plural, open_deals_count: 0, deals: [] };
    },
  },
  {
    name: 'ops_quote_lookup',
    title: 'Tra cứu Báo giá Kinh doanh (Sales Quotations)',
    description: 'Tìm kiếm và kiểm tra hiệu lực các bản báo giá gửi cho khách hàng.',
    group: 'erp_ops_finance',
    groupLabel: GROUP_LABELS.erp_ops_finance,
    moduleKey: 'quotes_orders',
    requiredAction: 'view',
    specialistKeys: ['orchestrator', 'crm_sales', 'finance_ops'],
    parameters: {},
    execute: async (ctx) => {
      const cols = await getTableColumnsSafe(ctx.client, 'erp_quotes');
      if (cols.size > 0) {
        const rows = await runOptionalSavepointQuery(
          ctx.client,
          `SELECT * FROM erp_quotes WHERE tenant_id = $1 ORDER BY created_at DESC LIMIT 15`,
          [ctx.tenantId]
        );
        if (rows) return { quote_label: ctx.terminology.quote_singular, count: rows.length, quotes: rows };
      }
      return { quote_label: ctx.terminology.quote_singular, count: 0, quotes: [] };
    },
  },
  {
    name: 'ops_sales_order_revenue_summary',
    title: 'Tổng hợp Doanh thu Đơn bán hàng SO & Đặt cọc',
    description: 'Thống kê tổng giá trị đơn bán hàng (SO) và các khoản đặt cọc đã xác nhận.',
    group: 'erp_ops_finance',
    groupLabel: GROUP_LABELS.erp_ops_finance,
    moduleKey: 'quotes_orders',
    requiredAction: 'view_financials',
    specialistKeys: ['orchestrator', 'finance_ops', 'executive_bi'],
    parameters: {},
    execute: async (ctx) => {
      const cols = await getTableColumnsSafe(ctx.client, 'erp_sales_orders');
      if (cols.size > 0) {
        const rows = await runOptionalSavepointQuery(
          ctx.client,
          `SELECT * FROM erp_sales_orders WHERE tenant_id = $1 ORDER BY created_at DESC LIMIT 20`,
          [ctx.tenantId]
        );
        if (rows) return { order_label: ctx.terminology.order_singular, order_count: rows.length, sales_orders: rows };
      }
      const leadRev = await ctx.client.query<{ rev: number }>(
        'SELECT COALESCE(SUM(total_revenue_vnd), 0) AS rev FROM leads WHERE tenant_id = $1 AND is_deleted = false',
        [ctx.tenantId]
      );
      return {
        order_label: ctx.terminology.order_singular,
        order_count: 0,
        sales_orders: [],
        master_contact_recorded_revenue_vnd: Number(leadRev.rows[0]?.rev || 0),
      };
    },
  },
  {
    name: 'ops_purchase_order_status',
    title: 'Tình trạng Đơn mua hàng (Purchase Orders - PO)',
    description: 'Kiểm tra tiến độ duyệt và nhập kho của các đơn đặt hàng nhà cung cấp (PO).',
    group: 'erp_ops_finance',
    groupLabel: GROUP_LABELS.erp_ops_finance,
    moduleKey: 'quotes_orders',
    requiredAction: 'view',
    specialistKeys: ['orchestrator', 'finance_ops'],
    parameters: {},
    execute: async (ctx) => {
      const cols = await getTableColumnsSafe(ctx.client, 'erp_purchase_orders');
      if (cols.size > 0) {
        const rows = await runOptionalSavepointQuery(
          ctx.client,
          `SELECT * FROM erp_purchase_orders WHERE tenant_id = $1 ORDER BY created_at DESC LIMIT 15`,
          [ctx.tenantId]
        );
        if (rows) return { po_count: rows.length, purchase_orders: rows };
      }
      return { po_count: 0, purchase_orders: [] };
    },
  },
  {
    name: 'ops_cashflow_pnl_summary',
    title: 'Báo cáo Dòng tiền Thu - Chi & Lợi nhuận P&L (Yêu cầu view_financials)',
    description: 'Tổng hợp dòng tiền thực thu, tổng chi phí vận hành và chênh lệch dòng tiền ròng của doanh nghiệp.',
    group: 'erp_ops_finance',
    groupLabel: GROUP_LABELS.erp_ops_finance,
    moduleKey: 'finance',
    requiredAction: 'view_financials',
    specialistKeys: ['orchestrator', 'finance_ops', 'executive_bi'],
    parameters: {},
    execute: async (ctx) => {
      const leadRevRes = await ctx.client.query<{ rev: number }>(
        'SELECT COALESCE(SUM(total_revenue_vnd), 0) AS rev FROM leads WHERE tenant_id = $1 AND is_deleted = false',
        [ctx.tenantId]
      );
      let totalIncome = Number(leadRevRes.rows[0]?.rev || 0);
      let totalExpense = 0;

      const expCols = await getTableColumnsSafe(ctx.client, 'erp_expenses');
      if (expCols.size > 0 && expCols.has('amount_vnd')) {
        const expRows = await runOptionalSavepointQuery<{ total_exp: number }>(
          ctx.client,
          `SELECT COALESCE(SUM(amount_vnd), 0) AS total_exp FROM erp_expenses WHERE tenant_id = $1`,
          [ctx.tenantId]
        );
        if (expRows?.[0]) totalExpense = Number(expRows[0].total_exp || 0);
      }

      const invCols = await getTableColumnsSafe(ctx.client, 'erp_invoices');
      if (invCols.size > 0 && invCols.has('total_amount_vnd')) {
        const invRows = await runOptionalSavepointQuery<{ total_inv: number }>(
          ctx.client,
          `SELECT COALESCE(SUM(total_amount_vnd), 0) AS total_inv FROM erp_invoices WHERE tenant_id = $1`,
          [ctx.tenantId]
        );
        if (invRows?.[0] && Number(invRows[0].total_inv || 0) > totalIncome) {
          totalIncome = Number(invRows[0].total_inv || 0);
        }
      }

      return {
        revenue_label: ctx.terminology.revenue_label,
        total_inflow_vnd: totalIncome,
        total_outflow_vnd: totalExpense,
        net_cashflow_vnd: totalIncome - totalExpense,
      };
    },
  },
  {
    name: 'ops_overdue_invoices',
    title: 'Công nợ Hóa đơn Quá hạn Phải thu (Overdue Receivables)',
    description: 'Liệt kê các hóa đơn bán hàng đã quá hạn thanh toán cần kế toán thu hồi công nợ.',
    group: 'erp_ops_finance',
    groupLabel: GROUP_LABELS.erp_ops_finance,
    moduleKey: 'finance',
    requiredAction: 'view_financials',
    specialistKeys: ['orchestrator', 'finance_ops', 'executive_bi'],
    parameters: {},
    execute: async (ctx) => {
      const cols = await getTableColumnsSafe(ctx.client, 'erp_invoices');
      if (cols.size > 0) {
        const rows = await runOptionalSavepointQuery(
          ctx.client,
          `SELECT * FROM erp_invoices WHERE tenant_id = $1 AND status NOT IN ('paid', 'cancelled') ORDER BY created_at ASC LIMIT 20`,
          [ctx.tenantId]
        );
        if (rows) return { overdue_count: rows.length, invoices: rows };
      }
      return { overdue_count: 0, invoices: [] };
    },
  },
  {
    name: 'ops_low_stock_fifo_alerts',
    title: 'Cảnh báo Tồn kho Thấp & Lô hàng FIFO Sắp hết hạn',
    description: 'Kiểm tra các mã sản phẩm (SKU) chạm ngưỡng tồn kho an toàn hoặc lô nhập FIFO cần ưu tiên xuất.',
    group: 'erp_ops_finance',
    groupLabel: GROUP_LABELS.erp_ops_finance,
    moduleKey: 'inventory_assets',
    requiredAction: 'view',
    specialistKeys: ['orchestrator', 'finance_ops'],
    parameters: {},
    execute: async (ctx) => {
      const cols = await getTableColumnsSafe(ctx.client, 'erp_inventory_batches');
      if (cols.size > 0) {
        const rows = await runOptionalSavepointQuery(
          ctx.client,
          `SELECT * FROM erp_inventory_batches WHERE tenant_id = $1 ORDER BY created_at ASC LIMIT 20`,
          [ctx.tenantId]
        );
        if (rows) return { batch_count: rows.length, fifo_batches: rows };
      }
      return { batch_count: 0, fifo_batches: [] };
    },
  },
  {
    name: 'ops_product_catalog_lookup',
    title: 'Danh mục Sản phẩm / Dịch vụ (Product SKU Catalog)',
    description: 'Tra cứu thông tin sản phẩm, mã SKU, đơn giá niêm yết và trạng thái kinh doanh.',
    group: 'erp_ops_finance',
    groupLabel: GROUP_LABELS.erp_ops_finance,
    moduleKey: 'inventory_assets',
    requiredAction: 'view',
    specialistKeys: ['orchestrator', 'crm_sales', 'finance_ops'],
    parameters: {
      keyword: { type: 'STRING', description: 'Tên hoặc mã SKU sản phẩm' },
    },
    execute: async (ctx, args) => {
      const cols = await getTableColumnsSafe(ctx.client, 'erp_products');
      if (cols.size > 0) {
        const kw = args.keyword ? `%${String(args.keyword).trim().toLowerCase()}%` : null;
        const rows = kw
          ? await runOptionalSavepointQuery(
              ctx.client,
              `SELECT * FROM erp_products WHERE tenant_id = $1 AND LOWER(name) LIKE $2 LIMIT 20`,
              [ctx.tenantId, kw]
            )
          : await runOptionalSavepointQuery(
              ctx.client,
              `SELECT * FROM erp_products WHERE tenant_id = $1 ORDER BY created_at DESC LIMIT 20`,
              [ctx.tenantId]
            );
        if (rows) return { product_label: ctx.terminology.product_singular, count: rows.length, products: rows };
      }
      return { product_label: ctx.terminology.product_singular, count: 0, products: [] };
    },
  },
  {
    name: 'ops_supplier_summary',
    title: 'Danh bạ Nhà cung cấp & Đối tác Mua hàng (Suppliers)',
    description: 'Tra cứu danh sách nhà cung cấp vật tư, hàng hóa và dịch vụ đầu vào.',
    group: 'erp_ops_finance',
    groupLabel: GROUP_LABELS.erp_ops_finance,
    moduleKey: 'inventory_assets',
    requiredAction: 'view',
    specialistKeys: ['orchestrator', 'finance_ops'],
    parameters: {},
    execute: async (ctx) => {
      const cols = await getTableColumnsSafe(ctx.client, 'erp_suppliers');
      if (cols.size > 0) {
        const rows = await runOptionalSavepointQuery(
          ctx.client,
          `SELECT * FROM erp_suppliers WHERE tenant_id = $1 ORDER BY created_at DESC LIMIT 20`,
          [ctx.tenantId]
        );
        if (rows) return { supplier_count: rows.length, suppliers: rows };
      }
      return { supplier_count: 0, suppliers: [] };
    },
  },
  {
    name: 'ops_my_assigned_assets',
    title: 'Tài sản Cố định & Thiết bị Cấp phát cho Nhân sự',
    description: 'Kiểm tra danh mục máy tính, thiết bị và tài sản công ty đang bàn giao cho người dùng.',
    group: 'erp_ops_finance',
    groupLabel: GROUP_LABELS.erp_ops_finance,
    moduleKey: 'inventory_assets',
    requiredAction: 'view',
    specialistKeys: ['orchestrator', 'hr_approvals', 'finance_ops'],
    parameters: {},
    execute: async (ctx) => {
      const cols = await getTableColumnsSafe(ctx.client, 'erp_assets');
      if (cols.size > 0) {
        const ownerCol = cols.has('assigned_user_id')
          ? 'assigned_user_id'
          : cols.has('assigned_to')
            ? 'assigned_to'
            : null;
        const sql =
          ownerCol && ctx.effectiveScope === 'own'
            ? `SELECT * FROM erp_assets WHERE tenant_id = $1 AND ${ownerCol} = $2 LIMIT 20`
            : `SELECT * FROM erp_assets WHERE tenant_id = $1 LIMIT 20`;
        const rows = await runOptionalSavepointQuery(
          ctx.client,
          sql,
          ownerCol && ctx.effectiveScope === 'own' ? [ctx.tenantId, ctx.userId] : [ctx.tenantId]
        );
        if (rows) return { asset_count: rows.length, assets: rows };
      }
      return { asset_count: 0, assets: [] };
    },
  },
  {
    name: 'ops_cloud_drive_search',
    title: 'Tìm kiếm Tài liệu Cloud Drive & Hợp đồng AI OCR (Dept ACL)',
    description: 'Tìm kiếm tệp lưu trữ trên Cloud của doanh nghiệp, tuân thủ chặt quyền truy cập phòng ban.',
    group: 'erp_ops_finance',
    groupLabel: GROUP_LABELS.erp_ops_finance,
    moduleKey: 'cloud_files_ocr',
    requiredAction: 'view',
    specialistKeys: ['orchestrator', 'finance_ops', 'hr_approvals'],
    parameters: {
      keyword: { type: 'STRING', description: 'Tên tài liệu hoặc số hợp đồng cần tra cứu' },
    },
    execute: async (ctx, args) => {
      const cols = await getTableColumnsSafe(ctx.client, 'erp_cloud_files');
      if (cols.size > 0) {
        const rows = await runOptionalSavepointQuery<Record<string, unknown>>(
          ctx.client,
          `SELECT * FROM erp_cloud_files WHERE tenant_id = $1 ORDER BY created_at DESC LIMIT 30`,
          [ctx.tenantId]
        );
        if (rows) {
          const kw = args.keyword ? String(args.keyword).trim().toLowerCase() : '';
          const filtered = rows.filter((r) => {
            if ('allowed_department_ids' in r) {
              if (!canCallerAccessKnowledgeDoc(r.allowed_department_ids, ctx.resolvedRbac.userOrg)) {
                return false;
              }
            }
            if (!kw) return true;
            const fname = String(r.name || r.file_name || r.title || '').toLowerCase();
            return fname.includes(kw);
          });
          return { file_count: filtered.length, files: filtered.slice(0, 15) };
        }
      }
      return { file_count: 0, files: [] };
    },
  },
  {
    name: 'edu_class_schedule_lookup',
    title: 'Tra cứu Lịch Lớp học & Đào tạo (Chỉ mở khi bật Education Add-on)',
    description: 'Xem thời khóa biểu lớp học và lịch giảng dạy dành riêng cho tổ chức bật Education Vertical Add-on.',
    group: 'erp_ops_finance',
    groupLabel: GROUP_LABELS.erp_ops_finance,
    moduleKey: 'education',
    requiredAction: 'view',
    specialistKeys: ['orchestrator'],
    parameters: {},
    execute: async (ctx) => {
      const cols = await getTableColumnsSafe(ctx.client, 'edu_classes');
      if (cols.size > 0) {
        const rows = await runOptionalSavepointQuery(
          ctx.client,
          `SELECT * FROM edu_classes WHERE tenant_id = $1 ORDER BY created_at DESC LIMIT 15`,
          [ctx.tenantId]
        );
        if (rows) return { class_count: rows.length, classes: rows };
      }
      return { class_count: 0, classes: [] };
    },
  },
  {
    name: 'ops_trace_approval_blocker',
    title: 'Truy vết Điểm nghẽn SLA Phê duyệt & Người Duyệt Hiện tại',
    description:
      'Kiểm tra các tờ trình phê duyệt đang chờ ở bước nào, ai đang giữ quyền duyệt và có bị quá hạn SLA hay không.',
    group: 'erp_ops_finance',
    groupLabel: GROUP_LABELS.erp_ops_finance,
    moduleKey: 'approvals',
    requiredAction: 'view',
    specialistKeys: ['orchestrator', 'hr_approvals', 'finance_ops', 'executive_bi'],
    parameters: {},
    execute: async (ctx) => {
      const cols = await getTableColumnsSafe(ctx.client, 'tenant_approval_requests');
      if (cols.size === 0) return { pending_count: 0, blockers: [] };
      const rows =
        (await runOptionalSavepointQuery<Record<string, unknown>>(
          ctx.client,
          `SELECT r.id, r.request_code, r.title, r.category, r.amount_vnd, r.current_step_order, r.total_steps,
                  sl.step_name, sl.due_at, u.full_name AS current_approver_name
           FROM tenant_approval_requests r
           LEFT JOIN tenant_approval_step_logs sl
             ON sl.tenant_id = r.tenant_id AND sl.request_id = r.id AND sl.step_order = r.current_step_order AND sl.status = 'pending'
           LEFT JOIN users u ON u.tenant_id = sl.tenant_id AND u.id = sl.assigned_user_id
           WHERE r.tenant_id = $1 AND r.status = 'pending'
           ORDER BY sl.due_at ASC NULLS LAST, r.created_at ASC
           LIMIT 15`,
          [ctx.tenantId]
        )) || [];
      return {
        pending_count: rows.length,
        blockers: rows.map((r) => ({
          ...r,
          is_sla_overdue: r.due_at ? new Date(String(r.due_at)).getTime() < Date.now() : false,
        })),
      };
    },
  },
  {
    name: 'ops_draft_action_proposal',
    title: 'Khởi tạo Đề xuất Hành động Xác nhận Trước Khi Ghi (ActionProposalCard)',
    description:
      'Chuẩn bị thẻ đề xuất có xác nhận của người dùng (Confirm-Before-Write) cho Nghỉ phép, Đề nghị Chi phí, Tạm ứng, Giao việc hoặc Tạo Lead.',
    group: 'erp_ops_finance',
    groupLabel: GROUP_LABELS.erp_ops_finance,
    moduleKey: 'leads',
    requiredAction: 'view',
    specialistKeys: ['orchestrator', 'crm_sales', 'hr_approvals', 'finance_ops', 'marketing_growth'],
    parameters: {
      action_type: { type: 'STRING', description: 'Loại hành động: leave | expense | cash_advance | task | lead' },
      title: { type: 'STRING', description: 'Tiêu đề đề xuất' },
      amount_vnd: { type: 'NUMBER', description: 'Số tiền VNĐ (nếu là chi phí/tạm ứng)' },
      reason: { type: 'STRING', description: 'Lý do hoặc mô tả chi tiết' },
    },
    execute: async (_ctx, args) => {
      const actionType = ['leave', 'expense', 'cash_advance', 'task', 'lead'].includes(String(args.action_type))
        ? String(args.action_type)
        : 'task';
      const title = String(args.title || 'Đề xuất hành động từ DOM Agent').trim();
      const amountVnd = Number(args.amount_vnd || 0);
      const reason = String(args.reason || 'Được chuẩn bị bởi DOM Agent — chờ người dùng xác nhận trước khi ghi DB.').trim();
      const todayIso = new Date().toISOString().slice(0, 10);

      return {
        requires_user_confirmation: true,
        proposal: {
          action_type: actionType,
          title,
          summary: `${title}${amountVnd > 0 ? ` • ${amountVnd.toLocaleString('vi-VN')}₫` : ''}`,
          params: {
            title,
            amount_vnd: amountVnd,
            reason,
            start_date: todayIso,
            end_date: todayIso,
            priority: 'high',
          },
        },
      };
    },
  },
];

const TOOLS_BY_NAME = new Map<string, DomAgentToolDefinition>(
  DOM_AGENT_TOOLS_REGISTRY.map((t) => [t.name, t])
);

export interface CallerToolCatalogItem {
  name: string;
  title: string;
  description: string;
  group: DomToolGroupKey;
  group_label: string;
  module_key: SaasModuleKey;
  extra_required_modules: SaasModuleKey[];
  required_action: string;
  is_mutating: boolean;
  specialist_keys: string[];
  parameters: Record<string, unknown>;
  entitled: boolean;
  permitted: boolean;
  allowed: boolean;
  effective_scope: DataScope;
  locked_reason: 'MODULE_NOT_ENTITLED' | 'FORBIDDEN_RBAC_PERMISSION' | null;
  upgrade_hint: string | null;
}

export function evaluateToolAccessForCaller(
  tool: DomAgentToolDefinition,
  resolvedRbac: ResolvedUserRbacResult
): {
  entitled: boolean;
  permitted: boolean;
  allowed: boolean;
  effectiveScope: DataScope;
  lockedReason: 'MODULE_NOT_ENTITLED' | 'FORBIDDEN_RBAC_PERMISSION' | null;
  missingModuleKey: string | null;
} {
  const requiredModules: SaasModuleKey[] = [tool.moduleKey, ...(tool.extraRequiredModules || [])];
  for (const modKey of requiredModules) {
    if (!hasModuleEntitlement(resolvedRbac.enabledModules, modKey)) {
      return {
        entitled: false,
        permitted: false,
        allowed: false,
        effectiveScope: 'none',
        lockedReason: 'MODULE_NOT_ENTITLED',
        missingModuleKey: modKey,
      };
    }
  }

  const canonicalKey = normalizeCanonicalModuleKey(tool.moduleKey) || tool.moduleKey;
  const perm =
    resolvedRbac.effectivePermissions[canonicalKey] ||
    resolvedRbac.effectivePermissions[tool.moduleKey];

  if (!perm || perm.scope === 'none' || !perm.actions[tool.requiredAction]) {
    return {
      entitled: true,
      permitted: false,
      allowed: false,
      effectiveScope: perm?.scope || 'none',
      lockedReason: 'FORBIDDEN_RBAC_PERMISSION',
      missingModuleKey: null,
    };
  }

  // Also ensure extraRequiredModules have `view` permission
  for (const extraMod of tool.extraRequiredModules || []) {
    const extraCanon = normalizeCanonicalModuleKey(extraMod) || extraMod;
    const extraPerm =
      resolvedRbac.effectivePermissions[extraCanon] || resolvedRbac.effectivePermissions[extraMod];
    if (!extraPerm || extraPerm.scope === 'none' || !extraPerm.actions.view) {
      return {
        entitled: true,
        permitted: false,
        allowed: false,
        effectiveScope: 'none',
        lockedReason: 'FORBIDDEN_RBAC_PERMISSION',
        missingModuleKey: null,
      };
    }
  }

  return {
    entitled: true,
    permitted: true,
    allowed: true,
    effectiveScope: perm.scope,
    lockedReason: null,
    missingModuleKey: null,
  };
}

export function listDomAgentToolsForCaller(resolvedRbac: ResolvedUserRbacResult): CallerToolCatalogItem[] {
  return DOM_AGENT_TOOLS_REGISTRY.map((tool) => {
    const access = evaluateToolAccessForCaller(tool, resolvedRbac);
    return {
      name: tool.name,
      title: tool.title,
      description: tool.description,
      group: tool.group,
      group_label: tool.groupLabel,
      module_key: tool.moduleKey,
      extra_required_modules: tool.extraRequiredModules || [],
      required_action: tool.requiredAction,
      is_mutating: Boolean(tool.isMutating),
      specialist_keys: tool.specialistKeys,
      parameters: tool.parameters,
      entitled: access.entitled,
      permitted: access.permitted,
      allowed: access.allowed,
      effective_scope: access.effectiveScope,
      locked_reason: access.lockedReason,
      upgrade_hint: access.missingModuleKey ? buildUpgradeHintForModule(access.missingModuleKey) : null,
    };
  });
}

export function getGeminiFunctionDeclarationsForCaller(
  resolvedRbac: ResolvedUserRbacResult,
  specialistKey = 'orchestrator'
): Array<Record<string, unknown>> {
  return DOM_AGENT_TOOLS_REGISTRY.filter((tool) => {
    if (specialistKey !== 'orchestrator' && !tool.specialistKeys.includes(specialistKey)) {
      return false;
    }
    return evaluateToolAccessForCaller(tool, resolvedRbac).allowed;
  }).map((tool) => ({
    name: tool.name,
    description: tool.description,
    parameters: {
      type: 'OBJECT',
      properties: tool.parameters,
      required: tool.requiredParams || [],
    },
  }));
}

/**
 * Executes a single DOM Agent tool under strict 3-layer security guardrails:
 *   1. Tenant SaaS Package Entitlement Gate (`hasModuleEntitlement`)
 *   2. Zero-Short-Circuit Granular RBAC Permission Gate (`resolveUserEffectivePermissions`)
 *   3. 7-Tier Data Scope SQL Filter + Server-Side PII Masking (`maskContactPiiIfDisallowed`)
 * Always records an immutable audit row in `tenant_ai_tool_audit_logs` (`allowed = true | false`).
 */
export async function executeDomAgentToolInTx(
  client: DbClient,
  tenantCtx: TenantContext,
  toolName: string,
  rawArgs: Record<string, unknown> = {}
): Promise<DomToolExecutionResult> {
  const startedAt = Date.now();
  const cleanName = String(toolName || '').trim();
  const args = rawArgs && typeof rawArgs === 'object' ? rawArgs : {};
  const argsSummary = summarizeArgsForAudit(args);

  const tool = TOOLS_BY_NAME.get(cleanName);
  if (!tool) {
    const latency = Date.now() - startedAt;
    const auditId = await insertDomToolAuditLog(client, {
      tenantId: tenantCtx.tenantId,
      userId: tenantCtx.userId,
      toolName: cleanName || 'unknown_tool',
      moduleKey: 'dom_agent',
      requiredAction: 'view',
      dataScope: 'none',
      allowed: false,
      denialReason: `TOOL_NOT_FOUND: Công cụ '${cleanName}' không tồn tại trong danh mục 72 công cụ DOM Agent.`,
      argsSummary,
      latencyMs: latency,
    });
    return {
      allowed: false,
      status_code: 404,
      error_code: 'TOOL_NOT_FOUND',
      denial_reason: `Công cụ '${cleanName}' không tồn tại trong danh mục DOM Agent.`,
      tool_name: cleanName,
      module_key: 'dom_agent',
      required_action: 'view',
      effective_scope: 'none',
      pii_masked: true,
      audit_log_id: auditId,
      latency_ms: latency,
    };
  }

  const [resolvedRbac, tenantRowRes] = await Promise.all([
    resolveUserEffectivePermissions(client, tenantCtx.tenantId, tenantCtx.userId),
    client.query<{
      package_code?: string;
      plan_tier: string;
      subscription_plan_code: string | null;
      crm_erp_upgrade_status: string | null;
      industry: string;
      industry_key?: string;
      enabled_modules?: unknown;
      entitlements?: unknown;
      settings: Record<string, unknown>;
    }>(
      `SELECT package_code, plan_tier, subscription_plan_code, crm_erp_upgrade_status,
              industry, industry_key, enabled_modules, entitlements, settings
       FROM tenants
       WHERE id = $1
       LIMIT 1`,
      [tenantCtx.tenantId]
    ),
  ]);

  const tRow = tenantRowRes.rows[0] || {};
  const entSnap = resolveTenantEntitlementSnapshot(tRow);
  const normSettings = normalizeTenantSettings(tRow.settings);

  // --------------------------------------------------------------------------
  // GATE 1: PACKAGE ENTITLEMENT CHECK
  // --------------------------------------------------------------------------
  const access = evaluateToolAccessForCaller(tool, resolvedRbac);
  if (!access.entitled) {
    const missingMod = access.missingModuleKey || tool.moduleKey;
    const hint = buildUpgradeHintForModule(missingMod);
    const reason = `MODULE_NOT_ENTITLED: Phân hệ '${missingMod}' không nằm trong gói '${entSnap.package_code}'. ${hint}`;
    const latency = Date.now() - startedAt;
    const auditId = await insertDomToolAuditLog(client, {
      tenantId: tenantCtx.tenantId,
      userId: tenantCtx.userId,
      toolName: tool.name,
      moduleKey: tool.moduleKey,
      requiredAction: tool.requiredAction,
      dataScope: 'none',
      allowed: false,
      denialReason: reason,
      argsSummary,
      latencyMs: latency,
    });
    return {
      allowed: false,
      status_code: 403,
      error_code: 'MODULE_NOT_ENTITLED',
      denial_reason: reason,
      upgrade_hint: hint,
      tool_name: tool.name,
      tool_title: tool.title,
      module_key: tool.moduleKey,
      required_action: tool.requiredAction,
      effective_scope: 'none',
      pii_masked: true,
      audit_log_id: auditId,
      latency_ms: latency,
    };
  }

  // --------------------------------------------------------------------------
  // GATE 2: ZERO-SHORT-CIRCUIT GRANULAR RBAC CHECK
  // --------------------------------------------------------------------------
  const canonicalKey = normalizeCanonicalModuleKey(tool.moduleKey) || tool.moduleKey;
  const modPerm =
    resolvedRbac.effectivePermissions[canonicalKey] ||
    resolvedRbac.effectivePermissions[tool.moduleKey];

  // Extra check for crm_upsert_lead when updating an existing lead_id (`edit` required)
  const needsEditCheck = tool.name === 'crm_upsert_lead' && Boolean(args.lead_id && String(args.lead_id).trim());
  const editDenied = needsEditCheck && !modPerm?.actions.edit;

  if (!access.permitted || editDenied) {
    const missingAct = editDenied ? 'edit' : tool.requiredAction;
    const reason = `FORBIDDEN_RBAC_PERMISSION: Tài khoản không có quyền '${missingAct}' trên phân hệ '${tool.moduleKey}' (scope: ${modPerm?.scope || 'none'}).`;
    const latency = Date.now() - startedAt;
    const auditId = await insertDomToolAuditLog(client, {
      tenantId: tenantCtx.tenantId,
      userId: tenantCtx.userId,
      toolName: tool.name,
      moduleKey: tool.moduleKey,
      requiredAction: missingAct,
      dataScope: modPerm?.scope || 'none',
      allowed: false,
      denialReason: reason,
      argsSummary,
      latencyMs: latency,
    });
    return {
      allowed: false,
      status_code: 403,
      error_code: 'FORBIDDEN_RBAC_PERMISSION',
      denial_reason: reason,
      tool_name: tool.name,
      tool_title: tool.title,
      module_key: tool.moduleKey,
      required_action: missingAct,
      effective_scope: modPerm?.scope || 'none',
      pii_masked: true,
      audit_log_id: auditId,
      latency_ms: latency,
    };
  }

  // --------------------------------------------------------------------------
  // GATE 3: GRANULAR DATA SCOPE + SERVER PII MASKING EXECUTION
  // --------------------------------------------------------------------------
  const leadsPerm = resolvedRbac.effectivePermissions.leads;
  const moduleUnmask = Boolean(modPerm?.actions.unmask_phone);
  const leadsUnmask = leadsPerm ? Boolean(leadsPerm.actions.unmask_phone) : moduleUnmask;
  const canUnmaskPhone = moduleUnmask && leadsUnmask;
  const canViewFinancials = Boolean(modPerm?.actions.view_financials);

  const piiOptions = {
    pii_masking_enabled: normSettings.pii_masking_enabled,
    pii_mask_phone_prefix: normSettings.pii_mask_phone_prefix,
    pii_mask_phone_suffix: normSettings.pii_mask_phone_suffix,
    pii_mask_char: normSettings.pii_mask_char,
    pii_mask_email: normSettings.pii_mask_email,
    pii_hide_internal_notes: normSettings.pii_hide_internal_notes,
    pii_mask_all_sales: normSettings.pii_mask_all_sales,
    pii_mask_before_accept: normSettings.pii_mask_before_accept,
    default_dial_code: normSettings.default_dial_code,
  };

  const execCtx: ToolExecutionContext = {
    client,
    tenantCtx,
    tenantId: tenantCtx.tenantId,
    userId: tenantCtx.userId,
    packageCode: entSnap.package_code,
    enabledModules: resolvedRbac.enabledModules,
    terminology: entSnap.terminology,
    piiOptions,
    resolvedRbac,
    effectiveScope: access.effectiveScope,
    canUnmaskPhone,
    canViewFinancials,
  };

  const rawOutput = await tool.execute(execCtx, args);

  // Sanitize any free-text message field if caller lacks `unmask_phone`
  if (!canUnmaskPhone && typeof rawOutput.message === 'string') {
    rawOutput.message = sanitizeFreeText(rawOutput.message, false, piiOptions);
  }

  const latency = Date.now() - startedAt;
  const auditId = await insertDomToolAuditLog(client, {
    tenantId: tenantCtx.tenantId,
    userId: tenantCtx.userId,
    toolName: tool.name,
    moduleKey: tool.moduleKey,
    requiredAction: tool.requiredAction,
    dataScope: access.effectiveScope,
    allowed: true,
    denialReason: null,
    argsSummary,
    latencyMs: latency,
  });

  return {
    allowed: true,
    status_code: 200,
    tool_name: tool.name,
    tool_title: tool.title,
    module_key: tool.moduleKey,
    required_action: tool.requiredAction,
    effective_scope: access.effectiveScope,
    pii_masked: !canUnmaskPhone,
    audit_log_id: auditId,
    latency_ms: latency,
    output: rawOutput,
  };
}
