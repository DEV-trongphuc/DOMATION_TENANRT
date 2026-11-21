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
import { emitDomainEvent } from '../../core/events/event-bus.ts';
import { refreshAudienceCachedCount, upsertMasterContactInTx } from '../audiences/audiences.service.ts';
import {
  canUserUnmaskMarketingPii,
  generateShortCode,
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

export interface SurveyLogicRuleDto {
  condition?: {
    operator?: 'equals' | 'not_equals' | 'contains' | 'greater_than' | 'less_than' | 'is_empty' | 'is_answered';
    value?: unknown;
  };
  operator?: 'equals' | 'not_equals' | 'contains' | 'greater_than' | 'less_than' | 'is_empty' | 'is_answered';
  value?: unknown;
  action: 'skip_to' | 'end_survey' | 'end_survey_screen' | 'show_block' | 'hide_block';
  target?: string;
}

export interface SurveyMatrixEntryDto {
  id?: string;
  label?: string;
  text?: string;
  title?: string;
  name?: string;
  value?: string;
  key?: string;
}

export interface SurveyBlockItemDto {
  id: string;
  type: string;
  label: string;
  description?: string;
  required?: boolean;
  options?: Array<{ id?: string; label: string; value?: string; points?: number; jumpToBlockId?: string }>;
  matrixRows?: Array<SurveyMatrixEntryDto | string>;
  matrixCols?: Array<SurveyMatrixEntryDto | string>;
  matrix_rows?: Array<SurveyMatrixEntryDto | string>;
  matrix_cols?: Array<SurveyMatrixEntryDto | string>;
  rows?: Array<SurveyMatrixEntryDto | string>;
  columns?: Array<SurveyMatrixEntryDto | string>;
  cols?: Array<SurveyMatrixEntryDto | string>;
  content?: { rows?: Array<SurveyMatrixEntryDto | string>; columns?: Array<SurveyMatrixEntryDto | string> } | string;
  likertLabels?: string[];
  likertPoints?: Array<{ label?: string; value?: unknown }>;
  minValue?: number;
  maxValue?: number;
  points?: number;
  quizPoints?: number;
  correctValue?: string;
  correctAnswer?: unknown;
  correctAnswerMatch?: 'exact' | 'contains';
  tagOnAnswer?: string;
  logic?: SurveyLogicRuleDto[];
  logic_rules?: SurveyLogicRuleDto[];
}

const FREE_TEXT_BLOCK_TYPES = new Set(['short_text', 'long_text', 'email', 'phone']);
const NON_QUESTION_BLOCK_TYPES = new Set([
  'section_header',
  'image_block',
  'banner_block',
  'divider',
  'page_break',
  'welcome',
  'thank_you',
  'section_break',
]);

function isPlainSurveyObject(v: unknown): v is Record<string, unknown> {
  return Boolean(v && typeof v === 'object' && !Array.isArray(v) && !(v instanceof Date));
}

function decodeSurveyHtmlEntities(input: string): string {
  return input
    .replace(/&amp;/gi, '&')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&quot;/gi, '"')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>');
}

function lookupSurveyLabel(map: Map<string, string>, rawKey: string): string | undefined {
  if (!rawKey) return undefined;
  const trimmed = rawKey.trim();
  const decoded = decodeSurveyHtmlEntities(trimmed);
  const rawDecoded = decodeSurveyHtmlEntities(rawKey);
  return map.get(rawKey) ?? map.get(trimmed) ?? map.get(rawDecoded) ?? map.get(decoded);
}

function firstNonEmptySurveyText(...candidates: unknown[]): string {
  for (const c of candidates) {
    if (c === undefined || c === null || isPlainSurveyObject(c) || Array.isArray(c)) continue;
    const s = String(c).trim();
    if (s !== '') return s;
  }
  return '';
}

function isEmptyCheckboxFlagMap(obj: Record<string, unknown>): boolean {
  if (firstNonEmptySurveyText(obj.label, obj.text, obj.title, obj.name, obj.value) !== '') return false;
  const vals = Object.values(obj);
  return vals.length === 0 || vals.every((v) => v === false || v === null || v === undefined || v === '');
}

function isFileUploadPayload(obj: Record<string, unknown>, blockType?: string): boolean {
  if (blockType === 'file_upload') return true;
  const hasFileKey =
    typeof obj.name === 'string' || typeof obj.filename === 'string' || typeof obj.file_name === 'string';
  const hasFileMeta =
    'dataUrl' in obj || 'data_url' in obj || 'size' in obj || 'mimeType' in obj || 'url' in obj;
  return hasFileKey && hasFileMeta;
}

function isEmptySurveyAnswer(val: unknown): boolean {
  if (val === undefined || val === null || val === '') return true;
  if (Array.isArray(val)) return val.every((item) => isEmptySurveyAnswer(item));
  if (isPlainSurveyObject(val)) {
    if (isFileUploadPayload(val)) {
      return firstNonEmptySurveyText(val.name, val.filename, val.file_name, val.url) === '';
    }
    const vals = Object.values(val);
    if (vals.length === 0) return true;
    return vals.every((item) => {
      if (isPlainSurveyObject(item) && isEmptyCheckboxFlagMap(item)) return true;
      return isEmptySurveyAnswer(item);
    });
  }
  return false;
}

interface SurveyBlockLabelMaps {
  rowMap: Map<string, string>;
  rowOrder: Map<string, number>;
  colMap: Map<string, string>;
  optionMap: Map<string, string>;
}

function addSurveyLabelEntry(map: Map<string, string>, item: unknown, orderMap?: Map<string, number>, orderIdx?: number) {
  if (typeof item === 'string') {
    const s = item.trim();
    if (s) {
      map.set(s, s);
      const decoded = decodeSurveyHtmlEntities(s);
      if (decoded && decoded !== s && !map.has(decoded)) map.set(decoded, s);
      if (orderMap && orderIdx !== undefined && !orderMap.has(s)) {
        orderMap.set(s, orderIdx);
        if (decoded && !orderMap.has(decoded)) orderMap.set(decoded, orderIdx);
      }
    }
    return;
  }
  if (!isPlainSurveyObject(item)) return;
  const label = firstNonEmptySurveyText(item.label, item.text, item.title, item.name, item.value, item.id);
  if (!label) return;
  for (const keyField of ['id', 'value', 'key', 'code', 'label']) {
    const rawKey = item[keyField];
    if (rawKey !== undefined && rawKey !== null && String(rawKey).trim() !== '') {
      const k = String(rawKey).trim();
      if (keyField !== 'label' || !map.has(k)) {
        map.set(k, label);
      }
      const decoded = decodeSurveyHtmlEntities(k);
      if (decoded && !map.has(decoded)) {
        map.set(decoded, label);
      }
      if (orderMap && orderIdx !== undefined && !orderMap.has(k)) {
        orderMap.set(k, orderIdx);
        if (decoded && !orderMap.has(decoded)) orderMap.set(decoded, orderIdx);
      }
    }
  }
}

function buildSurveyBlockLabelMaps(block: SurveyBlockItemDto): SurveyBlockLabelMaps {
  const rowMap = new Map<string, string>();
  const rowOrder = new Map<string, number>();
  const colMap = new Map<string, string>();
  const optionMap = new Map<string, string>();

  const contentObj: Record<string, unknown> | null = isPlainSurveyObject(block.content)
    ? (block.content as Record<string, unknown>)
    : typeof block.content === 'string' && block.content.trim().startsWith('{')
      ? parseJsonCol<Record<string, unknown>>(block.content, {})
      : null;

  const rawRows = [
    ...(Array.isArray(block.matrixRows) ? block.matrixRows : []),
    ...(Array.isArray(block.matrix_rows) ? block.matrix_rows : []),
    ...(Array.isArray(block.rows) ? block.rows : []),
    ...(contentObj && Array.isArray(contentObj.rows) ? contentObj.rows : []),
    ...(contentObj && Array.isArray(contentObj.matrix_rows) ? contentObj.matrix_rows : []),
    ...(contentObj && Array.isArray(contentObj.matrixRows) ? contentObj.matrixRows : []),
  ];
  rawRows.forEach((r, idx) => addSurveyLabelEntry(rowMap, r, rowOrder, idx));

  const rawCols = [
    ...(Array.isArray(block.matrixCols) ? block.matrixCols : []),
    ...(Array.isArray(block.matrix_cols) ? block.matrix_cols : []),
    ...(Array.isArray(block.columns) ? block.columns : []),
    ...(Array.isArray(block.cols) ? block.cols : []),
    ...(contentObj && Array.isArray(contentObj.columns) ? contentObj.columns : []),
    ...(contentObj && Array.isArray(contentObj.matrix_cols) ? contentObj.matrix_cols : []),
    ...(contentObj && Array.isArray(contentObj.matrixCols) ? contentObj.matrixCols : []),
  ];
  for (const c of rawCols) addSurveyLabelEntry(colMap, c);

  const rawOptsCandidate = (block as unknown as Record<string, unknown>).options ?? contentObj?.options;
  const rawOpts = Array.isArray(rawOptsCandidate)
    ? rawOptsCandidate
    : isPlainSurveyObject(rawOptsCandidate) && Array.isArray(rawOptsCandidate.choices)
      ? rawOptsCandidate.choices
      : [];
  for (const o of rawOpts) {
    addSurveyLabelEntry(optionMap, o);
    if (rawCols.length === 0) {
      addSurveyLabelEntry(colMap, o);
    }
  }

  if (Array.isArray(block.likertPoints)) {
    for (const pt of block.likertPoints) {
      addSurveyLabelEntry(colMap, pt);
    }
  }
  if (Array.isArray(block.likertLabels) && ['likert', 'likert_matrix'].includes(block.type)) {
    block.likertLabels.forEach((lbl, idx) => {
      const clean = String(lbl || '').trim();
      if (clean && !colMap.has(String(idx + 1))) {
        colMap.set(String(idx + 1), clean);
      }
    });
  }

  return { rowMap, rowOrder, colMap, optionMap };
}

function getOrderedSurveyObjectEntries(
  obj: Record<string, unknown>,
  rowOrder: Map<string, number>
): Array<[string, unknown]> {
  const entries = Object.entries(obj);
  if (rowOrder.size === 0 || entries.length <= 1) return entries;
  return entries.sort(([a], [b]) => {
    const oa = rowOrder.get(a) ?? rowOrder.get(a.trim()) ?? rowOrder.get(decodeSurveyHtmlEntities(a.trim())) ?? Number.MAX_SAFE_INTEGER;
    const ob = rowOrder.get(b) ?? rowOrder.get(b.trim()) ?? rowOrder.get(decodeSurveyHtmlEntities(b.trim())) ?? Number.MAX_SAFE_INTEGER;
    return oa - ob;
  });
}

function normalizeSurveyAnswerValue(val: unknown, blockType: string): unknown {
  if (typeof val === 'string' && !FREE_TEXT_BLOCK_TYPES.has(blockType)) {
    const trimmed = val.trim();
    if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
      try {
        const parsed = JSON.parse(trimmed);
        if (isPlainSurveyObject(parsed) || Array.isArray(parsed)) return parsed;
      } catch {
        // keep raw string
      }
    }
  }
  return val;
}

function formatSurveyCellValue(item: unknown, lookupMap: Map<string, string>): string {
  if (item === undefined || item === null) return '';
  if (item instanceof Date) return item.toISOString();
  if (isPlainSurveyObject(item)) {
    if (isFileUploadPayload(item)) {
      return firstNonEmptySurveyText(item.name, item.filename, item.file_name, item.url);
    }
    const directCandidate = firstNonEmptySurveyText(item.label, item.text, item.title, item.name, item.value);
    if (directCandidate !== '') {
      return lookupSurveyLabel(lookupMap, directCandidate) ?? directCandidate;
    }
    return Object.entries(item)
      .map(([k, v]) => {
        if (v === false || v === null || v === undefined || v === '') return '';
        const mappedKey = lookupSurveyLabel(lookupMap, k) ?? k;
        if (v === true) return mappedKey;
        const formatted = formatSurveyCellValue(v, lookupMap);
        return formatted ? `${mappedKey}: ${formatted}` : '';
      })
      .filter(Boolean)
      .join(', ');
  }
  if (Array.isArray(item)) {
    return item
      .map((sub) => formatSurveyCellValue(sub, lookupMap))
      .filter(Boolean)
      .join(', ');
  }
  const raw = String(item);
  return lookupSurveyLabel(lookupMap, raw) ?? raw;
}

function extractMatrixBreakdownEntries(
  obj: Record<string, unknown>,
  block: SurveyBlockItemDto,
  maps: SurveyBlockLabelMaps
): string[] {
  if (isFileUploadPayload(obj, block.type)) {
    const fileLabel = firstNonEmptySurveyText(obj.name, obj.filename, obj.file_name, obj.url);
    return fileLabel ? [fileLabel] : [];
  }

  const entries: string[] = [];
  for (const [rawRowKey, rawCellVal] of getOrderedSurveyObjectEntries(obj, maps.rowOrder)) {
    if (isEmptySurveyAnswer(rawCellVal)) continue;
    if (isPlainSurveyObject(rawCellVal) && isEmptyCheckboxFlagMap(rawCellVal)) continue;
    const rowLabel = lookupSurveyLabel(maps.rowMap, rawRowKey) ?? rawRowKey;
    if (Array.isArray(rawCellVal)) {
      for (const cellItem of rawCellVal) {
        if (isEmptySurveyAnswer(cellItem)) continue;
        const colLabel = formatSurveyCellValue(cellItem, maps.colMap);
        if (colLabel) entries.push(`${rowLabel}: ${colLabel}`);
      }
    } else if (isPlainSurveyObject(rawCellVal)) {
      const directCandidate = firstNonEmptySurveyText(
        rawCellVal.label,
        rawCellVal.text,
        rawCellVal.title,
        rawCellVal.name,
        rawCellVal.value
      );
      if (directCandidate !== '') {
        const colLabel = lookupSurveyLabel(maps.colMap, directCandidate) ?? directCandidate;
        if (colLabel) entries.push(`${rowLabel}: ${colLabel}`);
      } else {
        for (const [subKey, subVal] of Object.entries(rawCellVal)) {
          if (subVal === false || subVal === null || subVal === undefined || subVal === '') continue;
          const mappedKey = lookupSurveyLabel(maps.colMap, subKey) ?? subKey;
          const colLabel =
            subVal === true ? mappedKey : `${mappedKey}=${formatSurveyCellValue(subVal, maps.colMap)}`;
          entries.push(`${rowLabel}: ${colLabel}`);
        }
      }
    } else {
      const colLabel = formatSurveyCellValue(rawCellVal, maps.colMap);
      if (colLabel) entries.push(`${rowLabel}: ${colLabel}`);
    }
  }
  return entries;
}

function formatSurveyAnswerForCsv(
  rawVal: unknown,
  block: SurveyBlockItemDto,
  maps: SurveyBlockLabelMaps
): string {
  const val = normalizeSurveyAnswerValue(rawVal, block.type);
  if (isEmptySurveyAnswer(val)) return '';
  if (val instanceof Date) return val.toISOString();

  if (Array.isArray(val)) {
    const preferredMap = maps.optionMap.size > 0 ? maps.optionMap : maps.colMap;
    return val
      .map((item) => {
        if (isEmptySurveyAnswer(item)) return '';
        if (isPlainSurveyObject(item)) {
          return formatSurveyAnswerForCsv(item, block, maps);
        }
        return formatSurveyCellValue(item, preferredMap);
      })
      .filter(Boolean)
      .join('; ');
  }

  if (isPlainSurveyObject(val)) {
    if (isFileUploadPayload(val, block.type)) {
      return firstNonEmptySurveyText(val.name, val.filename, val.file_name, val.url);
    }
    const rowParts: string[] = [];
    for (const [rawRowKey, rawCellVal] of getOrderedSurveyObjectEntries(val, maps.rowOrder)) {
      if (isEmptySurveyAnswer(rawCellVal)) continue;
      if (isPlainSurveyObject(rawCellVal) && isEmptyCheckboxFlagMap(rawCellVal)) continue;
      const rowLabel = lookupSurveyLabel(maps.rowMap, rawRowKey) ?? rawRowKey;
      if (Array.isArray(rawCellVal)) {
        const colLabels = rawCellVal
          .map((c) => formatSurveyCellValue(c, maps.colMap))
          .filter(Boolean);
        if (colLabels.length > 0) {
          rowParts.push(`${rowLabel}: ${colLabels.join(', ')}`);
        }
      } else if (isPlainSurveyObject(rawCellVal)) {
        const directCandidate = firstNonEmptySurveyText(
          rawCellVal.label,
          rawCellVal.text,
          rawCellVal.title,
          rawCellVal.name,
          rawCellVal.value
        );
        if (directCandidate !== '') {
          const colLabel = lookupSurveyLabel(maps.colMap, directCandidate) ?? directCandidate;
          if (colLabel) rowParts.push(`${rowLabel}: ${colLabel}`);
        } else {
          const nestedCols = Object.entries(rawCellVal)
            .filter(([, subV]) => subV !== false && subV !== null && subV !== undefined && subV !== '')
            .map(([subK, subV]) => {
              const mk = lookupSurveyLabel(maps.colMap, subK) ?? subK;
              return subV === true ? mk : `${mk}=${formatSurveyCellValue(subV, maps.colMap)}`;
            })
            .filter(Boolean);
          if (nestedCols.length > 0) rowParts.push(`${rowLabel}: ${nestedCols.join(', ')}`);
        }
      } else {
        const colLabel = formatSurveyCellValue(rawCellVal, maps.colMap);
        if (colLabel) rowParts.push(`${rowLabel}: ${colLabel}`);
      }
    }
    return rowParts.join(' | ');
  }

  const rawStr = String(val);
  if (
    !['number', 'nps', 'csat_stars', 'star_rating', 'slider', 'emoji_rating', 'short_text', 'long_text', 'email', 'phone', 'date'].includes(
      block.type
    )
  ) {
    return lookupSurveyLabel(maps.optionMap, rawStr) ?? lookupSurveyLabel(maps.colMap, rawStr) ?? rawStr;
  }
  return rawStr;
}

function buildSurveyQuestionStatsAndAnalytics(
  survey: { blocks: SurveyBlockItemDto[] },
  responses: Array<{ answers: Record<string, unknown> }>
) {
  const totalResponses = responses.length;
  const qBlocks = survey.blocks.filter((b) => !NON_QUESTION_BLOCK_TYPES.has(b.type));

  const questionStats = qBlocks.map((b) => {
    const blockMaps = buildSurveyBlockLabelMaps(b);
    const counts: Record<string, number> = {};
    let answeredCount = 0;
    let numericSum = 0;
    let numericCount = 0;
    let promoters = 0;
    let passives = 0;
    let detractors = 0;
    const sampleTexts: string[] = [];

    for (const r of responses) {
      const effectiveVal = normalizeSurveyAnswerValue(r.answers?.[b.id], b.type);
      if (isEmptySurveyAnswer(effectiveVal)) continue;

      if (isPlainSurveyObject(effectiveVal)) {
        const entries = extractMatrixBreakdownEntries(effectiveVal, b, blockMaps);
        if (entries.length === 0) continue;
        answeredCount++;
        for (const entry of entries) {
          if (FREE_TEXT_BLOCK_TYPES.has(b.type)) {
            if (sampleTexts.length < 15) sampleTexts.push(entry);
          } else {
            counts[entry] = (counts[entry] || 0) + 1;
          }
        }
      } else if (Array.isArray(effectiveVal)) {
        const preferredMap = blockMaps.optionMap.size > 0 ? blockMaps.optionMap : blockMaps.colMap;
        const formattedItems: string[] = [];
        for (const item of effectiveVal) {
          if (isEmptySurveyAnswer(item)) continue;
          const k = isPlainSurveyObject(item)
            ? extractMatrixBreakdownEntries(item, b, blockMaps).join(' | ') ||
              formatSurveyCellValue(item, preferredMap)
            : formatSurveyCellValue(item, preferredMap);
          if (k) formattedItems.push(k);
        }
        if (formattedItems.length === 0) continue;
        answeredCount++;
        for (const k of formattedItems) {
          counts[k] = (counts[k] || 0) + 1;
        }
      } else if (
        ['number', 'nps', 'csat_stars', 'star_rating', 'rating', 'slider', 'likert', 'emoji_rating'].includes(b.type) &&
        (typeof effectiveVal === 'number' ||
          (typeof effectiveVal === 'string' && effectiveVal.trim() !== '' && !Number.isNaN(Number(effectiveVal))))
      ) {
        answeredCount++;
        const num = Number(effectiveVal);
        if (Number.isFinite(num)) {
          numericSum += num;
          numericCount++;
          if (b.type === 'nps') {
            if (num >= 9) promoters++;
            else if (num >= 7) passives++;
            else detractors++;
          }
        }
        const rawStr = String(effectiveVal);
        const k = ['star_rating', 'rating', 'csat_stars', 'likert', 'emoji_rating'].includes(b.type)
          ? lookupSurveyLabel(blockMaps.colMap, rawStr) ?? lookupSurveyLabel(blockMaps.optionMap, rawStr) ?? rawStr
          : rawStr;
        counts[k] = (counts[k] || 0) + 1;
      } else {
        answeredCount++;
        const str = String(effectiveVal);
        if (FREE_TEXT_BLOCK_TYPES.has(b.type)) {
          if (sampleTexts.length < 15) sampleTexts.push(str);
        } else {
          const resolved = ![
            'number',
            'nps',
            'csat_stars',
            'slider',
            'star_rating',
            'emoji_rating',
            'date',
          ].includes(b.type)
            ? lookupSurveyLabel(blockMaps.colMap, str) ?? lookupSurveyLabel(blockMaps.optionMap, str) ?? str
            : str;
          counts[resolved] = (counts[resolved] || 0) + 1;
        }
      }
    }

    const breakdown = Object.entries(counts)
      .map(([option, count]) => ({
        option,
        count,
        pct: answeredCount > 0 ? Number(((count / answeredCount) * 100).toFixed(1)) : 0,
      }))
      .sort((a, b2) => b2.count - a.count);

    const numericAvg = numericCount > 0 ? Number((numericSum / numericCount).toFixed(2)) : null;
    const isNps = b.type === 'nps' && numericCount > 0;
    const isRating = ['star_rating', 'rating', 'csat_stars', 'slider', 'likert'].includes(b.type) && numericAvg !== null;

    return {
      stat: {
        block_id: b.id,
        label: b.label,
        type: b.type,
        answered_count: answeredCount,
        numeric_avg: numericAvg,
        breakdown,
        sample_texts: sampleTexts,
      },
      analyticsQuestion: {
        question_id: b.id,
        type: b.type,
        label: b.label || b.id || 'Câu hỏi',
        total_answered: answeredCount,
        skip_rate: totalResponses > 0 ? Math.max(0, (totalResponses - answeredCount) / totalResponses) : 0,
        choice_distribution:
          breakdown.length > 0 && !isNps
            ? breakdown.map((item) => ({
                label: item.option,
                count: item.count,
                percentage: Math.round(item.pct),
              }))
            : undefined,
        text_responses: sampleTexts.length > 0 ? sampleTexts : undefined,
        avg_rating: isRating ? numericAvg ?? undefined : undefined,
        nps_score: isNps ? Math.round(((promoters - detractors) / numericCount) * 100) : undefined,
        promoters,
        passives,
        detractors,
      },
    };
  });

  return {
    questionStats: questionStats.map((q) => q.stat),
    analyticsQuestions: questionStats.map((q) => q.analyticsQuestion),
  };
}

function formatSurveyRespondentAnswers(
  rawAnswers: Record<string, unknown>,
  survey: { blocks: SurveyBlockItemDto[] },
  asArray: boolean
): Record<string, unknown> | Array<{ block_id: string; question_title: string; answer_text: string }> {
  const qBlocks = survey.blocks.filter((b) => !NON_QUESTION_BLOCK_TYPES.has(b.type));
  const blockById = new Map(qBlocks.map((b) => [b.id, b]));
  const mapsById = new Map(qBlocks.map((b) => [b.id, buildSurveyBlockLabelMaps(b)]));

  if (asArray) {
    const out: Array<{ block_id: string; question_title: string; answer_text: string }> = [];
    const seen = new Set<string>();
    for (const b of qBlocks) {
      const maps = mapsById.get(b.id) || buildSurveyBlockLabelMaps(b);
      const formatted = formatSurveyAnswerForCsv(rawAnswers[b.id], b, maps);
      if (b.id in rawAnswers || formatted !== '') {
        seen.add(b.id);
        out.push({
          block_id: b.id,
          question_title: b.label || b.id,
          answer_text: formatted,
        });
      }
    }
    for (const [k, v] of Object.entries(rawAnswers)) {
      if (seen.has(k) || k.startsWith('_')) continue;
      const fallbackBlock: SurveyBlockItemDto = blockById.get(k) || { id: k, type: 'short_text', label: k };
      const maps = mapsById.get(k) || buildSurveyBlockLabelMaps(fallbackBlock);
      const formatted = formatSurveyAnswerForCsv(v, fallbackBlock, maps);
      if (formatted !== '') {
        out.push({
          block_id: k,
          question_title: fallbackBlock.label || k,
          answer_text: formatted,
        });
      }
    }
    if (out.length === 0 && Array.isArray(rawAnswers._answer_details)) {
      rawAnswers._answer_details.forEach((detail: unknown, idx: number) => {
        if (!isPlainSurveyObject(detail)) return;
        const title = firstNonEmptySurveyText(detail.question_title, detail.label, `Câu hỏi #${idx + 1}`);
        const answerText = formatSurveyCellValue(detail.answer_text ?? detail.answer ?? '', new Map());
        out.push({
          block_id: firstNonEmptySurveyText(detail.block_id, detail.question_id, `q_${idx + 1}`),
          question_title: title,
          answer_text: answerText,
        });
      });
    }
    return out;
  }

  const sanitized: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(rawAnswers)) {
    if (k.startsWith('_')) continue;
    const block = blockById.get(k);
    if (block) {
      const maps = mapsById.get(k) || buildSurveyBlockLabelMaps(block);
      const formatted = formatSurveyAnswerForCsv(v, block, maps);
      sanitized[k] = formatted !== '' ? formatted : isEmptySurveyAnswer(v) ? '' : v;
    } else if (isPlainSurveyObject(v) || Array.isArray(v)) {
      const formatted = formatSurveyAnswerForCsv(v, { id: k, type: 'short_text', label: k }, buildSurveyBlockLabelMaps({ id: k, type: 'short_text', label: k }));
      sanitized[k] = formatted;
    } else {
      sanitized[k] = v;
    }
  }
  return sanitized;
}

function normalizeSurveySettings(
  rawSettings: Record<string, unknown>,
  rawBody: Record<string, unknown> = {}
): Record<string, unknown> {
  const s = rawSettings && typeof rawSettings === 'object' ? { ...rawSettings } : {};
  const rewardVoucherId = String(
    s.reward_voucher_campaign_id ??
      s.voucher_campaign_id ??
      s.voucherCampaignId ??
      rawBody.reward_voucher_campaign_id ??
      rawBody.voucher_campaign_id ??
      ''
  ).trim() || null;

  const targetAudienceId = String(
    s.target_audience_id ??
      s.auto_add_list_id ??
      s.targetAudienceId ??
      rawBody.target_audience_id ??
      ''
  ).trim() || null;

  const rawMax = s.max_responses ?? s.maxResponses ?? rawBody.max_responses;
  const maxResponses =
    rawMax !== undefined && rawMax !== null && String(rawMax).trim() !== '' && Number(rawMax) > 0
      ? Math.round(Number(rawMax))
      : null;

  const allowMultiple =
    s.allow_multiple_submissions !== undefined
      ? Boolean(s.allow_multiple_submissions)
      : rawBody.allow_multiple_submissions !== undefined
        ? Boolean(rawBody.allow_multiple_submissions)
        : rawBody.one_per_email === true || s.one_per_email === true
          ? false
          : true;

  const rawAutoTags = Array.isArray(s.auto_tags)
    ? s.auto_tags.map((x) => String(x || '').trim()).filter(Boolean)
    : [];
  const primaryAutoTag = String(s.auto_tag || rawAutoTags[0] || '').trim();
  const mergedAutoTags = Array.from(new Set([primaryAutoTag, ...rawAutoTags].filter(Boolean)));

  const customRedirectUrl = String(
    s.custom_redirect_url ?? s.redirect_url ?? s.redirectUrl ?? rawBody.custom_redirect_url ?? ''
  ).trim();

  return {
    ...s,
    auto_tag: primaryAutoTag,
    auto_tags: mergedAutoTags,
    base_lead_score: Number(s.base_lead_score ?? 10),
    target_audience_id: targetAudienceId,
    auto_add_list_id: targetAudienceId,
    reward_voucher_campaign_id: rewardVoucherId,
    voucher_campaign_id: rewardVoucherId,
    max_responses: maxResponses,
    allow_multiple_submissions: allowMultiple,
    create_crm_lead: s.create_crm_lead !== false,
    emit_flow_trigger: s.emit_flow_trigger !== false,
    custom_redirect_url: customRedirectUrl || null,
    append_redirect_params: s.append_redirect_params !== false,
  };
}

function evaluateSurveyLogicCondition(
  rule: SurveyLogicRuleDto,
  val: unknown
): boolean {
  const op = rule.condition?.operator || rule.operator || 'equals';
  const expected = rule.condition ? rule.condition.value : rule.value;
  const isEmpty =
    val === undefined ||
    val === null ||
    val === '' ||
    (Array.isArray(val) && val.length === 0);

  if (op === 'is_empty') return isEmpty;
  if (op === 'is_answered') return !isEmpty;
  if (isEmpty) return false;

  if (Array.isArray(val)) {
    const arr = val.map((x) => String(x).toLowerCase());
    const expStr = String(expected ?? '').toLowerCase();
    if (op === 'contains') return arr.includes(expStr);
    if (op === 'equals') return arr.join(',') === expStr;
    if (op === 'not_equals') return !arr.includes(expStr);
    return false;
  }

  const strVal = String(val).trim().toLowerCase();
  const strExp = String(expected ?? '').trim().toLowerCase();
  if (op === 'equals') return strVal === strExp;
  if (op === 'not_equals') return strVal !== strExp;
  if (op === 'contains') return strVal.includes(strExp);
  if (op === 'greater_than') return Number(val) > Number(expected);
  if (op === 'less_than') return Number(val) < Number(expected);
  return false;
}

function appendSurveyRedirectQuery(
  rawUrl: string,
  params: { score?: number | null; voucher?: string | null; nps?: number | null; tier?: string | null }
): string {
  const clean = String(rawUrl || '').trim();
  if (!clean) return clean;
  try {
    const isRel = clean.startsWith('/');
    const parsed = new URL(clean, 'https://domation.local');
    if (params.score !== undefined && params.score !== null) {
      parsed.searchParams.set('score', String(params.score));
    }
    if (params.voucher) {
      parsed.searchParams.set('voucher', params.voucher);
    }
    if (params.nps !== undefined && params.nps !== null) {
      parsed.searchParams.set('nps', String(params.nps));
    }
    if (params.tier) {
      parsed.searchParams.set('tier', params.tier);
    }
    return isRel ? `${parsed.pathname}${parsed.search}${parsed.hash}` : parsed.toString();
  } catch {
    return clean;
  }
}

function mapSurveyRow(row: Record<string, unknown>) {
  const title = String(row.title || '');
  const thankYou = parseJsonCol<Record<string, unknown>>(row.thank_you_json, {});
  const settings = normalizeSurveySettings(parseJsonCol<Record<string, unknown>>(row.settings_json, {}));
  return {
    id: String(row.id),
    tenant_id: String(row.tenant_id),
    title,
    name: title,
    slug: String(row.slug || ''),
    description: row.description ? String(row.description) : '',
    survey_type: String(row.survey_type || 'survey') as 'survey' | 'quiz' | 'nps',
    status: String(row.status || 'active'),
    blocks: parseJsonCol<SurveyBlockItemDto[]>(row.blocks_json, []),
    theme: parseJsonCol<Record<string, unknown>>(row.theme_json, {}),
    settings,
    redirect_rules: parseJsonCol<Array<Record<string, unknown>>>(row.redirect_rules_json, []),
    thank_you: thankYou,
    thankYouPage: thankYou,
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
    const title = String(req.body?.title || req.body?.name || '').trim();
    if (!title) {
      sendApiError(res, 422, 'SURVEY_TITLE_REQUIRED', 'Vui lòng nhập tiêu đề Khảo sát / Bài Quiz.');
      return;
    }

    const baseSlug = slugifyMarketingKey(String(req.body?.slug || title), 'survey');
    const uniqueSlug = `${baseSlug}-${crypto.randomBytes(2).toString('hex')}`;
    const surveyType =
      req.body?.survey_type === 'quiz' ? 'quiz' : req.body?.survey_type === 'nps' ? 'nps' : 'survey';
    const description = req.body?.description ? String(req.body.description).trim() : null;
    const rawBlocks = Array.isArray(req.body?.blocks)
      ? req.body.blocks
      : Array.isArray(req.body?.blocks_json)
        ? req.body.blocks_json
        : [];
    const blocks: SurveyBlockItemDto[] = rawBlocks;
    const theme =
      req.body?.theme && typeof req.body.theme === 'object'
        ? req.body.theme
        : { primaryColor: '#1E40FF', backgroundColor: '#F8F9FA', cardBackground: '#FFFFFF' };
    const settings = normalizeSurveySettings(
      req.body?.settings && typeof req.body.settings === 'object' ? req.body.settings : {},
      req.body || {}
    );
    const redirectRules = Array.isArray(req.body?.redirect_rules)
      ? req.body.redirect_rules
      : Array.isArray(req.body?.score_tiers)
        ? req.body.score_tiers
        : Array.isArray((settings as Record<string, unknown>).redirect_rules)
          ? (settings as Record<string, unknown>).redirect_rules
          : Array.isArray((settings as Record<string, unknown>).score_tiers)
            ? (settings as Record<string, unknown>).score_tiers
            : [];
    const rawThankYou = req.body?.thank_you ?? req.body?.thankYouPage ?? req.body?.thank_you_page;
    const thankYou =
      rawThankYou && typeof rawThankYou === 'object'
        ? rawThankYou
        : { title: 'Cảm ơn bạn đã hoàn thành khảo sát!', subtitle: 'Phản hồi của bạn đã được ghi nhận.' };

    const id = crypto.randomUUID();
    const created = await withTenantTransaction(ctx.tenantId, async (client) => {
      await client.query(
        `INSERT INTO mkt_surveys (
           id, tenant_id, title, slug, description, survey_type, status,
           blocks_json, theme_json, settings_json, redirect_rules_json, thank_you_json, created_by
         ) VALUES (
           $1, $2, $3, $4, $5, $6, 'active',
           $7::jsonb, $8::jsonb, $9::jsonb, $10::jsonb, $11::jsonb, $12
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
          JSON.stringify(redirectRules),
          JSON.stringify(thankYou),
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

// Get Single Survey Detail
surveysRouter.get('/:id', requirePermission('mkt_surveys', 'view'), async (req, res) => {
  try {
    const ctx = getTenantContext();
    const row = await withTenantTransaction(ctx.tenantId, async (client) => {
      const r = await client.query('SELECT * FROM mkt_surveys WHERE tenant_id = $1 AND id = $2 LIMIT 1', [
        ctx.tenantId,
        req.params.id,
      ]);
      return r.rows[0] || null;
    });
    if (!row) {
      sendApiError(res, 404, 'SURVEY_NOT_FOUND', 'Không tìm thấy Khảo sát.');
      return;
    }
    res.json({ success: true, data: mapSurveyRow(row) });
  } catch (err: any) {
    sendApiError(res, 500, 'GET_SURVEY_FAILED', err?.message || 'Không thể tải chi tiết Khảo sát.');
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

      const title =
        req.body?.title !== undefined
          ? String(req.body.title).trim()
          : req.body?.name !== undefined
            ? String(req.body.name).trim()
            : String(ex.title);
      const description =
        req.body?.description !== undefined ? String(req.body.description).trim() : ex.description;
      const surveyType =
        req.body?.survey_type !== undefined ? String(req.body.survey_type) : String(ex.survey_type);
      const status = req.body?.status !== undefined ? String(req.body.status) : String(ex.status);
      const blocks = Array.isArray(req.body?.blocks)
        ? req.body.blocks
        : Array.isArray(req.body?.blocks_json)
          ? req.body.blocks_json
          : parseJsonCol(ex.blocks_json, []);
      const theme =
        req.body?.theme && typeof req.body.theme === 'object'
          ? req.body.theme
          : parseJsonCol(ex.theme_json, {});
      const settings = normalizeSurveySettings(
        req.body?.settings && typeof req.body.settings === 'object'
          ? req.body.settings
          : parseJsonCol(ex.settings_json, {}),
        req.body || {}
      );
      const redirectRules = Array.isArray(req.body?.redirect_rules)
        ? req.body.redirect_rules
        : Array.isArray(req.body?.score_tiers)
          ? req.body.score_tiers
          : Array.isArray(req.body?.settings?.redirect_rules)
            ? req.body.settings.redirect_rules
            : Array.isArray(req.body?.settings?.score_tiers)
              ? req.body.settings.score_tiers
              : parseJsonCol(ex.redirect_rules_json, []);
      const rawThankYou = req.body?.thank_you ?? req.body?.thankYouPage ?? req.body?.thank_you_page;
      const thankYou =
        rawThankYou && typeof rawThankYou === 'object'
          ? rawThankYou
          : parseJsonCol(ex.thank_you_json, {});

      await client.query(
        `UPDATE mkt_surveys
         SET title = $3,
             description = $4,
             survey_type = $5,
             status = $6,
             blocks_json = $7::jsonb,
             theme_json = $8::jsonb,
             settings_json = $9::jsonb,
             redirect_rules_json = $10::jsonb,
             thank_you_json = $11::jsonb,
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
          JSON.stringify(redirectRules),
          JSON.stringify(thankYou),
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

// Full Deep-Rule Survey Submission Engine (Branching Logic, Quiz Weights, Score Tiers, NPS, Auto-Tag/List, Voucher Reward, Max Cap, Redirect Params)
surveysRouter.post('/:id/submit', requirePermission('mkt_surveys', 'create'), async (req, res) => {
  try {
    const ctx = getTenantContext();
    const cfg = await getTenantSettingsCached(ctx.tenantId);
    const answers: Record<string, unknown> =
      req.body?.answers && typeof req.body.answers === 'object' ? req.body.answers : {};
    const clientIp = String(req.headers['x-forwarded-for'] || req.ip || '')
      .split(',')[0]
      .trim()
      .slice(0, 64);

    const txOut = await withTenantTransaction(ctx.tenantId, async (client) => {
      const sRes = await client.query('SELECT * FROM mkt_surveys WHERE tenant_id = $1 AND id = $2 LIMIT 1', [
        ctx.tenantId,
        req.params.id,
      ]);
      const surveyRow = sRes.rows[0];
      if (!surveyRow) return { errorStatus: 404, errorCode: 'SURVEY_NOT_FOUND', errorMessage: 'Không tìm thấy Khảo sát.' };
      if (String(surveyRow.status || '') !== 'active') {
        return { errorStatus: 400, errorCode: 'SURVEY_CLOSED', errorMessage: 'Khảo sát hiện không hoạt động.' };
      }

      const blocks = parseJsonCol<SurveyBlockItemDto[]>(surveyRow.blocks_json, []);
      const settings = normalizeSurveySettings(parseJsonCol<Record<string, unknown>>(surveyRow.settings_json, {}));
      const maxResponses = settings.max_responses ? Number(settings.max_responses) : null;
      const allowMultiple = settings.allow_multiple_submissions !== false;

      if (maxResponses !== null && maxResponses > 0) {
        const cntRes = await client.query<{ cnt: number }>(
          'SELECT COUNT(*)::int AS cnt FROM mkt_survey_responses WHERE tenant_id = $1 AND survey_id = $2',
          [ctx.tenantId, surveyRow.id]
        );
        const currentResponses = Number(cntRes.rows[0]?.cnt || 0);
        if (currentResponses >= maxResponses) {
          return {
            errorStatus: 409,
            errorCode: 'SURVEY_LIMIT_REACHED',
            errorMessage: `Khảo sát đã đạt giới hạn tối đa ${maxResponses} lượt phản hồi.`,
          };
        }
      }

      // Extract respondent identity from body or answers
      let contactPhone = String(req.body?.phone || req.body?.respondent_phone || '').trim();
      let contactEmail = String(req.body?.email || req.body?.respondent_email || '').trim().toLowerCase();
      let contactName = String(req.body?.name || req.body?.respondent_name || '').trim();
      for (const b of blocks) {
        const val = answers[b.id];
        if (val === undefined || val === null || val === '') continue;
        if (b.type === 'phone' && !contactPhone) contactPhone = String(val).trim();
        if (b.type === 'email' && !contactEmail) contactEmail = String(val).trim().toLowerCase();
        if (b.type === 'short_text' && !contactName && /tên|name|họ/i.test(String(b.label || ''))) {
          contactName = String(val).trim();
        }
      }

      // Enforce allow_multiple_submissions === false
      if (!allowMultiple && (contactEmail || contactPhone)) {
        const dupRes = await client.query<{ cnt: number }>(
          `SELECT COUNT(*)::int AS cnt
           FROM mkt_survey_responses r
           INNER JOIN leads l ON l.tenant_id = r.tenant_id AND l.id = r.lead_id
           WHERE r.tenant_id = $1 AND r.survey_id = $2
             AND (
               ($3 != '' AND LOWER(COALESCE(l.email, '')) = $3)
               OR ($4 != '' AND COALESCE(l.phone, '') LIKE $5)
             )`,
          [
            ctx.tenantId,
            surveyRow.id,
            contactEmail,
            contactPhone,
            contactPhone ? `%${contactPhone.replace(/\D/g, '').slice(-9)}` : '',
          ]
        );
        if (Number(dupRes.rows[0]?.cnt || 0) > 0) {
          return {
            errorStatus: 409,
            errorCode: 'DUPLICATE_SUBMISSION_NOT_ALLOWED',
            errorMessage: 'Mỗi khách hàng chỉ được phép gửi khảo sát này 1 lần.',
          };
        }
      }

      // Evaluate question skip/branching logic (`logic_rules`, `logic`, `option.jumpToBlockId`)
      const skippedBlockIds = new Set<string>();
      const branchEvents: Array<{ from_block_id: string; action: string; target?: string }> = [];
      let endedEarly = false;

      for (let idx = 0; idx < blocks.length; idx++) {
        const b = blocks[idx];
        if (skippedBlockIds.has(b.id)) continue;
        const val = answers[b.id];

        // 1. Check option-level jumpToBlockId
        if (Array.isArray(b.options) && val !== undefined && val !== null && val !== '') {
          const matchedOpt = b.options.find(
            (o) => String(o.value ?? o.label) === String(val) || String(o.label) === String(val)
          );
          if (matchedOpt?.jumpToBlockId) {
            const targetIdx = blocks.findIndex((tb) => tb.id === matchedOpt.jumpToBlockId);
            if (targetIdx > idx) {
              for (let skipIdx = idx + 1; skipIdx < targetIdx; skipIdx++) {
                skippedBlockIds.add(blocks[skipIdx].id);
              }
              branchEvents.push({ from_block_id: b.id, action: 'skip_to', target: matchedOpt.jumpToBlockId });
            }
          }
        }

        // 2. Check block.logic_rules / block.logic
        const rules = [...(Array.isArray(b.logic_rules) ? b.logic_rules : []), ...(Array.isArray(b.logic) ? b.logic : [])];
        for (const rule of rules) {
          if (!evaluateSurveyLogicCondition(rule, val)) continue;
          if (rule.action === 'skip_to' && rule.target) {
            const targetIdx = blocks.findIndex((tb) => tb.id === rule.target);
            if (targetIdx > idx) {
              for (let skipIdx = idx + 1; skipIdx < targetIdx; skipIdx++) {
                skippedBlockIds.add(blocks[skipIdx].id);
              }
              branchEvents.push({ from_block_id: b.id, action: 'skip_to', target: rule.target });
            }
            break;
          } else if (rule.action === 'hide_block' && rule.target) {
            skippedBlockIds.add(rule.target);
            branchEvents.push({ from_block_id: b.id, action: 'hide_block', target: rule.target });
          } else if (rule.action === 'end_survey' || rule.action === 'end_survey_screen') {
            for (let skipIdx = idx + 1; skipIdx < blocks.length; skipIdx++) {
              skippedBlockIds.add(blocks[skipIdx].id);
            }
            endedEarly = true;
            branchEvents.push({ from_block_id: b.id, action: rule.action, target: rule.target });
            break;
          }
        }
        if (endedEarly) break;
      }

      // Compute Quiz score, NPS classification, and Tags on active (non-skipped) blocks
      let quizScore = Number(settings.base_lead_score || 0);
      let maxQuizScore = 0;
      let npsScore: number | null = null;
      let npsClassification: 'Promoter' | 'Passive' | 'Detractor' | null = null;
      const tagsToApply = new Set<string>(
        Array.isArray(settings.auto_tags) ? (settings.auto_tags as string[]) : []
      );
      if (settings.auto_tag && String(settings.auto_tag).trim()) {
        tagsToApply.add(String(settings.auto_tag).trim());
      }

      for (const b of blocks) {
        if (skippedBlockIds.has(b.id)) continue;
        const val = answers[b.id];
        const blockPoints = Number(b.points ?? b.quizPoints ?? 0);
        if (blockPoints > 0) maxQuizScore += blockPoints;
        else if (Array.isArray(b.options)) {
          const maxOptPts = b.options.reduce((mx, o) => Math.max(mx, Number(o.points || 0)), 0);
          if (maxOptPts > 0) maxQuizScore += maxOptPts;
        }
        if (val === undefined || val === null || val === '') continue;

        if (b.type === 'nps') {
          const n = Math.min(10, Math.max(0, Math.round(Number(val))));
          if (Number.isFinite(n)) {
            npsScore = n;
            if (n >= 9) {
              npsClassification = 'Promoter';
              quizScore += 15;
              tagsToApply.add('NPS Promoter');
            } else if (n >= 7) {
              npsClassification = 'Passive';
              tagsToApply.add('NPS Passive');
            } else {
              npsClassification = 'Detractor';
              tagsToApply.add('NPS Detractor');
            }
          }
        } else if (b.type === 'csat_stars' || b.type === 'star_rating') {
          const stars = Math.round(Number(val));
          if (stars >= 4) quizScore += 10;
        } else if (b.type === 'quiz_scored' || b.correctValue !== undefined || b.correctAnswer !== undefined) {
          const expectedAns = b.correctValue !== undefined ? b.correctValue : b.correctAnswer;
          if (expectedAns !== undefined && String(val).trim().toLowerCase() === String(expectedAns).trim().toLowerCase()) {
            quizScore += Number(b.points ?? b.quizPoints ?? 10);
          } else if (Array.isArray(b.options)) {
            const opt = b.options.find(
              (o) => String(o.value ?? o.label) === String(val) || String(o.label) === String(val)
            );
            if (opt?.points) quizScore += Number(opt.points);
          }
        } else if (Array.isArray(b.options)) {
          const selectedVals = Array.isArray(val) ? val.map(String) : [String(val)];
          for (const sv of selectedVals) {
            const opt = b.options.find(
              (o) => String(o.value ?? o.label) === sv || String(o.label) === sv
            );
            if (opt?.points) quizScore += Number(opt.points);
          }
        }

        if (b.tagOnAnswer) {
          tagsToApply.add(String(b.tagOnAnswer).trim());
        }
      }

      // Match Score Tiers / Redirect Rules
      const redirectRules = parseJsonCol<Array<Record<string, unknown>>>(surveyRow.redirect_rules_json, []);
      const baseThankYou = parseJsonCol<Record<string, unknown>>(surveyRow.thank_you_json, {});
      let matchedTierLabel: string | null = null;
      let matchedRedirectUrl: string | null = settings.custom_redirect_url
        ? String(settings.custom_redirect_url)
        : null;
      let matchedThankYou: Record<string, unknown> = { ...baseThankYou };
      let rewardVoucherPoolId: string | null = settings.reward_voucher_campaign_id
        ? String(settings.reward_voucher_campaign_id)
        : null;

      for (const rule of redirectRules) {
        const minSc = Number(rule.minScore ?? rule.min_score ?? -999999);
        const maxSc = Number(rule.maxScore ?? rule.max_score ?? 999999);
        if (quizScore >= minSc && quizScore <= maxSc) {
          if (rule.label || rule.tier_label || rule.name) {
            matchedTierLabel = String(rule.label || rule.tier_label || rule.name);
          }
          if (rule.redirectUrl || rule.redirect_url) {
            matchedRedirectUrl = String(rule.redirectUrl || rule.redirect_url);
          }
          if (rule.thankYouTitle || rule.thank_you_title) {
            matchedThankYou = {
              ...matchedThankYou,
              title: String(rule.thankYouTitle || rule.thank_you_title),
              message: String(rule.thankYouMessage || rule.thank_you_message || matchedThankYou.message || ''),
            };
          }
          if (rule.assignTag || rule.assign_tag) {
            tagsToApply.add(String(rule.assignTag || rule.assign_tag).trim());
          }
          if (rule.voucherCampaignId || rule.voucher_campaign_id || rule.reward_voucher_campaign_id) {
            rewardVoucherPoolId = String(
              rule.voucherCampaignId || rule.voucher_campaign_id || rule.reward_voucher_campaign_id
            );
          }
          break;
        }
      }

      let leadId: string | null = null;
      if (settings.create_crm_lead !== false && (contactPhone || contactEmail)) {
        const upserted = await upsertMasterContactInTx(
          client,
          ctx.tenantId,
          {
            name: contactName,
            phone: contactPhone || undefined,
            email: contactEmail || undefined,
            source: `Survey: ${surveyRow.title}`,
          },
          {
            defaultStatus: 'marketing_nurture',
            defaultSource: `Survey: ${surveyRow.title}`,
            dialCode: cfg.default_dial_code,
          }
        );
        leadId = upserted.leadId;

        if (quizScore !== 0) {
          await client.query(
            `UPDATE leads
             SET lead_score = lead_score + $3,
                 last_engaged_at = clock_timestamp(),
                 updated_at = clock_timestamp()
             WHERE tenant_id = $1 AND id = $2`,
            [ctx.tenantId, leadId, quizScore]
          );
        }

        for (const rawTag of tagsToApply) {
          const tSlug = slugifyMarketingKey(rawTag, 'survey-tag');
          await client.query(
            `INSERT INTO tenant_tags (id, tenant_id, name, slug, color_hex, category)
             VALUES ($1, $2, $3, $4, '#1E40FF', 'survey')
             ON CONFLICT (tenant_id, slug) DO NOTHING`,
            [crypto.randomUUID(), ctx.tenantId, rawTag, tSlug]
          );
          const tagRow = await client.query<{ id: string }>(
            'SELECT id FROM tenant_tags WHERE tenant_id = $1 AND slug = $2 LIMIT 1',
            [ctx.tenantId, tSlug]
          );
          if (tagRow.rows[0]?.id) {
            await client.query(
              `INSERT INTO lead_tags (id, tenant_id, lead_id, tag_id)
               VALUES ($1, $2, $3, $4)
               ON CONFLICT (tenant_id, lead_id, tag_id) DO NOTHING`,
              [crypto.randomUUID(), ctx.tenantId, leadId, tagRow.rows[0].id]
            );
          }
        }

        if (settings.target_audience_id) {
          await client.query(
            `INSERT INTO tenant_audience_members (id, tenant_id, audience_id, lead_id, source_type, metadata)
             VALUES ($1, $2, $3, $4, 'survey', '{}'::jsonb)
             ON CONFLICT (tenant_id, audience_id, lead_id) DO NOTHING`,
            [crypto.randomUUID(), ctx.tenantId, String(settings.target_audience_id), leadId]
          );
          await refreshAudienceCachedCount(client, ctx.tenantId, String(settings.target_audience_id));
        }

        await client.query(
          `INSERT INTO lead_timeline_events (
             id, tenant_id, lead_id, event_type, event_category, actor_role, actor_name, title, content, metadata
           ) VALUES ($1, $2, $3, 'survey_completed', 'communication', 'tenant_admin', $4, $5, $6, $7::jsonb)`,
          [
            crypto.randomUUID(),
            ctx.tenantId,
            leadId,
            `Survey: ${surveyRow.title}`,
            `Hoàn thành khảo sát "${surveyRow.title}" (+${quizScore} Lead Score)`,
            npsScore !== null ? `NPS: ${npsScore}/10 (${npsClassification})` : `Điểm Quiz: ${quizScore}`,
            JSON.stringify({
              survey_id: surveyRow.id,
              quiz_score: quizScore,
              nps_score: npsScore,
              nps_classification: npsClassification,
              score_tier: matchedTierLabel,
            }),
          ]
        );
      }

      // Issue Reward Voucher Code if configured
      let rewardVoucherCode: string | null = null;
      if (rewardVoucherPoolId) {
        const vpRes = await client.query<{ id: string; code_prefix: string }>(
          'SELECT id, code_prefix FROM mkt_voucher_campaigns WHERE tenant_id = $1 AND id = $2 LIMIT 1',
          [ctx.tenantId, rewardVoucherPoolId]
        );
        if (vpRes.rows[0]) {
          // Prefer claiming an available pool code first; otherwise mint fresh prefixed code
          const availRes = await client.query<{ id: string; code: string }>(
            `SELECT id, code FROM mkt_voucher_codes
             WHERE tenant_id = $1 AND voucher_campaign_id = $2 AND status = 'available'
             ORDER BY created_at ASC
             LIMIT 1`,
            [ctx.tenantId, vpRes.rows[0].id]
          );
          if (availRes.rows[0]) {
            rewardVoucherCode = String(availRes.rows[0].code);
            await client.query(
              `UPDATE mkt_voucher_codes
               SET status = 'claimed', lead_id = COALESCE($3, lead_id), claimed_at = clock_timestamp()
               WHERE tenant_id = $1 AND id = $2`,
              [ctx.tenantId, availRes.rows[0].id, leadId]
            );
            await client.query(
              'UPDATE mkt_voucher_campaigns SET claimed_codes = claimed_codes + 1 WHERE tenant_id = $1 AND id = $2',
              [ctx.tenantId, vpRes.rows[0].id]
            );
          } else {
            rewardVoucherCode = `${String(vpRes.rows[0].code_prefix || 'DOM').toUpperCase()}-${generateShortCode(6).toUpperCase()}`;
            await client.query(
              `INSERT INTO mkt_voucher_codes (id, tenant_id, voucher_campaign_id, code, status, lead_id, claimed_at)
               VALUES ($1, $2, $3, $4, 'claimed', $5, clock_timestamp())
               ON CONFLICT (tenant_id, code) DO NOTHING`,
              [crypto.randomUUID(), ctx.tenantId, vpRes.rows[0].id, rewardVoucherCode, leadId]
            );
            await client.query(
              'UPDATE mkt_voucher_campaigns SET total_codes = total_codes + 1, claimed_codes = claimed_codes + 1 WHERE tenant_id = $1 AND id = $2',
              [ctx.tenantId, vpRes.rows[0].id]
            );
          }
        }
      }

      const respId = crypto.randomUUID();
      const appliedTagsArr = Array.from(tagsToApply);
      await client.query(
        `INSERT INTO mkt_survey_responses (
           id, tenant_id, survey_id, lead_id, answers_json, quiz_score, nps_score, tags_applied, client_ip
         ) VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7, $8::jsonb, $9)`,
        [
          respId,
          ctx.tenantId,
          surveyRow.id,
          leadId,
          JSON.stringify(answers),
          quizScore,
          npsScore,
          JSON.stringify(appliedTagsArr),
          clientIp || null,
        ]
      );

      const aggRes = await client.query<{ cnt: number; avg_sc: number }>(
        `SELECT COUNT(*)::int AS cnt, COALESCE(AVG(quiz_score), 0) AS avg_sc
         FROM mkt_survey_responses
         WHERE tenant_id = $1 AND survey_id = $2`,
        [ctx.tenantId, surveyRow.id]
      );
      await client.query(
        `UPDATE mkt_surveys
         SET response_count = $3,
             avg_score = $4,
             updated_at = clock_timestamp()
         WHERE tenant_id = $1 AND id = $2`,
        [
          ctx.tenantId,
          surveyRow.id,
          Number(aggRes.rows[0]?.cnt || 1),
          Number(Number(aggRes.rows[0]?.avg_sc || 0).toFixed(2)),
        ]
      );

      const finalRedirectUrl =
        matchedRedirectUrl && settings.append_redirect_params !== false
          ? appendSurveyRedirectQuery(matchedRedirectUrl, {
              score: quizScore,
              voucher: rewardVoucherCode,
              nps: npsScore,
              tier: matchedTierLabel,
            })
          : matchedRedirectUrl;

      return {
        errorStatus: null,
        errorCode: null,
        errorMessage: null,
        response_id: respId,
        lead_id: leadId,
        quiz_score: quizScore,
        max_quiz_score: maxQuizScore,
        score_tier: matchedTierLabel,
        nps_score: npsScore,
        nps_classification: npsClassification,
        tags_applied: appliedTagsArr,
        voucher_code: rewardVoucherCode,
        reward_voucher_code: rewardVoucherCode,
        redirect_url: finalRedirectUrl,
        thank_you: matchedThankYou,
        skipped_block_ids: Array.from(skippedBlockIds),
        branch_events: branchEvents,
        emit_flow_trigger: settings.emit_flow_trigger !== false,
      };
    });

    if (txOut.errorCode) {
      sendApiError(res, txOut.errorStatus || 400, txOut.errorCode, txOut.errorMessage || 'Không thể nộp Khảo sát.');
      return;
    }

    if (txOut.lead_id && txOut.emit_flow_trigger) {
      await emitDomainEvent('marketing.engaged', {
        tenantId: ctx.tenantId,
        leadId: txOut.lead_id,
        engagementType: 'survey_completed',
        channel: 'survey',
        scoreDelta: txOut.quiz_score,
        metadata: {
          surveyId: req.params.id,
          quizScore: txOut.quiz_score,
          npsScore: txOut.nps_score,
          npsClassification: txOut.nps_classification,
          voucherCode: txOut.voucher_code,
        },
      });
    }

    res.status(201).json({ success: true, data: txOut });
  } catch (err: any) {
    sendApiError(res, 500, 'SUBMIT_SURVEY_FAILED', err?.message || 'Không thể xử lý nộp bài Khảo sát.');
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
    const isRespondentsAction = String(req.query.action || '').toLowerCase() === 'respondents';

    const data = await withTenantTransaction(ctx.tenantId, async (client) => {
      const srvRes = await client.query('SELECT * FROM mkt_surveys WHERE tenant_id = $1 AND id = $2 LIMIT 1', [
        ctx.tenantId,
        req.params.id,
      ]);
      const srv = srvRes.rows[0];
      if (!srv) return null;

      const survey = mapSurveyRow(srv);
      const canUnmask = await canUserUnmaskMarketingPii(client, ctx.tenantId, ctx.userId);
      const respRes = await client.query(
        `SELECT r.*, l.name, l.phone, l.email, l.lead_score
         FROM mkt_survey_responses r
         LEFT JOIN leads l ON l.tenant_id = r.tenant_id AND l.id = r.lead_id
         WHERE r.tenant_id = $1 AND r.survey_id = $2
         ORDER BY r.created_at DESC
         LIMIT 500`,
        [ctx.tenantId, req.params.id]
      );

      let promoters = 0;
      let passives = 0;
      let detractors = 0;
      let npsCount = 0;
      let totalQuizScore = 0;
      const channelCounts = { direct_count: 0, qr_count: 0, email_count: 0, widget_count: 0, api_count: 0 };
      const deviceCounts = { desktop_count: 0, mobile_count: 0, tablet_count: 0 };
      const byDateMap: Record<string, number> = {};

      const parsedResponses = respRes.rows.map((row) => {
        const quizScore = Number(row.quiz_score || 0);
        totalQuizScore += quizScore;
        if (row.nps_score !== null && row.nps_score !== undefined) {
          const nps = Number(row.nps_score);
          npsCount++;
          if (nps >= 9) promoters++;
          else if (nps >= 7) passives++;
          else detractors++;
        }

        const ch = String(row.source_channel || 'direct').toLowerCase();
        if (ch.includes('email')) channelCounts.email_count++;
        else if (ch.includes('qr')) channelCounts.qr_count++;
        else if (ch.includes('widget')) channelCounts.widget_count++;
        else if (ch.includes('api')) channelCounts.api_count++;
        else channelCounts.direct_count++;

        const dev = String(row.device_type || 'Desktop').toLowerCase();
        if (dev.includes('mobile')) deviceCounts.mobile_count++;
        else if (dev.includes('tablet')) deviceCounts.tablet_count++;
        else deviceCounts.desktop_count++;

        const dtStr =
          row.created_at instanceof Date ? row.created_at.toISOString() : String(row.created_at || '');
        const dateKey = dtStr.slice(0, 10);
        if (dateKey) byDateMap[dateKey] = (byDateMap[dateKey] || 0) + 1;

        const masked = maskContactPiiIfDisallowed(row, canUnmask, cfg);
        const { answers_json: _rawAnswersJson, ...safeMasked } = masked as Record<string, unknown>;
        const rawAnswers = parseJsonCol<Record<string, unknown>>(row.answers_json, {});
        return {
          ...safeMasked,
          answers: rawAnswers,
          tags_applied: parseJsonCol<string[]>(row.tags_applied, []),
          quiz_score: quizScore,
          nps_score: row.nps_score !== null && row.nps_score !== undefined ? Number(row.nps_score) : null,
        };
      });

      const { analyticsQuestions } = buildSurveyQuestionStatsAndAnalytics(survey, parsedResponses);
      const responses = parsedResponses.map((r) => ({
        ...r,
        answers: formatSurveyRespondentAnswers(r.answers, survey, isRespondentsAction),
      }));

      const npsIndex = npsCount > 0 ? Math.round(((promoters - detractors) / npsCount) * 100) : 0;
      const avgQuizScore = responses.length > 0 ? Number((totalQuizScore / responses.length).toFixed(1)) : 0;
      const totalResponses = Math.max(Number(srv.response_count || 0), responses.length);
      const byDate = Object.entries(byDateMap)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([date, count]) => ({ date, count }));

      return {
        survey,
        summary: {
          total_responses: totalResponses,
          avg_quiz_score: avgQuizScore,
          nps_index: npsIndex,
          promoters,
          passives,
          detractors,
        },
        overview: {
          total_responses: totalResponses,
          avg_completion_rate: totalResponses > 0 ? 100 : 0,
          avg_time_spent_sec: 0,
          nps_score: npsCount > 0 ? npsIndex : undefined,
          promoters,
          passives,
          detractors,
          ...channelCounts,
          ...deviceCounts,
        },
        questions: analyticsQuestions,
        by_date: byDate,
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

// SurveyReportModal: Cross-Tab Per-Question Breakdown + Score Histogram + Respondent CSV Export
surveysRouter.get('/:id/report', requirePermission('mkt_surveys', 'view'), async (req, res) => {
  try {
    const ctx = getTenantContext();
    const cfg = await getTenantSettingsCached(ctx.tenantId);

    const data = await withTenantTransaction(ctx.tenantId, async (client) => {
      const srvRes = await client.query('SELECT * FROM mkt_surveys WHERE tenant_id = $1 AND id = $2 LIMIT 1', [
        ctx.tenantId,
        req.params.id,
      ]);
      const srvRow = srvRes.rows[0];
      if (!srvRow) return null;

      const canUnmask = await canUserUnmaskMarketingPii(client, ctx.tenantId, ctx.userId);
      const respRes = await client.query(
        `SELECT r.*, l.name, l.phone, l.email
         FROM mkt_survey_responses r
         LEFT JOIN leads l ON l.tenant_id = r.tenant_id AND l.id = r.lead_id
         WHERE r.tenant_id = $1 AND r.survey_id = $2
         ORDER BY r.created_at DESC
         LIMIT 500`,
        [ctx.tenantId, req.params.id]
      );

      const survey = mapSurveyRow(srvRow);
      const parsedResponses = respRes.rows.map((row) => {
        const masked = maskContactPiiIfDisallowed(row, canUnmask, cfg);
        const { answers_json: _rawAnswersJson, ...safeMasked } = masked as Record<string, unknown>;
        return {
          ...safeMasked,
          answers: parseJsonCol<Record<string, unknown>>(row.answers_json, {}),
          tags_applied: parseJsonCol<string[]>(row.tags_applied, []),
          quiz_score: Number(row.quiz_score || 0),
          nps_score: row.nps_score !== null && row.nps_score !== undefined ? Number(row.nps_score) : null,
        };
      });

      const { questionStats } = buildSurveyQuestionStatsAndAnalytics(survey, parsedResponses);
      const responses = parsedResponses.map((r) => ({
        ...r,
        answers: formatSurveyRespondentAnswers(r.answers, survey, false),
      }));

      return {
        survey,
        total_responses: responses.length,
        question_stats: questionStats,
        responses,
      };
    });

    if (!data) {
      sendApiError(res, 404, 'SURVEY_NOT_FOUND', 'Không tìm thấy Khảo sát.');
      return;
    }
    res.json({ success: true, data });
  } catch (err: any) {
    sendApiError(res, 500, 'SURVEY_REPORT_FAILED', err?.message || 'Không thể tải báo cáo chéo Khảo sát.');
  }
});

surveysRouter.get('/:id/export.csv', requirePermission('mkt_surveys', 'export'), async (req, res) => {
  try {
    const ctx = getTenantContext();
    const cfg = await getTenantSettingsCached(ctx.tenantId);

    const csvOut = await withTenantTransaction(ctx.tenantId, async (client) => {
      const srvRes = await client.query('SELECT * FROM mkt_surveys WHERE tenant_id = $1 AND id = $2 LIMIT 1', [
        ctx.tenantId,
        req.params.id,
      ]);
      if (!srvRes.rows[0]) return null;

      const survey = mapSurveyRow(srvRes.rows[0]);
      const canUnmask = await canUserUnmaskMarketingPii(client, ctx.tenantId, ctx.userId);
      const respRes = await client.query(
        `SELECT r.*, l.name, l.phone, l.email
         FROM mkt_survey_responses r
         LEFT JOIN leads l ON l.tenant_id = r.tenant_id AND l.id = r.lead_id
         WHERE r.tenant_id = $1 AND r.survey_id = $2
         ORDER BY r.created_at DESC`,
        [ctx.tenantId, req.params.id]
      );

      const qBlocks = survey.blocks.filter((b) => !NON_QUESTION_BLOCK_TYPES.has(b.type));
      const blockMapsById = new Map(qBlocks.map((q) => [q.id, buildSurveyBlockLabelMaps(q)]));
      const esc = (v: unknown) => `"${String(v ?? '').replace(/"/g, '""')}"`;
      const header = ['Thời gian', 'Họ tên', 'SĐT', 'Email', 'Điểm Quiz', 'NPS', ...qBlocks.map((q) => q.label)];
      const lines = [header.map(esc).join(',')];

      for (const row of respRes.rows) {
        const masked = maskContactPiiIfDisallowed(row, canUnmask, cfg);
        const ans = parseJsonCol<Record<string, unknown>>(row.answers_json, {});
        const cols = [
          row.created_at,
          masked.name || '',
          masked.phone || '',
          masked.email || '',
          row.quiz_score ?? 0,
          row.nps_score ?? '',
          ...qBlocks.map((q) => {
            const maps = blockMapsById.get(q.id) || buildSurveyBlockLabelMaps(q);
            return formatSurveyAnswerForCsv(ans[q.id], q, maps);
          }),
        ];
        lines.push(cols.map(esc).join(','));
      }

      return `\uFEFF${lines.join('\n')}`;
    });

    if (csvOut === null) {
      sendApiError(res, 404, 'SURVEY_NOT_FOUND', 'Không tìm thấy Khảo sát.');
      return;
    }

    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="survey-${req.params.id}.csv"`);
    res.send(csvOut);
  } catch (err: any) {
    sendApiError(res, 500, 'EXPORT_SURVEY_CSV_FAILED', err?.message || 'Không thể xuất CSV Khảo sát.');
  }
});
