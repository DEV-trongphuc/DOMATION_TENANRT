import crypto from 'node:crypto';
import { APP_CONFIG } from '../../config.ts';
import type { PlanTier, TenantRole } from '../context/tenant-context.ts';

export interface TenantJwtClaims {
  sub: string;
  tenantId: string;
  tenantSlug: string;
  email: string;
  name: string;
  role: TenantRole;
  isExternalAgency: boolean;
  planTier: PlanTier;
  impersonatedBy?: string;
  scope: 'tenant';
  iat: number;
  exp: number;
  jti: string;
}

export interface PlatformJwtClaims {
  sub: string;
  email: string;
  name: string;
  role: 'super_admin';
  scope: 'platform_superadmin';
  iat: number;
  exp: number;
  jti: string;
}

export interface AccountJwtClaims {
  sub: string;
  email: string;
  name: string;
  authProvider: 'password' | 'google';
  scope: 'global_account';
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
  while (padded.length % 4 !== 0) {
    padded += '=';
  }
  return Buffer.from(padded, 'base64');
}

function signHmacToken(payload: Record<string, unknown>, secret: string): string {
  const header = { alg: 'HS256', typ: 'JWT' };
  const encodedHeader = base64UrlEncode(JSON.stringify(header));
  const encodedPayload = base64UrlEncode(JSON.stringify(payload));
  const data = `${encodedHeader}.${encodedPayload}`;
  const sig = crypto.createHmac('sha256', secret).update(data).digest();
  return `${data}.${base64UrlEncode(sig)}`;
}

function verifyHmacToken<T>(token: string, secret: string): T {
  const parts = token.split('.');
  if (parts.length !== 3) {
    throw new Error('JWT_MALFORMED');
  }
  const [encodedHeader, encodedPayload, encodedSig] = parts;
  const header = JSON.parse(base64UrlDecode(encodedHeader).toString('utf8'));
  if (header.alg !== 'HS256') {
    throw new Error('JWT_UNSUPPORTED_ALG');
  }

  const data = `${encodedHeader}.${encodedPayload}`;
  const expectedSig = crypto.createHmac('sha256', secret).update(data).digest();
  const actualSig = base64UrlDecode(encodedSig);

  if (expectedSig.length !== actualSig.length || !crypto.timingSafeEqual(expectedSig, actualSig)) {
    throw new Error('JWT_INVALID_SIGNATURE');
  }

  const payload = JSON.parse(base64UrlDecode(encodedPayload).toString('utf8')) as T & { exp?: number };
  const nowSec = Math.floor(Date.now() / 1000);
  if (typeof payload.exp === 'number' && payload.exp <= nowSec) {
    throw new Error('JWT_EXPIRED');
  }

  return payload;
}

export function signTenantAccessToken(
  input: Omit<TenantJwtClaims, 'scope' | 'iat' | 'exp' | 'jti'>,
  expiresInSeconds = 3600
): string {
  const now = Math.floor(Date.now() / 1000);
  const claims: TenantJwtClaims = {
    ...input,
    scope: 'tenant',
    iat: now,
    exp: now + expiresInSeconds,
    jti: crypto.randomUUID(),
  };
  return signHmacToken(claims as unknown as Record<string, unknown>, APP_CONFIG.jwtSecret);
}

export function signTenantRefreshToken(userId: string, tenantId: string, expiresInSeconds = 604800): string {
  const now = Math.floor(Date.now() / 1000);
  return signHmacToken(
    {
      sub: userId,
      tenantId,
      scope: 'tenant_refresh',
      iat: now,
      exp: now + expiresInSeconds,
      jti: crypto.randomUUID(),
    },
    APP_CONFIG.jwtSecret
  );
}

export function verifyTenantAccessToken(token: string): TenantJwtClaims {
  const claims = verifyHmacToken<TenantJwtClaims>(token, APP_CONFIG.jwtSecret);
  if (claims.scope !== 'tenant' || !claims.tenantId || !claims.sub) {
    throw new Error('JWT_INVALID_SCOPE');
  }
  return claims;
}

export function signPlatformAccessToken(
  input: Omit<PlatformJwtClaims, 'scope' | 'role' | 'iat' | 'exp' | 'jti'>,
  expiresInSeconds = 1800
): string {
  const now = Math.floor(Date.now() / 1000);
  const claims: PlatformJwtClaims = {
    ...input,
    role: 'super_admin',
    scope: 'platform_superadmin',
    iat: now,
    exp: now + expiresInSeconds,
    jti: crypto.randomUUID(),
  };
  return signHmacToken(claims as unknown as Record<string, unknown>, APP_CONFIG.platformJwtSecret);
}

export function verifyPlatformAccessToken(token: string): PlatformJwtClaims {
  const claims = verifyHmacToken<PlatformJwtClaims>(token, APP_CONFIG.platformJwtSecret);
  if (claims.scope !== 'platform_superadmin' || claims.role !== 'super_admin') {
    throw new Error('JWT_INVALID_PLATFORM_SCOPE');
  }
  return claims;
}

export function signAccountToken(
  input: Omit<AccountJwtClaims, 'scope' | 'iat' | 'exp' | 'jti'>,
  expiresInSeconds = 3600
): string {
  const now = Math.floor(Date.now() / 1000);
  const claims: AccountJwtClaims = {
    ...input,
    scope: 'global_account',
    iat: now,
    exp: now + expiresInSeconds,
    jti: crypto.randomUUID(),
  };
  return signHmacToken(claims as unknown as Record<string, unknown>, APP_CONFIG.jwtSecret);
}

export function verifyAccountToken(token: string): AccountJwtClaims {
  const claims = verifyHmacToken<AccountJwtClaims>(token, APP_CONFIG.jwtSecret);
  if (claims.scope !== 'global_account' || !claims.sub || !claims.email) {
    throw new Error('JWT_INVALID_ACCOUNT_SCOPE');
  }
  return claims;
}
