import { getDatabasePool, type DbClient } from '../core/database/db-adapter.ts';
import { withTenantTransaction } from '../core/database/transaction.ts';
import { tenantRedis, type CachedGatekeeperConfig } from '../core/cache/tenant-redis.ts';
import {
  flattenCustomFieldVars,
  renderTemplateString,
  resolveTenantBrandName,
  isSafeRegexPattern,
  safeRegexTest,
  DEFAULT_TENANT_SETTINGS,
  type DistributionMode,
  type TenantSettings,
} from '../core/settings/tenant-settings.ts';
import {
  getGatekeeperPreflightCached,
  getTenantBlacklistCached,
  getTenantDistributionSnapshotCached,
  getTenantMetaCached,
  getTenantSettingsCached,
} from '../core/settings/tenant-cache.ts';
import { validateAndNormalizePhone } from './phone.service.ts';
import { dispatchStageCapiEventDetached } from './capi.service.ts';
import { sendTenantEmailNotification, renderEmailHtmlEnvelope } from './zalo-mail.service.ts';
import { enforceTenantOperationalPolicy } from './billing.service.ts';
import { resolveTenantTelegramConfig, sendTelegramNotification } from './telegram.service.ts';
import { isOutboundSilentMode } from '../core/security/outbound-guard.ts';
import { emitDomainEventDetached } from '../core/events/event-bus.ts';
import { resolveDecryptedSharedAiConfig } from './dom-meta-report.service.ts';
import {
  evaluateLeadGatekeeperWithGemini,
  hasLeadAiScreenerTestFetcher,
} from './ai-screener.service.ts';

export interface CandidateConsultant {
  round_consultant_id: string;
  user_id: string;
  full_name: string;
  email: string;
  zalo_chat_id: string | null;
  receive_ratio: number;
  data_per_turn: number;
  leads_received_in_round: number;
  compensation_count: number;
  skipped_credit: number;
  status: string;
  is_available: boolean;
  vacation_mode: boolean;
  work_schedule: Record<string, { active?: boolean; start?: string; end?: string }>;
}

export interface SelectConsultantOptions {
  distribution_mode?: DistributionMode;
  enable_compensation_credits?: boolean;
  enable_vacation_credits?: boolean;
  active_load_by_user?: Record<string, number>;
}

const JS_DAY_TO_KEY: Record<number, { name: string; num: string }> = {
  0: { name: 'sunday', num: '7' },
  1: { name: 'monday', num: '1' },
  2: { name: 'tuesday', num: '2' },
  3: { name: 'wednesday', num: '3' },
  4: { name: 'thursday', num: '4' },
  5: { name: 'friday', num: '5' },
  6: { name: 'saturday', num: '6' },
};

export function isWithinWorkSchedule(
  schedule: Record<string, { active?: boolean; start?: string; end?: string }> | null | undefined,
  referenceDate: Date = new Date(),
  timezoneOffsetHours = 7
): boolean {
  if (!schedule || Object.keys(schedule).length === 0) return true;

  const offsetHours = Number.isFinite(timezoneOffsetHours) ? timezoneOffsetHours : 7;
  const localTime = new Date(referenceDate.getTime() + offsetHours * 3600 * 1000);
  const dayInfo = JS_DAY_TO_KEY[localTime.getUTCDay()];
  const slot = schedule[dayInfo.name] || schedule[dayInfo.num];
  if (!slot) return true;
  if (slot.active === false) return false;

  const hh = String(localTime.getUTCHours()).padStart(2, '0');
  const mm = String(localTime.getUTCMinutes()).padStart(2, '0');
  const currentHm = `${hh}:${mm}`;
  const start = slot.start || '00:00';
  const end = slot.end || '23:59';

  return currentHm >= start && currentHm <= end;
}

/**
 * Pure Fair-Share Consultant Selection Algorithm:
 * Phase 1: Priority Compensation Credits (`compensation_count > 0`, when enabled)
 * Phase 2: Vacation Skipped Credits (`skipped_credit > 0`, when enabled)
 * Phase 3: Mid-Turn Batch Completion (`data_per_turn > 1` and `leads_received_in_round % data_per_turn !== 0`)
 * Phase 4: Configurable Mode (`weighted_round_robin` | `strict_round_robin` | `least_loaded` | `manual_only`)
 */
export function selectNextConsultant(
  candidates: CandidateConsultant[],
  options?: SelectConsultantOptions
): {
  selected: CandidateConsultant;
  reason:
    | 'compensation_credit'
    | 'skipped_credit'
    | 'batch_turn'
    | 'weighted_round_robin'
    | 'strict_round_robin'
    | 'least_loaded';
} | null {
  if (candidates.length === 0) return null;

  const mode = options?.distribution_mode || 'weighted_round_robin';
  if (mode === 'manual_only') {
    return null;
  }

  const allowCompensation = options?.enable_compensation_credits !== false;
  const allowVacation = options?.enable_vacation_credits !== false;

  if (allowCompensation) {
    const compensating = candidates.filter((c) => c.compensation_count > 0);
    if (compensating.length > 0) {
      compensating.sort((a, b) => b.compensation_count - a.compensation_count || a.user_id.localeCompare(b.user_id));
      return { selected: compensating[0], reason: 'compensation_credit' };
    }
  }

  if (allowVacation) {
    const skipped = candidates.filter((c) => c.skipped_credit > 0);
    if (skipped.length > 0) {
      skipped.sort((a, b) => b.skipped_credit - a.skipped_credit || a.user_id.localeCompare(b.user_id));
      return { selected: skipped[0], reason: 'skipped_credit' };
    }
  }

  // Finish active batch if a consultant has data_per_turn > 1 and is mid-turn
  const midBatch = candidates.filter((c) => {
    const perTurn = Math.max(1, Number(c.data_per_turn || 1));
    return perTurn > 1 && c.leads_received_in_round > 0 && c.leads_received_in_round % perTurn !== 0;
  });
  if (midBatch.length > 0) {
    midBatch.sort((a, b) => a.leads_received_in_round - b.leads_received_in_round || a.user_id.localeCompare(b.user_id));
    return { selected: midBatch[0], reason: 'batch_turn' };
  }

  if (mode === 'least_loaded') {
    const loadMap = options?.active_load_by_user || {};
    const sortedLeast = [...candidates].sort((a, b) => {
      const loadA = loadMap[a.user_id] ?? a.leads_received_in_round;
      const loadB = loadMap[b.user_id] ?? b.leads_received_in_round;
      if (loadA !== loadB) return loadA - loadB;
      const ratioA = Math.max(1, a.receive_ratio || 1);
      const ratioB = Math.max(1, b.receive_ratio || 1);
      const scoreA = a.leads_received_in_round / ratioA;
      const scoreB = b.leads_received_in_round / ratioB;
      if (Math.abs(scoreA - scoreB) > 1e-9) return scoreA - scoreB;
      return a.user_id.localeCompare(b.user_id);
    });
    return { selected: sortedLeast[0], reason: 'least_loaded' };
  }

  if (mode === 'strict_round_robin') {
    const sortedStrict = [...candidates].sort((a, b) => {
      if (a.leads_received_in_round !== b.leads_received_in_round) {
        return a.leads_received_in_round - b.leads_received_in_round;
      }
      return a.user_id.localeCompare(b.user_id);
    });
    return { selected: sortedStrict[0], reason: 'strict_round_robin' };
  }

  const sorted = [...candidates].sort((a, b) => {
    const ratioA = Math.max(1, a.receive_ratio || 1);
    const ratioB = Math.max(1, b.receive_ratio || 1);
    const scoreA = a.leads_received_in_round / ratioA;
    const scoreB = b.leads_received_in_round / ratioB;
    if (Math.abs(scoreA - scoreB) > 1e-9) {
      return scoreA - scoreB;
    }
    if (a.leads_received_in_round !== b.leads_received_in_round) {
      return a.leads_received_in_round - b.leads_received_in_round;
    }
    return a.user_id.localeCompare(b.user_id);
  });

  return { selected: sorted[0], reason: 'weighted_round_robin' };
}

export interface RoutingConditionItem {
  field?: string;
  op?: string;
  operator?: string;
  val?: unknown;
  value?: unknown;
  match_mode?: 'all' | 'any';
}

export function matchesRoutingConditions(
  rawConditions:
    | RoutingConditionItem[]
    | { match_mode?: 'all' | 'any'; conditions?: RoutingConditionItem[]; rules?: RoutingConditionItem[] }
    | null
    | undefined,
  leadPayload: Record<string, unknown>
): boolean {
  let matchMode: 'all' | 'any' = 'all';
  let conditions: RoutingConditionItem[] = [];

  if (Array.isArray(rawConditions)) {
    conditions = rawConditions;
    if (conditions[0]?.match_mode === 'any') {
      matchMode = 'any';
    }
  } else if (rawConditions && typeof rawConditions === 'object') {
    matchMode = rawConditions.match_mode === 'any' ? 'any' : 'all';
    conditions = Array.isArray(rawConditions.conditions)
      ? rawConditions.conditions
      : Array.isArray(rawConditions.rules)
        ? rawConditions.rules
        : [];
  }

  if (conditions.length === 0) return false;

  const evaluateSingle = (cond: RoutingConditionItem): boolean => {
    if (!cond.field) return true;
    const cleanField = cond.field.replace(/^custom\./, '');
    const rawActual =
      leadPayload[cond.field] ??
      leadPayload[cleanField] ??
      (leadPayload.custom_fields && typeof leadPayload.custom_fields === 'object'
        ? (leadPayload.custom_fields as Record<string, unknown>)[cond.field] ??
          (leadPayload.custom_fields as Record<string, unknown>)[cleanField]
        : undefined);
    const actualStr = String(rawActual ?? '').trim();
    const actual = actualStr.toLowerCase();
    const rawExpected = cond.val !== undefined ? cond.val : cond.value;
    const expectedStr = String(rawExpected ?? '').trim();
    const expected = expectedStr.toLowerCase();
    const op = String(cond.op || cond.operator || 'equals').trim().toLowerCase();

    switch (op) {
      case 'contains':
        return actual.includes(expected);
      case 'not_contains':
      case 'notcontains':
        return !actual.includes(expected);
      case 'starts_with':
      case 'startswith':
        return actual.startsWith(expected);
      case 'ends_with':
      case 'endswith':
        return actual.endsWith(expected);
      case 'not_equals':
      case 'neq':
      case '!=':
        return actual !== expected;
      case 'in': {
        const list = Array.isArray(rawExpected)
          ? rawExpected.map((v) => String(v).trim().toLowerCase())
          : expected
              .split(',')
              .map((v) => v.trim())
              .filter(Boolean);
        return list.includes(actual);
      }
      case 'not_in':
      case 'notin': {
        const list = Array.isArray(rawExpected)
          ? rawExpected.map((v) => String(v).trim().toLowerCase())
          : expected
              .split(',')
              .map((v) => v.trim())
              .filter(Boolean);
        return !list.includes(actual);
      }
      case 'gt':
      case '>': {
        const nA = Number(actualStr);
        const nE = Number(expectedStr);
        return Number.isFinite(nA) && Number.isFinite(nE) && nA > nE;
      }
      case 'gte':
      case '>=': {
        const nA = Number(actualStr);
        const nE = Number(expectedStr);
        return Number.isFinite(nA) && Number.isFinite(nE) && nA >= nE;
      }
      case 'lt':
      case '<': {
        const nA = Number(actualStr);
        const nE = Number(expectedStr);
        return Number.isFinite(nA) && Number.isFinite(nE) && nA < nE;
      }
      case 'lte':
      case '<=': {
        const nA = Number(actualStr);
        const nE = Number(expectedStr);
        return Number.isFinite(nA) && Number.isFinite(nE) && nA <= nE;
      }
      case 'regex': {
        if (!expectedStr) return false;
        return safeRegexTest(expectedStr, actualStr, 'i');
      }
      case 'is_empty':
      case 'empty':
        return actualStr.length === 0;
      case 'is_not_empty':
      case 'not_empty':
        return actualStr.length > 0;
      case 'eq':
      case '=':
      case 'equals':
      default:
        return actual === expected;
    }
  };

  return matchMode === 'any' ? conditions.some(evaluateSingle) : conditions.every(evaluateSingle);
}

export function matchesRoutingBranches(
  conditionBranches: unknown,
  fallbackConditionsJson: unknown,
  leadPayload: Record<string, unknown>,
  connectionScopes?: unknown,
  connectionId?: string | number | null,
  sourceHint?: string
): boolean {
  // 1. Check connection_scopes if provided
  if (Array.isArray(connectionScopes) && connectionScopes.length > 0 && !connectionScopes.includes('all')) {
    const scopeStrs = connectionScopes.map((s) => String(s));
    const connStr = connectionId !== undefined && connectionId !== null ? String(connectionId) : '';
    const srcLower = String(sourceHint || leadPayload.source || '').toLowerCase();
    const isSheet = srcLower.includes('sheet');
    const isManual = srcLower.includes('manual') || srcLower.includes('quick');
    const isWebhook = !isSheet && !isManual;
    const matchesScope =
      (connStr && scopeStrs.includes(connStr)) ||
      (isSheet && scopeStrs.includes('-1')) ||
      (isWebhook && scopeStrs.includes('-2')) ||
      (isManual && scopeStrs.includes('-3'));
    if (!matchesScope) return false;
  }

  // 2. Evaluate OR-of-AND branches if present
  if (Array.isArray(conditionBranches) && conditionBranches.length > 0) {
    return conditionBranches.some((branch) => {
      if (Array.isArray(branch)) {
        return matchesRoutingConditions(branch as RoutingConditionItem[], leadPayload);
      }
      if (branch && typeof branch === 'object' && Array.isArray((branch as any).conditions)) {
        return matchesRoutingConditions(
          { match_mode: 'all', conditions: (branch as any).conditions },
          leadPayload
        );
      }
      return false;
    });
  }

  return matchesRoutingConditions(fallbackConditionsJson as any, leadPayload);
}

export interface LeadIngestInput {
  name?: string;
  phone: string;
  email?: string;
  source?: string;
  campaign?: string;
  product_interest?: string;
  budget_range?: string;
  utm_source?: string;
  utm_medium?: string;
  utm_content?: string;
  ad_id?: string;
  adset_id?: string;
  campaign_id?: string;
  form_id?: string;
  connection_id?: string;
  integration_type?: string;
  meta_lead_id?: string;
  fbclid?: string;
  fbc?: string;
  fbp?: string;
  custom_fields?: Record<string, unknown>;
  note?: string;
  pipeline_id?: string;
  force_assigned_to?: string;
  skip_gatekeeper?: boolean;
  skip_blacklist?: boolean;
}

export interface LeadIngestResult {
  leadId: string;
  phoneNormalized: string;
  status: 'assigned' | 'unassigned_pending';
  assignedTo: string | null;
  assignedName: string | null;
  roundId?: string | null;
  isDuplicateReminder: boolean;
  dispatchReason: string;
  distributionLatencyMs: number;
  held?: boolean;
  heldReason?: string;
}

export function validateAndSanitizeCustomFields(
  defs: Array<{
    field_key: string;
    field_label: string;
    field_type: string;
    is_required: boolean;
    options_json: string[];
    config_json?: Record<string, unknown> | null;
  }>,
  rawCustomFields: Record<string, unknown> | undefined
): Record<string, unknown> {
  const result: Record<string, unknown> = { ...(rawCustomFields || {}) };

  for (const cf of defs) {
    const cfg = cf.config_json && typeof cf.config_json === 'object' ? cf.config_json : {};
    let val = result[cf.field_key];

    if ((val === undefined || val === null || val === '') && cfg.default_value !== undefined && cfg.default_value !== '') {
      val = cfg.default_value;
      result[cf.field_key] = val;
    }

    const isEmpty =
      val === undefined ||
      val === null ||
      val === '' ||
      (Array.isArray(val) && val.length === 0);

    if (cf.is_required && isEmpty) {
      throw new Error(`CUSTOM_FIELD_REQUIRED: Trường '${cf.field_label}' (${cf.field_key}) là bắt buộc`);
    }

    if (isEmpty) continue;

    if (cf.field_type === 'select' && Array.isArray(cf.options_json) && cf.options_json.length > 0) {
      if (!cf.options_json.includes(String(val))) {
        throw new Error(`CUSTOM_FIELD_INVALID_OPTION: Giá trị '${val}' không hợp lệ cho '${cf.field_label}'`);
      }
    }

    if (cf.field_type === 'multiselect') {
      const arr = Array.isArray(val)
        ? val.map((v) => String(v).trim()).filter(Boolean)
        : String(val)
            .split(',')
            .map((v) => v.trim())
            .filter(Boolean);
      if (cf.is_required && arr.length === 0) {
        throw new Error(`CUSTOM_FIELD_REQUIRED: Trường '${cf.field_label}' (${cf.field_key}) là bắt buộc`);
      }
      if (Array.isArray(cf.options_json) && cf.options_json.length > 0) {
        for (const item of arr) {
          if (!cf.options_json.includes(item)) {
            throw new Error(`CUSTOM_FIELD_INVALID_OPTION: Giá trị '${item}' không hợp lệ cho '${cf.field_label}'`);
          }
        }
      }
      result[cf.field_key] = arr;
    }

    if (cf.field_type === 'number' || cf.field_type === 'currency') {
      const numVal = typeof val === 'number' ? val : Number(String(val).replace(/,/g, ''));
      if (!Number.isFinite(numVal)) {
        throw new Error(`CUSTOM_FIELD_INVALID_NUMBER: Giá trị '${val}' của '${cf.field_label}' phải là số`);
      }
      if (cfg.min !== undefined && cfg.min !== '' && Number.isFinite(Number(cfg.min)) && numVal < Number(cfg.min)) {
        throw new Error(`CUSTOM_FIELD_MIN_ERROR: '${cf.field_label}' tối thiểu là ${cfg.min}`);
      }
      if (cfg.max !== undefined && cfg.max !== '' && Number.isFinite(Number(cfg.max)) && numVal > Number(cfg.max)) {
        throw new Error(`CUSTOM_FIELD_MAX_ERROR: '${cf.field_label}' tối đa là ${cfg.max}`);
      }
      result[cf.field_key] = numVal;
    }

    if (cf.field_type === 'boolean') {
      result[cf.field_key] = val === true || val === 'true' || val === 1 || val === '1';
    }

    if (cf.field_type === 'date') {
      const parsedDate = Date.parse(String(val));
      if (Number.isNaN(parsedDate)) {
        throw new Error(`CUSTOM_FIELD_INVALID_DATE: Ngày '${val}' không hợp lệ cho '${cf.field_label}'`);
      }
    }

    if (typeof cfg.regex === 'string' && cfg.regex.trim()) {
      const pattern = cfg.regex.trim();
      if (isSafeRegexPattern(pattern) && !safeRegexTest(pattern, String(val))) {
        throw new Error(`CUSTOM_FIELD_REGEX_MISMATCH: Giá trị '${cf.field_label}' không đúng định dạng quy định`);
      }
    }
  }

  return result;
}

/**
 * High-Throughput Lead Intake, Configurable Duplicate Policy & Fair-Share Distribution Engine.
 * Enforces Two-Tier Concurrency Serialization:
 * 1. Distributed Phone Lock (`lock:tenant:{tenant_id}:phone:{phone}`)
 * 2. PostgreSQL Transactional Advisory Lock (`pg_advisory_xact_lock(hashtext(tenant_id || ':' || phone))`)
 */
export async function ingestAndDistributeLead(
  tenantId: string,
  input: LeadIngestInput
): Promise<LeadIngestResult> {
  const startedAt = Date.now();

  // Pre-load tenant phone validation rules from isolated hot cache (zero extra DB transaction on cache hit)
  const preloadedTenant = await getTenantMetaCached(tenantId);
  const preCfg = preloadedTenant ? preloadedTenant.settings : DEFAULT_TENANT_SETTINGS;

  const phoneCheck = validateAndNormalizePhone(input.phone, {
    default_dial_code: preCfg.default_dial_code,
    allow_international_phones: preCfg.allow_international_phones,
    allow_landline_phones: preCfg.allow_landline_phones,
    vn_mobile_prefixes: preCfg.vn_mobile_prefixes,
    custom_phone_regex: preCfg.custom_phone_regex,
    block_repeated_digits: preCfg.block_repeated_digits,
  });
  if (!phoneCheck.valid) {
    throw new Error(`INVALID_PHONE: ${phoneCheck.reason}`);
  }
  const normalizedPhone = phoneCheck.normalizedE164;
  let postCommitSla: { deadlineMs: number; member: string } | null = null;
  let postCommitCapi: Parameters<typeof dispatchStageCapiEventDetached>[0] | null = null;
  let postCommitAssignedEmail: string | null = null;
  let postCommitStageId: string | null = null;
  let insertedNewLead = false;

  interface AiScreenerOutcome {
    status: string;
    evaluation: string | null;
    usedFallback: boolean;
    holdDecision: 'hold' | 'reject' | null;
    score: number;
    promptTokens: number;
    completionTokens: number;
  }

  let preflightGk: CachedGatekeeperConfig | null = null;
  let localRuleHit: string | null = null;
  let aiOutcome: AiScreenerOutcome = {
    status: 'not_screened',
    evaluation: null,
    usedFallback: false,
    holdDecision: null,
    score: 0,
    promptTokens: 0,
    completionTokens: 0,
  };

  const evaluateManualRulesMatch = (manualRulesRaw: unknown[]): string | null => {
    const checkPayload: Record<string, unknown> = {
      ...(input as unknown as Record<string, unknown>),
      phone: normalizedPhone,
      custom_fields: input.custom_fields || {},
    };
    for (const mr of manualRulesRaw) {
      if (mr && typeof mr === 'object') {
        const mrObj = mr as Record<string, unknown>;
        const ruleConditions = Array.isArray(mrObj.conditions) ? mrObj.conditions : [mrObj];
        if (matchesRoutingConditions(ruleConditions, checkPayload)) {
          return String(mrObj.reason || mrObj.label || 'Không đạt tiêu chuẩn Gatekeeper');
        }
      }
    }
    return null;
  };

  if (!input.skip_gatekeeper) {
    const preflight = await getGatekeeperPreflightCached(tenantId, resolveDecryptedSharedAiConfig);
    preflightGk = preflight.gk;

    if (preflightGk && preflightGk.is_enabled) {
      const manualRules = Array.isArray(preflightGk.manual_rules) ? preflightGk.manual_rules : [];
      localRuleHit = evaluateManualRulesMatch(manualRules);

      if (preflight.sharedAi) {
        if (!preflight.sharedAi.aiLeadEvalEnabled) {
          aiOutcome = {
            status: 'not_screened',
            evaluation: 'AI Lead Eval đang tắt (fallback thủ công)',
            usedFallback: true,
            holdDecision: null,
            score: 0,
            promptTokens: 0,
            completionTokens: 0,
          };
        } else if (!localRuleHit) {
          if (!preflight.sharedAi.apiKey) {
            aiOutcome = {
              status: 'not_screened',
              evaluation: 'Chưa cấu hình Gemini API Key (fallback thủ công)',
              usedFallback: true,
              holdDecision: null,
              score: 0,
              promptTokens: 0,
              completionTokens: 0,
            };
          } else if (isOutboundSilentMode() && !hasLeadAiScreenerTestFetcher()) {
            aiOutcome = {
              status: 'not_screened',
              evaluation: 'Silent mode (fallback thủ công)',
              usedFallback: true,
              holdDecision: null,
              score: 0,
              promptTokens: 0,
              completionTokens: 0,
            };
          } else {
            // Execute fast Gemini JSON evaluation strictly OUTSIDE any DB lock/transaction
            const aiRes = await evaluateLeadGatekeeperWithGemini({
              apiKey: preflight.sharedAi.apiKey,
              model: preflight.sharedAi.model || preflightGk.model_name,
              promptRules: preflightGk.prompt_rules,
              lead: {
                name: input.name,
                phone: normalizedPhone,
                email: input.email,
                source: input.source,
                campaign: input.campaign,
                product_interest: input.product_interest,
                budget_range: input.budget_range,
                note: input.note,
                custom_fields: input.custom_fields || {},
              },
              timeoutMs: 2_500,
            });

            if (aiRes.ok) {
              if (aiRes.decision === 'hold' || aiRes.decision === 'reject') {
                aiOutcome = {
                  status: 'failed',
                  evaluation: aiRes.reason,
                  usedFallback: false,
                  holdDecision: aiRes.decision,
                  score: aiRes.score,
                  promptTokens: aiRes.promptTokens,
                  completionTokens: aiRes.completionTokens,
                };
              } else {
                aiOutcome = {
                  status: 'passed',
                  evaluation: aiRes.reason,
                  usedFallback: false,
                  holdDecision: null,
                  score: aiRes.score,
                  promptTokens: aiRes.promptTokens,
                  completionTokens: aiRes.completionTokens,
                };
              }
            } else {
              aiOutcome = {
                status: 'fallback_manual',
                evaluation: aiRes.reason,
                usedFallback: true,
                holdDecision: null,
                score: 0,
                promptTokens: 0,
                completionTokens: 0,
              };
            }
          }
        }
      }
    }
  }

  const outcome = await tenantRedis.withLock(tenantId, `phone:${normalizedPhone}`, 3000, async () => {
    return withTenantTransaction(tenantId, async (client) => {
      // Kernel-level transactional advisory lock prevents duplicate race conditions (skipped on embedded single-process PGlite where tenantRedis.withLock + checkoutChain already serialize)
      if (!getDatabasePool().isEmbedded) {
        await client.query("SELECT pg_advisory_xact_lock(hashtext($1 || ':' || $2))", [
          tenantId,
          normalizedPhone,
        ]);
      }

      const tenantMeta = preloadedTenant || (await getTenantMetaCached(tenantId, client));
      if (!tenantMeta) {
        throw new Error('TENANT_NOT_FOUND');
      }

      await enforceTenantOperationalPolicy(client, tenantId, 'ingest_lead');

      const cfg: TenantSettings = tenantMeta.settings;
      const duplicateDays = cfg.duplicate_threshold_days;
      const duplicateAction = cfg.duplicate_action;
      const enforceSchedule = cfg.enforce_work_schedule;

      // Step A: Blacklist Check (`blacklist_entries` — phone, email, keyword, ip)
      if (!input.skip_blacklist) {
        const cleanEmail = input.email?.trim().toLowerCase() || '';
        const blSnapshot = await getTenantBlacklistCached(tenantId, client);
        let matchedBl: { id: string; entry_type: string; value: string; reason: string | null } | undefined;

        if (blSnapshot.overflow) {
          const blRes = await client.query<{ id: string; entry_type: string; value: string; reason: string | null }>(
            `SELECT id, entry_type, value, reason
             FROM blacklist_entries
             WHERE tenant_id = $1
               AND (
                 entry_type IN ('keyword', 'ip')
                 OR (entry_type = 'phone' AND value = $2)
                 OR (entry_type = 'email' AND $3 != '' AND LOWER(value) = $3)
               )`,
            [tenantId, normalizedPhone, cleanEmail]
          );
          const haystack = [
            input.name,
            normalizedPhone,
            input.email,
            input.source,
            input.campaign,
            input.note,
            input.product_interest,
            input.custom_fields ? JSON.stringify(input.custom_fields) : '',
          ]
            .filter(Boolean)
            .join(' ')
            .toLowerCase();
          matchedBl = blRes.rows.find((row) => {
            if (row.entry_type === 'phone' || row.entry_type === 'email') return true;
            const kw = String(row.value || '').trim().toLowerCase();
            return kw.length > 0 && haystack.includes(kw);
          });
        } else {
          matchedBl =
            blSnapshot.phoneMap.get(normalizedPhone) ||
            (cleanEmail ? blSnapshot.emailMap.get(cleanEmail) : undefined);
          if (!matchedBl && blSnapshot.keywordsAndIps.length > 0) {
            const haystack = [
              input.name,
              normalizedPhone,
              input.email,
              input.source,
              input.campaign,
              input.note,
              input.product_interest,
              input.custom_fields ? JSON.stringify(input.custom_fields) : '',
            ]
              .filter(Boolean)
              .join(' ')
              .toLowerCase();
            matchedBl = blSnapshot.keywordsAndIps.find((item) => haystack.includes(item.needle))?.entry;
          }
        }
        if (matchedBl) {
          const heldRes = await client.query<{ id: string }>(
            `INSERT INTO held_leads (
               tenant_id, connection_id, name, phone, email, source, campaign,
               ai_screener_status, ai_evaluation, hold_reason, status, payload_json
             ) VALUES ($1, $2, $3, $4, $5, $6, $7, 'blacklisted', $8, $9, 'blacklisted', $10::jsonb)
             RETURNING id`,
            [
              tenantId,
              input.connection_id || null,
              (input.name || '').trim() || `Khách hàng ${normalizedPhone.slice(-4)}`,
              normalizedPhone,
              input.email?.trim() || null,
              input.source?.trim() || cfg.default_lead_source,
              input.campaign?.trim() || null,
              `Khớp danh sách chặn (${matchedBl.entry_type}: ${matchedBl.value})`,
              matchedBl.reason || 'BLACKLIST_MATCH',
              JSON.stringify(input),
            ]
          );
          return {
            leadId: heldRes.rows[0].id,
            phoneNormalized: normalizedPhone,
            status: 'unassigned_pending' as const,
            assignedTo: null,
            assignedName: null,
            roundId: null,
            isDuplicateReminder: false,
            dispatchReason: 'blacklist_blocked',
            distributionLatencyMs: Math.max(1, Date.now() - startedAt),
            held: true,
            heldReason: matchedBl.reason || 'BLACKLIST_MATCH',
          };
        }
      }

      // Step B: AI Gatekeeper Check (`ai_screener_configs` when enabled)
      if (!input.skip_gatekeeper && preflightGk && preflightGk.is_enabled) {
        const gk = preflightGk;
        const manualRules = Array.isArray(gk.manual_rules) ? gk.manual_rules : [];
        let failedReason: string | null = localRuleHit ?? evaluateManualRulesMatch(manualRules);
        let holdTargetStatus: 'held' | 'rejected' = gk.manual_action === 'reject' ? 'rejected' : 'held';
        let holdDispatchReason = gk.manual_action === 'reject' ? 'ai_gatekeeper_rejected' : 'ai_gatekeeper_held';

        if (!failedReason && aiOutcome.holdDecision) {
          failedReason = aiOutcome.evaluation || 'AI Gatekeeper đánh giá Lead không đạt tiêu chuẩn';
          holdTargetStatus =
            aiOutcome.holdDecision === 'reject' || gk.manual_action === 'reject' ? 'rejected' : 'held';
          holdDispatchReason =
            holdTargetStatus === 'rejected' ? 'ai_gatekeeper_rejected' : 'ai_gatekeeper_held';
        }

        if (failedReason && (gk.manual_action === 'hold' || gk.manual_action === 'reject' || aiOutcome.holdDecision)) {
          const heldRes = await client.query<{ id: string }>(
            `INSERT INTO held_leads (
               tenant_id, connection_id, name, phone, email, source, campaign,
               ai_screener_status, ai_evaluation, hold_reason, status, payload_json
             ) VALUES ($1, $2, $3, $4, $5, $6, $7, 'failed', $8, $9, $10, $11::jsonb)
             RETURNING id`,
            [
              tenantId,
              input.connection_id || null,
              (input.name || '').trim() || `Khách hàng ${normalizedPhone.slice(-4)}`,
              normalizedPhone,
              input.email?.trim() || null,
              input.source?.trim() || cfg.default_lead_source,
              input.campaign?.trim() || null,
              failedReason,
              failedReason,
              holdTargetStatus,
              JSON.stringify({
                ...input,
                ai_score: aiOutcome.score,
                ai_prompt_tokens: aiOutcome.promptTokens,
                ai_completion_tokens: aiOutcome.completionTokens,
              }),
            ]
          );
          return {
            leadId: heldRes.rows[0].id,
            phoneNormalized: normalizedPhone,
            status: 'unassigned_pending' as const,
            assignedTo: null,
            assignedName: null,
            roundId: null,
            isDuplicateReminder: false,
            dispatchReason: holdDispatchReason,
            distributionLatencyMs: Math.max(1, Date.now() - startedAt),
            held: true,
            heldReason: failedReason,
          };
        }
      }

      // Resolve target pipeline (allowing cross-pipeline routing rules when pipeline_id is not explicitly forced)
      const distSnapshot = await getTenantDistributionSnapshotCached(tenantId, client);
      const explicitPipelineProvided = Boolean(input.pipeline_id);
      let pipelineId = input.pipeline_id;
      let preMatchedRoundId: string | null = null;
      let injectedRuleFields: Record<string, unknown> = {};
      let checkedAllRulesWithNoneActive = false;

      if (!explicitPipelineProvided && !input.force_assigned_to) {
        const crossRules = distSnapshot ? distSnapshot.activeRoutingRules : [];
        if (crossRules.length === 0) {
          checkedAllRulesWithNoneActive = true;
        }
        const preMatchPayload: Record<string, unknown> = {
          ...(input as unknown as Record<string, unknown>),
          phone: normalizedPhone,
          custom_fields: input.custom_fields || {},
        };
        for (const rule of crossRules) {
          if (
            matchesRoutingBranches(
              rule.condition_branches,
              rule.conditions_json,
              preMatchPayload,
              rule.connection_scopes,
              input.connection_id,
              input.source
            )
          ) {
            preMatchedRoundId = rule.round_id;
            pipelineId = rule.pipeline_id;
            if (rule.inject_fields && typeof rule.inject_fields === 'object') {
              injectedRuleFields = rule.inject_fields;
            }
            break;
          }
        }
      }

      if (!pipelineId) {
        pipelineId = distSnapshot?.defaultPipelineId;
      }
      if (!pipelineId) {
        throw new Error('PIPELINE_NOT_CONFIGURED');
      }

      const firstStage = distSnapshot?.firstStagesByPipeline[pipelineId];
      if (!firstStage) {
        throw new Error('PIPELINE_STAGES_EMPTY');
      }

      // Validate & sanitize custom fields on pipeline
      const customFieldDefsRows = distSnapshot?.customFieldsByPipeline[pipelineId] || [];
      const customFieldsObj = {
        ...validateAndSanitizeCustomFields(customFieldDefsRows, input.custom_fields),
        ...injectedRuleFields,
      };

      // Check configurable duplicate relationship window (`duplicate_threshold_days` & `duplicate_action`)
      const prevRes =
        duplicateDays > 0
          ? await client.query<{
              id: string;
              status: 'assigned' | 'unassigned_pending';
              assigned_to: string | null;
              created_at: string;
              custom_fields: Record<string, unknown> | null;
              consultant_name: string | null;
              consultant_email: string | null;
              consultant_status: string | null;
            }>(
              `SELECT l.id, l.status, l.assigned_to, l.created_at, l.custom_fields,
                      u.full_name AS consultant_name, u.email AS consultant_email, p.status AS consultant_status
               FROM leads l
               LEFT JOIN users u ON u.tenant_id = l.tenant_id AND u.id = l.assigned_to
               LEFT JOIN tenant_user_profiles p ON p.tenant_id = l.tenant_id AND p.user_id = l.assigned_to
               WHERE l.tenant_id = $1 AND l.phone = $2 AND l.is_deleted = false
               ORDER BY l.created_at DESC
               LIMIT 1`,
              [tenantId, normalizedPhone]
            )
          : { rows: [] };

      let assignedTo: string | null = input.force_assigned_to || null;
      let assignedName: string | null = null;
      let assignedEmail: string | null = null;
      let isDuplicateReminder = false;
      let dispatchReason = 'manual_assignment';

      if (assignedTo) {
        const forcedUserRes = await client.query<{ id: string; full_name: string; email: string }>(
          'SELECT id, full_name, email FROM users WHERE tenant_id = $1 AND id = $2 LIMIT 1',
          [tenantId, assignedTo]
        );
        if (forcedUserRes.rows[0]) {
          assignedName = forcedUserRes.rows[0].full_name;
          assignedEmail = forcedUserRes.rows[0].email;
        } else {
          assignedTo = null;
        }
      }

      if (prevRes.rows[0] && duplicateDays > 0) {
        const prev = prevRes.rows[0];
        const ageDays = (Date.now() - new Date(prev.created_at).getTime()) / (1000 * 3600 * 24);
        if (ageDays <= duplicateDays) {
          if (duplicateAction === 'reject_duplicate') {
            throw new Error(
              `DUPLICATE_LEAD_REJECTED: Số điện thoại ${phoneCheck.displayVN} đã tồn tại trong vòng ${duplicateDays} ngày`
            );
          }

          if (duplicateAction === 'update_existing') {
            const mergedCustom = {
              ...(prev.custom_fields || {}),
              ...customFieldsObj,
            };
            await client.query(
              `UPDATE leads
               SET name = COALESCE($3, name),
                   email = COALESCE($4, email),
                   source = COALESCE($5, source),
                   campaign = COALESCE($6, campaign),
                   custom_fields = $7::jsonb,
                   is_duplicate_reminder = true,
                   updated_at = clock_timestamp()
               WHERE tenant_id = $1 AND id = $2`,
              [
                tenantId,
                prev.id,
                input.name?.trim() || null,
                input.email?.trim() || null,
                input.source?.trim() || null,
                input.campaign?.trim() || null,
                JSON.stringify(mergedCustom),
              ]
            );
            const latencyMs = Math.max(1, Date.now() - startedAt);
            await client.query(
              `INSERT INTO lead_timeline_events (
                tenant_id, lead_id, event_type, event_category, actor_id, actor_role, actor_name, title, content, metadata
              ) VALUES ($1, $2, 'duplicate_reminder', 'system', $3, 'tenant_admin', $4, $5, $6, $7::jsonb)`,
              [
                tenantId,
                prev.id,
                prev.assigned_to,
                prev.consultant_name || 'AutoData Engine',
                `DUPLICATE_UPDATED: Khách cũ tương tác lại (${Math.max(0, Math.floor(ageDays))} ngày) — cập nhật hồ sơ gốc`,
                input.note || `Nguồn mới: ${input.source || cfg.default_lead_source}`,
                JSON.stringify({
                  dispatch_reason: 'duplicate_updated_existing',
                  latency_ms: latencyMs,
                  is_duplicate_reminder: true,
                }),
              ]
            );
            return {
              leadId: prev.id,
              phoneNormalized: normalizedPhone,
              status: (prev.assigned_to ? 'assigned' : 'unassigned_pending') as 'assigned' | 'unassigned_pending',
              assignedTo: prev.assigned_to,
              assignedName: prev.consultant_name,
              isDuplicateReminder: true,
              dispatchReason: 'duplicate_updated_existing',
              distributionLatencyMs: latencyMs,
            };
          }

          if (duplicateAction === 'round_robin') {
            isDuplicateReminder = true;
          } else if (!assignedTo && prev.assigned_to && prev.consultant_status === 'active') {
            // Default: 'route_to_previous_sale'
            assignedTo = prev.assigned_to;
            assignedName = prev.consultant_name;
            assignedEmail = prev.consultant_email;
            isDuplicateReminder = true;
            dispatchReason = `duplicate_reminder_${Math.max(0, Math.floor(ageDays))}d`;
          }
        }
      }

      // If not already assigned, run conditional routing rules (scoped to resolved pipeline) + Fair-Share Engine
      let resolvedRoundId: string | null = preMatchedRoundId;
      if (!assignedTo) {
        let targetRoundId: string | null = preMatchedRoundId;
        if (!targetRoundId && !checkedAllRulesWithNoneActive) {
          const pipelineRules = (distSnapshot?.activeRoutingRules || []).filter(
            (r) => r.pipeline_id === pipelineId
          );

          const matchPayload: Record<string, unknown> = {
            ...(input as unknown as Record<string, unknown>),
            phone: normalizedPhone,
            custom_fields: customFieldsObj,
          };

          for (const rule of pipelineRules) {
            if (
              matchesRoutingBranches(
                rule.condition_branches,
                rule.conditions_json,
                matchPayload,
                rule.connection_scopes,
                input.connection_id,
                input.source
              )
            ) {
              targetRoundId = rule.round_id;
              if (rule.inject_fields && typeof rule.inject_fields === 'object') {
                Object.assign(customFieldsObj, rule.inject_fields);
              }
              break;
            }
          }
        }

        if (!targetRoundId && aiOutcome.usedFallback && preflightGk?.fallback_enabled && preflightGk.fallback_round_id) {
          if (distSnapshot?.activeRoundIds.includes(preflightGk.fallback_round_id)) {
            targetRoundId = preflightGk.fallback_round_id;
            dispatchReason = 'ai_gatekeeper_fallback_round';
          }
        }

        if (!targetRoundId) {
          targetRoundId = distSnapshot?.defaultActiveRoundByPipeline[pipelineId] || null;
        }
        resolvedRoundId = targetRoundId;

        if (targetRoundId) {
          const rosterRes = await client.query<CandidateConsultant>(
            `SELECT
               rc.id AS round_consultant_id,
               rc.user_id,
               u.full_name,
               u.email,
               p.zalo_chat_id,
               rc.receive_ratio,
               rc.data_per_turn,
               rc.leads_received_in_round,
               rc.compensation_count,
               p.skipped_credit,
               p.status,
               p.is_available,
               p.vacation_mode,
               p.work_schedule
             FROM round_consultants rc
             INNER JOIN users u ON u.tenant_id = rc.tenant_id AND u.id = rc.user_id
             INNER JOIN tenant_user_profiles p ON p.tenant_id = rc.tenant_id AND p.user_id = rc.user_id
             WHERE rc.tenant_id = $1 AND rc.round_id = $2 AND rc.is_active = true
             ORDER BY rc.id ASC
             FOR UPDATE OF rc, p`,
            [tenantId, targetRoundId]
          );

          // Grant vacation skipped_credit (up to configurable vacation_credit_cap) in a single bulk UPDATE
          if (cfg.enable_vacation_credits && cfg.vacation_credit_cap > 0 && cfg.distribution_mode !== 'manual_only') {
            const vacationingIds = rosterRes.rows
              .filter(
                (c) =>
                  c.status === 'active' &&
                  c.vacation_mode === true &&
                  c.skipped_credit < cfg.vacation_credit_cap
              )
              .map((c) => c.user_id);
            if (vacationingIds.length > 0) {
              await client.query(
                `UPDATE tenant_user_profiles
                 SET skipped_credit = skipped_credit + 1
                 WHERE tenant_id = $1 AND user_id = ANY($2::uuid[])`,
                [tenantId, vacationingIds]
              );
            }
          }

          let eligible = rosterRes.rows.filter(
            (c) =>
              c.status === 'active' &&
              c.is_available === true &&
              c.vacation_mode === false &&
              (!enforceSchedule ||
                isWithinWorkSchedule(c.work_schedule, new Date(), cfg.timezone_offset_hours))
          );

          // Starvation Prevention: cap hourly leads per consultant if other eligible consultants exist
          if (cfg.starvation_prevention_enabled && cfg.starvation_max_leads_per_hour > 0 && eligible.length > 1) {
            const hourlyRes = await client.query<{ assigned_to: string; cnt: number }>(
              `SELECT assigned_to, COUNT(*)::int AS cnt
               FROM leads
               WHERE tenant_id = $1
                 AND assigned_to = ANY($2::uuid[])
                 AND created_at >= clock_timestamp() - INTERVAL '1 hour'
               GROUP BY assigned_to`,
              [tenantId, eligible.map((e) => e.user_id)]
            );
            const hourlyCounts = new Map<string, number>();
            for (const row of hourlyRes.rows) {
              hourlyCounts.set(row.assigned_to, Number(row.cnt || 0));
            }
            const underCap = eligible.filter(
              (c) => (hourlyCounts.get(c.user_id) || 0) < cfg.starvation_max_leads_per_hour
            );
            if (underCap.length > 0) {
              eligible = underCap;
            }
          }

          let activeLoadByUser: Record<string, number> | undefined;
          if (cfg.distribution_mode === 'least_loaded' && eligible.length > 0) {
            const loadRes = await client.query<{ assigned_to: string; cnt: string }>(
              `SELECT assigned_to, COUNT(*)::text AS cnt
               FROM leads l
               INNER JOIN tenant_pipeline_stages s ON s.tenant_id = l.tenant_id AND s.id = l.stage_id
               WHERE l.tenant_id = $1
                 AND l.assigned_to = ANY($2::uuid[])
                 AND s.is_won_stage = false
                 AND s.is_lost_stage = false
               GROUP BY assigned_to`,
              [tenantId, eligible.map((e) => e.user_id)]
            );
            activeLoadByUser = {};
            for (const row of loadRes.rows) {
              activeLoadByUser[row.assigned_to] = Number(row.cnt || 0);
            }
          }

          const choice = selectNextConsultant(eligible, {
            distribution_mode: cfg.distribution_mode,
            enable_compensation_credits: cfg.enable_compensation_credits,
            enable_vacation_credits: cfg.enable_vacation_credits,
            active_load_by_user: activeLoadByUser,
          });

          if (choice) {
            assignedTo = choice.selected.user_id;
            assignedName = choice.selected.full_name;
            assignedEmail = choice.selected.email;
            dispatchReason = choice.reason;

            if (choice.reason === 'compensation_credit') {
              await client.query(
                `UPDATE round_consultants
                 SET compensation_count = GREATEST(0, compensation_count - 1),
                     leads_received_in_round = leads_received_in_round + 1
                 WHERE id = $1 AND tenant_id = $2`,
                [choice.selected.round_consultant_id, tenantId]
              );
            } else if (choice.reason === 'skipped_credit') {
              await client.query(
                `UPDATE tenant_user_profiles
                 SET skipped_credit = GREATEST(0, skipped_credit - 1)
                 WHERE tenant_id = $1 AND user_id = $2`,
                [tenantId, choice.selected.user_id]
              );
              await client.query(
                `UPDATE round_consultants
                 SET leads_received_in_round = leads_received_in_round + 1
                 WHERE id = $1 AND tenant_id = $2`,
                [choice.selected.round_consultant_id, tenantId]
              );
            } else {
              await client.query(
                `UPDATE round_consultants
                 SET leads_received_in_round = leads_received_in_round + 1
                 WHERE id = $1 AND tenant_id = $2`,
                [choice.selected.round_consultant_id, tenantId]
              );
            }
          } else {
            dispatchReason =
              cfg.distribution_mode === 'manual_only'
                ? 'manual_only_queued'
                : 'zero_available_sales_queued';
          }
        }
      }

      const leadStatus = assignedTo ? 'assigned' : 'unassigned_pending';
      const autoAccept = Boolean(assignedTo && cfg.auto_accept_on_assign);
      const leadName =
        (input.name || '').trim() || `${cfg.default_lead_name_prefix} ${normalizedPhone.slice(-4)}`;
      const leadSource = input.source?.trim() || cfg.default_lead_source;

      if (assignedTo && resolvedRoundId) {
        await client.query(
          `UPDATE distribution_rounds
           SET last_assigned_consultant_id = $3, updated_at = clock_timestamp()
           WHERE tenant_id = $1 AND id = $2`,
          [tenantId, resolvedRoundId, assignedTo]
        );
      }

      const latencyMs = Math.max(1, Date.now() - startedAt);
      const timelineTitle =
        isDuplicateReminder && duplicateAction !== 'round_robin'
          ? `DUPLICATE_REMINDER: Khách cũ tương tác lại — định tuyến thẳng về ${assignedName || 'Sale cũ'}`
          : assignedTo
            ? `LEAD_DISTRIBUTED: Chia tự động (${dispatchReason}) cho ${assignedName || 'Sale'}`
            : cfg.distribution_mode === 'manual_only'
              ? 'MANUAL_QUEUE: Chế độ chia số thủ công — chờ Quản lý phân bổ'
              : 'UNASSIGNED_PENDING: Toàn bộ Sale đang bận/nghỉ — xếp hàng chờ ưu tiên';
      const timelineEventType = isDuplicateReminder ? 'duplicate_reminder' : 'lead_distributed';
      const timelineActorName = assignedName || 'AutoData Engine';
      const timelineContent =
        input.note || `Nguồn: ${leadSource}${input.campaign ? ` • Chiến dịch: ${input.campaign}` : ''}`;
      const timelineMetadataJson = JSON.stringify({
        dispatch_reason: dispatchReason,
        latency_ms: latencyMs,
        is_duplicate_reminder: isDuplicateReminder,
      });

      const leadInsertParams = [
        tenantId,
        pipelineId,
        firstStage.id,
        assignedTo,
        resolvedRoundId,
        input.connection_id || null,
        leadStatus,
        leadName,
        normalizedPhone,
        input.email?.trim() || null,
        aiOutcome.score > 0 ? aiOutcome.score : 0,
        leadSource,
        input.campaign?.trim() || null,
        input.product_interest?.trim() || null,
        input.budget_range?.trim() || null,
        input.utm_source?.trim() || null,
        input.utm_medium?.trim() || null,
        input.utm_content?.trim() || null,
        input.ad_id?.trim() || null,
        input.adset_id?.trim() || null,
        input.campaign_id?.trim() || null,
        input.form_id?.trim() || null,
        input.meta_lead_id?.trim() || null,
        input.fbclid?.trim() || null,
        input.fbc?.trim() || null,
        input.fbp?.trim() || null,
        JSON.stringify(customFieldsObj),
        autoAccept,
        autoAccept ? new Date().toISOString() : null,
        isDuplicateReminder,
        isDuplicateReminder,
        aiOutcome.status,
        aiOutcome.evaluation,
        aiOutcome.promptTokens,
        aiOutcome.completionTokens,
      ];

      let leadId: string;
      if (client.dialect === 'postgres') {
        const cteRes = await client.query<{ id: string }>(
          `WITH inserted_lead AS (
             INSERT INTO leads (
               tenant_id, pipeline_id, stage_id, assigned_to, round_id, connection_id, status,
               name, phone, email, lead_score, source, campaign, product_interest, budget_range,
               utm_source, utm_medium, utm_content, ad_id, adset_id, campaign_id, form_id,
               meta_lead_id, fbclid, fbc, fbp, custom_fields, is_accepted, accepted_at,
               is_duplicate_reminder, is_duplicated,
               ai_screener_status, ai_evaluation, ai_prompt_tokens, ai_completion_tokens
             ) VALUES (
               $1, $2, $3, $4, $5, $6, $7,
               $8, $9, $10, $11, $12, $13, $14, $15,
               $16, $17, $18, $19, $20, $21, $22,
               $23, $24, $25, $26, $27::jsonb, $28, $29,
               $30, $31,
               $32, $33, $34, $35
             ) RETURNING id
           ), inserted_timeline AS (
             INSERT INTO lead_timeline_events (
               tenant_id, lead_id, event_type, event_category, actor_id, actor_role, actor_name, title, content, metadata
             )
             SELECT
               $1, id, $36, 'system', $37, 'tenant_admin', $38, $39, $40, $41::jsonb
             FROM inserted_lead
           )
           SELECT id FROM inserted_lead`,
          [
            ...leadInsertParams,
            timelineEventType,
            assignedTo,
            timelineActorName,
            timelineTitle,
            timelineContent,
            timelineMetadataJson,
          ]
        );
        leadId = cteRes.rows[0].id;
      } else {
        const insertRes = await client.query<{ id: string }>(
          `INSERT INTO leads (
            tenant_id, pipeline_id, stage_id, assigned_to, round_id, connection_id, status,
            name, phone, email, lead_score, source, campaign, product_interest, budget_range,
            utm_source, utm_medium, utm_content, ad_id, adset_id, campaign_id, form_id,
            meta_lead_id, fbclid, fbc, fbp, custom_fields, is_accepted, accepted_at,
            is_duplicate_reminder, is_duplicated,
            ai_screener_status, ai_evaluation, ai_prompt_tokens, ai_completion_tokens
          ) VALUES (
            $1, $2, $3, $4, $5, $6, $7,
            $8, $9, $10, $11, $12, $13, $14, $15,
            $16, $17, $18, $19, $20, $21, $22,
            $23, $24, $25, $26, $27::jsonb, $28, $29,
            $30, $31,
            $32, $33, $34, $35
          ) RETURNING id`,
          leadInsertParams
        );
        leadId = insertRes.rows[0].id;

        // Append immutable event-sourced timeline record
        await client.query(
          `INSERT INTO lead_timeline_events (
            tenant_id, lead_id, event_type, event_category, actor_id, actor_role, actor_name, title, content, metadata
          ) VALUES ($1, $2, $3, 'system', $4, 'tenant_admin', $5, $6, $7, $8::jsonb)`,
          [
            tenantId,
            leadId,
            timelineEventType,
            assignedTo,
            timelineActorName,
            timelineTitle,
            timelineContent,
            timelineMetadataJson,
          ]
        );
      }
      insertedNewLead = true;

      // Prepare Stage SLA timeout & Meta CAPI signal to execute AFTER transaction commit
      const rawStageSla = Number(firstStage.sla_timeout_minutes || 0);
      const slaMin =
        rawStageSla > 0
          ? rawStageSla
          : cfg.use_default_sla_fallback && !firstStage.is_won_stage && !firstStage.is_lost_stage
            ? cfg.default_sla_minutes
            : 0;

      if (slaMin > 0 && assignedTo && !autoAccept) {
        postCommitSla = {
          deadlineMs: Date.now() + slaMin * 60 * 1000,
          member: `${leadId}:${firstStage.id}`,
        };
      }

      if (firstStage.capi_event_mapping && firstStage.capi_event_mapping !== 'Skip') {
        postCommitCapi = {
          tenantId,
          tenantSlug: tenantMeta.slug,
          eventName: firstStage.capi_event_mapping,
          tenantSettings: cfg,
          lead: {
            leadId,
            name: leadName,
            phone: normalizedPhone,
            email: input.email,
            metaLeadId: input.meta_lead_id,
            fbclid: input.fbclid,
            fbc: input.fbc,
            fbp: input.fbp,
            customFields: customFieldsObj,
          },
        };
      }

      postCommitAssignedEmail = assignedEmail;
      postCommitStageId = firstStage?.id ? String(firstStage.id) : null;

      return {
        leadId,
        phoneNormalized: normalizedPhone,
        status: leadStatus as 'assigned' | 'unassigned_pending',
        assignedTo,
        assignedName,
        roundId: resolvedRoundId,
        isDuplicateReminder,
        dispatchReason,
        distributionLatencyMs: latencyMs,
      };
    });
  });

  if (insertedNewLead) {
    tenantRedis.incrementTenantMonthlyLeadCount(tenantId, 1);
  }

  if (postCommitSla) {
    const slaItem = postCommitSla as { deadlineMs: number; member: string };
    await tenantRedis.zadd('sla_queue', slaItem.deadlineMs, slaItem.member, tenantId);
  }

  if (postCommitCapi) {
    await dispatchStageCapiEventDetached(postCommitCapi);
  }

  // Non-blocking domain events into Flow Engine & Dynamic Audiences (strictly post-commit, never blocks ingestion)
  const leadSourceForEvent = input.source?.trim() || preCfg.default_lead_source;
  if (!outcome.held && outcome.leadId) {
    const srcLower = String(leadSourceForEvent || '').toLowerCase();
    const inferredIntegrationType =
      input.integration_type?.trim().toLowerCase() ||
      (input.meta_lead_id || /meta|facebook|fb_lead|lead_ads/.test(srcLower)
        ? 'meta_lead_ads'
        : /sheet|google_sheet|gsheet/.test(srcLower)
          ? 'google_sheets'
          : /ladipage|landing/.test(srcLower)
            ? 'ladipage'
            : /form|website|web/.test(srcLower)
              ? 'form'
              : input.connection_id || /webhook|api|zapier|make/.test(srcLower)
                ? 'webhook'
                : 'manual');

    if (insertedNewLead) {
      emitDomainEventDetached('lead.created', {
        tenantId,
        leadId: outcome.leadId,
        status: outcome.status,
        source: leadSourceForEvent,
      });
    }

    if (outcome.assignedTo) {
      emitDomainEventDetached('marketing.engaged', {
        tenantId,
        leadId: outcome.leadId,
        engagementType: 'lead.assigned',
        scoreDelta: 0,
        metadata: {
          event: 'lead.assigned',
          isNewLead: insertedNewLead,
          assignmentType: insertedNewLead ? 'initial' : 'reassigned',
          source: leadSourceForEvent,
          campaign: input.campaign || null,
          utm_source: input.utm_source || null,
          utm_medium: input.utm_medium || null,
          utm_content: input.utm_content || null,
          integration_type: inferredIntegrationType,
          assigned_to: outcome.assignedTo,
          assigned_name: outcome.assignedName || null,
          round_id: outcome.roundId || null,
          stage_id: postCommitStageId,
          dispatch_reason: outcome.dispatchReason,
        },
      });
    }
  }

  // Non-blocking assignment email notification (skipped automatically in silent/test mode)
  const brandDisplayName = resolveTenantBrandName(preCfg, preloadedTenant);
  const leadDisplayName = input.name?.trim() || 'Khách hàng mới';
  const leadSourceDisplay = input.source?.trim() || preCfg.default_lead_source;
  const assignTemplateVars: Record<string, string | number | undefined | null> = {
    ...flattenCustomFieldVars((input.custom_fields && typeof input.custom_fields === 'object' ? input.custom_fields : null) || null),
    brand_name: brandDisplayName,
    customer_name: leadDisplayName,
    phone: outcome.phoneNormalized,
    source: leadSourceDisplay,
    campaign: input.campaign || '',
    round_name: String((outcome as Record<string, unknown>).roundName || outcome.dispatchReason || ''),
    sale_name: outcome.assignedName || 'Sale',
    sla_minutes: preCfg.default_sla_minutes,
    lead_id: `#${outcome.leadId.slice(0, 8)}`,
    lead_short_id: outcome.leadId.slice(0, 8),
    dispatch_reason: outcome.dispatchReason,
    status_label: outcome.status === 'assigned' ? 'Đã phân bổ' : 'Chờ phân bổ',
    accept_cmd: preCfg.telegram_accept_command || preCfg.zalo_accept_command || '/tiepnhan',
  };

  if (!isOutboundSilentMode() && outcome.status === 'assigned' && postCommitAssignedEmail && !outcome.held) {
    const recipientEmail = postCommitAssignedEmail;
    const emailSubject =
      renderTemplateString(preCfg.notification_templates.assign_email_subject, assignTemplateVars) ||
      `[${brandDisplayName}] Lead mới: ${leadDisplayName} (${outcome.phoneNormalized})`;
    const emailSummaryText =
      renderTemplateString(preCfg.notification_templates.assign_email_body, assignTemplateVars) ||
      `Chào ${outcome.assignedName || 'Sale'}, bạn vừa được phân bổ Lead mới: ${leadDisplayName} - SĐT: ${outcome.phoneNormalized} - Nguồn: ${leadSourceDisplay}.`;
    void sendTenantEmailNotification({
      tenantId,
      to: recipientEmail,
      category: 'assignment',
      subject: emailSubject,
      text: emailSummaryText,
      html: renderEmailHtmlEnvelope({
        title: `Khách hàng mới được phân bổ: ${leadDisplayName}`,
        badge: outcome.isDuplicateReminder ? 'TRÙNG LẶP • CHĂM SÓC LẠI' : 'PHÂN BỔ LEAD MỚI',
        accentColor: preCfg.brand_email_accent_color || preCfg.brand_primary_color || '#1E40FF',
        summaryText: emailSummaryText,
        rows: [
          { label: 'Khách hàng', value: leadDisplayName },
          { label: 'Số điện thoại', value: outcome.phoneNormalized },
          { label: 'Nguồn / Chiến dịch', value: `${leadSourceDisplay}${input.campaign ? ` • ${input.campaign}` : ''}` },
          { label: 'Sale phụ trách', value: outcome.assignedName || recipientEmail },
          { label: 'Lý do phân bổ', value: outcome.dispatchReason },
          { label: 'Mã Lead', value: `#${outcome.leadId.slice(0, 8)}` },
        ],
        tenantName: brandDisplayName,
        footerText: preCfg.brand_email_footer_text,
      }),
      meta: {
        lead_id: outcome.leadId,
        phone: outcome.phoneNormalized,
        assigned_to: outcome.assignedTo,
      },
    }).catch(() => undefined);
  }

  // Non-blocking notification dispatch (V-06): Detach Telegram notification so external HTTP latency / timeout
  // never blocks lead ingestion, event loops, or webhook responses.
  const { config: tgCfg } = await resolveTenantTelegramConfig(tenantId);
  if (!tgCfg.silentMode && tgCfg.enabled) {
    const renderedBotMsg = renderTemplateString(
      preCfg.notification_templates.assign_bot_message,
      assignTemplateVars
    ).trim();
    const text =
      renderedBotMsg ||
      [
        `🎯 <b>Khách hàng mới được phân bổ!</b>`,
        `• <b>Họ tên:</b> ${leadDisplayName}`,
        `• <b>Số điện thoại:</b> ${outcome.phoneNormalized}`,
        `• <b>Trạng thái:</b> ${outcome.status === 'assigned' ? 'Đã phân bổ' : 'Chờ phân bổ'}`,
        outcome.assignedName ? `• <b>Nhân viên phụ trách:</b> ${outcome.assignedName}` : '',
        `• <b>Mã Lead:</b> <code>#${outcome.leadId.slice(0, 8)}</code>`,
        `• Tiếp nhận: <code>${assignTemplateVars.accept_cmd} #${outcome.leadId.slice(0, 8)}</code>`,
      ]
        .filter(Boolean)
        .join('\n');

    void sendTelegramNotification(tenantId, text, { parseMode: 'HTML', resolvedConfig: tgCfg }).catch((teleErr: any) => {
      console.warn(
        `[DistributionService] Detached Telegram notification failed for tenant ${tenantId}, lead ${outcome.leadId}:`,
        teleErr?.message || teleErr
      );
    });
  }

  return outcome;
}

async function insertBulkLeadTimelineEvents(
  client: DbClient,
  params: {
    tenantId: string;
    leadIds: string[];
    eventType: string;
    eventCategory: string;
    actorId: string | null;
    actorRole: string;
    actorName: string;
    title: string;
    content: string;
    metadataJson: string;
  }
): Promise<void> {
  if (params.leadIds.length === 0) return;

  if (client.dialect === 'postgres') {
    await client.query(
      `INSERT INTO lead_timeline_events (
        tenant_id, lead_id, event_type, event_category, actor_id, actor_role, actor_name, title, content, metadata
      )
      SELECT $1, unnest($2::uuid[]), $3, $4, $5, $6, $7, $8, $9, $10::jsonb`,
      [
        params.tenantId,
        params.leadIds,
        params.eventType,
        params.eventCategory,
        params.actorId,
        params.actorRole,
        params.actorName,
        params.title,
        params.content,
        params.metadataJson,
      ]
    );
    return;
  }

  const CHUNK_SIZE = 200;
  for (let offset = 0; offset < params.leadIds.length; offset += CHUNK_SIZE) {
    const chunk = params.leadIds.slice(offset, offset + CHUNK_SIZE);
    const valuesClauses: string[] = [];
    const valuesParams: unknown[] = [
      params.tenantId,
      params.eventType,
      params.eventCategory,
      params.actorId,
      params.actorRole,
      params.actorName,
      params.title,
      params.content,
      params.metadataJson,
    ];
    for (const leadId of chunk) {
      const paramIdx = valuesParams.length + 1;
      valuesParams.push(leadId);
      valuesClauses.push(`($1, $${paramIdx}, $2, $3, $4, $5, $6, $7, $8, $9::jsonb)`);
    }
    await client.query(
      `INSERT INTO lead_timeline_events (
        tenant_id, lead_id, event_type, event_category, actor_id, actor_role, actor_name, title, content, metadata
      ) VALUES ${valuesClauses.join(', ')}`,
      valuesParams
    );
  }
}

/**
 * Drains `unassigned_pending` (and optionally orphaned `recalled`) leads when a sale toggles back online (`is_available = true`).
 */
export async function drainUnassignedLeads(
  tenantId: string,
  targetUserId: string,
  targetUserName: string
): Promise<number> {
  const cfg = await getTenantSettingsCached(tenantId);
  if (!cfg.auto_drain_on_online) return 0;

  return withTenantTransaction(tenantId, async (client) => {
    const allowedStatuses = cfg.drain_recalled_leads
      ? ['unassigned_pending', 'recalled']
      : ['unassigned_pending'];

    const pending = await client.query<{ id: string; stage_id: string; sla_timeout_minutes: number }>(
      `SELECT l.id, l.stage_id, COALESCE(s.sla_timeout_minutes, 0) AS sla_timeout_minutes
       FROM leads l
       LEFT JOIN tenant_pipeline_stages s ON s.tenant_id = l.tenant_id AND s.id = l.stage_id
       WHERE l.tenant_id = $1
         AND l.is_deleted = false
         AND l.status = ANY($2::varchar[])
         AND l.assigned_to IS NULL
       ORDER BY l.created_at ASC, l.id ASC
       LIMIT $3
       FOR UPDATE OF l`,
      [tenantId, allowedStatuses, cfg.queue_drain_batch_limit]
    );
    if (pending.rows.length === 0) return 0;

    const ids = pending.rows.map((r) => r.id);
    await client.query(
      `UPDATE leads
       SET assigned_to = $1, status = 'assigned', updated_at = clock_timestamp()
       WHERE tenant_id = $2 AND id = ANY($3::uuid[])`,
      [targetUserId, tenantId, ids]
    );

    const nowMs = Date.now();
    for (const row of pending.rows) {
      const slaMin =
        Number(row.sla_timeout_minutes) > 0
          ? Number(row.sla_timeout_minutes)
          : cfg.use_default_sla_fallback
            ? cfg.default_sla_minutes
            : 0;
      if (slaMin > 0) {
        await tenantRedis.zadd(
          'sla_queue',
          nowMs + slaMin * 60 * 1000,
          `${row.id}:${row.stage_id}`,
          tenantId
        );
      }
    }

    await insertBulkLeadTimelineEvents(client, {
      tenantId,
      leadIds: ids,
      eventType: 'queue_drained',
      eventCategory: 'system',
      actorId: targetUserId,
      actorRole: 'sale',
      actorName: targetUserName,
      title: `QUEUE_DRAIN: Giao tự động cho ${targetUserName} ngay khi bật trạng thái Trực tuyến`,
      content: 'Lead chờ ngoài giờ đã được phân bổ tự động.',
      metadataJson: '{}',
    });

    return ids.length;
  });
}

/**
 * Fair-Share Lead Queue Drainer (V-07):
 * Drains unassigned pending/recalled leads in round-robin fashion across active, available sales reps.
 * Caches round-robin cursor across runs to guarantee 100% fair distribution without oldest-rep bias.
 */
export async function drainUnassignedLeadsFairShare(
  tenantId: string,
  availableSales: Array<{ id: string; full_name: string }>
): Promise<number> {
  if (!availableSales || availableSales.length === 0) return 0;

  const cfg = await getTenantSettingsCached(tenantId);
  if (!cfg.auto_drain_on_online) return 0;

  const drainedAssignments: Array<{ leadId: string; assignedTo: string; assignedName: string }> = [];

  const drainedCount = await withTenantTransaction(tenantId, async (client) => {
    const allowedStatuses = cfg.drain_recalled_leads
      ? ['unassigned_pending', 'recalled']
      : ['unassigned_pending'];

    const pending = await client.query<{ id: string; stage_id: string; sla_timeout_minutes: number }>(
      `SELECT l.id, l.stage_id, COALESCE(s.sla_timeout_minutes, 0) AS sla_timeout_minutes
       FROM leads l
       LEFT JOIN tenant_pipeline_stages s ON s.tenant_id = l.tenant_id AND s.id = l.stage_id
       WHERE l.tenant_id = $1
         AND l.is_deleted = false
         AND l.status = ANY($2::varchar[])
         AND l.assigned_to IS NULL
       ORDER BY l.created_at ASC, l.id ASC
       LIMIT $3
       FOR UPDATE OF l`,
      [tenantId, allowedStatuses, cfg.queue_drain_batch_limit]
    );
    if (pending.rows.length === 0) return 0;

    // Determine round-robin starting cursor from persistent cache
    const lastSaleId = await tenantRedis.get('drain_rr_last_sale_id', tenantId);
    let startIndex = 0;
    if (lastSaleId) {
      const prevIdx = availableSales.findIndex((s) => s.id === lastSaleId);
      if (prevIdx !== -1) {
        startIndex = (prevIdx + 1) % availableSales.length;
      }
    }

    // Group pending leads by sales rep in round-robin sequence
    const groups = new Map<string, { sale: { id: string; full_name: string }; leadIds: string[] }>();
    for (let i = 0; i < pending.rows.length; i++) {
      const sale = availableSales[(startIndex + i) % availableSales.length];
      let g = groups.get(sale.id);
      if (!g) {
        g = { sale, leadIds: [] };
        groups.set(sale.id, g);
      }
      g.leadIds.push(pending.rows[i].id);
    }

    // Execute bulk assignments per sales rep
    for (const { sale, leadIds } of groups.values()) {
      await client.query(
        `UPDATE leads
         SET assigned_to = $1, status = 'assigned', updated_at = clock_timestamp()
         WHERE tenant_id = $2 AND id = ANY($3::uuid[])`,
        [sale.id, tenantId, leadIds]
      );

      await insertBulkLeadTimelineEvents(client, {
        tenantId,
        leadIds,
        eventType: 'queue_drained',
        eventCategory: 'system',
        actorId: sale.id,
        actorRole: 'sale',
        actorName: sale.full_name,
        title: `QUEUE_DRAIN: Giao tự động vòng tròn (Fair-Share Round-Robin) cho ${sale.full_name}`,
        content: 'Lead chờ trong hàng đợi đã được phân bổ công bằng.',
        metadataJson: '{}',
      });
      for (const lid of leadIds) {
        drainedAssignments.push({ leadId: lid, assignedTo: sale.id, assignedName: sale.full_name });
      }
    }

    // Schedule SLA timers
    const nowMs = Date.now();
    for (const row of pending.rows) {
      const slaMin =
        Number(row.sla_timeout_minutes) > 0
          ? Number(row.sla_timeout_minutes)
          : cfg.use_default_sla_fallback
            ? cfg.default_sla_minutes
            : 0;
      if (slaMin > 0) {
        await tenantRedis.zadd(
          'sla_queue',
          nowMs + slaMin * 60 * 1000,
          `${row.id}:${row.stage_id}`,
          tenantId
        );
      }
    }

    // Advance round-robin cursor for next drain cycle
    const lastAssignedSale = availableSales[(startIndex + pending.rows.length - 1) % availableSales.length];
    await tenantRedis.set('drain_rr_last_sale_id', lastAssignedSale.id, 86400 * 7, tenantId);

    return pending.rows.length;
  });

  for (const item of drainedAssignments) {
    emitDomainEventDetached('marketing.engaged', {
      tenantId,
      leadId: item.leadId,
      engagementType: 'lead.assigned',
      scoreDelta: 0,
      metadata: {
        event: 'lead.assigned',
        assignmentType: 'reassigned',
        assigned_to: item.assignedTo,
        assigned_name: item.assignedName,
        dispatch_reason: 'queue_drained',
      },
    });
  }

  return drainedCount;
}

/**
 * Administrative Sale Toggle Switch State Machine:
 * - Updates `tenant_user_profiles.status` ('active' | 'inactive' | 'suspended' | 'terminated')
 * - Auto-recalls unaccepted leads (`is_accepted = false`), cancels stale SLA timers, and re-routes to eligible online agents (or explicit target)
 * - Revokes active JWT sessions via Redis blacklist immediately when deactivated
 */
export async function toggleSaleAdministrativeStatus(params: {
  tenantId: string;
  targetUserId: string;
  newStatus: 'active' | 'inactive' | 'suspended' | 'terminated';
  reassignmentMode?: 'retain' | 'auto_recall_and_transfer';
  transferToUserId?: string;
  reason?: string;
  actorId: string;
  actorRole: string;
  actorName: string;
}): Promise<{
  previousStatus: string;
  newStatus: string;
  leadsRecalled: number;
  leadsTransferred: number;
  sessionRevoked: boolean;
}> {
  const result = await withTenantTransaction(params.tenantId, async (client) => {
    const profRes = await client.query<{ status: string }>(
      `SELECT status FROM tenant_user_profiles
       WHERE tenant_id = $1 AND user_id = $2
       FOR UPDATE`,
      [params.tenantId, params.targetUserId]
    );
    if (!profRes.rows[0]) {
      throw new Error('USER_PROFILE_NOT_FOUND');
    }
    const previousStatus = profRes.rows[0].status;

    await client.query(
      `UPDATE tenant_user_profiles
       SET status = $1::varchar(30),
           is_available = CASE WHEN $1::varchar(30) = 'active' THEN is_available ELSE false END
       WHERE tenant_id = $2 AND user_id = $3`,
      [params.newStatus, params.tenantId, params.targetUserId]
    );

    let leadsRecalled = 0;
    let leadsTransferred = 0;
    let transferredLeadIds: string[] = [];
    const slaToCancel: string[] = [];
    const slaToSchedule: Array<{ member: string; deadlineMs: number }> = [];

    if (params.newStatus !== 'active') {
      const cfg = await getTenantSettingsCached(params.tenantId, client);

      // Step 2: Recall unaccepted leads (`is_accepted = false`)
      const unaccepted = await client.query<{
        id: string;
        stage_id: string;
        sla_timeout_minutes: number;
        is_won_stage: boolean;
        is_lost_stage: boolean;
      }>(
        `SELECT l.id, l.stage_id,
                COALESCE(s.sla_timeout_minutes, 0) AS sla_timeout_minutes,
                COALESCE(s.is_won_stage, false) AS is_won_stage,
                COALESCE(s.is_lost_stage, false) AS is_lost_stage
         FROM leads l
         LEFT JOIN tenant_pipeline_stages s ON s.tenant_id = l.tenant_id AND s.id = l.stage_id
         WHERE l.tenant_id = $1 AND l.assigned_to = $2 AND l.is_accepted = false AND l.status = 'assigned'
         FOR UPDATE OF l`,
        [params.tenantId, params.targetUserId]
      );

      if (unaccepted.rows.length > 0) {
        const recallIds = unaccepted.rows.map((r) => r.id);
        leadsRecalled = recallIds.length;
        for (const r of unaccepted.rows) {
          slaToCancel.push(`${r.id}:${r.stage_id}`);
        }

        const resolveEffectiveSla = (r: {
          sla_timeout_minutes: number;
          is_won_stage: boolean;
          is_lost_stage: boolean;
        }) =>
          !r.is_won_stage && !r.is_lost_stage
            ? Number(r.sla_timeout_minutes) > 0
              ? Number(r.sla_timeout_minutes)
              : cfg.use_default_sla_fallback
                ? cfg.default_sla_minutes
                : 0
            : 0;

        if (params.transferToUserId) {
          await client.query(
            `UPDATE leads
             SET assigned_to = $1, status = 'assigned', updated_at = clock_timestamp()
             WHERE tenant_id = $2 AND id = ANY($3::uuid[])`,
            [params.transferToUserId, params.tenantId, recallIds]
          );
          for (const r of unaccepted.rows) {
            const effSla = resolveEffectiveSla(r);
            if (effSla > 0) {
              slaToSchedule.push({
                member: `${r.id}:${r.stage_id}`,
                deadlineMs: Date.now() + effSla * 60 * 1000,
              });
            }
          }
        } else if (cfg.distribution_mode === 'manual_only') {
          await client.query(
            `UPDATE leads
             SET assigned_to = NULL, status = 'recalled', updated_at = clock_timestamp()
             WHERE tenant_id = $1 AND id = ANY($2::uuid[])`,
            [params.tenantId, recallIds]
          );
        } else {
          // Check if online eligible sale consultants are available right now to re-dispatch immediately (Spec §3.2 Step 2)
          const onlinePeersRaw = await client.query<{
            id: string;
            full_name: string;
            work_schedule: Record<string, { active?: boolean; start?: string; end?: string }> | null;
          }>(
            `SELECT u.id, u.full_name, p.work_schedule
             FROM users u
             INNER JOIN tenant_user_profiles p ON p.tenant_id = u.tenant_id AND p.user_id = u.id
             WHERE u.tenant_id = $1
               AND u.id <> $2
               AND u.role = 'sale'
               AND p.status = 'active'
               AND p.is_available = true
               AND p.vacation_mode = false
             ORDER BY u.created_at ASC`,
            [params.tenantId, params.targetUserId]
          );
          const now = new Date();
          const onlinePeers = cfg.enforce_work_schedule
            ? onlinePeersRaw.rows.filter((peer) =>
                isWithinWorkSchedule(peer.work_schedule, now, cfg.timezone_offset_hours)
              )
            : onlinePeersRaw.rows;

          if (onlinePeers.length > 0) {
            const groupedByPeer = new Map<string, string[]>();
            for (let idx = 0; idx < unaccepted.rows.length; idx++) {
              const r = unaccepted.rows[idx];
              const peer = onlinePeers[idx % onlinePeers.length];
              let bucket = groupedByPeer.get(peer.id);
              if (!bucket) {
                bucket = [];
                groupedByPeer.set(peer.id, bucket);
              }
              bucket.push(r.id);

              const effSla = resolveEffectiveSla(r);
              if (effSla > 0) {
                slaToSchedule.push({
                  member: `${r.id}:${r.stage_id}`,
                  deadlineMs: Date.now() + effSla * 60 * 1000,
                });
              }
            }

            for (const [peerId, peerLeadIds] of groupedByPeer.entries()) {
              await client.query(
                `UPDATE leads
                 SET assigned_to = $1, status = 'assigned', updated_at = clock_timestamp()
                 WHERE tenant_id = $2 AND id = ANY($3::uuid[])`,
                [peerId, params.tenantId, peerLeadIds]
              );
            }
          } else {
            await client.query(
              `UPDATE leads
               SET assigned_to = NULL, status = 'recalled', updated_at = clock_timestamp()
               WHERE tenant_id = $1 AND id = ANY($2::uuid[])`,
              [params.tenantId, recallIds]
            );
          }
        }

        await insertBulkLeadTimelineEvents(client, {
          tenantId: params.tenantId,
          leadIds: recallIds,
          eventType: 'auto_recall',
          eventCategory: 'system',
          actorId: params.actorId,
          actorRole: params.actorRole,
          actorName: params.actorName,
          title: 'AUTO_RECALL: Thu hồi lead chưa tiếp nhận do Sale ngừng hoạt động',
          content: params.reason || `Trạng thái chuyển sang ${params.newStatus}`,
          metadataJson: JSON.stringify({ previous_assignee: params.targetUserId, new_status: params.newStatus }),
        });
      }

      // Step 3: Optionally bulk transfer accepted leads
      if (params.reassignmentMode === 'auto_recall_and_transfer' && params.transferToUserId) {
        const accepted = await client.query<{ id: string }>(
          `SELECT id FROM leads
           WHERE tenant_id = $1 AND assigned_to = $2 AND is_accepted = true
           FOR UPDATE`,
          [params.tenantId, params.targetUserId]
        );
        if (accepted.rows.length > 0) {
          const transferIds = accepted.rows.map((r) => r.id);
          transferredLeadIds = transferIds;
          leadsTransferred = transferIds.length;
          await client.query(
            `UPDATE leads
             SET assigned_to = $1, updated_at = clock_timestamp()
             WHERE tenant_id = $2 AND id = ANY($3::uuid[])`,
            [params.transferToUserId, params.tenantId, transferIds]
          );
          await insertBulkLeadTimelineEvents(client, {
            tenantId: params.tenantId,
            leadIds: transferIds,
            eventType: 'lead_transferred',
            eventCategory: 'system',
            actorId: params.actorId,
            actorRole: params.actorRole,
            actorName: params.actorName,
            title: 'BULK_TRANSFER: Điều chuyển khách hàng sang nhân sự tiếp quản',
            content: params.reason || 'Bàn giao danh sách khách hàng',
            metadataJson: JSON.stringify({ from_user: params.targetUserId, to_user: params.transferToUserId }),
          });
        }
      }
    }

    return { previousStatus, leadsRecalled, leadsTransferred, transferredLeadIds, slaToCancel, slaToSchedule };
  });

  for (const m of result.slaToCancel) {
    await tenantRedis.zrem('sla_queue', m, params.tenantId);
  }
  for (const s of result.slaToSchedule) {
    await tenantRedis.zadd('sla_queue', s.deadlineMs, s.member, params.tenantId);
  }

  if (params.transferToUserId && result.transferredLeadIds.length > 0) {
    for (const lid of result.transferredLeadIds) {
      emitDomainEventDetached('marketing.engaged', {
        tenantId: params.tenantId,
        leadId: lid,
        engagementType: 'lead.assigned',
        scoreDelta: 0,
        metadata: {
          event: 'lead.assigned',
          assignmentType: 'reassigned',
          assigned_to: params.transferToUserId,
          previous_assigned_to: params.targetUserId,
          dispatch_reason: 'bulk_transfer',
        },
      });
    }
  }

  let sessionRevoked = false;
  if (params.newStatus !== 'active') {
    await tenantRedis.blacklistUser(params.tenantId, params.targetUserId, params.newStatus);
    sessionRevoked = true;
  } else {
    await tenantRedis.unblacklistUser(params.tenantId, params.targetUserId);
  }

  return {
    previousStatus: result.previousStatus,
    newStatus: params.newStatus,
    leadsRecalled: result.leadsRecalled,
    leadsTransferred: result.leadsTransferred,
    sessionRevoked,
  };
}

/**
 * Checks expired SLA items in `tenant:{tenant_id}:sla_queue`, marks `sla_breached = true`
 * for both initial unaccepted leads AND post-acceptance stage SLA timeouts, optionally auto-recalls
 * unaccepted leads when `sla_auto_recall_enabled = true`, triggers SMTP alert, and fires outbound webhook.
 */
export async function sweepExpiredSlaTimeouts(tenantIdFilter?: string): Promise<number> {
  const nowMs = Date.now();
  const tenantIds = tenantIdFilter
    ? [tenantIdFilter]
    : tenantRedis.getTenantsWithExpiredSla(nowMs);

  if (tenantIds.length === 0) {
    return 0;
  }

  let totalBreached = 0;
  const SWEEP_CONCURRENCY = 8;

  const sweepSingleTenant = async (tenantId: string): Promise<number> => {
    const expiredMembers = await tenantRedis.zrangebyscore('sla_queue', 0, Date.now(), tenantId);
    if (expiredMembers.length === 0) return 0;

    let tenantBreached = 0;
    const emailAlertsToSend: Array<{ subject: string; text: string }> = [];
    const webhookEventsToFire: Array<{
      leadId: string;
      leadName: string;
      stageId: string;
      stageName: string;
      autoRecalled: boolean;
      reassignedTo: string | null;
    }> = [];
    const followUpSlaTimers: Array<{ member: string; deadlineMs: number }> = [];

    await withTenantTransaction(tenantId, async (client) => {
      const cfg = await getTenantSettingsCached(tenantId, client);

      for (const member of expiredMembers) {
        const [leadId, stageId] = member.split(':');
        if (leadId && stageId) {
          const leadCheck = await client.query<{
            id: string;
            name: string | null;
            phone: string;
            assigned_to: string | null;
            sale_name: string | null;
            is_accepted: boolean;
            sla_breached: boolean;
            stage_name: string;
            stage_order: number;
            sla_timeout_minutes: number;
            is_won_stage: boolean;
            is_lost_stage: boolean;
          }>(
            `SELECT l.id, l.name, l.phone, l.assigned_to, u.full_name AS sale_name,
                    l.is_accepted, l.sla_breached,
                    s.stage_name, s.stage_order, s.sla_timeout_minutes, s.is_won_stage, s.is_lost_stage
             FROM leads l
             INNER JOIN tenant_pipeline_stages s ON s.tenant_id = l.tenant_id AND s.id = l.stage_id
             LEFT JOIN users u ON u.tenant_id = l.tenant_id AND u.id = l.assigned_to
             WHERE l.tenant_id = $1 AND l.id = $2 AND l.stage_id = $3
             FOR UPDATE OF l`,
            [tenantId, leadId, stageId]
          );

          const row = leadCheck.rows[0];
          const shouldBreach =
            Boolean(row) &&
            !row.is_won_stage &&
            !row.is_lost_stage &&
            (row.stage_order <= 1 ? !row.is_accepted : true);

          if (row && shouldBreach) {
            const currentAssigneeKey = row.assigned_to || 'unassigned';
            const dupCheck = await client.query<{ id: string }>(
              `SELECT id FROM lead_timeline_events
               WHERE tenant_id = $1 AND lead_id = $2 AND event_type = 'sla_breach'
                 AND metadata->>'stage_id' = $3
                 AND COALESCE(metadata->>'breached_assignee', 'unassigned') = $4
               LIMIT 1`,
              [tenantId, leadId, stageId, currentAssigneeKey]
            );

            if (!dupCheck.rows[0]) {
              let autoRecalled = false;
              let reassignedTo: string | null = row.assigned_to;

              if (cfg.sla_auto_recall_enabled && !row.is_accepted) {
                autoRecalled = true;
                const priorRecalls = await client.query<{ prev_id: string | null }>(
                  `SELECT metadata->>'previous_assignee' AS prev_id
                   FROM lead_timeline_events
                   WHERE tenant_id = $1 AND lead_id = $2 AND event_type = 'auto_recall'`,
                  [tenantId, leadId]
                );
                const excludedUserIds = Array.from(
                  new Set(
                    [row.assigned_to, ...priorRecalls.rows.map((r) => r.prev_id)].filter(
                      (uid): uid is string => typeof uid === 'string' && uid.length > 0
                    )
                  )
                );

                let chosenPeer: { id: string; full_name: string } | undefined;
                if (cfg.distribution_mode !== 'manual_only') {
                  const peerRes = await client.query<{
                    id: string;
                    full_name: string;
                    work_schedule: Record<string, { active?: boolean; start?: string; end?: string }> | null;
                  }>(
                    `SELECT u.id, u.full_name, p.work_schedule
                     FROM users u
                     INNER JOIN tenant_user_profiles p ON p.tenant_id = u.tenant_id AND p.user_id = u.id
                     WHERE u.tenant_id = $1
                       AND u.role = 'sale'
                       AND NOT (u.id = ANY($2::uuid[]))
                       AND p.status = 'active'
                       AND p.is_available = true
                       AND p.vacation_mode = false
                     ORDER BY u.created_at ASC`,
                    [tenantId, excludedUserIds]
                  );
                  const now = new Date();
                  const eligiblePeers = cfg.enforce_work_schedule
                    ? peerRes.rows.filter((peer) =>
                        isWithinWorkSchedule(peer.work_schedule, now, cfg.timezone_offset_hours)
                      )
                    : peerRes.rows;
                  chosenPeer = eligiblePeers[0];
                }

                if (chosenPeer) {
                  reassignedTo = chosenPeer.id;
                  await client.query(
                    `UPDATE leads
                     SET sla_breached = true, assigned_to = $3, status = 'assigned', updated_at = clock_timestamp()
                     WHERE tenant_id = $1 AND id = $2`,
                    [tenantId, leadId, reassignedTo]
                  );
                  const slaMin =
                    Number(row.sla_timeout_minutes) > 0
                      ? Number(row.sla_timeout_minutes)
                      : cfg.use_default_sla_fallback
                        ? Number(cfg.default_sla_minutes || 0)
                        : Number(cfg.default_sla_minutes || 0);
                  if (slaMin > 0) {
                    followUpSlaTimers.push({
                      member: `${leadId}:${stageId}`,
                      deadlineMs: Date.now() + slaMin * 60 * 1000,
                    });
                  }
                  await client.query(
                    `INSERT INTO lead_timeline_events (
                      tenant_id, lead_id, event_type, event_category, actor_id, actor_role, actor_name, title, content, metadata
                    ) VALUES ($1, $2, 'auto_recall', 'system', $3, 'tenant_admin', 'SLA Auto-Recall', $4, $5, $6::jsonb)`,
                    [
                      tenantId,
                      leadId,
                      reassignedTo,
                      `SLA_AUTO_RECALL: Tự động thu hồi do quá hạn & chuyển cho ${chosenPeer.full_name}`,
                      `Sale cũ (${row.sale_name || 'N/A'}) không tiếp nhận đúng hạn SLA.`,
                      JSON.stringify({ previous_assignee: row.assigned_to, new_assignee: reassignedTo }),
                    ]
                  );
                } else {
                  reassignedTo = null;
                  await client.query(
                    `UPDATE leads
                     SET sla_breached = true, assigned_to = NULL, status = 'recalled', updated_at = clock_timestamp()
                     WHERE tenant_id = $1 AND id = $2`,
                    [tenantId, leadId]
                  );
                  await client.query(
                    `INSERT INTO lead_timeline_events (
                      tenant_id, lead_id, event_type, event_category, actor_role, actor_name, title, content, metadata
                    ) VALUES ($1, $2, 'auto_recall', 'system', 'tenant_admin', 'SLA Auto-Recall', $3, $4, $5::jsonb)`,
                    [
                      tenantId,
                      leadId,
                      'SLA_AUTO_RECALL: Thu hồi lead quá hạn về hàng chờ (không còn Sale trực tuyến khả dụng)',
                      `Sale cũ (${row.sale_name || 'N/A'}) quá hạn SLA tiếp nhận.`,
                      JSON.stringify({ previous_assignee: row.assigned_to, new_assignee: null }),
                    ]
                  );
                }
              } else {
                await client.query(
                  `UPDATE leads
                   SET sla_breached = true, updated_at = clock_timestamp()
                   WHERE tenant_id = $1 AND id = $2`,
                  [tenantId, leadId]
                );
              }

              tenantBreached += 1;
              await client.query(
                `INSERT INTO lead_timeline_events (
                  tenant_id, lead_id, event_type, event_category, actor_role, actor_name, title, content, metadata
                ) VALUES ($1, $2, 'sla_breach', 'system', 'tenant_admin', 'SLA Monitor', $3, $4, $5::jsonb)`,
                [
                  tenantId,
                  leadId,
                  `SLA_BREACH: Quá hạn cam kết tại bước "${row.stage_name}"`,
                  autoRecalled
                    ? 'Đã tự động thu hồi Lead theo chính sách SLA Auto-Recall.'
                    : 'Cảnh báo đã được gửi tới Quản lý trực ca.',
                  JSON.stringify({
                    stage_id: stageId,
                    stage_name: row.stage_name,
                    auto_recalled: autoRecalled,
                    breached_assignee: currentAssigneeKey,
                  }),
                ]
              );

              const resolvedLeadName = row.name || leadId.slice(0, 8);
              const resolvedSaleName = row.sale_name || 'Chưa nhận';
              const templateVars = {
                customer_name: resolvedLeadName,
                lead_name: resolvedLeadName,
                phone: row.phone,
                sale_name: resolvedSaleName,
                assigned_sale: resolvedSaleName,
                stage_name: row.stage_name,
                sla_minutes: Number(row.sla_timeout_minutes || cfg.default_sla_minutes || 0),
              };

              emailAlertsToSend.push({
                subject: renderTemplateString(cfg.sla_email_subject_template, templateVars),
                text: renderTemplateString(cfg.sla_email_body_template, templateVars),
              });
              webhookEventsToFire.push({
                leadId,
                leadName: row.name || leadId.slice(0, 8),
                stageId,
                stageName: row.stage_name,
                autoRecalled,
                reassignedTo,
              });
            }
          }
        }
        await tenantRedis.zrem('sla_queue', member, tenantId);
      }
    });

    for (const ft of followUpSlaTimers) {
      await tenantRedis.zadd('sla_queue', ft.deadlineMs, ft.member, tenantId);
    }

    for (const alert of emailAlertsToSend) {
      await sendTenantEmailNotification({
        tenantId,
        category: 'sla_alert',
        subject: alert.subject,
        text: alert.text,
      }).catch(() => {});
    }

    if (webhookEventsToFire.length > 0) {
      const { enqueueOutboundWebhookEvent } = await import('./webhook.service.ts');
      for (const ev of webhookEventsToFire) {
        enqueueOutboundWebhookEvent({
          tenantId,
          eventType: 'lead.sla_breached',
          payload: {
            lead_id: ev.leadId,
            lead_name: ev.leadName,
            stage_id: ev.stageId,
            stage_name: ev.stageName,
            auto_recalled: ev.autoRecalled,
            reassigned_to: ev.reassignedTo,
          },
        });
      }
    }

    return tenantBreached;
  };

  for (let i = 0; i < tenantIds.length; i += SWEEP_CONCURRENCY) {
    const chunk = tenantIds.slice(i, i + SWEEP_CONCURRENCY);
    const counts = await Promise.all(chunk.map((tid) => sweepSingleTenant(tid)));
    for (const c of counts) {
      totalBreached += c;
    }
  }

  return totalBreached;
}
