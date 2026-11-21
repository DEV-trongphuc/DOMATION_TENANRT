import crypto from 'node:crypto';
import type { DbClient } from '../../core/database/db-adapter.ts';
import { encryptTenantSecret, decryptTenantSecret } from '../../core/crypto/vault.ts';
import { tenantRedis } from '../../core/cache/tenant-redis.ts';
import { isOutboundSilentMode } from '../../core/security/outbound-guard.ts';
import {
  DEFAULT_PORTAL_MODEL,
  DEFAULT_PORTAL_SYSTEM_INSTRUCTION,
  parseJsonArray,
  parseJsonObject,
} from './schema.ts';

export interface DomAiChunkDraft {
  chunk_index: number;
  content: string;
  keywords_text: string;
  token_estimate: number;
}

export interface DomAiCitation {
  chunk_id: string;
  document_id: string;
  title: string;
  doc_type: string;
  collection_id: string | null;
  collection_name: string | null;
  snippet: string;
  score: number;
  attachment_url?: string | null;
  thumbnail_url?: string | null;
}

export interface DomAiSearchOptions {
  portalId: string;
  query: string;
  topK?: number;
  collectionFilterId?: string | null;
  allowedCollectionIds?: string[] | null;
  includePrivateCollections?: boolean;
}

export interface DomAiSearchResult {
  query: string;
  normalized_query: string;
  total_candidates: number;
  filtered_by_acl: number;
  citations: DomAiCitation[];
}

export interface PortalGeminiByokResolution {
  apiKey: string | null;
  modelOverride?: string;
  keyHint: string | null;
  source: 'portal_vault' | 'tenant_vault' | 'legacy_settings' | 'none';
}

export interface PortalRecord {
  id: string;
  tenant_id: string;
  slug: string;
  name: string;
  tagline: string;
  logo_url: string;
  primary_color: string;
  welcome_message: string;
  system_instruction: string;
  starter_prompts_json: unknown;
  auth_mode: string;
  allow_guest_history: boolean;
  model: string;
  temperature: number;
  top_k: number;
  is_active: boolean;
  is_free_byok: boolean;
  metadata_json: unknown;
}

export interface PortalChatViewerContext {
  portalUserId: string | null;
  email: string;
  fullName: string;
  role: 'admin' | 'viewer' | 'guest';
  isGuest: boolean;
  allowedCollectionIds: string[];
}

const GENERIC_STOPWORDS = new Set([
  // Vietnamese common function words
  'va',
  'cua',
  'cho',
  'cac',
  'nhung',
  'trong',
  'ngoai',
  'voi',
  'duoc',
  'khong',
  'nay',
  'kia',
  'khi',
  'neu',
  'thi',
  'la',
  'co',
  'mot',
  'theo',
  'tren',
  'duoi',
  'den',
  'tu',
  'tai',
  've',
  'the',
  'nao',
  'bao',
  'nhieu',
  'toi',
  'em',
  'anh',
  'chi',
  'ban',
  'xin',
  'hoi',
  'xem',
  'giup',
  'biet',
  'nhu',
  'hay',
  'hoac',
  'de',
  'da',
  'dang',
  'se',
  'bi',
  'boi',
  'vi',
  'nen',
  'ma',
  'rat',
  'qua',
  'cung',
  'con',
  'can',
  'phai',
  'lam',
  'sao',
  'gi',
  'dau',
  // English common function words
  'the',
  'and',
  'for',
  'with',
  'that',
  'this',
  'from',
  'are',
  'was',
  'were',
  'have',
  'has',
  'had',
  'can',
  'could',
  'what',
  'how',
  'where',
  'when',
  'who',
  'why',
  'please',
  'about',
  'into',
  'your',
  'our',
]);

export function stripHtmlPreservingStructure(raw: string): string {
  if (!raw) return '';
  return String(raw)
    .replace(/<\s*br\s*\/?>/gi, '\n')
    .replace(/<\/\s*(p|div|li|tr|h1|h2|h3|h4|h5|h6|section|article)\s*>/gi, '\n')
    .replace(/<\s*li[^>]*>/gi, '- ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/\r\n/g, '\n')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export function normalizeVietnameseFolded(input: string): string {
  return String(input || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/đ/gi, 'd')
    .toLowerCase()
    .replace(/[^a-z0-9%./\-\s]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function tokenizeFolded(folded: string): string[] {
  if (!folded) return [];
  const rawTokens = folded
    .split(/\s+/)
    .map((t) => t.replace(/^[./\-]+|[./\-]+$/g, ''))
    .filter(Boolean);

  const out: string[] = [];
  for (const tok of rawTokens) {
    if (tok.length >= 2) {
      out.push(tok);
    }
    // Also index sub-parts of slash/hyphen/dot codes (e.g. "24/2026/csbh" -> "24", "2026", "csbh")
    if (/[./\-]/.test(tok)) {
      for (const sub of tok.split(/[./\-]+/)) {
        if (sub.length >= 2 && sub !== tok) {
          out.push(sub);
        }
      }
    }
  }
  return out;
}

export function extractDomAiKeywords(text: string): string[] {
  const folded = normalizeVietnameseFolded(text);
  if (!folded) return [];
  const tokens = tokenizeFolded(folded);
  const unique = new Set<string>();
  for (const tok of tokens) {
    if ((tok.length >= 2 && !GENERIC_STOPWORDS.has(tok)) || /\d/.test(tok)) {
      unique.add(tok);
    }
    if (unique.size >= 120) break;
  }
  return Array.from(unique);
}

/**
 * Smart Markdown/paragraph/section-aware chunker for Enterprise Knowledge RAG.
 * Preserves active heading context across splits and uses controlled overlap on long passages.
 */
export function chunkDomAiDocument(
  title: string,
  rawContent: string,
  tags: string[] = [],
  maxChunkChars = 950,
  overlapChars = 140
): DomAiChunkDraft[] {
  const cleaned = stripHtmlPreservingStructure(rawContent);
  const tagLine = tags.filter(Boolean).join(' ');

  if (!cleaned) {
    const fallback = title.trim() || 'Tài liệu tri thức';
    return [
      {
        chunk_index: 0,
        content: fallback,
        keywords_text: extractDomAiKeywords(`${title} ${tagLine} ${fallback}`).join(' '),
        token_estimate: Math.max(1, Math.ceil(fallback.length / 4)),
      },
    ];
  }

  // Split by blank lines or before Markdown headings while tracking active section heading
  const blocks: Array<{ heading: string; text: string }> = [];
  const lines = cleaned.split('\n');
  let activeHeading = '';
  let currentParaLines: string[] = [];

  const flushPara = () => {
    const joined = currentParaLines.join('\n').trim();
    if (joined) {
      blocks.push({ heading: activeHeading, text: joined });
    }
    currentParaLines = [];
  };

  for (const line of lines) {
    const trimmed = line.trim();
    if (/^#{1,4}\s+/.test(trimmed)) {
      flushPara();
      activeHeading = trimmed.replace(/^#{1,4}\s+/, '').trim();
      currentParaLines.push(trimmed);
      continue;
    }
    if (trimmed === '') {
      flushPara();
      continue;
    }
    currentParaLines.push(line);
  }
  flushPara();

  const rawChunks: string[] = [];
  let buffer = '';

  const flushBuffer = () => {
    if (buffer.trim()) {
      rawChunks.push(buffer.trim());
      buffer = '';
    }
  };

  for (const blk of blocks) {
    const piece = blk.text;
    if (piece.length > maxChunkChars) {
      flushBuffer();
      const headingPrefix =
        blk.heading && !piece.startsWith('#') ? `[${blk.heading}]\n` : '';
      const effectiveMax = Math.max(250, maxChunkChars - headingPrefix.length);
      let cursor = 0;
      while (cursor < piece.length) {
        const end = Math.min(cursor + effectiveMax, piece.length);
        let breakAt = end;
        if (end < piece.length) {
          const slice = piece.slice(cursor, end);
          for (const sep of ['\n', '. ', '; ', '! ', '? ']) {
            const idx = slice.lastIndexOf(sep);
            if (idx > effectiveMax * 0.45) {
              breakAt = cursor + idx + sep.length;
              break;
            }
          }
        }
        const chunkBody = piece.slice(cursor, breakAt).trim();
        if (chunkBody) {
          rawChunks.push(`${cursor > 0 ? headingPrefix : ''}${chunkBody}`.trim());
        }
        if (breakAt >= piece.length) break;
        const step = Math.max(120, breakAt - cursor - overlapChars);
        cursor += step;
      }
      continue;
    }

    if (!buffer) {
      buffer = piece;
    } else if (buffer.length + 2 + piece.length <= maxChunkChars) {
      buffer = `${buffer}\n\n${piece}`;
    } else {
      flushBuffer();
      const prefix =
        blk.heading && !piece.startsWith('#') && !piece.includes(blk.heading)
          ? `[${blk.heading}]\n`
          : '';
      buffer = `${prefix}${piece}`;
    }
  }
  flushBuffer();

  if (rawChunks.length === 0) {
    rawChunks.push(cleaned.slice(0, maxChunkChars));
  }

  return rawChunks.map((chunkText, idx) => ({
    chunk_index: idx,
    content: chunkText,
    keywords_text: extractDomAiKeywords(`${title} ${tagLine} ${chunkText}`).join(' '),
    token_estimate: Math.max(1, Math.ceil(chunkText.length / 4)),
  }));
}

export async function recomputeCollectionDocCountsInTx(
  client: DbClient,
  tenantId: string,
  portalId: string
): Promise<void> {
  const countsRes = await client.query<{ collection_id: string; cnt: string | number }>(
    `SELECT collection_id, COUNT(*) AS cnt
     FROM dom_ai_documents
     WHERE tenant_id = $1 AND portal_id = $2 AND status = 'active' AND collection_id IS NOT NULL
     GROUP BY collection_id`,
    [tenantId, portalId]
  );

  const countMap = new Map<string, number>();
  for (const row of countsRes.rows) {
    if (row.collection_id) {
      countMap.set(String(row.collection_id), Number(row.cnt || 0));
    }
  }

  const colsRes = await client.query<{ id: string }>(
    `SELECT id FROM dom_ai_collections WHERE tenant_id = $1 AND portal_id = $2`,
    [tenantId, portalId]
  );

  for (const col of colsRes.rows) {
    const nextCount = countMap.get(String(col.id)) || 0;
    await client.query(
      `UPDATE dom_ai_collections
       SET doc_count = $3, updated_at = clock_timestamp()
       WHERE tenant_id = $1 AND id = $2`,
      [tenantId, col.id, nextCount]
    );
  }
}

export async function indexDomAiDocumentInTx(
  client: DbClient,
  tenantId: string,
  documentId: string
): Promise<{ document_id: string; chunk_count: number }> {
  const docRes = await client.query<{
    id: string;
    portal_id: string;
    collection_id: string | null;
    title: string;
    content: string;
    summary: string;
    tags_json: unknown;
    status: string;
  }>(
    `SELECT id, portal_id, collection_id, title, content, summary, tags_json, status
     FROM dom_ai_documents
     WHERE tenant_id = $1 AND id = $2
     LIMIT 1`,
    [tenantId, documentId]
  );

  const doc = docRes.rows[0];
  if (!doc) {
    throw new Error('DOM_AI_DOCUMENT_NOT_FOUND');
  }

  await client.query(
    `DELETE FROM dom_ai_chunks WHERE tenant_id = $1 AND document_id = $2`,
    [tenantId, documentId]
  );

  if (doc.status !== 'active') {
    await client.query(
      `UPDATE dom_ai_documents
       SET chunk_count = 0, updated_at = clock_timestamp()
       WHERE tenant_id = $1 AND id = $2`,
      [tenantId, documentId]
    );
    return { document_id: documentId, chunk_count: 0 };
  }

  const tags = parseJsonArray<string>(doc.tags_json).map((t) => String(t || '').trim()).filter(Boolean);
  const fullText = [doc.summary?.trim(), doc.content?.trim()].filter(Boolean).join('\n\n');
  const chunks = chunkDomAiDocument(doc.title, fullText || doc.title, tags);

  for (const ch of chunks) {
    await client.query(
      `INSERT INTO dom_ai_chunks (
         id, tenant_id, portal_id, document_id, collection_id,
         chunk_index, content, keywords_text, token_estimate
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [
        crypto.randomUUID(),
        tenantId,
        doc.portal_id,
        doc.id,
        doc.collection_id || null,
        ch.chunk_index,
        ch.content,
        ch.keywords_text,
        ch.token_estimate,
      ]
    );
  }

  await client.query(
    `UPDATE dom_ai_documents
     SET chunk_count = $3, updated_at = clock_timestamp()
     WHERE tenant_id = $1 AND id = $2`,
    [tenantId, documentId, chunks.length]
  );

  return { document_id: documentId, chunk_count: chunks.length };
}

export async function reindexPortalDocumentsInTx(
  client: DbClient,
  tenantId: string,
  portalId: string
): Promise<{ documents_indexed: number; total_chunks: number }> {
  const docsRes = await client.query<{ id: string }>(
    `SELECT id FROM dom_ai_documents WHERE tenant_id = $1 AND portal_id = $2`,
    [tenantId, portalId]
  );

  let totalChunks = 0;
  for (const row of docsRes.rows) {
    const out = await indexDomAiDocumentInTx(client, tenantId, String(row.id));
    totalChunks += out.chunk_count;
  }
  await recomputeCollectionDocCountsInTx(client, tenantId, portalId);

  return {
    documents_indexed: docsRes.rows.length,
    total_chunks: totalChunks,
  };
}

/**
 * Hybrid Vietnamese Diacritic-Insensitive RAG Retrieval with Collection ACL enforcement.
 * Scores chunks by exact phrase match, IDF-weighted token overlap, bigram proximity,
 * title boost, tag boost, collection boost, and document relevance_boost.
 */
export async function searchDomAiKnowledgeInTx(
  client: DbClient,
  tenantId: string,
  options: DomAiSearchOptions
): Promise<DomAiSearchResult> {
  const rawQuery = String(options.query || '').trim();
  const foldedQuery = normalizeVietnameseFolded(rawQuery);
  const topK = Math.max(1, Math.min(20, Number(options.topK || 6)));

  if (!foldedQuery) {
    return {
      query: rawQuery,
      normalized_query: '',
      total_candidates: 0,
      filtered_by_acl: 0,
      citations: [],
    };
  }

  const allTokens = tokenizeFolded(foldedQuery);
  const meaningfulTokens = Array.from(
    new Set(allTokens.filter((t) => !GENERIC_STOPWORDS.has(t) || /\d/.test(t)))
  );
  const queryTokens = (meaningfulTokens.length > 0 ? meaningfulTokens : Array.from(new Set(allTokens))).slice(0, 18);

  const bigrams: string[] = [];
  for (let i = 0; i < queryTokens.length - 1; i++) {
    bigrams.push(`${queryTokens[i]} ${queryTokens[i + 1]}`);
  }

  const rowsRes = await client.query<{
    chunk_id: string;
    document_id: string;
    collection_id: string | null;
    chunk_index: number;
    chunk_content: string;
    keywords_text: string;
    doc_title: string;
    doc_type: string;
    doc_tags_json: unknown;
    doc_relevance_boost: string | number;
    doc_attachment_url: string;
    doc_thumbnail_url: string;
    collection_name: string | null;
    collection_is_public: boolean | number | null;
  }>(
    `SELECT
       c.id AS chunk_id,
       c.document_id,
       d.collection_id,
       c.chunk_index,
       c.content AS chunk_content,
       c.keywords_text,
       d.title AS doc_title,
       d.doc_type,
       d.tags_json AS doc_tags_json,
       d.relevance_boost AS doc_relevance_boost,
       d.attachment_url AS doc_attachment_url,
       d.thumbnail_url AS doc_thumbnail_url,
       col.name AS collection_name,
       col.is_public AS collection_is_public
     FROM dom_ai_chunks c
     INNER JOIN dom_ai_documents d
       ON d.tenant_id = c.tenant_id AND d.id = c.document_id
     LEFT JOIN dom_ai_collections col
       ON col.tenant_id = d.tenant_id AND col.id = d.collection_id
     WHERE c.tenant_id = $1
       AND c.portal_id = $2
       AND d.status = 'active'`,
    [tenantId, options.portalId]
  );

  const allowedSet =
    Array.isArray(options.allowedCollectionIds) && options.allowedCollectionIds.length > 0
      ? new Set(options.allowedCollectionIds.map((x) => String(x).trim()).filter(Boolean))
      : null;

  const filterColId = options.collectionFilterId ? String(options.collectionFilterId).trim() : null;

  let filteredByAcl = 0;
  const accessibleRows = rowsRes.rows.filter((row) => {
    const colId = row.collection_id ? String(row.collection_id) : null;
    const isColPublic = row.collection_is_public === null || row.collection_is_public === undefined
      ? true
      : Boolean(row.collection_is_public);

    if (allowedSet) {
      if (!colId || !allowedSet.has(colId)) {
        filteredByAcl++;
        return false;
      }
    } else if (!options.includePrivateCollections) {
      if (colId && !isColPublic) {
        filteredByAcl++;
        return false;
      }
    }

    if (filterColId && colId !== filterColId) {
      return false;
    }

    return true;
  });

  if (accessibleRows.length === 0) {
    return {
      query: rawQuery,
      normalized_query: foldedQuery,
      total_candidates: 0,
      filtered_by_acl: filteredByAcl,
      citations: [],
    };
  }

  // Pre-fold candidate fields once
  const prepared = accessibleRows.map((row) => {
    const tags = parseJsonArray<string>(row.doc_tags_json).map((t) => String(t || '').trim()).filter(Boolean);
    const titleFolded = normalizeVietnameseFolded(row.doc_title);
    const tagsFolded = normalizeVietnameseFolded(tags.join(' '));
    const colFolded = normalizeVietnameseFolded(row.collection_name || '');
    const contentFolded = normalizeVietnameseFolded(row.chunk_content);
    const kwFolded = String(row.keywords_text || '').toLowerCase();
    const combinedFolded = `${titleFolded} ${tagsFolded} ${colFolded} ${contentFolded} ${kwFolded}`;
    return {
      row,
      titleFolded,
      tagsFolded,
      colFolded,
      contentFolded,
      kwFolded,
      combinedFolded,
    };
  });

  // Compute IDF across accessible candidate chunks
  const totalN = prepared.length;
  const idfMap = new Map<string, number>();
  let totalIdf = 0;
  for (const tok of queryTokens) {
    let df = 0;
    for (const item of prepared) {
      if (item.combinedFolded.includes(tok)) {
        df++;
      }
    }
    const idf = Math.log((totalN + 1) / (df + 0.5)) + 1.0;
    idfMap.set(tok, idf);
    totalIdf += idf;
  }
  if (totalIdf <= 0) totalIdf = 1;

  // Score every candidate chunk
  const scored: Array<DomAiCitation & { rawScore: number }> = [];

  for (const item of prepared) {
    let score = 0;
    let matchedIdf = 0;
    let matchedTokenCount = 0;
    let titleMatches = 0;
    let tagMatches = 0;
    let colMatches = 0;

    // 1. Exact phrase match bonus
    if (foldedQuery.length >= 4) {
      if (item.titleFolded.includes(foldedQuery)) {
        score += 35;
      }
      if (item.tagsFolded.includes(foldedQuery)) {
        score += 28;
      }
      if (item.contentFolded.includes(foldedQuery)) {
        score += 22;
      }
    }

    // 2. IDF-weighted token overlap + title/tag/collection boosts
    for (const tok of queryTokens) {
      const idf = idfMap.get(tok) || 1.0;
      const inTitle = item.titleFolded.includes(tok);
      const inTags = item.tagsFolded.includes(tok);
      const inCol = item.colFolded.includes(tok);
      const inBody = item.contentFolded.includes(tok) || item.kwFolded.includes(tok);

      if (inTitle || inTags || inCol || inBody) {
        matchedTokenCount++;
        matchedIdf += idf;
      }
      if (inTitle) titleMatches++;
      if (inTags) tagMatches++;
      if (inCol) colMatches++;
    }

    if (matchedTokenCount === 0 && score === 0) {
      continue;
    }

    const idfCoverage = matchedIdf / totalIdf;
    score += idfCoverage * 42;
    score += Math.min(24, titleMatches * 6);
    score += Math.min(20, tagMatches * 5);
    score += Math.min(10, colMatches * 4);

    // 3. Bigram phrase proximity boost
    let bigramHits = 0;
    for (const bg of bigrams) {
      if (
        item.titleFolded.includes(bg) ||
        item.tagsFolded.includes(bg) ||
        item.contentFolded.includes(bg)
      ) {
        bigramHits++;
      }
    }
    score += Math.min(24, bigramHits * 8);

    // 4. Document relevance_boost multiplier
    const relBoost = Math.max(0.2, Math.min(5.0, Number(item.row.doc_relevance_boost || 1.0)));
    const finalScore = Number((score * relBoost).toFixed(2));

    if (finalScore <= 0) continue;

    const cleanSnippet =
      item.row.chunk_content.length > 420
        ? `${item.row.chunk_content.slice(0, 417).trimEnd()}...`
        : item.row.chunk_content;

    scored.push({
      chunk_id: String(item.row.chunk_id),
      document_id: String(item.row.document_id),
      title: String(item.row.doc_title),
      doc_type: String(item.row.doc_type || 'document'),
      collection_id: item.row.collection_id ? String(item.row.collection_id) : null,
      collection_name: item.row.collection_name ? String(item.row.collection_name) : null,
      snippet: cleanSnippet,
      score: finalScore,
      attachment_url: item.row.doc_attachment_url || null,
      thumbnail_url: item.row.doc_thumbnail_url || null,
      rawScore: finalScore,
    });
  }

  scored.sort((a, b) => b.rawScore - a.rawScore);

  // Deduplicate excessive chunks from the same document (max 3 chunks per doc unless pool is small)
  const selected: DomAiCitation[] = [];
  const docCounter = new Map<string, number>();

  for (const cand of scored) {
    const seen = docCounter.get(cand.document_id) || 0;
    if (seen >= 3 && scored.length > topK) {
      continue;
    }
    docCounter.set(cand.document_id, seen + 1);
    const { rawScore: _ignored, ...citation } = cand;
    selected.push(citation);
    if (selected.length >= topK) break;
  }

  return {
    query: rawQuery,
    normalized_query: foldedQuery,
    total_candidates: accessibleRows.length,
    filtered_by_acl: filteredByAcl,
    citations: selected,
  };
}

export function maskApiKeyHint(rawKey: string | null | undefined): string | null {
  const trimmed = String(rawKey || '').trim();
  if (!trimmed) return null;
  if (trimmed.length >= 8) {
    return `${trimmed.slice(0, 4)}••••••••${trimmed.slice(-4)}`;
  }
  return '••••••••';
}

export async function resolvePortalGeminiByokInTx(
  client: DbClient,
  tenantId: string,
  portalMetadata?: unknown
): Promise<PortalGeminiByokResolution> {
  // 1. Check portal-specific encrypted vault inside dom_ai_portals.metadata_json.byok_vault
  const meta = parseJsonObject<Record<string, unknown>>(portalMetadata);
  const portalVault = parseJsonObject<Record<string, unknown>>(meta.byok_vault);
  if (
    typeof portalVault.config_encrypted === 'string' &&
    typeof portalVault.iv === 'string' &&
    typeof portalVault.auth_tag === 'string'
  ) {
    try {
      const dec = decryptTenantSecret<Record<string, unknown>>(
        tenantId,
        portalVault.config_encrypted,
        portalVault.iv,
        portalVault.auth_tag
      );
      const rawKey = String(dec.api_key || dec.gemini_api_key || dec.apiKey || '').trim();
      if (rawKey) {
        return {
          apiKey: rawKey,
          modelOverride: typeof dec.model === 'string' && dec.model.trim() ? dec.model.trim() : undefined,
          keyHint: maskApiKeyHint(rawKey),
          source: 'portal_vault',
        };
      }
    } catch {
      // Fall through to tenant vault
    }
  }

  // 2. Check tenant-level encrypted Vault (`ai_gemini_byok`, `ai_gemini`)
  const res = await client.query<{
    integration_type: string;
    config_encrypted: string;
    iv: string;
    auth_tag: string;
  }>(
    `SELECT integration_type, config_encrypted, iv, auth_tag
     FROM tenant_integrations
     WHERE tenant_id = $1
       AND integration_type IN ('ai_gemini_byok', 'ai_gemini')
       AND status = 'active'
     ORDER BY CASE WHEN integration_type = 'ai_gemini_byok' THEN 0 ELSE 1 END
     LIMIT 1`,
    [tenantId]
  );

  const row = res.rows[0];
  if (row) {
    try {
      const dec = decryptTenantSecret<Record<string, unknown>>(
        tenantId,
        row.config_encrypted,
        row.iv,
        row.auth_tag
      );
      const rawKey = String(
        dec.api_key || dec.gemini_api_key || dec.geminiByokKey || dec.apiKey || ''
      ).trim();
      if (rawKey) {
        return {
          apiKey: rawKey,
          modelOverride: typeof dec.model === 'string' && dec.model.trim() ? dec.model.trim() : undefined,
          keyHint: maskApiKeyHint(rawKey),
          source: 'tenant_vault',
        };
      }
    } catch {
      // Fall through
    }
  }

  // 3. Legacy tenants.settings fallback
  const legacyRes = await client.query<{ settings: Record<string, unknown> | null }>(
    `SELECT settings FROM tenants WHERE id = $1 LIMIT 1`,
    [tenantId]
  );
  const settingsObj = parseJsonObject<Record<string, unknown>>(legacyRes.rows[0]?.settings);
  const legacyKey = String(settingsObj.gemini_api_key || '').trim();
  if (legacyKey && !legacyKey.includes('••••') && !legacyKey.includes('***')) {
    return {
      apiKey: legacyKey,
      modelOverride:
        typeof settingsObj.gemini_model === 'string' && settingsObj.gemini_model.trim()
          ? settingsObj.gemini_model.trim()
          : undefined,
      keyHint: maskApiKeyHint(legacyKey),
      source: 'legacy_settings',
    };
  }

  return { apiKey: null, keyHint: null, source: 'none' };
}

export async function savePortalGeminiByokInTx(
  client: DbClient,
  tenantId: string,
  portalId: string,
  input: {
    api_key: string;
    model?: string;
    sync_tenant_vault?: boolean;
  }
): Promise<{ has_api_key: boolean; api_key_hint: string | null; model: string }> {
  const cleanKey = String(input.api_key || '').trim();
  if (!cleanKey || cleanKey.includes('••••') || cleanKey.includes('***')) {
    throw new Error('INVALID_GEMINI_API_KEY');
  }

  const portalRes = await client.query<{ model: string; metadata_json: unknown }>(
    `SELECT model, metadata_json FROM dom_ai_portals WHERE tenant_id = $1 AND id = $2 LIMIT 1`,
    [tenantId, portalId]
  );
  const portalRow = portalRes.rows[0];
  if (!portalRow) {
    throw new Error('PORTAL_NOT_FOUND');
  }

  const nextModel = String(input.model || portalRow.model || DEFAULT_PORTAL_MODEL).trim();
  const encryptedPortalVault = encryptTenantSecret(tenantId, {
    api_key: cleanKey,
    model: nextModel,
    portal_id: portalId,
    updated_at: new Date().toISOString(),
  });

  const nextMeta = parseJsonObject<Record<string, unknown>>(portalRow.metadata_json);
  nextMeta.byok_vault = {
    config_encrypted: encryptedPortalVault.configEncrypted,
    iv: encryptedPortalVault.iv,
    auth_tag: encryptedPortalVault.authTag,
    key_hint: maskApiKeyHint(cleanKey),
    updated_at: new Date().toISOString(),
  };

  await client.query(
    `UPDATE dom_ai_portals
     SET model = $3,
         metadata_json = $4::jsonb,
         is_free_byok = true,
         updated_at = clock_timestamp()
     WHERE tenant_id = $1 AND id = $2`,
    [tenantId, portalId, nextModel, JSON.stringify(nextMeta)]
  );

  if (input.sync_tenant_vault !== false) {
    // Preserve any extra flags already in tenant ai_gemini_byok
    const prevRes = await client.query<{
      config_encrypted: string;
      iv: string;
      auth_tag: string;
    }>(
      `SELECT config_encrypted, iv, auth_tag
       FROM tenant_integrations
       WHERE tenant_id = $1 AND integration_type = 'ai_gemini_byok'
       LIMIT 1`,
      [tenantId]
    );
    let prevData: Record<string, unknown> = {};
    if (prevRes.rows[0]) {
      try {
        prevData = decryptTenantSecret<Record<string, unknown>>(
          tenantId,
          prevRes.rows[0].config_encrypted,
          prevRes.rows[0].iv,
          prevRes.rows[0].auth_tag
        );
      } catch {
        prevData = {};
      }
    }

    const tenantEnc = encryptTenantSecret(tenantId, {
      ...prevData,
      api_key: cleanKey,
      model: nextModel,
      updated_at: new Date().toISOString(),
    });

    await client.query(
      `INSERT INTO tenant_integrations (
         tenant_id, integration_type, config_encrypted, iv, auth_tag, status, last_synced_at
       ) VALUES ($1, 'ai_gemini_byok', $2, $3, $4, 'active', clock_timestamp())
       ON CONFLICT (tenant_id, integration_type)
       DO UPDATE SET
         config_encrypted = EXCLUDED.config_encrypted,
         iv = EXCLUDED.iv,
         auth_tag = EXCLUDED.auth_tag,
         status = 'active',
         last_synced_at = clock_timestamp(),
         updated_at = clock_timestamp()`,
      [tenantId, tenantEnc.configEncrypted, tenantEnc.iv, tenantEnc.authTag]
    );
    tenantRedis.invalidateTenantIntegrations(tenantId, 'ai_gemini_byok');
  }

  return {
    has_api_key: true,
    api_key_hint: maskApiKeyHint(cleanKey),
    model: nextModel,
  };
}

export async function testPortalGeminiKey(
  apiKey: string,
  model = DEFAULT_PORTAL_MODEL
): Promise<{
  ok: boolean;
  model: string;
  latency_ms: number;
  mode: 'live' | 'silent_mock';
  message: string;
}> {
  const startedAt = Date.now();
  const cleanKey = String(apiKey || '').trim();
  const cleanModel = String(model || DEFAULT_PORTAL_MODEL).trim();

  if (!cleanKey || cleanKey.length < 10) {
    return {
      ok: false,
      model: cleanModel,
      latency_ms: Date.now() - startedAt,
      mode: isOutboundSilentMode() ? 'silent_mock' : 'live',
      message: 'API Key không hợp lệ hoặc quá ngắn.',
    };
  }

  if (isOutboundSilentMode()) {
    return {
      ok: true,
      model: cleanModel,
      latency_ms: Math.max(1, Date.now() - startedAt),
      mode: 'silent_mock',
      message: `Kết nối Gemini BYOK (${cleanModel}) hợp lệ ở chế độ kiểm thử cục bộ.`,
    };
  }

  try {
    const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(cleanModel)}:generateContent`;
    const resp = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-goog-api-key': cleanKey,
      },
      body: JSON.stringify({
        contents: [{ role: 'user', parts: [{ text: 'Trả lời đúng 1 từ: OK' }] }],
        generationConfig: { temperature: 0, maxOutputTokens: 16 },
      }),
      signal: AbortSignal.timeout(12_000),
    });

    const json = (await resp.json().catch(() => ({}))) as Record<string, any>;
    const latency = Date.now() - startedAt;

    if (!resp.ok) {
      return {
        ok: false,
        model: cleanModel,
        latency_ms: latency,
        mode: 'live',
        message: String(json?.error?.message || `Gemini API trả về mã lỗi HTTP ${resp.status}.`),
      };
    }

    return {
      ok: true,
      model: cleanModel,
      latency_ms: latency,
      mode: 'live',
      message: `Kết nối thành công tới Google Gemini (${cleanModel}) trong ${latency}ms.`,
    };
  } catch (err: unknown) {
    return {
      ok: false,
      model: cleanModel,
      latency_ms: Date.now() - startedAt,
      mode: 'live',
      message: err instanceof Error ? err.message : 'Không thể kết nối Google Gemini API.',
    };
  }
}

async function callGeminiGroundedGeneration(params: {
  apiKey: string;
  model: string;
  temperature: number;
  systemInstruction: string;
  history: Array<{ role: 'user' | 'assistant'; content: string }>;
  userMessage: string;
}): Promise<{ text: string; tokensUsed: number } | null> {
  if (!params.apiKey || isOutboundSilentMode()) {
    return null;
  }

  const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(params.model)}:generateContent`;
  const contents: Array<{ role: 'user' | 'model'; parts: Array<{ text: string }> }> = [];

  for (const h of params.history.slice(-8)) {
    contents.push({
      role: h.role === 'assistant' ? 'model' : 'user',
      parts: [{ text: h.content }],
    });
  }
  contents.push({
    role: 'user',
    parts: [{ text: params.userMessage }],
  });

  try {
    const resp = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-goog-api-key': params.apiKey,
      },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: params.systemInstruction }] },
        contents,
        generationConfig: {
          temperature: Math.max(0, Math.min(1, Number(params.temperature ?? 0.25))),
          maxOutputTokens: 2048,
        },
      }),
      signal: AbortSignal.timeout(22_000),
    });

    if (!resp.ok) {
      return null;
    }

    const json = (await resp.json().catch(() => ({}))) as Record<string, any>;
    const parts = Array.isArray(json?.candidates?.[0]?.content?.parts)
      ? (json.candidates[0].content.parts as Array<Record<string, unknown>>)
      : [];
    const text = parts
      .map((p) => (typeof p.text === 'string' ? p.text : ''))
      .join('\n')
      .trim();

    if (!text) return null;

    const totalTokens = Number(json?.usageMetadata?.totalTokenCount || 0);
    return {
      text,
      tokensUsed: totalTokens > 0 ? totalTokens : Math.ceil((params.userMessage.length + text.length) / 4),
    };
  } catch {
    return null;
  }
}

export function buildDeterministicRagReply(params: {
  portalName: string;
  query: string;
  citations: DomAiCitation[];
  filteredByAcl: number;
  starterPrompts: string[];
}): string {
  const { portalName, query, citations, filteredByAcl, starterPrompts } = params;

  if (citations.length === 0) {
    const aclNote =
      filteredByAcl > 0
        ? `\n\n> Lưu ý phân quyền: Có **${filteredByAcl}** đoạn tri thức nằm trong bộ sưu tập giới hạn quyền truy cập không thuộc phạm vi tài khoản của bạn.`
        : '';
    const suggestions =
      starterPrompts.length > 0
        ? `\n\n**Gợi ý câu hỏi bạn có thể thử:**\n${starterPrompts
            .slice(0, 3)
            .map((p) => `- ${p}`)
            .join('\n')}`
        : '';
    return `Hiện tại **${portalName}** chưa tìm thấy tài liệu khớp trực tiếp với nội dung *"${query}"* trong các bộ sưu tập được cấp quyền.${aclNote}${suggestions}`;
  }

  const lines: string[] = [
    `Dựa trên tài liệu chính thức trong kho tri thức **${portalName}**, dưới đây là thông tin chi tiết liên quan đến câu hỏi của bạn:`,
    '',
  ];

  const uniqueByDoc = new Map<string, { citation: DomAiCitation; index: number }>();
  citations.forEach((cit, idx) => {
    if (!uniqueByDoc.has(cit.document_id)) {
      uniqueByDoc.set(cit.document_id, { citation: cit, index: idx + 1 });
    }
  });

  let sectionIdx = 1;
  for (const { citation } of uniqueByDoc.values()) {
    if (sectionIdx > 4) break;
    const colLabel = citation.collection_name ? ` *(${citation.collection_name})*` : '';
    lines.push(`### ${sectionIdx}. ${citation.title}${colLabel}`);
    lines.push(citation.snippet);
    lines.push('');
    sectionIdx++;
  }

  lines.push('---');
  lines.push(
    `**Nguồn trích dẫn:** ${Array.from(uniqueByDoc.values())
      .slice(0, 4)
      .map((entry, idx) => `[${idx + 1}] ${entry.citation.title}`)
      .join(' • ')}`
  );

  return lines.join('\n').trim();
}

function expandShortFollowUpQuery(
  message: string,
  history: Array<{ role: 'user' | 'assistant'; content: string }>
): string {
  const trimmed = message.trim();
  if (trimmed.length >= 45 || history.length === 0) {
    return trimmed;
  }
  const lastUserTurn = [...history].reverse().find((h) => h.role === 'user');
  if (!lastUserTurn) return trimmed;
  const prevKeywords = extractDomAiKeywords(lastUserTurn.content).slice(0, 6);
  if (prevKeywords.length === 0) return trimmed;
  return `${trimmed} ${prevKeywords.join(' ')}`;
}

export async function runDomAiPortalChatInTx(
  client: DbClient,
  tenantId: string,
  params: {
    portal: PortalRecord;
    viewer: PortalChatViewerContext;
    message: string;
    conversationId?: string | null;
    collectionFilterId?: string | null;
  }
): Promise<{
  conversation: Record<string, unknown>;
  user_message: Record<string, unknown>;
  assistant_message: Record<string, unknown>;
  reply: string;
  citations: DomAiCitation[];
  model: string;
  latency_ms: number;
  tokens_used: number;
  engine_mode: 'gemini_byok_live' | 'rag_grounded_deterministic';
}> {
  const startedAt = Date.now();
  const cleanMessage = String(params.message || '').trim();
  if (!cleanMessage) {
    throw new Error('CHAT_MESSAGE_REQUIRED');
  }

  const portal = params.portal;
  const viewer = params.viewer;

  // 1. Resolve or create conversation
  let convRow: Record<string, unknown> | null = null;
  if (params.conversationId) {
    const existingConv = await client.query(
      `SELECT * FROM dom_ai_conversations
       WHERE tenant_id = $1 AND portal_id = $2 AND id = $3
       LIMIT 1`,
      [tenantId, portal.id, params.conversationId]
    );
    const found = existingConv.rows[0];
    if (
      found &&
      (String(found.user_email || '').toLowerCase() === viewer.email.toLowerCase() ||
        (viewer.portalUserId && String(found.portal_user_id || '') === viewer.portalUserId))
    ) {
      convRow = found;
    }
  }

  if (!convRow) {
    const newConvId = crypto.randomUUID();
    const autoTitle =
      cleanMessage.length > 72 ? `${cleanMessage.slice(0, 69).trimEnd()}...` : cleanMessage;
    await client.query(
      `INSERT INTO dom_ai_conversations (
         id, tenant_id, portal_id, portal_user_id, user_email, user_name,
         title, is_starred, collection_filter_id, message_count, last_message_at
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, false, $8, 0, clock_timestamp())`,
      [
        newConvId,
        tenantId,
        portal.id,
        viewer.portalUserId,
        viewer.email,
        viewer.fullName,
        autoTitle,
        params.collectionFilterId || null,
      ]
    );
    const createdConv = await client.query(
      `SELECT * FROM dom_ai_conversations WHERE tenant_id = $1 AND id = $2 LIMIT 1`,
      [tenantId, newConvId]
    );
    convRow = createdConv.rows[0];
  }

  const convId = String(convRow!.id);
  const effectiveCollectionFilter =
    params.collectionFilterId !== undefined
      ? params.collectionFilterId
      : (convRow?.collection_filter_id as string | null) || null;

  // 2. Load recent conversation history for multi-turn grounding
  const historyRes = await client.query<{ role: 'user' | 'assistant'; content: string }>(
    `SELECT role, content
     FROM dom_ai_messages
     WHERE tenant_id = $1 AND portal_id = $2 AND conversation_id = $3
     ORDER BY created_at DESC
     LIMIT 8`,
    [tenantId, portal.id, convId]
  );
  const history = [...historyRes.rows].reverse();

  // 3. Hybrid Vietnamese RAG search scoped strictly to viewer's collection ACL
  const searchQuery = expandShortFollowUpQuery(cleanMessage, history);
  const ragResult = await searchDomAiKnowledgeInTx(client, tenantId, {
    portalId: portal.id,
    query: searchQuery,
    topK: Math.max(1, Math.min(15, Number(portal.top_k || 6))),
    collectionFilterId: effectiveCollectionFilter,
    allowedCollectionIds: viewer.allowedCollectionIds,
    includePrivateCollections: viewer.role === 'admin',
  });

  // 4. Persist user message
  const userMsgId = crypto.randomUUID();
  const userTokenEst = Math.max(1, Math.ceil(cleanMessage.length / 4));
  await client.query(
    `INSERT INTO dom_ai_messages (
       id, tenant_id, portal_id, conversation_id, role, content,
       citations_json, model, latency_ms, tokens_used
     ) VALUES ($1, $2, $3, $4, 'user', $5, '[]'::jsonb, '', 0, $6)`,
    [userMsgId, tenantId, portal.id, convId, cleanMessage, userTokenEst]
  );

  // 5. Resolve BYOK Gemini API key and run generation (or clean RAG-grounded deterministic reply)
  const byok = await resolvePortalGeminiByokInTx(client, tenantId, portal.metadata_json);
  const effectiveModel = byok.modelOverride || portal.model || DEFAULT_PORTAL_MODEL;
  const starterPrompts = parseJsonArray<string>(portal.starter_prompts_json)
    .map((p) => String(p || '').trim())
    .filter(Boolean);

  const ragContextBlock =
    ragResult.citations.length > 0
      ? ragResult.citations
          .map(
            (c, idx) =>
              `[${idx + 1}] ${c.title}${c.collection_name ? ` (Bộ sưu tập: ${c.collection_name})` : ''} [Score: ${c.score}]:\n${c.snippet}`
          )
          .join('\n\n')
      : 'Không tìm thấy đoạn tài liệu khớp trực tiếp trong phạm vi bộ sưu tập được cấp quyền.';

  const systemInstruction = [
    portal.system_instruction?.trim() || DEFAULT_PORTAL_SYSTEM_INSTRUCTION,
    `Tên trợ lý/Cổng tri thức: ${portal.name}.`,
    'NGUYÊN TẮC TRÍCH DẪN & CHỐNG BỊA ĐẶT: Chỉ trả lời dựa trên KHO TRI THỨC NỘI BỘ dưới đây. Khi nêu thông tin, gắn số trích dẫn [1], [2]... tương ứng nguồn tài liệu. Nếu tài liệu không đề cập, hãy nói rõ chưa có dữ liệu và không tự suy diễn.',
    `KHO TRI THỨC NỘI BỘ (RAG TOP-${ragResult.citations.length}):\n${ragContextBlock}`,
  ].join('\n\n');

  let replyText = '';
  let tokensUsed = 0;
  let engineMode: 'gemini_byok_live' | 'rag_grounded_deterministic' = 'rag_grounded_deterministic';
  let modelLabel = `${effectiveModel} (RAG Grounded)`;

  if (byok.apiKey && !isOutboundSilentMode()) {
    const liveOut = await callGeminiGroundedGeneration({
      apiKey: byok.apiKey,
      model: effectiveModel,
      temperature: Number(portal.temperature ?? 0.25),
      systemInstruction,
      history,
      userMessage: cleanMessage,
    });
    if (liveOut) {
      replyText = liveOut.text;
      tokensUsed = liveOut.tokensUsed;
      engineMode = 'gemini_byok_live';
      modelLabel = effectiveModel;
    }
  }

  if (!replyText) {
    replyText = buildDeterministicRagReply({
      portalName: portal.name,
      query: cleanMessage,
      citations: ragResult.citations,
      filteredByAcl: ragResult.filtered_by_acl,
      starterPrompts,
    });
    tokensUsed = Math.max(1, Math.ceil((cleanMessage.length + replyText.length) / 4));
  }

  const latencyMs = Math.max(1, Date.now() - startedAt);

  // 6. Persist assistant message
  const assistantMsgId = crypto.randomUUID();
  await client.query(
    `INSERT INTO dom_ai_messages (
       id, tenant_id, portal_id, conversation_id, role, content,
       citations_json, model, latency_ms, tokens_used
     ) VALUES ($1, $2, $3, $4, 'assistant', $5, $6::jsonb, $7, $8, $9)`,
    [
      assistantMsgId,
      tenantId,
      portal.id,
      convId,
      replyText,
      JSON.stringify(ragResult.citations),
      modelLabel,
      latencyMs,
      tokensUsed,
    ]
  );

  // 7. Update conversation & portal user metrics
  const currentTitle = String(convRow?.title || '').trim();
  const shouldUpdateTitle =
    !currentTitle ||
    currentTitle === 'Cuộc hội thoại mới' ||
    currentTitle === 'Hội thoại mới' ||
    Number(convRow?.message_count || 0) === 0;
  const nextTitle = shouldUpdateTitle
    ? cleanMessage.length > 72
      ? `${cleanMessage.slice(0, 69).trimEnd()}...`
      : cleanMessage
    : currentTitle;

  await client.query(
    `UPDATE dom_ai_conversations
     SET title = $3,
         collection_filter_id = $4,
         message_count = message_count + 2,
         last_message_at = clock_timestamp()
     WHERE tenant_id = $1 AND id = $2`,
    [tenantId, convId, nextTitle, effectiveCollectionFilter]
  );

  if (viewer.portalUserId) {
    await client.query(
      `UPDATE dom_ai_portal_users
       SET message_count = message_count + 1,
           last_active_at = clock_timestamp(),
           updated_at = clock_timestamp()
       WHERE tenant_id = $1 AND id = $2`,
      [tenantId, viewer.portalUserId]
    );
  }

  const [updatedConvRes, userMsgRes, assistantMsgRes] = await Promise.all([
    client.query(`SELECT * FROM dom_ai_conversations WHERE tenant_id = $1 AND id = $2 LIMIT 1`, [
      tenantId,
      convId,
    ]),
    client.query(`SELECT * FROM dom_ai_messages WHERE tenant_id = $1 AND id = $2 LIMIT 1`, [
      tenantId,
      userMsgId,
    ]),
    client.query(`SELECT * FROM dom_ai_messages WHERE tenant_id = $1 AND id = $2 LIMIT 1`, [
      tenantId,
      assistantMsgId,
    ]),
  ]);

  const formattedAssistant = {
    ...assistantMsgRes.rows[0],
    citations: ragResult.citations,
  };
  const formattedUser = {
    ...userMsgRes.rows[0],
    citations: [],
  };

  return {
    conversation: updatedConvRes.rows[0],
    user_message: formattedUser,
    assistant_message: formattedAssistant,
    reply: replyText,
    citations: ragResult.citations,
    model: modelLabel,
    latency_ms: latencyMs,
    tokens_used: tokensUsed,
    engine_mode: engineMode,
  };
}
