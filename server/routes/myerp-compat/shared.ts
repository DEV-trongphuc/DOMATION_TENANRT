/**
 * MYERP Compatibility Layer — shared primitives.
 *
 * The cloned MYERP frontend (DOMATION_LANDINGPAGE/src/components/autodata/cloned) talks to
 * `/api/v1/myerp/<resource>` with the original MYERP PHP contract:
 *   success → `{ success: true, data: <payload>, message: '' }`
 *   lists   → `data: { items, total, page, limit }`
 *   errors  → `{ success: false, data: null, message, error: { code, message } }`
 *
 * Every compat sub-router builds on these helpers so that:
 *   - tenant isolation always runs inside `withTenantTransaction` (PostgreSQL RLS),
 *   - authorisation is always `requirePermission(...)` (never role hardcodes),
 *   - phone/email masking always goes through `pii-masker` (`shouldMaskPiiForActor` + `maskPhoneString`).
 */
import type { NextFunction, Request, RequestHandler, Response } from 'express';
import type { DbClient } from '../../core/database/db-adapter.ts';
import { withTenantTransaction } from '../../core/database/transaction.ts';
import { getTenantContext, type TenantContext } from '../../core/context/tenant-context.ts';
import {
  requirePermission,
  requireAnyPermission,
  requireTenantAuth,
  resolveUserEffectivePermissions,
  type GranularAction,
  type ResolvedUserRbacResult,
} from '../../core/security/rbac.ts';
import {
  maskEmailString,
  maskPhoneString,
  shouldMaskPiiForActor,
  type PiiMaskOptions,
} from '../../core/security/pii-masker.ts';
import { getTenantSettingsCached } from '../../core/settings/tenant-cache.ts';

export { requirePermission, requireAnyPermission, withTenantTransaction, getTenantContext };
export type { DbClient, TenantContext, GranularAction };

/** `authenticate` = JWT + tenant isolation middleware (alias of `requireTenantAuth`). */
export const authenticate: RequestHandler = requireTenantAuth as unknown as RequestHandler;

// ----------------------------------------------------------------------------
// Response envelopes (MYERP contract)
// ----------------------------------------------------------------------------
export function ok(res: Response, data: unknown = null, message = '', status = 200): void {
  res.status(status).json({ success: true, data, message });
}

export function fail(res: Response, status: number, code: string, message: string): void {
  res.status(status).json({
    success: false,
    data: null,
    message,
    error: { code, message, timestamp: new Date().toISOString() },
  });
}

export function listPayload<T>(items: T[], total: number, page: number, limit: number, extra?: Record<string, unknown>) {
  return { items, total, page, limit, total_pages: limit > 0 ? Math.ceil(total / limit) : 1, ...(extra || {}) };
}

export interface Paging {
  page: number;
  limit: number;
  offset: number;
}

export function readPaging(req: Request, defLimit = 20, maxLimit = 500): Paging {
  const q = req.query as Record<string, unknown>;
  const page = Math.max(1, Math.floor(Number(q.page || 1)) || 1);
  const rawLimit = Number(q.limit || q.per_page || q.pageSize || q.page_size || defLimit);
  const limit = Math.min(maxLimit, Math.max(1, Math.floor(rawLimit) || defLimit));
  return { page, limit, offset: (page - 1) * limit };
}

export function qstr(req: Request, key: string): string {
  const v = (req.query as Record<string, unknown>)[key];
  if (Array.isArray(v)) return String(v[0] ?? '').trim();
  return v === undefined || v === null ? '' : String(v).trim();
}

export function bstr(body: Record<string, any> | undefined, ...keys: string[]): string {
  if (!body) return '';
  for (const k of keys) {
    const v = body[k];
    if (v !== undefined && v !== null && String(v).trim() !== '') return String(v).trim();
  }
  return '';
}

export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export function isUuid(v: unknown): v is string {
  return typeof v === 'string' && UUID_RE.test(v);
}

export function parseJson<T>(raw: unknown, fallback: T): T {
  if (raw === null || raw === undefined || raw === '') return fallback;
  if (typeof raw === 'object') return raw as T;
  try {
    return JSON.parse(String(raw)) as T;
  } catch {
    return fallback;
  }
}

export function num(v: unknown, fallback = 0): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

/** Wraps an async handler so thrown errors become a MYERP error envelope (500). */
export function handler(
  code: string,
  fn: (req: Request, res: Response, next: NextFunction) => Promise<void>
): RequestHandler {
  return (req, res, next) => {
    fn(req, res, next).catch((err: any) => {
      if (res.headersSent) return;
      const msg = String(err?.message || 'Lỗi hệ thống.');
      if (/INVALID_TENANT_UUID|TENANT_CONTEXT_MISSING/.test(msg)) {
        fail(res, 401, 'TENANT_CONTEXT_MISSING', 'Không tìm thấy ngữ cảnh doanh nghiệp.');
        return;
      }
      fail(res, 500, code, msg);
    });
  };
}

/** Runs `op` inside the caller's RLS-scoped tenant transaction. */
export async function tx<T>(op: (client: DbClient, ctx: TenantContext) => Promise<T>): Promise<T> {
  const ctx = getTenantContext();
  return withTenantTransaction(ctx.tenantId, (client) => op(client, ctx));
}

// ----------------------------------------------------------------------------
// PII masking (RBAC-driven)
// ----------------------------------------------------------------------------
export interface PiiActor {
  rbac: ResolvedUserRbacResult;
  cfg: PiiMaskOptions;
  canUnmask: boolean;
  /** Masks `phone`, `email` and any extra phone-like keys on a row according to RBAC + tenant PII config. */
  mask<T extends Record<string, any>>(row: T, opts?: { isAccepted?: boolean; phoneKeys?: string[]; emailKeys?: string[] }): T & { pii_masked: boolean };
}

export async function resolvePiiActor(client: DbClient, ctx: TenantContext): Promise<PiiActor> {
  const [rbac, settings] = await Promise.all([
    resolveUserEffectivePermissions(client, ctx.tenantId, ctx.userId),
    getTenantSettingsCached(ctx.tenantId, client),
  ]);
  const cfg = (settings || {}) as PiiMaskOptions;
  const leadsPerm = rbac.effectivePermissions?.leads;
  const canUnmask = Boolean(leadsPerm && leadsPerm.scope !== 'none' && leadsPerm.actions?.unmask_phone);
  return {
    rbac,
    cfg,
    canUnmask,
    mask(row, opts) {
      const masked = shouldMaskPiiForActor(ctx, cfg, { is_accepted: opts?.isAccepted ?? true }, canUnmask);
      if (!masked) return { ...row, pii_masked: false };
      const out: Record<string, any> = { ...row, pii_masked: true };
      for (const k of opts?.phoneKeys || ['phone', 'phone_number', 'mobile', 'secondary_phone']) {
        if (typeof out[k] === 'string' && out[k]) out[k] = maskPhoneString(out[k], cfg);
      }
      if (cfg.pii_mask_email !== false) {
        for (const k of opts?.emailKeys || ['email']) {
          if (typeof out[k] === 'string' && out[k]) out[k] = maskEmailString(out[k], cfg) || out[k];
        }
      }
      return out as any;
    },
  };
}

// ----------------------------------------------------------------------------
// In-process bridge onto existing Wave-2 module routers
// ----------------------------------------------------------------------------
export interface BridgeOptions {
  /** Override the HTTP method seen by the target router (e.g. MYERP `PUT` → module `PATCH`). */
  method?: string;
  /** Mutate/replace the request body before the target handles it. */
  mapBody?: (body: any, req: Request) => any;
  /** Merge extra query params seen by the target. */
  mapQuery?: (query: Record<string, any>, req: Request) => Record<string, any>;
  /** Reshape the JSON payload returned by the target into the MYERP contract. */
  transform?: (payload: any, req: Request, status: number) => any;
}

/**
 * Dispatches the current request into `target` (a module Router or handler) under a rewritten path,
 * so the module's own `requireTenantAuth`, entitlement, `requirePermission`, RLS and PII logic run unchanged.
 * `path` may be a string or a function of the request (e.g. `(req) => \`/contacts/${req.params.id}\``).
 */
export function bridge(target: RequestHandler, path: string | ((req: Request) => string), opts: BridgeOptions = {}): RequestHandler {
  return (req, res, next) => {
    const originalUrl = req.url;
    const originalMethod = req.method;
    const originalJson = res.json.bind(res);
    const targetPath = typeof path === 'function' ? path(req) : path;
    const qsIdx = originalUrl.indexOf('?');
    const qs = qsIdx >= 0 ? originalUrl.slice(qsIdx) : '';

    if (opts.mapQuery) {
      const nextQuery = opts.mapQuery({ ...(req.query as Record<string, any>) }, req);
      Object.defineProperty(req, 'query', { value: nextQuery, writable: true, configurable: true, enumerable: true });
    }
    if (opts.mapBody) {
      req.body = opts.mapBody(req.body ?? {}, req);
    }
    if (opts.method) req.method = opts.method.toUpperCase();
    req.url = `${targetPath}${targetPath.includes('?') ? '' : qs}`;

    if (opts.transform) {
      res.json = ((payload: any) => {
        res.json = originalJson;
        let shaped = payload;
        try {
          shaped = opts.transform!(payload, req, res.statusCode);
        } catch {
          shaped = payload;
        }
        return originalJson(normalizeEnvelope(shaped));
      }) as Response['json'];
    } else {
      res.json = ((payload: any) => {
        res.json = originalJson;
        return originalJson(normalizeEnvelope(payload));
      }) as Response['json'];
    }

    target(req, res, (err?: any) => {
      req.url = originalUrl;
      req.method = originalMethod;
      res.json = originalJson;
      if (err) {
        next(err);
        return;
      }
      fail(res, 404, 'MYERP_BRIDGE_TARGET_NOT_FOUND', `Không tìm thấy endpoint đích cho ${originalMethod} ${req.originalUrl}.`);
    });
  };
}

/** Ensures `{ success, data, message }` + mirrors module `error.message` into top-level `message`. */
export function normalizeEnvelope(payload: any): any {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return { success: true, data: payload ?? null, message: '' };
  }
  if (payload.success === false) {
    const msg = payload.message || payload.error?.message || 'Yêu cầu thất bại.';
    return { ...payload, data: payload.data ?? null, message: msg };
  }
  if ('success' in payload) {
    return { ...payload, message: payload.message ?? '' };
  }
  return { success: true, data: payload, message: '' };
}

/** Maps every row of a list payload (array or `{ items }`) through `fn`; leaves other shapes intact. */
export function mapListData(payload: any, fn: (row: any) => any, itemsKeys: string[] = ['items', 'rows', 'list']): any {
  if (!payload || typeof payload !== 'object') return payload;
  const data = payload.data;
  if (Array.isArray(data)) {
    const items = data.map(fn);
    return { ...payload, data: { items, total: items.length, page: 1, limit: items.length } };
  }
  if (data && typeof data === 'object') {
    for (const key of itemsKeys) {
      if (Array.isArray(data[key])) {
        const items = data[key].map(fn);
        return { ...payload, data: { ...data, items, total: data.total ?? items.length } };
      }
    }
  }
  return payload;
}

/** Maps `payload.data` (single entity) through `fn` when it is an object. */
export function mapEntityData(payload: any, fn: (row: any) => any): any {
  if (!payload || typeof payload !== 'object' || !payload.data || typeof payload.data !== 'object' || Array.isArray(payload.data)) {
    return payload;
  }
  return { ...payload, data: fn(payload.data) };
}

/** Adds MYERP alias keys (`alias ← source`) without overwriting keys that already exist. */
export function withAliases<T extends Record<string, any>>(row: T, aliases: Record<string, string | ((r: T) => unknown)>): T & Record<string, unknown> {
  if (!row || typeof row !== 'object') return row as any;
  const out: Record<string, unknown> = { ...row };
  for (const [alias, src] of Object.entries(aliases)) {
    if (out[alias] !== undefined && out[alias] !== null && out[alias] !== '') continue;
    out[alias] = typeof src === 'function' ? src(row) : row[src];
  }
  return out as any;
}

// ----------------------------------------------------------------------------
// HTTP method override (`_method` in query or body; `X-HTTP-Method-Override` header)
// ----------------------------------------------------------------------------
const OVERRIDABLE = new Set(['PUT', 'PATCH', 'DELETE']);
export const methodOverride: RequestHandler = (req, _res, next) => {
  if (req.method === 'POST') {
    const fromQuery = (req.query as Record<string, unknown>)?._method;
    const fromBody = req.body && typeof req.body === 'object' ? (req.body as Record<string, unknown>)._method : undefined;
    const fromHeader = req.header('X-HTTP-Method-Override');
    const raw = String(fromQuery || fromBody || fromHeader || '').trim().toUpperCase();
    if (OVERRIDABLE.has(raw)) {
      req.method = raw;
      if (req.body && typeof req.body === 'object' && '_method' in req.body) {
        delete (req.body as Record<string, unknown>)._method;
      }
    }
  }
  next();
};

/** Resolves display names for a set of user ids in one query (tenant-scoped). */
export async function loadUserNames(client: DbClient, tenantId: string, ids: Array<string | null | undefined>): Promise<Map<string, { full_name: string; avatar_url: string | null; email: string }>> {
  const uniq = Array.from(new Set(ids.filter((v): v is string => isUuid(v))));
  const map = new Map<string, { full_name: string; avatar_url: string | null; email: string }>();
  if (!uniq.length) return map;
  const ph = uniq.map((_, i) => `$${i + 2}`).join(', ');
  const r = await client.query<{ id: string; full_name: string; avatar_url: string | null; email: string }>(
    `SELECT id, full_name, avatar_url, email FROM users WHERE tenant_id = $1 AND id IN (${ph})`,
    [tenantId, ...uniq]
  );
  for (const row of r.rows) map.set(String(row.id), row);
  return map;
}
