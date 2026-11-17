import crypto from 'node:crypto';
import type { DbClient } from '../../core/database/db-adapter.ts';
import { parseJsonSafe, toBool, toNum } from '../hrm/schema.ts';

export interface PitBracket {
  up_to: number | null;
  rate: number;
}

export interface AllowanceDefinition {
  key: string;
  name: string;
  tax_mode: 'taxable' | 'meal_cap' | 'exempt';
  prorate: boolean;
  include_insurance: boolean;
}

export interface TenantPayrollConfigResolved {
  id?: string;
  currency: string;
  standard_workdays_mode: 'calendar' | 'fixed';
  fixed_standard_workdays: number;
  saturday_work_mode: 'off' | 'half' | 'full';
  emp_bhxh_rate: number;
  emp_bhyt_rate: number;
  emp_bhtn_rate: number;
  er_bhxh_rate: number;
  er_bhyt_rate: number;
  er_bhtn_rate: number;
  er_union_rate: number;
  emp_union_rate: number;
  bhxh_salary_cap_vnd: number;
  bhtn_salary_cap_vnd: number;
  personal_deduction_vnd: number;
  dependent_deduction_vnd: number;
  meal_allowance_exempt_cap_vnd: number;
  non_resident_flat_tax_rate: number;
  casual_withholding_threshold_vnd: number;
  casual_flat_tax_rate: number;
  pit_brackets: PitBracket[];
  allowance_definitions: AllowanceDefinition[];
  tax_authority_code: string | null;
  tax_authority_name: string | null;
}

export const DEFAULT_PIT_BRACKETS: PitBracket[] = [
  { up_to: 5_000_000, rate: 0.05 },
  { up_to: 10_000_000, rate: 0.10 },
  { up_to: 18_000_000, rate: 0.15 },
  { up_to: 32_000_000, rate: 0.20 },
  { up_to: 52_000_000, rate: 0.25 },
  { up_to: 80_000_000, rate: 0.30 },
  { up_to: null, rate: 0.35 },
];

export const DEFAULT_ALLOWANCE_DEFINITIONS: AllowanceDefinition[] = [
  { key: 'meal', name: 'Phụ cấp ăn trưa', tax_mode: 'meal_cap', prorate: true, include_insurance: false },
  { key: 'responsibility', name: 'Phụ cấp trách nhiệm', tax_mode: 'taxable', prorate: true, include_insurance: true },
  { key: 'transport', name: 'Phụ cấp xăng xe & điện thoại', tax_mode: 'taxable', prorate: true, include_insurance: false },
];

export function computeStandardWorkdaysForMonth(
  year: number,
  month: number,
  cfg: Pick<TenantPayrollConfigResolved, 'standard_workdays_mode' | 'fixed_standard_workdays' | 'saturday_work_mode'>
): number {
  if (cfg.standard_workdays_mode === 'fixed' && cfg.fixed_standard_workdays > 0) {
    return cfg.fixed_standard_workdays;
  }
  const daysInMonth = new Date(year, month, 0).getDate();
  let count = 0;
  for (let d = 1; d <= daysInMonth; d++) {
    const dow = new Date(year, month - 1, d).getDay();
    if (dow === 0) continue;
    if (dow === 6) {
      if (cfg.saturday_work_mode === 'full') count += 1;
      else if (cfg.saturday_work_mode === 'half') count += 0.5;
    } else {
      count += 1;
    }
  }
  return count || 22;
}

export interface ProgressiveTaxBreakdownItem {
  bracket_index: number;
  from_vnd: number;
  to_vnd: number | null;
  rate: number;
  taxable_slice_vnd: number;
  tax_vnd: number;
}

export function computeProgressivePitTax(
  assessableIncomeVnd: number,
  brackets: PitBracket[],
  annualMultiplier = 1
): { total_tax_vnd: number; breakdown: ProgressiveTaxBreakdownItem[] } {
  if (!(assessableIncomeVnd > 0)) {
    return { total_tax_vnd: 0, breakdown: [] };
  }

  const effectiveBrackets = brackets && brackets.length > 0 ? brackets : DEFAULT_PIT_BRACKETS;
  let totalTax = 0;
  let prevCap = 0;
  const breakdown: ProgressiveTaxBreakdownItem[] = [];

  for (let idx = 0; idx < effectiveBrackets.length; idx++) {
    const b = effectiveBrackets[idx];
    const cap = b.up_to !== null && b.up_to !== undefined && Number(b.up_to) > 0
      ? Number(b.up_to) * annualMultiplier
      : Infinity;
    const rate = Math.max(0, Number(b.rate || 0));
    const slice = Math.max(0, Math.min(assessableIncomeVnd, cap) - prevCap);
    const sliceTax = slice * rate;
    if (slice > 0) {
      totalTax += sliceTax;
      breakdown.push({
        bracket_index: idx + 1,
        from_vnd: prevCap,
        to_vnd: Number.isFinite(cap) ? cap : null,
        rate,
        taxable_slice_vnd: Math.round(slice),
        tax_vnd: Math.round(sliceTax),
      });
    }
    if (assessableIncomeVnd <= cap) break;
    prevCap = cap;
  }

  return {
    total_tax_vnd: Math.round(totalTax),
    breakdown,
  };
}

export interface PayslipCalculationInput {
  base_salary_vnd: number;
  insurance_salary_vnd?: number;
  insurance_enrolled: boolean;
  is_resident: boolean;
  employment_type: 'full_time' | 'part_time' | 'contractor' | 'intern' | string;
  dependents_count: number;
  union_member: boolean;
  allowances_map: Record<string, number>;
  standard_workdays: number;
  actual_workdays: number;
  paid_leave_days: number;
  unpaid_leave_days: number;
  overtime_hours: number;
  overtime_multiplier?: number;
  commission_pay_vnd: number;
  bonus_vnd?: number;
  advance_deduction_vnd?: number;
  other_deduction_vnd?: number;
}

export interface PayslipCalculationOutput {
  standard_workdays: number;
  actual_workdays: number;
  paid_leave_days: number;
  unpaid_leave_days: number;
  overtime_hours: number;
  base_salary_vnd: number;
  prorated_base_pay_vnd: number;
  allowances_vnd: number;
  tax_exempt_vnd: number;
  overtime_pay_vnd: number;
  commission_pay_vnd: number;
  bonus_vnd: number;
  gross_pay_vnd: number;
  insurance_salary_base_vnd: number;
  emp_bhxh_vnd: number;
  emp_bhyt_vnd: number;
  emp_bhtn_vnd: number;
  emp_insurance_total_vnd: number;
  emp_union_vnd: number;
  er_bhxh_vnd: number;
  er_bhyt_vnd: number;
  er_bhtn_vnd: number;
  er_union_vnd: number;
  er_insurance_total_vnd: number;
  dependents_count: number;
  family_deduction_vnd: number;
  taxable_income_vnd: number;
  assessable_income_vnd: number;
  pit_tax_vnd: number;
  advance_deduction_vnd: number;
  other_deduction_vnd: number;
  net_pay_vnd: number;
  tax_method: 'progressive' | 'casual_flat' | 'non_resident_flat';
  pit_breakdown: ProgressiveTaxBreakdownItem[];
  allowance_lines: Array<{ key: string; name: string; amount_vnd: number; exempt_vnd: number }>;
}

export function calculateEmployeePayslip(
  input: PayslipCalculationInput,
  cfg: TenantPayrollConfigResolved
): PayslipCalculationOutput {
  const stdDays = Math.max(1, input.standard_workdays || 22);
  const payableDays = Math.max(0, input.actual_workdays + input.paid_leave_days);
  const payRatio = Math.min(1.5, payableDays / stdDays);
  const workRatio = Math.min(1.5, Math.max(0, input.actual_workdays) / stdDays);

  const baseSalary = Math.max(0, Math.round(input.base_salary_vnd || 0));
  const proratedBase = Math.round(baseSalary * payRatio);

  // Allowances
  const allowanceLines: Array<{ key: string; name: string; amount_vnd: number; exempt_vnd: number }> = [];
  let totalAllowances = 0;
  let allowanceExempt = 0;
  let insuranceAllowanceSum = 0;

  const defsMap = new Map<string, AllowanceDefinition>();
  for (const d of cfg.allowance_definitions || DEFAULT_ALLOWANCE_DEFINITIONS) {
    defsMap.set(d.key, d);
  }

  for (const [k, rawVal] of Object.entries(input.allowances_map || {})) {
    const rawAmt = Math.max(0, toNum(rawVal, 0));
    if (rawAmt <= 0) continue;
    const def = defsMap.get(k) || {
      key: k,
      name: k,
      tax_mode: 'taxable' as const,
      prorate: false,
      include_insurance: false,
    };
    const appliedAmt = def.prorate
      ? Math.round(rawAmt * (def.tax_mode === 'meal_cap' ? workRatio : payRatio))
      : Math.round(rawAmt);

    let exAmt = 0;
    if (def.tax_mode === 'exempt') {
      exAmt = appliedAmt;
    } else if (def.tax_mode === 'meal_cap') {
      exAmt = Math.min(appliedAmt, Math.max(0, cfg.meal_allowance_exempt_cap_vnd));
    }

    totalAllowances += appliedAmt;
    allowanceExempt += exAmt;
    if (def.include_insurance) {
      insuranceAllowanceSum += rawAmt;
    }
    allowanceLines.push({
      key: k,
      name: def.name,
      amount_vnd: appliedAmt,
      exempt_vnd: exAmt,
    });
  }

  // Overtime pay + OT premium tax exemption (portion above 100% normal hourly wage is PIT-exempt)
  const otHours = Math.max(0, toNum(input.overtime_hours, 0));
  const otMult = Math.max(1, toNum(input.overtime_multiplier, 1.5));
  const hourlyRate = baseSalary / stdDays / 8;
  const otPay = Math.round(hourlyRate * otHours * otMult);
  const otNormalPortion = Math.round(hourlyRate * otHours);
  const otExempt = Math.max(0, otPay - otNormalPortion);

  const commissionPay = Math.max(0, Math.round(input.commission_pay_vnd || 0));
  const bonusVnd = Math.max(0, Math.round(input.bonus_vnd || 0));
  const grossPay = proratedBase + totalAllowances + otPay + commissionPay + bonusVnd;
  const taxExemptTotal = allowanceExempt + otExempt;
  const taxableIncome = Math.max(0, grossPay - taxExemptTotal);

  // Statutory Insurance (BHXH / BHYT / BHTN)
  const isLabourContract = !['contractor', 'intern'].includes(String(input.employment_type || '').toLowerCase());
  const insEligible = Boolean(input.insurance_enrolled && isLabourContract && payableDays > 0 && input.unpaid_leave_days < 14);
  const rawInsBase =
    input.insurance_salary_vnd && input.insurance_salary_vnd > 0
      ? input.insurance_salary_vnd
      : baseSalary + insuranceAllowanceSum;
  const insBase = insEligible ? Math.max(0, Math.round(rawInsBase)) : 0;

  const cappedBhxhBase = Math.min(insBase, Math.max(0, cfg.bhxh_salary_cap_vnd));
  const cappedBhtnBase = Math.min(insBase, Math.max(0, cfg.bhtn_salary_cap_vnd));

  const empBhxh = Math.round(cappedBhxhBase * cfg.emp_bhxh_rate);
  const empBhyt = Math.round(cappedBhxhBase * cfg.emp_bhyt_rate);
  const empBhtn = Math.round(cappedBhtnBase * cfg.emp_bhtn_rate);
  const empInsuranceTotal = empBhxh + empBhyt + empBhtn;
  const empUnion = input.union_member && insEligible ? Math.round(cappedBhxhBase * cfg.emp_union_rate) : 0;

  const erBhxh = Math.round(cappedBhxhBase * cfg.er_bhxh_rate);
  const erBhyt = Math.round(cappedBhxhBase * cfg.er_bhyt_rate);
  const erBhtn = Math.round(cappedBhtnBase * cfg.er_bhtn_rate);
  const erUnion = insEligible ? Math.round(cappedBhxhBase * cfg.er_union_rate) : 0;
  const erInsuranceTotal = erBhxh + erBhyt + erBhtn + erUnion;

  // PIT Calculation
  const dependents = Math.max(0, Math.floor(input.dependents_count || 0));
  let familyDeduction = 0;
  let assessableIncome = 0;
  let pitTax = 0;
  let taxMethod: 'progressive' | 'casual_flat' | 'non_resident_flat' = 'progressive';
  let pitBreakdown: ProgressiveTaxBreakdownItem[] = [];

  if (!input.is_resident) {
    taxMethod = 'non_resident_flat';
    assessableIncome = taxableIncome;
    pitTax = Math.round(taxableIncome * cfg.non_resident_flat_tax_rate);
  } else if (!isLabourContract) {
    taxMethod = 'casual_flat';
    assessableIncome = taxableIncome;
    pitTax =
      taxableIncome >= cfg.casual_withholding_threshold_vnd
        ? Math.round(taxableIncome * cfg.casual_flat_tax_rate)
        : 0;
  } else {
    taxMethod = 'progressive';
    familyDeduction =
      Math.round(cfg.personal_deduction_vnd) + dependents * Math.round(cfg.dependent_deduction_vnd);
    assessableIncome = Math.max(0, taxableIncome - empInsuranceTotal - familyDeduction);
    const progRes = computeProgressivePitTax(assessableIncome, cfg.pit_brackets);
    pitTax = progRes.total_tax_vnd;
    pitBreakdown = progRes.breakdown;
  }

  const advanceDeduction = Math.max(0, Math.round(input.advance_deduction_vnd || 0));
  const otherDeduction = Math.max(0, Math.round(input.other_deduction_vnd || 0));
  const netPay =
    grossPay - empInsuranceTotal - empUnion - pitTax - advanceDeduction - otherDeduction;

  return {
    standard_workdays: stdDays,
    actual_workdays: input.actual_workdays,
    paid_leave_days: input.paid_leave_days,
    unpaid_leave_days: input.unpaid_leave_days,
    overtime_hours: otHours,
    base_salary_vnd: baseSalary,
    prorated_base_pay_vnd: proratedBase,
    allowances_vnd: totalAllowances,
    tax_exempt_vnd: taxExemptTotal,
    overtime_pay_vnd: otPay,
    commission_pay_vnd: commissionPay,
    bonus_vnd: bonusVnd,
    gross_pay_vnd: grossPay,
    insurance_salary_base_vnd: insBase,
    emp_bhxh_vnd: empBhxh,
    emp_bhyt_vnd: empBhyt,
    emp_bhtn_vnd: empBhtn,
    emp_insurance_total_vnd: empInsuranceTotal,
    emp_union_vnd: empUnion,
    er_bhxh_vnd: erBhxh,
    er_bhyt_vnd: erBhyt,
    er_bhtn_vnd: erBhtn,
    er_union_vnd: erUnion,
    er_insurance_total_vnd: erInsuranceTotal,
    dependents_count: dependents,
    family_deduction_vnd: familyDeduction,
    taxable_income_vnd: taxableIncome,
    assessable_income_vnd: assessableIncome,
    pit_tax_vnd: pitTax,
    advance_deduction_vnd: advanceDeduction,
    other_deduction_vnd: otherDeduction,
    net_pay_vnd: netPay,
    tax_method: taxMethod,
    pit_breakdown: pitBreakdown,
    allowance_lines: allowanceLines,
  };
}

/**
 * Bidirectional Gross <-> Net Simulator using binary search for exact Net -> Gross inversion.
 */
export function simulateGrossNet(
  params: {
    mode: 'gross_to_net' | 'net_to_gross';
    amount_vnd: number;
    dependents_count?: number;
    insurance_salary_vnd?: number | null;
    is_resident?: boolean;
  },
  cfg: TenantPayrollConfigResolved
): PayslipCalculationOutput & { total_employer_cost_vnd: number } {
  const targetAmount = Math.max(0, Math.round(params.amount_vnd || 0));
  const evalForGross = (grossCandidate: number) =>
    calculateEmployeePayslip(
      {
        base_salary_vnd: grossCandidate,
        insurance_salary_vnd:
          params.insurance_salary_vnd && params.insurance_salary_vnd > 0
            ? params.insurance_salary_vnd
            : undefined,
        insurance_enrolled: true,
        is_resident: params.is_resident !== false,
        employment_type: 'full_time',
        dependents_count: params.dependents_count || 0,
        union_member: false,
        allowances_map: {},
        standard_workdays: 22,
        actual_workdays: 22,
        paid_leave_days: 0,
        unpaid_leave_days: 0,
        overtime_hours: 0,
        commission_pay_vnd: 0,
      },
      cfg
    );

  if (params.mode === 'gross_to_net') {
    const res = evalForGross(targetAmount);
    return {
      ...res,
      total_employer_cost_vnd: res.gross_pay_vnd + res.er_insurance_total_vnd,
    };
  }

  // Net -> Gross inversion via monotonic binary search
  let low = targetAmount;
  let high = Math.max(targetAmount * 2 + 20_000_000, 50_000_000);
  while (evalForGross(high).net_pay_vnd < targetAmount && high < 50_000_000_000) {
    high *= 2;
  }

  for (let iter = 0; iter < 60; iter++) {
    const mid = Math.floor((low + high) / 2);
    const out = evalForGross(mid);
    if (out.net_pay_vnd < targetAmount) {
      low = mid + 1;
    } else {
      high = mid;
    }
  }

  const solved = evalForGross(high);
  return {
    ...solved,
    total_employer_cost_vnd: solved.gross_pay_vnd + solved.er_insurance_total_vnd,
  };
}

function escapeXml(raw: unknown): string {
  return String(raw ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/**
 * Generates a valid General Department of Taxation (GDT Vietnam) HTKK 05/KK-TNCN (TT80/2021) XML declaration
 * dynamically populated from Tenant Branch Legal Entity & Period Payslips (ZERO hardcoded company names!).
 */
export function buildHtkk05KkXml(params: {
  year: number;
  month: number;
  legalEntityName: string;
  taxCode: string;
  address: string;
  phone: string;
  email: string;
  signerName: string;
  taxAuthorityCode: string;
  taxAuthorityName: string;
  slips: Array<{
    is_resident: boolean;
    employment_type: string;
    gross_pay_vnd: number;
    taxable_income_vnd: number;
    pit_tax_vnd: number;
  }>;
}): string {
  const activeSlips = params.slips.filter((s) => toNum(s.gross_pay_vnd, 0) > 0);
  const residents = activeSlips.filter((s) => s.is_resident !== false);
  const nonResidents = activeSlips.filter((s) => s.is_resident === false);

  const resLabour = residents.filter(
    (s) => !['contractor', 'intern'].includes(String(s.employment_type || '').toLowerCase())
  );
  const withheldRes = residents.filter((s) => toNum(s.pit_tax_vnd, 0) > 0);
  const withheldNonRes = nonResidents.filter((s) => toNum(s.pit_tax_vnd, 0) > 0);

  const sumField = (arr: typeof activeSlips, key: 'taxable_income_vnd' | 'pit_tax_vnd') =>
    Math.round(arr.reduce((acc, item) => acc + toNum(item[key], 0), 0));

  const ct16 = activeSlips.length;
  const ct17 = resLabour.length;
  const ct19 = withheldRes.length;
  const ct20 = withheldNonRes.length;
  const ct18 = ct19 + ct20;

  const ct22 = sumField(residents, 'taxable_income_vnd');
  const ct23 = sumField(nonResidents, 'taxable_income_vnd');
  const ct21 = ct22 + ct23;

  const ct27 = sumField(withheldRes, 'taxable_income_vnd');
  const ct28 = sumField(withheldNonRes, 'taxable_income_vnd');
  const ct26 = ct27 + ct28;

  const ct30 = sumField(withheldRes, 'pit_tax_vnd');
  const ct31 = sumField(withheldNonRes, 'pit_tax_vnd');
  const ct29 = ct30 + ct31;

  const mm = String(params.month).padStart(2, '0');
  const lastDay = String(new Date(params.year, params.month, 0).getDate()).padStart(2, '0');
  const todayIso = new Date().toISOString().slice(0, 10);

  return `<?xml version="1.0" encoding="UTF-8"?>
<HSoThueDTu xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xmlns="http://kekhaithue.gdt.gov.vn/TKhaiThue">
  <HSoKhaiThue id="ID_1">
    <TTinChung>
      <TTinDVu>
        <maDVu>HTKK</maDVu>
        <tenDVu>HỖ TRỢ KÊ KHAI THUẾ</tenDVu>
        <pbanDVu>5.7.8</pbanDVu>
        <ttinNhaCCapDVu>DOMATION_ERP_PAYROLL_ENGINE</ttinNhaCCapDVu>
      </TTinDVu>
      <TTinTKhaiThue>
        <TKhaiThue>
          <maTKhai>864</maTKhai>
          <tenTKhai>TK khấu trừ thuế thu nhập cá nhân Mẫu 05/KK-TNCN (TT80/2021)</tenTKhai>
          <moTaBMau>(Ban hành kèm theo Thông tư số 80/2021/TT-BTC)</moTaBMau>
          <pbanTKhaiXML>2.9.3</pbanTKhaiXML>
          <loaiTKhai>C</loaiTKhai>
          <soLan>0</soLan>
          <KyKKhaiThue>
            <kieuKy>M</kieuKy>
            <kyKKhai>${mm}/${params.year}</kyKKhai>
            <kyKKhaiTuNgay>01/${mm}/${params.year}</kyKKhaiTuNgay>
            <kyKKhaiDenNgay>${lastDay}/${mm}/${params.year}</kyKKhaiDenNgay>
            <kyKKhaiTuThang />
            <kyKKhaiDenThang />
          </KyKKhaiThue>
          <maCQTNoiNop>${escapeXml(params.taxAuthorityCode)}</maCQTNoiNop>
          <tenCQTNoiNop>${escapeXml(params.taxAuthorityName)}</tenCQTNoiNop>
          <ngayLapTKhai>${todayIso}</ngayLapTKhai>
          <nguoiKy>${escapeXml(params.signerName)}</nguoiKy>
          <ngayKy>${todayIso}</ngayKy>
        </TKhaiThue>
        <NNT>
          <mst>${escapeXml(params.taxCode)}</mst>
          <tenNNT>${escapeXml(params.legalEntityName)}</tenNNT>
          <dchiNNT>${escapeXml(params.address)}</dchiNNT>
          <dthoaiNNT>${escapeXml(params.phone)}</dthoaiNNT>
          <emailNNT>${escapeXml(params.email)}</emailNNT>
        </NNT>
      </TTinTKhaiThue>
    </TTinChung>
    <CTieuTKhaiChinh>
      <mst_cu>${escapeXml(params.taxCode)}</mst_cu>
      <ct15>0</ct15>
      <ct16>${ct16}</ct16>
      <ct17>${ct17}</ct17>
      <ct18>${ct18}</ct18>
      <ct19>${ct19}</ct19>
      <ct20>${ct20}</ct20>
      <ct21>${ct21}</ct21>
      <ct22>${ct22}</ct22>
      <ct23>${ct23}</ct23>
      <ct24>0</ct24>
      <ct25>0</ct25>
      <ct25_1>0</ct25_1>
      <ct26>${ct26}</ct26>
      <ct27>${ct27}</ct27>
      <ct28>${ct28}</ct28>
      <ct29>${ct29}</ct29>
      <ct30>${ct30}</ct30>
      <ct31>${ct31}</ct31>
      <ct32>0</ct32>
    </CTieuTKhaiChinh>
  </HSoKhaiThue>
</HSoThueDTu>`;
}

export function buildPayrollCsv(
  periodKey: string,
  slips: Array<Record<string, any>>
): string {
  const escCsv = (val: unknown) => {
    const s = String(val ?? '');
    if (/[",\n\r]/.test(s)) {
      return `"${s.replace(/"/g, '""')}"`;
    }
    return s;
  };

  const headers = [
    'Ky_Luong',
    'Ma_NV',
    'Ho_Va_Ten',
    'Ma_So_Thue',
    'Cong_Chuan',
    'Cong_Thuc_Te',
    'Luong_Co_Ban',
    'Luong_Theo_Cong',
    'Phu_Cap',
    'Tang_Ca_OT',
    'Hoa_Hong_KPI',
    'Thuong',
    'Tong_Thu_Nhap_Gross',
    'BHXH_8%',
    'BHYT_1.5%',
    'BHTN_1%',
    'Nguoi_Phu_Thuoc',
    'Giam_Tru_Gia_Canh',
    'Thu_Nhap_Tinh_Thue',
    'Thue_TNCN',
    'Thuc_Linh_Net',
    'Ngan_Hang',
    'So_Tai_Khoan',
  ];

  const lines = [headers.join(',')];
  for (const r of slips) {
    lines.push(
      [
        periodKey,
        r.employee_code || '',
        r.employee_name || '',
        r.tax_code || '',
        toNum(r.standard_workdays, 22),
        toNum(r.actual_workdays, 0),
        Math.round(toNum(r.base_salary_vnd, 0)),
        Math.round(toNum(r.prorated_base_pay_vnd, 0)),
        Math.round(toNum(r.allowances_vnd, 0)),
        Math.round(toNum(r.overtime_pay_vnd, 0)),
        Math.round(toNum(r.commission_pay_vnd, 0)),
        Math.round(toNum(r.bonus_vnd, 0)),
        Math.round(toNum(r.gross_pay_vnd, 0)),
        Math.round(toNum(r.emp_bhxh_vnd, 0)),
        Math.round(toNum(r.emp_bhyt_vnd, 0)),
        Math.round(toNum(r.emp_bhtn_vnd, 0)),
        Number(r.dependents_count || 0),
        Math.round(toNum(r.family_deduction_vnd, 0)),
        Math.round(toNum(r.assessable_income_vnd, 0)),
        Math.round(toNum(r.pit_tax_vnd, 0)),
        Math.round(toNum(r.net_pay_vnd, 0)),
        r.bank_name || '',
        r.bank_account_number || '',
      ]
        .map(escCsv)
        .join(',')
    );
  }

  return '\uFEFF' + lines.join('\r\n');
}

export async function getOrSeedTenantPayrollConfigInTx(
  client: DbClient,
  tenantId: string
): Promise<TenantPayrollConfigResolved> {
  const existing = await client.query(
    'SELECT * FROM tenant_payroll_configs WHERE tenant_id = $1 LIMIT 1',
    [tenantId]
  );

  if (existing.rows.length === 0) {
    const id = crypto.randomUUID();
    await client.query(
      `INSERT INTO tenant_payroll_configs (
         id, tenant_id, currency, standard_workdays_mode, fixed_standard_workdays,
         saturday_work_mode, pit_brackets, allowance_definitions
       ) VALUES ($1, $2, 'VND', 'calendar', 22, 'off', $3::jsonb, $4::jsonb)`,
      [
        id,
        tenantId,
        JSON.stringify(DEFAULT_PIT_BRACKETS),
        JSON.stringify(DEFAULT_ALLOWANCE_DEFINITIONS),
      ]
    );
    return getOrSeedTenantPayrollConfigInTx(client, tenantId);
  }

  const row = existing.rows[0];
  return {
    id: String(row.id),
    currency: String(row.currency || 'VND'),
    standard_workdays_mode: row.standard_workdays_mode === 'fixed' ? 'fixed' : 'calendar',
    fixed_standard_workdays: toNum(row.fixed_standard_workdays, 22),
    saturday_work_mode:
      row.saturday_work_mode === 'full'
        ? 'full'
        : row.saturday_work_mode === 'half'
          ? 'half'
          : 'off',
    emp_bhxh_rate: toNum(row.emp_bhxh_rate, 0.08),
    emp_bhyt_rate: toNum(row.emp_bhyt_rate, 0.015),
    emp_bhtn_rate: toNum(row.emp_bhtn_rate, 0.01),
    er_bhxh_rate: toNum(row.er_bhxh_rate, 0.175),
    er_bhyt_rate: toNum(row.er_bhyt_rate, 0.03),
    er_bhtn_rate: toNum(row.er_bhtn_rate, 0.01),
    er_union_rate: toNum(row.er_union_rate, 0.02),
    emp_union_rate: toNum(row.emp_union_rate, 0.01),
    bhxh_salary_cap_vnd: toNum(row.bhxh_salary_cap_vnd, 46_800_000),
    bhtn_salary_cap_vnd: toNum(row.bhtn_salary_cap_vnd, 99_200_000),
    personal_deduction_vnd: toNum(row.personal_deduction_vnd, 11_000_000),
    dependent_deduction_vnd: toNum(row.dependent_deduction_vnd, 4_400_000),
    meal_allowance_exempt_cap_vnd: toNum(row.meal_allowance_exempt_cap_vnd, 730_000),
    non_resident_flat_tax_rate: toNum(row.non_resident_flat_tax_rate, 0.2),
    casual_withholding_threshold_vnd: toNum(row.casual_withholding_threshold_vnd, 2_000_000),
    casual_flat_tax_rate: toNum(row.casual_flat_tax_rate, 0.1),
    pit_brackets: parseJsonSafe<PitBracket[]>(row.pit_brackets, DEFAULT_PIT_BRACKETS),
    allowance_definitions: parseJsonSafe<AllowanceDefinition[]>(
      row.allowance_definitions,
      DEFAULT_ALLOWANCE_DEFINITIONS
    ),
    tax_authority_code: row.tax_authority_code ? String(row.tax_authority_code) : null,
    tax_authority_name: row.tax_authority_name ? String(row.tax_authority_name) : null,
  };
}
