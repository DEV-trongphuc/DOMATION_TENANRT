import crypto from 'node:crypto';
import { Router } from 'express';
import { withTenantTransaction } from '../../core/database/transaction.ts';
import { getTenantContext } from '../../core/context/tenant-context.ts';
import {
  buildGranularScopeWhereClause,
  requireEntitlement,
  requirePermission,
  requireTenantAuth,
  resolveUserEffectivePermissions,
  sendApiError,
} from '../../core/security/rbac.ts';
import {
  ensureHrmApprovalsSchemaMiddleware,
  parseJsonSafe,
  toBool,
  toNum,
} from '../hrm/schema.ts';
import {
  buildHtkk05KkXml,
  buildPayrollCsv,
  calculateEmployeePayslip,
  computeStandardWorkdaysForMonth,
  getOrSeedTenantPayrollConfigInTx,
  simulateGrossNet,
  type AllowanceDefinition,
  type PitBracket,
} from './payroll-engine.ts';

function computeCommissionFromRule(
  revenueVnd: number,
  wonCount: number,
  rule: {
    rule_type: string;
    flat_rate_pct: number;
    fixed_amount_vnd: number;
    min_revenue_threshold_vnd: number;
    tiers_json: Array<{ min_vnd?: number; max_vnd?: number | null; rate_pct: number }>;
  }
): number {
  if (revenueVnd < rule.min_revenue_threshold_vnd && rule.rule_type !== 'fixed_per_won_lead') {
    return 0;
  }
  if (rule.rule_type === 'fixed_per_won_lead') {
    return Math.round(Math.max(0, wonCount) * Math.max(0, rule.fixed_amount_vnd));
  }
  if (rule.rule_type === 'tiered_revenue' && Array.isArray(rule.tiers_json) && rule.tiers_json.length > 0) {
    let matchedPct = rule.flat_rate_pct;
    for (const tier of rule.tiers_json) {
      const minV = toNum(tier.min_vnd, 0);
      const maxV = tier.max_vnd !== null && tier.max_vnd !== undefined ? toNum(tier.max_vnd, Infinity) : Infinity;
      if (revenueVnd >= minV && revenueVnd <= maxV) {
        matchedPct = toNum(tier.rate_pct, rule.flat_rate_pct);
      }
    }
    return Math.round((revenueVnd * matchedPct) / 100);
  }
  return Math.round((revenueVnd * Math.max(0, rule.flat_rate_pct)) / 100);
}

async function recalculatePeriodTotalsInTx(client: any, tenantId: string, periodId: string): Promise<void> {
  const aggRes = await client.query(
    `SELECT
       COUNT(*)::int AS cnt,
       COALESCE(SUM(gross_pay_vnd), 0) AS total_gross,
       COALESCE(SUM(emp_bhxh_vnd + emp_bhyt_vnd + emp_bhtn_vnd), 0) AS total_emp_ins,
       COALESCE(SUM(er_insurance_total_vnd), 0) AS total_er_ins,
       COALESCE(SUM(pit_tax_vnd), 0) AS total_pit,
       COALESCE(SUM(commission_pay_vnd), 0) AS total_comm,
       COALESCE(SUM(net_pay_vnd), 0) AS total_net
     FROM tenant_payroll_slips
     WHERE tenant_id = $1 AND period_id = $2`,
    [tenantId, periodId]
  );
  const a = aggRes.rows[0] || {};
  await client.query(
    `UPDATE tenant_payroll_periods
     SET employee_count = $3,
         total_gross_vnd = $4,
         total_emp_insurance_vnd = $5,
         total_er_insurance_vnd = $6,
         total_pit_tax_vnd = $7,
         total_commission_vnd = $8,
         total_net_vnd = $9,
         updated_at = clock_timestamp()
     WHERE tenant_id = $1 AND id = $2`,
    [
      tenantId,
      periodId,
      Number(a.cnt || 0),
      toNum(a.total_gross, 0),
      toNum(a.total_emp_ins, 0),
      toNum(a.total_er_ins, 0),
      toNum(a.total_pit, 0),
      toNum(a.total_comm, 0),
      toNum(a.total_net, 0),
    ]
  );
}

export const payrollRouter = Router();

payrollRouter.use(ensureHrmApprovalsSchemaMiddleware);
payrollRouter.use(requireTenantAuth);
payrollRouter.use(requireEntitlement('payroll'));

// ============================================================================
// 1. Payroll Tax & Insurance Config (`/config`) & Gross-to-Net Simulator (`/simulate`)
// ============================================================================
payrollRouter.get('/config', requirePermission('payroll', 'view'), async (_req, res) => {
  try {
    const ctx = getTenantContext();
    const cfg = await withTenantTransaction(ctx.tenantId, (client) =>
      getOrSeedTenantPayrollConfigInTx(client, ctx.tenantId)
    );
    res.json({ success: true, data: cfg });
  } catch (err: any) {
    sendApiError(res, 500, 'GET_PAYROLL_CONFIG_FAILED', err?.message || 'Không thể tải cấu hình Thuế & Bảo hiểm.');
  }
});

const updateConfigHandler = async (req: any, res: any) => {
  try {
    const ctx = getTenantContext();
    const b = req.body || {};

    const updated = await withTenantTransaction(ctx.tenantId, async (client) => {
      const cur = await getOrSeedTenantPayrollConfigInTx(client, ctx.tenantId);

      const nextBrackets: PitBracket[] = Array.isArray(b.pit_brackets) ? b.pit_brackets : cur.pit_brackets;
      const nextAllowances: AllowanceDefinition[] = Array.isArray(b.allowance_definitions)
        ? b.allowance_definitions
        : cur.allowance_definitions;

      await client.query(
        `UPDATE tenant_payroll_configs
         SET currency = $2,
             standard_workdays_mode = $3,
             fixed_standard_workdays = $4,
             saturday_work_mode = $5,
             emp_bhxh_rate = $6,
             emp_bhyt_rate = $7,
             emp_bhtn_rate = $8,
             er_bhxh_rate = $9,
             er_bhyt_rate = $10,
             er_bhtn_rate = $11,
             er_union_rate = $12,
             emp_union_rate = $13,
             bhxh_salary_cap_vnd = $14,
             bhtn_salary_cap_vnd = $15,
             personal_deduction_vnd = $16,
             dependent_deduction_vnd = $17,
             meal_allowance_exempt_cap_vnd = $18,
             non_resident_flat_tax_rate = $19,
             casual_withholding_threshold_vnd = $20,
             casual_flat_tax_rate = $21,
             pit_brackets = $22::jsonb,
             allowance_definitions = $23::jsonb,
             tax_authority_code = $24,
             tax_authority_name = $25,
             updated_by = $26,
             updated_at = clock_timestamp()
         WHERE tenant_id = $1`,
        [
          ctx.tenantId,
          b.currency ? String(b.currency).trim().toUpperCase() : cur.currency,
          b.standard_workdays_mode === 'fixed'
            ? 'fixed'
            : b.standard_workdays_mode === 'calendar'
              ? 'calendar'
              : cur.standard_workdays_mode,
          b.fixed_standard_workdays !== undefined ? toNum(b.fixed_standard_workdays, 22) : cur.fixed_standard_workdays,
          b.saturday_work_mode !== undefined ? String(b.saturday_work_mode) : cur.saturday_work_mode,
          b.emp_bhxh_rate !== undefined ? toNum(b.emp_bhxh_rate, 0.08) : cur.emp_bhxh_rate,
          b.emp_bhyt_rate !== undefined ? toNum(b.emp_bhyt_rate, 0.015) : cur.emp_bhyt_rate,
          b.emp_bhtn_rate !== undefined ? toNum(b.emp_bhtn_rate, 0.01) : cur.emp_bhtn_rate,
          b.er_bhxh_rate !== undefined ? toNum(b.er_bhxh_rate, 0.175) : cur.er_bhxh_rate,
          b.er_bhyt_rate !== undefined ? toNum(b.er_bhyt_rate, 0.03) : cur.er_bhyt_rate,
          b.er_bhtn_rate !== undefined ? toNum(b.er_bhtn_rate, 0.01) : cur.er_bhtn_rate,
          b.er_union_rate !== undefined ? toNum(b.er_union_rate, 0.02) : cur.er_union_rate,
          b.emp_union_rate !== undefined ? toNum(b.emp_union_rate, 0.01) : cur.emp_union_rate,
          b.bhxh_salary_cap_vnd !== undefined ? toNum(b.bhxh_salary_cap_vnd, 46800000) : cur.bhxh_salary_cap_vnd,
          b.bhtn_salary_cap_vnd !== undefined ? toNum(b.bhtn_salary_cap_vnd, 99200000) : cur.bhtn_salary_cap_vnd,
          b.personal_deduction_vnd !== undefined ? toNum(b.personal_deduction_vnd, 11000000) : cur.personal_deduction_vnd,
          b.dependent_deduction_vnd !== undefined ? toNum(b.dependent_deduction_vnd, 4400000) : cur.dependent_deduction_vnd,
          b.meal_allowance_exempt_cap_vnd !== undefined
            ? toNum(b.meal_allowance_exempt_cap_vnd, 730000)
            : cur.meal_allowance_exempt_cap_vnd,
          b.non_resident_flat_tax_rate !== undefined
            ? toNum(b.non_resident_flat_tax_rate, 0.2)
            : cur.non_resident_flat_tax_rate,
          b.casual_withholding_threshold_vnd !== undefined
            ? toNum(b.casual_withholding_threshold_vnd, 2000000)
            : cur.casual_withholding_threshold_vnd,
          b.casual_flat_tax_rate !== undefined ? toNum(b.casual_flat_tax_rate, 0.1) : cur.casual_flat_tax_rate,
          JSON.stringify(nextBrackets),
          JSON.stringify(nextAllowances),
          b.tax_authority_code !== undefined ? b.tax_authority_code || null : cur.tax_authority_code,
          b.tax_authority_name !== undefined ? b.tax_authority_name || null : cur.tax_authority_name,
          ctx.userId,
        ]
      );

      return getOrSeedTenantPayrollConfigInTx(client, ctx.tenantId);
    });

    res.json({ success: true, data: updated });
  } catch (err: any) {
    sendApiError(res, 500, 'UPDATE_PAYROLL_CONFIG_FAILED', err?.message || 'Không thể lưu cấu hình Thuế & Bảo hiểm.');
  }
};

payrollRouter.put('/config', requirePermission('payroll', 'manage_config'), updateConfigHandler);
payrollRouter.patch('/config', requirePermission('payroll', 'manage_config'), updateConfigHandler);

payrollRouter.post('/simulate', requirePermission('payroll', 'view'), async (req, res) => {
  try {
    const ctx = getTenantContext();
    const b = req.body || {};
    const mode = b.mode === 'net_to_gross' ? 'net_to_gross' : 'gross_to_net';
    const amountVnd = Math.max(0, toNum(b.amount_vnd, 0));

    const result = await withTenantTransaction(ctx.tenantId, async (client) => {
      const cfg = await getOrSeedTenantPayrollConfigInTx(client, ctx.tenantId);
      return simulateGrossNet(
        {
          mode,
          amount_vnd: amountVnd,
          dependents_count: Math.max(0, Number(b.dependents_count || 0)),
          insurance_salary_vnd: b.insurance_salary_vnd ? toNum(b.insurance_salary_vnd, 0) : null,
          is_resident: b.is_resident !== false,
        },
        cfg
      );
    });

    res.json({ success: true, data: result });
  } catch (err: any) {
    sendApiError(res, 500, 'SIMULATE_GROSS_NET_FAILED', err?.message || 'Không thể chạy mô phỏng Gross - Net.');
  }
});

// ============================================================================
// 2. Commission Rules Studio & Ledgers (`/commission-rules`, `/commissions`)
// ============================================================================
payrollRouter.get('/commission-rules', requirePermission('payroll', 'view'), async (_req, res) => {
  try {
    const ctx = getTenantContext();
    const rows = await withTenantTransaction(ctx.tenantId, async (client) => {
      const r = await client.query(
        `SELECT cr.*, tr.name AS role_name, d.name AS department_name
         FROM tenant_commission_rules cr
         LEFT JOIN tenant_roles tr ON tr.tenant_id = cr.tenant_id AND tr.id = cr.applies_to_role_id
         LEFT JOIN tenant_departments d ON d.tenant_id = cr.tenant_id AND d.id = cr.applies_to_department_id
         WHERE cr.tenant_id = $1
         ORDER BY cr.is_active DESC, cr.created_at ASC`,
        [ctx.tenantId]
      );
      return r.rows.map((x) => ({
        ...x,
        flat_rate_pct: toNum(x.flat_rate_pct, 0),
        fixed_amount_vnd: toNum(x.fixed_amount_vnd, 0),
        min_revenue_threshold_vnd: toNum(x.min_revenue_threshold_vnd, 0),
        is_active: toBool(x.is_active, true),
        tiers_json: parseJsonSafe<any[]>(x.tiers_json, []),
      }));
    });
    res.json({ success: true, data: rows });
  } catch (err: any) {
    sendApiError(res, 500, 'LIST_COMMISSION_RULES_FAILED', err?.message || 'Không thể tải quy tắc hoa hồng.');
  }
});

payrollRouter.post('/commission-rules', requirePermission('payroll', 'manage_config'), async (req, res) => {
  try {
    const ctx = getTenantContext();
    const b = req.body || {};
    const name = String(b.name || '').trim();
    if (!name) {
      sendApiError(res, 422, 'VALIDATION_ERROR', 'Tên chính sách hoa hồng không được để trống.');
      return;
    }

    const id = crypto.randomUUID();
    const created = await withTenantTransaction(ctx.tenantId, async (client) => {
      await client.query(
        `INSERT INTO tenant_commission_rules (
           id, tenant_id, name, description, applies_to_role_id, applies_to_department_id,
           rule_type, flat_rate_pct, fixed_amount_vnd, tiers_json, min_revenue_threshold_vnd, is_active
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb, $11, $12)`,
        [
          id,
          ctx.tenantId,
          name,
          b.description ? String(b.description).trim() : null,
          b.applies_to_role_id || null,
          b.applies_to_department_id || null,
          b.rule_type || 'percentage_revenue',
          Math.max(0, toNum(b.flat_rate_pct, 3)),
          Math.max(0, toNum(b.fixed_amount_vnd, 0)),
          JSON.stringify(Array.isArray(b.tiers_json) ? b.tiers_json : []),
          Math.max(0, toNum(b.min_revenue_threshold_vnd, 0)),
          b.is_active !== false,
        ]
      );
      const r = await client.query('SELECT * FROM tenant_commission_rules WHERE tenant_id = $1 AND id = $2', [
        ctx.tenantId,
        id,
      ]);
      return r.rows[0];
    });

    res.status(201).json({ success: true, data: created });
  } catch (err: any) {
    sendApiError(res, 500, 'CREATE_COMMISSION_RULE_FAILED', err?.message || 'Không thể tạo quy tắc hoa hồng.');
  }
});

payrollRouter.delete('/commission-rules/:id', requirePermission('payroll', 'manage_config'), async (req, res) => {
  try {
    const ctx = getTenantContext();
    await withTenantTransaction(ctx.tenantId, async (client) => {
      await client.query('DELETE FROM tenant_commission_rules WHERE tenant_id = $1 AND id = $2', [
        ctx.tenantId,
        req.params.id,
      ]);
    });
    res.json({ success: true, data: { deleted: true, id: req.params.id } });
  } catch (err: any) {
    sendApiError(res, 500, 'DELETE_COMMISSION_RULE_FAILED', err?.message || 'Không thể xóa quy tắc hoa hồng.');
  }
});

payrollRouter.get('/commissions', requirePermission('payroll', 'view'), async (req, res) => {
  try {
    const ctx = getTenantContext();
    const periodKey = req.query.period_key ? String(req.query.period_key).slice(0, 7) : null;

    const rows = await withTenantTransaction(ctx.tenantId, async (client) => {
      const rbac = await resolveUserEffectivePermissions(client, ctx.tenantId, ctx.userId);
      const payScope = rbac.effectivePermissions.payroll?.scope || 'own';
      const scopeSql = rbac.userOrg
        ? await buildGranularScopeWhereClause(client, ctx.tenantId, rbac.userOrg, payScope, {
            tenantColumn: 'cl.tenant_id',
            ownerColumn: 'cl.user_id',
            startParamIndex: 1,
          })
        : { clause: 'cl.tenant_id = $1', values: [ctx.tenantId], nextIndex: 2 };

      const params = [...scopeSql.values];
      let where = scopeSql.clause;
      if (periodKey) {
        params.push(periodKey);
        where += ` AND cl.period_key = $${params.length}`;
      }

      const r = await client.query(
        `SELECT cl.*, u.full_name AS user_name, cr.name AS rule_name
         FROM tenant_commission_ledgers cl
         LEFT JOIN users u ON u.tenant_id = cl.tenant_id AND u.id = cl.user_id
         LEFT JOIN tenant_commission_rules cr ON cr.tenant_id = cl.tenant_id AND cr.id = cl.rule_id
         WHERE ${where}
         ORDER BY cl.created_at DESC`,
        params
      );
      return r.rows.map((x) => ({
        ...x,
        revenue_base_vnd: toNum(x.revenue_base_vnd, 0),
        commission_amount_vnd: toNum(x.commission_amount_vnd, 0),
      }));
    });

    res.json({ success: true, data: rows });
  } catch (err: any) {
    sendApiError(res, 500, 'LIST_COMMISSIONS_FAILED', err?.message || 'Không thể tải sổ hoa hồng.');
  }
});

payrollRouter.post('/commissions', requirePermission('payroll', 'create'), async (req, res) => {
  try {
    const ctx = getTenantContext();
    const b = req.body || {};
    const periodKey = String(b.period_key || new Date().toISOString().slice(0, 7)).slice(0, 7);
    const userId = String(b.user_id || ctx.userId).trim();
    const sourceTitle = String(b.source_title || 'Hoa hồng doanh số chốt Deal').trim();

    const id = crypto.randomUUID();
    const created = await withTenantTransaction(ctx.tenantId, async (client) => {
      const empRes = await client.query(
        'SELECT id FROM tenant_hr_employees WHERE tenant_id = $1 AND user_id = $2 LIMIT 1',
        [ctx.tenantId, userId]
      );
      await client.query(
        `INSERT INTO tenant_commission_ledgers (
           id, tenant_id, period_key, employee_id, user_id, rule_id, lead_id,
           source_title, revenue_base_vnd, commission_amount_vnd, status, notes
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
        [
          id,
          ctx.tenantId,
          periodKey,
          b.employee_id || empRes.rows[0]?.id || null,
          userId,
          b.rule_id || null,
          b.lead_id || null,
          sourceTitle,
          Math.max(0, toNum(b.revenue_base_vnd, 0)),
          Math.max(0, toNum(b.commission_amount_vnd, 0)),
          b.status || 'approved',
          b.notes ? String(b.notes).trim() : null,
        ]
      );
      const r = await client.query('SELECT * FROM tenant_commission_ledgers WHERE tenant_id = $1 AND id = $2', [
        ctx.tenantId,
        id,
      ]);
      return r.rows[0];
    });

    res.status(201).json({ success: true, data: created });
  } catch (err: any) {
    sendApiError(res, 500, 'CREATE_COMMISSION_LEDGER_FAILED', err?.message || 'Không thể ghi nhận khoản hoa hồng.');
  }
});

payrollRouter.post('/commissions/sync-won-leads', requirePermission('payroll', 'create'), async (req, res) => {
  try {
    const ctx = getTenantContext();
    const periodKey = String(req.body?.period_key || new Date().toISOString().slice(0, 7)).slice(0, 7);

    const synced = await withTenantTransaction(ctx.tenantId, async (client) => {
      const [rulesRes, wonLeadsRes, existingLedgersRes, empsRes] = await Promise.all([
        client.query(
          'SELECT * FROM tenant_commission_rules WHERE tenant_id = $1 AND is_active = true ORDER BY created_at ASC',
          [ctx.tenantId]
        ),
        client.query(
          `SELECT l.id, l.name, l.assigned_to, l.total_revenue_vnd, u.role_id, u.department_id
           FROM leads l
           LEFT JOIN tenant_pipeline_stages s ON s.tenant_id = l.tenant_id AND s.id = l.stage_id
           LEFT JOIN users u ON u.tenant_id = l.tenant_id AND u.id = l.assigned_to
           WHERE l.tenant_id = $1
             AND l.is_deleted = false
             AND l.assigned_to IS NOT NULL
             AND (s.is_won_stage = true OR l.total_revenue_vnd > 0)`,
          [ctx.tenantId]
        ),
        client.query<{ lead_id: string }>(
          'SELECT lead_id FROM tenant_commission_ledgers WHERE tenant_id = $1 AND period_key = $2 AND lead_id IS NOT NULL',
          [ctx.tenantId, periodKey]
        ),
        client.query<{ id: string; user_id: string }>(
          'SELECT id, user_id FROM tenant_hr_employees WHERE tenant_id = $1 AND user_id IS NOT NULL',
          [ctx.tenantId]
        ),
      ]);

      const defaultRule = rulesRes.rows[0]
        ? {
            id: String(rulesRes.rows[0].id),
            rule_type: String(rulesRes.rows[0].rule_type),
            flat_rate_pct: toNum(rulesRes.rows[0].flat_rate_pct, 3),
            fixed_amount_vnd: toNum(rulesRes.rows[0].fixed_amount_vnd, 0),
            min_revenue_threshold_vnd: toNum(rulesRes.rows[0].min_revenue_threshold_vnd, 0),
            tiers_json: parseJsonSafe<any[]>(rulesRes.rows[0].tiers_json, []),
          }
        : null;

      if (!defaultRule) {
        return { synced_count: 0, message: 'Chưa có quy tắc hoa hồng đang bật.' };
      }

      const existingLeadSet = new Set(existingLedgersRes.rows.map((r) => String(r.lead_id)));
      const empByUser = new Map<string, string>();
      for (const e of empsRes.rows) empByUser.set(String(e.user_id), String(e.id));

      let syncedCount = 0;
      for (const lead of wonLeadsRes.rows) {
        const lid = String(lead.id);
        if (existingLeadSet.has(lid)) continue;
        const rev = toNum(lead.total_revenue_vnd, 0);
        const commAmt = computeCommissionFromRule(rev, 1, defaultRule);
        if (commAmt <= 0) continue;

        const uid = String(lead.assigned_to);
        await client.query(
          `INSERT INTO tenant_commission_ledgers (
             id, tenant_id, period_key, employee_id, user_id, rule_id, lead_id,
             source_title, revenue_base_vnd, commission_amount_vnd, status
           ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'approved')`,
          [
            crypto.randomUUID(),
            ctx.tenantId,
            periodKey,
            empByUser.get(uid) || null,
            uid,
            defaultRule.id,
            lid,
            `Hoa hồng Deal thắng: ${lead.name}`,
            rev,
            commAmt,
          ]
        );
        syncedCount++;
      }

      return { synced_count: syncedCount };
    });

    res.json({ success: true, data: synced });
  } catch (err: any) {
    sendApiError(res, 500, 'SYNC_WON_COMMISSIONS_FAILED', err?.message || 'Không thể đồng bộ hoa hồng từ Deal thắng.');
  }
});

// ============================================================================
// 3. Payroll Period Generator, Payslips & HTKK XML / CSV Exporter (`/periods`)
// ============================================================================
payrollRouter.get('/periods', requirePermission('payroll', 'view'), async (_req, res) => {
  try {
    const ctx = getTenantContext();
    const rows = await withTenantTransaction(ctx.tenantId, async (client) => {
      const r = await client.query(
        'SELECT * FROM tenant_payroll_periods WHERE tenant_id = $1 ORDER BY year DESC, month DESC',
        [ctx.tenantId]
      );
      return r.rows.map((p) => ({
        ...p,
        standard_workdays: toNum(p.standard_workdays, 22),
        employee_count: Number(p.employee_count || 0),
        total_gross_vnd: toNum(p.total_gross_vnd, 0),
        total_emp_insurance_vnd: toNum(p.total_emp_insurance_vnd, 0),
        total_er_insurance_vnd: toNum(p.total_er_insurance_vnd, 0),
        total_pit_tax_vnd: toNum(p.total_pit_tax_vnd, 0),
        total_commission_vnd: toNum(p.total_commission_vnd, 0),
        total_net_vnd: toNum(p.total_net_vnd, 0),
      }));
    });
    res.json({ success: true, data: rows });
  } catch (err: any) {
    sendApiError(res, 500, 'LIST_PAYROLL_PERIODS_FAILED', err?.message || 'Không thể tải danh sách kỳ lương.');
  }
});

payrollRouter.post('/periods/generate', requirePermission('payroll', 'create'), async (req, res) => {
  try {
    const ctx = getTenantContext();
    const b = req.body || {};
    const rawPeriod = String(b.period_key || '').trim();
    const now = new Date();
    let year = Number(b.year || now.getFullYear());
    let month = Number(b.month || now.getMonth() + 1);
    if (/^\d{4}-\d{2}$/.test(rawPeriod)) {
      const [y, m] = rawPeriod.split('-').map(Number);
      year = y;
      month = m;
    }
    month = Math.min(12, Math.max(1, month));
    const periodKey = `${year}-${String(month).padStart(2, '0')}`;
    const lastDay = new Date(year, month, 0).getDate();
    const startDate = `${periodKey}-01`;
    const endDate = `${periodKey}-${String(lastDay).padStart(2, '0')}`;
    const autoFullWhenNoLogs = b.use_full_attendance_when_empty !== false;

    const generated = await withTenantTransaction(ctx.tenantId, async (client) => {
      const cfg = await getOrSeedTenantPayrollConfigInTx(client, ctx.tenantId);
      const stdWorkdays = computeStandardWorkdaysForMonth(year, month, cfg);

      // Ensure period row exists (and is not locked)
      const existingPeriodRes = await client.query(
        'SELECT * FROM tenant_payroll_periods WHERE tenant_id = $1 AND period_key = $2 LIMIT 1',
        [ctx.tenantId, periodKey]
      );
      let periodId: string;
      if (existingPeriodRes.rows.length > 0) {
        if (existingPeriodRes.rows[0].status === 'locked') {
          throw new Error('PERIOD_LOCKED');
        }
        periodId = String(existingPeriodRes.rows[0].id);
        await client.query(
          `UPDATE tenant_payroll_periods
           SET standard_workdays = $3, status = 'calculated', updated_at = clock_timestamp()
           WHERE tenant_id = $1 AND id = $2`,
          [ctx.tenantId, periodId, stdWorkdays]
        );
      } else {
        periodId = crypto.randomUUID();
        const title = b.title
          ? String(b.title).trim()
          : `Bảng lương Tháng ${String(month).padStart(2, '0')}/${year}`;
        await client.query(
          `INSERT INTO tenant_payroll_periods (
             id, tenant_id, period_key, year, month, title, branch_id, standard_workdays, status, created_by
           ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'calculated', $9)`,
          [periodId, ctx.tenantId, periodKey, year, month, title, b.branch_id || null, stdWorkdays, ctx.userId]
        );
      }

      // Fetch active employees + attendance logs + commissions
      const [empsRes, attLogsRes, commRes] = await Promise.all([
        client.query(
          `SELECT * FROM tenant_hr_employees
           WHERE tenant_id = $1 AND employment_status IN ('active', 'probation')
           ORDER BY employee_code ASC`,
          [ctx.tenantId]
        ),
        client.query(
          `SELECT user_id, employee_id,
                  COUNT(*)::int AS log_count,
                  COALESCE(SUM(work_units), 0) AS sum_units,
                  COALESCE(SUM(overtime_hours), 0) AS sum_ot
           FROM tenant_hr_attendance_logs
           WHERE tenant_id = $1 AND work_date >= $2 AND work_date <= $3
           GROUP BY user_id, employee_id`,
          [ctx.tenantId, startDate, endDate]
        ),
        client.query(
          `SELECT user_id, employee_id, COALESCE(SUM(commission_amount_vnd), 0) AS sum_comm
           FROM tenant_commission_ledgers
           WHERE tenant_id = $1 AND period_key = $2 AND status IN ('approved', 'paid')
           GROUP BY user_id, employee_id`,
          [ctx.tenantId, periodKey]
        ),
      ]);

      const attByEmp = new Map<string, { logCount: number; units: number; ot: number }>();
      const attByUser = new Map<string, { logCount: number; units: number; ot: number }>();
      for (const a of attLogsRes.rows) {
        const rec = {
          logCount: Number(a.log_count || 0),
          units: toNum(a.sum_units, 0),
          ot: toNum(a.sum_ot, 0),
        };
        if (a.employee_id) attByEmp.set(String(a.employee_id), rec);
        if (a.user_id) attByUser.set(String(a.user_id), rec);
      }

      const commByEmp = new Map<string, number>();
      const commByUser = new Map<string, number>();
      for (const c of commRes.rows) {
        const amt = toNum(c.sum_comm, 0);
        if (c.employee_id) commByEmp.set(String(c.employee_id), (commByEmp.get(String(c.employee_id)) || 0) + amt);
        if (c.user_id) commByUser.set(String(c.user_id), (commByUser.get(String(c.user_id)) || 0) + amt);
      }

      // Clear existing slips for clean recalculation
      await client.query('DELETE FROM tenant_payroll_slips WHERE tenant_id = $1 AND period_id = $2', [
        ctx.tenantId,
        periodId,
      ]);

      for (const emp of empsRes.rows) {
        const empId = String(emp.id);
        const uid = emp.user_id ? String(emp.user_id) : null;
        const att = attByEmp.get(empId) || (uid ? attByUser.get(uid) : undefined);

        const actualWorkdays =
          att && att.logCount > 0 ? att.units : autoFullWhenNoLogs ? stdWorkdays : 0;
        const otHours = att ? att.ot : 0;
        const commAmt = commByEmp.has(empId)
          ? commByEmp.get(empId)!
          : uid
            ? commByUser.get(uid) || 0
            : 0;

        const calc = calculateEmployeePayslip(
          {
            base_salary_vnd: toNum(emp.base_salary_vnd, 0),
            insurance_salary_vnd: toNum(emp.insurance_salary_vnd, 0),
            insurance_enrolled: toBool(emp.insurance_enrolled, true),
            is_resident: toBool(emp.is_resident, true),
            employment_type: String(emp.employment_type || 'full_time'),
            dependents_count: Number(emp.dependents_count || 0),
            union_member: toBool(emp.union_member, false),
            allowances_map: parseJsonSafe<Record<string, number>>(emp.allowances_json, {}),
            standard_workdays: stdWorkdays,
            actual_workdays: actualWorkdays,
            paid_leave_days: 0,
            unpaid_leave_days: 0,
            overtime_hours: otHours,
            commission_pay_vnd: commAmt,
          },
          cfg
        );

        await client.query(
          `INSERT INTO tenant_payroll_slips (
             id, tenant_id, period_id, employee_id, user_id,
             standard_workdays, actual_workdays, paid_leave_days, unpaid_leave_days, overtime_hours,
             base_salary_vnd, prorated_base_pay_vnd, allowances_vnd, tax_exempt_vnd,
             overtime_pay_vnd, commission_pay_vnd, bonus_vnd, gross_pay_vnd,
             insurance_salary_base_vnd, emp_bhxh_vnd, emp_bhyt_vnd, emp_bhtn_vnd,
             emp_union_vnd, er_insurance_total_vnd, dependents_count, family_deduction_vnd,
             taxable_income_vnd, assessable_income_vnd, pit_tax_vnd,
             advance_deduction_vnd, other_deduction_vnd, net_pay_vnd,
             tax_method, payment_status, breakdown
           ) VALUES (
             $1, $2, $3, $4, $5,
             $6, $7, $8, $9, $10,
             $11, $12, $13, $14,
             $15, $16, $17, $18,
             $19, $20, $21, $22,
             $23, $24, $25, $26,
             $27, $28, $29,
             $30, $31, $32,
             $33, 'unpaid', $34::jsonb
           )`,
          [
            crypto.randomUUID(),
            ctx.tenantId,
            periodId,
            empId,
            uid,
            calc.standard_workdays,
            calc.actual_workdays,
            calc.paid_leave_days,
            calc.unpaid_leave_days,
            calc.overtime_hours,
            calc.base_salary_vnd,
            calc.prorated_base_pay_vnd,
            calc.allowances_vnd,
            calc.tax_exempt_vnd,
            calc.overtime_pay_vnd,
            calc.commission_pay_vnd,
            calc.bonus_vnd,
            calc.gross_pay_vnd,
            calc.insurance_salary_base_vnd,
            calc.emp_bhxh_vnd,
            calc.emp_bhyt_vnd,
            calc.emp_bhtn_vnd,
            calc.emp_union_vnd,
            calc.er_insurance_total_vnd,
            calc.dependents_count,
            calc.family_deduction_vnd,
            calc.taxable_income_vnd,
            calc.assessable_income_vnd,
            calc.pit_tax_vnd,
            calc.advance_deduction_vnd,
            calc.other_deduction_vnd,
            calc.net_pay_vnd,
            calc.tax_method,
            JSON.stringify({
              pit_breakdown: calc.pit_breakdown,
              allowance_lines: calc.allowance_lines,
              er_bhxh_vnd: calc.er_bhxh_vnd,
              er_bhyt_vnd: calc.er_bhyt_vnd,
              er_bhtn_vnd: calc.er_bhtn_vnd,
              er_union_vnd: calc.er_union_vnd,
            }),
          ]
        );
      }

      await recalculatePeriodTotalsInTx(client, ctx.tenantId, periodId);

      const [periodOut, slipsOut] = await Promise.all([
        client.query('SELECT * FROM tenant_payroll_periods WHERE tenant_id = $1 AND id = $2', [
          ctx.tenantId,
          periodId,
        ]),
        client.query(
          `SELECT s.*, e.employee_code, e.full_name AS employee_name, e.tax_code, e.bank_name, e.bank_account_number,
                  d.name AS department_name
           FROM tenant_payroll_slips s
           INNER JOIN tenant_hr_employees e ON e.tenant_id = s.tenant_id AND e.id = s.employee_id
           LEFT JOIN tenant_departments d ON d.tenant_id = e.tenant_id AND d.id = e.department_id
           WHERE s.tenant_id = $1 AND s.period_id = $2
           ORDER BY e.employee_code ASC`,
          [ctx.tenantId, periodId]
        ),
      ]);

      return {
        period: {
          ...periodOut.rows[0],
          standard_workdays: toNum(periodOut.rows[0]?.standard_workdays, 22),
          total_gross_vnd: toNum(periodOut.rows[0]?.total_gross_vnd, 0),
          total_emp_insurance_vnd: toNum(periodOut.rows[0]?.total_emp_insurance_vnd, 0),
          total_er_insurance_vnd: toNum(periodOut.rows[0]?.total_er_insurance_vnd, 0),
          total_pit_tax_vnd: toNum(periodOut.rows[0]?.total_pit_tax_vnd, 0),
          total_commission_vnd: toNum(periodOut.rows[0]?.total_commission_vnd, 0),
          total_net_vnd: toNum(periodOut.rows[0]?.total_net_vnd, 0),
        },
        slips: slipsOut.rows.map((s) => ({
          ...s,
          standard_workdays: toNum(s.standard_workdays, 22),
          actual_workdays: toNum(s.actual_workdays, 0),
          overtime_hours: toNum(s.overtime_hours, 0),
          base_salary_vnd: toNum(s.base_salary_vnd, 0),
          prorated_base_pay_vnd: toNum(s.prorated_base_pay_vnd, 0),
          allowances_vnd: toNum(s.allowances_vnd, 0),
          tax_exempt_vnd: toNum(s.tax_exempt_vnd, 0),
          overtime_pay_vnd: toNum(s.overtime_pay_vnd, 0),
          commission_pay_vnd: toNum(s.commission_pay_vnd, 0),
          bonus_vnd: toNum(s.bonus_vnd, 0),
          gross_pay_vnd: toNum(s.gross_pay_vnd, 0),
          emp_bhxh_vnd: toNum(s.emp_bhxh_vnd, 0),
          emp_bhyt_vnd: toNum(s.emp_bhyt_vnd, 0),
          emp_bhtn_vnd: toNum(s.emp_bhtn_vnd, 0),
          emp_union_vnd: toNum(s.emp_union_vnd, 0),
          er_insurance_total_vnd: toNum(s.er_insurance_total_vnd, 0),
          family_deduction_vnd: toNum(s.family_deduction_vnd, 0),
          taxable_income_vnd: toNum(s.taxable_income_vnd, 0),
          assessable_income_vnd: toNum(s.assessable_income_vnd, 0),
          pit_tax_vnd: toNum(s.pit_tax_vnd, 0),
          advance_deduction_vnd: toNum(s.advance_deduction_vnd, 0),
          other_deduction_vnd: toNum(s.other_deduction_vnd, 0),
          net_pay_vnd: toNum(s.net_pay_vnd, 0),
          breakdown: parseJsonSafe<Record<string, unknown>>(s.breakdown, {}),
        })),
      };
    });

    res.status(201).json({ success: true, data: generated });
  } catch (err: any) {
    if (err?.message === 'PERIOD_LOCKED') {
      sendApiError(res, 409, 'PERIOD_LOCKED', 'Kỳ lương này đã chốt khóa sổ, không thể tính lại.');
      return;
    }
    sendApiError(res, 500, 'GENERATE_PAYROLL_FAILED', err?.message || 'Không thể tổng hợp kỳ lương.');
  }
});

payrollRouter.get('/periods/:id', requirePermission('payroll', 'view'), async (req, res) => {
  try {
    const ctx = getTenantContext();
    const id = String(req.params.id);

    const detail = await withTenantTransaction(ctx.tenantId, async (client) => {
      const pRes = await client.query(
        'SELECT * FROM tenant_payroll_periods WHERE tenant_id = $1 AND id = $2 LIMIT 1',
        [ctx.tenantId, id]
      );
      if (pRes.rows.length === 0) return null;

      const rbac = await resolveUserEffectivePermissions(client, ctx.tenantId, ctx.userId);
      const payScope = rbac.effectivePermissions.payroll?.scope || 'own';
      const scopeSql = rbac.userOrg
        ? await buildGranularScopeWhereClause(client, ctx.tenantId, rbac.userOrg, payScope, {
            tenantColumn: 's.tenant_id',
            ownerColumn: 's.user_id',
            startParamIndex: 1,
            allowUnassignedForManagers: true,
          })
        : { clause: 's.tenant_id = $1', values: [ctx.tenantId], nextIndex: 2 };

      const params = [...scopeSql.values, id];
      const pIdParam = `$${params.length}`;
      const slipsRes = await client.query(
        `SELECT s.*, e.employee_code, e.full_name AS employee_name, e.tax_code,
                e.bank_name, e.bank_account_number, e.is_resident, e.employment_type,
                d.name AS department_name
         FROM tenant_payroll_slips s
         INNER JOIN tenant_hr_employees e ON e.tenant_id = s.tenant_id AND e.id = s.employee_id
         LEFT JOIN tenant_departments d ON d.tenant_id = e.tenant_id AND d.id = e.department_id
         WHERE ${scopeSql.clause} AND s.period_id = ${pIdParam}
         ORDER BY e.employee_code ASC`,
        params
      );

      const p = pRes.rows[0];
      return {
        period: {
          ...p,
          standard_workdays: toNum(p.standard_workdays, 22),
          total_gross_vnd: toNum(p.total_gross_vnd, 0),
          total_emp_insurance_vnd: toNum(p.total_emp_insurance_vnd, 0),
          total_er_insurance_vnd: toNum(p.total_er_insurance_vnd, 0),
          total_pit_tax_vnd: toNum(p.total_pit_tax_vnd, 0),
          total_commission_vnd: toNum(p.total_commission_vnd, 0),
          total_net_vnd: toNum(p.total_net_vnd, 0),
        },
        slips: slipsRes.rows.map((s) => ({
          ...s,
          standard_workdays: toNum(s.standard_workdays, 22),
          actual_workdays: toNum(s.actual_workdays, 0),
          overtime_hours: toNum(s.overtime_hours, 0),
          base_salary_vnd: toNum(s.base_salary_vnd, 0),
          prorated_base_pay_vnd: toNum(s.prorated_base_pay_vnd, 0),
          allowances_vnd: toNum(s.allowances_vnd, 0),
          tax_exempt_vnd: toNum(s.tax_exempt_vnd, 0),
          overtime_pay_vnd: toNum(s.overtime_pay_vnd, 0),
          commission_pay_vnd: toNum(s.commission_pay_vnd, 0),
          bonus_vnd: toNum(s.bonus_vnd, 0),
          gross_pay_vnd: toNum(s.gross_pay_vnd, 0),
          emp_bhxh_vnd: toNum(s.emp_bhxh_vnd, 0),
          emp_bhyt_vnd: toNum(s.emp_bhyt_vnd, 0),
          emp_bhtn_vnd: toNum(s.emp_bhtn_vnd, 0),
          emp_union_vnd: toNum(s.emp_union_vnd, 0),
          er_insurance_total_vnd: toNum(s.er_insurance_total_vnd, 0),
          family_deduction_vnd: toNum(s.family_deduction_vnd, 0),
          taxable_income_vnd: toNum(s.taxable_income_vnd, 0),
          assessable_income_vnd: toNum(s.assessable_income_vnd, 0),
          pit_tax_vnd: toNum(s.pit_tax_vnd, 0),
          advance_deduction_vnd: toNum(s.advance_deduction_vnd, 0),
          other_deduction_vnd: toNum(s.other_deduction_vnd, 0),
          net_pay_vnd: toNum(s.net_pay_vnd, 0),
          breakdown: parseJsonSafe<Record<string, unknown>>(s.breakdown, {}),
        })),
      };
    });

    if (!detail) {
      sendApiError(res, 404, 'PERIOD_NOT_FOUND', 'Không tìm thấy kỳ lương.');
      return;
    }
    res.json({ success: true, data: detail });
  } catch (err: any) {
    sendApiError(res, 500, 'GET_PAYROLL_PERIOD_FAILED', err?.message || 'Không thể tải chi tiết kỳ lương.');
  }
});

payrollRouter.patch('/slips/:id', requirePermission('payroll', 'edit'), async (req, res) => {
  try {
    const ctx = getTenantContext();
    const slipId = String(req.params.id);
    const b = req.body || {};

    const updated = await withTenantTransaction(ctx.tenantId, async (client) => {
      const slipRes = await client.query(
        'SELECT * FROM tenant_payroll_slips WHERE tenant_id = $1 AND id = $2 LIMIT 1',
        [ctx.tenantId, slipId]
      );
      if (slipRes.rows.length === 0) return null;
      const slip = slipRes.rows[0];

      const empRes = await client.query(
        'SELECT * FROM tenant_hr_employees WHERE tenant_id = $1 AND id = $2 LIMIT 1',
        [ctx.tenantId, slip.employee_id]
      );
      const emp = empRes.rows[0];
      const cfg = await getOrSeedTenantPayrollConfigInTx(client, ctx.tenantId);

      const calc = calculateEmployeePayslip(
        {
          base_salary_vnd:
            b.base_salary_vnd !== undefined ? toNum(b.base_salary_vnd, 0) : toNum(slip.base_salary_vnd, 0),
          insurance_salary_vnd: toNum(emp?.insurance_salary_vnd, 0),
          insurance_enrolled: toBool(emp?.insurance_enrolled, true),
          is_resident: toBool(emp?.is_resident, true),
          employment_type: String(emp?.employment_type || 'full_time'),
          dependents_count: Number(emp?.dependents_count || 0),
          union_member: toBool(emp?.union_member, false),
          allowances_map: parseJsonSafe<Record<string, number>>(emp?.allowances_json, {}),
          standard_workdays: toNum(slip.standard_workdays, 22),
          actual_workdays:
            b.actual_workdays !== undefined ? toNum(b.actual_workdays, 0) : toNum(slip.actual_workdays, 0),
          paid_leave_days:
            b.paid_leave_days !== undefined ? toNum(b.paid_leave_days, 0) : toNum(slip.paid_leave_days, 0),
          unpaid_leave_days:
            b.unpaid_leave_days !== undefined ? toNum(b.unpaid_leave_days, 0) : toNum(slip.unpaid_leave_days, 0),
          overtime_hours:
            b.overtime_hours !== undefined ? toNum(b.overtime_hours, 0) : toNum(slip.overtime_hours, 0),
          commission_pay_vnd:
            b.commission_pay_vnd !== undefined ? toNum(b.commission_pay_vnd, 0) : toNum(slip.commission_pay_vnd, 0),
          bonus_vnd: b.bonus_vnd !== undefined ? toNum(b.bonus_vnd, 0) : toNum(slip.bonus_vnd, 0),
          advance_deduction_vnd:
            b.advance_deduction_vnd !== undefined
              ? toNum(b.advance_deduction_vnd, 0)
              : toNum(slip.advance_deduction_vnd, 0),
          other_deduction_vnd:
            b.other_deduction_vnd !== undefined ? toNum(b.other_deduction_vnd, 0) : toNum(slip.other_deduction_vnd, 0),
        },
        cfg
      );

      await client.query(
        `UPDATE tenant_payroll_slips
         SET actual_workdays = $3,
             paid_leave_days = $4,
             unpaid_leave_days = $5,
             overtime_hours = $6,
             base_salary_vnd = $7,
             prorated_base_pay_vnd = $8,
             allowances_vnd = $9,
             tax_exempt_vnd = $10,
             overtime_pay_vnd = $11,
             commission_pay_vnd = $12,
             bonus_vnd = $13,
             gross_pay_vnd = $14,
             emp_bhxh_vnd = $15,
             emp_bhyt_vnd = $16,
             emp_bhtn_vnd = $17,
             taxable_income_vnd = $18,
             assessable_income_vnd = $19,
             pit_tax_vnd = $20,
             advance_deduction_vnd = $21,
             other_deduction_vnd = $22,
             net_pay_vnd = $23,
             payment_status = COALESCE($24, payment_status),
             breakdown = $25::jsonb,
             updated_at = clock_timestamp()
         WHERE tenant_id = $1 AND id = $2`,
        [
          ctx.tenantId,
          slipId,
          calc.actual_workdays,
          calc.paid_leave_days,
          calc.unpaid_leave_days,
          calc.overtime_hours,
          calc.base_salary_vnd,
          calc.prorated_base_pay_vnd,
          calc.allowances_vnd,
          calc.tax_exempt_vnd,
          calc.overtime_pay_vnd,
          calc.commission_pay_vnd,
          calc.bonus_vnd,
          calc.gross_pay_vnd,
          calc.emp_bhxh_vnd,
          calc.emp_bhyt_vnd,
          calc.emp_bhtn_vnd,
          calc.taxable_income_vnd,
          calc.assessable_income_vnd,
          calc.pit_tax_vnd,
          calc.advance_deduction_vnd,
          calc.other_deduction_vnd,
          calc.net_pay_vnd,
          b.payment_status ? String(b.payment_status) : null,
          JSON.stringify({
            pit_breakdown: calc.pit_breakdown,
            allowance_lines: calc.allowance_lines,
          }),
        ]
      );

      await recalculatePeriodTotalsInTx(client, ctx.tenantId, String(slip.period_id));
      const r = await client.query('SELECT * FROM tenant_payroll_slips WHERE tenant_id = $1 AND id = $2', [
        ctx.tenantId,
        slipId,
      ]);
      return r.rows[0];
    });

    if (!updated) {
      sendApiError(res, 404, 'SLIP_NOT_FOUND', 'Không tìm thấy phiếu lương.');
      return;
    }
    res.json({ success: true, data: updated });
  } catch (err: any) {
    sendApiError(res, 500, 'UPDATE_SLIP_FAILED', err?.message || 'Không thể cập nhật phiếu lương.');
  }
});

payrollRouter.patch('/periods/:id', requirePermission('payroll', 'approve'), async (req, res) => {
  try {
    const ctx = getTenantContext();
    const id = String(req.params.id);
    const status = String(req.body?.status || 'approved');

    const updated = await withTenantTransaction(ctx.tenantId, async (client) => {
      await client.query(
        `UPDATE tenant_payroll_periods
         SET status = $3,
             approved_by = CASE WHEN $3 IN ('approved', 'paid', 'locked') THEN $4::uuid ELSE approved_by END,
             approved_at = CASE WHEN $3 IN ('approved', 'paid', 'locked') THEN clock_timestamp() ELSE approved_at END,
             updated_at = clock_timestamp()
         WHERE tenant_id = $1 AND id = $2`,
        [ctx.tenantId, id, status, ctx.userId]
      );
      if (status === 'paid') {
        await client.query(
          `UPDATE tenant_payroll_slips SET payment_status = 'paid', updated_at = clock_timestamp() WHERE tenant_id = $1 AND period_id = $2`,
          [ctx.tenantId, id]
        );
      }
      const r = await client.query('SELECT * FROM tenant_payroll_periods WHERE tenant_id = $1 AND id = $2', [
        ctx.tenantId,
        id,
      ]);
      return r.rows[0] || null;
    });

    if (!updated) {
      sendApiError(res, 404, 'PERIOD_NOT_FOUND', 'Không tìm thấy kỳ lương.');
      return;
    }
    res.json({ success: true, data: updated });
  } catch (err: any) {
    sendApiError(res, 500, 'UPDATE_PERIOD_STATUS_FAILED', err?.message || 'Không thể cập nhật trạng thái kỳ lương.');
  }
});

// Export HTKK 05/KK-TNCN XML
payrollRouter.get('/periods/:id/export-htkk-xml', requirePermission('payroll', 'export'), async (req, res) => {
  try {
    const ctx = getTenantContext();
    const periodId = String(req.params.id);

    const exported = await withTenantTransaction(ctx.tenantId, async (client) => {
      const [pRes, cfg, tenantRes, branchRes, slipsRes] = await Promise.all([
        client.query('SELECT * FROM tenant_payroll_periods WHERE tenant_id = $1 AND id = $2 LIMIT 1', [
          ctx.tenantId,
          periodId,
        ]),
        getOrSeedTenantPayrollConfigInTx(client, ctx.tenantId),
        client.query('SELECT name FROM tenants WHERE id = $1 LIMIT 1', [ctx.tenantId]),
        client.query(
          'SELECT * FROM tenant_branches WHERE tenant_id = $1 AND is_active = true ORDER BY is_headquarters DESC, created_at ASC LIMIT 1',
          [ctx.tenantId]
        ),
        client.query(
          `SELECT s.gross_pay_vnd, s.taxable_income_vnd, s.pit_tax_vnd,
                  e.is_resident, e.employment_type
           FROM tenant_payroll_slips s
           INNER JOIN tenant_hr_employees e ON e.tenant_id = s.tenant_id AND e.id = s.employee_id
           WHERE s.tenant_id = $1 AND s.period_id = $2`,
          [ctx.tenantId, periodId]
        ),
      ]);

      if (pRes.rows.length === 0) return null;
      const period = pRes.rows[0];
      const br = branchRes.rows[0] || {};
      const tenantName = String(tenantRes.rows[0]?.name || 'Doanh nghiệp');
      const taxCode = String(br.tax_code || '0000000000');

      const xmlContent = buildHtkk05KkXml({
        year: Number(period.year),
        month: Number(period.month),
        legalEntityName: String(br.legal_entity_name || br.name || tenantName),
        taxCode,
        address: String(br.address || ''),
        phone: String(br.phone || ''),
        email: String(br.email || ctx.userEmail || ''),
        signerName: String(br.representative_name || ctx.userName || ''),
        taxAuthorityCode: cfg.tax_authority_code || '',
        taxAuthorityName: cfg.tax_authority_name || '',
        slips: slipsRes.rows.map((r) => ({
          is_resident: toBool(r.is_resident, true),
          employment_type: String(r.employment_type || 'full_time'),
          gross_pay_vnd: toNum(r.gross_pay_vnd, 0),
          taxable_income_vnd: toNum(r.taxable_income_vnd, 0),
          pit_tax_vnd: toNum(r.pit_tax_vnd, 0),
        })),
      });

      const mm = String(period.month).padStart(2, '0');
      const filename = `${taxCode}-05_KK_TNCN_TT80-M${mm}${period.year}-L00.xml`;
      return { filename, xml_content: xmlContent, period_key: String(period.period_key) };
    });

    if (!exported) {
      sendApiError(res, 404, 'PERIOD_NOT_FOUND', 'Không tìm thấy kỳ lương cần kết xuất XML.');
      return;
    }

    if (req.query.download === '1' || req.query.raw === '1') {
      res.setHeader('Content-Type', 'application/xml; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="${exported.filename}"`);
      res.send(exported.xml_content);
      return;
    }

    res.json({ success: true, data: exported });
  } catch (err: any) {
    sendApiError(res, 500, 'EXPORT_HTKK_XML_FAILED', err?.message || 'Không thể kết xuất tờ khai XML HTKK.');
  }
});

// Export Payroll & PIT CSV
payrollRouter.get('/periods/:id/export-csv', requirePermission('payroll', 'export'), async (req, res) => {
  try {
    const ctx = getTenantContext();
    const periodId = String(req.params.id);

    const exported = await withTenantTransaction(ctx.tenantId, async (client) => {
      const pRes = await client.query(
        'SELECT * FROM tenant_payroll_periods WHERE tenant_id = $1 AND id = $2 LIMIT 1',
        [ctx.tenantId, periodId]
      );
      if (pRes.rows.length === 0) return null;
      const period = pRes.rows[0];

      const slipsRes = await client.query(
        `SELECT s.*, e.employee_code, e.full_name AS employee_name, e.tax_code,
                e.bank_name, e.bank_account_number
         FROM tenant_payroll_slips s
         INNER JOIN tenant_hr_employees e ON e.tenant_id = s.tenant_id AND e.id = s.employee_id
         WHERE s.tenant_id = $1 AND s.period_id = $2
         ORDER BY e.employee_code ASC`,
        [ctx.tenantId, periodId]
      );

      const csvContent = buildPayrollCsv(String(period.period_key), slipsRes.rows);
      const filename = `Bang_Luong_TNCN_${period.period_key}.csv`;
      return { filename, csv_content: csvContent, period_key: String(period.period_key) };
    });

    if (!exported) {
      sendApiError(res, 404, 'PERIOD_NOT_FOUND', 'Không tìm thấy kỳ lương cần xuất CSV.');
      return;
    }

    if (req.query.download === '1' || req.query.raw === '1') {
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="${exported.filename}"`);
      res.send(exported.csv_content);
      return;
    }

    res.json({ success: true, data: exported });
  } catch (err: any) {
    sendApiError(res, 500, 'EXPORT_PAYROLL_CSV_FAILED', err?.message || 'Không thể xuất bảng lương CSV.');
  }
});

// ============================================================================
// 4. Employee Self-Service Payslips (`/my-payslips`, `/slips/:id/sign`, `/slips/:id/dispute`)
// ============================================================================
payrollRouter.get('/my-payslips', async (req, res) => {
  try {
    const ctx = getTenantContext();
    const requestedPeriodKey = req.query.period_key ? String(req.query.period_key).trim() : '';

    const data = await withTenantTransaction(ctx.tenantId, async (client) => {
      const [tenantRes, branchRes, slipsRes] = await Promise.all([
        client.query('SELECT name FROM tenants WHERE id = $1 LIMIT 1', [ctx.tenantId]),
        client.query(
          'SELECT * FROM tenant_branches WHERE tenant_id = $1 AND is_active = true ORDER BY is_headquarters DESC, created_at ASC LIMIT 1',
          [ctx.tenantId]
        ),
        client.query(
          `SELECT s.*,
                  p.period_key, p.title AS period_title, p.status AS period_status, p.year, p.month,
                  e.employee_code, e.full_name AS employee_name, e.tax_code, e.bank_name, e.bank_account_number,
                  d.name AS department_name, b.name AS branch_name
           FROM tenant_payroll_slips s
           INNER JOIN tenant_payroll_periods p ON p.tenant_id = s.tenant_id AND p.id = s.period_id
           INNER JOIN tenant_hr_employees e ON e.tenant_id = s.tenant_id AND e.id = s.employee_id
           LEFT JOIN tenant_departments d ON d.tenant_id = e.tenant_id AND d.id = e.department_id
           LEFT JOIN tenant_branches b ON b.tenant_id = e.tenant_id AND b.id = e.branch_id
           WHERE s.tenant_id = $1 AND (s.user_id = $2 OR e.user_id = $2)
           ORDER BY p.year DESC, p.month DESC`,
          [ctx.tenantId, ctx.userId]
        ),
      ]);

      const br = branchRes.rows[0] || {};
      const tenantName = String(tenantRes.rows[0]?.name || 'Doanh nghiệp');
      const legalEntity = {
        legal_entity_name: String(br.legal_entity_name || br.name || tenantName),
        tax_code: String(br.tax_code || ''),
        address: String(br.address || ''),
        phone: String(br.phone || ''),
        representative_name: String(br.representative_name || ''),
      };

      const normalizedSlips = slipsRes.rows.map((s) => ({
        ...s,
        base_salary_vnd: toNum(s.base_salary_vnd, 0),
        prorated_base_pay_vnd: toNum(s.prorated_base_pay_vnd, 0),
        allowances_vnd: toNum(s.allowances_vnd, 0),
        tax_exempt_vnd: toNum(s.tax_exempt_vnd, 0),
        overtime_pay_vnd: toNum(s.overtime_pay_vnd, 0),
        commission_pay_vnd: toNum(s.commission_pay_vnd, 0),
        bonus_vnd: toNum(s.bonus_vnd, 0),
        gross_pay_vnd: toNum(s.gross_pay_vnd, 0),
        emp_bhxh_vnd: toNum(s.emp_bhxh_vnd, 0),
        emp_bhyt_vnd: toNum(s.emp_bhyt_vnd, 0),
        emp_bhtn_vnd: toNum(s.emp_bhtn_vnd, 0),
        emp_union_vnd: toNum(s.emp_union_vnd, 0),
        family_deduction_vnd: toNum(s.family_deduction_vnd, 0),
        taxable_income_vnd: toNum(s.taxable_income_vnd, 0),
        assessable_income_vnd: toNum(s.assessable_income_vnd, 0),
        pit_tax_vnd: toNum(s.pit_tax_vnd, 0),
        advance_deduction_vnd: toNum(s.advance_deduction_vnd, 0),
        other_deduction_vnd: toNum(s.other_deduction_vnd, 0),
        net_pay_vnd: toNum(s.net_pay_vnd, 0),
        signed_by_employee: toBool(s.signed_by_employee, false),
        breakdown: parseJsonSafe<Record<string, unknown>>(s.breakdown, {}),
      }));

      const activeSlip =
        (requestedPeriodKey && requestedPeriodKey !== 'all'
          ? normalizedSlips.find((x) => String(x.period_key) === requestedPeriodKey)
          : normalizedSlips[0]) || null;

      return {
        legal_entity: legalEntity,
        selected_period_key: requestedPeriodKey || (activeSlip ? String(activeSlip.period_key) : ''),
        payslip: activeSlip,
        all_payslips: normalizedSlips,
      };
    });

    res.json({ success: true, data });
  } catch (err: any) {
    sendApiError(res, 500, 'GET_MY_PAYSLIPS_FAILED', err?.message || 'Không thể tải phiếu lương cá nhân.');
  }
});

payrollRouter.post('/slips/:id/sign', async (req, res) => {
  try {
    const ctx = getTenantContext();
    const slipId = String(req.params.id);
    const sigUrl = String(req.body?.signature_data_url || req.body?.signature_url || '').trim();
    if (!sigUrl) {
      sendApiError(res, 422, 'SIGNATURE_REQUIRED', 'Vui lòng ký xác nhận phiếu lương.');
      return;
    }

    const updated = await withTenantTransaction(ctx.tenantId, async (client) => {
      const sRes = await client.query<{ id: string; user_id: string | null; employee_id: string }>(
        'SELECT id, user_id, employee_id FROM tenant_payroll_slips WHERE tenant_id = $1 AND id = $2 LIMIT 1',
        [ctx.tenantId, slipId]
      );
      const s = sRes.rows[0];
      if (!s) return { error: 'NOT_FOUND' as const };

      // Allow employee owner or tenant owner
      if (s.user_id && String(s.user_id) !== ctx.userId) {
        const rbac = await resolveUserEffectivePermissions(client, ctx.tenantId, ctx.userId);
        if (!rbac.userOrg?.is_tenant_owner) {
          return { error: 'FORBIDDEN' as const };
        }
      }

      await client.query(
        `UPDATE tenant_payroll_slips
         SET signed_by_employee = true,
             employee_signature_url = $3,
             employee_signed_at = clock_timestamp(),
             updated_at = clock_timestamp()
         WHERE tenant_id = $1 AND id = $2`,
        [ctx.tenantId, slipId, sigUrl]
      );
      const r = await client.query('SELECT * FROM tenant_payroll_slips WHERE tenant_id = $1 AND id = $2', [
        ctx.tenantId,
        slipId,
      ]);
      return { data: { ...r.rows[0], signed_by_employee: toBool(r.rows[0]?.signed_by_employee, true) } };
    });

    if ('error' in updated) {
      if (updated.error === 'FORBIDDEN') {
        sendApiError(res, 403, 'FORBIDDEN_SLIP_SIGN', 'Bạn chỉ được ký xác nhận phiếu lương của chính mình.');
        return;
      }
      sendApiError(res, 404, 'SLIP_NOT_FOUND', 'Không tìm thấy phiếu lương.');
      return;
    }

    res.json({ success: true, data: updated.data });
  } catch (err: any) {
    sendApiError(res, 500, 'SIGN_PAYSLIP_FAILED', err?.message || 'Không thể lưu chữ ký phiếu lương.');
  }
});

payrollRouter.post('/slips/:id/dispute', async (req, res) => {
  try {
    const ctx = getTenantContext();
    const slipId = String(req.params.id);
    const note = String(req.body?.dispute_note || req.body?.note || req.body?.reason || '').trim();
    const nextStatus = req.body?.status === 'resolved' ? 'resolved' : 'open';

    if (!note && nextStatus === 'open') {
      sendApiError(res, 422, 'DISPUTE_NOTE_REQUIRED', 'Vui lòng nhập nội dung thắc mắc bảng lương.');
      return;
    }

    const updated = await withTenantTransaction(ctx.tenantId, async (client) => {
      const sRes = await client.query('SELECT id FROM tenant_payroll_slips WHERE tenant_id = $1 AND id = $2 LIMIT 1', [
        ctx.tenantId,
        slipId,
      ]);
      if (!sRes.rows[0]) return null;

      await client.query(
        `UPDATE tenant_payroll_slips
         SET dispute_status = $3,
             dispute_note = COALESCE($4, dispute_note),
             disputed_at = clock_timestamp(),
             updated_at = clock_timestamp()
         WHERE tenant_id = $1 AND id = $2`,
        [ctx.tenantId, slipId, nextStatus, note || null]
      );
      const r = await client.query('SELECT * FROM tenant_payroll_slips WHERE tenant_id = $1 AND id = $2', [
        ctx.tenantId,
        slipId,
      ]);
      return r.rows[0];
    });

    if (!updated) {
      sendApiError(res, 404, 'SLIP_NOT_FOUND', 'Không tìm thấy phiếu lương.');
      return;
    }
    res.json({ success: true, data: updated });
  } catch (err: any) {
    sendApiError(res, 500, 'DISPUTE_PAYSLIP_FAILED', err?.message || 'Không thể gửi phản hồi phiếu lương.');
  }
});

// ============================================================================
// 5. Multi-Sale Cooperation Slips (`/cooperation-slips`)
// ============================================================================
interface CooperationShareholder {
  user_id: string;
  name: string;
  email: string;
  percentage: number;
  signed: boolean;
  signature_url?: string | null;
  signature_time: string | null;
  signature_ip: string | null;
}

function normalizeCoopSlipRow(row: Record<string, unknown>) {
  const shareholders = parseJsonSafe<CooperationShareholder[]>(row.line_items_json, []);
  const meta = parseJsonSafe<Record<string, unknown>>(row.metadata_json, {});
  return {
    ...row,
    estimated_value_vnd: toNum(row.estimated_value_vnd, 0),
    expected_revenue: toNum(row.estimated_value_vnd, 0),
    expected_commission_vnd: toNum(row.expected_commission_vnd, 0),
    expected_commission: toNum(row.expected_commission_vnd, 0),
    commission_pct: toNum(row.commission_pct, 0),
    total_percentage: toNum(row.total_percentage, 100),
    shareholders,
    approver: meta.approver || null,
    adjustment_request: meta.adjustment_request || null,
  };
}

payrollRouter.get('/cooperation-slips', requirePermission('payroll', 'view'), async (req, res) => {
  try {
    const ctx = getTenantContext();
    const statusFilter = req.query.status ? String(req.query.status).trim() : 'all';
    const q = req.query.q ? String(req.query.q).trim().toLowerCase() : '';

    const data = await withTenantTransaction(ctx.tenantId, async (client) => {
      let sql = 'SELECT * FROM tenant_cooperation_slips WHERE tenant_id = $1';
      const params: unknown[] = [ctx.tenantId];
      if (statusFilter && statusFilter !== 'all') {
        params.push(statusFilter);
        sql += ` AND status = $${params.length}`;
      }
      sql += ' ORDER BY created_at DESC LIMIT 200';

      const [slipsRes, usersRes] = await Promise.all([
        client.query(sql, params),
        client.query(
          `SELECT id, full_name, email, role, department_id
           FROM users
           WHERE tenant_id = $1 AND is_system_bot = false
           ORDER BY full_name ASC`,
          [ctx.tenantId]
        ),
      ]);

      let items = slipsRes.rows.map((r) => normalizeCoopSlipRow(r));
      if (q) {
        items = items.filter(
          (item: Record<string, unknown>) =>
            String(item.title || '').toLowerCase().includes(q) ||
            String(item.slip_code || '').toLowerCase().includes(q) ||
            String(item.partner_name || '').toLowerCase().includes(q) ||
            String(item.unit_code || '').toLowerCase().includes(q) ||
            String(item.project_name || '').toLowerCase().includes(q)
        );
      }

      return {
        items,
        sales_accounts: usersRes.rows,
      };
    });

    res.json({ success: true, data });
  } catch (err: any) {
    sendApiError(res, 500, 'LIST_COOPERATION_SLIPS_FAILED', err?.message || 'Không thể tải danh sách phiếu hợp tác.');
  }
});

payrollRouter.post('/cooperation-slips', requirePermission('payroll', 'create'), async (req, res) => {
  try {
    const ctx = getTenantContext();
    const b = req.body || {};
    const title = String(b.title || b.partner_name || 'Phiếu hợp tác kinh doanh').trim();
    const rawShares = Array.isArray(b.shareholders) ? b.shareholders : [];

    if (rawShares.length === 0) {
      sendApiError(res, 422, 'SHAREHOLDERS_REQUIRED', 'Vui lòng phân bổ ít nhất 1 thành viên trên phiếu hợp tác.');
      return;
    }

    const totalPct = rawShares.reduce((acc: number, s: any) => acc + toNum(s?.percentage, 0), 0);
    if (Math.abs(totalPct - 100) > 0.05) {
      sendApiError(
        res,
        422,
        'INVALID_SHARE_TOTAL',
        `Tổng tỷ lệ hợp tác bắt buộc bằng 100% (hiện tại: ${totalPct.toFixed(2)}%).`
      );
      return;
    }

    const created = await withTenantTransaction(ctx.tenantId, async (client) => {
      const usersRes = await client.query<{ id: string; full_name: string; email: string }>(
        'SELECT id, full_name, email FROM users WHERE tenant_id = $1',
        [ctx.tenantId]
      );
      const userMap = new Map(usersRes.rows.map((u) => [String(u.id), u]));

      const shareholders: CooperationShareholder[] = rawShares.map((s: any) => {
        const uid = String(s.user_id || '').trim();
        const u = userMap.get(uid);
        return {
          user_id: uid,
          name: String(s.name || u?.full_name || 'Thành viên'),
          email: String(s.email || u?.email || ''),
          percentage: Math.round(toNum(s.percentage, 0) * 100) / 100,
          signed: false,
          signature_url: null,
          signature_time: null,
          signature_ip: null,
        };
      });

      const id = crypto.randomUUID();
      const ym = new Date().toISOString().slice(0, 7).replace('-', '');
      const slipCode = b.slip_code
        ? String(b.slip_code).trim()
        : `HT-${ym}-${id.slice(0, 4).toUpperCase()}`;
      const expectedRevenue = Math.max(0, toNum(b.estimated_value_vnd ?? b.expected_revenue, 0));
      const expectedComm = Math.max(0, toNum(b.expected_commission_vnd ?? b.expected_commission, 0));
      const commPct =
        b.commission_pct !== undefined
          ? toNum(b.commission_pct, 0)
          : expectedRevenue > 0
            ? Math.round((expectedComm / expectedRevenue) * 10000) / 100
            : 0;

      await client.query(
        `INSERT INTO tenant_cooperation_slips (
           id, tenant_id, slip_code, title, lead_id, deal_id, partner_name, partner_contact,
           commission_pct, estimated_value_vnd, status, terms_text, line_items_json,
           owner_user_id, unit_code, project_name, expected_commission_vnd, total_percentage, metadata_json
         ) VALUES (
           $1, $2, $3, $4, $5, $6, $7, $8,
           $9, $10, 'pending_signatures', $11, $12::jsonb,
           $13, $14, $15, $16, $17, $18::jsonb
         )`,
        [
          id,
          ctx.tenantId,
          slipCode,
          title,
          b.lead_id || null,
          b.deal_id || null,
          b.partner_name || b.full_name || null,
          b.partner_contact || b.phone || null,
          commPct,
          expectedRevenue,
          b.terms_text || null,
          JSON.stringify(shareholders),
          ctx.userId,
          b.unit_code || null,
          b.project_name || null,
          expectedComm,
          totalPct,
          JSON.stringify({ version: 1 }),
        ]
      );

      const r = await client.query('SELECT * FROM tenant_cooperation_slips WHERE tenant_id = $1 AND id = $2', [
        ctx.tenantId,
        id,
      ]);
      return normalizeCoopSlipRow(r.rows[0]);
    });

    res.status(201).json({ success: true, data: created });
  } catch (err: any) {
    sendApiError(res, 500, 'CREATE_COOPERATION_SLIP_FAILED', err?.message || 'Không thể khởi tạo phiếu hợp tác.');
  }
});

payrollRouter.patch('/cooperation-slips/:id/shares', requirePermission('payroll', 'edit'), async (req, res) => {
  try {
    const ctx = getTenantContext();
    const slipId = String(req.params.id);
    const b = req.body || {};
    const rawShares = Array.isArray(b.shareholders) ? b.shareholders : [];

    const totalPct = rawShares.reduce((acc: number, s: any) => acc + toNum(s?.percentage, 0), 0);
    if (rawShares.length === 0 || Math.abs(totalPct - 100) > 0.05) {
      sendApiError(res, 422, 'INVALID_SHARE_TOTAL', 'Tổng tỷ lệ phân bổ phải bằng 100%.');
      return;
    }

    const updated = await withTenantTransaction(ctx.tenantId, async (client) => {
      const curRes = await client.query(
        'SELECT * FROM tenant_cooperation_slips WHERE tenant_id = $1 AND id = $2 LIMIT 1',
        [ctx.tenantId, slipId]
      );
      if (!curRes.rows[0]) return null;
      const cur = curRes.rows[0];

      const usersRes = await client.query<{ id: string; full_name: string; email: string }>(
        'SELECT id, full_name, email FROM users WHERE tenant_id = $1',
        [ctx.tenantId]
      );
      const userMap = new Map(usersRes.rows.map((u) => [String(u.id), u]));

      const nextShares: CooperationShareholder[] = rawShares.map((s: any) => {
        const uid = String(s.user_id || '').trim();
        const u = userMap.get(uid);
        return {
          user_id: uid,
          name: String(s.name || u?.full_name || 'Thành viên'),
          email: String(s.email || u?.email || ''),
          percentage: Math.round(toNum(s.percentage, 0) * 100) / 100,
          signed: false,
          signature_url: null,
          signature_time: null,
          signature_ip: null,
        };
      });

      const meta = parseJsonSafe<Record<string, unknown>>(cur.metadata_json, {});
      meta.version = Number(meta.version || 1) + 1;
      meta.last_change_reason = b.change_reason || null;

      const nextExpectedComm =
        b.expected_commission_vnd !== undefined || b.expected_commission !== undefined
          ? Math.max(0, toNum(b.expected_commission_vnd ?? b.expected_commission, 0))
          : toNum(cur.expected_commission_vnd, 0);

      await client.query(
        `UPDATE tenant_cooperation_slips
         SET line_items_json = $3::jsonb,
             expected_commission_vnd = $4,
             total_percentage = $5,
             status = 'pending_signatures',
             dispute_details = NULL,
             metadata_json = $6::jsonb,
             updated_at = clock_timestamp()
         WHERE tenant_id = $1 AND id = $2`,
        [ctx.tenantId, slipId, JSON.stringify(nextShares), nextExpectedComm, totalPct, JSON.stringify(meta)]
      );

      const r = await client.query('SELECT * FROM tenant_cooperation_slips WHERE tenant_id = $1 AND id = $2', [
        ctx.tenantId,
        slipId,
      ]);
      return normalizeCoopSlipRow(r.rows[0]);
    });

    if (!updated) {
      sendApiError(res, 404, 'COOP_SLIP_NOT_FOUND', 'Không tìm thấy phiếu hợp tác.');
      return;
    }
    res.json({ success: true, data: updated });
  } catch (err: any) {
    sendApiError(res, 500, 'UPDATE_COOP_SHARES_FAILED', err?.message || 'Không thể cập nhật tỷ lệ hợp tác.');
  }
});

payrollRouter.post('/cooperation-slips/:id/sign', async (req, res) => {
  try {
    const ctx = getTenantContext();
    const slipId = String(req.params.id);
    const sigUrl = String(req.body?.signature_data_url || req.body?.signature_url || 'signed').trim();
    const clientIp = String(req.ip || req.headers['x-forwarded-for'] || '127.0.0.1');

    const result = await withTenantTransaction(ctx.tenantId, async (client) => {
      const curRes = await client.query(
        'SELECT * FROM tenant_cooperation_slips WHERE tenant_id = $1 AND id = $2 LIMIT 1',
        [ctx.tenantId, slipId]
      );
      if (!curRes.rows[0]) return { error: 'NOT_FOUND' as const };
      const cur = curRes.rows[0];
      const shares = parseJsonSafe<CooperationShareholder[]>(cur.line_items_json, []);
      const idx = shares.findIndex((s) => String(s.user_id) === ctx.userId);
      if (idx < 0) return { error: 'NOT_SHAREHOLDER' as const };

      shares[idx] = {
        ...shares[idx],
        signed: true,
        signature_url: sigUrl,
        signature_time: new Date().toISOString(),
        signature_ip: clientIp,
      };

      const allSigned = shares.length > 0 && shares.every((s) => Boolean(s.signed));
      const nextStatus =
        cur.status === 'approved'
          ? 'approved'
          : allSigned
            ? 'pending_manager_approval'
            : 'pending_signatures';

      await client.query(
        `UPDATE tenant_cooperation_slips
         SET line_items_json = $3::jsonb,
             status = $4,
             updated_at = clock_timestamp()
         WHERE tenant_id = $1 AND id = $2`,
        [ctx.tenantId, slipId, JSON.stringify(shares), nextStatus]
      );

      const r = await client.query('SELECT * FROM tenant_cooperation_slips WHERE tenant_id = $1 AND id = $2', [
        ctx.tenantId,
        slipId,
      ]);
      return { data: normalizeCoopSlipRow(r.rows[0]) };
    });

    if ('error' in result) {
      if (result.error === 'NOT_SHAREHOLDER') {
        sendApiError(res, 403, 'NOT_SHAREHOLDER', 'Bạn không nằm trong danh sách thành viên ký trên phiếu hợp tác này.');
        return;
      }
      sendApiError(res, 404, 'COOP_SLIP_NOT_FOUND', 'Không tìm thấy phiếu hợp tác.');
      return;
    }

    res.json({ success: true, data: result.data });
  } catch (err: any) {
    sendApiError(res, 500, 'SIGN_COOP_SLIP_FAILED', err?.message || 'Không thể ký xác nhận phiếu hợp tác.');
  }
});

payrollRouter.post('/cooperation-slips/:id/decide', requirePermission('payroll', 'approve'), async (req, res) => {
  try {
    const ctx = getTenantContext();
    const slipId = String(req.params.id);
    const decision = String(req.body?.decision || 'approve').toLowerCase();
    const isApprove = decision.startsWith('approv');

    const updated = await withTenantTransaction(ctx.tenantId, async (client) => {
      const curRes = await client.query(
        'SELECT * FROM tenant_cooperation_slips WHERE tenant_id = $1 AND id = $2 LIMIT 1',
        [ctx.tenantId, slipId]
      );
      if (!curRes.rows[0]) return null;
      const cur = curRes.rows[0];
      const shares = parseJsonSafe<CooperationShareholder[]>(cur.line_items_json, []);
      const meta = parseJsonSafe<Record<string, unknown>>(cur.metadata_json, {});

      const nextStatus = isApprove ? 'approved' : 'rejected';
      meta.approver = {
        user_id: ctx.userId,
        name: ctx.userName || 'Quản lý phê duyệt',
        email: ctx.userEmail || '',
        approved_at: new Date().toISOString(),
        comment: req.body?.comment || null,
      };

      await client.query(
        `UPDATE tenant_cooperation_slips
         SET status = $3,
             approved_by = $4,
             approved_at = clock_timestamp(),
             metadata_json = $5::jsonb,
             updated_at = clock_timestamp()
         WHERE tenant_id = $1 AND id = $2`,
        [ctx.tenantId, slipId, nextStatus, ctx.userId, JSON.stringify(meta)]
      );

      // When approved and expected_commission_vnd > 0, record commission ledgers per shareholder
      const totalComm = toNum(cur.expected_commission_vnd, 0);
      if (isApprove && totalComm > 0 && shares.length > 0) {
        const periodKey = String(req.body?.period_key || new Date().toISOString().slice(0, 7));
        const totalRev = toNum(cur.estimated_value_vnd, 0);
        for (const sh of shares) {
          const shareComm = Math.round((totalComm * toNum(sh.percentage, 0)) / 100);
          const shareRev = Math.round((totalRev * toNum(sh.percentage, 0)) / 100);
          if (shareComm > 0 && sh.user_id) {
            await client.query(
              `INSERT INTO tenant_commission_ledgers (
                 id, tenant_id, period_key, user_id, lead_id, source_title,
                 revenue_base_vnd, commission_amount_vnd, status, notes
               ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'approved', $9)`,
              [
                crypto.randomUUID(),
                ctx.tenantId,
                periodKey,
                sh.user_id,
                cur.lead_id || null,
                `Phiếu hợp tác ${cur.slip_code} (${sh.percentage}%) — ${cur.title}`,
                shareRev,
                shareComm,
                `Tự động ghi nhận từ duyệt phiếu hợp tác ${cur.slip_code}`,
              ]
            );
          }
        }
      }

      const r = await client.query('SELECT * FROM tenant_cooperation_slips WHERE tenant_id = $1 AND id = $2', [
        ctx.tenantId,
        slipId,
      ]);
      return normalizeCoopSlipRow(r.rows[0]);
    });

    if (!updated) {
      sendApiError(res, 404, 'COOP_SLIP_NOT_FOUND', 'Không tìm thấy phiếu hợp tác.');
      return;
    }
    res.json({ success: true, data: updated });
  } catch (err: any) {
    sendApiError(res, 500, 'DECIDE_COOP_SLIP_FAILED', err?.message || 'Không thể phê duyệt phiếu hợp tác.');
  }
});

payrollRouter.post('/cooperation-slips/:id/dispute', async (req, res) => {
  try {
    const ctx = getTenantContext();
    const slipId = String(req.params.id);
    const reason = String(req.body?.reason || req.body?.dispute_details || '').trim();
    if (!reason) {
      sendApiError(res, 422, 'DISPUTE_REASON_REQUIRED', 'Vui lòng nhập lý do yêu cầu điều chỉnh / khiếu nại.');
      return;
    }

    const updated = await withTenantTransaction(ctx.tenantId, async (client) => {
      const curRes = await client.query(
        'SELECT * FROM tenant_cooperation_slips WHERE tenant_id = $1 AND id = $2 LIMIT 1',
        [ctx.tenantId, slipId]
      );
      if (!curRes.rows[0]) return null;
      const meta = parseJsonSafe<Record<string, unknown>>(curRes.rows[0].metadata_json, {});
      meta.adjustment_request = {
        user_id: ctx.userId,
        name: ctx.userName || 'Thành viên',
        email: ctx.userEmail || '',
        reason,
        requested_at: new Date().toISOString(),
      };

      await client.query(
        `UPDATE tenant_cooperation_slips
         SET status = 'disputed',
             dispute_details = $3,
             metadata_json = $4::jsonb,
             updated_at = clock_timestamp()
         WHERE tenant_id = $1 AND id = $2`,
        [ctx.tenantId, slipId, reason, JSON.stringify(meta)]
      );
      const r = await client.query('SELECT * FROM tenant_cooperation_slips WHERE tenant_id = $1 AND id = $2', [
        ctx.tenantId,
        slipId,
      ]);
      return normalizeCoopSlipRow(r.rows[0]);
    });

    if (!updated) {
      sendApiError(res, 404, 'COOP_SLIP_NOT_FOUND', 'Không tìm thấy phiếu hợp tác.');
      return;
    }
    res.json({ success: true, data: updated });
  } catch (err: any) {
    sendApiError(res, 500, 'DISPUTE_COOP_SLIP_FAILED', err?.message || 'Không thể gửi yêu cầu điều chỉnh phiếu hợp tác.');
  }
});

// ============================================================================
// 6. HRM & Payroll Accounting A-Z Workspace (`/accounting-az` — TT200/TT133)
// ============================================================================
function buildStatutoryPayrollJournalEntries(params: {
  periodKey: string;
  regime: 'TT200' | 'TT133';
  totalGross: number;
  empBhxh: number;
  empBhyt: number;
  empBhtn: number;
  erInsuranceTotal: number;
  totalPit: number;
  totalNet: number;
}) {
  const { periodKey, regime, totalGross, empBhxh, empBhyt, empBhtn, erInsuranceTotal, totalPit, totalNet } = params;
  const expenseAcc = regime === 'TT133' ? '6422' : '6421';
  const expenseAccName =
    regime === 'TT133'
      ? 'Chi phí quản lý kinh doanh (TT133)'
      : 'Chi phí nhân viên quản lý doanh nghiệp (TT200)';
  const docDate = `${periodKey}-28`;
  const entries: Array<{
    seq: number;
    date: string;
    voucher_no: string;
    description: string;
    debit_account: string;
    credit_account: string;
    amount_vnd: number;
    entry_group: string;
  }> = [];

  let seq = 1;
  if (totalGross > 0) {
    entries.push({
      seq: seq++,
      date: docDate,
      voucher_no: `PKT-LUONG-${periodKey}`,
      description: `Hạch toán chi phí tiền lương, phụ cấp & hoa hồng kỳ ${periodKey} (${expenseAccName})`,
      debit_account: expenseAcc,
      credit_account: '3341',
      amount_vnd: Math.round(totalGross),
      entry_group: 'salary_accrual',
    });
  }
  if (erInsuranceTotal > 0) {
    entries.push({
      seq: seq++,
      date: docDate,
      voucher_no: `PKT-BHDN-${periodKey}`,
      description: `Trích BHXH, BHYT, BHTN, KPCĐ phần doanh nghiệp đóng tính vào chi phí kỳ ${periodKey}`,
      debit_account: expenseAcc,
      credit_account: '338',
      amount_vnd: Math.round(erInsuranceTotal),
      entry_group: 'employer_insurance',
    });
  }
  if (empBhxh > 0) {
    entries.push({
      seq: seq++,
      date: docDate,
      voucher_no: `PKT-BHXH-${periodKey}`,
      description: `Khấu trừ BHXH bắt buộc (8%) vào lương người lao động kỳ ${periodKey}`,
      debit_account: '3341',
      credit_account: '3383',
      amount_vnd: Math.round(empBhxh),
      entry_group: 'employee_insurance',
    });
  }
  if (empBhyt > 0) {
    entries.push({
      seq: seq++,
      date: docDate,
      voucher_no: `PKT-BHYT-${periodKey}`,
      description: `Khấu trừ BHYT bắt buộc (1.5%) vào lương người lao động kỳ ${periodKey}`,
      debit_account: '3341',
      credit_account: '3384',
      amount_vnd: Math.round(empBhyt),
      entry_group: 'employee_insurance',
    });
  }
  if (empBhtn > 0) {
    entries.push({
      seq: seq++,
      date: docDate,
      voucher_no: `PKT-BHTN-${periodKey}`,
      description: `Khấu trừ BHTN bắt buộc (1%) vào lương người lao động kỳ ${periodKey}`,
      debit_account: '3341',
      credit_account: '3386',
      amount_vnd: Math.round(empBhtn),
      entry_group: 'employee_insurance',
    });
  }
  if (totalPit > 0) {
    entries.push({
      seq: seq++,
      date: docDate,
      voucher_no: `PKT-TNCN-${periodKey}`,
      description: `Khấu trừ Thuế TNCN phải nộp tại nguồn (05/KK-TNCN) kỳ ${periodKey}`,
      debit_account: '3341',
      credit_account: '3335',
      amount_vnd: Math.round(totalPit),
      entry_group: 'pit_withholding',
    });
  }
  if (totalNet > 0) {
    entries.push({
      seq: seq++,
      date: docDate,
      voucher_no: `UNC-LUONG-${periodKey}`,
      description: `Chi trả lương thực lĩnh (Net) qua tài khoản ngân hàng kỳ ${periodKey}`,
      debit_account: '3341',
      credit_account: '1121',
      amount_vnd: Math.round(totalNet),
      entry_group: 'bank_disbursement',
    });
  }

  return entries;
}

payrollRouter.get('/accounting-az', requirePermission('payroll', 'view'), async (req, res) => {
  try {
    const ctx = getTenantContext();
    const periodKey = String(req.query.period_key || new Date().toISOString().slice(0, 7)).slice(0, 7);

    const payload = await withTenantTransaction(ctx.tenantId, async (client) => {
      const [tenantRes, branchesRes, cfg, empsRes, contractsRes, periodRes, wsRowsRes] = await Promise.all([
        client.query('SELECT name FROM tenants WHERE id = $1 LIMIT 1', [ctx.tenantId]),
        client.query(
          'SELECT * FROM tenant_branches WHERE tenant_id = $1 AND is_active = true ORDER BY is_headquarters DESC, created_at ASC',
          [ctx.tenantId]
        ),
        getOrSeedTenantPayrollConfigInTx(client, ctx.tenantId),
        client.query(
          `SELECT e.*, b.name AS branch_name, d.name AS department_name, p.name AS position_name
           FROM tenant_hr_employees e
           LEFT JOIN tenant_branches b ON b.tenant_id = e.tenant_id AND b.id = e.branch_id
           LEFT JOIN tenant_departments d ON d.tenant_id = e.tenant_id AND d.id = e.department_id
           LEFT JOIN tenant_positions p ON p.tenant_id = e.tenant_id AND p.id = e.position_id
           WHERE e.tenant_id = $1
           ORDER BY e.employee_code ASC`,
          [ctx.tenantId]
        ),
        client.query(
          `SELECT c.*, e.full_name AS employee_name, e.employee_code
           FROM tenant_hr_contracts c
           INNER JOIN tenant_hr_employees e ON e.tenant_id = c.tenant_id AND e.id = c.employee_id
           WHERE c.tenant_id = $1
           ORDER BY c.start_date DESC`,
          [ctx.tenantId]
        ),
        client.query(
          'SELECT * FROM tenant_payroll_periods WHERE tenant_id = $1 AND period_key = $2 LIMIT 1',
          [ctx.tenantId, periodKey]
        ),
        client.query(
          'SELECT * FROM tenant_accounting_az_workspace WHERE tenant_id = $1 AND fiscal_period = $2 ORDER BY created_at ASC',
          [ctx.tenantId, periodKey]
        ),
      ]);

      const hq = branchesRes.rows[0] || {};
      const tenantName = String(tenantRes.rows[0]?.name || 'Doanh nghiệp');
      const legalEntity = {
        legal_entity_name: String(hq.legal_entity_name || hq.name || tenantName),
        tax_code: String(hq.tax_code || ''),
        address: String(hq.address || ''),
        phone: String(hq.phone || ''),
        email: String(hq.email || ctx.userEmail || ''),
        representative_name: String(hq.representative_name || ''),
        tax_authority_code: cfg.tax_authority_code || '',
        tax_authority_name: cfg.tax_authority_name || '',
      };

      const period = periodRes.rows[0] || null;
      let slips: any[] = [];
      if (period) {
        const sRes = await client.query(
          `SELECT s.*, e.employee_code, e.full_name AS employee_name, e.tax_code,
                  e.id_card_number, e.bank_name, e.bank_account_number, e.is_resident, e.employment_type,
                  d.name AS department_name
           FROM tenant_payroll_slips s
           INNER JOIN tenant_hr_employees e ON e.tenant_id = s.tenant_id AND e.id = s.employee_id
           LEFT JOIN tenant_departments d ON d.tenant_id = e.tenant_id AND d.id = e.department_id
           WHERE s.tenant_id = $1 AND s.period_id = $2
           ORDER BY e.employee_code ASC`,
          [ctx.tenantId, period.id]
        );
        slips = sRes.rows.map((s) => ({
          ...s,
          base_salary_vnd: toNum(s.base_salary_vnd, 0),
          gross_pay_vnd: toNum(s.gross_pay_vnd, 0),
          emp_bhxh_vnd: toNum(s.emp_bhxh_vnd, 0),
          emp_bhyt_vnd: toNum(s.emp_bhyt_vnd, 0),
          emp_bhtn_vnd: toNum(s.emp_bhtn_vnd, 0),
          er_insurance_total_vnd: toNum(s.er_insurance_total_vnd, 0),
          taxable_income_vnd: toNum(s.taxable_income_vnd, 0),
          assessable_income_vnd: toNum(s.assessable_income_vnd, 0),
          pit_tax_vnd: toNum(s.pit_tax_vnd, 0),
          net_pay_vnd: toNum(s.net_pay_vnd, 0),
          breakdown: parseJsonSafe<Record<string, unknown>>(s.breakdown, {}),
        }));
      }

      const cfgRow = wsRowsRes.rows.find((r) => r.entry_type === 'workspace_config');
      const wsExtra = cfgRow ? parseJsonSafe<Record<string, unknown>>(cfgRow.extra_json, {}) : {};
      const regime: 'TT200' | 'TT133' = wsExtra.accounting_regime === 'TT133' ? 'TT133' : 'TT200';

      // Aggregate statutory journal totals from slips (or projected from active employees if period not generated yet)
      let totalGross = 0;
      let empBhxh = 0;
      let empBhyt = 0;
      let empBhtn = 0;
      let erIns = 0;
      let totalPit = 0;
      let totalNet = 0;

      if (slips.length > 0) {
        for (const s of slips) {
          totalGross += toNum(s.gross_pay_vnd, 0);
          empBhxh += toNum(s.emp_bhxh_vnd, 0);
          empBhyt += toNum(s.emp_bhyt_vnd, 0);
          empBhtn += toNum(s.emp_bhtn_vnd, 0);
          erIns += toNum(s.er_insurance_total_vnd, 0);
          totalPit += toNum(s.pit_tax_vnd, 0);
          totalNet += toNum(s.net_pay_vnd, 0);
        }
      } else {
        for (const e of empsRes.rows) {
          if (e.employment_status === 'resigned' || e.employment_status === 'terminated') continue;
          const sim = calculateEmployeePayslip(
            {
              base_salary_vnd: toNum(e.base_salary_vnd, 0),
              insurance_salary_vnd: toNum(e.insurance_salary_vnd, 0),
              insurance_enrolled: toBool(e.insurance_enrolled, true),
              is_resident: toBool(e.is_resident, true),
              employment_type: String(e.employment_type || 'full_time'),
              dependents_count: Number(e.dependents_count || 0),
              union_member: toBool(e.union_member, false),
              allowances_map: parseJsonSafe<Record<string, number>>(e.allowances_json, {}),
              standard_workdays: 22,
              actual_workdays: 22,
              paid_leave_days: 0,
              unpaid_leave_days: 0,
              overtime_hours: 0,
              commission_pay_vnd: 0,
              bonus_vnd: 0,
              advance_deduction_vnd: 0,
              other_deduction_vnd: 0,
            },
            cfg
          );
          totalGross += sim.gross_pay_vnd;
          empBhxh += sim.emp_bhxh_vnd;
          empBhyt += sim.emp_bhyt_vnd;
          empBhtn += sim.emp_bhtn_vnd;
          erIns += sim.er_insurance_total_vnd;
          totalPit += sim.pit_tax_vnd;
          totalNet += sim.net_pay_vnd;
        }
      }

      const autoJournalEntries = buildStatutoryPayrollJournalEntries({
        periodKey,
        regime,
        totalGross,
        empBhxh,
        empBhyt,
        empBhtn,
        erInsuranceTotal: erIns,
        totalPit,
        totalNet,
      });

      const customJournalRows = wsRowsRes.rows
        .filter((r) => r.entry_type === 'journal')
        .map((r, i) => ({
          id: r.id,
          seq: autoJournalEntries.length + i + 1,
          date: `${periodKey}-28`,
          voucher_no: r.voucher_no || `PKT-CUSTOM-${i + 1}`,
          description: r.account_name,
          debit_account: r.account_code,
          credit_account: String(parseJsonSafe<Record<string, unknown>>(r.extra_json, {}).credit_account || '1121'),
          amount_vnd: toNum(r.debit_vnd || r.credit_vnd, 0),
          entry_group: 'custom',
        }));

      // Compliance Alerts (Contract Expiry & Missing Tax/Bank Info)
      const nowMs = Date.now();
      const contractAlerts: Array<Record<string, unknown>> = [];
      for (const c of contractsRes.rows) {
        if (c.status === 'active' && c.end_date) {
          const endMs = new Date(c.end_date).getTime();
          const daysLeft = Math.ceil((endMs - nowMs) / 86_400_000);
          if (daysLeft <= 45) {
            contractAlerts.push({
              contract_id: c.id,
              contract_number: c.contract_number,
              employee_name: c.employee_name,
              employee_code: c.employee_code,
              end_date: c.end_date,
              days_left: daysLeft,
              severity: daysLeft < 0 ? 'bad' : daysLeft <= 15 ? 'warn' : 'info',
            });
          }
        }
      }

      const missingInfoEmployees = empsRes.rows
        .filter((e) => e.employment_status === 'active' && (!e.tax_code || !e.bank_account_number || !e.id_card_number))
        .map((e) => ({
          id: e.id,
          employee_code: e.employee_code,
          full_name: e.full_name,
          missing_fields: [
            !e.tax_code ? 'Mã số thuế TNCN' : null,
            !e.id_card_number ? 'CCCD/CMND' : null,
            !e.bank_account_number ? 'Số tài khoản ngân hàng' : null,
          ].filter(Boolean),
        }));

      return {
        period_key: periodKey,
        accounting_regime: regime,
        legal_entity: legalEntity,
        branches: branchesRes.rows,
        payroll_config: cfg,
        employees: empsRes.rows.map((e) => ({
          ...e,
          base_salary_vnd: toNum(e.base_salary_vnd, 0),
          insurance_salary_vnd: toNum(e.insurance_salary_vnd, 0),
          allowances_json: parseJsonSafe<Record<string, number>>(e.allowances_json, {}),
        })),
        contracts: contractsRes.rows,
        period,
        slips,
        is_projected: slips.length === 0,
        kpis: {
          total_employees: empsRes.rows.length,
          active_employees: empsRes.rows.filter((e) => e.employment_status === 'active').length,
          total_gross_vnd: Math.round(totalGross),
          total_emp_insurance_vnd: Math.round(empBhxh + empBhyt + empBhtn),
          total_er_insurance_vnd: Math.round(erIns),
          total_pit_tax_vnd: Math.round(totalPit),
          total_net_vnd: Math.round(totalNet),
        },
        journal_entries: [...autoJournalEntries, ...customJournalRows],
        alerts: {
          contract_alerts: contractAlerts,
          missing_info_employees: missingInfoEmployees,
        },
        workspace_state: wsExtra,
      };
    });

    res.json({ success: true, data: payload });
  } catch (err: any) {
    sendApiError(res, 500, 'GET_ACCOUNTING_AZ_FAILED', err?.message || 'Không thể tải không gian Kế toán A-Z.');
  }
});

const saveAccountingAzHandler = async (req: any, res: any) => {
  try {
    const ctx = getTenantContext();
    const b = req.body || {};
    const periodKey = String(b.period_key || b.fiscal_period || new Date().toISOString().slice(0, 7)).slice(0, 7);
    const regime: 'TT200' | 'TT133' = b.accounting_regime === 'TT133' ? 'TT133' : 'TT200';

    const saved = await withTenantTransaction(ctx.tenantId, async (client) => {
      const existing = await client.query<{ id: string; extra_json: unknown }>(
        `SELECT id, extra_json FROM tenant_accounting_az_workspace
         WHERE tenant_id = $1 AND fiscal_period = $2 AND entry_type = 'workspace_config'
         LIMIT 1`,
        [ctx.tenantId, periodKey]
      );

      const nextExtra = {
        ...(existing.rows[0] ? parseJsonSafe<Record<string, unknown>>(existing.rows[0].extra_json, {}) : {}),
        accounting_regime: regime,
        ...(b.sop_checklist ? { sop_checklist: b.sop_checklist } : {}),
        ...(b.tax_rule_mode ? { tax_rule_mode: b.tax_rule_mode } : {}),
        ...(b.notes !== undefined ? { notes: b.notes } : {}),
      };

      if (existing.rows[0]) {
        await client.query(
          `UPDATE tenant_accounting_az_workspace
           SET extra_json = $3::jsonb,
               updated_at = clock_timestamp()
           WHERE tenant_id = $1 AND id = $2`,
          [ctx.tenantId, existing.rows[0].id, JSON.stringify(nextExtra)]
        );
      } else {
        await client.query(
          `INSERT INTO tenant_accounting_az_workspace (
             id, tenant_id, fiscal_period, account_code, account_name,
             entry_type, debit_vnd, credit_vnd, balance_vnd, analytics_json, extra_json, created_by
           ) VALUES ($1, $2, $3, 'CFG', 'Cấu hình Kế toán A-Z', 'workspace_config', 0, 0, 0, '{}'::jsonb, $4::jsonb, $5)`,
          [crypto.randomUUID(), ctx.tenantId, periodKey, JSON.stringify(nextExtra), ctx.userId]
        );
      }

      if (b.custom_journal_entry && typeof b.custom_journal_entry === 'object') {
        const cj = b.custom_journal_entry;
        const amt = Math.max(0, toNum(cj.amount_vnd, 0));
        if (amt > 0) {
          await client.query(
            `INSERT INTO tenant_accounting_az_workspace (
               id, tenant_id, fiscal_period, account_code, account_name, voucher_no,
               entry_type, debit_vnd, credit_vnd, balance_vnd, analytics_json, extra_json, created_by
             ) VALUES ($1, $2, $3, $4, $5, $6, 'journal', $7, $7, 0, '{}'::jsonb, $8::jsonb, $9)`,
            [
              crypto.randomUUID(),
              ctx.tenantId,
              periodKey,
              String(cj.debit_account || '6421'),
              String(cj.description || 'Bút toán bổ sung'),
              String(cj.voucher_no || `PKT-BS-${periodKey}`),
              amt,
              JSON.stringify({ credit_account: String(cj.credit_account || '1121') }),
              ctx.userId,
            ]
          );
        }
      }

      return { period_key: periodKey, accounting_regime: regime, workspace_state: nextExtra };
    });

    res.json({ success: true, data: saved });
  } catch (err: any) {
    sendApiError(res, 500, 'SAVE_ACCOUNTING_AZ_FAILED', err?.message || 'Không thể lưu dữ liệu Kế toán A-Z.');
  }
};

payrollRouter.put('/accounting-az', requirePermission('payroll', 'edit'), saveAccountingAzHandler);
payrollRouter.post('/accounting-az', requirePermission('payroll', 'edit'), saveAccountingAzHandler);
