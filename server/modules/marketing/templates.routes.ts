import crypto from 'node:crypto';
import fsSync from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import zlib from 'node:zlib';
import { Router } from 'express';
import { withTenantTransaction } from '../../core/database/transaction.ts';
import { getTenantContext } from '../../core/context/tenant-context.ts';
import {
  requireEntitlement,
  requirePermission,
  sendApiError,
} from '../../core/security/rbac.ts';
import { normalizeTenantSettings } from '../../core/settings/tenant-settings.ts';
import { resolveDecryptedSharedAiConfig } from '../../services/dom-meta-report.service.ts';
import {
  analyzeEmailSpamScore,
  buildCountdownTimerSvg,
  compileEmailBlocksToHtml,
  parseJsonCol,
  readTenantChannelVault,
  renderMergeTags,
  stripHtmlTagsForPlainText,
  type EmailBlockDto,
  type EmailBodyStyleDto,
} from './utils.ts';
import { dispatchMarketingEmail } from './dispatchers.ts';

export const templatesRouter = Router();

templatesRouter.use(requireEntitlement('mkt_templates'));

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function localUploadFileExists(relPath: string): boolean {
  const clean = String(relPath || '').replace(/^\/+/, '').split(/[?#]/)[0];
  if (!clean || clean.includes('..') || clean.includes('\\')) return false;
  const uploadRoots = [
    process.env.UPLOADS_PUBLIC_DIR ? path.resolve(process.env.UPLOADS_PUBLIC_DIR) : '',
    path.resolve(process.cwd(), 'public', 'uploads'),
    path.resolve(process.cwd(), 'uploads'),
  ].filter(Boolean);
  for (const root of uploadRoots) {
    try {
      if (!fsSync.existsSync(root)) continue;
      const rootReal = fsSync.realpathSync(root);
      const candidate = path.resolve(rootReal, clean);
      if (candidate !== rootReal && !candidate.startsWith(rootReal + path.sep)) continue;
      const resolved = fsSync.realpathSync(candidate);
      if ((resolved === rootReal || resolved.startsWith(rootReal + path.sep)) && fsSync.statSync(resolved).isFile()) {
        return true;
      }
    } catch {
      continue;
    }
  }
  return false;
}

function resolveTemplateThumbUrl(raw: unknown): string | null {
  const s = String(raw || '').trim();
  if (!s) return null;
  const uploadMatch = s.match(/^(?:https?:\/\/[^/]+)?(\/uploads\/(.+))$/i);
  if (uploadMatch && uploadMatch[2]) {
    const cleanRel = uploadMatch[2].replace(/^\/+/, '');
    return localUploadFileExists(cleanRel) ? `/uploads/${cleanRel}` : null;
  }
  return s;
}

function mapTemplateRow(row: Record<string, unknown>) {
  const bodyStyleObj = parseJsonCol<EmailBodyStyleDto>(row.body_style, {});
  const compiledHtml = String(row.compiled_html || '');
  const savedBlocks = parseJsonCol<EmailBlockDto[]>(row.saved_blocks_json, []);
  const groupId = row.group_id ? String(row.group_id) : null;
  const groupName = row.group_name ? String(row.group_name) : null;
  const resolvedThumb = resolveTemplateThumbUrl(row.thumbnail_url);
  return {
    id: String(row.id),
    tenant_id: String(row.tenant_id),
    group_id: groupId,
    groupId,
    group_name: groupName,
    groupName,
    name: String(row.name || ''),
    subject: String(row.subject || ''),
    preheader: String(row.preheader || ''),
    category: String(row.category || 'general'),
    blocks: parseJsonCol<EmailBlockDto[]>(row.blocks_json, []),
    saved_blocks: savedBlocks,
    savedBlocks,
    body_style: bodyStyleObj,
    bodyStyle: bodyStyleObj,
    compiled_html: compiledHtml,
    htmlContent: compiledHtml,
    thumbnail_url: resolvedThumb,
    thumbnail: resolvedThumb,
    spam_score: Number(row.spam_score || 0),
    merge_tags: parseJsonCol<string[]>(row.merge_tags, []),
    visibility: String(row.visibility || 'company'),
    status: String(row.status || 'active'),
    created_by: row.created_by ? String(row.created_by) : null,
    created_at: row.created_at,
    updated_at: row.updated_at,
    lastModified: row.updated_at || row.created_at,
  };
}

// Dynamic Countdown SVG Preview
templatesRouter.get('/countdown.svg', (req, res) => {
  const target = String(req.query.target || new Date(Date.now() + 86400_000 * 3).toISOString());
  const accent = String(req.query.accent || '#1E40FF');
  const label = String(req.query.label || 'Ưu đãi kết thúc sau');
  const svg = buildCountdownTimerSvg(target, accent, label);
  res.setHeader('Content-Type', 'image/svg+xml; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.send(svg);
});

// List Templates + Groups + Dynamic Tenant Merge Tags (also supports `?id=<uuid>` legacy single-fetch)
templatesRouter.get('/', requirePermission('mkt_templates', 'view'), async (req, res) => {
  try {
    const ctx = getTenantContext();
    const requestedId = String(req.query?.id || '').trim();
    if (requestedId) {
      if (!UUID_REGEX.test(requestedId)) {
        sendApiError(res, 404, 'TEMPLATE_NOT_FOUND', 'Không tìm thấy mẫu Email trong doanh nghiệp.');
        return;
      }
      const singleRow = await withTenantTransaction(ctx.tenantId, async (client) => {
        const r = await client.query(
          `SELECT t.*, g.name AS group_name
           FROM mkt_email_templates t
           LEFT JOIN mkt_template_groups g ON g.tenant_id = t.tenant_id AND g.id = t.group_id
           WHERE t.tenant_id = $1 AND t.id = $2
           LIMIT 1`,
          [ctx.tenantId, requestedId]
        );
        return r.rows[0] || null;
      });
      if (!singleRow) {
        sendApiError(res, 404, 'TEMPLATE_NOT_FOUND', 'Không tìm thấy mẫu Email trong doanh nghiệp.');
        return;
      }
      res.json({ success: true, data: mapTemplateRow(singleRow) });
      return;
    }
    const data = await withTenantTransaction(ctx.tenantId, async (client) => {
      const [tplRes, grpRes, cfRes, tenantRes] = await Promise.all([
        client.query(
          `SELECT t.*, g.name AS group_name
           FROM mkt_email_templates t
           LEFT JOIN mkt_template_groups g ON g.tenant_id = t.tenant_id AND g.id = t.group_id
           WHERE t.tenant_id = $1 AND t.status != 'archived'
           ORDER BY t.updated_at DESC`,
          [ctx.tenantId]
        ),
        client.query(
          `SELECT id, name, description, color_hex, created_at
           FROM mkt_template_groups
           WHERE tenant_id = $1
           ORDER BY name ASC`,
          [ctx.tenantId]
        ),
        client.query<{ field_key: string; field_label: string }>(
          `SELECT DISTINCT field_key, field_label
           FROM tenant_pipeline_custom_fields
           WHERE tenant_id = $1
           ORDER BY field_key ASC`,
          [ctx.tenantId]
        ),
        client.query<{ name: string; slug: string; settings: Record<string, unknown> }>(
          'SELECT name, slug, settings FROM tenants WHERE id = $1 LIMIT 1',
          [ctx.tenantId]
        ),
      ]);

      const mergeTags = [
        { key: '{{lead.name}}', label: 'Họ tên Khách hàng', sample: 'Nguyễn Minh Anh' },
        { key: '{{lead.phone}}', label: 'Số điện thoại', sample: '0909123456' },
        { key: '{{lead.email}}', label: 'Địa chỉ Email', sample: 'minhanh@company.vn' },
        { key: '{{lead.product_interest}}', label: 'Sản phẩm / Dịch vụ quan tâm', sample: 'Growth Suite' },
        { key: '{{lead.voucher_code}}', label: 'Mã ưu đãi cá nhân hóa', sample: 'DOM-VIP20' },
        { key: '{{tenant.name}}', label: 'Tên Thương hiệu Doanh nghiệp', sample: tenantRes.rows[0]?.name || 'DOMATION' },
        { key: '{{unsubscribe_url}}', label: 'Liên kết Hủy đăng ký chuẩn HMAC', sample: 'https://domation.net/unsubscribe' },
        ...cfRes.rows.map((cf) => ({
          key: `{{lead.custom_fields.${cf.field_key}}}`,
          label: `${cf.field_label || cf.field_key} (Trường tùy chỉnh)`,
          sample: 'Giá trị tùy chỉnh',
        })),
      ];

      const sesVault = await readTenantChannelVault(client, ctx.tenantId, ['aws_ses', 'smtp']);
      const tSettings = (tenantRes.rows[0]?.settings || {}) as Record<string, unknown>;
      const hasAppscript = Boolean(String(tSettings.appscript_webhook_url || '').trim());
      const hasResend = Boolean(String(tSettings.resend_api_key || '').trim());
      const emailConfigured = sesVault.configured || hasAppscript || hasResend;
      const emailProvider =
        sesVault.integrationType || (hasAppscript ? 'appscript' : hasResend ? 'resend' : null);

      return {
        items: tplRes.rows.map(mapTemplateRow),
        groups: grpRes.rows,
        merge_tags: mergeTags,
        sender_vault: {
          configured: emailConfigured,
          provider: emailProvider,
          from_email: String(sesVault.config.from_email || sesVault.config.fromEmail || tSettings.resend_from_email || ''),
          from_name: String(sesVault.config.from_name || sesVault.config.fromName || tenantRes.rows[0]?.name || ''),
        },
      };
    });

    res.json({ success: true, data });
  } catch (err: any) {
    sendApiError(res, 500, 'LIST_TEMPLATES_FAILED', err?.message || 'Không thể tải thư viện mẫu Email.');
  }
});

// Create Template Group
templatesRouter.post('/groups', requirePermission('mkt_templates', 'create'), async (req, res) => {
  try {
    const ctx = getTenantContext();
    const name = String(req.body?.name || '').trim();
    if (!name) {
      sendApiError(res, 422, 'GROUP_NAME_REQUIRED', 'Vui lòng nhập tên nhóm mẫu Email.');
      return;
    }
    const id = crypto.randomUUID();
    const colorHex = String(req.body?.color_hex || '#1E40FF').trim();
    const description = req.body?.description ? String(req.body.description).trim() : null;

    const created = await withTenantTransaction(ctx.tenantId, async (client) => {
      await client.query(
        `INSERT INTO mkt_template_groups (id, tenant_id, name, description, color_hex, created_by)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [id, ctx.tenantId, name, description, colorHex, ctx.userId]
      );
      const r = await client.query('SELECT * FROM mkt_template_groups WHERE tenant_id = $1 AND id = $2', [
        ctx.tenantId,
        id,
      ]);
      return r.rows[0];
    });

    res.status(201).json({ success: true, data: created });
  } catch (err: any) {
    sendApiError(res, 500, 'CREATE_TEMPLATE_GROUP_FAILED', err?.message || 'Không thể tạo nhóm mẫu Email.');
  }
});

templatesRouter.delete('/groups/:id', requirePermission('mkt_templates', 'delete'), async (req, res) => {
  try {
    const ctx = getTenantContext();
    await withTenantTransaction(ctx.tenantId, async (client) => {
      await client.query('DELETE FROM mkt_template_groups WHERE tenant_id = $1 AND id = $2', [
        ctx.tenantId,
        req.params.id,
      ]);
    });
    res.json({ success: true, data: { deleted: true } });
  } catch (err: any) {
    sendApiError(res, 500, 'DELETE_TEMPLATE_GROUP_FAILED', err?.message || 'Không thể xóa nhóm mẫu Email.');
  }
});

// Compile HTML + Spam Score Analyzer
templatesRouter.post('/compile', requirePermission('mkt_templates', 'view'), async (req, res) => {
  try {
    const blocks: EmailBlockDto[] = Array.isArray(req.body?.blocks) ? req.body.blocks : [];
    const rawStyle = req.body?.body_style ?? req.body?.bodyStyle;
    const bodyStyle: EmailBodyStyleDto = rawStyle && typeof rawStyle === 'object' ? rawStyle : {};
    const subject = String(req.body?.subject || '');
    const title = String(req.body?.name || subject || 'DOMATION Email');

    const compiledHtml = compileEmailBlocksToHtml(blocks, bodyStyle, title);
    const spamAnalysis = analyzeEmailSpamScore(subject, blocks, compiledHtml);

    res.json({
      success: true,
      data: {
        compiled_html: compiledHtml,
        spam_analysis: spamAnalysis,
      },
    });
  } catch (err: any) {
    sendApiError(res, 500, 'COMPILE_EMAIL_FAILED', err?.message || 'Không thể biên dịch HTML Email.');
  }
});

// EmailValidationPanel: Link & Deliverability Checker + SPF/DKIM Vault Status
templatesRouter.post('/validate', requirePermission('mkt_templates', 'view'), async (req, res) => {
  try {
    const ctx = getTenantContext();
    const blocks: EmailBlockDto[] = Array.isArray(req.body?.blocks) ? req.body.blocks : [];
    const rawStyleValidate = req.body?.body_style ?? req.body?.bodyStyle;
    const bodyStyle: EmailBodyStyleDto =
      rawStyleValidate && typeof rawStyleValidate === 'object' ? rawStyleValidate : {};
    const subject = String(req.body?.subject || '');
    const rawHtmlValidate = req.body?.compiled_html ?? req.body?.htmlContent;
    const compiledHtml =
      typeof rawHtmlValidate === 'string' && rawHtmlValidate.trim()
        ? rawHtmlValidate
        : compileEmailBlocksToHtml(blocks, bodyStyle, subject || 'DOMATION Email');

    const spam = analyzeEmailSpamScore(subject, blocks, compiledHtml);
    const vaultInfo = await withTenantTransaction(ctx.tenantId, async (client) => {
      const [vault, tRes] = await Promise.all([
        readTenantChannelVault(client, ctx.tenantId, ['aws_ses', 'smtp']),
        client.query<{ settings: Record<string, unknown> }>('SELECT settings FROM tenants WHERE id = $1 LIMIT 1', [
          ctx.tenantId,
        ]),
      ]);
      const tSettings = (tRes.rows[0]?.settings || {}) as Record<string, unknown>;
      const hasAppscript = Boolean(String(tSettings.appscript_webhook_url || '').trim());
      const hasResend = Boolean(String(tSettings.resend_api_key || '').trim());
      const configured = vault.configured || hasAppscript || hasResend;
      const provider = vault.integrationType || (hasAppscript ? 'appscript' : hasResend ? 'resend' : null);
      return {
        configured,
        provider,
        spf_verified: Boolean(vault.config.spf_verified ?? configured),
        dkim_verified: Boolean(vault.config.dkim_verified ?? configured),
      };
    });

    const links: Array<{ blockId: string; label: string; url: string; valid: boolean; reason?: string }> = [];
    const missingAltImages: string[] = [];

    for (const b of blocks) {
      if (b.type === 'button' || b.type === 'hero_banner' || b.type === 'product_card' || b.type === 'pricing_card' || b.type === 'video_thumbnail') {
        const rawUrl = String(b.url || '').trim();
        if (!rawUrl || rawUrl === '#') {
          links.push({
            blockId: b.id,
            label: String(b.buttonLabel || b.title || b.type),
            url: rawUrl || '(trống)',
            valid: false,
            reason: 'Chưa cấu hình URL đích thực tế',
          });
        } else {
          const ok = /^https?:\/\//i.test(rawUrl) || rawUrl.startsWith('{{');
          links.push({
            blockId: b.id,
            label: String(b.buttonLabel || b.title || b.type),
            url: rawUrl,
            valid: ok,
            reason: ok ? undefined : 'URL cần bắt đầu bằng https:// hoặc biến động {{...}}',
          });
        }
      }
      if (b.type === 'image' && !String(b.title || '').trim()) {
        missingAltImages.push(b.id);
      }
    }

    const deliverabilityScore = Math.max(0, 100 - spam.score);
    res.json({
      success: true,
      data: {
        deliverability_score: deliverabilityScore,
        spam_risk_score: spam.score,
        deliverability_grade: spam.deliverabilityGrade,
        has_unsubscribe_tag: compiledHtml.includes('{{unsubscribe_url}}'),
        vault_status: vaultInfo,
        links,
        missing_alt_block_ids: missingAltImages,
        issues: spam.issues,
      },
    });
  } catch (err: any) {
    sendApiError(res, 500, 'VALIDATE_EMAIL_FAILED', err?.message || 'Không thể kiểm tra chất lượng Email.');
  }
});

// ImageLibraryModal: Tenant Media Asset Library CRUD
templatesRouter.get('/media', requirePermission('mkt_templates', 'view'), async (req, res) => {
  try {
    const ctx = getTenantContext();
    const folder = req.query.folder ? String(req.query.folder).trim() : '';
    const q = req.query.q ? String(req.query.q).trim().toLowerCase() : '';

    const data = await withTenantTransaction(ctx.tenantId, async (client) => {
      let sql = 'SELECT * FROM mkt_media_assets WHERE tenant_id = $1';
      const params: unknown[] = [ctx.tenantId];
      if (folder && folder !== 'all') {
        params.push(folder);
        sql += ` AND folder_name = $${params.length}`;
      }
      if (q) {
        params.push(`%${q}%`);
        sql += ` AND LOWER(file_name) LIKE $${params.length}`;
      }
      sql += ' ORDER BY created_at DESC LIMIT 200';
      const [itemsRes, foldersRes] = await Promise.all([
        client.query(sql, params),
        client.query<{ folder_name: string; cnt: number }>(
          `SELECT folder_name, COUNT(*)::int AS cnt
           FROM mkt_media_assets
           WHERE tenant_id = $1
           GROUP BY folder_name
           ORDER BY folder_name ASC`,
          [ctx.tenantId]
        ),
      ]);
      return {
        items: itemsRes.rows.map((r) => ({
          ...r,
          tags: parseJsonCol<string[]>(r.tags_json, []),
        })),
        folders: foldersRes.rows,
      };
    });

    res.json({ success: true, data });
  } catch (err: any) {
    sendApiError(res, 500, 'LIST_MEDIA_FAILED', err?.message || 'Không thể tải thư viện hình ảnh.');
  }
});

templatesRouter.post('/media', requirePermission('mkt_templates', 'create'), async (req, res) => {
  try {
    const ctx = getTenantContext();
    const url = String(req.body?.url || '').trim();
    const fileName = String(req.body?.file_name || 'email-asset.png').trim();
    if (!url) {
      sendApiError(res, 422, 'MEDIA_URL_REQUIRED', 'Vui lòng cung cấp URL hoặc dữ liệu hình ảnh.');
      return;
    }
    const folderName = String(req.body?.folder_name || 'Chung').trim() || 'Chung';
    const mimeType = String(req.body?.mime_type || 'image/png').trim();
    const sizeBytes = Math.max(0, Math.round(Number(req.body?.size_bytes || 0)));
    const widthPx = req.body?.width_px ? Math.round(Number(req.body.width_px)) : null;
    const heightPx = req.body?.height_px ? Math.round(Number(req.body.height_px)) : null;
    const altText = req.body?.alt_text ? String(req.body.alt_text).trim() : fileName;
    const tags = Array.isArray(req.body?.tags) ? req.body.tags.map(String) : [];

    const id = crypto.randomUUID();
    const created = await withTenantTransaction(ctx.tenantId, async (client) => {
      await client.query(
        `INSERT INTO mkt_media_assets (
           id, tenant_id, folder_name, file_name, mime_type, url,
           size_bytes, width_px, height_px, alt_text, tags_json, created_by
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::jsonb, $12)`,
        [
          id,
          ctx.tenantId,
          folderName,
          fileName,
          mimeType,
          url,
          sizeBytes,
          widthPx,
          heightPx,
          altText,
          JSON.stringify(tags),
          ctx.userId,
        ]
      );
      const r = await client.query('SELECT * FROM mkt_media_assets WHERE tenant_id = $1 AND id = $2', [
        ctx.tenantId,
        id,
      ]);
      return r.rows[0];
    });

    res.status(201).json({ success: true, data: created });
  } catch (err: any) {
    sendApiError(res, 500, 'UPLOAD_MEDIA_FAILED', err?.message || 'Không thể thêm hình ảnh vào thư viện.');
  }
});

templatesRouter.delete('/media/:assetId', requirePermission('mkt_templates', 'delete'), async (req, res) => {
  try {
    const ctx = getTenantContext();
    await withTenantTransaction(ctx.tenantId, async (client) => {
      await client.query('DELETE FROM mkt_media_assets WHERE tenant_id = $1 AND id = $2', [
        ctx.tenantId,
        req.params.assetId,
      ]);
    });
    res.json({ success: true, data: { deleted: true } });
  } catch (err: any) {
    sendApiError(res, 500, 'DELETE_MEDIA_FAILED', err?.message || 'Không thể xóa hình ảnh.');
  }
});

// QuickSendEmailModal: Direct Personalized Dispatch to Specific Recipients / Leads
templatesRouter.post('/quick-send', requirePermission('mkt_templates', 'create'), async (req, res) => {
  try {
    const ctx = getTenantContext();
    const rawRecipients: string[] = Array.isArray(req.body?.recipients)
      ? req.body.recipients.map((r: unknown) => String(r || '').trim().toLowerCase()).filter((r: string) => r.includes('@'))
      : String(req.body?.to_email || '')
          .split(/[,;\s]+/)
          .map((s) => s.trim().toLowerCase())
          .filter((s) => s.includes('@'));

    if (rawRecipients.length === 0) {
      sendApiError(res, 422, 'RECIPIENTS_REQUIRED', 'Vui lòng nhập ít nhất 1 địa chỉ Email người nhận hợp lệ.');
      return;
    }

    const fallbackVars: Record<string, string> =
      req.body?.fallback_vars && typeof req.body.fallback_vars === 'object' ? req.body.fallback_vars : {};

    const outcome = await withTenantTransaction(ctx.tenantId, async (client) => {
      const [tenantRes, vault] = await Promise.all([
        client.query<{ name: string }>('SELECT name FROM tenants WHERE id = $1 LIMIT 1', [ctx.tenantId]),
        readTenantChannelVault(client, ctx.tenantId, ['aws_ses', 'smtp', 'appscript', 'resend']),
      ]);
      const tenantName = tenantRes.rows[0]?.name || 'DOMATION';

      let subject = String(req.body?.subject || '').trim();
      let html = String(req.body?.compiled_html || '').trim();
      if (req.body?.template_id) {
        const tRes = await client.query(
          'SELECT subject, compiled_html, blocks_json, body_style FROM mkt_email_templates WHERE tenant_id = $1 AND id = $2 LIMIT 1',
          [ctx.tenantId, String(req.body.template_id)]
        );
        const tpl = tRes.rows[0];
        if (tpl) {
          if (!subject) subject = String(tpl.subject || '');
          if (!html) {
            html = String(tpl.compiled_html || '');
            if (!html) {
              const b = parseJsonCol<EmailBlockDto[]>(tpl.blocks_json, []);
              const st = parseJsonCol<EmailBodyStyleDto>(tpl.body_style, {});
              if (b.length > 0) html = compileEmailBlocksToHtml(b, st, subject || 'DOMATION Email');
            }
          }
        }
      }
      if (!html && Array.isArray(req.body?.blocks)) {
        html = compileEmailBlocksToHtml(req.body.blocks, req.body?.body_style || {}, subject || 'DOMATION Email');
      }

      const dispatched: Array<{ email: string; lead_id: string | null; subject: string; provider: string; message_id: string }> = [];
      for (const email of rawRecipients.slice(0, 50)) {
        const lRes = await client.query(
          'SELECT id, name, phone, email, product_interest, custom_fields FROM leads WHERE tenant_id = $1 AND LOWER(email) = $2 AND is_deleted = false LIMIT 1',
          [ctx.tenantId, email]
        );
        const lead = lRes.rows[0];
        const mergeCtx = {
          lead: lead
            ? { ...lead, custom_fields: parseJsonCol(lead.custom_fields, {}) }
            : { email, name: fallbackVars['lead.name'] || 'Quý khách' },
          tenant: { name: tenantName },
          unsubscribe_url: '#unsubscribe',
        };
        const renderedSubject = renderMergeTags(
          subject || 'Thông báo từ {{tenant.name}}',
          mergeCtx,
          fallbackVars
        );
        const renderedHtml = renderMergeTags(
          html || `<div>${renderedSubject}</div>`,
          mergeCtx,
          fallbackVars
        );
        const mailRes = await dispatchMarketingEmail({
          tenantId: ctx.tenantId,
          client,
          to: email,
          subject: renderedSubject,
          text: stripHtmlTagsForPlainText(renderedHtml) || renderedSubject,
          html: renderedHtml,
          category: 'system_alert',
          meta: { quick_send: true, template_id: req.body?.template_id || null },
          emailVaultConfigured: vault.configured,
          emailVaultType: vault.integrationType,
        });

        if (!mailRes.sent) continue;

        if (lead?.id) {
          await client.query(
            `INSERT INTO lead_timeline_events (
               id, tenant_id, lead_id, event_type, event_category, actor_id, actor_role, actor_name, title, content, metadata
             ) VALUES ($1, $2, $3, 'mkt_email_sent', 'communication', $4, 'tenant_admin', $5, $6, $7, $8::jsonb)`,
            [
              crypto.randomUUID(),
              ctx.tenantId,
              lead.id,
              ctx.userId,
              ctx.userName || 'Quick Send',
              `Gửi nhanh Email: ${renderedSubject}`,
              `Kênh gửi: ${mailRes.provider}`,
              JSON.stringify({ quick_send: true, email, provider: mailRes.provider, message_id: mailRes.messageId }),
            ]
          );
        }
        dispatched.push({
          email,
          lead_id: lead?.id ? String(lead.id) : null,
          subject: renderedSubject,
          provider: mailRes.provider,
          message_id: mailRes.messageId,
        });
      }

      return {
        sent_count: dispatched.length,
        provider: dispatched[0]?.provider || vault.integrationType || 'vault_sandbox_queue',
        vault_configured: vault.configured,
        dispatched,
      };
    });

    res.json({ success: true, data: outcome });
  } catch (err: any) {
    sendApiError(res, 500, 'QUICK_SEND_FAILED', err?.message || 'Không thể gửi nhanh Email.');
  }
});

// ============================================================================
// Pure-Node PNG Architectural Banner Encoder + Gemini Multimodal Image Studio
// ============================================================================
const PNG_CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c >>> 0;
  }
  return table;
})();

function pngCrc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    c = PNG_CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

function makePngChunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(pngCrc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([len, typeBuf, data, crc]);
}

function parseHexRgb(hex: string, fallback: [number, number, number]): [number, number, number] {
  const clean = String(hex || '').trim().replace(/^#/, '');
  if (/^[0-9a-fA-F]{3}$/.test(clean)) {
    return [
      parseInt(clean[0] + clean[0], 16),
      parseInt(clean[1] + clean[1], 16),
      parseInt(clean[2] + clean[2], 16),
    ];
  }
  if (/^[0-9a-fA-F]{6}$/.test(clean)) {
    return [
      parseInt(clean.slice(0, 2), 16),
      parseInt(clean.slice(2, 4), 16),
      parseInt(clean.slice(4, 6), 16),
    ];
  }
  return fallback;
}

function renderArchitecturalFallbackBannerPng(params: {
  width: number;
  height: number;
  brandColor: string;
  stylePreset: string;
  hasLogo: boolean;
  hasReference: boolean;
}): Buffer {
  const { width, height, brandColor, stylePreset, hasLogo, hasReference } = params;
  const [br, bg, bb] = parseHexRgb(brandColor, [30, 64, 255]);
  // Secondary harmonized color based on style preset
  const preset = stylePreset.toLowerCase();
  const [sr, sg, sb]: [number, number, number] =
    preset.includes('sale') || preset.includes('offer')
      ? [Math.min(255, br + 65), Math.max(20, Math.round(bg * 0.55)), Math.max(40, Math.round(bb * 0.7))]
      : preset.includes('minimal') || preset.includes('editorial')
        ? [241, 245, 249]
        : preset.includes('event') || preset.includes('vip')
          ? [15, 23, 42]
          : [Math.max(12, Math.round(br * 0.35)), Math.min(240, Math.round(bg * 0.85 + 30)), Math.min(255, bb + 25)];

  const stride = width * 4 + 1;
  const raw = Buffer.alloc(stride * height);
  const cx = width * 0.78;
  const cy = height * 0.32;
  const glowRadius = Math.max(width, height) * 0.55;

  for (let y = 0; y < height; y++) {
    const rowOff = y * stride;
    raw[rowOff] = 0; // filter: None
    const ny = y / Math.max(1, height - 1);
    for (let x = 0; x < width; x++) {
      const nx = x / Math.max(1, width - 1);
      const t = Math.min(1, Math.max(0, nx * 0.72 + ny * 0.28));

      let r = br * (1 - t) + sr * t;
      let g = bg * (1 - t) + sg * t;
      let b = bb * (1 - t) + sb * t;

      // Soft executive spotlight glow
      const dx = x - cx;
      const dy = y - cy;
      const dist = Math.sqrt(dx * dx + dy * dy);
      if (dist < glowRadius) {
        const glow = Math.pow(1 - dist / glowRadius, 2.2) * 0.32;
        r = r + (255 - r) * glow;
        g = g + (255 - g) * glow;
        b = b + (255 - b) * glow;
      }

      // Subtle architectural grid lines
      if (x % 48 === 0 || y % 48 === 0) {
        r = r * 0.96 + 255 * 0.04;
        g = g * 0.96 + 255 * 0.04;
        b = b * 0.96 + 255 * 0.04;
      }

      // Geometric accent ring on right side
      const ringDist = Math.abs(dist - Math.min(width, height) * 0.36);
      if (ringDist < 2.2) {
        r = r * 0.65 + 255 * 0.35;
        g = g * 0.65 + 255 * 0.35;
        b = b * 0.65 + 255 * 0.35;
      }

      // Left-top brand logo anchor card indicator when logo provided
      if (hasLogo && x >= 28 && x <= 116 && y >= 24 && y <= 56) {
        r = r * 0.18 + 255 * 0.82;
        g = g * 0.18 + 255 * 0.82;
        b = b * 0.18 + 255 * 0.82;
      }

      // Subtle reference frame accent bar on bottom edge
      if (hasReference && y >= height - 6) {
        r = 255;
        g = 255;
        b = 255;
      }

      const px = rowOff + 1 + x * 4;
      raw[px] = Math.max(0, Math.min(255, Math.round(r)));
      raw[px + 1] = Math.max(0, Math.min(255, Math.round(g)));
      raw[px + 2] = Math.max(0, Math.min(255, Math.round(b)));
      raw[px + 3] = 255;
    }
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type RGBA
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;

  const compressed = zlib.deflateSync(raw, { level: 6 });
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  return Buffer.concat([
    signature,
    makePngChunk('IHDR', ihdr),
    makePngChunk('IDAT', compressed),
    makePngChunk('IEND', Buffer.alloc(0)),
  ]);
}

function resolveAspectDimensions(rawAspect: unknown): {
  aspectRatio: '16:9' | '3:1' | '4:3' | '1:1';
  width: number;
  height: number;
} {
  const val = String(rawAspect || '16:9').trim();
  if (val === '3:1') return { aspectRatio: '3:1', width: 720, height: 240 };
  if (val === '4:3') return { aspectRatio: '4:3', width: 640, height: 480 };
  if (val === '1:1') return { aspectRatio: '1:1', width: 512, height: 512 };
  return { aspectRatio: '16:9', width: 640, height: 360 };
}

const ALLOWED_INLINE_IMAGE_MIMES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif']);
const MAX_INLINE_IMAGE_BASE64_CHARS = 8_500_000; // ~6 MB decoded cap

function parseDataUrlBase64(input?: string): { mimeType: string; data: string } | null {
  if (!input || typeof input !== 'string') return null;
  const trimmed = input.trim();
  if (!trimmed || trimmed.length > MAX_INLINE_IMAGE_BASE64_CHARS) return null;
  const match = trimmed.match(/^data:(image\/[a-zA-Z0-9.+-]+);base64,(.+)$/i);
  if (match) {
    const mime = match[1].toLowerCase();
    if (!ALLOWED_INLINE_IMAGE_MIMES.has(mime)) return null;
    const data = match[2].replace(/\s+/g, '');
    if (data.length > MAX_INLINE_IMAGE_BASE64_CHARS) return null;
    return { mimeType: mime, data };
  }
  // Plain base64 payload
  if (/^[A-Za-z0-9+/=\s]{32,}$/.test(trimmed)) {
    const data = trimmed.replace(/\s+/g, '');
    if (data.length > MAX_INLINE_IMAGE_BASE64_CHARS) return null;
    return { mimeType: 'image/png', data };
  }
  return null;
}

const ALLOWED_LOCAL_IMAGE_EXTS = new Set(['.png', '.jpg', '.jpeg', '.webp']);

async function resolveImageToInlinePart(
  base64Input?: string,
  urlInput?: string,
  tenantId?: string
): Promise<{ mimeType: string; data: string } | null> {
  const parsedB64 = parseDataUrlBase64(base64Input);
  if (parsedB64) return parsedB64;

  const cleanUrl = String(urlInput || '').trim();
  if (!cleanUrl || cleanUrl.includes('\0')) return null;
  // Support local /uploadss/... paths directly from disk without network call (zero SSRF)
  if (cleanUrl.startsWith('/uploadss/')) {
    const relRaw = cleanUrl.replace(/^\/uploadss\//, '').replace(/\\/g, '/');
    if (!relRaw || relRaw.includes('..') || relRaw.startsWith('/')) return null;
    // Enforce strict tenant isolation when referencing tenant-scoped ai_generated/ directory
    if (relRaw.startsWith('ai_generated/') && tenantId) {
      const safeTenantDir = tenantId.replace(/[^a-zA-Z0-9_-]/g, '_');
      if (!relRaw.startsWith(`ai_generated/${safeTenantDir}/`)) {
        return null;
      }
    }
    const ext = path.extname(relRaw).toLowerCase();
    if (!ALLOWED_LOCAL_IMAGE_EXTS.has(ext)) return null;

    const roots = [
      process.env.UPLOADS_DIR ? path.resolve(process.env.UPLOADS_DIR) : '',
      path.resolve(process.cwd(), 'public', 'uploadss'),
      path.resolve(process.cwd(), 'uploadss'),
    ].filter(Boolean);
    for (const root of roots) {
      const candidate = path.resolve(root, relRaw);
      const relCheck = path.relative(root, candidate);
      if (relCheck && !relCheck.startsWith('..') && !path.isAbsolute(relCheck)) {
        try {
          const stat = await fs.stat(candidate);
          if (!stat.isFile() || stat.size > 6 * 1024 * 1024) continue;
          const bytes = await fs.readFile(candidate);
          const mimeType =
            ext === '.jpg' || ext === '.jpeg'
              ? 'image/jpeg'
              : ext === '.webp'
                ? 'image/webp'
                : 'image/png';
          return { mimeType, data: bytes.toString('base64') };
        } catch {
          // continue
        }
      }
    }
  }
  return null;
}

async function generateAndPersistAiBanner(params: {
  tenantId: string;
  userId: string;
  prompt: string;
  aspectRatio: '16:9' | '3:1' | '4:3' | '1:1';
  stylePreset: string;
  brandColor: string;
  referenceBase64?: string;
  referenceUrl?: string;
  logoBase64?: string;
  logoUrl?: string;
  saveToLibrary: boolean;
  geminiApiKey?: string;
}): Promise<{
  url: string;
  asset_id: string | null;
  width: number;
  height: number;
  aspect_ratio: '16:9' | '3:1' | '4:3' | '1:1';
  provider: string;
  style_preset: string;
  used_reference: boolean;
  used_logo: boolean;
  saved_to_library: boolean;
}> {
  const dims = resolveAspectDimensions(params.aspectRatio);
  const usedReference = Boolean(String(params.referenceBase64 || params.referenceUrl || '').trim());
  const usedLogo = Boolean(String(params.logoBase64 || params.logoUrl || '').trim());

  let imageBytes: Buffer | null = null;
  let provider = 'domation_brand_studio_fallback';
  const silentMode = process.env.OUTBOUND_SILENT_MODE === 'true' || process.env.NODE_ENV === 'test';

  if (!silentMode && params.geminiApiKey) {
    try {
      const [refPart, logoPart] = await Promise.all([
        resolveImageToInlinePart(params.referenceBase64, params.referenceUrl, params.tenantId),
        resolveImageToInlinePart(params.logoBase64, params.logoUrl, params.tenantId),
      ]);

      const promptLines = [
        `Design an executive-grade email marketing banner image (${dims.aspectRatio}).`,
        `Prompt: ${params.prompt}`,
        `Visual style preset: ${params.stylePreset}.`,
        `Primary brand accent color: ${params.brandColor}.`,
        usedReference ? 'Follow the visual layout rhythm, lighting mood, and composition cues of the attached reference image.' : '',
        usedLogo ? 'Cleanly integrate the attached brand logo in a balanced corner with high contrast and crisp breathing room.' : '',
        'No garbled text, high editorial polish, clean negative space, modern commercial photography / graphic art direction.',
      ].filter(Boolean);

      const parts: Array<Record<string, unknown>> = [{ text: promptLines.join('\n') }];
      if (refPart) parts.push({ inlineData: refPart });
      if (logoPart) parts.push({ inlineData: logoPart });

      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 25_000);
      try {
        const resp = await fetch(
          `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-image:generateContent?key=${encodeURIComponent(params.geminiApiKey)}`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            signal: controller.signal,
            body: JSON.stringify({
              contents: [{ role: 'user', parts }],
              generationConfig: {
                responseModalities: ['IMAGE', 'TEXT'],
              },
            }),
          }
        );
        if (resp.ok) {
          const json = (await resp.json()) as any;
          const outParts: any[] = json?.candidates?.[0]?.content?.parts || [];
          const imgPart = outParts.find((p) => p?.inlineData?.data);
          if (imgPart?.inlineData?.data) {
            imageBytes = Buffer.from(String(imgPart.inlineData.data), 'base64');
            provider = 'gemini-2.5-flash-image';
          }
        }
      } finally {
        clearTimeout(timeout);
      }

      // Secondary fallback to Imagen 3.0 if gemini-2.5-flash-image returned text only
      if (!imageBytes) {
        const imgController = new AbortController();
        const imgTimeout = setTimeout(() => imgController.abort(), 25_000);
        try {
          const imagenAspect = dims.aspectRatio === '3:1' ? '16:9' : dims.aspectRatio;
          const resp2 = await fetch(
            `https://generativelanguage.googleapis.com/v1beta/models/imagen-3.0-generate-002:predict?key=${encodeURIComponent(params.geminiApiKey)}`,
            {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              signal: imgController.signal,
              body: JSON.stringify({
                instances: [{ prompt: promptLines.join(' ') }],
                parameters: { sampleCount: 1, aspectRatio: imagenAspect },
              }),
            }
          );
          if (resp2.ok) {
            const json2 = (await resp2.json()) as any;
            const b64 = json2?.predictions?.[0]?.bytesBase64Encoded;
            if (b64) {
              imageBytes = Buffer.from(String(b64), 'base64');
              provider = 'imagen-3.0-generate-002';
            }
          }
        } finally {
          clearTimeout(imgTimeout);
        }
      }
    } catch {
      // Fall through cleanly to local architectural PNG fallback
    }
  }

  if (!imageBytes || imageBytes.length < 32) {
    imageBytes = renderArchitecturalFallbackBannerPng({
      width: dims.width,
      height: dims.height,
      brandColor: params.brandColor,
      stylePreset: params.stylePreset,
      hasLogo: usedLogo,
      hasReference: usedReference,
    });
    provider = 'domation_brand_studio_fallback';
  }

  const uploadsRoot = process.env.UPLOADS_DIR
    ? path.resolve(process.env.UPLOADS_DIR)
    : path.resolve(process.cwd(), 'public', 'uploadss');
  const safeTenantDir = params.tenantId.replace(/[^a-zA-Z0-9_-]/g, '_');
  const fileUuid = crypto.randomUUID();
  const targetDir = path.join(uploadsRoot, 'ai_generated', safeTenantDir);
  await fs.mkdir(targetDir, { recursive: true });
  const targetPath = path.join(targetDir, `${fileUuid}.png`);
  await fs.writeFile(targetPath, imageBytes);

  const publicUrl = `/uploadss/ai_generated/${safeTenantDir}/${fileUuid}.png`;
  let assetId: string | null = null;

  if (params.saveToLibrary) {
    assetId = crypto.randomUUID();
    const safeSlug = params.prompt
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/đ/gi, 'd')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 40) || 'ai-banner';
    const fileName = `${safeSlug}-${fileUuid.slice(0, 6)}.png`;
    await withTenantTransaction(params.tenantId, async (client) => {
      await client.query(
        `INSERT INTO mkt_media_assets (
           id, tenant_id, folder_name, file_name, mime_type, url,
           size_bytes, width_px, height_px, alt_text, tags_json, created_by
         ) VALUES ($1, $2, $3, $4, 'image/png', $5, $6, $7, $8, $9, $10::jsonb, $11)`,
        [
          assetId,
          params.tenantId,
          'AI Generated',
          fileName,
          publicUrl,
          imageBytes!.length,
          dims.width,
          dims.height,
          params.prompt.slice(0, 180),
          JSON.stringify(['ai_generated', params.stylePreset, dims.aspectRatio]),
          params.userId,
        ]
      );
    });
  }

  return {
    url: publicUrl,
    asset_id: assetId,
    width: dims.width,
    height: dims.height,
    aspect_ratio: dims.aspectRatio,
    provider,
    style_preset: params.stylePreset,
    used_reference: usedReference,
    used_logo: usedLogo,
    saved_to_library: params.saveToLibrary,
  };
}

// AI Email Banner Image Generator (Multimodal Reference + Brand Logo Import)
templatesRouter.post('/ai-generate-image', requirePermission('mkt_templates', 'create'), async (req, res) => {
  try {
    const ctx = getTenantContext();
    const body = (req.body && typeof req.body === 'object' ? req.body : {}) as Record<string, unknown>;
    const stylePreset = String(body.style_preset || 'hero_sale').trim() || 'hero_sale';
    const rawPrompt = String(body.prompt || '').trim();
    const prompt =
      rawPrompt ||
      `Executive email marketing hero banner (${stylePreset}) with crisp lighting and modern layout`;
    const brandColor = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.test(String(body.brand_color || '').trim())
      ? String(body.brand_color).trim()
      : '#1E40FF';
    const { aspectRatio } = resolveAspectDimensions(body.aspect_ratio);
    const saveToLibrary = body.save_to_library !== false;

    // Release PGlite mutex before outbound image generation
    const tenantGate = await withTenantTransaction(ctx.tenantId, async (client) => {
      const [tRes, aiCfg] = await Promise.all([
        client.query<{ settings: Record<string, unknown> }>(
          'SELECT settings FROM tenants WHERE id = $1 LIMIT 1',
          [ctx.tenantId]
        ),
        resolveDecryptedSharedAiConfig(client, ctx.tenantId),
      ]);
      const norm = normalizeTenantSettings(tRes.rows[0]?.settings || {});
      return {
        enabled: norm.ai_image_generator_enabled,
        apiKey: aiCfg.apiKey || '',
        brandColor: norm.brand_primary_color || '#1E40FF',
      };
    });

    if (!tenantGate.enabled) {
      sendApiError(
        res,
        403,
        'AI_IMAGE_GENERATOR_DISABLED',
        'Công tắc "AI Tạo Ảnh Banner & Sáng tạo Hình ảnh" đang tắt trong Cài đặt Trợ lý AI.'
      );
      return;
    }

    const result = await generateAndPersistAiBanner({
      tenantId: ctx.tenantId,
      userId: ctx.userId,
      prompt,
      aspectRatio,
      stylePreset,
      brandColor: body.brand_color ? brandColor : tenantGate.brandColor,
      referenceBase64: typeof body.reference_image_base64 === 'string' ? body.reference_image_base64 : undefined,
      referenceUrl: typeof body.reference_image_url === 'string' ? body.reference_image_url : undefined,
      logoBase64: typeof body.logo_image_base64 === 'string' ? body.logo_image_base64 : undefined,
      logoUrl: typeof body.logo_image_url === 'string' ? body.logo_image_url : undefined,
      saveToLibrary,
      geminiApiKey: tenantGate.apiKey || undefined,
    });

    res.status(201).json({ success: true, data: result });
  } catch (err: any) {
    sendApiError(res, 500, 'AI_IMAGE_GENERATE_FAILED', err?.message || 'Không thể tạo ảnh Banner AI.');
  }
});

// DOM Agent Email Studio (Executive Multi-Block Visual Designer + Optional Auto Hero Banner)
templatesRouter.post('/ai-generate', requirePermission('mkt_templates', 'create'), async (req, res) => {
  try {
    const ctx = getTenantContext();
    const body = (req.body && typeof req.body === 'object' ? req.body : {}) as Record<string, unknown>;
    const goal = String(body.goal || body.prompt || 'Chào mừng khách hàng mới & gửi ưu đãi').trim();
    const tone = String(body.tone || 'professional').trim().toLowerCase();
    const industry = String(body.industry || '').trim();
    const brandStyle = String(body.brand_style || 'executive_modern').trim();
    const referenceCues = String(body.reference_cues || '').trim();
    const ctaUrl = String(body.cta_url || 'https://domation.net').trim();
    const includeVoucher = Boolean(body.include_voucher ?? true);
    const includeCountdown = Boolean(body.include_countdown ?? true);
    const includeBlocksRaw = Array.isArray(body.include_blocks) ? body.include_blocks.map(String) : [];
    const autoGenerateBanner = Boolean(body.auto_generate_hero_banner);
    const logoUrl = String(body.logo_url || '').trim();
    let heroImageUrl = String(body.hero_image_url || '').trim();

    const tenantInfo = await withTenantTransaction(ctx.tenantId, async (client) => {
      const [r, aiCfg] = await Promise.all([
        client.query<{ name: string; industry: string; settings: Record<string, unknown> }>(
          'SELECT name, industry, settings FROM tenants WHERE id = $1 LIMIT 1',
          [ctx.tenantId]
        ),
        resolveDecryptedSharedAiConfig(client, ctx.tenantId),
      ]);
      const row = r.rows[0] || { name: 'Doanh nghiệp của bạn', industry: 'general', settings: {} };
      const norm = normalizeTenantSettings(row.settings || {});
      return {
        name: norm.brand_display_name || row.name || 'Doanh nghiệp của bạn',
        industry: industry || row.industry || norm.industry_key || 'general',
        primaryColor: norm.brand_primary_color || '#1E40FF',
        brandLogoUrl: logoUrl || norm.brand_logo_url || '',
        footerText: norm.brand_email_footer_text || 'Hệ thống Marketing Automation & CRM Chuyên nghiệp',
        aiEmailDesignerEnabled: norm.ai_email_designer_enabled,
        aiImageGeneratorEnabled: norm.ai_image_generator_enabled,
        apiKey: aiCfg.apiKey || '',
      };
    });

    if (!tenantInfo.aiEmailDesignerEnabled) {
      sendApiError(
        res,
        403,
        'AI_EMAIL_DESIGNER_DISABLED',
        'Công tắc "AI Thiết kế Email Marketing" đang tắt trong Cài đặt Trợ lý AI.'
      );
      return;
    }

    const rawColor = String(body.brand_color || '').trim();
    const accentColor =
      /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.test(rawColor) ? rawColor : tenantInfo.primaryColor;

    let heroBannerAsset: Awaited<ReturnType<typeof generateAndPersistAiBanner>> | null = null;
    if (autoGenerateBanner && !heroImageUrl && tenantInfo.aiImageGeneratorEnabled) {
      heroBannerAsset = await generateAndPersistAiBanner({
        tenantId: ctx.tenantId,
        userId: ctx.userId,
        prompt: `${tenantInfo.name} email hero banner for: ${goal}`,
        aspectRatio: '16:9',
        stylePreset: brandStyle === 'luxury' || tone === 'luxury' ? 'event_invite' : 'hero_sale',
        brandColor: accentColor,
        logoUrl: tenantInfo.brandLogoUrl || undefined,
        saveToLibrary: true,
        geminiApiKey: tenantInfo.apiKey || undefined,
      });
      heroImageUrl = heroBannerAsset.url;
    }

    const greeting =
      tone === 'friendly'
        ? 'Chào bạn {{lead.name}},'
        : tone === 'urgent' || tone === 'persuasive'
          ? 'Thông báo đặc quyền giới hạn dành riêng cho {{lead.name}},'
          : tone === 'luxury'
            ? 'Trân trọng kính mời Quý khách {{lead.name}},'
            : 'Kính gửi {{lead.name}},';

    const toneBadge =
      tone === 'luxury'
        ? 'EXECUTIVE EDITION'
        : tone === 'urgent' || tone === 'persuasive'
          ? 'ƯU ĐÃI GIỚI HẠN'
          : tone === 'friendly'
            ? 'BẢN TIN ĐẶC QUYỀN'
            : 'THÔNG BÁO CHÍNH THỨC';

    const industryHighlights: Record<string, Array<{ heading: string; body: string }>> = {
      education: [
        { heading: 'Lộ trình Chuẩn Quốc tế', body: 'Chương trình thiết kế thực chiến, đồng hành 1:1 cùng chuyên gia đầu ngành.' },
        { heading: 'Học bổng & Ưu tiên Xét duyệt', body: 'Hỗ trợ hồ sơ nhanh chóng kèm đặc quyền học phí dành riêng cho đợt này.' },
      ],
      real_estate: [
        { heading: 'Pháp lý Minh bạch 100%', body: 'Hồ sơ quy hoạch rõ ràng, tiến độ cam kết và chính sách thanh toán linh hoạt.' },
        { heading: 'Đặc quyền Tham quan Riêng', body: 'Đặt lịch tư vấn 1:1 cùng chuyên viên cấp cao và nhận bảng hàng mới nhất.' },
      ],
      ecommerce: [
        { heading: 'Thiết kế Tuyển chọn', body: 'Chất liệu cao cấp, số lượng giới hạn cho bộ sưu tập mới nhất mùa này.' },
        { heading: 'Giao hàng Ưu tiên & Đổi trả Dễ dàng', body: 'Miễn phí vận chuyển toàn quốc và bảo hành chính hãng 30 ngày.' },
      ],
    };
    const featurePair = industryHighlights[tenantInfo.industry.toLowerCase()] || [
      { heading: 'Triển khai Tức thì & Hiệu quả', body: 'Quy trình chuẩn hóa giúp tối ưu thời gian, nâng cao hiệu suất chuyển đổi rõ rệt.' },
      { heading: 'Đồng hành Chuyên sâu 1:1', body: 'Đội ngũ chuyên gia luôn sẵn sàng hỗ trợ và tùy biến theo mục tiêu thực tế của bạn.' },
    ];

    const generatedBlocks: EmailBlockDto[] = [];

    if (heroImageUrl) {
      generatedBlocks.push({
        id: crypto.randomUUID(),
        type: 'image',
        title: `${tenantInfo.name} — ${goal}`,
        imageUrl: heroImageUrl,
        url: ctaUrl,
        align: 'center',
      });
    }

    generatedBlocks.push(
      {
        id: crypto.randomUUID(),
        type: 'hero_banner',
        title: `${tenantInfo.name} — ${goal}`,
        subtitle: toneBadge,
        content: referenceCues
          ? `Giải pháp cá nhân hóa dành cho {{lead.product_interest}} (${referenceCues.slice(0, 90)}).`
          : `Giải pháp được cá nhân hóa dành riêng cho nhu cầu {{lead.product_interest}} của Quý khách.`,
        buttonLabel: tone === 'luxury' ? 'Xác nhận Đặc quyền VIP' : 'Khám phá Chi tiết Ngay',
        url: ctaUrl,
        align: 'center',
        accentColor,
      },
      {
        id: crypto.randomUUID(),
        type: 'text',
        title: 'Điểm nhấn giá trị thực tiễn',
        content: `${greeting}\n\nĐội ngũ ${tenantInfo.name} trân trọng gửi tới bạn thông tin nổi bật về "${goal}". Chúng tôi thiết kế lộ trình tinh gọn giúp bạn đạt kết quả tối ưu ngay từ tuần đầu tiên triển khai.`,
        align: 'left',
      },
      {
        id: crypto.randomUUID(),
        type: 'columns',
        columns: [
          {
            heading: featurePair[0].heading,
            body: featurePair[0].body,
            ctaLabel: 'Tìm hiểu thêm',
            ctaUrl,
          },
          {
            heading: featurePair[1].heading,
            body: featurePair[1].body,
            ctaLabel: 'Xem chi tiết',
            ctaUrl,
          },
        ],
      },
      {
        id: crypto.randomUUID(),
        type: 'text',
        title: 'Khách hàng nói gì về chúng tôi',
        content: `"Trải nghiệm cùng ${tenantInfo.name} vượt xa kỳ vọng — đội ngũ phản hồi cực nhanh, quy trình rõ ràng và mang lại tăng trưởng thực chất chỉ sau 30 ngày." — Đại diện Khách hàng Doanh nghiệp`,
        align: 'left',
        backgroundColor: '#F8FAFC',
      }
    );

    if (includeVoucher || includeBlocksRaw.includes('voucher')) {
      generatedBlocks.push({
        id: crypto.randomUUID(),
        type: 'voucher_box',
        title: 'Mã Ưu Đãi Đặc Quyền Của Bạn',
        voucherCode: '{{lead.voucher_code}}',
        content: 'Sao chép và nhập mã khi xác nhận đăng ký để nhận ưu đãi trực tiếp.',
        accentColor,
      });
    }

    if (includeCountdown || includeBlocksRaw.includes('countdown')) {
      generatedBlocks.push({
        id: crypto.randomUUID(),
        type: 'countdown_timer',
        title: 'Thời hạn hiệu lực của chương trình',
        countdownIso: new Date(Date.now() + 72 * 3600_000).toISOString(),
        accentColor,
      });
    }

    generatedBlocks.push(
      {
        id: crypto.randomUUID(),
        type: 'button',
        buttonLabel: tone === 'urgent' ? 'Nhận Ưu Đãi Ngay Hôm Nay' : 'Kích hoạt Quyền lợi Ngay',
        url: ctaUrl,
        align: 'center',
        accentColor,
      },
      {
        id: crypto.randomUUID(),
        type: 'social_links',
        socialLinks: [
          { network: 'Website', url: ctaUrl },
          { network: 'Zalo OA', url: ctaUrl },
          { network: 'Facebook', url: ctaUrl },
        ],
      }
    );

    // Rich Gmail-Safe Frontend Visual Editor Block Tree (100% compatible with EmailEditor compileHTML)
    const editorBlocks: Array<Record<string, unknown>> = [];
    if (tenantInfo.brandLogoUrl) {
      editorBlocks.push({
        id: crypto.randomUUID(),
        type: 'section',
        content: '',
        style: { backgroundColor: '#ffffff', paddingTop: '20px', paddingBottom: '12px', paddingLeft: '24px', paddingRight: '24px', textAlign: 'center' },
        children: [
          {
            id: crypto.randomUUID(),
            type: 'image',
            content: '',
            url: tenantInfo.brandLogoUrl,
            altText: tenantInfo.name,
            style: { width: '140px', maxWidth: '160px', textAlign: 'center', borderRadius: '8px' },
          },
        ],
      });
    }

    if (heroImageUrl) {
      editorBlocks.push({
        id: crypto.randomUUID(),
        type: 'section',
        content: '',
        style: { backgroundColor: '#ffffff', paddingTop: '0px', paddingBottom: '0px', paddingLeft: '0px', paddingRight: '0px' },
        children: [
          {
            id: crypto.randomUUID(),
            type: 'image',
            content: '',
            url: heroImageUrl,
            altText: `${tenantInfo.name} Banner`,
            style: { width: '100%', borderRadius: '0px' },
          },
        ],
      });
    }

    editorBlocks.push(
      {
        id: crypto.randomUUID(),
        type: 'section',
        content: '',
        style: { backgroundColor: accentColor, paddingTop: '34px', paddingBottom: '34px', paddingLeft: '28px', paddingRight: '28px', textAlign: 'center' },
        children: [
          {
            id: crypto.randomUUID(),
            type: 'text',
            content: `<div style="font-size:11px;font-weight:800;letter-spacing:1.4px;text-transform:uppercase;color:rgba(255,255,255,0.85);margin-bottom:10px;">${toneBadge}</div><h1 style="margin:0 0 12px 0;font-size:26px;line-height:1.25;font-weight:800;color:#ffffff;">${goal}</h1><p style="margin:0;font-size:15px;line-height:1.6;color:rgba(255,255,255,0.92);">${tenantInfo.name} — Giải pháp tối ưu cá nhân hóa cho {{lead.name}}</p>`,
            style: { color: '#ffffff', textAlign: 'center', paddingTop: '0px', paddingBottom: '16px' },
          },
          {
            id: crypto.randomUUID(),
            type: 'button',
            content: tone === 'luxury' ? 'Xác nhận Đặc quyền VIP' : 'Khám phá Chi tiết Ngay',
            url: ctaUrl,
            style: { backgroundColor: '#ffffff', color: accentColor, fontWeight: '700', fontSize: '14px', borderRadius: '10px', paddingTop: '12px', paddingBottom: '12px', paddingLeft: '26px', paddingRight: '26px', textAlign: 'center' },
          },
        ],
      },
      {
        id: crypto.randomUUID(),
        type: 'section',
        content: '',
        style: { backgroundColor: '#ffffff', paddingTop: '28px', paddingBottom: '20px', paddingLeft: '28px', paddingRight: '28px' },
        children: [
          {
            id: crypto.randomUUID(),
            type: 'text',
            content: `<p style="margin:0 0 12px 0;font-size:15px;font-weight:700;color:#0f172a;">${greeting}</p><p style="margin:0;font-size:14px;line-height:1.7;color:#334155;">Đội ngũ <strong>${tenantInfo.name}</strong> trân trọng gửi tới bạn bộ thông tin nổi bật dành riêng cho chương trình <strong>${goal}</strong>. Mọi hạng mục đã được tinh gọn để giúp bạn dễ dàng nắm bắt quyền lợi và triển khai hiệu quả ngay hôm nay.</p>`,
            style: { color: '#334155', fontSize: '14px', lineHeight: '1.7', textAlign: 'left' },
          },
        ],
      },
      {
        id: crypto.randomUUID(),
        type: 'section',
        content: '',
        style: { backgroundColor: '#F8FAFC', paddingTop: '22px', paddingBottom: '22px', paddingLeft: '28px', paddingRight: '28px' },
        children: [
          {
            id: crypto.randomUUID(),
            type: 'check_list',
            content: '',
            checkListTitle: '3 Giá trị Nổi bật Dành Riêng Cho Bạn',
            items: [
              { id: crypto.randomUUID(), title: featurePair[0].heading, description: featurePair[0].body },
              { id: crypto.randomUUID(), title: featurePair[1].heading, description: featurePair[1].body },
              { id: crypto.randomUUID(), title: 'Cam kết Đồng hành Trực tiếp', description: 'Tư vấn chuyên sâu theo đúng nhu cầu {{lead.product_interest}} và hỗ trợ nhanh trong 15 phút.' },
            ],
            style: { color: '#0f172a', accentColor },
          },
        ],
      },
      {
        id: crypto.randomUUID(),
        type: 'section',
        content: '',
        style: { backgroundColor: '#ffffff', paddingTop: '20px', paddingBottom: '20px', paddingLeft: '28px', paddingRight: '28px' },
        children: [
          {
            id: crypto.randomUUID(),
            type: 'review',
            content: `"Đội ngũ ${tenantInfo.name} làm việc rất chuyên nghiệp, lộ trình rõ ràng và giúp chúng tôi thấy hiệu quả thực tế ngay trong tháng đầu tiên."`,
            rating: 5,
            altText: `Khách hàng tiêu biểu của ${tenantInfo.name}`,
            style: { backgroundColor: '#F8FAFC', borderRadius: '12px', paddingTop: '16px', paddingBottom: '16px', paddingLeft: '18px', paddingRight: '18px', color: '#0f172a' },
          },
        ],
      }
    );

    if (includeVoucher || includeBlocksRaw.includes('voucher')) {
      editorBlocks.push({
        id: crypto.randomUUID(),
        type: 'section',
        content: '',
        style: { backgroundColor: '#ffffff', paddingTop: '8px', paddingBottom: '20px', paddingLeft: '28px', paddingRight: '28px' },
        children: [
          {
            id: crypto.randomUUID(),
            type: 'voucher',
            content: '{{lead.voucher_code}}',
            altText: 'Mã ưu đãi đặc quyền — Áp dụng khi xác nhận đăng ký',
            style: { backgroundColor: '#EFF6FF', color: accentColor, borderColor: accentColor, borderRadius: '12px', textAlign: 'center', paddingTop: '18px', paddingBottom: '18px' },
          },
        ],
      });
    }

    if (includeCountdown || includeBlocksRaw.includes('countdown')) {
      editorBlocks.push({
        id: crypto.randomUUID(),
        type: 'section',
        content: '',
        style: { backgroundColor: '#ffffff', paddingTop: '4px', paddingBottom: '16px', paddingLeft: '28px', paddingRight: '28px', textAlign: 'center' },
        children: [
          {
            id: crypto.randomUUID(),
            type: 'countdown',
            content: new Date(Date.now() + 72 * 3600_000).toISOString(),
            style: { backgroundColor: '#0f172a', color: '#ffffff', borderRadius: '10px', textAlign: 'center', paddingTop: '14px', paddingBottom: '14px' },
          },
        ],
      });
    }

    editorBlocks.push({
      id: crypto.randomUUID(),
      type: 'section',
      content: '',
      style: { backgroundColor: '#0F172A', paddingTop: '24px', paddingBottom: '24px', paddingLeft: '28px', paddingRight: '28px', textAlign: 'center' },
      children: [
        {
          id: crypto.randomUUID(),
          type: 'text',
          content: `<p style="margin:0 0 8px 0;font-size:13px;font-weight:700;color:#f8fafc;">${tenantInfo.name}</p><p style="margin:0 0 10px 0;font-size:12px;color:#94a3b8;">${tenantInfo.footerText}</p><p style="margin:0;font-size:11px;color:#64748b;">Nếu không muốn tiếp tục nhận tin, bạn có thể <a href="{{unsubscribe_url}}" style="color:#93c5fd;text-decoration:underline;">Hủy đăng ký tại đây</a>.</p>`,
          style: { color: '#94a3b8', fontSize: '12px', textAlign: 'center' },
        },
      ],
    });

    const subject = `[${tenantInfo.name}] ${goal} dành cho {{lead.name}}`;
    const preheader = `Khám phá giải pháp tối ưu từ ${tenantInfo.name} và nhận quyền lợi dành riêng cho bạn.`;
    const compiledHtml = compileEmailBlocksToHtml(generatedBlocks, { primaryColor: accentColor }, subject);
    const spamAnalysis = analyzeEmailSpamScore(subject, generatedBlocks, compiledHtml);

    res.json({
      success: true,
      data: {
        generator: 'DOM Agent Email Studio',
        subject,
        preheader,
        brand_color: accentColor,
        blocks: generatedBlocks,
        editor_blocks: editorBlocks,
        compiled_html: compiledHtml,
        spam_analysis: spamAnalysis,
        ...(heroBannerAsset ? { hero_banner_asset: heroBannerAsset } : {}),
      },
    });
  } catch (err: any) {
    sendApiError(res, 500, 'DOM_AGENT_EMAIL_STUDIO_FAILED', err?.message || 'DOM Agent không thể sinh mẫu Email.');
  }
});

// Create Template
templatesRouter.post('/', requirePermission('mkt_templates', 'create'), async (req, res) => {
  try {
    const ctx = getTenantContext();
    const name = String(req.body?.name || '').trim();
    if (!name) {
      sendApiError(res, 422, 'TEMPLATE_NAME_REQUIRED', 'Vui lòng nhập tên mẫu Email.');
      return;
    }

    const subject = String(req.body?.subject || name).trim();
    const preheader = String(req.body?.preheader || '').trim();
    const category = String(req.body?.category || 'general').trim();
    const rawGroupCreate = req.body?.group_id ?? req.body?.groupId;
    const groupId = rawGroupCreate ? String(rawGroupCreate) : null;
    const visibility = String(req.body?.visibility || 'company');
    const status = String(req.body?.status || 'active');
    const blocks: EmailBlockDto[] = Array.isArray(req.body?.blocks) ? req.body.blocks : [];
    const rawStyleCreate = req.body?.body_style ?? req.body?.bodyStyle;
    const bodyStyle: EmailBodyStyleDto =
      rawStyleCreate && typeof rawStyleCreate === 'object' ? rawStyleCreate : {};

    const rawHtmlCreate = req.body?.compiled_html ?? req.body?.htmlContent;
    const compiledHtml =
      typeof rawHtmlCreate === 'string' && rawHtmlCreate.trim()
        ? rawHtmlCreate
        : compileEmailBlocksToHtml(blocks, bodyStyle, subject || name);
    const spam = analyzeEmailSpamScore(subject, blocks, compiledHtml);

    const detectedTags = Array.from(
      new Set(
        (String(compiledHtml).match(/\{\{\s*[a-zA-Z0-9_.-]+\s*\}\}/g) || []).map((t: string) =>
          t.replace(/\s+/g, '')
        )
      )
    );

    const rawThumbCreate = req.body?.thumbnail_url ?? req.body?.thumbnailUrl ?? req.body?.thumbnail;
    const thumbnailUrl = rawThumbCreate ? String(rawThumbCreate).trim() || null : null;

    const id = crypto.randomUUID();
    const saved = await withTenantTransaction(ctx.tenantId, async (client) => {
      await client.query(
        `INSERT INTO mkt_email_templates (
           id, tenant_id, group_id, name, subject, preheader, category,
           blocks_json, body_style, compiled_html, thumbnail_url, spam_score, merge_tags, visibility, status, created_by
         ) VALUES (
           $1, $2, $3, $4, $5, $6, $7,
           $8::jsonb, $9::jsonb, $10, $11, $12, $13::jsonb, $14, $15, $16
         )`,
        [
          id,
          ctx.tenantId,
          groupId,
          name,
          subject,
          preheader,
          category,
          JSON.stringify(blocks),
          JSON.stringify(bodyStyle),
          compiledHtml,
          thumbnailUrl,
          spam.score,
          JSON.stringify(detectedTags),
          visibility,
          status,
          ctx.userId,
        ]
      );
      const r = await client.query('SELECT * FROM mkt_email_templates WHERE tenant_id = $1 AND id = $2', [
        ctx.tenantId,
        id,
      ]);
      return mapTemplateRow(r.rows[0]);
    });

    res.status(201).json({ success: true, data: { ...saved, spam_analysis: spam } });
  } catch (err: any) {
    sendApiError(res, 500, 'CREATE_TEMPLATE_FAILED', err?.message || 'Không thể lưu mẫu Email.');
  }
});

// Get Single Template
templatesRouter.get('/:id', requirePermission('mkt_templates', 'view'), async (req, res) => {
  try {
    const ctx = getTenantContext();
    const row = await withTenantTransaction(ctx.tenantId, async (client) => {
      const r = await client.query('SELECT * FROM mkt_email_templates WHERE tenant_id = $1 AND id = $2 LIMIT 1', [
        ctx.tenantId,
        req.params.id,
      ]);
      return r.rows[0] || null;
    });
    if (!row) {
      sendApiError(res, 404, 'TEMPLATE_NOT_FOUND', 'Không tìm thấy mẫu Email trong doanh nghiệp.');
      return;
    }
    res.json({ success: true, data: mapTemplateRow(row) });
  } catch (err: any) {
    sendApiError(res, 500, 'GET_TEMPLATE_FAILED', err?.message || 'Không thể tải chi tiết mẫu Email.');
  }
});

// Update Template
templatesRouter.put('/:id', requirePermission('mkt_templates', 'edit'), async (req, res) => {
  try {
    const ctx = getTenantContext();
    const updated = await withTenantTransaction(ctx.tenantId, async (client) => {
      const existingRes = await client.query(
        'SELECT * FROM mkt_email_templates WHERE tenant_id = $1 AND id = $2 LIMIT 1',
        [ctx.tenantId, req.params.id]
      );
      const existing = existingRes.rows[0];
      if (!existing) return null;

      const name = req.body?.name !== undefined ? String(req.body.name).trim() : String(existing.name);
      const subject = req.body?.subject !== undefined ? String(req.body.subject).trim() : String(existing.subject);
      const preheader =
        req.body?.preheader !== undefined ? String(req.body.preheader).trim() : String(existing.preheader || '');
      const category =
        req.body?.category !== undefined ? String(req.body.category).trim() : String(existing.category || 'general');
      const rawGroupUpdate = req.body?.group_id !== undefined ? req.body.group_id : req.body?.groupId;
      const groupId =
        rawGroupUpdate !== undefined ? (rawGroupUpdate ? String(rawGroupUpdate) : null) : existing.group_id;
      const blocks: EmailBlockDto[] = Array.isArray(req.body?.blocks)
        ? req.body.blocks
        : parseJsonCol<EmailBlockDto[]>(existing.blocks_json, []);
      const rawStyleUpdate = req.body?.body_style ?? req.body?.bodyStyle;
      const bodyStyle: EmailBodyStyleDto =
        rawStyleUpdate && typeof rawStyleUpdate === 'object'
          ? rawStyleUpdate
          : parseJsonCol<EmailBodyStyleDto>(existing.body_style, {});

      const rawHtmlUpdate = req.body?.compiled_html ?? req.body?.htmlContent;
      const compiledHtml =
        typeof rawHtmlUpdate === 'string' && rawHtmlUpdate.trim()
          ? rawHtmlUpdate
          : compileEmailBlocksToHtml(blocks, bodyStyle, subject || name);
      const spam = analyzeEmailSpamScore(subject, blocks, compiledHtml);
      const detectedTags = Array.from(
        new Set(
          (String(compiledHtml).match(/\{\{\s*[a-zA-Z0-9_.-]+\s*\}\}/g) || []).map((t: string) =>
            t.replace(/\s+/g, '')
          )
        )
      );

      const status =
        req.body?.status !== undefined ? String(req.body.status).trim() : String(existing.status || 'active');
      const visibility =
        req.body?.visibility !== undefined ? String(req.body.visibility).trim() : String(existing.visibility || 'company');
      const rawSavedBlocks = req.body?.saved_blocks ?? req.body?.savedBlocks ?? req.body?.saved_blocks_json;
      const savedBlocks = Array.isArray(rawSavedBlocks)
        ? rawSavedBlocks
        : parseJsonCol<EmailBlockDto[]>(existing.saved_blocks_json, []);
      const rawThumb = req.body?.thumbnail_url !== undefined ? req.body.thumbnail_url : req.body?.thumbnailUrl;
      const thumbnailUrl =
        rawThumb !== undefined ? (rawThumb ? String(rawThumb) : null) : existing.thumbnail_url;

      await client.query(
        `UPDATE mkt_email_templates
         SET name = $3,
             subject = $4,
             preheader = $5,
             category = $6,
             group_id = $7,
             blocks_json = $8::jsonb,
             body_style = $9::jsonb,
             compiled_html = $10,
             spam_score = $11,
             merge_tags = $12::jsonb,
             status = $13,
             visibility = $14,
             saved_blocks_json = $15::jsonb,
             thumbnail_url = $16,
             updated_at = clock_timestamp()
         WHERE tenant_id = $1 AND id = $2`,
        [
          ctx.tenantId,
          req.params.id,
          name,
          subject,
          preheader,
          category,
          groupId,
          JSON.stringify(blocks),
          JSON.stringify(bodyStyle),
          compiledHtml,
          spam.score,
          JSON.stringify(detectedTags),
          status,
          visibility,
          JSON.stringify(savedBlocks),
          thumbnailUrl,
        ]
      );

      const r = await client.query('SELECT * FROM mkt_email_templates WHERE tenant_id = $1 AND id = $2', [
        ctx.tenantId,
        req.params.id,
      ]);
      return { ...mapTemplateRow(r.rows[0]), spam_analysis: spam };
    });

    if (!updated) {
      sendApiError(res, 404, 'TEMPLATE_NOT_FOUND', 'Không tìm thấy mẫu Email cần cập nhật.');
      return;
    }

    res.json({ success: true, data: updated });
  } catch (err: any) {
    sendApiError(res, 500, 'UPDATE_TEMPLATE_FAILED', err?.message || 'Không thể cập nhật mẫu Email.');
  }
});

// Delete Template
templatesRouter.delete('/:id', requirePermission('mkt_templates', 'delete'), async (req, res) => {
  try {
    const ctx = getTenantContext();
    const count = await withTenantTransaction(ctx.tenantId, async (client) => {
      const r = await client.query('DELETE FROM mkt_email_templates WHERE tenant_id = $1 AND id = $2', [
        ctx.tenantId,
        req.params.id,
      ]);
      return r.rowCount;
    });
    if (!count) {
      sendApiError(res, 404, 'TEMPLATE_NOT_FOUND', 'Không tìm thấy mẫu Email cần xóa.');
      return;
    }
    res.json({ success: true, data: { deleted: true } });
  } catch (err: any) {
    sendApiError(res, 500, 'DELETE_TEMPLATE_FAILED', err?.message || 'Không thể xóa mẫu Email.');
  }
});

// Test Render / Preview Merge Tags via Tenant Vault
templatesRouter.post('/:id/test-send', requirePermission('mkt_templates', 'view'), async (req, res) => {
  try {
    const ctx = getTenantContext();
    const toEmail = String(req.body?.to_email || ctx.userEmail || '').trim();
    if (!toEmail || !toEmail.includes('@')) {
      sendApiError(res, 422, 'INVALID_TEST_EMAIL', 'Vui lòng nhập địa chỉ Email nhận bản gửi thử hợp lệ.');
      return;
    }

    const result = await withTenantTransaction(ctx.tenantId, async (client) => {
      const tplRes = await client.query(
        'SELECT * FROM mkt_email_templates WHERE tenant_id = $1 AND id = $2 LIMIT 1',
        [ctx.tenantId, req.params.id]
      );
      const tpl = tplRes.rows[0];
      if (!tpl) return null;

      const [tenantRes, vault] = await Promise.all([
        client.query<{ name: string; settings: Record<string, unknown> }>(
          'SELECT name, settings FROM tenants WHERE id = $1 LIMIT 1',
          [ctx.tenantId]
        ),
        readTenantChannelVault(client, ctx.tenantId, ['aws_ses', 'smtp']),
      ]);

      const tSettings = (tenantRes.rows[0]?.settings || {}) as Record<string, unknown>;
      const hasAppscript = Boolean(String(tSettings.appscript_webhook_url || '').trim());
      const hasResend = Boolean(String(tSettings.resend_api_key || '').trim());
      const emailConfigured = vault.configured || hasAppscript || hasResend;
      const emailProvider =
        vault.integrationType || (hasAppscript ? 'appscript' : hasResend ? 'resend' : null);

      const sampleCtx = {
        lead: {
          name: String(req.body?.sample_name || ctx.userName || 'Khách hàng Doanh nghiệp'),
          phone: '0909888999',
          email: toEmail,
          product_interest: 'Growth Suite',
          voucher_code: 'DOM-TEST20',
          custom_fields: {},
        },
        tenant: {
          name: tenantRes.rows[0]?.name || 'DOMATION',
        },
        unsubscribe_url: '#unsubscribe-preview',
      };

      const renderedSubject = renderMergeTags(String(tpl.subject || tpl.name), sampleCtx);
      const renderedHtml = renderMergeTags(String(tpl.compiled_html || ''), sampleCtx);

      let delivery: { sent: boolean; queued?: boolean; message_id: string; provider: string; error?: string } | null = null;
      if (req.body?.send_live !== false) {
        const mailRes = await dispatchMarketingEmail({
          tenantId: ctx.tenantId,
          client,
          to: toEmail,
          subject: renderedSubject,
          text: stripHtmlTagsForPlainText(renderedHtml) || renderedSubject,
          html: renderedHtml || `<div>${renderedSubject}</div>`,
          category: 'system_alert',
          meta: { test_send: true, template_id: tpl.id },
          emailVaultConfigured: emailConfigured,
          emailVaultType: emailProvider,
        });
        delivery = {
          sent: mailRes.sent,
          queued: mailRes.queued,
          message_id: mailRes.messageId,
          provider: mailRes.provider,
          ...(mailRes.error ? { error: mailRes.error } : {}),
        };
      }

      return {
        to_email: toEmail,
        vault_configured: emailConfigured,
        provider: delivery?.provider || emailProvider || 'vault_sandbox_preview',
        rendered_subject: renderedSubject,
        rendered_html: renderedHtml,
        ...(delivery ? { delivery } : {}),
      };
    });

    if (!result) {
      sendApiError(res, 404, 'TEMPLATE_NOT_FOUND', 'Không tìm thấy mẫu Email.');
      return;
    }

    res.json({ success: true, data: result });
  } catch (err: any) {
    sendApiError(res, 500, 'TEST_SEND_FAILED', err?.message || 'Không thể gửi thử mẫu Email.');
  }
});

// TemplateAccessModal: Team / Department / Role / User ACL Sharing
templatesRouter.get('/:id/acl', requirePermission('mkt_templates', 'view'), async (req, res) => {
  try {
    const ctx = getTenantContext();
    const data = await withTenantTransaction(ctx.tenantId, async (client) => {
      const tplRes = await client.query(
        'SELECT id, name, visibility FROM mkt_email_templates WHERE tenant_id = $1 AND id = $2 LIMIT 1',
        [ctx.tenantId, req.params.id]
      );
      if (!tplRes.rows[0]) return null;

      const [aclRes, rolesRes, deptsRes, teamsRes, usersRes] = await Promise.all([
        client.query(
          'SELECT * FROM mkt_template_acl WHERE tenant_id = $1 AND template_id = $2 ORDER BY created_at ASC',
          [ctx.tenantId, req.params.id]
        ),
        client.query('SELECT id, name, role_key, role_key AS code FROM tenant_roles WHERE tenant_id = $1 ORDER BY name ASC', [ctx.tenantId]),
        client.query('SELECT id, name FROM tenant_departments WHERE tenant_id = $1 ORDER BY name ASC', [ctx.tenantId]),
        client.query('SELECT id, name FROM tenant_teams WHERE tenant_id = $1 ORDER BY name ASC', [ctx.tenantId]),
        client.query('SELECT id, full_name, email FROM users WHERE tenant_id = $1 AND COALESCE(is_system_bot, false) = false ORDER BY full_name ASC LIMIT 100', [ctx.tenantId]),
      ]);

      return {
        template: tplRes.rows[0],
        acl_entries: aclRes.rows,
        available_targets: {
          roles: rolesRes.rows,
          departments: deptsRes.rows,
          teams: teamsRes.rows,
          users: usersRes.rows,
        },
      };
    });

    if (!data) {
      sendApiError(res, 404, 'TEMPLATE_NOT_FOUND', 'Không tìm thấy mẫu Email.');
      return;
    }
    res.json({ success: true, data });
  } catch (err: any) {
    sendApiError(res, 500, 'GET_TEMPLATE_ACL_FAILED', err?.message || 'Không thể tải cấu hình phân quyền mẫu Email.');
  }
});

templatesRouter.put('/:id/acl', requirePermission('mkt_templates', 'edit'), async (req, res) => {
  try {
    const ctx = getTenantContext();
    const visibility = ['private', 'team', 'department', 'company'].includes(String(req.body?.visibility || ''))
      ? String(req.body.visibility)
      : 'company';
    const entries: Array<{
      scope_type?: string;
      scope_target_id?: string;
      scope_label?: string;
      permission_level?: string;
    }> = Array.isArray(req.body?.entries) ? req.body.entries : [];

    const out = await withTenantTransaction(ctx.tenantId, async (client) => {
      const ex = await client.query(
        'SELECT id FROM mkt_email_templates WHERE tenant_id = $1 AND id = $2 LIMIT 1',
        [ctx.tenantId, req.params.id]
      );
      if (!ex.rows[0]) return null;

      await client.query(
        'UPDATE mkt_email_templates SET visibility = $3, updated_at = clock_timestamp() WHERE tenant_id = $1 AND id = $2',
        [ctx.tenantId, req.params.id, visibility]
      );
      await client.query(
        'DELETE FROM mkt_template_acl WHERE tenant_id = $1 AND template_id = $2',
        [ctx.tenantId, req.params.id]
      );

      for (const item of entries) {
        const scopeType = ['user', 'department', 'role', 'team'].includes(String(item.scope_type || ''))
          ? String(item.scope_type)
          : 'role';
        const targetId = String(item.scope_target_id || '').trim();
        if (!targetId) continue;
        const permLevel = ['view', 'edit', 'manage'].includes(String(item.permission_level || ''))
          ? String(item.permission_level)
          : 'view';
        await client.query(
          `INSERT INTO mkt_template_acl (
             id, tenant_id, template_id, scope_type, scope_target_id, scope_label, permission_level
           ) VALUES ($1, $2, $3, $4, $5, $6, $7)
           ON CONFLICT (tenant_id, template_id, scope_type, scope_target_id)
           DO UPDATE SET permission_level = EXCLUDED.permission_level, scope_label = EXCLUDED.scope_label`,
          [
            crypto.randomUUID(),
            ctx.tenantId,
            req.params.id,
            scopeType,
            targetId,
            item.scope_label ? String(item.scope_label) : null,
            permLevel,
          ]
        );
      }

      const aclRes = await client.query(
        'SELECT * FROM mkt_template_acl WHERE tenant_id = $1 AND template_id = $2 ORDER BY created_at ASC',
        [ctx.tenantId, req.params.id]
      );
      return { visibility, acl_entries: aclRes.rows };
    });

    if (!out) {
      sendApiError(res, 404, 'TEMPLATE_NOT_FOUND', 'Không tìm thấy mẫu Email.');
      return;
    }
    res.json({ success: true, data: out });
  } catch (err: any) {
    sendApiError(res, 500, 'UPDATE_TEMPLATE_ACL_FAILED', err?.message || 'Không thể lưu phân quyền mẫu Email.');
  }
});
