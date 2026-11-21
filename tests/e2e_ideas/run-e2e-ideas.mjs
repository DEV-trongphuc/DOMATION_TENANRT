import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const BACKEND_ROOT = path.resolve(__dirname, '..', '..');
const SUITE_DIR = __dirname;
const LIVE_PGDATA_DIR = path.join(BACKEND_ROOT, '.autodata-pgdata');

const rawArgs = process.argv.slice(2);

let requestedTier = null;
let HARNESS_CHECK = false;
let TYPECHECK_ONLY = false;
let STRICT_SERVER_TSC = false;

for (let i = 0; i < rawArgs.length; i++) {
  const arg = rawArgs[i];
  if (arg === '--harness-check') {
    HARNESS_CHECK = true;
  } else if (arg === '--typecheck') {
    TYPECHECK_ONLY = true;
  } else if (arg === '--strict-server-tsc') {
    STRICT_SERVER_TSC = true;
  } else if (arg.startsWith('--tier=')) {
    requestedTier = arg.slice('--tier='.length).trim().toLowerCase();
  } else if (arg === '--tier' && i + 1 < rawArgs.length) {
    requestedTier = rawArgs[++i].trim().toLowerCase();
  } else if (arg === '--help' || arg === '-h') {
    console.log(
      [
        'Usage: node tests/e2e_ideas/run-e2e-ideas.mjs [options]',
        '',
        'Options:',
        '  --tier=1|2|3|4|all     Run Tier 1..4 test files via tsx --test --test-concurrency=1',
        '  --harness-check        Validate runner syntax, files, tsc --noEmit, smoke test, and .autodata-pgdata safety',
        '  --typecheck            Run tsc -p tsconfig.server.json --noEmit only',
        '  --strict-server-tsc    Fail on any tsc diagnostic outside tests/e2e_ideas/',
      ].join('\n')
    );
    process.exit(0);
  } else {
    console.error(`Unknown argument: ${arg}`);
    process.exit(2);
  }
}

const VALID_TIERS = new Set(['1', '2', '3', '4', 'all']);
if (requestedTier !== null && !VALID_TIERS.has(requestedTier)) {
  console.error(`Invalid --tier value '${requestedTier}'. Expected 1, 2, 3, 4, or all.`);
  process.exit(2);
}

const REQUIRED_HARNESS_FILES = [
  'harness.ts',
  'helpers/mock-smtp.ts',
  'helpers/sns-signer.ts',
  'helpers/mock-fetch.ts',
  'helpers/synthetic-myerp.ts',
  'harness.smoke.test.ts',
  'run-e2e-ideas.mjs',
];

function resolveTsxCliPath() {
  const candidates = [
    path.join(BACKEND_ROOT, 'node_modules', 'tsx', 'dist', 'cli.mjs'),
    path.join(BACKEND_ROOT, 'node_modules', 'tsx', 'dist', 'cli.js'),
  ];
  return candidates.find((p) => fs.existsSync(p)) || null;
}

function resolveTscCliPath() {
  const candidate = path.join(BACKEND_ROOT, 'node_modules', 'typescript', 'bin', 'tsc');
  return fs.existsSync(candidate) ? candidate : null;
}

function snapshotLivePgData() {
  if (!fs.existsSync(LIVE_PGDATA_DIR)) {
    return { exists: false, maxMtimeMs: 0, fileCount: 0 };
  }
  let maxMtimeMs = 0;
  let fileCount = 0;
  const walk = (dir) => {
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, ent.name);
      const st = fs.statSync(full);
      if (st.mtimeMs > maxMtimeMs) maxMtimeMs = st.mtimeMs;
      if (ent.isDirectory()) {
        walk(full);
      } else {
        fileCount += 1;
      }
    }
  };
  walk(LIVE_PGDATA_DIR);
  return { exists: true, maxMtimeMs, fileCount };
}

function checkLivePgDataUnmodified(before, after) {
  if (!before.exists && !after.exists) {
    return { ok: true, detail: '.autodata-pgdata does not exist (untouched)' };
  }
  if (!before.exists && after.exists) {
    return { ok: false, detail: '.autodata-pgdata was created during test run!' };
  }
  if (before.fileCount !== after.fileCount || after.maxMtimeMs > before.maxMtimeMs) {
    return {
      ok: false,
      detail: `.autodata-pgdata mutated (before=${JSON.stringify(before)}, after=${JSON.stringify(after)})`,
    };
  }
  return {
    ok: true,
    detail: `.autodata-pgdata untouched (${after.fileCount} files, latest mtime=${new Date(after.maxMtimeMs).toISOString()})`,
  };
}

function discoverTierFiles(tier) {
  if (!fs.existsSync(SUITE_DIR)) return [];
  const prefix = tier === 'all' ? 'tier' : `tier${tier}_`;
  return fs
    .readdirSync(SUITE_DIR, { withFileTypes: true })
    .filter((ent) => ent.isFile() && ent.name.startsWith(prefix) && ent.name.endsWith('.test.ts'))
    .map((ent) => path.join(SUITE_DIR, ent.name))
    .sort();
}

function countDeclaredTests(filePath) {
  const src = fs.readFileSync(filePath, 'utf8');
  let count = 0;
  for (const line of src.split(/\r?\n/)) {
    if (/^\s*(?:await\s+t\.)?(?:test|it)\s*\(\s*(['"`])/.test(line)) {
      count += 1;
    }
  }
  return count;
}

function runTscCheck() {
  const tscCli = resolveTscCliPath();
  if (!tscCli) {
    console.error('[FAIL] typescript/bin/tsc not found in node_modules.');
    return { ok: false, e2eErrors: [], externalErrors: [] };
  }

  console.log('Running TypeScript check (tsc -p tsconfig.server.json --noEmit)...');
  const res = spawnSync(process.execPath, [tscCli, '-p', 'tsconfig.server.json', '--noEmit'], {
    cwd: BACKEND_ROOT,
    encoding: 'utf8',
  });

  if (res.status === 0) {
    console.log('[OK] tsc -p tsconfig.server.json --noEmit passed (0 errors).');
    return { ok: true, e2eErrors: [], externalErrors: [] };
  }

  const combined = `${res.stdout || ''}\n${res.stderr || ''}`.trim();
  const diagLines = combined
    .split(/\r?\n/)
    .filter((l) => /^(.+?)\(\d+,\d+\):\s+error\s+TS\d+:/.test(l));

  const e2eErrors = [];
  const externalErrors = [];
  for (const line of diagLines) {
    const m = line.match(/^(.+?)\(\d+,\d+\):\s+error\s+TS\d+:/);
    const filePath = (m ? m[1] : '').replace(/\\/g, '/');
    if (filePath.startsWith('tests/e2e_ideas/')) {
      e2eErrors.push(line);
    } else {
      externalErrors.push(line);
    }
  }

  if (e2eErrors.length > 0) {
    console.error(`[FAIL] TypeScript errors in tests/e2e_ideas/ (${e2eErrors.length}):\n${e2eErrors.join('\n')}`);
  } else {
    console.log('[OK] Zero TypeScript errors inside tests/e2e_ideas/.');
  }

  if (externalErrors.length > 0) {
    console.error(
      `[FAIL] TypeScript errors outside tests/e2e_ideas/ (${externalErrors.length}):\n${externalErrors.join('\n')}`
    );
  } else if (e2eErrors.length === 0) {
    console.error(`[FAIL] tsc exited with code ${res.status}:\n${combined}`);
  }

  if (STRICT_SERVER_TSC && externalErrors.length > 0) {
    console.error('[FAIL] --strict-server-tsc rejected external TypeScript diagnostics.');
  }

  return { ok: false, e2eErrors, externalErrors };
}

function runTsxTests(relativeOrAbsFiles) {
  const tsxCli = resolveTsxCliPath();
  if (!tsxCli) {
    console.error('[FAIL] tsx CLI not found in node_modules/tsx/dist/.');
    return 1;
  }

  const relFiles = relativeOrAbsFiles.map((f) => path.relative(BACKEND_ROOT, f));
  console.log(`Executing tsx --test --test-concurrency=1 on ${relFiles.length} file(s):`);
  for (const rf of relFiles) {
    console.log(`  - ${rf}`);
  }

  const res = spawnSync(process.execPath, [tsxCli, '--test', '--test-concurrency=1', ...relFiles], {
    cwd: BACKEND_ROOT,
    stdio: 'inherit',
  });
  return res.status ?? 1;
}

if (TYPECHECK_ONLY) {
  const tscResult = runTscCheck();
  process.exit(tscResult.ok ? 0 : 1);
}

if (HARNESS_CHECK) {
  console.log('=== E2E IDEAS Harness Check ===');
  let failures = 0;

  const syn = spawnSync(process.execPath, ['--check', __filename], { encoding: 'utf8' });
  if (syn.status !== 0) {
    console.error(`[FAIL] Syntax check failed for ${__filename}:\n${syn.stderr}`);
    failures += 1;
  } else {
    console.log('[OK] Runner syntax check passed.');
  }

  for (const rel of REQUIRED_HARNESS_FILES) {
    const full = path.join(SUITE_DIR, rel);
    if (!fs.existsSync(full)) {
      console.error(`[FAIL] Missing required harness file: ${full}`);
      failures += 1;
    }
  }
  if (failures === 0) {
    console.log(`[OK] All ${REQUIRED_HARNESS_FILES.length} required harness files exist.`);
  }

  const tscResult = runTscCheck();
  if (!tscResult.ok) {
    failures += 1;
  }

  const tierFiles = discoverTierFiles('all');
  console.log(`Discovered ${tierFiles.length} tier test file(s).`);
  for (const tf of tierFiles) {
    console.log(`  - ${path.relative(BACKEND_ROOT, tf)} (${countDeclaredTests(tf)} declared tests)`);
  }

  const pgBefore = snapshotLivePgData();
  const smokeFile = path.join(SUITE_DIR, 'harness.smoke.test.ts');
  if (fs.existsSync(smokeFile)) {
    const smokeExit = runTsxTests([smokeFile]);
    if (smokeExit !== 0) {
      console.error(`[FAIL] harness.smoke.test.ts exited with status ${smokeExit}.`);
      failures += 1;
    } else {
      console.log('[OK] harness.smoke.test.ts passed.');
    }
  }
  const pgAfter = snapshotLivePgData();
  const pgCheck = checkLivePgDataUnmodified(pgBefore, pgAfter);
  if (!pgCheck.ok) {
    console.error(`[FAIL] ${pgCheck.detail}`);
    failures += 1;
  } else {
    console.log(`[OK] ${pgCheck.detail}`);
  }

  if (failures > 0) {
    console.error(`\nHarness check FAILED with ${failures} failure(s).`);
    process.exit(1);
  }
  console.log('\nHarness check PASSED.');
  process.exit(0);
}

const tier = requestedTier || 'all';
const files = discoverTierFiles(tier);
if (files.length === 0) {
  console.error(`No tier test files found for --tier=${tier} in ${SUITE_DIR}.`);
  process.exit(1);
}

const pgBefore = snapshotLivePgData();
const exitCode = runTsxTests(files);
const pgAfter = snapshotLivePgData();
const pgCheck = checkLivePgDataUnmodified(pgBefore, pgAfter);
if (!pgCheck.ok) {
  console.error(`[FAIL] ${pgCheck.detail}`);
  process.exit(1);
}
console.log(`[OK] ${pgCheck.detail}`);
process.exit(exitCode);
