import { withSystemPrivilege } from '../core/database/transaction.ts';
import type { DbClient } from '../core/database/db-adapter.ts';
import { getPlatformBillingCatalog } from './billing.service.ts';

export const DEFAULT_DOMATION_SPREADSHEET_ID = '1FiCtjay20ZhIg4t4DHs3ONucrmjg4Ah5MBeofjxvV-A';
const MASTER_CONFIG_KEY = 'master_appscript_config';

export interface MasterAppscriptConfig {
  enabled: boolean;
  webhook_url: string;
  secret: string;
  spreadsheet_id: string;
  admin_notify_email: string;
  send_customer_emails: boolean;
  send_admin_emails: boolean;
}

export interface PlatformAppscriptDispatchResult {
  dispatched: boolean;
  success: boolean;
  skippedReason?: string;
  httpStatus?: number;
  response?: Record<string, unknown>;
  error?: string;
}

export type PlatformAppscriptFetcher = (
  url: string,
  payload: Record<string, unknown>
) => Promise<{ ok: boolean; status: number; json?: Record<string, unknown>; rawText?: string }>;

let customMasterFetcher: PlatformAppscriptFetcher | null = null;
let cachedMasterConfig: { value: MasterAppscriptConfig; expiresAt: number } | null = null;

export function setPlatformAppscriptFetcher(fetcher: PlatformAppscriptFetcher | null): void {
  customMasterFetcher = fetcher;
}

export function invalidatePlatformAppscriptCache(): void {
  cachedMasterConfig = null;
}

export function isValidAppscriptWebhookUrl(url: string): boolean {
  return /^https:\/\/script\.google\.com\/macros\/s\/[A-Za-z0-9_-]+\/(exec|dev)(\?.*)?$/i.test(
    String(url || '').trim()
  );
}

function getEnvMasterDefaults(): MasterAppscriptConfig {
  return {
    enabled: process.env.DOMATION_MASTER_APPSCRIPT_ENABLED !== 'false',
    webhook_url: (process.env.DOMATION_MASTER_APPSCRIPT_URL || '').trim(),
    secret: (process.env.DOMATION_MASTER_APPSCRIPT_SECRET || '').trim(),
    spreadsheet_id:
      (process.env.DOMATION_MASTER_SPREADSHEET_ID || '').trim() || DEFAULT_DOMATION_SPREADSHEET_ID,
    admin_notify_email: (process.env.DOMATION_MASTER_ADMIN_EMAIL || 'domation.net@gmail.com').trim(),
    send_customer_emails: process.env.DOMATION_MASTER_SEND_CUSTOMER_EMAILS !== 'false',
    send_admin_emails: process.env.DOMATION_MASTER_SEND_ADMIN_EMAILS !== 'false',
  };
}

export function normalizeMasterAppscriptConfig(
  raw: Record<string, unknown> | null | undefined,
  envDefaults = getEnvMasterDefaults()
): MasterAppscriptConfig {
  const obj = raw && typeof raw === 'object' ? raw : {};
  const dbUrl = typeof obj.webhook_url === 'string' ? obj.webhook_url.trim() : '';
  const dbSecret = typeof obj.secret === 'string' ? obj.secret.trim() : '';
  const dbSheetId = typeof obj.spreadsheet_id === 'string' ? obj.spreadsheet_id.trim() : '';
  const dbAdminEmail = typeof obj.admin_notify_email === 'string' ? obj.admin_notify_email.trim() : '';

  return {
    enabled: obj.enabled !== undefined ? Boolean(obj.enabled) : envDefaults.enabled,
    webhook_url: dbUrl || envDefaults.webhook_url,
    secret: dbSecret || envDefaults.secret,
    spreadsheet_id: dbSheetId || envDefaults.spreadsheet_id,
    admin_notify_email: dbAdminEmail || envDefaults.admin_notify_email,
    send_customer_emails:
      obj.send_customer_emails !== undefined
        ? Boolean(obj.send_customer_emails)
        : envDefaults.send_customer_emails,
    send_admin_emails:
      obj.send_admin_emails !== undefined ? Boolean(obj.send_admin_emails) : envDefaults.send_admin_emails,
  };
}

export async function getMasterAppscriptConfig(client?: DbClient): Promise<MasterAppscriptConfig> {
  if (!client && cachedMasterConfig && cachedMasterConfig.expiresAt > Date.now()) {
    return cachedMasterConfig.value;
  }

  const readRow = async (c: DbClient) => {
    const res = await c.query<{ setting_value: Record<string, unknown> }>(
      `SELECT setting_value FROM platform_settings WHERE setting_key = $1 LIMIT 1`,
      [MASTER_CONFIG_KEY]
    );
    return res.rows[0]?.setting_value || null;
  };

  let rawVal: Record<string, unknown> | null = null;
  try {
    rawVal = client ? await readRow(client) : await withSystemPrivilege(readRow);
  } catch {
    rawVal = null;
  }

  const normalized = normalizeMasterAppscriptConfig(rawVal);
  if (!client) {
    cachedMasterConfig = { value: normalized, expiresAt: Date.now() + 30_000 };
  }
  return normalized;
}

export async function saveMasterAppscriptConfig(
  patch: Partial<MasterAppscriptConfig>
): Promise<MasterAppscriptConfig> {
  const existing = await getMasterAppscriptConfig();
  const nextRaw: Record<string, unknown> = {
    enabled: patch.enabled !== undefined ? Boolean(patch.enabled) : existing.enabled,
    webhook_url:
      patch.webhook_url !== undefined ? String(patch.webhook_url || '').trim() : existing.webhook_url,
    secret: patch.secret !== undefined ? String(patch.secret || '').trim() : existing.secret,
    spreadsheet_id:
      patch.spreadsheet_id !== undefined && String(patch.spreadsheet_id).trim()
        ? String(patch.spreadsheet_id).trim()
        : existing.spreadsheet_id,
    admin_notify_email:
      patch.admin_notify_email !== undefined
        ? String(patch.admin_notify_email || '').trim()
        : existing.admin_notify_email,
    send_customer_emails:
      patch.send_customer_emails !== undefined
        ? Boolean(patch.send_customer_emails)
        : existing.send_customer_emails,
    send_admin_emails:
      patch.send_admin_emails !== undefined
        ? Boolean(patch.send_admin_emails)
        : existing.send_admin_emails,
  };

  const jsonPayload = JSON.stringify(nextRaw);
  await withSystemPrivilege(async (client) => {
    await client.query(
      `INSERT INTO platform_settings (setting_key, setting_value, updated_at)
       VALUES ($1, $2::jsonb, clock_timestamp())
       ON CONFLICT (setting_key)
       DO UPDATE SET setting_value = EXCLUDED.setting_value, updated_at = clock_timestamp()`,
      [MASTER_CONFIG_KEY, jsonPayload]
    );
  });

  invalidatePlatformAppscriptCache();
  return normalizeMasterAppscriptConfig(nextRaw);
}

function isMasterAppscriptSilentBlocked(): boolean {
  if (customMasterFetcher) return false;
  return (
    process.env.OUTBOUND_SILENT_MODE === 'true' ||
    process.env.NODE_ENV === 'test' ||
    process.env.VITEST === 'true'
  );
}

export async function dispatchPlatformAppscriptEvent(
  payload: Record<string, unknown>,
  options?: { overrideWebhookUrl?: string; overrideSecret?: string; timeoutMs?: number }
): Promise<PlatformAppscriptDispatchResult> {
  const cfg = await getMasterAppscriptConfig();
  const targetUrl = (options?.overrideWebhookUrl || cfg.webhook_url || '').trim();
  const targetSecret = (options?.overrideSecret ?? cfg.secret ?? '').trim();

  if (!cfg.enabled && !options?.overrideWebhookUrl) {
    return { dispatched: false, success: false, skippedReason: 'disabled' };
  }
  if (!targetUrl) {
    return { dispatched: false, success: false, skippedReason: 'missing_webhook_url' };
  }
  if (isMasterAppscriptSilentBlocked()) {
    return { dispatched: false, success: true, skippedReason: 'silent_guard' };
  }

  const enrichedPayload: Record<string, unknown> = {
    ...payload,
    spreadsheet_id: cfg.spreadsheet_id,
    ...(targetSecret ? { secret: targetSecret } : {}),
  };

  if (customMasterFetcher) {
    try {
      const out = await customMasterFetcher(targetUrl, enrichedPayload);
      const okFlag = out.ok && out.json?.success !== false;
      return {
        dispatched: true,
        success: okFlag,
        httpStatus: out.status,
        response: out.json,
        error: okFlag ? undefined : String(out.json?.error || `HTTP ${out.status}`),
      };
    } catch (err: any) {
      return {
        dispatched: true,
        success: false,
        error: err?.message || 'Custom Apps Script fetcher error',
      };
    }
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options?.timeoutMs || 12_000);

  try {
    const resp = await fetch(targetUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify(enrichedPayload),
      redirect: 'follow',
      signal: controller.signal,
    });
    const rawText = await resp.text();
    let parsed: Record<string, unknown> | undefined;
    try {
      parsed = JSON.parse(rawText);
    } catch {
      parsed = undefined;
    }

    if (!parsed) {
      const permissionHint =
        rawText.includes('ServiceLogin') || rawText.includes('accounts.google.com')
          ? 'Google Apps Script chưa chọn "Anyone (Bất kỳ ai)" khi Deploy Web App.'
          : `Google Apps Script trả về HTML/Text không phải JSON (HTTP ${resp.status}).`;
      return {
        dispatched: true,
        success: false,
        httpStatus: resp.status,
        error: permissionHint,
      };
    }

    const ok = resp.ok && parsed.success !== false;
    return {
      dispatched: true,
      success: ok,
      httpStatus: resp.status,
      response: parsed,
      error: ok ? undefined : String(parsed.error || `HTTP ${resp.status}`),
    };
  } catch (err: any) {
    return {
      dispatched: true,
      success: false,
      error: err?.name === 'AbortError' ? 'Hết thời gian chờ Google Apps Script (12s)' : err?.message || 'Lỗi gọi Apps Script',
    };
  } finally {
    clearTimeout(timer);
  }
}

export async function fetchTenantPrimaryAdminContact(
  client: DbClient,
  tenantId: string
): Promise<{
  tenantName: string;
  tenantSlug: string;
  adminName: string;
  adminEmail: string;
  adminPhone: string;
}> {
  const res = await client.query<{
    tenant_name: string;
    tenant_slug: string;
    admin_name: string | null;
    admin_email: string | null;
    admin_phone: string | null;
  }>(
    `SELECT t.name AS tenant_name, t.slug AS tenant_slug,
            u.full_name AS admin_name, u.email AS admin_email, u.phone AS admin_phone
     FROM tenants t
     LEFT JOIN users u ON u.tenant_id = t.id AND u.role = 'tenant_admin'
     WHERE t.id = $1
     ORDER BY u.created_at ASC
     LIMIT 1`,
    [tenantId]
  );
  const row = res.rows[0];
  return {
    tenantName: row?.tenant_name || 'DOMATION Workspace',
    tenantSlug: row?.tenant_slug || '',
    adminName: row?.admin_name || 'Quản trị viên',
    adminEmail: row?.admin_email || '',
    adminPhone: row?.admin_phone || '',
  };
}

export interface ConsultationNotifyInput {
  lead_code: string;
  name: string;
  email: string;
  phone: string;
  company: string;
  service: string;
  budget_or_scale?: string;
  addons_summary?: string;
  total_price_vnd?: number;
  message: string;
  source_form: string;
  page_path?: string;
  page_url?: string;
  utm_source?: string;
  utm_medium?: string;
  utm_campaign?: string;
  metadata?: Record<string, unknown>;
}

export async function notifyPlatformConsultation(
  input: ConsultationNotifyInput
): Promise<PlatformAppscriptDispatchResult> {
  return dispatchPlatformAppscriptEvent({
    event_type: 'consultation',
    ...input,
  });
}

export interface WorkspaceRegisteredNotifyInput {
  tenant_id: string;
  tenant_slug: string;
  tenant_name: string;
  industry: string;
  admin_name: string;
  email: string;
  phone?: string | null;
  plan_code?: string;
  trial_days?: number;
  trial_ends_at?: string | null;
  auth_provider?: 'password' | 'google' | string;
}

export async function notifyPlatformWorkspaceRegistered(
  input: WorkspaceRegisteredNotifyInput
): Promise<PlatformAppscriptDispatchResult> {
  return dispatchPlatformAppscriptEvent({
    event_type: 'workspace_registered',
    ...input,
  });
}

export type PlatformBillingEventType =
  | 'topup_requested'
  | 'topup_approved'
  | 'topup_rejected'
  | 'subscription_requested'
  | 'subscription_activated'
  | 'subscription_renewed'
  | 'auto_renewal_success'
  | 'plan_upgraded'
  | 'admin_grant'
  | 'crm_erp_upgrade_requested'
  | 'crm_erp_upgrade_approved'
  | 'expiry_warning'
  | 'subscription_expired_suspended';

export interface PlatformBillingNotifyInput {
  event_type: PlatformBillingEventType;
  reference_code: string;
  status?: string;
  tenant_id?: string;
  tenant_slug: string;
  tenant_name: string;
  admin_name?: string;
  email: string;
  phone?: string | null;
  plan_code?: string | null;
  plan_name?: string | null;
  target_suite_label?: string | null;
  billing_cycle?: string | null;
  months_added?: number;
  added_days?: number;
  days_remaining?: number;
  amount_vnd?: number;
  bonus_vnd?: number;
  discount_pct?: number;
  wallet_balance_vnd?: number;
  required_amount_vnd?: number;
  shortfall_vnd?: number;
  payment_method?: string;
  effective_expires_at?: string | null;
  processed_by?: string | null;
  note?: string | null;
}

export async function notifyPlatformBillingEvent(
  input: PlatformBillingNotifyInput
): Promise<PlatformAppscriptDispatchResult> {
  let catalogBankInfo: Record<string, unknown> | undefined;
  let resolvedPlanName = input.plan_name || undefined;
  try {
    const catalog = await getPlatformBillingCatalog();
    catalogBankInfo = catalog.payment_bank_info as unknown as Record<string, unknown>;
    if (!resolvedPlanName && input.plan_code) {
      const matched = catalog.plans.find((p) => p.code === input.plan_code);
      if (matched) resolvedPlanName = matched.name;
    }
  } catch {
    // Non-blocking catalog lookup
  }

  return dispatchPlatformAppscriptEvent({
    ...input,
    plan_name: resolvedPlanName || input.plan_code || '',
    bank_info: catalogBankInfo,
  });
}
