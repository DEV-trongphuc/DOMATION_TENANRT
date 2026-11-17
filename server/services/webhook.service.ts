import crypto from 'node:crypto';
import { tenantRedis } from '../core/cache/tenant-redis.ts';
import { withTenantTransaction } from '../core/database/transaction.ts';
import { tenantQueue } from '../core/queue/tenant-queue.ts';
import {
  getTenantSettingsCached,
  getOutboundWebhooksCached,
} from '../core/settings/tenant-cache.ts';
import type { LeadIngestInput } from './distribution.service.ts';
import { isLocalLoopbackUrl, isOutboundSilentMode } from '../core/security/outbound-guard.ts';

const VOLATILE_WEBHOOK_KEYS = new Set(['submitted_at', 'timestamp', '_ts', 'request_id']);

function canonicalizeJsonValue(val: unknown, extraIgnored?: Set<string>): unknown {
  if (val === null || val === undefined) return null;
  if (typeof val === 'string') return val.trim();
  if (typeof val !== 'object') return val;
  if (Array.isArray(val)) {
    return val.map((item) => canonicalizeJsonValue(item, extraIgnored));
  }
  const obj = val as Record<string, unknown>;
  const sortedKeys = Object.keys(obj)
    .filter((k) => !VOLATILE_WEBHOOK_KEYS.has(k) && !extraIgnored?.has(k))
    .sort();
  const out: Record<string, unknown> = {};
  for (const k of sortedKeys) {
    out[k] = canonicalizeJsonValue(obj[k], extraIgnored);
  }
  return out;
}

/**
 * Computes deterministic SHA-256 canonical payload hash excluding volatile timestamp/request_id keys
 * and any tenant-configured ignored keys.
 */
export function computeCanonicalPayloadHash(
  payload: Record<string, unknown>,
  extraIgnoredKeys?: string[]
): string {
  const extraSet =
    Array.isArray(extraIgnoredKeys) && extraIgnoredKeys.length > 0
      ? new Set(extraIgnoredKeys.map((k) => String(k || '').trim()).filter(Boolean))
      : undefined;
  const canonical = canonicalizeJsonValue(payload, extraSet);
  return crypto.createHash('sha256').update(JSON.stringify(canonical), 'utf8').digest('hex');
}

/**
 * Verifies HMAC-SHA256 webhook signature (`sha256=<hex>` or `<hex>`) using constant-time comparison.
 */
export function verifyWebhookHmacSignature(
  rawBody: string | Buffer,
  signingSecret: string,
  signatureHeader?: string | null
): boolean {
  if (!signatureHeader || !signingSecret) return false;
  const cleanSig = signatureHeader.trim().replace(/^sha256=/i, '');
  if (!/^[0-9a-f]{64}$/i.test(cleanSig)) return false;

  const expectedHex = crypto.createHmac('sha256', signingSecret).update(rawBody).digest('hex');
  const expectedBuf = Buffer.from(expectedHex, 'hex');
  const actualBuf = Buffer.from(cleanSig, 'hex');

  if (expectedBuf.length !== actualBuf.length) return false;
  return crypto.timingSafeEqual(expectedBuf, actualBuf);
}

export function signWebhookPayload(rawBody: string, signingSecret: string): string {
  return crypto.createHmac('sha256', signingSecret).update(rawBody, 'utf8').digest('hex');
}

/**
 * Checks configurable Dual-Mode Webhook Idempotency in Tenant-Namespaced Redis:
 * - Path A: `X-Idempotency-Key` header
 * - Path B: Canonical JSON Payload SHA-256 Hash
 * Setting `ttlSeconds <= 0` disables idempotency deduplication when requested by tenant configuration.
 */
export async function checkAndRecordWebhookIdempotency(params: {
  tenantId: string;
  idempotencyHeader?: string | null;
  payload: Record<string, unknown>;
  ttlSeconds?: number;
  ignoredKeys?: string[];
}): Promise<{ isDuplicate: boolean; idempotencyKeyUsed: string }> {
  const ttl = params.ttlSeconds ?? 86_400; // Default 24 hours
  if (ttl <= 0) {
    return { isDuplicate: false, idempotencyKeyUsed: 'disabled' };
  }

  if (params.idempotencyHeader && params.idempotencyHeader.trim()) {
    const headerKey = `cache:idempotency:header:${params.idempotencyHeader.trim()}`;
    const inserted = await tenantRedis.setNxEx(headerKey, '1', ttl, params.tenantId);
    if (!inserted) {
      return { isDuplicate: true, idempotencyKeyUsed: headerKey };
    }
  }

  const payloadHash = computeCanonicalPayloadHash(params.payload, params.ignoredKeys);
  const payloadKey = `cache:idempotency:payload:${payloadHash}`;
  const insertedPayload = await tenantRedis.setNxEx(payloadKey, '1', ttl, params.tenantId);
  if (!insertedPayload) {
    return { isDuplicate: true, idempotencyKeyUsed: payloadKey };
  }

  return { isDuplicate: false, idempotencyKeyUsed: payloadKey };
}

const CANONICAL_LEAD_FIELDS = new Set([
  'name',
  'phone',
  'email',
  'source',
  'campaign',
  'utm_medium',
  'utm_content',
  'meta_lead_id',
  'fbclid',
  'fbc',
  'fbp',
  'note',
  'pipeline_id',
]);

/**
 * Transforms an arbitrary inbound JSON payload (Ladipage, Facebook Lead Ads, Sheet, Custom Form)
 * into a canonical `LeadIngestInput` using `field_mappings` + per-webhook metadata (`_target_pipeline_id`,
 * `_default_source`, `_force_assigned_to`, `_custom_constants`) + Vietnamese/English fallbacks.
 */
export function mapWebhookPayloadToLead(
  payload: Record<string, unknown>,
  fieldMappings: Record<string, unknown> = {},
  defaultSourceFallback = 'Webhook'
): LeadIngestInput {
  const mapped: Record<string, any> = {
    custom_fields: {},
  };

  if (fieldMappings._custom_constants && typeof fieldMappings._custom_constants === 'object') {
    Object.assign(mapped.custom_fields, fieldMappings._custom_constants);
  }

  // Apply explicit visual field mappings first (`foreignKey -> systemField`)
  for (const [foreignKey, targetField] of Object.entries(fieldMappings)) {
    if (foreignKey.startsWith('_') || typeof targetField !== 'string' || !targetField.trim()) continue;
    const val = payload[foreignKey];
    if (val !== undefined && val !== null && val !== '') {
      if (CANONICAL_LEAD_FIELDS.has(targetField)) {
        mapped[targetField] = String(val);
      } else {
        mapped.custom_fields[targetField] = val;
      }
    }
  }

  const configuredDefaultSource =
    typeof fieldMappings._default_source === 'string' && fieldMappings._default_source.trim()
      ? fieldMappings._default_source.trim()
      : defaultSourceFallback;

  const configuredTargetPipelineId =
    typeof fieldMappings._target_pipeline_id === 'string' && fieldMappings._target_pipeline_id.trim()
      ? fieldMappings._target_pipeline_id.trim()
      : undefined;

  const configuredForceAssignee =
    typeof fieldMappings._force_assigned_to === 'string' && fieldMappings._force_assigned_to.trim()
      ? fieldMappings._force_assigned_to.trim()
      : undefined;

  // Fallback standard aliases if not already mapped
  mapped.name =
    mapped.name ||
    payload.name ||
    payload.full_name ||
    payload.ho_ten ||
    payload.fullname ||
    payload.customer_name ||
    '';

  mapped.phone =
    mapped.phone ||
    payload.phone ||
    payload.so_dien_thoai ||
    payload.phone_number ||
    payload.sdt ||
    payload.mobile ||
    '';

  mapped.email = mapped.email || payload.email || payload.mail || undefined;
  mapped.source = mapped.source || payload.source || payload.utm_source || configuredDefaultSource;
  mapped.campaign = mapped.campaign || payload.campaign || payload.utm_campaign || payload.du_an || undefined;
  mapped.utm_medium = mapped.utm_medium || payload.utm_medium || undefined;
  mapped.utm_content = mapped.utm_content || payload.utm_content || undefined;
  mapped.meta_lead_id = mapped.meta_lead_id || payload.meta_lead_id || payload.leadgen_id || undefined;
  mapped.fbclid = mapped.fbclid || payload.fbclid || undefined;
  mapped.fbc = mapped.fbc || payload.fbc || undefined;
  mapped.fbp = mapped.fbp || payload.fbp || undefined;
  mapped.note = mapped.note || payload.note || payload.ghi_chu || payload.nhu_cau || undefined;
  mapped.pipeline_id = mapped.pipeline_id || payload.pipeline_id || configuredTargetPipelineId || undefined;

  const ignoredSet = new Set<string>(
    Array.isArray(fieldMappings._ignored_keys)
      ? fieldMappings._ignored_keys.map((x) => String(x || '').trim()).filter(Boolean)
      : []
  );

  // Preserve extra custom attributes (`du_an`, `nhu_cau`, etc.) inside custom_fields unless ignored
  for (const [k, v] of Object.entries(payload)) {
    if (
      v !== undefined &&
      v !== null &&
      !VOLATILE_WEBHOOK_KEYS.has(k) &&
      !k.startsWith('_') &&
      k !== 'live_test_seq' &&
      !ignoredSet.has(k) &&
      !CANONICAL_LEAD_FIELDS.has(k) &&
      !(k in fieldMappings)
    ) {
      mapped.custom_fields[k] = v;
    }
  }

  return {
    name: String(mapped.name || ''),
    phone: String(mapped.phone || ''),
    email: mapped.email ? String(mapped.email) : undefined,
    source: String(mapped.source || configuredDefaultSource),
    campaign: mapped.campaign ? String(mapped.campaign) : undefined,
    utm_medium: mapped.utm_medium ? String(mapped.utm_medium) : undefined,
    utm_content: mapped.utm_content ? String(mapped.utm_content) : undefined,
    meta_lead_id: mapped.meta_lead_id ? String(mapped.meta_lead_id) : undefined,
    fbclid: mapped.fbclid ? String(mapped.fbclid) : undefined,
    fbclid_raw: undefined,
    fbc: mapped.fbc ? String(mapped.fbc) : undefined,
    fbp: mapped.fbp ? String(mapped.fbp) : undefined,
    note: mapped.note ? String(mapped.note) : undefined,
    pipeline_id: mapped.pipeline_id ? String(mapped.pipeline_id) : undefined,
    force_assigned_to: configuredForceAssignee,
    custom_fields: mapped.custom_fields,
  } as LeadIngestInput;
}

export type OutboundTransportFn = (
  url: string,
  options: { method: string; headers: Record<string, string>; body: string; timeoutMs?: number }
) => Promise<{ status: number; statusText?: string }>;

let customOutboundTransport: OutboundTransportFn | null = null;

export function setOutboundWebhookTransportForTesting(fn: OutboundTransportFn | null): void {
  customOutboundTransport = fn;
}

async function defaultHttpTransport(
  url: string,
  options: { method: string; headers: Record<string, string>; body: string; timeoutMs?: number }
): Promise<{ status: number; statusText?: string }> {
  if (isOutboundSilentMode() && !isLocalLoopbackUrl(url)) {
    return { status: 200, statusText: 'OUTBOUND_SILENT_SKIPPED' };
  }
  const resp = await fetch(url, {
    method: options.method,
    headers: options.headers,
    body: options.body,
    signal: AbortSignal.timeout(options.timeoutMs || 8000),
  });
  return { status: resp.status, statusText: resp.statusText };
}

/**
 * Dispatches an outbound webhook event to all subscribed tenant endpoints with
 * configurable retry attempts and Dead Letter Queue (`tenant_webhook_dlq`) persistence on failure.
 */
export async function dispatchOutboundWebhookEvent(params: {
  tenantId: string;
  eventType: string;
  payload: Record<string, unknown>;
  maxAttempts?: number;
  retryDelayMs?: number;
}): Promise<{ delivered: number; failedToDlq: number }> {
  const [cfg, allWebhooks] = await Promise.all([
    getTenantSettingsCached(params.tenantId),
    getOutboundWebhooksCached(params.tenantId),
  ]);

  const webhooks = allWebhooks.filter(
    (w) =>
      w.url &&
      (w.subscribed_events.length === 0 ||
        w.subscribed_events.includes('*') ||
        w.subscribed_events.includes(params.eventType))
  );

  if (webhooks.length === 0) {
    return { delivered: 0, failedToDlq: 0 };
  }

  const tenantMaxRetries = cfg.outbound_webhook_max_retries;
  const tenantTimeoutMs = cfg.outbound_webhook_timeout_ms;

  const baseDelay = params.retryDelayMs ?? 10;
  const transport = customOutboundTransport || defaultHttpTransport;

  let delivered = 0;
  let failedToDlq = 0;

  for (const wh of webhooks) {
    const perWebhookRetries =
      wh.field_mappings && typeof wh.field_mappings._max_retries === 'number'
        ? Math.min(20, Math.max(1, Math.round(wh.field_mappings._max_retries)))
        : undefined;
    const maxAttempts = params.maxAttempts ?? perWebhookRetries ?? tenantMaxRetries ?? 5;

    const deliveryId = `del-${crypto.randomUUID()}`;
    const bodyStr = JSON.stringify(params.payload);
    const timestamp = String(Math.floor(Date.now() / 1000));
    const sig = signWebhookPayload(bodyStr, wh.signing_secret);

    let succeeded = false;
    let lastError = '';
    let attemptsRun = 0;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      attemptsRun = attempt;
      try {
        const resp = await transport(wh.url!, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-AutoData-Event': params.eventType,
            'X-AutoData-Delivery-Id': deliveryId,
            'X-AutoData-Timestamp': timestamp,
            'X-AutoData-Signature-256': sig,
          },
          body: bodyStr,
          timeoutMs: tenantTimeoutMs,
        });
        if (resp.status >= 200 && resp.status < 300) {
          succeeded = true;
          delivered += 1;
          break;
        }
        lastError = `HTTP ${resp.status} ${resp.statusText || ''}`.trim();
      } catch (err: any) {
        lastError = err?.message || 'Network delivery failure';
      }

      if (attempt < maxAttempts && baseDelay > 0) {
        await new Promise((r) => setTimeout(r, baseDelay * attempt));
      }
    }

    if (!succeeded) {
      failedToDlq += 1;
      await withTenantTransaction(params.tenantId, async (client) => {
        await client.query(
          `INSERT INTO tenant_webhook_dlq (
            tenant_id, webhook_id, event_type, delivery_id, payload, error_trace, retry_count
          ) VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7)`,
          [
            params.tenantId,
            wh.id,
            params.eventType,
            deliveryId,
            bodyStr,
            lastError || `Exceeded maximum ${maxAttempts} delivery retries`,
            attemptsRun,
          ]
        );
      });
    }
  }

  return { delivered, failedToDlq };
}

export async function dispatchOutboundWebhook(
  tenantId: string,
  eventType: string,
  payload: Record<string, unknown>
): Promise<{ delivered: number; failedToDlq: number }> {
  return dispatchOutboundWebhookEvent({ tenantId, eventType, payload });
}

/**
 * Enqueues an outbound webhook event onto the Fair-Share TenantQueueEngine so noisy tenants
 * with slow external ERP endpoints never starve other tenants or block HTTP API responses.
 */
export function enqueueOutboundWebhookEvent(params: {
  tenantId: string;
  eventType: string;
  payload: Record<string, unknown>;
}): void {
  const cachedHooks = tenantRedis.getCachedOutboundWebhooks(params.tenantId);
  if (cachedHooks !== null) {
    const hasMatch = cachedHooks.some(
      (w) =>
        w.url &&
        (w.subscribed_events.length === 0 ||
          w.subscribed_events.includes('*') ||
          w.subscribed_events.includes(params.eventType))
    );
    if (!hasMatch) {
      return;
    }
  }
  tenantQueue.enqueue(params.tenantId, 'webhook-dispatch', params, { maxAttempts: 1 });
}

tenantQueue.registerWorker('webhook-dispatch', async (job) => {
  await dispatchOutboundWebhookEvent(job.payload);
});

/**
 * Replays a failed Dead Letter Queue item (`POST /webhooks/dlq/:id/replay`).
 */
export async function replayWebhookDlqItem(
  tenantId: string,
  dlqId: string
): Promise<{ replayed: boolean; status: string }> {
  const cfg = await getTenantSettingsCached(tenantId);
  const item = await withTenantTransaction(tenantId, async (client) => {
    const res = await client.query<{
      id: string;
      webhook_id: string;
      event_type: string;
      delivery_id: string;
      payload: Record<string, unknown>;
      url: string | null;
      signing_secret: string;
    }>(
      `SELECT d.id, d.webhook_id, d.event_type, d.delivery_id, d.payload, w.url, w.signing_secret
       FROM tenant_webhook_dlq d
       INNER JOIN tenant_webhooks w ON w.tenant_id = d.tenant_id AND w.id = d.webhook_id
       WHERE d.tenant_id = $1 AND d.id = $2
       LIMIT 1`,
      [tenantId, dlqId]
    );
    return res.rows[0] || null;
  });

  if (!item || !item.url) {
    throw new Error('DLQ_ITEM_NOT_FOUND');
  }

  const transport = customOutboundTransport || defaultHttpTransport;
  const bodyStr = JSON.stringify(item.payload);
  const sig = signWebhookPayload(bodyStr, item.signing_secret);

  const resp = await transport(item.url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-AutoData-Event': item.event_type,
      'X-AutoData-Delivery-Id': `${item.delivery_id}-replay`,
      'X-AutoData-Timestamp': String(Math.floor(Date.now() / 1000)),
      'X-AutoData-Signature-256': sig,
    },
    body: bodyStr,
    timeoutMs: cfg.outbound_webhook_timeout_ms,
  });

  if (resp.status >= 200 && resp.status < 300) {
    await withTenantTransaction(tenantId, async (client) => {
      await client.query('DELETE FROM tenant_webhook_dlq WHERE tenant_id = $1 AND id = $2', [tenantId, dlqId]);
    });
    return { replayed: true, status: 'DELIVERED_AND_CLEARED' };
  }

  await withTenantTransaction(tenantId, async (client) => {
    await client.query(
      `UPDATE tenant_webhook_dlq
       SET retry_count = retry_count + 1,
           error_trace = $3,
           last_attempt_at = clock_timestamp()
       WHERE tenant_id = $1 AND id = $2`,
      [tenantId, dlqId, `Replay failed: HTTP ${resp.status}`]
    );
  });

  return { replayed: false, status: `REPLAY_FAILED_HTTP_${resp.status}` };
}
