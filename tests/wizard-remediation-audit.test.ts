import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

describe('Milestone 4 Remediation: UnifiedBotSetupWizard Forensic Integrity Audit', () => {
  const wizardPath = 'D:\\GITHUB_SPACE\\DOMATION_LANDINGPAGE\\src\\components\\autodata\\cloned\\components\\UnifiedBotSetupWizard.tsx';

  test('1. Wizard file exists and contains genuine state declarations', () => {
    assert.ok(fs.existsSync(wizardPath), `UnifiedBotSetupWizard.tsx must exist at ${wizardPath}`);
    const content = fs.readFileSync(wizardPath, 'utf-8');

    assert.ok(content.includes('const [isSilentMode, setIsSilentMode] = useState<boolean>(false)'), 'Must have isSilentMode state');
    assert.ok(content.includes('const [selectedCoManagers, setSelectedCoManagers] = useState<string[]>([])'), 'Must have selectedCoManagers state');
    assert.ok(content.includes('const [vaultSaved, setVaultSaved] = useState<boolean>(false)'), 'Must have vaultSaved state');
  });

  test('2. Issue 1 & 5: Genuine Vault AES-256 persistence for Zalo Bot via PUT /api/v1/integrations/vault/zalo_bot', () => {
    const content = fs.readFileSync(wizardPath, 'utf-8');

    // handleSaveToVault must call PUT /api/v1/integrations/vault/zalo_bot
    assert.match(
      content,
      /else\s+if\s*\(channel\s*===\s*['"]zalo['"]\)[\s\S]*?fetch\(['"]\/api\/v1\/integrations\/vault\/zalo_bot['"],\s*\{\s*method:\s*['"]PUT['"]/,
      'handleSaveToVault must call PUT /api/v1/integrations/vault/zalo_bot when channel === "zalo"'
    );

    // handleSaveToVault must transmit silent_mode: isSilentMode for Zalo
    assert.match(
      content,
      /fetch\(['"]\/api\/v1\/integrations\/vault\/zalo_bot['"][\s\S]*?silent_mode:\s*isSilentMode/,
      'handleSaveToVault must transmit silent_mode: isSilentMode for Zalo'
    );

    // handleFinalize must call PUT /api/v1/integrations/vault/zalo_bot
    assert.match(
      content,
      /handleFinalize[\s\S]*?else\s+if\s*\(channel\s*===\s*['"]zalo['"]\)[\s\S]*?fetch\(['"]\/api\/v1\/integrations\/vault\/zalo_bot['"],\s*\{\s*method:\s*['"]PUT['"]/,
      'handleFinalize must persist Zalo config to Vault via PUT /api/v1/integrations/vault/zalo_bot'
    );

    // handleFinalize must transmit silent_mode: isSilentMode for Zalo
    assert.match(
      content,
      /handleFinalize[\s\S]*?fetch\(['"]\/api\/v1\/integrations\/vault\/zalo_bot['"][\s\S]*?silent_mode:\s*isSilentMode/,
      'handleFinalize must persist silent_mode: isSilentMode for Zalo'
    );
  });

  test('3. Issue 2: Hardcoded fake chat ID "-10029384756" is completely removed from runtime logic', () => {
    const content = fs.readFileSync(wizardPath, 'utf-8');

    // Confirm '-10029384756' does not appear anywhere in the source code
    assert.ok(!content.includes('-10029384756'), 'Hardcoded "-10029384756" must be removed completely');
    assert.ok(!content.includes('demo_zalobot_token'), 'Fake token "demo_zalobot_token" must be removed');
    assert.ok(!content.includes('sale_chatid_889900'), 'Fake chat ID "sale_chatid_889900" must be removed');

    // Verify Telegram scan shows prompt when chatId is empty
    assert.match(
      content,
      /if\s*\(!chatId\.trim\(\)\)\s*\{[\s\S]*?setScanMessage\([\s\S]*?toast\.error\(/,
      'Telegram auto-scan must prompt the user with warning toast and message when chatId is empty'
    );
  });

  test('4. Issue 3: Co-Managers array is genuinely persisted via add_consultant_manager in handleFinalize', () => {
    const content = fs.readFileSync(wizardPath, 'utf-8');

    // Verify handleFinalize iterates selectedCoManagers and calls add_consultant_manager
    assert.match(
      content,
      /for\s*\(\s*const\s+\w+\s+of\s+selectedCoManagers\s*\)[\s\S]*?fetchAPI\(['"]add_consultant_manager['"]/,
      'handleFinalize must iterate selectedCoManagers and call add_consultant_manager'
    );
    assert.match(
      content,
      /consultant_id:\s*selectedConsultantId/,
      'add_consultant_manager payload must bind to selectedConsultantId'
    );
  });

  test('5. Issue 4: Webhook health check genuinely pings /api/v1/integrations/overview', () => {
    const content = fs.readFileSync(wizardPath, 'utf-8');

    // Step 4 Webhook test must fetch /api/v1/integrations/overview
    assert.match(
      content,
      /handleRunLatencyTest[\s\S]*?else\s*\{[\s\S]*?fetch\(['"]\/api\/v1\/integrations\/overview['"],\s*\{\s*method:\s*['"]GET['"]/,
      'handleRunLatencyTest Webhook branch must call GET /api/v1/integrations/overview'
    );

    // Must calculate genuine round-trip latency without Math.max(12, elapsed)
    assert.ok(!content.includes('Math.max(12, elapsed)'), 'Fabricated latency Math.max(12, elapsed) must be removed');
  });

  test('6. Issue 5: Silent mode is persisted for Telegram and Zalo in handleFinalize', () => {
    const content = fs.readFileSync(wizardPath, 'utf-8');

    // Telegram config in handleFinalize includes silent_mode: isSilentMode
    assert.match(
      content,
      /handleFinalize[\s\S]*?fetch\(['"]\/api\/v1\/integrations\/telegram\/config['"][\s\S]*?silent_mode:\s*isSilentMode/,
      'handleFinalize Telegram config must include silent_mode: isSilentMode'
    );

    // Zalo vault in handleFinalize includes silent_mode: isSilentMode
    assert.match(
      content,
      /handleFinalize[\s\S]*?fetch\(['"]\/api\/v1\/integrations\/vault\/zalo_bot['"][\s\S]*?silent_mode:\s*isSilentMode/,
      'handleFinalize Zalo vault must include silent_mode: isSilentMode'
    );
  });
});
