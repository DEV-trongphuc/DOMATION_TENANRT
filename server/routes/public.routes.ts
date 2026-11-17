import crypto from 'node:crypto';
import { Router } from 'express';
import { APP_CONFIG } from '../config.ts';
import { withSystemPrivilege } from '../core/database/transaction.ts';
import { sendApiError } from '../core/security/rbac.ts';
import { notifyPlatformConsultation } from '../services/platform-appscript.service.ts';

export const publicRouter = Router();

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const recentConsultCache = new Map<string, number>();

export function resetConsultationDedupCacheForTests(): void {
  recentConsultCache.clear();
}

function cleanText(v: unknown, maxLen = 500): string {
  if (v === undefined || v === null) return '';
  return String(v).trim().slice(0, maxLen);
}

function generateLeadCode(): string {
  const now = new Date();
  const y = String(now.getFullYear()).slice(-2);
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  const rand = crypto.randomBytes(2).toString('hex').toUpperCase();
  return `DOM-${y}${m}${d}-${rand}`;
}

function checkDedup(key: string): boolean {
  const now = Date.now();
  for (const [k, exp] of recentConsultCache.entries()) {
    if (exp <= now) recentConsultCache.delete(k);
  }
  const existing = recentConsultCache.get(key);
  if (existing && existing > now) return true;
  recentConsultCache.set(key, now + 15_000);
  return false;
}

async function pingPlatformTelegramConsultation(payload: {
  leadCode: string;
  sourceForm: string;
  name: string;
  phone: string;
  email: string;
  company: string;
  service: string;
  budgetOrScale: string;
  message: string;
}): Promise<void> {
  if (
    !APP_CONFIG.telegramNotifyEnabled ||
    APP_CONFIG.telegramSilentMode ||
    !APP_CONFIG.telegramBotToken ||
    !APP_CONFIG.telegramChatId
  ) {
    return;
  }
  const lines = [
    `🔥 <b>[DOMATION LEAD TƯ VẤN MỚI #${payload.leadCode}]</b>`,
    `• <b>Nguồn:</b> ${payload.sourceForm}`,
    `• <b>Khách hàng:</b> ${payload.name}`,
    payload.phone ? `• <b>SĐT / Zalo:</b> ${payload.phone}` : '',
    payload.email ? `• <b>Email:</b> ${payload.email}` : '',
    payload.company ? `• <b>DN / Web:</b> ${payload.company}` : '',
    `• <b>Giải pháp:</b> ${payload.service}`,
    payload.budgetOrScale ? `• <b>Quy mô / Giá:</b> ${payload.budgetOrScale}` : '',
    payload.message ? `• <b>Nhu cầu:</b> ${payload.message}` : '',
  ]
    .filter(Boolean)
    .join('\n');

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 5_000);
  try {
    await fetch(`https://api.telegram.org/bot${APP_CONFIG.telegramBotToken}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: APP_CONFIG.telegramChatId,
        text: lines,
        parse_mode: 'HTML',
        disable_web_page_preview: true,
      }),
      signal: controller.signal,
    });
  } catch {
    // Non-blocking notification
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Unified Public Consultation Intake across ALL DOMATION landing pages & modals:
 * - Saves to PostgreSQL/MariaDB `platform_consultations`
 * - Dispatches to Master Google Apps Script (Sheet `Tu_Van_Form` + Thank-you Email + Admin Alert)
 */
publicRouter.post('/consultation', async (req, res) => {
  try {
    const body = (req.body && typeof req.body === 'object' ? req.body : {}) as Record<string, unknown>;

    const rawName = cleanText(body.name || body.full_name || body.contact_name, 150);
    const email = cleanText(body.email, 255).toLowerCase();
    const rawPhone = cleanText(body.phone || body.zalo, 40);
    const phoneDigits = rawPhone.replace(/[^0-9+]/g, '');
    const company = cleanText(body.company || body.website, 255);
    const service = cleanText(
      body.service || body.product_interest || body.source_title || 'Tư vấn Giải pháp DOMATION',
      255
    );
    const budgetOrScale = cleanText(
      body.budget_or_scale ||
        body.volume ||
        body.size ||
        (body.total_price_vnd ? `${Number(body.total_price_vnd).toLocaleString('vi-VN')} VNĐ` : ''),
      255
    );
    const addonsSummary = cleanText(body.addons_summary, 500);
    const message = cleanText(body.message || body.note || body.problem, 2000);
    const sourceForm = cleanText(body.source_form || body.source || body.page_path || 'domation.net', 150);
    const pagePath = cleanText(body.page_path, 255);
    const pageUrl = cleanText(body.page_url || req.headers.referer, 1000);
    const utmSource = cleanText(body.utm_source, 120);
    const utmMedium = cleanText(body.utm_medium, 120);
    const utmCampaign = cleanText(body.utm_campaign, 120);
    const totalPriceVnd = body.total_price_vnd ? Number(body.total_price_vnd) || 0 : undefined;

    if (email && !EMAIL_REGEX.test(email)) {
      sendApiError(res, 422, 'INVALID_EMAIL', 'Địa chỉ Email chưa đúng định dạng.');
      return;
    }

    if (!email && phoneDigits.length < 8) {
      sendApiError(
        res,
        422,
        'CONTACT_REQUIRED',
        'Vui lòng cung cấp Email hoặc Số điện thoại / Zalo hợp lệ để đội ngũ liên hệ.'
      );
      return;
    }

    const name = rawName || (company || (email ? email.split('@')[0] : 'Quý khách'));
    const dedupKey = `${sourceForm}|${email}|${phoneDigits}`;
    if (checkDedup(dedupKey)) {
      res.status(200).json({
        success: true,
        data: {
          deduplicated: true,
          message: 'Yêu cầu của bạn vừa được hệ thống tiếp nhận.',
        },
      });
      return;
    }

    const leadCode = generateLeadCode();
    const recordId = crypto.randomUUID();
    const clientIp = String(req.headers['x-forwarded-for'] || req.ip || '').split(',')[0].trim().slice(0, 64);

    const metadataObj = {
      ...(body.metadata && typeof body.metadata === 'object' ? (body.metadata as Record<string, unknown>) : {}),
      ...(addonsSummary ? { addons_summary: addonsSummary } : {}),
      ...(totalPriceVnd ? { total_price_vnd: totalPriceVnd } : {}),
      user_agent: cleanText(req.headers['user-agent'], 300),
    };

    const dispatchResult = await notifyPlatformConsultation({
      lead_code: leadCode,
      name,
      email,
      phone: rawPhone,
      company,
      service,
      budget_or_scale: budgetOrScale,
      addons_summary: addonsSummary,
      total_price_vnd: totalPriceVnd,
      message,
      source_form: sourceForm,
      page_path: pagePath,
      page_url: pageUrl,
      utm_source: utmSource,
      utm_medium: utmMedium,
      utm_campaign: utmCampaign,
      metadata: metadataObj,
    });

    const appscriptStatus = dispatchResult.skippedReason
      ? `skipped:${dispatchResult.skippedReason}`
      : dispatchResult.success
        ? 'dispatched'
        : 'failed';

    await withSystemPrivilege(async (client) => {
      await client.query(
        `INSERT INTO platform_consultations (
           id, lead_code, source_form, page_path, page_url, name, email, phone,
           company, service, budget_or_scale, message, utm_source, utm_medium, utm_campaign,
           metadata, appscript_status, appscript_response, client_ip
         ) VALUES (
           $1, $2, $3, $4, $5, $6, $7, $8,
           $9, $10, $11, $12, $13, $14, $15,
           $16::jsonb, $17, $18::jsonb, $19
         )`,
        [
          recordId,
          leadCode,
          sourceForm,
          pagePath || null,
          pageUrl || null,
          name,
          email || null,
          rawPhone || null,
          company || null,
          service || null,
          budgetOrScale || null,
          message || null,
          utmSource || null,
          utmMedium || null,
          utmCampaign || null,
          JSON.stringify(metadataObj),
          appscriptStatus,
          JSON.stringify(dispatchResult.response || { error: dispatchResult.error || null }),
          clientIp || null,
        ]
      );
    });

    void pingPlatformTelegramConsultation({
      leadCode,
      sourceForm,
      name,
      phone: rawPhone,
      email,
      company,
      service,
      budgetOrScale,
      message: addonsSummary ? `${addonsSummary}${message ? ` | ${message}` : ''}` : message,
    });

    res.status(201).json({
      success: true,
      data: {
        id: recordId,
        lead_code: leadCode,
        saved_to_db: true,
        sheets_dispatched: dispatchResult.success,
        appscript_status: appscriptStatus,
        customer_mail_status: dispatchResult.response?.customer_mail_status || null,
      },
    });
  } catch (err: any) {
    sendApiError(
      res,
      500,
      'CONSULTATION_SUBMIT_FAILED',
      err?.message || 'Không thể tiếp nhận yêu cầu tư vấn lúc này.'
    );
  }
});
