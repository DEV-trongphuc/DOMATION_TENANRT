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

function mapCustomFieldType(rawType: unknown): ConditionFieldOptionDto['type'] {
  const t = String(rawType || 'text').trim().toLowerCase();
  if (t === 'number') return 'number';
  if (t === 'currency') return 'currency';
  if (t === 'date') return 'date';
  if (t === 'boolean' || t === 'checkbox') return 'boolean';
  if (t === 'select' || t === 'multiselect') return 'select';
  return 'text';
}

export async function buildDynamicConditionSchemaRegistryInTx(client: DbClient, tenantId: string) {
  const [tenantRes, stagesRes, teamsRes, usersRes, tagsRes, listsRes, pipeCfRows, globalCfRows] = await Promise.all([
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
    safeSavepoint(
      client,
      `SELECT id, name, slug, color_hex, category
       FROM tenant_tags
       WHERE tenant_id = $1
       ORDER BY name ASC`,
      [tenantId]
    ),
    safeSavepoint(
      client,
      `SELECT id, name, audience_type, cached_member_count
       FROM tenant_audiences
       WHERE tenant_id = $1 AND audience_type IN ('static_data', 'static') AND is_active = true
       ORDER BY name ASC`,
      [tenantId]
    ),
    safeSavepoint(
      client,
      `SELECT DISTINCT field_key, field_label, field_type, options_json
       FROM tenant_pipeline_custom_fields
       WHERE tenant_id = $1
       ORDER BY field_key ASC`,
      [tenantId]
    ),
    safeSavepoint(
      client,
      `SELECT DISTINCT field_key, field_label, field_type, options_json
       FROM tenant_custom_fields
       WHERE tenant_id = $1 AND entity_type IN ('contact', 'lead', 'customer') AND is_active = true
       ORDER BY field_key ASC`,
      [tenantId]
    ),
  ]);

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

  const stageOpts = stages.map((s) => ({ value: s.value, label: s.label }));
  const userOpts = users.map((u) => ({ value: u.value, label: u.label }));
  const teamOpts = teams.map((t) => ({ value: t.value, label: t.label }));
  const tagOpts = tags.map((tg) => ({ value: tg.value, label: tg.label }));
  const listOpts = lists.map((l) => ({ value: l.value, label: l.label }));

  const groups: ConditionFieldGroupDto[] = [
    {
      id: 'profile',
      label: 'Thông tin Hồ sơ & Liên hệ',
      fields: [
        { value: 'name', key: 'name', label: 'Họ & Tên đầy đủ', type: 'text', group: 'profile', placeholder: 'VD: Nguyễn Văn A...' },
        { value: 'firstName', key: 'firstName', label: 'Tên (First Name)', type: 'text', group: 'profile' },
        { value: 'lastName', key: 'lastName', label: 'Họ & Tên đệm (Last Name)', type: 'text', group: 'profile' },
        { value: 'phoneNumber', key: 'phoneNumber', label: 'Số điện thoại', type: 'text', group: 'profile', placeholder: 'VD: 090...' },
        { value: 'email', key: 'email', label: 'Địa chỉ Email', type: 'text', group: 'profile', placeholder: 'VD: @gmail.com' },
        { value: 'has_phone', key: 'has_phone', label: 'Có Số điện thoại', type: 'boolean_presence', group: 'profile' },
        { value: 'has_email', key: 'has_email', label: 'Có Địa chỉ Email', type: 'boolean_presence', group: 'profile' },
        { value: 'cf.company', key: 'cf.company', label: 'Công ty / Tổ chức', type: 'text', group: 'profile' },
        { value: 'cf.job_title', key: 'cf.job_title', label: 'Chức danh / Nghề nghiệp', type: 'text', group: 'profile' },
        {
          value: 'cf.gender',
          key: 'cf.gender',
          label: 'Giới tính',
          type: 'select',
          group: 'profile',
          options: [
            { value: 'Nam', label: 'Nam' },
            { value: 'Nữ', label: 'Nữ' },
            { value: 'Khác', label: 'Khác' },
          ],
        },
        { value: 'cf.city', key: 'cf.city', label: 'Tỉnh / Thành phố', type: 'text', group: 'profile' },
        { value: 'cf.address', key: 'cf.address', label: 'Địa chỉ liên hệ', type: 'text', group: 'profile' },
        { value: 'product_interest', key: 'product_interest', label: 'Sản phẩm / Dịch vụ quan tâm', type: 'text', group: 'profile' },
        { value: 'budget_range', key: 'budget_range', label: 'Khoảng ngân sách dự kiến', type: 'text', group: 'profile' },
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
      ],
    },
    {
      id: 'crm_pipeline',
      label: 'CRM Pipeline, Phân bổ & Nguồn QC',
      fields: [
        { value: 'crm_stage_id', key: 'crm_stage_id', label: 'Giai đoạn Pipeline (CRM Stage)', type: 'stage', group: 'crm_pipeline', options: stageOpts },
        {
          value: 'crm_lead_status',
          key: 'crm_lead_status',
          label: 'Trạng thái xử lý Lead',
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
        { value: 'leadScore', key: 'leadScore', label: 'Điểm tương tác (Lead Score)', type: 'number', group: 'crm_pipeline' },
        { value: 'crm_owner_id', key: 'crm_owner_id', label: 'Nhân sự Sale phụ trách', type: 'owner_select', group: 'crm_pipeline', options: userOpts },
        { value: 'crm_team_id', key: 'crm_team_id', label: 'Nhóm Sale (Team)', type: 'team', group: 'crm_pipeline', options: teamOpts },
        { value: 'sla_breached', key: 'sla_breached', label: 'Vi phạm SLA tiếp nhận', type: 'boolean', group: 'crm_pipeline' },
        { value: 'lastActivityDays', key: 'lastActivityDays', label: 'Số ngày chưa tương tác (Ngủ đông)', type: 'number', group: 'crm_pipeline' },
        { value: 'crm_created_at', key: 'crm_created_at', label: 'Ngày tạo Lead', type: 'date', group: 'crm_pipeline' },
        { value: 'source', key: 'source', label: 'Nguồn khách hàng (Source)', type: 'text', group: 'crm_pipeline' },
        { value: 'campaign', key: 'campaign', label: 'Chiến dịch (Campaign)', type: 'text', group: 'crm_pipeline' },
        { value: 'utm_source', key: 'utm_source', label: 'UTM Source', type: 'text', group: 'crm_pipeline' },
        { value: 'utm_medium', key: 'utm_medium', label: 'UTM Medium', type: 'text', group: 'crm_pipeline' },
        { value: 'ad_id', key: 'ad_id', label: 'Meta Ad ID', type: 'text', group: 'crm_pipeline' },
        { value: 'adset_id', key: 'adset_id', label: 'Meta Adset ID', type: 'text', group: 'crm_pipeline' },
        { value: 'campaign_id', key: 'campaign_id', label: 'Meta Campaign ID', type: 'text', group: 'crm_pipeline' },
        { value: 'tags', key: 'tags', label: 'Nhãn phân loại (Tags)', type: 'tags', group: 'crm_pipeline', options: tagOpts },
        { value: 'list', key: 'list', label: 'Thuộc Danh sách Tĩnh (Static List)', type: 'list_select', group: 'crm_pipeline', options: listOpts },
      ],
    },
    {
      id: 'deals_revenue',
      label: 'Cơ hội (Deals) & Doanh thu',
      fields: [
        { value: 'erp_deal_value', key: 'erp_deal_value', label: 'Tổng giá trị Deal / Doanh thu (VNĐ)', type: 'currency', group: 'deals_revenue' },
        { value: 'has_revenue', key: 'has_revenue', label: 'Đã phát sinh doanh thu', type: 'boolean', group: 'deals_revenue' },
        { value: 'is_won_stage', key: 'is_won_stage', label: 'Đã chốt thành công (Won)', type: 'boolean', group: 'deals_revenue' },
        { value: 'is_lost_stage', key: 'is_lost_stage', label: 'Đã thất bại (Lost)', type: 'boolean', group: 'deals_revenue' },
      ],
    },
    {
      id: 'behavior',
      label: 'Hành vi Marketing Đa kênh',
      fields: [
        { value: 'opened_email', key: 'opened_email', label: 'Đã mở Email Marketing', type: 'event', group: 'behavior' },
        { value: 'clicked_email', key: 'clicked_email', label: 'Đã click link trong Email', type: 'event', group: 'behavior' },
        { value: 'submitted_form', key: 'submitted_form', label: 'Đã điền Form đăng ký', type: 'event', group: 'behavior' },
        { value: 'completed_survey', key: 'completed_survey', label: 'Đã hoàn thành Khảo sát / Quiz', type: 'event', group: 'behavior' },
        { value: 'quiz_score', key: 'quiz_score', label: 'Điểm bài Quiz', type: 'number', group: 'behavior' },
        { value: 'visited_url', key: 'visited_url', label: 'Đã truy cập trang Web', type: 'event', group: 'behavior' },
        { value: 'claimed_voucher', key: 'claimed_voucher', label: 'Đã nhận mã Voucher', type: 'event', group: 'behavior' },
        { value: 'received_zns', key: 'received_zns', label: 'Đã nhận Zalo ZNS', type: 'event', group: 'behavior' },
        { value: 'statsOpened', key: 'statsOpened', label: 'Số lần mở Email', type: 'number', group: 'behavior' },
        { value: 'statsClicked', key: 'statsClicked', label: 'Số lần click link', type: 'number', group: 'behavior' },
      ],
    },
  ];

  // Dynamic Custom Fields from `tenants.settings.custom_fields`, `tenant_pipeline_custom_fields`, `tenant_custom_fields`
  const customFieldMap = new Map<string, ConditionFieldOptionDto>();
  const registerCustomField = (rawKey: unknown, rawLabel: unknown, rawType: unknown, rawOpts?: unknown) => {
    const cleanKey = String(rawKey || '').replace(/^(?:cf|custom_fields|custom)\./i, '').trim();
    if (!cleanKey || !/^[a-zA-Z0-9_-]{1,64}$/.test(cleanKey)) return;
    const fullKey = `cf.${cleanKey}`;
    if (customFieldMap.has(fullKey)) return;
    const mappedType = mapCustomFieldType(rawType);
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
      label: String(rawLabel || cleanKey).trim(),
      type: mappedType,
      group: 'custom_fields',
      ...(opts.length > 0 ? { options: opts } : {}),
    });
  };

  for (const row of [...pipeCfRows, ...globalCfRows]) {
    registerCustomField(row.field_key, row.field_label, row.field_type, row.options_json);
  }
  const settingsCustom = rawSettings.custom_fields;
  if (Array.isArray(settingsCustom)) {
    for (const item of settingsCustom) {
      if (item && typeof item === 'object') {
        const obj = item as Record<string, unknown>;
        registerCustomField(obj.key ?? obj.field_key ?? obj.name, obj.label ?? obj.field_label, obj.type ?? obj.field_type, obj.options ?? obj.options_json);
      }
    }
  } else if (settingsCustom && typeof settingsCustom === 'object') {
    for (const [k, v] of Object.entries(settingsCustom as Record<string, unknown>)) {
      if (v && typeof v === 'object' && !Array.isArray(v)) {
        const obj = v as Record<string, unknown>;
        registerCustomField(k, obj.label ?? obj.field_label ?? k, obj.type ?? obj.field_type, obj.options);
      } else {
        registerCustomField(k, typeof v === 'string' ? v : k, 'text');
      }
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
  return {
    groups,
    fields,
    operators_by_type: CONDITION_OPERATORS_BY_TYPE,
    dynamic_options: {
      stages,
      users,
      teams,
      tags,
      lists,
    },
    education_enabled: educationEnabled,
  };
}
