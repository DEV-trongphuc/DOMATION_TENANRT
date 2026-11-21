import crypto from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';
import type { DbClient } from '../../core/database/db-adapter.ts';
import { withTenantTransaction } from '../../core/database/transaction.ts';
import { tenantRedis } from '../../core/cache/tenant-redis.ts';
import { getTenantSettingsCached } from '../../core/settings/tenant-cache.ts';
import { validateAndNormalizePhone } from '../../services/phone.service.ts';
import { runUnassignedLeadDrainer } from '../../cron/subroutines/lead-drainer.ts';
import {
  emitDomainEvent,
  onDomainEvent,
} from '../../core/events/event-bus.ts';
import { compileSegmentWhereSql } from './segment-compiler.ts';

function isPlainJsonObject(val: unknown): val is Record<string, unknown> {
  return typeof val === 'object' && val !== null && !Array.isArray(val);
}

export function deepMergeJsonObjects(
  base: Record<string, unknown>,
  incoming: Record<string, unknown>,
  depth = 0
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...base };
  for (const [key, val] of Object.entries(incoming)) {
    if (val === undefined) continue;
    if (depth < 16 && isPlainJsonObject(val) && isPlainJsonObject(out[key])) {
      out[key] = deepMergeJsonObjects(out[key] as Record<string, unknown>, val, depth + 1);
    } else {
      out[key] = val;
    }
  }
  return out;
}

export interface EvaluateAudienceResult {
  audience_id: string;
  entered_lead_ids: string[];
  exited_lead_ids: string[];
  entered_count: number;
  exited_count: number;
  total_count: number;
  pushed_to_sale_count: number;
}

export async function refreshAudienceCachedCount(
  client: DbClient,
  tenantId: string,
  audienceId: string
): Promise<number> {
  const cntRes = await client.query<{ cnt: number }>(
    `SELECT COUNT(*)::int AS cnt
     FROM tenant_audience_members tam
     INNER JOIN leads l ON l.tenant_id = tam.tenant_id AND l.id = tam.lead_id
     WHERE tam.tenant_id = $1 AND tam.audience_id = $2 AND l.is_deleted = false`,
    [tenantId, audienceId]
  );
  const cnt = Number(cntRes.rows[0]?.cnt || 0);
  await client.query(
    `UPDATE tenant_audiences
     SET cached_member_count = $3,
         updated_at = clock_timestamp()
     WHERE tenant_id = $1 AND id = $2`,
    [tenantId, audienceId, cnt]
  );
  return cnt;
}

/**
 * Promotes `marketing_nurture` (or unassigned) contacts into `unassigned_pending`
 * with valid `pipeline_id`, `stage_id`, and optional `round_id` so Fair-Share Sale routing picks them up.
 */
export async function promoteLeadsToSaleRoundInTx(
  client: DbClient,
  tenantId: string,
  leadIds: string[],
  options?: {
    roundId?: string | null;
    pipelineId?: string | null;
    actorId?: string | null;
    actorName?: string;
    reasonTitle?: string;
  }
): Promise<string[]> {
  if (!leadIds || leadIds.length === 0) return [];

  // Resolve target round & pipeline
  let targetRoundId = options?.roundId || null;
  let targetPipelineId = options?.pipelineId || null;

  if (targetRoundId) {
    const rRes = await client.query<{ id: string; pipeline_id: string }>(
      'SELECT id, pipeline_id FROM distribution_rounds WHERE tenant_id = $1 AND id = $2 LIMIT 1',
      [tenantId, targetRoundId]
    );
    if (rRes.rows[0]) {
      targetPipelineId = targetPipelineId || rRes.rows[0].pipeline_id;
    } else {
      targetRoundId = null;
    }
  }

  if (!targetPipelineId) {
    const pRes = await client.query<{ id: string }>(
      'SELECT id FROM tenant_pipelines WHERE tenant_id = $1 ORDER BY is_default DESC, created_at ASC LIMIT 1',
      [tenantId]
    );
    targetPipelineId = pRes.rows[0]?.id || null;
  }

  let firstStageId: string | null = null;
  if (targetPipelineId) {
    const sRes = await client.query<{ id: string }>(
      `SELECT id FROM tenant_pipeline_stages
       WHERE tenant_id = $1 AND pipeline_id = $2
       ORDER BY stage_order ASC
       LIMIT 1`,
      [tenantId, targetPipelineId]
    );
    firstStageId = sRes.rows[0]?.id || null;
  }

  if (!targetRoundId && targetPipelineId) {
    const defRound = await client.query<{ id: string }>(
      `SELECT id FROM distribution_rounds
       WHERE tenant_id = $1 AND pipeline_id = $2 AND is_active = true
       ORDER BY priority ASC
       LIMIT 1`,
      [tenantId, targetPipelineId]
    );
    targetRoundId = defRound.rows[0]?.id || null;
  }

  const promotedIds: string[] = [];
  for (const lid of leadIds) {
    const curRes = await client.query<{
      id: string;
      status: string;
      assigned_to: string | null;
      pipeline_id: string | null;
      stage_id: string | null;
    }>(
      'SELECT id, status, assigned_to, pipeline_id, stage_id FROM leads WHERE tenant_id = $1 AND id = $2 AND is_deleted = false LIMIT 1',
      [tenantId, lid]
    );
    const cur = curRes.rows[0];
    if (!cur) continue;
    // Only promote contacts that are in `marketing_nurture` (never overwrite already-assigned Sale leads!)
    if (cur.status !== 'marketing_nurture' && cur.assigned_to) continue;
    if (cur.status !== 'marketing_nurture' && cur.status !== 'unassigned_pending') continue;

    await client.query(
      `UPDATE leads
       SET status = 'unassigned_pending',
           lifecycle_stage = CASE WHEN lifecycle_stage IN ('subscriber', 'lead') THEN 'mql' ELSE lifecycle_stage END,
           pipeline_id = COALESCE(pipeline_id, $3),
           stage_id = COALESCE(stage_id, $4),
           round_id = COALESCE($5, round_id),
           updated_at = clock_timestamp()
       WHERE tenant_id = $1 AND id = $2`,
      [tenantId, lid, targetPipelineId, firstStageId, targetRoundId]
    );

    if (cur.status === 'marketing_nurture') {
      promotedIds.push(lid);
      await client.query(
        `INSERT INTO lead_timeline_events (
           id, tenant_id, lead_id, event_type, event_category, actor_id, actor_role, actor_name, title, content, metadata
         ) VALUES ($1, $2, $3, 'pushed_to_sale_round', 'pipeline', $4, 'tenant_admin', $5, $6, $7, $8::jsonb)`,
        [
          crypto.randomUUID(),
          tenantId,
          lid,
          options?.actorId || null,
          options?.actorName || 'Audience Engine',
          options?.reasonTitle || 'Chuyển giao từ Tệp Marketing sang Vòng chia Sale',
          'Hồ sơ đạt điều kiện chuyển giao sang đội Kinh doanh (Fair-Share Queue).',
          JSON.stringify({ round_id: targetRoundId, pipeline_id: targetPipelineId }),
        ]
      );
    }
  }

  return promotedIds;
}

/**
 * Evaluates a `dynamic_logic` ("Tệp Logic") audience, materializes membership diff
 * (`entered` vs `exited`), promotes `marketing_nurture` contacts if `auto_push_to_sale_round = true`,
 * and dispatches `audience.entered` / `audience.exited` domain events.
 */
export async function evaluateDynamicAudience(
  tenantId: string,
  audienceId: string
): Promise<EvaluateAudienceResult> {
  const txOutcome = await withTenantTransaction(tenantId, async (client) => {
    const audRes = await client.query<{
      id: string;
      name: string;
      audience_type: string;
      filter_branches: unknown;
      auto_push_to_sale_round: boolean;
      target_round_id: string | null;
      is_active: boolean;
    }>(
      `SELECT id, name, audience_type, filter_branches, auto_push_to_sale_round, target_round_id, is_active
       FROM tenant_audiences
       WHERE tenant_id = $1 AND id = $2
       LIMIT 1`,
      [tenantId, audienceId]
    );
    const aud = audRes.rows[0];
    if (!aud) {
      throw new Error('AUDIENCE_NOT_FOUND');
    }

    if (aud.audience_type !== 'dynamic_logic') {
      const cnt = await refreshAudienceCachedCount(client, tenantId, audienceId);
      return {
        aud,
        enteredIds: [] as string[],
        exitedIds: [] as string[],
        totalCount: cnt,
        pushedIds: [] as string[],
      };
    }

    const compiled = compileSegmentWhereSql(tenantId, aud.filter_branches, {
      audienceIdForExclusions: audienceId,
      startParamIndex: 1,
    });

    const [matchedRes, currentMembersRes] = await Promise.all([
      client.query<{ id: string }>(
        `SELECT l.id
         FROM leads l
         LEFT JOIN tenant_pipeline_stages s ON s.tenant_id = l.tenant_id AND s.id = l.stage_id
         WHERE ${compiled.whereClause}`,
        compiled.params
      ),
      client.query<{ lead_id: string }>(
        'SELECT lead_id FROM tenant_audience_members WHERE tenant_id = $1 AND audience_id = $2',
        [tenantId, audienceId]
      ),
    ]);

    const matchedSet = new Set(matchedRes.rows.map((r) => r.id));
    const existingSet = new Set(currentMembersRes.rows.map((r) => r.lead_id));

    const enteredIds: string[] = [];
    for (const id of matchedSet) {
      if (!existingSet.has(id)) enteredIds.push(id);
    }

    const exitedIds: string[] = [];
    for (const id of existingSet) {
      if (!matchedSet.has(id)) exitedIds.push(id);
    }

    for (const lid of enteredIds) {
      await client.query(
        `INSERT INTO tenant_audience_members (id, tenant_id, audience_id, lead_id, source_type, metadata)
         VALUES ($1, $2, $3, $4, 'rule_engine', '{}'::jsonb)
         ON CONFLICT (tenant_id, audience_id, lead_id) DO NOTHING`,
        [crypto.randomUUID(), tenantId, audienceId, lid]
      );
    }

    for (const lid of exitedIds) {
      await client.query(
        'DELETE FROM tenant_audience_members WHERE tenant_id = $1 AND audience_id = $2 AND lead_id = $3',
        [tenantId, audienceId, lid]
      );
    }

    let pushedIds: string[] = [];
    if (aud.auto_push_to_sale_round && enteredIds.length > 0) {
      pushedIds = await promoteLeadsToSaleRoundInTx(client, tenantId, enteredIds, {
        roundId: aud.target_round_id,
        actorName: `Tệp Logic: ${aud.name}`,
        reasonTitle: `Tự động đẩy vào Vòng chia Sale từ Tệp Logic "${aud.name}"`,
      });
    }

    const totalCount = matchedSet.size;
    await client.query(
      `UPDATE tenant_audiences
       SET cached_member_count = $3,
           last_evaluated_at = clock_timestamp(),
           updated_at = clock_timestamp()
       WHERE tenant_id = $1 AND id = $2`,
      [tenantId, audienceId, totalCount]
    );

    return {
      aud,
      enteredIds,
      exitedIds,
      totalCount,
      pushedIds,
    };
  });

  // Trigger immediate Fair-Share draining if any nurture contacts were promoted
  if (txOutcome.pushedIds.length > 0) {
    await runUnassignedLeadDrainer(tenantId).catch(() => {});
  }

  // Emit `audience.entered` and `audience.exited` events outside DB lock
  const pushedSet = new Set(txOutcome.pushedIds);
  for (const lid of txOutcome.enteredIds) {
    await emitDomainEvent('audience.entered', {
      tenantId,
      audienceId: txOutcome.aud.id,
      audienceName: txOutcome.aud.name,
      audienceType: txOutcome.aud.audience_type,
      leadId: lid,
      pushedToSaleRound: pushedSet.has(lid),
    });
  }

  for (const lid of txOutcome.exitedIds) {
    await emitDomainEvent('audience.exited', {
      tenantId,
      audienceId: txOutcome.aud.id,
      audienceName: txOutcome.aud.name,
      audienceType: txOutcome.aud.audience_type,
      leadId: lid,
    });
  }

  return {
    audience_id: audienceId,
    entered_lead_ids: txOutcome.enteredIds,
    exited_lead_ids: txOutcome.exitedIds,
    entered_count: txOutcome.enteredIds.length,
    exited_count: txOutcome.exitedIds.length,
    total_count: txOutcome.totalCount,
    pushed_to_sale_count: txOutcome.pushedIds.length,
  };
}

const inFlightTenantDynamicEval = new Map<string, { promise: Promise<void>; rerun: boolean }>();
const dynamicEvalContext = new AsyncLocalStorage<Set<string>>();
const MAX_DYNAMIC_REEVAL_PASSES = 5;

export async function evaluateAllDynamicAudiencesForTenant(tenantId: string): Promise<void> {
  if (!tenantId) return;

  // Fast-skip when tenant is known to have 0 active `dynamic_logic` audiences (0 DB checkouts)
  const cachedCount = tenantRedis.getCachedDynamicAudienceCount(tenantId);
  if (cachedCount === 0) {
    return;
  }

  // Re-entrant call inside an active `evaluateAllDynamicAudiencesForTenant(tenantId)` call chain
  // (e.g. `audience.entered` -> flow `add_remove_tag` -> `marketing.engaged` -> re-eval):
  // request a trailing pass and return immediately instead of awaiting our own promise (prevents deadlock).
  const activeChainTenants = dynamicEvalContext.getStore();
  if (activeChainTenants?.has(tenantId)) {
    const active = inFlightTenantDynamicEval.get(tenantId);
    if (active) {
      active.rerun = true;
    }
    return;
  }

  const existingInFlight = inFlightTenantDynamicEval.get(tenantId);
  if (existingInFlight) {
    existingInFlight.rerun = true;
    await existingInFlight.promise;
    return;
  }

  const nextChainTenants = new Set<string>(activeChainTenants || []);
  nextChainTenants.add(tenantId);

  const state = { promise: Promise.resolve(), rerun: false };
  const runner = dynamicEvalContext.run(nextChainTenants, async () => {
    try {
      let pass = 0;
      do {
        state.rerun = false;
        pass++;
        const dynamicIds = await withTenantTransaction(tenantId, async (client) => {
          const r = await client.query<{ id: string }>(
            `SELECT id FROM tenant_audiences
             WHERE tenant_id = $1 AND audience_type = 'dynamic_logic' AND is_active = true`,
            [tenantId]
          );
          return r.rows.map((x) => x.id);
        });

        tenantRedis.setCachedDynamicAudienceCount(tenantId, dynamicIds.length, 60);
        if (dynamicIds.length === 0) {
          break;
        }

        for (const audId of dynamicIds) {
          await evaluateDynamicAudience(tenantId, audId);
        }
      } while (state.rerun && pass < MAX_DYNAMIC_REEVAL_PASSES);
    } finally {
      inFlightTenantDynamicEval.delete(tenantId);
    }
  });

  state.promise = runner;
  inFlightTenantDynamicEval.set(tenantId, state);
  await runner;
}

let listenersRegistered = false;

export function registerAudienceEventListeners(): void {
  if (listenersRegistered) return;
  listenersRegistered = true;

  const triggerReeval = async (evt: { tenantId: string }) => {
    await evaluateAllDynamicAudiencesForTenant(evt.tenantId);
  };

  onDomainEvent('lead.created', triggerReeval);
  onDomainEvent('lead.updated', triggerReeval);
  onDomainEvent('lead.stage_changed', async (evt) => {
    // Coalesce when `deal.won` will immediately follow in the same stage transition
    if (evt.payload.willEmitDealWon) return;
    await evaluateAllDynamicAudiencesForTenant(evt.tenantId);
  });
  onDomainEvent('marketing.engaged', triggerReeval);
  onDomainEvent('deal.won', triggerReeval);
}

/**
 * RFC-4180 Compliant CSV Parser supporting Vietnamese headers & quoted commas/newlines
 */
export function parseCsvTextToRows(csvText: string): Array<Record<string, string>> {
  const clean = String(csvText || '').replace(/^\uFEFF/, '').trim();
  if (!clean) return [];

  const rows: string[][] = [];
  let currentRow: string[] = [];
  let currentCell = '';
  let inQuotes = false;

  for (let i = 0; i < clean.length; i++) {
    const ch = clean[i];
    if (inQuotes) {
      if (ch === '"') {
        if (clean[i + 1] === '"') {
          currentCell += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        currentCell += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ',' || ch === ';') {
      currentRow.push(currentCell.trim());
      currentCell = '';
    } else if (ch === '\r' || ch === '\n') {
      if (ch === '\r' && clean[i + 1] === '\n') i++;
      currentRow.push(currentCell.trim());
      if (currentRow.some((c) => c.length > 0)) {
        rows.push(currentRow);
      }
      currentRow = [];
      currentCell = '';
    } else {
      currentCell += ch;
    }
  }
  currentRow.push(currentCell.trim());
  if (currentRow.some((c) => c.length > 0)) {
    rows.push(currentRow);
  }

  if (rows.length < 2) return [];
  const headers = rows[0].map((h) => h.trim());
  return rows.slice(1).map((cells) => {
    const obj: Record<string, string> = {};
    for (let idx = 0; idx < headers.length; idx++) {
      if (headers[idx]) {
        obj[headers[idx]] = cells[idx] ?? '';
      }
    }
    return obj;
  });
}

/**
 * Unified Master Contact Upsert (`leads`):
 * Supports Marketing-only contacts (`phone = NULL` allowed when `email` present, `pipeline_id = NULL`, `status = 'marketing_nurture'`)
 * AND deduplicates cleanly within `tenant_id` by normalized phone or lowercase email.
 */
export async function upsertMasterContactInTx(
  client: DbClient,
  tenantId: string,
  rawItem: Record<string, any>,
  options?: {
    defaultStatus?: 'marketing_nurture' | 'unassigned_pending';
    defaultSource?: string;
    dialCode?: string;
  }
): Promise<{ leadId: string; created: boolean }> {
  const rawName = String(
    rawItem.name || rawItem['Họ tên'] || rawItem['Khách hàng'] || rawItem.full_name || ''
  ).trim();
  const rawPhone = String(
    rawItem.phone || rawItem['Số điện thoại'] || rawItem['SĐT'] || rawItem.mobile || ''
  ).trim();
  const rawEmail = String(rawItem.email || rawItem['Email'] || '').trim().toLowerCase();

  let normalizedPhone: string | null = null;
  if (rawPhone) {
    const pCheck = validateAndNormalizePhone(rawPhone, {
      default_dial_code: options?.dialCode || '84',
      allow_international_phones: true,
      allow_landline_phones: true,
    });
    if (pCheck.valid) {
      normalizedPhone = pCheck.normalizedE164;
    } else {
      const digits = rawPhone.replace(/\D/g, '');
      if (digits.length >= 8) {
        normalizedPhone = digits.startsWith('0') ? `84${digits.slice(1)}` : digits;
      }
    }
  }

  const cleanEmail = rawEmail && rawEmail.includes('@') ? rawEmail : null;
  if (!normalizedPhone && !cleanEmail) {
    throw new Error('CONTACT_REQUIRES_PHONE_OR_EMAIL');
  }

  // Deduplicate within tenant by phone first, then email
  let existingId: string | null = null;
  let existingCustomFieldsRaw: unknown = null;
  if (normalizedPhone) {
    const byPhone = await client.query<{ id: string; custom_fields?: unknown }>(
      'SELECT id, custom_fields FROM leads WHERE tenant_id = $1 AND phone = $2 AND is_deleted = false ORDER BY created_at DESC LIMIT 1',
      [tenantId, normalizedPhone]
    );
    existingId = byPhone.rows[0]?.id || null;
    existingCustomFieldsRaw = byPhone.rows[0]?.custom_fields ?? null;
  }
  if (!existingId && cleanEmail) {
    const byEmail = await client.query<{ id: string; custom_fields?: unknown }>(
      'SELECT id, custom_fields FROM leads WHERE tenant_id = $1 AND LOWER(email) = $2 AND is_deleted = false ORDER BY created_at DESC LIMIT 1',
      [tenantId, cleanEmail]
    );
    existingId = byEmail.rows[0]?.id || null;
    existingCustomFieldsRaw = byEmail.rows[0]?.custom_fields ?? null;
  }

  const customFields: Record<string, unknown> =
    rawItem.custom_fields && typeof rawItem.custom_fields === 'object' && !Array.isArray(rawItem.custom_fields)
      ? { ...rawItem.custom_fields }
      : {};
  for (const [k, v] of Object.entries(rawItem)) {
    if (v === undefined || v === '') continue;
    if (k.startsWith('cf_')) {
      customFields[k.slice(3)] = v;
    } else if (k.startsWith('cf.')) {
      customFields[k.slice(3)] = v;
    } else if (k.startsWith('custom_fields.')) {
      customFields[k.slice(14)] = v;
    }
  }

  const displayName =
    rawName ||
    (cleanEmail ? cleanEmail.split('@')[0] : `Khách hàng ${normalizedPhone?.slice(-4) || ''}`);
  const source = String(rawItem.source || rawItem['Nguồn'] || options?.defaultSource || 'Audience Import').trim();
  const campaign = rawItem.campaign || rawItem['Chiến dịch'] ? String(rawItem.campaign || rawItem['Chiến dịch']).trim() : null;
  const leadScore = Number.isFinite(Number(rawItem.lead_score)) ? Math.round(Number(rawItem.lead_score)) : 0;
  const totalRev = Number.isFinite(Number(rawItem.total_revenue_vnd)) ? Math.round(Number(rawItem.total_revenue_vnd)) : 0;

  if (existingId) {
    let existingCfObj: Record<string, unknown> = {};
    if (existingCustomFieldsRaw && typeof existingCustomFieldsRaw === 'object' && !Array.isArray(existingCustomFieldsRaw)) {
      existingCfObj = { ...(existingCustomFieldsRaw as Record<string, unknown>) };
    } else if (typeof existingCustomFieldsRaw === 'string' && existingCustomFieldsRaw.trim()) {
      try {
        const parsed = JSON.parse(existingCustomFieldsRaw);
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
          existingCfObj = parsed as Record<string, unknown>;
        }
      } catch {
        // ignore invalid json
      }
    }
    const hasIncomingCf = Object.keys(customFields).length > 0;
    const mergedCf = hasIncomingCf ? deepMergeJsonObjects(existingCfObj, customFields) : existingCfObj;

    await client.query(
      `UPDATE leads
       SET name = COALESCE($3, name),
           phone = COALESCE($4, phone),
           email = COALESCE($5, email),
           campaign = COALESCE($6, campaign),
           lead_score = CASE WHEN $7::int != 0 THEN $7::int ELSE lead_score END,
           total_revenue_vnd = CASE WHEN $8::bigint > 0 THEN $8::bigint ELSE total_revenue_vnd END,
           custom_fields = CASE WHEN $9::boolean THEN $10::jsonb ELSE custom_fields END,
           updated_at = clock_timestamp()
       WHERE tenant_id = $1 AND id = $2`,
      [
        tenantId,
        existingId,
        rawName || null,
        normalizedPhone,
        cleanEmail,
        campaign,
        leadScore,
        totalRev,
        hasIncomingCf,
        JSON.stringify(mergedCf),
      ]
    );
    return { leadId: existingId, created: false };
  }

  const targetStatus = options?.defaultStatus || 'marketing_nurture';
  let pipelineId: string | null = rawItem.pipeline_id || null;
  let stageId: string | null = rawItem.stage_id || null;

  if (targetStatus === 'unassigned_pending' && !pipelineId) {
    const pRes = await client.query<{ id: string }>(
      'SELECT id FROM tenant_pipelines WHERE tenant_id = $1 ORDER BY is_default DESC, created_at ASC LIMIT 1',
      [tenantId]
    );
    pipelineId = pRes.rows[0]?.id || null;
    if (pipelineId && !stageId) {
      const sRes = await client.query<{ id: string }>(
        'SELECT id FROM tenant_pipeline_stages WHERE tenant_id = $1 AND pipeline_id = $2 ORDER BY stage_order ASC LIMIT 1',
        [tenantId, pipelineId]
      );
      stageId = sRes.rows[0]?.id || null;
    }
  }

  const newLeadId = crypto.randomUUID();
  const lifecycle =
    rawItem.lifecycle_stage ||
    (targetStatus === 'marketing_nurture' ? 'subscriber' : 'lead');
  const emailConsent =
    rawItem.email_consent === 'unsubscribed' || rawItem.email_consent === 'bounced'
      ? rawItem.email_consent
      : 'subscribed';
  const znsConsent = rawItem.zns_consent === 'opted_out' ? 'opted_out' : 'opted_in';

  await client.query(
    `INSERT INTO leads (
       id, tenant_id, pipeline_id, stage_id, status, lifecycle_stage,
       name, phone, email, lead_score, email_consent, zns_consent,
       total_revenue_vnd, source, campaign, product_interest, custom_fields, last_engaged_at
     ) VALUES (
       $1, $2, $3, $4, $5, $6,
       $7, $8, $9, $10, $11, $12,
       $13, $14, $15, $16, $17::jsonb, clock_timestamp()
     )`,
    [
      newLeadId,
      tenantId,
      pipelineId,
      stageId,
      targetStatus,
      lifecycle,
      displayName,
      normalizedPhone,
      cleanEmail,
      leadScore,
      emailConsent,
      znsConsent,
      totalRev,
      source,
      campaign,
      rawItem.product_interest ? String(rawItem.product_interest).trim() : null,
      JSON.stringify(customFields),
    ]
  );

  tenantRedis.invalidateTenantMonthlyLeadCount(tenantId);
  return { leadId: newLeadId, created: true };
}

export async function importRowsIntoAudience(
  tenantId: string,
  audienceId: string,
  rows: Array<Record<string, any>>,
  options?: {
    status?: 'marketing_nurture' | 'unassigned_pending';
    source?: string;
    actorId?: string;
  }
) {
  const cfg = await getTenantSettingsCached(tenantId);
  const targetStatus =
    options?.status === 'unassigned_pending' ? 'unassigned_pending' : 'marketing_nurture';

  const summary = await withTenantTransaction(tenantId, async (client) => {
    const audCheck = await client.query<{ id: string; name: string }>(
      'SELECT id, name FROM tenant_audiences WHERE tenant_id = $1 AND id = $2 LIMIT 1',
      [tenantId, audienceId]
    );
    if (!audCheck.rows[0]) {
      throw new Error('AUDIENCE_NOT_FOUND');
    }

    let createdCount = 0;
    let updatedCount = 0;
    let skippedCount = 0;
    const importedLeadIds: string[] = [];
    const newlyEnteredLeadIds: string[] = [];

    for (const row of rows) {
      if (!row || typeof row !== 'object') {
        skippedCount++;
        continue;
      }
      try {
        const upserted = await upsertMasterContactInTx(client, tenantId, row, {
          defaultStatus: targetStatus,
          defaultSource: options?.source || `Tệp: ${audCheck.rows[0].name}`,
          dialCode: cfg.default_dial_code,
        });
        if (upserted.created) createdCount++;
        else updatedCount++;

        const insMem = await client.query(
          `INSERT INTO tenant_audience_members (id, tenant_id, audience_id, lead_id, source_type, metadata)
           VALUES ($1, $2, $3, $4, 'csv', '{}'::jsonb)
           ON CONFLICT (tenant_id, audience_id, lead_id) DO NOTHING`,
          [crypto.randomUUID(), tenantId, audienceId, upserted.leadId]
        );
        importedLeadIds.push(upserted.leadId);
        if ((insMem.rowCount || 0) > 0) {
          newlyEnteredLeadIds.push(upserted.leadId);
        }
      } catch {
        skippedCount++;
      }
    }

    const totalMembers = await refreshAudienceCachedCount(client, tenantId, audienceId);
    return {
      created_count: createdCount,
      updated_count: updatedCount,
      skipped_count: skippedCount,
      imported_count: createdCount + updatedCount,
      total_audience_members: totalMembers,
      lead_ids: importedLeadIds,
      newly_entered_lead_ids: newlyEnteredLeadIds,
      audience_name: audCheck.rows[0].name,
    };
  });

  for (const lid of summary.newly_entered_lead_ids) {
    await emitDomainEvent('audience.entered', {
      tenantId,
      audienceId,
      audienceName: summary.audience_name,
      audienceType: 'static_list',
      leadId: lid,
    });
  }

  // Trigger dynamic segment evaluation once after bulk import
  await evaluateAllDynamicAudiencesForTenant(tenantId);
  if (targetStatus === 'unassigned_pending' && summary.imported_count > 0) {
    await runUnassignedLeadDrainer(tenantId).catch(() => {});
  }

  return {
    created_count: summary.created_count,
    updated_count: summary.updated_count,
    skipped_count: summary.skipped_count,
    imported_count: summary.imported_count,
    total_audience_members: summary.total_audience_members,
    lead_ids: summary.lead_ids,
  };
}

const UUID_V4_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function safeAudSavepoint<T extends Record<string, any> = Record<string, any>>(
  client: DbClient,
  sql: string,
  params: unknown[]
): Promise<T[]> {
  const sp = `sp_aud_${crypto.randomUUID().replace(/-/g, '').slice(0, 12)}`;
  const isMaria = client.dialect === 'mariadb';
  try {
    if (!isMaria) await client.query(`SAVEPOINT ${sp}`);
    const r = await client.query<T>(sql, params);
    if (!isMaria) await client.query(`RELEASE SAVEPOINT ${sp}`);
    return r.rows || [];
  } catch {
    if (!isMaria) {
      await client.query(`ROLLBACK TO SAVEPOINT ${sp}`).catch(() => {});
      await client.query(`RELEASE SAVEPOINT ${sp}`).catch(() => {});
    }
    return [];
  }
}

/**
 * Resolves live non-deleted member lead IDs for BOTH static lists and `dynamic_logic` segments.
 */
export async function resolveAudienceMemberLeadIdsInTx(
  client: DbClient,
  tenantId: string,
  audienceId: string,
  options?: { excludeSuppressed?: boolean }
): Promise<{
  audience: {
    id: string;
    name: string;
    audience_type: string;
    color_hex: string;
    filter_branches: unknown;
  };
  leadIds: string[];
}> {
  const audRes = await client.query<{
    id: string;
    name: string;
    audience_type: string;
    color_hex: string;
    filter_branches: unknown;
  }>(
    `SELECT id, name, audience_type, color_hex, filter_branches
     FROM tenant_audiences
     WHERE tenant_id = $1 AND id = $2
     LIMIT 1`,
    [tenantId, audienceId]
  );
  const aud = audRes.rows[0];
  if (!aud) throw new Error('AUDIENCE_NOT_FOUND');

  const suppressFilter = options?.excludeSuppressed
    ? ` AND COALESCE(l.email_consent, 'subscribed') NOT IN ('unsubscribed', 'bounced', 'complained')`
    : '';

  if (aud.audience_type === 'dynamic_logic') {
    const compiled = compileSegmentWhereSql(tenantId, aud.filter_branches, {
      audienceIdForExclusions: audienceId,
      startParamIndex: 1,
    });
    if (compiled.hasRules) {
      const mRes = await client.query<{ id: string }>(
        `SELECT l.id
         FROM leads l
         LEFT JOIN tenant_pipeline_stages s ON s.tenant_id = l.tenant_id AND s.id = l.stage_id
         WHERE ${compiled.whereClause}${suppressFilter}
         ORDER BY l.created_at DESC, l.id ASC`,
        compiled.params
      );
      return {
        audience: aud,
        leadIds: Array.from(new Set(mRes.rows.map((r) => String(r.id)))),
      };
    }
  }

  const membersRes = await client.query<{ lead_id: string }>(
    `SELECT tam.lead_id
     FROM tenant_audience_members tam
     INNER JOIN leads l ON l.tenant_id = tam.tenant_id AND l.id = tam.lead_id
     WHERE tam.tenant_id = $1 AND tam.audience_id = $2 AND l.is_deleted = false${suppressFilter}
     ORDER BY tam.joined_at DESC, tam.lead_id ASC`,
    [tenantId, audienceId]
  );

  return {
    audience: aud,
    leadIds: Array.from(new Set(membersRes.rows.map((r) => String(r.lead_id)))),
  };
}

/**
 * Largest-remainder bucket allocation so percentage splits ALWAYS sum cleanly to exact total.
 */
function allocateByWeights(total: number, weights: number[]): number[] {
  if (total <= 0) return weights.map(() => 0);
  const totalWeight = weights.reduce((a, b) => a + b, 0) || 1;
  const exact = weights.map((w) => (total * w) / totalWeight);
  const floors = exact.map((x) => Math.floor(x));
  let remainder = total - floors.reduce((a, b) => a + b, 0);
  const order = exact
    .map((x, idx) => ({ idx, frac: x - Math.floor(x) }))
    .sort((a, b) => b.frac - a.frac || a.idx - b.idx);
  for (let i = 0; i < remainder; i++) {
    floors[order[i % order.length].idx] += 1;
  }
  return floors;
}

/**
 * Splits an existing Audience (static list or dynamic segment) cleanly across all strategies:
 *   - `percentage` / `ratio` (A/B/N split by %)
 *   - `round_robin` (deterministic interleaved balanced split into N parts)
 *   - `count` / `quantity` (extract N contacts random/top into new or existing list)
 *   - `selection` / `list` / `phone` (extract specific contacts or valid-phone contacts)
 */
export async function splitAudienceIntoParts(
  tenantId: string,
  audienceId: string,
  options: {
    mode?: 'percentage' | 'ratio' | 'round_robin' | 'count' | 'quantity' | 'selection' | 'list' | 'phone';
    type?: string;
    ratios?: number[];
    ratio_a?: number;
    parts?: number;
    count_parts?: number;
    quantity?: number;
    count?: number;
    strategy?: 'random' | 'top' | 'round_robin';
    deterministic?: boolean;
    data?: string[];
    lead_ids?: string[];
    destination_id?: string | null;
    destination_name?: string | null;
    name_prefix?: string;
    exclude_from_source?: boolean;
    cleanup_invalid?: boolean;
    actorId?: string;
  }
) {
  const result = await withTenantTransaction(tenantId, async (client) => {
    const resolved = await resolveAudienceMemberLeadIdsInTx(client, tenantId, audienceId, {
      excludeSuppressed: Boolean(options.cleanup_invalid),
    });
    const sourceAud = resolved.audience;
    const baseLeadIds = [...resolved.leadIds];

    const rawMode = String(options.mode || options.type || '').trim().toLowerCase();
    const effectiveMode:
      | 'percentage'
      | 'round_robin'
      | 'count'
      | 'selection'
      | 'list'
      | 'phone' =
      rawMode === 'round_robin'
        ? 'round_robin'
        : rawMode === 'count' || rawMode === 'quantity'
          ? 'count'
          : rawMode === 'selection'
            ? 'selection'
            : rawMode === 'list'
              ? 'list'
              : rawMode === 'phone'
                ? 'phone'
                : rawMode === 'percentage' || rawMode === 'ratio'
                  ? 'percentage'
                  : (options.count !== undefined || (options.quantity !== undefined && !Array.isArray(options.ratios) && options.parts === undefined && options.count_parts === undefined && options.ratio_a === undefined && (options.destination_id || options.destination_name)))
                    ? 'count'
                    : 'percentage';

    const prefix = String(options.name_prefix || sourceAud.name).trim();

    // Helper: create or reuse static target audience and insert member IDs idempotently
    const materializeBucket = async (
      bucketIds: string[],
      targetName: string,
      description: string,
      variantLabel: string,
      existingDestId?: string | null
    ) => {
      let targetAudId = existingDestId && UUID_V4_RE.test(existingDestId) ? existingDestId : null;
      if (targetAudId) {
        const destCheck = await client.query<{ id: string }>(
          'SELECT id FROM tenant_audiences WHERE tenant_id = $1 AND id = $2 LIMIT 1',
          [tenantId, targetAudId]
        );
        if (!destCheck.rows[0]) targetAudId = null;
      }

      if (!targetAudId) {
        targetAudId = crypto.randomUUID();
        await client.query(
          `INSERT INTO tenant_audiences (
             id, tenant_id, name, description, audience_type, filter_branches,
             cached_member_count, color_hex, is_active, created_by
           ) VALUES ($1, $2, $3, $4, 'static_data', '[]'::jsonb, 0, $5, true, $6)`,
          [
            targetAudId,
            tenantId,
            targetName.slice(0, 200),
            description,
            sourceAud.color_hex || '#1E40FF',
            options.actorId || null,
          ]
        );
      }

      let added = 0;
      for (const lid of Array.from(new Set(bucketIds))) {
        const ins = await client.query(
          `INSERT INTO tenant_audience_members (id, tenant_id, audience_id, lead_id, source_type, metadata)
           VALUES ($1, $2, $3, $4, 'ab_split', $5::jsonb)
           ON CONFLICT (tenant_id, audience_id, lead_id) DO NOTHING`,
          [
            crypto.randomUUID(),
            tenantId,
            targetAudId,
            lid,
            JSON.stringify({ parent_audience_id: audienceId, mode: effectiveMode, variant: variantLabel }),
          ]
        );
        added += Number(ins.rowCount || 0);
      }
      await refreshAudienceCachedCount(client, tenantId, targetAudId);
      const subRow = await client.query('SELECT * FROM tenant_audiences WHERE tenant_id = $1 AND id = $2', [
        tenantId,
        targetAudId,
      ]);
      return { audience: subRow.rows[0], added_count: added };
    };

    // Single-destination extraction modes (`count`, `selection`, `list`, `phone`)
    if (effectiveMode === 'count' || effectiveMode === 'selection' || effectiveMode === 'list' || effectiveMode === 'phone') {
      let pickedIds: string[] = [];

      if (effectiveMode === 'selection') {
        const wanted = new Set(
          (Array.isArray(options.lead_ids) ? options.lead_ids : Array.isArray(options.data) ? options.data : [])
            .map((x) => String(x || '').trim())
            .filter(Boolean)
        );
        pickedIds = baseLeadIds.filter((id) => wanted.has(id));
      } else if (effectiveMode === 'list') {
        const tokens = (Array.isArray(options.data) ? options.data : [])
          .map((x) => String(x || '').trim().toLowerCase())
          .filter(Boolean);
        const digitTokens = new Set(tokens.map((t) => t.replace(/\D/g, '')).filter((d) => d.length >= 8));
        const tokenSet = new Set(tokens);
        if (baseLeadIds.length > 0 && tokens.length > 0) {
          const ph = baseLeadIds.map((_, i) => `$${i + 2}`).join(', ');
          const lRes = await client.query<{ id: string; email: string | null; phone: string | null }>(
            `SELECT id, email, phone FROM leads WHERE tenant_id = $1 AND id IN (${ph})`,
            [tenantId, ...baseLeadIds]
          );
          for (const row of lRes.rows) {
            const em = String(row.email || '').trim().toLowerCase();
            const phRaw = String(row.phone || '').trim().toLowerCase();
            const phDigits = phRaw.replace(/\D/g, '');
            const localPhone = phDigits.startsWith('84') ? `0${phDigits.slice(2)}` : phDigits;
            if (
              (em && tokenSet.has(em)) ||
              (phRaw && tokenSet.has(phRaw)) ||
              (phDigits && digitTokens.has(phDigits)) ||
              (localPhone && digitTokens.has(localPhone))
            ) {
              pickedIds.push(String(row.id));
            }
          }
        }
      } else if (effectiveMode === 'phone') {
        if (baseLeadIds.length > 0) {
          const ph = baseLeadIds.map((_, i) => `$${i + 2}`).join(', ');
          const pRes = await client.query<{ id: string; phone: string | null }>(
            `SELECT id, phone FROM leads WHERE tenant_id = $1 AND id IN (${ph})`,
            [tenantId, ...baseLeadIds]
          );
          for (const row of pRes.rows) {
            const digits = String(row.phone || '').replace(/\D/g, '');
            if (digits.length >= 9) pickedIds.push(String(row.id));
          }
        }
      } else {
        // `count` / `quantity`
        const requestedQty = Math.max(0, Math.floor(Number(options.count ?? options.quantity ?? 0)));
        const working = [...baseLeadIds];
        if ((options.strategy || 'random') === 'random' && !options.deterministic) {
          for (let i = working.length - 1; i > 0; i--) {
            const j = Math.floor(Math.random() * (i + 1));
            [working[i], working[j]] = [working[j], working[i]];
          }
        }
        pickedIds = working.slice(0, Math.min(working.length, requestedQty));
      }

      const destName = String(
        options.destination_name || `${prefix} — Tách (${pickedIds.length})`
      ).trim();
      const mat = await materializeBucket(
        pickedIds,
        destName,
        `Tách ${pickedIds.length} khách hàng từ tệp "${sourceAud.name}" (${effectiveMode})`,
        effectiveMode.toUpperCase(),
        options.destination_id
      );

      // Optional Move / Exclude from source
      if (options.exclude_from_source && pickedIds.length > 0) {
        if (sourceAud.audience_type === 'dynamic_logic') {
          for (const lid of pickedIds) {
            await client.query(
              `INSERT INTO tenant_audience_exclusions (id, tenant_id, audience_id, lead_id, reason, created_by)
               VALUES ($1, $2, $3, $4, 'split_move', $5)`,
              [crypto.randomUUID(), tenantId, audienceId, lid, options.actorId || null]
            );
          }
        } else {
          const ph = pickedIds.map((_, i) => `$${i + 3}`).join(', ');
          await client.query(
            `DELETE FROM tenant_audience_members WHERE tenant_id = $1 AND audience_id = $2 AND lead_id IN (${ph})`,
            [tenantId, audienceId, ...pickedIds]
          );
          await refreshAudienceCachedCount(client, tenantId, audienceId);
        }
      }

      const createdArr = mat.audience ? [mat.audience] : [];
      return {
        parent_audience_id: audienceId,
        mode: effectiveMode,
        total_split_members: pickedIds.length,
        destination_audience_id: mat.audience?.id || null,
        added_count: mat.added_count,
        created_audiences: createdArr,
        items: createdArr,
        created: createdArr,
        needsDynamicReeval: Boolean(options.exclude_from_source && sourceAud.audience_type === 'dynamic_logic'),
      };
    }

    // Multi-bucket modes: `round_robin` OR `percentage`
    if (effectiveMode === 'round_robin') {
      const nParts = Math.min(10, Math.max(2, Math.round(Number(options.parts || options.count_parts || 2))));
      const buckets: string[][] = Array.from({ length: nParts }, () => []);
      baseLeadIds.forEach((lid, idx) => {
        buckets[idx % nParts].push(lid);
      });

      const createdSubAudiences: any[] = [];
      for (let idx = 0; idx < nParts; idx++) {
        const labelSuffix = String.fromCharCode(65 + idx);
        const subName = `${prefix} — Round-Robin ${labelSuffix} (${idx + 1}/${nParts})`;
        const mat = await materializeBucket(
          buckets[idx],
          subName,
          `Chia đều Round-Robin (${idx + 1}/${nParts}) từ tệp "${sourceAud.name}"`,
          `RR-${labelSuffix}`
        );
        if (mat.audience) createdSubAudiences.push(mat.audience);
      }

      return {
        parent_audience_id: audienceId,
        mode: 'round_robin',
        total_split_members: baseLeadIds.length,
        created_audiences: createdSubAudiences,
        items: createdSubAudiences,
        created: createdSubAudiences,
        needsDynamicReeval: false,
      };
    }

    // `percentage` / `ratio` split (largest-remainder exact allocation)
    const shuffled = [...baseLeadIds];
    if (!options.deterministic) {
      for (let i = shuffled.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
      }
    }

    let weights: number[] = [];
    if (Array.isArray(options.ratios) && options.ratios.length >= 2) {
      weights = options.ratios.map((n) => Math.max(1, Number(n) || 1));
    } else if (options.ratio_a !== undefined && Number(options.ratio_a) > 0 && Number(options.ratio_a) < 100) {
      const a = Math.round(Number(options.ratio_a));
      weights = [a, 100 - a];
    } else {
      const nParts = Math.min(10, Math.max(2, Math.round(Number(options.count_parts || options.parts || 2))));
      weights = Array.from({ length: nParts }, () => 1);
    }

    const totalWeight = weights.reduce((a, b) => a + b, 0);
    const counts = allocateByWeights(shuffled.length, weights);
    const createdSubAudiences: any[] = [];
    let cursor = 0;

    for (let idx = 0; idx < weights.length; idx++) {
      const bucketIds = shuffled.slice(cursor, cursor + counts[idx]);
      cursor += bucketIds.length;

      const labelSuffix = String.fromCharCode(65 + idx);
      const pctLabel = Math.round((weights[idx] / totalWeight) * 100);
      const subName = `${prefix} — Nhánh ${labelSuffix} (${pctLabel}%)`;
      const mat = await materializeBucket(
        bucketIds,
        subName,
        `Tách theo tỷ lệ ${pctLabel}% từ tệp "${sourceAud.name}"`,
        labelSuffix
      );
      if (mat.audience) createdSubAudiences.push(mat.audience);
    }

    return {
      parent_audience_id: audienceId,
      mode: 'percentage',
      total_split_members: shuffled.length,
      created_audiences: createdSubAudiences,
      items: createdSubAudiences,
      created: createdSubAudiences,
      needsDynamicReeval: false,
    };
  });

  if (result.needsDynamicReeval) {
    await evaluateDynamicAudience(tenantId, audienceId).catch(() => {});
  }
  const { needsDynamicReeval: _ignored, ...cleanResult } = result;
  return cleanResult;
}

/**
 * Merges 2+ Audiences (static lists or dynamic segments) using Set Algebra:
 *   - `union` (A ∪ B ∪ ...): deduplicated union
 *   - `intersection` (A ∩ B ∩ ...): members present in ALL selected audiences
 *   - `subtract` (Base \ Others): members in `base_id` (defaults to `source_ids[0]`) not in remaining audiences
 * 100% Idempotent with exact duplicate accounting.
 */
export async function mergeAudiences(
  tenantId: string,
  options: {
    operation?: 'union' | 'intersection' | 'subtract';
    source_ids?: string[];
    list_ids?: string[];
    base_id?: string | null;
    merge_type?: 'new' | 'existing';
    target_id?: string | null;
    target_list_id?: string | null;
    destination_id?: string | null;
    new_list_name?: string | null;
    name?: string | null;
    delete_source_lists?: boolean;
    actorId?: string;
  }
) {
  const rawIds = Array.isArray(options.source_ids)
    ? options.source_ids
    : Array.isArray(options.list_ids)
      ? options.list_ids
      : [];
  const sourceIds = Array.from(new Set(rawIds.map((x) => String(x || '').trim()).filter((x) => UUID_V4_RE.test(x))));

  const rawOp = String(options.operation || 'union').trim().toLowerCase();
  const operation: 'union' | 'intersection' | 'subtract' =
    rawOp === 'intersection' ? 'intersection' : rawOp === 'subtract' ? 'subtract' : 'union';

  const explicitTargetId = String(
    options.target_id || options.target_list_id || options.destination_id || ''
  ).trim();
  const mergeType: 'new' | 'existing' =
    options.merge_type === 'existing' || (!options.merge_type && UUID_V4_RE.test(explicitTargetId))
      ? 'existing'
      : 'new';

  if (mergeType === 'existing' && !UUID_V4_RE.test(explicitTargetId)) {
    throw new Error('INVALID_MERGE_TARGET');
  }
  if (sourceIds.length === 0) {
    throw new Error('INVALID_MERGE_SOURCES');
  }
  if ((operation === 'intersection' || operation === 'subtract') && sourceIds.length < 2) {
    throw new Error('MERGE_REQUIRES_AT_LEAST_TWO_SOURCES');
  }

  return withTenantTransaction(tenantId, async (client) => {
    // Resolve member sets for every source audience
    const memberSets = new Map<string, Set<string>>();
    const sourceMeta = new Map<string, { id: string; name: string; audience_type: string }>();
    let rawInputTotal = 0;

    for (const srcId of sourceIds) {
      const resolved = await resolveAudienceMemberLeadIdsInTx(client, tenantId, srcId);
      const set = new Set(resolved.leadIds);
      memberSets.set(srcId, set);
      sourceMeta.set(srcId, {
        id: resolved.audience.id,
        name: resolved.audience.name,
        audience_type: resolved.audience.audience_type,
      });
      rawInputTotal += set.size;
    }

    // Compute set algebra
    let resultIds: string[] = [];
    if (operation === 'union') {
      const unionSet = new Set<string>();
      for (const s of memberSets.values()) {
        for (const id of s) unionSet.add(id);
      }
      resultIds = Array.from(unionSet);
    } else if (operation === 'intersection') {
      const setsArr = Array.from(memberSets.values());
      const [first, ...rest] = setsArr;
      resultIds = Array.from(first).filter((id) => rest.every((other) => other.has(id)));
    } else {
      // subtract: base \ others
      const effectiveBaseId =
        options.base_id && memberSets.has(options.base_id) ? options.base_id : sourceIds[0];
      const baseSet = memberSets.get(effectiveBaseId) || new Set<string>();
      const excludeSet = new Set<string>();
      for (const [sid, s] of memberSets.entries()) {
        if (sid === effectiveBaseId) continue;
        for (const id of s) excludeSet.add(id);
      }
      resultIds = Array.from(baseSet).filter((id) => !excludeSet.has(id));
    }

    const duplicatesRemoved =
      operation === 'union' ? Math.max(0, rawInputTotal - resultIds.length) : 0;

    let targetId = explicitTargetId;
    let targetName = '';

    if (mergeType === 'new') {
      targetId = crypto.randomUUID();
      const opLabel =
        operation === 'intersection' ? 'Giao nhau' : operation === 'subtract' ? 'Loại trừ' : 'Gộp';
      targetName = String(
        options.new_list_name || options.name || `${opLabel} (${sourceIds.length} tệp)`
      )
        .trim()
        .slice(0, 200);
      await client.query(
        `INSERT INTO tenant_audiences (
           id, tenant_id, name, description, audience_type, filter_branches,
           cached_member_count, color_hex, is_active, created_by
         ) VALUES ($1, $2, $3, $4, 'static_data', '[]'::jsonb, 0, '#1E40FF', true, $5)`,
        [
          targetId,
          tenantId,
          targetName,
          `Kết quả ${opLabel} từ ${sourceIds.length} tệp khách hàng (${operation})`,
          options.actorId || null,
        ]
      );
    } else {
      const tgtCheck = await client.query<{ id: string; name: string }>(
        'SELECT id, name FROM tenant_audiences WHERE tenant_id = $1 AND id = $2 LIMIT 1',
        [tenantId, targetId]
      );
      if (!tgtCheck.rows[0]) throw new Error('AUDIENCE_NOT_FOUND');
      targetName = tgtCheck.rows[0].name;

      // For intersection / subtract into an existing target, replace target membership with exact set result
      if (operation === 'intersection' || operation === 'subtract') {
        await client.query(
          'DELETE FROM tenant_audience_members WHERE tenant_id = $1 AND audience_id = $2',
          [tenantId, targetId]
        );
      }
    }

    let insertedCount = 0;
    for (const lid of resultIds) {
      const ins = await client.query(
        `INSERT INTO tenant_audience_members (id, tenant_id, audience_id, lead_id, source_type, metadata)
         VALUES ($1, $2, $3, $4, 'merge', $5::jsonb)
         ON CONFLICT (tenant_id, audience_id, lead_id) DO NOTHING`,
        [
          crypto.randomUUID(),
          tenantId,
          targetId,
          lid,
          JSON.stringify({ operation, source_ids: sourceIds }),
        ]
      );
      insertedCount += Number(ins.rowCount || 0);
    }

    const totalMembers = await refreshAudienceCachedCount(client, tenantId, targetId);

    // Optional deletion of non-target static source lists
    let deletedSourceCount = 0;
    if (options.delete_source_lists) {
      for (const srcId of sourceIds) {
        if (srcId === targetId) continue;
        const meta = sourceMeta.get(srcId);
        if (meta && meta.audience_type !== 'dynamic_logic') {
          const del = await client.query(
            'DELETE FROM tenant_audiences WHERE tenant_id = $1 AND id = $2',
            [tenantId, srcId]
          );
          deletedSourceCount += Number(del.rowCount || 0);
        }
      }
    }

    const audRowRes = await client.query('SELECT * FROM tenant_audiences WHERE tenant_id = $1 AND id = $2', [
      tenantId,
      targetId,
    ]);

    return {
      operation,
      target_audience_id: targetId,
      target_audience_name: targetName,
      source_count: sourceIds.length,
      raw_input_total: rawInputTotal,
      unique_count: resultIds.length,
      duplicates_removed: duplicatesRemoved,
      merged_count: insertedCount,
      total_members: totalMembers,
      deleted_source_count: deletedSourceCount,
      audience: audRowRes.rows[0] || null,
    };
  });
}

/**
 * Meta-Report-style Audience & Segment Analytics (tenant-wide or scoped to an audienceId).
 */
export async function computeAudienceAnalyticsInTx(
  client: DbClient,
  tenantId: string,
  audienceId?: string | null
) {
  let scopeFilterSql = 'l.tenant_id = $1 AND l.is_deleted = false';
  const scopeParams: unknown[] = [tenantId];
  let scopedAudience: { id: string; name: string; audience_type: string } | null = null;

  if (audienceId && UUID_V4_RE.test(audienceId)) {
    const resolved = await resolveAudienceMemberLeadIdsInTx(client, tenantId, audienceId);
    scopedAudience = {
      id: resolved.audience.id,
      name: resolved.audience.name,
      audience_type: resolved.audience.audience_type,
    };
    if (resolved.leadIds.length === 0) {
      scopeFilterSql += ' AND 1 = 0';
    } else {
      scopeParams.push(resolved.leadIds);
      scopeFilterSql += ` AND l.id::text = ANY($${scopeParams.length}::text[])`;
    }
  }

  const [
    summaryRows,
    audCountsRows,
    sourceRows,
    adRows,
    stageRows,
    growthRows,
  ] = await Promise.all([
    client.query<{
      total_contacts: number;
      email_reach: number;
      phone_reach: number;
      zalo_reach: number;
      messenger_reach: number;
      suppressed_consent: number;
      hot_count: number;
      warm_count: number;
      cold_count: number;
      avg_lead_score: number;
      total_revenue_vnd: number;
    }>(
      `SELECT
         COUNT(*)::int AS total_contacts,
         COALESCE(SUM(CASE WHEN l.email IS NOT NULL AND TRIM(l.email) != '' AND COALESCE(l.email_consent, 'subscribed') = 'subscribed' THEN 1 ELSE 0 END), 0)::int AS email_reach,
         COALESCE(SUM(CASE WHEN l.phone IS NOT NULL AND TRIM(l.phone) != '' THEN 1 ELSE 0 END), 0)::int AS phone_reach,
         COALESCE(SUM(CASE WHEN COALESCE(l.zns_consent, 'opted_in') = 'opted_in' AND (
           (l.phone IS NOT NULL AND TRIM(l.phone) != '')
           OR NULLIF(TRIM(COALESCE(l.custom_fields->>'zalo_user_id', '')), '') IS NOT NULL
         ) THEN 1 ELSE 0 END), 0)::int AS zalo_reach,
         COALESCE(SUM(CASE WHEN NULLIF(TRIM(COALESCE(l.custom_fields->>'meta_psid', '')), '') IS NOT NULL OR LOWER(COALESCE(l.source, '')) LIKE '%messenger%' THEN 1 ELSE 0 END), 0)::int AS messenger_reach,
         COALESCE(SUM(CASE WHEN COALESCE(l.email_consent, 'subscribed') IN ('unsubscribed', 'bounced', 'complained') THEN 1 ELSE 0 END), 0)::int AS suppressed_consent,
         COALESCE(SUM(CASE WHEN COALESCE(l.email_consent, 'subscribed') NOT IN ('unsubscribed', 'bounced', 'complained') AND COALESCE(l.lead_score, 0) >= 70 THEN 1 ELSE 0 END), 0)::int AS hot_count,
         COALESCE(SUM(CASE WHEN COALESCE(l.email_consent, 'subscribed') NOT IN ('unsubscribed', 'bounced', 'complained') AND COALESCE(l.lead_score, 0) >= 30 AND COALESCE(l.lead_score, 0) < 70 THEN 1 ELSE 0 END), 0)::int AS warm_count,
         COALESCE(SUM(CASE WHEN COALESCE(l.email_consent, 'subscribed') NOT IN ('unsubscribed', 'bounced', 'complained') AND COALESCE(l.lead_score, 0) < 30 THEN 1 ELSE 0 END), 0)::int AS cold_count,
         COALESCE(ROUND(AVG(COALESCE(l.lead_score, 0))::numeric, 1), 0)::float AS avg_lead_score,
         COALESCE(SUM(COALESCE(l.total_revenue_vnd, 0)), 0)::bigint AS total_revenue_vnd
       FROM leads l
       WHERE ${scopeFilterSql}`,
      scopeParams
    ),
    client.query<{ static_count: number; dynamic_count: number }>(
      `SELECT
         COALESCE(SUM(CASE WHEN audience_type IN ('static_data', 'sync_data') THEN 1 ELSE 0 END), 0)::int AS static_count,
         COALESCE(SUM(CASE WHEN audience_type = 'dynamic_logic' THEN 1 ELSE 0 END), 0)::int AS dynamic_count
       FROM tenant_audiences
       WHERE tenant_id = $1 AND is_active = true`,
      [tenantId]
    ),
    client.query<{
      source: string;
      cnt: number;
      avg_score: number;
      revenue_vnd: number;
    }>(
      `SELECT
         COALESCE(NULLIF(TRIM(l.source), ''), 'Direct / Khác') AS source,
         COUNT(*)::int AS cnt,
         COALESCE(ROUND(AVG(COALESCE(l.lead_score, 0))::numeric, 1), 0)::float AS avg_score,
         COALESCE(SUM(COALESCE(l.total_revenue_vnd, 0)), 0)::bigint AS revenue_vnd
       FROM leads l
       WHERE ${scopeFilterSql}
       GROUP BY COALESCE(NULLIF(TRIM(l.source), ''), 'Direct / Khác')
       ORDER BY cnt DESC
       LIMIT 8`,
      scopeParams
    ),
    client.query<{
      campaign_name: string;
      utm_source: string;
      utm_medium: string;
      ad_name: string;
      leads_count: number;
      won_count: number;
      revenue_vnd: number;
    }>(
      `SELECT
         COALESCE(NULLIF(TRIM(l.custom_fields->>'utm_campaign'), ''), NULLIF(TRIM(l.campaign), ''), NULLIF(TRIM(l.custom_fields->>'campaign_name'), ''), 'Organic / Direct') AS campaign_name,
         COALESCE(NULLIF(TRIM(l.utm_source), ''), NULLIF(TRIM(l.custom_fields->>'utm_source'), ''), NULLIF(TRIM(l.source), ''), 'direct') AS utm_source,
         COALESCE(NULLIF(TRIM(l.utm_medium), ''), NULLIF(TRIM(l.custom_fields->>'utm_medium'), ''), '—') AS utm_medium,
         COALESCE(NULLIF(TRIM(l.custom_fields->>'ad_name'), ''), NULLIF(TRIM(l.ad_id), ''), '—') AS ad_name,
         COUNT(*)::int AS leads_count,
         COALESCE(SUM(CASE WHEN COALESCE(s.is_won_stage, false) = true OR l.lifecycle_stage IN ('customer', 'evangelist') THEN 1 ELSE 0 END), 0)::int AS won_count,
         COALESCE(SUM(COALESCE(l.total_revenue_vnd, 0)), 0)::bigint AS revenue_vnd
       FROM leads l
       LEFT JOIN tenant_pipeline_stages s ON s.tenant_id = l.tenant_id AND s.id = l.stage_id
       WHERE ${scopeFilterSql}
       GROUP BY 1, 2, 3, 4
       ORDER BY leads_count DESC, revenue_vnd DESC
       LIMIT 8`,
      scopeParams
    ),
    client.query<{
      stage_id: string | null;
      stage_name: string;
      color_hex: string;
      cnt: number;
      revenue_vnd: number;
    }>(
      `SELECT
         l.stage_id::text AS stage_id,
         COALESCE(NULLIF(TRIM(s.stage_name), ''), CASE WHEN l.status = 'marketing_nurture' THEN 'Nuôi dưỡng Marketing' ELSE 'Chưa vào Pipeline' END) AS stage_name,
         COALESCE(s.color_hex, '#64748b') AS color_hex,
         COUNT(*)::int AS cnt,
         COALESCE(SUM(COALESCE(l.total_revenue_vnd, 0)), 0)::bigint AS revenue_vnd
       FROM leads l
       LEFT JOIN tenant_pipeline_stages s ON s.tenant_id = l.tenant_id AND s.id = l.stage_id
       WHERE ${scopeFilterSql}
       GROUP BY l.stage_id, s.stage_name, s.color_hex, l.status
       ORDER BY cnt DESC
       LIMIT 10`,
      scopeParams
    ),
    client.query<{
      day: string;
      new_contacts: number;
      engaged_contacts: number;
    }>(
      `SELECT
         TO_CHAR(l.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD') AS day,
         COUNT(*)::int AS new_contacts,
         COALESCE(SUM(CASE WHEN l.last_engaged_at IS NOT NULL THEN 1 ELSE 0 END), 0)::int AS engaged_contacts
       FROM leads l
       WHERE ${scopeFilterSql} AND l.created_at >= (clock_timestamp() - INTERVAL '14 days')
       GROUP BY 1
       ORDER BY 1 ASC`,
      scopeParams
    ),
  ]);

  const socialRows = await safeAudSavepoint<{ channel: string; cnt: number }>(
    client,
    `SELECT sc.channel, COUNT(DISTINCT sc.lead_id)::int AS cnt
     FROM mkt_social_conversations sc
     INNER JOIN leads l ON l.tenant_id = sc.tenant_id AND l.id = sc.lead_id
     WHERE ${scopeFilterSql}
     GROUP BY sc.channel`,
    scopeParams
  );
  const suppressedRows = await safeAudSavepoint<{ cnt: number }>(
    client,
    `SELECT COUNT(DISTINCT l.id)::int AS cnt
     FROM leads l
     INNER JOIN mkt_suppression_list ms ON ms.tenant_id = l.tenant_id
       AND ((l.email IS NOT NULL AND LOWER(ms.recipient) = LOWER(l.email)) OR (l.phone IS NOT NULL AND ms.recipient = l.phone))
     WHERE ${scopeFilterSql}`,
    scopeParams
  );

  const sRow = summaryRows.rows[0] || {
    total_contacts: 0,
    email_reach: 0,
    phone_reach: 0,
    zalo_reach: 0,
    messenger_reach: 0,
    suppressed_consent: 0,
    hot_count: 0,
    warm_count: 0,
    cold_count: 0,
    avg_lead_score: 0,
    total_revenue_vnd: 0,
  };
  const total = Number(sRow.total_contacts || 0);
  const pct = (v: number) => (total > 0 ? Math.round((v / total) * 1000) / 10 : 0);

  let socialMessenger = 0;
  let socialZalo = 0;
  for (const r of socialRows) {
    if (r.channel === 'messenger') socialMessenger = Number(r.cnt || 0);
    if (r.channel === 'zalo_oa') socialZalo = Number(r.cnt || 0);
  }
  const emailReach = Number(sRow.email_reach || 0);
  const phoneReach = Number(sRow.phone_reach || 0);
  const zaloReach = Math.max(Number(sRow.zalo_reach || 0), socialZalo);
  const messengerReach = Math.max(Number(sRow.messenger_reach || 0), socialMessenger);
  const suppressedCount = Math.max(Number(sRow.suppressed_consent || 0), Number(suppressedRows[0]?.cnt || 0));

  // Build full 14-day timeline
  const growthMap = new Map<string, { new_contacts: number; engaged_contacts: number }>();
  for (const r of growthRows.rows) {
    growthMap.set(String(r.day), {
      new_contacts: Number(r.new_contacts || 0),
      engaged_contacts: Number(r.engaged_contacts || 0),
    });
  }
  const growthTrend14d: Array<{
    date: string;
    label: string;
    new_contacts: number;
    engaged_contacts: number;
  }> = [];
  const now = new Date();
  for (let i = 13; i >= 0; i--) {
    const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - i));
    const iso = d.toISOString().slice(0, 10);
    const label = `${String(d.getUTCDate()).padStart(2, '0')}/${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
    const rec = growthMap.get(iso);
    growthTrend14d.push({
      date: iso,
      label,
      new_contacts: rec?.new_contacts || 0,
      engaged_contacts: rec?.engaged_contacts || 0,
    });
  }

  return {
    scope: scopedAudience ? 'audience' : 'tenant',
    audience: scopedAudience,
    summary: {
      total_contacts: total,
      email_reach: emailReach,
      phone_reach: phoneReach,
      zalo_reach: zaloReach,
      messenger_reach: messengerReach,
      suppressed_count: suppressedCount,
      avg_lead_score: Number(sRow.avg_lead_score || 0),
      total_revenue_vnd: Number(sRow.total_revenue_vnd || 0),
      static_lists_count: Number(audCountsRows.rows[0]?.static_count || 0),
      dynamic_segments_count: Number(audCountsRows.rows[0]?.dynamic_count || 0),
    },
    channel_reach: [
      { key: 'email', channel: 'Email Marketing', count: emailReach, pct: pct(emailReach), color: '#1E40FF' },
      { key: 'phone', channel: 'Điện thoại / SMS', count: phoneReach, pct: pct(phoneReach), color: '#10b981' },
      { key: 'zalo', channel: 'Zalo OA / ZNS', count: zaloReach, pct: pct(zaloReach), color: '#0284c7' },
      { key: 'messenger', channel: 'Meta Messenger', count: messengerReach, pct: pct(messengerReach), color: '#8b5cf6' },
    ],
    top_sources: sourceRows.rows.map((r) => ({
      source: String(r.source),
      count: Number(r.cnt || 0),
      pct: pct(Number(r.cnt || 0)),
      avg_score: Number(r.avg_score || 0),
      revenue_vnd: Number(r.revenue_vnd || 0),
    })),
    top_ad_attribution: adRows.rows.map((r) => ({
      campaign_name: String(r.campaign_name),
      utm_source: String(r.utm_source),
      utm_medium: String(r.utm_medium),
      ad_name: String(r.ad_name),
      leads_count: Number(r.leads_count || 0),
      won_count: Number(r.won_count || 0),
      revenue_vnd: Number(r.revenue_vnd || 0),
    })),
    pipeline_stages: stageRows.rows.map((r) => ({
      stage_id: r.stage_id || null,
      stage_name: String(r.stage_name),
      color_hex: String(r.color_hex || '#64748b'),
      count: Number(r.cnt || 0),
      pct: pct(Number(r.cnt || 0)),
      revenue_vnd: Number(r.revenue_vnd || 0),
    })),
    engagement_tiers: [
      { tier: 'hot', label: 'Nóng (Hot ≥ 70)', count: Number(sRow.hot_count || 0), pct: pct(Number(sRow.hot_count || 0)), color: '#ef4444' },
      { tier: 'warm', label: 'Ấm (Warm 30-69)', count: Number(sRow.warm_count || 0), pct: pct(Number(sRow.warm_count || 0)), color: '#f59e0b' },
      { tier: 'cold', label: 'Lạnh (Cold < 30)', count: Number(sRow.cold_count || 0), pct: pct(Number(sRow.cold_count || 0)), color: '#3b82f6' },
      { tier: 'suppressed', label: 'Bị chặn / Hủy nhận', count: suppressedCount, pct: pct(suppressedCount), color: '#64748b' },
    ],
    growth_trend_14d: growthTrend14d,
  };
}
