import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { apiRequest, startTestServer, type TestHarness } from './helpers.ts';
import { APP_CONFIG } from '../server/config.ts';
import { tenantRedis } from '../server/core/cache/tenant-redis.ts';
import { withTenantTransaction } from '../server/core/database/transaction.ts';
import { resolveTenantEntitlementSnapshot } from '../server/core/security/entitlements.ts';
import { ALL_CRON_SUBROUTINES, shouldRefuseDirectCliPglite } from '../server/cron/master-cron.ts';
import { runMarketingCampaignsWorker } from '../server/cron/subroutines/wave2-workers.ts';
import { upsertMasterContactInTx } from '../server/modules/audiences/audiences.service.ts';
import { executeFlowForLead } from '../server/modules/marketing/flow-engine.service.ts';
import { resolvePublicRequestOrigin } from '../server/modules/marketing/utils.ts';
import {
  buildSnsStringToSign,
  clearSnsCertCacheForTesting,
  isValidAwsSnsUrl,
  setSnsHttpFetcherForTesting,
  type SnsEnvelope,
} from '../server/services/ses-sns.service.ts';
import { sendRawSmtpMail, sendZaloBotNotification } from '../server/services/zalo-mail.service.ts';
import { setZnsTransportForTesting } from '../server/services/zalo-zns.service.ts';

function derLen(len: number): Buffer {
  if (len < 0x80) return Buffer.from([len]);
  if (len < 0x100) return Buffer.from([0x81, len]);
  return Buffer.from([0x82, (len >> 8) & 0xff, len & 0xff]);
}

function derWrap(tag: number, content: Buffer): Buffer {
  return Buffer.concat([Buffer.from([tag]), derLen(content.length), content]);
}

function derInt(bytes: Buffer): Buffer {
  let b = bytes;
  while (b.length > 1 && b[0] === 0) b = b.subarray(1);
  if (b[0] & 0x80) b = Buffer.concat([Buffer.from([0]), b]);
  return derWrap(0x02, b);
}

function generateSelfSignedRsaCert(): {
  privateKey: crypto.KeyObject;
  certPem: string;
} {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', {
    modulusLength: 2048,
  });
  const spkiDer = publicKey.export({ type: 'spki', format: 'der' });
  const algId = Buffer.from('300d06092a864886f70d01010b0500', 'hex'); // sha256WithRSAEncryption
  const cnAttr = derWrap(
    0x30,
    Buffer.concat([
      Buffer.from('0603550403', 'hex'), // OID 2.5.4.3 (CN)
      derWrap(0x0c, Buffer.from('sns.ap-southeast-2.amazonaws.com', 'utf8')),
    ])
  );
  const rdnName = derWrap(0x30, derWrap(0x31, cnAttr));
  const validity = derWrap(
    0x30,
    Buffer.concat([
      derWrap(0x17, Buffer.from('240101000000Z', 'ascii')),
      derWrap(0x17, Buffer.from('350101000000Z', 'ascii')),
    ])
  );
  const version0 = derWrap(0xa0, derInt(Buffer.from([0x02]))); // v3
  const serial = derInt(crypto.randomBytes(8));
  const tbsCert = derWrap(
    0x30,
    Buffer.concat([version0, serial, algId, rdnName, validity, rdnName, spkiDer])
  );
  const sig = crypto.sign('sha256', tbsCert, privateKey);
  const certDer = derWrap(
    0x30,
    Buffer.concat([tbsCert, algId, derWrap(0x03, Buffer.concat([Buffer.from([0x00]), sig]))])
  );
  const b64Lines = certDer.toString('base64').match(/.{1,64}/g)?.join('\n') || '';
  const certPem = `-----BEGIN CERTIFICATE-----\n${b64Lines}\n-----END CERTIFICATE-----\n`;
  return { privateKey, certPem };
}

function signSnsEnvelope(
  base: Omit<SnsEnvelope, 'Signature'>,
  privateKey: crypto.KeyObject
): SnsEnvelope {
  const full: SnsEnvelope = { ...base, Signature: '' };
  const sts = buildSnsStringToSign(full);
  const algo = full.SignatureVersion === '2' ? 'sha256' : 'sha1';
  const signer = crypto.createSign(algo);
  signer.update(sts, 'utf8');
  full.Signature = signer.sign(privateKey, 'base64');
  return full;
}

describe('M1 Cutover, /uploadss, AWS SES/SNS Webhook, Master Cron Safety & ZaloBot Exclusion', () => {
  let harness: TestHarness;
  let tenantA: { id: string; slug: string; token: string };
  let tenantB: { id: string; slug: string; token: string };
  let tempUploadsDir = '';
  let tempPgLockDir = '';
  const origAppPublicUrl = process.env.APP_PUBLIC_URL;
  const origNodeEnv = process.env.NODE_ENV;
  const origUploadsDir = process.env.UPLOADS_DIR;
  const origSilentMode = process.env.OUTBOUND_SILENT_MODE;
  const { privateKey: snsPrivKey, certPem: snsCertPem } = generateSelfSignedRsaCert();
  const testCertUrl = 'https://sns.ap-southeast-2.amazonaws.com/SimpleNotificationService-test-m1.pem';

  before(async () => {
    tempUploadsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'autodata-m1-uploads-'));
    tempPgLockDir = fs.mkdtempSync(path.join(os.tmpdir(), 'autodata-m1-pglock-'));
    process.env.UPLOADS_DIR = tempUploadsDir;

    harness = await startTestServer();

    const regA = await apiRequest(harness.baseUrl, '/api/v1/auth/register', {
      method: 'POST',
      body: {
        company_name: 'M1 Cutover Ideas Test',
        tenant_slug: 'm1-cutover-a',
        admin_name: 'Admin A',
        work_email: 'admin-a@m1cutover.vn',
        phone: '0901000111',
        password: 'SecurePassword123!',
        industry: 'education',
        seed_demo_leads: false,
      },
    });
    assert.equal(regA.status, 201);
    tenantA = {
      id: regA.json.data.tenant.id,
      slug: regA.json.data.tenant.slug,
      token: regA.json.data.access_token,
    };

    const regB = await apiRequest(harness.baseUrl, '/api/v1/auth/register', {
      method: 'POST',
      body: {
        company_name: 'M1 Cutover Beta Test',
        tenant_slug: 'm1-cutover-b',
        admin_name: 'Admin B',
        work_email: 'admin-b@m1cutover.vn',
        phone: '0902000222',
        password: 'SecurePassword123!',
        industry: 'retail',
        seed_demo_leads: false,
      },
    });
    assert.equal(regB.status, 201);
    tenantB = {
      id: regB.json.data.tenant.id,
      slug: regB.json.data.tenant.slug,
      token: regB.json.data.access_token,
    };

    for (const t of [tenantA, tenantB]) {
      await withTenantTransaction(t.id, async (client) => {
        await client.query('UPDATE tenants SET wallet_balance_vnd = 50000000 WHERE id = $1', [t.id]);
      });
      const sw = await apiRequest(harness.baseUrl, '/api/v1/billing/switch-package', {
        method: 'POST',
        token: t.token,
        tenantSlug: t.slug,
        body: { package_code: 'growth_combo', payment_method: 'wallet', billing_cycle: 'monthly' },
      });
      assert.equal(sw.status, 200);
    }
  });

  after(async () => {
    setSnsHttpFetcherForTesting(null);
    clearSnsCertCacheForTesting();
    setZnsTransportForTesting(null);

    if (origAppPublicUrl === undefined) delete process.env.APP_PUBLIC_URL;
    else process.env.APP_PUBLIC_URL = origAppPublicUrl;

    if (origNodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = origNodeEnv;

    if (origUploadsDir === undefined) delete process.env.UPLOADS_DIR;
    else process.env.UPLOADS_DIR = origUploadsDir;

    if (origSilentMode === undefined) delete process.env.OUTBOUND_SILENT_MODE;
    else process.env.OUTBOUND_SILENT_MODE = origSilentMode;

    await harness.close();
    if (tempUploadsDir) fs.rmSync(tempUploadsDir, { recursive: true, force: true });
    if (tempPgLockDir) fs.rmSync(tempPgLockDir, { recursive: true, force: true });
  });

  it('1. Domain Cutover (APP_PUBLIC_URL, resolvePublicRequestOrigin, forms embed-config) & /uploadss static + traversal protection', async () => {
    // 1a. resolvePublicRequestOrigin without req
    process.env.APP_PUBLIC_URL = 'https://data.domation.net/';
    process.env.NODE_ENV = 'test';
    assert.equal(resolvePublicRequestOrigin(), 'https://data.domation.net');

    delete process.env.APP_PUBLIC_URL;
    process.env.NODE_ENV = 'production';
    assert.equal(resolvePublicRequestOrigin(), 'https://data.domation.net');

    process.env.NODE_ENV = 'development';
    assert.equal(
      resolvePublicRequestOrigin(undefined, 'https://custom.domation.net/'),
      'https://custom.domation.net'
    );
    assert.match(resolvePublicRequestOrigin(), /^http:\/\/127\.0\.0\.1:\d+$/);

    // Local test request keeps local host even when APP_PUBLIC_URL is set
    process.env.APP_PUBLIC_URL = 'https://data.domation.net';
    assert.equal(
      resolvePublicRequestOrigin({ headers: { host: '127.0.0.1:4567' }, protocol: 'http' }),
      'http://127.0.0.1:4567'
    );
    assert.equal(
      resolvePublicRequestOrigin({
        headers: { host: 'data.domation.net', 'x-forwarded-proto': 'https' },
        protocol: 'http',
      }),
      'https://data.domation.net'
    );

    // 1b. forms/:id/embed-config emits data.domation.net and zero app.domation.net
    const formCreate = await apiRequest(harness.baseUrl, '/api/v1/marketing/forms', {
      method: 'POST',
      token: tenantA.token,
      tenantSlug: tenantA.slug,
      body: {
        name: 'IDEAS Cutover Form',
        routing_mode: 'marketing_nurture',
        fields: [{ id: 'f1', key: 'email', label: 'Email', type: 'email', required: true }],
      },
    });
    assert.equal(formCreate.status, 201);
    const formId = formCreate.json.data.id;

    const embedRes = await apiRequest(harness.baseUrl, `/api/v1/marketing/forms/${formId}/embed-config`, {
      token: tenantA.token,
      tenantSlug: tenantA.slug,
      headers: {
        'X-Forwarded-Host': 'data.domation.net',
        'X-Forwarded-Proto': 'https',
      },
    });
    assert.equal(embedRes.status, 200);
    const snippets = embedRes.json.data.snippets;
    for (const key of ['iframe', 'popup_modal', 'floating_bar', 'slide_in']) {
      assert.ok(String(snippets[key]).includes('https://data.domation.net/'), `${key} must use data.domation.net`);
      assert.ok(!String(snippets[key]).includes('app.domation.net'), `${key} must not contain app.domation.net`);
    }

    // 1b-reg. Production origin spoofing prevention (X-Forwarded-Host: localhost:9999 & evil.com)
    process.env.NODE_ENV = 'production';
    process.env.APP_PUBLIC_URL = 'https://data.domation.net';
    assert.equal(
      resolvePublicRequestOrigin({
        headers: { 'x-forwarded-host': 'localhost:9999', 'x-forwarded-proto': 'http' },
        protocol: 'http',
      }),
      'https://data.domation.net'
    );
    const spoofLocalEmbed = await apiRequest(harness.baseUrl, `/api/v1/marketing/forms/${formId}/embed-config`, {
      token: tenantA.token,
      tenantSlug: tenantA.slug,
      headers: {
        'X-Forwarded-Host': 'localhost:9999',
        'X-Forwarded-Proto': 'http',
      },
    });
    assert.equal(spoofLocalEmbed.status, 200);
    assert.ok(String(spoofLocalEmbed.json.data.snippets.iframe).includes('https://data.domation.net/'));
    assert.ok(!String(spoofLocalEmbed.json.data.snippets.iframe).includes('localhost:9999'));

    delete process.env.APP_PUBLIC_URL;
    assert.equal(
      resolvePublicRequestOrigin({
        headers: { 'x-forwarded-host': 'evil.com', 'x-forwarded-proto': 'https' },
        protocol: 'http',
      }),
      'https://data.domation.net'
    );
    const spoofEvilEmbed = await apiRequest(harness.baseUrl, `/api/v1/marketing/forms/${formId}/embed-config`, {
      token: tenantA.token,
      tenantSlug: tenantA.slug,
      headers: {
        'X-Forwarded-Host': 'evil.com',
        'X-Forwarded-Proto': 'https',
      },
    });
    assert.equal(spoofEvilEmbed.status, 200);
    assert.ok(String(spoofEvilEmbed.json.data.snippets.iframe).includes('https://data.domation.net/'));
    assert.ok(!String(spoofEvilEmbed.json.data.snippets.iframe).includes('evil.com'));

    if (origAppPublicUrl === undefined) delete process.env.APP_PUBLIC_URL;
    else process.env.APP_PUBLIC_URL = origAppPublicUrl;
    process.env.NODE_ENV = origNodeEnv || 'test';

    // 1c. /uploadss static serving, CORS, non-image media on data.* host, 404 on missing, 403 on traversal
    fs.mkdirSync(path.join(tempUploadsDir, 'ai_generated'), { recursive: true });
    fs.writeFileSync(path.join(tempUploadsDir, 'ai_generated', 'banner.png'), 'PNG_BINARY_STUB');
    fs.writeFileSync(path.join(tempUploadsDir, 'export.csv'), 'col1,col2\n1,2\n');

    const imgResp = await fetch(`${harness.baseUrl}/uploadss/ai_generated/banner.png`);
    assert.equal(imgResp.status, 200);
    assert.equal(imgResp.headers.get('access-control-allow-origin'), '*');
    assert.equal(await imgResp.text(), 'PNG_BINARY_STUB');

    const csvResp = await fetch(`${harness.baseUrl}/uploadss/export.csv`, {
      headers: { 'X-Forwarded-Host': 'data.domation.net' },
    });
    assert.equal(csvResp.status, 200);
    assert.equal(await csvResp.text(), 'col1,col2\n1,2\n');

    const missingResp = await fetch(`${harness.baseUrl}/uploadss/not-found.png`);
    assert.equal(missingResp.status, 404);
    assert.equal(await missingResp.text(), '');

    const rawGetStatus = (reqPath: string) =>
      new Promise<number>((resolve, reject) => {
        const u = new URL(harness.baseUrl);
        const req = http.request(
          { hostname: u.hostname, port: Number(u.port), path: reqPath, method: 'GET' },
          (res) => {
            res.resume();
            resolve(res.statusCode || 0);
          }
        );
        req.on('error', reject);
        req.end();
      });

    assert.equal(await rawGetStatus('/uploadss/%2e%2e/.env'), 403);
    assert.equal(await rawGetStatus('/uploadss/../.env'), 403);

    // 1d. Config & deploy script checks
    const envExample = fs.readFileSync(path.resolve('.env.example'), 'utf8');
    assert.ok(envExample.includes('APP_PUBLIC_URL=https://data.domation.net'));
    assert.ok(envExample.includes('CRON_SECRET='));

    const htaccess = fs.readFileSync(path.resolve('.htaccess'), 'utf8');
    assert.ok(htaccess.includes('RewriteCond %{REQUEST_URI} ^/uploadss/'));
    assert.ok(htaccess.includes('RewriteRule ^(.*)$ public/$1 [L]'));

    const deployPy = fs.readFileSync(path.resolve('scripts/deploy-direct.py'), 'utf8');
    assert.ok(deployPy.includes('APP_PUBLIC_URL='));
    assert.ok(deployPy.includes('input=env_payload.encode("utf-8")'));
    assert.ok(!deployPy.includes('input=env_payload,\n            text=True'));

    process.env.NODE_ENV = origNodeEnv || 'test';
  });

  it('2. AWS SES/SNS Security Rejections, Real RSA X.509 Verification (SHA1/SHA256), text/plain + JSON, SubscriptionConfirmation & HMAC rawBody Regression', async () => {
    clearSnsCertCacheForTesting();
    const fetchedUrls: string[] = [];
    setSnsHttpFetcherForTesting(async (url) => {
      fetchedUrls.push(url);
      if (url === testCertUrl) {
        return { ok: true, status: 200, text: async () => snsCertPem };
      }
      if (url.startsWith('https://sns.ap-southeast-2.amazonaws.com/?Action=ConfirmSubscription')) {
        return { ok: true, status: 200, text: async () => '<ConfirmSubscriptionResponse/>' };
      }
      return { ok: false, status: 404, text: async () => 'Not Found' };
    });

    // 2a. URL validation unit checks
    assert.equal(isValidAwsSnsUrl(testCertUrl, true), true);
    assert.equal(isValidAwsSnsUrl('http://sns.ap-southeast-2.amazonaws.com/cert.pem', true), false);
    assert.equal(isValidAwsSnsUrl('https://evil.com/cert.pem', true), false);
    assert.equal(isValidAwsSnsUrl('https://sns.ap-southeast-2.amazonaws.com/../evil.pem', true), false);
    assert.equal(isValidAwsSnsUrl('https://sns.ap-southeast-2.amazonaws.com/%2e%2e/evil.pem', true), false);
    assert.equal(isValidAwsSnsUrl('https://sns.ap-southeast-2.amazonaws.com/cert.txt', true), false);
    assert.equal(isValidAwsSnsUrl('https://sns.ap-southeast-2.amazonaws.com/cert.pem?q=1', true), false);
    assert.equal(isValidAwsSnsUrl('https://user:pass@sns.ap-southeast-2.amazonaws.com/cert.pem', true), false);
    assert.equal(isValidAwsSnsUrl('https://sns.us-east-1.amazonaws.com/foo%5cbar.pem', true), false);
    assert.equal(isValidAwsSnsUrl('https://sns.us-east-1.amazonaws.com/foo%00bar.pem', true), false);

    // 2b. Malformed JSON & missing envelope fields -> 400
    const badJson = await apiRequest(harness.baseUrl, '/api/v1/webhooks/ses-sns', {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain; charset=UTF-8' },
      body: '{not-valid-json',
    });
    assert.equal(badJson.status, 400);

    const missingFields = await apiRequest(harness.baseUrl, '/api/v1/webhooks/ses-sns', {
      method: 'POST',
      body: { Type: 'Notification' },
    });
    assert.equal(missingFields.status, 400);

    // 2c. Invalid SigningCertURL -> 403
    const badCertUrlEnv = signSnsEnvelope(
      {
        Type: 'Notification',
        MessageId: crypto.randomUUID(),
        TopicArn: 'arn:aws:sns:ap-southeast-2:123456789012:ses-events',
        Message: JSON.stringify({ notificationType: 'Delivery' }),
        Timestamp: new Date().toISOString(),
        SignatureVersion: '1',
        SigningCertURL: 'https://evil.example.com/cert.pem',
      },
      snsPrivKey
    );
    const badCertRes = await apiRequest(harness.baseUrl, '/api/v1/webhooks/ses-sns', {
      method: 'POST',
      body: badCertUrlEnv,
    });
    assert.equal(badCertRes.status, 403);

    // 2d. Unsupported SignatureVersion -> 403
    const badVerEnv = signSnsEnvelope(
      {
        Type: 'Notification',
        MessageId: crypto.randomUUID(),
        TopicArn: 'arn:aws:sns:ap-southeast-2:123456789012:ses-events',
        Message: JSON.stringify({ notificationType: 'Delivery' }),
        Timestamp: new Date().toISOString(),
        SignatureVersion: '3',
        SigningCertURL: testCertUrl,
      },
      snsPrivKey
    );
    const badVerRes = await apiRequest(harness.baseUrl, '/api/v1/webhooks/ses-sns', {
      method: 'POST',
      body: badVerEnv,
    });
    assert.equal(badVerRes.status, 403);

    // 2e. Tampered Message for both SHA1 ('1') & SHA256 ('2') -> 403
    for (const sigVer of ['1', '2']) {
      const signed = signSnsEnvelope(
        {
          Type: 'Notification',
          MessageId: crypto.randomUUID(),
          TopicArn: 'arn:aws:sns:ap-southeast-2:123456789012:ses-events',
          Subject: 'Amazon SES Email Event Notification',
          Message: JSON.stringify({ notificationType: 'AmazonSnsSubscriptionSucceeded' }),
          Timestamp: new Date().toISOString(),
          SignatureVersion: sigVer,
          SigningCertURL: testCertUrl,
        },
        snsPrivKey
      );
      const tampered = { ...signed, Message: JSON.stringify({ notificationType: 'Tampered' }) };
      const resTampered = await apiRequest(harness.baseUrl, '/api/v1/webhooks/ses-sns', {
        method: 'POST',
        headers: { 'Content-Type': 'text/plain; charset=UTF-8' },
        body: JSON.stringify(tampered),
      });
      assert.equal(resTampered.status, 403, `Tampered SigV${sigVer} must return 403`);
    }

    // 2f. Valid SubscriptionConfirmation -> confirms SubscribeURL & returns 200
    const subscribeUrl = 'https://sns.ap-southeast-2.amazonaws.com/?Action=ConfirmSubscription&TopicArn=arn:aws:sns:ap-southeast-2:123:ses&Token=tok123';
    const subConfirmEnv = signSnsEnvelope(
      {
        Type: 'SubscriptionConfirmation',
        MessageId: crypto.randomUUID(),
        TopicArn: 'arn:aws:sns:ap-southeast-2:123456789012:ses-events',
        Token: 'tok123',
        Message: 'You have chosen to subscribe to the topic.',
        SubscribeURL: subscribeUrl,
        Timestamp: new Date().toISOString(),
        SignatureVersion: '2',
        SigningCertURL: testCertUrl,
      },
      snsPrivKey
    );
    const subRes = await apiRequest(harness.baseUrl, '/api/v1/webhooks/ses-sns', {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain; charset=UTF-8' },
      body: JSON.stringify(subConfirmEnv),
    });
    assert.equal(subRes.status, 200);
    assert.equal(subRes.json.data.confirmed, true);
    assert.ok(fetchedUrls.includes(subscribeUrl));

    // Forged SubscribeURL (even validly signed!) -> 403
    const forgedSubEnv = signSnsEnvelope(
      {
        Type: 'SubscriptionConfirmation',
        MessageId: crypto.randomUUID(),
        TopicArn: 'arn:aws:sns:ap-southeast-2:123456789012:ses-events',
        Token: 'tok123',
        Message: 'Subscribe',
        SubscribeURL: 'https://evil.com/steal-token',
        Timestamp: new Date().toISOString(),
        SignatureVersion: '1',
        SigningCertURL: testCertUrl,
      },
      snsPrivKey
    );
    const forgedSubRes = await apiRequest(harness.baseUrl, '/api/v1/webhooks/ses-sns', {
      method: 'POST',
      body: forgedSubEnv,
    });
    assert.equal(forgedSubRes.status, 403);

    // 2g. Alias /api/v1/public/marketing/sns-webhook with application/json & SignatureVersion '1' (SHA1)
    const pingEnv = signSnsEnvelope(
      {
        Type: 'Notification',
        MessageId: crypto.randomUUID(),
        TopicArn: 'arn:aws:sns:ap-southeast-2:123456789012:ses-events',
        Message: JSON.stringify({ notificationType: 'AmazonSnsSubscriptionSucceeded' }),
        Timestamp: new Date().toISOString(),
        SignatureVersion: '1',
        SigningCertURL: testCertUrl,
      },
      snsPrivKey
    );
    const aliasRes = await apiRequest(harness.baseUrl, '/api/v1/public/marketing/sns-webhook', {
      method: 'POST',
      body: pingEnv,
    });
    assert.equal(aliasRes.status, 200);

    // 2h. Regression check: existing tenant HMAC rawBody webhook still works cleanly
    const whCreate = await apiRequest(harness.baseUrl, '/api/v1/integrations/webhooks', {
      method: 'POST',
      token: tenantA.token,
      tenantSlug: tenantA.slug,
      body: {
        name: 'M1 HMAC Regression',
        webhook_type: 'inbound',
        is_active: true,
      },
    });
    assert.equal(whCreate.status, 201);
    const connToken = String(whCreate.json.data.token);
    const connSecret = String(whCreate.json.data.signing_secret);
    const rawWebhookPayload = JSON.stringify({
      name: 'HMAC Regression Lead',
      phone: '0908999777',
      email: 'hmac-reg@m1.vn',
    });
    const sig = crypto.createHmac('sha256', connSecret).update(rawWebhookPayload).digest('hex');
    const hmacRes = await apiRequest(harness.baseUrl, `/api/v1/webhooks/${tenantA.slug}/${connToken}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Webhook-Signature': `sha256=${sig}`,
      },
      body: rawWebhookPayload,
    });
    assert.equal(hmacRes.status, 202);
  });

  it('3. SES Bounce (Permanent & Transient), Complaint, Delivery, Non-Downgrade, Idempotency, Flow Correlation, SES SMTP 250 Ok & /ses-quota', async () => {
    clearSnsCertCacheForTesting();
    setSnsHttpFetcherForTesting(async (url) => {
      if (url === testCertUrl) return { ok: true, status: 200, text: async () => snsCertPem };
      return { ok: false, status: 404, text: async () => '' };
    });

    const campId = crypto.randomUUID();
    const leadIds: Record<string, string> = {};
    const claimIds: Record<string, string> = {};
    let rivalLeadId = '';

    await withTenantTransaction(tenantA.id, async (client) => {
      for (const key of ['deliv', 'opened', 'hard', 'soft', 'comp', 'flow']) {
        const up = await upsertMasterContactInTx(client, tenantA.id, {
          name: `Lead ${key}`,
          phone: `090511100${Object.keys(leadIds).length}`,
          email: `${key}@m1-sns-test.vn`,
        });
        leadIds[key] = up.leadId;
      }

      await client.query(
        `INSERT INTO mkt_campaigns (id, tenant_id, name, channel, status, total_targeted, sent_count)
         VALUES ($1, $2, 'M1 SNS Campaign', 'email', 'completed', 5, 5)`,
        [campId, tenantA.id]
      );

      const claimsToSeed = [
        { key: 'deliv', status: 'sent', msgId: 'ses-deliv-001' },
        { key: 'opened', status: 'opened', msgId: 'ses-opened-002' },
        { key: 'hard', status: 'sent', msgId: 'ses-hard-003' },
        { key: 'soft', status: 'sent', msgId: 'ses-soft-004' },
        { key: 'comp', status: 'delivered', msgId: 'ses-comp-005' },
      ];
      for (const c of claimsToSeed) {
        const cid = crypto.randomUUID();
        claimIds[c.key] = cid;
        await client.query(
          `INSERT INTO mkt_send_claims (id, tenant_id, campaign_id, lead_id, channel, status, sent_at, metadata)
           VALUES ($1, $2, $3, $4, 'email', $5, clock_timestamp(), $6::jsonb)`,
          [cid, tenantA.id, campId, leadIds[c.key], c.status, JSON.stringify({ message_id: c.msgId })]
        );
      }

      // Flow email sent timeline event (no mkt_send_claims row)
      await client.query(
        `INSERT INTO lead_timeline_events (
           id, tenant_id, lead_id, event_type, event_category, actor_role, actor_name, title, content, metadata
         ) VALUES ($1, $2, $3, 'mkt_email_sent', 'communication', 'tenant_admin', 'Flow: Welcome', 'Email', 'SES', $4::jsonb)`,
        [
          crypto.randomUUID(),
          tenantA.id,
          leadIds.flow,
          JSON.stringify({ message_id: 'ses-flow-006', header_message_id: 'msg_flow_hdr_006@autodata.vn' }),
        ]
      );
    });

    // Seed same email as hard@m1-sns-test.vn in Tenant B to prove tenant isolation
    await withTenantTransaction(tenantB.id, async (client) => {
      const up = await upsertMasterContactInTx(client, tenantB.id, {
        name: 'Rival Hard Email',
        phone: '0909888123',
        email: 'hard@m1-sns-test.vn',
      });
      rivalLeadId = up.leadId;
    });

    const postSesEvent = async (sesPayload: Record<string, unknown>, snsMsgId = crypto.randomUUID()) => {
      const env = signSnsEnvelope(
        {
          Type: 'Notification',
          MessageId: snsMsgId,
          TopicArn: 'arn:aws:sns:ap-southeast-2:123456789012:ses-events',
          Message: JSON.stringify(sesPayload),
          Timestamp: new Date().toISOString(),
          SignatureVersion: '2',
          SigningCertURL: testCertUrl,
        },
        snsPrivKey
      );
      return apiRequest(harness.baseUrl, '/api/v1/webhooks/ses-sns', {
        method: 'POST',
        headers: { 'Content-Type': 'text/plain; charset=UTF-8' },
        body: JSON.stringify(env),
      });
    };

    // 3a. Delivery advances 'sent' -> 'delivered' and preserves 'opened'
    const deliv1 = await postSesEvent({
      notificationType: 'Delivery',
      mail: { messageId: 'ses-deliv-001', destination: ['deliv@m1-sns-test.vn'] },
      delivery: { recipients: ['deliv@m1-sns-test.vn'], smtpResponse: '250 2.0.0 OK' },
    });
    assert.equal(deliv1.status, 200);
    assert.equal(deliv1.json.data.matched_count, 1);

    const delivOpened = await postSesEvent({
      notificationType: 'Delivery',
      mail: { messageId: 'ses-opened-002', destination: ['opened@m1-sns-test.vn'] },
      delivery: { recipients: ['opened@m1-sns-test.vn'], smtpResponse: '250 2.0.0 OK' },
    });
    assert.equal(delivOpened.status, 200);

    // 3b. Permanent Bounce + idempotent replay
    const hardSnsId = crypto.randomUUID();
    const hardPayload = {
      notificationType: 'Bounce',
      mail: { messageId: 'ses-hard-003', destination: ['HARD@M1-SNS-TEST.VN'] },
      bounce: {
        bounceType: 'Permanent',
        bounceSubType: 'General',
        bouncedRecipients: [{ emailAddress: 'HARD@M1-SNS-TEST.VN', diagnosticCode: 'smtp; 550 5.1.1 user unknown' }],
      },
    };
    const hardRes1 = await postSesEvent(hardPayload, hardSnsId);
    assert.equal(hardRes1.status, 200);
    const hardRes2 = await postSesEvent(hardPayload, hardSnsId);
    assert.equal(hardRes2.status, 200);

    // 3c. Transient Bounce (soft bounce)
    const softRes = await postSesEvent({
      notificationType: 'Bounce',
      mail: { messageId: 'ses-soft-004', destination: ['soft@m1-sns-test.vn'] },
      bounce: {
        bounceType: 'Transient',
        bounceSubType: 'MailboxFull',
        bouncedRecipients: [{ emailAddress: 'soft@m1-sns-test.vn', diagnosticCode: '452 4.2.2 Mailbox full' }],
      },
    });
    assert.equal(softRes.status, 200);

    // 3d. Complaint + not-spam ignored
    const compRes = await postSesEvent({
      notificationType: 'Complaint',
      mail: { messageId: 'ses-comp-005', destination: ['comp@m1-sns-test.vn'] },
      complaint: {
        complaintFeedbackType: 'abuse',
        complainedRecipients: [{ emailAddress: 'comp@m1-sns-test.vn' }],
      },
    });
    assert.equal(compRes.status, 200);

    const notSpamRes = await postSesEvent({
      notificationType: 'Complaint',
      mail: { messageId: 'ses-deliv-001', destination: ['deliv@m1-sns-test.vn'] },
      complaint: {
        complaintFeedbackType: 'not-spam',
        complainedRecipients: [{ emailAddress: 'deliv@m1-sns-test.vn' }],
      },
    });
    assert.equal(notSpamRes.status, 200);
    assert.equal(notSpamRes.json.data.ignored, true);

    // 3e. Flow email correlation via header_message_id
    const flowBounce = await postSesEvent({
      notificationType: 'Bounce',
      mail: {
        messageId: 'ses-unknown-outer-id',
        commonHeaders: { messageId: '<msg_flow_hdr_006@autodata.vn>' },
        destination: ['flow@m1-sns-test.vn'],
      },
      bounce: {
        bounceType: 'Permanent',
        bounceSubType: 'NoEmail',
        bouncedRecipients: [{ emailAddress: 'flow@m1-sns-test.vn' }],
      },
    });
    assert.equal(flowBounce.status, 200);
    assert.equal(flowBounce.json.data.matched_count, 1);

    // Verify DB state on Tenant A
    await withTenantTransaction(tenantA.id, async (client) => {
      const claimRows = await client.query<{ id: string; status: string }>(
        'SELECT id, status FROM mkt_send_claims WHERE tenant_id = $1 AND campaign_id = $2',
        [tenantA.id, campId]
      );
      const statusById = new Map(claimRows.rows.map((r) => [r.id, r.status]));
      assert.equal(statusById.get(claimIds.deliv), 'delivered');
      assert.equal(statusById.get(claimIds.opened), 'opened', 'opened claim must NOT downgrade to delivered');
      assert.equal(statusById.get(claimIds.hard), 'bounced');
      assert.equal(statusById.get(claimIds.soft), 'sent', 'transient bounce must NOT mark claim bounced');
      assert.equal(statusById.get(claimIds.comp), 'complained');

      const campRow = await client.query<{ bounced_count: number }>(
        'SELECT bounced_count FROM mkt_campaigns WHERE tenant_id = $1 AND id = $2',
        [tenantA.id, campId]
      );
      assert.equal(Number(campRow.rows[0]?.bounced_count), 1, 'replay must keep bounced_count === 1');

      const leadsRows = await client.query<{ id: string; email_consent: string }>(
        'SELECT id, email_consent FROM leads WHERE tenant_id = $1',
        [tenantA.id]
      );
      const consentById = new Map(leadsRows.rows.map((r) => [r.id, r.email_consent]));
      assert.equal(consentById.get(leadIds.hard), 'bounced');
      assert.equal(consentById.get(leadIds.soft), 'subscribed');
      assert.equal(consentById.get(leadIds.comp), 'complained');
      assert.equal(consentById.get(leadIds.flow), 'bounced');

      const supRows = await client.query<{ recipient: string; reason: string }>(
        'SELECT recipient, reason FROM mkt_suppression_list WHERE tenant_id = $1',
        [tenantA.id]
      );
      const supMap = new Map(supRows.rows.map((r) => [r.recipient, r.reason]));
      assert.equal(supMap.get('hard@m1-sns-test.vn'), 'hard_bounce');
      assert.equal(supMap.get('comp@m1-sns-test.vn'), 'complained');
      assert.equal(supMap.get('flow@m1-sns-test.vn'), 'hard_bounce');
      assert.equal(supMap.has('soft@m1-sns-test.vn'), false);

      const hardTimeline = await client.query<{ cnt: number }>(
        `SELECT COUNT(*)::int AS cnt FROM lead_timeline_events
         WHERE tenant_id = $1 AND lead_id = $2 AND event_type = 'email_bounced'`,
        [tenantA.id, leadIds.hard]
      );
      assert.equal(Number(hardTimeline.rows[0]?.cnt), 1, 'replayed SNS must not duplicate timeline events');

      const softTimeline = await client.query<{ cnt: number }>(
        `SELECT COUNT(*)::int AS cnt FROM lead_timeline_events
         WHERE tenant_id = $1 AND lead_id = $2 AND event_type = 'email_soft_bounce'`,
        [tenantA.id, leadIds.soft]
      );
      assert.equal(Number(softTimeline.rows[0]?.cnt), 1);
    });

    // Verify Tenant B's identically-emailed lead was NOT affected
    await withTenantTransaction(tenantB.id, async (client) => {
      const r = await client.query<{ email_consent: string }>(
        'SELECT email_consent FROM leads WHERE tenant_id = $1 AND id = $2',
        [tenantB.id, rivalLeadId]
      );
      assert.equal(r.rows[0]?.email_consent, 'subscribed');
    });

    // Verify /ses-quota reflects complaint_rate_pct & bounce_rate_pct
    const quotaRes = await apiRequest(harness.baseUrl, '/api/v1/marketing/campaigns/ses-quota', {
      token: tenantA.token,
      tenantSlug: tenantA.slug,
    });
    assert.equal(quotaRes.status, 200);
    assert.equal(quotaRes.json.data.bounce_rate_pct, 20);
    assert.equal(quotaRes.json.data.complaint_rate_pct, 20);

    // 3e-reg. Cross-tenant Step C collision: Tenant B has recent claim + Tenant A's mail.source bounces
    let collisionLeadAId = '';
    let collisionLeadBId = '';
    await withTenantTransaction(tenantA.id, async (client) => {
      await client.query(
        `UPDATE tenants SET settings = COALESCE(settings, '{}'::jsonb) || '{"ses_sender_email":"noreply@ideas.edu.vn"}'::jsonb WHERE id = $1`,
        [tenantA.id]
      );
      const upA = await upsertMasterContactInTx(client, tenantA.id, {
        name: 'Collision A',
        phone: '0907000111',
        email: 'collision2@m1-sns-test.vn',
      });
      collisionLeadAId = upA.leadId;
    });
    await withTenantTransaction(tenantB.id, async (client) => {
      await client.query(
        `UPDATE tenants SET settings = COALESCE(settings, '{}'::jsonb) || '{"ses_sender_email":"noreply@ecolife.vn"}'::jsonb WHERE id = $1`,
        [tenantB.id]
      );
      const upB = await upsertMasterContactInTx(client, tenantB.id, {
        name: 'Collision B',
        phone: '0907000222',
        email: 'collision2@m1-sns-test.vn',
      });
      collisionLeadBId = upB.leadId;
      const campBId = crypto.randomUUID();
      await client.query(
        `INSERT INTO mkt_campaigns (id, tenant_id, name, channel, status, total_targeted, sent_count)
         VALUES ($1, $2, 'Ecolife Campaign', 'email', 'completed', 1, 1)`,
        [campBId, tenantB.id]
      );
      await client.query(
        `INSERT INTO mkt_send_claims (id, tenant_id, campaign_id, lead_id, channel, status, sent_at, metadata)
         VALUES ($1, $2, $3, $4, 'email', 'sent', clock_timestamp(), '{"message_id":"ecolife-real-msg-1"}'::jsonb)`,
        [crypto.randomUUID(), tenantB.id, campBId, collisionLeadBId]
      );
    });

    const crossBounceRes = await postSesEvent({
      notificationType: 'Bounce',
      mail: {
        messageId: 'ideas-raw-untracked-msg',
        source: 'noreply@ideas.edu.vn',
        destination: ['collision2@m1-sns-test.vn'],
      },
      bounce: {
        bounceType: 'Permanent',
        bounceSubType: 'General',
        bouncedRecipients: [
          { emailAddress: 'collision2@m1-sns-test.vn', diagnosticCode: 'smtp; 550 5.1.1 ideas bounce' },
        ],
      },
    });
    assert.equal(crossBounceRes.status, 200);
    assert.equal(crossBounceRes.json.data.matched_count, 1);

    await withTenantTransaction(tenantB.id, async (client) => {
      const r = await client.query<{ email_consent: string }>(
        'SELECT email_consent FROM leads WHERE tenant_id = $1 AND id = $2',
        [tenantB.id, collisionLeadBId]
      );
      assert.equal(r.rows[0]?.email_consent, 'subscribed', 'Tenant B must NOT be corrupted by Tenant A bounce');
    });
    await withTenantTransaction(tenantA.id, async (client) => {
      const r = await client.query<{ email_consent: string }>(
        'SELECT email_consent FROM leads WHERE tenant_id = $1 AND id = $2',
        [tenantA.id, collisionLeadAId]
      );
      assert.equal(r.rows[0]?.email_consent, 'bounced', 'Tenant A must be marked bounced via mail.source');
    });

    // 3e-diag. Multi-recipient diagnosticCode matching picks exact recipient entry
    let diagLead1Id = '';
    let diagLead2Id = '';
    await withTenantTransaction(tenantA.id, async (client) => {
      const u1 = await upsertMasterContactInTx(client, tenantA.id, {
        name: 'Diag 1',
        phone: '0907000331',
        email: 'diag1@m1-sns-test.vn',
      });
      const u2 = await upsertMasterContactInTx(client, tenantA.id, {
        name: 'Diag 2',
        phone: '0907000332',
        email: 'diag2@m1-sns-test.vn',
      });
      diagLead1Id = u1.leadId;
      diagLead2Id = u2.leadId;
      await client.query(
        `INSERT INTO mkt_send_claims (id, tenant_id, campaign_id, lead_id, channel, status, sent_at, metadata)
         VALUES ($1, $2, $3, $4, 'email', 'sent', clock_timestamp(), '{"message_id":"ses-multi-diag-1"}'::jsonb),
                ($5, $2, $3, $6, 'email', 'sent', clock_timestamp(), '{"message_id":"ses-multi-diag-1"}'::jsonb)`,
        [crypto.randomUUID(), tenantA.id, campId, diagLead1Id, crypto.randomUUID(), diagLead2Id]
      );
    });
    const multiDiagRes = await postSesEvent({
      notificationType: 'Bounce',
      mail: {
        messageId: 'ses-multi-diag-1',
        source: 'noreply@ideas.edu.vn',
        destination: ['diag1@m1-sns-test.vn', 'diag2@m1-sns-test.vn'],
      },
      bounce: {
        bounceType: 'Permanent',
        bounceSubType: 'General',
        bouncedRecipients: [
          { emailAddress: 'diag1@m1-sns-test.vn', diagnosticCode: 'smtp; 550 diag-one' },
          { emailAddress: 'diag2@m1-sns-test.vn', diagnosticCode: 'smtp; 552 diag-two' },
        ],
      },
    });
    assert.equal(multiDiagRes.status, 200);
    await withTenantTransaction(tenantA.id, async (client) => {
      const c2 = await client.query<{ error_message: string }>(
        'SELECT error_message FROM mkt_send_claims WHERE tenant_id = $1 AND lead_id = $2',
        [tenantA.id, diagLead2Id]
      );
      assert.ok(String(c2.rows[0]?.error_message || '').includes('diag-two'));
    });

    // 3f. Mock SES SMTP `250 Ok <ses-message-id>` parsing + generic `250 OK` fallback
    const startMockSmtp = (dataAckLine: string) =>
      new Promise<{ port: number; close: () => Promise<void> }>((resolve) => {
        const srv = net.createServer((socket) => {
          let buf = '';
          let inData = false;
          socket.write('220 mock-ses.local ESMTP\r\n');
          socket.on('data', (chunk) => {
            buf += chunk.toString('utf8');
            if (inData) {
              const endIdx = buf.indexOf('\r\n.\r\n');
              if (endIdx !== -1) {
                buf = buf.slice(endIdx + 5);
                inData = false;
                socket.write(`${dataAckLine}\r\n`);
              }
              return;
            }
            let nl = buf.indexOf('\r\n');
            while (nl !== -1) {
              const line = buf.slice(0, nl);
              buf = buf.slice(nl + 2);
              const upper = line.toUpperCase();
              if (upper.startsWith('EHLO') || upper.startsWith('HELO')) {
                socket.write('250-mock-ses.local\r\n250 OK\r\n');
              } else if (upper.startsWith('MAIL FROM') || upper.startsWith('RCPT TO')) {
                socket.write('250 OK\r\n');
              } else if (upper === 'DATA') {
                inData = true;
                socket.write('354 End data with <CR><LF>.<CR><LF>\r\n');
                break;
              } else if (upper === 'QUIT') {
                socket.write('221 Bye\r\n');
                socket.end();
              } else {
                socket.write('250 OK\r\n');
              }
              nl = buf.indexOf('\r\n');
            }
          });
        });
        srv.listen(0, '127.0.0.1', () => {
          const addr = srv.address();
          const port = typeof addr === 'object' && addr ? addr.port : 0;
          resolve({
            port,
            close: () => new Promise<void>((resClose) => srv.close(() => resClose())),
          });
        });
      });

    const sesSmtp = await startMockSmtp('250 Ok 01090193abcdef-998877-000000');
    try {
      const resSes = await sendRawSmtpMail({
        host: '127.0.0.1',
        port: sesSmtp.port,
        fromEmail: 'noreply@ideas.edu.vn',
        to: 'student@ideas.edu.vn',
        subject: 'SES SMTP ID Check',
        text: 'Hello',
        html: '<p>Hello</p>',
        messageId: 'msg_custom_hdr_1@autodata.vn',
      });
      assert.equal(resSes.accepted, true);
      assert.equal(resSes.messageId, '01090193abcdef-998877-000000');
      assert.equal(resSes.headerMessageId, 'msg_custom_hdr_1@autodata.vn');
    } finally {
      await sesSmtp.close();
    }

    const genericSmtp = await startMockSmtp('250 OK');
    try {
      const resGen = await sendRawSmtpMail({
        host: '127.0.0.1',
        port: genericSmtp.port,
        fromEmail: 'noreply@ideas.edu.vn',
        to: 'student@ideas.edu.vn',
        subject: 'Generic SMTP Check',
        text: 'Hello',
        html: '<p>Hello</p>',
        messageId: 'msg_generic_hdr_2@autodata.vn',
      });
      assert.equal(resGen.accepted, true);
      assert.equal(resGen.messageId, 'msg_generic_hdr_2@autodata.vn');
    } finally {
      await genericSmtp.close();
    }
  });

  it('4. Master Cronjob Consolidation & PGlite Safety Guards', async () => {
    // 4a. scripts/run-master-cron.sh LF-only & guards
    const cronScriptBytes = fs.readFileSync(path.resolve('scripts/run-master-cron.sh'));
    assert.equal(cronScriptBytes.includes(Buffer.from('\r\n')), false, 'run-master-cron.sh must be LF-only');
    const cronScriptText = cronScriptBytes.toString('utf8');
    assert.ok(cronScriptText.includes('ALLOW_OFFLINE_PGLITE_CRON'));
    assert.ok(cronScriptText.includes('postmaster.pid'));
    assert.ok(cronScriptText.includes('pgrep -f lsnode'));

    // 4b. shouldRefuseDirectCliPglite guard
    fs.writeFileSync(path.join(tempPgLockDir, 'postmaster.pid'), '12345\n');
    assert.equal(
      shouldRefuseDirectCliPglite({ pgliteDataDir: tempPgLockDir, databaseUrl: '', allowOfflinePgliteCron: '' }),
      true
    );
    assert.equal(
      shouldRefuseDirectCliPglite({ pgliteDataDir: tempPgLockDir, databaseUrl: '', allowOfflinePgliteCron: 'true' }),
      false
    );
    assert.equal(
      shouldRefuseDirectCliPglite({
        pgliteDataDir: tempPgLockDir,
        databaseUrl: 'postgres://user:pass@127.0.0.1:5432/db',
        allowOfflinePgliteCron: '',
      }),
      false
    );

    // 4c. Master cron 13 subroutines & HTTP endpoint auth
    assert.equal(ALL_CRON_SUBROUTINES.length, 13);

    const unauth = await apiRequest(harness.baseUrl, '/api/v1/operations/cron/master', {
      method: 'POST',
      headers: { 'X-Cron-Secret': 'wrong-secret' },
    });
    assert.equal(unauth.status, 401);

    const validSecret = (APP_CONFIG.cronSecret || APP_CONFIG.platformJwtSecret || '').trim();
    const okCron = await apiRequest(harness.baseUrl, '/api/v1/operations/cron/master', {
      method: 'POST',
      headers: { 'X-Cron-Secret': validSecret },
      body: { tenant_id: tenantA.id, subroutines: ['sla'] },
    });
    assert.equal(okCron.status, 200);
    assert.equal(okCron.json.data.locked, false);
  });

  it('5. ZaloBot Exclusion, Unconfigured zalo_zns Flow No-Op Truthfulness & growth_combo Entitlements', async () => {
    // 5a. Unconfigured zalo_zns & send_zns flow nodes make 0 HTTP calls, complete cleanly, and emit 0 zns_sent events
    setZnsTransportForTesting(null);
    const origFetch = globalThis.fetch;
    let externalFetchCount = 0;
    globalThis.fetch = (async (...args: Parameters<typeof fetch>) => {
      externalFetchCount++;
      return origFetch(...args);
    }) as typeof fetch;

    const origTgSilent = process.env.TELEGRAM_SILENT_MODE;
    const origMigSilent = process.env.MIGRATION_SILENT_MODE;
    process.env.OUTBOUND_SILENT_MODE = 'false';
    process.env.TELEGRAM_SILENT_MODE = 'false';
    process.env.MIGRATION_SILENT_MODE = 'false';
    process.env.NODE_ENV = 'production';
    try {
      let leadValidPhoneId = '';
      let leadNoPhoneId = '';
      await withTenantTransaction(tenantA.id, async (client) => {
        const l1 = await upsertMasterContactInTx(client, tenantA.id, {
          name: 'ZNS NoOp Valid Phone',
          phone: '0909123456',
          email: 'zns-valid@m1.vn',
        });
        leadValidPhoneId = l1.leadId;

        const l2 = await upsertMasterContactInTx(client, tenantA.id, {
          name: 'ZNS NoOp No Phone',
          phone: '',
          email: 'zns-nophone@m1.vn',
        });
        leadNoPhoneId = l2.leadId;
      });

      const flowRes = await apiRequest(harness.baseUrl, '/api/v1/marketing/flows', {
        method: 'POST',
        token: tenantA.token,
        tenantSlug: tenantA.slug,
        body: {
          name: 'M1 Unconfigured ZNS Flow',
          trigger_type: 'manual_enroll',
          status: 'active',
          steps: [
            { id: 's1', type: 'zalo_zns', label: 'ZNS Alias Node', config: { template_id: 'TPL_01' }, nextStepId: 's2' },
            { id: 's2', type: 'send_zns', label: 'ZNS Direct Node', config: { template_id: 'TPL_02' }, nextStepId: 's3' },
            { id: 's3', type: 'update_lead_score', label: 'After ZNS', config: { delta: 10 }, nextStepId: null },
          ],
        },
      });
      assert.equal(flowRes.status, 201);
      const flowId = flowRes.json.data.id;

      const fetchBeforeFlow = externalFetchCount;
      const run1 = await executeFlowForLead(tenantA.id, flowId, leadValidPhoneId, { skipWaitDelay: true });
      const run2 = await executeFlowForLead(tenantA.id, flowId, leadNoPhoneId, { skipWaitDelay: true });

      assert.equal(run1.status, 'completed');
      assert.equal(run2.status, 'completed');
      assert.equal(externalFetchCount, fetchBeforeFlow, 'Unconfigured ZNS must NEVER make external HTTP calls');
      assert.ok(
        run1.trace.some((t) => t.step_id === 's1' && t.outcome.includes('chưa cấu hình')),
        `Unexpected trace for s1: ${JSON.stringify(run1.trace)}`
      );
      assert.ok(run1.trace.some((t) => t.step_id === 's3'));

      await withTenantTransaction(tenantA.id, async (client) => {
        const znsEvents = await client.query<{ cnt: number }>(
          `SELECT COUNT(*)::int AS cnt FROM lead_timeline_events
           WHERE tenant_id = $1 AND lead_id = ANY($2) AND event_type = 'zns_sent'`,
          [tenantA.id, [leadValidPhoneId, leadNoPhoneId]]
        );
        assert.equal(Number(znsEvents.rows[0]?.cnt), 0, 'Unconfigured ZNS must NOT emit false zns_sent events');
      });

      // 5b. Unconfigured sendZaloBotNotification returns failure cleanly with 0 HTTP calls
      const fetchBeforeBot = externalFetchCount;
      const botSend = await sendZaloBotNotification(tenantA.id, 'Hello', { silentOverride: false });
      assert.equal(botSend.success, false);
      assert.equal(externalFetchCount, fetchBeforeBot, 'Unconfigured ZaloBot must NEVER make external HTTP calls');
    } finally {
      globalThis.fetch = origFetch;
      setZnsTransportForTesting(null);
      if (origNodeEnv === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = origNodeEnv;
      if (origTgSilent === undefined) delete process.env.TELEGRAM_SILENT_MODE;
      else process.env.TELEGRAM_SILENT_MODE = origTgSilent;
      if (origMigSilent === undefined) delete process.env.MIGRATION_SILENT_MODE;
      else process.env.MIGRATION_SILENT_MODE = origMigSilent;
      process.env.OUTBOUND_SILENT_MODE = origSilentMode ?? 'true';
    }

    // 5c. zalo_bot_disabled blocks ZaloBot webhook & sendZaloBotNotification cleanly (even with stale token)
    await withTenantTransaction(tenantA.id, async (client) => {
      await client.query(
        `UPDATE tenants SET settings = COALESCE(settings, '{}'::jsonb) || '{"zalo_bot_disabled":true,"zalo_bot_token":"stale_token_123","zalo_admin_group_chat_id":"-999999"}'::jsonb WHERE id = $1`,
        [tenantA.id]
      );
    });
    tenantRedis.invalidateTenantCache(tenantA.id, tenantA.slug);
    const zaloDisabledWebhook = await apiRequest(harness.baseUrl, `/api/v1/webhooks/zalo/${tenantA.slug}`, {
      method: 'POST',
      body: { chat_id: '-1001', sender_id: 'user_1', text: '/chatid' },
    });
    assert.equal(zaloDisabledWebhook.status, 200);
    assert.equal(zaloDisabledWebhook.json.data.handled, false);
    assert.equal(zaloDisabledWebhook.json.data.disabled, true);

    const origFetchStale = globalThis.fetch;
    let staleFetchCount = 0;
    globalThis.fetch = (async (...args: Parameters<typeof fetch>) => {
      staleFetchCount++;
      return origFetchStale(...args);
    }) as typeof fetch;
    process.env.OUTBOUND_SILENT_MODE = 'false';
    try {
      const staleBotSend = await sendZaloBotNotification(tenantA.id, 'Alert with stale token');
      assert.equal(staleBotSend.success, false);
      assert.equal(staleFetchCount, 0, 'zalo_bot_disabled=true must NEVER fire outbound HTTP calls');
    } finally {
      globalThis.fetch = origFetchStale;
      process.env.OUTBOUND_SILENT_MODE = origSilentMode ?? 'true';
    }

    // 5c-reg. runMarketingCampaignsWorker under OUTBOUND_SILENT_MODE=true with unconfigured ZNS vault
    process.env.OUTBOUND_SILENT_MODE = 'true';
    try {
      let silentCampId = '';
      let silentZnsLeadId = '';
      await withTenantTransaction(tenantA.id, async (client) => {
        const upZ = await upsertMasterContactInTx(client, tenantA.id, {
          name: 'Silent ZNS Lead',
          phone: '0909555666',
          email: 'silent-zns@m1.vn',
        });
        silentZnsLeadId = upZ.leadId;
        silentCampId = crypto.randomUUID();
        await client.query(
          `INSERT INTO mkt_campaigns (id, tenant_id, name, channel, status, scheduled_at, subject_a)
           VALUES ($1, $2, 'Silent ZNS Campaign', 'zns', 'scheduled', clock_timestamp() - INTERVAL '1 minute', 'ZNS Test')`,
          [silentCampId, tenantA.id]
        );
      });
      await runMarketingCampaignsWorker(tenantA.id);
      await withTenantTransaction(tenantA.id, async (client) => {
        const claimRow = await client.query<{ status: string }>(
          'SELECT status FROM mkt_send_claims WHERE tenant_id = $1 AND campaign_id = $2 LIMIT 1',
          [tenantA.id, silentCampId]
        );
        assert.notEqual(claimRow.rows[0]?.status, 'sent', 'Silent unconfigured ZNS claim must NOT be marked sent');
        const tlRow = await client.query<{ cnt: number }>(
          `SELECT COUNT(*)::int AS cnt FROM lead_timeline_events
           WHERE tenant_id = $1 AND lead_id = $2 AND event_type = 'zns_sent'`,
          [tenantA.id, silentZnsLeadId]
        );
        assert.equal(Number(tlRow.rows[0]?.cnt), 0, 'Silent unconfigured ZNS must emit 0 zns_sent events');
      });
    } finally {
      process.env.OUTBOUND_SILENT_MODE = origSilentMode ?? 'true';
    }

    // 5d. growth_combo entitlements enable CRM + Meta Report + Marketing Automation, exclude PROMAX ERP
    const ent = resolveTenantEntitlementSnapshot({
      package_code: 'growth_combo',
      plan_tier: 'growth',
      industry_key: 'education',
      entitlements: { package_code: 'growth_combo', education_addon: true },
    });
    assert.equal(ent.package_code, 'growth_combo');
    for (const enabledMod of [
      'dashboard_crm',
      'leads',
      'pipelines',
      'rounds',
      'ads_capi',
      'integrations_crm',
      'dashboard_marketing',
      'mkt_flows',
      'mkt_campaigns',
      'mkt_forms',
      'dashboard_growth',
      'revenue_attribution',
      'education',
    ]) {
      assert.equal(ent.enabled_modules.includes(enabledMod as any), true, `growth_combo must enable ${enabledMod}`);
    }
    for (const disabledMod of ['hrm', 'finance', 'payroll', 'dom_agent', 'projects']) {
      assert.equal(ent.enabled_modules.includes(disabledMod as any), false, `growth_combo must disable ${disabledMod}`);
    }

    // Verify growth_combo unlocks CRM, Meta Report & Marketing HTTP endpoints cleanly
    const crmRes = await apiRequest(harness.baseUrl, '/api/v1/leads', {
      token: tenantA.token,
      tenantSlug: tenantA.slug,
    });
    assert.equal(crmRes.status, 200);
    const metaRes = await apiRequest(harness.baseUrl, '/api/v1/integrations/dom-meta/config', {
      token: tenantA.token,
      tenantSlug: tenantA.slug,
    });
    assert.equal(metaRes.status, 200);
    const mktRes = await apiRequest(harness.baseUrl, '/api/v1/marketing/campaigns', {
      token: tenantA.token,
      tenantSlug: tenantA.slug,
    });
    assert.equal(mktRes.status, 200);
  });
});
