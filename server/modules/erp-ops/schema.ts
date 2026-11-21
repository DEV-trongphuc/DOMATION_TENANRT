import crypto from 'node:crypto';
import { getDatabasePool, type DbClient } from '../../core/database/db-adapter.ts';
import { withTenantTransaction } from '../../core/database/transaction.ts';
import { getTenantSettingsCached } from '../../core/settings/tenant-cache.ts';
import { resolveUserEffectivePermissions, type ResolvedUserRbacResult } from '../../core/security/rbac.ts';
import { onDomainEvent } from '../../core/events/event-bus.ts';

export const ERP_OPS_TABLES = [
  'tenant_projects',
  'tenant_tasks',
  'tenant_pomodoro_sessions',
  'tenant_workflow_task_templates',
  'tenant_helpdesk_tickets',
  'tenant_helpdesk_comments',
  'tenant_workchat_channels',
  'tenant_workchat_members',
  'tenant_workchat_messages',
  'tenant_workchat_presence',
  'tenant_feed_posts',
  'tenant_feed_comments',
  'tenant_kudos_recognitions',
  'tenant_b2b_companies',
  'tenant_deals',
  'tenant_quotes',
  'tenant_sales_orders',
  'tenant_deposits',
  'tenant_purchase_orders',
  'tenant_finance_transactions',
  'tenant_products',
  'tenant_suppliers',
  'tenant_warehouses',
  'tenant_inventory_batches',
  'tenant_stock_movements',
  'tenant_fixed_assets',
  'tenant_cloud_folders',
  'tenant_cloud_files',
  'tenant_ocr_extractions',
  'tenant_edu_courses',
  'tenant_edu_classes',
  'tenant_edu_schedules',
  'tenant_edu_enrollments',
  'tenant_edu_attendance_grades',
  // Stage 4B Full-Clone Commercial Finance, Supply Chain, Projects/Gantt, Cloud & Education Tables
  'tenant_quote_items',
  'tenant_sales_order_items',
  'tenant_purchase_order_items',
  'tenant_invoices',
  'tenant_invoice_items',
  'tenant_deposit_milestones',
  'tenant_expenses',
  'tenant_pos_sessions',
  'tenant_pos_orders',
  'tenant_inventory_sync_sheets',
  'tenant_project_roster',
  'tenant_task_dependencies',
  'tenant_task_comments',
  'tenant_task_attachments',
  'tenant_task_whiteboard_snapshots',
  'tenant_cloud_file_categories',
  'tenant_edu_announcements',
] as const;

const initializedPools = new WeakSet<object>();
const inFlightInitByPool = new WeakMap<object, Promise<void>>();
let stageTaskSubscriberRegistered = false;

export function parseJsonSafe<T>(raw: unknown, fallback: T): T {
  if (raw === null || raw === undefined) return fallback;
  if (typeof raw === 'string') {
    const trimmed = raw.trim();
    if (!trimmed) return fallback;
    try {
      return JSON.parse(trimmed) as T;
    } catch {
      return fallback;
    }
  }
  if (typeof raw === 'object') {
    return raw as T;
  }
  return fallback;
}

export function clampLimit(raw: unknown, defaultVal = 50, maxVal = 200): number {
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return defaultVal;
  return Math.min(maxVal, Math.max(1, Math.floor(n)));
}

export interface BranchLegalEntitySnapshot {
  branch_id: string | null;
  branch_code: string | null;
  branch_name: string;
  legal_entity_name: string;
  tax_code: string;
  representative_name: string;
  representative_title: string;
  address: string;
  phone: string;
  email: string;
  bank_name: string;
  bank_bin: string;
  bank_account_no: string;
  bank_account_holder: string;
}

export async function resolvePrimaryBranchLegalInfo(
  client: DbClient,
  tenantId: string,
  branchId?: string | null
): Promise<BranchLegalEntitySnapshot> {
  const [tenantRes, branchRes] = await Promise.all([
    client.query<{ name: string; settings: unknown }>(
      'SELECT name, settings FROM tenants WHERE id = $1 LIMIT 1',
      [tenantId]
    ),
    branchId
      ? client.query(
          `SELECT * FROM tenant_branches
           WHERE tenant_id = $1 AND id = $2
           LIMIT 1`,
          [tenantId, branchId]
        )
      : client.query(
          `SELECT * FROM tenant_branches
           WHERE tenant_id = $1 AND is_active = true
           ORDER BY is_headquarters DESC, created_at ASC
           LIMIT 1`,
          [tenantId]
        ),
  ]);

  const tenantRow = tenantRes.rows[0];
  const settingsObj = parseJsonSafe<Record<string, unknown>>(tenantRow?.settings, {});
  const bankCfg = parseJsonSafe<Record<string, unknown>>(settingsObj.bank_account, {});
  const br = branchRes.rows[0] as Record<string, unknown> | undefined;
  const brSchedule = parseJsonSafe<Record<string, unknown>>(br?.work_schedule, {});
  const brBank = parseJsonSafe<Record<string, unknown>>(brSchedule.bank_account, {});

  const companyName = String(tenantRow?.name || 'Doanh nghiệp').trim();
  const legalName = String(
    br?.legal_entity_name || settingsObj.legal_entity_name || companyName
  ).trim();

  return {
    branch_id: br?.id ? String(br.id) : null,
    branch_code: br?.code ? String(br.code) : null,
    branch_name: String(br?.name || companyName),
    legal_entity_name: legalName,
    tax_code: String(br?.tax_code || settingsObj.tax_code || ''),
    representative_name: String(br?.representative_name || settingsObj.representative_name || ''),
    representative_title: String(br?.representative_title || settingsObj.representative_title || 'Giám đốc'),
    address: String(br?.address || settingsObj.company_address || ''),
    phone: String(br?.phone || settingsObj.company_phone || ''),
    email: String(br?.email || settingsObj.company_email || ''),
    bank_name: String(brBank.bank_name || bankCfg.bank_name || settingsObj.bank_name || 'Vietcombank'),
    bank_bin: String(brBank.bank_bin || bankCfg.bank_bin || settingsObj.bank_bin || '970436'),
    bank_account_no: String(brBank.account_no || bankCfg.account_no || settingsObj.bank_account_no || ''),
    bank_account_holder: String(
      brBank.account_holder || bankCfg.account_holder || settingsObj.bank_account_holder || legalName.toUpperCase()
    ),
  };
}

export async function resolveActorContext(
  client: DbClient,
  tenantId: string,
  userId: string
): Promise<{
  rbac: ResolvedUserRbacResult;
  canUnmaskLeads: boolean;
  tenantSettings: Awaited<ReturnType<typeof getTenantSettingsCached>>;
}> {
  const [rbac, tenantSettings] = await Promise.all([
    resolveUserEffectivePermissions(client, tenantId, userId),
    getTenantSettingsCached(tenantId, client),
  ]);
  const canUnmaskLeads = Boolean(rbac.effectivePermissions.leads?.actions.unmask_phone);
  return { rbac, canUnmaskLeads, tenantSettings };
}

export interface FifoBatchAllocation {
  batch_id: string;
  batch_code: string;
  warehouse_id: string | null;
  deducted_qty: number;
  unit_cost_vnd: number;
  line_cogs_vnd: number;
  remaining_after: number;
}

export interface FifoDeductionOutcome {
  product_id: string;
  deducted_qty: number;
  total_cogs_vnd: number;
  allocations: FifoBatchAllocation[];
}

/**
 * True Oldest-Batch-First FIFO Stock Deduction Engine
 * Deducts `quantity` across active `tenant_inventory_batches` ordered by `received_at ASC, created_at ASC`,
 * computes exact multi-batch Cost of Goods Sold (`total_cogs_vnd`), updates cached stock, and writes audit movements.
 */
export async function deductFifoInventoryInTx(
  client: DbClient,
  params: {
    tenantId: string;
    productId: string;
    warehouseId?: string | null;
    quantity: number;
    referenceType: 'sales_order' | 'pos' | 'manual_out';
    referenceId?: string | null;
    actorId?: string | null;
    reason?: string;
  }
): Promise<FifoDeductionOutcome> {
  const qtyNeeded = Math.round(Number(params.quantity || 0));
  if (qtyNeeded <= 0) {
    throw new Error('INVALID_FIFO_QUANTITY: Số lượng xuất kho phải lớn hơn 0.');
  }

  const whereWarehouse = params.warehouseId ? 'AND warehouse_id = $3' : '';
  const queryParams: unknown[] = params.warehouseId
    ? [params.tenantId, params.productId, params.warehouseId]
    : [params.tenantId, params.productId];

  const batchesRes = await client.query<{
    id: string;
    batch_code: string;
    warehouse_id: string | null;
    remaining_qty: number;
    unit_cost_vnd: string | number;
  }>(
    `SELECT id, batch_code, warehouse_id, remaining_qty, unit_cost_vnd
     FROM tenant_inventory_batches
     WHERE tenant_id = $1
       AND product_id = $2
       ${whereWarehouse}
       AND status = 'active'
       AND remaining_qty > 0
     ORDER BY received_at ASC, created_at ASC, id ASC`,
    queryParams
  );

  const availableTotal = batchesRes.rows.reduce((acc, b) => acc + Number(b.remaining_qty || 0), 0);
  if (availableTotal < qtyNeeded) {
    throw new Error(
      `INSUFFICIENT_FIFO_STOCK: Tồn kho khả dụng (${availableTotal}) không đủ để xuất (${qtyNeeded}).`
    );
  }

  let remainingToDeduct = qtyNeeded;
  let totalCogsVnd = 0;
  const allocations: FifoBatchAllocation[] = [];

  for (const batch of batchesRes.rows) {
    if (remainingToDeduct <= 0) break;
    const batchAvail = Number(batch.remaining_qty || 0);
    if (batchAvail <= 0) continue;

    const takeQty = Math.min(batchAvail, remainingToDeduct);
    const nextRemaining = batchAvail - takeQty;
    const unitCost = Math.round(Number(batch.unit_cost_vnd || 0));
    const lineCogs = takeQty * unitCost;

    await client.query(
      `UPDATE tenant_inventory_batches
       SET remaining_qty = $3::int,
           status = CASE WHEN $3::int <= 0 THEN 'depleted' ELSE status END,
           updated_at = clock_timestamp()
       WHERE tenant_id = $1 AND id = $2`,
      [params.tenantId, batch.id, nextRemaining]
    );

    const movId = crypto.randomUUID();
    const movType = params.referenceType === 'pos' ? 'OUT_POS' : params.referenceType === 'sales_order' ? 'OUT_SO' : 'OUT_MANUAL';
    await client.query(
      `INSERT INTO tenant_stock_movements (
         id, tenant_id, product_id, batch_id, warehouse_id, movement_type,
         qty_delta, unit_cost_vnd, total_cost_vnd, reference_type, reference_id, note, created_by
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)`,
      [
        movId,
        params.tenantId,
        params.productId,
        batch.id,
        batch.warehouse_id || null,
        movType,
        -takeQty,
        unitCost,
        lineCogs,
        params.referenceType,
        params.referenceId || null,
        params.reason || `Xuất kho FIFO (${movType})`,
        params.actorId || null,
      ]
    );

    remainingToDeduct -= takeQty;
    totalCogsVnd += lineCogs;
    allocations.push({
      batch_id: batch.id,
      batch_code: batch.batch_code,
      warehouse_id: batch.warehouse_id || null,
      deducted_qty: takeQty,
      unit_cost_vnd: unitCost,
      line_cogs_vnd: lineCogs,
      remaining_after: nextRemaining,
    });
  }

  // Recompute cached_stock_qty on tenant_products from active batches
  const sumRes = await client.query<{ total_qty: string | number }>(
    `SELECT COALESCE(SUM(remaining_qty), 0) AS total_qty
     FROM tenant_inventory_batches
     WHERE tenant_id = $1 AND product_id = $2 AND status = 'active'`,
    [params.tenantId, params.productId]
  );
  const newStockQty = Math.max(0, Number(sumRes.rows[0]?.total_qty || 0));
  await client.query(
    `UPDATE tenant_products
     SET cached_stock_qty = $3,
         updated_at = clock_timestamp()
     WHERE tenant_id = $1 AND id = $2`,
    [params.tenantId, params.productId, newStockQty]
  );

  return {
    product_id: params.productId,
    deducted_qty: qtyNeeded,
    total_cogs_vnd: totalCogsVnd,
    allocations,
  };
}

/**
 * Updates `leads.total_revenue_vnd`, marks `lifecycle_stage = 'customer'`, updates linked `tenant_deals`,
 * and appends an immutable `lead_timeline_events` entry inside the current tenant transaction.
 */
export async function recordRevenueAttributionOnOrderPaidInTx(
  client: DbClient,
  params: {
    tenantId: string;
    orderId: string;
    orderCode: string;
    leadId?: string | null;
    dealId?: string | null;
    amountDeltaVnd: number;
    actorId?: string | null;
    actorRole?: string;
    actorName?: string;
    sourceLabel?: string;
  }
): Promise<void> {
  const delta = Math.round(Number(params.amountDeltaVnd || 0));
  if (delta <= 0) return;

  if (params.dealId) {
    await client.query(
      `UPDATE tenant_deals
       SET stage = 'won',
           probability = 100,
           actual_close_date = COALESCE(actual_close_date, CURRENT_DATE),
           updated_at = clock_timestamp()
       WHERE tenant_id = $1 AND id = $2`,
      [params.tenantId, params.dealId]
    );
  }

  if (params.leadId) {
    const leadCheck = await client.query<{ id: string }>(
      'SELECT id FROM leads WHERE tenant_id = $1 AND id = $2 LIMIT 1',
      [params.tenantId, params.leadId]
    );
    if (leadCheck.rows[0]) {
      await client.query(
        `UPDATE leads
         SET total_revenue_vnd = total_revenue_vnd + $3,
             lifecycle_stage = 'customer',
             quality_status = 'Won',
             last_engaged_at = clock_timestamp(),
             updated_at = clock_timestamp()
         WHERE tenant_id = $1 AND id = $2`,
        [params.tenantId, params.leadId, delta]
      );

      await client.query(
        `INSERT INTO lead_timeline_events (
           id, tenant_id, lead_id, event_type, event_category,
           actor_id, actor_role, actor_name, title, content, metadata
         ) VALUES ($1, $2, $3, 'order_completed', 'system', $4, $5, $6, $7, $8, $9::jsonb)`,
        [
          crypto.randomUUID(),
          params.tenantId,
          params.leadId,
          params.actorId || null,
          params.actorRole || 'tenant_admin',
          params.actorName || 'Finance Engine',
          `Hoàn tất thanh toán ${params.sourceLabel || 'Đơn hàng'} ${params.orderCode} (+${delta.toLocaleString('vi-VN')}₫)`,
          `Doanh thu thực thu đã được ghi nhận vào Hồ sơ Khách hàng 360° & Báo cáo Phân bổ Doanh thu.`,
          JSON.stringify({
            order_id: params.orderId,
            order_code: params.orderCode,
            deal_id: params.dealId || null,
            amount_vnd: delta,
          }),
        ]
      );
    }
  }
}

function registerStageTaskAutomationSubscriberOnce(): void {
  if (stageTaskSubscriberRegistered) return;
  stageTaskSubscriberRegistered = true;

  onDomainEvent('lead.stage_changed', async (envelope) => {
    const { tenantId, leadId, pipelineId, currentStageId, currentStageKey, actorId } = envelope.payload;
    if (!tenantId || !leadId || !currentStageId) return;

    await ensureErpOpsSchema();

    await withTenantTransaction(tenantId, async (client) => {
      const leadRes = await client.query<{
        id: string;
        name: string;
        assigned_to: string | null;
      }>('SELECT id, name, assigned_to FROM leads WHERE tenant_id = $1 AND id = $2 LIMIT 1', [
        tenantId,
        leadId,
      ]);
      const lead = leadRes.rows[0];
      if (!lead) return;

      const tplRes = await client.query<{
        id: string;
        title_template: string;
        description_template: string | null;
        priority: string;
        due_offset_hours: number;
        project_id: string | null;
        default_assignee_id: string | null;
        checklist_json: unknown;
      }>(
        `SELECT id, title_template, description_template, priority, due_offset_hours,
                project_id, default_assignee_id, checklist_json
         FROM tenant_workflow_task_templates
         WHERE tenant_id = $1
           AND is_active = true
           AND (pipeline_id IS NULL OR pipeline_id = $2::uuid)
           AND (stage_id = $3::uuid OR ($4::text <> '' AND LOWER(COALESCE(stage_key, '')) = LOWER($4::text)))
         ORDER BY sort_order ASC, created_at ASC`,
        [tenantId, pipelineId || null, currentStageId, String(currentStageKey || '')]
      );

      for (const tpl of tplRes.rows) {
        // Idempotency guard per (tenant_id, lead_id, source_template_id, trigger_stage_id)
        const dupCheck = await client.query<{ id: string }>(
          `SELECT id FROM tenant_tasks
           WHERE tenant_id = $1
             AND lead_id = $2
             AND source_template_id = $3
             AND trigger_stage_id = $4
           LIMIT 1`,
          [tenantId, leadId, tpl.id, currentStageId]
        );
        if (dupCheck.rows[0]) continue;

        const renderedTitle = String(tpl.title_template || 'Công việc tự động')
          .replace(/\{\{\s*lead\.name\s*\}\}/gi, lead.name)
          .replace(/\{\{\s*customer_name\s*\}\}/gi, lead.name);
        const renderedDesc = tpl.description_template
          ? String(tpl.description_template)
              .replace(/\{\{\s*lead\.name\s*\}\}/gi, lead.name)
              .replace(/\{\{\s*customer_name\s*\}\}/gi, lead.name)
          : null;

        const offsetHours = Math.max(1, Number(tpl.due_offset_hours || 24));
        const dueDateIso = new Date(Date.now() + offsetHours * 3600_000).toISOString();
        const assigneeId = lead.assigned_to || tpl.default_assignee_id || actorId || null;
        const checklist = parseJsonSafe<unknown[]>(tpl.checklist_json, []);

        await client.query(
          `INSERT INTO tenant_tasks (
             id, tenant_id, project_id, lead_id, title, description, status_key, priority,
             assignee_user_id, reporter_user_id, due_date, checklist_json,
             source_template_id, trigger_stage_id
           ) VALUES ($1, $2, $3, $4, $5, $6, 'todo', $7, $8, $9, $10, $11::jsonb, $12, $13)`,
          [
            crypto.randomUUID(),
            tenantId,
            tpl.project_id || null,
            leadId,
            renderedTitle,
            renderedDesc,
            tpl.priority || 'medium',
            assigneeId,
            actorId || null,
            dueDateIso,
            JSON.stringify(checklist),
            tpl.id,
            currentStageId,
          ]
        );
      }
    });
  });
}

// Register immediately at module load so event-bus automation is always active once imported
registerStageTaskAutomationSubscriberOnce();

export async function ensureErpOpsSchema(): Promise<void> {
  registerStageTaskAutomationSubscriberOnce();
  const pool = getDatabasePool();
  if (initializedPools.has(pool)) {
    return;
  }

  const existingPromise = inFlightInitByPool.get(pool);
  if (existingPromise) {
    await existingPromise;
    return;
  }

  const initPromise = (async () => {
    const client = await pool.connect();
    try {
      const isMariaDb = client.dialect === 'mariadb' || pool.dialect === 'mariadb';
      if (isMariaDb) {
        await runErpOpsMariaDbSchema(client);
      } else {
        await runErpOpsPostgresSchema(client);
      }
      initializedPools.add(pool);
    } finally {
      client.release();
      inFlightInitByPool.delete(pool);
    }
  })();

  inFlightInitByPool.set(pool, initPromise);
  await initPromise;
}

async function runErpOpsPostgresSchema(client: DbClient): Promise<void> {
  const pgDdl = `
    -- ========================================================================
    -- GROUP 1: PROJECTS, KANBAN/GANTT/WHITEBOARD/POMODORO & HELPDESK SLA
    -- ========================================================================
    CREATE TABLE IF NOT EXISTS tenant_projects (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
      code VARCHAR(50) NOT NULL,
      name VARCHAR(200) NOT NULL,
      description TEXT,
      status VARCHAR(30) NOT NULL DEFAULT 'active' CHECK (status IN ('planning', 'active', 'on_hold', 'completed', 'archived')),
      priority VARCHAR(20) NOT NULL DEFAULT 'medium' CHECK (priority IN ('low', 'medium', 'high', 'urgent')),
      owner_user_id UUID,
      department_id UUID,
      branch_id UUID,
      start_date DATE,
      due_date DATE,
      budget_vnd BIGINT NOT NULL DEFAULT 0,
      progress_pct INTEGER NOT NULL DEFAULT 0,
      task_columns_json JSONB NOT NULL DEFAULT '[{"key":"todo","label":"Cần làm","color":"#64748B"},{"key":"in_progress","label":"Đang thực hiện","color":"#1E40FF"},{"key":"review","label":"Chờ duyệt","color":"#D97706"},{"key":"done","label":"Hoàn thành","color":"#10B981","is_done":true}]'::jsonb,
      whiteboard_json JSONB NOT NULL DEFAULT '[]'::jsonb,
      metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
      created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
      CONSTRAINT uk_tenant_projects_tenant_id UNIQUE (tenant_id, id),
      CONSTRAINT uk_tenant_projects_code UNIQUE (tenant_id, code),
      CONSTRAINT fk_proj_owner FOREIGN KEY (tenant_id, owner_user_id) REFERENCES users(tenant_id, id) ON DELETE SET NULL,
      CONSTRAINT fk_proj_dept FOREIGN KEY (tenant_id, department_id) REFERENCES tenant_departments(tenant_id, id) ON DELETE SET NULL,
      CONSTRAINT fk_proj_branch FOREIGN KEY (tenant_id, branch_id) REFERENCES tenant_branches(tenant_id, id) ON DELETE SET NULL
    );
    CREATE INDEX IF NOT EXISTS idx_tenant_projects_status ON tenant_projects(tenant_id, status, created_at DESC);

    CREATE TABLE IF NOT EXISTS tenant_workflow_task_templates (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
      pipeline_id UUID,
      stage_id UUID,
      stage_key VARCHAR(64),
      project_id UUID,
      title_template VARCHAR(255) NOT NULL,
      description_template TEXT,
      priority VARCHAR(20) NOT NULL DEFAULT 'medium' CHECK (priority IN ('low', 'medium', 'high', 'urgent')),
      due_offset_hours INTEGER NOT NULL DEFAULT 24,
      default_assignee_id UUID,
      checklist_json JSONB NOT NULL DEFAULT '[]'::jsonb,
      sort_order INTEGER NOT NULL DEFAULT 0,
      is_active BOOLEAN NOT NULL DEFAULT true,
      created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
      CONSTRAINT uk_tenant_workflow_task_templates_tenant_id UNIQUE (tenant_id, id),
      CONSTRAINT fk_wtt_pipeline FOREIGN KEY (tenant_id, pipeline_id) REFERENCES tenant_pipelines(tenant_id, id) ON DELETE CASCADE,
      CONSTRAINT fk_wtt_stage FOREIGN KEY (tenant_id, stage_id) REFERENCES tenant_pipeline_stages(tenant_id, id) ON DELETE CASCADE,
      CONSTRAINT fk_wtt_project FOREIGN KEY (tenant_id, project_id) REFERENCES tenant_projects(tenant_id, id) ON DELETE SET NULL,
      CONSTRAINT fk_wtt_assignee FOREIGN KEY (tenant_id, default_assignee_id) REFERENCES users(tenant_id, id) ON DELETE SET NULL
    );
    CREATE INDEX IF NOT EXISTS idx_wtt_lookup ON tenant_workflow_task_templates(tenant_id, is_active, stage_id);

    CREATE TABLE IF NOT EXISTS tenant_tasks (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
      project_id UUID,
      lead_id UUID,
      title VARCHAR(255) NOT NULL,
      description TEXT,
      status_key VARCHAR(50) NOT NULL DEFAULT 'todo',
      priority VARCHAR(20) NOT NULL DEFAULT 'medium' CHECK (priority IN ('low', 'medium', 'high', 'urgent')),
      assignee_user_id UUID,
      reporter_user_id UUID,
      start_date TIMESTAMPTZ,
      due_date TIMESTAMPTZ,
      estimated_minutes INTEGER NOT NULL DEFAULT 60,
      logged_minutes INTEGER NOT NULL DEFAULT 0,
      progress_pct INTEGER NOT NULL DEFAULT 0,
      sort_order INTEGER NOT NULL DEFAULT 0,
      checklist_json JSONB NOT NULL DEFAULT '[]'::jsonb,
      dependencies_json JSONB NOT NULL DEFAULT '[]'::jsonb,
      source_template_id UUID,
      trigger_stage_id UUID,
      completed_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
      CONSTRAINT uk_tenant_tasks_tenant_id UNIQUE (tenant_id, id),
      CONSTRAINT fk_task_project FOREIGN KEY (tenant_id, project_id) REFERENCES tenant_projects(tenant_id, id) ON DELETE CASCADE,
      CONSTRAINT fk_task_lead FOREIGN KEY (tenant_id, lead_id) REFERENCES leads(tenant_id, id) ON DELETE SET NULL,
      CONSTRAINT fk_task_assignee FOREIGN KEY (tenant_id, assignee_user_id) REFERENCES users(tenant_id, id) ON DELETE SET NULL,
      CONSTRAINT fk_task_reporter FOREIGN KEY (tenant_id, reporter_user_id) REFERENCES users(tenant_id, id) ON DELETE SET NULL,
      CONSTRAINT fk_task_tpl FOREIGN KEY (tenant_id, source_template_id) REFERENCES tenant_workflow_task_templates(tenant_id, id) ON DELETE SET NULL
    );
    CREATE INDEX IF NOT EXISTS idx_tenant_tasks_proj_status ON tenant_tasks(tenant_id, project_id, status_key, sort_order ASC);
    CREATE INDEX IF NOT EXISTS idx_tenant_tasks_lead ON tenant_tasks(tenant_id, lead_id);
    CREATE INDEX IF NOT EXISTS idx_tenant_tasks_assignee_status ON tenant_tasks(tenant_id, assignee_user_id, status_key, due_date ASC);

    CREATE TABLE IF NOT EXISTS tenant_pomodoro_sessions (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
      task_id UUID,
      user_id UUID NOT NULL,
      duration_minutes INTEGER NOT NULL DEFAULT 25,
      mode VARCHAR(20) NOT NULL DEFAULT 'focus' CHECK (mode IN ('focus', 'short_break', 'long_break')),
      note TEXT,
      started_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
      completed_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
      created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
      CONSTRAINT uk_tenant_pomodoro_sessions_tenant_id UNIQUE (tenant_id, id),
      CONSTRAINT fk_pomo_task FOREIGN KEY (tenant_id, task_id) REFERENCES tenant_tasks(tenant_id, id) ON DELETE SET NULL,
      CONSTRAINT fk_pomo_user FOREIGN KEY (tenant_id, user_id) REFERENCES users(tenant_id, id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_pomodoro_user ON tenant_pomodoro_sessions(tenant_id, user_id, created_at DESC);

    CREATE TABLE IF NOT EXISTS tenant_helpdesk_tickets (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
      ticket_code VARCHAR(40) NOT NULL,
      subject VARCHAR(255) NOT NULL,
      description TEXT,
      category VARCHAR(60) NOT NULL DEFAULT 'customer_support',
      priority VARCHAR(20) NOT NULL DEFAULT 'medium' CHECK (priority IN ('low', 'medium', 'high', 'urgent')),
      status VARCHAR(30) NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'in_progress', 'waiting_customer', 'resolved', 'closed')),
      lead_id UUID,
      customer_name VARCHAR(150),
      customer_contact VARCHAR(150),
      assignee_user_id UUID,
      created_by_user_id UUID,
      sla_response_hours NUMERIC(8,2) NOT NULL DEFAULT 2,
      sla_resolution_hours NUMERIC(8,2) NOT NULL DEFAULT 24,
      response_due_at TIMESTAMPTZ NOT NULL,
      resolution_due_at TIMESTAMPTZ NOT NULL,
      first_responded_at TIMESTAMPTZ,
      resolved_at TIMESTAMPTZ,
      sla_breached BOOLEAN NOT NULL DEFAULT false,
      attachments_json JSONB NOT NULL DEFAULT '[]'::jsonb,
      created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
      CONSTRAINT uk_tenant_helpdesk_tickets_tenant_id UNIQUE (tenant_id, id),
      CONSTRAINT uk_tenant_helpdesk_code UNIQUE (tenant_id, ticket_code),
      CONSTRAINT fk_hd_lead FOREIGN KEY (tenant_id, lead_id) REFERENCES leads(tenant_id, id) ON DELETE SET NULL,
      CONSTRAINT fk_hd_assignee FOREIGN KEY (tenant_id, assignee_user_id) REFERENCES users(tenant_id, id) ON DELETE SET NULL,
      CONSTRAINT fk_hd_creator FOREIGN KEY (tenant_id, created_by_user_id) REFERENCES users(tenant_id, id) ON DELETE SET NULL
    );
    CREATE INDEX IF NOT EXISTS idx_helpdesk_status_due ON tenant_helpdesk_tickets(tenant_id, status, resolution_due_at ASC);
    CREATE INDEX IF NOT EXISTS idx_helpdesk_lead ON tenant_helpdesk_tickets(tenant_id, lead_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_helpdesk_assignee_status ON tenant_helpdesk_tickets(tenant_id, assignee_user_id, status);

    CREATE TABLE IF NOT EXISTS tenant_helpdesk_comments (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
      ticket_id UUID NOT NULL,
      author_user_id UUID,
      author_name VARCHAR(150) NOT NULL,
      content TEXT NOT NULL,
      is_internal_note BOOLEAN NOT NULL DEFAULT false,
      created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
      CONSTRAINT uk_tenant_helpdesk_comments_tenant_id UNIQUE (tenant_id, id),
      CONSTRAINT fk_hdc_ticket FOREIGN KEY (tenant_id, ticket_id) REFERENCES tenant_helpdesk_tickets(tenant_id, id) ON DELETE CASCADE,
      CONSTRAINT fk_hdc_author FOREIGN KEY (tenant_id, author_user_id) REFERENCES users(tenant_id, id) ON DELETE SET NULL
    );
    CREATE INDEX IF NOT EXISTS idx_helpdesk_comments_ticket ON tenant_helpdesk_comments(tenant_id, ticket_id, created_at ASC);

    -- ========================================================================
    -- GROUP 2: WORKCHAT, PRESENCE, INTERNAL FEED & KUDOS WALL
    -- ========================================================================
    CREATE TABLE IF NOT EXISTS tenant_workchat_channels (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
      name VARCHAR(150) NOT NULL,
      channel_type VARCHAR(30) NOT NULL DEFAULT 'group' CHECK (channel_type IN ('direct', 'department', 'project', 'group', 'announcement')),
      topic TEXT,
      department_id UUID,
      project_id UUID,
      created_by UUID,
      is_archived BOOLEAN NOT NULL DEFAULT false,
      last_message_at TIMESTAMPTZ DEFAULT clock_timestamp(),
      last_message_preview VARCHAR(255),
      created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
      CONSTRAINT uk_tenant_workchat_channels_tenant_id UNIQUE (tenant_id, id),
      CONSTRAINT fk_wcc_dept FOREIGN KEY (tenant_id, department_id) REFERENCES tenant_departments(tenant_id, id) ON DELETE SET NULL,
      CONSTRAINT fk_wcc_proj FOREIGN KEY (tenant_id, project_id) REFERENCES tenant_projects(tenant_id, id) ON DELETE SET NULL,
      CONSTRAINT fk_wcc_creator FOREIGN KEY (tenant_id, created_by) REFERENCES users(tenant_id, id) ON DELETE SET NULL
    );
    CREATE INDEX IF NOT EXISTS idx_workchat_channels_last ON tenant_workchat_channels(tenant_id, is_archived, last_message_at DESC);

    CREATE TABLE IF NOT EXISTS tenant_workchat_members (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
      channel_id UUID NOT NULL,
      user_id UUID NOT NULL,
      member_role VARCHAR(20) NOT NULL DEFAULT 'member' CHECK (member_role IN ('owner', 'admin', 'member')),
      last_read_at TIMESTAMPTZ DEFAULT clock_timestamp(),
      joined_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
      CONSTRAINT uk_tenant_workchat_members_tenant_id UNIQUE (tenant_id, id),
      CONSTRAINT uk_workchat_channel_member UNIQUE (tenant_id, channel_id, user_id),
      CONSTRAINT fk_wcm_channel FOREIGN KEY (tenant_id, channel_id) REFERENCES tenant_workchat_channels(tenant_id, id) ON DELETE CASCADE,
      CONSTRAINT fk_wcm_user FOREIGN KEY (tenant_id, user_id) REFERENCES users(tenant_id, id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_workchat_members_user ON tenant_workchat_members(tenant_id, user_id);

    CREATE TABLE IF NOT EXISTS tenant_workchat_messages (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
      channel_id UUID NOT NULL,
      sender_user_id UUID,
      sender_name VARCHAR(150) NOT NULL,
      parent_message_id UUID,
      message_type VARCHAR(30) NOT NULL DEFAULT 'text' CHECK (message_type IN ('text', 'sticker', 'work_badge', 'attachment', 'card_link')),
      content TEXT NOT NULL DEFAULT '',
      sticker_pack_id VARCHAR(50),
      sticker_id VARCHAR(100),
      attachments_json JSONB NOT NULL DEFAULT '[]'::jsonb,
      reactions_json JSONB NOT NULL DEFAULT '{}'::jsonb,
      is_pinned BOOLEAN NOT NULL DEFAULT false,
      is_deleted BOOLEAN NOT NULL DEFAULT false,
      created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
      CONSTRAINT uk_tenant_workchat_messages_tenant_id UNIQUE (tenant_id, id),
      CONSTRAINT fk_wcmsg_channel FOREIGN KEY (tenant_id, channel_id) REFERENCES tenant_workchat_channels(tenant_id, id) ON DELETE CASCADE,
      CONSTRAINT fk_wcmsg_sender FOREIGN KEY (tenant_id, sender_user_id) REFERENCES users(tenant_id, id) ON DELETE SET NULL,
      CONSTRAINT fk_wcmsg_parent FOREIGN KEY (tenant_id, parent_message_id) REFERENCES tenant_workchat_messages(tenant_id, id) ON DELETE SET NULL
    );
    CREATE INDEX IF NOT EXISTS idx_workchat_msgs_channel ON tenant_workchat_messages(tenant_id, channel_id, created_at ASC);

    CREATE TABLE IF NOT EXISTS tenant_workchat_presence (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
      user_id UUID NOT NULL,
      status VARCHAR(20) NOT NULL DEFAULT 'online' CHECK (status IN ('online', 'busy', 'away', 'offline')),
      status_text VARCHAR(120),
      last_seen_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
      CONSTRAINT uk_tenant_workchat_presence_tenant_id UNIQUE (tenant_id, id),
      CONSTRAINT uk_workchat_presence_user UNIQUE (tenant_id, user_id),
      CONSTRAINT fk_wcp_user FOREIGN KEY (tenant_id, user_id) REFERENCES users(tenant_id, id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS tenant_feed_posts (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
      author_user_id UUID,
      author_name VARCHAR(150) NOT NULL,
      title VARCHAR(255),
      content TEXT NOT NULL,
      post_type VARCHAR(30) NOT NULL DEFAULT 'announcement' CHECK (post_type IN ('announcement', 'update', 'policy', 'celebration')),
      branch_id UUID,
      department_id UUID,
      is_pinned BOOLEAN NOT NULL DEFAULT false,
      attachments_json JSONB NOT NULL DEFAULT '[]'::jsonb,
      reactions_json JSONB NOT NULL DEFAULT '{}'::jsonb,
      likes_count INTEGER NOT NULL DEFAULT 0,
      comments_count INTEGER NOT NULL DEFAULT 0,
      created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
      CONSTRAINT uk_tenant_feed_posts_tenant_id UNIQUE (tenant_id, id),
      CONSTRAINT fk_fp_author FOREIGN KEY (tenant_id, author_user_id) REFERENCES users(tenant_id, id) ON DELETE SET NULL,
      CONSTRAINT fk_fp_branch FOREIGN KEY (tenant_id, branch_id) REFERENCES tenant_branches(tenant_id, id) ON DELETE SET NULL,
      CONSTRAINT fk_fp_dept FOREIGN KEY (tenant_id, department_id) REFERENCES tenant_departments(tenant_id, id) ON DELETE SET NULL
    );
    CREATE INDEX IF NOT EXISTS idx_feed_posts_pinned ON tenant_feed_posts(tenant_id, is_pinned DESC, created_at DESC);

    CREATE TABLE IF NOT EXISTS tenant_feed_comments (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
      post_id UUID NOT NULL,
      author_user_id UUID,
      author_name VARCHAR(150) NOT NULL,
      content TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
      CONSTRAINT uk_tenant_feed_comments_tenant_id UNIQUE (tenant_id, id),
      CONSTRAINT fk_fc_post FOREIGN KEY (tenant_id, post_id) REFERENCES tenant_feed_posts(tenant_id, id) ON DELETE CASCADE,
      CONSTRAINT fk_fc_author FOREIGN KEY (tenant_id, author_user_id) REFERENCES users(tenant_id, id) ON DELETE SET NULL
    );
    CREATE INDEX IF NOT EXISTS idx_feed_comments_post ON tenant_feed_comments(tenant_id, post_id, created_at ASC);

    CREATE TABLE IF NOT EXISTS tenant_kudos_recognitions (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
      sender_user_id UUID,
      sender_name VARCHAR(150) NOT NULL,
      recipient_user_id UUID NOT NULL,
      recipient_name VARCHAR(150) NOT NULL,
      badge_key VARCHAR(50) NOT NULL DEFAULT 'top_performer',
      badge_title VARCHAR(120) NOT NULL DEFAULT 'Chiến binh Xuất sắc',
      points INTEGER NOT NULL DEFAULT 10,
      message TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
      CONSTRAINT uk_tenant_kudos_recognitions_tenant_id UNIQUE (tenant_id, id),
      CONSTRAINT fk_kudos_sender FOREIGN KEY (tenant_id, sender_user_id) REFERENCES users(tenant_id, id) ON DELETE SET NULL,
      CONSTRAINT fk_kudos_recipient FOREIGN KEY (tenant_id, recipient_user_id) REFERENCES users(tenant_id, id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_kudos_recipient ON tenant_kudos_recognitions(tenant_id, recipient_user_id, created_at DESC);

    -- ========================================================================
    -- GROUP 3: B2B COMPANIES, MULTI-DEALS, QUOTES, SO/PO, DEPOSITS & CASHFLOW
    -- ========================================================================
    CREATE TABLE IF NOT EXISTS tenant_b2b_companies (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
      code VARCHAR(50) NOT NULL,
      name VARCHAR(255) NOT NULL,
      tax_code VARCHAR(50),
      industry VARCHAR(100),
      company_size VARCHAR(50),
      website VARCHAR(255),
      billing_address TEXT,
      phone VARCHAR(40),
      email VARCHAR(255),
      representative_name VARCHAR(150),
      owner_user_id UUID,
      primary_lead_id UUID,
      contacts_json JSONB NOT NULL DEFAULT '[]'::jsonb,
      tier VARCHAR(30) NOT NULL DEFAULT 'standard' CHECK (tier IN ('standard', 'silver', 'gold', 'enterprise')),
      notes TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
      CONSTRAINT uk_tenant_b2b_companies_tenant_id UNIQUE (tenant_id, id),
      CONSTRAINT uk_tenant_b2b_companies_code UNIQUE (tenant_id, code),
      CONSTRAINT fk_b2b_owner FOREIGN KEY (tenant_id, owner_user_id) REFERENCES users(tenant_id, id) ON DELETE SET NULL,
      CONSTRAINT fk_b2b_lead FOREIGN KEY (tenant_id, primary_lead_id) REFERENCES leads(tenant_id, id) ON DELETE SET NULL
    );
    CREATE INDEX IF NOT EXISTS idx_b2b_companies_tax ON tenant_b2b_companies(tenant_id, tax_code);

    CREATE TABLE IF NOT EXISTS tenant_deals (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
      deal_code VARCHAR(50) NOT NULL,
      title VARCHAR(255) NOT NULL,
      company_id UUID,
      lead_id UUID,
      owner_user_id UUID,
      stage VARCHAR(40) NOT NULL DEFAULT 'qualification' CHECK (stage IN ('qualification', 'discovery', 'proposal', 'negotiation', 'won', 'lost')),
      amount_vnd BIGINT NOT NULL DEFAULT 0,
      probability INTEGER NOT NULL DEFAULT 30 CHECK (probability >= 0 AND probability <= 100),
      expected_close_date DATE,
      actual_close_date DATE,
      lost_reason TEXT,
      notes TEXT,
      metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
      created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
      CONSTRAINT uk_tenant_deals_tenant_id UNIQUE (tenant_id, id),
      CONSTRAINT uk_tenant_deals_code UNIQUE (tenant_id, deal_code),
      CONSTRAINT fk_deal_company FOREIGN KEY (tenant_id, company_id) REFERENCES tenant_b2b_companies(tenant_id, id) ON DELETE SET NULL,
      CONSTRAINT fk_deal_lead FOREIGN KEY (tenant_id, lead_id) REFERENCES leads(tenant_id, id) ON DELETE SET NULL,
      CONSTRAINT fk_deal_owner FOREIGN KEY (tenant_id, owner_user_id) REFERENCES users(tenant_id, id) ON DELETE SET NULL
    );
    CREATE INDEX IF NOT EXISTS idx_tenant_deals_stage ON tenant_deals(tenant_id, stage, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_tenant_deals_lead ON tenant_deals(tenant_id, lead_id);
    CREATE INDEX IF NOT EXISTS idx_tenant_deals_owner_stage ON tenant_deals(tenant_id, owner_user_id, stage);
    CREATE INDEX IF NOT EXISTS idx_tenant_deals_company ON tenant_deals(tenant_id, company_id, created_at DESC);

    CREATE TABLE IF NOT EXISTS tenant_suppliers (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
      code VARCHAR(50) NOT NULL,
      name VARCHAR(255) NOT NULL,
      tax_code VARCHAR(50),
      contact_name VARCHAR(150),
      phone VARCHAR(40),
      email VARCHAR(255),
      address TEXT,
      payment_terms VARCHAR(100),
      rating INTEGER NOT NULL DEFAULT 5,
      is_active BOOLEAN NOT NULL DEFAULT true,
      created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
      CONSTRAINT uk_tenant_suppliers_tenant_id UNIQUE (tenant_id, id),
      CONSTRAINT uk_tenant_suppliers_code UNIQUE (tenant_id, code)
    );

    CREATE TABLE IF NOT EXISTS tenant_warehouses (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
      code VARCHAR(50) NOT NULL,
      name VARCHAR(150) NOT NULL,
      branch_id UUID,
      address TEXT,
      manager_user_id UUID,
      is_default BOOLEAN NOT NULL DEFAULT false,
      is_active BOOLEAN NOT NULL DEFAULT true,
      created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
      CONSTRAINT uk_tenant_warehouses_tenant_id UNIQUE (tenant_id, id),
      CONSTRAINT uk_tenant_warehouses_code UNIQUE (tenant_id, code),
      CONSTRAINT fk_wh_branch FOREIGN KEY (tenant_id, branch_id) REFERENCES tenant_branches(tenant_id, id) ON DELETE SET NULL,
      CONSTRAINT fk_wh_manager FOREIGN KEY (tenant_id, manager_user_id) REFERENCES users(tenant_id, id) ON DELETE SET NULL
    );

    CREATE TABLE IF NOT EXISTS tenant_products (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
      sku VARCHAR(80) NOT NULL,
      barcode VARCHAR(80),
      name VARCHAR(255) NOT NULL,
      category VARCHAR(100) NOT NULL DEFAULT 'general',
      unit VARCHAR(40) NOT NULL DEFAULT 'Cái',
      product_type VARCHAR(20) NOT NULL DEFAULT 'goods' CHECK (product_type IN ('goods', 'service', 'bundle')),
      sale_price_vnd BIGINT NOT NULL DEFAULT 0,
      default_cost_vnd BIGINT NOT NULL DEFAULT 0,
      tax_rate_pct NUMERIC(5,2) NOT NULL DEFAULT 0,
      min_stock_alert INTEGER NOT NULL DEFAULT 5,
      cached_stock_qty INTEGER NOT NULL DEFAULT 0,
      is_active BOOLEAN NOT NULL DEFAULT true,
      metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
      created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
      CONSTRAINT uk_tenant_products_tenant_id UNIQUE (tenant_id, id),
      CONSTRAINT uk_tenant_products_sku UNIQUE (tenant_id, sku)
    );
    CREATE INDEX IF NOT EXISTS idx_tenant_products_cat ON tenant_products(tenant_id, category, is_active);

    CREATE TABLE IF NOT EXISTS tenant_quotes (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
      quote_code VARCHAR(50) NOT NULL,
      title VARCHAR(255) NOT NULL,
      company_id UUID,
      lead_id UUID,
      deal_id UUID,
      branch_id UUID,
      status VARCHAR(30) NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'sent', 'accepted', 'converted', 'rejected', 'expired')),
      items_json JSONB NOT NULL DEFAULT '[]'::jsonb,
      subtotal_vnd BIGINT NOT NULL DEFAULT 0,
      discount_vnd BIGINT NOT NULL DEFAULT 0,
      tax_vnd BIGINT NOT NULL DEFAULT 0,
      total_vnd BIGINT NOT NULL DEFAULT 0,
      valid_until DATE,
      terms_text TEXT,
      converted_order_id UUID,
      created_by UUID,
      created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
      CONSTRAINT uk_tenant_quotes_tenant_id UNIQUE (tenant_id, id),
      CONSTRAINT uk_tenant_quotes_code UNIQUE (tenant_id, quote_code),
      CONSTRAINT fk_quote_company FOREIGN KEY (tenant_id, company_id) REFERENCES tenant_b2b_companies(tenant_id, id) ON DELETE SET NULL,
      CONSTRAINT fk_quote_lead FOREIGN KEY (tenant_id, lead_id) REFERENCES leads(tenant_id, id) ON DELETE SET NULL,
      CONSTRAINT fk_quote_deal FOREIGN KEY (tenant_id, deal_id) REFERENCES tenant_deals(tenant_id, id) ON DELETE SET NULL,
      CONSTRAINT fk_quote_branch FOREIGN KEY (tenant_id, branch_id) REFERENCES tenant_branches(tenant_id, id) ON DELETE SET NULL,
      CONSTRAINT fk_quote_creator FOREIGN KEY (tenant_id, created_by) REFERENCES users(tenant_id, id) ON DELETE SET NULL
    );

    CREATE TABLE IF NOT EXISTS tenant_sales_orders (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
      order_code VARCHAR(50) NOT NULL,
      quote_id UUID,
      company_id UUID,
      lead_id UUID,
      deal_id UUID,
      branch_id UUID,
      warehouse_id UUID,
      sales_rep_id UUID,
      customer_name VARCHAR(200) NOT NULL,
      status VARCHAR(30) NOT NULL DEFAULT 'confirmed' CHECK (status IN ('draft', 'confirmed', 'fulfilled', 'completed', 'cancelled')),
      payment_status VARCHAR(30) NOT NULL DEFAULT 'unpaid' CHECK (payment_status IN ('unpaid', 'partial', 'paid', 'refunded')),
      fulfillment_status VARCHAR(30) NOT NULL DEFAULT 'pending' CHECK (fulfillment_status IN ('pending', 'fulfilled', 'not_required')),
      items_json JSONB NOT NULL DEFAULT '[]'::jsonb,
      subtotal_vnd BIGINT NOT NULL DEFAULT 0,
      discount_vnd BIGINT NOT NULL DEFAULT 0,
      tax_vnd BIGINT NOT NULL DEFAULT 0,
      total_vnd BIGINT NOT NULL DEFAULT 0,
      paid_vnd BIGINT NOT NULL DEFAULT 0,
      attributed_revenue_vnd BIGINT NOT NULL DEFAULT 0,
      cogs_vnd BIGINT NOT NULL DEFAULT 0,
      notes TEXT,
      completed_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
      CONSTRAINT uk_tenant_sales_orders_tenant_id UNIQUE (tenant_id, id),
      CONSTRAINT uk_tenant_sales_orders_code UNIQUE (tenant_id, order_code),
      CONSTRAINT fk_so_quote FOREIGN KEY (tenant_id, quote_id) REFERENCES tenant_quotes(tenant_id, id) ON DELETE SET NULL,
      CONSTRAINT fk_so_company FOREIGN KEY (tenant_id, company_id) REFERENCES tenant_b2b_companies(tenant_id, id) ON DELETE SET NULL,
      CONSTRAINT fk_so_lead FOREIGN KEY (tenant_id, lead_id) REFERENCES leads(tenant_id, id) ON DELETE SET NULL,
      CONSTRAINT fk_so_deal FOREIGN KEY (tenant_id, deal_id) REFERENCES tenant_deals(tenant_id, id) ON DELETE SET NULL,
      CONSTRAINT fk_so_branch FOREIGN KEY (tenant_id, branch_id) REFERENCES tenant_branches(tenant_id, id) ON DELETE SET NULL,
      CONSTRAINT fk_so_wh FOREIGN KEY (tenant_id, warehouse_id) REFERENCES tenant_warehouses(tenant_id, id) ON DELETE SET NULL,
      CONSTRAINT fk_so_rep FOREIGN KEY (tenant_id, sales_rep_id) REFERENCES users(tenant_id, id) ON DELETE SET NULL
    );
    CREATE INDEX IF NOT EXISTS idx_sales_orders_status ON tenant_sales_orders(tenant_id, status, payment_status, created_at DESC);

    CREATE TABLE IF NOT EXISTS tenant_deposits (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
      deposit_code VARCHAR(50) NOT NULL,
      lead_id UUID,
      company_id UUID,
      deal_id UUID,
      sales_order_id UUID,
      customer_name VARCHAR(200) NOT NULL,
      amount_vnd BIGINT NOT NULL DEFAULT 0,
      payment_method VARCHAR(40) NOT NULL DEFAULT 'bank_transfer',
      status VARCHAR(30) NOT NULL DEFAULT 'received' CHECK (status IN ('pending', 'received', 'applied', 'refunded', 'forfeited')),
      reference_no VARCHAR(100),
      notes TEXT,
      received_by UUID,
      received_at TIMESTAMPTZ DEFAULT clock_timestamp(),
      created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
      CONSTRAINT uk_tenant_deposits_tenant_id UNIQUE (tenant_id, id),
      CONSTRAINT uk_tenant_deposits_code UNIQUE (tenant_id, deposit_code),
      CONSTRAINT fk_dep_lead FOREIGN KEY (tenant_id, lead_id) REFERENCES leads(tenant_id, id) ON DELETE SET NULL,
      CONSTRAINT fk_dep_company FOREIGN KEY (tenant_id, company_id) REFERENCES tenant_b2b_companies(tenant_id, id) ON DELETE SET NULL,
      CONSTRAINT fk_dep_deal FOREIGN KEY (tenant_id, deal_id) REFERENCES tenant_deals(tenant_id, id) ON DELETE SET NULL,
      CONSTRAINT fk_dep_so FOREIGN KEY (tenant_id, sales_order_id) REFERENCES tenant_sales_orders(tenant_id, id) ON DELETE SET NULL,
      CONSTRAINT fk_dep_receiver FOREIGN KEY (tenant_id, received_by) REFERENCES users(tenant_id, id) ON DELETE SET NULL
    );

    CREATE TABLE IF NOT EXISTS tenant_purchase_orders (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
      po_code VARCHAR(50) NOT NULL,
      supplier_id UUID,
      warehouse_id UUID,
      supplier_name VARCHAR(200) NOT NULL,
      status VARCHAR(30) NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'approved', 'ordered', 'received', 'cancelled')),
      items_json JSONB NOT NULL DEFAULT '[]'::jsonb,
      total_vnd BIGINT NOT NULL DEFAULT 0,
      expected_date DATE,
      received_at TIMESTAMPTZ,
      notes TEXT,
      created_by UUID,
      created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
      CONSTRAINT uk_tenant_purchase_orders_tenant_id UNIQUE (tenant_id, id),
      CONSTRAINT uk_tenant_po_code UNIQUE (tenant_id, po_code),
      CONSTRAINT fk_po_supplier FOREIGN KEY (tenant_id, supplier_id) REFERENCES tenant_suppliers(tenant_id, id) ON DELETE SET NULL,
      CONSTRAINT fk_po_wh FOREIGN KEY (tenant_id, warehouse_id) REFERENCES tenant_warehouses(tenant_id, id) ON DELETE SET NULL,
      CONSTRAINT fk_po_creator FOREIGN KEY (tenant_id, created_by) REFERENCES users(tenant_id, id) ON DELETE SET NULL
    );

    CREATE TABLE IF NOT EXISTS tenant_finance_transactions (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
      tx_code VARCHAR(50) NOT NULL,
      tx_type VARCHAR(20) NOT NULL CHECK (tx_type IN ('income', 'expense')),
      category VARCHAR(80) NOT NULL DEFAULT 'sales_revenue',
      amount_vnd BIGINT NOT NULL DEFAULT 0,
      payment_method VARCHAR(40) NOT NULL DEFAULT 'bank_transfer',
      status VARCHAR(30) NOT NULL DEFAULT 'completed' CHECK (status IN ('pending', 'completed', 'cancelled')),
      counterparty_name VARCHAR(200),
      counterparty_tax_code VARCHAR(50),
      branch_id UUID,
      lead_id UUID,
      company_id UUID,
      sales_order_id UUID,
      purchase_order_id UUID,
      deposit_id UUID,
      tx_date DATE NOT NULL DEFAULT CURRENT_DATE,
      description TEXT,
      created_by UUID,
      created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
      CONSTRAINT uk_tenant_finance_transactions_tenant_id UNIQUE (tenant_id, id),
      CONSTRAINT uk_tenant_fin_tx_code UNIQUE (tenant_id, tx_code),
      CONSTRAINT fk_ftx_branch FOREIGN KEY (tenant_id, branch_id) REFERENCES tenant_branches(tenant_id, id) ON DELETE SET NULL,
      CONSTRAINT fk_ftx_lead FOREIGN KEY (tenant_id, lead_id) REFERENCES leads(tenant_id, id) ON DELETE SET NULL,
      CONSTRAINT fk_ftx_company FOREIGN KEY (tenant_id, company_id) REFERENCES tenant_b2b_companies(tenant_id, id) ON DELETE SET NULL,
      CONSTRAINT fk_ftx_so FOREIGN KEY (tenant_id, sales_order_id) REFERENCES tenant_sales_orders(tenant_id, id) ON DELETE SET NULL,
      CONSTRAINT fk_ftx_po FOREIGN KEY (tenant_id, purchase_order_id) REFERENCES tenant_purchase_orders(tenant_id, id) ON DELETE SET NULL,
      CONSTRAINT fk_ftx_dep FOREIGN KEY (tenant_id, deposit_id) REFERENCES tenant_deposits(tenant_id, id) ON DELETE SET NULL,
      CONSTRAINT fk_ftx_creator FOREIGN KEY (tenant_id, created_by) REFERENCES users(tenant_id, id) ON DELETE SET NULL
    );
    CREATE INDEX IF NOT EXISTS idx_finance_tx_type_date ON tenant_finance_transactions(tenant_id, tx_type, tx_date DESC);

    -- ========================================================================
    -- GROUP 4: FIFO INVENTORY BATCHES, MOVEMENTS & FIXED ASSETS
    -- ========================================================================
    CREATE TABLE IF NOT EXISTS tenant_inventory_batches (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
      product_id UUID NOT NULL,
      warehouse_id UUID,
      supplier_id UUID,
      purchase_order_id UUID,
      batch_code VARCHAR(80) NOT NULL,
      initial_qty INTEGER NOT NULL CHECK (initial_qty >= 0),
      remaining_qty INTEGER NOT NULL CHECK (remaining_qty >= 0),
      unit_cost_vnd BIGINT NOT NULL DEFAULT 0,
      received_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
      expiry_date DATE,
      status VARCHAR(20) NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'depleted', 'expired', 'archived')),
      notes TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
      CONSTRAINT uk_tenant_inventory_batches_tenant_id UNIQUE (tenant_id, id),
      CONSTRAINT uk_tenant_inv_batch_code UNIQUE (tenant_id, batch_code),
      CONSTRAINT fk_ib_product FOREIGN KEY (tenant_id, product_id) REFERENCES tenant_products(tenant_id, id) ON DELETE CASCADE,
      CONSTRAINT fk_ib_wh FOREIGN KEY (tenant_id, warehouse_id) REFERENCES tenant_warehouses(tenant_id, id) ON DELETE SET NULL,
      CONSTRAINT fk_ib_supplier FOREIGN KEY (tenant_id, supplier_id) REFERENCES tenant_suppliers(tenant_id, id) ON DELETE SET NULL,
      CONSTRAINT fk_ib_po FOREIGN KEY (tenant_id, purchase_order_id) REFERENCES tenant_purchase_orders(tenant_id, id) ON DELETE SET NULL
    );
    CREATE INDEX IF NOT EXISTS idx_inv_batches_fifo ON tenant_inventory_batches(tenant_id, product_id, status, received_at ASC);

    CREATE TABLE IF NOT EXISTS tenant_stock_movements (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
      product_id UUID NOT NULL,
      batch_id UUID,
      warehouse_id UUID,
      movement_type VARCHAR(30) NOT NULL CHECK (movement_type IN ('IN_BATCH', 'OUT_SO', 'OUT_POS', 'OUT_MANUAL', 'ADJUST', 'RETURN')),
      qty_delta INTEGER NOT NULL,
      unit_cost_vnd BIGINT NOT NULL DEFAULT 0,
      total_cost_vnd BIGINT NOT NULL DEFAULT 0,
      reference_type VARCHAR(40),
      reference_id VARCHAR(80),
      note TEXT,
      created_by UUID,
      created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
      CONSTRAINT uk_tenant_stock_movements_tenant_id UNIQUE (tenant_id, id),
      CONSTRAINT fk_sm_product FOREIGN KEY (tenant_id, product_id) REFERENCES tenant_products(tenant_id, id) ON DELETE CASCADE,
      CONSTRAINT fk_sm_batch FOREIGN KEY (tenant_id, batch_id) REFERENCES tenant_inventory_batches(tenant_id, id) ON DELETE SET NULL,
      CONSTRAINT fk_sm_wh FOREIGN KEY (tenant_id, warehouse_id) REFERENCES tenant_warehouses(tenant_id, id) ON DELETE SET NULL,
      CONSTRAINT fk_sm_creator FOREIGN KEY (tenant_id, created_by) REFERENCES users(tenant_id, id) ON DELETE SET NULL
    );
    CREATE INDEX IF NOT EXISTS idx_stock_movements_prod ON tenant_stock_movements(tenant_id, product_id, created_at DESC);

    CREATE TABLE IF NOT EXISTS tenant_fixed_assets (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
      asset_code VARCHAR(60) NOT NULL,
      name VARCHAR(255) NOT NULL,
      category VARCHAR(80) NOT NULL DEFAULT 'IT Equipment',
      serial_number VARCHAR(100),
      branch_id UUID,
      department_id UUID,
      assigned_user_id UUID,
      purchase_date DATE NOT NULL DEFAULT CURRENT_DATE,
      purchase_cost_vnd BIGINT NOT NULL DEFAULT 0,
      salvage_value_vnd BIGINT NOT NULL DEFAULT 0,
      useful_life_months INTEGER NOT NULL DEFAULT 36 CHECK (useful_life_months >= 1),
      status VARCHAR(30) NOT NULL DEFAULT 'in_use' CHECK (status IN ('available', 'in_use', 'maintenance', 'retired', 'disposed')),
      notes TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
      CONSTRAINT uk_tenant_fixed_assets_tenant_id UNIQUE (tenant_id, id),
      CONSTRAINT uk_tenant_fixed_asset_code UNIQUE (tenant_id, asset_code),
      CONSTRAINT fk_fa_branch FOREIGN KEY (tenant_id, branch_id) REFERENCES tenant_branches(tenant_id, id) ON DELETE SET NULL,
      CONSTRAINT fk_fa_dept FOREIGN KEY (tenant_id, department_id) REFERENCES tenant_departments(tenant_id, id) ON DELETE SET NULL,
      CONSTRAINT fk_fa_user FOREIGN KEY (tenant_id, assigned_user_id) REFERENCES users(tenant_id, id) ON DELETE SET NULL
    );

    -- ========================================================================
    -- GROUP 5: TENANT CLOUD DRIVE (ACL + NAMESPACE) & AI OCR EXTRACTOR
    -- ========================================================================
    CREATE TABLE IF NOT EXISTS tenant_cloud_folders (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
      parent_folder_id UUID,
      name VARCHAR(200) NOT NULL,
      storage_prefix VARCHAR(500) NOT NULL,
      visibility VARCHAR(30) NOT NULL DEFAULT 'company' CHECK (visibility IN ('company', 'departments', 'private')),
      allowed_department_ids JSONB NOT NULL DEFAULT '[]'::jsonb,
      created_by UUID,
      created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
      CONSTRAINT uk_tenant_cloud_folders_tenant_id UNIQUE (tenant_id, id),
      CONSTRAINT fk_cfolder_parent FOREIGN KEY (tenant_id, parent_folder_id) REFERENCES tenant_cloud_folders(tenant_id, id) ON DELETE CASCADE,
      CONSTRAINT fk_cfolder_creator FOREIGN KEY (tenant_id, created_by) REFERENCES users(tenant_id, id) ON DELETE SET NULL
    );

    CREATE TABLE IF NOT EXISTS tenant_cloud_files (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
      folder_id UUID,
      project_id UUID,
      name VARCHAR(255) NOT NULL,
      storage_key VARCHAR(600) NOT NULL,
      mime_type VARCHAR(120) NOT NULL DEFAULT 'application/octet-stream',
      size_bytes BIGINT NOT NULL DEFAULT 0,
      version_tag VARCHAR(40) NOT NULL DEFAULT 'v1.0',
      visibility VARCHAR(30) NOT NULL DEFAULT 'company' CHECK (visibility IN ('company', 'departments', 'private')),
      allowed_department_ids JSONB NOT NULL DEFAULT '[]'::jsonb,
      checksum_sha256 VARCHAR(80),
      content_preview TEXT,
      uploaded_by UUID,
      uploaded_by_name VARCHAR(150),
      created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
      CONSTRAINT uk_tenant_cloud_files_tenant_id UNIQUE (tenant_id, id),
      CONSTRAINT fk_cfile_folder FOREIGN KEY (tenant_id, folder_id) REFERENCES tenant_cloud_folders(tenant_id, id) ON DELETE SET NULL,
      CONSTRAINT fk_cfile_proj FOREIGN KEY (tenant_id, project_id) REFERENCES tenant_projects(tenant_id, id) ON DELETE SET NULL,
      CONSTRAINT fk_cfile_uploader FOREIGN KEY (tenant_id, uploaded_by) REFERENCES users(tenant_id, id) ON DELETE SET NULL
    );
    CREATE INDEX IF NOT EXISTS idx_cloud_files_folder ON tenant_cloud_files(tenant_id, folder_id, created_at DESC);

    CREATE TABLE IF NOT EXISTS tenant_ocr_extractions (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
      doc_type VARCHAR(40) NOT NULL DEFAULT 'contract' CHECK (doc_type IN ('contract', 'cccd', 'business_license', 'invoice')),
      source_file_id UUID,
      source_title VARCHAR(255) NOT NULL,
      raw_text TEXT NOT NULL,
      extracted_party_name VARCHAR(255),
      extracted_tax_code VARCHAR(60),
      extracted_id_number VARCHAR(60),
      extracted_representative VARCHAR(150),
      extracted_address TEXT,
      contract_value_vnd BIGINT NOT NULL DEFAULT 0,
      effective_date DATE,
      expiry_date DATE,
      branch_verification_json JSONB NOT NULL DEFAULT '{}'::jsonb,
      extracted_fields_json JSONB NOT NULL DEFAULT '{}'::jsonb,
      saved_company_id UUID,
      saved_transaction_id UUID,
      created_by UUID,
      created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
      CONSTRAINT uk_tenant_ocr_extractions_tenant_id UNIQUE (tenant_id, id),
      CONSTRAINT fk_ocr_file FOREIGN KEY (tenant_id, source_file_id) REFERENCES tenant_cloud_files(tenant_id, id) ON DELETE SET NULL,
      CONSTRAINT fk_ocr_comp FOREIGN KEY (tenant_id, saved_company_id) REFERENCES tenant_b2b_companies(tenant_id, id) ON DELETE SET NULL,
      CONSTRAINT fk_ocr_tx FOREIGN KEY (tenant_id, saved_transaction_id) REFERENCES tenant_finance_transactions(tenant_id, id) ON DELETE SET NULL,
      CONSTRAINT fk_ocr_creator FOREIGN KEY (tenant_id, created_by) REFERENCES users(tenant_id, id) ON DELETE SET NULL
    );

    -- ========================================================================
    -- GROUP 6: EDUCATION VERTICAL ADD-ON (GATED BY education_addon)
    -- ========================================================================
    CREATE TABLE IF NOT EXISTS tenant_edu_courses (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
      code VARCHAR(50) NOT NULL,
      name VARCHAR(255) NOT NULL,
      category VARCHAR(100) NOT NULL DEFAULT 'Program',
      duration_sessions INTEGER NOT NULL DEFAULT 12,
      tuition_fee_vnd BIGINT NOT NULL DEFAULT 0,
      description TEXT,
      is_active BOOLEAN NOT NULL DEFAULT true,
      created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
      CONSTRAINT uk_tenant_edu_courses_tenant_id UNIQUE (tenant_id, id),
      CONSTRAINT uk_tenant_edu_courses_code UNIQUE (tenant_id, code)
    );

    CREATE TABLE IF NOT EXISTS tenant_edu_classes (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
      course_id UUID NOT NULL,
      code VARCHAR(50) NOT NULL,
      name VARCHAR(200) NOT NULL,
      instructor_user_id UUID,
      instructor_name VARCHAR(150),
      branch_id UUID,
      room_name VARCHAR(100),
      max_capacity INTEGER NOT NULL DEFAULT 30,
      start_date DATE,
      end_date DATE,
      status VARCHAR(30) NOT NULL DEFAULT 'enrolling' CHECK (status IN ('planning', 'enrolling', 'ongoing', 'completed', 'cancelled')),
      created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
      CONSTRAINT uk_tenant_edu_classes_tenant_id UNIQUE (tenant_id, id),
      CONSTRAINT uk_tenant_edu_classes_code UNIQUE (tenant_id, code),
      CONSTRAINT fk_ecls_course FOREIGN KEY (tenant_id, course_id) REFERENCES tenant_edu_courses(tenant_id, id) ON DELETE CASCADE,
      CONSTRAINT fk_ecls_inst FOREIGN KEY (tenant_id, instructor_user_id) REFERENCES users(tenant_id, id) ON DELETE SET NULL,
      CONSTRAINT fk_ecls_branch FOREIGN KEY (tenant_id, branch_id) REFERENCES tenant_branches(tenant_id, id) ON DELETE SET NULL
    );

    CREATE TABLE IF NOT EXISTS tenant_edu_schedules (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
      class_id UUID NOT NULL,
      day_of_week INTEGER NOT NULL CHECK (day_of_week >= 0 AND day_of_week <= 6),
      start_time VARCHAR(10) NOT NULL,
      end_time VARCHAR(10) NOT NULL,
      room_name VARCHAR(100) NOT NULL,
      instructor_user_id UUID,
      instructor_name VARCHAR(150),
      topic VARCHAR(255),
      created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
      CONSTRAINT uk_tenant_edu_schedules_tenant_id UNIQUE (tenant_id, id),
      CONSTRAINT fk_esch_class FOREIGN KEY (tenant_id, class_id) REFERENCES tenant_edu_classes(tenant_id, id) ON DELETE CASCADE,
      CONSTRAINT fk_esch_inst FOREIGN KEY (tenant_id, instructor_user_id) REFERENCES users(tenant_id, id) ON DELETE SET NULL
    );
    CREATE INDEX IF NOT EXISTS idx_edu_schedules_slot ON tenant_edu_schedules(tenant_id, day_of_week, room_name);

    CREATE TABLE IF NOT EXISTS tenant_edu_enrollments (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
      class_id UUID NOT NULL,
      lead_id UUID,
      student_name VARCHAR(150) NOT NULL,
      student_phone VARCHAR(40),
      student_email VARCHAR(255),
      status VARCHAR(30) NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'completed', 'deferred', 'dropped')),
      tuition_paid_vnd BIGINT NOT NULL DEFAULT 0,
      enrolled_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
      CONSTRAINT uk_tenant_edu_enrollments_tenant_id UNIQUE (tenant_id, id),
      CONSTRAINT fk_eenr_class FOREIGN KEY (tenant_id, class_id) REFERENCES tenant_edu_classes(tenant_id, id) ON DELETE CASCADE,
      CONSTRAINT fk_eenr_lead FOREIGN KEY (tenant_id, lead_id) REFERENCES leads(tenant_id, id) ON DELETE SET NULL
    );

    CREATE TABLE IF NOT EXISTS tenant_edu_attendance_grades (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
      enrollment_id UUID NOT NULL,
      class_id UUID NOT NULL,
      session_date DATE NOT NULL DEFAULT CURRENT_DATE,
      attendance_status VARCHAR(20) NOT NULL DEFAULT 'present' CHECK (attendance_status IN ('present', 'late', 'excused', 'absent')),
      midterm_score NUMERIC(5,2),
      final_score NUMERIC(5,2),
      gpa_score NUMERIC(5,2),
      feedback TEXT,
      recorded_by UUID,
      created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
      CONSTRAINT uk_tenant_edu_attendance_grades_tenant_id UNIQUE (tenant_id, id),
      CONSTRAINT fk_eag_enr FOREIGN KEY (tenant_id, enrollment_id) REFERENCES tenant_edu_enrollments(tenant_id, id) ON DELETE CASCADE,
      CONSTRAINT fk_eag_class FOREIGN KEY (tenant_id, class_id) REFERENCES tenant_edu_classes(tenant_id, id) ON DELETE CASCADE,
      CONSTRAINT fk_eag_rec FOREIGN KEY (tenant_id, recorded_by) REFERENCES users(tenant_id, id) ON DELETE SET NULL
    );

    -- ========================================================================
    -- GROUP 7: STAGE 4B FULL-CLONE TABLES & IDEMPOTENT COLUMN UPGRADES
    -- ========================================================================
    ALTER TABLE tenant_quotes ADD COLUMN IF NOT EXISTS shipping_fee_vnd BIGINT NOT NULL DEFAULT 0;
    ALTER TABLE tenant_quotes ADD COLUMN IF NOT EXISTS discount_pct NUMERIC(5,2) NOT NULL DEFAULT 0;
    ALTER TABLE tenant_quotes ADD COLUMN IF NOT EXISTS tax_pct NUMERIC(5,2) NOT NULL DEFAULT 0;
    ALTER TABLE tenant_quotes ADD COLUMN IF NOT EXISTS notes TEXT;
    ALTER TABLE tenant_quotes ADD COLUMN IF NOT EXISTS customer_name VARCHAR(200);
    ALTER TABLE tenant_quotes ADD COLUMN IF NOT EXISTS customer_email VARCHAR(255);
    ALTER TABLE tenant_quotes ADD COLUMN IF NOT EXISTS customer_phone VARCHAR(40);

    ALTER TABLE tenant_sales_orders ADD COLUMN IF NOT EXISTS shipping_fee_vnd BIGINT NOT NULL DEFAULT 0;
    ALTER TABLE tenant_sales_orders ADD COLUMN IF NOT EXISTS voucher_code VARCHAR(80);
    ALTER TABLE tenant_sales_orders ADD COLUMN IF NOT EXISTS payment_method VARCHAR(40) NOT NULL DEFAULT 'bank_transfer';
    ALTER TABLE tenant_sales_orders ADD COLUMN IF NOT EXISTS split_payments_json JSONB NOT NULL DEFAULT '[]'::jsonb;

    ALTER TABLE tenant_purchase_orders ADD COLUMN IF NOT EXISTS subtotal_vnd BIGINT NOT NULL DEFAULT 0;
    ALTER TABLE tenant_purchase_orders ADD COLUMN IF NOT EXISTS discount_vnd BIGINT NOT NULL DEFAULT 0;
    ALTER TABLE tenant_purchase_orders ADD COLUMN IF NOT EXISTS tax_vnd BIGINT NOT NULL DEFAULT 0;
    ALTER TABLE tenant_purchase_orders ADD COLUMN IF NOT EXISTS shipping_fee_vnd BIGINT NOT NULL DEFAULT 0;
    ALTER TABLE tenant_purchase_orders ADD COLUMN IF NOT EXISTS payment_status VARCHAR(30) NOT NULL DEFAULT 'unpaid';
    ALTER TABLE tenant_purchase_orders ADD COLUMN IF NOT EXISTS paid_vnd BIGINT NOT NULL DEFAULT 0;
    ALTER TABLE tenant_purchase_orders ADD COLUMN IF NOT EXISTS three_way_match_status VARCHAR(30) NOT NULL DEFAULT 'pending';
    ALTER TABLE tenant_purchase_orders ADD COLUMN IF NOT EXISTS three_way_match_json JSONB NOT NULL DEFAULT '{}'::jsonb;

    ALTER TABLE tenant_deposits ADD COLUMN IF NOT EXISTS project_id UUID;
    ALTER TABLE tenant_deposits ADD COLUMN IF NOT EXISTS unit_code VARCHAR(80);
    ALTER TABLE tenant_deposits ADD COLUMN IF NOT EXISTS contract_value_vnd BIGINT NOT NULL DEFAULT 0;
    ALTER TABLE tenant_deposits ADD COLUMN IF NOT EXISTS expected_commission_vnd BIGINT NOT NULL DEFAULT 0;
    ALTER TABLE tenant_deposits ADD COLUMN IF NOT EXISTS currency VARCHAR(10) NOT NULL DEFAULT 'VND';
    ALTER TABLE tenant_deposits ADD COLUMN IF NOT EXISTS exchange_rate NUMERIC(12,4) NOT NULL DEFAULT 1;
    ALTER TABLE tenant_deposits ADD COLUMN IF NOT EXISTS unc_attachment_url TEXT;
    ALTER TABLE tenant_deposits ADD COLUMN IF NOT EXISTS attachments_json JSONB NOT NULL DEFAULT '[]'::jsonb;
    ALTER TABLE tenant_deposits ADD COLUMN IF NOT EXISTS commission_shares_json JSONB NOT NULL DEFAULT '[]'::jsonb;
    ALTER TABLE tenant_deposits ADD COLUMN IF NOT EXISTS watchers_json JSONB NOT NULL DEFAULT '[]'::jsonb;
    ALTER TABLE tenant_deposits ADD COLUMN IF NOT EXISTS history_json JSONB NOT NULL DEFAULT '[]'::jsonb;
    ALTER TABLE tenant_deposits ADD COLUMN IF NOT EXISTS confirmed_by UUID;
    ALTER TABLE tenant_deposits ADD COLUMN IF NOT EXISTS confirmed_at TIMESTAMPTZ;
    ALTER TABLE tenant_deposits ADD COLUMN IF NOT EXISTS refunded_amount_vnd BIGINT NOT NULL DEFAULT 0;
    ALTER TABLE tenant_deposits ADD COLUMN IF NOT EXISTS refund_reason TEXT;

    ALTER TABLE tenant_suppliers ADD COLUMN IF NOT EXISTS prestige_tier VARCHAR(10) NOT NULL DEFAULT 'A';
    ALTER TABLE tenant_suppliers ADD COLUMN IF NOT EXISTS cooperation_status VARCHAR(30) NOT NULL DEFAULT 'active';
    ALTER TABLE tenant_suppliers ADD COLUMN IF NOT EXISTS website VARCHAR(255);
    ALTER TABLE tenant_suppliers ADD COLUMN IF NOT EXISTS bank_name VARCHAR(120);
    ALTER TABLE tenant_suppliers ADD COLUMN IF NOT EXISTS bank_account_no VARCHAR(80);
    ALTER TABLE tenant_suppliers ADD COLUMN IF NOT EXISTS bank_account_holder VARCHAR(150);
    ALTER TABLE tenant_suppliers ADD COLUMN IF NOT EXISTS categories_json JSONB NOT NULL DEFAULT '[]'::jsonb;
    ALTER TABLE tenant_suppliers ADD COLUMN IF NOT EXISTS notes TEXT;
    ALTER TABLE tenant_suppliers ADD COLUMN IF NOT EXISTS metadata_json JSONB NOT NULL DEFAULT '{}'::jsonb;

    ALTER TABLE tenant_cloud_files ADD COLUMN IF NOT EXISTS category_key VARCHAR(80) NOT NULL DEFAULT 'general';
    ALTER TABLE tenant_cloud_files ADD COLUMN IF NOT EXISTS lead_id UUID;
    ALTER TABLE tenant_cloud_files ADD COLUMN IF NOT EXISTS file_url TEXT;

    ALTER TABLE tenant_edu_courses ADD COLUMN IF NOT EXISTS grading_scale VARCHAR(30) NOT NULL DEFAULT 'scale_10';
    ALTER TABLE tenant_edu_courses ADD COLUMN IF NOT EXISTS subjects_json JSONB NOT NULL DEFAULT '[]'::jsonb;
    ALTER TABLE tenant_edu_courses ADD COLUMN IF NOT EXISTS credits INTEGER NOT NULL DEFAULT 3;

    ALTER TABLE tenant_edu_enrollments ADD COLUMN IF NOT EXISTS program_code VARCHAR(60);
    ALTER TABLE tenant_edu_enrollments ADD COLUMN IF NOT EXISTS postpone_status VARCHAR(30) NOT NULL DEFAULT 'none';
    ALTER TABLE tenant_edu_enrollments ADD COLUMN IF NOT EXISTS postpone_reason TEXT;
    ALTER TABLE tenant_edu_enrollments ADD COLUMN IF NOT EXISTS postpone_until DATE;
    ALTER TABLE tenant_edu_enrollments ADD COLUMN IF NOT EXISTS postpone_ocr_json JSONB NOT NULL DEFAULT '{}'::jsonb;
    ALTER TABLE tenant_edu_enrollments ADD COLUMN IF NOT EXISTS metadata_json JSONB NOT NULL DEFAULT '{}'::jsonb;

    ALTER TABLE tenant_edu_attendance_grades ADD COLUMN IF NOT EXISTS subject_key VARCHAR(80) NOT NULL DEFAULT 'GENERAL';
    ALTER TABLE tenant_edu_attendance_grades ADD COLUMN IF NOT EXISTS subject_name VARCHAR(200);
    ALTER TABLE tenant_edu_attendance_grades ADD COLUMN IF NOT EXISTS attendance_score NUMERIC(5,2);
    ALTER TABLE tenant_edu_attendance_grades ADD COLUMN IF NOT EXISTS assignment_score NUMERIC(5,2);
    ALTER TABLE tenant_edu_attendance_grades ADD COLUMN IF NOT EXISTS ects_score_6 NUMERIC(5,2);
    ALTER TABLE tenant_edu_attendance_grades ADD COLUMN IF NOT EXISTS letter_grade VARCHAR(40);
    ALTER TABLE tenant_edu_attendance_grades ADD COLUMN IF NOT EXISTS pass_status VARCHAR(20) NOT NULL DEFAULT 'passed';

    CREATE TABLE IF NOT EXISTS tenant_quote_items (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
      quote_id UUID NOT NULL,
      product_id UUID,
      sku VARCHAR(80) NOT NULL DEFAULT '',
      name VARCHAR(255) NOT NULL,
      description TEXT,
      unit VARCHAR(40) NOT NULL DEFAULT 'Cái',
      qty NUMERIC(12,2) NOT NULL DEFAULT 1,
      unit_price_vnd BIGINT NOT NULL DEFAULT 0,
      discount_pct NUMERIC(5,2) NOT NULL DEFAULT 0,
      tax_pct NUMERIC(5,2) NOT NULL DEFAULT 0,
      line_subtotal_vnd BIGINT NOT NULL DEFAULT 0,
      line_discount_vnd BIGINT NOT NULL DEFAULT 0,
      line_tax_vnd BIGINT NOT NULL DEFAULT 0,
      line_total_vnd BIGINT NOT NULL DEFAULT 0,
      sort_order INTEGER NOT NULL DEFAULT 0,
      created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
      CONSTRAINT uk_tenant_quote_items_tenant_id UNIQUE (tenant_id, id),
      CONSTRAINT fk_qitem_quote FOREIGN KEY (tenant_id, quote_id) REFERENCES tenant_quotes(tenant_id, id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_quote_items_quote ON tenant_quote_items(tenant_id, quote_id, sort_order ASC);

    CREATE TABLE IF NOT EXISTS tenant_sales_order_items (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
      sales_order_id UUID NOT NULL,
      product_id UUID,
      sku VARCHAR(80) NOT NULL DEFAULT '',
      name VARCHAR(255) NOT NULL,
      description TEXT,
      unit VARCHAR(40) NOT NULL DEFAULT 'Cái',
      qty NUMERIC(12,2) NOT NULL DEFAULT 1,
      fulfilled_qty NUMERIC(12,2) NOT NULL DEFAULT 0,
      unit_price_vnd BIGINT NOT NULL DEFAULT 0,
      discount_pct NUMERIC(5,2) NOT NULL DEFAULT 0,
      tax_pct NUMERIC(5,2) NOT NULL DEFAULT 0,
      line_subtotal_vnd BIGINT NOT NULL DEFAULT 0,
      line_discount_vnd BIGINT NOT NULL DEFAULT 0,
      line_tax_vnd BIGINT NOT NULL DEFAULT 0,
      line_total_vnd BIGINT NOT NULL DEFAULT 0,
      sort_order INTEGER NOT NULL DEFAULT 0,
      created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
      CONSTRAINT uk_tenant_so_items_tenant_id UNIQUE (tenant_id, id),
      CONSTRAINT fk_soitem_so FOREIGN KEY (tenant_id, sales_order_id) REFERENCES tenant_sales_orders(tenant_id, id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_so_items_so ON tenant_sales_order_items(tenant_id, sales_order_id, sort_order ASC);

    CREATE TABLE IF NOT EXISTS tenant_purchase_order_items (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
      purchase_order_id UUID NOT NULL,
      product_id UUID,
      sku VARCHAR(80) NOT NULL DEFAULT '',
      name VARCHAR(255) NOT NULL,
      unit VARCHAR(40) NOT NULL DEFAULT 'Cái',
      ordered_qty NUMERIC(12,2) NOT NULL DEFAULT 1,
      received_qty NUMERIC(12,2) NOT NULL DEFAULT 0,
      invoiced_qty NUMERIC(12,2) NOT NULL DEFAULT 0,
      unit_price_vnd BIGINT NOT NULL DEFAULT 0,
      discount_pct NUMERIC(5,2) NOT NULL DEFAULT 0,
      tax_pct NUMERIC(5,2) NOT NULL DEFAULT 0,
      line_total_vnd BIGINT NOT NULL DEFAULT 0,
      match_note TEXT,
      sort_order INTEGER NOT NULL DEFAULT 0,
      created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
      CONSTRAINT uk_tenant_po_items_tenant_id UNIQUE (tenant_id, id),
      CONSTRAINT fk_poitem_po FOREIGN KEY (tenant_id, purchase_order_id) REFERENCES tenant_purchase_orders(tenant_id, id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_po_items_po ON tenant_purchase_order_items(tenant_id, purchase_order_id, sort_order ASC);

    CREATE TABLE IF NOT EXISTS tenant_invoices (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
      invoice_code VARCHAR(60) NOT NULL,
      invoice_type VARCHAR(20) NOT NULL DEFAULT 'sales',
      sales_order_id UUID,
      purchase_order_id UUID,
      quote_id UUID,
      deposit_id UUID,
      company_id UUID,
      lead_id UUID,
      deal_id UUID,
      supplier_id UUID,
      branch_id UUID,
      customer_name VARCHAR(200) NOT NULL DEFAULT '',
      customer_tax_code VARCHAR(60),
      tax_code VARCHAR(50),
      customer_address TEXT,
      customer_email VARCHAR(255),
      status VARCHAR(30) NOT NULL DEFAULT 'issued',
      issue_date DATE NOT NULL DEFAULT CURRENT_DATE,
      issued_at TIMESTAMPTZ DEFAULT clock_timestamp(),
      due_date DATE,
      items_json JSONB NOT NULL DEFAULT '[]'::jsonb,
      subtotal_vnd BIGINT NOT NULL DEFAULT 0,
      discount_vnd BIGINT NOT NULL DEFAULT 0,
      tax_vnd BIGINT NOT NULL DEFAULT 0,
      shipping_fee_vnd BIGINT NOT NULL DEFAULT 0,
      total_vnd BIGINT NOT NULL DEFAULT 0,
      paid_vnd BIGINT NOT NULL DEFAULT 0,
      payment_method VARCHAR(40) NOT NULL DEFAULT 'bank_transfer',
      vat_invoice_no VARCHAR(80),
      vat_serial VARCHAR(40),
      notes TEXT,
      created_by UUID,
      created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
      CONSTRAINT uk_tenant_invoices_tenant_id UNIQUE (tenant_id, id),
      CONSTRAINT uk_tenant_invoices_code UNIQUE (tenant_id, invoice_code)
    );
    CREATE INDEX IF NOT EXISTS idx_tenant_invoices_status ON tenant_invoices(tenant_id, status, issue_date DESC);

    CREATE TABLE IF NOT EXISTS tenant_invoice_items (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
      invoice_id UUID NOT NULL,
      product_id UUID,
      sku VARCHAR(80) NOT NULL DEFAULT '',
      name VARCHAR(255) NOT NULL,
      description TEXT,
      unit VARCHAR(40) NOT NULL DEFAULT 'Cái',
      qty NUMERIC(12,2) NOT NULL DEFAULT 1,
      unit_price_vnd BIGINT NOT NULL DEFAULT 0,
      discount_pct NUMERIC(5,2) NOT NULL DEFAULT 0,
      tax_pct NUMERIC(5,2) NOT NULL DEFAULT 0,
      line_total_vnd BIGINT NOT NULL DEFAULT 0,
      sort_order INTEGER NOT NULL DEFAULT 0,
      created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
      CONSTRAINT uk_tenant_invoice_items_tenant_id UNIQUE (tenant_id, id),
      CONSTRAINT fk_invitem_inv FOREIGN KEY (tenant_id, invoice_id) REFERENCES tenant_invoices(tenant_id, id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_invoice_items_inv ON tenant_invoice_items(tenant_id, invoice_id, sort_order ASC);

    CREATE TABLE IF NOT EXISTS tenant_deposit_milestones (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
      deposit_id UUID NOT NULL,
      tranche_no INTEGER NOT NULL DEFAULT 1,
      name VARCHAR(200) NOT NULL,
      amount_vnd BIGINT NOT NULL DEFAULT 0,
      expected_pay_date DATE,
      paid_at TIMESTAMPTZ,
      status VARCHAR(30) NOT NULL DEFAULT 'pending',
      payment_method VARCHAR(40) NOT NULL DEFAULT 'bank_transfer',
      unc_url TEXT,
      reference_no VARCHAR(100),
      confirmed_by UUID,
      confirmed_by_name VARCHAR(150),
      note TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
      CONSTRAINT uk_tenant_dep_milestones_tenant_id UNIQUE (tenant_id, id),
      CONSTRAINT fk_depm_dep FOREIGN KEY (tenant_id, deposit_id) REFERENCES tenant_deposits(tenant_id, id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_deposit_milestones_dep ON tenant_deposit_milestones(tenant_id, deposit_id, tranche_no ASC);

    CREATE TABLE IF NOT EXISTS tenant_expenses (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
      expense_code VARCHAR(60) NOT NULL,
      title VARCHAR(255) NOT NULL,
      category VARCHAR(80) NOT NULL DEFAULT 'operating_expense',
      branch_id UUID,
      department_id UUID,
      project_id UUID,
      supplier_id UUID,
      vendor_name VARCHAR(200),
      vendor_tax_code VARCHAR(60),
      requester_user_id UUID,
      requester_name VARCHAR(150),
      approver_user_id UUID,
      approval_request_id UUID,
      approval_status VARCHAR(40) NOT NULL DEFAULT 'pending_approval',
      has_vat_invoice BOOLEAN NOT NULL DEFAULT false,
      is_vat_inclusive BOOLEAN NOT NULL DEFAULT true,
      vat_invoice_no VARCHAR(80),
      currency VARCHAR(10) NOT NULL DEFAULT 'VND',
      subtotal_vnd BIGINT NOT NULL DEFAULT 0,
      vat_amount_vnd BIGINT NOT NULL DEFAULT 0,
      total_amount_vnd BIGINT NOT NULL DEFAULT 0,
      payment_method VARCHAR(40) NOT NULL DEFAULT 'bank_transfer',
      bank_name VARCHAR(120),
      bank_bin VARCHAR(30),
      bank_account_no VARCHAR(80),
      bank_account_holder VARCHAR(150),
      expense_date DATE NOT NULL DEFAULT CURRENT_DATE,
      due_date DATE,
      paid_at TIMESTAMPTZ,
      refund_status VARCHAR(30) NOT NULL DEFAULT 'none',
      refund_amount_vnd BIGINT NOT NULL DEFAULT 0,
      refund_attachment_url TEXT,
      refunded_at TIMESTAMPTZ,
      line_items_json JSONB NOT NULL DEFAULT '[]'::jsonb,
      attachments_json JSONB NOT NULL DEFAULT '[]'::jsonb,
      watchers_json JSONB NOT NULL DEFAULT '[]'::jsonb,
      history_json JSONB NOT NULL DEFAULT '[]'::jsonb,
      notes TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
      CONSTRAINT uk_tenant_expenses_tenant_id UNIQUE (tenant_id, id),
      CONSTRAINT uk_tenant_expenses_code UNIQUE (tenant_id, expense_code)
    );
    CREATE INDEX IF NOT EXISTS idx_tenant_expenses_status ON tenant_expenses(tenant_id, approval_status, expense_date DESC);

    CREATE TABLE IF NOT EXISTS tenant_pos_sessions (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
      session_code VARCHAR(60) NOT NULL,
      branch_id UUID,
      warehouse_id UUID,
      cashier_user_id UUID,
      cashier_name VARCHAR(150),
      status VARCHAR(20) NOT NULL DEFAULT 'open',
      opening_cash_vnd BIGINT NOT NULL DEFAULT 0,
      cash_sales_vnd BIGINT NOT NULL DEFAULT 0,
      bank_sales_vnd BIGINT NOT NULL DEFAULT 0,
      card_sales_vnd BIGINT NOT NULL DEFAULT 0,
      expected_closing_cash_vnd BIGINT NOT NULL DEFAULT 0,
      actual_closing_cash_vnd BIGINT NOT NULL DEFAULT 0,
      variance_vnd BIGINT NOT NULL DEFAULT 0,
      orders_count INTEGER NOT NULL DEFAULT 0,
      opened_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
      closed_at TIMESTAMPTZ,
      closing_note TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
      CONSTRAINT uk_tenant_pos_sessions_tenant_id UNIQUE (tenant_id, id),
      CONSTRAINT uk_tenant_pos_sessions_code UNIQUE (tenant_id, session_code)
    );
    CREATE INDEX IF NOT EXISTS idx_pos_sessions_status ON tenant_pos_sessions(tenant_id, status, opened_at DESC);

    CREATE TABLE IF NOT EXISTS tenant_pos_orders (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
      pos_order_code VARCHAR(60) NOT NULL,
      session_id UUID,
      sales_order_id UUID,
      lead_id UUID,
      branch_id UUID,
      warehouse_id UUID,
      cashier_user_id UUID,
      customer_name VARCHAR(200) NOT NULL DEFAULT 'Khách lẻ POS',
      customer_phone VARCHAR(40),
      items_json JSONB NOT NULL DEFAULT '[]'::jsonb,
      subtotal_vnd BIGINT NOT NULL DEFAULT 0,
      discount_vnd BIGINT NOT NULL DEFAULT 0,
      voucher_code VARCHAR(80),
      voucher_discount_vnd BIGINT NOT NULL DEFAULT 0,
      shipping_fee_vnd BIGINT NOT NULL DEFAULT 0,
      tax_vnd BIGINT NOT NULL DEFAULT 0,
      total_vnd BIGINT NOT NULL DEFAULT 0,
      cash_paid_vnd BIGINT NOT NULL DEFAULT 0,
      bank_paid_vnd BIGINT NOT NULL DEFAULT 0,
      payment_method VARCHAR(40) NOT NULL DEFAULT 'cash',
      cogs_vnd BIGINT NOT NULL DEFAULT 0,
      status VARCHAR(30) NOT NULL DEFAULT 'completed',
      notes TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
      CONSTRAINT uk_tenant_pos_orders_tenant_id UNIQUE (tenant_id, id),
      CONSTRAINT uk_tenant_pos_orders_code UNIQUE (tenant_id, pos_order_code)
    );
    CREATE INDEX IF NOT EXISTS idx_pos_orders_session ON tenant_pos_orders(tenant_id, session_id, created_at DESC);

    CREATE TABLE IF NOT EXISTS tenant_inventory_sync_sheets (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
      sheet_name VARCHAR(150) NOT NULL DEFAULT 'Sheet1',
      spreadsheet_id VARCHAR(255) NOT NULL,
      webhook_token VARCHAR(120) NOT NULL,
      warehouse_id UUID,
      sync_interval_minutes INTEGER NOT NULL DEFAULT 15,
      is_active BOOLEAN NOT NULL DEFAULT true,
      sync_status VARCHAR(30) NOT NULL DEFAULT 'idle',
      last_sync_at TIMESTAMPTZ,
      last_error TEXT,
      mappings_json JSONB NOT NULL DEFAULT '[]'::jsonb,
      history_json JSONB NOT NULL DEFAULT '[]'::jsonb,
      created_by UUID,
      created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
      CONSTRAINT uk_tenant_inv_sync_sheets_tenant_id UNIQUE (tenant_id, id)
    );

    CREATE TABLE IF NOT EXISTS tenant_project_roster (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
      project_id UUID NOT NULL,
      user_id UUID NOT NULL,
      user_name VARCHAR(150) NOT NULL,
      role_in_project VARCHAR(30) NOT NULL DEFAULT 'member',
      can_edit_tasks BOOLEAN NOT NULL DEFAULT true,
      can_manage_roster BOOLEAN NOT NULL DEFAULT false,
      can_edit_whiteboard BOOLEAN NOT NULL DEFAULT true,
      allocation_pct INTEGER NOT NULL DEFAULT 100,
      added_by UUID,
      created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
      CONSTRAINT uk_tenant_project_roster_tenant_id UNIQUE (tenant_id, id),
      CONSTRAINT uk_project_roster_member UNIQUE (tenant_id, project_id, user_id),
      CONSTRAINT fk_proster_proj FOREIGN KEY (tenant_id, project_id) REFERENCES tenant_projects(tenant_id, id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS tenant_task_dependencies (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
      project_id UUID,
      task_id UUID NOT NULL,
      predecessor_task_id UUID,
      depends_on_task_id UUID,
      dependency_type VARCHAR(30) NOT NULL DEFAULT 'FS',
      lag_days INTEGER NOT NULL DEFAULT 0,
      note TEXT,
      created_by UUID,
      created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
      CONSTRAINT uk_tenant_task_deps_tenant_id UNIQUE (tenant_id, id),
      CONSTRAINT uk_task_dep_pair UNIQUE (tenant_id, task_id, predecessor_task_id),
      CONSTRAINT fk_tdep_task FOREIGN KEY (tenant_id, task_id) REFERENCES tenant_tasks(tenant_id, id) ON DELETE CASCADE,
      CONSTRAINT fk_tdep_pred FOREIGN KEY (tenant_id, predecessor_task_id) REFERENCES tenant_tasks(tenant_id, id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS tenant_task_comments (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
      task_id UUID NOT NULL,
      author_user_id UUID,
      author_name VARCHAR(150) NOT NULL DEFAULT 'Thành viên',
      content TEXT NOT NULL,
      mentions_json JSONB NOT NULL DEFAULT '[]'::jsonb,
      attachments_json JSONB NOT NULL DEFAULT '[]'::jsonb,
      edit_history_json JSONB NOT NULL DEFAULT '[]'::jsonb,
      created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
      CONSTRAINT uk_tenant_task_comments_tenant_id UNIQUE (tenant_id, id),
      CONSTRAINT fk_tcomm_task FOREIGN KEY (tenant_id, task_id) REFERENCES tenant_tasks(tenant_id, id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_task_comments_task ON tenant_task_comments(tenant_id, task_id, created_at ASC);

    CREATE TABLE IF NOT EXISTS tenant_task_attachments (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
      task_id UUID NOT NULL,
      file_name VARCHAR(255) NOT NULL,
      file_url TEXT NOT NULL,
      mime_type VARCHAR(120) NOT NULL DEFAULT 'application/octet-stream',
      size_bytes BIGINT NOT NULL DEFAULT 0,
      cloud_file_id UUID,
      uploaded_by UUID,
      uploaded_by_name VARCHAR(150),
      created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
      CONSTRAINT uk_tenant_task_attachments_tenant_id UNIQUE (tenant_id, id),
      CONSTRAINT fk_tatt_task FOREIGN KEY (tenant_id, task_id) REFERENCES tenant_tasks(tenant_id, id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS tenant_task_whiteboard_snapshots (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
      project_id UUID NOT NULL,
      snapshot_name VARCHAR(200) NOT NULL,
      version_no INTEGER NOT NULL DEFAULT 1,
      snapshot_json JSONB NOT NULL DEFAULT '[]'::jsonb,
      thumbnail_note TEXT,
      created_by UUID,
      created_by_name VARCHAR(150),
      created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
      CONSTRAINT uk_tenant_wb_snapshots_tenant_id UNIQUE (tenant_id, id),
      CONSTRAINT fk_wbsnap_proj FOREIGN KEY (tenant_id, project_id) REFERENCES tenant_projects(tenant_id, id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_wb_snapshots_proj ON tenant_task_whiteboard_snapshots(tenant_id, project_id, created_at DESC);

    CREATE TABLE IF NOT EXISTS tenant_cloud_file_categories (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
      category_key VARCHAR(80) NOT NULL,
      label VARCHAR(150) NOT NULL,
      icon_type VARCHAR(40) NOT NULL DEFAULT 'folder',
      visibility VARCHAR(30) NOT NULL DEFAULT 'company',
      allowed_department_ids JSONB NOT NULL DEFAULT '[]'::jsonb,
      allowed_role_ids JSONB NOT NULL DEFAULT '[]'::jsonb,
      sort_order INTEGER NOT NULL DEFAULT 0,
      created_by UUID,
      created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
      CONSTRAINT uk_tenant_cloud_cats_tenant_id UNIQUE (tenant_id, id),
      CONSTRAINT uk_tenant_cloud_cat_key UNIQUE (tenant_id, category_key)
    );

    CREATE TABLE IF NOT EXISTS tenant_edu_announcements (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
      announcement_type VARCHAR(40) NOT NULL DEFAULT 'subject_announcement',
      course_id UUID,
      class_id UUID,
      subject_key VARCHAR(80),
      title VARCHAR(255) NOT NULL,
      content_html TEXT NOT NULL,
      channels_json JSONB NOT NULL DEFAULT '["email"]'::jsonb,
      recipients_json JSONB NOT NULL DEFAULT '[]'::jsonb,
      sent_count INTEGER NOT NULL DEFAULT 0,
      status VARCHAR(30) NOT NULL DEFAULT 'sent',
      created_by UUID,
      created_by_name VARCHAR(150),
      created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
      CONSTRAINT uk_tenant_edu_announcements_tenant_id UNIQUE (tenant_id, id)
    );

    -- ========================================================================
    -- ENABLE & FORCE ROW LEVEL SECURITY + TENANT POLICIES + autodata_app GRANTS
    -- ========================================================================
    DO $$
    DECLARE
      tbl TEXT;
      pol TEXT;
    BEGIN
      FOREACH tbl IN ARRAY ARRAY[
        'tenant_projects', 'tenant_tasks', 'tenant_pomodoro_sessions', 'tenant_workflow_task_templates',
        'tenant_helpdesk_tickets', 'tenant_helpdesk_comments',
        'tenant_workchat_channels', 'tenant_workchat_members', 'tenant_workchat_messages', 'tenant_workchat_presence',
        'tenant_feed_posts', 'tenant_feed_comments', 'tenant_kudos_recognitions',
        'tenant_b2b_companies', 'tenant_deals', 'tenant_quotes', 'tenant_sales_orders',
        'tenant_deposits', 'tenant_purchase_orders', 'tenant_finance_transactions',
        'tenant_products', 'tenant_suppliers', 'tenant_warehouses',
        'tenant_inventory_batches', 'tenant_stock_movements', 'tenant_fixed_assets',
        'tenant_cloud_folders', 'tenant_cloud_files', 'tenant_ocr_extractions',
        'tenant_edu_courses', 'tenant_edu_classes', 'tenant_edu_schedules',
        'tenant_edu_enrollments', 'tenant_edu_attendance_grades',
        'tenant_quote_items', 'tenant_sales_order_items', 'tenant_purchase_order_items',
        'tenant_invoices', 'tenant_invoice_items', 'tenant_deposit_milestones',
        'tenant_expenses', 'tenant_pos_sessions', 'tenant_pos_orders',
        'tenant_inventory_sync_sheets', 'tenant_project_roster', 'tenant_task_dependencies',
        'tenant_task_comments', 'tenant_task_attachments', 'tenant_task_whiteboard_snapshots',
        'tenant_cloud_file_categories', 'tenant_edu_announcements'
      ]
      LOOP
        EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', tbl);
        EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', tbl);
        pol := 'tenant_isolation_' || tbl;
        IF NOT EXISTS (
          SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = tbl AND policyname = pol
        ) THEN
          EXECUTE format(
            'CREATE POLICY %I ON %I USING (tenant_id = NULLIF(current_setting(''app.current_tenant_id'', true), '''')::uuid) WITH CHECK (tenant_id = NULLIF(current_setting(''app.current_tenant_id'', true), '''')::uuid)',
            pol, tbl
          );
        END IF;
      END LOOP;
    END $$;

    DO $$
    DECLARE
      tbl TEXT;
    BEGIN
      IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'autodata_app') THEN
        FOREACH tbl IN ARRAY ARRAY[
          'tenant_projects', 'tenant_tasks', 'tenant_pomodoro_sessions', 'tenant_workflow_task_templates',
          'tenant_helpdesk_tickets', 'tenant_helpdesk_comments',
          'tenant_workchat_channels', 'tenant_workchat_members', 'tenant_workchat_messages', 'tenant_workchat_presence',
          'tenant_feed_posts', 'tenant_feed_comments', 'tenant_kudos_recognitions',
          'tenant_b2b_companies', 'tenant_deals', 'tenant_quotes', 'tenant_sales_orders',
          'tenant_deposits', 'tenant_purchase_orders', 'tenant_finance_transactions',
          'tenant_products', 'tenant_suppliers', 'tenant_warehouses',
          'tenant_inventory_batches', 'tenant_stock_movements', 'tenant_fixed_assets',
          'tenant_cloud_folders', 'tenant_cloud_files', 'tenant_ocr_extractions',
          'tenant_edu_courses', 'tenant_edu_classes', 'tenant_edu_schedules',
          'tenant_edu_enrollments', 'tenant_edu_attendance_grades',
          'tenant_quote_items', 'tenant_sales_order_items', 'tenant_purchase_order_items',
          'tenant_invoices', 'tenant_invoice_items', 'tenant_deposit_milestones',
          'tenant_expenses', 'tenant_pos_sessions', 'tenant_pos_orders',
          'tenant_inventory_sync_sheets', 'tenant_project_roster', 'tenant_task_dependencies',
          'tenant_task_comments', 'tenant_task_attachments', 'tenant_task_whiteboard_snapshots',
          'tenant_cloud_file_categories', 'tenant_edu_announcements'
        ]
        LOOP
          EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON %I TO autodata_app', tbl);
        END LOOP;
      END IF;
    EXCEPTION
      WHEN insufficient_privilege THEN
        NULL;
    END $$;
  `;

  if (client.exec) {
    await client.exec(pgDdl);
  } else {
    await client.query(pgDdl);
  }
}

async function runErpOpsMariaDbSchema(client: DbClient): Promise<void> {
  const mariaTables = [
    `CREATE TABLE IF NOT EXISTS tenant_projects (
      id VARCHAR(36) NOT NULL PRIMARY KEY DEFAULT (UUID()),
      tenant_id VARCHAR(36) NOT NULL,
      code VARCHAR(50) NOT NULL,
      name VARCHAR(200) NOT NULL,
      description TEXT NULL,
      status VARCHAR(30) NOT NULL DEFAULT 'active',
      priority VARCHAR(20) NOT NULL DEFAULT 'medium',
      owner_user_id VARCHAR(36) NULL,
      department_id VARCHAR(36) NULL,
      branch_id VARCHAR(36) NULL,
      start_date DATE NULL,
      due_date DATE NULL,
      budget_vnd BIGINT NOT NULL DEFAULT 0,
      progress_pct INT NOT NULL DEFAULT 0,
      task_columns_json JSON NULL,
      whiteboard_json JSON NULL,
      metadata JSON NULL,
      created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
      updated_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
      CONSTRAINT uk_tenant_projects_tenant_id UNIQUE (tenant_id, id),
      CONSTRAINT uk_tenant_projects_code UNIQUE (tenant_id, code)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
    `CREATE TABLE IF NOT EXISTS tenant_workflow_task_templates (
      id VARCHAR(36) NOT NULL PRIMARY KEY DEFAULT (UUID()),
      tenant_id VARCHAR(36) NOT NULL,
      pipeline_id VARCHAR(36) NULL,
      stage_id VARCHAR(36) NULL,
      stage_key VARCHAR(64) NULL,
      project_id VARCHAR(36) NULL,
      title_template VARCHAR(255) NOT NULL,
      description_template TEXT NULL,
      priority VARCHAR(20) NOT NULL DEFAULT 'medium',
      due_offset_hours INT NOT NULL DEFAULT 24,
      default_assignee_id VARCHAR(36) NULL,
      checklist_json JSON NULL,
      sort_order INT NOT NULL DEFAULT 0,
      is_active TINYINT(1) NOT NULL DEFAULT 1,
      created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
      updated_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
      CONSTRAINT uk_tenant_workflow_task_templates_tenant_id UNIQUE (tenant_id, id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
    `CREATE TABLE IF NOT EXISTS tenant_tasks (
      id VARCHAR(36) NOT NULL PRIMARY KEY DEFAULT (UUID()),
      tenant_id VARCHAR(36) NOT NULL,
      project_id VARCHAR(36) NULL,
      lead_id VARCHAR(36) NULL,
      title VARCHAR(255) NOT NULL,
      description TEXT NULL,
      status_key VARCHAR(50) NOT NULL DEFAULT 'todo',
      priority VARCHAR(20) NOT NULL DEFAULT 'medium',
      assignee_user_id VARCHAR(36) NULL,
      reporter_user_id VARCHAR(36) NULL,
      start_date DATETIME(6) NULL,
      due_date DATETIME(6) NULL,
      estimated_minutes INT NOT NULL DEFAULT 60,
      logged_minutes INT NOT NULL DEFAULT 0,
      progress_pct INT NOT NULL DEFAULT 0,
      sort_order INT NOT NULL DEFAULT 0,
      checklist_json JSON NULL,
      dependencies_json JSON NULL,
      source_template_id VARCHAR(36) NULL,
      trigger_stage_id VARCHAR(36) NULL,
      completed_at DATETIME(6) NULL,
      created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
      updated_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
      CONSTRAINT uk_tenant_tasks_tenant_id UNIQUE (tenant_id, id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
    `CREATE TABLE IF NOT EXISTS tenant_pomodoro_sessions (
      id VARCHAR(36) NOT NULL PRIMARY KEY DEFAULT (UUID()),
      tenant_id VARCHAR(36) NOT NULL,
      task_id VARCHAR(36) NULL,
      user_id VARCHAR(36) NOT NULL,
      duration_minutes INT NOT NULL DEFAULT 25,
      mode VARCHAR(20) NOT NULL DEFAULT 'focus',
      note TEXT NULL,
      started_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
      completed_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
      created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
      CONSTRAINT uk_tenant_pomodoro_sessions_tenant_id UNIQUE (tenant_id, id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
    `CREATE TABLE IF NOT EXISTS tenant_helpdesk_tickets (
      id VARCHAR(36) NOT NULL PRIMARY KEY DEFAULT (UUID()),
      tenant_id VARCHAR(36) NOT NULL,
      ticket_code VARCHAR(40) NOT NULL,
      subject VARCHAR(255) NOT NULL,
      description TEXT NULL,
      category VARCHAR(60) NOT NULL DEFAULT 'customer_support',
      priority VARCHAR(20) NOT NULL DEFAULT 'medium',
      status VARCHAR(30) NOT NULL DEFAULT 'open',
      lead_id VARCHAR(36) NULL,
      customer_name VARCHAR(150) NULL,
      customer_contact VARCHAR(150) NULL,
      assignee_user_id VARCHAR(36) NULL,
      created_by_user_id VARCHAR(36) NULL,
      sla_response_hours DECIMAL(8,2) NOT NULL DEFAULT 2,
      sla_resolution_hours DECIMAL(8,2) NOT NULL DEFAULT 24,
      response_due_at DATETIME(6) NOT NULL,
      resolution_due_at DATETIME(6) NOT NULL,
      first_responded_at DATETIME(6) NULL,
      resolved_at DATETIME(6) NULL,
      sla_breached TINYINT(1) NOT NULL DEFAULT 0,
      attachments_json JSON NULL,
      created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
      updated_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
      CONSTRAINT uk_tenant_helpdesk_tickets_tenant_id UNIQUE (tenant_id, id),
      CONSTRAINT uk_tenant_helpdesk_code UNIQUE (tenant_id, ticket_code)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
    `CREATE TABLE IF NOT EXISTS tenant_helpdesk_comments (
      id VARCHAR(36) NOT NULL PRIMARY KEY DEFAULT (UUID()),
      tenant_id VARCHAR(36) NOT NULL,
      ticket_id VARCHAR(36) NOT NULL,
      author_user_id VARCHAR(36) NULL,
      author_name VARCHAR(150) NOT NULL,
      content TEXT NOT NULL,
      is_internal_note TINYINT(1) NOT NULL DEFAULT 0,
      created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
      CONSTRAINT uk_tenant_helpdesk_comments_tenant_id UNIQUE (tenant_id, id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
    `CREATE TABLE IF NOT EXISTS tenant_workchat_channels (
      id VARCHAR(36) NOT NULL PRIMARY KEY DEFAULT (UUID()),
      tenant_id VARCHAR(36) NOT NULL,
      name VARCHAR(150) NOT NULL,
      channel_type VARCHAR(30) NOT NULL DEFAULT 'group',
      topic TEXT NULL,
      department_id VARCHAR(36) NULL,
      project_id VARCHAR(36) NULL,
      created_by VARCHAR(36) NULL,
      is_archived TINYINT(1) NOT NULL DEFAULT 0,
      last_message_at DATETIME(6) NULL,
      last_message_preview VARCHAR(255) NULL,
      created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
      updated_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
      CONSTRAINT uk_tenant_workchat_channels_tenant_id UNIQUE (tenant_id, id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
    `CREATE TABLE IF NOT EXISTS tenant_workchat_members (
      id VARCHAR(36) NOT NULL PRIMARY KEY DEFAULT (UUID()),
      tenant_id VARCHAR(36) NOT NULL,
      channel_id VARCHAR(36) NOT NULL,
      user_id VARCHAR(36) NOT NULL,
      member_role VARCHAR(20) NOT NULL DEFAULT 'member',
      last_read_at DATETIME(6) NULL,
      joined_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
      CONSTRAINT uk_tenant_workchat_members_tenant_id UNIQUE (tenant_id, id),
      CONSTRAINT uk_workchat_channel_member UNIQUE (tenant_id, channel_id, user_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
    `CREATE TABLE IF NOT EXISTS tenant_workchat_messages (
      id VARCHAR(36) NOT NULL PRIMARY KEY DEFAULT (UUID()),
      tenant_id VARCHAR(36) NOT NULL,
      channel_id VARCHAR(36) NOT NULL,
      sender_user_id VARCHAR(36) NULL,
      sender_name VARCHAR(150) NOT NULL,
      parent_message_id VARCHAR(36) NULL,
      message_type VARCHAR(30) NOT NULL DEFAULT 'text',
      content TEXT NOT NULL,
      sticker_pack_id VARCHAR(50) NULL,
      sticker_id VARCHAR(100) NULL,
      attachments_json JSON NULL,
      reactions_json JSON NULL,
      is_pinned TINYINT(1) NOT NULL DEFAULT 0,
      is_deleted TINYINT(1) NOT NULL DEFAULT 0,
      created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
      updated_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
      CONSTRAINT uk_tenant_workchat_messages_tenant_id UNIQUE (tenant_id, id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
    `CREATE TABLE IF NOT EXISTS tenant_workchat_presence (
      id VARCHAR(36) NOT NULL PRIMARY KEY DEFAULT (UUID()),
      tenant_id VARCHAR(36) NOT NULL,
      user_id VARCHAR(36) NOT NULL,
      status VARCHAR(20) NOT NULL DEFAULT 'online',
      status_text VARCHAR(120) NULL,
      last_seen_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
      updated_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
      CONSTRAINT uk_tenant_workchat_presence_tenant_id UNIQUE (tenant_id, id),
      CONSTRAINT uk_workchat_presence_user UNIQUE (tenant_id, user_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
    `CREATE TABLE IF NOT EXISTS tenant_feed_posts (
      id VARCHAR(36) NOT NULL PRIMARY KEY DEFAULT (UUID()),
      tenant_id VARCHAR(36) NOT NULL,
      author_user_id VARCHAR(36) NULL,
      author_name VARCHAR(150) NOT NULL,
      title VARCHAR(255) NULL,
      content TEXT NOT NULL,
      post_type VARCHAR(30) NOT NULL DEFAULT 'announcement',
      branch_id VARCHAR(36) NULL,
      department_id VARCHAR(36) NULL,
      is_pinned TINYINT(1) NOT NULL DEFAULT 0,
      attachments_json JSON NULL,
      reactions_json JSON NULL,
      likes_count INT NOT NULL DEFAULT 0,
      comments_count INT NOT NULL DEFAULT 0,
      created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
      updated_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
      CONSTRAINT uk_tenant_feed_posts_tenant_id UNIQUE (tenant_id, id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
    `CREATE TABLE IF NOT EXISTS tenant_feed_comments (
      id VARCHAR(36) NOT NULL PRIMARY KEY DEFAULT (UUID()),
      tenant_id VARCHAR(36) NOT NULL,
      post_id VARCHAR(36) NOT NULL,
      author_user_id VARCHAR(36) NULL,
      author_name VARCHAR(150) NOT NULL,
      content TEXT NOT NULL,
      created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
      CONSTRAINT uk_tenant_feed_comments_tenant_id UNIQUE (tenant_id, id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
    `CREATE TABLE IF NOT EXISTS tenant_kudos_recognitions (
      id VARCHAR(36) NOT NULL PRIMARY KEY DEFAULT (UUID()),
      tenant_id VARCHAR(36) NOT NULL,
      sender_user_id VARCHAR(36) NULL,
      sender_name VARCHAR(150) NOT NULL,
      recipient_user_id VARCHAR(36) NOT NULL,
      recipient_name VARCHAR(150) NOT NULL,
      badge_key VARCHAR(50) NOT NULL DEFAULT 'top_performer',
      badge_title VARCHAR(120) NOT NULL DEFAULT 'Chiến binh Xuất sắc',
      points INT NOT NULL DEFAULT 10,
      message TEXT NOT NULL,
      created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
      CONSTRAINT uk_tenant_kudos_recognitions_tenant_id UNIQUE (tenant_id, id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
    `CREATE TABLE IF NOT EXISTS tenant_b2b_companies (
      id VARCHAR(36) NOT NULL PRIMARY KEY DEFAULT (UUID()),
      tenant_id VARCHAR(36) NOT NULL,
      code VARCHAR(50) NOT NULL,
      name VARCHAR(255) NOT NULL,
      tax_code VARCHAR(50) NULL,
      industry VARCHAR(100) NULL,
      company_size VARCHAR(50) NULL,
      website VARCHAR(255) NULL,
      billing_address TEXT NULL,
      phone VARCHAR(40) NULL,
      email VARCHAR(255) NULL,
      representative_name VARCHAR(150) NULL,
      owner_user_id VARCHAR(36) NULL,
      primary_lead_id VARCHAR(36) NULL,
      contacts_json JSON NULL,
      tier VARCHAR(30) NOT NULL DEFAULT 'standard',
      notes TEXT NULL,
      created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
      updated_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
      CONSTRAINT uk_tenant_b2b_companies_tenant_id UNIQUE (tenant_id, id),
      CONSTRAINT uk_tenant_b2b_companies_code UNIQUE (tenant_id, code)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
    `CREATE TABLE IF NOT EXISTS tenant_deals (
      id VARCHAR(36) NOT NULL PRIMARY KEY DEFAULT (UUID()),
      tenant_id VARCHAR(36) NOT NULL,
      deal_code VARCHAR(50) NOT NULL,
      title VARCHAR(255) NOT NULL,
      company_id VARCHAR(36) NULL,
      lead_id VARCHAR(36) NULL,
      owner_user_id VARCHAR(36) NULL,
      stage VARCHAR(40) NOT NULL DEFAULT 'qualification',
      amount_vnd BIGINT NOT NULL DEFAULT 0,
      probability INT NOT NULL DEFAULT 30,
      expected_close_date DATE NULL,
      actual_close_date DATE NULL,
      lost_reason TEXT NULL,
      notes TEXT NULL,
      metadata JSON NULL,
      created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
      updated_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
      CONSTRAINT uk_tenant_deals_tenant_id UNIQUE (tenant_id, id),
      CONSTRAINT uk_tenant_deals_code UNIQUE (tenant_id, deal_code)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
    `CREATE TABLE IF NOT EXISTS tenant_suppliers (
      id VARCHAR(36) NOT NULL PRIMARY KEY DEFAULT (UUID()),
      tenant_id VARCHAR(36) NOT NULL,
      code VARCHAR(50) NOT NULL,
      name VARCHAR(255) NOT NULL,
      tax_code VARCHAR(50) NULL,
      contact_name VARCHAR(150) NULL,
      phone VARCHAR(40) NULL,
      email VARCHAR(255) NULL,
      address TEXT NULL,
      payment_terms VARCHAR(100) NULL,
      rating INT NOT NULL DEFAULT 5,
      is_active TINYINT(1) NOT NULL DEFAULT 1,
      created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
      updated_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
      CONSTRAINT uk_tenant_suppliers_tenant_id UNIQUE (tenant_id, id),
      CONSTRAINT uk_tenant_suppliers_code UNIQUE (tenant_id, code)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
    `CREATE TABLE IF NOT EXISTS tenant_warehouses (
      id VARCHAR(36) NOT NULL PRIMARY KEY DEFAULT (UUID()),
      tenant_id VARCHAR(36) NOT NULL,
      code VARCHAR(50) NOT NULL,
      name VARCHAR(150) NOT NULL,
      branch_id VARCHAR(36) NULL,
      address TEXT NULL,
      manager_user_id VARCHAR(36) NULL,
      is_default TINYINT(1) NOT NULL DEFAULT 0,
      is_active TINYINT(1) NOT NULL DEFAULT 1,
      created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
      updated_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
      CONSTRAINT uk_tenant_warehouses_tenant_id UNIQUE (tenant_id, id),
      CONSTRAINT uk_tenant_warehouses_code UNIQUE (tenant_id, code)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
    `CREATE TABLE IF NOT EXISTS tenant_products (
      id VARCHAR(36) NOT NULL PRIMARY KEY DEFAULT (UUID()),
      tenant_id VARCHAR(36) NOT NULL,
      sku VARCHAR(80) NOT NULL,
      barcode VARCHAR(80) NULL,
      name VARCHAR(255) NOT NULL,
      category VARCHAR(100) NOT NULL DEFAULT 'general',
      unit VARCHAR(40) NOT NULL DEFAULT 'Cái',
      product_type VARCHAR(20) NOT NULL DEFAULT 'goods',
      sale_price_vnd BIGINT NOT NULL DEFAULT 0,
      default_cost_vnd BIGINT NOT NULL DEFAULT 0,
      tax_rate_pct DECIMAL(5,2) NOT NULL DEFAULT 0,
      min_stock_alert INT NOT NULL DEFAULT 5,
      cached_stock_qty INT NOT NULL DEFAULT 0,
      is_active TINYINT(1) NOT NULL DEFAULT 1,
      metadata JSON NULL,
      created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
      updated_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
      CONSTRAINT uk_tenant_products_tenant_id UNIQUE (tenant_id, id),
      CONSTRAINT uk_tenant_products_sku UNIQUE (tenant_id, sku)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
    `CREATE TABLE IF NOT EXISTS tenant_quotes (
      id VARCHAR(36) NOT NULL PRIMARY KEY DEFAULT (UUID()),
      tenant_id VARCHAR(36) NOT NULL,
      quote_code VARCHAR(50) NOT NULL,
      title VARCHAR(255) NOT NULL,
      company_id VARCHAR(36) NULL,
      lead_id VARCHAR(36) NULL,
      deal_id VARCHAR(36) NULL,
      branch_id VARCHAR(36) NULL,
      status VARCHAR(30) NOT NULL DEFAULT 'draft',
      items_json JSON NULL,
      subtotal_vnd BIGINT NOT NULL DEFAULT 0,
      discount_vnd BIGINT NOT NULL DEFAULT 0,
      tax_vnd BIGINT NOT NULL DEFAULT 0,
      total_vnd BIGINT NOT NULL DEFAULT 0,
      valid_until DATE NULL,
      terms_text TEXT NULL,
      converted_order_id VARCHAR(36) NULL,
      created_by VARCHAR(36) NULL,
      created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
      updated_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
      CONSTRAINT uk_tenant_quotes_tenant_id UNIQUE (tenant_id, id),
      CONSTRAINT uk_tenant_quotes_code UNIQUE (tenant_id, quote_code)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
    `CREATE TABLE IF NOT EXISTS tenant_sales_orders (
      id VARCHAR(36) NOT NULL PRIMARY KEY DEFAULT (UUID()),
      tenant_id VARCHAR(36) NOT NULL,
      order_code VARCHAR(50) NOT NULL,
      quote_id VARCHAR(36) NULL,
      company_id VARCHAR(36) NULL,
      lead_id VARCHAR(36) NULL,
      deal_id VARCHAR(36) NULL,
      branch_id VARCHAR(36) NULL,
      warehouse_id VARCHAR(36) NULL,
      sales_rep_id VARCHAR(36) NULL,
      customer_name VARCHAR(200) NOT NULL,
      status VARCHAR(30) NOT NULL DEFAULT 'confirmed',
      payment_status VARCHAR(30) NOT NULL DEFAULT 'unpaid',
      fulfillment_status VARCHAR(30) NOT NULL DEFAULT 'pending',
      items_json JSON NULL,
      subtotal_vnd BIGINT NOT NULL DEFAULT 0,
      discount_vnd BIGINT NOT NULL DEFAULT 0,
      tax_vnd BIGINT NOT NULL DEFAULT 0,
      total_vnd BIGINT NOT NULL DEFAULT 0,
      paid_vnd BIGINT NOT NULL DEFAULT 0,
      attributed_revenue_vnd BIGINT NOT NULL DEFAULT 0,
      cogs_vnd BIGINT NOT NULL DEFAULT 0,
      notes TEXT NULL,
      completed_at DATETIME(6) NULL,
      created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
      updated_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
      CONSTRAINT uk_tenant_sales_orders_tenant_id UNIQUE (tenant_id, id),
      CONSTRAINT uk_tenant_sales_orders_code UNIQUE (tenant_id, order_code)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
    `CREATE TABLE IF NOT EXISTS tenant_deposits (
      id VARCHAR(36) NOT NULL PRIMARY KEY DEFAULT (UUID()),
      tenant_id VARCHAR(36) NOT NULL,
      deposit_code VARCHAR(50) NOT NULL,
      lead_id VARCHAR(36) NULL,
      company_id VARCHAR(36) NULL,
      deal_id VARCHAR(36) NULL,
      sales_order_id VARCHAR(36) NULL,
      customer_name VARCHAR(200) NOT NULL,
      amount_vnd BIGINT NOT NULL DEFAULT 0,
      payment_method VARCHAR(40) NOT NULL DEFAULT 'bank_transfer',
      status VARCHAR(30) NOT NULL DEFAULT 'received',
      reference_no VARCHAR(100) NULL,
      notes TEXT NULL,
      received_by VARCHAR(36) NULL,
      received_at DATETIME(6) NULL,
      created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
      updated_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
      CONSTRAINT uk_tenant_deposits_tenant_id UNIQUE (tenant_id, id),
      CONSTRAINT uk_tenant_deposits_code UNIQUE (tenant_id, deposit_code)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
    `CREATE TABLE IF NOT EXISTS tenant_purchase_orders (
      id VARCHAR(36) NOT NULL PRIMARY KEY DEFAULT (UUID()),
      tenant_id VARCHAR(36) NOT NULL,
      po_code VARCHAR(50) NOT NULL,
      supplier_id VARCHAR(36) NULL,
      warehouse_id VARCHAR(36) NULL,
      supplier_name VARCHAR(200) NOT NULL,
      status VARCHAR(30) NOT NULL DEFAULT 'draft',
      items_json JSON NULL,
      total_vnd BIGINT NOT NULL DEFAULT 0,
      expected_date DATE NULL,
      received_at DATETIME(6) NULL,
      notes TEXT NULL,
      created_by VARCHAR(36) NULL,
      created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
      updated_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
      CONSTRAINT uk_tenant_purchase_orders_tenant_id UNIQUE (tenant_id, id),
      CONSTRAINT uk_tenant_po_code UNIQUE (tenant_id, po_code)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
    `CREATE TABLE IF NOT EXISTS tenant_finance_transactions (
      id VARCHAR(36) NOT NULL PRIMARY KEY DEFAULT (UUID()),
      tenant_id VARCHAR(36) NOT NULL,
      tx_code VARCHAR(50) NOT NULL,
      tx_type VARCHAR(20) NOT NULL,
      category VARCHAR(80) NOT NULL DEFAULT 'sales_revenue',
      amount_vnd BIGINT NOT NULL DEFAULT 0,
      payment_method VARCHAR(40) NOT NULL DEFAULT 'bank_transfer',
      status VARCHAR(30) NOT NULL DEFAULT 'completed',
      counterparty_name VARCHAR(200) NULL,
      counterparty_tax_code VARCHAR(50) NULL,
      branch_id VARCHAR(36) NULL,
      lead_id VARCHAR(36) NULL,
      company_id VARCHAR(36) NULL,
      sales_order_id VARCHAR(36) NULL,
      purchase_order_id VARCHAR(36) NULL,
      deposit_id VARCHAR(36) NULL,
      tx_date DATE NOT NULL,
      description TEXT NULL,
      created_by VARCHAR(36) NULL,
      created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
      updated_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
      CONSTRAINT uk_tenant_finance_transactions_tenant_id UNIQUE (tenant_id, id),
      CONSTRAINT uk_tenant_fin_tx_code UNIQUE (tenant_id, tx_code)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
    `CREATE TABLE IF NOT EXISTS tenant_inventory_batches (
      id VARCHAR(36) NOT NULL PRIMARY KEY DEFAULT (UUID()),
      tenant_id VARCHAR(36) NOT NULL,
      product_id VARCHAR(36) NOT NULL,
      warehouse_id VARCHAR(36) NULL,
      supplier_id VARCHAR(36) NULL,
      purchase_order_id VARCHAR(36) NULL,
      batch_code VARCHAR(80) NOT NULL,
      initial_qty INT NOT NULL,
      remaining_qty INT NOT NULL,
      unit_cost_vnd BIGINT NOT NULL DEFAULT 0,
      received_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
      expiry_date DATE NULL,
      status VARCHAR(20) NOT NULL DEFAULT 'active',
      notes TEXT NULL,
      created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
      updated_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
      CONSTRAINT uk_tenant_inventory_batches_tenant_id UNIQUE (tenant_id, id),
      CONSTRAINT uk_tenant_inv_batch_code UNIQUE (tenant_id, batch_code)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
    `CREATE TABLE IF NOT EXISTS tenant_stock_movements (
      id VARCHAR(36) NOT NULL PRIMARY KEY DEFAULT (UUID()),
      tenant_id VARCHAR(36) NOT NULL,
      product_id VARCHAR(36) NOT NULL,
      batch_id VARCHAR(36) NULL,
      warehouse_id VARCHAR(36) NULL,
      movement_type VARCHAR(30) NOT NULL,
      qty_delta INT NOT NULL,
      unit_cost_vnd BIGINT NOT NULL DEFAULT 0,
      total_cost_vnd BIGINT NOT NULL DEFAULT 0,
      reference_type VARCHAR(40) NULL,
      reference_id VARCHAR(80) NULL,
      note TEXT NULL,
      created_by VARCHAR(36) NULL,
      created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
      CONSTRAINT uk_tenant_stock_movements_tenant_id UNIQUE (tenant_id, id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
    `CREATE TABLE IF NOT EXISTS tenant_fixed_assets (
      id VARCHAR(36) NOT NULL PRIMARY KEY DEFAULT (UUID()),
      tenant_id VARCHAR(36) NOT NULL,
      asset_code VARCHAR(60) NOT NULL,
      name VARCHAR(255) NOT NULL,
      category VARCHAR(80) NOT NULL DEFAULT 'IT Equipment',
      serial_number VARCHAR(100) NULL,
      branch_id VARCHAR(36) NULL,
      department_id VARCHAR(36) NULL,
      assigned_user_id VARCHAR(36) NULL,
      purchase_date DATE NOT NULL,
      purchase_cost_vnd BIGINT NOT NULL DEFAULT 0,
      salvage_value_vnd BIGINT NOT NULL DEFAULT 0,
      useful_life_months INT NOT NULL DEFAULT 36,
      status VARCHAR(30) NOT NULL DEFAULT 'in_use',
      notes TEXT NULL,
      created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
      updated_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
      CONSTRAINT uk_tenant_fixed_assets_tenant_id UNIQUE (tenant_id, id),
      CONSTRAINT uk_tenant_fixed_asset_code UNIQUE (tenant_id, asset_code)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
    `CREATE TABLE IF NOT EXISTS tenant_cloud_folders (
      id VARCHAR(36) NOT NULL PRIMARY KEY DEFAULT (UUID()),
      tenant_id VARCHAR(36) NOT NULL,
      parent_folder_id VARCHAR(36) NULL,
      name VARCHAR(200) NOT NULL,
      storage_prefix VARCHAR(500) NOT NULL,
      visibility VARCHAR(30) NOT NULL DEFAULT 'company',
      allowed_department_ids JSON NULL,
      created_by VARCHAR(36) NULL,
      created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
      updated_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
      CONSTRAINT uk_tenant_cloud_folders_tenant_id UNIQUE (tenant_id, id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
    `CREATE TABLE IF NOT EXISTS tenant_cloud_files (
      id VARCHAR(36) NOT NULL PRIMARY KEY DEFAULT (UUID()),
      tenant_id VARCHAR(36) NOT NULL,
      folder_id VARCHAR(36) NULL,
      project_id VARCHAR(36) NULL,
      name VARCHAR(255) NOT NULL,
      storage_key VARCHAR(600) NOT NULL,
      mime_type VARCHAR(120) NOT NULL DEFAULT 'application/octet-stream',
      size_bytes BIGINT NOT NULL DEFAULT 0,
      version_tag VARCHAR(40) NOT NULL DEFAULT 'v1.0',
      visibility VARCHAR(30) NOT NULL DEFAULT 'company',
      allowed_department_ids JSON NULL,
      checksum_sha256 VARCHAR(80) NULL,
      content_preview TEXT NULL,
      uploaded_by VARCHAR(36) NULL,
      uploaded_by_name VARCHAR(150) NULL,
      created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
      updated_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
      CONSTRAINT uk_tenant_cloud_files_tenant_id UNIQUE (tenant_id, id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
    `CREATE TABLE IF NOT EXISTS tenant_ocr_extractions (
      id VARCHAR(36) NOT NULL PRIMARY KEY DEFAULT (UUID()),
      tenant_id VARCHAR(36) NOT NULL,
      doc_type VARCHAR(40) NOT NULL DEFAULT 'contract',
      source_file_id VARCHAR(36) NULL,
      source_title VARCHAR(255) NOT NULL,
      raw_text TEXT NOT NULL,
      extracted_party_name VARCHAR(255) NULL,
      extracted_tax_code VARCHAR(60) NULL,
      extracted_id_number VARCHAR(60) NULL,
      extracted_representative VARCHAR(150) NULL,
      extracted_address TEXT NULL,
      contract_value_vnd BIGINT NOT NULL DEFAULT 0,
      effective_date DATE NULL,
      expiry_date DATE NULL,
      branch_verification_json JSON NULL,
      extracted_fields_json JSON NULL,
      saved_company_id VARCHAR(36) NULL,
      saved_transaction_id VARCHAR(36) NULL,
      created_by VARCHAR(36) NULL,
      created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
      CONSTRAINT uk_tenant_ocr_extractions_tenant_id UNIQUE (tenant_id, id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
    `CREATE TABLE IF NOT EXISTS tenant_edu_courses (
      id VARCHAR(36) NOT NULL PRIMARY KEY DEFAULT (UUID()),
      tenant_id VARCHAR(36) NOT NULL,
      code VARCHAR(50) NOT NULL,
      name VARCHAR(255) NOT NULL,
      category VARCHAR(100) NOT NULL DEFAULT 'Program',
      duration_sessions INT NOT NULL DEFAULT 12,
      tuition_fee_vnd BIGINT NOT NULL DEFAULT 0,
      description TEXT NULL,
      is_active TINYINT(1) NOT NULL DEFAULT 1,
      created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
      updated_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
      CONSTRAINT uk_tenant_edu_courses_tenant_id UNIQUE (tenant_id, id),
      CONSTRAINT uk_tenant_edu_courses_code UNIQUE (tenant_id, code)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
    `CREATE TABLE IF NOT EXISTS tenant_edu_classes (
      id VARCHAR(36) NOT NULL PRIMARY KEY DEFAULT (UUID()),
      tenant_id VARCHAR(36) NOT NULL,
      course_id VARCHAR(36) NOT NULL,
      code VARCHAR(50) NOT NULL,
      name VARCHAR(200) NOT NULL,
      instructor_user_id VARCHAR(36) NULL,
      instructor_name VARCHAR(150) NULL,
      branch_id VARCHAR(36) NULL,
      room_name VARCHAR(100) NULL,
      max_capacity INT NOT NULL DEFAULT 30,
      start_date DATE NULL,
      end_date DATE NULL,
      status VARCHAR(30) NOT NULL DEFAULT 'enrolling',
      created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
      updated_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
      CONSTRAINT uk_tenant_edu_classes_tenant_id UNIQUE (tenant_id, id),
      CONSTRAINT uk_tenant_edu_classes_code UNIQUE (tenant_id, code)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
    `CREATE TABLE IF NOT EXISTS tenant_edu_schedules (
      id VARCHAR(36) NOT NULL PRIMARY KEY DEFAULT (UUID()),
      tenant_id VARCHAR(36) NOT NULL,
      class_id VARCHAR(36) NOT NULL,
      day_of_week INT NOT NULL,
      start_time VARCHAR(10) NOT NULL,
      end_time VARCHAR(10) NOT NULL,
      room_name VARCHAR(100) NOT NULL,
      instructor_user_id VARCHAR(36) NULL,
      instructor_name VARCHAR(150) NULL,
      topic VARCHAR(255) NULL,
      created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
      CONSTRAINT uk_tenant_edu_schedules_tenant_id UNIQUE (tenant_id, id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
    `CREATE TABLE IF NOT EXISTS tenant_edu_enrollments (
      id VARCHAR(36) NOT NULL PRIMARY KEY DEFAULT (UUID()),
      tenant_id VARCHAR(36) NOT NULL,
      class_id VARCHAR(36) NOT NULL,
      lead_id VARCHAR(36) NULL,
      student_name VARCHAR(150) NOT NULL,
      student_phone VARCHAR(40) NULL,
      student_email VARCHAR(255) NULL,
      status VARCHAR(30) NOT NULL DEFAULT 'active',
      tuition_paid_vnd BIGINT NOT NULL DEFAULT 0,
      enrolled_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
      updated_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
      CONSTRAINT uk_tenant_edu_enrollments_tenant_id UNIQUE (tenant_id, id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
    `CREATE TABLE IF NOT EXISTS tenant_edu_attendance_grades (
      id VARCHAR(36) NOT NULL PRIMARY KEY DEFAULT (UUID()),
      tenant_id VARCHAR(36) NOT NULL,
      enrollment_id VARCHAR(36) NOT NULL,
      class_id VARCHAR(36) NOT NULL,
      session_date DATE NOT NULL,
      attendance_status VARCHAR(20) NOT NULL DEFAULT 'present',
      midterm_score DECIMAL(5,2) NULL,
      final_score DECIMAL(5,2) NULL,
      gpa_score DECIMAL(5,2) NULL,
      feedback TEXT NULL,
      recorded_by VARCHAR(36) NULL,
      created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
      updated_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
      CONSTRAINT uk_tenant_edu_attendance_grades_tenant_id UNIQUE (tenant_id, id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
    `CREATE TABLE IF NOT EXISTS tenant_quote_items (
      id VARCHAR(36) NOT NULL PRIMARY KEY DEFAULT (UUID()),
      tenant_id VARCHAR(36) NOT NULL,
      quote_id VARCHAR(36) NOT NULL,
      product_id VARCHAR(36) NULL,
      sku VARCHAR(80) NOT NULL DEFAULT '',
      name VARCHAR(255) NOT NULL,
      description TEXT NULL,
      unit VARCHAR(40) NOT NULL DEFAULT 'Cái',
      qty DECIMAL(12,2) NOT NULL DEFAULT 1,
      unit_price_vnd BIGINT NOT NULL DEFAULT 0,
      discount_pct DECIMAL(5,2) NOT NULL DEFAULT 0,
      tax_pct DECIMAL(5,2) NOT NULL DEFAULT 0,
      line_subtotal_vnd BIGINT NOT NULL DEFAULT 0,
      line_discount_vnd BIGINT NOT NULL DEFAULT 0,
      line_tax_vnd BIGINT NOT NULL DEFAULT 0,
      line_total_vnd BIGINT NOT NULL DEFAULT 0,
      sort_order INT NOT NULL DEFAULT 0,
      created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
      CONSTRAINT uk_tenant_quote_items_tenant_id UNIQUE (tenant_id, id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
    `CREATE TABLE IF NOT EXISTS tenant_sales_order_items (
      id VARCHAR(36) NOT NULL PRIMARY KEY DEFAULT (UUID()),
      tenant_id VARCHAR(36) NOT NULL,
      sales_order_id VARCHAR(36) NOT NULL,
      product_id VARCHAR(36) NULL,
      sku VARCHAR(80) NOT NULL DEFAULT '',
      name VARCHAR(255) NOT NULL,
      description TEXT NULL,
      unit VARCHAR(40) NOT NULL DEFAULT 'Cái',
      qty DECIMAL(12,2) NOT NULL DEFAULT 1,
      fulfilled_qty DECIMAL(12,2) NOT NULL DEFAULT 0,
      unit_price_vnd BIGINT NOT NULL DEFAULT 0,
      discount_pct DECIMAL(5,2) NOT NULL DEFAULT 0,
      tax_pct DECIMAL(5,2) NOT NULL DEFAULT 0,
      line_subtotal_vnd BIGINT NOT NULL DEFAULT 0,
      line_discount_vnd BIGINT NOT NULL DEFAULT 0,
      line_tax_vnd BIGINT NOT NULL DEFAULT 0,
      line_total_vnd BIGINT NOT NULL DEFAULT 0,
      sort_order INT NOT NULL DEFAULT 0,
      created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
      CONSTRAINT uk_tenant_so_items_tenant_id UNIQUE (tenant_id, id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
    `CREATE TABLE IF NOT EXISTS tenant_purchase_order_items (
      id VARCHAR(36) NOT NULL PRIMARY KEY DEFAULT (UUID()),
      tenant_id VARCHAR(36) NOT NULL,
      purchase_order_id VARCHAR(36) NOT NULL,
      product_id VARCHAR(36) NULL,
      sku VARCHAR(80) NOT NULL DEFAULT '',
      name VARCHAR(255) NOT NULL,
      unit VARCHAR(40) NOT NULL DEFAULT 'Cái',
      ordered_qty DECIMAL(12,2) NOT NULL DEFAULT 1,
      received_qty DECIMAL(12,2) NOT NULL DEFAULT 0,
      invoiced_qty DECIMAL(12,2) NOT NULL DEFAULT 0,
      unit_price_vnd BIGINT NOT NULL DEFAULT 0,
      discount_pct DECIMAL(5,2) NOT NULL DEFAULT 0,
      tax_pct DECIMAL(5,2) NOT NULL DEFAULT 0,
      line_total_vnd BIGINT NOT NULL DEFAULT 0,
      match_note TEXT NULL,
      sort_order INT NOT NULL DEFAULT 0,
      created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
      CONSTRAINT uk_tenant_po_items_tenant_id UNIQUE (tenant_id, id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
    `CREATE TABLE IF NOT EXISTS tenant_invoices (
      id VARCHAR(36) NOT NULL PRIMARY KEY DEFAULT (UUID()),
      tenant_id VARCHAR(36) NOT NULL,
      invoice_code VARCHAR(60) NOT NULL,
      invoice_type VARCHAR(20) NOT NULL DEFAULT 'sales',
      sales_order_id VARCHAR(36) NULL,
      purchase_order_id VARCHAR(36) NULL,
      quote_id VARCHAR(36) NULL,
      deposit_id VARCHAR(36) NULL,
      company_id VARCHAR(36) NULL,
      lead_id VARCHAR(36) NULL,
      deal_id VARCHAR(36) NULL,
      supplier_id VARCHAR(36) NULL,
      branch_id VARCHAR(36) NULL,
      customer_name VARCHAR(200) NOT NULL DEFAULT '',
      customer_tax_code VARCHAR(60) NULL,
      tax_code VARCHAR(50) NULL,
      customer_address TEXT NULL,
      customer_email VARCHAR(255) NULL,
      status VARCHAR(30) NOT NULL DEFAULT 'issued',
      issue_date DATE NULL,
      issued_at DATETIME(6) NULL,
      due_date DATE NULL,
      items_json JSON NULL,
      subtotal_vnd BIGINT NOT NULL DEFAULT 0,
      discount_vnd BIGINT NOT NULL DEFAULT 0,
      tax_vnd BIGINT NOT NULL DEFAULT 0,
      shipping_fee_vnd BIGINT NOT NULL DEFAULT 0,
      total_vnd BIGINT NOT NULL DEFAULT 0,
      paid_vnd BIGINT NOT NULL DEFAULT 0,
      payment_method VARCHAR(40) NOT NULL DEFAULT 'bank_transfer',
      vat_invoice_no VARCHAR(80) NULL,
      vat_serial VARCHAR(40) NULL,
      notes TEXT NULL,
      created_by VARCHAR(36) NULL,
      created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
      updated_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
      CONSTRAINT uk_tenant_invoices_tenant_id UNIQUE (tenant_id, id),
      CONSTRAINT uk_tenant_invoices_code UNIQUE (tenant_id, invoice_code)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
    `CREATE TABLE IF NOT EXISTS tenant_invoice_items (
      id VARCHAR(36) NOT NULL PRIMARY KEY DEFAULT (UUID()),
      tenant_id VARCHAR(36) NOT NULL,
      invoice_id VARCHAR(36) NOT NULL,
      product_id VARCHAR(36) NULL,
      sku VARCHAR(80) NOT NULL DEFAULT '',
      name VARCHAR(255) NOT NULL,
      description TEXT NULL,
      unit VARCHAR(40) NOT NULL DEFAULT 'Cái',
      qty DECIMAL(12,2) NOT NULL DEFAULT 1,
      unit_price_vnd BIGINT NOT NULL DEFAULT 0,
      discount_pct DECIMAL(5,2) NOT NULL DEFAULT 0,
      tax_pct DECIMAL(5,2) NOT NULL DEFAULT 0,
      line_total_vnd BIGINT NOT NULL DEFAULT 0,
      sort_order INT NOT NULL DEFAULT 0,
      created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
      CONSTRAINT uk_tenant_invoice_items_tenant_id UNIQUE (tenant_id, id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
    `CREATE TABLE IF NOT EXISTS tenant_deposit_milestones (
      id VARCHAR(36) NOT NULL PRIMARY KEY DEFAULT (UUID()),
      tenant_id VARCHAR(36) NOT NULL,
      deposit_id VARCHAR(36) NOT NULL,
      tranche_no INT NOT NULL DEFAULT 1,
      name VARCHAR(200) NOT NULL,
      amount_vnd BIGINT NOT NULL DEFAULT 0,
      expected_pay_date DATE NULL,
      paid_at DATETIME(6) NULL,
      status VARCHAR(30) NOT NULL DEFAULT 'pending',
      payment_method VARCHAR(40) NOT NULL DEFAULT 'bank_transfer',
      unc_url TEXT NULL,
      reference_no VARCHAR(100) NULL,
      confirmed_by VARCHAR(36) NULL,
      confirmed_by_name VARCHAR(150) NULL,
      note TEXT NULL,
      created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
      updated_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
      CONSTRAINT uk_tenant_dep_milestones_tenant_id UNIQUE (tenant_id, id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
    `CREATE TABLE IF NOT EXISTS tenant_expenses (
      id VARCHAR(36) NOT NULL PRIMARY KEY DEFAULT (UUID()),
      tenant_id VARCHAR(36) NOT NULL,
      expense_code VARCHAR(60) NOT NULL,
      title VARCHAR(255) NOT NULL,
      category VARCHAR(80) NOT NULL DEFAULT 'operating_expense',
      branch_id VARCHAR(36) NULL,
      department_id VARCHAR(36) NULL,
      project_id VARCHAR(36) NULL,
      supplier_id VARCHAR(36) NULL,
      vendor_name VARCHAR(200) NULL,
      vendor_tax_code VARCHAR(60) NULL,
      requester_user_id VARCHAR(36) NULL,
      requester_name VARCHAR(150) NULL,
      approver_user_id VARCHAR(36) NULL,
      approval_request_id VARCHAR(36) NULL,
      approval_status VARCHAR(40) NOT NULL DEFAULT 'pending_approval',
      has_vat_invoice TINYINT(1) NOT NULL DEFAULT 0,
      is_vat_inclusive TINYINT(1) NOT NULL DEFAULT 1,
      vat_invoice_no VARCHAR(80) NULL,
      currency VARCHAR(10) NOT NULL DEFAULT 'VND',
      subtotal_vnd BIGINT NOT NULL DEFAULT 0,
      vat_amount_vnd BIGINT NOT NULL DEFAULT 0,
      total_amount_vnd BIGINT NOT NULL DEFAULT 0,
      payment_method VARCHAR(40) NOT NULL DEFAULT 'bank_transfer',
      bank_name VARCHAR(120) NULL,
      bank_bin VARCHAR(30) NULL,
      bank_account_no VARCHAR(80) NULL,
      bank_account_holder VARCHAR(150) NULL,
      expense_date DATE NOT NULL,
      due_date DATE NULL,
      paid_at DATETIME(6) NULL,
      refund_status VARCHAR(30) NOT NULL DEFAULT 'none',
      refund_amount_vnd BIGINT NOT NULL DEFAULT 0,
      refund_attachment_url TEXT NULL,
      refunded_at DATETIME(6) NULL,
      line_items_json JSON NULL,
      attachments_json JSON NULL,
      watchers_json JSON NULL,
      history_json JSON NULL,
      notes TEXT NULL,
      created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
      updated_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
      CONSTRAINT uk_tenant_expenses_tenant_id UNIQUE (tenant_id, id),
      CONSTRAINT uk_tenant_expenses_code UNIQUE (tenant_id, expense_code)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
    `CREATE TABLE IF NOT EXISTS tenant_pos_sessions (
      id VARCHAR(36) NOT NULL PRIMARY KEY DEFAULT (UUID()),
      tenant_id VARCHAR(36) NOT NULL,
      session_code VARCHAR(60) NOT NULL,
      branch_id VARCHAR(36) NULL,
      warehouse_id VARCHAR(36) NULL,
      cashier_user_id VARCHAR(36) NULL,
      cashier_name VARCHAR(150) NULL,
      status VARCHAR(20) NOT NULL DEFAULT 'open',
      opening_cash_vnd BIGINT NOT NULL DEFAULT 0,
      cash_sales_vnd BIGINT NOT NULL DEFAULT 0,
      bank_sales_vnd BIGINT NOT NULL DEFAULT 0,
      card_sales_vnd BIGINT NOT NULL DEFAULT 0,
      expected_closing_cash_vnd BIGINT NOT NULL DEFAULT 0,
      actual_closing_cash_vnd BIGINT NOT NULL DEFAULT 0,
      variance_vnd BIGINT NOT NULL DEFAULT 0,
      orders_count INT NOT NULL DEFAULT 0,
      opened_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
      closed_at DATETIME(6) NULL,
      closing_note TEXT NULL,
      created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
      updated_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
      CONSTRAINT uk_tenant_pos_sessions_tenant_id UNIQUE (tenant_id, id),
      CONSTRAINT uk_tenant_pos_sessions_code UNIQUE (tenant_id, session_code)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
    `CREATE TABLE IF NOT EXISTS tenant_pos_orders (
      id VARCHAR(36) NOT NULL PRIMARY KEY DEFAULT (UUID()),
      tenant_id VARCHAR(36) NOT NULL,
      pos_order_code VARCHAR(60) NOT NULL,
      session_id VARCHAR(36) NULL,
      sales_order_id VARCHAR(36) NULL,
      lead_id VARCHAR(36) NULL,
      branch_id VARCHAR(36) NULL,
      warehouse_id VARCHAR(36) NULL,
      cashier_user_id VARCHAR(36) NULL,
      customer_name VARCHAR(200) NOT NULL DEFAULT 'Khách lẻ POS',
      customer_phone VARCHAR(40) NULL,
      items_json JSON NULL,
      subtotal_vnd BIGINT NOT NULL DEFAULT 0,
      discount_vnd BIGINT NOT NULL DEFAULT 0,
      voucher_code VARCHAR(80) NULL,
      voucher_discount_vnd BIGINT NOT NULL DEFAULT 0,
      shipping_fee_vnd BIGINT NOT NULL DEFAULT 0,
      tax_vnd BIGINT NOT NULL DEFAULT 0,
      total_vnd BIGINT NOT NULL DEFAULT 0,
      cash_paid_vnd BIGINT NOT NULL DEFAULT 0,
      bank_paid_vnd BIGINT NOT NULL DEFAULT 0,
      payment_method VARCHAR(40) NOT NULL DEFAULT 'cash',
      cogs_vnd BIGINT NOT NULL DEFAULT 0,
      status VARCHAR(30) NOT NULL DEFAULT 'completed',
      notes TEXT NULL,
      created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
      CONSTRAINT uk_tenant_pos_orders_tenant_id UNIQUE (tenant_id, id),
      CONSTRAINT uk_tenant_pos_orders_code UNIQUE (tenant_id, pos_order_code)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
    `CREATE TABLE IF NOT EXISTS tenant_inventory_sync_sheets (
      id VARCHAR(36) NOT NULL PRIMARY KEY DEFAULT (UUID()),
      tenant_id VARCHAR(36) NOT NULL,
      sheet_name VARCHAR(150) NOT NULL DEFAULT 'Sheet1',
      spreadsheet_id VARCHAR(255) NOT NULL,
      webhook_token VARCHAR(120) NOT NULL,
      warehouse_id VARCHAR(36) NULL,
      sync_interval_minutes INT NOT NULL DEFAULT 15,
      is_active TINYINT(1) NOT NULL DEFAULT 1,
      sync_status VARCHAR(30) NOT NULL DEFAULT 'idle',
      last_sync_at DATETIME(6) NULL,
      last_error TEXT NULL,
      mappings_json JSON NULL,
      history_json JSON NULL,
      created_by VARCHAR(36) NULL,
      created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
      updated_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
      CONSTRAINT uk_tenant_inv_sync_sheets_tenant_id UNIQUE (tenant_id, id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
    `CREATE TABLE IF NOT EXISTS tenant_project_roster (
      id VARCHAR(36) NOT NULL PRIMARY KEY DEFAULT (UUID()),
      tenant_id VARCHAR(36) NOT NULL,
      project_id VARCHAR(36) NOT NULL,
      user_id VARCHAR(36) NOT NULL,
      user_name VARCHAR(150) NOT NULL,
      role_in_project VARCHAR(30) NOT NULL DEFAULT 'member',
      can_edit_tasks TINYINT(1) NOT NULL DEFAULT 1,
      can_manage_roster TINYINT(1) NOT NULL DEFAULT 0,
      can_edit_whiteboard TINYINT(1) NOT NULL DEFAULT 1,
      allocation_pct INT NOT NULL DEFAULT 100,
      added_by VARCHAR(36) NULL,
      created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
      updated_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
      CONSTRAINT uk_tenant_project_roster_tenant_id UNIQUE (tenant_id, id),
      CONSTRAINT uk_project_roster_member UNIQUE (tenant_id, project_id, user_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
    `CREATE TABLE IF NOT EXISTS tenant_task_dependencies (
      id VARCHAR(36) NOT NULL PRIMARY KEY DEFAULT (UUID()),
      tenant_id VARCHAR(36) NOT NULL,
      project_id VARCHAR(36) NULL,
      task_id VARCHAR(36) NOT NULL,
      predecessor_task_id VARCHAR(36) NULL,
      depends_on_task_id VARCHAR(36) NULL,
      dependency_type VARCHAR(30) NOT NULL DEFAULT 'FS',
      lag_days INT NOT NULL DEFAULT 0,
      note TEXT NULL,
      created_by VARCHAR(36) NULL,
      created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
      CONSTRAINT uk_tenant_task_deps_tenant_id UNIQUE (tenant_id, id),
      CONSTRAINT uk_task_dep_pair UNIQUE (tenant_id, task_id, predecessor_task_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
    `CREATE TABLE IF NOT EXISTS tenant_task_comments (
      id VARCHAR(36) NOT NULL PRIMARY KEY DEFAULT (UUID()),
      tenant_id VARCHAR(36) NOT NULL,
      task_id VARCHAR(36) NOT NULL,
      author_user_id VARCHAR(36) NULL,
      author_name VARCHAR(150) NOT NULL DEFAULT 'Thành viên',
      content TEXT NOT NULL,
      mentions_json JSON NULL,
      attachments_json JSON NULL,
      edit_history_json JSON NULL,
      created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
      updated_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
      CONSTRAINT uk_tenant_task_comments_tenant_id UNIQUE (tenant_id, id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
    `CREATE TABLE IF NOT EXISTS tenant_task_attachments (
      id VARCHAR(36) NOT NULL PRIMARY KEY DEFAULT (UUID()),
      tenant_id VARCHAR(36) NOT NULL,
      task_id VARCHAR(36) NOT NULL,
      file_name VARCHAR(255) NOT NULL,
      file_url TEXT NOT NULL,
      mime_type VARCHAR(120) NOT NULL DEFAULT 'application/octet-stream',
      size_bytes BIGINT NOT NULL DEFAULT 0,
      cloud_file_id VARCHAR(36) NULL,
      uploaded_by VARCHAR(36) NULL,
      uploaded_by_name VARCHAR(150) NULL,
      created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
      CONSTRAINT uk_tenant_task_attachments_tenant_id UNIQUE (tenant_id, id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
    `CREATE TABLE IF NOT EXISTS tenant_task_whiteboard_snapshots (
      id VARCHAR(36) NOT NULL PRIMARY KEY DEFAULT (UUID()),
      tenant_id VARCHAR(36) NOT NULL,
      project_id VARCHAR(36) NOT NULL,
      snapshot_name VARCHAR(200) NOT NULL,
      version_no INT NOT NULL DEFAULT 1,
      snapshot_json JSON NULL,
      thumbnail_note TEXT NULL,
      created_by VARCHAR(36) NULL,
      created_by_name VARCHAR(150) NULL,
      created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
      CONSTRAINT uk_tenant_wb_snapshots_tenant_id UNIQUE (tenant_id, id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
    `CREATE TABLE IF NOT EXISTS tenant_cloud_file_categories (
      id VARCHAR(36) NOT NULL PRIMARY KEY DEFAULT (UUID()),
      tenant_id VARCHAR(36) NOT NULL,
      category_key VARCHAR(80) NOT NULL,
      label VARCHAR(150) NOT NULL,
      icon_type VARCHAR(40) NOT NULL DEFAULT 'folder',
      visibility VARCHAR(30) NOT NULL DEFAULT 'company',
      allowed_department_ids JSON NULL,
      allowed_role_ids JSON NULL,
      sort_order INT NOT NULL DEFAULT 0,
      created_by VARCHAR(36) NULL,
      created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
      updated_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
      CONSTRAINT uk_tenant_cloud_cats_tenant_id UNIQUE (tenant_id, id),
      CONSTRAINT uk_tenant_cloud_cat_key UNIQUE (tenant_id, category_key)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
    `CREATE TABLE IF NOT EXISTS tenant_edu_announcements (
      id VARCHAR(36) NOT NULL PRIMARY KEY DEFAULT (UUID()),
      tenant_id VARCHAR(36) NOT NULL,
      announcement_type VARCHAR(40) NOT NULL DEFAULT 'subject_announcement',
      course_id VARCHAR(36) NULL,
      class_id VARCHAR(36) NULL,
      subject_key VARCHAR(80) NULL,
      title VARCHAR(255) NOT NULL,
      content_html TEXT NOT NULL,
      channels_json JSON NULL,
      recipients_json JSON NULL,
      sent_count INT NOT NULL DEFAULT 0,
      status VARCHAR(30) NOT NULL DEFAULT 'sent',
      created_by VARCHAR(36) NULL,
      created_by_name VARCHAR(150) NULL,
      created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
      CONSTRAINT uk_tenant_edu_announcements_tenant_id UNIQUE (tenant_id, id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
  ];

  for (const stmt of mariaTables) {
    await client.query(stmt);
  }

  const mariaColumnUpgrades = [
    'ALTER TABLE tenant_quotes ADD COLUMN IF NOT EXISTS shipping_fee_vnd BIGINT NOT NULL DEFAULT 0',
    'ALTER TABLE tenant_quotes ADD COLUMN IF NOT EXISTS discount_pct DECIMAL(5,2) NOT NULL DEFAULT 0',
    'ALTER TABLE tenant_quotes ADD COLUMN IF NOT EXISTS tax_pct DECIMAL(5,2) NOT NULL DEFAULT 0',
    'ALTER TABLE tenant_quotes ADD COLUMN IF NOT EXISTS notes TEXT NULL',
    'ALTER TABLE tenant_quotes ADD COLUMN IF NOT EXISTS customer_name VARCHAR(200) NULL',
    'ALTER TABLE tenant_quotes ADD COLUMN IF NOT EXISTS customer_email VARCHAR(255) NULL',
    'ALTER TABLE tenant_quotes ADD COLUMN IF NOT EXISTS customer_phone VARCHAR(40) NULL',
    'ALTER TABLE tenant_sales_orders ADD COLUMN IF NOT EXISTS shipping_fee_vnd BIGINT NOT NULL DEFAULT 0',
    'ALTER TABLE tenant_sales_orders ADD COLUMN IF NOT EXISTS voucher_code VARCHAR(80) NULL',
    "ALTER TABLE tenant_sales_orders ADD COLUMN IF NOT EXISTS payment_method VARCHAR(40) NOT NULL DEFAULT 'bank_transfer'",
    'ALTER TABLE tenant_sales_orders ADD COLUMN IF NOT EXISTS split_payments_json JSON NULL',
    'ALTER TABLE tenant_purchase_orders ADD COLUMN IF NOT EXISTS subtotal_vnd BIGINT NOT NULL DEFAULT 0',
    'ALTER TABLE tenant_purchase_orders ADD COLUMN IF NOT EXISTS discount_vnd BIGINT NOT NULL DEFAULT 0',
    'ALTER TABLE tenant_purchase_orders ADD COLUMN IF NOT EXISTS tax_vnd BIGINT NOT NULL DEFAULT 0',
    'ALTER TABLE tenant_purchase_orders ADD COLUMN IF NOT EXISTS shipping_fee_vnd BIGINT NOT NULL DEFAULT 0',
    "ALTER TABLE tenant_purchase_orders ADD COLUMN IF NOT EXISTS payment_status VARCHAR(30) NOT NULL DEFAULT 'unpaid'",
    'ALTER TABLE tenant_purchase_orders ADD COLUMN IF NOT EXISTS paid_vnd BIGINT NOT NULL DEFAULT 0',
    "ALTER TABLE tenant_purchase_orders ADD COLUMN IF NOT EXISTS three_way_match_status VARCHAR(30) NOT NULL DEFAULT 'pending'",
    'ALTER TABLE tenant_purchase_orders ADD COLUMN IF NOT EXISTS three_way_match_json JSON NULL',
    'ALTER TABLE tenant_deposits ADD COLUMN IF NOT EXISTS project_id VARCHAR(36) NULL',
    'ALTER TABLE tenant_deposits ADD COLUMN IF NOT EXISTS unit_code VARCHAR(80) NULL',
    'ALTER TABLE tenant_deposits ADD COLUMN IF NOT EXISTS contract_value_vnd BIGINT NOT NULL DEFAULT 0',
    'ALTER TABLE tenant_deposits ADD COLUMN IF NOT EXISTS expected_commission_vnd BIGINT NOT NULL DEFAULT 0',
    "ALTER TABLE tenant_deposits ADD COLUMN IF NOT EXISTS currency VARCHAR(10) NOT NULL DEFAULT 'VND'",
    'ALTER TABLE tenant_deposits ADD COLUMN IF NOT EXISTS exchange_rate DECIMAL(12,4) NOT NULL DEFAULT 1',
    'ALTER TABLE tenant_deposits ADD COLUMN IF NOT EXISTS unc_attachment_url TEXT NULL',
    'ALTER TABLE tenant_deposits ADD COLUMN IF NOT EXISTS attachments_json JSON NULL',
    'ALTER TABLE tenant_deposits ADD COLUMN IF NOT EXISTS commission_shares_json JSON NULL',
    'ALTER TABLE tenant_deposits ADD COLUMN IF NOT EXISTS watchers_json JSON NULL',
    'ALTER TABLE tenant_deposits ADD COLUMN IF NOT EXISTS history_json JSON NULL',
    'ALTER TABLE tenant_deposits ADD COLUMN IF NOT EXISTS confirmed_by VARCHAR(36) NULL',
    'ALTER TABLE tenant_deposits ADD COLUMN IF NOT EXISTS confirmed_at DATETIME(6) NULL',
    'ALTER TABLE tenant_deposits ADD COLUMN IF NOT EXISTS refunded_amount_vnd BIGINT NOT NULL DEFAULT 0',
    'ALTER TABLE tenant_deposits ADD COLUMN IF NOT EXISTS refund_reason TEXT NULL',
    "ALTER TABLE tenant_suppliers ADD COLUMN IF NOT EXISTS prestige_tier VARCHAR(10) NOT NULL DEFAULT 'A'",
    "ALTER TABLE tenant_suppliers ADD COLUMN IF NOT EXISTS cooperation_status VARCHAR(30) NOT NULL DEFAULT 'active'",
    'ALTER TABLE tenant_suppliers ADD COLUMN IF NOT EXISTS website VARCHAR(255) NULL',
    'ALTER TABLE tenant_suppliers ADD COLUMN IF NOT EXISTS bank_name VARCHAR(120) NULL',
    'ALTER TABLE tenant_suppliers ADD COLUMN IF NOT EXISTS bank_account_no VARCHAR(80) NULL',
    'ALTER TABLE tenant_suppliers ADD COLUMN IF NOT EXISTS bank_account_holder VARCHAR(150) NULL',
    'ALTER TABLE tenant_suppliers ADD COLUMN IF NOT EXISTS categories_json JSON NULL',
    'ALTER TABLE tenant_suppliers ADD COLUMN IF NOT EXISTS notes TEXT NULL',
    'ALTER TABLE tenant_suppliers ADD COLUMN IF NOT EXISTS metadata_json JSON NULL',
    "ALTER TABLE tenant_cloud_files ADD COLUMN IF NOT EXISTS category_key VARCHAR(80) NOT NULL DEFAULT 'general'",
    'ALTER TABLE tenant_cloud_files ADD COLUMN IF NOT EXISTS lead_id VARCHAR(36) NULL',
    'ALTER TABLE tenant_cloud_files ADD COLUMN IF NOT EXISTS file_url TEXT NULL',
    "ALTER TABLE tenant_edu_courses ADD COLUMN IF NOT EXISTS grading_scale VARCHAR(30) NOT NULL DEFAULT 'scale_10'",
    'ALTER TABLE tenant_edu_courses ADD COLUMN IF NOT EXISTS subjects_json JSON NULL',
    'ALTER TABLE tenant_edu_courses ADD COLUMN IF NOT EXISTS credits INT NOT NULL DEFAULT 3',
    'ALTER TABLE tenant_edu_enrollments ADD COLUMN IF NOT EXISTS program_code VARCHAR(60) NULL',
    "ALTER TABLE tenant_edu_enrollments ADD COLUMN IF NOT EXISTS postpone_status VARCHAR(30) NOT NULL DEFAULT 'none'",
    'ALTER TABLE tenant_edu_enrollments ADD COLUMN IF NOT EXISTS postpone_reason TEXT NULL',
    'ALTER TABLE tenant_edu_enrollments ADD COLUMN IF NOT EXISTS postpone_until DATE NULL',
    'ALTER TABLE tenant_edu_enrollments ADD COLUMN IF NOT EXISTS postpone_ocr_json JSON NULL',
    'ALTER TABLE tenant_edu_enrollments ADD COLUMN IF NOT EXISTS metadata_json JSON NULL',
    "ALTER TABLE tenant_edu_attendance_grades ADD COLUMN IF NOT EXISTS subject_key VARCHAR(80) NOT NULL DEFAULT 'GENERAL'",
    'ALTER TABLE tenant_edu_attendance_grades ADD COLUMN IF NOT EXISTS subject_name VARCHAR(200) NULL',
    'ALTER TABLE tenant_edu_attendance_grades ADD COLUMN IF NOT EXISTS attendance_score DECIMAL(5,2) NULL',
    'ALTER TABLE tenant_edu_attendance_grades ADD COLUMN IF NOT EXISTS assignment_score DECIMAL(5,2) NULL',
    'ALTER TABLE tenant_edu_attendance_grades ADD COLUMN IF NOT EXISTS ects_score_6 DECIMAL(5,2) NULL',
    'ALTER TABLE tenant_edu_attendance_grades ADD COLUMN IF NOT EXISTS letter_grade VARCHAR(40) NULL',
    "ALTER TABLE tenant_edu_attendance_grades ADD COLUMN IF NOT EXISTS pass_status VARCHAR(20) NOT NULL DEFAULT 'passed'",
    // Performance composite indexes for MariaDB 10.6 parity with PostgreSQL
    'CREATE INDEX IF NOT EXISTS idx_tenant_tasks_assignee_status ON tenant_tasks(tenant_id, assignee_user_id, status_key, due_date)',
    'CREATE INDEX IF NOT EXISTS idx_tenant_deals_owner_stage ON tenant_deals(tenant_id, owner_user_id, stage)',
    'CREATE INDEX IF NOT EXISTS idx_tenant_deals_company ON tenant_deals(tenant_id, company_id, created_at)',
    'CREATE INDEX IF NOT EXISTS idx_helpdesk_lead ON tenant_helpdesk_tickets(tenant_id, lead_id, created_at)',
    'CREATE INDEX IF NOT EXISTS idx_helpdesk_assignee_status ON tenant_helpdesk_tickets(tenant_id, assignee_user_id, status)',
  ];

  for (const alt of mariaColumnUpgrades) {
    try {
      await client.query(alt);
    } catch {
      // ignore if column already exists on older engines
    }
  }
}
