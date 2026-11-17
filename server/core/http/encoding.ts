/**
 * RFC 9110 §12.5.3 compliant Accept-Encoding parser for `gzip` / `x-gzip`.
 * Honors explicit q-values (`gzip;q=0`, `*;q=0`) so clients opting out of compression
 * never receive gzip-encoded payloads.
 */
export function acceptsGzipEncoding(headerValue: string | undefined): boolean {
  if (!headerValue) return false;
  const raw = headerValue.trim();
  if (!raw) return false;

  let explicitGzipQ: number | null = null;
  let wildcardQ: number | null = null;

  const parts = raw.split(',');
  for (let i = 0; i < parts.length; i++) {
    const token = parts[i].trim();
    if (!token) continue;
    const segments = token.split(';');
    const coding = segments[0].trim().toLowerCase();
    let q = 1;

    for (let j = 1; j < segments.length; j++) {
      const param = segments[j].trim();
      if (param.length >= 2 && (param[0] === 'q' || param[0] === 'Q') && param[1] === '=') {
        const parsed = Number(param.slice(2).trim());
        if (Number.isFinite(parsed)) {
          q = Math.max(0, Math.min(1, parsed));
        }
      }
    }

    if (coding === 'gzip' || coding === 'x-gzip') {
      explicitGzipQ = explicitGzipQ === null ? q : Math.max(explicitGzipQ, q);
    } else if (coding === '*') {
      wildcardQ = wildcardQ === null ? q : Math.max(wildcardQ, q);
    }
  }

  if (explicitGzipQ !== null) {
    return explicitGzipQ > 0;
  }
  if (wildcardQ !== null) {
    return wildcardQ > 0;
  }
  return false;
}
