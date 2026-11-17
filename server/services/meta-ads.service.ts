import crypto from 'node:crypto';
import type { DbClient } from '../core/database/db-adapter.ts';
import { decryptTenantSecret, encryptTenantSecret } from '../core/crypto/vault.ts';
import { tenantRedis } from '../core/cache/tenant-redis.ts';
import { getTenantSettingsCached } from '../core/settings/tenant-cache.ts';
import { formatDateTimeVnSql } from '../routes/legacy/legacy-helpers.ts';

export interface MetaAdAccountRecord {
  id: string;
  name: string;
  ad_account_id: string;
  access_token: string;
  pixel_id?: string;
  is_active: boolean;
  last_sync?: string | null;
  synced_ads_count?: number;
  last_error?: string | null;
  created_at: string;
  updated_at: string;
}

export interface MetaAdAccountPublicDto {
  id: string;
  name: string;
  ad_account_id: string;
  has_token: boolean;
  access_token_masked: string;
  pixel_id: string;
  is_active: boolean;
  last_sync: string | null;
  synced_ads_count: number;
  last_error: string | null;
  created_at: string;
  updated_at: string;
}

export interface DiscoveredMetaPixel {
  id: string;
  name: string;
  last_fired_time?: string | null;
  source_account_id?: string;
  source_account_name?: string;
}

export interface DiscoveredMetaAdAccount {
  id: string;
  ad_account_id: string;
  name: string;
  account_status: number;
  status_label: string;
  currency: string;
  business_name?: string | null;
  pixels: DiscoveredMetaPixel[];
}

interface MetaAdsVaultStore {
  version: 2;
  primary_account_id?: string;
  accounts: MetaAdAccountRecord[];
}

export type MetaGraphFetcherFn = (url: string) => Promise<{
  ok: boolean;
  status: number;
  json: () => Promise<any>;
}>;

let customMetaGraphFetcher: MetaGraphFetcherFn | null = null;

export function setMetaGraphFetcherForTesting(fn: MetaGraphFetcherFn | null): void {
  customMetaGraphFetcher = fn;
}

export function normalizeAdAccountId(raw: unknown): string {
  const cleaned = String(raw || '')
    .trim()
    .replace(/^act_/i, '')
    .replace(/\s+/g, '');
  const digits = cleaned.replace(/[^0-9]/g, '');
  return digits;
}

export function maskMetaToken(token: string | undefined | null): string {
  const clean = String(token || '').trim();
  if (!clean) return '';
  if (clean.length <= 12) return `${clean.slice(0, 3)}***${clean.slice(-2)}`;
  return `${clean.slice(0, 8)}...${clean.slice(-4)}`;
}

function isTokenUnchangedSentinel(rawToken: unknown, existingToken?: string): boolean {
  const trimmed = String(rawToken || '').trim();
  if (!trimmed || trimmed === '__KEEP_EXISTING__') return true;
  if (existingToken && trimmed === maskMetaToken(existingToken)) return true;
  return false;
}

function toPublicAccountDto(acc: MetaAdAccountRecord): MetaAdAccountPublicDto {
  return {
    id: acc.id,
    name: acc.name || `TK #${acc.ad_account_id}`,
    ad_account_id: acc.ad_account_id,
    has_token: Boolean(acc.access_token && acc.access_token.trim().length > 0),
    access_token_masked: maskMetaToken(acc.access_token),
    pixel_id: acc.pixel_id || '',
    is_active: acc.is_active !== false,
    last_sync: acc.last_sync || null,
    synced_ads_count: Number(acc.synced_ads_count || 0),
    last_error: acc.last_error || null,
    created_at: acc.created_at,
    updated_at: acc.updated_at,
  };
}

async function readVaultStore(client: DbClient, tenantId: string): Promise<MetaAdsVaultStore> {
  const res = await client.query<{
    config_encrypted: string;
    iv: string;
    auth_tag: string;
    last_synced_at: string | null;
  }>(
    `SELECT config_encrypted, iv, auth_tag, last_synced_at
     FROM tenant_integrations
     WHERE tenant_id = $1 AND integration_type = 'facebook_ads'
     LIMIT 1`,
    [tenantId]
  );

  const row = res.rows[0];
  if (!row) {
    return { version: 2, accounts: [] };
  }

  try {
    const raw = decryptTenantSecret<any>(tenantId, row.config_encrypted, row.iv, row.auth_tag);
    if (raw && Array.isArray(raw.accounts)) {
      const normalized: MetaAdAccountRecord[] = raw.accounts
        .filter((item: any) => item && normalizeAdAccountId(item.ad_account_id))
        .map((item: any) => ({
          id: String(item.id || `meta_${crypto.randomUUID().slice(0, 8)}`),
          name: String(item.name || '').trim() || `TK #${normalizeAdAccountId(item.ad_account_id)}`,
          ad_account_id: normalizeAdAccountId(item.ad_account_id),
          access_token: String(item.access_token || '').trim(),
          pixel_id: String(item.pixel_id || '').trim(),
          is_active: item.is_active !== false,
          last_sync: item.last_sync || null,
          synced_ads_count: Number(item.synced_ads_count || 0),
          last_error: item.last_error || null,
          created_at: String(item.created_at || new Date().toISOString()),
          updated_at: String(item.updated_at || new Date().toISOString()),
        }));
      return {
        version: 2,
        primary_account_id: raw.primary_account_id || normalized[0]?.id,
        accounts: normalized,
      };
    }

    // Legacy single-account format upgrade
    const legacyId = normalizeAdAccountId(raw?.ad_account_id);
    const legacyToken = String(raw?.access_token || raw?.fb_access_token || '').trim();
    if (legacyId || legacyToken) {
      const nowIso = new Date().toISOString();
      const acc: MetaAdAccountRecord = {
        id: `meta_${crypto.randomUUID().slice(0, 8)}`,
        name: String(raw?.name || '').trim() || (legacyId ? `TK Quảng Cáo #${legacyId.slice(-6)}` : 'TK Meta Mặc Định'),
        ad_account_id: legacyId,
        access_token: legacyToken,
        pixel_id: String(raw?.pixel_id || raw?.capi_pixel_id || '').trim(),
        is_active: true,
        last_sync: row.last_synced_at ? formatDateTimeVnSql(row.last_synced_at) : null,
        synced_ads_count: 0,
        last_error: null,
        created_at: nowIso,
        updated_at: nowIso,
      };
      return {
        version: 2,
        primary_account_id: acc.id,
        accounts: [acc],
      };
    }
  } catch {
    // Corrupted/old key vault row returns clean empty store
  }
  return { version: 2, accounts: [] };
}

async function writeVaultStore(client: DbClient, tenantId: string, store: MetaAdsVaultStore): Promise<void> {
  const payload: MetaAdsVaultStore = {
    version: 2,
    primary_account_id: store.primary_account_id || store.accounts[0]?.id,
    accounts: store.accounts,
  };
  const enc = encryptTenantSecret(tenantId, payload as unknown as Record<string, unknown>);
  await client.query(
    `INSERT INTO tenant_integrations (tenant_id, integration_type, config_encrypted, iv, auth_tag, status)
     VALUES ($1, 'facebook_ads', $2, $3, $4, 'active')
     ON CONFLICT (tenant_id, integration_type)
     DO UPDATE SET config_encrypted = EXCLUDED.config_encrypted,
                   iv = EXCLUDED.iv,
                   auth_tag = EXCLUDED.auth_tag,
                   status = 'active',
                   updated_at = clock_timestamp()`,
    [tenantId, enc.configEncrypted, enc.iv, enc.authTag]
  );
  tenantRedis.invalidateTenantIntegrations(tenantId);
}

export async function getMetaAdsConfigSummary(client: DbClient, tenantId: string) {
  const [store, adsCountRes] = await Promise.all([
    readVaultStore(client, tenantId),
    client.query<{ cnt: number }>(
      'SELECT COUNT(DISTINCT ad_id)::int AS cnt FROM meta_ads_insights WHERE tenant_id = $1',
      [tenantId]
    ),
  ]);

  const publicAccounts = store.accounts.map(toPublicAccountDto);
  const primary =
    publicAccounts.find((a) => a.id === store.primary_account_id) ||
    publicAccounts.find((a) => a.is_active) ||
    publicAccounts[0] ||
    null;

  const syncedAdsTotal = Number(adsCountRes.rows[0]?.cnt || 0);
  const lastSync =
    primary?.last_sync ||
    publicAccounts.map((a) => a.last_sync).filter(Boolean)[0] ||
    null;

  return {
    ad_account_id: primary?.ad_account_id || '',
    pixel_id: primary?.pixel_id || '',
    has_token: publicAccounts.some((a) => a.has_token),
    access_token_masked: primary?.access_token_masked || '',
    last_sync: lastSync,
    cached_ads_count: syncedAdsTotal,
    total_accounts: publicAccounts.length,
    active_accounts: publicAccounts.filter((a) => a.is_active).length,
    accounts: publicAccounts,
  };
}

export async function upsertMetaAdAccount(
  client: DbClient,
  tenantId: string,
  input: {
    id?: string;
    name?: string;
    ad_account_id: string;
    access_token?: string;
    pixel_id?: string;
    is_active?: boolean;
    requireNew?: boolean;
  }
) {
  const normalizedAdAccountId = normalizeAdAccountId(input.ad_account_id);
  if (!normalizedAdAccountId || normalizedAdAccountId.length < 5) {
    return {
      success: false as const,
      message: 'Ad Account ID không hợp lệ (cần dãy số từ 5 chữ số trở lên, có hoặc không có tiền tố act_).',
    };
  }

  const store = await readVaultStore(client, tenantId);
  const targetId = input.id ? String(input.id).trim() : '';
  const existingIdx = targetId
    ? store.accounts.findIndex((a) => a.id === targetId)
    : input.requireNew
      ? -1
      : store.accounts.findIndex((a) => a.ad_account_id === normalizedAdAccountId);

  const duplicateByAdAccount = store.accounts.find(
    (a, idx) => a.ad_account_id === normalizedAdAccountId && idx !== existingIdx
  );
  if (duplicateByAdAccount) {
    return {
      success: false as const,
      message: `Ad Account act_${normalizedAdAccountId} đã tồn tại dưới tên "${duplicateByAdAccount.name}". Hãy bấm Sửa tài khoản đó thay vì tạo trùng.`,
    };
  }

  const nowIso = new Date().toISOString();
  if (existingIdx >= 0) {
    const existing = store.accounts[existingIdx];
    const nextToken = isTokenUnchangedSentinel(input.access_token, existing.access_token)
      ? existing.access_token
      : String(input.access_token || '').trim();
    if (!nextToken) {
      return {
        success: false as const,
        message: 'Meta Access Token không được để trống.',
      };
    }
    const updated: MetaAdAccountRecord = {
      ...existing,
      name: String(input.name || '').trim() || existing.name || `TK #${normalizedAdAccountId}`,
      ad_account_id: normalizedAdAccountId,
      access_token: nextToken,
      pixel_id: input.pixel_id !== undefined ? String(input.pixel_id || '').trim() : existing.pixel_id,
      is_active: input.is_active !== undefined ? Boolean(input.is_active) : existing.is_active,
      last_error: null,
      updated_at: nowIso,
    };
    store.accounts[existingIdx] = updated;
    await writeVaultStore(client, tenantId, store);
    return {
      success: true as const,
      mode: 'updated' as const,
      account: toPublicAccountDto(updated),
      summary: await getMetaAdsConfigSummary(client, tenantId),
      message: `Đã cập nhật tài khoản "${updated.name}" (act_${updated.ad_account_id}).`,
    };
  }

  const rawToken = String(input.access_token || '').trim();
  if (!rawToken || rawToken === '__KEEP_EXISTING__') {
    return {
      success: false as const,
      message: 'Vui lòng nhập Meta Access Token cho tài khoản mới.',
    };
  }

  const created: MetaAdAccountRecord = {
    id: `meta_${crypto.randomUUID().slice(0, 8)}`,
    name: String(input.name || '').trim() || `TK #${normalizedAdAccountId.slice(-6)}`,
    ad_account_id: normalizedAdAccountId,
    access_token: rawToken,
    pixel_id: String(input.pixel_id || '').trim(),
    is_active: input.is_active !== undefined ? Boolean(input.is_active) : true,
    last_sync: null,
    synced_ads_count: 0,
    last_error: null,
    created_at: nowIso,
    updated_at: nowIso,
  };
  store.accounts.push(created);
  if (!store.primary_account_id) {
    store.primary_account_id = created.id;
  }
  await writeVaultStore(client, tenantId, store);
  return {
    success: true as const,
    mode: 'created' as const,
    account: toPublicAccountDto(created),
    summary: await getMetaAdsConfigSummary(client, tenantId),
    message: `Đã thêm tài khoản "${created.name}" (act_${created.ad_account_id}).`,
  };
}

export async function deleteMetaAdAccount(
  client: DbClient,
  tenantId: string,
  accountRef: string,
  purgeInsights = false
) {
  const store = await readVaultStore(client, tenantId);
  const cleanRef = String(accountRef || '').trim();
  const normalizedRef = normalizeAdAccountId(cleanRef);
  const target = store.accounts.find(
    (a) => a.id === cleanRef || (normalizedRef && a.ad_account_id === normalizedRef)
  );
  if (!target) {
    return {
      success: false as const,
      message: 'Không tìm thấy tài khoản Meta Ads cần xóa.',
    };
  }

  store.accounts = store.accounts.filter((a) => a.id !== target.id);
  if (store.primary_account_id === target.id) {
    store.primary_account_id = store.accounts[0]?.id;
  }
  await writeVaultStore(client, tenantId, store);

  let purgedRows = 0;
  if (purgeInsights && target.ad_account_id) {
    const delRes = await client.query(
      'DELETE FROM meta_ads_insights WHERE tenant_id = $1 AND ad_account_id = $2',
      [tenantId, target.ad_account_id]
    );
    purgedRows = delRes.rowCount || 0;
  }

  return {
    success: true as const,
    deleted_account_id: target.id,
    deleted_ad_account_id: target.ad_account_id,
    purged_ads_count: purgedRows,
    summary: await getMetaAdsConfigSummary(client, tenantId),
    message: purgeInsights
      ? `Đã xóa tài khoản act_${target.ad_account_id} và ${purgedRows} bản ghi QC liên quan.`
      : `Đã xóa kết nối tài khoản act_${target.ad_account_id} (giữ lại lịch sử số liệu QC).`,
  };
}

export async function toggleMetaAdAccountStatus(
  client: DbClient,
  tenantId: string,
  accountRef: string,
  isActive: boolean
) {
  const store = await readVaultStore(client, tenantId);
  const cleanRef = String(accountRef || '').trim();
  const normalizedRef = normalizeAdAccountId(cleanRef);
  const idx = store.accounts.findIndex(
    (a) => a.id === cleanRef || (normalizedRef && a.ad_account_id === normalizedRef)
  );
  if (idx < 0) {
    return { success: false as const, message: 'Không tìm thấy tài khoản Meta Ads.' };
  }
  store.accounts[idx] = {
    ...store.accounts[idx],
    is_active: Boolean(isActive),
    updated_at: new Date().toISOString(),
  };
  await writeVaultStore(client, tenantId, store);
  return {
    success: true as const,
    account: toPublicAccountDto(store.accounts[idx]),
    summary: await getMetaAdsConfigSummary(client, tenantId),
    message: isActive
      ? `Đã bật đồng bộ cho act_${store.accounts[idx].ad_account_id}.`
      : `Đã tạm ngưng đồng bộ act_${store.accounts[idx].ad_account_id}.`,
  };
}

function extractMetaLeadsCount(actions: any): number {
  if (!Array.isArray(actions)) return 0;
  const leadActionTypes = new Set([
    'lead',
    'onsite_conversion.lead_grouped',
    'offsite_conversion.fb_pixel_lead',
    'leadgen_grouped',
  ]);
  let maxCnt = 0;
  for (const act of actions) {
    const t = String(act?.action_type || '').toLowerCase();
    if (leadActionTypes.has(t)) {
      const val = Number(act?.value || 0);
      if (val > maxCnt) maxCnt = val;
    }
  }
  return Math.round(maxCnt);
}

function shouldUseMockSafeSync(customFetcher?: MetaGraphFetcherFn): boolean {
  if (customFetcher) return false;
  return (
    process.env.OUTBOUND_SILENT_MODE === 'true' ||
    process.env.NODE_ENV === 'test' ||
    process.env.VITEST === 'true'
  );
}

export async function syncMetaAdsAccounts(
  client: DbClient,
  tenantId: string,
  options?: {
    accountRef?: string;
    graphFetcher?: MetaGraphFetcherFn;
  }
) {
  const store = await readVaultStore(client, tenantId);
  if (store.accounts.length === 0) {
    return {
      success: false as const,
      synced_ads: 0,
      account_results: [],
      message: 'Chưa cấu hình tài khoản Meta Ads nào. Hãy nhấn "+ Thêm Tài khoản Meta" để kết nối.',
    };
  }

  const targetRef = String(options?.accountRef || '').trim();
  const normalizedTarget = normalizeAdAccountId(targetRef);
  const targetAccounts = targetRef
    ? store.accounts.filter((a) => a.id === targetRef || (normalizedTarget && a.ad_account_id === normalizedTarget))
    : store.accounts.filter((a) => a.is_active !== false);

  if (targetAccounts.length === 0) {
    return {
      success: false as const,
      synced_ads: 0,
      account_results: [],
      message: targetRef
        ? 'Không tìm thấy tài khoản Meta Ads được chọn.'
        : 'Tất cả tài khoản Meta Ads hiện đang tạm ngưng.',
    };
  }

  const effectiveFetcher = options?.graphFetcher || customMetaGraphFetcher;
  const safeMockMode = shouldUseMockSafeSync(effectiveFetcher || undefined);
  if (safeMockMode) {
    const nowLabel = formatDateTimeVnSql(new Date().toISOString());
    const results = targetAccounts.map((acc) => {
      acc.last_sync = nowLabel;
      acc.last_error = null;
      acc.updated_at = new Date().toISOString();
      return {
        id: acc.id,
        name: acc.name,
        ad_account_id: acc.ad_account_id,
        success: true,
        synced_ads: acc.synced_ads_count || 0,
        message: 'Safe silent check OK',
      };
    });
    await writeVaultStore(client, tenantId, store);
    return {
      success: true as const,
      synced_ads: results.reduce((s, r) => s + r.synced_ads, 0),
      account_results: results,
      summary: await getMetaAdsConfigSummary(client, tenantId),
      message: `Đã kiểm tra đồng bộ an toàn cho ${targetAccounts.length} tài khoản (Silent Mode).`,
    };
  }

  const fetcher: MetaGraphFetcherFn =
    effectiveFetcher ||
    (async (url: string) => {
      const resp = await fetch(url, {
        method: 'GET',
        signal: AbortSignal.timeout(20_000),
      });
      return {
        ok: resp.ok,
        status: resp.status,
        json: () => resp.json(),
      };
    });

  const today = new Date().toISOString().slice(0, 10);
  const fields =
    'id,name,status,effective_status,campaign{id,name,objective},adset{id,name,optimization_goal},creative{id,name,title,body,thumbnail_url,image_url,effective_object_story_id},insights.date_preset(maximum){spend,impressions,clicks,reach,ctr,cpc,cpm,frequency,actions,date_start,date_stop}';

  let totalSyncedAds = 0;
  const accountResults: Array<{
    id: string;
    name: string;
    ad_account_id: string;
    success: boolean;
    synced_ads: number;
    error?: string;
  }> = [];

  for (const acc of targetAccounts) {
    if (!acc.access_token || !acc.ad_account_id) {
      acc.last_error = 'Thiếu Ad Account ID hoặc Meta Access Token';
      accountResults.push({
        id: acc.id,
        name: acc.name,
        ad_account_id: acc.ad_account_id,
        success: false,
        synced_ads: 0,
        error: acc.last_error,
      });
      continue;
    }

    let nextUrl: string | null =
      `https://graph.facebook.com/v21.0/act_${encodeURIComponent(acc.ad_account_id)}/ads?fields=${encodeURIComponent(fields)}&limit=100&access_token=${encodeURIComponent(acc.access_token)}`;
    let pages = 0;
    let acctSynced = 0;
    let acctErr: string | null = null;

    while (nextUrl && pages < 5) {
      pages += 1;
      try {
        const res = await fetcher(nextUrl);
        const json = await res.json();
        if (!res.ok || json?.error) {
          acctErr = json?.error?.message || `Meta Graph API HTTP ${res.status}`;
          break;
        }
        const rows = Array.isArray(json?.data) ? json.data : [];
        for (const item of rows) {
          const adId = String(item?.id || '').trim();
          if (!adId) continue;
          const ins = Array.isArray(item?.insights?.data) && item.insights.data[0] ? item.insights.data[0] : {};
          const dateStart = String(ins.date_start || today).slice(0, 10);
          const dateStop = String(ins.date_stop || today).slice(0, 10);
          const campaignId = String(item?.campaign?.id || `cmp_${acc.ad_account_id}`);
          const campaignName = item?.campaign?.name ? String(item.campaign.name) : null;
          const adsetId = item?.adset?.id ? String(item.adset.id) : null;
          const adsetName = item?.adset?.name ? String(item.adset.name) : null;
          const adName = item?.name ? String(item.name) : `Ad ${adId}`;
          const creative = item?.creative || {};
          const optGoal = item?.adset?.optimization_goal || item?.campaign?.objective || 'LEAD_GENERATION';
          const metaLeads = extractMetaLeadsCount(ins.actions);

          await client.query(
            `INSERT INTO meta_ads_insights (
               tenant_id, ad_account_id, date_start, date_stop,
               campaign_id, campaign_name, adset_id, adset_name, ad_id, ad_name,
               spend, impressions, clicks, reach, ctr, cpc, cpm, frequency, meta_leads,
               thumbnail_url, image_url, creative_title, creative_body, story_id, optimization_goal
             ) VALUES (
               $1, $2, $3, $4, $5, $6, $7, $8, $9, $10,
               $11, $12, $13, $14, $15, $16, $17, $18, $19,
               $20, $21, $22, $23, $24, $25
             )
             ON CONFLICT (tenant_id, ad_id, date_start, date_stop)
             DO UPDATE SET
               ad_account_id = COALESCE(EXCLUDED.ad_account_id, meta_ads_insights.ad_account_id),
               campaign_id = EXCLUDED.campaign_id,
               campaign_name = COALESCE(EXCLUDED.campaign_name, meta_ads_insights.campaign_name),
               adset_id = COALESCE(EXCLUDED.adset_id, meta_ads_insights.adset_id),
               adset_name = COALESCE(EXCLUDED.adset_name, meta_ads_insights.adset_name),
               ad_name = COALESCE(EXCLUDED.ad_name, meta_ads_insights.ad_name),
               spend = EXCLUDED.spend,
               impressions = EXCLUDED.impressions,
               clicks = EXCLUDED.clicks,
               reach = EXCLUDED.reach,
               ctr = EXCLUDED.ctr,
               cpc = EXCLUDED.cpc,
               cpm = EXCLUDED.cpm,
               frequency = EXCLUDED.frequency,
               meta_leads = GREATEST(EXCLUDED.meta_leads, meta_ads_insights.meta_leads),
               thumbnail_url = COALESCE(NULLIF(EXCLUDED.thumbnail_url, ''), meta_ads_insights.thumbnail_url),
               image_url = COALESCE(NULLIF(EXCLUDED.image_url, ''), meta_ads_insights.image_url),
               creative_title = COALESCE(NULLIF(EXCLUDED.creative_title, ''), meta_ads_insights.creative_title),
               creative_body = COALESCE(NULLIF(EXCLUDED.creative_body, ''), meta_ads_insights.creative_body),
               story_id = COALESCE(NULLIF(EXCLUDED.story_id, ''), meta_ads_insights.story_id),
               optimization_goal = COALESCE(EXCLUDED.optimization_goal, meta_ads_insights.optimization_goal),
               updated_at = clock_timestamp()`,
            [
              tenantId,
              acc.ad_account_id,
              dateStart,
              dateStop,
              campaignId,
              campaignName,
              adsetId,
              adsetName,
              adId,
              adName,
              Number(ins.spend || 0),
              Math.round(Number(ins.impressions || 0)),
              Math.round(Number(ins.clicks || 0)),
              Math.round(Number(ins.reach || 0)),
              Number(ins.ctr || 0),
              Number(ins.cpc || 0),
              Number(ins.cpm || 0),
              Number(ins.frequency || 0),
              metaLeads,
              creative.thumbnail_url || null,
              creative.image_url || null,
              creative.title || null,
              creative.body || null,
              creative.effective_object_story_id || null,
              String(optGoal),
            ]
          );
          acctSynced += 1;
        }
        nextUrl = typeof json?.paging?.next === 'string' ? json.paging.next : null;
      } catch (err: any) {
        acctErr = err?.message || 'Lỗi kết nối Meta Graph API';
        break;
      }
    }

    const nowLabel = formatDateTimeVnSql(new Date().toISOString());
    if (acctErr) {
      acc.last_error = acctErr;
      acc.updated_at = new Date().toISOString();
      accountResults.push({
        id: acc.id,
        name: acc.name,
        ad_account_id: acc.ad_account_id,
        success: false,
        synced_ads: acctSynced,
        error: acctErr,
      });
    } else {
      acc.last_error = null;
      acc.last_sync = nowLabel;
      acc.synced_ads_count = acctSynced;
      acc.updated_at = new Date().toISOString();
      totalSyncedAds += acctSynced;
      accountResults.push({
        id: acc.id,
        name: acc.name,
        ad_account_id: acc.ad_account_id,
        success: true,
        synced_ads: acctSynced,
      });
    }
  }

  await writeVaultStore(client, tenantId, store);

  const succeededAccounts = accountResults.filter((r) => r.success).length;
  const failedAccounts = accountResults.filter((r) => !r.success);
  const allOk = succeededAccounts > 0 && failedAccounts.length === 0;
  const partialOk = succeededAccounts > 0 && failedAccounts.length > 0;

  return {
    success: succeededAccounts > 0,
    synced_ads: totalSyncedAds,
    account_results: accountResults,
    summary: await getMetaAdsConfigSummary(client, tenantId),
    message: allOk
      ? `Đã đồng bộ ${totalSyncedAds} bài QC từ ${succeededAccounts} tài khoản Meta Ads.`
      : partialOk
        ? `Đã đồng bộ ${totalSyncedAds} bài QC (${succeededAccounts} TK thành công, ${failedAccounts.length} TK lỗi: ${failedAccounts[0]?.error}).`
        : `Đồng bộ Meta Ads thất bại: ${failedAccounts[0]?.error || 'Vui lòng kiểm tra lại Token.'}`,
  };
}

export async function getMetaCapiDashboardConfig(client: DbClient, tenantId: string, cfgFallbackCapiEnabled: boolean) {
  const [capiRowRes, adsSummary, tenantCfg] = await Promise.all([
    client.query<{ config_encrypted: string; iv: string; auth_tag: string }>(
      `SELECT config_encrypted, iv, auth_tag
       FROM tenant_integrations
       WHERE tenant_id = $1 AND integration_type = 'meta_capi'
       LIMIT 1`,
      [tenantId]
    ),
    getMetaAdsConfigSummary(client, tenantId),
    getTenantSettingsCached(tenantId, client),
  ]);

  let capiData: Record<string, any> = {};
  if (capiRowRes.rows[0]) {
    try {
      capiData = decryptTenantSecret<Record<string, any>>(
        tenantId,
        capiRowRes.rows[0].config_encrypted,
        capiRowRes.rows[0].iv,
        capiRowRes.rows[0].auth_tag
      );
    } catch {
      capiData = {};
    }
  }

  const rawToken = String(capiData.capi_access_token || capiData.access_token || '').trim();
  const availablePixels = adsSummary.accounts
    .filter((a) => a.pixel_id)
    .map((a) => ({
      id: a.pixel_id,
      name: `${a.name} (Pixel ${a.pixel_id})`,
      is_crm: false,
    }));

  return {
    config: {
      capi_enabled: capiData.capi_enabled !== undefined ? Boolean(capiData.capi_enabled) : cfgFallbackCapiEnabled,
      capi_pixel_id: String(capiData.capi_pixel_id || capiData.dataset_id || adsSummary.pixel_id || '').trim(),
      capi_only_meta_leads: Boolean(capiData.capi_only_meta_leads),
      has_custom_capi_token: Boolean(rawToken && rawToken !== '__KEEP_EXISTING__'),
      capi_access_token_masked: maskMetaToken(rawToken),
      has_meta_ads_token: adsSummary.has_token,
      capi_closed_value_vnd: Number(
        capiData.capi_closed_value_vnd ?? tenantCfg.default_closed_deal_value_vnd ?? 50000000
      ),
      capi_event_triggers: capiData.capi_event_triggers || {
        Qualified: 'Lead',
        Booked: 'Schedule',
        Booking: 'InitiateCheckout',
        Deposited: 'AddPaymentInfo',
        Closed: 'Purchase',
        Badtiming: 'Skip',
        NoAnswer: 'Skip',
        Notlead: 'DisqualifiedLead',
        Spam: 'DisqualifiedLead',
      },
      capi_custom_events: Array.isArray(capiData.capi_custom_events) ? capiData.capi_custom_events : [],
    },
    available_pixels: availablePixels,
  };
}

function formatMetaAccountStatus(statusCode: number): string {
  switch (statusCode) {
    case 1:
      return 'Đang hoạt động';
    case 2:
      return 'Vô hiệu hóa';
    case 3:
      return 'Nợ thanh toán';
    case 7:
      return 'Chờ duyệt';
    case 9:
      return 'Gia hạn';
    case 100:
      return 'Sắp đóng';
    case 101:
      return 'Đã đóng';
    default:
      return statusCode ? `Trạng thái ${statusCode}` : 'Không rõ';
  }
}

export async function discoverMetaTokenAssets(
  client: DbClient,
  tenantId: string,
  input: {
    access_token?: string;
    account_id?: string;
    ad_account_id?: string;
    graphFetcher?: MetaGraphFetcherFn;
  }
) {
  let token = String(input.access_token || '').trim();
  if (!token || token === '__KEEP_EXISTING__' || token.includes('...')) {
    const store = await readVaultStore(client, tenantId);
    const refId = String(input.account_id || '').trim();
    const normAcc = normalizeAdAccountId(input.ad_account_id);
    const matched = store.accounts.find(
      (a) => (refId && a.id === refId) || (normAcc && a.ad_account_id === normAcc)
    );
    if (matched?.access_token && (!token || token === '__KEEP_EXISTING__' || token === maskMetaToken(matched.access_token))) {
      token = matched.access_token;
    }
  }

  if (!token || token === '__KEEP_EXISTING__') {
    return {
      success: false as const,
      message: 'Vui lòng dán Meta Access Token hợp lệ để tải danh sách Tài khoản QC và Pixel.',
      ad_accounts: [] as DiscoveredMetaAdAccount[],
      pixels: [] as DiscoveredMetaPixel[],
    };
  }

  const effectiveFetcher = input.graphFetcher || customMetaGraphFetcher;
  if (shouldUseMockSafeSync(effectiveFetcher || undefined)) {
    return {
      success: true as const,
      token_owner: { id: 'silent', name: 'Silent Mode' },
      ad_accounts: [] as DiscoveredMetaAdAccount[],
      pixels: [] as DiscoveredMetaPixel[],
      message: 'Đang chạy chế độ Silent Mode nên bỏ qua gọi Meta Graph API.',
    };
  }

  const fetcher: MetaGraphFetcherFn =
    effectiveFetcher ||
    (async (url: string) => {
      const resp = await fetch(url, {
        method: 'GET',
        signal: AbortSignal.timeout(15_000),
      });
      return {
        ok: resp.ok,
        status: resp.status,
        json: () => resp.json(),
      };
    });

  const meUrl = `https://graph.facebook.com/v21.0/me?fields=id,name&access_token=${encodeURIComponent(token)}`;
  const accountsUrl =
    `https://graph.facebook.com/v21.0/me/adaccounts?fields=${encodeURIComponent('id,account_id,name,account_status,currency,business{id,name},adspixels{id,name,last_fired_time}')}&limit=100&access_token=${encodeURIComponent(token)}`;

  const [meRes, firstAccRes] = await Promise.all([
    fetcher(meUrl).catch(() => null),
    fetcher(accountsUrl),
  ]);

  let tokenOwner: { id: string; name: string } | null = null;
  if (meRes?.ok) {
    try {
      const meJson = await meRes.json();
      if (meJson?.id) {
        tokenOwner = { id: String(meJson.id), name: String(meJson.name || 'Meta User') };
      }
    } catch {
      // ignore non-critical profile lookup
    }
  }

  const firstAccJson = await firstAccRes.json();
  const discoveredAccounts: DiscoveredMetaAdAccount[] = [];
  const pixelMap = new Map<string, DiscoveredMetaPixel>();

  const registerPixel = (raw: any, srcAccountId?: string, srcAccountName?: string): DiscoveredMetaPixel | null => {
    const pid = String(raw?.id || '').trim();
    if (!pid) return null;
    const item: DiscoveredMetaPixel = {
      id: pid,
      name: String(raw?.name || `Pixel ${pid}`),
      last_fired_time: raw?.last_fired_time ? String(raw.last_fired_time) : null,
      source_account_id: srcAccountId,
      source_account_name: srcAccountName,
    };
    if (!pixelMap.has(pid)) {
      pixelMap.set(pid, item);
    }
    return item;
  };

  if (!firstAccRes.ok || firstAccJson?.error) {
    const normSpecific = normalizeAdAccountId(input.ad_account_id);
    if (normSpecific) {
      const singleUrl = `https://graph.facebook.com/v21.0/act_${encodeURIComponent(normSpecific)}?fields=${encodeURIComponent('id,account_id,name,account_status,currency,adspixels{id,name,last_fired_time}')}&access_token=${encodeURIComponent(token)}`;
      const singleRes = await fetcher(singleUrl).catch(() => null);
      const singleJson = singleRes ? await singleRes.json().catch(() => null) : null;
      if (singleRes?.ok && singleJson && !singleJson.error) {
        const cleanId = normalizeAdAccountId(singleJson.account_id || singleJson.id || normSpecific);
        const accName = String(singleJson.name || `act_${cleanId}`);
        const accPixelsRaw = Array.isArray(singleJson?.adspixels?.data) ? singleJson.adspixels.data : [];
        const accPixels = accPixelsRaw
          .map((px: any) => registerPixel(px, cleanId, accName))
          .filter(Boolean) as DiscoveredMetaPixel[];
        discoveredAccounts.push({
          id: String(singleJson.id || `act_${cleanId}`),
          ad_account_id: cleanId,
          name: accName,
          account_status: Number(singleJson.account_status || 1),
          status_label: formatMetaAccountStatus(Number(singleJson.account_status || 1)),
          currency: String(singleJson.currency || 'VND'),
          business_name: singleJson?.business?.name || null,
          pixels: accPixels,
        });
      } else {
        return {
          success: false as const,
          message: firstAccJson?.error?.message || `Meta Graph API trả về lỗi HTTP ${firstAccRes.status}`,
          ad_accounts: [] as DiscoveredMetaAdAccount[],
          pixels: [] as DiscoveredMetaPixel[],
        };
      }
    } else {
      return {
        success: false as const,
        message: firstAccJson?.error?.message || `Meta Graph API từ chối truy cập (HTTP ${firstAccRes.status}). Hãy kiểm tra quyền ads_read hoặc hạn Token.`,
        ad_accounts: [] as DiscoveredMetaAdAccount[],
        pixels: [] as DiscoveredMetaPixel[],
      };
    }
  } else {
    let pageJson: any = firstAccJson;
    let pageCount = 0;
    while (pageJson && pageCount < 3) {
      pageCount += 1;
      const rows = Array.isArray(pageJson?.data) ? pageJson.data : [];
      for (const row of rows) {
        const digits = normalizeAdAccountId(row?.account_id || row?.id);
        if (!digits) continue;
        const accName = String(row?.name || `TK #${digits}`);
        const rawPx = Array.isArray(row?.adspixels?.data) ? row.adspixels.data : [];
        const accPixels = rawPx
          .map((px: any) => registerPixel(px, digits, accName))
          .filter(Boolean) as DiscoveredMetaPixel[];
        const statusNum = Number(row?.account_status || 0);
        discoveredAccounts.push({
          id: String(row?.id || `act_${digits}`),
          ad_account_id: digits,
          name: accName,
          account_status: statusNum,
          status_label: formatMetaAccountStatus(statusNum),
          currency: String(row?.currency || 'VND'),
          business_name: row?.business?.name ? String(row.business.name) : null,
          pixels: accPixels,
        });
      }
      const nextUrl = typeof pageJson?.paging?.next === 'string' ? pageJson.paging.next : null;
      if (!nextUrl || pageCount >= 3) break;
      const nextRes = await fetcher(nextUrl).catch(() => null);
      if (!nextRes?.ok) break;
      pageJson = await nextRes.json().catch(() => null);
    }

    // If a specific Ad Account is highlighted or has no nested pixels yet, also inspect act_{id}/adspixels directly
    const selectedNorm = normalizeAdAccountId(input.ad_account_id) || discoveredAccounts[0]?.ad_account_id || '';
    if (selectedNorm) {
      const targetAcc = discoveredAccounts.find((a) => a.ad_account_id === selectedNorm);
      if (targetAcc && targetAcc.pixels.length === 0) {
        const pxRes = await fetcher(
          `https://graph.facebook.com/v21.0/act_${encodeURIComponent(selectedNorm)}/adspixels?fields=id,name,last_fired_time&limit=100&access_token=${encodeURIComponent(token)}`
        ).catch(() => null);
        if (pxRes?.ok) {
          const pxJson = await pxRes.json().catch(() => null);
          const extraPx = Array.isArray(pxJson?.data) ? pxJson.data : [];
          for (const px of extraPx) {
            const added = registerPixel(px, selectedNorm, targetAcc.name);
            if (added && !targetAcc.pixels.some((p) => p.id === added.id)) {
              targetAcc.pixels.push(added);
            }
          }
        }
      }
    }

    // Best-effort Business Manager pixels lookup (ignored cleanly if token lacks business_management)
    if (pixelMap.size === 0) {
      const bizRes = await fetcher(
        `https://graph.facebook.com/v21.0/me/businesses?fields=${encodeURIComponent('id,name,owned_pixels{id,name,last_fired_time},client_pixels{id,name,last_fired_time}')}&limit=25&access_token=${encodeURIComponent(token)}`
      ).catch(() => null);
      if (bizRes?.ok) {
        const bizJson = await bizRes.json().catch(() => null);
        const businesses = Array.isArray(bizJson?.data) ? bizJson.data : [];
        for (const biz of businesses) {
          const owned = Array.isArray(biz?.owned_pixels?.data) ? biz.owned_pixels.data : [];
          const clientPx = Array.isArray(biz?.client_pixels?.data) ? biz.client_pixels.data : [];
          for (const px of [...owned, ...clientPx]) {
            registerPixel(px, undefined, biz?.name ? `BM: ${biz.name}` : 'Business Manager');
          }
        }
      }
    }
  }

  discoveredAccounts.sort((a, b) => {
    const aActive = a.account_status === 1 ? 0 : 1;
    const bActive = b.account_status === 1 ? 0 : 1;
    if (aActive !== bActive) return aActive - bActive;
    return a.name.localeCompare(b.name, 'vi');
  });

  const allPixels = Array.from(pixelMap.values());
  return {
    success: true as const,
    token_owner: tokenOwner,
    ad_accounts: discoveredAccounts,
    pixels: allPixels,
    message:
      discoveredAccounts.length > 0
        ? `Token hợp lệ${tokenOwner ? ` (${tokenOwner.name})` : ''}: Tìm thấy ${discoveredAccounts.length} Tài khoản QC và ${allPixels.length} Pixel.`
        : 'Token hợp lệ nhưng chưa có Tài khoản QC nào được gán quyền cho Token này.',
  };
}
