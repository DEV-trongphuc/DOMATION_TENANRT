import crypto from 'node:crypto';
import type { DbClient } from '../../core/database/db-adapter.ts';
import type { TenantContext } from '../../core/context/tenant-context.ts';
import {
  buildGranularScopeWhereClause,
  normalizeDataScope,
  type DataScope,
  type GranularAction,
  type ResolvedUserRbacResult,
  type UserOrgAuthSnapshot,
} from '../../core/security/rbac.ts';
import {
  SAAS_MODULES_CATALOG,
  normalizeCanonicalModuleKey,
  type SaasModuleKey,
  type SaasPackageCode,
  type TenantTerminology,
} from '../../core/security/entitlements.ts';
import {
  maskContactPiiIfDisallowed,
  maskPiiInText,
  type PiiMaskOptions,
} from '../../core/security/pii-masker.ts';

export type DomToolGroupKey =
  | 'crm_autodata'
  | 'marketing_audiences'
  | 'org_rbac_rag'
  | 'hrm_payroll'
  | 'erp_ops_finance';

export interface DomToolParameterProp {
  type: 'STRING' | 'NUMBER' | 'INTEGER' | 'BOOLEAN';
  description: string;
  enum?: string[];
}

export interface ToolExecutionContext {
  client: DbClient;
  tenantCtx: TenantContext;
  tenantId: string;
  userId: string;
  packageCode: SaasPackageCode;
  enabledModules: string[];
  terminology: TenantTerminology;
  piiOptions: PiiMaskOptions;
  resolvedRbac: ResolvedUserRbacResult;
  effectiveScope: DataScope;
  canUnmaskPhone: boolean;
  canViewFinancials: boolean;
}

export interface DomAgentToolDefinition {
  name: string;
  title: string;
  description: string;
  group: DomToolGroupKey;
  groupLabel: string;
  moduleKey: SaasModuleKey;
  extraRequiredModules?: SaasModuleKey[];
  requiredAction: GranularAction;
  isMutating?: boolean;
  specialistKeys: string[];
  parameters: Record<string, DomToolParameterProp>;
  requiredParams?: string[];
  execute: (ctx: ToolExecutionContext, args: Record<string, unknown>) => Promise<Record<string, unknown>>;
}

export interface DomToolExecutionResult {
  allowed: boolean;
  status_code: number;
  error_code?: string;
  denial_reason?: string;
  upgrade_hint?: string;
  tool_name: string;
  tool_title?: string;
  module_key: string;
  required_action: string;
  effective_scope: DataScope;
  pii_masked: boolean;
  audit_log_id: string;
  latency_ms: number;
  output?: Record<string, unknown>;
}

const ALWAYS_ENABLED_SET = new Set<string>(
  SAAS_MODULES_CATALOG.filter((m) => m.always_enabled).map((m) => m.key)
);

/**
 * Strict Package Entitlement Gate Helper:
 * Checks whether the tenant's active `enabledModules` list includes `moduleKey`.
 */
export function hasModuleEntitlement(
  enabledModules: readonly string[],
  moduleKey: SaasModuleKey | string
): boolean {
  const canonical = normalizeCanonicalModuleKey(moduleKey) || String(moduleKey).trim().toLowerCase();
  if (ALWAYS_ENABLED_SET.has(canonical)) {
    return true;
  }
  return enabledModules.includes(canonical) || enabledModules.includes(String(moduleKey));
}

export function buildUpgradeHintForModule(moduleKey: SaasModuleKey | string): string {
  const canonical = normalizeCanonicalModuleKey(moduleKey) || String(moduleKey);
  if (canonical === 'education') {
    return 'Vui lòng bật công tắc "Education Vertical Add-on" trên gói DOMATION PROMAX trong Cài đặt Hệ thống.';
  }
  const modDesc = SAAS_MODULES_CATALOG.find((m) => m.key === canonical);
  if (!modDesc) {
    return 'Vui lòng nâng cấp lên gói DOMATION PROMAX để mở khóa công cụ này.';
  }
  switch (modDesc.group) {
    case 'crm_autodata':
      return 'Tính năng thuộc cụm Auto Data & CRM — vui lòng nâng cấp lên Gói 3 (Growth Suite) hoặc Gói 4 (DOMATION PROMAX).';
    case 'marketing':
      return 'Tính năng thuộc cụm Marketing Automation — vui lòng nâng cấp lên Gói 2 (Marketing Standalone), Gói 3 (Growth Suite) hoặc Gói 4 (DOMATION PROMAX).';
    case 'growth':
      return 'Tính năng thuộc cụm Growth Attribution — vui lòng nâng cấp lên Gói 3 (Growth Suite) hoặc Gói 4 (DOMATION PROMAX).';
    default:
      return 'Tính năng thuộc cụm Quản trị ERP Nội bộ — vui lòng nâng cấp lên Gói 4 (DOMATION PROMAX) để mở khóa tức thì 0 giây migrate.';
  }
}

/**
 *Extended Scope SQL Builder supporting all 7 canonical scopes plus `department_tree` & `custom_departments`.
 */
export async function buildExtendedToolScopeWhere(
  client: DbClient,
  tenantId: string,
  userOrg: UserOrgAuthSnapshot | null,
  rawScope: DataScope | 'department_tree' | 'custom_departments',
  options?: {
    tenantColumn?: string;
    ownerColumn?: string;
    startParamIndex?: number;
    allowUnassignedForManagers?: boolean;
    customDepartmentIds?: string[];
  }
): Promise<{ clause: string; values: unknown[]; nextIndex: number }> {
  const startIdx = options?.startParamIndex ?? 1;
  const tenantCol = options?.tenantColumn || 'l.tenant_id';
  const ownerCol = options?.ownerColumn || 'l.assigned_to';

  if (!userOrg) {
    return {
      clause: `${tenantCol} = $${startIdx} AND 1 = 0`,
      values: [tenantId],
      nextIndex: startIdx + 1,
    };
  }

  if (rawScope === 'custom_departments') {
    const customDepts = (options?.customDepartmentIds || []).filter(Boolean);
    if (customDepts.length === 0) {
      return buildGranularScopeWhereClause(client, tenantId, userOrg, 'own', {
        tenantColumn: tenantCol,
        ownerColumn: ownerCol,
        startParamIndex: startIdx,
      });
    }
    const pTenant = `$${startIdx}`;
    const pUser = `$${startIdx + 1}`;
    const placeholders = customDepts.map((_, i) => `$${startIdx + 2 + i}`).join(', ');
    return {
      clause: `${tenantCol} = ${pTenant} AND (${ownerCol} = ${pUser} OR ${ownerCol} IN (SELECT u_cd.id FROM users u_cd WHERE u_cd.tenant_id = ${pTenant} AND u_cd.department_id IN (${placeholders})))`,
      values: [tenantId, userOrg.user_id, ...customDepts],
      nextIndex: startIdx + 2 + customDepts.length,
    };
  }

  const mappedScope: DataScope =
    rawScope === 'department_tree' ? 'sub_departments' : normalizeDataScope(rawScope, 'none');

  return buildGranularScopeWhereClause(client, tenantId, userOrg, mappedScope, {
    tenantColumn: tenantCol,
    ownerColumn: ownerCol,
    startParamIndex: startIdx,
    allowUnassignedForManagers: options?.allowUnassignedForManagers,
  });
}

/**
 * Inspects `information_schema.columns` without throwing SQL errors (safe inside PG transactions!).
 */
export async function getTableColumnsSafe(
  client: DbClient,
  tableName: string
): Promise<Set<string>> {
  const cleanName = String(tableName || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_]/g, '');
  if (!cleanName) return new Set();

  if (client.dialect === 'mariadb') {
    const r = await client.query<{ col_name: string }>(
      `SELECT LOWER(column_name) AS col_name
       FROM information_schema.columns
       WHERE table_schema = DATABASE() AND LOWER(table_name) = $1`,
      [cleanName]
    );
    return new Set(r.rows.map((row) => String(row.col_name)));
  }

  const r = await client.query<{ col_name: string }>(
    `SELECT LOWER(column_name) AS col_name
     FROM information_schema.columns
     WHERE table_schema = 'public' AND LOWER(table_name) = $1`,
    [cleanName]
  );
  return new Set(r.rows.map((row) => String(row.col_name)));
}

/**
 * Runs an optional Wave 2 query wrapped in a PostgreSQL/MariaDB SAVEPOINT so any missing
 * optional schema/column never aborts the active `withTenantTransaction`!
 */
export async function runOptionalSavepointQuery<R extends Record<string, unknown> = Record<string, unknown>>(
  client: DbClient,
  sql: string,
  params: unknown[] = []
): Promise<R[] | null> {
  const sp = 'sp_dom_opt_q';
  await client.query(`SAVEPOINT ${sp}`);
  try {
    const res = await client.query<R>(sql, params);
    await client.query(`RELEASE SAVEPOINT ${sp}`);
    return res.rows;
  } catch {
    await client.query(`ROLLBACK TO SAVEPOINT ${sp}`).catch(() => {});
    await client.query(`RELEASE SAVEPOINT ${sp}`).catch(() => {});
    return null;
  }
}

export function sanitizeContactRow<
  T extends { phone?: string | null; email?: string | null; pii_masked?: boolean },
>(row: T, canUnmaskPhone: boolean, piiOptions: PiiMaskOptions): T {
  return maskContactPiiIfDisallowed(row, canUnmaskPhone, piiOptions);
}

export function sanitizeFreeText(
  text: string | null | undefined,
  canUnmaskPhone: boolean,
  piiOptions: PiiMaskOptions
): string {
  if (!text) return '';
  if (canUnmaskPhone) return text;
  return maskPiiInText(text, piiOptions) || '';
}

export function summarizeArgsForAudit(rawArgs: Record<string, unknown>): Record<string, unknown> {
  const summary: Record<string, unknown> = {};
  const entries = Object.entries(rawArgs || {}).slice(0, 12);
  for (const [k, v] of entries) {
    if (k.toLowerCase().includes('password') || k.toLowerCase().includes('secret') || k.toLowerCase().includes('api_key')) {
      summary[k] = '[REDACTED]';
    } else if (typeof v === 'string') {
      summary[k] = v.length > 160 ? `${v.slice(0, 160)}...` : v;
    } else if (typeof v === 'number' || typeof v === 'boolean' || v === null) {
      summary[k] = v;
    } else if (Array.isArray(v)) {
      summary[k] = `[Array(${v.length})]`;
    } else if (typeof v === 'object') {
      summary[k] = '[Object]';
    }
  }
  return summary;
}

export async function insertDomToolAuditLog(
  client: DbClient,
  params: {
    tenantId: string;
    userId: string;
    toolName: string;
    moduleKey: string;
    requiredAction: string;
    dataScope: string;
    allowed: boolean;
    denialReason: string | null;
    argsSummary: Record<string, unknown>;
    latencyMs: number;
  }
): Promise<string> {
  const id = crypto.randomUUID();
  await client.query(
    `INSERT INTO tenant_ai_tool_audit_logs (
       id, tenant_id, user_id, tool_name, module_key, required_action,
       data_scope, allowed, denial_reason, args_summary, latency_ms
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb, $11)`,
    [
      id,
      params.tenantId,
      params.userId,
      params.toolName,
      params.moduleKey,
      params.requiredAction,
      params.dataScope || 'none',
      params.allowed,
      params.denialReason,
      JSON.stringify(params.argsSummary || {}),
      Math.max(0, Math.round(params.latencyMs || 0)),
    ]
  );
  return id;
}

/**
 * Progressive Vietnam Personal Income Tax (7 brackets) + Employee BHXH/BHYT/BHTN Calculator
 * Zero-hardcode configurable deductions with standard statutory defaults.
 */
export function calculateVietnamGrossToNet(input: {
  grossSalaryVnd: number;
  dependentsCount?: number;
  insuranceSalaryBaseVnd?: number;
  personalDeductionVnd?: number;
  dependentDeductionVnd?: number;
}): Record<string, unknown> {
  const gross = Math.max(0, Math.round(Number(input.grossSalaryVnd || 0)));
  const dependents = Math.max(0, Math.floor(Number(input.dependentsCount || 0)));
  const insBase = Math.max(
    0,
    Math.min(
      gross,
      input.insuranceSalaryBaseVnd !== undefined && Number(input.insuranceSalaryBaseVnd) > 0
        ? Math.round(Number(input.insuranceSalaryBaseVnd))
        : 46_800_000
    )
  );

  const bhxh = Math.round(insBase * 0.08);
  const bhyt = Math.round(insBase * 0.015);
  const bhtn = Math.round(insBase * 0.01);
  const totalInsurance = bhxh + bhyt + bhtn;

  const personalDeduction = Math.round(Number(input.personalDeductionVnd || 11_000_000));
  const dependentDeduction = Math.round(Number(input.dependentDeductionVnd || 4_400_000)) * dependents;

  const incomeBeforeTax = Math.max(0, gross - totalInsurance);
  const taxableIncome = Math.max(0, incomeBeforeTax - personalDeduction - dependentDeduction);

  const brackets = [
    { limit: 5_000_000, rate: 0.05 },
    { limit: 10_000_000, rate: 0.10 },
    { limit: 18_000_000, rate: 0.15 },
    { limit: 32_000_000, rate: 0.20 },
    { limit: 52_000_000, rate: 0.25 },
    { limit: 80_000_000, rate: 0.30 },
    { limit: Number.POSITIVE_INFINITY, rate: 0.35 },
  ];

  let remaining = taxableIncome;
  let prevCap = 0;
  let pitAmount = 0;
  const bracketBreakdown: Array<{ bracket: number; rate_pct: number; taxed_amount_vnd: number; tax_vnd: number }> = [];

  brackets.forEach((b, idx) => {
    if (remaining <= 0) return;
    const width = b.limit === Number.POSITIVE_INFINITY ? remaining : b.limit - prevCap;
    const chunk = Math.min(remaining, width);
    const tax = Math.round(chunk * b.rate);
    pitAmount += tax;
    bracketBreakdown.push({
      bracket: idx + 1,
      rate_pct: Math.round(b.rate * 100),
      taxed_amount_vnd: chunk,
      tax_vnd: tax,
    });
    remaining -= chunk;
    prevCap = b.limit;
  });

  const netSalary = Math.max(0, gross - totalInsurance - pitAmount);

  return {
    gross_salary_vnd: gross,
    dependents_count: dependents,
    insurance_breakdown: {
      bhxh_8pct_vnd: bhxh,
      bhyt_1_5pct_vnd: bhyt,
      bhtn_1pct_vnd: bhtn,
      total_employee_insurance_vnd: totalInsurance,
    },
    deductions: {
      personal_deduction_vnd: personalDeduction,
      dependent_deduction_vnd: dependentDeduction,
    },
    taxable_income_vnd: taxableIncome,
    pit_tax_vnd: pitAmount,
    net_salary_vnd: netSalary,
    bracket_breakdown: bracketBreakdown,
  };
}

export function evaluateMarketingCopySpamRisk(subject: string, bodyText: string): Record<string, unknown> {
  const subj = String(subject || '').trim();
  const body = String(bodyText || '').trim();
  const combined = `${subj} ${body}`.toLowerCase();

  const spamPatterns = [
    { token: 'miễn phí 100%', penalty: 18, reason: 'Cụm từ "miễn phí 100%" dễ kích hoạt bộ lọc Quảng cáo/Spam' },
    { token: 'kiếm tiền nhanh', penalty: 25, reason: 'Cụm từ tài chính rủi ro cao' },
    { token: 'trúng thưởng', penalty: 22, reason: 'Từ khóa trúng thưởng dễ bị chặn bởi Gmail/Outlook' },
    { token: 'click ngay kẻo lỡ', penalty: 14, reason: 'Ngôn từ thúc ép quá mức' },
    { token: 'khẩn cấp!!!', penalty: 16, reason: 'Lạm dụng dấu chấm than và từ khẩn cấp' },
    { token: '100% free', penalty: 18, reason: 'Cụm từ tiếng Anh rủi ro Spam cao' },
    { token: 'act now', penalty: 12, reason: 'Cụm từ CTA rủi ro cao' },
  ];

  const warnings: string[] = [];
  let riskScore = 8;

  for (const pat of spamPatterns) {
    if (combined.includes(pat.token)) {
      riskScore += pat.penalty;
      warnings.push(pat.reason);
    }
  }

  const exclamations = (subj.match(/!/g) || []).length + (body.match(/!{2,}/g) || []).length * 2;
  if (exclamations >= 3) {
    riskScore += 15;
    warnings.push('Tiêu đề/nội dung chứa quá nhiều dấu chấm than (!).');
  }

  const letters = subj.replace(/[^a-zA-ZÀ-ỹ]/g, '');
  const upperLetters = letters.replace(/[^A-ZÀÁẢÃẠĂẮẰẲẴẶÂẤẦẨẪẬĐÈÉẺẼẸÊẾỀỂỄỆÌÍỈĨỊÒÓỎÕỌÔỐỒỔỖỘƠỚỜỞỠỢÙÚỦŨỤƯỨỪỬỮỰỲÝỶỸỴ]/g, '');
  if (letters.length >= 8 && upperLetters.length / letters.length > 0.65) {
    riskScore += 20;
    warnings.push('Tiêu đề viết IN HOA quá 65% chiều dài.');
  }

  const linkCount = (body.match(/https?:\/\//gi) || []).length;
  if (linkCount > 6) {
    riskScore += 14;
    warnings.push(`Nội dung chứa ${linkCount} liên kết ngoài (khuyến nghị <= 4 liên kết).`);
  }

  if (!combined.includes('unsubscribe') && !combined.includes('hủy đăng ký') && !combined.includes('ngừng nhận')) {
    riskScore += 10;
    warnings.push('Nên bổ sung liên kết Hủy đăng ký (Unsubscribe) ở chân trang để tuân thủ chuẩn AWS SES.');
  }

  const clampedRisk = Math.min(100, riskScore);
  const deliverabilityScore = Math.max(0, 100 - clampedRisk);
  const verdict =
    clampedRisk <= 25 ? 'safe_high_inbox' : clampedRisk <= 55 ? 'moderate_review_recommended' : 'high_spam_risk';

  return {
    subject_length: subj.length,
    link_count: linkCount,
    spam_risk_score: clampedRisk,
    deliverability_score: deliverabilityScore,
    verdict,
    warnings,
    recommendations:
      warnings.length === 0
        ? ['Nội dung đạt chuẩn Inbox cao, sẵn sàng phát hành qua AWS SES / SMTP.']
        : warnings,
  };
}
