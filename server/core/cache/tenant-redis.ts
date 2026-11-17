import { APP_CONFIG } from '../../config.ts';
import { getTenantContext, type TenantRole } from '../context/tenant-context.ts';

interface CacheEntry {
  value: string;
  expiresAt: number | null;
}

interface TokenBucketState {
  tokens: number;
  lastRefillMs: number;
}

export interface CachedTenantMeta {
  slug: string;
  name?: string;
  status: string;
  rawSettings: Record<string, unknown>;
  normalizedSettings?: any;
  expiresAt: number;
}

export interface CachedInboundWebhookMeta {
  id: string;
  tenant_id: string;
  tenant_slug: string;
  tenant_status: string;
  signing_secret: string;
  field_mappings: Record<string, unknown>;
  is_active: boolean;
  expiresAt: number;
}

export interface CachedOutboundWebhookItem {
  id: string;
  url: string | null;
  signing_secret: string;
  subscribed_events: string[];
  field_mappings: Record<string, unknown>;
}

export interface CachedTenantSlugMeta {
  id: string;
  slug: string;
  status: string;
  expiresAt: number;
}

export interface CachedUserAuthMeta {
  role: TenantRole;
  isExternalAgency: boolean;
  expiresAt: number;
}

export interface CachedTenantIntegrationRecord {
  status: string;
  config_encrypted: string;
  iv: string;
  auth_tag: string;
  token_expires_at?: string | Date | null;
}

const MAX_KV_ENTRIES = 250_000;
const MAX_TENANT_META_CACHE = 10_000;
const MAX_WEBHOOK_META_CACHE = 25_000;
const MAX_USER_AUTH_CACHE = 100_000;
const GC_SWEEP_INTERVAL_OPS = 1_000;

/**
 * Multi-Tenant Isolated Cache, Distributed Lock (Redlock pattern), Sorted Set SLA Queue,
 * Token Bucket Rate Limiter, Hot Tenant/Webhook Config Cache & Session Blacklist Store.
 *
 * Enforces strict tenant key-prefixing: `tenant:{tenant_id}:{domain}:{key}`.
 * Any attempt to read/write unscoped tenant keys throws REDIS_UNSCOPED_KEY_ERROR.
 */
class TenantRedisStore {
  private kv = new Map<string, CacheEntry>();
  private zsets = new Map<string, Map<string, number>>();
  private buckets = new Map<string, TokenBucketState>();
  private locks = new Map<string, Promise<void>>();
  private tenantMetaCache = new Map<string, CachedTenantMeta>();
  private tenantSlugCache = new Map<string, CachedTenantSlugMeta>();
  private userAuthCache = new Map<string, CachedUserAuthMeta>();
  private effectivePermissionsCache = new Map<string, { value: unknown; expiresAt: number }>();
  private dynamicAudienceCountCache = new Map<string, { count: number; expiresAt: number }>();
  private tenantIntegrationCache = new Map<string, { record: CachedTenantIntegrationRecord | null; expiresAt: number }>();
  private inboundWebhookCache = new Map<string, CachedInboundWebhookMeta>();
  private outboundWebhookCache = new Map<string, { webhooks: CachedOutboundWebhookItem[]; expiresAt: number }>();
  private platformDefaultsCache: { rawSettings: Record<string, unknown>; expiresAt: number } | null = null;
  private writeOpsSinceSweep = 0;

  private resolveScopedKey(subKey: string, explicitTenantId?: string): string {
    const tenantId = explicitTenantId || getTenantContext().tenantId;
    if (!tenantId) {
      throw new Error('REDIS_UNSCOPED_KEY_ERROR: Missing tenantId for cache operation');
    }
    if (subKey.startsWith(`tenant:${tenantId}:`)) {
      return subKey;
    }
    return `tenant:${tenantId}:${subKey}`;
  }

  private pruneIfExpired(fullKey: string): CacheEntry | undefined {
    const entry = this.kv.get(fullKey);
    if (!entry) return undefined;
    if (entry.expiresAt !== null && Date.now() >= entry.expiresAt) {
      this.kv.delete(fullKey);
      return undefined;
    }
    return entry;
  }

  private maybeSweepMemory(): void {
    this.writeOpsSinceSweep += 1;
    if (this.writeOpsSinceSweep < GC_SWEEP_INTERVAL_OPS && this.kv.size <= MAX_KV_ENTRIES) {
      return;
    }
    this.writeOpsSinceSweep = 0;
    const now = Date.now();
    for (const [k, entry] of this.kv.entries()) {
      if (entry.expiresAt !== null && now >= entry.expiresAt) {
        this.kv.delete(k);
      }
    }
    if (this.kv.size > MAX_KV_ENTRIES) {
      // Evict oldest non-blacklist keys first so revoked JWT blacklists are never displaced by cache churn
      const excess = this.kv.size - MAX_KV_ENTRIES;
      let removed = 0;
      for (const k of this.kv.keys()) {
        if (!k.includes(':blacklist:user:')) {
          this.kv.delete(k);
          removed += 1;
          if (removed >= excess) break;
        }
      }
    }
    if (this.buckets.size > MAX_KV_ENTRIES) {
      const staleCutoff = now - 10 * 60 * 1000;
      for (const [k, b] of this.buckets.entries()) {
        if (b.lastRefillMs < staleCutoff) {
          this.buckets.delete(k);
        }
      }
    }
  }

  async get(subKey: string, explicitTenantId?: string): Promise<string | null> {
    const fullKey = this.resolveScopedKey(subKey, explicitTenantId);
    const entry = this.pruneIfExpired(fullKey);
    return entry ? entry.value : null;
  }

  async set(subKey: string, value: string, ttlSeconds?: number, explicitTenantId?: string): Promise<void> {
    const fullKey = this.resolveScopedKey(subKey, explicitTenantId);
    this.kv.set(fullKey, {
      value,
      expiresAt: ttlSeconds ? Date.now() + ttlSeconds * 1000 : null,
    });
    this.maybeSweepMemory();
  }

  /**
   * Atomic SET if Not Exists with TTL (24h Webhook Idempotency Engine).
   * Returns true if newly set, false if duplicate key already exists within TTL window.
   */
  async setNxEx(subKey: string, value: string, ttlSeconds: number, explicitTenantId?: string): Promise<boolean> {
    const fullKey = this.resolveScopedKey(subKey, explicitTenantId);
    const existing = this.pruneIfExpired(fullKey);
    if (existing) {
      return false;
    }
    this.kv.set(fullKey, {
      value,
      expiresAt: Date.now() + ttlSeconds * 1000,
    });
    this.maybeSweepMemory();
    return true;
  }

  async del(subKey: string, explicitTenantId?: string): Promise<void> {
    const fullKey = this.resolveScopedKey(subKey, explicitTenantId);
    this.kv.delete(fullKey);
  }

  async exists(subKey: string, explicitTenantId?: string): Promise<boolean> {
    const fullKey = this.resolveScopedKey(subKey, explicitTenantId);
    return Boolean(this.pruneIfExpired(fullKey));
  }

  // --- Sorted Sets for Stage SLA Escalation Queue (`tenant:{tenant_id}:sla_queue`) ---
  async zadd(subKey: string, score: number, member: string, explicitTenantId?: string): Promise<void> {
    const fullKey = this.resolveScopedKey(subKey, explicitTenantId);
    let zset = this.zsets.get(fullKey);
    if (!zset) {
      zset = new Map<string, number>();
      this.zsets.set(fullKey, zset);
    }
    zset.set(member, score);
  }

  async zrangebyscore(subKey: string, minScore: number, maxScore: number, explicitTenantId?: string): Promise<string[]> {
    const fullKey = this.resolveScopedKey(subKey, explicitTenantId);
    const zset = this.zsets.get(fullKey);
    if (!zset) return [];
    const matches: Array<{ member: string; score: number }> = [];
    for (const [member, score] of zset.entries()) {
      if (score >= minScore && score <= maxScore) {
        matches.push({ member, score });
      }
    }
    matches.sort((a, b) => a.score - b.score);
    return matches.map((m) => m.member);
  }

  async zrem(subKey: string, member: string, explicitTenantId?: string): Promise<void> {
    const fullKey = this.resolveScopedKey(subKey, explicitTenantId);
    const zset = this.zsets.get(fullKey);
    if (!zset) return;
    zset.delete(member);
    if (zset.size === 0) {
      this.zsets.delete(fullKey);
    }
  }

  /**
   * Returns only the tenant IDs that currently hold at least one SLA queue entry with `score <= maxScore`.
   * Avoids full `SELECT id FROM tenants` DB scans when background SLA sweep runs across hundreds of idle tenants.
   */
  getTenantsWithExpiredSla(maxScore: number): string[] {
    const expiredTenantIds: string[] = [];
    const prefix = 'tenant:';
    const suffix = ':sla_queue';
    for (const [fullKey, zset] of this.zsets.entries()) {
      if (zset.size === 0) {
        this.zsets.delete(fullKey);
        continue;
      }
      if (!fullKey.startsWith(prefix) || !fullKey.endsWith(suffix)) continue;
      for (const score of zset.values()) {
        if (score <= maxScore) {
          expiredTenantIds.push(fullKey.slice(prefix.length, fullKey.length - suffix.length));
          break;
        }
      }
    }
    return expiredTenantIds;
  }

  // --- Hot Tenant Metadata & Custom Settings Cache (with instant invalidation) ---
  getCachedTenantMeta(
    tenantId: string
  ): { slug: string; name?: string; status: string; rawSettings: Record<string, unknown>; normalizedSettings?: any } | null {
    const entry = this.tenantMetaCache.get(tenantId);
    if (!entry) return null;
    if (Date.now() >= entry.expiresAt) {
      this.tenantMetaCache.delete(tenantId);
      return null;
    }
    return {
      slug: entry.slug,
      name: entry.name,
      status: entry.status,
      rawSettings: entry.rawSettings,
      normalizedSettings: entry.normalizedSettings,
    };
  }

  setCachedTenantMeta(
    tenantId: string,
    meta: { slug: string; name?: string; status: string; rawSettings: Record<string, unknown>; normalizedSettings?: any },
    ttlSeconds = APP_CONFIG.tenantCacheTtlSeconds
  ): void {
    if (!tenantId) return;
    if (this.tenantMetaCache.size >= MAX_TENANT_META_CACHE && !this.tenantMetaCache.has(tenantId)) {
      const oldest = this.tenantMetaCache.keys().next().value;
      if (oldest !== undefined) this.tenantMetaCache.delete(oldest);
    }
    const expiresAt = Date.now() + ttlSeconds * 1000;
    this.tenantMetaCache.set(tenantId, {
      slug: meta.slug,
      status: meta.status,
      rawSettings: meta.rawSettings,
      normalizedSettings: meta.normalizedSettings,
      expiresAt,
    });
    if (meta.slug) {
      this.setCachedTenantBySlug(meta.slug, { id: tenantId, slug: meta.slug, status: meta.status }, ttlSeconds);
    }
  }

  getCachedTenantBySlug(slug: string): { id: string; slug: string; obfuscated_slug?: string; status: string } | null {
    const clean = slug.trim().toLowerCase();
    if (!clean) return null;
    const entry = this.tenantSlugCache.get(clean);
    if (!entry) return null;
    if (Date.now() >= entry.expiresAt) {
      this.tenantSlugCache.delete(clean);
      return null;
    }
    return {
      id: entry.id,
      slug: entry.slug,
      obfuscated_slug: (entry as any).obfuscated_slug,
      status: entry.status,
    };
  }

  setCachedTenantBySlug(
    slug: string,
    meta: { id: string; slug: string; obfuscated_slug?: string; status: string },
    ttlSeconds = APP_CONFIG.tenantCacheTtlSeconds
  ): void {
    const clean = slug.trim().toLowerCase();
    if (!clean) return;
    if (this.tenantSlugCache.size >= MAX_TENANT_META_CACHE && !this.tenantSlugCache.has(clean)) {
      const oldest = this.tenantSlugCache.keys().next().value;
      if (oldest !== undefined) this.tenantSlugCache.delete(oldest);
    }
    this.tenantSlugCache.set(clean, {
      id: meta.id,
      slug: meta.slug,
      status: meta.status,
      obfuscated_slug: meta.obfuscated_slug,
      expiresAt: Date.now() + ttlSeconds * 1000,
    } as any);
  }

  getCachedUserAuth(
    tenantId: string,
    userId: string
  ): { role: TenantRole; isExternalAgency: boolean } | null {
    const key = `${tenantId}:${userId}`;
    const entry = this.userAuthCache.get(key);
    if (!entry) return null;
    if (Date.now() >= entry.expiresAt) {
      this.userAuthCache.delete(key);
      return null;
    }
    return { role: entry.role, isExternalAgency: entry.isExternalAgency };
  }

  setCachedUserAuth(
    tenantId: string,
    userId: string,
    meta: { role: TenantRole; isExternalAgency: boolean },
    ttlSeconds = 604800
  ): void {
    if (!tenantId || !userId) return;
    const key = `${tenantId}:${userId}`;
    if (this.userAuthCache.size >= MAX_USER_AUTH_CACHE && !this.userAuthCache.has(key)) {
      const oldest = this.userAuthCache.keys().next().value;
      if (oldest !== undefined) this.userAuthCache.delete(oldest);
    }
    this.userAuthCache.set(key, {
      role: meta.role,
      isExternalAgency: Boolean(meta.isExternalAgency),
      expiresAt: Date.now() + ttlSeconds * 1000,
    });
    this.invalidateEffectivePermissions(tenantId, userId);
  }

  invalidateUserAuth(tenantId: string, userId: string): void {
    this.userAuthCache.delete(`${tenantId}:${userId}`);
    this.invalidateEffectivePermissions(tenantId, userId);
  }

  getCachedEffectivePermissions<T>(tenantId: string, userId: string): T | null {
    if (!tenantId || !userId) return null;
    const key = `${tenantId}:${userId}`;
    const entry = this.effectivePermissionsCache.get(key);
    if (!entry) return null;
    if (Date.now() >= entry.expiresAt) {
      this.effectivePermissionsCache.delete(key);
      return null;
    }
    return entry.value as T;
  }

  setCachedEffectivePermissions<T>(
    tenantId: string,
    userId: string,
    value: T,
    ttlSeconds = 30
  ): void {
    if (!tenantId || !userId) return;
    const key = `${tenantId}:${userId}`;
    if (this.effectivePermissionsCache.size >= MAX_USER_AUTH_CACHE && !this.effectivePermissionsCache.has(key)) {
      const oldest = this.effectivePermissionsCache.keys().next().value;
      if (oldest !== undefined) this.effectivePermissionsCache.delete(oldest);
    }
    this.effectivePermissionsCache.set(key, {
      value,
      expiresAt: Date.now() + ttlSeconds * 1000,
    });
  }

  invalidateEffectivePermissions(tenantId?: string, userId?: string): void {
    if (!tenantId) {
      this.effectivePermissionsCache.clear();
      return;
    }
    if (userId) {
      this.effectivePermissionsCache.delete(`${tenantId}:${userId}`);
      return;
    }
    const prefix = `${tenantId}:`;
    for (const k of this.effectivePermissionsCache.keys()) {
      if (k.startsWith(prefix)) {
        this.effectivePermissionsCache.delete(k);
      }
    }
  }

  getCachedDynamicAudienceCount(tenantId: string): number | null {
    if (!tenantId) return null;
    const entry = this.dynamicAudienceCountCache.get(tenantId);
    if (!entry) return null;
    if (Date.now() >= entry.expiresAt) {
      this.dynamicAudienceCountCache.delete(tenantId);
      return null;
    }
    return entry.count;
  }

  setCachedDynamicAudienceCount(tenantId: string, count: number, ttlSeconds = 60): void {
    if (!tenantId) return;
    if (this.dynamicAudienceCountCache.size >= MAX_TENANT_META_CACHE && !this.dynamicAudienceCountCache.has(tenantId)) {
      const oldest = this.dynamicAudienceCountCache.keys().next().value;
      if (oldest !== undefined) this.dynamicAudienceCountCache.delete(oldest);
    }
    this.dynamicAudienceCountCache.set(tenantId, {
      count: Math.max(0, count),
      expiresAt: Date.now() + ttlSeconds * 1000,
    });
  }

  invalidateDynamicAudienceCount(tenantId?: string): void {
    if (!tenantId) {
      this.dynamicAudienceCountCache.clear();
      return;
    }
    this.dynamicAudienceCountCache.delete(tenantId);
  }

  getCachedTenantIntegration(
    tenantId: string,
    type: string
  ): { hit: true; record: CachedTenantIntegrationRecord | null } | { hit: false } {
    const key = `${tenantId}\0${type}`;
    const entry = this.tenantIntegrationCache.get(key);
    if (!entry) return { hit: false };
    if (Date.now() >= entry.expiresAt) {
      this.tenantIntegrationCache.delete(key);
      return { hit: false };
    }
    return { hit: true, record: entry.record };
  }

  setCachedTenantIntegration(
    tenantId: string,
    type: string,
    record: CachedTenantIntegrationRecord | null,
    ttlSeconds = APP_CONFIG.tenantCacheTtlSeconds
  ): void {
    if (!tenantId || !type) return;
    const key = `${tenantId}\0${type}`;
    if (this.tenantIntegrationCache.size >= MAX_WEBHOOK_META_CACHE && !this.tenantIntegrationCache.has(key)) {
      const oldest = this.tenantIntegrationCache.keys().next().value;
      if (oldest !== undefined) this.tenantIntegrationCache.delete(oldest);
    }
    this.tenantIntegrationCache.set(key, {
      record,
      expiresAt: Date.now() + ttlSeconds * 1000,
    });
  }

  invalidateTenantIntegrations(tenantId?: string, type?: string): void {
    if (!tenantId) {
      this.tenantIntegrationCache.clear();
      return;
    }
    if (type) {
      this.tenantIntegrationCache.delete(`${tenantId}\0${type}`);
      return;
    }
    const prefix = `${tenantId}\0`;
    for (const k of this.tenantIntegrationCache.keys()) {
      if (k.startsWith(prefix)) {
        this.tenantIntegrationCache.delete(k);
      }
    }
  }

  invalidateTenantCache(tenantId?: string, tenantSlug?: string): void {
    if (!tenantId && !tenantSlug) {
      this.tenantMetaCache.clear();
      this.tenantSlugCache.clear();
      this.effectivePermissionsCache.clear();
      this.dynamicAudienceCountCache.clear();
      this.tenantIntegrationCache.clear();
      this.inboundWebhookCache.clear();
      this.outboundWebhookCache.clear();
      return;
    }
    const existing = tenantId ? this.tenantMetaCache.get(tenantId) : undefined;
    const effectiveSlug = (tenantSlug || existing?.slug || '').toLowerCase();
    if (tenantId) {
      this.tenantMetaCache.delete(tenantId);
      this.outboundWebhookCache.delete(tenantId);
      this.invalidateEffectivePermissions(tenantId);
      this.invalidateDynamicAudienceCount(tenantId);
      this.invalidateTenantIntegrations(tenantId);
      for (const [slugKey, slugVal] of this.tenantSlugCache.entries()) {
        if (slugVal.id === tenantId) {
          this.tenantSlugCache.delete(slugKey);
        }
      }
    }
    if (effectiveSlug) {
      this.tenantSlugCache.delete(effectiveSlug);
    }
    for (const [key, val] of this.inboundWebhookCache.entries()) {
      if (
        (tenantId && val.tenant_id === tenantId) ||
        (effectiveSlug && key.startsWith(`${effectiveSlug}\0`))
      ) {
        this.inboundWebhookCache.delete(key);
      }
    }
  }

  getCachedPlatformDefaults(): Record<string, unknown> | null {
    if (!this.platformDefaultsCache) return null;
    if (Date.now() >= this.platformDefaultsCache.expiresAt) {
      this.platformDefaultsCache = null;
      return null;
    }
    return this.platformDefaultsCache.rawSettings;
  }

  setCachedPlatformDefaults(
    rawSettings: Record<string, unknown>,
    ttlSeconds = APP_CONFIG.tenantCacheTtlSeconds
  ): void {
    this.platformDefaultsCache = {
      rawSettings,
      expiresAt: Date.now() + ttlSeconds * 1000,
    };
  }

  invalidatePlatformDefaultsCache(): void {
    this.platformDefaultsCache = null;
  }

  getCachedInboundWebhook(slug: string, token: string): CachedInboundWebhookMeta | null {
    const key = `${slug.trim().toLowerCase()}\0${token}`;
    const entry = this.inboundWebhookCache.get(key);
    if (!entry) return null;
    if (Date.now() >= entry.expiresAt) {
      this.inboundWebhookCache.delete(key);
      return null;
    }
    return entry;
  }

  setCachedInboundWebhook(
    slug: string,
    token: string,
    meta: Omit<CachedInboundWebhookMeta, 'expiresAt'>,
    ttlSeconds = APP_CONFIG.tenantCacheTtlSeconds
  ): void {
    const key = `${slug.trim().toLowerCase()}\0${token}`;
    if (this.inboundWebhookCache.size >= MAX_WEBHOOK_META_CACHE && !this.inboundWebhookCache.has(key)) {
      const oldest = this.inboundWebhookCache.keys().next().value;
      if (oldest !== undefined) this.inboundWebhookCache.delete(oldest);
    }
    this.inboundWebhookCache.set(key, {
      ...meta,
      expiresAt: Date.now() + ttlSeconds * 1000,
    });
  }

  invalidateInboundWebhooks(tenantId?: string): void {
    this.invalidateWebhookCaches(tenantId);
  }

  getCachedOutboundWebhooks(tenantId: string): CachedOutboundWebhookItem[] | null {
    const entry = this.outboundWebhookCache.get(tenantId);
    if (!entry) return null;
    if (Date.now() >= entry.expiresAt) {
      this.outboundWebhookCache.delete(tenantId);
      return null;
    }
    return entry.webhooks;
  }

  setCachedOutboundWebhooks(
    tenantId: string,
    webhooks: CachedOutboundWebhookItem[],
    ttlSeconds = APP_CONFIG.tenantCacheTtlSeconds
  ): void {
    if (!tenantId) return;
    if (this.outboundWebhookCache.size >= MAX_TENANT_META_CACHE && !this.outboundWebhookCache.has(tenantId)) {
      const oldest = this.outboundWebhookCache.keys().next().value;
      if (oldest !== undefined) this.outboundWebhookCache.delete(oldest);
    }
    this.outboundWebhookCache.set(tenantId, {
      webhooks,
      expiresAt: Date.now() + ttlSeconds * 1000,
    });
  }

  invalidateWebhookCaches(tenantId?: string): void {
    if (!tenantId) {
      this.inboundWebhookCache.clear();
      this.outboundWebhookCache.clear();
      return;
    }
    this.outboundWebhookCache.delete(tenantId);
    for (const [key, val] of this.inboundWebhookCache.entries()) {
      if (val.tenant_id === tenantId) {
        this.inboundWebhookCache.delete(key);
      }
    }
  }

  // --- Distributed Lock (`lock:tenant:{tenant_id}:{resource}`) ---
  async withLock<T>(tenantId: string, resource: string, ttlMs: number, fn: () => Promise<T>): Promise<T> {
    if (!tenantId) {
      throw new Error('REDIS_LOCK_TENANT_REQUIRED');
    }
    const lockKey = `lock:tenant:${tenantId}:${resource}`;
    const prev = this.locks.get(lockKey) || Promise.resolve();

    let releaseLock!: () => void;
    const current = new Promise<void>((resolve) => {
      releaseLock = resolve;
    });
    const chain = prev.then(() => current);
    this.locks.set(lockKey, chain);

    await prev;
    const effectiveTtlMs = Number.isFinite(ttlMs) && ttlMs > 0 ? Math.max(250, ttlMs) : 10_000;
    const ttlTimer = setTimeout(() => {
      releaseLock();
      if (this.locks.get(lockKey) === chain) {
        this.locks.delete(lockKey);
      }
    }, effectiveTtlMs);
    ttlTimer.unref?.();

    try {
      return await fn();
    } finally {
      clearTimeout(ttlTimer);
      releaseLock();
      if (this.locks.get(lockKey) === chain) {
        this.locks.delete(lockKey);
      }
    }
  }

  // --- Token Bucket Rate Limiter (e.g. Zalo Bot 30 req/s per tenant) ---
  consumeRateLimit(tenantId: string, integrationType: string, capacity = 30, refillPerSec = 30): {
    allowed: boolean;
    remaining: number;
    retryAfterMs: number;
  } {
    const key = `tenant:${tenantId}:rate_limit:${integrationType}`;
    const now = Date.now();
    const bucket = this.buckets.get(key) || { tokens: capacity, lastRefillMs: now };

    const elapsedSec = Math.max(0, (now - bucket.lastRefillMs) / 1000);
    bucket.tokens = Math.min(capacity, bucket.tokens + elapsedSec * refillPerSec);
    bucket.lastRefillMs = now;

    if (bucket.tokens >= 1) {
      bucket.tokens -= 1;
      this.buckets.set(key, bucket);
      return { allowed: true, remaining: Math.floor(bucket.tokens), retryAfterMs: 0 };
    }

    const deficit = 1 - bucket.tokens;
    const retryAfterMs = Math.ceil((deficit / refillPerSec) * 1000);
    this.buckets.set(key, bucket);
    return { allowed: false, remaining: 0, retryAfterMs };
  }

  // --- User Session Blacklist ---
  async blacklistUser(tenantId: string, userId: string, status: string, ttlSeconds = 604800): Promise<void> {
    this.invalidateEffectivePermissions(tenantId, userId);
    await this.set(
      `blacklist:user:${userId}`,
      JSON.stringify({ status, revokedAt: Date.now() }),
      ttlSeconds,
      tenantId
    );
  }

  async unblacklistUser(tenantId: string, userId: string): Promise<void> {
    this.invalidateEffectivePermissions(tenantId, userId);
    await this.del(`blacklist:user:${userId}`, tenantId);
  }

  async isUserBlacklisted(tenantId: string, userId: string): Promise<boolean> {
    return this.exists(`blacklist:user:${userId}`, tenantId);
  }

  clearAllForTesting(): void {
    this.kv.clear();
    this.zsets.clear();
    this.buckets.clear();
    this.tenantMetaCache.clear();
    this.tenantSlugCache.clear();
    this.userAuthCache.clear();
    this.effectivePermissionsCache.clear();
    this.dynamicAudienceCountCache.clear();
    this.tenantIntegrationCache.clear();
    this.inboundWebhookCache.clear();
    this.outboundWebhookCache.clear();
    this.platformDefaultsCache = null;
    this.writeOpsSinceSweep = 0;
  }
}

export const tenantRedis = new TenantRedisStore();
