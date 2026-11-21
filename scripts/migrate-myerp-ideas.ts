/**
 * MYERP -> DOMATION (`ideas`) Authoritative Full Migration CLI (Milestone M3)
 *
 * Streams MariaDB/mysqldump backups (632MB+ safe, zero full-file readFileSync)
 * into DOMATION multi-tenant PostgreSQL / embedded PGlite storage:
 * - F1: Provisions/refreshes tenant `ideas` on `growth_combo` (`industry_key='education'`, `education_addon=true`)
 * - F2: Deterministic RFC 4122 UUIDv5 IDs, strict `tenant_id=1`/`workspace_id` filtering,
 *       excludes `99999` test pollution, `_bak_*`/`*_backup_*` tables, and orphan child rows
 * - F3: Auto Data CRM (users, contacts+leads unified 360, pipeline stages, rounds, consultants,
 *       routing rules, distribution logs, compensation logs, data reports, notes, activities,
 *       tickets, tags, companies, sheet connections + field mappings)
 * - F4: Email Marketing & Suppression (subscribers, unsubscribed/bounced -> `mkt_suppression_list`,
 *       lists, list links, segments, tags, templates, template groups, email sections, global assets,
 *       campaigns, send claims with `reminder_sent=true`, delivery logs, subscriber activity,
 *       4 verified `@ideas.edu.vn` senders)
 * - F5: Automation Flows (preserving `zalo_zns` nodes as safe no-ops), snapshots, gated enrollments
 *       (`waiting` -> `paused` + `next_run_at=NULL`), forms, surveys + questions + responses,
 *       vouchers, short links + clicks, web properties + sessions + events + blacklist,
 *       AI chatbot configs + training docs (omitting binary NUL blobs) + conversations;
 *       purges/skips stale pending `mail_queue`
 * - F6: Meta Report, CAPI logs, `capi_blocked_phones` (128k+), `contact_meta_attribution`,
 *       Messenger pages, conversations, messages, customer journey, automation scenarios
 * - F7: AES-256-GCM encrypted `tenant_integrations` vault (`aws_ses`, `facebook_ads`, `meta_capi`,
 *       `meta_messenger`, `dom_meta_report`, `ai_gemini_byok`, `google_sheets`) with zero plaintext logs
 * - F8: Complete ZaloBot / Zalo OA / Zalo ZNS exclusion (13 `zalo_*` tables, 11 `zalo*` settings keys,
 *       `zalo_bot_disabled=true`, `daily_report_channels.zalo=false`, zero `zalo_*` vault rows)
 * - F10: Rewrites legacy `automation.ideas.edu.vn/uploadss/` and `myerp.ideas.edu.vn/backend/uploadss/`
 *        URLs (including JSON-escaped `\/` and PHP `img_ratio.php`/`video_thumb.php` wrappers) to
 *        `https://data.domation.net/uploadss/...` while preserving non-uploadss URLs & external links.
 *
 * Usage:
 *   npx tsx scripts/migrate-myerp-ideas.ts --sql <path> [--tenant ideas] [--data-dir <dir>] [--dry-run] [--manifest-out <path>]
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import { fileURLToPath } from 'node:url';

// Enforce strict silent mode before importing any server modules
process.env.OUTBOUND_SILENT_MODE = 'true';
process.env.TELEGRAM_NOTIFY_ENABLED = 'false';
process.env.TELEGRAM_SILENT_MODE = 'true';
process.env.MIGRATION_SILENT_MODE = 'true';

import { APP_CONFIG } from '../server/config.ts';
import { createDatabasePool, setDatabasePool, type DbClient } from '../server/core/database/db-adapter.ts';
import { runDatabaseMigrations } from '../server/core/database/migrate.ts';
import { withSystemPrivilege, withTenantTransaction } from '../server/core/database/transaction.ts';
import { encryptTenantSecret } from '../server/core/crypto/vault.ts';
import { hashPassword } from '../server/core/crypto/password.ts';
import { buildModulesForPackage } from '../server/core/security/entitlements.ts';
import { DEFAULT_TENANT_SETTINGS } from '../server/core/settings/tenant-settings.ts';
import { normalizeAdAccountId } from '../server/services/meta-ads.service.ts';
import {
  sanitizeAvatarUrl,
  stripEphemeralAvatarsFromCustomFields,
} from '../server/core/security/pii-masker.ts';

function sanitizeMigratedAvatarUrl(raw: unknown): string | null {
  const safe = sanitizeAvatarUrl(raw);
  if (!safe) return null;
  if (/^uploads\//i.test(safe)) {
    const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
    const localCandidate = path.join(repoRoot, 'public', safe);
    const uploadssCandidate = path.join(repoRoot, 'public', safe.replace(/^uploads\//i, 'uploadss/'));
    if (!fs.existsSync(localCandidate) && !fs.existsSync(uploadssCandidate)) {
      return null;
    }
  }
  return safe;
}

const AVATAR_FIELD_KEYS = ['avatar', 'avatar_url', 'profile_pic', 'picture', 'photo'] as const;

function sanitizeMigratedAvatarObject(obj: Record<string, unknown>): Record<string, unknown> {
  const cleaned = stripEphemeralAvatarsFromCustomFields(obj);
  const next: Record<string, unknown> = { ...cleaned };
  for (const key of AVATAR_FIELD_KEYS) {
    if (next[key] !== undefined && next[key] !== null) {
      const safeVal = sanitizeMigratedAvatarUrl(next[key]);
      if (!safeVal) {
        delete next[key];
      } else {
        next[key] = safeVal;
      }
    }
  }
  if (next.custom_attributes && typeof next.custom_attributes === 'object' && !Array.isArray(next.custom_attributes)) {
    next.custom_attributes = sanitizeMigratedAvatarObject(next.custom_attributes as Record<string, unknown>);
  }
  return next;
}

// ============================================================================
// Constants & Types
// ============================================================================

const IDEAS_UUID_NAMESPACE = '6ba7b810-9dad-11d1-80b4-00c04fd430c8';
const DEFAULT_SOURCE_SQL_PATH = 'D:\\GITHUB_SPACE\\MYERP\\backups\\myerp_backup_latest.sql';
const DEFAULT_PUBLIC_URL = 'https://data.domation.net';
const DEFAULT_CRM_URL = 'https://erp.domation.net';

const IN_SCOPE_TABLES = new Set<string>([
  // Core & Settings
  'tenants',
  'workspaces',
  'users',
  'system_settings',
  'mkt_system_settings',
  // Auto Data CRM
  'contacts',
  'leads',
  'pipeline_stages',
  'distribution_rounds',
  'round_consultants',
  'routing_rules',
  'distribution_logs',
  'active_compensation_logs',
  'data_reports',
  'notes',
  'comments',
  'activities',
  'tickets',
  'tags',
  'sheet_connections',
  'field_mappings',
  'sheet_sync_records',
  'integrations',
  'persons',
  'companies',
  // Email & Marketing
  'subscribers',
  'lists',
  'subscriber_lists',
  'segments',
  'domation_tags',
  'subscriber_tags',
  'templates',
  'template_groups',
  'email_sections',
  'global_assets',
  'campaigns',
  'campaign_send_claims',
  'mail_delivery_logs',
  'mail_queue',
  'subscriber_activity',
  'verified_senders',
  // Flows, Forms, Surveys, Vouchers, Short Links, Web Tracking, AI Bots
  'flows',
  'flow_snapshots',
  'subscriber_flow_states',
  'forms',
  'purchase_events',
  'surveys',
  'survey_questions',
  'survey_responses',
  'survey_answer_details',
  'voucher_campaigns',
  'voucher_codes',
  'short_links',
  'link_clicks',
  'web_properties',
  'web_visitors',
  'web_sessions',
  'web_page_views',
  'web_events',
  'web_daily_stats',
  'web_blacklist',
  'ai_chatbots',
  'ai_chatbot_settings',
  'ai_chatbot_scenarios',
  'ai_chatbot_meta_settings',
  'domation_ai_training_docs',
  'domation_ai_training_chunks',
  'domation_ai_conversations',
  'domation_ai_messages',
  // Meta Report, Messenger & CAPI
  'contact_meta_attribution',
  'capi_logs',
  'capi_blocked_phones',
  'meta_app_configs',
  'meta_subscribers',
  'meta_conversations',
  'meta_message_logs',
  'meta_customer_journey',
  'meta_automation_scenarios',
]);

const ZALO_SETTING_PREFIX = 'zalo';
const SECRET_SETTING_KEYS = new Set<string>([
  'ses_password',
  'ses_username',
  'ses_access_key',
  'ses_secret_key',
  'smtp_pass',
  'smtp_password',
  'smtp_user',
  'smtp_username',
  'aws_access_key',
  'aws_secret_key',
  'imap_pass',
  'meta_access_token',
  'meta_ads_access_token',
  'capi_access_token',
  'gemini_api_key',
  'google_api_key',
  'google_cloud_api_key',
  'groq_api_key',
  'openrouter_api_key',
  'openai_api_key',
  'zalo_bot_token',
  'zalo_webhook_secret',
  'telegram_bot_token',
]);

type SqlCell = string | number | null;
type RowObj = Record<string, SqlCell>;

export interface MigrateMyerpIdeasOptions {
  sqlPath: string;
  tenantSlug?: string;
  dataDir?: string;
  dryRun?: boolean;
  publicUrl?: string;
  crmUrl?: string;
  manifestOut?: string;
  skipWebAnalytics?: boolean;
  quiet?: boolean;
}

export interface AssetManifest {
  generated_at: string;
  source_sql: string;
  public_origin: string;
  uploadss_files: string[];
  template_thumbs_files: string[];
  ai_training_files: string[];
  counts: {
    uploadss: number;
    template_thumbs: number;
    ai_training: number;
  };
}

export interface MigrationSummary {
  success: boolean;
  dry_run: boolean;
  tenant_slug: string;
  tenant_id: string | null;
  source_sql: string;
  data_dir: string | null;
  duration_ms: number;
  dump_stats: {
    file_size_bytes: number;
    tables_defined: number;
    backup_tables_skipped: string[];
    zalo_tables_skipped: string[];
    out_of_scope_tables_skipped: number;
  };
  source_filtered_counts: Record<string, number>;
  source_excluded_counts: Record<string, number>;
  target_migrated_counts: Record<string, number>;
  safety_gates: {
    stale_mail_queue_pending_purged: number;
    mail_queue_total_skipped: number;
    waiting_flow_states_gated_to_paused: number;
    orphan_flow_snapshots_dropped: number;
    orphan_link_clicks_dropped: number;
    zalo_settings_keys_excluded: number;
    zalo_vault_integrations_present: number;
    zalo_bot_disabled: boolean;
  };
  quarantined: {
    contacts_missing_phone_and_email: number;
    leads_missing_phone_and_email: number;
    subscribers_missing_phone_and_email: number;
    orphan_distribution_logs: number;
    orphan_data_reports: number;
    orphan_send_claims: number;
    orphan_capi_logs: number;
  };
  vault_integrations: Record<string, boolean>;
  url_rewrites: {
    total_rewritten: number;
    uploadss_assets_referenced: number;
    template_thumbs_referenced: number;
    ai_training_assets_referenced: number;
  };
}

interface ParsedDumpData {
  fileSizeBytes: number;
  tablesDefined: number;
  backupTablesSkipped: string[];
  zaloTablesSkipped: string[];
  outOfScopeTablesSkipped: number;
  filteredCounts: Record<string, number>;
  excludedCounts: Record<string, number>;
  // Core & Settings
  tenants: RowObj[];
  users: RowObj[];
  systemSettings: Map<string, string>;
  zaloSettingKeysExcluded: number;
  mktSystemSettings: Map<string, { value: string; updatedAt: string; workspaceId: number }>;
  // CRM
  persons: Map<string, { phone: string | null; email: string | null; full_name: string | null }>;
  companies: RowObj[];
  contacts: RowObj[];
  excluded99999UserIds: Set<string>;
  excluded99999Emails: Set<string>;
  excluded99999Phones: Set<string>;
  leads: RowObj[];
  pipelineStages: RowObj[];
  distributionRounds: RowObj[];
  roundConsultants: RowObj[];
  routingRules: RowObj[];
  distributionLogs: Array<{
    id: string;
    lead_id: string;
    assigned_to: string | null;
    round_id: string | null;
    status: string | null;
    message: string | null;
    received_at: string | null;
  }>;
  activeCompensationLogs: RowObj[];
  dataReports: RowObj[];
  notes: RowObj[];
  comments: RowObj[];
  activities: Array<{
    id: string;
    user_id: string | null;
    created_by: string | null;
    type: string | null;
    subject: string | null;
    body: string | null;
    status: string | null;
    priority: string | null;
    due_date: string | null;
    done_at: string | null;
    related_type: string | null;
    related_id: string | null;
    contact_id: string | null;
    created_at: string | null;
    updated_at: string | null;
    deleted_at: string | null;
  }>;
  tickets: RowObj[];
  tags: RowObj[];
  sheetConnections: RowObj[];
  fieldMappings: RowObj[];
  sheetSyncCounts: Map<string, number>;
  integrations: RowObj[];
  // Email & Marketing
  subscribers: RowObj[];
  lists: RowObj[];
  subscriberLists: Array<{ subscriber_id: string; list_id: string }>;
  segments: RowObj[];
  domationTags: RowObj[];
  subscriberTags: Array<{ subscriber_id: string; tag_id: string }>;
  templates: RowObj[];
  templateGroups: RowObj[];
  emailSections: RowObj[];
  globalAssets: RowObj[];
  campaigns: RowObj[];
  campaignSendClaims: RowObj[];
  mailDeliveryLogs: Array<{
    id: string;
    recipient: string | null;
    subject: string | null;
    campaign_id: string | null;
    flow_id: string | null;
    status: string | null;
    error_message: string | null;
    sent_at: string | null;
    subscriber_id: string | null;
    created_at: string | null;
  }>;
  mailQueueTotal: number;
  mailQueuePending: number;
  subscriberActivity: Array<{
    id: string;
    contact_id: string | null;
    subscriber_id: string | null;
    type: string | null;
    action_type: string | null;
    campaign_id: string | null;
    flow_id: string | null;
    reference_name: string | null;
    target_name: string | null;
    details: string | null;
    created_at: string | null;
  }>;
  verifiedSenders: RowObj[];
  // Flows, Forms, Surveys, Vouchers, Short Links, Web Tracking, AI Bots
  flows: RowObj[];
  flowSnapshots: RowObj[];
  subscriberFlowStates: Array<{
    id: string;
    contact_id: string | null;
    subscriber_id: string | null;
    flow_id: string | null;
    step_id: string | null;
    step_type: string | null;
    status: string | null;
    scheduled_at: string | null;
    waiting_until: string | null;
    branch_taken: string | null;
    last_error: string | null;
    created_at: string | null;
    updated_at: string | null;
    last_step_at: string | null;
  }>;
  forms: RowObj[];
  purchaseEvents: RowObj[];
  surveys: RowObj[];
  surveyQuestions: RowObj[];
  surveyResponses: RowObj[];
  surveyAnswerDetails: RowObj[];
  voucherCampaigns: RowObj[];
  voucherCodes: RowObj[];
  shortLinks: RowObj[];
  linkClicks: RowObj[];
  webProperties: RowObj[];
  webSessions: Array<{
    id: string;
    visitor_id: string | null;
    property_id: string | null;
    workspace_id: number | null;
    started_at: string | null;
    last_active_at: string | null;
    entry_url: string | null;
    referrer_source: string | null;
    utm_source: string | null;
    utm_medium: string | null;
    utm_campaign: string | null;
    page_count: number;
    duration_seconds: number;
    device_type: string | null;
    browser: string | null;
    os: string | null;
    country: string | null;
    city: string | null;
    contact_id: string | null;
  }>;
  webPageViews: Array<{
    id: string;
    session_id: string | null;
    property_id: string | null;
    workspace_id: number | null;
    url: string | null;
    title: string | null;
    loaded_at: string | null;
    scroll_depth: number | null;
  }>;
  webEvents: Array<{
    id: string;
    session_id: string | null;
    page_view_id: string | null;
    property_id: string | null;
    event_type: string | null;
    target_selector: string | null;
    target_text: string | null;
    meta_data: string | null;
    created_at: string | null;
  }>;
  webBlacklist: RowObj[];
  aiChatbots: RowObj[];
  aiChatbotSettings: RowObj[];
  aiChatbotScenarios: RowObj[];
  domationAiTrainingDocs: RowObj[];
  domationAiChunkStats: Map<string, { chunks: number; tokens: number }>;
  domationAiConversations: RowObj[];
  domationAiMessages: Array<{
    id: string;
    conversation_id: string | null;
    sender: string | null;
    message: string | null;
    created_at: string | null;
  }>;
  // Meta & CAPI
  contactMetaAttribution: RowObj[];
  capiLogs: RowObj[];
  capiBlockedPhones: Array<{
    id: string;
    phone_normalized: string;
    source_label: string | null;
    reason: string | null;
    created_by: string | null;
    created_at: string | null;
  }>;
  metaAppConfigs: RowObj[];
  metaSubscribers: RowObj[];
  metaConversations: RowObj[];
  metaMessageLogs: Array<{
    id: string;
    page_id: string | null;
    psid: string | null;
    direction: string | null;
    content: string | null;
    timestamp: string | null;
    created_at: string | null;
  }>;
  metaCustomerJourney: Array<{
    id: string;
    page_id: string | null;
    psid: string | null;
    event_type: string | null;
    event_name: string | null;
    event_data: string | null;
    created_at: string | null;
  }>;
  metaAutomationScenarios: RowObj[];
}

// ============================================================================
// Pure Utilities: Deterministic UUIDv5, Normalization, URL Rewriting
// ============================================================================

export function deterministicUuid(
  tenantSlug: string,
  tableName: string,
  legacyId: string | number
): string {
  const hash = crypto
    .createHash('sha256')
    .update(`${IDEAS_UUID_NAMESPACE}:${tenantSlug}:${tableName}:${String(legacyId)}`, 'utf8')
    .digest();
  // Set RFC 4122 version 5 (0101) and variant (10xx)
  hash[6] = (hash[6] & 0x0f) | 0x50;
  hash[8] = (hash[8] & 0x3f) | 0x80;
  const hex = hash.subarray(0, 16).toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

function isIdeasTenant(val: SqlCell | undefined): boolean {
  if (val === null || val === undefined || val === '') return false;
  return Number(val) === 1;
}

function isIdeasWorkspace(val: SqlCell | undefined, allowZero = false): boolean {
  if (val === null || val === undefined || val === '') return false;
  const n = Number(val);
  return n === 1 || (allowZero && n === 0);
}

function asStr(val: SqlCell | undefined): string {
  if (val === null || val === undefined) return '';
  return String(val);
}

function asTrimmed(val: SqlCell | undefined): string {
  return asStr(val).trim();
}

function asNullableStr(val: SqlCell | undefined, maxLen?: number): string | null {
  const s = asTrimmed(val);
  if (!s) return null;
  return maxLen && s.length > maxLen ? s.slice(0, maxLen) : s;
}

function truncateStr(val: string, maxLen: number): string {
  return val.length > maxLen ? val.slice(0, maxLen) : val;
}

function toInt(val: SqlCell | undefined, fallback = 0): number {
  if (val === null || val === undefined || val === '') return fallback;
  const n = Number(val);
  if (!Number.isFinite(n)) return fallback;
  const i = Math.trunc(n);
  if (i > 2147483647) return 2147483647;
  if (i < -2147483648) return -2147483648;
  return i;
}

function toBigIntNum(val: SqlCell | undefined, fallback = 0): number {
  if (val === null || val === undefined || val === '') return fallback;
  const n = Number(val);
  if (!Number.isFinite(n)) return fallback;
  return Math.trunc(n);
}

function parseSqlTs(val: SqlCell | undefined): string | null {
  if (val === null || val === undefined) return null;
  const raw = String(val).trim();
  if (!raw || raw.startsWith('0000-00-00')) return null;
  const iso = raw.includes('T')
    ? raw
    : `${raw.replace(' ', 'T')}${/[zZ]|[+-]\d{2}:?\d{2}$/.test(raw) ? '' : 'Z'}`;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString();
}

function parseSqlTsOrNow(val: SqlCell | undefined): string {
  return parseSqlTs(val) ?? new Date().toISOString();
}

function normalizeEmail(raw: SqlCell | undefined): string | null {
  const s = asTrimmed(raw).toLowerCase();
  if (!s || !s.includes('@') || s.length > 255) return null;
  return s;
}

function normalizePhoneDisplay(raw: SqlCell | undefined): string | null {
  const s = asTrimmed(raw);
  if (!s) return null;
  const digits = s.replace(/\D/g, '');
  if (digits.length < 7) return null;
  if (digits.startsWith('84') && digits.length >= 10 && digits.length <= 15) {
    return `+${digits}`.slice(0, 30);
  }
  if (digits.startsWith('0') && (digits.length === 10 || digits.length === 11)) {
    return `+84${digits.slice(1)}`.slice(0, 30);
  }
  if (digits.length === 9 && /^[35789]/.test(digits)) {
    return `+84${digits}`.slice(0, 30);
  }
  return s.slice(0, 30);
}

function normalizePhoneKey(raw: SqlCell | undefined): string | null {
  const s = asTrimmed(raw);
  if (!s) return null;
  const digits = s.replace(/\D/g, '');
  if (digits.length < 7) return null;
  if (digits.startsWith('84') && digits.length >= 11) {
    return digits.slice(2);
  }
  if (digits.startsWith('0') && digits.length >= 10) {
    return digits.slice(1);
  }
  return digits.slice(-9);
}

function slugify(raw: string, fallback: string, maxLen = 63): string {
  const base = raw
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/đ/g, 'd')
    .replace(/Đ/g, 'D')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
  return (base || fallback).slice(0, maxLen);
}

function parseJsonSafe<T = unknown>(raw: SqlCell | undefined): T | null {
  if (raw === null || raw === undefined) return null;
  const str = String(raw).trim();
  if (!str) return null;
  try {
    return JSON.parse(str) as T;
  } catch {
    return null;
  }
}

function sha256Hex(val: string): string {
  return crypto.createHash('sha256').update(val, 'utf8').digest('hex');
}

function incCounter(map: Record<string, number>, key: string, delta = 1): void {
  map[key] = (map[key] || 0) + delta;
}

// ============================================================================
// Legacy URL Rewriter & Asset Tracker (F10)
// ============================================================================

export class LegacyUrlRewriter {
  readonly publicOrigin: string;
  readonly crmOrigin: string;
  readonly uploadssAssets = new Set<string>();
  readonly templateThumbs = new Set<string>();
  readonly aiTrainingAssets = new Set<string>();
  rewriteCount = 0;

  constructor(publicOrigin = DEFAULT_PUBLIC_URL, crmOrigin = DEFAULT_CRM_URL) {
    this.publicOrigin = publicOrigin.replace(/\/+$/, '');
    this.crmOrigin = crmOrigin.replace(/\/+$/, '');
  }

  private recordUploadssPath(relPath: string): string {
    const clean = relPath.replace(/^\/+/, '');
    const pathNoQuery = clean.split(/[?#]/)[0];
    if (pathNoQuery) this.uploadssAssets.add(pathNoQuery);
    return `${this.publicOrigin}/uploadss/${clean}`;
  }

  rewriteString(input: string, mode: 'html' | 'json_leaf' | 'url_field' = 'html'): string {
    if (!input) return input;
    let out = input;

    // Track /uploads/template_thumbs/*.webp references
    const thumbRe = /\/uploads\/template_thumbs\/([^\s"'<>?#)]+)/gi;
    let tm: RegExpExecArray | null;
    while ((tm = thumbRe.exec(out)) !== null) {
      if (tm[1]) this.templateThumbs.add(tm[1]);
    }

    // 1. Unwrap PHP img_ratio.php / video_thumb.php proxies pointing to legacy uploadss/
    const proxyRe =
      /https?:\/\/(?:automation\.ideas\.edu\.vn\/mail_api|myerp\.ideas\.edu\.vn\/backend\/automation)\/(?:img_ratio|video_thumb)\.php\?[^"'<>\s)]*?\burl=([^&"'<>\s)]+)[^"'<>\s)]*/gi;
    out = out.replace(proxyRe, (fullMatch, encodedUrl: string) => {
      try {
        const decoded = decodeURIComponent(encodedUrl);
        const innerUploadss = decoded.match(
          /^(?:https?:\/\/(?:automation\.ideas\.edu\.vn|myerp\.ideas\.edu\.vn\/backend))?\/?uploadss\/(.+)$/i
        );
        if (innerUploadss && innerUploadss[1]) {
          this.rewriteCount += 1;
          return this.recordUploadssPath(innerUploadss[1]);
        }
      } catch {
        // Leave intact if malformed encoding
      }
      return fullMatch;
    });

    // 2. Rewrite direct legacy automation.ideas.edu.vn/uploadss/* and myerp.ideas.edu.vn/backend/uploadss/*
    const directUploadssRe =
      /https?:\/\/(?:automation\.ideas\.edu\.vn|myerp\.ideas\.edu\.vn\/backend)\/uploadss\/([^\s"'<>\\)]+)/gi;
    out = out.replace(directUploadssRe, (_match, relPath: string) => {
      this.rewriteCount += 1;
      return this.recordUploadssPath(relPath);
    });

    // 3. Rewrite legacy automation.ideas.edu.vn/uploads/ai_training/*
    const aiTrainRe = /https?:\/\/automation\.ideas\.edu\.vn\/uploads\/ai_training\/([^\s"'<>\\)]+)/gi;
    out = out.replace(aiTrainRe, (_match, relPath: string) => {
      const clean = relPath.replace(/^\/+/, '');
      const pathNoQuery = clean.split(/[?#]/)[0];
      if (pathNoQuery) this.aiTrainingAssets.add(pathNoQuery);
      this.rewriteCount += 1;
      return `${this.publicOrigin}/uploads/ai_training/${clean}`;
    });

    // 4. Rewrite legacy template_thumbs URLs on legacy hosts to root-relative /uploads/template_thumbs/*
    const tplThumbHostRe =
      /https?:\/\/(?:(?:automation|myerp|erp|mail)\.ideas\.edu\.vn|open\.automation\.net|crm\.domation\.net)(?:\/backend)?\/uploads\/template_thumbs\/([^\s"'<>\\)]+)/gi;
    out = out.replace(tplThumbHostRe, (_match, relPath: string) => {
      const clean = relPath.replace(/^\/+/, '');
      const pathNoQuery = clean.split(/[?#]/)[0];
      if (pathNoQuery) this.templateThumbs.add(pathNoQuery);
      this.rewriteCount += 1;
      return `/uploads/template_thumbs/${clean}`;
    });

    // 5. Rewrite legacy PHP public endpoints (timer.php, track.php, voucher_claim.php) to DOMATION API v1
    out = out.replace(
      /https?:\/\/(?:(?:automation|myerp|erp|mail)\.ideas\.edu\.vn|open\.automation\.net|crm\.domation\.net)(?:\/backend)?\/(?:mail_api|automation|api)\/timer\.php(\?[^\s"'<>\\)]*)?/gi,
      (_m, qs: string | undefined) => {
        this.rewriteCount += 1;
        return `${this.publicOrigin}/api/v1/public/marketing/timer${qs || ''}`;
      }
    );
    out = out.replace(
      /https?:\/\/(?:(?:automation|myerp|erp|mail)\.ideas\.edu\.vn|open\.automation\.net|crm\.domation\.net)(?:\/backend)?\/(?:mail_api|automation|api)\/track\.php([^\s"'<>\\)]*)?/gi,
      (_m, rest: string | undefined) => {
        this.rewriteCount += 1;
        return `${this.publicOrigin}/api/v1/public/marketing/track${rest || ''}`;
      }
    );
    out = out.replace(
      /https?:\/\/(?:(?:automation|myerp|erp|mail)\.ideas\.edu\.vn|open\.automation\.net|crm\.domation\.net)(?:\/backend)?\/(?:mail_api|automation|api)\/voucher_claim\.php([^\s"'<>\\)]*)?/gi,
      (_m, rest: string | undefined) => {
        this.rewriteCount += 1;
        return `${this.publicOrigin}/api/v1/public/marketing/vouchers${rest || ''}`;
      }
    );

    // 6. Rewrite public survey links (/s/<slug>) on legacy hosts to canonical DOMATION ERP origin
    out = out.replace(
      /https?:\/\/(?:(?:automation|myerp|erp|mail)\.ideas\.edu\.vn|open\.automation\.net|crm\.domation\.net)(?:\/backend)?\/(?:s|survey)\/([^\s"'<>\\)]+)/gi,
      (_m, slugPath: string) => {
        this.rewriteCount += 1;
        return `${this.crmOrigin}/s/${slugPath.replace(/^\/+/, '')}`;
      }
    );

    // 7. Rewrite any remaining URLs on legacy MYERP / automation hosts to DOMATION (never altering ideas.edu.vn landing URLs)
    out = out.replace(
      /https?:\/\/(?:(?:automation|myerp|erp|mail)\.ideas\.edu\.vn|open\.automation\.net|crm\.domation\.net)(\/[^\s"'<>\\)]*)?/gi,
      (_m, rawPath: string | undefined) => {
        const rest = rawPath || '';
        this.rewriteCount += 1;
        if (/^\/(?:backend\/)?uploadss\//i.test(rest)) {
          return this.recordUploadssPath(rest.replace(/^\/(?:backend\/)?uploadss\//i, ''));
        }
        if (/^\/(?:backend\/)?uploads\//i.test(rest)) {
          return `${this.publicOrigin}${rest.replace(/^\/backend/i, '')}`;
        }
        if (/^\/(?:mail_api|api\/v1\/public)\b/i.test(rest)) {
          return `${this.publicOrigin}${rest.replace(/^\/mail_api\b/i, '/api/v1/public/marketing')}`;
        }
        if (/^\/backend\b/i.test(rest) || /^\/api\b/i.test(rest)) {
          return `${this.publicOrigin}${rest}`;
        }
        return `${this.crmOrigin}${rest}`;
      }
    );

    // 8. Rewrite relative ../uploadss/* or /uploadss/* paths
    if (mode === 'url_field' || mode === 'json_leaf') {
      const trimmed = out.trim();
      const relMatch = trimmed.match(/^(?:\.\.\/|\/)uploadss\/(.+)$/i);
      if (relMatch && relMatch[1]) {
        this.rewriteCount += 1;
        out = this.recordUploadssPath(relMatch[1]);
      }
    }
    if (mode === 'html' || mode === 'json_leaf') {
      out = out.replace(
        /(src|href)=(["'])(?:\.\.\/|\/)uploadss\/([^"']+)\2/gi,
        (_m, attr: string, quote: string, relPath: string) => {
          this.rewriteCount += 1;
          return `${attr}=${quote}${this.recordUploadssPath(relPath)}${quote}`;
        }
      );
    }

    return out;
  }

  rewriteJsonValue<T>(value: T): T {
    if (typeof value === 'string') {
      return this.rewriteString(value, 'json_leaf') as unknown as T;
    }
    if (Array.isArray(value)) {
      return value.map((item) => this.rewriteJsonValue(item)) as unknown as T;
    }
    if (value && typeof value === 'object') {
      const rec = value as Record<string, unknown>;
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(rec)) {
        out[k] = this.rewriteJsonValue(v);
      }
      return out as T;
    }
    return value;
  }
}

export function rewriteLegacyIdeasUrl(
  input: string,
  publicOrigin = DEFAULT_PUBLIC_URL,
  crmOrigin = DEFAULT_CRM_URL
): string {
  return new LegacyUrlRewriter(publicOrigin, crmOrigin).rewriteString(input, 'html');
}

const FLOW_UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface FlowIdRemapMaps {
  formIdMap?: Map<string, string>;
  listIdMap?: Map<string, string>;
  campaignIdMap?: Map<string, string>;
  templateIdMap?: Map<string, string>;
}

/**
 * Remaps legacy MYERP form/list/segment/campaign/template IDs inside flow `trigger_config`
 * and `steps_json`, synchronizing `form_id`/`audience_id`/`campaign_id` so migrated flows
 * execute natively inside DOMATION's flow engine without "Form đã xóa" references.
 */
export function remapFlowTriggerAndSteps(
  triggerTypeRaw: string,
  triggerConfigRaw: unknown,
  stepsRaw: unknown,
  maps: FlowIdRemapMaps
): { triggerConfig: Record<string, unknown>; steps: unknown[]; remappedCount: number } {
  const { formIdMap, listIdMap, campaignIdMap, templateIdMap } = maps;
  let remappedCount = 0;

  const lookupMap = (mapper: Map<string, string> | undefined, raw: string): string | null => {
    if (!mapper || !raw) return null;
    return mapper.get(raw) || mapper.get(raw.toLowerCase()) || null;
  };

  const resolveByCategory = (categoryHint: string, rawVal: unknown): string | null => {
    const raw = typeof rawVal === 'string' || typeof rawVal === 'number' ? String(rawVal).trim() : '';
    if (!raw) return null;
    const h = categoryHint.toLowerCase();
    if (h === 'template') return lookupMap(templateIdMap, raw);
    if (h === 'form') return lookupMap(formIdMap, raw);
    if (h === 'segment' || h === 'list' || h === 'audience') return lookupMap(listIdMap, raw);
    if (h === 'campaign') return lookupMap(campaignIdMap, raw);
    if (h === 'tag') return null;
    return lookupMap(formIdMap, raw) || lookupMap(listIdMap, raw) || lookupMap(campaignIdMap, raw);
  };

  const normalizeCfgObject = (cfgRaw: unknown, fallbackType: string): Record<string, unknown> => {
    const src =
      cfgRaw && typeof cfgRaw === 'object' && !Array.isArray(cfgRaw)
        ? { ...(cfgRaw as Record<string, unknown>) }
        : {};
    const stepKind = String(src.type || src.trigger_type || fallbackType || '').toLowerCase();

    const mappedForm =
      resolveByCategory('form', src.form_id ?? src.formId) ||
      (stepKind === 'form' ? resolveByCategory('form', src.targetId) : null);
    if (mappedForm) {
      if (src.form_id !== mappedForm || src.formId !== mappedForm) remappedCount++;
      src.form_id = mappedForm;
      src.formId = mappedForm;
      if (src.targetId && !FLOW_UUID_RE.test(String(src.targetId))) src.targetId = mappedForm;
    }

    const mappedAud =
      resolveByCategory('audience', src.audience_id ?? src.audienceId ?? src.list_id ?? src.listId ?? src.segment_id ?? src.segmentId) ||
      (stepKind === 'segment' || stepKind === 'list' || stepKind === 'audience'
        ? resolveByCategory('audience', src.targetId)
        : null);
    if (mappedAud) {
      if (src.audience_id !== mappedAud || src.targetId !== mappedAud) remappedCount++;
      src.audience_id = mappedAud;
      src.audienceId = mappedAud;
      if (src.list_id !== undefined) src.list_id = mappedAud;
      if (src.listId !== undefined) src.listId = mappedAud;
      if (src.segment_id !== undefined) src.segment_id = mappedAud;
      if (src.segmentId !== undefined) src.segmentId = mappedAud;
      if (src.targetId && !FLOW_UUID_RE.test(String(src.targetId))) src.targetId = mappedAud;
    }

    const mappedCamp =
      resolveByCategory('campaign', src.campaign_id ?? src.campaignId) ||
      (stepKind === 'campaign' ? resolveByCategory('campaign', src.targetId) : null);
    if (mappedCamp) {
      if (src.campaign_id !== mappedCamp || src.targetId !== mappedCamp) remappedCount++;
      src.campaign_id = mappedCamp;
      src.campaignId = mappedCamp;
      if (src.targetId && !FLOW_UUID_RE.test(String(src.targetId))) src.targetId = mappedCamp;
    }

    if (typeof src.targetId === 'string' && src.targetId.trim() && !FLOW_UUID_RE.test(src.targetId.trim())) {
      const genericMapped = resolveByCategory(stepKind, src.targetId);
      if (genericMapped) {
        src.legacy_target_id = src.targetId;
        src.targetId = genericMapped;
        remappedCount++;
        if (stepKind === 'form') {
          src.form_id = genericMapped;
          src.formId = genericMapped;
        } else if (stepKind === 'segment' || stepKind === 'list' || stepKind === 'audience') {
          src.audience_id = genericMapped;
          src.audienceId = genericMapped;
        } else if (stepKind === 'campaign') {
          src.campaign_id = genericMapped;
          src.campaignId = genericMapped;
        }
      }
    }

    const rawTpl = src.template_id ?? src.templateId;
    const mappedTpl = resolveByCategory('template', rawTpl);
    if (mappedTpl) {
      src.template_id = mappedTpl;
      src.templateId = mappedTpl;
    }

    return src;
  };

  const baseTriggerType = String(triggerTypeRaw || 'manual').trim().toLowerCase();
  const baseTriggerCfg = normalizeCfgObject(triggerConfigRaw, baseTriggerType);

  let trigStepCfg: Record<string, unknown> | undefined;
  const stepsArr = Array.isArray(stepsRaw) ? stepsRaw : [];
  const nextSteps = stepsArr.map((st) => {
    if (!st || typeof st !== 'object') return st;
    const rec = { ...(st as Record<string, unknown>) };
    const stType = String(rec.type || '').toLowerCase();
    const cfg = normalizeCfgObject(rec.config, stType === 'trigger' ? baseTriggerType : stType);
    rec.config = cfg;
    if (stType === 'trigger' && trigStepCfg === undefined) {
      trigStepCfg = cfg;
    }
    return rec;
  });

  const mergedTriggerCfg: Record<string, unknown> = trigStepCfg
    ? { ...baseTriggerCfg, ...(trigStepCfg as Record<string, unknown>) }
    : baseTriggerCfg;

  // Ensure canonical snake_case keys exist on trigger_config when targetId is a mapped UUID
  const trigTarget = typeof mergedTriggerCfg.targetId === 'string' ? mergedTriggerCfg.targetId.trim() : '';
  const effType = String(mergedTriggerCfg.type || baseTriggerType).toLowerCase();
  if (trigTarget && FLOW_UUID_RE.test(trigTarget)) {
    if (effType === 'form' && !mergedTriggerCfg.form_id) mergedTriggerCfg.form_id = trigTarget;
    if ((effType === 'segment' || effType === 'list' || effType === 'audience') && !mergedTriggerCfg.audience_id) {
      mergedTriggerCfg.audience_id = trigTarget;
    }
    if (effType === 'campaign' && !mergedTriggerCfg.campaign_id) mergedTriggerCfg.campaign_id = trigTarget;
  }

  return { triggerConfig: mergedTriggerCfg, steps: nextSteps, remappedCount };
}

// ============================================================================
// Streaming MariaDB SQL Dump Parser (632MB+ & Multiline String Safe)
// ============================================================================

function isBackupTable(tableName: string): boolean {
  const lower = tableName.toLowerCase();
  return lower.startsWith('_bak_') || lower.includes('_backup_');
}

function isZaloTable(tableName: string): boolean {
  return tableName.toLowerCase().startsWith('zalo_');
}

/**
 * Streams a MariaDB/mysqldump SQL file in 1 MiB UTF-8 chunks using a character-level
 * state machine. Never loads the full file into RAM; fast-skips out-of-scope tables
 * (including 28.7MB single lines) without building row objects; handles both
 * positional VALUES(...) and explicit INSERT column lists, escaped quotes, NUL byte
 * sanitization, and literal multiline strings inside SQL string literals.
 */
export async function parseMyerpSqlDump(
  sqlPath: string,
  options?: { skipWebAnalytics?: boolean }
): Promise<ParsedDumpData> {
  const stat = await fs.promises.stat(sqlPath);
  const skipWebAnalytics = options?.skipWebAnalytics ?? false;

  const data: ParsedDumpData = {
    fileSizeBytes: stat.size,
    tablesDefined: 0,
    backupTablesSkipped: [],
    zaloTablesSkipped: [],
    outOfScopeTablesSkipped: 0,
    filteredCounts: {},
    excludedCounts: {},
    tenants: [],
    users: [],
    systemSettings: new Map(),
    zaloSettingKeysExcluded: 0,
    mktSystemSettings: new Map(),
    persons: new Map(),
    companies: [],
    contacts: [],
    excluded99999UserIds: new Set(),
    excluded99999Emails: new Set(),
    excluded99999Phones: new Set(),
    leads: [],
    pipelineStages: [],
    distributionRounds: [],
    roundConsultants: [],
    routingRules: [],
    distributionLogs: [],
    activeCompensationLogs: [],
    dataReports: [],
    notes: [],
    comments: [],
    activities: [],
    tickets: [],
    tags: [],
    sheetConnections: [],
    fieldMappings: [],
    sheetSyncCounts: new Map(),
    integrations: [],
    subscribers: [],
    lists: [],
    subscriberLists: [],
    segments: [],
    domationTags: [],
    subscriberTags: [],
    templates: [],
    templateGroups: [],
    emailSections: [],
    globalAssets: [],
    campaigns: [],
    campaignSendClaims: [],
    mailDeliveryLogs: [],
    mailQueueTotal: 0,
    mailQueuePending: 0,
    subscriberActivity: [],
    verifiedSenders: [],
    flows: [],
    flowSnapshots: [],
    subscriberFlowStates: [],
    forms: [],
    purchaseEvents: [],
    surveys: [],
    surveyQuestions: [],
    surveyResponses: [],
    surveyAnswerDetails: [],
    voucherCampaigns: [],
    voucherCodes: [],
    shortLinks: [],
    linkClicks: [],
    webProperties: [],
    webSessions: [],
    webPageViews: [],
    webEvents: [],
    webBlacklist: [],
    aiChatbots: [],
    aiChatbotSettings: [],
    aiChatbotScenarios: [],
    domationAiTrainingDocs: [],
    domationAiChunkStats: new Map(),
    domationAiConversations: [],
    domationAiMessages: [],
    contactMetaAttribution: [],
    capiLogs: [],
    capiBlockedPhones: [],
    metaAppConfigs: [],
    metaSubscribers: [],
    metaConversations: [],
    metaMessageLogs: [],
    metaCustomerJourney: [],
    metaAutomationScenarios: [],
  };

  const tableColumns = new Map<string, string[]>();
  const seenTables = new Set<string>();

  const buildRowObj = (cols: string[], vals: SqlCell[]): RowObj => {
    const obj: RowObj = {};
    const len = cols.length;
    for (let k = 0; k < len; k++) {
      obj[cols[k]] = k < vals.length ? vals[k] : null;
    }
    return obj;
  };

  const handleRow = (table: string, cols: string[], vals: SqlCell[]) => {
    const colIdx = (name: string): number => cols.indexOf(name);
    const get = (name: string): SqlCell => {
      const idx = colIdx(name);
      return idx >= 0 && idx < vals.length ? vals[idx] : null;
    };

    switch (table) {
      case 'tenants': {
        const obj = buildRowObj(cols, vals);
        if (isIdeasTenant(obj.id)) {
          data.tenants.push(obj);
          incCounter(data.filteredCounts, 'tenants');
        } else {
          incCounter(data.excludedCounts, 'tenants');
        }
        return;
      }
      case 'workspaces': {
        if (isIdeasWorkspace(get('id'))) incCounter(data.filteredCounts, 'workspaces');
        else incCounter(data.excludedCounts, 'workspaces');
        return;
      }
      case 'users': {
        const obj = buildRowObj(cols, vals);
        if (isIdeasTenant(obj.tenant_id)) {
          data.users.push(obj);
          incCounter(data.filteredCounts, 'users');
        } else {
          if (obj.id !== null) data.excluded99999UserIds.add(String(obj.id));
          incCounter(data.excludedCounts, 'users');
        }
        return;
      }
      case 'system_settings': {
        const k = asTrimmed(get('setting_key'));
        const v = asStr(get('setting_value'));
        if (!k) return;
        if (k.toLowerCase().startsWith(ZALO_SETTING_PREFIX)) {
          data.zaloSettingKeysExcluded += 1;
          incCounter(data.excludedCounts, 'system_settings_zalo');
          return;
        }
        data.systemSettings.set(k, v);
        incCounter(data.filteredCounts, 'system_settings');
        return;
      }
      case 'mkt_system_settings': {
        const wsVal = get('workspace_id');
        if (!isIdeasWorkspace(wsVal, true)) {
          incCounter(data.excludedCounts, 'mkt_system_settings');
          return;
        }
        const k = asTrimmed(get('key'));
        if (!k) return;
        if (k.toLowerCase().includes('zalo')) {
          data.zaloSettingKeysExcluded += 1;
          incCounter(data.excludedCounts, 'mkt_system_settings_zalo');
          return;
        }
        const val = asStr(get('value'));
        const updatedAt = asTrimmed(get('updated_at'));
        const wsNum = Number(wsVal);
        const existing = data.mktSystemSettings.get(k);
        if (!existing) {
          data.mktSystemSettings.set(k, { value: val, updatedAt, workspaceId: wsNum });
        } else {
          // Prefer latest updated_at; on tie prefer ws=1 over ws=0; never overwrite non-empty with empty
          const newIsNewer = updatedAt > existing.updatedAt;
          const sameTimePreferWs1 = updatedAt === existing.updatedAt && wsNum === 1 && existing.workspaceId === 0;
          if ((newIsNewer || sameTimePreferWs1) && (val !== '' || existing.value === '')) {
            data.mktSystemSettings.set(k, { value: val, updatedAt, workspaceId: wsNum });
          } else if (existing.value === '' && val !== '') {
            data.mktSystemSettings.set(k, { value: val, updatedAt, workspaceId: wsNum });
          }
        }
        incCounter(data.filteredCounts, 'mkt_system_settings');
        return;
      }
      case 'persons': {
        const id = asTrimmed(get('id'));
        if (!id) return;
        data.persons.set(id, {
          phone: asNullableStr(get('phone')),
          email: asNullableStr(get('email')),
          full_name: asNullableStr(get('full_name')),
        });
        incCounter(data.filteredCounts, 'persons');
        return;
      }
      case 'companies': {
        const obj = buildRowObj(cols, vals);
        if (isIdeasTenant(obj.tenant_id)) {
          data.companies.push(obj);
          incCounter(data.filteredCounts, 'companies');
        } else {
          incCounter(data.excludedCounts, 'companies');
        }
        return;
      }
      case 'contacts': {
        const obj = buildRowObj(cols, vals);
        if (isIdeasTenant(obj.tenant_id)) {
          data.contacts.push(obj);
          incCounter(data.filteredCounts, 'contacts');
        } else {
          const em = normalizeEmail(obj.email);
          if (em) data.excluded99999Emails.add(em);
          const ph = normalizePhoneKey(obj.phone);
          if (ph) data.excluded99999Phones.add(ph);
          incCounter(data.excludedCounts, 'contacts');
        }
        return;
      }
      case 'leads': {
        data.leads.push(buildRowObj(cols, vals));
        incCounter(data.filteredCounts, 'leads');
        return;
      }
      case 'pipeline_stages': {
        const obj = buildRowObj(cols, vals);
        if (isIdeasTenant(obj.tenant_id)) {
          data.pipelineStages.push(obj);
          incCounter(data.filteredCounts, 'pipeline_stages');
        } else {
          incCounter(data.excludedCounts, 'pipeline_stages');
        }
        return;
      }
      case 'distribution_rounds': {
        const obj = buildRowObj(cols, vals);
        if (isIdeasTenant(obj.tenant_id)) {
          data.distributionRounds.push(obj);
          incCounter(data.filteredCounts, 'distribution_rounds');
        } else {
          incCounter(data.excludedCounts, 'distribution_rounds');
        }
        return;
      }
      case 'round_consultants': {
        data.roundConsultants.push(buildRowObj(cols, vals));
        incCounter(data.filteredCounts, 'round_consultants');
        return;
      }
      case 'routing_rules': {
        data.routingRules.push(buildRowObj(cols, vals));
        incCounter(data.filteredCounts, 'routing_rules');
        return;
      }
      case 'distribution_logs': {
        data.distributionLogs.push({
          id: asTrimmed(get('id')),
          lead_id: asTrimmed(get('lead_id')),
          assigned_to: asNullableStr(get('assigned_to')),
          round_id: asNullableStr(get('round_id')),
          status: asNullableStr(get('status')),
          message: asNullableStr(get('message')),
          received_at: asNullableStr(get('received_at')),
        });
        incCounter(data.filteredCounts, 'distribution_logs');
        return;
      }
      case 'active_compensation_logs': {
        const obj = buildRowObj(cols, vals);
        if (isIdeasTenant(obj.tenant_id)) {
          data.activeCompensationLogs.push(obj);
          incCounter(data.filteredCounts, 'active_compensation_logs');
        } else {
          incCounter(data.excludedCounts, 'active_compensation_logs');
        }
        return;
      }
      case 'data_reports': {
        data.dataReports.push(buildRowObj(cols, vals));
        incCounter(data.filteredCounts, 'data_reports');
        return;
      }
      case 'notes': {
        const obj = buildRowObj(cols, vals);
        if (isIdeasTenant(obj.tenant_id)) {
          data.notes.push(obj);
          incCounter(data.filteredCounts, 'notes');
        } else {
          incCounter(data.excludedCounts, 'notes');
        }
        return;
      }
      case 'comments': {
        const obj = buildRowObj(cols, vals);
        if (isIdeasTenant(obj.tenant_id)) {
          data.comments.push(obj);
          incCounter(data.filteredCounts, 'comments');
        } else {
          incCounter(data.excludedCounts, 'comments');
        }
        return;
      }
      case 'activities': {
        if (!isIdeasTenant(get('tenant_id'))) {
          incCounter(data.excludedCounts, 'activities');
          return;
        }
        data.activities.push({
          id: asTrimmed(get('id')),
          user_id: asNullableStr(get('user_id')),
          created_by: asNullableStr(get('created_by')),
          type: asNullableStr(get('type')),
          subject: asNullableStr(get('subject')),
          body: asNullableStr(get('body')),
          status: asNullableStr(get('status')),
          priority: asNullableStr(get('priority')),
          due_date: asNullableStr(get('due_date')),
          done_at: asNullableStr(get('done_at')),
          related_type: asNullableStr(get('related_type')),
          related_id: asNullableStr(get('related_id')),
          contact_id: asNullableStr(get('contact_id')),
          created_at: asNullableStr(get('created_at')),
          updated_at: asNullableStr(get('updated_at')),
          deleted_at: asNullableStr(get('deleted_at')),
        });
        incCounter(data.filteredCounts, 'activities');
        return;
      }
      case 'tickets': {
        const obj = buildRowObj(cols, vals);
        if (isIdeasTenant(obj.tenant_id)) {
          data.tickets.push(obj);
          incCounter(data.filteredCounts, 'tickets');
        } else {
          incCounter(data.excludedCounts, 'tickets');
        }
        return;
      }
      case 'tags': {
        const obj = buildRowObj(cols, vals);
        if (isIdeasTenant(obj.tenant_id)) {
          data.tags.push(obj);
          incCounter(data.filteredCounts, 'tags');
        } else {
          incCounter(data.excludedCounts, 'tags');
        }
        return;
      }
      case 'sheet_connections': {
        data.sheetConnections.push(buildRowObj(cols, vals));
        incCounter(data.filteredCounts, 'sheet_connections');
        return;
      }
      case 'field_mappings': {
        data.fieldMappings.push(buildRowObj(cols, vals));
        incCounter(data.filteredCounts, 'field_mappings');
        return;
      }
      case 'sheet_sync_records': {
        const cid = asTrimmed(get('connection_id'));
        if (cid) data.sheetSyncCounts.set(cid, (data.sheetSyncCounts.get(cid) || 0) + 1);
        incCounter(data.filteredCounts, 'sheet_sync_records');
        return;
      }
      case 'integrations': {
        const obj = buildRowObj(cols, vals);
        if (isIdeasWorkspace(obj.workspace_id)) {
          data.integrations.push(obj);
          incCounter(data.filteredCounts, 'integrations');
        } else {
          incCounter(data.excludedCounts, 'integrations');
        }
        return;
      }
      case 'subscribers': {
        const obj = buildRowObj(cols, vals);
        if (isIdeasWorkspace(obj.workspace_id)) {
          data.subscribers.push(obj);
          incCounter(data.filteredCounts, 'subscribers');
        } else {
          const em = normalizeEmail(obj.email || obj.email_norm);
          if (em) data.excluded99999Emails.add(em);
          incCounter(data.excludedCounts, 'subscribers');
        }
        return;
      }
      case 'lists': {
        const obj = buildRowObj(cols, vals);
        if (isIdeasWorkspace(obj.workspace_id)) {
          data.lists.push(obj);
          incCounter(data.filteredCounts, 'lists');
        } else {
          incCounter(data.excludedCounts, 'lists');
        }
        return;
      }
      case 'subscriber_lists': {
        if (!isIdeasWorkspace(get('workspace_id'))) {
          incCounter(data.excludedCounts, 'subscriber_lists');
          return;
        }
        const sid = asTrimmed(get('subscriber_id'));
        const lid = asTrimmed(get('list_id'));
        if (sid && lid) {
          data.subscriberLists.push({ subscriber_id: sid, list_id: lid });
          incCounter(data.filteredCounts, 'subscriber_lists');
        }
        return;
      }
      case 'segments': {
        const obj = buildRowObj(cols, vals);
        if (isIdeasTenant(obj.tenant_id) && isIdeasWorkspace(obj.workspace_id)) {
          data.segments.push(obj);
          incCounter(data.filteredCounts, 'segments');
        } else {
          incCounter(data.excludedCounts, 'segments');
        }
        return;
      }
      case 'domation_tags': {
        const obj = buildRowObj(cols, vals);
        if (isIdeasWorkspace(obj.workspace_id)) {
          data.domationTags.push(obj);
          incCounter(data.filteredCounts, 'domation_tags');
        } else {
          incCounter(data.excludedCounts, 'domation_tags');
        }
        return;
      }
      case 'subscriber_tags': {
        if (!isIdeasWorkspace(get('workspace_id'))) {
          incCounter(data.excludedCounts, 'subscriber_tags');
          return;
        }
        const sid = asTrimmed(get('subscriber_id'));
        const tid = asTrimmed(get('tag_id'));
        if (sid && tid) {
          data.subscriberTags.push({ subscriber_id: sid, tag_id: tid });
          incCounter(data.filteredCounts, 'subscriber_tags');
        }
        return;
      }
      case 'templates': {
        const obj = buildRowObj(cols, vals);
        if (isIdeasWorkspace(obj.workspace_id)) {
          data.templates.push(obj);
          incCounter(data.filteredCounts, 'templates');
        } else {
          incCounter(data.excludedCounts, 'templates');
        }
        return;
      }
      case 'template_groups': {
        const obj = buildRowObj(cols, vals);
        if (isIdeasWorkspace(obj.workspace_id)) {
          data.templateGroups.push(obj);
          incCounter(data.filteredCounts, 'template_groups');
        } else {
          incCounter(data.excludedCounts, 'template_groups');
        }
        return;
      }
      case 'email_sections': {
        const obj = buildRowObj(cols, vals);
        if (isIdeasWorkspace(obj.workspace_id)) {
          data.emailSections.push(obj);
          incCounter(data.filteredCounts, 'email_sections');
        } else {
          incCounter(data.excludedCounts, 'email_sections');
        }
        return;
      }
      case 'global_assets': {
        const obj = buildRowObj(cols, vals);
        if (isIdeasWorkspace(obj.workspace_id)) {
          data.globalAssets.push(obj);
          incCounter(data.filteredCounts, 'global_assets');
        } else {
          incCounter(data.excludedCounts, 'global_assets');
        }
        return;
      }
      case 'campaigns': {
        const obj = buildRowObj(cols, vals);
        if (isIdeasWorkspace(obj.workspace_id)) {
          data.campaigns.push(obj);
          incCounter(data.filteredCounts, 'campaigns');
        } else {
          incCounter(data.excludedCounts, 'campaigns');
        }
        return;
      }
      case 'campaign_send_claims': {
        const obj = buildRowObj(cols, vals);
        if (isIdeasWorkspace(obj.workspace_id)) {
          data.campaignSendClaims.push(obj);
          incCounter(data.filteredCounts, 'campaign_send_claims');
        } else {
          incCounter(data.excludedCounts, 'campaign_send_claims');
        }
        return;
      }
      case 'mail_delivery_logs': {
        if (!isIdeasWorkspace(get('workspace_id'), true)) {
          incCounter(data.excludedCounts, 'mail_delivery_logs');
          return;
        }
        data.mailDeliveryLogs.push({
          id: asTrimmed(get('id')),
          recipient: asNullableStr(get('recipient')),
          subject: asNullableStr(get('subject')),
          campaign_id: asNullableStr(get('campaign_id')),
          flow_id: asNullableStr(get('flow_id')),
          status: asNullableStr(get('status')),
          error_message: asNullableStr(get('error_message')),
          sent_at: asNullableStr(get('sent_at')),
          subscriber_id: asNullableStr(get('subscriber_id')),
          created_at: asNullableStr(get('created_at')),
        });
        incCounter(data.filteredCounts, 'mail_delivery_logs');
        return;
      }
      case 'mail_queue': {
        // Intentionally never migrated (F5 safety gate: purge stale pending queue)
        data.mailQueueTotal += 1;
        if (asTrimmed(get('status')).toLowerCase() === 'pending') {
          data.mailQueuePending += 1;
        }
        incCounter(data.excludedCounts, 'mail_queue');
        return;
      }
      case 'subscriber_activity': {
        if (!isIdeasWorkspace(get('workspace_id'))) {
          incCounter(data.excludedCounts, 'subscriber_activity');
          return;
        }
        data.subscriberActivity.push({
          id: asTrimmed(get('id')),
          contact_id: asNullableStr(get('contact_id')),
          subscriber_id: asNullableStr(get('subscriber_id')),
          type: asNullableStr(get('type')),
          action_type: asNullableStr(get('action_type')),
          campaign_id: asNullableStr(get('campaign_id')),
          flow_id: asNullableStr(get('flow_id')),
          reference_name: asNullableStr(get('reference_name')),
          target_name: asNullableStr(get('target_name')),
          details: asNullableStr(get('details'), 500),
          created_at: asNullableStr(get('created_at')),
        });
        incCounter(data.filteredCounts, 'subscriber_activity');
        return;
      }
      case 'verified_senders': {
        const obj = buildRowObj(cols, vals);
        if (isIdeasWorkspace(obj.workspace_id)) {
          data.verifiedSenders.push(obj);
          incCounter(data.filteredCounts, 'verified_senders');
        } else {
          incCounter(data.excludedCounts, 'verified_senders');
        }
        return;
      }
      case 'flows': {
        const obj = buildRowObj(cols, vals);
        if (isIdeasWorkspace(obj.workspace_id)) {
          data.flows.push(obj);
          incCounter(data.filteredCounts, 'flows');
        } else {
          incCounter(data.excludedCounts, 'flows');
        }
        return;
      }
      case 'flow_snapshots': {
        data.flowSnapshots.push(buildRowObj(cols, vals));
        incCounter(data.filteredCounts, 'flow_snapshots');
        return;
      }
      case 'subscriber_flow_states': {
        if (!isIdeasWorkspace(get('workspace_id'))) {
          incCounter(data.excludedCounts, 'subscriber_flow_states');
          return;
        }
        data.subscriberFlowStates.push({
          id: asTrimmed(get('id')),
          contact_id: asNullableStr(get('contact_id')),
          subscriber_id: asNullableStr(get('subscriber_id')),
          flow_id: asNullableStr(get('flow_id')),
          step_id: asNullableStr(get('step_id')),
          step_type: asNullableStr(get('step_type')),
          status: asNullableStr(get('status')),
          scheduled_at: asNullableStr(get('scheduled_at')),
          waiting_until: asNullableStr(get('waiting_until')),
          branch_taken: asNullableStr(get('branch_taken')),
          last_error: asNullableStr(get('last_error')),
          created_at: asNullableStr(get('created_at')),
          updated_at: asNullableStr(get('updated_at')),
          last_step_at: asNullableStr(get('last_step_at')),
        });
        incCounter(data.filteredCounts, 'subscriber_flow_states');
        return;
      }
      case 'forms': {
        const obj = buildRowObj(cols, vals);
        const wsOk = obj.workspace_id === null || obj.workspace_id === undefined || isIdeasWorkspace(obj.workspace_id);
        if (isIdeasTenant(obj.tenant_id) && wsOk) {
          data.forms.push(obj);
          incCounter(data.filteredCounts, 'forms');
        } else {
          incCounter(data.excludedCounts, 'forms');
        }
        return;
      }
      case 'surveys': {
        const obj = buildRowObj(cols, vals);
        if (isIdeasWorkspace(obj.workspace_id)) {
          data.surveys.push(obj);
          incCounter(data.filteredCounts, 'surveys');
        } else {
          incCounter(data.excludedCounts, 'surveys');
        }
        return;
      }
      case 'survey_questions': {
        data.surveyQuestions.push(buildRowObj(cols, vals));
        incCounter(data.filteredCounts, 'survey_questions');
        return;
      }
      case 'purchase_events': {
        const obj = buildRowObj(cols, vals);
        if (isIdeasWorkspace(obj.workspace_id)) {
          data.purchaseEvents.push(obj);
          incCounter(data.filteredCounts, 'purchase_events');
        } else {
          incCounter(data.excludedCounts, 'purchase_events');
        }
        return;
      }
      case 'survey_responses': {
        const obj = buildRowObj(cols, vals);
        if (isIdeasWorkspace(obj.workspace_id)) {
          data.surveyResponses.push(obj);
          incCounter(data.filteredCounts, 'survey_responses');
        } else {
          incCounter(data.excludedCounts, 'survey_responses');
        }
        return;
      }
      case 'survey_answer_details': {
        data.surveyAnswerDetails.push(buildRowObj(cols, vals));
        incCounter(data.filteredCounts, 'survey_answer_details');
        return;
      }
      case 'voucher_campaigns': {
        const obj = buildRowObj(cols, vals);
        if (isIdeasWorkspace(obj.workspace_id)) {
          data.voucherCampaigns.push(obj);
          incCounter(data.filteredCounts, 'voucher_campaigns');
        } else {
          incCounter(data.excludedCounts, 'voucher_campaigns');
        }
        return;
      }
      case 'voucher_codes': {
        const obj = buildRowObj(cols, vals);
        if (isIdeasWorkspace(obj.workspace_id)) {
          data.voucherCodes.push(obj);
          incCounter(data.filteredCounts, 'voucher_codes');
        } else {
          incCounter(data.excludedCounts, 'voucher_codes');
        }
        return;
      }
      case 'short_links': {
        const obj = buildRowObj(cols, vals);
        if (isIdeasWorkspace(obj.workspace_id)) {
          data.shortLinks.push(obj);
          incCounter(data.filteredCounts, 'short_links');
        } else {
          incCounter(data.excludedCounts, 'short_links');
        }
        return;
      }
      case 'link_clicks': {
        data.linkClicks.push(buildRowObj(cols, vals));
        incCounter(data.filteredCounts, 'link_clicks');
        return;
      }
      case 'web_properties': {
        const obj = buildRowObj(cols, vals);
        if (isIdeasWorkspace(obj.workspace_id)) {
          data.webProperties.push(obj);
          incCounter(data.filteredCounts, 'web_properties');
        } else {
          incCounter(data.excludedCounts, 'web_properties');
        }
        return;
      }
      case 'web_visitors': {
        if (isIdeasWorkspace(get('workspace_id'))) incCounter(data.filteredCounts, 'web_visitors');
        else incCounter(data.excludedCounts, 'web_visitors');
        return;
      }
      case 'web_sessions': {
        const wsRaw = get('workspace_id');
        const wsNum = wsRaw === null || wsRaw === '' ? null : Number(wsRaw);
        if (wsNum !== null && wsNum !== 1) {
          incCounter(data.excludedCounts, 'web_sessions');
          return;
        }
        if (!skipWebAnalytics) {
          data.webSessions.push({
            id: asTrimmed(get('id')),
            visitor_id: asNullableStr(get('visitor_id')),
            property_id: asNullableStr(get('property_id')),
            workspace_id: wsNum,
            started_at: asNullableStr(get('started_at')),
            last_active_at: asNullableStr(get('last_active_at')),
            entry_url: asNullableStr(get('entry_url')),
            referrer_source: asNullableStr(get('referrer_source')),
            utm_source: asNullableStr(get('utm_source'), 100),
            utm_medium: asNullableStr(get('utm_medium'), 100),
            utm_campaign: asNullableStr(get('utm_campaign'), 150),
            page_count: toInt(get('page_count'), 1),
            duration_seconds: toInt(get('duration_seconds'), 0),
            device_type: asNullableStr(get('device_type'), 30),
            browser: asNullableStr(get('browser'), 60),
            os: asNullableStr(get('os'), 60),
            country: asNullableStr(get('country'), 60),
            city: asNullableStr(get('city'), 100),
            contact_id: asNullableStr(get('contact_id')),
          });
        }
        incCounter(data.filteredCounts, 'web_sessions');
        return;
      }
      case 'web_page_views': {
        const wsRaw = get('workspace_id');
        const wsNum = wsRaw === null || wsRaw === '' ? null : Number(wsRaw);
        if (wsNum !== null && wsNum !== 1) {
          incCounter(data.excludedCounts, 'web_page_views');
          return;
        }
        if (!skipWebAnalytics) {
          data.webPageViews.push({
            id: asTrimmed(get('id')),
            session_id: asNullableStr(get('session_id')),
            property_id: asNullableStr(get('property_id')),
            workspace_id: wsNum,
            url: asNullableStr(get('url')),
            title: asNullableStr(get('title'), 200),
            loaded_at: asNullableStr(get('loaded_at')),
            scroll_depth: get('scroll_depth') === null ? null : toInt(get('scroll_depth'), 0),
          });
        }
        incCounter(data.filteredCounts, 'web_page_views');
        return;
      }
      case 'web_events': {
        if (!isIdeasWorkspace(get('workspace_id'))) {
          incCounter(data.excludedCounts, 'web_events');
          return;
        }
        if (!skipWebAnalytics) {
          data.webEvents.push({
            id: asTrimmed(get('id')),
            session_id: asNullableStr(get('session_id')),
            page_view_id: asNullableStr(get('page_view_id')),
            property_id: asNullableStr(get('property_id')),
            event_type: asNullableStr(get('event_type'), 40),
            target_selector: asNullableStr(get('target_selector'), 255),
            target_text: asNullableStr(get('target_text'), 255),
            meta_data: asNullableStr(get('meta_data'), 4000),
            created_at: asNullableStr(get('created_at')),
          });
        }
        incCounter(data.filteredCounts, 'web_events');
        return;
      }
      case 'web_daily_stats': {
        incCounter(data.filteredCounts, 'web_daily_stats');
        return;
      }
      case 'web_blacklist': {
        const obj = buildRowObj(cols, vals);
        if (isIdeasWorkspace(obj.workspace_id)) {
          data.webBlacklist.push(obj);
          incCounter(data.filteredCounts, 'web_blacklist');
        } else {
          incCounter(data.excludedCounts, 'web_blacklist');
        }
        return;
      }
      case 'ai_chatbots': {
        data.aiChatbots.push(buildRowObj(cols, vals));
        incCounter(data.filteredCounts, 'ai_chatbots');
        return;
      }
      case 'ai_chatbot_settings': {
        data.aiChatbotSettings.push(buildRowObj(cols, vals));
        incCounter(data.filteredCounts, 'ai_chatbot_settings');
        return;
      }
      case 'ai_chatbot_scenarios': {
        data.aiChatbotScenarios.push(buildRowObj(cols, vals));
        incCounter(data.filteredCounts, 'ai_chatbot_scenarios');
        return;
      }
      case 'ai_chatbot_meta_settings': {
        incCounter(data.filteredCounts, 'ai_chatbot_meta_settings');
        return;
      }
      case 'domation_ai_training_docs': {
        data.domationAiTrainingDocs.push(buildRowObj(cols, vals));
        incCounter(data.filteredCounts, 'domation_ai_training_docs');
        return;
      }
      case 'domation_ai_training_chunks': {
        // Omit embedding_binary (contains NUL \x00 bytes); aggregate chunk/token counts per doc
        const docId = asTrimmed(get('doc_id'));
        if (docId) {
          const cur = data.domationAiChunkStats.get(docId) || { chunks: 0, tokens: 0 };
          cur.chunks += 1;
          cur.tokens += toInt(get('token_count'), 0);
          data.domationAiChunkStats.set(docId, cur);
        }
        incCounter(data.filteredCounts, 'domation_ai_training_chunks');
        return;
      }
      case 'domation_ai_conversations': {
        data.domationAiConversations.push(buildRowObj(cols, vals));
        incCounter(data.filteredCounts, 'domation_ai_conversations');
        return;
      }
      case 'domation_ai_messages': {
        data.domationAiMessages.push({
          id: asTrimmed(get('id')),
          conversation_id: asNullableStr(get('conversation_id')),
          sender: asNullableStr(get('sender')),
          message: asNullableStr(get('message')),
          created_at: asNullableStr(get('created_at')),
        });
        incCounter(data.filteredCounts, 'domation_ai_messages');
        return;
      }
      case 'contact_meta_attribution': {
        const obj = buildRowObj(cols, vals);
        if (isIdeasTenant(obj.tenant_id)) {
          data.contactMetaAttribution.push(obj);
          incCounter(data.filteredCounts, 'contact_meta_attribution');
        } else {
          incCounter(data.excludedCounts, 'contact_meta_attribution');
        }
        return;
      }
      case 'capi_logs': {
        data.capiLogs.push(buildRowObj(cols, vals));
        incCounter(data.filteredCounts, 'capi_logs');
        return;
      }
      case 'capi_blocked_phones': {
        if (!isIdeasTenant(get('tenant_id'))) {
          incCounter(data.excludedCounts, 'capi_blocked_phones');
          return;
        }
        if (get('deleted_at')) {
          incCounter(data.excludedCounts, 'capi_blocked_phones_deleted');
          return;
        }
        const ph = asTrimmed(get('phone_normalized'));
        if (!ph) return;
        data.capiBlockedPhones.push({
          id: asTrimmed(get('id')),
          phone_normalized: ph.slice(0, 40),
          source_label: asNullableStr(get('source_label'), 60),
          reason: asNullableStr(get('reason')),
          created_by: asNullableStr(get('created_by')),
          created_at: asNullableStr(get('created_at')),
        });
        incCounter(data.filteredCounts, 'capi_blocked_phones');
        return;
      }
      case 'meta_app_configs': {
        const obj = buildRowObj(cols, vals);
        if (isIdeasWorkspace(obj.workspace_id)) {
          data.metaAppConfigs.push(obj);
          incCounter(data.filteredCounts, 'meta_app_configs');
        } else {
          incCounter(data.excludedCounts, 'meta_app_configs');
        }
        return;
      }
      case 'meta_subscribers': {
        const obj = buildRowObj(cols, vals);
        if (isIdeasWorkspace(obj.workspace_id)) {
          data.metaSubscribers.push(obj);
          incCounter(data.filteredCounts, 'meta_subscribers');
        } else {
          incCounter(data.excludedCounts, 'meta_subscribers');
        }
        return;
      }
      case 'meta_conversations': {
        const obj = buildRowObj(cols, vals);
        if (isIdeasWorkspace(obj.workspace_id)) {
          data.metaConversations.push(obj);
          incCounter(data.filteredCounts, 'meta_conversations');
        } else {
          incCounter(data.excludedCounts, 'meta_conversations');
        }
        return;
      }
      case 'meta_message_logs': {
        if (!isIdeasWorkspace(get('workspace_id'))) {
          incCounter(data.excludedCounts, 'meta_message_logs');
          return;
        }
        data.metaMessageLogs.push({
          id: asTrimmed(get('id')),
          page_id: asNullableStr(get('page_id')),
          psid: asNullableStr(get('psid')),
          direction: asNullableStr(get('direction')),
          content: asNullableStr(get('content')),
          timestamp: asNullableStr(get('timestamp')),
          created_at: asNullableStr(get('created_at')),
        });
        incCounter(data.filteredCounts, 'meta_message_logs');
        return;
      }
      case 'meta_customer_journey': {
        if (!isIdeasWorkspace(get('workspace_id'))) {
          incCounter(data.excludedCounts, 'meta_customer_journey');
          return;
        }
        data.metaCustomerJourney.push({
          id: asTrimmed(get('id')),
          page_id: asNullableStr(get('page_id')),
          psid: asNullableStr(get('psid')),
          event_type: asNullableStr(get('event_type')),
          event_name: asNullableStr(get('event_name')),
          event_data: asNullableStr(get('event_data'), 500),
          created_at: asNullableStr(get('created_at')),
        });
        incCounter(data.filteredCounts, 'meta_customer_journey');
        return;
      }
      case 'meta_automation_scenarios': {
        const obj = buildRowObj(cols, vals);
        if (isIdeasWorkspace(obj.workspace_id)) {
          data.metaAutomationScenarios.push(obj);
          incCounter(data.filteredCounts, 'meta_automation_scenarios');
        } else {
          incCounter(data.excludedCounts, 'meta_automation_scenarios');
        }
        return;
      }
    }
  };

  // Streaming State Machine
  type TopState = 'LINE_SEEK' | 'CREATE_TABLE' | 'SKIP_STMT' | 'INSERT_HEADER' | 'INSERT_TUPLES';
  let state: TopState = 'LINE_SEEK';
  let lineBuf = '';

  // CREATE TABLE state
  let createTableName = '';
  let createCols: string[] = [];

  // SKIP_STMT state
  let skipInString = false;
  let skipEscaped = false;

  // INSERT state
  let insertTableName = '';
  let insertCols: string[] = [];
  let insertHeaderBuf = '';

  // Tuple parser sub-state (inside INSERT_TUPLES)
  type TupleSubState =
    | 'EXPECT_TUPLE'
    | 'EXPECT_VAL'
    | 'IN_STRING'
    | 'STRING_ESCAPE'
    | 'STRING_AFTER_QUOTE'
    | 'IN_RAW_TOKEN'
    | 'AFTER_VAL'
    | 'AFTER_TUPLE';

  let tState: TupleSubState = 'EXPECT_TUPLE';
  let currentRow: SqlCell[] = [];
  let valParts: string[] = [];
  let rawToken = '';

  const parseRawToken = (tok: string): SqlCell => {
    const trimmed = tok.trim();
    if (!trimmed || trimmed.toUpperCase() === 'NULL') return null;
    if (/^-?\d+$/.test(trimmed)) {
      return trimmed.length <= 15 ? Number(trimmed) : trimmed;
    }
    if (/^-?\d+\.\d+$/.test(trimmed)) {
      const n = Number(trimmed);
      return Number.isFinite(n) ? n : trimmed;
    }
    return trimmed;
  };

  const resetInsertState = () => {
    state = 'LINE_SEEK';
    lineBuf = '';
    insertTableName = '';
    insertCols = [];
    insertHeaderBuf = '';
    tState = 'EXPECT_TUPLE';
    currentRow = [];
    valParts = [];
    rawToken = '';
  };

  const processLineInSeekOrCreate = (line: string) => {
    if (state === 'CREATE_TABLE') {
      const trimmed = line.trim();
      if (trimmed.startsWith(')')) {
        tableColumns.set(createTableName, createCols);
        state = 'LINE_SEEK';
        createTableName = '';
        createCols = [];
        return;
      }
      if (trimmed.startsWith('`')) {
        const endTick = trimmed.indexOf('`', 1);
        if (endTick > 1) {
          createCols.push(trimmed.slice(1, endTick));
        }
      }
      return;
    }

    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('--') || trimmed.startsWith('/*')) return;

    const createMatch = trimmed.match(/^CREATE TABLE(?:\s+IF NOT EXISTS)?\s+`([^`]+)`/i);
    if (createMatch) {
      const tbl = createMatch[1];
      if (!seenTables.has(tbl)) {
        seenTables.add(tbl);
        data.tablesDefined += 1;
        if (isBackupTable(tbl)) {
          data.backupTablesSkipped.push(tbl);
        } else if (isZaloTable(tbl)) {
          data.zaloTablesSkipped.push(tbl);
        } else if (!IN_SCOPE_TABLES.has(tbl)) {
          data.outOfScopeTablesSkipped += 1;
        }
      }
      if (IN_SCOPE_TABLES.has(tbl) && !isBackupTable(tbl) && !isZaloTable(tbl)) {
        state = 'CREATE_TABLE';
        createTableName = tbl;
        createCols = [];
      }
    }
  };

  const consumeChunk = (chunk: string) => {
    let i = 0;
    const len = chunk.length;

    while (i < len) {
      if (state === 'LINE_SEEK' || state === 'CREATE_TABLE') {
        // Fast check for INSERT INTO `...` at start of a line when in LINE_SEEK
        if (state === 'LINE_SEEK' && lineBuf.length < 180) {
          const nlIdx = chunk.indexOf('\n', i);
          const segEnd = nlIdx === -1 ? len : nlIdx;
          const probeEnd = Math.min(segEnd, i + (180 - lineBuf.length));
          const probe = lineBuf + chunk.slice(i, probeEnd);
          const trimmedStart = probe.trimStart();

          if (trimmedStart.startsWith('INSERT INTO `') || trimmedStart.startsWith('INSERT IGNORE INTO `')) {
            const firstTick = probe.indexOf('`');
            const secondTick = firstTick >= 0 ? probe.indexOf('`', firstTick + 1) : -1;
            if (secondTick > firstTick) {
              const tbl = probe.slice(firstTick + 1, secondTick);
              // Advance i to right after secondTick
              const offsetInChunk = secondTick + 1 - lineBuf.length;
              lineBuf = '';
              i = i + Math.max(0, offsetInChunk);

              if (isBackupTable(tbl) || isZaloTable(tbl) || !IN_SCOPE_TABLES.has(tbl)) {
                state = 'SKIP_STMT';
                skipInString = false;
                skipEscaped = false;
                continue;
              } else {
                state = 'INSERT_HEADER';
                insertTableName = tbl;
                insertCols = tableColumns.get(tbl) || [];
                insertHeaderBuf = '';
                continue;
              }
            }
          }

          if (nlIdx === -1) {
            lineBuf += chunk.slice(i, len);
            return;
          }
          lineBuf += chunk.slice(i, nlIdx);
          processLineInSeekOrCreate(lineBuf);
          lineBuf = '';
          i = nlIdx + 1;
          continue;
        }

        const nlIdx = chunk.indexOf('\n', i);
        if (nlIdx === -1) {
          lineBuf += chunk.slice(i, len);
          return;
        }
        lineBuf += chunk.slice(i, nlIdx);
        processLineInSeekOrCreate(lineBuf);
        lineBuf = '';
        i = nlIdx + 1;
        continue;
      }

      if (state === 'SKIP_STMT') {
        // Tight zero-allocation loop skipping out-of-scope INSERT statements (up to 28.7MB)
        while (i < len) {
          const ch = chunk.charCodeAt(i);
          i++;
          if (skipInString) {
            if (skipEscaped) {
              skipEscaped = false;
            } else if (ch === 92 /* \ */) {
              skipEscaped = true;
            } else if (ch === 39 /* ' */) {
              skipInString = false;
            }
          } else {
            if (ch === 39 /* ' */) {
              skipInString = true;
            } else if (ch === 59 /* ; */) {
              state = 'LINE_SEEK';
              lineBuf = '';
              break;
            }
          }
        }
        continue;
      }

      if (state === 'INSERT_HEADER') {
        // Read until VALUES keyword followed by '(' or whitespace
        const takeEnd = Math.min(len, i + 4096);
        const startI = i;
        insertHeaderBuf += chunk.slice(i, takeEnd);
        const m = insertHeaderBuf.match(/^(?:\s*\(([^)]+)\))?\s*VALUES\s*/i);
        if (m) {
          if (m[1]) {
            insertCols = m[1]
              .split(',')
              .map((c) => c.trim().replace(/^`|`$/g, ''))
              .filter(Boolean);
          }
          const consumedFromBuf = m[0].length;
          const prevBufLen = insertHeaderBuf.length - (takeEnd - startI);
          i = startI + (consumedFromBuf - prevBufLen);
          insertHeaderBuf = '';
          state = 'INSERT_TUPLES';
          tState = 'EXPECT_TUPLE';
          currentRow = [];
          valParts = [];
          rawToken = '';
          continue;
        }
        i = takeEnd;
        if (insertHeaderBuf.length > 65536) {
          // Malformed header fallback
          state = 'SKIP_STMT';
          skipInString = false;
          skipEscaped = false;
          insertHeaderBuf = '';
        }
        continue;
      }

      // state === 'INSERT_TUPLES'
      while (i < len && state === 'INSERT_TUPLES') {
        const ch = chunk.charCodeAt(i);

        if (tState === 'EXPECT_TUPLE') {
          if (ch === 40 /* ( */) {
            currentRow = [];
            tState = 'EXPECT_VAL';
            i++;
          } else if (ch === 59 /* ; */) {
            i++;
            resetInsertState();
            break;
          } else {
            i++;
          }
          continue;
        }

        if (tState === 'EXPECT_VAL') {
          if (ch === 32 || ch === 9 || ch === 10 || ch === 13) {
            i++;
          } else if (ch === 39 /* ' */) {
            valParts = [];
            tState = 'IN_STRING';
            i++;
          } else if (ch === 41 /* ) */) {
            handleRow(insertTableName, insertCols, currentRow);
            currentRow = [];
            tState = 'AFTER_TUPLE';
            i++;
          } else {
            rawToken = '';
            tState = 'IN_RAW_TOKEN';
          }
          continue;
        }

        if (tState === 'IN_STRING') {
          const segStart = i;
          while (i < len) {
            const c = chunk.charCodeAt(i);
            if (c === 92 /* \ */) {
              if (i > segStart) valParts.push(chunk.slice(segStart, i));
              i++;
              tState = 'STRING_ESCAPE';
              break;
            }
            if (c === 39 /* ' */) {
              if (i > segStart) valParts.push(chunk.slice(segStart, i));
              i++;
              tState = 'STRING_AFTER_QUOTE';
              break;
            }
            if (c === 0 /* raw NUL byte */) {
              if (i > segStart) valParts.push(chunk.slice(segStart, i));
              i++;
              break;
            }
            i++;
          }
          if (tState === 'IN_STRING' && i > segStart) {
            valParts.push(chunk.slice(segStart, i));
          }
          continue;
        }

        if (tState === 'STRING_ESCAPE') {
          const esc = chunk.charAt(i);
          i++;
          if (esc === 'n') valParts.push('\n');
          else if (esc === 'r') valParts.push('\r');
          else if (esc === 't') valParts.push('\t');
          else if (esc === '0') {
            // Strip \x00 NUL bytes so PostgreSQL/PGlite UTF-8 TEXT/JSONB never rejects
          } else if (esc === 'Z') valParts.push('\x1a');
          else if (esc === 'b') valParts.push('\b');
          else valParts.push(esc);
          tState = 'IN_STRING';
          continue;
        }

        if (tState === 'STRING_AFTER_QUOTE') {
          if (ch === 39 /* doubled '' */) {
            valParts.push("'");
            i++;
            tState = 'IN_STRING';
          } else {
            const joined = valParts.length === 1 ? valParts[0] : valParts.join('');
            currentRow.push(joined);
            valParts = [];
            tState = 'AFTER_VAL';
            // Do not increment i; re-evaluate ch in AFTER_VAL
          }
          continue;
        }

        if (tState === 'IN_RAW_TOKEN') {
          const segStart = i;
          while (i < len) {
            const c = chunk.charCodeAt(i);
            if (c === 44 /* , */ || c === 41 /* ) */) {
              if (i > segStart) rawToken += chunk.slice(segStart, i);
              currentRow.push(parseRawToken(rawToken));
              rawToken = '';
              tState = 'AFTER_VAL';
              break;
            }
            i++;
          }
          if (tState === 'IN_RAW_TOKEN' && i > segStart) {
            rawToken += chunk.slice(segStart, i);
          }
          continue;
        }

        if (tState === 'AFTER_VAL') {
          if (ch === 44 /* , */) {
            tState = 'EXPECT_VAL';
            i++;
          } else if (ch === 41 /* ) */) {
            handleRow(insertTableName, insertCols, currentRow);
            currentRow = [];
            tState = 'AFTER_TUPLE';
            i++;
          } else {
            i++;
          }
          continue;
        }

        if (tState === 'AFTER_TUPLE') {
          if (ch === 44 /* , */) {
            tState = 'EXPECT_TUPLE';
            i++;
          } else if (ch === 59 /* ; */) {
            i++;
            resetInsertState();
            break;
          } else {
            i++;
          }
          continue;
        }
      }
    }
  };

  const decoder = new StringDecoder('utf8');
  await new Promise<void>((resolve, reject) => {
    const stream = fs.createReadStream(sqlPath, { highWaterMark: 1024 * 1024 });
    stream.on('data', (buf: Buffer | string) => {
      try {
        const text = typeof buf === 'string' ? buf : decoder.write(buf);
        if (text) consumeChunk(text);
      } catch (err) {
        stream.destroy();
        reject(err);
      }
    });
    stream.on('end', () => {
      try {
        const tail = decoder.end();
        if (tail) consumeChunk(tail);
        if (lineBuf.trim()) processLineInSeekOrCreate(lineBuf);
        resolve();
      } catch (err) {
        reject(err);
      }
    });
    stream.on('error', reject);
  });

  return data;
}

// ============================================================================
// Batched PostgreSQL Upsert Helper (Multi-VALUES + UNNEST)
// ============================================================================

async function batchExecValues(
  client: DbClient,
  table: string,
  columns: string[],
  rows: unknown[][],
  conflictClause: string,
  chunkSize = 300,
  colCasts?: Record<string, string>
): Promise<number> {
  if (rows.length === 0) return 0;
  const colList = columns.join(', ');
  let total = 0;

  // PG max bind params ~32767 (conservative cap at 12000 per query)
  const maxRowsByParams = Math.max(1, Math.floor(12000 / columns.length));
  const effChunk = Math.min(chunkSize, maxRowsByParams);

  for (let start = 0; start < rows.length; start += effChunk) {
    const slice = rows.slice(start, start + effChunk);
    const params: unknown[] = [];
    const valueTuples: string[] = [];
    let pIdx = 1;

    for (const row of slice) {
      const placeholders: string[] = [];
      for (let c = 0; c < columns.length; c++) {
        const cast = colCasts?.[columns[c]];
        placeholders.push(cast ? `$${pIdx}::${cast}` : `$${pIdx}`);
        params.push(row[c]);
        pIdx += 1;
      }
      valueTuples.push(`(${placeholders.join(',')})`);
    }

    const sql = `INSERT INTO ${table} (${colList}) VALUES ${valueTuples.join(',')} ${conflictClause}`;
    await client.query(sql, params);
    total += slice.length;
  }

  return total;
}

// ============================================================================
// Auxiliary Schema Guard (`capi_blocked_phones` + `leads.note`)
// ============================================================================

async function ensureAuxiliaryMigrationSchema(client: DbClient): Promise<void> {
  const stmts = [
    `CREATE TABLE IF NOT EXISTS capi_blocked_phones (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
      phone_normalized VARCHAR(40) NOT NULL,
      phone_hash VARCHAR(128) NOT NULL,
      reason TEXT,
      source VARCHAR(60) NOT NULL DEFAULT 'manual',
      matched_leads_count INTEGER NOT NULL DEFAULT 0,
      synced_to_meta BOOLEAN NOT NULL DEFAULT false,
      last_synced_at TIMESTAMPTZ,
      created_by UUID,
      created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
      CONSTRAINT uk_capi_blocked_tenant_id UNIQUE (tenant_id, id),
      CONSTRAINT uk_capi_blocked_phone UNIQUE (tenant_id, phone_normalized)
    )`,
    `CREATE INDEX IF NOT EXISTS idx_capi_blocked_sync
      ON capi_blocked_phones (tenant_id, synced_to_meta, created_at DESC)`,
    `ALTER TABLE capi_blocked_phones ENABLE ROW LEVEL SECURITY`,
    `ALTER TABLE capi_blocked_phones FORCE ROW LEVEL SECURITY`,
    `DROP POLICY IF EXISTS tenant_isolation_capi_blocked_phones ON capi_blocked_phones`,
    `CREATE POLICY tenant_isolation_capi_blocked_phones ON capi_blocked_phones
      USING (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid)
      WITH CHECK (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid)`,
    `ALTER TABLE leads ADD COLUMN IF NOT EXISTS note TEXT`,
  ];

  for (const s of stmts) {
    await client.query(s);
  }

  // Grant autodata_app permissions if role exists
  await client
    .query(
      `DO $$
       BEGIN
         IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'autodata_app') THEN
           GRANT SELECT, INSERT, UPDATE, DELETE ON capi_blocked_phones TO autodata_app;
         END IF;
       END $$;`
    )
    .catch(() => {});
}

// ============================================================================
// Core Migration Orchestrator
// ============================================================================

function resolveEffectiveSettings(parsed: ParsedDumpData) {
  const sys = (key: string): string => (parsed.systemSettings.get(key) || '').trim();
  const mkt = (key: string): string => (parsed.mktSystemSettings.get(key)?.value || '').trim();

  const smtpHost = mkt('smtp_host') || sys('ses_host') || 'email-smtp.ap-southeast-2.amazonaws.com';
  const smtpPort = Number(mkt('smtp_port') || sys('smtp_port') || 587) || 587;
  // Prefer newer smtp_user / ses_username over older smtp_username
  const smtpUser = mkt('smtp_user') || sys('ses_username') || mkt('smtp_username') || '';
  const smtpPass = mkt('smtp_pass') || sys('ses_password') || mkt('smtp_password') || '';

  // Reconcile region from smtpHost (email-smtp.ap-southeast-2.amazonaws.com -> ap-southeast-2)
  const hostRegionMatch = smtpHost.match(/email-smtp\.([a-z0-9-]+)\.amazonaws\.com/i);
  const sesRegion = hostRegionMatch?.[1] || sys('ses_region') || 'ap-southeast-2';

  // Never let empty system_settings.ses_access_key overwrite non-empty mkt_system_settings.aws_access_key
  const awsAccessKey = mkt('aws_access_key') || sys('ses_access_key') || '';
  const awsSecretKey = mkt('aws_secret_key') || sys('ses_secret_key') || '';

  const verifiedSenders = parsed.verifiedSenders.map((vs) => ({
    email: asTrimmed(vs.email).toLowerCase(),
    name: asTrimmed(vs.name) || 'IDEAS Admissions',
    reply_to: asTrimmed(vs.reply_to).toLowerCase() || asTrimmed(vs.email).toLowerCase(),
    is_verified: Boolean(Number(vs.is_verified ?? 1)),
    is_default: Boolean(Number(vs.is_default ?? 0)),
  }));

  const defaultSenderObj =
    verifiedSenders.find((v) => v.is_default && v.email) ||
    verifiedSenders.find((v) => v.email) ||
    null;

  const fromEmail =
    defaultSenderObj?.email ||
    mkt('smtp_from_email').split(',')[0]?.trim().toLowerCase() ||
    sys('ses_sender_email').toLowerCase() ||
    'tuyensinh@ideas.edu.vn';

  const rawFromName =
    defaultSenderObj?.name ||
    mkt('smtp_from_name') ||
    sys('ses_sender_name') ||
    'IDEAS';
  const fromName = /^ideas\s+myerp$/i.test(rawFromName.trim()) ? 'IDEAS' : rawFromName;

  const supportEmail =
    verifiedSenders.find((v) => v.email.startsWith('systemnoti@') || v.email.startsWith('cskh@'))?.email ||
    sys('ses_sender_email').toLowerCase() ||
    fromEmail;

  const metaAccessToken = sys('meta_access_token') || sys('meta_ads_access_token');
  const metaAdAccountId = normalizeAdAccountId(sys('meta_ad_account_id'));
  const metaPixelId = sys('meta_pixel_id') || '583807401361847';
  const metaWebPixelId = sys('meta_web_pixel_id') || '661260709828887';
  const capiDualEnabled = sys('capi_dual_pixel_enabled') === '1';

  const mktGeminiKey = mkt('gemini_api_key');
  const sysGeminiKey = sys('gemini_api_key');
  const primaryGeminiKey =
    (mktGeminiKey.startsWith('AIza') ? mktGeminiKey : '') ||
    (sysGeminiKey.startsWith('AIza') ? sysGeminiKey : '') ||
    mktGeminiKey ||
    sysGeminiKey ||
    '';

  const googleApiKey = mkt('google_api_key');
  const googleCloudApiKey = mkt('google_cloud_api_key');
  const groqApiKey = sys('groq_api_key');
  const groqModel = sys('groq_model') || 'qwen/qwen3.8-27b';
  const openrouterApiKey = sys('openrouter_api_key');
  const geminiModel = sys('gemini_model') || 'gemini-2.5-flash';
  const aiScreenerModel = sys('ai_screener_model') || 'gemini-2.5-flash-lite';

  const imapHost = mkt('imap_host');
  const imapPort = Number(mkt('imap_port') || 993) || 993;
  const imapUser = mkt('imap_user');
  const imapPass = mkt('imap_pass');

  return {
    smtpHost,
    smtpPort,
    smtpUser,
    smtpPass,
    sesRegion,
    awsAccessKey,
    awsSecretKey,
    verifiedSenders,
    fromEmail,
    fromName,
    supportEmail,
    metaAccessToken,
    metaAdAccountId,
    metaPixelId,
    metaWebPixelId,
    capiDualEnabled,
    primaryGeminiKey,
    sysGeminiKey,
    mktGeminiKey,
    googleApiKey,
    googleCloudApiKey,
    groqApiKey,
    groqModel,
    openrouterApiKey,
    geminiModel,
    aiScreenerModel,
    imapHost,
    imapPort,
    imapUser,
    imapPass,
    capiPhoneFarmAudienceId: sys('capi_phone_farm_audience_id'),
    capiQualityMinStage: sys('capi_quality_min_stage') || 'needed',
    capiSourceMode: sys('capi_source_mode') || 'all_quality',
    internalQaEmails: mkt('internal_qa_emails') || sys('qa_test_emails') || 'qa@ideas.edu.vn',
    fallbackCcEmail: sys('fallback_cc_email') || mkt('fallback_cc_email') || '',
  };
}

export async function migrateMyerpIdeas(options: MigrateMyerpIdeasOptions): Promise<MigrationSummary> {
  const startedAt = Date.now();
  const sqlPath = path.resolve(options.sqlPath);
  const tenantSlug = (options.tenantSlug || 'ideas').trim().toLowerCase();
  const dryRun = Boolean(options.dryRun);
  const publicOrigin = (options.publicUrl || DEFAULT_PUBLIC_URL).replace(/\/+$/, '');
  const crmOrigin = (options.crmUrl || DEFAULT_CRM_URL).replace(/\/+$/, '');

  // 1. Validate source SQL file exists BEFORE touching any DB
  if (!fs.existsSync(sqlPath)) {
    throw new Error(`SOURCE_SQL_NOT_FOUND: File does not exist at '${sqlPath}'`);
  }
  const stat = fs.statSync(sqlPath);
  if (!stat.isFile()) {
    throw new Error(`SOURCE_SQL_INVALID: Path is not a regular file '${sqlPath}'`);
  }

  // 2. Check PGlite postmaster.pid lockfile BEFORE opening DB (when not dry-run)
  const effectiveDataDir =
    !process.env.DATABASE_URL
      ? dryRun
        ? options.dataDir
          ? path.resolve(options.dataDir)
          : null
        : path.resolve(options.dataDir || process.env.PGLITE_DATA_DIR || APP_CONFIG.pgliteDataDir)
      : null;

  if (!dryRun && effectiveDataDir) {
    const pidFile = path.join(effectiveDataDir, 'postmaster.pid');
    if (fs.existsSync(pidFile)) {
      throw new Error(
        `REFUSED_PGLITE_LOCKED: Lockfile '${pidFile}' exists. Stop the running server before executing offline migration.`
      );
    }
  }

  // 3. Stream-parse the MariaDB SQL dump
  const parsed = await parseMyerpSqlDump(sqlPath, {
    skipWebAnalytics: options.skipWebAnalytics,
  });

  const rewriter = new LegacyUrlRewriter(publicOrigin, crmOrigin);
  const creds = resolveEffectiveSettings(parsed);

  // Pre-compute dry-run / live asset rewriting & orphan counts cleanly
  const targetMigratedCounts: Record<string, number> = {};
  const quarantined = {
    contacts_missing_phone_and_email: 0,
    leads_missing_phone_and_email: 0,
    subscribers_missing_phone_and_email: 0,
    orphan_distribution_logs: 0,
    orphan_data_reports: 0,
    orphan_send_claims: 0,
    orphan_capi_logs: 0,
  };

  // Build valid ID sets for parent-FK filtering
  const validFlowIds = new Set(parsed.flows.map((f) => asTrimmed(f.id)).filter(Boolean));
  const validFlowSnapshots = parsed.flowSnapshots.filter((s) => validFlowIds.has(asTrimmed(s.flow_id)));
  const orphanFlowSnapshotsDropped = parsed.flowSnapshots.length - validFlowSnapshots.length;

  const validShortLinkIds = new Set(parsed.shortLinks.map((s) => asTrimmed(s.id)).filter(Boolean));
  const validLinkClicks = parsed.linkClicks.filter((c) => validShortLinkIds.has(asTrimmed(c.short_link_id)));
  const orphanLinkClicksDropped = parsed.linkClicks.length - validLinkClicks.length;

  const validWebPropertyIds = new Set(parsed.webProperties.map((wp) => asTrimmed(wp.id)).filter(Boolean));
  const validWebSessions = parsed.webSessions.filter(
    (s) => s.workspace_id === 1 || (s.workspace_id === null && s.property_id !== null && validWebPropertyIds.has(s.property_id))
  );
  const validWebPageViews = parsed.webPageViews.filter(
    (p) => p.workspace_id === 1 || (p.workspace_id === null && p.property_id !== null && validWebPropertyIds.has(p.property_id))
  );

  // Count waiting flow states that will be gated to paused
  let waitingFlowStatesGated = 0;
  for (const sfs of parsed.subscriberFlowStates) {
    const st = (sfs.status || '').toLowerCase();
    if (st === 'waiting' || st === 'active' || st === 'pending') {
      waitingFlowStatesGated += 1;
    }
  }

  // Perform URL rewrite pre-pass (for manifest + dry-run accuracy + live DB writes)
  const ideasTenantRow = parsed.tenants[0] || null;
  const rewrittenLogoUrl = ideasTenantRow?.logo_url
    ? rewriter.rewriteString(asStr(ideasTenantRow.logo_url), 'url_field')
    : null;

  const rewrittenTemplates = parsed.templates.map((t) => {
    const rawBlocks = parseJsonSafe(t.blocks);
    const blocksObj = rawBlocks !== null ? rewriter.rewriteJsonValue(rawBlocks) : [];
    const rawBodyStyle = parseJsonSafe(t.body_style);
    const bodyStyleObj = rawBodyStyle !== null ? rewriter.rewriteJsonValue(rawBodyStyle) : {};
    const html = rewriter.rewriteString(asStr(t.html_content), 'html');
    const thumb = t.thumbnail ? rewriter.rewriteString(asStr(t.thumbnail), 'url_field') : null;
    return {
      row: t,
      blocks: blocksObj,
      bodyStyle: bodyStyleObj,
      html,
      thumbnail: thumb,
    };
  });

  const rewrittenEmailSections = parsed.emailSections.map((es) => {
    const parsedData = parseJsonSafe(es.data_json);
    return {
      row: es,
      data: parsedData !== null ? rewriter.rewriteJsonValue(parsedData) : {},
    };
  });

  const rewrittenGlobalAssets = parsed.globalAssets.map((ga) => ({
    row: ga,
    url: rewriter.rewriteString(asStr(ga.url), 'url_field'),
  }));

  const rewrittenCampaigns = parsed.campaigns.map((c) => {
    const rawAttachments = parseJsonSafe(c.attachments);
    const attachments = rawAttachments !== null ? rewriter.rewriteJsonValue(rawAttachments) : [];
    const rawConfig = parseJsonSafe(c.config);
    const config = rawConfig !== null ? rewriter.rewriteJsonValue(rawConfig) : {};
    const rawTarget = parseJsonSafe(c.target_config);
    const targetConfig = rawTarget !== null ? rewriter.rewriteJsonValue(rawTarget) : {};
    const contentBody = rewriter.rewriteString(asStr(c.content_body), 'html');
    const subject = rewriter.rewriteString(asStr(c.subject), 'html');
    return { row: c, attachments, config, targetConfig, contentBody, subject };
  });

  // Template ID mapping (for flow step template_id resolution)
  const templateIdMap = new Map<string, string>();
  for (const t of parsed.templates) {
    const legacyId = asTrimmed(t.id);
    if (legacyId) templateIdMap.set(legacyId, deterministicUuid(tenantSlug, 'templates', legacyId));
  }

  const mapFlowSteps = (raw: unknown): unknown => {
    const rewritten = rewriter.rewriteJsonValue(raw);
    if (Array.isArray(rewritten)) {
      return rewritten.map((step) => {
        if (step && typeof step === 'object') {
          const rec = { ...(step as Record<string, unknown>) };
          if (rec.config && typeof rec.config === 'object') {
            const cfg = { ...(rec.config as Record<string, unknown>) };
            const rawTplId =
              typeof cfg.template_id === 'string' && cfg.template_id.trim()
                ? cfg.template_id.trim()
                : typeof cfg.templateId === 'string' && cfg.templateId.trim()
                  ? cfg.templateId.trim()
                  : '';
            if (rawTplId && templateIdMap.has(rawTplId)) {
              const mappedTplUuid = templateIdMap.get(rawTplId)!;
              cfg.legacy_template_id = rawTplId;
              cfg.template_id = mappedTplUuid;
              cfg.templateId = mappedTplUuid;
            }
            rec.config = cfg;
          }
          return rec;
        }
        return step;
      });
    }
    return rewritten;
  };

  const rewrittenFlows = parsed.flows.map((f) => {
    const parsedSteps = parseJsonSafe(f.steps);
    const steps = parsedSteps !== null ? mapFlowSteps(parsedSteps) : [];
    const parsedConfig = parseJsonSafe(f.config);
    const config = parsedConfig !== null ? rewriter.rewriteJsonValue(parsedConfig) : {};
    return { row: f, steps, config };
  });

  const rewrittenFlowSnapshots = validFlowSnapshots.map((s) => {
    const parsedFlowData = parseJsonSafe(s.flow_data);
    const flowData = parsedFlowData !== null ? mapFlowSteps(parsedFlowData) : {};
    return { row: s, flowData };
  });

  const rewrittenShortLinks = parsed.shortLinks.map((sl) => {
    const targetUrl = rewriter.rewriteString(asStr(sl.target_url), 'url_field');
    const parsedQr = parseJsonSafe(sl.qr_config_json);
    const qrDesign = parsedQr !== null ? rewriter.rewriteJsonValue(parsedQr) : {};
    return { row: sl, targetUrl, qrDesign };
  });

  const rewrittenVoucherCampaigns = parsed.voucherCampaigns.map((vc) => ({
    row: vc,
    thumbnailUrl: vc.thumbnail_url ? rewriter.rewriteString(asStr(vc.thumbnail_url), 'url_field') : null,
  }));

  const rewrittenTrainingDocs = parsed.domationAiTrainingDocs.map((d) => {
    const parsedMeta = parseJsonSafe(d.metadata);
    const meta = parsedMeta !== null ? rewriter.rewriteJsonValue(parsedMeta) : {};
    return { row: d, meta };
  });

  // Determine vault presence flags (never exposing plaintext secrets!)
  const vaultIntegrations: Record<string, boolean> = {
    aws_ses: Boolean(creds.smtpUser || creds.awsAccessKey),
    facebook_ads: Boolean(creds.metaAdAccountId && creds.metaAccessToken),
    meta_capi: Boolean(creds.metaPixelId && creds.metaAccessToken),
    meta_messenger: parsed.metaAppConfigs.length > 0,
    dom_meta_report: Boolean(creds.metaAdAccountId || creds.primaryGeminiKey),
    ai_gemini_byok: Boolean(
      creds.primaryGeminiKey || creds.groqApiKey || creds.openrouterApiKey || creds.googleApiKey
    ),
    google_sheets: parsed.integrations.length > 0 || parsed.sheetConnections.length > 0,
    zalo_bot: false,
    zalo_oa: false,
    zalo_zns: false,
  };

  // Optional asset manifest export
  if (options.manifestOut) {
    const manifest: AssetManifest = {
      generated_at: new Date().toISOString(),
      source_sql: sqlPath,
      public_origin: publicOrigin,
      uploadss_files: Array.from(rewriter.uploadssAssets).sort(),
      template_thumbs_files: Array.from(rewriter.templateThumbs).sort(),
      ai_training_files: Array.from(rewriter.aiTrainingAssets).sort(),
      counts: {
        uploadss: rewriter.uploadssAssets.size,
        template_thumbs: rewriter.templateThumbs.size,
        ai_training: rewriter.aiTrainingAssets.size,
      },
    };
    const manifestPath = path.resolve(options.manifestOut);
    fs.mkdirSync(path.dirname(manifestPath), { recursive: true });
    fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), 'utf8');
  }

  // If dry-run, return full structured report WITHOUT touching target DB!
  if (dryRun) {
    return {
      success: true,
      dry_run: true,
      tenant_slug: tenantSlug,
      tenant_id: deterministicUuid(tenantSlug, 'tenants', 1),
      source_sql: sqlPath,
      data_dir: effectiveDataDir,
      duration_ms: Date.now() - startedAt,
      dump_stats: {
        file_size_bytes: parsed.fileSizeBytes,
        tables_defined: parsed.tablesDefined,
        backup_tables_skipped: parsed.backupTablesSkipped,
        zalo_tables_skipped: parsed.zaloTablesSkipped,
        out_of_scope_tables_skipped: parsed.outOfScopeTablesSkipped,
      },
      source_filtered_counts: parsed.filteredCounts,
      source_excluded_counts: parsed.excludedCounts,
      target_migrated_counts: {},
      safety_gates: {
        stale_mail_queue_pending_purged: parsed.mailQueuePending,
        mail_queue_total_skipped: parsed.mailQueueTotal,
        waiting_flow_states_gated_to_paused: waitingFlowStatesGated,
        orphan_flow_snapshots_dropped: orphanFlowSnapshotsDropped,
        orphan_link_clicks_dropped: orphanLinkClicksDropped,
        zalo_settings_keys_excluded: parsed.zaloSettingKeysExcluded,
        zalo_vault_integrations_present: 0,
        zalo_bot_disabled: true,
      },
      quarantined,
      vault_integrations: vaultIntegrations,
      url_rewrites: {
        total_rewritten: rewriter.rewriteCount,
        uploadss_assets_referenced: rewriter.uploadssAssets.size,
        template_thumbs_referenced: rewriter.templateThumbs.size,
        ai_training_assets_referenced: rewriter.aiTrainingAssets.size,
      },
    };
  }

  // ============================================================================
  // Live Database Execution (Isolated PGlite or PostgreSQL)
  // ============================================================================

  if (effectiveDataDir) {
    fs.mkdirSync(effectiveDataDir, { recursive: true });
    process.env.PGLITE_DATA_DIR = effectiveDataDir;
  }

  const pool = effectiveDataDir
    ? createDatabasePool({ inMemory: false, dataDir: effectiveDataDir })
    : createDatabasePool();
  setDatabasePool(pool);

  let tenantId = '';

  try {
    await runDatabaseMigrations({ seedSuperAdmin: true });

    await withSystemPrivilege(async (client) => {
      await ensureAuxiliaryMigrationSchema(client);
    });

    // ------------------------------------------------------------------------
    // F1: Provision / Refresh `ideas` Tenant on `growth_combo` + `education`
    // ------------------------------------------------------------------------
    const enabledModules = buildModulesForPackage('growth_combo', { educationAddon: true });
    const entitlementsPayload = {
      package_code: 'growth_combo',
      education_addon: true,
      enable_ideas_mascot: false,
      zero_migration_ready: true,
    };

    // Build sanitized non-secret, non-Zalo tenant settings
    const safeExtraSettings: Record<string, unknown> = {};
    for (const [k, v] of parsed.systemSettings.entries()) {
      const kl = k.toLowerCase();
      if (kl.startsWith(ZALO_SETTING_PREFIX) || SECRET_SETTING_KEYS.has(kl) || kl === 'web_properties') continue;
      if (kl === 'frontend_url') {
        safeExtraSettings[k] = crmOrigin;
      } else if (kl === 'tracking_endpoint_url') {
        safeExtraSettings[k] = `${publicOrigin}/api/v1/public/marketing/sdk.js`;
      } else {
        safeExtraSettings[k] = v;
      }
    }

    const tenantSettings = {
      ...DEFAULT_TENANT_SETTINGS,
      ...safeExtraSettings,
      brand_primary_color: asTrimmed(ideasTenantRow?.primary_color) || '#BD1D2D',
      brand_logo_url: rewrittenLogoUrl || undefined,
      timezone_name: asTrimmed(ideasTenantRow?.timezone) || 'Asia/Ho_Chi_Minh',
      email_provider: 'ses',
      ses_sender_email: creds.fromEmail,
      from_email: creds.fromEmail,
      support_email: creds.supportEmail,
      ses_sender_name: creds.fromName,
      verified_senders: creds.verifiedSenders,
      internal_qa_emails: creds.internalQaEmails,
      fallback_cc_email: creds.fallbackCcEmail,
      dual_capi_enabled: creds.capiDualEnabled,
      capi_phone_farm_audience_id: creds.capiPhoneFarmAudienceId,
      capi_quality_min_stage: creds.capiQualityMinStage,
      capi_source_mode: creds.capiSourceMode,
      frontend_url: crmOrigin,
      tracking_endpoint_url: `${publicOrigin}/api/v1/public/marketing/sdk.js`,
      // F8: Hard ZaloBot / Zalo OA Exclusion
      zalo_bot_disabled: true,
      zalo_bot_token: '',
      zalo_admin_group_chat_id: '',
      zalo_daily_report_enabled: false,
      zalo_notify_only_group: false,
      zalo_webhook_secret: '',
      daily_report_channels: {
        zalo: false,
        telegram: false,
        email: true,
        discord: false,
      },
    };

    const tenantName = asTrimmed(ideasTenantRow?.name) || 'IDEAS Institute';

    tenantId = await withSystemPrivilege(async (client) => {
      const existing = await client.query<{ id: string }>(
        `SELECT id FROM tenants WHERE slug = $1 LIMIT 1`,
        [tenantSlug]
      );
      const id = existing.rows[0]?.id || deterministicUuid(tenantSlug, 'tenants', 1);
      const obfSlug = `${tenantSlug}-edu-${id.slice(0, 8)}`;

      if (existing.rows.length === 0) {
        await client.query(
          `INSERT INTO tenants (
            id, slug, obfuscated_slug, name, industry, industry_key,
            package_code, plan_tier, subscription_plan_code, billing_cycle,
            enabled_modules, entitlements, status,
            trial_ends_at, subscription_expires_at, settings,
            created_at, updated_at
          ) VALUES (
            $1, $2, $3, $4, 'education', 'education',
            'growth_combo', 'growth_combo', 'autodata_growth', 'annual',
            $5::jsonb, $6::jsonb, 'active',
            clock_timestamp() + interval '30 days', clock_timestamp() + interval '365 days', $7::jsonb,
            $8::timestamptz, clock_timestamp()
          )`,
          [
            id,
            tenantSlug,
            obfSlug,
            tenantName,
            JSON.stringify(enabledModules),
            JSON.stringify(entitlementsPayload),
            JSON.stringify(tenantSettings),
            parseSqlTsOrNow(ideasTenantRow?.created_at),
          ]
        );
      } else {
        await client.query(
          `UPDATE tenants SET
            name = $2,
            industry = 'education',
            industry_key = 'education',
            package_code = 'growth_combo',
            plan_tier = 'growth_combo',
            subscription_plan_code = 'autodata_growth',
            billing_cycle = 'annual',
            enabled_modules = $3::jsonb,
            entitlements = $4::jsonb,
            status = 'active',
            subscription_expires_at = GREATEST(COALESCE(subscription_expires_at, clock_timestamp()), clock_timestamp() + interval '365 days'),
            settings = $5::jsonb,
            updated_at = clock_timestamp()
          WHERE id = $1`,
          [
            id,
            tenantName,
            JSON.stringify(enabledModules),
            JSON.stringify(entitlementsPayload),
            JSON.stringify(tenantSettings),
          ]
        );
      }
      return id;
    });
    targetMigratedCounts.tenants = 1;
    let aiTrainingPropertyStatsOut: Record<string, { queries_count: number }> = {};

    // ------------------------------------------------------------------------
    // F3: Users -> `global_accounts` (system) + `users` & `tenant_user_profiles`
    // ------------------------------------------------------------------------
    const fallbackRandomPassHash = await hashPassword(crypto.randomBytes(24).toString('hex'), 8);
    const userIdMap = new Map<string, string>();
    const userNameMap = new Map<string, string>();
    const globalAccountIdByEmail = new Map<string, string>();

    const normalizedUsers: Array<{
      legacyId: string;
      uuid: string;
      email: string;
      passwordHash: string;
      fullName: string;
      phone: string | null;
      role: string;
      isOwner: boolean;
      avatarUrl: string | null;
      lastLoginAt: string | null;
      createdAt: string;
      updatedAt: string;
      status: string;
      vacationMode: boolean;
    }> = [];

    const seenUserEmails = new Set<string>();
    let assignedOwner = false;

    for (const u of parsed.users) {
      const legacyId = asTrimmed(u.id);
      if (!legacyId) continue;

      let email = normalizeEmail(u.email) || `user.${legacyId}@${tenantSlug}.local`;
      if (seenUserEmails.has(email)) {
        const [localPart, domainPart] = email.split('@');
        email = `${localPart}+u${legacyId}@${domainPart || `${tenantSlug}.local`}`.slice(0, 255);
      }
      seenUserEmails.add(email);

      const rawRole = asTrimmed(u.role).toLowerCase();
      let role = 'sale';
      if (['admin', 'super_admin', 'tenant_admin', 'owner', 'director'].includes(rawRole)) {
        role = 'tenant_admin';
      } else if (['manager', 'team_lead', 'lead', 'supervisor'].includes(rawRole)) {
        role = 'manager';
      } else if (rawRole && rawRole !== 'sales' && rawRole !== 'consultant') {
        role = rawRole.slice(0, 50);
      }

      const isOwner = role === 'tenant_admin' && !assignedOwner;
      if (isOwner) assignedOwner = true;

      const rawHash = asTrimmed(u.password_hash);
      const passwordHash = /^\$2[aby]\$\d{2}\$/.test(rawHash)
        ? rawHash.replace(/^\$2y\$/, '$2b$')
        : fallbackRandomPassHash;

      const fullName = truncateStr(asTrimmed(u.full_name) || asTrimmed(u.username) || email.split('@')[0], 150);
      const isActive = Number(u.is_active ?? 1) === 1 && !u.deleted_at;
      const rawStatus = asTrimmed(u.status).toLowerCase();
      const profileStatus = !isActive
        ? 'inactive'
        : ['active', 'inactive', 'suspended', 'terminated'].includes(rawStatus)
          ? rawStatus
          : 'active';

      const uuid = deterministicUuid(tenantSlug, 'users', legacyId);
      userIdMap.set(legacyId, uuid);
      userNameMap.set(uuid, fullName);

      normalizedUsers.push({
        legacyId,
        uuid,
        email,
        passwordHash,
        fullName,
        phone: normalizePhoneDisplay(u.phone),
        role,
        isOwner,
        avatarUrl: sanitizeMigratedAvatarUrl(
          u.avatar_url ? rewriter.rewriteString(asStr(u.avatar_url), 'url_field') : null
        ),
        lastLoginAt: parseSqlTs(u.last_login_at),
        createdAt: parseSqlTsOrNow(u.created_at),
        updatedAt: parseSqlTsOrNow(u.updated_at),
        status: profileStatus,
        vacationMode: Boolean(Number(u.vacation_mode ?? 0)),
      });
    }

    // Ensure at least one tenant admin exists if dump had none
    if (normalizedUsers.length > 0 && !assignedOwner) {
      normalizedUsers[0].isOwner = true;
      normalizedUsers[0].role = 'tenant_admin';
    }

    // Upsert global_accounts without overwriting existing sibling-tenant credentials
    await withSystemPrivilege(async (client) => {
      for (const nu of normalizedUsers) {
        await client.query(
          `INSERT INTO global_accounts (id, email, password_hash, full_name, phone, is_active, last_login_at, created_at, updated_at)
           VALUES ($1, $2, $3, $4, $5, true, $6::timestamptz, $7::timestamptz, $8::timestamptz)
           ON CONFLICT (email) DO NOTHING`,
          [
            deterministicUuid('global_accounts', 'email', nu.email),
            nu.email,
            nu.passwordHash,
            nu.fullName,
            nu.phone,
            nu.lastLoginAt,
            nu.createdAt,
            nu.updatedAt,
          ]
        );
        const found = await client.query<{ id: string }>(
          `SELECT id FROM global_accounts WHERE LOWER(email) = $1 LIMIT 1`,
          [nu.email]
        );
        if (found.rows[0]?.id) {
          globalAccountIdByEmail.set(nu.email, found.rows[0].id);
        }
      }
    });

    const defaultAdminUserId =
      normalizedUsers.find((u) => u.isOwner)?.uuid || normalizedUsers[0]?.uuid || null;

    // ------------------------------------------------------------------------
    // All Tenant-Scoped Migrations inside `withTenantTransaction` (FORCE RLS)
    // ------------------------------------------------------------------------
    await withTenantTransaction(tenantId, async (client) => {
      // Onboarding progress
      await client.query(
        `INSERT INTO tenant_onboarding_progress (
          tenant_id, current_step, completed_steps, is_completed, dismissed_at, screen_tours
        ) VALUES ($1, 4, '[1,2,3,4]'::jsonb, true, clock_timestamp(), '{}'::jsonb)
        ON CONFLICT (tenant_id) DO UPDATE SET
          current_step = 4, completed_steps = '[1,2,3,4]'::jsonb, is_completed = true`,
        [tenantId]
      );

      // Users & profiles (check existing tenant users by email to avoid uk_users_tenant_email clash)
      const existingUsersRes = await client.query<{ id: string; email: string }>(
        `SELECT id, LOWER(email) AS email FROM users WHERE tenant_id = $1`,
        [tenantId]
      );
      const existingUserByEmail = new Map(existingUsersRes.rows.map((r) => [r.email, r.id]));

      const userRowsToInsert: unknown[][] = [];
      const profileRowsToInsert: unknown[][] = [];

      for (const nu of normalizedUsers) {
        const effectiveUuid = existingUserByEmail.get(nu.email) || nu.uuid;
        userIdMap.set(nu.legacyId, effectiveUuid);
        userNameMap.set(effectiveUuid, nu.fullName);
        const accountId = globalAccountIdByEmail.get(nu.email) || null;

        userRowsToInsert.push([
          effectiveUuid,
          accountId,
          tenantId,
          nu.email,
          nu.passwordHash,
          nu.fullName,
          nu.phone,
          nu.role,
          nu.isOwner,
          nu.avatarUrl,
          nu.lastLoginAt,
          nu.createdAt,
          nu.updatedAt,
        ]);

        profileRowsToInsert.push([
          deterministicUuid(tenantSlug, 'tenant_user_profiles', nu.legacyId),
          tenantId,
          effectiveUuid,
          nu.status,
          nu.status === 'active' && !nu.vacationMode,
          nu.vacationMode,
          null, // F8: zalo_chat_id explicitly NULL
          null, // F8: zalo_user_id explicitly NULL
          nu.createdAt,
          nu.updatedAt,
        ]);
      }

      targetMigratedCounts.users = await batchExecValues(
        client,
        'users',
        [
          'id',
          'account_id',
          'tenant_id',
          'email',
          'password_hash',
          'full_name',
          'phone',
          'role',
          'is_tenant_owner',
          'avatar_url',
          'last_login_at',
          'created_at',
          'updated_at',
        ],
        userRowsToInsert,
        `ON CONFLICT (id) DO UPDATE SET
          account_id = EXCLUDED.account_id,
          full_name = EXCLUDED.full_name,
          phone = EXCLUDED.phone,
          role = EXCLUDED.role,
          is_tenant_owner = EXCLUDED.is_tenant_owner,
          avatar_url = EXCLUDED.avatar_url,
          updated_at = clock_timestamp()`
      );

      targetMigratedCounts.tenant_user_profiles = await batchExecValues(
        client,
        'tenant_user_profiles',
        [
          'id',
          'tenant_id',
          'user_id',
          'status',
          'is_available',
          'vacation_mode',
          'zalo_chat_id',
          'zalo_user_id',
          'created_at',
          'updated_at',
        ],
        profileRowsToInsert,
        `ON CONFLICT (tenant_id, user_id) DO UPDATE SET
          status = EXCLUDED.status,
          is_available = EXCLUDED.is_available,
          vacation_mode = EXCLUDED.vacation_mode,
          zalo_chat_id = NULL,
          zalo_user_id = NULL,
          updated_at = clock_timestamp()`
      );

      // ----------------------------------------------------------------------
      // F3: Default Pipeline & Pipeline Stages
      // ----------------------------------------------------------------------
      const defaultPipelineId = deterministicUuid(tenantSlug, 'tenant_pipelines', 'default');
      await client.query(
        `INSERT INTO tenant_pipelines (id, tenant_id, name, description, is_default)
         VALUES ($1, $2, $3, $4, true)
         ON CONFLICT (id) DO UPDATE SET
           name = EXCLUDED.name, description = EXCLUDED.description, is_default = true, updated_at = clock_timestamp()`,
        [defaultPipelineId, tenantId, 'IDEAS Admissions Pipeline', 'Migrated from MYERP IDEAS CRM']
      );
      targetMigratedCounts.tenant_pipelines = 1;

      const stageIdMap = new Map<string, string>();
      const seenStageKeys = new Set<string>();
      const stageRows: unknown[][] = [];

      const sortedStages = [...parsed.pipelineStages].sort(
        (a, b) => toInt(a.order_index, 0) - toInt(b.order_index, 0)
      );

      sortedStages.forEach((s, idx) => {
        const legacyId = asTrimmed(s.id);
        if (!legacyId) return;
        const stageUuid = deterministicUuid(tenantSlug, 'pipeline_stages', legacyId);
        stageIdMap.set(legacyId, stageUuid);

        let stageKey = slugify(asTrimmed(s.system_slug) || asTrimmed(s.name), `stage_${legacyId}`, 55);
        if (seenStageKeys.has(stageKey)) {
          stageKey = `${stageKey.slice(0, 48)}_${legacyId}`.slice(0, 63);
        }
        seenStageKeys.add(stageKey);

        const isWon = Boolean(Number(s.is_won ?? 0));
        const isLost = Boolean(Number(s.is_lost ?? 0));
        const capiEvent = isWon
          ? 'Purchase'
          : /qualif|need|hot|consult|demo/.test(stageKey)
            ? 'Lead'
            : 'Skip';

        stageRows.push([
          stageUuid,
          tenantId,
          defaultPipelineId,
          stageKey,
          truncateStr(asTrimmed(s.name) || `Stage ${idx + 1}`, 150),
          toInt(s.order_index, idx),
          truncateStr(asTrimmed(s.color) || '#1E40FF', 20),
          isWon,
          isLost,
          capiEvent,
          null, // F8: zalo_notify_template_id NULL
          parseSqlTsOrNow(s.created_at),
        ]);
      });

      targetMigratedCounts.tenant_pipeline_stages = await batchExecValues(
        client,
        'tenant_pipeline_stages',
        [
          'id',
          'tenant_id',
          'pipeline_id',
          'stage_key',
          'stage_name',
          'stage_order',
          'color_hex',
          'is_won_stage',
          'is_lost_stage',
          'capi_event_mapping',
          'zalo_notify_template_id',
          'created_at',
        ],
        stageRows,
        `ON CONFLICT (id) DO UPDATE SET
          stage_key = EXCLUDED.stage_key,
          stage_name = EXCLUDED.stage_name,
          stage_order = EXCLUDED.stage_order,
          color_hex = EXCLUDED.color_hex,
          is_won_stage = EXCLUDED.is_won_stage,
          is_lost_stage = EXCLUDED.is_lost_stage,
          capi_event_mapping = EXCLUDED.capi_event_mapping,
          zalo_notify_template_id = NULL,
          updated_at = clock_timestamp()`
      );

      // ----------------------------------------------------------------------
      // F3: Distribution Rounds, Round Consultants, Sheet Connections, Routing Rules
      // ----------------------------------------------------------------------
      const roundIdMap = new Map<string, string>();
      const roundRows: unknown[][] = [];

      parsed.distributionRounds.forEach((r, idx) => {
        const legacyId = asTrimmed(r.id);
        if (!legacyId) return;
        const uuid = deterministicUuid(tenantSlug, 'distribution_rounds', legacyId);
        roundIdMap.set(legacyId, uuid);
        const lastCons = r.last_assigned_consultant_id
          ? userIdMap.get(asTrimmed(r.last_assigned_consultant_id)) || null
          : null;

        roundRows.push([
          uuid,
          tenantId,
          defaultPipelineId,
          truncateStr(asTrimmed(r.round_name) || `Round ${legacyId}`, 150),
          asNullableStr(r.description),
          asNullableStr(r.cc_emails),
          lastCons,
          idx + 1,
          Boolean(Number(r.is_active ?? 1)),
        ]);
      });

      targetMigratedCounts.distribution_rounds = await batchExecValues(
        client,
        'distribution_rounds',
        [
          'id',
          'tenant_id',
          'pipeline_id',
          'name',
          'description',
          'cc_emails',
          'last_assigned_consultant_id',
          'priority',
          'is_active',
        ],
        roundRows,
        `ON CONFLICT (id) DO UPDATE SET
          name = EXCLUDED.name,
          description = EXCLUDED.description,
          cc_emails = EXCLUDED.cc_emails,
          last_assigned_consultant_id = EXCLUDED.last_assigned_consultant_id,
          is_active = EXCLUDED.is_active,
          updated_at = clock_timestamp()`
      );

      const rcMap = new Map<string, unknown[]>();
      for (const rc of parsed.roundConsultants) {
        const rUuid = roundIdMap.get(asTrimmed(rc.round_id));
        const uUuid = userIdMap.get(asTrimmed(rc.consultant_id));
        if (!rUuid || !uUuid) continue;
        const key = `${rUuid}:${uUuid}`;
        rcMap.set(key, [
          deterministicUuid(tenantSlug, 'round_consultants', `${rc.round_id}:${rc.consultant_id}`),
          tenantId,
          rUuid,
          uUuid,
          Boolean(Number(rc.is_active ?? 1)),
          Math.max(1, toInt(rc.receive_ratio, 1)),
          Math.max(1, toInt(rc.data_per_turn, 1)),
          Math.max(0, toInt(rc.current_turn_remaining, 0)),
          Math.max(0, toInt(rc.compensation_count, 0)),
          Math.max(0, toInt(rc.skip_count, 0)),
          Math.max(0, toInt(rc.skipped_credit, 0)),
        ]);
      }

      targetMigratedCounts.round_consultants = await batchExecValues(
        client,
        'round_consultants',
        [
          'id',
          'tenant_id',
          'round_id',
          'user_id',
          'is_active',
          'receive_ratio',
          'data_per_turn',
          'current_turn_remaining',
          'compensation_count',
          'skip_count',
          'skipped_credit',
        ],
        Array.from(rcMap.values()),
        `ON CONFLICT (tenant_id, round_id, user_id) DO UPDATE SET
          is_active = EXCLUDED.is_active,
          receive_ratio = EXCLUDED.receive_ratio,
          data_per_turn = EXCLUDED.data_per_turn,
          current_turn_remaining = EXCLUDED.current_turn_remaining,
          compensation_count = EXCLUDED.compensation_count,
          skip_count = EXCLUDED.skip_count,
          skipped_credit = EXCLUDED.skipped_credit,
          updated_at = clock_timestamp()`
      );

      // Sheet connections + field mappings -> tenant_webhooks
      const fieldMappingsByConn = new Map<string, Array<Record<string, unknown>>>();
      for (const fm of parsed.fieldMappings) {
        const cid = asTrimmed(fm.connection_id);
        if (!cid) continue;
        const arr = fieldMappingsByConn.get(cid) || [];
        arr.push({
          id: fm.id,
          sheet_column: asTrimmed(fm.sheet_column),
          system_field: asTrimmed(fm.system_field),
          custom_label: asNullableStr(fm.custom_label),
        });
        fieldMappingsByConn.set(cid, arr);
      }

      const webhookIdMap = new Map<string, string>();
      const seenWebhookTokens = new Set<string>();
      const webhookRows: unknown[][] = [];

      for (const sc of parsed.sheetConnections) {
        const legacyId = asTrimmed(sc.id);
        if (!legacyId) continue;
        const uuid = deterministicUuid(tenantSlug, 'sheet_connections', legacyId);
        webhookIdMap.set(legacyId, uuid);

        let token = asTrimmed(sc.webhook_token) || `whk_${tenantSlug}_sc_${legacyId}`;
        if (seenWebhookTokens.has(token)) {
          token = `${token.slice(0, 100)}_${legacyId}`;
        }
        token = token.slice(0, 128);
        seenWebhookTokens.add(token);

        const mappingsList = fieldMappingsByConn.get(legacyId) || [];
        const fieldMapObj: Record<string, unknown> = {
          _legacy_connection_id: legacyId,
          _spreadsheet_id: asNullableStr(sc.spreadsheet_id),
          _connection_type: asNullableStr(sc.connection_type),
          _sync_mode: asNullableStr(sc.sync_mode),
          _sync_interval: toInt(sc.sync_interval, 5),
          _two_way_sync: Boolean(Number(sc.two_way_sync ?? 0)),
          _lead_recall_minutes: toInt(sc.lead_recall_minutes, 0),
          _sync_records_count: parsed.sheetSyncCounts.get(legacyId) || 0,
          _mappings: mappingsList,
        };
        for (const m of mappingsList) {
          if (typeof m.sheet_column === 'string' && m.sheet_column && typeof m.system_field === 'string') {
            fieldMapObj[m.sheet_column] = m.system_field;
          }
        }

        const signingSecret = `whsec_${sha256Hex(`${tenantSlug}:webhook:${legacyId}`).slice(0, 48)}`;
        webhookRows.push([
          uuid,
          tenantId,
          truncateStr(asTrimmed(sc.sheet_name) || `Sheet Connection #${legacyId}`, 150),
          'inbound',
          asNullableStr(sc.google_script_url),
          token,
          signingSecret,
          JSON.stringify(fieldMapObj),
          '[]',
          Boolean(Number(sc.is_active ?? 1)),
          parseSqlTsOrNow(sc.created_at),
        ]);
      }

      targetMigratedCounts.tenant_webhooks = await batchExecValues(
        client,
        'tenant_webhooks',
        [
          'id',
          'tenant_id',
          'name',
          'webhook_type',
          'url',
          'token',
          'signing_secret',
          'field_mappings',
          'subscribed_events',
          'is_active',
          'created_at',
        ],
        webhookRows,
        `ON CONFLICT (id) DO UPDATE SET
          name = EXCLUDED.name,
          url = EXCLUDED.url,
          field_mappings = EXCLUDED.field_mappings,
          is_active = EXCLUDED.is_active,
          updated_at = clock_timestamp()`,
        100,
        { field_mappings: 'jsonb', subscribed_events: 'jsonb' }
      );

      // Routing rules
      const ruleRows: unknown[][] = [];
      for (const rr of parsed.routingRules) {
        const legacyId = asTrimmed(rr.id);
        const rUuid = roundIdMap.get(asTrimmed(rr.target_round_id));
        if (!legacyId || !rUuid) continue;

        const parsedConds = parseJsonSafe<unknown[]>(rr.conditions_json);
        const condCol = asTrimmed(rr.condition_column);
        const condOp = asTrimmed(rr.condition_operator) || 'equals';
        const condVal = asStr(rr.condition_value);
        const flatConditions = condCol
          ? [{ field: condCol, op: condOp, val: condVal }]
          : [];
        const branches = Array.isArray(parsedConds) ? parsedConds : [];

        const rawConnCsv = asTrimmed(rr.connection_id);
        const connScopes = rawConnCsv
          ? rawConnCsv
              .split(',')
              .map((x) => x.trim())
              .filter(Boolean)
              .map((x) => webhookIdMap.get(x) || x)
          : ['all'];

        const ruleName = truncateStr(
          condCol ? `Rule #${legacyId}: ${condCol} ${condOp} ${condVal}`.trim() : `Routing Rule #${legacyId}`,
          150
        );

        ruleRows.push([
          deterministicUuid(tenantSlug, 'routing_rules', legacyId),
          tenantId,
          rUuid,
          ruleName,
          toInt(rr.priority, 1),
          JSON.stringify(flatConditions),
          JSON.stringify(branches),
          JSON.stringify(connScopes),
          '{}',
          true,
        ]);
      }

      targetMigratedCounts.routing_rules = await batchExecValues(
        client,
        'routing_rules',
        [
          'id',
          'tenant_id',
          'round_id',
          'rule_name',
          'priority',
          'conditions_json',
          'condition_branches',
          'connection_scopes',
          'inject_fields',
          'is_active',
        ],
        ruleRows,
        `ON CONFLICT (id) DO UPDATE SET
          round_id = EXCLUDED.round_id,
          rule_name = EXCLUDED.rule_name,
          priority = EXCLUDED.priority,
          conditions_json = EXCLUDED.conditions_json,
          condition_branches = EXCLUDED.condition_branches,
          connection_scopes = EXCLUDED.connection_scopes,
          updated_at = clock_timestamp()`,
        100,
        {
          conditions_json: 'jsonb',
          condition_branches: 'jsonb',
          connection_scopes: 'jsonb',
          inject_fields: 'jsonb',
        }
      );

      // ----------------------------------------------------------------------
      // F3: B2B Companies (`tenant_b2b_companies`)
      // ----------------------------------------------------------------------
      const companyIdMap = new Map<string, string>();
      const seenCompanyCodes = new Set<string>();
      const companyRows: unknown[][] = [];

      for (const co of parsed.companies) {
        const legacyId = asTrimmed(co.id);
        if (!legacyId) continue;
        const uuid = deterministicUuid(tenantSlug, 'companies', legacyId);
        companyIdMap.set(legacyId, uuid);

        let code = truncateStr(asTrimmed(co.erp_code) || `IDEAS-CO-${legacyId}`, 50);
        if (seenCompanyCodes.has(code)) {
          code = `IDEAS-CO-${legacyId}`.slice(0, 50);
        }
        seenCompanyCodes.add(code);

        const rawTier = asTrimmed(co.tier).toLowerCase();
        const tier = ['standard', 'silver', 'gold', 'enterprise'].includes(rawTier) ? rawTier : 'standard';

        companyRows.push([
          uuid,
          tenantId,
          code,
          truncateStr(asTrimmed(co.name) || `Company #${legacyId}`, 255),
          asNullableStr(co.tax_id, 50),
          asNullableStr(co.industry, 100),
          asNullableStr(co.size, 50),
          asNullableStr(co.website, 255),
          asNullableStr(co.address),
          normalizePhoneDisplay(co.phone),
          normalizeEmail(co.email),
          asNullableStr(co.legal_representative, 150),
          co.owner_id ? userIdMap.get(asTrimmed(co.owner_id)) || null : null,
          tier,
          asNullableStr(co.notes),
          parseSqlTsOrNow(co.created_at),
          parseSqlTsOrNow(co.updated_at),
        ]);
      }

      targetMigratedCounts.tenant_b2b_companies = await batchExecValues(
        client,
        'tenant_b2b_companies',
        [
          'id',
          'tenant_id',
          'code',
          'name',
          'tax_code',
          'industry',
          'company_size',
          'website',
          'billing_address',
          'phone',
          'email',
          'representative_name',
          'owner_user_id',
          'tier',
          'notes',
          'created_at',
          'updated_at',
        ],
        companyRows,
        `ON CONFLICT (id) DO UPDATE SET
          name = EXCLUDED.name,
          tax_code = EXCLUDED.tax_code,
          phone = EXCLUDED.phone,
          email = EXCLUDED.email,
          updated_at = clock_timestamp()`
      );

      // ----------------------------------------------------------------------
      // F3 + F4 + F6: Unified Master Contact 360° (`leads`) + `mkt_suppression_list`
      // ----------------------------------------------------------------------
      const metaAttrByContactId = new Map<string, RowObj>();
      for (const attr of parsed.contactMetaAttribution) {
        const cid = asTrimmed(attr.contact_id);
        if (!cid) continue;
        if (!metaAttrByContactId.has(cid)) {
          metaAttrByContactId.set(cid, attr);
        }
      }

      // Pre-index subscribers by id so contact fallback lookup works if contact lacks phone/email
      const subById = new Map<string, RowObj>();
      for (const sub of parsed.subscribers) {
        const sid = asTrimmed(sub.id);
        if (sid) subById.set(sid, sub);
      }

      interface UnifiedLeadRecord {
        id: string;
        pipeline_id: string | null;
        stage_id: string | null;
        assigned_to: string | null;
        round_id: string | null;
        connection_id: string | null;
        status: string;
        lifecycle_stage: string;
        name: string;
        phone: string | null;
        email: string | null;
        lead_score: number;
        email_consent: string;
        total_revenue_vnd: number;
        last_engaged_at: string | null;
        source: string;
        campaign: string | null;
        product_interest: string | null;
        budget_range: string | null;
        utm_source: string | null;
        utm_medium: string | null;
        utm_content: string | null;
        ad_id: string | null;
        adset_id: string | null;
        campaign_id: string | null;
        form_id: string | null;
        meta_lead_id: string | null;
        fbc: string | null;
        fbp: string | null;
        company_id: string | null;
        job_title: string | null;
        address: string | null;
        note: string | null;
        custom_fields: Record<string, unknown>;
        is_accepted: boolean;
        accepted_at: string | null;
        is_deleted: boolean;
        ai_screener_status: string;
        ai_evaluation: string | null;
        ai_prompt_tokens: number;
        ai_completion_tokens: number;
        email_notify_status: string;
        created_at: string;
        updated_at: string;
      }

      const unifiedById = new Map<string, UnifiedLeadRecord>();
      const contactIdToUuid = new Map<string, string>();
      const legacyLeadIdToUuid = new Map<string, string>();
      const subIdToUuid = new Map<string, string>();
      const personIdToUuid = new Map<string, string>();
      const phoneKeyToUuid = new Map<string, string>();
      const emailToUuid = new Map<string, string>();
      const suppressionMap = new Map<string, { recipient: string; reason: string }>();

      const registerIndices = (
        rec: UnifiedLeadRecord,
        opts?: { personId?: string | null; phoneKeys?: Array<string | null> }
      ) => {
        if (opts?.personId && !personIdToUuid.has(opts.personId)) {
          personIdToUuid.set(opts.personId, rec.id);
        }
        if (rec.email && !emailToUuid.has(rec.email)) {
          emailToUuid.set(rec.email, rec.id);
        }
        const pk = normalizePhoneKey(rec.phone);
        if (pk && !phoneKeyToUuid.has(pk)) {
          phoneKeyToUuid.set(pk, rec.id);
        }
        if (opts?.phoneKeys) {
          for (const extra of opts.phoneKeys) {
            if (extra && !phoneKeyToUuid.has(extra)) phoneKeyToUuid.set(extra, rec.id);
          }
        }
      };

      const addSuppression = (email: string | null, reason: string) => {
        if (!email) return;
        const normReason = reason === 'spam' ? 'complained' : reason;
        if (!suppressionMap.has(email) || normReason === 'bounced' || normReason === 'complained') {
          suppressionMap.set(email, { recipient: email, reason: normReason });
        }
      };

      const mapLifecycle = (rawStatus: string, rawPipeStatus: string): string => {
        const s = `${rawStatus} ${rawPipeStatus}`.toLowerCase();
        if (s.includes('customer') || s.includes('student') || s.includes('enrolled') || s.includes('won')) {
          return 'customer';
        }
        if (s.includes('opportun')) return 'opportunity';
        if (s.includes('sql') || s.includes('qualif')) return 'sql';
        if (s.includes('mql')) return 'mql';
        if (s.includes('disqualif') || s.includes('lost') || s.includes('invalid')) return 'disqualified';
        if (s.includes('subscrib')) return 'subscriber';
        return 'lead';
      };

      const mapConsent = (raw: string): string => {
        const s = raw.toLowerCase();
        if (s === 'unsubscribed') return 'unsubscribed';
        if (s === 'bounced' || s === 'hard_bounce') return 'bounced';
        if (s === 'complained' || s === 'spam') return 'complained';
        return 'subscribed';
      };

      // Pass A: Seed from `contacts` (tenant_id = 1)
      for (const c of parsed.contacts) {
        const legacyId = asTrimmed(c.id);
        if (!legacyId) continue;

        const person = c.person_id ? parsed.persons.get(asTrimmed(c.person_id)) : undefined;
        const linkedSub = c.domation_subscriber_id ? subById.get(asTrimmed(c.domation_subscriber_id)) : undefined;

        const phone =
          normalizePhoneDisplay(c.phone) ||
          normalizePhoneDisplay(c.mobile) ||
          normalizePhoneDisplay(c.phone2) ||
          normalizePhoneDisplay(person?.phone) ||
          normalizePhoneDisplay(linkedSub?.phone || linkedSub?.phone_number);

        const email =
          normalizeEmail(c.email) ||
          normalizeEmail(person?.email) ||
          normalizeEmail(linkedSub?.email || linkedSub?.email_norm);

        if (!phone && !email) {
          quarantined.contacts_missing_phone_and_email += 1;
          continue;
        }

        const uuid = deterministicUuid(tenantSlug, 'contacts', legacyId);
        const assignedTo = c.owner_id ? userIdMap.get(asTrimmed(c.owner_id)) || null : null;
        const stageId = c.stage_id ? stageIdMap.get(asTrimmed(c.stage_id)) || null : null;
        const isDeleted = Boolean(c.deleted_at);
        const attr = metaAttrByContactId.get(legacyId);

        const mktStatus = asTrimmed(c.marketing_status);
        const emailConsent = mapConsent(mktStatus);
        if (emailConsent !== 'subscribed') {
          addSuppression(email, emailConsent);
        }

        const resolvedFormName = asNullableStr(c.form_name || attr?.form_name);
        const resolvedMetaFormName = asNullableStr(c.meta_form_name || attr?.form_name || c.form_name);
        const customFields: Record<string, unknown> = {
          legacy_contact_id: legacyId,
          ...(c.program ? { program: asTrimmed(c.program) } : {}),
          ...(c.intake ? { intake: asTrimmed(c.intake) } : {}),
          ...(c.major ? { major: asTrimmed(c.major) } : {}),
          ...(c.student_id ? { student_id: asTrimmed(c.student_id) } : {}),
          ...(c.study_status ? { study_status: asTrimmed(c.study_status) } : {}),
          ...(c.temperature ? { temperature: asTrimmed(c.temperature) } : {}),
          ...(c.city ? { city: asTrimmed(c.city) } : {}),
          ...(c.district ? { district: asTrimmed(c.district) } : {}),
          ...(c.ward ? { ward: asTrimmed(c.ward) } : {}),
          ...(resolvedFormName ? { form_name: resolvedFormName } : {}),
          ...(resolvedMetaFormName ? { meta_form_name: resolvedMetaFormName } : {}),
          ...(c.notes ? { notes: asStr(c.notes) } : {}),
          ...(c.tags ? { legacy_tags: parseJsonSafe(c.tags) ?? asStr(c.tags) } : {}),
          ...(attr
            ? {
                meta_attribution: {
                  meta_lead_id: asNullableStr(attr.meta_lead_id),
                  ad_id: asNullableStr(attr.ad_id),
                  ad_name: asNullableStr(attr.ad_name),
                  adset_id: asNullableStr(attr.adset_id),
                  adset_name: asNullableStr(attr.adset_name),
                  campaign_id: asNullableStr(attr.campaign_id),
                  campaign_name: asNullableStr(attr.campaign_name),
                  form_id: asNullableStr(attr.form_id),
                  form_name: asNullableStr(attr.form_name),
                  fb_pixel_id: asNullableStr(attr.fb_pixel_id),
                  degree: asNullableStr(attr.degree),
                  english_work_exp: asNullableStr(attr.english_work_exp),
                  consultation_time: asNullableStr(attr.consultation_time),
                  program_interest: asNullableStr(attr.program_interest),
                },
              }
            : {}),
        };

        const rec: UnifiedLeadRecord = {
          id: uuid,
          pipeline_id: defaultPipelineId,
          stage_id: stageId,
          assigned_to: assignedTo,
          round_id: null,
          connection_id: null,
          status: isDeleted ? 'archived' : assignedTo ? 'assigned' : 'unassigned_pending',
          lifecycle_stage: mapLifecycle(asTrimmed(c.status), asTrimmed(c.pipeline_status)),
          name: truncateStr(
            asTrimmed(c.full_name) || asTrimmed(person?.full_name) || email || phone || `Contact #${legacyId}`,
            150
          ),
          phone,
          email,
          lead_score: toInt(c.lead_score, 0),
          email_consent: emailConsent,
          total_revenue_vnd: toBigIntNum(c.total_spent, 0),
          last_engaged_at:
            parseSqlTs(c.last_email_click_at) ||
            parseSqlTs(c.last_email_open_at) ||
            parseSqlTs(c.last_web_visit_at) ||
            parseSqlTs(c.last_contact),
          source: truncateStr(asTrimmed(c.source) || 'MYERP CRM', 100),
          campaign: asNullableStr(attr?.campaign_name || c.meta_campaign_name || c.utm_campaign, 150),
          product_interest: asNullableStr(c.program || attr?.program_interest || c.major, 255),
          budget_range: asNullableStr(c.budget_range || c.budget, 120),
          utm_source: asNullableStr(c.platform || c.meta_platform || attr?.platform, 100),
          utm_medium: asNullableStr(c.utm_medium, 100),
          utm_content: asNullableStr(c.utm_content, 150),
          ad_id: asNullableStr(attr?.ad_id || c.meta_ad_id, 100),
          adset_id: asNullableStr(attr?.adset_id || c.meta_adset_id, 100),
          campaign_id: asNullableStr(attr?.campaign_id || c.meta_campaign_id || c.campaign_id, 100),
          form_id: asNullableStr(attr?.form_id || c.meta_form_id || resolvedFormName, 100),
          meta_lead_id: asNullableStr(attr?.meta_lead_id || c.meta_lead_id, 100),
          fbc: asNullableStr(attr?.fbc, 255),
          fbp: asNullableStr(attr?.fbp, 255),
          company_id: c.company_id ? companyIdMap.get(asTrimmed(c.company_id)) || null : null,
          job_title: asNullableStr(c.job_title, 150),
          address: asNullableStr(c.address),
          note: asNullableStr(c.notes),
          custom_fields: customFields,
          is_accepted: Boolean(assignedTo),
          accepted_at: parseSqlTs(c.assigned_at),
          is_deleted: isDeleted,
          ai_screener_status: 'not_screened',
          ai_evaluation: null,
          ai_prompt_tokens: 0,
          ai_completion_tokens: 0,
          email_notify_status: 'none',
          created_at: parseSqlTsOrNow(c.created_at),
          updated_at: parseSqlTsOrNow(c.updated_at),
        };

        unifiedById.set(uuid, rec);
        contactIdToUuid.set(legacyId, uuid);
        if (c.domation_subscriber_id) {
          subIdToUuid.set(asTrimmed(c.domation_subscriber_id), uuid);
        }
        registerIndices(rec, {
          personId: asNullableStr(c.person_id),
          phoneKeys: [normalizePhoneKey(c.mobile), normalizePhoneKey(c.phone2)],
        });
      }

      // Pass B: Merge MYERP `leads` (attach distribution/AI/note fields, create unmatched)
      for (const l of parsed.leads) {
        const legacyId = asTrimmed(l.id);
        if (!legacyId) continue;

        // Exclude pollution rows referencing 99999 users
        if (l.assigned_to && parsed.excluded99999UserIds.has(asTrimmed(l.assigned_to))) {
          incCounter(parsed.excludedCounts, 'leads_99999');
          continue;
        }

        const lEmail = normalizeEmail(l.email);
        const lPhone = normalizePhoneDisplay(l.phone) || normalizePhoneDisplay(l.phone2);
        const lPhoneKey = normalizePhoneKey(l.phone) || normalizePhoneKey(l.phone2);
        const lPersonId = asNullableStr(l.person_id);

        // Match priority: person_id -> phone -> email
        let matchedUuid: string | undefined;
        if (lPersonId) matchedUuid = personIdToUuid.get(lPersonId);
        if (!matchedUuid && lPhoneKey) matchedUuid = phoneKeyToUuid.get(lPhoneKey);
        if (!matchedUuid && lEmail) matchedUuid = emailToUuid.get(lEmail);

        const roundUuid = l.target_round_id ? roundIdMap.get(asTrimmed(l.target_round_id)) || null : null;
        const connUuid = l.connection_id ? webhookIdMap.get(asTrimmed(l.connection_id)) || null : null;
        const assignedUuid = l.assigned_to ? userIdMap.get(asTrimmed(l.assigned_to)) || null : null;
        const leadNote = l.note !== null && l.note !== undefined && String(l.note).length > 0 ? String(l.note) : null;

        if (matchedUuid) {
          const rec = unifiedById.get(matchedUuid)!;
          legacyLeadIdToUuid.set(legacyId, rec.id);
          if (roundUuid) rec.round_id = roundUuid;
          if (connUuid) rec.connection_id = connUuid;
          if (!rec.assigned_to && assignedUuid) rec.assigned_to = assignedUuid;
          if (Number(l.is_accepted) === 1) {
            rec.is_accepted = true;
            rec.accepted_at = rec.accepted_at || parseSqlTs(l.accepted_at);
          }
          if (l.ai_screener_status) rec.ai_screener_status = truncateStr(asTrimmed(l.ai_screener_status), 40);
          if (l.ai_evaluation) rec.ai_evaluation = asStr(l.ai_evaluation);
          rec.ai_prompt_tokens = Math.max(rec.ai_prompt_tokens, toInt(l.ai_prompt_tokens, 0));
          rec.ai_completion_tokens = Math.max(rec.ai_completion_tokens, toInt(l.ai_completion_tokens, 0));
          if (l.email_notify_status) rec.email_notify_status = truncateStr(asTrimmed(l.email_notify_status), 40);
          if (!rec.campaign && l.campaign_name) rec.campaign = truncateStr(asTrimmed(l.campaign_name), 150);
          if (!rec.ad_id && l.ad_id) rec.ad_id = truncateStr(asTrimmed(l.ad_id), 100);
          if (!rec.campaign_id && l.campaign_id) rec.campaign_id = truncateStr(asTrimmed(l.campaign_id), 100);
          if (leadNote) {
            rec.note = rec.note ? `${rec.note}\n${leadNote}` : leadNote;
            rec.custom_fields.note = rec.note;
          }
          rec.custom_fields.legacy_lead_id = legacyId;
          continue;
        }

        // Unmatched lead -> create new unified lead record
        if (!lPhone && !lEmail) {
          quarantined.leads_missing_phone_and_email += 1;
          continue;
        }
        // Skip if strictly belongs to 99999 pollution email/phone
        if (
          (lEmail && parsed.excluded99999Emails.has(lEmail)) ||
          (lPhoneKey && parsed.excluded99999Phones.has(lPhoneKey))
        ) {
          incCounter(parsed.excludedCounts, 'leads_99999');
          continue;
        }

        const uuid = deterministicUuid(tenantSlug, 'leads', legacyId);
        const rawLeadStatus = asTrimmed(l.status).toLowerCase();
        const mappedStatus =
          rawLeadStatus === 'rejected'
            ? 'rejected'
            : rawLeadStatus === 'blacklisted'
              ? 'blacklisted'
              : assignedUuid
                ? 'assigned'
                : 'unassigned_pending';

        const rec: UnifiedLeadRecord = {
          id: uuid,
          pipeline_id: defaultPipelineId,
          stage_id: null,
          assigned_to: assignedUuid,
          round_id: roundUuid,
          connection_id: connUuid,
          status: mappedStatus,
          lifecycle_stage: mappedStatus === 'rejected' || mappedStatus === 'blacklisted' ? 'disqualified' : 'lead',
          name: truncateStr(asTrimmed(l.full_name) || asTrimmed(l.name) || lEmail || lPhone || `Lead #${legacyId}`, 150),
          phone: lPhone,
          email: lEmail,
          lead_score: 0,
          email_consent: 'subscribed',
          total_revenue_vnd: 0,
          last_engaged_at: parseSqlTs(l.last_interaction_date),
          source: truncateStr(asTrimmed(l.source) || 'MYERP Lead', 100),
          campaign: asNullableStr(l.campaign_name || l.utm_campaign, 150),
          product_interest: asNullableStr(l.program, 255),
          budget_range: asNullableStr(l.budget, 120),
          utm_source: asNullableStr(l.platform, 100),
          utm_medium: asNullableStr(l.utm_medium, 100),
          utm_content: asNullableStr(l.utm_content, 150),
          ad_id: asNullableStr(l.ad_id, 100),
          adset_id: null,
          campaign_id: asNullableStr(l.campaign_id, 100),
          form_id: null,
          meta_lead_id: null,
          fbc: null,
          fbp: null,
          company_id: null,
          job_title: null,
          address: null,
          note: leadNote,
          custom_fields: {
            legacy_lead_id: legacyId,
            ...(leadNote ? { note: leadNote } : {}),
            ...(l.program ? { program: asTrimmed(l.program) } : {}),
          },
          is_accepted: Boolean(Number(l.is_accepted ?? 0)),
          accepted_at: parseSqlTs(l.accepted_at),
          is_deleted: Boolean(l.deleted_at),
          ai_screener_status: truncateStr(asTrimmed(l.ai_screener_status) || 'not_screened', 40),
          ai_evaluation: asNullableStr(l.ai_evaluation),
          ai_prompt_tokens: toInt(l.ai_prompt_tokens, 0),
          ai_completion_tokens: toInt(l.ai_completion_tokens, 0),
          email_notify_status: truncateStr(asTrimmed(l.email_notify_status) || 'none', 40),
          created_at: parseSqlTsOrNow(l.created_at),
          updated_at: parseSqlTsOrNow(l.last_interaction_date || l.created_at),
        };

        unifiedById.set(uuid, rec);
        legacyLeadIdToUuid.set(legacyId, uuid);
        registerIndices(rec, { personId: lPersonId });
      }

      // Pass C: Merge MYERP `subscribers` (workspace_id = 1) + suppression extraction
      for (const sub of parsed.subscribers) {
        const legacySubId = asTrimmed(sub.id);
        if (!legacySubId) continue;

        const subEmail = normalizeEmail(sub.email || sub.email_norm);
        const subPhone = normalizePhoneDisplay(sub.phone || sub.phone_number || sub.phone_norm9);
        const subPhoneKey = normalizePhoneKey(sub.phone || sub.phone_number || sub.phone_norm9);
        const subStatus = asTrimmed(sub.status).toLowerCase();
        const subConsent = mapConsent(subStatus);

        // Always record unsubscribed/bounced/complained emails in mkt_suppression_list
        if (subConsent !== 'subscribed' && subEmail) {
          addSuppression(subEmail, subConsent);
        }

        // Resolve to existing unified contact/lead (deduplicates outlier multi-subscriber contact_ids!)
        let matchedUuid: string | undefined;
        if (sub.contact_id !== null && sub.contact_id !== undefined && String(sub.contact_id).trim() !== '') {
          matchedUuid = contactIdToUuid.get(asTrimmed(sub.contact_id));
        }
        if (!matchedUuid && subIdToUuid.has(legacySubId)) {
          matchedUuid = subIdToUuid.get(legacySubId);
        }
        if (!matchedUuid && sub.person_id) {
          matchedUuid = personIdToUuid.get(asTrimmed(sub.person_id));
        }
        if (!matchedUuid && subEmail) {
          matchedUuid = emailToUuid.get(subEmail);
        }
        if (!matchedUuid && subPhoneKey) {
          matchedUuid = phoneKeyToUuid.get(subPhoneKey);
        }

        const rawSubAttrs = parseJsonSafe<Record<string, unknown>>(sub.custom_attributes);
        const subAttrs = rawSubAttrs ? sanitizeMigratedAvatarObject(rawSubAttrs) : null;
        const cleanSubAvatar = sanitizeMigratedAvatarUrl(
          (subAttrs?.avatar ?? subAttrs?.avatar_url ?? sub.avatar ?? sub.avatar_url) as SqlCell
        );
        if (subAttrs && !cleanSubAvatar) {
          delete subAttrs.avatar;
          delete subAttrs.avatar_url;
          delete subAttrs.profile_pic;
        }
        const subMetaFormName = asNullableStr(
          (subAttrs?.meta_form_name ?? subAttrs?.form_name) as SqlCell
        );
        const subMetaFormId = asNullableStr(
          (subAttrs?.meta_form_id ?? subAttrs?.form_id) as SqlCell,
          100
        );
        const subMetaCampaignName = asNullableStr(subAttrs?.meta_campaign_name as SqlCell, 150);

        if (matchedUuid) {
          const rec = unifiedById.get(matchedUuid)!;
          rec.custom_fields = sanitizeMigratedAvatarObject(rec.custom_fields);
          subIdToUuid.set(legacySubId, rec.id);
          if (subConsent !== 'subscribed') {
            rec.email_consent = subConsent;
          }
          rec.lead_score = Math.max(rec.lead_score, toInt(sub.lead_score, 0));
          const subEngaged =
            parseSqlTs(sub.last_click_at) || parseSqlTs(sub.last_open_at) || parseSqlTs(sub.last_activity_at);
          if (subEngaged && (!rec.last_engaged_at || subEngaged > rec.last_engaged_at)) {
            rec.last_engaged_at = subEngaged;
          }
          if (!rec.email && subEmail) {
            rec.email = subEmail;
            emailToUuid.set(subEmail, rec.id);
          }
          if (!rec.phone && subPhone) {
            rec.phone = subPhone;
            if (subPhoneKey) phoneKeyToUuid.set(subPhoneKey, rec.id);
          }
          if (subMetaFormName) {
            if (!rec.custom_fields.meta_form_name) rec.custom_fields.meta_form_name = subMetaFormName;
            if (!rec.custom_fields.form_name) rec.custom_fields.form_name = subMetaFormName;
          }
          if (!rec.form_id && (subMetaFormId || subMetaFormName)) {
            rec.form_id = subMetaFormId || truncateStr(subMetaFormName || '', 100);
          }
          if (!rec.campaign && subMetaCampaignName) {
            rec.campaign = subMetaCampaignName;
          }
          continue;
        }

        // Marketing-only subscriber -> create unified lead row with status='marketing_nurture'
        if (!subPhone && !subEmail) {
          quarantined.subscribers_missing_phone_and_email += 1;
          continue;
        }

        const uuid = deterministicUuid(tenantSlug, 'subscribers', legacySubId);
        const fullName = truncateStr(
          [asTrimmed(sub.last_name), asTrimmed(sub.first_name)].filter(Boolean).join(' ') ||
            subEmail ||
            subPhone ||
            `Subscriber ${legacySubId}`,
          150
        );

        const rec: UnifiedLeadRecord = {
          id: uuid,
          pipeline_id: defaultPipelineId,
          stage_id: sub.stage_id ? stageIdMap.get(asTrimmed(sub.stage_id)) || null : null,
          assigned_to: sub.owner_id ? userIdMap.get(asTrimmed(sub.owner_id)) || null : null,
          round_id: null,
          connection_id: null,
          status: sub.deleted_at || subStatus === 'archived' ? 'archived' : 'marketing_nurture',
          lifecycle_stage: subStatus === 'customer' ? 'customer' : subStatus === 'lead' ? 'lead' : 'subscriber',
          name: fullName,
          phone: subPhone,
          email: subEmail,
          lead_score: toInt(sub.lead_score, 0),
          email_consent: subConsent,
          total_revenue_vnd: 0,
          last_engaged_at:
            parseSqlTs(sub.last_click_at) || parseSqlTs(sub.last_open_at) || parseSqlTs(sub.last_activity_at),
          source: truncateStr(asTrimmed(sub.source) || 'Marketing Subscriber', 100),
          campaign: subMetaCampaignName,
          product_interest: asNullableStr(sub.program, 255),
          budget_range: null,
          utm_source: asNullableStr(subAttrs?.platform as SqlCell, 100),
          utm_medium: null,
          utm_content: null,
          ad_id: asNullableStr(subAttrs?.meta_ad_id as SqlCell, 100),
          adset_id: asNullableStr(subAttrs?.meta_adset_id as SqlCell, 100),
          campaign_id: asNullableStr(subAttrs?.meta_campaign_id as SqlCell, 100),
          form_id: subMetaFormId || (subMetaFormName ? truncateStr(subMetaFormName, 100) : null),
          meta_lead_id: asNullableStr(subAttrs?.meta_lead_id as SqlCell, 100),
          fbc: null,
          fbp: null,
          company_id: null,
          job_title: asNullableStr(sub.job_title, 150),
          address: asNullableStr(sub.address),
          note: asNullableStr(sub.notes),
          custom_fields: {
            legacy_subscriber_id: legacySubId,
            ...(sub.program ? { program: asTrimmed(sub.program) } : {}),
            ...(sub.temperature ? { temperature: asTrimmed(sub.temperature) } : {}),
            ...(sub.meta_psid ? { meta_psid: asTrimmed(sub.meta_psid) } : {}),
            ...(subMetaFormName ? { form_name: subMetaFormName, meta_form_name: subMetaFormName } : {}),
            ...(subAttrs ? { custom_attributes: subAttrs } : {}),
          },
          is_accepted: false,
          accepted_at: null,
          is_deleted: Boolean(sub.deleted_at),
          ai_screener_status: 'not_screened',
          ai_evaluation: null,
          ai_prompt_tokens: 0,
          ai_completion_tokens: 0,
          email_notify_status: 'none',
          created_at: parseSqlTsOrNow(sub.created_at || sub.joined_at),
          updated_at: parseSqlTsOrNow(sub.updated_at || sub.created_at),
        };

        unifiedById.set(uuid, rec);
        subIdToUuid.set(legacySubId, uuid);
        registerIndices(rec, { personId: asNullableStr(sub.person_id) });
      }

      // Batch insert unified `leads`
      const leadInsertRows: unknown[][] = [];
      for (const r of unifiedById.values()) {
        leadInsertRows.push([
          r.id,
          tenantId,
          r.pipeline_id,
          r.stage_id,
          r.assigned_to,
          r.round_id,
          r.connection_id,
          r.status,
          r.lifecycle_stage,
          r.name,
          r.phone,
          r.email,
          r.lead_score,
          r.email_consent,
          'opted_out', // F8: zns_consent disabled
          r.total_revenue_vnd,
          r.last_engaged_at,
          r.source,
          r.campaign,
          r.product_interest,
          r.budget_range,
          r.utm_source,
          r.utm_medium,
          r.utm_content,
          r.ad_id,
          r.adset_id,
          r.campaign_id,
          r.form_id,
          r.meta_lead_id,
          r.fbc,
          r.fbp,
          r.company_id,
          r.job_title,
          r.address,
          r.note,
          JSON.stringify(r.custom_fields),
          r.is_accepted,
          r.accepted_at,
          r.is_deleted,
          r.ai_screener_status,
          r.ai_evaluation,
          r.ai_prompt_tokens,
          r.ai_completion_tokens,
          'none', // F8: zalo_notify_status='none'
          r.email_notify_status,
          r.created_at,
          r.updated_at,
        ]);
      }

      targetMigratedCounts.leads = await batchExecValues(
        client,
        'leads',
        [
          'id',
          'tenant_id',
          'pipeline_id',
          'stage_id',
          'assigned_to',
          'round_id',
          'connection_id',
          'status',
          'lifecycle_stage',
          'name',
          'phone',
          'email',
          'lead_score',
          'email_consent',
          'zns_consent',
          'total_revenue_vnd',
          'last_engaged_at',
          'source',
          'campaign',
          'product_interest',
          'budget_range',
          'utm_source',
          'utm_medium',
          'utm_content',
          'ad_id',
          'adset_id',
          'campaign_id',
          'form_id',
          'meta_lead_id',
          'fbc',
          'fbp',
          'company_id',
          'job_title',
          'address',
          'note',
          'custom_fields',
          'is_accepted',
          'accepted_at',
          'is_deleted',
          'ai_screener_status',
          'ai_evaluation',
          'ai_prompt_tokens',
          'ai_completion_tokens',
          'zalo_notify_status',
          'email_notify_status',
          'created_at',
          'updated_at',
        ],
        leadInsertRows,
        `ON CONFLICT (id) DO UPDATE SET
          pipeline_id = EXCLUDED.pipeline_id,
          stage_id = EXCLUDED.stage_id,
          assigned_to = EXCLUDED.assigned_to,
          round_id = EXCLUDED.round_id,
          connection_id = EXCLUDED.connection_id,
          status = EXCLUDED.status,
          lifecycle_stage = EXCLUDED.lifecycle_stage,
          name = EXCLUDED.name,
          phone = EXCLUDED.phone,
          email = EXCLUDED.email,
          lead_score = EXCLUDED.lead_score,
          email_consent = EXCLUDED.email_consent,
          zns_consent = 'opted_out',
          source = EXCLUDED.source,
          campaign = EXCLUDED.campaign,
          product_interest = EXCLUDED.product_interest,
          ad_id = EXCLUDED.ad_id,
          adset_id = EXCLUDED.adset_id,
          campaign_id = EXCLUDED.campaign_id,
          form_id = EXCLUDED.form_id,
          meta_lead_id = EXCLUDED.meta_lead_id,
          fbc = EXCLUDED.fbc,
          fbp = EXCLUDED.fbp,
          note = EXCLUDED.note,
          custom_fields = EXCLUDED.custom_fields,
          is_accepted = EXCLUDED.is_accepted,
          accepted_at = EXCLUDED.accepted_at,
          is_deleted = EXCLUDED.is_deleted,
          zalo_notify_status = 'none',
          updated_at = clock_timestamp()`,
        250,
        { custom_fields: 'jsonb' }
      );

      // Batch insert `mkt_suppression_list`
      const suppressionRows: unknown[][] = [];
      for (const s of suppressionMap.values()) {
        suppressionRows.push([
          deterministicUuid(tenantSlug, 'mkt_suppression_list', `email:${s.recipient}`),
          tenantId,
          'email',
          s.recipient,
          truncateStr(s.reason, 50),
        ]);
      }

      targetMigratedCounts.mkt_suppression_list = await batchExecValues(
        client,
        'mkt_suppression_list',
        ['id', 'tenant_id', 'channel', 'recipient', 'reason'],
        suppressionRows,
        `ON CONFLICT (tenant_id, channel, recipient) DO UPDATE SET reason = EXCLUDED.reason`,
        500
      );

      // ----------------------------------------------------------------------
      // F3 + F4: Tags (`tenant_tags` + `lead_tags`), Lists/Segments (`tenant_audiences` + members)
      // ----------------------------------------------------------------------
      const tagSlugToUuid = new Map<string, string>();
      const domationTagIdToUuid = new Map<string, string>();
      const tagRowsMap = new Map<string, unknown[]>();

      for (const tg of parsed.tags) {
        const name = truncateStr(asTrimmed(tg.name), 100);
        if (!name) continue;
        const slug = slugify(name, `tag_${tg.id}`, 100);
        if (!tagSlugToUuid.has(slug)) {
          const uuid = deterministicUuid(tenantSlug, 'tenant_tags', slug);
          tagSlugToUuid.set(slug, uuid);
          tagRowsMap.set(slug, [
            uuid,
            tenantId,
            name,
            slug,
            truncateStr(asTrimmed(tg.color) || '#1E40FF', 20),
            truncateStr(asTrimmed(tg.entity_type) || 'crm', 50),
            null,
            parseSqlTsOrNow(tg.created_at),
          ]);
        }
      }
      for (const dt of parsed.domationTags) {
        const legacyId = asTrimmed(dt.id);
        const name = truncateStr(asTrimmed(dt.name), 100);
        if (!name) continue;
        const slug = slugify(name, `dtag_${legacyId}`, 100);
        let uuid = tagSlugToUuid.get(slug);
        if (!uuid) {
          uuid = deterministicUuid(tenantSlug, 'tenant_tags', slug);
          tagSlugToUuid.set(slug, uuid);
          tagRowsMap.set(slug, [
            uuid,
            tenantId,
            name,
            slug,
            truncateStr(asTrimmed(dt.color) || '#1E40FF', 20),
            'marketing',
            asNullableStr(dt.description),
            parseSqlTsOrNow(dt.created_at),
          ]);
        }
        if (legacyId) domationTagIdToUuid.set(legacyId, uuid);
      }

      targetMigratedCounts.tenant_tags = await batchExecValues(
        client,
        'tenant_tags',
        ['id', 'tenant_id', 'name', 'slug', 'color_hex', 'category', 'description', 'created_at'],
        Array.from(tagRowsMap.values()),
        `ON CONFLICT (tenant_id, slug) DO UPDATE SET name = EXCLUDED.name, color_hex = EXCLUDED.color_hex, updated_at = clock_timestamp()`
      );

      // Re-resolve actual tag UUIDs by slug (in case pre-existing tags had different UUIDs)
      if (tagRowsMap.size > 0) {
        const existingTags = await client.query<{ id: string; slug: string }>(
          `SELECT id, slug FROM tenant_tags WHERE tenant_id = $1`,
          [tenantId]
        );
        for (const r of existingTags.rows) {
          tagSlugToUuid.set(r.slug, r.id);
        }
        for (const dt of parsed.domationTags) {
          const legacyId = asTrimmed(dt.id);
          const slug = slugify(asTrimmed(dt.name), `dtag_${legacyId}`, 100);
          const actual = tagSlugToUuid.get(slug);
          if (legacyId && actual) domationTagIdToUuid.set(legacyId, actual);
        }
      }

      const leadTagSet = new Map<string, unknown[]>();
      for (const st of parsed.subscriberTags) {
        const leadUuid = subIdToUuid.get(st.subscriber_id);
        const tagUuid = domationTagIdToUuid.get(st.tag_id);
        if (!leadUuid || !tagUuid) continue;
        const key = `${leadUuid}:${tagUuid}`;
        if (!leadTagSet.has(key)) {
          leadTagSet.set(key, [
            deterministicUuid(tenantSlug, 'lead_tags', key),
            tenantId,
            leadUuid,
            tagUuid,
          ]);
        }
      }
      targetMigratedCounts.lead_tags = await batchExecValues(
        client,
        'lead_tags',
        ['id', 'tenant_id', 'lead_id', 'tag_id'],
        Array.from(leadTagSet.values()),
        `ON CONFLICT (tenant_id, lead_id, tag_id) DO NOTHING`,
        500
      );

      // Lists & Segments -> `tenant_audiences`
      const listIdMap = new Map<string, string>();
      const audienceRows: unknown[][] = [];

      for (const l of parsed.lists) {
        const legacyId = asTrimmed(l.id);
        if (legacyId) listIdMap.set(legacyId, deterministicUuid(tenantSlug, 'lists', legacyId));
      }
      for (const seg of parsed.segments) {
        const legacyId = asTrimmed(seg.id);
        if (legacyId) listIdMap.set(legacyId, deterministicUuid(tenantSlug, 'segments', legacyId));
      }

      const remapSegmentRuleValue = (rawField: string, rawVal: unknown): unknown => {
        const fieldLower = rawField.trim().toLowerCase();
        const resolveSingle = (val: unknown): unknown => {
          if (val === null || val === undefined) return val;
          const s = String(val).trim();
          if (!s) return val;
          if (fieldLower === 'crm_stage_id' || fieldLower === 'crm_stage_is' || fieldLower === 'stage_id') {
            return stageIdMap.get(s) || val;
          }
          if (fieldLower === 'crm_owner_id' || fieldLower === 'crm_assigned_to' || fieldLower === 'assigned_to') {
            return userIdMap.get(s) || val;
          }
          if (fieldLower === 'in_audience' || fieldLower === 'audience_id' || fieldLower === 'list') {
            return listIdMap.get(s) || val;
          }
          if (fieldLower === 'tag_id' || fieldLower === 'has_tag_id') {
            return domationTagIdToUuid.get(s) || val;
          }
          return val;
        };
        if (Array.isArray(rawVal)) {
          return rawVal.map(resolveSingle);
        }
        if (typeof rawVal === 'string' && rawVal.includes(',')) {
          return rawVal
            .split(',')
            .map((part) => String(resolveSingle(part.trim())))
            .join(',');
        }
        return resolveSingle(rawVal);
      };

      const remapSegmentFilters = (node: unknown): unknown => {
        if (Array.isArray(node)) {
          return node.map(remapSegmentFilters);
        }
        if (node && typeof node === 'object') {
          const obj = { ...(node as Record<string, unknown>) };
          if (!obj.join && typeof obj.logic === 'string') {
            obj.join = obj.logic.toUpperCase() === 'OR' ? 'OR' : 'AND';
          }
          if (Array.isArray(obj.conditions)) {
            obj.conditions = obj.conditions.map(remapSegmentFilters);
          }
          if (Array.isArray(obj.rules)) {
            obj.rules = obj.rules.map(remapSegmentFilters);
          }
          if (Array.isArray(obj.groups)) {
            obj.groups = obj.groups.map(remapSegmentFilters);
          }
          if (Array.isArray(obj.branches)) {
            obj.branches = obj.branches.map(remapSegmentFilters);
          }
          if (typeof obj.field === 'string' && obj.field.trim()) {
            const rawVal = obj.val !== undefined ? obj.val : obj.value;
            const mappedVal = remapSegmentRuleValue(obj.field, rawVal);
            if (mappedVal !== rawVal) {
              obj.legacy_value = rawVal;
              if (obj.value !== undefined) obj.value = mappedVal;
              if (obj.val !== undefined) obj.val = mappedVal;
            }
          }
          return obj;
        }
        return node;
      };

      for (const l of parsed.lists) {
        const legacyId = asTrimmed(l.id);
        if (!legacyId) continue;
        const uuid = listIdMap.get(legacyId)!;
        const audType = asTrimmed(l.type).toLowerCase() === 'sync' ? 'sync_data' : 'static_data';
        audienceRows.push([
          uuid,
          tenantId,
          truncateStr(asTrimmed(l.name) || `List ${legacyId}`, 200),
          asNullableStr(l.source),
          audType,
          '[]',
          JSON.stringify({ legacy_list_id: legacyId, source: asNullableStr(l.source) }),
          toInt(l.subscriber_count, 0),
          !l.deleted_at,
          l.created_by ? userIdMap.get(asTrimmed(l.created_by)) || null : null,
          parseSqlTsOrNow(l.created_at),
          parseSqlTsOrNow(l.updated_at),
        ]);
      }

      for (const seg of parsed.segments) {
        const legacyId = asTrimmed(seg.id);
        if (!legacyId) continue;
        const uuid = listIdMap.get(legacyId)!;
        const rawFilters = parseJsonSafe(seg.conditions) ?? parseJsonSafe(seg.filters) ?? [];
        const filters = remapSegmentFilters(rawFilters);
        audienceRows.push([
          uuid,
          tenantId,
          truncateStr(asTrimmed(seg.name) || `Segment ${legacyId}`, 200),
          asNullableStr(seg.description),
          'dynamic_logic',
          JSON.stringify(filters),
          JSON.stringify({ legacy_segment_id: legacyId }),
          toInt(seg.subscriber_count, 0),
          !seg.deleted_at,
          seg.created_by ? userIdMap.get(asTrimmed(seg.created_by)) || null : null,
          parseSqlTsOrNow(seg.created_at),
          parseSqlTsOrNow(seg.updated_at),
        ]);
      }

      targetMigratedCounts.tenant_audiences = await batchExecValues(
        client,
        'tenant_audiences',
        [
          'id',
          'tenant_id',
          'name',
          'description',
          'audience_type',
          'filter_branches',
          'sync_config',
          'cached_member_count',
          'is_active',
          'created_by',
          'created_at',
          'updated_at',
        ],
        audienceRows,
        `ON CONFLICT (id) DO UPDATE SET
          name = EXCLUDED.name,
          description = EXCLUDED.description,
          audience_type = EXCLUDED.audience_type,
          filter_branches = EXCLUDED.filter_branches,
          cached_member_count = EXCLUDED.cached_member_count,
          is_active = EXCLUDED.is_active,
          updated_at = clock_timestamp()`,
        200,
        { filter_branches: 'jsonb', sync_config: 'jsonb' }
      );

      // `subscriber_lists` -> `tenant_audience_members` (deduplicated per audience_id + lead_id)
      const audMemberMap = new Map<string, unknown[]>();
      for (const sl of parsed.subscriberLists) {
        const audUuid = listIdMap.get(sl.list_id);
        const leadUuid = subIdToUuid.get(sl.subscriber_id);
        if (!audUuid || !leadUuid) continue;
        const key = `${audUuid}:${leadUuid}`;
        if (!audMemberMap.has(key)) {
          audMemberMap.set(key, [
            deterministicUuid(tenantSlug, 'tenant_audience_members', key),
            tenantId,
            audUuid,
            leadUuid,
            'myerp_migration',
          ]);
        }
      }

      targetMigratedCounts.tenant_audience_members = await batchExecValues(
        client,
        'tenant_audience_members',
        ['id', 'tenant_id', 'audience_id', 'lead_id', 'source_type'],
        Array.from(audMemberMap.values()),
        `ON CONFLICT (tenant_id, audience_id, lead_id) DO NOTHING`,
        600
      );

      // ----------------------------------------------------------------------
      // F3: Data Reports, Compensation Logs, Helpdesk Tickets, Notes & Activities
      // ----------------------------------------------------------------------
      const dataReportRows: unknown[][] = [];
      for (const dr of parsed.dataReports) {
        const legacyId = asTrimmed(dr.id);
        const leadUuid = legacyLeadIdToUuid.get(asTrimmed(dr.lead_id));
        const reporterUuid = userIdMap.get(asTrimmed(dr.consultant_id)) || defaultAdminUserId;
        if (!legacyId || !leadUuid || !reporterUuid) {
          quarantined.orphan_data_reports += 1;
          continue;
        }
        const rawSt = asTrimmed(dr.status).toLowerCase();
        const st = ['pending', 'approved', 'rejected'].includes(rawSt) ? rawSt : 'pending';
        dataReportRows.push([
          deterministicUuid(tenantSlug, 'data_reports', legacyId),
          tenantId,
          leadUuid,
          reporterUuid,
          truncateStr(asTrimmed(dr.reason) || 'Reported issue', 100),
          asNullableStr(dr.reason),
          st,
          dr.resolved_by ? userIdMap.get(asTrimmed(dr.resolved_by)) || null : null,
          asNullableStr(dr.approval_reason || dr.reject_reason),
          st === 'approved',
          parseSqlTsOrNow(dr.created_at),
          parseSqlTsOrNow(dr.resolved_at || dr.created_at),
        ]);
      }

      targetMigratedCounts.data_reports = await batchExecValues(
        client,
        'data_reports',
        [
          'id',
          'tenant_id',
          'lead_id',
          'reporter_id',
          'reason',
          'description',
          'status',
          'resolved_by',
          'resolution_note',
          'compensation_granted',
          'created_at',
          'updated_at',
        ],
        dataReportRows,
        `ON CONFLICT (id) DO UPDATE SET status = EXCLUDED.status, resolution_note = EXCLUDED.resolution_note, updated_at = clock_timestamp()`
      );

      const compLogRows: unknown[][] = [];
      for (const cl of parsed.activeCompensationLogs) {
        const legacyId = asTrimmed(cl.id);
        const rUuid = roundIdMap.get(asTrimmed(cl.round_id));
        const uUuid = userIdMap.get(asTrimmed(cl.consultant_id));
        if (!legacyId || !rUuid || !uUuid) continue;
        compLogRows.push([
          deterministicUuid(tenantSlug, 'active_compensation_logs', legacyId),
          tenantId,
          rUuid,
          uUuid,
          cl.admin_id ? userIdMap.get(asTrimmed(cl.admin_id)) || null : null,
          toInt(cl.amount, 1),
          asNullableStr(cl.reason, 255),
          'myerp_migration',
          parseSqlTsOrNow(cl.created_at),
        ]);
      }

      targetMigratedCounts.active_compensation_logs = await batchExecValues(
        client,
        'active_compensation_logs',
        [
          'id',
          'tenant_id',
          'round_id',
          'consultant_user_id',
          'admin_user_id',
          'amount',
          'reason',
          'source_type',
          'created_at',
        ],
        compLogRows,
        `ON CONFLICT (id) DO NOTHING`
      );

      // Helpdesk tickets
      const ticketRows: unknown[][] = [];
      for (const tk of parsed.tickets) {
        const legacyId = asTrimmed(tk.id);
        if (!legacyId) continue;
        const createdIso = parseSqlTsOrNow(tk.created_at);
        const dueIso = parseSqlTs(tk.due_date) || new Date(Date.parse(createdIso) + 86400_000).toISOString();
        const rawPrio = asTrimmed(tk.priority).toLowerCase();
        const prio = ['low', 'medium', 'high', 'urgent'].includes(rawPrio) ? rawPrio : 'medium';
        const rawSt = asTrimmed(tk.status).toLowerCase();
        const st =
          rawSt === 'done' || rawSt === 'completed'
            ? 'resolved'
            : ['open', 'in_progress', 'waiting_customer', 'resolved', 'closed'].includes(rawSt)
              ? rawSt
              : 'open';

        ticketRows.push([
          deterministicUuid(tenantSlug, 'tickets', legacyId),
          tenantId,
          `MYERP-TK-${legacyId}`.slice(0, 40),
          truncateStr(asTrimmed(tk.subject) || `Ticket #${legacyId}`, 255),
          asNullableStr(tk.description),
          prio,
          st,
          tk.contact_id ? contactIdToUuid.get(asTrimmed(tk.contact_id)) || null : null,
          asNullableStr(tk.customer_name, 150),
          tk.assignee_id ? userIdMap.get(asTrimmed(tk.assignee_id)) || null : null,
          tk.created_by ? userIdMap.get(asTrimmed(tk.created_by)) || null : null,
          dueIso,
          dueIso,
          parseSqlTs(tk.resolved_at),
          createdIso,
          parseSqlTsOrNow(tk.updated_at || tk.created_at),
        ]);
      }

      targetMigratedCounts.tenant_helpdesk_tickets = await batchExecValues(
        client,
        'tenant_helpdesk_tickets',
        [
          'id',
          'tenant_id',
          'ticket_code',
          'subject',
          'description',
          'priority',
          'status',
          'lead_id',
          'customer_name',
          'assignee_user_id',
          'created_by_user_id',
          'response_due_at',
          'resolution_due_at',
          'resolved_at',
          'created_at',
          'updated_at',
        ],
        ticketRows,
        `ON CONFLICT (id) DO UPDATE SET subject = EXCLUDED.subject, status = EXCLUDED.status, updated_at = clock_timestamp()`
      );

      // Notes + Comments + CRM Activities -> `tenant_crm_activities` (editable, non-immutable)
      const crmActRows: unknown[][] = [];

      for (const n of parsed.notes) {
        const legacyId = asTrimmed(n.id);
        if (!legacyId || n.deleted_at) continue;
        const ownerUuid = n.user_id ? userIdMap.get(asTrimmed(n.user_id)) || null : null;
        const leadUuid =
          asTrimmed(n.entity_type).toLowerCase() === 'contact' && n.entity_id
            ? contactIdToUuid.get(asTrimmed(n.entity_id)) || null
            : null;
        crmActRows.push([
          deterministicUuid(tenantSlug, 'notes', legacyId),
          tenantId,
          truncateStr(asTrimmed(n.note_type || n.type) || 'note', 40),
          truncateStr(asTrimmed(n.channel) ? `Note (${asTrimmed(n.channel)})` : 'CRM Note', 255),
          asNullableStr(n.body),
          'completed',
          'medium',
          null,
          parseSqlTsOrNow(n.created_at),
          toInt(n.duration_minutes, 0),
          leadUuid,
          ownerUuid,
          ownerUuid ? userNameMap.get(ownerUuid) || null : null,
          JSON.stringify({ legacy_note_id: legacyId, entity_type: n.entity_type, entity_id: n.entity_id }),
          ownerUuid,
          parseSqlTsOrNow(n.created_at),
          parseSqlTsOrNow(n.updated_at || n.created_at),
        ]);
      }

      for (const cm of parsed.comments) {
        const legacyId = asTrimmed(cm.id);
        if (!legacyId) continue;
        const ownerUuid = cm.user_id ? userIdMap.get(asTrimmed(cm.user_id)) || null : null;
        const leadUuid =
          asTrimmed(cm.entity_type).toLowerCase() === 'contact' && cm.entity_id
            ? contactIdToUuid.get(asTrimmed(cm.entity_id)) || null
            : null;
        crmActRows.push([
          deterministicUuid(tenantSlug, 'comments', legacyId),
          tenantId,
          'comment',
          truncateStr(`Comment (${asTrimmed(cm.entity_type) || 'crm'})`, 255),
          asNullableStr(cm.body),
          'completed',
          'medium',
          null,
          parseSqlTsOrNow(cm.created_at),
          0,
          leadUuid,
          ownerUuid,
          ownerUuid ? userNameMap.get(ownerUuid) || null : null,
          JSON.stringify({ legacy_comment_id: legacyId, entity_type: cm.entity_type, entity_id: cm.entity_id }),
          ownerUuid,
          parseSqlTsOrNow(cm.created_at),
          parseSqlTsOrNow(cm.created_at),
        ]);
      }

      for (const act of parsed.activities) {
        if (!act.id || act.deleted_at) continue;
        const ownerUuid = act.user_id ? userIdMap.get(act.user_id) || null : null;
        const creatorUuid = act.created_by ? userIdMap.get(act.created_by) || null : ownerUuid;
        const leadUuid =
          (act.contact_id ? contactIdToUuid.get(act.contact_id) : undefined) ||
          (act.related_type === 'contact' && act.related_id ? contactIdToUuid.get(act.related_id) : undefined) ||
          null;
        crmActRows.push([
          deterministicUuid(tenantSlug, 'activities', act.id),
          tenantId,
          truncateStr(act.type || 'task', 40),
          truncateStr(act.subject || `Activity #${act.id}`, 255),
          act.body,
          truncateStr(act.status || 'completed', 30),
          truncateStr(act.priority || 'medium', 20),
          parseSqlTs(act.due_date),
          parseSqlTs(act.done_at),
          15,
          leadUuid,
          ownerUuid,
          ownerUuid ? userNameMap.get(ownerUuid) || null : null,
          JSON.stringify({ legacy_activity_id: act.id }),
          creatorUuid,
          parseSqlTsOrNow(act.created_at),
          parseSqlTsOrNow(act.updated_at || act.created_at),
        ]);
      }

      targetMigratedCounts.tenant_crm_activities = await batchExecValues(
        client,
        'tenant_crm_activities',
        [
          'id',
          'tenant_id',
          'activity_type',
          'subject',
          'body',
          'status',
          'priority',
          'due_date',
          'completed_at',
          'duration_minutes',
          'lead_id',
          'owner_user_id',
          'owner_name',
          'metadata',
          'created_by',
          'created_at',
          'updated_at',
        ],
        crmActRows,
        `ON CONFLICT (id) DO UPDATE SET subject = EXCLUDED.subject, body = EXCLUDED.body, status = EXCLUDED.status, updated_at = clock_timestamp()`,
        400,
        { metadata: 'jsonb' }
      );

      // ----------------------------------------------------------------------
      // F4: Template Groups, Media Assets, Email Templates, Campaigns, Send Claims
      // ----------------------------------------------------------------------
      const templateGroupIdMap = new Map<string, string>();
      const tplGroupRows: unknown[][] = [];

      for (const tg of parsed.templateGroups) {
        const legacyId = asTrimmed(tg.id);
        if (!legacyId) continue;
        const uuid = deterministicUuid(tenantSlug, 'template_groups', legacyId);
        templateGroupIdMap.set(legacyId, uuid);
        tplGroupRows.push([
          uuid,
          tenantId,
          truncateStr(asTrimmed(tg.name) || `Group ${legacyId}`, 150),
          null,
          '#1E40FF',
          tg.created_by ? userIdMap.get(asTrimmed(tg.created_by)) || null : null,
          parseSqlTsOrNow(tg.created_at),
          parseSqlTsOrNow(tg.updated_at || tg.created_at),
        ]);
      }

      targetMigratedCounts.mkt_template_groups = await batchExecValues(
        client,
        'mkt_template_groups',
        ['id', 'tenant_id', 'name', 'description', 'color_hex', 'created_by', 'created_at', 'updated_at'],
        tplGroupRows,
        `ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name, updated_at = clock_timestamp()`
      );

      // Global assets + Email sections -> `mkt_media_assets`
      const mediaAssetRows: unknown[][] = [];
      for (const ga of rewrittenGlobalAssets) {
        const legacyId = asTrimmed(ga.row.id);
        if (!legacyId || Number(ga.row.is_deleted ?? 0) === 1) continue;
        const fileName = truncateStr(asTrimmed(ga.row.name) || asTrimmed(ga.row.unique_name) || `asset_${legacyId}`, 255);
        const url = ga.url || `${publicOrigin}/uploadss/${asTrimmed(ga.row.unique_name || ga.row.name)}`;
        if (
          !url ||
          /^blob:/i.test(url) ||
          /localhost:\d+/i.test(url) ||
          /\.php(\?|$)/i.test(url) ||
          /\.php$/i.test(fileName)
        ) {
          continue;
        }
        mediaAssetRows.push([
          deterministicUuid(tenantSlug, 'global_assets', legacyId),
          tenantId,
          truncateStr(asTrimmed(ga.row.source) || 'MYERP Assets', 100),
          fileName,
          truncateStr(asTrimmed(ga.row.type) || 'image/png', 80),
          url,
          toInt(ga.row.size, 0),
          JSON.stringify(ga.row.extension ? [asTrimmed(ga.row.extension)] : []),
          parseSqlTsOrNow(ga.row.created_at),
        ]);
      }
      for (const es of rewrittenEmailSections) {
        const legacyId = asTrimmed(es.row.id);
        if (!legacyId) continue;
        mediaAssetRows.push([
          deterministicUuid(tenantSlug, 'email_sections', legacyId),
          tenantId,
          'Email Sections',
          truncateStr(asTrimmed(es.row.name) || `Section ${legacyId}`, 255),
          'application/json',
          `${publicOrigin}/uploadss/email_sections/${legacyId}.json`,
          JSON.stringify(es.data).length,
          JSON.stringify(['email_section', legacyId]),
          parseSqlTsOrNow(es.row.created_at),
        ]);
      }

      targetMigratedCounts.mkt_media_assets = await batchExecValues(
        client,
        'mkt_media_assets',
        ['id', 'tenant_id', 'folder_name', 'file_name', 'mime_type', 'url', 'size_bytes', 'tags_json', 'created_at'],
        mediaAssetRows,
        `ON CONFLICT (id) DO UPDATE SET url = EXCLUDED.url, file_name = EXCLUDED.file_name`,
        300,
        { tags_json: 'jsonb' }
      );

      // Email templates -> `mkt_email_templates`
      const savedSectionsPayload = rewrittenEmailSections.map((es) => ({
        id: asTrimmed(es.row.id),
        name: asTrimmed(es.row.name),
        data: es.data,
      }));
      const templateRows: unknown[][] = [];

      for (const t of rewrittenTemplates) {
        const legacyId = asTrimmed(t.row.id);
        if (!legacyId) continue;
        const uuid = templateIdMap.get(legacyId) || deterministicUuid(tenantSlug, 'templates', legacyId);
        const groupUuid = t.row.group_id ? templateGroupIdMap.get(asTrimmed(t.row.group_id)) || null : null;

        templateRows.push([
          uuid,
          tenantId,
          groupUuid,
          truncateStr(asTrimmed(t.row.name) || `Template ${legacyId}`, 200),
          truncateStr(rewriter.rewriteString(asStr(t.row.subject), 'html'), 255),
          '',
          truncateStr(asTrimmed(t.row.category) || 'general', 60),
          JSON.stringify(t.blocks),
          JSON.stringify(t.bodyStyle),
          t.html,
          truncateStr(asTrimmed(t.row.visibility) || 'company', 30),
          'active',
          JSON.stringify(savedSectionsPayload),
          t.thumbnail,
          t.row.created_by ? userIdMap.get(asTrimmed(t.row.created_by)) || null : null,
          parseSqlTsOrNow(t.row.created_at),
          parseSqlTsOrNow(t.row.updated_at || t.row.created_at),
        ]);
      }

      targetMigratedCounts.mkt_email_templates = await batchExecValues(
        client,
        'mkt_email_templates',
        [
          'id',
          'tenant_id',
          'group_id',
          'name',
          'subject',
          'preheader',
          'category',
          'blocks_json',
          'body_style',
          'compiled_html',
          'visibility',
          'status',
          'saved_blocks_json',
          'thumbnail_url',
          'created_by',
          'created_at',
          'updated_at',
        ],
        templateRows,
        `ON CONFLICT (id) DO UPDATE SET
          group_id = EXCLUDED.group_id,
          name = EXCLUDED.name,
          subject = EXCLUDED.subject,
          blocks_json = EXCLUDED.blocks_json,
          body_style = EXCLUDED.body_style,
          compiled_html = EXCLUDED.compiled_html,
          saved_blocks_json = EXCLUDED.saved_blocks_json,
          thumbnail_url = EXCLUDED.thumbnail_url,
          updated_at = clock_timestamp()`,
        100,
        { blocks_json: 'jsonb', body_style: 'jsonb', saved_blocks_json: 'jsonb' }
      );

      // Campaigns -> `mkt_campaigns` (Zero-Blast: never leave historical campaigns as 'scheduled')
      const campaignIdMap = new Map<string, string>();
      const campaignRows: unknown[][] = [];

      for (const c of rewrittenCampaigns) {
        const legacyId = asTrimmed(c.row.id);
        if (!legacyId || Number(c.row.is_deleted ?? 0) === 1 || c.row.deleted_at) continue;
        const uuid = deterministicUuid(tenantSlug, 'campaigns', legacyId);
        campaignIdMap.set(legacyId, uuid);

        const rawStatus = asTrimmed(c.row.status).toLowerCase();
        // Zero-blast guard: convert any active/scheduled/sending legacy campaign to completed (if sent_at) or paused
        const safeStatus =
          rawStatus === 'sent' || rawStatus === 'completed'
            ? 'completed'
            : rawStatus === 'draft'
              ? 'draft'
              : c.row.sent_at
                ? 'completed'
                : 'paused';

        const cfg = c.config as Record<string, unknown>;
        const tcfg = c.targetConfig as Record<string, unknown>;
        const mapIdArr = (arr: unknown, mapper: Map<string, string>): string[] =>
          Array.isArray(arr)
            ? arr.map((v) => mapper.get(String(v).trim()) || String(v).trim()).filter(Boolean)
            : [];

        const rawListIds = [
          ...(Array.isArray(tcfg?.listIds) ? tcfg.listIds : []),
          ...(Array.isArray(tcfg?.list_ids) ? tcfg.list_ids : []),
          ...(Array.isArray(cfg?.listIds) ? cfg.listIds : []),
          ...(Array.isArray(cfg?.list_ids) ? cfg.list_ids : []),
        ];
        const rawSegmentIds = [
          ...(Array.isArray(tcfg?.segmentIds) ? tcfg.segmentIds : []),
          ...(Array.isArray(tcfg?.segment_ids) ? tcfg.segment_ids : []),
          ...(Array.isArray(cfg?.segmentIds) ? cfg.segmentIds : []),
          ...(Array.isArray(cfg?.segment_ids) ? cfg.segment_ids : []),
        ];
        const candidateListIds = [...rawListIds, ...rawSegmentIds];
        let audienceUuid: string | null = null;
        for (const lid of candidateListIds) {
          const mapped = listIdMap.get(String(lid).trim());
          if (mapped) {
            audienceUuid = mapped;
            break;
          }
        }

        const remappedTarget = {
          listIds: mapIdArr(rawListIds, listIdMap),
          segmentIds: mapIdArr(rawSegmentIds, listIdMap),
          tagIds: mapIdArr(tcfg?.tagIds ?? tcfg?.tag_ids ?? cfg?.tagIds ?? [], domationTagIdToUuid),
          individualIds: Array.isArray(tcfg?.individualIds) ? tcfg.individualIds : [],
        };

        const rawTargetCount = toInt(c.row.total_target_audience, 0);
        const rawSentCount = toInt(c.row.count_sent, 0);
        const rawUniqueOpened = toInt(c.row.count_unique_opened, 0);
        const rawTotalOpened = toInt(c.row.count_opened, 0);
        const rawUniqueClicked = toInt(c.row.count_unique_clicked, 0);
        const rawTotalClicked = toInt(c.row.count_clicked, 0);
        const rawBounced = toInt(c.row.count_bounced, 0);
        const rawUnsub = toInt(c.row.count_unsubscribed, 0);
        const effectiveOpened =
          rawUniqueOpened > 0
            ? rawSentCount > 0
              ? Math.min(rawSentCount, rawUniqueOpened)
              : rawUniqueOpened
            : rawSentCount > 0
              ? Math.min(rawSentCount, rawTotalOpened || toInt(c.row.stat_opens, 0))
              : rawTotalOpened || toInt(c.row.stat_opens, 0);
        const effectiveClicked =
          rawUniqueClicked > 0
            ? rawSentCount > 0
              ? Math.min(rawSentCount, rawUniqueClicked)
              : rawUniqueClicked
            : rawSentCount > 0
              ? Math.min(rawSentCount, rawTotalClicked || toInt(c.row.stat_clicks, 0))
              : rawTotalClicked || toInt(c.row.stat_clicks, 0);

        const tplUuid = c.row.template_id ? templateIdMap.get(asTrimmed(c.row.template_id)) || null : null;
        const fallbackVars = {
          legacy_campaign_id: legacyId,
          preheader_text: asNullableStr(c.row.preheader_text),
          reply_to: asNullableStr(c.row.reply_to),
          _attachments: c.attachments,
          _target: remappedTarget,
          _config: c.config,
          _dispatch_stats: {
            provider: 'aws_ses',
            progress_pct: safeStatus === 'completed' ? 100 : 0,
            total_target: rawTargetCount,
            sent: rawSentCount,
            total_opens: rawTotalOpened,
            unique_opens: rawUniqueOpened,
            total_clicks: rawTotalClicked,
            unique_clicks: rawUniqueClicked,
            bounced: rawBounced,
            unsubscribed: rawUnsub,
            failed: 0,
          },
          ...(c.contentBody ? { _content_body: c.contentBody } : {}),
        };

        campaignRows.push([
          uuid,
          tenantId,
          truncateStr(asTrimmed(c.row.name) || `Campaign ${legacyId}`, 255),
          'email',
          safeStatus,
          audienceUuid,
          tplUuid,
          truncateStr(c.subject, 255),
          '',
          truncateStr(asTrimmed(c.row.sender_name) || creds.fromName, 150),
          truncateStr(asTrimmed(c.row.sender_email) || creds.fromEmail, 255),
          '{}', // reminder_config empty so reminders worker never blasts historical campaigns
          safeStatus === 'completed' ? null : parseSqlTs(c.row.scheduled_at),
          parseSqlTs(c.row.sent_at),
          rawTargetCount,
          rawSentCount,
          effectiveOpened,
          effectiveClicked,
          rawBounced,
          rawUnsub,
          JSON.stringify(fallbackVars),
          c.row.created_by ? userIdMap.get(asTrimmed(c.row.created_by)) || null : null,
          parseSqlTsOrNow(c.row.created_at),
          parseSqlTsOrNow(c.row.updated_at || c.row.created_at),
        ]);
      }

      targetMigratedCounts.mkt_campaigns = await batchExecValues(
        client,
        'mkt_campaigns',
        [
          'id',
          'tenant_id',
          'name',
          'channel',
          'status',
          'audience_id',
          'template_id',
          'subject_a',
          'subject_b',
          'sender_name',
          'sender_email',
          'reminder_config',
          'scheduled_at',
          'sent_at',
          'total_targeted',
          'sent_count',
          'opened_count',
          'clicked_count',
          'bounced_count',
          'unsubscribed_count',
          'fallback_vars_json',
          'created_by',
          'created_at',
          'updated_at',
        ],
        campaignRows,
        `ON CONFLICT (id) DO UPDATE SET
          name = EXCLUDED.name,
          status = EXCLUDED.status,
          audience_id = EXCLUDED.audience_id,
          template_id = EXCLUDED.template_id,
          subject_a = EXCLUDED.subject_a,
          sender_name = EXCLUDED.sender_name,
          sender_email = EXCLUDED.sender_email,
          fallback_vars_json = EXCLUDED.fallback_vars_json,
          total_targeted = EXCLUDED.total_targeted,
          sent_count = EXCLUDED.sent_count,
          opened_count = EXCLUDED.opened_count,
          clicked_count = EXCLUDED.clicked_count,
          bounced_count = EXCLUDED.bounced_count,
          unsubscribed_count = EXCLUDED.unsubscribed_count,
          updated_at = clock_timestamp()`,
        100,
        { reminder_config: 'jsonb', fallback_vars_json: 'jsonb' }
      );

      // Build open/click engagement index per (campaignUuid, leadUuid) from subscriber_activity
      const campLeadEngagement = new Map<string, { openedAt: string | null; clickedAt: string | null }>();
      for (const sa of parsed.subscriberActivity) {
        if (!sa.campaign_id) continue;
        const campUuid = campaignIdMap.get(asTrimmed(sa.campaign_id));
        const leadUuid =
          (sa.subscriber_id ? subIdToUuid.get(asTrimmed(sa.subscriber_id)) : undefined) ||
          (sa.contact_id ? contactIdToUuid.get(asTrimmed(sa.contact_id)) : undefined);
        if (!campUuid || !leadUuid) continue;
        const actLower = (sa.action_type || sa.type || '').trim().toLowerCase();
        if (actLower !== 'open_email' && actLower !== 'click_link') continue;
        const ts = parseSqlTs(sa.created_at);
        if (!ts) continue;
        const key = `${campUuid}:${leadUuid}:email`;
        const cur = campLeadEngagement.get(key) || { openedAt: null, clickedAt: null };
        if (actLower === 'open_email' && (!cur.openedAt || ts < cur.openedAt)) {
          cur.openedAt = ts;
        }
        if (actLower === 'click_link') {
          if (!cur.clickedAt || ts < cur.clickedAt) cur.clickedAt = ts;
          if (!cur.openedAt || ts < cur.openedAt) cur.openedAt = ts;
        }
        campLeadEngagement.set(key, cur);
      }

      const normalizeClaimStatus = (
        rawStatus: string,
        eng: { openedAt: string | null; clickedAt: string | null } | undefined
      ): string => {
        const lower = rawStatus.trim().toLowerCase();
        let st = lower === 'success' || !lower ? 'sent' : lower;
        if (eng?.clickedAt && (st === 'sent' || st === 'delivered' || st === 'opened')) {
          st = 'clicked';
        } else if (eng?.openedAt && (st === 'sent' || st === 'delivered')) {
          st = 'opened';
        }
        return truncateStr(st, 30);
      };

      // Send claims (`campaign_send_claims` + campaign-linked `mail_delivery_logs`)
      // CRITICAL ZERO-BLAST: Always set `reminder_sent = true`!
      const claimByKey = new Map<string, unknown[]>();
      for (const sc of parsed.campaignSendClaims) {
        const campUuid = campaignIdMap.get(asTrimmed(sc.campaign_id));
        const leadUuid =
          (sc.subscriber_id ? subIdToUuid.get(asTrimmed(sc.subscriber_id)) : undefined) ||
          (sc.recipient_key ? emailToUuid.get(asTrimmed(sc.recipient_key).toLowerCase()) : undefined);
        if (!campUuid || !leadUuid) {
          quarantined.orphan_send_claims += 1;
          continue;
        }
        const key = `${campUuid}:${leadUuid}:email`;
        const eng = campLeadEngagement.get(key);
        const ts = parseSqlTsOrNow(sc.claimed_at || sc.updated_at);
        claimByKey.set(key, [
          deterministicUuid(tenantSlug, 'mkt_send_claims', key),
          tenantId,
          campUuid,
          leadUuid,
          'email',
          'A',
          normalizeClaimStatus(asTrimmed(sc.status) || 'sent', eng),
          true, // reminder_sent = true (zero-blast!)
          ts,
          ts,
          eng?.openedAt || null,
          eng?.clickedAt || null,
          null,
          JSON.stringify({ legacy_claim_id: sc.id }),
        ]);
      }

      // Enrich with campaign-linked `mail_delivery_logs`
      const nonCampaignDeliveries: typeof parsed.mailDeliveryLogs = [];
      for (const dl of parsed.mailDeliveryLogs) {
        const campUuid = dl.campaign_id ? campaignIdMap.get(dl.campaign_id) : undefined;
        const leadUuid =
          (dl.subscriber_id ? subIdToUuid.get(dl.subscriber_id) : undefined) ||
          (dl.recipient ? emailToUuid.get(dl.recipient.trim().toLowerCase()) : undefined);

        if (campUuid && leadUuid) {
          const key = `${campUuid}:${leadUuid}:email`;
          if (!claimByKey.has(key)) {
            const eng = campLeadEngagement.get(key);
            const ts = parseSqlTsOrNow(dl.sent_at || dl.created_at);
            claimByKey.set(key, [
              deterministicUuid(tenantSlug, 'mkt_send_claims', key),
              tenantId,
              campUuid,
              leadUuid,
              'email',
              'A',
              normalizeClaimStatus(dl.status || 'sent', eng),
              true, // reminder_sent = true (zero-blast!)
              ts,
              ts,
              eng?.openedAt || null,
              eng?.clickedAt || null,
              dl.error_message,
              JSON.stringify({ legacy_delivery_log_id: dl.id }),
            ]);
          }
        } else if (leadUuid) {
          nonCampaignDeliveries.push(dl);
        }
      }

      targetMigratedCounts.mkt_send_claims = await batchExecValues(
        client,
        'mkt_send_claims',
        [
          'id',
          'tenant_id',
          'campaign_id',
          'lead_id',
          'channel',
          'variant',
          'status',
          'reminder_sent',
          'claimed_at',
          'sent_at',
          'opened_at',
          'clicked_at',
          'error_message',
          'metadata',
        ],
        Array.from(claimByKey.values()),
        `ON CONFLICT (tenant_id, campaign_id, lead_id, channel) DO UPDATE SET
          status = EXCLUDED.status,
          reminder_sent = true,
          opened_at = COALESCE(EXCLUDED.opened_at, mkt_send_claims.opened_at),
          clicked_at = COALESCE(EXCLUDED.clicked_at, mkt_send_claims.clicked_at),
          error_message = EXCLUDED.error_message`,
        400,
        { metadata: 'jsonb' }
      );

      // ----------------------------------------------------------------------
      // F5: Automation Flows, Flow Snapshots, Gated Flow Enrollments
      // ----------------------------------------------------------------------
      const formIdMap = new Map<string, string>();
      for (const fm of parsed.forms) {
        const legId = asTrimmed(fm.id);
        if (!legId || fm.deleted_at) continue;
        const fmUuid = deterministicUuid(tenantSlug, 'forms', legId);
        formIdMap.set(legId, fmUuid);
        formIdMap.set(legId.toLowerCase(), fmUuid);
        const tok = asTrimmed(fm.embed_token);
        if (tok) formIdMap.set(tok, fmUuid);
      }

      const flowIdMap = new Map<string, string>();
      const flowStepLookup = new Map<string, { type: string; label: string }>();
      const flowRows: unknown[][] = [];

      for (const f of rewrittenFlows) {
        const legacyId = asTrimmed(f.row.id);
        if (!legacyId || f.row.deleted_at) continue;
        const uuid = deterministicUuid(tenantSlug, 'flows', legacyId);
        flowIdMap.set(legacyId, uuid);
        const triggerType = truncateStr(asTrimmed(f.row.trigger_type) || 'manual', 60);
        const remappedFlow = remapFlowTriggerAndSteps(triggerType, f.config, f.steps, {
          formIdMap,
          listIdMap,
          campaignIdMap,
          templateIdMap,
        });
        for (const st of remappedFlow.steps) {
          if (st && typeof st === 'object') {
            const rec = st as Record<string, unknown>;
            const stId = asTrimmed(rec.id as SqlCell);
            if (stId) {
              flowStepLookup.set(`${legacyId}:${stId}`, {
                type: asTrimmed(rec.type as SqlCell) || 'action',
                label: asTrimmed(rec.label as SqlCell) || asTrimmed(rec.type as SqlCell) || stId,
              });
            }
          }
        }

        const rawStatus = asTrimmed(f.row.status).toLowerCase() || 'draft';
        // Zero-blast guard: pause scheduled birthday/inactivity auto-triggers on migration
        const safeStatus =
          rawStatus === 'active' && (triggerType === 'birthday' || triggerType === 'inactivity')
            ? 'paused'
            : rawStatus;

        flowRows.push([
          uuid,
          tenantId,
          truncateStr(asTrimmed(f.row.name) || `Flow ${legacyId}`, 255),
          asNullableStr(f.row.description),
          safeStatus,
          triggerType,
          JSON.stringify(remappedFlow.triggerConfig),
          JSON.stringify(remappedFlow.steps),
          1,
          toInt(f.row.stat_enrolled, 0),
          toInt(f.row.stat_completed, 0),
          JSON.stringify({ legacy_flow_id: legacyId }),
          f.row.created_by ? userIdMap.get(asTrimmed(f.row.created_by)) || null : null,
          parseSqlTsOrNow(f.row.created_at),
          parseSqlTsOrNow(f.row.updated_at || f.row.created_at),
        ]);
      }

      targetMigratedCounts.mkt_flows = await batchExecValues(
        client,
        'mkt_flows',
        [
          'id',
          'tenant_id',
          'name',
          'description',
          'status',
          'trigger_type',
          'trigger_config',
          'steps_json',
          'version',
          'enrolled_count',
          'completed_count',
          'settings_json',
          'created_by',
          'created_at',
          'updated_at',
        ],
        flowRows,
        `ON CONFLICT (id) DO UPDATE SET
          name = EXCLUDED.name,
          description = EXCLUDED.description,
          status = EXCLUDED.status,
          trigger_type = EXCLUDED.trigger_type,
          trigger_config = EXCLUDED.trigger_config,
          steps_json = EXCLUDED.steps_json,
          enrolled_count = EXCLUDED.enrolled_count,
          completed_count = EXCLUDED.completed_count,
          updated_at = clock_timestamp()`,
        100,
        { trigger_config: 'jsonb', steps_json: 'jsonb', settings_json: 'jsonb' }
      );

      // Flow snapshots (only valid parent flows — drops 90 orphans)
      const snapVersionByFlow = new Map<string, number>();
      const snapRows: unknown[][] = [];
      for (const s of rewrittenFlowSnapshots) {
        const legacyId = asTrimmed(s.row.id);
        const fUuid = flowIdMap.get(asTrimmed(s.row.flow_id));
        if (!legacyId || !fUuid) continue;
        const ver = (snapVersionByFlow.get(fUuid) || 0) + 1;
        snapVersionByFlow.set(fUuid, ver);
        const fd = s.flowData as Record<string, unknown>;
        const snapTrigger = truncateStr(asTrimmed((fd?.trigger_type as SqlCell) ?? 'manual') || 'manual', 60);
        const stepsArr = Array.isArray(fd?.steps) ? fd.steps : Array.isArray(fd) ? fd : [fd];
        const remappedSnap = remapFlowTriggerAndSteps(
          snapTrigger,
          fd?.config ?? { label: asNullableStr(s.row.label) },
          stepsArr,
          { formIdMap, listIdMap, campaignIdMap, templateIdMap }
        );
        snapRows.push([
          deterministicUuid(tenantSlug, 'flow_snapshots', legacyId),
          tenantId,
          fUuid,
          ver,
          snapTrigger,
          JSON.stringify(remappedSnap.triggerConfig),
          JSON.stringify(remappedSnap.steps),
          s.row.created_by ? userIdMap.get(asTrimmed(s.row.created_by)) || null : null,
          parseSqlTsOrNow(s.row.created_at),
        ]);
      }

      targetMigratedCounts.mkt_flow_snapshots = await batchExecValues(
        client,
        'mkt_flow_snapshots',
        [
          'id',
          'tenant_id',
          'flow_id',
          'version',
          'trigger_type',
          'trigger_config',
          'steps_json',
          'published_by',
          'created_at',
        ],
        snapRows,
        `ON CONFLICT (id) DO UPDATE SET steps_json = EXCLUDED.steps_json, trigger_config = EXCLUDED.trigger_config`,
        100,
        { trigger_config: 'jsonb', steps_json: 'jsonb' }
      );

      // Flow enrollments (`subscriber_flow_states`)
      // CRITICAL ZERO-BLAST GATE: convert `waiting`/`active`/`pending` -> `paused` + `next_run_at = NULL`!
      const enrollMap = new Map<string, unknown[]>();
      for (const sfs of parsed.subscriberFlowStates) {
        const fUuid = sfs.flow_id ? flowIdMap.get(sfs.flow_id) : undefined;
        const leadUuid =
          (sfs.subscriber_id ? subIdToUuid.get(sfs.subscriber_id) : undefined) ||
          (sfs.contact_id ? contactIdToUuid.get(sfs.contact_id) : undefined);
        if (!fUuid || !leadUuid) continue;

        const enrollId = deterministicUuid(
          tenantSlug,
          'mkt_flow_enrollments',
          sfs.id || `${sfs.flow_id}:${sfs.subscriber_id}`
        );
        const rawSt = (sfs.status || 'completed').toLowerCase();
        const isWaitingOrActive = rawSt === 'waiting' || rawSt === 'active' || rawSt === 'pending';
        const safeStatus = isWaitingOrActive ? 'paused' : truncateStr(rawSt, 30);

        const stepIdStr = sfs.step_id ? truncateStr(sfs.step_id, 120) : '';
        const stepMeta = sfs.flow_id && stepIdStr ? flowStepLookup.get(`${sfs.flow_id}:${stepIdStr}`) : undefined;
        const rawNodeType = (stepMeta?.type || sfs.step_type || 'action').toLowerCase();
        const traceNodeType =
          rawNodeType === 'action' ? 'send_email' : rawNodeType === 'wait' ? 'wait_delay' : rawNodeType;
        const traceOutcome =
          rawSt === 'failed'
            ? `Lỗi: ${sfs.last_error || 'thất bại'}`
            : isWaitingOrActive
              ? 'Tạm dừng khi migrate (Zero-Blast)'
              : traceNodeType === 'send_email'
                ? 'Đã gửi Email (migrated)'
                : 'Đã xử lý';
        const traceTs = parseSqlTsOrNow(sfs.last_step_at || sfs.updated_at || sfs.created_at);

        const trace = [
          {
            step_id: stepIdStr || undefined,
            node_type: traceNodeType,
            label: stepMeta?.label || sfs.step_type || stepIdStr || 'Step',
            outcome: traceOutcome,
            timestamp: traceTs,
            migrated_from: 'myerp_subscriber_flow_states',
            original_status: rawSt,
            step_type: sfs.step_type,
            gated_to_paused: isWaitingOrActive,
            ...(sfs.waiting_until ? { original_waiting_until: sfs.waiting_until } : {}),
            ...(sfs.scheduled_at ? { original_scheduled_at: sfs.scheduled_at } : {}),
            ...(sfs.last_error ? { last_error: sfs.last_error } : {}),
          },
        ];

        enrollMap.set(enrollId, [
          enrollId,
          tenantId,
          fUuid,
          1,
          leadUuid,
          sfs.step_id ? truncateStr(sfs.step_id, 120) : null,
          safeStatus,
          null, // next_run_at = NULL so master-cron NEVER blasts historical waiting states!
          JSON.stringify(trace),
          parseSqlTsOrNow(sfs.created_at),
          safeStatus === 'completed' ? parseSqlTs(sfs.last_step_at || sfs.updated_at) : null,
        ]);
      }

      targetMigratedCounts.mkt_flow_enrollments = await batchExecValues(
        client,
        'mkt_flow_enrollments',
        [
          'id',
          'tenant_id',
          'flow_id',
          'snapshot_version',
          'lead_id',
          'current_step_id',
          'status',
          'next_run_at',
          'execution_trace',
          'enrolled_at',
          'completed_at',
        ],
        Array.from(enrollMap.values()),
        `ON CONFLICT (id) DO UPDATE SET
          current_step_id = EXCLUDED.current_step_id,
          status = EXCLUDED.status,
          next_run_at = NULL,
          execution_trace = EXCLUDED.execution_trace`,
        400,
        { execution_trace: 'jsonb' }
      );

      // ----------------------------------------------------------------------
      // F5: Forms, Surveys & Responses, Vouchers, Short Links & Clicks
      // ----------------------------------------------------------------------
      const leadCountByFormKey = new Map<string, number>();
      for (const rec of unifiedById.values()) {
        if (rec.is_deleted) continue;
        const keys = new Set<string>();
        if (rec.form_id) keys.add(rec.form_id.trim().toLowerCase());
        const cfFn =
          typeof rec.custom_fields?.form_name === 'string'
            ? rec.custom_fields.form_name.trim().toLowerCase()
            : '';
        const cfMfn =
          typeof rec.custom_fields?.meta_form_name === 'string'
            ? rec.custom_fields.meta_form_name.trim().toLowerCase()
            : '';
        if (cfFn) keys.add(cfFn);
        if (cfMfn) keys.add(cfMfn);
        for (const k of keys) {
          leadCountByFormKey.set(k, (leadCountByFormKey.get(k) || 0) + 1);
        }
      }

      const audMemberCountById = new Map<string, number>();
      for (const row of audMemberMap.values()) {
        const aId = String(row[2]);
        audMemberCountById.set(aId, (audMemberCountById.get(aId) || 0) + 1);
      }

      const listUuidByNormName = new Map<string, string>();
      for (const l of parsed.lists) {
        const lid = asTrimmed(l.id);
        const luuid = lid ? listIdMap.get(lid) : undefined;
        const lname = asTrimmed(l.name).toLowerCase();
        if (luuid && lname && !listUuidByNormName.has(lname)) {
          listUuidByNormName.set(lname, luuid);
        }
      }

      const audienceUsageCount = new Map<string, number>();
      for (const fm of parsed.forms) {
        if (fm.deleted_at) continue;
        const explicitId = fm.target_list_id ? listIdMap.get(asTrimmed(fm.target_list_id)) : undefined;
        if (explicitId) {
          audienceUsageCount.set(explicitId, (audienceUsageCount.get(explicitId) || 0) + 1);
        }
      }

      const seenFormTokens = new Set<string>();
      const fallbackFormAudRows: unknown[][] = [];
      const formRows: unknown[][] = [];

      for (const fm of parsed.forms) {
        const legacyId = asTrimmed(fm.id);
        if (!legacyId || fm.deleted_at) continue;
        const formName = truncateStr(asTrimmed(fm.name) || `Form ${legacyId}`, 200);
        let pubToken = asTrimmed(fm.embed_token) || `${tenantSlug}_form_${legacyId}`;
        if (seenFormTokens.has(pubToken)) {
          pubToken = `${pubToken.slice(0, 60)}_${legacyId}`;
        }
        pubToken = pubToken.slice(0, 80);
        seenFormTokens.add(pubToken);

        const fieldsJson = parseJsonSafe(fm.fields_json) ?? parseJsonSafe(fm.schema) ?? [];
        let targetAudUuid: string | null = fm.target_list_id
          ? listIdMap.get(asTrimmed(fm.target_list_id)) || null
          : null;
        if (!targetAudUuid) {
          targetAudUuid = listUuidByNormName.get(formName.toLowerCase()) || null;
        }
        if (!targetAudUuid) {
          targetAudUuid = deterministicUuid(tenantSlug, 'form_default_audience', legacyId);
          fallbackFormAudRows.push([
            targetAudUuid,
            tenantId,
            formName,
            `Danh sách tự động liên kết với biểu mẫu "${formName}"`,
            'static_data',
            '[]',
            JSON.stringify({ source: 'form_auto_fallback', legacy_form_id: legacyId }),
            0,
            true,
            fm.created_by ? userIdMap.get(asTrimmed(fm.created_by)) || null : null,
            parseSqlTsOrNow(fm.created_at),
            parseSqlTsOrNow(fm.created_at),
          ]);
        }

        const matchedLeadsCount = Math.max(
          leadCountByFormKey.get(legacyId.toLowerCase()) || 0,
          leadCountByFormKey.get(formName.toLowerCase()) || 0
        );
        const dedicatedAudCount =
          targetAudUuid && (audienceUsageCount.get(targetAudUuid) || 0) <= 1
            ? audMemberCountById.get(targetAudUuid) || 0
            : 0;
        const effectiveSubmitCount = Math.max(
          toInt(fm.submit_count, 0),
          matchedLeadsCount,
          dedicatedAudCount
        );

        formRows.push([
          deterministicUuid(tenantSlug, 'forms', legacyId),
          tenantId,
          formName,
          pubToken,
          truncateStr(asTrimmed(fm.status) || (Number(fm.is_active ?? 1) === 1 ? 'active' : 'paused'), 30),
          'marketing_nurture',
          targetAudUuid,
          JSON.stringify(fieldsJson),
          JSON.stringify({ legacy_form_id: legacyId, mapping: parseJsonSafe(fm.mapping) ?? {} }),
          effectiveSubmitCount,
          fm.created_by ? userIdMap.get(asTrimmed(fm.created_by)) || null : null,
          parseSqlTsOrNow(fm.created_at),
        ]);
      }

      if (fallbackFormAudRows.length > 0) {
        await batchExecValues(
          client,
          'tenant_audiences',
          [
            'id',
            'tenant_id',
            'name',
            'description',
            'audience_type',
            'filter_branches',
            'sync_config',
            'cached_member_count',
            'is_active',
            'created_by',
            'created_at',
            'updated_at',
          ],
          fallbackFormAudRows,
          `ON CONFLICT (id) DO NOTHING`,
          100,
          { filter_branches: 'jsonb', sync_config: 'jsonb' }
        );
      }

      targetMigratedCounts.mkt_forms = await batchExecValues(
        client,
        'mkt_forms',
        [
          'id',
          'tenant_id',
          'name',
          'public_token',
          'status',
          'routing_mode',
          'target_audience_id',
          'fields_json',
          'theme_json',
          'submission_count',
          'created_by',
          'created_at',
        ],
        formRows,
        `ON CONFLICT (id) DO UPDATE SET
          name = EXCLUDED.name,
          status = EXCLUDED.status,
          target_audience_id = EXCLUDED.target_audience_id,
          fields_json = EXCLUDED.fields_json,
          submission_count = EXCLUDED.submission_count,
          updated_at = clock_timestamp()`,
        100,
        { fields_json: 'jsonb', theme_json: 'jsonb' }
      );

      // Purchase Events -> `mkt_custom_events`
      const customEventRows: unknown[][] = [];
      const seenEventKeys = new Set<string>();
      for (const pe of parsed.purchaseEvents) {
        const legacyId = asTrimmed(pe.id);
        const eventName = truncateStr(asTrimmed(pe.name) || `Purchase Event ${legacyId}`, 200);
        if (!legacyId) continue;
        let eventKey = slugify(eventName, `purchase_${legacyId}`, 90);
        if (seenEventKeys.has(eventKey)) {
          eventKey = `${eventKey.slice(0, 72)}_${legacyId.slice(0, 14)}`;
        }
        seenEventKeys.add(eventKey);

        customEventRows.push([
          deterministicUuid(tenantSlug, 'purchase_events', legacyId),
          tenantId,
          eventKey,
          eventName,
          'purchase',
          asNullableStr(pe.notification_subject) || `MYERP Purchase Event: ${eventName}`,
          JSON.stringify({
            legacy_purchase_event_id: legacyId,
            notification_enabled: Boolean(Number(pe.notification_enabled ?? 0)),
            notification_emails: asNullableStr(pe.notification_emails),
            notification_subject: asNullableStr(pe.notification_subject),
          }),
          0,
          toBigIntNum(pe.revenue, 0),
          asTrimmed(pe.status).toLowerCase() !== 'inactive',
          defaultAdminUserId,
          parseSqlTsOrNow(pe.created_at),
          parseSqlTsOrNow(pe.created_at),
        ]);
      }

      targetMigratedCounts.mkt_custom_events = await batchExecValues(
        client,
        'mkt_custom_events',
        [
          'id',
          'tenant_id',
          'event_key',
          'event_name',
          'event_category',
          'description',
          'schema_json',
          'trigger_count',
          'total_revenue_vnd',
          'is_active',
          'created_by',
          'created_at',
          'updated_at',
        ],
        customEventRows,
        `ON CONFLICT (tenant_id, event_key) DO UPDATE SET
          event_name = EXCLUDED.event_name,
          event_category = EXCLUDED.event_category,
          description = EXCLUDED.description,
          schema_json = EXCLUDED.schema_json,
          total_revenue_vnd = EXCLUDED.total_revenue_vnd,
          is_active = EXCLUDED.is_active,
          updated_at = clock_timestamp()`,
        100,
        { schema_json: 'jsonb' }
      );

      // Surveys + Survey Questions + Responses + Answer Details
      const questionsBySurvey = new Map<string, RowObj[]>();
      for (const q of parsed.surveyQuestions) {
        const sid = asTrimmed(q.survey_id);
        if (!sid) continue;
        const arr = questionsBySurvey.get(sid) || [];
        arr.push(q);
        questionsBySurvey.set(sid, arr);
      }

      const surveyNpsBlockIdsBySurvey = new Map<string, Set<string>>();
      for (const sv of parsed.surveys) {
        const sid = asTrimmed(sv.id);
        if (!sid) continue;
        const npsKeys = new Set<string>();
        const parsedBlocks = parseJsonSafe<unknown[]>(sv.blocks_json);
        if (Array.isArray(parsedBlocks)) {
          for (const b of parsedBlocks) {
            if (!b || typeof b !== 'object') continue;
            const rec = b as Record<string, unknown>;
            const tp = String(rec.type || '').toLowerCase();
            const opt = rec.options && typeof rec.options === 'object' ? (rec.options as Record<string, unknown>) : null;
            if (tp === 'nps' || String(opt?.style || '').toLowerCase() === 'nps') {
              const bid = asTrimmed(rec.id as SqlCell);
              if (bid) npsKeys.add(bid);
            }
          }
        }
        for (const q of questionsBySurvey.get(sid) || []) {
          if (asTrimmed(q.type).toLowerCase() === 'nps') {
            const bid = asTrimmed(q.block_id) || asTrimmed(q.id);
            const qid = asTrimmed(q.id);
            if (bid) npsKeys.add(bid);
            if (qid) npsKeys.add(qid);
          }
        }
        if (npsKeys.size > 0) surveyNpsBlockIdsBySurvey.set(sid, npsKeys);
      }

      const detailsByResp = new Map<string, Array<Record<string, unknown>>>();
      for (const ad of parsed.surveyAnswerDetails) {
        const rid = asTrimmed(ad.response_id);
        if (!rid) continue;
        const arr = detailsByResp.get(rid) || [];
        arr.push({
          question_id: ad.question_id,
          answer_text: ad.answer_text,
          answer_num: ad.answer_num,
          answer_json: parseJsonSafe(ad.answer_json),
        });
        detailsByResp.set(rid, arr);
      }

      const extractResponseNpsScore = (
        surveyLegacyId: string,
        parsedAnswers: unknown,
        extraDetails: Array<Record<string, unknown>> | undefined
      ): number | null => {
        const npsBlockIds = surveyNpsBlockIdsBySurvey.get(surveyLegacyId);
        if (Array.isArray(parsedAnswers)) {
          for (const item of parsedAnswers) {
            if (!item || typeof item !== 'object') continue;
            const rec = item as Record<string, unknown>;
            const bKey = asTrimmed((rec.block_id ?? rec.question_id) as SqlCell);
            const rType = String(rec.type || '').toLowerCase();
            if (rType === 'nps' || (bKey && npsBlockIds?.has(bKey))) {
              const rawNum = rec.answer_num ?? rec.answer_text;
              if (rawNum !== null && rawNum !== undefined && String(rawNum).trim() !== '') {
                const n = Number(rawNum);
                if (Number.isFinite(n) && n >= 0 && n <= 10) return Math.round(n);
              }
            }
          }
        }
        if (extraDetails && npsBlockIds && npsBlockIds.size > 0) {
          for (const d of extraDetails) {
            const qKey = asTrimmed(d.question_id as SqlCell);
            if (qKey && npsBlockIds.has(qKey)) {
              const rawNum = d.answer_num ?? d.answer_text;
              if (rawNum !== null && rawNum !== undefined && String(rawNum).trim() !== '') {
                const n = Number(rawNum);
                if (Number.isFinite(n) && n >= 0 && n <= 10) return Math.round(n);
              }
            }
          }
        }
        return null;
      };

      const surveyRespAgg = new Map<
        string,
        { count: number; scoreSum: number; scoreCnt: number; npsSum: number; npsCnt: number }
      >();
      const respParsedCache = new Map<
        string,
        { parsedAnswers: unknown; extraDetails: Array<Record<string, unknown>> | undefined; npsScore: number | null }
      >();

      for (const sr of parsed.surveyResponses) {
        const legacyId = asTrimmed(sr.id);
        const sid = asTrimmed(sr.survey_id);
        if (!sid) continue;
        const parsedAnswers = parseJsonSafe<unknown>(sr.answers_json);
        const extraDetails = legacyId ? detailsByResp.get(legacyId) : undefined;
        const npsScore = extractResponseNpsScore(sid, parsedAnswers, extraDetails);
        if (legacyId) {
          respParsedCache.set(legacyId, { parsedAnswers, extraDetails, npsScore });
        }

        const cur = surveyRespAgg.get(sid) || { count: 0, scoreSum: 0, scoreCnt: 0, npsSum: 0, npsCnt: 0 };
        cur.count += 1;
        const rawTotalScore = sr.total_score !== null && sr.total_score !== undefined ? Number(sr.total_score) : Number(sr.score);
        if (Number.isFinite(rawTotalScore) && (sr.total_score !== null || rawTotalScore > 0)) {
          cur.scoreSum += rawTotalScore;
          cur.scoreCnt += 1;
        }
        if (npsScore !== null) {
          cur.npsSum += npsScore;
          cur.npsCnt += 1;
        }
        surveyRespAgg.set(sid, cur);
      }

      const surveyIdMap = new Map<string, string>();
      const seenSurveySlugs = new Set<string>();
      const surveyRows: unknown[][] = [];

      for (const sv of parsed.surveys) {
        const legacyId = asTrimmed(sv.id);
        if (!legacyId || sv.deleted_at) continue;
        const uuid = deterministicUuid(tenantSlug, 'surveys', legacyId);
        surveyIdMap.set(legacyId, uuid);

        let slug = truncateStr(asTrimmed(sv.slug) || slugify(asTrimmed(sv.name), `survey_${legacyId}`, 110), 120);
        if (seenSurveySlugs.has(slug)) {
          slug = `${slug.slice(0, 100)}-${legacyId.slice(0, 16)}`;
        }
        seenSurveySlugs.add(slug);

        const qs = (questionsBySurvey.get(legacyId) || []).sort(
          (a, b) => toInt(a.order_index, 0) - toInt(b.order_index, 0)
        );
        const parsedBlocks = parseJsonSafe<unknown[]>(sv.blocks_json);
        const blocks =
          Array.isArray(parsedBlocks) && parsedBlocks.length > 0
            ? (rewriter.rewriteJsonValue(parsedBlocks) as Array<Record<string, unknown>>)
            : qs.map((q) => ({
                id: asTrimmed(q.block_id) || asTrimmed(q.id),
                type: asTrimmed(q.type) || 'short_text',
                label: asTrimmed(q.label),
                options: parseJsonSafe(q.options_json) ?? [],
                required: Boolean(Number(q.required ?? 0)),
              }));

        const parsedSettings = parseJsonSafe<Record<string, unknown>>(sv.settings_json) || {};
        const settingsObj = {
          ...parsedSettings,
          legacy_survey_id: legacyId,
          legacy_questions_count: qs.length,
        };

        const hasNpsBlock = blocks.some((b) => {
          const t = String(b?.type || '').toLowerCase();
          const opt = b?.options && typeof b.options === 'object' ? (b.options as Record<string, unknown>) : null;
          return t === 'nps' || String(opt?.style || '').toLowerCase() === 'nps';
        });
        const hasQuizBlock =
          Boolean(parsedSettings.quiz_mode) ||
          blocks.some((b) => b?.correct_answer !== undefined || Number(b?.points || 0) > 0);
        const titleLower = `${asTrimmed(sv.name)} ${slug}`.toLowerCase();
        const surveyType =
          hasNpsBlock || /\bnps\b/.test(titleLower)
            ? 'nps'
            : hasQuizBlock || /\bquiz\b|trắc nghiệm/i.test(titleLower)
              ? 'quiz'
              : 'survey';

        const agg = surveyRespAgg.get(legacyId);
        const respCount = agg?.count || 0;
        const avgScore = agg
          ? surveyType === 'nps' && agg.npsCnt > 0
            ? Number((agg.npsSum / agg.npsCnt).toFixed(2))
            : agg.scoreCnt > 0
              ? Number((agg.scoreSum / agg.scoreCnt).toFixed(2))
              : agg.npsCnt > 0
                ? Number((agg.npsSum / agg.npsCnt).toFixed(2))
                : 0
          : 0;

        surveyRows.push([
          uuid,
          tenantId,
          truncateStr(asTrimmed(sv.name) || `Survey ${legacyId}`, 255),
          slug,
          surveyType,
          truncateStr(asTrimmed(sv.status) || 'active', 30),
          JSON.stringify(blocks),
          JSON.stringify(parseJsonSafe(sv.cover_style) ?? {}),
          JSON.stringify(settingsObj),
          JSON.stringify(parseJsonSafe(sv.thank_you_page) ?? {}),
          respCount,
          avgScore,
          sv.created_by ? userIdMap.get(asTrimmed(sv.created_by)) || null : null,
          parseSqlTsOrNow(sv.created_at),
          parseSqlTsOrNow(sv.updated_at || sv.created_at),
        ]);
      }

      targetMigratedCounts.mkt_surveys = await batchExecValues(
        client,
        'mkt_surveys',
        [
          'id',
          'tenant_id',
          'title',
          'slug',
          'survey_type',
          'status',
          'blocks_json',
          'theme_json',
          'settings_json',
          'thank_you_json',
          'response_count',
          'avg_score',
          'created_by',
          'created_at',
          'updated_at',
        ],
        surveyRows,
        `ON CONFLICT (id) DO UPDATE SET
          title = EXCLUDED.title,
          survey_type = EXCLUDED.survey_type,
          blocks_json = EXCLUDED.blocks_json,
          settings_json = EXCLUDED.settings_json,
          response_count = EXCLUDED.response_count,
          avg_score = EXCLUDED.avg_score,
          updated_at = clock_timestamp()`,
        100,
        { blocks_json: 'jsonb', theme_json: 'jsonb', settings_json: 'jsonb', thank_you_json: 'jsonb' }
      );

      // Survey responses + answer details
      const surveyRespRows: unknown[][] = [];
      for (const sr of parsed.surveyResponses) {
        const legacyId = asTrimmed(sr.id);
        const svUuid = surveyIdMap.get(asTrimmed(sr.survey_id));
        if (!legacyId || !svUuid) continue;
        const leadUuid =
          (sr.subscriber_id ? subIdToUuid.get(asTrimmed(sr.subscriber_id)) : undefined) ||
          (sr.contact_id ? contactIdToUuid.get(asTrimmed(sr.contact_id)) : undefined) ||
          null;
        const cached = respParsedCache.get(legacyId);
        const parsedAnswers = cached ? cached.parsedAnswers : parseJsonSafe<unknown>(sr.answers_json);
        const extraDetails = cached ? cached.extraDetails : detailsByResp.get(legacyId);
        const npsScore = cached ? cached.npsScore : null;
        const answersMap: Record<string, unknown> = {};
        if (Array.isArray(parsedAnswers)) {
          for (const item of parsedAnswers) {
            if (item && typeof item === 'object') {
              const rec = item as Record<string, unknown>;
              const blockKey = asTrimmed((rec.block_id ?? rec.question_id) as SqlCell);
              if (!blockKey) continue;
              const val =
                rec.answer_json !== undefined && rec.answer_json !== null
                  ? rec.answer_json
                  : rec.answer_num !== undefined && rec.answer_num !== null
                    ? rec.answer_num
                    : rec.answer_text !== undefined && rec.answer_text !== null
                      ? rec.answer_text
                      : null;
              if (val !== null && val !== '') {
                answersMap[blockKey] = val;
              }
            }
          }
        } else if (parsedAnswers && typeof parsedAnswers === 'object') {
          Object.assign(answersMap, parsedAnswers as Record<string, unknown>);
        }

        if (extraDetails) {
          for (const d of extraDetails) {
            const qKey = asTrimmed(d.question_id as SqlCell);
            if (qKey && answersMap[qKey] === undefined) {
              const val = d.answer_json ?? d.answer_num ?? d.answer_text ?? null;
              if (val !== null && val !== '') answersMap[qKey] = val;
            }
          }
          answersMap._answer_details = extraDetails;
        }

        surveyRespRows.push([
          deterministicUuid(tenantSlug, 'survey_responses', legacyId),
          tenantId,
          svUuid,
          leadUuid,
          JSON.stringify(answersMap),
          toInt(sr.total_score ?? sr.score, 0),
          npsScore,
          parseSqlTsOrNow(sr.submitted_at),
        ]);
      }

      targetMigratedCounts.mkt_survey_responses = await batchExecValues(
        client,
        'mkt_survey_responses',
        ['id', 'tenant_id', 'survey_id', 'lead_id', 'answers_json', 'quiz_score', 'nps_score', 'created_at'],
        surveyRespRows,
        `ON CONFLICT (id) DO UPDATE SET
          answers_json = EXCLUDED.answers_json,
          quiz_score = EXCLUDED.quiz_score,
          nps_score = EXCLUDED.nps_score`,
        100,
        { answers_json: 'jsonb' }
      );

      // Voucher campaigns & codes
      const voucherCodeAgg = new Map<string, { total: number; claimed: number; redeemed: number }>();
      for (const codeRow of parsed.voucherCodes) {
        const cid = asTrimmed(codeRow.campaign_id);
        if (!cid) continue;
        const cur = voucherCodeAgg.get(cid) || { total: 0, claimed: 0, redeemed: 0 };
        cur.total += 1;
        const rawSt = asTrimmed(codeRow.status).toLowerCase();
        const isRedeemed = Boolean(codeRow.used_at) || rawSt === 'used' || rawSt === 'redeemed';
        const isClaimed =
          isRedeemed || Boolean(codeRow.claimed_at || codeRow.distributed_at) || rawSt === 'claimed' || rawSt === 'assigned';
        if (isClaimed) cur.claimed += 1;
        if (isRedeemed) cur.redeemed += 1;
        voucherCodeAgg.set(cid, cur);
      }

      const voucherCampIdMap = new Map<string, string>();
      const voucherCampRows: unknown[][] = [];

      for (const vc of rewrittenVoucherCampaigns) {
        const legacyId = asTrimmed(vc.row.id);
        if (!legacyId) continue;
        const uuid = deterministicUuid(tenantSlug, 'voucher_campaigns', legacyId);
        voucherCampIdMap.set(legacyId, uuid);
        const rewardsList = parseJsonSafe<Array<Record<string, unknown>>>(vc.row.rewards) ?? [];
        const firstReward = Array.isArray(rewardsList) && rewardsList.length > 0 ? rewardsList[0] : null;
        const rawDiscType = String(firstReward?.discountType || firstReward?.discount_type || '').trim().toLowerCase();
        const discountType =
          rawDiscType === 'fixed' || rawDiscType === 'fixed_vnd'
            ? 'fixed_vnd'
            : rawDiscType === 'gift'
              ? 'gift'
              : 'percentage';
        const discountValue = Math.max(
          0,
          toInt((firstReward?.discountValue ?? firstReward?.discount_value ?? 10) as SqlCell, 10)
        );
        const codeStats = voucherCodeAgg.get(legacyId) || { total: 0, claimed: 0, redeemed: 0 };
        const totalCodes = Math.max(toInt(vc.row.total_codes, 0), codeStats.total);
        const claimedCodes = Math.max(toInt(vc.row.claimed_count, 0), codeStats.claimed);
        const redeemedCodes = Math.max(toInt(vc.row.redeemed_count, 0), codeStats.redeemed);

        voucherCampRows.push([
          uuid,
          tenantId,
          truncateStr(asTrimmed(vc.row.name) || `Voucher ${legacyId}`, 255),
          slugify(asTrimmed(vc.row.name), `voucher_${legacyId}`, 120),
          asNullableStr(vc.row.description),
          'IDEAS',
          discountType,
          discountValue,
          parseSqlTs(vc.row.end_date),
          truncateStr(asTrimmed(vc.row.status) || 'active', 30),
          totalCodes,
          claimedCodes,
          redeemedCodes,
          JSON.stringify({
            legacy_voucher_campaign_id: legacyId,
            ...(vc.thumbnailUrl ? { thumbnail_url: vc.thumbnailUrl } : {}),
            rewards: rewardsList,
          }),
          parseSqlTsOrNow(vc.row.created_at),
          parseSqlTsOrNow(vc.row.updated_at || vc.row.created_at),
        ]);
      }

      targetMigratedCounts.mkt_voucher_campaigns = await batchExecValues(
        client,
        'mkt_voucher_campaigns',
        [
          'id',
          'tenant_id',
          'name',
          'slug',
          'description',
          'code_prefix',
          'discount_type',
          'discount_value',
          'expires_at',
          'status',
          'total_codes',
          'claimed_codes',
          'redeemed_codes',
          'qr_design_json',
          'created_at',
          'updated_at',
        ],
        voucherCampRows,
        `ON CONFLICT (id) DO UPDATE SET
          name = EXCLUDED.name,
          discount_type = EXCLUDED.discount_type,
          discount_value = EXCLUDED.discount_value,
          total_codes = EXCLUDED.total_codes,
          claimed_codes = EXCLUDED.claimed_codes,
          redeemed_codes = EXCLUDED.redeemed_codes,
          qr_design_json = EXCLUDED.qr_design_json,
          updated_at = clock_timestamp()`,
        100,
        { qr_design_json: 'jsonb' }
      );

      const voucherCodeMap = new Map<string, unknown[]>();
      for (const codeRow of parsed.voucherCodes) {
        const legacyId = asTrimmed(codeRow.id);
        const vcUuid = voucherCampIdMap.get(asTrimmed(codeRow.campaign_id));
        const code = truncateStr(asTrimmed(codeRow.code), 80);
        if (!legacyId || !vcUuid || !code) continue;
        const leadUuid =
          (codeRow.subscriber_id ? subIdToUuid.get(asTrimmed(codeRow.subscriber_id)) : undefined) ||
          (codeRow.contact_id ? contactIdToUuid.get(asTrimmed(codeRow.contact_id)) : undefined) ||
          null;
        const rawCodeSt = asTrimmed(codeRow.status).toLowerCase();
        const normalizedCodeSt =
          rawCodeSt === 'unused' || !rawCodeSt
            ? 'available'
            : rawCodeSt === 'used'
              ? 'redeemed'
              : rawCodeSt === 'assigned'
                ? 'claimed'
                : rawCodeSt;
        voucherCodeMap.set(code, [
          deterministicUuid(tenantSlug, 'voucher_codes', legacyId),
          tenantId,
          vcUuid,
          code,
          truncateStr(normalizedCodeSt, 30),
          leadUuid,
          parseSqlTs(codeRow.claimed_at || codeRow.distributed_at),
          parseSqlTs(codeRow.used_at),
          parseSqlTsOrNow(codeRow.created_at),
        ]);
      }

      targetMigratedCounts.mkt_voucher_codes = await batchExecValues(
        client,
        'mkt_voucher_codes',
        [
          'id',
          'tenant_id',
          'voucher_campaign_id',
          'code',
          'status',
          'lead_id',
          'claimed_at',
          'redeemed_at',
          'created_at',
        ],
        Array.from(voucherCodeMap.values()),
        `ON CONFLICT (tenant_id, code) DO UPDATE SET status = EXCLUDED.status, lead_id = EXCLUDED.lead_id`
      );

      // Short links & valid link clicks (drops 113 orphan clicks)
      const linkClickStats = new Map<string, { total: number; uniqueIps: Set<string> }>();
      for (const lc of validLinkClicks) {
        const sid = asTrimmed(lc.short_link_id);
        if (!sid) continue;
        const cur = linkClickStats.get(sid) || { total: 0, uniqueIps: new Set<string>() };
        cur.total += 1;
        const ipHash = asTrimmed(lc.ip_hash);
        if (ipHash) cur.uniqueIps.add(ipHash);
        linkClickStats.set(sid, cur);
      }

      const shortLinkIdMap = new Map<string, string>();
      const seenShortCodes = new Set<string>();
      const shortLinkRows: unknown[][] = [];

      for (const sl of rewrittenShortLinks) {
        const legacyId = asTrimmed(sl.row.id);
        if (!legacyId || Number(sl.row.is_deleted ?? 0) === 1 || sl.row.deleted_at) continue;
        const uuid = deterministicUuid(tenantSlug, 'short_links', legacyId);
        shortLinkIdMap.set(legacyId, uuid);

        let shortCode = truncateStr(asTrimmed(sl.row.slug) || `sl_${legacyId}`, 60);
        if (seenShortCodes.has(shortCode)) {
          shortCode = `${shortCode.slice(0, 44)}_${legacyId.slice(0, 12)}`;
        }
        seenShortCodes.add(shortCode);

        const lcStat = linkClickStats.get(legacyId);
        const totalClicks = Math.max(toInt(sl.row.submit_count, 0), lcStat?.total || 0);
        const uniqueClicks = lcStat
          ? Math.max(lcStat.uniqueIps.size, lcStat.total > 0 ? 1 : 0)
          : toInt(sl.row.submit_count, 0);

        shortLinkRows.push([
          uuid,
          tenantId,
          truncateStr(asTrimmed(sl.row.name) || shortCode, 255),
          shortCode,
          sl.targetUrl || publicOrigin,
          asNullableStr(sl.row.utm_source, 100),
          asNullableStr(sl.row.utm_medium, 100),
          asNullableStr(sl.row.utm_campaign, 150),
          JSON.stringify(sl.qrDesign),
          totalClicks,
          uniqueClicks,
          asTrimmed(sl.row.status).toLowerCase() !== 'inactive',
          sl.row.created_by ? userIdMap.get(asTrimmed(sl.row.created_by)) || null : null,
          parseSqlTsOrNow(sl.row.created_at),
        ]);
      }

      targetMigratedCounts.mkt_short_links = await batchExecValues(
        client,
        'mkt_short_links',
        [
          'id',
          'tenant_id',
          'title',
          'short_code',
          'target_url',
          'utm_source',
          'utm_medium',
          'utm_campaign',
          'qr_design_json',
          'click_count',
          'unique_click_count',
          'is_active',
          'created_by',
          'created_at',
        ],
        shortLinkRows,
        `ON CONFLICT (id) DO UPDATE SET
          title = EXCLUDED.title,
          target_url = EXCLUDED.target_url,
          qr_design_json = EXCLUDED.qr_design_json,
          click_count = EXCLUDED.click_count,
          unique_click_count = EXCLUDED.unique_click_count,
          updated_at = clock_timestamp()`,
        100,
        { qr_design_json: 'jsonb' }
      );

      const linkClickRows: unknown[][] = [];
      for (let lcIdx = 0; lcIdx < validLinkClicks.length; lcIdx++) {
        const lc = validLinkClicks[lcIdx];
        const legacyId = asTrimmed(lc.id);
        const slUuid = shortLinkIdMap.get(asTrimmed(lc.short_link_id));
        if (!slUuid) continue;
        const clickKey = legacyId || `auto_${slUuid}_${asTrimmed(lc.ip_hash) || 'ip'}_${asTrimmed(lc.clicked_at) || lcIdx}_${lcIdx}`;
        linkClickRows.push([
          deterministicUuid(tenantSlug, 'link_clicks', clickKey),
          tenantId,
          slUuid,
          truncateStr(asTrimmed(lc.device_type) || 'desktop', 30),
          asNullableStr(lc.ip_hash, 64),
          JSON.stringify({ os: lc.os, country: lc.country, city: lc.city }),
          parseSqlTsOrNow(lc.clicked_at),
        ]);
      }

      targetMigratedCounts.mkt_short_link_clicks = await batchExecValues(
        client,
        'mkt_short_link_clicks',
        ['id', 'tenant_id', 'short_link_id', 'device_type', 'client_ip', 'utm_json', 'clicked_at'],
        linkClickRows,
        `ON CONFLICT (id) DO NOTHING`,
        200,
        { utm_json: 'jsonb' }
      );

      // ----------------------------------------------------------------------
      // F5: Web Properties (strictly ws=1), Web Sessions, Web Events, Blacklist
      // ----------------------------------------------------------------------
      const webPropIdMap = new Map<string, string>();
      const webPropOriginById = new Map<string, string>();
      const seenSiteKeys = new Set<string>();
      const webPropRows: unknown[][] = [];

      for (const wp of parsed.webProperties) {
        const legacyId = asTrimmed(wp.id);
        if (!legacyId || Number(wp.is_deleted ?? 0) === 1 || wp.deleted_at) continue;
        const uuid = deterministicUuid(tenantSlug, 'web_properties', legacyId);
        webPropIdMap.set(legacyId, uuid);
        const rawDomain = asTrimmed(wp.domain).replace(/^https?:\/\//i, '').replace(/\/+$/, '');
        if (rawDomain) webPropOriginById.set(legacyId, `https://${rawDomain}`);

        let siteKey = truncateStr(asTrimmed(wp.api_key) || `wp_${tenantSlug}_${legacyId}`, 80);
        if (seenSiteKeys.has(siteKey)) {
          siteKey = `${siteKey.slice(0, 60)}_${legacyId.slice(0, 16)}`;
        }
        seenSiteKeys.add(siteKey);

        webPropRows.push([
          uuid,
          tenantId,
          truncateStr(asTrimmed(wp.name) || asTrimmed(wp.domain) || `Site ${legacyId}`, 200),
          truncateStr(asTrimmed(wp.domain), 255),
          siteKey,
          asTrimmed(wp.status).toLowerCase() !== 'inactive',
          wp.created_by ? userIdMap.get(asTrimmed(wp.created_by)) || null : null,
          parseSqlTsOrNow(wp.created_at),
        ]);
      }

      targetMigratedCounts.mkt_web_properties = await batchExecValues(
        client,
        'mkt_web_properties',
        ['id', 'tenant_id', 'name', 'domain', 'site_key', 'is_active', 'created_by', 'created_at'],
        webPropRows,
        `ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name, domain = EXCLUDED.domain, is_active = EXCLUDED.is_active, updated_at = clock_timestamp()`
      );

      // Web sessions (deduplicated per property_id + visitor_token due to uk_mkt_web_visitor_prop)
      const PRICING_INTENT_RE = /(?:pricing|bang-gia|hoc-phi|tuition|scholarship|hoc-bong|bao-gia)/i;
      const pricingIntentLegacySessionIds = new Set<string>();
      for (const we of parsed.webEvents) {
        if (
          we.session_id &&
          PRICING_INTENT_RE.test(`${we.target_text || ''} ${we.target_selector || ''} ${we.meta_data || ''}`)
        ) {
          pricingIntentLegacySessionIds.add(we.session_id);
        }
      }

      const pageViewById = new Map<string, (typeof validWebPageViews)[number]>();
      const sessionPageSummary = new Map<
        string,
        {
          firstTs: string;
          lastTs: string;
          entryUrl: string | null;
          lastUrl: string | null;
          identifiedLeadUuid: string | null;
        }
      >();
      const tryMatchLeadFromUrl = (rawUrl: string | null): string | null => {
        if (!rawUrl || !rawUrl.includes('email=')) return null;
        try {
          const u = new URL(rawUrl, 'https://ideas.edu.vn');
          const em = normalizeEmail(u.searchParams.get('email'));
          return em ? emailToUuid.get(em) || null : null;
        } catch {
          return null;
        }
      };

      for (const pv of validWebPageViews) {
        if (pv.id) pageViewById.set(pv.id, pv);
        if (!pv.session_id) continue;
        if (PRICING_INTENT_RE.test(pv.url || '')) {
          pricingIntentLegacySessionIds.add(pv.session_id);
        }
        const loadedTs = parseSqlTsOrNow(pv.loaded_at);
        const pvUrl = pv.url || null;
        const matchedLead = tryMatchLeadFromUrl(pvUrl);
        const cur = sessionPageSummary.get(pv.session_id);
        if (!cur) {
          sessionPageSummary.set(pv.session_id, {
            firstTs: loadedTs,
            lastTs: loadedTs,
            entryUrl: pvUrl,
            lastUrl: pvUrl,
            identifiedLeadUuid: matchedLead,
          });
        } else {
          if (pvUrl && loadedTs < cur.firstTs) {
            cur.firstTs = loadedTs;
            cur.entryUrl = pvUrl;
          }
          if (pvUrl && loadedTs >= cur.lastTs) {
            cur.lastTs = loadedTs;
            cur.lastUrl = pvUrl;
          }
          if (!cur.entryUrl && pvUrl) cur.entryUrl = pvUrl;
          if (!cur.lastUrl && pvUrl) cur.lastUrl = pvUrl;
          if (!cur.identifiedLeadUuid && matchedLead) cur.identifiedLeadUuid = matchedLead;
        }
      }

      const sessionByPropVisitor = new Map<
        string,
        { uuid: string; row: unknown[]; legacySessionId: string; firstSeen: string; lastSeen: string }
      >();
      const legacySessionToUuid = new Map<string, string>();
      const legacySessionEntryUrl = new Map<string, string | null>();
      const sessionUuidToLeadUuid = new Map<string, string>();

      for (const ws of validWebSessions) {
        if (!ws.id || !ws.property_id) continue;
        const propUuid = webPropIdMap.get(ws.property_id);
        if (!propUuid) continue;
        const visitorToken = truncateStr(ws.visitor_id || ws.id, 120);
        const key = `${propUuid}:${visitorToken}`;
        const startedAt = parseSqlTsOrNow(ws.started_at);
        const lastSeen = parseSqlTsOrNow(ws.last_active_at || ws.started_at);
        const pvSum = sessionPageSummary.get(ws.id);
        const resolvedEntryUrl = ws.entry_url || pvSum?.entryUrl || null;
        const resolvedLastUrl = pvSum?.lastUrl || ws.entry_url || resolvedEntryUrl || null;
        const resolvedLeadUuid =
          (ws.contact_id ? contactIdToUuid.get(ws.contact_id) || null : null) ||
          pvSum?.identifiedLeadUuid ||
          null;
        legacySessionEntryUrl.set(ws.id, resolvedEntryUrl);
        const hasPricingIntent =
          pricingIntentLegacySessionIds.has(ws.id) || PRICING_INTENT_RE.test(resolvedEntryUrl || '');
        const existing = sessionByPropVisitor.get(key);

        if (existing) {
          legacySessionToUuid.set(ws.id, existing.uuid);
          if (resolvedLeadUuid && !existing.row[4]) {
            existing.row[4] = resolvedLeadUuid;
            sessionUuidToLeadUuid.set(existing.uuid, resolvedLeadUuid);
          }
          if (resolvedEntryUrl && (!existing.row[5] || startedAt < existing.firstSeen)) {
            existing.firstSeen = startedAt;
            existing.row[5] = resolvedEntryUrl;
          }
          if (resolvedLastUrl && (!existing.row[6] || lastSeen >= existing.lastSeen)) {
            existing.row[6] = resolvedLastUrl;
          }
          // Column indices: 12 = pageviews_count, 13 = pricing_intent_detected, 20 = last_seen_at
          existing.row[12] = Number(existing.row[12]) + Math.max(1, ws.page_count);
          if (hasPricingIntent) existing.row[13] = true;
          if (lastSeen > existing.lastSeen) {
            existing.lastSeen = lastSeen;
            existing.row[20] = lastSeen;
          }
          continue;
        }

        const uuid = deterministicUuid(tenantSlug, 'mkt_web_sessions', key);
        legacySessionToUuid.set(ws.id, uuid);
        if (resolvedLeadUuid) {
          sessionUuidToLeadUuid.set(uuid, resolvedLeadUuid);
        }

        sessionByPropVisitor.set(key, {
          uuid,
          legacySessionId: ws.id,
          firstSeen: startedAt,
          lastSeen,
          row: [
            uuid, // 0
            tenantId, // 1
            propUuid, // 2
            visitorToken, // 3
            resolvedLeadUuid, // 4
            resolvedEntryUrl, // 5
            resolvedLastUrl, // 6
            ws.referrer_source, // 7
            ws.utm_source, // 8
            ws.utm_medium, // 9
            ws.utm_campaign, // 10
            ws.device_type || 'desktop', // 11
            Math.max(1, ws.page_count), // 12: pageviews_count
            hasPricingIntent, // 13: pricing_intent_detected
            ws.country || 'VN', // 14: geo_country
            ws.city, // 15: geo_city
            ws.browser, // 16: browser
            ws.os, // 17: os
            Math.max(0, ws.duration_seconds), // 18: duration_seconds
            startedAt, // 19: started_at
            lastSeen, // 20: last_seen_at
          ],
        });
      }

      // Batch insert web sessions via fast multi-VALUES
      const webSessRows = Array.from(sessionByPropVisitor.values()).map((v) => v.row);
      targetMigratedCounts.mkt_web_sessions = await batchExecValues(
        client,
        'mkt_web_sessions',
        [
          'id',
          'tenant_id',
          'property_id',
          'visitor_token',
          'lead_id',
          'entry_url',
          'last_url',
          'referrer',
          'utm_source',
          'utm_medium',
          'utm_campaign',
          'device_type',
          'pageviews_count',
          'pricing_intent_detected',
          'geo_country',
          'geo_city',
          'browser',
          'os',
          'duration_seconds',
          'started_at',
          'last_seen_at',
        ],
        webSessRows,
        `ON CONFLICT (tenant_id, property_id, visitor_token) DO UPDATE SET
          lead_id = COALESCE(EXCLUDED.lead_id, mkt_web_sessions.lead_id),
          entry_url = COALESCE(mkt_web_sessions.entry_url, EXCLUDED.entry_url),
          last_url = COALESCE(EXCLUDED.last_url, mkt_web_sessions.last_url),
          device_type = EXCLUDED.device_type,
          os = EXCLUDED.os,
          pageviews_count = EXCLUDED.pageviews_count,
          pricing_intent_detected = mkt_web_sessions.pricing_intent_detected OR EXCLUDED.pricing_intent_detected,
          last_seen_at = EXCLUDED.last_seen_at`,
        400
      );

      // Web events + page views via high-speed UNNEST batches
      const webEventIds: string[] = [];
      const webEventPropIds: string[] = [];
      const webEventSessIds: string[] = [];
      const webEventLeadIds: Array<string | null> = [];
      const webEventTypes: string[] = [];
      const webEventUrls: string[] = [];
      const webEventSelectors: Array<string | null> = [];
      const webEventXPcts: Array<number | null> = [];
      const webEventYPcts: Array<number | null> = [];
      const webEventScrolls: Array<number | null> = [];
      const webEventMetaJsons: string[] = [];
      const webEventCreated: string[] = [];
      const seenWebEventUuids = new Set<string>();

      const resolveEventPageUrl = (
        propLegacyId: string,
        sessionLegacyId: string,
        pageViewLegacyId: string | null,
        md: Record<string, unknown> | null
      ): string => {
        if (pageViewLegacyId) {
          const linkedPv = pageViewById.get(pageViewLegacyId);
          if (linkedPv?.url) return linkedPv.url;
        }
        const origin = webPropOriginById.get(propLegacyId) || '';
        const mdPath = typeof md?.path === 'string' ? md.path.trim() : '';
        if (mdPath) {
          if (/^https?:\/\//i.test(mdPath)) return mdPath;
          if (origin) return `${origin}${mdPath.startsWith('/') ? mdPath : `/${mdPath}`}`;
          return mdPath;
        }
        const mdHref = typeof md?.href === 'string' ? md.href.trim() : '';
        if (mdHref && /^https?:\/\//i.test(mdHref)) return mdHref;
        const sessEntry = legacySessionEntryUrl.get(sessionLegacyId);
        if (sessEntry) return sessEntry;
        return origin ? `${origin}/` : '/';
      };

      const clampPct = (val: number, maxVal = 100): number =>
        Number(Math.max(0, Math.min(maxVal, val)).toFixed(2));

      for (let weIdx = 0; weIdx < parsed.webEvents.length; weIdx++) {
        const we = parsed.webEvents[weIdx];
        if (!we.id || !we.property_id || !we.session_id) continue;
        const propUuid = webPropIdMap.get(we.property_id);
        const sessUuid = legacySessionToUuid.get(we.session_id);
        if (!propUuid || !sessUuid) continue;
        let evtUuid = deterministicUuid(tenantSlug, 'web_events', we.id);
        if (seenWebEventUuids.has(evtUuid)) {
          evtUuid = deterministicUuid(tenantSlug, 'web_events', `${we.id}:${we.created_at || weIdx}:${weIdx}`);
        }
        seenWebEventUuids.add(evtUuid);

        const evtType = truncateStr(we.event_type || 'click', 40);
        const md = we.meta_data ? parseJsonSafe<Record<string, unknown>>(we.meta_data) : null;
        const pageUrl = resolveEventPageUrl(we.property_id, we.session_id, we.page_view_id, md);

        let xPct: number | null = null;
        let yPct: number | null = null;
        if (md && typeof md.x === 'number' && typeof md.vw === 'number' && md.vw > 0) {
          xPct = clampPct((md.x / md.vw) * 100, 100);
          if (typeof md.y === 'number' && typeof md.vh === 'number' && md.vh > 0) {
            yPct = clampPct((md.y / md.vh) * 100, 100);
          }
        }

        let scrollPct: number | null = null;
        if (evtType === 'scroll' && we.target_text) {
          const parsedScroll = Number(String(we.target_text).trim());
          if (Number.isFinite(parsedScroll)) {
            scrollPct = Math.max(0, Math.min(100, Math.round(parsedScroll)));
          }
        }

        const metaObj: Record<string, unknown> = {};
        const elText = asNullableStr((md?.text as SqlCell) ?? (evtType !== 'scroll' ? we.target_text : null), 300);
        if (elText) metaObj.element_text = elText;
        const elTag = asNullableStr((md?.tag ?? md?.element) as SqlCell, 40);
        if (elTag) metaObj.element_tag = elTag;
        const href = asNullableStr(md?.href as SqlCell, 500);
        if (href) metaObj.href = href;
        const mdPath = asNullableStr(md?.path as SqlCell, 300);
        if (mdPath) metaObj.path = mdPath;
        if (typeof md?.x === 'number' && typeof md?.y === 'number') {
          metaObj.raw_coords = { x: md.x, y: md.y, vw: md.vw ?? null, vh: md.vh ?? null };
        }

        webEventIds.push(evtUuid);
        webEventPropIds.push(propUuid);
        webEventSessIds.push(sessUuid);
        webEventLeadIds.push(sessionUuidToLeadUuid.get(sessUuid) || null);
        webEventTypes.push(evtType);
        webEventUrls.push(pageUrl);
        webEventSelectors.push(we.target_selector);
        webEventXPcts.push(xPct);
        webEventYPcts.push(yPct);
        webEventScrolls.push(scrollPct);
        webEventMetaJsons.push(JSON.stringify(metaObj));
        webEventCreated.push(parseSqlTsOrNow(we.created_at));
      }

      for (const pv of validWebPageViews) {
        if (!pv.id || !pv.property_id || !pv.session_id) continue;
        const propUuid = webPropIdMap.get(pv.property_id);
        const sessUuid = legacySessionToUuid.get(pv.session_id);
        if (!propUuid || !sessUuid) continue;
        const evtUuid = deterministicUuid(tenantSlug, 'web_page_views', pv.id);
        if (seenWebEventUuids.has(evtUuid)) continue;
        seenWebEventUuids.add(evtUuid);

        const pvMeta: Record<string, unknown> = {};
        if (pv.title) pvMeta.page_title = pv.title;

        webEventIds.push(evtUuid);
        webEventPropIds.push(propUuid);
        webEventSessIds.push(sessUuid);
        webEventLeadIds.push(sessionUuidToLeadUuid.get(sessUuid) || null);
        webEventTypes.push('pageview');
        webEventUrls.push(pv.url || '/');
        webEventSelectors.push(null);
        webEventXPcts.push(null);
        webEventYPcts.push(null);
        webEventScrolls.push(pv.scroll_depth);
        webEventMetaJsons.push(JSON.stringify(pvMeta));
        webEventCreated.push(parseSqlTsOrNow(pv.loaded_at));
      }

      const UNNEST_BATCH = 2000;
      let webEventsInserted = 0;
      for (let s = 0; s < webEventIds.length; s += UNNEST_BATCH) {
        const e = Math.min(webEventIds.length, s + UNNEST_BATCH);
        await client.query(
          `INSERT INTO mkt_web_events (
            id, tenant_id, property_id, session_id, lead_id, event_type,
            page_url, element_selector, x_pct, y_pct, scroll_depth_pct, metadata, created_at
          )
          SELECT u.id, $1::uuid, u.prop_id, u.sess_id, u.lead_id, u.evt_type,
                 u.page_url, u.sel, u.x_pct, u.y_pct, u.scroll_pct, u.meta, u.created_at
          FROM UNNEST(
            $2::uuid[], $3::uuid[], $4::uuid[], $5::uuid[], $6::varchar[],
            $7::text[], $8::varchar[], $9::numeric[], $10::numeric[], $11::int[],
            $12::jsonb[], $13::timestamptz[]
          ) AS u(id, prop_id, sess_id, lead_id, evt_type, page_url, sel, x_pct, y_pct, scroll_pct, meta, created_at)
          ON CONFLICT (id) DO UPDATE SET
            lead_id = COALESCE(EXCLUDED.lead_id, mkt_web_events.lead_id),
            event_type = EXCLUDED.event_type,
            page_url = EXCLUDED.page_url,
            element_selector = EXCLUDED.element_selector,
            x_pct = EXCLUDED.x_pct,
            y_pct = EXCLUDED.y_pct,
            scroll_depth_pct = EXCLUDED.scroll_depth_pct,
            metadata = EXCLUDED.metadata`,
          [
            tenantId,
            webEventIds.slice(s, e),
            webEventPropIds.slice(s, e),
            webEventSessIds.slice(s, e),
            webEventLeadIds.slice(s, e),
            webEventTypes.slice(s, e),
            webEventUrls.slice(s, e),
            webEventSelectors.slice(s, e),
            webEventXPcts.slice(s, e),
            webEventYPcts.slice(s, e),
            webEventScrolls.slice(s, e),
            webEventMetaJsons.slice(s, e),
            webEventCreated.slice(s, e),
          ]
        );
        webEventsInserted += e - s;
      }
      targetMigratedCounts.mkt_web_events = webEventsInserted;

      // Web blacklist -> `blacklist_entries`
      const blacklistRows: unknown[][] = [];
      for (const wb of parsed.webBlacklist) {
        const ip = truncateStr(asTrimmed(wb.ip_address), 255);
        if (!ip) continue;
        blacklistRows.push([
          deterministicUuid(tenantSlug, 'web_blacklist', `${wb.id}:${ip}`),
          tenantId,
          'ip',
          ip,
          asNullableStr(wb.reason) || 'Migrated web_blacklist',
          parseSqlTsOrNow(wb.created_at),
        ]);
      }
      targetMigratedCounts.blacklist_entries = await batchExecValues(
        client,
        'blacklist_entries',
        ['id', 'tenant_id', 'entry_type', 'value', 'reason', 'created_at'],
        blacklistRows,
        `ON CONFLICT (tenant_id, entry_type, value) DO NOTHING`
      );

      // ----------------------------------------------------------------------
      // F5: AI Bot Config, AI Training Docs, Automation Scenarios
      // ----------------------------------------------------------------------
      if (parsed.aiChatbotSettings.length > 0 || parsed.aiChatbots.length > 0) {
        const primaryProp = parsed.webProperties.find((w) => asTrimmed(w.domain).includes('ideas.edu.vn'));
        const primaryBotSetting =
          (primaryProp
            ? parsed.aiChatbotSettings.find((s) => asTrimmed(s.property_id) === asTrimmed(primaryProp.id))
            : undefined) || parsed.aiChatbotSettings[0];

        const botName = truncateStr(asTrimmed(primaryBotSetting?.bot_name) || 'IDEAS AI Assistant', 150);
        const persona = asNullableStr(primaryBotSetting?.persona_prompt || primaryBotSetting?.system_instruction);
        const welcome = asNullableStr(primaryBotSetting?.welcome_msg);
        const faqRules = parsed.aiChatbotScenarios.map((sc) => ({
          id: sc.id,
          title: asTrimmed(sc.title),
          keywords: parseJsonSafe(sc.trigger_keywords) ?? asTrimmed(sc.trigger_keywords),
          reply_text: asStr(sc.reply_text),
          is_active: Boolean(Number(sc.is_active ?? 1)),
        }));

        await client.query(
          `INSERT INTO mkt_ai_bot_configs (
            id, tenant_id, bot_name, brand_persona, welcome_message,
            channels_json, faq_rules_json, auto_extract_contact, is_active, updated_at
          ) VALUES (
            $1, $2, $3, $4, $5,
            '["messenger","web_chat"]'::jsonb, $6::jsonb, true, $7, clock_timestamp()
          )
          ON CONFLICT (tenant_id) DO UPDATE SET
            bot_name = EXCLUDED.bot_name,
            brand_persona = EXCLUDED.brand_persona,
            welcome_message = EXCLUDED.welcome_message,
            channels_json = '["messenger","web_chat"]'::jsonb,
            faq_rules_json = EXCLUDED.faq_rules_json,
            is_active = EXCLUDED.is_active,
            updated_at = clock_timestamp()`,
          [
            deterministicUuid(tenantSlug, 'mkt_ai_bot_configs', 'primary'),
            tenantId,
            botName,
            persona,
            welcome,
            JSON.stringify(faqRules),
            Boolean(Number(primaryBotSetting?.is_enabled ?? 1)),
          ]
        );
        targetMigratedCounts.mkt_ai_bot_configs = 1;
      }

      // AI Training Docs (omitting binary embedding_binary!)
      const trainDocRows: unknown[][] = [];
      for (const td of rewrittenTrainingDocs) {
        const legacyId = asTrimmed(td.row.id);
        if (!legacyId) continue;
        const stats = parsed.domationAiChunkStats.get(legacyId) || { chunks: 1, tokens: 0 };
        const meta = td.meta as Record<string, unknown>;
        trainDocRows.push([
          deterministicUuid(tenantSlug, 'domation_ai_training_docs', legacyId),
          tenantId,
          truncateStr(asTrimmed(td.row.name) || asTrimmed(td.row.filename) || `Doc ${legacyId}`, 255),
          truncateStr(asTrimmed(td.row.source_type || td.row.type) || 'faq', 40),
          typeof meta?.file_url === 'string' ? meta.file_url : null,
          asStr(td.row.content),
          Math.max(1, stats.chunks),
          Math.max(0, stats.tokens),
          truncateStr(asTrimmed(td.row.status) || 'indexed', 30),
          JSON.stringify({ ...meta, legacy_doc_id: legacyId, property_id: td.row.property_id }),
          parseSqlTsOrNow(td.row.created_at),
          parseSqlTsOrNow(td.row.updated_at || td.row.created_at),
        ]);
      }

      targetMigratedCounts.mkt_ai_training_docs = await batchExecValues(
        client,
        'mkt_ai_training_docs',
        [
          'id',
          'tenant_id',
          'title',
          'doc_type',
          'source_url',
          'content_text',
          'chunk_count',
          'token_count',
          'status',
          'metadata_json',
          'created_at',
          'updated_at',
        ],
        trainDocRows,
        `ON CONFLICT (id) DO UPDATE SET
          title = EXCLUDED.title,
          content_text = EXCLUDED.content_text,
          chunk_count = EXCLUDED.chunk_count,
          token_count = EXCLUDED.token_count,
          metadata_json = EXCLUDED.metadata_json,
          updated_at = clock_timestamp()`,
        100,
        { metadata_json: 'jsonb' }
      );

      // Automation Scenarios (`meta_automation_scenarios` + `ai_chatbot_scenarios`)
      const scenarioRows: unknown[][] = [];
      for (const ms of parsed.metaAutomationScenarios) {
        const legacyId = asTrimmed(ms.id);
        if (!legacyId) continue;
        scenarioRows.push([
          deterministicUuid(tenantSlug, 'meta_automation_scenarios', legacyId),
          tenantId,
          truncateStr(asTrimmed(ms.name) || `Meta Scenario ${legacyId}`, 200),
          'messenger',
          truncateStr(asTrimmed(ms.trigger_type) || 'keyword', 50),
          JSON.stringify(parseJsonSafe(ms.keywords) ?? (ms.keywords ? [asStr(ms.keywords)] : [])),
          JSON.stringify([{ type: ms.response_type || 'text', content: ms.response_content, buttons: parseJsonSafe(ms.buttons) ?? [] }]),
          '[]',
          JSON.stringify({ page_id: ms.page_id, match_type: ms.match_type, priority: ms.priority }),
          Boolean(Number(ms.is_active ?? 1)),
          parseSqlTsOrNow(ms.created_at),
          parseSqlTsOrNow(ms.updated_at || ms.created_at),
        ]);
      }
      for (const cs of parsed.aiChatbotScenarios) {
        const legacyId = asTrimmed(cs.id);
        if (!legacyId) continue;
        scenarioRows.push([
          deterministicUuid(tenantSlug, 'ai_chatbot_scenarios', legacyId),
          tenantId,
          truncateStr(asTrimmed(cs.title) || `Web Chat Scenario ${legacyId}`, 200),
          'web_chat',
          'keyword',
          JSON.stringify(parseJsonSafe(cs.trigger_keywords) ?? (cs.trigger_keywords ? [asStr(cs.trigger_keywords)] : [])),
          JSON.stringify(parseJsonSafe(cs.flow_data) ?? [{ type: 'reply', text: cs.reply_text }]),
          '[]',
          JSON.stringify({ property_id: cs.property_id, match_mode: cs.match_mode }),
          Boolean(Number(cs.is_active ?? 1)),
          parseSqlTsOrNow(cs.created_at),
          parseSqlTsOrNow(cs.updated_at || cs.created_at),
        ]);
      }

      targetMigratedCounts.mkt_automation_scenarios = await batchExecValues(
        client,
        'mkt_automation_scenarios',
        [
          'id',
          'tenant_id',
          'name',
          'channel',
          'trigger_type',
          'keywords_json',
          'nodes_json',
          'edges_json',
          'settings_json',
          'is_active',
          'created_at',
          'updated_at',
        ],
        scenarioRows,
        `ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name, nodes_json = EXCLUDED.nodes_json, updated_at = clock_timestamp()`,
        100,
        { keywords_json: 'jsonb', nodes_json: 'jsonb', edges_json: 'jsonb', settings_json: 'jsonb' }
      );

      // ----------------------------------------------------------------------
      // F6: Meta CAPI Logs, CAPI Blocked Phones (128k+ UNNEST), Messenger & Web Chat Conversations
      // ----------------------------------------------------------------------
      const capiLogRows: unknown[][] = [];
      for (const cl of parsed.capiLogs) {
        const legacyId = asTrimmed(cl.id);
        const leadUuid =
          (cl.contact_id ? contactIdToUuid.get(asTrimmed(cl.contact_id)) : undefined) ||
          (cl.lead_id ? legacyLeadIdToUuid.get(asTrimmed(cl.lead_id)) : undefined);
        if (!legacyId || !leadUuid) {
          quarantined.orphan_capi_logs += 1;
          continue;
        }
        capiLogRows.push([
          deterministicUuid(tenantSlug, 'capi_logs', legacyId),
          tenantId,
          leadUuid,
          truncateStr(asTrimmed(cl.pixel_id) || creds.metaPixelId, 100),
          truncateStr(asTrimmed(cl.event_name) || 'Lead', 100),
          truncateStr(asTrimmed(cl.event_id) || `myerp_capi_${legacyId}`, 255),
          truncateStr(asTrimmed(cl.action_source) || 'system_generated', 50),
          JSON.stringify({ emq_signals: cl.emq_signals, trigger_stage: cl.trigger_stage }),
          JSON.stringify(parseJsonSafe(cl.sent_payload) ?? {}),
          toInt(cl.response_status, 200),
          JSON.stringify(parseJsonSafe(cl.response_body) ?? {}),
          parseSqlTsOrNow(cl.sent_at),
        ]);
      }

      targetMigratedCounts.capi_logs = await batchExecValues(
        client,
        'capi_logs',
        [
          'id',
          'tenant_id',
          'lead_id',
          'dataset_id',
          'event_name',
          'event_id',
          'action_source',
          'match_keys',
          'sent_payload',
          'response_status',
          'response_body',
          'sent_at',
        ],
        capiLogRows,
        `ON CONFLICT (id) DO NOTHING`,
        200,
        { match_keys: 'jsonb', sent_payload: 'jsonb', response_body: 'jsonb' }
      );

      // `capi_blocked_phones` (128,302 rows -> deduplicated + UNNEST bulk upsert!)
      const blockedByPhone = new Map<
        string,
        { id: string; phone: string; hash: string; reason: string | null; source: string; createdBy: string | null; createdAt: string }
      >();
      for (const bp of parsed.capiBlockedPhones) {
        if (blockedByPhone.has(bp.phone_normalized)) continue;
        blockedByPhone.set(bp.phone_normalized, {
          id: deterministicUuid(tenantSlug, 'capi_blocked_phones', bp.phone_normalized),
          phone: bp.phone_normalized,
          hash: sha256Hex(bp.phone_normalized),
          reason: bp.reason,
          source: bp.source_label || 'myerp_migration',
          createdBy: bp.created_by ? userIdMap.get(bp.created_by) || null : null,
          createdAt: parseSqlTsOrNow(bp.created_at),
        });
      }

      const blockedArr = Array.from(blockedByPhone.values());
      const BP_BATCH = 2500;
      let bpInserted = 0;
      for (let s = 0; s < blockedArr.length; s += BP_BATCH) {
        const chunk = blockedArr.slice(s, s + BP_BATCH);
        await client.query(
          `INSERT INTO capi_blocked_phones (
            id, tenant_id, phone_normalized, phone_hash, reason, source, created_by, created_at
          )
          SELECT u.id, $1::uuid, u.phone, u.phash, u.reason, u.src, u.created_by, u.created_at
          FROM UNNEST(
            $2::uuid[], $3::varchar[], $4::varchar[], $5::text[], $6::varchar[], $7::uuid[], $8::timestamptz[]
          ) AS u(id, phone, phash, reason, src, created_by, created_at)
          ON CONFLICT (tenant_id, phone_normalized) DO UPDATE SET
            reason = EXCLUDED.reason,
            source = EXCLUDED.source,
            updated_at = clock_timestamp()`,
          [
            tenantId,
            chunk.map((x) => x.id),
            chunk.map((x) => x.phone),
            chunk.map((x) => x.hash),
            chunk.map((x) => x.reason),
            chunk.map((x) => x.source),
            chunk.map((x) => x.createdBy),
            chunk.map((x) => x.createdAt),
          ]
        );
        bpInserted += chunk.length;
      }
      targetMigratedCounts.capi_blocked_phones = bpInserted;

      // Meta Messenger + Web Chat Social Conversations & Messages
      const metaSubByPagePsid = new Map<string, RowObj>();
      for (const ms of parsed.metaSubscribers) {
        const key = `${asTrimmed(ms.page_id)}:${asTrimmed(ms.psid)}`;
        metaSubByPagePsid.set(key, ms);
      }

      const socialConvMap = new Map<string, unknown[]>();
      const metaConvIdByPagePsid = new Map<string, string>();
      const aiConvIdMap = new Map<string, string>();

      for (const mc of parsed.metaConversations) {
        const pageId = asTrimmed(mc.page_id);
        const psid = asTrimmed(mc.psid);
        if (!pageId || !psid) continue;
        const extThread = truncateStr(`${pageId}:${psid}`, 150);
        const convUuid = deterministicUuid(tenantSlug, 'meta_conversations', extThread);
        metaConvIdByPagePsid.set(extThread, convUuid);

        const msub = metaSubByPagePsid.get(extThread);
        const leadUuid =
          (mc.contact_id ? contactIdToUuid.get(asTrimmed(mc.contact_id)) : undefined) ||
          (msub?.contact_id ? contactIdToUuid.get(asTrimmed(msub.contact_id)) : undefined) ||
          (msub?.subscriber_id ? subIdToUuid.get(asTrimmed(msub.subscriber_id)) : undefined) ||
          null;

        socialConvMap.set(`messenger:${extThread}`, [
          convUuid,
          tenantId,
          'messenger',
          extThread,
          truncateStr(asTrimmed(msub?.name || msub?.first_name) || `Messenger ${psid.slice(-6)}`, 150),
          sanitizeMigratedAvatarUrl(msub?.avatar_url || msub?.profile_pic),
          normalizePhoneDisplay(msub?.phone),
          normalizeEmail(msub?.email),
          leadUuid,
          !Boolean(Number(mc.ai_enabled ?? 1)),
          toInt(mc.unread_count, 0),
          truncateStr(asTrimmed(mc.status) || 'open', 30),
          asNullableStr(mc.last_message_snippet),
          parseSqlTsOrNow(mc.last_message_time || mc.updated_at || mc.created_at),
          parseSqlTsOrNow(mc.created_at),
        ]);
      }

      const aiConvPropCounts = new Map<string, number>();
      const normWpDomain = (d: SqlCell | undefined) =>
        asTrimmed(d).toLowerCase().replace(/^https?:\/\//, '').replace(/\/+$/, '');
      const primaryWebProp =
        parsed.webProperties.find((w) => normWpDomain(w.domain) === 'ideas.edu.vn') ||
        parsed.webProperties.find((w) => asTrimmed(w.name).toLowerCase() === 'ideas.edu.vn') ||
        parsed.webProperties.find(
          (w) => normWpDomain(w.domain).includes('ideas.edu.vn') && !normWpDomain(w.domain).startsWith('ai.')
        ) ||
        parsed.webProperties.find((w) => normWpDomain(w.domain).includes('ideas.edu.vn')) ||
        parsed.webProperties[0];
      const primaryWebPropLegacyId = primaryWebProp ? asTrimmed(primaryWebProp.id) : '';

      for (const ac of parsed.domationAiConversations) {
        const legacyId = asTrimmed(ac.id);
        if (!legacyId) continue;
        const rawAcPropId = asTrimmed(ac.property_id);
        const mappedWebPropUuid = rawAcPropId ? webPropIdMap.get(rawAcPropId) : undefined;
        const bucketPropKey = mappedWebPropUuid ? rawAcPropId : primaryWebPropLegacyId;
        if (bucketPropKey) {
          aiConvPropCounts.set(bucketPropKey, (aiConvPropCounts.get(bucketPropKey) || 0) + 1);
        }
        const extThread = truncateStr(`ai_${legacyId}`, 150);
        const convUuid = deterministicUuid(tenantSlug, 'domation_ai_conversations', legacyId);
        aiConvIdMap.set(legacyId, convUuid);
        const leadUuid = ac.contact_id ? contactIdToUuid.get(asTrimmed(ac.contact_id)) || null : null;

        socialConvMap.set(`web_chat:${extThread}`, [
          convUuid,
          tenantId,
          'web_chat',
          extThread,
          truncateStr(`Web Visitor ${asTrimmed(ac.visitor_id).slice(0, 12) || legacyId.slice(0, 8)}`, 150),
          null,
          null,
          null,
          leadUuid,
          false,
          0,
          truncateStr(asTrimmed(ac.status) || 'open', 30),
          asNullableStr(ac.last_message),
          parseSqlTsOrNow(ac.last_message_at || ac.updated_at || ac.created_at),
          parseSqlTsOrNow(ac.created_at),
        ]);
      }

      const aiTrainingPropertyStats: Record<string, { queries_count: number }> = {};
      for (const [legacyPropId, cnt] of aiConvPropCounts.entries()) {
        aiTrainingPropertyStats[legacyPropId] = { queries_count: cnt };
        const mappedUuid = webPropIdMap.get(legacyPropId);
        if (mappedUuid) {
          aiTrainingPropertyStats[mappedUuid] = { queries_count: cnt };
        }
      }
      aiTrainingPropertyStatsOut = aiTrainingPropertyStats;

      targetMigratedCounts.mkt_social_conversations = await batchExecValues(
        client,
        'mkt_social_conversations',
        [
          'id',
          'tenant_id',
          'channel',
          'external_thread_id',
          'customer_name',
          'customer_avatar',
          'extracted_phone',
          'extracted_email',
          'lead_id',
          'bot_paused',
          'unread_count',
          'status',
          'last_message_preview',
          'last_message_at',
          'created_at',
        ],
        Array.from(socialConvMap.values()),
        `ON CONFLICT (tenant_id, channel, external_thread_id) DO UPDATE SET
          last_message_preview = EXCLUDED.last_message_preview,
          last_message_at = EXCLUDED.last_message_at,
          lead_id = COALESCE(EXCLUDED.lead_id, mkt_social_conversations.lead_id)`,
        300
      );

      // Social messages (`meta_message_logs` + `domation_ai_messages`)
      const socialMsgRows: unknown[][] = [];
      for (const mm of parsed.metaMessageLogs) {
        if (!mm.id || !mm.page_id || !mm.psid) continue;
        const convUuid = metaConvIdByPagePsid.get(truncateStr(`${mm.page_id}:${mm.psid}`, 150));
        if (!convUuid) continue;
        const dir = (mm.direction || '').toLowerCase();
        const senderType = dir === 'in' || dir === 'inbound' || dir === 'received' ? 'customer' : 'agent';
        socialMsgRows.push([
          deterministicUuid(tenantSlug, 'meta_message_logs', mm.id),
          tenantId,
          convUuid,
          senderType,
          senderType === 'customer' ? 'Customer' : 'IDEAS Page',
          mm.content || '[attachment]',
          parseSqlTsOrNow(mm.timestamp || mm.created_at),
        ]);
      }

      for (const am of parsed.domationAiMessages) {
        if (!am.id || !am.conversation_id) continue;
        const convUuid = aiConvIdMap.get(am.conversation_id);
        if (!convUuid) continue;
        const s = (am.sender || '').toLowerCase();
        const senderType = s === 'user' || s === 'visitor' || s === 'customer' ? 'customer' : s === 'agent' ? 'agent' : 'bot';
        socialMsgRows.push([
          deterministicUuid(tenantSlug, 'domation_ai_messages', am.id),
          tenantId,
          convUuid,
          senderType,
          senderType === 'customer' ? 'Visitor' : 'IDEAS AI Bot',
          am.message || '',
          parseSqlTsOrNow(am.created_at),
        ]);
      }

      targetMigratedCounts.mkt_social_messages = await batchExecValues(
        client,
        'mkt_social_messages',
        ['id', 'tenant_id', 'conversation_id', 'sender_type', 'sender_name', 'content', 'created_at'],
        socialMsgRows,
        `ON CONFLICT (id) DO NOTHING`,
        500
      );

      // ----------------------------------------------------------------------
      // Immutable Append-Only `lead_timeline_events` (STRICTLY `ON CONFLICT (id) DO NOTHING`!)
      // Sources: `distribution_logs`, non-campaign `mail_delivery_logs`, `subscriber_activity`, `meta_customer_journey`
      // ----------------------------------------------------------------------
      const tlIds: string[] = [];
      const tlLeadIds: string[] = [];
      const tlEventTypes: string[] = [];
      const tlEventCats: string[] = [];
      const tlActorIds: Array<string | null> = [];
      const tlActorRoles: string[] = [];
      const tlTitles: string[] = [];
      const tlContents: Array<string | null> = [];
      const tlMetadata: string[] = [];
      const tlCreated: string[] = [];

      const pushTimeline = (
        id: string,
        leadId: string,
        eventType: string,
        eventCat: string,
        actorId: string | null,
        actorRole: string,
        title: string,
        content: string | null,
        meta: Record<string, unknown>,
        createdAt: string
      ) => {
        tlIds.push(id);
        tlLeadIds.push(leadId);
        tlEventTypes.push(truncateStr(eventType, 100));
        tlEventCats.push(truncateStr(eventCat, 30));
        tlActorIds.push(actorId);
        tlActorRoles.push(truncateStr(actorRole, 30));
        tlTitles.push(truncateStr(title, 255));
        tlContents.push(content);
        tlMetadata.push(JSON.stringify(meta));
        tlCreated.push(createdAt);
      };

      for (const dl of parsed.distributionLogs) {
        if (!dl.id) continue;
        const leadUuid = legacyLeadIdToUuid.get(dl.lead_id);
        if (!leadUuid) {
          quarantined.orphan_distribution_logs += 1;
          continue;
        }
        const actorUuid = dl.assigned_to ? userIdMap.get(dl.assigned_to) || null : null;
        const st = (dl.status || '').toLowerCase();
        const evType = st.includes('dup') ? 'duplicate_reminder' : st.includes('recall') ? 'lead_recalled' : 'lead_assigned';
        pushTimeline(
          deterministicUuid(tenantSlug, 'distribution_logs', dl.id),
          leadUuid,
          evType,
          'pipeline',
          actorUuid,
          'system',
          dl.message || `Lead distributed (${dl.status || 'assigned'})`,
          dl.message,
          { legacy_dist_log_id: dl.id, round_id: dl.round_id, status: dl.status },
          parseSqlTsOrNow(dl.received_at)
        );
      }

      for (const dl of nonCampaignDeliveries) {
        if (!dl.id) continue;
        const leadUuid =
          (dl.subscriber_id ? subIdToUuid.get(dl.subscriber_id) : undefined) ||
          (dl.recipient ? emailToUuid.get(dl.recipient.trim().toLowerCase()) : undefined);
        if (!leadUuid) continue;
        pushTimeline(
          deterministicUuid(tenantSlug, 'mail_delivery_logs', dl.id),
          leadUuid,
          'mkt_email_sent',
          'communication',
          null,
          'system',
          dl.subject || 'Email sent',
          dl.error_message,
          { legacy_delivery_log_id: dl.id, flow_id: dl.flow_id, status: dl.status },
          parseSqlTsOrNow(dl.sent_at || dl.created_at)
        );
      }

      for (const sa of parsed.subscriberActivity) {
        if (!sa.id) continue;
        const leadUuid =
          (sa.subscriber_id ? subIdToUuid.get(sa.subscriber_id) : undefined) ||
          (sa.contact_id ? contactIdToUuid.get(sa.contact_id) : undefined);
        if (!leadUuid) continue;
        const rawType = (sa.type || sa.action_type || 'activity').toLowerCase();
        const mappedType = rawType.includes('open')
          ? 'email_opened'
          : rawType.includes('click')
            ? 'email_clicked'
            : rawType.includes('bounce')
              ? 'email_bounced'
              : rawType.includes('unsub')
                ? 'email_unsubscribed'
                : rawType.includes('form')
                  ? 'form_submitted'
                  : rawType.includes('survey')
                    ? 'survey_completed'
                    : rawType.includes('page') || rawType.includes('web')
                      ? 'web_page_view'
                      : rawType;
        pushTimeline(
          deterministicUuid(tenantSlug, 'subscriber_activity', sa.id),
          leadUuid,
          mappedType,
          'communication',
          null,
          'system',
          sa.reference_name || sa.target_name || mappedType,
          sa.details,
          { legacy_sub_activity_id: sa.id, campaign_id: sa.campaign_id, flow_id: sa.flow_id },
          parseSqlTsOrNow(sa.created_at)
        );
      }

      for (const mj of parsed.metaCustomerJourney) {
        if (!mj.id || !mj.page_id || !mj.psid) continue;
        const msub = metaSubByPagePsid.get(`${mj.page_id}:${mj.psid}`);
        const leadUuid =
          (msub?.contact_id ? contactIdToUuid.get(asTrimmed(msub.contact_id)) : undefined) ||
          (msub?.subscriber_id ? subIdToUuid.get(asTrimmed(msub.subscriber_id)) : undefined);
        if (!leadUuid) continue;
        pushTimeline(
          deterministicUuid(tenantSlug, 'meta_customer_journey', mj.id),
          leadUuid,
          mj.event_type || 'meta_journey_event',
          'communication',
          null,
          'system',
          mj.event_name || mj.event_type || 'Meta Journey',
          mj.event_data,
          { legacy_meta_journey_id: mj.id, page_id: mj.page_id, psid: mj.psid },
          parseSqlTsOrNow(mj.created_at)
        );
      }

      let timelineInserted = 0;
      for (let s = 0; s < tlIds.length; s += UNNEST_BATCH) {
        const e = Math.min(tlIds.length, s + UNNEST_BATCH);
        await client.query(
          `INSERT INTO lead_timeline_events (
            id, tenant_id, lead_id, event_type, event_category, actor_id, actor_role, title, content, metadata, created_at
          )
          SELECT u.id, $1::uuid, u.lead_id, u.ev_type, u.ev_cat, u.actor_id, u.actor_role, u.title, u.content, u.meta::jsonb, u.created_at
          FROM UNNEST(
            $2::uuid[], $3::uuid[], $4::varchar[], $5::varchar[], $6::uuid[],
            $7::varchar[], $8::varchar[], $9::text[], $10::text[], $11::timestamptz[]
          ) AS u(id, lead_id, ev_type, ev_cat, actor_id, actor_role, title, content, meta, created_at)
          ON CONFLICT (id) DO NOTHING`,
          [
            tenantId,
            tlIds.slice(s, e),
            tlLeadIds.slice(s, e),
            tlEventTypes.slice(s, e),
            tlEventCats.slice(s, e),
            tlActorIds.slice(s, e),
            tlActorRoles.slice(s, e),
            tlTitles.slice(s, e),
            tlContents.slice(s, e),
            tlMetadata.slice(s, e),
            tlCreated.slice(s, e),
          ]
        );
        timelineInserted += e - s;
      }
      targetMigratedCounts.lead_timeline_events = timelineInserted;

      // ----------------------------------------------------------------------
      // F7 & F8: Encrypted Credentials Vault (`tenant_integrations`)
      // ----------------------------------------------------------------------
      const upsertVault = async (integrationType: string, payload: Record<string, unknown>) => {
        const enc = encryptTenantSecret(tenantId, payload);
        await client.query(
          `INSERT INTO tenant_integrations (
            id, tenant_id, integration_type, config_encrypted, iv, auth_tag, status, last_synced_at
          ) VALUES (
            $1, $2, $3, $4, $5, $6, 'active', clock_timestamp()
          )
          ON CONFLICT (tenant_id, integration_type) DO UPDATE SET
            config_encrypted = EXCLUDED.config_encrypted,
            iv = EXCLUDED.iv,
            auth_tag = EXCLUDED.auth_tag,
            status = 'active',
            last_synced_at = clock_timestamp(),
            updated_at = clock_timestamp()`,
          [
            deterministicUuid(tenantSlug, 'tenant_integrations', integrationType),
            tenantId,
            integrationType,
            enc.configEncrypted,
            enc.iv,
            enc.authTag,
          ]
        );
      };

      let vaultCount = 0;

      if (vaultIntegrations.aws_ses) {
        await upsertVault('aws_ses', {
          smtp_host: creds.smtpHost,
          smtp_port: creds.smtpPort,
          smtp_user: creds.smtpUser,
          smtp_pass: creds.smtpPass,
          region: creds.sesRegion,
          sesRegion: creds.sesRegion,
          accessKeyId: creds.awsAccessKey,
          secretAccessKey: creds.awsSecretKey,
          from_email: creds.fromEmail,
          from_name: creds.fromName,
          verified_senders: creds.verifiedSenders,
          spf_verified: true,
          dkim_verified: true,
          dmarc_verified: true,
          ...(creds.imapHost
            ? {
                imap: {
                  host: creds.imapHost,
                  port: creds.imapPort,
                  user: creds.imapUser,
                  pass: creds.imapPass,
                },
              }
            : {}),
        });
        vaultCount += 1;
      }

      if (vaultIntegrations.facebook_ads) {
        const acctKey = deterministicUuid(tenantSlug, 'facebook_ads_account', creds.metaAdAccountId);
        await upsertVault('facebook_ads', {
          version: 2,
          primary_account_id: acctKey,
          accounts: [
            {
              id: acctKey,
              name: `${tenantName} Ads`,
              ad_account_id: creds.metaAdAccountId,
              access_token: creds.metaAccessToken,
              pixel_id: creds.metaPixelId,
              is_active: true,
            },
          ],
        });
        vaultCount += 1;
      }

      if (vaultIntegrations.meta_capi) {
        await upsertVault('meta_capi', {
          dataset_id: creds.metaPixelId,
          access_token: creds.metaAccessToken,
          dual_send: creds.capiDualEnabled,
          secondary_dataset_id: creds.metaWebPixelId,
          secondary_access_token: creds.metaAccessToken,
          phone_farm_audience_id: creds.capiPhoneFarmAudienceId,
          quality_min_stage: creds.capiQualityMinStage,
          source_mode: creds.capiSourceMode,
        });
        vaultCount += 1;
      }

      if (vaultIntegrations.meta_messenger) {
        await upsertVault('meta_messenger', {
          pages: parsed.metaAppConfigs.map((p) => ({
            page_id: asTrimmed(p.page_id),
            page_name: asTrimmed(p.page_name),
            page_access_token: asTrimmed(p.page_access_token),
            app_id: asTrimmed(p.app_id),
            app_secret: asTrimmed(p.app_secret),
            verify_token: asTrimmed(p.verify_token),
            status: asTrimmed(p.status) || 'active',
            mode: asTrimmed(p.mode) || 'live',
          })),
        });
        vaultCount += 1;
      }

      if (vaultIntegrations.dom_meta_report) {
        await upsertVault('dom_meta_report', {
          version: 1,
          primary_ad_account_id: creds.metaAdAccountId,
          brand_filter_enabled: false,
          ...(creds.primaryGeminiKey ? { gemini_api_key: creds.primaryGeminiKey } : {}),
          updated_at: new Date().toISOString(),
        });
        vaultCount += 1;
      }

      if (vaultIntegrations.ai_gemini_byok) {
        await upsertVault('ai_gemini_byok', {
          gemini_api_key: creds.primaryGeminiKey,
          gemini_model: creds.geminiModel,
          ai_screener_model: creds.aiScreenerModel,
          ...(creds.sysGeminiKey && creds.sysGeminiKey !== creds.primaryGeminiKey
            ? { system_gemini_api_key: creds.sysGeminiKey }
            : {}),
          ...(creds.googleApiKey ? { google_api_key: creds.googleApiKey } : {}),
          ...(creds.googleCloudApiKey ? { google_cloud_api_key: creds.googleCloudApiKey } : {}),
          ...(creds.groqApiKey ? { groq_api_key: creds.groqApiKey, groq_model: creds.groqModel } : {}),
          ...(creds.openrouterApiKey ? { openrouter_api_key: creds.openrouterApiKey } : {}),
        });
        vaultCount += 1;
      }

      if (vaultIntegrations.google_sheets) {
        await upsertVault('google_sheets', {
          legacy_integrations: parsed.integrations.map((ig) => ({
            id: asTrimmed(ig.id),
            name: asTrimmed(ig.name),
            provider: asTrimmed(ig.provider),
            type: asTrimmed(ig.type),
            status: asTrimmed(ig.status),
            config: parseJsonSafe(ig.config) ?? {},
          })),
          sheet_connections_count: parsed.sheetConnections.length,
        });
        vaultCount += 1;
      }

      // F8 Hard Cleanup: guarantee ZERO Zalo integrations or Zalo OA rows for `ideas`
      await client.query(
        `DELETE FROM tenant_integrations
         WHERE tenant_id = $1 AND integration_type IN ('zalo_bot', 'zalo_oa', 'zalo_zns')`,
        [tenantId]
      );
      await client.query(`DELETE FROM mkt_zalo_oa_configs WHERE tenant_id = $1`, [tenantId]);
      await client.query(`DELETE FROM mkt_zalo_templates WHERE tenant_id = $1`, [tenantId]);

      targetMigratedCounts.tenant_integrations = vaultCount;
    });

    // Refresh planner statistics across all bulk-imported tables so complex Marketing/CRM joins
    // use optimal index plans immediately after migration, then flush WAL cleanly to disk.
    await withSystemPrivilege(async (client) => {
      if (Object.keys(aiTrainingPropertyStatsOut).length > 0) {
        const curRes = await client.query<{ settings: unknown }>(
          'SELECT settings FROM tenants WHERE id = $1 LIMIT 1',
          [tenantId]
        );
        const curRaw = curRes.rows[0]?.settings;
        const curObj =
          curRaw && typeof curRaw === 'object' && !Array.isArray(curRaw)
            ? (curRaw as Record<string, unknown>)
            : typeof curRaw === 'string'
              ? ((parseJsonSafe(curRaw) || {}) as Record<string, unknown>)
              : {};
        await client.query(
          'UPDATE tenants SET settings = $2::jsonb, updated_at = clock_timestamp() WHERE id = $1',
          [tenantId, JSON.stringify({ ...curObj, ai_training_property_stats: aiTrainingPropertyStatsOut })]
        );
      }
      await client.query('ANALYZE;');
      if (pool.isEmbedded) {
        await client.query('CHECKPOINT;');
      }
    });

    return {
      success: true,
      dry_run: false,
      tenant_slug: tenantSlug,
      tenant_id: tenantId,
      source_sql: sqlPath,
      data_dir: effectiveDataDir,
      duration_ms: Date.now() - startedAt,
      dump_stats: {
        file_size_bytes: parsed.fileSizeBytes,
        tables_defined: parsed.tablesDefined,
        backup_tables_skipped: parsed.backupTablesSkipped,
        zalo_tables_skipped: parsed.zaloTablesSkipped,
        out_of_scope_tables_skipped: parsed.outOfScopeTablesSkipped,
      },
      source_filtered_counts: parsed.filteredCounts,
      source_excluded_counts: parsed.excludedCounts,
      target_migrated_counts: targetMigratedCounts,
      safety_gates: {
        stale_mail_queue_pending_purged: parsed.mailQueuePending,
        mail_queue_total_skipped: parsed.mailQueueTotal,
        waiting_flow_states_gated_to_paused: waitingFlowStatesGated,
        orphan_flow_snapshots_dropped: orphanFlowSnapshotsDropped,
        orphan_link_clicks_dropped: orphanLinkClicksDropped,
        zalo_settings_keys_excluded: parsed.zaloSettingKeysExcluded,
        zalo_vault_integrations_present: 0,
        zalo_bot_disabled: true,
      },
      quarantined,
      vault_integrations: vaultIntegrations,
      url_rewrites: {
        total_rewritten: rewriter.rewriteCount,
        uploadss_assets_referenced: rewriter.uploadssAssets.size,
        template_thumbs_referenced: rewriter.templateThumbs.size,
        ai_training_assets_referenced: rewriter.aiTrainingAssets.size,
      },
    };
  } finally {
    await pool.close().catch(() => {});
    setDatabasePool(null);
  }
}

// ============================================================================
// CLI Argument Parsing & Entrypoint
// ============================================================================

export function parseCliArgs(argv: string[]): MigrateMyerpIdeasOptions & { help?: boolean } {
  let sqlPath = '';
  let tenantSlug = 'ideas';
  let dataDir: string | undefined;
  let dryRun = false;
  let publicUrl = DEFAULT_PUBLIC_URL;
  let crmUrl = DEFAULT_CRM_URL;
  let manifestOut: string | undefined;
  let skipWebAnalytics = false;
  let help = false;

  const takeValue = (idx: number, flag: string, inlineVal?: string): { val: string; nextIdx: number } => {
    if (inlineVal !== undefined) return { val: inlineVal, nextIdx: idx };
    const next = argv[idx + 1];
    if (!next || next.startsWith('--')) {
      throw new Error(`CLI_ARG_ERROR: Flag '${flag}' requires a value`);
    }
    return { val: next, nextIdx: idx + 1 };
  };

  for (let i = 0; i < argv.length; i++) {
    const raw = argv[i];
    const eqIdx = raw.indexOf('=');
    const flag = eqIdx >= 0 ? raw.slice(0, eqIdx) : raw;
    const inlineVal = eqIdx >= 0 ? raw.slice(eqIdx + 1) : undefined;

    if (flag === '--help' || flag === '-h') {
      help = true;
    } else if (flag === '--sql' || flag === '--source') {
      const r = takeValue(i, flag, inlineVal);
      sqlPath = r.val;
      i = r.nextIdx;
    } else if (flag === '--tenant') {
      const r = takeValue(i, flag, inlineVal);
      tenantSlug = r.val;
      i = r.nextIdx;
    } else if (flag === '--data-dir' || flag === '--pgdata') {
      const r = takeValue(i, flag, inlineVal);
      dataDir = r.val;
      i = r.nextIdx;
    } else if (flag === '--dry-run') {
      dryRun = true;
    } else if (flag === '--public-url') {
      const r = takeValue(i, flag, inlineVal);
      publicUrl = r.val;
      i = r.nextIdx;
    } else if (flag === '--crm-url') {
      const r = takeValue(i, flag, inlineVal);
      crmUrl = r.val;
      i = r.nextIdx;
    } else if (flag === '--manifest-out') {
      const r = takeValue(i, flag, inlineVal);
      manifestOut = r.val;
      i = r.nextIdx;
    } else if (flag === '--skip-web-analytics') {
      skipWebAnalytics = true;
    }
  }

  if (!sqlPath) {
    sqlPath = process.env.MYERP_SQL_PATH || DEFAULT_SOURCE_SQL_PATH;
  }

  return {
    sqlPath,
    tenantSlug,
    dataDir,
    dryRun,
    publicUrl,
    crmUrl,
    manifestOut,
    skipWebAnalytics,
    help,
  };
}

function isDirectCli(): boolean {
  if (!process.argv[1]) return false;
  try {
    const entry = path.resolve(process.argv[1]);
    const self = path.resolve(fileURLToPath(import.meta.url));
    return process.platform === 'win32'
      ? entry.toLowerCase() === self.toLowerCase()
      : entry === self;
  } catch {
    return false;
  }
}

async function runCli(): Promise<void> {
  try {
    const parsed = parseCliArgs(process.argv.slice(2));
    if (parsed.help) {
      console.log(`Usage: npx tsx scripts/migrate-myerp-ideas.ts [options]
Options:
  --sql, --source <path>      Path to MariaDB/MYERP SQL dump (default: ${DEFAULT_SOURCE_SQL_PATH})
  --tenant <slug>             Target tenant slug (default: ideas)
  --data-dir, --pgdata <dir>  Isolated PGlite data directory (overrides PGLITE_DATA_DIR)
  --dry-run                   Stream-parse and validate dump without touching target DB
  --public-url <origin>       Canonical public API origin (default: ${DEFAULT_PUBLIC_URL})
  --crm-url <origin>          Canonical CRM SPA origin (default: ${DEFAULT_CRM_URL})
  --manifest-out <path>       Write referenced legacy media asset manifest JSON
  --skip-web-analytics        Skip bulk web_sessions/web_page_views/web_events rows
  -h, --help                  Show help`);
      process.exit(0);
    }

    const summary = await migrateMyerpIdeas(parsed);
    console.log(JSON.stringify(summary, null, 2));
    process.exit(0);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[migrate-myerp-ideas] ERROR: ${msg}`);
    process.exit(1);
  }
}

if (isDirectCli()) {
  void runCli();
}
