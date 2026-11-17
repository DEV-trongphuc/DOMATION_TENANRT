import crypto from 'node:crypto';
import type { DbClient } from '../../core/database/db-adapter.ts';
import { parseJsonSafe, toBool, toNum } from '../hrm/schema.ts';

export interface ResolvedStepAssignee {
  assigned_user_id: string;
  assigned_user_name: string;
  original_approver_user_id: string;
  delegated_from_user_id: string | null;
}

export interface ResolvedApprovalStepPlan {
  step_id: string | null;
  step_order: number;
  original_step_order: number;
  step_name: string;
  approver_type: string;
  approval_mode: 'any_one' | 'all_must_approve';
  fallback_strategy: 'escalate_parent_dept' | 'tenant_admin';
  sla_hours: number;
  require_signature: boolean;
  assignees: ResolvedStepAssignee[];
}

interface OrgGraphUser {
  id: string;
  full_name: string;
  email: string;
  role: string;
  role_id: string | null;
  branch_id: string | null;
  department_id: string | null;
  team_id: string | null;
  reports_to_user_id: string | null;
  is_tenant_owner: boolean;
  is_active: boolean;
}

interface OrgGraphDept {
  id: string;
  branch_id: string | null;
  parent_department_id: string | null;
  manager_user_id: string | null;
  name: string;
}

interface OrgGraphTeam {
  id: string;
  department_id: string | null;
  branch_id: string | null;
  leader_user_id: string | null;
}

interface OrgGraphBranch {
  id: string;
  manager_user_id: string | null;
  work_schedule: unknown;
}

/**
 * Dynamically resolves N-step approval assignees for a given workflow, requester, and amount.
 * Zero hardcoded user IDs, names, emails, or fixed column counts.
 */
export async function resolveDynamicApprovalStepsInTx(
  client: DbClient,
  params: {
    tenantId: string;
    workflowId: string;
    requesterUserId: string;
    amountVnd: number;
    category: string;
    referenceTime?: Date;
  }
): Promise<ResolvedApprovalStepPlan[]> {
  const { tenantId, workflowId, requesterUserId, amountVnd, category } = params;
  const now = params.referenceTime || new Date();

  const [stepsRes, usersRes, deptsRes, teamsRes, branchesRes, hrEmpRes, delegationsRes] = await Promise.all([
    client.query(
      `SELECT id, step_order, step_name, approver_type, approver_role_id, approver_user_id,
              min_amount_threshold, max_amount_threshold, approval_mode, fallback_strategy,
              sla_hours, require_signature
       FROM tenant_approval_workflow_steps
       WHERE tenant_id = $1 AND workflow_id = $2
       ORDER BY step_order ASC, created_at ASC`,
      [tenantId, workflowId]
    ),
    client.query(
      `SELECT id, full_name, email, role, role_id, branch_id, department_id, team_id,
              reports_to_user_id, is_tenant_owner, is_system_bot
       FROM users
       WHERE tenant_id = $1`,
      [tenantId]
    ),
    client.query(
      `SELECT id, branch_id, parent_department_id, manager_user_id, name
       FROM tenant_departments
       WHERE tenant_id = $1 AND is_active = true`,
      [tenantId]
    ),
    client.query(
      `SELECT id, department_id, branch_id, leader_user_id
       FROM tenant_teams
       WHERE tenant_id = $1 AND is_active = true`,
      [tenantId]
    ),
    client.query(
      `SELECT id, manager_user_id, work_schedule
       FROM tenant_branches
       WHERE tenant_id = $1 AND is_active = true`,
      [tenantId]
    ),
    client.query(
      `SELECT user_id, branch_id, department_id, team_id, manager_user_id
       FROM tenant_hr_employees
       WHERE tenant_id = $1 AND user_id = $2
       LIMIT 1`,
      [tenantId, requesterUserId]
    ),
    client.query(
      `SELECT delegator_user_id, delegate_user_id, categories, valid_from, valid_until
       FROM tenant_approval_delegations
       WHERE tenant_id = $1 AND is_active = true`,
      [tenantId]
    ),
  ]);

  const usersMap = new Map<string, OrgGraphUser>();
  for (const row of usersRes.rows) {
    usersMap.set(String(row.id), {
      id: String(row.id),
      full_name: String(row.full_name || row.email || 'User'),
      email: String(row.email || ''),
      role: String(row.role || 'sale'),
      role_id: row.role_id ? String(row.role_id) : null,
      branch_id: row.branch_id ? String(row.branch_id) : null,
      department_id: row.department_id ? String(row.department_id) : null,
      team_id: row.team_id ? String(row.team_id) : null,
      reports_to_user_id: row.reports_to_user_id ? String(row.reports_to_user_id) : null,
      is_tenant_owner: toBool(row.is_tenant_owner, false),
      is_active: !toBool(row.is_system_bot, false),
    });
  }

  const deptsMap = new Map<string, OrgGraphDept>();
  for (const d of deptsRes.rows) {
    deptsMap.set(String(d.id), {
      id: String(d.id),
      branch_id: d.branch_id ? String(d.branch_id) : null,
      parent_department_id: d.parent_department_id ? String(d.parent_department_id) : null,
      manager_user_id: d.manager_user_id ? String(d.manager_user_id) : null,
      name: String(d.name || ''),
    });
  }

  const teamsMap = new Map<string, OrgGraphTeam>();
  for (const t of teamsRes.rows) {
    teamsMap.set(String(t.id), {
      id: String(t.id),
      department_id: t.department_id ? String(t.department_id) : null,
      branch_id: t.branch_id ? String(t.branch_id) : null,
      leader_user_id: t.leader_user_id ? String(t.leader_user_id) : null,
    });
  }

  const branchesMap = new Map<string, OrgGraphBranch>();
  for (const b of branchesRes.rows) {
    branchesMap.set(String(b.id), {
      id: String(b.id),
      manager_user_id: b.manager_user_id ? String(b.manager_user_id) : null,
      work_schedule: b.work_schedule,
    });
  }

  const requesterUser = usersMap.get(requesterUserId);
  const hrEmp = hrEmpRes.rows[0] || null;

  const effectiveTeamId = (hrEmp?.team_id ? String(hrEmp.team_id) : null) || requesterUser?.team_id || null;
  const effectiveDeptId =
    (hrEmp?.department_id ? String(hrEmp.department_id) : null) ||
    requesterUser?.department_id ||
    (effectiveTeamId ? teamsMap.get(effectiveTeamId)?.department_id || null : null);
  const effectiveBranchId =
    (hrEmp?.branch_id ? String(hrEmp.branch_id) : null) ||
    requesterUser?.branch_id ||
    (effectiveDeptId ? deptsMap.get(effectiveDeptId)?.branch_id || null : null) ||
    (effectiveTeamId ? teamsMap.get(effectiveTeamId)?.branch_id || null : null);
  const effectiveDirectMgrId =
    (hrEmp?.manager_user_id ? String(hrEmp.manager_user_id) : null) ||
    requesterUser?.reports_to_user_id ||
    null;

  // Build active delegation lookup (delegator -> delegate) at `now`
  const nowMs = now.getTime();
  const activeDelegationMap = new Map<string, string>();
  for (const del of delegationsRes.rows) {
    const fromMs = new Date(del.valid_from).getTime();
    const untilMs = new Date(del.valid_until).getTime();
    if (Number.isNaN(fromMs) || Number.isNaN(untilMs)) continue;
    if (nowMs < fromMs || nowMs > untilMs) continue;
    const cats = parseJsonSafe<string[]>(del.categories, []);
    if (Array.isArray(cats) && cats.length > 0 && !cats.includes(category) && !cats.includes('*')) {
      continue;
    }
    const delegatorId = String(del.delegator_user_id);
    const delegateId = String(del.delegate_user_id);
    if (delegatorId && delegateId && delegatorId !== delegateId && usersMap.get(delegateId)?.is_active) {
      activeDelegationMap.set(delegatorId, delegateId);
    }
  }

  const resolveDelegatedUser = (rawUserId: string): { finalUserId: string; delegatedFrom: string | null } => {
    let current = rawUserId;
    let firstDelegator: string | null = null;
    const visited = new Set<string>([current]);
    for (let hop = 0; hop < 4; hop++) {
      const next = activeDelegationMap.get(current);
      if (!next || visited.has(next)) break;
      if (!firstDelegator) firstDelegator = rawUserId;
      visited.add(next);
      current = next;
    }
    return { finalUserId: current, delegatedFrom: firstDelegator };
  };

  const resolveBranchDirector = (branchId: string | null): string | null => {
    if (!branchId) return null;
    const br = branchesMap.get(branchId);
    if (!br) return null;
    if (br.manager_user_id && usersMap.get(br.manager_user_id)?.is_active) {
      return br.manager_user_id;
    }
    const ws = parseJsonSafe<Record<string, unknown>>(br.work_schedule, {});
    const wsDirector = ws.director_user_id || ws.manager_user_id;
    if (typeof wsDirector === 'string' && usersMap.get(wsDirector)?.is_active) {
      return wsDirector;
    }
    return null;
  };

  const findTenantAdmins = (): string[] => {
    const owners: string[] = [];
    const admins: string[] = [];
    for (const u of usersMap.values()) {
      if (!u.is_active) continue;
      if (u.is_tenant_owner) owners.push(u.id);
      else if (['tenant_admin', 'owner', 'admin'].includes(u.role.toLowerCase())) admins.push(u.id);
    }
    if (owners.length > 0) return [owners[0]];
    if (admins.length > 0) return [admins[0]];
    const firstActive = Array.from(usersMap.values()).find((u) => u.is_active);
    return firstActive ? [firstActive.id] : [];
  };

  const walkAncestorDeptManager = (startDeptId: string | null, skipSelfDept: boolean): string | null => {
    if (!startDeptId) return null;
    const visited = new Set<string>();
    let curId: string | null = startDeptId;
    let isFirst = true;
    while (curId && !visited.has(curId)) {
      visited.add(curId);
      const dept = deptsMap.get(curId);
      if (!dept) break;
      if (!(skipSelfDept && isFirst)) {
        if (dept.manager_user_id && usersMap.get(dept.manager_user_id)?.is_active) {
          return dept.manager_user_id;
        }
      }
      isFirst = false;
      curId = dept.parent_department_id;
    }
    return null;
  };

  const resolveStepCandidateIds = (
    approverType: string,
    approverRoleId: string | null,
    approverUserId: string | null,
    fallbackStrategy: 'escalate_parent_dept' | 'tenant_admin'
  ): string[] => {
    const candidates: string[] = [];

    if (approverType === 'specific_user' && approverUserId) {
      if (usersMap.get(approverUserId)?.is_active) candidates.push(approverUserId);
    } else if (approverType === 'specific_role' && approverRoleId) {
      for (const u of usersMap.values()) {
        if (u.is_active && u.role_id === approverRoleId) {
          candidates.push(u.id);
        }
      }
    } else if (approverType === 'direct_manager') {
      if (effectiveDirectMgrId && usersMap.get(effectiveDirectMgrId)?.is_active) {
        candidates.push(effectiveDirectMgrId);
      } else {
        const deptMgr = walkAncestorDeptManager(effectiveDeptId, false);
        if (deptMgr) candidates.push(deptMgr);
      }
    } else if (approverType === 'team_leader') {
      const leaderId = effectiveTeamId ? teamsMap.get(effectiveTeamId)?.leader_user_id || null : null;
      if (leaderId && usersMap.get(leaderId)?.is_active) {
        candidates.push(leaderId);
      } else if (effectiveDirectMgrId && usersMap.get(effectiveDirectMgrId)?.is_active) {
        candidates.push(effectiveDirectMgrId);
      }
    } else if (approverType === 'department_head') {
      const deptMgr = walkAncestorDeptManager(effectiveDeptId, false);
      if (deptMgr) candidates.push(deptMgr);
    } else if (approverType === 'parent_department_head') {
      const parentMgr = walkAncestorDeptManager(effectiveDeptId, true);
      if (parentMgr) candidates.push(parentMgr);
    } else if (approverType === 'branch_director') {
      const brDir = resolveBranchDirector(effectiveBranchId);
      if (brDir) candidates.push(brDir);
    }

    if (candidates.length === 0) {
      if (fallbackStrategy === 'escalate_parent_dept') {
        const parentMgr = walkAncestorDeptManager(effectiveDeptId, true);
        if (parentMgr) {
          candidates.push(parentMgr);
        } else {
          const brDir = resolveBranchDirector(effectiveBranchId);
          if (brDir) candidates.push(brDir);
        }
      }
      if (candidates.length === 0) {
        candidates.push(...findTenantAdmins());
      }
    }

    return Array.from(new Set(candidates));
  };

  // Filter steps by dynamic amount thresholds
  const applicableSteps = stepsRes.rows.filter((st) => {
    const minAmt = toNum(st.min_amount_threshold, 0);
    const maxAmt = st.max_amount_threshold !== null && st.max_amount_threshold !== undefined
      ? toNum(st.max_amount_threshold, -1)
      : null;
    if (amountVnd < minAmt) return false;
    if (maxAmt !== null && maxAmt >= 0 && amountVnd > maxAmt) return false;
    return true;
  });

  // If all steps were filtered out by amount thresholds (or workflow had 0 steps), fallback to 1-step tenant_admin
  const effectiveRawSteps =
    applicableSteps.length > 0
      ? applicableSteps
      : [
          {
            id: null,
            step_order: 1,
            step_name: 'Quản trị viên phê duyệt',
            approver_type: 'direct_manager',
            approver_role_id: null,
            approver_user_id: null,
            approval_mode: 'any_one',
            fallback_strategy: 'tenant_admin',
            sla_hours: 24,
            require_signature: false,
          },
        ];

  const resolvedPlans: ResolvedApprovalStepPlan[] = [];
  let seqOrder = 1;

  for (const raw of effectiveRawSteps) {
    const approvalMode =
      raw.approval_mode === 'all_must_approve' ? 'all_must_approve' : 'any_one';
    const fallbackStrategy =
      raw.fallback_strategy === 'escalate_parent_dept' ? 'escalate_parent_dept' : 'tenant_admin';
    const rawCandidateIds = resolveStepCandidateIds(
      String(raw.approver_type || 'direct_manager'),
      raw.approver_role_id ? String(raw.approver_role_id) : null,
      raw.approver_user_id ? String(raw.approver_user_id) : null,
      fallbackStrategy
    );

    const assigneesMap = new Map<string, ResolvedStepAssignee>();
    for (const origUid of rawCandidateIds) {
      const { finalUserId, delegatedFrom } = resolveDelegatedUser(origUid);
      const finalUser = usersMap.get(finalUserId);
      if (!finalUser) continue;
      if (!assigneesMap.has(finalUserId)) {
        assigneesMap.set(finalUserId, {
          assigned_user_id: finalUserId,
          assigned_user_name: finalUser.full_name,
          original_approver_user_id: origUid,
          delegated_from_user_id: delegatedFrom,
        });
      }
    }

    if (assigneesMap.size === 0) continue;

    resolvedPlans.push({
      step_id: raw.id ? String(raw.id) : null,
      step_order: seqOrder++,
      original_step_order: Number(raw.step_order || 1),
      step_name: String(raw.step_name || `Bước duyệt ${seqOrder - 1}`),
      approver_type: String(raw.approver_type || 'direct_manager'),
      approval_mode: approvalMode,
      fallback_strategy: fallbackStrategy,
      sla_hours: Math.max(1, Number(raw.sla_hours || 24)),
      require_signature: toBool(raw.require_signature, false),
      assignees: Array.from(assigneesMap.values()),
    });
  }

  return resolvedPlans;
}

/**
 * Creates an approval request + all N-step log rows inside an active tenant transaction.
 */
export interface CreateApprovalRequestInput {
  tenantId: string;
  workflowId: string;
  requesterUserId: string;
  title: string;
  description?: string | null;
  amountVnd?: number;
  currency?: string;
  startDate?: string | null;
  endDate?: string | null;
  formData?: Record<string, unknown>;
  attachments?: unknown[];
  linkedEntityType?: string | null;
  linkedEntityId?: string | null;
}

export interface CreateApprovalRequestResult {
  id: string;
  request: Record<string, any>;
  step_logs: Array<Record<string, any>>;
  resolved_steps: ResolvedApprovalStepPlan[];
}

export async function createApprovalRequestInTx(
  client: DbClient,
  input: CreateApprovalRequestInput
): Promise<CreateApprovalRequestResult>;
export async function createApprovalRequestInTx(
  client: DbClient,
  tenantId: string,
  requesterUserId: string,
  payload: Record<string, unknown>
): Promise<CreateApprovalRequestResult>;
export async function createApprovalRequestInTx(
  client: DbClient,
  inputOrTenantId: CreateApprovalRequestInput | string,
  maybeRequesterUserId?: string,
  maybePayload?: Record<string, unknown>
): Promise<CreateApprovalRequestResult> {
  const input: CreateApprovalRequestInput =
    typeof inputOrTenantId === 'string'
      ? {
          tenantId: inputOrTenantId,
          requesterUserId: String(maybeRequesterUserId || ''),
          workflowId: String(maybePayload?.workflowId ?? maybePayload?.workflow_id ?? ''),
          title: String(maybePayload?.title ?? ''),
          description:
            maybePayload?.description !== undefined && maybePayload?.description !== null
              ? String(maybePayload.description)
              : null,
          amountVnd: toNum(maybePayload?.amountVnd ?? maybePayload?.amount_vnd, 0),
          currency: maybePayload?.currency ? String(maybePayload.currency) : 'VND',
          startDate: (maybePayload?.startDate ?? maybePayload?.start_date ?? null) as string | null,
          endDate: (maybePayload?.endDate ?? maybePayload?.end_date ?? null) as string | null,
          formData:
            ((maybePayload?.formData ?? maybePayload?.form_data) as Record<string, unknown>) || {},
          attachments: Array.isArray(maybePayload?.attachments) ? maybePayload.attachments : [],
          linkedEntityType: (maybePayload?.linkedEntityType ?? maybePayload?.linked_entity_type ?? null) as string | null,
          linkedEntityId: (maybePayload?.linkedEntityId ?? maybePayload?.linked_entity_id ?? null) as string | null,
        }
      : inputOrTenantId;
  const wfRes = await client.query(
    'SELECT * FROM tenant_approval_workflows WHERE tenant_id = $1 AND id = $2 LIMIT 1',
    [input.tenantId, input.workflowId]
  );
  const wf = wfRes.rows[0];
  if (!wf) {
    throw new Error('WORKFLOW_NOT_FOUND');
  }

  const amountVnd = Math.max(0, toNum(input.amountVnd, 0));
  const category = String(wf.category || 'custom_form');
  const resolvedSteps = await resolveDynamicApprovalStepsInTx(client, {
    tenantId: input.tenantId,
    workflowId: input.workflowId,
    requesterUserId: input.requesterUserId,
    amountVnd,
    category,
  });

  const requestId = crypto.randomUUID();
  const shortHex = requestId.replace(/-/g, '').slice(0, 6).toUpperCase();
  const requestCode = `APR-${new Date().toISOString().slice(2, 10).replace(/-/g, '')}-${shortHex}`;
  const totalSteps = Math.max(1, resolvedSteps.length);

  await client.query(
    `INSERT INTO tenant_approval_requests (
       id, tenant_id, request_code, workflow_id, category, title, description,
       requester_user_id, amount_vnd, currency, start_date, end_date,
       form_data, attachments, status, current_step_order, total_steps,
       resolved_steps_snapshot, linked_entity_type, linked_entity_id
     ) VALUES (
       $1, $2, $3, $4, $5, $6, $7,
       $8, $9, $10, $11, $12,
       $13::jsonb, $14::jsonb, 'pending', 1, $15,
       $16::jsonb, $17, $18
     )`,
    [
      requestId,
      input.tenantId,
      requestCode,
      input.workflowId,
      category,
      input.title.trim(),
      input.description ? String(input.description).trim() : null,
      input.requesterUserId,
      amountVnd,
      input.currency ? String(input.currency).trim().toUpperCase() : 'VND',
      input.startDate || null,
      input.endDate || null,
      JSON.stringify(input.formData || {}),
      JSON.stringify(Array.isArray(input.attachments) ? input.attachments : []),
      totalSteps,
      JSON.stringify(resolvedSteps),
      input.linkedEntityType || null,
      input.linkedEntityId || null,
    ]
  );

  const nowMs = Date.now();
  for (const step of resolvedSteps) {
    const initialStatus = step.step_order === 1 ? 'pending' : 'waiting';
    const dueIso = new Date(nowMs + step.sla_hours * 3600_000).toISOString();
    for (const assignee of step.assignees) {
      await client.query(
        `INSERT INTO tenant_approval_step_logs (
           id, tenant_id, request_id, step_id, step_order, step_name, approval_mode,
           assigned_user_id, original_approver_user_id, delegated_from_user_id,
           status, due_at
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
        [
          crypto.randomUUID(),
          input.tenantId,
          requestId,
          step.step_id,
          step.step_order,
          step.step_name,
          step.approval_mode,
          assignee.assigned_user_id,
          assignee.original_approver_user_id,
          assignee.delegated_from_user_id,
          initialStatus,
          dueIso,
        ]
      );
    }
  }

  const [reqCreated, logsCreated] = await Promise.all([
    client.query('SELECT * FROM tenant_approval_requests WHERE tenant_id = $1 AND id = $2', [
      input.tenantId,
      requestId,
    ]),
    client.query(
      `SELECT l.*, u.full_name AS assigned_user_name, u.email AS assigned_user_email,
              du.full_name AS delegated_from_user_name
       FROM tenant_approval_step_logs l
       LEFT JOIN users u ON u.tenant_id = l.tenant_id AND u.id = l.assigned_user_id
       LEFT JOIN users du ON du.tenant_id = l.tenant_id AND du.id = l.delegated_from_user_id
       WHERE l.tenant_id = $1 AND l.request_id = $2
       ORDER BY l.step_order ASC, l.created_at ASC`,
      [input.tenantId, requestId]
    ),
  ]);

  return {
    id: requestId,
    request: reqCreated.rows[0],
    step_logs: logsCreated.rows,
    resolved_steps: resolvedSteps,
  };
}
