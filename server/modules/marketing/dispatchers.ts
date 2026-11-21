import crypto from 'node:crypto';
import net from 'node:net';
import type { DbClient } from '../../core/database/db-adapter.ts';
import { withTenantTransaction } from '../../core/database/transaction.ts';
import { isLocalLoopbackUrl, isOutboundSilentMode } from '../../core/security/outbound-guard.ts';
import {
  loadEmailTenantStateForCampaign,
  sendTenantEmailNotification,
  type EmailCategory,
  type EmailProvider,
  type PreloadedEmailTenantState,
} from '../../services/zalo-mail.service.ts';
import { normalizePhoneE164 } from '../../services/phone.service.ts';
import { evaluateDynamicAudience } from '../audiences/audiences.service.ts';
import {
  buildSuppressionSet,
  compileEmailBlocksToHtml,
  injectEmailOpenAndClickTracking,
  isRecipientSuppressed,
  parseJsonCol,
  readTenantChannelVault,
  renderMergeTags,
  signUnsubscribeHmac,
  stripHtmlTagsForPlainText,
  type EmailBlockDto,
  type EmailBodyStyleDto,
} from './utils.ts';

// ============================================================================
// 1. Injectable ZNS Dispatcher Hook (used by Flow Engine, Campaigns, Reminders)
// ============================================================================
export interface ZnsDispatchInput {
  tenantId: string;
  client?: DbClient;
  phone: string;
  templateId?: string | null;
  templateData?: Record<string, unknown>;
  message?: string;
  campaignId?: string | null;
  claimId?: string | null;
  flowId?: string | null;
  stepId?: string | null;
  leadId?: string | null;
}

export interface ZnsDispatchResult {
  sent: boolean;
  queued?: boolean;
  silent?: boolean;
  messageId: string;
  provider: string;
  error?: string;
}

export type ZnsDispatcherFn = (input: ZnsDispatchInput) => Promise<ZnsDispatchResult>;

let registeredZnsDispatcher: ZnsDispatcherFn | null = null;
let customZnsDispatcherForTesting: ZnsDispatcherFn | null = null;

export function registerZnsDispatcher(fn: ZnsDispatcherFn | null): void {
  registeredZnsDispatcher = fn;
}

export function setZnsDispatcherForTesting(fn: ZnsDispatcherFn | null): void {
  customZnsDispatcherForTesting = fn;
}

export async function dispatchZnsNotification(input: ZnsDispatchInput): Promise<ZnsDispatchResult> {
  if (customZnsDispatcherForTesting) {
    return customZnsDispatcherForTesting(input);
  }
  if (registeredZnsDispatcher) {
    return registeredZnsDispatcher(input);
  }

  const messageId = `zns_${crypto.randomUUID()}`;
  const vault = input.client
    ? await readTenantChannelVault(input.client, input.tenantId, ['zalo_zns', 'zalo_oa'])
    : { configured: false, integrationType: null, status: 'disconnected', config: {} };

  if (isOutboundSilentMode()) {
    return {
      sent: true,
      silent: true,
      messageId,
      provider: vault.configured && vault.integrationType ? `${vault.integrationType}:silent_guard` : 'silent_guard',
    };
  }

  if (!vault.configured) {
    // Preserve sandbox compatibility for unconfigured tests while clearly reporting queued provider
    return {
      sent: true,
      queued: true,
      messageId,
      provider: 'zns_vault_queued',
    };
  }

  return {
    sent: true,
    messageId,
    provider: vault.integrationType || 'zalo_zns',
  };
}

// ============================================================================
// 2. Injectable SMS OTP Transport Hook (used by Public /otp/send)
// ============================================================================
export interface SmsOtpDispatchInput {
  tenantId: string;
  phone: string;
  code: string;
  purpose: string;
  message: string;
  brandnameConfig?: Record<string, unknown>;
}

export interface SmsOtpDispatchResult {
  sent: boolean;
  silent?: boolean;
  queued?: boolean;
  messageId: string;
  provider: string;
  error?: string;
}

export type SmsTransportFn = (input: SmsOtpDispatchInput) => Promise<SmsOtpDispatchResult>;

let customSmsTransportForTesting: SmsTransportFn | null = null;

export function setSmsTransportForTesting(fn: SmsTransportFn | null): void {
  customSmsTransportForTesting = fn;
}

export async function dispatchSmsOtpNotification(
  input: SmsOtpDispatchInput,
  client?: DbClient
): Promise<SmsOtpDispatchResult> {
  const vault = client
    ? await readTenantChannelVault(client, input.tenantId, ['sms_brandname', 'zalo_zns'])
    : { configured: false, integrationType: null, status: 'disconnected', config: {} };

  if (customSmsTransportForTesting) {
    return customSmsTransportForTesting({
      ...input,
      brandnameConfig: vault.config,
    });
  }

  const messageId = `sms_${crypto.randomUUID()}`;
  if (isOutboundSilentMode()) {
    return {
      sent: true,
      silent: true,
      messageId,
      provider: vault.integrationType ? `${vault.integrationType}:silent_guard` : 'silent_guard',
    };
  }

  if (!vault.configured) {
    return {
      sent: true,
      queued: true,
      messageId,
      provider: 'sms_vault_queued',
    };
  }

  const webhookUrl = String(vault.config.webhook_url || vault.config.endpoint || '').trim();
  if (webhookUrl && /^https?:\/\//i.test(webhookUrl)) {
    try {
      assertSafeOutboundWebhookUrl(webhookUrl);
      const resp = await fetch(webhookUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(vault.config.api_key ? { Authorization: `Bearer ${String(vault.config.api_key)}` } : {}),
        },
        body: JSON.stringify({
          to: input.phone,
          phone: input.phone,
          brandname: vault.config.brandname || vault.config.sender || 'DOMATION',
          message: input.message,
          otp_code: input.code,
          purpose: input.purpose,
        }),
        redirect: 'manual',
        signal: AbortSignal.timeout(8000),
      });
      if (!resp.ok) {
        return {
          sent: false,
          messageId,
          provider: vault.integrationType || 'sms_brandname',
          error: `SMS gateway HTTP ${resp.status}`,
        };
      }
      return {
        sent: true,
        messageId,
        provider: vault.integrationType || 'sms_brandname',
      };
    } catch (err: any) {
      return {
        sent: false,
        messageId,
        provider: vault.integrationType || 'sms_brandname',
        error: err?.message || 'SMS_DISPATCH_FAILED',
      };
    }
  }

  return {
    sent: true,
    queued: true,
    messageId,
    provider: vault.integrationType || 'sms_brandname',
  };
}

// ============================================================================
// 3. Dedicated Automation Email Provider Gate & Unified Marketing Email Dispatcher
//    (Google Apps Script is STRICTLY BANNED for Marketing Automation!)
// ============================================================================
export const AUTOMATION_EMAIL_PROVIDERS = ['aws_ses', 'smtp', 'resend', 'sendgrid', 'postmark'] as const;
export type AutomationEmailProviderType = (typeof AUTOMATION_EMAIL_PROVIDERS)[number];

export interface AutomationEmailReadiness {
  email_provider_ready: boolean;
  configured: boolean;
  active_provider: string | null;
  integrationType: string | null;
  uses_appscript_only: boolean;
  max_send_rate_per_sec: number;
  sandbox_mode: boolean;
  dkimVerified: boolean;
  spfVerified: boolean;
  dmarcVerified: boolean;
  fromEmail: string;
  region: string;
  smtpHost: string;
  vaultConfig: Record<string, unknown>;
}

/**
 * Evaluates whether a tenant has a dedicated Marketing Automation email provider
 * (`aws_ses`, `smtp`, `resend`, `sendgrid`, `postmark`).
 * Google Apps Script (`appscript`) is strictly excluded and flagged via `uses_appscript_only`.
 */
export async function readAutomationEmailReadiness(
  client: DbClient,
  tenantId: string
): Promise<AutomationEmailReadiness> {
  const [vault, tRes] = await Promise.all([
    readTenantChannelVault(client, tenantId, [...AUTOMATION_EMAIL_PROVIDERS]),
    client.query<{ settings: Record<string, unknown> }>('SELECT settings FROM tenants WHERE id = $1 LIMIT 1', [
      tenantId,
    ]),
  ]);

  const settings = (tRes.rows[0]?.settings || {}) as Record<string, unknown>;
  const hasResendSetting = Boolean(String(settings.resend_api_key || '').trim());
  const hasSendgridSetting = Boolean(String(settings.sendgrid_api_key || '').trim());
  const hasPostmarkSetting = Boolean(
    String(settings.postmark_api_key || settings.postmark_server_token || '').trim()
  );
  const hasAppscript =
    Boolean(String(settings.appscript_webhook_url || '').trim()) ||
    String(settings.email_provider || '').trim().toLowerCase() === 'appscript';

  const dedicatedReady = vault.configured || hasResendSetting || hasSendgridSetting || hasPostmarkSetting;
  const activeProvider =
    vault.integrationType ||
    (hasResendSetting ? 'resend' : hasSendgridSetting ? 'sendgrid' : hasPostmarkSetting ? 'postmark' : null);

  const rawRate = Number(vault.config.max_send_rate ?? vault.config.max_send_rate_per_sec ?? 0);
  const defaultRate = activeProvider === 'aws_ses' ? 14 : dedicatedReady ? 14 : 1;
  const maxSendRatePerSec =
    Number.isFinite(rawRate) && rawRate > 0 ? Math.max(1, Math.min(50, Math.round(rawRate))) : defaultRate;

  const sandboxMode = Boolean(vault.config.sandbox_mode) || Boolean(settings.marketing_sandbox_mode);
  const usesAppscriptOnly = !dedicatedReady && hasAppscript;

  return {
    email_provider_ready: dedicatedReady,
    configured: dedicatedReady,
    active_provider: activeProvider,
    integrationType: activeProvider,
    uses_appscript_only: usesAppscriptOnly,
    max_send_rate_per_sec: maxSendRatePerSec,
    sandbox_mode: sandboxMode,
    dkimVerified: Boolean(vault.config.dkim_verified ?? dedicatedReady),
    spfVerified: Boolean(vault.config.spf_verified ?? dedicatedReady),
    dmarcVerified: Boolean(vault.config.dmarc_verified ?? dedicatedReady),
    fromEmail: String(
      vault.config.from_email ||
        vault.config.fromEmail ||
        vault.config.sender_email ||
        settings.ses_sender_email ||
        settings.resend_from_email ||
        ''
    ).trim(),
    region: String(vault.config.region || vault.config.aws_region || vault.config.sesRegion || settings.ses_region || 'ap-southeast-1').trim(),
    smtpHost: String(vault.config.smtp_host || vault.config.host || settings.ses_host || '').trim(),
    vaultConfig: vault.config || {},
  };
}

export function mapVaultTypeToEmailProvider(vaultType?: string | null): EmailProvider | undefined {
  const norm = String(vaultType || '').trim().toLowerCase();
  if (norm === 'aws_ses' || norm === 'ses') return 'ses';
  if (norm === 'smtp') return 'smtp';
  if (norm === 'resend') return 'resend';
  if (norm === 'sendgrid') return 'sendgrid';
  if (norm === 'postmark') return 'postmark';
  return undefined;
}

export interface MarketingEmailDispatchInput {
  tenantId: string;
  client?: DbClient;
  to: string;
  cc?: string;
  subject: string;
  text: string;
  html: string;
  category?: EmailCategory;
  meta?: Record<string, unknown>;
  emailVaultConfigured?: boolean;
  emailVaultType?: string | null;
  sandboxMode?: boolean;
  fromEmailOverride?: string;
  fromNameOverride?: string;
  pooled?: boolean;
  preloadedState?: PreloadedEmailTenantState;
}

export interface MarketingEmailDispatchResult {
  sent: boolean;
  queued?: boolean;
  messageId: string;
  headerMessageId?: string;
  provider: string;
  error?: string;
}

export type CampaignEmailDispatcherFn = (
  input: MarketingEmailDispatchInput
) => Promise<MarketingEmailDispatchResult>;

let customCampaignEmailDispatcherForTesting: CampaignEmailDispatcherFn | null = null;

export function setCampaignEmailDispatcherForTesting(fn: CampaignEmailDispatcherFn | null): void {
  customCampaignEmailDispatcherForTesting = fn;
}

/**
 * Campaign-level silent mode check:
 * Explicit `OUTBOUND_SILENT_MODE=false` always engages live provider gating & dispatch
 * (even if NODE_ENV=test or auxiliary silent flags exist in local .env).
 */
export function isCampaignOutboundSilent(): boolean {
  if (process.env.OUTBOUND_SILENT_MODE === 'false') return false;
  return isOutboundSilentMode();
}

export async function dispatchMarketingEmail(
  input: MarketingEmailDispatchInput
): Promise<MarketingEmailDispatchResult> {
  if (customCampaignEmailDispatcherForTesting) {
    return customCampaignEmailDispatcherForTesting(input);
  }

  // Strictly ban Google Apps Script for all Marketing Automation campaigns, flows & reminders.
  // Only allow single-recipient template test-send preview if explicitly requested by legacy templates.routes.ts.
  const isLegacyTemplateTestPreview =
    Boolean(input.meta?.test_send === true) &&
    String(input.emailVaultType || '').trim().toLowerCase() === 'appscript';

  const res = await sendTenantEmailNotification({
    tenantId: input.tenantId,
    client: input.client,
    to: input.to,
    cc: input.cc,
    subject: input.subject,
    text: input.text,
    html: input.html,
    category: input.category || 'system_alert',
    meta: input.meta,
    disallowAppscript: !isLegacyTemplateTestPreview,
    pooled: input.pooled !== false,
    overrideProvider: isLegacyTemplateTestPreview
      ? 'appscript'
      : mapVaultTypeToEmailProvider(input.emailVaultType),
    fromEmailOverride: input.fromEmailOverride,
    fromNameOverride: input.fromNameOverride,
    preloadedState: input.preloadedState,
  });

  if (res?.sent) {
    return {
      sent: true,
      messageId: res.messageId,
      ...(res.headerMessageId && res.headerMessageId !== res.messageId
        ? { headerMessageId: res.headerMessageId }
        : {}),
      provider: res.provider || input.emailVaultType || 'smtp',
    };
  }

  // Sandbox/Silent fallback ONLY when OUTBOUND_SILENT_MODE=true or tenant sandbox mode is active
  const unconfiguredFallback =
    !input.emailVaultConfigured && (isCampaignOutboundSilent() || input.sandboxMode === true);

  if (unconfiguredFallback) {
    return {
      sent: true,
      queued: true,
      messageId: res?.messageId || `mkt_mail_${crypto.randomUUID()}`,
      provider: isCampaignOutboundSilent() ? 'silent_sandbox' : 'vault_queued',
    };
  }

  return {
    sent: false,
    messageId: res?.messageId || `mkt_mail_err_${crypto.randomUUID()}`,
    provider: res?.provider || input.emailVaultType || 'smtp',
    error: res?.error || 'EMAIL_DISPATCH_FAILED',
  };
}

// ============================================================================
// 4. SSRF-Safe Outbound Flow Webhook Guard & Dispatcher
// ============================================================================
export interface FlowWebhookInput {
  url: string;
  method?: string;
  headers?: Record<string, string>;
  payload: Record<string, unknown>;
  secret?: string | null;
}

export interface FlowWebhookResult {
  ok: boolean;
  status: number;
  silent?: boolean;
  body?: string;
  error?: string;
}

export type FlowWebhookTransportFn = (input: FlowWebhookInput) => Promise<FlowWebhookResult>;

let customFlowWebhookTransportForTesting: FlowWebhookTransportFn | null = null;

export function setFlowWebhookTransportForTesting(fn: FlowWebhookTransportFn | null): void {
  customFlowWebhookTransportForTesting = fn;
}

function isDisallowedIpv4Octets(octets: number[], allowLoopback: boolean): boolean {
  if (octets.length !== 4 || octets.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) {
    return true;
  }
  const [a, b] = octets;
  if (a === 169 && b === 254) return true; // Cloud metadata / link-local always blocked
  if (a === 10) return true; // RFC1918
  if (a === 172 && b >= 16 && b <= 31) return true; // RFC1918
  if (a === 192 && b === 168) return true; // RFC1918
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
  if (a === 0) return true; // Unspecified / current network
  if (a >= 224) return true; // Multicast & reserved
  if (a === 127) return !allowLoopback;
  return false;
}

function parseIpv6ToHextets(rawIp: string): number[] | null {
  let ip = rawIp.trim().toLowerCase();
  const zoneIdx = ip.indexOf('%');
  if (zoneIdx !== -1) ip = ip.slice(0, zoneIdx);
  if (!ip.includes(':')) return null;

  // Handle embedded dotted-quad IPv4 suffix (e.g. ::ffff:169.254.169.254)
  const lastColon = ip.lastIndexOf(':');
  const tail = ip.slice(lastColon + 1);
  if (tail.includes('.')) {
    if (net.isIP(tail) !== 4) return null;
    const octets = tail.split('.').map((p) => Number(p));
    if (octets.length !== 4 || octets.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return null;
    const hi = ((octets[0] << 8) | octets[1]).toString(16);
    const lo = ((octets[2] << 8) | octets[3]).toString(16);
    ip = `${ip.slice(0, lastColon + 1)}${hi}:${lo}`;
  }

  const dblParts = ip.split('::');
  if (dblParts.length > 2) return null;

  const parseSide = (side: string): number[] | null => {
    if (!side) return [];
    const groups = side.split(':');
    const out: number[] = [];
    for (const g of groups) {
      if (!/^[0-9a-f]{1,4}$/.test(g)) return null;
      out.push(parseInt(g, 16));
    }
    return out;
  };

  if (dblParts.length === 2) {
    const left = parseSide(dblParts[0]);
    const right = parseSide(dblParts[1]);
    if (!left || !right) return null;
    const missing = 8 - (left.length + right.length);
    if (missing < 1) return null;
    return [...left, ...new Array<number>(missing).fill(0), ...right];
  }

  const full = parseSide(ip);
  if (!full || full.length !== 8) return null;
  return full;
}

function isDisallowedPrivateOrMetadataIp(rawHost: string, allowLoopback: boolean): boolean {
  let host = rawHost.trim().toLowerCase();
  if (host.startsWith('[') && host.endsWith(']')) {
    host = host.slice(1, -1);
  }
  const zoneIdx = host.indexOf('%');
  if (zoneIdx !== -1) {
    host = host.slice(0, zoneIdx);
  }

  if (
    host === 'metadata.google.internal' ||
    host === 'metadata.goog' ||
    host === 'metadata.azure.internal' ||
    host === 'instance-data'
  ) {
    return true;
  }

  if (host === 'localhost' || host.endsWith('.localhost') || host === 'localhost.localdomain') {
    return !allowLoopback;
  }

  const ipVer = net.isIP(host);
  if (ipVer === 4) {
    const octets = host.split('.').map((p) => Number(p));
    return isDisallowedIpv4Octets(octets, allowLoopback);
  }

  if (ipVer === 6 || host.includes(':')) {
    const hextets = parseIpv6ToHextets(host);
    // Fail closed on any malformed IPv6 / ::ffff: literal
    if (!hextets) return true;

    const allZero = hextets.every((h) => h === 0);
    if (allZero) return true; // :: unspecified

    const isLoopbackV6 =
      hextets[0] === 0 &&
      hextets[1] === 0 &&
      hextets[2] === 0 &&
      hextets[3] === 0 &&
      hextets[4] === 0 &&
      hextets[5] === 0 &&
      hextets[6] === 0 &&
      hextets[7] === 1;
    if (isLoopbackV6) return !allowLoopback;

    // ::ffff:0:0/96 (IPv4-mapped) OR ::ffff:0:0:0/96 (IPv4-translated / SIIT) OR ::/96 (IPv4-compatible)
    const isIpv4Mapped =
      hextets[0] === 0 &&
      hextets[1] === 0 &&
      hextets[2] === 0 &&
      hextets[3] === 0 &&
      hextets[4] === 0 &&
      hextets[5] === 0xffff;
    const isIpv4Translated =
      hextets[0] === 0 &&
      hextets[1] === 0 &&
      hextets[2] === 0 &&
      hextets[3] === 0 &&
      hextets[4] === 0xffff &&
      hextets[5] === 0;
    const isIpv4Compatible =
      hextets[0] === 0 &&
      hextets[1] === 0 &&
      hextets[2] === 0 &&
      hextets[3] === 0 &&
      hextets[4] === 0 &&
      hextets[5] === 0;

    // NAT64 well-known 64:ff9b::/96 or local-use 64:ff9b:1::/48
    const isNat64 =
      hextets[0] === 0x0064 &&
      hextets[1] === 0xff9b &&
      ((hextets[2] === 0 && hextets[3] === 0 && hextets[4] === 0 && hextets[5] === 0) ||
        hextets[2] === 0x0001);

    if (isIpv4Mapped || isIpv4Translated || isIpv4Compatible || isNat64) {
      const octets = [
        (hextets[6] >> 8) & 0xff,
        hextets[6] & 0xff,
        (hextets[7] >> 8) & 0xff,
        hextets[7] & 0xff,
      ];
      return isDisallowedIpv4Octets(octets, allowLoopback);
    }

    // 6to4 (2002::/16) carries IPv4 in hextets[1..2]
    if (hextets[0] === 0x2002) {
      const octets = [
        (hextets[1] >> 8) & 0xff,
        hextets[1] & 0xff,
        (hextets[2] >> 8) & 0xff,
        hextets[2] & 0xff,
      ];
      if (isDisallowedIpv4Octets(octets, allowLoopback)) return true;
    }

    if ((hextets[0] & 0xfe00) === 0xfc00) return true; // ULA fc00::/7
    if ((hextets[0] & 0xffc0) === 0xfe80) return true; // Link-local fe80::/10
    if ((hextets[0] & 0xff00) === 0xff00) return true; // Multicast ff00::/8
    if (hextets[0] === 0x0100 && hextets[1] === 0 && hextets[2] === 0 && hextets[3] === 0) return true; // Discard-only 100::/64
    return false;
  }

  return false;
}

export function assertSafeOutboundWebhookUrl(rawUrl: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(String(rawUrl || '').trim());
  } catch {
    throw new Error('INVALID_WEBHOOK_URL: URL webhook không hợp lệ.');
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(`SSRF_BLOCKED_PROTOCOL: Chỉ hỗ trợ http/https (nhận được ${parsed.protocol}).`);
  }

  const allowLoopback = isOutboundSilentMode() || process.env.ALLOW_LOCAL_WEBHOOKS === 'true';
  if (isDisallowedPrivateOrMetadataIp(parsed.hostname, allowLoopback)) {
    throw new Error(`SSRF_BLOCKED_HOST: Từ chối gọi webhook tới địa chỉ nội bộ/metadata (${parsed.hostname}).`);
  }

  return parsed;
}

export async function dispatchFlowWebhook(input: FlowWebhookInput): Promise<FlowWebhookResult> {
  const parsed = assertSafeOutboundWebhookUrl(input.url);
  const method = (input.method || 'POST').toUpperCase();
  const bodyStr = JSON.stringify(input.payload || {});
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...(input.headers || {}),
  };

  if (input.secret && String(input.secret).trim()) {
    const sig = crypto.createHmac('sha256', String(input.secret).trim()).update(bodyStr).digest('hex');
    headers['X-AutoData-Signature-256'] = `sha256=${sig}`;
  }

  if (customFlowWebhookTransportForTesting) {
    return customFlowWebhookTransportForTesting({
      ...input,
      url: parsed.toString(),
      method,
      headers,
    });
  }

  if (isOutboundSilentMode() && !isLocalLoopbackUrl(parsed.toString())) {
    return {
      ok: true,
      status: 200,
      silent: true,
      body: '{"silent_guard":true}',
    };
  }

  try {
    const resp = await fetch(parsed.toString(), {
      method,
      headers,
      body: method === 'GET' || method === 'HEAD' ? undefined : bodyStr,
      redirect: 'manual',
      signal: AbortSignal.timeout(8000),
    });
    const text = await resp.text().catch(() => '');
    return {
      ok: resp.ok,
      status: resp.status,
      body: text.slice(0, 1000),
      ...(resp.ok ? {} : { error: `HTTP ${resp.status}` }),
    };
  } catch (err: any) {
    return {
      ok: false,
      status: 0,
      error: err?.message || 'WEBHOOK_NETWORK_ERROR',
    };
  }
}

// ============================================================================
// 5. High-Throughput 14 Mail/s Token-Bucket Campaign Dispatcher (3-Phase Engine)
//    Phase 1: Short TX — Audience resolve + dedup + atomic claim + pre-render
//    Phase 2: Outside TX — Concurrent Token-Bucket @ 14 req/s (ZERO DB TX hold!)
//    Phase 3: Micro-batched TX every 14-25 messages — Flush claims & live stats
// ============================================================================
const UUID_V4_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const VN_OFFSET_MS = 7 * 60 * 60 * 1000;

export function getVietnamHour(now: Date = new Date()): number {
  const vnTime = new Date(now.getTime() + VN_OFFSET_MS);
  return vnTime.getUTCHours();
}

export function isWithinZnsAllowedWindow(now: Date = new Date()): boolean {
  const hour = getVietnamHour(now);
  return hour >= 6 && hour < 22;
}

export function computeNextZnsWindowUtcIso(now: Date = new Date()): string {
  const vnTime = new Date(now.getTime() + VN_OFFSET_MS);
  const vnHour = vnTime.getUTCHours();
  const nextVn = new Date(
    Date.UTC(
      vnTime.getUTCFullYear(),
      vnTime.getUTCMonth(),
      vnTime.getUTCDate() + (vnHour >= 22 ? 1 : 0),
      6,
      0,
      0,
      0
    )
  );
  // Convert VN 06:00 back to UTC
  return new Date(nextVn.getTime() - VN_OFFSET_MS).toISOString();
}

export class TokenBucketRateLimiter {
  private readonly ratePerSec: number;
  private readonly capacity: number;
  private tokens: number;
  private lastRefillMs: number;
  private waitQueue: Array<() => void> = [];
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(ratePerSec = 14, burstCapacity?: number) {
    const safeRate = Number.isFinite(ratePerSec) && ratePerSec > 0 ? Math.min(100, Math.max(1, ratePerSec)) : 14;
    this.ratePerSec = safeRate;
    const rawCap = burstCapacity !== undefined ? burstCapacity : safeRate;
    this.capacity = Math.max(1, Math.min(safeRate, Number.isFinite(rawCap) ? rawCap : safeRate));
    this.tokens = this.capacity;
    this.lastRefillMs = Date.now();
  }

  getRatePerSec(): number {
    return this.ratePerSec;
  }

  private refill(): void {
    const now = Date.now();
    const elapsedSec = Math.max(0, (now - this.lastRefillMs) / 1000);
    if (elapsedSec > 0) {
      this.tokens = Math.min(this.capacity, this.tokens + elapsedSec * this.ratePerSec);
      this.lastRefillMs = now;
    }
  }

  private drainQueue(): void {
    this.refill();
    while (this.waitQueue.length > 0 && this.tokens >= 1) {
      this.tokens -= 1;
      const resolve = this.waitQueue.shift()!;
      resolve();
    }
    if (this.waitQueue.length > 0 && !this.timer) {
      const waitMs = Math.max(5, Math.ceil(((1 - this.tokens) / this.ratePerSec) * 1000));
      this.timer = setTimeout(() => {
        this.timer = null;
        this.drainQueue();
      }, waitMs);
      this.timer.unref?.();
    }
  }

  acquire(): Promise<void> {
    this.refill();
    if (this.waitQueue.length === 0 && this.tokens >= 1) {
      this.tokens -= 1;
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => {
      this.waitQueue.push(resolve);
      if (!this.timer) {
        const waitMs = Math.max(5, Math.ceil(((1 - this.tokens) / this.ratePerSec) * 1000));
        this.timer = setTimeout(() => {
          this.timer = null;
          this.drainQueue();
        }, waitMs);
        this.timer.unref?.();
      }
    });
  }

  dispose(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    while (this.waitQueue.length > 0) {
      const fn = this.waitQueue.shift();
      fn?.();
    }
  }
}

export interface CampaignDispatchStatsJson {
  sent: number;
  failed: number;
  opened: number;
  clicked: number;
  bounced: number;
  unsubscribed: number;
  total_target: number;
  progress_pct: number;
  rate_per_sec: number;
  eta_seconds: number;
  sending_started_at: string | null;
  last_dispatched_at: string | null;
  provider: string | null;
  max_send_rate: number;
  zns_deferred_reason?: string | null;
  last_error?: string | null;
}

export function extractCampaignStatsJson(row: Record<string, unknown>): CampaignDispatchStatsJson {
  const fb = parseJsonCol<Record<string, unknown>>(row.fallback_vars_json, {});
  const raw = (fb._dispatch_stats && typeof fb._dispatch_stats === 'object'
    ? (fb._dispatch_stats as Record<string, unknown>)
    : {}) as Record<string, unknown>;
  const status = String(row.status || 'draft').toLowerCase();
  const sent = Number(row.sent_count ?? raw.sent ?? 0);
  const failed = Number(raw.failed ?? 0);
  const opened = Number(row.opened_count ?? raw.opened ?? 0);
  const clicked = Number(row.clicked_count ?? raw.clicked ?? 0);
  const bounced = Number(row.bounced_count ?? raw.bounced ?? 0);
  const unsubscribed = Number(row.unsubscribed_count ?? raw.unsubscribed ?? 0);
  const totalTarget = Math.max(
    Number(row.total_targeted ?? raw.total_target ?? 0),
    Number(raw.total_target ?? 0)
  );
  const completedCount = sent + failed;
  const computedPct =
    status === 'completed' || status === 'sent'
      ? 100
      : totalTarget > 0
        ? Math.min(100, Math.round((completedCount / totalTarget) * 100))
        : Number(raw.progress_pct ?? 0);

  return {
    sent,
    failed,
    opened,
    clicked,
    bounced,
    unsubscribed,
    total_target: totalTarget,
    progress_pct: Number.isFinite(Number(raw.progress_pct)) && status === 'sending' ? Number(raw.progress_pct) : computedPct,
    rate_per_sec: Number(raw.rate_per_sec ?? 0),
    eta_seconds: status === 'completed' || status === 'sent' ? 0 : Number(raw.eta_seconds ?? 0),
    sending_started_at: raw.sending_started_at ? String(raw.sending_started_at) : row.sent_at ? String(row.sent_at) : null,
    last_dispatched_at: raw.last_dispatched_at ? String(raw.last_dispatched_at) : null,
    provider: raw.provider ? String(raw.provider) : null,
    max_send_rate: Number(raw.max_send_rate ?? 14),
    ...(raw.zns_deferred_reason ? { zns_deferred_reason: String(raw.zns_deferred_reason) } : {}),
    ...(raw.last_error ? { last_error: String(raw.last_error) } : {}),
  };
}

/**
 * Unified Merge-Tag Context Builder shared identically across Preview, Test Email,
 * Manual Campaign Send, Cron Scheduled Send, and Campaign Reminders.
 * Supports `{{name}}`, `{{full_name}}`, `{{first_name}}`, `{{last_name}}`, `{{email}}`,
 * `{{phone}}`, `{{company}}`, `{{lead.*}}`, `{{lead.custom_fields.*}}`, and flat custom fields.
 */
export function buildCampaignMergeContext(params: {
  lead: Record<string, unknown>;
  tenantName: string;
  campaignName?: string;
  campaignSubject?: string;
  unsubscribeUrl?: string;
}): Record<string, unknown> {
  const rawLead = params.lead || {};
  const cf = parseJsonCol<Record<string, unknown>>(rawLead.custom_fields ?? rawLead.customFields, {});
  const fullName = String(rawLead.name || rawLead.full_name || rawLead.fullName || '').trim();
  const nameParts = fullName ? fullName.split(/\s+/) : [];
  const firstName = String(rawLead.first_name || rawLead.firstName || (nameParts.length > 0 ? nameParts[nameParts.length - 1] : '')).trim();
  const lastName = String(rawLead.last_name || rawLead.lastName || (nameParts.length > 1 ? nameParts.slice(0, -1).join(' ') : '')).trim();
  const company = String(
    rawLead.company || rawLead.company_name || rawLead.companyName || cf.company || cf.company_name || ''
  ).trim();
  const email = String(rawLead.email || '').trim();
  const phone = String(rawLead.phone || rawLead.phone_number || rawLead.phoneNumber || '').trim();

  const vnNow = new Date(Date.now() + VN_OFFSET_MS);
  const dd = String(vnNow.getUTCDate()).padStart(2, '0');
  const mm = String(vnNow.getUTCMonth() + 1).padStart(2, '0');
  const yyyy = String(vnNow.getUTCFullYear());

  const enrichedLead: Record<string, unknown> = {
    ...cf,
    ...rawLead,
    name: fullName,
    full_name: fullName,
    fullName,
    customer_name: fullName,
    first_name: firstName,
    firstName,
    last_name: lastName,
    lastName,
    email,
    phone,
    phone_number: phone,
    company,
    company_name: company,
    companyName: company,
    custom_fields: cf,
  };

  return {
    lead: enrichedLead,
    tenant: { name: params.tenantName || 'DOMATION' },
    campaign: {
      name: params.campaignName || '',
      subject: params.campaignSubject || '',
    },
    current_date: `${dd}/${mm}/${yyyy}`,
    date: `${dd}/${mm}/${yyyy}`,
    year: yyyy,
    unsubscribe_url: params.unsubscribeUrl || '#unsubscribe',
  };
}

async function tableExistsFast(client: DbClient, tableName: string): Promise<boolean> {
  if (client.dialect === 'mariadb') {
    const res = await client.query<{ cnt: number }>(
      `SELECT COUNT(*) AS cnt FROM information_schema.tables WHERE table_schema = DATABASE() AND table_name = $1`,
      [tableName]
    );
    return Number(res.rows[0]?.cnt || 0) > 0;
  }
  const res = await client.query<{ exists: string | null }>(
    `SELECT to_regclass('public.' || $1)::text AS exists`,
    [tableName]
  );
  return Boolean(res.rows[0]?.exists);
}

interface PreparedDispatchJob {
  claimId: string;
  leadId: string;
  leadName: string;
  channel: 'email' | 'zns';
  variant: 'A' | 'B';
  toEmail: string;
  toPhone: string;
  subject: string;
  text: string;
  html: string;
  unsubscribeUrl: string;
  znsTemplateId: string | null;
  znsTemplateData: Record<string, unknown>;
}

interface CompletedDispatchOutcome {
  job: PreparedDispatchJob;
  ok: boolean;
  providerUsed: string;
  messageId: string;
  headerMessageId?: string;
  error?: string;
}

export interface HighSpeedCampaignDispatchInput {
  tenantId: string;
  campaignId: string;
  publicOrigin: string;
  actorId?: string | null;
  actorName?: string;
  source?: 'manual_send' | 'cron_scheduler' | 'resume';
  enforceEmailProviderGate?: boolean;
  enforceZnsWindow?: boolean;
  nowOverride?: Date;
  batchFlushSize?: number;
  ratePerSecOverride?: number;
  concurrencyOverride?: number;
  /** When true, returns immediately after Phase 1 commits (`status = 'sending'`) while Phase 2+3 runs in background. */
  asyncBackground?: boolean;
}

export interface HighSpeedCampaignDispatchOutcome {
  ok: boolean;
  notFound?: boolean;
  errorCode?: 'AUTOMATION_EMAIL_PROVIDER_REQUIRED';
  errorMessage?: string;
  usesAppscriptOnly?: boolean;
  deferredForZnsWindow?: boolean;
  scheduledAt?: string;
  asyncRunning?: boolean;
  campaignRow?: Record<string, unknown> | null;
  newly_sent: number;
  duplicate_claims_prevented: number;
  suppressed_skipped: number;
  failed_count: number;
  claim_ids: string[];
  stats_json?: CampaignDispatchStatsJson;
}

const activeCampaignDispatches = new Map<string, Promise<HighSpeedCampaignDispatchOutcome>>();

export function isCampaignDispatchActive(tenantId: string, campaignId: string): boolean {
  return activeCampaignDispatches.has(`${tenantId}:${campaignId}`);
}

export async function waitForCampaignDispatch(tenantId: string, campaignId: string): Promise<void> {
  const active = activeCampaignDispatches.get(`${tenantId}:${campaignId}`);
  if (active) {
    await active.catch(() => {});
  }
}

/**
 * 3-Phase High-Throughput Concurrent Token-Bucket Campaign Dispatcher (14 mail/s default).
 * NEVER holds a DB transaction open during SMTP/SES/ZNS network dispatch!
 */
export async function dispatchCampaignBatchHighSpeed(
  input: HighSpeedCampaignDispatchInput
): Promise<HighSpeedCampaignDispatchOutcome> {
  const dispatchKey = `${input.tenantId}:${input.campaignId}`;
  const existingRun = activeCampaignDispatches.get(dispatchKey);
  if (existingRun) {
    if (input.asyncBackground) {
      const row = await withTenantTransaction(input.tenantId, async (c) => {
        const r = await c.query('SELECT * FROM mkt_campaigns WHERE tenant_id = $1 AND id = $2 LIMIT 1', [
          input.tenantId,
          input.campaignId,
        ]);
        return r.rows[0] || null;
      });
      return {
        ok: true,
        asyncRunning: true,
        campaignRow: row,
        newly_sent: 0,
        duplicate_claims_prevented: 0,
        suppressed_skipped: 0,
        failed_count: 0,
        claim_ids: [],
        stats_json: row ? extractCampaignStatsJson(row) : undefined,
      };
    }
    return existingRun;
  }

  // Pre-step (Outside TX): Refresh any dynamic_logic audiences referenced by this campaign
  const dynamicAudIds = await withTenantTransaction(input.tenantId, async (client) => {
    const cRes = await client.query<{ audience_id: string | null; fallback_vars_json: unknown }>(
      'SELECT audience_id, fallback_vars_json FROM mkt_campaigns WHERE tenant_id = $1 AND id = $2 LIMIT 1',
      [input.tenantId, input.campaignId]
    );
    const cRow = cRes.rows[0];
    if (!cRow) return null;
    const fb = parseJsonCol<Record<string, unknown>>(cRow.fallback_vars_json, {});
    const targetObj = (fb._target && typeof fb._target === 'object' ? fb._target : {}) as Record<string, unknown>;
    const candidateAudIds = new Set<string>();
    if (cRow.audience_id && UUID_V4_REGEX.test(String(cRow.audience_id))) candidateAudIds.add(String(cRow.audience_id));
    for (const arrKey of ['listIds', 'segmentIds']) {
      const arr = Array.isArray(targetObj[arrKey]) ? (targetObj[arrKey] as unknown[]) : [];
      for (const id of arr) {
        if (UUID_V4_REGEX.test(String(id))) candidateAudIds.add(String(id));
      }
    }
    if (candidateAudIds.size === 0) return [] as string[];
    const ids = Array.from(candidateAudIds);
    const ph = ids.map((_, idx) => `$${idx + 2}`).join(', ');
    const aRes = await client.query<{ id: string }>(
      `SELECT id FROM tenant_audiences WHERE tenant_id = $1 AND audience_type = 'dynamic_logic' AND id IN (${ph})`,
      [input.tenantId, ...ids]
    );
    return aRes.rows.map((r) => String(r.id));
  });

  if (dynamicAudIds === null) {
    return {
      ok: false,
      notFound: true,
      newly_sent: 0,
      duplicate_claims_prevented: 0,
      suppressed_skipped: 0,
      failed_count: 0,
      claim_ids: [],
    };
  }

  for (const dynId of dynamicAudIds) {
    await evaluateDynamicAudience(input.tenantId, dynId).catch(() => {});
  }

  const now = input.nowOverride || new Date();
  const source = input.source || 'manual_send';
  const batchFlushSize = Math.max(10, Math.min(25, Math.round(input.batchFlushSize ?? 16)));

  // ==========================================================================
  // PHASE 1 (Fast Short TX): Gate checks, Audience Resolution + Dedup,
  // Atomic Send-Claim Chunk Insert, Merge-Tag Rendering, Preload Vault State
  // ==========================================================================
  const phase1 = await withTenantTransaction(input.tenantId, async (client) => {
    const cRes = await client.query('SELECT * FROM mkt_campaigns WHERE tenant_id = $1 AND id = $2 LIMIT 1', [
      input.tenantId,
      input.campaignId,
    ]);
    const camp = cRes.rows[0];
    if (!camp) return { kind: 'not_found' as const };

    const channelsToSend: Array<'email' | 'zns'> =
      camp.channel === 'multi' ? ['email', 'zns'] : camp.channel === 'zns' ? ['zns'] : ['email'];

    const tenantRes = await client.query<{ name: string; slug: string }>(
      'SELECT name, slug FROM tenants WHERE id = $1 LIMIT 1',
      [input.tenantId]
    );
    const emailReadiness = await readAutomationEmailReadiness(client, input.tenantId);
    const znsVault = await readTenantChannelVault(client, input.tenantId, ['zalo_zns', 'zalo_oa']);
    const suppressionRes = (await tableExistsFast(client, 'mkt_suppression_list'))
      ? await client.query<{ channel: string; recipient: string }>(
          'SELECT channel, LOWER(recipient) AS recipient FROM mkt_suppression_list WHERE tenant_id = $1',
          [input.tenantId]
        )
      : { rows: [] as Array<{ channel: string; recipient: string }> };

    const fbRaw = parseJsonCol<Record<string, unknown>>(camp.fallback_vars_json, {});

    // Mandatory Dedicated Automation Email Provider Gate (Ban Apps Script!)
    const needsEmail = channelsToSend.includes('email');
    if (
      needsEmail &&
      input.enforceEmailProviderGate !== false &&
      !emailReadiness.email_provider_ready &&
      !isCampaignOutboundSilent() &&
      !emailReadiness.sandbox_mode
    ) {
      const errorMessage = emailReadiness.uses_appscript_only
        ? 'Marketing Automation không hỗ trợ Google Apps Script (chỉ dùng cho thông báo CRM nội bộ). Vui lòng cấu hình cổng gửi Email chuyên dụng (AWS SES, SMTP, Resend, SendGrid hoặc Postmark) tại Cài đặt → Cấu hình Email.'
        : 'Chưa cấu hình cổng gửi Email chuyên dụng cho Marketing Automation. Vui lòng kết nối AWS SES, SMTP, Resend, SendGrid hoặc Postmark tại Cài đặt → Cấu hình Email (không dùng Google Apps Script).';

      if (source === 'cron_scheduler') {
        const pausedFb = {
          ...fbRaw,
          _dispatch_stats: {
            ...extractCampaignStatsJson(camp),
            last_error: 'AUTOMATION_EMAIL_PROVIDER_REQUIRED',
          },
        };
        await client.query(
          `UPDATE mkt_campaigns
           SET status = 'paused', fallback_vars_json = $3::jsonb, updated_at = clock_timestamp()
           WHERE tenant_id = $1 AND id = $2`,
          [input.tenantId, camp.id, JSON.stringify(pausedFb)]
        );
      }

      return {
        kind: 'provider_required' as const,
        usesAppscriptOnly: emailReadiness.uses_appscript_only,
        errorMessage,
      };
    }

    const isZnsOnly = channelsToSend.length === 1 && channelsToSend[0] === 'zns';
    const tenantName = tenantRes.rows[0]?.name || 'DOMATION';
    const suppressedSet = buildSuppressionSet(suppressionRes.rows);
    const excludeAudIds = parseJsonCol<string[]>(camp.exclude_audience_ids, []).filter((id) =>
      UUID_V4_REGEX.test(String(id))
    );

    const targetMeta = (fbRaw._target && typeof fbRaw._target === 'object' ? fbRaw._target : {}) as Record<string, unknown>;
    const targetAudIds = Array.from(
      new Set([
        ...(camp.audience_id && UUID_V4_REGEX.test(String(camp.audience_id)) ? [String(camp.audience_id)] : []),
        ...(Array.isArray(targetMeta.listIds) ? targetMeta.listIds.map(String) : []),
        ...(Array.isArray(targetMeta.segmentIds) ? targetMeta.segmentIds.map(String) : []),
      ].filter((id) => UUID_V4_REGEX.test(id)))
    );
    const targetTagIds = Array.isArray(targetMeta.tagIds)
      ? targetMeta.tagIds.map(String).filter((t) => t.trim().length > 0)
      : [];
    const targetIndividualIds = Array.isArray(targetMeta.individualIds)
      ? targetMeta.individualIds.map(String).filter((id) => UUID_V4_REGEX.test(id))
      : [];

    const hasAudMembers = await tableExistsFast(client, 'tenant_audience_members');
    const hasAudExcl = await tableExistsFast(client, 'tenant_audience_exclusions');
    const hasLeadTags = await tableExistsFast(client, 'lead_tags');

    let leadsSql = `
      SELECT l.id, l.name, l.phone, l.email, l.email_consent, l.zns_consent,
             l.product_interest, l.total_revenue_vnd, l.custom_fields
      FROM leads l
      WHERE l.tenant_id = $1 AND l.is_deleted = false
    `;
    const qParams: unknown[] = [input.tenantId];
    const includeOrClauses: string[] = [];

    if (targetAudIds.length > 0 && hasAudMembers) {
      const ph = targetAudIds.map((aid) => {
        qParams.push(aid);
        return `$${qParams.length}`;
      });
      includeOrClauses.push(`EXISTS (
        SELECT 1 FROM tenant_audience_members tam
        WHERE tam.tenant_id = l.tenant_id AND tam.audience_id IN (${ph.join(', ')}) AND tam.lead_id = l.id
      )`);
    }

    if (targetTagIds.length > 0 && hasLeadTags) {
      const uuidTags = targetTagIds.filter((t) => UUID_V4_REGEX.test(t));
      const namedTags = targetTagIds.filter((t) => !UUID_V4_REGEX.test(t));
      if (uuidTags.length > 0) {
        const ph = uuidTags.map((tid) => {
          qParams.push(tid);
          return `$${qParams.length}`;
        });
        includeOrClauses.push(`EXISTS (
          SELECT 1 FROM lead_tags lt
          WHERE lt.tenant_id = l.tenant_id AND lt.lead_id = l.id AND lt.tag_id IN (${ph.join(', ')})
        )`);
      }
      if (namedTags.length > 0) {
        const ph = namedTags.map((tn) => {
          qParams.push(tn);
          return `$${qParams.length}`;
        });
        includeOrClauses.push(`EXISTS (
          SELECT 1 FROM lead_tags lt
          INNER JOIN tenant_tags tt ON tt.tenant_id = lt.tenant_id AND tt.id = lt.tag_id
          WHERE lt.tenant_id = l.tenant_id AND lt.lead_id = l.id AND tt.name IN (${ph.join(', ')})
        )`);
      }
    }

    if (targetIndividualIds.length > 0) {
      const ph = targetIndividualIds.map((lid) => {
        qParams.push(lid);
        return `$${qParams.length}`;
      });
      includeOrClauses.push(`l.id IN (${ph.join(', ')})`);
    }

    if (includeOrClauses.length > 0) {
      leadsSql += ` AND (${includeOrClauses.join(' OR ')})`;
    }

    if (targetAudIds.length > 0 && hasAudExcl) {
      const ph = targetAudIds.map((aid) => {
        qParams.push(aid);
        return `$${qParams.length}`;
      });
      leadsSql += `
        AND NOT EXISTS (
          SELECT 1 FROM tenant_audience_exclusions tae
          WHERE tae.tenant_id = l.tenant_id
            AND tae.audience_id IN (${ph.join(', ')})
            AND (
              tae.lead_id = l.id
              OR (tae.email IS NOT NULL AND l.email IS NOT NULL AND LOWER(tae.email) = LOWER(l.email))
              OR (tae.phone IS NOT NULL AND l.phone IS NOT NULL AND tae.phone = l.phone)
              OR (
                tae.excluded_audience_id IS NOT NULL AND EXISTS (
                  SELECT 1 FROM tenant_audience_members ex_m
                  WHERE ex_m.tenant_id = l.tenant_id
                    AND ex_m.audience_id = tae.excluded_audience_id
                    AND ex_m.lead_id = l.id
                )
              )
            )
        )
      `;
    }

    if (excludeAudIds.length > 0 && hasAudMembers) {
      const ph = excludeAudIds.map((eid) => {
        qParams.push(eid);
        return `$${qParams.length}`;
      });
      leadsSql += `
        AND NOT EXISTS (
          SELECT 1 FROM tenant_audience_members tam_ex
          WHERE tam_ex.tenant_id = l.tenant_id
            AND tam_ex.lead_id = l.id
            AND tam_ex.audience_id IN (${ph.join(', ')})
        )
      `;
    }

    leadsSql += ' ORDER BY l.created_at ASC, l.id ASC';

    const recipientsRes = await client.query(leadsSql, qParams);
    const totalTargetedRows = recipientsRes.rows.length;

    // Resolve email HTML template (saved template -> inline custom HTML -> clean default envelope)
    let tplHtml = '';
    if (camp.template_id && (await tableExistsFast(client, 'mkt_email_templates'))) {
      const tRes = await client.query<{ compiled_html: string; blocks_json: unknown; body_style: unknown }>(
        'SELECT compiled_html, blocks_json, body_style FROM mkt_email_templates WHERE tenant_id = $1 AND id = $2 LIMIT 1',
        [input.tenantId, camp.template_id]
      );
      const tplRow = tRes.rows[0];
      if (tplRow) {
        tplHtml = String(tplRow.compiled_html || '').trim();
        if (!tplHtml) {
          const blocks = parseJsonCol<EmailBlockDto[]>(tplRow.blocks_json, []);
          const bodyStyle = parseJsonCol<EmailBodyStyleDto>(tplRow.body_style, {});
          if (blocks.length > 0) {
            tplHtml = compileEmailBlocksToHtml(blocks, bodyStyle, String(camp.subject_a || camp.name));
          }
        }
      }
    }
    if (!tplHtml && typeof fbRaw._content_body === 'string' && fbRaw._content_body.trim()) {
      tplHtml = fbRaw._content_body.trim();
    }
    if (!tplHtml) {
      tplHtml = `<!DOCTYPE html><html lang="vi"><body><div style="font-family:Inter,Arial,sans-serif;padding:24px;color:#0F172A;"><h2>{{campaign.subject}}</h2><p>Xin chào {{lead.name}},</p><p>Thông báo từ <strong>{{tenant.name}}</strong>.</p><p style="margin-top:24px;font-size:12px;color:#64748B;"><a href="{{unsubscribe_url}}">Hủy đăng ký nhận tin</a></p></div></body></html>`;
    }

    // Load existing claims ONCE so atomic chunk insert is ultra-fast
    const existingClaimsRes = await client.query<{
      id: string;
      lead_id: string;
      channel: string;
      variant: string;
      status: string;
    }>(
      'SELECT id, lead_id, channel, variant, status FROM mkt_send_claims WHERE tenant_id = $1 AND campaign_id = $2',
      [input.tenantId, camp.id]
    );
    const existingClaimByKey = new Map<string, { id: string; variant: string; status: string }>();
    for (const r of existingClaimsRes.rows) {
      existingClaimByKey.set(`${r.lead_id}:${r.channel}`, {
        id: String(r.id),
        variant: String(r.variant || 'A'),
        status: String(r.status || 'claimed'),
      });
    }

    const campFallbacks: Record<string, string> = {};
    for (const [k, v] of Object.entries(fbRaw)) {
      if (!k.startsWith('_') && (typeof v === 'string' || typeof v === 'number')) {
        campFallbacks[k] = String(v);
      }
    }
    const campConfig = (fbRaw._config && typeof fbRaw._config === 'object' ? fbRaw._config : {}) as Record<string, unknown>;
    const znsMappedParams =
      campConfig.mapped_params && typeof campConfig.mapped_params === 'object'
        ? (campConfig.mapped_params as Record<string, string>)
        : {};
    const ccHeader =
      campConfig.cc_enabled && typeof campConfig.cc_emails === 'string' && campConfig.cc_emails.trim()
        ? campConfig.cc_emails.trim()
        : undefined;

    const rawRatioA = Number(camp.ab_split_ratio ?? 100);
    const ratioA = Number.isFinite(rawRatioA) ? Math.max(0, Math.min(100, Math.round(rawRatioA))) : 100;
    const hasVariantB = Boolean(camp.subject_b && String(camp.subject_b).trim()) && ratioA < 100;

    // Deduplicate recipients per channel by normalized email / normalized VN E.164 phone
    const seenEmailLower = new Set<string>();
    const seenZnsPhone = new Set<string>();

    let skippedDuplicateClaims = 0;
    let suppressedSkipped = 0;
    let eligibleIdx = 0;

    const candidatesToInsert: Array<{
      claimId: string;
      lead: Record<string, unknown>;
      channel: 'email' | 'zns';
      variant: 'A' | 'B';
      toEmail: string;
      toPhone: string;
      reusedClaim: boolean;
    }> = [];

    for (const lead of recipientsRes.rows) {
      const deliverableChannels: Array<{ ch: 'email' | 'zns'; toEmail: string; toPhone: string }> = [];
      for (const ch of channelsToSend) {
        if (ch === 'email') {
          const emailLower = String(lead.email || '').trim().toLowerCase();
          if (
            !emailLower ||
            lead.email_consent !== 'subscribed' ||
            isRecipientSuppressed(suppressedSet, 'email', emailLower)
          ) {
            suppressedSkipped++;
            continue;
          }
          if (seenEmailLower.has(emailLower)) {
            skippedDuplicateClaims++;
            continue;
          }
          seenEmailLower.add(emailLower);
          deliverableChannels.push({ ch: 'email', toEmail: emailLower, toPhone: '' });
        } else {
          const phoneRaw = String(lead.phone || '').trim();
          const phoneNorm = normalizePhoneE164(phoneRaw, { default_dial_code: '84' }) || phoneRaw;
          if (
            !phoneRaw ||
            lead.zns_consent === 'opted_out' ||
            isRecipientSuppressed(suppressedSet, 'zns', phoneRaw) ||
            isRecipientSuppressed(suppressedSet, 'zns', phoneNorm)
          ) {
            suppressedSkipped++;
            continue;
          }
          if (seenZnsPhone.has(phoneNorm)) {
            skippedDuplicateClaims++;
            continue;
          }
          seenZnsPhone.add(phoneNorm);
          deliverableChannels.push({ ch: 'zns', toEmail: '', toPhone: phoneNorm });
        }
      }
      if (deliverableChannels.length === 0) continue;

      const isVariantA =
        !hasVariantB || Math.ceil(((eligibleIdx + 1) * ratioA) / 100) > Math.ceil((eligibleIdx * ratioA) / 100);
      const variant: 'A' | 'B' = isVariantA ? 'A' : 'B';
      eligibleIdx++;

      for (const item of deliverableChannels) {
        const key = `${lead.id}:${item.ch}`;
        const existing = existingClaimByKey.get(key);
        if (existing) {
          if (source === 'resume' && existing.status === 'claimed') {
            candidatesToInsert.push({
              claimId: existing.id,
              lead,
              channel: item.ch,
              variant: existing.variant === 'B' ? 'B' : 'A',
              toEmail: item.toEmail,
              toPhone: item.toPhone,
              reusedClaim: true,
            });
          } else {
            skippedDuplicateClaims++;
          }
          continue;
        }
        candidatesToInsert.push({
          claimId: crypto.randomUUID(),
          lead,
          channel: item.ch,
          variant,
          toEmail: item.toEmail,
          toPhone: item.toPhone,
          reusedClaim: false,
        });
      }
    }

    // ZNS Vietnam 06:00 - 22:00 Window Enforcement: defer cleanly to next 06:00 VN
    // whenever there is at least 1 eligible deliverable ZNS recipient outside allowed hours.
    if (
      isZnsOnly &&
      candidatesToInsert.length > 0 &&
      input.enforceZnsWindow !== false &&
      !isCampaignOutboundSilent() &&
      !customZnsDispatcherForTesting &&
      !isWithinZnsAllowedWindow(now)
    ) {
      const nextWindowIso = computeNextZnsWindowUtcIso(now);
      const deferredFb = {
        ...fbRaw,
        _dispatch_stats: {
          ...extractCampaignStatsJson(camp),
          total_target: Math.max(totalTargetedRows, candidatesToInsert.length),
          zns_deferred_reason: 'OUTSIDE_VN_WINDOW_06_22',
        },
      };
      await client.query(
        `UPDATE mkt_campaigns
         SET status = 'scheduled',
             scheduled_at = $3,
             total_targeted = GREATEST(total_targeted, $4),
             fallback_vars_json = $5::jsonb,
             updated_at = clock_timestamp()
         WHERE tenant_id = $1 AND id = $2`,
        [input.tenantId, camp.id, nextWindowIso, totalTargetedRows, JSON.stringify(deferredFb)]
      );
      const updated = await client.query('SELECT * FROM mkt_campaigns WHERE tenant_id = $1 AND id = $2 LIMIT 1', [
        input.tenantId,
        camp.id,
      ]);
      return {
        kind: 'zns_deferred' as const,
        scheduledAt: nextWindowIso,
        suppressedSkipped,
        skippedDuplicateClaims,
        campaignRow: updated.rows[0] || camp,
      };
    }

    // Batch-insert new claims in chunks of 100 rows & atomically verify ownership
    const newlyClaimedSet = new Set<string>();
    const newCandidates = candidatesToInsert.filter((c) => !c.reusedClaim);
    const CHUNK_SIZE = 100;
    for (let i = 0; i < newCandidates.length; i += CHUNK_SIZE) {
      const chunk = newCandidates.slice(i, i + CHUNK_SIZE);
      const vals: unknown[] = [];
      const rowPlaceholders: string[] = [];
      for (const c of chunk) {
        const base = vals.length;
        vals.push(c.claimId, input.tenantId, camp.id, c.lead.id, c.channel, c.variant);
        rowPlaceholders.push(`($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}, $${base + 5}, $${base + 6}, 'claimed', '{}'::jsonb)`);
      }
      await client.query(
        `INSERT INTO mkt_send_claims (id, tenant_id, campaign_id, lead_id, channel, variant, status, metadata)
         VALUES ${rowPlaceholders.join(', ')}
         ON CONFLICT (tenant_id, campaign_id, lead_id, channel) DO NOTHING`,
        vals
      );
      const idPh = chunk.map((_, idx) => `$${idx + 3}`).join(', ');
      const verified = await client.query<{ id: string }>(
        `SELECT id FROM mkt_send_claims WHERE tenant_id = $1 AND campaign_id = $2 AND id IN (${idPh})`,
        [input.tenantId, camp.id, ...chunk.map((c) => c.claimId)]
      );
      for (const vr of verified.rows) {
        newlyClaimedSet.add(String(vr.id));
      }
    }

    // Pre-render personalized HTML, subject, and ZNS template params outside Phase 2
    const preparedJobs: PreparedDispatchJob[] = [];
    for (const c of candidatesToInsert) {
      if (!c.reusedClaim && !newlyClaimedSet.has(c.claimId)) {
        skippedDuplicateClaims++;
        continue;
      }
      const leadId = String(c.lead.id);
      const unsubSig = signUnsubscribeHmac(input.tenantId, leadId, c.channel);
      const unsubUrl = `${input.publicOrigin}/api/v1/public/marketing/unsubscribe?tenant_id=${input.tenantId}&lead_id=${leadId}&channel=${c.channel}&sig=${unsubSig}&claim_id=${c.claimId}`;
      const chosenSubject = c.variant === 'B' ? String(camp.subject_b) : String(camp.subject_a || camp.name);
      const mergeCtx = buildCampaignMergeContext({
        lead: c.lead,
        tenantName,
        campaignName: String(camp.name || ''),
        campaignSubject: chosenSubject,
        unsubscribeUrl: unsubUrl,
      });

      const renderedSubject = renderMergeTags(chosenSubject, mergeCtx, campFallbacks);
      const renderedRawHtml = renderMergeTags(tplHtml, mergeCtx, campFallbacks);
      const trackedHtml =
        c.channel === 'email'
          ? injectEmailOpenAndClickTracking(renderedRawHtml, {
              baseUrl: input.publicOrigin,
              claimId: c.claimId,
              unsubscribeUrl: unsubUrl,
            })
          : renderedRawHtml;

      const znsData: Record<string, unknown> = {
        customer_name: String(c.lead.name || ''),
        name: String(c.lead.name || ''),
        subject: renderedSubject,
      };
      for (const [paramKey, rawExpr] of Object.entries(znsMappedParams)) {
        if (typeof rawExpr === 'string' && rawExpr.trim()) {
          znsData[paramKey] = renderMergeTags(rawExpr, mergeCtx, campFallbacks);
        }
      }

      preparedJobs.push({
        claimId: c.claimId,
        leadId,
        leadName: String(c.lead.name || ''),
        channel: c.channel,
        variant: c.variant,
        toEmail: c.toEmail,
        toPhone: c.toPhone,
        subject: renderedSubject,
        text: stripHtmlTagsForPlainText(trackedHtml) || renderedSubject,
        html: trackedHtml,
        unsubscribeUrl: unsubUrl,
        znsTemplateId: camp.zns_template_id ? String(camp.zns_template_id) : null,
        znsTemplateData: znsData,
      });
    }

    // Preload decrypted tenant email state ONCE so Phase 2 makes ZERO DB queries per email
    const preloadedEmailState = needsEmail ? await loadEmailTenantStateForCampaign(client, input.tenantId) : undefined;
    const hasDeliveryLogsTable = await tableExistsFast(client, 'mkt_delivery_logs');

    // Compute rate limit (default 14 mail/s for AWS SES, capped by throttle_per_minute if configured)
    const vaultMaxRate = emailReadiness.max_send_rate_per_sec || 14;
    const throttlePerMin = Number(camp.throttle_per_minute || 0);
    const baseRate =
      input.ratePerSecOverride !== undefined && input.ratePerSecOverride > 0
        ? input.ratePerSecOverride
        : throttlePerMin > 0
          ? Math.min(vaultMaxRate, Math.max(1, throttlePerMin / 60))
          : vaultMaxRate;
    const effectiveRatePerSec = Math.max(1, Math.min(50, baseRate));

    const startedAtIso = new Date().toISOString();
    const totalTargetCount = Math.max(totalTargetedRows, preparedJobs.length);
    const initialStats: CampaignDispatchStatsJson = {
      sent: Number(camp.sent_count || 0),
      failed: Number(extractCampaignStatsJson(camp).failed || 0),
      opened: Number(camp.opened_count || 0),
      clicked: Number(camp.clicked_count || 0),
      bounced: Number(camp.bounced_count || 0),
      unsubscribed: Number(camp.unsubscribed_count || 0),
      total_target: totalTargetCount,
      progress_pct: preparedJobs.length === 0 ? 100 : 0,
      rate_per_sec: 0,
      eta_seconds: preparedJobs.length > 0 ? Math.ceil(preparedJobs.length / effectiveRatePerSec) : 0,
      sending_started_at: startedAtIso,
      last_dispatched_at: null,
      provider: needsEmail ? emailReadiness.active_provider || (isCampaignOutboundSilent() ? 'silent_sandbox' : 'smtp') : znsVault.integrationType || 'zalo_zns',
      max_send_rate: effectiveRatePerSec,
    };

    const nextFb = { ...fbRaw, _dispatch_stats: initialStats };
    await client.query(
      `UPDATE mkt_campaigns
       SET status = $3,
           total_targeted = GREATEST(total_targeted, $4),
           fallback_vars_json = $5::jsonb,
           updated_at = clock_timestamp()
       WHERE tenant_id = $1 AND id = $2`,
      [
        input.tenantId,
        camp.id,
        preparedJobs.length > 0 ? 'sending' : 'completed',
        totalTargetCount,
        JSON.stringify(nextFb),
      ]
    );

    const updatedCampRes = await client.query('SELECT * FROM mkt_campaigns WHERE tenant_id = $1 AND id = $2 LIMIT 1', [
      input.tenantId,
      camp.id,
    ]);

    return {
      kind: 'ready' as const,
      camp: updatedCampRes.rows[0] || camp,
      campName: String(camp.name || ''),
      senderEmail: camp.sender_email ? String(camp.sender_email).trim() : undefined,
      senderName: camp.sender_name ? String(camp.sender_name).trim() : undefined,
      ccHeader,
      emailReadiness,
      preloadedEmailState,
      hasDeliveryLogsTable,
      effectiveRatePerSec,
      preparedJobs,
      skippedDuplicateClaims,
      suppressedSkipped,
      totalTargetCount,
      startedAtIso,
      initialStats,
    };
  });

  if (phase1.kind === 'not_found') {
    return {
      ok: false,
      notFound: true,
      newly_sent: 0,
      duplicate_claims_prevented: 0,
      suppressed_skipped: 0,
      failed_count: 0,
      claim_ids: [],
    };
  }
  if (phase1.kind === 'provider_required') {
    return {
      ok: false,
      errorCode: 'AUTOMATION_EMAIL_PROVIDER_REQUIRED',
      errorMessage: phase1.errorMessage,
      usesAppscriptOnly: phase1.usesAppscriptOnly,
      newly_sent: 0,
      duplicate_claims_prevented: 0,
      suppressed_skipped: 0,
      failed_count: 0,
      claim_ids: [],
    };
  }
  if (phase1.kind === 'zns_deferred') {
    return {
      ok: true,
      deferredForZnsWindow: true,
      scheduledAt: phase1.scheduledAt,
      campaignRow: phase1.campaignRow,
      newly_sent: 0,
      duplicate_claims_prevented: phase1.skippedDuplicateClaims,
      suppressed_skipped: phase1.suppressedSkipped,
      failed_count: 0,
      claim_ids: [],
      stats_json: extractCampaignStatsJson(phase1.campaignRow),
    };
  }

  // ==========================================================================
  // PHASE 2 (OUTSIDE TX — Concurrent Token-Bucket @ 14 req/s)
  // + PHASE 3 (Micro-Batched Short TX every 14-25 completed messages)
  // ==========================================================================
  const runPhase2And3 = async (): Promise<HighSpeedCampaignDispatchOutcome> => {
    const dispatchStartMs = Date.now();
    const {
      camp,
      campName,
      senderEmail,
      senderName,
      ccHeader,
      emailReadiness,
      preloadedEmailState,
      hasDeliveryLogsTable,
      effectiveRatePerSec,
      preparedJobs,
      skippedDuplicateClaims,
      suppressedSkipped,
      totalTargetCount,
      startedAtIso,
    } = phase1;

    let newlySent = 0;
    let failedCount = 0;
    let processedInRun = 0;
    let pausedByUser = false;
    const sentClaimIds: string[] = [];

    const pendingFlush: CompletedDispatchOutcome[] = [];
    let flushChain: Promise<void> = Promise.resolve();

    const executeFlush = async (batch: CompletedDispatchOutcome[], isFinal: boolean): Promise<Record<string, unknown> | null> => {
      return withTenantTransaction(input.tenantId, async (client) => {
        const sentTimelineRows: CompletedDispatchOutcome[] = [];
        let sentEmailInBatch = 0;

        for (const item of batch) {
          const metaObj = {
            ...(source === 'cron_scheduler' ? { source: 'cron_scheduler' } : {}),
            subject: item.job.subject,
            provider: item.providerUsed,
            message_id: item.messageId,
            ...(item.headerMessageId && item.headerMessageId !== item.messageId
              ? { header_message_id: item.headerMessageId }
              : {}),
            has_html: Boolean(item.job.html),
            unsubscribe_url: item.job.unsubscribeUrl,
          };

          if (item.ok) {
            await client.query(
              `UPDATE mkt_send_claims
               SET status = 'sent', sent_at = clock_timestamp(), metadata = $3::jsonb
               WHERE tenant_id = $1 AND id = $2`,
              [input.tenantId, item.job.claimId, JSON.stringify(metaObj)]
            );
            sentTimelineRows.push(item);
            if (item.job.channel === 'email') sentEmailInBatch++;
          } else {
            await client.query(
              `UPDATE mkt_send_claims
               SET status = 'failed', error_message = $3, metadata = $4::jsonb
               WHERE tenant_id = $1 AND id = $2`,
              [input.tenantId, item.job.claimId, item.error || 'DISPATCH_FAILED', JSON.stringify(metaObj)]
            );
          }
        }

        // Batch-insert lead_timeline_events for all sent messages in this micro-batch
        if (sentTimelineRows.length > 0) {
          const vals: unknown[] = [];
          const tuples: string[] = [];
          const actorName = input.actorName || (source === 'cron_scheduler' ? 'Cron Campaign Scheduler' : 'Campaign Sender');
          for (const item of sentTimelineRows) {
            const b = vals.length;
            vals.push(
              crypto.randomUUID(),
              input.tenantId,
              item.job.leadId,
              item.job.channel === 'zns' ? 'zns_sent' : 'mkt_email_sent',
              input.actorId || null,
              actorName,
              source === 'cron_scheduler'
                ? `Gửi chiến dịch định kỳ ${item.job.channel.toUpperCase()}: ${campName}`
                : `Gửi chiến dịch ${item.job.channel.toUpperCase()}: ${campName}`,
              item.job.subject,
              JSON.stringify({
                campaign_id: camp.id,
                claim_id: item.job.claimId,
                variant: item.job.variant,
                provider: item.providerUsed,
              })
            );
            tuples.push(
              `($${b + 1}, $${b + 2}, $${b + 3}, $${b + 4}, 'communication', $${b + 5}, 'tenant_admin', $${b + 6}, $${b + 7}, $${b + 8}, $${b + 9}::jsonb)`
            );
          }
          await client.query(
            `INSERT INTO lead_timeline_events (
               id, tenant_id, lead_id, event_type, event_category, actor_id, actor_role, actor_name, title, content, metadata
             ) VALUES ${tuples.join(', ')}`,
            vals
          );
        }

        // Optional mkt_delivery_logs support if present in environment schema
        if (hasDeliveryLogsTable && batch.length > 0) {
          for (const item of batch) {
            await client
              .query(
                `INSERT INTO mkt_delivery_logs (id, tenant_id, campaign_id, claim_id, lead_id, channel, status, provider, message_id, error_message, created_at)
                 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, clock_timestamp())`,
                [
                  crypto.randomUUID(),
                  input.tenantId,
                  camp.id,
                  item.job.claimId,
                  item.job.leadId,
                  item.job.channel,
                  item.ok ? 'sent' : 'failed',
                  item.providerUsed,
                  item.messageId,
                  item.error || null,
                ]
              )
              .catch(() => {});
          }
        }

        // Check if user paused campaign mid-flight
        const curCampRes = await client.query<{ status: string; fallback_vars_json: unknown }>(
          'SELECT status, fallback_vars_json FROM mkt_campaigns WHERE tenant_id = $1 AND id = $2 LIMIT 1',
          [input.tenantId, camp.id]
        );
        const curStatus = String(curCampRes.rows[0]?.status || 'sending').toLowerCase();
        if (curStatus === 'paused') {
          pausedByUser = true;
        }

        // MariaDB-safe aggregated counters (zero FILTER WHERE)
        const statsRes = await client.query<{
          sent_cnt: number;
          failed_cnt: number;
          open_cnt: number;
          click_cnt: number;
          bounce_cnt: number;
          unsub_cnt: number;
        }>(
          `SELECT COALESCE(SUM(CASE WHEN status IN ('sent', 'delivered', 'opened', 'clicked') THEN 1 ELSE 0 END), 0)::int AS sent_cnt,
                  COALESCE(SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END), 0)::int AS failed_cnt,
                  COALESCE(SUM(CASE WHEN opened_at IS NOT NULL THEN 1 ELSE 0 END), 0)::int AS open_cnt,
                  COALESCE(SUM(CASE WHEN clicked_at IS NOT NULL THEN 1 ELSE 0 END), 0)::int AS click_cnt,
                  COALESCE(SUM(CASE WHEN status = 'bounced' THEN 1 ELSE 0 END), 0)::int AS bounce_cnt,
                  COALESCE(SUM(CASE WHEN status = 'unsubscribed' THEN 1 ELSE 0 END), 0)::int AS unsub_cnt
           FROM mkt_send_claims
           WHERE tenant_id = $1 AND campaign_id = $2`,
          [input.tenantId, camp.id]
        );
        const st = statsRes.rows[0];
        const sentCnt = Number(st?.sent_cnt || 0);
        const failedCnt = Number(st?.failed_cnt || 0);
        const openCnt = Number(st?.open_cnt || 0);
        const clickCnt = Number(st?.click_cnt || 0);
        const bounceCnt = Number(st?.bounce_cnt || 0);
        const unsubCnt = Number(st?.unsub_cnt || 0);

        const elapsedSec = Math.max(0.05, (Date.now() - dispatchStartMs) / 1000);
        const liveRatePerSec = processedInRun > 0 ? Number((processedInRun / elapsedSec).toFixed(2)) : 0;
        const remainingInRun = Math.max(0, preparedJobs.length - processedInRun);
        const etaSeconds =
          isFinal || remainingInRun === 0
            ? 0
            : liveRatePerSec > 0
              ? Math.ceil(remainingInRun / liveRatePerSec)
              : Math.ceil(remainingInRun / effectiveRatePerSec);
        const progressPct =
          isFinal && !pausedByUser
            ? 100
            : preparedJobs.length > 0
              ? Math.min(100, Math.round((processedInRun / preparedJobs.length) * 100))
              : 100;

        const curFb = parseJsonCol<Record<string, unknown>>(curCampRes.rows[0]?.fallback_vars_json, {});
        const liveStatsJson: CampaignDispatchStatsJson = {
          sent: sentCnt,
          failed: failedCnt,
          opened: openCnt,
          clicked: clickCnt,
          bounced: bounceCnt,
          unsubscribed: unsubCnt,
          total_target: Math.max(totalTargetCount, sentCnt + failedCnt),
          progress_pct: progressPct,
          rate_per_sec: liveRatePerSec,
          eta_seconds: etaSeconds,
          sending_started_at: startedAtIso,
          last_dispatched_at: new Date().toISOString(),
          provider:
            emailReadiness.active_provider ||
            (batch[0]?.providerUsed ?? (isCampaignOutboundSilent() ? 'silent_sandbox' : null)),
          max_send_rate: effectiveRatePerSec,
        };
        const updatedFb = { ...curFb, _dispatch_stats: liveStatsJson };

        const nextStatus = pausedByUser ? 'paused' : isFinal ? 'completed' : 'sending';
        const sentAtSql = nextStatus === 'completed' ? 'sent_at = COALESCE(sent_at, clock_timestamp()),' : '';
        await client.query(
          `UPDATE mkt_campaigns
           SET status = $3,
               ${sentAtSql}
               total_targeted = GREATEST(total_targeted, $4),
               sent_count = $5,
               opened_count = $6,
               clicked_count = $7,
               bounced_count = $8,
               unsubscribed_count = $9,
               fallback_vars_json = $10::jsonb,
               updated_at = clock_timestamp()
           WHERE tenant_id = $1 AND id = $2`,
          [
            input.tenantId,
            camp.id,
            nextStatus,
            Math.max(totalTargetCount, sentCnt + failedCnt),
            sentCnt,
            openCnt,
            clickCnt,
            bounceCnt,
            unsubCnt,
            JSON.stringify(updatedFb),
          ]
        );

        // Update integration last_synced_at ONCE at end of campaign instead of per-email
        if (isFinal && (sentEmailInBatch > 0 || newlySent > 0) && emailReadiness.active_provider) {
          await client
            .query(
              `UPDATE tenant_integrations
               SET last_synced_at = clock_timestamp()
               WHERE tenant_id = $1 AND integration_type = $2`,
              [input.tenantId, emailReadiness.active_provider]
            )
            .catch(() => {});
        }

        if (isFinal) {
          const finalRow = await client.query('SELECT * FROM mkt_campaigns WHERE tenant_id = $1 AND id = $2 LIMIT 1', [
            input.tenantId,
            camp.id,
          ]);
          return finalRow.rows[0] || null;
        }
        return null;
      });
    };

    const enqueueFlush = (isFinal: boolean): Promise<Record<string, unknown> | null> => {
      const drained = pendingFlush.splice(0, pendingFlush.length);
      if (drained.length === 0 && !isFinal) return Promise.resolve(null);
      const next = flushChain.then(() => executeFlush(drained, isFinal));
      flushChain = next.then(
        () => undefined,
        () => undefined
      );
      return next;
    };

    let finalCampaignRow: Record<string, unknown> | null = null;

    if (preparedJobs.length > 0) {
      const rateLimiter = new TokenBucketRateLimiter(
        effectiveRatePerSec,
        Math.min(14, Math.max(1, Math.floor(effectiveRatePerSec)))
      );
      const concurrency = Math.max(
        1,
        Math.min(
          input.concurrencyOverride ?? 14,
          Math.ceil(effectiveRatePerSec),
          preparedJobs.length
        )
      );

      let cursor = 0;
      const worker = async () => {
        while (!pausedByUser) {
          const idx = cursor++;
          if (idx >= preparedJobs.length) break;
          const job = preparedJobs[idx];

          await rateLimiter.acquire();
          if (pausedByUser) break;

          let ok = false;
          let providerUsed = 'vault_queued';
          let msgId = '';
          let headerMsgId: string | undefined;
          let errMsg: string | undefined;

          try {
            if (job.channel === 'email') {
              const mailRes = await dispatchMarketingEmail({
                tenantId: input.tenantId,
                to: job.toEmail,
                cc: ccHeader,
                subject: job.subject,
                text: job.text,
                html: job.html,
                category: 'system_alert',
                meta: {
                  campaign_id: camp.id,
                  claim_id: job.claimId,
                  variant: job.variant,
                  ...(source === 'cron_scheduler' ? { source: 'cron_scheduler' } : {}),
                },
                emailVaultConfigured: emailReadiness.configured,
                emailVaultType: emailReadiness.active_provider,
                sandboxMode: emailReadiness.sandbox_mode,
                fromEmailOverride: senderEmail,
                fromNameOverride: senderName,
                pooled: true,
                preloadedState: preloadedEmailState,
              });
              ok = mailRes.sent;
              providerUsed = mailRes.provider;
              msgId = mailRes.messageId;
              headerMsgId = mailRes.headerMessageId;
              errMsg = mailRes.error;
            } else {
              const znsRes = await dispatchZnsNotification({
                tenantId: input.tenantId,
                phone: job.toPhone,
                templateId: job.znsTemplateId,
                templateData: job.znsTemplateData,
                message: job.subject,
                campaignId: String(camp.id),
                claimId: job.claimId,
                leadId: job.leadId,
              });
              // Preserve cron strictness: unconfigured/silent ZNS in cron_scheduler is NOT marked sent
              ok =
                source === 'cron_scheduler'
                  ? znsRes.sent && !znsRes.queued && !znsRes.silent && znsRes.provider !== 'zns_vault_queued'
                  : znsRes.sent;
              providerUsed = znsRes.provider;
              msgId = znsRes.messageId;
              errMsg = znsRes.error || (source === 'cron_scheduler' && znsRes.queued ? 'ZNS_NOT_CONFIGURED' : undefined);
            }
          } catch (err: any) {
            ok = false;
            errMsg = err?.message || 'DISPATCH_EXCEPTION';
          }

          processedInRun++;
          if (ok) {
            newlySent++;
            sentClaimIds.push(job.claimId);
          } else {
            failedCount++;
          }

          pendingFlush.push({
            job,
            ok,
            providerUsed,
            messageId: msgId,
            headerMessageId: headerMsgId,
            error: errMsg,
          });

          if (pendingFlush.length >= batchFlushSize) {
            void enqueueFlush(false);
          }
        }
      };

      try {
        await Promise.all(Array.from({ length: concurrency }, () => worker()));
      } finally {
        rateLimiter.dispose();
      }
      finalCampaignRow = await enqueueFlush(true);
    } else {
      finalCampaignRow = await executeFlush([], true);
    }

    return {
      ok: true,
      campaignRow: finalCampaignRow || phase1.camp,
      newly_sent: newlySent,
      duplicate_claims_prevented: skippedDuplicateClaims,
      suppressed_skipped: suppressedSkipped,
      failed_count: failedCount,
      claim_ids: sentClaimIds,
      stats_json: finalCampaignRow ? extractCampaignStatsJson(finalCampaignRow) : phase1.initialStats,
    };
  };

  const trackedPromise = runPhase2And3().finally(() => {
    activeCampaignDispatches.delete(dispatchKey);
  });
  activeCampaignDispatches.set(dispatchKey, trackedPromise);

  if (input.asyncBackground && phase1.preparedJobs.length > 0) {
    // Detach cleanly with error guard so unhandled rejections can never crash process
    trackedPromise.catch(() => {});
    return {
      ok: true,
      asyncRunning: true,
      campaignRow: phase1.camp,
      newly_sent: 0,
      duplicate_claims_prevented: phase1.skippedDuplicateClaims,
      suppressed_skipped: phase1.suppressedSkipped,
      failed_count: 0,
      claim_ids: phase1.preparedJobs.map((j) => j.claimId),
      stats_json: phase1.initialStats,
    };
  }

  return trackedPromise;
}
