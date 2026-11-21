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

function escapeMailHtml(raw: unknown): string {
  return String(raw ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export const DEFAULT_GOOGLE_ADS_MCC_ADMIN_EMAIL = 'domation.net@gmail.com';
export const DEFAULT_GOOGLE_ADS_MCC_CC_EMAIL = 'turniodev@gmail.com';

export interface GoogleAdsMccLinkRequestMailInput {
  tenant_id: string;
  tenant_name: string;
  tenant_slug: string;
  requester_name: string;
  requester_email: string;
  requester_phone?: string;
  mcc_id: string;
  customer_ids: Array<{ customer_id: string; label?: string }>;
  note?: string;
}

export async function notifyGoogleAdsMccLinkRequest(
  input: GoogleAdsMccLinkRequestMailInput
): Promise<PlatformAppscriptDispatchResult> {
  const toEmail =
    (process.env.DOMATION_GOOGLE_ADS_MCC_ADMIN_EMAIL || '').trim() ||
    DEFAULT_GOOGLE_ADS_MCC_ADMIN_EMAIL;
  const ccEmail =
    (process.env.DOMATION_GOOGLE_ADS_MCC_CC_EMAIL || '').trim() ||
    DEFAULT_GOOGLE_ADS_MCC_CC_EMAIL;

  const idListStr = input.customer_ids.map((x) => x.customer_id).join(', ');
  const subject = `[DOMATION Google Ads MCC] Yêu cầu mời liên kết MCC (${input.tenant_name}) — ${idListStr}`;
  const portalLink = input.tenant_slug
    ? `https://meta.domation.net/${encodeURIComponent(input.tenant_slug)}`
    : 'https://meta.domation.net/';

  const rowsHtml = input.customer_ids
    .map(
      (item, idx) =>
        `<tr>
          <td style="padding:8px 12px;border-bottom:1px solid #e2e8f0;font-size:13px;color:#475569;">${idx + 1}</td>
          <td style="padding:8px 12px;border-bottom:1px solid #e2e8f0;font-size:13px;font-family:monospace;font-weight:700;color:#1E40FF;">${escapeMailHtml(item.customer_id)}</td>
          <td style="padding:8px 12px;border-bottom:1px solid #e2e8f0;font-size:13px;color:#0f172a;">${escapeMailHtml(item.label || 'Chưa đặt tên gợi nhớ')}</td>
        </tr>`
    )
    .join('');

  const htmlBody = `
    <div style="font-family:Inter,Arial,sans-serif;max-width:640px;margin:0 auto;background:#ffffff;border:1px solid #e2e8f0;border-radius:16px;overflow:hidden;">
      <div style="background:linear-gradient(135deg,#1E40FF,#0284C7);padding:20px 24px;color:#ffffff;">
        <div style="font-size:11px;font-weight:700;letter-spacing:0.08em;text-transform:uppercase;opacity:0.9;">DOMATION GOOGLE ADS MCC HUB</div>
        <h2 style="margin:6px 0 0;font-size:18px;font-weight:700;">Yêu cầu gửi lời mời liên kết vào MCC ${escapeMailHtml(input.mcc_id)}</h2>
      </div>
      <div style="padding:20px 24px;color:#334155;font-size:14px;line-height:1.6;">
        <p style="margin:0 0 12px;">Khách hàng vừa gửi danh sách <strong>Google Ads Customer ID</strong> để kích hoạt chế độ Thiết lập nhanh trên DOMATION Meta Report:</p>
        <div style="background:#f8fafc;border:1px solid #e2e8f0;border-radius:12px;padding:12px 16px;margin-bottom:16px;font-size:13px;">
          <div><strong>Workspace:</strong> ${escapeMailHtml(input.tenant_name)} (<a href="${portalLink}" style="color:#1E40FF;">${escapeMailHtml(portalLink)}</a>)</div>
          <div><strong>Người gửi:</strong> ${escapeMailHtml(input.requester_name)} (${escapeMailHtml(input.requester_email)}${input.requester_phone ? ` · ${escapeMailHtml(input.requester_phone)}` : ''})</div>
          ${input.note ? `<div style="margin-top:6px;"><strong>Ghi chú:</strong> ${escapeMailHtml(input.note)}</div>` : ''}
        </div>
        <table style="width:100%;border-collapse:collapse;border:1px solid #e2e8f0;border-radius:10px;overflow:hidden;margin-bottom:16px;">
          <thead>
            <tr style="background:#f1f5f9;">
              <th style="padding:8px 12px;text-align:left;font-size:11px;color:#64748b;">#</th>
              <th style="padding:8px 12px;text-align:left;font-size:11px;color:#64748b;">Google Ads Customer ID</th>
              <th style="padding:8px 12px;text-align:left;font-size:11px;color:#64748b;">Tên gợi nhớ</th>
            </tr>
          </thead>
          <tbody>${rowsHtml}</tbody>
        </table>
        <div style="background:#eff6ff;border:1px solid #bfdbfe;border-radius:12px;padding:12px 16px;font-size:13px;color:#1e3a8a;">
          <strong>Thao tác nhanh cho Quản trị MCC (${escapeMailHtml(input.mcc_id)}):</strong><br/>
          1. Vào Google Ads MCC → <strong>Tài khoản → Hiệu suất → dấu (+) → Liên kết tài khoản hiện có</strong>.<br/>
          2. Dán các mã ID trên và bấm <strong>Gửi yêu cầu</strong>.<br/>
          3. Sau khi khách bấm <strong>Chấp nhận (Accept)</strong> trong Google Ads, khách chỉ cần quay lại DOMATION nhập mã OTP 6 số gửi về email chủ tài khoản Google Ads để mở báo cáo ngay lập tức.
        </div>
      </div>
    </div>
  `.trim();

  const textLines = [
    `[DOMATION Google Ads MCC] Yêu cầu mời liên kết MCC ${input.mcc_id}`,
    `Workspace: ${input.tenant_name} (${portalLink})`,
    `Người yêu cầu: ${input.requester_name} <${input.requester_email}>${input.requester_phone ? ' - ' + input.requester_phone : ''}`,
    `Danh sách Google Ads Customer ID:`,
    ...input.customer_ids.map((x, i) => `  ${i + 1}. ${x.customer_id}${x.label ? ` (${x.label})` : ''}`),
    ...(input.note ? [`Ghi chú: ${input.note}`] : []),
  ];

  return dispatchPlatformAppscriptEvent({
    event_type: 'google_ads_mcc_link_request',
    category: 'google_ads_mcc',
    to: toEmail,
    cc: ccEmail,
    reply_to: input.requester_email || toEmail,
    from_name: 'DOMATION Google Ads MCC Hub',
    subject,
    text: textLines.join('\n'),
    htmlBody,
    tenant_id: input.tenant_id,
    tenant_slug: input.tenant_slug,
    tenant_name: input.tenant_name,
    customer_ids: input.customer_ids,
  });
}

export interface GoogleAdsMccOtpMailInput {
  tenant_id: string;
  tenant_name: string;
  tenant_slug: string;
  requester_name: string;
  requester_email: string;
  customer_id: string;
  google_account_name: string;
  otp_code: string;
  expires_minutes: number;
  to_emails: string[];
  cc_email?: string;
  is_mcc_fallback: boolean;
}

export async function sendGoogleAdsMccOtpEmail(
  input: GoogleAdsMccOtpMailInput
): Promise<PlatformAppscriptDispatchResult> {
  const recipients = input.to_emails
    .map((e) => String(e || '').trim().toLowerCase())
    .filter((e) => e.includes('@'));
  const toHeader = recipients.join(', ') || DEFAULT_GOOGLE_ADS_MCC_ADMIN_EMAIL;
  const ccHeader = input.is_mcc_fallback
    ? input.cc_email ||
      (process.env.DOMATION_GOOGLE_ADS_MCC_CC_EMAIL || '').trim() ||
      DEFAULT_GOOGLE_ADS_MCC_CC_EMAIL
    : input.cc_email || '';

  const subject = input.is_mcc_fallback
    ? `[DOMATION MCC OTP] Mã xác thực ${input.otp_code} cho Google Ads ${input.customer_id} — ${input.tenant_name}`
    : `[DOMATION] Mã xác nhận ${input.otp_code} liên kết tài khoản Google Ads ${input.customer_id}`;

  const portalLink = input.tenant_slug
    ? `https://meta.domation.net/${encodeURIComponent(input.tenant_slug)}`
    : 'https://meta.domation.net/';

  const fallbackBanner = input.is_mcc_fallback
    ? `<div style="background:#fffbeb;border:1px solid #fcd34d;border-radius:12px;padding:12px 16px;margin-bottom:16px;font-size:13px;color:#92400e;">
        <strong>Lưu ý dành cho Quản trị MCC:</strong> Google Ads API chưa cho phép đọc danh sách email ADMIN trực tiếp từ tài khoản con <code>${escapeMailHtml(input.customer_id)}</code> (hoặc tài khoản con không có user ADMIN riêng ngoài MCC). Vui lòng xác minh đúng chủ sở hữu Workspace <strong>${escapeMailHtml(input.tenant_name)}</strong> (${escapeMailHtml(input.requester_email)}) trước khi cung cấp mã OTP bên dưới.
      </div>`
    : '';

  const htmlBody = `
    <div style="font-family:Inter,Arial,sans-serif;max-width:600px;margin:0 auto;background:#ffffff;border:1px solid #e2e8f0;border-radius:16px;overflow:hidden;">
      <div style="background:linear-gradient(135deg,#1E40FF,#06B6D4);padding:20px 24px;color:#ffffff;">
        <div style="font-size:11px;font-weight:700;letter-spacing:0.08em;text-transform:uppercase;opacity:0.9;">XÁC THỰC QUYỀN SỞ HỮU GOOGLE ADS</div>
        <h2 style="margin:6px 0 0;font-size:18px;font-weight:700;">Mã xác nhận liên kết tài khoản ${escapeMailHtml(input.customer_id)}</h2>
      </div>
      <div style="padding:24px;color:#334155;font-size:14px;line-height:1.6;">
        ${fallbackBanner}
        <p style="margin:0 0 12px;">
          Workspace <strong>${escapeMailHtml(input.tenant_name)}</strong> (người thao tác: <strong>${escapeMailHtml(input.requester_name)}</strong> · ${escapeMailHtml(input.requester_email)}) đang yêu cầu gắn tài khoản Google Ads sau vào báo cáo DOMATION:
        </p>
        <div style="background:#f8fafc;border:1px solid #e2e8f0;border-radius:12px;padding:12px 16px;margin-bottom:18px;font-size:13px;">
          <div><strong>Google Ads ID:</strong> <span style="font-family:monospace;font-weight:700;color:#1E40FF;">${escapeMailHtml(input.customer_id)}</span></div>
          <div><strong>Tên tài khoản Google Ads:</strong> ${escapeMailHtml(input.google_account_name)}</div>
          <div><strong>Đường dẫn Workspace:</strong> <a href="${portalLink}" style="color:#1E40FF;">${escapeMailHtml(portalLink)}</a></div>
        </div>
        <div style="text-align:center;background:#eff6ff;border:2px dashed #93c5fd;border-radius:14px;padding:18px;margin-bottom:18px;">
          <div style="font-size:11px;font-weight:700;color:#1e40af;letter-spacing:0.08em;text-transform:uppercase;">MÃ XÁC NHẬN OTP (HẾT HẠN SAU ${input.expires_minutes} PHÚT)</div>
          <div style="font-size:34px;font-weight:800;letter-spacing:0.25em;font-family:monospace;color:#1E40FF;margin-top:6px;">${escapeMailHtml(input.otp_code)}</div>
        </div>
        <p style="margin:0;font-size:12px;color:#64748b;">
          Vì lý do bảo mật, tuyệt đối không chia sẻ mã này cho người không có quyền xem dữ liệu quảng cáo của tài khoản ${escapeMailHtml(input.customer_id)}. Nếu bạn không thực hiện yêu cầu này, hãy bỏ qua email này.
        </p>
      </div>
    </div>
  `.trim();

  const text = [
    `Mã xác nhận OTP DOMATION Google Ads: ${input.otp_code} (hết hạn sau ${input.expires_minutes} phút)`,
    `Tài khoản Google Ads: ${input.customer_id} (${input.google_account_name})`,
    `Workspace yêu cầu: ${input.tenant_name} (${portalLink})`,
    `Người yêu cầu: ${input.requester_name} <${input.requester_email}>`,
    input.is_mcc_fallback
      ? 'Lưu ý: Gửi tới quản trị MCC do API không đọc được email ADMIN trực tiếp từ tài khoản con.'
      : 'Nếu bạn không yêu cầu gắn tài khoản này vào DOMATION, vui lòng bỏ qua email này.',
  ].join('\n');

  return dispatchPlatformAppscriptEvent({
    event_type: 'google_ads_mcc_otp',
    category: 'google_ads_otp',
    to: toHeader,
    ...(ccHeader ? { cc: ccHeader } : {}),
    from_name: 'DOMATION Security & Ads Hub',
    subject,
    text,
    htmlBody,
    tenant_id: input.tenant_id,
    tenant_slug: input.tenant_slug,
    tenant_name: input.tenant_name,
    customer_id: input.customer_id,
  });
}
