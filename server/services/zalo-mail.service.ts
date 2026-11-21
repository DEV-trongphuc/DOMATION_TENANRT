import crypto from 'node:crypto';
import https from 'node:https';
import net from 'node:net';
import tls from 'node:tls';
import type { DbClient } from '../core/database/db-adapter.ts';
import { withTenantTransaction, withSystemPrivilege } from '../core/database/transaction.ts';
import { encryptTenantSecret, decryptTenantSecret } from '../core/crypto/vault.ts';
import { tenantRedis } from '../core/cache/tenant-redis.ts';
import {
  DEFAULT_TENANT_SETTINGS,
  normalizeTenantSettings,
  renderTemplateString,
  resolveTenantBrandName,
} from '../core/settings/tenant-settings.ts';
import {
  getTenantIntegrationCached,
  getTenantIntegrationsBatchCached,
  getTenantMetaCached,
  getTenantSettingsCached,
} from '../core/settings/tenant-cache.ts';
import { isLocalLoopbackUrl, isOutboundSilentMode } from '../core/security/outbound-guard.ts';
import { dispatchOutboundWebhookEvent } from './webhook.service.ts';

export interface ZaloIntegrationConfig {
  app_id?: string;
  oa_id?: string;
  oa_secret?: string;
  secret_key?: string;
  bot_token?: string;
  botToken?: string;
  chat_id?: string;
  chatId?: string;
  enabled?: boolean;
  silent_mode?: boolean;
  silentMode?: boolean;
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
  from_email?: string;
  fromEmail?: string;
  sender_email?: string;
  sesRegion?: string;
  region?: string;
  aws_region?: string;
  authUser?: string;
  accessKeyId?: string;
  aws_access_key_id?: string;
  apiKey?: string;
  api_key?: string;
  server_token?: string;
  serverToken?: string;
  secretAccessKey?: string;
  aws_secret_access_key?: string;
  max_send_rate?: number;
  max_send_rate_per_sec?: number;
  sandbox_mode?: boolean;
  dkim_verified?: boolean;
}

export type EmailProvider = 'appscript' | 'resend' | 'smtp' | 'ses' | 'sendgrid' | 'postmark';

export interface PreloadedEmailTenantState {
  tenantId: string;
  smtpCfg: SmtpIntegrationConfig;
  hasSmtpVault: boolean;
  sesCfg: SmtpIntegrationConfig;
  hasSesVault: boolean;
  resendCfg: SmtpIntegrationConfig;
  hasResendVault: boolean;
  sendgridCfg: SmtpIntegrationConfig;
  hasSendgridVault: boolean;
  postmarkCfg: SmtpIntegrationConfig;
  hasPostmarkVault: boolean;
  rawRow: { name: string; slug: string; settings: Record<string, any> };
  tenantCfg: ReturnType<typeof normalizeTenantSettings>;
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
  overrideProvider?: EmailProvider;
  overrideWebhookUrl?: string;
  overrideSecret?: string;
  /** When true (Marketing Automation), Google Apps Script is strictly forbidden. */
  disallowAppscript?: boolean;
  /** When true, SMTP / AWS SES SMTP uses persistent connection pooling (maxConnections: 10, maxMessages: 200). */
  pooled?: boolean;
  fromEmailOverride?: string;
  fromNameOverride?: string;
  /** Preloaded decrypted tenant + vault state from Phase 1 so Phase 2 makes zero DB queries per message. */
  preloadedState?: PreloadedEmailTenantState;
}

export interface EmailDispatchResult {
  sent: boolean;
  messageId: string;
  headerMessageId?: string;
  recipient: string;
  smtpHost: string;
  provider: EmailProvider | 'silent_guard';
  category: string;
  remainingQuota?: number | null;
  sheetLogged?: boolean;
  error?: string;
}

export interface ZaloBotSendResult {
  success: boolean;
  messageId?: string;
  silent: boolean;
  mocked: boolean;
  error?: string;
}

export interface DiscordSendResult {
  success: boolean;
  messageId?: string;
  silent: boolean;
  mocked: boolean;
  error?: string;
}

type SmtpTransportFn = (
  cfg: SmtpIntegrationConfig,
  msg: { to: string; subject: string; text: string; html?: string; fromName?: string; cc?: string }
) => Promise<{ accepted: boolean; messageId: string }>;

export type ZaloOAuthFetcherFn = (
  cfg: ZaloIntegrationConfig
) => Promise<{ access_token: string; refresh_token: string; expires_in: number }>;

type EmailWebhookFetcherFn = (
  url: string,
  init: { method: string; headers: Record<string, string>; body: string }
) => Promise<{ ok: boolean; status: number; text: () => Promise<string>; headers?: { get(k: string): string | null } }>;

export type ZaloBotTransportFn = (payload: {
  chatId: string;
  text: string;
  botToken?: string;
}) => Promise<{ messageId?: string; ok?: boolean } | void>;

export type DiscordTransportFn = (payload: {
  webhookUrl?: string;
  channelId?: string;
  content: string;
  username?: string;
  embeds?: Array<Record<string, unknown>>;
}) => Promise<{ messageId?: string; id?: string } | void>;

let customSmtpTransport: SmtpTransportFn | null = null;
let customEmailWebhookFetcher: EmailWebhookFetcherFn | null = null;
let customZaloBotTransport: ZaloBotTransportFn | null = null;
let customDiscordTransport: DiscordTransportFn | null = null;
let customZaloOAuthFetcher: ZaloOAuthFetcherFn | null = null;

export function setSmtpTransportForTesting(fn: SmtpTransportFn | null): void {
  customSmtpTransport = fn;
}

export function setEmailWebhookFetcherForTesting(fn: EmailWebhookFetcherFn | null): void {
  customEmailWebhookFetcher = fn;
}

export function setZaloBotTransportForTesting(fn: ZaloBotTransportFn | null): void {
  customZaloBotTransport = fn;
}

export function setDiscordTransportForTesting(fn: DiscordTransportFn | null): void {
  customDiscordTransport = fn;
}

export function setZaloOAuthFetcherForTesting(fn: ZaloOAuthFetcherFn | null): void {
  customZaloOAuthFetcher = fn;
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
  includeMetaAds?: boolean;
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
      summary: params.includeMetaAds
        ? 'Báo cáo tổng hợp tình hình tiếp nhận Lead, tỷ lệ thiện chí, kết quả xử lý SLA và hiệu quả Meta Ads trong ngày.'
        : 'Báo cáo tổng hợp tình hình tiếp nhận Lead, tỷ lệ thiện chí & kết quả xử lý SLA trong ngày.',
      cta: 'Xem Báo cáo Chi tiết',
      rows: [
        { label: 'Tổng Lead tiếp nhận', value: '42 Lead (100% đã phân bổ)' },
        { label: 'Đã tiếp nhận đúng SLA', value: '39 / 42 (92.8%)' },
        { label: 'Thiện chí & Hẹn gặp', value: '24 Lead (57.1%)' },
        { label: 'Ticket bù lỗi', value: '2 đã duyệt • 0 tồn đọng' },
        ...(params.includeMetaAds
          ? [
              {
                label: 'Hiệu quả Meta Ads (Preview)',
                value: 'Chi tiêu 1,230,000₫ • Reach 19,000 • 27 Leads • 45 Tin nhắn • Cao điểm 20:00',
              },
            ]
          : []),
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

function isLoopbackHost(host: string): boolean {
  return isLocalLoopbackUrl(`http://${host}`);
}

const EMAIL_RECIPIENT_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function sanitizeEmailAddress(raw: unknown): string {
  return String(raw || '').replace(/[\r\n<>]/g, '').trim();
}

function sanitizeEmailDisplayName(raw: unknown): string {
  return String(raw || '')
    .replace(/[\r\n<>]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function parseEmailRecipientList(rawCc: unknown, excludeTo?: string): string[] {
  const excludeLow = sanitizeEmailAddress(excludeTo).toLowerCase();
  const seen = new Set<string>();
  const out: string[] = [];
  const parts = Array.isArray(rawCc) ? rawCc : String(rawCc || '').split(/[,;\s]+/);
  for (const part of parts) {
    const addr = sanitizeEmailAddress(part);
    if (!addr || !EMAIL_RECIPIENT_REGEX.test(addr)) continue;
    const low = addr.toLowerCase();
    if (excludeLow && low === excludeLow) continue;
    if (seen.has(low)) continue;
    seen.add(low);
    out.push(addr);
  }
  return out;
}

export function stripHtmlTagsForPlainText(input: string): string {
  return String(input || '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<\/?[a-zA-Z][^>]*>/g, '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .trim();
}

export function chunkTextForChat(text: string, maxChars = 1950): string[] {
  const clean = String(text || '').trim();
  if (!clean) return [];
  if (clean.length <= maxChars) return [clean];

  const chunks: string[] = [];
  let remaining = clean;
  while (remaining.length > maxChars) {
    let splitIdx = remaining.lastIndexOf('\n', maxChars);
    if (splitIdx < Math.floor(maxChars * 0.4)) {
      splitIdx = remaining.lastIndexOf(' ', maxChars);
    }
    if (splitIdx <= 0) {
      splitIdx = maxChars;
    }
    chunks.push(remaining.slice(0, splitIdx).trim());
    remaining = remaining.slice(splitIdx).trim();
  }
  if (remaining) chunks.push(remaining);
  return chunks.filter(Boolean);
}

function encodeMimeHeaderUtf8(text: string): string {
  return `=?UTF-8?B?${Buffer.from(text, 'utf8').toString('base64')}?=`;
}

function wrapBase64Lines(b64: string, width = 76): string {
  const lines: string[] = [];
  for (let i = 0; i < b64.length; i += width) {
    lines.push(b64.slice(i, i + width));
  }
  return lines.join('\r\n');
}

export async function sendRawSmtpMail(opts: {
  host: string;
  port: number;
  user?: string;
  pass?: string;
  fromEmail: string;
  fromName?: string;
  to: string;
  cc?: string;
  subject: string;
  text: string;
  html: string;
  messageId?: string;
  timeoutMs?: number;
}): Promise<{ accepted: boolean; messageId: string; headerMessageId?: string; error?: string }> {
  const host = opts.host.trim();
  const port = Number.isFinite(opts.port) && opts.port > 0 ? Math.round(opts.port) : 587;
  const timeoutMs = opts.timeoutMs ?? 15_000;
  const messageId = (opts.messageId || `msg_${crypto.randomBytes(8).toString('hex')}@autodata.vn`).replace(/^<|>$/g, '');
  const loopback = isLoopbackHost(host);
  const fromEmail = sanitizeEmailAddress(opts.fromEmail);
  const toEmail = sanitizeEmailAddress(opts.to);
  const ccList = parseEmailRecipientList(opts.cc, toEmail);
  const safeFromName = sanitizeEmailDisplayName(opts.fromName);

  return new Promise((resolve) => {
    let settled = false;
    let socket: net.Socket | tls.TLSSocket | null = null;
    let buffer = '';
    let pendingResolve: ((res: { code: number; lines: string[] }) => void) | null = null;
    let pendingReject: ((err: Error) => void) | null = null;
    let currentLines: string[] = [];

    const finish = (result: { accepted: boolean; messageId: string; headerMessageId?: string; error?: string }) => {
      if (settled) return;
      settled = true;
      try {
        socket?.destroy();
      } catch {}
      resolve(result);
    };

    const attachSocketHandlers = (sock: net.Socket | tls.TLSSocket) => {
      sock.setEncoding('utf8');
      sock.setTimeout(timeoutMs, () => {
        const err = new Error(`SMTP timeout after ${timeoutMs}ms (${host}:${port})`);
        pendingReject?.(err);
        finish({ accepted: false, messageId, error: err.message });
      });
      sock.on('error', (err) => {
        pendingReject?.(err);
        finish({ accepted: false, messageId, error: err.message || 'SMTP socket error' });
      });
      sock.on('close', () => {
        if (!settled && pendingReject) {
          pendingReject(new Error('SMTP connection closed unexpectedly'));
        }
      });
      sock.on('data', (chunk: string) => {
        buffer += chunk;
        let idx = buffer.indexOf('\n');
        while (idx !== -1) {
          const rawLine = buffer.slice(0, idx).replace(/\r$/, '');
          buffer = buffer.slice(idx + 1);
          if (/^\d{3}[- ]/.test(rawLine)) {
            currentLines.push(rawLine);
            if (rawLine[3] === ' ') {
              const code = Number(rawLine.slice(0, 3));
              const lines = currentLines;
              currentLines = [];
              const resFn = pendingResolve;
              pendingResolve = null;
              pendingReject = null;
              resFn?.({ code, lines });
            }
          }
          idx = buffer.indexOf('\n');
        }
      });
    };

    const readReply = (): Promise<{ code: number; lines: string[] }> =>
      new Promise((res, rej) => {
        pendingResolve = res;
        pendingReject = rej;
      });

    const sendCmd = async (cmd: string, expectedCodes: number[]): Promise<{ code: number; lines: string[] }> => {
      if (!socket) throw new Error('SMTP socket not initialized');
      const replyPromise = readReply();
      socket.write(`${cmd}\r\n`);
      const reply = await replyPromise;
      if (!expectedCodes.includes(reply.code)) {
        throw new Error(`SMTP ${cmd.split(' ')[0]} failed (${reply.code}): ${reply.lines.join(' | ')}`);
      }
      return reply;
    };

    (async () => {
      if (port === 465) {
        socket = tls.connect({ host, port, servername: host, rejectUnauthorized: !loopback });
      } else {
        socket = net.createConnection({ host, port });
      }
      attachSocketHandlers(socket);

      const greeting = await readReply();
      if (greeting.code !== 220) {
        throw new Error(`SMTP greeting rejected (${greeting.code}): ${greeting.lines.join(' | ')}`);
      }

      let ehlo = await sendCmd('EHLO autodata.local', [250]);
      const supportsStartTls = ehlo.lines.some((l) => /STARTTLS/i.test(l));

      if (port !== 465 && supportsStartTls) {
        await sendCmd('STARTTLS', [220]);
        const plainSock = socket;
        plainSock.removeAllListeners('data');
        plainSock.removeAllListeners('error');
        plainSock.removeAllListeners('close');
        plainSock.removeAllListeners('timeout');
        buffer = '';
        currentLines = [];

        const tlsSock = await new Promise<tls.TLSSocket>((res, rej) => {
          const upgraded = tls.connect(
            { socket: plainSock, servername: host, rejectUnauthorized: !loopback },
            () => res(upgraded)
          );
          upgraded.once('error', rej);
        });
        socket = tlsSock;
        attachSocketHandlers(socket);
        ehlo = await sendCmd('EHLO autodata.local', [250]);
      }

      if (opts.user && opts.pass) {
        const ehloJoined = ehlo.lines.join(' ').toUpperCase();
        if (ehloJoined.includes('AUTH') && ehloJoined.includes('PLAIN')) {
          const token = Buffer.from(`\0${opts.user}\0${opts.pass}`, 'utf8').toString('base64');
          await sendCmd(`AUTH PLAIN ${token}`, [235]);
        } else if (ehloJoined.includes('AUTH')) {
          await sendCmd('AUTH LOGIN', [334]);
          await sendCmd(Buffer.from(opts.user, 'utf8').toString('base64'), [334]);
          await sendCmd(Buffer.from(opts.pass, 'utf8').toString('base64'), [235]);
        }
      }

      await sendCmd(`MAIL FROM:<${fromEmail}>`, [250]);
      await sendCmd(`RCPT TO:<${toEmail}>`, [250, 251]);
      for (const ccAddr of ccList) {
        await sendCmd(`RCPT TO:<${ccAddr}>`, [250, 251]);
      }
      await sendCmd('DATA', [354]);

      const boundary = `=_dom_${crypto.randomBytes(8).toString('hex')}`;
      const fromHeader = safeFromName
        ? `${encodeMimeHeaderUtf8(safeFromName)} <${fromEmail}>`
        : `<${fromEmail}>`;

      const mimeLines = [
        `From: ${fromHeader}`,
        `To: <${toEmail}>`,
        ...(ccList.length > 0 ? [`Cc: ${ccList.join(', ')}`] : []),
        `Subject: ${encodeMimeHeaderUtf8(opts.subject)}`,
        `Date: ${new Date().toUTCString()}`,
        `Message-ID: <${messageId}>`,
        'MIME-Version: 1.0',
        `Content-Type: multipart/alternative; boundary="${boundary}"`,
        '',
        `--${boundary}`,
        'Content-Type: text/plain; charset=UTF-8',
        'Content-Transfer-Encoding: base64',
        '',
        wrapBase64Lines(Buffer.from(opts.text || '', 'utf8').toString('base64')),
        '',
        `--${boundary}`,
        'Content-Type: text/html; charset=UTF-8',
        'Content-Transfer-Encoding: base64',
        '',
        wrapBase64Lines(Buffer.from(opts.html || opts.text || '', 'utf8').toString('base64')),
        '',
        `--${boundary}--`,
      ];

      const stuffedBody = mimeLines
        .map((line) => (line.startsWith('.') ? `.${line}` : line))
        .join('\r\n');

      const dataReplyPromise = readReply();
      socket.write(`${stuffedBody}\r\n.\r\n`);
      const dataReply = await dataReplyPromise;
      if (dataReply.code !== 250) {
        throw new Error(`SMTP DATA rejected (${dataReply.code}): ${dataReply.lines.join(' | ')}`);
      }

      const sesOkLine = dataReply.lines
        .map((line) => line.match(/^250[- ]\s*Ok\s+([A-Za-z0-9-]+)$/i))
        .find(Boolean);
      const resolvedMessageId = sesOkLine?.[1] ? sesOkLine[1].trim() : messageId;

      try {
        await sendCmd('QUIT', [221]);
      } catch {
        // Ignore QUIT close race after 250 OK
      }
      finish({ accepted: true, messageId: resolvedMessageId, headerMessageId: messageId });
    })().catch((err: any) => {
      finish({ accepted: false, messageId, error: err?.message || 'SMTP dispatch failed' });
    });
  });
}

// ============================================================================
// High-Throughput Pooled SMTP Transporter Cache (maxConnections: 10, maxMessages: 200)
// & Keep-Alive HTTPS Agent for AWS SES v2 / Resend / SendGrid / Postmark
// ============================================================================
const sesKeepAliveAgent = new https.Agent({
  keepAlive: true,
  keepAliveMsecs: 30_000,
  maxSockets: 20,
  maxFreeSockets: 10,
});

async function postJsonKeepAlive(
  rawUrl: string,
  init: { method: string; headers: Record<string, string>; body: string },
  timeoutMs = 18_000
): Promise<{ ok: boolean; status: number; text: () => Promise<string>; headers: { get(k: string): string | null } }> {
  const parsed = new URL(rawUrl);
  if (parsed.protocol !== 'https:') {
    const r = await fetch(rawUrl, {
      ...init,
      redirect: 'follow',
      signal: AbortSignal.timeout(timeoutMs),
    });
    return r;
  }

  return new Promise((resolve, reject) => {
    const bodyBuf = Buffer.from(init.body || '', 'utf8');
    const req = https.request(
      {
        protocol: parsed.protocol,
        hostname: parsed.hostname,
        port: parsed.port ? Number(parsed.port) : 443,
        path: `${parsed.pathname}${parsed.search}`,
        method: init.method || 'POST',
        agent: sesKeepAliveAgent,
        headers: {
          ...init.headers,
          'Content-Length': String(bodyBuf.byteLength),
          Connection: 'keep-alive',
        },
        timeout: timeoutMs,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer | string) => chunks.push(typeof c === 'string' ? Buffer.from(c) : c));
        res.on('end', () => {
          const textBody = Buffer.concat(chunks).toString('utf8');
          const status = res.statusCode || 0;
          resolve({
            ok: status >= 200 && status < 300,
            status,
            async text() {
              return textBody;
            },
            headers: {
              get(k: string) {
                const v = res.headers[k.toLowerCase()];
                return Array.isArray(v) ? v.join(', ') : v ?? null;
              },
            },
          });
        });
      }
    );

    req.on('timeout', () => {
      req.destroy(new Error(`HTTPS keep-alive request timeout after ${timeoutMs}ms (${parsed.hostname})`));
    });
    req.on('error', reject);
    req.write(bodyBuf);
    req.end();
  });
}

interface PooledSmtpSendOpts {
  host: string;
  port: number;
  user?: string;
  pass?: string;
  fromEmail: string;
  fromName?: string;
  to: string;
  cc?: string;
  subject: string;
  text: string;
  html: string;
  messageId?: string;
  timeoutMs?: number;
}

class PooledSmtpSession {
  private socket: net.Socket | tls.TLSSocket | null = null;
  private buffer = '';
  private currentLines: string[] = [];
  private pendingResolve: ((res: { code: number; lines: string[] }) => void) | null = null;
  private pendingReject: ((err: Error) => void) | null = null;
  public closed = false;
  public messagesSent = 0;
  public lastUsedAt = Date.now();
  private readonly host: string;
  private readonly port: number;
  private readonly user?: string;
  private readonly pass?: string;
  private readonly timeoutMs: number;

  constructor(opts: { host: string; port: number; user?: string; pass?: string; timeoutMs?: number }) {
    this.host = opts.host.trim();
    this.port = Number.isFinite(opts.port) && opts.port > 0 ? Math.round(opts.port) : 587;
    this.user = opts.user;
    this.pass = opts.pass;
    this.timeoutMs = opts.timeoutMs ?? 15_000;
  }

  private attachSocket(sock: net.Socket | tls.TLSSocket): void {
    sock.setEncoding('utf8');
    sock.setTimeout(this.timeoutMs, () => {
      const err = new Error(`SMTP pool timeout after ${this.timeoutMs}ms (${this.host}:${this.port})`);
      this.failPending(err);
      this.destroy();
    });
    sock.on('error', (err) => {
      this.failPending(err);
      this.destroy();
    });
    sock.on('close', () => {
      this.closed = true;
      this.failPending(new Error('SMTP pooled connection closed'));
    });
    sock.on('data', (chunk: string) => {
      this.buffer += chunk;
      let idx = this.buffer.indexOf('\n');
      while (idx !== -1) {
        const rawLine = this.buffer.slice(0, idx).replace(/\r$/, '');
        this.buffer = this.buffer.slice(idx + 1);
        if (/^\d{3}[- ]/.test(rawLine)) {
          this.currentLines.push(rawLine);
          if (rawLine[3] === ' ') {
            const code = Number(rawLine.slice(0, 3));
            const lines = this.currentLines;
            this.currentLines = [];
            const resFn = this.pendingResolve;
            this.pendingResolve = null;
            this.pendingReject = null;
            resFn?.({ code, lines });
          }
        }
        idx = this.buffer.indexOf('\n');
      }
    });
  }

  private failPending(err: Error): void {
    const rej = this.pendingReject;
    this.pendingResolve = null;
    this.pendingReject = null;
    rej?.(err);
  }

  private readReply(): Promise<{ code: number; lines: string[] }> {
    if (this.closed || !this.socket || this.socket.destroyed) {
      return Promise.reject(new Error('SMTP pooled socket closed'));
    }
    return new Promise((res, rej) => {
      this.pendingResolve = res;
      this.pendingReject = rej;
    });
  }

  private async sendCmd(cmd: string, expectedCodes: number[]): Promise<{ code: number; lines: string[] }> {
    if (!this.socket || this.closed || this.socket.destroyed) {
      throw new Error('SMTP pooled socket not connected');
    }
    const p = this.readReply();
    this.socket.write(`${cmd}\r\n`);
    const reply = await p;
    if (!expectedCodes.includes(reply.code)) {
      throw new Error(`SMTP ${cmd.split(' ')[0]} failed (${reply.code}): ${reply.lines.join(' | ')}`);
    }
    return reply;
  }

  async connect(): Promise<void> {
    const loopback = isLoopbackHost(this.host);
    this.socket =
      this.port === 465
        ? tls.connect({ host: this.host, port: this.port, servername: this.host, rejectUnauthorized: !loopback })
        : net.createConnection({ host: this.host, port: this.port });
    this.attachSocket(this.socket);

    const greeting = await this.readReply();
    if (greeting.code !== 220) {
      throw new Error(`SMTP greeting rejected (${greeting.code}): ${greeting.lines.join(' | ')}`);
    }

    let ehlo = await this.sendCmd('EHLO autodata.local', [250]);
    const supportsStartTls = ehlo.lines.some((l) => /STARTTLS/i.test(l));
    if (this.port !== 465 && supportsStartTls) {
      await this.sendCmd('STARTTLS', [220]);
      const plainSock = this.socket;
      plainSock.removeAllListeners('data');
      plainSock.removeAllListeners('error');
      plainSock.removeAllListeners('close');
      plainSock.removeAllListeners('timeout');
      this.buffer = '';
      this.currentLines = [];

      const tlsSock = await new Promise<tls.TLSSocket>((res, rej) => {
        const upgraded = tls.connect(
          { socket: plainSock, servername: this.host, rejectUnauthorized: !loopback },
          () => res(upgraded)
        );
        upgraded.once('error', rej);
      });
      this.socket = tlsSock;
      this.attachSocket(this.socket);
      ehlo = await this.sendCmd('EHLO autodata.local', [250]);
    }

    if (this.user && this.pass) {
      const ehloJoined = ehlo.lines.join(' ').toUpperCase();
      if (ehloJoined.includes('AUTH') && ehloJoined.includes('PLAIN')) {
        const token = Buffer.from(`\0${this.user}\0${this.pass}`, 'utf8').toString('base64');
        await this.sendCmd(`AUTH PLAIN ${token}`, [235]);
      } else if (ehloJoined.includes('AUTH')) {
        await this.sendCmd('AUTH LOGIN', [334]);
        await this.sendCmd(Buffer.from(this.user, 'utf8').toString('base64'), [334]);
        await this.sendCmd(Buffer.from(this.pass, 'utf8').toString('base64'), [235]);
      }
    }
    this.lastUsedAt = Date.now();
  }

  async sendMessage(opts: PooledSmtpSendOpts): Promise<{ accepted: boolean; messageId: string; headerMessageId?: string }> {
    if (!this.socket || this.closed || this.socket.destroyed) {
      throw new Error('SMTP pooled socket closed');
    }
    this.socket.ref?.();
    const messageId = (opts.messageId || `msg_${crypto.randomBytes(8).toString('hex')}@autodata.vn`).replace(/^<|>$/g, '');
    const fromEmail = sanitizeEmailAddress(opts.fromEmail);
    const toEmail = sanitizeEmailAddress(opts.to);
    const ccList = parseEmailRecipientList(opts.cc, toEmail);
    const safeFromName = sanitizeEmailDisplayName(opts.fromName);

    if (this.messagesSent > 0) {
      await this.sendCmd('RSET', [250]);
    }
    await this.sendCmd(`MAIL FROM:<${fromEmail}>`, [250]);
    await this.sendCmd(`RCPT TO:<${toEmail}>`, [250, 251]);
    for (const ccAddr of ccList) {
      await this.sendCmd(`RCPT TO:<${ccAddr}>`, [250, 251]);
    }
    await this.sendCmd('DATA', [354]);

    const boundary = `=_dom_${crypto.randomBytes(8).toString('hex')}`;
    const fromHeader = safeFromName ? `${encodeMimeHeaderUtf8(safeFromName)} <${fromEmail}>` : `<${fromEmail}>`;
    const mimeLines = [
      `From: ${fromHeader}`,
      `To: <${toEmail}>`,
      ...(ccList.length > 0 ? [`Cc: ${ccList.join(', ')}`] : []),
      `Subject: ${encodeMimeHeaderUtf8(opts.subject)}`,
      `Date: ${new Date().toUTCString()}`,
      `Message-ID: <${messageId}>`,
      'MIME-Version: 1.0',
      `Content-Type: multipart/alternative; boundary="${boundary}"`,
      '',
      `--${boundary}`,
      'Content-Type: text/plain; charset=UTF-8',
      'Content-Transfer-Encoding: base64',
      '',
      wrapBase64Lines(Buffer.from(opts.text || '', 'utf8').toString('base64')),
      '',
      `--${boundary}`,
      'Content-Type: text/html; charset=UTF-8',
      'Content-Transfer-Encoding: base64',
      '',
      wrapBase64Lines(Buffer.from(opts.html || opts.text || '', 'utf8').toString('base64')),
      '',
      `--${boundary}--`,
    ];
    const stuffedBody = mimeLines.map((line) => (line.startsWith('.') ? `.${line}` : line)).join('\r\n');
    const dataReplyPromise = this.readReply();
    this.socket.write(`${stuffedBody}\r\n.\r\n`);
    const dataReply = await dataReplyPromise;
    if (dataReply.code !== 250) {
      throw new Error(`SMTP DATA rejected (${dataReply.code}): ${dataReply.lines.join(' | ')}`);
    }

    const sesOkLine = dataReply.lines
      .map((line) => line.match(/^250[- ]\s*Ok\s+([A-Za-z0-9-]+)$/i))
      .find(Boolean);
    const resolvedMessageId = sesOkLine?.[1] ? sesOkLine[1].trim() : messageId;

    this.messagesSent++;
    this.lastUsedAt = Date.now();
    this.socket.unref?.();
    return { accepted: true, messageId: resolvedMessageId, headerMessageId: messageId };
  }

  async quitAndDestroy(): Promise<void> {
    if (!this.closed && this.socket && !this.socket.destroyed) {
      try {
        await this.sendCmd('QUIT', [221]);
      } catch {
        // Ignore close race
      }
    }
    this.destroy();
  }

  destroy(): void {
    this.closed = true;
    try {
      this.socket?.destroy();
    } catch {}
    this.socket = null;
  }
}

class SmtpConnectionPool {
  public readonly maxConnections: number;
  public readonly maxMessages: number;
  private readonly idleTimeoutMs: number;
  private readonly host: string;
  private readonly port: number;
  private readonly user?: string;
  private readonly pass?: string;
  private idle: PooledSmtpSession[] = [];
  private activeCount = 0;
  private waiters: Array<(sess: PooledSmtpSession | null) => void> = [];
  private sweepTimer: ReturnType<typeof setInterval> | null = null;
  public totalReused = 0;
  public totalCreated = 0;

  constructor(opts: {
    host: string;
    port: number;
    user?: string;
    pass?: string;
    maxConnections?: number;
    maxMessages?: number;
    idleTimeoutMs?: number;
  }) {
    this.host = opts.host;
    this.port = opts.port;
    this.user = opts.user;
    this.pass = opts.pass;
    this.maxConnections = Math.max(1, Math.min(20, opts.maxConnections ?? 10));
    this.maxMessages = Math.max(1, opts.maxMessages ?? 200);
    this.idleTimeoutMs = opts.idleTimeoutMs ?? 45_000;
    this.sweepTimer = setInterval(() => this.sweepIdle(), 15_000);
    this.sweepTimer.unref?.();
  }

  private sweepIdle(): void {
    const cutoff = Date.now() - this.idleTimeoutMs;
    const kept: PooledSmtpSession[] = [];
    for (const s of this.idle) {
      if (s.closed || s.lastUsedAt < cutoff) {
        s.destroy();
      } else {
        kept.push(s);
      }
    }
    this.idle = kept;
  }

  private async acquire(): Promise<{ session: PooledSmtpSession; reused: boolean }> {
    while (this.idle.length > 0) {
      const candidate = this.idle.pop()!;
      if (!candidate.closed && candidate.messagesSent < this.maxMessages) {
        this.activeCount++;
        this.totalReused++;
        return { session: candidate, reused: true };
      }
      candidate.destroy();
    }

    if (this.activeCount < this.maxConnections) {
      this.activeCount++;
      this.totalCreated++;
      const sess = new PooledSmtpSession({
        host: this.host,
        port: this.port,
        user: this.user,
        pass: this.pass,
      });
      try {
        await sess.connect();
        return { session: sess, reused: false };
      } catch (err) {
        this.activeCount = Math.max(0, this.activeCount - 1);
        sess.destroy();
        this.wakeNextWaiter();
        throw err;
      }
    }

    const handed = await new Promise<PooledSmtpSession | null>((resolve) => {
      this.waiters.push(resolve);
    });
    if (handed && !handed.closed && handed.messagesSent < this.maxMessages) {
      this.totalReused++;
      return { session: handed, reused: true };
    }
    handed?.destroy();
    return this.acquire();
  }

  private wakeNextWaiter(): void {
    const next = this.waiters.shift();
    if (next) next(null);
  }

  private release(sess: PooledSmtpSession, broken: boolean): void {
    if (broken || sess.closed || sess.messagesSent >= this.maxMessages) {
      this.activeCount = Math.max(0, this.activeCount - 1);
      if (sess.messagesSent >= this.maxMessages && !broken && !sess.closed) {
        void sess.quitAndDestroy();
      } else {
        sess.destroy();
      }
      this.wakeNextWaiter();
      return;
    }

    const nextWaiter = this.waiters.shift();
    if (nextWaiter) {
      nextWaiter(sess);
      return;
    }
    this.activeCount = Math.max(0, this.activeCount - 1);
    this.idle.push(sess);
  }

  async send(opts: PooledSmtpSendOpts): Promise<{ accepted: boolean; messageId: string; headerMessageId?: string; error?: string }> {
    const fallbackId = (opts.messageId || `msg_${crypto.randomBytes(8).toString('hex')}@autodata.vn`).replace(/^<|>$/g, '');
    for (let attempt = 0; attempt < 2; attempt++) {
      let acquired: { session: PooledSmtpSession; reused: boolean } | null = null;
      try {
        acquired = await this.acquire();
        const res = await acquired.session.sendMessage(opts);
        this.release(acquired.session, false);
        return res;
      } catch (err: any) {
        if (acquired) {
          this.release(acquired.session, true);
        }
        // Retry once transparently if a reused idle connection was closed by remote peer
        if (attempt === 0 && acquired?.reused) {
          continue;
        }
        return { accepted: false, messageId: fallbackId, error: err?.message || 'SMTP pooled dispatch failed' };
      }
    }
    return { accepted: false, messageId: fallbackId, error: 'SMTP pooled dispatch failed' };
  }

  close(): void {
    if (this.sweepTimer) {
      clearInterval(this.sweepTimer);
      this.sweepTimer = null;
    }
    for (const s of this.idle) s.destroy();
    this.idle = [];
    while (this.waiters.length > 0) {
      const w = this.waiters.shift();
      w?.(null);
    }
  }
}

const smtpPoolCache = new Map<string, SmtpConnectionPool>();

function getOrCreateSmtpPool(opts: { host: string; port: number; user?: string; pass?: string }): SmtpConnectionPool {
  const passHash = opts.pass ? sha256Hex(opts.pass).slice(0, 12) : 'nopass';
  const key = `${opts.host.trim().toLowerCase()}:${opts.port}:${opts.user || ''}:${passHash}`;
  let pool = smtpPoolCache.get(key);
  if (!pool) {
    pool = new SmtpConnectionPool({
      host: opts.host,
      port: opts.port,
      user: opts.user,
      pass: opts.pass,
      maxConnections: 10,
      maxMessages: 200,
    });
    smtpPoolCache.set(key, pool);
  }
  return pool;
}

export async function sendPooledSmtpMail(
  opts: PooledSmtpSendOpts
): Promise<{ accepted: boolean; messageId: string; headerMessageId?: string; error?: string }> {
  const pool = getOrCreateSmtpPool({
    host: opts.host,
    port: Number.isFinite(opts.port) && opts.port > 0 ? Math.round(opts.port) : 587,
    user: opts.user,
    pass: opts.pass,
  });
  return pool.send(opts);
}

export function closeSmtpConnectionPools(): void {
  for (const pool of smtpPoolCache.values()) {
    pool.close();
  }
  smtpPoolCache.clear();
}

export function getSmtpPoolStats(): Array<{ key: string; maxConnections: number; maxMessages: number; totalCreated: number; totalReused: number }> {
  return Array.from(smtpPoolCache.entries()).map(([key, pool]) => ({
    key,
    maxConnections: pool.maxConnections,
    maxMessages: pool.maxMessages,
    totalCreated: pool.totalCreated,
    totalReused: pool.totalReused,
  }));
}

/**
 * Loads decrypted email channel vault rows & tenant settings ONCE (Phase 1) so Phase 2
 * concurrent high-speed campaign workers dispatch with ZERO per-email DB queries.
 */
export async function loadEmailTenantStateForCampaign(
  client: DbClient,
  tenantId: string
): Promise<PreloadedEmailTenantState> {
  type VaultRow = { integration_type: string; status: string; config_encrypted: string; iv: string; auth_tag: string };
  const [intRes, tRes] = await Promise.all([
    client.query<VaultRow>(
      `SELECT integration_type, status, config_encrypted, iv, auth_tag
       FROM tenant_integrations
       WHERE tenant_id = $1 AND integration_type IN ('smtp', 'aws_ses', 'resend', 'sendgrid', 'postmark') AND status = 'active'
       ORDER BY updated_at DESC`,
      [tenantId]
    ),
    client.query<{ name: string; slug: string; settings: Record<string, any> }>(
      'SELECT name, slug, settings FROM tenants WHERE id = $1 LIMIT 1',
      [tenantId]
    ),
  ]);

  const decryptByType = (type: string): { has: boolean; cfg: SmtpIntegrationConfig } => {
    const row = intRes.rows.find((r) => r.integration_type === type);
    if (!row) return { has: false, cfg: {} };
    try {
      return {
        has: true,
        cfg: decryptTenantSecret<SmtpIntegrationConfig>(tenantId, row.config_encrypted, row.iv, row.auth_tag) || {},
      };
    } catch {
      return { has: false, cfg: {} };
    }
  };

  const smtp = decryptByType('smtp');
  const ses = decryptByType('aws_ses');
  const resend = decryptByType('resend');
  const sendgrid = decryptByType('sendgrid');
  const postmark = decryptByType('postmark');
  const rawRow = tRes.rows[0] || { name: 'DOMATION AutoData', slug: '', settings: {} };

  return {
    tenantId,
    smtpCfg: smtp.cfg,
    hasSmtpVault: smtp.has,
    sesCfg: ses.cfg,
    hasSesVault: ses.has,
    resendCfg: resend.cfg,
    hasResendVault: resend.has,
    sendgridCfg: sendgrid.cfg,
    hasSendgridVault: sendgrid.has,
    postmarkCfg: postmark.cfg,
    hasPostmarkVault: postmark.has,
    rawRow,
    tenantCfg: normalizeTenantSettings(rawRow.settings || {}),
  };
}

function hmacSha256(key: Buffer | string, data: string): Buffer {
  return crypto.createHmac('sha256', key).update(data, 'utf8').digest();
}

function sha256Hex(data: string): string {
  return crypto.createHash('sha256').update(data, 'utf8').digest('hex');
}

function signAwsSigV4Headers(params: {
  method: string;
  host: string;
  path: string;
  region: string;
  service: string;
  accessKeyId: string;
  secretAccessKey: string;
  payload: string;
  contentType: string;
}): Record<string, string> {
  const now = new Date();
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, '');
  const dateStamp = amzDate.slice(0, 8);
  const payloadHash = sha256Hex(params.payload);

  const canonicalHeaders =
    `content-type:${params.contentType}\n` +
    `host:${params.host}\n` +
    `x-amz-content-sha256:${payloadHash}\n` +
    `x-amz-date:${amzDate}\n`;
  const signedHeaders = 'content-type;host;x-amz-content-sha256;x-amz-date';

  const canonicalRequest = [
    params.method.toUpperCase(),
    params.path,
    '',
    canonicalHeaders,
    signedHeaders,
    payloadHash,
  ].join('\n');

  const credentialScope = `${dateStamp}/${params.region}/${params.service}/aws4_request`;
  const stringToSign = [
    'AWS4-HMAC-SHA256',
    amzDate,
    credentialScope,
    sha256Hex(canonicalRequest),
  ].join('\n');

  const kDate = hmacSha256(`AWS4${params.secretAccessKey}`, dateStamp);
  const kRegion = hmacSha256(kDate, params.region);
  const kService = hmacSha256(kRegion, params.service);
  const kSigning = hmacSha256(kService, 'aws4_request');
  const signature = hmacSha256(kSigning, stringToSign).toString('hex');

  return {
    'Content-Type': params.contentType,
    'X-Amz-Date': amzDate,
    'X-Amz-Content-Sha256': payloadHash,
    Authorization: `AWS4-HMAC-SHA256 Credential=${params.accessKeyId}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
  };
}

/**
 * Dispatches an operational, assignment, ticket, report, or SLA alert email using the tenant's
 * configured Google Apps Script Web App, Resend API, SMTP, or AWS SES driver.
 */
export async function sendTenantEmailNotification(input: EmailDispatchMessage): Promise<EmailDispatchResult | null> {
  type VaultIntegrationRow = { integration_type?: string; status: string; config_encrypted: string; iv: string; auth_tag: string };

  let hasSmtpVault = false;
  let hasSesVault = false;
  let hasResendVault = false;
  let hasSendgridVault = false;
  let hasPostmarkVault = false;
  let cfg: SmtpIntegrationConfig = {};
  let sesCfg: SmtpIntegrationConfig = {};
  let resendCfg: SmtpIntegrationConfig = {};
  let sendgridCfg: SmtpIntegrationConfig = {};
  let postmarkCfg: SmtpIntegrationConfig = {};
  let rawRow: { name: string; slug: string; settings: Record<string, any> };
  let tenantCfg: ReturnType<typeof normalizeTenantSettings>;

  if (input.preloadedState) {
    const st = input.preloadedState;
    cfg = st.smtpCfg;
    hasSmtpVault = st.hasSmtpVault;
    sesCfg = st.sesCfg;
    hasSesVault = st.hasSesVault;
    resendCfg = st.resendCfg;
    hasResendVault = st.hasResendVault;
    sendgridCfg = st.sendgridCfg;
    hasSendgridVault = st.hasSendgridVault;
    postmarkCfg = st.postmarkCfg;
    hasPostmarkVault = st.hasPostmarkVault;
    rawRow = st.rawRow;
    tenantCfg = st.tenantCfg;
  } else if (input.client) {
    const st = await loadEmailTenantStateForCampaign(input.client, input.tenantId);
    cfg = st.smtpCfg;
    hasSmtpVault = st.hasSmtpVault;
    sesCfg = st.sesCfg;
    hasSesVault = st.hasSesVault;
    resendCfg = st.resendCfg;
    hasResendVault = st.hasResendVault;
    sendgridCfg = st.sendgridCfg;
    hasSendgridVault = st.hasSendgridVault;
    postmarkCfg = st.postmarkCfg;
    hasPostmarkVault = st.hasPostmarkVault;
    rawRow = st.rawRow;
    tenantCfg = st.tenantCfg;
  } else {
    const cachedBatch = await getTenantIntegrationsBatchCached(input.tenantId, [
      'smtp',
      'aws_ses',
      'resend',
      'sendgrid',
      'postmark',
    ]);
    const decryptRow = (r: VaultIntegrationRow | null | undefined): { has: boolean; cfg: SmtpIntegrationConfig } => {
      if (!r || r.status !== 'active') return { has: false, cfg: {} };
      try {
        return {
          has: true,
          cfg: decryptTenantSecret<SmtpIntegrationConfig>(input.tenantId, r.config_encrypted, r.iv, r.auth_tag) || {},
        };
      } catch {
        return { has: false, cfg: {} };
      }
    };
    const smtp = decryptRow(cachedBatch.smtp);
    const ses = decryptRow(cachedBatch.aws_ses);
    const resend = decryptRow(cachedBatch.resend);
    const sendgrid = decryptRow(cachedBatch.sendgrid);
    const postmark = decryptRow(cachedBatch.postmark);
    cfg = smtp.cfg;
    hasSmtpVault = smtp.has;
    sesCfg = ses.cfg;
    hasSesVault = ses.has;
    resendCfg = resend.cfg;
    hasResendVault = resend.has;
    sendgridCfg = sendgrid.cfg;
    hasSendgridVault = sendgrid.has;
    postmarkCfg = postmark.cfg;
    hasPostmarkVault = postmark.has;

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

  const rawSettings = rawRow.settings || {};
  const appscriptUrl = (input.overrideWebhookUrl || rawSettings.appscript_webhook_url || '').trim();
  const appscriptSecret = (input.overrideSecret !== undefined ? input.overrideSecret : rawSettings.appscript_secret || '').trim();
  const resendApiKey = (
    input.overrideProvider === 'resend' && input.overrideSecret !== undefined
      ? input.overrideSecret
      : resendCfg.apiKey || resendCfg.api_key || rawSettings.resend_api_key || process.env.RESEND_API_KEY || ''
  ).trim();
  const sendgridApiKey = (
    input.overrideProvider === 'sendgrid' && input.overrideSecret !== undefined
      ? input.overrideSecret
      : sendgridCfg.apiKey || sendgridCfg.api_key || rawSettings.sendgrid_api_key || ''
  ).trim();
  const postmarkToken = (
    input.overrideProvider === 'postmark' && input.overrideSecret !== undefined
      ? input.overrideSecret
      : postmarkCfg.server_token || postmarkCfg.serverToken || postmarkCfg.apiKey || postmarkCfg.api_key || rawSettings.postmark_api_key || rawSettings.postmark_server_token || ''
  ).trim();

  const rawExplicitProvider = String(input.overrideProvider || rawSettings.email_provider || '')
    .trim()
    .toLowerCase();
  const explicitProvider =
    rawExplicitProvider === 'aws_ses'
      ? 'ses'
      : input.disallowAppscript && rawExplicitProvider === 'appscript'
        ? ''
        : rawExplicitProvider;

  let provider: EmailProvider;
  if (
    explicitProvider === 'resend' ||
    explicitProvider === 'ses' ||
    explicitProvider === 'smtp' ||
    explicitProvider === 'sendgrid' ||
    explicitProvider === 'postmark' ||
    (!input.disallowAppscript && explicitProvider === 'appscript')
  ) {
    provider = explicitProvider;
  } else if (hasSesVault) {
    provider = 'ses';
  } else if (hasSmtpVault) {
    provider = 'smtp';
  } else if (hasResendVault || rawSettings.resend_api_key) {
    provider = 'resend';
  } else if (hasSendgridVault || rawSettings.sendgrid_api_key) {
    provider = 'sendgrid';
  } else if (hasPostmarkVault || rawSettings.postmark_api_key || rawSettings.postmark_server_token) {
    provider = 'postmark';
  } else if (!input.disallowAppscript && appscriptUrl) {
    provider = 'appscript';
  } else {
    provider = 'smtp';
  }

  const recipient = sanitizeEmailAddress(
    input.to ||
      rawSettings.fallback_cc_email ||
      cfg.notify_email ||
      sesCfg.notify_email ||
      cfg.smtp_user ||
      cfg.user ||
      ''
  );
  if (!recipient) {
    return null;
  }

  const brandName = resolveTenantBrandName(tenantCfg, { name: rawRow.name, slug: rawRow.slug, rawSettings });
  const fromName = sanitizeEmailDisplayName(
    input.fromNameOverride ||
      rawSettings.ses_sender_name ||
      cfg.from_name ||
      sesCfg.from_name ||
      resendCfg.from_name ||
      sendgridCfg.from_name ||
      postmarkCfg.from_name ||
      brandName ||
      'DOMATION AutoData'
  );
  const sesRegion = (
    sesCfg.sesRegion ||
    sesCfg.region ||
    sesCfg.aws_region ||
    rawSettings.ses_region ||
    process.env.AWS_REGION ||
    'ap-southeast-1'
  ).trim();
  const smtpHost =
    provider === 'appscript'
      ? 'script.google.com'
      : provider === 'resend'
        ? 'api.resend.com'
        : provider === 'sendgrid'
          ? 'api.sendgrid.com'
          : provider === 'postmark'
            ? 'api.postmarkapp.com'
            : provider === 'ses'
              ? (sesCfg.smtp_host || sesCfg.host || rawSettings.ses_host || '').trim() || `email.${sesRegion}.amazonaws.com`
              : (cfg.smtp_host || cfg.host || rawSettings.ses_host || tenantCfg.default_smtp_host || '').trim() ||
                'smtp.gmail.com';
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
  let headerMessageId: string | undefined;
  let accepted = false;
  let remainingQuota: number | null = null;
  let sheetLogged = false;
  let errMsg: string | undefined;

  const fetcher: EmailWebhookFetcherFn =
    customEmailWebhookFetcher ||
    (async (u, init) => {
      if (u.startsWith('https://')) {
        return postJsonKeepAlive(u, init, 18_000);
      }
      const r = await fetch(u, {
        ...init,
        redirect: 'follow',
        signal: AbortSignal.timeout(18_000),
      });
      return r;
    });

  if (customSmtpTransport) {
    const out = await customSmtpTransport(hasSesVault && !hasSmtpVault ? sesCfg : cfg, {
      to: recipient,
      subject: input.subject,
      text: input.text,
      html: renderedHtml,
      fromName,
      cc: input.cc || rawSettings.fallback_cc_email,
    });
    accepted = out.accepted;
    messageId = out.messageId;
  } else if (provider === 'appscript' && !input.disallowAppscript) {
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
      cc: parseEmailRecipientList(input.cc || rawSettings.fallback_cc_email, recipient).join(', '),
      from_name: fromName,
      subject: input.subject,
      text: input.text,
      html: renderedHtml,
      htmlBody: renderedHtml,
      meta: input.meta || {},
    });

    try {
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
  } else if (provider === 'resend') {
    if (!resendApiKey) {
      return {
        sent: false,
        messageId,
        recipient,
        smtpHost: 'api.resend.com',
        provider: 'resend',
        category,
        error: 'Chưa cấu hình Resend API Key.',
      };
    }

    if (isEmailSilentBlocked()) {
      return {
        sent: true,
        messageId,
        recipient,
        smtpHost: 'api.resend.com',
        provider: 'silent_guard',
        category,
      };
    }

    const fromEmail = sanitizeEmailAddress(
      input.fromEmailOverride ||
        resendCfg.from_email ||
        resendCfg.fromEmail ||
        resendCfg.sender_email ||
        rawSettings.resend_from_email ||
        rawSettings.ses_sender_email ||
        cfg.from_email ||
        cfg.notify_email ||
        tenantCfg.support_email ||
        'onboarding@resend.dev'
    );

    try {
      const ccList = parseEmailRecipientList(input.cc || rawSettings.fallback_cc_email, recipient);
      const resendBody: Record<string, unknown> = {
        from: `${fromName} <${fromEmail}>`,
        to: [recipient],
        ...(ccList.length > 0 ? { cc: ccList } : {}),
        subject: input.subject,
        html: renderedHtml,
        text: input.text,
      };
      const resp = await fetcher('https://api.resend.com/emails', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${resendApiKey}`,
        },
        body: JSON.stringify(resendBody),
      });
      const rawText = await resp.text();
      let parsed: any = null;
      try {
        parsed = JSON.parse(rawText);
      } catch {
        parsed = null;
      }
      if (!resp.ok) {
        accepted = false;
        errMsg = parsed?.message || parsed?.error || `Resend API trả về lỗi HTTP ${resp.status}`;
      } else {
        accepted = true;
        if (parsed?.id) messageId = String(parsed.id);
      }
    } catch (err: any) {
      accepted = false;
      errMsg = err?.message || 'Không thể kết nối tới Resend Email API.';
    }
  } else if (provider === 'sendgrid') {
    if (!sendgridApiKey) {
      return {
        sent: false,
        messageId,
        recipient,
        smtpHost: 'api.sendgrid.com',
        provider: 'sendgrid',
        category,
        error: 'Chưa cấu hình SendGrid API Key.',
      };
    }

    if (isEmailSilentBlocked()) {
      return {
        sent: true,
        messageId,
        recipient,
        smtpHost: 'api.sendgrid.com',
        provider: 'silent_guard',
        category,
      };
    }

    const fromEmail = sanitizeEmailAddress(
      input.fromEmailOverride ||
        sendgridCfg.from_email ||
        sendgridCfg.fromEmail ||
        sendgridCfg.sender_email ||
        rawSettings.ses_sender_email ||
        tenantCfg.support_email ||
        ''
    );
    if (!fromEmail) {
      return {
        sent: false,
        messageId,
        recipient,
        smtpHost: 'api.sendgrid.com',
        provider: 'sendgrid',
        category,
        error: 'Chưa cấu hình địa chỉ Email người gửi (From) cho SendGrid.',
      };
    }

    try {
      const ccList = parseEmailRecipientList(input.cc || rawSettings.fallback_cc_email, recipient);
      const sgPayload = {
        personalizations: [
          {
            to: [{ email: recipient }],
            ...(ccList.length > 0 ? { cc: ccList.map((e) => ({ email: e })) } : {}),
            subject: input.subject,
          },
        ],
        from: { email: fromEmail, name: fromName },
        content: [
          { type: 'text/plain', value: input.text || input.subject },
          { type: 'text/html', value: renderedHtml },
        ],
      };
      const resp = await fetcher('https://api.sendgrid.com/v3/mail/send', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${sendgridApiKey}`,
        },
        body: JSON.stringify(sgPayload),
      });
      if (!resp.ok) {
        const rawText = await resp.text().catch(() => '');
        accepted = false;
        errMsg = rawText.slice(0, 240) || `SendGrid API trả về lỗi HTTP ${resp.status}`;
      } else {
        accepted = true;
        const sgMsgId = resp.headers?.get('x-message-id');
        if (sgMsgId) messageId = sgMsgId.trim();
      }
    } catch (err: any) {
      accepted = false;
      errMsg = err?.message || 'Không thể kết nối tới SendGrid Email API.';
    }
  } else if (provider === 'postmark') {
    if (!postmarkToken) {
      return {
        sent: false,
        messageId,
        recipient,
        smtpHost: 'api.postmarkapp.com',
        provider: 'postmark',
        category,
        error: 'Chưa cấu hình Postmark Server Token.',
      };
    }

    if (isEmailSilentBlocked()) {
      return {
        sent: true,
        messageId,
        recipient,
        smtpHost: 'api.postmarkapp.com',
        provider: 'silent_guard',
        category,
      };
    }

    const fromEmail = sanitizeEmailAddress(
      input.fromEmailOverride ||
        postmarkCfg.from_email ||
        postmarkCfg.fromEmail ||
        postmarkCfg.sender_email ||
        rawSettings.ses_sender_email ||
        tenantCfg.support_email ||
        ''
    );
    if (!fromEmail) {
      return {
        sent: false,
        messageId,
        recipient,
        smtpHost: 'api.postmarkapp.com',
        provider: 'postmark',
        category,
        error: 'Chưa cấu hình địa chỉ Email người gửi (From) cho Postmark.',
      };
    }

    try {
      const ccList = parseEmailRecipientList(input.cc || rawSettings.fallback_cc_email, recipient);
      const pmPayload: Record<string, unknown> = {
        From: `${fromName} <${fromEmail}>`,
        To: recipient,
        ...(ccList.length > 0 ? { Cc: ccList.join(', ') } : {}),
        Subject: input.subject,
        HtmlBody: renderedHtml,
        TextBody: input.text || input.subject,
      };
      const resp = await fetcher('https://api.postmarkapp.com/email', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json',
          'X-Postmark-Server-Token': postmarkToken,
        },
        body: JSON.stringify(pmPayload),
      });
      const rawText = await resp.text().catch(() => '');
      let parsed: any = null;
      try {
        parsed = JSON.parse(rawText);
      } catch {
        parsed = null;
      }
      if (!resp.ok || (parsed && parsed.ErrorCode && parsed.ErrorCode !== 0)) {
        accepted = false;
        errMsg = parsed?.Message || `Postmark API trả về lỗi HTTP ${resp.status}`;
      } else {
        accepted = true;
        if (parsed?.MessageID) messageId = String(parsed.MessageID);
      }
    } catch (err: any) {
      accepted = false;
      errMsg = err?.message || 'Không thể kết nối tới Postmark API.';
    }
  } else if (provider === 'ses') {
    const sesSmtpHost = (sesCfg.smtp_host || sesCfg.host || rawSettings.ses_host || '').trim();
    const sesSmtpUser = (sesCfg.smtp_user || sesCfg.user || rawSettings.ses_username || '').trim();
    const sesSmtpPass = (sesCfg.smtp_pass || sesCfg.pass || rawSettings.ses_password || '').trim();
    const sesFromEmail = sanitizeEmailAddress(
      input.fromEmailOverride ||
        sesCfg.from_email ||
        sesCfg.fromEmail ||
        sesCfg.sender_email ||
        rawSettings.ses_sender_email ||
        cfg.notify_email ||
        tenantCfg.support_email ||
        ''
    );

    if (sesSmtpHost && sesSmtpUser && sesSmtpPass && sesFromEmail) {
      if (isEmailSilentBlocked()) {
        return {
          sent: true,
          messageId,
          recipient,
          smtpHost: sesSmtpHost,
          provider: 'silent_guard',
          category,
        };
      }
      const smtpDispatchFn = input.pooled ? sendPooledSmtpMail : sendRawSmtpMail;
      const smtpRes = await smtpDispatchFn({
        host: sesSmtpHost,
        port: Number(sesCfg.smtp_port || sesCfg.port || rawSettings.ses_port || tenantCfg.default_smtp_port || 587),
        user: sesSmtpUser,
        pass: sesSmtpPass,
        fromEmail: sesFromEmail,
        fromName,
        to: recipient,
        cc: input.cc || rawSettings.fallback_cc_email,
        subject: input.subject,
        text: input.text,
        html: renderedHtml,
        messageId,
      });
      accepted = smtpRes.accepted;
      messageId = smtpRes.messageId;
      headerMessageId = smtpRes.headerMessageId;
      errMsg = smtpRes.error;
    } else {
      const accessKeyId = (
        sesCfg.authUser ||
        sesCfg.accessKeyId ||
        sesCfg.aws_access_key_id ||
        rawSettings.ses_username ||
        process.env.AWS_ACCESS_KEY_ID ||
        ''
      ).trim();
      const secretAccessKey = (
        sesCfg.apiKey ||
        sesCfg.secretAccessKey ||
        sesCfg.aws_secret_access_key ||
        rawSettings.ses_password ||
        process.env.AWS_SECRET_ACCESS_KEY ||
        ''
      ).trim();
      const region = sesRegion;

      if (!accessKeyId || !secretAccessKey || !sesFromEmail) {
        return {
          sent: false,
          messageId,
          recipient,
          smtpHost: `email.${region}.amazonaws.com`,
          provider: 'ses',
          category,
          error: 'Chưa cấu hình AWS SES (SMTP hoặc IAM Access Key / Email người gửi).',
        };
      }

      if (isEmailSilentBlocked()) {
        return {
          sent: true,
          messageId,
          recipient,
          smtpHost: `email.${region}.amazonaws.com`,
          provider: 'silent_guard',
          category,
        };
      }

      const sesHost = `email.${region}.amazonaws.com`;
      const sesPath = '/v2/email/outbound-emails';
      const ccList = parseEmailRecipientList(input.cc || rawSettings.fallback_cc_email, recipient);
      const sesPayload = JSON.stringify({
        FromEmailAddress: `${fromName} <${sesFromEmail}>`,
        Destination: {
          ToAddresses: [recipient],
          ...(ccList.length > 0 ? { CcAddresses: ccList } : {}),
        },
        Content: {
          Simple: {
            Subject: { Data: input.subject, Charset: 'UTF-8' },
            Body: {
              Text: { Data: input.text, Charset: 'UTF-8' },
              Html: { Data: renderedHtml, Charset: 'UTF-8' },
            },
          },
        },
      });
      const signedHeaders = signAwsSigV4Headers({
        method: 'POST',
        host: sesHost,
        path: sesPath,
        region,
        service: 'ses',
        accessKeyId,
        secretAccessKey,
        payload: sesPayload,
        contentType: 'application/json',
      });
      try {
        const resp = await fetcher(`https://${sesHost}${sesPath}`, {
          method: 'POST',
          headers: signedHeaders,
          body: sesPayload,
        });
        const rawText = await resp.text();
        let parsed: any = null;
        try {
          parsed = JSON.parse(rawText);
        } catch {
          parsed = null;
        }
        if (!resp.ok) {
          accepted = false;
          errMsg = parsed?.message || parsed?.Message || `AWS SES trả về lỗi HTTP ${resp.status}`;
        } else {
          accepted = true;
          if (parsed?.MessageId) messageId = String(parsed.MessageId);
        }
      } catch (err: any) {
        accepted = false;
        errMsg = err?.message || 'Không thể kết nối tới AWS SES API.';
      }
    }
  } else {
    // SMTP driver (pure Node node:net + node:tls — pooled when `input.pooled` is true)
    const explicitHost = (
      cfg.smtp_host ||
      cfg.host ||
      rawSettings.ses_host ||
      (rawSettings.default_smtp_host !== 'smtp.gmail.com' ? rawSettings.default_smtp_host : '') ||
      ''
    ).trim();
    const smtpUser = (cfg.smtp_user || cfg.user || rawSettings.ses_username || '').trim();
    const smtpPass = (cfg.smtp_pass || cfg.pass || rawSettings.ses_password || '').trim();
    const effectiveHost =
      explicitHost ||
      (hasSmtpVault && (cfg.smtp_host || cfg.host) ? String(cfg.smtp_host || cfg.host).trim() : '') ||
      (smtpUser && smtpPass ? tenantCfg.default_smtp_host : '');
    const effectivePort = Number(cfg.smtp_port || cfg.port || rawSettings.ses_port || tenantCfg.default_smtp_port || 587);
    const fromEmail = (
      input.fromEmailOverride ||
      rawSettings.ses_sender_email ||
      cfg.from_email ||
      cfg.fromEmail ||
      cfg.sender_email ||
      cfg.notify_email ||
      smtpUser ||
      tenantCfg.support_email ||
      ''
    ).trim();

    if (!effectiveHost || effectiveHost === 'script.google.com') {
      return {
        sent: false,
        messageId,
        recipient,
        smtpHost: effectiveHost || '',
        provider: 'smtp',
        category,
        error: 'Chưa cấu hình SMTP Host.',
      };
    }

    if (!isLoopbackHost(effectiveHost) && (!smtpUser || !smtpPass)) {
      return {
        sent: false,
        messageId,
        recipient,
        smtpHost: effectiveHost,
        provider: 'smtp',
        category,
        error: 'Chưa cấu hình tài khoản/mật khẩu SMTP.',
      };
    }

    if (!fromEmail) {
      return {
        sent: false,
        messageId,
        recipient,
        smtpHost: effectiveHost,
        provider: 'smtp',
        category,
        error: 'Chưa cấu hình địa chỉ Email người gửi (From).',
      };
    }

    if (isEmailSilentBlocked()) {
      return {
        sent: true,
        messageId,
        recipient,
        smtpHost: effectiveHost,
        provider: 'silent_guard',
        category,
      };
    }

    const smtpDispatchFn = input.pooled ? sendPooledSmtpMail : sendRawSmtpMail;
    const smtpRes = await smtpDispatchFn({
      host: effectiveHost,
      port: effectivePort,
      user: smtpUser || undefined,
      pass: smtpPass || undefined,
      fromEmail,
      fromName,
      to: recipient,
      cc: input.cc || rawSettings.fallback_cc_email,
      subject: input.subject,
      text: input.text,
      html: renderedHtml,
      messageId,
    });
    accepted = smtpRes.accepted;
    messageId = smtpRes.messageId;
    headerMessageId = smtpRes.headerMessageId;
    errMsg = smtpRes.error;
  }

  const syncedTypes: string[] = [];
  if (hasSmtpVault && (provider === 'smtp' || customSmtpTransport)) syncedTypes.push('smtp');
  if (hasSesVault && provider === 'ses') syncedTypes.push('aws_ses');
  if (hasResendVault && provider === 'resend') syncedTypes.push('resend');
  if (hasSendgridVault && provider === 'sendgrid') syncedTypes.push('sendgrid');
  if (hasPostmarkVault && provider === 'postmark') syncedTypes.push('postmark');

  // Skip per-message DB write when dispatched inside high-speed preloaded campaign batch (flushed in Phase 3)
  if (accepted && syncedTypes.length > 0 && !input.preloadedState) {
    const updateSynced = async (c: DbClient) => {
      await c.query(
        `UPDATE tenant_integrations
         SET last_synced_at = clock_timestamp()
         WHERE tenant_id = $1 AND integration_type = ANY($2)`,
        [input.tenantId, syncedTypes]
      );
    };
    if (input.client) {
      await updateSynced(input.client);
    } else {
      await withTenantTransaction(input.tenantId, updateSynced);
    }
  }

  return {
    sent: accepted,
    messageId,
    ...(headerMessageId && headerMessageId !== messageId ? { headerMessageId } : {}),
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
 * Outbound Zalo Bot API sender (`bot-api.zaloplatforms.com/bot<token>/sendMessage`).
 */
export async function sendZaloBotNotification(
  tenantId: string | null,
  text: string,
  options?: {
    chatId?: string;
    botToken?: string;
    silentOverride?: boolean;
  }
): Promise<ZaloBotSendResult> {
  let vaultCfg: ZaloIntegrationConfig | null = null;
  let rawSettings: Record<string, any> = {};

  if (tenantId) {
    try {
      const [zBatch, meta] = await Promise.all([
        getTenantIntegrationsBatchCached(tenantId, ['zalo_bot', 'zalo_oa']),
        getTenantMetaCached(tenantId),
      ]);
      rawSettings = (meta?.rawSettings || {}) as Record<string, any>;
      const row = zBatch.zalo_bot || zBatch.zalo_oa;
      if (row && row.status === 'active') {
        vaultCfg = decryptTenantSecret<ZaloIntegrationConfig>(
          tenantId,
          row.config_encrypted,
          row.iv,
          row.auth_tag
        );
      }
    } catch {
      vaultCfg = null;
    }
  }

  if (rawSettings.zalo_bot_disabled === true) {
    return {
      success: false,
      silent: false,
      mocked: false,
      error: 'Zalo Bot chưa được kích hoạt cho không gian làm việc này.',
    };
  }

  const botToken = String(
    options?.botToken || vaultCfg?.bot_token || vaultCfg?.botToken || rawSettings.zalo_bot_token || ''
  ).trim();
  const targetChatId = String(
    options?.chatId ||
      vaultCfg?.chat_id ||
      vaultCfg?.chatId ||
      vaultCfg?.group_chat_id ||
      rawSettings.zalo_admin_group_chat_id ||
      ''
  ).trim();

  if (vaultCfg?.enabled === false || vaultCfg?.silent_mode === true || vaultCfg?.silentMode === true) {
    return { success: true, silent: true, mocked: true };
  }

  const plainText = stripHtmlTagsForPlainText(text);
  const chunks = chunkTextForChat(plainText, 1950);
  if (chunks.length === 0) {
    return { success: false, silent: false, mocked: false, error: 'Nội dung tin nhắn Zalo trống.' };
  }

  const isSilent =
    options?.silentOverride !== undefined
      ? options.silentOverride
      : customZaloBotTransport
        ? false
        : isOutboundSilentMode();

  if (isSilent) {
    return { success: true, silent: true, mocked: true };
  }

  if (customZaloBotTransport) {
    try {
      let lastId: string | undefined;
      for (const chunk of chunks) {
        const out = await customZaloBotTransport({
          chatId: targetChatId,
          text: chunk,
          botToken: botToken || undefined,
        });
        if (out?.messageId) lastId = out.messageId;
      }
      return { success: true, messageId: lastId || 'zalo_mock_msg', silent: false, mocked: true };
    } catch (err: any) {
      return {
        success: false,
        silent: false,
        mocked: true,
        error: err?.message || 'Zalo mock transport failed',
      };
    }
  }

  if (!botToken) {
    return {
      success: false,
      silent: false,
      mocked: false,
      error: 'Zalo Bot Token chưa được cấu hình.',
    };
  }

  if (!targetChatId) {
    return {
      success: false,
      silent: false,
      mocked: false,
      error: 'Zalo Chat ID / Group ID chưa được cấu hình.',
    };
  }

  const url = `https://bot-api.zaloplatforms.com/bot${encodeURIComponent(botToken)}/sendMessage`;
  let lastMessageId: string | undefined;
  try {
    for (const chunk of chunks) {
      const resp = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: targetChatId, text: chunk }),
        signal: AbortSignal.timeout(10_000),
      });
      const data = (await resp.json().catch(() => ({}))) as any;
      if (!resp.ok || data?.ok === false || (data?.error !== undefined && Number(data.error) !== 0)) {
        return {
          success: false,
          silent: false,
          mocked: false,
          error: data?.description || data?.message || `Zalo Bot API error: HTTP ${resp.status}`,
        };
      }
      if (data?.result?.message_id) {
        lastMessageId = String(data.result.message_id);
      }
    }
    return {
      success: true,
      messageId: lastMessageId,
      silent: false,
      mocked: false,
    };
  } catch (err: any) {
    return {
      success: false,
      silent: false,
      mocked: false,
      error: err?.message || 'Failed to dispatch Zalo Bot HTTP request',
    };
  }
}

/**
 * Outbound Discord Webhook / Bot API sender.
 */
export async function sendDiscordNotification(
  tenantId: string | null,
  content: string,
  options?: {
    webhookUrl?: string;
    botToken?: string;
    channelId?: string;
    username?: string;
    embeds?: Array<Record<string, unknown>>;
    silentOverride?: boolean;
  }
): Promise<DiscordSendResult> {
  let rawSettings: Record<string, any> = {};
  let brandName = 'DOMATION AutoData';

  if (tenantId) {
    try {
      const meta = await getTenantMetaCached(tenantId);
      rawSettings = (meta?.rawSettings || {}) as Record<string, any>;
      brandName = String(
        rawSettings.brand_display_name || meta?.name || rawSettings.capi_event_source_name || 'DOMATION AutoData'
      ).trim();
    } catch {
      rawSettings = {};
    }
  }

  const webhookUrl = String(options?.webhookUrl || rawSettings.discord_webhook_url || '').trim();
  const botToken = String(options?.botToken || rawSettings.discord_bot_token || '').trim();
  const channelId = String(options?.channelId || rawSettings.discord_channel_id || '').trim();
  const username = String(options?.username || brandName).trim() || 'DOMATION AutoData';

  const plainText = stripHtmlTagsForPlainText(content);
  const chunks = chunkTextForChat(plainText, 1950);
  if (chunks.length === 0) {
    return { success: false, silent: false, mocked: false, error: 'Nội dung tin nhắn Discord trống.' };
  }

  const isSilent =
    options?.silentOverride !== undefined
      ? options.silentOverride
      : customDiscordTransport
        ? false
        : isOutboundSilentMode();

  if (isSilent) {
    return { success: true, silent: true, mocked: true };
  }

  if (customDiscordTransport) {
    try {
      let lastId: string | undefined;
      for (let i = 0; i < chunks.length; i++) {
        const out = await customDiscordTransport({
          webhookUrl: webhookUrl || undefined,
          channelId: channelId || undefined,
          content: chunks[i],
          username,
          embeds: i === 0 ? options?.embeds : undefined,
        });
        if (out?.messageId || out?.id) lastId = String(out.messageId || out.id);
      }
      return { success: true, messageId: lastId || 'discord_mock_msg', silent: false, mocked: true };
    } catch (err: any) {
      return {
        success: false,
        silent: false,
        mocked: true,
        error: err?.message || 'Discord mock transport failed',
      };
    }
  }

  const hasValidWebhook = /^https:\/\/(?:discord\.com|discordapp\.com)\/api\/webhooks\/.+/i.test(webhookUrl);
  const hasBotCreds = Boolean(botToken && channelId);
  if (!hasValidWebhook && !hasBotCreds) {
    return {
      success: false,
      silent: false,
      mocked: false,
      error: 'Chưa cấu hình Discord Webhook URL hoặc Discord Bot Token/Channel ID.',
    };
  }

  let targetUrl = '';
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (hasValidWebhook) {
    const parsedUrl = new URL(webhookUrl);
    if (!parsedUrl.searchParams.has('wait')) parsedUrl.searchParams.set('wait', 'true');
    targetUrl = parsedUrl.toString();
  } else {
    targetUrl = `https://discord.com/api/v10/channels/${encodeURIComponent(channelId)}/messages`;
    headers.Authorization = `Bot ${botToken}`;
  }

  let lastMessageId: string | undefined;
  try {
    for (let i = 0; i < chunks.length; i++) {
      const bodyPayload: Record<string, unknown> = {
        content: chunks[i],
        ...(hasValidWebhook ? { username } : {}),
        ...(i === 0 && Array.isArray(options?.embeds) && options.embeds.length > 0 ? { embeds: options.embeds } : {}),
      };
      const resp = await fetch(targetUrl, {
        method: 'POST',
        headers,
        body: JSON.stringify(bodyPayload),
        signal: AbortSignal.timeout(10_000),
      });
      if (resp.status === 204) {
        continue;
      }
      const data = (await resp.json().catch(() => ({}))) as any;
      if (!resp.ok) {
        return {
          success: false,
          silent: false,
          mocked: false,
          error: data?.message || `Discord API error: HTTP ${resp.status}`,
        };
      }
      if (data?.id) {
        lastMessageId = String(data.id);
      }
    }
    return {
      success: true,
      messageId: lastMessageId,
      silent: false,
      mocked: false,
    };
  } catch (err: any) {
    return {
      success: false,
      silent: false,
      mocked: false,
      error: err?.message || 'Failed to dispatch Discord HTTP request',
    };
  }
}

/**
 * Proactive Zalo OAuth Token Refresh Loop:
 * Scans integrations expiring within tenant-configured window (default 4 hours), acquires Redlock
 * `lock:tenant:{tenant_id}:integration:zalo_oa:refresh`, rotates token, and
 * re-encrypts using AES-256-GCM with a CRYPTOGRAPHICALLY FRESH 96-bit CSPRNG IV.
 * On upstream OAuth failure, transitions status to `refresh_required` per spec.
 */
export async function refreshTenantZaloIntegrationsOnClient(
  client: DbClient,
  tenantId: string,
  mockOAuthFetcher?: ZaloOAuthFetcherFn
): Promise<{ refreshedCount: number; failedCount: number; newIvs: string[]; latestAccessToken?: string }> {
  const tenantCfg = await getTenantSettingsCached(tenantId, client);
  let refreshedCount = 0;
  let failedCount = 0;
  const newIvs: string[] = [];
  let latestAccessToken: string | undefined;

  const rows = await client.query<{
    id: string;
    integration_type: string;
    config_encrypted: string;
    iv: string;
    auth_tag: string;
  }>(
    `SELECT id, integration_type, config_encrypted, iv, auth_tag
     FROM tenant_integrations
     WHERE tenant_id = $1 AND integration_type IN ('zalo_oa', 'zalo_bot', 'zalo_zns') AND status = 'active'
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
      const activeFetcher = mockOAuthFetcher || customZaloOAuthFetcher;
      const secretKey = String(currentCfg.oa_secret || currentCfg.secret_key || '').trim();
      const appId = String(currentCfg.app_id || '').trim();
      const refreshToken = String(currentCfg.refresh_token || '').trim();

      if (activeFetcher) {
        nextTokens = await activeFetcher(currentCfg);
      } else if (!isOutboundSilentMode() && refreshToken && appId && secretKey) {
        const formBody = new URLSearchParams({
          refresh_token: refreshToken,
          app_id: appId,
          grant_type: 'refresh_token',
        });
        const oauthResp = await fetch('https://oauth.zaloapp.com/v4/oa/access_token', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
            secret_key: secretKey,
          },
          body: formBody.toString(),
          signal: AbortSignal.timeout(8000),
        });
        const oauthData = (await oauthResp.json().catch(() => null)) as {
          access_token?: string;
          refresh_token?: string;
          expires_in?: number | string;
          error?: number;
          error_description?: string;
          error_name?: string;
        } | null;
        if (!oauthResp.ok || !oauthData?.access_token) {
          throw new Error(
            oauthData?.error_description ||
              oauthData?.error_name ||
              `Zalo OAuth refresh failed (HTTP ${oauthResp.status})`
          );
        }
        const parsedExpires = Number(oauthData.expires_in || tenantCfg.zalo_token_ttl_hours * 3600);
        nextTokens = {
          access_token: String(oauthData.access_token),
          refresh_token: String(oauthData.refresh_token || refreshToken),
          expires_in: Number.isFinite(parsedExpires) && parsedExpires > 0 ? parsedExpires : 3600,
        };
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
      latestAccessToken = nextTokens.access_token;
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

  return { refreshedCount, failedCount, newIvs, latestAccessToken };
}

export async function refreshExpiringZaloTokens(
  tenantIdFilter?: string,
  mockOAuthFetcher?: ZaloOAuthFetcherFn
): Promise<{ refreshedCount: number; failedCount: number; newIvs: string[] }> {
  const candidates = await withSystemPrivilege(async (client) => {
    const sql = tenantIdFilter
      ? `SELECT DISTINCT i.tenant_id
         FROM tenant_integrations i
         INNER JOIN tenants t ON t.id = i.tenant_id
         WHERE i.tenant_id = $1
           AND i.integration_type IN ('zalo_oa', 'zalo_bot', 'zalo_zns')
           AND i.status = 'active'
           AND (
             i.token_expires_at IS NULL
             OR i.token_expires_at <= clock_timestamp() + make_interval(hours => GREATEST(1, LEAST(48, COALESCE((t.settings->>'zalo_token_refresh_window_hours')::int, 4))))
           )`
      : `SELECT DISTINCT i.tenant_id
         FROM tenant_integrations i
         INNER JOIN tenants t ON t.id = i.tenant_id
         WHERE i.integration_type IN ('zalo_oa', 'zalo_bot', 'zalo_zns')
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
    await tenantRedis.withLock(tenantId, 'integration:zalo_oa:refresh', 10_000, async () => {
      await withTenantTransaction(tenantId, async (client) => {
        const out = await refreshTenantZaloIntegrationsOnClient(client, tenantId, mockOAuthFetcher);
        refreshedCount += out.refreshedCount;
        failedCount += out.failedCount;
        newIvs.push(...out.newIvs);
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
  disabled?: boolean;
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
  const [tenantMeta, botRow, oaRow] = await Promise.all([
    getTenantMetaCached(input.tenantId),
    getTenantIntegrationCached(input.tenantId, 'zalo_bot'),
    getTenantIntegrationCached(input.tenantId, 'zalo_oa'),
  ]);
  const tenantCfg = tenantMeta?.settings || DEFAULT_TENANT_SETTINGS;
  if (tenantMeta?.rawSettings?.zalo_bot_disabled === true) {
    return {
      handled: false,
      disabled: true,
      command: 'zalo_bot_disabled',
      replyText: 'Zalo Bot chưa được kích hoạt cho không gian làm việc này.',
      metadata: { disabled: true },
    };
  }

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
