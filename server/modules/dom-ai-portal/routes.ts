import crypto from 'node:crypto';
import { Router, type Request, type Response } from 'express';
import { APP_CONFIG } from '../../config.ts';
import { withSystemPrivilege, withTenantTransaction } from '../../core/database/transaction.ts';
import { getTenantContext } from '../../core/context/tenant-context.ts';
import {
  requireTenantAuth,
  resolveUserEffectivePermissions,
  sendApiError,
} from '../../core/security/rbac.ts';
import { isOutboundSilentMode } from '../../core/security/outbound-guard.ts';
import { createSlidingWindowRateLimiter, extractClientIp } from '../../middleware/rate-limit.ts';
import {
  DEFAULT_PORTAL_MODEL,
  DEFAULT_PORTAL_PRIMARY_COLOR,
  DEFAULT_PORTAL_SYSTEM_INSTRUCTION,
  DEFAULT_PORTAL_WELCOME,
  parseJsonArray,
  parseJsonObject,
  runDomAiPortalSchema,
  slugifyDomAi,
  type DomAiAuthMode,
  type DomAiDocStatus,
  type DomAiDocType,
} from './schema.ts';
import {
  buildDeterministicRagReply,
  indexDomAiDocumentInTx,
  normalizeVietnameseFolded,
  recomputeCollectionDocCountsInTx,
  reindexPortalDocumentsInTx,
  resolvePortalGeminiByokInTx,
  runDomAiPortalChatInTx,
  savePortalGeminiByokInTx,
  searchDomAiKnowledgeInTx,
  testPortalGeminiKey,
  type DomAiCitation,
  type PortalChatViewerContext,
  type PortalRecord,
} from './rag.service.ts';

export const domAiPortalRouter = Router();
export const publicDomAiPortalRouter = Router();

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const VALID_AUTH_MODES = new Set<DomAiAuthMode>(['public_bypass', 'open_login', 'viewer_whitelist']);
const VALID_DOC_TYPES = new Set<DomAiDocType>(['document', 'qa', 'url', 'media']);
const VALID_DOC_STATUSES = new Set<DomAiDocStatus>(['active', 'draft', 'archived']);

const DEFAULT_STARTER_PROMPTS = [
  'Tóm tắt những điểm nổi bật nhất trong bộ tài liệu hiện có',
  'Chính sách và quy định quan trọng cần lưu ý là gì?',
  'Hướng dẫn quy trình triển khai từng bước cho thành viên mới',
];

function isUuid(val: unknown): boolean {
  return typeof val === 'string' && UUID_REGEX.test(val.trim());
}

function cleanStr(val: unknown, maxLen = 500): string {
  if (val === undefined || val === null) return '';
  return String(val).trim().slice(0, maxLen);
}

/** Reject dangerous XSS protocols (javascript:, vbscript:, data:) on portal/document URLs. */
function sanitizeSafePortalUrl(val: unknown, maxLen = 1200): string {
  const s = cleanStr(val, maxLen);
  if (!s) return '';
  if (s.startsWith('/') && !s.startsWith('//')) return s;
  try {
    const parsed = new URL(s);
    if (parsed.protocol === 'https:' || parsed.protocol === 'http:') {
      return s;
    }
  } catch {
    // invalid URL
  }
  return '';
}

const portalAuthRateLimiter = createSlidingWindowRateLimiter({
  name: 'dom_ai_auth',
  windowMs: 60_000,
  maxRequests: 20,
  keyFn: (req) => `${extractClientIp(req)}:${String(req.params.slug || '').toLowerCase()}`,
  message: 'Quá nhiều yêu cầu xác thực cổng AI. Vui lòng thử lại sau 1 phút.',
});

const portalChatRateLimiter = createSlidingWindowRateLimiter({
  name: 'dom_ai_chat',
  windowMs: 60_000,
  maxRequests: 30,
  keyFn: (req) => `${extractClientIp(req)}:${String(req.params.slug || '').toLowerCase()}`,
  message: 'Bạn đang gửi câu hỏi AI quá nhanh. Vui lòng chờ vài giây rồi thử lại.',
});

function clampInt(val: unknown, min: number, max: number, fallback: number): number {
  const n = Number(val);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(n)));
}

function timingSafeEqualStr(a: string, b: string): boolean {
  const bufA = Buffer.from(a, 'utf8');
  const bufB = Buffer.from(b, 'utf8');
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

// ============================================================================
// Portal Viewer Signed JWT (strictly segregated scope: `dom_ai_portal_viewer`)
// ============================================================================
export interface DomAiPortalViewerClaims {
  sub: string;
  tenantId: string;
  portalId: string;
  portalSlug: string;
  email: string;
  fullName: string;
  role: 'admin' | 'viewer' | 'guest';
  department: string;
  isGuest: boolean;
  allowedCollectionIds: string[];
  scope: 'dom_ai_portal_viewer';
  iat: number;
  exp: number;
  jti: string;
}

function base64UrlEncode(input: Buffer | string): string {
  const buf = typeof input === 'string' ? Buffer.from(input, 'utf8') : input;
  return buf.toString('base64').replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
}

function base64UrlDecode(input: string): Buffer {
  let padded = input.replace(/-/g, '+').replace(/_/g, '/');
  while (padded.length % 4 !== 0) padded += '=';
  return Buffer.from(padded, 'base64');
}

export function signPortalViewerToken(
  input: Omit<DomAiPortalViewerClaims, 'scope' | 'iat' | 'exp' | 'jti'>,
  expiresInSeconds = 604_800
): string {
  const now = Math.floor(Date.now() / 1000);
  const claims: DomAiPortalViewerClaims = {
    ...input,
    scope: 'dom_ai_portal_viewer',
    iat: now,
    exp: now + expiresInSeconds,
    jti: crypto.randomUUID(),
  };
  const header = base64UrlEncode(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const payload = base64UrlEncode(JSON.stringify(claims));
  const data = `${header}.${payload}`;
  const sig = crypto.createHmac('sha256', APP_CONFIG.jwtSecret).update(data).digest();
  return `${data}.${base64UrlEncode(sig)}`;
}

export function verifyPortalViewerToken(token: string): DomAiPortalViewerClaims {
  const parts = token.split('.');
  if (parts.length !== 3) throw new Error('JWT_MALFORMED');
  const [encodedHeader, encodedPayload, encodedSig] = parts;
  const header = JSON.parse(base64UrlDecode(encodedHeader).toString('utf8')) as { alg?: string };
  if (header.alg !== 'HS256') throw new Error('JWT_UNSUPPORTED_ALG');

  const data = `${encodedHeader}.${encodedPayload}`;
  const expectedSig = crypto.createHmac('sha256', APP_CONFIG.jwtSecret).update(data).digest();
  const actualSig = base64UrlDecode(encodedSig);
  if (expectedSig.length !== actualSig.length || !crypto.timingSafeEqual(expectedSig, actualSig)) {
    throw new Error('JWT_INVALID_SIGNATURE');
  }

  const claims = JSON.parse(
    base64UrlDecode(encodedPayload).toString('utf8')
  ) as DomAiPortalViewerClaims;
  const now = Math.floor(Date.now() / 1000);
  if (typeof claims.exp === 'number' && claims.exp <= now) {
    throw new Error('JWT_EXPIRED');
  }
  if (claims.scope !== 'dom_ai_portal_viewer' || !claims.portalId || !claims.tenantId) {
    throw new Error('JWT_INVALID_PORTAL_SCOPE');
  }
  return claims;
}

function extractBearerToken(req: Request): string | null {
  const authHeader = String(req.headers.authorization || '').trim();
  if (authHeader.toLowerCase().startsWith('bearer ')) {
    const t = authHeader.slice(7).trim();
    if (t) return t;
  }
  const alt = String(req.headers['x-portal-token'] || req.headers['x-auth-token'] || '').trim();
  return alt || null;
}

function sanitizeMetadataPublic(rawMeta: unknown): Record<string, unknown> {
  const meta = { ...parseJsonObject<Record<string, unknown>>(rawMeta) };
  delete meta.byok_vault;
  delete meta.api_key;
  delete meta.gemini_api_key;
  return meta;
}

function formatPortalForAdmin(
  row: Record<string, unknown>,
  extras?: {
    has_api_key?: boolean;
    api_key_hint?: string | null;
    api_key_source?: string;
    collection_count?: number;
    document_count?: number;
    chunk_count?: number;
    user_count?: number;
    conversation_count?: number;
    message_count?: number;
  }
): Record<string, unknown> {
  return {
    id: String(row.id),
    tenant_id: String(row.tenant_id),
    slug: String(row.slug),
    public_path: `/ai/${String(row.slug)}`,
    name: String(row.name),
    tagline: String(row.tagline || ''),
    logo_url: String(row.logo_url || ''),
    primary_color: String(row.primary_color || DEFAULT_PORTAL_PRIMARY_COLOR),
    welcome_message: String(row.welcome_message || ''),
    system_instruction: String(row.system_instruction || ''),
    starter_prompts: parseJsonArray<string>(row.starter_prompts_json),
    auth_mode: String(row.auth_mode || 'open_login'),
    allow_guest_history: Boolean(row.allow_guest_history ?? true),
    model: String(row.model || DEFAULT_PORTAL_MODEL),
    temperature: Number(row.temperature ?? 0.25),
    top_k: Number(row.top_k ?? 6),
    is_active: Boolean(row.is_active ?? true),
    is_free_byok: Boolean(row.is_free_byok ?? true),
    metadata: sanitizeMetadataPublic(row.metadata_json),
    created_at: row.created_at,
    updated_at: row.updated_at,
    ...(extras || {}),
  };
}

function formatDocumentRow(row: Record<string, unknown>): Record<string, unknown> {
  return {
    id: String(row.id),
    tenant_id: String(row.tenant_id),
    portal_id: String(row.portal_id),
    collection_id: row.collection_id ? String(row.collection_id) : null,
    collection_name: row.collection_name ? String(row.collection_name) : null,
    title: String(row.title),
    doc_type: String(row.doc_type || 'document'),
    content: String(row.content || ''),
    summary: String(row.summary || ''),
    tags: parseJsonArray<string>(row.tags_json),
    attachment_url: String(row.attachment_url || ''),
    thumbnail_url: String(row.thumbnail_url || ''),
    relevance_boost: Number(row.relevance_boost ?? 1),
    chunk_count: Number(row.chunk_count ?? 0),
    status: String(row.status || 'active'),
    created_by: row.created_by ? String(row.created_by) : null,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

function formatPortalUserRow(row: Record<string, unknown>): Record<string, unknown> {
  return {
    id: String(row.id),
    tenant_id: String(row.tenant_id),
    portal_id: String(row.portal_id),
    email: String(row.email),
    full_name: String(row.full_name || ''),
    role: String(row.role || 'viewer'),
    department: String(row.department || ''),
    allowed_collection_ids: parseJsonArray<string>(row.allowed_collection_ids_json),
    has_access_code: Boolean(row.access_code && String(row.access_code).trim().length > 0),
    access_code: row.access_code ? String(row.access_code) : null,
    status: String(row.status || 'active'),
    last_active_at: row.last_active_at || null,
    message_count: Number(row.message_count ?? 0),
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

async function resolvePublicPortalLookupBySlug(
  rawSlug: string
): Promise<{ id: string; tenant_id: string; slug: string } | null> {
  const cleanSlug = String(rawSlug || '').trim().toLowerCase();
  if (!cleanSlug) return null;
  return withSystemPrivilege(async (client) => {
    const res = await client.query<{ id: string; tenant_id: string; slug: string }>(
      `SELECT p.id, p.tenant_id, p.slug
       FROM dom_ai_portals p
       INNER JOIN tenants t ON t.id = p.tenant_id
       WHERE LOWER(p.slug) = $1
         AND p.is_active = true
         AND t.status != 'deleted'
       LIMIT 1`,
      [cleanSlug]
    );
    return res.rows[0] || null;
  });
}

async function decodeGoogleCredentialIfPresent(body: Record<string, unknown>): Promise<{
  email: string;
  fullName: string;
  usedGoogle: boolean;
} | null> {
  const tokenInput = String(body.credential || body.id_token || '').trim();
  if (!tokenInput) return null;

  const parts = tokenInput.split('.');
  if (parts.length !== 3) {
    throw new Error('INVALID_GOOGLE_TOKEN');
  }

  if (!isOutboundSilentMode() && process.env.ALLOW_TEST_GOOGLE_LOGIN !== 'true') {
    const resp = await fetch(
      `https://oauth2.googleapis.com/tokeninfo?id_token=${encodeURIComponent(tokenInput)}`,
      { signal: AbortSignal.timeout(8000) }
    );
    if (!resp.ok) {
      throw new Error('INVALID_GOOGLE_TOKEN');
    }
    const info = (await resp.json()) as Record<string, unknown>;
    const expectedClientId = (process.env.GOOGLE_CLIENT_ID || process.env.VITE_GOOGLE_CLIENT_ID || '').trim();
    if (expectedClientId && info.aud && String(info.aud) !== expectedClientId) {
      throw new Error('GOOGLE_CLIENT_MISMATCH');
    }
    const email = String(info.email || '').trim().toLowerCase();
    const fullName = String(info.name || email.split('@')[0] || 'Viewer').trim();
    return { email, fullName, usedGoogle: true };
  }

  try {
    const decoded = JSON.parse(base64UrlDecode(parts[1]).toString('utf8')) as Record<string, unknown>;
    const email = String(decoded.email || body.email || '').trim().toLowerCase();
    const fullName = String(
      decoded.name || body.full_name || body.name || email.split('@')[0] || 'Viewer'
    ).trim();
    return { email, fullName, usedGoogle: true };
  } catch {
    throw new Error('INVALID_GOOGLE_TOKEN');
  }
}

async function resolvePublicViewerInTx(
  req: Request,
  res: Response,
  portal: PortalRecord,
  options?: { allowAnonymousGuestOnBypass?: boolean }
): Promise<PortalChatViewerContext | null> {
  const token = extractBearerToken(req);

  if (!token) {
    if (options?.allowAnonymousGuestOnBypass && portal.auth_mode === 'public_bypass') {
      return {
        portalUserId: null,
        email: 'guest@public.local',
        fullName: 'Khách trải nghiệm',
        role: 'guest',
        isGuest: true,
        allowedCollectionIds: [],
      };
    }
    sendApiError(res, 401, 'PORTAL_AUTH_REQUIRED', 'Vui lòng xác thực để truy cập cổng tri thức AI.');
    return null;
  }

  let claims: DomAiPortalViewerClaims;
  try {
    claims = verifyPortalViewerToken(token);
  } catch (err: unknown) {
    const code = err instanceof Error ? err.message : 'JWT_INVALID';
    sendApiError(res, 401, code, 'Phiên truy cập cổng AI không hợp lệ hoặc đã hết hạn.');
    return null;
  }

  if (claims.portalId !== portal.id || claims.tenantId !== portal.tenant_id) {
    sendApiError(res, 403, 'PORTAL_TOKEN_MISMATCH', 'Token truy cập không thuộc cổng AI này.');
    return null;
  }

  if (portal.auth_mode === 'viewer_whitelist' && claims.isGuest) {
    sendApiError(
      res,
      403,
      'VIEWER_NOT_AUTHORIZED',
      'Cổng AI này yêu cầu tài khoản nằm trong danh sách được cấp quyền (Viewer Whitelist).'
    );
    return null;
  }

  if (!claims.isGuest) {
    const uRes = await withTenantTransaction(portal.tenant_id, (client) =>
      client.query<{
        id: string;
        email: string;
        full_name: string;
        role: string;
        allowed_collection_ids_json: unknown;
        status: string;
      }>(
        `SELECT id, email, full_name, role, allowed_collection_ids_json, status
         FROM dom_ai_portal_users
         WHERE tenant_id = $1 AND portal_id = $2 AND LOWER(email) = LOWER($3)
         LIMIT 1`,
        [portal.tenant_id, portal.id, claims.email]
      )
    );
    const userRow = uRes.rows[0];
    if (!userRow || userRow.status !== 'active') {
      sendApiError(
        res,
        403,
        'VIEWER_NOT_AUTHORIZED',
        'Tài khoản của bạn đã bị thu hồi hoặc chưa được kích hoạt quyền truy cập.'
      );
      return null;
    }

    const allowedCols = parseJsonArray<string>(userRow.allowed_collection_ids_json)
      .map((x) => String(x || '').trim())
      .filter(Boolean);

    return {
      portalUserId: String(userRow.id),
      email: String(userRow.email).toLowerCase(),
      fullName: String(userRow.full_name || claims.fullName || userRow.email),
      role: userRow.role === 'admin' ? 'admin' : 'viewer',
      isGuest: false,
      allowedCollectionIds: allowedCols,
    };
  }

  return {
    portalUserId: null,
    email: claims.email,
    fullName: claims.fullName,
    role: 'guest',
    isGuest: true,
    allowedCollectionIds: [],
  };
}

// ============================================================================
// PART A: PUBLIC USER PORTAL ROUTES (`/api/v1/public/dom-ai/:slug/*`)
// ============================================================================
publicDomAiPortalRouter.use(async (_req, res, next) => {
  try {
    await runDomAiPortalSchema();
    next();
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : 'Không thể khởi tạo cấu trúc dữ liệu DOM AI Portal.';
    sendApiError(res, 500, 'DOM_AI_SCHEMA_INIT_FAILED', msg);
  }
});

// 1. GET /:slug/bootstrap — Public sanitized branding, auth_mode, starter prompts & public collections
publicDomAiPortalRouter.get('/:slug/bootstrap', async (req, res) => {
  try {
    const lookup = await resolvePublicPortalLookupBySlug(req.params.slug);
    if (!lookup) {
      sendApiError(res, 404, 'PORTAL_NOT_FOUND', 'Cổng Trợ lý AI không tồn tại hoặc đang tạm khóa.');
      return;
    }

    const data = await withTenantTransaction(lookup.tenant_id, async (client) => {
      const [portalRes, colsRes, docsCountRes, accessCodeRes] = await Promise.all([
        client.query<PortalRecord>(
          `SELECT * FROM dom_ai_portals WHERE tenant_id = $1 AND id = $2 LIMIT 1`,
          [lookup.tenant_id, lookup.id]
        ),
        client.query(
          `SELECT id, slug, name, description, icon, color, sort_order, is_public, doc_count
           FROM dom_ai_collections
           WHERE tenant_id = $1 AND portal_id = $2 AND is_public = true
           ORDER BY sort_order ASC, name ASC`,
          [lookup.tenant_id, lookup.id]
        ),
        client.query<{ cnt: string | number }>(
          `SELECT COUNT(*) AS cnt
           FROM dom_ai_documents d
           LEFT JOIN dom_ai_collections c ON c.tenant_id = d.tenant_id AND c.id = d.collection_id
           WHERE d.tenant_id = $1 AND d.portal_id = $2 AND d.status = 'active'
             AND (d.collection_id IS NULL OR c.is_public = true)`,
          [lookup.tenant_id, lookup.id]
        ),
        client.query<{ cnt: string | number }>(
          `SELECT COUNT(*) AS cnt
           FROM dom_ai_portal_users
           WHERE tenant_id = $1 AND portal_id = $2 AND status = 'active'
             AND access_code IS NOT NULL AND access_code != ''`,
          [lookup.tenant_id, lookup.id]
        ),
      ]);

      const portal = portalRes.rows[0];
      const byok = await resolvePortalGeminiByokInTx(client, lookup.tenant_id, portal.metadata_json);
      const safeMeta = sanitizeMetadataPublic(portal.metadata_json);
      const requiresAccessCode =
        portal.auth_mode === 'viewer_whitelist' &&
        (Boolean(safeMeta.require_access_code) || Number(accessCodeRes.rows[0]?.cnt || 0) > 0);

      return {
        portal: {
          id: String(portal.id),
          slug: String(portal.slug),
          name: String(portal.name),
          tagline: String(portal.tagline || ''),
          logo_url: String(portal.logo_url || ''),
          primary_color: String(portal.primary_color || DEFAULT_PORTAL_PRIMARY_COLOR),
          welcome_message: String(portal.welcome_message || DEFAULT_PORTAL_WELCOME),
          starter_prompts: parseJsonArray<string>(portal.starter_prompts_json),
          auth_mode: String(portal.auth_mode),
          allow_guest_history: Boolean(portal.allow_guest_history),
          model: String(portal.model || DEFAULT_PORTAL_MODEL),
          is_free_byok: Boolean(portal.is_free_byok ?? true),
          has_api_key: Boolean(byok.apiKey),
          requires_access_code: requiresAccessCode,
        },
        collections: colsRes.rows.map((c) => ({
          id: String(c.id),
          slug: String(c.slug),
          name: String(c.name),
          description: String(c.description || ''),
          icon: String(c.icon || 'BookOpen'),
          color: String(c.color || portal.primary_color || DEFAULT_PORTAL_PRIMARY_COLOR),
          sort_order: Number(c.sort_order ?? 0),
          is_public: Boolean(c.is_public),
          doc_count: Number(c.doc_count ?? 0),
        })),
        stats: {
          total_collections: colsRes.rows.length,
          total_documents: Number(docsCountRes.rows[0]?.cnt || 0),
        },
      };
    });

    res.json({ success: true, data });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : 'Không thể tải cấu hình cổng AI.';
    sendApiError(res, 500, 'PORTAL_BOOTSTRAP_FAILED', msg);
  }
});

// 2. POST /:slug/auth/enter — Enforces public_bypass | open_login | viewer_whitelist
publicDomAiPortalRouter.post('/:slug/auth/enter', portalAuthRateLimiter, async (req, res) => {
  try {
    const lookup = await resolvePublicPortalLookupBySlug(req.params.slug);
    if (!lookup) {
      sendApiError(res, 404, 'PORTAL_NOT_FOUND', 'Cổng Trợ lý AI không tồn tại hoặc đang tạm khóa.');
      return;
    }

    const body = (req.body && typeof req.body === 'object' ? req.body : {}) as Record<string, unknown>;
    let googleInfo: { email: string; fullName: string; usedGoogle: boolean } | null = null;
    try {
      googleInfo = await decodeGoogleCredentialIfPresent(body);
    } catch (err: unknown) {
      const code = err instanceof Error ? err.message : 'INVALID_GOOGLE_TOKEN';
      sendApiError(res, 401, code, 'Xác thực Google ID Token không hợp lệ.');
      return;
    }

    const rawEmail = String(googleInfo?.email || body.email || '').trim().toLowerCase();
    const rawName = cleanStr(googleInfo?.fullName || body.full_name || body.name, 180);
    const providedAccessCode = cleanStr(body.access_code, 100);

    const outcome = await withTenantTransaction(lookup.tenant_id, async (client) => {
      const portalRes = await client.query<PortalRecord>(
        `SELECT * FROM dom_ai_portals WHERE tenant_id = $1 AND id = $2 LIMIT 1`,
        [lookup.tenant_id, lookup.id]
      );
      const portal = portalRes.rows[0];
      const authMode = String(portal.auth_mode) as DomAiAuthMode;

      // Mode 1: public_bypass — immediate guest or optional named entry
      if (authMode === 'public_bypass') {
        if (rawEmail && EMAIL_REGEX.test(rawEmail)) {
          const existing = await client.query(
            `SELECT * FROM dom_ai_portal_users
             WHERE tenant_id = $1 AND portal_id = $2 AND LOWER(email) = LOWER($3)
             LIMIT 1`,
            [lookup.tenant_id, portal.id, rawEmail]
          );
          if (existing.rows[0]) {
            const u = existing.rows[0];
            if (u.status !== 'active') {
              return { error: { status: 403, code: 'VIEWER_NOT_AUTHORIZED', message: 'Tài khoản này đang bị tạm khóa.' } };
            }
            await client.query(
              `UPDATE dom_ai_portal_users SET last_active_at = clock_timestamp(), updated_at = clock_timestamp()
               WHERE tenant_id = $1 AND id = $2`,
              [lookup.tenant_id, u.id]
            );
            const allowedCols = parseJsonArray<string>(u.allowed_collection_ids_json);
            const token = signPortalViewerToken({
              sub: String(u.id),
              tenantId: lookup.tenant_id,
              portalId: portal.id,
              portalSlug: portal.slug,
              email: String(u.email).toLowerCase(),
              fullName: String(u.full_name || rawName || u.email),
              role: u.role === 'admin' ? 'admin' : 'viewer',
              department: String(u.department || ''),
              isGuest: false,
              allowedCollectionIds: allowedCols,
            });
            return {
              token,
              viewer: {
                id: String(u.id),
                email: String(u.email).toLowerCase(),
                full_name: String(u.full_name || rawName || u.email),
                role: u.role === 'admin' ? 'admin' : 'viewer',
                department: String(u.department || ''),
                is_guest: false,
                allowed_collection_ids: allowedCols,
              },
              portal: { id: portal.id, slug: portal.slug, name: portal.name, auth_mode: authMode },
            };
          }
        }

        const guestId = `guest:${crypto.randomUUID()}`;
        const guestEmail =
          rawEmail && EMAIL_REGEX.test(rawEmail)
            ? rawEmail
            : `guest-${guestId.slice(6, 14)}@guest.local`;
        const guestName = rawName || 'Khách trải nghiệm';
        const token = signPortalViewerToken({
          sub: guestId,
          tenantId: lookup.tenant_id,
          portalId: portal.id,
          portalSlug: portal.slug,
          email: guestEmail,
          fullName: guestName,
          role: 'guest',
          department: '',
          isGuest: true,
          allowedCollectionIds: [],
        });
        return {
          token,
          viewer: {
            id: guestId,
            email: guestEmail,
            full_name: guestName,
            role: 'guest',
            department: '',
            is_guest: true,
            allowed_collection_ids: [],
          },
          portal: { id: portal.id, slug: portal.slug, name: portal.name, auth_mode: authMode },
        };
      }

      // Modes 2 & 3 both require a valid email
      if (!rawEmail || !EMAIL_REGEX.test(rawEmail)) {
        return {
          error: {
            status: 422,
            code: 'INVALID_EMAIL',
            message: 'Vui lòng nhập địa chỉ email hợp lệ để tiếp tục.',
          },
        };
      }

      const existingRes = await client.query(
        `SELECT * FROM dom_ai_portal_users
         WHERE tenant_id = $1 AND portal_id = $2 AND LOWER(email) = LOWER($3)
         LIMIT 1`,
        [lookup.tenant_id, portal.id, rawEmail]
      );
      let userRow = existingRes.rows[0];

      // Mode 2: open_login — auto-registers new viewer
      if (authMode === 'open_login') {
        if (userRow && userRow.status !== 'active') {
          return {
            error: {
              status: 403,
              code: 'VIEWER_SUSPENDED',
              message: 'Tài khoản này đang bị tạm khóa trên cổng AI.',
            },
          };
        }

        if (!userRow) {
          const newUserId = crypto.randomUUID();
          const finalName = rawName || rawEmail.split('@')[0];
          await client.query(
            `INSERT INTO dom_ai_portal_users (
               id, tenant_id, portal_id, email, full_name, role, department,
               allowed_collection_ids_json, status, last_active_at, message_count
             ) VALUES ($1, $2, $3, $4, $5, 'viewer', '', '[]'::jsonb, 'active', clock_timestamp(), 0)`,
            [newUserId, lookup.tenant_id, portal.id, rawEmail, finalName]
          );
          const createdRes = await client.query(
            `SELECT * FROM dom_ai_portal_users WHERE tenant_id = $1 AND id = $2 LIMIT 1`,
            [lookup.tenant_id, newUserId]
          );
          userRow = createdRes.rows[0];
        } else {
          const nextName = String(userRow.full_name || '').trim() || rawName || rawEmail.split('@')[0];
          await client.query(
            `UPDATE dom_ai_portal_users
             SET full_name = $3, last_active_at = clock_timestamp(), updated_at = clock_timestamp()
             WHERE tenant_id = $1 AND id = $2`,
            [lookup.tenant_id, userRow.id, nextName]
          );
          userRow = { ...userRow, full_name: nextName };
        }
      } else {
        // Mode 3: viewer_whitelist — strict email whitelist (+ optional access_code)
        if (!userRow || userRow.status !== 'active') {
          return {
            error: {
              status: 403,
              code: 'VIEWER_NOT_AUTHORIZED',
              message:
                'Email của bạn chưa được cấp quyền truy cập cổng AI này. Vui lòng liên hệ quản trị viên để được thêm vào danh sách Viewer.',
            },
          };
        }

        const expectedCode = String(userRow.access_code || '').trim();
        if (expectedCode && !timingSafeEqualStr(providedAccessCode, expectedCode)) {
          return {
            error: {
              status: 403,
              code: 'INVALID_ACCESS_CODE',
              message: 'Mã truy cập (Access Code) không chính xác.',
            },
          };
        }

        const nextName = String(userRow.full_name || '').trim() || rawName || rawEmail.split('@')[0];
        await client.query(
          `UPDATE dom_ai_portal_users
           SET full_name = $3, last_active_at = clock_timestamp(), updated_at = clock_timestamp()
           WHERE tenant_id = $1 AND id = $2`,
          [lookup.tenant_id, userRow.id, nextName]
        );
        userRow = { ...userRow, full_name: nextName };
      }

      const allowedCols = parseJsonArray<string>(userRow.allowed_collection_ids_json)
        .map((x) => String(x || '').trim())
        .filter(Boolean);
      const token = signPortalViewerToken({
        sub: String(userRow.id),
        tenantId: lookup.tenant_id,
        portalId: portal.id,
        portalSlug: portal.slug,
        email: String(userRow.email).toLowerCase(),
        fullName: String(userRow.full_name || userRow.email),
        role: userRow.role === 'admin' ? 'admin' : 'viewer',
        department: String(userRow.department || ''),
        isGuest: false,
        allowedCollectionIds: allowedCols,
      });

      return {
        token,
        viewer: {
          id: String(userRow.id),
          email: String(userRow.email).toLowerCase(),
          full_name: String(userRow.full_name || userRow.email),
          role: userRow.role === 'admin' ? 'admin' : 'viewer',
          department: String(userRow.department || ''),
          is_guest: false,
          allowed_collection_ids: allowedCols,
        },
        portal: { id: portal.id, slug: portal.slug, name: portal.name, auth_mode: authMode },
      };
    });

    if ('error' in outcome && outcome.error) {
      sendApiError(res, outcome.error.status, outcome.error.code, outcome.error.message);
      return;
    }

    res.json({ success: true, data: outcome });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : 'Không thể xác thực truy cập cổng AI.';
    sendApiError(res, 500, 'PORTAL_AUTH_ENTER_FAILED', msg);
  }
});

// Helper to load portal + viewer for authenticated public routes
async function loadPublicPortalAndViewer(
  req: Request,
  res: Response,
  options?: { allowAnonymousGuestOnBypass?: boolean }
): Promise<{ portal: PortalRecord; viewer: PortalChatViewerContext } | null> {
  const lookup = await resolvePublicPortalLookupBySlug(req.params.slug);
  if (!lookup) {
    sendApiError(res, 404, 'PORTAL_NOT_FOUND', 'Cổng Trợ lý AI không tồn tại hoặc đang tạm khóa.');
    return null;
  }

  const portal = await withTenantTransaction(lookup.tenant_id, async (client) => {
    const pRes = await client.query<PortalRecord>(
      `SELECT * FROM dom_ai_portals WHERE tenant_id = $1 AND id = $2 LIMIT 1`,
      [lookup.tenant_id, lookup.id]
    );
    return pRes.rows[0] || null;
  });

  if (!portal) {
    sendApiError(res, 404, 'PORTAL_NOT_FOUND', 'Cổng Trợ lý AI không tồn tại.');
    return null;
  }

  const viewer = await resolvePublicViewerInTx(req, res, portal, options);
  if (!viewer) return null;

  return { portal, viewer };
}

// 3. GET /:slug/me — Current viewer session profile
publicDomAiPortalRouter.get('/:slug/me', async (req, res) => {
  try {
    const loaded = await loadPublicPortalAndViewer(req, res);
    if (!loaded) return;
    res.json({
      success: true,
      data: {
        viewer: {
          id: loaded.viewer.portalUserId || loaded.viewer.email,
          email: loaded.viewer.email,
          full_name: loaded.viewer.fullName,
          role: loaded.viewer.role,
          is_guest: loaded.viewer.isGuest,
          allowed_collection_ids: loaded.viewer.allowedCollectionIds,
        },
        portal: {
          id: loaded.portal.id,
          slug: loaded.portal.slug,
          name: loaded.portal.name,
          auth_mode: loaded.portal.auth_mode,
        },
      },
    });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : 'Không thể xác thực phiên làm việc.';
    sendApiError(res, 500, 'PORTAL_ME_FAILED', msg);
  }
});

// 4. GET /:slug/collections — Collections strictly scoped to viewer's allowed_collection_ids
publicDomAiPortalRouter.get('/:slug/collections', async (req, res) => {
  try {
    const loaded = await loadPublicPortalAndViewer(req, res, { allowAnonymousGuestOnBypass: true });
    if (!loaded) return;
    const { portal, viewer } = loaded;

    const collections = await withTenantTransaction(portal.tenant_id, async (client) => {
      const colRes = await client.query(
        `SELECT id, slug, name, description, icon, color, sort_order, is_public, doc_count
         FROM dom_ai_collections
         WHERE tenant_id = $1 AND portal_id = $2
         ORDER BY sort_order ASC, name ASC`,
        [portal.tenant_id, portal.id]
      );

      const allowedSet =
        viewer.allowedCollectionIds.length > 0 ? new Set(viewer.allowedCollectionIds) : null;

      return colRes.rows
        .filter((c) => {
          if (allowedSet) return allowedSet.has(String(c.id));
          if (viewer.role === 'admin') return true;
          return Boolean(c.is_public);
        })
        .map((c) => ({
          id: String(c.id),
          slug: String(c.slug),
          name: String(c.name),
          description: String(c.description || ''),
          icon: String(c.icon || 'BookOpen'),
          color: String(c.color || portal.primary_color || DEFAULT_PORTAL_PRIMARY_COLOR),
          sort_order: Number(c.sort_order ?? 0),
          is_public: Boolean(c.is_public),
          doc_count: Number(c.doc_count ?? 0),
        }));
    });

    res.json({ success: true, data: collections });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : 'Không thể tải danh sách bộ sưu tập.';
    sendApiError(res, 500, 'PORTAL_COLLECTIONS_FAILED', msg);
  }
});

// 5. GET /:slug/documents — Active documents strictly scoped to viewer's collection ACL
publicDomAiPortalRouter.get('/:slug/documents', async (req, res) => {
  try {
    const loaded = await loadPublicPortalAndViewer(req, res, { allowAnonymousGuestOnBypass: true });
    if (!loaded) return;
    const { portal, viewer } = loaded;

    const collectionId = cleanStr(req.query.collection_id, 64);
    const docType = cleanStr(req.query.doc_type, 24);
    const searchRaw = cleanStr(req.query.search || req.query.q, 200);
    const searchFolded = normalizeVietnameseFolded(searchRaw);
    const limit = clampInt(req.query.limit, 1, 100, 50);
    const offset = clampInt(req.query.offset, 0, 10_000, 0);

    const payload = await withTenantTransaction(portal.tenant_id, async (client) => {
      const docsRes = await client.query(
        `SELECT d.*, c.name AS collection_name, c.is_public AS collection_is_public
         FROM dom_ai_documents d
         LEFT JOIN dom_ai_collections c ON c.tenant_id = d.tenant_id AND c.id = d.collection_id
         WHERE d.tenant_id = $1 AND d.portal_id = $2 AND d.status = 'active'
         ORDER BY d.relevance_boost DESC, d.updated_at DESC`,
        [portal.tenant_id, portal.id]
      );

      const allowedSet =
        viewer.allowedCollectionIds.length > 0 ? new Set(viewer.allowedCollectionIds) : null;

      const filtered = docsRes.rows.filter((d) => {
        const colId = d.collection_id ? String(d.collection_id) : null;
        const isPublic =
          d.collection_is_public === null || d.collection_is_public === undefined
            ? true
            : Boolean(d.collection_is_public);

        if (allowedSet) {
          if (!colId || !allowedSet.has(colId)) return false;
        } else if (viewer.role !== 'admin') {
          if (colId && !isPublic) return false;
        }

        if (collectionId && colId !== collectionId) return false;
        if (docType && String(d.doc_type) !== docType) return false;

        if (searchFolded) {
          const tagsStr = parseJsonArray<string>(d.tags_json).join(' ');
          const haystack = normalizeVietnameseFolded(
            `${d.title || ''} ${d.summary || ''} ${tagsStr} ${d.content || ''}`
          );
          if (!haystack.includes(searchFolded)) return false;
        }
        return true;
      });

      const items = filtered.slice(offset, offset + limit).map(formatDocumentRow);
      return {
        items,
        total: filtered.length,
        limit,
        offset,
      };
    });

    res.json({ success: true, data: payload });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : 'Không thể tải danh sách tài liệu.';
    sendApiError(res, 500, 'PORTAL_DOCUMENTS_FAILED', msg);
  }
});

// 5b. GET /:slug/documents/:docId — Single document reader (strictly enforces collection ACL)
publicDomAiPortalRouter.get('/:slug/documents/:docId', async (req, res) => {
  try {
    if (!isUuid(req.params.docId)) {
      sendApiError(res, 400, 'INVALID_DOCUMENT_ID', 'ID tài liệu không hợp lệ.');
      return;
    }
    const loaded = await loadPublicPortalAndViewer(req, res, { allowAnonymousGuestOnBypass: true });
    if (!loaded) return;
    const { portal, viewer } = loaded;

    const doc = await withTenantTransaction(portal.tenant_id, async (client) => {
      const r = await client.query(
        `SELECT d.*, c.name AS collection_name, c.is_public AS collection_is_public
         FROM dom_ai_documents d
         LEFT JOIN dom_ai_collections c ON c.tenant_id = d.tenant_id AND c.id = d.collection_id
         WHERE d.tenant_id = $1 AND d.portal_id = $2 AND d.id = $3 AND d.status = 'active'
         LIMIT 1`,
        [portal.tenant_id, portal.id, req.params.docId]
      );
      const row = r.rows[0];
      if (!row) return null;

      const colId = row.collection_id ? String(row.collection_id) : null;
      const isPublic =
        row.collection_is_public === null || row.collection_is_public === undefined
          ? true
          : Boolean(row.collection_is_public);
      const allowedSet =
        viewer.allowedCollectionIds.length > 0 ? new Set(viewer.allowedCollectionIds) : null;

      if (allowedSet) {
        if (!colId || !allowedSet.has(colId)) return null;
      } else if (viewer.role !== 'admin' && colId && !isPublic) {
        return null;
      }
      return formatDocumentRow(row);
    });

    if (!doc) {
      sendApiError(res, 404, 'DOCUMENT_NOT_FOUND', 'Không tìm thấy tài liệu hoặc bạn không có quyền truy cập.');
      return;
    }
    res.json({ success: true, data: doc });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : 'Không thể tải chi tiết tài liệu.';
    sendApiError(res, 500, 'PORTAL_DOCUMENT_DETAIL_FAILED', msg);
  }
});

// 6. Custom Conversation Groups CRUD (`/:slug/groups`)
publicDomAiPortalRouter.get('/:slug/groups', async (req, res) => {
  try {
    const loaded = await loadPublicPortalAndViewer(req, res);
    if (!loaded) return;
    const { portal, viewer } = loaded;

    const groups = await withTenantTransaction(portal.tenant_id, async (client) => {
      const r = await client.query(
        `SELECT * FROM dom_ai_groups
         WHERE tenant_id = $1 AND portal_id = $2 AND LOWER(portal_user_email) = LOWER($3)
         ORDER BY sort_order ASC, created_at ASC`,
        [portal.tenant_id, portal.id, viewer.email]
      );
      return r.rows;
    });

    res.json({ success: true, data: groups });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : 'Không thể tải danh sách nhóm hội thoại.';
    sendApiError(res, 500, 'PORTAL_GROUPS_LIST_FAILED', msg);
  }
});

publicDomAiPortalRouter.post('/:slug/groups', async (req, res) => {
  try {
    const loaded = await loadPublicPortalAndViewer(req, res);
    if (!loaded) return;
    const { portal, viewer } = loaded;

    const body = (req.body && typeof req.body === 'object' ? req.body : {}) as Record<string, unknown>;
    const name = cleanStr(body.name, 150);
    if (!name) {
      sendApiError(res, 422, 'GROUP_NAME_REQUIRED', 'Vui lòng nhập tên nhóm hội thoại.');
      return;
    }
    const color = cleanStr(body.color, 32) || portal.primary_color || DEFAULT_PORTAL_PRIMARY_COLOR;
    const sortOrder = clampInt(body.sort_order, 0, 10_000, 0);

    const created = await withTenantTransaction(portal.tenant_id, async (client) => {
      const id = crypto.randomUUID();
      await client.query(
        `INSERT INTO dom_ai_groups (id, tenant_id, portal_id, portal_user_email, name, color, sort_order)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [id, portal.tenant_id, portal.id, viewer.email, name, color, sortOrder]
      );
      const r = await client.query(
        `SELECT * FROM dom_ai_groups WHERE tenant_id = $1 AND id = $2 LIMIT 1`,
        [portal.tenant_id, id]
      );
      return r.rows[0];
    });

    res.status(201).json({ success: true, data: created });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : 'Không thể tạo nhóm hội thoại.';
    sendApiError(res, 500, 'PORTAL_GROUP_CREATE_FAILED', msg);
  }
});

publicDomAiPortalRouter.patch('/:slug/groups/:groupId', async (req, res) => {
  try {
    if (!isUuid(req.params.groupId)) {
      sendApiError(res, 400, 'INVALID_GROUP_ID', 'ID nhóm hội thoại không hợp lệ.');
      return;
    }
    const loaded = await loadPublicPortalAndViewer(req, res);
    if (!loaded) return;
    const { portal, viewer } = loaded;

    const body = (req.body && typeof req.body === 'object' ? req.body : {}) as Record<string, unknown>;
    const name = body.name !== undefined ? cleanStr(body.name, 150) : null;
    const color = body.color !== undefined ? cleanStr(body.color, 32) : null;
    const sortOrder = body.sort_order !== undefined ? clampInt(body.sort_order, 0, 10_000, 0) : null;

    const updated = await withTenantTransaction(portal.tenant_id, async (client) => {
      const chk = await client.query(
        `SELECT id FROM dom_ai_groups
         WHERE tenant_id = $1 AND portal_id = $2 AND id = $3 AND LOWER(portal_user_email) = LOWER($4)
         LIMIT 1`,
        [portal.tenant_id, portal.id, req.params.groupId, viewer.email]
      );
      if (!chk.rows[0]) return null;

      await client.query(
        `UPDATE dom_ai_groups
         SET name = COALESCE($3, name),
             color = COALESCE($4, color),
             sort_order = COALESCE($5, sort_order)
         WHERE tenant_id = $1 AND id = $2`,
        [portal.tenant_id, req.params.groupId, name || null, color || null, sortOrder]
      );
      const r = await client.query(
        `SELECT * FROM dom_ai_groups WHERE tenant_id = $1 AND id = $2 LIMIT 1`,
        [portal.tenant_id, req.params.groupId]
      );
      return r.rows[0];
    });

    if (!updated) {
      sendApiError(res, 404, 'GROUP_NOT_FOUND', 'Không tìm thấy nhóm hội thoại.');
      return;
    }
    res.json({ success: true, data: updated });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : 'Không thể cập nhật nhóm hội thoại.';
    sendApiError(res, 500, 'PORTAL_GROUP_UPDATE_FAILED', msg);
  }
});

publicDomAiPortalRouter.delete('/:slug/groups/:groupId', async (req, res) => {
  try {
    if (!isUuid(req.params.groupId)) {
      sendApiError(res, 400, 'INVALID_GROUP_ID', 'ID nhóm hội thoại không hợp lệ.');
      return;
    }
    const loaded = await loadPublicPortalAndViewer(req, res);
    if (!loaded) return;
    const { portal, viewer } = loaded;

    const deleted = await withTenantTransaction(portal.tenant_id, async (client) => {
      const chk = await client.query(
        `SELECT id FROM dom_ai_groups
         WHERE tenant_id = $1 AND portal_id = $2 AND id = $3 AND LOWER(portal_user_email) = LOWER($4)
         LIMIT 1`,
        [portal.tenant_id, portal.id, req.params.groupId, viewer.email]
      );
      if (!chk.rows[0]) return false;

      await client.query(
        `UPDATE dom_ai_conversations SET group_id = NULL
         WHERE tenant_id = $1 AND portal_id = $2 AND group_id = $3`,
        [portal.tenant_id, portal.id, req.params.groupId]
      );
      await client.query(`DELETE FROM dom_ai_groups WHERE tenant_id = $1 AND id = $2`, [
        portal.tenant_id,
        req.params.groupId,
      ]);
      return true;
    });

    if (!deleted) {
      sendApiError(res, 404, 'GROUP_NOT_FOUND', 'Không tìm thấy nhóm hội thoại.');
      return;
    }
    res.json({ success: true, data: { deleted: true, id: req.params.groupId } });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : 'Không thể xóa nhóm hội thoại.';
    sendApiError(res, 500, 'PORTAL_GROUP_DELETE_FAILED', msg);
  }
});

// 7. Conversations (Sessions) CRUD (`/:slug/sessions`)
publicDomAiPortalRouter.get('/:slug/sessions', async (req, res) => {
  try {
    const loaded = await loadPublicPortalAndViewer(req, res);
    if (!loaded) return;
    const { portal, viewer } = loaded;

    const groupId = cleanStr(req.query.group_id, 64);
    const starredOnly = req.query.starred === 'true' || req.query.starred === '1';
    const searchFolded = normalizeVietnameseFolded(cleanStr(req.query.search || req.query.q, 160));
    const limit = clampInt(req.query.limit, 1, 100, 50);

    const sessions = await withTenantTransaction(portal.tenant_id, async (client) => {
      const r = await client.query(
        `SELECT * FROM dom_ai_conversations
         WHERE tenant_id = $1 AND portal_id = $2 AND LOWER(user_email) = LOWER($3)
         ORDER BY is_starred DESC, last_message_at DESC
         LIMIT 200`,
        [portal.tenant_id, portal.id, viewer.email]
      );
      return r.rows
        .filter((s) => {
          if (groupId && String(s.group_id || '') !== groupId) return false;
          if (starredOnly && !Boolean(s.is_starred)) return false;
          if (searchFolded && !normalizeVietnameseFolded(String(s.title || '')).includes(searchFolded)) {
            return false;
          }
          return true;
        })
        .slice(0, limit)
        .map((s) => ({
          ...s,
          is_starred: Boolean(s.is_starred),
          message_count: Number(s.message_count ?? 0),
        }));
    });

    res.json({ success: true, data: sessions });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : 'Không thể tải danh sách hội thoại.';
    sendApiError(res, 500, 'PORTAL_SESSIONS_LIST_FAILED', msg);
  }
});

publicDomAiPortalRouter.post('/:slug/sessions', async (req, res) => {
  try {
    const loaded = await loadPublicPortalAndViewer(req, res);
    if (!loaded) return;
    const { portal, viewer } = loaded;

    const body = (req.body && typeof req.body === 'object' ? req.body : {}) as Record<string, unknown>;
    const title = cleanStr(body.title, 250) || 'Cuộc hội thoại mới';
    const groupId = body.group_id && isUuid(body.group_id) ? String(body.group_id).trim() : null;
    const collectionFilterId =
      body.collection_filter_id && isUuid(body.collection_filter_id)
        ? String(body.collection_filter_id).trim()
        : null;

    const created = await withTenantTransaction(portal.tenant_id, async (client) => {
      let validGroupId: string | null = null;
      if (groupId) {
        const gChk = await client.query(
          `SELECT id FROM dom_ai_groups
           WHERE tenant_id = $1 AND portal_id = $2 AND id = $3 AND LOWER(portal_user_email) = LOWER($4)
           LIMIT 1`,
          [portal.tenant_id, portal.id, groupId, viewer.email]
        );
        if (gChk.rows[0]) validGroupId = groupId;
      }

      const id = crypto.randomUUID();
      await client.query(
        `INSERT INTO dom_ai_conversations (
           id, tenant_id, portal_id, portal_user_id, user_email, user_name,
           title, group_id, is_starred, collection_filter_id, message_count, last_message_at
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, false, $9, 0, clock_timestamp())`,
        [
          id,
          portal.tenant_id,
          portal.id,
          viewer.portalUserId,
          viewer.email,
          viewer.fullName,
          title,
          validGroupId,
          collectionFilterId,
        ]
      );
      const r = await client.query(
        `SELECT * FROM dom_ai_conversations WHERE tenant_id = $1 AND id = $2 LIMIT 1`,
        [portal.tenant_id, id]
      );
      return {
        ...r.rows[0],
        is_starred: Boolean(r.rows[0]?.is_starred),
        message_count: Number(r.rows[0]?.message_count ?? 0),
      };
    });

    res.status(201).json({ success: true, data: created });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : 'Không thể tạo hội thoại mới.';
    sendApiError(res, 500, 'PORTAL_SESSION_CREATE_FAILED', msg);
  }
});

publicDomAiPortalRouter.get('/:slug/sessions/:sessionId', async (req, res) => {
  try {
    if (!isUuid(req.params.sessionId)) {
      sendApiError(res, 400, 'INVALID_SESSION_ID', 'ID hội thoại không hợp lệ.');
      return;
    }
    const loaded = await loadPublicPortalAndViewer(req, res);
    if (!loaded) return;
    const { portal, viewer } = loaded;

    const detail = await withTenantTransaction(portal.tenant_id, async (client) => {
      const cRes = await client.query(
        `SELECT * FROM dom_ai_conversations
         WHERE tenant_id = $1 AND portal_id = $2 AND id = $3 AND LOWER(user_email) = LOWER($4)
         LIMIT 1`,
        [portal.tenant_id, portal.id, req.params.sessionId, viewer.email]
      );
      const conv = cRes.rows[0];
      if (!conv) return null;

      const mRes = await client.query(
        `SELECT * FROM dom_ai_messages
         WHERE tenant_id = $1 AND portal_id = $2 AND conversation_id = $3
         ORDER BY created_at ASC`,
        [portal.tenant_id, portal.id, conv.id]
      );

      return {
        conversation: {
          ...conv,
          is_starred: Boolean(conv.is_starred),
          message_count: Number(conv.message_count ?? 0),
        },
        messages: mRes.rows.map((m) => ({
          ...m,
          citations: parseJsonArray<DomAiCitation>(m.citations_json),
          latency_ms: Number(m.latency_ms ?? 0),
          tokens_used: Number(m.tokens_used ?? 0),
        })),
      };
    });

    if (!detail) {
      sendApiError(res, 404, 'SESSION_NOT_FOUND', 'Không tìm thấy cuộc hội thoại.');
      return;
    }
    res.json({ success: true, data: detail });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : 'Không thể tải chi tiết hội thoại.';
    sendApiError(res, 500, 'PORTAL_SESSION_DETAIL_FAILED', msg);
  }
});

publicDomAiPortalRouter.patch('/:slug/sessions/:sessionId', async (req, res) => {
  try {
    if (!isUuid(req.params.sessionId)) {
      sendApiError(res, 400, 'INVALID_SESSION_ID', 'ID hội thoại không hợp lệ.');
      return;
    }
    const loaded = await loadPublicPortalAndViewer(req, res);
    if (!loaded) return;
    const { portal, viewer } = loaded;

    const body = (req.body && typeof req.body === 'object' ? req.body : {}) as Record<string, unknown>;

    const updated = await withTenantTransaction(portal.tenant_id, async (client) => {
      const cRes = await client.query(
        `SELECT * FROM dom_ai_conversations
         WHERE tenant_id = $1 AND portal_id = $2 AND id = $3 AND LOWER(user_email) = LOWER($4)
         LIMIT 1`,
        [portal.tenant_id, portal.id, req.params.sessionId, viewer.email]
      );
      const existing = cRes.rows[0];
      if (!existing) return null;

      const nextTitle = body.title !== undefined ? cleanStr(body.title, 250) || existing.title : existing.title;
      const nextStarred =
        typeof body.is_starred === 'boolean' ? body.is_starred : Boolean(existing.is_starred);

      let nextGroupId: string | null = existing.group_id ? String(existing.group_id) : null;
      if (body.group_id !== undefined) {
        if (body.group_id === null || body.group_id === '') {
          nextGroupId = null;
        } else if (isUuid(body.group_id)) {
          const gChk = await client.query(
            `SELECT id FROM dom_ai_groups
             WHERE tenant_id = $1 AND portal_id = $2 AND id = $3 AND LOWER(portal_user_email) = LOWER($4)
             LIMIT 1`,
            [portal.tenant_id, portal.id, String(body.group_id).trim(), viewer.email]
          );
          if (gChk.rows[0]) {
            nextGroupId = String(body.group_id).trim();
          }
        }
      }

      let nextColFilter: string | null = existing.collection_filter_id
        ? String(existing.collection_filter_id)
        : null;
      if (body.collection_filter_id !== undefined) {
        nextColFilter =
          body.collection_filter_id && isUuid(body.collection_filter_id)
            ? String(body.collection_filter_id).trim()
            : null;
      }

      await client.query(
        `UPDATE dom_ai_conversations
         SET title = $3, is_starred = $4, group_id = $5, collection_filter_id = $6
         WHERE tenant_id = $1 AND id = $2`,
        [portal.tenant_id, existing.id, nextTitle, nextStarred, nextGroupId, nextColFilter]
      );

      const reread = await client.query(
        `SELECT * FROM dom_ai_conversations WHERE tenant_id = $1 AND id = $2 LIMIT 1`,
        [portal.tenant_id, existing.id]
      );
      return {
        ...reread.rows[0],
        is_starred: Boolean(reread.rows[0]?.is_starred),
        message_count: Number(reread.rows[0]?.message_count ?? 0),
      };
    });

    if (!updated) {
      sendApiError(res, 404, 'SESSION_NOT_FOUND', 'Không tìm thấy cuộc hội thoại.');
      return;
    }
    res.json({ success: true, data: updated });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : 'Không thể cập nhật hội thoại.';
    sendApiError(res, 500, 'PORTAL_SESSION_UPDATE_FAILED', msg);
  }
});

publicDomAiPortalRouter.delete('/:slug/sessions/:sessionId', async (req, res) => {
  try {
    if (!isUuid(req.params.sessionId)) {
      sendApiError(res, 400, 'INVALID_SESSION_ID', 'ID hội thoại không hợp lệ.');
      return;
    }
    const loaded = await loadPublicPortalAndViewer(req, res);
    if (!loaded) return;
    const { portal, viewer } = loaded;

    const deleted = await withTenantTransaction(portal.tenant_id, async (client) => {
      const chk = await client.query(
        `SELECT id FROM dom_ai_conversations
         WHERE tenant_id = $1 AND portal_id = $2 AND id = $3 AND LOWER(user_email) = LOWER($4)
         LIMIT 1`,
        [portal.tenant_id, portal.id, req.params.sessionId, viewer.email]
      );
      if (!chk.rows[0]) return false;
      await client.query(`DELETE FROM dom_ai_conversations WHERE tenant_id = $1 AND id = $2`, [
        portal.tenant_id,
        req.params.sessionId,
      ]);
      return true;
    });

    if (!deleted) {
      sendApiError(res, 404, 'SESSION_NOT_FOUND', 'Không tìm thấy cuộc hội thoại.');
      return;
    }
    res.json({ success: true, data: { deleted: true, id: req.params.sessionId } });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : 'Không thể xóa hội thoại.';
    sendApiError(res, 500, 'PORTAL_SESSION_DELETE_FAILED', msg);
  }
});

// 8. POST /:slug/chat — RAG-grounded enterprise Q&A chat
publicDomAiPortalRouter.post('/:slug/chat', portalChatRateLimiter, async (req, res) => {
  try {
    const loaded = await loadPublicPortalAndViewer(req, res);
    if (!loaded) return;
    const { portal, viewer } = loaded;

    const body = (req.body && typeof req.body === 'object' ? req.body : {}) as Record<string, unknown>;
    const message = cleanStr(body.message || body.prompt || body.question, 4000);
    if (!message) {
      sendApiError(res, 422, 'CHAT_MESSAGE_REQUIRED', 'Vui lòng nhập nội dung câu hỏi.');
      return;
    }

    const rawConvId = body.conversation_id || body.session_id;
    const conversationId = rawConvId && isUuid(rawConvId) ? String(rawConvId).trim() : null;
    const collectionFilterId =
      body.collection_filter_id && isUuid(body.collection_filter_id)
        ? String(body.collection_filter_id).trim()
        : undefined;

    const result = await withTenantTransaction(portal.tenant_id, (client) =>
      runDomAiPortalChatInTx(client, portal.tenant_id, {
        portal,
        viewer,
        message,
        conversationId,
        collectionFilterId,
      })
    );

    res.json({ success: true, data: result });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : 'Không thể xử lý câu hỏi AI lúc này.';
    sendApiError(res, 500, 'PORTAL_CHAT_FAILED', msg);
  }
});

// 9. POST /:slug/messages/:msgId/feedback — Record thumbs up/down + optional note
publicDomAiPortalRouter.post('/:slug/messages/:msgId/feedback', async (req, res) => {
  try {
    if (!isUuid(req.params.msgId)) {
      sendApiError(res, 400, 'INVALID_MESSAGE_ID', 'ID tin nhắn không hợp lệ.');
      return;
    }
    const loaded = await loadPublicPortalAndViewer(req, res);
    if (!loaded) return;
    const { portal, viewer } = loaded;

    const body = (req.body && typeof req.body === 'object' ? req.body : {}) as Record<string, unknown>;
    const rawFeedback = body.feedback;
    const feedback: 'up' | 'down' | null =
      rawFeedback === 'up' || rawFeedback === 'down' ? rawFeedback : null;
    const feedbackNote = cleanStr(body.feedback_note ?? body.note, 1000) || null;

    const updated = await withTenantTransaction(portal.tenant_id, async (client) => {
      const mRes = await client.query(
        `SELECT m.id
         FROM dom_ai_messages m
         INNER JOIN dom_ai_conversations c
           ON c.tenant_id = m.tenant_id AND c.id = m.conversation_id
         WHERE m.tenant_id = $1
           AND m.portal_id = $2
           AND m.id = $3
           AND LOWER(c.user_email) = LOWER($4)
         LIMIT 1`,
        [portal.tenant_id, portal.id, req.params.msgId, viewer.email]
      );
      if (!mRes.rows[0]) return null;

      await client.query(
        `UPDATE dom_ai_messages
         SET feedback = $3, feedback_note = $4
         WHERE tenant_id = $1 AND id = $2`,
        [portal.tenant_id, req.params.msgId, feedback, feedbackNote]
      );
      const reread = await client.query(
        `SELECT * FROM dom_ai_messages WHERE tenant_id = $1 AND id = $2 LIMIT 1`,
        [portal.tenant_id, req.params.msgId]
      );
      return {
        ...reread.rows[0],
        citations: parseJsonArray<DomAiCitation>(reread.rows[0]?.citations_json),
      };
    });

    if (!updated) {
      sendApiError(res, 404, 'MESSAGE_NOT_FOUND', 'Không tìm thấy tin nhắn để ghi nhận đánh giá.');
      return;
    }
    res.json({ success: true, data: updated });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : 'Không thể lưu phản hồi đánh giá.';
    sendApiError(res, 500, 'PORTAL_FEEDBACK_FAILED', msg);
  }
});

// ============================================================================
// PART B: AUTHENTICATED TENANT ADMIN APIs (`/api/v1/dom-ai-portal/*`)
// Accessible to tenant admins/managers on ANY package including FREE standalone BYOK!
// ============================================================================
domAiPortalRouter.use(async (_req, res, next) => {
  try {
    await runDomAiPortalSchema();
    next();
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : 'Không thể khởi tạo cấu trúc dữ liệu DOM AI Portal.';
    sendApiError(res, 500, 'DOM_AI_SCHEMA_INIT_FAILED', msg);
  }
});

domAiPortalRouter.use(requireTenantAuth);

domAiPortalRouter.use(async (req, res, next) => {
  try {
    const ctx = getTenantContext();
    const resolved = await withTenantTransaction(ctx.tenantId, (client) =>
      resolveUserEffectivePermissions(client, ctx.tenantId, ctx.userId)
    );

    const role = String(resolved.userOrg?.role || ctx.userRole || '').trim().toLowerCase();
    const isAdminOrManager =
      Boolean(resolved.userOrg?.is_tenant_owner) ||
      ['owner', 'admin', 'tenant_admin', 'manager', 'super_admin', 'superadmin'].includes(role) ||
      Boolean(resolved.effectivePermissions.settings?.actions.manage_config) ||
      Boolean(resolved.effectivePermissions.dom_agent?.actions.manage_config) ||
      Boolean(resolved.effectivePermissions.mkt_ai_bot?.actions.manage_config);

    if (!isAdminOrManager) {
      sendApiError(
        res,
        403,
        'FORBIDDEN_PORTAL_ADMIN',
        'Chỉ quản trị viên hoặc quản lý doanh nghiệp mới có quyền quản trị DOM AI Assistant.'
      );
      return;
    }

    next();
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : 'Không thể xác thực quyền quản trị DOM AI Portal.';
    sendApiError(res, 500, 'DOM_AI_ADMIN_AUTH_FAILED', msg);
  }
});

async function assertPortalExistsInTx(
  client: Parameters<Parameters<typeof withTenantTransaction>[1]>[0],
  tenantId: string,
  portalId: string
): Promise<PortalRecord | null> {
  if (!isUuid(portalId)) return null;
  const r = await client.query<PortalRecord>(
    `SELECT * FROM dom_ai_portals WHERE tenant_id = $1 AND id = $2 LIMIT 1`,
    [tenantId, portalId]
  );
  return r.rows[0] || null;
}

async function isGlobalPortalSlugTaken(slug: string, excludePortalId?: string): Promise<boolean> {
  return withSystemPrivilege(async (client) => {
    const r = await client.query<{ id: string }>(
      `SELECT id FROM dom_ai_portals WHERE LOWER(slug) = LOWER($1) LIMIT 2`,
      [slug]
    );
    return r.rows.some((row) => !excludePortalId || String(row.id) !== excludePortalId);
  });
}

// 1. GET /portals — List tenant's AI portals with live counts & BYOK status
domAiPortalRouter.get('/portals', async (_req, res) => {
  try {
    const ctx = getTenantContext();
    const portals = await withTenantTransaction(ctx.tenantId, async (client) => {
      const pRes = await client.query<PortalRecord>(
        `SELECT * FROM dom_ai_portals WHERE tenant_id = $1 ORDER BY created_at DESC`,
        [ctx.tenantId]
      );
      if (pRes.rows.length === 0) return [];

      const [colRes, docRes, chunkRes, usrRes, convRes, msgRes] = await Promise.all([
        client.query<{ portal_id: string; cnt: string | number }>(
          `SELECT portal_id, COUNT(*) AS cnt FROM dom_ai_collections WHERE tenant_id = $1 GROUP BY portal_id`,
          [ctx.tenantId]
        ),
        client.query<{ portal_id: string; cnt: string | number }>(
          `SELECT portal_id, COUNT(*) AS cnt FROM dom_ai_documents WHERE tenant_id = $1 GROUP BY portal_id`,
          [ctx.tenantId]
        ),
        client.query<{ portal_id: string; cnt: string | number }>(
          `SELECT portal_id, COUNT(*) AS cnt FROM dom_ai_chunks WHERE tenant_id = $1 GROUP BY portal_id`,
          [ctx.tenantId]
        ),
        client.query<{ portal_id: string; cnt: string | number }>(
          `SELECT portal_id, COUNT(*) AS cnt FROM dom_ai_portal_users WHERE tenant_id = $1 GROUP BY portal_id`,
          [ctx.tenantId]
        ),
        client.query<{ portal_id: string; cnt: string | number }>(
          `SELECT portal_id, COUNT(*) AS cnt FROM dom_ai_conversations WHERE tenant_id = $1 GROUP BY portal_id`,
          [ctx.tenantId]
        ),
        client.query<{ portal_id: string; cnt: string | number }>(
          `SELECT portal_id, COUNT(*) AS cnt FROM dom_ai_messages WHERE tenant_id = $1 GROUP BY portal_id`,
          [ctx.tenantId]
        ),
      ]);

      const toMap = (rows: Array<{ portal_id: string; cnt: string | number }>) => {
        const m = new Map<string, number>();
        for (const r of rows) m.set(String(r.portal_id), Number(r.cnt || 0));
        return m;
      };
      const colMap = toMap(colRes.rows);
      const docMap = toMap(docRes.rows);
      const chunkMap = toMap(chunkRes.rows);
      const usrMap = toMap(usrRes.rows);
      const convMap = toMap(convRes.rows);
      const msgMap = toMap(msgRes.rows);

      const out = [];
      for (const p of pRes.rows) {
        const byok = await resolvePortalGeminiByokInTx(client, ctx.tenantId, p.metadata_json);
        out.push(
          formatPortalForAdmin(p as unknown as Record<string, unknown>, {
            has_api_key: Boolean(byok.apiKey),
            api_key_hint: byok.keyHint,
            api_key_source: byok.source,
            collection_count: colMap.get(p.id) || 0,
            document_count: docMap.get(p.id) || 0,
            chunk_count: chunkMap.get(p.id) || 0,
            user_count: usrMap.get(p.id) || 0,
            conversation_count: convMap.get(p.id) || 0,
            message_count: msgMap.get(p.id) || 0,
          })
        );
      }
      return out;
    });

    res.json({ success: true, data: portals });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : 'Không thể tải danh sách cổng AI.';
    sendApiError(res, 500, 'PORTALS_LIST_FAILED', msg);
  }
});

// 2. POST /portals — Create a new standalone AI Knowledge Portal
domAiPortalRouter.post('/portals', async (req, res) => {
  try {
    const ctx = getTenantContext();
    const body = (req.body && typeof req.body === 'object' ? req.body : {}) as Record<string, unknown>;
    const name = cleanStr(body.name, 200);
    if (!name) {
      sendApiError(res, 422, 'PORTAL_NAME_REQUIRED', 'Vui lòng nhập tên cổng Trợ lý AI.');
      return;
    }

    let slug = slugifyDomAi(String(body.slug || name), `portal-${crypto.randomBytes(3).toString('hex')}`);
    if (body.slug) {
      if (await isGlobalPortalSlugTaken(slug)) {
        sendApiError(
          res,
          409,
          'PORTAL_SLUG_TAKEN',
          `Đường dẫn /ai/${slug} đã được sử dụng. Vui lòng chọn slug khác.`
        );
        return;
      }
    } else if (await isGlobalPortalSlugTaken(slug)) {
      slug = `${slug.slice(0, 68)}-${crypto.randomBytes(3).toString('hex')}`;
    }

    const authMode = VALID_AUTH_MODES.has(body.auth_mode as DomAiAuthMode)
      ? (body.auth_mode as DomAiAuthMode)
      : 'open_login';
    const starterPrompts = Array.isArray(body.starter_prompts)
      ? body.starter_prompts.map((x) => cleanStr(x, 220)).filter(Boolean).slice(0, 8)
      : DEFAULT_STARTER_PROMPTS;
    const temperature =
      body.temperature !== undefined && Number.isFinite(Number(body.temperature))
        ? Math.max(0, Math.min(1, Number(body.temperature)))
        : 0.25;
    const topK = clampInt(body.top_k, 1, 15, 6);
    const metaObj = sanitizeMetadataPublic(body.metadata);

    const created = await withTenantTransaction(ctx.tenantId, async (client) => {
      const id = crypto.randomUUID();
      await client.query(
        `INSERT INTO dom_ai_portals (
           id, tenant_id, slug, name, tagline, logo_url, primary_color,
           welcome_message, system_instruction, starter_prompts_json,
           auth_mode, allow_guest_history, model, temperature, top_k,
           is_active, is_free_byok, metadata_json
         ) VALUES (
           $1, $2, $3, $4, $5, $6, $7,
           $8, $9, $10::jsonb,
           $11, $12, $13, $14, $15,
           $16, $17, $18::jsonb
         )`,
        [
          id,
          ctx.tenantId,
          slug,
          name,
          cleanStr(body.tagline, 300),
          sanitizeSafePortalUrl(body.logo_url, 1000),
          cleanStr(body.primary_color, 32) || DEFAULT_PORTAL_PRIMARY_COLOR,
          cleanStr(body.welcome_message, 2000) || DEFAULT_PORTAL_WELCOME,
          cleanStr(body.system_instruction, 12000) || DEFAULT_PORTAL_SYSTEM_INSTRUCTION,
          JSON.stringify(starterPrompts),
          authMode,
          body.allow_guest_history !== false,
          cleanStr(body.model, 80) || DEFAULT_PORTAL_MODEL,
          temperature,
          topK,
          body.is_active !== false,
          body.is_free_byok !== false,
          JSON.stringify(metaObj),
        ]
      );
      const r = await client.query<PortalRecord>(
        `SELECT * FROM dom_ai_portals WHERE tenant_id = $1 AND id = $2 LIMIT 1`,
        [ctx.tenantId, id]
      );
      const byok = await resolvePortalGeminiByokInTx(client, ctx.tenantId, r.rows[0].metadata_json);
      return formatPortalForAdmin(r.rows[0] as unknown as Record<string, unknown>, {
        has_api_key: Boolean(byok.apiKey),
        api_key_hint: byok.keyHint,
        api_key_source: byok.source,
      });
    });

    res.status(201).json({ success: true, data: created });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : 'Không thể tạo cổng Trợ lý AI.';
    sendApiError(res, 500, 'PORTAL_CREATE_FAILED', msg);
  }
});

// 3. GET /portals/:id — Single portal detail
domAiPortalRouter.get('/portals/:id', async (req, res) => {
  try {
    const ctx = getTenantContext();
    const portal = await withTenantTransaction(ctx.tenantId, async (client) => {
      const p = await assertPortalExistsInTx(client, ctx.tenantId, req.params.id);
      if (!p) return null;
      const byok = await resolvePortalGeminiByokInTx(client, ctx.tenantId, p.metadata_json);
      return formatPortalForAdmin(p as unknown as Record<string, unknown>, {
        has_api_key: Boolean(byok.apiKey),
        api_key_hint: byok.keyHint,
        api_key_source: byok.source,
      });
    });
    if (!portal) {
      sendApiError(res, 404, 'PORTAL_NOT_FOUND', 'Không tìm thấy cổng AI.');
      return;
    }
    res.json({ success: true, data: portal });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : 'Không thể tải thông tin cổng AI.';
    sendApiError(res, 500, 'PORTAL_GET_FAILED', msg);
  }
});

// 4. PUT|PATCH /portals/:id — Update portal branding, auth_mode, AI params
const updatePortalHandler = async (req: Request, res: Response) => {
  try {
    const ctx = getTenantContext();
    const portalId = req.params.id;
    if (!isUuid(portalId)) {
      sendApiError(res, 400, 'INVALID_PORTAL_ID', 'ID cổng AI không hợp lệ.');
      return;
    }

    const body = (req.body && typeof req.body === 'object' ? req.body : {}) as Record<string, unknown>;
    const nextSlugCandidate =
      typeof body.slug === 'string' && body.slug.trim() ? slugifyDomAi(body.slug) : null;

    if (nextSlugCandidate && (await isGlobalPortalSlugTaken(nextSlugCandidate, portalId))) {
      sendApiError(
        res,
        409,
        'PORTAL_SLUG_TAKEN',
        `Đường dẫn /ai/${nextSlugCandidate} đã được sử dụng.`
      );
      return;
    }

    const updated = await withTenantTransaction(ctx.tenantId, async (client) => {
      const existing = await assertPortalExistsInTx(client, ctx.tenantId, portalId);
      if (!existing) return null;

      const existingMeta = parseJsonObject<Record<string, unknown>>(existing.metadata_json);
      const nextMeta =
        body.metadata && typeof body.metadata === 'object' && !Array.isArray(body.metadata)
          ? {
              ...sanitizeMetadataPublic(body.metadata),
              ...(existingMeta.byok_vault ? { byok_vault: existingMeta.byok_vault } : {}),
            }
          : existingMeta;

      const nextAuthMode =
        body.auth_mode !== undefined && VALID_AUTH_MODES.has(body.auth_mode as DomAiAuthMode)
          ? (body.auth_mode as DomAiAuthMode)
          : existing.auth_mode;
      const nextPrompts = Array.isArray(body.starter_prompts)
        ? body.starter_prompts.map((x) => cleanStr(x, 220)).filter(Boolean).slice(0, 8)
        : parseJsonArray<string>(existing.starter_prompts_json);
      const nextTemp =
        body.temperature !== undefined && Number.isFinite(Number(body.temperature))
          ? Math.max(0, Math.min(1, Number(body.temperature)))
          : Number(existing.temperature);
      const nextTopK =
        body.top_k !== undefined ? clampInt(body.top_k, 1, 15, 6) : Number(existing.top_k);

      await client.query(
        `UPDATE dom_ai_portals
         SET slug = $3,
             name = $4,
             tagline = $5,
             logo_url = $6,
             primary_color = $7,
             welcome_message = $8,
             system_instruction = $9,
             starter_prompts_json = $10::jsonb,
             auth_mode = $11,
             allow_guest_history = $12,
             model = $13,
             temperature = $14,
             top_k = $15,
             is_active = $16,
             is_free_byok = $17,
             metadata_json = $18::jsonb,
             updated_at = clock_timestamp()
         WHERE tenant_id = $1 AND id = $2`,
        [
          ctx.tenantId,
          portalId,
          nextSlugCandidate || existing.slug,
          body.name !== undefined ? cleanStr(body.name, 200) || existing.name : existing.name,
          body.tagline !== undefined ? cleanStr(body.tagline, 300) : existing.tagline,
          body.logo_url !== undefined ? sanitizeSafePortalUrl(body.logo_url, 1000) : existing.logo_url,
          body.primary_color !== undefined
            ? cleanStr(body.primary_color, 32) || existing.primary_color
            : existing.primary_color,
          body.welcome_message !== undefined ? cleanStr(body.welcome_message, 2000) : existing.welcome_message,
          body.system_instruction !== undefined
            ? cleanStr(body.system_instruction, 12000)
            : existing.system_instruction,
          JSON.stringify(nextPrompts),
          nextAuthMode,
          typeof body.allow_guest_history === 'boolean'
            ? body.allow_guest_history
            : Boolean(existing.allow_guest_history),
          body.model !== undefined ? cleanStr(body.model, 80) || existing.model : existing.model,
          nextTemp,
          nextTopK,
          typeof body.is_active === 'boolean' ? body.is_active : Boolean(existing.is_active),
          typeof body.is_free_byok === 'boolean' ? body.is_free_byok : Boolean(existing.is_free_byok),
          JSON.stringify(nextMeta),
        ]
      );

      const reread = await client.query<PortalRecord>(
        `SELECT * FROM dom_ai_portals WHERE tenant_id = $1 AND id = $2 LIMIT 1`,
        [ctx.tenantId, portalId]
      );
      const byok = await resolvePortalGeminiByokInTx(client, ctx.tenantId, reread.rows[0].metadata_json);
      return formatPortalForAdmin(reread.rows[0] as unknown as Record<string, unknown>, {
        has_api_key: Boolean(byok.apiKey),
        api_key_hint: byok.keyHint,
        api_key_source: byok.source,
      });
    });

    if (!updated) {
      sendApiError(res, 404, 'PORTAL_NOT_FOUND', 'Không tìm thấy cổng AI để cập nhật.');
      return;
    }
    res.json({ success: true, data: updated });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : 'Không thể cập nhật cổng AI.';
    sendApiError(res, 500, 'PORTAL_UPDATE_FAILED', msg);
  }
};
domAiPortalRouter.put('/portals/:id', updatePortalHandler);
domAiPortalRouter.patch('/portals/:id', updatePortalHandler);

// 5. DELETE /portals/:id
domAiPortalRouter.delete('/portals/:id', async (req, res) => {
  try {
    const ctx = getTenantContext();
    const deleted = await withTenantTransaction(ctx.tenantId, async (client) => {
      const p = await assertPortalExistsInTx(client, ctx.tenantId, req.params.id);
      if (!p) return false;
      await client.query(`DELETE FROM dom_ai_portals WHERE tenant_id = $1 AND id = $2`, [
        ctx.tenantId,
        p.id,
      ]);
      return true;
    });
    if (!deleted) {
      sendApiError(res, 404, 'PORTAL_NOT_FOUND', 'Không tìm thấy cổng AI để xóa.');
      return;
    }
    res.json({ success: true, data: { deleted: true, id: req.params.id } });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : 'Không thể xóa cổng AI.';
    sendApiError(res, 500, 'PORTAL_DELETE_FAILED', msg);
  }
});

// 6. GET /portals/:id/dashboard — Analytics, daily trends, top cited docs, feedback %, unanswered queries
domAiPortalRouter.get('/portals/:id/dashboard', async (req, res) => {
  try {
    const ctx = getTenantContext();
    const days = clampInt(req.query.days, 1, 90, 14);

    const dashboard = await withTenantTransaction(ctx.tenantId, async (client) => {
      const portal = await assertPortalExistsInTx(client, ctx.tenantId, req.params.id);
      if (!portal) return null;

      const [
        byok,
        colsRes,
        docsRes,
        chunksRes,
        usersRes,
        convsRes,
        msgsRes,
      ] = await Promise.all([
        resolvePortalGeminiByokInTx(client, ctx.tenantId, portal.metadata_json),
        client.query<{ cnt: string | number }>(
          `SELECT COUNT(*) AS cnt FROM dom_ai_collections WHERE tenant_id = $1 AND portal_id = $2`,
          [ctx.tenantId, portal.id]
        ),
        client.query<{ total: string | number; active: string | number }>(
          `SELECT COUNT(*) AS total,
                  SUM(CASE WHEN status = 'active' THEN 1 ELSE 0 END) AS active
           FROM dom_ai_documents
           WHERE tenant_id = $1 AND portal_id = $2`,
          [ctx.tenantId, portal.id]
        ),
        client.query<{ cnt: string | number }>(
          `SELECT COUNT(*) AS cnt FROM dom_ai_chunks WHERE tenant_id = $1 AND portal_id = $2`,
          [ctx.tenantId, portal.id]
        ),
        client.query<{ total: string | number; active: string | number }>(
          `SELECT COUNT(*) AS total,
                  SUM(CASE WHEN status = 'active' THEN 1 ELSE 0 END) AS active
           FROM dom_ai_portal_users
           WHERE tenant_id = $1 AND portal_id = $2`,
          [ctx.tenantId, portal.id]
        ),
        client.query<{ id: string; user_email: string; user_name: string; title: string }>(
          `SELECT id, user_email, user_name, title
           FROM dom_ai_conversations
           WHERE tenant_id = $1 AND portal_id = $2`,
          [ctx.tenantId, portal.id]
        ),
        client.query<{
          id: string;
          conversation_id: string;
          role: string;
          content: string;
          citations_json: unknown;
          latency_ms: number;
          tokens_used: number;
          feedback: string | null;
          feedback_note: string | null;
          created_at: string | Date;
        }>(
          `SELECT id, conversation_id, role, content, citations_json, latency_ms, tokens_used,
                  feedback, feedback_note, created_at
           FROM dom_ai_messages
           WHERE tenant_id = $1 AND portal_id = $2
           ORDER BY conversation_id ASC, created_at ASC`,
          [ctx.tenantId, portal.id]
        ),
      ]);

      const convMap = new Map<string, { user_email: string; user_name: string; title: string }>();
      for (const c of convsRes.rows) {
        convMap.set(String(c.id), {
          user_email: String(c.user_email || ''),
          user_name: String(c.user_name || ''),
          title: String(c.title || ''),
        });
      }

      // Build daily trend buckets
      const now = new Date();
      const trendBuckets = new Map<
        string,
        { date: string; questions: number; users: Set<string>; latencySum: number; latencyCount: number }
      >();
      for (let i = days - 1; i >= 0; i--) {
        const d = new Date(now.getTime() - i * 86_400_000);
        const key = d.toISOString().slice(0, 10);
        trendBuckets.set(key, {
          date: key,
          questions: 0,
          users: new Set<string>(),
          latencySum: 0,
          latencyCount: 0,
        });
      }

      const activeUserEmails = new Set<string>();
      const docCiteCounts = new Map<
        string,
        { document_id: string; title: string; collection_name: string | null; cite_count: number }
      >();
      const unansweredOrNegative: Array<Record<string, unknown>> = [];

      let totalQuestions = 0;
      let totalLatency = 0;
      let latencySamples = 0;
      let feedbackUp = 0;
      let feedbackDown = 0;

      // Pair preceding user message per conversation
      const lastUserByConv = new Map<string, string>();

      for (const m of msgsRes.rows) {
        const convInfo = convMap.get(String(m.conversation_id));
        const userEmail = convInfo?.user_email || '';
        const dateKey = new Date(m.created_at).toISOString().slice(0, 10);
        const bucket = trendBuckets.get(dateKey);

        if (userEmail) activeUserEmails.add(userEmail.toLowerCase());

        if (m.role === 'user') {
          totalQuestions++;
          lastUserByConv.set(String(m.conversation_id), String(m.content || ''));
          if (bucket) {
            bucket.questions++;
            if (userEmail) bucket.users.add(userEmail.toLowerCase());
          }
        } else if (m.role === 'assistant') {
          const lat = Number(m.latency_ms || 0);
          if (lat > 0) {
            totalLatency += lat;
            latencySamples++;
            if (bucket) {
              bucket.latencySum += lat;
              bucket.latencyCount++;
            }
          }
          if (m.feedback === 'up') feedbackUp++;
          if (m.feedback === 'down') feedbackDown++;

          const cites = parseJsonArray<DomAiCitation>(m.citations_json);
          const seenDocsInMsg = new Set<string>();
          for (const c of cites) {
            if (!c.document_id || seenDocsInMsg.has(c.document_id)) continue;
            seenDocsInMsg.add(c.document_id);
            const cur = docCiteCounts.get(c.document_id);
            if (cur) {
              cur.cite_count++;
            } else {
              docCiteCounts.set(c.document_id, {
                document_id: c.document_id,
                title: c.title || 'Tài liệu',
                collection_name: c.collection_name || null,
                cite_count: 1,
              });
            }
          }

          if (m.feedback === 'down' || cites.length === 0) {
            const qText = lastUserByConv.get(String(m.conversation_id)) || convInfo?.title || '';
            unansweredOrNegative.push({
              message_id: String(m.id),
              conversation_id: String(m.conversation_id),
              question: qText,
              answer_preview: String(m.content || '').slice(0, 260),
              user_email: userEmail,
              user_name: convInfo?.user_name || '',
              feedback: m.feedback || null,
              feedback_note: m.feedback_note || null,
              citation_count: cites.length,
              created_at: m.created_at,
            });
          }
        }
      }

      const feedbackTotal = feedbackUp + feedbackDown;
      const satisfactionRate =
        feedbackTotal > 0 ? Number(((feedbackUp / feedbackTotal) * 100).toFixed(1)) : null;

      unansweredOrNegative.sort(
        (a, b) => new Date(String(b.created_at)).getTime() - new Date(String(a.created_at)).getTime()
      );

      const topCitedDocs = Array.from(docCiteCounts.values())
        .sort((a, b) => b.cite_count - a.cite_count)
        .slice(0, 10);

      const dailyTrends = Array.from(trendBuckets.values()).map((b) => ({
        date: b.date,
        questions: b.questions,
        active_users: b.users.size,
        avg_latency_ms: b.latencyCount > 0 ? Math.round(b.latencySum / b.latencyCount) : 0,
      }));

      return {
        portal: formatPortalForAdmin(portal as unknown as Record<string, unknown>, {
          has_api_key: Boolean(byok.apiKey),
          api_key_hint: byok.keyHint,
          api_key_source: byok.source,
        }),
        summary: {
          total_collections: Number(colsRes.rows[0]?.cnt || 0),
          total_documents: Number(docsRes.rows[0]?.total || 0),
          active_documents: Number(docsRes.rows[0]?.active || 0),
          total_chunks: Number(chunksRes.rows[0]?.cnt || 0),
          total_viewers: Number(usersRes.rows[0]?.total || 0),
          active_viewers: Number(usersRes.rows[0]?.active || 0),
          active_users: activeUserEmails.size,
          total_conversations: convsRes.rows.length,
          total_questions: totalQuestions,
          total_messages: msgsRes.rows.length,
          avg_latency_ms: latencySamples > 0 ? Math.round(totalLatency / latencySamples) : 0,
          feedback_up: feedbackUp,
          feedback_down: feedbackDown,
          feedback_total: feedbackTotal,
          satisfaction_rate: satisfactionRate,
        },
        daily_trends: dailyTrends,
        top_cited_documents: topCitedDocs,
        top_unanswered_or_negative: unansweredOrNegative.slice(0, 15),
      };
    });

    if (!dashboard) {
      sendApiError(res, 404, 'PORTAL_NOT_FOUND', 'Không tìm thấy cổng AI.');
      return;
    }
    res.json({ success: true, data: dashboard });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : 'Không thể tải báo cáo tổng quan cổng AI.';
    sendApiError(res, 500, 'PORTAL_DASHBOARD_FAILED', msg);
  }
});

// ============================================================================
// 7. Collections CRUD (`/portals/:id/collections`)
// ============================================================================
domAiPortalRouter.get('/portals/:id/collections', async (req, res) => {
  try {
    const ctx = getTenantContext();
    const items = await withTenantTransaction(ctx.tenantId, async (client) => {
      const p = await assertPortalExistsInTx(client, ctx.tenantId, req.params.id);
      if (!p) return null;
      const r = await client.query(
        `SELECT * FROM dom_ai_collections
         WHERE tenant_id = $1 AND portal_id = $2
         ORDER BY sort_order ASC, name ASC`,
        [ctx.tenantId, p.id]
      );
      return r.rows.map((c) => ({
        ...c,
        is_public: Boolean(c.is_public),
        sort_order: Number(c.sort_order ?? 0),
        doc_count: Number(c.doc_count ?? 0),
      }));
    });
    if (items === null) {
      sendApiError(res, 404, 'PORTAL_NOT_FOUND', 'Không tìm thấy cổng AI.');
      return;
    }
    res.json({ success: true, data: items });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : 'Không thể tải danh sách bộ sưu tập.';
    sendApiError(res, 500, 'COLLECTIONS_LIST_FAILED', msg);
  }
});

domAiPortalRouter.post('/portals/:id/collections', async (req, res) => {
  try {
    const ctx = getTenantContext();
    const body = (req.body && typeof req.body === 'object' ? req.body : {}) as Record<string, unknown>;
    const name = cleanStr(body.name, 200);
    if (!name) {
      sendApiError(res, 422, 'COLLECTION_NAME_REQUIRED', 'Vui lòng nhập tên bộ sưu tập.');
      return;
    }

    const created = await withTenantTransaction(ctx.tenantId, async (client) => {
      const p = await assertPortalExistsInTx(client, ctx.tenantId, req.params.id);
      if (!p) return null;

      let slug = slugifyDomAi(String(body.slug || name), `col-${crypto.randomBytes(3).toString('hex')}`);
      const dupChk = await client.query(
        `SELECT id FROM dom_ai_collections
         WHERE tenant_id = $1 AND portal_id = $2 AND slug = $3
         LIMIT 1`,
        [ctx.tenantId, p.id, slug]
      );
      if (dupChk.rows[0]) {
        slug = `${slug.slice(0, 95)}-${crypto.randomBytes(2).toString('hex')}`;
      }

      const id = crypto.randomUUID();
      await client.query(
        `INSERT INTO dom_ai_collections (
           id, tenant_id, portal_id, slug, name, description, icon, color, sort_order, is_public, doc_count
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 0)`,
        [
          id,
          ctx.tenantId,
          p.id,
          slug,
          name,
          cleanStr(body.description, 1000),
          cleanStr(body.icon, 60) || 'BookOpen',
          cleanStr(body.color, 32) || p.primary_color || DEFAULT_PORTAL_PRIMARY_COLOR,
          clampInt(body.sort_order, 0, 10_000, 0),
          body.is_public !== false,
        ]
      );
      const r = await client.query(
        `SELECT * FROM dom_ai_collections WHERE tenant_id = $1 AND id = $2 LIMIT 1`,
        [ctx.tenantId, id]
      );
      return {
        ...r.rows[0],
        is_public: Boolean(r.rows[0]?.is_public),
        sort_order: Number(r.rows[0]?.sort_order ?? 0),
        doc_count: Number(r.rows[0]?.doc_count ?? 0),
      };
    });

    if (!created) {
      sendApiError(res, 404, 'PORTAL_NOT_FOUND', 'Không tìm thấy cổng AI.');
      return;
    }
    res.status(201).json({ success: true, data: created });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : 'Không thể tạo bộ sưu tập.';
    sendApiError(res, 500, 'COLLECTION_CREATE_FAILED', msg);
  }
});

const updateCollectionHandler = async (req: Request, res: Response) => {
  try {
    const ctx = getTenantContext();
    if (!isUuid(req.params.collectionId)) {
      sendApiError(res, 400, 'INVALID_COLLECTION_ID', 'ID bộ sưu tập không hợp lệ.');
      return;
    }
    const body = (req.body && typeof req.body === 'object' ? req.body : {}) as Record<string, unknown>;

    const updated = await withTenantTransaction(ctx.tenantId, async (client) => {
      const p = await assertPortalExistsInTx(client, ctx.tenantId, req.params.id);
      if (!p) return null;

      const curRes = await client.query(
        `SELECT * FROM dom_ai_collections
         WHERE tenant_id = $1 AND portal_id = $2 AND id = $3
         LIMIT 1`,
        [ctx.tenantId, p.id, req.params.collectionId]
      );
      const cur = curRes.rows[0];
      if (!cur) return 'NOT_FOUND' as const;

      const nextSlug =
        body.slug !== undefined && cleanStr(body.slug, 120)
          ? slugifyDomAi(String(body.slug))
          : String(cur.slug);

      await client.query(
        `UPDATE dom_ai_collections
         SET slug = $3,
             name = $4,
             description = $5,
             icon = $6,
             color = $7,
             sort_order = $8,
             is_public = $9,
             updated_at = clock_timestamp()
         WHERE tenant_id = $1 AND id = $2`,
        [
          ctx.tenantId,
          cur.id,
          nextSlug,
          body.name !== undefined ? cleanStr(body.name, 200) || cur.name : cur.name,
          body.description !== undefined ? cleanStr(body.description, 1000) : cur.description,
          body.icon !== undefined ? cleanStr(body.icon, 60) || cur.icon : cur.icon,
          body.color !== undefined ? cleanStr(body.color, 32) || cur.color : cur.color,
          body.sort_order !== undefined
            ? clampInt(body.sort_order, 0, 10_000, Number(cur.sort_order ?? 0))
            : Number(cur.sort_order ?? 0),
          typeof body.is_public === 'boolean' ? body.is_public : Boolean(cur.is_public),
        ]
      );
      const reread = await client.query(
        `SELECT * FROM dom_ai_collections WHERE tenant_id = $1 AND id = $2 LIMIT 1`,
        [ctx.tenantId, cur.id]
      );
      return {
        ...reread.rows[0],
        is_public: Boolean(reread.rows[0]?.is_public),
        sort_order: Number(reread.rows[0]?.sort_order ?? 0),
        doc_count: Number(reread.rows[0]?.doc_count ?? 0),
      };
    });

    if (updated === null) {
      sendApiError(res, 404, 'PORTAL_NOT_FOUND', 'Không tìm thấy cổng AI.');
      return;
    }
    if (updated === 'NOT_FOUND') {
      sendApiError(res, 404, 'COLLECTION_NOT_FOUND', 'Không tìm thấy bộ sưu tập.');
      return;
    }
    res.json({ success: true, data: updated });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : 'Không thể cập nhật bộ sưu tập.';
    sendApiError(res, 500, 'COLLECTION_UPDATE_FAILED', msg);
  }
};
domAiPortalRouter.put('/portals/:id/collections/:collectionId', updateCollectionHandler);
domAiPortalRouter.patch('/portals/:id/collections/:collectionId', updateCollectionHandler);

domAiPortalRouter.delete('/portals/:id/collections/:collectionId', async (req, res) => {
  try {
    const ctx = getTenantContext();
    if (!isUuid(req.params.collectionId)) {
      sendApiError(res, 400, 'INVALID_COLLECTION_ID', 'ID bộ sưu tập không hợp lệ.');
      return;
    }
    const deleted = await withTenantTransaction(ctx.tenantId, async (client) => {
      const p = await assertPortalExistsInTx(client, ctx.tenantId, req.params.id);
      if (!p) return null;

      const chk = await client.query(
        `SELECT id FROM dom_ai_collections WHERE tenant_id = $1 AND portal_id = $2 AND id = $3 LIMIT 1`,
        [ctx.tenantId, p.id, req.params.collectionId]
      );
      if (!chk.rows[0]) return 'NOT_FOUND' as const;

      await client.query(
        `UPDATE dom_ai_documents SET collection_id = NULL, updated_at = clock_timestamp()
         WHERE tenant_id = $1 AND portal_id = $2 AND collection_id = $3`,
        [ctx.tenantId, p.id, req.params.collectionId]
      );
      await client.query(
        `UPDATE dom_ai_chunks SET collection_id = NULL
         WHERE tenant_id = $1 AND portal_id = $2 AND collection_id = $3`,
        [ctx.tenantId, p.id, req.params.collectionId]
      );
      await client.query(`DELETE FROM dom_ai_collections WHERE tenant_id = $1 AND id = $2`, [
        ctx.tenantId,
        req.params.collectionId,
      ]);
      return true;
    });

    if (deleted === null) {
      sendApiError(res, 404, 'PORTAL_NOT_FOUND', 'Không tìm thấy cổng AI.');
      return;
    }
    if (deleted === 'NOT_FOUND') {
      sendApiError(res, 404, 'COLLECTION_NOT_FOUND', 'Không tìm thấy bộ sưu tập.');
      return;
    }
    res.json({ success: true, data: { deleted: true, id: req.params.collectionId } });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : 'Không thể xóa bộ sưu tập.';
    sendApiError(res, 500, 'COLLECTION_DELETE_FAILED', msg);
  }
});

// ============================================================================
// 8. Documents CRUD + Reindex + RAG Test (`/portals/:id/documents`, `/rag/test`)
// ============================================================================
domAiPortalRouter.get('/portals/:id/documents', async (req, res) => {
  try {
    const ctx = getTenantContext();
    const collectionId = cleanStr(req.query.collection_id, 64);
    const statusFilter = cleanStr(req.query.status, 24);
    const docType = cleanStr(req.query.doc_type, 24);
    const searchFolded = normalizeVietnameseFolded(cleanStr(req.query.search || req.query.q, 200));
    const limit = clampInt(req.query.limit, 1, 200, 100);
    const offset = clampInt(req.query.offset, 0, 10_000, 0);

    const out = await withTenantTransaction(ctx.tenantId, async (client) => {
      const p = await assertPortalExistsInTx(client, ctx.tenantId, req.params.id);
      if (!p) return null;

      const r = await client.query(
        `SELECT d.*, c.name AS collection_name
         FROM dom_ai_documents d
         LEFT JOIN dom_ai_collections c ON c.tenant_id = d.tenant_id AND c.id = d.collection_id
         WHERE d.tenant_id = $1 AND d.portal_id = $2
         ORDER BY d.updated_at DESC`,
        [ctx.tenantId, p.id]
      );

      const filtered = r.rows.filter((row) => {
        if (collectionId && String(row.collection_id || '') !== collectionId) return false;
        if (statusFilter && String(row.status) !== statusFilter) return false;
        if (docType && String(row.doc_type) !== docType) return false;
        if (searchFolded) {
          const tagsStr = parseJsonArray<string>(row.tags_json).join(' ');
          const hay = normalizeVietnameseFolded(
            `${row.title || ''} ${row.summary || ''} ${tagsStr} ${row.content || ''}`
          );
          if (!hay.includes(searchFolded)) return false;
        }
        return true;
      });

      return {
        items: filtered.slice(offset, offset + limit).map(formatDocumentRow),
        total: filtered.length,
        limit,
        offset,
      };
    });

    if (!out) {
      sendApiError(res, 404, 'PORTAL_NOT_FOUND', 'Không tìm thấy cổng AI.');
      return;
    }
    res.json({ success: true, data: out });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : 'Không thể tải danh sách tài liệu.';
    sendApiError(res, 500, 'DOCUMENTS_LIST_FAILED', msg);
  }
});

function parseTagsInput(raw: unknown): string[] {
  if (Array.isArray(raw)) {
    return Array.from(new Set(raw.map((t) => cleanStr(t, 80)).filter(Boolean))).slice(0, 30);
  }
  if (typeof raw === 'string' && raw.trim()) {
    return Array.from(
      new Set(
        raw
          .split(/[,;\n]+/)
          .map((t) => t.trim().slice(0, 80))
          .filter(Boolean)
      )
    ).slice(0, 30);
  }
  return [];
}

domAiPortalRouter.post('/portals/:id/documents', async (req, res) => {
  try {
    const ctx = getTenantContext();
    const body = (req.body && typeof req.body === 'object' ? req.body : {}) as Record<string, unknown>;
    const title = cleanStr(body.title, 300);
    if (!title) {
      sendApiError(res, 422, 'DOCUMENT_TITLE_REQUIRED', 'Vui lòng nhập tiêu đề tài liệu.');
      return;
    }

    const docType = VALID_DOC_TYPES.has(body.doc_type as DomAiDocType)
      ? (body.doc_type as DomAiDocType)
      : 'document';
    const status = VALID_DOC_STATUSES.has(body.status as DomAiDocStatus)
      ? (body.status as DomAiDocStatus)
      : 'active';
    const content = String(body.content || '').trim();
    const summary = cleanStr(body.summary, 1000) || content.replace(/\s+/g, ' ').slice(0, 220);
    const tags = parseTagsInput(body.tags);
    const relevanceBoost =
      body.relevance_boost !== undefined && Number.isFinite(Number(body.relevance_boost))
        ? Math.max(0.2, Math.min(5, Number(body.relevance_boost)))
        : 1.0;

    const created = await withTenantTransaction(ctx.tenantId, async (client) => {
      const p = await assertPortalExistsInTx(client, ctx.tenantId, req.params.id);
      if (!p) return null;

      let collectionId: string | null = null;
      if (body.collection_id && isUuid(body.collection_id)) {
        const colChk = await client.query(
          `SELECT id FROM dom_ai_collections WHERE tenant_id = $1 AND portal_id = $2 AND id = $3 LIMIT 1`,
          [ctx.tenantId, p.id, String(body.collection_id).trim()]
        );
        if (colChk.rows[0]) collectionId = String(body.collection_id).trim();
      }

      const id = crypto.randomUUID();
      await client.query(
        `INSERT INTO dom_ai_documents (
           id, tenant_id, portal_id, collection_id, title, doc_type, content, summary,
           tags_json, attachment_url, thumbnail_url, relevance_boost, chunk_count, status, created_by
         ) VALUES (
           $1, $2, $3, $4, $5, $6, $7, $8,
           $9::jsonb, $10, $11, $12, 0, $13, $14
         )`,
        [
          id,
          ctx.tenantId,
          p.id,
          collectionId,
          title,
          docType,
          content,
          summary,
          JSON.stringify(tags),
          sanitizeSafePortalUrl(body.attachment_url, 1200),
          sanitizeSafePortalUrl(body.thumbnail_url, 1200),
          relevanceBoost,
          status,
          ctx.userId,
        ]
      );

      await indexDomAiDocumentInTx(client, ctx.tenantId, id);
      await recomputeCollectionDocCountsInTx(client, ctx.tenantId, p.id);

      const reread = await client.query(
        `SELECT d.*, c.name AS collection_name
         FROM dom_ai_documents d
         LEFT JOIN dom_ai_collections c ON c.tenant_id = d.tenant_id AND c.id = d.collection_id
         WHERE d.tenant_id = $1 AND d.id = $2
         LIMIT 1`,
        [ctx.tenantId, id]
      );
      return formatDocumentRow(reread.rows[0]);
    });

    if (!created) {
      sendApiError(res, 404, 'PORTAL_NOT_FOUND', 'Không tìm thấy cổng AI.');
      return;
    }
    res.status(201).json({ success: true, data: created });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : 'Không thể tạo tài liệu tri thức.';
    sendApiError(res, 500, 'DOCUMENT_CREATE_FAILED', msg);
  }
});

const updateDocumentHandler = async (req: Request, res: Response) => {
  try {
    const ctx = getTenantContext();
    if (!isUuid(req.params.docId)) {
      sendApiError(res, 400, 'INVALID_DOCUMENT_ID', 'ID tài liệu không hợp lệ.');
      return;
    }
    const body = (req.body && typeof req.body === 'object' ? req.body : {}) as Record<string, unknown>;

    const updated = await withTenantTransaction(ctx.tenantId, async (client) => {
      const p = await assertPortalExistsInTx(client, ctx.tenantId, req.params.id);
      if (!p) return null;

      const curRes = await client.query(
        `SELECT * FROM dom_ai_documents WHERE tenant_id = $1 AND portal_id = $2 AND id = $3 LIMIT 1`,
        [ctx.tenantId, p.id, req.params.docId]
      );
      const cur = curRes.rows[0];
      if (!cur) return 'NOT_FOUND' as const;

      let nextColId: string | null = cur.collection_id ? String(cur.collection_id) : null;
      if (body.collection_id !== undefined) {
        if (body.collection_id === null || body.collection_id === '') {
          nextColId = null;
        } else if (isUuid(body.collection_id)) {
          const colChk = await client.query(
            `SELECT id FROM dom_ai_collections WHERE tenant_id = $1 AND portal_id = $2 AND id = $3 LIMIT 1`,
            [ctx.tenantId, p.id, String(body.collection_id).trim()]
          );
          if (colChk.rows[0]) nextColId = String(body.collection_id).trim();
        }
      }

      const nextContent = body.content !== undefined ? String(body.content || '').trim() : String(cur.content || '');
      const nextTags = body.tags !== undefined ? parseTagsInput(body.tags) : parseJsonArray<string>(cur.tags_json);
      const nextBoost =
        body.relevance_boost !== undefined && Number.isFinite(Number(body.relevance_boost))
          ? Math.max(0.2, Math.min(5, Number(body.relevance_boost)))
          : Number(cur.relevance_boost ?? 1.0);
      const nextDocType =
        body.doc_type !== undefined && VALID_DOC_TYPES.has(body.doc_type as DomAiDocType)
          ? (body.doc_type as DomAiDocType)
          : String(cur.doc_type);
      const nextStatus =
        body.status !== undefined && VALID_DOC_STATUSES.has(body.status as DomAiDocStatus)
          ? (body.status as DomAiDocStatus)
          : String(cur.status);

      await client.query(
        `UPDATE dom_ai_documents
         SET collection_id = $3,
             title = $4,
             doc_type = $5,
             content = $6,
             summary = $7,
             tags_json = $8::jsonb,
             attachment_url = $9,
             thumbnail_url = $10,
             relevance_boost = $11,
             status = $12,
             updated_at = clock_timestamp()
         WHERE tenant_id = $1 AND id = $2`,
        [
          ctx.tenantId,
          cur.id,
          nextColId,
          body.title !== undefined ? cleanStr(body.title, 300) || cur.title : cur.title,
          nextDocType,
          nextContent,
          body.summary !== undefined ? cleanStr(body.summary, 1000) : cur.summary,
          JSON.stringify(nextTags),
          body.attachment_url !== undefined ? sanitizeSafePortalUrl(body.attachment_url, 1200) : cur.attachment_url,
          body.thumbnail_url !== undefined ? sanitizeSafePortalUrl(body.thumbnail_url, 1200) : cur.thumbnail_url,
          nextBoost,
          nextStatus,
        ]
      );

      await indexDomAiDocumentInTx(client, ctx.tenantId, cur.id);
      await recomputeCollectionDocCountsInTx(client, ctx.tenantId, p.id);

      const reread = await client.query(
        `SELECT d.*, c.name AS collection_name
         FROM dom_ai_documents d
         LEFT JOIN dom_ai_collections c ON c.tenant_id = d.tenant_id AND c.id = d.collection_id
         WHERE d.tenant_id = $1 AND d.id = $2
         LIMIT 1`,
        [ctx.tenantId, cur.id]
      );
      return formatDocumentRow(reread.rows[0]);
    });

    if (updated === null) {
      sendApiError(res, 404, 'PORTAL_NOT_FOUND', 'Không tìm thấy cổng AI.');
      return;
    }
    if (updated === 'NOT_FOUND') {
      sendApiError(res, 404, 'DOCUMENT_NOT_FOUND', 'Không tìm thấy tài liệu.');
      return;
    }
    res.json({ success: true, data: updated });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : 'Không thể cập nhật tài liệu.';
    sendApiError(res, 500, 'DOCUMENT_UPDATE_FAILED', msg);
  }
};
domAiPortalRouter.put('/portals/:id/documents/:docId', updateDocumentHandler);
domAiPortalRouter.patch('/portals/:id/documents/:docId', updateDocumentHandler);

domAiPortalRouter.delete('/portals/:id/documents/:docId', async (req, res) => {
  try {
    const ctx = getTenantContext();
    if (!isUuid(req.params.docId)) {
      sendApiError(res, 400, 'INVALID_DOCUMENT_ID', 'ID tài liệu không hợp lệ.');
      return;
    }
    const deleted = await withTenantTransaction(ctx.tenantId, async (client) => {
      const p = await assertPortalExistsInTx(client, ctx.tenantId, req.params.id);
      if (!p) return null;
      const chk = await client.query(
        `SELECT id FROM dom_ai_documents WHERE tenant_id = $1 AND portal_id = $2 AND id = $3 LIMIT 1`,
        [ctx.tenantId, p.id, req.params.docId]
      );
      if (!chk.rows[0]) return 'NOT_FOUND' as const;

      await client.query(`DELETE FROM dom_ai_documents WHERE tenant_id = $1 AND id = $2`, [
        ctx.tenantId,
        req.params.docId,
      ]);
      await recomputeCollectionDocCountsInTx(client, ctx.tenantId, p.id);
      return true;
    });

    if (deleted === null) {
      sendApiError(res, 404, 'PORTAL_NOT_FOUND', 'Không tìm thấy cổng AI.');
      return;
    }
    if (deleted === 'NOT_FOUND') {
      sendApiError(res, 404, 'DOCUMENT_NOT_FOUND', 'Không tìm thấy tài liệu.');
      return;
    }
    res.json({ success: true, data: { deleted: true, id: req.params.docId } });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : 'Không thể xóa tài liệu.';
    sendApiError(res, 500, 'DOCUMENT_DELETE_FAILED', msg);
  }
});

// POST /portals/:id/documents/reindex
domAiPortalRouter.post('/portals/:id/documents/reindex', async (req, res) => {
  try {
    const ctx = getTenantContext();
    const body = (req.body && typeof req.body === 'object' ? req.body : {}) as Record<string, unknown>;
    const singleDocId = body.document_id && isUuid(body.document_id) ? String(body.document_id).trim() : null;

    const outcome = await withTenantTransaction(ctx.tenantId, async (client) => {
      const p = await assertPortalExistsInTx(client, ctx.tenantId, req.params.id);
      if (!p) return null;

      if (singleDocId) {
        const resSingle = await indexDomAiDocumentInTx(client, ctx.tenantId, singleDocId);
        await recomputeCollectionDocCountsInTx(client, ctx.tenantId, p.id);
        return { documents_indexed: 1, total_chunks: resSingle.chunk_count, document_id: singleDocId };
      }
      return reindexPortalDocumentsInTx(client, ctx.tenantId, p.id);
    });

    if (!outcome) {
      sendApiError(res, 404, 'PORTAL_NOT_FOUND', 'Không tìm thấy cổng AI.');
      return;
    }
    res.json({ success: true, data: outcome });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : 'Không thể tái lập chỉ mục RAG.';
    sendApiError(res, 500, 'DOCUMENTS_REINDEX_FAILED', msg);
  }
});

// POST /portals/:id/rag/test — Test RAG retrieval & scoring in Admin Playground
domAiPortalRouter.post('/portals/:id/rag/test', async (req, res) => {
  try {
    const ctx = getTenantContext();
    const body = (req.body && typeof req.body === 'object' ? req.body : {}) as Record<string, unknown>;
    const query = cleanStr(body.query || body.message, 1000);
    if (!query) {
      sendApiError(res, 422, 'QUERY_REQUIRED', 'Vui lòng nhập câu hỏi cần kiểm thử RAG.');
      return;
    }

    const startedAt = Date.now();
    const out = await withTenantTransaction(ctx.tenantId, async (client) => {
      const p = await assertPortalExistsInTx(client, ctx.tenantId, req.params.id);
      if (!p) return null;

      const allowedCols = Array.isArray(body.allowed_collection_ids)
        ? body.allowed_collection_ids.map((x) => String(x || '').trim()).filter(Boolean)
        : null;
      const collectionFilterId =
        body.collection_id && isUuid(body.collection_id) ? String(body.collection_id).trim() : null;

      const rag = await searchDomAiKnowledgeInTx(client, ctx.tenantId, {
        portalId: p.id,
        query,
        topK: clampInt(body.top_k, 1, 20, Number(p.top_k || 6)),
        collectionFilterId,
        allowedCollectionIds: allowedCols,
        includePrivateCollections: allowedCols === null,
      });

      const previewAnswer =
        body.simulate_answer !== false
          ? buildDeterministicRagReply({
              portalName: p.name,
              query,
              citations: rag.citations,
              filteredByAcl: rag.filtered_by_acl,
              starterPrompts: parseJsonArray<string>(p.starter_prompts_json),
            })
          : undefined;

      return {
        ...rag,
        latency_ms: Math.max(1, Date.now() - startedAt),
        preview_answer: previewAnswer,
      };
    });

    if (!out) {
      sendApiError(res, 404, 'PORTAL_NOT_FOUND', 'Không tìm thấy cổng AI.');
      return;
    }
    res.json({ success: true, data: out });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : 'Không thể kiểm thử RAG.';
    sendApiError(res, 500, 'RAG_TEST_FAILED', msg);
  }
});

// ============================================================================
// 9. Portal Viewers / Whitelist Users CRUD + Bulk CSV Import (`/portals/:id/users`)
// ============================================================================
domAiPortalRouter.get('/portals/:id/users', async (req, res) => {
  try {
    const ctx = getTenantContext();
    const statusFilter = cleanStr(req.query.status, 24);
    const roleFilter = cleanStr(req.query.role, 24);
    const searchFolded = normalizeVietnameseFolded(cleanStr(req.query.search || req.query.q, 160));

    const items = await withTenantTransaction(ctx.tenantId, async (client) => {
      const p = await assertPortalExistsInTx(client, ctx.tenantId, req.params.id);
      if (!p) return null;

      const r = await client.query(
        `SELECT * FROM dom_ai_portal_users
         WHERE tenant_id = $1 AND portal_id = $2
         ORDER BY created_at DESC`,
        [ctx.tenantId, p.id]
      );
      return r.rows
        .filter((u) => {
          if (statusFilter && String(u.status) !== statusFilter) return false;
          if (roleFilter && String(u.role) !== roleFilter) return false;
          if (searchFolded) {
            const hay = normalizeVietnameseFolded(
              `${u.email || ''} ${u.full_name || ''} ${u.department || ''}`
            );
            if (!hay.includes(searchFolded)) return false;
          }
          return true;
        })
        .map(formatPortalUserRow);
    });

    if (items === null) {
      sendApiError(res, 404, 'PORTAL_NOT_FOUND', 'Không tìm thấy cổng AI.');
      return;
    }
    res.json({ success: true, data: items });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : 'Không thể tải danh sách người dùng cổng AI.';
    sendApiError(res, 500, 'PORTAL_USERS_LIST_FAILED', msg);
  }
});

interface ViewerUpsertDraft {
  email: string;
  full_name?: string;
  role?: 'admin' | 'viewer';
  department?: string;
  allowed_collection_ids?: string[];
  access_code?: string | null;
  status?: 'active' | 'suspended';
}

function parseBulkViewersCsv(csvText: string, defaultAllowedCollections: string[]): ViewerUpsertDraft[] {
  const lines = String(csvText || '')
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  const out: ViewerUpsertDraft[] = [];

  for (const line of lines) {
    // Skip header line if detected
    if (/^email[\s,;\t]/i.test(line) || line.toLowerCase() === 'email') continue;
    const cols = line.split(/[,;\t]+/).map((c) => c.trim().replace(/^["']|["']$/g, ''));
    const email = (cols[0] || '').toLowerCase();
    if (!EMAIL_REGEX.test(email)) continue;
    out.push({
      email,
      full_name: cols[1] || email.split('@')[0],
      department: cols[2] || '',
      access_code: cols[3] || null,
      role: 'viewer',
      status: 'active',
      allowed_collection_ids: defaultAllowedCollections,
    });
  }
  return out;
}

const createOrBulkUsersHandler = async (req: Request, res: Response) => {
  try {
    const ctx = getTenantContext();
    const body = (req.body && typeof req.body === 'object' ? req.body : {}) as Record<string, unknown>;

    const defaultCols = Array.isArray(body.allowed_collection_ids)
      ? body.allowed_collection_ids.map((x) => String(x || '').trim()).filter(isUuid)
      : [];

    const isBulk = Array.isArray(body.users) || typeof body.csv_text === 'string';
    const drafts: ViewerUpsertDraft[] = [];

    if (Array.isArray(body.users)) {
      for (const raw of body.users) {
        if (!raw || typeof raw !== 'object') continue;
        const u = raw as Record<string, unknown>;
        const email = String(u.email || '').trim().toLowerCase();
        if (!EMAIL_REGEX.test(email)) continue;
        drafts.push({
          email,
          full_name: cleanStr(u.full_name || u.name, 200) || email.split('@')[0],
          role: u.role === 'admin' ? 'admin' : 'viewer',
          department: cleanStr(u.department, 150),
          allowed_collection_ids: Array.isArray(u.allowed_collection_ids)
            ? u.allowed_collection_ids.map((x) => String(x || '').trim()).filter(isUuid)
            : defaultCols,
          access_code: u.access_code ? cleanStr(u.access_code, 100) : null,
          status: u.status === 'suspended' ? 'suspended' : 'active',
        });
      }
    }
    if (typeof body.csv_text === 'string' && body.csv_text.trim()) {
      drafts.push(...parseBulkViewersCsv(body.csv_text, defaultCols));
    }

    if (!isBulk) {
      const email = String(body.email || '').trim().toLowerCase();
      if (!EMAIL_REGEX.test(email)) {
        sendApiError(res, 422, 'INVALID_EMAIL', 'Vui lòng nhập địa chỉ email hợp lệ.');
        return;
      }
      drafts.push({
        email,
        full_name: cleanStr(body.full_name || body.name, 200) || email.split('@')[0],
        role: body.role === 'admin' ? 'admin' : 'viewer',
        department: cleanStr(body.department, 150),
        allowed_collection_ids: defaultCols,
        access_code: body.access_code ? cleanStr(body.access_code, 100) : null,
        status: body.status === 'suspended' ? 'suspended' : 'active',
      });
    }

    if (drafts.length === 0) {
      sendApiError(res, 422, 'NO_VALID_USERS', 'Không có địa chỉ email hợp lệ nào để thêm.');
      return;
    }

    const result = await withTenantTransaction(ctx.tenantId, async (client) => {
      const p = await assertPortalExistsInTx(client, ctx.tenantId, req.params.id);
      if (!p) return null;

      let imported = 0;
      let updated = 0;
      const items: Record<string, unknown>[] = [];

      for (const draft of drafts) {
        const existingRes = await client.query(
          `SELECT * FROM dom_ai_portal_users
           WHERE tenant_id = $1 AND portal_id = $2 AND LOWER(email) = LOWER($3)
           LIMIT 1`,
          [ctx.tenantId, p.id, draft.email]
        );
        if (existingRes.rows[0]) {
          const ex = existingRes.rows[0];
          await client.query(
            `UPDATE dom_ai_portal_users
             SET full_name = $3,
                 role = $4,
                 department = $5,
                 allowed_collection_ids_json = $6::jsonb,
                 access_code = $7,
                 status = $8,
                 updated_at = clock_timestamp()
             WHERE tenant_id = $1 AND id = $2`,
            [
              ctx.tenantId,
              ex.id,
              draft.full_name || ex.full_name,
              draft.role || ex.role,
              draft.department !== undefined ? draft.department : ex.department,
              JSON.stringify(draft.allowed_collection_ids || []),
              draft.access_code !== undefined ? draft.access_code : ex.access_code,
              draft.status || ex.status,
            ]
          );
          const reread = await client.query(
            `SELECT * FROM dom_ai_portal_users WHERE tenant_id = $1 AND id = $2 LIMIT 1`,
            [ctx.tenantId, ex.id]
          );
          updated++;
          items.push(formatPortalUserRow(reread.rows[0]));
        } else {
          const id = crypto.randomUUID();
          await client.query(
            `INSERT INTO dom_ai_portal_users (
               id, tenant_id, portal_id, email, full_name, role, department,
               allowed_collection_ids_json, access_code, status, message_count
             ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9, $10, 0)`,
            [
              id,
              ctx.tenantId,
              p.id,
              draft.email,
              draft.full_name || draft.email.split('@')[0],
              draft.role || 'viewer',
              draft.department || '',
              JSON.stringify(draft.allowed_collection_ids || []),
              draft.access_code ?? null,
              draft.status || 'active',
            ]
          );
          const reread = await client.query(
            `SELECT * FROM dom_ai_portal_users WHERE tenant_id = $1 AND id = $2 LIMIT 1`,
            [ctx.tenantId, id]
          );
          imported++;
          items.push(formatPortalUserRow(reread.rows[0]));
        }
      }

      return isBulk ? { imported, updated, total: items.length, items } : items[0];
    });

    if (!result) {
      sendApiError(res, 404, 'PORTAL_NOT_FOUND', 'Không tìm thấy cổng AI.');
      return;
    }
    res.status(201).json({ success: true, data: result });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : 'Không thể thêm người dùng cổng AI.';
    sendApiError(res, 500, 'PORTAL_USER_CREATE_FAILED', msg);
  }
};
domAiPortalRouter.post('/portals/:id/users', createOrBulkUsersHandler);
domAiPortalRouter.post('/portals/:id/users/bulk', createOrBulkUsersHandler);

const updatePortalUserHandler = async (req: Request, res: Response) => {
  try {
    const ctx = getTenantContext();
    if (!isUuid(req.params.userId)) {
      sendApiError(res, 400, 'INVALID_USER_ID', 'ID người dùng không hợp lệ.');
      return;
    }
    const body = (req.body && typeof req.body === 'object' ? req.body : {}) as Record<string, unknown>;

    const updated = await withTenantTransaction(ctx.tenantId, async (client) => {
      const p = await assertPortalExistsInTx(client, ctx.tenantId, req.params.id);
      if (!p) return null;

      const curRes = await client.query(
        `SELECT * FROM dom_ai_portal_users WHERE tenant_id = $1 AND portal_id = $2 AND id = $3 LIMIT 1`,
        [ctx.tenantId, p.id, req.params.userId]
      );
      const cur = curRes.rows[0];
      if (!cur) return 'NOT_FOUND' as const;

      const nextCols = Array.isArray(body.allowed_collection_ids)
        ? body.allowed_collection_ids.map((x) => String(x || '').trim()).filter(isUuid)
        : parseJsonArray<string>(cur.allowed_collection_ids_json);

      await client.query(
        `UPDATE dom_ai_portal_users
         SET full_name = $3,
             role = $4,
             department = $5,
             allowed_collection_ids_json = $6::jsonb,
             access_code = $7,
             status = $8,
             updated_at = clock_timestamp()
         WHERE tenant_id = $1 AND id = $2`,
        [
          ctx.tenantId,
          cur.id,
          body.full_name !== undefined ? cleanStr(body.full_name, 200) : cur.full_name,
          body.role === 'admin' || body.role === 'viewer' ? body.role : cur.role,
          body.department !== undefined ? cleanStr(body.department, 150) : cur.department,
          JSON.stringify(nextCols),
          body.access_code !== undefined
            ? body.access_code
              ? cleanStr(body.access_code, 100)
              : null
            : cur.access_code,
          body.status === 'active' || body.status === 'suspended' ? body.status : cur.status,
        ]
      );
      const reread = await client.query(
        `SELECT * FROM dom_ai_portal_users WHERE tenant_id = $1 AND id = $2 LIMIT 1`,
        [ctx.tenantId, cur.id]
      );
      return formatPortalUserRow(reread.rows[0]);
    });

    if (updated === null) {
      sendApiError(res, 404, 'PORTAL_NOT_FOUND', 'Không tìm thấy cổng AI.');
      return;
    }
    if (updated === 'NOT_FOUND') {
      sendApiError(res, 404, 'PORTAL_USER_NOT_FOUND', 'Không tìm thấy tài khoản người dùng.');
      return;
    }
    res.json({ success: true, data: updated });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : 'Không thể cập nhật tài khoản người dùng.';
    sendApiError(res, 500, 'PORTAL_USER_UPDATE_FAILED', msg);
  }
};
domAiPortalRouter.put('/portals/:id/users/:userId', updatePortalUserHandler);
domAiPortalRouter.patch('/portals/:id/users/:userId', updatePortalUserHandler);

domAiPortalRouter.delete('/portals/:id/users/:userId', async (req, res) => {
  try {
    const ctx = getTenantContext();
    if (!isUuid(req.params.userId)) {
      sendApiError(res, 400, 'INVALID_USER_ID', 'ID người dùng không hợp lệ.');
      return;
    }
    const deleted = await withTenantTransaction(ctx.tenantId, async (client) => {
      const p = await assertPortalExistsInTx(client, ctx.tenantId, req.params.id);
      if (!p) return null;
      const chk = await client.query(
        `SELECT id FROM dom_ai_portal_users WHERE tenant_id = $1 AND portal_id = $2 AND id = $3 LIMIT 1`,
        [ctx.tenantId, p.id, req.params.userId]
      );
      if (!chk.rows[0]) return 'NOT_FOUND' as const;
      await client.query(`DELETE FROM dom_ai_portal_users WHERE tenant_id = $1 AND id = $2`, [
        ctx.tenantId,
        req.params.userId,
      ]);
      return true;
    });

    if (deleted === null) {
      sendApiError(res, 404, 'PORTAL_NOT_FOUND', 'Không tìm thấy cổng AI.');
      return;
    }
    if (deleted === 'NOT_FOUND') {
      sendApiError(res, 404, 'PORTAL_USER_NOT_FOUND', 'Không tìm thấy tài khoản người dùng.');
      return;
    }
    res.json({ success: true, data: { deleted: true, id: req.params.userId } });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : 'Không thể xóa người dùng.';
    sendApiError(res, 500, 'PORTAL_USER_DELETE_FAILED', msg);
  }
});

// ============================================================================
// 10. Conversation Logs Audit & 1-Click Promote to Q&A (`/portals/:id/logs`)
// ============================================================================
domAiPortalRouter.get('/portals/:id/logs', async (req, res) => {
  try {
    const ctx = getTenantContext();
    const searchFolded = normalizeVietnameseFolded(cleanStr(req.query.search || req.query.q, 200));
    const userEmailFilter = cleanStr(req.query.user_email || req.query.user, 200).toLowerCase();
    const feedbackFilter = cleanStr(req.query.feedback, 24).toLowerCase();
    const convFilter = cleanStr(req.query.conversation_id, 64);
    const page = clampInt(req.query.page, 1, 1000, 1);
    const limit = clampInt(req.query.limit, 1, 100, 20);

    const payload = await withTenantTransaction(ctx.tenantId, async (client) => {
      const p = await assertPortalExistsInTx(client, ctx.tenantId, req.params.id);
      if (!p) return null;

      const [convsRes, msgsRes] = await Promise.all([
        client.query<{
          id: string;
          user_email: string;
          user_name: string;
          title: string;
        }>(
          `SELECT id, user_email, user_name, title
           FROM dom_ai_conversations
           WHERE tenant_id = $1 AND portal_id = $2`,
          [ctx.tenantId, p.id]
        ),
        client.query<{
          id: string;
          conversation_id: string;
          role: string;
          content: string;
          citations_json: unknown;
          model: string;
          latency_ms: number;
          tokens_used: number;
          feedback: string | null;
          feedback_note: string | null;
          created_at: string | Date;
        }>(
          `SELECT id, conversation_id, role, content, citations_json, model, latency_ms,
                  tokens_used, feedback, feedback_note, created_at
           FROM dom_ai_messages
           WHERE tenant_id = $1 AND portal_id = $2
           ORDER BY conversation_id ASC, created_at ASC`,
          [ctx.tenantId, p.id]
        ),
      ]);

      const convMap = new Map<string, { user_email: string; user_name: string; title: string }>();
      for (const c of convsRes.rows) {
        convMap.set(String(c.id), {
          user_email: String(c.user_email || ''),
          user_name: String(c.user_name || ''),
          title: String(c.title || ''),
        });
      }

      const lastUserMsgByConv = new Map<string, { id: string; content: string }>();
      const turns: Array<Record<string, unknown>> = [];

      for (const m of msgsRes.rows) {
        const cid = String(m.conversation_id);
        if (m.role === 'user') {
          lastUserMsgByConv.set(cid, { id: String(m.id), content: String(m.content || '') });
          continue;
        }
        if (m.role === 'assistant') {
          const conv = convMap.get(cid);
          const q = lastUserMsgByConv.get(cid);
          const citations = parseJsonArray<DomAiCitation>(m.citations_json);

          turns.push({
            message_id: String(m.id),
            user_message_id: q?.id || null,
            conversation_id: cid,
            conversation_title: conv?.title || '',
            user_email: conv?.user_email || '',
            user_name: conv?.user_name || '',
            question: q?.content || conv?.title || '',
            answer: String(m.content || ''),
            citations,
            citation_count: citations.length,
            model: String(m.model || ''),
            latency_ms: Number(m.latency_ms ?? 0),
            tokens_used: Number(m.tokens_used ?? 0),
            feedback: m.feedback || null,
            feedback_note: m.feedback_note || null,
            created_at: m.created_at,
          });
        }
      }

      const filtered = turns
        .filter((t) => {
          if (convFilter && String(t.conversation_id) !== convFilter) return false;
          if (userEmailFilter && !String(t.user_email).toLowerCase().includes(userEmailFilter)) {
            return false;
          }
          if (feedbackFilter === 'up' && t.feedback !== 'up') return false;
          if (feedbackFilter === 'down' && t.feedback !== 'down') return false;
          if (feedbackFilter === 'none' && t.feedback !== null) return false;
          if (feedbackFilter === 'unanswered' && Number(t.citation_count) > 0) return false;
          if (searchFolded) {
            const hay = normalizeVietnameseFolded(
              `${t.question || ''} ${t.answer || ''} ${t.user_email || ''} ${t.user_name || ''}`
            );
            if (!hay.includes(searchFolded)) return false;
          }
          return true;
        })
        .sort(
          (a, b) => new Date(String(b.created_at)).getTime() - new Date(String(a.created_at)).getTime()
        );

      const total = filtered.length;
      const offset = (page - 1) * limit;
      return {
        items: filtered.slice(offset, offset + limit),
        pagination: {
          page,
          limit,
          total,
          total_pages: Math.max(1, Math.ceil(total / limit)),
        },
      };
    });

    if (!payload) {
      sendApiError(res, 404, 'PORTAL_NOT_FOUND', 'Không tìm thấy cổng AI.');
      return;
    }
    res.json({ success: true, data: payload });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : 'Không thể tải nhật ký hội thoại.';
    sendApiError(res, 500, 'PORTAL_LOGS_FAILED', msg);
  }
});

// POST /portals/:id/logs/:msgId/promote-qa — 1-click promote logged turn into Q&A training doc & re-index
domAiPortalRouter.post('/portals/:id/logs/:msgId/promote-qa', async (req, res) => {
  try {
    const ctx = getTenantContext();
    if (!isUuid(req.params.msgId)) {
      sendApiError(res, 400, 'INVALID_MESSAGE_ID', 'ID tin nhắn không hợp lệ.');
      return;
    }
    const body = (req.body && typeof req.body === 'object' ? req.body : {}) as Record<string, unknown>;

    const promoted = await withTenantTransaction(ctx.tenantId, async (client) => {
      const p = await assertPortalExistsInTx(client, ctx.tenantId, req.params.id);
      if (!p) return null;

      const targetRes = await client.query<{
        id: string;
        conversation_id: string;
        role: string;
        content: string;
        created_at: string | Date;
      }>(
        `SELECT id, conversation_id, role, content, created_at
         FROM dom_ai_messages
         WHERE tenant_id = $1 AND portal_id = $2 AND id = $3
         LIMIT 1`,
        [ctx.tenantId, p.id, req.params.msgId]
      );
      const target = targetRes.rows[0];
      if (!target) return 'NOT_FOUND' as const;

      const convMsgs = await client.query<{
        id: string;
        role: string;
        content: string;
        created_at: string | Date;
      }>(
        `SELECT id, role, content, created_at
         FROM dom_ai_messages
         WHERE tenant_id = $1 AND portal_id = $2 AND conversation_id = $3
         ORDER BY created_at ASC`,
        [ctx.tenantId, p.id, target.conversation_id]
      );

      const idx = convMsgs.rows.findIndex((m) => String(m.id) === String(target.id));
      let inferredQuestion = '';
      let inferredAnswer = '';

      if (target.role === 'assistant') {
        inferredAnswer = String(target.content || '');
        for (let i = idx - 1; i >= 0; i--) {
          if (convMsgs.rows[i].role === 'user') {
            inferredQuestion = String(convMsgs.rows[i].content || '');
            break;
          }
        }
      } else {
        inferredQuestion = String(target.content || '');
        for (let i = idx + 1; i < convMsgs.rows.length; i++) {
          if (convMsgs.rows[i].role === 'assistant') {
            inferredAnswer = String(convMsgs.rows[i].content || '');
            break;
          }
        }
      }

      const finalQuestion = cleanStr(body.question, 1000) || inferredQuestion;
      const finalAnswer = String(body.answer ?? inferredAnswer).trim();
      if (!finalQuestion || !finalAnswer) {
        return 'MISSING_QA_CONTENT' as const;
      }

      const title =
        cleanStr(body.title, 300) ||
        `Q&A: ${finalQuestion.length > 120 ? `${finalQuestion.slice(0, 117)}...` : finalQuestion}`;

      let collectionId: string | null = null;
      if (body.collection_id && isUuid(body.collection_id)) {
        const colChk = await client.query(
          `SELECT id FROM dom_ai_collections WHERE tenant_id = $1 AND portal_id = $2 AND id = $3 LIMIT 1`,
          [ctx.tenantId, p.id, String(body.collection_id).trim()]
        );
        if (colChk.rows[0]) collectionId = String(body.collection_id).trim();
      }

      const qaContent = `### Câu hỏi thường gặp (Q&A)\n**Câu hỏi:** ${finalQuestion}\n\n**Câu trả lời chuẩn:**\n${finalAnswer}`;
      const tags = parseTagsInput(body.tags);
      if (!tags.includes('qa')) tags.push('qa');
      const relevanceBoost =
        body.relevance_boost !== undefined && Number.isFinite(Number(body.relevance_boost))
          ? Math.max(0.5, Math.min(5, Number(body.relevance_boost)))
          : 1.25;

      const docId = crypto.randomUUID();
      await client.query(
        `INSERT INTO dom_ai_documents (
           id, tenant_id, portal_id, collection_id, title, doc_type, content, summary,
           tags_json, attachment_url, thumbnail_url, relevance_boost, chunk_count, status, created_by
         ) VALUES (
           $1, $2, $3, $4, $5, 'qa', $6, $7,
           $8::jsonb, '', '', $9, 0, 'active', $10
         )`,
        [
          docId,
          ctx.tenantId,
          p.id,
          collectionId,
          title,
          qaContent,
          finalQuestion.slice(0, 260),
          JSON.stringify(tags),
          relevanceBoost,
          ctx.userId,
        ]
      );

      const indexed = await indexDomAiDocumentInTx(client, ctx.tenantId, docId);
      await recomputeCollectionDocCountsInTx(client, ctx.tenantId, p.id);

      const docRes = await client.query(
        `SELECT d.*, c.name AS collection_name
         FROM dom_ai_documents d
         LEFT JOIN dom_ai_collections c ON c.tenant_id = d.tenant_id AND c.id = d.collection_id
         WHERE d.tenant_id = $1 AND d.id = $2
         LIMIT 1`,
        [ctx.tenantId, docId]
      );

      return {
        document: formatDocumentRow(docRes.rows[0]),
        chunks_indexed: indexed.chunk_count,
        promoted_from_message_id: target.id,
      };
    });

    if (promoted === null) {
      sendApiError(res, 404, 'PORTAL_NOT_FOUND', 'Không tìm thấy cổng AI.');
      return;
    }
    if (promoted === 'NOT_FOUND') {
      sendApiError(res, 404, 'MESSAGE_NOT_FOUND', 'Không tìm thấy bản ghi hội thoại cần huấn luyện.');
      return;
    }
    if (promoted === 'MISSING_QA_CONTENT') {
      sendApiError(res, 422, 'MISSING_QA_CONTENT', 'Vui lòng cung cấp đầy đủ nội dung câu hỏi và câu trả lời chuẩn.');
      return;
    }

    res.status(201).json({ success: true, data: promoted });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : 'Không thể chuyển đổi hội thoại thành tài liệu Q&A.';
    sendApiError(res, 500, 'PROMOTE_QA_FAILED', msg);
  }
});

// ============================================================================
// 11. Gemini BYOK Encrypted Vault Config & Connectivity Test
// ============================================================================
domAiPortalRouter.put('/portals/:id/api-key', async (req, res) => {
  try {
    const ctx = getTenantContext();
    const body = (req.body && typeof req.body === 'object' ? req.body : {}) as Record<string, unknown>;
    const apiKey = cleanStr(body.api_key || body.gemini_api_key, 300);
    if (!apiKey || apiKey.length < 10) {
      sendApiError(res, 422, 'INVALID_GEMINI_API_KEY', 'Vui lòng cung cấp Google Gemini API Key hợp lệ.');
      return;
    }

    const saved = await withTenantTransaction(ctx.tenantId, async (client) => {
      const p = await assertPortalExistsInTx(client, ctx.tenantId, req.params.id);
      if (!p) return null;
      return savePortalGeminiByokInTx(client, ctx.tenantId, p.id, {
        api_key: apiKey,
        model: body.model ? cleanStr(body.model, 80) : undefined,
        sync_tenant_vault: body.sync_tenant_vault !== false,
      });
    });

    if (!saved) {
      sendApiError(res, 404, 'PORTAL_NOT_FOUND', 'Không tìm thấy cổng AI.');
      return;
    }
    res.json({
      success: true,
      data: {
        ...saved,
        is_free_byok: true,
      },
    });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : 'Không thể lưu khóa Gemini BYOK vào Vault.';
    sendApiError(res, 500, 'PORTAL_API_KEY_SAVE_FAILED', msg);
  }
});

domAiPortalRouter.post('/portals/:id/api-key/test', async (req, res) => {
  try {
    const ctx = getTenantContext();
    const body = (req.body && typeof req.body === 'object' ? req.body : {}) as Record<string, unknown>;

    const resolved = await withTenantTransaction(ctx.tenantId, async (client) => {
      const p = await assertPortalExistsInTx(client, ctx.tenantId, req.params.id);
      if (!p) return null;

      const inlineKey = cleanStr(body.api_key || body.gemini_api_key, 300);
      if (inlineKey && !inlineKey.includes('••••') && !inlineKey.includes('***')) {
        return {
          apiKey: inlineKey,
          model: cleanStr(body.model, 80) || p.model || DEFAULT_PORTAL_MODEL,
        };
      }
      const vault = await resolvePortalGeminiByokInTx(client, ctx.tenantId, p.metadata_json);
      return {
        apiKey: vault.apiKey || '',
        model: cleanStr(body.model, 80) || vault.modelOverride || p.model || DEFAULT_PORTAL_MODEL,
      };
    });

    if (!resolved) {
      sendApiError(res, 404, 'PORTAL_NOT_FOUND', 'Không tìm thấy cổng AI.');
      return;
    }
    if (!resolved.apiKey) {
      sendApiError(res, 422, 'API_KEY_NOT_CONFIGURED', 'Chưa cấu hình Gemini BYOK API Key cho cổng AI này.');
      return;
    }

    const testOut = await testPortalGeminiKey(resolved.apiKey, resolved.model);
    res.status(testOut.ok ? 200 : 400).json({
      success: testOut.ok,
      data: testOut,
      ...(testOut.ok ? {} : { error: { code: 'GEMINI_TEST_FAILED', message: testOut.message } }),
    });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : 'Không thể kiểm thử kết nối Gemini BYOK.';
    sendApiError(res, 500, 'PORTAL_API_KEY_TEST_FAILED', msg);
  }
});
