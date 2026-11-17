/**
 * =============================================================================
 * DOMATION MASTER HUB — Google Apps Script All-in-One (v3.1)
 * Spreadsheet ID: 1FiCtjay20ZhIg4t4DHs3ONucrmjg4Ah5MBeofjxvV-A
 * -----------------------------------------------------------------------------
 * NHIEM VU HOP NHAT TOAN HE SINH THAI DOMATION:
 *  1. Thu thap TAT CA form tu van / bao gia / demo tren domation.net & data.domation.net
 *     (ContactModal, /automation, /crm, /meta-ad-report, /web-design, /erp, /ideas, /boost, /portfolio)
 *  2. Tu dong gui Email Cam On ca nhan hoa cho Khach hang + Email Canh Bao cho Admin
 *  3. Ghi nhan & gui Email vong doi SaaS AutoData:
 *     - Dang ky Workspace & kich hoat Dung thu (Trial)
 *     - Nap vi Topup (tao lenh cho chuyen khoan, duyet, tu choi)
 *     - Dang ky goi / Gia han / Tu dong gia han bang Vi / Nang step / Admin cap phat
 *     - Yeu cau & kich hoat nang cap lien mach DOMATION CRM 360 & ERP 5.0
 *     - Canh bao sap het han (3 ngay / 1 ngay) & Thong bao tam ngung bao toan du lieu
 *
 * HUONG DAN CAI DAT NHANH (3 BUOC):
 *  Buoc 1: Mo Google Sheet ID 1FiCtjay20ZhIg4t4DHs3ONucrmjg4Ah5MBeofjxvV-A
 *          -> Tien ich mo rong (Extensions) -> Apps Script -> Xoa code cu, dan toan bo file nay -> Ctrl+S
 *  Buoc 2: Chon ham `setupAllTabs` o thanh tren -> Bam Run (Chay) 1 lan de cap quyen Gmail/Sheets
 *          va khoi tao san 6 tab Sheets dep mat + tab Cau_Hinh_Mail.
 *  Buoc 3: Bam Trien khai (Deploy) -> Tuy chon trien khai moi (New deployment)
 *          - Loai: Ung dung web (Web app)
 *          - Thuc thi duoi dang (Execute as): Toi (Me)
 *          - Ai co quyen truy cap (Who has access): Bat ky ai (Anyone)  <-- BAT BUOC
 *          -> Copy link ".../exec" dan vao SuperAdmin DOMATION hoac bien DOMATION_MASTER_APPSCRIPT_URL.
 * =============================================================================
 */

var SPREADSHEET_ID = "1FiCtjay20ZhIg4t4DHs3ONucrmjg4Ah5MBeofjxvV-A";

// Tuy chon bao mat: Dat chuoi bi mat khop voi DOMATION_MASTER_APPSCRIPT_SECRET tren server
// (De rong "" neu muon ket noi nhanh khong can khoa chia se)
var SECRET_KEY = "";

// Neu = true, form tu van gui truc tiep khong qua backend cung bat buoc phai co `secret`.
// Khuyen nghi giu false de an toan neu dung fallback client, hoac bat true khi tat ca form di qua data.domation.net.
var REQUIRE_SECRET_FOR_PUBLIC_CONSULT = false;

var TABS = {
  DASHBOARD: "Tong_Quan",
  CONSULTATIONS: "Tu_Van_Form",
  WORKSPACES: "Dang_Ky_Workspace",
  BILLING: "Dang_Ky_Goi_Gia_Han",
  EMAIL_LOGS: "Lich_Su_Email",
  CONFIG: "Cau_Hinh_Mail"
};

var TAB_SCHEMAS = {};

TAB_SCHEMAS[TABS.CONSULTATIONS] = {
  color: "#1E40FF",
  headers: [
    "Ma Lead",
    "Thoi gian gui",
    "Nguon Form / Trang",
    "Ho va ten",
    "Email",
    "So dien thoai / Zalo",
    "Doanh nghiep / Website",
    "Giai phap quan tam",
    "Quy mo / Ngan sach / Volume",
    "Chi tiet nhu cau / Add-ons",
    "UTM Tracking",
    "Page URL",
    "Mail Cam On",
    "Sale phu trach",
    "Trang thai CSKH",
    "Payload JSON"
  ]
};

TAB_SCHEMAS[TABS.WORKSPACES] = {
  color: "#0284C7",
  headers: [
    "Thoi gian DK",
    "Tenant Slug",
    "Ten Doanh Nghiep",
    "Nganh hang",
    "Ho ten Admin",
    "Email Admin",
    "So dien thoai",
    "Goi khoi tao",
    "Han Trial",
    "Phuong thuc tao",
    "Tenant ID",
    "Mail Chao Mung",
    "Ghi chu van hanh",
    "Payload JSON"
  ]
};

TAB_SCHEMAS[TABS.BILLING] = {
  color: "#059669",
  headers: [
    "Thoi gian",
    "Ma Tham Chieu",
    "Loai Su Kien",
    "Trang thai GD",
    "Tenant Slug",
    "Ten Doanh Nghiep",
    "Email Admin",
    "So dien thoai",
    "Ma Goi / Suite",
    "Chu ky",
    "Thang / Ngay cong",
    "So Tien (VND)",
    "Bonus / Giam (%)",
    "Phuong thuc TT",
    "Han moi / So du vi",
    "Trang thai Mail",
    "Ghi chu / Nguoi duyet",
    "Payload JSON"
  ]
};

TAB_SCHEMAS[TABS.EMAIL_LOGS] = {
  color: "#6366F1",
  headers: [
    "Thoi gian",
    "Su kien nguon",
    "Loai Email (Category)",
    "Vai tro",
    "Nguoi nhan (To)",
    "CC / Reply-To",
    "Tieu de Email",
    "Trang thai",
    "Quota con lai",
    "Ghi chu / Loi"
  ]
};

TAB_SCHEMAS[TABS.CONFIG] = {
  color: "#334155",
  headers: ["Khoa Cau Hinh", "Gia Tri (Chinh sua truc tiep tai day)", "Mo Ta"]
};

var DEFAULT_CONFIG_ROWS = [
  ["BRAND_NAME", "DOMATION Enterprise", "Ten thuong hieu hien thi trong tieu de & chan Email"],
  ["SENDER_NAME", "DOMATION Enterprise Solutions", "Ten nguoi gui (Display Name) trong hop thu khach"],
  ["REPLY_TO_EMAIL", "domation.net@gmail.com", "Email nhan phan hoi khi khach bam Reply"],
  ["ADMIN_NOTIFY_EMAILS", "domation.net@gmail.com", "Email Admin nhan thong bao Lead & Giao dich (ngan cach boi dau phay)"],
  ["SEND_CUSTOMER_THANK_YOU", "TRUE", "TRUE = Tu dong gui mail cam on cho khach dien form tu van"],
  ["SEND_ADMIN_ALERT", "TRUE", "TRUE = Gui mail bao Admin khi co Lead / Dang ky / Giao dich moi"],
  ["SEND_BILLING_CUSTOMER_EMAIL", "TRUE", "TRUE = Gui mail chao mung, nap vi, hoa don gia han & nang cap cho khach"],
  ["SEND_EXPIRY_WARNING_EMAIL", "TRUE", "TRUE = Gui mail nhac sap het han Trial/Goi & thong bao tam ngung"],
  ["HOTLINE_ZALO", "0378.859.736", "So Hotline / Zalo tu van hien thi trong Email"],
  ["ZALO_OA_LINK", "https://zalo.me/0378859736", "Link chat Zalo truc tiep gan vao nut CTA Email"],
  ["FACEBOOK_URL", "https://www.facebook.com/domation.net/", "Link Fanpage Facebook chinh thuc DOMATION"],
  ["PORTAL_URL", "https://data.domation.net/data", "Link dang nhap Workspace AutoData"],
  ["DEFAULT_BANK_INFO", "MB Bank | STK & Noi dung hien thi tu dong theo he thong", "Thong tin ngan hang mac dinh neu server khong truyen sang"],
  ["SIGNATURE_NOTE", "Đội ngũ Kiến trúc Giải pháp & Chuyển đổi số DOMATION.NET", "Chu ky cuoi moi Email"]
];

/* ============================================================================
 * PUBLIC ENTRYPOINTS (WEB APP + MANUAL SETUP)
 * ========================================================================== */

/**
 * Chay ham nay 1 lan trong Apps Script Editor de khoi tao san 6 tab & dashboard KPI.
 */
function setupAllTabs() {
  var ss = getTargetSpreadsheet();
  ensureAllTabs(ss);
  Logger.log("Khoi tao hoan tat 6 tab tren Spreadsheet: " + ss.getName() + " (" + ss.getUrl() + ")");
  return {
    ok: true,
    spreadsheet_name: ss.getName(),
    spreadsheet_url: ss.getUrl(),
    tabs: Object.keys(TABS).map(function(k) { return TABS[k]; })
  };
}

/**
 * Ham Test nhanh trong Apps Script Editor (khong spam mail khach that).
 */
function testSetupOnly() {
  var res = setupAllTabs();
  Logger.log(JSON.stringify(res));
}

function doGet(e) {
  try {
    var ss = getTargetSpreadsheet();
    var sheetNames = ss.getSheets().map(function(s) { return s.getName(); });
    var quota = -1;
    try { quota = MailApp.getRemainingDailyQuota(); } catch (qErr) {}

    return jsonResponse({
      ok: true,
      service: "DOMATION Master Consultation, Billing & Mail Hub",
      version: "3.1.0",
      spreadsheet_id: ss.getId(),
      spreadsheet_name: ss.getName(),
      existing_tabs: sheetNames,
      expected_tabs: Object.keys(TABS).map(function(k) { return TABS[k]; }),
      remaining_daily_quota: quota,
      requires_secret: Boolean(SECRET_KEY)
    });
  } catch (err) {
    return jsonResponse({
      ok: false,
      error: formatError(err)
    });
  }
}

function doPost(e) {
  var lock = LockService.getScriptLock();
  var lockAcquired = false;

  try {
    var data = parseIncomingPayload(e);
    if (!data) {
      return jsonResponse({ success: false, error: "Empty or invalid POST payload" });
    }

    var eventType = normalizeEventType(data);

    // Kiem tra Secret
    if (SECRET_KEY) {
      var providedSecret = String(data.secret || (e && e.parameter && e.parameter.secret) || "").trim();
      var isPublicConsult = eventType === "consultation" && !REQUIRE_SECRET_FOR_PUBLIC_CONSULT;
      if (!isPublicConsult && providedSecret !== SECRET_KEY) {
        return jsonResponse({
          success: false,
          error: "Unauthorized: Invalid Apps Script secret key"
        });
      }
    }

    // Chong double-submit trong vong 15 giay (tru event test)
    if (eventType.indexOf("test") === -1 && isDuplicateSubmission(eventType, data)) {
      return jsonResponse({
        success: true,
        deduplicated: true,
        event_type: eventType,
        message: "Duplicate submission ignored within 15s guard window"
      });
    }

    lockAcquired = lock.tryLock(15000);
    var ss = getTargetSpreadsheet();
    ensureAllTabs(ss);
    var cfg = readMailConfig(ss);

    var result;
    if (eventType === "consultation") {
      result = handleConsultationEvent(ss, cfg, data);
    } else if (eventType === "workspace_registered") {
      result = handleWorkspaceRegisteredEvent(ss, cfg, data);
    } else if (isBillingEventType(eventType)) {
      result = handleBillingOrLifecycleEvent(ss, cfg, eventType, data);
    } else if (eventType === "test_connection" || eventType === "test") {
      result = handleTestConnectionEvent(ss, cfg, data);
    } else {
      // Tuong thich nguoc cho luong gui email tuy chinh / legacy tenant relay
      result = handleGenericEmailEvent(ss, cfg, eventType, data);
    }

    return jsonResponse(result);
  } catch (err) {
    try {
      var errSs = getTargetSpreadsheet();
      appendEmailLogRow(errSs, {
        eventType: "system_error",
        category: "error",
        role: "system",
        to: "",
        cc: "",
        subject: "doPost Unhandled Error",
        status: "FAILED",
        quota: safeRemainingQuota(),
        note: formatError(err)
      });
    } catch (innerErr) {}

    return jsonResponse({
      success: false,
      error: formatError(err)
    });
  } finally {
    if (lockAcquired) {
      try { lock.releaseLock(); } catch (relErr) {}
    }
  }
}

/* ============================================================================
 * EVENT HANDLERS
 * ========================================================================== */

function handleConsultationEvent(ss, cfg, data) {
  var sheet = ensureSchemaTab(ss, TABS.CONSULTATIONS);
  var nowStr = formatNowVN();
  var leadCode = String(data.lead_code || generateCode("DOM")).trim();

  var name = cleanStr(data.name || data.full_name || data.contact_name || "Quý khách");
  var email = cleanStr(data.email || "").toLowerCase();
  var phone = cleanStr(data.phone || data.zalo || "");
  var company = cleanStr(data.company || data.website || "");
  var service = cleanStr(data.service || data.product_interest || data.source_title || "Tư vấn Giải pháp DOMATION");
  var scaleOrBudget = cleanStr(
    data.budget_or_scale || data.volume || data.size || (data.total_price_vnd ? formatVnd(data.total_price_vnd) : "")
  );
  var message = cleanStr(data.message || data.note || data.problem || "");
  var sourceForm = cleanStr(data.source_form || data.source || data.page_path || "domation.net");
  var pageUrl = cleanStr(data.page_url || data.referrer || "");
  var utm = buildUtmSummary(data);

  var mailStatus = "SKIPPED_NO_EMAIL";
  if (email && isValidEmail(email)) {
    if (cfg.SEND_CUSTOMER_THANK_YOU) {
      var custMail = buildConsultationThankYouEmail({
        leadCode: leadCode,
        name: name,
        email: email,
        phone: phone,
        company: company,
        service: service,
        scaleOrBudget: scaleOrBudget,
        message: message,
        sourceForm: sourceForm,
        addonsSummary: cleanStr(data.addons_summary || "")
      }, cfg);

      var sendCust = sendSafeEmail(ss, {
        to: email,
        replyTo: cfg.REPLY_TO_EMAIL,
        senderName: cfg.SENDER_NAME,
        subject: custMail.subject,
        text: custMail.text,
        htmlBody: custMail.html,
        eventType: "consultation",
        category: "consultation_thank_you",
        role: "customer"
      });
      mailStatus = sendCust.sent ? "SENT" : ("FAILED: " + sendCust.error);
    } else {
      mailStatus = "DISABLED_IN_CONFIG";
    }
  }

  sheet.appendRow([
    leadCode,
    nowStr,
    sourceForm,
    name,
    email,
    phone,
    company,
    service,
    scaleOrBudget,
    message,
    utm,
    pageUrl,
    mailStatus,
    "",
    "Mới tiếp nhận",
    safeJsonTruncated(data)
  ]);

  var adminSent = false;
  if (cfg.SEND_ADMIN_ALERT && cfg.ADMIN_NOTIFY_EMAILS.length > 0) {
    var adminMail = buildAdminConsultationAlertEmail({
      leadCode: leadCode,
      submittedAt: nowStr,
      name: name,
      email: email,
      phone: phone,
      company: company,
      service: service,
      scaleOrBudget: scaleOrBudget,
      message: message,
      sourceForm: sourceForm,
      utm: utm,
      pageUrl: pageUrl,
      customerMailStatus: mailStatus
    }, cfg, ss.getUrl());

    var adminRes = sendSafeEmail(ss, {
      to: cfg.ADMIN_NOTIFY_EMAILS.join(","),
      replyTo: isValidEmail(email) ? email : cfg.REPLY_TO_EMAIL,
      senderName: cfg.SENDER_NAME,
      subject: adminMail.subject,
      text: adminMail.text,
      htmlBody: adminMail.html,
      eventType: "consultation",
      category: "admin_consultation_alert",
      role: "admin_cc"
    });
    adminSent = adminRes.sent;
  }

  return {
    success: true,
    tab: TABS.CONSULTATIONS,
    lead_code: leadCode,
    customer_mail_status: mailStatus,
    admin_alert_sent: adminSent,
    remaining_quota: safeRemainingQuota()
  };
}

function handleWorkspaceRegisteredEvent(ss, cfg, data) {
  var sheet = ensureSchemaTab(ss, TABS.WORKSPACES);
  var nowStr = formatNowVN();

  var slug = cleanStr(data.tenant_slug || "");
  var companyName = cleanStr(data.tenant_name || data.company_name || slug);
  var industry = cleanStr(data.industry || "general");
  var adminName = cleanStr(data.admin_name || data.full_name || "Quản trị viên");
  var email = cleanStr(data.email || data.admin_email || "").toLowerCase();
  var phone = cleanStr(data.phone || "");
  var planCode = cleanStr(data.plan_code || "trial_1m");
  var trialEndsAt = formatIsoOrTextVN(data.trial_ends_at || "");
  var trialDays = Number(data.trial_days || 30);
  var authMethod = cleanStr(data.auth_provider || data.source || "password");
  var tenantId = cleanStr(data.tenant_id || "");

  var mailStatus = "SKIPPED_NO_EMAIL";
  if (email && isValidEmail(email)) {
    if (cfg.SEND_BILLING_CUSTOMER_EMAIL) {
      var welcome = buildWorkspaceWelcomeEmail({
        slug: slug,
        companyName: companyName,
        industry: industry,
        adminName: adminName,
        email: email,
        phone: phone,
        planCode: planCode,
        trialEndsAt: trialEndsAt,
        trialDays: trialDays
      }, cfg);

      var custRes = sendSafeEmail(ss, {
        to: email,
        replyTo: cfg.REPLY_TO_EMAIL,
        senderName: cfg.SENDER_NAME,
        subject: welcome.subject,
        text: welcome.text,
        htmlBody: welcome.html,
        eventType: "workspace_registered",
        category: "workspace_welcome_trial",
        role: "customer"
      });
      mailStatus = custRes.sent ? "SENT" : ("FAILED: " + custRes.error);
    } else {
      mailStatus = "DISABLED_IN_CONFIG";
    }
  }

  sheet.appendRow([
    nowStr,
    slug,
    companyName,
    industry,
    adminName,
    email,
    phone,
    planCode + " (" + trialDays + " ngay)",
    trialEndsAt,
    authMethod,
    tenantId,
    mailStatus,
    "Khoi tao Workspace AutoData thanh cong",
    safeJsonTruncated(data)
  ]);

  var adminSent = false;
  if (cfg.SEND_ADMIN_ALERT && cfg.ADMIN_NOTIFY_EMAILS.length > 0) {
    var adminMail = buildAdminWorkspaceAlertEmail({
      registeredAt: nowStr,
      slug: slug,
      companyName: companyName,
      industry: industry,
      adminName: adminName,
      email: email,
      phone: phone,
      trialEndsAt: trialEndsAt,
      trialDays: trialDays,
      authMethod: authMethod
    }, cfg, ss.getUrl());

    var adminRes = sendSafeEmail(ss, {
      to: cfg.ADMIN_NOTIFY_EMAILS.join(","),
      replyTo: isValidEmail(email) ? email : cfg.REPLY_TO_EMAIL,
      senderName: cfg.SENDER_NAME,
      subject: adminMail.subject,
      text: adminMail.text,
      htmlBody: adminMail.html,
      eventType: "workspace_registered",
      category: "admin_workspace_alert",
      role: "admin_cc"
    });
    adminSent = adminRes.sent;
  }

  return {
    success: true,
    tab: TABS.WORKSPACES,
    tenant_slug: slug,
    customer_mail_status: mailStatus,
    admin_alert_sent: adminSent,
    remaining_quota: safeRemainingQuota()
  };
}

function handleBillingOrLifecycleEvent(ss, cfg, eventType, data) {
  var sheet = ensureSchemaTab(ss, TABS.BILLING);
  var nowStr = formatNowVN();

  var refCode = cleanStr(data.reference_code || data.ref_code || generateCode("BILL"));
  var txStatus = cleanStr(data.status || inferTxStatusFromEvent(eventType));
  var slug = cleanStr(data.tenant_slug || "");
  var companyName = cleanStr(data.tenant_name || data.company_name || slug);
  var email = cleanStr(data.email || data.admin_email || "").toLowerCase();
  var phone = cleanStr(data.phone || "");
  var planCode = cleanStr(data.plan_code || data.target_suite || "");
  var planName = cleanStr(data.plan_name || planCode);
  var billingCycle = cleanStr(data.billing_cycle || "");
  var monthsOrDays = data.months_added
    ? (data.months_added + " thang" + (data.added_days ? " (" + data.added_days + " ngay)" : ""))
    : (data.days_remaining !== undefined ? ("Con " + data.days_remaining + " ngay") : (data.extend_days ? data.extend_days + " ngay" : "-"));
  var amountVnd = Number(data.amount_vnd || 0);
  var bonusOrDiscount = data.bonus_vnd
    ? ("+" + formatVnd(data.bonus_vnd))
    : (data.discount_pct ? ("-" + data.discount_pct + "%") : "0");
  var paymentMethod = cleanStr(data.payment_method || "");
  var expiresOrWallet = buildExpiryWalletSummary(data);
  var note = cleanStr(data.note || data.resolution_note || "");
  var processedBy = cleanStr(data.processed_by || "");
  var noteCol = [note, processedBy ? ("Xu ly: " + processedBy) : ""].filter(Boolean).join(" | ");

  var isExpiryEvent = eventType === "expiry_warning" || eventType === "subscription_expired_suspended";
  var shouldEmailCustomer = isExpiryEvent ? cfg.SEND_EXPIRY_WARNING_EMAIL : cfg.SEND_BILLING_CUSTOMER_EMAIL;

  var mailStatus = "SKIPPED_NO_EMAIL";
  if (email && isValidEmail(email)) {
    if (shouldEmailCustomer) {
      var custMail = buildBillingCustomerEmail(eventType, {
        refCode: refCode,
        txStatus: txStatus,
        slug: slug,
        companyName: companyName,
        adminName: cleanStr(data.admin_name || "Quý khách"),
        email: email,
        phone: phone,
        planCode: planCode,
        planName: planName,
        billingCycle: billingCycle,
        monthsAdded: Number(data.months_added || 0),
        addedDays: Number(data.added_days || 0),
        daysRemaining: data.days_remaining,
        amountVnd: amountVnd,
        bonusVnd: Number(data.bonus_vnd || 0),
        discountPct: Number(data.discount_pct || 0),
        walletBalanceVnd: data.wallet_balance_vnd,
        requiredAmountVnd: data.required_amount_vnd,
        shortfallVnd: data.shortfall_vnd,
        paymentMethod: paymentMethod,
        effectiveExpiresAt: formatIsoOrTextVN(data.effective_expires_at || data.new_expires_at || ""),
        note: note,
        bankInfo: data.bank_info || null,
        targetSuiteLabel: cleanStr(data.target_suite_label || "")
      }, cfg);

      var custRes = sendSafeEmail(ss, {
        to: email,
        replyTo: cfg.REPLY_TO_EMAIL,
        senderName: cfg.SENDER_NAME,
        subject: custMail.subject,
        text: custMail.text,
        htmlBody: custMail.html,
        eventType: eventType,
        category: custMail.category,
        role: "customer"
      });
      mailStatus = custRes.sent ? "SENT" : ("FAILED: " + custRes.error);
    } else {
      mailStatus = "DISABLED_IN_CONFIG";
    }
  }

  sheet.appendRow([
    nowStr,
    refCode,
    eventType,
    txStatus,
    slug,
    companyName,
    email,
    phone,
    planName || planCode,
    billingCycle,
    monthsOrDays,
    amountVnd,
    bonusOrDiscount,
    paymentMethod,
    expiresOrWallet,
    mailStatus,
    noteCol,
    safeJsonTruncated(data)
  ]);

  var adminSent = false;
  if (cfg.SEND_ADMIN_ALERT && cfg.ADMIN_NOTIFY_EMAILS.length > 0) {
    var adminMail = buildAdminBillingAlertEmail(eventType, {
      timestamp: nowStr,
      refCode: refCode,
      txStatus: txStatus,
      slug: slug,
      companyName: companyName,
      email: email,
      phone: phone,
      planName: planName || planCode,
      billingCycle: billingCycle,
      amountVnd: amountVnd,
      paymentMethod: paymentMethod,
      expiresOrWallet: expiresOrWallet,
      note: noteCol,
      customerMailStatus: mailStatus
    }, cfg, ss.getUrl());

    var adminRes = sendSafeEmail(ss, {
      to: cfg.ADMIN_NOTIFY_EMAILS.join(","),
      replyTo: isValidEmail(email) ? email : cfg.REPLY_TO_EMAIL,
      senderName: cfg.SENDER_NAME,
      subject: adminMail.subject,
      text: adminMail.text,
      htmlBody: adminMail.html,
      eventType: eventType,
      category: "admin_" + eventType,
      role: "admin_cc"
    });
    adminSent = adminRes.sent;
  }

  return {
    success: true,
    tab: TABS.BILLING,
    event_type: eventType,
    reference_code: refCode,
    customer_mail_status: mailStatus,
    admin_alert_sent: adminSent,
    remaining_quota: safeRemainingQuota()
  };
}

function handleTestConnectionEvent(ss, cfg, data) {
  var to = cleanStr(data.to || data.email || (cfg.ADMIN_NOTIFY_EMAILS[0] || ""));
  if (!to || !isValidEmail(to)) {
    return {
      success: false,
      error: "Thieu dia chi email hop le (to/email) de gui mail test."
    };
  }

  var mail = buildTestConnectionEmail({
    spreadsheetName: ss.getName(),
    spreadsheetUrl: ss.getUrl(),
    to: to,
    remainingQuota: safeRemainingQuota()
  }, cfg);

  var sendRes = sendSafeEmail(ss, {
    to: to,
    replyTo: cfg.REPLY_TO_EMAIL,
    senderName: cfg.SENDER_NAME,
    subject: mail.subject,
    text: mail.text,
    htmlBody: mail.html,
    eventType: "test_connection",
    category: "system_test",
    role: "test"
  });

  return {
    success: sendRes.sent,
    tab: TABS.EMAIL_LOGS,
    to: to,
    remaining_quota: safeRemainingQuota(),
    sheet_logged: true,
    error: sendRes.error || undefined,
    message: sendRes.sent
      ? "Ket noi Master Apps Script & Google Sheets thanh cong!"
      : ("Loi gui email test: " + sendRes.error)
  };
}

function handleGenericEmailEvent(ss, cfg, eventType, data) {
  var to = cleanStr(data.to || data.email || "");
  if (!to || !isValidEmail(to)) {
    return { success: false, error: "Thieu dia chi email nguoi nhan hop le (to/email)" };
  }
  var senderName = cleanStr(data.from_name || data.tenant_name || cfg.SENDER_NAME);
  var subject = cleanStr(data.subject || ("[" + cfg.BRAND_NAME + "] Thong bao he thong (" + eventType + ")"));
  var plainText = cleanStr(data.text || ("Thong bao tu " + senderName));
  var htmlBody = cleanStr(data.htmlBody || data.html || "");
  if (!htmlBody) {
    htmlBody = wrapHtmlEnvelope({
      badge: eventType.toUpperCase(),
      accentColor: "#1E40FF",
      title: subject,
      greeting: "",
      summaryHtml: "<p style='margin:0;white-space:pre-line;color:#334155;font-size:14px;line-height:1.6'>" + escapeHtml(plainText) + "</p>",
      rows: [],
      ctaLabel: "Truy cập DOMATION",
      ctaUrl: cfg.PORTAL_URL
    }, cfg);
  }

  var sendRes = sendSafeEmail(ss, {
    to: to,
    cc: cleanStr(data.cc || ""),
    replyTo: cleanStr(data.reply_to || cfg.REPLY_TO_EMAIL),
    senderName: senderName,
    subject: subject,
    text: plainText,
    htmlBody: htmlBody,
    eventType: eventType,
    category: cleanStr(data.category || eventType),
    role: "custom"
  });

  return {
    success: sendRes.sent,
    category: eventType,
    to: to,
    remaining_quota: safeRemainingQuota(),
    sheet_logged: true,
    error: sendRes.error || undefined
  };
}

/* ============================================================================
 * SPREADSHEET SCHEMA, DASHBOARD & CONFIG HELPERS
 * ========================================================================== */

function getTargetSpreadsheet() {
  try {
    var active = SpreadsheetApp.getActiveSpreadsheet();
    if (active) {
      return active;
    }
  } catch (e) {}
  return SpreadsheetApp.openById(SPREADSHEET_ID);
}

function ensureAllTabs(ss) {
  ensureDashboardTab(ss);
  ensureSchemaTab(ss, TABS.CONSULTATIONS);
  ensureSchemaTab(ss, TABS.WORKSPACES);
  ensureSchemaTab(ss, TABS.BILLING);
  ensureSchemaTab(ss, TABS.EMAIL_LOGS);
  ensureConfigTab(ss);
}

function ensureSchemaTab(ss, tabName) {
  var sheet = ss.getSheetByName(tabName);
  var spec = TAB_SCHEMAS[tabName];
  if (!sheet) {
    sheet = ss.insertSheet(tabName);
    if (spec && spec.headers) {
      sheet.appendRow(spec.headers);
      var headerRange = sheet.getRange(1, 1, 1, spec.headers.length);
      headerRange
        .setFontWeight("bold")
        .setFontColor("#FFFFFF")
        .setBackground(spec.color || "#1E40FF")
        .setVerticalAlignment("middle")
        .setWrap(true);
      sheet.setRowHeight(1, 34);
      sheet.setFrozenRows(1);
      sheet.setTabColor(spec.color || "#1E40FF");
      if (spec.headers.length >= 2) {
        sheet.getRange(1, 1, 1, spec.headers.length).createFilter();
      }
      sheet.autoResizeColumns(1, Math.min(12, spec.headers.length));
    }
  }
  return sheet;
}

function ensureConfigTab(ss) {
  ss = ss || getTargetSpreadsheet();
  var sheet = ensureSchemaTab(ss, TABS.CONFIG);
  var lastRow = sheet.getLastRow();

  if (lastRow <= 1) {
    sheet.getRange(2, 2, DEFAULT_CONFIG_ROWS.length, 1).setNumberFormat("@");
    for (var i = 0; i < DEFAULT_CONFIG_ROWS.length; i++) {
      sheet.appendRow(DEFAULT_CONFIG_ROWS[i]);
    }
    sheet.setColumnWidth(1, 240);
    sheet.setColumnWidth(2, 340);
    sheet.setColumnWidth(3, 440);
    return sheet;
  }

  // Dong bo cac khoa moi (VD: FACEBOOK_URL) va tu dong nang cap gia tri mac dinh cu ma khong ghi de tuy chinh moi
  var existingRange = sheet.getRange(2, 1, lastRow - 1, 2);
  var existingValues = existingRange.getValues();
  var keyToRow = {};
  for (var r = 0; r < existingValues.length; r++) {
    var existingKey = cleanStr(existingValues[r][0]);
    if (existingKey) {
      keyToRow[existingKey] = {
        rowNum: r + 2,
        value: cleanStr(existingValues[r][1])
      };
    }
  }

  for (var d = 0; d < DEFAULT_CONFIG_ROWS.length; d++) {
    var defKey = DEFAULT_CONFIG_ROWS[d][0];
    var defVal = DEFAULT_CONFIG_ROWS[d][1];
    var defDesc = DEFAULT_CONFIG_ROWS[d][2];
    var found = keyToRow[defKey];

    if (!found) {
      var appendAt = sheet.getLastRow() + 1;
      sheet.getRange(appendAt, 2).setNumberFormat("@");
      sheet.getRange(appendAt, 1, 1, 3).setValues([[defKey, defVal, defDesc]]);
      continue;
    }

    if ((defKey === "REPLY_TO_EMAIL" || defKey === "ADMIN_NOTIFY_EMAILS") && found.value.indexOf("turniodev@gmail.com") !== -1) {
      sheet.getRange(found.rowNum, 2).setValue(found.value.replace(/turniodev@gmail\.com/gi, "domation.net@gmail.com"));
    } else if (defKey === "HOTLINE_ZALO" && (found.value === "378.859.736" || found.value === "378859736")) {
      var phoneCell = sheet.getRange(found.rowNum, 2);
      phoneCell.setNumberFormat("@");
      phoneCell.setValue("0378.859.736");
    }
  }

  return sheet;
}

function ensureDashboardTab(ss) {
  ss = ss || getTargetSpreadsheet();
  var dash = ss.getSheetByName(TABS.DASHBOARD);
  if (!dash) {
    dash = ss.insertSheet(TABS.DASHBOARD, 0);
    dash.setTabColor("#0F172A");

    dash.getRange("A1:D1").merge()
      .setValue("DOMATION ENTERPRISE — TRUNG TAM DIEU HANH FORM, DANG KY GOI & EMAIL HUB")
      .setFontSize(13).setFontWeight("bold").setFontColor("#FFFFFF").setBackground("#0F172A")
      .setVerticalAlignment("middle").setHorizontalAlignment("left");
    dash.setRowHeight(1, 42);

    dash.getRange("A2:D2").merge()
      .setValue("Tu dong dong bo tu tat ca trang domation.net & he thong AutoData SaaS (data.domation.net). Chinh sua email nhan bao cao tai tab Cau_Hinh_Mail.")
      .setFontSize(10).setFontColor("#475569").setBackground("#F1F5F9");

    var kpiRows = [
      ["CHI SO VAN HANH", "GIA TRI TU DONG", "NGUON DU LIEU", "GHI CHU"],
      ["Tong luot Form Tu Van (All Sites)", "=MAX(0, COUNTA('" + TABS.CONSULTATIONS + "'!A:A)-1)", TABS.CONSULTATIONS, "Tat ca form tren domation.net"],
      ["So luot da gui Mail Cam On thanh cong", "=COUNTIF('" + TABS.CONSULTATIONS + "'!M:M, \"SENT\")", TABS.CONSULTATIONS, "Khach dien dung Email hop le"],
      ["Tong Workspace AutoData da khoi tao", "=MAX(0, COUNTA('" + TABS.WORKSPACES + "'!B:B)-1)", TABS.WORKSPACES, "Bao gom Dung thu & Tao moi"],
      ["Tong giao dich / su kien Goi & Gia han", "=MAX(0, COUNTA('" + TABS.BILLING + "'!B:B)-1)", TABS.BILLING, "Topup, Mua goi, Gia han, Nang cap"],
      ["Don chuyen khoan cho Admin duyet (Pending)", "=COUNTIF('" + TABS.BILLING + "'!D:D, \"pending\")", TABS.BILLING, "Can kiem tra bien lai & duyet"],
      ["Tien chuyen khoan da duyet / Nap vi (VND)", "=SUMIFS('" + TABS.BILLING + "'!L:L, '" + TABS.BILLING + "'!D:D, \"approved\")", TABS.BILLING, "Tien that chuyen khoan da duyet vao he thong"],
      ["Gia tri kich hoat / gia han qua Vi (VND)", "=SUMIFS('" + TABS.BILLING + "'!L:L, '" + TABS.BILLING + "'!D:D, \"completed\")", TABS.BILLING, "Tru vi kich hoat / tu dong gia han goi"],
      ["Tong Email da gui thanh cong qua Hub", "=COUNTIF('" + TABS.EMAIL_LOGS + "'!H:H, \"SENT\")", TABS.EMAIL_LOGS, "Bao gom Mail khach & Mail Admin"],
      ["Tong Email loi (can kiem tra)", "=COUNTIF('" + TABS.EMAIL_LOGS + "'!H:H, \"FAILED\")", TABS.EMAIL_LOGS, "Kiem tra quota Gmail / Email sai"]
    ];

    dash.getRange(4, 1, kpiRows.length, 4).setValues(kpiRows);
    dash.getRange(4, 1, 1, 4).setFontWeight("bold").setFontColor("#FFFFFF").setBackground("#1E40FF");
    dash.getRange(5, 2, kpiRows.length - 1, 1).setFontWeight("bold").setFontSize(12).setHorizontalAlignment("right");
    dash.getRange(10, 2, 2, 1).setNumberFormat("#,##0 \"₫\"");
    dash.setColumnWidth(1, 320);
    dash.setColumnWidth(2, 180);
    dash.setColumnWidth(3, 180);
    dash.setColumnWidth(4, 340);
  }
  return dash;
}

function readMailConfig(ss) {
  var cfg = {
    BRAND_NAME: "DOMATION Enterprise",
    SENDER_NAME: "DOMATION Enterprise Solutions",
    REPLY_TO_EMAIL: "domation.net@gmail.com",
    ADMIN_NOTIFY_EMAILS: ["domation.net@gmail.com"],
    SEND_CUSTOMER_THANK_YOU: true,
    SEND_ADMIN_ALERT: true,
    SEND_BILLING_CUSTOMER_EMAIL: true,
    SEND_EXPIRY_WARNING_EMAIL: true,
    HOTLINE_ZALO: "0378.859.736",
    ZALO_OA_LINK: "https://zalo.me/0378859736",
    FACEBOOK_URL: "https://www.facebook.com/domation.net/",
    PORTAL_URL: "https://data.domation.net/data",
    DEFAULT_BANK_INFO: "",
    SIGNATURE_NOTE: "Đội ngũ Kiến trúc Giải pháp & Chuyển đổi số DOMATION.NET"
  };

  try {
    var sheet = ss.getSheetByName(TABS.CONFIG);
    if (!sheet || sheet.getLastRow() <= 1) return cfg;
    var values = sheet.getRange(2, 1, sheet.getLastRow() - 1, 2).getValues();
    for (var i = 0; i < values.length; i++) {
      var k = cleanStr(values[i][0]);
      var v = cleanStr(values[i][1]);
      if (!k || !v) continue;
      if (k === "ADMIN_NOTIFY_EMAILS") {
        cfg.ADMIN_NOTIFY_EMAILS = v.split(/[,;\s]+/).map(function(x) { return x.trim(); }).filter(isValidEmail);
      } else if (
        k === "SEND_CUSTOMER_THANK_YOU" ||
        k === "SEND_ADMIN_ALERT" ||
        k === "SEND_BILLING_CUSTOMER_EMAIL" ||
        k === "SEND_EXPIRY_WARNING_EMAIL"
      ) {
        cfg[k] = v.toUpperCase() !== "FALSE" && v !== "0" && v.toUpperCase() !== "NO";
      } else {
        cfg[k] = v;
      }
    }
  } catch (err) {}
  return cfg;
}

/* ============================================================================
 * EMAIL DISPATCH + LOGGING
 * ========================================================================== */

function sendSafeEmail(ss, opts) {
  var sent = false;
  var errText = "";
  try {
    var mailOptions = {
      to: opts.to,
      subject: opts.subject,
      body: opts.text,
      htmlBody: opts.htmlBody,
      name: opts.senderName || "DOMATION Enterprise"
    };
    if (opts.cc) mailOptions.cc = opts.cc;
    if (opts.replyTo && isValidEmail(opts.replyTo)) mailOptions.replyTo = opts.replyTo;

    MailApp.sendEmail(mailOptions);
    sent = true;
  } catch (err) {
    errText = formatError(err);
  }

  appendEmailLogRow(ss, {
    eventType: opts.eventType || "",
    category: opts.category || "system",
    role: opts.role || "customer",
    to: opts.to || "",
    cc: opts.cc || opts.replyTo || "",
    subject: opts.subject || "",
    status: sent ? "SENT" : "FAILED",
    quota: safeRemainingQuota(),
    note: errText
  });

  return { sent: sent, error: errText };
}

function appendEmailLogRow(ss, entry) {
  try {
    var sheet = ensureSchemaTab(ss, TABS.EMAIL_LOGS);
    sheet.appendRow([
      formatNowVN(),
      cleanStr(entry.eventType),
      cleanStr(entry.category),
      cleanStr(entry.role),
      cleanStr(entry.to),
      cleanStr(entry.cc),
      cleanStr(entry.subject),
      cleanStr(entry.status || "SENT"),
      entry.quota !== undefined ? entry.quota : safeRemainingQuota(),
      cleanStr(entry.note)
    ]);
  } catch (e) {}
}

/* ============================================================================
 * HTML EMAIL TEMPLATES (SWISS LIGHT INDIGO / ENTERPRISE GRADE)
 * ========================================================================== */

function wrapHtmlEnvelope(opts, cfg) {
  var rowsHtml = "";
  if (opts.rows && opts.rows.length > 0) {
    rowsHtml += "<table role='presentation' width='100%' cellspacing='0' cellpadding='0' style='border-collapse:collapse;margin:18px 0;background:#F8FAFC;border:1px solid #E2E8F0;border-radius:12px;overflow:hidden'>";
    for (var i = 0; i < opts.rows.length; i++) {
      var r = opts.rows[i];
      if (!r || !r.value) continue;
      rowsHtml +=
        "<tr style='border-bottom:1px solid #E2E8F0'>" +
        "<td style='padding:10px 14px;font-size:12px;font-weight:700;color:#64748B;text-transform:uppercase;width:36%'>" + escapeHtml(r.label) + "</td>" +
        "<td style='padding:10px 14px;font-size:13.5px;font-weight:600;color:#0F172A'>" + escapeHtml(r.value) + "</td>" +
        "</tr>";
    }
    rowsHtml += "</table>";
  }

  var ctaBlock = "";
  if (opts.ctaLabel && opts.ctaUrl) {
    ctaBlock =
      "<div style='margin:22px 0 10px'>" +
      "<a href='" + escapeHtml(opts.ctaUrl) + "' target='_blank' style='display:inline-block;padding:12px 24px;background:" + (opts.accentColor || "#1E40FF") + ";color:#FFFFFF;text-decoration:none;font-size:13.5px;font-weight:700;border-radius:999px'>" +
      escapeHtml(opts.ctaLabel) +
      "</a></div>";
  }

  var secondaryCta = "";
  if (opts.secondaryLabel && opts.secondaryUrl) {
    secondaryCta =
      " <a href='" + escapeHtml(opts.secondaryUrl) + "' target='_blank' style='display:inline-block;margin-left:8px;padding:11px 18px;background:#EFF6FF;color:#1E40FF;border:1px solid #BFDBFE;text-decoration:none;font-size:13px;font-weight:700;border-radius:999px'>" +
      escapeHtml(opts.secondaryLabel) +
      "</a>";
  }

  return (
    "<!DOCTYPE html><html><body style='margin:0;padding:24px 12px;background:#F1F5F9;font-family:-apple-system,BlinkMacSystemFont,Segoe UI,Roboto,Arial,sans-serif;color:#0F172A'>" +
    "<div style='max-width:620px;margin:0 auto;background:#FFFFFF;border:1px solid #E2E8F0;border-radius:18px;overflow:hidden;box-shadow:0 10px 30px rgba(15,23,42,0.06)'>" +
    "<div style='padding:22px 26px;background:linear-gradient(135deg,#0F172A 0%,#1E3A8A 100%);color:#FFFFFF'>" +
    "<div style='display:inline-block;padding:4px 11px;border-radius:999px;font-size:10.5px;font-weight:800;letter-spacing:0.06em;background:rgba(255,255,255,0.16);color:#BAE6FD;margin-bottom:10px'>" + escapeHtml(opts.badge || "DOMATION ENTERPRISE") + "</div>" +
    "<h2 style='margin:0;font-size:20px;line-height:1.35;font-weight:800;color:#FFFFFF'>" + escapeHtml(opts.title) + "</h2>" +
    "</div>" +
    "<div style='padding:24px 26px'>" +
    (opts.greeting ? "<p style='margin:0 0 12px;font-size:14.5px;color:#0F172A'>" + opts.greeting + "</p>" : "") +
    (opts.summaryHtml || "") +
    rowsHtml +
    (ctaBlock ? ("<div>" + ctaBlock + secondaryCta + "</div>") : "") +
    "</div>" +
    "<div style='padding:16px 26px;background:#F8FAFC;border-top:1px solid #E2E8F0;font-size:12px;color:#64748B;line-height:1.6'>" +
    "<strong style='color:#334155'>" + escapeHtml(cfg.BRAND_NAME) + "</strong> • " + escapeHtml(cfg.SIGNATURE_NOTE) + "<br/>" +
    "Hotline / Zalo 24/7: <a href='" + escapeHtml(cfg.ZALO_OA_LINK) + "' style='color:#1E40FF;font-weight:700;text-decoration:none'>" + escapeHtml(cfg.HOTLINE_ZALO) + "</a> • Email: <a href='mailto:" + escapeHtml(cfg.REPLY_TO_EMAIL) + "' style='color:#1E40FF;text-decoration:none'>" + escapeHtml(cfg.REPLY_TO_EMAIL) + "</a> • Facebook: <a href='" + escapeHtml(cfg.FACEBOOK_URL) + "' style='color:#1E40FF;text-decoration:none'>fb.com/domation.net</a>" +
    "</div></div></body></html>"
  );
}

function buildConsultationThankYouEmail(p, cfg) {
  var rows = [
    { label: "Mã tiếp nhận", value: p.leadCode },
    { label: "Giải pháp quan tâm", value: p.service },
    { label: "Số điện thoại / Zalo", value: p.phone || "Chưa cung cấp" },
    { label: "Doanh nghiệp / Website", value: p.company || "Chưa cung cấp" },
    { label: "Quy mô / Dự toán", value: p.scaleOrBudget || "" },
    { label: "Nhu cầu chi tiết", value: p.addonsSummary || p.message || "" }
  ];

  var subject = "[" + cfg.BRAND_NAME + "] Cảm ơn Anh/Chị " + p.name + " đã đăng ký tư vấn (#" + p.leadCode + ")";
  var html = wrapHtmlEnvelope({
    badge: "XÁC NHẬN YÊU CẦU TƯ VẤN",
    accentColor: "#1E40FF",
    title: "Cảm ơn Anh/Chị đã kết nối cùng DOMATION!",
    greeting: "Kính chào Anh/Chị <strong>" + escapeHtml(p.name) + "</strong>,",
    summaryHtml:
      "<p style='margin:0 0 12px;font-size:14px;line-height:1.65;color:#334155'>" +
      "Hệ thống đã tiếp nhận đầy đủ thông tin yêu cầu tư vấn từ trang <strong>" + escapeHtml(p.sourceForm) + "</strong>. " +
      "Chuyên gia Solution Architect của DOMATION sẽ chủ động liên hệ qua Zalo / SĐT <strong>" + escapeHtml(p.phone || cfg.HOTLINE_ZALO) + "</strong> trong vòng <strong>15–30 phút</strong> (giờ hành chính) để demo luồng vận hành & báo giá chi tiết." +
      "</p>",
    rows: rows,
    ctaLabel: "Chat Zalo Kiến Trúc Sư Ngay",
    ctaUrl: cfg.ZALO_OA_LINK,
    secondaryLabel: "Dùng thử AutoData Miễn Phí",
    secondaryUrl: cfg.PORTAL_URL
  }, cfg);

  var text = "Cảm ơn Anh/Chị " + p.name + " đã đăng ký tư vấn " + p.service + " (Mã: " + p.leadCode + "). Đội ngũ DOMATION sẽ liên hệ qua Zalo/SĐT " + (p.phone || "") + " trong 15-30 phút. Hotline: " + cfg.HOTLINE_ZALO;
  return { subject: subject, html: html, text: text };
}

function buildAdminConsultationAlertEmail(p, cfg, sheetUrl) {
  var rows = [
    { label: "Mã Lead", value: p.leadCode },
    { label: "Nguồn Form", value: p.sourceForm },
    { label: "Khách hàng", value: p.name },
    { label: "SĐT / Zalo", value: p.phone || "—" },
    { label: "Email", value: p.email || "—" },
    { label: "Doanh nghiệp", value: p.company || "—" },
    { label: "Giải pháp", value: p.service },
    { label: "Quy mô / Ngân sách", value: p.scaleOrBudget || "—" },
    { label: "Nội dung yêu cầu", value: p.message || "—" },
    { label: "UTM / Page URL", value: [p.utm, p.pageUrl].filter(Boolean).join(" | ") },
    { label: "Trạng thái Mail Cảm Ơn", value: p.customerMailStatus }
  ];

  var subject = "🔥 [LEAD MỚI DOMATION] " + p.name + " (" + (p.phone || p.email || "N/A") + ") — " + p.service;
  var zaloPhoneClean = (p.phone || "").replace(/[^0-9+]/g, "");
  var html = wrapHtmlEnvelope({
    badge: "LEAD TƯ VẤN MỚI • " + p.sourceForm.toUpperCase(),
    accentColor: "#059669",
    title: "Có khách hàng mới đăng ký tư vấn trên " + p.sourceForm,
    greeting: "Admin thân mến,",
    summaryHtml: "<p style='margin:0 0 10px;font-size:14px;color:#334155'>Vui lòng liên hệ sớm để đảm bảo tỷ lệ chuyển đổi tối ưu. Toàn bộ dữ liệu đã được lưu tự động vào tab <strong>" + TABS.CONSULTATIONS + "</strong>.</p>",
    rows: rows,
    ctaLabel: "Mở Google Sheet Quản Lý",
    ctaUrl: sheetUrl,
    secondaryLabel: zaloPhoneClean ? ("Chat Zalo Khách (" + p.phone + ")") : "",
    secondaryUrl: zaloPhoneClean ? ("https://zalo.me/" + zaloPhoneClean) : ""
  }, cfg);

  return {
    subject: subject,
    html: html,
    text: "Lead moi tu " + p.sourceForm + ": " + p.name + " | " + p.phone + " | " + p.email + " | " + p.service
  };
}

function buildWorkspaceWelcomeEmail(p, cfg) {
  var rows = [
    { label: "Doanh nghiệp", value: p.companyName },
    { label: "Workspace Slug", value: p.slug },
    { label: "Ngành hàng Preset", value: p.industry },
    { label: "Gói khởi tạo", value: "Dùng thử miễn phí (" + p.trialDays + " ngày)" },
    { label: "Thời hạn dùng thử", value: p.trialEndsAt || "30 ngày kể từ hôm nay" },
    { label: "Email Quản trị", value: p.email }
  ];
  var subject = "[" + cfg.BRAND_NAME + "] Chào mừng " + p.companyName + " — Workspace AutoData đã sẵn sàng!";
  var html = wrapHtmlEnvelope({
    badge: "WORKSPACE KÍCH HOẠT THÀNH CÔNG",
    accentColor: "#1E40FF",
    title: "Chào mừng Anh/Chị " + p.adminName + " gia nhập DOMATION AutoData!",
    greeting: "Kính chào Anh/Chị <strong>" + escapeHtml(p.adminName) + "</strong>,",
    summaryHtml:
      "<p style='margin:0 0 12px;font-size:14px;line-height:1.65;color:#334155'>" +
      "Không gian điều phối Lead đa kênh riêng biệt (<strong>" + escapeHtml(p.companyName) + "</strong>) đã được khởi tạo an toàn. " +
      "Anh/Chị đang có <strong>" + p.trialDays + " ngày dùng thử miễn phí toàn bộ tính năng</strong> (chia vòng Sale, ZaloBot/Telegram Bot, Meta CAPI, lọc SĐT trùng & Blacklist)." +
      "</p>",
    rows: rows,
    ctaLabel: "Truy Cập Workspace Ngay",
    ctaUrl: cfg.PORTAL_URL,
    secondaryLabel: "Hỗ trợ Setup 1-1 qua Zalo",
    secondaryUrl: cfg.ZALO_OA_LINK
  }, cfg);
  return {
    subject: subject,
    html: html,
    text: "Workspace " + p.companyName + " (" + p.slug + ") da san sang. Dang nhap tai " + cfg.PORTAL_URL
  };
}

function buildAdminWorkspaceAlertEmail(p, cfg, sheetUrl) {
  var rows = [
    { label: "Doanh nghiệp", value: p.companyName },
    { label: "Tenant Slug", value: p.slug },
    { label: "Ngành", value: p.industry },
    { label: "Admin", value: p.adminName },
    { label: "Email", value: p.email },
    { label: "SĐT", value: p.phone || "—" },
    { label: "Hạn Trial", value: p.trialEndsAt },
    { label: "Cách đăng ký", value: p.authMethod }
  ];
  return {
    subject: "🚀 [WORKSPACE MỚI] " + p.companyName + " (" + p.slug + ") vừa đăng ký Dùng thử",
    html: wrapHtmlEnvelope({
      badge: "ĐĂNG KÝ WORKSPACE MỚI",
      accentColor: "#0284C7",
      title: "Doanh nghiệp mới khởi tạo Workspace AutoData",
      greeting: "Admin DOMATION,",
      summaryHtml: "<p style='margin:0 0 10px;font-size:14px;color:#334155'>Ghi nhận tại tab <strong>" + TABS.WORKSPACES + "</strong>. Anh/Chị có thể chủ động hỗ trợ khách kết nối Bot/Meta Token trong 24h đầu.</p>",
      rows: rows,
      ctaLabel: "Xem danh sách Workspace",
      ctaUrl: sheetUrl
    }, cfg),
    text: "Workspace moi: " + p.companyName + " | " + p.email + " | " + p.phone
  };
}

function buildBillingCustomerEmail(eventType, p, cfg) {
  var bank = p.bankInfo || {};
  var bankSummary = bank.bank_name
    ? (bank.bank_name + " • STK: " + bank.account_number + " • Chủ TK: " + bank.account_holder)
    : cfg.DEFAULT_BANK_INFO;

  var badge = "THÔNG BÁO THANH TOÁN & GÓI";
  var accent = "#1E40FF";
  var title = "Cập nhật dịch vụ DOMATION AutoData — " + p.companyName;
  var summary = "";
  var ctaLabel = "Mở Quản lý Gói & Ví Topup";
  var category = eventType;

  var rows = [
    { label: "Doanh nghiệp / Workspace", value: p.companyName + " (" + p.slug + ")" },
    { label: "Mã tham chiếu", value: p.refCode },
    { label: "Gói / Dịch vụ", value: p.targetSuiteLabel || p.planName || p.planCode || "Ví Topup AutoData" }
  ];

  if (eventType === "topup_requested") {
    badge = "CHỜ CHUYỂN KHOẢN NẠP VÍ";
    accent = "#F59E0B";
    title = "Hướng dẫn chuyển khoản Nạp Ví Topup (#" + p.refCode + ")";
    summary = "Lệnh nạp ví của <strong>" + escapeHtml(p.companyName) + "</strong> đã được ghi nhận. Vui lòng chuyển khoản đúng số tiền và <strong>nội dung chuyển khoản là Mã tham chiếu " + escapeHtml(p.refCode) + "</strong> để hệ thống đối soát & cộng tiền nhanh nhất.";
    rows.push({ label: "Số tiền cần chuyển", value: formatVnd(p.amountVnd) });
    if (p.bonusVnd > 0) rows.push({ label: "Ưu đãi tặng thêm", value: "+" + formatVnd(p.bonusVnd) });
    if (bankSummary) rows.push({ label: "Thông tin Ngân hàng", value: bankSummary });
    rows.push({ label: "Nội dung chuyển khoản", value: p.refCode });
  } else if (eventType === "topup_approved") {
    badge = "NẠP VÍ TOPUP THÀNH CÔNG";
    accent = "#10B981";
    title = "Ví Topup đã được cộng +" + formatVnd(p.amountVnd + p.bonusVnd) + "!";
    summary = "Giao dịch nạp ví của <strong>" + escapeHtml(p.companyName) + "</strong> đã được xác nhận thành công. Anh/Chị có thể dùng số dư ví để kích hoạt hoặc tự động gia hạn gói hàng tháng/năm bất cứ lúc nào.";
    rows.push({ label: "Số tiền thực nạp", value: formatVnd(p.amountVnd) });
    if (p.bonusVnd > 0) rows.push({ label: "Bonus ưu đãi", value: "+" + formatVnd(p.bonusVnd) });
    if (p.walletBalanceVnd !== undefined) rows.push({ label: "Số dư Ví hiện tại", value: formatVnd(p.walletBalanceVnd) });
  } else if (eventType === "topup_rejected") {
    badge = "GIAO DỊCH CHƯA ĐỐI SOÁT ĐƯỢC";
    accent = "#EF4444";
    title = "Thông báo kiểm tra lại giao dịch #" + p.refCode;
    summary = "Yêu cầu thanh toán mã <strong>" + escapeHtml(p.refCode) + "</strong> hiện chưa được phê duyệt. Nếu Anh/Chị đã chuyển khoản, vui lòng gửi ảnh biên lai qua Zalo hỗ trợ 24/7 để đối soát ngay.";
    if (p.note) rows.push({ label: "Lý do / Ghi chú", value: p.note });
  } else if (eventType === "subscription_requested") {
    badge = "ĐƠN ĐĂNG KÝ / GIA HẠN GÓI (CHỜ TT)";
    accent = "#F59E0B";
    title = "Xác nhận yêu cầu đăng ký gói " + (p.planName || p.planCode);
    summary = "Hệ thống đã ghi nhận yêu cầu đăng ký/gia hạn gói bằng chuyển khoản. Vui lòng chuyển khoản kèm mã <strong>" + escapeHtml(p.refCode) + "</strong> để kích hoạt.";
    rows.push({ label: "Chu kỳ / Thời hạn", value: (p.billingCycle === "annual" ? "Theo Năm (12 tháng)" : "Theo Tháng") + (p.monthsAdded ? " • " + p.monthsAdded + " tháng" : "") });
    rows.push({ label: "Tổng thanh toán", value: formatVnd(p.amountVnd) });
    if (p.discountPct > 0) rows.push({ label: "Ưu đãi gói năm", value: "-" + p.discountPct + "%" });
    if (bankSummary) rows.push({ label: "Thông tin Ngân hàng", value: bankSummary });
    rows.push({ label: "Nội dung chuyển khoản", value: p.refCode });
  } else if (eventType === "crm_erp_upgrade_requested" || eventType === "crm_erp_upgrade_approved") {
    var isApproved = eventType === "crm_erp_upgrade_approved";
    badge = isApproved ? "ĐÃ NÂNG CẤP CRM 360° / ERP 5.0" : "YÊU CẦU NÂNG CẤP CRM / ERP";
    accent = isApproved ? "#10B981" : "#1E40FF";
    title = isApproved
      ? ("Workspace " + p.companyName + " đã mở khóa Hệ sinh thái CRM 360° / ERP 5.0!")
      : ("Tiếp nhận yêu cầu nâng cấp liền mạch lên DOMATION CRM 360° / ERP 5.0");
    summary = isApproved
      ? "Chúc mừng Anh/Chị! Toàn bộ Lead, Pipeline và lịch sử cấu hình AutoData đã được giữ nguyên 100% và nâng cấp lên phân hệ Enterprise."
      : "Yêu cầu nâng cấp từ AutoData sang <strong>DOMATION CRM 360° / ERP 5.0 (Giữ nguyên 100% dữ liệu đang vận hành)</strong> đã được chuyển tới Solution Architect cấp cao để kích hoạt & hỗ trợ chuyển đổi.";
    rows.push({ label: "Ước tính chi phí", value: formatVnd(p.amountVnd) });
    if (p.effectiveExpiresAt) rows.push({ label: "Hiệu lực tới", value: p.effectiveExpiresAt });
  } else if (eventType === "expiry_warning") {
    badge = "NHẮC NHỞ GIA HẠN GÓI DỊCH VỤ";
    accent = "#F59E0B";
    title = "Workspace " + p.companyName + " còn " + (p.daysRemaining !== undefined ? p.daysRemaining : "ít") + " ngày sử dụng";
    var hasEnoughWallet = p.walletBalanceVnd !== undefined && p.requiredAmountVnd !== undefined && Number(p.walletBalanceVnd) >= Number(p.requiredAmountVnd);
    summary = hasEnoughWallet
      ? "Hệ thống ghi nhận Ví Topup của Anh/Chị hiện đủ số dư để <strong>Tự động gia hạn</strong> khi đến hạn, giúp luồng chia số Zalo/Meta CAPI không bao giờ gián đoạn."
      : "Thời hạn gói sắp kết thúc và số dư Ví Topup hiện chưa đủ để tự động gia hạn. Vui lòng nạp thêm hoặc chọn gói Step/Năm để tránh gián đoạn chia Lead về Sale.";
    if (p.effectiveExpiresAt) rows.push({ label: "Ngày hết hạn", value: p.effectiveExpiresAt });
    if (p.walletBalanceVnd !== undefined) rows.push({ label: "Số dư Ví hiện tại", value: formatVnd(p.walletBalanceVnd) });
    if (p.requiredAmountVnd) rows.push({ label: "Phí gia hạn chu kỳ tới", value: formatVnd(p.requiredAmountVnd) });
    if (p.shortfallVnd > 0) rows.push({ label: "Cần nạp tối thiểu", value: formatVnd(p.shortfallVnd) });
    ctaLabel = "Nạp Ví & Gia Hạn Ngay";
  } else if (eventType === "subscription_expired_suspended") {
    badge = "TẠM NGƯNG DO HẾT HẠN GÓI";
    accent = "#EF4444";
    title = "Workspace " + p.companyName + " đã tạm ngưng do hết hạn & thiếu số dư ví";
    summary = "<strong>Cam kết an toàn dữ liệu:</strong> 100% dữ liệu Lead, tài khoản nhân sự và cấu hình Bot của Anh/Chị được bảo toàn nguyên vẹn. Chỉ cần Nạp ví hoặc gia hạn gói, hệ thống sẽ tự mở khóa hoạt động lại ngay lập tức.";
    if (p.requiredAmountVnd) rows.push({ label: "Chi phí mở lại 1 tháng", value: formatVnd(p.requiredAmountVnd) });
    ctaLabel = "Gia Hạn Mở Khóa Workspace";
  } else {
    // subscription_activated, subscription_renewed, auto_renewal_success, plan_upgraded, admin_grant
    badge = eventType === "auto_renewal_success" ? "TỰ ĐỘNG GIA HẠN THÀNH CÔNG" : "KÍCH HOẠT / GIA HẠN GÓI THÀNH CÔNG";
    accent = "#10B981";
    title = "Xác nhận kích hoạt / gia hạn gói " + (p.planName || p.planCode) + " — " + p.companyName;
    summary = eventType === "auto_renewal_success"
      ? "Hệ thống đã tự động trích số dư Ví Topup để gia hạn thêm <strong>" + (p.addedDays || 30) + " ngày</strong> cho Workspace <strong>" + escapeHtml(p.companyName) + "</strong>, đảm bảo luồng Data vận hành liên tục."
      : "Cảm ơn Anh/Chị đã tin tưởng nâng cấp & đồng hành cùng DOMATION AutoData. Thời hạn sử dụng Workspace đã được cộng nối tiếp thành công!";
    rows.push({ label: "Chu kỳ", value: (p.billingCycle === "annual" ? "Gói Năm (-" + p.discountPct + "%)" : "Theo Tháng") });
    if (p.amountVnd > 0) rows.push({ label: "Số tiền thanh toán", value: formatVnd(p.amountVnd) });
    if (p.effectiveExpiresAt) rows.push({ label: "Thời hạn sử dụng mới", value: p.effectiveExpiresAt });
    if (p.walletBalanceVnd !== undefined) rows.push({ label: "Số dư Ví còn lại", value: formatVnd(p.walletBalanceVnd) });
  }

  var html = wrapHtmlEnvelope({
    badge: badge,
    accentColor: accent,
    title: title,
    greeting: "Kính chào Anh/Chị <strong>" + escapeHtml(p.adminName || "Quản trị viên") + "</strong>,",
    summaryHtml: "<p style='margin:0 0 12px;font-size:14px;line-height:1.65;color:#334155'>" + summary + "</p>",
    rows: rows,
    ctaLabel: ctaLabel,
    ctaUrl: cfg.PORTAL_URL,
    secondaryLabel: "Zalo Kế toán / Hỗ trợ",
    secondaryUrl: cfg.ZALO_OA_LINK
  }, cfg);

  return {
    category: category,
    subject: "[" + cfg.BRAND_NAME + "] " + title,
    html: html,
    text: title + " | Workspace: " + p.companyName + " | Ref: " + p.refCode + " | Xem tai: " + cfg.PORTAL_URL
  };
}

function buildAdminBillingAlertEmail(eventType, p, cfg, sheetUrl) {
  var rows = [
    { label: "Loại sự kiện", value: eventType },
    { label: "Trạng thái GD", value: p.txStatus },
    { label: "Mã tham chiếu", value: p.refCode },
    { label: "Doanh nghiệp", value: p.companyName + " (" + p.slug + ")" },
    { label: "Email / SĐT", value: [p.email, p.phone].filter(Boolean).join(" | ") },
    { label: "Gói / Chu kỳ", value: [p.planName, p.billingCycle].filter(Boolean).join(" • ") },
    { label: "Số tiền", value: formatVnd(p.amountVnd) },
    { label: "Hạn / Ví", value: p.expiresOrWallet },
    { label: "Ghi chú", value: p.note },
    { label: "Email gửi khách", value: p.customerMailStatus }
  ];

  var icon = p.txStatus === "pending" ? "💰 [CHỜ DUYỆT]" : (p.txStatus === "suspended" ? "⛔ [TẠM NGƯNG]" : "✅ [BILLING]");
  return {
    subject: icon + " " + p.companyName + " — " + eventType + " (" + formatVnd(p.amountVnd) + ")",
    html: wrapHtmlEnvelope({
      badge: "BILLING HUB • " + eventType.toUpperCase(),
      accentColor: p.txStatus === "pending" ? "#F59E0B" : "#1E40FF",
      title: "Ghi nhận sự kiện Gói & Gia hạn: " + p.companyName,
      greeting: "Admin DOMATION,",
      summaryHtml: "<p style='margin:0 0 10px;font-size:14px;color:#334155'>Chi tiết giao dịch đã lưu tự động vào tab <strong>" + TABS.BILLING + "</strong>.</p>",
      rows: rows,
      ctaLabel: "Mở Sheet Quản Lý Giao Dịch",
      ctaUrl: sheetUrl
    }, cfg),
    text: icon + " " + p.companyName + " | " + eventType + " | " + formatVnd(p.amountVnd) + " | Ref: " + p.refCode
  };
}

function buildTestConnectionEmail(p, cfg) {
  var rows = [
    { label: "Spreadsheet mục tiêu", value: p.spreadsheetName },
    { label: "Email nhận Test", value: p.to },
    { label: "Quota Gmail còn lại", value: String(p.remainingQuota) + " email/ngày" },
    { label: "Thời gian", value: formatNowVN() }
  ];
  return {
    subject: "[" + cfg.BRAND_NAME + "] Kiểm tra kết nối Master Google Sheet & Apps Script thành công!",
    html: wrapHtmlEnvelope({
      badge: "MASTER HUB ACTIVE • TEST OK",
      accentColor: "#10B981",
      title: "Kết nối DOMATION Master Apps Script hoàn hảo!",
      greeting: "Xin chào Admin,",
      summaryHtml: "<p style='margin:0 0 12px;font-size:14px;color:#334155'>Toàn bộ Form Tư vấn trên <strong>domation.net</strong> và hệ thống Email Đăng ký gói / Gia hạn <strong>AutoData</strong> đã kết nối thông suốt với bảng tính Google Sheets trung tâm.</p>",
      rows: rows,
      ctaLabel: "Mở Google Sheet Trung Tâm",
      ctaUrl: p.spreadsheetUrl
    }, cfg),
    text: "Master Apps Script ket noi thanh cong voi Sheet " + p.spreadsheetName + ". Quota con: " + p.remainingQuota
  };
}

/* ============================================================================
 * UTILITY HELPERS
 * ========================================================================== */

function parseIncomingPayload(e) {
  if (e && e.postData && e.postData.contents) {
    try {
      return JSON.parse(e.postData.contents);
    } catch (jsonErr) {
      if (e.parameter && Object.keys(e.parameter).length > 0) {
        return e.parameter;
      }
      return null;
    }
  }
  if (e && e.parameter && Object.keys(e.parameter).length > 0) {
    return e.parameter;
  }
  return null;
}

function normalizeEventType(data) {
  var raw = String(data.event_type || data.action || data.category || data.type || "consultation").trim().toLowerCase();
  if (!raw || raw === "form" || raw === "contact" || raw === "lead") return "consultation";
  if (raw === "register" || raw === "signup") return "workspace_registered";
  return raw;
}

function isBillingEventType(eventType) {
  return [
    "topup_requested",
    "topup_approved",
    "topup_rejected",
    "subscription_requested",
    "subscription_activated",
    "subscription_renewed",
    "auto_renewal_success",
    "plan_upgraded",
    "admin_grant",
    "crm_erp_upgrade_requested",
    "crm_erp_upgrade_approved",
    "expiry_warning",
    "subscription_expired_suspended"
  ].indexOf(eventType) !== -1;
}

function inferTxStatusFromEvent(eventType) {
  if (eventType.indexOf("requested") !== -1) return "pending";
  if (eventType.indexOf("rejected") !== -1) return "rejected";
  if (eventType === "expiry_warning") return "warning";
  if (eventType.indexOf("suspended") !== -1) return "suspended";
  if (eventType.indexOf("approved") !== -1) return "approved";
  return "completed";
}

function isDuplicateSubmission(eventType, data) {
  try {
    var cache = CacheService.getScriptCache();
    var fingerprintParts = [
      eventType,
      cleanStr(data.email || "").toLowerCase(),
      cleanStr(data.phone || ""),
      cleanStr(data.reference_code || ""),
      cleanStr(data.tenant_slug || ""),
      cleanStr(data.source_form || "")
    ].join("|");
    var digest = Utilities.base64EncodeWebSafe(
      Utilities.computeDigest(Utilities.DigestAlgorithm.MD5, fingerprintParts)
    );
    var key = "dedup_" + digest.slice(0, 28);
    if (cache.get(key)) return true;
    cache.put(key, "1", 15);
    return false;
  } catch (e) {
    return false;
  }
}

function buildUtmSummary(data) {
  var utm = data.utm || {};
  var parts = [
    data.utm_source || utm.utm_source,
    data.utm_medium || utm.utm_medium,
    data.utm_campaign || utm.utm_campaign
  ].filter(Boolean);
  return parts.join(" / ");
}

function buildExpiryWalletSummary(data) {
  var parts = [];
  if (data.effective_expires_at || data.new_expires_at) {
    parts.push("Hạn: " + formatIsoOrTextVN(data.effective_expires_at || data.new_expires_at));
  }
  if (data.wallet_balance_vnd !== undefined && data.wallet_balance_vnd !== null && data.wallet_balance_vnd !== "") {
    parts.push("Ví: " + formatVnd(data.wallet_balance_vnd));
  }
  return parts.join(" | ");
}

function generateCode(prefix) {
  var d = Utilities.formatDate(new Date(), "Asia/Ho_Chi_Minh", "yyMMdd");
  var rand = Math.random().toString(36).substring(2, 6).toUpperCase();
  return (prefix || "DOM") + "-" + d + "-" + rand;
}

function formatNowVN() {
  return Utilities.formatDate(new Date(), "Asia/Ho_Chi_Minh", "dd/MM/yyyy HH:mm:ss");
}

function formatIsoOrTextVN(val) {
  var s = cleanStr(val);
  if (!s) return "";
  try {
    var dt = new Date(s);
    if (!isNaN(dt.getTime())) {
      return Utilities.formatDate(dt, "Asia/Ho_Chi_Minh", "dd/MM/yyyy HH:mm");
    }
  } catch (e) {}
  return s;
}

function formatVnd(n) {
  var num = Math.round(Number(n || 0));
  return num.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ".") + " ₫";
}

function cleanStr(v) {
  if (v === undefined || v === null) return "";
  return String(v).trim();
}

function isValidEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(cleanStr(email));
}

function safeRemainingQuota() {
  try { return MailApp.getRemainingDailyQuota(); } catch (e) { return -1; }
}

function safeJsonTruncated(obj) {
  try {
    var s = JSON.stringify(obj);
    return s.length > 4000 ? s.slice(0, 4000) + "...(truncated)" : s;
  } catch (e) {
    return "";
  }
}

function formatError(err) {
  return err && err.toString ? err.toString() : String(err);
}

function escapeHtml(str) {
  return cleanStr(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function jsonResponse(payload) {
  return ContentService
    .createTextOutput(JSON.stringify(payload))
    .setMimeType(ContentService.MimeType.JSON);
}
