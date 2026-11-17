import crypto from 'node:crypto';
import { Router } from 'express';
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
  canUserUnmaskMarketingPii,
  parseJsonCol,
  slugifyMarketingKey,
} from './utils.ts';

export const surveysRouter = Router();

surveysRouter.use(requireEntitlement('mkt_surveys'));

// Complete 25-Block Survey & Quiz Catalog
export const SURVEY_25_BLOCK_TYPES = [
  { type: 'short_text', group: 'Cơ bản', label: 'Văn bản ngắn (1 dòng)' },
  { type: 'long_text', group: 'Cơ bản', label: 'Văn bản dài (Đoạn văn)' },
  { type: 'email', group: 'Cơ bản', label: 'Địa chỉ Email' },
  { type: 'phone', group: 'Cơ bản', label: 'Số điện thoại' },
  { type: 'number', group: 'Cơ bản', label: 'Con số định lượng' },
  { type: 'date', group: 'Cơ bản', label: 'Ngày tháng' },
  { type: 'single_choice', group: 'Lựa chọn', label: 'Chọn 1 đáp án (Radio)' },
  { type: 'multi_choice', group: 'Lựa chọn', label: 'Chọn nhiều đáp án (Checkbox)' },
  { type: 'dropdown', group: 'Lựa chọn', label: 'Danh sách thả xuống (Dropdown)' },
  { type: 'yes_no', group: 'Lựa chọn', label: 'Có / Không' },
  { type: 'quiz_scored', group: 'Chấm điểm & Rẽ nhánh', label: 'Câu hỏi Trắc nghiệm tính điểm (Quiz)' },
  { type: 'branch_jump', group: 'Chấm điểm & Rẽ nhánh', label: 'Điều hướng Rẽ nhánh (Branch Jump)' },
  { type: 'nps', group: 'Đánh giá', label: 'Chỉ số NPS (0–10)' },
  { type: 'csat_stars', group: 'Đánh giá', label: 'Đánh giá CSAT Sao (1–5)' },
  { type: 'likert_matrix', group: 'Đánh giá', label: 'Ma trận Thang đo Likert' },
  { type: 'slider', group: 'Đánh giá', label: 'Thanh kéo Giá trị (Slider)' },
  { type: 'emoji_rating', group: 'Đánh giá', label: 'Biểu tượng Cảm xúc (Emoji)' },
  { type: 'ranking', group: 'Nâng cao', label: 'Xếp hạng Ưu tiên (Ranking)' },
  { type: 'matrix_multi', group: 'Nâng cao', label: 'Ma trận Đa lựa chọn' },
  { type: 'file_upload', group: 'Nâng cao', label: 'Tải tệp đính kèm' },
  { type: 'section_header', group: 'Bố cục', label: 'Tiêu đề Phân đoạn' },
  { type: 'image_block', group: 'Bố cục', label: 'Hình ảnh Minh họa' },
  { type: 'banner_block', group: 'Bố cục', label: 'Banner Thương hiệu' },
  { type: 'divider', group: 'Bố cục', label: 'Đường kẻ Phân cách' },
  { type: 'page_break', group: 'Bố cục', label: 'Ngắt Trang (Multi-Step)' },
] as const;

export interface SurveyBlockItemDto {
  id: string;
  type: string;
  label: string;
  description?: string;
  required?: boolean;
  options?: Array<{ id: string; label: string; value: string; points?: number; jumpToBlockId?: string }>;
  minValue?: number;
  maxValue?: number;
  points?: number;
  correctValue?: string;
  tagOnAnswer?: string;
}

function mapSurveyRow(row: Record<string, unknown>) {
  return {
    id: String(row.id),
    tenant_id: String(row.tenant_id),
    title: String(row.title || ''),
    slug: String(row.slug || ''),
    description: row.description ? String(row.description) : '',
    survey_type: String(row.survey_type || 'survey') as 'survey' | 'quiz' | 'nps',
    status: String(row.status || 'active'),
    blocks: parseJsonCol<SurveyBlockItemDto[]>(row.blocks_json, []),
    theme: parseJsonCol<Record<string, unknown>>(row.theme_json, {}),
    settings: parseJsonCol<Record<string, unknown>>(row.settings_json, {}),
    response_count: Number(row.response_count || 0),
    avg_score: Number(row.avg_score || 0),
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

// List Surveys + 25 Block Definitions
surveysRouter.get('/', requirePermission('mkt_surveys', 'view'), async (_req, res) => {
  try {
    const ctx = getTenantContext();
    const data = await withTenantTransaction(ctx.tenantId, async (client) => {
      const [srvRes, audRes, tagRes] = await Promise.all([
        client.query(
          `SELECT * FROM mkt_surveys
           WHERE tenant_id = $1
           ORDER BY created_at DESC`,
          [ctx.tenantId]
        ),
        client.query(
          `SELECT id, name, audience_type FROM tenant_audiences WHERE tenant_id = $1 AND is_active = true ORDER BY name ASC`,
          [ctx.tenantId]
        ),
        client.query(
          `SELECT id, name, slug, color_hex FROM tenant_tags WHERE tenant_id = $1 ORDER BY name ASC`,
          [ctx.tenantId]
        ),
      ]);

      return {
        items: srvRes.rows.map(mapSurveyRow),
        block_catalog: SURVEY_25_BLOCK_TYPES,
        audiences: audRes.rows,
        tags: tagRes.rows,
      };
    });

    res.json({ success: true, data });
  } catch (err: any) {
    sendApiError(res, 500, 'LIST_SURVEYS_FAILED', err?.message || 'Không thể tải danh sách Khảo sát & Quiz.');
  }
});

// Create Survey / Quiz
surveysRouter.post('/', requirePermission('mkt_surveys', 'create'), async (req, res) => {
  try {
    const ctx = getTenantContext();
    const title = String(req.body?.title || '').trim();
    if (!title) {
      sendApiError(res, 422, 'SURVEY_TITLE_REQUIRED', 'Vui lòng nhập tiêu đề Khảo sát / Bài Quiz.');
      return;
    }

    const baseSlug = slugifyMarketingKey(String(req.body?.slug || title), 'survey');
    const uniqueSlug = `${baseSlug}-${crypto.randomBytes(2).toString('hex')}`;
    const surveyType =
      req.body?.survey_type === 'quiz' ? 'quiz' : req.body?.survey_type === 'nps' ? 'nps' : 'survey';
    const description = req.body?.description ? String(req.body.description).trim() : null;
    const blocks: SurveyBlockItemDto[] = Array.isArray(req.body?.blocks) ? req.body.blocks : [];
    const theme =
      req.body?.theme && typeof req.body.theme === 'object'
        ? req.body.theme
        : { primaryColor: '#1E40FF', backgroundColor: '#F8F9FA', cardBackground: '#FFFFFF' };
    const settings =
      req.body?.settings && typeof req.body.settings === 'object'
        ? req.body.settings
        : { auto_tag: '', base_lead_score: 10, target_audience_id: null };

    const id = crypto.randomUUID();
    const created = await withTenantTransaction(ctx.tenantId, async (client) => {
      await client.query(
        `INSERT INTO mkt_surveys (
           id, tenant_id, title, slug, description, survey_type, status,
           blocks_json, theme_json, settings_json, created_by
         ) VALUES (
           $1, $2, $3, $4, $5, $6, 'active',
           $7::jsonb, $8::jsonb, $9::jsonb, $10
         )`,
        [
          id,
          ctx.tenantId,
          title,
          uniqueSlug,
          description,
          surveyType,
          JSON.stringify(blocks),
          JSON.stringify(theme),
          JSON.stringify(settings),
          ctx.userId,
        ]
      );
      const r = await client.query('SELECT * FROM mkt_surveys WHERE tenant_id = $1 AND id = $2', [ctx.tenantId, id]);
      return mapSurveyRow(r.rows[0]);
    });

    res.status(201).json({ success: true, data: created });
  } catch (err: any) {
    sendApiError(res, 500, 'CREATE_SURVEY_FAILED', err?.message || 'Không thể tạo Khảo sát / Quiz.');
  }
});

// Update Survey / Quiz
surveysRouter.put('/:id', requirePermission('mkt_surveys', 'edit'), async (req, res) => {
  try {
    const ctx = getTenantContext();
    const updated = await withTenantTransaction(ctx.tenantId, async (client) => {
      const exRes = await client.query('SELECT * FROM mkt_surveys WHERE tenant_id = $1 AND id = $2 LIMIT 1', [
        ctx.tenantId,
        req.params.id,
      ]);
      const ex = exRes.rows[0];
      if (!ex) return null;

      const title = req.body?.title !== undefined ? String(req.body.title).trim() : String(ex.title);
      const description =
        req.body?.description !== undefined ? String(req.body.description).trim() : ex.description;
      const surveyType =
        req.body?.survey_type !== undefined ? String(req.body.survey_type) : String(ex.survey_type);
      const status = req.body?.status !== undefined ? String(req.body.status) : String(ex.status);
      const blocks = Array.isArray(req.body?.blocks) ? req.body.blocks : parseJsonCol(ex.blocks_json, []);
      const theme =
        req.body?.theme && typeof req.body.theme === 'object'
          ? req.body.theme
          : parseJsonCol(ex.theme_json, {});
      const settings =
        req.body?.settings && typeof req.body.settings === 'object'
          ? req.body.settings
          : parseJsonCol(ex.settings_json, {});

      await client.query(
        `UPDATE mkt_surveys
         SET title = $3,
             description = $4,
             survey_type = $5,
             status = $6,
             blocks_json = $7::jsonb,
             theme_json = $8::jsonb,
             settings_json = $9::jsonb,
             updated_at = clock_timestamp()
         WHERE tenant_id = $1 AND id = $2`,
        [
          ctx.tenantId,
          req.params.id,
          title,
          description,
          surveyType,
          status,
          JSON.stringify(blocks),
          JSON.stringify(theme),
          JSON.stringify(settings),
        ]
      );

      const r = await client.query('SELECT * FROM mkt_surveys WHERE tenant_id = $1 AND id = $2', [
        ctx.tenantId,
        req.params.id,
      ]);
      return mapSurveyRow(r.rows[0]);
    });

    if (!updated) {
      sendApiError(res, 404, 'SURVEY_NOT_FOUND', 'Không tìm thấy Khảo sát.');
      return;
    }
    res.json({ success: true, data: updated });
  } catch (err: any) {
    sendApiError(res, 500, 'UPDATE_SURVEY_FAILED', err?.message || 'Không thể cập nhật Khảo sát.');
  }
});

surveysRouter.delete('/:id', requirePermission('mkt_surveys', 'delete'), async (req, res) => {
  try {
    const ctx = getTenantContext();
    const count = await withTenantTransaction(ctx.tenantId, async (client) => {
      const r = await client.query('DELETE FROM mkt_surveys WHERE tenant_id = $1 AND id = $2', [
        ctx.tenantId,
        req.params.id,
      ]);
      return r.rowCount;
    });
    if (!count) {
      sendApiError(res, 404, 'SURVEY_NOT_FOUND', 'Không tìm thấy Khảo sát cần xóa.');
      return;
    }
    res.json({ success: true, data: { deleted: true } });
  } catch (err: any) {
    sendApiError(res, 500, 'DELETE_SURVEY_FAILED', err?.message || 'Không thể xóa Khảo sát.');
  }
});

// Survey / Quiz Response Analytics
surveysRouter.get('/:id/analytics', requirePermission('mkt_surveys', 'view'), async (req, res) => {
  try {
    const ctx = getTenantContext();
    const cfg = await getTenantSettingsCached(ctx.tenantId);

    const data = await withTenantTransaction(ctx.tenantId, async (client) => {
      const srvRes = await client.query('SELECT * FROM mkt_surveys WHERE tenant_id = $1 AND id = $2 LIMIT 1', [
        ctx.tenantId,
        req.params.id,
      ]);
      const srv = srvRes.rows[0];
      if (!srv) return null;

      const canUnmask = await canUserUnmaskMarketingPii(client, ctx.tenantId, ctx.userId);
      const respRes = await client.query(
        `SELECT r.*, l.name, l.phone, l.email, l.lead_score
         FROM mkt_survey_responses r
         LEFT JOIN leads l ON l.tenant_id = r.tenant_id AND l.id = r.lead_id
         WHERE r.tenant_id = $1 AND r.survey_id = $2
         ORDER BY r.created_at DESC
         LIMIT 200`,
        [ctx.tenantId, req.params.id]
      );

      let promoters = 0;
      let passives = 0;
      let detractors = 0;
      let npsCount = 0;
      let totalQuizScore = 0;

      const responses = respRes.rows.map((row) => {
        const quizScore = Number(row.quiz_score || 0);
        totalQuizScore += quizScore;
        if (row.nps_score !== null && row.nps_score !== undefined) {
          const nps = Number(row.nps_score);
          npsCount++;
          if (nps >= 9) promoters++;
          else if (nps >= 7) passives++;
          else detractors++;
        }
        const masked = maskContactPiiIfDisallowed(row, canUnmask, cfg);
        return {
          ...masked,
          answers: parseJsonCol<Record<string, unknown>>(row.answers_json, {}),
          tags_applied: parseJsonCol<string[]>(row.tags_applied, []),
          quiz_score: quizScore,
          nps_score: row.nps_score !== null && row.nps_score !== undefined ? Number(row.nps_score) : null,
        };
      });

      const npsIndex = npsCount > 0 ? Math.round(((promoters - detractors) / npsCount) * 100) : 0;
      const avgQuizScore = responses.length > 0 ? Number((totalQuizScore / responses.length).toFixed(1)) : 0;

      return {
        survey: mapSurveyRow(srv),
        summary: {
          total_responses: responses.length,
          avg_quiz_score: avgQuizScore,
          nps_index: npsIndex,
          promoters,
          passives,
          detractors,
        },
        responses,
      };
    });

    if (!data) {
      sendApiError(res, 404, 'SURVEY_NOT_FOUND', 'Không tìm thấy Khảo sát.');
      return;
    }

    res.json({ success: true, data });
  } catch (err: any) {
    sendApiError(res, 500, 'SURVEY_ANALYTICS_FAILED', err?.message || 'Không thể tải báo cáo phân tích Khảo sát.');
  }
});
