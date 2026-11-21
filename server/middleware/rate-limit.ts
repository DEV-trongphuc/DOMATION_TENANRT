import type { Request, Response, NextFunction } from 'express';

export interface SlidingWindowRateLimitOptions {
  name: string;
  windowMs: number;
  maxRequests: number;
  keyFn?: (req: Request) => string;
  message?: string;
}

interface BucketEntry {
  timestamps: number[];
  lastSeen: number;
}

const MAX_TRACKED_BUCKETS = 20_000;

export function extractClientIp(req: Request): string {
  const xff = req.headers['x-forwarded-for'];
  if (typeof xff === 'string' && xff.trim()) {
    return xff.split(',')[0].trim().slice(0, 80);
  }
  if (Array.isArray(xff) && xff[0]) {
    return String(xff[0]).split(',')[0].trim().slice(0, 80);
  }
  return String(req.ip || req.socket?.remoteAddress || 'unknown').trim().slice(0, 80);
}

export function createSlidingWindowRateLimiter(options: SlidingWindowRateLimitOptions) {
  const buckets = new Map<string, BucketEntry>();
  const windowMs = Math.max(1_000, options.windowMs);
  const maxRequests = Math.max(1, options.maxRequests);

  const sweepTimer = setInterval(() => {
    const cutoff = Date.now() - windowMs;
    for (const [key, entry] of buckets.entries()) {
      if (entry.lastSeen < cutoff) {
        buckets.delete(key);
      }
    }
  }, Math.min(Math.max(windowMs, 30_000), 120_000));
  sweepTimer.unref();

  return function rateLimitMiddleware(req: Request, res: Response, next: NextFunction): void {
    const isTestEnv = process.env.NODE_ENV === 'test';
    const forceInTest = String(req.headers['x-test-enforce-rate-limit'] || '').trim() === '1';
    if (isTestEnv && !forceInTest) {
      next();
      return;
    }

    const now = Date.now();
    const cutoff = now - windowMs;
    const rawKey = options.keyFn ? options.keyFn(req) : extractClientIp(req);
    const key = `${options.name}:${String(rawKey || 'anon').toLowerCase().slice(0, 180)}`;

    let entry = buckets.get(key);
    if (!entry) {
      if (buckets.size >= MAX_TRACKED_BUCKETS) {
        const oldestKey = buckets.keys().next().value;
        if (oldestKey) buckets.delete(oldestKey);
      }
      entry = { timestamps: [], lastSeen: now };
      buckets.set(key, entry);
    }

    // Drop timestamps outside sliding window
    while (entry.timestamps.length > 0 && entry.timestamps[0] <= cutoff) {
      entry.timestamps.shift();
    }
    entry.lastSeen = now;

    if (entry.timestamps.length >= maxRequests) {
      const oldestInWindow = entry.timestamps[0] || now;
      const retryAfterSec = Math.max(1, Math.ceil((oldestInWindow + windowMs - now) / 1000));
      res.setHeader('Retry-After', String(retryAfterSec));
      res.setHeader('X-RateLimit-Limit', String(maxRequests));
      res.setHeader('X-RateLimit-Remaining', '0');
      res.status(429).json({
        success: false,
        error: {
          code: 'RATE_LIMIT_EXCEEDED',
          message:
            options.message ||
            'Bạn đang gửi yêu cầu quá nhanh. Vui lòng thử lại sau ít phút.',
          retry_after_seconds: retryAfterSec,
        },
      });
      return;
    }

    entry.timestamps.push(now);
    const remaining = Math.max(0, maxRequests - entry.timestamps.length);
    res.setHeader('X-RateLimit-Limit', String(maxRequests));
    res.setHeader('X-RateLimit-Remaining', String(remaining));
    next();
  };
}
