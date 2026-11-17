import crypto from 'node:crypto';
import type { DbClient } from '../core/database/db-adapter.ts';
import { withTenantTransaction, withSystemPrivilege } from '../core/database/transaction.ts';
import { encryptTenantSecret, decryptTenantSecret } from '../core/crypto/vault.ts';
import { tenantRedis } from '../core/cache/tenant-redis.ts';
import {
  normalizeTenantSettings,
  renderTemplateString,
  resolveTenantBrandName,
} from '../core/settings/tenant-settings.ts';
import { getTenantIntegrationCached, getTenantSettingsCached } from '../core/settings/tenant-cache.ts';
import { dispatchOutboundWebhookEvent } from './webhook.service.ts';

export interface ZaloIntegrationConfig {
  app_id?: string;
  oa_id?: string;
  oa_secret?: string;
  bot_token?: string;
  access_token?: string;
  refresh_token?: string;
  group_chat_id?: string;
  template?: string;
  rate_limit_per_sec?: number;
  accept_command?: string;
  report_command?: string;
  approve_command?: string;
  reject_command?: string;
  accept_reply_template?: string;
  report_reply_template?: string;
  approve_reply_template?: string;
  reject_reply_template?: string;
}

export interface SmtpIntegrationConfig {
  host?: string;
  smtp_host?: string;
  port?: number;
  smtp_port?: number;
  user?: string;
  smtp_user?: string;
  pass?: string;
  smtp_pass?: string;
  notify_email?: string;
  from_name?: string;
}

export type EmailCategory =
  | 'system'
  | 'smtp_test'
  | 'assignment'
  | 'sla_alert'
  | 'sla_warning'
  | 'zalo_sale'
  | 'zalo_admin'
  | 'ticket_admin'
  | 'ticket_sale_success'
  | 'ticket_sale_fail'
  | 'admin_confirm'
  | 'daily_report'
  | 'system_alert';

export interface EmailDispatchMessage {
  tenantId: string;
  client?: DbClient;
  to?: string;
  cc?: string;
  subject: string;
  text: string;
  html?: string;
  category?: EmailCategory;
  meta?: Record<string, unknown>;
  overrideProvider?: 'appscript' | 'ses' | 'smtp';
  overrideWebhookUrl?: string;
  overrideSecret?: string;
}

export interface EmailDispatchResult {
  sent: boolean;
  messageId: string;
  recipient: string;
  smtpHost: string;
  provider: 'appscript' | 'smtp' | 'ses' | 'silent_guard';
  category: string;
  remainingQuota?: number | null;
  sheetLogged?: boolean;
  error?: string;
}

type SmtpTransportFn = (
  cfg: SmtpIntegrationConfig,
  msg: { to: string; subject: string; text: string }
) => Promise<{ accepted: boolean; messageId: string }>;

type EmailWebhookFetcherFn = (
  url: string,
  init: { method: string; headers: Record<string, string>; body: string }
) => Promise<{ ok: boolean; status: number; text: () => Promise<string>; headers?: { get(k: string): string | null } }>;

let customSmtpTransport: SmtpTransportFn | null = null;
let customEmailWebhookFetcher: EmailWebhookFetcherFn | null = null;

export function setSmtpTransportForTesting(fn: SmtpTransportFn | null): void {
  customSmtpTransport = fn;
}

export function setEmailWebhookFetcherForTesting(fn: EmailWebhookFetcherFn | null): void {
  customEmailWebhookFetcher = fn;
}

function escapeHtml(val: unknown): string {
  return String(val ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export function renderEmailHtmlEnvelope(params: {
  title: string;
  badge: string;
  accentColor?: string;
  summaryText: string;
  rows?: Array<{ label: string; value: string }>;
  ctaLabel?: string;
  ctaUrl?: string;
  tenantName?: string;
  footerText?: string;
}): string {
  const accent = params.accentColor || '#1E40FF';
  const rowsHtml = (params.rows || [])
    .filter((r) => r.value !== '')
    .map(
      (r) =>
        `<tr><td style="padding:8px 12px;border-bottom:1px solid #e2e8f0;color:#64748b;font-size:13px;width:36%;font-weight:600">${escapeHtml(r.label)}</td><td style="padding:8px 12px;border-bottom:1px solid #e2e8f0;color:#0f172a;font-size:13px;font-weight:600">${escapeHtml(r.value)}</td></tr>`
    )
    .join('');

  const ctaHtml =
    params.ctaUrl && params.ctaLabel
      ? `<div style="margin-top:20px;text-align:center"><a href="${escapeHtml(params.ctaUrl)}" style="display:inline-block;padding:11px 22px;background:${accent};color:#ffffff;text-decoration:none;border-radius:10px;font-weight:700;font-size:14px">${escapeHtml(params.ctaLabel)}</a></div>`
      : '';

  return `<!DOCTYPE html><html><body style="margin:0;padding:24px;background:#f1f5f9;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;color:#0f172a">
<div style="max-width:600px;margin:0 auto;background:#ffffff;border:1px solid #e2e8f0;border-radius:16px;overflow:hidden;box-shadow:0 4px 16px rgba(15,23,42,0.06)">
  <div style="padding:20px 24px;background:linear-gradient(135deg,${accent} 0%,#0f172a 100%);color:#ffffff">
    <div style="display:inline-block;padding:3px 10px;border-radius:999px;background:rgba(255,255,255,0.18);font-size:11px;font-weight:700;letter-spacing:0.04em;text-transform:uppercase">${escapeHtml(params.badge)}</div>
    <h2 style="margin:10px 0 0;font-size:18px;line-height:1.35;font-weight:700;color:#ffffff">${escapeHtml(params.title)}</h2>
  </div>
  <div style="padding:22px 24px">
    <p style="margin:0 0 16px;font-size:14px;line-height:1.65;color:#334155;white-space:pre-line">${escapeHtml(params.summaryText)}</p>
    ${rowsHtml ? `<table style="width:100%;border-collapse:collapse;background:#f8fafc;border:1px solid #e2e8f0;border-radius:10px;overflow:hidden">${rowsHtml}</table>` : ''}
    ${ctaHtml}
  </div>
  <div style="padding:14px 24px;background:#f8fafc;border-top:1px solid #e2e8f0;font-size:12px;color:#64748b;display:flex;justify-content:space-between">
    <span>${escapeHtml(params.tenantName || 'DOMATION AutoData')} • ${escapeHtml(params.footerText || 'Hệ thống phân phối Lead tự động')}</span>
  </div>
</div>
</body></html>`;
}

export function buildCategoryTestEmailContent(params: {
  type: string;
  tenantName: string;
  tenantSlug: string;
  frontendUrl: string;
}): { category: EmailCategory; subject: string; text: string; html: string; meta: Record<string, unknown> } {
  const baseUrl = params.frontendUrl.replace(/\/+$/, '') || 'https://domation.net/data';
  const portalUrl = `${baseUrl}/${params.tenantSlug}`;
  const t = String(params.type || 'system').trim().toLowerCase();

  const configs: Record<string, { category: EmailCategory; badge: string; accent: string; title: string; summary: string; cta: string; rows: Array<{ label: string; value: string }> }> = {
    assignment: {
      category: 'assignment',
      badge: 'LEAD MỚI • GIAO DATA',
      accent: '#1E40FF',
      title: 'Khách hàng mới vừa được phân bổ cho bạn',
      summary: 'Hệ thống vừa tiếp nhận và điều phối một khách hàng mới từ Meta Ads. Vui lòng tiếp nhận và liên hệ trong khung thời gian SLA.',
      cta: 'Mở CRM Tiếp nhận Lead',
      rows: [
        { label: 'Khách hàng', value: 'Nguyễn Hoàng Nam (Mẫu Test)' },
        { label: 'Số điện thoại', value: '+84 908 123 456' },
        { label: 'Nguồn Lead', value: 'Meta Lead Ads • Chiến dịch T11' },
        { label: 'Vòng phân bổ', value: 'Vòng Ưu Tiên (Round #1)' },
      ],
    },
    zalo_sale: {
      category: 'zalo_sale',
      badge: 'CHÀO MỪNG SALE',
      accent: '#0284C7',
      title: `Chào mừng gia nhập đội ngũ Sale — ${params.tenantName}`,
      summary: 'Tài khoản Sale & Đại lý của bạn đã được kích hoạt. Hãy liên kết ZaloBot / Telegram bằng lệnh /chatid để nhận Lead tự động trong 3 giây.',
      cta: 'Truy cập Cổng Sale',
      rows: [
        { label: 'Workspace', value: params.tenantName },
        { label: 'Lệnh kết nối Bot', value: '/chatid' },
        { label: 'Lệnh nhận số nhanh', value: '/tiepnhan <mã lead>' },
      ],
    },
    zalo_admin: {
      category: 'zalo_admin',
      badge: 'CHÀO MỪNG QUẢN LÝ',
      accent: '#1E40FF',
      title: `Kích hoạt quyền Quản lý vận hành — ${params.tenantName}`,
      summary: 'Bạn đã được phân quyền Quản lý trên DOMATION AutoData để giám sát vòng chia số, duyệt Ticket lỗi & xem báo cáo công bằng.',
      cta: 'Vào Dashboard Quản trị',
      rows: [
        { label: 'Workspace', value: params.tenantName },
        { label: 'Nhóm cảnh báo SLA', value: 'Đã kết nối Zalo / Telegram / Email' },
      ],
    },
    ticket_admin: {
      category: 'ticket_admin',
      badge: 'TICKET BÁO LỖI MỚI',
      accent: '#F59E0B',
      title: 'Có phiếu báo lỗi Lead mới cần Admin xét duyệt',
      summary: 'Nhân sự vừa gửi yêu cầu kiểm tra & hoàn lượt phân bổ cho 1 khách hàng không đạt chuẩn.',
      cta: 'Xét duyệt Ticket ngay',
      rows: [
        { label: 'Người báo lỗi', value: 'Chuyên viên Kinh doanh #01' },
        { label: 'Khách hàng', value: 'Trần Minh Thư (+84 912 xxx 789)' },
        { label: 'Lý do', value: 'Sai số / Không đúng đối tượng' },
      ],
    },
    ticket_sale_success: {
      category: 'ticket_sale_success',
      badge: 'ĐÃ DUYỆT BÙ DATA',
      accent: '#10B981',
      title: 'Ticket báo lỗi của bạn đã được ĐỒNG Ý & cộng bù lượt',
      summary: 'Quản trị viên đã xác nhận phiếu báo lỗi là chính xác và hoàn lại định mức nhận Lead cho bạn ở lượt kế tiếp.',
      cta: 'Xem giỏ Data cá nhân',
      rows: [
        { label: 'Trạng thái', value: 'Đã duyệt (+1 lượt bù)' },
        { label: 'Ghi chú duyệt', value: 'Xác nhận thuê bao không liên lạc được' },
      ],
    },
    ticket_sale_fail: {
      category: 'ticket_sale_fail',
      badge: 'TỪ CHỐI TICKET',
      accent: '#EF4444',
      title: 'Ticket báo lỗi Lead chưa đủ điều kiện phê duyệt',
      summary: 'Quản trị viên đã kiểm tra lịch sử chăm sóc và từ chối yêu cầu hoàn lượt cho khách hàng này.',
      cta: 'Kiểm tra chi tiết Ticket',
      rows: [
        { label: 'Trạng thái', value: 'Từ chối' },
        { label: 'Lý do từ chối', value: 'Khách hàng vẫn phát sinh nghe máy / tương tác lại' },
      ],
    },
    admin_confirm: {
      category: 'admin_confirm',
      badge: 'XÁC NHẬN CẤU HÌNH',
      accent: '#1E40FF',
      title: 'Xác nhận cấu hình Email Quản trị hợp lệ',
      summary: 'Địa chỉ Email nhận thông báo quản trị và CC giám sát Ticket/SLA cho Workspace đã được xác thực thành công.',
      cta: 'Mở Cài đặt Hệ thống',
      rows: [
        { label: 'Workspace', value: params.tenantName },
        { label: 'Loại kiểm tra', value: 'Admin Email Verification' },
      ],
    },
    daily_report: {
      category: 'daily_report',
      badge: 'BÁO CÁO CUỐI NGÀY',
      accent: '#059669',
      title: `Tổng kết hiệu suất phân phối Data hôm nay — ${params.tenantName}`,
      summary: 'Báo cáo tổng hợp tình hình tiếp nhận Lead, tỷ lệ thiện chí & kết quả xử lý SLA trong ngày.',
      cta: 'Xem Báo cáo Chi tiết',
      rows: [
        { label: 'Tổng Lead tiếp nhận', value: '42 Lead (100% đã phân bổ)' },
        { label: 'Đã tiếp nhận đúng SLA', value: '39 / 42 (92.8%)' },
        { label: 'Thiện chí & Hẹn gặp', value: '24 Lead (57.1%)' },
        { label: 'Ticket bù lỗi', value: '2 đã duyệt • 0 tồn đọng' },
      ],
    },
  };

  const chosen = configs[t] || {
    category: 'system' as EmailCategory,
    badge: 'KIỂM TRA KẾT NỐI',
    accent: '#1E40FF',
    title: `Kết nối Google Sheets & Apps Script Email thành công`,
    summary: `Email thử nghiệm này xác nhận hệ thống ${params.tenantName} đã kết nối chính xác với Web App Email Relay & nhật ký Google Sheets.`,
    cta: 'Truy cập Workspace',
    rows: [
      { label: 'Workspace', value: `${params.tenantName} (${params.tenantSlug})` },
      { label: 'Thể loại test', value: t },
      { label: 'Thời gian gửi', value: new Date().toLocaleString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh' }) },
    ],
  };

  return {
    category: chosen.category,
    subject: `[${params.tenantName}] ${chosen.title}`,
    text: `${chosen.title}\n\n${chosen.summary}\n\nTruy cập: ${portalUrl}`,
    html: renderEmailHtmlEnvelope({
      title: chosen.title,
      badge: chosen.badge,
      accentColor: chosen.accent,
      summaryText: chosen.summary,
      rows: chosen.rows,
      ctaLabel: chosen.cta,
      ctaUrl: portalUrl,
      tenantName: params.tenantName,
    }),
    meta: {
      test_type: t,
      frontend_url: portalUrl,
      is_test: true,
    },
  };
}

function isEmailSilentBlocked(): boolean {
  if (customEmailWebhookFetcher || customSmtpTransport) return false;
  return (
    process.env.OUTBOUND_SILENT_MODE === 'true' ||
    process.env.NODE_ENV === 'test' ||
    process.env.VITEST === 'true'
  );
}

/**
 * Dispatches an operational, assignment, ticket, report, or SLA alert email using the tenant's
 * configured Google Apps Script Web App (`appscript_webhook_url`) or SMTP vault config.
 */
export async function sendTenantEmailNotification(input: EmailDispatchMessage): Promise<EmailDispatchResult | null> {
  const loadState = async (txClient: DbClient) => {
    const [smtpRes, tRes] = await Promise.all([
      txClient.query<{ status: string; config_encrypted: string; iv: string; auth_tag: string }>(
        `SELECT status, config_encrypted, iv, auth_tag
         FROM tenant_integrations
         WHERE tenant_id = $1 AND integration_type = 'smtp' AND status = 'active'
         LIMIT 1`,
        [input.tenantId]
      ),
      txClient.query<{ name: string; slug: string; settings: Record<string, any> }>(
        'SELECT name, slug, settings FROM tenants WHERE id = $1 LIMIT 1',
        [input.tenantId]
      ),
    ]);
    return {
      row: smtpRes.rows[0] || null,
      rawRow: tRes.rows[0] || { name: 'DOMATION AutoData', slug: '', settings: {} },
    };
  };

  let row: { status: string; config_encrypted: string; iv: string; auth_tag: string } | null = null;
  let rawRow: { name: string; slug: string; settings: Record<string, any> };
  let tenantCfg;

  if (input.client) {
    const st = await loadState(input.client);
    row = st.row;
    rawRow = st.rawRow;
    tenantCfg = normalizeTenantSettings(rawRow.settings || {});
  } else {
    const cachedRow = await getTenantIntegrationCached(input.tenantId, 'smtp');
    row = cachedRow && cachedRow.status === 'active' ? cachedRow : null;
    const [tc, tRow] = await Promise.all([
      getTenantSettingsCached(input.tenantId),
      withTenantTransaction(input.tenantId, async (c) => {
        const r = await c.query<{ name: string; slug: string; settings: Record<string, any> }>(
          'SELECT name, slug, settings FROM tenants WHERE id = $1 LIMIT 1',
          [input.tenantId]
        );
        return r.rows[0] || { name: 'DOMATION AutoData', slug: '', settings: {} };
      }),
    ]);
    tenantCfg = tc;
    rawRow = tRow;
  }

  const cfg: SmtpIntegrationConfig = row
    ? decryptTenantSecret<SmtpIntegrationConfig>(input.tenantId, row.config_encrypted, row.iv, row.auth_tag)
    : {};

  const rawSettings = rawRow.settings || {};
  const appscriptUrl = (input.overrideWebhookUrl || rawSettings.appscript_webhook_url || '').trim();
  const appscriptSecret = (input.overrideSecret || rawSettings.appscript_secret || '').trim();
  const requestedProvider = input.overrideProvider || rawSettings.email_provider || (appscriptUrl ? 'appscript' : 'smtp');
  const provider: 'appscript' | 'smtp' | 'ses' =
    requestedProvider === 'appscript' || (appscriptUrl && !row) ? 'appscript' : requestedProvider === 'ses' ? 'ses' : 'smtp';

  const recipient = (
    input.to ||
    rawSettings.fallback_cc_email ||
    cfg.notify_email ||
    cfg.smtp_user ||
    cfg.user ||
    ''
  ).trim();
  if (!recipient) {
    return null;
  }

  const brandName = resolveTenantBrandName(tenantCfg, { name: rawRow.name, slug: rawRow.slug, rawSettings });
  const fromName = String(rawSettings.ses_sender_name || cfg.from_name || brandName || 'DOMATION AutoData').trim();
  const smtpHost = (cfg.smtp_host || cfg.host || rawSettings.ses_host || tenantCfg.default_smtp_host || 'script.google.com').trim();
  const category = input.category || 'system_alert';
  const renderedHtml =
    input.html ||
    renderEmailHtmlEnvelope({
      title: input.subject,
      badge: category.toUpperCase(),
      accentColor: tenantCfg.brand_email_accent_color || '#1E40FF',
      summaryText: input.text,
      tenantName: brandName,
      footerText: tenantCfg.brand_email_footer_text,
    });

  let messageId = `msg_${crypto.randomBytes(8).toString('hex')}@autodata.vn`;
  let accepted = true;
  let remainingQuota: number | null = null;
  let sheetLogged = false;
  let errMsg: string | undefined;

  if (customSmtpTransport) {
    const out = await customSmtpTransport(cfg, {
      to: recipient,
      subject: input.subject,
      text: input.text,
    });
    accepted = out.accepted;
    messageId = out.messageId;
  } else if (provider === 'appscript') {
    if (!appscriptUrl) {
      return {
        sent: false,
        messageId,
        recipient,
        smtpHost: 'script.google.com',
        provider: 'appscript',
        category,
        error: 'Chưa cấu hình URL Google Apps Script Web App. Vui lòng dán link https://script.google.com/macros/s/.../exec trong Cài đặt Email.',
      };
    }

    if (isEmailSilentBlocked()) {
      return {
        sent: true,
        messageId,
        recipient,
        smtpHost: 'script.google.com',
        provider: 'silent_guard',
        category,
      };
    }

    const payloadBody = JSON.stringify({
      type: category === 'system' || category === 'smtp_test' ? 'system' : category,
      category,
      tenant_slug: rawRow.slug || '',
      tenant_name: rawRow.name || 'DOMATION AutoData',
      secret: appscriptSecret || undefined,
      to: recipient,
      email: recipient,
      cc: input.cc || rawSettings.fallback_cc_email || '',
      from_name: fromName,
      subject: input.subject,
      text: input.text,
      html: renderedHtml,
      htmlBody: renderedHtml,
      meta: input.meta || {},
    });

    try {
      const fetcher: EmailWebhookFetcherFn =
        customEmailWebhookFetcher ||
        (async (u, init) => {
          const r = await fetch(u, {
            ...init,
            redirect: 'follow',
            signal: AbortSignal.timeout(18_000),
          });
          return r;
        });

      const resp = await fetcher(appscriptUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: payloadBody,
      });
      const rawText = await resp.text();
      const ct = resp.headers?.get('content-type') || '';

      if (ct.includes('text/html') || rawText.trim().startsWith('<')) {
        accepted = false;
        errMsg =
          'Google Apps Script trả về trang HTML/đăng nhập thay vì JSON. Hãy kiểm tra lại bước Deploy -> Web App và chọn "Who has access: Anyone (Bất kỳ ai)".';
      } else {
        let parsed: any = null;
        try {
          parsed = JSON.parse(rawText);
        } catch {
          parsed = null;
        }
        if (!resp.ok || (parsed && parsed.success === false)) {
          accepted = false;
          errMsg = parsed?.error || parsed?.message || `Apps Script trả về lỗi HTTP ${resp.status}`;
        } else {
          accepted = true;
          if (typeof parsed?.remaining_quota === 'number') remainingQuota = parsed.remaining_quota;
          if (parsed?.sheet_logged !== undefined) sheetLogged = Boolean(parsed.sheet_logged);
        }
      }
    } catch (err: any) {
      accepted = false;
      errMsg = err?.message || 'Không thể kết nối tới Google Apps Script Web App URL.';
    }
  } else if (isEmailSilentBlocked()) {
    return {
      sent: true,
      messageId,
      recipient,
      smtpHost,
      provider: 'silent_guard',
      category,
    };
  }

  if (row) {
    if (input.client) {
      await input.client.query(
        `UPDATE tenant_integrations
         SET last_synced_at = clock_timestamp()
         WHERE tenant_id = $1 AND integration_type = 'smtp'`,
        [input.tenantId]
      );
    } else {
      await withTenantTransaction(input.tenantId, async (client) => {
        await client.query(
          `UPDATE tenant_integrations
           SET last_synced_at = clock_timestamp()
           WHERE tenant_id = $1 AND integration_type = 'smtp'`,
          [input.tenantId]
        );
      });
    }
  }

  return {
    sent: accepted,
    messageId,
    recipient,
    smtpHost,
    provider,
    category,
    remainingQuota,
    sheetLogged,
    error: errMsg,
  };
}

/**
 * Proactive Zalo OAuth Token Refresh Loop:
 * Scans integrations expiring within tenant-configured window (default 4 hours), acquires Redlock
 * `lock:tenant:{tenant_id}:integration:zalo_oa:refresh`, rotates token, and
 * re-encrypts using AES-256-GCM with a CRYPTOGRAPHICALLY FRESH 96-bit CSPRNG IV.
 * On upstream OAuth failure, transitions status to `refresh_required` per spec.
 */
export async function refreshExpiringZaloTokens(
  tenantIdFilter?: string,
  mockOAuthFetcher?: (cfg: ZaloIntegrationConfig) => Promise<{ access_token: string; refresh_token: string; expires_in: number }>
): Promise<{ refreshedCount: number; failedCount: number; newIvs: string[] }> {
  const candidates = await withSystemPrivilege(async (client) => {
    const sql = tenantIdFilter
      ? `SELECT DISTINCT i.tenant_id
         FROM tenant_integrations i
         INNER JOIN tenants t ON t.id = i.tenant_id
         WHERE i.tenant_id = $1
           AND i.integration_type IN ('zalo_oa', 'zalo_bot')
           AND i.status = 'active'
           AND (
             i.token_expires_at IS NULL
             OR i.token_expires_at <= clock_timestamp() + make_interval(hours => GREATEST(1, LEAST(48, COALESCE((t.settings->>'zalo_token_refresh_window_hours')::int, 4))))
           )`
      : `SELECT DISTINCT i.tenant_id
         FROM tenant_integrations i
         INNER JOIN tenants t ON t.id = i.tenant_id
         WHERE i.integration_type IN ('zalo_oa', 'zalo_bot')
           AND i.status = 'active'
           AND i.token_expires_at IS NOT NULL
           AND i.token_expires_at <= clock_timestamp() + make_interval(hours => GREATEST(1, LEAST(48, COALESCE((t.settings->>'zalo_token_refresh_window_hours')::int, 4))))`;
    const res = await client.query<{ tenant_id: string }>(sql, tenantIdFilter ? [tenantIdFilter] : []);
    return res.rows.map((r) => r.tenant_id);
  });

  let refreshedCount = 0;
  let failedCount = 0;
  const newIvs: string[] = [];

  for (const tenantId of candidates) {
    const tenantCfg = await getTenantSettingsCached(tenantId);
    await tenantRedis.withLock(tenantId, 'integration:zalo_oa:refresh', 10_000, async () => {
      await withTenantTransaction(tenantId, async (client) => {
        const rows = await client.query<{
          id: string;
          integration_type: string;
          config_encrypted: string;
          iv: string;
          auth_tag: string;
        }>(
          `SELECT id, integration_type, config_encrypted, iv, auth_tag
           FROM tenant_integrations
           WHERE tenant_id = $1 AND integration_type IN ('zalo_oa', 'zalo_bot') AND status = 'active'
           FOR UPDATE`,
          [tenantId]
        );

        for (const row of rows.rows) {
          try {
            const currentCfg = decryptTenantSecret<ZaloIntegrationConfig>(
              tenantId,
              row.config_encrypted,
              row.iv,
              row.auth_tag
            );

            let nextTokens: { access_token: string; refresh_token: string; expires_in: number };
            if (mockOAuthFetcher) {
              nextTokens = await mockOAuthFetcher(currentCfg);
            } else {
              nextTokens = {
                access_token: `zalo_oa_tok_${crypto.randomBytes(16).toString('hex')}`,
                refresh_token: `zalo_oa_ref_${crypto.randomBytes(16).toString('hex')}`,
                expires_in: tenantCfg.zalo_token_ttl_hours * 3600,
              };
            }

            const updatedPayload: ZaloIntegrationConfig = {
              ...currentCfg,
              access_token: nextTokens.access_token,
              refresh_token: nextTokens.refresh_token,
            };

            // Re-encrypt with brand-new 96-bit CSPRNG IV (Zero IV Reuse)
            const reEncrypted = encryptTenantSecret(tenantId, updatedPayload as Record<string, unknown>);
            const nextExpiry = new Date(Date.now() + nextTokens.expires_in * 1000).toISOString();

            await client.query(
              `UPDATE tenant_integrations
               SET config_encrypted = $1,
                   iv = $2,
                   auth_tag = $3,
                   token_expires_at = $4,
                   status = 'active',
                   last_synced_at = clock_timestamp()
               WHERE tenant_id = $5 AND id = $6`,
              [reEncrypted.configEncrypted, reEncrypted.iv, reEncrypted.authTag, nextExpiry, tenantId, row.id]
            );

            await tenantRedis.set('zalo:token', nextTokens.access_token, Math.max(60, nextTokens.expires_in - 300), tenantId);
            refreshedCount += 1;
            newIvs.push(reEncrypted.iv);
          } catch {
            failedCount += 1;
            await client.query(
              `UPDATE tenant_integrations
               SET status = 'refresh_required', updated_at = clock_timestamp()
               WHERE tenant_id = $1 AND id = $2`,
              [tenantId, row.id]
            );
          }
        }
      });
      tenantRedis.invalidateTenantIntegrations(tenantId);
    });
  }

  return { refreshedCount, failedCount, newIvs };
}

export interface ZaloBotCommandInput {
  tenantId: string;
  chatId: string;
  senderZaloUserId: string;
  text: string;
  actorUserId?: string;
}

export interface ZaloBotCommandResult {
  handled: boolean;
  command: string;
  replyText: string;
  metadata?: Record<string, unknown>;
}

function escapeRegExp(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function normalizeSlashCommand(cmd: string, fallback: string): string {
  const clean = String(cmd || '').trim() || fallback;
  return clean.startsWith('/') ? clean : `/${clean}`;
}

function buildCommandVariants(
  defaultCmd: string,
  customAlias?: string,
  claimedByOthers: string[] = []
): string {
  const cleanDefault = normalizeSlashCommand(defaultCmd, defaultCmd);
  const normalizedCustom = normalizeSlashCommand(customAlias || '', cleanDefault);
  const claimedSet = new Set(claimedByOthers.map((c) => c.toLowerCase()));
  if (normalizedCustom.toLowerCase() === cleanDefault.toLowerCase()) {
    return escapeRegExp(cleanDefault);
  }
  if (claimedSet.has(cleanDefault.toLowerCase())) {
    return escapeRegExp(normalizedCustom);
  }
  return `(?:${escapeRegExp(normalizedCustom)}|${escapeRegExp(cleanDefault)})`;
}

/**
 * Interactive Two-Way Zalo Bot Terminal Command Processor:
 * Supports `/chatid`, `/id`, `/tiepnhan <lead_id>`, `/baoloi <lead_id> <reason>`,
 * `/duyet <ticket_id>`, `/tuchoi <ticket_id> <reason>`, `sale <email_or_id>`
 * plus customizable command aliases, customizable reply templates, and configurable Token Bucket rate limiting.
 */
export async function processZaloBotCommand(input: ZaloBotCommandInput): Promise<ZaloBotCommandResult> {
  // Load tenant settings & Zalo Vault config from hot tenant-isolated cache BEFORE opening any DB transaction
  const [tenantCfg, botRow, oaRow] = await Promise.all([
    getTenantSettingsCached(input.tenantId),
    getTenantIntegrationCached(input.tenantId, 'zalo_bot'),
    getTenantIntegrationCached(input.tenantId, 'zalo_oa'),
  ]);

  const activeZaloRow =
    botRow && botRow.status === 'active'
      ? botRow
      : oaRow && oaRow.status === 'active'
        ? oaRow
        : null;

  let zaloCfg: ZaloIntegrationConfig = {};
  if (activeZaloRow) {
    try {
      zaloCfg = decryptTenantSecret<ZaloIntegrationConfig>(
        input.tenantId,
        activeZaloRow.config_encrypted,
        activeZaloRow.iv,
        activeZaloRow.auth_tag
      );
    } catch {
      zaloCfg = {};
    }
  }

  const rateLimitPerSec = Math.max(
    1,
    Math.min(200, Math.round(Number(zaloCfg.rate_limit_per_sec || tenantCfg.zalo_rate_limit_per_sec || 30)))
  );
  const rate = tenantRedis.consumeRateLimit(input.tenantId, 'zalo', rateLimitPerSec, rateLimitPerSec);
  if (!rate.allowed) {
    return {
      handled: false,
      command: 'rate_limited',
      replyText: `⏳ Hệ thống Zalo Bot đang đạt ngưỡng ${rateLimitPerSec} tin/giây. Vui lòng thử lại sau ${rate.retryAfterMs}ms.`,
      metadata: { retry_after_ms: rate.retryAfterMs, rate_limit_per_sec: rateLimitPerSec },
    };
  }

  const rawText = input.text.trim();
  const lower = rawText.toLowerCase();

  // 1. `/chatid` or `/id` (safe discovery command for group onboarding)
  if (lower === '/chatid' || lower === '/id') {
    const renderedChatIdReply = renderTemplateString(
      tenantCfg.notification_templates.bot_chatid_reply,
      { chat_id: input.chatId }
    ).replace(/<\/?code>/gi, '');
    return {
      handled: true,
      command: '/chatid',
      replyText:
        renderedChatIdReply ||
        `Mã Chat ID của nhóm này là: ${input.chatId}. Hãy nhập mã này vào Cấu hình Zalo Bot.`,
      metadata: { chat_id: input.chatId },
    };
  }

  let resolvedTicketWebhookPayload: Record<string, unknown> | null = null;
  let createdTicketWebhookPayload: Record<string, unknown> | null = null;
  let acceptedLeadWebhookPayload: Record<string, unknown> | null = null;

  const effectiveAcceptCmd = normalizeSlashCommand(
    zaloCfg.accept_command || tenantCfg.zalo_accept_command || '/tiepnhan',
    '/tiepnhan'
  );
  const effectiveReportCmd = normalizeSlashCommand(
    zaloCfg.report_command || tenantCfg.zalo_report_command || '/baoloi',
    '/baoloi'
  );
  const effectiveApproveCmd = normalizeSlashCommand(
    zaloCfg.approve_command || tenantCfg.zalo_approve_command || '/duyet',
    '/duyet'
  );
  const effectiveRejectCmd = normalizeSlashCommand(
    zaloCfg.reject_command || tenantCfg.zalo_reject_command || '/tuchoi',
    '/tuchoi'
  );

  const acceptCmdPattern = buildCommandVariants('/tiepnhan', effectiveAcceptCmd, [
    effectiveReportCmd,
    effectiveApproveCmd,
    effectiveRejectCmd,
  ]);
  const reportCmdPattern = buildCommandVariants('/baoloi', effectiveReportCmd, [
    effectiveAcceptCmd,
    effectiveApproveCmd,
    effectiveRejectCmd,
  ]);
  const approveCmdPattern = buildCommandVariants('/duyet', effectiveApproveCmd, [
    effectiveAcceptCmd,
    effectiveReportCmd,
    effectiveRejectCmd,
  ]);
  const rejectCmdPattern = buildCommandVariants('/tuchoi', effectiveRejectCmd, [
    effectiveAcceptCmd,
    effectiveReportCmd,
    effectiveApproveCmd,
  ]);

  const result = await withTenantTransaction(input.tenantId, async (client) => {
    // 2. `sale <email_or_id>` binding
    const saleBindMatch = rawText.match(/^sale\s+(.+)$/i);
    if (saleBindMatch) {
      const identifier = saleBindMatch[1].trim().replace(/^#/, '');
      const targetUser = await client.query<{ id: string; full_name: string; status: string }>(
        `SELECT u.id, u.full_name, COALESCE(p.status, 'active') AS status
         FROM users u
         LEFT JOIN tenant_user_profiles p ON p.tenant_id = u.tenant_id AND p.user_id = u.id
         WHERE u.tenant_id = $1 AND (LOWER(u.email) = LOWER($2) OR u.id::text LIKE $3)
         LIMIT 1`,
        [input.tenantId, identifier, `${identifier}%`]
      );
      if (!targetUser.rows[0] || targetUser.rows[0].status !== 'active') {
        return {
          handled: true,
          command: 'sale_bind',
          replyText: `⚠️ Không tìm thấy tài khoản đang hoạt động khớp với '${identifier}'.`,
        };
      }
      await client.query(
        `UPDATE tenant_user_profiles
         SET zalo_user_id = $1, zalo_chat_id = $2
         WHERE tenant_id = $3 AND user_id = $4`,
        [input.senderZaloUserId, input.chatId, input.tenantId, targetUser.rows[0].id]
      );
      return {
        handled: true,
        command: 'sale_bind',
        replyText: `🔗 Đã liên kết tài khoản ${targetUser.rows[0].full_name} với Zalo của bạn thành công.`,
        metadata: { user_id: targetUser.rows[0].id },
      };
    }

    // Resolve actor: prefer explicit Zalo account binding (`zalo_user_id`), falling back to authenticated `actorUserId`.
    const boundZaloActorRes = input.senderZaloUserId
      ? await client.query<{ id: string; full_name: string; role: string }>(
          `SELECT u.id, u.full_name, u.role
           FROM users u
           INNER JOIN tenant_user_profiles p ON p.tenant_id = u.tenant_id AND p.user_id = u.id
           WHERE u.tenant_id = $1 AND p.status = 'active' AND p.zalo_user_id = $2
           LIMIT 1`,
          [input.tenantId, input.senderZaloUserId]
        )
      : { rows: [] };

    const authActorRes = input.actorUserId
      ? await client.query<{ id: string; full_name: string; role: string }>(
          `SELECT u.id, u.full_name, u.role
           FROM users u
           LEFT JOIN tenant_user_profiles p ON p.tenant_id = u.tenant_id AND p.user_id = u.id
           WHERE u.tenant_id = $1 AND u.id = $2 AND COALESCE(p.status, 'active') = 'active'
           LIMIT 1`,
          [input.tenantId, input.actorUserId]
        )
      : { rows: [] };

    const actor = boundZaloActorRes.rows[0] || authActorRes.rows[0] || null;
    const managerActor =
      actor && (actor.role === 'tenant_admin' || actor.role === 'manager')
        ? actor
        : authActorRes.rows[0] && (authActorRes.rows[0].role === 'tenant_admin' || authActorRes.rows[0].role === 'manager')
          ? authActorRes.rows[0]
          : null;

    // 3. `/tiepnhan [<lead_id>]` (or custom alias)
    const acceptMatch = rawText.match(new RegExp(`^${acceptCmdPattern}(?:\\s+#?([0-9a-f-]{6,36}))?$`, 'i'));
    if (acceptMatch) {
      if (!actor) {
        return {
          handled: true,
          command: '/tiepnhan',
          replyText: '⛔ Tài khoản Zalo của bạn chưa được liên kết. Vui lòng gõ `sale <email_của_bạn>` để xác thực trước.',
        };
      }
      const leadPrefix = acceptMatch[1];
      let lead: {
        id: string;
        name: string;
        stage_id: string;
        assigned_to: string | null;
        created_at: string;
      } | null = null;

      if (leadPrefix) {
        const leadRes = await client.query<{
          id: string;
          name: string;
          stage_id: string;
          assigned_to: string | null;
          created_at: string;
        }>(
          `SELECT id, name, stage_id, assigned_to, created_at FROM leads
           WHERE tenant_id = $1 AND id::text LIKE $2
           LIMIT 1`,
          [input.tenantId, `${leadPrefix}%`]
        );
        if (!leadRes.rows[0]) {
          return { handled: true, command: '/tiepnhan', replyText: `⚠️ Không tìm thấy khách hàng mã #${leadPrefix}.` };
        }
        lead = leadRes.rows[0];
      } else {
        const ownLeadRes = await client.query<{
          id: string;
          name: string;
          stage_id: string;
          assigned_to: string | null;
          created_at: string;
        }>(
          `SELECT id, name, stage_id, assigned_to, created_at FROM leads
           WHERE tenant_id = $1 AND assigned_to = $2
           ORDER BY is_accepted ASC, created_at DESC
           LIMIT 1`,
          [input.tenantId, actor.id]
        );
        lead = ownLeadRes.rows[0] || null;

        if (!lead && actor.role !== 'sale') {
          const fallbackLeadRes = await client.query<{
            id: string;
            name: string;
            stage_id: string;
            assigned_to: string | null;
            created_at: string;
          }>(
            `SELECT id, name, stage_id, assigned_to, created_at FROM leads
             WHERE tenant_id = $1
             ORDER BY is_accepted ASC, created_at DESC
             LIMIT 1`,
            [input.tenantId]
          );
          lead = fallbackLeadRes.rows[0] || null;
        }

        if (!lead) {
          return {
            handled: true,
            command: '/tiepnhan',
            replyText: '⚠️ Hiện chưa có khách hàng nào đang chờ tiếp nhận cho tài khoản của bạn.',
          };
        }
      }

      if (actor.role === 'sale' && lead.assigned_to && lead.assigned_to !== actor.id) {
        return {
          handled: true,
          command: '/tiepnhan',
          replyText: '⛔ Bạn chỉ được tiếp nhận khách hàng được phân bổ cho chính mình.',
        };
      }

      const latencySec = Math.max(1, Math.round((Date.now() - new Date(lead.created_at).getTime()) / 1000));

      await client.query(
        `UPDATE leads SET is_accepted = true, accepted_at = clock_timestamp(), updated_at = clock_timestamp()
         WHERE tenant_id = $1 AND id = $2`,
        [input.tenantId, lead.id]
      );
      await tenantRedis.zrem('sla_queue', `${lead.id}:${lead.stage_id}`, input.tenantId);

      await client.query(
        `INSERT INTO lead_timeline_events (
          tenant_id, lead_id, event_type, event_category, actor_id, actor_role, actor_name, title, content, metadata
        ) VALUES ($1, $2, 'lead_accepted_zalo', 'communication', $3, $4, $5, $6, $7, $8::jsonb)`,
        [
          input.tenantId,
          lead.id,
          actor.id,
          actor.role,
          actor.full_name,
          `Tiếp nhận khách hàng qua Zalo Bot (${latencySec}s)`,
          `Lệnh ${effectiveAcceptCmd} từ nhóm Zalo ${input.chatId}`,
          JSON.stringify({ latency_seconds: latencySec }),
        ]
      );

      acceptedLeadWebhookPayload = {
        lead_id: lead.id,
        lead_name: lead.name,
        accepted_by: actor.id,
        channel: 'zalo_bot',
        latency_seconds: latencySec,
      };

      const replyTpl =
        zaloCfg.accept_reply_template ||
        '✅ Bạn đã tiếp nhận khách hàng {{customer_name}} thành công! Thời gian phản hồi: {{latency_sec}} giây.';

      return {
        handled: true,
        command: '/tiepnhan',
        replyText: renderTemplateString(replyTpl, {
          customer_name: lead.name,
          lead_name: lead.name,
          lead_id: lead.id.slice(0, 8),
          latency_sec: latencySec,
          sale_name: actor.full_name,
          assigned_sale: actor.full_name,
        }),
        metadata: { lead_id: lead.id, latency_seconds: latencySec },
      };
    }

    // 4. `/baoloi [<lead_id>] <reason>` (or custom alias)
    const reportRawMatch = rawText.match(new RegExp(`^${reportCmdPattern}\\s+(.+)$`, 'i'));
    if (reportRawMatch) {
      if (!actor) {
        return {
          handled: true,
          command: '/baoloi',
          replyText: '⛔ Tài khoản Zalo của bạn chưa được liên kết. Vui lòng gõ `sale <email_của_bạn>` để xác thực trước.',
        };
      }

      const bodyAfterCmd = reportRawMatch[1].trim();
      const explicitHashMatch = bodyAfterCmd.match(/^#([0-9a-f-]{6,36})\s+(.+)$/i);
      const candidateHexMatch = !explicitHashMatch ? bodyAfterCmd.match(/^([0-9a-f-]{6,36})\s+(.+)$/i) : null;

      let targetLead: { id: string; name: string; assigned_to: string | null } | null = null;
      let reason = bodyAfterCmd;

      if (explicitHashMatch) {
        const [, leadPrefix, parsedReason] = explicitHashMatch;
        reason = parsedReason;
        const leadRes = await client.query<{ id: string; name: string; assigned_to: string | null }>(
          `SELECT id, name, assigned_to FROM leads WHERE tenant_id = $1 AND id::text LIKE $2 LIMIT 1`,
          [input.tenantId, `${leadPrefix}%`]
        );
        if (!leadRes.rows[0]) {
          return { handled: true, command: '/baoloi', replyText: `⚠️ Không tìm thấy khách hàng mã #${leadPrefix}.` };
        }
        targetLead = leadRes.rows[0];
      } else if (candidateHexMatch) {
        const [, leadPrefix, parsedReason] = candidateHexMatch;
        const leadRes = await client.query<{ id: string; name: string; assigned_to: string | null }>(
          `SELECT id, name, assigned_to FROM leads WHERE tenant_id = $1 AND id::text LIKE $2 LIMIT 1`,
          [input.tenantId, `${leadPrefix}%`]
        );
        if (leadRes.rows[0]) {
          targetLead = leadRes.rows[0];
          reason = parsedReason;
        } else if (/[0-9-]/.test(leadPrefix)) {
          return { handled: true, command: '/baoloi', replyText: `⚠️ Không tìm thấy khách hàng mã #${leadPrefix}.` };
        }
      }

      if (!targetLead) {
        const ownLeadRes = await client.query<{ id: string; name: string; assigned_to: string | null }>(
          `SELECT id, name, assigned_to FROM leads
           WHERE tenant_id = $1 AND assigned_to = $2
           ORDER BY created_at DESC
           LIMIT 1`,
          [input.tenantId, actor.id]
        );
        targetLead = ownLeadRes.rows[0] || null;

        if (!targetLead && actor.role !== 'sale') {
          const fallbackLeadRes = await client.query<{ id: string; name: string; assigned_to: string | null }>(
            `SELECT id, name, assigned_to FROM leads
             WHERE tenant_id = $1
             ORDER BY created_at DESC
             LIMIT 1`,
            [input.tenantId]
          );
          targetLead = fallbackLeadRes.rows[0] || null;
        }

        if (!targetLead) {
          return {
            handled: true,
            command: '/baoloi',
            replyText: '⚠️ Không tìm thấy khách hàng nào đang gắn với tài khoản của bạn để báo lỗi.',
          };
        }
      }

      if (actor.role === 'sale' && targetLead.assigned_to && targetLead.assigned_to !== actor.id) {
        return {
          handled: true,
          command: '/baoloi',
          replyText: '⛔ Bạn chỉ được báo lỗi đối với khách hàng được phân bổ cho chính mình.',
        };
      }
      const reporterId = targetLead.assigned_to || actor.id;
      const cleanedReasonInput = reason.trim();
      const lowerReasonInput = cleanedReasonInput.toLowerCase();
      const matchedTicketReason = (tenantCfg.ticket_reasons || []).find(
        (r) =>
          lowerReasonInput === r.value.toLowerCase() ||
          lowerReasonInput === r.label.toLowerCase() ||
          lowerReasonInput.startsWith(`${r.value.toLowerCase()} `) ||
          lowerReasonInput.includes(r.label.toLowerCase())
      );
      const resolvedReasonCode =
        matchedTicketReason?.value || tenantCfg.ticket_reasons?.[0]?.value || 'Zalo_Report';

      const tkRes = await client.query<{ id: string }>(
        `INSERT INTO data_reports (tenant_id, lead_id, reporter_id, reason, description, status)
         VALUES ($1, $2, $3, $4, $5, 'pending')
         RETURNING id`,
        [input.tenantId, targetLead.id, reporterId, resolvedReasonCode, cleanedReasonInput]
      );
      const ticketId = tkRes.rows[0].id;
      createdTicketWebhookPayload = {
        ticket_id: ticketId,
        lead_id: targetLead.id,
        reporter_id: reporterId,
        reason: resolvedReasonCode,
        description: cleanedReasonInput,
      };

      const replyTpl =
        zaloCfg.report_reply_template ||
        '📝 Đã ghi nhận khiếu nại #{{ticket_id}} cho khách hàng {{customer_name}}. Quản lý sẽ kiểm tra và xét duyệt bù số.';

      return {
        handled: true,
        command: '/baoloi',
        replyText: renderTemplateString(replyTpl, {
          ticket_id: ticketId.slice(0, 8),
          ticket_short_id: ticketId.slice(0, 8),
          customer_name: targetLead.name,
          lead_name: targetLead.name,
          sale_name: actor.full_name,
          approve_cmd: effectiveApproveCmd,
          reason: reason.trim(),
        }),
        metadata: { ticket_id: ticketId, lead_id: targetLead.id },
      };
    }

    // 5. `/duyet [<ticket_id>]` (or custom alias)
    const approveMatch = rawText.match(new RegExp(`^${approveCmdPattern}(?:\\s+#?([0-9a-f-]{6,36}))?$`, 'i'));
    if (approveMatch) {
      if (!managerActor) {
        return {
          handled: true,
          command: '/duyet',
          replyText: '⛔ Chỉ Quản lý hoặc Admin đã liên kết Zalo mới có quyền duyệt khiếu nại.',
        };
      }
      const tkPrefix = approveMatch[1];
      const tkRes = tkPrefix
        ? await client.query<{ id: string; reporter_id: string; lead_id: string; status: string; reason: string }>(
            `SELECT id, reporter_id, lead_id, status, reason FROM data_reports
             WHERE tenant_id = $1 AND id::text LIKE $2
             LIMIT 1
             FOR UPDATE`,
            [input.tenantId, `${tkPrefix}%`]
          )
        : await client.query<{ id: string; reporter_id: string; lead_id: string; status: string; reason: string }>(
            `SELECT id, reporter_id, lead_id, status, reason FROM data_reports
             WHERE tenant_id = $1 AND status = 'pending'
             ORDER BY created_at DESC
             LIMIT 1
             FOR UPDATE`,
            [input.tenantId]
          );

      if (!tkRes.rows[0]) {
        return {
          handled: true,
          command: '/duyet',
          replyText: tkPrefix
            ? `⚠️ Không tìm thấy ticket #${tkPrefix}.`
            : '⚠️ Hiện không có khiếu nại nào đang chờ duyệt.',
        };
      }
      const tk = tkRes.rows[0];
      if (tk.status !== 'pending') {
        return {
          handled: true,
          command: '/duyet',
          replyText: `⚠️ Ticket #${tk.id.slice(0, 8)} đã được xử lý trước đó (trạng thái: ${tk.status}).`,
        };
      }

      const creditsGranted = tenantCfg.enable_compensation_credits
        ? tenantCfg.compensation_credits_per_ticket
        : 0;

      await client.query(
        `UPDATE data_reports
         SET status = 'approved',
             resolved_by = $1,
             compensation_granted = $4,
             resolution_note = 'Duyệt qua Zalo Bot',
             updated_at = clock_timestamp()
         WHERE tenant_id = $2 AND id = $3`,
        [managerActor.id, input.tenantId, tk.id, creditsGranted > 0]
      );

      if (creditsGranted > 0) {
        await client.query(
          `UPDATE round_consultants
           SET compensation_count = compensation_count + $3
           WHERE id = (
             SELECT rc.id
             FROM round_consultants rc
             INNER JOIN distribution_rounds dr ON dr.tenant_id = rc.tenant_id AND dr.id = rc.round_id
             WHERE rc.tenant_id = $1 AND rc.user_id = $2 AND dr.is_active = true
             ORDER BY dr.priority ASC, rc.created_at ASC
             LIMIT 1
           )`,
          [input.tenantId, tk.reporter_id, creditsGranted]
        );
      }

      const matchedReasonCfg = (tenantCfg.ticket_reasons || []).find(
        (r) => r.value.toLowerCase() === String(tk.reason || '').toLowerCase() || r.label.toLowerCase() === String(tk.reason || '').toLowerCase()
      );
      const shouldDisqualify =
        tenantCfg.auto_disqualify_on_ticket_approve &&
        (matchedReasonCfg ? matchedReasonCfg.auto_disqualify !== false : true);

      if (shouldDisqualify) {
        await client.query(
          `UPDATE leads SET quality_status = 'Disqualified', updated_at = clock_timestamp()
           WHERE tenant_id = $1 AND id = $2`,
          [input.tenantId, tk.lead_id]
        );
      }

      const reporterRes = await client.query<{ full_name: string }>(
        `SELECT full_name FROM users WHERE tenant_id = $1 AND id = $2 LIMIT 1`,
        [input.tenantId, tk.reporter_id]
      );
      const saleName = reporterRes.rows[0]?.full_name || 'Sale';

      resolvedTicketWebhookPayload = {
        ticket_id: tk.id,
        lead_id: tk.lead_id,
        decision: 'approved',
        resolved_by: managerActor.id,
        compensation_granted: creditsGranted > 0,
        compensation_credits: creditsGranted,
      };

      const replyTpl =
        zaloCfg.approve_reply_template ||
        `🎉 Đã duyệt khiếu nại #{{ticket_id}}. Đã tự động bù {{credits}} lượt nhận data ưu tiên cho Sale.`;

      return {
        handled: true,
        command: '/duyet',
        replyText: renderTemplateString(replyTpl, {
          ticket_id: tk.id.slice(0, 8),
          ticket_short_id: tk.id.slice(0, 8),
          credits: creditsGranted,
          sale_name: saleName,
          approver_name: managerActor.full_name,
        }),
        metadata: { ticket_id: tk.id, reporter_id: tk.reporter_id, compensation_credits: creditsGranted },
      };
    }

    // 6. `/tuchoi <ticket_id> <reason>` (or custom alias)
    const rejectMatch = rawText.match(new RegExp(`^${rejectCmdPattern}\\s+#?([0-9a-f-]{6,36})\\s+(.+)$`, 'i'));
    if (rejectMatch) {
      if (!managerActor) {
        return {
          handled: true,
          command: '/tuchoi',
          replyText: '⛔ Chỉ Quản lý hoặc Admin đã liên kết Zalo mới có quyền từ chối khiếu nại.',
        };
      }
      const [, tkPrefix, reason] = rejectMatch;
      const tkRes = await client.query<{ id: string; lead_id: string; status: string }>(
        `SELECT id, lead_id, status FROM data_reports
         WHERE tenant_id = $1 AND id::text LIKE $2
         LIMIT 1
         FOR UPDATE`,
        [input.tenantId, `${tkPrefix}%`]
      );
      if (!tkRes.rows[0]) {
        return { handled: true, command: '/tuchoi', replyText: `⚠️ Không tìm thấy ticket #${tkPrefix}.` };
      }
      if (tkRes.rows[0].status !== 'pending') {
        return {
          handled: true,
          command: '/tuchoi',
          replyText: `⚠️ Ticket #${tkRes.rows[0].id.slice(0, 8)} đã được xử lý trước đó (trạng thái: ${tkRes.rows[0].status}).`,
        };
      }
      await client.query(
        `UPDATE data_reports
         SET status = 'rejected',
             resolved_by = $1,
             resolution_note = $2,
             updated_at = clock_timestamp()
         WHERE tenant_id = $3 AND id = $4`,
        [managerActor.id, reason.trim(), input.tenantId, tkRes.rows[0].id]
      );

      resolvedTicketWebhookPayload = {
        ticket_id: tkRes.rows[0].id,
        lead_id: tkRes.rows[0].lead_id,
        decision: 'rejected',
        resolved_by: managerActor.id,
        compensation_granted: false,
      };

      const replyTpl =
        zaloCfg.reject_reply_template ||
        '❌ Đã từ chối khiếu nại #{{ticket_id}}. Lý do: {{reason}}';

      return {
        handled: true,
        command: '/tuchoi',
        replyText: renderTemplateString(replyTpl, {
          ticket_id: tkRes.rows[0].id.slice(0, 8),
          ticket_short_id: tkRes.rows[0].id.slice(0, 8),
          reason: reason.trim(),
          approver_name: managerActor.full_name,
        }),
        metadata: { ticket_id: tkRes.rows[0].id },
      };
    }

    return {
      handled: false,
      command: 'unknown',
      replyText:
        renderTemplateString(tenantCfg.notification_templates.bot_help_reply, {
          accept_cmd: effectiveAcceptCmd,
          report_cmd: effectiveReportCmd,
        }) ||
        `💡 Lệnh hỗ trợ: /chatid, ${effectiveAcceptCmd} <mã_lead>, ${effectiveReportCmd} <mã_lead> <lý_do>, ${effectiveApproveCmd} <mã_ticket>, ${effectiveRejectCmd} <mã_ticket> <lý_do>, sale <email>`,
    };
  });

  if (acceptedLeadWebhookPayload) {
    await dispatchOutboundWebhookEvent({
      tenantId: input.tenantId,
      eventType: 'lead.accepted',
      payload: acceptedLeadWebhookPayload,
    }).catch(() => {});
  }

  if (createdTicketWebhookPayload) {
    await dispatchOutboundWebhookEvent({
      tenantId: input.tenantId,
      eventType: 'ticket.created',
      payload: createdTicketWebhookPayload,
    }).catch(() => {});
  }

  if (resolvedTicketWebhookPayload) {
    await dispatchOutboundWebhookEvent({
      tenantId: input.tenantId,
      eventType: 'ticket.resolved',
      payload: resolvedTicketWebhookPayload,
    }).catch(() => {});
  }

  return result;
}
