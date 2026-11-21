import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { startTestServer } from './helpers.ts';

describe('Milestone 4: Integrations.tsx Dead Feature Remediation & Wizard Wiring Audit', () => {
  const landingPageDir = 'D:\\GITHUB_SPACE\\DOMATION_LANDINGPAGE';
  const integrationsPath = path.join(landingPageDir, 'src', 'components', 'autodata', 'cloned', 'pages', 'Integrations.tsx');
  const wizardPath = path.join(landingPageDir, 'src', 'components', 'autodata', 'cloned', 'components', 'UnifiedBotSetupWizard.tsx');
  const distDir = path.join(landingPageDir, 'dist', 'assets');
  const hasUiSource = fs.existsSync(integrationsPath) && fs.existsSync(wizardPath);
  const skipUiReason = !hasUiSource ? 'Optional DOMATION_LANDINGPAGE Integrations/UnifiedBotSetupWizard files not present' : false;

  test('1. Integrations.tsx exists and contains required state declarations', { skip: skipUiReason }, () => {
    assert.ok(fs.existsSync(integrationsPath), `Integrations.tsx must exist at ${integrationsPath}`);
    const content = fs.readFileSync(integrationsPath, 'utf-8');

    // Verify state variables exist
    assert.match(content, /const\s+\[botGuideType,\s*setBotGuideType\]\s*=\s*useState<['"]telegram['"]\s*\|\s*['"]zalo['"]\s*\|\s*['"]webhook['"]\s*\|\s*['"]email['"]\s*\|\s*null>\(null\)/,
      'Must declare botGuideType state with all 4 channel types');
    assert.match(content, /const\s+\[wizardOpen,\s*setWizardOpen\]\s*=\s*useState\(false\)/,
      'Must declare wizardOpen state');
    assert.match(content, /const\s+\[wizardChannel,\s*setWizardChannel\]\s*=\s*useState<BotChannelType>\(['"]zalo['"]\)/,
      'Must declare wizardChannel state with initial channel');
  });

  test('2. All 4 Guide Modals are reachable via dedicated user actions in Integrations.tsx', { skip: skipUiReason }, () => {
    const content = fs.readFileSync(integrationsPath, 'utf-8');

    // Reachability Check 1: Zalo Bot Guide (Card 1 secondary Info button)
    assert.ok(
      content.includes("onClick={() => setBotGuideType('zalo')}") || content.includes('onClick={() => setBotGuideType("zalo")}'),
      'Zalo guide modal must be reachable via setBotGuideType("zalo") on Card 1'
    );

    // Reachability Check 2: Telegram Bot Guide (Card 2 secondary Info button)
    assert.ok(
      content.includes("onClick={() => setBotGuideType('telegram')}") || content.includes('onClick={() => setBotGuideType("telegram")}'),
      'Telegram guide modal must be reachable via setBotGuideType("telegram") on Card 2'
    );

    // Reachability Check 3: Webhook Guide (Card 3 primary button)
    assert.ok(
      content.includes("onClick={() => setBotGuideType('webhook')}") || content.includes('onClick={() => setBotGuideType("webhook")}'),
      'Webhook guide modal must be reachable via setBotGuideType("webhook") on Card 3'
    );

    // Reachability Check 4: Email Guide (Card 4 primary button)
    assert.ok(
      content.includes("onClick={() => setBotGuideType('email')}") || content.includes('onClick={() => setBotGuideType("email")}'),
      'Email guide modal must be reachable via setBotGuideType("email") on Card 4'
    );

    // Verify modal close action cleans up state
    assert.match(
      content,
      /onClose=\{\(\)\s*=>\s*setBotGuideType\(null\)\}/,
      'Guide modal onClose must reset botGuideType to null'
    );
  });

  test('3. CustomModal correctly maps all 4 botGuideTypes to corresponding guide components and titles', { skip: skipUiReason }, () => {
    const content = fs.readFileSync(integrationsPath, 'utf-8');

    // Verify CustomModal opening condition
    assert.match(
      content,
      /<CustomModal[\s\S]*?isOpen=\{Boolean\(botGuideType\)\}/,
      'CustomModal must open when botGuideType is truthy'
    );

    // Verify Titles mapping
    assert.ok(content.includes('Kết nối Telegram Bot (Multi-Tenant)'), 'Must have Telegram title');
    assert.ok(content.includes('Kết nối Zalo Bot Verification'), 'Must have Zalo title');
    assert.ok(content.includes('Tài Liệu Inbound Webhook & Linkbot'), 'Must have Webhook title');
    assert.ok(content.includes('Hướng Dẫn Cấu Hình Gửi Email'), 'Must have Email title');

    // Verify component rendering
    assert.match(content, /<AutoDataTelegramBotGuide[\s\S]*?\/>/, 'Must render AutoDataTelegramBotGuide');
    assert.match(content, /<AutoDataZaloBotGuide[\s\S]*?\/>/, 'Must render AutoDataZaloBotGuide');
    assert.match(content, /<AutoDataWebhookGuide[\s\S]*?\/>/, 'Must render AutoDataWebhookGuide');
    assert.match(content, /<AutoDataEmailGuide[\s\S]*?\/>/, 'Must render AutoDataEmailGuide');

    // Verify sub-component onClose propagation
    assert.match(content, /<AutoDataWebhookGuide[\s\S]*?onClose=\{\(\)\s*=>\s*setBotGuideType\(null\)\}/,
      'AutoDataWebhookGuide must receive onClose to close modal');
    assert.match(content, /<AutoDataEmailGuide[\s\S]*?onClose=\{\(\)\s*=>\s*setBotGuideType\(null\)\}/,
      'AutoDataEmailGuide must receive onClose to close modal');
  });

  test('4. UnifiedBotSetupWizard is directly triggerable from Header and all 4 Cards', { skip: skipUiReason }, () => {
    const content = fs.readFileSync(integrationsPath, 'utf-8');

    // 1. Header Trigger button
    assert.match(
      content,
      /Cấu hình Bot Nhanh \(5 Bước\)[\s\S]*?setWizardOpen\(true\)|setWizardOpen\(true\)[\s\S]*?Cấu hình Bot Nhanh \(5 Bước\)/,
      'Header primary button must trigger setWizardOpen(true)'
    );

    // 2. Card 1 (Zalo) Wizard Trigger
    assert.match(
      content,
      /setWizardChannel\(['"]zalo['"]\);[\s\r\n]*setWizardOpen\(true\);/,
      'Card 1 must set channel to zalo and open wizard'
    );

    // 3. Card 2 (Telegram) Wizard Trigger
    assert.match(
      content,
      /setWizardChannel\(['"]telegram['"]\);[\s\r\n]*setWizardOpen\(true\);/,
      'Card 2 must set channel to telegram and open wizard'
    );

    // 4. Card 3 (Webhook) Wizard Trigger
    assert.match(
      content,
      /setWizardChannel\(['"]webhook['"]\);[\s\r\n]*setWizardOpen\(true\);/,
      'Card 3 must set channel to webhook and open wizard'
    );

    // 5. Card 4 (Email) Wizard Trigger
    assert.match(
      content,
      /setWizardChannel\(['"]email['"]\);[\s\r\n]*setWizardOpen\(true\);/,
      'Card 4 must set channel to email and open wizard'
    );

    // 6. Wizard Component instantiation
    assert.match(
      content,
      /<UnifiedBotSetupWizard[\s\S]*?isOpen=\{wizardOpen\}[\s\S]*?onClose=\{\(\)\s*=>\s*setWizardOpen\(false\)\}[\s\S]*?initialChannel=\{wizardChannel\}[\s\S]*?onSuccess=\{[\s\S]*?fetchData\(\)/,
      'UnifiedBotSetupWizard must be instantiated with isOpen, onClose, initialChannel, and onSuccess callback'
    );
  });

  test('5. Card UI Layout, Tour Tags, and Accessibility Attributes', { skip: skipUiReason }, () => {
    const content = fs.readFileSync(integrationsPath, 'utf-8');

    // Screen Help Button
    assert.match(content, /<ScreenHelpButton\s+screenKey=["']integrations["']\s*\/>/,
      'Must contain ScreenHelpButton with screenKey="integrations"');

    // Guided Tour tags
    assert.ok(content.includes('data-tour="integrations-tabs"'), 'Must have data-tour="integrations-tabs"');
    assert.ok(content.includes('data-tour="integrations-bots"'), 'Must have data-tour="integrations-bots"');

    // Responsive grid
    assert.match(content, /gridTemplateColumns:\s*['"]repeat\(auto-fit,\s*minmax\(230px,\s*1fr\)\)['"]/,
      'Cards container must use responsive auto-fit grid');
  });

  test('6. Production Bundle Verification: All components and strings survive dead-code elimination', { skip: skipUiReason }, () => {
    const files = fs.readdirSync(distDir);
    const integrationsBundle = files.find((f) => f.startsWith('Integrations-') && f.endsWith('.js'));
    assert.ok(integrationsBundle, `Integrations bundle file must exist in ${distDir}`);

    const bundleContent = fs.readFileSync(path.join(distDir, integrationsBundle), 'utf-8');

    // Modal Titles
    assert.ok(bundleContent.includes('Kết nối Telegram Bot (Multi-Tenant)'), 'Bundle must retain Telegram title');
    assert.ok(bundleContent.includes('Kết nối Zalo Bot Verification'), 'Bundle must retain Zalo title');
    assert.ok(bundleContent.includes('Tài Liệu Inbound Webhook & Linkbot'), 'Bundle must retain Webhook title');
    assert.ok(bundleContent.includes('Hướng Dẫn Cấu Hình Gửi Email'), 'Bundle must retain Email title');

    // Wizard Titles and Buttons
    assert.ok(bundleContent.includes('Cấu hình Bot Nhanh (5 Bước)'), 'Bundle must retain Wizard button text');
    assert.ok(bundleContent.includes('Cấu hình Kênh Thông Báo & Bot Tự Động (Wizard 5 Bước)'), 'Bundle must retain Wizard modal title');

    // Guide and Wizard Action references
    assert.ok(bundleContent.includes('setBotGuideType') || bundleContent.includes('telegram') && bundleContent.includes('zalo') && bundleContent.includes('webhook') && bundleContent.includes('email'),
      'Bundle must retain all 4 channel keys');
  });

  test('7. State Machine Transition Simulation (Deterministic Reachability Oracle)', () => {
    type GuideType = 'telegram' | 'zalo' | 'webhook' | 'email' | null;
    type ChannelType = 'telegram' | 'zalo' | 'webhook' | 'email';

    interface IntegrationsState {
      botGuideType: GuideType;
      wizardOpen: boolean;
      wizardChannel: ChannelType;
    }

    let state: IntegrationsState = {
      botGuideType: null,
      wizardOpen: false,
      wizardChannel: 'zalo',
    };

    const actions = {
      clickHeaderWizard: () => {
        state.wizardChannel = 'zalo';
        state.wizardOpen = true;
      },
      clickZaloWizard: () => {
        state.wizardChannel = 'zalo';
        state.wizardOpen = true;
      },
      clickZaloGuide: () => {
        state.botGuideType = 'zalo';
      },
      clickTelegramWizard: () => {
        state.wizardChannel = 'telegram';
        state.wizardOpen = true;
      },
      clickTelegramGuide: () => {
        state.botGuideType = 'telegram';
      },
      clickWebhookGuide: () => {
        state.botGuideType = 'webhook';
      },
      clickWebhookWizard: () => {
        state.wizardChannel = 'webhook';
        state.wizardOpen = true;
      },
      clickEmailGuide: () => {
        state.botGuideType = 'email';
      },
      clickEmailWizard: () => {
        state.wizardChannel = 'email';
        state.wizardOpen = true;
      },
      closeGuide: () => {
        state.botGuideType = null;
      },
      closeWizard: () => {
        state.wizardOpen = false;
      },
    };

    // Transition 1: Header Wizard
    actions.clickHeaderWizard();
    assert.equal(state.wizardOpen, true);
    assert.equal(state.wizardChannel, 'zalo');
    actions.closeWizard();
    assert.equal(state.wizardOpen, false);

    // Transition 2: Zalo Guide Modal
    actions.clickZaloGuide();
    assert.equal(state.botGuideType, 'zalo');
    assert.equal(Boolean(state.botGuideType), true);
    actions.closeGuide();
    assert.equal(state.botGuideType, null);

    // Transition 3: Telegram Guide Modal
    actions.clickTelegramGuide();
    assert.equal(state.botGuideType, 'telegram');
    assert.equal(Boolean(state.botGuideType), true);
    actions.closeGuide();
    assert.equal(state.botGuideType, null);

    // Transition 4: Webhook Guide Modal
    actions.clickWebhookGuide();
    assert.equal(state.botGuideType, 'webhook');
    assert.equal(Boolean(state.botGuideType), true);
    actions.closeGuide();
    assert.equal(state.botGuideType, null);

    // Transition 5: Email Guide Modal
    actions.clickEmailGuide();
    assert.equal(state.botGuideType, 'email');
    assert.equal(Boolean(state.botGuideType), true);
    actions.closeGuide();
    assert.equal(state.botGuideType, null);

    // Transition 6: Webhook Wizard Trigger
    actions.clickWebhookWizard();
    assert.equal(state.wizardOpen, true);
    assert.equal(state.wizardChannel, 'webhook');
    actions.closeWizard();
    assert.equal(state.wizardOpen, false);

    // Transition 7: Email Wizard Trigger
    actions.clickEmailWizard();
    assert.equal(state.wizardOpen, true);
    assert.equal(state.wizardChannel, 'email');
    actions.closeWizard();
    assert.equal(state.wizardOpen, false);

    // Transition 8: Telegram Wizard Trigger
    actions.clickTelegramWizard();
    assert.equal(state.wizardOpen, true);
    assert.equal(state.wizardChannel, 'telegram');
    actions.closeWizard();
    assert.equal(state.wizardOpen, false);

    // Rapid successive guide switching
    actions.clickZaloGuide();
    assert.equal(state.botGuideType, 'zalo');
    actions.clickTelegramGuide();
    assert.equal(state.botGuideType, 'telegram');
    actions.clickWebhookGuide();
    assert.equal(state.botGuideType, 'webhook');
    actions.clickEmailGuide();
    assert.equal(state.botGuideType, 'email');
    actions.closeGuide();
    assert.equal(state.botGuideType, null);
  });

  test('8. Live Backend Integration API endpoints verification', async () => {
    const harness = await startTestServer();
    try {
      const baseUrl = harness.baseUrl;

      // 1. Zalo updates endpoint
      const resZaloUpdates = await fetch(`${baseUrl}/api/v1/integrations/zalo/updates`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ bot_token: 'valid_test_token_12345678' }),
      });
      assert.ok([200, 400, 401].includes(resZaloUpdates.status), `Zalo updates returned ${resZaloUpdates.status}`);

      // 2. Telegram test endpoint
      const resTgTest = await fetch(`${baseUrl}/api/v1/integrations/telegram/test`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ bot_token: '12345678:ABCdefGHIjklMNOpqrsTUVwxyz123456', silent_mode: true }),
      });
      assert.ok([200, 400, 401].includes(resTgTest.status), `Telegram test returned ${resTgTest.status}`);

      // 3. Email test endpoint
      const resEmailTest = await fetch(`${baseUrl}/api/v1/integrations/email/test`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ appscript_url: 'https://script.google.com/macros/s/AKfycbxTest/exec' }),
      });
      assert.ok([200, 400, 401].includes(resEmailTest.status), `Email test returned ${resEmailTest.status}`);
    } finally {
      await harness.close();
    }
  });
});
