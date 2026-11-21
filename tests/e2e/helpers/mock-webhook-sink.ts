import http, { type Server } from 'node:http';

export interface CapturedWebhookDelivery {
  method: string;
  url: string;
  headers: Record<string, string | string[] | undefined>;
  rawBody: string;
  json: any;
  receivedAt: string;
}

export interface MockWebhookSink {
  url: string;
  port: number;
  setStatus: (statusCode: number) => void;
  getDeliveries: () => CapturedWebhookDelivery[];
  clearDeliveries: () => void;
  waitForDeliveries: (minCount: number, timeoutMs?: number) => Promise<CapturedWebhookDelivery[]>;
  close: () => Promise<void>;
}

export async function startMockWebhookSink(initialStatus = 200): Promise<MockWebhookSink> {
  let responseStatus = initialStatus;
  const deliveries: CapturedWebhookDelivery[] = [];

  const server: Server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c) => chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c)));
    req.on('end', () => {
      const rawBody = Buffer.concat(chunks).toString('utf8');
      let json: any = null;
      try {
        json = rawBody ? JSON.parse(rawBody) : null;
      } catch {
        json = null;
      }
      deliveries.push({
        method: req.method || 'POST',
        url: req.url || '/',
        headers: req.headers,
        rawBody,
        json,
        receivedAt: new Date().toISOString(),
      });

      res.statusCode = responseStatus;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ ok: responseStatus >= 200 && responseStatus < 300, status: responseStatus }));
    });
  });

  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const addr = server.address();
  const port = typeof addr === 'object' && addr ? addr.port : 0;

  return {
    url: `http://127.0.0.1:${port}/webhook-sink`,
    port,
    setStatus(statusCode: number) {
      responseStatus = statusCode;
    },
    getDeliveries() {
      return [...deliveries];
    },
    clearDeliveries() {
      deliveries.length = 0;
    },
    async waitForDeliveries(minCount: number, timeoutMs = 4000) {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        if (deliveries.length >= minCount) {
          return [...deliveries];
        }
        await new Promise((r) => setTimeout(r, 25));
      }
      return [...deliveries];
    },
    async close() {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
