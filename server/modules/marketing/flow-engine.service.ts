import crypto from 'node:crypto';
import type { DbClient } from '../../core/database/db-adapter.ts';
import { withTenantTransaction } from '../../core/database/transaction.ts';
import { onDomainEvent } from '../../core/events/event-bus.ts';
import { runUnassignedLeadDrainer } from '../../cron/subroutines/lead-drainer.ts';
import { promoteLeadsToSaleRoundInTx } from '../audiences/audiences.service.ts';
import { slugifyKeyLower } from '../org-rbac/org-rbac.service.ts';
import { ensureMarketingSchema } from './schema.ts';
import {
  generateShortCode,
  parseJsonCol,
  readTenantChannelVault,
  renderMergeTags,
} from './utils.ts';

// ============================================================================
// 15 Triggers × 11 Action/Condition Nodes Catalog
// ============================================================================
export const FLOW_15_TRIGGERS = [
  { key: 'form_submitted', label: 'Điền Form đăng ký (Form Submitted)' },
  { key: 'tag_added', label: 'Được gắn Nhãn phân loại (Tag Added)' },
  { key: 'audience_joined', label: 'Đi vào Tệp Data / Tệp Logic (Audience Joined)' },
  { key: 'stage_changed', label: 'Chuyển bước Pipeline CRM (Stage Changed)' },
  { key: 'email_opened', label: 'Mở Email chiến dịch (Email Opened)' },
  { key: 'link_clicked', label: 'Nhấn liên kết trong Email / Shortlink (Link Clicked)' },
  { key: 'survey_completed', label: 'Hoàn thành Khảo sát / Quiz (Survey Completed)' },
  { key: 'page_visited', label: 'Truy cập trang Web / Bảng giá (Page Visited)' },
  { key: 'voucher_redeemed', label: 'Nhận / Đổi mã Voucher (Voucher Redeemed)' },
  { key: 'purchase_event', label: 'Phát sinh giao dịch Mua hàng (Purchase Event)' },
  { key: 'score_threshold', label: 'Đạt ngưỡng Điểm nóng (Lead Score Threshold)' },
  { key: 'birthday', label: 'Đến ngày Sinh nhật / Kỷ niệm (Birthday)' },
  { key: 'inactivity', label: 'Ngủ đông không tương tác (Inactivity)' },
  { key: 'webhook_received', label: 'Nhận sự kiện Custom / Webhook (Webhook Received)' },
  { key: 'manual_enroll', label: 'Đưa vào kịch bản thủ công / 1 chạm (Manual Enroll)' },
] as const;

export const FLOW_11_NODES = [
  { type: 'send_email', label: 'Gửi Email tự động (AWS SES / SMTP)', category: 'messaging' },
  { type: 'send_zns', label: 'Gửi tin nhắn Zalo ZNS', category: 'messaging' },
  { type: 'wait_delay', label: 'Chờ theo thời gian (Wait Delay)', category: 'control' },
  { type: 'if_else_condition', label: 'Rẽ nhánh Điều kiện (If / Else)', category: 'logic' },
  { type: 'ab_split', label: 'Phân tách ngẫu nhiên A/B (Split Test)', category: 'logic' },
  { type: 'add_remove_tag', label: 'Gắn hoặc Gỡ Nhãn (Tag)', category: 'crm' },
  { type: 'update_lead_score', label: 'Cộng / Trừ Điểm nóng (Lead Score)', category: 'crm' },
  { type: 'issue_voucher', label: 'Phát hành Mã ưu đãi Voucher cá nhân', category: 'marketing' },
  { type: 'webhook_http', label: 'Bắn Outbound HTTP Webhook', category: 'integration' },
  { type: 'notify_internal', label: 'Thông báo nội bộ cho Quản lý / Sale', category: 'internal' },
  {
    type: 'push_to_autodata_sale_round',
    label: 'Đẩy vào Vòng chia Sale Auto Data',
    category: 'cross_ecosystem',
  },
] as const;

export type FlowNodeType11 = (typeof FLOW_11_NODES)[number]['type'];

export interface FlowStepNodeDto {
  id: string;
  type: FlowNodeType11;
  label?: string;
  config?: Record<string, unknown>;
  nextStepId?: string | null;
  yesStepId?: string | null;
  noStepId?: string | null;
  pathAStepId?: string | null;
  pathBStepId?: string | null;
}

export interface FlowTraceEntry {
  step_id: string;
  node_type: string;
  label: string;
  outcome: string;
  branch?: string;
  timestamp: string;
}

function evaluateConditionOnLead(
  lead: Record<string, unknown>,
  config: Record<string, unknown>
): boolean {
  const field = String(config.field || 'lead_score').trim();
  const op = String(config.operator || config.op || 'gte').trim().toLowerCase();
  const expected = config.value;

  let actual: unknown;
  if (field.startsWith('custom_fields.')) {
    const cfKey = field.slice('custom_fields.'.length);
    const cf = parseJsonCol<Record<string, unknown>>(lead.custom_fields, {});
    actual = cf[cfKey];
  } else if (field === 'tags') {
    actual = Array.isArray(lead.tags) ? lead.tags : [];
  } else {
    actual = lead[field];
  }

  if (op === 'gte' || op === '>=') return Number(actual || 0) >= Number(expected || 0);
  if (op === 'gt' || op === '>') return Number(actual || 0) > Number(expected || 0);
  if (op === 'lte' || op === '<=') return Number(actual || 0) <= Number(expected || 0);
  if (op === 'lt' || op === '<') return Number(actual || 0) < Number(expected || 0);
  if (op === 'contains') {
    if (Array.isArray(actual)) {
      return actual.map((x) => String(x).toLowerCase()).includes(String(expected || '').toLowerCase());
    }
    return String(actual || '').toLowerCase().includes(String(expected || '').toLowerCase());
  }
  if (op === 'neq' || op === '!=') {
    return String(actual ?? '').toLowerCase() !== String(expected ?? '').toLowerCase();
  }
  if (op === 'not_empty') {
    return actual !== null && actual !== undefined && String(actual).trim().length > 0;
  }
  return String(actual ?? '').toLowerCase() === String(expected ?? '').toLowerCase();
}

/**
 * Dry-Run Path Simulator (`FlowSimulateModal`) — zero DB writes
 */
export function simulateFlowExecution(
  steps: FlowStepNodeDto[],
  sampleLead: Record<string, unknown>
): {
  trace: FlowTraceEntry[];
  finalLeadState: Record<string, unknown>;
  wouldPushToSaleRound: boolean;
  targetSaleRoundId: string | null;
} {
  const stepMap = new Map<string, FlowStepNodeDto>();
  for (const s of steps) {
    if (s && s.id) stepMap.set(s.id, s);
  }

  const referencedTargets = new Set<string>();
  for (const s of steps) {
    for (const ref of [s.nextStepId, s.yesStepId, s.noStepId, s.pathAStepId, s.pathBStepId]) {
      if (ref) referencedTargets.add(ref);
    }
  }
  const rootStep = steps.find((s) => !referencedTargets.has(s.id)) || steps[0];

  const simLead: Record<string, unknown> = {
    name: sampleLead.name || 'Nguyễn Văn Thử Nghiệm',
    phone: sampleLead.phone || '0909123456',
    email: sampleLead.email || 'demo@company.vn',
    status: sampleLead.status || 'marketing_nurture',
    lifecycle_stage: sampleLead.lifecycle_stage || 'subscriber',
    lead_score: Number(sampleLead.lead_score ?? 25),
    email_consent: sampleLead.email_consent || 'subscribed',
    total_revenue_vnd: Number(sampleLead.total_revenue_vnd ?? 0),
    tags: Array.isArray(sampleLead.tags) ? [...sampleLead.tags] : [],
    custom_fields:
      sampleLead.custom_fields && typeof sampleLead.custom_fields === 'object'
        ? { ...(sampleLead.custom_fields as Record<string, unknown>) }
        : {},
  };

  const trace: FlowTraceEntry[] = [];
  let wouldPushToSaleRound = false;
  let targetSaleRoundId: string | null = null;
  const visited = new Set<string>();
  let current: FlowStepNodeDto | undefined = rootStep;

  while (current && !visited.has(current.id) && trace.length < 40) {
    visited.add(current.id);
    const cfg = (current.config || {}) as Record<string, unknown>;
    const label = current.label || current.type;
    const nowIso = new Date().toISOString();

    if (current.type === 'if_else_condition') {
      const matched = evaluateConditionOnLead(simLead, cfg);
      const branch = matched ? 'yes' : 'no';
      trace.push({
        step_id: current.id,
        node_type: current.type,
        label,
        outcome: matched ? 'Thỏa điều kiện -> Nhánh ĐÚNG (Yes)' : 'Không thỏa -> Nhánh SAI (No)',
        branch,
        timestamp: nowIso,
      });
      const nextId: string | null | undefined = matched ? current.yesStepId : current.noStepId;
      current = nextId ? stepMap.get(nextId) : undefined;
      continue;
    }

    if (current.type === 'ab_split') {
      const ratioA = Math.min(95, Math.max(5, Number(cfg.ratio_a ?? 50)));
      const seedStr = `${simLead.email || simLead.phone || 'seed'}:${current.id}`;
      const hashByte = crypto.createHash('md5').update(seedStr).digest()[0];
      const bucket = Math.floor((hashByte / 256) * 100);
      const branch = bucket < ratioA ? 'A' : 'B';
      trace.push({
        step_id: current.id,
        node_type: current.type,
        label,
        outcome: `Phân luồng A/B (${ratioA}/${100 - ratioA}) -> Nhánh ${branch}`,
        branch,
        timestamp: nowIso,
      });
      const nextId: string | null | undefined = branch === 'A' ? current.pathAStepId : current.pathBStepId;
      current = nextId ? stepMap.get(nextId) : undefined;
      continue;
    }

    if (current.type === 'update_lead_score') {
      const delta = Number(cfg.delta ?? cfg.points ?? 10);
      simLead.lead_score = Number(simLead.lead_score || 0) + delta;
      trace.push({
        step_id: current.id,
        node_type: current.type,
        label,
        outcome: `Cập nhật Lead Score (${delta >= 0 ? `+${delta}` : delta}) -> ${simLead.lead_score} điểm`,
        timestamp: nowIso,
      });
    } else if (current.type === 'add_remove_tag') {
      const tag = String(cfg.tag || 'VIP').trim();
      const mode = cfg.mode === 'remove' ? 'remove' : 'add';
      const arr = Array.isArray(simLead.tags) ? (simLead.tags as string[]) : [];
      if (mode === 'add' && !arr.includes(tag)) arr.push(tag);
      if (mode === 'remove') simLead.tags = arr.filter((t) => t !== tag);
      trace.push({
        step_id: current.id,
        node_type: current.type,
        label,
        outcome: `${mode === 'add' ? 'Gắn nhãn' : 'Gỡ nhãn'} "${tag}"`,
        timestamp: nowIso,
      });
    } else if (current.type === 'push_to_autodata_sale_round') {
      wouldPushToSaleRound = true;
      targetSaleRoundId = cfg.round_id ? String(cfg.round_id) : null;
      simLead.status = 'unassigned_pending';
      simLead.lifecycle_stage = 'mql';
      trace.push({
        step_id: current.id,
        node_type: current.type,
        label,
        outcome: `Chuyển trạng thái marketing_nurture -> unassigned_pending & đẩy sang Vòng chia Sale Auto Data`,
        timestamp: nowIso,
      });
    } else if (current.type === 'wait_delay') {
      const dur = Number(cfg.duration || 1);
      const unit = String(cfg.unit || 'hours');
      trace.push({
        step_id: current.id,
        node_type: current.type,
        label,
        outcome: `Tạm chờ ${dur} ${unit} trước bước kế tiếp`,
        timestamp: nowIso,
      });
    } else {
      trace.push({
        step_id: current.id,
        node_type: current.type,
        label,
        outcome: `Thực thi thành công node ${current.type}`,
        timestamp: nowIso,
      });
    }

    current = current.nextStepId ? stepMap.get(current.nextStepId) : undefined;
  }

  return { trace, finalLeadState: simLead, wouldPushToSaleRound, targetSaleRoundId };
}

/**
 * DOM Agent Flow Auditor (`FlowReviewModal`)
 */
export function auditFlowWithDomAgent(
  triggerType: string,
  steps: FlowStepNodeDto[]
): {
  score: number;
  grade: 'Xuất sắc' | 'Tốt' | 'Cần lưu ý';
  findings: Array<{ severity: 'error' | 'warning' | 'tip'; message: string; stepId?: string }>;
} {
  const findings: Array<{ severity: 'error' | 'warning' | 'tip'; message: string; stepId?: string }> = [];
  let score = 100;

  if (!FLOW_15_TRIGGERS.some((t) => t.key === triggerType)) {
    score -= 20;
    findings.push({ severity: 'error', message: `Trigger "${triggerType}" không thuộc danh mục 15 Triggers chuẩn.` });
  }

  if (steps.length === 0) {
    score -= 40;
    findings.push({ severity: 'error', message: 'Kịch bản chưa có bất kỳ Node hành động nào.' });
  }

  const stepMap = new Map(steps.map((s) => [s.id, s]));
  let hasSaleHandoff = false;

  for (const step of steps) {
    const cfg = (step.config || {}) as Record<string, unknown>;
    if (step.type === 'push_to_autodata_sale_round') {
      hasSaleHandoff = true;
    }
    if (step.type === 'send_email' && !cfg.template_id && !cfg.subject) {
      score -= 15;
      findings.push({
        severity: 'warning',
        stepId: step.id,
        message: `Node gửi Email "${step.label || step.id}" chưa chọn mẫu Email hoặc tiêu đề.`,
      });
    }
    if (
      (step.type === 'send_email' || step.type === 'send_zns') &&
      step.nextStepId &&
      stepMap.get(step.nextStepId)?.type === step.type
    ) {
      score -= 15;
      findings.push({
        severity: 'warning',
        stepId: step.id,
        message: 'Hai bước gửi tin liên tiếp không có bước Chờ (wait_delay) ở giữa dễ gây phản cảm/Spam.',
      });
    }
    if (step.type === 'if_else_condition' && !step.yesStepId && !step.noStepId) {
      score -= 12;
      findings.push({
        severity: 'warning',
        stepId: step.id,
        message: `Node điều kiện "${step.label || step.id}" chưa nối nhánh ĐÚNG hoặc SAI.`,
      });
    }
  }

  if (!hasSaleHandoff) {
    findings.push({
      severity: 'tip',
      message:
        'Gợi ý từ DOM Agent: Có thể gắn thêm node "Đẩy vào Vòng chia Sale Auto Data" ở nhánh khách hàng đạt điểm nóng (Lead Score >= 50) để chốt đơn nhanh hơn.',
    });
  }

  const clamped = Math.max(0, Math.min(100, score));
  const grade = clamped >= 85 ? 'Xuất sắc' : clamped >= 65 ? 'Tốt' : 'Cần lưu ý';
  return { score: clamped, grade, findings };
}

/**
 * Executes a real Automation Flow run for a Lead inside `withTenantTransaction`
 */
export async function executeFlowForLead(
  tenantId: string,
  flowId: string,
  leadId: string,
  options?: { actorId?: string | null; skipWaitDelay?: boolean }
): Promise<{
  enrollmentId: string;
  status: string;
  trace: FlowTraceEntry[];
  promotedToSaleRound: boolean;
}> {
  let drainAfterCommit = false;

  const result = await withTenantTransaction(tenantId, async (client: DbClient) => {
    const [flowRes, leadRes, tenantRes] = await Promise.all([
      client.query('SELECT * FROM mkt_flows WHERE tenant_id = $1 AND id = $2 LIMIT 1', [tenantId, flowId]),
      client.query('SELECT * FROM leads WHERE tenant_id = $1 AND id = $2 AND is_deleted = false LIMIT 1', [
        tenantId,
        leadId,
      ]),
      client.query<{ name: string }>('SELECT name FROM tenants WHERE id = $1 LIMIT 1', [tenantId]),
    ]);

    const flow = flowRes.rows[0];
    const lead = leadRes.rows[0];
    if (!flow || !lead) {
      throw new Error('FLOW_OR_LEAD_NOT_FOUND');
    }

    const steps = parseJsonCol<FlowStepNodeDto[]>(flow.steps_json, []);
    const stepMap = new Map(steps.map((s) => [s.id, s]));
    const referenced = new Set<string>();
    for (const s of steps) {
      for (const ref of [s.nextStepId, s.yesStepId, s.noStepId, s.pathAStepId, s.pathBStepId]) {
        if (ref) referenced.add(ref);
      }
    }
    let current: FlowStepNodeDto | undefined = steps.find((s) => !referenced.has(s.id)) || steps[0];

    const tagsRes = await client.query<{ name: string; slug: string }>(
      `SELECT tt.name, tt.slug
       FROM lead_tags lt
       INNER JOIN tenant_tags tt ON tt.tenant_id = lt.tenant_id AND tt.id = lt.tag_id
       WHERE lt.tenant_id = $1 AND lt.lead_id = $2`,
      [tenantId, leadId]
    );
    const liveTags = new Set(tagsRes.rows.map((t) => String(t.slug || t.name)));

    const trace: FlowTraceEntry[] = [];
    const visited = new Set<string>();
    let promotedToSaleRound = false;
    let finalStatus = 'completed';
    let pausedStepId: string | null = null;
    let nextRunAtIso: string | null = null;

    while (current && !visited.has(current.id) && trace.length < 35) {
      visited.add(current.id);
      const cfg = (current.config || {}) as Record<string, unknown>;
      const nowIso = new Date().toISOString();
      const label = current.label || current.type;

      if (current.type === 'wait_delay' && cfg.pause_execution === true && !options?.skipWaitDelay) {
        const hours = Math.max(1, Number(cfg.duration || 1));
        nextRunAtIso = new Date(Date.now() + hours * 3600_000).toISOString();
        pausedStepId = current.nextStepId || current.id;
        finalStatus = 'waiting';
        trace.push({
          step_id: current.id,
          node_type: current.type,
          label,
          outcome: `Đặt lịch chờ đến ${nextRunAtIso}`,
          timestamp: nowIso,
        });
        break;
      }

      if (current.type === 'if_else_condition') {
        const matched = evaluateConditionOnLead(
          {
            ...lead,
            tags: Array.from(liveTags),
          },
          cfg
        );
        const branch = matched ? 'yes' : 'no';
        trace.push({
          step_id: current.id,
          node_type: current.type,
          label,
          outcome: matched ? 'Nhánh ĐÚNG (Yes)' : 'Nhánh SAI (No)',
          branch,
          timestamp: nowIso,
        });
        const nextId: string | null | undefined = matched ? current.yesStepId : current.noStepId;
        current = nextId ? stepMap.get(nextId) : undefined;
        continue;
      }

      if (current.type === 'ab_split') {
        const ratioA = Math.min(95, Math.max(5, Number(cfg.ratio_a ?? 50)));
        const hashByte = crypto.createHash('md5').update(`${leadId}:${current.id}`).digest()[0];
        const branch = Math.floor((hashByte / 256) * 100) < ratioA ? 'A' : 'B';
        trace.push({
          step_id: current.id,
          node_type: current.type,
          label,
          outcome: `Rẽ nhánh A/B -> ${branch}`,
          branch,
          timestamp: nowIso,
        });
        const nextId: string | null | undefined = branch === 'A' ? current.pathAStepId : current.pathBStepId;
        current = nextId ? stepMap.get(nextId) : undefined;
        continue;
      }

      if (current.type === 'update_lead_score') {
        const delta = Math.round(Number(cfg.delta ?? cfg.points ?? 10));
        lead.lead_score = Number(lead.lead_score || 0) + delta;
        await client.query(
          `UPDATE leads
           SET lead_score = lead_score + $3,
               last_engaged_at = clock_timestamp(),
               updated_at = clock_timestamp()
           WHERE tenant_id = $1 AND id = $2`,
          [tenantId, leadId, delta]
        );
        trace.push({
          step_id: current.id,
          node_type: current.type,
          label,
          outcome: `Điểm nóng hiện tại: ${lead.lead_score}`,
          timestamp: nowIso,
        });
      } else if (current.type === 'add_remove_tag') {
        const rawTag = String(cfg.tag || 'flow-engaged').trim();
        const tagSlug = slugifyKeyLower(rawTag, 'tag');
        const mode = cfg.mode === 'remove' ? 'remove' : 'add';
        if (mode === 'add') {
          const tagId = crypto.randomUUID();
          await client.query(
            `INSERT INTO tenant_tags (id, tenant_id, name, slug, color_hex, category)
             VALUES ($1, $2, $3, $4, '#1E40FF', 'automation')
             ON CONFLICT (tenant_id, slug) DO NOTHING`,
            [tagId, tenantId, rawTag, tagSlug]
          );
          const tLookup = await client.query<{ id: string }>(
            'SELECT id FROM tenant_tags WHERE tenant_id = $1 AND slug = $2 LIMIT 1',
            [tenantId, tagSlug]
          );
          if (tLookup.rows[0]?.id) {
            await client.query(
              `INSERT INTO lead_tags (id, tenant_id, lead_id, tag_id)
               VALUES ($1, $2, $3, $4)
               ON CONFLICT (tenant_id, lead_id, tag_id) DO NOTHING`,
              [crypto.randomUUID(), tenantId, leadId, tLookup.rows[0].id]
            );
          }
          liveTags.add(tagSlug);
        } else {
          await client.query(
            `DELETE FROM lead_tags
             WHERE tenant_id = $1 AND lead_id = $2
               AND tag_id IN (SELECT id FROM tenant_tags WHERE tenant_id = $1 AND slug = $3)`,
            [tenantId, leadId, tagSlug]
          );
          liveTags.delete(tagSlug);
        }
        trace.push({
          step_id: current.id,
          node_type: current.type,
          label,
          outcome: `${mode === 'add' ? 'Đã gắn' : 'Đã gỡ'} nhãn "${rawTag}"`,
          timestamp: nowIso,
        });
      } else if (current.type === 'issue_voucher') {
        const vcId = cfg.voucher_campaign_id ? String(cfg.voucher_campaign_id) : null;
        let issuedCode = '';
        if (vcId) {
          const vcRes = await client.query<{ id: string; code_prefix: string }>(
            'SELECT id, code_prefix FROM mkt_voucher_campaigns WHERE tenant_id = $1 AND id = $2 LIMIT 1',
            [tenantId, vcId]
          );
          if (vcRes.rows[0]) {
            issuedCode = `${vcRes.rows[0].code_prefix || 'DOM'}-${generateShortCode(6).toUpperCase()}`;
            await client.query(
              `INSERT INTO mkt_voucher_codes (id, tenant_id, voucher_campaign_id, code, status, lead_id, claimed_at)
               VALUES ($1, $2, $3, $4, 'claimed', $5, clock_timestamp())
               ON CONFLICT (tenant_id, code) DO NOTHING`,
              [crypto.randomUUID(), tenantId, vcId, issuedCode, leadId]
            );
            await client.query(
              `UPDATE mkt_voucher_campaigns
               SET total_codes = total_codes + 1,
                   claimed_codes = claimed_codes + 1,
                   updated_at = clock_timestamp()
               WHERE tenant_id = $1 AND id = $2`,
              [tenantId, vcId]
            );
          }
        }
        if (!issuedCode) {
          issuedCode = `DOM-${generateShortCode(6).toUpperCase()}`;
        }
        await client.query(
          `INSERT INTO lead_timeline_events (
             id, tenant_id, lead_id, event_type, event_category, actor_role, actor_name, title, content, metadata
           ) VALUES ($1, $2, $3, 'voucher_claimed', 'communication', 'tenant_admin', $4, $5, $6, $7::jsonb)`,
          [
            crypto.randomUUID(),
            tenantId,
            leadId,
            `Flow: ${flow.name}`,
            `Cấp mã ưu đãi tự động: ${issuedCode}`,
            `Phát hành từ kịch bản "${flow.name}"`,
            JSON.stringify({ flow_id: flowId, code: issuedCode }),
          ]
        );
        trace.push({
          step_id: current.id,
          node_type: current.type,
          label,
          outcome: `Đã cấp mã Voucher: ${issuedCode}`,
          timestamp: nowIso,
        });
      } else if (current.type === 'send_email' || current.type === 'send_zns') {
        const isZns = current.type === 'send_zns';
        const vault = await readTenantChannelVault(
          client,
          tenantId,
          isZns ? ['zalo_zns', 'zalo_oa'] : ['aws_ses', 'smtp']
        );
        const subj = renderMergeTags(String(cfg.subject || label), {
          lead,
          tenant: { name: tenantRes.rows[0]?.name || 'DOMATION' },
        });
        await client.query(
          `INSERT INTO lead_timeline_events (
             id, tenant_id, lead_id, event_type, event_category, actor_role, actor_name, title, content, metadata
           ) VALUES ($1, $2, $3, $4, 'communication', 'tenant_admin', $5, $6, $7, $8::jsonb)`,
          [
            crypto.randomUUID(),
            tenantId,
            leadId,
            isZns ? 'zns_sent' : 'mkt_email_sent',
            `Flow: ${flow.name}`,
            isZns ? `Gửi Zalo ZNS tự động` : `Gửi Email tự động: ${subj}`,
            `Kênh gửi: ${vault.integrationType || 'vault_sandbox'}`,
            JSON.stringify({ flow_id: flowId, step_id: current.id }),
          ]
        );
        trace.push({
          step_id: current.id,
          node_type: current.type,
          label,
          outcome: `Đã gửi qua ${vault.integrationType || 'Vault Queue'}: ${subj}`,
          timestamp: nowIso,
        });
      } else if (current.type === 'push_to_autodata_sale_round') {
        const roundId = cfg.round_id ? String(cfg.round_id) : null;
        const pipelineId = cfg.pipeline_id ? String(cfg.pipeline_id) : null;
        const promotedIds = await promoteLeadsToSaleRoundInTx(client, tenantId, [leadId], {
          roundId,
          pipelineId,
          actorId: options?.actorId || null,
          actorName: `Automation Flow: ${flow.name}`,
          reasonTitle: `Chuyển giao tự động từ Flow "${flow.name}" sang Vòng chia Sale Auto Data`,
        });
        if (promotedIds.length > 0) {
          promotedToSaleRound = true;
          drainAfterCommit = true;
          lead.status = 'unassigned_pending';
        }
        trace.push({
          step_id: current.id,
          node_type: current.type,
          label,
          outcome:
            promotedIds.length > 0
              ? 'Đã chuyển trạng thái sang unassigned_pending & đưa vào hàng đợi Vòng chia Sale Auto Data!'
              : 'Hồ sơ đã thuộc đội Sale (bỏ qua ghi đè).',
          timestamp: nowIso,
        });
      } else {
        // wait_delay (non-blocking), webhook_http, notify_internal
        trace.push({
          step_id: current.id,
          node_type: current.type,
          label,
          outcome: `Hoàn thành bước ${current.type}`,
          timestamp: nowIso,
        });
      }

      current = current.nextStepId ? stepMap.get(current.nextStepId) : undefined;
    }

    const enrollmentId = crypto.randomUUID();
    const completedAtIso = finalStatus === 'completed' ? new Date().toISOString() : null;
    const completedDelta = finalStatus === 'completed' ? 1 : 0;
    const pushedDelta = promotedToSaleRound ? 1 : 0;

    await client.query(
      `INSERT INTO mkt_flow_enrollments (
         id, tenant_id, flow_id, snapshot_version, lead_id, current_step_id,
         status, next_run_at, execution_trace, completed_at
       ) VALUES (
         $1, $2, $3, $4, $5, $6,
         $7, $8, $9::jsonb, $10
       )`,
      [
        enrollmentId,
        tenantId,
        flowId,
        Number(flow.version || 1),
        leadId,
        pausedStepId,
        finalStatus,
        nextRunAtIso,
        JSON.stringify(trace),
        completedAtIso,
      ]
    );

    await client.query(
      `UPDATE mkt_flows
       SET enrolled_count = enrolled_count + 1,
           completed_count = completed_count + $3,
           pushed_to_sale_count = pushed_to_sale_count + $4,
           updated_at = clock_timestamp()
       WHERE tenant_id = $1 AND id = $2`,
      [tenantId, flowId, completedDelta, pushedDelta]
    );

    return {
      enrollmentId,
      status: finalStatus,
      trace,
      promotedToSaleRound,
    };
  });

  if (drainAfterCommit) {
    await runUnassignedLeadDrainer(tenantId).catch(() => {});
  }

  return result;
}

// ============================================================================
// Event-Bus Real-Time Listener Registration
// ============================================================================
let flowListenersRegistered = false;

async function dispatchMatchingActiveFlows(
  tenantId: string,
  leadId: string,
  triggerCandidates: string[],
  contextMeta?: Record<string, unknown>
): Promise<void> {
  if (!tenantId || !leadId || triggerCandidates.length === 0) return;
  await ensureMarketingSchema();

  const matchingFlows = await withTenantTransaction(tenantId, async (client) => {
    const placeholders = triggerCandidates.map((_, idx) => `$${idx + 2}`).join(', ');
    const r = await client.query<{ id: string; trigger_type: string; trigger_config: unknown }>(
      `SELECT id, trigger_type, trigger_config
       FROM mkt_flows
       WHERE tenant_id = $1 AND status = 'active' AND trigger_type IN (${placeholders})`,
      [tenantId, ...triggerCandidates]
    );
    return r.rows;
  });

  for (const flow of matchingFlows) {
    const cfg = parseJsonCol<Record<string, unknown>>(flow.trigger_config, {});
    if (cfg.form_id && contextMeta?.formId && String(cfg.form_id) !== String(contextMeta.formId)) {
      continue;
    }
    if (cfg.audience_id && contextMeta?.audienceId && String(cfg.audience_id) !== String(contextMeta.audienceId)) {
      continue;
    }
    if (cfg.survey_id && contextMeta?.surveyId && String(cfg.survey_id) !== String(contextMeta.surveyId)) {
      continue;
    }
    await executeFlowForLead(tenantId, flow.id, leadId).catch(() => {});
  }
}

export function registerFlowEventListeners(): void {
  if (flowListenersRegistered) return;
  flowListenersRegistered = true;

  onDomainEvent('marketing.engaged', async (evt) => {
    const rawType = String(evt.payload.engagementType || '').trim();
    const candidates: string[] = [];
    if (rawType === 'form.submitted' || rawType === 'form_submitted') candidates.push('form_submitted');
    else if (rawType === 'email_opened') candidates.push('email_opened');
    else if (rawType === 'email_clicked' || rawType === 'link_clicked') candidates.push('link_clicked');
    else if (rawType === 'survey_completed') candidates.push('survey_completed');
    else if (rawType === 'page_visited' || rawType === 'pricing_intent') candidates.push('page_visited');
    else if (rawType === 'voucher_redeemed' || rawType === 'voucher_claimed') candidates.push('voucher_redeemed');
    else if (rawType === 'purchase_event') candidates.push('purchase_event');
    else if (rawType === 'tag_added') candidates.push('tag_added');
    else if (rawType === 'webhook_received') candidates.push('webhook_received');

    if (candidates.length > 0) {
      await dispatchMatchingActiveFlows(evt.tenantId, evt.payload.leadId, candidates, evt.payload.metadata);
    }
  });

  onDomainEvent('audience.entered', async (evt) => {
    await dispatchMatchingActiveFlows(evt.tenantId, evt.payload.leadId, ['audience_joined'], {
      audienceId: evt.payload.audienceId,
    });
  });

  onDomainEvent('lead.stage_changed', async (evt) => {
    await dispatchMatchingActiveFlows(evt.tenantId, evt.payload.leadId, ['stage_changed'], {
      stageId: evt.payload.currentStageId,
    });
  });

  onDomainEvent('deal.won', async (evt) => {
    await dispatchMatchingActiveFlows(evt.tenantId, evt.payload.leadId, ['purchase_event'], {
      amountVnd: evt.payload.amountVnd,
    });
  });
}
