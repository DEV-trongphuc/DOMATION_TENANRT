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
const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function parseFiniteNonNegInt(rawVal: unknown, max: number): number | null {
  const rawStr = rawVal === undefined || rawVal === null ? '' : String(rawVal).trim();
  const parsed = rawStr === '' ? 0 : Number(rawStr);
  if (!Number.isFinite(parsed)) return null;
  return Math.max(0, Math.min(max, Math.floor(parsed)));
}

const STRING_COLUMNS_MAP: Record<string, string> = {
  name: 'l.name',
  phone: 'l.phone',
  phone_number: 'l.phone',
  phonenumber: 'l.phone',
  email: 'l.email',
  source: 'l.source',
  campaign: "COALESCE(NULLIF(l.custom_fields->>'utm_campaign', ''), NULLIF(l.campaign, ''), NULLIF(l.custom_fields->>'campaign_name', ''))",
  utm_campaign: "COALESCE(NULLIF(l.custom_fields->>'utm_campaign', ''), NULLIF(l.campaign, ''), NULLIF(l.custom_fields->>'campaign_name', ''))",
  crm_campaign_name: "COALESCE(NULLIF(l.custom_fields->>'utm_campaign', ''), NULLIF(l.campaign, ''), NULLIF(l.custom_fields->>'campaign_name', ''))",
  product_interest: 'l.product_interest',
  crm_program: 'l.product_interest',
  budget_range: 'l.budget_range',
  utm_source: "COALESCE(NULLIF(l.utm_source, ''), NULLIF(l.custom_fields->>'utm_source', ''))",
  crm_platform: "COALESCE(NULLIF(l.utm_source, ''), NULLIF(l.custom_fields->>'utm_source', ''))",
  utm_medium: "COALESCE(NULLIF(l.utm_medium, ''), NULLIF(l.custom_fields->>'utm_medium', ''))",
  utm_content: "COALESCE(NULLIF(l.utm_content, ''), NULLIF(l.custom_fields->>'utm_content', ''))",
  ad_id: "COALESCE(NULLIF(l.ad_id, ''), NULLIF(l.custom_fields->>'ad_id', ''), NULLIF(l.custom_fields->>'meta_ad_id', ''))",
  adset_id: "COALESCE(NULLIF(l.adset_id, ''), NULLIF(l.custom_fields->>'adset_id', ''), NULLIF(l.custom_fields->>'meta_adset_id', ''))",
  crm_adset_name: "COALESCE(NULLIF(l.custom_fields->>'adset_name', ''), NULLIF(l.custom_fields->>'meta_adset_name', ''), NULLIF(l.adset_id, ''))",
  campaign_id: "COALESCE(NULLIF(l.campaign_id, ''), NULLIF(l.custom_fields->>'campaign_id', ''), NULLIF(l.custom_fields->>'meta_campaign_id', ''))",
  form_id: "COALESCE(NULLIF(l.form_id, ''), NULLIF(l.custom_fields->>'form_id', ''))",
  crm_form_name: "COALESCE(NULLIF(l.custom_fields->>'form_name', ''), NULLIF(l.custom_fields->>'meta_form_name', ''), NULLIF(l.form_id, ''))",
  city: "COALESCE(NULLIF(l.custom_fields->>'city', ''), NULLIF(l.custom_fields->>'province', ''), NULLIF(l.custom_fields->>'tinh_thanh', ''), l.address)",
  province: "COALESCE(NULLIF(l.custom_fields->>'province', ''), NULLIF(l.custom_fields->>'city', ''), NULLIF(l.custom_fields->>'tinh_thanh', ''), l.address)",
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
          const opRaw = String(obj.join || obj.operator || obj.match_mode || 'AND').toUpperCase();
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
    const rootOpRaw = String(obj.rootJoin || obj.join || obj.operator || obj.match_mode || 'OR').toUpperCase();
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
    const ruleNegated = Boolean(rule.negate);
    const baseOpNeg =
      op.startsWith('not_') ||
      op === 'neq' ||
      op === '!=' ||
      op === 'is_not' ||
      op === 'has_not_done';
    const isNegated = baseOpNeg !== ruleNegated;

    // 1. Tag membership (`tag`, `tag_id`, `tag_slug`, `tags`)
    if (fieldLower === 'tag' || fieldLower === 'tag_id' || fieldLower === 'tag_slug' || fieldLower === 'tags') {
      if (op === 'is_empty' || op === 'empty' || op === 'is_not_empty' || op === 'not_empty') {
        const wantEmpty = op === 'is_empty' || op === 'empty';
        const effectiveEmpty = ruleNegated ? !wantEmpty : wantEmpty;
        return effectiveEmpty
          ? `NOT EXISTS (SELECT 1 FROM lead_tags lt WHERE lt.tenant_id = ${pTenant} AND lt.lead_id = l.id)`
          : `EXISTS (SELECT 1 FROM lead_tags lt WHERE lt.tenant_id = ${pTenant} AND lt.lead_id = l.id)`;
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

    const compileNumericExpr = (numSqlExpr: string): string => {
      if (op === 'between') {
        const minVal = Number(rule.min ?? (Array.isArray(rawVal) ? rawVal[0] : 0));
        const maxVal = Number(rule.max ?? (Array.isArray(rawVal) ? rawVal[1] : 0));
        if (!Number.isFinite(minVal) || !Number.isFinite(maxVal)) return '1 = 0';
        const pMin = pushParam(minVal);
        const pMax = pushParam(maxVal);
        const expr = `(${numSqlExpr}) BETWEEN ${pMin} AND ${pMax}`;
        return ruleNegated ? `NOT (${expr})` : expr;
      }
      const num = Number(rawVal);
      if (!Number.isFinite(num)) return '1 = 0';
      const pNum = pushParam(num);
      const isNotEqOp = op === 'neq' || op === '!=' || op === 'not_equals' || op === 'is_not';
      let baseExpr: string;
      switch (op) {
        case 'gt':
        case '>':
        case 'greater_than':
          baseExpr = `(${numSqlExpr}) > ${pNum}`;
          break;
        case 'gte':
        case '>=':
          baseExpr = `(${numSqlExpr}) >= ${pNum}`;
          break;
        case 'lt':
        case '<':
        case 'less_than':
          baseExpr = `(${numSqlExpr}) < ${pNum}`;
          break;
        case 'lte':
        case '<=':
          baseExpr = `(${numSqlExpr}) <= ${pNum}`;
          break;
        default:
          baseExpr = `(${numSqlExpr}) = ${pNum}`;
          break;
      }
      const wantNot = isNotEqOp !== ruleNegated;
      return wantNot ? `NOT (${baseExpr})` : baseExpr;
    };

    const resolveBoolDesired = (): boolean => {
      let baseBool: boolean;
      if (op === 'is_false' || op === 'false' || op === 'is_empty' || op === 'empty') {
        baseBool = false;
      } else if (op === 'is_true' || op === 'true' || op === 'is_not_empty' || op === 'not_empty') {
        baseBool = true;
      } else {
        const rawStr = rawVal === undefined ? 'true' : String(rawVal).trim().toLowerCase();
        const valBool = !(rawVal === false || rawStr === 'false' || rawStr === '0' || rawStr === 'no');
        const isNotEqOp = op === 'not_equals' || op === 'neq' || op === '!=' || op === 'is_not';
        baseBool = isNotEqOp ? !valBool : valBool;
      }
      return ruleNegated ? !baseBool : baseBool;
    };

    // 2. Audience / Static List membership (`in_audience`, `audience_id`, `list`)
    if (fieldLower === 'in_audience' || fieldLower === 'audience_id' || fieldLower === 'list') {
      const audIds = Array.isArray(rawVal)
        ? rawVal.map((v) => String(v || '').trim()).filter(Boolean)
        : String(rawVal || '')
            .split(',')
            .map((v) => v.trim())
            .filter(Boolean);
      if (audIds.length === 0) return '1 = 0';
      const audChecks = audIds.map((aid) => `tam.audience_id::text = ${pushParam(aid)}`).join(' OR ');
      const existsSql = `EXISTS (
        SELECT 1 FROM tenant_audience_members tam
        WHERE tam.tenant_id = ${pTenant} AND (${audChecks}) AND tam.lead_id = l.id
      )`;
      return isNegated ? `NOT (${existsSql})` : existsSql;
    }

    // 2b. CRM Stage ID / Key / Name (`crm_stage_id`, `crm_stage_is`)
    if (fieldLower === 'crm_stage_id' || fieldLower === 'crm_stage_is') {
      if (op === 'is_empty' || op === 'empty' || op === 'is_not_empty' || op === 'not_empty') {
        const wantEmpty = op === 'is_empty' || op === 'empty';
        return (ruleNegated ? !wantEmpty : wantEmpty) ? 'l.stage_id IS NULL' : 'l.stage_id IS NOT NULL';
      }
      const items = Array.isArray(rawVal)
        ? rawVal.map((v) => String(v ?? '').trim()).filter(Boolean)
        : String(rawVal ?? '')
            .split(',')
            .map((v) => v.trim())
            .filter(Boolean);
      if (items.length === 0) return '1 = 0';
      const checks = items
        .map((stVal) => {
          const pSt = pushParam(stVal);
          return `(COALESCE(l.stage_id::text, '') = ${pSt} OR LOWER(COALESCE(s.stage_key, '')) = LOWER(${pSt}) OR LOWER(COALESCE(s.stage_name, '')) = LOWER(${pSt}))`;
        })
        .join(' OR ');
      const matchSql = `(${checks})`;
      return isNegated ? `NOT (${matchSql})` : matchSql;
    }

    // 2c. CRM Lead Status (`crm_lead_status`)
    if (fieldLower === 'crm_lead_status') {
      if (op === 'is_empty' || op === 'empty' || op === 'is_not_empty' || op === 'not_empty') {
        const wantEmpty = op === 'is_empty' || op === 'empty';
        return (ruleNegated ? !wantEmpty : wantEmpty)
          ? "(l.status IS NULL OR TRIM(l.status) = '')"
          : "(l.status IS NOT NULL AND TRIM(l.status) != '')";
      }
      const valLower = String(rawVal ?? '').trim().toLowerCase();
      if (!valLower) return '1 = 0';
      let matchSql: string;
      if (valLower === 'active') {
        matchSql = `COALESCE(l.status, '') IN ('assigned', 'unassigned_pending')`;
      } else if (valLower === 'nurture') {
        matchSql = `COALESCE(l.status, '') = 'marketing_nurture'`;
      } else if (valLower === 'lost') {
        matchSql = `(COALESCE(l.status, '') IN ('archived', 'rejected', 'blacklisted') OR COALESCE(s.is_lost_stage, false) = true)`;
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
        matchSql = `(LOWER(COALESCE(l.custom_fields->>'temperature', '')) = 'hot' OR LOWER(COALESCE(l.quality_status, '')) IN ('hot', 'good', 'qualified') OR COALESCE(l.lead_score, 0) >= 70)`;
      } else if (valLower === 'warm') {
        matchSql = `(LOWER(COALESCE(l.custom_fields->>'temperature', '')) = 'warm' OR LOWER(COALESCE(l.quality_status, '')) IN ('warm', 'pending') OR (COALESCE(l.lead_score, 0) >= 30 AND COALESCE(l.lead_score, 0) < 70))`;
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
      if (op === 'is_empty' || op === 'empty' || op === 'is_not_empty' || op === 'not_empty') {
        const wantEmpty = op === 'is_empty' || op === 'empty';
        return (ruleNegated ? !wantEmpty : wantEmpty)
          ? `(l.assigned_to IS NULL OR NOT EXISTS (SELECT 1 FROM users u_org WHERE u_org.tenant_id = ${pTenant} AND u_org.id = l.assigned_to AND u_org.${colName} IS NOT NULL))`
          : `EXISTS (SELECT 1 FROM users u_org WHERE u_org.tenant_id = ${pTenant} AND u_org.id = l.assigned_to AND u_org.${colName} IS NOT NULL)`;
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
      let baseHas: boolean;
      if (op === 'is_empty' || op === 'empty' || op === 'is_false') {
        baseHas = false;
      } else if (op === 'is_not_empty' || op === 'not_empty' || op === 'is_true') {
        baseHas = true;
      } else {
        const valBool =
          rawVal === undefined
            ? true
            : !(rawVal === false || String(rawVal).toLowerCase() === 'false' || String(rawVal) === '0');
        const isNotEqOp = op === 'not_equals' || op === 'neq' || op === '!=' || op === 'is_not';
        baseHas = isNotEqOp ? !valBool : valBool;
      }
      const finalHas = ruleNegated ? !baseHas : baseHas;
      return finalHas ? `(${col} IS NOT NULL AND TRIM(${col}) != '')` : `(${col} IS NULL OR TRIM(${col}) = '')`;
    }

    // 2g. Owner / Round convenience empty checks (`crm_owner_id`, `salesperson`, `assigned_to`, `round_id`)
    if (
      (fieldLower === 'crm_owner_id' || fieldLower === 'salesperson' || fieldLower === 'assigned_to' || fieldLower === 'crm_assigned_to') &&
      (op === 'is_empty' || op === 'empty' || op === 'is_not_empty' || op === 'not_empty')
    ) {
      const wantEmpty = op === 'is_empty' || op === 'empty';
      return (ruleNegated ? !wantEmpty : wantEmpty) ? 'l.assigned_to IS NULL' : 'l.assigned_to IS NOT NULL';
    }
    if (fieldLower === 'round_id' && (op === 'is_empty' || op === 'empty' || op === 'is_not_empty' || op === 'not_empty')) {
      const wantEmpty = op === 'is_empty' || op === 'empty';
      return (ruleNegated ? !wantEmpty : wantEmpty) ? 'l.round_id IS NULL' : 'l.round_id IS NOT NULL';
    }

    // 2h. Gender with EN/VI normalization (`gender`)
    if (fieldLower === 'gender') {
      const gExpr = `COALESCE(NULLIF(l.custom_fields->>'gender', ''), NULLIF(l.custom_fields->>'gioi_tinh', ''))`;
      if (op === 'is_empty' || op === 'empty' || op === 'is_not_empty' || op === 'not_empty') {
        const wantEmpty = op === 'is_empty' || op === 'empty';
        return (ruleNegated ? !wantEmpty : wantEmpty)
          ? `(${gExpr} IS NULL OR TRIM(${gExpr}) = '')`
          : `(${gExpr} IS NOT NULL AND TRIM(${gExpr}) != '')`;
      }
      const vLow = String(rawVal ?? '').trim().toLowerCase();
      if (!vLow) return '1 = 0';
      let matchSql: string;
      if (vLow === 'male' || vLow === 'nam' || vLow === 'm') {
        matchSql = `LOWER(COALESCE(${gExpr}, '')) IN ('male', 'nam', 'm')`;
      } else if (vLow === 'female' || vLow === 'nu' || vLow === 'nữ' || vLow === 'f') {
        matchSql = `LOWER(COALESCE(${gExpr}, '')) IN ('female', 'nu', 'nữ', 'f')`;
      } else if (vLow === 'other' || vLow === 'khac' || vLow === 'khác') {
        matchSql = `LOWER(COALESCE(${gExpr}, '')) IN ('other', 'khac', 'khác')`;
      } else {
        const pG = pushParam(vLow);
        matchSql = `LOWER(COALESCE(${gExpr}, '')) = LOWER(${pG})`;
      }
      return isNegated ? `NOT (${matchSql})` : matchSql;
    }

    // 2i. Lead Value (`lead_value`) — total_revenue_vnd or numeric custom_fields.lead_value
    if (fieldLower === 'lead_value') {
      const valExpr = `GREATEST(COALESCE(l.total_revenue_vnd, 0), CASE WHEN COALESCE(l.custom_fields->>'lead_value', '') ~ '^-?[0-9]+([.][0-9]+)?$' THEN CAST(l.custom_fields->>'lead_value' AS DECIMAL(20,2)) ELSE 0 END)`;
      return compileNumericExpr(valExpr);
    }

    // 2j. CRM Deals (`has_deal`, `deal_stage`, `erp_deal_status`, `deal_value`)
    if (fieldLower === 'has_deal') {
      const wantHas = resolveBoolDesired();
      const existsSql = `EXISTS (SELECT 1 FROM tenant_deals d WHERE d.tenant_id = ${pTenant} AND d.lead_id = l.id)`;
      return wantHas ? existsSql : `NOT (${existsSql})`;
    }
    if (fieldLower === 'deal_stage' || fieldLower === 'erp_deal_status') {
      if (op === 'is_empty' || op === 'empty' || op === 'is_not_empty' || op === 'not_empty') {
        const wantEmpty = op === 'is_empty' || op === 'empty';
        const existsAny = `EXISTS (SELECT 1 FROM tenant_deals d WHERE d.tenant_id = ${pTenant} AND d.lead_id = l.id)`;
        return (ruleNegated ? !wantEmpty : wantEmpty) ? `NOT (${existsAny})` : existsAny;
      }
      const items = Array.isArray(rawVal)
        ? rawVal.map((v) => String(v ?? '').trim().toLowerCase()).filter(Boolean)
        : String(rawVal ?? '')
            .split(',')
            .map((v) => v.trim().toLowerCase())
            .filter(Boolean);
      if (items.length === 0) return '1 = 0';
      if (items.length === 1 && items[0] === 'no_deal') {
        const existsAny = `EXISTS (SELECT 1 FROM tenant_deals d WHERE d.tenant_id = ${pTenant} AND d.lead_id = l.id)`;
        return isNegated ? existsAny : `NOT (${existsAny})`;
      }
      if (items.length === 1 && items[0] === 'open') {
        const existsOpen = `EXISTS (SELECT 1 FROM tenant_deals d WHERE d.tenant_id = ${pTenant} AND d.lead_id = l.id AND LOWER(d.stage) NOT IN ('won', 'lost'))`;
        return isNegated ? `NOT (${existsOpen})` : existsOpen;
      }
      const pList = items.map((st) => `LOWER(${pushParam(st)})`).join(', ');
      const existsStage = `EXISTS (SELECT 1 FROM tenant_deals d WHERE d.tenant_id = ${pTenant} AND d.lead_id = l.id AND LOWER(d.stage) IN (${pList}))`;
      return isNegated ? `NOT (${existsStage})` : existsStage;
    }
    if (fieldLower === 'deal_value') {
      const dealSumExpr = `COALESCE((SELECT SUM(d.amount_vnd) FROM tenant_deals d WHERE d.tenant_id = ${pTenant} AND d.lead_id = l.id AND LOWER(d.stage) != 'lost'), 0)`;
      return compileNumericExpr(dealSumExpr);
    }

    // 2k. Meta / Ad Attribution (`ad_name`, `crm_ad_name`, `fbclid_present`)
    if (fieldLower === 'ad_name' || fieldLower === 'crm_ad_name') {
      const cfAdName = `COALESCE(NULLIF(l.custom_fields->>'ad_name', ''), NULLIF(l.custom_fields->>'meta_ad_name', ''))`;
      if (op === 'is_empty' || op === 'empty' || op === 'is_not_empty' || op === 'not_empty') {
        const wantEmpty = op === 'is_empty' || op === 'empty';
        const hasNameSql = `(${cfAdName} IS NOT NULL OR EXISTS (SELECT 1 FROM meta_ads_insights mai WHERE mai.tenant_id = ${pTenant} AND mai.ad_id = l.ad_id AND mai.ad_name IS NOT NULL AND TRIM(mai.ad_name) != ''))`;
        return (ruleNegated ? !wantEmpty : wantEmpty) ? `NOT (${hasNameSql})` : hasNameSql;
      }
      const strVal = String(rawVal ?? '').trim();
      if (!strVal) return '1 = 0';
      let matchSql: string;
      if (op === 'contains' || op === 'not_contains' || op === 'notcontains') {
        const pLike = pushParam(`%${strVal}%`);
        matchSql = `(COALESCE(${cfAdName}, '') ILIKE ${pLike} OR EXISTS (SELECT 1 FROM meta_ads_insights mai WHERE mai.tenant_id = ${pTenant} AND mai.ad_id = l.ad_id AND COALESCE(mai.ad_name, '') ILIKE ${pLike}))`;
      } else {
        const pEq = pushParam(strVal);
        matchSql = `(LOWER(COALESCE(${cfAdName}, '')) = LOWER(${pEq}) OR EXISTS (SELECT 1 FROM meta_ads_insights mai WHERE mai.tenant_id = ${pTenant} AND mai.ad_id = l.ad_id AND LOWER(COALESCE(mai.ad_name, '')) = LOWER(${pEq})))`;
      }
      return isNegated ? `NOT (${matchSql})` : matchSql;
    }
    if (fieldLower === 'fbclid_present') {
      const wantPresent = resolveBoolDesired();
      const presentSql = `(NULLIF(TRIM(COALESCE(l.fbclid, '')), '') IS NOT NULL OR NULLIF(TRIM(COALESCE(l.fbc, '')), '') IS NOT NULL OR NULLIF(TRIM(COALESCE(l.custom_fields->>'fbclid', '')), '') IS NOT NULL)`;
      return wantPresent ? presentSql : `NOT (${presentSql})`;
    }

    // 2l. Email / Campaign / Suppression / Flow Behavior (`opened_campaign`, `clicked_campaign`, `email_open_count`, `email_click_count`, `is_suppressed`, `in_flow`, `completed_flow`)
    if (fieldLower === 'opened_campaign' || fieldLower === 'clicked_campaign') {
      const tsCol = fieldLower === 'clicked_campaign' ? 'sc.clicked_at' : 'sc.opened_at';
      const valStr = String(rawVal ?? '').trim();
      const hasSpecific = Boolean(valStr) && !['any', 'true', 'false', '1', '0'].includes(valStr.toLowerCase());
      let campFilter = '';
      if (hasSpecific) {
        const pCamp = pushParam(valStr);
        const pLike = pushParam(`%${valStr}%`);
        campFilter = ` AND (sc.campaign_id::text = ${pCamp} OR LOWER(COALESCE(c.name, '')) = LOWER(${pCamp}) OR COALESCE(c.name, '') ILIKE ${pLike})`;
      }
      const existsSql = `EXISTS (
        SELECT 1 FROM mkt_send_claims sc
        LEFT JOIN mkt_campaigns c ON c.tenant_id = sc.tenant_id AND c.id = sc.campaign_id
        WHERE sc.tenant_id = ${pTenant} AND sc.lead_id = l.id AND ${tsCol} IS NOT NULL${campFilter}
      )`;
      const baseNeg = baseOpNeg || rawVal === false || valStr.toLowerCase() === 'false';
      const wantNeg = baseNeg !== ruleNegated;
      return wantNeg ? `NOT (${existsSql})` : existsSql;
    }
    if (fieldLower === 'email_open_count' || fieldLower === 'email_click_count') {
      const isClick = fieldLower === 'email_click_count';
      const tsCol = isClick ? 'sc.clicked_at' : 'sc.opened_at';
      const evtA = pushParam(isClick ? 'email_clicked' : 'email_opened');
      const evtB = pushParam(isClick ? 'mkt_email_click' : 'mkt_email_open');
      const cntExpr = `GREATEST(
        (SELECT COUNT(*) FROM mkt_send_claims sc WHERE sc.tenant_id = ${pTenant} AND sc.lead_id = l.id AND ${tsCol} IS NOT NULL),
        (SELECT COUNT(*) FROM lead_timeline_events te WHERE te.tenant_id = ${pTenant} AND te.lead_id = l.id AND te.event_type IN (${evtA}, ${evtB}))
      )`;
      return compileNumericExpr(cntExpr);
    }
    if (fieldLower === 'is_suppressed') {
      const wantSuppressed = resolveBoolDesired();
      const supSql = `(COALESCE(l.email_consent, 'subscribed') IN ('unsubscribed', 'bounced', 'complained') OR EXISTS (
        SELECT 1 FROM mkt_suppression_list ms
        WHERE ms.tenant_id = ${pTenant}
          AND (
            (l.email IS NOT NULL AND LOWER(ms.recipient) = LOWER(l.email))
            OR (l.phone IS NOT NULL AND ms.recipient = l.phone)
          )
      ))`;
      return wantSuppressed ? supSql : `NOT (${supSql})`;
    }
    if (fieldLower === 'in_flow' || fieldLower === 'completed_flow') {
      const statusFilter =
        fieldLower === 'completed_flow'
          ? `fe.status = 'completed'`
          : `fe.status IN ('active', 'waiting', 'running')`;
      const valStr = String(rawVal ?? '').trim();
      const hasSpecific = Boolean(valStr) && !['any', 'true', 'false', '1', '0'].includes(valStr.toLowerCase());
      let flowFilter = '';
      if (hasSpecific) {
        const pFlow = pushParam(valStr);
        const pLike = pushParam(`%${valStr}%`);
        flowFilter = ` AND (fe.flow_id::text = ${pFlow} OR LOWER(COALESCE(f.name, '')) = LOWER(${pFlow}) OR COALESCE(f.name, '') ILIKE ${pLike})`;
      }
      const existsSql = `EXISTS (
        SELECT 1 FROM mkt_flow_enrollments fe
        LEFT JOIN mkt_flows f ON f.tenant_id = fe.tenant_id AND f.id = fe.flow_id
        WHERE fe.tenant_id = ${pTenant} AND fe.lead_id = l.id AND ${statusFilter}${flowFilter}
      )`;
      const baseNeg = baseOpNeg || rawVal === false || valStr.toLowerCase() === 'false';
      const wantNeg = baseNeg !== ruleNegated;
      return wantNeg ? `NOT (${existsSql})` : existsSql;
    }

    // 2m. Web Behavior Tracking (`web_visited_url`, `web_clicked_cta`, `web_max_scroll_pct`, `web_active_duration_sec`, `web_pricing_intent`, `web_device_type`)
    if (fieldLower === 'web_visited_url' || fieldLower === 'web_activity') {
      if (op === 'is_empty' || op === 'empty' || op === 'is_not_empty' || op === 'not_empty') {
        const wantEmpty = op === 'is_empty' || op === 'empty';
        const anyWeb = `(EXISTS (SELECT 1 FROM mkt_web_events we WHERE we.tenant_id = ${pTenant} AND we.lead_id = l.id) OR EXISTS (SELECT 1 FROM mkt_web_sessions ws WHERE ws.tenant_id = ${pTenant} AND ws.lead_id = l.id))`;
        return (ruleNegated ? !wantEmpty : wantEmpty) ? `NOT (${anyWeb})` : anyWeb;
      }
      const urlVal = String(rawVal ?? '').trim();
      if (!urlVal) return '1 = 0';
      const isExact = op === 'equals' || op === 'is' || op === '=' || op === 'not_equals' || op === 'neq' || op === '!=' || op === 'is_not';
      let matchSql: string;
      if (isExact) {
        const pUrl = pushParam(urlVal);
        matchSql = `(EXISTS (SELECT 1 FROM mkt_web_events we WHERE we.tenant_id = ${pTenant} AND we.lead_id = l.id AND LOWER(COALESCE(we.page_url, '')) = LOWER(${pUrl})) OR EXISTS (SELECT 1 FROM mkt_web_sessions ws WHERE ws.tenant_id = ${pTenant} AND ws.lead_id = l.id AND (LOWER(COALESCE(ws.entry_url, '')) = LOWER(${pUrl}) OR LOWER(COALESCE(ws.last_url, '')) = LOWER(${pUrl}))))`;
      } else {
        const pattern = op === 'starts_with' ? `${urlVal}%` : op === 'ends_with' ? `%${urlVal}` : `%${urlVal}%`;
        const pLike = pushParam(pattern);
        matchSql = `(EXISTS (SELECT 1 FROM mkt_web_events we WHERE we.tenant_id = ${pTenant} AND we.lead_id = l.id AND COALESCE(we.page_url, '') ILIKE ${pLike}) OR EXISTS (SELECT 1 FROM mkt_web_sessions ws WHERE ws.tenant_id = ${pTenant} AND ws.lead_id = l.id AND (COALESCE(ws.entry_url, '') ILIKE ${pLike} OR COALESCE(ws.last_url, '') ILIKE ${pLike})))`;
      }
      return isNegated ? `NOT (${matchSql})` : matchSql;
    }
    if (fieldLower === 'web_clicked_cta') {
      const ctaClickTypes = `we.event_type IN ('click', 'cta_click', 'web_click')`;
      if (op === 'is_empty' || op === 'empty' || op === 'is_not_empty' || op === 'not_empty') {
        const wantEmpty = op === 'is_empty' || op === 'empty';
        const anyClick = `EXISTS (SELECT 1 FROM mkt_web_events we WHERE we.tenant_id = ${pTenant} AND we.lead_id = l.id AND ${ctaClickTypes})`;
        return (ruleNegated ? !wantEmpty : wantEmpty) ? `NOT (${anyClick})` : anyClick;
      }
      const ctaVal = String(rawVal ?? '').trim();
      const isAny = !ctaVal || ['any', 'true', '1'].includes(ctaVal.toLowerCase());
      let existsSql: string;
      if (isAny) {
        existsSql = `EXISTS (SELECT 1 FROM mkt_web_events we WHERE we.tenant_id = ${pTenant} AND we.lead_id = l.id AND ${ctaClickTypes})`;
      } else {
        const isExact = op === 'equals' || op === 'is' || op === '=' || op === 'not_equals' || op === 'neq' || op === '!=' || op === 'is_not';
        const pMatch = pushParam(isExact ? ctaVal : `%${ctaVal}%`);
        const cmpSql = isExact
          ? `(LOWER(COALESCE(we.element_selector, '')) = LOWER(${pMatch}) OR LOWER(COALESCE(we.metadata->>'cta_text', '')) = LOWER(${pMatch}) OR LOWER(COALESCE(we.metadata->>'text', '')) = LOWER(${pMatch}) OR LOWER(COALESCE(we.metadata->>'label', '')) = LOWER(${pMatch}) OR LOWER(COALESCE(we.metadata->>'element_text', '')) = LOWER(${pMatch}) OR LOWER(COALESCE(we.metadata->>'button_text', '')) = LOWER(${pMatch}))`
          : `(COALESCE(we.element_selector, '') ILIKE ${pMatch} OR COALESCE(we.metadata->>'cta_text', '') ILIKE ${pMatch} OR COALESCE(we.metadata->>'text', '') ILIKE ${pMatch} OR COALESCE(we.metadata->>'label', '') ILIKE ${pMatch} OR COALESCE(we.metadata->>'element_text', '') ILIKE ${pMatch} OR COALESCE(we.metadata->>'button_text', '') ILIKE ${pMatch} OR COALESCE(we.metadata->>'href', '') ILIKE ${pMatch})`;
        existsSql = `EXISTS (SELECT 1 FROM mkt_web_events we WHERE we.tenant_id = ${pTenant} AND we.lead_id = l.id AND ${ctaClickTypes} AND ${cmpSql})`;
      }
      return isNegated ? `NOT (${existsSql})` : existsSql;
    }
    if (fieldLower === 'web_max_scroll_pct') {
      const scrollExpr = `COALESCE((SELECT MAX(COALESCE(we.scroll_depth_pct, CASE WHEN COALESCE(we.metadata->>'max_scroll_pct', '') ~ '^[0-9]+$' THEN CAST(we.metadata->>'max_scroll_pct' AS INTEGER) ELSE NULL END, 0)) FROM mkt_web_events we WHERE we.tenant_id = ${pTenant} AND we.lead_id = l.id), 0)`;
      return compileNumericExpr(scrollExpr);
    }
    if (fieldLower === 'web_active_duration_sec') {
      const durExpr = `COALESCE((SELECT SUM(COALESCE(ws.duration_seconds, 0)) FROM mkt_web_sessions ws WHERE ws.tenant_id = ${pTenant} AND ws.lead_id = l.id), 0)`;
      return compileNumericExpr(durExpr);
    }
    if (fieldLower === 'web_pricing_intent') {
      const wantIntent = resolveBoolDesired();
      const intentSql = `(EXISTS (SELECT 1 FROM mkt_web_sessions ws WHERE ws.tenant_id = ${pTenant} AND ws.lead_id = l.id AND ws.pricing_intent_detected = true) OR EXISTS (SELECT 1 FROM mkt_web_events we WHERE we.tenant_id = ${pTenant} AND we.lead_id = l.id AND we.event_type = 'pricing_intent'))`;
      return wantIntent ? intentSql : `NOT (${intentSql})`;
    }
    if (fieldLower === 'web_device_type' || fieldLower === 'device') {
      if (op === 'is_empty' || op === 'empty' || op === 'is_not_empty' || op === 'not_empty') {
        const wantEmpty = op === 'is_empty' || op === 'empty';
        const hasDev = `EXISTS (SELECT 1 FROM mkt_web_sessions ws WHERE ws.tenant_id = ${pTenant} AND ws.lead_id = l.id AND ws.device_type IS NOT NULL AND TRIM(ws.device_type) != '')`;
        return (ruleNegated ? !wantEmpty : wantEmpty) ? `NOT (${hasDev})` : hasDev;
      }
      const items = Array.isArray(rawVal)
        ? rawVal.map((v) => String(v ?? '').trim().toLowerCase()).filter(Boolean)
        : String(rawVal ?? '')
            .split(',')
            .map((v) => v.trim().toLowerCase())
            .filter(Boolean);
      if (items.length === 0) return '1 = 0';
      const pList = items.map((d) => `LOWER(${pushParam(d)})`).join(', ');
      const existsSql = `EXISTS (SELECT 1 FROM mkt_web_sessions ws WHERE ws.tenant_id = ${pTenant} AND ws.lead_id = l.id AND LOWER(COALESCE(ws.device_type, '')) IN (${pList}))`;
      return isNegated ? `NOT (${existsSql})` : existsSql;
    }

    // 2n. Survey, NPS, Voucher & Social (`survey_score`, `nps_category`, `voucher_claimed`, `social_channel`)
    if (fieldLower === 'survey_score') {
      const maxSurveyScoreExpr = `COALESCE((SELECT MAX(sr.quiz_score) FROM mkt_survey_responses sr WHERE sr.tenant_id = ${pTenant} AND sr.lead_id = l.id), 0)`;
      return compileNumericExpr(maxSurveyScoreExpr);
    }
    if (fieldLower === 'nps_category') {
      if (op === 'is_empty' || op === 'empty' || op === 'is_not_empty' || op === 'not_empty') {
        const wantEmpty = op === 'is_empty' || op === 'empty';
        const hasNps = `EXISTS (SELECT 1 FROM mkt_survey_responses sr WHERE sr.tenant_id = ${pTenant} AND sr.lead_id = l.id AND sr.nps_score IS NOT NULL)`;
        return (ruleNegated ? !wantEmpty : wantEmpty) ? `NOT (${hasNps})` : hasNps;
      }
      const cat = String(rawVal ?? '').trim().toLowerCase();
      let rangeSql = '';
      if (cat === 'promoter' || cat === 'promoters') rangeSql = 'sr.nps_score >= 9';
      else if (cat === 'passive' || cat === 'passives') rangeSql = 'sr.nps_score BETWEEN 7 AND 8';
      else if (cat === 'detractor' || cat === 'detractors') rangeSql = 'sr.nps_score <= 6';
      else return '1 = 0';
      const existsSql = `EXISTS (SELECT 1 FROM mkt_survey_responses sr WHERE sr.tenant_id = ${pTenant} AND sr.lead_id = l.id AND sr.nps_score IS NOT NULL AND ${rangeSql})`;
      return isNegated ? `NOT (${existsSql})` : existsSql;
    }
    if (fieldLower === 'voucher_claimed') {
      const valStr = String(rawVal ?? '').trim();
      const hasSpecific = Boolean(valStr) && !['any', 'true', 'false', '1', '0'].includes(valStr.toLowerCase());
      let existsSql: string;
      if (hasSpecific) {
        const pV = pushParam(valStr);
        const pLike = pushParam(`%${valStr}%`);
        existsSql = `EXISTS (
          SELECT 1 FROM mkt_voucher_codes vc
          LEFT JOIN mkt_voucher_campaigns vcamp ON vcamp.tenant_id = vc.tenant_id AND vcamp.id = vc.voucher_campaign_id
          WHERE vc.tenant_id = ${pTenant} AND vc.lead_id = l.id
            AND (vc.voucher_campaign_id::text = ${pV} OR LOWER(COALESCE(vc.code, '')) = LOWER(${pV}) OR COALESCE(vcamp.name, '') ILIKE ${pLike})
        )`;
      } else {
        existsSql = `(EXISTS (SELECT 1 FROM mkt_voucher_codes vc WHERE vc.tenant_id = ${pTenant} AND vc.lead_id = l.id) OR EXISTS (SELECT 1 FROM lead_timeline_events te WHERE te.tenant_id = ${pTenant} AND te.lead_id = l.id AND te.event_type IN ('voucher_claimed', 'voucher_redeemed', 'voucher_issued')))`;
      }
      const baseNeg = baseOpNeg || rawVal === false || valStr.toLowerCase() === 'false';
      const wantNeg = baseNeg !== ruleNegated;
      return wantNeg ? `NOT (${existsSql})` : existsSql;
    }
    if (fieldLower === 'social_channel') {
      if (op === 'is_empty' || op === 'empty' || op === 'is_not_empty' || op === 'not_empty') {
        const wantEmpty = op === 'is_empty' || op === 'empty';
        const hasSoc = `EXISTS (SELECT 1 FROM mkt_social_conversations sc WHERE sc.tenant_id = ${pTenant} AND sc.lead_id = l.id)`;
        return (ruleNegated ? !wantEmpty : wantEmpty) ? `NOT (${hasSoc})` : hasSoc;
      }
      const items = Array.isArray(rawVal)
        ? rawVal.map((v) => String(v ?? '').trim().toLowerCase()).filter(Boolean)
        : String(rawVal ?? '')
            .split(',')
            .map((v) => v.trim().toLowerCase())
            .filter(Boolean);
      if (items.length === 0) return '1 = 0';
      const pList = items.map((ch) => `LOWER(${pushParam(ch)})`).join(', ');
      const existsSql = `EXISTS (SELECT 1 FROM mkt_social_conversations sc WHERE sc.tenant_id = ${pTenant} AND sc.lead_id = l.id AND LOWER(COALESCE(sc.channel, '')) IN (${pList}))`;
      return isNegated ? `NOT (${existsSql})` : existsSql;
    }

    // 3. Relative Inactivity / Age Days (`inactive_days`, `lastActivityDays`, `days_since_engaged`, `days_since_created`, `crm_hours_uncontacted`)
    if (
      fieldLower === 'inactive_days' ||
      fieldLower === 'lastactivitydays' ||
      fieldLower === 'days_since_engaged' ||
      fieldLower === 'days_since_created' ||
      fieldLower === 'crm_hours_uncontacted'
    ) {
      const safeNum = parseFiniteNonNegInt(rawVal, 87_600);
      if (safeNum === null) return '1 = 0';
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
      let baseExpr: string;
      if (op === 'gt' || op === '>' || op === 'greater_than' || op === 'not_in_the_last') baseExpr = `${colExpr} < ${thresholdExpr}`;
      else if (op === 'gte' || op === '>=') baseExpr = `${colExpr} <= ${thresholdExpr}`;
      else if (op === 'lt' || op === '<' || op === 'less_than' || op === 'in_the_last') baseExpr = `${colExpr} > ${thresholdExpr}`;
      else if (op === 'lte' || op === '<=') baseExpr = `${colExpr} >= ${thresholdExpr}`;
      else baseExpr = `${colExpr} <= ${thresholdExpr}`;
      return ruleNegated ? `NOT (${baseExpr})` : baseExpr;
    }

    // 3b. Date Columns (`created_at`, `crm_created_at`, `joinedAt`, `lastActivity`)
    if (
      fieldLower === 'created_at' ||
      fieldLower === 'crm_created_at' ||
      fieldLower === 'joinedat' ||
      fieldLower === 'lastactivity'
    ) {
      const colExpr = fieldLower === 'lastactivity' ? 'COALESCE(l.last_engaged_at, l.updated_at, l.created_at)' : 'l.created_at';
      if (op === 'is_empty' || op === 'empty' || op === 'is_not_empty' || op === 'not_empty') {
        const wantEmpty = op === 'is_empty' || op === 'empty';
        return (ruleNegated ? !wantEmpty : wantEmpty) ? `${colExpr} IS NULL` : `${colExpr} IS NOT NULL`;
      }
      const wrapDate = (expr: string): string => (ruleNegated ? `(${colExpr} IS NULL OR NOT (${expr}))` : expr);
      if (op === 'within_days' || op === 'in_the_last') {
        const d = parseFiniteNonNegInt(rawVal, 36_500);
        if (d === null) return '1 = 0';
        return wrapDate(`${colExpr} >= (clock_timestamp() - INTERVAL '${d} days')`);
      }
      if (op === 'not_in_the_last') {
        const d = parseFiniteNonNegInt(rawVal, 36_500);
        if (d === null) return '1 = 0';
        return wrapDate(`${colExpr} < (clock_timestamp() - INTERVAL '${d} days')`);
      }
      const dateStr = String(rawVal ?? '').trim().slice(0, 32);
      if (!dateStr || !/^\d{4}-\d{2}-\d{2}/.test(dateStr) || Number.isNaN(Date.parse(dateStr))) return '1 = 0';
      const pDate = pushParam(dateStr);
      if (op === 'after' || op === 'gt' || op === '>') return wrapDate(`CAST(${colExpr} AS DATE) > CAST(${pDate} AS DATE)`);
      if (op === 'before' || op === 'lt' || op === '<') return wrapDate(`CAST(${colExpr} AS DATE) < CAST(${pDate} AS DATE)`);
      const isNotEqOp = op === 'not_equals' || op === '!=' || op === 'neq' || op === 'is_not';
      const wantNot = isNotEqOp !== ruleNegated;
      const eqExpr = `CAST(${colExpr} AS DATE) = CAST(${pDate} AS DATE)`;
      return wantNot ? `(${colExpr} IS NULL OR NOT (${eqExpr}))` : eqExpr;
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
      const isNotEqOp = op === 'neq' || op === '!=' || op === 'not_equals' || op === 'is_not';
      const cmp =
        op === 'gt' || op === '>' || op === 'greater_than'
          ? '>'
          : op === 'lt' || op === '<' || op === 'less_than'
            ? '<'
            : op === 'lte' || op === '<='
              ? '<='
              : op === 'equals' || op === 'is' || op === '=' || isNotEqOp
                ? '='
                : '>=';
      const countExpr = `(SELECT COUNT(*) FROM lead_timeline_events te WHERE te.tenant_id = ${pTenant} AND te.lead_id = l.id AND te.event_type IN (${evtPh})) ${cmp} ${pCnt}`;
      const wantNot = isNotEqOp !== ruleNegated;
      return wantNot ? `NOT (${countExpr})` : countExpr;
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

      const baseNeg =
        baseOpNeg ||
        op === 'not_has_event' ||
        rawVal === false ||
        String(rawVal).toLowerCase() === 'false';
      const wantNegate = baseNeg !== ruleNegated;

      const existsSql = `EXISTS (
        SELECT 1 FROM lead_timeline_events te
        WHERE te.tenant_id = ${pTenant} AND te.lead_id = l.id AND ${eventMatchSql}${timeSql}
      )`;
      return wantNegate ? `NOT (${existsSql})` : existsSql;
    }

    // 5. Quiz Score (`quiz_score`)
    if (fieldLower === 'quiz_score') {
      const rawQuizExpr = `COALESCE(NULLIF(te.metadata->>'quiz_score', ''), NULLIF(te.metadata->>'score', ''))`;
      const numExpr = `(CASE WHEN COALESCE(${rawQuizExpr}, '') ~ '^-?[0-9]+([.][0-9]+)?$' THEN CAST(${rawQuizExpr} AS DECIMAL(12,2)) ELSE NULL END)`;
      if (op === 'between') {
        const minV = Number(rule.min ?? (Array.isArray(rawVal) ? rawVal[0] : 0));
        const maxV = Number(rule.max ?? (Array.isArray(rawVal) ? rawVal[1] : 0));
        if (!Number.isFinite(minV) || !Number.isFinite(maxV)) return '1 = 0';
        const pMin = pushParam(minV);
        const pMax = pushParam(maxV);
        const existsSql = `EXISTS (
          SELECT 1 FROM lead_timeline_events te
          WHERE te.tenant_id = ${pTenant}
            AND te.lead_id = l.id
            AND te.event_type IN ('survey_completed', 'quiz_completed')
            AND ${numExpr} IS NOT NULL
            AND ${numExpr} BETWEEN ${pMin} AND ${pMax}
        )`;
        return isNegated ? `NOT (${existsSql})` : existsSql;
      }
      const targetScore = Number(rawVal || 0);
      if (!Number.isFinite(targetScore)) return '1 = 0';
      const pScore = pushParam(targetScore);
      const isNotEqOp = op === 'not_equals' || op === '!=' || op === 'neq' || op === 'is_not';
      const cmp =
        op === 'gt' || op === '>' || op === 'greater_than'
          ? '>'
          : op === 'lt' || op === '<' || op === 'less_than'
            ? '<'
            : op === 'lte' || op === '<='
              ? '<='
              : op === 'equals' || op === '=' || op === 'is' || isNotEqOp
                ? '='
                : '>=';
      const existsSql = `EXISTS (
        SELECT 1 FROM lead_timeline_events te
        WHERE te.tenant_id = ${pTenant}
          AND te.lead_id = l.id
          AND te.event_type IN ('survey_completed', 'quiz_completed')
          AND ${numExpr} IS NOT NULL
          AND ${numExpr} ${cmp} ${pScore}
      )`;
      const wantNegate = isNotEqOp ? !rule.negate : Boolean(rule.negate);
      return wantNegate ? `NOT (${existsSql})` : existsSql;
    }

    // 6. Revenue convenience boolean (`has_revenue`)
    if (fieldLower === 'has_revenue') {
      const truthy = rawVal === undefined || rawVal === true || String(rawVal).toLowerCase() === 'true' || rawVal === 1;
      const wantPositive = isNegated ? !truthy : truthy;
      return wantPositive ? 'COALESCE(l.total_revenue_vnd, 0) > 0' : 'COALESCE(l.total_revenue_vnd, 0) <= 0';
    }

    // 7. Boolean Columns
    if (fieldLower in BOOLEAN_COLUMNS_MAP) {
      const col = BOOLEAN_COLUMNS_MAP[fieldLower];
      if (op === 'is_empty' || op === 'empty' || op === 'is_null' || op === 'is_not_empty' || op === 'not_empty' || op === 'is_not_null') {
        const wantEmpty = op === 'is_empty' || op === 'empty' || op === 'is_null';
        const effectiveEmpty = ruleNegated ? !wantEmpty : wantEmpty;
        return effectiveEmpty ? `(${col} IS NULL)` : `(${col} IS NOT NULL)`;
      }
      const truthy =
        rawVal === undefined
          ? op !== 'is_false' && op !== 'false'
          : rawVal === true || String(rawVal).toLowerCase() === 'true' || String(rawVal) === '1';
      const finalBool = isNegated ? !truthy : truthy;
      return `COALESCE(${col}, false) = ${finalBool ? 'true' : 'false'}`;
    }

    // 8. Numeric Columns (`lead_score`, `total_revenue_vnd`)
    if (fieldLower in NUMERIC_COLUMNS_MAP) {
      const col = `COALESCE(${NUMERIC_COLUMNS_MAP[fieldLower]}, 0)`;
      if (op === 'between') {
        const minVal = Number(rule.min ?? (Array.isArray(rawVal) ? rawVal[0] : 0));
        const maxVal = Number(rule.max ?? (Array.isArray(rawVal) ? rawVal[1] : 0));
        if (!Number.isFinite(minVal) || !Number.isFinite(maxVal)) return '1 = 0';
        const pMin = pushParam(minVal);
        const pMax = pushParam(maxVal);
        const expr = `${col} BETWEEN ${pMin} AND ${pMax}`;
        return ruleNegated ? `NOT (${expr})` : expr;
      }
      const num = Number(rawVal);
      if (!Number.isFinite(num)) return '1 = 0';
      const pNum = pushParam(num);
      const isNotEqOp = op === 'neq' || op === '!=' || op === 'not_equals' || op === 'is_not';
      let baseExpr: string;
      switch (op) {
        case 'gt':
        case '>':
        case 'greater_than':
          baseExpr = `${col} > ${pNum}`;
          break;
        case 'gte':
        case '>=':
          baseExpr = `${col} >= ${pNum}`;
          break;
        case 'lt':
        case '<':
        case 'less_than':
          baseExpr = `${col} < ${pNum}`;
          break;
        case 'lte':
        case '<=':
          baseExpr = `${col} <= ${pNum}`;
          break;
        default:
          baseExpr = `${col} = ${pNum}`;
          break;
      }
      const wantNot = isNotEqOp !== ruleNegated;
      return wantNot ? `NOT (${baseExpr})` : baseExpr;
    }

    // 8b. Birthday / Anniversary Date Fields & Operators (`is_today`, `is_this_month`, `before_days`, `on`, `before`, `after`)
    const BIRTHDAY_ALIASES = new Set([
      'birthday',
      'dob',
      'dateofbirth',
      'date_of_birth',
      'anniversarydate',
      'anniversary_date',
      'ngay_sinh',
      'cf.birthday',
      'custom_fields.birthday',
      'cf.dob',
      'custom_fields.dob',
      'cf.dateofbirth',
      'custom_fields.dateofbirth',
      'cf.date_of_birth',
      'custom_fields.date_of_birth',
      'cf.anniversarydate',
      'custom_fields.anniversarydate',
      'cf.anniversary_date',
      'custom_fields.anniversary_date',
      'cf.ngay_sinh',
      'custom_fields.ngay_sinh',
    ]);
    const isBirthdayField =
      BIRTHDAY_ALIASES.has(fieldLower) ||
      ((fieldLower.startsWith('cf.') || fieldLower.startsWith('custom_fields.') || fieldLower.startsWith('custom.')) &&
        ['is_today', 'is_this_month', 'before_days'].includes(op));

    if (isBirthdayField) {
      let dateExpr: string;
      if (fieldLower.startsWith('cf.') || fieldLower.startsWith('custom_fields.') || fieldLower.startsWith('custom.')) {
        const rawKey = rawField.replace(/^(?:custom_fields|cf|custom)\./i, '').trim();
        if (!SAFE_CUSTOM_KEY_REGEX.test(rawKey)) return '1 = 0';
        const lk = rawKey.toLowerCase();
        if (lk === 'birthday' || lk === 'dob' || lk === 'dateofbirth' || lk === 'date_of_birth' || lk === 'ngay_sinh') {
          dateExpr = `COALESCE(NULLIF(l.custom_fields->>'${rawKey}', ''), NULLIF(l.custom_fields->>'birthday', ''), NULLIF(l.custom_fields->>'dob', ''), NULLIF(l.custom_fields->>'dateOfBirth', ''), NULLIF(l.custom_fields->>'date_of_birth', ''), NULLIF(l.custom_fields->>'ngay_sinh', ''))`;
        } else {
          dateExpr = `NULLIF(l.custom_fields->>'${rawKey}', '')`;
        }
      } else {
        dateExpr = `COALESCE(NULLIF(l.custom_fields->>'birthday', ''), NULLIF(l.custom_fields->>'dob', ''), NULLIF(l.custom_fields->>'dateOfBirth', ''), NULLIF(l.custom_fields->>'date_of_birth', ''), NULLIF(l.custom_fields->>'anniversaryDate', ''), NULLIF(l.custom_fields->>'anniversary_date', ''), NULLIF(l.custom_fields->>'ngay_sinh', ''))`;
      }

      if (
        op === 'is_empty' ||
        op === 'empty' ||
        op === 'is_null' ||
        op === 'is_not_empty' ||
        op === 'not_empty' ||
        op === 'is_not_null'
      ) {
        const emptyExpr = `(${dateExpr} IS NULL OR TRIM(${dateExpr}) = '')`;
        const notEmptyExpr = `(${dateExpr} IS NOT NULL AND TRIM(${dateExpr}) != '')`;
        const wantEmpty = op === 'is_empty' || op === 'empty' || op === 'is_null';
        const effectiveEmpty = Boolean(rule.negate) ? !wantEmpty : wantEmpty;
        return effectiveEmpty ? emptyExpr : notEmptyExpr;
      }

      const now = new Date();
      const pad2 = (n: number) => String(n).padStart(2, '0');
      const todayMm = pad2(now.getMonth() + 1);
      const todayMmDd = `${todayMm}-${pad2(now.getDate())}`;

      const isNotEqOp = op === 'not_equals' || op === '!=' || op === 'neq' || op === 'is_not';
      const wantNegate = isNotEqOp ? !rule.negate : isNegated;
      const wrapBday = (matchSql: string): string => (wantNegate ? `NOT (${matchSql})` : matchSql);

      if (op === 'is_today') {
        const pToday = pushParam(todayMmDd);
        return wrapBday(`(${dateExpr} IS NOT NULL AND SUBSTRING(${dateExpr}, 6, 5) = ${pToday})`);
      }
      if (op === 'is_this_month') {
        const pMonth = pushParam(todayMm);
        return wrapBday(`(${dateExpr} IS NOT NULL AND SUBSTRING(${dateExpr}, 6, 2) = ${pMonth})`);
      }
      if (op === 'before_days') {
        const days = Math.max(0, Math.min(365, Math.floor(Number(rawVal ?? 0))));
        if (!Number.isFinite(days)) return '1 = 0';
        const mmDdList: string[] = [];
        for (let i = 0; i <= days; i++) {
          const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() + i);
          mmDdList.push(`${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`);
        }
        const uniqueMmDd = Array.from(new Set(mmDdList));
        const pList = uniqueMmDd.map((item) => pushParam(item)).join(', ');
        return wrapBday(`(${dateExpr} IS NOT NULL AND SUBSTRING(${dateExpr}, 6, 5) IN (${pList}))`);
      }

      const dateStr = String(rawVal ?? '').trim().slice(0, 32);
      const mmDdMatch = dateStr.match(/^(\d{2})-(\d{2})$/);
      if (mmDdMatch) {
        const mm = Number(mmDdMatch[1]);
        const dd = Number(mmDdMatch[2]);
        if (mm < 1 || mm > 12 || dd < 1 || dd > 31) return '1 = 0';
        const pMmDd = pushParam(dateStr);
        if (op === 'before' || op === 'lt' || op === '<') {
          return wrapBday(`(${dateExpr} IS NOT NULL AND SUBSTRING(${dateExpr}, 6, 5) < ${pMmDd})`);
        }
        if (op === 'after' || op === 'gt' || op === '>') {
          return wrapBday(`(${dateExpr} IS NOT NULL AND SUBSTRING(${dateExpr}, 6, 5) > ${pMmDd})`);
        }
        return wrapBday(`(${dateExpr} IS NOT NULL AND SUBSTRING(${dateExpr}, 6, 5) = ${pMmDd})`);
      }
      if (!dateStr || !/^\d{4}-\d{2}-\d{2}/.test(dateStr) || Number.isNaN(Date.parse(dateStr))) return '1 = 0';
      if (op === 'before' || op === 'lt' || op === '<') {
        const pDate = pushParam(dateStr.slice(0, 10));
        return wrapBday(`(${dateExpr} IS NOT NULL AND SUBSTRING(${dateExpr}, 1, 10) < ${pDate})`);
      }
      if (op === 'after' || op === 'gt' || op === '>') {
        const pDate = pushParam(dateStr.slice(0, 10));
        return wrapBday(`(${dateExpr} IS NOT NULL AND SUBSTRING(${dateExpr}, 1, 10) > ${pDate})`);
      }
      const pFull = pushParam(dateStr.slice(0, 10));
      return wrapBday(`(${dateExpr} IS NOT NULL AND SUBSTRING(${dateExpr}, 1, 10) = ${pFull})`);
    }

    // 9. Resolve Target Text / ID / Dynamic Custom Field Expression
    let strExpr: string | null = null;
    let customFieldKey: string | null = null;

    if (fieldLower === 'firstname' || fieldLower === 'first_name') {
      strExpr = `COALESCE(NULLIF(l.custom_fields->>'first_name', ''), NULLIF(l.custom_fields->>'firstName', ''), l.name)`;
    } else if (fieldLower === 'lastname' || fieldLower === 'last_name') {
      strExpr = `COALESCE(NULLIF(l.custom_fields->>'last_name', ''), NULLIF(l.custom_fields->>'lastName', ''), l.name)`;
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
      strExpr = `(l.custom_fields->>'${rawKey}')`;
    } else if (SAFE_CUSTOM_KEY_REGEX.test(rawField)) {
      // Allow direct custom field key when valid identifier (whitelist-validated)
      customFieldKey = rawField;
      strExpr = `(l.custom_fields->>'${rawField}')`;
    }

    if (!strExpr) {
      return '1 = 0';
    }

    // Numeric comparison on a Custom Field (`budget_vnd >= 3000000000`)
    if (customFieldKey && ['gt', '>', 'greater_than', 'gte', '>=', 'lt', '<', 'less_than', 'lte', '<=', 'between'].includes(op)) {
      const safeNumCast = `CASE WHEN COALESCE(${strExpr}, '') ~ '^-?[0-9]+([.][0-9]+)?$' THEN CAST(${strExpr} AS DECIMAL(20,4)) ELSE NULL END`;
      if (op === 'between') {
        const minV = Number(rule.min ?? (Array.isArray(rawVal) ? rawVal[0] : 0));
        const maxV = Number(rule.max ?? (Array.isArray(rawVal) ? rawVal[1] : 0));
        if (!Number.isFinite(minV) || !Number.isFinite(maxV)) return '1 = 0';
        const pMin = pushParam(minV);
        const pMax = pushParam(maxV);
        const expr = `((${safeNumCast}) IS NOT NULL AND (${safeNumCast}) BETWEEN ${pMin} AND ${pMax})`;
        return ruleNegated ? `((${safeNumCast}) IS NULL OR NOT ((${safeNumCast}) BETWEEN ${pMin} AND ${pMax}))` : expr;
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
      const matchExpr = `((${safeNumCast}) ${sqlOp} ${pN})`;
      return ruleNegated ? `((${safeNumCast}) IS NULL OR NOT ${matchExpr})` : matchExpr;
    }

    // Boolean check on a Custom Field (`custom.vip_flag is_true` / `is_false`)
    if (customFieldKey && (op === 'is_true' || op === 'is_false')) {
      const wantTrue = op === 'is_true';
      const effectiveTrue = ruleNegated ? !wantTrue : wantTrue;
      const trueSql = `LOWER(TRIM(COALESCE(${strExpr}, ''))) IN ('true', '1', 'yes', 'có', 'co')`;
      return effectiveTrue ? trueSql : `NOT (${trueSql})`;
    }

    // String / ID operators
    if (op === 'is_empty' || op === 'empty' || op === 'is_null' || op === 'is_not_empty' || op === 'not_empty' || op === 'is_not_null') {
      const wantEmpty = op === 'is_empty' || op === 'empty' || op === 'is_null';
      const effectiveEmpty = ruleNegated ? !wantEmpty : wantEmpty;
      return effectiveEmpty
        ? `(${strExpr} IS NULL OR TRIM(${strExpr}) = '')`
        : `(${strExpr} IS NOT NULL AND TRIM(${strExpr}) != '')`;
    }

    if (op === 'in' || op === 'in_list' || op === 'not_in' || op === 'not_in_list' || op === 'notin') {
      const items = Array.isArray(rawVal)
        ? rawVal.map((v) => String(v ?? '').trim()).filter(Boolean)
        : String(rawVal ?? '')
            .split(',')
            .map((v) => v.trim())
            .filter(Boolean);
      const baseIn = op === 'in' || op === 'in_list';
      const wantIn = ruleNegated ? !baseIn : baseIn;
      if (items.length === 0) return wantIn ? '1 = 0' : '1 = 1';
      const pList = items.map((item) => `LOWER(${pushParam(item)})`).join(', ');
      const inSql = `LOWER(COALESCE(${strExpr}, '')) IN (${pList})`;
      return wantIn ? inSql : `NOT (${inSql})`;
    }

    const strVal = String(rawVal ?? '').trim();
    if (op === 'contains' || op === 'not_contains' || op === 'notcontains') {
      const p = pushParam(`%${strVal}%`);
      const baseNeg = op !== 'contains';
      const wantNeg = baseNeg !== ruleNegated;
      const expr = `COALESCE(${strExpr}, '') ILIKE ${p}`;
      return wantNeg ? `NOT (${expr})` : expr;
    }
    if (op === 'starts_with' || op === 'startswith') {
      const p = pushParam(`${strVal}%`);
      const expr = `COALESCE(${strExpr}, '') ILIKE ${p}`;
      return ruleNegated ? `NOT (${expr})` : expr;
    }
    if (op === 'ends_with' || op === 'endswith') {
      const p = pushParam(`%${strVal}`);
      const expr = `COALESCE(${strExpr}, '') ILIKE ${p}`;
      return ruleNegated ? `NOT (${expr})` : expr;
    }
    if (op === 'not_equals' || op === 'neq' || op === '!=' || op === 'is_not') {
      const p = pushParam(strVal);
      const eqExpr = `LOWER(COALESCE(${strExpr}, '')) = LOWER(${p})`;
      return ruleNegated ? eqExpr : `NOT (${eqExpr})`;
    }

    // Default: case-insensitive exact match
    const pEq = pushParam(strVal);
    const eqExpr = `LOWER(COALESCE(${strExpr}, '')) = LOWER(${pEq})`;
    return ruleNegated ? `NOT (${eqExpr})` : eqExpr;
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
  if (options?.audienceIdForExclusions && UUID_REGEX.test(String(options.audienceIdForExclusions).trim())) {
    const pExAud = pushParam(String(options.audienceIdForExclusions).trim());
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
    const cleanIds = options.extraExcludeAudienceIds
      .map((x) => String(x || '').trim())
      .filter((x) => UUID_REGEX.test(x));
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
