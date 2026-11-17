import crypto from 'node:crypto';
import { APP_CONFIG } from '../../config.ts';
import type { DbClient } from '../../core/database/db-adapter.ts';
import { decryptTenantSecret } from '../../core/crypto/vault.ts';
import { resolveUserEffectivePermissions } from '../../core/security/rbac.ts';

export function parseJsonCol<T>(raw: unknown, fallback: T): T {
  if (raw === null || raw === undefined) return fallback;
  if (typeof raw === 'string') {
    const trimmed = raw.trim();
    if (!trimmed) return fallback;
    try {
      return JSON.parse(trimmed) as T;
    } catch {
      return fallback;
    }
  }
  return raw as T;
}

export function slugifyMarketingKey(input: string, fallbackPrefix = 'item'): string {
  const cleaned = String(input || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/đ/gi, 'd')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 72);
  if (cleaned) return cleaned;
  return `${fallbackPrefix}-${crypto.randomBytes(3).toString('hex')}`;
}

export function generatePublicToken(prefix = 'mkt'): string {
  return `${prefix}_${crypto.randomBytes(12).toString('base64url')}`;
}

export function generateShortCode(len = 7): string {
  const alphabet = '23456789abcdefghjkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ';
  const bytes = crypto.randomBytes(len * 2);
  let out = '';
  for (let i = 0; i < bytes.length && out.length < len; i++) {
    out += alphabet[bytes[i] % alphabet.length];
  }
  return out;
}

export function hashOtpCode(tenantId: string, recipient: string, code: string): string {
  return crypto
    .createHmac('sha256', APP_CONFIG.vaultMasterSecret || 'domation-otp-secret')
    .update(`${tenantId}:${recipient.trim().toLowerCase()}:${code.trim()}`)
    .digest('hex');
}

export function signUnsubscribeHmac(tenantId: string, leadId: string, channel: string): string {
  return crypto
    .createHmac('sha256', APP_CONFIG.vaultMasterSecret || 'domation-unsub-secret')
    .update(`unsub:${tenantId}:${leadId}:${channel}`)
    .digest('hex');
}

export function verifyUnsubscribeHmac(
  tenantId: string,
  leadId: string,
  channel: string,
  signature: string
): boolean {
  if (!signature) return false;
  const expected = signUnsubscribeHmac(tenantId, leadId, channel);
  const a = Buffer.from(expected);
  const b = Buffer.from(String(signature));
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

export async function canUserUnmaskMarketingPii(
  client: DbClient,
  tenantId: string,
  userId: string
): Promise<boolean> {
  const rbac = await resolveUserEffectivePermissions(client, tenantId, userId);
  if (rbac.userOrg?.is_tenant_owner) return true;
  return Boolean(
    rbac.effectivePermissions.leads?.actions.unmask_phone ||
      rbac.effectivePermissions.audiences?.actions.unmask_phone
  );
}

export interface TenantChannelVaultStatus {
  configured: boolean;
  integrationType: string | null;
  status: string;
  config: Record<string, unknown>;
}

/**
 * Reads channel credentials strictly from the encrypted per-tenant `tenant_integrations` Vault.
 * Zero hardcoded tokens or SMTP credentials.
 */
export async function readTenantChannelVault(
  client: DbClient,
  tenantId: string,
  preferredTypes: string[]
): Promise<TenantChannelVaultStatus> {
  if (!preferredTypes.length) {
    return { configured: false, integrationType: null, status: 'disconnected', config: {} };
  }
  const placeholders = preferredTypes.map((_, i) => `$${i + 2}`).join(', ');
  const res = await client.query<{
    integration_type: string;
    config_encrypted: string;
    iv: string;
    auth_tag: string;
    status: string;
  }>(
    `SELECT integration_type, config_encrypted, iv, auth_tag, status
     FROM tenant_integrations
     WHERE tenant_id = $1 AND integration_type IN (${placeholders}) AND status = 'active'
     ORDER BY updated_at DESC`,
    [tenantId, ...preferredTypes]
  );

  for (const row of res.rows) {
    try {
      const dec = decryptTenantSecret<Record<string, unknown>>(
        tenantId,
        row.config_encrypted,
        row.iv,
        row.auth_tag
      );
      return {
        configured: true,
        integrationType: row.integration_type,
        status: row.status,
        config: dec || {},
      };
    } catch {
      // Decryption failed or rotated key; skip
    }
  }
  return { configured: false, integrationType: null, status: 'disconnected', config: {} };
}

// ============================================================================
// 15-Block Email HTML Compiler, Merge Tags & Spam Score Analyzer
// ============================================================================
export type EmailBlockType15 =
  | 'text'
  | 'image'
  | 'button'
  | 'divider'
  | 'columns'
  | 'product_card'
  | 'voucher_box'
  | 'countdown_timer'
  | 'social_links'
  | 'hero_banner'
  | 'testimonial'
  | 'video_thumbnail'
  | 'pricing_card'
  | 'table'
  | 'custom_html';

export interface EmailBlockDto {
  id: string;
  type: EmailBlockType15;
  title?: string;
  content?: string;
  subtitle?: string;
  url?: string;
  imageUrl?: string;
  buttonLabel?: string;
  voucherCode?: string;
  priceText?: string;
  originalPriceText?: string;
  countdownIso?: string;
  columns?: Array<{ heading?: string; body?: string; ctaLabel?: string; ctaUrl?: string }>;
  rows?: string[][];
  socialLinks?: Array<{ network: string; url: string }>;
  align?: 'left' | 'center' | 'right';
  accentColor?: string;
  backgroundColor?: string;
  textColor?: string;
  padding?: string;
  borderRadius?: number;
}

export interface EmailBodyStyleDto {
  canvasColor?: string;
  cardColor?: string;
  primaryColor?: string;
  textColor?: string;
  fontFamily?: string;
  maxWidth?: number;
}

function escapeHtml(raw: unknown): string {
  return String(raw ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export function renderMergeTags(
  templateStr: string,
  context: Record<string, unknown>,
  fallbackVars?: Record<string, string>
): string {
  if (!templateStr) return '';
  const fb = fallbackVars && typeof fallbackVars === 'object' ? fallbackVars : {};
  return String(templateStr).replace(/\{\{\s*([a-zA-Z0-9_.-]+)\s*\}\}/g, (_match, rawPath: string) => {
    const parts = rawPath.split('.');
    let cursor: unknown = context;
    for (const part of parts) {
      if (cursor && typeof cursor === 'object' && part in (cursor as Record<string, unknown>)) {
        cursor = (cursor as Record<string, unknown>)[part];
      } else {
        cursor = undefined;
        break;
      }
    }
    if (cursor === undefined || cursor === null || String(cursor).trim() === '') {
      // Flat fallback (e.g. {{name}} -> context.lead.name)
      const leadObj = context.lead as Record<string, unknown> | undefined;
      if (leadObj && rawPath in leadObj && leadObj[rawPath] !== undefined && leadObj[rawPath] !== null && String(leadObj[rawPath]).trim() !== '') {
        return String(leadObj[rawPath]);
      }
      const wrappedKey = `{{${rawPath}}}`;
      if (fb[wrappedKey]) return String(fb[wrappedKey]);
      if (fb[rawPath]) return String(fb[rawPath]);
      const leaf = parts[parts.length - 1];
      if (leaf && fb[leaf]) return String(fb[leaf]);
      return '';
    }
    return String(cursor);
  });
}

export function buildCountdownTimerSvg(
  targetIso: string,
  accentHex = '#1E40FF',
  label = 'Ưu đãi kết thúc sau'
): string {
  const safeHex = /^#[0-9a-fA-F]{6}$/.test(accentHex) ? accentHex : '#1E40FF';
  const targetMs = new Date(targetIso).getTime();
  const nowMs = Date.now();
  const diffSec = Number.isFinite(targetMs) ? Math.max(0, Math.floor((targetMs - nowMs) / 1000)) : 86400;
  const days = String(Math.floor(diffSec / 86400)).padStart(2, '0');
  const hours = String(Math.floor((diffSec % 86400) / 3600)).padStart(2, '0');
  const minutes = String(Math.floor((diffSec % 3600) / 60)).padStart(2, '0');
  const seconds = String(diffSec % 60).padStart(2, '0');

  const boxes = [
    { val: days, unit: 'NGÀY', x: 24 },
    { val: hours, unit: 'GIỜ', x: 120 },
    { val: minutes, unit: 'PHÚT', x: 216 },
    { val: seconds, unit: 'GIÂY', x: 312 },
  ];

  const boxesSvg = boxes
    .map(
      (b) => `
    <g transform="translate(${b.x}, 36)">
      <rect width="80" height="62" rx="12" fill="#FFFFFF" stroke="#DBEAFE" stroke-width="1.5"/>
      <text x="40" y="34" text-anchor="middle" font-family="Inter, Arial, sans-serif" font-size="24" font-weight="800" fill="${safeHex}">${b.val}</text>
      <text x="40" y="52" text-anchor="middle" font-family="Inter, Arial, sans-serif" font-size="9" font-weight="700" fill="#64748B">${b.unit}</text>
    </g>`
    )
    .join('');

  return `<svg xmlns="http://www.w3.org/2000/svg" width="416" height="112" viewBox="0 0 416 112" role="img" aria-label="${escapeHtml(label)}">
    <rect width="416" height="112" rx="16" fill="#F8FAFF" stroke="#E2E8F0" stroke-width="1"/>
    <text x="208" y="23" text-anchor="middle" font-family="Inter, Arial, sans-serif" font-size="11" font-weight="700" fill="#334155">${escapeHtml(label)}</text>
    ${boxesSvg}
  </svg>`;
}

export function compileEmailBlocksToHtml(
  blocks: EmailBlockDto[],
  bodyStyle?: EmailBodyStyleDto,
  title = 'DOMATION Email'
): string {
  const canvasBg = bodyStyle?.canvasColor || '#F8F9FA';
  const cardBg = bodyStyle?.cardColor || '#FFFFFF';
  const primary = bodyStyle?.primaryColor || '#1E40FF';
  const textCol = bodyStyle?.textColor || '#0F172A';
  const font = bodyStyle?.fontFamily || "'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Arial, sans-serif";
  const maxWidth = Math.min(760, Math.max(480, Number(bodyStyle?.maxWidth || 600)));

  const renderedBlocks = (Array.isArray(blocks) ? blocks : [])
    .map((block) => {
      const align = block.align || 'left';
      const accent = block.accentColor || primary;
      const bg = block.backgroundColor || 'transparent';
      const color = block.textColor || textCol;
      const pad = block.padding || '16px 28px';
      const radius = Number.isFinite(block.borderRadius) ? Number(block.borderRadius) : 12;

      switch (block.type) {
        case 'hero_banner':
          return `<tr><td style="padding:${pad};">
            <div style="background:${block.backgroundColor || 'linear-gradient(135deg,#1E40FF 0%,#0284C7 100%)'};border-radius:${radius}px;padding:32px 28px;text-align:${align};color:#FFFFFF;">
              <h1 style="margin:0 0 10px 0;font-size:24px;line-height:1.3;font-weight:800;color:#FFFFFF;">${escapeHtml(block.title || 'Giải pháp Tăng trưởng Doanh nghiệp')}</h1>
              <p style="margin:0 0 20px 0;font-size:15px;line-height:1.6;color:rgba(255,255,255,0.92);">${escapeHtml(block.content || '')}</p>
              ${
                block.buttonLabel
                  ? `<a href="${escapeHtml(block.url || 'https://domation.net')}" style="display:inline-block;padding:12px 24px;background:#FFFFFF;color:${primary};font-weight:700;font-size:14px;border-radius:10px;text-decoration:none;">${escapeHtml(block.buttonLabel)}</a>`
                  : ''
              }
            </div>
          </td></tr>`;

        case 'text':
          return `<tr><td style="padding:${pad};text-align:${align};background:${bg};color:${color};font-size:15px;line-height:1.65;">
            ${block.title ? `<h2 style="margin:0 0 8px 0;font-size:19px;font-weight:700;color:${color};">${escapeHtml(block.title)}</h2>` : ''}
            <div style="white-space:pre-line;">${escapeHtml(block.content || '')}</div>
          </td></tr>`;

        case 'image':
          return `<tr><td style="padding:${pad};text-align:${align};background:${bg};">
            ${block.url ? `<a href="${escapeHtml(block.url)}" style="text-decoration:none;">` : ''}
            <img src="${escapeHtml(block.imageUrl || 'https://placehold.co/600x260/EFF6FF/1E40FF?text=DOMATION+Visual')}" alt="${escapeHtml(block.title || 'Email Image')}" style="max-width:100%;height:auto;border-radius:${radius}px;display:inline-block;border:1px solid #E2E8F0;" />
            ${block.url ? '</a>' : ''}
          </td></tr>`;

        case 'button':
          return `<tr><td style="padding:${pad};text-align:${align};background:${bg};">
            <a href="${escapeHtml(block.url || 'https://domation.net')}" style="display:inline-block;padding:13px 28px;background:${accent};color:#FFFFFF;font-size:14px;font-weight:700;border-radius:${radius}px;text-decoration:none;">
              ${escapeHtml(block.buttonLabel || block.content || 'Khám phá ngay')}
            </a>
          </td></tr>`;

        case 'divider':
          return `<tr><td style="padding:${pad};">
            <hr style="border:none;border-top:1px solid #E2E8F0;margin:0;" />
          </td></tr>`;

        case 'columns': {
          const cols = Array.isArray(block.columns) && block.columns.length > 0
            ? block.columns
            : [
                { heading: 'Cột 1', body: 'Nội dung nổi bật cột trái' },
                { heading: 'Cột 2', body: 'Nội dung nổi bật cột phải' },
              ];
          const widthPct = Math.floor(100 / cols.length);
          const colsHtml = cols
            .map(
              (c) => `<td class="stack-col" width="${widthPct}%" valign="top" style="padding:8px;">
                <div style="background:#F8FAFC;border:1px solid #E2E8F0;border-radius:12px;padding:16px;">
                  <div style="font-size:15px;font-weight:700;color:#0F172A;margin-bottom:6px;">${escapeHtml(c.heading || '')}</div>
                  <div style="font-size:13px;line-height:1.55;color:#475569;">${escapeHtml(c.body || '')}</div>
                  ${c.ctaLabel ? `<div style="margin-top:10px;"><a href="${escapeHtml(c.ctaUrl || 'https://domation.net')}" style="color:${accent};font-size:13px;font-weight:700;text-decoration:none;">${escapeHtml(c.ctaLabel)} →</a></div>` : ''}
                </div>
              </td>`
            )
            .join('');
          return `<tr><td style="padding:${pad};"><table width="100%" cellpadding="0" cellspacing="0" role="presentation"><tr>${colsHtml}</tr></table></td></tr>`;
        }

        case 'product_card':
          return `<tr><td style="padding:${pad};">
            <table width="100%" cellpadding="0" cellspacing="0" role="presentation" style="border:1px solid #E2E8F0;border-radius:${radius}px;overflow:hidden;background:#FFFFFF;">
              <tr>
                <td width="38%" valign="middle" style="padding:16px;background:#F8FAFF;text-align:center;">
                  <img src="${escapeHtml(block.imageUrl || 'https://placehold.co/240x180/EFF6FF/1E40FF?text=Product')}" alt="${escapeHtml(block.title || 'Sản phẩm')}" style="max-width:100%;border-radius:10px;" />
                </td>
                <td width="62%" valign="middle" style="padding:18px;">
                  <div style="font-size:16px;font-weight:800;color:#0F172A;">${escapeHtml(block.title || 'Sản phẩm chủ lực')}</div>
                  <div style="font-size:13px;color:#64748B;margin:6px 0 10px 0;line-height:1.5;">${escapeHtml(block.content || '')}</div>
                  <div style="margin-bottom:12px;">
                    <span style="font-size:18px;font-weight:800;color:${accent};">${escapeHtml(block.priceText || '1.990.000₫')}</span>
                    ${block.originalPriceText ? `<span style="font-size:13px;color:#94A3B8;text-decoration:line-through;margin-left:8px;">${escapeHtml(block.originalPriceText)}</span>` : ''}
                  </div>
                  <a href="${escapeHtml(block.url || 'https://domation.net')}" style="display:inline-block;padding:10px 20px;background:${accent};color:#FFFFFF;font-size:13px;font-weight:700;border-radius:10px;text-decoration:none;">${escapeHtml(block.buttonLabel || 'Đặt mua ngay')}</a>
                </td>
              </tr>
            </table>
          </td></tr>`;

        case 'voucher_box':
          return `<tr><td style="padding:${pad};">
            <div style="border:2px dashed ${accent};background:#EFF6FF;border-radius:${radius}px;padding:20px;text-align:center;">
              <div style="font-size:12px;font-weight:700;text-transform:uppercase;letter-spacing:0.08em;color:${accent};">${escapeHtml(block.title || 'Mã Ưu Đãi Dành Riêng Cho Bạn')}</div>
              <div style="margin:10px auto;display:inline-block;padding:10px 24px;background:#FFFFFF;border:1px solid #BFDBFE;border-radius:10px;font-family:monospace;font-size:22px;font-weight:800;letter-spacing:0.12em;color:#0F172A;">
                ${escapeHtml(block.voucherCode || '{{lead.voucher_code}}')}
              </div>
              <div style="font-size:13px;color:#475569;">${escapeHtml(block.content || 'Áp dụng khi thanh toán trực tuyến hoặc tại quầy.')}</div>
            </div>
          </td></tr>`;

        case 'countdown_timer':
          return `<tr><td style="padding:${pad};text-align:center;">
            ${buildCountdownTimerSvg(block.countdownIso || new Date(Date.now() + 86400_000 * 2).toISOString(), accent, block.title || 'Ưu đãi kết thúc sau')}
          </td></tr>`;

        case 'social_links': {
          const links = Array.isArray(block.socialLinks) && block.socialLinks.length > 0
            ? block.socialLinks
            : [
                { network: 'Website', url: 'https://domation.net' },
                { network: 'Facebook', url: 'https://facebook.com' },
                { network: 'Zalo OA', url: 'https://zalo.me' },
              ];
          return `<tr><td style="padding:${pad};text-align:center;">
            ${links
              .map(
                (s) =>
                  `<a href="${escapeHtml(s.url)}" style="display:inline-block;margin:0 6px;padding:8px 14px;border-radius:999px;background:#F1F5F9;border:1px solid #E2E8F0;color:#1E40FF;font-size:12px;font-weight:700;text-decoration:none;">${escapeHtml(s.network)}</a>`
              )
              .join('')}
          </td></tr>`;
        }

        case 'testimonial':
          return `<tr><td style="padding:${pad};">
            <div style="background:#F8FAFC;border-left:4px solid ${accent};border-radius:0 12px 12px 0;padding:18px 20px;">
              <div style="font-size:14px;font-style:italic;color:#1E293B;line-height:1.6;">“${escapeHtml(block.content || 'Trải nghiệm dịch vụ chuyên nghiệp, phản hồi nhanh chóng và hiệu quả vượt kỳ vọng.')}”</div>
              <div style="margin-top:10px;font-size:13px;font-weight:700;color:#0F172A;">— ${escapeHtml(block.title || 'Khách hàng Doanh nghiệp')}</div>
            </div>
          </td></tr>`;

        case 'video_thumbnail':
          return `<tr><td style="padding:${pad};text-align:center;">
            <a href="${escapeHtml(block.url || 'https://domation.net')}" style="display:block;text-decoration:none;">
              <div style="position:relative;border-radius:${radius}px;overflow:hidden;border:1px solid #E2E8F0;background:#EFF6FF;padding:28px 20px;">
                <div style="width:54px;height:54px;line-height:54px;margin:0 auto 10px auto;border-radius:999px;background:${accent};color:#FFFFFF;font-size:20px;font-weight:800;">▶</div>
                <div style="font-size:15px;font-weight:700;color:#0F172A;">${escapeHtml(block.title || 'Xem Video Giới Thiệu')}</div>
                <div style="font-size:12px;color:#64748B;margin-top:4px;">${escapeHtml(block.content || 'Nhấn để phát video trực tiếp')}</div>
              </div>
            </a>
          </td></tr>`;

        case 'pricing_card':
          return `<tr><td style="padding:${pad};">
            <div style="border:1.5px solid ${accent};border-radius:${radius}px;padding:24px;text-align:center;background:#FFFFFF;">
              <div style="font-size:13px;font-weight:800;color:${accent};text-transform:uppercase;">${escapeHtml(block.subtitle || 'Gói Đề Xuất')}</div>
              <div style="font-size:20px;font-weight:800;color:#0F172A;margin:6px 0;">${escapeHtml(block.title || 'Growth Suite')}</div>
              <div style="font-size:28px;font-weight:800;color:${accent};margin:8px 0;">${escapeHtml(block.priceText || '2.990.000₫ / tháng')}</div>
              <div style="font-size:13px;color:#475569;line-height:1.6;margin-bottom:16px;white-space:pre-line;">${escapeHtml(block.content || '')}</div>
              <a href="${escapeHtml(block.url || 'https://domation.net')}" style="display:inline-block;padding:12px 26px;background:${accent};color:#FFFFFF;font-size:14px;font-weight:700;border-radius:10px;text-decoration:none;">${escapeHtml(block.buttonLabel || 'Đăng ký ngay')}</a>
            </div>
          </td></tr>`;

        case 'table': {
          const rows = Array.isArray(block.rows) && block.rows.length > 0
            ? block.rows
            : [
                ['Hạng mục', 'Chi tiết', 'Ưu đãi'],
                ['Gói Triển khai', 'Đầy đủ tính năng', 'Miễn phí khởi tạo'],
              ];
          const tableRowsHtml = rows
            .map((r, rIdx) => {
              const tag = rIdx === 0 ? 'th' : 'td';
              const cellStyle =
                rIdx === 0
                  ? 'padding:10px 12px;background:#F8FAFC;border-bottom:1px solid #E2E8F0;font-size:12px;font-weight:700;color:#475569;text-align:left;'
                  : 'padding:10px 12px;border-bottom:1px solid #F1F5F9;font-size:13px;color:#0F172A;text-align:left;';
              return `<tr>${r.map((cell) => `<${tag} style="${cellStyle}">${escapeHtml(cell)}</${tag}>`).join('')}</tr>`;
            })
            .join('');
          return `<tr><td style="padding:${pad};"><table width="100%" cellpadding="0" cellspacing="0" style="border:1px solid #E2E8F0;border-radius:10px;overflow:hidden;border-collapse:collapse;">${tableRowsHtml}</table></td></tr>`;
        }

        case 'custom_html':
          return `<tr><td style="padding:${pad};">${String(block.content || '')}</td></tr>`;

        default:
          return '';
      }
    })
    .join('\n');

  return `<!DOCTYPE html>
<html lang="vi">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>${escapeHtml(title)}</title>
  <style>
    @media only screen and (max-width: 600px) {
      .email-shell { width: 100% !important; }
      .stack-col { display: block !important; width: 100% !important; box-sizing: border-box !important; }
    }
  </style>
</head>
<body style="margin:0;padding:24px 12px;background:${canvasBg};font-family:${font};color:${textCol};">
  <table width="100%" cellpadding="0" cellspacing="0" role="presentation" style="background:${canvasBg};">
    <tr>
      <td align="center">
        <table class="email-shell" width="${maxWidth}" cellpadding="0" cellspacing="0" role="presentation" style="max-width:${maxWidth}px;width:100%;background:${cardBg};border:1px solid #E2E8F0;border-radius:20px;overflow:hidden;">
          ${renderedBlocks}
          <tr>
            <td style="padding:18px 28px;background:#F8FAFC;border-top:1px solid #E2E8F0;text-align:center;font-size:12px;color:#64748B;">
              Email được gửi từ <strong>{{tenant.name}}</strong> • <a href="{{unsubscribe_url}}" style="color:${primary};text-decoration:underline;">Hủy đăng ký nhận tin</a>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;
}

const SPAM_TRIGGER_WORDS = [
  'miễn phí 100%',
  'trúng thưởng',
  'rút tiền ngay',
  'làm giàu nhanh',
  'không rủi ro',
  'thu nhập thụ động',
  'vốn 0 đồng',
  'độc đắc',
  'click ngay kẻo lỡ',
];

export interface SpamAnalysisResult {
  score: number; // 0 (cleanest) -> 100 (highest spam risk)
  deliverabilityGrade: 'A+' | 'A' | 'B' | 'C' | 'D';
  issues: Array<{ severity: 'high' | 'medium' | 'low'; message: string }>;
}

export function analyzeEmailSpamScore(
  subject: string,
  blocks: EmailBlockDto[],
  compiledHtml: string
): SpamAnalysisResult {
  const issues: Array<{ severity: 'high' | 'medium' | 'low'; message: string }> = [];
  let score = 5;

  const cleanSubj = String(subject || '').trim();
  if (!cleanSubj) {
    score += 25;
    issues.push({ severity: 'high', message: 'Chưa nhập tiêu đề Email (Subject).' });
  } else {
    if (cleanSubj.length > 78) {
      score += 10;
      issues.push({ severity: 'low', message: 'Tiêu đề dài trên 78 ký tự dễ bị cắt trên thiết bị di động.' });
    }
    const upperLetters = cleanSubj.replace(/[^A-ZÀÁẠẢÃÂẦẤẬẨẪĂẰẮẶẲẴÈÉẸẺẼÊỀẾỆỂỄÌÍỊỈĨÒÓỌỎÕÔỒỐỘỔỖƠỜỚỢỞỠÙÚỤỦŨƯỪỨỰỬỮỲÝỴỶỸĐ]/g, '').length;
    if (cleanSubj.length >= 10 && upperLetters / cleanSubj.length > 0.6) {
      score += 20;
      issues.push({ severity: 'medium', message: 'Tiêu đề viết IN HOA quá nhiều dễ kích hoạt bộ lọc Spam.' });
    }
    if ((cleanSubj.match(/!/g) || []).length >= 2) {
      score += 12;
      issues.push({ severity: 'medium', message: 'Hạn chế dùng nhiều dấu chấm than (!) liên tiếp trong tiêu đề.' });
    }
  }

  const combinedLower = `${cleanSubj} ${compiledHtml.replace(/<[^>]+>/g, ' ')}`.toLowerCase();
  for (const word of SPAM_TRIGGER_WORDS) {
    if (combinedLower.includes(word)) {
      score += 14;
      issues.push({ severity: 'medium', message: `Phát hiện cụm từ nhạy cảm dễ rơi vào Quảng cáo/Spam: "${word}".` });
    }
  }

  const imageCount = (Array.isArray(blocks) ? blocks : []).filter((b) => b.type === 'image').length;
  const textBlocks = (Array.isArray(blocks) ? blocks : []).filter((b) => b.type === 'text' || b.type === 'hero_banner');
  if (imageCount >= 3 && textBlocks.length === 0) {
    score += 22;
    issues.push({ severity: 'high', message: 'Email chỉ chứa ảnh mà thiếu văn bản (Image-only email) rất dễ bị chặn.' });
  }

  for (const b of Array.isArray(blocks) ? blocks : []) {
    if ((b.type === 'button' || b.type === 'product_card' || b.type === 'pricing_card') && (!b.url || b.url.trim() === '#')) {
      score += 10;
      issues.push({ severity: 'medium', message: `Khối "${b.title || b.buttonLabel || b.type}" đang gắn link '#' hoặc trống.` });
    }
  }

  if (!compiledHtml.includes('{{unsubscribe_url}}')) {
    score += 18;
    issues.push({ severity: 'high', message: 'Thiếu liên kết hủy đăng ký {{unsubscribe_url}} theo chuẩn CAN-SPAM.' });
  }

  const clamped = Math.min(100, Math.max(0, score));
  const deliverabilityGrade: SpamAnalysisResult['deliverabilityGrade'] =
    clamped <= 15 ? 'A+' : clamped <= 30 ? 'A' : clamped <= 50 ? 'B' : clamped <= 70 ? 'C' : 'D';

  return { score: clamped, deliverabilityGrade, issues };
}
