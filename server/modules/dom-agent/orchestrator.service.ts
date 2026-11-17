import crypto from 'node:crypto';
import type { DbClient } from '../../core/database/db-adapter.ts';
import type { TenantContext } from '../../core/context/tenant-context.ts';
import { encryptTenantSecret, decryptTenantSecret } from '../../core/crypto/vault.ts';
import { isOutboundSilentMode } from '../../core/security/outbound-guard.ts';
import { maskPiiInText } from '../../core/security/pii-masker.ts';
import { resolveUserEffectivePermissions, type ResolvedUserRbacResult } from '../../core/security/rbac.ts';
import {
  resolveTenantEntitlementSnapshot,
  type SaasPackageCode,
  type TenantTerminology,
} from '../../core/security/entitlements.ts';
import { normalizeTenantSettings } from '../../core/settings/tenant-settings.ts';
import { tenantRedis } from '../../core/cache/tenant-redis.ts';
import {
  DEFAULT_DOM_AGENT_AVATAR,
  DEFAULT_DOM_AGENT_GREETING,
  DEFAULT_DOM_AGENT_NAME,
  parseJsonArray,
} from './schema.ts';
import {
  normalizeFoldedAscii,
  searchKnowledgeRagInTx,
  type RagCitationItem,
} from './rag.service.ts';
import {
  executeDomAgentToolInTx,
  getGeminiFunctionDeclarationsForCaller,
  hasModuleEntitlement,
  type DomToolExecutionResult,
} from './tools-registry.ts';

export interface TenantDomAgentConfigDto {
  id: string;
  tenant_id: string;
  agent_name: string;
  avatar_url: string;
  greeting_message: string;
  persona_tone: string;
  preferred_model: string;
  temperature: number;
  enable_morning_briefing: boolean;
  guardrail_rules: string[];
  has_byok_gemini: boolean;
  gemini_key_hint: string | null;
  updated_at?: string;
}

export interface SpecialistDescriptor {
  key: string;
  name: string;
  badge: string;
  description: string;
  required_module: string;
  unlocked: boolean;
  upgrade_package: SaasPackageCode | null;
  quick_prompts: string[];
}

export function buildSpecialistsCatalog(
  enabledModules: readonly string[],
  terminology: TenantTerminology
): SpecialistDescriptor[] {
  const cust = terminology.customer_singular;
  const deal = terminology.deal_singular;
  const proj = terminology.project_singular;

  const hasSales =
    hasModuleEntitlement(enabledModules, 'dom_sales_copilot') ||
    hasModuleEntitlement(enabledModules, 'rounds');
  const hasMkt =
    hasModuleEntitlement(enabledModules, 'dom_marketing_copilot') ||
    hasModuleEntitlement(enabledModules, 'audiences');
  const hasPromax = hasModuleEntitlement(enabledModules, 'dom_agent');

  return [
    {
      key: 'orchestrator',
      name: 'DOM Orchestrator (Tổng Điều Phối)',
      badge: 'Core AI',
      description: `Điều phối đa nhiệm xuyên suốt các phân hệ mở khóa và kho tri thức RAG nội bộ.`,
      required_module: 'leads',
      unlocked: true,
      upgrade_package: null,
      quick_prompts: [
        `Tổng hợp tình hình ${cust} mới và cảnh báo SLA hôm nay`,
        'Tra cứu quy định & chính sách nội bộ của công ty',
        'Kiểm tra quyền hạn RBAC hiện tại của tài khoản tôi',
      ],
    },
    {
      key: 'crm_sales',
      name: 'Chuyên gia Kinh doanh & Chia số',
      badge: 'Sales Copilot',
      description: `Theo dõi phễu ${deal}, radar khách nóng, vòng chia Fair-Share và nhắc lịch chăm lại.`,
      required_module: 'dom_sales_copilot',
      unlocked: hasSales,
      upgrade_package: hasSales ? null : 'growth_combo',
      quick_prompts: [
        `Danh sách ${cust} điểm nóng cao cần gọi ngay`,
        'Kiểm tra trạng thái các vòng chia Fair-Share và SLA vi phạm',
        'Bảng xếp hạng hiệu suất đội ngũ tư vấn',
      ],
    },
    {
      key: 'marketing_growth',
      name: 'Chuyên gia Marketing & Tăng trưởng',
      badge: 'Marketing Copilot',
      description: 'Phân tích Tệp Data / Tệp Logic, soạn Email chống Spam, chiến dịch đa kênh & ROAS.',
      required_module: 'dom_marketing_copilot',
      unlocked: hasMkt,
      upgrade_package: hasMkt ? null : 'growth_combo',
      quick_prompts: [
        'Liệt kê các Tệp Data và Tệp Logic đang hoạt động',
        `Soạn mẫu Email giới thiệu ưu đãi cho ${cust}`,
        'Báo cáo phân bổ doanh thu và chỉ số ROAS xuyên phễu',
      ],
    },
    {
      key: 'executive_bi',
      name: 'Hội đồng Điều hành CEO & BI 360°',
      badge: 'PROMAX Council',
      description: 'Tổng hợp bức tranh điều hành toàn công ty: Doanh thu, Dòng tiền, Phễu, Nhân sự & KPI.',
      required_module: 'dom_agent',
      unlocked: hasPromax,
      upgrade_package: hasPromax ? null : 'domation_promax',
      quick_prompts: [
        'Đánh giá các chỉ số Custom KPI của doanh nghiệp so với mục tiêu',
        'Tổng quan định biên nhân sự theo từng phòng ban & chi nhánh',
        'Báo cáo dòng tiền Thu - Chi P&L và hiệu quả kinh doanh',
      ],
    },
    {
      key: 'hr_approvals',
      name: 'Chuyên gia Nhân sự, Chấm công & Phê duyệt',
      badge: 'PROMAX Council',
      description: 'Tra cứu phép năm, chấm công GPS, tính thuế TNCN / BHXH và hộp thư đề xuất chờ duyệt.',
      required_module: 'dom_agent',
      unlocked: hasPromax,
      upgrade_package: hasPromax ? null : 'domation_promax',
      quick_prompts: [
        'Kiểm tra quỹ phép năm còn lại và các đề xuất chờ phê duyệt',
        'Tính lương Gross sang Net cho mức lương 30.000.000 VNĐ (1 người phụ thuộc)',
        'Báo cáo tình hình chấm công GPS và hợp đồng sắp hết hạn',
      ],
    },
    {
      key: 'finance_ops',
      name: 'Chuyên gia Tài chính, Kho FIFO & Dự án',
      badge: 'PROMAX Council',
      description: `Theo dõi tiến độ ${proj}, công nợ hóa đơn, đơn hàng SO/PO, tồn kho FIFO & tài liệu Cloud.`,
      required_module: 'dom_agent',
      unlocked: hasPromax,
      upgrade_package: hasPromax ? null : 'domation_promax',
      quick_prompts: [
        `Rà soát các công việc đang mở và công việc quá hạn trên ${proj}`,
        'Tổng hợp dòng tiền Thu - Chi và công nợ hóa đơn quá hạn',
        'Kiểm tra cảnh báo tồn kho thấp FIFO và danh mục tài sản cấp phát',
      ],
    },
  ];
}

async function resolveTenantGeminiByokKey(
  client: DbClient,
  tenantId: string
): Promise<{ apiKey: string | null; modelOverride?: string; keyHint: string | null }> {
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
  if (!row) {
    return { apiKey: null, keyHint: null };
  }

  try {
    const decrypted = decryptTenantSecret<Record<string, unknown>>(
      tenantId,
      row.config_encrypted,
      row.iv,
      row.auth_tag
    );
    const rawKey = String(
      decrypted.api_key || decrypted.gemini_api_key || decrypted.apiKey || ''
    ).trim();
    if (!rawKey) {
      return { apiKey: null, keyHint: null };
    }
    const hint =
      rawKey.length >= 8
        ? `${rawKey.slice(0, 4)}••••••••${rawKey.slice(-4)}`
        : '••••••••';
    const modelOverride =
      typeof decrypted.model === 'string' && decrypted.model.trim()
        ? decrypted.model.trim()
        : undefined;
    return { apiKey: rawKey, modelOverride, keyHint: hint };
  } catch {
    return { apiKey: null, keyHint: null };
  }
}

export async function getOrSeedTenantAgentConfigInTx(
  client: DbClient,
  tenantId: string
): Promise<TenantDomAgentConfigDto> {
  const [existingRes, tenantRes, byok] = await Promise.all([
    client.query('SELECT * FROM tenant_ai_agent_configs WHERE tenant_id = $1 LIMIT 1', [tenantId]),
    client.query<{ settings: Record<string, unknown> }>(
      'SELECT settings FROM tenants WHERE id = $1 LIMIT 1',
      [tenantId]
    ),
    resolveTenantGeminiByokKey(client, tenantId),
  ]);

  const settings = normalizeTenantSettings(tenantRes.rows[0]?.settings);
  let row = existingRes.rows[0];

  if (!row) {
    const id = crypto.randomUUID();
    const initialName = settings.ai_agent_name || DEFAULT_DOM_AGENT_NAME;
    const initialAvatar = settings.ai_avatar_url || DEFAULT_DOM_AGENT_AVATAR;
    await client.query(
      `INSERT INTO tenant_ai_agent_configs (
         id, tenant_id, agent_name, avatar_url, greeting_message,
         persona_tone, preferred_model, temperature, enable_morning_briefing, guardrail_rules
       ) VALUES ($1, $2, $3, $4, $5, 'executive_concise', 'gemini-2.5-flash', 0.25, true, '[]'::jsonb)
       ON CONFLICT (tenant_id) DO NOTHING`,
      [id, tenantId, initialName, initialAvatar, DEFAULT_DOM_AGENT_GREETING]
    );
    const reread = await client.query(
      'SELECT * FROM tenant_ai_agent_configs WHERE tenant_id = $1 LIMIT 1',
      [tenantId]
    );
    row = reread.rows[0];
  }

  return {
    id: String(row?.id || ''),
    tenant_id: tenantId,
    agent_name: String(row?.agent_name || DEFAULT_DOM_AGENT_NAME),
    avatar_url: String(row?.avatar_url || DEFAULT_DOM_AGENT_AVATAR),
    greeting_message: String(row?.greeting_message || DEFAULT_DOM_AGENT_GREETING),
    persona_tone: String(row?.persona_tone || 'executive_concise'),
    preferred_model: String(row?.preferred_model || 'gemini-2.5-flash'),
    temperature: Number(row?.temperature ?? 0.25),
    enable_morning_briefing: Boolean(row?.enable_morning_briefing ?? true),
    guardrail_rules: parseJsonArray<string>(row?.guardrail_rules),
    has_byok_gemini: Boolean(byok.apiKey),
    gemini_key_hint: byok.keyHint,
    updated_at: row?.updated_at ? String(row.updated_at) : undefined,
  };
}

export async function upsertTenantAgentConfigInTx(
  client: DbClient,
  tenantId: string,
  actorUserId: string,
  patch: Record<string, unknown>
): Promise<TenantDomAgentConfigDto> {
  await getOrSeedTenantAgentConfigInTx(client, tenantId);

  const agentName =
    typeof patch.agent_name === 'string' && patch.agent_name.trim()
      ? patch.agent_name.trim().slice(0, 120)
      : null;
  const avatarUrl =
    typeof patch.avatar_url === 'string' && patch.avatar_url.trim()
      ? patch.avatar_url.trim()
      : null;
  const greeting =
    typeof patch.greeting_message === 'string' && patch.greeting_message.trim()
      ? patch.greeting_message.trim()
      : null;
  const tone =
    typeof patch.persona_tone === 'string' && patch.persona_tone.trim()
      ? patch.persona_tone.trim().slice(0, 50)
      : null;
  const model =
    typeof patch.preferred_model === 'string' && patch.preferred_model.trim()
      ? patch.preferred_model.trim().slice(0, 80)
      : null;
  const temp =
    patch.temperature !== undefined && Number.isFinite(Number(patch.temperature))
      ? Math.max(0, Math.min(1, Number(patch.temperature)))
      : null;
  const morningBriefing =
    typeof patch.enable_morning_briefing === 'boolean' ? patch.enable_morning_briefing : null;
  const guardrails = Array.isArray(patch.guardrail_rules)
    ? patch.guardrail_rules.map((r) => String(r || '').trim()).filter(Boolean)
    : null;

  await client.query(
    `UPDATE tenant_ai_agent_configs
     SET agent_name = COALESCE($2, agent_name),
         avatar_url = COALESCE($3, avatar_url),
         greeting_message = COALESCE($4, greeting_message),
         persona_tone = COALESCE($5, persona_tone),
         preferred_model = COALESCE($6, preferred_model),
         temperature = COALESCE($7, temperature),
         enable_morning_briefing = COALESCE($8, enable_morning_briefing),
         guardrail_rules = COALESCE($9::jsonb, guardrail_rules),
         updated_by = $10,
         updated_at = clock_timestamp()
     WHERE tenant_id = $1`,
    [
      tenantId,
      agentName,
      avatarUrl,
      greeting,
      tone,
      model,
      temp,
      morningBriefing,
      guardrails ? JSON.stringify(guardrails) : null,
      actorUserId,
    ]
  );

  // Sync White-Label agent_name & avatar_url to tenants.settings if changed
  if (agentName || avatarUrl) {
    const tRes = await client.query<{ slug: string; settings: Record<string, unknown> }>(
      'SELECT slug, settings FROM tenants WHERE id = $1 LIMIT 1',
      [tenantId]
    );
    if (tRes.rows[0]) {
      const curSettings =
        tRes.rows[0].settings && typeof tRes.rows[0].settings === 'object'
          ? { ...tRes.rows[0].settings }
          : {};
      if (agentName) curSettings.ai_agent_name = agentName;
      if (avatarUrl) curSettings.ai_avatar_url = avatarUrl;
      await client.query(
        'UPDATE tenants SET settings = $2::jsonb, updated_at = clock_timestamp() WHERE id = $1',
        [tenantId, JSON.stringify(curSettings)]
      );
      tenantRedis.invalidateTenantCache(tenantId, tRes.rows[0].slug);
    }
  }

  // Optional BYOK Gemini API Key update in AES-256-GCM Vault
  if (typeof patch.gemini_api_key === 'string') {
    const rawKey = patch.gemini_api_key.trim();
    if (rawKey === '__CLEAR__') {
      await client.query(
        `DELETE FROM tenant_integrations WHERE tenant_id = $1 AND integration_type = 'ai_gemini_byok'`,
        [tenantId]
      );
      tenantRedis.invalidateTenantIntegrations(tenantId, 'ai_gemini_byok');
    } else if (rawKey && !rawKey.includes('••••')) {
      const encrypted = encryptTenantSecret(tenantId, {
        api_key: rawKey,
        model: model || 'gemini-2.5-flash',
      });
      await client.query(
        `INSERT INTO tenant_integrations (
           id, tenant_id, integration_type, config_encrypted, iv, auth_tag, status, last_synced_at
         ) VALUES ($1, $2, 'ai_gemini_byok', $3, $4, $5, 'active', clock_timestamp())
         ON CONFLICT (tenant_id, integration_type) DO UPDATE SET
           config_encrypted = EXCLUDED.config_encrypted,
           iv = EXCLUDED.iv,
           auth_tag = EXCLUDED.auth_tag,
           status = 'active',
           last_synced_at = clock_timestamp()`,
        [
          crypto.randomUUID(),
          tenantId,
          encrypted.configEncrypted,
          encrypted.iv,
          encrypted.authTag,
        ]
      );
      tenantRedis.invalidateTenantIntegrations(tenantId, 'ai_gemini_byok');
    }
  }

  return getOrSeedTenantAgentConfigInTx(client, tenantId);
}

interface PlannedToolCall {
  toolName: string;
  args: Record<string, unknown>;
}

function inferLocalToolsFromMessage(
  prompt: string,
  specialistKey: string
): PlannedToolCall[] {
  const folded = normalizeFoldedAscii(prompt);
  const calls: PlannedToolCall[] = [];

  const pushUnique = (toolName: string, args: Record<string, unknown> = {}) => {
    if (!calls.some((c) => c.toolName === toolName)) {
      calls.push({ toolName, args });
    }
  };

  if (folded.includes('bang luong') || folded.includes('quy luong') || folded.includes('payslip')) {
    pushUnique('hrm_payroll_period_summary');
  }
  if (folded.includes('gross') || folded.includes('thue tncn') || folded.includes('bhxh')) {
    const numMatch = prompt.replace(/[.,_]/g, '').match(/(\d{7,10})/);
    pushUnique('hrm_pit_bhxh_calculator', {
      gross_salary_vnd: numMatch ? Number(numMatch[1]) : 25_000_000,
      dependents_count: folded.includes('phu thuoc') ? 1 : 0,
    });
  }
  if (folded.includes('nghi phep') || folded.includes('phep nam') || folded.includes('leave')) {
    pushUnique('hrm_my_leave_balance');
  }
  if (folded.includes('phe duyet') || folded.includes('cho duyet') || folded.includes('approval')) {
    pushUnique('hrm_pending_approvals_inbox');
  }
  if (folded.includes('cham cong') || folded.includes('di tre') || folded.includes('attendance')) {
    pushUnique('hrm_late_absent_report');
  }
  if (folded.includes('hop dong lao dong') || folded.includes('het han hop dong')) {
    pushUnique('hrm_contract_expiring_alerts');
  }
  if (folded.includes('tep data') || folded.includes('tep logic') || folded.includes('audience')) {
    pushUnique('mkt_list_audiences');
  }
  if (folded.includes('soan email') || folded.includes('mau email') || folded.includes('draft email')) {
    pushUnique('mkt_draft_email_copy', { goal: prompt.slice(0, 120) });
  }
  if (folded.includes('spam')) {
    pushUnique('mkt_spam_check_copy', { subject: prompt.slice(0, 80), body: prompt });
  }
  if (folded.includes('chien dich') || folded.includes('zns')) {
    pushUnique('mkt_campaign_metrics');
  }
  if (folded.includes('roas') || folded.includes('phan bo doanh thu') || folded.includes('attribution')) {
    pushUnique('mkt_growth_roas_attribution');
  }
  if (folded.includes('dong tien') || folded.includes('thu chi') || folded.includes('p l') || folded.includes('loi nhuan')) {
    pushUnique('ops_cashflow_pnl_summary');
  }
  if (folded.includes('hoa don qua han') || folded.includes('cong no')) {
    pushUnique('ops_overdue_invoices');
  }
  if (folded.includes('ton kho') || folded.includes('fifo')) {
    pushUnique('ops_low_stock_fifo_alerts');
  }
  if (folded.includes('tai san')) {
    pushUnique('ops_my_assigned_assets');
  }
  if (folded.includes('cong viec') || folded.includes('task') || folded.includes('qua han')) {
    if (folded.includes('qua han')) pushUnique('ops_overdue_project_tasks');
    else pushUnique('ops_my_open_tasks');
  }
  if (folded.includes('lich hoc') || folded.includes('dao tao') || folded.includes('hoc vu')) {
    pushUnique('edu_class_schedule_lookup');
  }
  if (folded.includes('quyen han') || folded.includes('rbac') || folded.includes('phan quyen cua toi')) {
    pushUnique('org_inspect_my_permissions');
  }
  if (folded.includes('so do to chuc') || folded.includes('phong ban') || folded.includes('chi nhanh')) {
    pushUnique('org_list_structure');
  }
  if (folded.includes('kpi')) {
    pushUnique('org_evaluate_custom_kpis');
  }
  if (folded.includes('sla') || folded.includes('cham tiep nhan')) {
    pushUnique('crm_sla_breaches');
  }
  if (folded.includes('vong chia') || folded.includes('fair share') || folded.includes('round robin')) {
    pushUnique('crm_round_robin_queue_status');
  }
  if (folded.includes('xep hang') || folded.includes('leaderboard') || folded.includes('hieu suat')) {
    pushUnique('crm_top_sales_leaderboard');
  }
  if (folded.includes('khach nong') || folded.includes('hot lead') || folded.includes('diem nong')) {
    pushUnique('crm_hot_lead_radar');
  }
  if (folded.includes('pheu') || folded.includes('pipeline') || folded.includes('stage')) {
    pushUnique('crm_stage_distribution');
  }
  if (
    folded.includes('khach hang') ||
    folded.includes('lead') ||
    folded.includes('danh sach so') ||
    folded.includes('tim kiem')
  ) {
    pushUnique('crm_search_leads', { limit: 10 });
  }

  // Fallback default tool per specialist when no explicit keyword matched and no policy-only query
  const isPolicyQuery =
    folded.includes('noi quy') ||
    folded.includes('chinh sach') ||
    folded.includes('quy dinh') ||
    folded.includes('dieu khoan') ||
    folded.includes('sop') ||
    folded.includes('bao hanh');

  if (calls.length === 0 && !isPolicyQuery) {
    if (specialistKey === 'crm_sales') pushUnique('crm_search_leads', { limit: 8 });
    else if (specialistKey === 'marketing_growth') pushUnique('mkt_list_audiences');
    else if (specialistKey === 'hr_approvals') pushUnique('hrm_my_leave_balance');
    else if (specialistKey === 'finance_ops') pushUnique('ops_my_open_tasks');
    else if (specialistKey === 'executive_bi') pushUnique('org_evaluate_custom_kpis');
  }

  return calls.slice(0, 3);
}

function summarizeToolResultMarkdown(res: DomToolExecutionResult): string {
  if (!res.allowed) {
    return `- 🔒 **${res.tool_title || res.tool_name}** (\`${res.tool_name}\`): Đã chặn bởi hàng rào bảo mật — ${res.denial_reason || 'Không đủ quyền truy cập.'}`;
  }
  const out = res.output || {};
  const compactEntries = Object.entries(out)
    .filter(([, v]) => typeof v === 'number' || typeof v === 'string' || typeof v === 'boolean')
    .slice(0, 5)
    .map(([k, v]) => {
      if (typeof v === 'number' && k.endsWith('_vnd')) {
        return `**${k}**: ${Math.round(v).toLocaleString('vi-VN')}₫`;
      }
      return `**${k}**: ${String(v)}`;
    });

  let detailLine = compactEntries.join(' • ');
  if (Array.isArray(out.items) && out.items.length > 0) {
    const sampleNames = out.items
      .slice(0, 3)
      .map((it: Record<string, unknown>) => {
        const label = String(it.name || it.title || it.full_name || it.id || '');
        const ph = it.phone ? ` (${String(it.phone)})` : '';
        return `${label}${ph}`;
      })
      .join(', ');
    detailLine = `${detailLine ? `${detailLine} — ` : ''}Mẫu dữ liệu: ${sampleNames}`;
  } else if (Array.isArray(out.hot_leads) && out.hot_leads.length > 0) {
    const sampleNames = out.hot_leads
      .slice(0, 3)
      .map((it: Record<string, unknown>) => `${String(it.name || '')} (Score: ${String(it.lead_score ?? 0)})`)
      .join(', ');
    detailLine = `${detailLine ? `${detailLine} — ` : ''}Khách nóng: ${sampleNames}`;
  }

  return `- ✅ **${res.tool_title || res.tool_name}** (\`${res.tool_name}\`, phạm vi \`${res.effective_scope}\`): ${detailLine || 'Thực thi thành công.'}`;
}

async function tryLiveGeminiOrchestration(params: {
  apiKey: string;
  model: string;
  temperature: number;
  systemPrompt: string;
  userPrompt: string;
  resolvedRbac: ResolvedUserRbacResult;
  specialistKey: string;
  client: DbClient;
  tenantCtx: TenantContext;
}): Promise<{ text: string; toolExecutions: DomToolExecutionResult[] } | null> {
  if (!params.apiKey || isOutboundSilentMode()) {
    return null;
  }

  const declarations = getGeminiFunctionDeclarationsForCaller(
    params.resolvedRbac,
    params.specialistKey
  );
  const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(params.model)}:generateContent?key=${encodeURIComponent(params.apiKey)}`;

  const contents: Array<Record<string, unknown>> = [
    { role: 'user', parts: [{ text: params.userPrompt }] },
  ];
  const toolExecutions: DomToolExecutionResult[] = [];

  try {
    for (let round = 0; round < 3; round++) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 12_000);
      const resp = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal: controller.signal,
        body: JSON.stringify({
          systemInstruction: { parts: [{ text: params.systemPrompt }] },
          contents,
          tools: declarations.length > 0 ? [{ functionDeclarations: declarations }] : undefined,
          generationConfig: {
            temperature: params.temperature,
            maxOutputTokens: 1200,
          },
        }),
      }).finally(() => clearTimeout(timer));

      if (!resp.ok) {
        return null;
      }

      const payload = (await resp.json()) as Record<string, unknown>;
      const candidates = Array.isArray(payload.candidates) ? payload.candidates : [];
      const firstCand = (candidates[0] || {}) as Record<string, unknown>;
      const contentObj = (firstCand.content || {}) as Record<string, unknown>;
      const parts = Array.isArray(contentObj.parts)
        ? (contentObj.parts as Array<Record<string, unknown>>)
        : [];

      const fnCalls = parts.filter((p) => p.functionCall && typeof p.functionCall === 'object');
      if (fnCalls.length === 0) {
        const textOut = parts
          .map((p) => (typeof p.text === 'string' ? p.text : ''))
          .join('\n')
          .trim();
        if (!textOut) return null;
        return { text: textOut, toolExecutions };
      }

      contents.push({ role: 'model', parts });
      const responseParts: Array<Record<string, unknown>> = [];

      for (const fcPart of fnCalls) {
        const fc = fcPart.functionCall as { name?: string; args?: Record<string, unknown> };
        const execRes = await executeDomAgentToolInTx(
          params.client,
          params.tenantCtx,
          String(fc.name || ''),
          fc.args || {}
        );
        toolExecutions.push(execRes);
        responseParts.push({
          functionResponse: {
            name: String(fc.name || ''),
            response: execRes.allowed
              ? { allowed: true, scope: execRes.effective_scope, data: execRes.output }
              : { allowed: false, error: execRes.denial_reason },
          },
        });
      }

      contents.push({ role: 'user', parts: responseParts });
    }
    return null;
  } catch {
    return null;
  }
}

export interface ChatTurnResult {
  thread: Record<string, unknown>;
  user_message: Record<string, unknown>;
  assistant_message: Record<string, unknown>;
  tool_executions: DomToolExecutionResult[];
  citations: RagCitationItem[];
  engine_mode: 'gemini_byok_live' | 'local_deterministic_orchestrator';
}

export async function runDomAgentChatTurnInTx(
  client: DbClient,
  tenantCtx: TenantContext,
  input: {
    threadId?: string | null;
    specialistKey?: string;
    message: string;
    explicitToolName?: string;
    explicitToolArgs?: Record<string, unknown>;
  }
): Promise<
  | { ok: true; data: ChatTurnResult }
  | { ok: false; status: number; code: string; message: string }
> {
  const startedAt = Date.now();
  const cleanMessage = String(input.message || '').trim();
  if (!cleanMessage) {
    return {
      ok: false,
      status: 422,
      code: 'EMPTY_CHAT_MESSAGE',
      message: 'Nội dung câu hỏi gửi cho trợ lý không được để trống.',
    };
  }

  const [agentConfig, resolvedRbac, tenantRes, byok] = await Promise.all([
    getOrSeedTenantAgentConfigInTx(client, tenantCtx.tenantId),
    resolveUserEffectivePermissions(client, tenantCtx.tenantId, tenantCtx.userId),
    client.query<{
      name: string;
      package_code?: string;
      plan_tier: string;
      subscription_plan_code: string | null;
      crm_erp_upgrade_status: string | null;
      industry: string;
      industry_key?: string;
      enabled_modules?: unknown;
      entitlements?: unknown;
      settings: Record<string, unknown>;
    }>(
      `SELECT name, package_code, plan_tier, subscription_plan_code, crm_erp_upgrade_status,
              industry, industry_key, enabled_modules, entitlements, settings
       FROM tenants WHERE id = $1 LIMIT 1`,
      [tenantCtx.tenantId]
    ),
    resolveTenantGeminiByokKey(client, tenantCtx.tenantId),
  ]);

  const tRow = tenantRes.rows[0] || { name: 'Doanh nghiệp', plan_tier: 'starter', subscription_plan_code: null, crm_erp_upgrade_status: null, industry: 'general', settings: {} };
  const entSnap = resolveTenantEntitlementSnapshot(tRow);
  const normSettings = normalizeTenantSettings(tRow.settings);
  const specialists = buildSpecialistsCatalog(resolvedRbac.enabledModules, entSnap.terminology);

  const requestedSpecialistKey = String(input.specialistKey || 'orchestrator').trim();
  const matchedSpec = specialists.find((s) => s.key === requestedSpecialistKey) || specialists[0];
  if (!matchedSpec.unlocked) {
    return {
      ok: false,
      status: 403,
      code: 'SPECIALIST_NOT_ENTITLED',
      message: `Chuyên gia '${matchedSpec.name}' yêu cầu nâng cấp lên gói '${matchedSpec.upgrade_package || 'domation_promax'}' để mở khóa.`,
    };
  }

  // Ensure or create User-Isolated Thread
  let threadId = input.threadId ? String(input.threadId).trim() : '';
  if (threadId) {
    const tCheck = await client.query<{ id: string }>(
      'SELECT id FROM tenant_ai_threads WHERE tenant_id = $1 AND id = $2 AND user_id = $3 LIMIT 1',
      [tenantCtx.tenantId, threadId, tenantCtx.userId]
    );
    if (!tCheck.rows[0]) {
      threadId = '';
    }
  }

  if (!threadId) {
    threadId = crypto.randomUUID();
    const autoTitle = cleanMessage.slice(0, 72);
    await client.query(
      `INSERT INTO tenant_ai_threads (id, tenant_id, user_id, specialist_key, title, is_pinned, last_message_at)
       VALUES ($1, $2, $3, $4, $5, false, clock_timestamp())`,
      [threadId, tenantCtx.tenantId, tenantCtx.userId, matchedSpec.key, autoTitle]
    );
  }

  // Persist User Message
  const userMsgId = crypto.randomUUID();
  await client.query(
    `INSERT INTO tenant_ai_messages (id, tenant_id, thread_id, role, content, tool_calls, citations, latency_ms)
     VALUES ($1, $2, $3, 'user', $4, '[]'::jsonb, '[]'::jsonb, 0)`,
    [userMsgId, tenantCtx.tenantId, threadId, cleanMessage]
  );

  // Step 1: Retrieve Tenant-Isolated & Department-ACL-Filtered RAG Context
  const ragSearch = await searchKnowledgeRagInTx(
    client,
    tenantCtx.tenantId,
    resolvedRbac.userOrg,
    cleanMessage,
    { topK: 4 }
  );
  const citations = ragSearch.citations;

  // Step 2: Try Live Gemini BYOK Orchestration if configured, else Deterministic Local Orchestrator
  let engineMode: 'gemini_byok_live' | 'local_deterministic_orchestrator' =
    'local_deterministic_orchestrator';
  let assistantText = '';
  let toolExecutions: DomToolExecutionResult[] = [];

  const systemPrompt = [
    `Bạn là ${agentConfig.agent_name}, trợ lý điều hành doanh nghiệp của "${tRow.name}" (Ngành: ${entSnap.terminology.industry_label}, Gói cước: ${entSnap.package_code}).`,
    `Phong cách phản hồi: ${agentConfig.persona_tone}. Tuyệt đối chỉ dựa trên dữ liệu công cụ và kho tri thức nội bộ của chính doanh nghiệp này; không bịa đặt số liệu.`,
    agentConfig.guardrail_rules.length > 0
      ? `Quy tắc bảo vệ bắt buộc: ${agentConfig.guardrail_rules.join(' | ')}`
      : '',
    citations.length > 0
      ? `Trích dẫn tri thức nội bộ khớp câu hỏi:\n${citations.map((c, i) => `[${i + 1}] ${c.title}: ${c.snippet}`).join('\n')}`
      : '',
  ]
    .filter(Boolean)
    .join('\n\n');

  if (byok.apiKey && !input.explicitToolName) {
    const geminiOut = await tryLiveGeminiOrchestration({
      apiKey: byok.apiKey,
      model: byok.modelOverride || agentConfig.preferred_model || 'gemini-2.5-flash',
      temperature: agentConfig.temperature,
      systemPrompt,
      userPrompt: cleanMessage,
      resolvedRbac,
      specialistKey: matchedSpec.key,
      client,
      tenantCtx,
    });
    if (geminiOut) {
      engineMode = 'gemini_byok_live';
      assistantText = geminiOut.text;
      toolExecutions = geminiOut.toolExecutions;
    }
  }

  if (!assistantText) {
    const planned: PlannedToolCall[] = input.explicitToolName
      ? [{ toolName: input.explicitToolName, args: input.explicitToolArgs || {} }]
      : inferLocalToolsFromMessage(cleanMessage, matchedSpec.key);

    for (const call of planned) {
      const execRes = await executeDomAgentToolInTx(
        client,
        tenantCtx,
        call.toolName,
        call.args
      );
      toolExecutions.push(execRes);
    }

    const sections: string[] = [
      `### 🤖 ${agentConfig.agent_name} • ${matchedSpec.name}`,
    ];

    if (toolExecutions.length > 0) {
      sections.push(
        '**Kết quả tra cứu & thực thi công cụ theo phân quyền RBAC:**',
        toolExecutions.map(summarizeToolResultMarkdown).join('\n')
      );
    }

    if (citations.length > 0) {
      sections.push(
        '**Trích dẫn từ Kho Tri thức Nội bộ (RAG):**',
        citations
          .map((c, idx) => `${idx + 1}. **[${c.title}]** (*${c.category}*): ${c.snippet}`)
          .join('\n')
      );
    }

    if (toolExecutions.length === 0 && citations.length === 0) {
      sections.push(
        `${agentConfig.greeting_message}\n\nHiện chưa tìm thấy tài liệu nội bộ khớp trực tiếp với từ khóa vừa nêu${
          ragSearch.filtered_by_department_acl > 0
            ? ` (${ragSearch.filtered_by_department_acl} tài liệu giới hạn riêng cho phòng ban khác đã được lọc bảo mật)`
            : ''
        }. Bạn có thể chọn một tác vụ nhanh hoặc mở tab **72 Công cụ & Nhật ký RBAC** để kích hoạt trực tiếp.`
      );
    }

    assistantText = sections.join('\n\n');
  }

  // Final Server-Side PII Guardrail on Assistant Output
  const canUnmaskLeads = Boolean(resolvedRbac.effectivePermissions.leads?.actions.unmask_phone);
  if (!canUnmaskLeads) {
    assistantText =
      maskPiiInText(assistantText, {
        pii_masking_enabled: normSettings.pii_masking_enabled,
        pii_mask_phone_prefix: normSettings.pii_mask_phone_prefix,
        pii_mask_phone_suffix: normSettings.pii_mask_phone_suffix,
        pii_mask_char: normSettings.pii_mask_char,
        pii_mask_email: normSettings.pii_mask_email,
        default_dial_code: normSettings.default_dial_code,
      }) || assistantText;
  }

  const totalLatency = Date.now() - startedAt;

  // Persist optional tool message records when tools were invoked
  for (const te of toolExecutions) {
    await client.query(
      `INSERT INTO tenant_ai_messages (
         id, tenant_id, thread_id, role, content, tool_calls, citations, latency_ms, model_used
       ) VALUES ($1, $2, $3, 'tool', $4, $5::jsonb, '[]'::jsonb, $6, $7)`,
      [
        crypto.randomUUID(),
        tenantCtx.tenantId,
        threadId,
        te.allowed ? `Executed ${te.tool_name}` : `Blocked ${te.tool_name}: ${te.denial_reason || ''}`,
        JSON.stringify([te]),
        te.latency_ms,
        engineMode,
      ]
    );
  }

  const assistantMsgId = crypto.randomUUID();
  await client.query(
    `INSERT INTO tenant_ai_messages (
       id, tenant_id, thread_id, role, content, tool_calls, citations, latency_ms, model_used
     ) VALUES ($1, $2, $3, 'assistant', $4, $5::jsonb, $6::jsonb, $7, $8)`,
    [
      assistantMsgId,
      tenantCtx.tenantId,
      threadId,
      assistantText,
      JSON.stringify(toolExecutions),
      JSON.stringify(citations),
      totalLatency,
      engineMode === 'gemini_byok_live' ? agentConfig.preferred_model : 'dom-local-orchestrator-v2',
    ]
  );

  await client.query(
    `UPDATE tenant_ai_threads
     SET specialist_key = $3,
         last_message_at = clock_timestamp(),
         updated_at = clock_timestamp()
     WHERE tenant_id = $1 AND id = $2`,
    [tenantCtx.tenantId, threadId, matchedSpec.key]
  );

  const [threadRes, userMsgRes, assistantMsgRes] = await Promise.all([
    client.query('SELECT * FROM tenant_ai_threads WHERE tenant_id = $1 AND id = $2 LIMIT 1', [
      tenantCtx.tenantId,
      threadId,
    ]),
    client.query('SELECT * FROM tenant_ai_messages WHERE tenant_id = $1 AND id = $2 LIMIT 1', [
      tenantCtx.tenantId,
      userMsgId,
    ]),
    client.query('SELECT * FROM tenant_ai_messages WHERE tenant_id = $1 AND id = $2 LIMIT 1', [
      tenantCtx.tenantId,
      assistantMsgId,
    ]),
  ]);

  return {
    ok: true,
    data: {
      thread: threadRes.rows[0] || { id: threadId },
      user_message: userMsgRes.rows[0] || { id: userMsgId, role: 'user', content: cleanMessage },
      assistant_message: {
        ...(assistantMsgRes.rows[0] || { id: assistantMsgId, role: 'assistant', content: assistantText }),
        tool_calls: toolExecutions,
        citations,
      },
      tool_executions: toolExecutions,
      citations,
      engine_mode: engineMode,
    },
  };
}

export async function generateMorningBriefingInTx(
  client: DbClient,
  tenantCtx: TenantContext
): Promise<Record<string, unknown>> {
  const [agentConfig, resolvedRbac, tenantRes] = await Promise.all([
    getOrSeedTenantAgentConfigInTx(client, tenantCtx.tenantId),
    resolveUserEffectivePermissions(client, tenantCtx.tenantId, tenantCtx.userId),
    client.query<{
      name: string;
      package_code?: string;
      plan_tier: string;
      subscription_plan_code: string | null;
      crm_erp_upgrade_status: string | null;
      industry: string;
      industry_key?: string;
      enabled_modules?: unknown;
      entitlements?: unknown;
      settings: Record<string, unknown>;
    }>(
      `SELECT name, package_code, plan_tier, subscription_plan_code, crm_erp_upgrade_status,
              industry, industry_key, enabled_modules, entitlements, settings
       FROM tenants WHERE id = $1 LIMIT 1`,
      [tenantCtx.tenantId]
    ),
  ]);

  const tRow = tenantRes.rows[0] || { name: 'Doanh nghiệp', plan_tier: 'starter', subscription_plan_code: null, crm_erp_upgrade_status: null, industry: 'general', settings: {} };
  const entSnap = resolveTenantEntitlementSnapshot(tRow);

  const candidateBriefingTools = [
    'crm_sla_breaches',
    'crm_hot_lead_radar',
    'crm_round_robin_queue_status',
    'mkt_list_audiences',
    'mkt_growth_roas_attribution',
    'hrm_pending_approvals_inbox',
    'ops_overdue_project_tasks',
    'ops_cashflow_pnl_summary',
  ];

  const cards: Array<{
    tool_name: string;
    title: string;
    module_key: string;
    scope: string;
    metrics: Record<string, unknown>;
  }> = [];

  const actionItems: string[] = [];

  for (const tName of candidateBriefingTools) {
    // Only invoke tools that are unlocked & permitted for this caller so briefing produces zero false-denial logs
    const checkModMap: Record<string, string> = {
      crm_sla_breaches: 'leads',
      crm_hot_lead_radar: 'sale_portal',
      crm_round_robin_queue_status: 'rounds',
      mkt_list_audiences: 'audiences',
      mkt_growth_roas_attribution: 'revenue_attribution',
      hrm_pending_approvals_inbox: 'approvals',
      ops_overdue_project_tasks: 'projects',
      ops_cashflow_pnl_summary: 'finance',
    };
    const mKey = checkModMap[tName];
    if (!hasModuleEntitlement(resolvedRbac.enabledModules, mKey)) continue;
    const perm = resolvedRbac.effectivePermissions[mKey];
    const reqAct = tName === 'ops_cashflow_pnl_summary' ? 'view_financials' : 'view';
    if (!perm || perm.scope === 'none' || !perm.actions[reqAct]) continue;

    const res = await executeDomAgentToolInTx(client, tenantCtx, tName, { limit: 5 });
    if (res.allowed && res.output) {
      cards.push({
        tool_name: res.tool_name,
        title: res.tool_title || res.tool_name,
        module_key: res.module_key,
        scope: res.effective_scope,
        metrics: res.output,
      });

      if (tName === 'crm_sla_breaches' && Number(res.output.breach_count || 0) > 0) {
        actionItems.push(
          `Cần xử lý ngay ${String(res.output.breach_count)} hồ sơ ${entSnap.terminology.customer_singular} đang chạm/quá ngưỡng SLA.`
        );
      }
      if (tName === 'crm_hot_lead_radar' && Array.isArray(res.output.hot_leads) && res.output.hot_leads.length > 0) {
        actionItems.push(
          `Có ${res.output.hot_leads.length} ${entSnap.terminology.customer_singular} điểm nóng cao (>=50) sẵn sàng ưu tiên chốt đơn.`
        );
      }
      if (tName === 'hrm_pending_approvals_inbox' && Number(res.output.pending_count || 0) > 0) {
        actionItems.push(
          `Hộp thư Phê duyệt có ${String(res.output.pending_count)} phiếu đề xuất đang chờ quyết định.`
        );
      }
      if (tName === 'ops_overdue_project_tasks' && Number(res.output.overdue_count || 0) > 0) {
        actionItems.push(
          `Phát hiện ${String(res.output.overdue_count)} đầu việc quá hạn cần rà soát tiến độ.`
        );
      }
    }
  }

  const ragCountRes = await client.query<{ cnt: number }>(
    'SELECT COUNT(*)::int AS cnt FROM tenant_ai_knowledge_docs WHERE tenant_id = $1 AND is_active = true',
    [tenantCtx.tenantId]
  );
  const activeKnowledgeDocs = Number(ragCountRes.rows[0]?.cnt || 0);
  if (activeKnowledgeDocs === 0) {
    actionItems.push(
      'Kho Tri thức Nội bộ (RAG) chưa có văn bản nào — hãy bấm "Đồng bộ Văn bản Nội quy" ở tab RAG Knowledge Studio.'
    );
  }

  if (actionItems.length === 0) {
    actionItems.push(
      `Toàn bộ chỉ số vận hành thuộc phạm vi của bạn trên gói ${entSnap.package_info.short_name} đang ổn định, không có cảnh báo quá hạn.`
    );
  }

  return {
    generated_at: new Date().toISOString(),
    agent_name: agentConfig.agent_name,
    avatar_url: agentConfig.avatar_url,
    tenant_name: tRow.name,
    package_code: entSnap.package_code,
    package_name: entSnap.package_info.name,
    industry_label: entSnap.terminology.industry_label,
    active_knowledge_docs: activeKnowledgeDocs,
    sections: cards,
    priority_actions: actionItems,
  };
}
