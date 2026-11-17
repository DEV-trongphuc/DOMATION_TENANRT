import crypto from 'node:crypto';
import type { DbClient } from '../../core/database/db-adapter.ts';
import type { UserOrgAuthSnapshot } from '../../core/security/rbac.ts';
import { renderPolicyDocumentPreview } from '../org-rbac/org-rbac.service.ts';
import { parseJsonArray } from './schema.ts';

export interface KnowledgeChunkDraft {
  chunk_index: number;
  chunk_text: string;
  keywords_text: string;
  token_estimate: number;
}

export interface RagCitationItem {
  chunk_id: string;
  doc_id: string;
  title: string;
  category: string;
  source_type: string;
  chunk_index: number;
  snippet: string;
  score: number;
}

export interface RagSearchResult {
  query: string;
  total_accessible_docs: number;
  filtered_by_department_acl: number;
  citations: RagCitationItem[];
}

const VIETNAMESE_STOPWORDS = new Set([
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
  'hai',
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
  'chung',
  'cong',
  'ty',
]);

export function stripHtmlToText(raw: string): string {
  if (!raw) return '';
  return String(raw)
    .replace(/<\s*br\s*\/?>/gi, '\n')
    .replace(/<\/\s*(p|div|li|tr|h1|h2|h3|h4|h5|h6|section|article)\s*>/gi, '\n')
    .replace(/<\s*li[^>]*>/gi, '• ')
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
    .replace(/[ \t]{2,}/g, ' ')
    .trim();
}

export function normalizeFoldedAscii(input: string): string {
  return String(input || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/đ/gi, 'd')
    .toLowerCase()
    .replace(/[^a-z0-9_\s]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function extractKeywords(text: string): string[] {
  const folded = normalizeFoldedAscii(text);
  if (!folded) return [];
  const unique = new Set<string>();
  for (const tok of folded.split(' ')) {
    if ((tok.length >= 3 || /^\d{2,}$/.test(tok)) && !VIETNAMESE_STOPWORDS.has(tok)) {
      unique.add(tok);
    }
    if (unique.size >= 80) break;
  }
  return Array.from(unique);
}

export function chunkKnowledgeText(title: string, rawText: string, maxChunkChars = 680): KnowledgeChunkDraft[] {
  const cleaned = stripHtmlToText(rawText);
  if (!cleaned) {
    const fallbackText = title.trim() || 'Tài liệu nội bộ';
    return [
      {
        chunk_index: 0,
        chunk_text: fallbackText,
        keywords_text: extractKeywords(fallbackText).join(' '),
        token_estimate: Math.max(1, Math.ceil(fallbackText.length / 4)),
      },
    ];
  }

  const paragraphs = cleaned
    .split(/\n{2,}/)
    .map((p) => p.trim())
    .filter(Boolean);

  const rawChunks: string[] = [];
  let buffer = '';

  const flushBuffer = () => {
    if (buffer.trim()) {
      rawChunks.push(buffer.trim());
      buffer = '';
    }
  };

  for (const para of paragraphs) {
    if (para.length > maxChunkChars) {
      flushBuffer();
      let cursor = 0;
      const step = Math.max(200, maxChunkChars - 100);
      while (cursor < para.length) {
        const slice = para.slice(cursor, cursor + maxChunkChars).trim();
        if (slice) rawChunks.push(slice);
        if (cursor + maxChunkChars >= para.length) break;
        cursor += step;
      }
      continue;
    }

    if (!buffer) {
      buffer = para;
    } else if (buffer.length + 2 + para.length <= maxChunkChars) {
      buffer = `${buffer}\n\n${para}`;
    } else {
      flushBuffer();
      buffer = para;
    }
  }
  flushBuffer();

  if (rawChunks.length === 0) {
    rawChunks.push(cleaned.slice(0, maxChunkChars));
  }

  return rawChunks.map((chunkText, idx) => {
    const combinedForKw = `${title} ${chunkText}`;
    return {
      chunk_index: idx,
      chunk_text: chunkText,
      keywords_text: extractKeywords(combinedForKw).join(' '),
      token_estimate: Math.max(1, Math.ceil(chunkText.length / 4)),
    };
  });
}

/**
 * Department-ACL Guard for RAG Knowledge Documents:
 * - `allowed_department_ids` empty (`[]`) -> Company-wide internal doc within the same `tenant_id`.
 * - `allowed_department_ids` non-empty -> Strictly restricted to callers whose `department_id`
 *   is included in `allowed_department_ids` (or Workspace Owner `is_tenant_owner === true`).
 */
export function canCallerAccessKnowledgeDoc(
  rawAllowedDepartmentIds: unknown,
  callerOrg: UserOrgAuthSnapshot | null
): boolean {
  const allowedIds = parseJsonArray<string>(rawAllowedDepartmentIds)
    .map((id) => String(id || '').trim())
    .filter(Boolean);

  if (allowedIds.length === 0) {
    return true;
  }
  if (callerOrg?.is_tenant_owner) {
    return true;
  }
  if (!callerOrg?.department_id) {
    return false;
  }
  return allowedIds.includes(callerOrg.department_id);
}

export interface UpsertKnowledgeDocInput {
  id?: string;
  title: string;
  category?: string;
  source_type?: 'manual' | 'policy_sync' | 'file_upload';
  source_policy_id?: string | null;
  file_name?: string | null;
  content_text: string;
  allowed_department_ids?: string[];
  is_active?: boolean;
}

export async function upsertKnowledgeDocInTx(
  client: DbClient,
  tenantId: string,
  actorUserId: string,
  input: UpsertKnowledgeDocInput
): Promise<Record<string, unknown>> {
  const title = String(input.title || '').trim();
  if (!title) {
    throw new Error('KNOWLEDGE_TITLE_REQUIRED');
  }
  const category = String(input.category || 'company_policy').trim() || 'company_policy';
  const sourceType =
    input.source_type === 'policy_sync' || input.source_type === 'file_upload'
      ? input.source_type
      : 'manual';
  const cleanText = stripHtmlToText(input.content_text || '');
  const allowedDeptIds = Array.from(
    new Set(
      (Array.isArray(input.allowed_department_ids) ? input.allowed_department_ids : [])
        .map((x) => String(x || '').trim())
        .filter(Boolean)
    )
  );
  const isActive = input.is_active !== false;

  const chunks = chunkKnowledgeText(title, cleanText);

  let docId = input.id ? String(input.id).trim() : '';
  if (!docId && input.source_policy_id) {
    const existingSync = await client.query<{ id: string }>(
      `SELECT id FROM tenant_ai_knowledge_docs
       WHERE tenant_id = $1 AND source_policy_id = $2
       LIMIT 1`,
      [tenantId, input.source_policy_id]
    );
    if (existingSync.rows[0]?.id) {
      docId = existingSync.rows[0].id;
    }
  }

  if (docId) {
    const checkExisting = await client.query<{ id: string }>(
      'SELECT id FROM tenant_ai_knowledge_docs WHERE tenant_id = $1 AND id = $2 LIMIT 1',
      [tenantId, docId]
    );
    if (checkExisting.rows[0]?.id) {
      await client.query(
        `UPDATE tenant_ai_knowledge_docs
         SET title = $3,
             category = $4,
             source_type = $5,
             source_policy_id = $6,
             file_name = $7,
             content_text = $8,
             allowed_department_ids = $9::jsonb,
             chunk_count = $10,
             is_active = $11,
             updated_at = clock_timestamp()
         WHERE tenant_id = $1 AND id = $2`,
        [
          tenantId,
          docId,
          title,
          category,
          sourceType,
          input.source_policy_id || null,
          input.file_name || null,
          cleanText,
          JSON.stringify(allowedDeptIds),
          chunks.length,
          isActive,
        ]
      );
      await client.query(
        'DELETE FROM tenant_ai_knowledge_chunks WHERE tenant_id = $1 AND doc_id = $2',
        [tenantId, docId]
      );
    } else {
      docId = '';
    }
  }

  if (!docId) {
    docId = crypto.randomUUID();
    await client.query(
      `INSERT INTO tenant_ai_knowledge_docs (
         id, tenant_id, title, category, source_type, source_policy_id, file_name,
         content_text, allowed_department_ids, chunk_count, is_active, created_by
       ) VALUES (
         $1, $2, $3, $4, $5, $6, $7,
         $8, $9::jsonb, $10, $11, $12
       )`,
      [
        docId,
        tenantId,
        title,
        category,
        sourceType,
        input.source_policy_id || null,
        input.file_name || null,
        cleanText,
        JSON.stringify(allowedDeptIds),
        chunks.length,
        isActive,
        actorUserId,
      ]
    );
  }

  for (const ch of chunks) {
    await client.query(
      `INSERT INTO tenant_ai_knowledge_chunks (
         id, tenant_id, doc_id, chunk_index, chunk_text, keywords_text, token_estimate
       ) VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [
        crypto.randomUUID(),
        tenantId,
        docId,
        ch.chunk_index,
        ch.chunk_text,
        ch.keywords_text,
        ch.token_estimate,
      ]
    );
  }

  const savedRes = await client.query(
    'SELECT * FROM tenant_ai_knowledge_docs WHERE tenant_id = $1 AND id = $2 LIMIT 1',
    [tenantId, docId]
  );
  const saved = savedRes.rows[0] || {};
  return {
    ...saved,
    allowed_department_ids: parseJsonArray<string>(saved.allowed_department_ids),
  };
}

/**
 * Syncs published `tenant_policy_documents` from Wave 1 Settings directly into
 * `tenant_ai_knowledge_docs` and `tenant_ai_knowledge_chunks`, preserving Department ACLs
 * and rendering dynamic legal entity merge variables (`{{company.legal_name}}`, etc.).
 */
export async function syncPolicyDocumentsToKnowledgeInTx(
  client: DbClient,
  tenantId: string,
  actorUserId: string,
  options?: { policyIds?: string[] }
): Promise<{
  synced_count: number;
  total_chunks_indexed: number;
  documents: Array<Record<string, unknown>>;
}> {
  const filterIds = Array.isArray(options?.policyIds)
    ? options!.policyIds.map((x) => String(x || '').trim()).filter(Boolean)
    : [];

  const policiesRes = await client.query<{
    id: string;
    title: string;
    doc_category: string;
    content_html: string | null;
    content_markdown: string | null;
    status: string;
    allowed_department_ids: unknown;
  }>(
    `SELECT id, title, doc_category, content_html, content_markdown, status, allowed_department_ids
     FROM tenant_policy_documents
     WHERE tenant_id = $1 AND status = 'published'
     ORDER BY updated_at DESC`,
    [tenantId]
  );

  const targetPolicies =
    filterIds.length > 0
      ? policiesRes.rows.filter((p) => filterIds.includes(p.id))
      : policiesRes.rows;

  const syncedDocs: Array<Record<string, unknown>> = [];
  let totalChunks = 0;

  for (const pol of targetPolicies) {
    const rawBody = pol.content_markdown || pol.content_html || '';
    const renderedHtml = await renderPolicyDocumentPreview(client, tenantId, rawBody);
    const cleanText = stripHtmlToText(renderedHtml);
    const allowedDepts = parseJsonArray<string>(pol.allowed_department_ids);

    const kdoc = await upsertKnowledgeDocInTx(client, tenantId, actorUserId, {
      title: pol.title,
      category: pol.doc_category || 'company_policy',
      source_type: 'policy_sync',
      source_policy_id: pol.id,
      content_text: cleanText,
      allowed_department_ids: allowedDepts,
      is_active: true,
    });

    await client.query(
      `UPDATE tenant_policy_documents
       SET sync_to_dom_agent = true,
           last_synced_dom_agent_at = clock_timestamp(),
           updated_at = clock_timestamp()
       WHERE tenant_id = $1 AND id = $2`,
      [tenantId, pol.id]
    );

    totalChunks += Number(kdoc.chunk_count || 0);
    syncedDocs.push(kdoc);
  }

  return {
    synced_count: syncedDocs.length,
    total_chunks_indexed: totalChunks,
    documents: syncedDocs,
  };
}

/**
 * Searches Tenant-Isolated RAG Knowledge Chunks, strictly enforcing `callerOrg.department_id`
 * against each document's `allowed_department_ids`.
 */
export async function searchKnowledgeRagInTx(
  client: DbClient,
  tenantId: string,
  callerOrg: UserOrgAuthSnapshot | null,
  query: string,
  options?: { category?: string; topK?: number }
): Promise<RagSearchResult> {
  const cleanQuery = String(query || '').trim();
  const topK = Math.min(12, Math.max(1, Number(options?.topK || 5)));
  const categoryFilter = options?.category ? String(options.category).trim() : '';

  const docsRes = categoryFilter
    ? await client.query<{
        id: string;
        title: string;
        category: string;
        source_type: string;
        allowed_department_ids: unknown;
      }>(
        `SELECT id, title, category, source_type, allowed_department_ids
         FROM tenant_ai_knowledge_docs
         WHERE tenant_id = $1 AND is_active = true AND category = $2`,
        [tenantId, categoryFilter]
      )
    : await client.query<{
        id: string;
        title: string;
        category: string;
        source_type: string;
        allowed_department_ids: unknown;
      }>(
        `SELECT id, title, category, source_type, allowed_department_ids
         FROM tenant_ai_knowledge_docs
         WHERE tenant_id = $1 AND is_active = true`,
        [tenantId]
      );

  const accessibleDocMap = new Map<
    string,
    { id: string; title: string; category: string; source_type: string }
  >();
  let filteredByAcl = 0;

  for (const doc of docsRes.rows) {
    if (canCallerAccessKnowledgeDoc(doc.allowed_department_ids, callerOrg)) {
      accessibleDocMap.set(doc.id, {
        id: doc.id,
        title: doc.title,
        category: doc.category,
        source_type: doc.source_type,
      });
    } else {
      filteredByAcl += 1;
    }
  }

  if (accessibleDocMap.size === 0) {
    return {
      query: cleanQuery,
      total_accessible_docs: 0,
      filtered_by_department_acl: filteredByAcl,
      citations: [],
    };
  }

  const chunksRes = await client.query<{
    id: string;
    doc_id: string;
    chunk_index: number;
    chunk_text: string;
    keywords_text: string;
  }>(
    `SELECT id, doc_id, chunk_index, chunk_text, keywords_text
     FROM tenant_ai_knowledge_chunks
     WHERE tenant_id = $1
     ORDER BY chunk_index ASC`,
    [tenantId]
  );

  const queryLower = cleanQuery.toLowerCase();
  const queryFolded = normalizeFoldedAscii(cleanQuery);
  const queryTokens = extractKeywords(cleanQuery);

  const scored: RagCitationItem[] = [];

  for (const ch of chunksRes.rows) {
    const docMeta = accessibleDocMap.get(ch.doc_id);
    if (!docMeta) continue;

    const textLower = String(ch.chunk_text || '').toLowerCase();
    const textFolded = normalizeFoldedAscii(ch.chunk_text || '');
    const titleFolded = normalizeFoldedAscii(docMeta.title);
    const kwSet = new Set(String(ch.keywords_text || '').split(' ').filter(Boolean));

    let score = 0;

    if (!cleanQuery) {
      score = 1;
    } else {
      if (queryLower.length >= 3 && textLower.includes(queryLower)) {
        score += 12;
      } else if (queryFolded.length >= 3 && textFolded.includes(queryFolded)) {
        score += 9;
      }

      if (queryFolded.length >= 3 && titleFolded.includes(queryFolded)) {
        score += 7;
      }

      for (const tok of queryTokens) {
        if (kwSet.has(tok) || textFolded.includes(tok)) {
          score += 3;
        }
        if (titleFolded.includes(tok)) {
          score += 2;
        }
      }
    }

    if (score > 0) {
      scored.push({
        chunk_id: ch.id,
        doc_id: ch.doc_id,
        title: docMeta.title,
        category: docMeta.category,
        source_type: docMeta.source_type,
        chunk_index: Number(ch.chunk_index || 0),
        snippet: ch.chunk_text.slice(0, 420),
        score: Number(score.toFixed(2)),
      });
    }
  }

  scored.sort((a, b) => b.score - a.score || a.chunk_index - b.chunk_index);

  return {
    query: cleanQuery,
    total_accessible_docs: accessibleDocMap.size,
    filtered_by_department_acl: filteredByAcl,
    citations: scored.slice(0, topK),
  };
}
