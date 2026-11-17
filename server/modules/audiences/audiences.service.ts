import crypto from 'node:crypto';
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

export async function evaluateAllDynamicAudiencesForTenant(tenantId: string): Promise<void> {
  if (!tenantId) return;

  // Fast-skip when tenant is known to have 0 active `dynamic_logic` audiences (0 DB checkouts)
  const cachedCount = tenantRedis.getCachedDynamicAudienceCount(tenantId);
  if (cachedCount === 0) {
    return;
  }

  const existingInFlight = inFlightTenantDynamicEval.get(tenantId);
  if (existingInFlight) {
    existingInFlight.rerun = true;
    await existingInFlight.promise;
    return;
  }

  const state = { promise: Promise.resolve(), rerun: false };
  const runner = (async () => {
    try {
      do {
        state.rerun = false;
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
      } while (state.rerun);
    } finally {
      inFlightTenantDynamicEval.delete(tenantId);
    }
  })();

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
  if (normalizedPhone) {
    const byPhone = await client.query<{ id: string }>(
      'SELECT id FROM leads WHERE tenant_id = $1 AND phone = $2 AND is_deleted = false ORDER BY created_at DESC LIMIT 1',
      [tenantId, normalizedPhone]
    );
    existingId = byPhone.rows[0]?.id || null;
  }
  if (!existingId && cleanEmail) {
    const byEmail = await client.query<{ id: string }>(
      'SELECT id FROM leads WHERE tenant_id = $1 AND LOWER(email) = $2 AND is_deleted = false ORDER BY created_at DESC LIMIT 1',
      [tenantId, cleanEmail]
    );
    existingId = byEmail.rows[0]?.id || null;
  }

  const customFields: Record<string, unknown> =
    rawItem.custom_fields && typeof rawItem.custom_fields === 'object'
      ? { ...rawItem.custom_fields }
      : {};
  for (const [k, v] of Object.entries(rawItem)) {
    if (k.startsWith('cf_') && v !== undefined && v !== '') {
      customFields[k.slice(3)] = v;
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
        Object.keys(customFields).length > 0,
        JSON.stringify(customFields),
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

        await client.query(
          `INSERT INTO tenant_audience_members (id, tenant_id, audience_id, lead_id, source_type, metadata)
           VALUES ($1, $2, $3, $4, 'csv', '{}'::jsonb)
           ON CONFLICT (tenant_id, audience_id, lead_id) DO NOTHING`,
          [crypto.randomUUID(), tenantId, audienceId, upserted.leadId]
        );
        importedLeadIds.push(upserted.leadId);
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
    };
  });

  // Trigger dynamic segment evaluation once after bulk import
  await evaluateAllDynamicAudiencesForTenant(tenantId);
  if (targetStatus === 'unassigned_pending' && summary.imported_count > 0) {
    await runUnassignedLeadDrainer(tenantId).catch(() => {});
  }

  return summary;
}

/**
 * Splits an existing Audience randomly into N sub-audiences (A/B/N testing)
 */
export async function splitAudienceIntoParts(
  tenantId: string,
  audienceId: string,
  options: {
    ratios?: number[];
    ratio_a?: number;
    parts?: number;
    count_parts?: number;
    name_prefix?: string;
    actorId?: string;
  }
) {
  return withTenantTransaction(tenantId, async (client) => {
    const audRes = await client.query<{ id: string; name: string; color_hex: string }>(
      'SELECT id, name, color_hex FROM tenant_audiences WHERE tenant_id = $1 AND id = $2 LIMIT 1',
      [tenantId, audienceId]
    );
    const sourceAud = audRes.rows[0];
    if (!sourceAud) throw new Error('AUDIENCE_NOT_FOUND');

    const membersRes = await client.query<{ lead_id: string }>(
      `SELECT tam.lead_id
       FROM tenant_audience_members tam
       INNER JOIN leads l ON l.tenant_id = tam.tenant_id AND l.id = tam.lead_id
       WHERE tam.tenant_id = $1 AND tam.audience_id = $2 AND l.is_deleted = false`,
      [tenantId, audienceId]
    );

    const shuffled = membersRes.rows.map((r) => r.lead_id);
    for (let i = shuffled.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
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
    const prefix = (options.name_prefix || sourceAud.name).trim();
    const createdSubAudiences: any[] = [];
    let cursor = 0;

    for (let idx = 0; idx < weights.length; idx++) {
      const isLast = idx === weights.length - 1;
      const sliceCount = isLast
        ? shuffled.length - cursor
        : Math.round((shuffled.length * weights[idx]) / totalWeight);
      const bucketIds = shuffled.slice(cursor, cursor + Math.max(0, sliceCount));
      cursor += bucketIds.length;

      const labelSuffix = String.fromCharCode(65 + idx); // A, B, C...
      const pctLabel = Math.round((weights[idx] / totalWeight) * 100);
      const subId = crypto.randomUUID();
      const subName = `${prefix} — Nhánh ${labelSuffix} (${pctLabel}%)`;

      await client.query(
        `INSERT INTO tenant_audiences (
           id, tenant_id, name, description, audience_type, filter_branches,
           cached_member_count, color_hex, is_active, created_by
         ) VALUES ($1, $2, $3, $4, 'static_data', '[]'::jsonb, $5, $6, true, $7)`,
        [
          subId,
          tenantId,
          subName,
          `Tách ngẫu nhiên A/B từ tệp "${sourceAud.name}"`,
          bucketIds.length,
          sourceAud.color_hex || '#1E40FF',
          options.actorId || null,
        ]
      );

      for (const lid of bucketIds) {
        await client.query(
          `INSERT INTO tenant_audience_members (id, tenant_id, audience_id, lead_id, source_type, metadata)
           VALUES ($1, $2, $3, $4, 'ab_split', $5::jsonb)
           ON CONFLICT (tenant_id, audience_id, lead_id) DO NOTHING`,
          [
            crypto.randomUUID(),
            tenantId,
            subId,
            lid,
            JSON.stringify({ parent_audience_id: audienceId, variant: labelSuffix }),
          ]
        );
      }

      const subRow = await client.query('SELECT * FROM tenant_audiences WHERE tenant_id = $1 AND id = $2', [
        tenantId,
        subId,
      ]);
      createdSubAudiences.push(subRow.rows[0]);
    }

    return {
      parent_audience_id: audienceId,
      total_split_members: shuffled.length,
      created_audiences: createdSubAudiences,
      items: createdSubAudiences,
      created: createdSubAudiences,
    };
  });
}
