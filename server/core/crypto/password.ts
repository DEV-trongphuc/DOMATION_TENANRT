import os from 'node:os';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { Worker } from 'node:worker_threads';
import bcrypt from 'bcryptjs';
import { APP_CONFIG } from '../../config.ts';

interface PendingTask {
  resolve: (value: any) => void;
  reject: (err: Error) => void;
}

interface QueuedJob {
  id: number;
  op: 'hash' | 'compare';
  plain: string;
  rounds?: number;
  hash?: string;
  resolve: (value: any) => void;
  reject: (err: Error) => void;
}

interface WorkerSlot {
  worker: Worker;
  inFlight: number;
  pending: Map<number, PendingTask>;
}

const POOL_SIZE = Math.min(
  6,
  Math.max(2, (typeof os.availableParallelism === 'function' ? os.availableParallelism() : os.cpus().length) - 1)
);
const MAX_IN_FLIGHT_PER_WORKER = 2;
const IDLE_SWEEP_MS = 15_000;

let nextTaskId = 1;
let workerDataUrl: URL | null = null;
let poolDisabled = false;
let idleTimer: ReturnType<typeof setTimeout> | null = null;
const slots: WorkerSlot[] = [];
const waitQueue: QueuedJob[] = [];

function getWorkerDataUrl(): URL | null {
  if (poolDisabled) return null;
  if (workerDataUrl) return workerDataUrl;
  try {
    const req = createRequire(import.meta.url);
    const bcryptUrl = pathToFileURL(req.resolve('bcryptjs')).href;
    const workerSource = `
import { parentPort } from 'node:worker_threads';
import bcrypt from ${JSON.stringify(bcryptUrl)};

parentPort.on('message', async (msg) => {
  try {
    if (msg.op === 'hash') {
      const result = await bcrypt.hash(msg.plain, msg.rounds);
      parentPort.postMessage({ id: msg.id, ok: true, result });
    } else {
      const result = await bcrypt.compare(msg.plain, msg.hash);
      parentPort.postMessage({ id: msg.id, ok: true, result });
    }
  } catch (err) {
    parentPort.postMessage({ id: msg.id, ok: false, error: err && err.message ? err.message : 'BCRYPT_WORKER_ERROR' });
  }
});
`;
    workerDataUrl = new URL(`data:text/javascript;charset=utf-8,${encodeURIComponent(workerSource)}`);
    return workerDataUrl;
  } catch {
    poolDisabled = true;
    return null;
  }
}

function scheduleIdleSweep(): void {
  if (idleTimer) clearTimeout(idleTimer);
  idleTimer = setTimeout(() => {
    idleTimer = null;
    if (waitQueue.length > 0 || slots.some((s) => s.inFlight > 0)) return;
    while (slots.length > 0) {
      const slot = slots.pop()!;
      void slot.worker.terminate();
    }
  }, IDLE_SWEEP_MS);
  if (typeof idleTimer.unref === 'function') {
    idleTimer.unref();
  }
}

function spawnWorkerSlot(): WorkerSlot | null {
  const url = getWorkerDataUrl();
  if (!url) return null;
  try {
    // Pass empty execArgv so dev/test loaders (e.g. --import tsx) are not cloned into pure-JS bcrypt workers
    const worker = new Worker(url, { execArgv: [] });
    worker.unref();
    const slot: WorkerSlot = {
      worker,
      inFlight: 0,
      pending: new Map(),
    };

    worker.on('message', (msg: { id: number; ok: boolean; result?: any; error?: string }) => {
      const entry = slot.pending.get(msg.id);
      if (entry) {
        slot.pending.delete(msg.id);
        slot.inFlight = Math.max(0, slot.inFlight - 1);
        if (slot.inFlight === 0) {
          worker.unref();
        }
        if (msg.ok) {
          entry.resolve(msg.result);
        } else {
          entry.reject(new Error(msg.error || 'BCRYPT_WORKER_ERROR'));
        }
      }
      pumpQueue();
      if (waitQueue.length === 0 && slots.every((s) => s.inFlight === 0)) {
        scheduleIdleSweep();
      }
    });

    worker.on('error', (err) => {
      for (const [, entry] of slot.pending) {
        entry.reject(err instanceof Error ? err : new Error(String(err)));
      }
      slot.pending.clear();
      slot.inFlight = 0;
      const idx = slots.indexOf(slot);
      if (idx !== -1) slots.splice(idx, 1);
      if (slots.length === 0) {
        poolDisabled = true;
        drainQueueFallback();
      } else {
        pumpQueue();
      }
    });

    slots.push(slot);
    return slot;
  } catch {
    poolDisabled = true;
    return null;
  }
}

function drainQueueFallback(): void {
  while (waitQueue.length > 0) {
    const job = waitQueue.shift()!;
    if (job.op === 'hash') {
      bcrypt.hash(job.plain, job.rounds ?? APP_CONFIG.bcryptRounds).then(job.resolve, job.reject);
    } else {
      bcrypt.compare(job.plain, job.hash || '').then(job.resolve, job.reject);
    }
  }
}

function pumpQueue(): void {
  while (waitQueue.length > 0) {
    if (poolDisabled) {
      drainQueueFallback();
      return;
    }

    let bestSlot: WorkerSlot | null = null;
    for (const s of slots) {
      if (s.inFlight === 0) {
        bestSlot = s;
        break;
      }
    }

    if (!bestSlot && slots.length < POOL_SIZE) {
      bestSlot = spawnWorkerSlot();
      if (!bestSlot && poolDisabled) {
        drainQueueFallback();
        return;
      }
    }

    if (!bestSlot) {
      for (const s of slots) {
        if (s.inFlight < MAX_IN_FLIGHT_PER_WORKER) {
          if (!bestSlot || s.inFlight < bestSlot.inFlight) {
            bestSlot = s;
          }
        }
      }
    }

    if (!bestSlot) break;

    const job = waitQueue.shift()!;
    if (bestSlot.inFlight === 0) {
      bestSlot.worker.ref();
    }
    bestSlot.inFlight += 1;
    bestSlot.pending.set(job.id, { resolve: job.resolve, reject: job.reject });
    bestSlot.worker.postMessage({
      id: job.id,
      op: job.op,
      plain: job.plain,
      rounds: job.rounds,
      hash: job.hash,
    });
  }
}

export async function hashPassword(plain: string, rounds = APP_CONFIG.bcryptRounds): Promise<string> {
  if (poolDisabled) {
    return bcrypt.hash(plain, rounds);
  }
  return new Promise<string>((resolve, reject) => {
    waitQueue.push({
      id: nextTaskId++,
      op: 'hash',
      plain,
      rounds,
      resolve,
      reject,
    });
    pumpQueue();
  });
}

export async function verifyPassword(plain: string, hash: string): Promise<boolean> {
  if (!hash) return false;
  if (poolDisabled) {
    return bcrypt.compare(plain, hash);
  }
  return new Promise<boolean>((resolve, reject) => {
    waitQueue.push({
      id: nextTaskId++,
      op: 'compare',
      plain,
      hash,
      resolve,
      reject,
    });
    pumpQueue();
  });
}
