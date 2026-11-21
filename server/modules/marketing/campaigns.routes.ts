import crypto from 'node:crypto';
import { Router, type Request, type Response } from 'express';
import { withTenantTransaction } from '../../core/database/transaction.ts';
import { getTenantContext } from '../../core/context/tenant-context.ts';
import { getTenantSettingsCached } from '../../core/settings/tenant-cache.ts';
import {
  requireEntitlement,
  requirePermission,
  sendApiError,
} from '../../core/security/rbac.ts';
import { maskContactPiiIfDisallowed } from '../../core/security/pii-masker.ts';
import {
  loadEmailTenantStateForCampaign,
  sendTenantEmailNotification,
} from '../../services/zalo-mail.service.ts';
import { compileSegmentWhereSql } from '../audiences/segment-compiler.ts';
import {
  analyzeEmailSpamScore,
  buildSuppressionSet,
  canUserUnmaskMarketingPii,
  compileEmailBlocksToHtml,
  injectEmailOpenAndClickTracking,
  isRecipientSuppressed,
  normalizeSuppressionRecipient,
  parseJsonCol,
  readTenantChannelVault,
  renderMergeTags,
  resolvePublicRequestOrigin,
  signUnsubscribeHmac,
  stripHtmlTagsForPlainText,
  type EmailBlockDto,
  type EmailBodyStyleDto,
} from './utils.ts';
import {
  AUTOMATION_EMAIL_PROVIDERS,
  buildCampaignMergeContext,
  dispatchCampaignBatchHighSpeed,
  dispatchMarketingEmail,
  dispatchZnsNotification,
  extractCampaignStatsJson,
  isCampaignOutboundSilent,
  isWithinZnsAllowedWindow,
  readAutomationEmailReadiness,
} from './dispatchers.ts';

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function normalizeScheduledAtIso(raw: unknown): { iso: string | null; invalid: boolean } {
  if (raw === null || raw === undefined || String(raw).trim() === '') {
    return { iso: null, invalid: false };
  }
  const str = String(raw).trim();
  const d = new Date(str);
  if (Number.isNaN(d.getTime())) {
    return { iso: null, invalid: true };
  }
  return { iso: d.toISOString(), invalid: false };
}

function sendProviderRequiredError(res: Response, usesAppscriptOnly: boolean, customMessage?: string): void {
  const msg =
    customMessage ||
    (usesAppscriptOnly
      ? 'Marketing Automation không hỗ trợ Google Apps Script (chỉ dùng cho thông báo CRM nội bộ). Vui lòng cấu hình cổng gửi Email chuyên dụng (AWS SES, SMTP, Resend, SendGrid hoặc Postmark) tại Cài đặt → Cấu hình Email.'
      : 'Chưa cấu hình cổng gửi Email chuyên dụng cho Marketing Automation. Vui lòng kết nối AWS SES, SMTP, Resend, SendGrid hoặc Postmark tại Cài đặt → Cấu hình Email (không dùng Google Apps Script).');
  res.status(422).json({
    success: false,
    error: {
      code: 'AUTOMATION_EMAIL_PROVIDER_REQUIRED',
      message: msg,
      details: [
        {
          field: 'email_provider',
          issue: usesAppscriptOnly
            ? 'APPSCRIPT_NOT_SUPPORTED_FOR_AUTOMATION'
            : 'DEDICATED_EMAIL_PROVIDER_NOT_CONFIGURED',
        },
      ],
    },
    meta: {
      email_provider_ready: false,
      active_provider: null,
      uses_appscript_only: usesAppscriptOnly,
      supported_providers: [...AUTOMATION_EMAIL_PROVIDERS],
      settings_url: '/settings?tab=email_config',
    },
  });
}

export const campaignsRouter = Router();

campaignsRouter.use(requireEntitlement('mkt_campaigns'));

function mapCampaignRow(row: Record<string, unknown>) {
  const sentCount = Number(row.sent_count || 0);
  const openedCount = Number(row.opened_count || 0);
  const clickedCount = Number(row.clicked_count || 0);
  const bouncedCount = Number(row.bounced_count || 0);
  const unsubscribedCount = Number(row.unsubscribed_count || 0);
  const totalTargeted = Number(row.total_targeted || 0);
  const costVnd = Number(row.cost_vnd || 0);
  const revenueVnd = Number(row.attributed_revenue_vnd || 0);
  const rawFallbackVars = parseJsonCol<Record<string, unknown>>(row.fallback_vars_json, {});
  const attachments = Array.isArray(rawFallbackVars._attachments) ? rawFallbackVars._attachments : [];
  const statsJson = extractCampaignStatsJson(row);
  const targetMeta =
    rawFallbackVars._target && typeof rawFallbackVars._target === 'object'
      ? (rawFallbackVars._target as Record<string, unknown>)
      : null;
  const configMeta =
    rawFallbackVars._config && typeof rawFallbackVars._config === 'object'
      ? (rawFallbackVars._config as Record<string, unknown>)
      : {};
  const contentBody = typeof rawFallbackVars._content_body === 'string' ? rawFallbackVars._content_body : '';
  const channel = String(row.channel || 'email') as 'email' | 'zns' | 'multi';
  const subjectA = String(row.subject_a || '');

  return {
    id: String(row.id),
    tenant_id: String(row.tenant_id),
    name: String(row.name || ''),
    channel,
    type: channel === 'zns' ? 'zalo_zns' : 'email',
    status: String(row.status || 'draft'),
    audience_id: row.audience_id ? String(row.audience_id) : null,
    audience_name: row.audience_name ? String(row.audience_name) : null,
    audience_type: row.audience_type ? String(row.audience_type) : null,
    exclude_audience_ids: parseJsonCol<string[]>(row.exclude_audience_ids, []),
    template_id: row.template_id ? String(row.template_id) : null,
    templateId: row.template_id ? String(row.template_id) : row.zns_template_id ? String(row.zns_template_id) : '',
    template_name: row.template_name ? String(row.template_name) : null,
    subject_a: subjectA,
    subject: subjectA,
    subject_b: String(row.subject_b || ''),
    ab_split_ratio: Number(row.ab_split_ratio ?? 100),
    ab_winner_criteria: String(row.ab_winner_criteria || 'open_rate'),
    ab_test_hours: Number(row.ab_test_hours ?? 4),
    zns_template_id: row.zns_template_id ? String(row.zns_template_id) : '',
    sender_name: row.sender_name ? String(row.sender_name) : '',
    senderName: row.sender_name ? String(row.sender_name) : '',
    sender_email: row.sender_email ? String(row.sender_email) : '',
    senderEmail: row.sender_email ? String(row.sender_email) : '',
    fallback_vars: rawFallbackVars,
    attachments,
    contentBody,
    target: targetMeta || {
      listIds: row.audience_id ? [String(row.audience_id)] : [],
      segmentIds: [],
      tagIds: [],
      individualIds: [],
    },
    config: configMeta,
    throttle_per_minute: Number(row.throttle_per_minute || 0),
    pre_send_score: Number(row.pre_send_score ?? 100),
    reminder_config: parseJsonCol<Record<string, unknown>>(row.reminder_config, {}),
    scheduled_at: row.scheduled_at || null,
    scheduledAt: row.scheduled_at || undefined,
    sent_at: row.sent_at || null,
    sentAt: row.sent_at || undefined,
    total_targeted: totalTargeted,
    totalTargetAudience: Math.max(totalTargeted, statsJson.total_target),
    sent_count: sentCount,
    opened_count: openedCount,
    clicked_count: clickedCount,
    bounced_count: bouncedCount,
    unsubscribed_count: unsubscribedCount,
    open_rate_pct: sentCount > 0 ? Number(((openedCount / sentCount) * 100).toFixed(1)) : 0,
    click_rate_pct: sentCount > 0 ? Number(((clickedCount / sentCount) * 100).toFixed(1)) : 0,
    stats_json: statsJson,
    stats: {
      sent: sentCount,
      opened: openedCount,
      clicked: clickedCount,
      bounced: bouncedCount,
      spam: 0,
      unsubscribed: unsubscribedCount,
      failed: statsJson.failed,
      progress_pct: statsJson.progress_pct,
      rate_per_sec: statsJson.rate_per_sec,
      eta_seconds: statsJson.eta_seconds,
      max_send_rate: statsJson.max_send_rate,
      provider: statsJson.provider,
    },
    progress_pct: statsJson.progress_pct,
    rate_per_sec: statsJson.rate_per_sec,
    eta_seconds: statsJson.eta_seconds,
    cost_vnd: costVnd,
    attributed_revenue_vnd: revenueVnd,
    roi_multiple: costVnd > 0 ? Number((revenueVnd / costVnd).toFixed(2)) : 0,
    created_at: row.created_at,
    createdAt: row.created_at,
    updated_at: row.updated_at,
  };
}

function buildLightweightProgressPayload(row: Record<string, unknown>) {
  const statsJson = extractCampaignStatsJson(row);
  const totalTarget = Math.max(Number(row.total_targeted || 0), statsJson.total_target);
  return {
    id: String(row.id),
    status: String(row.status || 'draft'),
    total_target: totalTarget,
    totalTargetAudience: totalTarget,
    sent: statsJson.sent,
    failed: statsJson.failed,
    opened: statsJson.opened,
    clicked: statsJson.clicked,
    bounced: statsJson.bounced,
    unsubscribed: statsJson.unsubscribed,
    progress_pct: statsJson.progress_pct,
    rate_per_sec: statsJson.rate_per_sec,
    eta_seconds: statsJson.eta_seconds,
    sending_started_at: statsJson.sending_started_at,
    last_dispatched_at: statsJson.last_dispatched_at,
    provider: statsJson.provider,
    max_send_rate: statsJson.max_send_rate,
    sent_at: row.sent_at || null,
    sentAt: row.sent_at || undefined,
    scheduled_at: row.scheduled_at || null,
    scheduledAt: row.scheduled_at || undefined,
    updated_at: row.updated_at,
    stats_json: statsJson,
    stats: {
      sent: statsJson.sent,
      opened: statsJson.opened,
      clicked: statsJson.clicked,
      bounced: statsJson.bounced,
      spam: 0,
      unsubscribed: statsJson.unsubscribed,
      failed: statsJson.failed,
      progress_pct: statsJson.progress_pct,
      rate_per_sec: statsJson.rate_per_sec,
      eta_seconds: statsJson.eta_seconds,
      max_send_rate: statsJson.max_send_rate,
      provider: statsJson.provider,
    },
  };
}

// SesQuotaWidget & Provider Readiness: Real-time Dedicated Automation Email Quota & Deliverability Health
campaignsRouter.get('/ses-quota', requirePermission('mkt_campaigns', 'view'), async (_req, res) => {
  try {
    const ctx = getTenantContext();
    const data = await withTenantTransaction(ctx.tenantId, async (client) => {
      const [readiness, claimStats, supCnt] = await Promise.all([
        readAutomationEmailReadiness(client, ctx.tenantId),
        client.query<{ sent_cnt: number; bounce_cnt: number; complaint_cnt: number; unsub_cnt: number }>(
          `SELECT COALESCE(SUM(CASE WHEN status IN ('sent', 'delivered', 'opened', 'clicked', 'bounced', 'complained', 'unsubscribed') THEN 1 ELSE 0 END), 0)::int AS sent_cnt,
                  COALESCE(SUM(CASE WHEN status = 'bounced' THEN 1 ELSE 0 END), 0)::int AS bounce_cnt,
                  COALESCE(SUM(CASE WHEN status = 'complained' THEN 1 ELSE 0 END), 0)::int AS complaint_cnt,
                  COALESCE(SUM(CASE WHEN status = 'unsubscribed' THEN 1 ELSE 0 END), 0)::int AS unsub_cnt
           FROM mkt_send_claims
           WHERE tenant_id = $1`,
          [ctx.tenantId]
        ),
        client.query<{ cnt: number }>(
          'SELECT COUNT(*)::int AS cnt FROM mkt_suppression_list WHERE tenant_id = $1',
          [ctx.tenantId]
        ),
      ]);

      const max24hSend = Number(readiness.vaultConfig.max_24h_send || (readiness.email_provider_ready ? 50_000 : 200));
      const maxSendRate = readiness.max_send_rate_per_sec;
      const sentCnt = Number(claimStats.rows[0]?.sent_cnt || 0);
      const bounceCnt = Number(claimStats.rows[0]?.bounce_cnt || 0);
      const complaintCnt = Number(claimStats.rows[0]?.complaint_cnt || 0);
      const bounceRatePct = sentCnt > 0 ? Number(((bounceCnt / sentCnt) * 100).toFixed(2)) : 0;
      const complaintRatePct = sentCnt > 0 ? Number(((complaintCnt / sentCnt) * 100).toFixed(2)) : 0;

      const remaining24h = Math.max(0, max24hSend - sentCnt);
      const usagePct = max24hSend > 0 ? Number(Math.min(100, (sentCnt / max24hSend) * 100).toFixed(1)) : 0;
      const reputationStatus = bounceRatePct >= 5 ? 'at_risk' : bounceRatePct >= 2 ? 'warning' : 'healthy';

      return {
        email_provider_ready: readiness.email_provider_ready,
        active_provider: readiness.active_provider,
        uses_appscript_only: readiness.uses_appscript_only,
        supported_providers: [...AUTOMATION_EMAIL_PROVIDERS],
        settings_url: '/settings?tab=email_config',
        configured: readiness.email_provider_ready,
        provider: readiness.active_provider || 'sandbox',
        sandbox_mode: !readiness.email_provider_ready || readiness.sandbox_mode,
        from_email: readiness.fromEmail,
        max_24h_send: max24hSend,
        sent_last_24h: sentCnt,
        remaining_24h: remaining24h,
        usage_pct: usagePct,
        max_send_rate_per_sec: maxSendRate,
        bounce_rate_pct: bounceRatePct,
        complaint_rate_pct: complaintRatePct,
        reputation_status: reputationStatus,
        is_ses: readiness.active_provider === 'aws_ses',
        region: readiness.region,
        smtp_host: readiness.smtpHost,
        overall_status: !readiness.email_provider_ready ? 'not_configured' : reputationStatus,
        local: {
          sent_1h: 0,
          max_per_hour: max24hSend,
          limit_per_hour: max24hSend,
        },
        aws: {
          remaining: remaining24h,
          usage_pct: usagePct,
          max_24h: max24hSend,
          sent_24h: sentCnt,
          max_rate: maxSendRate,
          is_fallback: !readiness.email_provider_ready,
        },
        spf_verified: readiness.spfVerified,
        dkim_verified: readiness.dkimVerified,
        dmarc_verified: readiness.dmarcVerified,
        suppression_count: Number(supCnt.rows[0]?.cnt || 0),
      };
    });
    res.json({ success: true, data });
  } catch (err: any) {
    sendApiError(res, 500, 'SES_QUOTA_FAILED', err?.message || 'Không thể tải hạn mức gửi Email SES.');
  }
});

// Dedicated Provider Readiness Endpoint (used by CampaignWizard, PreSendReviewModal & TestEmailModal)
campaignsRouter.get('/readiness', requirePermission('mkt_campaigns', 'view'), async (_req, res) => {
  try {
    const ctx = getTenantContext();
    const data = await withTenantTransaction(ctx.tenantId, async (client) => {
      const [emailReadiness, znsVault] = await Promise.all([
        readAutomationEmailReadiness(client, ctx.tenantId),
        readTenantChannelVault(client, ctx.tenantId, ['zalo_zns', 'zalo_oa']),
      ]);
      return {
        email_provider_ready: emailReadiness.email_provider_ready,
        active_provider: emailReadiness.active_provider,
        uses_appscript_only: emailReadiness.uses_appscript_only,
        max_send_rate_per_sec: emailReadiness.max_send_rate_per_sec,
        sandbox_mode: emailReadiness.sandbox_mode,
        from_email: emailReadiness.fromEmail,
        spf_verified: emailReadiness.spfVerified,
        dkim_verified: emailReadiness.dkimVerified,
        dmarc_verified: emailReadiness.dmarcVerified,
        zns_ready: znsVault.configured,
        zns_provider: znsVault.integrationType,
        zns_window_open: isWithinZnsAllowedWindow(),
        supported_providers: [...AUTOMATION_EMAIL_PROVIDERS],
        settings_url: '/settings?tab=email_config',
      };
    });
    res.json({ success: true, data });
  } catch (err: any) {
    sendApiError(res, 500, 'READINESS_FAILED', err?.message || 'Không thể kiểm tra cấu hình kênh gửi.');
  }
});

// PreSendReviewModal: Pre-Flight SPF/DKIM, Provider Readiness, Audience Net Reachable, Spam & Fallback Check
async function runPreSendReviewForPayload(tenantId: string, payload: Record<string, unknown>, campaignId?: string) {
  return withTenantTransaction(tenantId, async (client) => {
    let campRow: Record<string, unknown> | undefined;
    if (campaignId) {
      const r = await client.query('SELECT * FROM mkt_campaigns WHERE tenant_id = $1 AND id = $2 LIMIT 1', [
        tenantId,
        campaignId,
      ]);
      campRow = r.rows[0];
    }

    const rawChannel = String(payload.channel || payload.type || campRow?.channel || 'email').toLowerCase();
    const channel = rawChannel === 'zalo_zns' || rawChannel === 'zns' ? 'zns' : rawChannel === 'multi' ? 'multi' : 'email';
    const audienceId = payload.audience_id !== undefined ? payload.audience_id : campRow?.audience_id;
    const excludeAudIds: string[] = Array.isArray(payload.exclude_audience_ids)
      ? payload.exclude_audience_ids.map(String)
      : parseJsonCol<string[]>(campRow?.exclude_audience_ids, []);
    const templateId = payload.template_id !== undefined ? payload.template_id : payload.templateId ?? campRow?.template_id;
    const subjectA = String(payload.subject_a || payload.subject || campRow?.subject_a || '');
    const throttlePerMin = Number(payload.throttle_per_minute ?? campRow?.throttle_per_minute ?? 0);
    const fallbackVars: Record<string, string> =
      payload.fallback_vars && typeof payload.fallback_vars === 'object'
        ? (payload.fallback_vars as Record<string, string>)
        : parseJsonCol<Record<string, string>>(campRow?.fallback_vars_json, {});

    const [emailVault, znsVault, supRes] = await Promise.all([
      readAutomationEmailReadiness(client, tenantId),
      readTenantChannelVault(client, tenantId, ['zalo_zns', 'zalo_oa']),
      client.query<{ cnt: number }>(
        'SELECT COUNT(*)::int AS cnt FROM mkt_suppression_list WHERE tenant_id = $1',
        [tenantId]
      ),
    ]);

    let audienceCount = 0;
    let excludedCount = 0;
    if (audienceId && UUID_REGEX.test(String(audienceId))) {
      const aCnt = await client.query<{ cnt: number }>(
        'SELECT COUNT(*)::int AS cnt FROM tenant_audience_members WHERE tenant_id = $1 AND audience_id = $2',
        [tenantId, String(audienceId)]
      );
      audienceCount = Number(aCnt.rows[0]?.cnt || 0);
      if (excludeAudIds.length > 0) {
        const ph = excludeAudIds.map((_, idx) => `$${idx + 3}`).join(', ');
        const exCnt = await client.query<{ cnt: number }>(
          `SELECT COUNT(DISTINCT lead_id)::int AS cnt
           FROM tenant_audience_members
           WHERE tenant_id = $1 AND audience_id = $2
             AND lead_id IN (SELECT lead_id FROM tenant_audience_members WHERE tenant_id = $1 AND audience_id IN (${ph}))`,
          [tenantId, String(audienceId), ...excludeAudIds]
        );
        excludedCount = Number(exCnt.rows[0]?.cnt || 0);
      }
    } else {
      const allCnt = await client.query<{ cnt: number }>(
        'SELECT COUNT(*)::int AS cnt FROM leads WHERE tenant_id = $1 AND is_deleted = false',
        [tenantId]
      );
      audienceCount = Number(allCnt.rows[0]?.cnt || 0);
    }

    let blocks: EmailBlockDto[] = [];
    let compiledHtml = '';
    if (templateId && UUID_REGEX.test(String(templateId))) {
      const tRes = await client.query(
        'SELECT blocks_json, compiled_html FROM mkt_email_templates WHERE tenant_id = $1 AND id = $2 LIMIT 1',
        [tenantId, String(templateId)]
      );
      if (tRes.rows[0]) {
        blocks = parseJsonCol<EmailBlockDto[]>(tRes.rows[0].blocks_json, []);
        compiledHtml = String(tRes.rows[0].compiled_html || '');
      }
    }

    const spam = analyzeEmailSpamScore(subjectA, blocks, compiledHtml || '{{unsubscribe_url}}');
    const detectedMergeTags = Array.from(
      new Set(
        (`${subjectA} ${compiledHtml}`.match(/\{\{\s*([a-zA-Z0-9_.-]+)\s*\}\}/g) || []).map((t) =>
          t.replace(/\s+/g, '')
        )
      )
    ).filter((t) => t !== '{{unsubscribe_url}}' && t !== '{{tenant.name}}');

    const missingFallbacks = detectedMergeTags.filter((tag) => {
      const raw = tag.slice(2, -2);
      const leaf = raw.split('.').pop() || raw;
      return !fallbackVars[tag] && !fallbackVars[raw] && !fallbackVars[leaf];
    });

    const suppressionCount = Number(supRes.rows[0]?.cnt || 0);
    const netReachable = Math.max(0, audienceCount - excludedCount);
    const effectiveRate =
      throttlePerMin > 0
        ? Math.min(emailVault.max_send_rate_per_sec, Math.max(1, throttlePerMin / 60))
        : emailVault.max_send_rate_per_sec || 14;
    const estSeconds = netReachable > 0 ? Math.max(1, Math.ceil(netReachable / effectiveRate)) : 0;
    const estMinutes = estSeconds > 0 ? Math.max(1, Math.ceil(estSeconds / 60)) : 1;
    const readinessScore = Math.max(0, Math.min(100, 100 - spam.score - (missingFallbacks.length > 0 ? 5 : 0)));

    return {
      readiness_score: readinessScore,
      ready_to_send: readinessScore >= 50,
      channel,
      email_provider_ready: emailVault.email_provider_ready,
      active_provider: emailVault.active_provider,
      uses_appscript_only: emailVault.uses_appscript_only,
      max_send_rate_per_sec: emailVault.max_send_rate_per_sec,
      settings_url: '/settings?tab=email_config',
      // Legacy boolean preserved for existing compat checks; Automation launch strictly gates on `email_provider_ready`
      vault_ready:
        channel === 'zns' ? znsVault.configured : emailVault.email_provider_ready || emailVault.uses_appscript_only,
      spf_dkim_verified: emailVault.dkimVerified,
      zns_window_open: isWithinZnsAllowedWindow(),
      audience_total: audienceCount,
      excluded_count: excludedCount,
      suppression_list_count: suppressionCount,
      net_reachable_estimate: netReachable,
      throttle_per_minute: throttlePerMin,
      estimated_duration_seconds: estSeconds,
      estimated_duration_minutes: estMinutes,
      spam_analysis: spam,
      detected_merge_tags: detectedMergeTags,
      missing_fallback_tags: missingFallbacks,
    };
  });
}

campaignsRouter.post('/pre-send-review', requirePermission('mkt_campaigns', 'view'), async (req, res) => {
  try {
    const ctx = getTenantContext();
    const data = await runPreSendReviewForPayload(ctx.tenantId, req.body || {});
    res.json({ success: true, data });
  } catch (err: any) {
    sendApiError(res, 500, 'PRE_SEND_REVIEW_FAILED', err?.message || 'Không thể kiểm tra chiến dịch trước khi gửi.');
  }
});

// TestEmailModal: Preview & Test Dispatch to Sample Recipients (ZERO TX held during SMTP/SES!)
async function runCampaignTestEmail(
  tenantId: string,
  userName: string | undefined,
  payload: Record<string, unknown>,
  campaignId?: string
) {
  const testPhone = String(payload.phone || '').trim();
  const rawEmails: string[] = Array.isArray(payload.emails)
    ? payload.emails.map((e) => String(e || '').trim()).filter((e) => e.includes('@'))
    : String(payload.to_email || payload.email || '')
        .split(/[,;\s]+/)
        .map((e) => e.trim())
        .filter((e) => e.includes('@'));

  if (rawEmails.length === 0 && !testPhone) {
    return { error: 'INVALID_TEST_EMAIL' as const };
  }

  // Phase 1 (Short TX): Read campaign, template, readiness & preloaded vault state
  const prep = await withTenantTransaction(tenantId, async (client) => {
    let campRow: Record<string, unknown> | undefined;
    if (campaignId && UUID_REGEX.test(campaignId)) {
      const cRes = await client.query('SELECT * FROM mkt_campaigns WHERE tenant_id = $1 AND id = $2 LIMIT 1', [
        tenantId,
        campaignId,
      ]);
      campRow = cRes.rows[0];
    }

    const variant = payload.variant === 'B' ? 'B' : 'A';
    const templateId = payload.template_id || payload.templateId || campRow?.template_id;
    let html = '';
    if (templateId && UUID_REGEX.test(String(templateId))) {
      const tRes = await client.query<{ compiled_html: string }>(
        'SELECT compiled_html FROM mkt_email_templates WHERE tenant_id = $1 AND id = $2 LIMIT 1',
        [tenantId, String(templateId)]
      );
      html = String(tRes.rows[0]?.compiled_html || '');
    }
    const campFb = parseJsonCol<Record<string, unknown>>(campRow?.fallback_vars_json, {});
    if (!html && typeof campFb._content_body === 'string' && campFb._content_body.trim()) {
      html = campFb._content_body.trim();
    }

    const [tenantRes, emailReadiness, preloadedEmailState] = await Promise.all([
      client.query<{ name: string }>('SELECT name FROM tenants WHERE id = $1 LIMIT 1', [tenantId]),
      readAutomationEmailReadiness(client, tenantId),
      rawEmails.length > 0 ? loadEmailTenantStateForCampaign(client, tenantId) : Promise.resolve(undefined),
    ]);

    return {
      campRow,
      campFb,
      variant,
      html,
      tenantName: tenantRes.rows[0]?.name || 'DOMATION',
      emailReadiness,
      preloadedEmailState,
    };
  });

  // ZNS Test Send branch
  if (rawEmails.length === 0 && testPhone) {
    const znsRes = await dispatchZnsNotification({
      tenantId,
      phone: testPhone,
      templateId: prep.campRow?.zns_template_id ? String(prep.campRow.zns_template_id) : null,
      templateData: { customer_name: userName || 'Khách hàng Test', name: userName || 'Khách hàng Test' },
      message: String(prep.campRow?.subject_a || prep.campRow?.name || 'ZNS Test'),
      campaignId: campaignId || null,
    });
    return {
      error: null,
      channel: 'zns',
      phone: testPhone,
      sent: znsRes.sent,
      provider: znsRes.provider,
      message_id: znsRes.messageId,
      ...(znsRes.error ? { dispatch_error: znsRes.error } : {}),
    };
  }

  // Dedicated Automation Email Provider Gate for live test sends:
  // Block if no email provider at all; allow single-recipient preview fallback when tenant currently
  // only has CRM Apps Script configured (returning explicit `automation_warning` + `email_provider_ready: false`),
  // while live campaign launch (/send, /launch, /resume) STRICTLY bans Apps Script with 422.
  const useLegacyAppscriptPreview =
    !prep.emailReadiness.email_provider_ready &&
    prep.emailReadiness.uses_appscript_only &&
    !prep.emailReadiness.sandbox_mode;

  if (
    payload.send_live !== false &&
    !prep.emailReadiness.email_provider_ready &&
    !prep.emailReadiness.uses_appscript_only &&
    !isCampaignOutboundSilent() &&
    !prep.emailReadiness.sandbox_mode
  ) {
    return {
      error: 'AUTOMATION_EMAIL_PROVIDER_REQUIRED' as const,
      uses_appscript_only: false,
    };
  }

  const rawSubject =
    prep.variant === 'B'
      ? String(payload.subject_b || prep.campRow?.subject_b || payload.subject_a || prep.campRow?.subject_a || 'Test Variant B')
      : String(payload.subject_a || payload.subject || prep.campRow?.subject_a || 'Test Variant A');

  const fallbackVars: Record<string, string> = {};
  const srcFb =
    payload.fallback_vars && typeof payload.fallback_vars === 'object'
      ? (payload.fallback_vars as Record<string, unknown>)
      : prep.campFb;
  for (const [k, v] of Object.entries(srcFb || {})) {
    if (!k.startsWith('_') && (typeof v === 'string' || typeof v === 'number')) {
      fallbackVars[k] = String(v);
    }
  }

  const sampleLead =
    payload.sample_lead && typeof payload.sample_lead === 'object'
      ? (payload.sample_lead as Record<string, unknown>)
      : {
          name: userName || 'Nguyễn Minh Anh',
          phone: '0909123456',
          email: rawEmails[0],
          company: 'DOMATION Enterprise',
          product_interest: 'Growth Suite',
          voucher_code: 'DOM-TEST20',
        };

  // Identical merge-tag resolver context to actual campaign dispatch!
  const mergeCtx = buildCampaignMergeContext({
    lead: sampleLead,
    tenantName: prep.tenantName,
    campaignName: String(prep.campRow?.name || 'Test Campaign'),
    campaignSubject: rawSubject,
    unsubscribeUrl: '#unsubscribe-test',
  });

  const renderedSubject = `[TEST ${prep.variant}] ${renderMergeTags(rawSubject, mergeCtx, fallbackVars)}`;
  const renderedHtml = renderMergeTags(prep.html, mergeCtx, fallbackVars);
  const recipients = rawEmails.slice(0, 5);
  const fromEmailOverride = String(payload.sender_email || payload.from_email || prep.campRow?.sender_email || '').trim() || undefined;
  const fromNameOverride = String(payload.sender_name || payload.from_name || prep.campRow?.sender_name || '').trim() || undefined;
  const dispatched: Array<{ email: string; sent: boolean; queued?: boolean; provider: string; message_id: string; error?: string }> = [];

  // Phase 2 (Outside TX): Dispatch test emails without holding any DB connection
  if (payload.send_live !== false) {
    for (const toEmail of recipients) {
      const rawMailRes = useLegacyAppscriptPreview
        ? await sendTenantEmailNotification({
            tenantId,
            to: toEmail.toLowerCase(),
            subject: renderedSubject,
            text: stripHtmlTagsForPlainText(renderedHtml) || renderedSubject,
            html: renderedHtml || `<div>${renderedSubject}</div>`,
            category: 'system_alert',
            meta: { test_email: true, campaign_id: campaignId || null, variant: prep.variant },
            fromEmailOverride,
            fromNameOverride,
            preloadedState: prep.preloadedEmailState,
          })
        : await dispatchMarketingEmail({
            tenantId,
            to: toEmail.toLowerCase(),
            subject: renderedSubject,
            text: stripHtmlTagsForPlainText(renderedHtml) || renderedSubject,
            html: renderedHtml || `<div>${renderedSubject}</div>`,
            category: 'system_alert',
            meta: { test_email: true, campaign_id: campaignId || null, variant: prep.variant },
            emailVaultConfigured: prep.emailReadiness.email_provider_ready,
            emailVaultType: prep.emailReadiness.active_provider,
            sandboxMode: prep.emailReadiness.sandbox_mode,
            fromEmailOverride,
            fromNameOverride,
            pooled: true,
            preloadedState: prep.preloadedEmailState,
          });
      const mailRes = rawMailRes || {
        sent: false,
        provider: 'appscript',
        messageId: `test_err_${crypto.randomUUID()}`,
        error: 'EMAIL_NOT_CONFIGURED',
      };
      dispatched.push({
        email: toEmail,
        sent: mailRes.sent,
        queued: 'queued' in mailRes ? mailRes.queued : undefined,
        provider: mailRes.provider,
        message_id: mailRes.messageId,
        ...(mailRes.error ? { error: mailRes.error } : {}),
      });
    }
  }

  return {
    error: null,
    recipients,
    variant: prep.variant,
    provider: dispatched[0]?.provider || prep.emailReadiness.active_provider || 'vault_sandbox_preview',
    vault_configured: prep.emailReadiness.email_provider_ready,
    email_provider_ready: prep.emailReadiness.email_provider_ready,
    uses_appscript_only: prep.emailReadiness.uses_appscript_only,
    ...(prep.emailReadiness.uses_appscript_only
      ? {
          automation_warning:
            'Google Apps Script chỉ dùng cho thông báo CRM nội bộ và không thể dùng để chạy chiến dịch Marketing Automation. Vui lòng cấu hình AWS SES / SMTP / Resend / SendGrid / Postmark tại Cài đặt → Cấu hình Email.',
        }
      : {}),
    rendered_subject: renderedSubject,
    rendered_html: renderedHtml,
    ...(dispatched.length > 0 ? { dispatched, delivery: dispatched[0] } : {}),
  };
}

campaignsRouter.post('/estimate-reach', requirePermission('mkt_campaigns', 'view'), async (req, res) => {
  try {
    const ctx = getTenantContext();
    const listIds: string[] = (Array.isArray(req.body?.listIds) ? req.body.listIds : req.body?.list_ids || [])
      .map(String)
      .filter((id: string) => UUID_REGEX.test(id));
    const segmentIds: string[] = (Array.isArray(req.body?.segmentIds) ? req.body.segmentIds : req.body?.segment_ids || [])
      .map(String)
      .filter((id: string) => UUID_REGEX.test(id));
    const tagIds: string[] = (Array.isArray(req.body?.tagIds) ? req.body.tagIds : req.body?.tag_ids || [])
      .map(String)
      .filter((id: string) => UUID_REGEX.test(id));
    const excludedListIds: string[] = (
      Array.isArray(req.body?.excludedListIds) ? req.body.excludedListIds : req.body?.excluded_list_ids || []
    )
      .map(String)
      .filter((id: string) => UUID_REGEX.test(id));
    const excludedSegmentIds: string[] = (
      Array.isArray(req.body?.excludedSegmentIds) ? req.body.excludedSegmentIds : req.body?.excluded_segment_ids || []
    )
      .map(String)
      .filter((id: string) => UUID_REGEX.test(id));
    const campaignType = req.body?.campaignType || req.body?.campaign_type || req.body?.channel || '';

    const data = await withTenantTransaction(ctx.tenantId, async (client) => {
      const targetAudIds = [...new Set([...listIds, ...segmentIds])];
      const excludeAudIds = [...new Set([...excludedListIds, ...excludedSegmentIds])];

      if (targetAudIds.length === 0 && tagIds.length === 0) {
        return { count: 0 };
      }

      // Include dynamic segment evaluation clauses for dynamic_logic segments alongside static members
      const includeClauses: string[] = [];
      const params: unknown[] = [ctx.tenantId];

      if (targetAudIds.length > 0) {
        const audMeta = await client.query<{ id: string; audience_type: string; filter_branches: unknown }>(
          `SELECT id, audience_type, filter_branches
           FROM tenant_audiences
           WHERE tenant_id = $1 AND id IN (${targetAudIds.map((_, i) => `$${i + 2}`).join(', ')})`,
          [ctx.tenantId, ...targetAudIds]
        );
        const staticIds: string[] = [];
        for (const a of audMeta.rows) {
          if (a.audience_type === 'dynamic_logic') {
            const compiled = compileSegmentWhereSql(ctx.tenantId, a.filter_branches, {
              startParamIndex: params.length + 1,
              audienceIdForExclusions: String(a.id),
            });
            if (compiled.hasRules) {
              params.push(...compiled.params);
              includeClauses.push(`(${compiled.whereClause})`);
              continue;
            }
          }
          staticIds.push(String(a.id));
        }

        if (staticIds.length > 0) {
          const ph = staticIds.map((id) => {
            params.push(id);
            return `$${params.length}`;
          });
          includeClauses.push(`EXISTS (
            SELECT 1 FROM tenant_audience_members tam
            WHERE tam.tenant_id = l.tenant_id AND tam.lead_id = l.id AND tam.audience_id IN (${ph.join(', ')})
          )`);
        }
      }

      if (tagIds.length > 0) {
        const ph = tagIds.map((id) => {
          params.push(id);
          return `$${params.length}`;
        });
        includeClauses.push(`EXISTS (
          SELECT 1 FROM lead_tags lt
          WHERE lt.tenant_id = l.tenant_id AND lt.lead_id = l.id AND lt.tag_id IN (${ph.join(', ')})
        )`);
      }

      if (includeClauses.length === 0) {
        return { count: 0 };
      }

      let sql = `
        SELECT COUNT(DISTINCT l.id)::int AS cnt
        FROM leads l
        LEFT JOIN tenant_pipeline_stages s ON s.tenant_id = l.tenant_id AND s.id = l.stage_id
        WHERE l.tenant_id = $1 AND l.is_deleted = false
          AND (${includeClauses.join(' OR ')})
      `;

      if (excludeAudIds.length > 0) {
        const ph = excludeAudIds.map((id) => {
          params.push(id);
          return `$${params.length}`;
        });
        sql += `
          AND NOT EXISTS (
            SELECT 1 FROM tenant_audience_members tam_ex
            WHERE tam_ex.tenant_id = l.tenant_id AND tam_ex.lead_id = l.id AND tam_ex.audience_id IN (${ph.join(', ')})
          )
        `;
      }

      if (campaignType === 'email') {
        sql += `
          AND l.email IS NOT NULL AND l.email != '' AND l.email_consent = 'subscribed'
          AND NOT EXISTS (
            SELECT 1 FROM mkt_suppression_list sup
            WHERE sup.tenant_id = l.tenant_id AND sup.channel = 'email' AND LOWER(sup.recipient) = LOWER(l.email)
          )
        `;
      } else if (campaignType === 'zns') {
        const normSupExpr = `CASE WHEN sup.recipient LIKE '+%' THEN SUBSTR(sup.recipient, 2) WHEN sup.recipient LIKE '0%' THEN CONCAT('84', SUBSTR(sup.recipient, 2)) ELSE sup.recipient END`;
        const normLeadPhoneExpr = `CASE WHEN l.phone LIKE '+%' THEN SUBSTR(l.phone, 2) WHEN l.phone LIKE '0%' THEN CONCAT('84', SUBSTR(l.phone, 2)) ELSE l.phone END`;
        sql += `
          AND l.phone IS NOT NULL AND l.phone != '' AND l.zns_consent != 'opted_out'
          AND NOT EXISTS (
            SELECT 1 FROM mkt_suppression_list sup
            WHERE sup.tenant_id = l.tenant_id AND sup.channel = 'zns'
              AND (${normSupExpr}) = (${normLeadPhoneExpr})
          )
        `;
      }

      const cntRes = await client.query<{ cnt: number }>(sql, params);
      return { count: Number(cntRes.rows[0]?.cnt || 0) };
    });

    res.json({ success: true, data });
  } catch (err: any) {
    sendApiError(res, 500, 'ESTIMATE_REACH_FAILED', err?.message || 'Không thể ước tính số người nhận.');
  }
});

campaignsRouter.post('/test-email', requirePermission('mkt_campaigns', 'view'), async (req, res) => {
  try {
    const ctx = getTenantContext();
    const out = await runCampaignTestEmail(ctx.tenantId, ctx.userName, req.body || {});
    if (out.error === 'INVALID_TEST_EMAIL') {
      sendApiError(res, 422, 'INVALID_TEST_EMAIL', 'Vui lòng nhập ít nhất 1 địa chỉ Email nhận bản thử nghiệm.');
      return;
    }
    if (out.error === 'AUTOMATION_EMAIL_PROVIDER_REQUIRED') {
      sendProviderRequiredError(res, Boolean(out.uses_appscript_only));
      return;
    }
    res.json({ success: true, data: out });
  } catch (err: any) {
    sendApiError(res, 500, 'TEST_EMAIL_FAILED', err?.message || 'Không thể gửi Email thử nghiệm.');
  }
});

// List Campaigns + Audiences + Templates + Vault Readiness + Suppression Summary
campaignsRouter.get('/', requirePermission('mkt_campaigns', 'view'), async (_req, res) => {
  try {
    const ctx = getTenantContext();
    const data = await withTenantTransaction(ctx.tenantId, async (client) => {
      const [campRes, audRes, tplRes, supRes] = await Promise.all([
        client.query(
          `SELECT c.*,
                  a.name AS audience_name,
                  a.audience_type AS audience_type,
                  t.name AS template_name
           FROM mkt_campaigns c
           LEFT JOIN tenant_audiences a ON a.tenant_id = c.tenant_id AND a.id = c.audience_id
           LEFT JOIN mkt_email_templates t ON t.tenant_id = c.tenant_id AND t.id = c.template_id
           WHERE c.tenant_id = $1
           ORDER BY c.created_at DESC`,
          [ctx.tenantId]
        ),
        client.query(
          `SELECT id, name, audience_type, cached_member_count
           FROM tenant_audiences
           WHERE tenant_id = $1 AND is_active = true
           ORDER BY name ASC`,
          [ctx.tenantId]
        ),
        client.query(
          `SELECT id, name, subject
           FROM mkt_email_templates
           WHERE tenant_id = $1 AND status = 'active'
           ORDER BY updated_at DESC`,
          [ctx.tenantId]
        ),
        client.query<{ cnt: number }>(
          'SELECT COUNT(*)::int AS cnt FROM mkt_suppression_list WHERE tenant_id = $1',
          [ctx.tenantId]
        ),
      ]);

      const [emailVault, znsVault] = await Promise.all([
        readAutomationEmailReadiness(client, ctx.tenantId),
        readTenantChannelVault(client, ctx.tenantId, ['zalo_zns', 'zalo_oa']),
      ]);

      const items = campRes.rows.map(mapCampaignRow);
      const totals = items.reduce(
        (acc, c) => {
          acc.sent += c.sent_count;
          acc.opened += c.opened_count;
          acc.clicked += c.clicked_count;
          acc.revenue_vnd += c.attributed_revenue_vnd;
          acc.cost_vnd += c.cost_vnd;
          return acc;
        },
        { sent: 0, opened: 0, clicked: 0, revenue_vnd: 0, cost_vnd: 0 }
      );

      return {
        items,
        audiences: audRes.rows,
        templates: tplRes.rows,
        suppression_count: Number(supRes.rows[0]?.cnt || 0),
        vault_channels: {
          email: {
            configured: emailVault.email_provider_ready,
            email_provider_ready: emailVault.email_provider_ready,
            provider: emailVault.active_provider,
            active_provider: emailVault.active_provider,
            uses_appscript_only: emailVault.uses_appscript_only,
            max_send_rate_per_sec: emailVault.max_send_rate_per_sec,
          },
          zns: { configured: znsVault.configured, provider: znsVault.integrationType },
        },
        summary: totals,
      };
    });

    res.json({ success: true, data });
  } catch (err: any) {
    sendApiError(res, 500, 'LIST_CAMPAIGNS_FAILED', err?.message || 'Không thể tải danh sách Chiến dịch.');
  }
});

// Create Campaign (supports both snake_case native & camelCase ERP Wizard payloads)
campaignsRouter.post('/', requirePermission('mkt_campaigns', 'create'), async (req, res) => {
  try {
    const ctx = getTenantContext();
    const name = String(req.body?.name || '').trim();
    if (!name) {
      sendApiError(res, 422, 'CAMPAIGN_NAME_REQUIRED', 'Vui lòng nhập tên Chiến dịch.');
      return;
    }

    const rawChannel = String(req.body?.channel || req.body?.type || 'email').toLowerCase();
    const channel =
      rawChannel === 'zns' || rawChannel === 'zalo_zns' ? 'zns' : rawChannel === 'multi' ? 'multi' : 'email';

    const targetObj =
      req.body?.target && typeof req.body.target === 'object' ? (req.body.target as Record<string, unknown>) : null;
    const rawTargetListIds = Array.isArray(targetObj?.listIds) ? targetObj.listIds.map(String) : [];
    const rawTargetSegIds = Array.isArray(targetObj?.segmentIds) ? targetObj.segmentIds.map(String) : [];
    const inferredAudienceId =
      req.body?.audience_id && UUID_REGEX.test(String(req.body.audience_id))
        ? String(req.body.audience_id)
        : rawTargetListIds.find((x) => UUID_REGEX.test(x)) || rawTargetSegIds.find((x) => UUID_REGEX.test(x)) || null;

    const excludeAudienceIds = Array.isArray(req.body?.exclude_audience_ids) ? req.body.exclude_audience_ids : [];
    const rawTplId = req.body?.template_id ?? req.body?.templateId;
    const templateId =
      channel !== 'zns' && rawTplId && rawTplId !== 'custom-html' && UUID_REGEX.test(String(rawTplId))
        ? String(rawTplId)
        : null;
    const znsTemplateId =
      req.body?.zns_template_id
        ? String(req.body.zns_template_id).trim()
        : channel === 'zns' && rawTplId
          ? String(rawTplId).trim()
          : null;

    const subjectA = String(req.body?.subject_a || req.body?.subject || name).trim();
    const subjectB = String(req.body?.subject_b || '').trim();
    const abSplitRatio = Math.min(100, Math.max(10, Math.round(Number(req.body?.ab_split_ratio ?? 100))));
    const senderName = req.body?.sender_name || req.body?.senderName ? String(req.body.sender_name || req.body.senderName).trim() : null;
    const senderEmail = req.body?.sender_email || req.body?.senderEmail ? String(req.body.sender_email || req.body.senderEmail).trim() : null;
    const reminderConfig =
      req.body?.reminder_config && typeof req.body.reminder_config === 'object'
        ? req.body.reminder_config
        : { enabled: false, trigger_condition: 'no_open', wait_hours: 24, reminder_subject: '' };

    const cfgObj = req.body?.config && typeof req.body.config === 'object' ? (req.body.config as Record<string, unknown>) : null;
    const baseFallbackVars: Record<string, unknown> = {
      ...(cfgObj?.variable_fallbacks && typeof cfgObj.variable_fallbacks === 'object'
        ? (cfgObj.variable_fallbacks as Record<string, unknown>)
        : {}),
      ...(req.body?.fallback_vars && typeof req.body.fallback_vars === 'object' ? req.body.fallback_vars : {}),
    };
    if (Array.isArray(req.body?.attachments)) baseFallbackVars._attachments = req.body.attachments;
    if (targetObj) baseFallbackVars._target = targetObj;
    if (cfgObj) baseFallbackVars._config = cfgObj;
    if (typeof req.body?.contentBody === 'string' && req.body.contentBody.trim()) {
      baseFallbackVars._content_body = req.body.contentBody;
    } else if (typeof req.body?.html_body === 'string' && req.body.html_body.trim()) {
      baseFallbackVars._content_body = req.body.html_body;
    }

    const throttlePerMinute = Math.max(0, Math.round(Number(req.body?.throttle_per_minute || 0)));
    const abWinnerCriteria = String(req.body?.ab_winner_criteria || 'open_rate');
    const abTestHours = Math.max(1, Math.round(Number(req.body?.ab_test_hours ?? 4)));
    const costVnd = Math.max(0, Math.round(Number(req.body?.cost_vnd || 0)));
    const schedNorm = normalizeScheduledAtIso(req.body?.scheduled_at ?? req.body?.scheduledAt);
    if (schedNorm.invalid) {
      sendApiError(res, 422, 'INVALID_SCHEDULED_AT', 'Thời gian lên lịch không hợp lệ (yêu cầu định dạng ISO-8601).');
      return;
    }
    const scheduledAt = schedNorm.iso;
    const requestedStatus = String(req.body?.status || '').toLowerCase();
    const shouldDispatchImmediately = requestedStatus === 'sending' && !scheduledAt;
    const initialStatus =
      requestedStatus === 'waiting_flow'
        ? 'waiting_flow'
        : scheduledAt
          ? 'scheduled'
          : 'draft';

    const initialReminders: Array<Record<string, unknown>> = Array.isArray(req.body?.reminders)
      ? req.body.reminders
      : [];

    // Enforce dedicated email provider gate BEFORE creating+launching a live immediate Email campaign
    if (shouldDispatchImmediately && (channel === 'email' || channel === 'multi')) {
      const readiness = await withTenantTransaction(ctx.tenantId, (client) =>
        readAutomationEmailReadiness(client, ctx.tenantId)
      );
      if (!readiness.email_provider_ready && !isCampaignOutboundSilent() && !readiness.sandbox_mode) {
        sendProviderRequiredError(res, readiness.uses_appscript_only);
        return;
      }
    }

    const id = crypto.randomUUID();
    let created = await withTenantTransaction(ctx.tenantId, async (client) => {
      await client.query(
        `INSERT INTO mkt_campaigns (
           id, tenant_id, name, channel, status, audience_id, exclude_audience_ids,
           template_id, subject_a, subject_b, ab_split_ratio, ab_winner_criteria, ab_test_hours,
           zns_template_id, sender_name, sender_email, fallback_vars_json, throttle_per_minute,
           reminder_config, scheduled_at, cost_vnd, created_by
         ) VALUES (
           $1, $2, $3, $4, $5, $6, $7::jsonb,
           $8, $9, $10, $11, $12, $13,
           $14, $15, $16, $17::jsonb, $18,
           $19::jsonb, $20, $21, $22
         )`,
        [
          id,
          ctx.tenantId,
          name,
          channel,
          initialStatus,
          inferredAudienceId,
          JSON.stringify(excludeAudienceIds),
          templateId,
          subjectA,
          subjectB,
          abSplitRatio,
          abWinnerCriteria,
          abTestHours,
          znsTemplateId,
          senderName,
          senderEmail,
          JSON.stringify(baseFallbackVars),
          throttlePerMinute,
          JSON.stringify(reminderConfig),
          scheduledAt,
          costVnd,
          ctx.userId,
        ]
      );

      for (let idx = 0; idx < initialReminders.length; idx++) {
        const rm = initialReminders[idx];
        const rmTpl = rm.template_id ?? rm.templateId;
        await client.query(
          `INSERT INTO mkt_campaign_reminders (
             id, tenant_id, campaign_id, step_order, trigger_condition, wait_hours, subject, template_id, channel, is_active
           ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
          [
            crypto.randomUUID(),
            ctx.tenantId,
            id,
            idx + 1,
            String(rm.trigger_condition || rm.type || 'no_open'),
            Math.max(1, Math.round(Number(rm.wait_hours ?? (Number(rm.delayDays || 0) * 24 + Number(rm.delayHours || 0)) ?? 24))),
            String(rm.subject || `Nhắc lại: ${subjectA}`),
            rmTpl && UUID_REGEX.test(String(rmTpl)) ? String(rmTpl) : templateId,
            String(rm.channel || channel),
            rm.is_active !== undefined ? Boolean(rm.is_active) : true,
          ]
        );
      }

      const r = await client.query('SELECT * FROM mkt_campaigns WHERE tenant_id = $1 AND id = $2', [
        ctx.tenantId,
        id,
      ]);
      return mapCampaignRow(r.rows[0]);
    });

    if (shouldDispatchImmediately) {
      const publicOrigin = resolvePublicRequestOrigin(req);
      const asyncBg =
        req.body?.async === true ||
        (!isCampaignOutboundSilent() && process.env.NODE_ENV === 'production' && req.body?.wait !== true);
      const out = await dispatchCampaignBatchHighSpeed({
        tenantId: ctx.tenantId,
        campaignId: id,
        publicOrigin,
        actorId: ctx.userId,
        actorName: ctx.userName || 'Campaign Sender',
        source: 'manual_send',
        asyncBackground: asyncBg,
      });
      if (!out.ok && out.errorCode === 'AUTOMATION_EMAIL_PROVIDER_REQUIRED') {
        sendProviderRequiredError(res, Boolean(out.usesAppscriptOnly), out.errorMessage);
        return;
      }
      if (out.campaignRow) {
        created = mapCampaignRow(out.campaignRow);
      }
    }

    res.status(201).json({ success: true, data: created });
  } catch (err: any) {
    sendApiError(res, 500, 'CREATE_CAMPAIGN_FAILED', err?.message || 'Không thể khởi tạo Chiến dịch.');
  }
});

// Update Campaign (preserves _dispatch_stats & supports immediate launch when status === 'sending')
campaignsRouter.put('/:id', requirePermission('mkt_campaigns', 'edit'), async (req, res) => {
  try {
    const ctx = getTenantContext();
    const schedRaw = req.body?.scheduled_at !== undefined ? req.body.scheduled_at : req.body?.scheduledAt;
    const schedNorm = schedRaw !== undefined ? normalizeScheduledAtIso(schedRaw) : null;
    if (schedNorm?.invalid) {
      sendApiError(res, 422, 'INVALID_SCHEDULED_AT', 'Thời gian lên lịch không hợp lệ (yêu cầu định dạng ISO-8601).');
      return;
    }

    const result = await withTenantTransaction(ctx.tenantId, async (client) => {
      const exRes = await client.query('SELECT * FROM mkt_campaigns WHERE tenant_id = $1 AND id = $2 LIMIT 1', [
        ctx.tenantId,
        req.params.id,
      ]);
      const ex = exRes.rows[0];
      if (!ex) return null;

      const name = req.body?.name !== undefined ? String(req.body.name).trim() : String(ex.name);
      const subjectA =
        req.body?.subject_a !== undefined
          ? String(req.body.subject_a).trim()
          : req.body?.subject !== undefined
            ? String(req.body.subject).trim()
            : String(ex.subject_a);
      const subjectB = req.body?.subject_b !== undefined ? String(req.body.subject_b).trim() : String(ex.subject_b);
      const abSplitRatio =
        req.body?.ab_split_ratio !== undefined
          ? Math.min(100, Math.max(10, Math.round(Number(req.body.ab_split_ratio))))
          : Number(ex.ab_split_ratio ?? 100);

      const targetObj =
        req.body?.target && typeof req.body.target === 'object' ? (req.body.target as Record<string, unknown>) : null;
      const rawTargetListIds = Array.isArray(targetObj?.listIds) ? targetObj.listIds.map(String) : [];
      const rawTargetSegIds = Array.isArray(targetObj?.segmentIds) ? targetObj.segmentIds.map(String) : [];
      const audienceId =
        req.body?.audience_id !== undefined
          ? req.body.audience_id && UUID_REGEX.test(String(req.body.audience_id))
            ? String(req.body.audience_id)
            : null
          : targetObj
            ? rawTargetListIds.find((x) => UUID_REGEX.test(x)) || rawTargetSegIds.find((x) => UUID_REGEX.test(x)) || ex.audience_id
            : ex.audience_id;

      const rawChannelInput = req.body?.channel ?? req.body?.type;
      const channel =
        rawChannelInput !== undefined
          ? String(rawChannelInput).toLowerCase() === 'zalo_zns' || String(rawChannelInput).toLowerCase() === 'zns'
            ? 'zns'
            : String(rawChannelInput).toLowerCase() === 'multi'
              ? 'multi'
              : 'email'
          : String(ex.channel || 'email');

      const rawTplInput = req.body?.template_id !== undefined ? req.body.template_id : req.body?.templateId;
      const templateId =
        rawTplInput !== undefined
          ? channel !== 'zns' && rawTplInput && rawTplInput !== 'custom-html' && UUID_REGEX.test(String(rawTplInput))
            ? String(rawTplInput)
            : null
          : ex.template_id;
      const znsTemplateId =
        req.body?.zns_template_id !== undefined
          ? req.body.zns_template_id
            ? String(req.body.zns_template_id)
            : null
          : channel === 'zns' && rawTplInput !== undefined
            ? rawTplInput
              ? String(rawTplInput)
              : null
            : ex.zns_template_id;

      const reminderConfig =
        req.body?.reminder_config && typeof req.body.reminder_config === 'object'
          ? req.body.reminder_config
          : parseJsonCol(ex.reminder_config, {});

      const existingFb = parseJsonCol<Record<string, unknown>>(ex.fallback_vars_json, {});
      const cfgObj =
        req.body?.config && typeof req.body.config === 'object' ? (req.body.config as Record<string, unknown>) : null;
      const nextFallbackVars: Record<string, unknown> =
        req.body?.fallback_vars && typeof req.body.fallback_vars === 'object'
          ? {
              ...(existingFb._dispatch_stats ? { _dispatch_stats: existingFb._dispatch_stats } : {}),
              ...(existingFb._attachments ? { _attachments: existingFb._attachments } : {}),
              ...(existingFb._target ? { _target: existingFb._target } : {}),
              ...(existingFb._config ? { _config: existingFb._config } : {}),
              ...(existingFb._content_body ? { _content_body: existingFb._content_body } : {}),
              ...req.body.fallback_vars,
            }
          : { ...existingFb };
      if (cfgObj?.variable_fallbacks && typeof cfgObj.variable_fallbacks === 'object') {
        Object.assign(nextFallbackVars, cfgObj.variable_fallbacks);
      }
      if (Array.isArray(req.body?.attachments)) nextFallbackVars._attachments = req.body.attachments;
      if (targetObj) nextFallbackVars._target = targetObj;
      if (cfgObj) nextFallbackVars._config = cfgObj;
      if (typeof req.body?.contentBody === 'string') nextFallbackVars._content_body = req.body.contentBody;

      const excludeAudienceIds = Array.isArray(req.body?.exclude_audience_ids)
        ? req.body.exclude_audience_ids
        : parseJsonCol(ex.exclude_audience_ids, []);
      const throttlePerMinute =
        req.body?.throttle_per_minute !== undefined
          ? Math.max(0, Math.round(Number(req.body.throttle_per_minute)))
          : Number(ex.throttle_per_minute || 0);
      const abWinnerCriteria =
        req.body?.ab_winner_criteria !== undefined
          ? String(req.body.ab_winner_criteria)
          : String(ex.ab_winner_criteria || 'open_rate');
      const abTestHours =
        req.body?.ab_test_hours !== undefined
          ? Math.max(1, Math.round(Number(req.body.ab_test_hours)))
          : Number(ex.ab_test_hours ?? 4);
      const costVnd =
        req.body?.cost_vnd !== undefined ? Math.max(0, Math.round(Number(req.body.cost_vnd))) : Number(ex.cost_vnd || 0);
      const attributedRev =
        req.body?.attributed_revenue_vnd !== undefined
          ? Math.max(0, Math.round(Number(req.body.attributed_revenue_vnd)))
          : Number(ex.attributed_revenue_vnd || 0);
      const senderName =
        req.body?.sender_name !== undefined || req.body?.senderName !== undefined
          ? String(req.body.sender_name ?? req.body.senderName ?? '').trim() || null
          : ex.sender_name;
      const senderEmail =
        req.body?.sender_email !== undefined || req.body?.senderEmail !== undefined
          ? String(req.body.sender_email ?? req.body.senderEmail ?? '').trim() || null
          : ex.sender_email;
      const scheduledAt = schedNorm !== null ? schedNorm.iso : ex.scheduled_at;
      const reqStatus = req.body?.status !== undefined ? String(req.body.status).toLowerCase() : null;
      const shouldDispatchNow = reqStatus === 'sending' && String(ex.status || '').toLowerCase() !== 'sending' && !scheduledAt;
      const status =
        reqStatus && ['draft', 'scheduled', 'sending', 'completed', 'paused', 'waiting_flow'].includes(reqStatus)
          ? shouldDispatchNow
            ? String(ex.status || 'draft')
            : reqStatus
          : String(ex.status || 'draft');

      // Enforce dedicated email provider gate BEFORE launching
      if (shouldDispatchNow && (channel === 'email' || channel === 'multi')) {
        const readiness = await readAutomationEmailReadiness(client, ctx.tenantId);
        if (!readiness.email_provider_ready && !isCampaignOutboundSilent() && !readiness.sandbox_mode) {
          return { providerRequired: true as const, usesAppscriptOnly: readiness.uses_appscript_only };
        }
      }

      await client.query(
        `UPDATE mkt_campaigns
         SET name = $3,
             subject_a = $4,
             subject_b = $5,
             ab_split_ratio = $6,
             audience_id = $7,
             template_id = $8,
             reminder_config = $9::jsonb,
             cost_vnd = $10,
             attributed_revenue_vnd = $11,
             fallback_vars_json = $12::jsonb,
             exclude_audience_ids = $13::jsonb,
             throttle_per_minute = $14,
             ab_winner_criteria = $15,
             ab_test_hours = $16,
             channel = $17,
             zns_template_id = $18,
             sender_name = $19,
             sender_email = $20,
             scheduled_at = $21,
             status = $22,
             updated_at = clock_timestamp()
         WHERE tenant_id = $1 AND id = $2`,
        [
          ctx.tenantId,
          req.params.id,
          name,
          subjectA,
          subjectB,
          abSplitRatio,
          audienceId,
          templateId,
          JSON.stringify(reminderConfig),
          costVnd,
          attributedRev,
          JSON.stringify(nextFallbackVars),
          JSON.stringify(excludeAudienceIds),
          throttlePerMinute,
          abWinnerCriteria,
          abTestHours,
          channel,
          znsTemplateId,
          senderName,
          senderEmail,
          scheduledAt,
          status,
        ]
      );

      const r = await client.query('SELECT * FROM mkt_campaigns WHERE tenant_id = $1 AND id = $2', [
        ctx.tenantId,
        req.params.id,
      ]);
      return {
        providerRequired: false as const,
        shouldDispatchNow,
        mapped: mapCampaignRow(r.rows[0]),
      };
    });

    if (!result) {
      sendApiError(res, 404, 'CAMPAIGN_NOT_FOUND', 'Không tìm thấy Chiến dịch.');
      return;
    }
    if (result.providerRequired) {
      sendProviderRequiredError(res, result.usesAppscriptOnly);
      return;
    }

    let finalCampaign = result.mapped;
    if (result.shouldDispatchNow) {
      const publicOrigin = resolvePublicRequestOrigin(req);
      const asyncBg =
        req.body?.async === true ||
        (!isCampaignOutboundSilent() && process.env.NODE_ENV === 'production' && req.body?.wait !== true);
      const out = await dispatchCampaignBatchHighSpeed({
        tenantId: ctx.tenantId,
        campaignId: String(req.params.id),
        publicOrigin,
        actorId: ctx.userId,
        actorName: ctx.userName || 'Campaign Sender',
        source: 'manual_send',
        asyncBackground: asyncBg,
      });
      if (!out.ok && out.errorCode === 'AUTOMATION_EMAIL_PROVIDER_REQUIRED') {
        sendProviderRequiredError(res, Boolean(out.usesAppscriptOnly), out.errorMessage);
        return;
      }
      if (out.campaignRow) {
        finalCampaign = mapCampaignRow(out.campaignRow);
      }
    }

    res.json({ success: true, data: finalCampaign });
  } catch (err: any) {
    sendApiError(res, 500, 'UPDATE_CAMPAIGN_FAILED', err?.message || 'Không thể cập nhật Chiến dịch.');
  }
});

// High-Speed 14 Mail/s Concurrent Token-Bucket Campaign Send / Launch (ZERO DB TX Hold!)
async function handleCampaignSendOrLaunch(req: Request, res: Response): Promise<void> {
  try {
    const campaignId = String(req.params.id || '').trim();
    if (!UUID_REGEX.test(campaignId)) {
      sendApiError(res, 404, 'CAMPAIGN_NOT_FOUND', 'Không tìm thấy Chiến dịch cần phát hành.');
      return;
    }

    const ctx = getTenantContext();
    const publicOrigin = resolvePublicRequestOrigin(req);
    const explicitAsync = req.body?.async === true || req.query?.async === '1' || req.query?.async === 'true';
    const explicitWait = req.body?.wait === true || req.query?.wait === '1';

    // Determine whether to run Phase 2+3 in background (only when explicitly requested or live production >20 recipients)
    let asyncBackground = explicitAsync;
    if (!asyncBackground && !explicitWait && !isCampaignOutboundSilent() && process.env.NODE_ENV === 'production') {
      const est = await withTenantTransaction(ctx.tenantId, async (client) => {
        const c = await client.query<{ audience_id: string | null }>(
          'SELECT audience_id FROM mkt_campaigns WHERE tenant_id = $1 AND id = $2 LIMIT 1',
          [ctx.tenantId, campaignId]
        );
        if (!c.rows[0]) return 0;
        if (c.rows[0].audience_id) {
          const cnt = await client.query<{ cnt: number }>(
            'SELECT COUNT(*)::int AS cnt FROM tenant_audience_members WHERE tenant_id = $1 AND audience_id = $2',
            [ctx.tenantId, c.rows[0].audience_id]
          );
          return Number(cnt.rows[0]?.cnt || 0);
        }
        const cnt = await client.query<{ cnt: number }>(
          'SELECT COUNT(*)::int AS cnt FROM leads WHERE tenant_id = $1 AND is_deleted = false',
          [ctx.tenantId]
        );
        return Number(cnt.rows[0]?.cnt || 0);
      });
      if (est > 20) asyncBackground = true;
    }

    const outcome = await dispatchCampaignBatchHighSpeed({
      tenantId: ctx.tenantId,
      campaignId,
      publicOrigin,
      actorId: ctx.userId,
      actorName: ctx.userName || 'Campaign Sender',
      source: 'manual_send',
      enforceEmailProviderGate: true,
      enforceZnsWindow: req.body?.bypass_zns_window !== true,
      ratePerSecOverride:
        req.body?.rate_per_sec !== undefined && Number(req.body.rate_per_sec) > 0
          ? Number(req.body.rate_per_sec)
          : undefined,
      asyncBackground,
    });

    if (outcome.notFound) {
      sendApiError(res, 404, 'CAMPAIGN_NOT_FOUND', 'Không tìm thấy Chiến dịch cần phát hành.');
      return;
    }

    if (!outcome.ok && outcome.errorCode === 'AUTOMATION_EMAIL_PROVIDER_REQUIRED') {
      sendProviderRequiredError(res, Boolean(outcome.usesAppscriptOnly), outcome.errorMessage);
      return;
    }

    const mappedCampaign = outcome.campaignRow ? mapCampaignRow(outcome.campaignRow) : null;
    res.json({
      success: true,
      data: {
        campaign: mappedCampaign,
        newly_sent: outcome.newly_sent,
        duplicate_claims_prevented: outcome.duplicate_claims_prevented,
        suppressed_skipped: outcome.suppressed_skipped,
        failed_count: outcome.failed_count,
        claim_ids: outcome.claim_ids,
        stats_json: outcome.stats_json || mappedCampaign?.stats_json,
        ...(outcome.asyncRunning ? { async: true } : {}),
        ...(outcome.deferredForZnsWindow
          ? { deferred_for_zns_window: true, scheduled_at: outcome.scheduledAt }
          : {}),
      },
    });
  } catch (err: any) {
    sendApiError(res, 500, 'SEND_CAMPAIGN_FAILED', err?.message || 'Không thể phát hành Chiến dịch.');
  }
}

campaignsRouter.post('/:id/send', requirePermission('mkt_campaigns', 'create'), handleCampaignSendOrLaunch);
campaignsRouter.post('/:id/launch', requirePermission('mkt_campaigns', 'create'), handleCampaignSendOrLaunch);

// Process Automated Reminders (`no_open` / `no_click`) — Zero DB TX hold during network dispatch!
campaignsRouter.post('/:id/process-reminders', requirePermission('mkt_campaigns', 'create'), async (req, res) => {
  try {
    const ctx = getTenantContext();
    const publicOrigin = resolvePublicRequestOrigin(req);

    // Phase 1 (Short TX): Resolve eligible reminder claims, suppressions, template & preloaded vault state
    const prep = await withTenantTransaction(ctx.tenantId, async (client) => {
      const cRes = await client.query('SELECT * FROM mkt_campaigns WHERE tenant_id = $1 AND id = $2 LIMIT 1', [
        ctx.tenantId,
        req.params.id,
      ]);
      const camp = cRes.rows[0];
      if (!camp) return null;

      const tenantRes = await client.query<{ name: string }>('SELECT name FROM tenants WHERE id = $1 LIMIT 1', [
        ctx.tenantId,
      ]);
      const tenantName = tenantRes.rows[0]?.name || 'DOMATION';

      const [emailReadiness, suppressionRes, remRowsRes, preloadedEmailState] = await Promise.all([
        readAutomationEmailReadiness(client, ctx.tenantId),
        client.query<{ channel: string; recipient: string }>(
          'SELECT channel, LOWER(recipient) AS recipient FROM mkt_suppression_list WHERE tenant_id = $1',
          [ctx.tenantId]
        ),
        client.query(
          `SELECT id, trigger_condition, wait_hours, subject, template_id, channel
           FROM mkt_campaign_reminders
           WHERE tenant_id = $1 AND campaign_id = $2 AND is_active = true
           ORDER BY step_order ASC, created_at ASC`,
          [ctx.tenantId, camp.id]
        ),
        loadEmailTenantStateForCampaign(client, ctx.tenantId),
      ]);
      const suppressedSet = buildSuppressionSet(suppressionRes.rows);

      const remCfg = parseJsonCol<{ trigger_condition?: string; reminder_subject?: string }>(
        camp.reminder_config,
        {}
      );
      const requestedRemId = req.body?.reminder_id ? String(req.body.reminder_id) : null;
      const matchedRemRow =
        (requestedRemId ? remRowsRes.rows.find((r) => String(r.id) === requestedRemId) : null) ||
        remRowsRes.rows.find(
          (r) => !req.body?.trigger_condition || String(r.trigger_condition) === String(req.body.trigger_condition)
        ) ||
        remRowsRes.rows[0] ||
        null;

      const condition = String(
        req.body?.trigger_condition || matchedRemRow?.trigger_condition || remCfg.trigger_condition || 'no_open'
      );
      const extraCond =
        condition === 'no_click'
          ? 'sc.clicked_at IS NULL'
          : condition === 'all'
            ? '1 = 1'
            : 'sc.opened_at IS NULL';

      const remChannel =
        matchedRemRow?.channel === 'email' || matchedRemRow?.channel === 'zns' ? matchedRemRow.channel : null;
      const pendingParams: unknown[] = [ctx.tenantId, camp.id];
      const channelFilterSql = remChannel ? `AND sc.channel = $${pendingParams.push(remChannel)}` : '';

      const pendingRes = await client.query<{
        id: string;
        lead_id: string;
        channel: string;
        lead_name: string | null;
        email: string | null;
        phone: string | null;
        email_consent: string | null;
        zns_consent: string | null;
        custom_fields: unknown;
      }>(
        `SELECT sc.id, sc.lead_id, sc.channel,
                l.name AS lead_name, l.email, l.phone, l.email_consent, l.zns_consent, l.custom_fields
         FROM mkt_send_claims sc
         INNER JOIN leads l ON l.tenant_id = sc.tenant_id AND l.id = sc.lead_id AND l.is_deleted = false
         WHERE sc.tenant_id = $1
           AND sc.campaign_id = $2
           AND sc.reminder_sent = false
           AND sc.status IN ('sent', 'delivered', 'opened')
           ${channelFilterSql}
           AND ${extraCond}`,
        pendingParams
      );

      const effectiveTplId = matchedRemRow?.template_id || camp.template_id || null;
      let tplHtml = '';
      if (effectiveTplId) {
        const tRes = await client.query<{ compiled_html: string; blocks_json: unknown; body_style: unknown }>(
          'SELECT compiled_html, blocks_json, body_style FROM mkt_email_templates WHERE tenant_id = $1 AND id = $2 LIMIT 1',
          [ctx.tenantId, effectiveTplId]
        );
        const tplRow = tRes.rows[0];
        if (tplRow) {
          tplHtml = String(tplRow.compiled_html || '').trim();
          if (!tplHtml) {
            const blocks = parseJsonCol<EmailBlockDto[]>(tplRow.blocks_json, []);
            const bodyStyle = parseJsonCol<EmailBodyStyleDto>(tplRow.body_style, {});
            if (blocks.length > 0) {
              tplHtml = compileEmailBlocksToHtml(blocks, bodyStyle, String(matchedRemRow?.subject || camp.subject_a || camp.name));
            }
          }
        }
      }
      if (!tplHtml) {
        tplHtml = `<!DOCTYPE html><html lang="vi"><body><div style="font-family:Inter,Arial,sans-serif;padding:24px;color:#0F172A;"><p>Xin chào {{lead.name}},</p><p>Nhắc lại thông tin chiến dịch <strong>{{campaign.name}}</strong> từ {{tenant.name}}.</p><p><a href="{{unsubscribe_url}}">Hủy đăng ký</a></p></div></body></html>`;
      }

      const rawRemSubject = String(
        req.body?.subject ||
          matchedRemRow?.subject ||
          remCfg.reminder_subject ||
          `[Nhắc lại] ${camp.subject_a || camp.name}`
      );
      const campFallbacks = parseJsonCol<Record<string, string>>(camp.fallback_vars_json, {});

      let skippedSuppressed = 0;
      const jobs: Array<{
        claimId: string;
        leadId: string;
        leadName: string;
        channel: 'email' | 'zns';
        toEmail: string;
        toPhone: string;
        subject: string;
        text: string;
        html: string;
      }> = [];

      for (const claim of pendingRes.rows) {
        const ch = (matchedRemRow?.channel && matchedRemRow.channel !== 'multi' ? matchedRemRow.channel : claim.channel) === 'zns' ? 'zns' : 'email';
        if (ch === 'email') {
          const emailLower = String(claim.email || '').trim().toLowerCase();
          if (!emailLower || claim.email_consent !== 'subscribed' || isRecipientSuppressed(suppressedSet, 'email', emailLower)) {
            skippedSuppressed++;
            await client.query(
              'UPDATE mkt_send_claims SET reminder_sent = true WHERE tenant_id = $1 AND id = $2',
              [ctx.tenantId, claim.id]
            );
            continue;
          }
        } else {
          const phoneClean = String(claim.phone || '').trim();
          if (!phoneClean || claim.zns_consent === 'opted_out' || isRecipientSuppressed(suppressedSet, 'zns', phoneClean)) {
            skippedSuppressed++;
            await client.query(
              'UPDATE mkt_send_claims SET reminder_sent = true WHERE tenant_id = $1 AND id = $2',
              [ctx.tenantId, claim.id]
            );
            continue;
          }
        }

        const unsubSig = signUnsubscribeHmac(ctx.tenantId, String(claim.lead_id), ch);
        const unsubUrl = `${publicOrigin}/api/v1/public/marketing/unsubscribe?tenant_id=${ctx.tenantId}&lead_id=${claim.lead_id}&channel=${ch}&sig=${unsubSig}&claim_id=${claim.id}`;
        const mergeCtx = buildCampaignMergeContext({
          lead: {
            id: claim.lead_id,
            name: claim.lead_name || '',
            email: claim.email || '',
            phone: claim.phone || '',
            custom_fields: claim.custom_fields,
          },
          tenantName,
          campaignName: String(camp.name || ''),
          campaignSubject: rawRemSubject,
          unsubscribeUrl: unsubUrl,
        });
        const renderedSubject = renderMergeTags(rawRemSubject, mergeCtx, campFallbacks);
        const renderedHtml = renderMergeTags(tplHtml, mergeCtx, campFallbacks);
        const trackedHtml =
          ch === 'email'
            ? injectEmailOpenAndClickTracking(renderedHtml, {
                baseUrl: publicOrigin,
                claimId: claim.id,
                unsubscribeUrl: unsubUrl,
              })
            : renderedHtml;

        jobs.push({
          claimId: claim.id,
          leadId: claim.lead_id,
          leadName: claim.lead_name || '',
          channel: ch,
          toEmail: String(claim.email || '').trim().toLowerCase(),
          toPhone: String(claim.phone || '').trim(),
          subject: renderedSubject,
          text: stripHtmlTagsForPlainText(trackedHtml) || renderedSubject,
          html: trackedHtml,
        });
      }

      return {
        camp,
        matchedRemId: matchedRemRow ? String(matchedRemRow.id) : null,
        condition,
        emailReadiness,
        preloadedEmailState,
        skippedSuppressed,
        jobs,
      };
    });

    if (!prep) {
      sendApiError(res, 404, 'CAMPAIGN_NOT_FOUND', 'Không tìm thấy Chiến dịch.');
      return;
    }

    const hasEmailJobs = prep.jobs.some((j) => j.channel === 'email');
    if (
      hasEmailJobs &&
      !prep.emailReadiness.email_provider_ready &&
      !isCampaignOutboundSilent() &&
      !prep.emailReadiness.sandbox_mode
    ) {
      sendProviderRequiredError(res, prep.emailReadiness.uses_appscript_only);
      return;
    }

    // Phase 2 (Outside TX): Dispatch reminders cleanly without holding DB transaction
    const sentResults: Array<{ job: (typeof prep.jobs)[number]; providerUsed: string }> = [];
    for (const job of prep.jobs) {
      let ok = false;
      let providerUsed = 'vault_queued';
      if (job.channel === 'email') {
        const resMail = await dispatchMarketingEmail({
          tenantId: ctx.tenantId,
          to: job.toEmail,
          subject: job.subject,
          text: job.text,
          html: job.html,
          category: 'system_alert',
          meta: { campaign_id: prep.camp.id, claim_id: job.claimId, reminder: true },
          emailVaultConfigured: prep.emailReadiness.email_provider_ready,
          emailVaultType: prep.emailReadiness.active_provider,
          sandboxMode: prep.emailReadiness.sandbox_mode,
          pooled: true,
          preloadedState: prep.preloadedEmailState,
        });
        ok = resMail.sent;
        providerUsed = resMail.provider;
      } else {
        const resZns = await dispatchZnsNotification({
          tenantId: ctx.tenantId,
          phone: job.toPhone,
          templateId: prep.camp.zns_template_id ? String(prep.camp.zns_template_id) : null,
          templateData: { customer_name: job.leadName, subject: job.subject },
          message: job.subject,
          campaignId: String(prep.camp.id),
          claimId: job.claimId,
          leadId: job.leadId,
        });
        ok = resZns.sent;
        providerUsed = resZns.provider;
      }
      if (ok) sentResults.push({ job, providerUsed });
    }

    // Phase 3 (Short TX): Persist reminder_sent flags & timeline events
    if (sentResults.length > 0) {
      await withTenantTransaction(ctx.tenantId, async (client) => {
        for (const item of sentResults) {
          await client.query(
            'UPDATE mkt_send_claims SET reminder_sent = true WHERE tenant_id = $1 AND id = $2',
            [ctx.tenantId, item.job.claimId]
          );
          await client.query(
            `INSERT INTO lead_timeline_events (
               id, tenant_id, lead_id, event_type, event_category, actor_id, actor_role, actor_name, title, content, metadata
             ) VALUES ($1, $2, $3, $4, 'communication', $5, 'tenant_admin', $6, $7, $8, $9::jsonb)`,
            [
              crypto.randomUUID(),
              ctx.tenantId,
              item.job.leadId,
              item.job.channel === 'zns' ? 'zns_sent' : 'mkt_email_sent',
              ctx.userId,
              ctx.userName || 'Campaign Reminder',
              `Gửi nhắc lại (${prep.condition}): ${prep.camp.name}`,
              item.job.subject,
              JSON.stringify({ campaign_id: prep.camp.id, claim_id: item.job.claimId, reminder: true, provider: item.providerUsed }),
            ]
          );
        }
        if (prep.matchedRemId) {
          await client.query(
            `UPDATE mkt_campaign_reminders
             SET dispatched_count = dispatched_count + $3,
                 updated_at = clock_timestamp()
             WHERE tenant_id = $1 AND id = $2`,
            [ctx.tenantId, prep.matchedRemId, sentResults.length]
          );
        }
      });
    }

    res.json({
      success: true,
      data: {
        condition: prep.condition,
        reminders_dispatched: sentResults.length,
        suppressed_skipped: prep.skippedSuppressed,
      },
    });
  } catch (err: any) {
    sendApiError(res, 500, 'REMINDER_PROCESS_FAILED', err?.message || 'Không thể chạy gửi nhắc Chiến dịch.');
  }
});

// Sync Attributed Revenue from Campaign Recipients' Total Revenue
campaignsRouter.post('/:id/attribute-revenue', requirePermission('mkt_campaigns', 'edit'), async (req, res) => {
  try {
    const ctx = getTenantContext();
    const manualBonusVnd = Math.max(0, Math.round(Number(req.body?.amount_vnd || 0)));

    const data = await withTenantTransaction(ctx.tenantId, async (client) => {
      const revRes = await client.query<{ rev: number }>(
        `SELECT COALESCE(SUM(l.total_revenue_vnd), 0)::bigint AS rev
         FROM mkt_send_claims c
         INNER JOIN leads l ON l.tenant_id = c.tenant_id AND l.id = c.lead_id
         WHERE c.tenant_id = $1 AND c.campaign_id = $2 AND (c.opened_at IS NOT NULL OR c.clicked_at IS NOT NULL)`,
        [ctx.tenantId, req.params.id]
      );
      const computedRev = Number(revRes.rows[0]?.rev || 0) + manualBonusVnd;

      await client.query(
        `UPDATE mkt_campaigns
         SET attributed_revenue_vnd = $3,
             updated_at = clock_timestamp()
         WHERE tenant_id = $1 AND id = $2`,
        [ctx.tenantId, req.params.id, computedRev]
      );

      const r = await client.query('SELECT * FROM mkt_campaigns WHERE tenant_id = $1 AND id = $2', [
        ctx.tenantId,
        req.params.id,
      ]);
      return r.rows[0] ? mapCampaignRow(r.rows[0]) : null;
    });

    if (!data) {
      sendApiError(res, 404, 'CAMPAIGN_NOT_FOUND', 'Không tìm thấy Chiến dịch.');
      return;
    }
    res.json({ success: true, data });
  } catch (err: any) {
    sendApiError(res, 500, 'ATTRIBUTE_REVENUE_FAILED', err?.message || 'Không thể đồng bộ doanh thu Chiến dịch.');
  }
});

campaignsRouter.delete('/:id', requirePermission('mkt_campaigns', 'delete'), async (req, res) => {
  try {
    const ctx = getTenantContext();
    const count = await withTenantTransaction(ctx.tenantId, async (client) => {
      const r = await client.query('DELETE FROM mkt_campaigns WHERE tenant_id = $1 AND id = $2', [
        ctx.tenantId,
        req.params.id,
      ]);
      return r.rowCount;
    });
    if (!count) {
      sendApiError(res, 404, 'CAMPAIGN_NOT_FOUND', 'Không tìm thấy Chiến dịch cần xóa.');
      return;
    }
    res.json({ success: true, data: { deleted: true } });
  } catch (err: any) {
    sendApiError(res, 500, 'DELETE_CAMPAIGN_FAILED', err?.message || 'Không thể xóa Chiến dịch.');
  }
});

// Suppression List Management
campaignsRouter.get('/suppression/list', requirePermission('mkt_campaigns', 'view'), async (_req, res) => {
  try {
    const ctx = getTenantContext();
    const items = await withTenantTransaction(ctx.tenantId, async (client) => {
      const r = await client.query(
        `SELECT * FROM mkt_suppression_list WHERE tenant_id = $1 ORDER BY created_at DESC LIMIT 200`,
        [ctx.tenantId]
      );
      return r.rows;
    });
    res.json({ success: true, data: { items } });
  } catch (err: any) {
    sendApiError(res, 500, 'LIST_SUPPRESSION_FAILED', err?.message || 'Không thể tải danh sách chặn gửi.');
  }
});

campaignsRouter.post('/suppression/list', requirePermission('mkt_campaigns', 'create'), async (req, res) => {
  try {
    const ctx = getTenantContext();
    const channel = req.body?.channel === 'zns' ? 'zns' : 'email';
    const recipient = normalizeSuppressionRecipient(channel, String(req.body?.recipient || ''));
    const reason = String(req.body?.reason || 'manual').trim();
    if (!recipient) {
      sendApiError(res, 422, 'RECIPIENT_REQUIRED', 'Vui lòng nhập Email hoặc SĐT cần đưa vào danh sách chặn.');
      return;
    }
    const id = crypto.randomUUID();
    await withTenantTransaction(ctx.tenantId, async (client) => {
      await client.query(
        `INSERT INTO mkt_suppression_list (id, tenant_id, channel, recipient, reason)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (tenant_id, channel, recipient) DO UPDATE SET reason = EXCLUDED.reason`,
        [id, ctx.tenantId, channel, recipient, reason]
      );
    });
    res.status(201).json({ success: true, data: { id, channel, recipient, reason } });
  } catch (err: any) {
    sendApiError(res, 500, 'ADD_SUPPRESSION_FAILED', err?.message || 'Không thể thêm vào danh sách chặn.');
  }
});

// Ultra-lightweight Live Sending Progress Endpoint (single-row read, zero joins)
campaignsRouter.get('/:id/progress', requirePermission('mkt_campaigns', 'view'), async (req, res) => {
  try {
    if (!UUID_REGEX.test(String(req.params.id || '').trim())) {
      sendApiError(res, 404, 'CAMPAIGN_NOT_FOUND', 'Không tìm thấy Chiến dịch.');
      return;
    }
    const ctx = getTenantContext();
    const row = await withTenantTransaction(ctx.tenantId, async (client) => {
      const r = await client.query(
        `SELECT id, status, total_targeted, sent_count, opened_count, clicked_count,
                bounced_count, unsubscribed_count, fallback_vars_json, sent_at, scheduled_at, updated_at
         FROM mkt_campaigns
         WHERE tenant_id = $1 AND id = $2
         LIMIT 1`,
        [ctx.tenantId, req.params.id]
      );
      return r.rows[0] || null;
    });
    if (!row) {
      sendApiError(res, 404, 'CAMPAIGN_NOT_FOUND', 'Không tìm thấy Chiến dịch.');
      return;
    }
    res.json({ success: true, data: buildLightweightProgressPayload(row) });
  } catch (err: any) {
    sendApiError(res, 500, 'CAMPAIGN_PROGRESS_FAILED', err?.message || 'Không thể tải tiến độ gửi Chiến dịch.');
  }
});

// CampaignDetailDrawer: Full Delivery Funnel, A/B Comparison, Click Map, Claims & Reminders
// Supports `?stats_only=1` ultra-lightweight fast path for lag-free 1.5s live sending polling!
campaignsRouter.get('/:id/detail', requirePermission('mkt_campaigns', 'view'), async (req, res) => {
  try {
    if (!UUID_REGEX.test(String(req.params.id || '').trim())) {
      sendApiError(res, 404, 'CAMPAIGN_NOT_FOUND', 'Không tìm thấy Chiến dịch.');
      return;
    }
    const ctx = getTenantContext();
    const statsOnly = req.query.stats_only === '1' || req.query.stats_only === 'true';

    if (statsOnly) {
      const row = await withTenantTransaction(ctx.tenantId, async (client) => {
        const r = await client.query(
          `SELECT id, status, total_targeted, sent_count, opened_count, clicked_count,
                  bounced_count, unsubscribed_count, fallback_vars_json, sent_at, scheduled_at, updated_at
           FROM mkt_campaigns
           WHERE tenant_id = $1 AND id = $2
           LIMIT 1`,
          [ctx.tenantId, req.params.id]
        );
        return r.rows[0] || null;
      });
      if (!row) {
        sendApiError(res, 404, 'CAMPAIGN_NOT_FOUND', 'Không tìm thấy Chiến dịch.');
        return;
      }
      res.json({ success: true, data: buildLightweightProgressPayload(row) });
      return;
    }

    const cfg = await getTenantSettingsCached(ctx.tenantId);

    const data = await withTenantTransaction(ctx.tenantId, async (client) => {
      const cRes = await client.query(
        `SELECT c.*, a.name AS audience_name, a.audience_type AS audience_type, t.name AS template_name, t.compiled_html
         FROM mkt_campaigns c
         LEFT JOIN tenant_audiences a ON a.tenant_id = c.tenant_id AND a.id = c.audience_id
         LEFT JOIN mkt_email_templates t ON t.tenant_id = c.tenant_id AND t.id = c.template_id
         WHERE c.tenant_id = $1 AND c.id = $2
         LIMIT 1`,
        [ctx.tenantId, req.params.id]
      );
      const campRow = cRes.rows[0];
      if (!campRow) return null;

      const canUnmask = await canUserUnmaskMarketingPii(client, ctx.tenantId, ctx.userId);
      const [claimsRes, remsRes, clickEventsRes] = await Promise.all([
        client.query(
          `SELECT sc.*, l.name, l.phone, l.email, l.total_revenue_vnd
           FROM mkt_send_claims sc
           LEFT JOIN leads l ON l.tenant_id = sc.tenant_id AND l.id = sc.lead_id
           WHERE sc.tenant_id = $1 AND sc.campaign_id = $2
           ORDER BY sc.claimed_at DESC
           LIMIT 250`,
          [ctx.tenantId, req.params.id]
        ),
        client.query(
          `SELECT * FROM mkt_campaign_reminders
           WHERE tenant_id = $1 AND campaign_id = $2
           ORDER BY step_order ASC, created_at ASC`,
          [ctx.tenantId, req.params.id]
        ),
        client.query<{ content: string; cnt: number }>(
          `SELECT COALESCE(content, 'https://domation.net') AS content, COUNT(*)::int AS cnt
           FROM lead_timeline_events
           WHERE tenant_id = $1 AND event_type = 'email_clicked'
             AND lead_id IN (SELECT lead_id FROM mkt_send_claims WHERE tenant_id = $1 AND campaign_id = $2)
           GROUP BY content
           ORDER BY cnt DESC
           LIMIT 20`,
          [ctx.tenantId, req.params.id]
        ),
      ]);

      const abStats = {
        A: { sent: 0, opened: 0, clicked: 0, bounced: 0 },
        B: { sent: 0, opened: 0, clicked: 0, bounced: 0 },
      };
      const providers: Record<string, number> = {};

      const claims = claimsRes.rows.map((row) => {
        const v = String(row.variant || 'A') === 'B' ? 'B' : 'A';
        abStats[v].sent++;
        if (row.opened_at) abStats[v].opened++;
        if (row.clicked_at) abStats[v].clicked++;
        if (row.status === 'bounced') abStats[v].bounced++;

        const meta = parseJsonCol<Record<string, unknown>>(row.metadata, {});
        const prov = String(meta.provider || 'vault');
        providers[prov] = (providers[prov] || 0) + 1;

        const masked = maskContactPiiIfDisallowed(row, canUnmask, cfg);
        return {
          ...masked,
          metadata: meta,
        };
      });

      const mappedCamp = mapCampaignRow(campRow);
      const totalClickEvents = clickEventsRes.rows.reduce((s, r) => s + Number(r.cnt || 0), 0);

      return {
        campaign: mappedCamp,
        stats_json: mappedCamp.stats_json,
        attachments: mappedCamp.attachments,
        compiled_html: String(campRow.compiled_html || ''),
        funnel: {
          targeted: mappedCamp.total_targeted,
          sent: mappedCamp.sent_count,
          delivered: Math.max(0, mappedCamp.sent_count - mappedCamp.bounced_count),
          opened: mappedCamp.opened_count,
          clicked: mappedCamp.clicked_count,
          bounced: mappedCamp.bounced_count,
          unsubscribed: mappedCamp.unsubscribed_count,
        },
        ab_comparison: {
          variant_a: {
            ...abStats.A,
            open_rate_pct: abStats.A.sent ? Number(((abStats.A.opened / abStats.A.sent) * 100).toFixed(1)) : 0,
            click_rate_pct: abStats.A.sent ? Number(((abStats.A.clicked / abStats.A.sent) * 100).toFixed(1)) : 0,
          },
          variant_b: {
            ...abStats.B,
            open_rate_pct: abStats.B.sent ? Number(((abStats.B.opened / abStats.B.sent) * 100).toFixed(1)) : 0,
            click_rate_pct: abStats.B.sent ? Number(((abStats.B.clicked / abStats.B.sent) * 100).toFixed(1)) : 0,
          },
        },
        click_map: clickEventsRes.rows.map((r) => ({
          url: String(r.content),
          clicks: Number(r.cnt || 0),
          share_pct: totalClickEvents > 0 ? Number(((Number(r.cnt || 0) / totalClickEvents) * 100).toFixed(1)) : 0,
        })),
        claims,
        reminders: remsRes.rows,
        tech_stats: {
          providers,
          throttle_per_minute: mappedCamp.throttle_per_minute,
        },
      };
    });

    if (!data) {
      sendApiError(res, 404, 'CAMPAIGN_NOT_FOUND', 'Không tìm thấy Chiến dịch.');
      return;
    }
    res.json({ success: true, data });
  } catch (err: any) {
    sendApiError(res, 500, 'CAMPAIGN_DETAIL_FAILED', err?.message || 'Không thể tải chi tiết Chiến dịch.');
  }
});

campaignsRouter.post('/:id/pause', requirePermission('mkt_campaigns', 'edit'), async (req, res) => {
  try {
    if (!UUID_REGEX.test(String(req.params.id || '').trim())) {
      sendApiError(res, 404, 'CAMPAIGN_NOT_FOUND', 'Không tìm thấy Chiến dịch.');
      return;
    }
    const ctx = getTenantContext();
    const updated = await withTenantTransaction(ctx.tenantId, async (client) => {
      const r = await client.query(
        `UPDATE mkt_campaigns
         SET status = 'paused', updated_at = clock_timestamp()
         WHERE tenant_id = $1 AND id = $2
         RETURNING *`,
        [ctx.tenantId, req.params.id]
      );
      return r.rows[0] ? mapCampaignRow(r.rows[0]) : null;
    });
    if (!updated) {
      sendApiError(res, 404, 'CAMPAIGN_NOT_FOUND', 'Không tìm thấy Chiến dịch.');
      return;
    }
    res.json({ success: true, data: updated });
  } catch (err: any) {
    sendApiError(res, 500, 'PAUSE_CAMPAIGN_FAILED', err?.message || 'Không thể tạm dừng Chiến dịch.');
  }
});

campaignsRouter.post('/:id/resume', requirePermission('mkt_campaigns', 'edit'), async (req, res) => {
  try {
    const campaignId = String(req.params.id || '').trim();
    if (!UUID_REGEX.test(campaignId)) {
      sendApiError(res, 404, 'CAMPAIGN_NOT_FOUND', 'Không tìm thấy Chiến dịch.');
      return;
    }
    const ctx = getTenantContext();
    const prep = await withTenantTransaction(ctx.tenantId, async (client) => {
      const exRes = await client.query(
        'SELECT id, channel, scheduled_at FROM mkt_campaigns WHERE tenant_id = $1 AND id = $2 LIMIT 1',
        [ctx.tenantId, campaignId]
      );
      const ex = exRes.rows[0];
      if (!ex) return null;
      const nextStatus =
        ex.scheduled_at && new Date(String(ex.scheduled_at)).getTime() > Date.now() ? 'scheduled' : 'sending';

      if (nextStatus === 'sending' && (ex.channel === 'email' || ex.channel === 'multi')) {
        const readiness = await readAutomationEmailReadiness(client, ctx.tenantId);
        if (!readiness.email_provider_ready && !isCampaignOutboundSilent() && !readiness.sandbox_mode) {
          return { providerRequired: true as const, usesAppscriptOnly: readiness.uses_appscript_only };
        }
      }

      const pendingClaimsRes = await client.query<{ cnt: number }>(
        `SELECT COUNT(*)::int AS cnt FROM mkt_send_claims
         WHERE tenant_id = $1 AND campaign_id = $2 AND status = 'claimed'`,
        [ctx.tenantId, campaignId]
      );
      const pendingClaims = Number(pendingClaimsRes.rows[0]?.cnt || 0);

      const r = await client.query(
        `UPDATE mkt_campaigns
         SET status = $3, updated_at = clock_timestamp()
         WHERE tenant_id = $1 AND id = $2
         RETURNING *`,
        [ctx.tenantId, campaignId, nextStatus]
      );
      return {
        providerRequired: false as const,
        nextStatus,
        pendingClaims,
        mapped: r.rows[0] ? mapCampaignRow(r.rows[0]) : null,
      };
    });

    if (!prep || (!prep.providerRequired && !prep.mapped)) {
      sendApiError(res, 404, 'CAMPAIGN_NOT_FOUND', 'Không tìm thấy Chiến dịch.');
      return;
    }
    if (prep.providerRequired) {
      sendProviderRequiredError(res, prep.usesAppscriptOnly);
      return;
    }

    let responseData = prep.mapped!;
    if (prep.nextStatus === 'sending' && req.body?.dispatch !== false && (prep.pendingClaims > 0 || req.body?.wait === true)) {
      const publicOrigin = resolvePublicRequestOrigin(req);
      const asyncBg = req.body?.wait !== true;
      const out = await dispatchCampaignBatchHighSpeed({
        tenantId: ctx.tenantId,
        campaignId,
        publicOrigin,
        actorId: ctx.userId,
        actorName: ctx.userName || 'Campaign Resumer',
        source: 'resume',
        asyncBackground: asyncBg,
      });
      if (!out.ok && out.errorCode === 'AUTOMATION_EMAIL_PROVIDER_REQUIRED') {
        sendProviderRequiredError(res, Boolean(out.usesAppscriptOnly), out.errorMessage);
        return;
      }
      if (out.campaignRow && req.body?.wait === true) {
        responseData = mapCampaignRow(out.campaignRow);
      }
    }

    res.json({ success: true, data: responseData });
  } catch (err: any) {
    sendApiError(res, 500, 'RESUME_CAMPAIGN_FAILED', err?.message || 'Không thể tiếp tục Chiến dịch.');
  }
});

campaignsRouter.post('/:id/pre-send-review', requirePermission('mkt_campaigns', 'view'), async (req, res) => {
  try {
    const ctx = getTenantContext();
    const data = await runPreSendReviewForPayload(ctx.tenantId, req.body || {}, req.params.id);
    res.json({ success: true, data });
  } catch (err: any) {
    sendApiError(res, 500, 'PRE_SEND_REVIEW_FAILED', err?.message || 'Không thể kiểm tra Chiến dịch.');
  }
});

campaignsRouter.post('/:id/test-email', requirePermission('mkt_campaigns', 'view'), async (req, res) => {
  try {
    const ctx = getTenantContext();
    const out = await runCampaignTestEmail(ctx.tenantId, ctx.userName, req.body || {}, req.params.id);
    if (out.error === 'INVALID_TEST_EMAIL') {
      sendApiError(res, 422, 'INVALID_TEST_EMAIL', 'Vui lòng nhập Email nhận bản thử nghiệm.');
      return;
    }
    if (out.error === 'AUTOMATION_EMAIL_PROVIDER_REQUIRED') {
      sendProviderRequiredError(res, Boolean(out.uses_appscript_only));
      return;
    }
    res.json({ success: true, data: out });
  } catch (err: any) {
    sendApiError(res, 500, 'TEST_EMAIL_FAILED', err?.message || 'Không thể gửi Email thử nghiệm.');
  }
});

// ReminderManager CRUD (`mkt_campaign_reminders`)
campaignsRouter.get('/:id/reminders', requirePermission('mkt_campaigns', 'view'), async (req, res) => {
  try {
    const ctx = getTenantContext();
    const items = await withTenantTransaction(ctx.tenantId, async (client) => {
      const r = await client.query(
        'SELECT * FROM mkt_campaign_reminders WHERE tenant_id = $1 AND campaign_id = $2 ORDER BY step_order ASC',
        [ctx.tenantId, req.params.id]
      );
      return r.rows;
    });
    res.json({ success: true, data: { items } });
  } catch (err: any) {
    sendApiError(res, 500, 'LIST_REMINDERS_FAILED', err?.message || 'Không thể tải danh sách bước gửi nhắc.');
  }
});

campaignsRouter.post('/:id/reminders', requirePermission('mkt_campaigns', 'edit'), async (req, res) => {
  try {
    const ctx = getTenantContext();
    const remId = crypto.randomUUID();
    const created = await withTenantTransaction(ctx.tenantId, async (client) => {
      const cCheck = await client.query('SELECT id, subject_a FROM mkt_campaigns WHERE tenant_id = $1 AND id = $2 LIMIT 1', [
        ctx.tenantId,
        req.params.id,
      ]);
      if (!cCheck.rows[0]) return null;

      const stepOrder = Math.max(1, Math.round(Number(req.body?.step_order || 1)));
      const triggerCondition = ['no_open', 'no_click', 'clicked_no_convert'].includes(String(req.body?.trigger_condition || ''))
        ? String(req.body.trigger_condition)
        : 'no_open';
      const waitHours = Math.max(1, Math.round(Number(req.body?.wait_hours || 24)));
      const subject = String(req.body?.subject || `Nhắc lại: ${cCheck.rows[0].subject_a || ''}`).trim();
      const templateId = req.body?.template_id ? String(req.body.template_id) : null;
      const channel = req.body?.channel === 'zns' ? 'zns' : 'email';

      await client.query(
        `INSERT INTO mkt_campaign_reminders (
           id, tenant_id, campaign_id, step_order, trigger_condition, wait_hours, subject, template_id, channel, is_active
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, true)`,
        [remId, ctx.tenantId, req.params.id, stepOrder, triggerCondition, waitHours, subject, templateId, channel]
      );
      const r = await client.query('SELECT * FROM mkt_campaign_reminders WHERE tenant_id = $1 AND id = $2', [
        ctx.tenantId,
        remId,
      ]);
      return r.rows[0];
    });

    if (!created) {
      sendApiError(res, 404, 'CAMPAIGN_NOT_FOUND', 'Không tìm thấy Chiến dịch.');
      return;
    }
    res.status(201).json({ success: true, data: created });
  } catch (err: any) {
    sendApiError(res, 500, 'CREATE_REMINDER_FAILED', err?.message || 'Không thể thêm bước gửi nhắc.');
  }
});

campaignsRouter.delete('/:id/reminders/:remId', requirePermission('mkt_campaigns', 'edit'), async (req, res) => {
  try {
    const ctx = getTenantContext();
    await withTenantTransaction(ctx.tenantId, async (client) => {
      await client.query(
        'DELETE FROM mkt_campaign_reminders WHERE tenant_id = $1 AND campaign_id = $2 AND id = $3',
        [ctx.tenantId, req.params.id, req.params.remId]
      );
    });
    res.json({ success: true, data: { deleted: true } });
  } catch (err: any) {
    sendApiError(res, 500, 'DELETE_REMINDER_FAILED', err?.message || 'Không thể xóa bước gửi nhắc.');
  }
});

// Single Campaign Read + `?stats_only=1` ultra-lightweight live metrics polling endpoint
campaignsRouter.get('/:id', requirePermission('mkt_campaigns', 'view'), async (req, res) => {
  try {
    const campaignId = String(req.params.id || '').trim();
    if (!UUID_REGEX.test(campaignId)) {
      sendApiError(res, 404, 'CAMPAIGN_NOT_FOUND', 'Không tìm thấy Chiến dịch.');
      return;
    }
    const ctx = getTenantContext();
    const statsOnly = req.query.stats_only === '1' || req.query.stats_only === 'true';

    const row = await withTenantTransaction(ctx.tenantId, async (client) => {
      if (statsOnly) {
        const r = await client.query(
          `SELECT id, status, total_targeted, sent_count, opened_count, clicked_count,
                  bounced_count, unsubscribed_count, fallback_vars_json, sent_at, scheduled_at, updated_at
           FROM mkt_campaigns
           WHERE tenant_id = $1 AND id = $2
           LIMIT 1`,
          [ctx.tenantId, campaignId]
        );
        return r.rows[0] || null;
      }
      const r = await client.query(
        `SELECT c.*, a.name AS audience_name, a.audience_type AS audience_type, t.name AS template_name
         FROM mkt_campaigns c
         LEFT JOIN tenant_audiences a ON a.tenant_id = c.tenant_id AND a.id = c.audience_id
         LEFT JOIN mkt_email_templates t ON t.tenant_id = c.tenant_id AND t.id = c.template_id
         WHERE c.tenant_id = $1 AND c.id = $2
         LIMIT 1`,
        [ctx.tenantId, campaignId]
      );
      return r.rows[0] || null;
    });

    if (!row) {
      sendApiError(res, 404, 'CAMPAIGN_NOT_FOUND', 'Không tìm thấy Chiến dịch.');
      return;
    }

    res.json({
      success: true,
      data: statsOnly ? buildLightweightProgressPayload(row) : mapCampaignRow(row),
    });
  } catch (err: any) {
    sendApiError(res, 500, 'GET_CAMPAIGN_FAILED', err?.message || 'Không thể tải Chiến dịch.');
  }
});
