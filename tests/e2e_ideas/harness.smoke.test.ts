import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  LIVE_PGLITE_DATA_DIR,
  REPO_ROOT,
  assertTestRecipientsOnly,
  buildCanonicalSnsStringToSign,
  buildSyntheticMyerpSql,
  createIsolatedContext,
  createSnsTestSigner,
  impersonateTenant,
  inspectSqlDumpMetadata,
  installIdeasMockFetch,
  loginSuperAdmin,
  makeTestRecipient,
  runCliSubprocess,
  seedIdeasTenant,
  seedSiblingTenant,
  signSnsNotification,
  startMockSmtpServer,
  triggerMasterCron,
  verifySnsEnvelopeSignature,
} from './harness.ts';

describe('M_E2E_1 Harness Smoke Verification', () => {
  it('boots isolated tempdir PGlite, provisions ideas & sibling, impersonates, triggers master cron, and cleans up tempdir', async () => {
    const ctx = await createIsolatedContext({ dbMode: 'tempdir', seedSuperAdmin: true });
    const dataDir = ctx.dataDir;
    assert.ok(dataDir, 'tempdir mode must allocate a non-null dataDir');
    assert.ok(fs.existsSync(dataDir), 'temp dataDir should exist while context is open');
    assert.notEqual(path.resolve(dataDir), path.resolve(LIVE_PGLITE_DATA_DIR));

    try {
      const ideas = await seedIdeasTenant(ctx, {
        slug: 'ideas',
        packageCode: 'growth_combo',
        industry: 'education',
      });
      assert.equal(ideas.tenantSlug, 'ideas');
      assert.equal(ideas.tenant.package_code, 'growth_combo');
      assert.equal(ideas.tenant.industry_key, 'education');
      assert.equal(ideas.tenant.status, 'active');

      const me = await ctx.apiJson('/api/v1/auth/me', {
        token: ideas.accessToken,
        tenantSlug: 'ideas',
      });
      assert.equal(me.success, true);
      assert.equal(me.data.tenant.slug, 'ideas');
      assert.ok(Array.isArray(me.data.tenant.enabled_modules));
      assert.ok(me.data.tenant.enabled_modules.includes('education'));
      assert.ok(me.data.tenant.enabled_modules.includes('mkt_campaigns'));
      assert.equal(me.data.tenant.enabled_modules.includes('hrm'), false);

      const sibling = await seedSiblingTenant(ctx, 'ecolife', { packageCode: 'autodata_crm' });
      assert.equal(sibling.tenantSlug, 'ecolife');

      const sa = await loginSuperAdmin(ctx);
      assert.equal(sa.ok, true);
      assert.ok(sa.token.length > 20);

      const imp = await impersonateTenant(ctx, sa.token, ideas.tenantId, 10);
      assert.equal(imp.ok, true);
      assert.equal(imp.tenantSlug, 'ideas');
      assert.ok(imp.accessToken.length > 20);

      const impMe = await ctx.apiJson('/api/v1/auth/me', {
        token: imp.accessToken,
        tenantSlug: 'ideas',
      });
      assert.equal(impMe.data.tenant.id, ideas.tenantId);

      const cronRes = await triggerMasterCron(ctx, {
        subroutines: ['billing', 'marketing_flows'],
        tenantId: ideas.tenantId,
      });
      assert.equal(cronRes.ok, true);
      assert.equal(cronRes.status, 200);
    } finally {
      await ctx.close();
      // Idempotent close check
      await ctx.close();
    }

    assert.equal(fs.existsSync(dataDir), false, 'owned temp dataDir must be removed on close()');
  });

  it('boots inMemory PGlite and refuses live ./.autodata-pgdata in both createIsolatedContext and runCliSubprocess', async () => {
    await assert.rejects(
      () => createIsolatedContext({ dbMode: 'tempdir', dataDir: LIVE_PGLITE_DATA_DIR }),
      /REFUSED_LIVE_PGLITE_DATA_DIR/
    );
    await assert.rejects(
      () =>
        runCliSubprocess(['--version'], {
          runner: 'node',
          env: { PGLITE_DATA_DIR: LIVE_PGLITE_DATA_DIR },
        }),
      /REFUSED_LIVE_PGLITE_DATA_DIR/
    );

    const ctx = await createIsolatedContext({ inMemory: true });
    try {
      assert.equal(ctx.dbMode, 'memory');
      assert.equal(ctx.dataDir, null);
      const health = await ctx.apiRaw('/api/v1/health');
      assert.equal(health.status, 200);
    } finally {
      await ctx.close();
    }
  });

  it('delivers real SMTP email over loopback 127.0.0.1 via /api/v1/integrations/email/test and decodes MIME headers/bodies', async () => {
    const ctx = await createIsolatedContext({ dbMode: 'memory' });
    try {
      const ideas = await seedIdeasTenant(ctx, {
        slug: 'ideas',
        configureLoopbackSmtp: true,
        smtpVia: 'aws_ses',
        fromEmail: 'systemnoti@test-sink.domation.local',
      });

      const recipient = makeTestRecipient('ideas-smtp-smoke');
      assertTestRecipientsOnly([recipient]);
      assert.throws(
        () => assertTestRecipientsOnly(['customer@gmail.com']),
        /UNSAFE_TEST_RECIPIENT/
      );

      const emailTestRes = await ctx.apiJson('/api/v1/integrations/email/test', {
        method: 'POST',
        token: ideas.accessToken,
        tenantSlug: 'ideas',
        body: {
          to_email: recipient,
          type: 'system',
          email_provider: 'ses',
        },
      });
      assert.equal(emailTestRes.success, true);
      assert.equal(emailTestRes.data.sent, true);

      const captured = await ctx.smtp.waitForMessages(1, 3000);
      assert.equal(captured.length, 1);
      const msg = captured[0];
      assert.equal(msg.mailFrom, 'systemnoti@test-sink.domation.local');
      assert.deepEqual(msg.rcptTo, [recipient]);
      assert.equal(msg.authUser, 'e2e-ses-user');
      assert.equal(msg.authPass, 'e2e-ses-pass');
      assert.ok(msg.subject.length > 0, 'decoded MIME Subject should be non-empty');
      assert.ok(msg.text.length > 0, 'decoded text/plain part should be non-empty');
      assert.ok(msg.html.includes('<'), 'decoded text/html part should contain HTML');
      assert.ok(msg.messageId, 'Message-ID header should be captured');

      ctx.smtp.clear();
      assert.equal(ctx.smtp.messages.length, 0);
    } finally {
      await ctx.close();
    }
  });

  it('generates valid ephemeral RSA-2048 X.509 cert, signs SHA256/SHA1 SNS envelopes, serves cert via fetch guard, and blocks unmocked external URLs', async () => {
    const ctx = await createIsolatedContext({ dbMode: 'memory' });
    try {
      const signer = ctx.snsSigner;
      const x509 = new crypto.X509Certificate(signer.certPem);
      assert.equal(x509.verify(x509.publicKey), true);
      assert.match(signer.signingCertUrl, /^https:\/\/sns\.ap-southeast-2\.amazonaws\.com\/.*\.pem$/);

      // Fetch SigningCertURL through the active globalThis.fetch interceptor
      const certRes = await fetch(signer.signingCertUrl);
      assert.equal(certRes.status, 200);
      const fetchedPem = await certRes.text();
      assert.equal(fetchedPem, signer.certPem);

      // SubscriptionConfirmation (SHA256)
      const subConfirm = signer.signSubscriptionConfirmation();
      assert.equal(subConfirm.envelope.Type, 'SubscriptionConfirmation');
      assert.equal(subConfirm.envelope.SignatureVersion, '2');
      assert.equal(verifySnsEnvelopeSignature(subConfirm.envelope, fetchedPem), true);

      // UnsubscribeConfirmation (SHA1)
      const unsubConfirm = signer.signUnsubscribeConfirmation({ signatureVersion: '1' });
      assert.equal(unsubConfirm.envelope.Type, 'UnsubscribeConfirmation');
      assert.equal(unsubConfirm.envelope.SignatureVersion, '1');
      assert.equal(verifySnsEnvelopeSignature(unsubConfirm.envelope, fetchedPem), true);

      // Notification: Permanent Bounce (SHA256), Transient Bounce (SHA1), Complaint, Delivery
      const bounceRecipient = makeTestRecipient('bounce');
      const permBounce = signSnsNotification(
        signer,
        {
          eventType: 'Bounce',
          bounceType: 'Permanent',
          recipients: [bounceRecipient],
          messageId: 'mock-smtp-bounce-1',
        },
        { signatureVersion: '2', subject: 'Amazon SES Email Event Notification' }
      );
      assert.equal(permBounce.envelope.SignatureVersion, '2');
      assert.ok(buildCanonicalSnsStringToSign(permBounce.envelope as unknown as Record<string, unknown>).includes('Subject\n'));
      assert.equal(verifySnsEnvelopeSignature(permBounce.envelope, fetchedPem), true);

      const transientBounce = signSnsNotification(
        signer,
        {
          eventType: 'Bounce',
          bounceType: 'Transient',
          recipients: [makeTestRecipient('transient')],
        },
        { signatureVersion: '1' }
      );
      assert.equal(transientBounce.envelope.SignatureVersion, '1');
      assert.equal(verifySnsEnvelopeSignature(transientBounce.envelope, fetchedPem), true);

      const complaint = signSnsNotification(signer, {
        eventType: 'Complaint',
        recipients: [makeTestRecipient('complaint')],
      });
      assert.equal(verifySnsEnvelopeSignature(complaint.envelope, fetchedPem), true);

      const delivery = signSnsNotification(signer, {
        eventType: 'Delivery',
        recipients: [makeTestRecipient('delivery')],
      });
      assert.equal(verifySnsEnvelopeSignature(delivery.envelope, fetchedPem), true);

      // Negative checks: tampered signature & evil SigningCertURL
      const tampered = signSnsNotification(signer, {
        eventType: 'Bounce',
        bounceType: 'Permanent',
        recipients: [bounceRecipient],
      }, { tamperSignature: true });
      assert.equal(verifySnsEnvelopeSignature(tampered.envelope, fetchedPem), false);

      const customSigner = createSnsTestSigner({ region: 'ap-southeast-1', certId: 'evil-test' });
      const evilHttp = customSigner.signNotification(
        { eventType: 'Delivery', recipients: [bounceRecipient] },
        { signingCertUrl: 'http://sns.ap-southeast-1.amazonaws.com/cert.pem' }
      );
      assert.equal(evilHttp.envelope.SigningCertURL.startsWith('http://'), true);

      const evilHost = customSigner.signNotification(
        { eventType: 'Delivery', recipients: [bounceRecipient] },
        { signingCertUrl: 'https://evil.example.com/cert.pem' }
      );
      assert.equal(evilHost.envelope.SigningCertURL, 'https://evil.example.com/cert.pem');

      // Outbound fetch guard: blocks and records unexpected external calls (Zalo & arbitrary external host)
      ctx.mockFetch.clearRequests();
      await assert.rejects(
        () =>
          fetch('https://bot-api.zaloplatforms.com/bot123/sendMessage', {
            method: 'POST',
            body: JSON.stringify({ chat_id: '1', text: 'forbidden' }),
          }),
        /BLOCKED_UNMOCKED_EXTERNAL_FETCH/
      );
      await assert.rejects(
        () => fetch('https://example.org/unexpected'),
        /BLOCKED_UNMOCKED_EXTERNAL_FETCH/
      );
      const zaloReqs = ctx.mockFetch.getRequests('zalo');
      assert.equal(zaloReqs.length, 1);
      assert.equal(zaloReqs[0].blocked, true);
      assert.equal(ctx.mockFetch.getBlockedRequests().length, 2);

      // Loopback HTTP continues passing cleanly
      const loopbackRes = await fetch(`${ctx.baseUrl}/api/v1/health`);
      assert.equal(loopbackRes.status, 200);
    } finally {
      await ctx.close();
    }
  });

  it('builds synthetic MYERP MariaDB dump with exact positional INSERTs, pollution/backup/zalo fixtures, and inspects via constant-memory stream scanner', async () => {
    const dump = buildSyntheticMyerpSql({
      extraContactsCount: 2,
      extraSubscribersCount: 2,
      pendingMailQueueCount: 3,
      waitingFlowStatesCount: 4,
      pollutionWebPropertiesCount: 5,
    });

    try {
      const meta = await inspectSqlDumpMetadata(dump.sqlPath);
      assert.ok(meta.fileSizeBytes > 5000);
      assert.ok(meta.lineCount > 100);
      assert.equal(meta.bakTableCount, 2);
      assert.deepEqual(meta.bakTables.sort(), ['_bak_activities_20260913', '_bak_deposits_20260819_103521']);
      assert.equal(meta.zaloTables.length, 13);

      const requiredCheck = meta.hasAllTables([
        'tenants',
        'users',
        'contacts',
        'leads',
        'pipeline_stages',
        'distribution_rounds',
        'round_consultants',
        'routing_rules',
        'subscribers',
        'lists',
        'subscriber_lists',
        'segments',
        'templates',
        'campaigns',
        'flows',
        'forms',
        'surveys',
        'short_links',
        'web_properties',
        'mail_queue',
        'subscriber_flow_states',
        'contact_meta_attribution',
        'capi_logs',
        'capi_blocked_phones',
        'meta_app_configs',
        'system_settings',
        'mkt_system_settings',
        'verified_senders',
        'zalo_oa_configs',
        'zalo_queue',
        'zalo_subscribers',
      ]);
      assert.equal(requiredCheck.ok, true, `Missing tables: ${requiredCheck.missing.join(', ')}`);

      const sqlText = fs.readFileSync(dump.sqlPath, 'utf8');
      // Verify positional INSERT INTO `tbl` VALUES (...) without column lists
      assert.match(sqlText, /INSERT INTO `tenants` VALUES \(1,'IDEAS ERP','ideas'.*?\),\(99999,'Test E2E Tenant 99999','test-e2e-99999'/);
      assert.doesNotMatch(sqlText, /INSERT INTO `[a-z0-9_]+` \(/);
      assert.match(sqlText, /"type":"zalo_zns"/);
      assert.match(sqlText, /automation\.ideas\.edu\.vn/);
      assert.match(sqlText, /myerp\.ideas\.edu\.vn/);
      assert.equal(dump.counts.pendingMailQueue, 3);
      assert.equal(dump.counts.waitingFlowStates, 4);
      assert.equal(dump.counts.pollutionWebProperties, 5);
      assert.equal(dump.counts.ideasWebProperties, 2);
    } finally {
      dump.cleanup();
    }
    assert.equal(fs.existsSync(dump.sqlPath), false, 'synthetic dump cleanup() should remove temp file');

    // Optional live-disk backup metadata check if real MYERP dump is present
    const realDumpPath = 'D:\\GITHUB_SPACE\\MYERP\\backups\\myerp_backup_latest.sql';
    if (fs.existsSync(realDumpPath)) {
      const realMeta = await inspectSqlDumpMetadata(realDumpPath);
      assert.ok(realMeta.fileSizeBytes > 100_000_000);
      assert.ok(realMeta.tableCount >= 200);
      assert.ok(realMeta.bakTableCount >= 20);
      assert.ok(realMeta.zaloTables.length >= 10);
      const reqCheck = realMeta.hasAllTables(['tenants', 'contacts', 'leads', 'subscribers', 'flows', 'zalo_oa_configs']);
      assert.equal(reqCheck.ok, true);
    }
  });

  it('isolates SNS cert cache and APP_CONFIG.cronSecret across sequential createIsolatedContext() calls', async () => {
    // Context 1: posts signed SNS Delivery to /api/v1/webhooks/ses-sns
    let certUrl1 = '';
    const ctx1 = await createIsolatedContext({ dbMode: 'memory' });
    try {
      certUrl1 = ctx1.snsSigner.signingCertUrl;
      const req1 = signSnsNotification(ctx1.snsSigner, {
        eventType: 'Delivery',
        recipients: [makeTestRecipient('sns-ctx1')],
      });
      const res1 = await ctx1.apiRaw('/api/v1/webhooks/ses-sns', {
        method: 'POST',
        headers: req1.headers,
        body: req1.rawBody,
      });
      assert.equal(res1.status, 200, `ctx1 SNS webhook failed: ${res1.rawText}`);
      assert.equal(res1.json?.success, true);
      assert.equal(res1.json?.data?.event_type, 'Delivery');
    } finally {
      await ctx1.close();
    }

    // Context 2: fresh SNS keypair + custom cronSecret must both succeed with HTTP 200
    const ctx2 = await createIsolatedContext({
      dbMode: 'memory',
      cronSecret: 'custom-e2e-cron-secret-2',
    });
    try {
      assert.notEqual(
        ctx2.snsSigner.signingCertUrl,
        certUrl1,
        'sequential signers must have unique default SigningCertURLs'
      );
      const req2 = signSnsNotification(ctx2.snsSigner, {
        eventType: 'Delivery',
        recipients: [makeTestRecipient('sns-ctx2')],
      });
      const res2 = await ctx2.apiRaw('/api/v1/webhooks/ses-sns', {
        method: 'POST',
        headers: req2.headers,
        body: req2.rawBody,
      });
      assert.equal(res2.status, 200, `ctx2 SNS webhook failed: ${res2.rawText}`);
      assert.equal(res2.json?.success, true);
      assert.equal(res2.json?.data?.event_type, 'Delivery');

      const cron2 = await triggerMasterCron(ctx2, { subroutines: ['billing'] });
      assert.equal(cron2.status, 200, `ctx2 custom cronSecret failed: ${JSON.stringify(cron2.json)}`);
      assert.equal(cron2.ok, true);
    } finally {
      await ctx2.close();
    }

    // Context 3: verifies APP_CONFIG.cronSecret was restored after ctx2.close()
    const ctx3 = await createIsolatedContext({ dbMode: 'memory' });
    try {
      const cron3 = await triggerMasterCron(ctx3, { subroutines: ['billing'] });
      assert.equal(cron3.status, 200, `ctx3 default cronSecret failed: ${JSON.stringify(cron3.json)}`);
      assert.equal(cron3.ok, true);
    } finally {
      await ctx3.close();
    }
  });

  it('enforces PGLITE_DATA_DIR sentinel, cwd/subpath guards, strict recipient regex, fetch identity restore, and SMTP waiter cleanup', async () => {
    // c1. Passing PGLITE_DATA_DIR: undefined or '' must keep os.tmpdir() sentinel (never UNSET or .autodata-pgdata)
    const tmpNorm = path.resolve(os.tmpdir()).toLowerCase();
    for (const overrideVal of [undefined, ''] as Array<string | undefined>) {
      const res = await runCliSubprocess(
        ['-e', 'console.log(process.env.PGLITE_DATA_DIR || "UNSET")'],
        { runner: 'node', env: { PGLITE_DATA_DIR: overrideVal } }
      );
      assert.equal(res.status, 0);
      const out = res.stdout.trim();
      assert.notEqual(out, 'UNSET');
      assert.ok(
        path.resolve(out).toLowerCase().startsWith(tmpNorm),
        `Expected os.tmpdir() sentinel, got '${out}'`
      );
      assert.ok(!out.includes('.autodata-pgdata'));
    }

    // c2. Relative path from alternate cwd & subpath inside .autodata-pgdata must throw REFUSED_LIVE_PGLITE_DATA_DIR
    await assert.rejects(
      () =>
        runCliSubprocess(['-e', 'console.log("should-not-run")'], {
          runner: 'node',
          cwd: path.join(REPO_ROOT, 'tests'),
          env: { PGLITE_DATA_DIR: '../.autodata-pgdata' },
        }),
      /REFUSED_LIVE_PGLITE_DATA_DIR/
    );
    await assert.rejects(
      () =>
        runCliSubprocess(['-e', 'console.log("should-not-run")'], {
          runner: 'node',
          env: { PGLITE_DATA_DIR: path.join(LIVE_PGLITE_DATA_DIR, 'pg_wal') },
        }),
      /REFUSED_LIVE_PGLITE_DATA_DIR/
    );

    // d. Strict single-recipient validation in assertTestRecipientsOnly (positive display-name & negative bypass cases)
    assertTestRecipientsOnly([
      makeTestRecipient('probe'),
      'valid.user+1@test-sink.domation.local',
      'x@test-sink.domation.local',
      'Display <x@test-sink.domation.local>',
      '  "IDEAS Test" <User.1+tag@TEST-SINK.DOMATION.LOCAL>  ',
      '"Quoted, Name" <x@test-sink.domation.local>',
      '<x@test-sink.domation.local>',
    ]);
    for (const unsafeRecipient of [
      'Fake <x@test-sink.domation.local>, Victim <victim@gmail.com>',
      'Fake <x@test-sink.domation.local>, Other <y@test-sink.domation.local>',
      'Fake <x@test-sink.domation.local> victim@gmail.com',
      '<x@test-sink.domation.local> <victim@gmail.com>',
      'x@test-sink.domation.local, victim@gmail.com',
      'x@test-sink.domation.local; victim@gmail.com',
      '"Quoted, Name" <x@test-sink.domation.local>, <victim@gmail.com>',
      'Display <x@test-sink.domation.local',
      'x@test-sink.domation.local>',
      'Display <x@test-sink.domation.local>\r\nBcc: victim@gmail.com',
      '@test-sink.domation.local',
      'a@evil.com@test-sink.domation.local',
      'x@test-sink.domation.local.evil.com',
      'x@sub.test-sink.domation.local',
      '',
      '   ',
    ]) {
      assert.throws(
        () => assertTestRecipientsOnly([unsafeRecipient]),
        /UNSAFE_TEST_RECIPIENT/,
        `Expected UNSAFE_TEST_RECIPIENT for: ${JSON.stringify(unsafeRecipient)}`
      );
    }

    // e. mockFetch.restore() preserves exact globalThis.fetch reference identity
    const nativeFetchBefore = globalThis.fetch;
    const mockFetch = installIdeasMockFetch();
    assert.notEqual(globalThis.fetch, nativeFetchBefore);
    mockFetch.restore();
    assert.strictEqual(globalThis.fetch, nativeFetchBefore);

    // f. MockSmtpServer.close() rejects and clears pending waitForMessages() timers immediately
    const smtp = await startMockSmtpServer();
    const pendingWait = smtp.waitForMessages(1, 30_000);
    await smtp.close();
    await assert.rejects(() => pendingWait, /closed/i);
  });
});
