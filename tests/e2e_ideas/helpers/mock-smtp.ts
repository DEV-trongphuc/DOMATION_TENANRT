import net from 'node:net';

export interface CapturedSmtpMessage {
  id: string;
  mailFrom: string;
  rcptTo: string[];
  authMethod: string | null;
  authUser: string | null;
  authPass: string | null;
  subject: string;
  messageId: string | null;
  headers: Record<string, string>;
  text: string;
  html: string;
  raw: string;
  receivedAt: string;
}

export interface SmtpRejectMode {
  stage: 'auth' | 'mail_from' | 'rcpt_to' | 'data';
  code?: number;
  message?: string;
}

export interface MockSmtpServerOptions {
  host?: string;
  port?: number;
  expectedAuth?: { user: string; pass: string } | null;
}

export interface MockSmtpServer {
  host: string;
  port: number;
  messages: CapturedSmtpMessage[];
  clear: () => void;
  reset: () => void;
  setRejectMode: (mode: SmtpRejectMode | null) => void;
  setExpectedAuth: (auth: { user: string; pass: string } | null) => void;
  waitForMessages: (count: number, timeoutMs?: number) => Promise<CapturedSmtpMessage[]>;
  close: () => Promise<void>;
}

function stripEnvelopeAngleBrackets(raw: string): string {
  const trimmed = raw.trim();
  const match = trimmed.match(/^<([^>]*)>/);
  return match ? match[1].trim() : trimmed;
}

function decodeMimeWords(input: string): string {
  if (!input) return '';
  // Collapse whitespace between adjacent RFC 2047 encoded-words before decoding.
  const collapsed = input.replace(/(\?=)\s+(=\?)/g, '$1$2');
  return collapsed.replace(
    /=\?([A-Za-z0-9_-]+)\?([BQ])\?([^?]+)\?=/gi,
    (_full, charset: string, encoding: string, payload: string) => {
      const upperEnc = encoding.toUpperCase();
      if (upperEnc === 'B') {
        try {
          const buf = Buffer.from(payload, 'base64');
          return buf.toString(charset.toLowerCase() === 'utf-8' || charset.toLowerCase() === 'utf8' ? 'utf8' : 'utf8');
        } catch {
          return payload;
        }
      }
      if (upperEnc === 'Q') {
        const qp = payload.replace(/_/g, ' ');
        return decodeQuotedPrintable(qp);
      }
      return payload;
    }
  );
}

function decodeQuotedPrintable(input: string): string {
  const withoutSoftBreaks = input.replace(/=\r?\n/g, '');
  const bytes: number[] = [];
  for (let i = 0; i < withoutSoftBreaks.length; i++) {
    const ch = withoutSoftBreaks[i];
    if (ch === '=' && i + 2 < withoutSoftBreaks.length) {
      const hex = withoutSoftBreaks.slice(i + 1, i + 3);
      if (/^[0-9A-Fa-f]{2}$/.test(hex)) {
        bytes.push(Number.parseInt(hex, 16));
        i += 2;
        continue;
      }
    }
    const charBuf = Buffer.from(ch, 'utf8');
    for (const b of charBuf) bytes.push(b);
  }
  return Buffer.from(bytes).toString('utf8');
}

function parseHeadersBlock(headerBlock: string): Record<string, string> {
  const unfolded = headerBlock.replace(/\r?\n[ \t]+/g, ' ');
  const headers: Record<string, string> = {};
  for (const line of unfolded.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const colonIdx = line.indexOf(':');
    if (colonIdx <= 0) continue;
    const name = line.slice(0, colonIdx).trim().toLowerCase();
    const val = line.slice(colonIdx + 1).trim();
    headers[name] = val;
  }
  return headers;
}

function decodePartBody(rawBody: string, transferEncoding: string | undefined): string {
  const enc = (transferEncoding || '').trim().toLowerCase();
  if (enc === 'base64') {
    const cleaned = rawBody.replace(/[\r\n\s]+/g, '');
    if (!cleaned) return '';
    return Buffer.from(cleaned, 'base64').toString('utf8');
  }
  if (enc === 'quoted-printable') {
    return decodeQuotedPrintable(rawBody);
  }
  return rawBody.replace(/\r?\n$/, '');
}

function parseMimePayload(rawMessage: string): {
  headers: Record<string, string>;
  subject: string;
  messageId: string | null;
  text: string;
  html: string;
} {
  const sepMatch = rawMessage.match(/\r?\n\r?\n/);
  const headerBlock = sepMatch && sepMatch.index !== undefined ? rawMessage.slice(0, sepMatch.index) : rawMessage;
  const bodyBlock =
    sepMatch && sepMatch.index !== undefined ? rawMessage.slice(sepMatch.index + sepMatch[0].length) : '';

  const headers = parseHeadersBlock(headerBlock);
  const subject = decodeMimeWords(headers['subject'] || '');
  const rawMsgId = headers['message-id'] || '';
  const messageId = rawMsgId ? rawMsgId.replace(/^<|>$/g, '').trim() : null;

  const contentType = headers['content-type'] || '';
  const boundaryMatch = contentType.match(/boundary=(?:"([^"]+)"|([^;\s]+))/i);
  const boundary = boundaryMatch ? (boundaryMatch[1] || boundaryMatch[2] || '').trim() : '';

  let text = '';
  let html = '';

  if (boundary) {
    const delimiter = `--${boundary}`;
    const segments = bodyBlock.split(delimiter);
    for (const seg of segments) {
      const trimmedStart = seg.replace(/^\r?\n/, '');
      if (!trimmedStart || trimmedStart.startsWith('--')) continue;
      const partSep = trimmedStart.match(/\r?\n\r?\n/);
      if (!partSep || partSep.index === undefined) continue;
      const partHeaderBlock = trimmedStart.slice(0, partSep.index);
      const partBodyRaw = trimmedStart.slice(partSep.index + partSep[0].length).replace(/\r?\n$/, '');
      const partHeaders = parseHeadersBlock(partHeaderBlock);
      const partType = (partHeaders['content-type'] || '').toLowerCase();
      const decoded = decodePartBody(partBodyRaw, partHeaders['content-transfer-encoding']);
      if (partType.includes('text/plain') && !text) {
        text = decoded;
      } else if (partType.includes('text/html') && !html) {
        html = decoded;
      } else if (partType.includes('multipart/')) {
        const nested = parseMimePayload(`${partHeaderBlock}\r\n\r\n${partBodyRaw}`);
        if (!text && nested.text) text = nested.text;
        if (!html && nested.html) html = nested.html;
      }
    }
  } else {
    const decoded = decodePartBody(bodyBlock, headers['content-transfer-encoding']);
    if (contentType.toLowerCase().includes('text/html')) {
      html = decoded;
    } else {
      text = decoded;
    }
  }

  return { headers, subject, messageId, text, html };
}

function unstuffDotLines(rawData: string): string {
  if (!rawData) return '';
  return rawData
    .split('\r\n')
    .map((line) => (line.startsWith('..') ? line.slice(1) : line))
    .join('\r\n');
}

export async function startMockSmtpServer(options: MockSmtpServerOptions = {}): Promise<MockSmtpServer> {
  const host = options.host || '127.0.0.1';
  const requestedPort = options.port ?? 0;
  const messages: CapturedSmtpMessage[] = [];
  let rejectMode: SmtpRejectMode | null = null;
  let expectedAuth: { user: string; pass: string } | null = options.expectedAuth ?? null;
  let seq = 0;
  let closed = false;
  const waiters: Array<{
    targetCount: number;
    resolve: (msgs: CapturedSmtpMessage[]) => void;
    reject: (err: Error) => void;
    timer: NodeJS.Timeout;
  }> = [];

  const notifyWaiters = () => {
    for (let i = waiters.length - 1; i >= 0; i--) {
      if (messages.length >= waiters[i].targetCount) {
        const w = waiters.splice(i, 1)[0];
        clearTimeout(w.timer);
        w.resolve([...messages]);
      }
    }
  };

  const server = net.createServer((socket) => {
    socket.setEncoding('utf8');
    let mode: 'CMD' | 'DATA' | 'AUTH_PLAIN_WAIT' | 'AUTH_LOGIN_USER' | 'AUTH_LOGIN_PASS' = 'CMD';
    let cmdBuffer = '';
    let dataBuffer = '';
    let tx: {
      helo: string | null;
      authMethod: string | null;
      authUser: string | null;
      authPass: string | null;
      mailFrom: string | null;
      rcptTo: string[];
    } = {
      helo: null,
      authMethod: null,
      authUser: null,
      authPass: null,
      mailFrom: null,
      rcptTo: [],
    };

    const resetTx = (preserveAuth = true) => {
      tx = {
        helo: tx.helo,
        authMethod: preserveAuth ? tx.authMethod : null,
        authUser: preserveAuth ? tx.authUser : null,
        authPass: preserveAuth ? tx.authPass : null,
        mailFrom: null,
        rcptTo: [],
      };
    };

    const verifyAuth = (user: string, pass: string): boolean => {
      if (rejectMode?.stage === 'auth') return false;
      if (expectedAuth) {
        return user === expectedAuth.user && pass === expectedAuth.pass;
      }
      return true;
    };

    const handleCommandLine = (line: string) => {
      if (mode === 'AUTH_PLAIN_WAIT') {
        const decoded = Buffer.from(line.trim(), 'base64').toString('utf8');
        const parts = decoded.split('\0');
        const user = parts.length >= 3 ? parts[1] : parts[0] || '';
        const pass = parts.length >= 3 ? parts[2] : parts[1] || '';
        tx.authMethod = 'PLAIN';
        tx.authUser = user;
        tx.authPass = pass;
        mode = 'CMD';
        if (!verifyAuth(user, pass)) {
          socket.write(`${rejectMode?.code || 535} ${rejectMode?.message || '5.7.8 Authentication credentials invalid'}\r\n`);
          return;
        }
        socket.write('235 2.7.0 Authentication successful\r\n');
        return;
      }

      if (mode === 'AUTH_LOGIN_USER') {
        tx.authMethod = 'LOGIN';
        tx.authUser = Buffer.from(line.trim(), 'base64').toString('utf8');
        mode = 'AUTH_LOGIN_PASS';
        socket.write('334 UGFzc3dvcmQ6\r\n');
        return;
      }

      if (mode === 'AUTH_LOGIN_PASS') {
        tx.authPass = Buffer.from(line.trim(), 'base64').toString('utf8');
        mode = 'CMD';
        if (!verifyAuth(tx.authUser || '', tx.authPass || '')) {
          socket.write(`${rejectMode?.code || 535} ${rejectMode?.message || '5.7.8 Authentication credentials invalid'}\r\n`);
          return;
        }
        socket.write('235 2.7.0 Authentication successful\r\n');
        return;
      }

      const trimmed = line.trim();
      const upper = trimmed.toUpperCase();

      if (upper.startsWith('EHLO')) {
        tx.helo = trimmed.slice(4).trim() || 'localhost';
        socket.write('250-127.0.0.1 Hello\r\n250-SIZE 10485760\r\n250 AUTH PLAIN LOGIN\r\n');
        return;
      }

      if (upper.startsWith('HELO')) {
        tx.helo = trimmed.slice(4).trim() || 'localhost';
        socket.write('250 127.0.0.1 Hello\r\n');
        return;
      }

      if (upper.startsWith('AUTH PLAIN')) {
        const rest = trimmed.slice('AUTH PLAIN'.length).trim();
        if (!rest) {
          mode = 'AUTH_PLAIN_WAIT';
          socket.write('334 \r\n');
          return;
        }
        const decoded = Buffer.from(rest, 'base64').toString('utf8');
        const parts = decoded.split('\0');
        const user = parts.length >= 3 ? parts[1] : parts[0] || '';
        const pass = parts.length >= 3 ? parts[2] : parts[1] || '';
        tx.authMethod = 'PLAIN';
        tx.authUser = user;
        tx.authPass = pass;
        if (!verifyAuth(user, pass)) {
          socket.write(`${rejectMode?.code || 535} ${rejectMode?.message || '5.7.8 Authentication credentials invalid'}\r\n`);
          return;
        }
        socket.write('235 2.7.0 Authentication successful\r\n');
        return;
      }

      if (upper === 'AUTH LOGIN') {
        mode = 'AUTH_LOGIN_USER';
        socket.write('334 VXNlcm5hbWU6\r\n');
        return;
      }

      if (upper.startsWith('MAIL FROM:')) {
        if (rejectMode?.stage === 'mail_from') {
          socket.write(`${rejectMode.code || 550} ${rejectMode.message || '5.1.0 Sender rejected'}\r\n`);
          return;
        }
        tx.mailFrom = stripEnvelopeAngleBrackets(trimmed.slice('MAIL FROM:'.length));
        socket.write('250 2.1.0 Ok\r\n');
        return;
      }

      if (upper.startsWith('RCPT TO:')) {
        if (rejectMode?.stage === 'rcpt_to') {
          socket.write(`${rejectMode.code || 550} ${rejectMode.message || '5.1.1 Recipient rejected'}\r\n`);
          return;
        }
        tx.rcptTo.push(stripEnvelopeAngleBrackets(trimmed.slice('RCPT TO:'.length)));
        socket.write('250 2.1.5 Ok\r\n');
        return;
      }

      if (upper === 'DATA') {
        mode = 'DATA';
        dataBuffer = '';
        socket.write('354 End data with <CR><LF>.<CR><LF>\r\n');
        return;
      }

      if (upper === 'RSET') {
        resetTx(true);
        socket.write('250 2.0.0 Ok\r\n');
        return;
      }

      if (upper === 'NOOP') {
        socket.write('250 2.0.0 Ok\r\n');
        return;
      }

      if (upper === 'QUIT') {
        socket.write('221 2.0.0 Bye\r\n');
        socket.end();
        return;
      }

      socket.write('502 5.5.2 Command not implemented\r\n');
    };

    const processIncoming = () => {
      while (true) {
        if (mode === 'DATA') {
          let endIdx = -1;
          let terminatorLen = 0;
          if (dataBuffer.startsWith('.\r\n')) {
            endIdx = 0;
            terminatorLen = 3;
          } else {
            const idx = dataBuffer.indexOf('\r\n.\r\n');
            if (idx !== -1) {
              endIdx = idx;
              terminatorLen = 5;
            }
          }
          if (endIdx === -1) return;

          const stuffedRaw = endIdx === 0 ? '' : dataBuffer.slice(0, endIdx);
          const remainder = dataBuffer.slice(endIdx + terminatorLen);
          dataBuffer = '';
          mode = 'CMD';
          if (remainder) {
            cmdBuffer = remainder + cmdBuffer;
          }

          if (rejectMode?.stage === 'data') {
            resetTx(true);
            socket.write(`${rejectMode.code || 554} ${rejectMode.message || '5.6.0 Message rejected'}\r\n`);
            continue;
          }

          seq += 1;
          const queueId = `mock-smtp-${seq}`;
          const unstuffedRaw = unstuffDotLines(stuffedRaw);
          const parsed = parseMimePayload(unstuffedRaw);

          messages.push({
            id: queueId,
            mailFrom: tx.mailFrom || '',
            rcptTo: [...tx.rcptTo],
            authMethod: tx.authMethod,
            authUser: tx.authUser,
            authPass: tx.authPass,
            subject: parsed.subject,
            messageId: parsed.messageId,
            headers: parsed.headers,
            text: parsed.text,
            html: parsed.html,
            raw: unstuffedRaw,
            receivedAt: new Date().toISOString(),
          });
          resetTx(true);
          notifyWaiters();
          socket.write(`250 Ok ${queueId}\r\n`);
          continue;
        }

        const nlIdx = cmdBuffer.indexOf('\n');
        if (nlIdx === -1) return;
        const rawLine = cmdBuffer.slice(0, nlIdx).replace(/\r$/, '');
        cmdBuffer = cmdBuffer.slice(nlIdx + 1);
        handleCommandLine(rawLine);
        if ((mode as string) === 'DATA' && cmdBuffer.length > 0) {
          dataBuffer += cmdBuffer;
          cmdBuffer = '';
        }
      }
    };

    socket.on('data', (chunk: string) => {
      if (mode === 'DATA') {
        dataBuffer += chunk;
      } else {
        cmdBuffer += chunk;
      }
      processIncoming();
    });

    socket.on('error', () => {
      // Ignore abrupt client disconnect during tests
    });

    socket.write('220 127.0.0.1 ESMTP MockSmtp\r\n');
  });

  await new Promise<void>((resolve, reject) => {
    const onError = (err: Error) => {
      server.off('listening', onListening);
      reject(err);
    };
    const onListening = () => {
      server.off('error', onError);
      resolve();
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(requestedPort, host);
  });

  const addr = server.address();
  const port = typeof addr === 'object' && addr ? addr.port : requestedPort;

  const clear = () => {
    messages.length = 0;
  };

  return {
    host,
    port,
    messages,
    clear,
    reset: () => {
      clear();
      rejectMode = null;
      expectedAuth = options.expectedAuth ?? null;
    },
    setRejectMode: (mode) => {
      rejectMode = mode;
    },
    setExpectedAuth: (auth) => {
      expectedAuth = auth;
    },
    waitForMessages: (count: number, timeoutMs = 5000) => {
      if (messages.length >= count) {
        return Promise.resolve([...messages]);
      }
      if (closed) {
        return Promise.reject(new Error('MockSmtpServer is closed'));
      }
      return new Promise<CapturedSmtpMessage[]>((resolve, reject) => {
        const entry = {
          targetCount: count,
          resolve,
          reject,
          timer: setTimeout(() => {
            const idx = waiters.indexOf(entry);
            if (idx !== -1) waiters.splice(idx, 1);
            reject(
              new Error(`MockSmtpServer timed out after ${timeoutMs}ms waiting for ${count} message(s), got ${messages.length}`)
            );
          }, timeoutMs),
        };
        waiters.push(entry);
      });
    },
    close: async () => {
      if (closed) return;
      closed = true;
      while (waiters.length > 0) {
        const w = waiters.pop()!;
        clearTimeout(w.timer);
        w.reject(new Error('MockSmtpServer closed while waiting for messages'));
      }
      (server as net.Server & { closeAllConnections?: () => void }).closeAllConnections?.();
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
      });
    },
  };
}
