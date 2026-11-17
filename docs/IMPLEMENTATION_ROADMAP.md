# Auto Data Multi-Tenant (SaaS) Platform
## Engineering Implementation Roadmap & Milestone Verification Plan

**Document ID**: `SPEC-ROADMAP-006`  
**Requirement Mapping**: R4 (Phased Implementation Roadmap & Verification Criteria)  
**Status**: APPROVED / PRODUCTION READY  
**Classification**: Enterprise Technical Execution Plan  

---

## 1. Engineering Roadmap Overview

The execution roadmap translates the architectural specifications into five sequential engineering phases. Each phase is independently testable, contains explicit dependency boundaries, and is governed by strict completion criteria.

```
┌────────────────────────────────────────────────────────────────────────┐
│ PHASE 1: FOUNDATION & MULTI-TENANCY CORE                               │
│ Multi-Tenant Database, RLS Kernel Policies, AsyncLocalStorage, RBAC    │
└──────────────────────────────────┬─────────────────────────────────────┘
                                   │
┌──────────────────────────────────▼─────────────────────────────────────┐
│ PHASE 2: INGESTION, PIPELINES & LEAD DISTRIBUTION ENGINE               │
│ High-Throughput Webhooks, 24h Idempotency, Dynamic Pipelines, Round-Robin│
└──────────────────────────────────┬─────────────────────────────────────┘
                                   │
┌──────────────────────────────────▼─────────────────────────────────────┐
│ PHASE 3: THIRD-PARTY INTEGRATIONS (ZALO BOT & META CAPI v21.0)         │
│ AES-256 Vault, Zalo 2h Refresh, Interactive Commands, CAPI Hashing, DLQ│
└──────────────────────────────────┬─────────────────────────────────────┘
                                   │
┌──────────────────────────────────▼─────────────────────────────────────┐
│ PHASE 4: FRONTEND UI, LANDING PAGE & ONBOARDING WIZARDS                │
│ Light-Theme Tokens, 7-Section Landing, 4-Step Onboarding, 6-Step Tour  │
└──────────────────────────────────┬─────────────────────────────────────┘
                                   │
┌──────────────────────────────────▼─────────────────────────────────────┐
│ PHASE 5: ENTERPRISE HARDENING, E2E VERIFICATION & LAUNCH READINESS     │
│ Zero-Leakage Penetration Test, 10k/min Load Test, Redis/DB HA Failover │
└────────────────────────────────────────────────────────────────────────┘
```

---

## 2. Phase-by-Phase Work Packages & Milestones

### Phase 1: Foundation & Multi-Tenancy Core

- **Objective**: Establish the secure multi-tenant foundation, guaranteeing mathematical zero-leakage across all database, cache, and application layers.
- **Duration**: Weeks 1 - 3
- **Dependencies**: None (Greenfield Core)

#### Work Packages (WP):
1. **WP 1.1 - Database Schema & RLS Kernel Deployment**:
   - Apply `DATABASE_SCHEMA.sql` DDL migrations to PostgreSQL 15+.
   - Verify `FORCE ROW LEVEL SECURITY` on all tenant-scoped tables.
   - Implement custom PostgreSQL connection pool wrapper that enforces `SET LOCAL app.current_tenant_id = $1` per transaction and `DISCARD ALL` on release.
2. **WP 1.2 - Ingress Resolution & Context Propagation**:
   - Build Subdomain and Custom Domain resolver middleware.
   - Implement Node.js `AsyncLocalStorage` (`tenantStorage.run(...)`) to propagate `TenantContext` across asynchronous request threads.
   - Enforce cryptographic JWT signature verification and assert identity between Host domain and JWT tenant claims.
3. **WP 1.3 - Redis Namespacing Interceptor**:
   - Implement automated Redis command proxy prepending `tenant:{tenant_id}:` to all cache keys, distributed locks, and rate limiters.
4. **WP 1.4 - 4-Tier RBAC & Enterprise Permission Guard**:
   - Construct role-based authorization middleware covering Super Admin, Tenant Admin, Manager, and Sale/Đại lý across 25 operations.
   - Implement field-level PII masking for external agency roles.

#### Independent Completion Criteria (Phase 1):
- [ ] Unit tests confirm that queries executed without setting `app.current_tenant_id` return exactly 0 rows from tenant tables.
- [ ] Penetration test: Token issued for Tenant A fails with HTTP 403 when dispatched to Tenant B subdomain.
- [ ] Concurrency test: 500 parallel async requests across 10 distinct tenants maintain 100% context isolation without state bleeding.

---

### Phase 2: Ingestion, Pipelines & Lead Distribution Engine

- **Objective**: Deliver high-velocity lead intake, dynamic pipeline configuration, and fair-share lead distribution under 4 seconds.
- **Duration**: Weeks 4 - 6
- **Dependencies**: Phase 1 Core Complete

#### Work Packages (WP):
1. **WP 2.1 - Inbound Webhook & Idempotency Engine**:
   - Implement endpoint `POST /v1/webhooks/:tenant_slug/:token` with HMAC-SHA256 signature verification.
   - Integrate 24-hour Redis idempotency check (`SET ... NX EX 86400`) returning HTTP 200 on duplicate submissions.
   - Connect dynamic visual field mappers to transform arbitrary JSON payloads into canonical `leads` attributes.
2. **WP 2.2 - Dynamic Pipeline Engine & Custom Fields**:
   - Build metadata CRUD for `tenant_pipelines`, `tenant_pipeline_stages`, and custom fields (`JSONB`).
   - Implement SLA timeout scheduler via Redis Sorted Sets (`sla_queue`) with BullMQ background escalation workers.
3. **WP 2.3 - Fair-Share Lead Distribution & Duplicate Detector**:
   - Implement weighted round-robin distribution with compensatory quotas (`compensation_count` and `skipped_credit`).
   - Implement 90-day duplicate reminder check (`checkCRMInteraction`), routing re-engaging clients directly to their original consultant.
   - Wrap round-robin dispatch in distributed Redis locks (`Redlock`) to eliminate assignment races.
4. **WP 2.4 - Event-Sourced Interaction Timeline**:
   - Implement append-only `lead_timeline_events` storage with reverse-chronological pagination.

#### Independent Completion Criteria (Phase 2):
- [ ] Lead ingestion acknowledges HTTP 202 Accepted in under 50ms.
- [ ] Round-robin test: 100 concurrent incoming leads are distributed across 5 sales according to configured 2:1 ratios with 0 duplicates.
- [ ] Duplicate check: Resubmission of an existing phone within 90 days routes to the assigned consultant without entering round-robin.

---

### Phase 3: Third-Party Integrations (Zalo Bot & Meta CAPI v21.0)

- **Objective**: Connect bi-directional communication channels (Zalo Bot, Email) and automated offline conversion feedback loops (Meta CAPI).
- **Duration**: Weeks 7 - 9
- **Dependencies**: Phase 2 Engines Complete

#### Work Packages (WP):
1. **WP 3.1 - Encrypted Integration Vault (AES-256-GCM)**:
   - Implement PBKDF2 key derivation and AES-256-GCM encryption for all third-party secrets.
2. **WP 3.2 - Zalo Bot Platform & Proactive OAuth Refresh Loop**:
   - Implement 2-hour proactive token refresh cron against `https://oauth.zalo.me/v4/oa/access_token`.
   - Build interactive two-way bot commands (`/chatid`, `/tiepnhan`, `/duyet`, `/tuchoi`, `/baoloi`).
   - Enforce Redis Token Bucket rate limiter (30 requests/second per Bot Token).
3. **WP 3.3 - Meta Conversions API (CAPI v21.0) Engine**:
   - Implement automated pipeline stage triggers mapping CRM transitions to Meta events (`Lead`, `Schedule`, `Purchase`, `DisqualifiedLead`).
   - Implement Vietnamese PII normalization: E.164 phone (`84...`), lowercased email, first/last name splitting, and SHA-256 hashing.
   - Build browser/server deduplication (`event_id`, `fbc`, `fbp`, `meta_lead_id`).
   - Support live debugging via `test_event_code` parameter.
4. **WP 3.4 - Outbound Webhooks & Dead Letter Queue (DLQ)**:
   - Implement event broadcaster with HMAC-SHA256 headers, 5x exponential backoff retries, and persistence to `tenant_webhook_dlq`.

#### Independent Completion Criteria (Phase 3):
- [ ] Zalo Bot token refreshes automatically without dropping scheduled notifications.
- [ ] Interactive `/tiepnhan` command via Zalo marks lead accepted within 1.5 seconds.
- [ ] Test CAPI event dispatched to Meta Graph API v21.0 returns HTTP 200 OK with valid `fbtrace_id`.
- [ ] Unresponsive webhook endpoint moves to DLQ after exactly 5 retry attempts.

---

### Phase 4: Frontend UI, Landing Page & Onboarding Wizards

- **Objective**: Deliver the responsive, light-theme web application, high-converting landing page, and self-service onboarding flows.
- **Duration**: Weeks 10 - 13
- **Dependencies**: Phase 1-3 Backend APIs Complete

#### Work Packages (WP):
1. **WP 4.1 - Design System & Component Library**:
   - Implement Tailwind CSS v4 design tokens (`#F8F9FA`, Royal Sapphire `#1E40FF`, Be Vietnam Pro, tabular numbers).
   - Build core glassmorphic components (`.inkica-glass-card`, `.btn-inkica-primary`, spotlight hovers).
2. **WP 4.2 - SaaS High-Converting Landing Page**:
   - Implement 7 structured sections: Glass Navbar, Hero with Interactive Flow Simulator, Bento Grid, Pricing Matrix, Social Proof Marquee, Testimonials, and Footer.
3. **WP 4.3 - 4-Step Self-Service Onboarding Wizard**:
   - Company profile, debounced slug availability checker, industry preset pipeline generator, demo sandbox data seeder.
4. **WP 4.4 - 6-Step Interactive Tour Guidance**:
   - Spotlight highlighting system with persistent browser & DB progress tracking.
5. **WP 4.5 - Full-Modal Setup Wizards & Sale Portal**:
   - Build Pipeline Builder Modal, Bot & Webhook Hub Modal, Meta CAPI Hub Modal, and Sale Management Modal.
   - Deliver Sale Portal featuring dual-dimension toggle switches and Interaction Timeline drawer.

#### Independent Completion Criteria (Phase 4):
- [ ] User completes registration, selects industry preset, and enters active dashboard with 5 demo leads in under 90 seconds.
- [ ] Interactive Step Tour remembers completed steps after page reload or browser restart.
- [ ] Mobile/desktop responsive layout conforms 100% with `MY_PORTFOLIO` light-theme specifications.

---

### Phase 5: Enterprise Hardening, E2E Verification & Launch Readiness

- **Objective**: Validate platform security, stress-test high concurrency, verify disaster recovery, and ensure zero-defect production deployment.
- **Duration**: Weeks 14 - 16
- **Dependencies**: All Previous Phases Complete

#### Work Packages (WP):
1. **WP 5.1 - Zero-Leakage Forensic Penetration Audit**:
   - Independent security assessment verifying that SQL injection or manipulated headers cannot leak cross-tenant records.
2. **WP 5.2 - High-Throughput Concurrency & Load Stress Test**:
   - Simulate 10,000 inbound webhook requests/minute during major flash marketing campaigns.
   - Validate lead distribution latency remains under 4,000ms at 99th percentile (p99).
3. **WP 5.3 - High Availability & Disaster Recovery Validation**:
   - Test automated failover of PostgreSQL replica and Redis Sentinel cluster.
   - Validate point-in-time recovery (PITR) and per-tenant logical data export/purge.
4. **WP 5.4 - Telemetry & Production Monitoring**:
   - Setup Prometheus/Grafana dashboards tracking distribution latency, CAPI HTTP 200 rates, Zalo queue backlog, and DLQ counts.

#### Independent Completion Criteria (Phase 5):
- [ ] Zero cross-tenant data leaks detected under 1,000 automated penetration test scenarios.
- [ ] Ingest queue successfully buffers 10,000 requests/minute without HTTP 500 dropouts.
- [ ] Disaster recovery: Tenant database restored to exact second with zero corrupted transactions.

---

## 3. Engineering Dependency Graph & Risk Mitigation Matrix

### 3.1 Dependency Graph

```
[ WP 1.1: Database DDL & RLS ] ──────────────▶ [ WP 2.1: Inbound Webhooks ]
       │                                               │
       ▼                                               ▼
[ WP 1.2: Context Middleware ] ──────────────▶ [ WP 2.2: Dynamic Pipelines ]
       │                                               │
       ▼                                               ▼
[ WP 1.4: RBAC & Permissions ] ──────────────▶ [ WP 2.3: Fair-Share Distribution ]
                                                       │
                                                       ▼
                                              [ WP 3.2: Zalo Bot ] ──┐
                                              [ WP 3.3: Meta CAPI ] ─┼──▶ [ WP 4.5: Setup Modals ]
                                              [ WP 2.4: Timeline ] ──┘          │
                                                                                ▼
                                                                     [ WP 5.1 - 5.4: Hardening ]
```

---

### 3.2 Risk Mitigation Matrix

| Risk Factor | Probability | Impact | Mitigation Strategy |
| :--- | :---: | :---: | :--- |
| **Cross-Tenant Data Leakage** | Low | Critical | `FORCE ROW LEVEL SECURITY` enforced at kernel level; unit tests assert empty set when context is missing. |
| **Meta Graph API Breaking Changes** | Medium | High | System targets version-pinned Graph API `v21.0`; schema validation rejects deprecated match keys. |
| **Zalo OA Token Expiry Outage** | Medium | High | Proactive refresh worker triggers 4 hours prior to token expiration; failover alerts sent to admin. |
| **Marketing Inbound Webhook Spike** | High | Medium | Decoupled ingest: HTTP endpoint acknowledges `202 Accepted` to Redis buffer in <50ms; BullMQ throttles DB writes. |
| **Sale Team Lead Distribution Disputes** | Medium | Medium | Complete event-sourced audit logs in `lead_timeline_events` and transparent round-robin metrics in Sale Portal. |
