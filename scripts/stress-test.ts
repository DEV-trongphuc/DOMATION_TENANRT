import http from 'node:http';
import https from 'node:https';
import { performance } from 'node:perf_hooks';

interface StressOptions {
  url: string;
  concurrency: number;
  total: number;
  duration: number; // in seconds, 0 = unlimited
}

interface RequestSample {
  category: 'inbound_lead' | 'stage_transition' | 'dashboard_query' | 'bcrypt_login' | 'master_cron';
  latencyMs: number;
  status: number;
  success: boolean;
  cronSkippedOrLocked?: boolean;
  error?: string;
}

/**
 * MANDATORY PRODUCTION ABORT GUARD:
 * Inspects target URL. If hostname contains 'domation.net' or is not local loopback,
 * immediately aborts with an explicit error message and exit code 1.
 */
export function enforceProductionAbortGuard(targetUrl: string): void {
  let parsed: URL;
  try {
    parsed = new URL(targetUrl);
  } catch (err: any) {
    console.error(`\n\x1b[31m[PRODUCTION ABORT GUARD] Invalid URL provided: "${targetUrl}" (${err?.message})\x1b[0m\n`);
    process.exit(1);
  }

  const hostname = parsed.hostname.toLowerCase();
  const isLocalhost =
    hostname === 'localhost' ||
    hostname === '127.0.0.1' ||
    hostname === '::1' ||
    hostname === '[::1]';
  const containsDomation = hostname.includes('domation.net');

  if (containsDomation || !isLocalhost) {
    console.error(
      `\n\x1b[41m\x1b[37m[CRITICAL SAFETY VIOLATION: PRODUCTION ABORT GUARD ACTIVATED]\x1b[0m\n` +
      `Target URL "${targetUrl}" resolves to remote/production hostname: "${hostname}".\n` +
      `STRESS TESTING AGAINST REMOTE OR PRODUCTION SERVERS IS STRICTLY PROHIBITED!\n` +
      `Only local loopback hosts (localhost, 127.0.0.1, ::1) are permitted for load testing.\n` +
      `Aborting execution immediately with exit code 1.\n`
    );
    process.exit(1);
  }
}

/**
 * Parses CLI arguments supporting `--arg value` and `--arg=value` syntax.
 */
export function parseCliArgs(argv: string[]): StressOptions {
  const options: StressOptions = {
    url: 'http://127.0.0.1:3100',
    concurrency: 20,
    total: 200,
    duration: 0,
  };

  for (let i = 2; i < argv.length; i++) {
    const arg = argv[i];

    if (arg === '--url' && i + 1 < argv.length) {
      options.url = argv[++i];
    } else if (arg.startsWith('--url=')) {
      options.url = arg.slice(6);
    } else if ((arg === '--concurrency' || arg === '-c') && i + 1 < argv.length) {
      options.concurrency = parseInt(argv[++i], 10) || 20;
    } else if (arg.startsWith('--concurrency=')) {
      options.concurrency = parseInt(arg.slice(14), 10) || 20;
    } else if ((arg === '--total' || arg === '-n') && i + 1 < argv.length) {
      options.total = parseInt(argv[++i], 10) || 200;
    } else if (arg.startsWith('--total=')) {
      options.total = parseInt(arg.slice(8), 10) || 200;
    } else if ((arg === '--duration' || arg === '-d') && i + 1 < argv.length) {
      options.duration = parseInt(argv[++i], 10) || 0;
    } else if (arg.startsWith('--duration=')) {
      options.duration = parseInt(arg.slice(11), 10) || 0;
    } else if (arg === '--help' || arg === '-h') {
      console.log(`
DOMATION AutoData Standalone Live Stress Script
Usage:
  npx tsx scripts/stress-test.ts [options]

Options:
  --url <url>              Target server URL (default: http://127.0.0.1:3100)
                           * Strict guard: MUST be localhost/127.0.0.1/::1. Remote URLs abort with code 1.
  --concurrency, -c <num>  Concurrent worker count (default: 20)
  --total, -n <num>        Total number of requests to execute (default: 200)
  --duration, -d <seconds> Max duration in seconds (optional, default: 0 = until total)
  --help, -h               Show this help message
`);
      process.exit(0);
    }
  }

  return options;
}

/**
 * Native HTTP/HTTPS request helper for zero-dependency high-throughput benchmarking.
 */
function rawHttpRequest(
  targetUrl: string,
  path: string,
  options: {
    method?: string;
    headers?: Record<string, string>;
    body?: string;
  } = {}
): Promise<{ status: number; body: string; json: any }> {
  return new Promise((resolve) => {
    const fullUrl = new URL(path, targetUrl);
    const isHttps = fullUrl.protocol === 'https:';
    const transport = isHttps ? https : http;

    const req = transport.request(
      fullUrl,
      {
        method: options.method || 'GET',
        headers: {
          'Content-Type': 'application/json',
          Connection: 'keep-alive',
          ...(options.headers || {}),
        },
      },
      (res) => {
        let responseData = '';
        res.on('data', (chunk) => {
          responseData += chunk;
        });
        res.on('end', () => {
          let json: any = {};
          try {
            json = JSON.parse(responseData);
          } catch {}
          resolve({ status: res.statusCode || 0, body: responseData, json });
        });
      }
    );

    req.on('error', (err) => {
      resolve({ status: 0, body: err.message, json: { error: err.message } });
    });

    if (options.body) {
      req.write(options.body);
    }
    req.end();
  });
}

function calculatePercentile(sortedValues: number[], percentile: number): number {
  if (sortedValues.length === 0) return 0;
  const index = Math.ceil((percentile / 100) * sortedValues.length) - 1;
  return sortedValues[Math.max(0, Math.min(index, sortedValues.length - 1))];
}

async function main() {
  const args = parseCliArgs(process.argv);

  // 1. MANDATORY PRODUCTION ABORT GUARD CHECK
  enforceProductionAbortGuard(args.url);

  console.log(`\n===================================================================`);
  console.log(` DOMATION AutoData Full-Stack Live Stress Test Harness`);
  console.log(` Target Server:  ${args.url} (Local dev loopback verified)`);
  console.log(` Concurrency:    ${args.concurrency} concurrent workers`);
  console.log(` Total Requests: ${args.total}`);
  if (args.duration > 0) {
    console.log(` Duration Cap:   ${args.duration}s`);
  }
  console.log(`===================================================================\n`);

  // 2. Pre-flight health and auth bootstrapping
  console.log('[StressTest] 1. Verifying dev server health...');
  const health = await rawHttpRequest(args.url, '/api/v1/health');
  if (health.status !== 200) {
    console.error(`\x1b[31m[FAILED] Target server ${args.url} is unhealthy (HTTP ${health.status})\x1b[0m`);
    process.exit(1);
  }
  console.log(`[StressTest]    Health check OK (${health.json.service || 'AutoData Engine'})\n`);

  console.log('[StressTest] 2. Bootstrapping test tokens and tenant context...');
  // Superadmin credentials
  const superadminLogin = await rawHttpRequest(args.url, '/api/v1/admin/auth/login', {
    method: 'POST',
    body: JSON.stringify({
      email: 'ops-admin@autodata.vn',
      password: 'SuperAdminMasterPassword999!',
    }),
  });

  const superadminToken = superadminLogin.json.data?.access_token || '';

  // Tenant admin credentials (ecolife workspace)
  const tenantLogin = await rawHttpRequest(args.url, '/api/v1/auth/login', {
    method: 'POST',
    body: JSON.stringify({
      email: 'turniodev@gmail.com',
      password: '123456',
      tenant_slug: 'ecolife',
    }),
  });

  const tenantToken = tenantLogin.json.data?.access_token || superadminToken;
  const tenantSlug = 'ecolife';

  // Discover stages and sample leads for stage transitions
  const pipelinesRes = await rawHttpRequest(args.url, '/api/v1/pipelines', {
    headers: { Authorization: `Bearer ${tenantToken}`, 'X-Tenant-Slug': tenantSlug },
  });
  const stages = pipelinesRes.json.data?.[0]?.stages || [];
  const stageIds = stages.map((s: any) => s.id);

  // Discover existing leads or seed one
  const leadsRes = await rawHttpRequest(args.url, '/api/v1/leads?limit=20', {
    headers: { Authorization: `Bearer ${tenantToken}`, 'X-Tenant-Slug': tenantSlug },
  });
  let activeLeadIds = (leadsRes.json.data?.items || []).map((l: any) => l.id);

  if (activeLeadIds.length === 0) {
    const seedLead = await rawHttpRequest(args.url, '/api/v1/leads/quick-test', {
      method: 'POST',
      headers: { Authorization: `Bearer ${tenantToken}`, 'X-Tenant-Slug': tenantSlug },
      body: JSON.stringify({
        name: 'Stress Seed Lead',
        phone: '0912999888',
        source: 'Stress Bootstrap',
      }),
    });
    if (seedLead.json.data?.leadId) {
      activeLeadIds.push(seedLead.json.data.leadId);
    }
  }

  console.log(`[StressTest]    Bootstrap complete. Discovered ${stageIds.length} stages, ${activeLeadIds.length} leads.\n`);

  // 3. Workload Execution
  console.log(`[StressTest] 3. Commencing concurrency burst (${args.total} requests, concurrency ${args.concurrency})...\n`);

  const samples: RequestSample[] = [];
  const cronSecret = 'autodata-platform-superadmin-jwt-secret-2026';
  let cursor = 0;
  const startTime = performance.now();
  const endTimeCap = args.duration > 0 ? startTime + args.duration * 1000 : Infinity;

  // Workload factory generator
  const createWorkloadTask = (index: number): (() => Promise<void>) => {
    // Workload profile:
    // 25% Inbound Lead Ingest / Webhooks
    // 25% Lead Stage Transitions
    // 25% Authenticated Dashboard Queries
    // 15% Bcrypt Logins
    // 10% Master Cron Triggers
    const mod = index % 20;

    if (mod < 5) {
      // 1. Inbound Lead Webhook / Quick Test (25%)
      return async () => {
        const uniquePhone = `0912${String(100000 + (index % 900000))}`;
        const t0 = performance.now();
        const res = await rawHttpRequest(args.url, '/api/v1/leads/quick-test', {
          method: 'POST',
          headers: { Authorization: `Bearer ${tenantToken}`, 'X-Tenant-Slug': tenantSlug },
          body: JSON.stringify({
            name: `Khách Stress #${index + 1}`,
            phone: uniquePhone,
            source: 'Stress Test Live',
            campaign: 'Live Load Test',
          }),
        });
        const latencyMs = performance.now() - t0;
        const success = res.status >= 200 && res.status < 300;
        if (success && res.json.data?.leadId) {
          activeLeadIds.push(res.json.data.leadId);
        }
        samples.push({
          category: 'inbound_lead',
          latencyMs,
          status: res.status,
          success,
          error: success ? undefined : res.json.error?.message || res.body,
        });
      };
    } else if (mod < 10) {
      // 2. Lead Stage Transition (25%)
      return async () => {
        const targetLeadId = activeLeadIds[index % activeLeadIds.length] || '';
        const targetStageId = stageIds[(index + 1) % (stageIds.length || 1)] || '';
        const t0 = performance.now();
        const res = await rawHttpRequest(args.url, `/api/v1/leads/${targetLeadId}/stage`, {
          method: 'PATCH',
          headers: { Authorization: `Bearer ${tenantToken}`, 'X-Tenant-Slug': tenantSlug },
          body: JSON.stringify({ stage_id: targetStageId }),
        });
        const latencyMs = performance.now() - t0;
        const success = res.status === 200;
        samples.push({
          category: 'stage_transition',
          latencyMs,
          status: res.status,
          success,
          error: success ? undefined : res.json.error?.message || res.body,
        });
      };
    } else if (mod < 15) {
      // 3. Authenticated Dashboard Queries (25%)
      return async () => {
        const subPath = index % 2 === 0 ? '/api/v1/workspace/bootstrap' : '/api/v1/leads?limit=20';
        const t0 = performance.now();
        const res = await rawHttpRequest(args.url, subPath, {
          headers: { Authorization: `Bearer ${tenantToken}`, 'X-Tenant-Slug': tenantSlug },
        });
        const latencyMs = performance.now() - t0;
        const success = res.status === 200;
        samples.push({
          category: 'dashboard_query',
          latencyMs,
          status: res.status,
          success,
          error: success ? undefined : res.json.error?.message || res.body,
        });
      };
    } else if (mod < 18) {
      // 4. Bcrypt Logins (15%)
      return async () => {
        const t0 = performance.now();
        const res = await rawHttpRequest(args.url, '/api/v1/auth/login', {
          method: 'POST',
          body: JSON.stringify({
            email: 'turniodev@gmail.com',
            password: '123456',
            tenant_slug: tenantSlug,
          }),
        });
        const latencyMs = performance.now() - t0;
        const success = res.status === 200;
        samples.push({
          category: 'bcrypt_login',
          latencyMs,
          status: res.status,
          success,
          error: success ? undefined : res.json.error?.message || res.body,
        });
      };
    } else {
      // 5. Master Cron Trigger (10%)
      return async () => {
        const t0 = performance.now();
        const res = await rawHttpRequest(args.url, '/api/v1/operations/cron/master', {
          method: 'POST',
          headers: { 'X-Cron-Secret': cronSecret },
        });
        const latencyMs = performance.now() - t0;
        const isCleanSkip = res.status === 200 && (res.json.data?.skipped === true || res.json.data?.locked === true);
        const isExecution = res.status === 200 && res.json.data?.locked === false;
        const success = isCleanSkip || isExecution;

        samples.push({
          category: 'master_cron',
          latencyMs,
          status: res.status,
          success,
          cronSkippedOrLocked: isCleanSkip,
          error: success ? undefined : res.json.error?.message || res.body,
        });
      };
    }
  };

  // Run workers
  const workerCount = Math.min(args.concurrency, args.total);
  await Promise.all(
    Array.from({ length: workerCount }, async () => {
      while (cursor < args.total && performance.now() < endTimeCap) {
        const taskIdx = cursor++;
        const task = createWorkloadTask(taskIdx);
        await task();
      }
    })
  );

  const totalDurationMs = performance.now() - startTime;
  const totalDurationSec = totalDurationMs / 1000;
  const totalCompleted = samples.length;
  const throughputReqSec = totalCompleted / totalDurationSec;

  // 4. Compute Metrics
  const successSamples = samples.filter((s) => s.success);
  const successRate = totalCompleted > 0 ? (successSamples.length / totalCompleted) * 100 : 0;

  const count2xx = samples.filter((s) => s.status >= 200 && s.status < 300).length;
  const count4xx = samples.filter((s) => s.status >= 400 && s.status < 500).length;
  const count5xx = samples.filter((s) => s.status >= 500).length;
  const countNetErrors = samples.filter((s) => s.status === 0).length;
  const cleanCronSkips = samples.filter((s) => s.cronSkippedOrLocked).length;

  const latencies = samples.map((s) => s.latencyMs).sort((a, b) => a - b);
  const minLatency = latencies.length > 0 ? latencies[0] : 0;
  const maxLatency = latencies.length > 0 ? latencies[latencies.length - 1] : 0;
  const avgLatency = latencies.length > 0 ? latencies.reduce((a, b) => a + b, 0) / latencies.length : 0;
  const p50 = calculatePercentile(latencies, 50);
  const p90 = calculatePercentile(latencies, 90);
  const p95 = calculatePercentile(latencies, 95);
  const p99 = calculatePercentile(latencies, 99);

  // Group by workload category
  const categories = ['inbound_lead', 'stage_transition', 'dashboard_query', 'bcrypt_login', 'master_cron'] as const;
  const categoryStats = categories.map((cat) => {
    const subset = samples.filter((s) => s.category === cat);
    const subsetLatencies = subset.map((s) => s.latencyMs).sort((a, b) => a - b);
    const subAvg = subsetLatencies.length > 0 ? subsetLatencies.reduce((a, b) => a + b, 0) / subsetLatencies.length : 0;
    const subP95 = calculatePercentile(subsetLatencies, 95);
    const subSuccess = subset.filter((s) => s.success).length;
    return {
      category: cat,
      count: subset.length,
      successRate: subset.length > 0 ? (subSuccess / subset.length) * 100 : 0,
      avgMs: subAvg,
      p95Ms: subP95,
    };
  });

  // 5. Render Formatted Output Tables
  console.log(`===================================================================`);
  console.log(` LIVE STRESS TEST BENCHMARK RESULTS`);
  console.log(`===================================================================`);
  console.log(` Completed Requests:  ${totalCompleted} / ${args.total}`);
  console.log(` Total Time Elapsed:  ${totalDurationSec.toFixed(2)}s`);
  console.log(` Throughput:          \x1b[32m${throughputReqSec.toFixed(1)} req/sec\x1b[0m`);
  console.log(` Overall Success Rate:\x1b[32m${successRate.toFixed(2)}%\x1b[0m`);
  console.log(` Status Codes:        2xx: ${count2xx} | 4xx: ${count4xx} | 5xx: ${count5xx} | NetErr: ${countNetErrors}`);
  console.log(` Cron Lock Skips:     ${cleanCronSkips} (Clean non-blocking lock exits)`);
  console.log(`-------------------------------------------------------------------`);
  console.log(` Latency Distribution:`);
  console.log(`   Min:  ${minLatency.toFixed(2)} ms`);
  console.log(`   Avg:  ${avgLatency.toFixed(2)} ms`);
  console.log(`   p50:  ${p50.toFixed(2)} ms`);
  console.log(`   p90:  ${p90.toFixed(2)} ms`);
  console.log(`   p95:  ${p95.toFixed(2)} ms`);
  console.log(`   p99:  ${p99.toFixed(2)} ms`);
  console.log(`   Max:  ${maxLatency.toFixed(2)} ms`);
  console.log(`-------------------------------------------------------------------`);
  console.log(` Workload Profile Breakdown:`);
  console.log(` Category             | Count | Success % | Avg Latency | p95 Latency `);
  console.log(` ---------------------|-------|-----------|-------------|------------ `);
  for (const c of categoryStats) {
    const name = c.category.padEnd(20);
    const count = String(c.count).padStart(5);
    const succ = `${c.successRate.toFixed(1)}%`.padStart(9);
    const avg = `${c.avgMs.toFixed(1)} ms`.padStart(11);
    const p95Str = `${c.p95Ms.toFixed(1)} ms`.padStart(11);
    console.log(` ${name} | ${count} | ${succ} | ${avg} | ${p95Str} `);
  }
  console.log(`===================================================================\n`);

  if (count5xx > 0 || countNetErrors > 0) {
    console.warn(`\x1b[33m[WARNING] Encountered ${count5xx} 5xx server errors and ${countNetErrors} network failures.\x1b[0m`);
  } else {
    console.log(`\x1b[32m[SUCCESS] Zero 5xx server errors and zero dropped requests under live load.\x1b[0m\n`);
  }
}

if (process.argv[1]?.endsWith('stress-test.ts')) {
  main().catch((err) => {
    console.error('[StressTest] Unhandled fatal error:', err);
    process.exit(1);
  });
}
