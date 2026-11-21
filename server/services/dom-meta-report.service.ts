import crypto from 'node:crypto';
import type { DbClient } from '../core/database/db-adapter.ts';
import type { PlanTier, TenantContext } from '../core/context/tenant-context.ts';
import { decryptTenantSecret, encryptTenantSecret } from '../core/crypto/vault.ts';
import { hashPassword } from '../core/crypto/password.ts';
import { signTenantAccessToken } from '../core/crypto/jwt.ts';
import { withSystemPrivilege } from '../core/database/transaction.ts';
import { PUBLIC_DOM_META_VIEWER_USER_ID } from '../core/security/rbac.ts';
import { tenantRedis } from '../core/cache/tenant-redis.ts';
import { DEFAULT_PIPELINE_CAPI_STAGES } from '../core/settings/tenant-settings.ts';
import { getTenantSettingsCached } from '../core/settings/tenant-cache.ts';
import {
  maskEmailString,
  maskPhoneString,
  maskPiiInText,
  shouldHideInternalNotesForActor,
  shouldMaskPiiForActor,
} from '../core/security/pii-masker.ts';
import { zonedWallClockToUtc } from '../routes/workspace.routes.ts';
import {
  enrichLeadAssigneeAndRound,
  formatDateTimeVnSql,
  pickCleanName,
} from '../routes/legacy/legacy-helpers.ts';
import {
  discoverMetaTokenAssets,
  getMetaAdsConfigSummary,
  maskMetaToken,
  normalizeAdAccountId,
  toggleMetaAdAccountStatus,
  upsertMetaAdAccount,
  type MetaAdAccountPublicDto,
} from './meta-ads.service.ts';
import {
  DEFAULT_GOOGLE_ADS_MCC_ADMIN_EMAIL,
  DEFAULT_GOOGLE_ADS_MCC_CC_EMAIL,
  fetchTenantPrimaryAdminContact,
  notifyGoogleAdsMccLinkRequest,
  sendGoogleAdsMccOtpEmail,
} from './platform-appscript.service.ts';

export interface DomMetaBrandFilter {
  id: string;
  name: string;
  filter: string;
  avatar?: string;
}

export interface DomMetaCustomMetric {
  id: string;
  name: string;
  formula: string;
  format?: 'money' | 'number' | 'percent';
}

export interface DomMetaColumnConfig {
  activeColumns: string[];
  customMetrics: DomMetaCustomMetric[];
}

export interface DomMetaViewPreset {
  id: string;
  name: string;
  activeColumns: string[];
  customMetrics?: DomMetaCustomMetric[];
}

export interface DomMetaAiReportEntry {
  id: string;
  timestamp: string;
  label: string;
  brand: string;
  date_range: string;
  preview: string;
  html: string;
  plain_text: string;
}

export type DomMetaGoogleAdsSetupMode = 'mcc_quick' | 'custom_script';
export type DomMetaGoogleAdsAccountStatus = 'pending_mcc' | 'pending_otp' | 'connected' | 'error';
export type DomMetaGoogleAdsVerifiedVia =
  | 'owner_email_otp'
  | 'mcc_admin_otp'
  | 'legacy_migrated'
  | 'custom_script';

export interface DomMetaGoogleAdsAccountDto {
  customer_id: string;
  label: string;
  status: DomMetaGoogleAdsAccountStatus;
  requested_at: string | null;
  verified_at: string | null;
  verified_via: DomMetaGoogleAdsVerifiedVia | null;
  otp_sent_to_masked: string | null;
  otp_expires_at: string | null;
  last_error: string | null;
}

interface DomMetaGoogleAdsAccountVaultItem extends DomMetaGoogleAdsAccountDto {
  otp_last_sent_at?: string | null;
  otp_hash?: string | null;
  otp_attempts?: number;
  otp_target_mode?: 'owner_email' | 'mcc_admin' | null;
  pending_google_account_name?: string | null;
}

export interface DomMetaGoogleAdsConfigDto {
  enabled: boolean;
  setup_mode: DomMetaGoogleAdsSetupMode;
  customer_id: string;
  accounts: DomMetaGoogleAdsAccountDto[];
  mcc_id: string;
  apps_script_url: string;
  has_developer_token: boolean;
  developer_token_masked: string;
  last_verified_at: string | null;
}

export interface DomMetaSharedAiConfigDto {
  has_api_key: boolean;
  api_key_masked: string;
  model: string;
  ai_lead_eval_enabled: boolean;
  ai_ads_eval_enabled: boolean;
  updated_at: string | null;
}

interface DomMetaVaultPayload {
  version: 1;
  primary_ad_account_id?: string;
  public_view?: boolean;
  brand_filters: DomMetaBrandFilter[];
  goal_keywords: string[];
  goal_chart_mode: 'goal' | 'brand' | 'keyword';
  column_config: DomMetaColumnConfig;
  view_presets: DomMetaViewPreset[];
  summary_metrics: string[];
  ai_reports: DomMetaAiReportEntry[];
  ai_ads_eval_enabled?: boolean;
  ai_lead_eval_enabled?: boolean;
  google_ads: {
    enabled: boolean;
    setup_mode: DomMetaGoogleAdsSetupMode;
    customer_id: string;
    accounts: DomMetaGoogleAdsAccountVaultItem[];
    apps_script_url: string;
    developer_token: string;
    last_verified_at: string | null;
  };
  updated_at: string;
}

export const DEFAULT_DOMATION_GOOGLE_ADS_MCC_ID = '113-061-8835';
export const DEFAULT_DOMATION_GOOGLE_ADS_MCC_SCRIPT_URL =
  'https://script.google.com/macros/s/AKfycby0BDtgLxuC8xN-grb9lXZk4ISK9C0NN77muj48YQ6GmpfsAF7RzfRa7uyrMjBonHs3/exec';
const GOOGLE_ADS_OTP_TTL_MS = 10 * 60 * 1000;
const GOOGLE_ADS_OTP_MAX_ATTEMPTS = 5;
const GOOGLE_ADS_OTP_RESEND_COOLDOWN_MS = 60 * 1000;
const GOOGLE_ADS_MAX_ACCOUNTS_PER_WORKSPACE = 15;

export function getMasterGoogleAdsMccId(): string {
  return (process.env.DOMATION_GOOGLE_ADS_MCC_ID || '').trim() || DEFAULT_DOMATION_GOOGLE_ADS_MCC_ID;
}

export function getMasterGoogleAdsMccScriptUrl(): string {
  return (
    (process.env.DOMATION_GOOGLE_ADS_MCC_SCRIPT_URL || '').trim() ||
    DEFAULT_DOMATION_GOOGLE_ADS_MCC_SCRIPT_URL
  );
}

function getMasterGoogleAdsMccSecret(): string {
  return (process.env.DOMATION_GOOGLE_ADS_MCC_SECRET || '').trim();
}

export function normalizeGoogleAdsCustomerId(raw: unknown): string {
  const digits = String(raw || '').replace(/\D/g, '');
  if (digits.length !== 10) return '';
  return `${digits.slice(0, 3)}-${digits.slice(3, 6)}-${digits.slice(6, 10)}`;
}

function hashGoogleAdsOtp(tenantId: string, customerId: string, otpCode: string): string {
  return crypto
    .createHash('sha256')
    .update(`dom_gads_otp:v1:${tenantId}:${customerId}:${otpCode}`)
    .digest('hex');
}

function verifyGoogleAdsOtpHash(expectedHex: string, candidateHex: string): boolean {
  try {
    const a = Buffer.from(expectedHex, 'hex');
    const b = Buffer.from(candidateHex, 'hex');
    if (a.length === 0 || a.length !== b.length) return false;
    return crypto.timingSafeEqual(a, b);
  } catch {
    return false;
  }
}

function maskOwnerEmailDisplay(email: string): string {
  const clean = String(email || '').trim().toLowerCase();
  if (!clean.includes('@')) return '***';
  return maskEmailString(clean) || '***';
}

function toGoogleAdsAccountDto(item: DomMetaGoogleAdsAccountVaultItem): DomMetaGoogleAdsAccountDto {
  return {
    customer_id: item.customer_id,
    label: item.label || '',
    status: item.status,
    requested_at: item.requested_at || null,
    verified_at: item.verified_at || null,
    verified_via: item.verified_via || null,
    otp_sent_to_masked: item.otp_sent_to_masked || null,
    otp_expires_at: item.otp_expires_at || null,
    last_error: item.last_error || null,
  };
}

function buildGoogleAdsConfigDto(vaultGads: DomMetaVaultPayload['google_ads']): DomMetaGoogleAdsConfigDto {
  return {
    enabled: Boolean(vaultGads.enabled === true),
    setup_mode: vaultGads.setup_mode === 'custom_script' ? 'custom_script' : 'mcc_quick',
    customer_id: vaultGads.customer_id,
    accounts: (vaultGads.accounts || []).map(toGoogleAdsAccountDto),
    mcc_id: getMasterGoogleAdsMccId(),
    apps_script_url: vaultGads.apps_script_url,
    has_developer_token: Boolean(vaultGads.developer_token),
    developer_token_masked: maskMetaToken(vaultGads.developer_token),
    last_verified_at: vaultGads.last_verified_at,
  };
}

const DEFAULT_ACTIVE_COLUMNS = [
  'status',
  'spend',
  'result',
  'cpr',
  'cpm',
  'reach',
  'frequency',
  'reaction',
];

const DEFAULT_SUMMARY_METRICS = ['reach', 'leads', 'impressions'];

export type DomExternalHttpFetcher = (url: string) => Promise<{
  ok: boolean;
  status: number;
  contentType?: string;
  text?: () => Promise<string>;
  json: () => Promise<any>;
}>;

let customExternalFetcher: DomExternalHttpFetcher | null = null;

export function setDomMetaExternalFetcherForTesting(fn: DomExternalHttpFetcher | null): void {
  customExternalFetcher = fn;
}

const ALLOWED_GOOGLE_APPS_SCRIPT_HOSTS = new Set([
  'script.google.com',
  'script.googleusercontent.com',
]);

export function validateGoogleAppsScriptUrl(rawUrl: string): {
  valid: boolean;
  normalized: string;
  reason?: string;
} {
  const trimmed = String(rawUrl || '').trim();
  if (!trimmed) {
    return {
      valid: false,
      normalized: '',
      reason: 'Chưa cấu hình Google Apps Script Web App URL (https://script.google.com/macros/s/.../exec).',
    };
  }
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return {
      valid: false,
      normalized: '',
      reason: 'URL Google Apps Script không đúng định dạng URL hợp lệ.',
    };
  }
  if (parsed.protocol !== 'https:') {
    return {
      valid: false,
      normalized: '',
      reason: 'URL Google Apps Script bắt buộc phải dùng giao thức bảo mật https://.',
    };
  }
  if (parsed.port && parsed.port !== '443') {
    return {
      valid: false,
      normalized: '',
      reason: 'URL Google Apps Script không được chỉ định cổng mạng tùy chỉnh.',
    };
  }
  if (parsed.username || parsed.password) {
    return {
      valid: false,
      normalized: '',
      reason: 'URL Google Apps Script không được chứa thông tin xác thực nội tuyến.',
    };
  }
  const host = parsed.hostname.toLowerCase();
  if (!ALLOWED_GOOGLE_APPS_SCRIPT_HOSTS.has(host)) {
    return {
      valid: false,
      normalized: '',
      reason:
        'Chỉ chấp nhận tên miền chính thức của Google Apps Script (script.google.com hoặc script.googleusercontent.com).',
    };
  }
  if (host === 'script.google.com' && !parsed.pathname.startsWith('/macros/')) {
    return {
      valid: false,
      normalized: '',
      reason: 'URL Google Apps Script phải có dạng https://script.google.com/macros/s/.../exec.',
    };
  }
  return { valid: true, normalized: parsed.toString() };
}

async function performExternalGet(
  url: string
): Promise<{ ok: boolean; status: number; isJson: boolean; rawText: string; data: any }> {
  if (customExternalFetcher) {
    const r = await customExternalFetcher(url);
    if (typeof r.text === 'function') {
      const text = await r.text();
      try {
        const parsed = text ? JSON.parse(text) : {};
        return { ok: r.ok, status: r.status, isJson: true, rawText: text, data: parsed };
      } catch {
        return {
          ok: r.ok,
          status: r.status,
          isJson: false,
          rawText: text,
          data: { raw_error: text.slice(0, 300) },
        };
      }
    }
    try {
      const data = await r.json();
      return { ok: r.ok, status: r.status, isJson: true, rawText: '', data };
    } catch {
      return { ok: r.ok, status: r.status, isJson: false, rawText: '', data: {} };
    }
  }
  const resp = await fetch(url, {
    method: 'GET',
    headers: { Accept: 'application/json' },
    redirect: 'follow',
    signal: AbortSignal.timeout(25_000),
  });
  const text = await resp.text();
  const trimmed = text.trim();
  if (!trimmed) {
    return { ok: resp.ok, status: resp.status, isJson: false, rawText: '', data: {} };
  }
  try {
    const data = JSON.parse(trimmed);
    return { ok: resp.ok, status: resp.status, isJson: true, rawText: trimmed, data };
  } catch {
    return {
      ok: resp.ok,
      status: resp.status,
      isJson: false,
      rawText: trimmed.slice(0, 500),
      data: { raw_error: trimmed.slice(0, 300) },
    };
  }
}

function normalizeSummaryMetricId(raw: unknown): string {
  const k = String(raw || '').trim();
  if (k === 'lead') return 'leads';
  if (k === 'message_started') return 'messages';
  if (k === 'follow') return 'follows';
  if (k === 'comment') return 'comments';
  if (k === 'share') return 'shares';
  if (k === 'purchase') return 'purchases';
  return k;
}

function buildDefaultVaultPayload(): DomMetaVaultPayload {
  return {
    version: 1,
    primary_ad_account_id: '',
    public_view: false,
    brand_filters: [],
    goal_keywords: [],
    goal_chart_mode: 'goal',
    column_config: {
      activeColumns: [...DEFAULT_ACTIVE_COLUMNS],
      customMetrics: [],
    },
    view_presets: [
      {
        id: 'preset_lead_default',
        name: 'Báo cáo Lead & CPL',
        activeColumns: ['status', 'spend', 'result', 'cpr', 'cpm', 'reach', 'frequency', 'ctr'],
      },
      {
        id: 'preset_crm_fusion',
        name: 'Đối soát Lead CRM & Sale',
        activeColumns: ['status', 'spend', 'result', 'cpr'],
      },
      {
        id: 'preset_creative_hook',
        name: 'Creative Hook & Hold Rate',
        activeColumns: ['status', 'spend', 'impressions', 'video_3s', 'hook_rate', 'thruplay', 'hold_rate', 'ctr'],
      },
    ],
    summary_metrics: [...DEFAULT_SUMMARY_METRICS],
    ai_reports: [],
    ai_ads_eval_enabled: true,
    ai_lead_eval_enabled: true,
    google_ads: {
      enabled: false, // STRICTLY OFF BY DEFAULT per product spec
      setup_mode: 'mcc_quick',
      customer_id: '',
      accounts: [],
      apps_script_url: '',
      developer_token: '',
      last_verified_at: null,
    },
    updated_at: new Date().toISOString(),
  };
}

function normalizeStoredGoogleAdsVault(
  rawGads: Partial<DomMetaVaultPayload['google_ads']> | undefined
): DomMetaVaultPayload['google_ads'] {
  const enabled = Boolean(rawGads?.enabled === true);
  const rawCid = String(rawGads?.customer_id || '').trim();
  const formattedCid = normalizeGoogleAdsCustomerId(rawCid) || rawCid;
  const appsScriptUrl = String(rawGads?.apps_script_url || '').trim();
  const developerToken = String(rawGads?.developer_token || '').trim();
  const lastVerifiedAt = rawGads?.last_verified_at || null;

  const setupMode: DomMetaGoogleAdsSetupMode =
    rawGads?.setup_mode === 'custom_script'
      ? 'custom_script'
      : rawGads?.setup_mode === 'mcc_quick'
        ? 'mcc_quick'
        : appsScriptUrl
          ? 'custom_script'
          : 'mcc_quick';

  const rawAccounts = Array.isArray(rawGads?.accounts) ? rawGads.accounts : [];
  const seen = new Set<string>();
  const accounts: DomMetaGoogleAdsAccountVaultItem[] = [];
  for (const item of rawAccounts) {
    if (!item || typeof item !== 'object') continue;
    const cid = normalizeGoogleAdsCustomerId((item as DomMetaGoogleAdsAccountVaultItem).customer_id);
    if (!cid || seen.has(cid)) continue;
    seen.add(cid);
    const rawStatus = (item as DomMetaGoogleAdsAccountVaultItem).status;
    const status: DomMetaGoogleAdsAccountStatus =
      rawStatus === 'connected' ||
      rawStatus === 'pending_otp' ||
      rawStatus === 'pending_mcc' ||
      rawStatus === 'error'
        ? rawStatus
        : 'pending_mcc';
    accounts.push({
      customer_id: cid,
      label: String((item as DomMetaGoogleAdsAccountVaultItem).label || '').trim().slice(0, 120),
      status,
      requested_at: (item as DomMetaGoogleAdsAccountVaultItem).requested_at || null,
      verified_at: (item as DomMetaGoogleAdsAccountVaultItem).verified_at || null,
      verified_via: (item as DomMetaGoogleAdsAccountVaultItem).verified_via || null,
      otp_sent_to_masked: (item as DomMetaGoogleAdsAccountVaultItem).otp_sent_to_masked || null,
      otp_expires_at: (item as DomMetaGoogleAdsAccountVaultItem).otp_expires_at || null,
      otp_last_sent_at: (item as DomMetaGoogleAdsAccountVaultItem).otp_last_sent_at || null,
      last_error: (item as DomMetaGoogleAdsAccountVaultItem).last_error || null,
      otp_hash: (item as DomMetaGoogleAdsAccountVaultItem).otp_hash || null,
      otp_attempts: Number((item as DomMetaGoogleAdsAccountVaultItem).otp_attempts || 0),
      otp_target_mode: (item as DomMetaGoogleAdsAccountVaultItem).otp_target_mode || null,
      pending_google_account_name:
        (item as DomMetaGoogleAdsAccountVaultItem).pending_google_account_name || null,
    });
    if (accounts.length >= GOOGLE_ADS_MAX_ACCOUNTS_PER_WORKSPACE) break;
  }

  // Backward compatibility: synthesize 1 connected account for legacy custom_script configs
  if (accounts.length === 0 && setupMode === 'custom_script' && appsScriptUrl && formattedCid) {
    const norm = normalizeGoogleAdsCustomerId(formattedCid);
    if (norm) {
      accounts.push({
        customer_id: norm,
        label: '',
        status: 'connected',
        requested_at: null,
        verified_at: lastVerifiedAt,
        verified_via: 'custom_script',
        otp_sent_to_masked: null,
        otp_expires_at: null,
        otp_last_sent_at: null,
        last_error: null,
      });
    }
  }

  return {
    enabled,
    setup_mode: setupMode,
    customer_id: formattedCid,
    accounts,
    apps_script_url: appsScriptUrl,
    developer_token: developerToken,
    last_verified_at: lastVerifiedAt,
  };
}

async function readDomMetaVault(client: DbClient, tenantId: string): Promise<DomMetaVaultPayload> {
  const res = await client.query<{
    config_encrypted: string;
    iv: string;
    auth_tag: string;
  }>(
    `SELECT config_encrypted, iv, auth_tag
     FROM tenant_integrations
     WHERE tenant_id = $1 AND integration_type = 'dom_meta_report'
     LIMIT 1`,
    [tenantId]
  );

  const base = buildDefaultVaultPayload();
  const row = res.rows[0];
  if (!row) return base;

  try {
    const raw = decryptTenantSecret<Partial<DomMetaVaultPayload>>(
      tenantId,
      row.config_encrypted,
      row.iv,
      row.auth_tag
    );
    if (!raw || typeof raw !== 'object') return base;

    return {
      version: 1,
      primary_ad_account_id: String(raw.primary_ad_account_id || ''),
      public_view: Boolean(raw.public_view === true),
      brand_filters: Array.isArray(raw.brand_filters) ? raw.brand_filters.slice(0, 40) : [],
      goal_keywords: Array.isArray(raw.goal_keywords)
        ? raw.goal_keywords.map((k) => String(k || '').trim()).filter(Boolean).slice(0, 50)
        : [],
      goal_chart_mode:
        raw.goal_chart_mode === 'brand' || raw.goal_chart_mode === 'keyword' ? raw.goal_chart_mode : 'goal',
      column_config: {
        activeColumns:
          Array.isArray(raw.column_config?.activeColumns) && raw.column_config.activeColumns.length > 0
            ? raw.column_config.activeColumns.map((c) => normalizeSummaryMetricId(c)).slice(0, 15)
            : [...DEFAULT_ACTIVE_COLUMNS],
        customMetrics: Array.isArray(raw.column_config?.customMetrics)
          ? raw.column_config.customMetrics.slice(0, 20)
          : [],
      },
      view_presets:
        Array.isArray(raw.view_presets) && raw.view_presets.length > 0
          ? raw.view_presets.slice(0, 25)
          : base.view_presets,
      summary_metrics:
        Array.isArray(raw.summary_metrics) && raw.summary_metrics.length === 3
          ? raw.summary_metrics.map((m) => normalizeSummaryMetricId(m))
          : [...DEFAULT_SUMMARY_METRICS],
      ai_reports: Array.isArray(raw.ai_reports)
        ? raw.ai_reports
            .filter((r) => r && typeof r === 'object')
            .map((r, idx) => ({
              id: String(r.id || `air_${idx + 1}`),
              timestamp: String(r.timestamp || ''),
              label: String(r.label || 'Báo cáo AI'),
              brand: String(r.brand || 'Tất cả'),
              date_range: String(r.date_range || ''),
              preview: String(r.preview || '').slice(0, 300),
              html: String(r.html || '').slice(0, 80_000),
              plain_text: String(r.plain_text || '').slice(0, 40_000),
            }))
            .slice(0, 25)
        : [],
      ai_ads_eval_enabled: raw.ai_ads_eval_enabled !== false,
      ai_lead_eval_enabled: raw.ai_lead_eval_enabled !== false,
      google_ads: normalizeStoredGoogleAdsVault(raw.google_ads),
      updated_at: String(raw.updated_at || base.updated_at),
    };
  } catch {
    return base;
  }
}

async function writeDomMetaVault(
  client: DbClient,
  tenantId: string,
  payload: DomMetaVaultPayload
): Promise<void> {
  const next: DomMetaVaultPayload = {
    ...payload,
    version: 1,
    updated_at: new Date().toISOString(),
  };
  const enc = encryptTenantSecret(tenantId, next as unknown as Record<string, unknown>);
  await client.query(
    `INSERT INTO tenant_integrations (tenant_id, integration_type, config_encrypted, iv, auth_tag, status, last_synced_at)
     VALUES ($1, 'dom_meta_report', $2, $3, $4, 'active', clock_timestamp())
     ON CONFLICT (tenant_id, integration_type)
     DO UPDATE SET config_encrypted = EXCLUDED.config_encrypted,
                   iv = EXCLUDED.iv,
                   auth_tag = EXCLUDED.auth_tag,
                   status = 'active',
                   last_synced_at = clock_timestamp(),
                   updated_at = clock_timestamp()`,
    [tenantId, enc.configEncrypted, enc.iv, enc.authTag]
  );
  tenantRedis.invalidateTenantIntegrations(tenantId, 'dom_meta_report');
}

async function resolveDecryptedMetaTokenForAccount(
  client: DbClient,
  tenantId: string,
  requestedAdAccountId?: string
): Promise<{ adAccountId: string; accessToken: string } | null> {
  const res = await client.query<{
    config_encrypted: string;
    iv: string;
    auth_tag: string;
  }>(
    `SELECT config_encrypted, iv, auth_tag
     FROM tenant_integrations
     WHERE tenant_id = $1 AND integration_type = 'facebook_ads'
     LIMIT 1`,
    [tenantId]
  );
  const row = res.rows[0];
  if (!row) return null;

  try {
    const raw = decryptTenantSecret<any>(tenantId, row.config_encrypted, row.iv, row.auth_tag);
    const accounts: Array<{ ad_account_id?: string; access_token?: string; is_active?: boolean }> = Array.isArray(
      raw?.accounts
    )
      ? raw.accounts
      : raw?.ad_account_id || raw?.access_token
        ? [{ ad_account_id: raw.ad_account_id, access_token: raw.access_token, is_active: true }]
        : [];

    const normTarget = normalizeAdAccountId(requestedAdAccountId);
    const matched =
      (normTarget
        ? accounts.find((a) => normalizeAdAccountId(a.ad_account_id) === normTarget && a.access_token)
        : null) ||
      accounts.find((a) => a.is_active !== false && a.access_token) ||
      accounts.find((a) => Boolean(a.access_token));

    if (!matched || !matched.access_token) return null;
    return {
      adAccountId: normalizeAdAccountId(matched.ad_account_id) || normTarget,
      accessToken: String(matched.access_token).trim(),
    };
  } catch {
    return null;
  }
}

async function syncTenantPublicViewFlag(
  client: DbClient,
  tenantId: string,
  enabled: boolean
): Promise<void> {
  const tRes = await client.query<{ settings: Record<string, unknown> | null }>(
    `SELECT settings FROM tenants WHERE id = $1 LIMIT 1`,
    [tenantId]
  );
  if (!tRes.rows[0]) return;
  const rawSettings =
    tRes.rows[0].settings && typeof tRes.rows[0].settings === 'object' ? tRes.rows[0].settings : {};
  const nextSettings = {
    ...rawSettings,
    dom_meta_public_view: Boolean(enabled),
  };
  await client.query(`UPDATE tenants SET settings = $2::jsonb WHERE id = $1`, [
    tenantId,
    JSON.stringify(nextSettings),
  ]);
  tenantRedis.invalidateEffectivePermissions(tenantId, PUBLIC_DOM_META_VIEWER_USER_ID);
  tenantRedis.invalidateTenantCache(tenantId);
}

export function maskSharedAiKey(raw: string | undefined | null): string {
  const clean = String(raw || '').trim();
  if (!clean) return '';
  if (clean.length <= 10) return `${clean.slice(0, 2)}••••${clean.slice(-2)}`;
  return `${clean.slice(0, 6)}••••••••${clean.slice(-4)}`;
}

function isMaskedSecretInput(raw: unknown, existingPlain?: string): boolean {
  const s = String(raw ?? '').trim();
  if (!s) return false;
  if (s === '__KEEP_EXISTING__' || s === '••••••••' || s.includes('••••') || s.includes('***') || s.includes('...')) {
    return true;
  }
  if (existingPlain && (s === maskSharedAiKey(existingPlain) || s === maskMetaToken(existingPlain))) {
    return true;
  }
  return false;
}

export async function resolveDecryptedSharedAiConfig(
  client: DbClient,
  tenantId: string
): Promise<{
  apiKey: string;
  model: string;
  aiLeadEvalEnabled: boolean;
  aiAdsEvalEnabled: boolean;
  updatedAt: string | null;
}> {
  const [vaultRowRes, tenantRes, screenerRes, domVault] = await Promise.all([
    client.query<{
      config_encrypted: string;
      iv: string;
      auth_tag: string;
      updated_at: string | null;
    }>(
      `SELECT config_encrypted, iv, auth_tag, updated_at
       FROM tenant_integrations
       WHERE tenant_id = $1
         AND integration_type IN ('ai_gemini_byok', 'ai_gemini')
         AND status = 'active'
       ORDER BY CASE WHEN integration_type = 'ai_gemini_byok' THEN 0 ELSE 1 END
       LIMIT 1`,
      [tenantId]
    ),
    client.query<{ settings: Record<string, any> | null }>(
      `SELECT settings FROM tenants WHERE id = $1 LIMIT 1`,
      [tenantId]
    ),
    client.query<{ is_enabled: boolean; model_name: string | null }>(
      `SELECT is_enabled, model_name FROM ai_screener_configs WHERE tenant_id = $1 LIMIT 1`,
      [tenantId]
    ),
    readDomMetaVault(client, tenantId),
  ]);

  let vaultKey = '';
  let vaultModel = '';
  let vaultLeadToggle: boolean | undefined;
  let vaultAdsToggle: boolean | undefined;
  let updatedAt: string | null = vaultRowRes.rows[0]?.updated_at || null;

  if (vaultRowRes.rows[0]) {
    try {
      const dec = decryptTenantSecret<Record<string, any>>(
        tenantId,
        vaultRowRes.rows[0].config_encrypted,
        vaultRowRes.rows[0].iv,
        vaultRowRes.rows[0].auth_tag
      );
      if (dec && typeof dec === 'object') {
        vaultKey = String(dec.api_key || dec.gemini_api_key || dec.apiKey || '').trim();
        vaultModel = String(dec.model || dec.gemini_model || '').trim();
        if (dec.ai_lead_eval_enabled !== undefined) {
          vaultLeadToggle = Boolean(dec.ai_lead_eval_enabled);
        }
        if (dec.ai_ads_eval_enabled !== undefined) {
          vaultAdsToggle = Boolean(dec.ai_ads_eval_enabled);
        }
      }
    } catch {
      // ignore corrupted vault
    }
  }

  const rawSettings =
    tenantRes.rows[0]?.settings && typeof tenantRes.rows[0].settings === 'object'
      ? tenantRes.rows[0].settings
      : {};
  const legacyKeyCandidate = String(rawSettings.gemini_api_key || '').trim();
  const cleanLegacyKey =
    legacyKeyCandidate && !isMaskedSecretInput(legacyKeyCandidate) ? legacyKeyCandidate : '';

  const apiKey = vaultKey || cleanLegacyKey;
  const model =
    vaultModel ||
    String(rawSettings.gemini_model || screenerRes.rows[0]?.model_name || '').trim() ||
    'gemini-2.5-flash';

  // Both toggles default to TRUE unless explicitly turned OFF
  const parseBoolPref = (val: unknown): boolean | undefined => {
    if (val === undefined || val === null || val === '') return undefined;
    if (typeof val === 'boolean') return val;
    if (val === 1 || val === '1' || val === 'true') return true;
    if (val === 0 || val === '0' || val === 'false') return false;
    return undefined;
  };

  const settingsLeadPref = parseBoolPref(rawSettings.ai_lead_eval_enabled);
  const settingsAdsPref = parseBoolPref(rawSettings.ai_ads_eval_enabled);

  const aiLeadEvalEnabled =
    vaultLeadToggle ??
    settingsLeadPref ??
    (domVault.ai_lead_eval_enabled !== undefined ? Boolean(domVault.ai_lead_eval_enabled) : true);

  const aiAdsEvalEnabled =
    vaultAdsToggle ??
    settingsAdsPref ??
    (domVault.ai_ads_eval_enabled !== undefined ? Boolean(domVault.ai_ads_eval_enabled) : true);

  return {
    apiKey,
    model,
    aiLeadEvalEnabled,
    aiAdsEvalEnabled,
    updatedAt,
  };
}

export async function getSharedTenantAiConfig(
  client: DbClient,
  tenantId: string
): Promise<DomMetaSharedAiConfigDto> {
  const resolved = await resolveDecryptedSharedAiConfig(client, tenantId);
  return {
    has_api_key: Boolean(resolved.apiKey),
    api_key_masked: maskSharedAiKey(resolved.apiKey),
    model: resolved.model,
    ai_lead_eval_enabled: resolved.aiLeadEvalEnabled,
    ai_ads_eval_enabled: resolved.aiAdsEvalEnabled,
    updated_at: resolved.updatedAt,
  };
}

export async function saveSharedTenantAiConfig(
  client: DbClient,
  tenantId: string,
  input: {
    api_key?: string;
    clear_api_key?: boolean;
    model?: string;
    ai_lead_eval_enabled?: boolean;
    ai_ads_eval_enabled?: boolean;
  }
): Promise<DomMetaSharedAiConfigDto> {
  const current = await resolveDecryptedSharedAiConfig(client, tenantId);
  const domVault = await readDomMetaVault(client, tenantId);

  let nextKey = current.apiKey;
  if (input.clear_api_key === true) {
    nextKey = '';
  } else if (input.api_key !== undefined) {
    const rawSubmitted = String(input.api_key || '').trim();
    if (!rawSubmitted) {
      nextKey = '';
    } else if (!isMaskedSecretInput(rawSubmitted, current.apiKey)) {
      nextKey = rawSubmitted;
    }
  }

  const nextModel =
    typeof input.model === 'string' && input.model.trim()
      ? input.model.trim().slice(0, 80)
      : current.model || 'gemini-2.5-flash';

  const nextLeadEval =
    input.ai_lead_eval_enabled !== undefined
      ? Boolean(input.ai_lead_eval_enabled)
      : current.aiLeadEvalEnabled;

  const nextAdsEval =
    input.ai_ads_eval_enabled !== undefined
      ? Boolean(input.ai_ads_eval_enabled)
      : current.aiAdsEvalEnabled;

  // 1. Sync encrypted Vault ('ai_gemini_byok') shared across DOM Agent, CRM, and Meta Report
  const enc = encryptTenantSecret(tenantId, {
    api_key: nextKey,
    model: nextModel,
    ai_lead_eval_enabled: nextLeadEval,
    ai_ads_eval_enabled: nextAdsEval,
    updated_at: new Date().toISOString(),
  });
  await client.query(
    `INSERT INTO tenant_integrations (
       tenant_id, integration_type, config_encrypted, iv, auth_tag, status, last_synced_at
     ) VALUES ($1, 'ai_gemini_byok', $2, $3, $4, 'active', clock_timestamp())
     ON CONFLICT (tenant_id, integration_type)
     DO UPDATE SET
       config_encrypted = EXCLUDED.config_encrypted,
       iv = EXCLUDED.iv,
       auth_tag = EXCLUDED.auth_tag,
       status = 'active',
       last_synced_at = clock_timestamp(),
       updated_at = clock_timestamp()`,
    [tenantId, enc.configEncrypted, enc.iv, enc.authTag]
  );
  tenantRedis.invalidateTenantIntegrations(tenantId, 'ai_gemini_byok');

  // 2. Sync DOM Meta Vault toggles
  domVault.ai_lead_eval_enabled = nextLeadEval;
  domVault.ai_ads_eval_enabled = nextAdsEval;
  await writeDomMetaVault(client, tenantId, domVault);

  // 3. Sync tenants.settings (store masked marker instead of plaintext key, plus toggle flags) & ai_screener_configs
  const [tRes, gkRes] = await Promise.all([
    client.query<{ settings: Record<string, any> | null }>(
      `SELECT settings FROM tenants WHERE id = $1 LIMIT 1`,
      [tenantId]
    ),
    client.query<{
      is_enabled: boolean;
      mode: string;
      manual_rules: unknown;
      fallback_enabled: boolean;
    }>(
      `SELECT is_enabled, mode, manual_rules, fallback_enabled
       FROM ai_screener_configs
       WHERE tenant_id = $1
       LIMIT 1`,
      [tenantId]
    ),
  ]);
  const existingGk = gkRes.rows[0] || null;
  const effectiveAiScreenerEnabled = Boolean(nextLeadEval && nextKey);
  const hasManualRules = Array.isArray(existingGk?.manual_rules) && existingGk.manual_rules.length > 0;
  const preserveExistingScreener =
    Boolean(existingGk) &&
    (String(existingGk?.mode || '').toLowerCase() === 'manual' ||
      (Boolean(existingGk?.is_enabled) &&
        !effectiveAiScreenerEnabled &&
        (hasManualRules || Boolean(existingGk?.fallback_enabled))));
  const nextScreenerEnabled = preserveExistingScreener
    ? Boolean(existingGk!.is_enabled)
    : effectiveAiScreenerEnabled;

  if (tRes.rows[0]) {
    const rawSettings =
      tRes.rows[0].settings && typeof tRes.rows[0].settings === 'object'
        ? { ...tRes.rows[0].settings }
        : {};
    delete rawSettings.gemini_api_key;
    rawSettings.has_shared_gemini_key = Boolean(nextKey);
    rawSettings.gemini_model = nextModel;
    rawSettings.ai_lead_eval_enabled = nextLeadEval;
    rawSettings.ai_ads_eval_enabled = nextAdsEval;
    rawSettings.ai_screener_enabled = nextScreenerEnabled;
    await client.query(
      `UPDATE tenants SET settings = $2::jsonb, updated_at = clock_timestamp() WHERE id = $1`,
      [tenantId, JSON.stringify(rawSettings)]
    );
  }

  await client.query(
    `INSERT INTO ai_screener_configs (tenant_id, is_enabled, mode, model_name)
     VALUES ($1, $2, 'ai', $3)
     ON CONFLICT (tenant_id)
     DO UPDATE SET
       is_enabled = EXCLUDED.is_enabled,
       model_name = EXCLUDED.model_name,
       updated_at = clock_timestamp()`,
    [tenantId, nextScreenerEnabled, nextModel]
  );

  tenantRedis.invalidateTenantCache(tenantId);
  return getSharedTenantAiConfig(client, tenantId);
}

export async function getDomMetaWorkspaceConfig(client: DbClient, tenantId: string) {
  const [metaSummary, domVault, aiConfig] = await Promise.all([
    getMetaAdsConfigSummary(client, tenantId),
    readDomMetaVault(client, tenantId),
    getSharedTenantAiConfig(client, tenantId),
  ]);

  const activePrimaryAdAccountId =
    (domVault.primary_ad_account_id &&
    metaSummary.accounts.some((a) => a.ad_account_id === normalizeAdAccountId(domVault.primary_ad_account_id))
      ? normalizeAdAccountId(domVault.primary_ad_account_id)
      : '') ||
    metaSummary.ad_account_id ||
    metaSummary.accounts[0]?.ad_account_id ||
    '';

  const googleAdsDto: DomMetaGoogleAdsConfigDto = buildGoogleAdsConfigDto(domVault.google_ads);

  return {
    primary_ad_account_id: activePrimaryAdAccountId,
    public_view: Boolean(domVault.public_view === true),
    meta_summary: metaSummary,
    brand_filters: domVault.brand_filters,
    goal_keywords: domVault.goal_keywords,
    goal_chart_mode: domVault.goal_chart_mode,
    column_config: domVault.column_config,
    view_presets: domVault.view_presets,
    summary_metrics: domVault.summary_metrics,
    ai_reports: domVault.ai_reports,
    ai_config: aiConfig,
    google_ads: googleAdsDto,
    updated_at: domVault.updated_at,
  };
}

export async function saveDomMetaWorkspaceConfig(
  client: DbClient,
  tenantId: string,
  input: Record<string, any>,
  internalOptions?: { trustGoogleAdsAccounts?: boolean }
) {
  const current = await readDomMetaVault(client, tenantId);

  if (input.primary_ad_account_id !== undefined) {
    current.primary_ad_account_id = normalizeAdAccountId(input.primary_ad_account_id);
  }

  let publicViewChanged = false;
  if (input.public_view !== undefined) {
    const nextPublic = Boolean(input.public_view === true);
    if (nextPublic !== Boolean(current.public_view === true)) {
      publicViewChanged = true;
    }
    current.public_view = nextPublic;
  }

  if (Array.isArray(input.brand_filters)) {
    current.brand_filters = input.brand_filters
      .map((item: any, idx: number) => ({
        id: String(item?.id || `brand_${idx + 1}`),
        name: String(item?.name || '').trim(),
        filter: String(item?.filter || '').trim(),
        avatar: String(item?.avatar || '').trim(),
      }))
      .filter((b: DomMetaBrandFilter) => b.name && b.filter)
      .slice(0, 40);
  }

  if (Array.isArray(input.goal_keywords)) {
    current.goal_keywords = input.goal_keywords
      .map((k: unknown) => String(k || '').trim())
      .filter(Boolean)
      .slice(0, 50);
  }

  if (
    input.goal_chart_mode === 'goal' ||
    input.goal_chart_mode === 'brand' ||
    input.goal_chart_mode === 'keyword'
  ) {
    current.goal_chart_mode = input.goal_chart_mode;
  }

  if (input.column_config && typeof input.column_config === 'object') {
    if (Array.isArray(input.column_config.activeColumns) && input.column_config.activeColumns.length > 0) {
      current.column_config.activeColumns = input.column_config.activeColumns
        .map((c: unknown) => String(c || '').trim())
        .filter(Boolean)
        .slice(0, 15);
    }
    if (Array.isArray(input.column_config.customMetrics)) {
      current.column_config.customMetrics = input.column_config.customMetrics
        .map((m: any, idx: number) => ({
          id: String(m?.id || `custom_${idx + 1}`),
          name: String(m?.name || '').trim(),
          formula: String(m?.formula || '').trim(),
          format:
            m?.format === 'money' || m?.format === 'percent' ? m.format : ('number' as const),
        }))
        .filter((m: DomMetaCustomMetric) => m.name && m.formula)
        .slice(0, 20);
    }
  }

  if (Array.isArray(input.view_presets)) {
    current.view_presets = input.view_presets
      .map((p: any, idx: number) => ({
        id: String(p?.id || `preset_${idx + 1}`),
        name: String(p?.name || '').trim(),
        activeColumns: Array.isArray(p?.activeColumns)
          ? p.activeColumns.map((c: unknown) => String(c || '').trim()).filter(Boolean)
          : [...DEFAULT_ACTIVE_COLUMNS],
        customMetrics: Array.isArray(p?.customMetrics) ? p.customMetrics : undefined,
      }))
      .filter((p: DomMetaViewPreset) => p.name && p.activeColumns.length > 0)
      .slice(0, 25);
  }

  if (Array.isArray(input.summary_metrics) && input.summary_metrics.length === 3) {
    current.summary_metrics = input.summary_metrics.map((m: unknown) => normalizeSummaryMetricId(m));
  }

  if (Array.isArray(input.ai_reports)) {
    current.ai_reports = input.ai_reports
      .filter((item: unknown): item is Record<string, unknown> => Boolean(item && typeof item === 'object'))
      .map((item, idx) => ({
        id: String(item.id || `air_${Date.now()}_${idx}`),
        timestamp: String(item.timestamp || new Date().toLocaleString('vi-VN')),
        label: String(item.label || 'Báo cáo AI').trim().slice(0, 160),
        brand: String(item.brand || 'Tất cả').trim().slice(0, 80),
        date_range: String(item.date_range || '').trim().slice(0, 80),
        preview: String(item.preview || '').trim().slice(0, 300),
        html: String(item.html || '').slice(0, 80_000),
        plain_text: String(item.plain_text || '').slice(0, 40_000),
      }))
      .filter((r) => r.html || r.plain_text)
      .slice(0, 25);
  }

  if (input.google_ads && typeof input.google_ads === 'object') {
    const g = input.google_ads;
    if (g.enabled !== undefined) {
      current.google_ads.enabled = Boolean(g.enabled === true);
    }
    if (g.setup_mode === 'mcc_quick' || g.setup_mode === 'custom_script') {
      current.google_ads.setup_mode = g.setup_mode;
    }
    if (g.apps_script_url !== undefined) {
      const cleanUrl = String(g.apps_script_url || '').trim();
      if (cleanUrl) {
        const urlCheck = validateGoogleAppsScriptUrl(cleanUrl);
        if (!urlCheck.valid) {
          return {
            success: false as const,
            message: urlCheck.reason || 'URL Google Apps Script không hợp lệ.',
          };
        }
        current.google_ads.apps_script_url = urlCheck.normalized;
        if (g.setup_mode === undefined) {
          current.google_ads.setup_mode = 'custom_script';
        }
      } else {
        current.google_ads.apps_script_url = '';
      }
    }
    if (g.customer_id !== undefined) {
      const rawCid = String(g.customer_id || '')
        .trim()
        .replace(/^act_/i, '')
        .slice(0, 32);
      const formatted = normalizeGoogleAdsCustomerId(rawCid) || rawCid;
      if (current.google_ads.setup_mode === 'custom_script' || internalOptions?.trustGoogleAdsAccounts) {
        current.google_ads.customer_id = formatted;
      } else if (!formatted) {
        current.google_ads.customer_id = '';
      } else if (current.google_ads.accounts.some((a) => a.customer_id === formatted)) {
        // In mcc_quick mode, PUT /config may only switch active customer_id among already-registered accounts
        current.google_ads.customer_id = formatted;
      }
    }
    if (g.developer_token !== undefined) {
      const rawDev = String(g.developer_token || '').trim();
      const isMasked =
        rawDev === '__KEEP_EXISTING__' ||
        rawDev.includes('***') ||
        rawDev.includes('...') ||
        (current.google_ads.developer_token &&
          rawDev === maskMetaToken(current.google_ads.developer_token));
      if (!isMasked) {
        current.google_ads.developer_token = rawDev;
      }
    }
    // Trusted server-side migration/seeding ONLY (never exposed via HTTP route body)
    if (internalOptions?.trustGoogleAdsAccounts && Array.isArray(g.accounts)) {
      const seen = new Set<string>();
      const trusted: DomMetaGoogleAdsAccountVaultItem[] = [];
      for (const acc of g.accounts) {
        const cid = normalizeGoogleAdsCustomerId(acc?.customer_id);
        if (!cid || seen.has(cid)) continue;
        seen.add(cid);
        trusted.push({
          customer_id: cid,
          label: String(acc?.label || '').trim().slice(0, 120),
          status: acc?.status === 'pending_mcc' || acc?.status === 'pending_otp' ? acc.status : 'connected',
          requested_at: acc?.requested_at || null,
          verified_at: acc?.verified_at || new Date().toISOString(),
          verified_via: acc?.verified_via || 'legacy_migrated',
          otp_sent_to_masked: null,
          otp_expires_at: null,
          otp_last_sent_at: null,
          last_error: null,
        });
      }
      current.google_ads.accounts = trusted;
      if (!current.google_ads.customer_id && trusted[0]) {
        current.google_ads.customer_id = trusted[0].customer_id;
      }
    } else if (g.account_labels && typeof g.account_labels === 'object') {
      // Safe label update for existing accounts only (never alters status/verification)
      for (const acc of current.google_ads.accounts) {
        if (typeof g.account_labels[acc.customer_id] === 'string') {
          acc.label = String(g.account_labels[acc.customer_id]).trim().slice(0, 120);
        }
      }
    }
    if (g.mark_verified === true) {
      current.google_ads.last_verified_at = new Date().toISOString();
    }
  }

  if (input.ai_config && typeof input.ai_config === 'object') {
    const ac = input.ai_config;
    if (ac.ai_lead_eval_enabled !== undefined) {
      current.ai_lead_eval_enabled = Boolean(ac.ai_lead_eval_enabled);
    }
    if (ac.ai_ads_eval_enabled !== undefined) {
      current.ai_ads_eval_enabled = Boolean(ac.ai_ads_eval_enabled);
    }
  }

  await writeDomMetaVault(client, tenantId, current);
  if (input.ai_config && typeof input.ai_config === 'object') {
    const ac = input.ai_config;
    await saveSharedTenantAiConfig(client, tenantId, {
      ...(ac.api_key !== undefined ? { api_key: String(ac.api_key) } : {}),
      ...(ac.clear_api_key === true ? { clear_api_key: true } : {}),
      ...(ac.model !== undefined ? { model: String(ac.model) } : {}),
      ...(ac.ai_lead_eval_enabled !== undefined
        ? { ai_lead_eval_enabled: Boolean(ac.ai_lead_eval_enabled) }
        : {}),
      ...(ac.ai_ads_eval_enabled !== undefined
        ? { ai_ads_eval_enabled: Boolean(ac.ai_ads_eval_enabled) }
        : {}),
    });
  }
  if (publicViewChanged) {
    await syncTenantPublicViewFlag(client, tenantId, Boolean(current.public_view));
  }
  const config = await getDomMetaWorkspaceConfig(client, tenantId);
  return {
    success: true as const,
    data: config,
    message: 'Đã lưu cấu hình DOM Meta Report thành công.',
  };
}

export async function connectDomMetaBatchAccounts(
  client: DbClient,
  tenantId: string,
  input: {
    access_token: string;
    accounts: Array<{ ad_account_id: string; name?: string; pixel_id?: string }>;
    primary_ad_account_id?: string;
  }
) {
  const rawToken = String(input.access_token || '').trim();
  if (!rawToken || rawToken.length < 15) {
    return {
      success: false as const,
      message: 'Vui lòng nhập Meta Access Token hợp lệ (EAA...).',
    };
  }
  const items = Array.isArray(input.accounts) ? input.accounts : [];
  if (items.length === 0) {
    return {
      success: false as const,
      message: 'Vui lòng chọn ít nhất 1 tài khoản quảng cáo (Ad Account).',
    };
  }

  const connected: any[] = [];
  for (const item of items.slice(0, 30)) {
    const cleanId = normalizeAdAccountId(item.ad_account_id);
    if (!cleanId) continue;
    const res = await upsertMetaAdAccount(client, tenantId, {
      ad_account_id: cleanId,
      name: item.name,
      access_token: rawToken,
      pixel_id: item.pixel_id,
      is_active: true,
      requireNew: false,
    });
    if (res.success) {
      connected.push(res.account);
    }
  }

  if (connected.length === 0) {
    return {
      success: false as const,
      message: 'Không thể lưu danh sách Ad Account đã chọn. Vui lòng kiểm tra định dạng ID.',
    };
  }

  const primaryId =
    normalizeAdAccountId(input.primary_ad_account_id) || connected[0]?.ad_account_id || '';
  await saveDomMetaWorkspaceConfig(client, tenantId, {
    primary_ad_account_id: primaryId,
  });

  return {
    success: true as const,
    connected_count: connected.length,
    accounts: connected,
    config: await getDomMetaWorkspaceConfig(client, tenantId),
  };
}

const SAFE_GRAPH_PATH_REGEX =
  /^(?:me\/(?:adaccounts|businesses)|act_[0-9]{5,25}(?:\/(?:insights|campaigns|adsets|ads|activities|adcreatives|customaudiences))?|[0-9]{5,30}(?:\/(?:insights|adcreatives|ads|adsets|previews|delivery_estimate))?)$/;

const META_GRAPH_LIVE_TTL_MS = 120_000;
const META_GRAPH_HISTORICAL_TTL_MS = 900_000;
const MAX_META_GRAPH_CACHE_ENTRIES = 1500;
const metaGraphResponseCache = new Map<string, { expiresAt: number; data: any }>();
const inFlightMetaGraphRequests = new Map<string, Promise<any>>();

function resolveMetaGraphCacheTtlMs(relativeUrl: string): number {
  const untilMatch = relativeUrl.match(/%22until%22%3A%22(\d{4}-\d{2}-\d{2})%22|"until":"(\d{4}-\d{2}-\d{2})"/);
  const untilIso = untilMatch?.[1] || untilMatch?.[2] || '';
  if (untilIso) {
    const todayVnIso = new Date(Date.now() + 7 * 3_600_000).toISOString().slice(0, 10);
    if (untilIso < todayVnIso) {
      return META_GRAPH_HISTORICAL_TTL_MS;
    }
  }
  return META_GRAPH_LIVE_TTL_MS;
}

function buildCanonicalRelativeUrl(
  cleanPath: string,
  params?: Record<string, string | number | boolean | undefined>
): string {
  const sp = new URLSearchParams();
  if (params && typeof params === 'object') {
    const sortedKeys = Object.keys(params).sort();
    for (const k of sortedKeys) {
      const v = params[k];
      if (v === undefined || v === null || k === 'access_token') continue;
      sp.set(k, String(v));
    }
  }
  const qs = sp.toString();
  return qs ? `${cleanPath}?${qs}` : cleanPath;
}

function getCachedMetaGraphPayload(cacheKey: string): any | undefined {
  const entry = metaGraphResponseCache.get(cacheKey);
  if (!entry) return undefined;
  if (Date.now() > entry.expiresAt) {
    metaGraphResponseCache.delete(cacheKey);
    return undefined;
  }
  return entry.data;
}

function setCachedMetaGraphPayload(cacheKey: string, data: any, relativeUrl = ''): void {
  if (metaGraphResponseCache.size >= MAX_META_GRAPH_CACHE_ENTRIES) {
    const now = Date.now();
    for (const [k, v] of metaGraphResponseCache.entries()) {
      if (now > v.expiresAt) metaGraphResponseCache.delete(k);
    }
    if (metaGraphResponseCache.size >= MAX_META_GRAPH_CACHE_ENTRIES) {
      const oldestKey = metaGraphResponseCache.keys().next().value;
      if (oldestKey) metaGraphResponseCache.delete(oldestKey);
    }
  }
  metaGraphResponseCache.set(cacheKey, {
    expiresAt: Date.now() + resolveMetaGraphCacheTtlMs(relativeUrl),
    data,
  });
}

export function clearDomMetaGraphCacheForTesting(): void {
  metaGraphResponseCache.clear();
  inFlightMetaGraphRequests.clear();
}

export async function resolveDomMetaAccessToken(
  client: DbClient,
  tenantId: string,
  adAccountId?: string,
  overrideAccessToken?: string
) {
  const overrideToken = String(overrideAccessToken || '').trim();
  if (overrideToken) {
    return {
      success: true as const,
      accessToken: overrideToken,
      normalizedAccountId: normalizeAdAccountId(adAccountId || '') || 'override',
      isOverride: true,
    };
  }

  const resolved = await resolveDecryptedMetaTokenForAccount(client, tenantId, adAccountId);
  if (!resolved?.accessToken) {
    return {
      success: false as const,
      status: 422,
      message: 'Chưa kết nối Meta Access Token cho tài khoản quảng cáo này.',
    };
  }

  return {
    success: true as const,
    accessToken: resolved.accessToken,
    normalizedAccountId: normalizeAdAccountId(adAccountId || '') || 'default',
    isOverride: false,
  };
}

export async function executeDomMetaGraphGet(
  tenantId: string,
  tokenToUse: string,
  input: {
    ad_account_id?: string;
    graph_path: string;
    params?: Record<string, string | number | boolean | undefined>;
    force_refresh?: boolean;
    skip_cache?: boolean;
  }
) {
  const cleanPath = String(input.graph_path || '')
    .trim()
    .replace(/^\/+|\/+$/g, '');

  if (!cleanPath || !SAFE_GRAPH_PATH_REGEX.test(cleanPath)) {
    return {
      success: false as const,
      status: 422,
      message: `Đường dẫn Meta Graph '${cleanPath}' không hợp lệ hoặc không nằm trong danh mục cho phép.`,
    };
  }

  const relativeUrl = buildCanonicalRelativeUrl(cleanPath, input.params);
  const acctScope = normalizeAdAccountId(input.ad_account_id || '') || 'default';
  const cacheKey = `${tenantId}:${acctScope}:${relativeUrl}`;
  const allowCache = !input.skip_cache && !customExternalFetcher;

  if (allowCache && !input.force_refresh) {
    const hit = getCachedMetaGraphPayload(cacheKey);
    if (hit !== undefined) {
      return {
        success: true as const,
        status: 200,
        data: hit,
        cached: true,
      };
    }
    const inflight = inFlightMetaGraphRequests.get(cacheKey);
    if (inflight) {
      return inflight;
    }
  }

  const runPromise = (async () => {
    const url = new URL(`https://graph.facebook.com/v25.0/${relativeUrl}`);
    url.searchParams.set('access_token', tokenToUse);

    const upstream = await performExternalGet(url.toString());
    if (!upstream.ok || upstream.data?.error) {
      const metaErr = upstream.data?.error || null;
      const isExpiredToken = Number(metaErr?.code) === 190 || Number(metaErr?.code) === 102;
      return {
        success: false as const,
        status: isExpiredToken ? 401 : upstream.status >= 400 ? upstream.status : 422,
        message: isExpiredToken
          ? 'Meta Access Token đã hết hạn hoặc bị thu hồi (Mã lỗi 190). Vui lòng bấm Kết nối Token Mới để cấp lại.'
          : metaErr?.message || `Meta Graph API phản hồi lỗi HTTP ${upstream.status}.`,
        meta_error: metaErr,
      };
    }

    if (allowCache) {
      setCachedMetaGraphPayload(cacheKey, upstream.data, relativeUrl);
    }

    return {
      success: true as const,
      status: 200,
      data: upstream.data,
    };
  })();

  if (allowCache && !input.force_refresh) {
    inFlightMetaGraphRequests.set(cacheKey, runPromise);
    try {
      return await runPromise;
    } finally {
      inFlightMetaGraphRequests.delete(cacheKey);
    }
  }

  return runPromise;
}

export interface DomMetaBatchRequestItem {
  key: string;
  graph_path: string;
  params?: Record<string, string | number | boolean | undefined>;
}

export async function executeDomMetaGraphBatch(
  tenantId: string,
  tokenToUse: string,
  input: {
    ad_account_id?: string;
    requests: DomMetaBatchRequestItem[];
    force_refresh?: boolean;
    skip_cache?: boolean;
  }
) {
  const rawReqs = Array.isArray(input.requests) ? input.requests : [];
  if (rawReqs.length === 0 || rawReqs.length > 60) {
    return {
      success: false as const,
      status: 422,
      message: 'Danh sách truy vấn Meta Batch phải từ 1 đến 60 mục.',
    };
  }

  const acctScope = normalizeAdAccountId(input.ad_account_id || '') || 'default';
  const allowCache = !input.skip_cache && !customExternalFetcher;
  const results: Record<string, any> = {};
  const itemErrors: Record<string, any> = {};
  const uncached: Array<{ keys: string[]; relativeUrl: string; cacheKey: string }> = [];
  const uncachedByCacheKey = new Map<string, { keys: string[]; relativeUrl: string; cacheKey: string }>();
  const inflightWaits: Array<Promise<void>> = [];
  let cacheHits = 0;

  for (let i = 0; i < rawReqs.length; i++) {
    const item = rawReqs[i];
    const key = String(item?.key || `req_${i}`).trim();
    const cleanPath = String(item?.graph_path || '')
      .trim()
      .replace(/^\/+|\/+$/g, '');

    if (!key || !cleanPath || !SAFE_GRAPH_PATH_REGEX.test(cleanPath)) {
      return {
        success: false as const,
        status: 422,
        message: `Đường dẫn Meta Graph '${cleanPath}' không hợp lệ hoặc không nằm trong danh mục cho phép.`,
      };
    }

    const relativeUrl = buildCanonicalRelativeUrl(cleanPath, item?.params);
    const cacheKey = `${tenantId}:${acctScope}:${relativeUrl}`;

    if (allowCache && !input.force_refresh) {
      const hit = getCachedMetaGraphPayload(cacheKey);
      if (hit !== undefined) {
        results[key] = hit;
        cacheHits += 1;
        continue;
      }
      const inflightSlot = inFlightMetaGraphRequests.get(`slot:${cacheKey}`);
      if (inflightSlot) {
        inflightWaits.push(
          inflightSlot.then((val) => {
            if (val !== undefined && val !== null) {
              results[key] = val;
              cacheHits += 1;
            } else {
              itemErrors[key] = { message: 'Inflight Meta Batch item failed' };
            }
          })
        );
        continue;
      }
    }

    // Intra-batch deduplication: coalesce duplicate relativeUrls inside the same batch into 1 upstream call
    const existingUncached = uncachedByCacheKey.get(cacheKey);
    if (existingUncached) {
      if (!existingUncached.keys.includes(key)) {
        existingUncached.keys.push(key);
      }
      continue;
    }

    const entry = { keys: [key], relativeUrl, cacheKey };
    uncachedByCacheKey.set(cacheKey, entry);
    uncached.push(entry);
  }

  if (uncached.length === 0) {
    if (inflightWaits.length > 0) {
      await Promise.all(inflightWaits);
    }
    return {
      success: true as const,
      status: 200,
      data: results,
      cache_hits: cacheHits,
    };
  }

  if (customExternalFetcher) {
    await Promise.all(
      uncached.map(async (u) => {
        const url = new URL(`https://graph.facebook.com/v25.0/${u.relativeUrl}`);
        url.searchParams.set('access_token', tokenToUse);
        const r = await performExternalGet(url.toString());
        if (r.ok && !r.data?.error) {
          for (const k of u.keys) results[k] = r.data;
        } else {
          const errVal = r.data?.error || { message: `HTTP ${r.status}` };
          for (const k of u.keys) itemErrors[k] = errVal;
        }
      })
    );
    return {
      success: true as const,
      status: 200,
      data: results,
      ...(Object.keys(itemErrors).length > 0 ? { errors: itemErrors } : {}),
      cache_hits: cacheHits,
    };
  }

  // Register per-slot in-flight resolvers so concurrent requests coalesce cleanly
  const slotResolvers = new Map<string, (val: any) => void>();
  if (allowCache && !input.force_refresh) {
    for (const u of uncached) {
      const slotKey = `slot:${u.cacheKey}`;
      if (!inFlightMetaGraphRequests.has(slotKey)) {
        let resolveFn!: (val: any) => void;
        const p = new Promise<any>((res) => {
          resolveFn = res;
        });
        inFlightMetaGraphRequests.set(slotKey, p);
        slotResolvers.set(u.cacheKey, resolveFn);
      }
    }
  }

  let hasExpiredTokenSubError = false;
  const fatalHolder: { err: { status: number; message: string; meta_error?: any } | null } = {
    err: null,
  };

  try {
    // Split into parallel micro-batches of 4 sub-requests (or max 6 concurrent batches for >24 items)
    // so Facebook Graph API executes heavy /insights + /ads queries concurrently instead of serializing 20+ items into a 30s timeout!
    const sliceSize = uncached.length > 24 ? Math.min(45, Math.ceil(uncached.length / 6)) : 4;
    const chunks: Array<typeof uncached> = [];
    for (let i = 0; i < uncached.length; i += sliceSize) {
      chunks.push(uncached.slice(i, i + sliceSize));
    }

    const executeBatchChunkWithRetry = async (bodyStr: string) => {
      const maxAttempts = 2;
      let lastResp: Response | null = null;
      let lastErr: unknown = null;
      for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        try {
          const resp = await fetch('https://graph.facebook.com/v25.0/', {
            method: 'POST',
            headers: {
              'Content-Type': 'application/x-www-form-urlencoded',
              Accept: 'application/json',
            },
            body: bodyStr,
            signal: AbortSignal.timeout(30_000),
          });
          lastResp = resp;
          const isTransient = resp.status === 429 || resp.status >= 500;
          if (!isTransient || attempt === maxAttempts) {
            return resp;
          }
          await resp.body?.cancel().catch(() => {});
        } catch (err) {
          lastErr = err;
          if (attempt === maxAttempts) {
            throw err;
          }
        }
        await new Promise((r) => setTimeout(r, 320 + Math.floor(Math.random() * 140)));
      }
      if (lastResp) return lastResp;
      throw lastErr || new Error('Meta Batch request failed');
    };

    await Promise.all([
      ...inflightWaits,
      ...chunks.map(async (chunk) => {
        const formBody = new URLSearchParams();
        formBody.set('access_token', tokenToUse);
        formBody.set('include_headers', 'false');
        formBody.set(
          'batch',
          JSON.stringify(
            chunk.map((u) => ({
              method: 'GET',
              relative_url: u.relativeUrl,
            }))
          )
        );

        let resp: Response;
        try {
          resp = await executeBatchChunkWithRetry(formBody.toString());
        } catch (netErr: any) {
          for (const target of chunk) {
            const errObj = { message: netErr?.message || 'Meta Batch network timeout' };
            for (const k of target.keys) itemErrors[k] = errObj;
            slotResolvers.get(target.cacheKey)?.(null);
          }
          return;
        }

        const text = await resp.text();
        let parsedBatch: any = null;
        try {
          parsedBatch = text ? JSON.parse(text) : null;
        } catch {
          parsedBatch = null;
        }

        if (!resp.ok || (parsedBatch && !Array.isArray(parsedBatch) && parsedBatch.error)) {
          const metaErr = parsedBatch?.error || null;
          const isExpiredToken = Number(metaErr?.code) === 190 || Number(metaErr?.code) === 102;
          const errMessage = isExpiredToken
            ? 'Meta Access Token đã hết hạn hoặc bị thu hồi (Mã lỗi 190). Vui lòng bấm Kết nối Token Mới để cấp lại.'
            : metaErr?.message || `Meta Batch API phản hồi lỗi HTTP ${resp.status}.`;
          const chunkErrObj = metaErr || { status: resp.status, message: errMessage };
          for (const target of chunk) {
            for (const k of target.keys) itemErrors[k] = chunkErrObj;
            slotResolvers.get(target.cacheKey)?.(null);
          }
          if (isExpiredToken) {
            hasExpiredTokenSubError = true;
          }
          if (!fatalHolder.err || isExpiredToken) {
            fatalHolder.err = {
              status: isExpiredToken ? 401 : resp.status >= 400 ? resp.status : 422,
              message: errMessage,
              meta_error: metaErr,
            };
          }
          return;
        }

        if (!Array.isArray(parsedBatch)) {
          const invalidErrObj = { status: 502, message: 'Meta Batch API trả về dữ liệu không hợp lệ.' };
          for (const target of chunk) {
            for (const k of target.keys) itemErrors[k] = invalidErrObj;
            slotResolvers.get(target.cacheKey)?.(null);
          }
          if (!fatalHolder.err) {
            fatalHolder.err = {
              status: 502,
              message: 'Meta Batch API trả về dữ liệu không hợp lệ.',
            };
          }
          return;
        }

        for (let i = 0; i < chunk.length; i++) {
          const target = chunk[i];
          const slot = parsedBatch[i];
          if (!slot) {
            for (const k of target.keys) itemErrors[k] = { message: 'Missing batch slot response' };
            slotResolvers.get(target.cacheKey)?.(null);
            continue;
          }
          let slotBody: any = {};
          if (typeof slot.body === 'string' && slot.body.trim()) {
            try {
              slotBody = JSON.parse(slot.body);
            } catch {
              slotBody = { raw: slot.body.slice(0, 300) };
            }
          } else if (slot.body && typeof slot.body === 'object') {
            slotBody = slot.body;
          }

          const codeNum = Number(slot.code || 0);
          if (codeNum >= 200 && codeNum < 300 && !slotBody?.error) {
            for (const k of target.keys) results[k] = slotBody;
            if (allowCache) {
              setCachedMetaGraphPayload(target.cacheKey, slotBody, target.relativeUrl);
            }
            slotResolvers.get(target.cacheKey)?.(slotBody);
          } else {
            const subErr = slotBody?.error || { code: codeNum, message: `Batch item HTTP ${codeNum}` };
            if (Number(subErr?.code) === 190 || Number(subErr?.code) === 102) {
              hasExpiredTokenSubError = true;
            }
            for (const k of target.keys) itemErrors[k] = subErr;
            slotResolvers.get(target.cacheKey)?.(null);
          }
        }
      }),
    ]);
  } finally {
    for (const [ck, resolver] of slotResolvers.entries()) {
      resolver(null);
      inFlightMetaGraphRequests.delete(`slot:${ck}`);
    }
  }

  if (fatalHolder.err && Object.keys(results).length === 0) {
    return {
      success: false as const,
      status: fatalHolder.err.status,
      message: fatalHolder.err.message,
      meta_error: fatalHolder.err.meta_error,
    };
  }

  if (Object.keys(results).length === 0 && hasExpiredTokenSubError) {
    return {
      success: false as const,
      status: 401,
      message:
        'Meta Access Token đã hết hạn hoặc bị thu hồi (Mã lỗi 190). Vui lòng bấm Kết nối Token Mới để cấp lại.',
    };
  }

  return {
    success: true as const,
    status: 200,
    data: results,
    ...(Object.keys(itemErrors).length > 0 ? { errors: itemErrors } : {}),
    cache_hits: cacheHits,
  };
}

export async function proxyDomMetaGraphRequest(
  client: DbClient,
  tenantId: string,
  input: {
    ad_account_id?: string;
    graph_path: string;
    params?: Record<string, string | number | boolean | undefined>;
    override_access_token?: string;
    force_refresh?: boolean;
  }
) {
  const cleanPath = String(input.graph_path || '')
    .trim()
    .replace(/^\/+|\/+$/g, '');

  if (!cleanPath || !SAFE_GRAPH_PATH_REGEX.test(cleanPath)) {
    return {
      success: false as const,
      status: 422,
      message: `Đường dẫn Meta Graph '${cleanPath}' không hợp lệ hoặc không nằm trong danh mục cho phép.`,
    };
  }

  const tokenRes = await resolveDomMetaAccessToken(
    client,
    tenantId,
    input.ad_account_id,
    input.override_access_token
  );
  if (!tokenRes.success) {
    return tokenRes;
  }

  return executeDomMetaGraphGet(tenantId, tokenRes.accessToken, {
    ad_account_id: input.ad_account_id,
    graph_path: cleanPath,
    params: input.params,
    force_refresh: input.force_refresh,
    skip_cache: tokenRes.isOverride,
  });
}

export async function proxyDomGoogleAdsRequest(
  client: DbClient,
  tenantId: string,
  input: {
    customer_id?: string;
    time_range?: { since: string; until: string };
    action?: 'sync' | 'ads_data' | 'keywords';
    campaign_id?: string;
    since?: string;
    until?: string;
    test_connection?: boolean;
    override_config?: {
      customer_id?: string;
      apps_script_url?: string;
      developer_token?: string;
    };
  }
) {
  const vault = await readDomMetaVault(client, tenantId);
  const isTest = Boolean(input.test_connection === true);

  if (!isTest && vault.google_ads.enabled !== true) {
    return {
      success: false as const,
      status: 422,
      message: 'Tích hợp Google Ads hiện đang TẮT (mặc định). Vui lòng bật công tắc Google Ads trong Cài đặt để đồng bộ.',
    };
  }

  const overrideUrlRaw = String(input.override_config?.apps_script_url || '').trim();
  const savedUrlRaw = String(vault.google_ads.apps_script_url || '').trim();
  const useMccQuickMode =
    !overrideUrlRaw && vault.google_ads.setup_mode === 'mcc_quick';

  if (useMccQuickMode) {
    return proxyDomGoogleAdsViaMccHub(client, tenantId, vault, input);
  }

  const rawScriptUrl = overrideUrlRaw || savedUrlRaw;

  const urlCheck = validateGoogleAppsScriptUrl(rawScriptUrl);
  if (!urlCheck.valid) {
    return {
      success: false as const,
      status: 422,
      message: urlCheck.reason || 'Chưa cấu hình Google Apps Script Web App URL hợp lệ.',
    };
  }

  const customerId = String(
    input.override_config?.customer_id ?? input.customer_id ?? vault.google_ads.customer_id ?? ''
  )
    .trim()
    .replace(/^act_/i, '');

  // Never attach stored vault developer_token if caller overrides apps_script_url to a different endpoint
  const isSameAsSavedUrl =
    !overrideUrlRaw ||
    (savedUrlRaw && validateGoogleAppsScriptUrl(savedUrlRaw).normalized === urlCheck.normalized);
  const rawOverrideDevToken = String(input.override_config?.developer_token || '').trim();
  const devToken =
    rawOverrideDevToken && !rawOverrideDevToken.includes('***') && !rawOverrideDevToken.includes('...')
      ? rawOverrideDevToken
      : isSameAsSavedUrl
        ? vault.google_ads.developer_token
        : '';

  const target = new URL(urlCheck.normalized);
  if (customerId) {
    target.searchParams.set('account_id', customerId);
  }
  if (devToken && !devToken.includes('***') && !devToken.includes('...')) {
    target.searchParams.set('token', devToken);
  }
  if (input.action === 'sync') {
    target.searchParams.set('action', 'sync');
  } else if (input.action === 'keywords' && input.campaign_id) {
    target.searchParams.set('type', 'keywords');
    target.searchParams.set('campaignId', String(input.campaign_id));
    if (input.since) target.searchParams.set('since', String(input.since));
    if (input.until) target.searchParams.set('until', String(input.until));
  } else if (input.time_range?.since && input.time_range?.until) {
    target.searchParams.set('time_range', JSON.stringify(input.time_range));
    target.searchParams.set('since', String(input.time_range.since));
    target.searchParams.set('until', String(input.time_range.until));
  }

  const allowGadsCache =
    !isTest &&
    isSameAsSavedUrl &&
    !rawOverrideDevToken &&
    !customExternalFetcher &&
    input.action !== 'sync';
  const gadsCacheKey = `gads:${tenantId}:${target.toString()}`;
  if (allowGadsCache) {
    const cachedGads = getCachedMetaGraphPayload(gadsCacheKey);
    if (cachedGads !== undefined) {
      return {
        success: true as const,
        status: 200,
        data: cachedGads,
        cached: true,
      };
    }
  }

  const upstream = await performExternalGet(target.toString());
  if (!upstream.ok) {
    return {
      success: false as const,
      status: upstream.status >= 400 ? upstream.status : 502,
      message: `Google Ads Apps Script phản hồi lỗi HTTP ${upstream.status}.`,
    };
  }

  if (!upstream.isJson) {
    const looksLikeHtmlLogin =
      /<!doctype html|<html|accounts\.google\.com|ServiceLogin/i.test(upstream.rawText);
    return {
      success: false as const,
      status: 422,
      message: looksLikeHtmlLogin
        ? 'Google Apps Script trả về trang đăng nhập HTML thay vì dữ liệu JSON. Vui lòng kiểm tra Bước 4 khi Deploy Web App: chọn "Who has access: Anyone" (Bất kỳ ai).'
        : 'Google Apps Script không trả về định dạng JSON hợp lệ. Vui lòng kiểm tra lại URL .../exec và mã script.',
    };
  }

  if (upstream.data && typeof upstream.data === 'object' && !Array.isArray(upstream.data)) {
    if (upstream.data.ok === false || (typeof upstream.data.error === 'string' && upstream.data.error)) {
      return {
        success: false as const,
        status: 422,
        message: String(upstream.data.error || upstream.data.message || 'Apps Script báo lỗi khi truy vấn Google Ads.'),
      };
    }
  }

  if (isTest && isSameAsSavedUrl && vault.google_ads.apps_script_url) {
    vault.google_ads.last_verified_at = new Date().toISOString();
    await writeDomMetaVault(client, tenantId, vault);
  }

  if (allowGadsCache) {
    setCachedMetaGraphPayload(
      gadsCacheKey,
      upstream.data,
      input.time_range ? `time_range=${JSON.stringify(input.time_range)}` : ''
    );
  }

  return {
    success: true as const,
    status: 200,
    data: upstream.data,
  };
}

// ============================================================================
// DOMATION MCC Hub (Zero-Trust OTP Ownership Verification + Multi-ID Proxy)
// ============================================================================

interface MccInspectResult {
  ok: boolean;
  linked: boolean;
  status: string;
  customer_id: string;
  account_name: string;
  currency_code: string;
  time_zone: string;
  user_access_readable: boolean;
  admin_emails: string[];
  standard_emails: string[];
  error?: string;
}

async function inspectGoogleAdsAccountViaMccHub(customerId: string): Promise<MccInspectResult> {
  const masterUrl = getMasterGoogleAdsMccScriptUrl();
  const urlCheck = validateGoogleAppsScriptUrl(masterUrl);
  if (!urlCheck.valid) {
    return {
      ok: false,
      linked: false,
      status: 'error',
      customer_id: customerId,
      account_name: '',
      currency_code: 'VND',
      time_zone: 'Asia/Ho_Chi_Minh',
      user_access_readable: false,
      admin_emails: [],
      standard_emails: [],
      error: 'Chưa cấu hình URL Master MCC Google Ads Hub trên hệ thống.',
    };
  }

  const target = new URL(urlCheck.normalized);
  target.searchParams.set('action', 'inspect_mcc_account');
  target.searchParams.set('account_id', customerId);
  const hubSecret = getMasterGoogleAdsMccSecret();
  if (hubSecret) {
    target.searchParams.set('hub_secret', hubSecret);
  }

  const upstream = await performExternalGet(target.toString());
  if (!upstream.ok || !upstream.isJson || !upstream.data || typeof upstream.data !== 'object') {
    return {
      ok: false,
      linked: false,
      status: 'error',
      customer_id: customerId,
      account_name: '',
      currency_code: 'VND',
      time_zone: 'Asia/Ho_Chi_Minh',
      user_access_readable: false,
      admin_emails: [],
      standard_emails: [],
      error: `Không thể kiểm tra trạng thái MCC Hub (HTTP ${upstream.status}).`,
    };
  }

  const d = upstream.data as Record<string, any>;
  if (d.ok === false) {
    return {
      ok: false,
      linked: false,
      status: 'error',
      customer_id: customerId,
      account_name: '',
      currency_code: 'VND',
      time_zone: 'Asia/Ho_Chi_Minh',
      user_access_readable: false,
      admin_emails: [],
      standard_emails: [],
      error: String(d.error || d.message || 'MCC Hub báo lỗi kiểm tra tài khoản.'),
    };
  }

  return {
    ok: true,
    linked: Boolean(d.linked === true),
    status: String(d.status || (d.linked ? 'linked' : 'pending_mcc')),
    customer_id: customerId,
    account_name: String(d.account_name || `Google Ads ${customerId}`).trim(),
    currency_code: String(d.currency_code || 'VND').trim(),
    time_zone: String(d.time_zone || 'Asia/Ho_Chi_Minh').trim(),
    user_access_readable: Boolean(d.user_access_readable === true),
    admin_emails: Array.isArray(d.admin_emails)
      ? d.admin_emails
          .map((e: unknown) => String(e || '').trim().toLowerCase())
          .filter((e: string) => e.includes('@'))
      : [],
    standard_emails: Array.isArray(d.standard_emails)
      ? d.standard_emails
          .map((e: unknown) => String(e || '').trim().toLowerCase())
          .filter((e: string) => e.includes('@'))
      : [],
  };
}

async function fetchSingleMccGoogleAdsPayload(
  tenantId: string,
  customerId: string,
  input: {
    time_range?: { since: string; until: string };
    action?: 'sync' | 'ads_data' | 'keywords';
    campaign_id?: string;
    since?: string;
    until?: string;
    test_connection?: boolean;
  }
) {
  const masterUrl = getMasterGoogleAdsMccScriptUrl();
  const urlCheck = validateGoogleAppsScriptUrl(masterUrl);
  if (!urlCheck.valid) {
    return {
      success: false as const,
      status: 500,
      message: 'Hệ thống chưa cấu hình Master MCC Apps Script URL.',
    };
  }

  const target = new URL(urlCheck.normalized);
  target.searchParams.set('account_id', customerId);
  const hubSecret = getMasterGoogleAdsMccSecret();
  if (hubSecret) {
    target.searchParams.set('hub_secret', hubSecret);
  }
  if (input.action === 'sync') {
    target.searchParams.set('action', 'sync');
  } else if (input.action === 'keywords' && input.campaign_id) {
    target.searchParams.set('type', 'keywords');
    target.searchParams.set('campaignId', String(input.campaign_id));
    if (input.since) target.searchParams.set('since', String(input.since));
    if (input.until) target.searchParams.set('until', String(input.until));
  } else if (input.time_range?.since && input.time_range?.until) {
    target.searchParams.set('time_range', JSON.stringify(input.time_range));
    target.searchParams.set('since', String(input.time_range.since));
    target.searchParams.set('until', String(input.time_range.until));
  }

  const allowCache = !input.test_connection && !customExternalFetcher && input.action !== 'sync';
  const cacheKey = `gads_mcc:${tenantId}:${customerId}:${target.searchParams.toString()}`;
  if (allowCache) {
    const cached = getCachedMetaGraphPayload(cacheKey);
    if (cached !== undefined) {
      return { success: true as const, status: 200, data: cached, cached: true };
    }
  }

  const upstream = await performExternalGet(target.toString());
  if (!upstream.ok) {
    return {
      success: false as const,
      status: upstream.status >= 400 ? upstream.status : 502,
      message: `MCC Google Ads Hub phản hồi lỗi HTTP ${upstream.status}.`,
    };
  }
  if (!upstream.isJson) {
    return {
      success: false as const,
      status: 422,
      message: 'MCC Google Ads Hub không trả về JSON hợp lệ. Vui lòng kiểm tra cấu hình Deploy Web App (Anyone).',
    };
  }
  if (upstream.data && typeof upstream.data === 'object' && !Array.isArray(upstream.data)) {
    if (upstream.data.ok === false || (typeof upstream.data.error === 'string' && upstream.data.error)) {
      return {
        success: false as const,
        status: 422,
        message: String(upstream.data.error || upstream.data.message || 'MCC Google Ads Hub báo lỗi.'),
      };
    }
  }

  if (allowCache) {
    setCachedMetaGraphPayload(
      cacheKey,
      upstream.data,
      input.time_range ? `time_range=${JSON.stringify(input.time_range)}` : ''
    );
  }

  return { success: true as const, status: 200, data: upstream.data };
}

async function proxyDomGoogleAdsViaMccHub(
  client: DbClient,
  tenantId: string,
  vault: DomMetaVaultPayload,
  input: {
    customer_id?: string;
    time_range?: { since: string; until: string };
    action?: 'sync' | 'ads_data' | 'keywords';
    campaign_id?: string;
    since?: string;
    until?: string;
    test_connection?: boolean;
    override_config?: { customer_id?: string };
  }
) {
  // ZERO-TRUST GUARD: Only accounts explicitly verified via OTP (status === 'connected')
  // belonging to THIS tenant are ever allowed to query data through the shared MCC Hub.
  const connectedAccounts = vault.google_ads.accounts.filter((a) => a.status === 'connected');
  if (connectedAccounts.length === 0) {
    return {
      success: false as const,
      status: 403,
      message:
        'Chưa có Google Ads ID nào được xác thực mã OTP trong Workspace này. Vui lòng nhập mã xác nhận gửi về email chủ tài khoản Google Ads để mở khóa dữ liệu.',
    };
  }

  const rawRequested = String(input.override_config?.customer_id ?? input.customer_id ?? '').trim();
  const isAllMode = rawRequested.toLowerCase() === 'all';

  if (isAllMode && input.action !== 'keywords') {
    const batchAccounts = connectedAccounts.slice(0, 10);
    const results = await Promise.all(
      batchAccounts.map(async (acc) => ({
        acc,
        res: await fetchSingleMccGoogleAdsPayload(tenantId, acc.customer_id, input),
      }))
    );

    const succeeded = results.filter((x) => x.res.success);
    if (succeeded.length === 0) {
      const firstErr = results[0]?.res;
      return {
        success: false as const,
        status: (!firstErr || firstErr.success ? 422 : firstErr.status) || 422,
        message:
          !firstErr || firstErr.success
            ? 'Không thể tải dữ liệu Google Ads từ MCC Hub.'
            : firstErr.message,
      };
    }

    let mergedHeaders: string[] = [];
    const mergedRows: unknown[][] = [];
    const mergedLeadForms: unknown[] = [];
    let latestSync: string | null = null;
    const multiPrefix = batchAccounts.length > 1;

    for (const item of succeeded) {
      if (!item.res.success) continue;
      const payload = item.res.data;
      if (!payload || typeof payload !== 'object' || Array.isArray(payload)) continue;
      const rec = payload as Record<string, any>;
      if (rec.syncedAt && (!latestSync || String(rec.syncedAt) > latestSync)) {
        latestSync = String(rec.syncedAt);
      }
      if (Array.isArray(rec.leadForms)) {
        mergedLeadForms.push(...rec.leadForms);
      }
      if (Array.isArray(rec.h) && Array.isArray(rec.d)) {
        const hdrs = rec.h.map((h: unknown) => String(h));
        const hasCidCol = hdrs.includes('customer_id');
        if (mergedHeaders.length === 0) {
          mergedHeaders = hasCidCol ? [...hdrs] : [...hdrs, 'customer_id'];
        }
        const campIdx = hdrs.indexOf('campaign');
        const cidIdx = hdrs.indexOf('customer_id');
        const accPrefix = `[${item.acc.label || item.acc.customer_id}] `;
        for (const rawRow of rec.d) {
          if (!Array.isArray(rawRow)) continue;
          const rowCopy = rawRow.slice(0, hdrs.length);
          while (rowCopy.length < hdrs.length) rowCopy.push('');
          if (multiPrefix && campIdx >= 0) {
            rowCopy[campIdx] = `${accPrefix}${String(rowCopy[campIdx] || '')}`;
          }
          if (hasCidCol && cidIdx >= 0) {
            rowCopy[cidIdx] = item.acc.customer_id;
          } else {
            rowCopy.push(item.acc.customer_id);
          }
          mergedRows.push(rowCopy);
        }
      }
    }

    return {
      success: true as const,
      status: 200,
      data: {
        ok: true,
        merged: true,
        customer_ids: batchAccounts.map((a) => a.customer_id),
        h: mergedHeaders,
        d: mergedRows,
        leadForms: mergedLeadForms,
        syncedAt: latestSync || new Date().toISOString(),
        direct: true,
      },
    };
  }

  let targetCid = '';
  if (rawRequested && !isAllMode) {
    targetCid = normalizeGoogleAdsCustomerId(rawRequested);
    if (!targetCid) {
      return {
        success: false as const,
        status: 422,
        message: 'Định dạng Google Ads Customer ID không hợp lệ (cần 10 chữ số XXX-XXX-XXXX).',
      };
    }
  } else {
    const primaryNorm = normalizeGoogleAdsCustomerId(vault.google_ads.customer_id);
    const primaryAcc = connectedAccounts.find((a) => a.customer_id === primaryNorm);
    targetCid = primaryAcc ? primaryAcc.customer_id : connectedAccounts[0].customer_id;
  }

  // STRICT ANTI-IDOR: Block any ID not verified inside THIS tenant's vault
  const matchedAccount = connectedAccounts.find((a) => a.customer_id === targetCid);
  if (!matchedAccount) {
    return {
      success: false as const,
      status: 403,
      message: `Tài khoản Google Ads ${targetCid} chưa được xác thực OTP hoặc không thuộc quyền quản lý của Workspace hiện tại.`,
    };
  }

  const out = await fetchSingleMccGoogleAdsPayload(tenantId, matchedAccount.customer_id, input);
  if (out.success && input.test_connection) {
    vault.google_ads.last_verified_at = new Date().toISOString();
    await writeDomMetaVault(client, tenantId, vault);
  }
  return out;
}

export async function requestGoogleAdsMccAccounts(
  client: DbClient,
  tenantId: string,
  actor: { email?: string; full_name?: string; phone?: string },
  input: {
    items: Array<{ customer_id: string; label?: string }>;
    note?: string;
  }
) {
  const rawItems = Array.isArray(input.items) ? input.items : [];
  if (rawItems.length === 0) {
    return {
      success: false as const,
      status: 422,
      message: 'Vui lòng nhập ít nhất 1 Google Ads Customer ID (dạng XXX-XXX-XXXX).',
    };
  }

  const normalizedItems: Array<{ customer_id: string; label: string }> = [];
  const seenInReq = new Set<string>();
  const invalidInputs: string[] = [];

  for (const item of rawItems) {
    const rawStr = String(item?.customer_id || '').trim();
    if (!rawStr) continue;
    const norm = normalizeGoogleAdsCustomerId(rawStr);
    if (!norm) {
      invalidInputs.push(rawStr);
      continue;
    }
    if (seenInReq.has(norm)) continue;
    seenInReq.add(norm);
    normalizedItems.push({
      customer_id: norm,
      label: String(item?.label || '').trim().slice(0, 120),
    });
  }

  if (invalidInputs.length > 0) {
    return {
      success: false as const,
      status: 422,
      message: `Mã Google Ads Customer ID không hợp lệ (cần đúng 10 chữ số, VD: 227-521-6666): ${invalidInputs.join(', ')}`,
    };
  }

  if (normalizedItems.length === 0) {
    return {
      success: false as const,
      status: 422,
      message: 'Vui lòng nhập ít nhất 1 Google Ads Customer ID hợp lệ.',
    };
  }

  const vault = await readDomMetaVault(client, tenantId);
  const existingMap = new Map(vault.google_ads.accounts.map((a) => [a.customer_id, a]));
  const projectedTotal =
    vault.google_ads.accounts.length +
    normalizedItems.filter((it) => !existingMap.has(it.customer_id)).length;
  if (projectedTotal > GOOGLE_ADS_MAX_ACCOUNTS_PER_WORKSPACE) {
    return {
      success: false as const,
      status: 422,
      message: `Mỗi Workspace hỗ trợ tối đa ${GOOGLE_ADS_MAX_ACCOUNTS_PER_WORKSPACE} Google Ads Customer ID.`,
    };
  }

  const contact = await fetchTenantPrimaryAdminContact(client, tenantId);
  const requesterName = actor.full_name || contact.adminName || 'Quản trị viên';
  const requesterEmail = actor.email || contact.adminEmail || '';
  const requesterPhone = actor.phone || contact.adminPhone || '';
  const mccId = getMasterGoogleAdsMccId();
  const nowIso = new Date().toISOString();

  vault.google_ads.enabled = true;
  vault.google_ads.setup_mode = 'mcc_quick';

  const sentOtpIds: Array<{ customer_id: string; masked_to: string; is_mcc_fallback: boolean }> = [];
  const pendingMccIds: Array<{ customer_id: string; label?: string }> = [];
  const alreadyConnectedIds: string[] = [];
  const inspectWarnings: string[] = [];

  for (const item of normalizedItems) {
    const existing = existingMap.get(item.customer_id);
    if (existing && existing.status === 'connected') {
      if (item.label) existing.label = item.label;
      alreadyConnectedIds.push(item.customer_id);
      continue;
    }

    const inspect = await inspectGoogleAdsAccountViaMccHub(item.customer_id);
    if (!inspect.ok) {
      // If MCC inspect endpoint temporarily unreachable, fall back safely to pending_mcc & notify admin
      inspectWarnings.push(`${item.customer_id}: ${inspect.error || 'Chưa kiểm tra được trạng thái MCC'}`);
      const nextEntry: DomMetaGoogleAdsAccountVaultItem = {
        customer_id: item.customer_id,
        label: item.label || existing?.label || '',
        status: 'pending_mcc',
        requested_at: nowIso,
        verified_at: null,
        verified_via: null,
        otp_sent_to_masked: null,
        otp_expires_at: null,
        otp_last_sent_at: null,
        last_error: null,
        otp_hash: null,
        otp_attempts: 0,
        otp_target_mode: null,
        pending_google_account_name: null,
      };
      if (existing) {
        Object.assign(existing, nextEntry);
      } else {
        vault.google_ads.accounts.push(nextEntry);
        existingMap.set(item.customer_id, nextEntry);
      }
      pendingMccIds.push({ customer_id: item.customer_id, label: nextEntry.label || undefined });
      continue;
    }

    if (!inspect.linked) {
      const nextEntry: DomMetaGoogleAdsAccountVaultItem = {
        customer_id: item.customer_id,
        label: item.label || existing?.label || '',
        status: 'pending_mcc',
        requested_at: nowIso,
        verified_at: null,
        verified_via: null,
        otp_sent_to_masked: null,
        otp_expires_at: null,
        otp_last_sent_at: null,
        last_error: null,
        otp_hash: null,
        otp_attempts: 0,
        otp_target_mode: null,
        pending_google_account_name: null,
      };
      if (existing) {
        Object.assign(existing, nextEntry);
      } else {
        vault.google_ads.accounts.push(nextEntry);
        existingMap.set(item.customer_id, nextEntry);
      }
      pendingMccIds.push({ customer_id: item.customer_id, label: nextEntry.label || undefined });
      continue;
    }

    // Account IS linked to MCC -> ZERO-TRUST: Never unlock without 6-digit OTP sent to real owner email!
    const otpCode = String(crypto.randomInt(100000, 1000000));
    const otpHash = hashGoogleAdsOtp(tenantId, item.customer_id, otpCode);
    const expiresAt = new Date(Date.now() + GOOGLE_ADS_OTP_TTL_MS).toISOString();

    const useOwnerEmails = inspect.user_access_readable && inspect.admin_emails.length > 0;
    const targetEmails = useOwnerEmails
      ? inspect.admin_emails
      : [
          (process.env.DOMATION_GOOGLE_ADS_MCC_ADMIN_EMAIL || '').trim() ||
            DEFAULT_GOOGLE_ADS_MCC_ADMIN_EMAIL,
        ];
    const maskedDisplay = useOwnerEmails
      ? inspect.admin_emails.map(maskOwnerEmailDisplay).join(', ')
      : `Quản trị MCC DOMATION (${maskOwnerEmailDisplay(targetEmails[0])})`;

    const nextEntry: DomMetaGoogleAdsAccountVaultItem = {
      customer_id: item.customer_id,
      // Do NOT leak real Google Ads descriptive_name before OTP is confirmed!
      label: item.label || existing?.label || '',
      status: 'pending_otp',
      requested_at: existing?.requested_at || nowIso,
      verified_at: null,
      verified_via: null,
      otp_sent_to_masked: maskedDisplay,
      otp_expires_at: expiresAt,
      otp_last_sent_at: nowIso,
      last_error: null,
      otp_hash: otpHash,
      otp_attempts: 0,
      otp_target_mode: useOwnerEmails ? 'owner_email' : 'mcc_admin',
      pending_google_account_name: inspect.account_name || null,
    };
    if (existing) {
      Object.assign(existing, nextEntry);
    } else {
      vault.google_ads.accounts.push(nextEntry);
      existingMap.set(item.customer_id, nextEntry);
    }

    await sendGoogleAdsMccOtpEmail({
      tenant_id: tenantId,
      tenant_name: contact.tenantName,
      tenant_slug: contact.tenantSlug,
      requester_name: requesterName,
      requester_email: requesterEmail,
      customer_id: item.customer_id,
      google_account_name: inspect.account_name || item.customer_id,
      otp_code: otpCode,
      expires_minutes: Math.round(GOOGLE_ADS_OTP_TTL_MS / 60000),
      to_emails: targetEmails,
      cc_email: useOwnerEmails ? undefined : DEFAULT_GOOGLE_ADS_MCC_CC_EMAIL,
      is_mcc_fallback: !useOwnerEmails,
    });

    sentOtpIds.push({
      customer_id: item.customer_id,
      masked_to: maskedDisplay,
      is_mcc_fallback: !useOwnerEmails,
    });
  }

  let mccInviteMailResult: { dispatched: boolean; success: boolean; error?: string } | null = null;
  if (pendingMccIds.length > 0) {
    const mailOut = await notifyGoogleAdsMccLinkRequest({
      tenant_id: tenantId,
      tenant_name: contact.tenantName,
      tenant_slug: contact.tenantSlug,
      requester_name: requesterName,
      requester_email: requesterEmail,
      requester_phone: requesterPhone,
      mcc_id: mccId,
      customer_ids: pendingMccIds,
      note: String(input.note || '').trim().slice(0, 500) || undefined,
    });
    mccInviteMailResult = {
      dispatched: mailOut.dispatched,
      success: mailOut.success,
      error: mailOut.error,
    };
  }

  if (!vault.google_ads.customer_id && vault.google_ads.accounts.length > 0) {
    const firstConnected = vault.google_ads.accounts.find((a) => a.status === 'connected');
    vault.google_ads.customer_id = (firstConnected || vault.google_ads.accounts[0]).customer_id;
  }

  await writeDomMetaVault(client, tenantId, vault);

  return {
    success: true as const,
    status: 200,
    data: {
      google_ads: buildGoogleAdsConfigDto(vault.google_ads),
      sent_otp_ids: sentOtpIds,
      pending_mcc_ids: pendingMccIds.map((x) => x.customer_id),
      already_connected_ids: alreadyConnectedIds,
      mcc_invite_mail: mccInviteMailResult,
      warnings: inspectWarnings,
    },
  };
}

export async function resendGoogleAdsMccOtp(
  client: DbClient,
  tenantId: string,
  actor: { email?: string; full_name?: string; phone?: string },
  customerIdRaw: string
) {
  const cid = normalizeGoogleAdsCustomerId(customerIdRaw);
  if (!cid) {
    return {
      success: false as const,
      status: 422,
      message: 'Định dạng Google Ads Customer ID không hợp lệ.',
    };
  }

  const vault = await readDomMetaVault(client, tenantId);
  const acc = vault.google_ads.accounts.find((a) => a.customer_id === cid);
  if (!acc) {
    return {
      success: false as const,
      status: 404,
      message: `Không tìm thấy Google Ads ID ${cid} trong Workspace này.`,
    };
  }
  if (acc.status === 'connected') {
    return {
      success: true as const,
      status: 200,
      data: {
        already_connected: true,
        linked: true,
        google_ads: buildGoogleAdsConfigDto(vault.google_ads),
      },
    };
  }

  // Cooldown 60s if already in pending_otp (do not block first transition from pending_mcc -> pending_otp)
  if (acc.status === 'pending_otp' && acc.otp_last_sent_at) {
    const elapsed = Date.now() - new Date(acc.otp_last_sent_at).getTime();
    if (!Number.isNaN(elapsed) && elapsed >= 0 && elapsed < GOOGLE_ADS_OTP_RESEND_COOLDOWN_MS) {
      const waitSec = Math.ceil((GOOGLE_ADS_OTP_RESEND_COOLDOWN_MS - elapsed) / 1000);
      return {
        success: false as const,
        status: 429,
        message: `Vui lòng đợi ${waitSec} giây trước khi yêu cầu gửi lại mã xác nhận OTP.`,
      };
    }
  }

  const inspect = await inspectGoogleAdsAccountViaMccHub(cid);
  if (!inspect.ok) {
    return {
      success: false as const,
      status: 502,
      message: inspect.error || 'Không thể kiểm tra trạng thái liên kết MCC lúc này.',
    };
  }

  if (!inspect.linked) {
    acc.status = 'pending_mcc';
    acc.last_error = null;
    await writeDomMetaVault(client, tenantId, vault);
    return {
      success: false as const,
      status: 422,
      code: 'MCC_NOT_ACCEPTED_YET',
      message: `Tài khoản ${cid} chưa được chấp nhận (Accept) vào MCC ${getMasterGoogleAdsMccId()}. Vui lòng vào Google Ads → Công cụ → Quyền truy cập và bảo mật → Người quản lý để bấm Chấp nhận lời mời rồi thử lại.`,
    };
  }

  const contact = await fetchTenantPrimaryAdminContact(client, tenantId);
  const otpCode = String(crypto.randomInt(100000, 1000000));
  const nowIso = new Date().toISOString();
  const expiresAt = new Date(Date.now() + GOOGLE_ADS_OTP_TTL_MS).toISOString();

  const useOwnerEmails = inspect.user_access_readable && inspect.admin_emails.length > 0;
  const targetEmails = useOwnerEmails
    ? inspect.admin_emails
    : [
        (process.env.DOMATION_GOOGLE_ADS_MCC_ADMIN_EMAIL || '').trim() ||
          DEFAULT_GOOGLE_ADS_MCC_ADMIN_EMAIL,
      ];
  const maskedDisplay = useOwnerEmails
    ? inspect.admin_emails.map(maskOwnerEmailDisplay).join(', ')
    : `Quản trị MCC DOMATION (${maskOwnerEmailDisplay(targetEmails[0])})`;

  acc.status = 'pending_otp';
  acc.otp_hash = hashGoogleAdsOtp(tenantId, cid, otpCode);
  acc.otp_attempts = 0;
  acc.otp_expires_at = expiresAt;
  acc.otp_last_sent_at = nowIso;
  acc.otp_sent_to_masked = maskedDisplay;
  acc.otp_target_mode = useOwnerEmails ? 'owner_email' : 'mcc_admin';
  acc.pending_google_account_name = inspect.account_name || null;
  acc.last_error = null;

  await sendGoogleAdsMccOtpEmail({
    tenant_id: tenantId,
    tenant_name: contact.tenantName,
    tenant_slug: contact.tenantSlug,
    requester_name: actor.full_name || contact.adminName || 'Quản trị viên',
    requester_email: actor.email || contact.adminEmail || '',
    customer_id: cid,
    google_account_name: inspect.account_name || cid,
    otp_code: otpCode,
    expires_minutes: Math.round(GOOGLE_ADS_OTP_TTL_MS / 60000),
    to_emails: targetEmails,
    cc_email: useOwnerEmails ? undefined : DEFAULT_GOOGLE_ADS_MCC_CC_EMAIL,
    is_mcc_fallback: !useOwnerEmails,
  });

  await writeDomMetaVault(client, tenantId, vault);

  return {
    success: true as const,
    status: 200,
    data: {
      linked: true,
      customer_id: cid,
      otp_sent_to_masked: maskedDisplay,
      is_mcc_fallback: !useOwnerEmails,
      otp_expires_at: expiresAt,
      google_ads: buildGoogleAdsConfigDto(vault.google_ads),
    },
  };
}

export async function verifyGoogleAdsMccOtp(
  client: DbClient,
  tenantId: string,
  customerIdRaw: string,
  otpCodeRaw: string
) {
  const cid = normalizeGoogleAdsCustomerId(customerIdRaw);
  const cleanOtp = String(otpCodeRaw || '').replace(/\D/g, '').trim();
  if (!cid) {
    return {
      success: false as const,
      status: 422,
      message: 'Định dạng Google Ads Customer ID không hợp lệ.',
    };
  }
  if (cleanOtp.length !== 6) {
    return {
      success: false as const,
      status: 422,
      message: 'Mã xác nhận OTP phải gồm đúng 6 chữ số.',
    };
  }

  const vault = await readDomMetaVault(client, tenantId);
  const acc = vault.google_ads.accounts.find((a) => a.customer_id === cid);
  if (!acc) {
    return {
      success: false as const,
      status: 404,
      message: `Không tìm thấy Google Ads ID ${cid} trong Workspace này.`,
    };
  }

  if (acc.status === 'connected') {
    return {
      success: true as const,
      status: 200,
      data: {
        verified: true,
        account: toGoogleAdsAccountDto(acc),
        google_ads: buildGoogleAdsConfigDto(vault.google_ads),
      },
    };
  }

  if (acc.status !== 'pending_otp' || !acc.otp_hash) {
    return {
      success: false as const,
      status: 422,
      message: 'Chưa có mã OTP hiệu lực cho tài khoản này. Vui lòng bấm "Gửi mã xác nhận OTP" trước.',
    };
  }

  if (!acc.otp_expires_at || Date.now() > new Date(acc.otp_expires_at).getTime()) {
    acc.otp_hash = null;
    acc.otp_attempts = 0;
    acc.last_error = 'Mã OTP đã hết hạn (quá 10 phút).';
    await writeDomMetaVault(client, tenantId, vault);
    return {
      success: false as const,
      status: 422,
      message: 'Mã OTP đã hết hạn (quá 10 phút). Vui lòng bấm "Gửi lại mã" để nhận mã mới.',
    };
  }

  const attempts = Number(acc.otp_attempts || 0);
  if (attempts >= GOOGLE_ADS_OTP_MAX_ATTEMPTS) {
    acc.otp_hash = null;
    acc.last_error = 'Đã vượt quá 5 lần nhập sai mã OTP.';
    await writeDomMetaVault(client, tenantId, vault);
    return {
      success: false as const,
      status: 429,
      message: 'Bạn đã nhập sai mã OTP quá 5 lần. Mã hiện tại đã bị hủy — vui lòng bấm "Gửi lại mã".',
    };
  }

  const candidateHash = hashGoogleAdsOtp(tenantId, cid, cleanOtp);
  if (!verifyGoogleAdsOtpHash(acc.otp_hash, candidateHash)) {
    const nextAttempts = attempts + 1;
    acc.otp_attempts = nextAttempts;
    const remaining = Math.max(0, GOOGLE_ADS_OTP_MAX_ATTEMPTS - nextAttempts);
    if (remaining === 0) {
      acc.otp_hash = null;
      acc.last_error = 'Đã nhập sai OTP quá 5 lần — cần gửi mã mới.';
    }
    await writeDomMetaVault(client, tenantId, vault);
    return {
      success: false as const,
      status: 422,
      message:
        remaining > 0
          ? `Mã OTP không chính xác. Bạn còn ${remaining} lần thử.`
          : 'Bạn đã nhập sai mã OTP 5 lần. Mã hiện tại đã bị hủy — vui lòng bấm "Gửi lại mã".',
    };
  }

  const nowIso = new Date().toISOString();
  acc.status = 'connected';
  acc.verified_at = nowIso;
  acc.verified_via = acc.otp_target_mode === 'owner_email' ? 'owner_email_otp' : 'mcc_admin_otp';
  if (!acc.label && acc.pending_google_account_name) {
    acc.label = acc.pending_google_account_name;
  }
  acc.otp_hash = null;
  acc.otp_attempts = 0;
  acc.otp_expires_at = null;
  acc.otp_sent_to_masked = null;
  acc.otp_target_mode = null;
  acc.pending_google_account_name = null;
  acc.last_error = null;

  vault.google_ads.enabled = true;
  vault.google_ads.setup_mode = 'mcc_quick';
  if (!vault.google_ads.customer_id) {
    vault.google_ads.customer_id = acc.customer_id;
  }
  vault.google_ads.last_verified_at = nowIso;

  await writeDomMetaVault(client, tenantId, vault);

  return {
    success: true as const,
    status: 200,
    data: {
      verified: true,
      account: toGoogleAdsAccountDto(acc),
      google_ads: buildGoogleAdsConfigDto(vault.google_ads),
    },
  };
}

export async function removeGoogleAdsMccAccount(
  client: DbClient,
  tenantId: string,
  customerIdRaw: string
) {
  const cid = normalizeGoogleAdsCustomerId(customerIdRaw);
  if (!cid) {
    return {
      success: false as const,
      status: 422,
      message: 'Định dạng Google Ads Customer ID không hợp lệ.',
    };
  }

  const vault = await readDomMetaVault(client, tenantId);
  const beforeLen = vault.google_ads.accounts.length;
  vault.google_ads.accounts = vault.google_ads.accounts.filter((a) => a.customer_id !== cid);
  if (vault.google_ads.accounts.length === beforeLen) {
    return {
      success: false as const,
      status: 404,
      message: `Không tìm thấy Google Ads ID ${cid} trong Workspace.`,
    };
  }

  if (normalizeGoogleAdsCustomerId(vault.google_ads.customer_id) === cid) {
    const nextConnected = vault.google_ads.accounts.find((a) => a.status === 'connected');
    vault.google_ads.customer_id = (nextConnected || vault.google_ads.accounts[0])?.customer_id || '';
  }

  await writeDomMetaVault(client, tenantId, vault);

  return {
    success: true as const,
    status: 200,
    data: {
      removed_customer_id: cid,
      google_ads: buildGoogleAdsConfigDto(vault.google_ads),
    },
  };
}

// ============================================================================
// Phase 1: Quick-Connect Status, Auto-Connect & Closed-Loop CRM Attribution
// ============================================================================

export interface DomMetaQuickConnectStatusDto {
  has_meta_token: boolean;
  total_accounts: number;
  active_accounts: number;
  primary_ad_account_id: string;
  primary_account_name: string;
  has_capi_pixel: boolean;
  dom_meta_connected: boolean;
  can_auto_connect: boolean;
  accounts: MetaAdAccountPublicDto[];
}

export async function getDomMetaQuickConnectStatus(
  client: DbClient,
  tenantId: string
): Promise<DomMetaQuickConnectStatusDto> {
  const [metaSummary, domVault, domRowRes, capiRowRes] = await Promise.all([
    getMetaAdsConfigSummary(client, tenantId),
    readDomMetaVault(client, tenantId),
    client.query<{ status: string }>(
      `SELECT status FROM tenant_integrations WHERE tenant_id = $1 AND integration_type = 'dom_meta_report' LIMIT 1`,
      [tenantId]
    ),
    client.query<{ config_encrypted: string; iv: string; auth_tag: string }>(
      `SELECT config_encrypted, iv, auth_tag FROM tenant_integrations WHERE tenant_id = $1 AND integration_type = 'meta_capi' LIMIT 1`,
      [tenantId]
    ),
  ]);

  let hasCustomCapiPixel = false;
  if (capiRowRes.rows[0]) {
    try {
      const capiRaw = decryptTenantSecret<Record<string, unknown>>(
        tenantId,
        capiRowRes.rows[0].config_encrypted,
        capiRowRes.rows[0].iv,
        capiRowRes.rows[0].auth_tag
      );
      hasCustomCapiPixel = Boolean(
        String(capiRaw?.capi_pixel_id || capiRaw?.dataset_id || '').trim()
      );
    } catch {
      hasCustomCapiPixel = false;
    }
  }

  const hasDomMetaRow = Boolean(domRowRes.rows[0] && domRowRes.rows[0].status === 'active');
  const vaultPrimaryId = normalizeAdAccountId(domVault.primary_ad_account_id);
  const publicAccounts = metaSummary.accounts;
  const hasMetaToken = Boolean(metaSummary.has_token);
  const activeAccounts = metaSummary.active_accounts;

  const linkedPrimaryAcc = vaultPrimaryId
    ? publicAccounts.find((a) => a.ad_account_id === vaultPrimaryId)
    : undefined;
  const fallbackPrimaryAcc =
    linkedPrimaryAcc ||
    publicAccounts.find((a) => a.is_active && a.has_token) ||
    publicAccounts.find((a) => a.has_token) ||
    publicAccounts[0] ||
    null;

  const domMetaConnected = Boolean(
    hasDomMetaRow &&
      hasMetaToken &&
      activeAccounts > 0 &&
      vaultPrimaryId &&
      publicAccounts.some(
        (a) => a.is_active && a.has_token && a.ad_account_id === vaultPrimaryId
      )
  );

  const canAutoConnect = Boolean(
    hasMetaToken && publicAccounts.some((a) => a.has_token) && !domMetaConnected
  );

  const hasCapiPixel = Boolean(
    metaSummary.pixel_id ||
      publicAccounts.some((a) => Boolean(a.pixel_id)) ||
      hasCustomCapiPixel
  );

  return {
    has_meta_token: hasMetaToken,
    total_accounts: metaSummary.total_accounts,
    active_accounts: activeAccounts,
    primary_ad_account_id: fallbackPrimaryAcc?.ad_account_id || metaSummary.ad_account_id || '',
    primary_account_name: fallbackPrimaryAcc?.name || '',
    has_capi_pixel: hasCapiPixel,
    dom_meta_connected: domMetaConnected,
    can_auto_connect: canAutoConnect,
    accounts: publicAccounts,
  };
}

export async function quickConnectDomMetaReport(
  client: DbClient,
  tenantId: string,
  input: {
    auto_reuse?: boolean;
    access_token?: string;
    accounts?: Array<{ ad_account_id: string; name?: string; pixel_id?: string }>;
    ad_account_id?: string;
    name?: string;
    pixel_id?: string;
    primary_ad_account_id?: string;
  }
) {
  const cleanPixelId = String(input.pixel_id || '').trim();

  if (input.auto_reuse === true) {
    const metaSummary = await getMetaAdsConfigSummary(client, tenantId);
    const tokenAccounts = metaSummary.accounts.filter((a) => a.has_token);
    if (!metaSummary.has_token || tokenAccounts.length === 0) {
      return {
        success: false as const,
        message:
          'Chưa có kết nối Meta sẵn có trong hệ thống để kích hoạt tự động. Vui lòng dán mã kết nối Meta để thiết lập.',
      };
    }

    const reqPrimary = normalizeAdAccountId(input.primary_ad_account_id);
    const targetAcc =
      (reqPrimary ? tokenAccounts.find((a) => a.ad_account_id === reqPrimary) : undefined) ||
      tokenAccounts.find((a) => a.is_active) ||
      tokenAccounts[0];

    if (!targetAcc.is_active) {
      await toggleMetaAdAccountStatus(client, tenantId, targetAcc.id, true);
    }

    if (cleanPixelId && cleanPixelId !== targetAcc.pixel_id) {
      await upsertMetaAdAccount(client, tenantId, {
        id: targetAcc.id,
        name: targetAcc.name,
        ad_account_id: targetAcc.ad_account_id,
        access_token: '__KEEP_EXISTING__',
        pixel_id: cleanPixelId,
        is_active: true,
      });
    }

    // Preserves google_ads.enabled = false default unless already enabled
    await saveDomMetaWorkspaceConfig(client, tenantId, {
      primary_ad_account_id: targetAcc.ad_account_id,
    });

    const [status, config] = await Promise.all([
      getDomMetaQuickConnectStatus(client, tenantId),
      getDomMetaWorkspaceConfig(client, tenantId),
    ]);

    return {
      success: true as const,
      mode: 'auto_reuse' as const,
      connected_count: status.active_accounts,
      status,
      config,
      message: `Đã tự động kích hoạt Báo cáo Quảng cáo từ tài khoản "${targetAcc.name}".`,
    };
  }

  // Mode B: Connect with access_token (+ optional accounts[], optional pixel_id)
  const rawToken = String(input.access_token || '').trim();
  if (!rawToken || rawToken.length < 15) {
    return {
      success: false as const,
      message: 'Vui lòng nhập mã kết nối Meta hợp lệ (EAA...).',
    };
  }

  let candidateAccounts: Array<{ ad_account_id: string; name?: string; pixel_id?: string }> = [];
  if (Array.isArray(input.accounts) && input.accounts.length > 0) {
    candidateAccounts = input.accounts;
  } else if (input.ad_account_id && normalizeAdAccountId(input.ad_account_id)) {
    candidateAccounts = [
      {
        ad_account_id: String(input.ad_account_id),
        name: input.name ? String(input.name) : undefined,
        pixel_id: cleanPixelId || undefined,
      },
    ];
  }

  if (candidateAccounts.length > 0) {
    const shouldValidateTokenLive =
      Boolean(customExternalFetcher) ||
      (process.env.OUTBOUND_SILENT_MODE !== 'true' &&
        process.env.NODE_ENV !== 'test' &&
        process.env.VITEST !== 'true' &&
        !rawToken.startsWith('sandbox_') &&
        !rawToken.startsWith('demo_'));
    if (shouldValidateTokenLive) {
      const probeUrl = `https://graph.facebook.com/v25.0/me?fields=id,name&access_token=${encodeURIComponent(rawToken)}`;
      const probe = await performExternalGet(probeUrl);
      if (!probe.ok || probe.data?.error) {
        return {
          success: false as const,
          message:
            probe.data?.error?.message ||
            'Mã kết nối Meta không hợp lệ hoặc đã hết hạn. Vui lòng kiểm tra lại.',
        };
      }
    }
  } else {
    const discovered = await discoverMetaTokenAssets(client, tenantId, {
      access_token: rawToken,
      graphFetcher: customExternalFetcher
        ? async (u: string) => {
            const r = await performExternalGet(u);
            return { ok: r.ok, status: r.status, json: async () => r.data };
          }
        : undefined,
    });
    if (discovered.success && Array.isArray(discovered.ad_accounts) && discovered.ad_accounts.length > 0) {
      const activeDiscovered = discovered.ad_accounts.filter((a) => a.account_status === 1);
      const picked = activeDiscovered.length > 0 ? activeDiscovered : discovered.ad_accounts;
      candidateAccounts = picked.slice(0, 20).map((acc) => ({
        ad_account_id: acc.ad_account_id,
        name: acc.name,
        pixel_id: cleanPixelId || acc.pixels?.[0]?.id || undefined,
      }));
    } else {
      return {
        success: false as const,
        message:
          discovered.message ||
          'Vui lòng chọn ít nhất 1 tài khoản quảng cáo để kích hoạt báo cáo.',
      };
    }
  }

  const connected: MetaAdAccountPublicDto[] = [];
  for (let i = 0; i < Math.min(candidateAccounts.length, 30); i++) {
    const item = candidateAccounts[i];
    const cleanId = normalizeAdAccountId(item.ad_account_id);
    if (!cleanId) continue;
    const itemPixel = String(item.pixel_id || (i === 0 ? cleanPixelId : '') || '').trim();
    const res = await upsertMetaAdAccount(client, tenantId, {
      ad_account_id: cleanId,
      name: item.name,
      access_token: rawToken,
      pixel_id: itemPixel || undefined,
      is_active: true,
      requireNew: false,
    });
    if (res.success) {
      connected.push(res.account);
    }
  }

  if (connected.length === 0) {
    return {
      success: false as const,
      message: 'Không thể lưu tài khoản quảng cáo đã chọn. Vui lòng kiểm tra mã tài khoản.',
    };
  }

  const primaryId =
    normalizeAdAccountId(input.primary_ad_account_id) || connected[0]?.ad_account_id || '';
  await saveDomMetaWorkspaceConfig(client, tenantId, {
    primary_ad_account_id: primaryId,
  });

  const [status, config] = await Promise.all([
    getDomMetaQuickConnectStatus(client, tenantId),
    getDomMetaWorkspaceConfig(client, tenantId),
  ]);

  return {
    success: true as const,
    mode: 'token_connect' as const,
    connected_count: connected.length,
    accounts: connected,
    status,
    config,
    message: `Đã kết nối ${connected.length} tài khoản quảng cáo và kích hoạt Báo cáo Quảng cáo.`,
  };
}

export interface DomMetaCrmSaleBreakdownItem {
  user_id: string;
  name: string;
  avatar: string | null;
  lead_count: number;
  qualified_count: number;
  closed_count: number;
  revenue_vnd: number;
}

export interface DomMetaCrmEntityBucket {
  entity_id: string;
  total_leads: number;
  qualified_leads: number;
  closed_leads: number;
  negative_leads: number;
  pending_leads: number;
  positive_rate: number;
  total_revenue_vnd: number;
  capi_sent_count: number;
  pipeline: Record<string, number>;
  sales: DomMetaCrmSaleBreakdownItem[];
}

export interface DomMetaCrmEntityLeadItem {
  id: string;
  name: string;
  phone: string;
  email: string;
  pii_masked: boolean;
  created_at: string;
  assigned_to: string | null;
  assigned_to_name: string;
  assigned_to_avatar: string | null;
  round_name: string;
  quality_status: string;
  stage_key: string;
  quality_note: string | null;
  total_revenue_vnd: number;
  ad_id: string;
  ad_name: string;
  adset_id: string;
  campaign_id: string;
  campaign_name: string;
  source: string;
  capi_last_event: string | null;
  capi_last_status: 'sent' | 'failed' | null;
}

function resolveSafeTenantTimezone(rawTz?: string): string {
  const cand = String(rawTz || 'Asia/Ho_Chi_Minh').trim();
  if (!/^[A-Za-z0-9_+/:-]{1,64}$/.test(cand)) return 'Asia/Ho_Chi_Minh';
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: cand });
    return cand;
  } catch {
    return 'Asia/Ho_Chi_Minh';
  }
}

export async function getDomMetaCrmAttribution(
  client: DbClient,
  ctx: TenantContext,
  input: {
    since?: string;
    until?: string;
    entity_type?: string;
    entity_id?: string;
    entity_name?: string;
    sale_id?: string;
    quality_status?: string;
    search?: string;
    only_attributed?: boolean;
    page?: number;
    page_size?: number;
  }
) {
  const cfg = await getTenantSettingsCached(ctx.tenantId, client);
  const tenantTz = resolveSafeTenantTimezone(cfg.timezone_name);

  const params: unknown[] = [ctx.tenantId];
  let where = `l.tenant_id = $1 AND l.is_deleted = false AND l.status != 'archived'`;

  const sinceRaw = String(input.since || '').trim();
  const untilRaw = String(input.until || '').trim();
  const sinceMatch = /^(\d{4})-(\d{2})-(\d{2})$/.exec(sinceRaw);
  const untilMatch = /^(\d{4})-(\d{2})-(\d{2})$/.exec(untilRaw);

  if (sinceMatch) {
    const startUtc = zonedWallClockToUtc(
      Number(sinceMatch[1]),
      Number(sinceMatch[2]),
      Number(sinceMatch[3]),
      0,
      0,
      0,
      tenantTz
    );
    params.push(startUtc);
    where += ` AND l.created_at >= $${params.length}`;
  }
  if (untilMatch) {
    const endUtcBase = zonedWallClockToUtc(
      Number(untilMatch[1]),
      Number(untilMatch[2]),
      Number(untilMatch[3]),
      23,
      59,
      59,
      tenantTz
    );
    const endUtc = new Date(endUtcBase.getTime() + 999);
    params.push(endUtc);
    where += ` AND l.created_at <= $${params.length}`;
  }

  if (ctx.userRole === 'sale') {
    params.push(ctx.userId);
    where += ` AND l.assigned_to = $${params.length}`;
  }

  const [leadsRes, insightsMetaRes] = await Promise.all([
    client.query<{
      id: string;
      name: string;
      phone: string | null;
      email: string | null;
      created_at: Date | string;
      assigned_to: string | null;
      assigned_to_name: string | null;
      assigned_to_avatar: string | null;
      round_id: string | null;
      round_name: string | null;
      stage_id: string | null;
      stage_key: string | null;
      stage_name: string | null;
      is_won_stage: boolean | null;
      is_lost_stage: boolean | null;
      is_accepted: boolean | null;
      quality_status: string | null;
      quality_note: string | null;
      total_revenue_vnd: string | number | null;
      ad_id: string | null;
      adset_id: string | null;
      campaign_id: string | null;
      campaign: string | null;
      source: string | null;
      custom_fields: Record<string, any> | null;
    }>(
      `SELECT l.id, l.name, l.phone, l.email, l.created_at,
              l.assigned_to, u.full_name AS assigned_to_name, u.avatar_url AS assigned_to_avatar,
              l.round_id, r.name AS round_name,
              l.stage_id, tps.stage_key, tps.stage_name, tps.is_won_stage, tps.is_lost_stage,
              l.is_accepted, l.quality_status, l.quality_note, l.total_revenue_vnd,
              l.ad_id, l.adset_id, l.campaign_id, l.campaign, l.source, l.custom_fields
       FROM leads l
       LEFT JOIN users u ON u.tenant_id = l.tenant_id AND u.id = l.assigned_to
       LEFT JOIN distribution_rounds r ON r.tenant_id = l.tenant_id AND r.id = l.round_id
       LEFT JOIN tenant_pipeline_stages tps ON tps.tenant_id = l.tenant_id AND tps.id = l.stage_id
       WHERE ${where}
       ORDER BY l.created_at DESC`,
      params
    ),
    client.query<{
      ad_id: string;
      ad_name: string | null;
      adset_id: string | null;
      campaign_id: string | null;
      campaign_name: string | null;
    }>(
      `SELECT ad_id,
              MAX(ad_name) AS ad_name,
              MAX(adset_id) AS adset_id,
              MAX(campaign_id) AS campaign_id,
              MAX(campaign_name) AS campaign_name
       FROM meta_ads_insights
       WHERE tenant_id = $1
       GROUP BY ad_id`,
      [ctx.tenantId]
    ),
  ]);

  const rawRows = leadsRes.rows;
  if (rawRows.length > 0) {
    await enrichLeadAssigneeAndRound(client, ctx.tenantId, rawRows);
  }

  // Batch fetch CAPI logs for matched leads (tenant-scoped + ordered newest first)
  const latestCapiByLead = new Map<
    string,
    { lastEvent: string; lastStatus: 'sent' | 'failed'; hasSuccess: boolean }
  >();
  if (rawRows.length > 0) {
    const chunkSize = 500;
    for (let offset = 0; offset < rawRows.length; offset += chunkSize) {
      const sliceIds = rawRows.slice(offset, offset + chunkSize).map((r) => r.id);
      const idPlaceholders = sliceIds.map((_, idx) => `$${idx + 2}`).join(', ');
      const capiRes = await client.query<{
        lead_id: string;
        event_name: string;
        response_status: number;
      }>(
        `SELECT lead_id, event_name, response_status
         FROM capi_logs
         WHERE tenant_id = $1 AND lead_id IN (${idPlaceholders})
         ORDER BY sent_at DESC`,
        [ctx.tenantId, ...sliceIds]
      );
      for (const c of capiRes.rows) {
        const lid = String(c.lead_id);
        const statusNum = Number(c.response_status || 0);
        const isOk = statusNum >= 200 && statusNum < 300;
        const existing = latestCapiByLead.get(lid);
        if (!existing) {
          latestCapiByLead.set(lid, {
            lastEvent: String(c.event_name || 'Lead'),
            lastStatus: isOk ? 'sent' : 'failed',
            hasSuccess: isOk,
          });
        } else if (isOk && !existing.hasSuccess) {
          existing.hasSuccess = true;
        }
      }
    }
  }

  const adInsightsMap = new Map<
    string,
    { ad_name: string; adset_id: string; campaign_id: string; campaign_name: string }
  >();
  const campaignNameMap = new Map<string, string>();
  const campaignIdByLowerName = new Map<string, string>();
  for (const ins of insightsMetaRes.rows) {
    const aid = String(ins.ad_id || '').trim();
    const cid = String(ins.campaign_id || '').trim();
    const cname = String(ins.campaign_name || '').trim();
    if (aid) {
      adInsightsMap.set(aid, {
        ad_name: String(ins.ad_name || '').trim(),
        adset_id: String(ins.adset_id || '').trim(),
        campaign_id: cid,
        campaign_name: cname,
      });
    }
    if (cid && cname) {
      if (!campaignNameMap.has(cid)) {
        campaignNameMap.set(cid, cname);
      }
      const lowerCname = cname.toLowerCase();
      if (!campaignIdByLowerName.has(lowerCname)) {
        campaignIdByLowerName.set(lowerCname, cid);
      }
    }
  }

  // Stage classification aligned with legacy-analytics.ts & pipeline_capi_stages
  const activePipelineStages = (
    Array.isArray(cfg.pipeline_capi_stages) && cfg.pipeline_capi_stages.length > 0
      ? cfg.pipeline_capi_stages
      : DEFAULT_PIPELINE_CAPI_STAGES
  ).filter((st) => st.enabled !== false);

  const positiveKeys = new Set<string>(['Qualified', 'Booked', 'Booking', 'Deposited', 'Closed']);
  const negativeKeys = new Set<string>(['Notlead']);
  for (const st of activePipelineStages) {
    if (st.group === 'positive' || st.is_qualified) positiveKeys.add(st.key);
    else if (st.group === 'negative') negativeKeys.add(st.key);
  }

  const classifyStageKey = (raw: string, isWon?: boolean | null, isLost?: boolean | null): string => {
    const s = String(raw || '').normalize('NFC').toLowerCase().trim();
    if (s && s !== 'pending' && s !== 'new' && s !== 'unrated' && !s.includes('chưa đánh giá') && !s.includes('mới tiếp nhận')) {
      for (const st of activePipelineStages) {
        const stKeyLow = st.key.normalize('NFC').toLowerCase();
        const stLabelLow = st.label.normalize('NFC').toLowerCase();
        const stShortLow = st.short_label ? st.short_label.normalize('NFC').toLowerCase() : '';
        if (stKeyLow === s || stLabelLow === s || (stShortLow && stShortLow === s)) {
          return st.key;
        }
      }
      if (
        s === 'good' ||
        s === 'hot' ||
        s === 'mql' ||
        s === 'sql' ||
        s.includes('qualified') ||
        s.includes('thiện chí') ||
        s.includes('tiềm năng') ||
        s.includes('quan tâm') ||
        s.includes('nhu cầu') ||
        s.includes('đủ điều kiện')
      ) {
        return 'Qualified';
      }
      if (
        s === 'scheduled' ||
        s.includes('booked') ||
        s.includes('hẹn gặp') ||
        s.includes('xem mẫu') ||
        s.includes('lịch hẹn') ||
        s.includes('tư vấn trực tiếp') ||
        s.includes('tham quan')
      ) {
        return 'Booked';
      }
      if (s.includes('booking') || s.includes('giữ chỗ')) return 'Booking';
      if (s.includes('deposit') || s.includes('đặt cọc') || s === 'cọc') return 'Deposited';
      if (
        s === 'won' ||
        s === 'customer' ||
        s.includes('closed') ||
        s.includes('chốt') ||
        s.includes('ký hđ') ||
        s.includes('hợp đồng') ||
        s.includes('thanh toán') ||
        s.includes('thu tiền') ||
        s.includes('nhập học') ||
        s.includes('thành công')
      ) {
        return 'Closed';
      }
      if (
        s === 'bad_timing' ||
        s.includes('badtiming') ||
        s.includes('bad timing') ||
        s.includes('hẹn gọi') ||
        s.includes('liên hệ lại') ||
        s.includes('chưa có nhu cầu') ||
        s.includes('suy nghĩ thêm')
      ) {
        return 'Badtiming';
      }
      if (
        s === 'no_answer' ||
        s.includes('noanswer') ||
        s.includes('no answer') ||
        s.includes('liên lạc') ||
        s.includes('không nghe') ||
        s.includes('thuê bao') ||
        s.includes('tắt máy')
      ) {
        return 'NoAnswer';
      }
      if (
        s === 'disqualified' ||
        s === 'junk' ||
        s === 'lost' ||
        s.includes('notlead') ||
        s.includes('not lead') ||
        s.includes('không đúng') ||
        s.includes('không phù hợp') ||
        s.includes('sai số') ||
        s.includes('rác') ||
        s.includes('spam') ||
        s.includes('blacklist') ||
        s.includes('từ chối')
      ) {
        return 'Notlead';
      }
    }
    if (isWon) return 'Closed';
    if (isLost) return 'Notlead';
    return 'unrated';
  };

  const buildEmptyPipeline = (): Record<string, number> => {
    const base: Record<string, number> = {
      Qualified: 0,
      Booked: 0,
      Booking: 0,
      Deposited: 0,
      Closed: 0,
      Badtiming: 0,
      NoAnswer: 0,
      Notlead: 0,
      unrated: 0,
    };
    for (const st of activePipelineStages) {
      if (!(st.key in base)) base[st.key] = 0;
    }
    return base;
  };

  interface InternalBucket {
    entity_id: string;
    total_leads: number;
    qualified_leads: number;
    closed_leads: number;
    negative_leads: number;
    total_revenue_vnd: number;
    capi_sent_count: number;
    pipeline: Record<string, number>;
    salesMap: Map<string, DomMetaCrmSaleBreakdownItem>;
  }

  const getOrCreateBucket = (map: Map<string, InternalBucket>, entityId: string): InternalBucket => {
    let b = map.get(entityId);
    if (!b) {
      b = {
        entity_id: entityId,
        total_leads: 0,
        qualified_leads: 0,
        closed_leads: 0,
        negative_leads: 0,
        total_revenue_vnd: 0,
        capi_sent_count: 0,
        pipeline: buildEmptyPipeline(),
        salesMap: new Map(),
      };
      map.set(entityId, b);
    }
    return b;
  };

  const addLeadToBucket = (
    bucket: InternalBucket,
    stageKey: string,
    isQual: boolean,
    isClosed: boolean,
    isNeg: boolean,
    rev: number,
    hasCapi: boolean,
    saleId: string | null,
    saleName: string,
    saleAvatar: string | null
  ) => {
    bucket.total_leads += 1;
    if (isQual) bucket.qualified_leads += 1;
    if (isClosed) bucket.closed_leads += 1;
    if (isNeg) bucket.negative_leads += 1;
    bucket.total_revenue_vnd += rev;
    if (hasCapi) bucket.capi_sent_count += 1;
    bucket.pipeline[stageKey] = (bucket.pipeline[stageKey] || 0) + 1;

    if (saleId) {
      const existingSale = bucket.salesMap.get(saleId) || {
        user_id: saleId,
        name: saleName || 'Sale',
        avatar: saleAvatar,
        lead_count: 0,
        qualified_count: 0,
        closed_count: 0,
        revenue_vnd: 0,
      };
      existingSale.lead_count += 1;
      if (isQual) existingSale.qualified_count += 1;
      if (isClosed) existingSale.closed_count += 1;
      existingSale.revenue_vnd += rev;
      if (!existingSale.avatar && saleAvatar) existingSale.avatar = saleAvatar;
      bucket.salesMap.set(saleId, existingSale);
    }
  };

  const finalizeBucket = (b: InternalBucket): DomMetaCrmEntityBucket => {
    const pendingLeads = Math.max(0, b.total_leads - b.qualified_leads - b.negative_leads);
    return {
      entity_id: b.entity_id,
      total_leads: b.total_leads,
      qualified_leads: b.qualified_leads,
      closed_leads: b.closed_leads,
      negative_leads: b.negative_leads,
      pending_leads: pendingLeads,
      positive_rate: b.total_leads > 0 ? Math.round((b.qualified_leads / b.total_leads) * 100) : 0,
      total_revenue_vnd: b.total_revenue_vnd,
      capi_sent_count: b.capi_sent_count,
      pipeline: b.pipeline,
      sales: Array.from(b.salesMap.values()).sort((x, y) => y.lead_count - x.lead_count),
    };
  };

  const byAdMap = new Map<string, InternalBucket>();
  const byAdsetMap = new Map<string, InternalBucket>();
  const byCampaignMap = new Map<string, InternalBucket>();
  const byCampaignNameMap = new Map<string, InternalBucket>();

  let attributedLeads = 0;
  let attrQualified = 0;
  let attrClosed = 0;
  let attrNegative = 0;
  let attrRevenue = 0;
  let attrCapiSent = 0;

  interface EnrichedLeadInternal {
    raw: (typeof rawRows)[number];
    adId: string;
    adName: string;
    adsetId: string;
    campaignId: string;
    campaignName: string;
    saleId: string | null;
    saleName: string;
    saleAvatar: string | null;
    roundName: string;
    stageKey: string;
    isQual: boolean;
    isClosed: boolean;
    isNeg: boolean;
    rev: number;
    capiLastEvent: string | null;
    capiLastStatus: 'sent' | 'failed' | null;
  }

  const enrichedLeads: EnrichedLeadInternal[] = [];

  for (const r of rawRows) {
    const cf = r.custom_fields && typeof r.custom_fields === 'object' ? r.custom_fields : {};
    const adId = String(r.ad_id || cf.ad_id || cf.meta_ad_id || '').trim();
    const adMeta = adId ? adInsightsMap.get(adId) : undefined;
    const adsetId = String(r.adset_id || cf.adset_id || adMeta?.adset_id || '').trim();
    const explicitCampaignName = String(
      r.campaign || cf.campaign_name || cf.utm_campaign || ''
    ).trim();
    const campaignId = String(
      r.campaign_id ||
        cf.campaign_id ||
        cf.meta_campaign_id ||
        adMeta?.campaign_id ||
        (explicitCampaignName
          ? campaignIdByLowerName.get(explicitCampaignName.toLowerCase()) || ''
          : '') ||
        ''
    ).trim();
    const adName = String(cf.ad_name || cf.meta_ad_name || adMeta?.ad_name || '').trim();
    const campaignName = String(
      explicitCampaignName || campaignNameMap.get(campaignId) || adMeta?.campaign_name || ''
    ).trim();

    const rawQuality = String(r.quality_status || '').trim();
    const stageCandidates = [
      rawQuality && rawQuality.toLowerCase() !== 'pending' ? rawQuality : '',
      cf.sale_status,
      r.stage_name,
      r.stage_key,
      rawQuality,
    ];
    let stageKey = 'unrated';
    for (const cand of stageCandidates) {
      const cleanedCand = pickCleanName(cand);
      if (!cleanedCand) continue;
      const mapped = classifyStageKey(cleanedCand);
      if (mapped !== 'unrated') {
        stageKey = mapped;
        break;
      }
    }
    if (stageKey === 'unrated') {
      stageKey = classifyStageKey('', r.is_won_stage, r.is_lost_stage);
    }

    const isQual = positiveKeys.has(stageKey);
    const isClosed = stageKey === 'Closed' || Boolean(r.is_won_stage);
    const isNeg = negativeKeys.has(stageKey);
    const rev = Math.max(0, Number(r.total_revenue_vnd || 0));

    const capiInfo = latestCapiByLead.get(r.id);
    const hasCapi = Boolean(capiInfo?.hasSuccess);

    const saleId = r.assigned_to ? String(r.assigned_to) : null;
    const saleName =
      pickCleanName(
        r.assigned_to_name,
        cf.assigned_to_name,
        cf.assigned_sale_name,
        cf.consultant_name,
        cf.sale_name
      ) || (saleId ? 'Chuyên viên Sale' : 'Chưa phân bổ');
    const saleAvatar = r.assigned_to_avatar || null;
    const roundName = pickCleanName(r.round_name, cf.round_name) || '';

    const isAttributed = Boolean(adId || adsetId || campaignId || campaignName);
    if (isAttributed) {
      attributedLeads += 1;
      if (isQual) attrQualified += 1;
      if (isClosed) attrClosed += 1;
      if (isNeg) attrNegative += 1;
      attrRevenue += rev;
      if (hasCapi) attrCapiSent += 1;
    }

    if (adId) {
      addLeadToBucket(
        getOrCreateBucket(byAdMap, adId),
        stageKey,
        isQual,
        isClosed,
        isNeg,
        rev,
        hasCapi,
        saleId,
        saleName,
        saleAvatar
      );
    }
    if (adsetId) {
      addLeadToBucket(
        getOrCreateBucket(byAdsetMap, adsetId),
        stageKey,
        isQual,
        isClosed,
        isNeg,
        rev,
        hasCapi,
        saleId,
        saleName,
        saleAvatar
      );
    }
    if (campaignId) {
      addLeadToBucket(
        getOrCreateBucket(byCampaignMap, campaignId),
        stageKey,
        isQual,
        isClosed,
        isNeg,
        rev,
        hasCapi,
        saleId,
        saleName,
        saleAvatar
      );
    }
    if (campaignName) {
      const normCampKey = campaignName.normalize('NFC').toLowerCase();
      addLeadToBucket(
        getOrCreateBucket(byCampaignNameMap, normCampKey),
        stageKey,
        isQual,
        isClosed,
        isNeg,
        rev,
        hasCapi,
        saleId,
        saleName,
        saleAvatar
      );
    }

    enrichedLeads.push({
      raw: r,
      adId,
      adName,
      adsetId,
      campaignId,
      campaignName,
      saleId,
      saleName,
      saleAvatar,
      roundName,
      stageKey,
      isQual,
      isClosed,
      isNeg,
      rev,
      capiLastEvent: capiInfo?.lastEvent || null,
      capiLastStatus: capiInfo?.lastStatus || null,
    });
  }

  const byAd: Record<string, DomMetaCrmEntityBucket> = {};
  for (const [k, b] of byAdMap.entries()) byAd[k] = finalizeBucket(b);

  const byAdset: Record<string, DomMetaCrmEntityBucket> = {};
  for (const [k, b] of byAdsetMap.entries()) byAdset[k] = finalizeBucket(b);

  const byCampaign: Record<string, DomMetaCrmEntityBucket> = {};
  for (const [k, b] of byCampaignMap.entries()) byCampaign[k] = finalizeBucket(b);

  const byCampaignName: Record<string, DomMetaCrmEntityBucket> = {};
  for (const [k, b] of byCampaignNameMap.entries()) byCampaignName[k] = finalizeBucket(b);

  const pipelineTotals = buildEmptyPipeline();
  for (const item of enrichedLeads) {
    if (item.adId || item.adsetId || item.campaignId || item.campaignName) {
      pipelineTotals[item.stageKey] = (pipelineTotals[item.stageKey] || 0) + 1;
    }
  }

  const summary = {
    total_leads: rawRows.length,
    attributed_leads: attributedLeads,
    qualified_leads: attrQualified,
    closed_leads: attrClosed,
    negative_leads: attrNegative,
    total_revenue_vnd: attrRevenue,
    capi_sent_count: attrCapiSent,
    pipeline_totals: pipelineTotals,
  };

  const entityType = String(input.entity_type || '').trim().toLowerCase();
  const entityId = String(input.entity_id || '').trim();
  const entityNameLow = String(input.entity_name || '')
    .normalize('NFC')
    .trim()
    .toLowerCase();
  const searchLow = String(input.search || '')
    .normalize('NFC')
    .trim()
    .toLowerCase();
  let entityLeads: {
    items: DomMetaCrmEntityLeadItem[];
    total: number;
    page: number;
    page_size: number;
    sales_filter_options: Array<{ user_id: string; name: string; avatar: string | null; count: number }>;
  } | undefined;

  if (
    entityType === 'all' ||
    (entityId && (entityType === 'ad' || entityType === 'adset' || entityType === 'campaign'))
  ) {
    const matchedForEntity = enrichedLeads.filter((item) => {
      if (entityType === 'all') {
        if (input.only_attributed === false) return true;
        return Boolean(item.adId || item.adsetId || item.campaignId || item.campaignName);
      }
      if (entityType === 'ad') return item.adId === entityId;
      if (entityType === 'adset') return item.adsetId === entityId;
      if (item.campaignId === entityId) return true;
      const itemCampLow = item.campaignName.normalize('NFC').toLowerCase();
      if (entityNameLow && !item.campaignId && itemCampLow === entityNameLow) return true;
      if (!item.campaignId && itemCampLow === entityId.normalize('NFC').toLowerCase()) return true;
      return false;
    });

    const salesOptionMap = new Map<
      string,
      { user_id: string; name: string; avatar: string | null; count: number }
    >();
    for (const m of matchedForEntity) {
      const key = m.saleId || 'unassigned';
      const cur = salesOptionMap.get(key) || {
        user_id: key,
        name: m.saleId ? m.saleName : 'Chưa phân bổ',
        avatar: m.saleAvatar,
        count: 0,
      };
      cur.count += 1;
      salesOptionMap.set(key, cur);
    }

    const filterSaleId = String(input.sale_id || '').trim();
    const filterQuality = String(input.quality_status || '').trim().toLowerCase();

    const filtered = matchedForEntity.filter((item) => {
      if (filterSaleId && filterSaleId !== 'all') {
        if (filterSaleId === 'unassigned') {
          if (item.saleId) return false;
        } else if (item.saleId !== filterSaleId) {
          return false;
        }
      }
      if (filterQuality && filterQuality !== 'all') {
        if (filterQuality === 'qualified' || filterQuality === 'positive') {
          if (!item.isQual) return false;
        } else if (filterQuality === 'closed' || filterQuality === 'won') {
          if (!item.isClosed && item.stageKey !== 'Deposited') return false;
        } else if (filterQuality === 'negative') {
          if (!item.isNeg) return false;
        } else if (filterQuality === 'pending') {
          if (item.isQual || item.isNeg) return false;
        } else if (
          item.stageKey.toLowerCase() !== filterQuality &&
          String(item.raw.quality_status || '').toLowerCase() !== filterQuality
        ) {
          return false;
        }
      }
      if (searchLow) {
        const hay = [
          item.raw.name || '',
          item.raw.phone || '',
          item.raw.email || '',
          item.saleName || '',
          item.roundName || '',
          item.adName || '',
          item.adId || '',
          item.campaignName || '',
          item.campaignId || '',
          item.raw.id || '',
        ]
          .join(' ')
          .normalize('NFC')
          .toLowerCase();
        if (!hay.includes(searchLow)) return false;
      }
      return true;
    });

    const page = Math.max(1, Math.round(Number(input.page || 1)));
    const pageSize = Math.min(200, Math.max(1, Math.round(Number(input.page_size || 50))));
    const startIdx = (page - 1) * pageSize;
    const pagedSlice = filtered.slice(startIdx, startIdx + pageSize);
    const hideNotes = shouldHideInternalNotesForActor(ctx, cfg);

    const items: DomMetaCrmEntityLeadItem[] = pagedSlice.map((item) => {
      const r = item.raw;
      const shouldMask = shouldMaskPiiForActor(ctx, cfg, {
        is_accepted: Boolean(r.is_accepted),
      });
      const safePhone = shouldMask ? maskPhoneString(r.phone || '', cfg) : r.phone || '';
      const safeEmail =
        shouldMask && cfg.pii_mask_email && r.email
          ? maskEmailString(r.email, cfg) || ''
          : r.email || '';
      const safeQualityNote = hideNotes
        ? null
        : shouldMask && r.quality_note
          ? maskPiiInText(r.quality_note, cfg)
          : r.quality_note || null;

      return {
        id: r.id,
        name: r.name || 'Khách hàng',
        phone: safePhone,
        email: safeEmail,
        pii_masked: shouldMask,
        created_at: formatDateTimeVnSql(r.created_at),
        assigned_to: item.saleId,
        assigned_to_name: item.saleName,
        assigned_to_avatar: item.saleAvatar,
        round_name: item.roundName,
        quality_status: item.stageKey === 'unrated' ? r.quality_status || 'Pending' : item.stageKey,
        stage_key: item.stageKey,
        quality_note: safeQualityNote,
        total_revenue_vnd: item.rev,
        ad_id: item.adId,
        ad_name: item.adName,
        adset_id: item.adsetId,
        campaign_id: item.campaignId,
        campaign_name: item.campaignName,
        source: r.source || 'Meta Ads',
        capi_last_event: item.capiLastEvent,
        capi_last_status: item.capiLastStatus,
      };
    });

    entityLeads = {
      items,
      total: filtered.length,
      page,
      page_size: pageSize,
      sales_filter_options: Array.from(salesOptionMap.values()).sort((a, b) => b.count - a.count),
    };
  }

  return {
    summary,
    by_ad: byAd,
    by_adset: byAdset,
    by_campaign: byCampaign,
    by_campaign_name: byCampaignName,
    ...(entityLeads ? { entity_leads: entityLeads } : {}),
  };
}

export interface DomMetaShareMemberDto {
  id: string;
  email: string;
  full_name: string;
  avatar_url?: string | null;
  role: 'tenant_admin' | 'viewer' | 'manager' | 'sale' | string;
  is_tenant_owner: boolean;
  added_at: string;
}

export async function getDomMetaShareConfig(client: DbClient, tenantId: string) {
  const [domVault, tRes, uRes] = await Promise.all([
    readDomMetaVault(client, tenantId),
    client.query<{ slug: string; name: string; settings: Record<string, unknown> | null }>(
      `SELECT slug, name, settings FROM tenants WHERE id = $1 LIMIT 1`,
      [tenantId]
    ),
    client.query<{
      id: string;
      email: string;
      full_name: string | null;
      avatar_url: string | null;
      role: string;
      is_tenant_owner: boolean;
      created_at: string | Date;
    }>(
      `SELECT u.id, u.email, u.full_name,
              COALESCE(NULLIF(u.avatar_url, ''), ga.avatar_url) AS avatar_url,
              u.role, u.is_tenant_owner, u.created_at
       FROM users u
       LEFT JOIN global_accounts ga ON LOWER(ga.email) = LOWER(u.email)
       LEFT JOIN tenant_user_profiles p ON p.tenant_id = u.tenant_id AND p.user_id = u.id
       WHERE u.tenant_id = $1
         AND COALESCE(u.is_system_bot, false) = false
         AND COALESCE(p.status, 'active') = 'active'
         AND LOWER(u.role) <> 'revoked'
       ORDER BY u.is_tenant_owner DESC, u.created_at ASC`,
      [tenantId]
    ),
  ]);

  const tenantRow = tRes.rows[0];
  const publicView = Boolean(
    domVault.public_view === true ||
      (tenantRow?.settings &&
        typeof tenantRow.settings === 'object' &&
        (tenantRow.settings as Record<string, unknown>).dom_meta_public_view === true)
  );

  const members: DomMetaShareMemberDto[] = uRes.rows.map((r) => ({
    id: r.id,
    email: r.email,
    full_name: String(r.full_name || r.email.split('@')[0] || 'Thành viên'),
    avatar_url: r.avatar_url ? String(r.avatar_url) : null,
    role: String(r.role || 'viewer').toLowerCase(),
    is_tenant_owner: Boolean(r.is_tenant_owner),
    added_at:
      r.created_at instanceof Date ? r.created_at.toISOString() : String(r.created_at || new Date().toISOString()),
  }));

  return {
    public_view: publicView,
    slug: tenantRow?.slug || '',
    tenant_name: tenantRow?.name || '',
    members,
  };
}

function normalizeShareRole(rawRole: unknown): 'viewer' | 'tenant_admin' {
  const s = String(rawRole || '').trim().toLowerCase();
  if (s === 'tenant_admin' || s === 'admin' || s === 'editor') return 'tenant_admin';
  return 'viewer';
}

export async function saveDomMetaShareConfig(
  client: DbClient,
  tenantId: string,
  input: {
    public_view?: boolean;
    invite?: { email: string; role?: string; full_name?: string };
    update_member?: { user_id?: string; email?: string; role: string };
    remove_user_id?: string;
    remove_email?: string;
  }
) {
  if (input.public_view !== undefined) {
    const nextPublic = Boolean(input.public_view === true);
    const current = await readDomMetaVault(client, tenantId);
    current.public_view = nextPublic;
    await writeDomMetaVault(client, tenantId, current);
    await syncTenantPublicViewFlag(client, tenantId, nextPublic);
  }

  if (input.invite && input.invite.email) {
    const cleanEmail = String(input.invite.email).trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(cleanEmail)) {
      return {
        success: false as const,
        message: 'Email không hợp lệ. Vui lòng nhập đúng định dạng email (ví dụ ten@gmail.com).',
      };
    }
    const targetRole = normalizeShareRole(input.invite.role);
    const emailLocal = cleanEmail.split('@')[0] || 'Thành viên';
    const fallbackName = String(input.invite.full_name || emailLocal).trim();

    let gaId: string | null = null;
    let gaAvatar: string | null = null;
    let gaFullName: string | null = null;
    const gaRes = await client.query<{ id: string; full_name: string | null; avatar_url: string | null }>(
      `SELECT id, full_name, avatar_url FROM global_accounts WHERE LOWER(email) = $1 LIMIT 1`,
      [cleanEmail]
    );
    if (gaRes.rows[0]?.id) {
      gaId = gaRes.rows[0].id;
      gaAvatar = gaRes.rows[0].avatar_url || null;
      gaFullName = gaRes.rows[0].full_name || null;
    } else {
      const randomPassHash = await hashPassword(crypto.randomBytes(24).toString('hex'));
      const newGaRes = await client.query<{ id: string }>(
        `INSERT INTO global_accounts (email, password_hash, full_name, is_active, last_login_at)
         VALUES ($1, $2, $3, true, clock_timestamp())
         RETURNING id`,
        [cleanEmail, randomPassHash, fallbackName]
      );
      gaId = newGaRes.rows[0]?.id || null;
    }

    const preferredFullName = input.invite.full_name
      ? fallbackName
      : gaFullName && gaFullName.trim()
        ? gaFullName.trim()
        : fallbackName;

    const existingUserRes = await client.query<{
      id: string;
      role: string;
      is_tenant_owner: boolean;
      full_name: string | null;
    }>(
      `SELECT id, role, is_tenant_owner, full_name
       FROM users
       WHERE tenant_id = $1 AND LOWER(email) = $2
       LIMIT 1`,
      [tenantId, cleanEmail]
    );

    if (existingUserRes.rows[0]) {
      const existing = existingUserRes.rows[0];
      if (!existing.is_tenant_owner) {
        await client.query(
          `UPDATE users
           SET role = $3,
               account_id = COALESCE(account_id, $4),
               full_name = COALESCE(NULLIF($5, ''), full_name),
               avatar_url = CASE WHEN $6 <> '' THEN $6 ELSE avatar_url END,
               updated_at = clock_timestamp()
           WHERE tenant_id = $1 AND id = $2`,
          [
            tenantId,
            existing.id,
            targetRole,
            gaId,
            input.invite.full_name ? fallbackName : gaFullName || '',
            gaAvatar || '',
          ]
        );
        await client.query(
          `UPDATE tenant_user_profiles
           SET status = 'active'
           WHERE tenant_id = $1 AND user_id = $2`,
          [tenantId, existing.id]
        );
        await tenantRedis.unblacklistUser(tenantId, existing.id);
        tenantRedis.invalidateUserAuth(tenantId, existing.id);
        tenantRedis.invalidateEffectivePermissions(tenantId, existing.id);
      }
    } else {
      const randomUserPassHash = await hashPassword(crypto.randomBytes(24).toString('hex'));
      const insRes = await client.query<{ id: string }>(
        `INSERT INTO users (
           account_id, tenant_id, email, password_hash, full_name, avatar_url, role, is_tenant_owner, is_external_agency
         )
         VALUES ($1, $2, $3, $4, $5, $6, $7, false, false)
         RETURNING id`,
        [gaId, tenantId, cleanEmail, randomUserPassHash, preferredFullName, gaAvatar, targetRole]
      );
      const newUserId = insRes.rows[0].id;
      await client.query(
        `INSERT INTO tenant_user_profiles (tenant_id, user_id, status, is_available, vacation_mode)
         VALUES ($1, $2, 'active', false, false)`,
        [tenantId, newUserId]
      );
      tenantRedis.invalidateEffectivePermissions(tenantId, newUserId);
    }
  }

  if (input.update_member && (input.update_member.user_id || input.update_member.email)) {
    const targetRole = normalizeShareRole(input.update_member.role);
    const byId = String(input.update_member.user_id || '').trim();
    const byEmail = String(input.update_member.email || '').trim().toLowerCase();
    const uLookup = await client.query<{ id: string; is_tenant_owner: boolean }>(
      byId
        ? `SELECT id, is_tenant_owner FROM users WHERE tenant_id = $1 AND id = $2 LIMIT 1`
        : `SELECT id, is_tenant_owner FROM users WHERE tenant_id = $1 AND LOWER(email) = $2 LIMIT 1`,
      [tenantId, byId || byEmail]
    );
    const found = uLookup.rows[0];
    if (found && !found.is_tenant_owner) {
      await client.query(
        `UPDATE users SET role = $3, updated_at = clock_timestamp() WHERE tenant_id = $1 AND id = $2`,
        [tenantId, found.id, targetRole]
      );
      tenantRedis.invalidateUserAuth(tenantId, found.id);
      tenantRedis.invalidateEffectivePermissions(tenantId, found.id);
    }
  }

  if (input.remove_user_id || input.remove_email) {
    const rmId = String(input.remove_user_id || '').trim();
    const rmEmail = String(input.remove_email || '').trim().toLowerCase();
    const uLookup = await client.query<{ id: string; is_tenant_owner: boolean }>(
      rmId
        ? `SELECT id, is_tenant_owner FROM users WHERE tenant_id = $1 AND id = $2 LIMIT 1`
        : `SELECT id, is_tenant_owner FROM users WHERE tenant_id = $1 AND LOWER(email) = $2 LIMIT 1`,
      [tenantId, rmId || rmEmail]
    );
    const target = uLookup.rows[0];
    if (target) {
      if (target.is_tenant_owner) {
        return {
          success: false as const,
          message: 'Không thể xóa chủ sở hữu workspace khỏi quyền truy cập.',
        };
      }
      await tenantRedis.blacklistUser(tenantId, target.id, 'removed_from_dom_meta_share');
      await client.query(`SAVEPOINT sp_dom_meta_rm_user`);
      try {
        await client.query(`DELETE FROM tenant_user_profiles WHERE tenant_id = $1 AND user_id = $2`, [
          tenantId,
          target.id,
        ]);
        await client.query(
          `DELETE FROM users WHERE tenant_id = $1 AND id = $2 AND is_tenant_owner = false`,
          [tenantId, target.id]
        );
        await client.query(`RELEASE SAVEPOINT sp_dom_meta_rm_user`);
      } catch {
        await client.query(`ROLLBACK TO SAVEPOINT sp_dom_meta_rm_user`);
        await client.query(`RELEASE SAVEPOINT sp_dom_meta_rm_user`);
        await client.query(
          `UPDATE users SET account_id = NULL, role = 'revoked', updated_at = clock_timestamp()
           WHERE tenant_id = $1 AND id = $2 AND is_tenant_owner = false`,
          [tenantId, target.id]
        );
        await client.query(
          `UPDATE tenant_user_profiles SET status = 'inactive', is_available = false
           WHERE tenant_id = $1 AND user_id = $2`,
          [tenantId, target.id]
        );
      }
      tenantRedis.invalidateUserAuth(tenantId, target.id);
      tenantRedis.invalidateEffectivePermissions(tenantId, target.id);
    }
  }

  const data = await getDomMetaShareConfig(client, tenantId);
  return {
    success: true as const,
    data,
    message: 'Đã cập nhật cài đặt chia sẻ & phân quyền thành công.',
  };
}

export async function resolvePublicDomMetaViewerAccess(rawSlug: string) {
  const cleanSlug = String(rawSlug || '').trim().toLowerCase();
  if (!cleanSlug) {
    return { success: false as const, code: 'SLUG_REQUIRED', status: 400, message: 'Thiếu mã workspace.' };
  }

  return withSystemPrivilege(async (client) => {
    const tRes = await client.query<{
      id: string;
      slug: string;
      name: string;
      status: string;
      plan_tier: string;
      package_code: string | null;
      settings: Record<string, unknown> | null;
    }>(
      `SELECT id, slug, name, status, plan_tier, package_code, settings
       FROM tenants
       WHERE LOWER(slug) = $1 OR LOWER(COALESCE(obfuscated_slug, '')) = $1
       LIMIT 1`,
      [cleanSlug]
    );
    const tenant = tRes.rows[0];
    if (!tenant || tenant.status === 'suspended' || tenant.status === 'cancelled') {
      return {
        success: false as const,
        code: 'WORKSPACE_NOT_FOUND',
        status: 404,
        message: 'Không tìm thấy workspace báo cáo này.',
      };
    }

    const domVault = await readDomMetaVault(client, tenant.id);
    const settingsPublic = Boolean(
      tenant.settings &&
        typeof tenant.settings === 'object' &&
        (tenant.settings as Record<string, unknown>).dom_meta_public_view === true
    );
    const isPublic = Boolean(domVault.public_view === true || settingsPublic);
    if (!isPublic) {
      return {
        success: false as const,
        code: 'PUBLIC_VIEW_DISABLED',
        status: 403,
        message: 'Workspace này yêu cầu đăng nhập để xem báo cáo.',
      };
    }

    if (!settingsPublic) {
      await syncTenantPublicViewFlag(client, tenant.id, true);
    }

    const accessToken = signTenantAccessToken(
      {
        sub: PUBLIC_DOM_META_VIEWER_USER_ID,
        tenantId: tenant.id,
        tenantSlug: tenant.slug,
        email: 'public-viewer@domation.net',
        name: `${tenant.name} (Viewer)`,
        role: 'viewer',
        isExternalAgency: false,
        planTier: (tenant.plan_tier || 'growth_combo') as PlanTier,
      },
      12 * 3600
    );

    return {
      success: true as const,
      status: 200,
      data: {
        public_view: true,
        access_token: accessToken,
        primary_ad_account_id: domVault.primary_ad_account_id || '',
        tenant: {
          id: tenant.id,
          name: tenant.name,
          slug: tenant.slug,
          status: tenant.status,
          plan_tier: tenant.plan_tier,
          package_code: tenant.package_code || 'growth_combo',
        },
        user: {
          id: PUBLIC_DOM_META_VIEWER_USER_ID,
          email: 'public-viewer@domation.net',
          full_name: 'Public Viewer',
          role: 'viewer',
          is_public_viewer: true,
        },
      },
    };
  });
}

function escapeServerHtml(raw: string): string {
  return String(raw || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function markdownToCleanReportHtml(md: string): { html: string; plainText: string } {
  const cleanedMd = String(md || '')
    .replace(/\r\n/g, '\n')
    .replace(/^```(?:markdown|md|html|text)?\s*\n?/i, '')
    .replace(/\n?```\s*$/i, '');
  const lines = cleanedMd.split('\n');
  const htmlParts: string[] = [];
  const plainLines: string[] = [];
  let listTag: 'ul' | 'ol' | null = null;
  let tableRows: string[][] = [];

  const formatInline = (text: string) =>
    escapeServerHtml(text)
      .replace(/`([^`]+)`/g, '<code>$1</code>')
      .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
      .replace(/(^|[^*])\*([^*]+)\*(?!\*)/g, '$1<em>$2</em>');

  const stripMdInline = (text: string) =>
    text.replace(/`([^`]+)`/g, '$1').replace(/\*\*(.+?)\*\*/g, '$1').replace(/(^|[^*])\*([^*]+)\*(?!\*)/g, '$1$2');

  const closeList = () => {
    if (listTag) {
      htmlParts.push(`</${listTag}>`);
      listTag = null;
    }
  };

  const flushTable = () => {
    if (tableRows.length === 0) return;
    if (tableRows.length === 1) {
      htmlParts.push(`<p>${formatInline(tableRows[0].join(' · '))}</p>`);
      tableRows = [];
      return;
    }
    const header = tableRows[0];
    const body = tableRows.slice(1);
    const ths = header.map((c) => `<th>${formatInline(c)}</th>`).join('');
    const trs = body
      .map((row) => `<tr>${header.map((_, idx) => `<td>${formatInline(row[idx] ?? '')}</td>`).join('')}</tr>`)
      .join('');
    htmlParts.push(`<table><thead><tr>${ths}</tr></thead><tbody>${trs}</tbody></table>`);
    tableRows = [];
  };

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (/^```/.test(line)) {
      continue;
    }
    if (!line) {
      closeList();
      flushTable();
      continue;
    }

    // Markdown pipe table row
    if (line.startsWith('|') && line.endsWith('|') && line.length > 2) {
      closeList();
      const cells = line
        .slice(1, -1)
        .split('|')
        .map((c) => c.trim());
      const isSeparator = cells.every((c) => /^:?-{2,}:?$/.test(c));
      if (!isSeparator && cells.some(Boolean)) {
        tableRows.push(cells);
        plainLines.push(cells.map(stripMdInline).join(' | '));
      }
      continue;
    }
    flushTable();

    // Horizontal rule
    if (/^(?:---|\*\*\*|___)\s*$/.test(line)) {
      closeList();
      htmlParts.push('<hr/>');
      continue;
    }

    const headingMatch = line.match(/^#{1,6}\s+(.+)$/);
    if (headingMatch) {
      closeList();
      const title = stripMdInline(headingMatch[1]).trim();
      htmlParts.push(`<h2>${escapeServerHtml(title)}</h2>`);
      plainLines.push(`\n${title.toUpperCase()}`);
      continue;
    }

    const bulletMatch = line.match(/^[-*•]\s+(.+)$/);
    if (bulletMatch) {
      if (listTag !== 'ul') {
        closeList();
        htmlParts.push('<ul>');
        listTag = 'ul';
      }
      const itemText = bulletMatch[1].trim();
      htmlParts.push(`<li>${formatInline(itemText)}</li>`);
      plainLines.push(`- ${stripMdInline(itemText)}`);
      continue;
    }

    const orderedMatch = line.match(/^(\d+)\.\s+(.+)$/);
    if (orderedMatch) {
      if (listTag !== 'ol') {
        closeList();
        htmlParts.push('<ol>');
        listTag = 'ol';
      }
      const itemText = orderedMatch[2].trim();
      htmlParts.push(`<li>${formatInline(itemText)}</li>`);
      plainLines.push(`${orderedMatch[1]}. ${stripMdInline(itemText)}`);
      continue;
    }

    closeList();
    htmlParts.push(`<p>${formatInline(line)}</p>`);
    plainLines.push(stripMdInline(line));
  }
  closeList();
  flushTable();

  return {
    html: htmlParts.join('\n'),
    plainText: plainLines.join('\n').trim(),
  };
}

export async function executeSharedGeminiAnalysis(
  apiKey: string,
  preferredModel: string,
  scope: 'workspace' | 'compare' | 'entity' | 'lead',
  contextData: Record<string, any>,
  promptFocus?: string
) {
  const cleanRequested = String(preferredModel || '').trim();
  const primaryModel =
    !cleanRequested || cleanRequested === 'gemini-3.5-flash-lite'
      ? 'gemini-2.5-flash'
      : cleanRequested;
  const candidateModels =
    primaryModel === 'gemini-2.5-flash'
      ? ['gemini-2.5-flash', 'gemini-2.0-flash']
      : [primaryModel, 'gemini-2.5-flash'];

  const compactJson = JSON.stringify(contextData || {}).slice(0, 28_000);
  const systemRole =
    scope === 'lead'
      ? 'Bạn là Chuyên gia AI Đánh giá & Phân loại Chất lượng Lead CRM thực chiến tại Việt Nam.'
      : 'Bạn là Giám đốc Tối ưu Hiệu suất Quảng cáo Meta & Đa kênh (Performance Marketing Director) thực chiến tại Việt Nam.';

  const taskInstruction =
    scope === 'lead'
      ? 'Hãy đánh giá mức độ tiềm năng của Lead, phân tích tín hiệu số điện thoại/nhu cầu/chiến dịch nguồn, chấm điểm chất lượng (0-100), phân loại (Qualified / Cần xác minh / Rủi ro rác) và gợi ý kịch bản tiếp cận ngắn gọn cho Sale.'
      : scope === 'entity'
        ? 'Hãy phân tích chuyên sâu đối tượng quảng cáo này theo dữ liệu Meta API cung cấp: hiệu quả chi tiêu vs kết quả (CPR), chất lượng phễu Click → Landing Page → Tin nhắn/Lead, giữ chân Video (Hook/Hold/Avg Watch Time), khung giờ vàng, độ tuổi/giới tính, tỉnh thành, nền tảng/thiết bị, tần suất lặp và đề xuất 3 hành động tối ưu cụ thể ngay lập tức.'
        : scope === 'compare'
          ? 'Hãy đối chiếu trực diện các chiến dịch được chọn theo Spent, Result, CPR, CTR, Hook/Hold Rate, ROAS/CRM Lead, chỉ rõ chiến dịch thắng cuộc và đề xuất tỷ lệ phân bổ lại ngân sách cụ thể.'
          : 'Hãy lập báo cáo chẩn đoán tổng thể tài khoản quảng cáo: tổng quan ngân sách & tăng trưởng, sức khỏe phễu chuyển đổi & Creative Video, nền tảng/thiết bị/địa lý/khung giờ hiệu quả nhất, cảnh báo đốt tiền hoặc lặp tệp (Frequency), và kế hoạch hành động tối ưu ngân sách.';

  const fullPrompt = [
    systemRole,
    taskInstruction,
    promptFocus ? `Trọng tâm bổ sung từ người dùng: ${String(promptFocus).slice(0, 600)}` : '',
    'Trình bày bằng tiếng Việt chuyên nghiệp, súc tích, có các tiêu đề mục rõ ràng dùng Markdown `## 1. ...`, gạch đầu dòng `- ...`, in đậm `**con số quan trọng**`. Không dùng khối mã ```html.',
    `Dữ liệu thực tế (JSON):\n${compactJson}`,
  ]
    .filter(Boolean)
    .join('\n\n');

  if (customExternalFetcher) {
    const testUrl = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(primaryModel)}:generateContent`;
    const r = await performExternalGet(testUrl);
    if (!r.ok) {
      return {
        success: false as const,
        status: r.status >= 400 ? r.status : 502,
        code: 'GEMINI_UPSTREAM_ERROR',
        message: r.data?.error?.message || `Gemini API phản hồi lỗi HTTP ${r.status}.`,
      };
    }
    const rawText =
      r.data?.candidates?.[0]?.content?.parts?.[0]?.text ||
      '## 1. Kết quả phân tích AI\n- Đã đánh giá dữ liệu thành công.';
    const converted = markdownToCleanReportHtml(String(rawText));
    return {
      success: true as const,
      status: 200,
      data: {
        scope,
        model: primaryModel,
        html: converted.html,
        plain_text: converted.plainText,
        preview: converted.plainText.replace(/\s+/g, ' ').slice(0, 220),
        timestamp: new Date().toLocaleString('vi-VN'),
      },
    };
  }

  let lastErrMsg = 'Không thể kết nối Google Gemini API.';
  let lastStatus = 502;

  for (const modelName of candidateModels) {
    const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(modelName)}:generateContent`;
    const resp = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-goog-api-key': apiKey,
      },
      body: JSON.stringify({
        contents: [{ role: 'user', parts: [{ text: fullPrompt }] }],
        generationConfig: {
          temperature: 0.3,
          maxOutputTokens: 2048,
        },
      }),
      signal: AbortSignal.timeout(28_000),
    });

    const json = (await resp.json().catch(() => ({}))) as Record<string, any>;
    if (resp.ok && json?.candidates?.[0]?.content?.parts) {
      const textOut = json.candidates[0].content.parts
        .map((p: any) => String(p?.text || ''))
        .join('\n')
        .trim();
      if (textOut) {
        const converted = markdownToCleanReportHtml(textOut);
        return {
          success: true as const,
          status: 200,
          data: {
            scope,
            model: modelName,
            html: converted.html,
            plain_text: converted.plainText,
            preview: converted.plainText.replace(/\s+/g, ' ').slice(0, 220),
            timestamp: new Date().toLocaleString('vi-VN'),
          },
        };
      }
    }

    lastStatus = resp.status || 502;
    lastErrMsg =
      json?.error?.message ||
      `Google Gemini API phản hồi lỗi HTTP ${resp.status} cho mô hình ${modelName}.`;
    if (resp.status !== 404) {
      break;
    }
  }

  return {
    success: false as const,
    status: lastStatus === 400 || lastStatus === 403 ? 422 : lastStatus,
    code: 'GEMINI_UPSTREAM_ERROR',
    message: lastErrMsg,
  };
}
