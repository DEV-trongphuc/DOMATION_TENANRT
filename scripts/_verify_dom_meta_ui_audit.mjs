import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import puppeteer from 'puppeteer';

const LANDING_DIR = 'D:\\GITHUB_SPACE\\DOMATION_LANDINGPAGE';
const OUT_DIR = 'D:\\GITHUB_SPACE\\AUTO_DATA_TENANRT\\scripts\\_audit_shots';
const PORT = 4188;
const BASE_URL = `http://127.0.0.1:${PORT}`;

fs.mkdirSync(OUT_DIR, { recursive: true });

async function waitForHttp(url, timeoutMs = 20000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const r = await fetch(url);
      if (r.ok) return;
    } catch {
      // retry
    }
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error(`Timed out waiting for ${url}`);
}

function buildMockBatchResponse(requests, batchAuditLog) {
  const out = {};
  for (const req of requests || []) {
    const { key, params = {} } = req;
    batchAuditLog.push({ key, graph_path: req.graph_path, params });

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
              { action_type: 'post', value: '195' },
              { action_type: 'photo_view', value: '5120' },
              { action_type: 'video_view', value: '86400' },
              { action_type: 'like', value: '310' },
            ],
            video_play_actions: [{ action_type: 'video_view', value: '142000' }],
            video_thruplay_watched_actions: [{ action_type: 'video_view', value: '41200' }],
            video_p25_watched_actions: [{ action_type: 'video_view', value: '79000' }],
            video_p50_watched_actions: [{ action_type: 'video_view', value: '54000' }],
            video_p75_watched_actions: [{ action_type: 'video_view', value: '36000' }],
            video_p95_watched_actions: [{ action_type: 'video_view', value: '22000' }],
            video_p100_watched_actions: [{ action_type: 'video_view', value: '18500' }],
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
        const leads = 10 + (i % 9);
        const msgs = 7 + (i % 6);
        days.push({
          date_start: `2026-11-${dd}`,
          spend: String(spend),
          impressions: String(Math.round(spend / 78)),
          reach: String(Math.round(spend / 115)),
          clicks: String(Math.round(spend / 3200)),
          actions: [
            { action_type: 'lead', value: String(leads) },
            { action_type: 'onsite_conversion.messaging_conversation_started_7d', value: String(msgs) },
            { action_type: 'like', value: String(12 + (i % 5)) },
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
            name: '[THE CRUMB CLUB] Messaging Grand Opening Promo',
            status: 'ACTIVE',
            effective_status: 'ACTIVE',
            objective: 'OUTCOME_ENGAGEMENT',
            daily_budget: '1800000',
          },
          {
            id: 'camp_zero_spend_999',
            name: 'ZERO_SPEND_GHOST_CAMPAIGN_OLD_2025',
            status: 'ACTIVE',
            effective_status: 'ACTIVE',
            objective: 'OUTCOME_LEADS',
            daily_budget: '1000000',
          },
        ],
      };
    } else if (key === 'campIns') {
      // Simulate Meta Graph filtering spend > 0 + test client-side guard with a 0-spend row if ever returned
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
              { action_type: 'post_reaction', value: '2640' },
              { action_type: 'comment', value: '412' },
              { action_type: 'post', value: '128' },
              { action_type: 'photo_view', value: '3200' },
              { action_type: 'video_view', value: '58000' },
              { action_type: 'like', value: '190' },
            ],
            video_play_actions: [{ action_type: 'video_view', value: '96000' }],
            video_thruplay_watched_actions: [{ action_type: 'video_view', value: '29400' }],
            video_p25_watched_actions: [{ action_type: 'video_view', value: '54000' }],
            video_p50_watched_actions: [{ action_type: 'video_view', value: '38000' }],
            video_p75_watched_actions: [{ action_type: 'video_view', value: '25000' }],
            video_p95_watched_actions: [{ action_type: 'video_view', value: '15200' }],
            video_p100_watched_actions: [{ action_type: 'video_view', value: '12800' }],
          },
          {
            campaign_id: 'camp_active_2',
            campaign_name: '[THE CRUMB CLUB] Messaging Grand Opening Promo',
            objective: 'OUTCOME_ENGAGEMENT',
            spend: '17000000',
            impressions: '225000',
            reach: '137000',
            clicks: '5600',
            actions: [
              { action_type: 'onsite_conversion.messaging_conversation_started_7d', value: '164' },
              { action_type: 'link_click', value: '3320' },
              { action_type: 'post_engagement', value: '7500' },
            ],
          },
          {
            campaign_id: 'camp_zero_spend_999',
            campaign_name: 'ZERO_SPEND_GHOST_CAMPAIGN_OLD_2025',
            objective: 'OUTCOME_LEADS',
            spend: '0',
            impressions: '0',
            reach: '0',
            clicks: '0',
            actions: [],
          },
        ],
      };
    } else if (key === 'adsetList') {
      out[key] = {
        data: [
          {
            id: 'adset_1',
            name: 'Adset 01 - HCMC High Net Worth 28-50',
            campaign_id: 'camp_active_1',
            status: 'ACTIVE',
            effective_status: 'ACTIVE',
            optimization_goal: 'LEAD_GENERATION',
            daily_budget: '2000000',
          },
          {
            id: 'adset_2',
            name: 'Adset 02 - Crumb Club F&B Lovers',
            campaign_id: 'camp_active_2',
            status: 'ACTIVE',
            effective_status: 'ACTIVE',
            optimization_goal: 'CONVERSATIONS',
            daily_budget: '1800000',
          },
        ],
      };
    } else if (key === 'adsetIns') {
      out[key] = {
        data: [
          {
            adset_id: 'adset_1',
            adset_name: 'Adset 01 - HCMC High Net Worth 28-50',
            campaign_id: 'camp_active_1',
            campaign_name: '[ECOLIFE] Lead Form Signature Q4 - Luxury Pent',
            optimization_goal: 'LEAD_GENERATION',
            spend: '31500000',
            impressions: '395000',
            reach: '248000',
            clicks: '9200',
            actions: [{ action_type: 'lead', value: '186' }],
          },
          {
            adset_id: 'adset_2',
            adset_name: 'Adset 02 - Crumb Club F&B Lovers',
            campaign_id: 'camp_active_2',
            campaign_name: '[THE CRUMB CLUB] Messaging Grand Opening Promo',
            optimization_goal: 'CONVERSATIONS',
            spend: '17000000',
            impressions: '225000',
            reach: '137000',
            clicks: '5600',
            actions: [
              { action_type: 'onsite_conversion.messaging_conversation_started_7d', value: '164' },
            ],
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
            creative: {
              id: 'cr_1',
              thumbnail_url: 'http://127.0.0.1:4188/assets/partners/logo_ecolife_ngang.webp',
            },
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
            adset_name: 'Adset 01 - HCMC High Net Worth 28-50',
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
          {
            publisher_platform: 'facebook',
            platform_position: 'feed',
            spend: '19500000',
            impressions: '230000',
            reach: '150000',
            clicks: '5400',
            actions: [{ action_type: 'lead', value: '98' }],
          },
          {
            publisher_platform: 'facebook',
            platform_position: 'facebook_reels',
            spend: '11200000',
            impressions: '148000',
            reach: '96000',
            clicks: '3200',
            actions: [{ action_type: 'lead', value: '52' }],
          },
          {
            publisher_platform: 'instagram',
            platform_position: 'instagram_reels',
            spend: '9800000',
            impressions: '124000',
            reach: '82000',
            clicks: '2900',
            actions: [{ action_type: 'lead', value: '39' }],
          },
          {
            publisher_platform: 'messenger',
            platform_position: 'messenger_inbox',
            spend: '5100000',
            impressions: '72000',
            reach: '45000',
            clicks: '1900',
            actions: [{ action_type: 'lead', value: '21' }],
          },
          {
            publisher_platform: 'audience_network',
            platform_position: 'classic',
            spend: '2900000',
            impressions: '46000',
            reach: '31000',
            clicks: '1400',
            actions: [{ action_type: 'lead', value: '8' }],
          },
        ],
      };
    } else if (key === 'ageGender' || key === 'byAgeGender') {
      out[key] = {
        data: [
          { age: '25-34', gender: 'male', spend: '11200000', impressions: '138000', reach: '90000', clicks: '3100', actions: [{ action_type: 'lead', value: '54' }] },
          { age: '25-34', gender: 'female', spend: '10400000', impressions: '132000', reach: '86000', clicks: '2950', actions: [{ action_type: 'lead', value: '51' }] },
          { age: '35-44', gender: 'male', spend: '9800000', impressions: '115000', reach: '74000', clicks: '2600', actions: [{ action_type: 'lead', value: '46' }] },
          { age: '35-44', gender: 'female', spend: '8300000', impressions: '102000', reach: '66000', clicks: '2200', actions: [{ action_type: 'lead', value: '39' }] },
          { age: '45-54', gender: 'male', spend: '5200000', impressions: '68000', reach: '42000', clicks: '1400', actions: [{ action_type: 'lead', value: '18' }] },
          { age: '45-54', gender: 'female', spend: '3600000', impressions: '51000', reach: '33000', clicks: '980', actions: [{ action_type: 'lead', value: '10' }] },
        ],
      };
    } else if (key === 'region' || key === 'byRegion') {
      out[key] = {
        data: [
          { region: 'Ho Chi Minh City', spend: '24500000', impressions: '290000', reach: '185000', clicks: '6800', actions: [{ action_type: 'lead', value: '112' }] },
          { region: 'Hanoi', spend: '11800000', impressions: '148000', reach: '95000', clicks: '3400', actions: [{ action_type: 'lead', value: '54' }] },
          { region: 'Binh Duong Province', spend: '5400000', impressions: '72000', reach: '48000', clicks: '1650', actions: [{ action_type: 'lead', value: '24' }] },
          { region: 'Dong Nai Province', spend: '4100000', impressions: '58000', reach: '39000', clicks: '1320', actions: [{ action_type: 'lead', value: '17' }] },
          { region: 'Ba Ria - Vung Tau', spend: '2700000', impressions: '39000', reach: '25000', clicks: '890', actions: [{ action_type: 'lead', value: '11' }] },
        ],
      };
    } else if (key === 'device' || key === 'byDevice') {
      out[key] = {
        data: [
          { impression_device: 'iphone', spend: '26800000', impressions: '315000', reach: '198000', clicks: '7900', actions: [{ action_type: 'lead', value: '124' }] },
          { impression_device: 'android_smartphone', spend: '15400000', impressions: '212000', reach: '134000', clicks: '4700', actions: [{ action_type: 'lead', value: '68' }] },
          { impression_device: 'desktop', spend: '4200000', impressions: '62000', reach: '38000', clicks: '1520', actions: [{ action_type: 'lead', value: '19' }] },
          { impression_device: 'ipad', spend: '2100000', impressions: '31000', reach: '19000', clicks: '680', actions: [{ action_type: 'lead', value: '7' }] },
        ],
      };
    } else if (key === 'hourly' || key === 'byHour') {
      const hours = [];
      for (let h = 0; h < 24; h++) {
        const hh = String(h).padStart(2, '0');
        // Deliberately make 05:00 have 0 leads and 66 post_engagement to test strict goal extraction!
        const isZeroLeadHour = h === 5;
        const leads = isZeroLeadHour ? 0 : h >= 8 && h <= 22 ? 4 + (h % 8) : h % 2;
        const spend = isZeroLeadHour
          ? 240000
          : h >= 8 && h <= 22
            ? 1450000 + ((h * 210000) % 1300000)
            : 280000 + h * 45000;
        const actions = [{ action_type: 'post_engagement', value: '66' }, { action_type: 'link_click', value: '19' }];
        if (leads > 0) {
          actions.push({ action_type: 'lead', value: String(leads) });
        }
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
        name: 'EcoLife Signature Ad Account',
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
    } else if (key === 'activities') {
      out[key] = { data: [] };
    } else if (key === 'campAdsets') {
      out[key] = {
        data: [
          {
            id: 'adset_1',
            name: 'Adset 01 - HCMC High Net Worth 28-50',
            optimization_goal: 'LEAD_GENERATION',
            targeting: {
              age_min: 28,
              age_max: 52,
              genders: [1, 2],
              publisher_platforms: ['facebook', 'instagram', 'messenger'],
              facebook_positions: ['feed', 'facebook_reels', 'facebook_stories'],
              instagram_positions: ['stream', 'instagram_reels'],
              geo_locations: {
                cities: [
                  { name: 'Ho Chi Minh City', radius: 15, distance_unit: 'kilometer' },
                  { name: 'Hanoi', radius: 12, distance_unit: 'kilometer' },
                ],
              },
              flexible_spec: [
                {
                  interests: [
                    { id: '60031', name: 'Bất động sản cao cấp' },
                    { id: '60032', name: 'Đầu tư tài chính' },
                    { id: '60033', name: 'Penthouse & Duplex' },
                    { id: '60034', name: 'Golf & Resort' },
                  ],
                },
              ],
            },
          },
        ],
      };
    } else {
      out[key] = { data: [] };
    }
  }
  return out;
}

async function main() {
  const previewProc = spawn(
    process.platform === 'win32' ? 'cmd.exe' : 'npx',
    process.platform === 'win32'
      ? ['/c', 'npx', 'vite', 'preview', '--port', String(PORT), '--host', '127.0.0.1']
      : ['vite', 'preview', '--port', String(PORT), '--host', '127.0.0.1'],
    { cwd: LANDING_DIR, stdio: 'pipe' }
  );

  let browser;
  const assertions = [];
  const assert = (cond, msg, detail = null) => {
    if (!cond) {
      const err = `ASSERTION FAILED: ${msg}${detail ? ' -> ' + JSON.stringify(detail) : ''}`;
      console.error(err);
      throw new Error(err);
    }
    assertions.push(`PASS: ${msg}`);
  };

  try {
    await waitForHttp(`${BASE_URL}/meta-report`);

    browser = await puppeteer.launch({
      headless: 'new',
      args: ['--no-sandbox', '--disable-setuid-sandbox'],
    });

    const page = await browser.newPage();
    await page.setViewport({ width: 1440, height: 900, deviceScaleFactor: 2 });

    const batchAuditLog = [];
    const pageErrors = [];
    page.on('pageerror', (err) => pageErrors.push(err.message));

    await page.setRequestInterception(true);
    page.on('request', async (req) => {
      const url = req.url();
      if (url.includes('/api/autodata?action=bootstrap')) {
        return req.respond({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ success: true, data: { google_oauth: { enabled: true, client_id: 'test' } } }),
        });
      }
      if (url.includes('/api/v1/integrations/dom-meta/config')) {
        return req.respond({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({
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
                    name: 'EcoLife Signature Ad Account',
                    has_token: true,
                    is_active: true,
                  },
                ],
              },
              brand_filters: [
                { name: 'EcoLife Signature', filter: 'ECOLIFE', avatarUrl: '/assets/partners/logo_ecolife_ngang.webp' },
                { name: 'The Crumb Club', filter: 'THE CRUMB CLUB', avatarUrl: '/assets/partners/partner_the_crumb_club.jpg' },
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
          }),
        });
      }
      if (url.includes('/api/v1/integrations/dom-meta/meta-batch')) {
        const postBody = JSON.parse(req.postData() || '{}');
        const batchData = buildMockBatchResponse(postBody.requests || [], batchAuditLog);
        return req.respond({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ success: true, data: batchData }),
        });
      }
      if (url.includes('/api/v1/billing/overview') || url.includes('/api/v1/billing/catalog')) {
        return req.respond({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({
            success: true,
            data: {
              wallet: { balance_vnd: 4500000, total_topup_vnd: 4500000, total_spent_vnd: 0, updated_at: '2026-11-19T08:00:00Z' },
              subscription: {
                plan_tier: 'starter',
                plan_name: 'Gói Dùng Thử 30 Ngày (Shared Trial)',
                status: 'trialing',
                billing_cycle: 'monthly',
                max_users: 5,
                monthly_leads_limit: 500,
                used_leads_this_month: 84,
                used_users_count: 3,
                days_remaining: 26,
                is_in_trial: true,
                is_expired: false,
                trial_ends_at: '2026-12-15T00:00:00Z',
                subscription_ends_at: null,
                features: ['Báo cáo Meta Ads + CRM AutoData dùng chung 30 ngày miễn phí'],
              },
              catalog: {
                trial_duration_days: 30,
                plans: [
                  {
                    code: 'autodata_standard',
                    plan_tier: 'starter',
                    name: 'Auto Data Standard',
                    badge: 'Phổ biến nhất',
                    tagline: 'Tự động thu Lead Meta/TikTok & chia số công bằng cho đội Sale',
                    monthly_price_vnd: 1500000,
                    annual_total_vnd: 15300000,
                    annual_monthly_equivalent_vnd: 1275000,
                    annual_saved_vnd: 2700000,
                    max_users: 25,
                    max_rounds: 5,
                    monthly_lead_quota: 5000,
                    features: [
                      'Tối đa 25 tài khoản Sale / Marketing / Quản lý',
                      '5.000 Lead đồng bộ tự động mỗi tháng',
                      'Track chuẩn từng Lead về đúng Ad / Adset / Campaign',
                      'Auto chia số Fair-Share & thu hồi khi Sale chậm xử lý',
                    ],
                  },
                  {
                    code: 'autodata_scale_pro',
                    plan_tier: 'pro',
                    name: 'Auto Data Scale Pro',
                    badge: 'Tối ưu Scale',
                    tagline: 'Đa dự án, phân bổ theo tỷ lệ đại lý F1 & gửi ngược Meta CAPI',
                    monthly_price_vnd: 3000000,
                    annual_total_vnd: 30600000,
                    annual_monthly_equivalent_vnd: 2550000,
                    annual_saved_vnd: 5400000,
                    max_users: 100,
                    max_rounds: 25,
                    monthly_lead_quota: 25000,
                    features: [
                      'Tối đa 100 nhân sự & phân quyền đa sàn/chi nhánh',
                      '25.000 Lead/tháng + Meta Conversion API (CAPI) tự động',
                      'Báo cáo CPQL (Cost per Qualified Lead) & ROAS thực tế',
                    ],
                  },
                  {
                    code: 'domation_crm_erp',
                    plan_tier: 'enterprise',
                    name: 'DOMATION CRM 360° & ERP 5.0',
                    badge: 'All-in-One',
                    tagline: 'Hợp nhất Quảng cáo + CRM + Hợp đồng + Công nợ + Nhân sự',
                    monthly_price_vnd: 6000000,
                    annual_total_vnd: 61200000,
                    annual_monthly_equivalent_vnd: 5100000,
                    annual_saved_vnd: 10800000,
                    max_users: 9999,
                    max_rounds: 999,
                    monthly_lead_quota: 1000000,
                    is_enterprise_upgrade: true,
                    features: [
                      'Giữ nguyên 100% dữ liệu Lead, lịch sử Timeline & cấu hình hiện có',
                      'Quản trị dòng tiền, hoa hồng Sale, KPI & kho hàng',
                    ],
                  },
                ],
                topup_packages: [
                  { id: 'topup_1m', label: 'Topup 1 Tháng', amount_vnd: 1500000, bonus_vnd: 0, equivalent_months_note: 'Đủ gia hạn ngay 1 tháng gói Auto Data Standard' },
                  { id: 'topup_3m', label: 'Topup 3 Tháng', amount_vnd: 4500000, bonus_vnd: 0, equivalent_months_note: 'Đủ gia hạn 1 quý (3 tháng) liên tục' },
                  { id: 'topup_6m', label: 'Topup 6 Tháng (+5% Bonus)', amount_vnd: 9000000, bonus_vnd: 450000, equivalent_months_note: 'Tặng thêm +450.000₫ (= 9.450.000₫ vào ví gia hạn)' },
                  { id: 'topup_12m', label: 'Topup Năm (Tiết kiệm 15%)', amount_vnd: 15300000, bonus_vnd: 0, equivalent_months_note: 'Đủ mua gói Năm (-15%), chỉ 1.275.000₫/tháng', highlight: true },
                ],
                payment_bank_info: {
                  bank_name: 'Techcombank (TCB)',
                  account_number: '19038889996868',
                  account_holder: 'CONG TY GIAI PHAP CONG NGHE DOMATION',
                  transfer_prefix: 'DOMDATA',
                },
              },
              transactions: [],
              orders: [],
            },
          }),
        });
      }
      return req.continue();
    });

    await page.evaluateOnNewDocument(() => {
      window.__DOM_META_PREVIEW__ = {
        authContext: {
          accessToken: 'jwt_preview_audit',
          tenantSlug: 'ecolife',
        },
        workspaceName: 'EcoLife Signature',
        userDisplayName: 'Minh Quân',
        userRoleLabel: 'admin',
        mode: 'standalone',
        initialView: 'dashboard',
        initialCustomRange: { since: '2026-11-01', until: '2026-11-14' },
      };
    });

    await page.goto(`${BASE_URL}/meta-report`, { waitUntil: 'networkidle0' });
    await page.waitForSelector('[data-testid="standalone-global-search"]', { timeout: 15000 });
    await page.waitForSelector('[data-testid="device-donut-card"]', { timeout: 15000 });
    await new Promise((r) => setTimeout(r, 350));

    // 1. Verify Graph API batch filtering & breakdowns
    const campInsReq = batchAuditLog.find((x) => x.key === 'campIns');
    const adsetInsReq = batchAuditLog.find((x) => x.key === 'adsetIns');
    const adInsReq = batchAuditLog.find((x) => x.key === 'adIns');
    const deviceReq = batchAuditLog.find((x) => x.key === 'device');
    assert(
      campInsReq?.params?.filtering?.includes('"GREATER_THAN"') &&
        adsetInsReq?.params?.filtering?.includes('"GREATER_THAN"') &&
        adInsReq?.params?.filtering?.includes('"GREATER_THAN"'),
      'campIns/adsetIns/adIns pass spend > 0 filtering to Meta Graph API'
    );
    assert(
      deviceReq?.params?.breakdowns === 'impression_device',
      'Dashboard device breakdown requests impression_device'
    );

    // 2. Verify Zero-Spend Campaign is strictly excluded from DOM
    const bodyText1 = await page.evaluate(() => document.body.innerText);
    assert(
      !bodyText1.includes('ZERO_SPEND_GHOST_CAMPAIGN_OLD_2025'),
      'Zero-spend active campaign in BM is excluded from Dashboard'
    );
    assert(
      bodyText1.includes('[ECOLIFE] Lead Form Signature Q4 - Luxury Pent'),
      'Active campaign with spend > 0 is rendered'
    );

    // 3. Measure Dashboard Chart Heights at t=200ms vs t=2000ms (No infinite stretch & no empty gap!)
    const measureDashboardHeights = () =>
      page.evaluate(() => {
        const findCardByTitle = (txt) => {
          const els = Array.from(document.querySelectorAll('h3, h4, div, span'));
          const hit = els.find((el) => el.childElementCount === 0 && el.textContent?.trim() === txt);
          if (!hit) return null;
          let cur = hit;
          while (cur && cur.parentElement) {
            if (cur.className && typeof cur.className === 'string' && cur.className.includes('rounded-2xl') && cur.className.includes('bg-white')) {
              const r = cur.getBoundingClientRect();
              if (r.height > 180) return { width: Math.round(r.width), height: Math.round(r.height), top: Math.round(r.top) };
            }
            cur = cur.parentElement;
          }
          return null;
        };
        const deviceCard = document.querySelector('[data-testid="device-donut-card"]');
        const devRect = deviceCard ? deviceCard.getBoundingClientRect() : null;
        return {
          dailySpent: findCardByTitle('Daily Spent'),
          metaGoal: findCardByTitle('Meta Goal'),
          activeCamp: findCardByTitle('Active Campaign'),
          spentPlatform: findCardByTitle('Spent Platform'),
          ageGender: findCardByTitle('Age & Gender'),
          deviceDonut: devRect ? { width: Math.round(devRect.width), height: Math.round(devRect.height) } : null,
          docScrollHeight: document.documentElement.scrollHeight,
          mainScrollHeight: document.querySelector('[data-dom-scroll-shell]')?.scrollHeight || 0,
        };
      });

    const dashH1 = await measureDashboardHeights();
    await new Promise((r) => setTimeout(r, 1800));
    const dashH2 = await measureDashboardHeights();

    console.log('Dashboard heights t1:', dashH1);
    console.log('Dashboard heights t2 (+1800ms):', dashH2);

    for (const key of ['dailySpent', 'metaGoal', 'activeCamp', 'spentPlatform', 'ageGender', 'deviceDonut']) {
      assert(Boolean(dashH1[key] && dashH2[key]), `Dashboard card ${key} found`, dashH2[key]);
      assert(
        Math.abs(dashH2[key].height - dashH1[key].height) <= 1,
        `Dashboard card ${key} has ZERO vertical runaway drift`,
        { t1: dashH1[key].height, t2: dashH2[key].height }
      );
      assert(
        dashH2[key].height >= 200 && dashH2[key].height <= 540,
        `Dashboard card ${key} height is healthy & bounded (${dashH2[key].height}px)`
      );
    }
    assert(
      Math.abs(dashH2.docScrollHeight - dashH1.docScrollHeight) <= 2,
      'Document scrollHeight is rock-steady (no infinite stretch)',
      { t1: dashH1.docScrollHeight, t2: dashH2.docScrollHeight }
    );
    assert(
      Math.abs(dashH2.activeCamp.height - dashH2.ageGender.height) <= 2 &&
        Math.abs(dashH2.spentPlatform.height - dashH2.ageGender.height) <= 2,
      'Row 2 cards (Active/Interaction, Spent Platform, Age & Gender) align to identical height'
    );

    // 4. Verify Sidebar Collapse `<` Button Not Clipped & Header Input Size
    const uiMetrics = await page.evaluate(() => {
      const btn = document.querySelector('[data-testid="sidebar-collapse-toggle"]');
      const r = btn.getBoundingClientRect();
      const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
      const search = document.querySelector('[data-testid="standalone-global-search"]');
      const sr = search.getBoundingClientRect();
      const upgradeBtn = document.querySelector('[data-testid="open-crm-upgrade-modal"]');
      const ur = upgradeBtn ? upgradeBtn.getBoundingClientRect() : null;
      return {
        collapseBtn: { left: r.left, top: r.top, width: r.width, height: r.height, hitInsideBtn: Boolean(hit && btn.contains(hit)) },
        globalSearch: { width: sr.width, height: sr.height },
        upgradeBtn: ur ? { width: ur.width, height: ur.height, top: ur.top } : null,
      };
    });
    assert(
      uiMetrics.collapseBtn.width >= 26 && uiMetrics.collapseBtn.hitInsideBtn,
      'Sidebar collapse `<` button is unclipped and clickable on top of header',
      uiMetrics.collapseBtn
    );
    assert(
      uiMetrics.globalSearch.width >= 300 && uiMetrics.globalSearch.height >= 34,
      'Header global search input is generously sized',
      uiMetrics.globalSearch
    );
    assert(Boolean(uiMetrics.upgradeBtn && uiMetrics.upgradeBtn.width > 160), 'Sidebar Upgrade lên CRM button is visible');

    // Screenshot 1: Dashboard top + Row 2 + Sidebar Decor
    await page.screenshot({ path: path.join(OUT_DIR, '01_dashboard_top.png') });

    // Switch Spent Platform to Platform Positions & scroll down to Extra Details (Device Donut)
    await page.evaluate(() => {
      const btns = Array.from(document.querySelectorAll('button'));
      const detBtn = btns.find((b) => b.textContent?.includes('Details') && b.closest('.rounded-2xl')?.textContent?.includes('Spent Platform'));
      if (detBtn) detBtn.click();
    });
    await new Promise((r) => setTimeout(r, 250));
    await page.screenshot({ path: path.join(OUT_DIR, '02_dashboard_platform_positions_logos.png') });

    await page.evaluate(() => {
      const dev = document.querySelector('[data-testid="device-donut-card"]');
      dev?.scrollIntoView({ behavior: 'instant', block: 'center' });
    });
    await new Promise((r) => setTimeout(r, 250));
    await page.screenshot({ path: path.join(OUT_DIR, '03_dashboard_extra_device_donut.png') });

    // Verify DeviceDonutCard has slice % labels & device names
    const deviceText = await page.evaluate(() => document.querySelector('[data-testid="device-donut-card"]')?.textContent || '');
    assert(
      deviceText.includes('iPhone') && deviceText.includes('Android') && deviceText.includes('Desktop') && deviceText.includes('%'),
      'DeviceDonutCard renders iPhone/Android/Desktop labels and % values'
    );

    // 5. Open Slide-Over Entity Drawer by clicking Campaign Row
    await page.evaluate(() => {
      window.scrollTo({ top: document.documentElement.scrollHeight, behavior: 'instant' });
    });
    await new Promise((r) => setTimeout(r, 250));

    await page.evaluate(() => {
      const els = Array.from(document.querySelectorAll('td, div, span, button'));
      const campCell = els.find(
        (el) => el.childElementCount === 0 && el.textContent?.includes('[ECOLIFE] Lead Form Signature Q4')
      );
      if (!campCell) throw new Error('Campaign cell not found');
      campCell.click();
    });

    await page.waitForSelector('[data-testid="dom-meta-entity-modal"]', { timeout: 10000 });
    await page.waitForSelector('[data-testid="hourly-spend-result-chart"]', { timeout: 10000 });
    await new Promise((r) => setTimeout(r, 300));

    const drawerCheck = await page.evaluate(() => {
      const modalRoot = document.querySelector('[data-testid="dom-meta-entity-modal"]');
      const drawerPanel = modalRoot.lastElementChild;
      const backOverlay = document.querySelector('[data-testid="dom-meta-drawer-overlay-back"]');
      const dr = drawerPanel.getBoundingClientRect();
      const br = backOverlay.getBoundingClientRect();
      return {
        drawerLeft: Math.round(dr.left),
        drawerWidth: Math.round(dr.width),
        drawerHeight: Math.round(dr.height),
        overlayLeft: Math.round(br.left),
        overlayWidth: Math.round(br.width),
        overlayText: backOverlay.textContent?.trim(),
        bodyOverflow: getComputedStyle(document.body).overflow,
        htmlOverflow: getComputedStyle(document.documentElement).overflow,
      };
    });
    console.log('Drawer check (expanded sidebar):', drawerCheck);
    assert(
      Math.abs(drawerCheck.drawerLeft - 260) <= 2 && Math.abs(drawerCheck.drawerWidth - 1180) <= 2,
      'Drawer stretches right up to 260px sidebar on 1440px desktop (width = 1180px)',
      drawerCheck
    );
    assert(
      drawerCheck.overlayLeft === 0 && drawerCheck.overlayWidth === 260 && drawerCheck.overlayText?.includes('Quay lại'),
      'Left overlay renders Back button over sidebar area',
      drawerCheck
    );
    assert(
      drawerCheck.bodyOverflow === 'hidden' && drawerCheck.htmlOverflow === 'hidden',
      'Underlying html and body are scroll-locked when drawer is open',
      drawerCheck
    );

    // Screenshot 4: Drawer Top (Hero KPIs + Daily Trend + Video Funnel + Detail Cost per Result)
    await page.screenshot({ path: path.join(OUT_DIR, '04_drawer_top_overview.png') });

    // Check 24-Hour Spend & Result Chart single-row labels + 05:00 zero fake result!
    const hourlyAudit = await page.evaluate(() => {
      const card = document.querySelector('[data-testid="hourly-spend-result-chart"]');
      const texts = Array.from(card.querySelectorAll('svg text'))
        .filter((t) => /^\d{2}h$/.test(t.textContent?.trim() || ''))
        .map((t) => ({ label: t.textContent?.trim(), y: t.getAttribute('y') }));
      const uniqueYs = Array.from(new Set(texts.map((t) => t.y)));
      return { count: texts.length, uniqueYs, cardHeight: Math.round(card.getBoundingClientRect().height) };
    });
    console.log('Hourly chart audit:', hourlyAudit);
    assert(
      hourlyAudit.count === 24 && hourlyAudit.uniqueYs.length === 1,
      'All 24 hourly labels (00h..23h) render on a single horizontal axis line',
      hourlyAudit
    );

    // Hover 05h rect inside hourly chart to verify 0 LEAD (NOT 66 post_engagement!)
    await page.evaluate(() => {
      const card = document.querySelector('[data-testid="hourly-spend-result-chart"]');
      card.scrollIntoView({ behavior: 'instant', block: 'center' });
    });
    await new Promise((r) => setTimeout(r, 200));

    const hour05Pos = await page.evaluate(() => {
      const card = document.querySelector('[data-testid="hourly-spend-result-chart"]');
      const t05 = Array.from(card.querySelectorAll('svg text')).find((t) => t.textContent?.trim() === '05h');
      const r = t05.getBoundingClientRect();
      return { x: r.left + r.width / 2, y: r.top - 40 };
    });
    await page.mouse.move(hour05Pos.x, hour05Pos.y);
    await new Promise((r) => setTimeout(r, 150));
    const hour05Readout = await page.evaluate(
      () => document.querySelector('[data-testid="hourly-spend-result-chart"]')?.innerText || ''
    );
    console.log('Hour 05 readout:', hour05Readout.split('\n').slice(0, 6).join(' | '));
    assert(
      hour05Readout.includes('05:00 – 05:59') &&
        hour05Readout.includes('Result: 0') &&
        !hour05Readout.includes('Result: 66'),
      '05:00 slot with 0 leads + 66 post_engagement strictly shows Result: 0 (no fake results!)',
      hour05Readout
    );

    // Move hover to 20h peak hour for clean screenshot of Audiences & Targeting + 24h Chart + Frequency
    const hour20Pos = await page.evaluate(() => {
      const card = document.querySelector('[data-testid="hourly-spend-result-chart"]');
      const t20 = Array.from(card.querySelectorAll('svg text')).find((t) => t.textContent?.trim() === '20h');
      const r = t20.getBoundingClientRect();
      return { x: r.left + r.width / 2, y: r.top - 50 };
    });
    await page.mouse.move(hour20Pos.x, hour20Pos.y);
    await new Promise((r) => setTimeout(r, 200));
    await page.screenshot({ path: path.join(OUT_DIR, '05_drawer_targeting_and_24h_chart.png') });

    // Measure Drawer Row 4 & Row 5 heights at t1 vs t2 (+1500ms) to ensure ZERO runaway inside drawer too!
    const measureDrawerChartHeights = () =>
      page.evaluate(() => {
        const drawer = document.querySelector('[data-testid="dom-meta-entity-modal"]');
        const hrCard = drawer.querySelector('[data-testid="hourly-spend-result-chart"]');
        const devCard = drawer.querySelector('[data-testid="device-donut-card"]');
        return {
          hourlyH: hrCard ? Math.round(hrCard.getBoundingClientRect().height) : 0,
          deviceH: devCard ? Math.round(devCard.getBoundingClientRect().height) : 0,
          drawerScrollH: drawer.querySelector('.overflow-y-auto')?.scrollHeight || 0,
        };
      });

    const drH1 = await measureDrawerChartHeights();
    await new Promise((r) => setTimeout(r, 1500));
    const drH2 = await measureDrawerChartHeights();
    console.log('Drawer chart heights t1 vs t2:', { drH1, drH2 });
    assert(
      Math.abs(drH2.hourlyH - drH1.hourlyH) <= 1 &&
        Math.abs(drH2.deviceH - drH1.deviceH) <= 1 &&
        Math.abs(drH2.drawerScrollH - drH1.drawerScrollH) <= 2,
      'Drawer charts (Hourly + Row 5 Age/Device/Region) have ZERO vertical drift',
      { drH1, drH2 }
    );

    // Scroll inside drawer to Row 5 (Age & Gender + DeviceDonutCard + Top Regions)
    await page.evaluate(() => {
      const drawer = document.querySelector('[data-testid="dom-meta-entity-modal"]');
      const devCard = drawer.querySelector('[data-testid="device-donut-card"]');
      devCard?.scrollIntoView({ behavior: 'instant', block: 'center' });
    });
    await new Promise((r) => setTimeout(r, 250));
    await page.screenshot({ path: path.join(OUT_DIR, '06_drawer_row5_age_device_region_charts.png') });

    // Click Overlay Back button to close drawer & verify scroll unlock
    await page.click('[data-testid="dom-meta-drawer-overlay-back"]');
    await new Promise((r) => setTimeout(r, 250));
    const afterClose = await page.evaluate(() => ({
      modalGone: !document.querySelector('[data-testid="dom-meta-entity-modal"]'),
      bodyOverflow: getComputedStyle(document.body).overflow,
    }));
    assert(
      afterClose.modalGone && afterClose.bodyOverflow !== 'hidden',
      'Clicking overlay Back button closes drawer and unlocks body scroll',
      afterClose
    );

    // Collapse sidebar & verify drawer stretches to 72px collapsed sidebar (1368px wide)
    await page.click('[data-testid="sidebar-collapse-toggle"]');
    await new Promise((r) => setTimeout(r, 350));
    await page.evaluate(() => {
      const els = Array.from(document.querySelectorAll('td, div, span, button'));
      const campCell = els.find(
        (el) => el.childElementCount === 0 && el.textContent?.includes('[ECOLIFE] Lead Form Signature Q4')
      );
      campCell?.click();
    });
    await page.waitForSelector('[data-testid="dom-meta-entity-modal"]', { timeout: 10000 });
    await new Promise((r) => setTimeout(r, 450));
    const collapsedDrawer = await page.evaluate(() => {
      const r = document.querySelector('[data-testid="dom-meta-entity-modal"]').lastElementChild.getBoundingClientRect();
      return { left: Math.round(r.left), width: Math.round(r.width) };
    });
    assert(
      Math.abs(collapsedDrawer.left - 72) <= 2 && Math.abs(collapsedDrawer.width - 1368) <= 2,
      'When sidebar is collapsed (72px), drawer stretches to 1368px',
      collapsedDrawer
    );
    await page.click('[data-testid="dom-meta-drawer-overlay-back"]');
    await new Promise((r) => setTimeout(r, 250));
    // Expand sidebar back
    await page.click('[data-testid="sidebar-collapse-toggle"]');
    await new Promise((r) => setTimeout(r, 350));

    // 6. Open CRM Upgrade Showcase Modal & verify Tab 1 + Tab 2 (Pricing, Topup, 30-day shared trial)
    await page.click('[data-testid="open-crm-upgrade-modal"]');
    await page.waitForSelector('[data-testid="crm-upgrade-showcase-modal"]', { timeout: 8000 });
    await new Promise((r) => setTimeout(r, 350));
    await page.screenshot({ path: path.join(OUT_DIR, '07_crm_upgrade_modal_showcase.png') });

    await page.click('[data-testid="crm-upgrade-tab-pricing"]');
    await new Promise((r) => setTimeout(r, 300));
    const pricingText = await page.evaluate(
      () => document.querySelector('[data-testid="crm-upgrade-showcase-modal"]')?.innerText || ''
    );
    assert(
      (pricingText.includes('1.275.000') || pricingText.includes('1,275,000')) &&
        (pricingText.includes('2.550.000') || pricingText.includes('2,550,000')) &&
        pricingText.includes('Topup 6 Tháng') &&
        (pricingText.includes('30 ngày') || pricingText.includes('dùng thử chung')),
      'CRM Upgrade Pricing & Topup tab renders accurate annual -15% prices, Topup bonus packs, and shared trial',
      pricingText.slice(0, 400)
    );
    await page.screenshot({ path: path.join(OUT_DIR, '08_crm_upgrade_modal_pricing_topup.png') });

    // Close CRM modal via Escape
    await page.keyboard.press('Escape');
    await new Promise((r) => setTimeout(r, 250));

    // 7. Mobile Viewport (390x844) Audit
    await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 2 });
    await new Promise((r) => setTimeout(r, 400));
    const mobileMetrics = await page.evaluate(() => ({
      docScrollWidth: document.documentElement.scrollWidth,
    }));
    assert(mobileMetrics.docScrollWidth <= 392, 'Mobile 390px layout has no horizontal overflow', mobileMetrics);

    await page.evaluate(() => {
      const els = Array.from(document.querySelectorAll('td, div, span, button'));
      const campCell = els.find(
        (el) => el.childElementCount === 0 && el.textContent?.includes('[ECOLIFE] Lead Form Signature Q4')
      );
      campCell?.click();
    });
    await page.waitForSelector('[data-testid="dom-meta-entity-modal"]', { timeout: 8000 });
    await new Promise((r) => setTimeout(r, 300));
    const mobileDrawer = await page.evaluate(() => {
      const r = document.querySelector('[data-testid="dom-meta-entity-modal"]').lastElementChild.getBoundingClientRect();
      return { left: Math.round(r.left), width: Math.round(r.width) };
    });
    assert(
      Math.abs(mobileDrawer.left) <= 2 && Math.abs(mobileDrawer.width - 390) <= 2,
      'Mobile drawer uses full 390px viewport width cleanly',
      mobileDrawer
    );
    await page.screenshot({ path: path.join(OUT_DIR, '09_mobile_drawer.png') });

    assert(pageErrors.length === 0, 'Zero uncaught page runtime errors', pageErrors);

    console.log('\n=== ALL AUDIT ASSERTIONS PASSED ===');
    for (const a of assertions) console.log('  ✓', a);
  } finally {
    if (browser) await browser.close().catch(() => {});
    previewProc.kill('SIGTERM');
    if (process.platform === 'win32' && previewProc.pid) {
      spawn('taskkill', ['/pid', String(previewProc.pid), '/f', '/t']);
    }
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
