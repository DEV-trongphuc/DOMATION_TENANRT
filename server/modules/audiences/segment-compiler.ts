/**
 * Dynamic "Tệp Logic" (Smart Audience Segment) Parameterized SQL AST Compiler
 * Compiles OR-of-AND `filter_branches` across 4 Data Layers:
 *   1. Profile, Consent, Tags & Dynamic `custom_fields`
 *   2. CRM Pipeline, Stage, Funnel Category, SLA & Inactivity Days
 *   3. Omnichannel Marketing & Timeline Events (`lead_timeline_events`)
 *   4. Revenue & Won Deal Attribution (`total_revenue_vnd`, `is_won_stage`)
 *
 * Security Guarantee: 100% whitelist-validated identifiers + positional `$N` parameters (Zero SQL Injection).
 */

export interface SegmentConditionRule {
  field?: string;
  op?: string;
  operator?: string;
  val?: unknown;
  value?: unknown;
  min?: unknown;
  max?: unknown;
  within_days?: number;
  negate?: boolean;
}

export interface NormalizedBranch {
  join: 'AND' | 'OR';
  rules: SegmentConditionRule[];
}

export interface NormalizedFilterAst {
  rootJoin: 'OR' | 'AND';
  branches: NormalizedBranch[];
}

const SAFE_CUSTOM_KEY_REGEX = /^[a-zA-Z0-9_-]{1,64}$/;

const STRING_COLUMNS_MAP: Record<string, string> = {
  name: 'l.name',
  phone: 'l.phone',
  email: 'l.email',
  source: 'l.source',
  campaign: 'l.campaign',
  product_interest: 'l.product_interest',
  budget_range: 'l.budget_range',
  utm_source: 'l.utm_source',
  utm_medium: 'l.utm_medium',
  utm_content: 'l.utm_content',
  ad_id: 'l.ad_id',
  adset_id: 'l.adset_id',
  campaign_id: 'l.campaign_id',
  form_id: 'l.form_id',
  status: 'l.status',
  lifecycle_stage: 'l.lifecycle_stage',
  email_consent: 'l.email_consent',
  zns_consent: 'l.zns_consent',
  quality_status: 'l.quality_status',
  ai_screener_status: 'l.ai_screener_status',
  stage_key: 's.stage_key',
  stage_name: 's.stage_name',
  funnel_category: 's.funnel_category',
};

const ID_COLUMNS_MAP: Record<string, string> = {
  id: 'l.id::text',
  pipeline_id: 'l.pipeline_id::text',
  stage_id: 'l.stage_id::text',
  assigned_to: 'l.assigned_to::text',
  round_id: 'l.round_id::text',
};

const NUMERIC_COLUMNS_MAP: Record<string, string> = {
  lead_score: 'l.lead_score',
  score: 'l.lead_score',
  total_revenue_vnd: 'l.total_revenue_vnd',
  revenue_vnd: 'l.total_revenue_vnd',
  revenue: 'l.total_revenue_vnd',
};

const BOOLEAN_COLUMNS_MAP: Record<string, string> = {
  is_accepted: 'l.is_accepted',
  sla_breached: 'l.sla_breached',
  is_duplicated: 'l.is_duplicated',
  is_duplicate_reminder: 'l.is_duplicate_reminder',
  is_won_stage: 'COALESCE(s.is_won_stage, false)',
  has_won_stage: 'COALESCE(s.is_won_stage, false)',
  is_lost_stage: 'COALESCE(s.is_lost_stage, false)',
};

const MARKETING_EVENT_SHORTCUTS: Record<string, string[]> = {
  opened_email: ['email_opened', 'mkt_email_open'],
  clicked_email: ['email_clicked', 'mkt_email_click'],
  submitted_form: ['form_submitted', 'mkt_form_submit'],
  completed_survey: ['survey_completed', 'quiz_completed'],
  received_zns: ['zns_delivered', 'zns_sent'],
  visited_url: ['web_page_view', 'page_view'],
  claimed_voucher: ['voucher_claimed', 'voucher_redeemed'],
};

function isRuleLeaf(item: unknown): item is SegmentConditionRule {
  return Boolean(item && typeof item === 'object' && !Array.isArray(item) && 'field' in (item as any));
}

export function normalizeFilterBranchesAst(rawInput: unknown): NormalizedFilterAst {
  if (!rawInput) {
    return { rootJoin: 'OR', branches: [] };
  }

  let parsed = rawInput;
  if (typeof parsed === 'string') {
    try {
      parsed = JSON.parse(parsed);
    } catch {
      return { rootJoin: 'OR', branches: [] };
    }
  }

  // Shape 1: Array
  if (Array.isArray(parsed)) {
    if (parsed.length === 0) return { rootJoin: 'OR', branches: [] };

    // Flat array of leaf rules -> 1 branch
    if (parsed.every(isRuleLeaf)) {
      const firstMode = String((parsed[0] as any)?.match_mode || '').toLowerCase();
      return {
        rootJoin: 'OR',
        branches: [
          {
            join: firstMode === 'any' || firstMode === 'or' ? 'OR' : 'AND',
            rules: parsed.filter((r) => Boolean(r.field)),
          },
        ],
      };
    }

    // Array of branches (either SegmentConditionRule[] or { conditions/rules, operator/match_mode })
    const branches: NormalizedBranch[] = [];
    for (const item of parsed) {
      if (Array.isArray(item)) {
        const cleanRules = item.filter(isRuleLeaf).filter((r) => Boolean(r.field));
        if (cleanRules.length > 0) {
          branches.push({ join: 'AND', rules: cleanRules });
        }
      } else if (item && typeof item === 'object') {
        const obj = item as Record<string, unknown>;
        const rawList = Array.isArray(obj.conditions)
          ? obj.conditions
          : Array.isArray(obj.rules)
            ? obj.rules
            : isRuleLeaf(obj)
              ? [obj]
              : [];
        const cleanRules = rawList.filter(isRuleLeaf).filter((r) => Boolean(r.field));
        if (cleanRules.length > 0) {
          const opRaw = String(obj.operator || obj.match_mode || 'AND').toUpperCase();
          branches.push({
            join: opRaw === 'OR' || opRaw === 'ANY' ? 'OR' : 'AND',
            rules: cleanRules,
          });
        }
      }
    }
    return { rootJoin: 'OR', branches };
  }

  // Shape 2: Root Tree Object `{ operator, branches | groups | conditions | rules }`
  if (parsed && typeof parsed === 'object') {
    const obj = parsed as Record<string, unknown>;
    const rootOpRaw = String(obj.operator || obj.match_mode || 'OR').toUpperCase();
    const rootJoin: 'OR' | 'AND' = rootOpRaw === 'AND' || rootOpRaw === 'ALL' ? 'AND' : 'OR';

    if (Array.isArray(obj.branches) || Array.isArray(obj.groups)) {
      const sub = normalizeFilterBranchesAst(obj.branches || obj.groups);
      return { rootJoin, branches: sub.branches };
    }

    const leafList = Array.isArray(obj.conditions)
      ? obj.conditions
      : Array.isArray(obj.rules)
        ? obj.rules
        : [];
    const cleanRules = leafList.filter(isRuleLeaf).filter((r) => Boolean(r.field));
    if (cleanRules.length > 0) {
      return {
        rootJoin: 'OR',
        branches: [{ join: rootJoin, rules: cleanRules }],
      };
    }
  }

  return { rootJoin: 'OR', branches: [] };
}

export interface CompiledSegmentQuery {
  whereClause: string;
  params: unknown[];
  hasRules: boolean;
}

export function compileSegmentWhereSql(
  tenantId: string,
  rawFilterBranches: unknown,
  options?: {
    audienceIdForExclusions?: string | null;
    extraExcludeAudienceIds?: string[];
    startParamIndex?: number;
  }
): CompiledSegmentQuery {
  const startIdx = options?.startParamIndex ?? 1;
  const params: unknown[] = [tenantId];
  const pTenant = `$${startIdx}`;

  const pushParam = (val: unknown): string => {
    params.push(val);
    return `$${startIdx + params.length - 1}`;
  };

  const ast = normalizeFilterBranchesAst(rawFilterBranches);

  const compileSingleRule = (rule: SegmentConditionRule): string | null => {
    const rawField = String(rule.field || '').trim();
    if (!rawField) return null;

    const fieldLower = rawField.toLowerCase();
    const op = String(rule.op || rule.operator || 'equals').trim().toLowerCase();
    const rawVal = rule.val !== undefined ? rule.val : rule.value;
    const isNegated = Boolean(rule.negate) || op.startsWith('not_') || op === 'neq' || op === '!=';

    // 1. Tag membership (`tag`, `tag_id`, `tag_slug`, `tags`)
    if (fieldLower === 'tag' || fieldLower === 'tag_id' || fieldLower === 'tag_slug' || fieldLower === 'tags') {
      if (op === 'is_empty' || op === 'empty') {
        return `NOT EXISTS (SELECT 1 FROM lead_tags lt WHERE lt.tenant_id = ${pTenant} AND lt.lead_id = l.id)`;
      }
      if (op === 'is_not_empty' || op === 'not_empty') {
        return `EXISTS (SELECT 1 FROM lead_tags lt WHERE lt.tenant_id = ${pTenant} AND lt.lead_id = l.id)`;
      }
      const values = Array.isArray(rawVal)
        ? rawVal.map((v) => String(v || '').trim()).filter(Boolean)
        : String(rawVal || '')
            .split(',')
            .map((v) => v.trim())
            .filter(Boolean);
      if (values.length === 0) return '1 = 0';

      const subChecks = values.map((v) => {
        const p = pushParam(v);
        return `(tt.id::text = ${p} OR LOWER(tt.slug) = LOWER(${p}) OR LOWER(tt.name) = LOWER(${p}))`;
      });
      const existsSql = `EXISTS (
        SELECT 1 FROM lead_tags lt
        INNER JOIN tenant_tags tt ON tt.tenant_id = lt.tenant_id AND tt.id = lt.tag_id
        WHERE lt.tenant_id = ${pTenant} AND lt.lead_id = l.id AND (${subChecks.join(' OR ')})
      )`;
      return isNegated ? `NOT (${existsSql})` : existsSql;
    }

    // 2. Audience membership (`in_audience`, `audience_id`)
    if (fieldLower === 'in_audience' || fieldLower === 'audience_id') {
      const targetAudId = String(rawVal || '').trim();
      if (!targetAudId) return '1 = 0';
      const pAud = pushParam(targetAudId);
      const existsSql = `EXISTS (
        SELECT 1 FROM tenant_audience_members tam
        WHERE tam.tenant_id = ${pTenant} AND tam.audience_id::text = ${pAud} AND tam.lead_id = l.id
      )`;
      return isNegated ? `NOT (${existsSql})` : existsSql;
    }

    // 3. Relative Inactivity / Age Days (`inactive_days`, `days_since_engaged`, `days_since_created`)
    if (
      fieldLower === 'inactive_days' ||
      fieldLower === 'days_since_engaged' ||
      fieldLower === 'days_since_created'
    ) {
      const safeDays = Math.max(0, Math.min(36_500, Math.floor(Number(rawVal || 0))));
      const colExpr =
        fieldLower === 'days_since_created'
          ? 'l.created_at'
          : 'COALESCE(l.last_engaged_at, l.updated_at, l.created_at)';
      const thresholdExpr = `(clock_timestamp() - INTERVAL '${safeDays} days')`;
      // More inactive days (`inactive_days >= N`) means timestamp <= now - N days
      if (op === 'gt' || op === '>') return `${colExpr} < ${thresholdExpr}`;
      if (op === 'gte' || op === '>=') return `${colExpr} <= ${thresholdExpr}`;
      if (op === 'lt' || op === '<') return `${colExpr} > ${thresholdExpr}`;
      if (op === 'lte' || op === '<=') return `${colExpr} >= ${thresholdExpr}`;
      return `${colExpr} <= ${thresholdExpr}`;
    }

    // 4. Marketing & Timeline Engagement Events (`timeline_event`, `opened_email`, `clicked_email`, `submitted_form`, etc.)
    if (
      fieldLower === 'timeline_event' ||
      fieldLower === 'event_type' ||
      fieldLower === 'marketing_event' ||
      fieldLower in MARKETING_EVENT_SHORTCUTS
    ) {
      const shortcutEvents = MARKETING_EVENT_SHORTCUTS[fieldLower];
      const withinDays =
        rule.within_days !== undefined && Number(rule.within_days) > 0
          ? Math.min(3650, Math.floor(Number(rule.within_days)))
          : null;
      const timeSql = withinDays ? ` AND te.created_at >= (clock_timestamp() - INTERVAL '${withinDays} days')` : '';

      let eventMatchSql = '';
      if (shortcutEvents) {
        const evtParams = shortcutEvents.map((ev) => pushParam(ev));
        eventMatchSql = `te.event_type IN (${evtParams.join(', ')})`;
        // Optional specific campaign/url/form filter in `rawVal` when string (not boolean)
        if (typeof rawVal === 'string' && rawVal.trim() && rawVal !== 'true' && rawVal !== 'false') {
          const pSub = pushParam(`%${rawVal.trim()}%`);
          eventMatchSql += ` AND (te.title ILIKE ${pSub} OR COALESCE(te.content, '') ILIKE ${pSub})`;
        }
      } else {
        const evtName = String(rawVal || '').trim();
        if (!evtName) return '1 = 0';
        const pEvt = pushParam(evtName);
        eventMatchSql = `LOWER(te.event_type) = LOWER(${pEvt})`;
      }

      const wantNegate =
        isNegated ||
        op === 'not_has_event' ||
        rawVal === false ||
        String(rawVal).toLowerCase() === 'false';

      const existsSql = `EXISTS (
        SELECT 1 FROM lead_timeline_events te
        WHERE te.tenant_id = ${pTenant} AND te.lead_id = l.id AND ${eventMatchSql}${timeSql}
      )`;
      return wantNegate ? `NOT (${existsSql})` : existsSql;
    }

    // 5. Quiz Score (`quiz_score`)
    if (fieldLower === 'quiz_score') {
      const targetScore = Number(rawVal || 0);
      if (!Number.isFinite(targetScore)) return '1 = 0';
      const pScore = pushParam(targetScore);
      const cmp = op === 'gt' || op === '>' ? '>' : op === 'lt' || op === '<' ? '<' : op === 'lte' || op === '<=' ? '<=' : '>=';
      return `EXISTS (
        SELECT 1 FROM lead_timeline_events te
        WHERE te.tenant_id = ${pTenant}
          AND te.lead_id = l.id
          AND te.event_type IN ('survey_completed', 'quiz_completed')
          AND COALESCE(NULLIF(te.metadata->>'score', '')::numeric, 0) ${cmp} ${pScore}
      )`;
    }

    // 6. Revenue convenience boolean (`has_revenue`)
    if (fieldLower === 'has_revenue') {
      const truthy = rawVal === undefined || rawVal === true || String(rawVal).toLowerCase() === 'true' || rawVal === 1;
      return truthy && !isNegated ? 'l.total_revenue_vnd > 0' : 'l.total_revenue_vnd <= 0';
    }

    // 7. Boolean Columns
    if (fieldLower in BOOLEAN_COLUMNS_MAP) {
      const col = BOOLEAN_COLUMNS_MAP[fieldLower];
      const truthy =
        rawVal === undefined
          ? op !== 'is_false' && op !== 'false'
          : rawVal === true || String(rawVal).toLowerCase() === 'true' || String(rawVal) === '1';
      const finalBool = isNegated ? !truthy : truthy;
      return `${col} = ${finalBool ? 'true' : 'false'}`;
    }

    // 8. Numeric Columns (`lead_score`, `total_revenue_vnd`)
    if (fieldLower in NUMERIC_COLUMNS_MAP) {
      const col = NUMERIC_COLUMNS_MAP[fieldLower];
      if (op === 'between') {
        const minVal = Number(rule.min ?? (Array.isArray(rawVal) ? rawVal[0] : 0));
        const maxVal = Number(rule.max ?? (Array.isArray(rawVal) ? rawVal[1] : 0));
        if (!Number.isFinite(minVal) || !Number.isFinite(maxVal)) return '1 = 0';
        const pMin = pushParam(minVal);
        const pMax = pushParam(maxVal);
        return `${col} BETWEEN ${pMin} AND ${pMax}`;
      }
      const num = Number(rawVal);
      if (!Number.isFinite(num)) return '1 = 0';
      const pNum = pushParam(num);
      switch (op) {
        case 'gt':
        case '>':
          return `${col} > ${pNum}`;
        case 'gte':
        case '>=':
          return `${col} >= ${pNum}`;
        case 'lt':
        case '<':
          return `${col} < ${pNum}`;
        case 'lte':
        case '<=':
          return `${col} <= ${pNum}`;
        case 'neq':
        case '!=':
        case 'not_equals':
          return `${col} != ${pNum}`;
        default:
          return `${col} = ${pNum}`;
      }
    }

    // 9. Resolve Target Text / ID / Dynamic Custom Field Expression
    let strExpr: string | null = null;
    let customFieldKey: string | null = null;

    if (fieldLower in ID_COLUMNS_MAP) {
      strExpr = ID_COLUMNS_MAP[fieldLower];
    } else if (fieldLower in STRING_COLUMNS_MAP) {
      strExpr = STRING_COLUMNS_MAP[fieldLower];
    } else if (
      fieldLower.startsWith('custom_fields.') ||
      fieldLower.startsWith('cf.') ||
      fieldLower.startsWith('custom.')
    ) {
      const rawKey = rawField.replace(/^(?:custom_fields|cf|custom)\./i, '').trim();
      if (!SAFE_CUSTOM_KEY_REGEX.test(rawKey)) {
        return '1 = 0';
      }
      customFieldKey = rawKey;
      strExpr = `(l.custom_fields->>'${rawKey}')`;
    } else if (SAFE_CUSTOM_KEY_REGEX.test(rawField)) {
      // Allow direct custom field key when valid identifier
      customFieldKey = rawField;
      strExpr = `(l.custom_fields->>'${rawField}')`;
    }

    if (!strExpr) {
      return '1 = 0';
    }

    // Numeric comparison on a Custom Field (`budget_vnd >= 3000000000`)
    if (customFieldKey && ['gt', '>', 'gte', '>=', 'lt', '<', 'lte', '<=', 'between'].includes(op)) {
      const safeNumCast = `CASE WHEN COALESCE(${strExpr}, '') != '' THEN CAST(${strExpr} AS DECIMAL(20,4)) ELSE NULL END`;
      if (op === 'between') {
        const minV = Number(rule.min ?? (Array.isArray(rawVal) ? rawVal[0] : 0));
        const maxV = Number(rule.max ?? (Array.isArray(rawVal) ? rawVal[1] : 0));
        if (!Number.isFinite(minV) || !Number.isFinite(maxV)) return '1 = 0';
        const pMin = pushParam(minV);
        const pMax = pushParam(maxV);
        return `(${safeNumCast}) BETWEEN ${pMin} AND ${pMax}`;
      }
      const numV = Number(rawVal);
      if (!Number.isFinite(numV)) return '1 = 0';
      const pN = pushParam(numV);
      const sqlOp = op === 'gt' || op === '>' ? '>' : op === 'gte' || op === '>=' ? '>=' : op === 'lt' || op === '<' ? '<' : '<=';
      return `(${safeNumCast}) ${sqlOp} ${pN}`;
    }

    // String / ID operators
    if (op === 'is_empty' || op === 'empty' || op === 'is_null') {
      return `(${strExpr} IS NULL OR TRIM(${strExpr}) = '')`;
    }
    if (op === 'is_not_empty' || op === 'not_empty' || op === 'is_not_null') {
      return `(${strExpr} IS NOT NULL AND TRIM(${strExpr}) != '')`;
    }

    if (op === 'in' || op === 'not_in' || op === 'notin') {
      const items = Array.isArray(rawVal)
        ? rawVal.map((v) => String(v ?? '').trim()).filter(Boolean)
        : String(rawVal ?? '')
            .split(',')
            .map((v) => v.trim())
            .filter(Boolean);
      if (items.length === 0) return op === 'in' ? '1 = 0' : '1 = 1';
      const pList = items.map((item) => `LOWER(${pushParam(item)})`).join(', ');
      const inSql = `LOWER(COALESCE(${strExpr}, '')) IN (${pList})`;
      return op === 'in' ? inSql : `NOT (${inSql})`;
    }

    const strVal = String(rawVal ?? '').trim();
    if (op === 'contains') {
      const p = pushParam(`%${strVal}%`);
      return `COALESCE(${strExpr}, '') ILIKE ${p}`;
    }
    if (op === 'not_contains' || op === 'notcontains') {
      const p = pushParam(`%${strVal}%`);
      return `NOT (COALESCE(${strExpr}, '') ILIKE ${p})`;
    }
    if (op === 'starts_with' || op === 'startswith') {
      const p = pushParam(`${strVal}%`);
      return `COALESCE(${strExpr}, '') ILIKE ${p}`;
    }
    if (op === 'ends_with' || op === 'endswith') {
      const p = pushParam(`%${strVal}`);
      return `COALESCE(${strExpr}, '') ILIKE ${p}`;
    }
    if (op === 'not_equals' || op === 'neq' || op === '!=') {
      const p = pushParam(strVal);
      return `LOWER(COALESCE(${strExpr}, '')) != LOWER(${p})`;
    }

    // Default: case-insensitive exact match
    const pEq = pushParam(strVal);
    return `LOWER(COALESCE(${strExpr}, '')) = LOWER(${pEq})`;
  };

  const compiledBranches: string[] = [];
  for (const branch of ast.branches) {
    const ruleClauses = branch.rules
      .map(compileSingleRule)
      .filter((c): c is string => Boolean(c));
    if (ruleClauses.length > 0) {
      compiledBranches.push(`(${ruleClauses.join(` ${branch.join} `)})`);
    }
  }

  let whereClause = `l.tenant_id = ${pTenant} AND l.is_deleted = false`;
  const hasRules = compiledBranches.length > 0;

  if (hasRules) {
    whereClause += ` AND (${compiledBranches.join(` ${ast.rootJoin} `)})`;
  } else {
    // An unconfigured dynamic segment matches 0 contacts until at least 1 rule is specified
    whereClause += ' AND 1 = 0';
  }

  // Audience-level exclusions (`tenant_audience_exclusions`)
  if (options?.audienceIdForExclusions) {
    const pExAud = pushParam(options.audienceIdForExclusions);
    whereClause += `
      AND NOT EXISTS (
        SELECT 1 FROM tenant_audience_exclusions ex
        WHERE ex.tenant_id = ${pTenant}
          AND ex.audience_id = ${pExAud}::uuid
          AND (
            (ex.lead_id IS NOT NULL AND ex.lead_id = l.id)
            OR (ex.email IS NOT NULL AND l.email IS NOT NULL AND LOWER(ex.email) = LOWER(l.email))
            OR (ex.phone IS NOT NULL AND l.phone IS NOT NULL AND ex.phone = l.phone)
            OR (
              ex.excluded_audience_id IS NOT NULL AND EXISTS (
                SELECT 1 FROM tenant_audience_members ex_m
                WHERE ex_m.tenant_id = ${pTenant}
                  AND ex_m.audience_id = ex.excluded_audience_id
                  AND ex_m.lead_id = l.id
              )
            )
          )
      )`;
  }

  if (options?.extraExcludeAudienceIds && options.extraExcludeAudienceIds.length > 0) {
    const cleanIds = options.extraExcludeAudienceIds.map((x) => String(x || '').trim()).filter(Boolean);
    if (cleanIds.length > 0) {
      const pIds = cleanIds.map((id) => `${pushParam(id)}::uuid`).join(', ');
      whereClause += `
        AND NOT EXISTS (
          SELECT 1 FROM tenant_audience_members ex_m2
          WHERE ex_m2.tenant_id = ${pTenant}
            AND ex_m2.audience_id IN (${pIds})
            AND ex_m2.lead_id = l.id
        )`;
    }
  }

  return {
    whereClause,
    params,
    hasRules,
  };
}
