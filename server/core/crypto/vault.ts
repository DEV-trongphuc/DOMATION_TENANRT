import crypto from 'node:crypto';
import { APP_CONFIG } from '../../config.ts';

export interface EncryptedVaultRecord {
  configEncrypted: string;
  iv: string;
  authTag: string;
}

interface CachedTenantVaultMaterial {
  key: crypto.KeyObject;
  aad: Buffer;
}

const MAX_DERIVED_KEY_CACHE_SIZE = 5_000;
const derivedKeyCache = new Map<string, CachedTenantVaultMaterial>();
let cachedMasterSecret = '';

// Batched CSPRNG 96-bit IV pool (341 * 12 = 4092 bytes) to eliminate per-encrypt syscall lock contention
const IV_LENGTH = 12;
const IV_POOL_BYTES = IV_LENGTH * 341;
const ivPool = Buffer.allocUnsafe(IV_POOL_BYTES);
let ivPoolOffset = IV_POOL_BYTES;

function nextRandomIv(): Buffer {
  if (ivPoolOffset + IV_LENGTH > IV_POOL_BYTES) {
    crypto.randomFillSync(ivPool);
    ivPoolOffset = 0;
  }
  const slice = ivPool.subarray(ivPoolOffset, ivPoolOffset + IV_LENGTH);
  ivPoolOffset += IV_LENGTH;
  return slice;
}

function getTenantVaultMaterial(tenantId: string): CachedTenantVaultMaterial {
  if (!tenantId) {
    throw new Error('VAULT_TENANT_ID_REQUIRED: Cannot derive encryption key without tenantId');
  }
  const masterSecret = APP_CONFIG.vaultMasterSecret;
  if (cachedMasterSecret !== masterSecret) {
    derivedKeyCache.clear();
    cachedMasterSecret = masterSecret;
  }

  const cached = derivedKeyCache.get(tenantId);
  if (cached) {
    derivedKeyCache.delete(tenantId);
    derivedKeyCache.set(tenantId, cached);
    return cached;
  }

  const salt = `tenant:${tenantId}:aes256gcm:vault:v1`;
  const derivedBuf = crypto.pbkdf2Sync(masterSecret, salt, 100_000, 32, 'sha256');
  const material: CachedTenantVaultMaterial = {
    key: crypto.createSecretKey(derivedBuf),
    aad: Buffer.from(`tenant:${tenantId}`, 'utf8'),
  };

  if (derivedKeyCache.size >= MAX_DERIVED_KEY_CACHE_SIZE) {
    const oldestKey = derivedKeyCache.keys().next().value;
    if (oldestKey !== undefined) {
      derivedKeyCache.delete(oldestKey);
    }
  }
  derivedKeyCache.set(tenantId, material);
  return material;
}

export function clearVaultKeyCacheForTesting(): void {
  derivedKeyCache.clear();
}

/**
 * Encrypts sensitive third-party credentials (Zalo OA, Meta CAPI, SMTP) using AES-256-GCM
 * with a tenant-derived PBKDF2 KeyObject and a fresh 96-bit CSPRNG IV on every write/rotation.
 */
export function encryptTenantSecret(tenantId: string, secretPayload: Record<string, unknown>): EncryptedVaultRecord {
  const { key, aad } = getTenantVaultMaterial(tenantId);
  const ivBuf = nextRandomIv();
  const cipher = crypto.createCipheriv('aes-256-gcm', key, ivBuf);
  cipher.setAAD(aad);

  const plaintext = JSON.stringify(secretPayload);
  const encHead = cipher.update(plaintext, 'utf8', 'hex');
  const encTail = cipher.final('hex');
  const authTagBuf = cipher.getAuthTag();

  return {
    configEncrypted: encTail ? encHead + encTail : encHead,
    iv: ivBuf.toString('hex'),
    authTag: authTagBuf.toString('hex'),
  };
}

/**
 * Decrypts AES-256-GCM ciphertexts scoped to the exact tenantId.
 * Cross-tenant decryption attempts fail cryptographic tag verification immediately.
 */
export function decryptTenantSecret<T = Record<string, unknown>>(
  tenantId: string,
  configEncrypted: string,
  iv: string,
  authTag: string
): T {
  const { key, aad } = getTenantVaultMaterial(tenantId);
  const ivBuf = Buffer.from(iv, 'hex');
  const authTagBuf = Buffer.from(authTag, 'hex');

  const decipher = crypto.createDecipheriv('aes-256-gcm', key, ivBuf);
  decipher.setAAD(aad);
  decipher.setAuthTag(authTagBuf);

  const decHead = decipher.update(configEncrypted, 'hex', 'utf8');
  const decTail = decipher.final('utf8');
  return JSON.parse(decTail ? decHead + decTail : decHead) as T;
}
