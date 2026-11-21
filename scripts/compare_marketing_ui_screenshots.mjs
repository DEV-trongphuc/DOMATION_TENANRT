#!/usr/bin/env node
/**
 * Local Paired UI/UX Screenshot Comparison & Automated DOM/Style Audit Harness
 *
 * Plan ID: PLAN-M4-UIUX-COMPARE-001 (docs/SCREENSHOT_COMPARISON_PLAN.md)
 *
 * Captures paired desktop (1440x900) and mobile (390x844) screenshots across:
 *   - Group A: Reference Baselines (DOMATION_LANDINGPAGE & DOMATION_ERP_FULL /data, /meta-report)
 *   - Group B: Shell, Loading Splash, White Sidebar (Expanded/Collapsed/Standalone), Quick-Nav & Settings
 *   - Group C: Dual-Mode Marketing Pages (Portal domation_promax vs Standalone marketing_standalone)
 *   - Group D: Expanded Modals (Email 3xl, ZNS 2xl), Zalo OA/ZNS 4 Tabs, Drawers & Spotlight Tours
 *   - Group E: Mobile 390x844 Responsive Parity & Overflow Verification
 *
 * Produces:
 *   - <outDir>/<viewport>/<capture-id>.png
 *   - <outDir>/audit-report.json  (all 12 automated checks per capture + aggregate summary)
 *   - <outDir>/summary.md         (Markdown side-by-side visual comparison & pass/fail matrix)
 *
 * Process Isolation & Safety Notes:
 *   - Uses explicit System Chrome/Edge executablePath in puppeteer.launch() to avoid Windows
 *     cached Chromium spawn UNKNOWN errors.
 *   - Spawns Vite directly via `node <repo>/node_modules/vite/bin/vite.js --port <free> --host 127.0.0.1 --strictPort`
 *     with VITE_API_ORIGIN / AUTODATA_API_URL. NEVER invokes `npm run dev` or `sync-unified-shared.cjs`.
 *   - Note: DOMATION_ERP_FULL/vite.config.ts `versionManifestPlugin()` stamps public/version.json and
 *     public/sw.js on Vite `buildStart()` when spawning DOMATION_ERP_FULL Vite.
 *   - Cleans up Puppeteer browser and spawned child process trees (`taskkill /pid <pid> /f /t` on win32)
 *     in `finally` and on SIGINT/SIGTERM so zero orphan node/chrome processes remain.
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { execFile, spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import puppeteer from 'puppeteer';

const execFileAsync = promisify(execFile);

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '..');

const DEFAULT_OUT_DIR = 'docs/screenshots/marketing-ui-comparison';
const DEFAULT_BACKEND_URL = 'http://127.0.0.1:3100';
const DEFAULT_ERP_URL = 'http://127.0.0.1:5174';
const DEFAULT_LANDING_URL = 'http://127.0.0.1:5173';
const DEFAULT_VIEWPORTS_RAW = '1440x900,390x844';
const DEFAULT_TIMEOUT_MS = 30_000;

const VALID_MODES = new Set(['all', 'portal', 'standalone', 'reference', 'landing', 'erp', 'zalo_demo']);

const ALL_CHECK_IDS = [
  'runtime_clean',
  'route_guard_clean',
  'splash_landing_bg',
  'dom_svg_decor_present',
  'typography_be_vietnam_pro',
  'palette_sapphire_red_no_purple',
  'sidebar_light_animated_clean',
  'settings_upgrade_relocated',
  'standard_app_icons',
  'date_range_filter_present',
  'modal_zns_drawer_tour_contracts',
  'viewport_no_horizontal_overflow',
];

const AUDIT_CHECK_META = {
  runtime_clean: {
    category: 'Console & Network',
    expected: '0 consoleErrors, 0 pageErrors, 0 http5xx, 0 requestFailed, 0 .php 404/501, 0 legacy :3199 requests',
  },
  route_guard_clean: {
    category: 'Auth & ErrorBoundary',
    expected: '<main> text > 40 chars, no AccessDeniedView/ErrorBoundary text, no unexpected /login redirect',
  },
  splash_landing_bg: {
    category: 'Loading Screen (08:36Z)',
    expected: '#ideas-splash-screen references fluent-brand-ambient-bg (HTTP 200) and fades cleanly after hydration',
  },
  dom_svg_decor_present: {
    category: 'Architectural Decor (08:36Z)',
    expected: '>= 1 visible non-icon Domation SVG decor accent in .dom-meta-app-canvas / .mkt-scope / .ql-luxury-decor-layer',
  },
  typography_be_vietnam_pro: {
    category: 'Typography',
    expected: 'Be Vietnam Pro on body, active .mkt-scope (+ tabular-nums), and .dom-meta-scope (+ h1/h2)',
  },
  palette_sapphire_red_no_purple: {
    category: 'Palette (09:10Z)',
    expected: 'Royal Sapphire #1e40ff, Red accent #dc2626/#ef4444 in Marketing & ERP, Canvas #f8f9fa, zero legacy purple',
  },
  sidebar_light_animated_clean: {
    category: 'White Sidebar (09:10Z)',
    expected: 'Light gradient sidebar (no dark stops), transitionDuration > 0, dark readable nav text, zero sidebar Upgrade box',
  },
  settings_upgrade_relocated: {
    category: 'Settings Upgrade (09:10Z)',
    expected: '[data-testid="settings-upgrade-cta"] & [data-testid="settings-upgrade-banner"] on /settings + Upgrade tab',
  },
  standard_app_icons: {
    category: 'AppIcons (09:10Z)',
    expected: 'Square bounded icons (sidebar 14..38px, .mkt-scope 56x56 tiles 32..56px, |w - h| <= 2)',
  },
  date_range_filter_present: {
    category: 'Date Filter (09:10Z)',
    expected: 'Unified date range filter trigger visible on surface and opens unified-date-picker-popover',
  },
  modal_zns_drawer_tour_contracts: {
    category: 'R3 Components',
    expected: 'Expanded Email modal (>=768px, 2-col), ZNS 2xl & 4 sub-tabs, Campaign/Flow/Survey drawers, Spotlight tours',
  },
  viewport_no_horizontal_overflow: {
    category: 'Layout Stability',
    expected: 'document.documentElement.scrollWidth <= window.innerWidth + 2',
  },
};

/**
 * Canonical 53-capture matrix matching docs/SCREENSHOT_COMPARISON_PLAN.md (A01 through E08).
 */
const CAPTURE_MATRIX = [
  // Group A — Reference Baselines (1440x900)
  {
    id: 'A01-ref-landing-data',
    group: 'A',
    mode: 'landing',
    surfaces: ['reference', 'landing'],
    deviceClass: 'desktop',
    route: '/data',
    state: 'default',
    pairId: 'A-DATA',
    pairRole: 'reference',
    title: 'Landing CRM Auto (/data)',
    description: 'Canonical CRM Auto light theme, Royal Sapphire tokens, LuxuryBackgroundDecor, Be Vietnam Pro',
    checks: ['runtime_clean', 'route_guard_clean', 'dom_svg_decor_present', 'typography_be_vietnam_pro', 'viewport_no_horizontal_overflow'],
  },
  {
    id: 'A02-ref-erp-data',
    group: 'A',
    mode: 'portal',
    surfaces: ['reference', 'portal'],
    deviceClass: 'desktop',
    route: '/data',
    state: 'default',
    pairId: 'A-DATA',
    pairRole: 'target',
    title: 'ERP CRM Auto (/data)',
    description: 'ERP CRM Auto /data light sidebar, DomUnifiedDatePicker, Layout.tsx SVG decor',
    checks: ['runtime_clean', 'route_guard_clean', 'splash_landing_bg', 'dom_svg_decor_present', 'typography_be_vietnam_pro', 'palette_sapphire_red_no_purple', 'sidebar_light_animated_clean', 'standard_app_icons', 'date_range_filter_present', 'viewport_no_horizontal_overflow'],
    exerciseDatePopover: true,
  },
  {
    id: 'A03-ref-landing-meta-report',
    group: 'A',
    mode: 'landing',
    surfaces: ['reference', 'landing'],
    deviceClass: 'desktop',
    route: '/meta-report',
    state: 'meta-preview',
    pairId: 'A-META',
    pairRole: 'reference',
    title: 'Landing Realtime Report (/meta-report)',
    description: 'Canonical Realtime Report (DomMetaReportWorkspace) KPIs, heatmaps, light sidebar',
    checks: ['runtime_clean', 'route_guard_clean', 'dom_svg_decor_present', 'typography_be_vietnam_pro', 'date_range_filter_present', 'viewport_no_horizontal_overflow'],
  },
  {
    id: 'A04-ref-erp-meta-report',
    group: 'A',
    mode: 'portal',
    surfaces: ['reference', 'portal'],
    deviceClass: 'desktop',
    route: '/meta-report',
    state: 'default',
    pairId: 'A-META',
    pairRole: 'target',
    title: 'ERP Realtime Report (/meta-report)',
    description: 'Paired comparison against A03; verifies .dom-meta-scope Be Vietnam Pro, white sidebar sub-tabs, CAPI tab',
    checks: ['runtime_clean', 'route_guard_clean', 'dom_svg_decor_present', 'typography_be_vietnam_pro', 'sidebar_light_animated_clean', 'standard_app_icons', 'date_range_filter_present', 'viewport_no_horizontal_overflow'],
    exerciseDatePopover: true,
  },

  // Group B — Shell, Loading Screen, White Sidebar, Quick-Nav & Settings (1440x900)
  {
    id: 'B01-loading-splash',
    group: 'B',
    mode: 'portal',
    surfaces: ['portal'],
    deviceClass: 'desktop',
    route: '/',
    state: 'splash-pre-hydration',
    isInteractiveState: true,
    pairId: 'B-SHELL',
    pairRole: 'splash',
    title: 'Pre-Hydration Loading Splash',
    description: 'Landing BG image (/imgs/landing/fluent-brand-ambient-bg.{webp,jpg}), 2-path silk SVG, glass card (DOMATION Suite)',
    checks: ['runtime_clean', 'splash_landing_bg', 'viewport_no_horizontal_overflow'],
  },
  {
    id: 'B02-portal-white-sidebar-expanded',
    group: 'B',
    mode: 'portal',
    surfaces: ['portal'],
    deviceClass: 'desktop',
    route: '/marketing',
    state: 'sidebar-expanded',
    pairId: 'B-SIDEBAR',
    pairRole: 'portal',
    title: 'Portal White Sidebar (Expanded 260px)',
    description: 'Light gradient aside.responsive-sidebar matching A01/A03, active Royal Sapphire pill, normal icons',
    checks: ['runtime_clean', 'route_guard_clean', 'splash_landing_bg', 'dom_svg_decor_present', 'typography_be_vietnam_pro', 'palette_sapphire_red_no_purple', 'sidebar_light_animated_clean', 'standard_app_icons', 'date_range_filter_present', 'viewport_no_horizontal_overflow'],
    requireMktRedAccent: true,
  },
  {
    id: 'B03-portal-white-sidebar-collapsed',
    group: 'B',
    mode: 'portal',
    surfaces: ['portal'],
    deviceClass: 'desktop',
    route: '/marketing',
    state: 'sidebar-collapsed',
    isInteractiveState: true,
    pairId: 'B-SIDEBAR-COLLAPSE',
    pairRole: 'portal',
    title: 'Portal White Sidebar (Collapsed 72px)',
    description: 'Smooth width 260px -> 72px animation, centered 36x36 icon tiles, zero clipped labels',
    checks: ['runtime_clean', 'route_guard_clean', 'sidebar_light_animated_clean', 'standard_app_icons', 'viewport_no_horizontal_overflow'],
  },
  {
    id: 'B04-standalone-white-sidebar',
    group: 'B',
    mode: 'standalone',
    surfaces: ['standalone'],
    deviceClass: 'desktop',
    route: '/',
    state: 'standalone-sidebar',
    pairId: 'B-SIDEBAR',
    pairRole: 'standalone',
    title: 'Standalone White Sidebar',
    description: 'White sidebar scoped to MARKETING AUTOMATION + CÀI ĐẶT HỆ THỐNG; zero bottom STANDALONE MODE / Nâng cấp widget',
    checks: ['runtime_clean', 'route_guard_clean', 'splash_landing_bg', 'dom_svg_decor_present', 'typography_be_vietnam_pro', 'palette_sapphire_red_no_purple', 'sidebar_light_animated_clean', 'standard_app_icons', 'date_range_filter_present', 'viewport_no_horizontal_overflow'],
    requireMktRedAccent: true,
  },
  {
    id: 'B05-quick-nav-menu-red-sapphire',
    group: 'B',
    mode: 'portal',
    surfaces: ['portal'],
    deviceClass: 'desktop',
    route: '/marketing',
    state: 'quick-nav-modal',
    isInteractiveState: true,
    pairId: 'B-QUICKNAV',
    pairRole: 'portal',
    title: 'ERP & Marketing Quick-Nav Modal',
    description: 'Red (#DC2626/#E11D48) + Royal Sapphire (#1E40FF) PALETTE across Marketing & ERP + normal 56x56 AppIcons',
    checks: ['runtime_clean', 'route_guard_clean', 'typography_be_vietnam_pro', 'palette_sapphire_red_no_purple', 'standard_app_icons', 'viewport_no_horizontal_overflow'],
    requireQuickNavRedAccent: true,
    requireQuickNavAppIcons: true,
  },
  {
    id: 'B06-settings-upgrade-cta',
    group: 'B',
    mode: 'standalone',
    surfaces: ['standalone'],
    deviceClass: 'desktop',
    route: '/settings?tab=package_upgrade',
    state: 'settings-upgrade',
    isInteractiveState: true,
    pairId: 'B-SETTINGS',
    pairRole: 'standalone',
    title: 'Settings Upgrade CTA & Package Upgrade Panel',
    description: 'Confirms Nâng cấp gói CTA & red-accented banner live cleanly in /settings and ?tab=package_upgrade',
    checks: ['runtime_clean', 'route_guard_clean', 'typography_be_vietnam_pro', 'palette_sapphire_red_no_purple', 'sidebar_light_animated_clean', 'settings_upgrade_relocated', 'viewport_no_horizontal_overflow'],
  },

  // Group C — Dual-Mode Core Marketing Pages: Portal (C*p) vs Standalone (C*s) (1440x900)
  {
    id: 'C01p-portal-marketing-dashboard',
    group: 'C',
    mode: 'portal',
    surfaces: ['portal'],
    deviceClass: 'desktop',
    route: '/marketing',
    state: 'default',
    pairId: 'C01',
    pairRole: 'portal',
    title: 'Marketing Dashboard (Portal)',
    description: 'PageHero, erp-marketing-meta-strip, mkt-dashboard-date-picker, AppIcon module grid',
    checks: ['runtime_clean', 'route_guard_clean', 'dom_svg_decor_present', 'typography_be_vietnam_pro', 'palette_sapphire_red_no_purple', 'sidebar_light_animated_clean', 'standard_app_icons', 'date_range_filter_present', 'viewport_no_horizontal_overflow'],
    requireMktScope: true,
    requireMktRedAccent: true,
    exerciseDatePopover: true,
  },
  {
    id: 'C01s-standalone-marketing-dashboard',
    group: 'C',
    mode: 'standalone',
    surfaces: ['standalone'],
    deviceClass: 'desktop',
    route: '/',
    state: 'default',
    pairId: 'C01',
    pairRole: 'standalone',
    title: 'Marketing Dashboard (Standalone /)',
    description: 'Isolated workspace rendering MarketingDashboardPage at "/" inside .mkt-scope',
    checks: ['runtime_clean', 'route_guard_clean', 'dom_svg_decor_present', 'typography_be_vietnam_pro', 'palette_sapphire_red_no_purple', 'sidebar_light_animated_clean', 'standard_app_icons', 'date_range_filter_present', 'viewport_no_horizontal_overflow'],
    requireMktScope: true,
    requireMktRedAccent: true,
    exerciseDatePopover: true,
  },
  {
    id: 'C02p-portal-flows-list',
    group: 'C',
    mode: 'portal',
    surfaces: ['portal'],
    deviceClass: 'desktop',
    route: '/marketing/flows',
    state: 'default',
    pairId: 'C02',
    pairRole: 'portal',
    title: 'Automation Flows List (Portal)',
    description: 'Refreshed Automation list (StatCard Tổng kịch bản, Tạo kịch bản, MktDateRangeFilter)',
    checks: ['runtime_clean', 'route_guard_clean', 'dom_svg_decor_present', 'typography_be_vietnam_pro', 'palette_sapphire_red_no_purple', 'sidebar_light_animated_clean', 'date_range_filter_present', 'viewport_no_horizontal_overflow'],
    requireMktScope: true,
    requireSapphirePrimaryCta: 'Tạo kịch bản',
  },
  {
    id: 'C02s-standalone-flows-list',
    group: 'C',
    mode: 'standalone',
    surfaces: ['standalone'],
    deviceClass: 'desktop',
    route: '/marketing/flows',
    state: 'default',
    pairId: 'C02',
    pairRole: 'standalone',
    title: 'Automation Flows List (Standalone)',
    description: 'Refreshed Automation list in standalone mode sharing same backend/DB',
    checks: ['runtime_clean', 'route_guard_clean', 'dom_svg_decor_present', 'typography_be_vietnam_pro', 'palette_sapphire_red_no_purple', 'sidebar_light_animated_clean', 'date_range_filter_present', 'viewport_no_horizontal_overflow'],
    requireMktScope: true,
    requireSapphirePrimaryCta: 'Tạo kịch bản',
  },
  {
    id: 'C02b-portal-flows-builder',
    group: 'C',
    mode: 'portal',
    surfaces: ['portal'],
    deviceClass: 'desktop',
    route: '/marketing/flows',
    state: 'flow-builder',
    isInteractiveState: true,
    pairId: 'C02b',
    pairRole: 'portal',
    title: 'Automation Flow Builder (Full-Screen)',
    description: 'Full-screen Builder (#mkt-portal-root, FlowHeader Thiết kế/Báo cáo/Cài đặt, FlowTree #step-node-*)',
    checks: ['runtime_clean', 'route_guard_clean', 'typography_be_vietnam_pro', 'palette_sapphire_red_no_purple', 'modal_zns_drawer_tour_contracts', 'viewport_no_horizontal_overflow'],
    requireMktScope: true,
  },
  {
    id: 'C03p-portal-campaigns',
    group: 'C',
    mode: 'portal',
    surfaces: ['portal'],
    deviceClass: 'desktop',
    route: '/marketing/campaigns',
    state: 'default',
    pairId: 'C03',
    pairRole: 'portal',
    title: 'Campaigns (Portal)',
    description: 'Campaign KPIs, MktDateRangeFilter, campaign cards/table, status badges',
    checks: ['runtime_clean', 'route_guard_clean', 'dom_svg_decor_present', 'typography_be_vietnam_pro', 'palette_sapphire_red_no_purple', 'sidebar_light_animated_clean', 'date_range_filter_present', 'viewport_no_horizontal_overflow'],
    requireMktScope: true,
  },
  {
    id: 'C03s-standalone-campaigns',
    group: 'C',
    mode: 'standalone',
    surfaces: ['standalone'],
    deviceClass: 'desktop',
    route: '/marketing/campaigns',
    state: 'default',
    pairId: 'C03',
    pairRole: 'standalone',
    title: 'Campaigns (Standalone)',
    description: 'Campaign KPIs, MktDateRangeFilter, campaign cards/table in standalone mode',
    checks: ['runtime_clean', 'route_guard_clean', 'dom_svg_decor_present', 'typography_be_vietnam_pro', 'palette_sapphire_red_no_purple', 'sidebar_light_animated_clean', 'date_range_filter_present', 'viewport_no_horizontal_overflow'],
    requireMktScope: true,
  },
  {
    id: 'C04p-portal-templates',
    group: 'C',
    mode: 'portal',
    surfaces: ['portal'],
    deviceClass: 'desktop',
    route: '/marketing/templates',
    state: 'default',
    pairId: 'C04',
    pairRole: 'portal',
    title: 'Email Templates (Portal)',
    description: 'Template groups, gallery cards, drag-drop EmailEditor preview',
    checks: ['runtime_clean', 'route_guard_clean', 'dom_svg_decor_present', 'typography_be_vietnam_pro', 'palette_sapphire_red_no_purple', 'sidebar_light_animated_clean', 'viewport_no_horizontal_overflow'],
    requireMktScope: true,
  },
  {
    id: 'C04s-standalone-templates',
    group: 'C',
    mode: 'standalone',
    surfaces: ['standalone'],
    deviceClass: 'desktop',
    route: '/marketing/templates',
    state: 'default',
    pairId: 'C04',
    pairRole: 'standalone',
    title: 'Email Templates (Standalone)',
    description: 'Template groups & gallery cards in standalone mode',
    checks: ['runtime_clean', 'route_guard_clean', 'dom_svg_decor_present', 'typography_be_vietnam_pro', 'palette_sapphire_red_no_purple', 'sidebar_light_animated_clean', 'viewport_no_horizontal_overflow'],
    requireMktScope: true,
  },
  {
    id: 'C05p-portal-audience',
    group: 'C',
    mode: 'portal',
    surfaces: ['portal'],
    deviceClass: 'desktop',
    route: '/marketing/audience',
    state: 'default',
    pairId: 'C05',
    pairRole: 'portal',
    title: 'Audience & Segments (Portal)',
    description: 'Tabs (lists, segments, contacts, integrations), Royal Sapphire pills, tabular-nums counts',
    checks: ['runtime_clean', 'route_guard_clean', 'dom_svg_decor_present', 'typography_be_vietnam_pro', 'palette_sapphire_red_no_purple', 'sidebar_light_animated_clean', 'viewport_no_horizontal_overflow'],
    requireMktScope: true,
  },
  {
    id: 'C05s-standalone-audience',
    group: 'C',
    mode: 'standalone',
    surfaces: ['standalone'],
    deviceClass: 'desktop',
    route: '/marketing/audience',
    state: 'default',
    pairId: 'C05',
    pairRole: 'standalone',
    title: 'Audience & Segments (Standalone)',
    description: 'Audience lists/segments/contacts in standalone mode',
    checks: ['runtime_clean', 'route_guard_clean', 'dom_svg_decor_present', 'typography_be_vietnam_pro', 'palette_sapphire_red_no_purple', 'sidebar_light_animated_clean', 'viewport_no_horizontal_overflow'],
    requireMktScope: true,
  },
  {
    id: 'C06p-portal-surveys',
    group: 'C',
    mode: 'portal',
    surfaces: ['portal'],
    deviceClass: 'desktop',
    route: '/marketing/surveys',
    state: 'default',
    pairId: 'C06',
    pairRole: 'portal',
    title: 'Surveys (Portal)',
    description: 'Survey list/cards, status badges, Xem báo cáo trigger',
    checks: ['runtime_clean', 'route_guard_clean', 'dom_svg_decor_present', 'typography_be_vietnam_pro', 'palette_sapphire_red_no_purple', 'sidebar_light_animated_clean', 'viewport_no_horizontal_overflow'],
    requireMktScope: true,
  },
  {
    id: 'C06s-standalone-surveys',
    group: 'C',
    mode: 'standalone',
    surfaces: ['standalone'],
    deviceClass: 'desktop',
    route: '/marketing/surveys',
    state: 'default',
    pairId: 'C06',
    pairRole: 'standalone',
    title: 'Surveys (Standalone)',
    description: 'Survey list/cards in standalone mode',
    checks: ['runtime_clean', 'route_guard_clean', 'dom_svg_decor_present', 'typography_be_vietnam_pro', 'palette_sapphire_red_no_purple', 'sidebar_light_animated_clean', 'viewport_no_horizontal_overflow'],
    requireMktScope: true,
  },
  {
    id: 'C07p-portal-vouchers',
    group: 'C',
    mode: 'portal',
    surfaces: ['portal'],
    deviceClass: 'desktop',
    route: '/marketing/vouchers',
    state: 'default',
    pairId: 'C07',
    pairRole: 'portal',
    title: 'Vouchers & Links/QR (Portal)',
    description: 'MktSegmented (vouchers / links-qr), voucher campaign cards, QR preview',
    checks: ['runtime_clean', 'route_guard_clean', 'dom_svg_decor_present', 'typography_be_vietnam_pro', 'palette_sapphire_red_no_purple', 'sidebar_light_animated_clean', 'viewport_no_horizontal_overflow'],
    requireMktScope: true,
  },
  {
    id: 'C07s-standalone-vouchers',
    group: 'C',
    mode: 'standalone',
    surfaces: ['standalone'],
    deviceClass: 'desktop',
    route: '/marketing/vouchers',
    state: 'default',
    pairId: 'C07',
    pairRole: 'standalone',
    title: 'Vouchers & Links/QR (Standalone)',
    description: 'Voucher campaign cards & QR preview in standalone mode',
    checks: ['runtime_clean', 'route_guard_clean', 'dom_svg_decor_present', 'typography_be_vietnam_pro', 'palette_sapphire_red_no_purple', 'sidebar_light_animated_clean', 'viewport_no_horizontal_overflow'],
    requireMktScope: true,
  },
  {
    id: 'C08p-portal-social-bot',
    group: 'C',
    mode: 'portal',
    surfaces: ['portal'],
    deviceClass: 'desktop',
    route: '/marketing/social-bot',
    state: 'default',
    pairId: 'C08',
    pairRole: 'portal',
    title: 'Social Bot & ZNS (Portal)',
    description: 'PageHero, 4 KPI cards, Meta Messenger & Zalo OA & ZNS channel switcher',
    checks: ['runtime_clean', 'route_guard_clean', 'dom_svg_decor_present', 'typography_be_vietnam_pro', 'palette_sapphire_red_no_purple', 'sidebar_light_animated_clean', 'viewport_no_horizontal_overflow'],
    requireMktScope: true,
  },
  {
    id: 'C08s-standalone-social-bot',
    group: 'C',
    mode: 'standalone',
    surfaces: ['standalone'],
    deviceClass: 'desktop',
    route: '/marketing/social-bot',
    state: 'default',
    pairId: 'C08',
    pairRole: 'standalone',
    title: 'Social Bot & ZNS (Standalone)',
    description: 'Social Bot & Zalo OA/ZNS channel switcher in standalone mode',
    checks: ['runtime_clean', 'route_guard_clean', 'dom_svg_decor_present', 'typography_be_vietnam_pro', 'palette_sapphire_red_no_purple', 'sidebar_light_animated_clean', 'viewport_no_horizontal_overflow'],
    requireMktScope: true,
  },
  {
    id: 'C09p-portal-ai-training',
    group: 'C',
    mode: 'portal',
    surfaces: ['portal'],
    deviceClass: 'desktop',
    route: '/marketing/ai-training',
    state: 'default',
    pairId: 'C09',
    pairRole: 'portal',
    title: 'AI Training (Portal)',
    description: 'AITrainingManager, ScenarioManager, InstructionSettings, UnifiedChat',
    checks: ['runtime_clean', 'route_guard_clean', 'dom_svg_decor_present', 'typography_be_vietnam_pro', 'palette_sapphire_red_no_purple', 'sidebar_light_animated_clean', 'viewport_no_horizontal_overflow'],
    requireMktScope: true,
  },
  {
    id: 'C09s-standalone-ai-training',
    group: 'C',
    mode: 'standalone',
    surfaces: ['standalone'],
    deviceClass: 'desktop',
    route: '/marketing/ai-training',
    state: 'default',
    pairId: 'C09',
    pairRole: 'standalone',
    title: 'AI Training (Standalone)',
    description: 'AITrainingManager in standalone mode',
    checks: ['runtime_clean', 'route_guard_clean', 'dom_svg_decor_present', 'typography_be_vietnam_pro', 'palette_sapphire_red_no_purple', 'sidebar_light_animated_clean', 'viewport_no_horizontal_overflow'],
    requireMktScope: true,
  },
  {
    id: 'C10p-portal-web-tracking',
    group: 'C',
    mode: 'portal',
    surfaces: ['portal'],
    deviceClass: 'desktop',
    route: '/marketing/web-tracking',
    state: 'default',
    pairId: 'C10',
    pairRole: 'portal',
    title: 'Web Tracking (Portal)',
    description: 'Website list, overview/visitors/chat tabs, SDK embed snippet (Fira Code)',
    checks: ['runtime_clean', 'route_guard_clean', 'dom_svg_decor_present', 'typography_be_vietnam_pro', 'palette_sapphire_red_no_purple', 'sidebar_light_animated_clean', 'viewport_no_horizontal_overflow'],
    requireMktScope: true,
  },
  {
    id: 'C10s-standalone-web-tracking',
    group: 'C',
    mode: 'standalone',
    surfaces: ['standalone'],
    deviceClass: 'desktop',
    route: '/marketing/web-tracking',
    state: 'default',
    pairId: 'C10',
    pairRole: 'standalone',
    title: 'Web Tracking (Standalone)',
    description: 'Website tracking & SDK embed in standalone mode',
    checks: ['runtime_clean', 'route_guard_clean', 'dom_svg_decor_present', 'typography_be_vietnam_pro', 'palette_sapphire_red_no_purple', 'sidebar_light_animated_clean', 'viewport_no_horizontal_overflow'],
    requireMktScope: true,
  },
  {
    id: 'C11p-portal-api-triggers',
    group: 'C',
    mode: 'portal',
    surfaces: ['portal'],
    deviceClass: 'desktop',
    route: '/marketing/api-triggers',
    state: 'default',
    pairId: 'C11',
    pairRole: 'portal',
    title: 'API & Webhook Triggers (Portal)',
    description: 'FormsTab, PurchasesTab, CustomEventsTab, OTPTriggersTab',
    checks: ['runtime_clean', 'route_guard_clean', 'dom_svg_decor_present', 'typography_be_vietnam_pro', 'palette_sapphire_red_no_purple', 'sidebar_light_animated_clean', 'viewport_no_horizontal_overflow'],
    requireMktScope: true,
  },
  {
    id: 'C11s-standalone-api-triggers',
    group: 'C',
    mode: 'standalone',
    surfaces: ['standalone'],
    deviceClass: 'desktop',
    route: '/marketing/api-triggers',
    state: 'default',
    pairId: 'C11',
    pairRole: 'standalone',
    title: 'API & Webhook Triggers (Standalone)',
    description: 'API & Webhook Triggers in standalone mode',
    checks: ['runtime_clean', 'route_guard_clean', 'dom_svg_decor_present', 'typography_be_vietnam_pro', 'palette_sapphire_red_no_purple', 'sidebar_light_animated_clean', 'viewport_no_horizontal_overflow'],
    requireMktScope: true,
  },
  {
    id: 'C12p-portal-capi',
    group: 'C',
    mode: 'portal',
    surfaces: ['portal'],
    deviceClass: 'desktop',
    route: '/marketing/capi',
    state: 'default',
    pairId: 'C12',
    pairRole: 'portal',
    title: 'Meta CAPI (Portal /marketing/capi)',
    description: 'Meta CAPI logs, stage mapping, 7-day backfill, Lookalike audiences (verifies .mkt-scope wrapper)',
    checks: ['runtime_clean', 'route_guard_clean', 'dom_svg_decor_present', 'typography_be_vietnam_pro', 'palette_sapphire_red_no_purple', 'sidebar_light_animated_clean', 'viewport_no_horizontal_overflow'],
    requireMktScope: true,
  },
  {
    id: 'C12s-standalone-capi',
    group: 'C',
    mode: 'standalone',
    surfaces: ['standalone'],
    deviceClass: 'desktop',
    route: '/capi',
    state: 'default',
    pairId: 'C12',
    pairRole: 'standalone',
    title: 'Meta CAPI (Standalone /capi)',
    description: 'Meta CAPI in standalone mode (verifies .mkt-scope wrapper)',
    checks: ['runtime_clean', 'route_guard_clean', 'dom_svg_decor_present', 'typography_be_vietnam_pro', 'palette_sapphire_red_no_purple', 'sidebar_light_animated_clean', 'viewport_no_horizontal_overflow'],
    requireMktScope: true,
  },

  // Group D — Expanded Modals, Optimized ZNS UI, Measurement Drawers & Focus Tours (1440x900)
  {
    id: 'D01-modal-step-email-3xl',
    group: 'D',
    mode: 'portal',
    surfaces: ['portal'],
    deviceClass: 'desktop',
    route: '/marketing/flows',
    state: 'modal-step-email-3xl',
    isInteractiveState: true,
    pairId: 'D-MODALS',
    pairRole: 'email',
    title: 'Expanded Email Step Modal (size="3xl")',
    description: 'StepEditor size=3xl (>=768px, NOT max-w-2xl), 2-column EmailActionConfig, zero horizontal clipping',
    checks: ['runtime_clean', 'route_guard_clean', 'typography_be_vietnam_pro', 'palette_sapphire_red_no_purple', 'modal_zns_drawer_tour_contracts', 'viewport_no_horizontal_overflow'],
  },
  {
    id: 'D02-modal-step-zns-2xl',
    group: 'D',
    mode: 'portal',
    surfaces: ['portal'],
    deviceClass: 'desktop',
    route: '/marketing/flows',
    state: 'modal-step-zns-2xl',
    isInteractiveState: true,
    pairId: 'D-MODALS',
    pairRole: 'zns',
    title: 'Optimized Zalo ZNS Step Modal (size="2xl")',
    description: 'StepEditor size=2xl, ZaloZNSStepConfig (OA selector, template picker, merge-tag params)',
    checks: ['runtime_clean', 'route_guard_clean', 'typography_be_vietnam_pro', 'palette_sapphire_red_no_purple', 'modal_zns_drawer_tour_contracts', 'viewport_no_horizontal_overflow'],
  },
  {
    id: 'D02s-showcase-zalo-zns-2xl',
    group: 'D',
    mode: 'zalo_demo',
    surfaces: ['standalone'],
    deviceClass: 'desktop',
    route: '/marketing/flows',
    state: 'modal-step-zns-2xl',
    isInteractiveState: true,
    requiresZaloDemo: true,
    pairId: 'D-MODALS',
    pairRole: 'zns-showcase',
    title: 'Showcase Zalo ZNS Step Modal (ideas-showcase-zns, 2-col live preview)',
    description: 'Live 2-column Zalo ZNS builder + approved template preview on separate ideas-showcase-zns tenant (preserves ideas F8)',
    checks: ['runtime_clean', 'route_guard_clean', 'typography_be_vietnam_pro', 'palette_sapphire_red_no_purple', 'modal_zns_drawer_tour_contracts', 'viewport_no_horizontal_overflow'],
  },
  {
    id: 'D03-zalo-oa-zns-tabs',
    group: 'D',
    mode: 'portal',
    surfaces: ['portal'],
    deviceClass: 'desktop',
    route: '/marketing/social-bot?channel=zalo',
    state: 'zalo-oa-zns-tabs',
    isInteractiveState: true,
    pairId: 'D-ZNS',
    pairRole: 'zalo-tabs',
    title: 'Zalo OA & ZNS 4 Sub-Tabs',
    description: 'Switches to Zalo OA & ZNS and exercises Khách hàng Zalo, Kịch bản Zalo, Broadcast & ZBS, Mẫu tin ZNS',
    checks: ['runtime_clean', 'route_guard_clean', 'typography_be_vietnam_pro', 'palette_sapphire_red_no_purple', 'modal_zns_drawer_tour_contracts', 'viewport_no_horizontal_overflow'],
  },
  {
    id: 'D04-drawer-campaign-detail',
    group: 'D',
    mode: 'portal',
    surfaces: ['portal'],
    deviceClass: 'desktop',
    route: '/marketing/campaigns',
    state: 'drawer-campaign-detail',
    isInteractiveState: true,
    pairId: 'D-DRAWERS',
    pairRole: 'campaign',
    title: 'CampaignDetailDrawer',
    description: 'Displays Tỷ lệ mở/Xem, Tỷ lệ Click (CTR), Phễu chuyển đổi, LinkClicksTab, TechStatsTab',
    checks: ['runtime_clean', 'route_guard_clean', 'typography_be_vietnam_pro', 'modal_zns_drawer_tour_contracts', 'viewport_no_horizontal_overflow'],
  },
  {
    id: 'D05-tab-flow-analytics',
    group: 'D',
    mode: 'portal',
    surfaces: ['portal'],
    deviceClass: 'desktop',
    route: '/marketing/flows',
    state: 'tab-flow-analytics',
    isInteractiveState: true,
    pairId: 'D-DRAWERS',
    pairRole: 'flow-analytics',
    title: 'FlowAnalyticsTab (Báo cáo)',
    description: 'Renders Hiệu suất vận hành, Hành trình Khách hàng, MktDateRangeFilter, bottleneck metrics',
    checks: ['runtime_clean', 'route_guard_clean', 'typography_be_vietnam_pro', 'date_range_filter_present', 'modal_zns_drawer_tour_contracts', 'viewport_no_horizontal_overflow'],
  },
  {
    id: 'D06-modal-step-participants',
    group: 'D',
    mode: 'portal',
    surfaces: ['portal'],
    deviceClass: 'desktop',
    route: '/marketing/flows',
    state: 'modal-step-participants',
    isInteractiveState: true,
    pairId: 'D-DRAWERS',
    pairRole: 'participants',
    title: 'StepParticipantsModal',
    description: 'Step participants drilldown modal with filter tabs (all_touched/waiting/opened/failed/clicks/zns_*)',
    checks: ['runtime_clean', 'route_guard_clean', 'typography_be_vietnam_pro', 'modal_zns_drawer_tour_contracts', 'viewport_no_horizontal_overflow'],
  },
  {
    id: 'D07-modal-survey-report',
    group: 'D',
    mode: 'portal',
    surfaces: ['portal'],
    deviceClass: 'desktop',
    route: '/marketing/surveys',
    state: 'modal-survey-report',
    isInteractiveState: true,
    pairId: 'D-DRAWERS',
    pairRole: 'survey',
    title: 'SurveyReportModal',
    description: 'MktDateRangeFilter, Recharts response charts, question analytics, tabular-nums breakdown',
    checks: ['runtime_clean', 'route_guard_clean', 'typography_be_vietnam_pro', 'date_range_filter_present', 'modal_zns_drawer_tour_contracts', 'viewport_no_horizontal_overflow'],
  },
  {
    id: 'D08-tour-dom-meta-spotlight',
    group: 'D',
    mode: 'portal',
    surfaces: ['portal'],
    deviceClass: 'desktop',
    route: '/meta-report',
    state: 'tour-dom-meta',
    isInteractiveState: true,
    pairId: 'D-TOURS',
    pairRole: 'meta-tour',
    title: 'DomMetaSpotlightTour (/meta-report)',
    description: 'div[role="dialog"][aria-modal="true"], BƯỚC 1 / 5, SVG mask spotlight, Tiếp theo/Quay lại/Bỏ qua tour',
    checks: ['runtime_clean', 'route_guard_clean', 'typography_be_vietnam_pro', 'modal_zns_drawer_tour_contracts', 'viewport_no_horizontal_overflow'],
  },
  {
    id: 'D09-tour-marketing-spotlight',
    group: 'D',
    mode: 'portal',
    surfaces: ['portal'],
    deviceClass: 'desktop',
    route: '/marketing',
    state: 'tour-marketing',
    isInteractiveState: true,
    pairId: 'D-TOURS',
    pairRole: 'mkt-tour',
    title: 'MarketingSpotlightTour (/marketing)',
    description: 'div[role="dialog"][aria-modal="true"], SVG mask spotlight over [data-tour] targets (M3.4 check)',
    checks: ['runtime_clean', 'route_guard_clean', 'typography_be_vietnam_pro', 'modal_zns_drawer_tour_contracts', 'viewport_no_horizontal_overflow'],
  },
  {
    id: 'D10-tour-erp-spotlight',
    group: 'D',
    mode: 'portal',
    surfaces: ['portal'],
    deviceClass: 'desktop',
    route: '/settings',
    state: 'tour-erp',
    isInteractiveState: true,
    pairId: 'D-TOURS',
    pairRole: 'erp-tour',
    title: 'ErpSpotlightTour (/settings)',
    description: 'ErpSpotlightTour dialog aligned visually with D08 and D09',
    checks: ['runtime_clean', 'route_guard_clean', 'typography_be_vietnam_pro', 'modal_zns_drawer_tour_contracts', 'viewport_no_horizontal_overflow'],
  },

  // Group E — Mobile 390x844 Paired Comparisons
  {
    id: 'E01-mobile-ref-data',
    group: 'E',
    mode: 'portal',
    surfaces: ['reference', 'portal'],
    deviceClass: 'mobile',
    route: '/data',
    state: 'mobile',
    pairId: 'E-REF',
    pairRole: 'data',
    title: 'Mobile CRM Auto (/data)',
    description: 'scrollWidth <= 392, responsive card/table view, DomUnifiedDatePicker fits cleanly',
    checks: ['runtime_clean', 'route_guard_clean', 'typography_be_vietnam_pro', 'date_range_filter_present', 'viewport_no_horizontal_overflow'],
  },
  {
    id: 'E02-mobile-ref-meta-report',
    group: 'E',
    mode: 'portal',
    fallbackLanding: true,
    surfaces: ['reference', 'portal', 'landing'],
    deviceClass: 'mobile',
    route: '/meta-report',
    state: 'mobile',
    pairId: 'E-REF',
    pairRole: 'meta',
    title: 'Mobile Realtime Report (/meta-report)',
    description: 'scrollWidth <= 392, KPI cards stack 2-col/1-col cleanly, charts fit viewport',
    checks: ['runtime_clean', 'route_guard_clean', 'typography_be_vietnam_pro', 'date_range_filter_present', 'viewport_no_horizontal_overflow'],
  },
  {
    id: 'E03-mobile-portal-marketing-dashboard',
    group: 'E',
    mode: 'portal',
    surfaces: ['portal'],
    deviceClass: 'mobile',
    route: '/marketing',
    state: 'mobile',
    pairId: 'E-DASH',
    pairRole: 'portal',
    title: 'Mobile Marketing Dashboard (Portal)',
    description: 'scrollWidth <= 392, MktStatGrid 2-col responsive layout, readable Be Vietnam Pro',
    checks: ['runtime_clean', 'route_guard_clean', 'typography_be_vietnam_pro', 'date_range_filter_present', 'viewport_no_horizontal_overflow'],
    requireMktScope: true,
  },
  {
    id: 'E04-mobile-standalone-marketing-dashboard',
    group: 'E',
    mode: 'standalone',
    surfaces: ['standalone'],
    deviceClass: 'mobile',
    route: '/',
    state: 'mobile',
    pairId: 'E-DASH',
    pairRole: 'standalone',
    title: 'Mobile Marketing Dashboard (Standalone /)',
    description: 'scrollWidth <= 392, MktPage renders cleanly without clipped buttons',
    checks: ['runtime_clean', 'route_guard_clean', 'typography_be_vietnam_pro', 'date_range_filter_present', 'viewport_no_horizontal_overflow'],
    requireMktScope: true,
  },
  {
    id: 'E05-mobile-marketing-flows',
    group: 'E',
    mode: 'portal',
    surfaces: ['portal'],
    deviceClass: 'mobile',
    route: '/marketing/flows',
    state: 'mobile',
    pairId: 'E-MKT',
    pairRole: 'flows',
    title: 'Mobile Automation Flows',
    description: 'scrollWidth <= 392, horizontal toolbar strip does not break page width',
    checks: ['runtime_clean', 'route_guard_clean', 'typography_be_vietnam_pro', 'viewport_no_horizontal_overflow'],
    requireMktScope: true,
  },
  {
    id: 'E06-mobile-marketing-campaigns',
    group: 'E',
    mode: 'portal',
    surfaces: ['portal'],
    deviceClass: 'mobile',
    route: '/marketing/campaigns',
    state: 'mobile',
    pairId: 'E-MKT',
    pairRole: 'campaigns',
    title: 'Mobile Campaigns',
    description: 'scrollWidth <= 392, campaign cards stack cleanly',
    checks: ['runtime_clean', 'route_guard_clean', 'typography_be_vietnam_pro', 'viewport_no_horizontal_overflow'],
    requireMktScope: true,
  },
  {
    id: 'E07-mobile-marketing-social-bot',
    group: 'E',
    mode: 'portal',
    surfaces: ['portal'],
    deviceClass: 'mobile',
    route: '/marketing/social-bot',
    state: 'mobile',
    pairId: 'E-MKT',
    pairRole: 'social-bot',
    title: 'Mobile Social Bot & ZNS',
    description: 'scrollWidth <= 392, channel tabs & KPI grid fit cleanly',
    checks: ['runtime_clean', 'route_guard_clean', 'typography_be_vietnam_pro', 'viewport_no_horizontal_overflow'],
    requireMktScope: true,
  },
  {
    id: 'E08-mobile-bottom-nav-quick-nav',
    group: 'E',
    mode: 'portal',
    surfaces: ['portal'],
    deviceClass: 'mobile',
    route: '/marketing',
    state: 'mobile-quick-nav',
    isInteractiveState: true,
    pairId: 'E-NAV',
    pairRole: 'drawer',
    title: 'Mobile Bottom Nav & Quick-Nav Drawer',
    description: '.mobile-bottom-nav visible, mobile quick-nav drawer opens inside 390px without overflow, closes on Escape',
    checks: ['runtime_clean', 'route_guard_clean', 'typography_be_vietnam_pro', 'modal_zns_drawer_tour_contracts', 'viewport_no_horizontal_overflow'],
  },
];

// ============================================================================
// CLI Parsing & Help
// ============================================================================

function parseBoolFlag(raw, flagName) {
  if (raw === undefined || raw === null || raw === '') return true;
  const s = String(raw).trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(s)) return true;
  if (['0', 'false', 'no', 'off'].includes(s)) return false;
  throw new Error(`Invalid boolean value "${raw}" for ${flagName}. Expected true or false.`);
}

function parseViewports(raw) {
  const parts = String(raw || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  if (parts.length === 0) {
    throw new Error('At least one viewport (e.g. 1440x900 or 390x844) must be specified in --viewports.');
  }
  const parsed = [];
  const seen = new Set();
  for (const token of parts) {
    const m = token.match(/^(\d{3,4})x(\d{3,4})$/i);
    if (!m) {
      throw new Error(`Invalid viewport "${token}". Expected format WxH (e.g. 1440x900,390x844).`);
    }
    const width = Number(m[1]);
    const height = Number(m[2]);
    if (width < 280 || height < 400) {
      throw new Error(`Viewport "${token}" is too small (minimum 280x400).`);
    }
    const label = `${width}x${height}`;
    if (!seen.has(label)) {
      seen.add(label);
      parsed.push({
        width,
        height,
        label,
        isMobile: width <= 540,
      });
    }
  }
  return parsed;
}

function parseCsvList(raw) {
  return String(raw || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

function parseCliArgs(argv) {
  const config = {
    help: false,
    dryRun: false,
    json: false,
    mode: 'all',
    outDir: DEFAULT_OUT_DIR,
    spawnVite: false,
    spawnBackend: false,
    mockMeta: false,
    strict: false,
    headless: true,
    fullPage: false,
    includeStates: true,
    seedFixtures: true,
    seedFixturesExplicit: false,
    seedMyerpShowcase: false,
    withShowcaseTenants: false,
    dataDir: null,
    backendUrl: null,
    frontendUrl: null,
    landingUrl: null,
    erpDir: process.env.DOMATION_ERP_DIR || path.resolve(REPO_ROOT, '..', 'DOMATION_ERP_FULL'),
    landingDir: process.env.DOMATION_LANDINGPAGE_DIR || path.resolve(REPO_ROOT, '..', 'DOMATION_LANDINGPAGE'),
    chromePath: null,
    viewportsRaw: DEFAULT_VIEWPORTS_RAW,
    routesFilter: [],
    capturesFilter: [],
    timeoutMs: DEFAULT_TIMEOUT_MS,
    token: null,
    tenantSlug: null,
    email: null,
    password: null,
  };

  const booleanFlags = new Set([
    'help',
    'dry-run',
    'json',
    'spawn-vite',
    'spawn-backend',
    'mock-meta',
    'strict',
    'headless',
    'full-page',
    'include-states',
    'seed-fixtures',
    'seed-myerp-showcase',
    'with-showcase-tenants',
  ]);

  const valueFlags = new Set([
    'mode',
    'out-dir',
    'data-dir',
    'backend-url',
    'api-url',
    'frontend-url',
    'erp-url',
    'base-url',
    'landing-url',
    'erp-dir',
    'landing-dir',
    'chrome-path',
    'viewports',
    'routes',
    'captures',
    'timeout-ms',
    'token',
    'tenant-slug',
    'email',
    'password',
  ]);

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '-h' || arg === '--help') {
      config.help = true;
      continue;
    }
    if (!arg.startsWith('--')) {
      throw new Error(`Unexpected positional argument "${arg}". Run with --help for usage.`);
    }

    const eqIdx = arg.indexOf('=');
    const key = (eqIdx >= 0 ? arg.slice(2, eqIdx) : arg.slice(2)).trim();
    const inlineVal = eqIdx >= 0 ? arg.slice(eqIdx + 1) : undefined;

    if (booleanFlags.has(key)) {
      let val = true;
      if (inlineVal !== undefined) {
        val = parseBoolFlag(inlineVal, `--${key}`);
      } else if (i + 1 < argv.length && !argv[i + 1].startsWith('--') && /^(true|false|1|0|yes|no|on|off)$/i.test(argv[i + 1])) {
        val = parseBoolFlag(argv[++i], `--${key}`);
      }
      if (key === 'help') config.help = val;
      else if (key === 'dry-run') config.dryRun = val;
      else if (key === 'json') config.json = val;
      else if (key === 'spawn-vite') config.spawnVite = val;
      else if (key === 'spawn-backend') config.spawnBackend = val;
      else if (key === 'mock-meta') config.mockMeta = val;
      else if (key === 'strict') config.strict = val;
      else if (key === 'headless') config.headless = val;
      else if (key === 'full-page') config.fullPage = val;
      else if (key === 'include-states') config.includeStates = val;
      else if (key === 'seed-fixtures') {
        config.seedFixtures = val;
        config.seedFixturesExplicit = true;
      } else if (key === 'seed-myerp-showcase') {
        config.seedMyerpShowcase = val;
      } else if (key === 'with-showcase-tenants') {
        config.withShowcaseTenants = val;
      }
      continue;
    }

    if (valueFlags.has(key)) {
      let val = inlineVal;
      if (val === undefined) {
        if (i + 1 >= argv.length || argv[i + 1].startsWith('--')) {
          throw new Error(`Missing value for --${key}.`);
        }
        val = argv[++i];
      }
      if (key === 'mode') config.mode = val.trim().toLowerCase();
      else if (key === 'out-dir') config.outDir = val.trim();
      else if (key === 'data-dir') config.dataDir = path.resolve(val.trim());
      else if (key === 'backend-url' || key === 'api-url') config.backendUrl = val.trim().replace(/\/+$/, '');
      else if (key === 'frontend-url' || key === 'erp-url' || key === 'base-url') {
        config.frontendUrl = val.trim().replace(/\/+$/, '');
      } else if (key === 'landing-url') config.landingUrl = val.trim().replace(/\/+$/, '');
      else if (key === 'erp-dir') config.erpDir = path.resolve(val.trim());
      else if (key === 'landing-dir') config.landingDir = path.resolve(val.trim());
      else if (key === 'chrome-path') config.chromePath = val.trim();
      else if (key === 'viewports') config.viewportsRaw = val.trim();
      else if (key === 'routes') config.routesFilter = parseCsvList(val);
      else if (key === 'captures') config.capturesFilter = parseCsvList(val);
      else if (key === 'timeout-ms') {
        const parsed = Number(val);
        if (!Number.isFinite(parsed) || parsed < 2000) {
          throw new Error(`Invalid --timeout-ms "${val}". Must be a number >= 2000.`);
        }
        config.timeoutMs = Math.round(parsed);
      } else if (key === 'token') config.token = val.trim();
      else if (key === 'tenant-slug') config.tenantSlug = val.trim().toLowerCase();
      else if (key === 'email') config.email = val.trim();
      else if (key === 'password') config.password = val;
      continue;
    }

    throw new Error(`Unknown CLI flag "--${key}". Run with --help for supported options.`);
  }

  if (config.dataDir) {
    const base = path.basename(config.dataDir).toLowerCase();
    if (
      base === '.autodata-pgdata' ||
      base === '.autodata-pgdata-preview' ||
      base === '.autodata-pgdata.bak' ||
      base === '.autodata-pgdata-erp-capture' ||
      base === '.autodata-pgdata-erp-staging'
    ) {
      throw new Error(`Refusing protected --data-dir "${config.dataDir}". Use an isolated showcase directory.`);
    }
  }

  if (config.seedMyerpShowcase) {
    if (!config.seedFixturesExplicit) config.seedFixtures = false;
    if (!config.dataDir) config.dataDir = path.join(REPO_ROOT, '.autodata-pgdata-myerp-showcase');
    if (!config.tenantSlug) config.tenantSlug = 'ideas';
  }

  if (!VALID_MODES.has(config.mode)) {
    throw new Error(`Invalid --mode "${config.mode}". Allowed values: ${Array.from(VALID_MODES).join(', ')}.`);
  }

  config.viewports = parseViewports(config.viewportsRaw);
  config.outDirAbs = path.resolve(REPO_ROOT, config.outDir);

  return config;
}

function printHelp() {
  const text = `
Local Paired UI/UX Screenshot Comparison & Automated DOM/Style Audit Harness
Plan ID: PLAN-M4-UIUX-COMPARE-001 (docs/SCREENSHOT_COMPARISON_PLAN.md)

USAGE:
  node scripts/compare_marketing_ui_screenshots.mjs [options]

CORE OPTIONS:
  --help, -h                      Show this usage guide and exit 0
  --mode=<mode>                   Target surface mode (default: all)
                                  Values: all | portal | standalone | reference | landing | erp | zalo_demo
  --out-dir=<path>                Output directory for PNGs, audit-report.json & summary.md
                                  (default: ${DEFAULT_OUT_DIR})
  --dry-run                       Print resolved browser, ports/URLs & full A01-E08 capture plan
                                  without launching Chrome, spawning servers, or writing files (exit 0)
  --json                          Output --dry-run plan as machine-readable JSON
  --strict                        Exit non-zero (1) if any automated audit check or capture fails

SERVER & NETWORK OPTIONS:
  --spawn-backend                 Spawn ephemeral AUTO_DATA_TENANRT backend (in-memory PGlite + Express
                                  via tsx wrapper of tests/e2e-marketing/_harness.ts, OR persistent
                                  isolated showcase PGlite when --data-dir / --seed-myerp-showcase is set)
  --data-dir=<path>               Isolated persistent PGlite directory (never touches .autodata-pgdata)
  --seed-myerp-showcase           Use migrated MYERP showcase DB (.autodata-pgdata-myerp-showcase,
                                  tenant "ideas" + OUTBOUND_SILENT_MODE=true; defaults --seed-fixtures=false)
  --spawn-vite                    Spawn DOMATION_ERP_FULL (and DOMATION_LANDINGPAGE when needed) directly
                                  via node_modules/vite/bin/vite.js on free loopback ports
                                  (NEVER invokes npm run dev or sync-unified-shared.cjs)
  --mock-meta                     Mock Meta Graph / dom-meta / external endpoints cleanly offline
                                  and inject window.__DOM_META_PREVIEW__ on landing /meta-report
  --backend-url=<url>             Existing backend API origin (alias: --api-url; default: ${DEFAULT_BACKEND_URL})
  --frontend-url=<url>            Existing DOMATION_ERP_FULL URL (aliases: --erp-url, --base-url; default: ${DEFAULT_ERP_URL})
  --landing-url=<url>             Existing DOMATION_LANDINGPAGE URL (default: ${DEFAULT_LANDING_URL})
  --erp-dir=<path>                Override DOMATION_ERP_FULL repo directory (env: DOMATION_ERP_DIR)
  --landing-dir=<path>            Override DOMATION_LANDINGPAGE repo directory (env: DOMATION_LANDINGPAGE_DIR)

CAPTURE & FILTER OPTIONS:
  --viewports=<WxH,...>           Comma-separated viewports (default: ${DEFAULT_VIEWPORTS_RAW})
  --routes=<r1,r2,...>            Optional route filter (e.g. /data,/meta-report,/marketing,/marketing/flows)
  --captures=<id1,id2,...>        Optional capture ID / prefix filter (e.g. A01,B02,C01,D01)
  --include-states=<true|false>   Include interactive modal/drawer/tour/splash states (default: true)
  --seed-fixtures=<true|false>    Seed sample contacts/audience/template/flow/campaign/survey/voucher (default: true)
  --full-page=<true|false>        Capture fullPage screenshots instead of viewport frame (default: false)
  --headless=<true|false>         Run Chrome/Edge headless (default: true)
  --chrome-path=<path>            Explicit Chrome/Edge binary override (env: CHROME_PATH, PUPPETEER_EXECUTABLE_PATH)
  --timeout-ms=<ms>               Navigation/wait timeout in milliseconds (default: ${DEFAULT_TIMEOUT_MS})

OPTIONAL AUTH OVERRIDES (external backend):
  --token=<jwt>                   Existing access token (requires --tenant-slug)
  --tenant-slug=<slug>            Existing tenant slug
  --email=<email>                 Existing account email for /api/v1/auth/login
  --password=<pw>                 Existing account password for /api/v1/auth/login

EXAMPLES:
  # 1. Dry-run preflight (zero browser/server launch)
  node scripts/compare_marketing_ui_screenshots.mjs --dry-run

  # 2. Fully self-contained ephemeral run (in-memory PGlite + direct Vite + offline Meta mocks)
  node scripts/compare_marketing_ui_screenshots.mjs --mode=all --spawn-backend --spawn-vite --mock-meta

  # 3. Strict M4/M5 acceptance gate against running local stack
  node scripts/compare_marketing_ui_screenshots.mjs --mode=all --backend-url=http://127.0.0.1:3100 --frontend-url=http://127.0.0.1:5174 --landing-url=http://127.0.0.1:5173 --mock-meta --strict

  # 4. Targeted mobile + portal subset
  node scripts/compare_marketing_ui_screenshots.mjs --mode=portal --viewports=1440x900,390x844 --routes=/data,/meta-report,/marketing,/marketing/flows --spawn-backend --spawn-vite
`.trim();
  console.log(text);
}

// ============================================================================
// Browser & Repo Resolution (ported from tests/e2e-marketing/_browser-harness.ts)
// ============================================================================

function resolveBrowserExecutable(cliChromePath, { allowMissing = false } = {}) {
  const explicit = cliChromePath?.trim() || process.env.CHROME_PATH?.trim();
  if (explicit) {
    if (!fs.existsSync(explicit)) {
      throw new Error(`Browser executable does not exist: "${explicit}"`);
    }
    return { path: explicit, source: cliChromePath ? '--chrome-path' : 'CHROME_PATH' };
  }

  const candidates = [
    { source: 'PUPPETEER_EXECUTABLE_PATH', path: process.env.PUPPETEER_EXECUTABLE_PATH?.trim() },
    { source: 'CHROME_BIN', path: process.env.CHROME_BIN?.trim() },
    // Windows system Chrome & Edge
    { source: 'win32-chrome', path: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe' },
    { source: 'win32-chrome-x86', path: 'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe' },
    { source: 'win32-edge-x86', path: 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe' },
    { source: 'win32-edge', path: 'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe' },
    // macOS / Linux fallbacks
    { source: 'darwin-chrome', path: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' },
    { source: 'darwin-edge', path: '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge' },
    { source: 'linux-chrome', path: '/usr/bin/google-chrome' },
    { source: 'linux-chromium', path: '/usr/bin/chromium' },
    { source: 'linux-chromium-browser', path: '/usr/bin/chromium-browser' },
  ].filter((c) => Boolean(c.path));

  for (const candidate of candidates) {
    if (fs.existsSync(candidate.path)) {
      return candidate;
    }
  }

  if (allowMissing) {
    return { path: null, source: 'not-found' };
  }

  throw new Error(
    `No Chrome or Edge executable found. Checked --chrome-path, CHROME_PATH, PUPPETEER_EXECUTABLE_PATH, CHROME_BIN, and: ${candidates
      .map((c) => c.path)
      .join(', ')}`
  );
}

function resolveRepoEnvironment(config) {
  const erpDir = path.resolve(config.erpDir);
  const landingDir = path.resolve(config.landingDir);
  const erpViteBin = path.join(erpDir, 'node_modules', 'vite', 'bin', 'vite.js');
  const landingViteBin = path.join(landingDir, 'node_modules', 'vite', 'bin', 'vite.js');
  const tsxCli = path.join(REPO_ROOT, 'node_modules', 'tsx', 'dist', 'cli.mjs');
  const harnessPath = path.join(REPO_ROOT, 'tests', 'e2e-marketing', '_harness.ts');

  return {
    repoRoot: REPO_ROOT,
    erpDir,
    erpDirExists: fs.existsSync(erpDir),
    erpViteBin,
    erpViteBinExists: fs.existsSync(erpViteBin),
    landingDir,
    landingDirExists: fs.existsSync(landingDir),
    landingViteBin,
    landingViteBinExists: fs.existsSync(landingViteBin),
    tsxCli,
    tsxCliExists: fs.existsSync(tsxCli),
    harnessPath,
    harnessExists: fs.existsSync(harnessPath),
  };
}

// ============================================================================
// Capture Plan Builder & Dry-Run Renderer
// ============================================================================

function matchesMode(entry, mode) {
  if (mode === 'all') return true;
  if (mode === 'erp') return entry.mode === 'portal' || entry.mode === 'standalone' || entry.mode === 'zalo_demo';
  if (mode === 'portal') return entry.mode === 'portal';
  if (mode === 'standalone') return entry.mode === 'standalone';
  if (mode === 'zalo_demo') return entry.mode === 'zalo_demo';
  if (mode === 'reference') return entry.surfaces.includes('reference');
  if (mode === 'landing') return entry.surfaces.includes('landing');
  return false;
}

function matchesRouteFilter(route, routesFilter) {
  if (!routesFilter || routesFilter.length === 0) return true;
  const cleanRoute = route.split('?')[0];
  return routesFilter.some((f) => {
    const cleanFilter = (f.startsWith('/') ? f : `/${f}`).split('?')[0];
    return cleanRoute === cleanFilter || route === f || cleanRoute.startsWith(`${cleanFilter}/`);
  });
}

function matchesCaptureFilter(captureId, capturesFilter) {
  if (!capturesFilter || capturesFilter.length === 0) return true;
  const lowerId = captureId.toLowerCase();
  return capturesFilter.some((f) => {
    const needle = f.toLowerCase();
    return lowerId === needle || lowerId.startsWith(needle);
  });
}

function buildCapturePlan(config) {
  const desktopViewports = config.viewports.filter((v) => !v.isMobile);
  const mobileViewports = config.viewports.filter((v) => v.isMobile);

  const items = [];
  for (const entry of CAPTURE_MATRIX) {
    if (!matchesMode(entry, config.mode)) continue;
    if (entry.requiresZaloDemo && !config.withShowcaseTenants && !config.seedMyerpShowcase && config.mode !== 'zalo_demo') continue;
    if (!config.includeStates && entry.isInteractiveState) continue;
    if (!matchesRouteFilter(entry.route, config.routesFilter)) continue;
    if (!matchesCaptureFilter(entry.id, config.capturesFilter)) continue;

    const targetViewports = entry.deviceClass === 'mobile' ? mobileViewports : desktopViewports;
    if (targetViewports.length === 0) continue;

    const effectiveMode =
      config.mode === 'landing' && entry.fallbackLanding ? 'landing' : entry.mode;

    for (const vp of targetViewports) {
      const relPath = path.posix.join(vp.label, `${entry.id}.png`);
      items.push({
        ...entry,
        effectiveMode,
        viewport: vp,
        relScreenshotPath: relPath,
        absScreenshotPath: path.join(config.outDirAbs, vp.label, `${entry.id}.png`),
      });
    }
  }

  const needsLanding = items.some((i) => i.effectiveMode === 'landing');
  const needsPortal = items.some((i) => i.effectiveMode === 'portal');
  const needsStandalone = items.some((i) => i.effectiveMode === 'standalone');
  const needsZaloDemo = items.some((i) => i.effectiveMode === 'zalo_demo');
  const needsErp = needsPortal || needsStandalone || needsZaloDemo;
  const needsBackend = needsErp || (needsLanding && !config.mockMeta);

  return {
    items,
    needsLanding,
    needsPortal,
    needsStandalone,
    needsZaloDemo,
    needsErp,
    needsBackend,
  };
}

function printDryRunOutput(config, plan, browserInfo, repoEnv) {
  const resolvedBackend = config.spawnBackend
    ? config.dataDir || config.seedMyerpShowcase
      ? `http://127.0.0.1:<showcase-pglite> (--spawn-backend + --data-dir=${config.dataDir || '.autodata-pgdata-myerp-showcase'})`
      : 'http://127.0.0.1:<ephemeral-pglite> (--spawn-backend via tsx _harness.ts)'
    : config.backendUrl || DEFAULT_BACKEND_URL;
  const resolvedErp = !plan.needsErp
    ? '(not required for selected mode)'
    : config.frontendUrl
      ? config.frontendUrl
      : config.spawnVite
        ? 'http://127.0.0.1:<ephemeral-vite> (--spawn-vite via DOMATION_ERP_FULL/node_modules/vite/bin/vite.js)'
        : DEFAULT_ERP_URL;
  const resolvedLanding = !plan.needsLanding
    ? '(not required for selected mode)'
    : config.landingUrl
      ? config.landingUrl
      : config.spawnVite
        ? 'http://127.0.0.1:<ephemeral-vite> (--spawn-vite via DOMATION_LANDINGPAGE/node_modules/vite/bin/vite.js)'
        : DEFAULT_LANDING_URL;

  const payload = {
    dryRun: true,
    planId: 'PLAN-M4-UIUX-COMPARE-001',
    mode: config.mode,
    outDir: config.outDir,
    outDirAbs: config.outDirAbs,
    viewports: config.viewports.map((v) => v.label),
    flags: {
      spawnBackend: config.spawnBackend,
      spawnVite: config.spawnVite,
      mockMeta: config.mockMeta,
      strict: config.strict,
      headless: config.headless,
      fullPage: config.fullPage,
      includeStates: config.includeStates,
      seedFixtures: config.seedFixtures,
      seedMyerpShowcase: config.seedMyerpShowcase,
      dataDir: config.dataDir,
      tenantSlug: config.tenantSlug,
    },
    browser: browserInfo,
    endpoints: {
      backendUrl: resolvedBackend,
      erpUrl: resolvedErp,
      landingUrl: resolvedLanding,
    },
    repositories: {
      autoDataTenant: repoEnv.repoRoot,
      domationErpFull: {
        dir: repoEnv.erpDir,
        exists: repoEnv.erpDirExists,
        viteBin: repoEnv.erpViteBin,
        viteBinExists: repoEnv.erpViteBinExists,
        syncUnifiedSharedInvoked: false,
      },
      domationLandingpage: {
        dir: repoEnv.landingDir,
        exists: repoEnv.landingDirExists,
        viteBin: repoEnv.landingViteBin,
        viteBinExists: repoEnv.landingViteBinExists,
      },
    },
    automatedChecks: ALL_CHECK_IDS.map((id) => ({
      id,
      category: AUDIT_CHECK_META[id].category,
      expected: AUDIT_CHECK_META[id].expected,
    })),
    artifacts: {
      auditReportJson: path.posix.join(config.outDir.replace(/\\/g, '/'), 'audit-report.json'),
      summaryMd: path.posix.join(config.outDir.replace(/\\/g, '/'), 'summary.md'),
    },
    totalCaptures: plan.items.length,
    captures: plan.items.map((item, idx) => ({
      index: idx + 1,
      id: item.id,
      group: item.group,
      mode: item.effectiveMode,
      viewport: item.viewport.label,
      route: item.route,
      state: item.state,
      outputPath: path.posix.join(config.outDir.replace(/\\/g, '/'), item.relScreenshotPath),
      checks: item.checks,
    })),
  };

  if (config.json) {
    console.log(JSON.stringify(payload, null, 2));
    return;
  }

  console.log('================================================================================');
  console.log('DOMATION UI/UX Screenshot Comparison & Audit Harness — DRY-RUN PLAN');
  console.log('Plan ID : PLAN-M4-UIUX-COMPARE-001 (docs/SCREENSHOT_COMPARISON_PLAN.md)');
  console.log('================================================================================');
  console.log(`Mode               : ${config.mode}`);
  console.log(`Viewports          : ${config.viewports.map((v) => v.label).join(', ')}`);
  console.log(`Output Directory   : ${config.outDir} (${config.outDirAbs})`);
  console.log(`Browser Executable : ${browserInfo.path || 'NOT FOUND'} (${browserInfo.source})`);
  console.log(`Backend Origin     : ${resolvedBackend}`);
  console.log(`ERP Origin         : ${resolvedErp}`);
  console.log(`Landing Origin     : ${resolvedLanding}`);
  console.log(
    `Flags              : spawnBackend=${config.spawnBackend} spawnVite=${config.spawnVite} mockMeta=${config.mockMeta} strict=${config.strict} headless=${config.headless} includeStates=${config.includeStates} seedFixtures=${config.seedFixtures}`
  );
  console.log(
    `Repo Readiness     : ERP vite.js=${repoEnv.erpViteBinExists ? 'OK' : 'MISSING'} | Landing vite.js=${repoEnv.landingViteBinExists ? 'OK' : 'MISSING'} | tsx=${repoEnv.tsxCliExists ? 'OK' : 'MISSING'} | sync-unified-shared.cjs=NEVER_INVOKED`
  );
  console.log(`Artifacts          : ${payload.artifacts.auditReportJson}, ${payload.artifacts.summaryMd}`);
  console.log('');
  console.log(`Automated Audit Checks (${ALL_CHECK_IDS.length}):`);
  for (const id of ALL_CHECK_IDS) {
    console.log(`  - ${id.padEnd(32)} [${AUDIT_CHECK_META[id].category}]`);
  }
  console.log('');
  console.log(`Planned Captures (${plan.items.length} total):`);
  console.log('  #  | Capture ID                               | Mode       | Viewport | Route                          | Output Path');
  console.log('  ---+------------------------------------------+------------+----------+--------------------------------+---------------------------------------------------------------');
  for (let i = 0; i < plan.items.length; i++) {
    const item = plan.items[i];
    const num = String(i + 1).padStart(2, ' ');
    const idCol = item.id.padEnd(40, ' ');
    const modeCol = item.effectiveMode.padEnd(10, ' ');
    const vpCol = item.viewport.label.padEnd(8, ' ');
    const routeCol = item.route.padEnd(30, ' ');
    const outCol = path.posix.join(config.outDir.replace(/\\/g, '/'), item.relScreenshotPath);
    console.log(`  ${num} | ${idCol} | ${modeCol} | ${vpCol} | ${routeCol} | ${outCol}`);
  }
  console.log('');
  console.log('[DRY-RUN] Zero browsers launched, zero child servers spawned, zero files written.');
}

// ============================================================================
// Process & Port Management (clean Windows process-tree teardown)
// ============================================================================

async function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function findFreeLoopbackPort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      srv.close((err) => (err ? reject(err) : resolve(port)));
    });
  });
}

async function killProcessTree(proc) {
  if (!proc) return;
  try {
    proc.stdout?.removeAllListeners();
    proc.stderr?.removeAllListeners();
    proc.stdout?.destroy();
    proc.stderr?.destroy();
  } catch {
    // ignore stream teardown errors
  }

  if (proc.exitCode !== null || proc.signalCode !== null) {
    try {
      proc.unref();
    } catch {
      // ignore
    }
    return;
  }

  if (process.platform === 'win32' && proc.pid) {
    await execFileAsync('taskkill', ['/pid', String(proc.pid), '/f', '/t'], {
      windowsHide: true,
    }).catch(() => {});
  } else {
    try {
      proc.kill('SIGTERM');
    } catch {
      // ignore
    }
    await Promise.race([
      new Promise((resolve) => proc.once('exit', () => resolve())),
      sleep(2000),
    ]);
    if (proc.exitCode === null && proc.signalCode === null) {
      try {
        proc.kill('SIGKILL');
      } catch {
        // ignore
      }
    }
  }
  try {
    proc.unref();
  } catch {
    // ignore
  }
}

function createRingLogger(maxBytes = 12_288) {
  const chunks = [];
  let bytes = 0;
  return {
    append(chunk) {
      const str = typeof chunk === 'string' ? chunk : chunk.toString('utf8');
      chunks.push(str);
      bytes += str.length;
      while (bytes > maxBytes && chunks.length > 1) {
        const shifted = chunks.shift();
        bytes -= shifted.length;
      }
    },
    text() {
      return chunks.join('');
    },
  };
}

async function waitForHttpReady(baseUrl, proc, getLogs, label, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  let exitedError = null;
  const onExit = (code, signal) => {
    exitedError = new Error(
      `${label} exited prematurely (code=${code}, signal=${signal}). Logs:\n${getLogs()}`
    );
  };
  proc?.once('exit', onExit);

  try {
    while (Date.now() < deadline) {
      if (exitedError) throw exitedError;
      try {
        const res = await fetch(`${baseUrl}/`, { signal: AbortSignal.timeout(1500) });
        if (res.ok || res.status < 500) {
          return;
        }
      } catch {
        // server still starting
      }
      await sleep(200);
    }
    throw new Error(`Timed out waiting ${timeoutMs}ms for ${label} at ${baseUrl}. Logs:\n${getLogs()}`);
  } finally {
    proc?.removeListener('exit', onExit);
  }
}

/**
 * Spawns AUTO_DATA_TENANRT ephemeral backend via tsx.
 * - Default (no --data-dir / --seed-myerp-showcase): wraps tests/e2e-marketing/_harness.ts (in-memory PGlite)
 * - Showcase (--data-dir or --seed-myerp-showcase): wraps scripts/prepare-myerp-showcase-db.ts against isolated PGlite
 */
async function spawnEphemeralBackend(repoEnv, timeoutMs = 45_000, config = null) {
  if (!repoEnv.tsxCliExists) {
    throw new Error(`tsx CLI not found at "${repoEnv.tsxCli}". Run npm install in AUTO_DATA_TENANRT.`);
  }

  const useShowcaseDb = Boolean(config?.dataDir || config?.seedMyerpShowcase);
  let bootstrapCode = '';
  let childEnv = { ...process.env };

  if (useShowcaseDb) {
    const showcaseHelperPath = path.join(repoEnv.repoRoot, 'scripts', 'prepare-myerp-showcase-db.ts');
    if (!fs.existsSync(showcaseHelperPath)) {
      throw new Error(`Showcase DB helper not found at "${showcaseHelperPath}".`);
    }
    const effectiveDataDir = config?.dataDir || path.join(repoEnv.repoRoot, '.autodata-pgdata-myerp-showcase');
    const showcaseHelperUrl = pathToFileURL(showcaseHelperPath).href;
    const withStandaloneShowcase = Boolean(
      config?.withShowcaseTenants ||
        (config?.seedMyerpShowcase && ['all', 'erp', 'standalone', 'zalo_demo'].includes(config?.mode))
    );
    childEnv = {
      ...childEnv,
      OUTBOUND_SILENT_MODE: 'true',
      TELEGRAM_NOTIFY_ENABLED: 'false',
      TELEGRAM_SILENT_MODE: 'true',
      MIGRATION_SILENT_MODE: 'true',
      PGLITE_DATA_DIR: effectiveDataDir,
    };
    bootstrapCode = `
      (async () => {
        const { startShowcaseBackendServer } = await import(${JSON.stringify(showcaseHelperUrl)});
        const srv = await startShowcaseBackendServer({
          dataDir: ${JSON.stringify(effectiveDataDir)},
          tenantSlug: ${JSON.stringify(config?.tenantSlug || 'ideas')},
          withShowcaseTenants: ${JSON.stringify(withStandaloneShowcase)},
          runMigrations: true,
        });
        process.stdout.write('__BACKEND_READY__:' + JSON.stringify({
          baseUrl: srv.baseUrl,
          cronSecret: srv.cronSecret,
          portalAuth: srv.portalAuth,
          standaloneAuth: srv.standaloneAuth,
          zaloDemoAuth: srv.zaloDemoAuth,
        }) + '\\n');
        let closing = false;
        const shutdown = async () => {
          if (closing) return;
          closing = true;
          try { await srv.teardown(); } catch {}
          process.exit(0);
        };
        process.stdin.resume();
        process.stdin.setEncoding('utf8');
        process.stdin.on('data', (chunk) => {
          if (String(chunk).includes('SHUTDOWN')) void shutdown();
        });
        process.stdin.on('end', () => void shutdown());
        process.on('SIGINT', () => void shutdown());
        process.on('SIGTERM', () => void shutdown());
      })().catch((err) => {
        console.error(err instanceof Error ? err.stack || err.message : String(err));
        process.exit(1);
      });
    `;
  } else {
    if (!repoEnv.harnessExists) {
      throw new Error(`Marketing E2E harness not found at "${repoEnv.harnessPath}".`);
    }
    const harnessUrl = pathToFileURL(repoEnv.harnessPath).href;
    bootstrapCode = `
      (async () => {
        const { startMarketingE2eHarness } = await import(${JSON.stringify(harnessUrl)});
        const harness = await startMarketingE2eHarness();
        process.stdout.write('__BACKEND_READY__:' + JSON.stringify({
          baseUrl: harness.baseUrl,
          cronSecret: harness.cronSecret,
        }) + '\\n');
        let closing = false;
        const shutdown = async () => {
          if (closing) return;
          closing = true;
          try { await harness.teardown(); } catch {}
          process.exit(0);
        };
        process.stdin.resume();
        process.stdin.setEncoding('utf8');
        process.stdin.on('data', (chunk) => {
          if (String(chunk).includes('SHUTDOWN')) void shutdown();
        });
        process.stdin.on('end', () => void shutdown());
        process.on('SIGINT', () => void shutdown());
        process.on('SIGTERM', () => void shutdown());
      })().catch((err) => {
        console.error(err instanceof Error ? err.stack || err.message : String(err));
        process.exit(1);
      });
    `;
  }

  const logs = createRingLogger(16_384);
  const proc = spawn(process.execPath, [repoEnv.tsxCli, '-e', bootstrapCode], {
    cwd: repoEnv.repoRoot,
    env: childEnv,
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  });

  const readyInfo = await new Promise((resolve, reject) => {
    let stdoutBuf = '';
    const timer = setTimeout(() => {
      reject(new Error(`Timed out waiting ${timeoutMs}ms for ephemeral backend. Logs:\n${logs.text()}`));
    }, timeoutMs);

    const onExit = (code, signal) => {
      clearTimeout(timer);
      reject(
        new Error(`Ephemeral backend exited before ready (code=${code}, signal=${signal}). Logs:\n${logs.text()}`)
      );
    };

    proc.once('exit', onExit);
    proc.stderr?.on('data', (chunk) => logs.append(chunk));
    proc.stdout?.on('data', (chunk) => {
      const str = chunk.toString('utf8');
      logs.append(str);
      stdoutBuf += str;
      const lines = stdoutBuf.split(/\r?\n/);
      stdoutBuf = lines.pop() || '';
      for (const line of lines) {
        const idx = line.indexOf('__BACKEND_READY__:');
        if (idx >= 0) {
          try {
            const parsed = JSON.parse(line.slice(idx + '__BACKEND_READY__:'.length));
            clearTimeout(timer);
            proc.removeListener('exit', onExit);
            resolve(parsed);
            return;
          } catch (err) {
            clearTimeout(timer);
            proc.removeListener('exit', onExit);
            reject(new Error(`Failed to parse __BACKEND_READY__ payload: ${err.message}`));
            return;
          }
        }
      }
    });
  }).catch(async (err) => {
    await killProcessTree(proc);
    throw err;
  });

  return {
    proc,
    baseUrl: String(readyInfo.baseUrl).replace(/\/+$/, ''),
    cronSecret: String(readyInfo.cronSecret || ''),
    portalAuth: readyInfo.portalAuth || null,
    standaloneAuth: readyInfo.standaloneAuth || null,
    zaloDemoAuth: readyInfo.zaloDemoAuth || null,
    async stop() {
      try {
        if (proc.stdin?.writable) {
          proc.stdin.write('SHUTDOWN\n');
          proc.stdin.end();
        }
      } catch {
        // ignore
      }
      await Promise.race([
        new Promise((resolve) => proc.once('exit', () => resolve())),
        sleep(1500),
      ]);
      await killProcessTree(proc);
    },
  };
}

/**
 * Spawns Vite directly via `node <repo>/node_modules/vite/bin/vite.js` (NEVER invoking npm or sync-unified-shared.cjs).
 */
async function spawnViteServer({ cwd, viteBin, envOverrides, label, timeoutMs = 30_000 }) {
  if (!fs.existsSync(cwd)) {
    throw new Error(`${label} directory not found: "${cwd}"`);
  }
  if (!fs.existsSync(viteBin)) {
    throw new Error(`${label} Vite binary not found: "${viteBin}"`);
  }

  const port = await findFreeLoopbackPort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const logs = createRingLogger(12_288);

  const proc = spawn(
    process.execPath,
    [viteBin, '--port', String(port), '--host', '127.0.0.1', '--strictPort'],
    {
      cwd,
      env: {
        ...process.env,
        ...envOverrides,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    }
  );
  proc.stdout?.on('data', (chunk) => logs.append(chunk));
  proc.stderr?.on('data', (chunk) => logs.append(chunk));

  try {
    await waitForHttpReady(baseUrl, proc, () => logs.text(), label, timeoutMs);
  } catch (err) {
    await killProcessTree(proc);
    throw err;
  }

  return {
    proc,
    port,
    baseUrl,
    async stop() {
      await killProcessTree(proc);
    },
  };
}

// ============================================================================
// Backend Auth Provisioning & Fixture Seeding
// ============================================================================

async function apiRequest(backendBaseUrl, reqPath, { method = 'GET', token, tenantSlug, headers = {}, body } = {}) {
  const url = `${backendBaseUrl}${reqPath.startsWith('/') ? reqPath : `/${reqPath}`}`;
  const finalHeaders = {
    Accept: 'application/json',
    ...headers,
  };
  if (token) finalHeaders.Authorization = `Bearer ${token}`;
  if (tenantSlug) finalHeaders['X-Tenant-Slug'] = tenantSlug;
  if (body !== undefined && !finalHeaders['Content-Type']) {
    finalHeaders['Content-Type'] = 'application/json';
  }

  const resp = await fetch(url, {
    method,
    headers: finalHeaders,
    body: body !== undefined ? (typeof body === 'string' ? body : JSON.stringify(body)) : undefined,
    signal: AbortSignal.timeout(20_000),
  });
  const rawText = await resp.text();
  let json = {};
  try {
    json = rawText ? JSON.parse(rawText) : {};
  } catch {
    json = {};
  }
  return { status: resp.status, ok: resp.ok, json, rawText };
}

async function apiJson(backendBaseUrl, reqPath, opts) {
  const res = await apiRequest(backendBaseUrl, reqPath, opts);
  if (!res.ok) {
    throw new Error(`HTTP ${res.status} ${opts?.method || 'GET'} ${reqPath}: ${res.rawText.slice(0, 400)}`);
  }
  return res.json;
}

function formatShowcaseAuthForUi(rawAuth, fallbackPackageCode) {
  if (!rawAuth) return null;
  const tenantSlug = String(rawAuth.tenantSlug || 'ideas').toLowerCase();
  const packageCode = String(rawAuth.packageCode || fallbackPackageCode || 'growth_combo').toLowerCase();
  return {
    accessToken: String(rawAuth.accessToken || ''),
    refreshToken: rawAuth.refreshToken ? String(rawAuth.refreshToken) : undefined,
    tenantId: String(rawAuth.tenantId || ''),
    tenantSlug,
    packageCode,
    user: {
      id: String(rawAuth.userId || 'showcase_admin'),
      role: String(rawAuth.role || 'tenant_admin'),
      email: String(rawAuth.email || ''),
      full_name: String(rawAuth.fullName || rawAuth.email || ''),
      name: String(rawAuth.fullName || rawAuth.email || ''),
      tenant_id: String(rawAuth.tenantId || ''),
      tenant_slug: tenantSlug,
      package_code: packageCode,
    },
  };
}

async function resolveExistingMarketingFixtures(backendBaseUrl, auth) {
  const reqAuth = { token: auth.accessToken, tenantSlug: auth.tenantSlug };
  const fixtures = {
    contactId: null,
    audienceId: null,
    templateId: null,
    flowId: null,
    flowName: 'Flow',
    emailStepId: 'step_email_ui_1',
    znsStepId: 'step_zns_ui_1',
    campaignId: null,
    campaignName: 'Campaign',
    surveyId: null,
    surveyTitle: 'Survey',
    voucherId: null,
  };

  try {
    const flowsRes = await apiJson(backendBaseUrl, '/api/v1/marketing/flows', reqAuth);
    const flows = Array.isArray(flowsRes?.data?.items)
      ? flowsRes.data.items
      : Array.isArray(flowsRes?.data)
        ? flowsRes.data
        : [];
    const sorted = [...flows].sort((a, b) => Number(b.enrolled_count || 0) - Number(a.enrolled_count || 0));
    const hasEmailStep = (f) =>
      Array.isArray(f.steps) &&
      f.steps.some((s) => ['action', 'send_email'].includes(String(s?.type || '').toLowerCase()));
    const hasBoundEmailStep = (f) =>
      Array.isArray(f.steps) &&
      f.steps.some(
        (s) =>
          ['action', 'send_email'].includes(String(s?.type || '').toLowerCase()) &&
          Boolean(s?.config?.template_id || s?.config?.templateId)
      );
    const hasZnsStep = (f) =>
      Array.isArray(f.steps) &&
      f.steps.some((s) => ['zalo_zns', 'send_zns'].includes(String(s?.type || '').toLowerCase()));
    const chosen =
      sorted.find((f) => Number(f.enrolled_count || 0) > 0 && hasBoundEmailStep(f) && hasZnsStep(f)) ||
      sorted.find((f) => Number(f.enrolled_count || 0) > 0 && hasBoundEmailStep(f) && Array.isArray(f.steps) && f.steps.length >= 2) ||
      sorted.find((f) => Number(f.enrolled_count || 0) > 0 && hasEmailStep(f) && Array.isArray(f.steps) && f.steps.length >= 2) ||
      sorted.find((f) => hasEmailStep(f) && hasZnsStep(f)) ||
      sorted.find((f) => hasBoundEmailStep(f) && Array.isArray(f.steps) && f.steps.length >= 2) ||
      sorted.find((f) => hasEmailStep(f) && Array.isArray(f.steps) && f.steps.length >= 2) ||
      sorted.find((f) => Array.isArray(f.steps) && f.steps.length >= 2) ||
      sorted[0];
    if (chosen) {
      fixtures.flowId = String(chosen.id || '');
      fixtures.flowName = String(chosen.name || 'Flow');
      const steps = Array.isArray(chosen.steps) ? chosen.steps : [];
      const emailStep =
        steps.find(
          (s) =>
            ['action', 'send_email'].includes(String(s?.type || '').toLowerCase()) &&
            Boolean(s?.config?.template_id || s?.config?.templateId)
        ) || steps.find((s) => ['action', 'send_email'].includes(String(s?.type || '').toLowerCase()));
      const znsStep = steps.find((s) => ['zalo_zns', 'send_zns'].includes(String(s?.type || '').toLowerCase()));
      if (emailStep?.id) fixtures.emailStepId = String(emailStep.id);
      if (znsStep?.id) fixtures.znsStepId = String(znsStep.id);
    }
    const richAnalyticsFlow =
      sorted.find((f) => Number(f.enrolled_count || 0) > 0 && Array.isArray(f.steps) && f.steps.length >= 2) ||
      sorted.find((f) => Number(f.enrolled_count || 0) > 0) ||
      chosen;
    if (richAnalyticsFlow) {
      fixtures.analyticsFlowId = String(richAnalyticsFlow.id || '');
      fixtures.analyticsFlowName = String(richAnalyticsFlow.name || fixtures.flowName || 'Flow');
    }
  } catch {
    // non-fatal
  }

  try {
    const campsRes = await apiJson(backendBaseUrl, '/api/v1/marketing/campaigns', reqAuth);
    const camps = Array.isArray(campsRes?.data?.items)
      ? campsRes.data.items
      : Array.isArray(campsRes?.data)
        ? campsRes.data
        : [];
    const sortedCamps = [...camps].sort((a, b) => Number(b.sent_count || 0) - Number(a.sent_count || 0));
    const chosenCamp = sortedCamps.find((c) => Number(c.sent_count || 0) > 0) || sortedCamps[0];
    if (chosenCamp) {
      fixtures.campaignId = String(chosenCamp.id || '');
      fixtures.campaignName = String(chosenCamp.name || 'Campaign');
    }
  } catch {
    // non-fatal
  }

  try {
    const srvRes = await apiJson(backendBaseUrl, '/api/v1/marketing/surveys', reqAuth);
    const surveys = Array.isArray(srvRes?.data?.items)
      ? srvRes.data.items
      : Array.isArray(srvRes?.data)
        ? srvRes.data
        : [];
    const sortedSurveys = [...surveys].sort(
      (a, b) => Number(b.response_count || 0) - Number(a.response_count || 0)
    );
    const chosenSrv = sortedSurveys.find((s) => Number(s.response_count || 0) > 0) || sortedSurveys[0];
    if (chosenSrv) {
      fixtures.surveyId = String(chosenSrv.id || '');
      fixtures.surveyTitle = String(chosenSrv.title || 'Survey');
    }
  } catch {
    // non-fatal
  }

  try {
    const vRes = await apiJson(backendBaseUrl, '/api/v1/marketing/vouchers', reqAuth);
    const pools = Array.isArray(vRes?.data?.items) ? vRes.data.items : [];
    if (pools[0]?.id) fixtures.voucherId = String(pools[0].id);
  } catch {
    // non-fatal
  }

  try {
    const tRes = await apiJson(backendBaseUrl, '/api/v1/marketing/templates', reqAuth);
    const tpls = Array.isArray(tRes?.data?.items)
      ? tRes.data.items
      : Array.isArray(tRes?.data)
        ? tRes.data
        : [];
    if (tpls[0]?.id) fixtures.templateId = String(tpls[0].id);
  } catch {
    // non-fatal
  }

  try {
    const aRes = await apiJson(backendBaseUrl, '/api/v1/audiences', reqAuth);
    const auds = Array.isArray(aRes?.data?.items)
      ? aRes.data.items
      : Array.isArray(aRes?.data)
        ? aRes.data
        : [];
    if (auds[0]?.id) fixtures.audienceId = String(auds[0].id);
  } catch {
    // non-fatal
  }

  return fixtures;
}

async function provisionTenantAuth(backendBaseUrl, packageCode, config) {
  // Optional explicit credentials when targeting an external backend for a single mode (or Portal under --seed-myerp-showcase)
  const allowOverride =
    (config.mode !== 'all' && config.mode !== 'erp') ||
    (Boolean(config.seedMyerpShowcase) && packageCode !== 'marketing_standalone');
  if (config.token && config.tenantSlug && allowOverride) {
    let user = {
      id: 'cli_user_1',
      role: 'admin',
      email: config.email || `admin@${config.tenantSlug}.vn`,
      tenant_slug: config.tenantSlug,
      package_code: packageCode,
    };
    const meRes = await apiRequest(backendBaseUrl, '/api/v1/auth/me', {
      token: config.token,
      tenantSlug: config.tenantSlug,
    }).catch(() => null);
    if (meRes?.ok && meRes.json?.data?.user) {
      user = { ...user, ...meRes.json.data.user };
    }
    return {
      accessToken: config.token,
      refreshToken: undefined,
      tenantId: String(user.tenant_id || ''),
      tenantSlug: config.tenantSlug,
      packageCode,
      user,
    };
  }

  if (config.email && config.password && allowOverride) {
    const loginRes = await apiJson(backendBaseUrl, '/api/v1/auth/login', {
      method: 'POST',
      body: {
        email: config.email,
        password: config.password,
        ...(config.tenantSlug ? { tenant_slug: config.tenantSlug } : {}),
      },
    });
    const data = loginRes?.data || {};
    const tenant = data.tenant || {};
    const user = data.user || {};
    return {
      accessToken: String(data.access_token || ''),
      refreshToken: data.refresh_token ? String(data.refresh_token) : undefined,
      tenantId: String(tenant.id || user.tenant_id || ''),
      tenantSlug: String(tenant.slug || config.tenantSlug || ''),
      packageCode: String(tenant.package_code || packageCode),
      user: {
        ...user,
        id: user.id || 'login_user',
        role: String(user.role || 'admin'),
        email: user.email || config.email,
        tenant_id: user.tenant_id || tenant.id,
        tenant_slug: user.tenant_slug || tenant.slug || config.tenantSlug,
      },
    };
  }

  // Default: register a clean isolated tenant for this mode
  const suffix = `${Date.now().toString(36)}${crypto.randomBytes(3).toString('hex')}`;
  const slugPrefix = packageCode === 'marketing_standalone' ? 'ui-standalone' : 'ui-portal';
  const tenantSlug = `${slugPrefix}-${suffix}`.toLowerCase();
  const companyName =
    packageCode === 'marketing_standalone'
      ? `UI Audit Standalone ${suffix}`
      : `UI Audit Portal ${suffix}`;
  const workEmail = `audit+${suffix}@${tenantSlug}.vn`;
  const password = 'AuditPassword123!';

  const regRes = await apiJson(backendBaseUrl, '/api/v1/auth/register', {
    method: 'POST',
    body: {
      company_name: companyName,
      tenant_slug: tenantSlug,
      admin_name: `${companyName} Admin`,
      work_email: workEmail,
      phone: '0909111222',
      password,
      industry: 'general',
      package_code: packageCode,
      seed_demo_leads: packageCode === 'domation_promax',
    },
  });

  const data = regRes?.data || {};
  const tenant = data.tenant || {};
  const user = data.user || {};
  return {
    accessToken: String(data.access_token || ''),
    refreshToken: data.refresh_token ? String(data.refresh_token) : undefined,
    tenantId: String(tenant.id || ''),
    tenantSlug: String(tenant.slug || tenantSlug),
    packageCode: String(tenant.package_code || packageCode),
    user: {
      ...user,
      id: user.id || 'reg_user',
      role: String(user.role || 'admin'),
      email: user.email || workEmail,
      tenant_id: user.tenant_id || tenant.id,
      tenant_slug: user.tenant_slug || tenant.slug || tenantSlug,
    },
  };
}

/**
 * Seeds contacts, audience, template, 3-step flow (Trigger -> Email -> Zalo ZNS),
 * campaign, survey, and voucher so all Group C & Group D captures render populated UI.
 */
async function seedMarketingFixtures(backendBaseUrl, auth, { cronSecret = '', prefix = 'UI Audit' } = {}) {
  const reqAuth = { token: auth.accessToken, tenantSlug: auth.tenantSlug };
  const fixtures = {
    contactId: null,
    audienceId: null,
    templateId: null,
    flowId: null,
    flowName: `${prefix} Flow`,
    emailStepId: 'step_email_ui_1',
    znsStepId: 'step_zns_ui_1',
    campaignId: null,
    campaignName: `${prefix} Campaign`,
    surveyId: null,
    surveyTitle: `${prefix} Customer Survey`,
    voucherId: null,
  };

  try {
    await apiJson(backendBaseUrl, '/api/v1/auth/tenant-settings', {
      ...reqAuth,
      method: 'PATCH',
      body: {
        settings: {
          email_provider: 'resend',
          resend_api_key: 're_ui_audit_mock_key_001',
          resend_from_email: 'mkt-audit@domation.vn',
          resend_from_name: 'DOMATION UI Audit',
        },
      },
    });
  } catch {
    // non-fatal on external backends with restricted settings
  }

  try {
    const contactRes = await apiJson(backendBaseUrl, '/api/v1/audiences/contacts', {
      ...reqAuth,
      method: 'POST',
      body: {
        name: `${prefix} Contact`,
        email: `audit-${auth.tenantSlug}@domation.vn`,
        phone: '0909888777',
        email_consent: 'subscribed',
      },
    });
    fixtures.contactId = String(contactRes.data?.id || '');
  } catch (err) {
    console.warn(`[seed] Warning creating contact: ${err.message}`);
  }

  try {
    const audRes = await apiJson(backendBaseUrl, '/api/v1/audiences', {
      ...reqAuth,
      method: 'POST',
      body: {
        name: `${prefix} Audience`,
        audience_type: 'static_data',
        lead_ids: fixtures.contactId ? [fixtures.contactId] : [],
      },
    });
    fixtures.audienceId = String(audRes.data?.id || '');
  } catch (err) {
    console.warn(`[seed] Warning creating audience: ${err.message}`);
  }

  try {
    const tplRes = await apiJson(backendBaseUrl, '/api/v1/marketing/templates', {
      ...reqAuth,
      method: 'POST',
      body: {
        name: `${prefix} Email Template`,
        subject: `${prefix} Welcome {{lead.name}}`,
        compiled_html:
          '<html><body><h1>Xin chào {{lead.name}}</h1><p>Chào mừng bạn đến với DOMATION Marketing Automation.</p><a href="https://example.com/ui-audit">Khám phá ngay</a></body></html>',
      },
    });
    fixtures.templateId = String(tplRes.data?.id || '');
  } catch (err) {
    console.warn(`[seed] Warning creating template: ${err.message}`);
  }

  try {
    const flowRes = await apiJson(backendBaseUrl, '/api/v1/marketing/flows', {
      ...reqAuth,
      method: 'POST',
      body: {
        name: fixtures.flowName,
        trigger_type: 'form_submitted',
        status: 'draft',
        steps: [
          {
            id: 'step_trigger_ui_1',
            type: 'trigger',
            label: 'Khi điền Form',
            nextStepId: fixtures.emailStepId,
            config: { triggerType: 'form_submitted' },
          },
          {
            id: fixtures.emailStepId,
            type: 'action',
            label: 'Gửi Email Chào Mừng',
            nextStepId: fixtures.znsStepId,
            config: {
              subject: `${prefix} Xin chào {{first_name}}`,
              template_id: fixtures.templateId || undefined,
              sender_email: 'mkt-audit@domation.vn',
            },
          },
          {
            id: fixtures.znsStepId,
            type: 'zalo_zns',
            label: 'Gửi Tin Zalo ZNS',
            config: {
              oa_id: '',
              template_id: '',
              params: {},
            },
          },
        ],
      },
    });
    fixtures.flowId = String(flowRes.data?.id || '');
  } catch (err) {
    console.warn(`[seed] Warning creating flow: ${err.message}`);
  }

  try {
    const dueAt = new Date(Date.now() - 60_000).toISOString();
    const campRes = await apiJson(backendBaseUrl, '/api/v1/marketing/campaigns', {
      ...reqAuth,
      method: 'POST',
      body: {
        name: fixtures.campaignName,
        channel: 'email',
        audience_id: fixtures.audienceId || undefined,
        template_id: fixtures.templateId || undefined,
        subject_a: `${prefix} Campaign Offer`,
        sender_email: 'mkt-audit@domation.vn',
        scheduled_at: dueAt,
      },
    });
    fixtures.campaignId = String(campRes.data?.id || '');

    if (cronSecret) {
      await apiRequest(backendBaseUrl, '/api/v1/operations/cron/master', {
        method: 'POST',
        headers: { 'X-Cron-Secret': cronSecret },
        body: {
          subroutines: ['marketing_campaigns'],
          tenant_id: auth.tenantId || undefined,
        },
      }).catch(() => {});
    } else if (fixtures.campaignId) {
      await apiRequest(backendBaseUrl, `/api/v1/marketing/campaigns/${encodeURIComponent(fixtures.campaignId)}/send`, {
        ...reqAuth,
        method: 'POST',
        body: {},
      }).catch(() => {});
    }
  } catch (err) {
    console.warn(`[seed] Warning creating campaign: ${err.message}`);
  }

  try {
    const surveyRes = await apiJson(backendBaseUrl, '/api/v1/marketing/surveys', {
      ...reqAuth,
      method: 'POST',
      body: {
        title: fixtures.surveyTitle,
        survey_type: 'survey',
        blocks: [
          {
            id: 'q_name',
            type: 'short_text',
            label: 'Họ và tên của bạn',
            required: true,
            placeholder: 'Nhập tên...',
          },
          {
            id: 'q_feedback',
            type: 'yes_no',
            label: 'Bạn có hài lòng với dịch vụ?',
            required: false,
          },
        ],
        thank_you: {
          title: 'Cảm ơn bạn đã đánh giá!',
          message: 'Phản hồi của bạn đã được lưu thành công.',
        },
      },
    });
    fixtures.surveyId = String(surveyRes.data?.id || '');
    const surveySlug = String(surveyRes.data?.slug || '');
    if (surveySlug) {
      await apiRequest(
        backendBaseUrl,
        `/api/v1/public/marketing/surveys/${encodeURIComponent(surveySlug)}?tenant=${encodeURIComponent(auth.tenantSlug)}`,
        {
          method: 'POST',
          headers: { 'X-Tenant-Slug': auth.tenantSlug },
          body: {
            tenant_slug: auth.tenantSlug,
            answers: {
              q_name: `${prefix} Respondent`,
              q_feedback: 'yes',
            },
          },
        }
      ).catch(() => {});
    }
  } catch (err) {
    console.warn(`[seed] Warning creating survey: ${err.message}`);
  }

  try {
    const voucherRes = await apiJson(backendBaseUrl, '/api/v1/marketing/vouchers', {
      ...reqAuth,
      method: 'POST',
      body: {
        name: `${prefix} VIP Voucher`,
        code_prefix: 'UIAUD',
        discount_type: 'percentage',
        discount_value: 20,
        auto_generate_count: 5,
      },
    });
    fixtures.voucherId = String(voucherRes.data?.id || '');
  } catch (err) {
    console.warn(`[seed] Warning creating voucher: ${err.message}`);
  }

  return fixtures;
}

// ============================================================================
// Offline Meta Graph / dom-meta Mock Payloads (--mock-meta)
// ============================================================================

const MOCK_THUMBNAIL_DATA_URI =
  'data:image/svg+xml;utf8,' +
  encodeURIComponent(
    '<svg xmlns="http://www.w3.org/2000/svg" width="120" height="80" viewBox="0 0 120 80"><rect width="120" height="80" rx="8" fill="#1E40FF"/><text x="60" y="45" fill="#fff" font-family="sans-serif" font-size="12" text-anchor="middle">DOMATION</text></svg>'
  );

function buildMockMetaBatchResponse(requests) {
  const out = {};
  for (const req of requests || []) {
    const { key } = req;
    if (key === 'currSummary') {
      out[key] = {
        data: [
          {
            spend: '48500000',
            impressions: '620000',
            reach: '385000',
            clicks: '14800',
            actions: [
              { action_type: 'lead', value: '218' },
              { action_type: 'onsite_conversion.messaging_conversation_started_7d', value: '164' },
              { action_type: 'link_click', value: '9420' },
              { action_type: 'post_engagement', value: '18900' },
              { action_type: 'post_reaction', value: '4210' },
              { action_type: 'comment', value: '680' },
              { action_type: 'video_view', value: '86400' },
              { action_type: 'like', value: '310' },
            ],
            video_play_actions: [{ action_type: 'video_view', value: '142000' }],
            video_thruplay_watched_actions: [{ action_type: 'video_view', value: '41200' }],
          },
        ],
      };
    } else if (key === 'prevSummary') {
      out[key] = {
        data: [
          {
            spend: '41200000',
            impressions: '540000',
            reach: '340000',
            clicks: '12100',
            actions: [
              { action_type: 'lead', value: '175' },
              { action_type: 'onsite_conversion.messaging_conversation_started_7d', value: '140' },
              { action_type: 'link_click', value: '7900' },
            ],
          },
        ],
      };
    } else if (key === 'daily' || key === 'byDate') {
      const days = [];
      for (let i = 1; i <= 14; i++) {
        const dd = String(i).padStart(2, '0');
        const spend = 2400000 + ((i * 470000) % 2100000);
        days.push({
          date_start: `2026-11-${dd}`,
          spend: String(spend),
          impressions: String(Math.round(spend / 78)),
          reach: String(Math.round(spend / 115)),
          clicks: String(Math.round(spend / 3200)),
          actions: [
            { action_type: 'lead', value: String(10 + (i % 9)) },
            { action_type: 'onsite_conversion.messaging_conversation_started_7d', value: String(7 + (i % 6)) },
          ],
        });
      }
      out[key] = { data: days };
    } else if (key === 'campList') {
      out[key] = {
        data: [
          {
            id: 'camp_active_1',
            name: '[ECOLIFE] Lead Form Signature Q4 - Luxury Pent',
            status: 'ACTIVE',
            effective_status: 'ACTIVE',
            objective: 'OUTCOME_LEADS',
            daily_budget: '3500000',
          },
          {
            id: 'camp_active_2',
            name: '[DOMATION] Messaging Growth Campaign',
            status: 'ACTIVE',
            effective_status: 'ACTIVE',
            objective: 'OUTCOME_ENGAGEMENT',
            daily_budget: '1800000',
          },
        ],
      };
    } else if (key === 'campIns') {
      out[key] = {
        data: [
          {
            campaign_id: 'camp_active_1',
            campaign_name: '[ECOLIFE] Lead Form Signature Q4 - Luxury Pent',
            objective: 'OUTCOME_LEADS',
            spend: '31500000',
            impressions: '395000',
            reach: '248000',
            clicks: '9200',
            actions: [
              { action_type: 'lead', value: '186' },
              { action_type: 'link_click', value: '6100' },
              { action_type: 'post_engagement', value: '11400' },
            ],
          },
          {
            campaign_id: 'camp_active_2',
            campaign_name: '[DOMATION] Messaging Growth Campaign',
            objective: 'OUTCOME_ENGAGEMENT',
            spend: '17000000',
            impressions: '225000',
            reach: '137000',
            clicks: '5600',
            actions: [
              { action_type: 'onsite_conversion.messaging_conversation_started_7d', value: '164' },
              { action_type: 'link_click', value: '3320' },
            ],
          },
        ],
      };
    } else if (key === 'adsetList') {
      out[key] = {
        data: [
          {
            id: 'adset_1',
            name: 'Adset 01 - HCMC High Intent 28-50',
            campaign_id: 'camp_active_1',
            status: 'ACTIVE',
            effective_status: 'ACTIVE',
            optimization_goal: 'LEAD_GENERATION',
            daily_budget: '2000000',
          },
        ],
      };
    } else if (key === 'adsetIns') {
      out[key] = {
        data: [
          {
            adset_id: 'adset_1',
            adset_name: 'Adset 01 - HCMC High Intent 28-50',
            campaign_id: 'camp_active_1',
            campaign_name: '[ECOLIFE] Lead Form Signature Q4 - Luxury Pent',
            optimization_goal: 'LEAD_GENERATION',
            spend: '31500000',
            impressions: '395000',
            reach: '248000',
            clicks: '9200',
            actions: [{ action_type: 'lead', value: '186' }],
          },
        ],
      };
    } else if (key === 'adList') {
      out[key] = {
        data: [
          {
            id: 'ad_1',
            name: 'Video Tour Penthouse 360 - Hook A',
            adset_id: 'adset_1',
            campaign_id: 'camp_active_1',
            status: 'ACTIVE',
            effective_status: 'ACTIVE',
            creative: { id: 'cr_1', thumbnail_url: MOCK_THUMBNAIL_DATA_URI },
          },
        ],
      };
    } else if (key === 'adIns') {
      out[key] = {
        data: [
          {
            ad_id: 'ad_1',
            ad_name: 'Video Tour Penthouse 360 - Hook A',
            adset_id: 'adset_1',
            adset_name: 'Adset 01 - HCMC High Intent 28-50',
            campaign_id: 'camp_active_1',
            campaign_name: '[ECOLIFE] Lead Form Signature Q4 - Luxury Pent',
            optimization_goal: 'LEAD_GENERATION',
            spend: '31500000',
            impressions: '395000',
            reach: '248000',
            clicks: '9200',
            actions: [{ action_type: 'lead', value: '186' }],
          },
        ],
      };
    } else if (key === 'platPos' || key === 'byPlatform') {
      out[key] = {
        data: [
          { publisher_platform: 'facebook', platform_position: 'feed', spend: '19500000', impressions: '230000', reach: '150000', clicks: '5400', actions: [{ action_type: 'lead', value: '98' }] },
          { publisher_platform: 'facebook', platform_position: 'facebook_reels', spend: '11200000', impressions: '148000', reach: '96000', clicks: '3200', actions: [{ action_type: 'lead', value: '52' }] },
          { publisher_platform: 'instagram', platform_position: 'instagram_reels', spend: '9800000', impressions: '124000', reach: '82000', clicks: '2900', actions: [{ action_type: 'lead', value: '39' }] },
          { publisher_platform: 'messenger', platform_position: 'messenger_inbox', spend: '5100000', impressions: '72000', reach: '45000', clicks: '1900', actions: [{ action_type: 'lead', value: '21' }] },
        ],
      };
    } else if (key === 'ageGender' || key === 'byAgeGender') {
      out[key] = {
        data: [
          { age: '25-34', gender: 'male', spend: '11200000', impressions: '138000', reach: '90000', clicks: '3100', actions: [{ action_type: 'lead', value: '54' }] },
          { age: '25-34', gender: 'female', spend: '10400000', impressions: '132000', reach: '86000', clicks: '2950', actions: [{ action_type: 'lead', value: '51' }] },
          { age: '35-44', gender: 'male', spend: '9800000', impressions: '115000', reach: '74000', clicks: '2600', actions: [{ action_type: 'lead', value: '46' }] },
          { age: '35-44', gender: 'female', spend: '8300000', impressions: '102000', reach: '66000', clicks: '2200', actions: [{ action_type: 'lead', value: '39' }] },
        ],
      };
    } else if (key === 'region' || key === 'byRegion') {
      out[key] = {
        data: [
          { region: 'Ho Chi Minh City', spend: '24500000', impressions: '290000', reach: '185000', clicks: '6800', actions: [{ action_type: 'lead', value: '112' }] },
          { region: 'Hanoi', spend: '11800000', impressions: '148000', reach: '95000', clicks: '3400', actions: [{ action_type: 'lead', value: '54' }] },
          { region: 'Binh Duong Province', spend: '5400000', impressions: '72000', reach: '48000', clicks: '1650', actions: [{ action_type: 'lead', value: '24' }] },
        ],
      };
    } else if (key === 'device' || key === 'byDevice') {
      out[key] = {
        data: [
          { impression_device: 'iphone', spend: '26800000', impressions: '315000', reach: '198000', clicks: '7900', actions: [{ action_type: 'lead', value: '124' }] },
          { impression_device: 'android_smartphone', spend: '15400000', impressions: '212000', reach: '134000', clicks: '4700', actions: [{ action_type: 'lead', value: '68' }] },
          { impression_device: 'desktop', spend: '4200000', impressions: '62000', reach: '38000', clicks: '1520', actions: [{ action_type: 'lead', value: '19' }] },
        ],
      };
    } else if (key === 'hourly' || key === 'byHour') {
      const hours = [];
      for (let h = 0; h < 24; h++) {
        const hh = String(h).padStart(2, '0');
        const spend = h >= 8 && h <= 22 ? 1450000 + ((h * 210000) % 1300000) : 280000 + h * 45000;
        const leads = h >= 8 && h <= 22 ? 4 + (h % 8) : h % 2;
        const actions = [{ action_type: 'link_click', value: '19' }];
        if (leads > 0) actions.push({ action_type: 'lead', value: String(leads) });
        hours.push({
          date_start: '2026-11-15',
          hourly_stats_aggregated_by_advertiser_time_zone: `${hh}:00:00 - ${hh}:59:59`,
          spend: String(spend),
          impressions: String(Math.round(spend / 80)),
          clicks: String(Math.round(spend / 3100)),
          actions,
        });
      }
      out[key] = { data: hours };
    } else if (key === 'accInfo') {
      out[key] = {
        account_id: '123456789',
        name: 'DOMATION Audit Ad Account',
        currency: 'VND',
        balance: '12500000',
        amount_spent: '985000000',
        account_status: 1,
        funding_source_details: { display_string: 'VISA *8899' },
      };
    } else if (key === 'yearMonthly') {
      out[key] = {
        data: [
          { date_start: '2026-09-01', spend: '82000000', reach: '610000', actions: [{ action_type: 'lead', value: '390' }] },
          { date_start: '2026-10-01', spend: '94000000', reach: '690000', actions: [{ action_type: 'lead', value: '445' }] },
          { date_start: '2026-11-01', spend: '48500000', reach: '385000', actions: [{ action_type: 'lead', value: '218' }] },
        ],
      };
    } else {
      out[key] = { data: [] };
    }
  }
  return out;
}

const MOCK_DOM_META_CONFIG_RESPONSE = {
  success: true,
  data: {
    primary_ad_account_id: '123456789',
    meta_summary: {
      ad_account_id: '123456789',
      pixel_id: '99887766',
      has_token: true,
      access_token_masked: 'EAAB••••••',
      total_accounts: 1,
      active_accounts: 1,
      accounts: [
        {
          id: 'acc_1',
          ad_account_id: '123456789',
          name: 'DOMATION Audit Ad Account',
          has_token: true,
          is_active: true,
        },
      ],
    },
    brand_filters: [
      { name: 'EcoLife Signature', filter: 'ECOLIFE' },
      { name: 'DOMATION Growth', filter: 'DOMATION' },
    ],
    goal_keywords: [],
    goal_chart_mode: 'goal',
    column_config: {
      activeColumns: ['status', 'spend', 'result', 'cpr', 'cpm', 'reach', 'frequency', 'reaction'],
      customMetrics: [],
    },
    view_presets: [
      {
        id: 'preset_lead_default',
        name: 'Báo cáo Lead & CPL',
        activeColumns: ['status', 'spend', 'result', 'cpr', 'cpm', 'reach', 'frequency', 'ctr'],
      },
    ],
    summary_metrics: ['reach', 'leads', 'impressions'],
    ai_reports: [],
    google_ads: {
      enabled: false,
      customer_id: '',
      apps_script_url: '',
      has_developer_token: false,
      developer_token_masked: '',
      last_verified_at: null,
    },
  },
};

const MOCK_ZALO_LOGO_SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 32 32"><rect width="32" height="32" rx="8" fill="#0068FF"/><text x="16" y="21" fill="#fff" font-family="sans-serif" font-size="11" font-weight="700" text-anchor="middle">Zalo</text></svg>';

const MOCK_CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, PUT, PATCH, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': '*',
  'Access-Control-Max-Age': '86400',
};

function buildMockMetaProxyResponse(graphPath) {
  const gp = String(graphPath || '');
  if (gp.includes('/insights')) {
    return buildMockMetaBatchResponse([{ key: 'currSummary' }]).currSummary;
  }
  if (gp.includes('/campaigns')) {
    return buildMockMetaBatchResponse([{ key: 'campList' }]).campList;
  }
  if (gp.includes('/adsets')) {
    return buildMockMetaBatchResponse([{ key: 'adsetList' }]).adsetList;
  }
  if (gp.includes('/ads')) {
    return buildMockMetaBatchResponse([{ key: 'adList' }]).adList;
  }
  if (/^act_\d+$/.test(gp.replace(/^\/+/, ''))) {
    return buildMockMetaBatchResponse([{ key: 'accInfo' }]).accInfo;
  }
  return { data: [] };
}

async function attachMetaMockInterceptor(page, { isLanding = false } = {}) {
  await page.setRequestInterception(true);
  page.on('request', (req) => {
    if (req.isInterceptResolutionHandled()) return;
    const url = req.url();
    const method = req.method().toUpperCase();

    const isDomMetaUrl =
      url.includes('/integrations/dom-meta/') ||
      url.includes('/public/dom-meta/') ||
      url.includes('/integrations/meta-ads/discover');
    const isExternalMockUrl =
      url.startsWith('https://graph.facebook.com/') ||
      url.startsWith('https://business.openapi.zalo.me/') ||
      url.startsWith('https://openapi.zalo.me/') ||
      url.startsWith('https://data.domation.net/imgs/');
    const isLandingMockUrl =
      isLanding &&
      (url.includes('/api/autodata?action=bootstrap') ||
        url.includes('/api/v1/billing/overview') ||
        url.includes('/api/v1/billing/catalog'));

    if (method === 'OPTIONS' && (isDomMetaUrl || isExternalMockUrl || isLandingMockUrl)) {
      return req
        .respond({
          status: 204,
          headers: MOCK_CORS_HEADERS,
          body: '',
        })
        .catch(() => {});
    }

    const respondJson = (body, status = 200) =>
      req
        .respond({
          status,
          headers: MOCK_CORS_HEADERS,
          contentType: 'application/json',
          body: JSON.stringify(body),
        })
        .catch(() => {});

    if (url.includes('/integrations/dom-meta/config')) {
      return respondJson(MOCK_DOM_META_CONFIG_RESPONSE);
    }
    if (url.includes('/integrations/dom-meta/meta-batch')) {
      let postBody = {};
      try {
        postBody = JSON.parse(req.postData() || '{}');
      } catch {
        postBody = {};
      }
      return respondJson({
        success: true,
        data: buildMockMetaBatchResponse(postBody.requests || []),
      });
    }
    if (url.includes('/integrations/dom-meta/meta-proxy')) {
      let postBody = {};
      try {
        postBody = JSON.parse(req.postData() || '{}');
      } catch {
        postBody = {};
      }
      return respondJson({
        success: true,
        data: buildMockMetaProxyResponse(postBody.graph_path || ''),
      });
    }
    if (url.includes('/integrations/dom-meta/quick-connect-status')) {
      return respondJson({
        success: true,
        data: {
          connected: true,
          ad_account_id: '123456789',
          has_token: true,
          total_accounts: 1,
          active_accounts: 1,
        },
      });
    }
    if (url.includes('/integrations/dom-meta/crm-attribution')) {
      return respondJson({
        success: true,
        data: {
          summary: {
            total_leads: 218,
            qualified_leads: 94,
            won_deals: 26,
            revenue_vnd: 425000000,
          },
          by_campaign: [],
          by_adset: [],
          by_ad: [],
          daily: [],
        },
      });
    }
    if (url.includes('/integrations/dom-meta/share')) {
      return respondJson({
        success: true,
        data: { enabled: false, slug: '', expires_at: null },
      });
    }
    if (url.includes('/integrations/dom-meta/ai-config')) {
      return respondJson({
        success: true,
        data: { enabled: false, provider: 'gemini', model: 'gemini-2.5-flash' },
      });
    }
    if (url.includes('/integrations/dom-meta/google-ads-proxy') || url.includes('/integrations/dom-meta/google-ads/')) {
      return respondJson({ success: true, data: { results: [], rows: [], accounts: [] } });
    }
    if (url.includes('/public/dom-meta/') && url.includes('/access')) {
      return respondJson({ success: true, data: { enabled: false } });
    }
    if (url.includes('/integrations/meta-ads/discover')) {
      return respondJson({ success: true, data: { accounts: [] } });
    }
    if (isLanding && url.includes('/api/autodata?action=bootstrap')) {
      return respondJson({
        success: true,
        data: { google_oauth: { enabled: true, client_id: 'mock_client' } },
      });
    }
    if (isLanding && (url.includes('/api/v1/billing/overview') || url.includes('/api/v1/billing/catalog'))) {
      return respondJson({
        success: true,
        data: {
          wallet: { balance_vnd: 4500000, total_topup_vnd: 4500000, total_spent_vnd: 0 },
          subscription: {
            plan_tier: 'starter',
            plan_name: 'Gói Dùng Thử 30 Ngày',
            status: 'trialing',
            billing_cycle: 'monthly',
            max_users: 5,
            monthly_leads_limit: 500,
            used_leads_this_month: 84,
            days_remaining: 26,
            is_in_trial: true,
            is_expired: false,
          },
          catalog: { trial_duration_days: 30, plans: [], topup_packages: [] },
          transactions: [],
          orders: [],
        },
      });
    }
    if (url.startsWith('https://data.domation.net/imgs/')) {
      return req
        .respond({
          status: 200,
          headers: MOCK_CORS_HEADERS,
          contentType: 'image/svg+xml',
          body: MOCK_ZALO_LOGO_SVG,
        })
        .catch(() => {});
    }
    // External Meta Graph / Zalo OpenAPI offline mocks
    if (
      url.startsWith('https://graph.facebook.com/') ||
      url.startsWith('https://business.openapi.zalo.me/') ||
      url.startsWith('https://openapi.zalo.me/')
    ) {
      return respondJson({ data: [], error: 0, message: 'Mocked offline' });
    }

    return req.continue().catch(() => {});
  });
}

// ============================================================================
// Runtime Diagnostics & Page Lifecycle Helpers
// ============================================================================

function attachPageDiagnostics(page, { allowPort3199 = false } = {}) {
  let state = {
    consoleErrors: [],
    pageErrors: [],
    http5xxErrors: [],
    http4xxUrls: [],
    requestFailedErrors: [],
    php404Or501Errors: [],
    port3199Requests: [],
  };

  page.on('console', (msg) => {
    if (msg.type() === 'error') {
      state.consoleErrors.push(msg.text());
    }
  });

  page.on('pageerror', (err) => {
    state.pageErrors.push(err instanceof Error ? err.stack || err.message : String(err));
  });

  page.on('request', (req) => {
    const url = req.url();
    if (!allowPort3199 && url.includes(':3199')) {
      state.port3199Requests.push(`${req.method()} ${url}`);
    }
  });

  page.on('response', (res) => {
    const status = res.status();
    const url = res.url();
    const method = res.request().method();
    if (status >= 400 && status < 500 && state.http4xxUrls.length < 15) {
      state.http4xxUrls.push({ status, method, url });
    }
    if (status >= 500 && (url.includes('/api/') || url.includes('/backend/'))) {
      state.http5xxErrors.push({ status, url, method });
    }
    if (url.includes('.php') && (status === 404 || status === 501)) {
      state.php404Or501Errors.push({ status, url, method });
    }
  });

  page.on('requestfailed', (req) => {
    const url = req.url();
    const errText = req.failure()?.errorText || 'unknown';
    if (errText !== 'net::ERR_ABORTED' && (url.includes('/api/') || url.includes('/backend/'))) {
      state.requestFailedErrors.push(`${req.method()} ${url}: ${errText}`);
    }
  });

  return {
    reset() {
      state = {
        consoleErrors: [],
        pageErrors: [],
        http5xxErrors: [],
        http4xxUrls: [],
        requestFailedErrors: [],
        php404Or501Errors: [],
        port3199Requests: [],
      };
    },
    snapshot() {
      return {
        consoleErrors: [...state.consoleErrors],
        pageErrors: [...state.pageErrors],
        http5xxErrors: [...state.http5xxErrors],
        http4xxUrls: [...state.http4xxUrls],
        requestFailedErrors: [...state.requestFailedErrors],
        php404Or501Errors: [...state.php404Or501Errors],
        port3199Requests: [...state.port3199Requests],
      };
    },
  };
}

async function seedErpAuthOnDocument(page, auth) {
  const tenantSlug = auth.tenantSlug.trim().toLowerCase();
  const roleRaw = String(auth.user?.role || 'admin').toLowerCase();
  const normalizedRole =
    roleRaw === 'sales'
      ? 'sale'
      : roleRaw === 'super_admin'
        ? 'superadmin'
        : roleRaw === 'tenant_admin'
          ? 'admin'
          : roleRaw;

  const normalizedUser = {
    ...auth.user,
    role: normalizedRole,
    username: auth.user?.username || auth.user?.email || '',
    name: auth.user?.full_name || auth.user?.name || auth.user?.email || '',
    tenant_slug: tenantSlug,
    ...(auth.packageCode
      ? {
          package_code: auth.packageCode.toLowerCase(),
          plan_tier: auth.packageCode.toLowerCase(),
        }
      : {}),
  };

  await page.evaluateOnNewDocument(
    (seed) => {
      const g = globalThis;
      if (g.window !== g.top) return;
      try {
        const ls = g.localStorage;
        if (!ls || ls.getItem('__e2e_seeded') === '1') return;
        ls.setItem('domation_token', seed.token);
        ls.setItem('Ideas_token', seed.token);
        ls.setItem('access_token', seed.token);
        if (seed.refreshToken) {
          ls.setItem('refresh_token', seed.refreshToken);
        }
        ls.setItem('Ideas_user', seed.userJson);
        ls.setItem('minth-auth', seed.minthAuthJson);
        ls.setItem('domation_tenant_slug', seed.tenantSlug);
        ls.setItem('tenant_slug', seed.tenantSlug);
        ls.removeItem('IDEAS_DEMO_MODE');
        ls.setItem('__e2e_seeded', '1');
      } catch {
        // ignore sandboxed / opaque iframes
      }
    },
    {
      token: auth.accessToken,
      refreshToken: auth.refreshToken,
      tenantSlug,
      userJson: JSON.stringify(normalizedUser),
      minthAuthJson: JSON.stringify({
        state: {
          user: normalizedUser,
          accessToken: auth.accessToken,
          refreshToken: auth.refreshToken ?? null,
          isAuthenticated: true,
        },
        version: 0,
      }),
    }
  );
}

async function waitForSplashDismissed(page, timeout = 20_000) {
  await page
    .waitForFunction(
      () => {
        const doc = document;
        const splash = doc.getElementById('ideas-splash-screen');
        if (!splash) return true;
        const cs = window.getComputedStyle(splash);
        return cs.display === 'none' || cs.visibility === 'hidden' || Number(cs.opacity) <= 0.02;
      },
      { timeout }
    )
    .catch(() => {});
}

async function waitForAppReady(page, timeout = 25_000) {
  await page
    .waitForFunction(
      () => {
        const root = document.getElementById('root');
        const hasLoader = Boolean(document.querySelector('[role="status"][aria-busy="true"]'));
        return Boolean(root && root.children.length > 0 && !hasLoader && (root.innerText || '').trim().length > 0);
      },
      { timeout }
    )
    .catch(() => {});
  await waitForSplashDismissed(page, timeout);
}

async function installEventSourceCleanupHook(page) {
  await page.evaluateOnNewDocument(() => {
    if (window !== window.top) return;
    if (typeof window.EventSource !== 'function' || window.__cmpEventSourceWrapped) return;
    const NativeEventSource = window.EventSource;
    const active = new Set();
    window.__cmpActiveEventSources = active;
    window.__cmpEventSourceWrapped = true;
    const TrackedEventSource = function TrackedEventSource(url, cfg) {
      const es = new NativeEventSource(url, cfg);
      active.add(es);
      return es;
    };
    TrackedEventSource.prototype = NativeEventSource.prototype;
    TrackedEventSource.CONNECTING = NativeEventSource.CONNECTING;
    TrackedEventSource.OPEN = NativeEventSource.OPEN;
    TrackedEventSource.CLOSED = NativeEventSource.CLOSED;
    window.EventSource = TrackedEventSource;
    const closeAll = () => {
      for (const es of active) {
        try {
          es.close();
        } catch {
          // ignore
        }
      }
      active.clear();
    };
    window.addEventListener('pagehide', closeAll);
    window.addEventListener('beforeunload', closeAll);
  });
}

async function closeTrackedEventSources(page) {
  await page
    .evaluate(() => {
      const active = window.__cmpActiveEventSources;
      if (!active) return;
      for (const es of active) {
        try {
          es.close();
        } catch {
          // ignore
        }
      }
      active.clear();
    })
    .catch(() => {});
}

async function navigateRoute(page, baseUrl, targetPath, timeout = 30_000) {
  const cleanPath = targetPath.startsWith('/') ? targetPath : `/${targetPath}`;
  // Close active SSE EventSource streams before full navigation to prevent HTTP/1.1 6-socket pool exhaustion on localhost
  await closeTrackedEventSources(page);
  await page.goto(`${baseUrl}${cleanPath}`, {
    waitUntil: 'domcontentloaded',
    timeout,
  });
  await waitForAppReady(page, Math.min(timeout, 25_000));
}

async function navigateSpaOrDirect(page, baseUrl, targetPath, timeout = 30_000) {
  const cleanPath = targetPath.startsWith('/') ? targetPath : `/${targetPath}`;
  const navState = await page
    .evaluate(() => ({
      full: window.location.pathname + window.location.search,
      inFullScreenBuilder: Boolean(document.querySelector('[id^="step-node-"]')),
      hasPortalOverlay: (document.getElementById('mkt-portal-root')?.innerText || '').trim().length > 0,
    }))
    .catch(() => ({ full: '', inFullScreenBuilder: false, hasPortalOverlay: false }));

  if (navState.full === cleanPath && !navState.inFullScreenBuilder && !navState.hasPortalOverlay) {
    await waitForAppReady(page, Math.min(timeout, 15_000));
    return;
  }

  // Always do a clean direct navigation when leaving full-screen FlowBuilder or active portal overlays
  if (navState.inFullScreenBuilder || navState.hasPortalOverlay) {
    await navigateRoute(page, baseUrl, cleanPath, timeout);
    return;
  }

  const clickedSidebar = await page
    .evaluate((dest) => {
      const main = document.querySelector('main');
      if (main && window.location.pathname + window.location.search !== dest) {
        window.__e2ePrevScopeEl =
          Array.from(main.querySelectorAll('.mkt-scope, .dom-meta-scope')).find(
            (el) =>
              !el.closest('[role="status"][aria-busy="true"]') &&
              el.style?.display !== 'contents' &&
              !(
                Boolean(el.querySelector('[data-testid*="date-picker"]')) &&
                el.querySelectorAll('button, a, input, select, textarea').length <= 1
              ) &&
              window.getComputedStyle(el).visibility !== 'hidden'
          ) || null;
      } else {
        window.__e2ePrevScopeEl = null;
      }
      const link = document.querySelector(`aside.responsive-sidebar a[href="${dest}"]`);
      if (link) {
        const cs = window.getComputedStyle(link);
        const r = link.getBoundingClientRect();
        if (cs.display !== 'none' && cs.visibility !== 'hidden' && r.width > 0 && r.height > 0) {
          link.click();
          return true;
        }
      }
      return false;
    }, cleanPath)
    .catch(() => false);

  if (!clickedSidebar) {
    await navigateRoute(page, baseUrl, cleanPath, timeout);
  }
}

async function waitForMainRouteReady(page, route, timeout = 20_000) {
  const routePathname = route.split('?')[0];
  await page
    .waitForFunction(
      (r) => {
        if (document.querySelector('[role="status"][aria-busy="true"]')) return false;
        const main = document.querySelector('main') || document.getElementById('root');
        if (!main) return false;
        const currentPath = window.location.pathname;
        if (r !== '/' && currentPath !== r) return false;
        if (
          window.__e2ePrevScopeEl &&
          window.__e2ePrevScopeEl.isConnected &&
          window.getComputedStyle(window.__e2ePrevScopeEl).visibility !== 'hidden'
        ) {
          return false;
        }
        const mainText = (main.innerText || '').trim();
        if (mainText.length <= 40) return false;
        if (r === '/data') {
          return !main.querySelector('.animate-pulse');
        }
        if (r === '/meta-report' || r === '/marketing/meta-report') {
          return Array.from(document.querySelectorAll('.dom-meta-scope, .mkt-scope')).some(
            (el) =>
              el !== window.__e2ePrevScopeEl &&
              !el.closest('[role="status"][aria-busy="true"]') &&
              el.style?.display !== 'contents' &&
              window.getComputedStyle(el).visibility !== 'hidden'
          );
        }
        if (r === '/capi' || r === '/marketing/capi' || r === '/settings') {
          const activeScope =
            Array.from(main.querySelectorAll('.mkt-scope')).find((el) => {
              const cs = window.getComputedStyle(el);
              return el.style?.display !== 'contents' && cs.display !== 'none' && cs.visibility !== 'hidden';
            }) || main;
          return activeScope.querySelectorAll('.animate-pulse, [style*="sk-shimmer"]').length === 0 && (activeScope.innerText || '').trim().length > 80;
        }
        if (r === '/marketing/templates' || r === '/templates') {
          const activeScope =
            Array.from(main.querySelectorAll('.mkt-scope')).find((el) => {
              const cs = window.getComputedStyle(el);
              return el.style?.display !== 'contents' && cs.display !== 'none' && cs.visibility !== 'hidden';
            }) || main;
          if (activeScope.querySelectorAll('.animate-pulse, [style*="sk-shimmer"]').length > 0) return false;
          const scopeTxt = activeScope.innerText || '';
          if (/chưa có mẫu|không tìm thấy mẫu/i.test(scopeTxt)) return true;
          const hasCardTitles = Array.from(activeScope.querySelectorAll('h3, h4, [data-testid*="template"]')).some(
            (el) => (el.textContent || '').trim().length > 1
          );
          if (!hasCardTitles) return false;
          const cardImgs = Array.from(activeScope.querySelectorAll('img')).slice(0, 12);
          if (cardImgs.some((img) => !img.complete || img.naturalWidth === 0)) return false;
          const iframes = Array.from(activeScope.querySelectorAll('iframe')).slice(0, 8);
          for (const fr of iframes) {
            try {
              const doc = fr.contentDocument || fr.contentWindow?.document;
              const body = doc?.body;
              if (!body || ((body.innerText || '').trim().length === 0 && body.children.length === 0)) {
                return false;
              }
            } catch {
              // Ignore cross-origin iframe
            }
          }
          return cardImgs.length > 0 || iframes.length > 0;
        }
        if (r === '/marketing/flows' || r === '/flows') {
          // Wait for both Tailwind animate-pulse and PageSkeleton sk-shimmer loaders as well as any "Đang tải..." badge
          const activeScope =
            Array.from(main.querySelectorAll('.mkt-scope')).find((el) => {
              const cs = window.getComputedStyle(el);
              return el.style?.display !== 'contents' && cs.display !== 'none' && cs.visibility !== 'hidden';
            }) || main;
          if (!activeScope || activeScope.querySelectorAll('.animate-pulse, [style*="sk-shimmer"]').length > 0) {
            return false;
          }
          const scopeTxt = (activeScope.innerText || '').trim();
          if (scopeTxt.includes('Đang tải...')) return false;
          return scopeTxt.length > 60 && Boolean(activeScope.querySelector('h1, h2'));
        }
        if (r.startsWith('/marketing')) {
          if (main.querySelectorAll('[style*="sk-shimmer"]').length > 0) return false;
          return Array.from(main.querySelectorAll('.mkt-scope')).some(
            (el) =>
              el !== window.__e2ePrevScopeEl &&
              !el.closest('[role="status"][aria-busy="true"]') &&
              el.style?.display !== 'contents' &&
              !(
                Boolean(el.querySelector('[data-testid*="date-picker"]')) &&
                el.querySelectorAll('button, a, input, select, textarea').length <= 1
              ) &&
              window.getComputedStyle(el).visibility !== 'hidden'
          );
        }
        return true;
      },
      { timeout },
      routePathname
    )
    .catch(() => {});

  // Wait for fonts & layout settle
  await page.evaluate(() => document.fonts?.ready?.catch?.(() => {})).catch(() => {});
  await sleep(300);
}

async function clickButtonByText(page, needle, { exact = false, rootSelector = 'body', selector = 'button, [role="tab"]' } = {}) {
  return page.evaluate(
    (txtNeedle, sel, rootSel, isExact) => {
      const root = document.querySelector(rootSel) || document.body;
      if (!root) return false;
      const nodes = Array.from(root.querySelectorAll(sel));
      for (const el of nodes) {
        const rect = el.getBoundingClientRect();
        const cs = window.getComputedStyle(el);
        if (rect.width <= 0 || rect.height <= 0 || cs.display === 'none' || cs.visibility === 'hidden') {
          continue;
        }
        const txt = (el.textContent || '').replace(/\s+/g, ' ').trim();
        const matched = isExact ? txt === txtNeedle : txt.includes(txtNeedle);
        if (matched && !el.disabled) {
          el.scrollIntoView({ block: 'center', inline: 'center' });
          el.click();
          return true;
        }
      }
      return false;
    },
    needle,
    selector,
    rootSelector,
    exact
  );
}

// ============================================================================
// 12-Check Automated Audit Evaluator (docs/SCREENSHOT_COMPARISON_PLAN.md §4.1)
// ============================================================================

async function checkSplashAssetReachable(erpBaseUrl, cache) {
  if (cache.splashAssetResult) return cache.splashAssetResult;
  if (!erpBaseUrl) {
    cache.splashAssetResult = { ok: false, jpgStatus: 0, webpStatus: 0 };
    return cache.splashAssetResult;
  }
  try {
    const [jpg, webp] = await Promise.all([
      fetch(`${erpBaseUrl}/imgs/landing/fluent-brand-ambient-bg.jpg`, { signal: AbortSignal.timeout(5000) }).catch(() => ({ status: 0 })),
      fetch(`${erpBaseUrl}/imgs/landing/fluent-brand-ambient-bg.webp`, { signal: AbortSignal.timeout(5000) }).catch(() => ({ status: 0 })),
    ]);
    cache.splashAssetResult = {
      ok: jpg.status === 200 || webp.status === 200,
      jpgStatus: jpg.status,
      webpStatus: webp.status,
    };
  } catch {
    cache.splashAssetResult = { ok: false, jpgStatus: 0, webpStatus: 0 };
  }
  return cache.splashAssetResult;
}

function makeCheck(id, status, actual, detail) {
  return {
    id,
    category: AUDIT_CHECK_META[id].category,
    status,
    actual,
    expected: AUDIT_CHECK_META[id].expected,
    detail,
  };
}

async function evaluateAllChecks(page, item, { diagnostics, stateEvidence = {}, erpBaseUrl, cache }) {
  const applicable = new Set(item.checks || []);

  // Collect single comprehensive DOM/style snapshot from the browser
  const domSnap = await page
    .evaluate((opts) => {
      const doc = document;
      const win = window;
      const main = doc.querySelector('main');
      const portalRoot = doc.getElementById('mkt-portal-root');
      const mainText = (main?.innerText || '').trim();
      const portalText = (portalRoot?.innerText || '').trim();
      const rootFallbackText = (!main ? (doc.getElementById('root')?.innerText || doc.body?.innerText || '').trim() : '');
      const contentText = main
        ? (mainText.length >= portalText.length ? mainText : portalText)
        : rootFallbackText;
      const combinedGuardText = `${mainText}\n${portalText}\n${rootFallbackText}`;

      const findVisibleMktScopeIn = (container) => {
        if (!container) return null;
        return (
          Array.from(container.querySelectorAll('.mkt-scope')).find(
            (el) =>
              !el.closest('[role="status"][aria-busy="true"]') &&
              el.style?.display !== 'contents' &&
              !(
                Boolean(el.querySelector('[data-testid*="date-picker"], [data-testid*="date-range-filter"]')) &&
                el.querySelectorAll('button, a, input, select, textarea').length <= 1
              ) &&
              win.getComputedStyle(el).visibility !== 'hidden' &&
              win.getComputedStyle(el).display !== 'none'
          ) || null
        );
      };

      const findActiveMktScope = () => {
        const fromMain = findVisibleMktScopeIn(main);
        if (fromMain) return fromMain;
        if (portalRoot && portalText.length > 0) {
          if (portalRoot.classList?.contains('mkt-scope')) return portalRoot;
          const fromPortal = findVisibleMktScopeIn(portalRoot);
          if (fromPortal) return fromPortal;
        }
        return findVisibleMktScopeIn(doc);
      };

      const findActiveDomMetaScope = () => {
        const searchRoot = main || doc;
        return (
          Array.from(searchRoot.querySelectorAll('.dom-meta-scope')).find(
            (el) =>
              !el.closest('[role="status"][aria-busy="true"]') &&
              win.getComputedStyle(el).visibility !== 'hidden'
          ) || null
        );
      };

      const mktScope = findActiveMktScope();
      const domMetaScope = findActiveDomMetaScope();
      const rootCs = win.getComputedStyle(doc.documentElement);
      const bodyCs = win.getComputedStyle(doc.body);
      const mktScopeCs = mktScope ? win.getComputedStyle(mktScope) : null;
      const domMetaScopeCs = domMetaScope ? win.getComputedStyle(domMetaScope) : null;
      const domMetaHeading = domMetaScope?.querySelector('h1, h2') || domMetaScope;
      const domMetaHeadingCs = domMetaHeading ? win.getComputedStyle(domMetaHeading) : null;

      // Splash inspection
      const splash = doc.getElementById('ideas-splash-screen');
      const splashImg = splash?.querySelector('img');
      const splashSource = splash?.querySelector('source');
      const splashCs = splash ? win.getComputedStyle(splash) : null;
      const splashDismissed =
        !splash ||
        splash.classList?.contains('splash-fade-out') ||
        splashCs?.display === 'none' ||
        splashCs?.visibility === 'hidden' ||
        Number(splashCs?.opacity) === 0;

      // Domation SVG decor inspection
      const decorRoots = [
        mktScope,
        ...Array.from(doc.querySelectorAll('.dom-meta-app-canvas, .ql-luxury-decor-layer')),
        ...(opts.isLandingData ? [doc.getElementById('root')] : []),
      ].filter(Boolean);
      const seenDecor = new Set();
      let decorSvgCount = 0;
      for (const r of decorRoots) {
        for (const svg of Array.from(r.querySelectorAll('svg'))) {
          if (seenDecor.has(svg)) continue;
          seenDecor.add(svg);
          const cls = String(svg.getAttribute('class') || '');
          if (cls.includes('lucide')) continue;
          if (svg.closest('button, aside, nav, header, #ideas-splash-screen, .lucide')) continue;
          const cs = win.getComputedStyle(svg);
          if (cs.display === 'none' || cs.visibility === 'hidden' || Number(cs.opacity) === 0) continue;
          const rect = svg.getBoundingClientRect();
          if (rect.width <= 0 || rect.height <= 0) continue;
          const vb = svg.getAttribute('viewBox') || '';
          if (
            vb === '0 0 1440 500' ||
            vb === '0 0 1440 260' ||
            vb === '0 0 280 96' ||
            vb === '0 0 64 64' ||
            vb === '0 0 80 80' ||
            vb === '0 0 48 48' ||
            cls.includes('ql-silk-wave-decor')
          ) {
            decorSvgCount++;
          }
        }
      }
      if (opts.isLandingData && decorSvgCount === 0) {
        const landingDecorImgs = Array.from(doc.querySelectorAll('img[src*="/imgs/enterprise/decor-"]')).filter((img) => {
          const r = img.getBoundingClientRect();
          return r.width > 0 && r.height > 0;
        });
        decorSvgCount = landingDecorImgs.length;
      }

      // Palette checks: CSS vars, legacy purple in .mkt-scope, Red accents
      const colorPrimaryVar = rootCs.getPropertyValue('--color-primary').trim().toLowerCase();
      const colorDangerVar = rootCs.getPropertyValue('--color-danger').trim().toLowerCase();
      const colorBgVar = rootCs.getPropertyValue('--color-bg').trim().toLowerCase();
      const colorTextVar = rootCs.getPropertyValue('--color-text').trim().toLowerCase();

      const purpleMatches = [];
      if (mktScope) {
        for (const el of Array.from(mktScope.querySelectorAll('button, a, [role="button"]'))) {
          const cs = win.getComputedStyle(el);
          if (cs.display === 'none' || cs.visibility === 'hidden') continue;
          const bg = cs.backgroundColor || '';
          const bgImg = cs.backgroundImage || '';
          const border = cs.borderColor || '';
          if (
            bg.includes('124, 58, 237') ||
            bg.includes('139, 92, 246') ||
            bgImg.includes('124, 58, 237') ||
            bgImg.includes('139, 92, 246') ||
            border.includes('124, 58, 237') ||
            border.includes('139, 92, 246')
          ) {
            purpleMatches.push(`${el.tagName}:${bg || bgImg}`);
          }
        }
      }

      const countRedAccents = (rootEl) => {
        if (!rootEl) return 0;
        let hits = 0;
        for (const el of Array.from(rootEl.querySelectorAll('*'))) {
          const tag = (el.tagName || '').toLowerCase();
          const cs = win.getComputedStyle(el);
          if (cs.display === 'none' || cs.visibility === 'hidden') continue;
          const combined = `${cs.backgroundColor || ''} ${cs.backgroundImage || ''} ${cs.borderColor || ''} ${cs.color || ''}`;
          const rgbHit = Array.from(
            combined.matchAll(/rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)(?:\s*,\s*[\d.]+)?\s*\)/gi)
          ).some((m) => Number(m[1]) >= 200 && Number(m[2]) <= 80 && Number(m[3]) <= 90);
          const hexHit = /#(?:dc2626|ef4444|e11d48|b91c1c|f43f5e)/i.test(combined);
          if (rgbHit || hexHit) {
            hits++;
            if (hits >= 5) break;
          }
          if (tag === 'stop' || tag === 'path' || tag === 'rect' || tag === 'circle') {
            const attrs = `${el.getAttribute('stop-color') || ''} ${el.getAttribute('fill') || ''} ${el.getAttribute('stroke') || ''}`;
            const attrRgbHit = Array.from(
              attrs.matchAll(/rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)(?:\s*,\s*[\d.]+)?\s*\)/gi)
            ).some((m) => Number(m[1]) >= 200 && Number(m[2]) <= 80 && Number(m[3]) <= 90);
            const attrHexHit = /#(?:dc2626|ef4444|e11d48|b91c1c|f43f5e)/i.test(attrs);
            if (attrRgbHit || attrHexHit) {
              hits++;
              if (hits >= 5) break;
            }
          }
        }
        return hits;
      };

      const mktRedHits = mktScope ? countRedAccents(mktScope) : 0;

      // Primary CTA check (e.g. "Tạo kịch bản")
      let primaryCtaBg = null;
      if (opts.requireSapphirePrimaryCta && mktScope) {
        const btn = Array.from(mktScope.querySelectorAll('button')).find((b) =>
          (b.textContent || '').includes(opts.requireSapphirePrimaryCta)
        );
        primaryCtaBg = btn ? win.getComputedStyle(btn).backgroundColor : '';
      }

      // Sidebar inspection
      const aside = doc.querySelector('aside.responsive-sidebar');
      let sidebar = { exists: false };
      if (aside) {
        const cs = win.getComputedStyle(aside);
        const rect = aside.getBoundingClientRect();
        const combined = `${cs.backgroundColor || ''} ${cs.backgroundImage || ''}`;
        const stops = [];
        for (const m of combined.matchAll(/rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)(?:\s*,\s*([\d.]+))?\s*\)/gi)) {
          const a = m[4] !== undefined ? Number(m[4]) : 1;
          if (a > 0.05) {
            stops.push({ r: Number(m[1]), g: Number(m[2]), b: Number(m[3]), a });
          }
        }
        const hasDarkStop = stops.some((c) => c.r < 120 && c.g < 120 && c.b < 120 && c.a >= 0.5);
        const hasLightStop = stops.some((c) => c.r >= 220 && c.g >= 220 && c.b >= 220 && c.a >= 0.7);
        const asideDur = parseFloat(cs.transitionDuration || '0') || 0;
        const navItems = Array.from(aside.querySelectorAll('a.sidebar-nav-item'));
        const inactiveNav = navItems.find(
          (a) => !a.classList.contains('active') && a.getAttribute('data-active') !== 'true'
        );
        let navTextColor = null;
        if (inactiveNav) {
          const m = (win.getComputedStyle(inactiveNav).color || '').match(
            /rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)(?:\s*,\s*([\d.]+))?\s*\)/i
          );
          if (m) {
            navTextColor = {
              r: Number(m[1]),
              g: Number(m[2]),
              b: Number(m[3]),
              a: m[4] !== undefined ? Number(m[4]) : 1,
            };
          }
        }
        const navDur = inactiveNav ? parseFloat(win.getComputedStyle(inactiveNav).transitionDuration || '0') || 0 : 0;
        const sidebarText = aside.textContent || '';
        const sidebarLower = sidebarText.toLowerCase();
        const hrefs = Array.from(aside.querySelectorAll('a[href]')).map((a) => a.getAttribute('href'));
        const hasStandaloneMarketingNav =
          sidebarLower.includes('marketing automation') ||
          sidebarText.includes('DOM AUTOMATION') ||
          sidebarText.includes('TỰ ĐỘNG & CHIẾN DỊCH') ||
          sidebarText.includes('TỔNG QUAN & PHÂN TÍCH') ||
          (hrefs.includes('/marketing') && hrefs.includes('/marketing/flows'));
        const requiredStandaloneHrefsMissing = ['/marketing', '/marketing/flows', '/settings'].filter(
          (h) => !hrefs.includes(h)
        );
        sidebar = {
          exists: true,
          width: Math.round(rect.width),
          hasDarkStop,
          hasLightStop,
          transitionDuration: Math.max(asideDur, navDur),
          navTextColor,
          hasForbiddenUpgradeBox:
            sidebarText.includes('STANDALONE MODE') ||
            sidebarText.includes('Marketing Stan...') ||
            sidebarText.includes('Nâng cấp') ||
            Boolean(aside.querySelector('a[href*="package_upgrade"]')),
          hasMarketingGroup: hasStandaloneMarketingNav,
          requiredStandaloneHrefsMissing,
          crmHrefsFound: ['/data', '/contacts', '/deals', '/rounds', '/rules', '/integrations'].filter((h) =>
            hrefs.includes(h)
          ),
        };
      }

      // Standard AppIcons audit
      const auditIcons = (rootSel, iconSel, minPx, maxPx) => {
        const roots = Array.from(doc.querySelectorAll(rootSel)).filter((el) => {
          const cs = win.getComputedStyle(el);
          if (cs.visibility === 'hidden' || cs.display === 'none' || Number(cs.opacity) === 0) return false;
          if (cs.display !== 'contents') {
            const r = el.getBoundingClientRect();
            if (r.width <= 0 || r.height <= 0) return false;
          }
          return true;
        });
        const seen = new Set();
        const visible = [];
        for (const r of roots) {
          for (const svg of Array.from(r.querySelectorAll(iconSel))) {
            if (seen.has(svg)) continue;
            seen.add(svg);
            const cs = win.getComputedStyle(svg);
            if (cs.display === 'none' || cs.visibility === 'hidden' || Number(cs.opacity) === 0) continue;
            const rect = svg.getBoundingClientRect();
            if (rect.width > 0 && rect.height > 0) {
              visible.push({
                w: Math.round(rect.width * 10) / 10,
                h: Math.round(rect.height * 10) / 10,
              });
            }
          }
        }
        const distorted = visible.filter(
          (d) => d.w < minPx || d.w > maxPx || d.h < minPx || d.h > maxPx || Math.abs(d.w - d.h) > 2
        );
        return { count: visible.length, distorted };
      };

      const sidebarIcons = auditIcons('aside.responsive-sidebar', 'a.sidebar-nav-item svg', 14, 38);
      const mktAppIcons = auditIcons('main .mkt-scope', 'svg[viewBox="0 0 56 56"]', 32, 56);
      let quickNavIcons = { count: 0, distorted: [] };
      if (opts.isQuickNavModal) {
        const modalRoot = Array.from(doc.querySelectorAll('div')).find(
          (d) =>
            (d.textContent || '').includes('Menu điều hướng nhanh') &&
            win.getComputedStyle(d).position === 'fixed'
        );
        if (modalRoot) {
          const visible = [];
          for (const svg of Array.from(modalRoot.querySelectorAll('svg[viewBox="0 0 56 56"]'))) {
            const cs = win.getComputedStyle(svg);
            if (cs.display === 'none' || cs.visibility === 'hidden' || Number(cs.opacity) === 0) continue;
            const rect = svg.getBoundingClientRect();
            if (rect.width > 0 && rect.height > 0) {
              visible.push({
                w: Math.round(rect.width * 10) / 10,
                h: Math.round(rect.height * 10) / 10,
              });
            }
          }
          quickNavIcons = {
            count: visible.length,
            distorted: visible.filter(
              (d) => d.w < 24 || d.w > 56 || d.h < 24 || d.h > 56 || Math.abs(d.w - d.h) > 2
            ),
          };
        }
      }

      // Date range filter presence (includes MktDateRangeFilter & DomUnifiedDatePicker triggers)
      const datePickerEls = Array.from(
        doc.querySelectorAll(
          '[data-testid="erp-datalist-date-picker"], [data-testid="mkt-dashboard-date-picker"], [data-testid="mkt-date-range-filter"], [data-testid="open-date-picker"], [data-testid*="date-picker"], [data-testid*="date-range-filter"]'
        )
      ).filter((el) => {
        if (el.getAttribute('data-testid') === 'unified-date-picker-popover') return false;
        const cs = win.getComputedStyle(el);
        if (cs.display === 'none' || cs.visibility === 'hidden' || Number(cs.opacity) === 0) return false;
        const r = el.getBoundingClientRect();
        return r.width > 0 && r.height > 0;
      });

      return {
        pathname: win.location.pathname,
        search: win.location.search,
        mainTextLength: contentText.length,
        portalTextLength: portalText.length,
        hasAccessDenied: combinedGuardText.includes('Không có quyền truy cập'),
        hasErrorBoundary:
          combinedGuardText.includes('Đã xảy ra lỗi') ||
          combinedGuardText.includes('Đã xảy ra sự cố') ||
          combinedGuardText.includes('Không thể tải nội dung này'),
        hasVisibleMktScope: Boolean(mktScope),
        hasVisibleDomMetaScope: Boolean(domMetaScope),
        splash: {
          exists: Boolean(splash),
          imgSrc: splashImg?.getAttribute('src') || '',
          sourceSrcset: splashSource?.getAttribute('srcset') || '',
          dismissed: splashDismissed,
        },
        decorSvgCount,
        typography: {
          bodyFont: bodyCs.fontFamily || '',
          mktScopeFont: mktScopeCs?.fontFamily || '',
          mktFontVariantNumeric: mktScopeCs?.fontVariantNumeric || '',
          domMetaScopeFont: domMetaScopeCs?.fontFamily || '',
          domMetaHeadingFont: domMetaHeadingCs?.fontFamily || '',
        },
        palette: {
          colorPrimaryVar,
          colorDangerVar,
          colorBgVar,
          colorTextVar,
          purpleMatches,
          mktRedHits,
          primaryCtaBg,
        },
        sidebar,
        icons: {
          sidebar: sidebarIcons,
          appTiles56: mktAppIcons,
          quickNavTiles56: quickNavIcons,
        },
        datePickerCount: datePickerEls.length,
        viewport: {
          scrollWidth: doc.documentElement.scrollWidth,
          innerWidth: win.innerWidth,
        },
      };
    }, {
      requireSapphirePrimaryCta: item.requireSapphirePrimaryCta || null,
      isLandingData: item.effectiveMode === 'landing' && item.route === '/data',
      isQuickNavModal: item.state === 'quick-nav-modal',
    })
    .catch((err) => ({ evalError: err.message }));

  if (domSnap.evalError) {
    return ALL_CHECK_IDS.map((id) =>
      applicable.has(id)
        ? makeCheck(id, 'fail', { evalError: domSnap.evalError }, `DOM evaluation failed: ${domSnap.evalError}`)
        : makeCheck(id, 'skip', null, 'Not applicable to this capture')
    );
  }

  const results = [];

  for (const id of ALL_CHECK_IDS) {
    if (!applicable.has(id)) {
      results.push(makeCheck(id, 'skip', null, 'Not applicable to this capture'));
      continue;
    }

    if (id === 'runtime_clean') {
      const totalErrors =
        diagnostics.consoleErrors.length +
        diagnostics.pageErrors.length +
        diagnostics.http5xxErrors.length +
        diagnostics.requestFailedErrors.length +
        diagnostics.php404Or501Errors.length +
        diagnostics.port3199Requests.length;
      results.push(
        makeCheck(
          id,
          totalErrors === 0 ? 'pass' : 'fail',
          {
            consoleErrors: diagnostics.consoleErrors.length,
            pageErrors: diagnostics.pageErrors.length,
            http5xxErrors: diagnostics.http5xxErrors.length,
            requestFailedErrors: diagnostics.requestFailedErrors.length,
            php404Or501Errors: diagnostics.php404Or501Errors.length,
            port3199Requests: diagnostics.port3199Requests.length,
          },
          totalErrors === 0
            ? 'Zero console, page, 5xx, failed request, .php 404/501, or :3199 errors'
            : `Detected ${totalErrors} runtime/network issue(s)`
        )
      );
      continue;
    }

    if (id === 'route_guard_clean') {
      const expectedPath = item.route.split('?')[0];
      const allowedPaths = new Set([expectedPath]);
      if (expectedPath === '/meta-report' || expectedPath === '/marketing/meta-report') {
        allowedPaths.add('/meta-report');
        allowedPaths.add('/marketing/meta-report');
      }
      if (expectedPath === '/capi' || expectedPath === '/marketing/capi') {
        allowedPaths.add('/capi');
        allowedPaths.add('/marketing/capi');
      }
      if (item.effectiveMode === 'standalone' && expectedPath === '/') {
        allowedPaths.add('/marketing');
      }
      const routeMatched = allowedPaths.has(domSnap.pathname);
      const unexpectedLogin = item.effectiveMode !== 'landing' && domSnap.pathname === '/login';
      const ok =
        domSnap.mainTextLength > 40 &&
        !domSnap.hasAccessDenied &&
        !domSnap.hasErrorBoundary &&
        !unexpectedLogin &&
        routeMatched;
      results.push(
        makeCheck(
          id,
          ok ? 'pass' : 'fail',
          {
            expectedPathname: expectedPath,
            pathname: domSnap.pathname,
            routeMatched,
            mainTextLength: domSnap.mainTextLength,
            portalTextLength: domSnap.portalTextLength ?? 0,
            hasAccessDenied: domSnap.hasAccessDenied,
            hasErrorBoundary: domSnap.hasErrorBoundary,
            unexpectedLogin,
          },
          ok
            ? `Rendered cleanly on ${domSnap.pathname} (${domSnap.mainTextLength} chars)`
            : !routeMatched
              ? `Unexpected route redirect: expected ${expectedPath}, landed on ${domSnap.pathname}`
              : `Route guard violation on ${domSnap.pathname}`
        )
      );
      continue;
    }

    if (id === 'splash_landing_bg') {
      const asset = await checkSplashAssetReachable(erpBaseUrl, cache);
      const splashRefOk =
        domSnap.splash.imgSrc.includes('fluent-brand-ambient-bg') ||
        domSnap.splash.sourceSrcset.includes('fluent-brand-ambient-bg') ||
        Boolean(stateEvidence.splashPreHydration?.hasBgAssetRef);
      const isSplashState = item.state === 'splash-pre-hydration';
      const lifecycleOk = isSplashState
        ? Boolean(stateEvidence.splashPreHydration?.visibleDuringLoad && stateEvidence.splashPreHydration?.dismissedAfterHydration)
        : domSnap.splash.dismissed;
      const ok = asset.ok && splashRefOk && lifecycleOk;
      results.push(
        makeCheck(
          id,
          ok ? 'pass' : 'fail',
          {
            asset,
            splash: domSnap.splash,
            splashPreHydration: stateEvidence.splashPreHydration || null,
          },
          ok
            ? 'Landing ambient BG HTTP 200, referenced in splash, and splash dismissed cleanly'
            : 'Splash landing BG or hydration dismissal check failed'
        )
      );
      continue;
    }

    if (id === 'dom_svg_decor_present') {
      const ok = domSnap.decorSvgCount >= 1;
      results.push(
        makeCheck(
          id,
          ok ? 'pass' : 'fail',
          { decorSvgCount: domSnap.decorSvgCount },
          ok
            ? `Found ${domSnap.decorSvgCount} visible Domation SVG decor element(s)`
            : 'No visible Domation SVG decor elements found'
        )
      );
      continue;
    }

    if (id === 'typography_be_vietnam_pro') {
      const bodyOk = domSnap.typography.bodyFont.toLowerCase().includes('be vietnam pro');
      const mktScopeMissing = Boolean(item.requireMktScope) && !domSnap.hasVisibleMktScope;
      const mktFontOk = !domSnap.hasVisibleMktScope || domSnap.typography.mktScopeFont.toLowerCase().includes('be vietnam pro');
      const tabularOk = !domSnap.hasVisibleMktScope || domSnap.typography.mktFontVariantNumeric.includes('tabular-nums');
      const metaFontOk =
        !domSnap.hasVisibleDomMetaScope ||
        (domSnap.typography.domMetaScopeFont.toLowerCase().includes('be vietnam pro') &&
          domSnap.typography.domMetaHeadingFont.toLowerCase().includes('be vietnam pro'));
      const ok = bodyOk && !mktScopeMissing && mktFontOk && tabularOk && metaFontOk;
      const reasons = [];
      if (!bodyOk) reasons.push(`body font="${domSnap.typography.bodyFont}"`);
      if (mktScopeMissing) reasons.push('missing visible main .mkt-scope wrapper');
      if (!mktFontOk) reasons.push(`.mkt-scope font="${domSnap.typography.mktScopeFont}"`);
      if (!tabularOk) reasons.push(`.mkt-scope fontVariantNumeric="${domSnap.typography.mktFontVariantNumeric}"`);
      if (!metaFontOk) {
        reasons.push(
          `.dom-meta-scope font="${domSnap.typography.domMetaScopeFont}" / heading="${domSnap.typography.domMetaHeadingFont}"`
        );
      }
      results.push(
        makeCheck(
          id,
          ok ? 'pass' : 'fail',
          {
            ...domSnap.typography,
            hasVisibleMktScope: domSnap.hasVisibleMktScope,
            hasVisibleDomMetaScope: domSnap.hasVisibleDomMetaScope,
          },
          ok ? 'Be Vietnam Pro & tabular-nums verified' : `Typography parity failure: ${reasons.join('; ')}`
        )
      );
      continue;
    }

    if (id === 'palette_sapphire_red_no_purple') {
      const p = domSnap.palette;
      const tokensOk =
        p.colorPrimaryVar === '#1e40ff' &&
        (p.colorDangerVar === '#dc2626' || p.colorDangerVar === '#ef4444') &&
        p.colorBgVar === '#f8f9fa' &&
        p.colorTextVar === '#0f172a';
      const noPurpleOk = p.purpleMatches.length === 0;
      const mktRedOk = !item.requireMktRedAccent || p.mktRedHits >= 1;
      const quickNavRedOk = !item.requireQuickNavRedAccent || (stateEvidence.quickNavRedCount ?? 0) >= 1;
      const primaryCtaOk =
        !item.requireSapphirePrimaryCta || p.primaryCtaBg === 'rgb(30, 64, 255)';
      const ok = tokensOk && noPurpleOk && mktRedOk && quickNavRedOk && primaryCtaOk;
      results.push(
        makeCheck(
          id,
          ok ? 'pass' : 'fail',
          {
            ...p,
            quickNavRedCount: stateEvidence.quickNavRedCount ?? null,
          },
          ok
            ? 'Royal Sapphire + Red accent verified with zero legacy purple'
            : `Palette mismatch (tokensOk=${tokensOk}, noPurple=${noPurpleOk}, mktRed=${mktRedOk}, quickNavRed=${quickNavRedOk}, primaryCta=${primaryCtaOk})`
        )
      );
      continue;
    }

    if (id === 'sidebar_light_animated_clean') {
      const sb = domSnap.sidebar;
      const navTextOk =
        !sb.navTextColor ||
        (sb.navTextColor.r < 130 && sb.navTextColor.g < 130 && sb.navTextColor.b < 130);
      const collapsedOk = item.state !== 'sidebar-collapsed' || (sb.width > 0 && sb.width <= 96);
      const standaloneScopeOk =
        item.effectiveMode !== 'standalone' ||
        (sb.hasMarketingGroup &&
          sb.crmHrefsFound.length === 0 &&
          (!sb.requiredStandaloneHrefsMissing || sb.requiredStandaloneHrefsMissing.length === 0));
      const ok =
        sb.exists &&
        !sb.hasDarkStop &&
        sb.hasLightStop &&
        sb.transitionDuration > 0 &&
        navTextOk &&
        !sb.hasForbiddenUpgradeBox &&
        collapsedOk &&
        standaloneScopeOk;
      results.push(
        makeCheck(
          id,
          ok ? 'pass' : 'fail',
          sb,
          ok
            ? `White/light animated sidebar verified (width=${sb.width}px, transition=${sb.transitionDuration}s)`
            : 'White/light sidebar contract failed'
        )
      );
      continue;
    }

    if (id === 'settings_upgrade_relocated') {
      const ev = stateEvidence.settingsUpgrade || {};
      const ok = Boolean(ev.hasUpgradeCta && ev.hasUpgradeBanner && ev.upgradePanelBtnCount >= 1);
      results.push(
        makeCheck(
          id,
          ok ? 'pass' : 'fail',
          ev,
          ok
            ? 'Upgrade CTA, banner, and ?tab=package_upgrade panel verified in Settings'
            : 'Missing expected Settings upgrade CTA, banner, or package_upgrade panel'
        )
      );
      continue;
    }

    if (id === 'standard_app_icons') {
      const sbIcons = domSnap.icons.sidebar;
      const appIcons = domSnap.icons.appTiles56;
      const qnIcons = domSnap.icons.quickNavTiles56 || { count: 0, distorted: [] };
      const totalCount = sbIcons.count + appIcons.count + qnIcons.count;
      const totalDistorted = sbIcons.distorted.length + appIcons.distorted.length + qnIcons.distorted.length;
      const sidebarIconsOk = !domSnap.sidebar.exists || sbIcons.count >= 1;
      const mktTilesOk = !item.requireMktAppIcons || appIcons.count >= 1;
      const quickNavTilesOk = !item.requireQuickNavAppIcons || qnIcons.count >= 1;
      const ok = totalCount >= 1 && totalDistorted === 0 && sidebarIconsOk && mktTilesOk && quickNavTilesOk;
      results.push(
        makeCheck(
          id,
          ok ? 'pass' : 'fail',
          domSnap.icons,
          ok
            ? `Verified ${totalCount} square bounded icon(s) with 0 distorted`
            : `AppIcons check failed (sidebar=${sbIcons.count}, mktTiles56=${appIcons.count}, quickNav56=${qnIcons.count}, distorted=${totalDistorted})`
        )
      );
      continue;
    }

    if (id === 'date_range_filter_present') {
      const hasTrigger = domSnap.datePickerCount >= 1;
      const popoverOk = !item.exerciseDatePopover || Boolean(stateEvidence.datePopoverOpened);
      const ok = hasTrigger && popoverOk;
      results.push(
        makeCheck(
          id,
          ok ? 'pass' : 'fail',
          {
            datePickerCount: domSnap.datePickerCount,
            datePopoverOpened: item.exerciseDatePopover ? Boolean(stateEvidence.datePopoverOpened) : 'not-tested',
          },
          ok
            ? `Unified date picker present (count=${domSnap.datePickerCount})`
            : `Unified date picker missing or popover failed (count=${domSnap.datePickerCount}, popover=${stateEvidence.datePopoverOpened})`
        )
      );
      continue;
    }

    if (id === 'modal_zns_drawer_tour_contracts') {
      const r3 = stateEvidence.r3Contract || { ok: false, detail: 'No R3 contract evidence recorded' };
      results.push(
        makeCheck(id, r3.ok ? 'pass' : 'fail', r3.actual ?? null, r3.detail || (r3.ok ? 'Passed' : 'Failed'))
      );
      continue;
    }

    if (id === 'viewport_no_horizontal_overflow') {
      const ok = domSnap.viewport.scrollWidth <= domSnap.viewport.innerWidth + 2;
      results.push(
        makeCheck(
          id,
          ok ? 'pass' : 'fail',
          domSnap.viewport,
          ok
            ? `No horizontal overflow (${domSnap.viewport.scrollWidth}px <= ${domSnap.viewport.innerWidth + 2}px)`
            : `Horizontal overflow detected: scrollWidth=${domSnap.viewport.scrollWidth}px > innerWidth=${domSnap.viewport.innerWidth}px`
        )
      );
      continue;
    }
  }

  return results;
}

// ============================================================================
// Specialized Capture Executors (Groups A–E)
// ============================================================================

async function captureLoadingSplash(browser, erpBaseUrl, auth, item, config, cache, { openContexts = null, allowPort3199 = false } = {}) {
  const ctx = await browser.createBrowserContext();
  openContexts?.add(ctx);
  const page = await ctx.newPage();
  const diag = attachPageDiagnostics(page, { allowPort3199: allowPort3199 || erpBaseUrl.includes(':3199') });
  let releaseEntryJs = null;

  try {
    await page.setViewport({
      width: item.viewport.width,
      height: item.viewport.height,
      deviceScaleFactor: 1,
    });
    if (auth) {
      await seedErpAuthOnDocument(page, auth);
    }

    await page.setRequestInterception(true);
    const entryGate = new Promise((resolve) => {
      releaseEntryJs = resolve;
    });

    page.on('request', async (req) => {
      if (req.isInterceptResolutionHandled()) return;
      const url = req.url();
      if (url.includes('/src/main.tsx') || /\/assets\/index-[^/]+\.js/.test(url)) {
        await Promise.race([entryGate, sleep(12_000)]);
      }
      if (!req.isInterceptResolutionHandled()) {
        req.continue().catch(() => {});
      }
    });

    // Start navigation without awaiting domcontentloaded yet because <script type="module"> blocks domcontentloaded
    const navPromise = page.goto(`${erpBaseUrl}/`, { waitUntil: 'domcontentloaded', timeout: config.timeoutMs });
    navPromise.catch(() => {});

    await page.waitForSelector('#ideas-splash-screen', { timeout: 10_000 });
    await page
      .waitForFunction(
        () => {
          const img = document.querySelector('#ideas-splash-screen img');
          return Boolean(img && img.complete && img.naturalWidth > 0);
        },
        { timeout: 8_000 }
      )
      .catch(() => {});
    await sleep(250);

    const preState = await page.evaluate(() => {
      const splash = document.getElementById('ideas-splash-screen');
      const img = splash?.querySelector('img');
      const source = splash?.querySelector('source');
      const svg = splash?.querySelector('svg.splash-silk-svg');
      const cs = splash ? window.getComputedStyle(splash) : null;
      return {
        visibleDuringLoad: Boolean(
          splash && cs && cs.display !== 'none' && cs.visibility !== 'hidden' && Number(cs.opacity) > 0.5
        ),
        hasBgAssetRef: Boolean(
          (img?.getAttribute('src') || '').includes('fluent-brand-ambient-bg') ||
            (source?.getAttribute('srcset') || '').includes('fluent-brand-ambient-bg')
        ),
        imgLoaded: Boolean(img && img.complete && img.naturalWidth > 0),
        hasSilkSvg: Boolean(svg && svg.getAttribute('viewBox') === '0 0 1440 500'),
        hasBrandTitle: (splash?.innerText || '').includes('DOMATION Suite'),
      };
    });

    fs.mkdirSync(path.dirname(item.absScreenshotPath), { recursive: true });
    await page.screenshot({ path: item.absScreenshotPath, fullPage: config.fullPage });

    // Release entry module, complete navigation, and verify splash dismisses cleanly after hydration
    releaseEntryJs?.();
    await navPromise;
    await waitForAppReady(page, config.timeoutMs);
    const dismissedAfterHydration = await page.evaluate(() => {
      const splash = document.getElementById('ideas-splash-screen');
      if (!splash) return true;
      const cs = window.getComputedStyle(splash);
      return (
        splash.classList?.contains('splash-fade-out') ||
        cs.display === 'none' ||
        cs.visibility === 'hidden' ||
        Number(cs.opacity) === 0
      );
    });

    const checks = await evaluateAllChecks(page, item, {
      diagnostics: diag.snapshot(),
      stateEvidence: {
        splashPreHydration: {
          ...preState,
          dismissedAfterHydration,
        },
      },
      erpBaseUrl,
      cache,
    });

    return { checks, diagnostics: diag.snapshot(), url: page.url() };
  } finally {
    releaseEntryJs?.();
    openContexts?.delete(ctx);
    await Promise.allSettled([page.close(), ctx.close()]);
  }
}

async function openSeededFlowInBuilder(
  page,
  baseUrl,
  fixtures,
  timeoutMs,
  { ensureDesignTab = true, preferAnalyticsFlow = false } = {}
) {
  const flowNeedle =
    (preferAnalyticsFlow && fixtures?.analyticsFlowName) || fixtures?.flowName || 'Flow';

  const alreadyInBuilder = await page
    .evaluate((needle) => {
      const portal = document.getElementById('mkt-portal-root');
      if (!portal || window.location.pathname !== '/marketing/flows') return false;
      const btns = Array.from(portal.querySelectorAll('button')).map((b) => (b.textContent || '').trim());
      const hasBuilderShell =
        Boolean(portal.querySelector('[id^="step-node-"]')) ||
        (btns.some((t) => t === 'Thiết kế' || t.includes('Thiết kế')) &&
          btns.some((t) => t === 'Báo cáo' || t.includes('Báo cáo')));
      if (!hasBuilderShell) return false;
      if (needle && !(portal.innerText || '').includes(needle)) return false;
      return true;
    }, flowNeedle)
    .catch(() => false);

  if (alreadyInBuilder) {
    // Ensure any previous portal modal is closed
    await page.keyboard.press('Escape').catch(() => {});
    await sleep(150);
    if (ensureDesignTab) {
      const clickedDesign =
        (await clickButtonByText(page, 'Thiết kế', { exact: true, rootSelector: '#mkt-portal-root' }).catch(() => false)) ||
        (await clickButtonByText(page, 'Thiết kế', { rootSelector: '#mkt-portal-root' }).catch(() => false)) ||
        (await clickButtonByText(page, 'Thiết kế').catch(() => false));
      if (clickedDesign) {
        await page
          .waitForFunction(() => document.querySelectorAll('[id^="step-node-"]').length >= 1, { timeout: 8_000 })
          .catch(() => {});
      }
      await sleep(250);
    }
    return true;
  }

  await navigateRoute(page, baseUrl, '/marketing/flows', timeoutMs);
  await waitForMainRouteReady(page, '/marketing/flows', timeoutMs);

  let foundInDefaultView = await page
    .waitForFunction(
      (needle) => (document.querySelector('main')?.innerText || '').includes(needle),
      { timeout: 3_500 },
      flowNeedle
    )
    .then(() => true)
    .catch(() => false);

  if (!foundInDefaultView) {
    // Flows list defaults to "Tháng này"; switch MktDateRangeFilter to "Tất cả" so older rich-telemetry flows become visible.
    const openedDateMenu = await page
      .evaluate(() => {
        const btn =
          document.querySelector('main [data-testid="mkt-date-range-filter"] button') ||
          document.querySelector('main button[data-testid="mkt-date-range-filter"]') ||
          Array.from(document.querySelectorAll('main button')).find((b) =>
            /tháng này|7 ngày|30 ngày|hôm nay/i.test(b.textContent || '')
          );
        if (!btn) return false;
        btn.scrollIntoView({ block: 'center' });
        btn.click();
        return true;
      })
      .catch(() => false);
    if (openedDateMenu) {
      await page.waitForSelector('[data-testid="unified-date-picker-popover"]', { timeout: 3_000 }).catch(() => {});
      await clickButtonByText(page, 'Tất cả', { exact: true, rootSelector: '[data-testid="unified-date-picker-popover"]' }).catch(
        async () => {
          await clickButtonByText(page, 'Tất cả', { rootSelector: '[data-testid="unified-date-picker-popover"]' }).catch(() => {});
        }
      );
      await page
        .waitForFunction(
          (needle) => {
            const txt = document.querySelector('main')?.innerText || '';
            return !txt.includes('Đang tải...') && txt.includes(needle);
          },
          { timeout: 8_000 },
          flowNeedle
        )
        .catch(() => {});
      await sleep(250);
    }
  }

  const clickFlowRow = async () =>
    page.evaluate((needle) => {
      const scope =
        Array.from(document.querySelectorAll('main .mkt-scope')).find((el) => {
          const cs = window.getComputedStyle(el);
          return el.style?.display !== 'contents' && cs.display !== 'none' && cs.visibility !== 'hidden';
        }) || document.querySelector('main');
      if (!scope) return false;
      const isVis = (el) => {
        const cs = window.getComputedStyle(el);
        const r = el.getBoundingClientRect();
        return cs.display !== 'none' && cs.visibility !== 'hidden' && r.width > 0 && r.height > 0;
      };
      const candidates = Array.from(scope.querySelectorAll('tbody tr, div.cursor-pointer, [role="button"]')).filter(isVis);
      const match =
        candidates.find((el) => (el.textContent || '').includes(needle)) ||
        candidates.find((el) => (el.textContent || '').trim().length > 10);
      if (!match) return false;
      match.scrollIntoView({ block: 'center' });
      match.click();
      return true;
    }, flowNeedle);

  let opened = await clickFlowRow();

  if (opened) {
    const waitHeaderReady = async (ms) =>
      page
        .waitForFunction(
          () => {
            const portal = document.getElementById('mkt-portal-root');
            if (!portal) return false;
            const btns = Array.from(portal.querySelectorAll('button')).map((b) => (b.textContent || '').trim());
            return btns.some((t) => t.includes('Thiết kế')) && btns.some((t) => t.includes('Báo cáo'));
          },
          { timeout: ms }
        )
        .then(() => true)
        .catch(() => false);

    let ready = await waitHeaderReady(8_000);
    if (!ready) {
      opened = await clickFlowRow();
      if (opened) ready = await waitHeaderReady(10_000);
    }

    if (ready && ensureDesignTab) {
      // Wait for lazy-loaded full flow steps (PERF-F3 fetches flows?id=... after opening)
      await page
        .waitForFunction(() => document.querySelectorAll('[id^="step-node-"]').length >= 2, { timeout: 6_000 })
        .catch(() =>
          page
            .waitForFunction(() => document.querySelectorAll('[id^="step-node-"]').length >= 1, { timeout: 4_000 })
            .catch(() => {})
        );
    }
    await sleep(350);
  }
  return opened;
}

async function executeStandardOrInteractiveCapture(page, item, ctxInfo) {
  const { baseUrl, erpBaseUrl, fixtures, config, diag, cache } = ctxInfo;
  const stateEvidence = {};
  let postScreenshotVerify = null;
  let postCaptureCleanup = null;

  diag.reset();

  // Route preparation & interactive state triggers
  if (item.state === 'sidebar-collapsed') {
    await navigateSpaOrDirect(page, baseUrl, item.route, config.timeoutMs);
    await waitForMainRouteReady(page, item.route, config.timeoutMs);

    // Hover sidebar so Sidebar.tsx reveals its collapse button (opacity: isHovered ? 1 : 0)
    await page.hover('aside.responsive-sidebar').catch(() => {});
    await sleep(150);

    const collapsed = await page.evaluate(() => {
      const aside = document.querySelector('aside.responsive-sidebar');
      if (!aside) return false;
      const beforeW = aside.getBoundingClientRect().width;
      if (beforeW <= 96) return true;
      const findCollapseBtn = () =>
        document.querySelector('[data-testid="sidebar-collapse-toggle"]') ||
        aside.querySelector('button[title*="Thu gọn"], button[aria-label*="Thu gọn"], button[title*="Collapse"]') ||
        aside.querySelector('button.responsive-hide-mobile.no-active-scale') ||
        Array.from(aside.querySelectorAll('button')).find((b) => {
          const cs = window.getComputedStyle(b);
          return cs.position === 'absolute' && (cs.borderRadius === '50%' || cs.borderRadius === '9999px');
        });
      const btn = findCollapseBtn();
      if (!btn) return false;
      btn.click();
      return true;
    });
    if (collapsed) {
      await sleep(450);
      postCaptureCleanup = async () => {
        await page
          .evaluate(() => {
            const aside = document.querySelector('aside.responsive-sidebar');
            if (!aside || aside.getBoundingClientRect().width > 120) return;
            const btn =
              document.querySelector('[data-testid="sidebar-collapse-toggle"]') ||
              aside.querySelector('button[title*="Mở rộng"], button[aria-label*="Mở rộng"], button[title*="Thu gọn"]') ||
              aside.querySelector('button.responsive-hide-mobile.no-active-scale') ||
              Array.from(aside.querySelectorAll('button')).find((b) => {
                const cs = window.getComputedStyle(b);
                return cs.position === 'absolute' && (cs.borderRadius === '50%' || cs.borderRadius === '9999px');
              });
            btn?.click();
          })
          .catch(() => {});
        await sleep(350);
      };
    }
  } else if (item.state === 'quick-nav-modal') {
    await navigateSpaOrDirect(page, baseUrl, item.route, config.timeoutMs);
    await waitForMainRouteReady(page, item.route, config.timeoutMs);

    await page.evaluate(() => {
      window.dispatchEvent(new CustomEvent('open-quick-menu'));
    });
    await page
      .waitForFunction(
        () => (document.body.innerText || '').includes('Menu điều hướng nhanh'),
        { timeout: 8_000 }
      )
      .catch(() => {});
    await sleep(300);

    stateEvidence.quickNavRedCount = await page.evaluate(() => {
      const modalRoot = Array.from(document.querySelectorAll('div')).find(
        (d) =>
          (d.textContent || '').includes('Menu điều hướng nhanh') &&
          window.getComputedStyle(d).position === 'fixed'
      );
      if (!modalRoot) return 0;
      let hits = 0;
      for (const el of Array.from(modalRoot.querySelectorAll('*'))) {
        const tag = (el.tagName || '').toLowerCase();
        const cs = window.getComputedStyle(el);
        if (cs.display === 'none' || cs.visibility === 'hidden') continue;
        const combined = `${cs.backgroundColor || ''} ${cs.backgroundImage || ''} ${cs.borderColor || ''} ${cs.color || ''}`;
        const rgbHit = Array.from(
          combined.matchAll(/rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)(?:\s*,\s*[\d.]+)?\s*\)/gi)
        ).some((m) => Number(m[1]) >= 200 && Number(m[2]) <= 80 && Number(m[3]) <= 90);
        const hexHit = /#(?:dc2626|ef4444|e11d48|b91c1c|f43f5e)/i.test(combined);
        if (rgbHit || hexHit) {
          hits++;
          continue;
        }
        if (tag === 'stop' || tag === 'path' || tag === 'rect' || tag === 'circle') {
          const attrs = `${el.getAttribute('stop-color') || ''} ${el.getAttribute('fill') || ''} ${el.getAttribute('stroke') || ''}`;
          const attrRgbHit = Array.from(
            attrs.matchAll(/rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)(?:\s*,\s*[\d.]+)?\s*\)/gi)
          ).some((m) => Number(m[1]) >= 200 && Number(m[2]) <= 80 && Number(m[3]) <= 90);
          const attrHexHit = /#(?:dc2626|ef4444|e11d48|b91c1c|f43f5e)/i.test(attrs);
          if (attrRgbHit || attrHexHit) {
            hits++;
          }
        }
      }
      return hits;
    });

    postCaptureCleanup = async () => {
      await page.keyboard.press('Escape').catch(() => {});
      await sleep(250);
    };
  } else if (item.state === 'settings-upgrade') {
    // Open a non-package_upgrade tab in /settings first (Settings.tsx defaults standalone admins to package_upgrade,
    // which intentionally hides settings-upgrade-cta & settings-upgrade-banner when activeTab === 'package_upgrade').
    await navigateRoute(page, baseUrl, '/settings?tab=email_config', config.timeoutMs);
    await waitForMainRouteReady(page, '/settings', config.timeoutMs);
    await page
      .waitForSelector('[data-testid="settings-upgrade-cta"], [data-testid="settings-upgrade-banner"]', {
        timeout: 8_000,
      })
      .catch(() => {});
    await sleep(300);

    const beforeTab = await page.evaluate(() => {
      const isVis = (el) => {
        if (!el) return false;
        const cs = window.getComputedStyle(el);
        const r = el.getBoundingClientRect();
        return cs.display !== 'none' && cs.visibility !== 'hidden' && r.width > 0 && r.height > 0;
      };
      return {
        hasUpgradeCta: isVis(document.querySelector('[data-testid="settings-upgrade-cta"]')),
        hasUpgradeBanner: isVis(document.querySelector('[data-testid="settings-upgrade-banner"]')),
      };
    });

    const clickedCta = await page.evaluate(() => {
      const btn = document.querySelector('[data-testid="settings-upgrade-cta"]');
      if (btn) {
        btn.click();
        return true;
      }
      return false;
    });
    if (!clickedCta) {
      await navigateRoute(page, baseUrl, '/settings?tab=package_upgrade', config.timeoutMs);
    }
    await page
      .waitForFunction(
        () => {
          const pane = document.querySelector('main .subtab-enter-active');
          if (!pane) return false;
          const cs = window.getComputedStyle(pane);
          if (Number(cs.opacity) < 0.95) return false;
          const txt = (pane.innerText || '').trim();
          return (
            txt.length > 120 &&
            (txt.includes('Growth') || txt.includes('PROMAX') || txt.includes('DOM ERP') || txt.includes('Gói dịch vụ'))
          );
        },
        { timeout: 12_000 }
      )
      .catch(() => {});
    await sleep(300);

    const panelCheck = await page.evaluate(() => {
      const main = document.querySelector('main');
      const btns = Array.from(main?.querySelectorAll('button') || []);
      return {
        hasUpgradePanelText: (main?.innerText || '').includes('Gói dịch vụ'),
        upgradePanelBtnCount: btns.filter((b) => (b.textContent || '').includes('Nâng cấp')).length,
      };
    });

    stateEvidence.settingsUpgrade = { ...beforeTab, ...panelCheck };
  } else if (item.state === 'flow-builder') {
    const opened = await openSeededFlowInBuilder(page, baseUrl, fixtures, config.timeoutMs);
    const builderState = await page.evaluate(() => {
      const txt = document.body.innerText || '';
      const stepNodes = document.querySelectorAll('[id^="step-node-"]').length;
      return {
        stepNodes,
        hasDesignTab: txt.includes('Thiết kế'),
        hasReportTab: txt.includes('Báo cáo'),
        hasSettingsTab: txt.includes('Cài đặt'),
      };
    });
    const ok = opened && builderState.stepNodes >= 1 && builderState.hasDesignTab && builderState.hasReportTab;
    stateEvidence.r3Contract = {
      ok,
      actual: { opened, ...builderState },
      detail: ok
        ? `FlowBuilder rendered ${builderState.stepNodes} step node(s) with Thiết kế/Báo cáo tabs`
        : 'FlowBuilder failed to open or missing step nodes / header tabs',
    };
  } else if (item.state === 'modal-step-email-3xl') {
    await openSeededFlowInBuilder(page, baseUrl, fixtures, config.timeoutMs);
    const stepSel = `#step-node-${fixtures?.emailStepId || 'step_email_ui_1'}`;
    // Resolve exact node selector and use real Puppeteer mouse click (FlowTree puts onClick on inner card, not outer #step-node-*)
    const resolvedEmailSel = await page
      .evaluate((sel) => {
        const direct = document.querySelector(sel);
        if (direct) {
          direct.scrollIntoView({ block: 'center', inline: 'center' });
          return sel;
        }
        const fallback = Array.from(document.querySelectorAll('[id^="step-node-"]')).find((n) =>
          (n.textContent || '').toLowerCase().includes('email')
        );
        if (!fallback) return null;
        fallback.scrollIntoView({ block: 'center', inline: 'center' });
        return `#${fallback.id}`;
      }, stepSel)
      .catch(() => null);

    let clickedNode = false;
    if (resolvedEmailSel) {
      await sleep(150);
      clickedNode = await page
        .click(resolvedEmailSel)
        .then(() => true)
        .catch(() => false);
    }

    if (clickedNode) {
      await page
        .waitForFunction(
          () => (document.getElementById('mkt-portal-root')?.innerText || '').includes('Cấu hình bước'),
          { timeout: 10_000 }
        )
        .catch(() => {});
      await sleep(350);

      // Ensure live 2-column HTML email preview is active inside the 3xl modal
      const hasPreviewIframe = await page
        .waitForFunction(
          () => Boolean(document.getElementById('mkt-portal-root')?.querySelector('iframe[title="Live Email Preview"]')),
          { timeout: 1_500 }
        )
        .then(() => true)
        .catch(() => false);

      if (!hasPreviewIframe) {
        const openedPicker =
          (await clickButtonByText(page, 'Chọn mẫu ngay', { rootSelector: '#mkt-portal-root' }).catch(() => false)) ||
          (await clickButtonByText(page, 'Chọn mẫu từ thư viện', { rootSelector: '#mkt-portal-root' }).catch(() => false));
        if (openedPicker) {
          // EmailActionConfig portals the template picker modal directly to document.body (outside #mkt-portal-root)
          await page
            .waitForFunction(
              () => (document.body?.innerText || '').includes('Chọn mẫu Email'),
              { timeout: 6_000 }
            )
            .catch(() => {});
          await sleep(300);
          const pickedTpl = await page
            .evaluate(() => {
              const heading = Array.from(document.querySelectorAll('h3')).find((h) =>
                (h.textContent || '').includes('Chọn mẫu Email')
              );
              const pickerRoot = heading?.closest('div.fixed') || heading?.parentElement?.parentElement || document.body;
              const card = pickerRoot?.querySelector('div.cursor-pointer.rounded-2xl');
              if (!card) return false;
              card.scrollIntoView({ block: 'center' });
              card.click();
              return true;
            })
            .catch(() => false);
          if (pickedTpl) {
            await page
              .waitForFunction(
                () =>
                  Boolean(document.getElementById('mkt-portal-root')?.querySelector('iframe[title="Live Email Preview"]')),
                { timeout: 8_000 }
              )
              .catch(() => {});
            await sleep(500);
          }
        }
      } else {
        await sleep(350);
      }
    }

    const modalAudit = await page.evaluate(() => {
      const portal = document.getElementById('mkt-portal-root');
      const subjectInput = portal?.querySelector(
        'input[placeholder*="Quà tặng"], input[placeholder*="first_name"]'
      );
      const mergeBtn = portal?.querySelector('button[title="Cá nhân hóa tiêu đề"]');
      const visualBtn = Array.from(portal?.querySelectorAll('button') || []).find((b) =>
        (b.textContent || '').includes('Chọn Mẫu (Visual)')
      );
      const htmlBtn = Array.from(portal?.querySelectorAll('button') || []).find((b) =>
        (b.textContent || '').includes('HTML Code')
      );

      let dialogBox = subjectInput?.parentElement;
      while (dialogBox && dialogBox !== portal) {
        const cls = String(dialogBox.className || '');
        if (cls.includes('max-w-') && (cls.includes('rounded-[var(--radius-xl)]') || cls.includes('shadow-'))) {
          break;
        }
        dialogBox = dialogBox.parentElement;
      }
      if (!dialogBox || dialogBox === portal) {
        dialogBox = Array.from(portal?.querySelectorAll('div') || [])
          .filter((d) => {
            const cls = String(d.className || '');
            const r = d.getBoundingClientRect();
            return (
              r.width >= 300 &&
              cls.includes('max-w-') &&
              (cls.includes('rounded-[var(--radius-xl)]') || cls.includes('shadow-')) &&
              (d.textContent || '').includes('Cấu hình bước')
            );
          })
          .sort((a, b) => b.getBoundingClientRect().width - a.getBoundingClientRect().width)[0] || null;
      }
      const dialogRect = dialogBox ? dialogBox.getBoundingClientRect() : { width: 0, height: 0 };
      const dialogClass = dialogBox ? String(dialogBox.className || '') : '';
      const scrollBody = Array.from(dialogBox?.querySelectorAll('div') || []).find((d) =>
        String(d.className || '').includes('overflow-y-auto')
      );

      const candidates = scrollBody
        ? [scrollBody, ...Array.from(scrollBody.querySelectorAll('div, section, form'))]
        : [];
      let twoColumnEvidence = null;
      for (const container of candidates) {
        const cs = window.getComputedStyle(container);
        if (cs.display === 'none' || cs.visibility === 'hidden') continue;
        const children = Array.from(container.children || []).filter((ch) => {
          if (ch.tagName === 'BUTTON') return false;
          const ccs = window.getComputedStyle(ch);
          if (ccs.display === 'none' || ccs.visibility === 'hidden') return false;
          const r = ch.getBoundingClientRect();
          return r.width >= 150 && r.height >= 120;
        });
        if (children.length < 2) continue;

        let foundPair = null;
        for (let i = 0; i < children.length && !foundPair; i++) {
          const c1 = children[i];
          const r1 = c1.getBoundingClientRect();
          for (let j = i + 1; j < children.length; j++) {
            const c2 = children[j];
            const r2 = c2.getBoundingClientRect();
            const leftDelta = Math.abs(r1.left - r2.left);
            const yOverlap = Math.min(r1.bottom, r2.bottom) - Math.max(r1.top, r2.top);
            const subjectCol =
              subjectInput && c1.contains(subjectInput) && !c2.contains(subjectInput)
                ? c1
                : subjectInput && c2.contains(subjectInput) && !c1.contains(subjectInput)
                  ? c2
                  : null;
            const oppositeCol = subjectCol === c1 ? c2 : subjectCol === c2 ? c1 : null;
            const hasContentToggleOppositeCol = Boolean(
              subjectCol &&
                oppositeCol &&
                ((visualBtn && oppositeCol.contains(visualBtn) && !subjectCol.contains(visualBtn)) ||
                  (htmlBtn && oppositeCol.contains(htmlBtn) && !subjectCol.contains(htmlBtn)))
            );
            const hasPreviewOrEditorOppositeCol = Boolean(
              oppositeCol &&
                (oppositeCol.querySelector('iframe, textarea, [data-testid*="preview"]') ||
                  /xem trước|preview|nội dung email|dữ liệu mẫu|desktop|toàn màn hình|gửi thử/i.test(
                    oppositeCol.innerText || oppositeCol.textContent || ''
                  ))
            );
            const hasDistinctSections =
              Boolean(subjectCol && oppositeCol) &&
              (hasPreviewOrEditorOppositeCol || (visualBtn || htmlBtn ? hasContentToggleOppositeCol : true));
            if (leftDelta >= 150 && yOverlap >= 40 && hasDistinctSections) {
              foundPair = { col1Left: Math.round(r1.left), col2Left: Math.round(r2.left) };
              break;
            }
          }
        }
        if (!foundPair) continue;
        if (cs.display.includes('grid')) {
          const tracks = String(cs.gridTemplateColumns || '')
            .trim()
            .split(/\s+/)
            .map((t) => parseFloat(t))
            .filter((n) => Number.isFinite(n) && n > 0);
          if (tracks.length >= 2) {
            twoColumnEvidence = { mode: 'grid', trackCount: tracks.length, ...foundPair };
            break;
          }
        }
        if (cs.display.includes('flex') && cs.flexDirection !== 'column') {
          twoColumnEvidence = { mode: 'flex-row', ...foundPair };
          break;
        }
      }

      return {
        dialogWidth: Math.round(dialogRect.width),
        dialogClass,
        hasSubjectInput: Boolean(subjectInput),
        hasMergeBtn: Boolean(mergeBtn && !mergeBtn.disabled),
        hasVisualBtn: Boolean(visualBtn),
        hasHtmlBtn: Boolean(htmlBtn),
        twoColumnEvidence,
        bodyScrollWidth: scrollBody ? scrollBody.scrollWidth : 0,
        bodyClientWidth: scrollBody ? scrollBody.clientWidth : 0,
      };
    });

    const ok =
      clickedNode &&
      modalAudit.hasSubjectInput &&
      modalAudit.hasMergeBtn &&
      modalAudit.hasVisualBtn &&
      modalAudit.hasHtmlBtn &&
      !modalAudit.dialogClass.includes('max-w-2xl') &&
      modalAudit.dialogWidth >= 768 &&
      modalAudit.twoColumnEvidence !== null &&
      modalAudit.bodyScrollWidth <= modalAudit.bodyClientWidth + 2;

    stateEvidence.r3Contract = {
      ok,
      actual: modalAudit,
      detail: ok
        ? `Email StepEditor 3xl verified (${modalAudit.dialogWidth}px, 2-col ${modalAudit.twoColumnEvidence?.mode})`
        : `Email StepEditor contract failed (width=${modalAudit.dialogWidth}px, twoCol=${Boolean(modalAudit.twoColumnEvidence)})`,
    };

    postCaptureCleanup = async () => {
      await page.keyboard.press('Escape').catch(() => {});
      await sleep(250);
    };
  } else if (item.state === 'modal-step-zns-2xl') {
    await openSeededFlowInBuilder(page, baseUrl, fixtures, config.timeoutMs);
    const stepSel = `#step-node-${fixtures?.znsStepId || 'step_zns_ui_1'}`;
    // Resolve exact node selector and use real Puppeteer mouse click (FlowTree puts onClick on inner ZaloZNSNode, not outer wrapper)
    const resolvedZnsSel = await page
      .evaluate((sel) => {
        const direct = document.querySelector(sel);
        if (direct) {
          direct.scrollIntoView({ block: 'center', inline: 'center' });
          return sel;
        }
        const fallback = Array.from(document.querySelectorAll('[id^="step-node-"]')).find((n) =>
          (n.textContent || '').toLowerCase().includes('zns')
        );
        if (!fallback) return null;
        fallback.scrollIntoView({ block: 'center', inline: 'center' });
        return `#${fallback.id}`;
      }, stepSel)
      .catch(() => null);

    let clickedNode = false;
    if (resolvedZnsSel) {
      await sleep(150);
      clickedNode = await page
        .click(resolvedZnsSel)
        .then(() => true)
        .catch(() => false);
    }

    if (clickedNode) {
      await page
        .waitForFunction(
          () => {
            const txt = document.getElementById('mkt-portal-root')?.innerText || '';
            return txt.includes('Cấu hình bước') && !txt.includes('Đang tải cấu hình Zalo OA');
          },
          { timeout: 10_000 }
        )
        .catch(() => {});
      if (item.mode === 'zalo_demo') {
        await page
          .waitForFunction(
            () => {
              const txt = document.getElementById('mkt-portal-root')?.innerText || '';
              return (
                !txt.includes('Đang tải') &&
                (/Xác nhận lịch tư vấn|ZNS_SHOWCASE_001|Xin chào/i.test(txt))
              );
            },
            { timeout: 5_000 }
          )
          .catch(() => {});
      }
      await sleep(450);
    }

    const znsModalAudit = await page.evaluate(() => {
      const portal = document.getElementById('mkt-portal-root');
      const txt = portal?.innerText || '';
      const dialogBox = Array.from(portal?.querySelectorAll('div') || [])
        .filter((d) => {
          const cls = String(d.className || '');
          const r = d.getBoundingClientRect();
          return (
            r.width >= 300 &&
            cls.includes('max-w-') &&
            (cls.includes('rounded-[var(--radius-xl)]') || cls.includes('shadow-')) &&
            (d.textContent || '').includes('Cấu hình bước')
          );
        })
        .sort((a, b) => b.getBoundingClientRect().width - a.getBoundingClientRect().width)[0] || null;
      const rect = dialogBox ? dialogBox.getBoundingClientRect() : { width: 0, height: 0 };
      const scrollBody = Array.from(dialogBox?.querySelectorAll('div') || []).find((d) =>
        String(d.className || '').includes('overflow-y-auto')
      );
      return {
        dialogWidth: Math.round(rect.width),
        dialogClass: dialogBox ? String(dialogBox.className || '') : '',
        hasZnsContent: /zns|zalo|oa|template|mẫu tin/i.test(txt),
        bodyScrollWidth: scrollBody ? scrollBody.scrollWidth : 0,
        bodyClientWidth: scrollBody ? scrollBody.clientWidth : 0,
      };
    });

    const ok =
      clickedNode &&
      znsModalAudit.dialogWidth >= 600 &&
      znsModalAudit.hasZnsContent &&
      znsModalAudit.bodyScrollWidth <= znsModalAudit.bodyClientWidth + 2;

    stateEvidence.r3Contract = {
      ok,
      actual: { clickedNode, ...znsModalAudit },
      detail: ok
        ? `Zalo ZNS StepEditor 2xl verified (${znsModalAudit.dialogWidth}px)`
        : `Zalo ZNS StepEditor contract failed (clicked=${clickedNode}, width=${znsModalAudit.dialogWidth}px)`,
    };

    postCaptureCleanup = async () => {
      await page.keyboard.press('Escape').catch(() => {});
      await sleep(250);
    };
  } else if (item.state === 'zalo-oa-zns-tabs') {
    await navigateRoute(page, baseUrl, item.route, config.timeoutMs);
    await waitForMainRouteReady(page, '/marketing/social-bot', config.timeoutMs);

    const clickedZalo = await clickButtonByText(page, 'Zalo OA & ZNS');
    await sleep(300);

    const subTabResults = [];
    for (const label of ['Khách hàng Zalo', 'Kịch bản Zalo', 'Broadcast & ZBS', 'Mẫu tin ZNS']) {
      const clicked = await clickButtonByText(page, label);
      await sleep(400);
      const check = await page.evaluate(() => {
        const txt = (document.querySelector('main')?.innerText || '').trim();
        return {
          len: txt.length,
          hasError:
            txt.includes('Đã xảy ra lỗi') ||
            txt.includes('Đã xảy ra sự cố') ||
            txt.includes('Không có quyền truy cập'),
        };
      });
      subTabResults.push({ label, clicked, ...check });
    }

    const allSubTabsOk = subTabResults.every((r) => r.clicked && !r.hasError && r.len > 100);
    const ok = (clickedZalo || allSubTabsOk) && allSubTabsOk;
    stateEvidence.r3Contract = {
      ok,
      actual: { clickedZalo, subTabResults },
      detail: ok
        ? 'All 4 Zalo OA & ZNS sub-tabs rendered cleanly without errors'
        : 'One or more Zalo OA & ZNS sub-tabs failed',
    };
  } else if (item.state === 'drawer-campaign-detail') {
    await navigateSpaOrDirect(page, baseUrl, '/marketing/campaigns', config.timeoutMs);
    await waitForMainRouteReady(page, '/marketing/campaigns', config.timeoutMs);

    const campNeedle = fixtures?.campaignName || 'Campaign';
    await page
      .waitForFunction(
        (needle) => {
          const scope = Array.from(document.querySelectorAll('main .mkt-scope')).find((el) => {
            const cs = window.getComputedStyle(el);
            return el.style?.display !== 'contents' && cs.display !== 'none' && cs.visibility !== 'hidden';
          });
          if (!scope) return false;
          const txt = scope.innerText || '';
          return txt.includes(needle) || scope.querySelectorAll('tbody tr').length > 0;
        },
        { timeout: 12_000 },
        campNeedle
      )
      .catch(() => {});
    await sleep(300);

    const clicked = await page.evaluate((needle) => {
      const scope =
        Array.from(document.querySelectorAll('main .mkt-scope')).find((el) => {
          const cs = window.getComputedStyle(el);
          return el.style?.display !== 'contents' && cs.display !== 'none' && cs.visibility !== 'hidden';
        }) || document.querySelector('main');
      if (!scope) return false;
      const isVis = (el) => {
        const cs = window.getComputedStyle(el);
        const r = el.getBoundingClientRect();
        return cs.display !== 'none' && cs.visibility !== 'hidden' && r.width > 0 && r.height > 0;
      };
      const tableRows = Array.from(scope.querySelectorAll('tbody tr')).filter(isVis);
      const cardRows = Array.from(scope.querySelectorAll('div.cursor-pointer')).filter((el) => {
        if (!isVis(el)) return false;
        const txt = (el.textContent || '').trim();
        return !txt.includes('Hạn mức gửi') && !el.closest('thead');
      });
      const candidates = [...tableRows, ...cardRows];
      const row =
        candidates.find((r) => (r.textContent || '').includes(needle)) ||
        tableRows[0] ||
        cardRows.find((r) => (r.textContent || '').trim().length > 15);
      if (!row) return false;
      row.scrollIntoView({ block: 'center' });
      row.click();
      return true;
    }, campNeedle);

    if (clicked) {
      await page.waitForSelector('.campaign-detail-drawer', { timeout: 10_000 }).catch(() => {});
      await sleep(350);
    }

    const drawerMetrics = await page.evaluate(() => {
      const drawer = document.querySelector('.campaign-detail-drawer');
      const lower = (drawer?.innerText || '').toLowerCase();
      return {
        exists: Boolean(drawer),
        hasOpenRate: lower.includes('tỷ lệ mở') || lower.includes('tỷ lệ xem') || lower.includes('open rate'),
        hasClickRate: lower.includes('tỷ lệ click') || lower.includes('ctr'),
        hasFunnel: lower.includes('phễu chuyển đổi') || lower.includes('funnel'),
      };
    });

    const ok = drawerMetrics.exists && drawerMetrics.hasOpenRate && drawerMetrics.hasClickRate && drawerMetrics.hasFunnel;
    stateEvidence.r3Contract = {
      ok,
      actual: drawerMetrics,
      detail: ok
        ? 'CampaignDetailDrawer rendered Open Rate, CTR & Funnel metrics'
        : 'CampaignDetailDrawer missing or incomplete metrics',
    };

    postCaptureCleanup = async () => {
      await page.keyboard.press('Escape').catch(() => {});
      await sleep(250);
    };
  } else if (item.state === 'tab-flow-analytics') {
    await openSeededFlowInBuilder(page, baseUrl, fixtures, config.timeoutMs, {
      ensureDesignTab: false,
      preferAnalyticsFlow: true,
    });
    const clickAnalyticsTab = async () =>
      (await clickButtonByText(page, 'Báo cáo', { exact: true, rootSelector: '#mkt-portal-root' })) ||
      (await clickButtonByText(page, 'Báo cáo', { rootSelector: '#mkt-portal-root' })) ||
      (await clickButtonByText(page, 'Báo cáo'));
    let clickedReport = await clickAnalyticsTab();
    const waitAnalyticsRendered = async (ms) =>
      page
        .waitForFunction(
          () => {
            const portal = document.getElementById('mkt-portal-root');
            const txt = portal?.innerText || document.body.innerText || '';
            const hasPulse = Boolean(portal?.querySelector('.animate-pulse'));
            return !hasPulse && txt.includes('Hiệu suất vận hành') && txt.includes('Hành trình Khách hàng');
          },
          { timeout: ms }
        )
        .then(() => true)
        .catch(() => false);
    if (clickedReport) {
      let rendered = await waitAnalyticsRendered(6_000);
      if (!rendered) {
        clickedReport = (await clickAnalyticsTab()) || clickedReport;
        await waitAnalyticsRendered(8_000);
      }
      await sleep(500);
    }
    const analyticsCheck = await page.evaluate(() => {
      const txt = document.getElementById('mkt-portal-root')?.innerText || document.body.innerText || '';
      return {
        hasPerfHeading: txt.includes('Hiệu suất vận hành'),
        hasJourneyHeading: txt.includes('Hành trình Khách hàng'),
        nonZeroMetricNums: (txt.match(/\b[1-9]\d*\b/g) || []).length,
      };
    });
    const ok = clickedReport && analyticsCheck.hasPerfHeading && analyticsCheck.hasJourneyHeading;
    stateEvidence.r3Contract = {
      ok,
      actual: { clickedReport, ...analyticsCheck },
      detail: ok
        ? 'FlowAnalyticsTab rendered Hiệu suất vận hành & Hành trình Khách hàng'
        : 'FlowAnalyticsTab failed to render expected sections',
    };
  } else if (item.state === 'modal-step-participants') {
    await openSeededFlowInBuilder(page, baseUrl, fixtures, config.timeoutMs, { ensureDesignTab: false });
    await (
      (await clickButtonByText(page, 'Báo cáo', { exact: true, rootSelector: '#mkt-portal-root' })) ||
      (await clickButtonByText(page, 'Báo cáo', { rootSelector: '#mkt-portal-root' })) ||
      (await clickButtonByText(page, 'Báo cáo'))
    );
    await page
      .waitForFunction(
        () => (document.getElementById('mkt-portal-root')?.innerText || document.body.innerText || '').includes('Hiệu suất vận hành'),
        { timeout: 10_000 }
      )
      .catch(() => {});
    await sleep(300);

    const clickedStepMetric = await page.evaluate(() => {
      const processedPill = document.querySelector('[title="Đã đi qua (Processed)"] > div');
      if (processedPill) {
        processedPill.scrollIntoView({ block: 'center' });
        processedPill.click();
        return true;
      }
      const stepCard = Array.from(document.querySelectorAll('div.cursor-pointer')).find((d) =>
        /gửi email|khi điền form|zalo zns/i.test(d.textContent || '')
      );
      if (stepCard) {
        stepCard.scrollIntoView({ block: 'center' });
        stepCard.click();
        return true;
      }
      return false;
    });

    if (clickedStepMetric) {
      await page
        .waitForFunction(
          () => {
            const txt = (document.getElementById('mkt-portal-root')?.innerText || '').trim();
            return txt.includes('Danh sách tại:') || txt.includes('Danh sách Hoàn thành');
          },
          { timeout: 8_000 }
        )
        .catch(() => {});
      await sleep(350);
    }

    const modalCheck = await page.evaluate(() => {
      const portal = document.getElementById('mkt-portal-root');
      const txt = (portal?.innerText || '').trim();
      return {
        portalTextLen: txt.length,
        hasModalTitle: txt.includes('Danh sách tại:') || txt.includes('Danh sách Hoàn thành'),
        hasTabs: /tất cả|đang chờ|đã mở|lỗi|click|zns/i.test(txt),
      };
    });

    const ok = clickedStepMetric && modalCheck.hasModalTitle && modalCheck.hasTabs && modalCheck.portalTextLen > 40;
    stateEvidence.r3Contract = {
      ok,
      actual: { clickedStepMetric, ...modalCheck },
      detail: ok
        ? `StepParticipantsModal opened cleanly (${modalCheck.portalTextLen} chars)`
        : `StepParticipantsModal did not open (clicked=${clickedStepMetric}, hasTitle=${modalCheck.hasModalTitle}, hasTabs=${modalCheck.hasTabs})`,
    };

    postCaptureCleanup = async () => {
      await page.keyboard.press('Escape').catch(() => {});
      await sleep(250);
    };
  } else if (item.state === 'modal-survey-report') {
    await navigateSpaOrDirect(page, baseUrl, '/marketing/surveys', config.timeoutMs);
    await waitForMainRouteReady(page, '/marketing/surveys', config.timeoutMs);

    // Wait for async surveys fetch to finish rendering at least one visible "Xem báo cáo" button
    await page
      .waitForFunction(
        () => {
          const scope =
            Array.from(document.querySelectorAll('main .mkt-scope')).find((el) => {
              const cs = window.getComputedStyle(el);
              return el.style?.display !== 'contents' && cs.display !== 'none' && cs.visibility !== 'hidden';
            }) || document.querySelector('main');
          if (!scope) return false;
          return Array.from(scope.querySelectorAll('button')).some((b) => {
            const cs = window.getComputedStyle(b);
            const r = b.getBoundingClientRect();
            if (cs.display === 'none' || cs.visibility === 'hidden' || r.width <= 0 || r.height <= 0) return false;
            return /xem báo cáo|báo cáo/i.test(`${b.textContent || ''} ${b.getAttribute('title') || ''}`);
          });
        },
        { timeout: 12_000 }
      )
      .catch(() => {});
    await sleep(300);

    const clickedReport = await page.evaluate((targetTitle) => {
      const scope =
        Array.from(document.querySelectorAll('main .mkt-scope')).find((el) => {
          const cs = window.getComputedStyle(el);
          return el.style?.display !== 'contents' && cs.display !== 'none' && cs.visibility !== 'hidden';
        }) || document.querySelector('main');
      if (!scope) return false;
      const isVis = (el) => {
        const cs = window.getComputedStyle(el);
        const r = el.getBoundingClientRect();
        return cs.display !== 'none' && cs.visibility !== 'hidden' && r.width > 0 && r.height > 0;
      };
      const visibleBtns = Array.from(scope.querySelectorAll('button')).filter(isVis);
      const reportBtns = visibleBtns.filter((b) =>
        b.getAttribute('title') === 'Xem báo cáo' ||
        /xem báo cáo|báo cáo/i.test(`${b.textContent || ''} ${b.getAttribute('title') || ''}`)
      );
      const isReportBtn = (el) => reportBtns.includes(el);
      const findCardContainer = (btn) => {
        const tr = btn.closest('tr');
        if (tr) return tr;
        let cur = btn.parentElement;
        let best = btn.parentElement;
        for (let depth = 0; depth < 6 && cur && cur !== scope; depth++) {
          const innerReportBtns = Array.from(cur.querySelectorAll('button')).filter(isReportBtn);
          if (innerReportBtns.length === 1) {
            best = cur;
            cur = cur.parentElement;
          } else {
            break;
          }
        }
        return best;
      };

      const normalizedTarget = String(targetTitle || '').trim().toLowerCase();
      let btn = null;
      if (normalizedTarget) {
        btn =
          reportBtns.find((b) => {
            const cardText = (findCardContainer(b)?.textContent || '').toLowerCase();
            return cardText.includes(normalizedTarget);
          }) || null;
      }
      if (!btn) {
        btn =
          reportBtns.find((b) => {
            const cardText = findCardContainer(b)?.textContent || '';
            return /[1-9]\d*\s*(?:phản hồi|lượt trả lời)/i.test(cardText);
          }) || null;
      }
      if (!btn) {
        btn =
          visibleBtns.find((b) => b.getAttribute('title') === 'Xem báo cáo') ||
          visibleBtns.find((b) => /xem báo cáo/i.test(b.textContent || '')) ||
          visibleBtns.find((b) => /báo cáo/i.test(`${b.textContent || ''} ${b.getAttribute('title') || ''}`));
      }
      if (!btn) return false;
      btn.scrollIntoView({ block: 'center' });
      btn.click();
      return true;
    }, fixtures?.surveyTitle || '');

    if (clickedReport) {
      await page
        .waitForFunction(
          () => {
            const portal = document.getElementById('mkt-portal-root');
            const txt = (portal?.innerText || '').trim();
            const hasPulse = Boolean(portal?.querySelector('.animate-pulse'));
            return txt.length > 40 && !hasPulse;
          },
          { timeout: 10_000 }
        )
        .catch(() => {});
      await page
        .waitForFunction(
          () => Boolean(document.getElementById('mkt-portal-root')?.querySelector('.recharts-surface')),
          { timeout: 3_000 }
        )
        .catch(() => {});
      await sleep(700);
    }

    const reportCheck = await page.evaluate(() => {
      const portal = document.getElementById('mkt-portal-root');
      const txt = (portal?.innerText || '').trim();
      return {
        portalTextLen: txt.length,
        hasAnalytics: /phản hồi|báo cáo|tổng quan|câu hỏi/i.test(txt),
        noRawObjectText: !txt.includes('[object Object]'),
      };
    });

    const ok = clickedReport && reportCheck.portalTextLen > 40 && reportCheck.hasAnalytics && reportCheck.noRawObjectText;
    stateEvidence.r3Contract = {
      ok,
      actual: { clickedReport, ...reportCheck },
      detail: ok
        ? `SurveyReportModal rendered cleanly (${reportCheck.portalTextLen} chars, zero [object Object])`
        : `SurveyReportModal did not open or failed contract (clicked=${clickedReport}, len=${reportCheck.portalTextLen}, hasAnalytics=${reportCheck.hasAnalytics}, noRawObjectText=${reportCheck.noRawObjectText})`,
    };

    postCaptureCleanup = async () => {
      await page.keyboard.press('Escape').catch(() => {});
      await sleep(250);
    };
  } else if (item.state === 'tour-dom-meta') {
    await navigateSpaOrDirect(page, baseUrl, '/meta-report', config.timeoutMs);
    await waitForMainRouteReady(page, '/meta-report', config.timeoutMs);

    const trigger = await page.waitForSelector('button[data-testid="open-dom-meta-tour"]', { timeout: 10_000 }).catch(() => null);
    let tourState = { opened: false };
    if (trigger) {
      await trigger.click();
      await page.waitForSelector('div[role="dialog"][aria-modal="true"]', { timeout: 8_000 }).catch(() => {});
      await sleep(300);

      const step1 = await page.evaluate(() => {
        const dialog = document.querySelector('div[role="dialog"][aria-modal="true"]');
        const txt = dialog?.innerText || '';
        return {
          hasDialog: Boolean(dialog),
          hasStep1: txt.includes('BƯỚC 1 / 5'),
          hasMask: Boolean(document.querySelector('svg mask')),
          hasNext: txt.includes('Tiếp theo'),
          hasSkip: txt.includes('Bỏ qua tour'),
        };
      });

      const steppedNext = await clickButtonByText(page, 'Tiếp theo', {
        rootSelector: 'div[role="dialog"][aria-modal="true"]',
      });
      await sleep(200);
      const reachedStep2 = await page.evaluate(() =>
        (document.querySelector('div[role="dialog"][aria-modal="true"]')?.innerText || '').includes('BƯỚC 2 / 5')
      );
      const steppedBack = await clickButtonByText(page, 'Quay lại', {
        rootSelector: 'div[role="dialog"][aria-modal="true"]',
      });
      await sleep(250);

      tourState = { opened: true, ...step1, steppedNext, reachedStep2, steppedBack };
    }

    const ok =
      tourState.opened &&
      tourState.hasDialog &&
      tourState.hasStep1 &&
      tourState.hasMask &&
      tourState.hasNext &&
      tourState.hasSkip &&
      tourState.reachedStep2 &&
      tourState.steppedBack;

    stateEvidence.r3Contract = {
      ok,
      actual: tourState,
      detail: ok
        ? 'DomMetaSpotlightTour verified (BƯỚC 1/5 -> 2/5 -> Back, SVG mask, Next/Skip present)'
        : 'DomMetaSpotlightTour trigger, mask, or step controls failed',
    };

    postCaptureCleanup = async () => {
      await clickButtonByText(page, 'Bỏ qua tour', {
        rootSelector: 'div[role="dialog"][aria-modal="true"]',
      }).catch(() => {});
      await sleep(200);
    };
  } else if (item.state === 'tour-marketing') {
    await navigateSpaOrDirect(page, baseUrl, '/marketing', config.timeoutMs);
    await waitForMainRouteReady(page, '/marketing', config.timeoutMs);

    const triggered = await page.evaluate(() => {
      const scope = Array.from(document.querySelectorAll('main .mkt-scope')).find(
        (el) =>
          el.style?.display !== 'contents' &&
          !(
            Boolean(el.querySelector('[data-testid*="date-picker"], [data-testid*="date-range-filter"]')) &&
            el.querySelectorAll('button, a, input, select, textarea').length <= 1
          ) &&
          window.getComputedStyle(el).visibility !== 'hidden'
      );
      if (!scope) return false;
      const byTestId = Array.from(scope.querySelectorAll('[data-testid="open-mkt-tour"]')).find((el) => {
        const cs = window.getComputedStyle(el);
        const r = el.getBoundingClientRect();
        return cs.display !== 'none' && cs.visibility !== 'hidden' && r.width > 0 && r.height > 0;
      });
      if (byTestId) {
        byTestId.click();
        return true;
      }
      const byLabel = Array.from(scope.querySelectorAll('button')).find((b) => {
        if (!(b.textContent || '').includes('Tour Hướng Dẫn')) return false;
        const cs = window.getComputedStyle(b);
        const r = b.getBoundingClientRect();
        return cs.display !== 'none' && cs.visibility !== 'hidden' && r.width > 0 && r.height > 0;
      });
      if (byLabel) {
        byLabel.click();
        return true;
      }
      return false;
    });

    if (triggered) {
      await page.waitForSelector('div[role="dialog"][aria-modal="true"]', { timeout: 6_000 }).catch(() => {});
      await sleep(300);
    }

    const mktTour = await page.evaluate(() => {
      const dialog = document.querySelector('div[role="dialog"][aria-modal="true"]');
      const txt = (dialog?.innerText || '').toLowerCase();
      const targets = document.querySelectorAll('main .mkt-scope [data-tour]').length;
      return {
        hasDialog: Boolean(dialog),
        hasMask: Boolean(document.querySelector('svg mask')),
        tourTargetsCount: targets,
        hasNext: txt.includes('tiếp theo') || txt.includes('bước tiếp'),
        hasSkip: txt.includes('bỏ qua') || txt.includes('đóng'),
        step1Text: dialog?.innerText || '',
      };
    });

    let steppedNext = false;
    let steppedBack = false;
    if (triggered && mktTour.hasDialog && mktTour.hasNext) {
      steppedNext =
        (await clickButtonByText(page, 'Tiếp theo', { rootSelector: 'div[role="dialog"][aria-modal="true"]' })) ||
        (await clickButtonByText(page, 'Bước tiếp', { rootSelector: 'div[role="dialog"][aria-modal="true"]' }));
      await sleep(250);
      steppedBack = await clickButtonByText(page, 'Quay lại', {
        rootSelector: 'div[role="dialog"][aria-modal="true"]',
      });
      await sleep(250);
    }

    const ok =
      triggered &&
      mktTour.hasDialog &&
      mktTour.hasMask &&
      mktTour.tourTargetsCount >= 1 &&
      mktTour.hasNext &&
      mktTour.hasSkip &&
      steppedNext &&
      steppedBack;
    stateEvidence.r3Contract = {
      ok,
      actual: { triggered, ...mktTour, steppedNext, steppedBack },
      detail: ok
        ? `MarketingSpotlightTour verified (${mktTour.tourTargetsCount} [data-tour] targets, SVG mask, Next/Back/Skip)`
        : 'MarketingSpotlightTour trigger, mask, or step controls missing',
    };

    postCaptureCleanup = async () => {
      await clickButtonByText(page, 'Bỏ qua', { rootSelector: 'div[role="dialog"][aria-modal="true"]' }).catch(() => {});
      await clickButtonByText(page, 'Đóng', { rootSelector: 'div[role="dialog"][aria-modal="true"]' }).catch(() => {});
      await page.keyboard.press('Escape').catch(() => {});
      await sleep(200);
    };
  } else if (item.state === 'tour-erp') {
    await navigateRoute(page, baseUrl, '/settings', config.timeoutMs);
    await waitForMainRouteReady(page, '/settings', config.timeoutMs);
    await page
      .waitForFunction(
        () => {
          const main = document.querySelector('main');
          if (!main) return false;
          return Array.from(main.querySelectorAll('button')).some((b) => {
            const txt = (b.textContent || '').replace(/\s+/g, ' ').trim();
            if (!txt.includes('Tour Hướng Dẫn')) return false;
            const cs = window.getComputedStyle(b);
            const r = b.getBoundingClientRect();
            return cs.display !== 'none' && cs.visibility !== 'hidden' && r.width > 0 && r.height > 0;
          });
        },
        { timeout: 12_000 }
      )
      .catch(() => {});
    await sleep(250);

    const triggered = await clickButtonByText(page, 'Tour Hướng Dẫn', { rootSelector: 'main' });
    if (triggered) {
      await page.waitForSelector('div[role="dialog"][aria-modal="true"]', { timeout: 8_000 }).catch(() => {});
      await sleep(300);
    }

    const erpTour = await page.evaluate(() => {
      const dialog = document.querySelector('div[role="dialog"][aria-modal="true"]');
      const txt = (dialog?.innerText || '').toLowerCase();
      return {
        hasDialog: Boolean(dialog),
        hasNext: txt.includes('tiếp theo') || txt.includes('bước tiếp') || txt.includes('hoàn tất'),
        hasSkip: txt.includes('bỏ qua') || txt.includes('đóng'),
      };
    });

    const ok = triggered && erpTour.hasDialog;
    stateEvidence.r3Contract = {
      ok,
      actual: { triggered, ...erpTour },
      detail: ok ? 'ErpSpotlightTour opened cleanly on /settings' : 'ErpSpotlightTour did not open on /settings',
    };

    postCaptureCleanup = async () => {
      await page.keyboard.press('Escape').catch(() => {});
      await clickButtonByText(page, 'Bỏ qua', { rootSelector: 'div[role="dialog"][aria-modal="true"]' }).catch(() => {});
      await sleep(200);
    };
  } else if (item.state === 'mobile-quick-nav') {
    await navigateRoute(page, baseUrl, item.route, config.timeoutMs);
    await waitForMainRouteReady(page, item.route, config.timeoutMs);
    await sleep(300);

    const hasBottomNav = Boolean(await page.waitForSelector('.mobile-bottom-nav', { timeout: 8_000 }).catch(() => null));
    const menuBtn = await page.waitForSelector('button.mobile-menu-btn', { timeout: 8_000 }).catch(() => null);
    let drawerOpened = false;
    if (menuBtn) {
      await menuBtn.click();
      await page
        .waitForFunction(
          () => (document.body.textContent || '').includes('Menu điều hướng nhanh'),
          { timeout: 6_000 }
        )
        .catch(() => {});
      await sleep(300);
      drawerOpened = await page.evaluate(() => (document.body.textContent || '').includes('Menu điều hướng nhanh'));
    }

    const overflowCheck = await page.evaluate(() => ({
      scrollWidth: document.documentElement.scrollWidth,
      innerWidth: window.innerWidth,
    }));

    const baseOk =
      hasBottomNav &&
      Boolean(menuBtn) &&
      drawerOpened &&
      overflowCheck.scrollWidth <= overflowCheck.innerWidth + 2;

    stateEvidence.r3Contract = {
      ok: baseOk,
      actual: { hasBottomNav, hasMenuBtn: Boolean(menuBtn), drawerOpened, closedOnEscape: null, ...overflowCheck },
      detail: baseOk
        ? 'Mobile bottom nav & quick-nav drawer opened within 390px without overflow'
        : 'Mobile bottom nav / quick-nav drawer check failed',
    };

    // After screenshot of the open mobile drawer, press Escape and verify it closes cleanly (per spec E08)
    postScreenshotVerify = async () => {
      await page.keyboard.press('Escape').catch(() => {});
      const closedOnEscape = await page
        .waitForFunction(
          () => !((document.body.textContent || '').includes('Menu điều hướng nhanh')),
          { timeout: 4_000 }
        )
        .then(() => true)
        .catch(() => false);
      await sleep(200);
      const finalOk = baseOk && closedOnEscape;
      stateEvidence.r3Contract = {
        ok: finalOk,
        actual: { hasBottomNav, hasMenuBtn: Boolean(menuBtn), drawerOpened, closedOnEscape, ...overflowCheck },
        detail: finalOk
          ? 'Mobile bottom nav & quick-nav drawer opened within 390px without overflow and closed cleanly on Escape'
          : `Mobile bottom nav / quick-nav drawer check failed (opened=${drawerOpened}, closedOnEscape=${closedOnEscape})`,
      };
    };
  } else {
    // Standard route navigation (Group A, B02, B04, Group C lists, E01-E07)
    if (item.effectiveMode === 'landing' || item.deviceClass === 'mobile') {
      await navigateRoute(page, baseUrl, item.route, config.timeoutMs);
    } else {
      await navigateSpaOrDirect(page, baseUrl, item.route, config.timeoutMs);
    }
    await waitForMainRouteReady(page, item.route, config.timeoutMs);

    // Extra settle wait for Recharts on /meta-report
    if (item.route.includes('meta-report')) {
      await sleep(500);
    }

    // On mobile /data (E01), DataList.tsx collapses the filter bar behind button.mobile-only[title*="bộ lọc"];
    // toggle it open so DomUnifiedDatePicker is visible and verified to fit cleanly inside 390px.
    if (item.deviceClass === 'mobile' && item.route === '/data') {
      const toggledFilters = await page.evaluate(() => {
        const picker = document.querySelector('[data-testid="erp-datalist-date-picker"]');
        if (picker) {
          const cs = window.getComputedStyle(picker);
          const r = picker.getBoundingClientRect();
          if (cs.display !== 'none' && cs.visibility !== 'hidden' && r.width > 0 && r.height > 0) {
            return false;
          }
        }
        const btn =
          document.querySelector('main button.mobile-only[title*="bộ lọc"]') ||
          document.querySelector('main button[title*="Hiện bộ lọc"]') ||
          Array.from(document.querySelectorAll('main button.mobile-only')).find((b) =>
            Boolean(b.querySelector('svg'))
          );
        if (!btn) return false;
        btn.click();
        return true;
      });
      if (toggledFilters) {
        await sleep(300);
      }
    }

    // Exercise date range popover cleanly before screenshot if flagged
    if (item.exerciseDatePopover) {
      const clickedPicker = await page.evaluate(() => {
        const activeMktScope = Array.from(document.querySelectorAll('main .mkt-scope')).find(
          (el) =>
            el.style?.display !== 'contents' &&
            !(
              Boolean(el.querySelector('[data-testid*="date-picker"], [data-testid*="date-range-filter"]')) &&
              el.querySelectorAll('button, a, input, select, textarea').length <= 1
            ) &&
            window.getComputedStyle(el).visibility !== 'hidden' &&
            window.getComputedStyle(el).display !== 'none'
        );
        const searchRoot = activeMktScope || document.querySelector('main') || document;
        const btn = Array.from(
          searchRoot.querySelectorAll(
            '[data-testid="erp-datalist-date-picker"], [data-testid="mkt-dashboard-date-picker"], [data-testid="mkt-date-range-filter"], [data-testid="open-date-picker"]'
          )
        ).find((el) => {
          const cs = window.getComputedStyle(el);
          const r = el.getBoundingClientRect();
          return cs.display !== 'none' && cs.visibility !== 'hidden' && Number(cs.opacity) !== 0 && r.width > 0 && r.height > 0;
        });
        if (!btn) return false;
        btn.scrollIntoView({ block: 'center' });
        btn.click();
        return true;
      });
      if (clickedPicker) {
        const popover = await page
          .waitForSelector('[data-testid="unified-date-picker-popover"]', { timeout: 4_000 })
          .catch(() => null);
        stateEvidence.datePopoverOpened = Boolean(popover);
        await page.keyboard.press('Escape').catch(() => {});
        await sleep(200);
      } else {
        stateEvidence.datePopoverOpened = false;
      }
    }
  }

  // Capture PNG
  fs.mkdirSync(path.dirname(item.absScreenshotPath), { recursive: true });
  await page.screenshot({
    path: item.absScreenshotPath,
    fullPage: config.fullPage,
  });

  // Optional post-screenshot verification (e.g., E08 verifying Escape dismisses mobile quick-nav drawer)
  if (postScreenshotVerify) {
    await postScreenshotVerify();
  }

  // Evaluate all 12 checks against the captured DOM state
  const diagnostics = diag.snapshot();
  const checks = await evaluateAllChecks(page, item, {
    diagnostics,
    stateEvidence,
    erpBaseUrl,
    cache,
  });

  if (postCaptureCleanup) {
    await postCaptureCleanup();
  }

  return { checks, diagnostics, url: page.url() };
}

// ============================================================================
// Report Writers: audit-report.json & summary.md
// ============================================================================

function computeSummaryStats(captures, totalPlanned) {
  const checksById = {};
  for (const id of ALL_CHECK_IDS) {
    checksById[id] = {
      category: AUDIT_CHECK_META[id].category,
      passed: 0,
      failed: 0,
      skipped: 0,
    };
  }

  let passed = 0;
  let failed = 0;
  let skipped = 0;
  let captureErrors = 0;
  let totalCaptured = 0;

  for (const cap of captures) {
    if (cap.error) {
      captureErrors++;
    } else {
      totalCaptured++;
    }
    for (const chk of cap.checks || []) {
      if (chk.status === 'pass') {
        passed++;
        if (checksById[chk.id]) checksById[chk.id].passed++;
      } else if (chk.status === 'fail') {
        failed++;
        if (checksById[chk.id]) checksById[chk.id].failed++;
      } else {
        skipped++;
        if (checksById[chk.id]) checksById[chk.id].skipped++;
      }
    }
  }

  const totalChecks = passed + failed + skipped;
  const overallStatus = captureErrors === 0 && failed === 0 ? 'pass' : 'fail';

  return {
    summary: {
      totalPlanned,
      totalCaptured,
      captureErrors,
      totalChecks,
      passed,
      failed,
      skipped,
      overallStatus,
    },
    checksById,
  };
}

function buildSummaryMarkdown(report) {
  const { summary, checksById, captures, environment, config } = report;
  const lines = [];

  lines.push('# Local UI/UX Screenshot Comparison & Automated Audit Summary');
  lines.push('');
  lines.push(`- **Plan ID**: \`${report.planId}\``);
  lines.push(`- **Generated At**: \`${report.generatedAt}\` (Duration: \`${(report.durationMs / 1000).toFixed(1)}s\`)`);
  lines.push(`- **Overall Status**: **${summary.overallStatus.toUpperCase()}** (Captured: \`${summary.totalCaptured}/${summary.totalPlanned}\`, Capture Errors: \`${summary.captureErrors}\`)`);
  lines.push(`- **Audit Checks**: Pass=\`${summary.passed}\` | Fail=\`${summary.failed}\` | Skip=\`${summary.skipped}\` | Total=\`${summary.totalChecks}\``);
  lines.push(`- **Mode / Viewports**: \`${config.mode}\` / \`${config.viewports.join(', ')}\` (Strict: \`${config.strict}\`, Mock Meta: \`${config.mockMeta}\`)`);
  lines.push(`- **Browser**: \`${environment.browserExecutable}\``);
  lines.push(`- **Origins**: Backend=\`${environment.backendUrl || 'n/a'}\` | ERP=\`${environment.erpUrl || 'n/a'}\` | Landing=\`${environment.landingUrl || 'n/a'}\``);
  lines.push('');

  lines.push('## 1. Automated Audit Checks Summary (12 Checks)');
  lines.push('');
  lines.push('| Check ID | Category | Pass | Fail | Skip | Status |');
  lines.push('|---|---|---:|---:|---:|---|');
  for (const id of ALL_CHECK_IDS) {
    const c = checksById[id] || { category: '', passed: 0, failed: 0, skipped: 0 };
    const st = c.failed > 0 ? 'FAIL' : c.passed > 0 ? 'PASS' : 'SKIP';
    lines.push(`| \`${id}\` | ${c.category} | ${c.passed} | ${c.failed} | ${c.skipped} | **${st}** |`);
  }
  lines.push('');

  const byIdAndVp = new Map(captures.map((c) => [`${c.id}:${c.viewport}`, c]));
  const desktopViewports = Array.from(
    new Set(captures.filter((c) => c.group !== 'E').map((c) => c.viewport))
  );
  const mobileViewports = Array.from(
    new Set(captures.filter((c) => c.group === 'E').map((c) => c.viewport))
  );
  const desktopLabel = desktopViewports.length > 0 ? desktopViewports.join(', ') : '1440x900';
  const mobileLabel = mobileViewports.length > 0 ? mobileViewports.join(', ') : '390x844';
  const formatCell = (cap) => {
    if (!cap) return '_not run_';
    const failCount = (cap.checks || []).filter((c) => c.status === 'fail').length;
    const passCount = (cap.checks || []).filter((c) => c.status === 'pass').length;
    const badge = cap.error ? 'ERROR' : failCount > 0 ? `FAIL (${failCount})` : `PASS (${passCount})`;
    const imgMd = cap.screenshotPath && !cap.error
      ? `[![${cap.id}](${cap.screenshotPath})](${cap.screenshotPath})<br>[\`${cap.screenshotPath}\`](${cap.screenshotPath})`
      : `\`${cap.error || 'no image'}\``;
    return `**${badge}**<br>${imgMd}`;
  };

  // Group A — Reference Baselines
  const groupA = captures.filter((c) => c.group === 'A');
  if (groupA.length > 0) {
    const groupAVps = Array.from(new Set(groupA.map((c) => c.viewport)));
    lines.push(`## 2. Group A — Reference Baselines (\`${groupAVps.join(', ')}\`)`);
    lines.push('');
    lines.push('| Surface | Viewport | Landing Reference (`DOMATION_LANDINGPAGE`) | ERP Target (`DOMATION_ERP_FULL`) |');
    lines.push('|---|---|---|---|');
    for (const vp of groupAVps) {
      const a01 = byIdAndVp.get(`A01-ref-landing-data:${vp}`);
      const a02 = byIdAndVp.get(`A02-ref-erp-data:${vp}`);
      if (a01 || a02) {
        lines.push(`| **CRM Auto (\`/data\`)** | \`${vp}\` | ${formatCell(a01)} | ${formatCell(a02)} |`);
      }
      const a03 = byIdAndVp.get(`A03-ref-landing-meta-report:${vp}`);
      const a04 = byIdAndVp.get(`A04-ref-erp-meta-report:${vp}`);
      if (a03 || a04) {
        lines.push(`| **Realtime Report (\`/meta-report\`)** | \`${vp}\` | ${formatCell(a03)} | ${formatCell(a04)} |`);
      }
    }
    lines.push('');
  }

  // Group B — Shell, Splash, White Sidebar, Quick-Nav & Settings
  const groupB = captures.filter((c) => c.group === 'B');
  if (groupB.length > 0) {
    lines.push(`## 3. Group B — Shell, Loading Splash, White Sidebar, Quick-Nav & Settings (\`${desktopLabel}\`)`);
    lines.push('');
    lines.push('| Capture ID | Mode | Viewport | Route | Status & Screenshot |');
    lines.push('|---|---|---|---|---|');
    for (const cap of groupB) {
      lines.push(`| \`${cap.id}\` | \`${cap.mode}\` | \`${cap.viewport}\` | \`${cap.route}\` | ${formatCell(cap)} |`);
    }
    lines.push('');
  }

  // Group C — Dual-Mode Portal vs Standalone Paired Table
  const groupC = captures.filter((c) => c.group === 'C');
  if (groupC.length > 0) {
    const groupCVps = Array.from(new Set(groupC.map((c) => c.viewport)));
    lines.push(`## 4. Group C — Dual-Mode Marketing Pages: Portal (\`C*p\`) vs Standalone (\`C*s\`) (\`${groupCVps.join(', ')}\`)`);
    lines.push('');
    lines.push('| Pair | Viewport | Route | Portal (`domation_promax`) | Standalone (`marketing_standalone`) |');
    lines.push('|---|---|---|---|---|');
    const cPairs = [
      ['C01', '/marketing vs /', 'C01p-portal-marketing-dashboard', 'C01s-standalone-marketing-dashboard'],
      ['C02', '/marketing/flows', 'C02p-portal-flows-list', 'C02s-standalone-flows-list'],
      ['C02b', '/marketing/flows (Builder)', 'C02b-portal-flows-builder', null],
      ['C03', '/marketing/campaigns', 'C03p-portal-campaigns', 'C03s-standalone-campaigns'],
      ['C04', '/marketing/templates', 'C04p-portal-templates', 'C04s-standalone-templates'],
      ['C05', '/marketing/audience', 'C05p-portal-audience', 'C05s-standalone-audience'],
      ['C06', '/marketing/surveys', 'C06p-portal-surveys', 'C06s-standalone-surveys'],
      ['C07', '/marketing/vouchers', 'C07p-portal-vouchers', 'C07s-standalone-vouchers'],
      ['C08', '/marketing/social-bot', 'C08p-portal-social-bot', 'C08s-standalone-social-bot'],
      ['C09', '/marketing/ai-training', 'C09p-portal-ai-training', 'C09s-standalone-ai-training'],
      ['C10', '/marketing/web-tracking', 'C10p-portal-web-tracking', 'C10s-standalone-web-tracking'],
      ['C11', '/marketing/api-triggers', 'C11p-portal-api-triggers', 'C11s-standalone-api-triggers'],
      ['C12', '/marketing/capi vs /capi', 'C12p-portal-capi', 'C12s-standalone-capi'],
    ];
    for (const vp of groupCVps) {
      for (const [pairId, routeLabel, pId, sId] of cPairs) {
        const pCap = pId ? byIdAndVp.get(`${pId}:${vp}`) : null;
        const sCap = sId ? byIdAndVp.get(`${sId}:${vp}`) : null;
        if (!pCap && !sCap) continue;
        lines.push(`| **${pairId}** | \`${vp}\` | \`${routeLabel}\` | ${formatCell(pCap)} | ${sId ? formatCell(sCap) : '_covered via C02s/D01/D02_'} |`);
      }
    }
    lines.push('');
  }

  // Group D — Modals, ZNS, Drawers & Focus Tours
  const groupD = captures.filter((c) => c.group === 'D');
  if (groupD.length > 0) {
    lines.push(`## 5. Group D — Expanded Modals, ZNS UI, Measurement Drawers & Focus Tours (\`${desktopLabel}\`)`);
    lines.push('');
    lines.push('| Capture ID | Viewport | Route | State | Status & Screenshot |');
    lines.push('|---|---|---|---|---|');
    for (const cap of groupD) {
      lines.push(`| \`${cap.id}\` | \`${cap.viewport}\` | \`${cap.route}\` | \`${cap.state}\` | ${formatCell(cap)} |`);
    }
    lines.push('');
  }

  // Group E — Mobile
  const groupE = captures.filter((c) => c.group === 'E');
  if (groupE.length > 0) {
    lines.push(`## 6. Group E — Mobile Responsive Parity (\`${mobileLabel}\`)`);
    lines.push('');
    lines.push('| Capture ID | Mode | Route | Viewport | Status & Screenshot |');
    lines.push('|---|---|---|---|---|');
    for (const cap of groupE) {
      lines.push(`| \`${cap.id}\` | \`${cap.mode}\` | \`${cap.route}\` | \`${cap.viewport}\` | ${formatCell(cap)} |`);
    }
    lines.push('');
  }

  // Detailed Failed Checks Section
  const failures = [];
  for (const cap of captures) {
    if (cap.error) {
      failures.push({ captureId: cap.id, checkId: 'capture_execution', detail: cap.error });
    }
    for (const chk of cap.checks || []) {
      if (chk.status === 'fail') {
        failures.push({ captureId: cap.id, checkId: chk.id, detail: chk.detail });
      }
    }
  }

  lines.push('## 7. Automated Audit Failures & Diagnostics');
  lines.push('');
  if (failures.length === 0) {
    lines.push('Zero automated audit failures recorded across all executed captures.');
  } else {
    lines.push('| Capture ID | Check ID | Detail |');
    lines.push('|---|---|---|');
    for (const f of failures) {
      const safeDetail = String(f.detail || '').replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');
      lines.push(`| \`${f.captureId}\` | \`${f.checkId}\` | ${safeDetail} |`);
    }
  }
  lines.push('');

  return lines.join('\n');
}

// ============================================================================
// Main Orchestrator
// ============================================================================

async function runLiveCapture(config, plan, browserInfo, repoEnv) {
  const startedAt = Date.now();
  const managed = {
    backend: null,
    erpVite: null,
    landingVite: null,
    browser: null,
    openContexts: new Set(),
  };

  let teardownPromise = null;
  const teardownAll = () => {
    if (teardownPromise) return teardownPromise;
    teardownPromise = (async () => {
      const ctxList = Array.from(managed.openContexts);
      managed.openContexts.clear();
      await Promise.allSettled(ctxList.map((ctx) => ctx.close().catch(() => {})));

      if (managed.browser) {
        const proc = managed.browser.process?.();
        await Promise.race([
          managed.browser.close().catch(() => {}),
          sleep(4000),
        ]);
        if (managed.browser.connected && proc?.pid) {
          if (process.platform === 'win32') {
            await execFileAsync('taskkill', ['/pid', String(proc.pid), '/f', '/t'], {
              windowsHide: true,
            }).catch(() => {});
          } else {
            try {
              proc.kill('SIGKILL');
            } catch {
              // ignore
            }
          }
        }
        managed.browser = null;
      }

      await Promise.allSettled([
        managed.erpVite?.stop?.(),
        managed.landingVite?.stop?.(),
        managed.backend?.stop?.(),
      ]);
    })();
    return teardownPromise;
  };

  const onSignal = (sig) => {
    console.error(`\n[signal] Received ${sig}; tearing down browser and spawned child processes...`);
    teardownAll().finally(() => {
      process.exit(sig === 'SIGINT' ? 130 : 143);
    });
  };
  process.once('SIGINT', onSignal);
  process.once('SIGTERM', onSignal);

  try {
    // 1. Resolve or spawn Backend API
    let backendBaseUrl = config.backendUrl || DEFAULT_BACKEND_URL;
    let cronSecret = '';
    if (config.spawnBackend) {
      if (config.dataDir || config.seedMyerpShowcase) {
        console.log(
          `[backend] Spawning showcase AUTO_DATA_TENANRT backend (isolated PGlite at ${config.dataDir || '.autodata-pgdata-myerp-showcase'}, OUTBOUND_SILENT_MODE=true)...`
        );
      } else {
        console.log('[backend] Spawning ephemeral AUTO_DATA_TENANRT backend (in-memory PGlite + Express)...');
      }
      managed.backend = await spawnEphemeralBackend(repoEnv, Math.max(config.timeoutMs, 45_000), config);
      backendBaseUrl = managed.backend.baseUrl;
      cronSecret = managed.backend.cronSecret;
      console.log(`[backend] Ready at ${backendBaseUrl}`);
    } else if (plan.needsBackend) {
      console.log(`[backend] Using external backend at ${backendBaseUrl}`);
    }

    // 2. Resolve or spawn Frontend Vite servers (direct vite.js, zero sync-unified-shared.cjs)
    let erpBaseUrl = config.frontendUrl || DEFAULT_ERP_URL;
    if (plan.needsErp && !config.frontendUrl && config.spawnVite) {
      console.log('[vite:erp] Spawning DOMATION_ERP_FULL via node_modules/vite/bin/vite.js...');
      managed.erpVite = await spawnViteServer({
        cwd: repoEnv.erpDir,
        viteBin: repoEnv.erpViteBin,
        envOverrides: { VITE_API_ORIGIN: backendBaseUrl },
        label: 'DOMATION_ERP_FULL Vite',
        timeoutMs: config.timeoutMs,
      });
      erpBaseUrl = managed.erpVite.baseUrl;
      console.log(`[vite:erp] Ready at ${erpBaseUrl} (VITE_API_ORIGIN=${backendBaseUrl})`);
    } else if (plan.needsErp) {
      console.log(`[vite:erp] Using ERP frontend at ${erpBaseUrl}`);
    }

    let landingBaseUrl = config.landingUrl || DEFAULT_LANDING_URL;
    if (plan.needsLanding && !config.landingUrl && config.spawnVite) {
      console.log('[vite:landing] Spawning DOMATION_LANDINGPAGE via node_modules/vite/bin/vite.js...');
      managed.landingVite = await spawnViteServer({
        cwd: repoEnv.landingDir,
        viteBin: repoEnv.landingViteBin,
        envOverrides: { AUTODATA_API_URL: backendBaseUrl },
        label: 'DOMATION_LANDINGPAGE Vite',
        timeoutMs: config.timeoutMs,
      });
      landingBaseUrl = managed.landingVite.baseUrl;
      console.log(`[vite:landing] Ready at ${landingBaseUrl} (AUTODATA_API_URL=${backendBaseUrl})`);
    } else if (plan.needsLanding) {
      console.log(`[vite:landing] Using Landing frontend at ${landingBaseUrl}`);
    }

    // 3. Provision dual-mode auth & seed fixtures
    let portalAuth = null;
    let portalFixtures = null;
    let standaloneAuth = null;
    let standaloneFixtures = null;
    let zaloDemoAuth = null;
    let zaloDemoFixtures = null;

    if (plan.needsPortal) {
      if (managed.backend?.portalAuth) {
        console.log(
          `[auth] Using migrated showcase Portal tenant "${managed.backend.portalAuth.tenantSlug}" (${managed.backend.portalAuth.email})...`
        );
        portalAuth = formatShowcaseAuthForUi(managed.backend.portalAuth, 'growth_combo');
      } else {
        console.log('[auth] Provisioning Portal (domation_promax) tenant...');
        portalAuth = await provisionTenantAuth(backendBaseUrl, 'domation_promax', config);
      }
      if (config.seedFixtures) {
        portalFixtures = await seedMarketingFixtures(backendBaseUrl, portalAuth, {
          cronSecret,
          prefix: 'PortalAudit',
        });
      } else if (config.seedMyerpShowcase || config.dataDir) {
        portalFixtures = await resolveExistingMarketingFixtures(backendBaseUrl, portalAuth);
      }
    }

    if (plan.needsStandalone) {
      if (managed.backend?.standaloneAuth) {
        console.log(
          `[auth] Using showcase Standalone tenant "${managed.backend.standaloneAuth.tenantSlug}" (${managed.backend.standaloneAuth.email})...`
        );
        standaloneAuth = formatShowcaseAuthForUi(managed.backend.standaloneAuth, 'marketing_standalone');
      } else {
        console.log('[auth] Provisioning Standalone (marketing_standalone) tenant...');
        standaloneAuth = await provisionTenantAuth(backendBaseUrl, 'marketing_standalone', config);
      }
      if (config.seedFixtures) {
        standaloneFixtures = await seedMarketingFixtures(backendBaseUrl, standaloneAuth, {
          cronSecret,
          prefix: 'StandaloneAudit',
        });
      } else if (config.seedMyerpShowcase && managed.backend?.standaloneAuth) {
        standaloneFixtures = await seedMarketingFixtures(backendBaseUrl, standaloneAuth, {
          cronSecret,
          prefix: 'ShowcaseStandalone',
        });
      }
    }

    if (plan.needsZaloDemo) {
      if (managed.backend?.zaloDemoAuth) {
        console.log(
          `[auth] Using showcase Zalo ZNS tenant "${managed.backend.zaloDemoAuth.tenantSlug}" (${managed.backend.zaloDemoAuth.email})...`
        );
        zaloDemoAuth = formatShowcaseAuthForUi(managed.backend.zaloDemoAuth, 'growth_combo');
      } else {
        try {
          const loginRes = await apiRequest(backendBaseUrl, '/api/v1/auth/login', {
            method: 'POST',
            headers: { 'x-tenant-slug': 'ideas-showcase-zns' },
            body: {
              email: 'showcase-zns@domation.local',
              password: process.env.SHOWCASE_ADMIN_PASSWORD || 'Showcase2026!',
              tenant_slug: 'ideas-showcase-zns',
            },
          });
          if (loginRes.ok && loginRes.json?.data?.accessToken) {
            zaloDemoAuth = formatShowcaseAuthForUi(
              {
                ...loginRes.json.data,
                tenantSlug: 'ideas-showcase-zns',
                email: 'showcase-zns@domation.local',
              },
              'growth_combo'
            );
          }
        } catch {
          zaloDemoAuth = null;
        }
      }
      if (zaloDemoAuth) {
        zaloDemoFixtures = await resolveExistingMarketingFixtures(backendBaseUrl, zaloDemoAuth);
      }
    }

    // 4. Launch Puppeteer with explicit System Chrome/Edge executablePath
    console.log(`[browser] Launching ${browserInfo.path} (headless=${config.headless})...`);
    managed.browser = await puppeteer.launch({
      executablePath: browserInfo.path,
      headless: config.headless,
      defaultViewport: { width: 1440, height: 900, deviceScaleFactor: 1 },
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu',
        '--disable-extensions',
        '--no-first-run',
        '--no-default-browser-check',
      ],
    });

    // Ensure output root exists now that live capture is starting
    fs.mkdirSync(config.outDirAbs, { recursive: true });

    const allowPort3199 =
      backendBaseUrl.includes(':3199') || erpBaseUrl.includes(':3199') || landingBaseUrl.includes(':3199');
    const sharedCache = {};
    const captureResults = [];

    // Group items by session key: `${effectiveMode}:${viewport.label}` (except B01 which gets a dedicated context)
    const sessionBuckets = new Map();
    for (const item of plan.items) {
      if (item.state === 'splash-pre-hydration') {
        sessionBuckets.set(`splash:${item.id}`, [item]);
        continue;
      }
      const key = `${item.effectiveMode}:${item.viewport.label}`;
      if (!sessionBuckets.has(key)) sessionBuckets.set(key, []);
      sessionBuckets.get(key).push(item);
    }

    for (const [bucketKey, bucketItems] of sessionBuckets.entries()) {
      if (bucketKey.startsWith('splash:')) {
        const item = bucketItems[0];
        const t0 = Date.now();
        console.log(`[capture] ${item.id} (${item.viewport.label}) ${item.route} [splash]`);
        try {
          const out = await captureLoadingSplash(managed.browser, erpBaseUrl, portalAuth, item, config, sharedCache, {
            openContexts: managed.openContexts,
            allowPort3199,
          });
          const hasFail = out.checks.some((c) => c.status === 'fail');
          captureResults.push({
            id: item.id,
            group: item.group,
            mode: item.effectiveMode,
            route: item.route,
            state: item.state,
            viewport: item.viewport.label,
            url: out.url,
            screenshotPath: item.relScreenshotPath,
            screenshotAbsPath: item.absScreenshotPath,
            status: hasFail ? 'fail' : 'pass',
            error: null,
            durationMs: Date.now() - t0,
            checks: out.checks,
            diagnostics: out.diagnostics,
          });
        } catch (err) {
          console.error(`[capture:error] ${item.id}: ${err.message}`);
          captureResults.push({
            id: item.id,
            group: item.group,
            mode: item.effectiveMode,
            route: item.route,
            state: item.state,
            viewport: item.viewport.label,
            url: `${erpBaseUrl}${item.route}`,
            screenshotPath: item.relScreenshotPath,
            screenshotAbsPath: item.absScreenshotPath,
            status: 'fail',
            error: err.message,
            durationMs: Date.now() - t0,
            checks: ALL_CHECK_IDS.map((id) =>
              item.checks.includes(id)
                ? makeCheck(id, 'fail', null, `Capture crashed: ${err.message}`)
                : makeCheck(id, 'skip', null, 'Not applicable')
            ),
            diagnostics: null,
          });
        }
        continue;
      }

      const firstItem = bucketItems[0];
      const mode = firstItem.effectiveMode;
      if (mode === 'zalo_demo' && !zaloDemoAuth) {
        console.log('[skip] ideas-showcase-zns tenant unavailable; skipping showcase Zalo ZNS captures.');
        continue;
      }
      const vp = firstItem.viewport;
      const baseUrl = mode === 'landing' ? landingBaseUrl : erpBaseUrl;
      const auth =
        mode === 'portal'
          ? portalAuth
          : mode === 'standalone'
            ? standaloneAuth
            : mode === 'zalo_demo'
              ? zaloDemoAuth
              : null;
      const fixtures =
        mode === 'portal'
          ? portalFixtures
          : mode === 'standalone'
            ? standaloneFixtures
            : mode === 'zalo_demo'
              ? zaloDemoFixtures
              : null;

      const ctx = await managed.browser.createBrowserContext();
      managed.openContexts.add(ctx);
      const page = await ctx.newPage();

      try {
        await page.setViewport({
          width: vp.width,
          height: vp.height,
          deviceScaleFactor: 1,
          isMobile: vp.isMobile,
          hasTouch: vp.isMobile,
        });

        const diag = attachPageDiagnostics(page, { allowPort3199 });
        await installEventSourceCleanupHook(page);

        if (config.mockMeta) {
          await attachMetaMockInterceptor(page, { isLanding: mode === 'landing' });
        }

        if (mode === 'landing') {
          await page.evaluateOnNewDocument(() => {
            window.__DOM_META_PREVIEW__ = {
              authContext: {
                accessToken: 'jwt_preview_audit',
                tenantSlug: 'domation_audit',
              },
              workspaceName: 'DOMATION Audit Workspace',
              userDisplayName: 'UI Reviewer',
              userRoleLabel: 'admin',
              mode: 'standalone',
              initialView: 'dashboard',
              initialCustomRange: { since: '2026-11-01', until: '2026-11-14' },
            };
          });
        } else if (auth) {
          await seedErpAuthOnDocument(page, auth);
        }

        for (const item of bucketItems) {
          const t0 = Date.now();
          console.log(`[capture] ${item.id} (${vp.label}, ${mode}) ${item.route} [${item.state}]`);
          try {
            const out = await executeStandardOrInteractiveCapture(page, item, {
              baseUrl,
              erpBaseUrl: plan.needsErp ? erpBaseUrl : null,
              fixtures,
              config,
              diag,
              cache: sharedCache,
            });
            const hasFail = out.checks.some((c) => c.status === 'fail');
            captureResults.push({
              id: item.id,
              group: item.group,
              mode: item.effectiveMode,
              route: item.route,
              state: item.state,
              viewport: vp.label,
              url: out.url,
              screenshotPath: item.relScreenshotPath,
              screenshotAbsPath: item.absScreenshotPath,
              status: hasFail ? 'fail' : 'pass',
              error: null,
              durationMs: Date.now() - t0,
              checks: out.checks,
              diagnostics: out.diagnostics,
            });
          } catch (err) {
            console.error(`[capture:error] ${item.id}: ${err.message}`);
            captureResults.push({
              id: item.id,
              group: item.group,
              mode: item.effectiveMode,
              route: item.route,
              state: item.state,
              viewport: vp.label,
              url: `${baseUrl}${item.route}`,
              screenshotPath: item.relScreenshotPath,
              screenshotAbsPath: item.absScreenshotPath,
              status: 'fail',
              error: err.message,
              durationMs: Date.now() - t0,
              checks: ALL_CHECK_IDS.map((id) =>
                item.checks.includes(id)
                  ? makeCheck(id, 'fail', null, `Capture failed: ${err.message}`)
                  : makeCheck(id, 'skip', null, 'Not applicable')
              ),
              diagnostics: diag.snapshot(),
            });
          }
        }
      } finally {
        await closeTrackedEventSources(page);
        managed.openContexts.delete(ctx);
        await Promise.allSettled([page.close(), ctx.close()]);
      }
    }

    // Reorder results to match canonical plan order
    const orderIdx = new Map(plan.items.map((it, idx) => [`${it.id}:${it.viewport.label}`, idx]));
    captureResults.sort(
      (a, b) => (orderIdx.get(`${a.id}:${a.viewport}`) ?? 9999) - (orderIdx.get(`${b.id}:${b.viewport}`) ?? 9999)
    );

    const { summary, checksById } = computeSummaryStats(captureResults, plan.items.length);
    const report = {
      schemaVersion: '1.0.0',
      planId: 'PLAN-M4-UIUX-COMPARE-001',
      generatedAt: new Date().toISOString(),
      durationMs: Date.now() - startedAt,
      config: {
        mode: config.mode,
        outDir: config.outDir,
        viewports: config.viewports.map((v) => v.label),
        spawnBackend: config.spawnBackend,
        spawnVite: config.spawnVite,
        mockMeta: config.mockMeta,
        strict: config.strict,
        headless: config.headless,
        fullPage: config.fullPage,
        includeStates: config.includeStates,
        seedFixtures: config.seedFixtures,
        seedMyerpShowcase: config.seedMyerpShowcase,
        dataDir: config.dataDir,
        tenantSlug: config.tenantSlug,
        routesFilter: config.routesFilter,
        capturesFilter: config.capturesFilter,
      },
      environment: {
        nodeVersion: process.version,
        platform: process.platform,
        browserExecutable: browserInfo.path,
        backendUrl: plan.needsBackend || config.spawnBackend ? backendBaseUrl : null,
        erpUrl: plan.needsErp ? erpBaseUrl : null,
        landingUrl: plan.needsLanding ? landingBaseUrl : null,
        erpDir: repoEnv.erpDir,
        landingDir: repoEnv.landingDir,
      },
      summary,
      checksById,
      captures: captureResults,
    };

    const reportJsonPath = path.join(config.outDirAbs, 'audit-report.json');
    const summaryMdPath = path.join(config.outDirAbs, 'summary.md');
    fs.writeFileSync(reportJsonPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
    fs.writeFileSync(summaryMdPath, buildSummaryMarkdown(report), 'utf8');

    console.log('');
    console.log('================================================================================');
    console.log(`Capture Complete — Status: ${summary.overallStatus.toUpperCase()}`);
    console.log(
      `Captured: ${summary.totalCaptured}/${summary.totalPlanned} | Errors: ${summary.captureErrors} | Checks: pass=${summary.passed} fail=${summary.failed} skip=${summary.skipped}`
    );
    console.log(`Audit JSON : ${reportJsonPath}`);
    console.log(`Summary MD : ${summaryMdPath}`);
    console.log('================================================================================');

    if (config.strict && (summary.failed > 0 || summary.captureErrors > 0)) {
      return 1;
    }
    return 0;
  } finally {
    process.removeListener('SIGINT', onSignal);
    process.removeListener('SIGTERM', onSignal);
    await teardownAll();
  }
}

async function main() {
  const config = parseCliArgs(process.argv.slice(2));
  if (config.help) {
    printHelp();
    return 0;
  }

  const repoEnv = resolveRepoEnvironment(config);
  const plan = buildCapturePlan(config);
  const browserInfo = resolveBrowserExecutable(config.chromePath, { allowMissing: config.dryRun });

  if (config.dryRun) {
    printDryRunOutput(config, plan, browserInfo, repoEnv);
    return 0;
  }

  if (plan.items.length === 0) {
    console.warn('[warn] No captures matched the provided --mode / --viewports / --routes / --captures filters.');
    return 0;
  }

  return runLiveCapture(config, plan, browserInfo, repoEnv);
}

main()
  .then((exitCode) => {
    process.exit(exitCode);
  })
  .catch((err) => {
    console.error(`[fatal] ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  });
