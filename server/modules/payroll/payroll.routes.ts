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
