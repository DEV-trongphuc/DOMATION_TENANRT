import crypto from 'node:crypto';

const BASE62_CHARS = '0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ';

/**
 * Generates an unbiased CSPRNG Base62 string using crypto.randomBytes.
 * Uses rejection sampling (< 248) to completely eliminate modulo bias.
 * (248 = 62 * 4, the largest multiple of 62 strictly less than 256)
 */
export function generateCsprngBase62(length: number = 10): string {
  if (length <= 0) return '';
  let result = '';
  while (result.length < length) {
    const bytesNeeded = Math.max(length - result.length, 16);
    const randomBuffer = crypto.randomBytes(bytesNeeded);
    for (let i = 0; i < randomBuffer.length && result.length < length; i++) {
      const byte = randomBuffer[i];
      if (byte < 248) {
        result += BASE62_CHARS[byte % 62];
      }
    }
  }
  return result;
}

/**
 * Generates a cryptographically secure, non-enumerable obfuscated tenant slug.
 * Format: {brand_prefix}-{10_char_base62} (e.g., 'ecolife-k7m9x4w2')
 */
export function generateObfuscatedSlug(brandSlug: string): string {
  const cleanBrand = (brandSlug || '')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '')
    .slice(0, 32) || 'tenant';
  const token = generateCsprngBase62(10);
  return `${cleanBrand}-${token}`;
}
