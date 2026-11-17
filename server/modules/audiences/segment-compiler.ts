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
  phone_number: 'l.phone',
  phonenumber: 'l.phone',
  email: 'l.email',
  source: 'l.source',
  campaign: 'l.campaign',
  crm_campaign_name: 'l.campaign',
  product_interest: 'l.product_interest',
  crm_program: 'l.product_interest',
  budget_range: 'l.budget_range',
  utm_source: 'l.utm_source',
  crm_platform: 'l.utm_source',
  utm_medium: 'l.utm_medium',
  utm_content: 'l.utm_content',
  ad_id: 'l.ad_id',
  crm_ad_name: 'l.ad_id',
  adset_id: 'l.adset_id',
  crm_adset_name: 'l.adset_id',
  campaign_id: 'l.campaign_id',
  form_id: 'l.form_id',
  crm_form_name: 'l.form_id',
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
  crm_owner_id: 'l.assigned_to::text',
  salesperson: 'l.assigned_to::text',
  crm_assigned_to: 'l.assigned_to::text',
  round_id: 'l.round_id::text',
};

const NUMERIC_COLUMNS_MAP: Record<string, string> = {
  lead_score: 'l.lead_score',
  leadscore: 'l.lead_score',
  score: 'l.lead_score',
  total_revenue_vnd: 'l.total_revenue_vnd',
  revenue_vnd: 'l.total_revenue_vnd',
  revenue: 'l.total_revenue_vnd',
  erp_deal_value: 'l.total_revenue_vnd',
  crm_expected_revenue: 'l.total_revenue_vnd',
};

const BOOLEAN_COLUMNS_MAP: Record<string, string> = {
  is_accepted: 'l.is_accepted',
  crm_sale_contacted: 'l.is_accepted',
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
    const isNegated =
      Boolean(rule.negate) ||
      op.startsWith('not_') ||
      op === 'neq' ||
      op === '!=' ||
      op === 'is_not' ||
      op === 'has_not_done';

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

    // 2. Audience / Static List membership (`in_audience`, `audience_id`, `list`)
    if (fieldLower === 'in_audience' || fieldLower === 'audience_id' || fieldLower === 'list') {
      const targetAudId = String(rawVal || '').trim();
      if (!targetAudId) return '1 = 0';
      const pAud = pushParam(targetAudId);
      const existsSql = `EXISTS (
        SELECT 1 FROM tenant_audience_members tam
        WHERE tam.tenant_id = ${pTenant} AND tam.audience_id::text = ${pAud} AND tam.lead_id = l.id
      )`;
      return isNegated || op === 'not_in_list' ? `NOT (${existsSql})` : existsSql;
    }

    // 2b. CRM Stage ID / Key / Name (`crm_stage_id`, `crm_stage_is`)
    if (fieldLower === 'crm_stage_id' || fieldLower === 'crm_stage_is') {
      if (op === 'is_empty' || op === 'empty') return 'l.stage_id IS NULL';
      if (op === 'is_not_empty' || op === 'not_empty') return 'l.stage_id IS NOT NULL';
      const strVal = String(rawVal ?? '').trim();
      if (!strVal) return '1 = 0';
      const pSt = pushParam(strVal);
      const matchSql = `(l.stage_id::text = ${pSt} OR LOWER(COALESCE(s.stage_key, '')) = LOWER(${pSt}) OR LOWER(COALESCE(s.stage_name, '')) = LOWER(${pSt}))`;
      return isNegated ? `NOT (${matchSql})` : matchSql;
    }

    // 2c. CRM Lead Status (`crm_lead_status`)
    if (fieldLower === 'crm_lead_status') {
      if (op === 'is_empty' || op === 'empty') return "(l.status IS NULL OR TRIM(l.status) = '')";
      if (op === 'is_not_empty' || op === 'not_empty') return "(l.status IS NOT NULL AND TRIM(l.status) != '')";
      const valLower = String(rawVal ?? '').trim().toLowerCase();
      if (!valLower) return '1 = 0';
      let matchSql: string;
      if (valLower === 'active') {
        matchSql = `l.status IN ('assigned', 'unassigned_pending')`;
      } else if (valLower === 'nurture') {
        matchSql = `l.status = 'marketing_nurture'`;
      } else if (valLower === 'lost') {
        matchSql = `(l.status IN ('archived', 'rejected', 'blacklisted') OR COALESCE(s.is_lost_stage, false) = true)`;
      } else {
        const pSt = pushParam(valLower);
        matchSql = `(LOWER(COALESCE(l.status, '')) = LOWER(${pSt}) OR LOWER(COALESCE(l.lifecycle_stage, '')) = LOWER(${pSt}))`;
      }
      return isNegated ? `NOT (${matchSql})` : matchSql;
    }

    // 2d. CRM Lead Temperature (`crm_temperature`, `crm_temperature_is`)
    if (fieldLower === 'crm_temperature' || fieldLower === 'crm_temperature_is') {
      const valLower = String(rawVal ?? '').trim().toLowerCase();
      if (!valLower) return '1 = 0';
      let matchSql: string;
      if (valLower === 'hot') {
        matchSql = `(LOWER(COALESCE(l.custom_fields->>'temperature', '')) = 'hot' OR LOWER(COALESCE(l.quality_status, '')) IN ('hot', 'good', 'qualified') OR l.lead_score >= 70)`;
      } else if (valLower === 'warm') {
        matchSql = `(LOWER(COALESCE(l.custom_fields->>'temperature', '')) = 'warm' OR LOWER(COALESCE(l.quality_status, '')) IN ('warm', 'pending') OR (l.lead_score >= 30 AND l.lead_score < 70))`;
      } else if (valLower === 'cold') {
        matchSql = `(LOWER(COALESCE(l.custom_fields->>'temperature', '')) = 'cold' OR LOWER(COALESCE(l.quality_status, '')) IN ('cold', 'bad_timing', 'no_answer', 'disqualified', 'junk'))`;
      } else {
        const pTemp = pushParam(valLower);
        matchSql = `(LOWER(COALESCE(l.custom_fields->>'temperature', '')) = LOWER(${pTemp}) OR LOWER(COALESCE(l.quality_status, '')) = LOWER(${pTemp}))`;
      }
      return isNegated ? `NOT (${matchSql})` : matchSql;
    }

    // 2e. CRM Team / Branch Ownership (`crm_team_id`, `crm_branch_id`)
    if (fieldLower === 'crm_team_id' || fieldLower === 'crm_branch_id') {
      const targetId = String(rawVal ?? '').trim();
      const colName = fieldLower === 'crm_team_id' ? 'team_id' : 'branch_id';
      if (op === 'is_empty' || op === 'empty') {
        return `(l.assigned_to IS NULL OR NOT EXISTS (SELECT 1 FROM users u_org WHERE u_org.tenant_id = ${pTenant} AND u_org.id = l.assigned_to AND u_org.${colName} IS NOT NULL))`;
      }
      if (op === 'is_not_empty' || op === 'not_empty') {
        return `EXISTS (SELECT 1 FROM users u_org WHERE u_org.tenant_id = ${pTenant} AND u_org.id = l.assigned_to AND u_org.${colName} IS NOT NULL)`;
      }
      if (!targetId) return '1 = 0';
      const pOrg = pushParam(targetId);
      const existsSql = `EXISTS (
        SELECT 1 FROM users u_org
        WHERE u_org.tenant_id = ${pTenant} AND u_org.id = l.assigned_to AND u_org.${colName}::text = ${pOrg}
      )`;
      return isNegated ? `NOT (${existsSql})` : existsSql;
    }

    // 2f. Contact Presence Booleans (`has_email`, `has_phone`)
    if (fieldLower === 'has_email' || fieldLower === 'has_phone') {
      const col = fieldLower === 'has_email' ? 'l.email' : 'l.phone';
      const hasExpr = `(${col} IS NOT NULL AND TRIM(${col}) != '')`;
      const wantEmpty =
        op === 'is_empty' ||
        op === 'empty' ||
        op === 'is_false' ||
        rawVal === false ||
        String(rawVal).toLowerCase() === 'false';
      const finalEmpty = isNegated ? !wantEmpty : wantEmpty;
      return finalEmpty ? `NOT ${hasExpr}` : hasExpr;
    }

    // 2g. Owner convenience empty checks (`crm_owner_id`, `salesperson`, `assigned_to`)
    if (
      (fieldLower === 'crm_owner_id' || fieldLower === 'salesperson' || fieldLower === 'assigned_to' || fieldLower === 'crm_assigned_to') &&
      (op === 'is_empty' || op === 'empty' || op === 'is_not_empty' || op === 'not_empty')
    ) {
      return op === 'is_empty' || op === 'empty' ? 'l.assigned_to IS NULL' : 'l.assigned_to IS NOT NULL';
    }

    // 3. Relative Inactivity / Age Days (`inactive_days`, `lastActivityDays`, `days_since_engaged`, `days_since_created`, `crm_hours_uncontacted`)
    if (
      fieldLower === 'inactive_days' ||
      fieldLower === 'lastactivitydays' ||
      fieldLower === 'days_since_engaged' ||
      fieldLower === 'days_since_created' ||
      fieldLower === 'crm_hours_uncontacted'
    ) {
      const safeNum = Math.max(0, Math.min(87_600, Math.floor(Number(rawVal || 0))));
      const isHours = fieldLower === 'crm_hours_uncontacted';
      const colExpr =
        fieldLower === 'days_since_created'
          ? 'l.created_at'
          : isHours
            ? 'COALESCE(l.accepted_at, l.created_at)'
            : 'COALESCE(l.last_engaged_at, l.updated_at, l.created_at)';
      const thresholdExpr = isHours
        ? `(clock_timestamp() - INTERVAL '${safeNum} hours')`
        : `(clock_timestamp() - INTERVAL '${safeNum} days')`;
      if (op === 'gt' || op === '>' || op === 'greater_than' || op === 'not_in_the_last') return `${colExpr} < ${thresholdExpr}`;
      if (op === 'gte' || op === '>=') return `${colExpr} <= ${thresholdExpr}`;
      if (op === 'lt' || op === '<' || op === 'less_than' || op === 'in_the_last') return `${colExpr} > ${thresholdExpr}`;
      if (op === 'lte' || op === '<=') return `${colExpr} >= ${thresholdExpr}`;
      return `${colExpr} <= ${thresholdExpr}`;
    }

    // 3b. Date Columns (`created_at`, `crm_created_at`, `joinedAt`, `lastActivity`)
    if (
      fieldLower === 'created_at' ||
      fieldLower === 'crm_created_at' ||
      fieldLower === 'joinedat' ||
      fieldLower === 'lastactivity'
    ) {
      const colExpr = fieldLower === 'lastactivity' ? 'COALESCE(l.last_engaged_at, l.updated_at, l.created_at)' : 'l.created_at';
      if (op === 'is_empty' || op === 'empty') return `${colExpr} IS NULL`;
      if (op === 'is_not_empty' || op === 'not_empty') return `${colExpr} IS NOT NULL`;
      if (op === 'within_days' || op === 'in_the_last') {
        const d = Math.max(0, Math.min(36_500, Math.floor(Number(rawVal || 0))));
        return `${colExpr} >= (clock_timestamp() - INTERVAL '${d} days')`;
      }
      if (op === 'not_in_the_last') {
        const d = Math.max(0, Math.min(36_500, Math.floor(Number(rawVal || 0))));
        return `${colExpr} < (clock_timestamp() - INTERVAL '${d} days')`;
      }
      const dateStr = String(rawVal ?? '').trim().slice(0, 32);
      if (!dateStr) return '1 = 0';
      const pDate = pushParam(dateStr);
      if (op === 'after' || op === 'gt' || op === '>') return `${colExpr}::date > ${pDate}::date`;
      if (op === 'before' || op === 'lt' || op === '<') return `${colExpr}::date < ${pDate}::date`;
      return `${colExpr}::date = ${pDate}::date`;
    }

    // 3c. Email / Link Stats Counters (`statsOpened`, `stats.emailsOpened`, `statsClicked`, `stats.linksClicked`, `statsSent`)
    if (
      fieldLower === 'statsopened' ||
      fieldLower === 'stats.emailsopened' ||
      fieldLower === 'statsclicked' ||
      fieldLower === 'stats.linksclicked' ||
      fieldLower === 'statssent'
    ) {
      const targetNum = Number(rawVal || 0);
      if (!Number.isFinite(targetNum)) return '1 = 0';
      const pCnt = pushParam(targetNum);
      const evtTypes =
        fieldLower.includes('click')
          ? ['email_clicked', 'mkt_email_click']
          : fieldLower.includes('sent')
            ? ['mkt_email_sent', 'email_sent']
            : ['email_opened', 'mkt_email_open'];
      const evtPh = evtTypes.map((ev) => pushParam(ev)).join(', ');
      const cmp =
        op === 'gt' || op === '>' || op === 'greater_than'
          ? '>'
          : op === 'lt' || op === '<' || op === 'less_than'
            ? '<'
            : op === 'lte' || op === '<='
              ? '<='
              : op === 'equals' || op === 'is' || op === '='
                ? '='
                : '>=';
      return `(SELECT COUNT(*) FROM lead_timeline_events te WHERE te.tenant_id = ${pTenant} AND te.lead_id = l.id AND te.event_type IN (${evtPh})) ${cmp} ${pCnt}`;
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
        case 'greater_than':
          return `${col} > ${pNum}`;
        case 'gte':
        case '>=':
          return `${col} >= ${pNum}`;
        case 'lt':
        case '<':
        case 'less_than':
          return `${col} < ${pNum}`;
        case 'lte':
        case '<=':
          return `${col} <= ${pNum}`;
        case 'neq':
        case '!=':
        case 'not_equals':
        case 'is_not':
          return `${col} != ${pNum}`;
        default:
          return `${col} = ${pNum}`;
      }
    }

    // 9. Resolve Target Text / ID / Dynamic Custom Field Expression
    let strExpr: string | null = null;
    let customFieldKey: string | null = null;

    if (fieldLower === 'firstname' || fieldLower === 'first_name') {
      const pCf = pushParam('first_name');
      strExpr = `COALESCE(NULLIF(l.custom_fields->>${pCf}::text, ''), l.name)`;
    } else if (fieldLower === 'lastname' || fieldLower === 'last_name') {
      const pCf = pushParam('last_name');
      strExpr = `COALESCE(NULLIF(l.custom_fields->>${pCf}::text, ''), l.name)`;
    } else if (fieldLower in ID_COLUMNS_MAP) {
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
      const pKey = pushParam(rawKey);
      strExpr = `(l.custom_fields->>${pKey}::text)`;
    } else if (SAFE_CUSTOM_KEY_REGEX.test(rawField)) {
      // Allow direct custom field key when valid identifier (parameterized)
      customFieldKey = rawField;
      const pKey = pushParam(rawField);
      strExpr = `(l.custom_fields->>${pKey}::text)`;
    }

    if (!strExpr) {
      return '1 = 0';
    }

    // Numeric comparison on a Custom Field (`budget_vnd >= 3000000000`)
    if (customFieldKey && ['gt', '>', 'greater_than', 'gte', '>=', 'lt', '<', 'less_than', 'lte', '<=', 'between'].includes(op)) {
      const safeNumCast = `CASE WHEN COALESCE(${strExpr}, '') ~ '^-?[0-9]+(\\.[0-9]+)?$' THEN CAST(${strExpr} AS DECIMAL(20,4)) ELSE NULL END`;
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
      const sqlOp =
        op === 'gt' || op === '>' || op === 'greater_than'
          ? '>'
          : op === 'gte' || op === '>='
            ? '>='
            : op === 'lt' || op === '<' || op === 'less_than'
              ? '<'
              : '<=';
      return `(${safeNumCast}) ${sqlOp} ${pN}`;
    }

    // String / ID operators
    if (op === 'is_empty' || op === 'empty' || op === 'is_null') {
      return `(${strExpr} IS NULL OR TRIM(${strExpr}) = '')`;
    }
    if (op === 'is_not_empty' || op === 'not_empty' || op === 'is_not_null') {
      return `(${strExpr} IS NOT NULL AND TRIM(${strExpr}) != '')`;
    }

    if (op === 'in' || op === 'in_list' || op === 'not_in' || op === 'not_in_list' || op === 'notin') {
      const items = Array.isArray(rawVal)
        ? rawVal.map((v) => String(v ?? '').trim()).filter(Boolean)
        : String(rawVal ?? '')
            .split(',')
            .map((v) => v.trim())
            .filter(Boolean);
      const wantIn = op === 'in' || op === 'in_list';
      if (items.length === 0) return wantIn ? '1 = 0' : '1 = 1';
      const pList = items.map((item) => `LOWER(${pushParam(item)})`).join(', ');
      const inSql = `LOWER(COALESCE(${strExpr}, '')) IN (${pList})`;
      return wantIn ? inSql : `NOT (${inSql})`;
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
    if (op === 'not_equals' || op === 'neq' || op === '!=' || op === 'is_not') {
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
