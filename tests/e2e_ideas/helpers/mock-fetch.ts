import type { SnsTestSigner } from './sns-signer.ts';

export interface RecordedFetchRequest {
  url: string;
  hostname: string;
  pathname: string;
  method: string;
  headers: Record<string, string>;
  body: string;
  jsonBody: unknown;
  blocked: boolean;
  matchedRouteId: string | null;
  timestamp: string;
}

export interface MockFetchRouteSpec {
  id?: string;
  match: (url: URL, method: string, req: RecordedFetchRequest) => boolean;
  handler: (req: RecordedFetchRequest, url: URL) => Response | Promise<Response>;
}

export interface IdeasMockFetchController {
  requests: RecordedFetchRequest[];
  registerRoute: (spec: MockFetchRouteSpec) => string;
  unregisterRoute: (id: string) => boolean;
  registerSnsCertRoute: (signerOrCertPem: SnsTestSigner | string, explicitCertUrl?: string) => string;
  getRequests: (filter?: string | ((req: RecordedFetchRequest) => boolean)) => RecordedFetchRequest[];
  getBlockedRequests: () => RecordedFetchRequest[];
  clearRequests: () => void;
  restore: () => void;
}

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);

function normalizeHeaders(input: RequestInit['headers'] | undefined, reqObj?: Request): Record<string, string> {
  const out: Record<string, string> = {};
  if (reqObj) {
    reqObj.headers.forEach((v, k) => {
      out[k.toLowerCase()] = v;
    });
  }
  if (!input) return out;
  if (input instanceof Headers) {
    input.forEach((v, k) => {
      out[k.toLowerCase()] = v;
    });
  } else if (Array.isArray(input)) {
    for (const [k, v] of input) {
      out[String(k).toLowerCase()] = String(v);
    }
  } else {
    for (const [k, v] of Object.entries(input)) {
      if (v !== undefined) {
        out[k.toLowerCase()] = String(v);
      }
    }
  }
  return out;
}

async function extractBodyText(input: string | URL | Request, init?: RequestInit): Promise<string> {
  if (init?.body !== undefined && init.body !== null) {
    if (typeof init.body === 'string') return init.body;
    if (init.body instanceof URLSearchParams) return init.body.toString();
    if (Buffer.isBuffer(init.body)) return init.body.toString('utf8');
    if (init.body instanceof Uint8Array) return Buffer.from(init.body).toString('utf8');
    if (init.body instanceof ArrayBuffer) return Buffer.from(init.body).toString('utf8');
    try {
      return String(init.body);
    } catch {
      return '';
    }
  }
  if (typeof Request !== 'undefined' && input instanceof Request) {
    try {
      return await input.clone().text();
    } catch {
      return '';
    }
  }
  return '';
}

export function installIdeasMockFetch(): IdeasMockFetchController {
  const originalFetch = globalThis.fetch;
  const requests: RecordedFetchRequest[] = [];
  const routes: Array<{
    id: string;
    match: MockFetchRouteSpec['match'];
    handler: MockFetchRouteSpec['handler'];
  }> = [];
  let routeSeq = 0;
  let restored = false;

  const registerRoute = (spec: MockFetchRouteSpec): string => {
    routeSeq += 1;
    const id = spec.id || `route_${routeSeq}`;
    routes.push({ id, match: spec.match, handler: spec.handler });
    return id;
  };

  const unregisterRoute = (id: string): boolean => {
    const idx = routes.findIndex((r) => r.id === id);
    if (idx === -1) return false;
    routes.splice(idx, 1);
    return true;
  };

  const registerSnsCertRoute = (
    signerOrCertPem: SnsTestSigner | string,
    explicitCertUrl?: string
  ): string => {
    const certPem = typeof signerOrCertPem === 'string' ? signerOrCertPem : signerOrCertPem.certPem;
    const targetUrl =
      explicitCertUrl || (typeof signerOrCertPem === 'string' ? null : signerOrCertPem.signingCertUrl);

    return registerRoute({
      id: targetUrl ? `sns-cert:${targetUrl}` : 'sns-cert-wildcard',
      match: (url, method) => {
        if (method !== 'GET') return false;
        if (targetUrl) return url.toString() === targetUrl;
        return /^https:\/\/sns\.[a-z0-9-]+\.amazonaws\.com\/.*\.pem$/i.test(url.toString());
      },
      handler: () =>
        new Response(certPem, {
          status: 200,
          headers: { 'Content-Type': 'application/x-pem-file' },
        }),
    });
  };

  const wrappedFetch = (async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const reqObj = typeof Request !== 'undefined' && input instanceof Request ? input : undefined;
    const urlStr = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    const parsed = new URL(urlStr);

    if (LOOPBACK_HOSTS.has(parsed.hostname.toLowerCase())) {
      return Reflect.apply(originalFetch, globalThis, [input as any, init]);
    }

    const method = (init?.method || reqObj?.method || 'GET').toUpperCase();
    const headers = normalizeHeaders(init?.headers, reqObj);
    const body = await extractBodyText(input, init);
    let jsonBody: unknown = null;
    if (body) {
      try {
        jsonBody = JSON.parse(body);
      } catch {
        jsonBody = null;
      }
    }

    const record: RecordedFetchRequest = {
      url: urlStr,
      hostname: parsed.hostname.toLowerCase(),
      pathname: parsed.pathname,
      method,
      headers,
      body,
      jsonBody,
      blocked: false,
      matchedRouteId: null,
      timestamp: new Date().toISOString(),
    };
    // Always record external requests BEFORE matching/throwing so blocked attempts are observable.
    requests.push(record);

    for (let i = routes.length - 1; i >= 0; i--) {
      const route = routes[i];
      if (route.match(parsed, method, record)) {
        record.matchedRouteId = route.id;
        return await route.handler(record, parsed);
      }
    }

    record.blocked = true;
    throw new Error(`BLOCKED_UNMOCKED_EXTERNAL_FETCH: ${method} ${urlStr}`);
  }) as typeof globalThis.fetch;

  globalThis.fetch = wrappedFetch;

  return {
    requests,
    registerRoute,
    unregisterRoute,
    registerSnsCertRoute,
    getRequests: (filter) => {
      if (!filter) return [...requests];
      if (typeof filter === 'string') {
        const needle = filter.toLowerCase();
        return requests.filter((r) => r.url.toLowerCase().includes(needle) || r.hostname.includes(needle));
      }
      return requests.filter(filter);
    },
    getBlockedRequests: () => requests.filter((r) => r.blocked),
    clearRequests: () => {
      requests.length = 0;
    },
    restore: () => {
      if (restored) return;
      restored = true;
      if (globalThis.fetch === wrappedFetch) {
        globalThis.fetch = originalFetch;
      }
    },
  };
}
