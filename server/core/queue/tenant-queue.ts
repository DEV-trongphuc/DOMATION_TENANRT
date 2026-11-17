import { APP_CONFIG } from '../../config.ts';
import { tenantStorage, type TenantContext } from '../context/tenant-context.ts';

export type QueueChannel =
  | 'inbound-leads'
  | 'webhook-dispatch'
  | 'mail-queue'
  | 'capi-dispatch'
  | (string & {});

export interface TenantJob<TPayload = any> {
  id: string;
  tenantId: string;
  channel: QueueChannel;
  payload: TPayload;
  attempts: number;
  maxAttempts: number;
  createdAt: number;
}

type JobHandler<TPayload = any> = (job: TenantJob<TPayload>) => Promise<void>;

interface QueuedJobEntry {
  job: TenantJob;
  baseDelayMs: number;
  ctx?: TenantContext;
  doneResolve: () => void;
  donePromise: Promise<void>;
}

/**
 * Tenant-Partitioned Background Queue Manager (`{tenant_id}:{channel}`).
 * Prevents noisy-neighbor starvation by Fair-Share Round-Robin draining across per-tenant FIFO queues,
 * enforces both global and per-tenant concurrency caps, supports exponential backoff retries,
 * and preserves TenantContext across async workers.
 */
class TenantQueueEngine {
  private handlers = new Map<QueueChannel, JobHandler>();
  private tenantQueues = new Map<string, QueuedJobEntry[]>();
  private activeTenants: string[] = [];
  private rrCursor = 0;
  private activeGlobal = 0;
  private activeByTenant = new Map<string, number>();
  private pendingJobs = new Set<Promise<void>>();
  private maxGlobalConcurrency = APP_CONFIG.queueConcurrency;
  private maxPerTenantConcurrency = APP_CONFIG.queuePerTenantConcurrency;

  registerWorker<TPayload = any>(channel: QueueChannel, handler: JobHandler<TPayload>): void {
    this.handlers.set(channel, handler);
  }

  configureLimits(options?: { maxGlobalConcurrency?: number; maxPerTenantConcurrency?: number }): void {
    this.maxGlobalConcurrency = Math.max(1, options?.maxGlobalConcurrency ?? APP_CONFIG.queueConcurrency);
    this.maxPerTenantConcurrency = Math.max(1, options?.maxPerTenantConcurrency ?? APP_CONFIG.queuePerTenantConcurrency);
    this.pump();
  }

  getStats(): {
    activeGlobal: number;
    queuedTenants: number;
    totalPending: number;
    maxGlobalConcurrency: number;
    maxPerTenantConcurrency: number;
  } {
    return {
      activeGlobal: this.activeGlobal,
      queuedTenants: this.activeTenants.length,
      totalPending: this.pendingJobs.size,
      maxGlobalConcurrency: this.maxGlobalConcurrency,
      maxPerTenantConcurrency: this.maxPerTenantConcurrency,
    };
  }

  enqueue<TPayload = any>(
    tenantId: string,
    channel: QueueChannel,
    payload: TPayload,
    options?: { maxAttempts?: number; retryDelayBaseMs?: number; ctx?: TenantContext }
  ): string {
    const effectiveTenantKey = tenantId || '__unscoped__';
    const job: TenantJob<TPayload> = {
      id: `job-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      tenantId,
      channel,
      payload,
      attempts: 0,
      maxAttempts: options?.maxAttempts ?? 5,
      createdAt: Date.now(),
    };

    let doneResolve!: () => void;
    const donePromise = new Promise<void>((resolve) => {
      doneResolve = resolve;
    });

    const entry: QueuedJobEntry = {
      job,
      baseDelayMs: options?.retryDelayBaseMs ?? 15,
      ctx: options?.ctx,
      doneResolve,
      donePromise,
    };

    this.pendingJobs.add(donePromise);

    let queue = this.tenantQueues.get(effectiveTenantKey);
    if (!queue) {
      queue = [];
      this.tenantQueues.set(effectiveTenantKey, queue);
      this.activeTenants.push(effectiveTenantKey);
    }
    queue.push(entry);

    this.pump();
    return job.id;
  }

  private pump(): void {
    while (this.activeGlobal < this.maxGlobalConcurrency && this.activeTenants.length > 0) {
      const ringLen = this.activeTenants.length;
      let pickedIdx = -1;

      for (let offset = 0; offset < ringLen; offset++) {
        const candidateIdx = (this.rrCursor + offset) % ringLen;
        const tid = this.activeTenants[candidateIdx];
        const queue = this.tenantQueues.get(tid);
        if (!queue || queue.length === 0) continue;

        const runningForTenant = this.activeByTenant.get(tid) || 0;
        if (runningForTenant < this.maxPerTenantConcurrency) {
          pickedIdx = candidateIdx;
          break;
        }
      }

      if (pickedIdx === -1) {
        // Every remaining queued tenant is currently at its per-tenant concurrency cap
        break;
      }

      const tenantKey = this.activeTenants[pickedIdx];
      const queue = this.tenantQueues.get(tenantKey)!;
      const nextEntry = queue.shift()!;

      if (queue.length === 0) {
        this.tenantQueues.delete(tenantKey);
        this.activeTenants.splice(pickedIdx, 1);
        if (this.activeTenants.length === 0) {
          this.rrCursor = 0;
        } else {
          this.rrCursor = pickedIdx % this.activeTenants.length;
        }
      } else {
        this.rrCursor = (pickedIdx + 1) % this.activeTenants.length;
      }

      this.activeGlobal += 1;
      this.activeByTenant.set(tenantKey, (this.activeByTenant.get(tenantKey) || 0) + 1);

      void this.executeWithRetry(nextEntry.job, nextEntry.baseDelayMs, nextEntry.ctx).finally(() => {
        this.activeGlobal = Math.max(0, this.activeGlobal - 1);
        const remainingActive = (this.activeByTenant.get(tenantKey) || 1) - 1;
        if (remainingActive <= 0) {
          this.activeByTenant.delete(tenantKey);
        } else {
          this.activeByTenant.set(tenantKey, remainingActive);
        }
        this.pendingJobs.delete(nextEntry.donePromise);
        nextEntry.doneResolve();
        this.pump();
      });
    }
  }

  private async executeWithRetry(job: TenantJob, baseDelayMs: number, explicitCtx?: TenantContext): Promise<void> {
    const handler = this.handlers.get(job.channel);
    if (!handler) return;

    const runOnce = async () => {
      if (explicitCtx) {
        await tenantStorage.run(explicitCtx, () => handler(job));
      } else {
        await handler(job);
      }
    };

    while (job.attempts < job.maxAttempts) {
      job.attempts += 1;
      try {
        await runOnce();
        return;
      } catch {
        if (job.attempts >= job.maxAttempts) {
          // Final failure handled by caller/handler DLQ hook if needed
          return;
        }
        const waitMs = Math.min(2000, Math.pow(2, job.attempts - 1) * baseDelayMs);
        await new Promise((r) => setTimeout(r, waitMs));
      }
    }
  }

  async flushAll(): Promise<void> {
    while (this.pendingJobs.size > 0) {
      await Promise.allSettled(Array.from(this.pendingJobs));
    }
  }
}

export const tenantQueue = new TenantQueueEngine();
