/**
 * =============================================================================
 * DOMATION GOOGLE ADS — UNIVERSAL MCC HUB APPS SCRIPT (v7.0)
 * -----------------------------------------------------------------------------
 * 1 SCRIPT DUY NHAT PHUC VU TOAN BO TAI KHOAN TRONG MCC (113-061-8835)
 * Khong can tao Google Sheet cho tung khach hang, truy van truc tiep Google Ads
 * REST API v23 kem xac thuc email chu tai khoan (customer_user_access) cho OTP.
 *
 * HUONG DAN CAP NHAT / DEPLOY (LAM DUNG 1 LAN):
 *   1. Mo du an Apps Script cua MCC DOMATION (dang dung cho EcoLife)
 *   2. Xoa code cu, dan toan bo file nay -> Ctrl+S
 *   3. Kiem tra tep appsscript.json co du 3 oauthScopes:
 *        - https://www.googleapis.com/auth/adwords
 *        - https://www.googleapis.com/auth/script.external_request
 *        - https://www.googleapis.com/auth/spreadsheets (tuy chon neu muon giu log)
 *   4. Bam Trien khai (Deploy) -> Quan ly cac ban trien khai (Manage deployments)
 *      -> Bam bieu tuong but chi (Edit) -> Phien ban: Phien ban moi (New version)
 *      -> Execute as: Me | Who has access: Anyone -> bam Trien khai (Deploy)
 *      (Giu nguyen URL .../exec cu, khong lam gian doan EcoLife!)
 *
 * API ENDPOINTS (GET):
 *   ?action=ping
 *   ?action=inspect_mcc_account&account_id=227-521-6666
 *   ?action=list_mcc_clients
 *   ?type=keywords&account_id=227-521-6666&campaignId=...&since=YYYY-MM-DD&until=YYYY-MM-DD
 *   ?account_id=227-521-6666&time_range={"since":"YYYY-MM-DD","until":"YYYY-MM-DD"}
 * =============================================================================
 */

const CONFIG = {
  DEVELOPER_TOKEN: "oBqM_GUwxCs4t-leZtW6pQ",
  LOGIN_CUSTOMER_ID: "113-061-8835",
  DEFAULT_DAYS: 14,
  // Tuy chon khoa bao mat chia se voi Backend data.domation.net (DOMATION_GOOGLE_ADS_MCC_SECRET)
  // De rong "" de tuong thich nguoc; dien chuoi bi mat de chan goi truc tiep tu ben ngoai.
  HUB_SECRET: "",
};

const GADS_API_BASE = "https://googleads.googleapis.com/v23";

// Anh xa ten goi nho legacy (CHI ap dung khi caller khong truyen 10 chu so Customer ID)
const LEGACY_ALIASES = {
  ecolifesignature: "295-339-0933",
  ideas: "227-521-6666",
  "1283070995510667": "367-797-3546",
  "676599667843841": "466-215-2707",
};

const HEADER_KEYS = [
  "date",
  "campaign",
  "campaign_id",
  "spent",
  "impression",
  "click",
  "ctr",
  "all_conversions",
  "directions",
  "calls",
  "menu",
  "orders",
  "other",
  "store_visits",
  "mobile",
  "desktop",
  "tablet",
  "hourly",
  "channels",
  "locations",
  "distances",
  "lead_forms",
];

// ═════════════════════════════════════════════════════════════════════════════
//  ROUTING & SECURITY HELPERS
// ═════════════════════════════════════════════════════════════════════════════

function _formatCustomerId(raw) {
  const digits = String(raw || "").replace(/\D/g, "");
  if (digits.length !== 10) return null;
  return digits.slice(0, 3) + "-" + digits.slice(3, 6) + "-" + digits.slice(6, 10);
}

/**
 * UU TIEN TUYET DOI 10 chu so Google Ads Customer ID (XXX-XXX-XXXX).
 * Khong bao gio ghi de theo customToken — tranh loi tra nham du lieu giua cac tai khoan MCC!
 */
function _resolveTargetAccount(rawAccountId) {
  const clean = String(rawAccountId || "").replace(/^act_/i, "").trim();
  if (!clean) return null;

  if (/^\d{3}-?\d{3}-?\d{4}$/.test(clean)) {
    const formatted = _formatCustomerId(clean);
    if (formatted) {
      return { customerId: formatted, digits: formatted.replace(/-/g, "") };
    }
  }

  const alias = LEGACY_ALIASES[clean.toLowerCase()];
  if (alias) {
    return { customerId: alias, digits: alias.replace(/-/g, "") };
  }

  return null;
}

function _verifyHubSecret(params) {
  if (!CONFIG.HUB_SECRET) return true;
  const provided = String((params && params.hub_secret) || "").trim();
  return provided === CONFIG.HUB_SECRET;
}

function _getApiHeaders(customToken, skipLoginCustomerId) {
  const token = String(customToken || "").trim() || CONFIG.DEVELOPER_TOKEN;
  const headers = {
    Authorization: "Bearer " + ScriptApp.getOAuthToken(),
    "developer-token": token,
    "Content-Type": "application/json",
  };
  if (!skipLoginCustomerId && CONFIG.LOGIN_CUSTOMER_ID) {
    headers["login-customer-id"] = CONFIG.LOGIN_CUSTOMER_ID.replace(/-/g, "");
  }
  return headers;
}

function _json(data) {
  return ContentService.createTextOutput(JSON.stringify(data)).setMimeType(
    ContentService.MimeType.JSON
  );
}

function _formatDate(date) {
  return (
    date.getFullYear() +
    "-" +
    ("0" + (date.getMonth() + 1)).slice(-2) +
    "-" +
    ("0" + date.getDate()).slice(-2)
  );
}

// ═════════════════════════════════════════════════════════════════════════════
//  ENTRY POINT (GET)
// ═════════════════════════════════════════════════════════════════════════════

function doGet(e) {
  const p = (e && e.parameter) || {};

  try {
    if (!_verifyHubSecret(p)) {
      return _json({ ok: false, error: "Unauthorized: Invalid MCC Hub secret." });
    }

    const action = String(p.action || "").trim().toLowerCase();
    const devToken = String(p.token || p.developer_token || CONFIG.DEVELOPER_TOKEN).trim();

    // 1. Health check
    if (action === "ping") {
      return _json({
        ok: true,
        version: "7.0-mcc-hub",
        mcc_id: CONFIG.LOGIN_CUSTOMER_ID,
        timestamp: new Date().toISOString(),
      });
    }

    // 2. List all sub-accounts under MCC (for Admin audit)
    if (action === "list_mcc_clients") {
      return _json(_listMccClients(devToken));
    }

    // Resolve target 10-digit Customer ID strictly
    const rawAccountId = p.account_id || p.customer_id || "";
    const target = _resolveTargetAccount(rawAccountId);
    if (!target) {
      return _json({
        ok: false,
        error:
          "Thiếu hoặc sai định dạng Google Ads Customer ID (cần 10 chữ số dạng XXX-XXX-XXXX, VD: 227-521-6666).",
      });
    }

    // 3. Inspect MCC link status + query customer_user_access emails for OTP verification
    if (action === "inspect_mcc_account" || action === "verify_mcc") {
      return _json(_inspectMccAccount(target.customerId, devToken));
    }

    // 4. Clear cache for this specific customerId if action=sync
    if (action === "sync") {
      _clearAccountCache(target.digits);
      return _json({
        ok: true,
        customer_id: target.customerId,
        syncedAt: new Date().toISOString(),
      });
    }

    // 5. Keywords & Search Terms on-demand
    if (String(p.type || "").toLowerCase() === "keywords") {
      return _getKeywordsResponse(p, target, devToken);
    }

    // 6. Default: Google Ads performance query (direct REST API v23, zero Sheet required)
    let sinceStr = "";
    let untilStr = "";
    if (p.time_range) {
      try {
        const r = JSON.parse(p.time_range);
        if (r.since) sinceStr = String(r.since).trim();
        if (r.until) untilStr = String(r.until).trim();
      } catch (_) {}
    }
    if (!sinceStr && p.since) sinceStr = String(p.since).trim();
    if (!untilStr && p.until) untilStr = String(p.until).trim();
    if (!sinceStr || !untilStr) {
      const today = new Date();
      untilStr = _formatDate(today);
      sinceStr = _formatDate(new Date(today.getTime() - CONFIG.DEFAULT_DAYS * 86400000));
    }

    const cacheKey = "gads7_" + target.digits + "_" + sinceStr + "_" + untilStr;
    if (String(p.nocache || "") !== "1") {
      try {
        const cached = CacheService.getScriptCache().get(cacheKey);
        if (cached) {
          return ContentService.createTextOutput(cached).setMimeType(ContentService.MimeType.JSON);
        }
      } catch (_) {}
    }

    const rows = _queryGoogleAdsDirect(target.customerId, sinceStr, untilStr, devToken);
    const nowIso = new Date().toISOString();
    const payloadObj = {
      ok: true,
      customer_id: target.customerId,
      h: HEADER_KEYS,
      d: rows,
      leadForms: [],
      syncedAt: nowIso,
      direct: true,
    };
    const jsonStr = JSON.stringify(payloadObj);
    try {
      if (jsonStr.length < 95000) {
        CacheService.getScriptCache().put(cacheKey, jsonStr, 1800);
      }
    } catch (_) {}
    return ContentService.createTextOutput(jsonStr).setMimeType(ContentService.MimeType.JSON);
  } catch (err) {
    return _json({
      ok: false,
      error: err && err.message ? err.message : String(err),
    });
  }
}

// ═════════════════════════════════════════════════════════════════════════════
//  MCC INSPECTION & OWNER EMAIL LOOKUP (FOR ZERO-TRUST OTP VERIFICATION)
// ═════════════════════════════════════════════════════════════════════════════

function _inspectMccAccount(customerIdStr, devToken) {
  const digits = customerIdStr.replace(/-/g, "");
  const url = GADS_API_BASE + "/customers/" + digits + "/googleAds:searchStream";
  let headers = _getApiHeaders(devToken, false);

  const qCustomer =
    "SELECT customer.id, customer.descriptive_name, customer.currency_code, customer.time_zone, customer.manager, customer.status FROM customer LIMIT 1";
  const qUsers =
    "SELECT customer_user_access.user_id, customer_user_access.email_address, customer_user_access.access_role FROM customer_user_access WHERE customer_user_access.access_role IN ('ADMIN', 'STANDARD')";

  let custResp = UrlFetchApp.fetch(url, {
    method: "post",
    headers: headers,
    payload: JSON.stringify({ query: qCustomer }),
    muteHttpExceptions: true,
  });

  // Fallback without login-customer-id in case the script owner has direct access
  if (custResp.getResponseCode() === 403 && headers["login-customer-id"]) {
    const directHeaders = _getApiHeaders(devToken, true);
    const retryResp = UrlFetchApp.fetch(url, {
      method: "post",
      headers: directHeaders,
      payload: JSON.stringify({ query: qCustomer }),
      muteHttpExceptions: true,
    });
    if (retryResp.getResponseCode() === 200) {
      headers = directHeaders;
      custResp = retryResp;
    }
  }

  const custCode = custResp.getResponseCode();
  if (custCode !== 200) {
    const snippet = String(custResp.getContentText() || "").slice(0, 350);
    return {
      ok: true,
      linked: false,
      status: "pending_mcc",
      customer_id: customerIdStr,
      mcc_id: CONFIG.LOGIN_CUSTOMER_ID,
      http_status: custCode,
      detail: snippet,
      message:
        "Tài khoản Google Ads " +
        customerIdStr +
        " chưa được liên kết hoặc chưa bấm Chấp nhận (Accept) lời mời vào MCC " +
        CONFIG.LOGIN_CUSTOMER_ID +
        ".",
    };
  }

  let accountName = "Google Ads " + customerIdStr;
  let currencyCode = "VND";
  let timeZone = "Asia/Ho_Chi_Minh";
  let isManager = false;
  let accountStatus = "ENABLED";

  try {
    const parsed = JSON.parse(custResp.getContentText() || "[]");
    const batches = Array.isArray(parsed) ? parsed : [parsed];
    for (let i = 0; i < batches.length; i++) {
      const results = (batches[i] && batches[i].results) || [];
      if (results.length > 0 && results[0].customer) {
        const c = results[0].customer;
        if (c.descriptiveName) accountName = String(c.descriptiveName).trim();
        if (c.currencyCode) currencyCode = String(c.currencyCode).trim();
        if (c.timeZone) timeZone = String(c.timeZone).trim();
        isManager = Boolean(c.manager);
        if (c.status) accountStatus = String(c.status);
        break;
      }
    }
  } catch (_) {}

  // Query customer_user_access to find real owner ADMIN emails for OTP verification
  const adminEmails = [];
  const standardEmails = [];
  let userAccessReadable = false;
  let userAccessNote = "";

  try {
    const userResp = UrlFetchApp.fetch(url, {
      method: "post",
      headers: headers,
      payload: JSON.stringify({ query: qUsers }),
      muteHttpExceptions: true,
    });
    if (userResp.getResponseCode() === 200) {
      userAccessReadable = true;
      const uParsed = JSON.parse(userResp.getContentText() || "[]");
      const uBatches = Array.isArray(uParsed) ? uParsed : [uParsed];
      const seenAdmin = {};
      const seenStd = {};
      for (let i = 0; i < uBatches.length; i++) {
        const rows = (uBatches[i] && uBatches[i].results) || [];
        for (let j = 0; j < rows.length; j++) {
          const cua = rows[j].customerUserAccess || {};
          const email = String(cua.emailAddress || "").trim().toLowerCase();
          const role = String(cua.accessRole || "").toUpperCase();
          if (!email || email.indexOf("@") === -1) continue;
          if (role === "ADMIN" && !seenAdmin[email]) {
            seenAdmin[email] = true;
            adminEmails.push(email);
          } else if (role === "STANDARD" && !seenStd[email]) {
            seenStd[email] = true;
            standardEmails.push(email);
          }
        }
      }
    } else {
      userAccessNote =
        "HTTP " +
        userResp.getResponseCode() +
        " (MCC không có quyền ADMIN trên tài khoản con để đọc danh sách user; fallback gửi OTP cho chủ MCC).";
    }
  } catch (uErr) {
    userAccessNote = uErr && uErr.message ? uErr.message : String(uErr);
  }

  return {
    ok: true,
    linked: true,
    status: "linked",
    customer_id: customerIdStr,
    mcc_id: CONFIG.LOGIN_CUSTOMER_ID,
    account_name: accountName,
    currency_code: currencyCode,
    time_zone: timeZone,
    is_manager: isManager,
    account_status: accountStatus,
    user_access_readable: userAccessReadable,
    admin_emails: adminEmails,
    standard_emails: standardEmails,
    user_access_note: userAccessNote || undefined,
  };
}

function _listMccClients(devToken) {
  const mccDigits = CONFIG.LOGIN_CUSTOMER_ID.replace(/-/g, "");
  const url = GADS_API_BASE + "/customers/" + mccDigits + "/googleAds:searchStream";
  const headers = _getApiHeaders(devToken, false);
  const query =
    "SELECT customer_client.id, customer_client.descriptive_name, customer_client.currency_code, customer_client.status, customer_client.manager, customer_client.level FROM customer_client WHERE customer_client.manager = FALSE ORDER BY customer_client.descriptive_name ASC LIMIT 500";
  const resp = UrlFetchApp.fetch(url, {
    method: "post",
    headers: headers,
    payload: JSON.stringify({ query: query }),
    muteHttpExceptions: true,
  });
  if (resp.getResponseCode() !== 200) {
    return {
      ok: false,
      error: "Không thể đọc danh sách tài khoản trong MCC (HTTP " + resp.getResponseCode() + ").",
      detail: String(resp.getContentText() || "").slice(0, 300),
    };
  }
  const clients = [];
  const parsed = JSON.parse(resp.getContentText() || "[]");
  const batches = Array.isArray(parsed) ? parsed : [parsed];
  batches.forEach(function (b) {
    (b.results || []).forEach(function (r) {
      const cc = r.customerClient || {};
      const cid = _formatCustomerId(cc.id);
      if (!cid) return;
      clients.push({
        customer_id: cid,
        name: String(cc.descriptiveName || cid),
        currency: String(cc.currencyCode || "VND"),
        status: String(cc.status || ""),
        level: Number(cc.level || 1),
      });
    });
  });
  return {
    ok: true,
    mcc_id: CONFIG.LOGIN_CUSTOMER_ID,
    total: clients.length,
    clients: clients,
  };
}

// ═════════════════════════════════════════════════════════════════════════════
//  GOOGLE ADS PERFORMANCE QUERY (22 COLUMNS INCL. LEAD_FORMS)
// ═════════════════════════════════════════════════════════════════════════════

function _queryGoogleAdsDirect(customerIdStr, since, until, devToken) {
  const customerId = customerIdStr.replace(/-/g, "");
  let headers = _getApiHeaders(devToken, false);
  const url = GADS_API_BASE + "/customers/" + customerId + "/googleAds:searchStream";

  const days = Math.max(1, Math.round((new Date(until) - new Date(since)) / 86400000) + 1);
  const LIM_BASE = Math.min(Math.max(days * 500, 5000), 20000);
  const LIM_HOURLY = Math.min(Math.max(days * 3000, 10000), 50000);
  const LIM_GEO = Math.min(Math.max(days * 1000, 10000), 50000);

  const qBase =
    "SELECT segments.date, campaign.name, campaign.id, segments.device, segments.ad_network_type, metrics.cost_micros, metrics.impressions, metrics.clicks, metrics.all_conversions FROM campaign WHERE segments.date BETWEEN '" +
    since +
    "' AND '" +
    until +
    "' AND campaign.status != REMOVED ORDER BY segments.date DESC LIMIT " +
    LIM_BASE;
  const qConv =
    "SELECT segments.date, campaign.name, segments.device, segments.conversion_action_category, segments.conversion_action_name, metrics.all_conversions FROM campaign WHERE segments.date BETWEEN '" +
    since +
    "' AND '" +
    until +
    "' AND campaign.status != REMOVED AND metrics.all_conversions > 0 ORDER BY segments.date DESC LIMIT " +
    LIM_BASE;
  const qHourly =
    "SELECT segments.date, campaign.name, segments.hour, metrics.cost_micros, metrics.impressions, metrics.clicks, metrics.all_conversions FROM campaign WHERE segments.date BETWEEN '" +
    since +
    "' AND '" +
    until +
    "' AND campaign.status != REMOVED ORDER BY segments.date DESC, segments.hour LIMIT " +
    LIM_HOURLY;
  const qHourlyConv =
    "SELECT segments.date, campaign.name, segments.hour, segments.conversion_action_category, segments.conversion_action_name, metrics.all_conversions FROM campaign WHERE segments.date BETWEEN '" +
    since +
    "' AND '" +
    until +
    "' AND campaign.status != REMOVED AND metrics.all_conversions > 0 ORDER BY segments.date DESC, segments.hour LIMIT " +
    LIM_HOURLY;
  const qLocations =
    "SELECT campaign.name, segments.date, segments.geo_target_city, segments.geo_target_region, geographic_view.country_criterion_id, geographic_view.location_type, metrics.impressions, metrics.clicks, metrics.all_conversions, metrics.cost_micros FROM geographic_view WHERE segments.date BETWEEN '" +
    since +
    "' AND '" +
    until +
    "' AND geographic_view.location_type = LOCATION_OF_PRESENCE ORDER BY metrics.impressions DESC LIMIT " +
    LIM_GEO;
  const qDistances =
    "SELECT campaign.name, segments.date, distance_view.distance_bucket, metrics.impressions, metrics.clicks, metrics.all_conversions, metrics.cost_micros FROM distance_view WHERE segments.date BETWEEN '" +
    since +
    "' AND '" +
    until +
    "' ORDER BY segments.date DESC LIMIT " +
    LIM_GEO;
  const qChanConv =
    "SELECT campaign.name, segments.date, segments.ad_network_type, segments.conversion_action_category, segments.conversion_action_name, metrics.all_conversions FROM campaign WHERE segments.date BETWEEN '" +
    since +
    "' AND '" +
    until +
    "' AND campaign.status != REMOVED AND metrics.all_conversions > 0 ORDER BY segments.date DESC LIMIT " +
    LIM_BASE;
  const qLocConv =
    "SELECT campaign.name, segments.date, segments.geo_target_city, segments.geo_target_region, geographic_view.country_criterion_id, segments.conversion_action_category, segments.conversion_action_name, metrics.all_conversions FROM geographic_view WHERE segments.date BETWEEN '" +
    since +
    "' AND '" +
    until +
    "' AND geographic_view.location_type = LOCATION_OF_PRESENCE AND metrics.all_conversions > 0 ORDER BY segments.date DESC LIMIT " +
    LIM_GEO;
  const qDistConv =
    "SELECT campaign.name, segments.date, distance_view.distance_bucket, segments.conversion_action_category, segments.conversion_action_name, metrics.all_conversions FROM distance_view WHERE segments.date BETWEEN '" +
    since +
    "' AND '" +
    until +
    "' AND metrics.all_conversions > 0 ORDER BY segments.date DESC LIMIT " +
    LIM_GEO;

  const mk = function (q, hdrs) {
    return {
      url: url,
      method: "post",
      headers: hdrs,
      payload: JSON.stringify({ query: q }),
      muteHttpExceptions: true,
    };
  };
  const queries = [
    qBase,
    qConv,
    qHourly,
    qHourlyConv,
    qLocations,
    qDistances,
    qChanConv,
    qLocConv,
    qDistConv,
  ];
  let responses = UrlFetchApp.fetchAll(
    queries.map(function (q) {
      return mk(q, headers);
    })
  );

  if (responses[0].getResponseCode() === 403 && headers["login-customer-id"]) {
    headers = _getApiHeaders(devToken, true);
    responses = UrlFetchApp.fetchAll(
      queries.map(function (q) {
        return mk(q, headers);
      })
    );
  }

  const baseData = _parseResponse(responses[0], "Base", false);
  if (!baseData) return [];
  const convData = _parseResponse(responses[1], "Conv", true) || [];
  const hourlyData = _parseResponse(responses[2], "Hourly", true) || [];
  const hourlyConvData = _parseResponse(responses[3], "HConv", true) || [];
  const locationsData = _parseResponse(responses[4], "Loc", true) || [];
  const distancesData = _parseResponse(responses[5], "Dist", true) || [];
  const channelConvData = _parseResponse(responses[6], "ChConv", true) || [];
  const locationConvData = _parseResponse(responses[7], "LocConv", true) || [];
  const distanceConvData = _parseResponse(responses[8], "DistConv", true) || [];

  const initDevice = function () {
    return {
      Impression: 0,
      Click: 0,
      "All Conversions": 0,
      "Lead Forms": 0,
      Directions: 0,
      Calls: 0,
      Menu: 0,
      Orders: 0,
      Other: 0,
      "Store Visits": 0,
      Spent: 0,
    };
  };
  const rowsMap = {};
  const CH_MAP = {
    SEARCH: "Search",
    SEARCH_PARTNERS: "Search Partners",
    CONTENT: "Display",
    YOUTUBE_SEARCH: "YouTube",
    YOUTUBE_WATCH: "YouTube",
    MIXED: "PMAX",
    GOOGLE_TV: "TV",
    UNKNOWN: "Unknown",
  };

  for (let bi = 0; bi < baseData.length; bi++) {
    const results = baseData[bi].results || [];
    for (let ri = 0; ri < results.length; ri++) {
      const r = results[ri];
      const seg = r.segments || {};
      const camp = r.campaign || {};
      const met = r.metrics || {};
      const key = (seg.date || "") + "|" + (camp.name || "");
      if (!rowsMap[key]) {
        rowsMap[key] = {
          date: seg.date || "",
          campaign: camp.name || "",
          campaignId: String(camp.id || ""),
          totals: {
            spent: 0,
            imp: 0,
            clicks: 0,
            cvs: 0,
            dir: 0,
            calls: 0,
            menu: 0,
            orders: 0,
            other: 0,
            visits: 0,
            lead_forms: 0,
          },
          devices: { MOBILE: initDevice(), DESKTOP: initDevice(), TABLET: initDevice() },
          hourly: {},
          channels: {},
          locations: {},
          distances: {},
        };
      }
      const spent = parseFloat(((met.costMicros || 0) / 1e6).toFixed(0));
      const imp = parseInt(met.impressions || 0, 10);
      const clicks = parseInt(met.clicks || 0, 10);
      const cvs = parseFloat((met.allConversions || 0).toFixed(2));
      rowsMap[key].totals.spent += spent;
      rowsMap[key].totals.imp += imp;
      rowsMap[key].totals.clicks += clicks;
      rowsMap[key].totals.cvs += cvs;
      if (["MOBILE", "DESKTOP", "TABLET"].indexOf(seg.device) !== -1) {
        rowsMap[key].devices[seg.device].Impression += imp;
        rowsMap[key].devices[seg.device].Click += clicks;
        rowsMap[key].devices[seg.device]["All Conversions"] += cvs;
        rowsMap[key].devices[seg.device].Spent += spent;
      }
      if (seg.adNetworkType) {
        const ch = CH_MAP[seg.adNetworkType] || seg.adNetworkType;
        if (!rowsMap[key].channels[ch]) {
          rowsMap[key].channels[ch] = {
            imp: 0,
            click: 0,
            conv: 0,
            cost: 0,
            visits: 0,
            dir: 0,
            calls: 0,
            menu: 0,
            orders: 0,
          };
        }
        rowsMap[key].channels[ch].imp += imp;
        rowsMap[key].channels[ch].click += clicks;
        rowsMap[key].channels[ch].conv += cvs;
        rowsMap[key].channels[ch].cost += spent;
      }
    }
  }

  const convTypeOf = function (seg) {
    const cat = String(seg.conversionActionCategory || "");
    const n = String(seg.conversionActionName || "").toLowerCase();
    if (cat === "STORE_VISIT") return "visits";
    if (
      cat === "SUBMIT_LEAD_FORM" ||
      cat === "QUALIFIED_LEAD" ||
      cat === "CONVERTED_LEAD" ||
      n.indexOf("lead") !== -1 ||
      n.indexOf("form") !== -1 ||
      n.indexOf("đăng ký") !== -1
    ) {
      return "lead_forms";
    }
    if (n.indexOf("direction") !== -1) return "dir";
    if (n.indexOf("call") !== -1 || cat === "PHONE_CALL_LEAD") return "calls";
    if (n.indexOf("menu") !== -1) return "menu";
    if (n.indexOf("order") !== -1 || cat === "PURCHASE") return "orders";
    if (n.indexOf("other engagement") !== -1) return "other";
    return null;
  };
  const DEV_KEY = {
    visits: "Store Visits",
    lead_forms: "Lead Forms",
    dir: "Directions",
    calls: "Calls",
    menu: "Menu",
    orders: "Orders",
    other: "Other",
  };

  convData.forEach(function (batch) {
    (batch.results || []).forEach(function (r) {
      const seg = r.segments || {};
      const key = seg.date + "|" + ((r.campaign || {}).name || "");
      if (!rowsMap[key]) return;
      const cvs = parseFloat(((r.metrics || {}).allConversions || 0).toFixed(2));
      const type = convTypeOf(seg);
      if (!type || !cvs) return;
      rowsMap[key].totals[type] += cvs;
      if (["MOBILE", "DESKTOP", "TABLET"].indexOf(seg.device) !== -1 && DEV_KEY[type]) {
        rowsMap[key].devices[seg.device][DEV_KEY[type]] += cvs;
      }
    });
  });

  hourlyData.forEach(function (batch) {
    (batch.results || []).forEach(function (r) {
      const seg = r.segments || {};
      const key = seg.date + "|" + ((r.campaign || {}).name || "");
      if (!rowsMap[key] || seg.hour == null) return;
      const h = String(seg.hour);
      if (!rowsMap[key].hourly[h]) {
        rowsMap[key].hourly[h] = {
          imp: 0,
          click: 0,
          spent: 0,
          conv: 0,
          visits: 0,
          dir: 0,
          calls: 0,
          menu: 0,
          orders: 0,
        };
      }
      rowsMap[key].hourly[h].imp += parseInt((r.metrics || {}).impressions || 0, 10);
      rowsMap[key].hourly[h].click += parseInt((r.metrics || {}).clicks || 0, 10);
      rowsMap[key].hourly[h].spent += parseFloat((((r.metrics || {}).costMicros || 0) / 1e6).toFixed(0));
      rowsMap[key].hourly[h].conv += parseFloat(((r.metrics || {}).allConversions || 0).toFixed(2));
    });
  });

  hourlyConvData.forEach(function (batch) {
    (batch.results || []).forEach(function (r) {
      const seg = r.segments || {};
      const key = seg.date + "|" + ((r.campaign || {}).name || "");
      if (!rowsMap[key] || seg.hour == null) return;
      const h = String(seg.hour);
      const cvs = parseFloat(((r.metrics || {}).allConversions || 0).toFixed(2));
      const type = convTypeOf(seg);
      if (!cvs || !type || type === "lead_forms" || type === "other") return;
      if (!rowsMap[key].hourly[h]) {
        rowsMap[key].hourly[h] = {
          imp: 0,
          click: 0,
          spent: 0,
          conv: 0,
          visits: 0,
          dir: 0,
          calls: 0,
          menu: 0,
          orders: 0,
        };
      }
      rowsMap[key].hourly[h][type] += cvs;
    });
  });

  const VN_LOC = {
    "2704": "Việt Nam (Tổng)",
    "9040331": "Hà Nội",
    "9040373": "TP. Hồ Chí Minh",
    "9040371": "Biên Hòa (Đồng Nai)",
    "9074086": "Từ Sơn (Bắc Ninh)",
    "1028509": "An Giang",
    "1028510": "Bà Rịa - Vũng Tàu",
    "1028511": "Bắc Giang",
    "1028512": "Bắc Kạn",
    "1028513": "Bạc Liêu",
    "1028514": "Bắc Ninh",
    "1028515": "Bến Tre",
    "1028516": "Bình Định",
    "1028517": "Bình Dương",
    "1028518": "Bình Phước",
    "1028519": "Bình Thuận",
    "1028520": "Cà Mau",
    "1028584": "Cần Thơ",
    "1028521": "Cao Bằng",
    "1028582": "Đà Nẵng",
    "1028522": "Đắk Lắk",
    "1028523": "Đắk Nông",
    "1028524": "Điện Biên",
    "1028525": "Đồng Nai",
    "1028526": "Đồng Tháp",
    "1028527": "Gia Lai",
    "1028528": "Hà Giang",
    "1028529": "Hà Nam",
    "1028580": "Hà Nội",
    "1028530": "Hà Tĩnh",
    "1028531": "Hải Dương",
    "1028583": "Hải Phòng",
    "1028532": "Hậu Giang",
    "1028533": "Hòa Bình",
    "1028534": "Hưng Yên",
    "1028535": "Lạng Sơn",
    "1028536": "Kiên Giang",
    "1028537": "Kon Tum",
    "1028538": "Lai Châu",
    "1028539": "Lâm Đồng",
    "1028540": "Nam Định",
    "1028541": "Nghệ An",
    "1028542": "Ninh Bình",
    "1028543": "Ninh Thuận",
    "1028544": "Phú Thọ",
    "1028545": "Phú Yên",
    "1028546": "Quảng Bình",
    "1028547": "Quảng Nam",
    "1028548": "Quảng Ngãi",
    "1028549": "Quảng Ninh",
    "1028550": "Quảng Trị",
    "1028551": "Sóc Trăng",
    "1028552": "Sơn La",
    "1028553": "Tây Ninh",
    "1028554": "Thái Bình",
    "1028555": "Thái Nguyên",
    "1028556": "Thanh Hóa",
    "1028557": "Thừa Thiên Huế",
    "1028558": "Tiền Giang",
    "1028581": "TP. Hồ Chí Minh",
    "1028559": "Trà Vinh",
    "1028560": "Tuyên Quang",
    "1028561": "Vĩnh Long",
    "1028562": "Vĩnh Phúc",
    "1028563": "Yên Bái",
    "1028570": "Long An",
  };
  const missingGeoIds = {};

  const geoKey = function (r) {
    const seg = r.segments || {};
    const gv = r.geographicView || {};
    const res = seg.geoTargetCity || seg.geoTargetRegion || "";
    return res ? res.split("/").pop() : String(gv.countryCriterionId || "unk");
  };

  locationsData.forEach(function (batch) {
    (batch.results || []).forEach(function (r) {
      const seg = r.segments || {};
      const key = seg.date + "|" + ((r.campaign || {}).name || "");
      if (!rowsMap[key]) return;
      const cid = geoKey(r);
      if (cid !== "unk" && !VN_LOC[cid]) missingGeoIds[cid] = true;
      const name = VN_LOC[cid] || "Loc_" + cid;
      if (!rowsMap[key].locations[cid]) {
        rowsMap[key].locations[cid] = {
          name: name,
          imp: 0,
          click: 0,
          conv: 0,
          cost: 0,
          visits: 0,
          dir: 0,
          calls: 0,
          menu: 0,
          orders: 0,
        };
      }
      rowsMap[key].locations[cid].imp += parseInt((r.metrics || {}).impressions || 0, 10);
      rowsMap[key].locations[cid].click += parseInt((r.metrics || {}).clicks || 0, 10);
      rowsMap[key].locations[cid].conv += parseFloat(((r.metrics || {}).allConversions || 0).toFixed(2));
      rowsMap[key].locations[cid].cost += parseFloat((((r.metrics || {}).costMicros || 0) / 1e6).toFixed(0));
    });
  });

  locationConvData.forEach(function (batch) {
    (batch.results || []).forEach(function (r) {
      const seg = r.segments || {};
      const key = seg.date + "|" + ((r.campaign || {}).name || "");
      if (!rowsMap[key]) return;
      const cid = geoKey(r);
      if (!rowsMap[key].locations[cid]) return;
      const cvs = parseFloat(((r.metrics || {}).allConversions || 0).toFixed(2));
      const type = convTypeOf(seg);
      if (!cvs || !type || type === "lead_forms" || type === "other") return;
      rowsMap[key].locations[cid][type] += cvs;
    });
  });

  distancesData.forEach(function (batch) {
    (batch.results || []).forEach(function (r) {
      const seg = r.segments || {};
      const key = seg.date + "|" + ((r.campaign || {}).name || "");
      if (!rowsMap[key]) return;
      const bk = (r.distanceView || {}).distanceBucket || "UNKNOWN";
      if (!rowsMap[key].distances[bk]) {
        rowsMap[key].distances[bk] = {
          imp: 0,
          click: 0,
          conv: 0,
          cost: 0,
          visits: 0,
          dir: 0,
          calls: 0,
          menu: 0,
          orders: 0,
        };
      }
      rowsMap[key].distances[bk].imp += parseInt((r.metrics || {}).impressions || 0, 10);
      rowsMap[key].distances[bk].click += parseInt((r.metrics || {}).clicks || 0, 10);
      rowsMap[key].distances[bk].conv += parseFloat(((r.metrics || {}).allConversions || 0).toFixed(2));
      rowsMap[key].distances[bk].cost += parseFloat((((r.metrics || {}).costMicros || 0) / 1e6).toFixed(0));
    });
  });

  channelConvData.forEach(function (batch) {
    (batch.results || []).forEach(function (r) {
      const seg = r.segments || {};
      const key = seg.date + "|" + ((r.campaign || {}).name || "");
      if (!rowsMap[key]) return;
      const ch = CH_MAP[seg.adNetworkType] || seg.adNetworkType || "Other";
      if (!rowsMap[key].channels[ch]) return;
      const cvs = parseFloat(((r.metrics || {}).allConversions || 0).toFixed(2));
      const type = convTypeOf(seg);
      if (!cvs || !type || type === "lead_forms" || type === "other") return;
      rowsMap[key].channels[ch][type] += cvs;
    });
  });

  distanceConvData.forEach(function (batch) {
    (batch.results || []).forEach(function (r) {
      const seg = r.segments || {};
      const key = seg.date + "|" + ((r.campaign || {}).name || "");
      if (!rowsMap[key]) return;
      const bk = (r.distanceView || {}).distanceBucket || "UNKNOWN";
      if (!rowsMap[key].distances[bk]) return;
      const cvs = parseFloat(((r.metrics || {}).allConversions || 0).toFixed(2));
      const type = convTypeOf(seg);
      if (!cvs || !type || type === "lead_forms" || type === "other") return;
      rowsMap[key].distances[bk][type] += cvs;
    });
  });

  // Auto geo lookup for unknown Geo IDs
  const missingList = Object.keys(missingGeoIds).filter(function (id) {
    return /^\d+$/.test(id);
  });
  if (missingList.length > 0) {
    const idsStr = missingList.slice(0, 500).join(",");
    try {
      const geoResp = UrlFetchApp.fetch(url, {
        method: "post",
        headers: headers,
        payload: JSON.stringify({
          query:
            "SELECT geo_target_constant.id, geo_target_constant.name FROM geo_target_constant WHERE geo_target_constant.id IN (" +
            idsStr +
            ")",
        }),
        muteHttpExceptions: true,
      });
      if (geoResp.getResponseCode() === 200) {
        const geoData = JSON.parse(geoResp.getContentText() || "[]");
        (Array.isArray(geoData) ? geoData : [geoData]).forEach(function (batch) {
          (batch.results || []).forEach(function (r) {
            if (r.geoTargetConstant && r.geoTargetConstant.id && r.geoTargetConstant.name) {
              VN_LOC[String(r.geoTargetConstant.id)] = String(r.geoTargetConstant.name);
            }
          });
        });
        Object.keys(rowsMap).forEach(function (k) {
          const locs = rowsMap[k].locations;
          Object.keys(locs).forEach(function (cid) {
            if (VN_LOC[cid]) locs[cid].name = VN_LOC[cid];
          });
        });
      }
    } catch (_) {}
  }

  const DIST_ORDER = [
    "WITHIN_700M",
    "WITHIN_1KM",
    "WITHIN_5KM",
    "WITHIN_10KM",
    "WITHIN_15KM",
    "WITHIN_20KM",
    "WITHIN_25KM",
    "WITHIN_30KM",
    "WITHIN_35KM",
    "WITHIN_40KM",
    "WITHIN_45KM",
    "WITHIN_50KM",
    "WITHIN_55KM",
    "WITHIN_60KM",
    "WITHIN_65KM",
    "BEYOND_65KM",
  ];

  return Object.keys(rowsMap)
    .map(function (k) {
      return rowsMap[k];
    })
    .sort(function (a, b) {
      return b.date.localeCompare(a.date);
    })
    .map(function (row) {
      const t = row.totals;
      const ctr = t.imp > 0 ? parseFloat(((t.clicks / t.imp) * 100).toFixed(4)) : 0;
      const hourlyArr = Object.keys(row.hourly)
        .sort(function (a, b) {
          return parseInt(a, 10) - parseInt(b, 10);
        })
        .map(function (h) {
          return Object.assign({ h: parseInt(h, 10) }, row.hourly[h]);
        });
      const channelsArr = Object.keys(row.channels)
        .map(function (ch) {
          return Object.assign({ ch: ch }, row.channels[ch]);
        })
        .sort(function (a, b) {
          return b.imp - a.imp;
        });
      const locationsArr = Object.keys(row.locations)
        .map(function (k) {
          return row.locations[k];
        })
        .sort(function (a, b) {
          return b.imp - a.imp;
        })
        .slice(0, 15);
      const distancesArr = DIST_ORDER.filter(function (d) {
        return Boolean(row.distances[d]);
      }).map(function (d) {
        return Object.assign({ d: d }, row.distances[d]);
      });
      Object.keys(row.distances).forEach(function (d) {
        if (DIST_ORDER.indexOf(d) === -1) {
          distancesArr.push(Object.assign({ d: d }, row.distances[d]));
        }
      });

      return [
        row.date,
        row.campaign,
        row.campaignId,
        t.spent,
        t.imp,
        t.clicks,
        ctr,
        t.cvs,
        t.dir,
        t.calls,
        t.menu,
        t.orders,
        t.other,
        t.visits,
        JSON.stringify(row.devices.MOBILE),
        JSON.stringify(row.devices.DESKTOP),
        JSON.stringify(row.devices.TABLET),
        JSON.stringify(hourlyArr),
        JSON.stringify(channelsArr),
        JSON.stringify(locationsArr),
        JSON.stringify(distancesArr),
        t.lead_forms,
      ];
    });
}

// ═════════════════════════════════════════════════════════════════════════════
//  KEYWORDS & SEARCH TERMS ON-DEMAND (SCOPED BY CUSTOMER ID)
// ═════════════════════════════════════════════════════════════════════════════

function _getKeywordsResponse(params, target, devToken) {
  const campaignId = String(params.campaignId || "").trim();
  const campaignName = String(params.campaignName || "").trim();
  const since = String(params.since || "").trim();
  const until = String(params.until || "").trim();
  if ((!campaignId && !campaignName) || !since || !until) {
    return _json({ ok: false, error: "Missing params (campaignId/campaignName, since, until)" });
  }

  const cacheKey = "kw7_" + target.digits + "_" + (campaignId || campaignName) + "_" + since + "_" + until;
  try {
    const cached = CacheService.getScriptCache().get(cacheKey);
    if (cached) {
      return ContentService.createTextOutput(cached).setMimeType(ContentService.MimeType.JSON);
    }
  } catch (_) {}

  try {
    let headers = _getApiHeaders(devToken, false);
    const url = GADS_API_BASE + "/customers/" + target.digits + "/googleAds:searchStream";
    const campFilter = campaignId
      ? "WHERE campaign.id = " + campaignId.replace(/\D/g, "")
      : "WHERE campaign.name = '" + campaignName.replace(/'/g, "\\'") + "'";

    let typeResp = UrlFetchApp.fetch(url, {
      method: "post",
      headers: headers,
      payload: JSON.stringify({
        query:
          "SELECT campaign.id, campaign.name, campaign.advertising_channel_type, campaign.advertising_channel_sub_type FROM campaign " +
          campFilter +
          " LIMIT 1",
      }),
      muteHttpExceptions: true,
    });
    if (typeResp.getResponseCode() === 403 && headers["login-customer-id"]) {
      headers = _getApiHeaders(devToken, true);
      typeResp = UrlFetchApp.fetch(url, {
        method: "post",
        headers: headers,
        payload: JSON.stringify({
          query:
            "SELECT campaign.id, campaign.name, campaign.advertising_channel_type, campaign.advertising_channel_sub_type FROM campaign " +
            campFilter +
            " LIMIT 1",
        }),
        muteHttpExceptions: true,
      });
    }
    if (typeResp.getResponseCode() !== 200) {
      return _json({ ok: false, error: "Google Ads API Error " + typeResp.getResponseCode() });
    }
    const parsedType = JSON.parse(typeResp.getContentText() || "[]");
    const firstBatch = Array.isArray(parsedType) ? parsedType[0] : parsedType;
    const firstRow = firstBatch && firstBatch.results ? firstBatch.results[0] : null;
    if (!firstRow || !firstRow.campaign) {
      return _json({ ok: false, error: "Campaign not found" });
    }

    const campType = firstRow.campaign.advertisingChannelType || "SEARCH";
    const campSubType = firstRow.campaign.advertisingChannelSubType || "";
    const resolvedId = firstRow.campaign.id;
    const resolvedName = firstRow.campaign.name;
    const isPMAX = campType === "PERFORMANCE_MAX";
    const isSmart = campSubType === "SEARCH_EXPRESS" || campType === "SMART";

    const keywords = [];
    let searchTerms = [];

    if (isSmart) {
      const r = UrlFetchApp.fetch(url, {
        method: "post",
        headers: headers,
        payload: JSON.stringify({
          query:
            "SELECT smart_campaign_search_term_view.search_term, metrics.clicks, metrics.impressions, metrics.cost_micros FROM smart_campaign_search_term_view WHERE segments.date BETWEEN '" +
            since +
            "' AND '" +
            until +
            "' AND campaign.id = " +
            resolvedId +
            " ORDER BY metrics.impressions DESC LIMIT 150",
        }),
        muteHttpExceptions: true,
      });
      if (r.getResponseCode() === 200) {
        const termMap = {};
        const arr = _safeParseArray(r.getContentText());
        arr.forEach(function (b) {
          (b.results || []).forEach(function (rv) {
            const t = rv.smartCampaignSearchTermView && rv.smartCampaignSearchTermView.searchTerm;
            if (!t) return;
            if (!termMap[t]) termMap[t] = { imp: 0, click: 0, cost: 0 };
            termMap[t].imp += parseInt((rv.metrics || {}).impressions || 0, 10);
            termMap[t].click += parseInt((rv.metrics || {}).clicks || 0, 10);
            termMap[t].cost += parseFloat((((rv.metrics || {}).costMicros || 0) / 1e6).toFixed(0));
          });
        });
        searchTerms = Object.keys(termMap)
          .sort(function (a, b) {
            return termMap[b].imp - termMap[a].imp;
          })
          .slice(0, 50)
          .map(function (term) {
            return Object.assign({ term: term, status: "SMART", category: "", conv: 0 }, termMap[term]);
          });
      }
    } else if (isPMAX) {
      const r = UrlFetchApp.fetch(url, {
        method: "post",
        headers: headers,
        payload: JSON.stringify({
          query:
            "SELECT search_term_insight.search_term, campaign_search_term_insight.category_label, campaign_search_term_insight.id, metrics.clicks, metrics.impressions, metrics.all_conversions, metrics.cost_micros FROM campaign_search_term_insight WHERE campaign_search_term_insight.campaign_id = '" +
            resolvedId +
            "' ORDER BY metrics.impressions DESC LIMIT 50",
        }),
        muteHttpExceptions: true,
      });
      if (r.getResponseCode() === 200) {
        _safeParseArray(r.getContentText()).forEach(function (b) {
          (b.results || []).forEach(function (row) {
            const sti = row.searchTermInsight || {};
            const csti = row.campaignSearchTermInsight || {};
            const term = sti.searchTerm || csti.categoryLabel;
            if (term) {
              searchTerms.push({
                term: term,
                category: csti.categoryLabel !== term ? csti.categoryLabel || "" : "",
                id: csti.id || "",
                status: "PMAX_INSIGHT",
                imp: parseInt((row.metrics || {}).impressions || 0, 10),
                click: parseInt((row.metrics || {}).clicks || 0, 10),
                conv: parseFloat(((row.metrics || {}).allConversions || 0).toFixed(2)),
                cost: parseFloat((((row.metrics || {}).costMicros || 0) / 1e6).toFixed(0)),
              });
            }
          });
        });
      }
    } else {
      const rs = UrlFetchApp.fetchAll([
        {
          url: url,
          method: "post",
          headers: headers,
          payload: JSON.stringify({
            query:
              "SELECT ad_group_criterion.keyword.text, ad_group_criterion.keyword.match_type, ad_group.name, metrics.impressions, metrics.clicks, metrics.all_conversions, metrics.cost_micros, metrics.search_impression_share FROM keyword_view WHERE segments.date BETWEEN '" +
              since +
              "' AND '" +
              until +
              "' AND campaign.id = " +
              resolvedId +
              " AND ad_group_criterion.status != REMOVED ORDER BY metrics.impressions DESC LIMIT 50",
          }),
          muteHttpExceptions: true,
        },
        {
          url: url,
          method: "post",
          headers: headers,
          payload: JSON.stringify({
            query:
              "SELECT search_term_view.search_term, search_term_view.status, metrics.impressions, metrics.clicks, metrics.all_conversions, metrics.cost_micros FROM search_term_view WHERE segments.date BETWEEN '" +
              since +
              "' AND '" +
              until +
              "' AND campaign.id = " +
              resolvedId +
              " ORDER BY metrics.impressions DESC LIMIT 50",
          }),
          muteHttpExceptions: true,
        },
      ]);
      if (rs[0].getResponseCode() === 200) {
        _safeParseArray(rs[0].getContentText()).forEach(function (b) {
          (b.results || []).forEach(function (row) {
            const kw = (row.adGroupCriterion && row.adGroupCriterion.keyword) || {};
            keywords.push({
              keyword: kw.text || "(unknown)",
              matchType: kw.matchType || "",
              adGroup: (row.adGroup && row.adGroup.name) || "",
              imp: parseInt((row.metrics || {}).impressions || 0, 10),
              click: parseInt((row.metrics || {}).clicks || 0, 10),
              conv: parseFloat(((row.metrics || {}).allConversions || 0).toFixed(2)),
              cost: parseFloat((((row.metrics || {}).costMicros || 0) / 1e6).toFixed(0)),
              impShare:
                row.metrics && row.metrics.searchImpressionShare
                  ? parseFloat((row.metrics.searchImpressionShare * 100).toFixed(1))
                  : null,
            });
          });
        });
      }
      if (rs[1].getResponseCode() === 200) {
        _safeParseArray(rs[1].getContentText()).forEach(function (b) {
          (b.results || []).forEach(function (row) {
            const stv = row.searchTermView || {};
            searchTerms.push({
              term: stv.searchTerm || "",
              status: stv.status || "",
              imp: parseInt((row.metrics || {}).impressions || 0, 10),
              click: parseInt((row.metrics || {}).clicks || 0, 10),
              conv: parseFloat(((row.metrics || {}).allConversions || 0).toFixed(2)),
              cost: parseFloat((((row.metrics || {}).costMicros || 0) / 1e6).toFixed(0)),
            });
          });
        });
      }
    }

    const resultStr = JSON.stringify({
      ok: true,
      customer_id: target.customerId,
      keywords: keywords,
      searchTerms: searchTerms,
      since: since,
      until: until,
      campaignId: resolvedId,
      campaignName: resolvedName,
      campType: campType,
      campSubType: campSubType,
      isPMAX: isPMAX,
      isSmart: isSmart,
    });
    try {
      if (resultStr.length < 95000) CacheService.getScriptCache().put(cacheKey, resultStr, 3600);
    } catch (_) {}
    return ContentService.createTextOutput(resultStr).setMimeType(ContentService.MimeType.JSON);
  } catch (err) {
    return _json({ ok: false, error: err && err.message ? err.message : String(err) });
  }
}

function _parseResponse(resp, label, optional) {
  const code = resp.getResponseCode();
  if (code !== 200) {
    const msg = String(resp.getContentText() || "").substring(0, 400);
    if (optional) {
      console.warn("⚠️ " + label + " skipped (" + code + "): " + msg);
      return null;
    }
    throw new Error(label + " API Error " + code + ": " + msg);
  }
  return _safeParseArray(resp.getContentText());
}

function _safeParseArray(rawText) {
  const text = String(rawText || "").trim();
  if (!text || text === "[]") return [];
  try {
    const parsed = JSON.parse(text);
    return Array.isArray(parsed) ? parsed : [parsed];
  } catch (_) {
    return [];
  }
}

function _clearAccountCache(digits) {
  try {
    const cache = CacheService.getScriptCache();
    const today = new Date();
    const ranges = [1, 7, 14, 30, 60, 90];
    const until = _formatDate(today);
    ranges.forEach(function (d) {
      const since = _formatDate(new Date(today.getTime() - d * 86400000));
      cache.remove("gads7_" + digits + "_" + since + "_" + until);
    });
  } catch (_) {}
}

function testInspectIdeasAndEcoLife() {
  console.log("EcoLife:", JSON.stringify(_inspectMccAccount("295-339-0933")));
  console.log("IDEAS:", JSON.stringify(_inspectMccAccount("227-521-6666")));
}
