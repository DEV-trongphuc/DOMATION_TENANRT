import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const BACKEND_ROOT = path.resolve(__dirname, '..', '..');
const WORKSPACE_ROOT = path.resolve(BACKEND_ROOT, '..');
const FRONTEND_ROOT = path.join(WORKSPACE_ROOT, 'DOMATION_LANDINGPAGE');
const PORTFOLIO_ROOT = path.join(WORKSPACE_ROOT, 'MY_PORTFOLIO');

const BACKEND_E2E_DIR = __dirname;
const FRONTEND_E2E_DIR = path.join(FRONTEND_ROOT, 'tests', 'e2e');

const args = new Set(process.argv.slice(2));
const HARNESS_CHECK = args.has('--harness-check');
const BACKEND_ONLY = args.has('--backend-only');
const FRONTEND_ONLY = args.has('--frontend-only');
const STRICT_SERVER_TSC = args.has('--strict-server-tsc');

if (BACKEND_ONLY && FRONTEND_ONLY) {
  console.error('Cannot specify both --backend-only and --frontend-only.');
  process.exit(2);
}

const EXPECTED_BACKEND_HELPERS = [
  'helpers/e2e-harness.ts',
  'helpers/mock-fetch.ts',
  'helpers/mock-webhook-sink.ts',
  'helpers/fixtures.ts',
];

const EXPECTED_BACKEND_SUITES = [
  'f7-billing-lifecycle.e2e.test.ts',
  'f8-daily-report-meta.e2e.test.ts',
  'f2-f9-closed-loop-perf.e2e.test.ts',
  'tier3-tier4-backend.e2e.test.ts',
];

const EXPECTED_FRONTEND_HELPERS = [
  'helpers/frontend-e2e-harness.mjs',
  'helpers/my-portfolio-baseline.json',
];

const EXPECTED_FRONTEND_SUITES = [
  'f1-f4-landing-seo-strategy.e2e.test.mjs',
  'f5-f6-setup-tours-ui.e2e.test.mjs',
  'f7-f9-sync-billing-ui.e2e.test.mjs',
  'tier3-tier4-ecosystem.e2e.test.mjs',
];

function discoverTestFiles(dir, suffix) {
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir, { withFileTypes: true })
    .filter((ent) => ent.isFile() && ent.name.endsWith(suffix))
    .map((ent) => path.join(dir, ent.name))
    .sort();
}

function countDeclaredTests(filePath) {
  const src = fs.readFileSync(filePath, 'utf8');
  const lines = src.split(/\r?\n/);
  let total = 0;
  let tier1 = 0;
  let tier2 = 0;
  let tier3 = 0;
  let tier4 = 0;

  for (const line of lines) {
    const m = line.match(/^\s*(?:await\s+t\.)?(?:test|it)\s*\(\s*(['"`])(.*?)\1/);
    if (!m) continue;
    total += 1;
    const title = m[2];
    if (/(?:\btier\s*1\b|-T1\.)/i.test(title)) tier1 += 1;
    else if (/(?:\btier\s*2\b|-T2\.)/i.test(title)) tier2 += 1;
    else if (/(?:\btier\s*3\b|Tier3-|-T3\.)/i.test(title)) tier3 += 1;
    else if (/(?:\btier\s*4\b|Tier4-|-T4\.)/i.test(title)) tier4 += 1;
  }

  return { total, tier1, tier2, tier3, tier4 };
}

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

const TASK_BASELINE_UTC_MS = Date.parse('2026-11-19T12:39:00Z');

function findModifiedAfter(dir, cutoffMs, hits = []) {
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    if (ent.name === 'node_modules' || ent.name === '.git') continue;
    const full = path.join(dir, ent.name);
    if (ent.isDirectory()) {
      findModifiedAfter(full, cutoffMs, hits);
    } else if (ent.isFile()) {
      const st = fs.statSync(full);
      if (st.mtimeMs > cutoffMs) {
        hits.push(`${path.relative(PORTFOLIO_ROOT, full)} (${new Date(st.mtimeMs).toISOString()})`);
      }
    }
  }
  return hits;
}

function checkPortfolioUntouched() {
  if (!fs.existsSync(PORTFOLIO_ROOT)) {
    return { ok: true, detail: 'MY_PORTFOLIO directory not present (skipped)' };
  }

  const baselinePath = path.join(FRONTEND_E2E_DIR, 'helpers', 'my-portfolio-baseline.json');
  if (fs.existsSync(baselinePath)) {
    try {
      const baseline = JSON.parse(fs.readFileSync(baselinePath, 'utf8'));
      const headRes = spawnSync('git', ['-C', PORTFOLIO_ROOT, 'rev-parse', 'HEAD'], { encoding: 'utf8' });
      const statusRes = spawnSync('git', ['-C', PORTFOLIO_ROOT, 'status', '--porcelain'], { encoding: 'utf8' });
      const diffRes = spawnSync('git', ['-C', PORTFOLIO_ROOT, 'diff'], { encoding: 'utf8' });

      if (headRes.status === 0 && statusRes.status === 0 && diffRes.status === 0) {
        const currentHead = (headRes.stdout || '').trim();
        const currentPorcelain = (statusRes.stdout || '')
          .split(/\r?\n/)
          .filter((l) => l.length > 0);
        const currentDiffSha = crypto.createHash('sha256').update(diffRes.stdout || '', 'utf8').digest('hex');

        const problems = [];
        if (baseline.head && currentHead !== baseline.head) {
          problems.push(`HEAD changed: expected ${baseline.head}, got ${currentHead}`);
        }
        const expectedSet = new Set(Array.isArray(baseline.porcelain) ? baseline.porcelain : []);
        const currentSet = new Set(currentPorcelain);
        const added = [...currentSet].filter((x) => !expectedSet.has(x));
        const removed = [...expectedSet].filter((x) => !currentSet.has(x));
        if (added.length > 0 || removed.length > 0) {
          problems.push(
            `git status porcelain drifted (added=${JSON.stringify(added)}, removed=${JSON.stringify(removed)})`
          );
        }
        if (baseline.diffSha256 && currentDiffSha !== baseline.diffSha256) {
          problems.push(`git diff SHA-256 changed: expected ${baseline.diffSha256}, got ${currentDiffSha}`);
        }

        if (problems.length > 0) {
          return { ok: false, detail: `MY_PORTFOLIO baseline mismatch:\n${problems.join('\n')}` };
        }
        return {
          ok: true,
          detail: `MY_PORTFOLIO matches baseline (${currentHead.slice(0, 8)}, ${currentPorcelain.length} porcelain entries, diffSha256=${currentDiffSha.slice(0, 12)})`,
        };
      }
    } catch (err) {
      return { ok: false, detail: `Failed checking MY_PORTFOLIO baseline: ${err?.message || String(err)}` };
    }
  }

  const gitCommitRes = spawnSync('git', ['log', '-1', '--format=%cI'], {
    cwd: PORTFOLIO_ROOT,
    encoding: 'utf8',
  });
  if (gitCommitRes.status === 0) {
    const commitIso = (gitCommitRes.stdout || '').trim();
    if (commitIso && Date.parse(commitIso) > TASK_BASELINE_UTC_MS) {
      return { ok: false, detail: `MY_PORTFOLIO has a new git commit after task start: ${commitIso}` };
    }
  }
  const touched = findModifiedAfter(PORTFOLIO_ROOT, TASK_BASELINE_UTC_MS);
  if (touched.length > 0) {
    return { ok: false, detail: `MY_PORTFOLIO files modified after task start:\n${touched.join('\n')}` };
  }
  return { ok: true, detail: 'MY_PORTFOLIO untouched since task start (0 modified files, 0 new commits)' };
}

function runHarnessCheck() {
  console.log('=== DOMATION E2E Harness Check ===');
  let failures = 0;

  if (!BACKEND_ONLY) {
    // Check runner itself
    const selfCheck = spawnSync(process.execPath, ['--check', __filename], { encoding: 'utf8' });
    if (selfCheck.status !== 0) {
      console.error(`[FAIL] Syntax check failed for ${__filename}:\n${selfCheck.stderr}`);
      failures += 1;
    }
  }

  const runBackend = !FRONTEND_ONLY;
  const runFrontend = !BACKEND_ONLY;

  const backendFiles = runBackend ? discoverTestFiles(BACKEND_E2E_DIR, '.e2e.test.ts') : [];
  const frontendFiles = runFrontend ? discoverTestFiles(FRONTEND_E2E_DIR, '.e2e.test.mjs') : [];

  if (runBackend) {
    for (const rel of [...EXPECTED_BACKEND_HELPERS, ...EXPECTED_BACKEND_SUITES]) {
      const full = path.join(BACKEND_E2E_DIR, rel);
      if (!fs.existsSync(full)) {
        console.error(`[FAIL] Missing expected backend E2E file: ${full}`);
        failures += 1;
      }
    }

    const tscCli = resolveTscCliPath();
    if (tscCli) {
      console.log('Running TypeScript compile check (tsc -p tsconfig.server.json --noEmit)...');
      const tscRes = spawnSync(process.execPath, [tscCli, '-p', 'tsconfig.server.json', '--noEmit'], {
        cwd: BACKEND_ROOT,
        encoding: 'utf8',
      });
      if (tscRes.status !== 0) {
        const combinedOut = `${tscRes.stdout || ''}\n${tscRes.stderr || ''}`.trim();
        const diagLines = combinedOut
          .split(/\r?\n/)
          .filter((l) => /^(.+?)\(\d+,\d+\):\s+error\s+TS\d+:/.test(l));
        const e2eErrors = [];
        const nonE2eErrors = [];
        for (const l of diagLines) {
          const m = l.match(/^(.+?)\(\d+,\d+\):\s+error\s+TS\d+:/);
          const filePath = (m ? m[1] : '').replace(/\\/g, '/');
          if (filePath.startsWith('tests/e2e/')) {
            e2eErrors.push(l);
          } else {
            nonE2eErrors.push(l);
          }
        }

        if (e2eErrors.length > 0 || (diagLines.length === 0 && tscRes.status !== 0)) {
          console.error(
            `[FAIL] E2E TypeScript check failed (${e2eErrors.length} E2E error(s)):\n${e2eErrors.length > 0 ? e2eErrors.join('\n') : combinedOut}`
          );
          failures += 1;
        } else {
          console.log('[OK] E2E TypeScript compile check passed for tests/e2e/ (0 errors).');
          if (nonE2eErrors.length > 0) {
            const msg = `[WARN] Concurrent server/non-E2E TypeScript check reported ${nonE2eErrors.length} error(s):\n${nonE2eErrors.join('\n')}`;
            if (STRICT_SERVER_TSC) {
              console.error(`[FAIL] --strict-server-tsc active: ${msg}`);
              failures += 1;
            } else {
              console.warn(msg);
            }
          }
        }
      } else {
        console.log('[OK] Backend TypeScript compile check passed (0 errors).');
      }
    } else {
      console.warn('[WARN] typescript/bin/tsc not found; checking Node strip-types parse on backend test files.');
      for (const f of backendFiles) {
        const syn = spawnSync(process.execPath, ['--check', f], { encoding: 'utf8' });
        if (syn.status !== 0) {
          console.error(`[FAIL] Syntax parse failed for ${f}:\n${syn.stderr}`);
          failures += 1;
        }
      }
    }
  }

  if (runFrontend) {
    for (const rel of [...EXPECTED_FRONTEND_HELPERS, ...EXPECTED_FRONTEND_SUITES]) {
      const full = path.join(FRONTEND_E2E_DIR, rel);
      if (!fs.existsSync(full)) {
        console.error(`[FAIL] Missing expected frontend E2E file: ${full}`);
        failures += 1;
      }
    }

    if (frontendFiles.length === 0) {
      console.error(`[FAIL] No frontend *.e2e.test.mjs files found in ${FRONTEND_E2E_DIR}`);
      failures += 1;
    } else {
      for (const f of frontendFiles) {
        const syn = spawnSync(process.execPath, ['--check', f], { encoding: 'utf8' });
        if (syn.status !== 0) {
          console.error(`[FAIL] Syntax check failed for ${f}:\n${syn.stderr}`);
          failures += 1;
        }
      }
      const helperPath = path.join(FRONTEND_E2E_DIR, 'helpers', 'frontend-e2e-harness.mjs');
      if (fs.existsSync(helperPath)) {
        const syn = spawnSync(process.execPath, ['--check', helperPath], { encoding: 'utf8' });
        if (syn.status !== 0) {
          console.error(`[FAIL] Syntax check failed for ${helperPath}:\n${syn.stderr}`);
          failures += 1;
        }
      }
      console.log(`[OK] Frontend syntax check passed for ${frontendFiles.length} suite(s).`);
    }
  }

  console.log('\n--- Discovered E2E Suites & Declared Test Counts ---');
  let grandTotal = 0;
  const tierTotals = { tier1: 0, tier2: 0, tier3: 0, tier4: 0 };

  for (const [label, list] of [
    ['Backend (AUTO_DATA_TENANRT)', backendFiles],
    ['Frontend (DOMATION_LANDINGPAGE)', frontendFiles],
  ]) {
    if (list.length === 0) continue;
    console.log(`\n[${label}]`);
    for (const f of list) {
      const c = countDeclaredTests(f);
      grandTotal += c.total;
      tierTotals.tier1 += c.tier1;
      tierTotals.tier2 += c.tier2;
      tierTotals.tier3 += c.tier3;
      tierTotals.tier4 += c.tier4;
      console.log(
        `  - ${path.basename(f)}: total=${c.total} (T1=${c.tier1}, T2=${c.tier2}, T3=${c.tier3}, T4=${c.tier4})`
      );
    }
  }

  console.log(
    `\nTotal declared tests: ${grandTotal} (Tier1=${tierTotals.tier1}, Tier2=${tierTotals.tier2}, Tier3=${tierTotals.tier3}, Tier4=${tierTotals.tier4})`
  );

  const minThresholds = BACKEND_ONLY
    ? { tier1: 25, tier2: 25, tier3: 5, tier4: 4 }
    : FRONTEND_ONLY
      ? { tier1: 20, tier2: 20, tier3: 4, tier4: 2 }
      : { tier1: 45, tier2: 45, tier3: 9, tier4: 6 };

  for (const [k, minVal] of Object.entries(minThresholds)) {
    if (tierTotals[k] < minVal) {
      console.error(`[FAIL] Minimum threshold not met for ${k}: got ${tierTotals[k]}, required >= ${minVal}`);
      failures += 1;
    }
  }

  const portfolioCheck = checkPortfolioUntouched();
  if (!portfolioCheck.ok) {
    console.error(`[FAIL] ${portfolioCheck.detail}`);
    failures += 1;
  } else {
    console.log(`[OK] ${portfolioCheck.detail}`);
  }

  if (failures > 0) {
    console.error(`\nHarness check FAILED with ${failures} error(s).`);
    process.exit(1);
  }
  console.log('\nHarness check PASSED.');
  process.exit(0);
}

function runSuites() {
  const runBackend = !FRONTEND_ONLY;
  const runFrontend = !BACKEND_ONLY;

  const backendFiles = runBackend ? discoverTestFiles(BACKEND_E2E_DIR, '.e2e.test.ts') : [];
  const frontendFiles = runFrontend ? discoverTestFiles(FRONTEND_E2E_DIR, '.e2e.test.mjs') : [];

  let overallExit = 0;

  if (runBackend) {
    if (backendFiles.length === 0) {
      console.error(`No backend E2E files found in ${BACKEND_E2E_DIR}`);
      process.exit(1);
    }
    const relFiles = backendFiles.map((f) => path.relative(BACKEND_ROOT, f));
    const tsxCli = resolveTsxCliPath();
    console.log(`\n=== Running Backend E2E (${relFiles.length} suites) ===`);
    let res;
    if (tsxCli) {
      res = spawnSync(process.execPath, [tsxCli, '--test', '--test-concurrency=1', ...relFiles], {
        cwd: BACKEND_ROOT,
        stdio: 'inherit',
      });
    } else {
      const npxCmd = process.platform === 'win32' ? 'npx.cmd' : 'npx';
      res = spawnSync(npxCmd, ['tsx', '--test', '--test-concurrency=1', ...relFiles], {
        cwd: BACKEND_ROOT,
        stdio: 'inherit',
        shell: process.platform === 'win32',
      });
    }
    if (res.status !== 0) {
      overallExit = res.status || 1;
    }
  }

  if (runFrontend) {
    if (frontendFiles.length === 0) {
      console.error(`No frontend E2E files found in ${FRONTEND_E2E_DIR}`);
      overallExit = overallExit || 1;
    } else {
      const relFiles = frontendFiles.map((f) => path.relative(FRONTEND_ROOT, f));
      console.log(`\n=== Running Frontend / Cross-Repo E2E (${relFiles.length} suites) ===`);
      const res = spawnSync(process.execPath, ['--test', '--test-concurrency=1', ...relFiles], {
        cwd: FRONTEND_ROOT,
        stdio: 'inherit',
      });
      if (res.status !== 0) {
        overallExit = res.status || 1;
      }
    }
  }

  const portfolioCheck = checkPortfolioUntouched();
  if (!portfolioCheck.ok) {
    console.error(`[FAIL] ${portfolioCheck.detail}`);
    overallExit = overallExit || 1;
  }

  process.exit(overallExit);
}

if (HARNESS_CHECK) {
  runHarnessCheck();
} else {
  runSuites();
}
