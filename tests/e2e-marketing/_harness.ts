import crypto from 'node:crypto';
import type { Server } from 'node:http';
import type {
  MockFailureConfig,
  MockFetchController,
  RecordedFetchRequest,
} from '../e2e/helpers/mock-fetch.ts';
import {
  startMockWebhookSink,
  type CapturedWebhookDelivery,
  type MockWebhookSink,
} from '../e2e/helpers/mock-webhook-sink.ts';

function configureHarnessEnv(silentOutbound: boolean): void {
  process.env.DB_DIALECT = 'postgres';
  delete process.env.DATABASE_URL;
  delete process.env.VITEST;
  process.env.NODE_ENV = 'development';
  process.env.SERVE_SPA = 'false';
  process.env.OUTBOUND_SILENT_MODE = silentOutbound ? 'true' : 'false';
  process.env.TELEGRAM_SILENT_MODE = silentOutbound ? 'true' : 'false';
  process.env.TELEGRAM_NOTIFY_ENABLED = silentOutbound ? 'false' : 'true';
  process.env.MIGRATION_SILENT_MODE = 'false';
  process.env.ALLOW_LOCAL_WEBHOOKS = 'true';
  process.env.CRON_SECRET = process.env.CRON_SECRET || 'e2e_marketing_cron_secret_2026';
  process.env.BILLING_MANUAL_WEBHOOK_SECRET =
    process.env.BILLING_MANUAL_WEBHOOK_SECRET || 'e2e_manual_webhook_secret_2026';
  process.env.PAYOS_CHECKSUM_KEY =
    process.env.PAYOS_CHECKSUM_KEY || 'e2e_payos_checksum_key_2026';
  process.env.SEPAY_WEBHOOK_SECRET =
    process.env.SEPAY_WEBHOOK_SECRET || 'e2e_sepay_webhook_secret_2026';
  delete process.env.VNPAY_HASH_SECRET;
}

configureHarnessEnv(false);

export type { RecordedFetchRequest, MockFailureConfig, MockFetchController };
export type { MockWebhookSink, CapturedWebhookDelivery };

export interface MarketingMockFailureConfig extends MockFailureConfig {
  znsStatus?: number | null;
  znsErrorCode?: number | null;
  znsErrorMessage?: string | null;
  messengerStatus?: number | null;
  messengerErrorMessage?: string | null;
  sesStatus?: number | null;
  responseDelayMs?: number | null;
}

export interface MarketingMockFetchController extends Omit<MockFetchController, 'setFailureMode'> {
  setFailureMode: (patch: Partial<MarketingMockFailureConfig>) => void;
}

export interface CapturedEmailRecord {
  driver: 'smtp_hook' | 'resend' | 'appscript' | 'ses';
  to: string;
  subject: string;
  text: string;
  html?: string;
  messageId: string;
  config?: Record<string, unknown>;
  url?: string;
  status: number;
  timestamp: string;
}

export interface CapturedZaloRecord {
  channel: 'zns' | 'zalo_oa' | 'zalo_bot';
  url: string;
  method: string;
  headers: Record<string, string>;
  body: Record<string, any> | null;
  status: number;
  timestamp: string;
}

export interface CapturedCapiRecord {
  source: 'dispatch' | 'cron_retry' | 'fetch';
  datasetId: string;
  apiVersion: string;
  url: string;
  payload: Record<string, unknown>;
  httpStatus: number;
  responseBody: Record<string, unknown>;
  timestamp: string;
}

export interface TenantAuthContext {
  status: number;
  tenantId: string;
  tenantSlug: string;
  accessToken: string;
  refreshToken: string;
  adminToken: string;
  userId: string;
  adminUserId: string;
  email: string;
  password: string;
  packageCode: string;
  user: Record<string, any>;
  tenant: Record<string, any>;
  raw: any;
}

export interface ApiRequestOptions {
  method?: string;
  token?: string;
  tenantSlug?: string;
  auth?: Pick<TenantAuthContext, 'accessToken' | 'tenantSlug'>;
  headers?: Record<string, string>;
  body?: unknown;
  query?: Record<string, string | number | boolean | undefined | null>;
}

export interface ApiRawResponse {
  status: number;
  ok: boolean;
  headers: Headers;
  rawText: string;
  json: any;
}

export interface RegisterTenantOptions {
  companyName?: string;
  company_name?: string;
  tenantSlug?: string;
  tenant_slug?: string;
  adminName?: string;
  admin_name?: string;
  workEmail?: string;
  work_email?: string;
  phone?: string;
  password?: string;
  industry?: string;
  packageCode?: string;
  package_code?: string;
  seedDemoLeads?: boolean;
  seed_demo_leads?: boolean;
  customSettings?: Record<string, unknown>;
  custom_settings?: Record<string, unknown>;
}

export interface LoginTenantOptions {
  email: string;
  password: string;
  tenantSlug?: string;
  tenant_slug?: string;
}

export interface UpgradePackageOptions {
  billingCycle?: 'monthly' | 'annual';
  months?: number;
  paymentMethod?: 'wallet' | 'manual_bank_transfer' | 'payos' | 'sepay';
  educationAddon?: boolean;
  industryKey?: string;
  scheduleAtPeriodEnd?: boolean;
  autoTopup?: boolean;
  topupAmountVnd?: number;
  endpoint?: 'myerp' | 'billing';
  note?: string;
  idempotencyKey?: string;
}

export interface MasterCronResult {
  status: number;
  locked: boolean;
  stats: Record<string, any>;
  json: any;
}

export interface MarketingE2eHarness {
  baseUrl: string;
  cronSecret: string;
  webhookSink: MockWebhookSink;
  mockFetch: MarketingMockFetchController;
  emailCapture: CapturedEmailRecord[];
  zaloCapture: CapturedZaloRecord[];
  capiCapture: CapturedCapiRecord[];
  apiRaw: (path: string, opts?: ApiRequestOptions) => Promise<ApiRawResponse>;
  apiJson: <T = any>(path: string, opts?: ApiRequestOptions) => Promise<T>;
  registerTenant: (opts?: RegisterTenantOptions) => Promise<TenantAuthContext>;
  loginTenant: (opts: LoginTenantOptions) => Promise<TenantAuthContext>;
  upgradePackage: (
    auth: TenantAuthContext,
    targetPackage: string,
    opts?: UpgradePackageOptions
  ) => Promise<any>;
  triggerMasterCron: (subroutines?: string[], tenantId?: string) => Promise<MasterCronResult>;
  setSmtpCaptureEnabled: (enabled: boolean) => void;
  resetCaptures: () => void;
  teardown: () => Promise<void>;
}

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);

function headersToRecord(h: RequestInit['headers'] | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!h) return out;
  if (h instanceof Headers) {
    h.forEach((v, k) => {
      out[k.toLowerCase()] = v;
    });
    return out;
  }
  if (Array.isArray(h)) {
    for (const [k, v] of h) {
      out[String(k).toLowerCase()] = String(v);
    }
    return out;
  }
  for (const [k, v] of Object.entries(h)) {
    if (v !== undefined) {
      out[k.toLowerCase()] = String(v);
    }
  }
  return out;
}

function extractBodyText(body: RequestInit['body'] | null | undefined): string {
  if (body === null || body === undefined) return '';
  if (typeof body === 'string') return body;
  if (body instanceof URLSearchParams) return body.toString();
  if (Buffer.isBuffer(body)) return body.toString('utf8');
  if (body instanceof Uint8Array) return Buffer.from(body).toString('utf8');
  return String(body);
}

function makeJsonResponse(status: number, data: unknown): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function installMarketingMockFetch(
  emailCapture: CapturedEmailRecord[],
  zaloCapture: CapturedZaloRecord[],
  capiCapture: CapturedCapiRecord[]
): MarketingMockFetchController {
  const originalFetch = globalThis.fetch;
  const requests: RecordedFetchRequest[] = [];
  let failures: MarketingMockFailureConfig = {};

  const buildMockInsightsRows = (isHourly = false) => {
    if (failures.emptyMetaInsights) return [];
    if (isHourly) {
      return [
        {
          hourly_stats_aggregated_by_audience_time_zone: '09:00:00 - 09:59:59',
          spend: '450000',
          impressions: '8200',
          reach: '6900',
          clicks: '210',
          actions: [
            { action_type: 'lead', value: '8' },
            { action_type: 'onsite_conversion.messaging_conversation_started_7d', value: '14' },
          ],
        },
        {
          hourly_stats_aggregated_by_audience_time_zone: '20:00:00 - 20:59:59',
          spend: '780000',
          impressions: '15400',
          reach: '12100',
          clicks: '440',
          actions: [
            { action_type: 'lead', value: '19' },
            { action_type: 'onsite_conversion.messaging_conversation_started_7d', value: '31' },
          ],
        },
      ];
    }
    return [
      {
        campaign_id: 'cmp_e2e_001',
        campaign_name: 'E2E Lead Generation Campaign',
        spend: '1230000',
        impressions: '23600',
        reach: '19000',
        clicks: '650',
        actions: [
          { action_type: 'lead', value: '27' },
          { action_type: 'onsite_conversion.messaging_conversation_started_7d', value: '45' },
        ],
      },
    ];
  };

  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const urlStr = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    const parsed = new URL(urlStr);

    if (LOOPBACK_HOSTS.has(parsed.hostname)) {
      return originalFetch(input as any, init);
    }

    const method = (init?.method || (input instanceof Request ? input.method : 'GET')).toUpperCase();
    const hdrs = headersToRecord(init?.headers || (input instanceof Request ? input.headers : undefined));
    let bodyText = '';
    if (init?.body !== undefined) {
      bodyText = extractBodyText(init.body);
    } else if (input instanceof Request && input.body !== null) {
      bodyText = await input.clone().text();
    }
    let jsonBody: any = null;
    try {
      jsonBody = bodyText ? JSON.parse(bodyText) : null;
    } catch {
      jsonBody = null;
    }

    const timestamp = new Date().toISOString();
    requests.push({
      url: urlStr,
      hostname: parsed.hostname,
      pathname: parsed.pathname,
      method,
      headers: hdrs,
      body: bodyText,
      jsonBody,
      timestamp,
    });

    const host = parsed.hostname.toLowerCase();

    if (failures.responseDelayMs && failures.responseDelayMs > 0) {
      await new Promise((r) => setTimeout(r, failures.responseDelayMs!));
    }

    // 1. Zalo ZNS OpenAPI
    if (host === 'business.openapi.zalo.me') {
      const injectedStatus = failures.znsStatus ?? failures.zaloStatus ?? null;
      const status = injectedStatus && injectedStatus >= 400 ? injectedStatus : 200;
      zaloCapture.push({
        channel: 'zns',
        url: urlStr,
        method,
        headers: hdrs,
        body: jsonBody,
        status,
        timestamp,
      });
      if (status >= 400 || (failures.znsErrorCode !== undefined && failures.znsErrorCode !== null && failures.znsErrorCode !== 0)) {
        return makeJsonResponse(status, {
          error: failures.znsErrorCode ?? -108,
          message: failures.znsErrorMessage || 'Injected Zalo ZNS error',
        });
      }
      return makeJsonResponse(200, {
        error: 0,
        message: 'Success',
        data: {
          msg_id: `zns_msg_${requests.length}`,
          sent_time: Date.now(),
          quota: { dailyQuota: '1000', remainingQuota: '999' },
        },
      });
    }

    // 2. Zalo OA & Bot APIs
    if (host === 'openapi.zalo.me' || host === 'oauth.zaloapp.com') {
      const status = failures.zaloStatus && failures.zaloStatus >= 400 ? failures.zaloStatus : 200;
      zaloCapture.push({
        channel: 'zalo_oa',
        url: urlStr,
        method,
        headers: hdrs,
        body: jsonBody,
        status,
        timestamp,
      });
      if (status >= 400) {
        return makeJsonResponse(status, { error: -1, message: 'Injected Zalo OA error' });
      }
      if (host === 'oauth.zaloapp.com' || parsed.pathname.includes('access_token')) {
        return makeJsonResponse(200, {
          access_token: `zalo_oa_access_${requests.length}`,
          refresh_token: `zalo_oa_refresh_${requests.length}`,
          expires_in: 90000,
        });
      }
      return makeJsonResponse(200, {
        error: 0,
        message: 'Success',
        data: {
          message_id: `zalo_oa_msg_${requests.length}`,
        },
      });
    }

    if (host === 'bot-api.zaloplatforms.com') {
      const status = failures.zaloStatus && failures.zaloStatus >= 400 ? failures.zaloStatus : 200;
      zaloCapture.push({
        channel: 'zalo_bot',
        url: urlStr,
        method,
        headers: hdrs,
        body: jsonBody,
        status,
        timestamp,
      });
      if (status >= 400) {
        return makeJsonResponse(status, { ok: false, error: -1, description: 'Injected Zalo Bot error' });
      }
      return makeJsonResponse(200, {
        ok: true,
        error: 0,
        message: 'Success',
        result: {
          account_name: 'DOMATION Zalo Mock Bot',
          message_id: `zalo_bot_msg_${requests.length}`,
          chat: { id: 'zalo_chat_001' },
        },
      });
    }

    // 3. Meta Graph API (CAPI, Messenger, Ads Insights, Batch)
    if (host === 'graph.facebook.com') {
      if (parsed.pathname.endsWith('/events')) {
        const status = failures.metaCapiStatus && failures.metaCapiStatus >= 400 ? failures.metaCapiStatus : 200;
        const respBody =
          status >= 400
            ? {
                error: {
                  message: failures.metaErrorMessage || `Injected Meta CAPI HTTP ${status}`,
                  type: 'OAuthException',
                  code: failures.metaErrorCode || 190,
                },
              }
            : {
                events_received: 1,
                messages: [],
                fbtrace_id: `mock_fbtrace_${requests.length}`,
              };
        if (hdrs['x-e2e-capi-captured'] !== '1') {
          const parts = parsed.pathname.split('/').filter(Boolean);
          const eventsIdx = parts.lastIndexOf('events');
          const datasetId = eventsIdx >= 1 ? parts[eventsIdx - 1] : '';
          const apiVersion = eventsIdx >= 2 ? parts[eventsIdx - 2] : 'v21.0';
          capiCapture.push({
            source: 'fetch',
            datasetId,
            apiVersion,
            url: urlStr,
            payload: (jsonBody && typeof jsonBody === 'object' ? jsonBody : {}) as Record<string, unknown>,
            httpStatus: status,
            responseBody: respBody,
            timestamp,
          });
        }
        return makeJsonResponse(status, respBody);
      }

      if (parsed.pathname.endsWith('/messages') && method === 'POST') {
        const msgStatus = failures.messengerStatus ?? failures.metaStatus ?? null;
        if (msgStatus && msgStatus >= 400) {
          return makeJsonResponse(msgStatus, {
            error: {
              message: failures.messengerErrorMessage || failures.metaErrorMessage || 'Injected Messenger Send API error',
              type: 'OAuthException',
              code: failures.metaErrorCode ?? 10,
            },
          });
        }
        const recipientId = String(jsonBody?.recipient?.id || 'psid_mock_001');
        return makeJsonResponse(200, {
          recipient_id: recipientId,
          message_id: `mid.$mock_${requests.length}`,
        });
      }

      if (failures.metaStatus && failures.metaStatus >= 400) {
        return makeJsonResponse(failures.metaStatus, {
          error: {
            message: failures.metaErrorMessage || 'Error validating access token: Session has expired',
            type: 'OAuthException',
            code: failures.metaErrorCode ?? (failures.metaStatus === 401 ? 190 : 2),
          },
        });
      }

      if (parsed.pathname === '/v25.0/' && method === 'POST') {
        const params = new URLSearchParams(bodyText);
        const batchRaw = params.get('batch');
        const batchItems: Array<{ relative_url?: string }> = batchRaw ? JSON.parse(batchRaw) : [];
        const batchResp = batchItems.map((b) => {
          const rel = String(b?.relative_url || '');
          const isHourly = rel.includes('hourly_stats');
          return {
            code: 200,
            body: JSON.stringify({ data: buildMockInsightsRows(isHourly) }),
          };
        });
        return makeJsonResponse(200, batchResp);
      }

      if (parsed.pathname.endsWith('/me')) {
        return makeJsonResponse(200, {
          id: '100000001',
          name: 'DOMATION Mock Meta User',
          adaccounts: {
            data: [
              {
                id: 'act_111222333',
                account_id: '111222333',
                name: 'DOMATION Main Ad Account',
                account_status: 1,
              },
            ],
          },
        });
      }

      if (parsed.pathname.endsWith('/me/accounts')) {
        return makeJsonResponse(200, {
          data: [
            {
              id: 'page_10001',
              name: 'DOMATION Official Page',
              access_token: 'mock_page_token_001',
            },
          ],
        });
      }

      if (parsed.pathname.endsWith('/me/businesses')) {
        return makeJsonResponse(200, {
          data: [{ id: 'biz_10001', name: 'DOMATION Business' }],
        });
      }

      if (parsed.pathname.includes('/insights')) {
        const isHourly = urlStr.includes('hourly_stats');
        return makeJsonResponse(200, { data: buildMockInsightsRows(isHourly) });
      }

      if (parsed.pathname.includes('/adaccounts')) {
        return makeJsonResponse(200, {
          data: [
            {
              id: 'act_111222333',
              account_id: '111222333',
              name: 'DOMATION Main Ad Account',
              account_status: 1,
            },
          ],
        });
      }

      if (parsed.pathname.includes('/adspixels')) {
        return makeJsonResponse(200, {
          data: [{ id: 'pixel_999888777', name: 'DOMATION Primary Pixel' }],
        });
      }

      if (parsed.pathname.includes('/ads')) {
        return makeJsonResponse(200, {
          data: [{ id: 'ad_001', name: 'E2E Ad 1', status: 'ACTIVE' }],
        });
      }

      return makeJsonResponse(200, { data: [], success: true });
    }

    // 4. Telegram Bot API
    if (host === 'api.telegram.org') {
      if (failures.telegramStatus && failures.telegramStatus >= 400) {
        return makeJsonResponse(failures.telegramStatus, { ok: false, description: 'Injected Telegram error' });
      }
      return makeJsonResponse(200, { ok: true, result: { message_id: 9000 + requests.length } });
    }

    // 5. Resend Email API
    if (host === 'api.resend.com') {
      const status = failures.resendStatus && failures.resendStatus >= 400 ? failures.resendStatus : 200;
      const msgId = `resend_mock_${requests.length}`;
      emailCapture.push({
        driver: 'resend',
        to: Array.isArray(jsonBody?.to) ? jsonBody.to.join(',') : String(jsonBody?.to || ''),
        subject: String(jsonBody?.subject || ''),
        text: String(jsonBody?.text || ''),
        html: jsonBody?.html ? String(jsonBody.html) : undefined,
        messageId: msgId,
        url: urlStr,
        status,
        timestamp,
      });
      if (status >= 400) {
        return makeJsonResponse(status, { message: 'Injected Resend error' });
      }
      return makeJsonResponse(200, { id: msgId });
    }

    // 6. AWS SES v2 IAM HTTP API
    if (/^email\.[a-z0-9-]+\.amazonaws\.com$/i.test(host)) {
      const status = failures.sesStatus && failures.sesStatus >= 400 ? failures.sesStatus : 200;
      const msgId = `ses_mock_${requests.length}`;
      const toArr = jsonBody?.Destination?.ToAddresses;
      const toStr = Array.isArray(toArr) ? toArr.join(',') : String(jsonBody?.to || '');
      const subject = String(jsonBody?.Content?.Simple?.Subject?.Data || jsonBody?.subject || '');
      const text = String(jsonBody?.Content?.Simple?.Body?.Text?.Data || jsonBody?.text || '');
      const html = jsonBody?.Content?.Simple?.Body?.Html?.Data
        ? String(jsonBody.Content.Simple.Body.Html.Data)
        : undefined;
      emailCapture.push({
        driver: 'ses',
        to: toStr,
        subject,
        text,
        html,
        messageId: msgId,
        url: urlStr,
        status,
        timestamp,
      });
      if (status >= 400) {
        return makeJsonResponse(status, { message: 'Injected SES error' });
      }
      return makeJsonResponse(200, { MessageId: msgId });
    }

    // 7. Discord Webhook API
    if (host === 'discord.com' || host === 'discordapp.com') {
      if (failures.discordStatus && failures.discordStatus >= 400) {
        return makeJsonResponse(failures.discordStatus, { message: 'Injected Discord error' });
      }
      return makeJsonResponse(200, { id: `discord_mock_${requests.length}` });
    }

    // 8. Google Apps Script Email / Proxy
    if (host === 'script.google.com' || host === 'script.googleusercontent.com') {
      const status = failures.appscriptStatus && failures.appscriptStatus >= 400 ? failures.appscriptStatus : 200;
      if (jsonBody && (jsonBody.to || jsonBody.email)) {
        emailCapture.push({
          driver: 'appscript',
          to: String(jsonBody.to || jsonBody.email || ''),
          subject: String(jsonBody.subject || ''),
          text: String(jsonBody.text || jsonBody.body || ''),
          html: jsonBody.html ? String(jsonBody.html) : undefined,
          messageId: `appscript_mock_${requests.length}`,
          url: urlStr,
          status,
          timestamp,
        });
      }
      if (status >= 400) {
        return makeJsonResponse(status, { success: false, error: 'Injected Apps Script error' });
      }
      return makeJsonResponse(200, {
        success: true,
        remaining_quota: 98,
        sheet_logged: true,
        campaigns: [],
      });
    }

    // 9. Google Gemini API
    if (host === 'generativelanguage.googleapis.com') {
      if (failures.geminiStatus && failures.geminiStatus >= 400) {
        return makeJsonResponse(failures.geminiStatus, {
          error: { message: 'Injected Gemini error', code: failures.geminiStatus },
        });
      }
      const textPayload =
        failures.geminiCustomText ||
        JSON.stringify({
          qualified: true,
          hold: false,
          reject: false,
          score: 88,
          decision: 'pass',
          reason: 'Lead hợp lệ: có nhu cầu tư vấn sản phẩm rõ ràng',
        });
      return makeJsonResponse(200, {
        candidates: [
          {
            content: {
              parts: [{ text: textPayload }],
            },
          },
        ],
        usageMetadata: { promptTokenCount: 32, candidatesTokenCount: 24, totalTokenCount: 56 },
      });
    }

    throw new Error(`UNMOCKED_EXTERNAL_FETCH: ${method} ${urlStr}`);
  }) as typeof fetch;

  return {
    getRequests(hostSubstring?: string) {
      if (!hostSubstring) return [...requests];
      const needle = hostSubstring.toLowerCase();
      return requests.filter(
        (r) => r.hostname.toLowerCase().includes(needle) || r.url.toLowerCase().includes(needle)
      );
    },
    clearRequests() {
      requests.length = 0;
    },
    setFailureMode(patch: Partial<MarketingMockFailureConfig>) {
      failures = { ...failures, ...patch };
    },
    resetFailureModes() {
      failures = {};
    },
    restore() {
      globalThis.fetch = originalFetch;
    },
  };
}

export async function startMarketingE2eHarness(
  options?: { silentOutbound?: boolean }
): Promise<MarketingE2eHarness> {
  const silentOutbound = options?.silentOutbound ?? false;
  configureHarnessEnv(silentOutbound);

  const [
    { APP_CONFIG },
    { createDatabasePool, setDatabasePool },
    { runMigrations },
    { tenantRedis },
    { createApp },
    zaloMailSvc,
    capiSvc,
    capiRetrySvc,
    webhookSvc,
    telegramSvc,
    aiScreenerSvc,
    metaAdsSvc,
  ] = await Promise.all([
    import('../../server/config.ts'),
    import('../../server/core/database/db-adapter.ts'),
    import('../../server/core/database/migrate.ts'),
    import('../../server/core/cache/tenant-redis.ts'),
    import('../../server/app.ts'),
    import('../../server/services/zalo-mail.service.ts'),
    import('../../server/services/capi.service.ts'),
    import('../../server/cron/subroutines/capi-retry.ts'),
    import('../../server/services/webhook.service.ts'),
    import('../../server/services/telegram.service.ts'),
    import('../../server/services/ai-screener.service.ts'),
    import('../../server/services/meta-ads.service.ts'),
  ]);

  const emailCapture: CapturedEmailRecord[] = [];
  const zaloCapture: CapturedZaloRecord[] = [];
  const capiCapture: CapturedCapiRecord[] = [];

  const mockFetch = installMarketingMockFetch(emailCapture, zaloCapture, capiCapture);
  const webhookSink = await startMockWebhookSink(200);

  const installSmtpHook = (enabled: boolean) => {
    if (enabled) {
      zaloMailSvc.setSmtpTransportForTesting(async (cfg, msg) => {
        const messageId = `smtp_mock_${emailCapture.length + 1}_${Date.now()}`;
        emailCapture.push({
          driver: 'smtp_hook',
          to: msg.to,
          subject: msg.subject,
          text: msg.text,
          messageId,
          config: cfg as unknown as Record<string, unknown>,
          status: 200,
          timestamp: new Date().toISOString(),
        });
        return { accepted: true, messageId };
      });
      zaloMailSvc.setEmailWebhookFetcherForTesting(null);
    } else {
      zaloMailSvc.setSmtpTransportForTesting(null);
      zaloMailSvc.setEmailWebhookFetcherForTesting((url, init) => globalThis.fetch(url, init));
    }
  };

  const installCapiHooks = () => {
    capiSvc.setCapiHttpTransportForTesting(async ({ datasetId, accessToken, payload, apiVersion, timeoutMs }) => {
      const url = `https://graph.facebook.com/${encodeURIComponent(apiVersion)}/${encodeURIComponent(datasetId)}/events?access_token=${encodeURIComponent(accessToken)}`;
      const resp = await globalThis.fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-e2e-capi-captured': '1',
        },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(timeoutMs),
      });
      const body = (await resp.json().catch(() => ({}))) as Record<string, unknown>;
      capiCapture.push({
        source: 'dispatch',
        datasetId,
        apiVersion,
        url,
        payload,
        httpStatus: resp.status,
        responseBody: body,
        timestamp: new Date().toISOString(),
      });
      return { httpStatus: resp.status, body };
    });

    capiRetrySvc.setCapiRetryFetcherForTesting(async (input, init) => {
      const urlStr = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      const mergedHeaders = {
        ...headersToRecord(init?.headers),
        'x-e2e-capi-captured': '1',
      };
      const resp = await globalThis.fetch(input as any, { ...init, headers: mergedHeaders });
      const clone = resp.clone();
      const body = (await clone.json().catch(() => ({}))) as Record<string, unknown>;
      let payload: Record<string, unknown> = {};
      try {
        const raw = extractBodyText(init?.body);
        payload = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
      } catch {
        payload = {};
      }
      const parsed = new URL(urlStr);
      const parts = parsed.pathname.split('/').filter(Boolean);
      const eventsIdx = parts.lastIndexOf('events');
      const datasetId = eventsIdx >= 1 ? parts[eventsIdx - 1] : '';
      const apiVersion = eventsIdx >= 2 ? parts[eventsIdx - 2] : 'v21.0';
      capiCapture.push({
        source: 'cron_retry',
        datasetId,
        apiVersion,
        url: urlStr,
        payload,
        httpStatus: resp.status,
        responseBody: body,
        timestamp: new Date().toISOString(),
      });
      return resp;
    });
  };

  installSmtpHook(true);
  installCapiHooks();
  zaloMailSvc.setZaloBotTransportForTesting(null);
  zaloMailSvc.setDiscordTransportForTesting(null);
  webhookSvc.setOutboundWebhookTransportForTesting(null);
  telegramSvc.setTelegramTransportForTesting(null);
  aiScreenerSvc.setLeadAiScreenerFetcherForTesting(null);
  metaAdsSvc.setMetaGraphFetcherForTesting(null);

  tenantRedis.clearAllForTesting();
  const pool = createDatabasePool({ inMemory: true });
  setDatabasePool(pool);
  await runMigrations({ seedSuperAdmin: true });

  const app = createApp();
  const server: Server = await new Promise((resolve) => {
    const srv = app.listen(0, '127.0.0.1', 4096, () => resolve(srv));
  });
  server.keepAliveTimeout = 65_000;
  server.headersTimeout = 66_000;

  const addr = server.address();
  const port = typeof addr === 'object' && addr ? addr.port : 0;
  const baseUrl = `http://127.0.0.1:${port}`;
  const cronSecret = (APP_CONFIG.cronSecret || APP_CONFIG.platformJwtSecret || '').trim();

  const apiRaw = async (reqPath: string, opts?: ApiRequestOptions): Promise<ApiRawResponse> => {
    const cleanPath = reqPath.startsWith('/') ? reqPath : `/${reqPath}`;
    const url = new URL(`${baseUrl}${cleanPath}`);
    if (opts?.query) {
      for (const [k, v] of Object.entries(opts.query)) {
        if (v !== undefined && v !== null) {
          url.searchParams.set(k, String(v));
        }
      }
    }

    const headers: Record<string, string> = {
      ...(opts?.headers || {}),
    };
    const token = opts?.token ?? opts?.auth?.accessToken;
    const tenantSlug = opts?.tenantSlug ?? opts?.auth?.tenantSlug;
    if (token && !headers['Authorization'] && !headers['authorization']) {
      headers['Authorization'] = `Bearer ${token}`;
    }
    if (tenantSlug && !headers['X-Tenant-Slug'] && !headers['x-tenant-slug']) {
      headers['X-Tenant-Slug'] = tenantSlug;
    }
    if (opts?.body !== undefined && !headers['Content-Type'] && !headers['content-type']) {
      headers['Content-Type'] = 'application/json';
    }

    const resp = await fetch(url.toString(), {
      method: (opts?.method || 'GET').toUpperCase(),
      headers,
      body:
        opts?.body === undefined
          ? undefined
          : typeof opts.body === 'string'
            ? opts.body
            : JSON.stringify(opts.body),
    });

    const rawText = await resp.text();
    let json: any = {};
    try {
      json = rawText ? JSON.parse(rawText) : {};
    } catch {
      json = {};
    }
    return {
      status: resp.status,
      ok: resp.ok,
      headers: resp.headers,
      rawText,
      json,
    };
  };

  const apiJson = async <T = any>(reqPath: string, opts?: ApiRequestOptions): Promise<T> => {
    const res = await apiRaw(reqPath, opts);
    if (!res.ok) {
      throw new Error(`HTTP ${res.status} ${opts?.method || 'GET'} ${reqPath}: ${res.rawText}`);
    }
    return res.json as T;
  };

  let tenantCounter = 0;

  const registerTenant = async (opts?: RegisterTenantOptions): Promise<TenantAuthContext> => {
    tenantCounter += 1;
    const uniqueSuffix = `${Date.now().toString(36)}${tenantCounter}${crypto.randomBytes(2).toString('hex')}`;
    const rawSlug = opts?.tenantSlug ?? opts?.tenant_slug ?? `mkt-e2e-${uniqueSuffix}`;
    const cleanSlug = rawSlug.toLowerCase();
    const companyName = opts?.companyName ?? opts?.company_name ?? `E2E Marketing ${cleanSlug}`;
    const workEmail = opts?.workEmail ?? opts?.work_email ?? `admin+${uniqueSuffix}@${cleanSlug}.vn`;
    const password = opts?.password ?? 'SecurePassword123!';
    const packageCode = opts?.packageCode ?? opts?.package_code ?? 'marketing_standalone';

    const res = await apiRaw('/api/v1/auth/register', {
      method: 'POST',
      body: {
        company_name: companyName,
        tenant_slug: cleanSlug,
        admin_name: opts?.adminName ?? opts?.admin_name ?? `${companyName} Admin`,
        work_email: workEmail,
        phone: opts?.phone ?? '0909111222',
        password,
        industry: opts?.industry ?? 'general',
        package_code: packageCode,
        seed_demo_leads: opts?.seedDemoLeads ?? opts?.seed_demo_leads ?? false,
        custom_settings: opts?.customSettings ?? opts?.custom_settings,
      },
    });

    const data = res.json?.data || {};
    const tenant = data.tenant || {};
    const user = data.user || {};
    const accessToken = String(data.access_token || '');
    const refreshToken = String(data.refresh_token || '');

    return {
      status: res.status,
      tenantId: String(tenant.id || ''),
      tenantSlug: String(tenant.slug || cleanSlug),
      accessToken,
      refreshToken,
      adminToken: accessToken,
      userId: String(user.id || ''),
      adminUserId: String(user.id || ''),
      email: String(user.email || workEmail),
      password,
      packageCode: String(tenant.package_code || packageCode),
      user,
      tenant,
      raw: res.json,
    };
  };

  const loginTenant = async (opts: LoginTenantOptions): Promise<TenantAuthContext> => {
    const slug = opts.tenantSlug ?? opts.tenant_slug;
    const res = await apiRaw('/api/v1/auth/login', {
      method: 'POST',
      body: {
        email: opts.email,
        password: opts.password,
        ...(slug ? { tenant_slug: slug.toLowerCase() } : {}),
      },
    });

    const data = res.json?.data || {};
    const tenant = data.tenant || {};
    const user = data.user || {};
    const accessToken = String(data.access_token || '');
    const refreshToken = String(data.refresh_token || '');

    return {
      status: res.status,
      tenantId: String(tenant.id || ''),
      tenantSlug: String(tenant.slug || slug || ''),
      accessToken,
      refreshToken,
      adminToken: accessToken,
      userId: String(user.id || ''),
      adminUserId: String(user.id || ''),
      email: String(user.email || opts.email),
      password: opts.password,
      packageCode: String(tenant.package_code || ''),
      user,
      tenant,
      raw: res.json,
    };
  };

  const settleManualBankTransfer = async (referenceCode: string, amountVnd: number) => {
    const payload = JSON.stringify({
      reference_code: referenceCode,
      external_tx_id: `ext_tx_${crypto.randomUUID()}`,
      amount_vnd: amountVnd,
      status: 'succeeded',
    });
    const secret = process.env.BILLING_MANUAL_WEBHOOK_SECRET || 'e2e_manual_webhook_secret_2026';
    const sig = `sha256=${crypto.createHmac('sha256', secret).update(payload).digest('hex')}`;
    return apiJson('/api/v1/billing/webhooks/manual_bank_transfer', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Webhook-Signature': sig,
      },
      body: payload,
    });
  };

  const upgradePackage = async (
    auth: TenantAuthContext,
    targetPackage: string,
    opts?: UpgradePackageOptions
  ): Promise<any> => {
    const path =
      opts?.endpoint === 'billing'
        ? '/api/v1/billing/switch-package'
        : '/api/v1/myerp/package-entitlements/upgrade';
    const headers: Record<string, string> = {};
    if (opts?.idempotencyKey) {
      headers['X-Idempotency-Key'] = opts.idempotencyKey;
    }
    const buildBody = () => ({
      package_code: targetPackage,
      ...(opts?.billingCycle ? { billing_cycle: opts.billingCycle } : {}),
      ...(opts?.months !== undefined ? { months: opts.months } : {}),
      payment_method: opts?.paymentMethod ?? 'wallet',
      ...(opts?.educationAddon !== undefined ? { education_addon: opts.educationAddon } : {}),
      ...(opts?.industryKey ? { industry_key: opts.industryKey } : {}),
      ...(opts?.scheduleAtPeriodEnd !== undefined
        ? { schedule_at_period_end: opts.scheduleAtPeriodEnd }
        : {}),
      ...(opts?.note ? { note: opts.note } : {}),
    });

    let res = await apiRaw(path, { method: 'POST', auth, headers, body: buildBody() });

    if (
      res.status === 402 &&
      res.json?.error?.code === 'INSUFFICIENT_WALLET_BALANCE' &&
      opts?.autoTopup !== false
    ) {
      const topupRes = await apiJson('/api/v1/billing/topup', {
        method: 'POST',
        auth,
        body: {
          amount_vnd: opts?.topupAmountVnd ?? 100_000_000,
          provider: 'manual_bank_transfer',
        },
      });
      const tx = topupRes.data?.transaction;
      if (!tx?.reference_code) {
        throw new Error(`Topup did not return transaction.reference_code: ${JSON.stringify(topupRes)}`);
      }
      await settleManualBankTransfer(String(tx.reference_code), Number(tx.amount_vnd));
      res = await apiRaw(path, { method: 'POST', auth, headers, body: buildBody() });
    }

    if (res.status === 201 && res.json?.data?.requires_payment && res.json?.data?.transaction?.reference_code) {
      await settleManualBankTransfer(
        String(res.json.data.transaction.reference_code),
        Number(res.json.data.transaction.amount_vnd)
      );
      const entitlements = await apiJson('/api/v1/myerp/package-entitlements', { auth });
      auth.packageCode = String(entitlements.data?.package_code || targetPackage);
      return res.json.data;
    }

    if (!res.ok) {
      throw new Error(`upgradePackage failed (${res.status}): ${res.rawText}`);
    }

    const outData = res.json?.data ?? res.json;
    if (outData?.package_code || outData?.current_package) {
      auth.packageCode = String(outData.package_code || outData.current_package);
    } else if (!opts?.scheduleAtPeriodEnd) {
      auth.packageCode = targetPackage;
    }
    return outData;
  };

  const triggerMasterCron = async (
    subroutines?: string[],
    tenantId?: string
  ): Promise<MasterCronResult> => {
    const body: Record<string, unknown> = {};
    if (subroutines !== undefined) body.subroutines = subroutines;
    if (tenantId !== undefined) body.tenant_id = tenantId;

    const res = await apiRaw('/api/v1/operations/cron/master', {
      method: 'POST',
      headers: {
        'X-Cron-Secret': cronSecret,
      },
      body,
    });

    return {
      status: res.status,
      locked: Boolean(res.json?.data?.locked ?? res.json?.data?.skipped),
      stats: res.json?.data?.stats || {},
      json: res.json,
    };
  };

  let tornDown = false;
  const teardown = async () => {
    if (tornDown) return;
    tornDown = true;

    zaloMailSvc.setSmtpTransportForTesting(null);
    zaloMailSvc.setEmailWebhookFetcherForTesting(null);
    zaloMailSvc.setZaloBotTransportForTesting(null);
    zaloMailSvc.setDiscordTransportForTesting(null);
    capiSvc.setCapiHttpTransportForTesting(null);
    capiRetrySvc.setCapiRetryFetcherForTesting(null);
    webhookSvc.setOutboundWebhookTransportForTesting(null);
    telegramSvc.setTelegramTransportForTesting(null);
    aiScreenerSvc.setLeadAiScreenerFetcherForTesting(null);
    metaAdsSvc.setMetaGraphFetcherForTesting(null);

    try {
      server.closeAllConnections?.();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    } finally {
      await webhookSink.close().catch(() => {});
      mockFetch.restore();
      await pool.close().catch(() => {});
      setDatabasePool(null);
      tenantRedis.clearAllForTesting();
    }
  };

  return {
    baseUrl,
    cronSecret,
    webhookSink,
    mockFetch,
    emailCapture,
    zaloCapture,
    capiCapture,
    apiRaw,
    apiJson,
    registerTenant,
    loginTenant,
    upgradePackage,
    triggerMasterCron,
    setSmtpCaptureEnabled: (enabled: boolean) => installSmtpHook(enabled),
    resetCaptures: () => {
      emailCapture.length = 0;
      zaloCapture.length = 0;
      capiCapture.length = 0;
      mockFetch.clearRequests();
      mockFetch.resetFailureModes();
      webhookSink.clearDeliveries();
      webhookSink.setStatus(200);
      installSmtpHook(true);
      installCapiHooks();
    },
    teardown,
  };
}
