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
    const steps: FlowStepNodeDto[] = Array.isArray(req.body?.steps)
      ? req.body.steps
      : Array.isArray(req.body?.steps_json)
        ? req.body.steps_json
        : [];
    const settings =
      req.body?.settings && typeof req.body.settings === 'object' ? req.body.settings : {};
    const status = req.body?.status === 'active' || req.body?.status === 'published' ? 'active' : 'draft';

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

      const prevStepsJson = JSON.stringify(parseJsonCol<FlowStepNodeDto[]>(ex.steps_json, []));
      const nextStepsJson = JSON.stringify(steps);
      const prevTrigCfgJson = JSON.stringify(parseJsonCol(ex.trigger_config, {}));
      const nextTrigCfgJson = JSON.stringify(triggerConfig);
      const shouldSnapshot =
        status === 'active' &&
        (prevStepsJson !== nextStepsJson ||
          prevTrigCfgJson !== nextTrigCfgJson ||
          triggerType !== String(ex.trigger_type) ||
          String(ex.status) !== 'active');
      const nextVersion = shouldSnapshot ? Number(ex.version || 0) + 1 : Number(ex.version || 1);

      await client.query(
        `UPDATE mkt_flows
         SET name = $3,
             description = $4,
             status = $5,
             trigger_type = $6,
             trigger_config = $7::jsonb,
             steps_json = $8::jsonb,
             settings_json = $9::jsonb,
             version = $10,
             updated_at = clock_timestamp()
         WHERE tenant_id = $1 AND id = $2`,
        [
          ctx.tenantId,
          req.params.id,
          name,
          description,
          status,
          triggerType,
          nextTrigCfgJson,
          nextStepsJson,
          JSON.stringify(settings),
          nextVersion,
        ]
      );

      if (shouldSnapshot) {
        const audit = auditFlowWithDomAgent(triggerType, steps);
        await client.query(
          `INSERT INTO mkt_flow_snapshots (
             id, tenant_id, flow_id, version, trigger_type, trigger_config, steps_json, review_score, published_by
           ) VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7::jsonb, $8, $9)`,
          [
            crypto.randomUUID(),
            ctx.tenantId,
            req.params.id,
            nextVersion,
            triggerType,
            nextTrigCfgJson,
            nextStepsJson,
            audit.score,
            ctx.userId,
          ]
        );
      }

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

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Restore from Version Snapshot
flowsRouter.post('/:id/restore-snapshot', requirePermission('mkt_flows', 'edit'), async (req, res) => {
  try {
    const ctx = getTenantContext();
    const flowId = String(req.params.id || '').trim();
    if (!UUID_REGEX.test(flowId)) {
      sendApiError(res, 404, 'FLOW_NOT_FOUND', 'Không tìm thấy Automation Flow.');
      return;
    }
    const snapshotId = String(req.body?.snapshot_id || '').trim();
    if (!snapshotId) {
      sendApiError(res, 422, 'SNAPSHOT_ID_REQUIRED', 'Vui lòng cung cấp snapshot_id cần khôi phục.');
      return;
    }
    if (!UUID_REGEX.test(snapshotId)) {
      sendApiError(res, 404, 'SNAPSHOT_NOT_FOUND', 'Không tìm thấy phiên bản Snapshot cần khôi phục.');
      return;
    }

    const restored = await withTenantTransaction(ctx.tenantId, async (client) => {
      const [fRes, sRes] = await Promise.all([
        client.query('SELECT * FROM mkt_flows WHERE tenant_id = $1 AND id = $2 LIMIT 1', [ctx.tenantId, flowId]),
        client.query(
          'SELECT * FROM mkt_flow_snapshots WHERE tenant_id = $1 AND flow_id = $2 AND id = $3 LIMIT 1',
          [ctx.tenantId, flowId, snapshotId]
        ),
      ]);
      const flow = fRes.rows[0];
      const snap = sRes.rows[0];
      if (!flow || !snap) return null;

      const restoredTriggerConfig = parseJsonCol<Record<string, unknown>>(snap.trigger_config, {});
      const restoredSteps = parseJsonCol<FlowStepNodeDto[]>(snap.steps_json, []);
      const nextVersion = Number(flow.version || 1) + 1;
      const audit = auditFlowWithDomAgent(String(snap.trigger_type), restoredSteps);

      await client.query(
        `UPDATE mkt_flows
         SET trigger_type = $3,
             trigger_config = $4::jsonb,
             steps_json = $5::jsonb,
             version = $6,
             updated_at = clock_timestamp()
         WHERE tenant_id = $1 AND id = $2`,
        [
          ctx.tenantId,
          flowId,
          snap.trigger_type,
          JSON.stringify(restoredTriggerConfig),
          JSON.stringify(restoredSteps),
          nextVersion,
        ]
      );

      await client.query(
        `INSERT INTO mkt_flow_snapshots (
           id, tenant_id, flow_id, version, trigger_type, trigger_config, steps_json, review_score, published_by
         ) VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7::jsonb, $8, $9)`,
        [
          crypto.randomUUID(),
          ctx.tenantId,
          flowId,
          nextVersion,
          snap.trigger_type,
          JSON.stringify(restoredTriggerConfig),
          JSON.stringify(restoredSteps),
          audit.score,
          ctx.userId,
        ]
      );

      const r = await client.query('SELECT * FROM mkt_flows WHERE tenant_id = $1 AND id = $2', [
        ctx.tenantId,
        flowId,
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
      skipWaitDelay: Boolean(req.body?.skip_wait_delay ?? false),
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

// FlowAnalyticsTab: Per-Step Conversion Funnel, Engagement & Branch Breakdown
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

      const [enrollsRes, timelineRes] = await Promise.all([
        client.query(
          `SELECT id, lead_id, current_step_id, status, next_run_at, execution_trace, enrolled_at, completed_at
           FROM mkt_flow_enrollments
           WHERE tenant_id = $1 AND flow_id = $2
           ORDER BY enrolled_at DESC
           LIMIT 1000`,
          [ctx.tenantId, req.params.id]
        ),
        client.query<{ lead_id: string; event_type: string; metadata: unknown; created_at: string }>(
          `SELECT lead_id, event_type, metadata, created_at
           FROM lead_timeline_events
           WHERE tenant_id = $1
             AND event_type IN (
               'mkt_email_sent', 'email_opened', 'mkt_email_opened', 'email_clicked', 'mkt_email_clicked',
               'link_clicked', 'zns_sent', 'zns_delivered', 'zns_clicked', 'zns_failed', 'deal_won', 'purchase_event'
             )
           ORDER BY created_at DESC
           LIMIT 2000`,
          [ctx.tenantId]
        ),
      ]);

      const steps = parseJsonCol<FlowStepNodeDto[]>(flowRow.steps_json, []);
      const stepMetricsMap = new Map<
        string,
        {
          step_id: string;
          label: string;
          type: string;
          entered: number;
          waiting: number;
          completed: number;
          sent: number;
          opened: number;
          clicked: number;
          converted: number;
          failed: number;
          yes_count: number;
          no_count: number;
          branch_a_count: number;
          branch_b_count: number;
          branch_counts: Record<string, number>;
          _waitMinutesSum: number;
          _waitMinutesCnt: number;
          _enteredLeads: Set<string>;
        }
      >();

      for (const s of steps) {
        stepMetricsMap.set(s.id, {
          step_id: s.id,
          label: s.label || s.type,
          type: s.type,
          entered: 0,
          waiting: 0,
          completed: 0,
          sent: 0,
          opened: 0,
          clicked: 0,
          converted: 0,
          failed: 0,
          yes_count: 0,
          no_count: 0,
          branch_a_count: 0,
          branch_b_count: 0,
          branch_counts: {},
          _waitMinutesSum: 0,
          _waitMinutesCnt: 0,
          _enteredLeads: new Set<string>(),
        });
      }

      // Build lead/step engagement maps from timeline events scoped to this flow (or lead-level fallback)
      const flowIdStr = String(req.params.id);
      const stepOpenedLeads = new Map<string, Set<string>>();
      const stepClickedLeads = new Map<string, Set<string>>();
      const leadOpenedAny = new Set<string>();
      const leadClickedAny = new Set<string>();
      const leadConvertedAny = new Set<string>();

      for (const ev of timelineRes.rows) {
        const lid = String(ev.lead_id || '');
        if (!lid) continue;
        const et = String(ev.event_type || '').toLowerCase();
        const meta = parseJsonCol<Record<string, unknown>>(ev.metadata, {});
        const metaFlowId = meta.flow_id ? String(meta.flow_id) : null;
        const metaStepId = meta.step_id ? String(meta.step_id) : null;

        if (et === 'email_opened' || et === 'mkt_email_opened') {
          leadOpenedAny.add(lid);
          if ((!metaFlowId || metaFlowId === flowIdStr) && metaStepId) {
            if (!stepOpenedLeads.has(metaStepId)) stepOpenedLeads.set(metaStepId, new Set());
            stepOpenedLeads.get(metaStepId)!.add(lid);
          }
        } else if (et === 'email_clicked' || et === 'mkt_email_clicked' || et === 'link_clicked' || et === 'zns_clicked') {
          leadClickedAny.add(lid);
          if ((!metaFlowId || metaFlowId === flowIdStr) && metaStepId) {
            if (!stepClickedLeads.has(metaStepId)) stepClickedLeads.set(metaStepId, new Set());
            stepClickedLeads.get(metaStepId)!.add(lid);
          }
        } else if (et === 'deal_won' || et === 'purchase_event') {
          leadConvertedAny.add(lid);
        }
      }

      let activeWaitingCount = 0;
      let exitedCount = 0;
      let failedEnrollmentCount = 0;
      let completedEnrollCount = 0;
      const nowMs = Date.now();

      for (const en of enrollsRes.rows) {
        const lid = String(en.lead_id || '');
        const enStatus = String(en.status || '');
        if (enStatus === 'waiting') activeWaitingCount++;
        else if (enStatus === 'exited') exitedCount++;
        else if (enStatus === 'failed') failedEnrollmentCount++;
        else if (enStatus === 'completed') completedEnrollCount++;

        const trace = parseJsonCol<FlowTraceEntry[]>(en.execution_trace, []);
        const seenStepInThisRun = new Set<string>();

        for (let i = 0; i < trace.length; i++) {
          const t = trace[i];
          const m = stepMetricsMap.get(t.step_id);
          if (!m) continue;

          if (!seenStepInThisRun.has(t.step_id)) {
            seenStepInThisRun.add(t.step_id);
            m.entered++;
            if (lid) m._enteredLeads.add(lid);
          }

          const outcomeLower = String(t.outcome || '').toLowerCase();
          const isWaitScheduled = outcomeLower.includes('đặt lịch chờ') || outcomeLower.includes('đang chờ sự kiện');
          const isFailedOrSkipped =
            outcomeLower.includes('thất bại') ||
            outcomeLower.includes('lỗi') ||
            outcomeLower.includes('bỏ qua') ||
            outcomeLower.includes('từ chối');

          if (isFailedOrSkipped) {
            m.failed++;
          } else if (!isWaitScheduled || i < trace.length - 1 || enStatus !== 'waiting') {
            m.completed++;
          }

          if (t.node_type === 'send_email' || t.node_type === 'send_zns') {
            if (!isFailedOrSkipped && (outcomeLower.includes('đã gửi') || outcomeLower.includes('mô phỏng'))) {
              m.sent++;
            }
          }

          if (t.node_type === 'push_to_autodata_sale_round' && !isFailedOrSkipped) {
            m.converted++;
          }

          if (t.branch) {
            const bKey = String(t.branch);
            m.branch_counts[bKey] = (m.branch_counts[bKey] || 0) + 1;
            if (bKey === 'yes') m.yes_count++;
            if (bKey === 'no') m.no_count++;
            if (bKey === 'A') m.branch_a_count++;
            if (bKey === 'B') m.branch_b_count++;
          }

          // Compute wait duration between this step and next trace entry (or now if still waiting)
          if (t.node_type === 'wait_delay' && t.timestamp) {
            const startTs = new Date(t.timestamp).getTime();
            const nextEntry = trace[i + 1];
            const endTs = nextEntry?.timestamp ? new Date(nextEntry.timestamp).getTime() : enStatus === 'waiting' ? nowMs : startTs;
            if (Number.isFinite(startTs) && Number.isFinite(endTs) && endTs >= startTs) {
              m._waitMinutesSum += (endTs - startTs) / 60_000;
              m._waitMinutesCnt++;
            }
          }
        }

        if (enStatus === 'waiting' && en.current_step_id && stepMetricsMap.has(String(en.current_step_id))) {
          const wm = stepMetricsMap.get(String(en.current_step_id))!;
          wm.waiting++;
          if (!seenStepInThisRun.has(String(en.current_step_id))) {
            wm.entered++;
            if (lid) wm._enteredLeads.add(lid);
          }
        }
      }

      const mappedFlow = mapFlowRow(flowRow);
      const effectiveEnrolled = Math.max(mappedFlow.enrolled_count, enrollsRes.rows.length);
      const effectiveCompleted = Math.max(mappedFlow.completed_count, completedEnrollCount);

      let totalSent = 0;
      let totalOpened = 0;
      let totalClicked = 0;
      let totalConverted = 0;
      let totalFailed = 0;

      const rawMetricsList = Array.from(stepMetricsMap.values());
      const stepFunnel = rawMetricsList.map((m, idx) => {
        const isMessaging = ['send_email', 'action', 'send_zns', 'zalo_zns'].includes(String(m.type).toLowerCase());
        let opened = stepOpenedLeads.get(m.step_id)?.size || 0;
        let clicked = stepClickedLeads.get(m.step_id)?.size || 0;
        if (isMessaging && opened === 0 && m.sent > 0) {
          for (const lid of m._enteredLeads) {
            if (leadOpenedAny.has(lid)) opened++;
          }
        }
        if (isMessaging && clicked === 0 && m.sent > 0) {
          for (const lid of m._enteredLeads) {
            if (leadClickedAny.has(lid)) clicked++;
          }
        }
        let converted = m.converted;
        if (converted === 0) {
          for (const lid of m._enteredLeads) {
            if (leadConvertedAny.has(lid)) converted++;
          }
        }

        totalSent += m.sent;
        totalOpened += opened;
        totalClicked += clicked;
        totalConverted = Math.max(totalConverted, converted, mappedFlow.pushed_to_sale_count);
        totalFailed += m.failed;

        const prevEntered = idx === 0 ? effectiveEnrolled : Math.max(1, rawMetricsList[idx - 1].entered);
        const dropOffPct =
          m.entered > 0
            ? Number((Math.max(0, (m.entered - m.completed - m.waiting) / m.entered) * 100).toFixed(1))
            : idx > 0 && prevEntered > 0
              ? 100
              : 0;
        const avgWaitMinutes = m._waitMinutesCnt > 0 ? Number((m._waitMinutesSum / m._waitMinutesCnt).toFixed(1)) : 0;

        return {
          step_id: m.step_id,
          label: m.label,
          type: m.type,
          entered: m.entered,
          waiting: m.waiting,
          completed: m.completed,
          sent: m.sent,
          opened,
          clicked,
          converted,
          failed: m.failed,
          drop_off_pct: dropOffPct,
          avg_wait_minutes: avgWaitMinutes,
          yes_count: m.yes_count,
          no_count: m.no_count,
          branch_a_count: m.branch_a_count,
          branch_b_count: m.branch_b_count,
          branch_counts: m.branch_counts,
          conversion_pct:
            effectiveEnrolled > 0 ? Number(((m.completed / Math.max(1, effectiveEnrolled)) * 100).toFixed(1)) : 0,
        };
      });

      return {
        flow: mappedFlow,
        summary: {
          enrolled_count: effectiveEnrolled,
          completed_count: effectiveCompleted,
          waiting_count: activeWaitingCount,
          exited_count: exitedCount,
          failed_count: Math.max(failedEnrollmentCount, totalFailed),
          pushed_to_sale_count: mappedFlow.pushed_to_sale_count,
          attributed_revenue_vnd: mappedFlow.attributed_revenue_vnd,
          total_sent: totalSent,
          total_opened: totalOpened,
          total_clicked: totalClicked,
          total_converted: totalConverted,
          completion_rate_pct:
            effectiveEnrolled > 0 ? Number(((effectiveCompleted / effectiveEnrolled) * 100).toFixed(1)) : 0,
          open_rate_pct: totalSent > 0 ? Number(((totalOpened / totalSent) * 100).toFixed(1)) : 0,
          click_rate_pct: totalSent > 0 ? Number(((totalClicked / totalSent) * 100).toFixed(1)) : 0,
          conversion_rate_pct:
            effectiveEnrolled > 0 ? Number(((totalConverted / effectiveEnrolled) * 100).toFixed(1)) : 0,
          error_rate_pct:
            totalSent + totalFailed > 0 ? Number(((totalFailed / (totalSent + totalFailed)) * 100).toFixed(1)) : 0,
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
          skipWaitDelay: Boolean(req.body?.skip_wait_delay ?? false),
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
