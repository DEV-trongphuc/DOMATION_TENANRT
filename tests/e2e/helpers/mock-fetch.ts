export interface RecordedFetchRequest {
  url: string;
  hostname: string;
  pathname: string;
  method: string;
  headers: Record<string, string>;
  body: string;
  jsonBody: any;
  timestamp: string;
}

export interface MockFailureConfig {
  metaStatus?: number | null;
  metaErrorCode?: number | null;
  metaErrorMessage?: string | null;
  metaCapiStatus?: number | null;
  emptyMetaInsights?: boolean;
  telegramStatus?: number | null;
  zaloStatus?: number | null;
  resendStatus?: number | null;
  discordStatus?: number | null;
  appscriptStatus?: number | null;
  geminiStatus?: number | null;
  geminiCustomText?: string | null;
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

export interface MockFetchController {
  getRequests: (hostSubstring?: string) => RecordedFetchRequest[];
  clearRequests: () => void;
  setFailureMode: (patch: Partial<MockFailureConfig>) => void;
  resetFailureModes: () => void;
  restore: () => void;
}

export function installMockFetch(initialFailures: MockFailureConfig = {}): MockFetchController {
  const originalFetch = globalThis.fetch.bind(globalThis);
  const requests: RecordedFetchRequest[] = [];
  let failures: MockFailureConfig = { ...initialFailures };

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

    requests.push({
      url: urlStr,
      hostname: parsed.hostname,
      pathname: parsed.pathname,
      method,
      headers: hdrs,
      body: bodyText,
      jsonBody,
      timestamp: new Date().toISOString(),
    });

    const host = parsed.hostname.toLowerCase();

    // 1. Meta Graph API (CAPI & Meta Ads Insights / Batch)
    if (host === 'graph.facebook.com') {
      if (parsed.pathname.endsWith('/events')) {
        if (failures.metaCapiStatus && failures.metaCapiStatus >= 400) {
          return makeJsonResponse(failures.metaCapiStatus, {
            error: {
              message: failures.metaErrorMessage || `Injected Meta CAPI HTTP ${failures.metaCapiStatus}`,
              type: 'OAuthException',
              code: failures.metaErrorCode || 190,
            },
          });
        }
        return makeJsonResponse(200, {
          events_received: 1,
          messages: [],
          fbtrace_id: `mock_fbtrace_${requests.length}`,
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

      return makeJsonResponse(200, { data: [], success: true });
    }

    // 2. Telegram Bot API
    if (host === 'api.telegram.org') {
      if (failures.telegramStatus && failures.telegramStatus >= 400) {
        return makeJsonResponse(failures.telegramStatus, { ok: false, description: 'Injected Telegram error' });
      }
      return makeJsonResponse(200, { ok: true, result: { message_id: 9000 + requests.length } });
    }

    // 3. Zalo Bot & OA API
    if (host === 'bot-api.zaloplatforms.com' || host === 'openapi.zalo.me') {
      if (failures.zaloStatus && failures.zaloStatus >= 400) {
        return makeJsonResponse(failures.zaloStatus, { ok: false, error: -1, description: 'Injected Zalo error' });
      }
      return makeJsonResponse(200, {
        ok: true,
        error: 0,
        message: 'Success',
        result: {
          account_name: 'DOMATION Zalo Mock Bot',
          message_id: `zalo_msg_${requests.length}`,
          chat: { id: 'zalo_chat_001' },
        },
      });
    }

    // 4. Resend Email API
    if (host === 'api.resend.com') {
      if (failures.resendStatus && failures.resendStatus >= 400) {
        return makeJsonResponse(failures.resendStatus, { message: 'Injected Resend error' });
      }
      return makeJsonResponse(200, { id: `resend_mock_${requests.length}` });
    }

    // 5. Discord Webhook API
    if (host === 'discord.com' || host === 'discordapp.com') {
      if (failures.discordStatus && failures.discordStatus >= 400) {
        return makeJsonResponse(failures.discordStatus, { message: 'Injected Discord error' });
      }
      return makeJsonResponse(200, { id: `discord_mock_${requests.length}` });
    }

    // 6. Google Apps Script Email / Google Ads Proxy
    if (host === 'script.google.com') {
      if (failures.appscriptStatus && failures.appscriptStatus >= 400) {
        return makeJsonResponse(failures.appscriptStatus, { success: false, error: 'Injected Apps Script error' });
      }
      return makeJsonResponse(200, {
        success: true,
        remaining_quota: 98,
        sheet_logged: true,
        campaigns: [],
      });
    }

    // 7. Google Gemini API
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
      });
    }

    // Fail loudly on any unexpected unmocked external host
    throw new Error(`UNMOCKED_EXTERNAL_FETCH: ${method} ${urlStr}`);
  }) as typeof fetch;

  return {
    getRequests(hostSubstring?: string) {
      if (!hostSubstring) return [...requests];
      const needle = hostSubstring.toLowerCase();
      return requests.filter((r) => r.hostname.toLowerCase().includes(needle) || r.url.toLowerCase().includes(needle));
    },
    clearRequests() {
      requests.length = 0;
    },
    setFailureMode(patch: Partial<MockFailureConfig>) {
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
