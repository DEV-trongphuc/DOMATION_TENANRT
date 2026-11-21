# Marketing Automation — Comprehensive System Audit & 9-Domain Partial Migration Plan

**Document ID:** `SPEC-MKT-AUDIT-MIG-001`  
**Version:** `2.0.0` (Wave 2C Final Verification Complete — `2026-11-21`)  
**Target Repositories:**
- **Backend Kernel & Master Cron:** `d:\GITHUB_SPACE\AUTO_DATA_TENANRT` (Express + TypeScript, port `:3100`)
- **Unified Portal & Dual-Mode Frontend:** `d:\GITHUB_SPACE\DOMATION_ERP_FULL` (React 19 + Vite 8 + Tailwind v4 `.mkt-scope`, port `:5174`)
- **Design System & Tour Reference:** `d:\GITHUB_SPACE\DOMATION_LANDINGPAGE` (Royal Sapphire Light Theme + Spotlight Tour reference, port `:5173`)

---

## 1. Executive Summary & Live Milestone Status

### 1.1 Unified Architecture Overview

The DOMATION Marketing Automation platform is consolidated into a **single multi-tenant backend kernel + shared database** (`AUTO_DATA_TENANRT`) paired with a **single dual-mode frontend application** (`DOMATION_ERP_FULL`), replacing fragmented standalone PHP/MySQL/HTML deployments (`DOMATION_FULLSTACK`, `DOMATION_FULLDEMO`, `MYERP/backend/automation`, `DOMATION_META`, `DOM-MARKETING`).

1. **Backend Kernel (`d:\GITHUB_SPACE\AUTO_DATA_TENANRT`, port `:3100`)**:
   - Serves Marketing Automation (`/api/v1/marketing/*`), Audiences & Dynamic Segments (`/api/v1/audiences/*`), Public Tracking/Forms/Surveys/Vouchers/Social Inbound (`/api/v1/public/marketing/*`), Legacy/ERP Compatibility Bridge (`/api/v1/myerp/automation/*` via `myerp-compat/marketing-config.ts` & `marketing-php-bridges.ts`), Meta CAPI (`/api/v1/capi/*`), Realtime Ads/CRM Attribution (`/api/v1/dom-meta/*`), 1-Click SaaS Billing & Package Switch (`/api/v1/billing/switch-package`), and Consolidated Master Cron (`/api/v1/operations/cron/master`).
   - Runs identically against **PostgreSQL 16** (production), **PGlite** (embedded/in-memory testing), and **MariaDB 10.6+** (via `sql-translator.ts` and synchronized DDL).
2. **Unified Dual-Mode Frontend (`d:\GITHUB_SPACE\DOMATION_ERP_FULL`, port `:5174`)**:
   - Hosts CRM Auto (`/data`, `/rounds`, `/pipelines`), Realtime Report (`DomMetaReportPage.tsx`), Meta CAPI (`CapiPage.tsx`), ERP modules, and all **13 Marketing Automation pages** (`src/pages/marketing/*`) + shared components (`src/components/marketing/*`).
   - Operates in **Dual Mode** controlled by `TenantConfigContext.tsx` (`isMarketingStandalone = packageCode === 'marketing_standalone'`):
     - **Standalone Mode (`marketing_standalone`)**: Marketing-only workspace (`/` renders `MarketingDashboardPage`, `Sidebar.tsx` focuses on Marketing + Settings/Account/AI Training, `App.tsx` enforces `isAllowedInMarketingStandalone`, and `Settings.tsx` hosts the instant Upgrade banner).
     - **Portal-Embedded Mode (`growth_combo` / `domation_promax`)**: Full coexistence alongside CRM Auto, Realtime Report, CAPI, and ERP modules over the **exact same database and `leads` master contact table**.
3. **Design System Reference (`d:\GITHUB_SPACE\DOMATION_LANDINGPAGE`, port `:5173`)**:
   - Defines canonical Light-Theme **Royal Sapphire (`#1E40FF`) + Red Accent (`#DC2626` / `#EF4444`)**, `Be Vietnam Pro` typography, `Fira Code` monospace, `tabular-nums`, ambient landing-page loading screen (`fluent-brand-ambient-bg.{webp,jpg}` + SVG silk waves), light white sidebar/header chrome, unified date filter, and interactive SVG Spotlight Focus Tours (`DomMetaSpotlightTour`, `ErpSpotlightTour`).

---

### 1.2 Live Milestone Status Matrix

> **Reporting Integrity Note:** As of Wave 2C verification (`2026-11-21`), milestones **M1**, **M2**, **M3.1**, **M3.2–M3.4**, **M4**, and **M5 (Local Automated & Visual Acceptance)** are verified **DONE** across `AUTO_DATA_TENANRT` and `DOMATION_ERP_FULL`. Production runtime cutover steps (target PG16/MariaDB migration, live vault validation, `OUTBOUND_SILENT_MODE=false`, and live cron scheduling in Section 4.3) remain deployment-time ops gates.

| Milestone / Track | Status | Verified Metrics & Evidence | Remaining / Active Scope |
|---|---|---|---|
| **M1: Backend Core, DB Schema, Flow Engine & Tracking** | **DONE** *(Gate PASS)* | `npm run typecheck` exit `0`; `51/51` core tests pass across 7 suites (`m1-marketing-core.test.ts` + 6 suites); Forensic Auditor `CLEAN`, 2 Reviewers `APPROVE`, 2 Challengers `APPROVE`. | Complete. |
| **M2: Channel Adapters, Cross-App Triggers, Compat & Hygiene** | **DONE** *(Wave 2B PASS)* | `npm run typecheck` exit `0`; `npm test` **`328 pass / 0 fail`** across all root unit/integration suites (incl. `m2-channels-capi-compat.test.ts`, `rls-zero-leakage.test.ts`, `dom-meta-report.test.ts`, `waveA-mariadb-and-cron.test.ts`, `master-cron-lock.test.ts`). | Complete (mutating compat RBAC, `zns_consent` phone normalization, multi-page Messenger, `+84` `estimate-reach`, `match-domation-sync`, and `web-tracking` `lead_id` enrichment verified). |
| **M3.1: Design Tokens, Shell, Dual-Mode & Settings Upgrade** | **DONE** *(Gate PASS)* | White/light `Sidebar.tsx` (with standalone `MARKETING AUTOMATION` workspace pill & zero bottom Upgrade box), Royal Sapphire `#1E40FF` + Brand Red `#DC2626` palette (incl. Quick Navigation modal), `Be Vietnam Pro` + `tabular-nums`, `DomationProgressLoader` (`fluent-brand-ambient-bg`), Settings Upgrade (`Settings.tsx` + `PackageUpgradePanel.tsx`), `isAllowedInMarketingStandalone` (`App.tsx`), proxy-safe `config.ts`. | Complete. |
| **M3.2–M3.4: Marketing UI, Email/ZNS Modals & Focus Tours** | **DONE** *(Wave 2A + 2C PASS)* | `DOMATION_ERP_FULL`: `npx tsc -p tsconfig.app.json --noEmit` exit `0`; `npm test` **`25/25 pass / 0 fail`** (empty `LEGACY_TOKEN_SWEEP_ALLOWLIST`, zero purple/violet/fuchsia/indigo tokens across all marketing files); `npx vite build` exit `0` (`2.05s`). Expanded `StepEditor.tsx` (`'3xl'` Email 2-col flex/grid workspace + `!text-white` header, `'2xl'` ZNS), restored `AutomationFlowsPage` 4-KPI `StatGrid`, synchronous `FlowBuilderTab` centering, `FlowAnalyticsTab` performance hero, `MarketingDashboardPage` standard `AppIcon` strip, `MarketingSpotlightTour.tsx` (8-area SVG `<mask>`), `.dom-meta-scope` `Be Vietnam Pro`, `/capi` `.mkt-scope`, and `useNativeAppBackGuard` `<Navigate>` redirect fix. | Complete. |
| **M4: Docs, Live Screenshot Harness & Visual Parity Audit** | **DONE** *(Wave 2C PASS)* | `node scripts/compare_marketing_ui_screenshots.mjs --mode=all --spawn-backend --spawn-vite --mock-meta --out-dir=docs/screenshots/marketing-ui-comparison`: **`53/53` captured, `0` capture errors**, **`343/344` checks PASS**, **`51/51` `DOMATION_ERP_FULL` captures 100% PASS** (`0` console/page/HTTP5xx/requestFailed errors; `D09-tour-marketing-spotlight` & `D10-tour-erp-spotlight` PASS `5/5`, `B01`–`B06`, `C01`–`C12` + `C02b`, `D01`–`D10`, `E01`–`E08` all PASS). Visual PNG inspection completed (`docs/screenshots/marketing-ui-comparison/summary.md` & `audit-report.json`). | Only `1/344` external baseline check failed: `A03-ref-landing-meta-report` (`DOMATION_LANDINGPAGE` `.dom-meta-scope` still uses `Roboto`; intentionally unedited in Wave 2C because `DOMATION_LANDINGPAGE` is owned by a separate concurrent track). |
| **M5: Full E2E (`133/133`) & Tier 5 Adversarial Acceptance** | **DONE** *(Local Gate PASS)* | Non-browser E2E suites `01`–`09` + `11` (`115/115` in Wave 2B) + browser suites `10-browser-dual-mode-ui.e2e.test.ts` (**`11/11` PASS**) + `12-tier4-scenarios.e2e.test.ts` (**`7/7` PASS**) = **`133/133` E2E PASS (`0` fail)**; Tier 5 adversarial white-box suite **`7/7` PASS** (Wave 2B). | Ready for production DB cutover & `OUTBOUND_SILENT_MODE=false` rollout (Section 4.3). |

---

## 2. Comprehensive System Audit Findings & Remediations

### 2.1 Database Architecture, Dual-Engine Parity, RLS & 1-Click Package Upgrade

#### A. Complete Inventory of the 32 `mkt_*` Tables (`server/modules/marketing/schema.ts:4-37`)

All 32 canonical marketing tables (`MARKETING_TABLES`) are created idempotently via `ensureMarketingSchema()` (`server/modules/marketing/schema.ts`) and synchronized across `docs/DATABASE_SCHEMA.sql` (PostgreSQL 15/16) and `docs/DATABASE_SCHEMA_MARIADB.sql` (MariaDB 10.6+ InnoDB `utf8mb4`).

| Domain Group | Count | Canonical `mkt_*` Tables | Key Constraints, Composite FKs & Notes |
|---|---:|---|---|
| **Templates & Media** | 4 | `mkt_template_groups`, `mkt_email_templates`, `mkt_template_acl`, `mkt_media_assets` | `uk_mkt_*_tenant_id (tenant_id, id)`; `ALTER` parity columns `saved_blocks_json`, `thumbnail_url` synced into PG & MariaDB DDL. |
| **Forms, Events & OTP** | 4 | `mkt_forms`, `mkt_form_submissions`, `mkt_custom_events`, `mkt_otp_verifications` | `mkt_forms.public_token UNIQUE`; `routing_mode CHECK ('marketing_nurture', 'sale_round')`; `mkt_otp_verifications.consumed_at` atomic single-use lock with `recipient` + `channel` + `expires_at` enforcement. |
| **Surveys & Quiz** | 2 | `mkt_surveys`, `mkt_survey_responses` | `mkt_surveys.slug` unique per tenant; `blocks_json`, `redirect_rules_json`, `thank_you_json`; `mkt_survey_responses.quiz_score`, `nps_score`, `tags_applied`. |
| **Campaigns & Suppression** | 4 | `mkt_campaigns`, `mkt_send_claims`, `mkt_suppression_list`, `mkt_campaign_reminders` | `uk_mkt_send_claim_unique (tenant_id, campaign_id, lead_id, channel)`; `uk_mkt_suppression_unique (tenant_id, channel, recipient)`; `mkt_campaign_reminders.dispatched_count`. |
| **Automation Flows** | 3 | `mkt_flows`, `mkt_flow_snapshots`, `mkt_flow_enrollments` | `snapshot_version`, `current_step_id`, `status`, `next_run_at`, `execution_trace`; active flow `PUT` bumps version and inserts new `mkt_flow_snapshots` row. |
| **Vouchers & Shortlinks** | 4 | `mkt_voucher_campaigns`, `mkt_voucher_codes`, `mkt_short_links`, `mkt_short_link_clicks` | `mkt_short_links.short_code UNIQUE`; `click_count`, `unique_click_count`; `mkt_short_link_clicks.utm_json.visitor_hash` deduplication; `qr_design_json`. |
| **Web Tracking & Heatmaps** | 4 | `mkt_web_properties`, `mkt_web_sessions`, `mkt_web_events`, `mkt_web_heatmaps` | `mkt_web_properties.site_key UNIQUE`; `uk_mkt_web_visitor_prop (tenant_id, property_id, visitor_token)`; `pricing_intent_detected`, `lead_id` stitch. |
| **Social, Zalo & AI Bot** | 7 | `mkt_ai_bot_configs`, `mkt_social_conversations`, `mkt_social_messages`, `mkt_zalo_oa_configs`, `mkt_zalo_templates`, `mkt_automation_scenarios`, `mkt_ai_training_docs` | `uk_mkt_social_conv_ext (tenant_id, channel, external_thread_id)`; `mkt_zalo_oa_configs` unique per tenant; `mkt_ai_training_docs` backs live chatbot RAG retrieval. |

#### B. Core Shared CRM, Audience, Tag, CAPI, Outbox & Cron Tables

Marketing Automation shares core relational entities in `docs/DATABASE_SCHEMA.sql` / `docs/DATABASE_SCHEMA_MARIADB.sql` with CRM Auto, Realtime Report, and ERP modules:
- **Tenants, Billing & Secrets**: `tenants` (`plan_tier` CHECK includes `'autodata_crm'`, `'marketing_standalone'`, `'growth_combo'`, `'domation_promax'`), `tenant_billing_transactions` (4 extension columns synced in `migrate.ts` `mariaExtensionDdl`), `tenant_integrations` (AES-256-GCM encrypted vault for SMTP/SES/Resend/AppsScript, Zalo OA/ZNS, Meta Messenger, Meta CAPI).
- **Master Contacts & CRM Pipelines**: `leads` (unified contact record for both Marketing `status='marketing_nurture'` and CRM `unassigned_pending`/`assigned`, `lead_score`, `email_consent`, `zns_consent`, `total_revenue_vnd`, `fbclid`, `fbc`, `fbp`, `meta_lead_id`, `custom_fields JSONB`, `is_deleted`), `lead_timeline_events` (append-only activity log), `tenant_pipelines`, `tenant_pipeline_stages`, `tenant_pipeline_custom_fields`, `tenant_custom_fields`, `distribution_rounds`, `round_consultants`, `routing_rules`.
- **Audiences, Segments & Tags**: `tenant_audiences` (`audience_type`: `'static'`/`'dynamic_logic'`/`'list'`, `filter_branches`, `cached_member_count`), `tenant_audience_members`, `tenant_audience_exclusions`, `tenant_tags`, `lead_tags`, `blacklist_entries` (`entry_type='ip'` backs `/web_blacklist`).
- **CAPI, Outbox, Cron & Audit**: `capi_logs`, `meta_ads_insights`, `tenant_cron_runs` (with `(tenant_id, subroutine_key, run_key)` unique index in `migrate.ts:71-73`), `tenant_domain_events_outbox`, `admin_audit_logs`.

#### C. Kernel Tenant Isolation (`FORCE ROW LEVEL SECURITY`) & Dual-Engine Parity

1. **PostgreSQL / PGlite `FORCE ROW LEVEL SECURITY` (`schema.ts:734-794`, `migrate.ts:78-104`)**:
   - Every `mkt_*` table enables `ENABLE ROW LEVEL SECURITY` and `FORCE ROW LEVEL SECURITY`.
   - Policy `tenant_isolation_<tbl>` enforces:
     ```sql
     tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid
     ```
   - **Audit Finding & Fix (M1):** Legacy policies lacking `NULLIF(..., '')` threw invalid-UUID cast exceptions when `app.current_tenant_id` was unset (`''`). `migrate.ts:78-96` now automatically drops and recreates any `tenant_isolation_*` policy lacking `NULLIF`, and grants `SELECT, INSERT, UPDATE, DELETE` to `autodata_app`.
2. **Dual-Engine PG16 / PGlite / MariaDB 10.6+ Parity (`migrate.ts`, `sql-translator.ts`)**:
   - `runDatabaseMigrations()` (`migrate.ts:13-115`, aliased as `runMigrations`) detects `pool.dialect === 'mariadb'` vs Postgres/PGlite and executes `runMariaDbMigrations` or `runPostgresMigrations`, followed by idempotent `ensureMarketingSchema()` and `tenant_cron_runs` index normalization.
   - `sql-translator.ts` translates PostgreSQL positional parameters (`$1`, `$2`), `::type` casts, `clock_timestamp()` -> `CURRENT_TIMESTAMP(6)`, and `~` -> `REGEXP` (fixed in M1 for `segment-compiler.ts` numeric regex safety on MariaDB).
   - **M1 Audit Fixes:** Synced 16 missing `mkt_*` columns into `DATABASE_SCHEMA_MARIADB.sql`, aligned 7 `tenant_cooperation_slips` columns inline in `DATABASE_SCHEMA.sql`, and added 4 `tenant_billing_transactions` columns in `migrate.ts` `mariaExtensionDdl`.

#### D. Zero-Migration 1-Click SaaS Package Switching

- **4 Commercial Tiers on 1 Shared Core (`server/core/security/entitlements.ts:11-487`)**:
  1. `autodata_crm` (1.5M VND/mo) — CRM Auto, Fair-Share Routing, Gatekeeper, Tickets, CAPI
  2. `marketing_standalone` (1.8M VND/mo) — Standalone Marketing Automation Suite
  3. `growth_combo` (3.0M VND/mo) — CRM Auto + Marketing Automation + Revenue Attribution
  4. `domation_promax` (6.0M VND/mo) — Full ERP + CRM + Marketing + DOM Agent
- **Execution Contract (`billing.routes.ts:1000-1046`, `billing.service.ts:1644-1741`)**:
  - `POST /api/v1/billing/switch-package` and `POST /api/v1/myerp/package-entitlements/upgrade` execute `switchTenantSaasPackageInTx` -> `executePlanOrPackageChangeInTx` in a single DB transaction.
  - Supports `X-Idempotency-Key` replay (returning `requires_payment: true, idempotent_replay: true, gateway_session, payment_bank_info` for pending orders without double-charging), wallet deduction + proration credit (`excessCreditVnd`), and instant recalculation of `package_code`, `enabled_modules` (`expandEnabledModulesWithAliases`), `entitlements`, `terminology`, and `effective_permissions`.
  - **Zero Table Migration:** Switching between `marketing_standalone` and `growth_combo`/`domation_promax` requires **zero ETL, zero contact export/import, and zero schema changes** because all tenants already live in `leads`, `tenant_audiences`, and the 32 `mkt_*` tables.

---

### 2.2 Critical Legacy-to-Canonical Table Reconciliation

Legacy `DOMATION_FULLSTACK/db_schema.json` and `MYERP/backend/unified_schema.sql` table names **do not** exist as literal `mkt_web_sites`, `mkt_web_visitors`, `mkt_web_blacklist`, or `subscribers` tables in `AUTO_DATA_TENANRT`. All code, bridges, and migration scripts MUST map strictly to the canonical targets below:

| Legacy Table / Model (`DOMATION_FULLSTACK` / `MYERP`) | Incorrect Assumed Name (Do NOT Create) | Canonical `AUTO_DATA_TENANRT` Table(s) | Reconciliation Mechanism & Notes |
|---|---|---|---|
| `web_tracking_sites` | `mkt_web_sites` | **`mkt_web_properties`** | Unique `site_key`, `pricing_url_pattern`, `target_audience_id`. Bridged by `marketing-php-bridges.ts`. |
| `web_visitors` | `mkt_web_visitors` | **`mkt_web_sessions`** + **`mkt_web_events`** | Unique `(tenant_id, property_id, visitor_token)`, `lead_id` stitch, `pageviews_count`, `pricing_intent_detected`, `geo_country`, `browser`, `os`, `duration_seconds`. |
| `web_blacklist` | `mkt_web_blacklist` | **`blacklist_entries`** (`entry_type = 'ip'`) | IP blacklist queries & mutations filtered by `tenant_id` and `entry_type = 'ip'` (`marketing-php-bridges.ts:1657-1793`). |
| `subscribers` | `mkt_subscribers` | **`leads`** | Unified master contact store (`status = 'marketing_nurture'` or CRM lead status, deduplicated by E.164 `'84...'` phone then `LOWER(email)`). |
| `email_otps` | `mkt_email_otps` | **`mkt_otp_verifications`** | Unified Email & SMS OTP verification table with atomic `consumed_at` + `recipient` + `channel` + `expires_at` checks. |
| `marketing_campaigns` | `marketing_campaigns` | **`mkt_campaigns`** | Unified Email / ZNS / Multi-channel campaign store with `mkt_send_claims` & `mkt_campaign_reminders`. |
| `workflows` | `workflows` | **`mkt_flows`** + **`mkt_flow_snapshots`** + **`mkt_flow_enrollments`** | Versioned flow definitions + execution state snapshots + per-lead enrollments. |

---

### 2.3 API, Flow Engine, Master Cron, Channel Adapters, Compat & UI/UX Audit

| Subsystem | Audit Finding (Pre-Fix Defect) | Verified Remediation & Target State |
|---|---|---|
| **Flow Engine & Wait Resume** (`flow-engine.service.ts`, `flows.routes.ts`, `wave2-workers.ts`) | (1) `wave2-workers.ts` called `executeFlowForLead` with `{ skipWaitDelay: true }`, ignoring `wait_delay` and re-running from root; (2) Frontend step types (`action`, `wait`, `condition`, `split_test`, `update_tag`, `list_action`, `zalo_zns`, `crm_action`) mismatched backend types (`send_email`, `wait_delay`, `if_else_condition`, `ab_split`, `add_remove_tag`, `add_remove_list`, `send_zns`, `push_to_autodata_sale_round`); (3) Active flow `PUT` did not bump snapshot version; (4) `webhook_http` lacked full IPv6 SSRF protection. | **[M1 DONE]** (1) `runMarketingFlowsWorker` atomically claims `'waiting'` rows (`rowCount > 0`) and passes `{ enrollmentId: row.id, resumeFromStepId: row.current_step_id }`, resuming at `pausedNode.nextStepId` without duplicating enrollment; `computeWaitDelayMs` honors `cfg.unit` (`ms`..`weeks`, `until`/`until_date`); (2) `STEP_TYPE_ALIASES` & `normalizeFlowStepNode` normalize both `cfg`/`config` and edge keys (`trueNextStepId`/`yesStepId`, `falseNextStepId`/`noStepId`, `branches`); (3) Active `PUT /flows/:id` bumps `version` and writes `mkt_flow_snapshots`; (4) `assertSafeOutboundWebhookUrl` in `dispatchers.ts` blocks private/loopback/link-local/metadata IPv4 + mapped/NAT64/6to4/ULA/malformed IPv6; `notify_internal` logs to `lead_timeline_events` + MariaDB-safe `admin_audit_logs`. |
| **Campaigns, Email, Suppression & Reminders** (`campaigns.routes.ts`, `templates.routes.ts`, `utils.ts`) | Single-channel reminders did not filter `sc.channel`; `excluded_audience_id` & VN phone normalization (`0...` vs `84...` vs `+84...`) had gaps; open/click wrapping risked double-wrapping; `runMarketingCampaignsWorker` left status `'sent'` instead of `'completed'`. | **[M1 DONE]** `utils.ts` provides shared `injectEmailOpenAndClickTracking` (double-wrap safe, skips `/unsubscribe`, `/track/open/`, `/track/click/`), `stripHtmlTagsForPlainText`, and `getSuppressionMatchKeys` (`0...`↔`84...`↔`+84...`). Campaigns enforce `email_consent`/`zns_consent`, split `'multi'` into `['email','zns']`, run A/B split, dispatch via `dispatchMarketingEmail`/`dispatchZnsNotification`, set `'completed'`, and `process-reminders` / `runRemindersWorker` filter `sc.channel` & increment `dispatched_count`. |
| **Channel Adapters & AI RAG** (`zalo-zns.service.ts`, `meta-messenger.service.ts`, `zalo-mail.service.ts`, `social-bot.routes.ts`, `dispatchers.ts`) | ZNS and Meta Messenger lacked live OpenAPI/Graph adapters with sandbox/test hooks; `social-bot.routes.ts` did not retrieve `mkt_ai_training_docs` in live RAG replies; `OUTBOUND_SILENT_MODE` needed uniform enforcement. | **[M2 DONE]** `zalo-zns.service.ts` registers live ZNS OpenAPI dispatcher (`business.openapi.zalo.me/message/template` + token refresh + `setZnsTransportForTesting`), `meta-messenger.service.ts` implements Graph `/{page-id}/messages` + HMAC `verifyMetaWebhookSignature` + `extractMetaPageConfigs` + `preferredPageId` + `setMessengerTransportForTesting`, `social-bot.routes.ts` implements `generateBotReplyFromRag` using `mkt_ai_training_docs` + entity extraction, and explicit-recipient `zns_consent` phone normalization is verified. |
| **Master Cron & Advisory Lock** (`master-cron.ts`, `wave2-workers.ts`) | Overlap risk without cross-engine advisory lock; Wave 2 marketing workers needed unified orchestration and idempotent run keys. | **[M1 DONE]** `executeMasterCron` acquires `pg_try_advisory_lock(hashtext('autodata_master_cron_lock'))` (PG) or `GET_LOCK('autodata_master_cron_lock', 0)` (MariaDB), executes all **13 subroutines** (`sla`, `drain`, `zalo`, `billing`, `webhook`, `capi`, `marketing_flows`, `marketing_campaigns`, `audience_reeval`, `attendance_confirm`, `reminders`, `outbox_events`, `daily_report`), and logs to `tenant_cron_runs` with `(tenant_id, subroutine_key, run_key)`. |
| **Compat Bridge (`/api/v1/myerp/automation/*`)** (`marketing-config.ts`, `marketing-php-bridges.ts`) | Legacy `.php` and `route`/`action` endpoints returned stubs/501s or lacked strict validation (`campaigns?route=rename`, `otp_profiles`, `flows.php?route=...`, `flow_ai_review.php`, `survey_public.php`, `voucher_claim.php`, `estimate_reach`, `web_tracking`, `web_blacklist`). | **[M2 DONE]** `marketing-php-bridges.ts` implements full SQL/service handlers across flows, campaigns, lists, segments, surveys, vouchers, web tracking, blacklist, Zalo OA/audience, Meta customers, AI chatbot/training, OTP profiles, and uploads with mutating RBAC enforcement, `+84` `estimate-reach` SQL, `campaigns?route=rename`, `otp_profiles` persistence, and PGlite tx/UUID safety (`09-compat-bridge.e2e.test.ts` + `m2-channels-capi-compat.test.ts` pass). |
| **Cross-App Triggers, CAPI & CRM Sync** (`capi.service.ts`, `audiences.service.ts`, `dom-meta-report.service.ts`, `finance/index.ts`) | Re-entrant dynamic segment evaluation (`T3-04` deadlock), destructive `custom_fields` overwrite, `match-domation-sync` returning `{matched:0, synced:0}` (`F8-T1-05`), and CAPI retry / empty-field hashing risks. | **[M1 + M2 DONE]** `audiences.service.ts` implements `AsyncLocalStorage` `dynamicEvalContext` (`MAX_DYNAMIC_REEVAL_PASSES = 5`), `deepMergeJsonObjects`, and `promoteLeadsToSaleRoundInTx` -> `runUnassignedLeadDrainer`. `capi.service.ts` enforces NFC lowercase SHA-256 `buildCapiUserData` (omitting empty attributes) and `capi-retry.ts`. `flow-engine.service.ts` & `finance/index.ts` emit `Lead`/`CompleteRegistration`/`Purchase` + update `leads.total_revenue_vnd`; `match-domation-sync` passes `08-cross-app-capi-crm.e2e.test.ts`. |
| **UI/UX Sync, Dual-Mode & Modals** (`DOMATION_ERP_FULL`) | Dark sidebar mismatched `/data` & Meta Report white UI; missing Red `#DC2626`/`#EF4444` accent in Marketing & ERP; Upgrade button truncated at sidebar bottom; plain gradient loading screen; narrow Email/ZNS step modals; missing `MarketingSpotlightTour`; `.dom-meta-scope` using `Roboto`; `/capi` missing `.mkt-scope`; `.env` port mismatch. | **[M3.1–M3.4 DONE]** White/light `Sidebar.tsx` (+ standalone `MARKETING AUTOMATION` workspace pill), Royal Sapphire `#1E40FF` + Red `#DC2626` palette (incl. Quick Nav modal), `Be Vietnam Pro` + `tabular-nums` across `.mkt-scope` & `.dom-meta-scope`, `DomationProgressLoader` (`fluent-brand-ambient-bg.{webp,jpg}`), Upgrade relocated to `Settings.tsx` (`PackageUpgradePanel`), `StepEditor.tsx` (`'3xl'` Email 2-col / `'2xl'` ZNS), `MarketingSpotlightTour.tsx` (8 areas, SVG `<mask>`), `/capi` `.mkt-scope`, `FlowBuilderTab` synchronous centering, `useNativeAppBackGuard` redirect fix; verified `25/25` ERP tests, `11/11` `10-browser-dual-mode-ui`, `7/7` `12-tier4-scenarios`, and `51/51` ERP screenshot captures PASS. |

---

## 3. Phased 9-Domain Partial Migration Roadmap

### 3.1 Dependency Graph & Phase Ordering Rationale

Partial migration executes in **4 sequential waves across all 9 domains** so that foundational contact/segment structures exist before capture/tracking endpoints populate them, and orchestration/delivery engines run before telemetry/drawer layers report on them:

1. **Wave 1 — Contact & Segmentation Foundation (`Domain 1: tệp` -> `Domain 2: segment`)**:
   - `tệp` (`leads`, `tenant_audiences`, `tenant_tags`, `custom_fields`) is the master entity referenced by every form, survey, web session, flow enrollment, campaign send claim, and CRM handover.
   - `segment` (`segment-compiler.ts` + `condition-schema.service.ts`) compiles dynamic logic over `leads` and timeline events before automation/campaigns evaluate target audiences.
2. **Wave 2 — Acquisition & Behavioral Capture (`Domain 3: website tracking` -> `Domain 4: khảo sát`)**:
   - `website tracking` (`/sdk.js`, `/track`, `mkt_web_*`, `blacklist_entries`, `mkt_short_links`) and `khảo sát` (`mkt_surveys`, `mkt_survey_responses`, `assignTag`) feed identified contacts, `quiz_score`, `lead_score`, and `marketing.engaged` events into Wave 1 audiences/tags.
3. **Wave 3 — Orchestration & Outbound Execution (`Domain 5: automation` -> `Domain 6: chiến dịch automation`)**:
   - `automation` (`mkt_flows`, `mkt_flow_snapshots`, `mkt_flow_enrollments`) and `chiến dịch automation` (`mkt_campaigns`, `mkt_send_claims`, `mkt_campaign_reminders`) consume Wave 1 segments/lists and react to Wave 2 triggers to dispatch Email/ZNS/webhooks/CRM round promotions.
4. **Wave 4 — Attribution, Engagement Telemetry & Measurement UI (`Domain 7: chỉ số` -> `Domain 8: report click/open` -> `Domain 9: tab drawer đo lường`)**:
   - `chỉ số` aggregates `lead_score`, `quiz_score`, `attributed_revenue_vnd`, Meta CAPI, and DOM Meta attribution; `report click/open` tracks `/track/open`, `/track/click`, `/r/:code`, and `/unsubscribe`; `tab drawer đo lường` exposes all 7 analytical drawers/modals in `DOMATION_ERP_FULL`.

---

### 3.2 Domain 1 (Phase 1A): `tệp` (Audiences, Lists, Contacts, Custom Fields & CRM Handover)

- **Source/Legacy vs Canonical Tables**:
  - Legacy `subscribers` -> Canonical **`leads`** (`status='marketing_nurture'` or CRM stage, `custom_fields JSONB`, `email_consent`, `zns_consent`, `lead_score`, `is_deleted`)
  - Legacy lists/groups -> **`tenant_audiences`** (`audience_type`: `'static'` | `'dynamic_logic'` | `'list'`), **`tenant_audience_members`**, **`tenant_audience_exclusions`**, **`tenant_tags`**, **`lead_tags`**
  - Custom field definitions & CRM handover -> **`tenant_custom_fields`**, **`tenant_pipeline_custom_fields`**, **`distribution_rounds`**, **`tenant_pipelines`**, **`tenant_pipeline_stages`**
- **Backend Routes & Services**:
  - `server/modules/audiences/audiences.routes.ts` (`/api/v1/audiences/*`, `GET /field-catalog`, `GET /contacts`, `POST /import`, `POST /promote-to-sale-round`)
  - `server/modules/audiences/audiences.service.ts` (`upsertMasterContactInTx`, `deepMergeJsonObjects`, `promoteLeadsToSaleRoundInTx`, `evaluateDynamicAudience`, `importRowsIntoAudience`)
  - `server/routes/myerp-compat/marketing-php-bridges.ts` (`lists?route=create_with_filter|cleanup`, `bulk_operations`, `audience_split.php`, `subscribers/:id`, `subscriber_ai_summary`)
- **Frontend Pages & Components**:
  - `DOMATION_ERP_FULL/src/pages/marketing/AudienceSegmentsPage.tsx`
  - `DOMATION_ERP_FULL/src/components/marketing/components/audience/*` (list/contact CRUD, tag manager, custom-field mapper, CRM push actions)
- **Data Backfill & Cutover Rules**:
  - Normalize Vietnamese phone numbers to E.164 `'84...'` (`phone.service.ts`) and lowercase emails before deduplication in `upsertMasterContactInTx` (`phone` match first, then `LOWER(email)` within `tenant_id`).
  - Flatten legacy `cf_`, `cf.`, and `custom_fields.` flat keys and merge via `deepMergeJsonObjects` so existing `leads.custom_fields` keys are never clobbered.
  - Ensure `push_to_autodata_sale_round` / `promoteLeadsToSaleRoundInTx` assigns valid `pipeline_id`, `stage_id`, and `round_id` before transitioning `status` to `'unassigned_pending'` and invoking `runUnassignedLeadDrainer`.
- **Idempotency & Tenant Isolation Checks**:
  - Deduplication key `(tenant_id, phone_e164)` / `(tenant_id, LOWER(email))` prevents duplicate contact rows on repeated imports.
  - `AsyncLocalStorage` `dynamicEvalContext` with `MAX_DYNAMIC_REEVAL_PASSES = 5` prevents re-entrant dynamic-audience evaluation loops (`T3-04`).
  - `FORCE ROW LEVEL SECURITY` on `leads` and `tenant_audiences*` scopes all queries to `app.current_tenant_id`.
- **Verification Gate Criteria**:
  - `tests/m1-marketing-core.test.ts` + `tests/e2e-marketing/04-audiences-segments.e2e.test.ts` (`10/10`) + `T3-04` (`11-tier3-pairwise.e2e.test.ts`) pass with `0` cross-tenant leakage (`tests/rls-zero-leakage.test.ts`).

---

### 3.3 Domain 2 (Phase 1B): `segment` (Dynamic SQL AST, `cf.` / `birthday` Operators & Exclusions)

- **Source/Legacy vs Canonical Tables**:
  - **`tenant_audiences`** (`audience_type = 'dynamic_logic'`, `filter_branches JSONB`, `cached_member_count`)
  - **`tenant_audience_exclusions`** (`lead_id`, `email`, `phone`, `excluded_audience_id`), **`tenant_audience_members`**
  - Evaluated across **`leads`**, **`lead_tags`**, **`tenant_tags`**, **`lead_timeline_events`**, **`mkt_survey_responses`**
- **Backend Routes & Services**:
  - `server/modules/audiences/segment-compiler.ts` (`normalizeFilterBranchesAst`, `compileSegmentWhereSql`)
  - `server/services/condition-schema.service.ts` (`CONDITION_OPERATORS_BY_TYPE`, `buildDynamicConditionSchemaRegistryInTx`)
  - `server/modules/audiences/audiences.routes.ts` (`POST /preview`, `GET /contacts?segment_id=...`) and `marketing-php-bridges.ts` (`segments?route=sync|preview|estimate`)
- **Frontend Pages & Components**:
  - `DOMATION_ERP_FULL/src/pages/marketing/AudienceSegmentsPage.tsx` (Segment builder, live reach preview, exclusion selector)
- **Data Backfill & Cutover Rules**:
  - Migrate legacy JSON condition trees through `normalizeFilterBranchesAst` (supports `AND`/`OR` nested branches and legacy flat rule arrays).
  - Support `quiz_score` (coalescing `metadata->>'quiz_score'` and `metadata->>'score'` with regex guard `'^-?[0-9]+([.][0-9]+)?$'`), `birthday` / `cf.birthday` (`is_today`, `is_this_month`, `before_days`, `on`, `before`, `after`, `is_empty`, `is_not_empty`, `negate`), and `cf.<key>`/`custom_fields.<key>`/`custom.<key>` operators.
  - Enforce `tenant_audience_exclusions` and `extraExcludeAudienceIds` on both `POST /audiences/preview` and `GET /audiences/contacts?segment_id=...`, sorting by `COALESCE(l.lead_score, 0) DESC`.
- **Idempotency & Tenant Isolation Checks**:
  - 100% whitelist-validated SQL column identifiers + positional `$N` parameters (zero raw string interpolation of user values) with MariaDB `->>` and `REGEXP` translation parity.
  - Dynamic audience re-evaluation in `runAudienceReevalWorker` is idempotent via `ON CONFLICT DO NOTHING` / diff sync on `tenant_audience_members`.
- **Verification Gate Criteria**:
  - All segment AST tests (`quiz_score` non-numeric/scoreless/`negate`, `birthday` `negate: true`, `cf.` keys, exclusions, MariaDB translation) pass in `tests/m1-marketing-core.test.ts` and `tests/e2e-marketing/04-audiences-segments.e2e.test.ts`.

---

### 3.4 Domain 3 (Phase 2A): `website tracking` (`/sdk.js`, `/track`, Heatmaps, Blacklist & Shortlinks/QR)

- **Source/Legacy vs Canonical Tables**:
  - Legacy `web_tracking_sites` -> **`mkt_web_properties`** (`site_key UNIQUE`, `pricing_url_pattern`, `target_audience_id`)
  - Legacy `web_visitors` -> **`mkt_web_sessions`** (`visitor_token`, `lead_id`, `pageviews_count`, `pricing_intent_detected`, `geo_country`, `browser`, `os`, `duration_seconds`) + **`mkt_web_events`**
  - Heatmaps -> **`mkt_web_heatmaps`**
  - Legacy `web_blacklist` -> **`blacklist_entries`** (`entry_type = 'ip'`, `value`, `reason`)
  - Shortlinks & QR -> **`mkt_short_links`**, **`mkt_short_link_clicks`** (`qr_design_json`, `unique_click_count`)
- **Backend Routes & Services**:
  - `server/modules/marketing-public/index.ts` (`GET /sdk.js`, `POST /track`, `GET /r/:code`)
  - `server/modules/marketing/web-tracking.routes.ts` & `vouchers.routes.ts` (`PUT /shortlinks/:id`, `GET /clicks-analytics`)
  - `server/routes/myerp-compat/marketing-php-bridges.ts` (`web_tracking?action=list|visitors|visitor_journey|live_visitors|heatmap|blacklist|stats|retention`, `web_blacklist?action=add|delete`, `track.php`)
- **Frontend Pages & Components**:
  - `DOMATION_ERP_FULL/src/pages/marketing/WebTrackingOmnichannelPage.tsx`
  - `DOMATION_ERP_FULL/src/pages/marketing/VouchersQrPage.tsx` + `LinksQR.tsx`
- **Data Backfill & Cutover Rules**:
  - Migrate legacy site records into `mkt_web_properties` preserving `site_key` so existing client `<script src=".../sdk.js?key=...">` embeds continue working uninterrupted.
  - Migrate IP exclusions strictly into `blacklist_entries` with `entry_type = 'ip'`.
  - On `POST /track`, unwrap `identify.{name,phone,email}` or top-level identity fields, upsert contact via `upsertMasterContactInTx`, **retroactively stitch** prior `mkt_web_events.lead_id`, increment `pageviews_count` only for `event_type === 'pageview'`, and on `pricing_intent_detected` add `+15` `lead_score`, enroll in `target_audience_id`, and emit `marketing.engaged`.
- **Idempotency & Tenant Isolation Checks**:
  - Unique constraint `uk_mkt_web_visitor_prop (tenant_id, property_id, visitor_token)` prevents duplicate visitor session rows under concurrent beacons.
  - `/sdk.js` wraps `localStorage` in `try/catch` (safe in sandboxed iframes) and serializes config via `JSON.stringify` (XSS-safe).
  - Blacklisted IPs in `blacklist_entries (entry_type='ip')` are dropped prior to session/event persistence per tenant.
- **Verification Gate Criteria**:
  - `tests/e2e-marketing/06-tracking-surveys-vouchers.e2e.test.ts` (`10/10`) and `T3-*` session-stitching tests pass; `web-tracking.routes.ts` `lead_id` enrichment verified in M2 Iter 2.

---

### 3.5 Domain 4 (Phase 2B): `khảo sát` (25-Block Surveys, Quiz/NPS Scoring, `redirect_rules` Tag Persistence)

- **Source/Legacy vs Canonical Tables**:
  - **`mkt_surveys`** (`slug` unique per tenant, `blocks_json`, `theme_json`, `settings_json`, `redirect_rules_json`, `thank_you_json`, `response_count`, `avg_score`)
  - **`mkt_survey_responses`** (`answers_json`, `quiz_score`, `nps_score`, `tags_applied`)
  - **`tenant_tags`**, **`lead_tags`**, **`mkt_voucher_codes`** (optional completion voucher reward), **`leads`**, **`lead_timeline_events`**
- **Backend Routes & Services**:
  - `server/modules/marketing/surveys.routes.ts` (`SURVEY_25_BLOCK_TYPES`, CRUD, `GET /:id/analytics`, `GET /:id/report`, `GET /:id/export.csv`)
  - `server/modules/marketing-public/index.ts` (`GET /surveys/:slug`, `POST /surveys/:slug`)
  - `server/routes/myerp-compat/marketing-php-bridges.ts` (`/automation/survey_public.php` & `/survey_public.php`)
- **Frontend Pages & Components**:
  - `DOMATION_ERP_FULL/src/pages/marketing/SurveysQuizPage.tsx` (25-block builder + logic/redirect rule editor)
  - `DOMATION_ERP_FULL/src/pages/marketing/PublicSurveyPage.tsx` (public respondent runtime)
  - `DOMATION_ERP_FULL/src/components/marketing/components/surveys/SurveyReportModal.tsx` (1178 lines)
- **Data Backfill & Cutover Rules**:
  - Import legacy surveys preserving `slug` and normalizing block definitions to `SURVEY_25_BLOCK_TYPES`.
  - In `POST /api/v1/public/marketing/surveys/:slug`, compute `quiz_score` and `nps_score`, evaluate `redirect_rules` **before** persisting `tenant_tags`/`lead_tags` so rule-triggered `assignTag` values are saved both in CRM `lead_tags` and in `mkt_survey_responses.tags_applied`.
  - Emit `marketing.engaged` (`survey_completed`) so downstream automation flows and Meta CAPI `CompleteRegistration` fire automatically.
- **Idempotency & Tenant Isolation Checks**:
  - `slug` uniqueness and survey lookups are strictly scoped by `tenant_id` (via `X-Tenant-Slug` or `public_token`/slug resolution within `withTenantTransaction`).
  - CSV export (`export.csv`) escapes formula prefixes and enforces tenant RBAC view permissions.
- **Verification Gate Criteria**:
  - `tests/e2e-marketing/06-tracking-surveys-vouchers.e2e.test.ts` and `tests/m1-marketing-core.test.ts` verify `assignTag` DB persistence into `lead_tags`, `quiz_score` calculation, and `survey_public.php` compat routing.

---

### 3.6 Domain 5 (Phase 3A): `automation` (15×11 Flow Engine, Snapshots, Wait Resume, Simulation & AI Review)

- **Source/Legacy vs Canonical Tables**:
  - Legacy `workflows` -> **`mkt_flows`** (`status`, `version`, `trigger_type`, `trigger_config`, `steps_json`, `enrolled_count`, `attributed_revenue_vnd`, `pushed_to_sale_count`)
  - **`mkt_flow_snapshots`** (`flow_id`, `version`, `steps_json`, `trigger_config`)
  - **`mkt_flow_enrollments`** (`flow_id`, `snapshot_version`, `lead_id`, `current_step_id`, `status`, `next_run_at`, `execution_trace`)
  - Side-effect logs -> **`lead_timeline_events`**, **`admin_audit_logs`**
- **Backend Routes & Services**:
  - `server/modules/marketing/flows.routes.ts` (CRUD, `POST /:id/activate`, `POST /:id/enroll`, `POST /:id/simulate`, `POST /:id/restore-snapshot`)
  - `server/modules/marketing/flow-engine.service.ts` (`FLOW_15_TRIGGERS`, `FLOW_11_NODES`, `STEP_TYPE_ALIASES`, `normalizeFlowStepNode`, `computeWaitDelayMs`, `executeFlowForLead`, `auditFlowWithDomAgent`)
  - `server/modules/marketing/dispatchers.ts` (`assertSafeOutboundWebhookUrl`, `dispatchFlowWebhook`, `dispatchZnsNotification`, `dispatchMarketingEmail`)
  - `server/cron/subroutines/wave2-workers.ts` (`runMarketingFlowsWorker`)
  - `server/routes/myerp-compat/marketing-php-bridges.ts` (`flows.php?route=flow-snapshots|duplicate|sync|active-count|migrate-users|completed-users|stats|distribution|participants|step-errors|step-unsubscribes`, `flow_ai_review.php`)
- **Frontend Pages & Components**:
  - `DOMATION_ERP_FULL/src/pages/marketing/AutomationFlowsPage.tsx`
  - `DOMATION_ERP_FULL/src/components/marketing/components/flows/modals/StepEditor.tsx` (`'3xl'` Email, `'2xl'` ZNS, `'xl'` advanced condition/CRM), `EmailActionConfig.tsx`, `ZaloZNSStepConfig.tsx`
- **Data Backfill & Cutover Rules**:
  - Normalize all legacy node schemas through `normalizeFlowStepNode` (accepting frontend aliases `action`, `wait`, `condition`, `advanced_condition`, `split_test`, `update_tag`, `list_action`, `zalo_zns`, `crm_action` and both `cfg`/`config` edge variants).
  - Create initial `mkt_flow_snapshots` v1 for every migrated active flow; on `PUT /flows/:id` of an active flow, bump `version` and insert a new snapshot so waiting enrollments resume accurately.
  - On cron wake-up (`runMarketingFlowsWorker`), claim `'waiting'` enrollments atomically (`status = 'processing'` / `rowCount > 0`) and pass `{ enrollmentId: row.id, resumeFromStepId: row.current_step_id }` to continue at `pausedNode.nextStepId`.
- **Idempotency & Tenant Isolation Checks**:
  - Wait resume updates the existing `mkt_flow_enrollments` row in place—never creating a duplicate enrollment or double-counting `enrolled_count`.
  - `webhook_http` validates URLs via `assertSafeOutboundWebhookUrl` (blocking private/loopback/link-local/metadata IPv4 and IPv6).
  - Email/ZNS nodes check `mkt_suppression_list`, `email_consent`, and `zns_consent` prior to dispatch.
- **Verification Gate Criteria**:
  - `tests/e2e-marketing/02-automation-flows.e2e.test.ts` (`11/11`), `tests/m1-marketing-core.test.ts`, and `F10-T1-01`/`F10-T1-04` browser flow builder checks pass cleanly.

---

### 3.7 Domain 6 (Phase 3B): `chiến dịch automation` (Campaigns, Multi-Channel Email/ZNS, A/B, Suppression & Reminders)

- **Source/Legacy vs Canonical Tables**:
  - Legacy `marketing_campaigns` -> **`mkt_campaigns`** (`channel`: `'email'` | `'zns'` | `'multi'`, `ab_split_ratio`, `subject_a`, `subject_b`, `excluded_audience_id`, `status`)
  - **`mkt_send_claims`** (`uk_mkt_send_claim_unique (tenant_id, campaign_id, lead_id, channel)`, `status`, `opened_at`, `clicked_at`)
  - **`mkt_campaign_reminders`** (`trigger_condition`, `channel`, `dispatched_count`)
  - **`mkt_suppression_list`**, **`mkt_email_templates`**, **`mkt_zalo_templates`**, **`mkt_zalo_oa_configs`**
- **Backend Routes & Services**:
  - `server/modules/marketing/campaigns.routes.ts` (`POST /:id/send`, `POST /:id/process-reminders`, `POST /:id/pause`, `POST /:id/resume`, `POST /estimate-reach`, `GET /ses-quota`)
  - `server/modules/marketing/templates.routes.ts` (`POST /quick-send`, `PUT /:id`) & `utils.ts` (`injectEmailOpenAndClickTracking`, `getSuppressionMatchKeys`)
  - `server/services/zalo-mail.service.ts`, `server/services/zalo-zns.service.ts`, `server/services/ses-sns.service.ts`
  - `server/cron/subroutines/wave2-workers.ts` (`runMarketingCampaignsWorker`, `runRemindersWorker`)
  - `server/routes/myerp-compat/marketing-php-bridges.ts` (`campaigns.php?route=...`, `estimate_reach`, `zalo_oa?route=generate-auth-url`, `zalo_audience?route=lists`)
- **Frontend Pages & Components**:
  - `DOMATION_ERP_FULL/src/pages/marketing/EmailCampaignsPage.tsx`, `EmailTemplatesPage.tsx`, `CampaignDetailDrawer.tsx`, `ZaloBroadcastTab.tsx`, `ZaloOAManager.tsx`
- **Data Backfill & Cutover Rules**:
  - Preserve historical `mkt_send_claims` so re-running or resuming a campaign never re-sends to already claimed recipients.
  - Resolve target audience minus `excluded_audience_id` / `tenant_audience_exclusions` and filter out `is_deleted = true`, missing consent (`email_consent` / `zns_consent`), and normalized `mkt_suppression_list` keys (`0...`↔`84...`↔`+84...`).
  - Split `'multi'` campaigns into `['email', 'zns']` send claims; render merge tags and inject open pixel + wrapped click URLs for HTML emails.
- **Idempotency & Tenant Isolation Checks**:
  - Composite unique key `uk_mkt_send_claim_unique (tenant_id, campaign_id, lead_id, channel)` enforces exactly-once send claim creation even under concurrent cron retries.
  - `OUTBOUND_SILENT_MODE=true` immediately halts external SMTP/SES/ZNS HTTP traffic while preserving DB audit records.
- **Verification Gate Criteria**:
  - `tests/e2e-marketing/03-campaigns-email.e2e.test.ts` (`10/10`), `tests/e2e-marketing/07-channel-adapters-ai.e2e.test.ts` (`19/19`), `F9-T1-04` (`campaigns?route=rename`), and `tests/m2-channels-capi-compat.test.ts` (`7/7`) pass.

---

### 3.8 Domain 7 (Phase 4A): `chỉ số` (Scoring, Revenue Attribution, Meta CAPI & Realtime Report)

- **Source/Legacy vs Canonical Tables**:
  - **`leads`** (`lead_score`, `total_revenue_vnd`, `quality_status`, `lifecycle_stage`, `fbclid`, `fbc`, `fbp`, `meta_lead_id`)
  - **`mkt_survey_responses`** (`quiz_score`, `nps_score`)
  - **`mkt_campaigns`** (`attributed_revenue_vnd`, `cost_vnd`), **`mkt_flows`** (`attributed_revenue_vnd`, `pushed_to_sale_count`)
  - **`capi_logs`**, **`meta_ads_insights`**, **`lead_timeline_events`**
- **Backend Routes & Services**:
  - `server/modules/marketing/index.ts` (`GET /api/v1/marketing/overview`)
  - `server/services/capi.service.ts` (`buildCapiUserData`, `resolveCapiEventForQualityOrStage`, `dispatchStageCapiEventDetached`) & `server/cron/subroutines/capi-retry.ts`
  - `server/services/dom-meta-report.service.ts` & `server/modules/finance/index.ts` (`deal.won` revenue attribution)
  - `server/modules/marketing/flow-engine.service.ts` (`form.submitted` -> `Lead`, `survey_completed` -> `CompleteRegistration`, `deal.won` -> `Purchase`)
- **Frontend Pages & Components**:
  - `DOMATION_ERP_FULL/src/pages/marketing/MarketingDashboardPage.tsx`
  - `DOMATION_ERP_FULL/src/pages/DomMetaReportPage.tsx` & `DOMATION_ERP_FULL/src/pages/CapiPage.tsx`
- **Data Backfill & Cutover Rules**:
  - Backfill `leads.total_revenue_vnd` from won deals (`finance/index.ts`) and ensure `mkt_campaigns.attributed_revenue_vnd` / `mkt_flows.attributed_revenue_vnd` reflect attributed conversions.
  - Ensure `buildCapiUserData` normalizes Vietnamese names via Unicode NFC + lowercase (`splitAndNormalizeVietnameseName`) and **omits** missing/empty attributes so `""` is never SHA-256 hashed.
  - Complete M2 `match-domation-sync` implementation so CRM/Domation lead matching synchronizes attribution status (`F8-T1-05`).
- **Idempotency & Tenant Isolation Checks**:
  - `capi_logs` records `event_id` deduplication keys for Meta Conversions API v21.0 retry safety.
  - `dom-meta-report.service.ts` enforces tenant isolation and PII masking (`shouldMaskPiiForActor`) for viewer roles.
- **Verification Gate Criteria**:
  - `tests/e2e-marketing/08-cross-app-capi-crm.e2e.test.ts` (`12/12` once M2 `F8-T1-05` closes), `tests/dom-meta-report.test.ts`, and `F10-T1-03` / `F10-T2-01` (`.dom-meta-scope` `Be Vietnam Pro` & `/capi` `.mkt-scope`) pass.

---

### 3.9 Domain 8 (Phase 4B): `report click/open` (Open Pixel, Click Redirects, Unique Shortlinks & HMAC Unsubscribe)

- **Source/Legacy vs Canonical Tables**:
  - **`mkt_send_claims`** (`opened_at`, `clicked_at`, `status`)
  - **`mkt_campaigns`** (`opened_count`, `clicked_count`, `unsubscribed_count`)
  - **`mkt_short_links`** (`click_count`, `unique_click_count`), **`mkt_short_link_clicks`** (`utm_json.visitor_hash`, `device_type`, `referrer`)
  - **`mkt_suppression_list`**, **`lead_timeline_events`**
- **Backend Routes & Services**:
  - `server/modules/marketing-public/index.ts`:
    - `GET /track/open/:claimId` (`L1171-1241`, returns `1x1` GIF `no-store`)
    - `GET /track/click/:claimId` (`L1243-1329`, validates `https?://` target)
    - `GET /r/:code` (`L1032-1166`, shortlink redirect + `?json=1`)
    - `ALL /unsubscribe` (`L1331-1399`, HMAC verification via `verifyUnsubscribeHmac`)
  - `server/modules/marketing/vouchers.routes.ts` (`GET /clicks-analytics`)
- **Frontend Pages & Components**:
  - `DOMATION_ERP_FULL/src/components/marketing/components/campaigns/LinkClicksTab.tsx` (440 lines: supports `type: 'campaign' | 'flow'`, list + `ClickHeatmap` mode, `deviceFilter`)
- **Data Backfill & Cutover Rules**:
  - Populate `mkt_short_links.unique_click_count` from distinct `utm_json.visitor_hash` (`lead:<id>` or `sha256(ip|ua)`) in `mkt_short_link_clicks`.
  - Ensure email HTML links and open pixels resolve via `resolvePublicRequestOrigin` and `injectEmailOpenAndClickTracking` without wrapping `/unsubscribe`, `/track/open/`, or `/track/click/`.
- **Idempotency & Tenant Isolation Checks**:
  - Atomic SQL guards (`WHERE opened_at IS NULL`, `WHERE clicked_at IS NULL`) guarantee repeated email client pre-fetches or duplicate clicks increment `opened_count` / `clicked_count` **at most once** per claim.
  - `GET /r/:code` computes `uniqueDelta` (`0` or `1`) by checking prior `visitor_hash` entries inside the transaction.
  - `/unsubscribe` requires valid `verifyUnsubscribeHmac` signature before updating `leads.email_consent` / `zns_consent`, inserting into `mkt_suppression_list`, and incrementing `unsubscribed_count`.
- **Verification Gate Criteria**:
  - `tests/m1-marketing-core.test.ts` and `tests/e2e-marketing/03-campaigns-email.e2e.test.ts` + `06-tracking-surveys-vouchers.e2e.test.ts` verify single-increment open/click counts, unique shortlink deduplication, and HMAC unsubscribe.

---

### 3.10 Domain 9 (Phase 4C): `tab drawer đo lường` (All 7 Measurement Drawers & Modals)

- **Canonical UI Inventory (`d:\GITHUB_SPACE\DOMATION_ERP_FULL\src\components\marketing\components\`)**:

| # | Component File | Lines | Domain Scope | Backend Endpoints & Data Sources |
|---|---|---:|---|---|
| 1 | `campaigns/CampaignDetailDrawer.tsx` | 1937 | Campaign Measurement Drawer | `GET /campaigns/:id`, `CampaignDeliveryDetailsTab`, `LinkClicksTab`, `TechStatsTab`, inline rename (`campaigns?route=rename`), pause/resume, desktop/mobile email preview, activity logs. |
| 2 | `flows/tabs/FlowAnalyticsTab.tsx` | 2099 | Flow Measurement Tab | Flow KPI funnel, step counts, waiting bottleneck distribution (`flows.php?route=distribution`), branch completion stats (`?route=completed-users`), execution logs (`MktDateRangeFilter`), `DomationHeroAccent`/`DomationCardCornerAccent`. |
| 3 | `flows/modals/StepParticipantsModal.tsx` | 2113 | Per-Step Participant Drawer/Modal | 15 participant tabs (`waiting`, `opened`, `failed`, `unsubscribed`, `all`, `clicks`, `report`, `zns_sent`, `zns_clicked`, `zns_replied`, `zns_failed`, `zns_skipped`, `all_touched`, `preview`, `inactive`), embedding `LinkClicksTab` & `TechStatsTab`. |
| 4 | `flows/modals/StepErrorModal.tsx` | 390 | Step Failure Diagnostics Modal | `flows.php?route=step-errors` — failure reason breakdown & retry triggers. |
| 5 | `flows/modals/StepUnsubscribeModal.tsx` | 153 | Step Unsubscribe Audit Modal | `flows.php?route=step-unsubscribes` — opt-out inspection per flow step. |
| 6 | `surveys/SurveyReportModal.tsx` | 1178 | Survey / Quiz / NPS Report Modal | `GET /surveys/:id/analytics`, `/report`, `/export.csv` (`MktDateRangeFilter`, Recharts breakdowns, respondent table). |
| 7 | `zalo/AutomationStatsModal.tsx` | 250 | Zalo Automation Stats Modal | `zalo_stats.php?route=summary&id=...` & `?route=logs` (`marketing-php-bridges.ts:2014+`). |

- **Data Backfill & Cutover Rules**:
  - Ensure all 7 measurement surfaces consume unified `MktDateRangeFilter` / `DomUnifiedDatePicker` date ranges, `tabular-nums` numeric alignment, Royal Sapphire `#1E40FF` + Red `#DC2626` semantic charts, and `myerp-compat` / native `/api/v1/marketing/*` responses with zero hardcoded placeholder arrays.
- **Idempotency & Tenant Isolation Checks**:
  - Every analytics query filters strictly by `tenant_id` (`withTenantTransaction` + RLS) and honors PII masking for restricted roles.
- **Verification Gate Criteria**:
  - `FlowAnalyticsTab` renders `'Hành trình Khách hàng'` (`F10-T1-05`), `CampaignDetailDrawer` rename/metrics pass (`F9-T1-04`), and `scripts/compare_marketing_ui_screenshots.mjs` verifies zero console/runtime errors across all drawers/modals on desktop (`1440x900`) & mobile (`390x844`).

---

## 4. Dual-Mode Coexistence & Production Cutover Checklist

### 4.1 Dual-Mode Runtime (`marketing_standalone` <-> Portal Coexistence)

Verified in `DOMATION_ERP_FULL/src/App.tsx:180-242`, `TenantConfigContext.tsx`, `Sidebar.tsx:755-775`, `Settings.tsx:2756-2860`, and `.env`:

1. **Shared Backend & Environment Alignment**:
   - Backend `AUTO_DATA_TENANRT` listens on `PORT=3100`; `DOMATION_ERP_FULL/.env` sets `VITE_API_ORIGIN=http://127.0.0.1:3100`.
   - `src/components/marketing/utils/config.ts` uses relative `/api/v1/myerp/automation` and `/api/v1/public/marketing` paths on localhost (proxy-safe in dev/E2E) and `${RESOLVED_API_ORIGIN}/api/v1/...` in production.
2. **Standalone Mode (`package_code === 'marketing_standalone'`)**:
   - `TenantConfigContext` derives `isMarketingStandalone = true` from `/api/v1/auth/me` / `tenant_config/bootstrap`.
   - `/` renders `MarketingDashboardPage` wrapped in `.mkt-scope`; `Sidebar.tsx:756-775` filters navigation exclusively to `MARKETING AUTOMATION` + Settings/Account/AI Training; `App.tsx:180-187` (`isAllowedInMarketingStandalone`) permits `/`, `/marketing/*`, `/meta-report`, `/capi`, `/settings`, `/accounts`, `/account`, `/ai-training`, `/about-erp`, `/ai-space/*`, `/chat/*` and redirects disallowed CRM/ERP paths to `/marketing`.
   - The Upgrade (`Nâng cấp`) CTA is removed from the sidebar bottom and placed inside `Settings.tsx:2756-2860` (`data-testid="settings-upgrade-banner"`), enabling 1-click upgrade to `growth_combo` or `domation_promax`.
3. **Portal-Embedded Mode (`growth_combo` / `domation_promax`)**:
   - Unlocks `/data` (CRM Auto), `/rounds`, `/pipelines`, `/meta-report`, `/capi`, and ERP routes alongside `/marketing/*` with **zero contact migration** because `leads`, `tenant_audiences`, and all 32 `mkt_*` tables are shared in place.

---

### 4.2 Rollback & Incident Kill-Switch Procedures

| Risk / Incident Scenario | Immediate Rollback / Mitigation Action | Data Safety Guarantee |
|---|---|---|
| **Unexpected Outbound Email / ZNS / Messenger / CAPI Surge** | Set `OUTBOUND_SILENT_MODE=true` in backend environment and reload/restart kernel. | Instantly blocks live external SMTP/SES/ZNS/Meta Graph HTTP requests while preserving DB state, send claims, and flow traces (`outbound-guard.ts`). |
| **Partial Compat Route Regression During Cutover** | Route affected frontend call back through `/api/v1/myerp/automation/*.php` (`marketing-php-bridges.ts`) or toggle reverse proxy route while keeping shared Postgres/MariaDB schema intact. | Zero schema rollbacks needed; `schema.ts` & `migrate.ts` only use additive `CREATE TABLE IF NOT EXISTS` / `ADD COLUMN IF NOT EXISTS`. |
| **Package Upgrade / Billing Dispute** | Inspect `tenant_billing_transactions` (`previous_package`, `new_package`, `idempotency_key`); trigger downgrade with `schedule_at_period_end: true` via `switchTenantSaasPackageInTx`. | Existing CRM/Marketing data remains preserved in `leads` & `mkt_*` tables; `X-Idempotency-Key` prevents duplicate charges. |
| **Cron Subrouting Contention / Stall** | Run targeted recovery via `POST /api/v1/operations/cron/master` with `{ subroutines: ['marketing_flows', ...] }`; inspect `tenant_cron_runs`. | Advisory lock (`pg_try_advisory_lock` / `GET_LOCK`) guarantees zero concurrent cron overlap; atomic claim locks prevent duplicate wait-step resumes. |

---

### 4.3 Production Cutover & Verification Gate Checklist

Execute in strict sequence prior to declaring **M5 Production Ready**:

1. **Database & Migration Gate**:
   - [ ] Run `runDatabaseMigrations()` on target PostgreSQL 16 (or MariaDB 10.6+) instance; confirm all **32 `mkt_*` tables** + core tables exist and `FORCE ROW LEVEL SECURITY` (`NULLIF` policy) is active on PostgreSQL.
   - [ ] Verify legacy data reconciliation counts: `leads` (ex-`subscribers`), `mkt_web_properties` (ex-`web_tracking_sites`), `mkt_web_sessions` (ex-`web_visitors`), `blacklist_entries` where `entry_type='ip'` (ex-`web_blacklist`).
2. **Backend Typecheck & Automated Suites (`d:\GITHUB_SPACE\AUTO_DATA_TENANRT`)**:
   - [x] `npm run typecheck` -> Exit `0` (verified Wave 2B + Wave 2C `2026-11-21`)
   - [x] `npm test` -> **`328 pass / 0 fail`** across all root unit/integration suites (incl. `m1-marketing-core.test.ts`, `m2-channels-capi-compat.test.ts`, `rls-zero-leakage.test.ts`, `waveA-mariadb-and-cron.test.ts`, `master-cron-lock.test.ts`) + Tier 5 adversarial **`7/7 pass`** (Wave 2B)
   - [x] `npx tsx --test --test-concurrency=1 tests/e2e-marketing/*.e2e.test.ts` -> **`133/133 pass`** (`01`–`09` + `11`: `115/115` in Wave 2B; `10-browser-dual-mode-ui.e2e.test.ts`: **`11/11`** and `12-tier4-scenarios.e2e.test.ts`: **`7/7`** verified in Wave 2C `2026-11-21`)
3. **Frontend Typecheck & Production Bundle (`d:\GITHUB_SPACE\DOMATION_ERP_FULL`)**:
   - [x] `npx tsc -p tsconfig.app.json --noEmit` -> Exit `0` (verified Wave 2C `2026-11-21`)
   - [x] `npm test` -> **`25/25 pass / 0 fail`** (`m2-domain-cutover.test.mjs`, `m3-4-marketing-ui.test.mjs` with empty legacy allowlist, `ui-ux-overhaul-audit.test.mjs`)
   - [x] `npx vite build` -> Exit `0` (`2.05s`, zero Vite/CSS/chunk resolution errors)
4. **Dual-Mode Visual & Browser Verification (`docs/SCREENSHOT_COMPARISON_PLAN.md`)**:
   - [x] Ran `node scripts/compare_marketing_ui_screenshots.mjs --mode=all --spawn-backend --spawn-vite --mock-meta --out-dir=docs/screenshots/marketing-ui-comparison` covering CRM Auto (`/data`), Realtime Report (`/meta-report`), and Marketing Automation (Portal + Standalone, loading splash `B01`, white sidebar `B02`–`B04`, Quick Nav `B05`, Settings Upgrade `B06`, expanded Email `3xl` / ZNS `2xl` modals `D01`–`D02`, Zalo 4 tabs `D03`, measurement drawers `D04`–`D07`, and all 3 Spotlight Tours `D08`–`D10`) at `1440x900` and `390x844` (`E01`–`E08`): **`53/53` captured, `0` capture errors, `51/51` `DOMATION_ERP_FULL` captures PASS (`0` console/page/HTTP5xx errors)**; artifacts written to `docs/screenshots/marketing-ui-comparison/summary.md` & `audit-report.json`. *(1 external baseline check failed on untouched `DOMATION_LANDINGPAGE` `A03-ref-landing-meta-report` `Roboto` font.)*
5. **Production Runtime Cutover**:
   - [ ] Verify `OUTBOUND_SILENT_MODE=false` only after live SMTP/SES/ZNS/Meta vault credentials and webhook HMAC secrets are validated per tenant.
   - [ ] Schedule single Master Cron (`scripts/run-master-cron.sh` -> `/api/v1/operations/cron/master`) and retire legacy PHP `cron_master.php`.

---

### 4.4 Legacy Repository Retirement Matrix

| Legacy Repository / Component | Last Observed State | Legacy Artifacts & Tables | Unified Replacement Target | Retirement Action |
|---|---|---|---|---|
| **`DOMATION_FULLSTACK`** *(+ unversioned `DOMATION_FULLDEMO`)* | `2026-10-16` (React 19.2.3 + purple CDN Tailwind + PHP `api/` + MySQL `db_schema.json`: `subscribers`, `web_tracking_sites`, `web_visitors`, `web_blacklist`) | Standalone PHP/MySQL Marketing Automation app (`Flows.tsx`, `Campaigns.tsx`, `/mail_api`) | `DOMATION_ERP_FULL` (`isMarketingStandalone = true`, `src/pages/marketing/*`) + `AUTO_DATA_TENANRT` (`32 mkt_*` + `leads` + `tenant_audiences` + `blacklist_entries`) | Migrate tenant data -> canonical tables per Section 3, switch DNS/reverse proxy to `DOMATION_ERP_FULL` + `AUTO_DATA_TENANRT`, archive repo read-only. |
| **`MYERP` (`backend/automation/*` PHP)** | `2026-11-18` (React + dark-red `#e11d48` + PHP `unified_schema.sql`: `email_otps`, `marketing_campaigns`, `workflows`, `zalo_queue`) | Legacy PHP scripts (`survey_public.php`, `voucher_claim.php`, `flows.php`, `campaigns.php`, `ai_training.php`, `cron_master.php`) | `AUTO_DATA_TENANRT/server/routes/myerp-compat/{marketing-config.ts,marketing-php-bridges.ts}` + native `/api/v1/marketing/*` + `master-cron.ts` | Route `/api/v1/myerp/automation/*` exclusively to `AUTO_DATA_TENANRT`; decommission PHP `backend/automation/*.php` & `cron_master.php`. |
| **`DOMATION_META` & `DOM-MARKETING`** | `2026-11-13` / `2026-11-17` (Static HTML/JS + Apps Script) | Standalone Meta/Google Ads dashboards | `AUTO_DATA_TENANRT/server/services/dom-meta-report.service.ts` + `DOMATION_ERP_FULL/src/pages/DomMetaReportPage.tsx` | Route `/meta-report` through unified portal + backend `/api/v1/dom-meta/*`; deprecate standalone static HTML copies. |
| **`DATA` / `DATA-ECOLIFE` / `CRM`** | `2026-06`–`2026-07` / unversioned | Legacy single-tenant CRM & EcoLife SQL dumps | `AUTO_DATA_TENANRT` (`leads`, `distribution_rounds`, `capi_logs`, `scripts/seed-ecolife-myerp-vivid.ts`) | Retain as read-only archival backup; guard missing external SQL dumps cleanly in automated test suites. |


---

## Final Cutover, Inline Tour Icon & `/automation` Landing Redesign (Completed 2026-11-21)

1. **MYERP -> DOMATION Cutover & Data Parity (`AUTO_DATA_TENANRT` + `DOMATION_ERP_FULL`)**:
   - Copied `102` `.webp` template thumbnails to `d:\GITHUB_SPACE\AUTO_DATA_TENANRT\public\uploads\template_thumbs\` with read-only `/uploads` serving (`server/app.ts`, `server/middleware/anti-agent-guard.ts`) and Vite proxy `/uploads` & `/uploadss` (`DOMATION_ERP_FULL/vite.config.ts`).
   - Added public SVG countdown timer endpoint `GET /api/v1/public/marketing/timer` (`server/modules/marketing-public/index.ts`, `server/modules/marketing/utils.ts`).
   - Updated `scripts/migrate-myerp-ideas.ts` & `scripts/prepare-myerp-showcase-db.ts` (`DEFAULT_CRM_URL = 'https://erp.domation.net'`, `remapFlowTriggerAndSteps`, junk media cleanup, tenant `ideas` F8 `zalo_bot_disabled=true` preservation).
   - Fixed `{ items }` envelope unwrapping across `EmailActionConfig.tsx` & `AutomationFlowsPage.tsx`, and eliminated legacy `.php` / `open.automation.net` / `crm.domation.net` references in `DOMATION_ERP_FULL`.
   - Verification:
     - `AUTO_DATA_TENANRT`: `npm run typecheck` (exit `0`), `npx tsx --test tests/myerp-ideas-migration.test.ts tests/m1-marketing-core.test.ts` (`18/18` pass, `4` suites, `0` fail, `0` skipped).
     - `DOMATION_ERP_FULL`: `npx tsc --noEmit` (exit `0`), `npm test` (`34/34` pass, `8` suites, `0` fail, `0` skipped).

2. **Compact Inline Spotlight Tour Launcher (`DOMATION_ERP_FULL`)**:
   - Converted the Spotlight Tour trigger into `<MktTourIconButton inline />` (`36x36` square icon button via `MktTourSlotContext` in `MktLayout.tsx`), rendered inline in `PageHero.tsx` (`.header-actions`) and `MarketingDashboardPage.tsx` (beside `Làm mới`).
   - Verified `36x36` dimensions on both `/marketing/flows` (`ideas` Portal) and `/marketing` (`ideas-showcase-standalone` Standalone).

3. **`/automation` Landing Page Redesign (`DOMATION_LANDINGPAGE`)**:
   - Populated `public/imgs/automation/` (`28` PNG files) and created modular components (`src/components/automation/{automationShowcaseData.ts, AutomationInteractiveStage.tsx, AutomationFlowSimulator.tsx, AutomationAnalyticsAiSection.tsx, AutomationGallerySection.tsx, AutomationModeComparisonSection.tsx}`), rebuilding `src/App.tsx` (`/automation`).
   - Fixed `.ql-eyebrow` mobile wrapping in `src/App.tsx` (`DOMATION MARKETING • ĐỘC LẬP HOẶC ERP`) so `390x844` has `scrollWidth = 390` and zero horizontal clipping.
   - Verification: `npx tsc -b` & `npx vite build --outDir .vite-verify-dist` (exit `0`, `2670` modules transformed, `.vite-verify-dist` cleaned); live Puppeteer check on `http://127.0.0.1:5175/automation` (`0` console/page/broken-image errors at `1440x900` & `390x844`).
