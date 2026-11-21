import crypto from 'node:crypto';
import type { Request, Response } from 'express';
import type { DbClient } from '../core/database/db-adapter.ts';
import { withSystemPrivilege, withTenantTransaction } from '../core/database/transaction.ts';
import { isOutboundSilentMode } from '../core/security/outbound-guard.ts';
import { sendApiError } from '../core/security/rbac.ts';
import { ensureMarketingSchema } from '../modules/marketing/schema.ts';
import { normalizeSuppressionRecipient, parseJsonCol } from '../modules/marketing/utils.ts';

export interface SnsEnvelope {
  Type: string;
  MessageId: string;
  TopicArn: string;
  Subject?: string | null;
  Message: string;
  Timestamp: string;
  SignatureVersion: string;
  Signature: string;
  SigningCertURL: string;
  SubscribeURL?: string;
  UnsubscribeURL?: string;
  Token?: string;
}

export interface SnsHttpResponse {
  ok: boolean;
  status: number;
  text: () => Promise<string>;
}

export type SnsHttpFetcherFn = (
  url: string,
  init?: { method?: string; redirect?: 'error' | 'follow' | 'manual'; signal?: AbortSignal }
) => Promise<SnsHttpResponse>;

let customSnsHttpFetcherForTesting: SnsHttpFetcherFn | null = null;
const snsCertCache = new Map<string, { pem: string; expiresAt: number }>();
const CERT_CACHE_TTL_MS = 60 * 60 * 1000;
const CERT_CACHE_MAX = 100;

export function setSnsHttpFetcherForTesting(fn: SnsHttpFetcherFn | null): void {
  customSnsHttpFetcherForTesting = fn;
}

export function clearSnsCertCacheForTesting(): void {
  snsCertCache.clear();
}

export function isValidAwsSnsUrl(rawUrl: string, requirePem = false): boolean {
  if (typeof rawUrl !== 'string' || !rawUrl.trim()) return false;
  if (/%(?:2e|5c|00)/i.test(rawUrl) || rawUrl.includes('..') || rawUrl.includes('\\') || rawUrl.includes('\0')) return false;

  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return false;
  }

  if (parsed.protocol !== 'https:') return false;
  if (parsed.username || parsed.password || parsed.port || parsed.hash) return false;
  if (requirePem && parsed.search) return false;
  if (!/^sns\.[a-z0-9-]+\.amazonaws\.com$/.test(parsed.hostname)) return false;
  if (parsed.pathname.includes('..') || parsed.pathname.includes('//')) return false;

  if (requirePem) {
    return /^\/[^/]+\.pem$/i.test(parsed.pathname) || parsed.pathname.toLowerCase().endsWith('.pem');
  }
  return parsed.pathname.startsWith('/');
}

export function buildSnsStringToSign(msg: SnsEnvelope): string {
  const pairs: Array<[string, string]> = [];
  if (msg.Type === 'Notification') {
    pairs.push(['Message', String(msg.Message ?? '')]);
    pairs.push(['MessageId', String(msg.MessageId ?? '')]);
    if (msg.Subject !== undefined && msg.Subject !== null) {
      pairs.push(['Subject', String(msg.Subject)]);
    }
    pairs.push(['Timestamp', String(msg.Timestamp ?? '')]);
    pairs.push(['TopicArn', String(msg.TopicArn ?? '')]);
    pairs.push(['Type', String(msg.Type ?? '')]);
  } else if (msg.Type === 'SubscriptionConfirmation' || msg.Type === 'UnsubscribeConfirmation') {
    pairs.push(['Message', String(msg.Message ?? '')]);
    pairs.push(['MessageId', String(msg.MessageId ?? '')]);
    pairs.push(['SubscribeURL', String(msg.SubscribeURL ?? '')]);
    pairs.push(['Timestamp', String(msg.Timestamp ?? '')]);
    pairs.push(['Token', String(msg.Token ?? '')]);
    pairs.push(['TopicArn', String(msg.TopicArn ?? '')]);
    pairs.push(['Type', String(msg.Type ?? '')]);
  }
  return pairs.map(([k, v]) => `${k}\n${v}\n`).join('');
}

async function fetchSnsCertificatePem(certUrl: string): Promise<string> {
  const now = Date.now();
  const cached = snsCertCache.get(certUrl);
  if (cached && cached.expiresAt > now) {
    return cached.pem;
  }

  const fetcher: SnsHttpFetcherFn =
    customSnsHttpFetcherForTesting ||
    (async (u, init) => {
      if (isOutboundSilentMode()) {
        throw new Error('SNS certificate fetch blocked in outbound silent mode without test fetcher');
      }
      const r = await fetch(u, init);
      return {
        ok: r.ok,
        status: r.status,
        text: () => r.text(),
      };
    });

  const resp = await fetcher(certUrl, {
    method: 'GET',
    redirect: 'error',
    signal: AbortSignal.timeout(5000),
  });
  if (!resp.ok) {
    throw new Error(`Failed to fetch SNS signing certificate (HTTP ${resp.status})`);
  }
  const pem = await resp.text();
  if (!pem || !pem.includes('-----BEGIN CERTIFICATE-----')) {
    throw new Error('Invalid SNS signing certificate PEM');
  }

  if (snsCertCache.size >= CERT_CACHE_MAX) {
    const oldestKey = snsCertCache.keys().next().value;
    if (oldestKey) snsCertCache.delete(oldestKey);
  }
  snsCertCache.set(certUrl, { pem, expiresAt: now + CERT_CACHE_TTL_MS });
  return pem;
}

function verifySnsSignature(msg: SnsEnvelope, pem: string): boolean {
  const stringToSign = buildSnsStringToSign(msg);
  if (!stringToSign) return false;
  const algorithm = msg.SignatureVersion === '2' ? 'SHA256' : 'SHA1';
  try {
    const verifier = crypto.createVerify(algorithm);
    verifier.update(stringToSign, 'utf8');
    return verifier.verify(pem, String(msg.Signature || ''), 'base64');
  } catch {
    return false;
  }
}

function normalizeEmail(raw: unknown): string {
  return String(raw || '').trim().toLowerCase();
}

function extractMessageIdCandidates(sesEvent: Record<string, any>): string[] {
  const out = new Set<string>();
  const cleanId = (val: unknown): string =>
    String(val || '')
      .trim()
      .replace(/^<+|>+$/g, '')
      .trim();

  const direct = cleanId(sesEvent.mail?.messageId);
  if (direct) out.add(direct);

  const commonHeaderId = cleanId(sesEvent.mail?.commonHeaders?.messageId);
  if (commonHeaderId) out.add(commonHeaderId);

  if (Array.isArray(sesEvent.mail?.headers)) {
    for (const h of sesEvent.mail.headers) {
      if (String(h?.name || '').trim().toLowerCase() === 'message-id') {
        const hid = cleanId(h?.value);
        if (hid) out.add(hid);
      }
    }
  }
  return Array.from(out);
}

interface MatchedTarget {
  tenantId: string;
  claimId: string | null;
  campaignId: string | null;
  leadId: string | null;
  claimStatus: string | null;
  claimMetadata: Record<string, unknown>;
  leadEmail: string | null;
}

async function resolveMatchedTarget(
  client: DbClient,
  candidateIds: string[],
  recipientEmail: string,
  mailSource: string,
  allowOrphanLeadFallback: boolean
): Promise<MatchedTarget | null> {
  // Step A: Direct correlation via mkt_send_claims.metadata->>'message_id' or 'header_message_id'
  if (candidateIds.length > 0) {
    const placeholders = candidateIds.map((_, idx) => `$${idx + 1}`).join(', ');
    const claimRows = await client.query<{
      id: string;
      tenant_id: string;
      campaign_id: string;
      lead_id: string;
      status: string;
      metadata: unknown;
      lead_email: string | null;
    }>(
      `SELECT sc.id, sc.tenant_id, sc.campaign_id, sc.lead_id, sc.status, sc.metadata, l.email AS lead_email
       FROM mkt_send_claims sc
       LEFT JOIN leads l ON l.tenant_id = sc.tenant_id AND l.id = sc.lead_id
       WHERE sc.metadata->>'message_id' IN (${placeholders})
          OR sc.metadata->>'header_message_id' IN (${placeholders})
       LIMIT 10`,
      candidateIds
    );
    if (claimRows.rows.length > 0) {
      const exactRecipient =
        recipientEmail &&
        claimRows.rows.find((r) => normalizeEmail(r.lead_email) === recipientEmail);
      const picked = exactRecipient || claimRows.rows[0];
      return {
        tenantId: String(picked.tenant_id),
        claimId: String(picked.id),
        campaignId: String(picked.campaign_id),
        leadId: String(picked.lead_id),
        claimStatus: String(picked.status),
        claimMetadata: parseJsonCol<Record<string, unknown>>(picked.metadata, {}),
        leadEmail: picked.lead_email ? normalizeEmail(picked.lead_email) : null,
      };
    }

    // Step B: Flow or non-campaign email correlation via lead_timeline_events
    const tlRows = await client.query<{
      tenant_id: string;
      lead_id: string;
      lead_email: string | null;
    }>(
      `SELECT lte.tenant_id, lte.lead_id, l.email AS lead_email
       FROM lead_timeline_events lte
       LEFT JOIN leads l ON l.tenant_id = lte.tenant_id AND l.id = lte.lead_id
       WHERE lte.event_type = 'mkt_email_sent'
         AND (lte.metadata->>'message_id' IN (${placeholders})
              OR lte.metadata->>'header_message_id' IN (${placeholders}))
       ORDER BY lte.created_at DESC
       LIMIT 10`,
      candidateIds
    );
    if (tlRows.rows.length > 0) {
      const exactRecipient =
        recipientEmail &&
        tlRows.rows.find((r) => normalizeEmail(r.lead_email) === recipientEmail);
      const picked = exactRecipient || tlRows.rows[0];
      return {
        tenantId: String(picked.tenant_id),
        claimId: null,
        campaignId: null,
        leadId: String(picked.lead_id),
        claimStatus: null,
        claimMetadata: {},
        leadEmail: picked.lead_email ? normalizeEmail(picked.lead_email) : null,
      };
    }
  }

  if (!recipientEmail) return null;

  // Step C: Recent 30-day email claim fallback for recipient email
  const recentClaims = await client.query<{
    id: string;
    tenant_id: string;
    campaign_id: string;
    lead_id: string;
    status: string;
    metadata: unknown;
    lead_email: string | null;
    tenant_settings: unknown;
  }>(
    `SELECT sc.id, sc.tenant_id, sc.campaign_id, sc.lead_id, sc.status, sc.metadata, l.email AS lead_email, t.settings AS tenant_settings
     FROM mkt_send_claims sc
     INNER JOIN leads l ON l.tenant_id = sc.tenant_id AND l.id = sc.lead_id
     INNER JOIN tenants t ON t.id = sc.tenant_id
     WHERE LOWER(l.email) = $1
       AND sc.channel = 'email'
       AND sc.sent_at >= clock_timestamp() - INTERVAL '30 days'
     ORDER BY sc.sent_at DESC
     LIMIT 10`,
    [recipientEmail]
  );

  if (recentClaims.rows.length > 0) {
    const distinctTenants = new Set(recentClaims.rows.map((r) => String(r.tenant_id)));
    let candidates = recentClaims.rows;
    if (mailSource) {
      if (distinctTenants.size > 1) {
        const narrowed = recentClaims.rows.filter((r) => {
          const s = parseJsonCol<Record<string, unknown>>(r.tenant_settings, {});
          const senderCandidates = [s.ses_sender_email, s.from_email, s.support_email]
            .map((v) => normalizeEmail(v))
            .filter(Boolean);
          return senderCandidates.includes(mailSource);
        });
        if (narrowed.length > 0) candidates = narrowed;
      } else {
        candidates = recentClaims.rows.filter((r) => {
          const s = parseJsonCol<Record<string, unknown>>(r.tenant_settings, {});
          const senderCandidates = [s.ses_sender_email, s.from_email, s.support_email]
            .map((v) => normalizeEmail(v))
            .filter(Boolean);
          return senderCandidates.length === 0 || senderCandidates.includes(mailSource);
        });
      }
    }
    if (new Set(candidates.map((r) => String(r.tenant_id))).size === 1) {
      const picked = candidates[0];
      return {
        tenantId: String(picked.tenant_id),
        claimId: String(picked.id),
        campaignId: String(picked.campaign_id),
        leadId: String(picked.lead_id),
        claimStatus: String(picked.status),
        claimMetadata: parseJsonCol<Record<string, unknown>>(picked.metadata, {}),
        leadEmail: picked.lead_email ? normalizeEmail(picked.lead_email) : recipientEmail,
      };
    }
  }

  // Step D: Tenant-safe orphan lead fallback (Bounce / Complaint only)
  if (allowOrphanLeadFallback) {
    const leadRows = await client.query<{
      id: string;
      tenant_id: string;
      email: string | null;
      tenant_settings: unknown;
    }>(
      `SELECT l.id, l.tenant_id, l.email, t.settings AS tenant_settings
       FROM leads l
       INNER JOIN tenants t ON t.id = l.tenant_id
       WHERE LOWER(l.email) = $1
         AND l.is_deleted = false
       ORDER BY l.updated_at DESC
       LIMIT 10`,
      [recipientEmail]
    );
    if (leadRows.rows.length > 0) {
      let candidates = leadRows.rows;
      if (mailSource) {
        if (new Set(candidates.map((r) => String(r.tenant_id))).size > 1) {
          const narrowed = candidates.filter((r) => {
            const s = parseJsonCol<Record<string, unknown>>(r.tenant_settings, {});
            const senderCandidates = [s.ses_sender_email, s.from_email, s.support_email]
              .map((v) => normalizeEmail(v))
              .filter(Boolean);
            return senderCandidates.includes(mailSource);
          });
          if (narrowed.length > 0) candidates = narrowed;
        } else {
          candidates = candidates.filter((r) => {
            const s = parseJsonCol<Record<string, unknown>>(r.tenant_settings, {});
            const senderCandidates = [s.ses_sender_email, s.from_email, s.support_email]
              .map((v) => normalizeEmail(v))
              .filter(Boolean);
            return senderCandidates.length === 0 || senderCandidates.includes(mailSource);
          });
        }
      }
      if (new Set(candidates.map((r) => String(r.tenant_id))).size === 1) {
        const picked = candidates[0];
        return {
          tenantId: String(picked.tenant_id),
          claimId: null,
          campaignId: null,
          leadId: String(picked.id),
          claimStatus: null,
          claimMetadata: {},
          leadEmail: picked.email ? normalizeEmail(picked.email) : recipientEmail,
        };
      }
    }
  }

  return null;
}

async function insertTimelineEventIdempotent(
  client: DbClient,
  params: {
    tenantId: string;
    leadId: string;
    eventType: string;
    title: string;
    content: string;
    snsMessageId: string;
    metadata: Record<string, unknown>;
  }
): Promise<boolean> {
  const existing = await client.query<{ id: string }>(
    `SELECT id FROM lead_timeline_events
     WHERE tenant_id = $1
       AND lead_id = $2
       AND event_type = $3
       AND metadata->>'sns_message_id' = $4
     LIMIT 1`,
    [params.tenantId, params.leadId, params.eventType, params.snsMessageId]
  );
  if (existing.rows.length > 0) {
    return false;
  }

  await client.query(
    `INSERT INTO lead_timeline_events (
       id, tenant_id, lead_id, event_type, event_category, actor_role, actor_name, title, content, metadata
     ) VALUES ($1, $2, $3, $4, 'communication', 'system', 'AWS SES/SNS', $5, $6, $7::jsonb)`,
    [
      crypto.randomUUID(),
      params.tenantId,
      params.leadId,
      params.eventType,
      params.title,
      params.content,
      JSON.stringify({ ...params.metadata, sns_message_id: params.snsMessageId }),
    ]
  );
  return true;
}

async function recomputeCampaignBouncedCount(
  client: DbClient,
  tenantId: string,
  campaignId: string
): Promise<void> {
  const cntRes = await client.query<{ bounced_cnt: number }>(
    `SELECT COALESCE(SUM(CASE WHEN status = 'bounced' THEN 1 ELSE 0 END), 0) AS bounced_cnt
     FROM mkt_send_claims
     WHERE tenant_id = $1 AND campaign_id = $2`,
    [tenantId, campaignId]
  );
  const bouncedCnt = Number(cntRes.rows[0]?.bounced_cnt || 0);
  await client.query(
    `UPDATE mkt_campaigns
     SET bounced_count = $3, updated_at = clock_timestamp()
     WHERE tenant_id = $1 AND id = $2`,
    [tenantId, campaignId, bouncedCnt]
  );
}

export async function handleSesSnsWebhook(req: Request, res: Response): Promise<void> {
  let envelope: SnsEnvelope;
  try {
    let parsedBody: unknown = req.body;
    if (Buffer.isBuffer(parsedBody)) {
      parsedBody = JSON.parse(parsedBody.toString('utf8').trim());
    } else if (typeof parsedBody === 'string') {
      parsedBody = JSON.parse(parsedBody.trim());
    }
    if (!parsedBody || typeof parsedBody !== 'object' || Array.isArray(parsedBody)) {
      sendApiError(res, 400, 'INVALID_SNS_PAYLOAD', 'SNS payload must be a valid JSON object.');
      return;
    }
    envelope = parsedBody as SnsEnvelope;
  } catch {
    sendApiError(res, 400, 'INVALID_SNS_PAYLOAD', 'Malformed JSON in SNS webhook payload.');
    return;
  }

  const requiredStringFields: Array<keyof SnsEnvelope> = [
    'Type',
    'MessageId',
    'TopicArn',
    'Timestamp',
    'Signature',
    'SignatureVersion',
    'SigningCertURL',
  ];
  for (const field of requiredStringFields) {
    if (typeof envelope[field] !== 'string' || !String(envelope[field]).trim()) {
      sendApiError(res, 400, 'INVALID_SNS_ENVELOPE', `Missing required SNS field: ${field}`);
      return;
    }
  }
  if (typeof envelope.Message !== 'string') {
    sendApiError(res, 400, 'INVALID_SNS_ENVELOPE', 'Missing required SNS field: Message');
    return;
  }

  if (
    (envelope.Type === 'SubscriptionConfirmation' || envelope.Type === 'UnsubscribeConfirmation') &&
    (typeof envelope.SubscribeURL !== 'string' ||
      !envelope.SubscribeURL.trim() ||
      typeof envelope.Token !== 'string' ||
      !envelope.Token.trim())
  ) {
    sendApiError(res, 400, 'INVALID_SNS_ENVELOPE', 'Missing SubscribeURL or Token for SNS confirmation.');
    return;
  }

  if (!isValidAwsSnsUrl(envelope.SigningCertURL, true)) {
    sendApiError(res, 403, 'INVALID_SNS_CERT_URL', 'SigningCertURL is not a valid AWS SNS HTTPS certificate URL.');
    return;
  }

  if (envelope.SignatureVersion !== '1' && envelope.SignatureVersion !== '2') {
    sendApiError(res, 403, 'UNSUPPORTED_SNS_SIGNATURE_VERSION', 'Unsupported SNS SignatureVersion.');
    return;
  }

  let certPem: string;
  try {
    certPem = await fetchSnsCertificatePem(envelope.SigningCertURL);
  } catch (err: any) {
    sendApiError(res, 403, 'SNS_CERT_FETCH_FAILED', err?.message || 'Unable to fetch SNS signing certificate.');
    return;
  }

  if (!verifySnsSignature(envelope, certPem)) {
    sendApiError(res, 403, 'INVALID_SNS_SIGNATURE', 'SNS cryptographic signature verification failed.');
    return;
  }

  if (envelope.Type === 'SubscriptionConfirmation') {
    const subUrl = String(envelope.SubscribeURL || '').trim();
    if (!isValidAwsSnsUrl(subUrl, false)) {
      sendApiError(res, 403, 'INVALID_SNS_SUBSCRIBE_URL', 'SubscribeURL is not a valid AWS SNS HTTPS origin.');
      return;
    }
    if (!customSnsHttpFetcherForTesting && isOutboundSilentMode()) {
      res.json({
        success: true,
        data: { type: 'SubscriptionConfirmation', confirmed: false, skipped_silent: true },
      });
      return;
    }
    try {
      const fetcher: SnsHttpFetcherFn =
        customSnsHttpFetcherForTesting ||
        (async (u, init) => {
          const r = await fetch(u, init);
          return { ok: r.ok, status: r.status, text: () => r.text() };
        });
      const confirmResp = await fetcher(subUrl, {
        method: 'GET',
        redirect: 'error',
        signal: AbortSignal.timeout(5000),
      });
      res.json({
        success: true,
        data: {
          type: 'SubscriptionConfirmation',
          confirmed: confirmResp.ok,
          status: confirmResp.status,
        },
      });
      return;
    } catch (err: any) {
      sendApiError(res, 502, 'SNS_SUBSCRIBE_CONFIRM_FAILED', err?.message || 'Failed to confirm SNS subscription.');
      return;
    }
  }

  if (envelope.Type === 'UnsubscribeConfirmation') {
    res.json({
      success: true,
      data: { type: 'UnsubscribeConfirmation', acknowledged: true },
    });
    return;
  }

  if (envelope.Type !== 'Notification') {
    res.json({ success: true, data: { processed: false, type: envelope.Type } });
    return;
  }

  let sesEvent: Record<string, any>;
  try {
    sesEvent = JSON.parse(envelope.Message);
    if (!sesEvent || typeof sesEvent !== 'object') {
      throw new Error('Not an object');
    }
  } catch {
    sendApiError(res, 400, 'INVALID_SES_EVENT', 'SNS Notification Message is not valid JSON.');
    return;
  }

  const eventType = String(sesEvent.notificationType || sesEvent.eventType || '').trim();
  if (!['Bounce', 'Complaint', 'Delivery'].includes(eventType)) {
    res.json({
      success: true,
      data: { processed: false, event_type: eventType || 'unknown' },
    });
    return;
  }

  if (eventType === 'Complaint') {
    const feedbackType = String(sesEvent.complaint?.complaintFeedbackType || '').trim().toLowerCase();
    if (feedbackType === 'not-spam') {
      res.json({
        success: true,
        data: { processed: false, event_type: 'Complaint', ignored: true, reason: 'not-spam' },
      });
      return;
    }
  }

  await ensureMarketingSchema();

  const candidateIds = extractMessageIdCandidates(sesEvent);
  const sesMessageId = String(sesEvent.mail?.messageId || '').trim();
  const mailSource = normalizeEmail(sesEvent.mail?.source);

  let recipientEmails: string[] = [];
  if (eventType === 'Bounce') {
    const bouncedList = Array.isArray(sesEvent.bounce?.bouncedRecipients)
      ? sesEvent.bounce.bouncedRecipients
      : [];
    recipientEmails = bouncedList
      .map((r: any) => normalizeEmail(r?.emailAddress))
      .filter(Boolean);
  } else if (eventType === 'Complaint') {
    const complainedList = Array.isArray(sesEvent.complaint?.complainedRecipients)
      ? sesEvent.complaint.complainedRecipients
      : [];
    recipientEmails = complainedList
      .map((r: any) => normalizeEmail(r?.emailAddress))
      .filter(Boolean);
  } else if (eventType === 'Delivery') {
    const deliveredList = Array.isArray(sesEvent.delivery?.recipients)
      ? sesEvent.delivery.recipients
      : [];
    recipientEmails = deliveredList.map((r: any) => normalizeEmail(r)).filter(Boolean);
  }

  if (recipientEmails.length === 0 && Array.isArray(sesEvent.mail?.destination)) {
    recipientEmails = sesEvent.mail.destination
      .map((r: any) => normalizeEmail(r))
      .filter(Boolean);
  }

  const targetsToProcess = recipientEmails.length > 0 ? recipientEmails : [''];
  let matchedCount = 0;

  for (const recipientEmail of targetsToProcess) {
    const target = await withSystemPrivilege((client) =>
      resolveMatchedTarget(
        client,
        candidateIds,
        recipientEmail,
        mailSource,
        eventType === 'Bounce' || eventType === 'Complaint'
      )
    );
    if (!target) continue;
    matchedCount++;

    await withTenantTransaction(target.tenantId, async (client) => {
      const effectiveEmail = normalizeSuppressionRecipient(
        'email',
        recipientEmail || target.leadEmail || ''
      );

      if (eventType === 'Bounce') {
        const bounceType = String(sesEvent.bounce?.bounceType || 'Permanent').trim();
        const bounceSubType = String(sesEvent.bounce?.bounceSubType || '').trim();
        const bouncedRecipients = Array.isArray(sesEvent.bounce?.bouncedRecipients)
          ? sesEvent.bounce.bouncedRecipients
          : [];
        const matchedRecipient = recipientEmail
          ? bouncedRecipients.find((r: any) => normalizeEmail(r?.emailAddress) === recipientEmail)
          : undefined;
        const diagnosticCode = String(
          matchedRecipient?.diagnosticCode ?? bouncedRecipients?.[0]?.diagnosticCode ?? ''
        ).trim();
        const isHardBounce = bounceType.toLowerCase() === 'permanent';
        const errDetail = ['SES Bounce', bounceType, bounceSubType, diagnosticCode]
          .filter(Boolean)
          .join(': ')
          .slice(0, 500);

        if (isHardBounce) {
          if (target.claimId) {
            const nextMeta = {
              ...target.claimMetadata,
              sns_bounce: {
                sns_message_id: envelope.MessageId,
                ses_message_id: sesMessageId,
                bounce_type: bounceType,
                bounce_sub_type: bounceSubType,
                diagnostic_code: diagnosticCode,
                timestamp: sesEvent.bounce?.timestamp || envelope.Timestamp,
              },
            };
            await client.query(
              `UPDATE mkt_send_claims
               SET status = 'bounced',
                   error_message = $3,
                   metadata = $4::jsonb
               WHERE tenant_id = $1 AND id = $2`,
              [target.tenantId, target.claimId, errDetail, JSON.stringify(nextMeta)]
            );
            if (target.campaignId) {
              await recomputeCampaignBouncedCount(client, target.tenantId, target.campaignId);
            }
          }

          if (target.leadId) {
            await client.query(
              `UPDATE leads
               SET email_consent = 'bounced', updated_at = clock_timestamp()
               WHERE tenant_id = $1 AND id = $2 AND email_consent != 'bounced'`,
              [target.tenantId, target.leadId]
            );
            await insertTimelineEventIdempotent(client, {
              tenantId: target.tenantId,
              leadId: target.leadId,
              eventType: 'email_bounced',
              title: 'Email bị trả lại vĩnh viễn (Hard Bounce)',
              content: errDetail,
              snsMessageId: envelope.MessageId,
              metadata: {
                ses_message_id: sesMessageId,
                bounce_type: bounceType,
                bounce_sub_type: bounceSubType,
                diagnostic_code: diagnosticCode,
                campaign_id: target.campaignId,
                claim_id: target.claimId,
              },
            });
          }

          if (effectiveEmail) {
            await client.query(
              `INSERT INTO mkt_suppression_list (id, tenant_id, channel, recipient, reason, source_campaign_id)
               VALUES ($1, $2, 'email', $3, 'hard_bounce', $4)
               ON CONFLICT (tenant_id, channel, recipient)
               DO UPDATE SET reason = 'hard_bounce',
                             source_campaign_id = COALESCE(EXCLUDED.source_campaign_id, mkt_suppression_list.source_campaign_id)`,
              [crypto.randomUUID(), target.tenantId, effectiveEmail, target.campaignId]
            );
          }
        } else {
          // Transient / Undetermined soft bounce: record metadata + timeline only
          if (target.claimId) {
            const prevCount = Number(target.claimMetadata.transient_bounce_count || 0);
            const alreadyRecorded =
              (target.claimMetadata.last_transient_bounce as Record<string, unknown> | undefined)
                ?.sns_message_id === envelope.MessageId;
            const nextMeta = {
              ...target.claimMetadata,
              transient_bounce_count: alreadyRecorded ? prevCount : prevCount + 1,
              last_transient_bounce: {
                sns_message_id: envelope.MessageId,
                ses_message_id: sesMessageId,
                bounce_type: bounceType,
                bounce_sub_type: bounceSubType,
                diagnostic_code: diagnosticCode,
                timestamp: sesEvent.bounce?.timestamp || envelope.Timestamp,
              },
            };
            await client.query(
              `UPDATE mkt_send_claims
               SET metadata = $3::jsonb,
                   error_message = CASE
                     WHEN status IN ('claimed', 'sent', 'delivered') THEN $4
                     ELSE error_message
                   END
               WHERE tenant_id = $1 AND id = $2`,
              [target.tenantId, target.claimId, JSON.stringify(nextMeta), errDetail]
            );
          }

          if (target.leadId) {
            await insertTimelineEventIdempotent(client, {
              tenantId: target.tenantId,
              leadId: target.leadId,
              eventType: 'email_soft_bounce',
              title: 'Email trả lại tạm thời (Soft Bounce)',
              content: errDetail,
              snsMessageId: envelope.MessageId,
              metadata: {
                ses_message_id: sesMessageId,
                bounce_type: bounceType,
                bounce_sub_type: bounceSubType,
                diagnostic_code: diagnosticCode,
                campaign_id: target.campaignId,
                claim_id: target.claimId,
              },
            });
          }
        }
      } else if (eventType === 'Complaint') {
        const feedbackType = String(sesEvent.complaint?.complaintFeedbackType || 'abuse').trim();
        const errDetail = `SES Complaint: ${feedbackType}`.slice(0, 500);

        if (target.claimId) {
          const nextMeta = {
            ...target.claimMetadata,
            sns_complaint: {
              sns_message_id: envelope.MessageId,
              ses_message_id: sesMessageId,
              feedback_type: feedbackType,
              timestamp: sesEvent.complaint?.timestamp || envelope.Timestamp,
            },
          };
          await client.query(
            `UPDATE mkt_send_claims
             SET status = 'complained',
                 error_message = $3,
                 metadata = $4::jsonb
             WHERE tenant_id = $1 AND id = $2`,
            [target.tenantId, target.claimId, errDetail, JSON.stringify(nextMeta)]
          );
        }

        if (target.leadId) {
          await client.query(
            `UPDATE leads
             SET email_consent = 'complained', updated_at = clock_timestamp()
             WHERE tenant_id = $1 AND id = $2 AND email_consent != 'complained'`,
            [target.tenantId, target.leadId]
          );
          await insertTimelineEventIdempotent(client, {
            tenantId: target.tenantId,
            leadId: target.leadId,
            eventType: 'email_complained',
            title: 'Khách hàng báo cáo Spam (Complaint)',
            content: errDetail,
            snsMessageId: envelope.MessageId,
            metadata: {
              ses_message_id: sesMessageId,
              feedback_type: feedbackType,
              campaign_id: target.campaignId,
              claim_id: target.claimId,
            },
          });
        }

        if (effectiveEmail) {
          await client.query(
            `INSERT INTO mkt_suppression_list (id, tenant_id, channel, recipient, reason, source_campaign_id)
             VALUES ($1, $2, 'email', $3, 'complained', $4)
             ON CONFLICT (tenant_id, channel, recipient)
             DO UPDATE SET reason = 'complained',
                           source_campaign_id = COALESCE(EXCLUDED.source_campaign_id, mkt_suppression_list.source_campaign_id)`,
            [crypto.randomUUID(), target.tenantId, effectiveEmail, target.campaignId]
          );
        }
      } else if (eventType === 'Delivery') {
        if (target.claimId) {
          const nextMeta = {
            ...target.claimMetadata,
            sns_delivery: {
              sns_message_id: envelope.MessageId,
              ses_message_id: sesMessageId,
              timestamp: sesEvent.delivery?.timestamp || envelope.Timestamp,
              smtp_response: sesEvent.delivery?.smtpResponse || null,
            },
          };
          await client.query(
            `UPDATE mkt_send_claims
             SET status = CASE WHEN status IN ('claimed', 'sent') THEN 'delivered' ELSE status END,
                 metadata = $3::jsonb
             WHERE tenant_id = $1 AND id = $2`,
            [target.tenantId, target.claimId, JSON.stringify(nextMeta)]
          );
        }

        if (target.leadId) {
          await insertTimelineEventIdempotent(client, {
            tenantId: target.tenantId,
            leadId: target.leadId,
            eventType: 'email_delivered',
            title: 'Email đã gửi tới hộp thư (Delivered)',
            content: String(sesEvent.delivery?.smtpResponse || '250 Ok'),
            snsMessageId: envelope.MessageId,
            metadata: {
              ses_message_id: sesMessageId,
              campaign_id: target.campaignId,
              claim_id: target.claimId,
            },
          });
        }
      }
    });
  }

  res.json({
    success: true,
    data: {
      processed: true,
      event_type: eventType,
      matched_count: matchedCount,
      sns_message_id: envelope.MessageId,
    },
  });
}
