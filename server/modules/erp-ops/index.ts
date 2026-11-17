import crypto from 'node:crypto';
import { Router } from 'express';
import { withTenantTransaction } from '../../core/database/transaction.ts';
import { getTenantContext } from '../../core/context/tenant-context.ts';
import {
  requireEntitlement,
  requirePermission,
  requireTenantAuth,
  sendApiError,
  type UserOrgAuthSnapshot,
} from '../../core/security/rbac.ts';
import { maskContactPiiIfDisallowed } from '../../core/security/pii-masker.ts';
import {
  ensureErpOpsSchema,
  parseJsonSafe,
  resolveActorContext,
  resolvePrimaryBranchLegalInfo,
} from './schema.ts';

export const router = Router();

router.use(requireTenantAuth);
router.use(requireEntitlement('erp_cloud_ocr'));
router.use(async (_req, _res, next) => {
  try {
    await ensureErpOpsSchema();
    next();
  } catch (err) {
    next(err);
  }
});

const DEFAULT_STORAGE_QUOTA_BYTES = 20 * 1024 * 1024 * 1024; // 20 GB per tenant

function sanitizePathSegment(raw: string): string {
  return (
    raw
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/[^a-zA-Z0-9._-]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 80) || 'item'
  );
}

function canAccessAclItem(params: {
  visibility: string;
  allowedDepartmentIds: string[];
  creatorId: string | null;
  actorId: string;
  actorRole: string;
  userOrg: UserOrgAuthSnapshot | null;
}): boolean {
  if (params.userOrg?.is_tenant_owner || params.actorRole === 'tenant_admin') {
    return true;
  }
  if (params.creatorId && params.creatorId === params.actorId) {
    return true;
  }
  if (params.visibility === 'private') {
    return false;
  }
  if (params.visibility === 'departments') {
    if (params.allowedDepartmentIds.length === 0) {
      return false;
    }
    const actorDept = params.userOrg?.department_id;
    return Boolean(actorDept && params.allowedDepartmentIds.includes(actorDept));
  }
  return true;
}

function parseStructuredOcrDocument(
  rawText: string,
  docType: string,
  branchLegal: Awaited<ReturnType<typeof resolvePrimaryBranchLegalInfo>>
) {
  const clean = rawText.replace(/\r/g, '\n');

  // Extract 10-digit or 13-digit Vietnamese Tax Code (MST)
  const taxMatches = Array.from(
    clean.matchAll(/(?:MST|Mã số thuế|Tax\s*(?:ID|Code))[:\s#-]*([0-9]{10}(?:-[0-9]{3})?)/gi)
  ).map((m) => m[1]);
  const standaloneTax = Array.from(clean.matchAll(/\b(0[0-9]{9}(?:-[0-9]{3})?)\b/g)).map((m) => m[1]);
  const allTaxCodes = Array.from(new Set([...taxMatches, ...standaloneTax]));
  const counterpartyTaxCode =
    allTaxCodes.find((tc) => tc !== branchLegal.tax_code) || allTaxCodes[0] || null;

  // Extract 12-digit CCCD / Citizen ID
  const cccdMatch = clean.match(/(?:CCCD|CMND|Số định danh|ID\s*No)[:\s#-]*([0-9]{9,12})/i) || clean.match(/\b(0[0-9]{11})\b/);
  const extractedIdNumber = cccdMatch ? cccdMatch[1] : null;

  // Extract Party Name (Counterparty / Bên B / Company Name / Citizen Name)
  let partyName: string | null = null;
  const benBMatch = clean.match(/(?:BÊN\s*B|ĐỐI\s*TÁC|KHÁCH\s*HÀNG|TÊN\s*DOANH\s*NGHIỆP|HỌ\s*VÀ\s*TÊN)[:\s–-]*(.+)/i);
  if (benBMatch?.[1]) {
    partyName = benBMatch[1].split('\n')[0].trim().slice(0, 200);
  } else {
    const companyLine = clean.match(/(CÔNG\s+TY\s+[^\n,;]+)/i);
    if (companyLine?.[1] && companyLine[1].trim().toLowerCase() !== branchLegal.legal_entity_name.toLowerCase()) {
      partyName = companyLine[1].trim().slice(0, 200);
    }
  }

  // Extract Representative
  const repMatch = clean.match(/(?:Đại diện|Người đại diện|Ông\/Bà)[:\s–-]*([^\n,;–-]+)/i);
  const representative = repMatch?.[1]?.trim().slice(0, 140) || null;

  // Extract Address
  const addrMatch = clean.match(/(?:Địa chỉ|Trụ sở|Thường trú)[:\s–-]*([^\n]+)/i);
  const extractedAddress = addrMatch?.[1]?.trim().slice(0, 300) || null;

  // Extract Contract Value in VND
  let contractValueVnd = 0;
  const moneyRegex = /([0-9]{1,3}(?:[.,][0-9]{3})+)\s*(?:VNĐ|VND|đồng|đ)(?=\s|$|[.,;)])/i;
  const mExact = clean.match(moneyRegex);
  if (mExact?.[1]) {
    contractValueVnd = Math.round(Number(mExact[1].replace(/[.,]/g, '')) || 0);
  } else {
    const mTy = clean.match(/([0-9]+(?:[.,][0-9]+)?)\s*tỷ/i);
    const mTrieu = clean.match(/([0-9]+(?:[.,][0-9]+)?)\s*triệu/i);
    if (mTy?.[1]) {
      contractValueVnd = Math.round(Number(mTy[1].replace(',', '.')) * 1_000_000_000);
    } else if (mTrieu?.[1]) {
      contractValueVnd = Math.round(Number(mTrieu[1].replace(',', '.')) * 1_000_000);
    }
  }

  // Extract Dates (DD/MM/YYYY or YYYY-MM-DD)
  const isoDates: string[] = [];
  for (const dm of clean.matchAll(/\b([0-3]?[0-9])[/-]([0-1]?[0-9])[/-](20[0-9]{2})\b/g)) {
    const dd = dm[1].padStart(2, '0');
    const mm = dm[2].padStart(2, '0');
    const yyyy = dm[3];
    isoDates.push(`${yyyy}-${mm}-${dd}`);
  }
  for (const ym of clean.matchAll(/\b(20[0-9]{2})-([0-1][0-9])-([0-3][0-9])\b/g)) {
    isoDates.push(`${ym[1]}-${ym[2]}-${ym[3]}`);
  }

  const normalizedUpper = clean.toLowerCase();
  const branchTaxMatched = Boolean(
    branchLegal.tax_code && clean.includes(branchLegal.tax_code)
  );
  const branchLegalNameMatched = Boolean(
    branchLegal.legal_entity_name &&
      normalizedUpper.includes(branchLegal.legal_entity_name.toLowerCase())
  );

  return {
    doc_type: docType,
    party_name: partyName,
    tax_code: counterpartyTaxCode,
    id_number: extractedIdNumber,
    representative,
    address: extractedAddress,
    contract_value_vnd: contractValueVnd,
    effective_date: isoDates[0] || null,
    expiry_date: isoDates[1] || null,
    branch_verification: {
      branch_id: branchLegal.branch_id,
      expected_legal_entity: branchLegal.legal_entity_name,
      expected_tax_code: branchLegal.tax_code,
      expected_representative: branchLegal.representative_name,
      expected_address: branchLegal.address,
      tax_code_matched: branchTaxMatched,
      legal_name_matched: branchLegalNameMatched,
      verified_status:
        branchTaxMatched || branchLegalNameMatched ? 'verified_party_a' : 'counterparty_only',
    },
  };
}

// ============================================================================
// 1. Tenant-Isolated Cloud Drive (`tenants/{tenant_id}/` + Department ACLs)
// ============================================================================
router.get('/drive', requirePermission('cloud_files_ocr', 'view'), async (req, res) => {
  try {
    const ctx = getTenantContext();
    const folderId = typeof req.query.folder_id === 'string' ? req.query.folder_id.trim() : '';

    const data = await withTenantTransaction(ctx.tenantId, async (client) => {
      const { rbac } = await resolveActorContext(client, ctx.tenantId, ctx.userId);
      const namespacePrefix = `tenants/${ctx.tenantId}/`;

      const [foldersRes, filesRes, deptsRes] = await Promise.all([
        client.query(
          `SELECT * FROM tenant_cloud_folders
           WHERE tenant_id = $1
           ORDER BY name ASC`,
          [ctx.tenantId]
        ),
        client.query(
          `SELECT f.*, fl.name AS folder_name
           FROM tenant_cloud_files f
           LEFT JOIN tenant_cloud_folders fl ON fl.tenant_id = f.tenant_id AND fl.id = f.folder_id
           WHERE f.tenant_id = $1
           ORDER BY f.created_at DESC`,
          [ctx.tenantId]
        ),
        client.query(
          'SELECT id, code, name FROM tenant_departments WHERE tenant_id = $1 AND is_active = true ORDER BY sort_order ASC',
          [ctx.tenantId]
        ),
      ]);

      const visibleFolders = foldersRes.rows
        .map((row) => ({
          ...row,
          allowed_department_ids: parseJsonSafe<string[]>(row.allowed_department_ids, []),
        }))
        .filter((row) =>
          canAccessAclItem({
            visibility: row.visibility,
            allowedDepartmentIds: row.allowed_department_ids,
            creatorId: row.created_by,
            actorId: ctx.userId,
            actorRole: ctx.userRole,
            userOrg: rbac.userOrg,
          })
        );

      const visibleFolderIds = new Set(visibleFolders.map((f) => f.id));

      const allTenantUsedBytes = filesRes.rows.reduce((sum, f) => sum + Number(f.size_bytes || 0), 0);

      const visibleFiles = filesRes.rows
        .map((row) => ({
          ...row,
          size_bytes: Number(row.size_bytes || 0),
          allowed_department_ids: parseJsonSafe<string[]>(row.allowed_department_ids, []),
        }))
        .filter((row) => {
          if (row.folder_id && !visibleFolderIds.has(row.folder_id)) {
            return false;
          }
          if (folderId && folderId !== 'all' && row.folder_id !== folderId) {
            return false;
          }
          return canAccessAclItem({
            visibility: row.visibility,
            allowedDepartmentIds: row.allowed_department_ids,
            creatorId: row.uploaded_by,
            actorId: ctx.userId,
            actorRole: ctx.userRole,
            userOrg: rbac.userOrg,
          });
        });

      return {
        namespace_prefix: namespacePrefix,
        quota: {
          used_bytes: allTenantUsedBytes,
          quota_bytes: DEFAULT_STORAGE_QUOTA_BYTES,
          used_pct: Number(((allTenantUsedBytes / DEFAULT_STORAGE_QUOTA_BYTES) * 100).toFixed(2)),
          visible_files_count: visibleFiles.length,
          visible_folders_count: visibleFolders.length,
        },
        folders: visibleFolders,
        files: visibleFiles,
        departments: deptsRes.rows,
      };
    });

    res.json({ success: true, data });
  } catch (err: any) {
    sendApiError(res, 500, 'CLOUD_DRIVE_LIST_FAILED', err?.message || 'Không thể tải Kho tài liệu Cloud.');
  }
});

router.post('/drive/folders', requirePermission('cloud_files_ocr', 'create'), async (req, res) => {
  try {
    const ctx = getTenantContext();
    const body = req.body || {};
    const name = String(body.name || '').trim();
    if (!name) {
      sendApiError(res, 422, 'FOLDER_NAME_REQUIRED', 'Vui lòng nhập tên thư mục.');
      return;
    }

    const allowedDepts = Array.isArray(body.allowed_department_ids)
      ? body.allowed_department_ids.map((d: unknown) => String(d)).filter(Boolean)
      : [];
    const visibility =
      body.visibility === 'private'
        ? 'private'
        : body.visibility === 'departments' || allowedDepts.length > 0
          ? 'departments'
          : 'company';
    const storagePrefix = `tenants/${ctx.tenantId}/folders/${sanitizePathSegment(name)}/`;

    const created = await withTenantTransaction(ctx.tenantId, async (client) => {
      const id = crypto.randomUUID();
      await client.query(
        `INSERT INTO tenant_cloud_folders (
           id, tenant_id, parent_folder_id, name, storage_prefix,
           visibility, allowed_department_ids, created_by
         ) VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8)`,
        [
          id,
          ctx.tenantId,
          body.parent_folder_id || null,
          name,
          storagePrefix,
          visibility,
          JSON.stringify(allowedDepts),
          ctx.userId,
        ]
      );
      const r = await client.query('SELECT * FROM tenant_cloud_folders WHERE tenant_id = $1 AND id = $2', [
        ctx.tenantId,
        id,
      ]);
      return {
        ...r.rows[0],
        allowed_department_ids: parseJsonSafe<string[]>(r.rows[0].allowed_department_ids, []),
      };
    });

    res.status(201).json({ success: true, data: created });
  } catch (err: any) {
    sendApiError(res, 500, 'CREATE_CLOUD_FOLDER_FAILED', err?.message || 'Không thể tạo thư mục Cloud.');
  }
});

router.post('/drive/files', requirePermission('cloud_files_ocr', 'create'), async (req, res) => {
  try {
    const ctx = getTenantContext();
    const body = req.body || {};
    const name = String(body.name || '').trim();
    if (!name) {
      sendApiError(res, 422, 'FILE_NAME_REQUIRED', 'Vui lòng nhập tên tệp tài liệu.');
      return;
    }

    const versionTag = String(body.version_tag || 'v1.0').trim().slice(0, 30) || 'v1.0';
    const contentPreview = body.content_preview ? String(body.content_preview).slice(0, 8000) : null;
    const sizeBytes = Math.max(
      0,
      Math.round(Number(body.size_bytes ?? (contentPreview ? Buffer.byteLength(contentPreview, 'utf8') : 1024)))
    );
    const allowedDepts = Array.isArray(body.allowed_department_ids)
      ? body.allowed_department_ids.map((d: unknown) => String(d)).filter(Boolean)
      : [];
    const visibility =
      body.visibility === 'private'
        ? 'private'
        : body.visibility === 'departments' || allowedDepts.length > 0
          ? 'departments'
          : 'company';

    const created = await withTenantTransaction(ctx.tenantId, async (client) => {
      let folderPrefix = `tenants/${ctx.tenantId}/root/`;
      let inheritedDepts = allowedDepts;
      let effectiveVisibility = visibility;

      if (body.folder_id) {
        const fRes = await client.query<{
          storage_prefix: string;
          visibility: string;
          allowed_department_ids: unknown;
        }>(
          'SELECT storage_prefix, visibility, allowed_department_ids FROM tenant_cloud_folders WHERE tenant_id = $1 AND id = $2 LIMIT 1',
          [ctx.tenantId, body.folder_id]
        );
        if (fRes.rows[0]) {
          folderPrefix = fRes.rows[0].storage_prefix;
          if (inheritedDepts.length === 0 && fRes.rows[0].visibility === 'departments') {
            inheritedDepts = parseJsonSafe<string[]>(fRes.rows[0].allowed_department_ids, []);
            effectiveVisibility = 'departments';
          }
        }
      }

      const id = crypto.randomUUID();
      const safeFileName = sanitizePathSegment(name);
      const storageKey = `${folderPrefix}${versionTag}_${id.slice(0, 8)}_${safeFileName}`;
      const checksum = crypto
        .createHash('sha256')
        .update(`${ctx.tenantId}:${name}:${versionTag}:${contentPreview || sizeBytes}`)
        .digest('hex');

      await client.query(
        `INSERT INTO tenant_cloud_files (
           id, tenant_id, folder_id, project_id, name, storage_key, mime_type,
           size_bytes, version_tag, visibility, allowed_department_ids,
           checksum_sha256, content_preview, uploaded_by, uploaded_by_name
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::jsonb, $12, $13, $14, $15)`,
        [
          id,
          ctx.tenantId,
          body.folder_id || null,
          body.project_id || null,
          name,
          storageKey,
          body.mime_type ? String(body.mime_type) : 'application/pdf',
          sizeBytes,
          versionTag,
          effectiveVisibility,
          JSON.stringify(inheritedDepts),
          checksum,
          contentPreview,
          ctx.userId,
          ctx.userName || 'Thành viên',
        ]
      );

      const r = await client.query('SELECT * FROM tenant_cloud_files WHERE tenant_id = $1 AND id = $2', [
        ctx.tenantId,
        id,
      ]);
      return {
        ...r.rows[0],
        size_bytes: Number(r.rows[0].size_bytes || 0),
        allowed_department_ids: parseJsonSafe<string[]>(r.rows[0].allowed_department_ids, []),
      };
    });

    res.status(201).json({ success: true, data: created });
  } catch (err: any) {
    sendApiError(res, 500, 'UPLOAD_CLOUD_FILE_FAILED', err?.message || 'Không thể tải tệp lên Cloud Drive.');
  }
});

router.get('/drive/files/:id', requirePermission('cloud_files_ocr', 'view'), async (req, res) => {
  try {
    const ctx = getTenantContext();
    const fileId = req.params.id;

    const outcome = await withTenantTransaction(ctx.tenantId, async (client) => {
      const { rbac } = await resolveActorContext(client, ctx.tenantId, ctx.userId);
      const r = await client.query('SELECT * FROM tenant_cloud_files WHERE tenant_id = $1 AND id = $2 LIMIT 1', [
        ctx.tenantId,
        fileId,
      ]);
      const row = r.rows[0];
      if (!row) return { status: 'not_found' as const };

      const allowedDepts = parseJsonSafe<string[]>(row.allowed_department_ids, []);
      const permitted = canAccessAclItem({
        visibility: row.visibility,
        allowedDepartmentIds: allowedDepts,
        creatorId: row.uploaded_by,
        actorId: ctx.userId,
        actorRole: ctx.userRole,
        userOrg: rbac.userOrg,
      });
      if (!permitted) return { status: 'forbidden_acl' as const };

      return {
        status: 'ok' as const,
        file: {
          ...row,
          size_bytes: Number(row.size_bytes || 0),
          allowed_department_ids: allowedDepts,
        },
      };
    });

    if (outcome.status === 'not_found') {
      sendApiError(res, 404, 'FILE_NOT_FOUND', 'Không tìm thấy tài liệu.');
      return;
    }
    if (outcome.status === 'forbidden_acl') {
      sendApiError(
        res,
        403,
        'FORBIDDEN_DEPARTMENT_ACL',
        'Phòng ban của bạn không được cấp quyền truy cập tài liệu này.'
      );
      return;
    }
    res.json({ success: true, data: outcome.file });
  } catch (err: any) {
    sendApiError(res, 500, 'GET_CLOUD_FILE_FAILED', err?.message || 'Không thể mở tài liệu.');
  }
});

router.delete('/drive/files/:id', requirePermission('cloud_files_ocr', 'delete'), async (req, res) => {
  try {
    const ctx = getTenantContext();
    const fileId = req.params.id;
    const deleted = await withTenantTransaction(ctx.tenantId, async (client) => {
      const r = await client.query('DELETE FROM tenant_cloud_files WHERE tenant_id = $1 AND id = $2', [
        ctx.tenantId,
        fileId,
      ]);
      return r.rowCount > 0;
    });
    if (!deleted) {
      sendApiError(res, 404, 'FILE_NOT_FOUND', 'Không tìm thấy tài liệu.');
      return;
    }
    res.json({ success: true, data: { id: fileId, deleted: true } });
  } catch (err: any) {
    sendApiError(res, 500, 'DELETE_CLOUD_FILE_FAILED', err?.message || 'Không thể xóa tài liệu.');
  }
});

// ============================================================================
// 2. AI OCR Contract & CCCD / Business License Extractor + 1-Click Save
// ============================================================================
router.get('/ocr/extractions', requirePermission('cloud_files_ocr', 'view'), async (_req, res) => {
  try {
    const ctx = getTenantContext();
    const items = await withTenantTransaction(ctx.tenantId, async (client) => {
      const r = await client.query(
        `SELECT * FROM tenant_ocr_extractions
         WHERE tenant_id = $1
         ORDER BY created_at DESC
         LIMIT 50`,
        [ctx.tenantId]
      );
      return r.rows.map((row) => ({
        ...row,
        contract_value_vnd: Number(row.contract_value_vnd || 0),
        branch_verification: parseJsonSafe(row.branch_verification_json, {}),
        extracted_fields: parseJsonSafe(row.extracted_fields_json, {}),
      }));
    });
    res.json({ success: true, data: { items } });
  } catch (err: any) {
    sendApiError(res, 500, 'LIST_OCR_FAILED', err?.message || 'Không thể tải lịch sử bóc tách AI OCR.');
  }
});

router.post('/ocr/extract', requirePermission('cloud_files_ocr', 'create'), async (req, res) => {
  try {
    const ctx = getTenantContext();
    const body = req.body || {};
    const rawText = String(body.raw_text || body.document_text || '').trim();
    if (!rawText) {
      sendApiError(res, 422, 'OCR_TEXT_REQUIRED', 'Vui lòng tải lên hoặc dán nội dung Hợp đồng / CCCD / ĐKKD để bóc tách.');
      return;
    }

    const docType = ['contract', 'cccd', 'business_license', 'invoice'].includes(String(body.doc_type))
      ? String(body.doc_type)
      : 'contract';
    const sourceTitle = String(body.source_title || `Tài liệu OCR ${new Date().toLocaleDateString('vi-VN')}`).trim();

    const extracted = await withTenantTransaction(ctx.tenantId, async (client) => {
      const branchLegal = await resolvePrimaryBranchLegalInfo(client, ctx.tenantId, body.branch_id || null);
      const parsed = parseStructuredOcrDocument(rawText, docType, branchLegal);

      const id = crypto.randomUUID();
      await client.query(
        `INSERT INTO tenant_ocr_extractions (
           id, tenant_id, doc_type, source_file_id, source_title, raw_text,
           extracted_party_name, extracted_tax_code, extracted_id_number,
           extracted_representative, extracted_address, contract_value_vnd,
           effective_date, expiry_date, branch_verification_json, extracted_fields_json, created_by
         ) VALUES (
           $1, $2, $3, $4, $5, $6,
           $7, $8, $9,
           $10, $11, $12,
           $13, $14, $15::jsonb, $16::jsonb, $17
         )`,
        [
          id,
          ctx.tenantId,
          docType,
          body.source_file_id || null,
          sourceTitle,
          rawText,
          parsed.party_name,
          parsed.tax_code,
          parsed.id_number,
          parsed.representative,
          parsed.address,
          parsed.contract_value_vnd,
          parsed.effective_date,
          parsed.expiry_date,
          JSON.stringify(parsed.branch_verification),
          JSON.stringify(parsed),
          ctx.userId,
        ]
      );

      const r = await client.query('SELECT * FROM tenant_ocr_extractions WHERE tenant_id = $1 AND id = $2', [
        ctx.tenantId,
        id,
      ]);
      const row = r.rows[0];
      return {
        ...row,
        contract_value_vnd: Number(row.contract_value_vnd || 0),
        branch_verification: parseJsonSafe(row.branch_verification_json, {}),
        extracted_fields: parseJsonSafe(row.extracted_fields_json, {}),
      };
    });

    res.status(201).json({ success: true, data: extracted });
  } catch (err: any) {
    sendApiError(res, 500, 'OCR_EXTRACT_FAILED', err?.message || 'Không thể bóc tách tài liệu AI OCR.');
  }
});

router.post('/ocr/extractions/:id/save-company', requirePermission('cloud_files_ocr', 'create'), async (req, res) => {
  try {
    const ctx = getTenantContext();
    const ocrId = req.params.id;

    const saved = await withTenantTransaction(ctx.tenantId, async (client) => {
      const oRes = await client.query('SELECT * FROM tenant_ocr_extractions WHERE tenant_id = $1 AND id = $2 LIMIT 1', [
        ctx.tenantId,
        ocrId,
      ]);
      const ocr = oRes.rows[0];
      if (!ocr) return null;

      const compId = crypto.randomUUID();
      const compCode = `B2B-OCR-${Date.now().toString(36).toUpperCase().slice(-5)}`;
      const compName = String(req.body?.name || ocr.extracted_party_name || ocr.source_title).trim();

      await client.query(
        `INSERT INTO tenant_b2b_companies (
           id, tenant_id, code, name, tax_code, billing_address,
           representative_name, owner_user_id, notes
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
        [
          compId,
          ctx.tenantId,
          compCode,
          compName,
          req.body?.tax_code || ocr.extracted_tax_code || null,
          req.body?.billing_address || ocr.extracted_address || null,
          req.body?.representative_name || ocr.extracted_representative || null,
          ctx.userId,
          `Khởi tạo 1 chạm từ AI OCR (${ocr.source_title})`,
        ]
      );

      await client.query(
        'UPDATE tenant_ocr_extractions SET saved_company_id = $3 WHERE tenant_id = $1 AND id = $2',
        [ctx.tenantId, ocrId, compId]
      );

      const cRes = await client.query('SELECT * FROM tenant_b2b_companies WHERE tenant_id = $1 AND id = $2', [
        ctx.tenantId,
        compId,
      ]);
      return cRes.rows[0];
    });

    if (!saved) {
      sendApiError(res, 404, 'OCR_EXTRACTION_NOT_FOUND', 'Không tìm thấy bản ghi OCR.');
      return;
    }
    res.status(201).json({ success: true, data: saved });
  } catch (err: any) {
    sendApiError(res, 500, 'OCR_SAVE_COMPANY_FAILED', err?.message || 'Không thể lưu đối tác vào B2B Companies.');
  }
});

router.post('/ocr/extractions/:id/save-transaction', requirePermission('cloud_files_ocr', 'create'), async (req, res) => {
  try {
    const ctx = getTenantContext();
    const ocrId = req.params.id;

    const saved = await withTenantTransaction(ctx.tenantId, async (client) => {
      const oRes = await client.query('SELECT * FROM tenant_ocr_extractions WHERE tenant_id = $1 AND id = $2 LIMIT 1', [
        ctx.tenantId,
        ocrId,
      ]);
      const ocr = oRes.rows[0];
      if (!ocr) return null;

      const amountVnd = Math.max(
        1,
        Math.round(Number(req.body?.amount_vnd ?? ocr.contract_value_vnd ?? 0))
      );
      const txType = req.body?.tx_type === 'expense' ? 'expense' : 'income';
      const txId = crypto.randomUUID();
      const txCode = `${txType === 'income' ? 'PT' : 'PC'}-OCR-${Date.now().toString(36).toUpperCase().slice(-5)}`;

      await client.query(
        `INSERT INTO tenant_finance_transactions (
           id, tenant_id, tx_code, tx_type, category, amount_vnd, payment_method, status,
           counterparty_name, counterparty_tax_code, company_id, description, created_by
         ) VALUES ($1, $2, $3, $4, 'contract_ocr', $5, 'bank_transfer', 'completed', $6, $7, $8, $9, $10)`,
        [
          txId,
          ctx.tenantId,
          txCode,
          txType,
          amountVnd,
          ocr.extracted_party_name || ocr.source_title,
          ocr.extracted_tax_code || null,
          ocr.saved_company_id || null,
          `Bút toán tự động từ AI OCR: ${ocr.source_title}`,
          ctx.userId,
        ]
      );

      await client.query(
        'UPDATE tenant_ocr_extractions SET saved_transaction_id = $3 WHERE tenant_id = $1 AND id = $2',
        [ctx.tenantId, ocrId, txId]
      );

      const tRes = await client.query('SELECT * FROM tenant_finance_transactions WHERE tenant_id = $1 AND id = $2', [
        ctx.tenantId,
        txId,
      ]);
      return { ...tRes.rows[0], amount_vnd: Number(tRes.rows[0].amount_vnd || 0) };
    });

    if (!saved) {
      sendApiError(res, 404, 'OCR_EXTRACTION_NOT_FOUND', 'Không tìm thấy bản ghi OCR.');
      return;
    }
    res.status(201).json({ success: true, data: saved });
  } catch (err: any) {
    sendApiError(res, 500, 'OCR_SAVE_TX_FAILED', err?.message || 'Không thể lưu bút toán từ AI OCR.');
  }
});

// ============================================================================
// 3. Global Cross-Module Search (`/api/v1/erp-ops/global-search`) & Clean OpenAPI Docs
// ============================================================================
router.get('/global-search', requirePermission('cloud_files_ocr', 'view'), async (req, res) => {
  try {
    const ctx = getTenantContext();
    const q = String(req.query.q || '').trim();
    if (!q) {
      res.json({ success: true, data: { query: '', total_hits: 0, results: [] } });
      return;
    }
    const pattern = `%${q}%`;

    const data = await withTenantTransaction(ctx.tenantId, async (client) => {
      const { rbac, canUnmaskLeads, tenantSettings } = await resolveActorContext(client, ctx.tenantId, ctx.userId);

      const [leadsRes, compRes, dealsRes, projRes, tasksRes, ticketsRes, ordersRes, filesRes] = await Promise.all([
        client.query(
          `SELECT id, name, phone, email, status
           FROM leads
           WHERE tenant_id = $1 AND is_deleted = false
             AND (LOWER(name) LIKE LOWER($2) OR LOWER(COALESCE(phone, '')) LIKE LOWER($2) OR LOWER(COALESCE(email, '')) LIKE LOWER($2))
           LIMIT 10`,
          [ctx.tenantId, pattern]
        ),
        client.query(
          `SELECT id, code, name, tax_code
           FROM tenant_b2b_companies
           WHERE tenant_id = $1 AND (LOWER(name) LIKE LOWER($2) OR LOWER(COALESCE(tax_code, '')) LIKE LOWER($2))
           LIMIT 10`,
          [ctx.tenantId, pattern]
        ),
        client.query(
          `SELECT id, deal_code, title, stage, amount_vnd
           FROM tenant_deals
           WHERE tenant_id = $1 AND (LOWER(title) LIKE LOWER($2) OR LOWER(deal_code) LIKE LOWER($2))
           LIMIT 10`,
          [ctx.tenantId, pattern]
        ),
        client.query(
          `SELECT id, code, name, status
           FROM tenant_projects
           WHERE tenant_id = $1 AND (LOWER(name) LIKE LOWER($2) OR LOWER(code) LIKE LOWER($2))
           LIMIT 10`,
          [ctx.tenantId, pattern]
        ),
        client.query(
          `SELECT id, title, status_key, priority
           FROM tenant_tasks
           WHERE tenant_id = $1 AND LOWER(title) LIKE LOWER($2)
           LIMIT 10`,
          [ctx.tenantId, pattern]
        ),
        client.query(
          `SELECT id, ticket_code, subject, status, priority
           FROM tenant_helpdesk_tickets
           WHERE tenant_id = $1 AND (LOWER(subject) LIKE LOWER($2) OR LOWER(ticket_code) LIKE LOWER($2))
           LIMIT 10`,
          [ctx.tenantId, pattern]
        ),
        client.query(
          `SELECT id, order_code, customer_name, total_vnd, payment_status
           FROM tenant_sales_orders
           WHERE tenant_id = $1 AND (LOWER(order_code) LIKE LOWER($2) OR LOWER(customer_name) LIKE LOWER($2))
           LIMIT 10`,
          [ctx.tenantId, pattern]
        ),
        client.query(
          `SELECT id, name, storage_key, visibility, allowed_department_ids, uploaded_by
           FROM tenant_cloud_files
           WHERE tenant_id = $1 AND LOWER(name) LIKE LOWER($2)
           LIMIT 15`,
          [ctx.tenantId, pattern]
        ),
      ]);

      const results: Array<{
        entity_type: string;
        id: string;
        title: string;
        subtitle: string;
        route: string;
      }> = [];

      for (const l of leadsRes.rows) {
        const masked = maskContactPiiIfDisallowed(l, canUnmaskLeads, tenantSettings);
        results.push({
          entity_type: 'lead',
          id: l.id,
          title: l.name,
          subtitle: `${masked.phone || masked.email || ''} • ${l.status}`,
          route: '/data-list',
        });
      }
      for (const c of compRes.rows) {
        results.push({
          entity_type: 'b2b_company',
          id: c.id,
          title: c.name,
          subtitle: `${c.code} • MST: ${c.tax_code || '—'}`,
          route: '/erp/finance',
        });
      }
      for (const d of dealsRes.rows) {
        results.push({
          entity_type: 'deal',
          id: d.id,
          title: d.title,
          subtitle: `${d.deal_code} • ${Number(d.amount_vnd || 0).toLocaleString('vi-VN')}₫ (${d.stage})`,
          route: '/erp/finance',
        });
      }
      for (const p of projRes.rows) {
        results.push({
          entity_type: 'project',
          id: p.id,
          title: p.name,
          subtitle: `${p.code} • ${p.status}`,
          route: '/erp/projects',
        });
      }
      for (const t of tasksRes.rows) {
        results.push({
          entity_type: 'task',
          id: t.id,
          title: t.title,
          subtitle: `${t.status_key} • ${t.priority}`,
          route: '/erp/projects',
        });
      }
      for (const tk of ticketsRes.rows) {
        results.push({
          entity_type: 'helpdesk_ticket',
          id: tk.id,
          title: tk.subject,
          subtitle: `${tk.ticket_code} • ${tk.status}`,
          route: '/erp/projects',
        });
      }
      for (const so of ordersRes.rows) {
        results.push({
          entity_type: 'sales_order',
          id: so.id,
          title: `${so.order_code} — ${so.customer_name}`,
          subtitle: `${Number(so.total_vnd || 0).toLocaleString('vi-VN')}₫ • ${so.payment_status}`,
          route: '/erp/finance',
        });
      }
      for (const f of filesRes.rows) {
        const depts = parseJsonSafe<string[]>(f.allowed_department_ids, []);
        if (
          canAccessAclItem({
            visibility: f.visibility,
            allowedDepartmentIds: depts,
            creatorId: f.uploaded_by,
            actorId: ctx.userId,
            actorRole: ctx.userRole,
            userOrg: rbac.userOrg,
          })
        ) {
          results.push({
            entity_type: 'cloud_file',
            id: f.id,
            title: f.name,
            subtitle: f.storage_key,
            route: '/erp/cloud-files',
          });
        }
      }

      return {
        query: q,
        total_hits: results.length,
        results,
      };
    });

    res.json({ success: true, data });
  } catch (err: any) {
    sendApiError(res, 500, 'GLOBAL_SEARCH_FAILED', err?.message || 'Không thể thực hiện tìm kiếm liên phân hệ.');
  }
});

router.get('/openapi-docs', requirePermission('cloud_files_ocr', 'view'), async (_req, res) => {
  try {
    const ctx = getTenantContext();
    const spec = await withTenantTransaction(ctx.tenantId, async (client) => {
      const legal = await resolvePrimaryBranchLegalInfo(client, ctx.tenantId);
      const webhooksRes = await client.query<{ id: string; name: string; webhook_type: string; url: string | null }>(
        'SELECT id, name, webhook_type, url FROM tenant_webhooks WHERE tenant_id = $1 LIMIT 20',
        [ctx.tenantId]
      );

      return {
        openapi: '3.1.0',
        info: {
          title: `DOMATION Enterprise Multi-Tenant API — ${legal.legal_entity_name}`,
          version: '2.0.0',
          description:
            'Tài liệu OpenAPI 3.1 & Chuẩn xác thực HMAC-SHA256 Webhook cô lập dữ liệu tuyệt đối theo từng Doanh nghiệp.',
        },
        tenant_metadata: {
          tenant_slug: ctx.tenantSlug,
          legal_entity_name: legal.legal_entity_name,
          tax_code: legal.tax_code,
          required_headers: ['Authorization: Bearer <ACCESS_TOKEN>', `X-Tenant-Slug: ${ctx.tenantSlug}`],
          webhook_signature_header: 'X-Domation-Signature-256',
        },
        endpoints_catalog: [
          { method: 'GET', path: '/api/v1/leads', module: 'CRM Master Contact 360°' },
          { method: 'POST', path: '/api/v1/leads', module: 'CRM Lead Intake & Fair-Share Routing' },
          { method: 'GET', path: '/api/v1/audiences', module: 'Tệp Data & Tệp Logic Động' },
          { method: 'GET', path: '/api/v1/projects', module: 'Dự án Kanban / Gantt / Whiteboard & Helpdesk SLA' },
          { method: 'GET', path: '/api/v1/workchat/bootstrap', module: 'WorkChat & Bảng tin Nội bộ' },
          { method: 'GET', path: '/api/v1/finance/dashboard', module: 'B2B Deals, Báo giá, Đơn bán SO/PO & Dòng tiền P&L' },
          { method: 'POST', path: '/api/v1/inventory/pos/checkout', module: 'Kho vận FIFO, Xuất kho Lô hạn & POS' },
          { method: 'POST', path: '/api/v1/erp-ops/ocr/extract', module: 'Cloud Drive ACL & AI OCR Hợp đồng / CCCD' },
          { method: 'GET', path: '/api/v1/erp-ops/global-search', module: 'Spotlight Tìm kiếm Đa phân hệ' },
        ],
        configured_webhooks: webhooksRes.rows,
      };
    });

    res.json({ success: true, data: spec });
  } catch (err: any) {
    sendApiError(res, 500, 'OPENAPI_SPEC_FAILED', err?.message || 'Không thể tải tài liệu OpenAPI.');
  }
});

export default router;
