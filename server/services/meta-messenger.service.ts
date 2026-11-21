import crypto from 'node:crypto';
import type { DbClient } from '../core/database/db-adapter.ts';
import { withTenantTransaction } from '../core/database/transaction.ts';
import { isOutboundSilentMode } from '../core/security/outbound-guard.ts';
import { readTenantChannelVault } from '../modules/marketing/utils.ts';

export interface MetaMessengerPageConfig {
  page_id: string;
  page_name?: string;
  page_access_token?: string;
  app_id?: string;
  app_secret?: string;
  verify_token?: string;
  status?: string;
  mode?: string;
}

export interface MessengerSendInput {
  tenantId: string;
  client?: DbClient;
  pageId?: string | null;
  recipientPsid: string;
  text: string;
  messagingType?: 'RESPONSE' | 'UPDATE' | 'MESSAGE_TAG';
}

export interface MessengerSendResult {
  sent: boolean;
  queued?: boolean;
  silent?: boolean;
  messageId: string;
  provider: string;
  error?: string;
}

export interface MessengerTransportRequest {
  url: string;
  headers: Record<string, string>;
  body: {
    recipient: { id: string };
    messaging_type: string;
    message: { text: string };
  };
  tenantId: string;
  pageId: string;
}

export interface MessengerTransportResponse {
  sent?: boolean;
  ok?: boolean;
  status?: number;
  messageId?: string;
  message_id?: string;
  provider?: string;
  error?: string;
}

export type MessengerTransportFn = (req: MessengerTransportRequest) => Promise<MessengerTransportResponse>;

let customMessengerTransportForTesting: MessengerTransportFn | null = null;

export function setMessengerTransportForTesting(fn: MessengerTransportFn | null): void {
  customMessengerTransportForTesting = fn;
}

function isSandboxToken(token: string): boolean {
  const lower = token.trim().toLowerCase();
  return lower.startsWith('sandbox_') || lower.startsWith('demo_') || lower.startsWith('test_');
}

export function verifyMetaWebhookSignature(
  rawBody: Buffer | string,
  appSecret: string,
  signatureHeader?: string
): boolean {
  const secret = String(appSecret || '').trim();
  const header = String(signatureHeader || '').trim();
  if (!secret || !header) return false;
  const expected = `sha256=${crypto.createHmac('sha256', secret).update(rawBody).digest('hex')}`;
  const a = Buffer.from(expected, 'utf8');
  const b = Buffer.from(header, 'utf8');
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

export function extractMetaPageConfigs(vaultConfig: Record<string, unknown>): MetaMessengerPageConfig[] {
  const rawPages = Array.isArray(vaultConfig.pages) ? vaultConfig.pages : [];
  const out: MetaMessengerPageConfig[] = [];
  for (const p of rawPages) {
    if (!p || typeof p !== 'object') continue;
    const obj = p as Record<string, unknown>;
    const pageId = String(obj.page_id || obj.id || '').trim();
    if (!pageId) continue;
    out.push({
      page_id: pageId,
      page_name: obj.page_name ? String(obj.page_name) : undefined,
      page_access_token: obj.page_access_token
        ? String(obj.page_access_token)
        : obj.access_token
          ? String(obj.access_token)
          : undefined,
      app_id: obj.app_id ? String(obj.app_id) : undefined,
      app_secret: obj.app_secret ? String(obj.app_secret) : undefined,
      verify_token: obj.verify_token ? String(obj.verify_token) : undefined,
      status: obj.status ? String(obj.status) : 'active',
      mode: obj.mode ? String(obj.mode) : undefined,
    });
  }
  if (out.length === 0 && (vaultConfig.page_id || vaultConfig.page_access_token || vaultConfig.access_token)) {
    out.push({
      page_id: String(vaultConfig.page_id || 'me').trim(),
      page_name: vaultConfig.page_name ? String(vaultConfig.page_name) : undefined,
      page_access_token: String(vaultConfig.page_access_token || vaultConfig.access_token || '').trim() || undefined,
      app_id: vaultConfig.app_id ? String(vaultConfig.app_id) : undefined,
      app_secret: vaultConfig.app_secret ? String(vaultConfig.app_secret) : undefined,
      verify_token: vaultConfig.verify_token ? String(vaultConfig.verify_token) : undefined,
      status: 'active',
    });
  }
  return out;
}

export async function resolveMetaMessengerVaultConfig(
  client: DbClient,
  tenantId: string,
  preferredPageId?: string | null
): Promise<{
  configured: boolean;
  integrationType: string | null;
  pageId: string;
  pageAccessToken: string;
  appSecret: string;
  verifyToken: string;
  pages: MetaMessengerPageConfig[];
}> {
  const vault = await readTenantChannelVault(client, tenantId, ['meta_messenger', 'facebook_ads', 'meta_capi']);
  const pages = extractMetaPageConfigs(vault.config);
  const selected =
    (preferredPageId ? pages.find((p) => p.page_id === String(preferredPageId).trim()) : undefined) ||
    pages.find((p) => p.status !== 'inactive') ||
    pages[0];

  const pageId = String(preferredPageId || selected?.page_id || vault.config.page_id || '').trim();
  const pageAccessToken = String(
    selected?.page_access_token || vault.config.page_access_token || vault.config.access_token || ''
  ).trim();
  const appSecret = String(selected?.app_secret || vault.config.app_secret || '').trim();
  const verifyToken = String(selected?.verify_token || vault.config.verify_token || '').trim();

  return {
    configured: vault.configured && Boolean(pageAccessToken || pages.length > 0),
    integrationType: vault.integrationType,
    pageId,
    pageAccessToken,
    appSecret,
    verifyToken,
    pages,
  };
}

export async function sendMetaMessengerMessage(input: MessengerSendInput): Promise<MessengerSendResult> {
  const messageId = `mid_${crypto.randomUUID()}`;
  const runWithClient = async (client: DbClient): Promise<MessengerSendResult> => {
    const resolved = await resolveMetaMessengerVaultConfig(client, input.tenantId, input.pageId);
    const pageId = resolved.pageId || 'me';
    const token = resolved.pageAccessToken;
    const url = `https://graph.facebook.com/v21.0/${encodeURIComponent(pageId)}/messages`;

    const reqPayload: MessengerTransportRequest = {
      url,
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: {
        recipient: { id: String(input.recipientPsid) },
        messaging_type: input.messagingType || 'RESPONSE',
        message: { text: String(input.text || '') },
      },
      tenantId: input.tenantId,
      pageId,
    };

    if (customMessengerTransportForTesting) {
      const out = await customMessengerTransportForTesting(reqPayload);
      const ok = out.sent ?? out.ok ?? true;
      if (!ok) {
        return {
          sent: false,
          messageId,
          provider: out.provider || 'meta_messenger',
          error: out.error || 'META_MESSENGER_FAILED',
        };
      }
      return {
        sent: true,
        messageId: String(out.message_id || out.messageId || messageId),
        provider: out.provider || 'meta_messenger',
      };
    }

    if (isOutboundSilentMode() || (token && isSandboxToken(token))) {
      return {
        sent: true,
        silent: true,
        messageId,
        provider: 'meta_messenger:silent_guard',
      };
    }

    if (!resolved.configured || !token || !resolved.pageId) {
      return {
        sent: true,
        queued: true,
        messageId,
        provider: 'meta_messenger:vault_queued',
      };
    }

    try {
      const resp = await fetch(url, {
        method: 'POST',
        headers: reqPayload.headers,
        body: JSON.stringify(reqPayload.body),
        signal: AbortSignal.timeout(8000),
      });
      const data = (await resp.json().catch(() => null)) as {
        message_id?: string;
        error?: { message?: string };
      } | null;
      if (!resp.ok) {
        return {
          sent: false,
          messageId,
          provider: 'meta_messenger',
          error: data?.error?.message || `Meta Graph HTTP ${resp.status}`,
        };
      }
      return {
        sent: true,
        messageId: String(data?.message_id || messageId),
        provider: 'meta_messenger',
      };
    } catch (err: any) {
      return {
        sent: false,
        messageId,
        provider: 'meta_messenger',
        error: err?.message || 'META_MESSENGER_NETWORK_ERROR',
      };
    }
  };

  if (input.client) {
    return runWithClient(input.client);
  }
  return withTenantTransaction(input.tenantId, runWithClient);
}
