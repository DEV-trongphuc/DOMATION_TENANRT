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

function sanitizeCategoryKey(raw: string): string {
  return (
    raw
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .toLowerCase()
      .replace(/[^a-z0-9_]+/g, '_')
      .replace(/^_+|_+$/g, '')
      .slice(0, 64) || 'general'
  );
}

function canAccessAclItem(params: {
  visibility: string;
  allowedDepartmentIds: string[];
  allowedRoleIds?: string[];
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
  const roleList = params.allowedRoleIds || [];
  const roleMatched =
    roleList.length > 0 &&
    (roleList.includes(params.actorRole) ||
      Boolean(params.userOrg?.role_id && roleList.includes(params.userOrg.role_id)));

  if (params.visibility === 'departments') {
    if (roleMatched) return true;
    if (params.allowedDepartmentIds.length === 0) {
      return false;
    }
    const actorDept = params.userOrg?.department_id;
    return Boolean(actorDept && params.allowedDepartmentIds.includes(actorDept));
  }
  if (roleList.length > 0 && !roleMatched) {
    return false;
  }
  return true;
}

function normalizeDateTokenToIso(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const trimmed = raw.trim();
  const ymd = trimmed.match(/\b((?:19|20)[0-9]{2})[-/.]([0-1]?[0-9])[-/.]([0-3]?[0-9])\b/);
  if (ymd) {
    return `${ymd[1]}-${ymd[2].padStart(2, '0')}-${ymd[3].padStart(2, '0')}`;
  }
  const dmy = trimmed.match(/\b([0-3]?[0-9])[/-]([0-1]?[0-9])[/-]((?:19|20)[0-9]{2})\b/);
  if (dmy) {
    return `${dmy[3]}-${dmy[2].padStart(2, '0')}-${dmy[1].padStart(2, '0')}`;
  }
  return null;
}

function parseVndAmountFromFragment(fragment: string): number {
  const mExact = fragment.match(/([0-9]{1,3}(?:[.,][0-9]{3})+)\s*(?:VNĐ|VND|đồng|đ)?/i);
  if (mExact?.[1]) {
    return Math.round(Number(mExact[1].replace(/[.,]/g, '')) || 0);
  }
  const mTy = fragment.match(/([0-9]+(?:[.,][0-9]+)?)\s*tỷ/i);
  if (mTy?.[1]) {
    return Math.round(Number(mTy[1].replace(',', '.')) * 1_000_000_000);
  }
  const mTrieu = fragment.match(/([0-9]+(?:[.,][0-9]+)?)\s*triệu/i);
  if (mTrieu?.[1]) {
    return Math.round(Number(mTrieu[1].replace(',', '.')) * 1_000_000);
  }
  return 0;
}

function parseIdCardDocument(rawText: string) {
  const clean = rawText.replace(/\r/g, '\n');

  const passportMatch =
    clean.match(/(?:Hộ\s*chiếu|Passport(?:\s*No)?|Số\s*hộ\s*chiếu)[:\s#-]*([A-Z][0-9]{7,8})/i) ||
    clean.match(/\b([BCEGKMNP][0-9]{7,8})\b/);
  const passport = passportMatch ? passportMatch[1].toUpperCase() : null;

  const cccdMatch =
    clean.match(/(?:CCCD|CMND|Số\s*(?:định\s*danh|CCCD|CMND|thẻ)|ID\s*No|No\.?)[:\s#-]*([0-9]{9,12})/i) ||
    clean.match(/\b(0[0-9]{11})\b/) ||
    clean.match(/\b([0-9]{9})\b/);
  const citizenId = cccdMatch ? cccdMatch[1] : null;

  const docType = passport && !citizenId ? 'passport' : 'cccd';

  const nameMatch = clean.match(
    /(?:Họ\s*(?:và\s*tên|chữ\s*đệm\s*và\s*tên|tên)|Full\s*name|Surname\s*and\s*given\s*names)[:\s/–-]*([^\n]+)/i
  );
  const fullName = nameMatch?.[1]?.trim().replace(/\s+/g, ' ').slice(0, 150) || null;

  const dobLineMatch = clean.match(
    /(?:Ngày\s*(?:,\s*tháng,\s*năm\s*)?sinh|Sinh\s*ngày|Date\s*of\s*birth|DOB)[:\s/–-]*([^\n]+)/i
  );
  const birthday = normalizeDateTokenToIso(dobLineMatch?.[1] || '');

  const genderMatch = clean.match(/(?:Giới\s*tính|Sex|Gender)[:\s/–-]*(Nam|Nữ|Nu|Male|Female)/i);
  let gender: string | null = null;
  if (genderMatch?.[1]) {
    const g = genderMatch[1].toLowerCase();
    gender = g === 'nam' || g === 'male' ? 'Nam' : 'Nữ';
  }

  const natMatch = clean.match(/(?:Quốc\s*tịch|Nationality)[:\s/–-]*([^\n,;]+)/i);
  const nationality = natMatch?.[1]?.trim().slice(0, 80) || (citizenId ? 'Việt Nam' : null);

  const originMatch = clean.match(/(?:Quê\s*quán|Place\s*of\s*origin)[:\s/–-]*([^\n]+)/i);
  const placeOfOrigin = originMatch?.[1]?.trim().slice(0, 250) || null;

  const addrMatch = clean.match(
    /(?:Nơi\s*thường\s*trú|Thường\s*trú|Place\s*of\s*residence|Địa\s*chỉ)[:\s/–-]*([^\n]+)/i
  );
  const address = addrMatch?.[1]?.trim().slice(0, 300) || null;

  const issueDateMatch = clean.match(/(?:Ngày\s*cấp|Date\s*of\s*issue)[:\s/–-]*([^\n]+)/i);
  const issueDate = normalizeDateTokenToIso(issueDateMatch?.[1] || '');

  const expiryDateMatch = clean.match(
    /(?:Có\s*giá\s*trị\s*đến|Ngày\s*hết\s*hạn|Date\s*of\s*expiry|Expiry\s*date)[:\s/–-]*([^\n]+)/i
  );
  const expiryDate = normalizeDateTokenToIso(expiryDateMatch?.[1] || '');

  const issuePlaceMatch = clean.match(/(?:Nơi\s*cấp|Cơ\s*quan\s*cấp|Place\s*of\s*issue)[:\s/–-]*([^\n]+)/i);
  const defaultIssuePlace = clean.match(/Cục\s+Cảnh\s+sát[^\n]*/i)?.[0] || null;
  const issuePlace = (issuePlaceMatch?.[1]?.trim() || defaultIssuePlace || '').slice(0, 200) || null;

  return {
    document_type: docType,
    full_name: fullName,
    citizen_id: citizenId,
    passport,
    birthday,
    gender,
    nationality,
    place_of_origin: placeOfOrigin,
    address,
    issue_date: issueDate,
    expiry_date: expiryDate,
    issue_place: issuePlace,
  };
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
  const cccdMatch =
    clean.match(/(?:CCCD|CMND|Số định danh|ID\s*No)[:\s#-]*([0-9]{9,12})/i) ||
    clean.match(/\b(0[0-9]{11})\b/);
  const extractedIdNumber = cccdMatch ? cccdMatch[1] : null;

  // Extract Party Name (Counterparty / Bên B / Company Name / Citizen Name)
  let partyName: string | null = null;
  const benBMatch = clean.match(
    /(?:BÊN\s*B|ĐỐI\s*TÁC|KHÁCH\s*HÀNG|TÊN\s*DOANH\s*NGHIỆP|HỌ\s*VÀ\s*TÊN)[:\s–-]*(.+)/i
  );
  if (benBMatch?.[1]) {
    partyName = benBMatch[1].split('\n')[0].trim().slice(0, 200);
  } else {
    const companyLine = clean.match(/(CÔNG\s+TY\s+[^\n,;]+)/i);
    if (
      companyLine?.[1] &&
      companyLine[1].trim().toLowerCase() !== branchLegal.legal_entity_name.toLowerCase()
    ) {
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
  const branchTaxMatched = Boolean(branchLegal.tax_code && clean.includes(branchLegal.tax_code));
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

function parseContractMilestonesAndLegal(
  rawText: string,
  branchLegal: Awaited<ReturnType<typeof resolvePrimaryBranchLegalInfo>>
) {
  const base = parseStructuredOcrDocument(rawText, 'contract', branchLegal);
  const clean = rawText.replace(/\r/g, '\n');

  const codeMatch =
    clean.match(/(?:Số|Hợp\s*đồng\s*số|Contract\s*No\.?)[:\s#-]*([A-Z0-9/_-]{3,40})/i) ||
    clean.match(/\b([0-9]{1,4}\/[0-9]{4}\/[A-Z0-9-]+|HĐKT-[A-Z0-9-]+)\b/i);
  const contractCode = codeMatch ? codeMatch[1].trim() : null;

  const benAMatch = clean.match(/BÊN\s*A[:\s–-]*([^\n]+)/i);
  const partyAName = benAMatch?.[1]?.trim().slice(0, 200) || branchLegal.legal_entity_name;

  const phoneMatch = clean.match(/(?:Điện\s*thoại|Phone|Hotline|SĐT)[:\s–-]*(0[0-9\s.-]{8,13})/i);
  const partyPhone = phoneMatch ? phoneMatch[1].replace(/[^0-9]/g, '') : null;
  const emailMatch = clean.match(/\b([a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,})\b/);
  const partyEmail = emailMatch ? emailMatch[1] : null;

  const milestones: Array<{
    tranche_no: number;
    name: string;
    percentage: number;
    amount_vnd: number;
    due_date: string | null;
    inferred: boolean;
  }> = [];

  const lines = clean.split('\n').map((l) => l.trim()).filter(Boolean);
  for (const line of lines) {
    const mTranche = line.match(
      /^(?:[-*•]\s*)?(?:Đợt|Lần|Giai\s*đoạn|Thanh\s*toán\s*đợt|Tranche)\s*([0-9]{1,2})[:\s–-]*(.+)$/i
    );
    if (!mTranche) continue;
    const trancheNo = Number(mTranche[1]) || milestones.length + 1;
    const desc = mTranche[2].trim();
    const pctMatch = desc.match(/([0-9]{1,3}(?:[.,][0-9]+)?)\s*%/);
    const pct = pctMatch ? Math.min(100, Number(pctMatch[1].replace(',', '.'))) : 0;
    let amt = parseVndAmountFromFragment(desc);
    if (!amt && pct > 0 && base.contract_value_vnd > 0) {
      amt = Math.round((base.contract_value_vnd * pct) / 100);
    }
    const computedPct =
      pct > 0
        ? pct
        : amt > 0 && base.contract_value_vnd > 0
          ? Number(((amt / base.contract_value_vnd) * 100).toFixed(1))
          : 0;
    const dueDate = normalizeDateTokenToIso(desc);

    milestones.push({
      tranche_no: trancheNo,
      name: `Đợt ${trancheNo}: ${desc.slice(0, 120)}`,
      percentage: computedPct,
      amount_vnd: amt,
      due_date: dueDate,
      inferred: false,
    });
  }

  if (milestones.length === 0 && base.contract_value_vnd > 0) {
    const firstAmt = Math.round(base.contract_value_vnd * 0.3);
    const secondAmt = Math.max(0, base.contract_value_vnd - firstAmt);
    milestones.push(
      {
        tranche_no: 1,
        name: 'Đợt 1: Tạm ứng sau khi ký Hợp đồng (30%)',
        percentage: 30,
        amount_vnd: firstAmt,
        due_date: base.effective_date,
        inferred: true,
      },
      {
        tranche_no: 2,
        name: 'Đợt 2: Nghiệm thu & quyết toán (70%)',
        percentage: 70,
        amount_vnd: secondAmt,
        due_date: base.expiry_date,
        inferred: true,
      }
    );
  }

  return {
    ...base,
    contract_code: contractCode,
    start_date: base.effective_date,
    end_date: base.expiry_date,
    party_a: {
      legal_name: partyAName,
      expected_legal_entity: branchLegal.legal_entity_name,
      expected_tax_code: branchLegal.tax_code,
      tax_code_matched: base.branch_verification.tax_code_matched,
      legal_name_matched: base.branch_verification.legal_name_matched,
      verified_status: base.branch_verification.verified_status,
    },
    party_b: {
      name: base.party_name,
      tax_code: base.tax_code,
      id_number: base.id_number,
      representative: base.representative,
      address: base.address,
      phone: partyPhone,
      email: partyEmail,
    },
    payment_milestones: milestones,
  };
}

function escapeCsvCell(val: unknown): string {
  const s = val === null || val === undefined ? '' : String(val);
  if (/[",\n\r]/.test(s)) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

type TxClient = Parameters<Parameters<typeof withTenantTransaction>[1]>[0];

async function applyIdFieldsToLeadInTx(
  client: TxClient,
  params: {
    tenantId: string;
    leadId: string;
    ocrId: string;
    actorId: string;
    actorRole: string;
    actorName: string;
    fields: {
      full_name?: string | null;
      citizen_id?: string | null;
      passport?: string | null;
      birthday?: string | null;
      gender?: string | null;
      nationality?: string | null;
      address?: string | null;
      issue_date?: string | null;
      expiry_date?: string | null;
      issue_place?: string | null;
    };
  }
) {
  const leadRes = await client.query<{
    id: string;
    name: string;
    phone: string | null;
    email: string | null;
    custom_fields: unknown;
  }>('SELECT id, name, phone, email, custom_fields FROM leads WHERE tenant_id = $1 AND id = $2 LIMIT 1', [
    params.tenantId,
    params.leadId,
  ]);
  const lead = leadRes.rows[0];
  if (!lead) return null;

  const existingCf = parseJsonSafe<Record<string, unknown>>(lead.custom_fields, {});
  const nextCf: Record<string, unknown> = { ...existingCf };
  const f = params.fields;

  if (f.citizen_id) nextCf.citizen_id = f.citizen_id;
  if (f.passport) nextCf.passport = f.passport;
  if (f.birthday) nextCf.birthday = f.birthday;
  if (f.gender) nextCf.gender = f.gender;
  if (f.nationality) nextCf.nationality = f.nationality;
  if (f.address) nextCf.address = f.address;
  if (f.issue_date) nextCf.issue_date = f.issue_date;
  if (f.expiry_date) nextCf.expiry_date = f.expiry_date;
  if (f.issue_place) nextCf.issue_place = f.issue_place;
  nextCf.kyc_ocr_extraction_id = params.ocrId;
  nextCf.kyc_verified_at = new Date().toISOString();

  const nextName = f.full_name && f.full_name.trim() ? f.full_name.trim() : lead.name;

  await client.query(
    `UPDATE leads
     SET name = $3,
         custom_fields = $4::jsonb,
         last_engaged_at = clock_timestamp(),
         updated_at = clock_timestamp()
     WHERE tenant_id = $1 AND id = $2`,
    [params.tenantId, params.leadId, nextName, JSON.stringify(nextCf)]
  );

  await client.query(
    `INSERT INTO lead_timeline_events (
       id, tenant_id, lead_id, event_type, event_category,
       actor_id, actor_role, actor_name, title, content, metadata
     ) VALUES ($1, $2, $3, 'kyc_id_extracted', 'system', $4, $5, $6, $7, $8, $9::jsonb)`,
    [
      crypto.randomUUID(),
      params.tenantId,
      params.leadId,
      params.actorId,
      params.actorRole,
      params.actorName,
      'Cập nhật định danh CCCD / Hộ chiếu bằng DOM Vision OCR',
      `Họ tên: ${nextName} • Số giấy tờ: ${f.citizen_id || f.passport || '—'}`,
      JSON.stringify({ ocr_extraction_id: params.ocrId, fields: f }),
    ]
  );

  const updatedRes = await client.query(
    'SELECT id, name, phone, email, status, lifecycle_stage, custom_fields, updated_at FROM leads WHERE tenant_id = $1 AND id = $2 LIMIT 1',
    [params.tenantId, params.leadId]
  );
  return updatedRes.rows[0] || null;
}

// ============================================================================
// 1. Tenant-Isolated Cloud Drive (`tenants/{tenant_id}/` + Department & Category ACLs)
// ============================================================================
router.get('/drive', requirePermission('cloud_files_ocr', 'view'), async (req, res) => {
  try {
    const ctx = getTenantContext();
    const folderId = typeof req.query.folder_id === 'string' ? req.query.folder_id.trim() : '';
    const categoryKey = typeof req.query.category_key === 'string' ? req.query.category_key.trim() : '';
    const projectId = typeof req.query.project_id === 'string' ? req.query.project_id.trim() : '';
    const leadId = typeof req.query.lead_id === 'string' ? req.query.lead_id.trim() : '';
    const searchQ = typeof req.query.q === 'string' ? req.query.q.trim().toLowerCase() : '';

    const data = await withTenantTransaction(ctx.tenantId, async (client) => {
      const { rbac } = await resolveActorContext(client, ctx.tenantId, ctx.userId);
      const namespacePrefix = `tenants/${ctx.tenantId}/`;

      const [foldersRes, filesRes, catsRes, deptsRes] = await Promise.all([
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
          `SELECT * FROM tenant_cloud_file_categories
           WHERE tenant_id = $1
           ORDER BY sort_order ASC, created_at ASC`,
          [ctx.tenantId]
        ),
        client.query(
          'SELECT id, code, name FROM tenant_departments WHERE tenant_id = $1 AND is_active = true ORDER BY sort_order ASC',
          [ctx.tenantId]
        ),
      ]);

      const parsedCategories = catsRes.rows.map((row) => ({
        ...row,
        sort_order: Number(row.sort_order || 0),
        allowed_department_ids: parseJsonSafe<string[]>(row.allowed_department_ids, []),
        allowed_role_ids: parseJsonSafe<string[]>(row.allowed_role_ids, []),
      }));

      const categoryMap = new Map(parsedCategories.map((c) => [String(c.category_key), c]));

      const visibleCategories = parsedCategories.filter((cat) =>
        canAccessAclItem({
          visibility: cat.visibility,
          allowedDepartmentIds: cat.allowed_department_ids,
          allowedRoleIds: cat.allowed_role_ids,
          creatorId: cat.created_by,
          actorId: ctx.userId,
          actorRole: ctx.userRole,
          userOrg: rbac.userOrg,
        })
      );

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
          category_key: row.category_key || 'general',
          size_bytes: Number(row.size_bytes || 0),
          allowed_department_ids: parseJsonSafe<string[]>(row.allowed_department_ids, []),
        }))
        .filter((row) => {
          if (row.folder_id && !visibleFolderIds.has(row.folder_id)) {
            return false;
          }
          const linkedCat = categoryMap.get(String(row.category_key));
          if (linkedCat) {
            const catPermitted = canAccessAclItem({
              visibility: linkedCat.visibility,
              allowedDepartmentIds: linkedCat.allowed_department_ids,
              allowedRoleIds: linkedCat.allowed_role_ids,
              creatorId: linkedCat.created_by,
              actorId: ctx.userId,
              actorRole: ctx.userRole,
              userOrg: rbac.userOrg,
            });
            if (!catPermitted) return false;
          }
          if (folderId && folderId !== 'all' && row.folder_id !== folderId) {
            return false;
          }
          if (categoryKey && categoryKey !== 'all' && row.category_key !== categoryKey) {
            return false;
          }
          if (projectId && projectId !== 'all' && row.project_id !== projectId) {
            return false;
          }
          if (leadId && row.lead_id !== leadId) {
            return false;
          }
          if (searchQ && !String(row.name || '').toLowerCase().includes(searchQ)) {
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
        categories: visibleCategories,
        departments: deptsRes.rows,
      };
    });

    res.json({ success: true, data });
  } catch (err: any) {
    sendApiError(res, 500, 'CLOUD_DRIVE_LIST_FAILED', err?.message || 'Không thể tải Kho tài liệu Cloud.');
  }
});

// ============================================================================
// 1B. File Category ACL Manager (`tenant_cloud_file_categories`)
// ============================================================================
router.get('/drive/categories', requirePermission('cloud_files_ocr', 'view'), async (_req, res) => {
  try {
    const ctx = getTenantContext();
    const items = await withTenantTransaction(ctx.tenantId, async (client) => {
      const { rbac } = await resolveActorContext(client, ctx.tenantId, ctx.userId);
      const r = await client.query(
        `SELECT * FROM tenant_cloud_file_categories
         WHERE tenant_id = $1
         ORDER BY sort_order ASC, created_at ASC`,
        [ctx.tenantId]
      );
      return r.rows
        .map((row) => ({
          ...row,
          sort_order: Number(row.sort_order || 0),
          allowed_department_ids: parseJsonSafe<string[]>(row.allowed_department_ids, []),
          allowed_role_ids: parseJsonSafe<string[]>(row.allowed_role_ids, []),
        }))
        .filter((cat) =>
          canAccessAclItem({
            visibility: cat.visibility,
            allowedDepartmentIds: cat.allowed_department_ids,
            allowedRoleIds: cat.allowed_role_ids,
            creatorId: cat.created_by,
            actorId: ctx.userId,
            actorRole: ctx.userRole,
            userOrg: rbac.userOrg,
          })
        );
    });
    res.json({ success: true, data: { items } });
  } catch (err: any) {
    sendApiError(res, 500, 'LIST_FILE_CATEGORIES_FAILED', err?.message || 'Không thể tải danh mục phân loại tệp.');
  }
});

router.post('/drive/categories', requirePermission('cloud_files_ocr', 'create'), async (req, res) => {
  try {
    const ctx = getTenantContext();
    const body = req.body || {};
    const label = String(body.label || '').trim();
    if (!label) {
      sendApiError(res, 422, 'CATEGORY_LABEL_REQUIRED', 'Vui lòng nhập tên danh mục tài liệu.');
      return;
    }

    const categoryKey = sanitizeCategoryKey(String(body.category_key || label));
    const iconType = String(body.icon_type || 'folder').trim().slice(0, 40) || 'folder';
    const allowedDepts = Array.isArray(body.allowed_department_ids)
      ? body.allowed_department_ids.map((d: unknown) => String(d)).filter(Boolean)
      : [];
    const allowedRoles = Array.isArray(body.allowed_role_ids)
      ? body.allowed_role_ids.map((r: unknown) => String(r)).filter(Boolean)
      : [];
    const visibility =
      body.visibility === 'private'
        ? 'private'
        : body.visibility === 'departments' || allowedDepts.length > 0
          ? 'departments'
          : 'company';
    const sortOrder = Math.round(Number(body.sort_order || 0));

    const outcome = await withTenantTransaction(ctx.tenantId, async (client) => {
      const dup = await client.query<{ id: string }>(
        'SELECT id FROM tenant_cloud_file_categories WHERE tenant_id = $1 AND category_key = $2 LIMIT 1',
        [ctx.tenantId, categoryKey]
      );
      if (dup.rows[0]) {
        return { status: 'duplicate' as const };
      }

      const id = crypto.randomUUID();
      await client.query(
        `INSERT INTO tenant_cloud_file_categories (
           id, tenant_id, category_key, label, icon_type, visibility,
           allowed_department_ids, allowed_role_ids, sort_order, created_by
         ) VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8::jsonb, $9, $10)`,
        [
          id,
          ctx.tenantId,
          categoryKey,
          label,
          iconType,
          visibility,
          JSON.stringify(allowedDepts),
          JSON.stringify(allowedRoles),
          sortOrder,
          ctx.userId,
        ]
      );

      const r = await client.query(
        'SELECT * FROM tenant_cloud_file_categories WHERE tenant_id = $1 AND id = $2',
        [ctx.tenantId, id]
      );
      const row = r.rows[0];
      return {
        status: 'ok' as const,
        category: {
          ...row,
          sort_order: Number(row.sort_order || 0),
          allowed_department_ids: parseJsonSafe<string[]>(row.allowed_department_ids, []),
          allowed_role_ids: parseJsonSafe<string[]>(row.allowed_role_ids, []),
        },
      };
    });

    if (outcome.status === 'duplicate') {
      sendApiError(res, 409, 'CATEGORY_KEY_EXISTS', `Mã danh mục "${categoryKey}" đã tồn tại.`);
      return;
    }
    res.status(201).json({ success: true, data: outcome.category });
  } catch (err: any) {
    sendApiError(res, 500, 'CREATE_FILE_CATEGORY_FAILED', err?.message || 'Không thể tạo danh mục tài liệu.');
  }
});

router.patch('/drive/categories/:id', requirePermission('cloud_files_ocr', 'edit'), async (req, res) => {
  try {
    const ctx = getTenantContext();
    const catId = req.params.id;
    const body = req.body || {};

    const updated = await withTenantTransaction(ctx.tenantId, async (client) => {
      const existing = await client.query(
        'SELECT * FROM tenant_cloud_file_categories WHERE tenant_id = $1 AND id = $2 LIMIT 1',
        [ctx.tenantId, catId]
      );
      if (!existing.rows[0]) return null;
      const cur = existing.rows[0];

      const nextLabel = body.label !== undefined ? String(body.label).trim() || cur.label : cur.label;
      const nextKey =
        body.category_key !== undefined
          ? sanitizeCategoryKey(String(body.category_key))
          : cur.category_key;
      const nextIcon = body.icon_type !== undefined ? String(body.icon_type).trim() : cur.icon_type;
      const nextDepts = Array.isArray(body.allowed_department_ids)
        ? body.allowed_department_ids.map((d: unknown) => String(d)).filter(Boolean)
        : parseJsonSafe<string[]>(cur.allowed_department_ids, []);
      const nextRoles = Array.isArray(body.allowed_role_ids)
        ? body.allowed_role_ids.map((r: unknown) => String(r)).filter(Boolean)
        : parseJsonSafe<string[]>(cur.allowed_role_ids, []);
      const nextVisibility =
        body.visibility !== undefined
          ? ['company', 'departments', 'private'].includes(String(body.visibility))
            ? String(body.visibility)
            : cur.visibility
          : cur.visibility;
      const nextSort =
        body.sort_order !== undefined ? Math.round(Number(body.sort_order)) : Number(cur.sort_order || 0);

      await client.query(
        `UPDATE tenant_cloud_file_categories
         SET category_key = $3,
             label = $4,
             icon_type = $5,
             visibility = $6,
             allowed_department_ids = $7::jsonb,
             allowed_role_ids = $8::jsonb,
             sort_order = $9,
             updated_at = clock_timestamp()
         WHERE tenant_id = $1 AND id = $2`,
        [
          ctx.tenantId,
          catId,
          nextKey,
          nextLabel,
          nextIcon,
          nextVisibility,
          JSON.stringify(nextDepts),
          JSON.stringify(nextRoles),
          nextSort,
        ]
      );

      if (nextKey !== cur.category_key) {
        await client.query(
          `UPDATE tenant_cloud_files
           SET category_key = $3,
               updated_at = clock_timestamp()
           WHERE tenant_id = $1 AND category_key = $2`,
          [ctx.tenantId, cur.category_key, nextKey]
        );
      }

      const r = await client.query(
        'SELECT * FROM tenant_cloud_file_categories WHERE tenant_id = $1 AND id = $2',
        [ctx.tenantId, catId]
      );
      const row = r.rows[0];
      return {
        ...row,
        sort_order: Number(row.sort_order || 0),
        allowed_department_ids: parseJsonSafe<string[]>(row.allowed_department_ids, []),
        allowed_role_ids: parseJsonSafe<string[]>(row.allowed_role_ids, []),
      };
    });

    if (!updated) {
      sendApiError(res, 404, 'CATEGORY_NOT_FOUND', 'Không tìm thấy danh mục tài liệu.');
      return;
    }
    res.json({ success: true, data: updated });
  } catch (err: any) {
    sendApiError(res, 500, 'UPDATE_FILE_CATEGORY_FAILED', err?.message || 'Không thể cập nhật danh mục tài liệu.');
  }
});

router.delete('/drive/categories/:id', requirePermission('cloud_files_ocr', 'delete'), async (req, res) => {
  try {
    const ctx = getTenantContext();
    const catId = req.params.id;
    const deleted = await withTenantTransaction(ctx.tenantId, async (client) => {
      const cur = await client.query<{ id: string; category_key: string }>(
        'SELECT id, category_key FROM tenant_cloud_file_categories WHERE tenant_id = $1 AND id = $2 LIMIT 1',
        [ctx.tenantId, catId]
      );
      if (!cur.rows[0]) return false;

      await client.query(
        `UPDATE tenant_cloud_files
         SET category_key = 'general',
             updated_at = clock_timestamp()
         WHERE tenant_id = $1 AND category_key = $2`,
        [ctx.tenantId, cur.rows[0].category_key]
      );
      await client.query('DELETE FROM tenant_cloud_file_categories WHERE tenant_id = $1 AND id = $2', [
        ctx.tenantId,
        catId,
      ]);
      return true;
    });

    if (!deleted) {
      sendApiError(res, 404, 'CATEGORY_NOT_FOUND', 'Không tìm thấy danh mục tài liệu.');
      return;
    }
    res.json({ success: true, data: { id: catId, deleted: true } });
  } catch (err: any) {
    sendApiError(res, 500, 'DELETE_FILE_CATEGORY_FAILED', err?.message || 'Không thể xóa danh mục tài liệu.');
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
    const categoryKey = body.category_key ? sanitizeCategoryKey(String(body.category_key)) : 'general';
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

      if (inheritedDepts.length === 0 && categoryKey !== 'general') {
        const catRes = await client.query<{
          visibility: string;
          allowed_department_ids: unknown;
        }>(
          'SELECT visibility, allowed_department_ids FROM tenant_cloud_file_categories WHERE tenant_id = $1 AND category_key = $2 LIMIT 1',
          [ctx.tenantId, categoryKey]
        );
        if (catRes.rows[0] && catRes.rows[0].visibility === 'departments') {
          inheritedDepts = parseJsonSafe<string[]>(catRes.rows[0].allowed_department_ids, []);
          effectiveVisibility = 'departments';
        }
      }

      const id = crypto.randomUUID();
      const safeFileName = sanitizePathSegment(name);
      const storageKey = `${folderPrefix}${versionTag}_${id.slice(0, 8)}_${safeFileName}`;
      const fileUrl = body.file_url ? String(body.file_url).trim() : null;
      const checksum = crypto
        .createHash('sha256')
        .update(`${ctx.tenantId}:${name}:${versionTag}:${contentPreview || sizeBytes}`)
        .digest('hex');

      await client.query(
        `INSERT INTO tenant_cloud_files (
           id, tenant_id, folder_id, project_id, lead_id, category_key,
           name, storage_key, file_url, mime_type,
           size_bytes, version_tag, visibility, allowed_department_ids,
           checksum_sha256, content_preview, uploaded_by, uploaded_by_name
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14::jsonb, $15, $16, $17, $18)`,
        [
          id,
          ctx.tenantId,
          body.folder_id || null,
          body.project_id || null,
          body.lead_id || null,
          categoryKey,
          name,
          storageKey,
          fileUrl,
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
        category_key: r.rows[0].category_key || 'general',
        size_bytes: Number(r.rows[0].size_bytes || 0),
        allowed_department_ids: parseJsonSafe<string[]>(r.rows[0].allowed_department_ids, []),
      };
    });

    res.status(201).json({ success: true, data: created });
  } catch (err: any) {
    sendApiError(res, 500, 'UPLOAD_CLOUD_FILE_FAILED', err?.message || 'Không thể tải tệp lên Cloud Drive.');
  }
});

router.patch('/drive/files/:id', requirePermission('cloud_files_ocr', 'edit'), async (req, res) => {
  try {
    const ctx = getTenantContext();
    const fileId = req.params.id;
    const body = req.body || {};

    const outcome = await withTenantTransaction(ctx.tenantId, async (client) => {
      const { rbac } = await resolveActorContext(client, ctx.tenantId, ctx.userId);
      const r = await client.query('SELECT * FROM tenant_cloud_files WHERE tenant_id = $1 AND id = $2 LIMIT 1', [
        ctx.tenantId,
        fileId,
      ]);
      const cur = r.rows[0];
      if (!cur) return { status: 'not_found' as const };

      const curDepts = parseJsonSafe<string[]>(cur.allowed_department_ids, []);
      const permitted = canAccessAclItem({
        visibility: cur.visibility,
        allowedDepartmentIds: curDepts,
        creatorId: cur.uploaded_by,
        actorId: ctx.userId,
        actorRole: ctx.userRole,
        userOrg: rbac.userOrg,
      });
      if (!permitted) return { status: 'forbidden_acl' as const };

      const nextName = body.name !== undefined ? String(body.name).trim() || cur.name : cur.name;
      const nextFolderId = body.folder_id !== undefined ? body.folder_id || null : cur.folder_id;
      const nextProjectId = body.project_id !== undefined ? body.project_id || null : cur.project_id;
      const nextLeadId = body.lead_id !== undefined ? body.lead_id || null : cur.lead_id;
      const nextCategoryKey =
        body.category_key !== undefined
          ? sanitizeCategoryKey(String(body.category_key))
          : cur.category_key || 'general';
      const nextVersionTag =
        body.version_tag !== undefined ? String(body.version_tag).trim() || cur.version_tag : cur.version_tag;
      const nextDepts = Array.isArray(body.allowed_department_ids)
        ? body.allowed_department_ids.map((d: unknown) => String(d)).filter(Boolean)
        : curDepts;
      const nextVisibility =
        body.visibility !== undefined
          ? ['company', 'departments', 'private'].includes(String(body.visibility))
            ? String(body.visibility)
            : cur.visibility
          : cur.visibility;
      const nextPreview =
        body.content_preview !== undefined
          ? body.content_preview
            ? String(body.content_preview).slice(0, 8000)
            : null
          : cur.content_preview;
      const nextFileUrl = body.file_url !== undefined ? (body.file_url ? String(body.file_url) : null) : cur.file_url;

      await client.query(
        `UPDATE tenant_cloud_files
         SET name = $3,
             folder_id = $4,
             project_id = $5,
             lead_id = $6,
             category_key = $7,
             version_tag = $8,
             visibility = $9,
             allowed_department_ids = $10::jsonb,
             content_preview = $11,
             file_url = $12,
             updated_at = clock_timestamp()
         WHERE tenant_id = $1 AND id = $2`,
        [
          ctx.tenantId,
          fileId,
          nextName,
          nextFolderId,
          nextProjectId,
          nextLeadId,
          nextCategoryKey,
          nextVersionTag,
          nextVisibility,
          JSON.stringify(nextDepts),
          nextPreview,
          nextFileUrl,
        ]
      );

      const updatedRes = await client.query('SELECT * FROM tenant_cloud_files WHERE tenant_id = $1 AND id = $2', [
        ctx.tenantId,
        fileId,
      ]);
      const row = updatedRes.rows[0];
      return {
        status: 'ok' as const,
        file: {
          ...row,
          category_key: row.category_key || 'general',
          size_bytes: Number(row.size_bytes || 0),
          allowed_department_ids: parseJsonSafe<string[]>(row.allowed_department_ids, []),
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
        'Phòng ban của bạn không được cấp quyền chỉnh sửa tài liệu này.'
      );
      return;
    }
    res.json({ success: true, data: outcome.file });
  } catch (err: any) {
    sendApiError(res, 500, 'UPDATE_CLOUD_FILE_FAILED', err?.message || 'Không thể cập nhật tài liệu.');
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

      if (row.category_key && row.category_key !== 'general') {
        const catRes = await client.query(
          'SELECT * FROM tenant_cloud_file_categories WHERE tenant_id = $1 AND category_key = $2 LIMIT 1',
          [ctx.tenantId, row.category_key]
        );
        if (catRes.rows[0]) {
          const catPermitted = canAccessAclItem({
            visibility: catRes.rows[0].visibility,
            allowedDepartmentIds: parseJsonSafe<string[]>(catRes.rows[0].allowed_department_ids, []),
            allowedRoleIds: parseJsonSafe<string[]>(catRes.rows[0].allowed_role_ids, []),
            creatorId: catRes.rows[0].created_by,
            actorId: ctx.userId,
            actorRole: ctx.userRole,
            userOrg: rbac.userOrg,
          });
          if (!catPermitted) return { status: 'forbidden_acl' as const };
        }
      }

      return {
        status: 'ok' as const,
        file: {
          ...row,
          category_key: row.category_key || 'general',
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
// 1C. Batch Contact / Folder Manifest & CSV/JSON Bundle Export
// ============================================================================
router.post('/drive/export-bundle', requirePermission('cloud_files_ocr', 'view'), async (req, res) => {
  try {
    const ctx = getTenantContext();
    const body = req.body || {};
    const folderId = typeof body.folder_id === 'string' ? body.folder_id.trim() : '';
    const categoryKey = typeof body.category_key === 'string' ? body.category_key.trim() : '';
    const requestedFileIds = Array.isArray(body.file_ids)
      ? new Set(body.file_ids.map((id: unknown) => String(id)).filter(Boolean))
      : null;
    const includeContacts = Boolean(body.include_contacts);

    const bundle = await withTenantTransaction(ctx.tenantId, async (client) => {
      const { rbac, canUnmaskLeads, tenantSettings } = await resolveActorContext(
        client,
        ctx.tenantId,
        ctx.userId
      );

      const [foldersRes, catsRes, filesRes] = await Promise.all([
        client.query('SELECT * FROM tenant_cloud_folders WHERE tenant_id = $1', [ctx.tenantId]),
        client.query('SELECT * FROM tenant_cloud_file_categories WHERE tenant_id = $1', [ctx.tenantId]),
        client.query(
          `SELECT f.*, fl.name AS folder_name
           FROM tenant_cloud_files f
           LEFT JOIN tenant_cloud_folders fl ON fl.tenant_id = f.tenant_id AND fl.id = f.folder_id
           WHERE f.tenant_id = $1
           ORDER BY f.created_at DESC`,
          [ctx.tenantId]
        ),
      ]);

      const visibleFolderIds = new Set(
        foldersRes.rows
          .filter((fl) =>
            canAccessAclItem({
              visibility: fl.visibility,
              allowedDepartmentIds: parseJsonSafe<string[]>(fl.allowed_department_ids, []),
              creatorId: fl.created_by,
              actorId: ctx.userId,
              actorRole: ctx.userRole,
              userOrg: rbac.userOrg,
            })
          )
          .map((fl) => String(fl.id))
      );

      const categoryMap = new Map(
        catsRes.rows.map((c) => [
          String(c.category_key),
          {
            ...c,
            allowed_department_ids: parseJsonSafe<string[]>(c.allowed_department_ids, []),
            allowed_role_ids: parseJsonSafe<string[]>(c.allowed_role_ids, []),
          },
        ])
      );

      const exportedFiles = filesRes.rows
        .filter((row) => {
          if (row.folder_id && !visibleFolderIds.has(String(row.folder_id))) return false;
          if (folderId && folderId !== 'all' && row.folder_id !== folderId) return false;
          if (categoryKey && categoryKey !== 'all' && (row.category_key || 'general') !== categoryKey) {
            return false;
          }
          if (requestedFileIds && requestedFileIds.size > 0 && !requestedFileIds.has(String(row.id))) {
            return false;
          }

          const linkedCat = categoryMap.get(String(row.category_key || 'general'));
          if (linkedCat) {
            const okCat = canAccessAclItem({
              visibility: linkedCat.visibility,
              allowedDepartmentIds: linkedCat.allowed_department_ids,
              allowedRoleIds: linkedCat.allowed_role_ids,
              creatorId: linkedCat.created_by,
              actorId: ctx.userId,
              actorRole: ctx.userRole,
              userOrg: rbac.userOrg,
            });
            if (!okCat) return false;
          }

          return canAccessAclItem({
            visibility: row.visibility,
            allowedDepartmentIds: parseJsonSafe<string[]>(row.allowed_department_ids, []),
            creatorId: row.uploaded_by,
            actorId: ctx.userId,
            actorRole: ctx.userRole,
            userOrg: rbac.userOrg,
          });
        })
        .map((row) => ({
          id: row.id,
          name: row.name,
          folder_id: row.folder_id || null,
          folder_name: row.folder_name || 'Thư mục gốc',
          category_key: row.category_key || 'general',
          storage_key: row.storage_key,
          file_url: row.file_url || null,
          mime_type: row.mime_type,
          size_bytes: Number(row.size_bytes || 0),
          version_tag: row.version_tag,
          checksum_sha256: row.checksum_sha256,
          content_preview: row.content_preview || null,
          created_at: row.created_at,
        }));

      let exportedContacts: Array<Record<string, unknown>> = [];
      if (includeContacts) {
        const leadsRes = await client.query(
          `SELECT id, name, phone, email, status, lifecycle_stage, source, total_revenue_vnd, created_at
           FROM leads
           WHERE tenant_id = $1 AND is_deleted = false
           ORDER BY created_at DESC
           LIMIT 500`,
          [ctx.tenantId]
        );
        exportedContacts = leadsRes.rows.map((l) => {
          const masked = maskContactPiiIfDisallowed(
            { phone: l.phone, email: l.email },
            canUnmaskLeads,
            tenantSettings
          );
          return {
            id: l.id,
            name: l.name,
            phone: masked.phone,
            email: masked.email,
            status: l.status,
            lifecycle_stage: l.lifecycle_stage || 'lead',
            source: l.source || '',
            total_revenue_vnd: Number(l.total_revenue_vnd || 0),
            created_at: l.created_at,
          };
        });
      }

      const totalBytes = exportedFiles.reduce((acc, f) => acc + f.size_bytes, 0);
      const exportedAt = new Date().toISOString();
      const dateTag = exportedAt.slice(0, 10);
      const manifest = {
        bundle_id: crypto.randomUUID(),
        exported_at: exportedAt,
        tenant_id: ctx.tenantId,
        namespace_prefix: `tenants/${ctx.tenantId}/`,
        folder_id: folderId && folderId !== 'all' ? folderId : null,
        category_key: categoryKey && categoryKey !== 'all' ? categoryKey : null,
        total_files: exportedFiles.length,
        total_bytes: totalBytes,
        total_contacts: exportedContacts.length,
        pii_masked: !canUnmaskLeads,
        archive_filename: `DOMATION_CloudBundle_${dateTag}.json`,
      };

      const csvFilesHeader =
        'id,name,folder_name,category_key,storage_key,mime_type,size_bytes,version_tag,checksum_sha256';
      const csvFilesRows = exportedFiles.map((f) =>
        [
          f.id,
          f.name,
          f.folder_name,
          f.category_key,
          f.storage_key,
          f.mime_type,
          f.size_bytes,
          f.version_tag,
          f.checksum_sha256 || '',
        ]
          .map(escapeCsvCell)
          .join(',')
      );
      const csvFiles = [csvFilesHeader, ...csvFilesRows].join('\n');

      const csvContactsHeader =
        'id,name,phone,email,status,lifecycle_stage,source,total_revenue_vnd';
      const csvContactsRows = exportedContacts.map((c) =>
        [
          c.id,
          c.name,
          c.phone || '',
          c.email || '',
          c.status || '',
          c.lifecycle_stage || '',
          c.source || '',
          c.total_revenue_vnd || 0,
        ]
          .map(escapeCsvCell)
          .join(',')
      );
      const csvContacts = [csvContactsHeader, ...csvContactsRows].join('\n');

      const bundlePayload = {
        manifest,
        files: exportedFiles,
        contacts: exportedContacts,
      };
      const bundleBase64 = Buffer.from(JSON.stringify(bundlePayload, null, 2), 'utf8').toString('base64');

      return {
        manifest,
        files: exportedFiles,
        contacts: exportedContacts,
        csv_files: csvFiles,
        csv_contacts: csvContacts,
        bundle_base64: bundleBase64,
      };
    });

    res.json({ success: true, data: bundle });
  } catch (err: any) {
    sendApiError(res, 500, 'EXPORT_CLOUD_BUNDLE_FAILED', err?.message || 'Không thể kết xuất gói tài liệu Cloud.');
  }
});

// ============================================================================
// 2. AI OCR Contract & CCCD / Passport Extractor + 1-Click Apply
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
      const extraFields =
        docType === 'cccd'
          ? { ...parsed, id_card: parseIdCardDocument(rawText) }
          : docType === 'contract'
            ? { ...parsed, ...parseContractMilestonesAndLegal(rawText, branchLegal) }
            : parsed;

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
          JSON.stringify(extraFields),
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

router.post('/ocr/extract-id-card', requirePermission('cloud_files_ocr', 'create'), async (req, res) => {
  try {
    const ctx = getTenantContext();
    const body = req.body || {};

    const outcome = await withTenantTransaction(ctx.tenantId, async (client) => {
      const { rbac, canUnmaskLeads, tenantSettings } = await resolveActorContext(
        client,
        ctx.tenantId,
        ctx.userId
      );

      let rawText = String(body.raw_text || body.document_text || '').trim();
      let sourceTitle = String(body.source_title || '').trim();
      const sourceFileId = body.source_file_id ? String(body.source_file_id).trim() : null;

      if (sourceFileId && !rawText) {
        const fRes = await client.query(
          'SELECT * FROM tenant_cloud_files WHERE tenant_id = $1 AND id = $2 LIMIT 1',
          [ctx.tenantId, sourceFileId]
        );
        const fRow = fRes.rows[0];
        if (!fRow) return { status: 'file_not_found' as const };
        const permitted = canAccessAclItem({
          visibility: fRow.visibility,
          allowedDepartmentIds: parseJsonSafe<string[]>(fRow.allowed_department_ids, []),
          creatorId: fRow.uploaded_by,
          actorId: ctx.userId,
          actorRole: ctx.userRole,
          userOrg: rbac.userOrg,
        });
        if (!permitted) return { status: 'forbidden_acl' as const };
        rawText = String(fRow.content_preview || fRow.name || '').trim();
        if (!sourceTitle) sourceTitle = String(fRow.name || '');
      }

      if (!rawText) {
        return { status: 'empty_text' as const };
      }

      const idFields = parseIdCardDocument(rawText);
      const finalTitle =
        sourceTitle ||
        `Định danh CCCD/Passport — ${idFields.full_name || idFields.citizen_id || new Date().toLocaleDateString('vi-VN')}`;

      const id = crypto.randomUUID();
      await client.query(
        `INSERT INTO tenant_ocr_extractions (
           id, tenant_id, doc_type, source_file_id, source_title, raw_text,
           extracted_party_name, extracted_id_number, extracted_address,
           effective_date, expiry_date, branch_verification_json, extracted_fields_json, created_by
         ) VALUES (
           $1, $2, 'cccd', $3, $4, $5,
           $6, $7, $8,
           $9, $10, '{}'::jsonb, $11::jsonb, $12
         )`,
        [
          id,
          ctx.tenantId,
          sourceFileId,
          finalTitle,
          rawText,
          idFields.full_name,
          idFields.citizen_id || idFields.passport,
          idFields.address,
          idFields.issue_date,
          idFields.expiry_date,
          JSON.stringify(idFields),
          ctx.userId,
        ]
      );

      let appliedLead: Record<string, unknown> | null = null;
      if (body.lead_id && body.auto_apply_lead) {
        const updatedLead = await applyIdFieldsToLeadInTx(client, {
          tenantId: ctx.tenantId,
          leadId: String(body.lead_id),
          ocrId: id,
          actorId: ctx.userId,
          actorRole: ctx.userRole,
          actorName: ctx.userName || 'DOM Vision AI',
          fields: idFields,
        });
        if (updatedLead) {
          const masked = maskContactPiiIfDisallowed(
            { phone: updatedLead.phone as string | null, email: updatedLead.email as string | null },
            canUnmaskLeads,
            tenantSettings
          );
          appliedLead = { ...updatedLead, phone: masked.phone, email: masked.email };
        }
      }

      const r = await client.query('SELECT * FROM tenant_ocr_extractions WHERE tenant_id = $1 AND id = $2', [
        ctx.tenantId,
        id,
      ]);
      const row = r.rows[0];
      return {
        status: 'ok' as const,
        data: {
          ...row,
          contract_value_vnd: 0,
          branch_verification: {},
          extracted_fields: parseJsonSafe(row.extracted_fields_json, idFields),
          id_card: idFields,
          applied_lead: appliedLead,
        },
      };
    });

    if (outcome.status === 'file_not_found') {
      sendApiError(res, 404, 'FILE_NOT_FOUND', 'Không tìm thấy tệp CCCD/Passport trên Cloud Drive.');
      return;
    }
    if (outcome.status === 'forbidden_acl') {
      sendApiError(res, 403, 'FORBIDDEN_DEPARTMENT_ACL', 'Không có quyền truy cập tệp này.');
      return;
    }
    if (outcome.status === 'empty_text') {
      sendApiError(res, 422, 'OCR_TEXT_REQUIRED', 'Vui lòng cung cấp nội dung hoặc chọn tệp CCCD / Hộ chiếu hợp lệ.');
      return;
    }

    res.status(201).json({ success: true, data: outcome.data });
  } catch (err: any) {
    sendApiError(res, 500, 'OCR_EXTRACT_ID_CARD_FAILED', err?.message || 'Không thể bóc tách CCCD / Hộ chiếu.');
  }
});

router.post(
  '/ocr/extractions/:id/apply-lead',
  requirePermission('cloud_files_ocr', 'create'),
  async (req, res) => {
    try {
      const ctx = getTenantContext();
      const ocrId = req.params.id;
      const body = req.body || {};
      const leadId = String(body.lead_id || '').trim();
      if (!leadId) {
        sendApiError(res, 422, 'LEAD_ID_REQUIRED', 'Vui lòng chọn Hồ sơ Khách hàng (CRM Lead) cần cập nhật.');
        return;
      }

      const outcome = await withTenantTransaction(ctx.tenantId, async (client) => {
        const { canUnmaskLeads, tenantSettings } = await resolveActorContext(
          client,
          ctx.tenantId,
          ctx.userId
        );

        const oRes = await client.query(
          'SELECT * FROM tenant_ocr_extractions WHERE tenant_id = $1 AND id = $2 LIMIT 1',
          [ctx.tenantId, ocrId]
        );
        const ocr = oRes.rows[0];
        if (!ocr) return { status: 'ocr_not_found' as const };

        const storedFields = parseJsonSafe<Record<string, unknown>>(ocr.extracted_fields_json, {});
        const storedIdCard =
          storedFields.id_card && typeof storedFields.id_card === 'object'
            ? (storedFields.id_card as Record<string, unknown>)
            : storedFields;
        const overrides =
          body.overrides && typeof body.overrides === 'object'
            ? (body.overrides as Record<string, unknown>)
            : {};

        const pickStr = (key: string, fallback?: string | null): string | null => {
          if (body[key] !== undefined && body[key] !== null) return String(body[key]).trim() || null;
          if (overrides[key] !== undefined && overrides[key] !== null) return String(overrides[key]).trim() || null;
          if (storedIdCard[key] !== undefined && storedIdCard[key] !== null) {
            return String(storedIdCard[key]).trim() || null;
          }
          return fallback || null;
        };

        const mergedFields = {
          full_name: pickStr('full_name', ocr.extracted_party_name),
          citizen_id: pickStr('citizen_id', ocr.extracted_id_number),
          passport: pickStr('passport'),
          birthday: pickStr('birthday'),
          gender: pickStr('gender'),
          nationality: pickStr('nationality'),
          address: pickStr('address', ocr.extracted_address),
          issue_date: pickStr('issue_date', ocr.effective_date),
          expiry_date: pickStr('expiry_date', ocr.expiry_date),
          issue_place: pickStr('issue_place'),
        };

        const updatedLead = await applyIdFieldsToLeadInTx(client, {
          tenantId: ctx.tenantId,
          leadId,
          ocrId,
          actorId: ctx.userId,
          actorRole: ctx.userRole,
          actorName: ctx.userName || 'DOM Vision AI',
          fields: mergedFields,
        });

        if (!updatedLead) return { status: 'lead_not_found' as const };

        const nextExtractedJson = {
          ...storedFields,
          ...mergedFields,
          applied_lead_id: leadId,
          applied_at: new Date().toISOString(),
        };
        await client.query(
          'UPDATE tenant_ocr_extractions SET extracted_fields_json = $3::jsonb WHERE tenant_id = $1 AND id = $2',
          [ctx.tenantId, ocrId, JSON.stringify(nextExtractedJson)]
        );

        const masked = maskContactPiiIfDisallowed(
          { phone: updatedLead.phone as string | null, email: updatedLead.email as string | null },
          canUnmaskLeads,
          tenantSettings
        );

        return {
          status: 'ok' as const,
          data: {
            extraction_id: ocrId,
            lead_id: leadId,
            updated_fields: mergedFields,
            lead: {
              ...updatedLead,
              phone: masked.phone,
              email: masked.email,
              custom_fields: parseJsonSafe(updatedLead.custom_fields, {}),
            },
          },
        };
      });

      if (outcome.status === 'ocr_not_found') {
        sendApiError(res, 404, 'OCR_EXTRACTION_NOT_FOUND', 'Không tìm thấy bản ghi OCR.');
        return;
      }
      if (outcome.status === 'lead_not_found') {
        sendApiError(res, 404, 'LEAD_NOT_FOUND', 'Không tìm thấy hồ sơ Khách hàng trong CRM.');
        return;
      }
      res.json({ success: true, data: outcome.data });
    } catch (err: any) {
      sendApiError(res, 500, 'OCR_APPLY_LEAD_FAILED', err?.message || 'Không thể điền tự động CCCD vào hồ sơ Lead.');
    }
  }
);

router.post('/ocr/parse-contract', requirePermission('cloud_files_ocr', 'create'), async (req, res) => {
  try {
    const ctx = getTenantContext();
    const body = req.body || {};

    const outcome = await withTenantTransaction(ctx.tenantId, async (client) => {
      const { rbac } = await resolveActorContext(client, ctx.tenantId, ctx.userId);
      let rawText = String(body.raw_text || body.document_text || '').trim();
      let sourceTitle = String(body.source_title || '').trim();
      const sourceFileId = body.source_file_id ? String(body.source_file_id).trim() : null;

      if (sourceFileId && !rawText) {
        const fRes = await client.query(
          'SELECT * FROM tenant_cloud_files WHERE tenant_id = $1 AND id = $2 LIMIT 1',
          [ctx.tenantId, sourceFileId]
        );
        const fRow = fRes.rows[0];
        if (!fRow) return { status: 'file_not_found' as const };
        const permitted = canAccessAclItem({
          visibility: fRow.visibility,
          allowedDepartmentIds: parseJsonSafe<string[]>(fRow.allowed_department_ids, []),
          creatorId: fRow.uploaded_by,
          actorId: ctx.userId,
          actorRole: ctx.userRole,
          userOrg: rbac.userOrg,
        });
        if (!permitted) return { status: 'forbidden_acl' as const };
        rawText = String(fRow.content_preview || '').trim();
        if (!sourceTitle) sourceTitle = String(fRow.name || '');
      }

      if (!rawText) return { status: 'empty_text' as const };

      const branchLegal = await resolvePrimaryBranchLegalInfo(client, ctx.tenantId, body.branch_id || null);
      const parsed = parseContractMilestonesAndLegal(rawText, branchLegal);
      const finalTitle =
        sourceTitle ||
        `Hợp đồng ${parsed.contract_code || parsed.party_name || new Date().toLocaleDateString('vi-VN')}`;

      const id = crypto.randomUUID();
      await client.query(
        `INSERT INTO tenant_ocr_extractions (
           id, tenant_id, doc_type, source_file_id, source_title, raw_text,
           extracted_party_name, extracted_tax_code, extracted_id_number,
           extracted_representative, extracted_address, contract_value_vnd,
           effective_date, expiry_date, branch_verification_json, extracted_fields_json, created_by
         ) VALUES (
           $1, $2, 'contract', $3, $4, $5,
           $6, $7, $8,
           $9, $10, $11,
           $12, $13, $14::jsonb, $15::jsonb, $16
         )`,
        [
          id,
          ctx.tenantId,
          sourceFileId,
          finalTitle,
          rawText,
          parsed.party_name,
          parsed.tax_code,
          parsed.id_number,
          parsed.representative,
          parsed.address,
          parsed.contract_value_vnd,
          parsed.start_date,
          parsed.end_date,
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
        status: 'ok' as const,
        data: {
          ...row,
          contract_code: parsed.contract_code,
          contract_value_vnd: Number(row.contract_value_vnd || 0),
          start_date: parsed.start_date,
          end_date: parsed.end_date,
          party_a: parsed.party_a,
          party_b: parsed.party_b,
          payment_milestones: parsed.payment_milestones,
          branch_verification: parsed.branch_verification,
          extracted_fields: parsed,
        },
      };
    });

    if (outcome.status === 'file_not_found') {
      sendApiError(res, 404, 'FILE_NOT_FOUND', 'Không tìm thấy tệp hợp đồng trên Cloud Drive.');
      return;
    }
    if (outcome.status === 'forbidden_acl') {
      sendApiError(res, 403, 'FORBIDDEN_DEPARTMENT_ACL', 'Không có quyền truy cập tệp hợp đồng này.');
      return;
    }
    if (outcome.status === 'empty_text') {
      sendApiError(res, 422, 'OCR_TEXT_REQUIRED', 'Vui lòng dán nội dung hoặc tải tệp hợp đồng để phân tích.');
      return;
    }

    res.status(201).json({ success: true, data: outcome.data });
  } catch (err: any) {
    sendApiError(res, 500, 'OCR_PARSE_CONTRACT_FAILED', err?.message || 'Không thể phân tích Hợp đồng AI.');
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
          route: '/support-tickets',
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
          version: '2.1.0',
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
          { method: 'GET', path: '/api/v1/projects', module: 'Dự án Kanban / Gantt / Whiteboard & Roster ACL' },
          { method: 'PUT', path: '/api/v1/projects/tasks/:taskId/dependencies', module: 'Gantt FS/SS/FF/SF Cascade Engine' },
          { method: 'POST', path: '/api/v1/projects/:id/whiteboard/snapshots', module: 'Whiteboard Version Snapshots & Restore' },
          { method: 'GET', path: '/api/v1/workchat/bootstrap', module: 'WorkChat & Bảng tin Nội bộ' },
          { method: 'GET', path: '/api/v1/finance/dashboard', module: 'B2B Deals, Báo giá, Đơn bán SO/PO & Dòng tiền P&L' },
          { method: 'POST', path: '/api/v1/inventory/pos/checkout', module: 'Kho vận FIFO, Xuất kho Lô hạn & POS' },
          { method: 'GET', path: '/api/v1/erp-ops/drive/categories', module: 'Cloud File Category ACL Manager' },
          { method: 'POST', path: '/api/v1/erp-ops/drive/export-bundle', module: 'Batch Cloud Manifest & Masked Contact Export' },
          { method: 'POST', path: '/api/v1/erp-ops/ocr/extract-id-card', module: 'DOM Vision CCCD / Passport KYC Auto-Fill' },
          { method: 'POST', path: '/api/v1/erp-ops/ocr/parse-contract', module: 'AI Contract Milestones & Party A Legal Parser' },
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
