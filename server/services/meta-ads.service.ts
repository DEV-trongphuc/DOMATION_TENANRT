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

export interface MetaOverviewDateWindow {
  since: string;
  until: string;
  prevSince: string;
  prevUntil: string;
  isAllTime: boolean;
}

function toVnIsoDate(d: Date): string {
  const vnMs = d.getTime() + 7 * 3600_000;
  return new Date(vnMs).toISOString().slice(0, 10);
}

function addDaysIso(isoDate: string, deltaDays: number): string {
  const dt = new Date(`${isoDate}T00:00:00Z`);
  dt.setUTCDate(dt.getUTCDate() + deltaDays);
  return dt.toISOString().slice(0, 10);
}

export function resolveOverviewDateWindow(
  dateRangeRaw?: string,
  fromDateRaw?: string,
  toDateRaw?: string
): MetaOverviewDateWindow {
  const today = toVnIsoDate(new Date());
  const range = String(dateRangeRaw || '30days').trim().toLowerCase();

  let since = addDaysIso(today, -29);
  let until = today;
  let isAllTime = false;

  if (range === 'custom' && fromDateRaw && toDateRaw) {
    since = String(fromDateRaw).slice(0, 10);
    until = String(toDateRaw).slice(0, 10);
  } else if (range === 'today') {
    since = today;
    until = today;
  } else if (range === 'yesterday') {
    const y = addDaysIso(today, -1);
    since = y;
    until = y;
  } else if (range === '7days' || range === 'last_7d' || range === 'last_7_days') {
    since = addDaysIso(today, -6);
    until = today;
  } else if (range === '30days' || range === 'last_30d' || range === 'last_30_days') {
    since = addDaysIso(today, -29);
    until = today;
  } else if (range === 'this_week') {
    const dt = new Date(`${today}T00:00:00Z`);
    const day = dt.getUTCDay();
    const diffMon = day === 0 ? -6 : 1 - day;
    since = addDaysIso(today, diffMon);
    until = today;
  } else if (range === 'last_week') {
    const dt = new Date(`${today}T00:00:00Z`);
    const day = dt.getUTCDay();
    const diffMon = day === 0 ? -6 : 1 - day;
    const thisMon = addDaysIso(today, diffMon);
    since = addDaysIso(thisMon, -7);
    until = addDaysIso(thisMon, -1);
  } else if (range === 'two_weeks_ago') {
    const dt = new Date(`${today}T00:00:00Z`);
    const day = dt.getUTCDay();
    const diffMon = day === 0 ? -6 : 1 - day;
    const thisMon = addDaysIso(today, diffMon);
    since = addDaysIso(thisMon, -14);
    until = addDaysIso(thisMon, -8);
  } else if (range === 'this_month') {
    since = `${today.slice(0, 7)}-01`;
    until = today;
  } else if (range === 'last_month') {
    const dt = new Date(`${today.slice(0, 7)}-01T00:00:00Z`);
    dt.setUTCMonth(dt.getUTCMonth() - 1);
    since = dt.toISOString().slice(0, 10);
    const endDt = new Date(`${today.slice(0, 7)}-01T00:00:00Z`);
    endDt.setUTCDate(endDt.getUTCDate() - 1);
    until = endDt.toISOString().slice(0, 10);
  } else if (range === 'this_quarter') {
    const m = Number(today.slice(5, 7)) - 1;
    const qStartMonth = String(Math.floor(m / 3) * 3 + 1).padStart(2, '0');
    since = `${today.slice(0, 4)}-${qStartMonth}-01`;
    until = today;
  } else if (range === 'this_year') {
    since = `${today.slice(0, 4)}-01-01`;
    until = today;
  } else if (range === 'all_time' || range === 'all') {
    since = '2020-01-01';
    until = today;
    isAllTime = true;
  } else if (fromDateRaw && toDateRaw) {
    since = String(fromDateRaw).slice(0, 10);
    until = String(toDateRaw).slice(0, 10);
  }

  const startMs = new Date(`${since}T00:00:00Z`).getTime();
  const endMs = new Date(`${until}T00:00:00Z`).getTime();
  const spanDays = Math.max(1, Math.round((endMs - startMs) / 86_400_000) + 1);
  const prevUntil = addDaysIso(since, -1);
  const prevSince = addDaysIso(prevUntil, -(spanDays - 1));

  return { since, until, prevSince, prevUntil, isAllTime };
}

async function safeMetaSavepointQuery(client: DbClient, sql: string, params: unknown[]): Promise<any[]> {
  const sp = `sp_meta_${crypto.randomUUID().replace(/-/g, '').slice(0, 12)}`;
  try {
    await client.query(`SAVEPOINT ${sp}`);
    const res = await client.query(sql, params);
    await client.query(`RELEASE SAVEPOINT ${sp}`);
    return res.rows || [];
  } catch {
    try {
      await client.query(`ROLLBACK TO SAVEPOINT ${sp}`);
    } catch {
      // ignore
    }
    return [];
  }
}

export async function buildMetaAdsOverviewInTx(
  client: DbClient,
  tenantId: string,
  filters: {
    ad_account_id?: string;
    date_range?: string;
    from_date?: string;
    to_date?: string;
    campaign_id?: string;
    owner_id?: string;
  },
  maskRow?: (row: Record<string, any>) => Record<string, any>
) {
  const metaSummary = await getMetaAdsConfigSummary(client, tenantId);
  const accounts = metaSummary.accounts || [];
  const win = resolveOverviewDateWindow(filters.date_range, filters.from_date, filters.to_date);

  if (accounts.length === 0) {
    return {
      configured: false,
      accounts: [],
      summary: {
        account_id: '',
        account_name: 'Chưa kết nối tài khoản Meta',
        since: win.since,
        until: win.until,
        spend: 0,
        attributed_spend: 0,
        account_total_spend: 0,
        prev_spend: 0,
        spend_change_pct: 0,
        lead_goal_spend: 0,
        meta_leads: 0,
        account_meta_leads: 0,
        prev_meta_leads: 0,
        leads_change_pct: 0,
        meta_cpl: 0,
        account_meta_cpl: 0,
        cpl: 0,
        crm_cpl: 0,
        cost_per_new_1_2: 0,
        cpq: 0,
        cpq_3_12: 0,
        cpw: 0,
        impressions: 0,
        prev_impressions: 0,
        impressions_change_pct: 0,
        reach: 0,
        prev_reach: 0,
        reach_change_pct: 0,
        frequency: 0,
        cpm: 0,
        clicks: 0,
        cpc: 0,
        ctr: 0,
        total_leads: 0,
        entry_stage_leads: 0,
        qualified_stage_leads: 0,
        won_stage_leads: 0,
        lost_stage_leads: 0,
        nurture_stage_leads: 0,
        new_1_2_leads: 0,
        new_1_2_pct: 0,
        qualified_3_12_leads: 0,
        qualified_3_12_pct: 0,
        won_leads: 0,
        won_pct: 0,
        qualified_leads: 0,
        qualified_pct: 0,
        uncontacted_leads: 0,
        contacted_leads: 0,
        contacted_pct: 0,
        assigned_leads: 0,
        assigned_pct: 0,
        paid_leads: 0,
        organic_leads: 0,
        instant_form_leads: 0,
        actual_revenue: 0,
        roas: 0,
        campaigns_count: 0,
        active_campaigns_count: 0,
        adsets_count: 0,
        active_adsets_count: 0,
        ads_count: 0,
        active_ads_count: 0,
        forms_count: 0,
        valid_phone_pct: 0,
        survey_completed_pct: 0,
      },
      stage_breakdown: [],
      daily_trend: [],
      campaigns: [],
      by_campaign: [],
      adsets: [],
      by_adset: [],
      ads: [],
      by_ad: [],
      hierarchy: [],
      meta_goal_chart: [],
      funnel_stages: [],
      pipeline_stages_catalog: [],
      top_advisors: [],
      attributed_leads: [],
    };
  }

  const rawAcctParam = String(filters.ad_account_id || '').trim();
  const matchedByRef =
    rawAcctParam && rawAcctParam.toLowerCase() !== 'all'
      ? accounts.find(
          (a) =>
            a.id === rawAcctParam ||
            a.ad_account_id === normalizeAdAccountId(rawAcctParam)
        )
      : null;
  const selectedAdAccountId =
    rawAcctParam && rawAcctParam.toLowerCase() !== 'all'
      ? matchedByRef?.ad_account_id || normalizeAdAccountId(rawAcctParam)
      : '';

  const displayAccountId = selectedAdAccountId
    ? selectedAdAccountId
    : accounts.length === 1
      ? accounts[0].ad_account_id
      : 'all';
  const displayAccountName = selectedAdAccountId
    ? matchedByRef?.name || `act_${selectedAdAccountId}`
    : accounts.length === 1
      ? accounts[0].name
      : `Tất cả (${accounts.length} tài khoản Meta)`;

  const campaignFilter =
    filters.campaign_id && filters.campaign_id !== 'all' ? String(filters.campaign_id).trim() : '';
  const ownerFilter =
    filters.owner_id && filters.owner_id !== 'all' ? String(filters.owner_id).trim() : '';

  const insParams: unknown[] = [tenantId];
  let insWhere = 'tenant_id = $1';
  if (selectedAdAccountId) {
    insParams.push(selectedAdAccountId);
    insWhere += ` AND ad_account_id = $${insParams.length}`;
  }
  if (!win.isAllTime) {
    insParams.push(win.since, win.until);
    insWhere += ` AND date_stop >= $${insParams.length - 1}::date AND date_start <= $${insParams.length}::date`;
  }
  if (campaignFilter) {
    insParams.push(campaignFilter);
    insWhere += ` AND campaign_id = $${insParams.length}`;
  }

  const prevParams: unknown[] = [tenantId, win.prevSince, win.prevUntil];
  let prevWhere = 'tenant_id = $1 AND date_stop >= $2::date AND date_start <= $3::date';
  if (selectedAdAccountId) {
    prevParams.push(selectedAdAccountId);
    prevWhere += ` AND ad_account_id = $${prevParams.length}`;
  }
  if (campaignFilter) {
    prevParams.push(campaignFilter);
    prevWhere += ` AND campaign_id = $${prevParams.length}`;
  }

  const [insRes, prevRes, stagesRes] = await Promise.all([
    client.query(
      `SELECT ad_account_id, date_start, date_stop, campaign_id, campaign_name,
              adset_id, adset_name, ad_id, ad_name,
              spend, impressions, clicks, reach, ctr, cpc, cpm, frequency, meta_leads,
              thumbnail_url, image_url, creative_title, creative_body, story_id, optimization_goal
       FROM meta_ads_insights
       WHERE ${insWhere}
       ORDER BY date_start ASC, spend DESC`,
      insParams
    ),
    win.isAllTime
      ? Promise.resolve({ rows: [{ spend: 0, impressions: 0, reach: 0, meta_leads: 0 }] })
      : client.query(
          `SELECT COALESCE(SUM(spend), 0)::numeric AS spend,
                  COALESCE(SUM(impressions), 0)::int AS impressions,
                  COALESCE(SUM(reach), 0)::int AS reach,
                  COALESCE(SUM(meta_leads), 0)::int AS meta_leads
           FROM meta_ads_insights
           WHERE ${prevWhere}`,
          prevParams
        ),
    client.query<{
      id: string;
      pipeline_id: string;
      stage_key: string;
      stage_name: string;
      stage_order: number;
      color_hex: string;
      is_won_stage: boolean;
      is_lost_stage: boolean;
      funnel_category: string;
    }>(
      `SELECT id, pipeline_id, stage_key, stage_name, stage_order, color_hex,
              is_won_stage, is_lost_stage, funnel_category
       FROM tenant_pipeline_stages
       WHERE tenant_id = $1
       ORDER BY stage_order ASC, created_at ASC`,
      [tenantId]
    ),
  ]);

  const insightRows = insRes.rows;
  const acctAdIds = Array.from(new Set(insightRows.map((r) => String(r.ad_id || '')).filter(Boolean)));
  const acctCampaignIds = Array.from(new Set(insightRows.map((r) => String(r.campaign_id || '')).filter(Boolean)));

  const leadParams: unknown[] = [tenantId];
  let leadWhere = 'l.tenant_id = $1 AND l.is_deleted = false';
  if (!win.isAllTime) {
    leadParams.push(win.since, win.until);
    leadWhere += ` AND l.created_at::date BETWEEN $${leadParams.length - 1}::date AND $${leadParams.length}::date`;
  }
  if (campaignFilter) {
    leadParams.push(campaignFilter);
    leadWhere += ` AND l.campaign_id = $${leadParams.length}`;
  }
  if (ownerFilter) {
    leadParams.push(ownerFilter);
    leadWhere += ` AND l.assigned_to::text = $${leadParams.length}`;
  }
  if (selectedAdAccountId) {
    if (acctAdIds.length === 0 && acctCampaignIds.length === 0) {
      leadWhere += ' AND 1 = 0';
    } else {
      const orParts: string[] = [];
      if (acctAdIds.length > 0) {
        leadParams.push(acctAdIds);
        orParts.push(`l.ad_id = ANY($${leadParams.length}::text[])`);
      }
      if (acctCampaignIds.length > 0) {
        leadParams.push(acctCampaignIds);
        orParts.push(`l.campaign_id = ANY($${leadParams.length}::text[])`);
      }
      leadWhere += ` AND (${orParts.join(' OR ')})`;
    }
  }

  const leadsRes = await client.query(
    `SELECT l.id, l.name, l.phone, l.email, l.source, l.campaign, l.campaign_id, l.adset_id, l.ad_id, l.form_id,
            l.stage_id, l.assigned_to, l.is_accepted, l.quality_status, l.lead_score, l.total_revenue_vnd, l.created_at,
            u.full_name AS owner_name, u.avatar_url AS owner_avatar
     FROM leads l
     LEFT JOIN users u ON u.tenant_id = l.tenant_id AND u.id = l.assigned_to
     WHERE ${leadWhere}
     ORDER BY l.created_at DESC
     LIMIT 5000`,
    leadParams
  );

  const leadRows = leadsRes.rows;
  const leadIds = leadRows.map((l) => String(l.id));

  // Optional Deals + Sales Orders revenue attribution (only adds when lead.total_revenue_vnd === 0 to avoid double-counting)
  const dealRevByLead = new Map<string, number>();
  const soRevByLead = new Map<string, number>();
  if (leadIds.length > 0) {
    const [dealRows, soRows] = await Promise.all([
      safeMetaSavepointQuery(
        client,
        `SELECT lead_id, COALESCE(SUM(amount_vnd), 0)::bigint AS rev
         FROM tenant_deals
         WHERE tenant_id = $1 AND stage = 'won' AND lead_id = ANY($2::uuid[])
         GROUP BY lead_id`,
        [tenantId, leadIds]
      ),
      safeMetaSavepointQuery(
        client,
        `SELECT lead_id, COALESCE(SUM(paid_vnd), 0)::bigint AS rev
         FROM tenant_sales_orders
         WHERE tenant_id = $1 AND status <> 'cancelled' AND paid_vnd > 0 AND lead_id = ANY($2::uuid[])
         GROUP BY lead_id`,
        [tenantId, leadIds]
      ),
    ]);
    for (const r of dealRows) {
      if (r.lead_id) dealRevByLead.set(String(r.lead_id), Number(r.rev || 0));
    }
    for (const r of soRows) {
      if (r.lead_id) soRevByLead.set(String(r.lead_id), Number(r.rev || 0));
    }
  }

  // Classify stages dynamically from tenant_pipeline_stages
  const stageMetaMap = new Map<
    string,
    {
      stage_id: string;
      stage_key: string;
      stage_name: string;
      stage_order: number;
      color_hex: string;
      category: 'entry' | 'qualified' | 'won' | 'lost' | 'nurture';
      count: number;
    }
  >();

  for (const st of stagesRes.rows) {
    const isWon = Boolean(st.is_won_stage) || st.funnel_category === 'closed_won';
    const isLost = Boolean(st.is_lost_stage) || st.funnel_category === 'closed_lost';
    const isNurture = !isWon && !isLost && st.funnel_category === 'nurturing';
    const isEntry =
      !isWon &&
      !isLost &&
      !isNurture &&
      (st.funnel_category === 'new_uncontacted' || Number(st.stage_order) <= 2);
    const category: 'entry' | 'qualified' | 'won' | 'lost' | 'nurture' = isWon
      ? 'won'
      : isLost
        ? 'lost'
        : isNurture
          ? 'nurture'
          : isEntry
            ? 'entry'
            : 'qualified';
    stageMetaMap.set(String(st.id), {
      stage_id: String(st.id),
      stage_key: String(st.stage_key || st.id),
      stage_name: String(st.stage_name || st.stage_key || 'Stage'),
      stage_order: Number(st.stage_order || 0),
      color_hex: String(st.color_hex || '#1E40FF'),
      category,
      count: 0,
    });
  }

  let totalLeads = 0;
  let entryStageLeads = 0;
  let qualifiedStageLeads = 0;
  let wonStageLeads = 0;
  let lostStageLeads = 0;
  let nurtureStageLeads = 0;
  let assignedLeads = 0;
  let contactedLeads = 0;
  let paidLeads = 0;
  let instantFormLeads = 0;
  let validPhoneCount = 0;
  let actualRevenue = 0;

  const leadsByAd = new Map<string, any[]>();
  const leadsByCampaign = new Map<string, any[]>();
  const leadsByAdset = new Map<string, any[]>();
  const advisorMap = new Map<
    string,
    { id: string; user_id: string; name: string; avatar: string; leads: number; qualified: number; won: number; revenue: number }
  >();

  for (const l of leadRows) {
    totalLeads += 1;
    const lid = String(l.id);
    const stInfo = l.stage_id ? stageMetaMap.get(String(l.stage_id)) : undefined;
    if (stInfo) {
      stInfo.count += 1;
      if (stInfo.category === 'entry') entryStageLeads += 1;
      else if (stInfo.category === 'qualified') qualifiedStageLeads += 1;
      else if (stInfo.category === 'won') wonStageLeads += 1;
      else if (stInfo.category === 'lost') lostStageLeads += 1;
      else if (stInfo.category === 'nurture') nurtureStageLeads += 1;
    } else {
      entryStageLeads += 1;
    }

    if (l.assigned_to) assignedLeads += 1;
    if (l.is_accepted) contactedLeads += 1;
    const srcLower = String(l.source || '').toLowerCase();
    const isPaid = Boolean(l.ad_id || l.campaign_id || srcLower.includes('facebook') || srcLower.includes('meta'));
    if (isPaid) paidLeads += 1;
    if (l.form_id) instantFormLeads += 1;
    if (l.phone && String(l.phone).trim().length >= 8) validPhoneCount += 1;

    const leadRev = Math.max(
      Number(l.total_revenue_vnd || 0),
      dealRevByLead.get(lid) || 0,
      soRevByLead.get(lid) || 0
    );
    actualRevenue += leadRev;

    if (l.assigned_to) {
      const uid = String(l.assigned_to);
      if (!advisorMap.has(uid)) {
        advisorMap.set(uid, {
          id: uid,
          user_id: uid,
          name: String(l.owner_name || 'Chuyên viên'),
          avatar: String(l.owner_avatar || ''),
          leads: 0,
          qualified: 0,
          won: 0,
          revenue: 0,
        });
      }
      const adv = advisorMap.get(uid)!;
      adv.leads += 1;
      if (stInfo?.category === 'qualified' || stInfo?.category === 'won') adv.qualified += 1;
      if (stInfo?.category === 'won') adv.won += 1;
      adv.revenue += leadRev;
    }

    const baseLeadDto = {
      id: lid,
      contact_id: lid,
      full_name: String(l.name || ''),
      phone: l.phone ? String(l.phone) : '',
      email: l.email ? String(l.email) : '',
      ad_id: l.ad_id ? String(l.ad_id) : '',
      adset_id: l.adset_id ? String(l.adset_id) : '',
      campaign_id: l.campaign_id ? String(l.campaign_id) : '',
      stage_id: l.stage_id ? String(l.stage_id) : '',
      stage_key: stInfo?.stage_key || 'new',
      stage_name: stInfo?.stage_name || 'Mới tiếp nhận',
      stage_category: stInfo?.category || 'entry',
      owner_name: String(l.owner_name || 'Chưa phân bổ'),
      revenue_vnd: leadRev,
      created_at: l.created_at,
    };
    const finalLeadDto = maskRow ? maskRow(baseLeadDto) : baseLeadDto;

    if (l.ad_id) {
      const arr = leadsByAd.get(String(l.ad_id)) || [];
      arr.push(finalLeadDto);
      leadsByAd.set(String(l.ad_id), arr);
    }
    if (l.adset_id) {
      const arr = leadsByAdset.get(String(l.adset_id)) || [];
      arr.push(finalLeadDto);
      leadsByAdset.set(String(l.adset_id), arr);
    }
    if (l.campaign_id) {
      const arr = leadsByCampaign.get(String(l.campaign_id)) || [];
      arr.push(finalLeadDto);
      leadsByCampaign.set(String(l.campaign_id), arr);
    }
  }

  // Aggregate Meta Ads Insights
  let spend = 0;
  let impressions = 0;
  let clicks = 0;
  let reach = 0;
  let metaLeads = 0;

  const dailyMap = new Map<string, { date: string; spend: number; impressions: number; clicks: number; meta_leads: number; crm_leads: number }>();
  const campaignMap = new Map<string, any>();
  const adsetMap = new Map<string, any>();
  const adMap = new Map<string, any>();
  const goalMap = new Map<string, { goal: string; label: string; spend: number; leads: number; impressions: number; clicks: number }>();

  for (const row of insightRows) {
    const rSpend = Number(row.spend || 0);
    const rImp = Number(row.impressions || 0);
    const rClicks = Number(row.clicks || 0);
    const rReach = Number(row.reach || 0);
    const rLeads = Number(row.meta_leads || 0);

    spend += rSpend;
    impressions += rImp;
    clicks += rClicks;
    reach += rReach;
    metaLeads += rLeads;

    const dKey = String(row.date_start instanceof Date ? row.date_start.toISOString().slice(0, 10) : row.date_start || '').slice(0, 10);
    if (dKey) {
      const dEntry = dailyMap.get(dKey) || { date: dKey, spend: 0, impressions: 0, clicks: 0, meta_leads: 0, crm_leads: 0 };
      dEntry.spend += rSpend;
      dEntry.impressions += rImp;
      dEntry.clicks += rClicks;
      dEntry.meta_leads += rLeads;
      dailyMap.set(dKey, dEntry);
    }

    const goalKey = String(row.optimization_goal || 'LEAD_GENERATION');
    const gEntry = goalMap.get(goalKey) || { goal: goalKey, label: goalKey, spend: 0, leads: 0, impressions: 0, clicks: 0 };
    gEntry.spend += rSpend;
    gEntry.leads += rLeads;
    gEntry.impressions += rImp;
    gEntry.clicks += rClicks;
    goalMap.set(goalKey, gEntry);

    const cmpId = String(row.campaign_id || '');
    if (cmpId) {
      const cEntry = campaignMap.get(cmpId) || {
        id: cmpId,
        campaign_id: cmpId,
        name: String(row.campaign_name || `Campaign ${cmpId}`),
        ad_account_id: String(row.ad_account_id || ''),
        spend: 0,
        impressions: 0,
        clicks: 0,
        reach: 0,
        meta_leads: 0,
      };
      cEntry.spend += rSpend;
      cEntry.impressions += rImp;
      cEntry.clicks += rClicks;
      cEntry.reach += rReach;
      cEntry.meta_leads += rLeads;
      campaignMap.set(cmpId, cEntry);
    }

    const asId = String(row.adset_id || '');
    if (asId) {
      const asEntry = adsetMap.get(asId) || {
        id: asId,
        adset_id: asId,
        campaign_id: cmpId,
        campaign_name: String(row.campaign_name || ''),
        name: String(row.adset_name || `AdSet ${asId}`),
        spend: 0,
        impressions: 0,
        clicks: 0,
        reach: 0,
        meta_leads: 0,
      };
      asEntry.spend += rSpend;
      asEntry.impressions += rImp;
      asEntry.clicks += rClicks;
      asEntry.reach += rReach;
      asEntry.meta_leads += rLeads;
      adsetMap.set(asId, asEntry);
    }

    const adId = String(row.ad_id || '');
    if (adId) {
      const aEntry = adMap.get(adId) || {
        id: adId,
        ad_id: adId,
        adset_id: asId,
        adset_name: String(row.adset_name || ''),
        campaign_id: cmpId,
        campaign_name: String(row.campaign_name || ''),
        ad_account_id: String(row.ad_account_id || ''),
        name: String(row.ad_name || `Ad ${adId}`),
        thumbnail_url: row.thumbnail_url || '',
        image_url: row.image_url || '',
        creative_title: row.creative_title || '',
        creative_body: row.creative_body || '',
        story_id: row.story_id || '',
        optimization_goal: row.optimization_goal || 'LEAD_GENERATION',
        spend: 0,
        impressions: 0,
        clicks: 0,
        reach: 0,
        meta_leads: 0,
      };
      aEntry.spend += rSpend;
      aEntry.impressions += rImp;
      aEntry.clicks += rClicks;
      aEntry.reach += rReach;
      aEntry.meta_leads += rLeads;
      adMap.set(adId, aEntry);
    }
  }

  // Merge CRM lead daily counts into daily_trend
  for (const l of leadRows) {
    const dKey = toVnIsoDate(new Date(String(l.created_at)));
    const dEntry = dailyMap.get(dKey) || { date: dKey, spend: 0, impressions: 0, clicks: 0, meta_leads: 0, crm_leads: 0 };
    dEntry.crm_leads += 1;
    dailyMap.set(dKey, dEntry);
  }
  const dailyTrend = Array.from(dailyMap.values()).sort((a, b) => a.date.localeCompare(b.date));

  const enrichMetrics = (item: any, matchedLeads: any[]) => {
    const lCount = matchedLeads.length;
    const qualCount = matchedLeads.filter((x) => x.stage_category === 'qualified' || x.stage_category === 'won').length;
    const wonCount = matchedLeads.filter((x) => x.stage_category === 'won').length;
    const rev = matchedLeads.reduce((s, x) => s + Number(x.revenue_vnd || 0), 0);
    const stageCounts: Record<string, number> = {};
    for (const x of matchedLeads) {
      const sk = String(x.stage_key || 'new');
      stageCounts[sk] = (stageCounts[sk] || 0) + 1;
    }
    const denomLeads = lCount > 0 ? lCount : Number(item.meta_leads || 0);
    return {
      ...item,
      leads: denomLeads,
      crm_leads: lCount,
      qualified: qualCount,
      won: wonCount,
      revenue: rev,
      cpl: denomLeads > 0 ? Math.round(item.spend / denomLeads) : 0,
      cpq: qualCount > 0 ? Math.round(item.spend / qualCount) : 0,
      roas: item.spend > 0 ? Number((rev / item.spend).toFixed(2)) : 0,
      ctr: item.impressions > 0 ? Number(((item.clicks / item.impressions) * 100).toFixed(2)) : 0,
      cpc: item.clicks > 0 ? Math.round(item.spend / item.clicks) : 0,
      stage_counts: stageCounts,
      attributed_leads: matchedLeads,
    };
  };

  const campaigns = Array.from(campaignMap.values())
    .map((c) => enrichMetrics(c, leadsByCampaign.get(c.campaign_id) || []))
    .sort((a, b) => b.spend - a.spend);
  const adsets = Array.from(adsetMap.values())
    .map((a) => enrichMetrics(a, leadsByAdset.get(a.adset_id) || []))
    .sort((a, b) => b.spend - a.spend);
  const ads = Array.from(adMap.values())
    .map((ad) => enrichMetrics(ad, leadsByAd.get(ad.ad_id) || []))
    .sort((a, b) => b.spend - a.spend);

  const hierarchy = campaigns.map((cmp) => ({
    ...cmp,
    adsets: adsets
      .filter((as) => as.campaign_id === cmp.campaign_id)
      .map((as) => ({
        ...as,
        ads: ads.filter((ad) => ad.adset_id === as.adset_id),
      })),
  }));

  const stageBreakdown = Array.from(stageMetaMap.values()).map((st) => ({
    ...st,
    pct: totalLeads > 0 ? Math.round((st.count / totalLeads) * 1000) / 10 : 0,
  }));

  const prevRow = prevRes.rows[0] || { spend: 0, impressions: 0, reach: 0, meta_leads: 0 };
  const prevSpend = Number(prevRow.spend || 0);
  const prevImp = Number(prevRow.impressions || 0);
  const prevReach = Number(prevRow.reach || 0);
  const prevMetaLeads = Number(prevRow.meta_leads || 0);
  const pctChange = (cur: number, prev: number) => (prev > 0 ? Math.round(((cur - prev) / prev) * 1000) / 10 : 0);

  const roas = spend > 0 ? Number((actualRevenue / spend).toFixed(2)) : 0;
  const effectiveLeadDenom = totalLeads > 0 ? totalLeads : metaLeads;
  const cpl = effectiveLeadDenom > 0 ? Math.round(spend / effectiveLeadDenom) : 0;
  const metaCpl = metaLeads > 0 ? Math.round(spend / metaLeads) : 0;
  const cpq = qualifiedStageLeads > 0 ? Math.round(spend / qualifiedStageLeads) : 0;
  const cpw = wonStageLeads > 0 ? Math.round(spend / wonStageLeads) : 0;

  return {
    configured: true,
    accounts,
    summary: {
      account_id: displayAccountId,
      account_name: displayAccountName,
      since: win.since,
      until: win.until,
      spend,
      attributed_spend: spend,
      account_total_spend: spend,
      prev_spend: prevSpend,
      spend_change_pct: pctChange(spend, prevSpend),
      lead_goal_spend: spend,
      meta_leads: metaLeads,
      account_meta_leads: metaLeads,
      prev_meta_leads: prevMetaLeads,
      leads_change_pct: pctChange(metaLeads, prevMetaLeads),
      meta_cpl: metaCpl,
      account_meta_cpl: metaCpl,
      cpl,
      crm_cpl: totalLeads > 0 ? Math.round(spend / totalLeads) : 0,
      cost_per_new_1_2: entryStageLeads > 0 ? Math.round(spend / entryStageLeads) : 0,
      cpq,
      cpq_3_12: cpq,
      cpw,
      impressions,
      prev_impressions: prevImp,
      impressions_change_pct: pctChange(impressions, prevImp),
      reach,
      prev_reach: prevReach,
      reach_change_pct: pctChange(reach, prevReach),
      frequency: reach > 0 ? Number((impressions / reach).toFixed(2)) : 0,
      cpm: impressions > 0 ? Math.round((spend / impressions) * 1000) : 0,
      clicks,
      cpc: clicks > 0 ? Math.round(spend / clicks) : 0,
      ctr: impressions > 0 ? Number(((clicks / impressions) * 100).toFixed(2)) : 0,
      total_leads: totalLeads,
      entry_stage_leads: entryStageLeads,
      qualified_stage_leads: qualifiedStageLeads,
      won_stage_leads: wonStageLeads,
      lost_stage_leads: lostStageLeads,
      nurture_stage_leads: nurtureStageLeads,
      new_1_2_leads: entryStageLeads,
      new_1_2_pct: totalLeads > 0 ? Math.round((entryStageLeads / totalLeads) * 1000) / 10 : 0,
      qualified_3_12_leads: qualifiedStageLeads,
      qualified_3_12_pct: totalLeads > 0 ? Math.round((qualifiedStageLeads / totalLeads) * 1000) / 10 : 0,
      won_leads: wonStageLeads,
      won_pct: totalLeads > 0 ? Math.round((wonStageLeads / totalLeads) * 1000) / 10 : 0,
      qualified_leads: qualifiedStageLeads + wonStageLeads,
      qualified_pct: totalLeads > 0 ? Math.round(((qualifiedStageLeads + wonStageLeads) / totalLeads) * 1000) / 10 : 0,
      uncontacted_leads: Math.max(0, totalLeads - contactedLeads),
      contacted_leads: contactedLeads,
      contacted_pct: totalLeads > 0 ? Math.round((contactedLeads / totalLeads) * 1000) / 10 : 0,
      assigned_leads: assignedLeads,
      assigned_pct: totalLeads > 0 ? Math.round((assignedLeads / totalLeads) * 1000) / 10 : 0,
      paid_leads: paidLeads,
      organic_leads: Math.max(0, totalLeads - paidLeads),
      instant_form_leads: instantFormLeads,
      actual_revenue: actualRevenue,
      roas,
      campaigns_count: campaigns.length,
      active_campaigns_count: campaigns.length,
      adsets_count: adsets.length,
      active_adsets_count: adsets.length,
      ads_count: ads.length,
      active_ads_count: ads.length,
      forms_count: Array.from(new Set(leadRows.map((l) => l.form_id).filter(Boolean))).length,
      valid_phone_pct: totalLeads > 0 ? Math.round((validPhoneCount / totalLeads) * 1000) / 10 : 0,
      survey_completed_pct: 0,
    },
    stage_breakdown: stageBreakdown,
    daily_trend: dailyTrend,
    campaigns,
    by_campaign: campaigns,
    adsets,
    by_adset: adsets,
    ads,
    by_ad: ads,
    hierarchy,
    meta_goal_chart: Array.from(goalMap.values()),
    funnel_stages: stageBreakdown.map((s) => ({ name: s.stage_name, count: s.count, pct: s.pct, color: s.color_hex })),
    pipeline_stages_catalog: stageBreakdown.map((s) => ({
      key: s.stage_key,
      stage_id: s.stage_id,
      stage_order: s.stage_order,
      stage_name: s.stage_name,
      bucket: s.category === 'entry' ? 'new_1_2' : s.category === 'qualified' ? 'qualified_3_12' : s.category === 'won' ? 'win_13_14' : s.category,
      count: s.count,
      color_hex: s.color_hex,
    })),
    top_advisors: Array.from(advisorMap.values()).sort((a, b) => b.leads - a.leads),
    attributed_leads: leadRows.slice(0, 200).map((l) => {
      const stInfo = l.stage_id ? stageMetaMap.get(String(l.stage_id)) : undefined;
      const dto = {
        id: String(l.id),
        contact_id: String(l.id),
        full_name: String(l.name || ''),
        phone: l.phone ? String(l.phone) : '',
        email: l.email ? String(l.email) : '',
        ad_id: l.ad_id ? String(l.ad_id) : '',
        ad_name: l.ad_id ? adMap.get(String(l.ad_id))?.name || String(l.ad_id) : '',
        campaign_id: l.campaign_id ? String(l.campaign_id) : '',
        stage_key: stInfo?.stage_key || 'new',
        stage_name: stInfo?.stage_name || 'Mới tiếp nhận',
        owner_name: String(l.owner_name || 'Chưa phân bổ'),
        created_at: l.created_at,
      };
      return maskRow ? maskRow(dto) : dto;
    }),
  };
}
