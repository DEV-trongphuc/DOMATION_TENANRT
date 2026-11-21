import crypto from 'node:crypto';

export type SnsMessageType = 'Notification' | 'SubscriptionConfirmation' | 'UnsubscribeConfirmation';
export type SnsSignatureVersion = '1' | '2';

export interface SnsEnvelope {
  Type: SnsMessageType;
  MessageId: string;
  TopicArn: string;
  Message: string;
  Timestamp: string;
  SignatureVersion: SnsSignatureVersion;
  Signature: string;
  SigningCertURL: string;
  Subject?: string;
  SubscribeURL?: string;
  Token?: string;
  UnsubscribeURL?: string;
}

export interface SesEventBuildOptions {
  eventType: 'Bounce' | 'Complaint' | 'Delivery';
  bounceType?: 'Permanent' | 'Transient' | 'Undetermined';
  bounceSubType?: string;
  complaintFeedbackType?: string;
  recipients: string[];
  messageId?: string;
  sourceEmail?: string;
  subject?: string;
  timestamp?: string;
  diagnosticCode?: string;
}

export interface SignSnsOptions {
  signatureVersion?: SnsSignatureVersion;
  signingCertUrl?: string;
  tamperSignature?: boolean;
  tamperMessage?: string;
  omitSubject?: boolean;
  messageId?: string;
  topicArn?: string;
  timestamp?: string;
  subscribeUrl?: string;
  token?: string;
  unsubscribeUrl?: string;
  subject?: string;
}

export interface SignedSnsRequest {
  envelope: SnsEnvelope;
  rawBody: string;
  canonicalString: string;
  headers: Record<string, string>;
}

export interface SnsTestSignerOptions {
  region?: string;
  certId?: string;
  commonName?: string;
  topicArn?: string;
}

export interface SnsTestSigner {
  region: string;
  certId: string;
  topicArn: string;
  signingCertUrl: string;
  certPem: string;
  x509: crypto.X509Certificate;
  publicKey: crypto.KeyObject;
  privateKey: crypto.KeyObject;
  signEnvelope: (
    fields: Omit<Partial<SnsEnvelope>, 'Type' | 'Message'> & { Type: SnsMessageType; Message: string },
    opts?: SignSnsOptions
  ) => SignedSnsRequest;
  signNotification: (
    payload: string | Record<string, unknown> | SesEventBuildOptions,
    opts?: SignSnsOptions
  ) => SignedSnsRequest;
  signSubscriptionConfirmation: (opts?: SignSnsOptions & { message?: string }) => SignedSnsRequest;
  signUnsubscribeConfirmation: (opts?: SignSnsOptions & { message?: string }) => SignedSnsRequest;
  buildSesEventPayload: (opts: SesEventBuildOptions) => Record<string, unknown>;
}

// ============================================================================
// Pure Node.js ASN.1 DER X.509 v3 Self-Signed Certificate Builder
// ============================================================================

function derEncodeLength(len: number): Buffer {
  if (len < 0x80) return Buffer.from([len]);
  const bytes: number[] = [];
  let n = len;
  while (n > 0) {
    bytes.unshift(n & 0xff);
    n >>= 8;
  }
  return Buffer.from([0x80 | bytes.length, ...bytes]);
}

function derTag(tag: number, content: Buffer): Buffer {
  return Buffer.concat([Buffer.from([tag]), derEncodeLength(content.length), content]);
}

function derSequence(...items: Buffer[]): Buffer {
  return derTag(0x30, Buffer.concat(items));
}

function derSet(...items: Buffer[]): Buffer {
  return derTag(0x31, Buffer.concat(items));
}

function derInteger(value: number | bigint | Buffer): Buffer {
  let buf: Buffer;
  if (Buffer.isBuffer(value)) {
    buf = value;
  } else {
    let hex = BigInt(value).toString(16);
    if (hex.length % 2 !== 0) hex = `0${hex}`;
    buf = Buffer.from(hex, 'hex');
  }
  // Strip redundant leading 0x00 bytes for minimal DER INTEGER encoding
  let start = 0;
  while (start < buf.length - 1 && buf[start] === 0x00) {
    start += 1;
  }
  buf = buf.subarray(start);
  if (buf.length === 0) buf = Buffer.from([0x00]);
  // Positive INTEGER requires a single leading 0x00 if MSB is set
  if (buf[0] & 0x80) {
    buf = Buffer.concat([Buffer.from([0x00]), buf]);
  }
  return derTag(0x02, buf);
}

function derBitString(content: Buffer): Buffer {
  return derTag(0x03, Buffer.concat([Buffer.from([0x00]), content]));
}

function derNull(): Buffer {
  return Buffer.from([0x05, 0x00]);
}

function derOid(oid: string): Buffer {
  const parts = oid.split('.').map((p) => Number.parseInt(p, 10));
  const out: number[] = [parts[0] * 40 + parts[1]];
  for (let i = 2; i < parts.length; i++) {
    let v = parts[i];
    if (v === 0) {
      out.push(0);
      continue;
    }
    const octets: number[] = [];
    while (v > 0) {
      octets.unshift(v & 0x7f);
      v >>>= 7;
    }
    for (let j = 0; j < octets.length - 1; j++) {
      octets[j] |= 0x80;
    }
    out.push(...octets);
  }
  return derTag(0x06, Buffer.from(out));
}

function derUtf8String(text: string): Buffer {
  return derTag(0x0c, Buffer.from(text, 'utf8'));
}

function derUtcTime(date: Date): Buffer {
  const yy = String(date.getUTCFullYear() % 100).padStart(2, '0');
  const mm = String(date.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(date.getUTCDate()).padStart(2, '0');
  const hh = String(date.getUTCHours()).padStart(2, '0');
  const mi = String(date.getUTCMinutes()).padStart(2, '0');
  const ss = String(date.getUTCSeconds()).padStart(2, '0');
  return derTag(0x17, Buffer.from(`${yy}${mm}${dd}${hh}${mi}${ss}Z`, 'ascii'));
}

function derContextExplicit(tagNum: number, inner: Buffer): Buffer {
  return derTag(0xa0 | (tagNum & 0x1f), inner);
}

function generateSelfSignedX509Pem(
  publicKey: crypto.KeyObject,
  privateKey: crypto.KeyObject,
  commonName: string
): string {
  // OID 1.2.840.113549.1.1.11 = sha256WithRSAEncryption
  const sigAlgId = derSequence(derOid('1.2.840.113549.1.1.11'), derNull());
  // OID 2.5.4.3 = commonName
  const rdnName = derSequence(derSet(derSequence(derOid('2.5.4.3'), derUtf8String(commonName))));
  const serialBytes = crypto.randomBytes(12);
  serialBytes[0] = (serialBytes[0] & 0x7f) || 0x01;
  const serial = derInteger(serialBytes);
  const now = Date.now();
  const notBefore = new Date(now - 24 * 60 * 60 * 1000);
  const notAfter = new Date(now + 365 * 24 * 60 * 60 * 1000);
  const validity = derSequence(derUtcTime(notBefore), derUtcTime(notAfter));
  const spkiDer = publicKey.export({ type: 'spki', format: 'der' }) as Buffer;

  // Version [0] EXPLICIT INTEGER 2 (X.509 v3)
  const version = derContextExplicit(0, derInteger(2));
  // BasicConstraints extension OID 2.5.29.19 -> OCTET STRING(SEQUENCE {})
  const basicConstraintsExt = derSequence(derOid('2.5.29.19'), derTag(0x04, derSequence()));
  const extensions = derContextExplicit(3, derSequence(basicConstraintsExt));

  const tbsCertificate = derSequence(version, serial, sigAlgId, rdnName, validity, rdnName, spkiDer, extensions);
  const signature = crypto.sign('RSA-SHA256', tbsCertificate, privateKey);
  const certDer = derSequence(tbsCertificate, sigAlgId, derBitString(signature));

  const b64 = certDer.toString('base64');
  const lines: string[] = [];
  for (let i = 0; i < b64.length; i += 64) {
    lines.push(b64.slice(i, i + 64));
  }
  return `-----BEGIN CERTIFICATE-----\n${lines.join('\n')}\n-----END CERTIFICATE-----\n`;
}

// ============================================================================
// AWS SNS Canonical String-to-Sign & Envelope Builders
// ============================================================================

const NOTIFICATION_CANONICAL_KEYS = ['Message', 'MessageId', 'Subject', 'Timestamp', 'TopicArn', 'Type'] as const;
const CONFIRMATION_CANONICAL_KEYS = [
  'Message',
  'MessageId',
  'SubscribeURL',
  'Timestamp',
  'Token',
  'TopicArn',
  'Type',
] as const;

export function buildCanonicalSnsStringToSign(envelope: Record<string, unknown>): string {
  const type = String(envelope.Type || '');
  const keys =
    type === 'SubscriptionConfirmation' || type === 'UnsubscribeConfirmation'
      ? CONFIRMATION_CANONICAL_KEYS
      : NOTIFICATION_CANONICAL_KEYS;

  let out = '';
  for (const key of keys) {
    const val = envelope[key];
    if (val !== undefined && val !== null) {
      out += `${key}\n${String(val)}\n`;
    }
  }
  return out;
}

export function verifySnsEnvelopeSignature(envelope: SnsEnvelope, certPem: string): boolean {
  const canonical = buildCanonicalSnsStringToSign(envelope as unknown as Record<string, unknown>);
  const alg = envelope.SignatureVersion === '1' ? 'SHA1' : 'SHA256';
  const verifier = crypto.createVerify(alg);
  verifier.update(canonical, 'utf8');
  return verifier.verify(certPem, envelope.Signature, 'base64');
}

function isSesEventBuildOptions(v: unknown): v is SesEventBuildOptions {
  return (
    Boolean(v) &&
    typeof v === 'object' &&
    'eventType' in (v as Record<string, unknown>) &&
    Array.isArray((v as Record<string, unknown>).recipients)
  );
}

export function buildSesNotificationMessage(opts: SesEventBuildOptions): Record<string, unknown> {
  const timestamp = opts.timestamp || new Date().toISOString();
  const messageId = opts.messageId || `010001-${crypto.randomUUID()}-000000`;
  const sourceEmail = opts.sourceEmail || 'systemnoti@ideas.edu.vn';
  const subject = opts.subject || 'IDEAS Notification';

  const commonHeaders = {
    from: [sourceEmail],
    to: opts.recipients,
    messageId: `<${messageId}@ap-southeast-2.amazonses.com>`,
    subject,
  };

  const mail = {
    timestamp,
    source: sourceEmail,
    sourceArn: 'arn:aws:ses:ap-southeast-2:123456789012:identity/ideas.edu.vn',
    sendingAccountId: '123456789012',
    messageId,
    destination: opts.recipients,
    headersTruncated: false,
    headers: [
      { name: 'From', value: sourceEmail },
      { name: 'To', value: opts.recipients.join(', ') },
      { name: 'Subject', value: subject },
      { name: 'Message-ID', value: `<${messageId}@ap-southeast-2.amazonses.com>` },
    ],
    commonHeaders,
  };

  if (opts.eventType === 'Bounce') {
    const bounceType = opts.bounceType || 'Permanent';
    const bounceSubType =
      opts.bounceSubType || (bounceType === 'Permanent' ? 'General' : 'MailboxFull');
    return {
      notificationType: 'Bounce',
      eventType: 'Bounce',
      mail,
      bounce: {
        bounceType,
        bounceSubType,
        bouncedRecipients: opts.recipients.map((email) => ({
          emailAddress: email,
          action: bounceType === 'Permanent' ? 'failed' : 'delayed',
          status: bounceType === 'Permanent' ? '5.1.1' : '4.2.2',
          diagnosticCode:
            opts.diagnosticCode ||
            (bounceType === 'Permanent'
              ? 'smtp; 550 5.1.1 user unknown'
              : 'smtp; 452 4.2.2 Mailbox full'),
        })),
        timestamp,
        feedbackId: `010001-${crypto.randomUUID()}`,
        reportingMTA: 'dsn; a27-10.smtp-out.ap-southeast-2.amazonses.com',
      },
    };
  }

  if (opts.eventType === 'Complaint') {
    return {
      notificationType: 'Complaint',
      eventType: 'Complaint',
      mail,
      complaint: {
        complainedRecipients: opts.recipients.map((email) => ({ emailAddress: email })),
        timestamp,
        feedbackId: `010001-${crypto.randomUUID()}`,
        complaintSubType: null,
        complaintFeedbackType: opts.complaintFeedbackType || 'abuse',
        userAgent: 'Mozilla/5.0',
      },
    };
  }

  return {
    notificationType: 'Delivery',
    eventType: 'Delivery',
    mail,
    delivery: {
      timestamp,
      processingTimeMillis: 412,
      recipients: opts.recipients,
      smtpResponse: '250 2.0.0 Ok: queued as e2e-delivery-ok',
      reportingMTA: 'a27-10.smtp-out.ap-southeast-2.amazonses.com',
    },
  };
}

export function createSnsTestSigner(options: SnsTestSignerOptions = {}): SnsTestSigner {
  const region = options.region || 'ap-southeast-2';
  const certId = options.certId || `test-${crypto.randomUUID().slice(0, 8)}`;
  const commonName = options.commonName || `sns.${region}.amazonaws.com`;
  const topicArn = options.topicArn || `arn:aws:sns:${region}:123456789012:ideas-ses-events`;
  const signingCertUrl = `https://sns.${region}.amazonaws.com/SimpleNotificationService-${certId}.pem`;

  const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  const certPem = generateSelfSignedX509Pem(publicKey, privateKey, commonName);
  const x509 = new crypto.X509Certificate(certPem);

  const signEnvelope: SnsTestSigner['signEnvelope'] = (fields, opts = {}) => {
    const sigVersion: SnsSignatureVersion = opts.signatureVersion || '2';
    const messageId = opts.messageId || fields.MessageId || crypto.randomUUID();
    const timestamp = opts.timestamp || fields.Timestamp || new Date().toISOString();
    const resolvedTopicArn = opts.topicArn || fields.TopicArn || topicArn;
    const resolvedCertUrl = opts.signingCertUrl ?? fields.SigningCertURL ?? signingCertUrl;

    const envelope: SnsEnvelope = {
      Type: fields.Type,
      MessageId: messageId,
      TopicArn: resolvedTopicArn,
      Message: fields.Message,
      Timestamp: timestamp,
      SignatureVersion: sigVersion,
      Signature: '',
      SigningCertURL: resolvedCertUrl,
    };

    if (fields.Type === 'Notification') {
      if (!opts.omitSubject && (opts.subject !== undefined || fields.Subject !== undefined)) {
        envelope.Subject = opts.subject ?? fields.Subject;
      }
      if (opts.unsubscribeUrl || fields.UnsubscribeURL) {
        envelope.UnsubscribeURL = opts.unsubscribeUrl || fields.UnsubscribeURL;
      }
    } else {
      envelope.SubscribeURL =
        opts.subscribeUrl ??
        fields.SubscribeURL ??
        `https://sns.${region}.amazonaws.com/?Action=ConfirmSubscription&TopicArn=${encodeURIComponent(
          resolvedTopicArn
        )}&Token=test-token`;
      envelope.Token = opts.token ?? fields.Token ?? crypto.randomBytes(16).toString('hex');
    }

    const canonicalString = buildCanonicalSnsStringToSign(envelope as unknown as Record<string, unknown>);
    const alg = sigVersion === '1' ? 'SHA1' : 'SHA256';
    let signature = crypto.createSign(alg).update(canonicalString, 'utf8').sign(privateKey, 'base64');

    if (opts.tamperSignature) {
      const sigBuf = Buffer.from(signature, 'base64');
      sigBuf[0] ^= 0xff;
      sigBuf[1] ^= 0xff;
      signature = sigBuf.toString('base64');
    }
    envelope.Signature = signature;

    if (opts.tamperMessage !== undefined) {
      envelope.Message = opts.tamperMessage;
    }

    const rawBody = JSON.stringify(envelope);
    const headers: Record<string, string> = {
      'Content-Type': 'text/plain; charset=UTF-8',
      'x-amz-sns-message-type': envelope.Type,
      'x-amz-sns-message-id': envelope.MessageId,
      'x-amz-sns-topic-arn': envelope.TopicArn,
    };

    return { envelope, rawBody, canonicalString, headers };
  };

  const signNotification: SnsTestSigner['signNotification'] = (payload, opts = {}) => {
    const messageStr =
      typeof payload === 'string'
        ? payload
        : isSesEventBuildOptions(payload)
          ? JSON.stringify(buildSesNotificationMessage(payload))
          : JSON.stringify(payload);
    return signEnvelope(
      {
        Type: 'Notification',
        Message: messageStr,
        Subject: opts.subject,
      },
      opts
    );
  };

  const signSubscriptionConfirmation: SnsTestSigner['signSubscriptionConfirmation'] = (opts = {}) => {
    const resolvedTopic = opts.topicArn || topicArn;
    return signEnvelope(
      {
        Type: 'SubscriptionConfirmation',
        Message:
          opts.message ||
          `You have chosen to subscribe to the topic ${resolvedTopic}.\nTo confirm the subscription, visit the SubscribeURL included in this message.`,
      },
      opts
    );
  };

  const signUnsubscribeConfirmation: SnsTestSigner['signUnsubscribeConfirmation'] = (opts = {}) => {
    const resolvedTopic = opts.topicArn || topicArn;
    return signEnvelope(
      {
        Type: 'UnsubscribeConfirmation',
        Message:
          opts.message ||
          `You have chosen to deactivate subscription arn:aws:sns:${region}:123456789012:sub.\nTo re-subscribe, visit the SubscribeURL included in this message.`,
      },
      opts
    );
  };

  return {
    region,
    certId,
    topicArn,
    signingCertUrl,
    certPem,
    x509,
    publicKey,
    privateKey,
    signEnvelope,
    signNotification,
    signSubscriptionConfirmation,
    signUnsubscribeConfirmation,
    buildSesEventPayload: buildSesNotificationMessage,
  };
}

export function signSnsNotification(
  signer: SnsTestSigner,
  payload: string | Record<string, unknown> | SesEventBuildOptions,
  opts?: SignSnsOptions
): SignedSnsRequest {
  return signer.signNotification(payload, opts);
}
