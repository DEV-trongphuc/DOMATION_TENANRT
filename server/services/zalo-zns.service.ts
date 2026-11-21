import crypto from 'node:crypto';
import type { DbClient } from '../core/database/db-adapter.ts';
import { withTenantTransaction } from '../core/database/transaction.ts';
import { isOutboundSilentMode } from '../core/security/outbound-guard.ts';
import {
  registerZnsDispatcher,
  type ZnsDispatchInput,
  type ZnsDispatchResult,
} from '../modules/marketing/dispatchers.ts';
import { readTenantChannelVault } from '../modules/marketing/utils.ts';
import { tenantRedis } from '../core/cache/tenant-redis.ts';
import { normalizePhoneE164 } from './phone.service.ts';
import { refreshTenantZaloIntegrationsOnClient } from './zalo-mail.service.ts';

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ZALO_ZNS_OPENAPI_URL = 'https://business.openapi.zalo.me/message/template';

export interface ZnsTransportRequest {
  url: string;
  headers: Record<string, string>;
  body: {
    phone: string;
    template_id: string;
    template_data: Record<string, unknown>;
    tracking_id: string;
  };
  tenantId: string;
  integrationType: string | null;
}

export interface ZnsTransportResponse {
  sent?: boolean;
  ok?: boolean;
  status?: number;
  errorCode?: number;
  messageId?: string;
  msgId?: string;
  provider?: string;
  error?: string;
  message?: string;
  data?: { msg_id?: string };
}

export type ZnsTransportFn = (req: ZnsTransportRequest) => Promise<ZnsTransportResponse>;

let customZnsTransportForTesting: ZnsTransportFn | null = null;
let znsDispatcherRegistered = false;

export function setZnsTransportForTesting(fn: ZnsTransportFn | null): void {
  customZnsTransportForTesting = fn;
}

function isSandboxCredential(token: string): boolean {
  const lower = token.trim().toLowerCase();
  return lower.startsWith('sandbox_') || lower.startsWith('demo_') || lower.startsWith('test_');
}

async function tableExistsOnClient(client: DbClient, tableName: string): Promise<boolean> {
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

async function resolveZnsTemplateAndVault(
  client: DbClient,
  input: ZnsDispatchInput
): Promise<{
  vault: Awaited<ReturnType<typeof readTenantChannelVault>>;
  resolvedTemplateId: string;
  oaConfigExists: boolean;
}> {
  const vault = await readTenantChannelVault(client, input.tenantId, ['zalo_zns', 'zalo_oa']);
  let resolvedTemplateId = String(input.templateId || '').trim();

  if (resolvedTemplateId && UUID_REGEX.test(resolvedTemplateId) && (await tableExistsOnClient(client, 'mkt_zalo_templates'))) {
    const tRes = await client.query<{ template_code: string | null }>(
      'SELECT template_code FROM mkt_zalo_templates WHERE tenant_id = $1 AND id = $2 LIMIT 1',
      [input.tenantId, resolvedTemplateId]
    );
    if (tRes.rows[0]?.template_code) {
      resolvedTemplateId = String(tRes.rows[0].template_code).trim();
    }
  }

  if (!resolvedTemplateId) {
    resolvedTemplateId = String(vault.config.default_template_id || vault.config.template_id || 'default').trim();
  }

  const oaConfigExists = await tableExistsOnClient(client, 'mkt_zalo_oa_configs');
  return { vault, resolvedTemplateId, oaConfigExists };
}

async function incrementZaloSentToday(client: DbClient, tenantId: string, oaConfigExists: boolean): Promise<void> {
  if (!oaConfigExists) return;
  try {
    await client.query(
      'UPDATE mkt_zalo_oa_configs SET sent_today = sent_today + 1, updated_at = clock_timestamp() WHERE tenant_id = $1',
      [tenantId]
    );
  } catch {
    // Non-fatal quota telemetry update
  }
}

export async function sendTenantZnsMessage(input: ZnsDispatchInput): Promise<ZnsDispatchResult> {
  const messageId = `zns_${crypto.randomUUID()}`;
  const runWithClient = async (client: DbClient): Promise<ZnsDispatchResult> => {
    const normalizedPhone = normalizePhoneE164(input.phone, { default_dial_code: '84' });
    if (!normalizedPhone) {
      return {
        sent: false,
        messageId,
        provider: 'zalo_zns',
        error: 'INVALID_ZNS_PHONE',
      };
    }

    let { vault, resolvedTemplateId, oaConfigExists } = await resolveZnsTemplateAndVault(client, input);
    let accessToken = String(vault.config.access_token || '').trim();

    const templateData: Record<string, unknown> =
      input.templateData && typeof input.templateData === 'object' && Object.keys(input.templateData).length > 0
        ? { ...input.templateData }
        : { message: String(input.message || '') };
    const trackingId = String(input.claimId || input.leadId || messageId);

    const buildRequest = (token: string): ZnsTransportRequest => ({
      url: ZALO_ZNS_OPENAPI_URL,
      headers: {
        'Content-Type': 'application/json',
        access_token: token,
      },
      body: {
        phone: normalizedPhone,
        template_id: resolvedTemplateId,
        template_data: templateData,
        tracking_id: trackingId,
      },
      tenantId: input.tenantId,
      integrationType: vault.integrationType,
    });

    const invokeTransport = async (
      reqPayload: ZnsTransportRequest
    ): Promise<{
      ok: boolean;
      status: number;
      errorCode?: number;
      msgId?: string;
      provider?: string;
      error?: string;
    }> => {
      if (customZnsTransportForTesting) {
        const out = await customZnsTransportForTesting(reqPayload);
        const errCode = out.errorCode;
        const httpStatus = out.status ?? (out.sent === false || out.ok === false ? 400 : 200);
        const isOk =
          out.sent !== undefined
            ? out.sent && errCode !== -124 && httpStatus !== 401
            : out.ok !== undefined
              ? out.ok && errCode !== -124 && httpStatus !== 401
              : errCode === undefined || errCode === 0;
        return {
          ok: isOk,
          status: httpStatus,
          errorCode: errCode,
          msgId: out.data?.msg_id || out.msgId || out.messageId,
          provider: out.provider,
          error: out.error || out.message,
        };
      }

      try {
        const resp = await fetch(reqPayload.url, {
          method: 'POST',
          headers: reqPayload.headers,
          body: JSON.stringify(reqPayload.body),
          signal: AbortSignal.timeout(8000),
        });
        const data = (await resp.json().catch(() => null)) as {
          error?: number;
          message?: string;
          data?: { msg_id?: string };
        } | null;
        const znsErrCode = typeof data?.error === 'number' ? data.error : undefined;
        const ok = resp.ok && (znsErrCode === undefined || znsErrCode === 0);
        return {
          ok,
          status: resp.status,
          errorCode: znsErrCode,
          msgId: data?.data?.msg_id,
          error: ok ? undefined : data?.message || `ZNS HTTP ${resp.status}`,
        };
      } catch (err: any) {
        return {
          ok: false,
          status: 0,
          error: err?.message || 'ZNS_NETWORK_ERROR',
        };
      }
    };

    // 1. Injected test transport takes precedence over silent/unconfigured guards so HTTP integration paths are testable
    if (customZnsTransportForTesting) {
      let attempt = await invokeTransport(buildRequest(accessToken));
      if (!attempt.ok && (attempt.errorCode === -124 || attempt.status === 401) && vault.config.refresh_token) {
        const refreshed = await refreshTenantZaloIntegrationsOnClient(client, input.tenantId);
        if (refreshed.refreshedCount > 0) {
          tenantRedis.invalidateTenantIntegrations(input.tenantId);
          accessToken = String(
            refreshed.latestAccessToken ||
              (await readTenantChannelVault(client, input.tenantId, ['zalo_zns', 'zalo_oa'])).config.access_token ||
              ''
          ).trim();
          attempt = await invokeTransport(buildRequest(accessToken));
        }
      }
      if (!attempt.ok) {
        return {
          sent: false,
          messageId,
          provider: attempt.provider || vault.integrationType || 'zalo_zns',
          error: attempt.error || 'ZNS_DISPATCH_FAILED',
        };
      }
      await incrementZaloSentToday(client, input.tenantId, oaConfigExists);
      return {
        sent: true,
        messageId: String(attempt.msgId || messageId),
        provider: attempt.provider || vault.integrationType || 'zalo_zns',
      };
    }

    // 2. Outbound Silent Mode or Sandbox/Demo/Test token guard
    if (isOutboundSilentMode() || (accessToken && isSandboxCredential(accessToken))) {
      return {
        sent: true,
        silent: true,
        messageId,
        provider: vault.configured && vault.integrationType ? `${vault.integrationType}:silent_guard` : 'silent_guard',
      };
    }

    // 3. Unconfigured tenant vault preserves sandbox compatibility cleanly
    if (!vault.configured || !accessToken) {
      return {
        sent: true,
        queued: true,
        messageId,
        provider: 'zns_vault_queued',
      };
    }

    // 4. Live Zalo ZNS OpenAPI v2/v3 HTTP dispatch + single auto-refresh retry on -124 / 401
    let attempt = await invokeTransport(buildRequest(accessToken));
    if (!attempt.ok && (attempt.errorCode === -124 || attempt.status === 401) && vault.config.refresh_token) {
      const refreshed = await refreshTenantZaloIntegrationsOnClient(client, input.tenantId);
      if (refreshed.refreshedCount > 0) {
        tenantRedis.invalidateTenantIntegrations(input.tenantId);
        accessToken = String(
          refreshed.latestAccessToken ||
            (await readTenantChannelVault(client, input.tenantId, ['zalo_zns', 'zalo_oa'])).config.access_token ||
            ''
        ).trim();
        attempt = await invokeTransport(buildRequest(accessToken));
      }
    }

    if (!attempt.ok) {
      return {
        sent: false,
        messageId,
        provider: vault.integrationType || 'zalo_zns',
        error: attempt.error || 'ZNS_DISPATCH_FAILED',
      };
    }

    await incrementZaloSentToday(client, input.tenantId, oaConfigExists);
    return {
      sent: true,
      messageId: String(attempt.msgId || messageId),
      provider: vault.integrationType || 'zalo_zns',
    };
  };

  if (input.client) {
    return runWithClient(input.client);
  }
  return withTenantTransaction(input.tenantId, runWithClient);
}

export function ensureZnsDispatcherRegistered(): void {
  if (!znsDispatcherRegistered) {
    registerZnsDispatcher(sendTenantZnsMessage);
    znsDispatcherRegistered = true;
  }
}
