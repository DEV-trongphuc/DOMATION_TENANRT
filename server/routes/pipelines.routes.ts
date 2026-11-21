import { Router } from 'express';
import { withTenantTransaction } from '../core/database/transaction.ts';
import { getTenantContext } from '../core/context/tenant-context.ts';
import { tenantRedis } from '../core/cache/tenant-redis.ts';
import {
  requireAnyPermission,
  requirePermission,
  requireTenantAuth,
  sendApiError,
} from '../core/security/rbac.ts';
import { isSafeRegexPattern } from '../core/settings/tenant-settings.ts';
import { getTenantSettingsCached } from '../core/settings/tenant-cache.ts';
import { enforceTenantOperationalPolicy } from '../services/billing.service.ts';

export const pipelinesRouter = Router();

pipelinesRouter.use(requireTenantAuth);

const requirePipelineConfig = requirePermission('pipelines', 'manage_config');
const requireRoundsWrite = requireAnyPermission([['rounds', 'edit'], ['rounds', 'manage_config']]);
const requireRoutingWrite = requireAnyPermission([['routing_rules', 'edit'], ['routing_rules', 'manage_config']]);

// ============================================================================
// Distribution Rounds & Routing Rules Management (Op 09)
// Placed BEFORE `/:id` routes to prevent Express parameter shadowing
// ============================================================================
pipelinesRouter.get('/rounds/list', requirePermission('rounds', 'view'), async (_req, res) => {
  try {
    const ctx = getTenantContext();
    const data = await withTenantTransaction(ctx.tenantId, async (client) => {
      const rounds = await client.query(
        `SELECT id, pipeline_id, name, priority, is_active, created_at
         FROM distribution_rounds
         WHERE tenant_id = $1
         ORDER BY priority ASC, created_at ASC`,
        [ctx.tenantId]
      );

      const consultants = await client.query(
        `SELECT rc.id, rc.round_id, rc.user_id, rc.receive_ratio, rc.data_per_turn,
                rc.leads_received_in_round, rc.compensation_count, rc.is_active,
                u.full_name, u.email, u.is_external_agency,
                p.status, p.is_available, p.vacation_mode, p.skipped_credit
         FROM round_consultants rc
         INNER JOIN users u ON u.tenant_id = rc.tenant_id AND u.id = rc.user_id
         LEFT JOIN tenant_user_profiles p ON p.tenant_id = rc.tenant_id AND p.user_id = rc.user_id
         WHERE rc.tenant_id = $1
         ORDER BY u.full_name ASC`,
        [ctx.tenantId]
      );

      const rules = await client.query(
        `SELECT rr.id, rr.round_id, dr.name AS round_name, rr.rule_name, rr.priority,
                rr.conditions_json, rr.condition_branches, rr.connection_scopes, rr.inject_fields, rr.is_active
         FROM routing_rules rr
         LEFT JOIN distribution_rounds dr ON dr.tenant_id = rr.tenant_id AND dr.id = rr.round_id
         WHERE rr.tenant_id = $1
         ORDER BY rr.priority ASC`,
        [ctx.tenantId]
      );

      return {
        rounds: rounds.rows.map((r) => ({
          ...r,
          consultants: consultants.rows.filter((c) => c.round_id === r.id),
        })),
        routing_rules: rules.rows,
      };
    });

    res.json({ success: true, data });
  } catch (err: any) {
    sendApiError(res, 500, 'LIST_ROUNDS_FAILED', err?.message || 'Không thể tải danh sách vòng chia.');
  }
});

pipelinesRouter.post('/rounds', requireRoundsWrite, async (req, res) => {
  try {
    const ctx = getTenantContext();
    const {
      pipeline_id,
      name,
      description = null,
      cc_emails = null,
      priority = 1,
      is_active = true,
      consultants = [],
      consultant_ids = [],
    } = req.body || {};

    const normalizedConsultants: Array<{ user_id: string; receive_ratio?: number; data_per_turn?: number; is_active?: boolean }> =
      Array.isArray(consultants) && consultants.length > 0
        ? consultants
        : Array.isArray(consultant_ids)
          ? consultant_ids.map((uid: unknown) => ({ user_id: String(uid || '').trim(), receive_ratio: 1, data_per_turn: 1 }))
          : [];

    const created = await withTenantTransaction(ctx.tenantId, async (client) => {
      await enforceTenantOperationalPolicy(client, ctx.tenantId, 'create_round');

      let targetPipelineId = pipeline_id;
      if (!targetPipelineId) {
        const p = await client.query<{ id: string }>(
          'SELECT id FROM tenant_pipelines WHERE tenant_id = $1 ORDER BY is_default DESC LIMIT 1',
          [ctx.tenantId]
        );
        targetPipelineId = p.rows[0]?.id;
      }

      const rRes = await client.query<{ id: string; pipeline_id: string; name: string; description: string | null; priority: number; is_active: boolean }>(
        `INSERT INTO distribution_rounds (tenant_id, pipeline_id, name, description, cc_emails, priority, is_active)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         RETURNING id, pipeline_id, name, description, priority, is_active`,
        [
          ctx.tenantId,
          targetPipelineId,
          String(name || 'Vòng Chia Mới').trim(),
          description ? String(description).trim() : null,
          cc_emails ? String(cc_emails).trim() : null,
          Number(priority || 1),
          Boolean(is_active),
        ]
      );

      for (const c of normalizedConsultants) {
        if (!c?.user_id) continue;
        await client.query(
          `INSERT INTO round_consultants (tenant_id, round_id, user_id, receive_ratio, data_per_turn, is_active)
           VALUES ($1, $2, $3, $4, $5, $6)
           ON CONFLICT (tenant_id, round_id, user_id)
           DO UPDATE SET receive_ratio = EXCLUDED.receive_ratio, data_per_turn = EXCLUDED.data_per_turn, is_active = EXCLUDED.is_active`,
          [
            ctx.tenantId,
            rRes.rows[0].id,
            c.user_id,
            Math.max(1, Number(c.receive_ratio || 1)),
            Math.max(1, Number(c.data_per_turn || 1)),
            c.is_active !== false,
          ]
        );
      }

      return rRes.rows[0];
    });

    tenantRedis.invalidateDistributionSnapshot(ctx.tenantId);
    res.status(201).json({ success: true, data: created });
  } catch (err: any) {
    const msg = String(err?.message || '');
    if (msg.startsWith('SUBSCRIPTION_EXPIRED')) {
      sendApiError(res, 402, 'SUBSCRIPTION_EXPIRED', msg);
      return;
    }
    if (msg.startsWith('PLAN_QUOTA_EXCEEDED')) {
      sendApiError(res, 402, 'PLAN_QUOTA_EXCEEDED', msg);
      return;
    }
    sendApiError(res, 500, 'CREATE_ROUND_FAILED', msg || 'Không thể tạo vòng chia data.');
  }
});

pipelinesRouter.patch('/rounds/:roundId', requireRoundsWrite, async (req, res) => {
  try {
    const ctx = getTenantContext();
    const roundId = req.params.roundId;
    const { name, priority, is_active, pipeline_id, reset_counters } = req.body || {};

    const updated = await withTenantTransaction(ctx.tenantId, async (client) => {
      const r = await client.query(
        `UPDATE distribution_rounds
         SET name = COALESCE($3, name),
             priority = COALESCE($4, priority),
             is_active = COALESCE($5, is_active),
             pipeline_id = COALESCE($6, pipeline_id),
             updated_at = clock_timestamp()
         WHERE tenant_id = $1 AND id = $2
         RETURNING *`,
        [
          ctx.tenantId,
          roundId,
          name ? String(name).trim() : null,
          typeof priority === 'number' ? Math.max(1, Math.round(priority)) : null,
          typeof is_active === 'boolean' ? is_active : null,
          pipeline_id || null,
        ]
      );

      if (reset_counters) {
        await client.query(
          `UPDATE round_consultants
           SET leads_received_in_round = 0, updated_at = clock_timestamp()
           WHERE tenant_id = $1 AND round_id = $2`,
          [ctx.tenantId, roundId]
        );
      }

      return r.rows[0] || null;
    });

    if (!updated) {
      sendApiError(res, 404, 'ROUND_NOT_FOUND', 'Không tìm thấy vòng chia data.');
      return;
    }

    tenantRedis.invalidateDistributionSnapshot(ctx.tenantId);
    res.json({ success: true, data: updated });
  } catch (err: any) {
    sendApiError(res, 500, 'UPDATE_ROUND_FAILED', err?.message || 'Không thể cập nhật vòng chia.');
  }
});

pipelinesRouter.put('/rounds/:roundId/consultants', requireRoundsWrite, async (req, res) => {
  try {
    const ctx = getTenantContext();
    const roundId = req.params.roundId;
    const body = req.body || {};
    const replace_all = Boolean(body.replace_all);
    const consultants = Array.isArray(body.consultants)
      ? body.consultants
      : typeof body.user_id === 'string' && body.user_id.trim()
        ? [
            {
              user_id: body.user_id.trim(),
              receive_ratio: body.receive_ratio,
              data_per_turn: body.data_per_turn,
            },
          ]
        : null;

    if (!consultants) {
      sendApiError(res, 422, 'INVALID_CONSULTANTS', 'Danh sách nhân sự trong vòng chia không hợp lệ.');
      return;
    }

    const updatedList = await withTenantTransaction(ctx.tenantId, async (client) => {
      if (replace_all) {
        const keepIds = consultants.map((c: any) => c.user_id).filter(Boolean);
        if (keepIds.length > 0) {
          await client.query(
            `DELETE FROM round_consultants
             WHERE tenant_id = $1 AND round_id = $2 AND NOT (user_id = ANY($3::uuid[]))`,
            [ctx.tenantId, roundId, keepIds]
          );
        } else {
          await client.query('DELETE FROM round_consultants WHERE tenant_id = $1 AND round_id = $2', [
            ctx.tenantId,
            roundId,
          ]);
        }
      }

      for (const c of consultants) {
        if (!c?.user_id) continue;
        await client.query(
          `INSERT INTO round_consultants (tenant_id, round_id, user_id, receive_ratio, data_per_turn, is_active)
           VALUES ($1, $2, $3, $4, $5, $6)
           ON CONFLICT (tenant_id, round_id, user_id)
           DO UPDATE SET
             receive_ratio = EXCLUDED.receive_ratio,
             data_per_turn = EXCLUDED.data_per_turn,
             is_active = EXCLUDED.is_active,
             updated_at = clock_timestamp()`,
          [
            ctx.tenantId,
            roundId,
            c.user_id,
            Math.max(1, Math.round(Number(c.receive_ratio || 1))),
            Math.max(1, Math.round(Number(c.data_per_turn || 1))),
            c.is_active !== false,
          ]
        );
      }

      const out = await client.query(
        `SELECT rc.id, rc.round_id, rc.user_id, rc.receive_ratio, rc.data_per_turn, rc.is_active,
                rc.leads_received_in_round, rc.compensation_count, u.full_name, u.email
         FROM round_consultants rc
         INNER JOIN users u ON u.tenant_id = rc.tenant_id AND u.id = rc.user_id
         WHERE rc.tenant_id = $1 AND rc.round_id = $2
         ORDER BY u.full_name ASC`,
        [ctx.tenantId, roundId]
      );
      return out.rows;
    });

    res.json({ success: true, data: updatedList });
  } catch (err: any) {
    sendApiError(res, 500, 'UPDATE_ROUND_CONSULTANTS_FAILED', err?.message || 'Không thể cập nhật nhân sự vòng chia.');
  }
});

pipelinesRouter.delete('/rounds/:roundId/consultants/:userId', requireRoundsWrite, async (req, res) => {
  try {
    const ctx = getTenantContext();
    await withTenantTransaction(ctx.tenantId, async (client) => {
      await client.query(
        'DELETE FROM round_consultants WHERE tenant_id = $1 AND round_id = $2 AND user_id = $3',
        [ctx.tenantId, req.params.roundId, req.params.userId]
      );
    });
    res.json({ success: true, data: { deleted: true } });
  } catch (err: any) {
    sendApiError(res, 500, 'REMOVE_ROUND_CONSULTANT_FAILED', err?.message || 'Không thể gỡ nhân sự khỏi vòng chia.');
  }
});

pipelinesRouter.delete('/rounds/:roundId', requireRoundsWrite, async (req, res) => {
  try {
    const ctx = getTenantContext();
    const roundId = req.params.roundId;

    await withTenantTransaction(ctx.tenantId, async (client) => {
      const countRes = await client.query<{ cnt: number }>(
        'SELECT COUNT(*)::int AS cnt FROM distribution_rounds WHERE tenant_id = $1',
        [ctx.tenantId]
      );
      if ((countRes.rows[0]?.cnt || 0) <= 1) {
        throw new Error('CANNOT_DELETE_LAST_ROUND');
      }
      await client.query('DELETE FROM distribution_rounds WHERE tenant_id = $1 AND id = $2', [
        ctx.tenantId,
        roundId,
      ]);
    });

    tenantRedis.invalidateDistributionSnapshot(ctx.tenantId);
    res.json({ success: true, data: { deleted: true, round_id: roundId } });
  } catch (err: any) {
    if (err?.message === 'CANNOT_DELETE_LAST_ROUND') {
      sendApiError(res, 422, 'CANNOT_DELETE_LAST_ROUND', 'Hệ thống cần giữ lại tối thiểu 1 vòng chia data.');
      return;
    }
    sendApiError(res, 500, 'DELETE_ROUND_FAILED', err?.message || 'Không thể xóa vòng chia.');
  }
});

pipelinesRouter.post('/routing-rules', requireRoutingWrite, async (req, res) => {
  try {
    const ctx = getTenantContext();
    const {
      round_id,
      rule_name,
      priority = 1,
      conditions_json = [],
      condition_branches = [],
      connection_scopes = ['all'],
      inject_fields = {},
      is_active = true,
    } = req.body || {};
    if (!round_id || !rule_name) {
      sendApiError(res, 422, 'VALIDATION_ERROR', 'Cần chọn Vòng chia đích và đặt tên quy tắc.');
      return;
    }

    const created = await withTenantTransaction(ctx.tenantId, async (client) => {
      const r = await client.query(
        `INSERT INTO routing_rules (
           tenant_id, round_id, rule_name, priority,
           conditions_json, condition_branches, connection_scopes, inject_fields, is_active
         )
         VALUES ($1, $2, $3, $4, $5::jsonb, $6::jsonb, $7::jsonb, $8::jsonb, $9)
         RETURNING *`,
        [
          ctx.tenantId,
          round_id,
          String(rule_name).trim(),
          Number(priority || 1),
          JSON.stringify(conditions_json),
          JSON.stringify(Array.isArray(condition_branches) ? condition_branches : []),
          JSON.stringify(Array.isArray(connection_scopes) ? connection_scopes : ['all']),
          JSON.stringify(inject_fields && typeof inject_fields === 'object' ? inject_fields : {}),
          Boolean(is_active),
        ]
      );
      return r.rows[0];
    });

    tenantRedis.invalidateDistributionSnapshot(ctx.tenantId);
    res.status(201).json({ success: true, data: created });
  } catch (err: any) {
    sendApiError(res, 500, 'CREATE_ROUTING_RULE_FAILED', err?.message || 'Không thể tạo quy tắc định tuyến.');
  }
});

pipelinesRouter.patch('/routing-rules/:ruleId', requireRoutingWrite, async (req, res) => {
  try {
    const ctx = getTenantContext();
    const ruleId = req.params.ruleId;
    const {
      round_id,
      rule_name,
      priority,
      conditions_json,
      condition_branches,
      connection_scopes,
      inject_fields,
      is_active,
    } = req.body || {};

    const updated = await withTenantTransaction(ctx.tenantId, async (client) => {
      const r = await client.query(
        `UPDATE routing_rules
         SET round_id = COALESCE($3, round_id),
             rule_name = COALESCE($4, rule_name),
             priority = COALESCE($5, priority),
             conditions_json = COALESCE($6::jsonb, conditions_json),
             condition_branches = COALESCE($7::jsonb, condition_branches),
             connection_scopes = COALESCE($8::jsonb, connection_scopes),
             inject_fields = COALESCE($9::jsonb, inject_fields),
             is_active = COALESCE($10, is_active),
             updated_at = clock_timestamp()
         WHERE tenant_id = $1 AND id = $2
         RETURNING *`,
        [
          ctx.tenantId,
          ruleId,
          round_id || null,
          rule_name ? String(rule_name).trim() : null,
          typeof priority === 'number' ? Math.max(1, Math.round(priority)) : null,
          conditions_json !== undefined ? JSON.stringify(conditions_json) : null,
          condition_branches !== undefined ? JSON.stringify(condition_branches) : null,
          connection_scopes !== undefined ? JSON.stringify(connection_scopes) : null,
          inject_fields !== undefined ? JSON.stringify(inject_fields) : null,
          typeof is_active === 'boolean' ? is_active : null,
        ]
      );
      return r.rows[0] || null;
    });

    if (!updated) {
      sendApiError(res, 404, 'RULE_NOT_FOUND', 'Không tìm thấy quy tắc định tuyến.');
      return;
    }

    tenantRedis.invalidateDistributionSnapshot(ctx.tenantId);
    res.json({ success: true, data: updated });
  } catch (err: any) {
    sendApiError(res, 500, 'UPDATE_ROUTING_RULE_FAILED', err?.message || 'Không thể cập nhật quy tắc định tuyến.');
  }
});

pipelinesRouter.delete('/routing-rules/:ruleId', requireRoutingWrite, async (req, res) => {
  try {
    const ctx = getTenantContext();
    await withTenantTransaction(ctx.tenantId, async (client) => {
      await client.query('DELETE FROM routing_rules WHERE tenant_id = $1 AND id = $2', [
        ctx.tenantId,
        req.params.ruleId,
      ]);
    });
    tenantRedis.invalidateDistributionSnapshot(ctx.tenantId);
    res.json({ success: true, data: { deleted: true, rule_id: req.params.ruleId } });
  } catch (err: any) {
    sendApiError(res, 500, 'DELETE_ROUTING_RULE_FAILED', err?.message || 'Không thể xóa quy tắc định tuyến.');
  }
});

// ============================================================================
// 4.1 Get Tenant Pipelines (with ordered stages & custom fields)
// ============================================================================
pipelinesRouter.get('/', requirePermission('pipelines', 'view'), async (_req, res) => {
  try {
    const ctx = getTenantContext();
    const data = await withTenantTransaction(ctx.tenantId, async (client) => {
      const pRes = await client.query(
        `SELECT id, name, description, is_default, created_at
         FROM tenant_pipelines
         WHERE tenant_id = $1
         ORDER BY is_default DESC, created_at ASC`,
        [ctx.tenantId]
      );

      const sRes = await client.query(
        `SELECT id, pipeline_id, stage_key, stage_name, stage_order, color_hex, badge_style,
                is_won_stage, is_lost_stage, sla_timeout_minutes, funnel_category, score_delta,
                required_fields, capi_event_mapping
         FROM tenant_pipeline_stages
         WHERE tenant_id = $1
         ORDER BY stage_order ASC`,
        [ctx.tenantId]
      );

      const cfRes = await client.query(
        `SELECT id, pipeline_id, field_key, field_label, field_type, is_required,
                options_json, stage_visibility, config_json
         FROM tenant_pipeline_custom_fields
         WHERE tenant_id = $1
         ORDER BY created_at ASC`,
        [ctx.tenantId]
      );

      return pRes.rows.map((p) => {
        const stages = sRes.rows.filter((s) => s.pipeline_id === p.id);
        const customFields = cfRes.rows.filter((c) => c.pipeline_id === p.id);
        return {
          ...p,
          stages_count: stages.length,
          stages,
          custom_fields: customFields,
        };
      });
    });

    res.json({ success: true, data });
  } catch (err: any) {
    sendApiError(res, 500, 'LIST_PIPELINES_FAILED', err?.message || 'Không thể tải cấu hình Pipeline.');
  }
});

// Create New Pipeline (Op 19)
pipelinesRouter.post('/', requirePipelineConfig, async (req, res) => {
  try {
    const ctx = getTenantContext();
    const { name, description, is_default = false, stages = [], create_default_round = true } = req.body || {};
    if (!name || !String(name).trim()) {
      sendApiError(res, 422, 'VALIDATION_ERROR', 'Tên Pipeline không được để trống.');
      return;
    }

    const created = await withTenantTransaction(ctx.tenantId, async (client) => {
      const cfg = await getTenantSettingsCached(ctx.tenantId, client);

      if (is_default) {
        await client.query('UPDATE tenant_pipelines SET is_default = false WHERE tenant_id = $1', [ctx.tenantId]);
      }
      const pRes = await client.query<{ id: string; name: string; description: string | null; is_default: boolean }>(
        `INSERT INTO tenant_pipelines (tenant_id, name, description, is_default)
         VALUES ($1, $2, $3, $4)
         RETURNING id, name, description, is_default`,
        [ctx.tenantId, String(name).trim(), description || null, Boolean(is_default)]
      );
      const pipelineId = pRes.rows[0].id;

      const stageList =
        Array.isArray(stages) && stages.length > 0
          ? stages
          : [
              {
                stage_key: 'new_lead',
                stage_name: 'Khách Mới',
                stage_order: 1,
                color_hex: '#1E40FF',
                sla_timeout_minutes: cfg.default_sla_minutes,
                capi_event_mapping: 'Lead',
              },
              {
                stage_key: 'qualified',
                stage_name: 'Đang Tư Vấn',
                stage_order: 2,
                color_hex: '#0EA5E9',
                sla_timeout_minutes: 0,
                capi_event_mapping: 'Schedule',
              },
              {
                stage_key: 'won',
                stage_name: 'Chốt Thành Công',
                stage_order: 3,
                color_hex: '#10B981',
                sla_timeout_minutes: 0,
                capi_event_mapping: 'Purchase',
                is_won_stage: true,
              },
            ];

      const insertedStages = [];
      for (let i = 0; i < stageList.length; i++) {
        const st = stageList[i];
        const sRes = await client.query(
          `INSERT INTO tenant_pipeline_stages (
            tenant_id, pipeline_id, stage_key, stage_name, stage_order, color_hex,
            sla_timeout_minutes, capi_event_mapping, is_won_stage, is_lost_stage
          ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
          RETURNING *`,
          [
            ctx.tenantId,
            pipelineId,
            String(st.stage_key || `stage_${i + 1}`).toLowerCase().replace(/[^a-z0-9_]/g, '_') || `stage_${i + 1}`,
            String(st.stage_name || `Bước ${i + 1}`),
            Number(st.stage_order ?? i + 1),
            String(st.color_hex || '#1E40FF'),
            Number(st.sla_timeout_minutes ?? 0),
            String(st.capi_event_mapping || 'Skip').trim() || 'Skip',
            Boolean(st.is_won_stage),
            Boolean(st.is_lost_stage),
          ]
        );
        insertedStages.push(sRes.rows[0]);
      }

      if (create_default_round !== false) {
        const roundRes = await client.query<{ id: string }>(
          `INSERT INTO distribution_rounds (tenant_id, pipeline_id, name, priority, is_active)
           VALUES ($1, $2, $3, 1, true)
           RETURNING id`,
          [ctx.tenantId, pipelineId, `Vòng Chia • ${String(name).trim()}`]
        );
        const activeSales = await client.query<{ id: string }>(
          `SELECT u.id FROM users u
           LEFT JOIN tenant_user_profiles p ON p.tenant_id = u.tenant_id AND p.user_id = u.id
           WHERE u.tenant_id = $1 AND u.role = 'sale' AND COALESCE(p.status, 'active') = 'active'`,
          [ctx.tenantId]
        );
        for (const s of activeSales.rows) {
          await client.query(
            `INSERT INTO round_consultants (tenant_id, round_id, user_id, receive_ratio, data_per_turn)
             VALUES ($1, $2, $3, 1, 1)
             ON CONFLICT DO NOTHING`,
            [ctx.tenantId, roundRes.rows[0].id, s.id]
          );
        }
      }

      return { ...pRes.rows[0], stages: insertedStages, custom_fields: [] };
    });

    tenantRedis.invalidateDistributionSnapshot(ctx.tenantId);
    res.status(201).json({ success: true, data: created });
  } catch (err: any) {
    sendApiError(res, 500, 'CREATE_PIPELINE_FAILED', err?.message || 'Không thể tạo Pipeline.');
  }
});

// Update Pipeline Metadata (name, description, is_default)
pipelinesRouter.patch('/:id', requirePipelineConfig, async (req, res) => {
  try {
    const ctx = getTenantContext();
    const pipelineId = req.params.id;
    const { name, description, is_default } = req.body || {};

    const updated = await withTenantTransaction(ctx.tenantId, async (client) => {
      if (is_default === true) {
        await client.query('UPDATE tenant_pipelines SET is_default = false WHERE tenant_id = $1', [ctx.tenantId]);
      }
      const r = await client.query(
        `UPDATE tenant_pipelines
         SET name = COALESCE($3, name),
             description = CASE WHEN $4::boolean THEN $5 ELSE description END,
             is_default = COALESCE($6, is_default),
             updated_at = clock_timestamp()
         WHERE tenant_id = $1 AND id = $2
         RETURNING *`,
        [
          ctx.tenantId,
          pipelineId,
          name ? String(name).trim() : null,
          description !== undefined,
          description ? String(description).trim() : null,
          typeof is_default === 'boolean' ? is_default : null,
        ]
      );
      return r.rows[0] || null;
    });

    if (!updated) {
      sendApiError(res, 404, 'PIPELINE_NOT_FOUND', 'Không tìm thấy Pipeline.');
      return;
    }

    tenantRedis.invalidateDistributionSnapshot(ctx.tenantId);
    res.json({ success: true, data: updated });
  } catch (err: any) {
    sendApiError(res, 500, 'UPDATE_PIPELINE_FAILED', err?.message || 'Không thể cập nhật Pipeline.');
  }
});

// Delete Pipeline Safely (migrating leads to remaining default pipeline)
pipelinesRouter.delete('/:id', requirePipelineConfig, async (req, res) => {
  try {
    const ctx = getTenantContext();
    const pipelineId = req.params.id;

    const out = await withTenantTransaction(ctx.tenantId, async (client) => {
      const others = await client.query<{ id: string }>(
        `SELECT id FROM tenant_pipelines
         WHERE tenant_id = $1 AND id <> $2
         ORDER BY is_default DESC, created_at ASC`,
        [ctx.tenantId, pipelineId]
      );
      if (others.rows.length === 0) {
        throw new Error('CANNOT_DELETE_LAST_PIPELINE');
      }

      const fallbackPipelineId = others.rows[0].id;
      const fallbackStage = await client.query<{
        id: string;
        sla_timeout_minutes: number;
        is_won_stage: boolean;
        is_lost_stage: boolean;
      }>(
        `SELECT id, sla_timeout_minutes, is_won_stage, is_lost_stage
         FROM tenant_pipeline_stages
         WHERE tenant_id = $1 AND pipeline_id = $2
         ORDER BY stage_order ASC LIMIT 1`,
        [ctx.tenantId, fallbackPipelineId]
      );

      const cfg = await getTenantSettingsCached(ctx.tenantId, client);

      const affectedLeads = await client.query<{ id: string; stage_id: string; is_accepted: boolean; status: string }>(
        `SELECT id, stage_id, is_accepted, status
         FROM leads
         WHERE tenant_id = $1 AND pipeline_id = $2`,
        [ctx.tenantId, pipelineId]
      );

      let migratedLeads = 0;
      const slaToRemove = affectedLeads.rows.map((l) => `${l.id}:${l.stage_id}`);
      const slaToAdd: Array<{ member: string; deadlineMs: number }> = [];

      if (fallbackStage.rows[0]?.id) {
        const fb = fallbackStage.rows[0];
        const mig = await client.query(
          `UPDATE leads
           SET pipeline_id = $3, stage_id = $4, updated_at = clock_timestamp()
           WHERE tenant_id = $1 AND pipeline_id = $2`,
          [ctx.tenantId, pipelineId, fallbackPipelineId, fb.id]
        );
        migratedLeads = mig.rowCount || 0;

        const effectiveSla =
          !fb.is_won_stage && !fb.is_lost_stage
            ? Number(fb.sla_timeout_minutes) > 0
              ? Number(fb.sla_timeout_minutes)
              : cfg.use_default_sla_fallback
                ? cfg.default_sla_minutes
                : 0
            : 0;
        if (effectiveSla > 0) {
          const deadlineMs = Date.now() + effectiveSla * 60_000;
          for (const l of affectedLeads.rows) {
            if (!l.is_accepted && l.status === 'assigned') {
              slaToAdd.push({ member: `${l.id}:${fb.id}`, deadlineMs });
            }
          }
        }
      }

      await client.query('DELETE FROM tenant_pipelines WHERE tenant_id = $1 AND id = $2', [
        ctx.tenantId,
        pipelineId,
      ]);

      // Ensure at least one default pipeline exists
      await client.query(
        `UPDATE tenant_pipelines SET is_default = true
         WHERE tenant_id = $1 AND id = $2
           AND NOT EXISTS (SELECT 1 FROM tenant_pipelines WHERE tenant_id = $1 AND is_default = true)`,
        [ctx.tenantId, fallbackPipelineId]
      );

      return {
        payload: {
          deleted_pipeline_id: pipelineId,
          fallback_pipeline_id: fallbackPipelineId,
          migrated_leads: migratedLeads,
        },
        slaToRemove,
        slaToAdd,
      };
    });

    for (const m of out.slaToRemove) {
      await tenantRedis.zrem('sla_queue', m, ctx.tenantId);
    }
    for (const s of out.slaToAdd) {
      await tenantRedis.zadd('sla_queue', s.deadlineMs, s.member, ctx.tenantId);
    }

    tenantRedis.invalidateDistributionSnapshot(ctx.tenantId);
    res.json({ success: true, data: out.payload });
  } catch (err: any) {
    if (err?.message === 'CANNOT_DELETE_LAST_PIPELINE') {
      sendApiError(res, 422, 'CANNOT_DELETE_LAST_PIPELINE', 'Hệ thống cần giữ lại tối thiểu 1 Pipeline hoạt động.');
      return;
    }
    sendApiError(res, 500, 'DELETE_PIPELINE_FAILED', err?.message || 'Không thể xóa Pipeline.');
  }
});

// 4.2 Reorder & Update Pipeline Stages (Op 19)
pipelinesRouter.put('/:id/stages/reorder', requirePipelineConfig, async (req, res) => {
  try {
    const ctx = getTenantContext();
    const pipelineId = req.params.id;
    const stages = req.body?.stages;

    if (!Array.isArray(stages) || stages.length === 0) {
      sendApiError(res, 422, 'INVALID_STAGES', 'Danh sách bước Pipeline không hợp lệ.');
      return;
    }

    const updatedStages = await withTenantTransaction(ctx.tenantId, async (client) => {
      const out = [];
      for (let idx = 0; idx < stages.length; idx++) {
        const s = stages[idx];
        const cleanKey = String(s.stage_key || `stage_${idx + 1}`)
          .trim()
          .toLowerCase()
          .replace(/[^a-z0-9_]/g, '_');
        const cleanCapi = s.capi_event_mapping ? String(s.capi_event_mapping).trim() : null;

        if (s.id) {
          const r = await client.query(
            `UPDATE tenant_pipeline_stages
             SET stage_name = COALESCE($4, stage_name),
                 stage_order = $5,
                 color_hex = COALESCE($6, color_hex),
                 sla_timeout_minutes = COALESCE($7, sla_timeout_minutes),
                 capi_event_mapping = COALESCE($8, capi_event_mapping),
                 is_won_stage = COALESCE($9, is_won_stage),
                 is_lost_stage = COALESCE($10, is_lost_stage),
                 funnel_category = COALESCE($11, funnel_category),
                 score_delta = COALESCE($12, score_delta),
                 required_fields = COALESCE($13::jsonb, required_fields),
                 updated_at = clock_timestamp()
             WHERE tenant_id = $1 AND pipeline_id = $2 AND id = $3
             RETURNING *`,
            [
              ctx.tenantId,
              pipelineId,
              s.id,
              s.stage_name ? String(s.stage_name).trim() : null,
              Number(s.stage_order ?? idx + 1),
              s.color_hex || null,
              typeof s.sla_timeout_minutes === 'number' ? Math.max(0, s.sla_timeout_minutes) : null,
              cleanCapi || null,
              typeof s.is_won_stage === 'boolean' ? s.is_won_stage : null,
              typeof s.is_lost_stage === 'boolean' ? s.is_lost_stage : null,
              s.funnel_category ? String(s.funnel_category).trim() : null,
              typeof s.score_delta === 'number' ? Math.round(s.score_delta) : null,
              Array.isArray(s.required_fields) ? JSON.stringify(s.required_fields) : null,
            ]
          );
          if (r.rows[0]) out.push(r.rows[0]);
        } else {
          const r = await client.query(
            `INSERT INTO tenant_pipeline_stages (
              tenant_id, pipeline_id, stage_key, stage_name, stage_order, color_hex,
              sla_timeout_minutes, capi_event_mapping, is_won_stage, is_lost_stage
            ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
            RETURNING *`,
            [
              ctx.tenantId,
              pipelineId,
              `${cleanKey}_${Date.now().toString(36).slice(-4)}`,
              String(s.stage_name || `Bước ${idx + 1}`).trim(),
              Number(s.stage_order ?? idx + 1),
              String(s.color_hex || '#1E40FF'),
              Math.max(0, Number(s.sla_timeout_minutes || 0)),
              cleanCapi || 'Skip',
              Boolean(s.is_won_stage),
              Boolean(s.is_lost_stage),
            ]
          );
          out.push(r.rows[0]);
        }
      }
      out.sort((a, b) => a.stage_order - b.stage_order);
      return out;
    });

    tenantRedis.invalidateDistributionSnapshot(ctx.tenantId);
    res.json({ success: true, data: updatedStages });
  } catch (err: any) {
    sendApiError(res, 500, 'REORDER_STAGES_FAILED', err?.message || 'Không thể lưu thứ tự bước Pipeline.');
  }
});

// Delete a Stage from Pipeline safely (migrating existing leads to requested or first remaining stage)
pipelinesRouter.delete('/:id/stages/:stageId', requirePipelineConfig, async (req, res) => {
  try {
    const ctx = getTenantContext();
    const pipelineId = req.params.id;
    const stageId = req.params.stageId;
    const requestedFallback = String(req.query.fallback_stage_id || req.body?.fallback_stage_id || '').trim();

    const out = await withTenantTransaction(ctx.tenantId, async (client) => {
      const remaining = await client.query<{
        id: string;
        sla_timeout_minutes: number;
        is_won_stage: boolean;
        is_lost_stage: boolean;
      }>(
        `SELECT id, sla_timeout_minutes, is_won_stage, is_lost_stage
         FROM tenant_pipeline_stages
         WHERE tenant_id = $1 AND pipeline_id = $2 AND id <> $3
         ORDER BY stage_order ASC`,
        [ctx.tenantId, pipelineId, stageId]
      );
      if (remaining.rows.length === 0) {
        throw new Error('CANNOT_DELETE_LAST_STAGE');
      }
      const fbStage = remaining.rows.find((r) => r.id === requestedFallback) || remaining.rows[0];
      const validFallback = fbStage.id;

      const cfg = await getTenantSettingsCached(ctx.tenantId, client);

      const affected = await client.query<{ id: string; is_accepted: boolean; status: string }>(
        `SELECT id, is_accepted, status
         FROM leads
         WHERE tenant_id = $1 AND pipeline_id = $2 AND stage_id = $3`,
        [ctx.tenantId, pipelineId, stageId]
      );

      const migrated = await client.query(
        `UPDATE leads SET stage_id = $4, updated_at = clock_timestamp()
         WHERE tenant_id = $1 AND pipeline_id = $2 AND stage_id = $3`,
        [ctx.tenantId, pipelineId, stageId, validFallback]
      );

      await client.query(
        'DELETE FROM tenant_pipeline_stages WHERE tenant_id = $1 AND pipeline_id = $2 AND id = $3',
        [ctx.tenantId, pipelineId, stageId]
      );

      const slaToRemove = affected.rows.map((l) => `${l.id}:${stageId}`);
      const slaToAdd: Array<{ member: string; deadlineMs: number }> = [];
      const effectiveSla =
        !fbStage.is_won_stage && !fbStage.is_lost_stage
          ? Number(fbStage.sla_timeout_minutes) > 0
            ? Number(fbStage.sla_timeout_minutes)
            : cfg.use_default_sla_fallback
              ? cfg.default_sla_minutes
              : 0
          : 0;
      if (effectiveSla > 0) {
        const deadlineMs = Date.now() + effectiveSla * 60_000;
        for (const l of affected.rows) {
          if (!l.is_accepted && l.status === 'assigned') {
            slaToAdd.push({ member: `${l.id}:${validFallback}`, deadlineMs });
          }
        }
      }

      return {
        payload: {
          deleted_stage_id: stageId,
          fallback_stage_id: validFallback,
          migrated_leads: migrated.rowCount || 0,
        },
        slaToRemove,
        slaToAdd,
      };
    });

    for (const m of out.slaToRemove) {
      await tenantRedis.zrem('sla_queue', m, ctx.tenantId);
    }
    for (const s of out.slaToAdd) {
      await tenantRedis.zadd('sla_queue', s.deadlineMs, s.member, ctx.tenantId);
    }

    tenantRedis.invalidateDistributionSnapshot(ctx.tenantId);
    res.json({ success: true, data: out.payload });
  } catch (err: any) {
    if (err?.message === 'CANNOT_DELETE_LAST_STAGE') {
      sendApiError(res, 422, 'CANNOT_DELETE_LAST_STAGE', 'Pipeline phải có tối thiểu 1 bước xử lý.');
      return;
    }
    sendApiError(res, 500, 'DELETE_STAGE_FAILED', err?.message || 'Không thể xóa bước Pipeline.');
  }
});

// Add Custom Field to Pipeline (Op 19)
pipelinesRouter.post('/:id/custom-fields', requirePipelineConfig, async (req, res) => {
  try {
    const ctx = getTenantContext();
    const pipelineId = req.params.id;
    const {
      field_key,
      field_label,
      field_type = 'text',
      is_required = false,
      options_json = [],
      stage_visibility = [],
      config_json = {},
    } = req.body || {};

    if (!field_label) {
      sendApiError(res, 422, 'VALIDATION_ERROR', 'Tên trường tùy biến không được để trống.');
      return;
    }
    if (
      config_json &&
      typeof config_json === 'object' &&
      typeof (config_json as Record<string, unknown>).regex === 'string' &&
      String((config_json as Record<string, unknown>).regex).trim() &&
      !isSafeRegexPattern(String((config_json as Record<string, unknown>).regex))
    ) {
      sendApiError(res, 422, 'INVALID_CUSTOM_FIELD_REGEX', 'Biểu thức Regex kiểm tra trường tùy biến không hợp lệ hoặc không an toàn.');
      return;
    }
    const cleanKey = String(field_key || field_label)
      .trim()
      .toLowerCase()
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/đ/g, 'd')
      .replace(/[^a-z0-9_]/g, '_')
      .replace(/^_+|_+$/g, '');

    const created = await withTenantTransaction(ctx.tenantId, async (client) => {
      const r = await client.query(
        `INSERT INTO tenant_pipeline_custom_fields (
          tenant_id, pipeline_id, field_key, field_label, field_type, is_required,
          options_json, stage_visibility, config_json
        ) VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8::jsonb, $9::jsonb)
        RETURNING *`,
        [
          ctx.tenantId,
          pipelineId,
          cleanKey || `cf_${Date.now()}`,
          String(field_label).trim(),
          field_type,
          Boolean(is_required),
          JSON.stringify(Array.isArray(options_json) ? options_json : []),
          JSON.stringify(Array.isArray(stage_visibility) ? stage_visibility : []),
          JSON.stringify(config_json && typeof config_json === 'object' ? config_json : {}),
        ]
      );
      return r.rows[0];
    });

    tenantRedis.invalidateDistributionSnapshot(ctx.tenantId);
    res.status(201).json({ success: true, data: created });
  } catch (err: any) {
    sendApiError(res, 500, 'CREATE_CUSTOM_FIELD_FAILED', err?.message || 'Không thể thêm trường tùy biến.');
  }
});

// Edit Custom Field Metadata & Validation Rules
pipelinesRouter.patch('/:id/custom-fields/:fieldId', requirePipelineConfig, async (req, res) => {
  try {
    const ctx = getTenantContext();
    const { field_label, field_type, is_required, options_json, stage_visibility, config_json } = req.body || {};

    if (
      config_json &&
      typeof config_json === 'object' &&
      typeof (config_json as Record<string, unknown>).regex === 'string' &&
      String((config_json as Record<string, unknown>).regex).trim() &&
      !isSafeRegexPattern(String((config_json as Record<string, unknown>).regex))
    ) {
      sendApiError(res, 422, 'INVALID_CUSTOM_FIELD_REGEX', 'Biểu thức Regex kiểm tra trường tùy biến không hợp lệ hoặc không an toàn.');
      return;
    }

    const updated = await withTenantTransaction(ctx.tenantId, async (client) => {
      const r = await client.query(
        `UPDATE tenant_pipeline_custom_fields
         SET field_label = COALESCE($4, field_label),
             field_type = COALESCE($5, field_type),
             is_required = COALESCE($6, is_required),
             options_json = COALESCE($7::jsonb, options_json),
             stage_visibility = COALESCE($8::jsonb, stage_visibility),
             config_json = COALESCE($9::jsonb, config_json),
             updated_at = clock_timestamp()
         WHERE tenant_id = $1 AND pipeline_id = $2 AND id = $3
         RETURNING *`,
        [
          ctx.tenantId,
          req.params.id,
          req.params.fieldId,
          field_label ? String(field_label).trim() : null,
          field_type || null,
          typeof is_required === 'boolean' ? is_required : null,
          Array.isArray(options_json) ? JSON.stringify(options_json) : null,
          Array.isArray(stage_visibility) ? JSON.stringify(stage_visibility) : null,
          config_json && typeof config_json === 'object' ? JSON.stringify(config_json) : null,
        ]
      );
      return r.rows[0] || null;
    });

    if (!updated) {
      sendApiError(res, 404, 'CUSTOM_FIELD_NOT_FOUND', 'Không tìm thấy trường dữ liệu tùy biến.');
      return;
    }

    tenantRedis.invalidateDistributionSnapshot(ctx.tenantId);
    res.json({ success: true, data: updated });
  } catch (err: any) {
    sendApiError(res, 500, 'UPDATE_CUSTOM_FIELD_FAILED', err?.message || 'Không thể cập nhật trường tùy biến.');
  }
});

pipelinesRouter.delete('/:id/custom-fields/:fieldId', requirePipelineConfig, async (req, res) => {
  try {
    const ctx = getTenantContext();
    await withTenantTransaction(ctx.tenantId, async (client) => {
      await client.query(
        'DELETE FROM tenant_pipeline_custom_fields WHERE tenant_id = $1 AND pipeline_id = $2 AND id = $3',
        [ctx.tenantId, req.params.id, req.params.fieldId]
      );
    });
    tenantRedis.invalidateDistributionSnapshot(ctx.tenantId);
    res.json({ success: true, data: { deleted: true } });
  } catch (err: any) {
    sendApiError(res, 500, 'DELETE_CUSTOM_FIELD_FAILED', err?.message || 'Không thể xóa trường tùy biến.');
  }
});
