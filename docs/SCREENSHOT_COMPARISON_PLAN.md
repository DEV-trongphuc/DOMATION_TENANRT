# Local UI/UX Screenshot Comparison Plan
## CRM Auto, Realtime Report & Dual-Mode Marketing Automation

**Document ID**: `PLAN-M4-UIUX-COMPARE-001`  
**Milestone**: M4-Prep -> M4 Visual Verification & M5 Final Acceptance  
**Requirement Mapping**: R3 (UI/UX Synchronization, Automation Refresh, Expanded Email Modal, Optimized ZNS UI, Focus Tours), R4 (Local Screenshot Comparison), Follow-up `2026-11-20T08:36:33Z` (Landing BG Loading Screen + Domation SVG Decor), Follow-up `2026-11-20T09:10:30Z` (Red + Royal Sapphire Palette across Marketing & ERP, White/Light Sidebar & UI, Upgrade CTA in Settings, Normal AppIcons, Date Range Filter, Synced Animations)  
**Companion Harness**: `scripts/compare_marketing_ui_screenshots.mjs`  
**Reference Spec**: `docs/ONBOARDING_UI_UX_SPEC.md` (`SPEC-UIUX-003`) & `tests/e2e-marketing/10-browser-dual-mode-ui.e2e.test.ts`

---

## 1. Comparison Objectives & Local Architecture Matrix

### 1.1 Objectives
This plan defines the deterministic visual, structural, and runtime comparison protocol used on the local environment to prove 1:1 UI/UX parity across:
1. **CRM Auto (Reference Surface)**: `DOMATION_LANDINGPAGE` (`/data` -> `DomationDataLanding.tsx` -> `AutodataClonedRoot.tsx`) and `DOMATION_ERP_FULL` (`/data` -> `DataList.tsx`).
2. **Realtime Report (Reference Surface)**: `DOMATION_LANDINGPAGE` (`/meta-report` -> `MetaAdReport.tsx` -> `DomMetaReportWorkspace.tsx`) and `DOMATION_ERP_FULL` (`/meta-report` & `/marketing/meta-report` -> `DomMetaReportPage.tsx`).
3. **Marketing Automation (Portal-Embedded Mode — `domation_promax`)**: All 13 Marketing Automation routes (`/marketing`, `/marketing/flows`, `/marketing/campaigns`, `/marketing/templates`, `/marketing/audience`, `/marketing/surveys`, `/marketing/vouchers`, `/marketing/social-bot`, `/marketing/ai-training`, `/marketing/web-tracking`, `/marketing/api-triggers`, `/marketing/meta-report`, `/marketing/capi`), plus ERP shell surfaces (`Sidebar`, `Header` Quick-Nav, `Settings`).
4. **Marketing Automation (Standalone Mode — `marketing_standalone`)**: Isolated single-purpose workspace (`/` renders `MarketingDashboardPage` inside `.mkt-scope`, `Sidebar` scopes to `MARKETING AUTOMATION` + `CÀI ĐẶT HỆ THỐNG`, `Header` displays `'Standalone • Marketing'`, CRM routes redirect cleanly to `/marketing`), sharing the exact same `AUTO_DATA_TENANRT` backend and database.

### 1.2 Local Environment Topology & Process Isolation Rules

| Layer | Repository / Service | Local Port / Origin | Startup Mechanism | Notes & Isolation Rules |
|---|---|---|---|---|
| **Backend API & DB** | `d:\GITHUB_SPACE\AUTO_DATA_TENANRT` | `http://127.0.0.1:3100` (or ephemeral `127.0.0.1:<free>`) | Existing local backend (`:3100`) OR `--spawn-backend` (in-memory PGlite + Express via `tsx` wrapper of `tests/e2e-marketing/_harness.ts`) | Never point local UI audits at legacy port `:3199`. Mock/sandbox outbound Zalo ZNS, Meta Graph, SMTP/Resend, Gemini endpoints when running `--spawn-backend`. |
| **Target Frontend (Portal + Standalone)** | `d:\GITHUB_SPACE\DOMATION_ERP_FULL` | `http://127.0.0.1:5174` (or ephemeral `--strictPort`) | Spawned directly via `node node_modules/vite/bin/vite.js --port <free> --host 127.0.0.1 --strictPort` with `VITE_API_ORIGIN=<apiUrl>` | **NEVER** invoke `sync-unified-shared.cjs` or destructive git commands. Note: `vite.config.ts` `versionManifestPlugin()` touches `public/version.json` & `public/sw.js` on `buildStart()`. |
| **Reference Frontend (Landing / CRM / Meta)** | `d:\GITHUB_SPACE\DOMATION_LANDINGPAGE` | `http://127.0.0.1:5173` (or ephemeral `--strictPort`) | Existing `:5173` OR spawned `node_modules/vite/bin/vite.js` with `AUTODATA_API_URL=<apiUrl>` | `/meta-report` supports `window.__DOM_META_PREVIEW__` + `--mock-meta` route interception so reference charts render deterministically without live Meta Ads credentials. |
| **Browser Engine** | System Chrome / Edge (`puppeteer ^25.18.1`) | Headless / Headed via CDP | `resolveBrowserExecutable()` (`--chrome-path` -> `CHROME_PATH` -> `PUPPETEER_EXECUTABLE_PATH` -> `CHROME_BIN` -> Windows `chrome.exe` / `msedge.exe`) | **MUST** pass explicit `executablePath` to `puppeteer.launch()` to avoid Windows cached Chromium `spawn UNKNOWN` errors. Clean up Vite/Chrome trees via `taskkill /pid <pid> /f /t` on `win32`. |

### 1.3 Deterministic Output Contract (`scripts/compare_marketing_ui_screenshots.mjs`)
- **Default Output Directory**: `docs/screenshots/marketing-ui-comparison/` (overridable via `--out-dir=<path>`).
- **Viewports**:
  - Desktop: `1440x900` (`deviceScaleFactor: 1`)
  - Mobile: `390x844` (`deviceScaleFactor: 1`, `isMobile: true`, `hasTouch: true`)
- **Path Convention**: `<outDir>/<viewport>/<capture-id>.png`
  - Examples: `docs/screenshots/marketing-ui-comparison/1440x900/A01-ref-landing-data.png`, `docs/screenshots/marketing-ui-comparison/390x844/E01-mobile-ref-data.png`.
- **Machine & Human Artifacts**:
  - `<outDir>/audit-report.json` — Structured per-capture metadata, DOM/CSS/runtime/overflow check results (`pass` / `fail` / `skip`), and summary counts.
  - `<outDir>/summary.md` — Side-by-side comparison markdown report summarizing paired baselines, check failures, and visual review links.

---

## 2. Design System & User-Feedback Parity Rubric

Every captured surface is audited against both the canonical Royal Sapphire design system (`docs/ONBOARDING_UI_UX_SPEC.md`, `DOMATION_LANDINGPAGE/src/index.css`) and the mid-run user feedback items (`2026-11-20T08:36:33Z` and `2026-11-20T09:10:30Z`).

### 2.1 Typography (`Be Vietnam Pro`, `Fira Code`, `tabular-nums`)
| Check | Canonical Token / Value | Source Reference | Verification Rule |
|---|---|---|---|
| **Primary UI Font** | `'Be Vietnam Pro', 'Inter', -apple-system, BlinkMacSystemFont, sans-serif` | `DOMATION_ERP_FULL/index.html:29`, `src/index.css:690` | `getComputedStyle(document.body).fontFamily` and visible `main .mkt-scope` `fontFamily` must include `be vietnam pro`. |
| **Meta Report Scoped Font** | `'Be Vietnam Pro'` (syncing `.dom-meta-scope` with portal) | `DOMATION_ERP_FULL/src/index.css:7785-7810`, `10-browser-dual-mode-ui.e2e.test.ts:1070-1076` | **M4 Execution Check (Pre-M3.4 Flagged Item)**: `src/index.css:7806-7808` currently sets `'Roboto', 'Inter'` on `.dom-meta-scope`. M4 live comparison MUST assert visible `main .dom-meta-scope` and its `h1/h2` resolve to `Be Vietnam Pro` once M3.4 lands. |
| **Monospace / Codes / Slugs** | `'Fira Code', ui-monospace, SFMono-Regular, monospace` | `src/index.css:692`, `PublicVoucherClaimPage.tsx` | Voucher codes, API keys, webhook endpoints, and `tabular-nums` badges use monospace / tabular alignment. |
| **Numeric Alignment** | `font-variant-numeric: lining-nums tabular-nums` | `ONBOARDING_UI_UX_SPEC.md:82-88`, `src/index.css:7582` | `.mkt-scope` computed `fontVariantNumeric` includes `tabular-nums` so KPIs, CTRs, and timestamps align vertically. |

### 2.2 Color Palette (Royal Sapphire + Red Accent across Marketing & ERP, Zero Legacy Purple)
| Token / Role | Hex / RGB Value | Source Reference | Where Verified |
|---|---|---|---|
| **Canvas** | `#F8F9FA` (`--color-bg`, `--surface-canvas`) | `src/index.css:693, 731` | App canvas background across `/data`, `/meta-report`, `/marketing/*` |
| **Surface & Card** | `#FFFFFF` (`--color-surface`, `--surface-card`) | `src/index.css:694, 734` | Cards, drawers, modals, sidebars |
| **Border & Muted** | `#E2E8F0` (`--color-border`), `#F1F5F9` (`--color-bg-secondary`) | `src/index.css:732, 735` | Hairline 1px borders and secondary containers |
| **Primary Text** | `#0F172A` (`--color-text`), Muted `#64748B` | `src/index.css:737, 739` | High-contrast Slate-900 labels and headings |
| **Royal Sapphire Primary** | `#1E40FF` (`rgb(30, 64, 255)`), Hover `#1D4ED8`, Sky/Cyan `#0284C7` / `#06B6D4` | `src/index.css:697-701, 719-720` | Primary CTAs, active tabs, focus rings, silk waves |
| **Red Accent (Marketing AND ERP)** | `#EF4444` (`--color-red`), `#DC2626` (`--color-red-strong`, `--color-danger`), `#E11D48` (`--color-rose`) | `src/index.css:702-706, 751`; `Header.tsx:2783-2816`; `AppIcons.tsx`; `Settings.tsx:2672-2860`; `StepEditor.tsx:139` | Present in **both** Marketing (`Chiến dịch`, `API & Webhook`, `Voucher`, `Khảo sát`, `email_campaigns` icon, `remove_action` header, `Nâng cấp gói` CTA) **and** ERP (`Ticket`, `Helpdesk`, `AI Pre-screener`, `Báo cáo`, `Quy trình`, `Phê duyệt` in `Header.tsx` `Menu điều hướng nhanh` `PALETTE.red`/`PALETTE.rose`). |
| **Zero Legacy Purple** | No `rgb(124, 58, 237)` / `rgb(139, 92, 246)` / Tailwind `purple-*`/`violet-*`/`fuchsia-*`/`indigo-*` | `10-browser-dual-mode-ui.e2e.test.ts:1165-1176` | Automated CSS scan checks visible buttons/links inside `.mkt-scope` for zero legacy purple hues. |

### 2.3 Loading Screen (Follow-up `08:36Z`)
- **Pre-hydration HTML Splash (`#ideas-splash-screen`)**: `DOMATION_ERP_FULL/index.html:66-280`.
  - Uses `<picture class="splash-bg-picture">` loading `/imgs/landing/fluent-brand-ambient-bg.webp` / `.jpg` (`opacity: 0.58`), `.splash-veil-white`, `.splash-veil-radial`, 2-path `<svg class="splash-silk-svg" viewBox="0 0 1440 500">` (`#1E40FF` & `#06B6D4`), and frosted glass `.splash-content` (`DOMATION Suite / ENTERPRISE ECOSYSTEM` + smooth gradient indeterminate bar).
- **React Suspense / Auth Loader (`DomationProgressLoader`)**: `DOMATION_ERP_FULL/src/components/common/DomationProgressLoader.tsx:17-101`.
  - Mirrors `#ideas-splash-screen` 1:1 (`role="status" aria-busy="true"`, same landing background `<picture>`, radial veil, 2-path `viewBox="0 0 1440 500"` SVG, and frosted glass card).
- **Check**: Asset HTTP status `200` for `/imgs/landing/fluent-brand-ambient-bg.{webp,jpg}`; `#ideas-splash-screen` fades out cleanly after hydration (`opacity: 0`, `visibility: hidden`).

### 2.4 Architectural Domation SVG Decor (Follow-up `08:36Z`)
- **CRM Auto Reference**: `DOMATION_LANDINGPAGE/src/components/autodata/cloned/components/ui/LuxuryBackgroundDecor.tsx:8-31` (`.ql-luxury-decor-layer`, `.ql-brochure-frame-decor` `+` crosshairs, 3-path `.ql-silk-wave-decor` SVG, `<DomationLogoMark />` watermarks).
- **Unified Portal & Marketing Shell**: `DOMATION_ERP_FULL/src/components/Layout/Layout.tsx:940-1018` renders `.dom-meta-app-canvas` with `.dom-meta-brochure-frame` (`span.dom-frame-cross.bl` / `.br` `+` crosshairs), 3-path silk SVG (`viewBox="0 0 1440 500"`), and two corner `<DomationLogoMark />` watermarks (`250px` top-left, `230px` bottom-right). `DomationDecor.tsx:12-21` intentionally avoids duplicating per-page backdrops when the global shell layer is active.

### 2.5 White/Light Sidebar, Header, Animations, Normal AppIcons, Date Filter & Settings Upgrade (Follow-up `09:10Z`)
1. **White/Light Sidebar (`aside.responsive-sidebar`)**:
   - `DOMATION_ERP_FULL/src/components/Layout/Sidebar.tsx:787-805`: `background: var(--sidebar-bg, linear-gradient(180deg, #FFFFFF 0%, #F8FAFF 55%, #F1F5F9 100%))`, `width: effectiveCollapsed ? 72 : 260`, `transition: width 0.3s cubic-bezier(0.16, 1, 0.3, 1), background-color 0.2s ease`.
   - Zero dark navy/black background stops (`r < 120 && g < 120 && b < 120 && a >= 0.5` is FALSE); at least one light stop (`r >= 220 && g >= 220 && b >= 220 && a >= 0.7` is TRUE); dark readable inactive nav text (`r,g,b < 130`).
   - Non-zero `transitionDuration` on `aside.responsive-sidebar` and `a.sidebar-nav-item`.
2. **Zero Sidebar-Bottom Upgrade Widget**:
   - `Sidebar.tsx` MUST NOT contain `"STANDALONE MODE"`, truncated `"Marketing Stan..."`, or any `Nâng cấp` / `a[href*="package_upgrade"]` footer box.
3. **Upgrade Button Relocated to Settings**:
   - `DOMATION_ERP_FULL/src/pages/Settings.tsx:2669-2864`:
     - Top header CTA `[data-testid="settings-upgrade-cta"]` (`"Nâng cấp gói"`, red gradient `#DC2626 -> #EF4444`).
     - Quick-upgrade banner `[data-testid="settings-upgrade-banner"]` (shown when `isMarketingStandalone || packageCode !== 'domation_promax'`).
     - Dedicated `/settings?tab=package_upgrade` view (`PackageUpgradePanel.tsx`).
4. **Normal/Standard AppIcons (`AppIcons.tsx`)**:
   - `svg[viewBox="0 0 56 56"]` tiles render with square proportions (`Math.abs(w - h) <= 2`), bounded to `32..56px` inside `.mkt-scope` cards/quick-nav and `14..38px` inside `a.sidebar-nav-item`.
5. **Unified Date Range Filter**:
   - `DataList.tsx:2178-2194` (`[data-testid="erp-datalist-date-picker"]` / `[data-testid="open-date-picker"]`), `DomMetaReportWorkspace.tsx:3182` (`main [data-testid="open-date-picker"]`), `MarketingDashboardPage.tsx` & `MktDateRangeFilter` (`[data-testid="mkt-dashboard-date-picker"]` / `[data-testid="open-date-picker"]` -> clicking opens `[data-testid="unified-date-picker-popover"]`).

---

## 3. Complete Paired Screenshot Matrix (Desktop `1440x900` & Mobile `390x844`)

All captures save to `<outDir>/<viewport>/<capture-id>.png` (default `<outDir>` = `docs/screenshots/marketing-ui-comparison`).

### Group A — Reference Baselines (`1440x900`)
Compare canonical CRM Auto and Realtime Report baselines across `DOMATION_LANDINGPAGE` and `DOMATION_ERP_FULL`.

| Capture ID | Mode / Repo | Route / URL | Setup / Interaction | Parity Purpose & Reference Target |
|---|---|---|---|---|
| `A01-ref-landing-data` | `landing` (`DOMATION_LANDINGPAGE`) | `/data` | Wait for `DomationDataLanding` (or `AutodataClonedRoot` if `autodata_session_v2` seeded) ready | Canonical CRM Auto light theme, Royal Sapphire tokens, `LuxuryBackgroundDecor`, `Be Vietnam Pro` typography |
| `A02-ref-erp-data` | `portal` (`DOMATION_ERP_FULL`) | `/data` | Login as `domation_promax` admin; wait for `DataList.tsx` & `[data-testid="erp-datalist-date-picker"]` | ERP CRM Auto `/data` light sidebar, `DomUnifiedDatePicker`, `Layout.tsx` SVG decor |
| `A03-ref-landing-meta-report` | `landing` (`DOMATION_LANDINGPAGE`) | `/meta-report` | Inject `window.__DOM_META_PREVIEW__` + optional `--mock-meta` payload; wait for Recharts & `[data-testid="open-date-picker"]` | Canonical Realtime Report (`DomMetaReportWorkspace`) KPIs, heatmaps, light sidebar |
| `A04-ref-erp-meta-report` | `portal` (`DOMATION_ERP_FULL`) | `/meta-report` (also mirrors `/marketing/meta-report`) | Wait for `DomMetaReportPage.tsx` + `[data-testid="erp-meta-sidebar-subtabs"]` + `.dom-meta-scope` | Paired comparison against `A03`; verifies `.dom-meta-scope` `Be Vietnam Pro`, white sidebar sub-tabs, CAPI tab |

### Group B — Shell, Loading Screen, White Sidebar, Quick-Nav & Settings (`1440x900`)
Verify mid-run feedback fixes (`08:36Z` & `09:10Z`) across both Portal and Standalone shells.

| Capture ID | Mode / Repo | Route / State | Setup / Interaction | Parity Purpose & Reference Target |
|---|---|---|---|---|
| `B01-loading-splash` | `portal` (`DOMATION_ERP_FULL`) | `/` (pre-hydration / loader capture) | Capture `#ideas-splash-screen` before fade-out (via `DOMContentLoaded` pause or route-level `DomationProgressLoader` harness hook) | Landing BG image (`/imgs/landing/fluent-brand-ambient-bg.{webp,jpg}`), 2-path silk SVG, glass card (`DOMATION Suite`) |
| `B02-portal-white-sidebar-expanded` | `portal` (`DOMATION_ERP_FULL`) | `/marketing` | Desktop `1440x900`, sidebar expanded (`260px`) | Light gradient `aside.responsive-sidebar` matching `A01`/`A03`, active Royal Sapphire pill, normal icons |
| `B03-portal-white-sidebar-collapsed` | `portal` (`DOMATION_ERP_FULL`) | `/marketing` | Click `[data-testid="sidebar-collapse-toggle"]` / collapse button; wait `400ms` for CSS transition | Smooth width `260px -> 72px` animation, centered `36x36` icon tiles, zero clipped labels |
| `B04-standalone-white-sidebar` | `standalone` (`DOMATION_ERP_FULL`) | `/` | Register/login `marketing_standalone` tenant; wait for `MarketingDashboardPage` | White sidebar scoped to `MARKETING AUTOMATION` + `CÀI ĐẶT HỆ THỐNG`; **zero** bottom `"STANDALONE MODE / Nâng cấp"` widget |
| `B05-quick-nav-menu-red-sapphire` | `portal` (`DOMATION_ERP_FULL`) | `/marketing` + Quick-Nav Modal | Dispatch `open-quick-menu` event (or click sidebar logo); wait for `"Menu điều hướng nhanh"` modal | Red (`#DC2626`/`#E11D48`) + Royal Sapphire (`#1E40FF`) + Cyan/Emerald/Amber `PALETTE` across both Marketing & ERP items + normal `56x56` `AppIcon`s |
| `B06-settings-upgrade-cta` | `standalone` (`DOMATION_ERP_FULL`) | `/settings?tab=package_upgrade` | Open `/settings` first to verify `[data-testid="settings-upgrade-cta"]` & `[data-testid="settings-upgrade-banner"]`, then capture `?tab=package_upgrade` | Confirms `"Nâng cấp"` CTA & red-accented banner live cleanly in Settings (`Settings.tsx:2669-2864`) |

### Group C — Dual-Mode Core Marketing Pages: Portal (`C*p`) vs Standalone (`C*s`) (`1440x900`)
Every Marketing Automation page is captured in **both** `portal` (`domation_promax`, `p` suffix) and `standalone` (`marketing_standalone`, `s` suffix) to guarantee visual parity, zero `ErrorBoundary` / `AccessDeniedView`, zero horizontal overflow, and consistent design tokens.

| Pair ID | Portal Capture (`domation_promax`) | Standalone Capture (`marketing_standalone`) | Route(s) & Key Verified Elements |
|---|---|---|---|
| **C01** | `C01p-portal-marketing-dashboard` (`/marketing`) | `C01s-standalone-marketing-dashboard` (`/`) | `PageHero` (`"Marketing & Đa kênh"`), `[data-testid="erp-marketing-meta-strip"]`, `[data-testid="mkt-dashboard-date-picker"]`, `AppIcon` module grid |
| **C02** | `C02p-portal-flows-list` (`/marketing/flows`) | `C02s-standalone-flows-list` (`/marketing/flows`) | Refreshed Automation list (`StatCard` `"Tổng kịch bản"`, `"Tạo kịch bản"`, `MktDateRangeFilter`, Grid/List toggle) |
| **C02b** | `C02b-portal-flows-builder` (`/marketing/flows` -> open flow) | *(covered via `C02s` + `D01`/`D02`/`D05`)* | Full-screen Builder (`#mkt-portal-root`, `FlowHeader` `Thiết kế`/`Báo cáo`/`Cài đặt`, `FlowTree` `#step-node-*`) |
| **C03** | `C03p-portal-campaigns` (`/marketing/campaigns`) | `C03s-standalone-campaigns` (`/marketing/campaigns`) | Campaign KPIs, `MktDateRangeFilter`, campaign cards/table, status badges |
| **C04** | `C04p-portal-templates` (`/marketing/templates`) | `C04s-standalone-templates` (`/marketing/templates`) | Template groups, gallery cards, drag-drop `EmailEditor` preview |
| **C05** | `C05p-portal-audience` (`/marketing/audience`) | `C05s-standalone-audience` (`/marketing/audience`) | Tabs (`lists`, `segments`, `contacts`, `integrations`), Royal Sapphire pills, `tabular-nums` counts |
| **C06** | `C06p-portal-surveys` (`/marketing/surveys`) | `C06s-standalone-surveys` (`/marketing/surveys`) | Survey list/cards, status badges, `"Xem báo cáo"` trigger |
| **C07** | `C07p-portal-vouchers` (`/marketing/vouchers`) | `C07s-standalone-vouchers` (`/marketing/vouchers`) | `MktSegmented` (`vouchers` / `links-qr`), voucher campaign cards, QR preview |
| **C08** | `C08p-portal-social-bot` (`/marketing/social-bot`) | `C08s-standalone-social-bot` (`/marketing/social-bot`) | `PageHero`, 4 KPI cards (`#1E40FF`, `#0284C7`, `#0f172a`), Meta Messenger & Zalo OA & ZNS channel switcher |
| **C09** | `C09p-portal-ai-training` (`/marketing/ai-training`) | `C09s-standalone-ai-training` (`/marketing/ai-training`) | `AITrainingManager`, `ScenarioManager`, `InstructionSettings`, `UnifiedChat` |
| **C10** | `C10p-portal-web-tracking` (`/marketing/web-tracking`) | `C10s-standalone-web-tracking` (`/marketing/web-tracking`) | Website list, `overview`/`visitors`/`chat` tabs, SDK embed snippet (`Fira Code`) |
| **C11** | `C11p-portal-api-triggers` (`/marketing/api-triggers`) | `C11s-standalone-api-triggers` (`/marketing/api-triggers`) | `FormsTab`, `PurchasesTab`, `CustomEventsTab`, `OTPTriggersTab` |
| **C12** | `C12p-portal-capi` (`/marketing/capi`) | `C12s-standalone-capi` (`/capi`) | Meta CAPI logs, stage mapping, 7-day backfill, Lookalike audiences (**verify `.mkt-scope` wrapper**) |

### Group D — Expanded Modals, Optimized ZNS UI, Measurement Drawers & Focus Tours (`1440x900`)
Verify every R3 interactive modal, optimized ZNS workflow, analytics drawer, and SVG spotlight tour.

| Capture ID | Route | Interactive Trigger / State | Expected Visual & DOM Contract |
|---|---|---|---|
| `D01-modal-step-email-3xl` | `/marketing/flows` (Builder) | Click email node `#step-node-*` (`type === 'action'`) | `StepEditor.tsx:149` `size="3xl"` (`>= 768px` width, NOT `max-w-2xl`), 2-column `EmailActionConfig` (left config + merge-tag popover + `"Chọn Mẫu (Visual)"` / `"HTML Code"`; right desktop/mobile live preview), zero horizontal clipping |
| `D02-modal-step-zns-2xl` | `/marketing/flows` (Builder) | Click ZNS node (`type === 'zalo_zns'`) | `StepEditor.tsx:150` `size="2xl"`, optimized `ZaloZNSStepConfig` (OA selector, template picker, param merge-tag mapping, UID/phone cost tip) |
| `D03-zalo-oa-zns-tabs` | `/marketing/social-bot?channel=zalo` | Switch to `'Zalo OA & ZNS'` and step through `'Khách hàng Zalo'`, `'Kịch bản Zalo'`, `'Broadcast & ZBS'`, `'Mẫu tin ZNS'` (plus `ZaloSendZBSModal` if open) | All 4 sub-tabs render cleanly in `.mkt-scope`, Sapphire/Cyan accents, `tabular-nums`, zero console errors |
| `D04-drawer-campaign-detail` | `/marketing/campaigns` | Click seeded campaign to open `CampaignDetailDrawer` (`.campaign-detail-drawer`) | Displays `"Tỷ lệ mở"`/`"Tỷ lệ Xem"`, `"Tỷ lệ Click (CTR)"`, `"Phễu chuyển đổi"`, `LinkClicksTab`, `TechStatsTab` |
| `D05-tab-flow-analytics` | `/marketing/flows` (Builder) | Click `FlowHeader` `'Báo cáo'` tab (`FlowAnalyticsTab`) | Renders `"Hiệu suất vận hành"`, `"Hành trình Khách hàng"`, `MktDateRangeFilter`, bottleneck metrics |
| `D06-modal-step-participants` | `/marketing/flows` (Builder -> `Báo cáo`) | Click step metric count to open `StepParticipantsModal` | Tabs (`all_touched`, `waiting`, `opened`, `failed`, `unsubscribed`, `clicks`, `zns_*`) + participant rows + pagination |
| `D07-modal-survey-report` | `/marketing/surveys` | Click `button[title="Xem báo cáo"]` / `"Báo cáo"` -> `SurveyReportModal` | `MktDateRangeFilter`, Recharts response charts, question analytics, `tabular-nums` breakdown |
| `D08-tour-dom-meta-spotlight` | `/meta-report` | Click `button[data-testid="open-dom-meta-tour"]` | `div[role="dialog"][aria-modal="true"]`, `"BƯỚC 1 / 5"`, SVG `<mask>` spotlight cutout, `"Tiếp theo"`, `"Quay lại"`, `"Bỏ qua tour"` |
| `D09-tour-marketing-spotlight` | `/marketing` | Click `[data-testid="open-mkt-tour"]` or `"Tour Hướng Dẫn"` | `div[role="dialog"][aria-modal="true"]`, SVG `<mask>` spotlight over `[data-tour]` targets (`MarketingSpotlightTour`), `"Tiếp theo"`/`"Bước tiếp"`, `"Quay lại"`, `"Hoàn tất"`, `"Bỏ qua"`/`"Đóng"` |
| `D10-tour-erp-spotlight` | `/settings` | Click `"Tour Hướng Dẫn"` (`Settings.tsx:2696-2719`) | `ErpSpotlightTour` `div[role="dialog"][aria-modal="true"]` aligned visually with `D08` and `D09` |

### Group E — Mobile `390x844` Paired Comparisons
Confirm responsive parity, mobile navigation ergonomics, and zero horizontal overflow (`document.documentElement.scrollWidth <= 392`) across reference and target surfaces.

| Capture ID | Mode | Route / State | Key Mobile Parity Assertions |
|---|---|---|---|
| `E01-mobile-ref-data` | `portal` (`DOMATION_ERP_FULL`) | `/data` (`390x844`) | `scrollWidth <= 392`, responsive card/table view, `DomUnifiedDatePicker` fits cleanly |
| `E02-mobile-ref-meta-report` | `landing` / `portal` | `/meta-report` (`390x844`) | `scrollWidth <= 392`, KPI cards stack 2-col/1-col cleanly, charts fit viewport |
| `E03-mobile-portal-marketing-dashboard` | `portal` | `/marketing` (`390x844`) | `scrollWidth <= 392`, `MktStatGrid` 2-col responsive layout, readable `Be Vietnam Pro` |
| `E04-mobile-standalone-marketing-dashboard` | `standalone` | `/` (`390x844`) | `scrollWidth <= 392`, `MktPage` renders cleanly without clipped buttons |
| `E05-mobile-marketing-flows` | `portal` | `/marketing/flows` (`390x844`) | `scrollWidth <= 392`, horizontal toolbar strip (`mobile-horizontal-strip`) does not break page width |
| `E06-mobile-marketing-campaigns` | `portal` | `/marketing/campaigns` (`390x844`) | `scrollWidth <= 392`, campaign cards stack cleanly |
| `E07-mobile-marketing-social-bot` | `portal` | `/marketing/social-bot` (`390x844`) | `scrollWidth <= 392`, channel tabs & KPI grid fit cleanly |
| `E08-mobile-bottom-nav-quick-nav` | `portal` | `/marketing` (`390x844`) + click `button.mobile-menu-btn` | `.mobile-bottom-nav` visible, mobile quick-nav drawer opens inside `390px` width without overflow, closes on `Escape` |

---

## 4. Automated Verification Checks, Visual Inspection Rubric & Execution Runbook

### 4.1 Automated Checks Recorded in `<outDir>/audit-report.json`
Each capture executes non-destructive DOM, computed-style, layout, and runtime diagnostics matching `tests/e2e-marketing/10-browser-dual-mode-ui.e2e.test.ts` and writes structured check entries `{ id, status: 'pass'|'fail'|'skip', actual, expected, detail }`:

| Check ID | Category | Deterministic Assertion |
|---|---|---|
| `runtime_clean` | Console & Network | `consoleErrors === 0`, `pageErrors === 0`, `http5xxErrors === 0`, `requestFailedErrors === 0`, `.php` `404`/`501` count `=== 0`, legacy `:3199` request count `=== 0`. |
| `route_guard_clean` | Auth & ErrorBoundary | `<main>` `innerText.length > 40`; zero `'Không có quyền truy cập'`, `'Đã xảy ra lỗi'`, `'Đã xảy ra sự cố'`, `'Không thể tải nội dung này'`. |
| `splash_landing_bg` | Loading Screen (`08:36Z`) | `#ideas-splash-screen` `<picture>` / `<img src>` references `fluent-brand-ambient-bg`; asset returns HTTP `200`; splash dismisses after hydration (`opacity === 0` or hidden). |
| `dom_svg_decor_present` | Architectural Decor (`08:36Z`) | Visible non-icon decor SVGs (`viewBox` matching `1440 500`, `1440 260`, `280 96`, `64 64`, `80 80`, `48 48`) present in `.dom-meta-app-canvas` / `main .mkt-scope`. |
| `typography_be_vietnam_pro` | Typography | `document.body`, visible `main .mkt-scope`, and visible `main .dom-meta-scope` (`+ h1/h2`) `fontFamily` includes `'be vietnam pro'`; `.mkt-scope` `fontVariantNumeric` includes `'tabular-nums'`. |
| `palette_sapphire_red_no_purple` | Palette (`09:10Z`) | `:root --color-primary === '#1e40ff'`, `--color-danger` in `['#dc2626', '#ef4444']`, `--color-bg === '#f8f9fa'`; Red accent (`r >= 200 && g <= 80 && b <= 90`) present in `.mkt-scope` and ERP Quick-Nav; zero legacy purple (`rgb(124, 58, 237)` / `rgb(139, 92, 246)`) on visible `.mkt-scope` buttons/links. |
| `sidebar_light_animated_clean` | White Sidebar (`09:10Z`) | `aside.responsive-sidebar`: zero dark background stops (`r,g,b < 120 && a >= 0.5`), `>= 1` light stop (`r,g,b >= 220 && a >= 0.7`), `transitionDuration > 0`, inactive text `r,g,b < 130`, zero `"STANDALONE MODE"` / `"Nâng cấp"` footer box. |
| `settings_upgrade_relocated` | Settings Upgrade (`09:10Z`) | `/settings`: `[data-testid="settings-upgrade-cta"]` & `[data-testid="settings-upgrade-banner"]` visible in `marketing_standalone` / non-`domation_promax`. |
| `standard_app_icons` | AppIcons (`09:10Z`) | `a.sidebar-nav-item svg` (`14..38px`) and `main .mkt-scope svg[viewBox="0 0 56 56"]` (`32..56px`) maintain `Math.abs(w - h) <= 2`. |
| `date_range_filter_present` | Date Filter (`09:10Z`) | `[data-testid="erp-datalist-date-picker"]` (`/data`), `main [data-testid="open-date-picker"]` (`/meta-report`), `[data-testid="mkt-dashboard-date-picker"]` (`/marketing`) visible and opens `[data-testid="unified-date-picker-popover"]`. |
| `modal_zns_drawer_tour_contracts` | R3 Components | `StepEditor` email modal width `>= 768px` (no `max-w-2xl`), `Zalo OA & ZNS` 4 sub-tabs present, `CampaignDetailDrawer` metrics present, `FlowAnalyticsTab` `'Hiệu suất vận hành'` & `'Hành trình Khách hàng'` present, `DomMetaSpotlightTour` & `MarketingSpotlightTour` render `div[role="dialog"][aria-modal="true"]` with Next/Back/Finish/Skip. |
| `viewport_no_horizontal_overflow` | Layout Stability | `document.documentElement.scrollWidth <= window.innerWidth + 2` at both `1440x900` and `390x844`. |

### 4.2 Known Pre-M3.4 Items to Verify Explicitly at M4 Live Execution
Per `TEST_READY.md` and direct source inspection of `DOMATION_ERP_FULL`, three M3.4 items were still pending landing on disk at M4-Prep time and **must** pass once M3.4 completes:
1. **`.dom-meta-scope` font family** (`DOMATION_ERP_FULL/src/index.css:7806-7808`): Must switch from `'Roboto', 'Inter'` to `'Be Vietnam Pro', 'Inter'` so `A04-ref-erp-meta-report` matches `A01`/`C01p` and passes `typography_be_vietnam_pro`.
2. **`/capi` & `/marketing/capi` `.mkt-scope` wrapper** (`DOMATION_ERP_FULL/src/App.tsx:438-443`): Must wrap `<CapiPage />` inside `<div className="mkt-scope">` so `C12p`/`C12s` inherit Marketing Automation typography, palette, and `tabular-nums`.
3. **`MarketingSpotlightTour`** (`DOMATION_ERP_FULL/src/components/marketing/components/tour/` + `MktLayout.tsx`): Must provide `[data-testid="open-mkt-tour"]` / `"Tour Hướng Dẫn"` + `[data-tour]` targets + `div[role="dialog"][aria-modal="true"]` so `D09-tour-marketing-spotlight` captures cleanly.

### 4.3 Human Visual Inspection Rubric (Side-by-Side Review of `summary.md` & PNG Pairs)
After automated capture finishes, reviewers inspect paired PNGs (`A01` vs `A02`, `A03` vs `A04`, `B02` vs `B04`, `C01p` vs `C01s` .. `C12p` vs `C12s`, `D08` vs `D09` vs `D10`, `E01`..`E08`) against:
1. **Visual Cohesion**: Light `#F8F9FA` canvas, crisp `#FFFFFF` cards, Royal Sapphire + Red semantic accents, and subtle Domation silk-wave SVG decor look unified between `/data`, `/meta-report`, and `/marketing/*` without visual jarring.
2. **Vietnamese Diacritics & Typography**: No fallback to system Times/Arial/Roboto in headings; crisp `Be Vietnam Pro` diacritics (`ế`, `ộ`, `ư`, `đ`, `ă`) and vertically aligned `tabular-nums` metrics.
3. **Zero Truncation or Overlap**: No `"Marketing Stan..."` ellipsis clipping in sidebar, no overlapping chart legends in Recharts (`A03`/`A04`/`D07`), no clipped preview columns in `D01-modal-step-email-3xl` or `D02-modal-step-zns-2xl`.
4. **Modal & Drawer Hierarchy**: Backdrop blur/dimming (`--shadow-modal`), crisp close buttons, clear active tab indicators, and smooth spotlight mask framing on `D08`–`D10`.

### 4.4 Execution Runbook (`scripts/compare_marketing_ui_screenshots.mjs`)

1. **Syntax & Dry-Run Preflight (Safe anytime, zero browser/Vite launch)**:
   ```bash
   node --check scripts/compare_marketing_ui_screenshots.mjs
   node scripts/compare_marketing_ui_screenshots.mjs --help
   node scripts/compare_marketing_ui_screenshots.mjs --dry-run --mode=all --out-dir=docs/screenshots/marketing-ui-comparison
   ```

2. **Self-Contained Ephemeral Run (No pre-started servers required; ideal for CI / M4 verification)**:
   ```bash
   node scripts/compare_marketing_ui_screenshots.mjs --mode=all --spawn-backend --spawn-vite --mock-meta --out-dir=docs/screenshots/marketing-ui-comparison
   ```

3. **Run Against Running Local Stack (`AUTO_DATA_TENANRT :3100`, `DOMATION_ERP_FULL :5174`, `DOMATION_LANDINGPAGE :5173`)**:
   ```bash
   node scripts/compare_marketing_ui_screenshots.mjs --mode=all --api-url=http://127.0.0.1:3100 --erp-url=http://127.0.0.1:5174 --landing-url=http://127.0.0.1:5173 --mock-meta --out-dir=docs/screenshots/marketing-ui-comparison
   ```

4. **Strict Acceptance Gate (Fails exit code `1` on any DOM, CSS, console, overflow, or M3.4 parity violation)**:
   ```bash
   node scripts/compare_marketing_ui_screenshots.mjs --mode=all --spawn-backend --spawn-vite --mock-meta --strict --out-dir=docs/screenshots/marketing-ui-comparison
   ```

5. **Targeted Subsets (Quick Re-Check of Mobile or Portal-Only Changes)**:
   ```bash
   node scripts/compare_marketing_ui_screenshots.mjs --mode=portal --viewports=1440x900,390x844 --routes=/data,/meta-report,/marketing,/marketing/flows --spawn-backend --spawn-vite --out-dir=docs/screenshots/marketing-ui-comparison
   ```

6. **Post-Run Verification Checklist**:
   - Inspect `<outDir>/summary.md` and `<outDir>/audit-report.json` (`summary.failed === 0` in `--strict` M4/M5 gate).
   - Confirm paired PNGs exist under `docs/screenshots/marketing-ui-comparison/1440x900/` and `docs/screenshots/marketing-ui-comparison/390x844/`.
   - Confirm `git status` in `DOMATION_ERP_FULL` shows zero unintended edits from `sync-unified-shared.cjs`, and zero orphaned Chrome/Vite background processes remain.
