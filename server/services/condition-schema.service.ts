import crypto from 'node:crypto';
import type { DbClient } from '../core/database/db-adapter.ts';
import { resolveTenantEntitlementSnapshot } from '../core/security/entitlements.ts';

export interface ConditionFieldOptionDto {
  value: string;
  key: string;
  label: string;
  type:
    | 'text'
    | 'number'
    | 'currency'
    | 'date'
    | 'birthday'
    | 'activity_date'
    | 'select'
    | 'stage'
    | 'owner'
    | 'owner_select'
    | 'team'
    | 'tag'
    | 'tags'
    | 'list_select'
    | 'boolean'
    | 'boolean_presence'
    | 'event'
    | 'activity_history';
  group: string;
  options?: Array<{ value: string; label: string }>;
  placeholder?: string;
  canonical_key?: string;
  is_custom?: boolean;
}

export interface ConditionFieldGroupDto {
  id: string;
  label: string;
  fields: ConditionFieldOptionDto[];
}

function safeObj(raw: unknown): Record<string, unknown> {
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) return raw as Record<string, unknown>;
  if (typeof raw === 'string') {
    try {
      const p = JSON.parse(raw);
      if (p && typeof p === 'object' && !Array.isArray(p)) return p as Record<string, unknown>;
    } catch {
      return {};
    }
  }
  return {};
}

function safeArr(raw: unknown): any[] {
  if (Array.isArray(raw)) return raw;
  if (typeof raw === 'string') {
    try {
      const p = JSON.parse(raw);
      if (Array.isArray(p)) return p;
    } catch {
      return [];
    }
  }
  return [];
}

async function safeSavepoint(client: DbClient, sql: string, params: unknown[]): Promise<any[]> {
  const sp = `sp_schema_${crypto.randomUUID().replace(/-/g, '').slice(0, 12)}`;
  try {
    await client.query(`SAVEPOINT ${sp}`);
    const r = await client.query(sql, params);
    await client.query(`RELEASE SAVEPOINT ${sp}`);
    return r.rows || [];
  } catch {
    try {
      await client.query(`ROLLBACK TO SAVEPOINT ${sp}`);
    } catch {
      // ignore
    }
    return [];
  }
}

export const CONDITION_OPERATORS_BY_TYPE: Record<string, Array<{ value: string; label: string }>> = {
  text: [
    { value: 'contains', label: 'Chứa' },
    { value: 'equals', label: 'Là' },
    { value: 'starts_with', label: 'Bắt đầu với' },
    { value: 'ends_with', label: 'Kết thúc với' },
    { value: 'not_contains', label: 'Không chứa' },
    { value: 'not_equals', label: 'Khác' },
    { value: 'is_not_empty', label: 'Có giá trị (*)' },
    { value: 'is_empty', label: 'Không có giá trị (*)' },
  ],
  number: [
    { value: 'greater_than', label: 'Lớn hơn (>)' },
    { value: 'gte', label: 'Lớn hơn hoặc bằng (>=)' },
    { value: 'less_than', label: 'Nhỏ hơn (<)' },
    { value: 'lte', label: 'Nhỏ hơn hoặc bằng (<=)' },
    { value: 'equals', label: 'Bằng (=)' },
    { value: 'not_equals', label: 'Khác (!=)' },
    { value: 'between', label: 'Trong khoảng' },
  ],
  currency: [
    { value: 'greater_than', label: 'Lớn hơn (>)' },
    { value: 'gte', label: 'Lớn hơn hoặc bằng (>=)' },
    { value: 'less_than', label: 'Nhỏ hơn (<)' },
    { value: 'lte', label: 'Nhỏ hơn hoặc bằng (<=)' },
    { value: 'equals', label: 'Bằng (=)' },
    { value: 'between', label: 'Trong khoảng' },
  ],
  date: [
    { value: 'after', label: 'Sau ngày' },
    { value: 'before', label: 'Trước ngày' },
    { value: 'on', label: 'Đúng ngày' },
    { value: 'within_days', label: 'Trong X ngày qua' },
    { value: 'is_not_empty', label: 'Có giá trị (*)' },
    { value: 'is_empty', label: 'Không có giá trị (*)' },
  ],
  birthday: [
    { value: 'is_today', label: 'Là hôm nay' },
    { value: 'is_this_month', label: 'Trong tháng này' },
    { value: 'before_days', label: 'Còn X ngày nữa' },
    { value: 'on', label: 'Đúng ngày' },
    { value: 'is_not_empty', label: 'Có giá trị (*)' },
    { value: 'is_empty', label: 'Không có giá trị (*)' },
  ],
  activity_date: [
    { value: 'in_the_last', label: 'Trong X ngày qua' },
    { value: 'not_in_the_last', label: 'Ngủ đông quá X ngày' },
    { value: 'after', label: 'Sau ngày' },
    { value: 'before', label: 'Trước ngày' },
    { value: 'is_empty', label: 'Chưa từng tương tác (*)' },
  ],
  select: [
    { value: 'is', label: 'Là' },
    { value: 'is_not', label: 'Không là' },
    { value: 'in', label: 'Thuộc một trong' },
  ],
  stage: [
    { value: 'is', label: 'Ở giai đoạn' },
    { value: 'is_not', label: 'Không ở giai đoạn' },
    { value: 'is_empty', label: 'Chưa gán giai đoạn' },
  ],
  team: [
    { value: 'is', label: 'Thuộc nhóm / team' },
    { value: 'is_not', label: 'Không thuộc nhóm / team' },
    { value: 'is_empty', label: 'Chưa gán nhóm' },
  ],
  owner: [
    { value: 'is', label: 'Là (Phụ trách bởi)' },
    { value: 'is_not', label: 'Không phải là' },
    { value: 'is_empty', label: 'Chưa phân bổ Sale (*)' },
    { value: 'is_not_empty', label: 'Đã có Sale phụ trách (*)' },
  ],
  owner_select: [
    { value: 'is', label: 'Là (Phụ trách bởi)' },
    { value: 'is_not', label: 'Không phải là' },
    { value: 'is_empty', label: 'Chưa phân bổ Sale (*)' },
    { value: 'is_not_empty', label: 'Đã có Sale phụ trách (*)' },
  ],
  list_select: [
    { value: 'in_list', label: 'Thuộc danh sách' },
    { value: 'not_in_list', label: 'Không thuộc danh sách' },
  ],
  tag: [
    { value: 'contains', label: 'Có gắn nhãn' },
    { value: 'not_contains', label: 'Không gắn nhãn' },
    { value: 'is_empty', label: 'Chưa gắn nhãn nào' },
  ],
  tags: [
    { value: 'contains', label: 'Có chứa' },
    { value: 'not_contains', label: 'Không chứa' },
    { value: 'is_empty', label: 'Chưa gắn nhãn nào' },
  ],
  boolean: [
    { value: 'is_true', label: 'Đúng (Có)' },
    { value: 'is_false', label: 'Sai (Không)' },
  ],
  boolean_presence: [
    { value: 'is_not_empty', label: 'Có thông tin (*)' },
    { value: 'is_empty', label: 'Chưa có / Trống (*)' },
  ],
  event: [
    { value: 'has_done', label: 'Đã thực hiện' },
    { value: 'has_not_done', label: 'Chưa từng thực hiện' },
  ],
  activity_history: [
    { value: 'has_done', label: 'Đã thực hiện' },
    { value: 'has_not_done', label: 'Chưa từng thực hiện' },
  ],
};

function mapCustomFieldType(rawType: unknown, rawKey?: unknown): ConditionFieldOptionDto['type'] {
  const t = String(rawType || 'text').trim().toLowerCase();
  const k = String(rawKey || '').trim().toLowerCase();
  if (t === 'birthday' || ((t === 'date' || t === 'text') && ['birthday', 'dob', 'date_of_birth', 'dateofbirth', 'ngay_sinh', 'anniversary_date', 'anniversarydate'].includes(k))) {
    return 'birthday';
  }
  if (t === 'number') return 'number';
  if (t === 'currency') return 'currency';
  if (t === 'date') return 'date';
  if (t === 'boolean' || t === 'checkbox') return 'boolean';
  if (t === 'select' || t === 'multiselect') return 'select';
  return 'text';
}

const INTERNAL_CUSTOM_KEY_BLOCKLIST = new Set([
  'dom_journey_ai',
  'ai_profile',
  'ai_summary',
  '__proto__',
  'constructor',
  'prototype',
]);

function inferCustomFieldTypeFromValue(sampleVal: unknown, key: string): ConditionFieldOptionDto['type'] {
  const k = key.toLowerCase();
  if (['birthday', 'dob', 'date_of_birth', 'dateofbirth', 'ngay_sinh', 'anniversary_date', 'anniversarydate'].includes(k)) {
    return 'birthday';
  }
  if (typeof sampleVal === 'boolean') return 'boolean';
  if (typeof sampleVal === 'number' && Number.isFinite(sampleVal)) {
    return k.includes('vnd') || k.includes('price') || k.includes('budget') || k.includes('amount') || k.includes('value')
      ? 'currency'
      : 'number';
  }
  if (typeof sampleVal === 'string') {
    const trimmed = sampleVal.trim();
    if (/^\d{4}-\d{2}-\d{2}/.test(trimmed)) return 'date';
    if (/^-?\d+(\.\d+)?$/.test(trimmed) && !k.includes('phone') && !k.includes('id') && !k.includes('code') && !k.includes('zip')) {
      return k.includes('vnd') || k.includes('price') || k.includes('budget') || k.includes('amount') ? 'currency' : 'number';
    }
  }
  return 'text';
}

function humanizeCustomFieldKey(key: string): string {
  return key
    .replace(/[_-]+/g, ' ')
    .replace(/\b\w/g, (m) => m.toUpperCase())
    .trim();
}

export async function buildDynamicConditionSchemaRegistryInTx(client: DbClient, tenantId: string) {
  const [tenantRes, stagesRes, teamsRes, usersRes] = await Promise.all([
    client.query<{
      package_code?: string;
      plan_tier?: string;
      subscription_plan_code?: string;
      crm_erp_upgrade_status?: string;
      industry?: string;
      industry_key?: string;
      enabled_modules?: unknown;
      entitlements?: unknown;
      settings?: unknown;
    }>(
      `SELECT package_code, plan_tier, subscription_plan_code, crm_erp_upgrade_status,
              industry, industry_key, enabled_modules, entitlements, settings
       FROM tenants WHERE id = $1 LIMIT 1`,
      [tenantId]
    ),
    client.query<{
      id: string;
      pipeline_id: string;
      stage_key: string;
      stage_name: string;
      stage_order: number;
      color_hex: string;
      funnel_category: string;
      is_won_stage: boolean;
      is_lost_stage: boolean;
    }>(
      `SELECT id, pipeline_id, stage_key, stage_name, stage_order, color_hex,
              funnel_category, is_won_stage, is_lost_stage
       FROM tenant_pipeline_stages
       WHERE tenant_id = $1
       ORDER BY stage_order ASC, created_at ASC`,
      [tenantId]
    ),
    client.query<{ id: string; code: string; name: string; leader_user_id: string | null }>(
      `SELECT id, code, name, leader_user_id
       FROM tenant_teams
       WHERE tenant_id = $1 AND is_active = true
       ORDER BY name ASC`,
      [tenantId]
    ),
    client.query<{
      id: string;
      full_name: string;
      email: string;
      role: string;
      avatar_url: string | null;
      team_id: string | null;
      department_id: string | null;
    }>(
      `SELECT id, full_name, email, role, avatar_url, team_id, department_id
       FROM users
       WHERE tenant_id = $1 AND COALESCE(is_system_bot, false) = false
       ORDER BY full_name ASC
       LIMIT 300`,
      [tenantId]
    ),
  ]);

  // Run optional-table SAVEPOINT queries strictly sequentially on the single PG client
  // so a ROLLBACK TO SAVEPOINT for a missing table never aborts sibling queries.
  const branchesRes = await safeSavepoint(
    client,
    `SELECT id, code, name
     FROM tenant_branches
     WHERE tenant_id = $1 AND is_active = true
     ORDER BY name ASC`,
    [tenantId]
  );
  const roundsRes = await safeSavepoint(
    client,
    `SELECT id, name, pipeline_id
     FROM distribution_rounds
     WHERE tenant_id = $1 AND is_active = true
     ORDER BY priority ASC, name ASC`,
    [tenantId]
  );
  const tagsRes = await safeSavepoint(
    client,
    `SELECT id, name, slug, color_hex, category
     FROM tenant_tags
     WHERE tenant_id = $1
     ORDER BY name ASC`,
    [tenantId]
  );
  const listsRes = await safeSavepoint(
    client,
    `SELECT id, name, audience_type, cached_member_count
     FROM tenant_audiences
     WHERE tenant_id = $1 AND is_active = true
     ORDER BY name ASC`,
    [tenantId]
  );
  const campaignsRes = await safeSavepoint(
    client,
    `SELECT id, name, channel, status
     FROM mkt_campaigns
     WHERE tenant_id = $1
     ORDER BY created_at DESC
     LIMIT 150`,
    [tenantId]
  );
  const flowsRes = await safeSavepoint(
    client,
    `SELECT id, name, status
     FROM mkt_flows
     WHERE tenant_id = $1
     ORDER BY created_at DESC
     LIMIT 150`,
    [tenantId]
  );
  const surveysRes = await safeSavepoint(
    client,
    `SELECT id, title, survey_type
     FROM mkt_surveys
     WHERE tenant_id = $1
     ORDER BY created_at DESC
     LIMIT 100`,
    [tenantId]
  );
  const formsRes = await safeSavepoint(
    client,
    `SELECT id, name
     FROM mkt_forms
     WHERE tenant_id = $1
     ORDER BY created_at DESC
     LIMIT 100`,
    [tenantId]
  );
  const vouchersRes = await safeSavepoint(
    client,
    `SELECT id, name, code_prefix
     FROM mkt_voucher_campaigns
     WHERE tenant_id = $1
     ORDER BY created_at DESC
     LIMIT 100`,
    [tenantId]
  );
  const pipeCfRows = await safeSavepoint(
    client,
    `SELECT DISTINCT field_key, field_label, field_type, options_json
     FROM tenant_pipeline_custom_fields
     WHERE tenant_id = $1
     ORDER BY field_key ASC`,
    [tenantId]
  );
  const globalCfRows = await safeSavepoint(
    client,
    `SELECT DISTINCT field_key, field_label, field_type, options_json
     FROM tenant_custom_fields
     WHERE tenant_id = $1 AND entity_type IN ('contact', 'lead', 'customer') AND is_active = true
     ORDER BY field_key ASC`,
    [tenantId]
  );
  const legacyCfDefsRows = await safeSavepoint(
    client,
    `SELECT DISTINCT field_key, field_label, field_type, options_json
     FROM custom_field_definitions
     WHERE tenant_id = $1
     ORDER BY field_key ASC`,
    [tenantId]
  );
  const sampledLeadCfRows = await safeSavepoint(
    client,
    `SELECT custom_fields
     FROM leads
     WHERE tenant_id = $1 AND is_deleted = false AND custom_fields IS NOT NULL AND custom_fields != '{}'::jsonb
     ORDER BY updated_at DESC
     LIMIT 200`,
    [tenantId]
  );

  const tenantRow = tenantRes.rows[0] || {};
  const rawSettings = safeObj(tenantRow.settings);
  const entSnap = resolveTenantEntitlementSnapshot({
    ...tenantRow,
    settings: rawSettings,
  });
  const educationEnabled =
    Boolean(entSnap.entitlements.education_addon) || entSnap.enabled_modules.includes('education');

  const stages = stagesRes.rows.map((s) => ({
    id: String(s.id),
    value: String(s.id),
    label: String(s.stage_name || s.stage_key),
    stage_key: String(s.stage_key),
    pipeline_id: String(s.pipeline_id),
    stage_order: Number(s.stage_order || 0),
    color_hex: String(s.color_hex || '#1E40FF'),
    funnel_category: String(s.funnel_category || 'engaged_qualified'),
    is_won_stage: Boolean(s.is_won_stage),
    is_lost_stage: Boolean(s.is_lost_stage),
  }));

  const users = usersRes.rows.map((u) => ({
    id: String(u.id),
    value: String(u.id),
    label: String(u.full_name || u.email),
    role: String(u.role || 'sale'),
    avatar_url: u.avatar_url || null,
    team_id: u.team_id ? String(u.team_id) : null,
    department_id: u.department_id ? String(u.department_id) : null,
  }));

  const teams = teamsRes.rows.map((t) => ({
    id: String(t.id),
    value: String(t.id),
    label: String(t.name),
    code: String(t.code),
    leader_user_id: t.leader_user_id ? String(t.leader_user_id) : null,
  }));

  const branches = branchesRes.map((b: any) => ({
    id: String(b.id),
    value: String(b.id),
    label: String(b.name || b.code || b.id),
    code: String(b.code || ''),
  }));

  const rounds = roundsRes.map((r: any) => ({
    id: String(r.id),
    value: String(r.id),
    label: String(r.name),
    pipeline_id: r.pipeline_id ? String(r.pipeline_id) : null,
  }));

  const tags = tagsRes.map((tg: any) => ({
    id: String(tg.id),
    value: String(tg.slug || tg.name || tg.id),
    label: String(tg.name),
    slug: String(tg.slug || ''),
    color_hex: String(tg.color_hex || '#1E40FF'),
    category: String(tg.category || 'general'),
  }));

  const lists = listsRes.map((aud: any) => ({
    id: String(aud.id),
    value: String(aud.id),
    label: String(aud.name),
    audience_type: String(aud.audience_type || 'static_data'),
    member_count: Number(aud.cached_member_count || 0),
  }));

  const campaigns = campaignsRes.map((c: any) => ({
    id: String(c.id),
    value: String(c.id),
    label: String(c.name),
    channel: String(c.channel || 'email'),
    status: String(c.status || 'draft'),
  }));

  const flows = flowsRes.map((f: any) => ({
    id: String(f.id),
    value: String(f.id),
    label: String(f.name),
    status: String(f.status || 'draft'),
  }));

  const surveys = surveysRes.map((s: any) => ({
    id: String(s.id),
    value: String(s.id),
    label: String(s.title),
    survey_type: String(s.survey_type || 'survey'),
  }));

  const forms = formsRes.map((f: any) => ({
    id: String(f.id),
    value: String(f.id),
    label: String(f.name),
  }));

  const voucherCampaigns = vouchersRes.map((v: any) => ({
    id: String(v.id),
    value: String(v.id),
    label: String(v.name),
    code_prefix: String(v.code_prefix || 'DOM'),
  }));

  const stageOpts = stages.map((s) => ({ value: s.value, label: s.label }));
  const userOpts = users.map((u) => ({ value: u.value, label: u.label }));
  const teamOpts = teams.map((t) => ({ value: t.value, label: t.label }));
  const branchOpts = branches.map((b) => ({ value: b.value, label: b.label }));
  const roundOpts = rounds.map((r) => ({ value: r.value, label: r.label }));
  const tagOpts = tags.map((tg) => ({ value: tg.value, label: tg.label }));
  const listOpts = lists.map((l) => ({ value: l.value, label: l.label }));
  const campaignOpts = campaigns.map((c) => ({ value: c.value, label: c.label }));
  const flowOpts = flows.map((f) => ({ value: f.value, label: f.label }));
  const voucherOpts = voucherCampaigns.map((v) => ({ value: v.value, label: v.label }));

  const groups: ConditionFieldGroupDto[] = [
    {
      id: 'profile',
      label: 'Thông tin Hồ sơ & Liên hệ',
      fields: [
        { value: 'name', key: 'name', label: 'Họ & Tên đầy đủ', type: 'text', group: 'profile', placeholder: 'VD: Nguyễn Văn A...' },
        { value: 'firstName', key: 'firstName', label: 'Tên (First Name)', type: 'text', group: 'profile' },
        { value: 'lastName', key: 'lastName', label: 'Họ & Tên đệm (Last Name)', type: 'text', group: 'profile' },
        { value: 'phone', key: 'phone', label: 'Số điện thoại', type: 'text', group: 'profile', placeholder: 'VD: 090...' },
        { value: 'email', key: 'email', label: 'Địa chỉ Email', type: 'text', group: 'profile', placeholder: 'VD: @gmail.com' },
        { value: 'has_phone', key: 'has_phone', label: 'Có Số điện thoại', type: 'boolean_presence', group: 'profile' },
        { value: 'has_email', key: 'has_email', label: 'Có Địa chỉ Email', type: 'boolean_presence', group: 'profile' },
        { value: 'city', key: 'city', label: 'Tỉnh / Thành phố', type: 'text', group: 'profile', placeholder: 'VD: Hồ Chí Minh, Hà Nội...' },
        {
          value: 'gender',
          key: 'gender',
          label: 'Giới tính',
          type: 'select',
          group: 'profile',
          options: [
            { value: 'male', label: 'Nam' },
            { value: 'female', label: 'Nữ' },
            { value: 'other', label: 'Khác' },
          ],
        },
        { value: 'source', key: 'source', label: 'Nguồn khách hàng (Source)', type: 'text', group: 'profile', placeholder: 'VD: Facebook Ads, Website...' },
        { value: 'product_interest', key: 'product_interest', label: 'Sản phẩm / Dịch vụ quan tâm', type: 'text', group: 'profile' },
        { value: 'budget_range', key: 'budget_range', label: 'Khoảng ngân sách dự kiến', type: 'text', group: 'profile' },
        { value: 'lead_score', key: 'lead_score', label: 'Điểm tương tác (Lead Score)', type: 'number', group: 'profile', placeholder: '0 - 100' },
        { value: 'lead_value', key: 'lead_value', label: 'Giá trị Khách hàng / Doanh thu (VNĐ)', type: 'currency', group: 'profile' },
        {
          value: 'quality_status',
          key: 'quality_status',
          label: 'Chất lượng Lead (Quality Status)',
          type: 'select',
          group: 'profile',
          options: [
            { value: 'Pending', label: 'Chờ thẩm định (Pending)' },
            { value: 'Qualified', label: 'Đạt chuẩn (Qualified)' },
            { value: 'Hot', label: 'Tiềm năng nóng (Hot)' },
            { value: 'Warm', label: 'Tiềm năng ấm (Warm)' },
            { value: 'Cold', label: 'Tiềm năng lạnh (Cold)' },
            { value: 'Disqualified', label: 'Không phù hợp (Disqualified)' },
            { value: 'Junk', label: 'Lead rác (Junk)' },
          ],
        },
        {
          value: 'status',
          key: 'status',
          label: 'Trạng thái hồ sơ (Status)',
          type: 'select',
          group: 'profile',
          options: [
            { value: 'marketing_nurture', label: 'Nuôi dưỡng Marketing' },
            { value: 'unassigned_pending', label: 'Chờ chia Sale' },
            { value: 'assigned', label: 'Đã phân bổ Sale' },
            { value: 'recalled', label: 'Đã thu hồi' },
            { value: 'archived', label: 'Lưu trữ' },
            { value: 'rejected', label: 'Từ chối' },
          ],
        },
        {
          value: 'lifecycle_stage',
          key: 'lifecycle_stage',
          label: 'Giai đoạn vòng đời (Lifecycle)',
          type: 'select',
          group: 'profile',
          options: [
            { value: 'subscriber', label: 'Subscriber' },
            { value: 'lead', label: 'Lead' },
            { value: 'mql', label: 'MQL' },
            { value: 'sql', label: 'SQL' },
            { value: 'opportunity', label: 'Opportunity' },
            { value: 'customer', label: 'Customer' },
            { value: 'evangelist', label: 'Evangelist' },
            { value: 'disqualified', label: 'Disqualified' },
          ],
        },
        {
          value: 'email_consent',
          key: 'email_consent',
          label: 'Trạng thái nhận Email',
          type: 'select',
          group: 'profile',
          options: [
            { value: 'subscribed', label: 'Đang đăng ký (Subscribed)' },
            { value: 'unsubscribed', label: 'Đã hủy đăng ký' },
            { value: 'bounced', label: 'Bị trả lại (Bounced)' },
            { value: 'complained', label: 'Báo Spam (Complained)' },
          ],
        },
        {
          value: 'zns_consent',
          key: 'zns_consent',
          label: 'Trạng thái nhận Zalo ZNS',
          type: 'select',
          group: 'profile',
          options: [
            { value: 'opted_in', label: 'Đồng ý nhận (Opted-in)' },
            { value: 'opted_out', label: 'Từ chối (Opted-out)' },
          ],
        },
        { value: 'created_at', key: 'created_at', label: 'Ngày tạo hồ sơ', type: 'date', group: 'profile' },
        { value: 'days_since_created', key: 'days_since_created', label: 'Số ngày kể từ lúc tạo', type: 'number', group: 'profile', placeholder: 'VD: 7, 30...' },
        { value: 'inactive_days', key: 'inactive_days', label: 'Số ngày chưa tương tác (Ngủ đông)', type: 'number', group: 'profile', placeholder: 'VD: 14, 30...' },
        { value: 'cf.company', key: 'cf.company', label: 'Công ty / Tổ chức', type: 'text', group: 'profile' },
        { value: 'cf.job_title', key: 'cf.job_title', label: 'Chức danh / Nghề nghiệp', type: 'text', group: 'profile' },
        { value: 'cf.address', key: 'cf.address', label: 'Địa chỉ liên hệ', type: 'text', group: 'profile' },
        { value: 'cf.birthday', key: 'cf.birthday', label: 'Ngày sinh (Birthday)', type: 'birthday', group: 'profile' },
      ],
    },
    {
      id: 'crm_pipeline',
      label: 'CRM & Pipeline',
      fields: [
        { value: 'crm_stage_id', key: 'crm_stage_id', label: 'Giai đoạn Pipeline (CRM Stage)', type: 'stage', group: 'crm_pipeline', options: stageOpts },
        {
          value: 'crm_lead_status',
          key: 'crm_lead_status',
          label: 'Trạng thái xử lý Lead CRM',
          type: 'select',
          group: 'crm_pipeline',
          options: [
            { value: 'active', label: 'Đang xử lý (Active)' },
            { value: 'assigned', label: 'Đã chia Sale' },
            { value: 'unassigned_pending', label: 'Chờ chia vòng' },
            { value: 'nurture', label: 'Nuôi dưỡng Marketing' },
            { value: 'lost', label: 'Ngừng chăm sóc / Lost' },
          ],
        },
        {
          value: 'crm_temperature',
          key: 'crm_temperature',
          label: 'Độ nóng Lead (Temperature)',
          type: 'select',
          group: 'crm_pipeline',
          options: [
            { value: 'hot', label: 'Nóng (Hot)' },
            { value: 'warm', label: 'Ấm (Warm)' },
            { value: 'cold', label: 'Lạnh (Cold)' },
          ],
        },
        { value: 'crm_owner_id', key: 'crm_owner_id', label: 'Nhân sự Sale phụ trách', type: 'owner_select', group: 'crm_pipeline', options: userOpts },
        { value: 'round_id', key: 'round_id', label: 'Vòng chia Sale (Distribution Round)', type: 'select', group: 'crm_pipeline', options: roundOpts },
        { value: 'crm_team_id', key: 'crm_team_id', label: 'Nhóm Sale (Team)', type: 'team', group: 'crm_pipeline', options: teamOpts },
        { value: 'crm_branch_id', key: 'crm_branch_id', label: 'Chi nhánh / Cơ sở (Branch)', type: 'select', group: 'crm_pipeline', options: branchOpts },
        { value: 'sla_breached', key: 'sla_breached', label: 'Vi phạm SLA tiếp nhận', type: 'boolean', group: 'crm_pipeline' },
        { value: 'tag', key: 'tag', label: 'Nhãn phân loại (Tag)', type: 'tags', group: 'crm_pipeline', options: tagOpts },
        { value: 'in_audience', key: 'in_audience', label: 'Thuộc Danh sách / Tệp (Audience)', type: 'list_select', group: 'crm_pipeline', options: listOpts },
      ],
    },
    {
      id: 'deals_revenue',
      label: 'Cơ hội (Deals) & Doanh thu',
      fields: [
        { value: 'has_deal', key: 'has_deal', label: 'Đã tạo Cơ hội (Has Deal)', type: 'boolean', group: 'deals_revenue' },
        {
          value: 'deal_stage',
          key: 'deal_stage',
          label: 'Giai đoạn Cơ hội (Deal Stage)',
          type: 'select',
          group: 'deals_revenue',
          options: [
            { value: 'open', label: 'Đang mở (Open Deal)' },
            { value: 'qualification', label: 'Thẩm định (Qualification)' },
            { value: 'discovery', label: 'Khám phá nhu cầu (Discovery)' },
            { value: 'proposal', label: 'Đã gửi báo giá (Proposal)' },
            { value: 'negotiation', label: 'Đàm phán (Negotiation)' },
            { value: 'won', label: 'Đã chốt thành công (Won)' },
            { value: 'lost', label: 'Thất bại (Lost)' },
            { value: 'no_deal', label: 'Chưa có Deal' },
          ],
        },
        { value: 'deal_value', key: 'deal_value', label: 'Tổng giá trị Cơ hội Deal (VNĐ)', type: 'currency', group: 'deals_revenue' },
        { value: 'erp_deal_value', key: 'erp_deal_value', label: 'Tổng doanh thu thực thu (VNĐ)', type: 'currency', group: 'deals_revenue' },
        { value: 'has_revenue', key: 'has_revenue', label: 'Đã phát sinh doanh thu', type: 'boolean', group: 'deals_revenue' },
        { value: 'is_won_stage', key: 'is_won_stage', label: 'Ở bước Chốt thành công (Won)', type: 'boolean', group: 'deals_revenue' },
        { value: 'is_lost_stage', key: 'is_lost_stage', label: 'Ở bước Thất bại (Lost)', type: 'boolean', group: 'deals_revenue' },
      ],
    },
    {
      id: 'ad_attribution',
      label: 'Quảng cáo & UTM',
      fields: [
        { value: 'utm_source', key: 'utm_source', label: 'UTM Source', type: 'text', group: 'ad_attribution', placeholder: 'VD: facebook, google, tiktok...' },
        { value: 'utm_medium', key: 'utm_medium', label: 'UTM Medium', type: 'text', group: 'ad_attribution', placeholder: 'VD: cpc, paid_social, email...' },
        { value: 'utm_campaign', key: 'utm_campaign', label: 'UTM Campaign / Tên chiến dịch', type: 'text', group: 'ad_attribution', placeholder: 'VD: black_friday_2026...' },
        { value: 'utm_content', key: 'utm_content', label: 'UTM Content', type: 'text', group: 'ad_attribution', placeholder: 'VD: video_hook_1...' },
        { value: 'ad_name', key: 'ad_name', label: 'Tên bài Quảng cáo (Ad Name)', type: 'text', group: 'ad_attribution', placeholder: 'VD: Video Testimonial V2...' },
        { value: 'ad_id', key: 'ad_id', label: 'Meta Ad ID', type: 'text', group: 'ad_attribution' },
        { value: 'adset_id', key: 'adset_id', label: 'Meta Adset ID', type: 'text', group: 'ad_attribution' },
        { value: 'campaign_id', key: 'campaign_id', label: 'Meta Campaign ID', type: 'text', group: 'ad_attribution' },
        { value: 'fbclid_present', key: 'fbclid_present', label: 'Có dấu vết Meta Click (fbclid/fbc)', type: 'boolean', group: 'ad_attribution' },
      ],
    },
    {
      id: 'behavior',
      label: 'Email & Automation Flow',
      fields: [
        { value: 'opened_campaign', key: 'opened_campaign', label: 'Đã mở chiến dịch Email', type: campaignOpts.length > 0 ? 'select' : 'event', group: 'behavior', options: campaignOpts.length > 0 ? [{ value: 'any', label: 'Bất kỳ chiến dịch nào' }, ...campaignOpts] : undefined },
        { value: 'clicked_campaign', key: 'clicked_campaign', label: 'Đã click link trong chiến dịch Email', type: campaignOpts.length > 0 ? 'select' : 'event', group: 'behavior', options: campaignOpts.length > 0 ? [{ value: 'any', label: 'Bất kỳ chiến dịch nào' }, ...campaignOpts] : undefined },
        { value: 'email_open_count', key: 'email_open_count', label: 'Tổng số lần mở Email', type: 'number', group: 'behavior', placeholder: 'VD: 3' },
        { value: 'email_click_count', key: 'email_click_count', label: 'Tổng số lần click Email', type: 'number', group: 'behavior', placeholder: 'VD: 1' },
        { value: 'is_suppressed', key: 'is_suppressed', label: 'Nằm trong danh sách chặn gửi (Suppressed)', type: 'boolean', group: 'behavior' },
        { value: 'in_flow', key: 'in_flow', label: 'Đang chạy trong Automation Flow', type: flowOpts.length > 0 ? 'select' : 'event', group: 'behavior', options: flowOpts.length > 0 ? [{ value: 'any', label: 'Bất kỳ Flow nào' }, ...flowOpts] : undefined },
        { value: 'completed_flow', key: 'completed_flow', label: 'Đã hoàn thành Automation Flow', type: flowOpts.length > 0 ? 'select' : 'event', group: 'behavior', options: flowOpts.length > 0 ? [{ value: 'any', label: 'Bất kỳ Flow nào' }, ...flowOpts] : undefined },
        { value: 'opened_email', key: 'opened_email', label: 'Đã mở Email Marketing (Timeline)', type: 'event', group: 'behavior' },
        { value: 'clicked_email', key: 'clicked_email', label: 'Đã click link Email (Timeline)', type: 'event', group: 'behavior' },
        { value: 'submitted_form', key: 'submitted_form', label: 'Đã điền Form đăng ký', type: 'event', group: 'behavior' },
        { value: 'received_zns', key: 'received_zns', label: 'Đã nhận tin nhắn Zalo ZNS', type: 'event', group: 'behavior' },
      ],
    },
    {
      id: 'web_behavior',
      label: 'Hành vi Website',
      fields: [
        { value: 'web_visited_url', key: 'web_visited_url', label: 'Đã truy cập URL trang Web', type: 'text', group: 'web_behavior', placeholder: 'VD: /bang-gia, /san-pham...' },
        { value: 'web_clicked_cta', key: 'web_clicked_cta', label: 'Đã bấm nút CTA / Phần tử Web', type: 'text', group: 'web_behavior', placeholder: 'VD: Đăng ký tư vấn, #cta-buy...' },
        { value: 'web_max_scroll_pct', key: 'web_max_scroll_pct', label: 'Độ sâu cuộn trang tối đa (%)', type: 'number', group: 'web_behavior', placeholder: '0 - 100' },
        { value: 'web_active_duration_sec', key: 'web_active_duration_sec', label: 'Tổng thời gian xem Web (giây)', type: 'number', group: 'web_behavior', placeholder: 'VD: 60, 180...' },
        { value: 'web_pricing_intent', key: 'web_pricing_intent', label: 'Có tín hiệu xem Bảng giá (Pricing Intent)', type: 'boolean', group: 'web_behavior' },
        {
          value: 'web_device_type',
          key: 'web_device_type',
          label: 'Thiết bị truy cập Website',
          type: 'select',
          group: 'web_behavior',
          options: [
            { value: 'desktop', label: 'Máy tính (Desktop)' },
            { value: 'mobile', label: 'Điện thoại (Mobile)' },
            { value: 'tablet', label: 'Máy tính bảng (Tablet)' },
          ],
        },
      ],
    },
    {
      id: 'engagement_social',
      label: 'Khảo sát, Voucher & Social',
      fields: [
        { value: 'completed_survey', key: 'completed_survey', label: 'Đã hoàn thành Khảo sát / Quiz', type: 'event', group: 'engagement_social' },
        { value: 'survey_score', key: 'survey_score', label: 'Điểm Khảo sát / Quiz (Survey Score)', type: 'number', group: 'engagement_social' },
        { value: 'quiz_score', key: 'quiz_score', label: 'Điểm Quiz (Timeline)', type: 'number', group: 'engagement_social' },
        {
          value: 'nps_category',
          key: 'nps_category',
          label: 'Nhóm hài lòng NPS',
          type: 'select',
          group: 'engagement_social',
          options: [
            { value: 'promoter', label: 'Ủng hộ tích cực (Promoter 9-10)' },
            { value: 'passive', label: 'Trung lập (Passive 7-8)' },
            { value: 'detractor', label: 'Chưa hài lòng (Detractor 0-6)' },
          ],
        },
        { value: 'voucher_claimed', key: 'voucher_claimed', label: 'Đã nhận / Đổi mã Voucher', type: voucherOpts.length > 0 ? 'select' : 'event', group: 'engagement_social', options: voucherOpts.length > 0 ? [{ value: 'any', label: 'Bất kỳ Voucher nào' }, ...voucherOpts] : undefined },
        {
          value: 'social_channel',
          key: 'social_channel',
          label: 'Kênh Chat Social đã tương tác',
          type: 'select',
          group: 'engagement_social',
          options: [
            { value: 'messenger', label: 'Facebook Messenger' },
            { value: 'zalo_oa', label: 'Zalo OA' },
            { value: 'web_chat', label: 'Live Web Chat' },
          ],
        },
      ],
    },
  ];

  // Dynamic Custom Fields from ALL tenant sources:
  // `tenant_pipeline_custom_fields`, `tenant_custom_fields`, `tenants.settings.custom_fields`,
  // `custom_field_definitions`, AND sampled keys from `leads.custom_fields` JSONB!
  const customFieldMap = new Map<string, ConditionFieldOptionDto>();
  const seenCleanCustomKeys = new Set<string>();

  const registerCustomField = (
    rawKey: unknown,
    rawLabel: unknown,
    rawType: unknown,
    rawOpts?: unknown,
    prefix: 'cf' | 'custom' = 'cf'
  ) => {
    const cleanKey = String(rawKey || '').replace(/^(?:cf|custom_fields|custom)\./i, '').trim();
    if (!cleanKey || !/^[a-zA-Z0-9_-]{1,64}$/.test(cleanKey)) return;
    if (INTERNAL_CUSTOM_KEY_BLOCKLIST.has(cleanKey.toLowerCase())) return;
    if (seenCleanCustomKeys.has(cleanKey.toLowerCase())) return;
    seenCleanCustomKeys.add(cleanKey.toLowerCase());

    const fullKey = `${prefix}.${cleanKey}`;
    const mappedType = mapCustomFieldType(rawType, cleanKey);
    const opts = safeArr(rawOpts)
      .map((o: any) =>
        typeof o === 'string'
          ? { value: o, label: o }
          : o && typeof o === 'object'
            ? { value: String(o.value ?? o.key ?? o.label ?? ''), label: String(o.label ?? o.name ?? o.value ?? '') }
            : null
      )
      .filter((x: { value: string; label: string } | null): x is { value: string; label: string } => Boolean(x && x.value));
    customFieldMap.set(fullKey, {
      value: fullKey,
      key: fullKey,
      canonical_key: `custom.${cleanKey}`,
      is_custom: true,
      label: String(rawLabel || humanizeCustomFieldKey(cleanKey)).trim(),
      type: mappedType,
      group: 'custom_fields',
      ...(opts.length > 0 ? { options: opts } : {}),
    });
  };

  for (const row of [...pipeCfRows, ...globalCfRows]) {
    registerCustomField(row.field_key, row.field_label, row.field_type, row.options_json, 'cf');
  }
  const settingsCustom = rawSettings.custom_fields;
  if (Array.isArray(settingsCustom)) {
    for (const item of settingsCustom) {
      if (item && typeof item === 'object') {
        const obj = item as Record<string, unknown>;
        registerCustomField(obj.key ?? obj.field_key ?? obj.name, obj.label ?? obj.field_label, obj.type ?? obj.field_type, obj.options ?? obj.options_json, 'cf');
      }
    }
  } else if (settingsCustom && typeof settingsCustom === 'object') {
    for (const [k, v] of Object.entries(settingsCustom as Record<string, unknown>)) {
      if (v && typeof v === 'object' && !Array.isArray(v)) {
        const obj = v as Record<string, unknown>;
        registerCustomField(k, obj.label ?? obj.field_label ?? k, obj.type ?? obj.field_type, obj.options, 'cf');
      } else {
        registerCustomField(k, typeof v === 'string' ? v : k, 'text', undefined, 'cf');
      }
    }
  }
  for (const row of legacyCfDefsRows) {
    registerCustomField(row.field_key, row.field_label, row.field_type, row.options_json, 'custom');
  }

  // Sample dynamic JSONB keys from tenant's actual `leads.custom_fields`
  for (const row of sampledLeadCfRows) {
    const cfObj = safeObj(row.custom_fields);
    for (const [k, v] of Object.entries(cfObj)) {
      if (v === null || v === undefined || typeof v === 'object') continue;
      const inferredType = inferCustomFieldTypeFromValue(v, k);
      registerCustomField(k, humanizeCustomFieldKey(k), inferredType, undefined, 'custom');
    }
  }

  if (customFieldMap.size > 0) {
    groups.push({
      id: 'custom_fields',
      label: 'Trường dữ liệu Tùy chỉnh',
      fields: Array.from(customFieldMap.values()),
    });
  }

  // Strictly include Education fields ONLY when `education` / `education_addon` is enabled
  if (educationEnabled) {
    groups.push({
      id: 'education',
      label: 'Đào tạo & Học vụ (Education Add-on)',
      fields: [
        { value: 'cf.erp_is_student', key: 'cf.erp_is_student', label: 'Đã là Học viên', type: 'boolean', group: 'education' },
        {
          value: 'cf.erp_student_status',
          key: 'cf.erp_student_status',
          label: 'Trạng thái Học vụ',
          type: 'select',
          group: 'education',
          options: [
            { value: 'studying', label: 'Đang theo học' },
            { value: 'graduated', label: 'Đã tốt nghiệp' },
            { value: 'reserved', label: 'Đang bảo lưu' },
          ],
        },
        { value: 'cf.erp_class_id', key: 'cf.erp_class_id', label: 'Lớp học / Khóa học', type: 'text', group: 'education' },
        {
          value: 'cf.erp_tuition_status',
          key: 'cf.erp_tuition_status',
          label: 'Trạng thái Học phí',
          type: 'select',
          group: 'education',
          options: [
            { value: 'paid', label: 'Đã hoàn tất học phí' },
            { value: 'partial', label: 'Đóng theo đợt / Còn công nợ' },
            { value: 'unpaid', label: 'Chưa đóng' },
          ],
        },
      ],
    });
  }

  const fields = groups.flatMap((g) => g.fields);
  const customFieldKeys = Array.from(customFieldMap.values()).map((f) => f.canonical_key || f.key);

  return {
    groups,
    fields,
    custom_field_keys: customFieldKeys,
    operators_by_type: CONDITION_OPERATORS_BY_TYPE,
    dynamic_options: {
      stages,
      users,
      teams,
      branches,
      rounds,
      tags,
      lists,
      campaigns,
      flows,
      surveys,
      forms,
      voucher_campaigns: voucherCampaigns,
    },
    education_enabled: educationEnabled,
  };
}
