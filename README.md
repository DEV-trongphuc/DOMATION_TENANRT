# Auto Data Multi-Tenant (SaaS) Platform
## Enterprise Lead Distribution, CRM Pipeline & Omnichannel Conversion Engine

[![Architecture](https://img.shields.io/badge/Architecture-Multi--Tenant%20Pool%20Model-1E40FF.svg)](#multi-tenancy-architecture)
[![Security](https://img.shields.io/badge/Security-PostgreSQL%20Kernel%20RLS-10B981.svg)](#zero-leakage-security)
[![Frontend](https://img.shields.io/badge/Frontend-React%2019%20%7C%20TailwindCSS-0EA5E9.svg)](#light-theme-design-system)
[![Backend](https://img.shields.io/badge/Backend-Node.js%20%7C%20PostgreSQL%2015%2B%20%7C%20Redis-6366F1.svg)](#backend-stack)
[![CAPI](https://img.shields.io/badge/Meta%20CAPI-v21.0%20Compliant-1877F2.svg)](#meta-conversions-api)
[![Zalo](https://img.shields.io/badge/Zalo%20Bot-Official%20Account%20v4-0068FF.svg)](#zalo-bot-engine)

---

## 1. Executive Summary & System Vision

The **Auto Data Multi-Tenant (SaaS) Platform** is an enterprise-grade cloud system engineered to empower any business—from real estate agencies, automotive dealerships, retail chains, medical clinics, to high-velocity B2B services—to self-register and operate an independent, highly customized lead distribution and sales conversion infrastructure.

Transforming battle-tested distribution algorithms from monolithic single-tenant deployments (`DATA-ECOLIFE`) and inheriting the modern, elegant light-theme design system of `MY_PORTFOLIO`, the platform delivers sub-4-second lead distribution, bi-directional Meta Conversions API (CAPI v21.0) synchronization, automated Zalo Bot notifications, and an event-sourced interaction timeline—all protected by PostgreSQL native Row-Level Security (`FORCE ROW LEVEL SECURITY`) with mathematical zero-leakage isolation.

---

## 2. Core Capabilities

| Capability | Technical Realization | Business Value |
| :--- | :--- | :--- |
| **Mathematical Zero-Leakage Multi-Tenancy** | PostgreSQL native RLS (`FORCE ROW LEVEL SECURITY`) + `AsyncLocalStorage` context propagation + Redis tenant namespacing. | Guaranteed enterprise data isolation across thousands of organizations within a shared compute cluster. |
| **4-Tier Granular RBAC Matrix** | Platform Super Admins segregated in `platform_superadmins`; Tenant Admin (Enterprise), Manager (Team/Round), Sale / Đại lý (Frontline operator). | Complete segregation of duties, field-level PII masking for external agencies, and comprehensive audit logs. |
| **Dual-Dimension Sale Toggle Engine** | Administrative status (`active`/`inactive`/`terminated`) vs Operational availability (`is_available`, `vacation_mode`). | Graceful lead reallocation, SLA timeout auto-recalls, dynamic weight normalization, and instant token blacklisting. |
| **Dynamic Customization Engine** | Drag-and-drop pipelines, custom stage ordering, color tags, custom fields (`JSONB`), and stage SLA timeouts. | Tailors the CRM experience to any industry (BĐS, Retail, Healthcare, B2B) without requiring code modifications. |
| **Zalo Bot & Email Notification Engine** | Multi-tenant OA tokens stored in AES-256-GCM vault, proactive 2-hour OAuth refresh loop, interactive bot commands. | Real-time lead alerts to sales reps and team groups within 2 seconds of arrival; one-click `/tiepnhan` acceptance. |
| **High-Throughput Webhook Engine** | HMAC-SHA256 signature verification, 24-hour Redis idempotency deduplication, 5x exponential retry with DLQ. | Reliable ingestion from Ladipage, Facebook Lead Ads, Google Sheets, or custom ERP systems with zero lead loss. |
| **Meta Conversions API (CAPI v21.0)** | Automated stage triggers, SHA-256 PII hashing (E.164 phone, email, names), browser/server deduplication (`event_id`). | Feeds verified sales milestones (`Qualified`, `Schedule`, `Purchase`, `DisqualifiedLead`) back to Meta AI algorithms to cut ad CAC by 30-45%. |
| **Event-Sourced Interaction Timeline** | Append-only `lead_timeline_events`, chronological pagination, role-based field masking, structured notes. | Complete chronological audit trail of all calls, appointments, status changes, and disputes without text string mangling. |
| **Fair-Share Round-Robin Distribution** | Weighted round-robin with compensation quotas from approved error tickets, 90-day duplicate reminder detection. | Eliminates sales team conflict through transparent, algorithmic lead sharing and automated quota adjustments. |
| **Light-Theme UI & Onboarding Tour** | `#F8F9FA` canvas, Royal Sapphire `#1E40FF`, Be Vietnam Pro typography, tabular numbers, spotlight step tour. | High-converting B2B SaaS landing page, 4-step registration wizard, and 4 full-modal setup wizards for self-onboarding. |

---

## 3. High-Level Architectural Diagram

```
                              [ INGRESS & TRAFFIC ROUTING ]
                                            │
                        ┌───────────────────┴───────────────────┐
                        ▼                                       ▼
            Subdomain Routing / Ingress              Custom Domain Gateway
           `{tenant_slug}.autodata.vn`              `crm.doanhnghiep.vn`
                        │                                       │
                        └───────────────────┬───────────────────┘
                                            ▼
                    [ API GATEWAY & SECURITY ENFORCEMENT ]
                        ├─ Rate Limiting (Token Bucket per Tenant)
                        ├─ TLS Termination & CORS Enforcement
                        ├─ JWT Signature Verification & Tenant Claim Extraction
                        └─ Tenant Resolution Middleware (Domain -> Tenant UUID)
                                            │
                                            ▼
                    [ APPLICATION RUNTIME (Node.js / Express) ]
                        ├─ AsyncLocalStorage Execution Context (`TenantContext`)
                        ├─ 4-Tier RBAC & Enterprise Permission Guard
                        │
                        ├───────────────────┬───────────────────┐
                        ▼                   ▼                   ▼
                [ INTAKE & WEBHOOKS ] [ CORE ENGINES ]  [ INTEGRATIONS ]
                ├─ HMAC SHA-256       ├─ Dynamic         ├─ Meta CAPI v21.0
                ├─ 24h Idempotency       Pipelines          (SHA-256 PII)
                ├─ Dynamic Mapper     ├─ Fair-Share      ├─ Zalo Bot OA
                └─ BullMQ Ingest         Round-Robin        (AES-256 Vault)
                   Queue              ├─ Sale Toggles    ├─ Email SES Engine
                                      └─ Event Timeline  └─ Outbound DLQ
                                            │
                                            ▼
                    [ PERSISTENCE & DATA ISOLATION TIER ]
                        │
       ┌────────────────┼───────────────────────────────┬────────────────┐
       ▼                ▼                               ▼                ▼
[ PostgreSQL 15+ ]  [ Redis Layer ]             [ Object Storage ] [ BullMQ Queues ]
├─ Pool Model       ├─ Tenant Namespaced Cache  ├─ S3 / MinIO      ├─ {tenant}:leads
├─ Kernel RLS       │  `tenant:{id}:{key}`      ├─ Isolated Path   ├─ {tenant}:capi
│  `FORCE` Enabled  ├─ Distributed Locks        │  `/{tenant_id}/` ├─ {tenant}:zalo
├─ `set_config()`   │  (`Redlock`)              └─ AES-256 SSE     └─ {tenant}:mail
│  & `DISCARD ALL`  └─ Pub/Sub Bus
└─ Compound FKs & btree_gin
```

---

## 4. Documentation Index & Deliverables Matrix

All technical specifications, architectural blueprints, database schemas, and engineering roadmaps are maintained within the `docs/` repository:

| Specification Document | Addressed Requirements | Description | File Path |
| :--- | :---: | :--- | :--- |
| **Architecture Specification** | **R1** | Pool Model multi-tenancy, mathematical zero-leakage proof, 5-layer Defense-in-Depth, request lifecycle, Redis caching isolation, 4-tier RBAC permission matrix (25 operations), and Sale toggle switch architecture. | [`docs/ARCHITECTURE_SPECIFICATION.md`](docs/ARCHITECTURE_SPECIFICATION.md) |
| **Customization Engine Specification** | **R2** | Dynamic Pipeline Engine, Zalo Bot & Email Hub (AES-256 vault, proactive OAuth refresh with Redlock), Webhook Engine (HMAC SHA-256, 24h dual idempotency, DLQ), Meta CAPI v21.0 integration (NFC Unicode), Event-Sourced Interaction Timeline, and Fair-Share Lead Routing. | [`docs/CUSTOMIZATION_ENGINE_SPEC.md`](docs/CUSTOMIZATION_ENGINE_SPEC.md) |
| **Onboarding & UI/UX Specification** | **R3** | Light-Theme Design System & Tokens (`#F8F9FA`, Royal Sapphire `#1E40FF`, Be Vietnam Pro), 7-section SaaS Landing Page, 4-step Self-Service Onboarding Flow, 6-step Interactive Step Tour, and 4 Full-Modal Setup Wizards. | [`docs/ONBOARDING_UI_UX_SPEC.md`](docs/ONBOARDING_UI_UX_SPEC.md) |
| **Production Database Schema** | **R4** | Production PostgreSQL 15+ DDL containing dedicated `platform_superadmins` table, multi-tenant tables, UUID primary keys, compound foreign keys, native Row-Level Security policies with `FORCE ROW LEVEL SECURITY`, trigger-enforced timeline immutability, and `btree_gin` composite indexes. | [`docs/DATABASE_SCHEMA.sql`](docs/DATABASE_SCHEMA.sql) |
| **Core API Specification** | **R4** | OpenAPI 3.1 specification for all core RESTful API endpoints: Authentication (segregated Platform vs Tenant), Tenants, Personnel & RBAC, Pipelines, Leads (with lifecycle status), Webhooks (dual idempotency), Meta CAPI, Zalo Bot, and Timeline Notes, with comprehensive request/response schemas. | [`docs/API_SPECIFICATION.md`](docs/API_SPECIFICATION.md) |
| **Implementation Roadmap** | **R4** | 5-Phase Engineering Execution Plan: Foundation & Multi-Tenancy Core, Dynamic Ingestion & Distribution, Integrations (Zalo & Meta CAPI), Frontend UI & Onboarding Tour, and Enterprise Hardening & E2E Validation. | [`docs/IMPLEMENTATION_ROADMAP.md`](docs/IMPLEMENTATION_ROADMAP.md) |

---

## 5. Technology Stack & Compatibility

The platform architecture is designed to cleanly inherit and expand upon the core proven patterns from `DATA-ECOLIFE` and the design tokens from `MY_PORTFOLIO`:

| Architectural Layer | Production Standard | Heritage & Alignment |
| :--- | :--- | :--- |
| **Frontend Framework** | React 19.x, TypeScript 5.8+, Vite 6.x | Derived from `DATA-ECOLIFE` & `MY_PORTFOLIO` |
| **Styling & Design Tokens** | Tailwind CSS v4, Lucide React, Framer Motion 12.x | 100% compliant with `MY_PORTFOLIO` Light Theme tokens |
| **Typography & Numbers** | Be Vietnam Pro (Sans/Display), tabular-nums lining | High-precision Vietnamese typography & real-time KPI metrics |
| **Backend Runtime** | Node.js 22 LTS / Express or Fastify with TypeScript | Modernized from `DATA-ECOLIFE` PHP monolithic scripts |
| **Execution Context** | `AsyncLocalStorage` (`node:async_hooks`) | Provides zero-leakage scoped context per asynchronous request |
| **Primary Database** | PostgreSQL 15+ with native Row-Level Security (RLS) & `btree_gin` | Upgraded from MariaDB to guarantee mathematical data isolation |
| **Caching & Message Broker** | Redis 7.2+ (Cluster / Sentinel), BullMQ | High-throughput distributed locks, tenant namespaced caching |
| **Third-Party APIs** | Meta Graph API v21.0 (CAPI), Zalo Bot & OA API v4 | Fully compliant with official upstream API schemas |
| **Object Storage** | AWS S3 / MinIO (Multi-Tenant Bucket/Prefix Isolation) | Server-side encryption (SSE-S3), presigned upload URLs |

---

## 6. Security & Compliance Baseline

1. **Kernel-Level Row Security & Complete Isolation**: Every tenant-scoped table (including `tenants` and `users`) enforces `FORCE ROW LEVEL SECURITY`. Queries executed without an explicit transaction context setting (`SELECT set_config('app.current_tenant_id', $1, true)`) automatically return an empty result set ($\emptyset$), rendering cross-tenant data leaks impossible. Database connection releases immediately execute `DISCARD ALL` to prevent context contamination across pooled clients. Platform Super Admins are segregated in `platform_superadmins` outside tenant scope.
2. **Cryptographic Secret Storage**: All third-party secrets (Zalo OA tokens, Meta Access Tokens, SMTP passwords, Webhook secrets) are encrypted using **AES-256-GCM** with tenant-unique salt derivation and fresh 96-bit CSPRNG IVs on every rotation to eliminate IV reuse hazards.
3. **Auditability & Non-Repudiation**: The interaction timeline (`lead_timeline_events`) is an immutable, append-only log. Modifications and deletions are strictly blocked at the database kernel level by trigger `trigger_immutable_lead_timeline` executing function `trg_prevent_timeline_mutation()`.
4. **Kernel-Enforced Composite Foreign Keys & btree_gin Indexing**: All child tables enforce compound foreign keys `FOREIGN KEY (tenant_id, ...) REFERENCES ... (tenant_id, id)` ensuring that referential integrity cannot cross tenant boundaries. Composite GIN indexes `USING gin (tenant_id, custom_fields)` and `USING gin (tenant_id, metadata)` prevent global unpartitioned index scans at enterprise scale.
5. **PII Masking & Privacy**: Customer phone numbers and emails are masked in API responses for external agency and contractor roles, preserving business confidentiality.

---

## 7. Quick Start & Verification Commands

```bash
# 1. Install dependencies
npm install

# 2. Run Full-Stack Development (Express API on :3100 + Vite React 19 UI on :5174)
npm run dev

# 3. Typecheck both Frontend & Backend TypeScript
npm run typecheck

# 4. Build Production Bundle (served automatically by server/app.ts)
npm run build
npm start

# 5. Run Full Automated Test Suite (PostgreSQL 16 Kernel RLS, 4-Tier RBAC, Fair-Share, Webhooks/CAPI/Zalo, Browser E2E)
npm test
```
