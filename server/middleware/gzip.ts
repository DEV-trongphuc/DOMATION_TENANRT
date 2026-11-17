import zlib from 'node:zlib';
import type { Request, Response, NextFunction } from 'express';
import { acceptsGzipEncoding } from '../core/http/encoding.ts';

/**
 * High-concurrency async libuv-threadpool Gzip compression for API JSON / CSV / HTML / text payloads > 1KB.
 * Max concurrency increased from 16 to 128 to prevent compression dropping during heavy concurrent bursts.
 */
export const MAX_INFLIGHT_GZIP = 128;
let inflightGzip = 0;

export function gzipMiddleware(req: Request, res: Response, next: NextFunction): void {
  const clientAcceptsGzip =
    req.method !== 'HEAD' && acceptsGzipEncoding(String(req.headers['accept-encoding'] || ''));

  const origSend = res.send.bind(res);
  res.send = ((body?: any): any => {
    if (
      res.headersSent ||
      res.getHeader('Content-Encoding') ||
      (typeof body !== 'string' && !Buffer.isBuffer(body))
    ) {
      return origSend(body);
    }

    const existingContentType = String(res.getHeader('Content-Type') || '');
    const lowerContentType = existingContentType.toLowerCase();
    const isUnsetStringHtml = !existingContentType && typeof body === 'string';
    const isCompressible =
      isUnsetStringHtml ||
      lowerContentType.includes('json') ||
      lowerContentType.includes('text/') ||
      lowerContentType.includes('javascript') ||
      lowerContentType.includes('xml') ||
      lowerContentType.includes('svg');

    if (!isCompressible) {
      return origSend(body);
    }

    // Always advertise Vary: Accept-Encoding on compressible payloads regardless of size or client header
    res.vary('Accept-Encoding');

    if (!clientAcceptsGzip) {
      return origSend(body);
    }

    const byteLen = Buffer.isBuffer(body) ? body.length : Buffer.byteLength(body, 'utf8');
    if (byteLen < 1024 || inflightGzip >= MAX_INFLIGHT_GZIP) {
      return origSend(body);
    }

    const rawBuf = Buffer.isBuffer(body) ? body : Buffer.from(body, 'utf8');
    inflightGzip += 1;
    zlib.gzip(rawBuf, { level: zlib.constants.Z_BEST_SPEED }, (err, compressed) => {
      inflightGzip = Math.max(0, inflightGzip - 1);
      if (res.writableEnded || res.destroyed) return;
      if (err || res.headersSent) {
        origSend(body);
        return;
      }
      if (isUnsetStringHtml && !res.getHeader('Content-Type')) {
        res.setHeader('Content-Type', 'text/html; charset=utf-8');
      }
      res.setHeader('Content-Encoding', 'gzip');
      res.removeHeader('Content-Length');
      origSend(compressed);
    });
    return res;
  }) as typeof res.send;

  next();
}
