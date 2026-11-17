import crypto from 'node:crypto';
import { Router } from 'express';
import { withTenantTransaction } from '../../core/database/transaction.ts';
import { getTenantContext } from '../../core/context/tenant-context.ts';
import {
  requireEntitlement,
  requirePermission,
  sendApiError,
} from '../../core/security/rbac.ts';
import {
  analyzeEmailSpamScore,
  buildCountdownTimerSvg,
  compileEmailBlocksToHtml,
  parseJsonCol,
  readTenantChannelVault,
  renderMergeTags,
  type EmailBlockDto,
  type EmailBodyStyleDto,
} from './utils.ts';

export const templatesRouter = Router();

templatesRouter.use(requireEntitlement('mkt_templates'));

function mapTemplateRow(row: Record<string, unknown>) {
  return {
    id: String(row.id),
    tenant_id: String(row.tenant_id),
    group_id: row.group_id ? String(row.group_id) : null,
    group_name: row.group_name ? String(row.group_name) : null,
    name: String(row.name || ''),
    subject: String(row.subject || ''),
    preheader: String(row.preheader || ''),
    category: String(row.category || 'general'),
    blocks: parseJsonCol<EmailBlockDto[]>(row.blocks_json, []),
    saved_blocks: parseJsonCol<EmailBlockDto[]>(row.saved_blocks_json, []),
    body_style: parseJsonCol<EmailBodyStyleDto>(row.body_style, {}),
    compiled_html: String(row.compiled_html || ''),
    thumbnail_url: row.thumbnail_url ? String(row.thumbnail_url) : null,
    spam_score: Number(row.spam_score || 0),
    merge_tags: parseJsonCol<string[]>(row.merge_tags, []),
    visibility: String(row.visibility || 'company'),
    status: String(row.status || 'active'),
    created_by: row.created_by ? String(row.created_by) : null,
    created_at: row.created_at,
    updated_at: row.updated_at,
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

// List Templates + Groups + Dynamic Tenant Merge Tags
templatesRouter.get('/', requirePermission('mkt_templates', 'view'), async (_req, res) => {
  try {
    const ctx = getTenantContext();
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
        client.query<{ name: string; slug: string }>(
          'SELECT name, slug FROM tenants WHERE id = $1 LIMIT 1',
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

      return {
        items: tplRes.rows.map(mapTemplateRow),
        groups: grpRes.rows,
        merge_tags: mergeTags,
        sender_vault: {
          configured: sesVault.configured,
          provider: sesVault.integrationType,
          from_email: String(sesVault.config.from_email || sesVault.config.fromEmail || ''),
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
    const bodyStyle: EmailBodyStyleDto = req.body?.body_style && typeof req.body.body_style === 'object' ? req.body.body_style : {};
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
    const bodyStyle: EmailBodyStyleDto =
      req.body?.body_style && typeof req.body.body_style === 'object' ? req.body.body_style : {};
    const subject = String(req.body?.subject || '');
    const compiledHtml =
      typeof req.body?.compiled_html === 'string' && req.body.compiled_html.trim()
        ? req.body.compiled_html
        : compileEmailBlocksToHtml(blocks, bodyStyle, subject || 'DOMATION Email');

    const spam = analyzeEmailSpamScore(subject, blocks, compiledHtml);
    const vaultInfo = await withTenantTransaction(ctx.tenantId, async (client) => {
      const vault = await readTenantChannelVault(client, ctx.tenantId, ['aws_ses', 'smtp']);
      return {
        configured: vault.configured,
        provider: vault.integrationType,
        spf_verified: Boolean(vault.config.spf_verified ?? vault.configured),
        dkim_verified: Boolean(vault.config.dkim_verified ?? vault.configured),
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
        readTenantChannelVault(client, ctx.tenantId, ['aws_ses', 'smtp']),
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
          if (!html) html = String(tpl.compiled_html || '');
        }
      }
      if (!html && Array.isArray(req.body?.blocks)) {
        html = compileEmailBlocksToHtml(req.body.blocks, req.body?.body_style || {}, subject || 'DOMATION Email');
      }

      const dispatched: Array<{ email: string; lead_id: string | null; subject: string }> = [];
      for (const email of rawRecipients.slice(0, 50)) {
        const lRes = await client.query(
          'SELECT id, name, phone, email, product_interest, custom_fields FROM leads WHERE tenant_id = $1 AND LOWER(email) = $2 AND is_deleted = false LIMIT 1',
          [ctx.tenantId, email]
        );
        const lead = lRes.rows[0];
        const renderedSubject = renderMergeTags(
          subject || 'Thông báo từ {{tenant.name}}',
          {
            lead: lead
              ? { ...lead, custom_fields: parseJsonCol(lead.custom_fields, {}) }
              : { email, name: fallbackVars['lead.name'] || 'Quý khách' },
            tenant: { name: tenantName },
            unsubscribe_url: '#unsubscribe',
          },
          fallbackVars
        );

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
              `Kênh gửi: ${vault.integrationType || 'vault_sandbox'}`,
              JSON.stringify({ quick_send: true, email }),
            ]
          );
        }
        dispatched.push({ email, lead_id: lead?.id ? String(lead.id) : null, subject: renderedSubject });
      }

      return {
        sent_count: dispatched.length,
        provider: vault.integrationType || 'vault_sandbox_queue',
        vault_configured: vault.configured,
        dispatched,
      };
    });

    res.json({ success: true, data: outcome });
  } catch (err: any) {
    sendApiError(res, 500, 'QUICK_SEND_FAILED', err?.message || 'Không thể gửi nhanh Email.');
  }
});

// DOM Agent Email Studio (AI Copy & Multi-Block Layout Generator)
templatesRouter.post('/ai-generate', requirePermission('mkt_templates', 'create'), async (req, res) => {
  try {
    const ctx = getTenantContext();
    const goal = String(req.body?.goal || req.body?.prompt || 'Chào mừng khách hàng mới & gửi ưu đãi').trim();
    const tone = String(req.body?.tone || 'professional').trim();
    const ctaUrl = String(req.body?.cta_url || 'https://domation.net').trim();
    const includeVoucher = Boolean(req.body?.include_voucher ?? true);
    const includeCountdown = Boolean(req.body?.include_countdown ?? true);

    const tenantInfo = await withTenantTransaction(ctx.tenantId, async (client) => {
      const r = await client.query<{ name: string; industry: string }>(
        'SELECT name, industry FROM tenants WHERE id = $1 LIMIT 1',
        [ctx.tenantId]
      );
      return r.rows[0] || { name: 'Doanh nghiệp của bạn', industry: 'general' };
    });

    const greeting =
      tone === 'friendly'
        ? 'Chào bạn {{lead.name}},'
        : tone === 'urgent'
          ? 'Thông báo đặc quyền dành riêng cho {{lead.name}},'
          : 'Kính gửi {{lead.name}},';

    const generatedBlocks: EmailBlockDto[] = [
      {
        id: crypto.randomUUID(),
        type: 'hero_banner',
        title: `${tenantInfo.name} — ${goal}`,
        content: `Giải pháp được cá nhân hóa dành riêng cho nhu cầu {{lead.product_interest}} của Quý khách.`,
        buttonLabel: 'Xem chi tiết ưu đãi',
        url: ctaUrl,
        align: 'center',
        accentColor: '#1E40FF',
      },
      {
        id: crypto.randomUUID(),
        type: 'text',
        title: 'Điểm nhấn giá trị thực tiễn',
        content: `${greeting}\n\nĐội ngũ ${tenantInfo.name} trân trọng cảm ơn sự quan tâm của bạn đối với "${goal}". Chúng tôi đã chuẩn bị lộ trình triển khai tối ưu giúp tiết kiệm thời gian và gia tăng hiệu quả chuyển đổi rõ rệt.`,
        align: 'left',
      },
      {
        id: crypto.randomUUID(),
        type: 'columns',
        columns: [
          {
            heading: 'Triển khai Tức thì',
            body: 'Đồng bộ dữ liệu khách hàng 360° tự động, không mất thời gian nhập liệu thủ công.',
            ctaLabel: 'Tìm hiểu thêm',
            ctaUrl,
          },
          {
            heading: 'Bảo mật Đa tầng',
            body: 'Cô lập dữ liệu chuẩn doanh nghiệp kèm theo dõi hiệu suất chuyển đổi theo thời gian thực.',
            ctaLabel: 'Xem bảng giá',
            ctaUrl,
          },
        ],
      },
    ];

    if (includeVoucher) {
      generatedBlocks.push({
        id: crypto.randomUUID(),
        type: 'voucher_box',
        title: 'Mã Ưu Đãi Đặc Quyền Của Bạn',
        voucherCode: '{{lead.voucher_code}}',
        content: 'Nhập mã khi xác nhận đơn hàng để nhận chiết khấu trực tiếp.',
        accentColor: '#1E40FF',
      });
    }

    if (includeCountdown) {
      generatedBlocks.push({
        id: crypto.randomUUID(),
        type: 'countdown_timer',
        title: 'Thời hạn hiệu lực của ưu đãi',
        countdownIso: new Date(Date.now() + 72 * 3600_000).toISOString(),
        accentColor: '#1E40FF',
      });
    }

    generatedBlocks.push(
      {
        id: crypto.randomUUID(),
        type: 'button',
        buttonLabel: 'Kích hoạt quyền lợi ngay',
        url: ctaUrl,
        align: 'center',
        accentColor: '#1E40FF',
      },
      {
        id: crypto.randomUUID(),
        type: 'social_links',
        socialLinks: [
          { network: 'Website', url: ctaUrl },
          { network: 'Zalo OA', url: ctaUrl },
        ],
      }
    );

    const subject = `[${tenantInfo.name}] ${goal} dành cho {{lead.name}}`;
    const preheader = `Khám phá giải pháp tối ưu từ ${tenantInfo.name} và nhận quyền lợi dành riêng cho bạn.`;
    const compiledHtml = compileEmailBlocksToHtml(generatedBlocks, { primaryColor: '#1E40FF' }, subject);
    const spamAnalysis = analyzeEmailSpamScore(subject, generatedBlocks, compiledHtml);

    res.json({
      success: true,
      data: {
        generator: 'DOM Agent Email Studio',
        subject,
        preheader,
        blocks: generatedBlocks,
        compiled_html: compiledHtml,
        spam_analysis: spamAnalysis,
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
    const groupId = req.body?.group_id ? String(req.body.group_id) : null;
    const visibility = String(req.body?.visibility || 'company');
    const status = String(req.body?.status || 'active');
    const blocks: EmailBlockDto[] = Array.isArray(req.body?.blocks) ? req.body.blocks : [];
    const bodyStyle: EmailBodyStyleDto =
      req.body?.body_style && typeof req.body.body_style === 'object' ? req.body.body_style : {};

    const compiledHtml =
      typeof req.body?.compiled_html === 'string' && req.body.compiled_html.trim()
        ? req.body.compiled_html
        : compileEmailBlocksToHtml(blocks, bodyStyle, subject || name);
    const spam = analyzeEmailSpamScore(subject, blocks, compiledHtml);

    const detectedTags = Array.from(
      new Set(
        (String(compiledHtml).match(/\{\{\s*[a-zA-Z0-9_.-]+\s*\}\}/g) || []).map((t: string) =>
          t.replace(/\s+/g, '')
        )
      )
    );

    const id = crypto.randomUUID();
    const saved = await withTenantTransaction(ctx.tenantId, async (client) => {
      await client.query(
        `INSERT INTO mkt_email_templates (
           id, tenant_id, group_id, name, subject, preheader, category,
           blocks_json, body_style, compiled_html, spam_score, merge_tags, visibility, status, created_by
         ) VALUES (
           $1, $2, $3, $4, $5, $6, $7,
           $8::jsonb, $9::jsonb, $10, $11, $12::jsonb, $13, $14, $15
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
      const groupId =
        req.body?.group_id !== undefined ? (req.body.group_id ? String(req.body.group_id) : null) : existing.group_id;
      const blocks: EmailBlockDto[] = Array.isArray(req.body?.blocks)
        ? req.body.blocks
        : parseJsonCol<EmailBlockDto[]>(existing.blocks_json, []);
      const bodyStyle: EmailBodyStyleDto =
        req.body?.body_style && typeof req.body.body_style === 'object'
          ? req.body.body_style
          : parseJsonCol<EmailBodyStyleDto>(existing.body_style, {});

      const compiledHtml =
        typeof req.body?.compiled_html === 'string' && req.body.compiled_html.trim()
          ? req.body.compiled_html
          : compileEmailBlocksToHtml(blocks, bodyStyle, subject || name);
      const spam = analyzeEmailSpamScore(subject, blocks, compiledHtml);
      const detectedTags = Array.from(
        new Set(
          (String(compiledHtml).match(/\{\{\s*[a-zA-Z0-9_.-]+\s*\}\}/g) || []).map((t: string) =>
            t.replace(/\s+/g, '')
          )
        )
      );

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

      const tenantRes = await client.query<{ name: string }>('SELECT name FROM tenants WHERE id = $1 LIMIT 1', [
        ctx.tenantId,
      ]);
      const vault = await readTenantChannelVault(client, ctx.tenantId, ['aws_ses', 'smtp']);

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

      return {
        to_email: toEmail,
        vault_configured: vault.configured,
        provider: vault.integrationType || 'vault_sandbox_preview',
        rendered_subject: renderedSubject,
        rendered_html: renderedHtml,
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
        client.query('SELECT id, name, code FROM tenant_roles WHERE tenant_id = $1 ORDER BY name ASC', [ctx.tenantId]),
        client.query('SELECT id, name FROM tenant_departments WHERE tenant_id = $1 ORDER BY name ASC', [ctx.tenantId]),
        client.query('SELECT id, name FROM tenant_teams WHERE tenant_id = $1 ORDER BY name ASC', [ctx.tenantId]),
        client.query('SELECT id, full_name, email FROM users WHERE tenant_id = $1 AND is_active = true ORDER BY full_name ASC LIMIT 100', [ctx.tenantId]),
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
