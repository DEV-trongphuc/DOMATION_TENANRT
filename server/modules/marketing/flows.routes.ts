import crypto from 'node:crypto';
import { Router } from 'express';
import { withTenantTransaction } from '../../core/database/transaction.ts';
import { getTenantContext } from '../../core/context/tenant-context.ts';
import { getTenantSettingsCached } from '../../core/settings/tenant-cache.ts';
import {
  requireEntitlement,
  requirePermission,
  sendApiError,
} from '../../core/security/rbac.ts';
import { maskContactPiiIfDisallowed } from '../../core/security/pii-masker.ts';
import {
  FLOW_11_NODES,
  FLOW_15_TRIGGERS,
  auditFlowWithDomAgent,
  executeFlowForLead,
  simulateFlowExecution,
  type FlowStepNodeDto,
  type FlowTraceEntry,
} from './flow-engine.service.ts';
import { canUserUnmaskMarketingPii, parseJsonCol } from './utils.ts';

export const flowsRouter = Router();

flowsRouter.use(requireEntitlement('mkt_flows'));

function mapFlowRow(row: Record<string, unknown>) {
  return {
    id: String(row.id),
    tenant_id: String(row.tenant_id),
    name: String(row.name || ''),
    description: row.description ? String(row.description) : '',
    status: String(row.status || 'draft'),
    trigger_type: String(row.trigger_type || 'form_submitted'),
    trigger_config: parseJsonCol<Record<string, unknown>>(row.trigger_config, {}),
    steps: parseJsonCol<FlowStepNodeDto[]>(row.steps_json, []),
    settings: parseJsonCol<Record<string, unknown>>(row.settings_json, {}),
    version: Number(row.version || 1),
    enrolled_count: Number(row.enrolled_count || 0),
    completed_count: Number(row.completed_count || 0),
    pushed_to_sale_count: Number(row.pushed_to_sale_count || 0),
    attributed_revenue_vnd: Number(row.attributed_revenue_vnd || 0),
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

// Lookup Zalo ZNS / ZBS Templates for `ZaloZNSStepConfig`
flowsRouter.get('/zalo-templates', requirePermission('mkt_flows', 'view'), async (_req, res) => {
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
    sendApiError(res, 500, 'LIST_FLOW_ZALO_TEMPLATES_FAILED', err?.message || 'Không thể tải danh sách mẫu Zalo ZNS.');
  }
});

// List Flows + 15 Triggers × 11 Nodes Catalog + Linked Entities (Templates, Forms, Audiences, Rounds, Vouchers)
flowsRouter.get('/', requirePermission('mkt_flows', 'view'), async (_req, res) => {
  try {
    const ctx = getTenantContext();
    const data = await withTenantTransaction(ctx.tenantId, async (client) => {
      const [flowsRes, tplRes, formsRes, audRes, roundsRes, vouchersRes] = await Promise.all([
        client.query('SELECT * FROM mkt_flows WHERE tenant_id = $1 ORDER BY updated_at DESC', [ctx.tenantId]),
        client.query('SELECT id, name, subject FROM mkt_email_templates WHERE tenant_id = $1 ORDER BY name ASC', [
          ctx.tenantId,
        ]),
        client.query('SELECT id, name FROM mkt_forms WHERE tenant_id = $1 ORDER BY name ASC', [ctx.tenantId]),
        client.query(
          'SELECT id, name, audience_type FROM tenant_audiences WHERE tenant_id = $1 AND is_active = true ORDER BY name ASC',
          [ctx.tenantId]
        ),
        client.query(
          'SELECT id, name, pipeline_id FROM distribution_rounds WHERE tenant_id = $1 AND is_active = true ORDER BY priority ASC',
          [ctx.tenantId]
        ),
        client.query('SELECT id, name, code_prefix FROM mkt_voucher_campaigns WHERE tenant_id = $1 ORDER BY name ASC', [
          ctx.tenantId,
        ]),
      ]);

      return {
        items: flowsRes.rows.map(mapFlowRow),
        triggers_catalog: FLOW_15_TRIGGERS,
        nodes_catalog: FLOW_11_NODES,
        templates: tplRes.rows,
        forms: formsRes.rows,
        audiences: audRes.rows,
        rounds: roundsRes.rows,
        vouchers: vouchersRes.rows,
      };
    });

    res.json({ success: true, data });
  } catch (err: any) {
    sendApiError(res, 500, 'LIST_FLOWS_FAILED', err?.message || 'Không thể tải danh sách Automation Flows.');
  }
});

// Create Flow
flowsRouter.post('/', requirePermission('mkt_flows', 'create'), async (req, res) => {
  try {
    const ctx = getTenantContext();
    const name = String(req.body?.name || '').trim();
    if (!name) {
      sendApiError(res, 422, 'FLOW_NAME_REQUIRED', 'Vui lòng nhập tên Kịch bản tự động (Flow).');
      return;
    }

    const description = req.body?.description ? String(req.body.description).trim() : null;
    const triggerType = String(req.body?.trigger_type || 'form_submitted').trim();
    const triggerConfig =
      req.body?.trigger_config && typeof req.body.trigger_config === 'object' ? req.body.trigger_config : {};
    const steps: FlowStepNodeDto[] = Array.isArray(req.body?.steps) ? req.body.steps : [];
    const settings =
      req.body?.settings && typeof req.body.settings === 'object' ? req.body.settings : {};
    const status = req.body?.status === 'active' ? 'active' : 'draft';

    const id = crypto.randomUUID();
    const created = await withTenantTransaction(ctx.tenantId, async (client) => {
      await client.query(
        `INSERT INTO mkt_flows (
           id, tenant_id, name, description, status, trigger_type, trigger_config, steps_json, settings_json, version, created_by
         ) VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8::jsonb, $9::jsonb, 1, $10)`,
        [
          id,
          ctx.tenantId,
          name,
          description,
          status,
          triggerType,
          JSON.stringify(triggerConfig),
          JSON.stringify(steps),
          JSON.stringify(settings),
          ctx.userId,
        ]
      );

      if (status === 'active') {
        const audit = auditFlowWithDomAgent(triggerType, steps);
        await client.query(
          `INSERT INTO mkt_flow_snapshots (
             id, tenant_id, flow_id, version, trigger_type, trigger_config, steps_json, review_score, published_by
           ) VALUES ($1, $2, $3, 1, $4, $5::jsonb, $6::jsonb, $7, $8)`,
          [
            crypto.randomUUID(),
            ctx.tenantId,
            id,
            triggerType,
            JSON.stringify(triggerConfig),
            JSON.stringify(steps),
            audit.score,
            ctx.userId,
          ]
        );
      }

      const r = await client.query('SELECT * FROM mkt_flows WHERE tenant_id = $1 AND id = $2', [ctx.tenantId, id]);
      return mapFlowRow(r.rows[0]);
    });

    res.status(201).json({ success: true, data: created });
  } catch (err: any) {
    sendApiError(res, 500, 'CREATE_FLOW_FAILED', err?.message || 'Không thể tạo Automation Flow.');
  }
});

// Get Single Flow + Snapshots + Recent Enrollments
flowsRouter.get('/:id', requirePermission('mkt_flows', 'view'), async (req, res) => {
  try {
    const ctx = getTenantContext();
    const data = await withTenantTransaction(ctx.tenantId, async (client) => {
      const fRes = await client.query('SELECT * FROM mkt_flows WHERE tenant_id = $1 AND id = $2 LIMIT 1', [
        ctx.tenantId,
        req.params.id,
      ]);
      if (!fRes.rows[0]) return null;

      const [snapsRes, enrollsRes] = await Promise.all([
        client.query(
          `SELECT id, version, trigger_type, review_score, created_at
           FROM mkt_flow_snapshots
           WHERE tenant_id = $1 AND flow_id = $2
           ORDER BY version DESC
           LIMIT 25`,
          [ctx.tenantId, req.params.id]
        ),
        client.query(
          `SELECT e.id, e.lead_id, e.snapshot_version, e.status, e.execution_trace, e.enrolled_at, e.completed_at,
                  l.name AS lead_name, l.status AS lead_status, l.lead_score
           FROM mkt_flow_enrollments e
           LEFT JOIN leads l ON l.tenant_id = e.tenant_id AND l.id = e.lead_id
           WHERE e.tenant_id = $1 AND e.flow_id = $2
           ORDER BY e.enrolled_at DESC
           LIMIT 50`,
          [ctx.tenantId, req.params.id]
        ),
      ]);

      return {
        flow: mapFlowRow(fRes.rows[0]),
        snapshots: snapsRes.rows,
        enrollments: enrollsRes.rows.map((e) => ({
          ...e,
          execution_trace: parseJsonCol(e.execution_trace, []),
        })),
      };
    });

    if (!data) {
      sendApiError(res, 404, 'FLOW_NOT_FOUND', 'Không tìm thấy Automation Flow.');
      return;
    }
    res.json({ success: true, data });
  } catch (err: any) {
    sendApiError(res, 500, 'GET_FLOW_FAILED', err?.message || 'Không thể tải chi tiết Automation Flow.');
  }
});

// Update Flow
flowsRouter.put('/:id', requirePermission('mkt_flows', 'edit'), async (req, res) => {
  try {
    const ctx = getTenantContext();
    const updated = await withTenantTransaction(ctx.tenantId, async (client) => {
      const exRes = await client.query('SELECT * FROM mkt_flows WHERE tenant_id = $1 AND id = $2 LIMIT 1', [
        ctx.tenantId,
        req.params.id,
      ]);
      const ex = exRes.rows[0];
      if (!ex) return null;

      const name = req.body?.name !== undefined ? String(req.body.name).trim() : String(ex.name);
      const description =
        req.body?.description !== undefined ? String(req.body.description).trim() : ex.description;
      const status = req.body?.status !== undefined ? String(req.body.status) : String(ex.status);
      const triggerType =
        req.body?.trigger_type !== undefined ? String(req.body.trigger_type).trim() : String(ex.trigger_type);
      const triggerConfig =
        req.body?.trigger_config && typeof req.body.trigger_config === 'object'
          ? req.body.trigger_config
          : parseJsonCol(ex.trigger_config, {});
      const steps: FlowStepNodeDto[] = Array.isArray(req.body?.steps)
        ? req.body.steps
        : parseJsonCol<FlowStepNodeDto[]>(ex.steps_json, []);
      const settings =
        req.body?.settings && typeof req.body.settings === 'object'
          ? req.body.settings
          : parseJsonCol(ex.settings_json, {});

      await client.query(
        `UPDATE mkt_flows
         SET name = $3,
             description = $4,
             status = $5,
             trigger_type = $6,
             trigger_config = $7::jsonb,
             steps_json = $8::jsonb,
             settings_json = $9::jsonb,
             updated_at = clock_timestamp()
         WHERE tenant_id = $1 AND id = $2`,
        [
          ctx.tenantId,
          req.params.id,
          name,
          description,
          status,
          triggerType,
          JSON.stringify(triggerConfig),
          JSON.stringify(steps),
          JSON.stringify(settings),
        ]
      );

      const r = await client.query('SELECT * FROM mkt_flows WHERE tenant_id = $1 AND id = $2', [
        ctx.tenantId,
        req.params.id,
      ]);
      return mapFlowRow(r.rows[0]);
    });

    if (!updated) {
      sendApiError(res, 404, 'FLOW_NOT_FOUND', 'Không tìm thấy Automation Flow.');
      return;
    }
    res.json({ success: true, data: updated });
  } catch (err: any) {
    sendApiError(res, 500, 'UPDATE_FLOW_FAILED', err?.message || 'Không thể cập nhật Automation Flow.');
  }
});

// Publish Flow & Save Immutable Version Snapshot (`mkt_flow_snapshots`)
flowsRouter.post('/:id/publish', requirePermission('mkt_flows', 'edit'), async (req, res) => {
  try {
    const ctx = getTenantContext();
    const published = await withTenantTransaction(ctx.tenantId, async (client) => {
      const exRes = await client.query('SELECT * FROM mkt_flows WHERE tenant_id = $1 AND id = $2 LIMIT 1', [
        ctx.tenantId,
        req.params.id,
      ]);
      const ex = exRes.rows[0];
      if (!ex) return null;

      const steps = parseJsonCol<FlowStepNodeDto[]>(ex.steps_json, []);
      const triggerConfig = parseJsonCol<Record<string, unknown>>(ex.trigger_config, {});
      const nextVersion = Number(ex.version || 0) + 1;
      const audit = auditFlowWithDomAgent(String(ex.trigger_type), steps);

      await client.query(
        `UPDATE mkt_flows
         SET status = 'active',
             version = $3,
             updated_at = clock_timestamp()
         WHERE tenant_id = $1 AND id = $2`,
        [ctx.tenantId, req.params.id, nextVersion]
      );

      const snapId = crypto.randomUUID();
      await client.query(
        `INSERT INTO mkt_flow_snapshots (
           id, tenant_id, flow_id, version, trigger_type, trigger_config, steps_json, review_score, published_by
         ) VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7::jsonb, $8, $9)`,
        [
          snapId,
          ctx.tenantId,
          req.params.id,
          nextVersion,
          ex.trigger_type,
          JSON.stringify(triggerConfig),
          JSON.stringify(steps),
          audit.score,
          ctx.userId,
        ]
      );

      const r = await client.query('SELECT * FROM mkt_flows WHERE tenant_id = $1 AND id = $2', [
        ctx.tenantId,
        req.params.id,
      ]);
      return { flow: mapFlowRow(r.rows[0]), snapshot_id: snapId, review: audit };
    });

    if (!published) {
      sendApiError(res, 404, 'FLOW_NOT_FOUND', 'Không tìm thấy Automation Flow.');
      return;
    }
    res.json({ success: true, data: published });
  } catch (err: any) {
    sendApiError(res, 500, 'PUBLISH_FLOW_FAILED', err?.message || 'Không thể kích hoạt Automation Flow.');
  }
});

// Restore from Version Snapshot
flowsRouter.post('/:id/restore-snapshot', requirePermission('mkt_flows', 'edit'), async (req, res) => {
  try {
    const ctx = getTenantContext();
    const snapshotId = String(req.body?.snapshot_id || '').trim();
    const restored = await withTenantTransaction(ctx.tenantId, async (client) => {
      const sRes = await client.query(
        'SELECT * FROM mkt_flow_snapshots WHERE tenant_id = $1 AND flow_id = $2 AND id = $3 LIMIT 1',
        [ctx.tenantId, req.params.id, snapshotId]
      );
      const snap = sRes.rows[0];
      if (!snap) return null;

      await client.query(
        `UPDATE mkt_flows
         SET trigger_type = $3,
             trigger_config = $4::jsonb,
             steps_json = $5::jsonb,
             updated_at = clock_timestamp()
         WHERE tenant_id = $1 AND id = $2`,
        [
          ctx.tenantId,
          req.params.id,
          snap.trigger_type,
          JSON.stringify(parseJsonCol(snap.trigger_config, {})),
          JSON.stringify(parseJsonCol(snap.steps_json, [])),
        ]
      );

      const r = await client.query('SELECT * FROM mkt_flows WHERE tenant_id = $1 AND id = $2', [
        ctx.tenantId,
        req.params.id,
      ]);
      return mapFlowRow(r.rows[0]);
    });

    if (!restored) {
      sendApiError(res, 404, 'SNAPSHOT_NOT_FOUND', 'Không tìm thấy phiên bản Snapshot cần khôi phục.');
      return;
    }
    res.json({ success: true, data: restored });
  } catch (err: any) {
    sendApiError(res, 500, 'RESTORE_SNAPSHOT_FAILED', err?.message || 'Không thể khôi phục phiên bản Flow.');
  }
});

// Dry-Run Path Tester (`FlowSimulateModal`)
flowsRouter.post('/:id/simulate', requirePermission('mkt_flows', 'view'), async (req, res) => {
  try {
    const ctx = getTenantContext();
    const flowRow = await withTenantTransaction(ctx.tenantId, async (client) => {
      const r = await client.query('SELECT * FROM mkt_flows WHERE tenant_id = $1 AND id = $2 LIMIT 1', [
        ctx.tenantId,
        req.params.id,
      ]);
      return r.rows[0] || null;
    });
    if (!flowRow) {
      sendApiError(res, 404, 'FLOW_NOT_FOUND', 'Không tìm thấy Automation Flow.');
      return;
    }

    const steps = Array.isArray(req.body?.steps)
      ? (req.body.steps as FlowStepNodeDto[])
      : parseJsonCol<FlowStepNodeDto[]>(flowRow.steps_json, []);
    const sampleLead =
      req.body?.sample_lead && typeof req.body.sample_lead === 'object'
        ? (req.body.sample_lead as Record<string, unknown>)
        : {};

    const simulation = simulateFlowExecution(steps, sampleLead);
    res.json({ success: true, data: simulation });
  } catch (err: any) {
    sendApiError(res, 500, 'SIMULATE_FLOW_FAILED', err?.message || 'Không thể chạy giả lập đường đi của Flow.');
  }
});

// DOM Agent Flow Audit (`FlowReviewModal`)
flowsRouter.post('/:id/review', requirePermission('mkt_flows', 'view'), async (req, res) => {
  try {
    const ctx = getTenantContext();
    const flowRow = await withTenantTransaction(ctx.tenantId, async (client) => {
      const r = await client.query('SELECT * FROM mkt_flows WHERE tenant_id = $1 AND id = $2 LIMIT 1', [
        ctx.tenantId,
        req.params.id,
      ]);
      return r.rows[0] || null;
    });
    if (!flowRow) {
      sendApiError(res, 404, 'FLOW_NOT_FOUND', 'Không tìm thấy Automation Flow.');
      return;
    }

    const triggerType = req.body?.trigger_type ? String(req.body.trigger_type) : String(flowRow.trigger_type);
    const steps = Array.isArray(req.body?.steps)
      ? (req.body.steps as FlowStepNodeDto[])
      : parseJsonCol<FlowStepNodeDto[]>(flowRow.steps_json, []);

    const audit = auditFlowWithDomAgent(triggerType, steps);
    res.json({ success: true, data: { auditor: 'DOM Agent', ...audit } });
  } catch (err: any) {
    sendApiError(res, 500, 'REVIEW_FLOW_FAILED', err?.message || 'DOM Agent không thể kiểm toán kịch bản.');
  }
});

// Enroll Lead Manually or Execute Flow Immediately
flowsRouter.post('/:id/enroll', requirePermission('mkt_flows', 'create'), async (req, res) => {
  try {
    const ctx = getTenantContext();
    const leadId = String(req.body?.lead_id || '').trim();
    if (!leadId) {
      sendApiError(res, 422, 'LEAD_ID_REQUIRED', 'Vui lòng chọn Hồ sơ khách hàng (lead_id) để đưa vào Flow.');
      return;
    }

    const execution = await executeFlowForLead(ctx.tenantId, req.params.id, leadId, {
      actorId: ctx.userId,
      skipWaitDelay: Boolean(req.body?.skip_wait_delay ?? true),
    });

    res.status(201).json({ success: true, data: execution });
  } catch (err: any) {
    if (err?.message === 'FLOW_OR_LEAD_NOT_FOUND') {
      sendApiError(res, 404, 'FLOW_OR_LEAD_NOT_FOUND', 'Không tìm thấy kịch bản hoặc hồ sơ khách hàng thuộc doanh nghiệp.');
      return;
    }
    sendApiError(res, 500, 'ENROLL_FLOW_FAILED', err?.message || 'Không thể thực thi Automation Flow cho khách hàng.');
  }
});

flowsRouter.delete('/:id', requirePermission('mkt_flows', 'delete'), async (req, res) => {
  try {
    const ctx = getTenantContext();
    const count = await withTenantTransaction(ctx.tenantId, async (client) => {
      const r = await client.query('DELETE FROM mkt_flows WHERE tenant_id = $1 AND id = $2', [
        ctx.tenantId,
        req.params.id,
      ]);
      return r.rowCount;
    });
    if (!count) {
      sendApiError(res, 404, 'FLOW_NOT_FOUND', 'Không tìm thấy kịch bản cần xóa.');
      return;
    }
    res.json({ success: true, data: { deleted: true } });
  } catch (err: any) {
    sendApiError(res, 500, 'DELETE_FLOW_FAILED', err?.message || 'Không thể xóa Automation Flow.');
  }
});

// FlowAnalyticsTab: Per-Step Conversion Funnel & Branch Breakdown
flowsRouter.get('/:id/analytics', requirePermission('mkt_flows', 'view'), async (req, res) => {
  try {
    const ctx = getTenantContext();
    const data = await withTenantTransaction(ctx.tenantId, async (client) => {
      const fRes = await client.query('SELECT * FROM mkt_flows WHERE tenant_id = $1 AND id = $2 LIMIT 1', [
        ctx.tenantId,
        req.params.id,
      ]);
      const flowRow = fRes.rows[0];
      if (!flowRow) return null;

      const enrollsRes = await client.query(
        `SELECT id, lead_id, current_step_id, status, execution_trace, enrolled_at, completed_at
         FROM mkt_flow_enrollments
         WHERE tenant_id = $1 AND flow_id = $2
         ORDER BY enrolled_at DESC
         LIMIT 500`,
        [ctx.tenantId, req.params.id]
      );

      const steps = parseJsonCol<FlowStepNodeDto[]>(flowRow.steps_json, []);
      const stepMetricsMap = new Map<
        string,
        {
          step_id: string;
          label: string;
          type: string;
          entered: number;
          completed: number;
          waiting: number;
          yes_count: number;
          no_count: number;
          branch_a_count: number;
          branch_b_count: number;
        }
      >();

      for (const s of steps) {
        stepMetricsMap.set(s.id, {
          step_id: s.id,
          label: s.label || s.type,
          type: s.type,
          entered: 0,
          completed: 0,
          waiting: 0,
          yes_count: 0,
          no_count: 0,
          branch_a_count: 0,
          branch_b_count: 0,
        });
      }

      let activeWaitingCount = 0;
      for (const en of enrollsRes.rows) {
        if (en.status === 'waiting') {
          activeWaitingCount++;
          if (en.current_step_id && stepMetricsMap.has(String(en.current_step_id))) {
            stepMetricsMap.get(String(en.current_step_id))!.waiting++;
          }
        }
        const trace = parseJsonCol<FlowTraceEntry[]>(en.execution_trace, []);
        for (const t of trace) {
          const m = stepMetricsMap.get(t.step_id);
          if (!m) continue;
          m.entered++;
          m.completed++;
          if (t.branch === 'yes') m.yes_count++;
          if (t.branch === 'no') m.no_count++;
          if (t.branch === 'A') m.branch_a_count++;
          if (t.branch === 'B') m.branch_b_count++;
        }
      }

      const mappedFlow = mapFlowRow(flowRow);
      const stepFunnel = Array.from(stepMetricsMap.values()).map((m) => ({
        ...m,
        conversion_pct:
          mappedFlow.enrolled_count > 0
            ? Number(((m.completed / Math.max(1, mappedFlow.enrolled_count)) * 100).toFixed(1))
            : 0,
      }));

      return {
        flow: mappedFlow,
        summary: {
          enrolled_count: mappedFlow.enrolled_count,
          completed_count: mappedFlow.completed_count,
          waiting_count: activeWaitingCount,
          pushed_to_sale_count: mappedFlow.pushed_to_sale_count,
          attributed_revenue_vnd: mappedFlow.attributed_revenue_vnd,
          completion_rate_pct:
            mappedFlow.enrolled_count > 0
              ? Number(((mappedFlow.completed_count / mappedFlow.enrolled_count) * 100).toFixed(1))
              : 0,
        },
        step_funnel: stepFunnel,
      };
    });

    if (!data) {
      sendApiError(res, 404, 'FLOW_NOT_FOUND', 'Không tìm thấy Automation Flow.');
      return;
    }
    res.json({ success: true, data });
  } catch (err: any) {
    sendApiError(res, 500, 'FLOW_ANALYTICS_FAILED', err?.message || 'Không thể tải báo cáo phân tích Flow.');
  }
});

// StepParticipantsModal: Live Per-Step Participant Debugger
flowsRouter.get('/:id/steps/:stepId/participants', requirePermission('mkt_flows', 'view'), async (req, res) => {
  try {
    const ctx = getTenantContext();
    const cfg = await getTenantSettingsCached(ctx.tenantId);
    const statusFilter = req.query.status ? String(req.query.status) : 'all';
    const targetStepId = String(req.params.stepId || '').trim();

    const data = await withTenantTransaction(ctx.tenantId, async (client) => {
      const fRes = await client.query('SELECT id, name, steps_json FROM mkt_flows WHERE tenant_id = $1 AND id = $2 LIMIT 1', [
        ctx.tenantId,
        req.params.id,
      ]);
      if (!fRes.rows[0]) return null;

      const canUnmask = await canUserUnmaskMarketingPii(client, ctx.tenantId, ctx.userId);
      const enrollsRes = await client.query(
        `SELECT e.*, l.name, l.phone, l.email, l.lead_score, l.status AS lead_status
         FROM mkt_flow_enrollments e
         LEFT JOIN leads l ON l.tenant_id = e.tenant_id AND l.id = e.lead_id
         WHERE e.tenant_id = $1 AND e.flow_id = $2
         ORDER BY e.enrolled_at DESC
         LIMIT 300`,
        [ctx.tenantId, req.params.id]
      );

      const participants: Array<Record<string, unknown>> = [];
      for (const row of enrollsRes.rows) {
        if (statusFilter !== 'all' && String(row.status) !== statusFilter) continue;
        const trace = parseJsonCol<FlowTraceEntry[]>(row.execution_trace, []);
        const stepEntry = trace.find((t) => t.step_id === targetStepId);
        const isWaitingAtStep = String(row.current_step_id || '') === targetStepId;
        if (!stepEntry && !isWaitingAtStep) continue;

        const masked = maskContactPiiIfDisallowed(row, canUnmask, cfg);
        participants.push({
          enrollment_id: String(row.id),
          lead_id: String(row.lead_id),
          name: masked.name || 'Khách hàng',
          phone: masked.phone || '',
          email: masked.email || '',
          lead_score: Number(row.lead_score || 0),
          lead_status: String(row.lead_status || ''),
          enrollment_status: String(row.status || ''),
          step_outcome: stepEntry?.outcome || (isWaitingAtStep ? 'Đang chờ tại bước này' : ''),
          step_branch: stepEntry?.branch || null,
          step_timestamp: stepEntry?.timestamp || row.enrolled_at,
          execution_trace: trace,
        });
      }

      return {
        step_id: targetStepId,
        total: participants.length,
        participants,
      };
    });

    if (!data) {
      sendApiError(res, 404, 'FLOW_NOT_FOUND', 'Không tìm thấy Automation Flow.');
      return;
    }
    res.json({ success: true, data });
  } catch (err: any) {
    sendApiError(res, 500, 'STEP_PARTICIPANTS_FAILED', err?.message || 'Không thể tải danh sách khách hàng tại bước này.');
  }
});

// ManualTriggerFlowModal: Batch Enroll Leads or Entire Audience
flowsRouter.post('/:id/manual-trigger', requirePermission('mkt_flows', 'create'), async (req, res) => {
  try {
    const ctx = getTenantContext();
    const rawLeadIds: string[] = Array.isArray(req.body?.lead_ids)
      ? req.body.lead_ids.map(String).filter(Boolean)
      : req.body?.lead_id
        ? [String(req.body.lead_id)]
        : [];
    const audienceId = req.body?.audience_id ? String(req.body.audience_id).trim() : null;

    const targetInfo = await withTenantTransaction(ctx.tenantId, async (client) => {
      const fRes = await client.query('SELECT id, settings_json FROM mkt_flows WHERE tenant_id = $1 AND id = $2 LIMIT 1', [
        ctx.tenantId,
        req.params.id,
      ]);
      if (!fRes.rows[0]) return null;

      const ids = new Set<string>(rawLeadIds);
      if (audienceId) {
        const mRes = await client.query<{ lead_id: string }>(
          'SELECT lead_id FROM tenant_audience_members WHERE tenant_id = $1 AND audience_id = $2 LIMIT 100',
          [ctx.tenantId, audienceId]
        );
        for (const r of mRes.rows) ids.add(String(r.lead_id));
      }

      const settings = parseJsonCol<Record<string, unknown>>(fRes.rows[0].settings_json, {});
      if (settings.re_entry_mode === 'once' && ids.size > 0) {
        const prevRes = await client.query<{ lead_id: string }>(
          'SELECT DISTINCT lead_id FROM mkt_flow_enrollments WHERE tenant_id = $1 AND flow_id = $2',
          [ctx.tenantId, req.params.id]
        );
        for (const p of prevRes.rows) ids.delete(String(p.lead_id));
      }

      return Array.from(ids).slice(0, 50);
    });

    if (!targetInfo) {
      sendApiError(res, 404, 'FLOW_NOT_FOUND', 'Không tìm thấy Automation Flow.');
      return;
    }

    let enrolled = 0;
    let promoted = 0;
    for (const lid of targetInfo) {
      try {
        const resExec = await executeFlowForLead(ctx.tenantId, req.params.id, lid, {
          actorId: ctx.userId,
          skipWaitDelay: Boolean(req.body?.skip_wait_delay ?? true),
        });
        enrolled++;
        if (resExec.promotedToSaleRound) promoted++;
      } catch {
        // Skip deleted or missing lead safely
      }
    }

    res.status(201).json({
      success: true,
      data: {
        enrolled_count: enrolled,
        promoted_to_sale_count: promoted,
      },
    });
  } catch (err: any) {
    sendApiError(res, 500, 'MANUAL_TRIGGER_FLOW_FAILED', err?.message || 'Không thể kích hoạt thủ công Automation Flow.');
  }
});
