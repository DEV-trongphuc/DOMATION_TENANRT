/**
 * Cross-Module Multi-Tenant Event Bus
 * Powers real-time synchronization between Master Contact (`leads`),
 * Dynamic Segments ("Tệp Logic"), Marketing Automation Flows, Fair-Share Sale Routing, and ERP Revenue.
 */

export type DomainEventType =
  | 'lead.created'
  | 'lead.updated'
  | 'lead.stage_changed'
  | 'marketing.engaged'
  | 'audience.entered'
  | 'audience.exited'
  | 'deal.won';

export interface DomainEventPayloads {
  'lead.created': {
    tenantId: string;
    leadId: string;
    status: string;
    lifecycleStage?: string;
    source?: string;
    actorId?: string | null;
  };
  'lead.updated': {
    tenantId: string;
    leadId: string;
    changedFields?: string[];
    actorId?: string | null;
  };
  'lead.stage_changed': {
    tenantId: string;
    leadId: string;
    pipelineId?: string | null;
    previousStageId?: string | null;
    currentStageId: string;
    currentStageKey?: string;
    isWonStage?: boolean;
    willEmitDealWon?: boolean;
    dealValueVnd?: number | null;
    actorId?: string | null;
  };
  'marketing.engaged': {
    tenantId: string;
    leadId: string;
    engagementType: string;
    channel?: 'email' | 'zns' | 'sms' | 'web' | 'form' | 'survey' | 'voucher' | 'social';
    scoreDelta?: number;
    metadata?: Record<string, unknown>;
  };
  'audience.entered': {
    tenantId: string;
    audienceId: string;
    audienceName: string;
    audienceType: string;
    leadId: string;
    pushedToSaleRound?: boolean;
  };
  'audience.exited': {
    tenantId: string;
    audienceId: string;
    audienceName: string;
    audienceType: string;
    leadId: string;
  };
  'deal.won': {
    tenantId: string;
    leadId: string;
    dealId?: string | null;
    amountVnd: number;
    sourceEntity?: 'lead_stage' | 'deal' | 'sales_order' | 'deposit' | 'invoice';
    actorId?: string | null;
  };
}

export interface DomainEventEnvelope<K extends DomainEventType = DomainEventType> {
  id: string;
  type: K;
  tenantId: string;
  timestamp: string;
  payload: DomainEventPayloads[K];
}

export type DomainEventHandler<K extends DomainEventType> = (
  event: DomainEventEnvelope<K>
) => Promise<void> | void;

class CrossModuleEventBus {
  private listeners = new Map<DomainEventType, Set<DomainEventHandler<any>>>();
  private tenantRecentLogs = new Map<string, DomainEventEnvelope[]>();
  private inFlight = new Set<Promise<void>>();
  private readonly maxRecentPerTenant = 100;

  on<K extends DomainEventType>(type: K, handler: DomainEventHandler<K>): () => void {
    let set = this.listeners.get(type);
    if (!set) {
      set = new Set();
      this.listeners.set(type, set);
    }
    set.add(handler);
    return () => {
      set?.delete(handler);
    };
  }

  async emit<K extends DomainEventType>(
    type: K,
    payload: DomainEventPayloads[K]
  ): Promise<DomainEventEnvelope<K>> {
    if (!payload?.tenantId) {
      throw new Error(`EVENT_BUS_TENANT_REQUIRED: Event '${type}' emitted without tenantId`);
    }

    const envelope: DomainEventEnvelope<K> = {
      id: `evt-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`,
      type,
      tenantId: payload.tenantId,
      timestamp: new Date().toISOString(),
      payload,
    };

    // Append to strictly tenant-isolated ring buffer
    let ring = this.tenantRecentLogs.get(payload.tenantId);
    if (!ring) {
      ring = [];
      this.tenantRecentLogs.set(payload.tenantId, ring);
    }
    ring.unshift(envelope);
    if (ring.length > this.maxRecentPerTenant) {
      ring.length = this.maxRecentPerTenant;
    }

    const handlers = this.listeners.get(type);
    if (!handlers || handlers.size === 0) {
      return envelope;
    }

    const execPromise = (async () => {
      for (const fn of Array.from(handlers)) {
        try {
          await fn(envelope);
        } catch (err: any) {
          if (process.env.DEBUG_API === '1') {
            console.warn(`[EventBus] Subscriber error on '${type}' (tenant ${payload.tenantId}):`, err?.message || err);
          }
        }
      }
    })();

    this.inFlight.add(execPromise);
    try {
      await execPromise;
    } finally {
      this.inFlight.delete(execPromise);
    }

    return envelope;
  }

  emitDetached<K extends DomainEventType>(type: K, payload: DomainEventPayloads[K]): void {
    void this.emit(type, payload).catch(() => {});
  }

  async flush(): Promise<void> {
    while (this.inFlight.size > 0) {
      await Promise.allSettled(Array.from(this.inFlight));
    }
  }

  getRecentTenantEvents(tenantId: string, limit = 25): DomainEventEnvelope[] {
    const ring = this.tenantRecentLogs.get(tenantId) || [];
    return ring.slice(0, Math.max(1, Math.min(100, limit)));
  }
}

export const domainEventBus = new CrossModuleEventBus();

export const onDomainEvent = domainEventBus.on.bind(domainEventBus);
export const emitDomainEvent = domainEventBus.emit.bind(domainEventBus);
export const emitDomainEventDetached = domainEventBus.emitDetached.bind(domainEventBus);
export const flushDomainEvents = domainEventBus.flush.bind(domainEventBus);
