import crypto from 'node:crypto';
import { Router } from 'express';
import { withTenantTransaction } from '../../core/database/transaction.ts';
import { getTenantContext } from '../../core/context/tenant-context.ts';
import {
  requireTenantAuth,
  resolveUserEffectivePermissions,
  sendApiError,
  type ResolvedUserRbacResult,
} from '../../core/security/rbac.ts';
import { resolveTenantEntitlementSnapshot } from '../../core/security/entitlements.ts';
import {
  ensureDomAgentSchema,
  parseJsonArray,
  parseJsonObject,
} from './schema.ts';
import {
  canCallerAccessKnowledgeDoc,
  searchKnowledgeRagInTx,
  syncPolicyDocumentsToKnowledgeInTx,
  upsertKnowledgeDocInTx,
} from './rag.service.ts';
import {
  executeDomAgentToolInTx,
  listDomAgentToolsForCaller,
} from './tools-registry.ts';
import {
  buildSpecialistsCatalog,
  generateMorningBriefingInTx,
  getOrSeedTenantAgentConfigInTx,
  runDomAgentChatTurnInTx,
  upsertTenantAgentConfigInTx,
} from './orchestrator.service.ts';

export const domAgentRouter = Router();

// 1. Self-initializing Multi-Tenant Schema Middleware (memoized per pool via WeakSet)
domAgentRouter.use(async (_req, res, next) => {
  try {
    await ensureDomAgentSchema();
    next();
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : 'Không thể khởi tạo cấu trúc bảng DOM Agent.';
    sendApiError(res, 500, 'DOM_AGENT_SCHEMA_INIT_FAILED', msg);
  }
});

// 2. Strict Tenant JWT + Subdomain Context Middleware
domAgentRouter.use(requireTenantAuth);

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isValidUuid(val: unknown): boolean {
  return typeof val === 'string' && UUID_PATTERN.test(val.trim());
}

function canCallerManageDomAgent(resolved: ResolvedUserRbacResult): boolean {
  if (resolved.userOrg?.is_tenant_owner) return true;
  if (resolved.effectivePermissions.settings?.actions.manage_config) return true;
  if (resolved.effectivePermissions.org_rbac?.actions.manage_config) return true;
  if (resolved.effectivePermissions.dom_agent?.actions.manage_config) return true;
  return false;
}

function canCallerUseDomAgentCopilot(resolved: ResolvedUserRbacResult): boolean {
  if (resolved.userOrg?.is_tenant_owner) return true;
  const candidateModules = [
    'dom_agent',
    'dom_sales_copilot',
    'dom_marketing_copilot',
    'leads',
    'audiences',
  ];
  return candidateModules.some((k) => {
    const perm = resolved.effectivePermissions[k];
    return Boolean(perm && perm.scope !== 'none' && perm.actions.view);
  });
}

domAgentRouter.use(async (req, res, next) => {
  try {
    const ctx = getTenantContext();
    const resolved = await withTenantTransaction(ctx.tenantId, (client) =>
      resolveUserEffectivePermissions(client, ctx.tenantId, ctx.userId)
    );
    if (!canCallerUseDomAgentCopilot(resolved)) {
      sendApiError(
        res,
        403,
        'FORBIDDEN_RBAC_PERMISSION',
        'Tài khoản của bạn không được cấp quyền truy cập trợ lý DOM Agent.'
      );
      return;
    }
    (req as unknown as Record<string, unknown>).rbacResolved = resolved;
    next();
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : 'Không thể xác thực phân quyền DOM Agent.';
    sendApiError(res, 500, 'DOM_AGENT_AUTH_CHECK_FAILED', msg);
  }
});

// ============================================================================
// 1. Unified Workspace Bootstrap (`GET /api/v1/dom-agent/bootstrap`)
// ============================================================================
domAgentRouter.get('/bootstrap', async (_req, res) => {
  try {
    const ctx = getTenantContext();
    const payload = await withTenantTransaction(ctx.tenantId, async (client) => {
      const [config, resolvedRbac, tenantRes, threadsRes, deptsRes, docsRes] = await Promise.all([
        getOrSeedTenantAgentConfigInTx(client, ctx.tenantId),
        resolveUserEffectivePermissions(client, ctx.tenantId, ctx.userId),
        client.query<{
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
          `SELECT package_code, plan_tier, subscription_plan_code, crm_erp_upgrade_status,
                  industry, industry_key, enabled_modules, entitlements, settings
           FROM tenants WHERE id = $1 LIMIT 1`,
          [ctx.tenantId]
        ),
        client.query(
          `SELECT * FROM tenant_ai_threads
           WHERE tenant_id = $1 AND user_id = $2
           ORDER BY is_pinned DESC, last_message_at DESC
           LIMIT 30`,
          [ctx.tenantId, ctx.userId]
        ),
        client.query(
          `SELECT id, code, name, parent_department_id
           FROM tenant_departments
           WHERE tenant_id = $1 AND is_active = true
           ORDER BY sort_order ASC, name ASC`,
          [ctx.tenantId]
        ),
        client.query(
          `SELECT id, title, category, source_type, source_policy_id, file_name,
                  content_text, allowed_department_ids, chunk_count, is_active, created_at, updated_at
           FROM tenant_ai_knowledge_docs
           WHERE tenant_id = $1
           ORDER BY updated_at DESC
           LIMIT 100`,
          [ctx.tenantId]
        ),
      ]);

      const tRow = tenantRes.rows[0] || {};
      const entSnap = resolveTenantEntitlementSnapshot(tRow);
      const specialists = buildSpecialistsCatalog(resolvedRbac.enabledModules, entSnap.terminology);
      const tools = listDomAgentToolsForCaller(resolvedRbac);

      const canManage = canCallerManageDomAgent(resolvedRbac);
      const visibleDocs = docsRes.rows
        .filter((d) => canManage || canCallerAccessKnowledgeDoc(d.allowed_department_ids, resolvedRbac.userOrg))
        .map((d) => ({
          ...d,
          allowed_department_ids: parseJsonArray<string>(d.allowed_department_ids),
        }));

      const canSeeAllAudits =
        Boolean(resolvedRbac.userOrg?.is_tenant_owner) ||
        Boolean(resolvedRbac.effectivePermissions.org_rbac?.actions.view) ||
        canManage;

      const auditRes = canSeeAllAudits
        ? await client.query(
            `SELECT a.*, u.full_name AS user_name, u.email AS user_email
             FROM tenant_ai_tool_audit_logs a
             LEFT JOIN users u ON u.tenant_id = a.tenant_id AND u.id = a.user_id
             WHERE a.tenant_id = $1
             ORDER BY a.created_at DESC
             LIMIT 40`,
            [ctx.tenantId]
          )
        : await client.query(
            `SELECT a.*, u.full_name AS user_name, u.email AS user_email
             FROM tenant_ai_tool_audit_logs a
             LEFT JOIN users u ON u.tenant_id = a.tenant_id AND u.id = a.user_id
             WHERE a.tenant_id = $1 AND a.user_id = $2
             ORDER BY a.created_at DESC
             LIMIT 40`,
            [ctx.tenantId, ctx.userId]
          );

      const entitledCount = tools.filter((t) => t.entitled).length;
      const allowedCount = tools.filter((t) => t.allowed).length;

      return {
        config,
        package_code: entSnap.package_code,
        package_info: entSnap.package_info,
        terminology: entSnap.terminology,
        can_manage_agent: canManage,
        caller_department_id: resolvedRbac.userOrg?.department_id || null,
        specialists,
        tools,
        tools_summary: {
          total_count: tools.length,
          entitled_count: entitledCount,
          allowed_count: allowedCount,
          locked_by_package_count: tools.filter((t) => t.locked_reason === 'MODULE_NOT_ENTITLED').length,
          locked_by_rbac_count: tools.filter((t) => t.locked_reason === 'FORBIDDEN_RBAC_PERMISSION').length,
        },
        threads: threadsRes.rows,
        departments: deptsRes.rows,
        knowledge_docs: visibleDocs,
        audit_logs: auditRes.rows.map((r) => ({
          ...r,
          allowed: Boolean(r.allowed),
          args_summary: parseJsonObject(r.args_summary),
        })),
      };
    });

    res.json({ success: true, data: payload });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : 'Không thể tải dữ liệu khởi tạo DOM Agent.';
    sendApiError(res, 500, 'DOM_AGENT_BOOTSTRAP_FAILED', msg);
  }
});

// ============================================================================
// 2. Agent Persona & White-Label Settings (`GET|PUT|PATCH /config`)
// ============================================================================
domAgentRouter.get('/config', async (_req, res) => {
  try {
    const ctx = getTenantContext();
    const config = await withTenantTransaction(ctx.tenantId, (client) =>
      getOrSeedTenantAgentConfigInTx(client, ctx.tenantId)
    );
    res.json({ success: true, data: config });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : 'Không thể tải cấu hình trợ lý.';
    sendApiError(res, 500, 'GET_AGENT_CONFIG_FAILED', msg);
  }
});

const saveAgentConfigHandler = async (req: any, res: any) => {
  try {
    const ctx = getTenantContext();
    const result = await withTenantTransaction(ctx.tenantId, async (client) => {
      const resolved = await resolveUserEffectivePermissions(client, ctx.tenantId, ctx.userId);
      if (!canCallerManageDomAgent(resolved)) {
        return { forbidden: true as const };
      }
      const updated = await upsertTenantAgentConfigInTx(
        client,
        ctx.tenantId,
        ctx.userId,
        req.body || {}
      );
      return { forbidden: false as const, config: updated };
    });

    if (result.forbidden) {
      sendApiError(
        res,
        403,
        'FORBIDDEN_RBAC_PERMISSION',
        'Bạn cần quyền Quản trị cấu hình để thay đổi nhân cách và khóa BYOK của DOM Agent.'
      );
      return;
    }

    res.json({ success: true, data: result.config });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : 'Không thể lưu cấu hình DOM Agent.';
    sendApiError(res, 500, 'SAVE_AGENT_CONFIG_FAILED', msg);
  }
};

domAgentRouter.put('/config', saveAgentConfigHandler);
domAgentRouter.patch('/config', saveAgentConfigHandler);

// ============================================================================
// 3. 72 Function Tools Catalog, Execution & Security Audit Logs
// ============================================================================
domAgentRouter.get('/tools', async (req, res) => {
  try {
    const ctx = getTenantContext();
    const groupFilter = req.query.group ? String(req.query.group).trim() : '';
    const searchKw = req.query.search ? String(req.query.search).trim().toLowerCase() : '';

    const data = await withTenantTransaction(ctx.tenantId, async (client) => {
      const resolved = await resolveUserEffectivePermissions(client, ctx.tenantId, ctx.userId);
      const allTools = listDomAgentToolsForCaller(resolved);
      const filtered = allTools.filter((t) => {
        if (groupFilter && groupFilter !== 'all' && t.group !== groupFilter) return false;
        if (searchKw) {
          const hay = `${t.name} ${t.title} ${t.description} ${t.module_key}`.toLowerCase();
          if (!hay.includes(searchKw)) return false;
        }
        return true;
      });

      return {
        total_registered: allTools.length,
        entitled_count: allTools.filter((t) => t.entitled).length,
        allowed_count: allTools.filter((t) => t.allowed).length,
        items: filtered,
      };
    });

    res.json({ success: true, data });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : 'Không thể tải danh mục 72 công cụ.';
    sendApiError(res, 500, 'LIST_TOOLS_FAILED', msg);
  }
});

const executeToolHandler = async (req: any, res: any) => {
  try {
    const ctx = getTenantContext();
    const body = req.body || {};
    const toolName = String(req.params.toolName || body.tool_name || body.name || '').trim();
    const toolArgs =
      body.args && typeof body.args === 'object'
        ? (body.args as Record<string, unknown>)
        : (body as Record<string, unknown>);

    if (!toolName) {
      sendApiError(res, 422, 'VALIDATION_ERROR', 'Vui lòng chỉ định tên công cụ (tool_name) cần thực thi.');
      return;
    }

    // Commit both ALLOWED and DENIED audit records inside `withTenantTransaction`
    const execResult = await withTenantTransaction(ctx.tenantId, (client) =>
      executeDomAgentToolInTx(client, ctx, toolName, toolArgs)
    );

    if (!execResult.allowed) {
      res.status(execResult.status_code).json({
        success: false,
        error: {
          code: execResult.error_code || 'FORBIDDEN_TOOL_EXECUTION',
          message: execResult.denial_reason || 'Công cụ bị từ chối thực thi.',
          upgrade_hint: execResult.upgrade_hint || null,
        },
        data: execResult,
      });
      return;
    }

    res.json({ success: true, data: execResult });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : 'Lỗi khi thực thi công cụ DOM Agent.';
    sendApiError(res, 500, 'EXECUTE_TOOL_FAILED', msg);
  }
};

domAgentRouter.post('/tools/execute', executeToolHandler);
domAgentRouter.post('/tools/:toolName/execute', executeToolHandler);

domAgentRouter.get('/audit-logs', async (req, res) => {
  try {
    const ctx = getTenantContext();
    const limit = Math.min(100, Math.max(1, Number(req.query.limit || 50)));

    const rows = await withTenantTransaction(ctx.tenantId, async (client) => {
      const resolved = await resolveUserEffectivePermissions(client, ctx.tenantId, ctx.userId);
      const canSeeAll =
        Boolean(resolved.userOrg?.is_tenant_owner) ||
        Boolean(resolved.effectivePermissions.org_rbac?.actions.view) ||
        canCallerManageDomAgent(resolved);

      const r = canSeeAll
        ? await client.query(
            `SELECT a.*, u.full_name AS user_name, u.email AS user_email
             FROM tenant_ai_tool_audit_logs a
             LEFT JOIN users u ON u.tenant_id = a.tenant_id AND u.id = a.user_id
             WHERE a.tenant_id = $1
             ORDER BY a.created_at DESC
             LIMIT $2`,
            [ctx.tenantId, limit]
          )
        : await client.query(
            `SELECT a.*, u.full_name AS user_name, u.email AS user_email
             FROM tenant_ai_tool_audit_logs a
             LEFT JOIN users u ON u.tenant_id = a.tenant_id AND u.id = a.user_id
             WHERE a.tenant_id = $1 AND a.user_id = $2
             ORDER BY a.created_at DESC
             LIMIT $3`,
            [ctx.tenantId, ctx.userId, limit]
          );

      return r.rows.map((item) => ({
        ...item,
        allowed: Boolean(item.allowed),
        args_summary: parseJsonObject(item.args_summary),
      }));
    });

    res.json({ success: true, data: rows });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : 'Không thể tải nhật ký kiểm toán công cụ AI.';
    sendApiError(res, 500, 'LIST_TOOL_AUDIT_FAILED', msg);
  }
});

// ============================================================================
// 4. Threads, Chat & Morning Executive Briefing
// ============================================================================
domAgentRouter.get('/threads', async (_req, res) => {
  try {
    const ctx = getTenantContext();
    const rows = await withTenantTransaction(ctx.tenantId, async (client) => {
      const r = await client.query(
        `SELECT * FROM tenant_ai_threads
         WHERE tenant_id = $1 AND user_id = $2
         ORDER BY is_pinned DESC, last_message_at DESC
         LIMIT 50`,
        [ctx.tenantId, ctx.userId]
      );
      return r.rows;
    });
    res.json({ success: true, data: rows });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : 'Không thể tải danh sách hội thoại.';
    sendApiError(res, 500, 'LIST_THREADS_FAILED', msg);
  }
});

domAgentRouter.post('/threads', async (req, res) => {
  try {
    const ctx = getTenantContext();
    const b = req.body || {};
    const id = crypto.randomUUID();
    const title = String(b.title || 'Cuộc hội thoại mới').trim().slice(0, 200) || 'Cuộc hội thoại mới';
    const specialistKey = String(b.specialist_key || 'orchestrator').trim() || 'orchestrator';

    const created = await withTenantTransaction(ctx.tenantId, async (client) => {
      await client.query(
        `INSERT INTO tenant_ai_threads (id, tenant_id, user_id, specialist_key, title, is_pinned, last_message_at)
         VALUES ($1, $2, $3, $4, $5, false, clock_timestamp())`,
        [id, ctx.tenantId, ctx.userId, specialistKey, title]
      );
      const r = await client.query(
        'SELECT * FROM tenant_ai_threads WHERE tenant_id = $1 AND id = $2 LIMIT 1',
        [ctx.tenantId, id]
      );
      return r.rows[0];
    });

    res.status(201).json({ success: true, data: created });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : 'Không thể tạo cuộc hội thoại mới.';
    sendApiError(res, 500, 'CREATE_THREAD_FAILED', msg);
  }
});

domAgentRouter.get('/threads/:id/messages', async (req, res) => {
  try {
    const ctx = getTenantContext();
    const threadId = req.params.id;
    if (!isValidUuid(threadId)) {
      sendApiError(res, 404, 'THREAD_NOT_FOUND', 'Không tìm thấy cuộc hội thoại.');
      return;
    }

    const result = await withTenantTransaction(ctx.tenantId, async (client) => {
      const tRes = await client.query(
        'SELECT * FROM tenant_ai_threads WHERE tenant_id = $1 AND id = $2 AND user_id = $3 LIMIT 1',
        [ctx.tenantId, threadId, ctx.userId]
      );
      if (!tRes.rows[0]) {
        return null;
      }
      const mRes = await client.query(
        `SELECT * FROM tenant_ai_messages
         WHERE tenant_id = $1 AND thread_id = $2
         ORDER BY created_at ASC`,
        [ctx.tenantId, threadId]
      );
      return {
        thread: tRes.rows[0],
        messages: mRes.rows.map((m) => ({
          ...m,
          tool_calls: parseJsonArray(m.tool_calls),
          citations: parseJsonArray(m.citations),
        })),
      };
    });

    if (!result) {
      sendApiError(res, 404, 'THREAD_NOT_FOUND', 'Không tìm thấy cuộc hội thoại.');
      return;
    }

    res.json({ success: true, data: result });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : 'Không thể tải lịch sử tin nhắn.';
    sendApiError(res, 500, 'GET_MESSAGES_FAILED', msg);
  }
});

domAgentRouter.patch('/threads/:id', async (req, res) => {
  try {
    if (!isValidUuid(req.params.id)) {
      sendApiError(res, 404, 'THREAD_NOT_FOUND', 'Không tìm thấy cuộc hội thoại.');
      return;
    }
    const ctx = getTenantContext();
    const b = req.body || {};
    const updated = await withTenantTransaction(ctx.tenantId, async (client) => {
      const r = await client.query(
        `UPDATE tenant_ai_threads
         SET title = COALESCE($4, title),
             is_pinned = COALESCE($5, is_pinned),
             updated_at = clock_timestamp()
         WHERE tenant_id = $1 AND id = $2 AND user_id = $3
         RETURNING *`,
        [
          ctx.tenantId,
          req.params.id,
          ctx.userId,
          typeof b.title === 'string' && b.title.trim() ? b.title.trim().slice(0, 200) : null,
          typeof b.is_pinned === 'boolean' ? b.is_pinned : null,
        ]
      );
      return r.rows[0] || null;
    });

    if (!updated) {
      sendApiError(res, 404, 'THREAD_NOT_FOUND', 'Không tìm thấy cuộc hội thoại.');
      return;
    }
    res.json({ success: true, data: updated });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : 'Không thể cập nhật hội thoại.';
    sendApiError(res, 500, 'UPDATE_THREAD_FAILED', msg);
  }
});

domAgentRouter.delete('/threads/:id', async (req, res) => {
  try {
    if (!isValidUuid(req.params.id)) {
      sendApiError(res, 404, 'THREAD_NOT_FOUND', 'Không tìm thấy cuộc hội thoại.');
      return;
    }
    const ctx = getTenantContext();
    const deletedCount = await withTenantTransaction(ctx.tenantId, async (client) => {
      const r = await client.query(
        'DELETE FROM tenant_ai_threads WHERE tenant_id = $1 AND id = $2 AND user_id = $3',
        [ctx.tenantId, req.params.id, ctx.userId]
      );
      return r.rowCount;
    });

    if (!deletedCount) {
      sendApiError(res, 404, 'THREAD_NOT_FOUND', 'Không tìm thấy cuộc hội thoại.');
      return;
    }
    res.json({ success: true, data: { deleted: true, id: req.params.id } });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : 'Không thể xóa cuộc hội thoại.';
    sendApiError(res, 500, 'DELETE_THREAD_FAILED', msg);
  }
});

domAgentRouter.post('/chat', async (req, res) => {
  try {
    const ctx = getTenantContext();
    const b = req.body || {};

    const turnOutcome = await withTenantTransaction(ctx.tenantId, (client) =>
      runDomAgentChatTurnInTx(client, ctx, {
        threadId: b.thread_id ? String(b.thread_id) : null,
        specialistKey: b.specialist_key ? String(b.specialist_key) : 'orchestrator',
        message: String(b.message || b.prompt || ''),
        explicitToolName: b.tool_name ? String(b.tool_name) : undefined,
        explicitToolArgs:
          b.tool_args && typeof b.tool_args === 'object'
            ? (b.tool_args as Record<string, unknown>)
            : undefined,
      })
    );

    if (!turnOutcome.ok) {
      sendApiError(res, turnOutcome.status, turnOutcome.code, turnOutcome.message);
      return;
    }

    res.json({ success: true, data: turnOutcome.data });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : 'Không thể xử lý yêu cầu hội thoại DOM Agent.';
    sendApiError(res, 500, 'DOM_AGENT_CHAT_FAILED', msg);
  }
});

const briefingHandler = async (_req: any, res: any) => {
  try {
    const ctx = getTenantContext();
    const briefing = await withTenantTransaction(ctx.tenantId, (client) =>
      generateMorningBriefingInTx(client, ctx)
    );
    res.json({ success: true, data: briefing });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : 'Không thể tổng hợp Bản tin Điều hành buổi sáng.';
    sendApiError(res, 500, 'MORNING_BRIEFING_FAILED', msg);
  }
};

domAgentRouter.get('/briefing', briefingHandler);
domAgentRouter.post('/briefing', briefingHandler);

// ============================================================================
// 5. Tenant-Isolated RAG Knowledge Studio (`/knowledge`, `/knowledge/sync-policies`, `/knowledge/query`)
// ============================================================================
domAgentRouter.get('/knowledge', async (_req, res) => {
  try {
    const ctx = getTenantContext();
    const docs = await withTenantTransaction(ctx.tenantId, async (client) => {
      const resolved = await resolveUserEffectivePermissions(client, ctx.tenantId, ctx.userId);
      const canManage = canCallerManageDomAgent(resolved);
      const r = await client.query(
        `SELECT * FROM tenant_ai_knowledge_docs
         WHERE tenant_id = $1
         ORDER BY updated_at DESC`,
        [ctx.tenantId]
      );
      return r.rows
        .filter((d) => canManage || canCallerAccessKnowledgeDoc(d.allowed_department_ids, resolved.userOrg))
        .map((d) => ({
          ...d,
          allowed_department_ids: parseJsonArray<string>(d.allowed_department_ids),
        }));
    });
    res.json({ success: true, data: docs });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : 'Không thể tải danh sách tài liệu RAG.';
    sendApiError(res, 500, 'LIST_KNOWLEDGE_FAILED', msg);
  }
});

domAgentRouter.post('/knowledge', async (req, res) => {
  try {
    const ctx = getTenantContext();
    const b = req.body || {};
    const title = String(b.title || '').trim();
    if (!title) {
      sendApiError(res, 422, 'VALIDATION_ERROR', 'Tiêu đề tài liệu tri thức không được để trống.');
      return;
    }

    const outcome = await withTenantTransaction(ctx.tenantId, async (client) => {
      const resolved = await resolveUserEffectivePermissions(client, ctx.tenantId, ctx.userId);
      const canCreate =
        canCallerManageDomAgent(resolved) ||
        Boolean(resolved.effectivePermissions.dom_agent?.actions.create);
      if (!canCreate) {
        return { forbidden: true as const };
      }
      const doc = await upsertKnowledgeDocInTx(client, ctx.tenantId, ctx.userId, {
        title,
        category: b.category ? String(b.category) : 'company_policy',
        source_type: b.source_type === 'file_upload' ? 'file_upload' : 'manual',
        file_name: b.file_name ? String(b.file_name) : null,
        content_text: String(b.content_text || b.content || ''),
        allowed_department_ids: Array.isArray(b.allowed_department_ids)
          ? b.allowed_department_ids.map(String)
          : [],
        is_active: b.is_active !== false,
      });
      return { forbidden: false as const, doc };
    });

    if (outcome.forbidden) {
      sendApiError(res, 403, 'FORBIDDEN_RBAC_PERMISSION', 'Tài khoản không có quyền nạp tài liệu vào Kho Tri thức RAG.');
      return;
    }

    res.status(201).json({ success: true, data: outcome.doc });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : 'Không thể lưu tài liệu tri thức RAG.';
    sendApiError(res, 500, 'CREATE_KNOWLEDGE_FAILED', msg);
  }
});

const updateKnowledgeHandler = async (req: any, res: any) => {
  try {
    if (!isValidUuid(req.params.id)) {
      sendApiError(res, 404, 'KNOWLEDGE_DOC_NOT_FOUND', 'Không tìm thấy tài liệu tri thức.');
      return;
    }
    const ctx = getTenantContext();
    const b = req.body || {};
    const outcome = await withTenantTransaction(ctx.tenantId, async (client) => {
      const resolved = await resolveUserEffectivePermissions(client, ctx.tenantId, ctx.userId);
      if (!canCallerManageDomAgent(resolved)) {
        return { status: 403 as const };
      }
      const existingRes = await client.query(
        'SELECT * FROM tenant_ai_knowledge_docs WHERE tenant_id = $1 AND id = $2 LIMIT 1',
        [ctx.tenantId, req.params.id]
      );
      const cur = existingRes.rows[0];
      if (!cur) {
        return { status: 404 as const };
      }
      const doc = await upsertKnowledgeDocInTx(client, ctx.tenantId, ctx.userId, {
        id: cur.id,
        title: b.title !== undefined ? String(b.title) : String(cur.title),
        category: b.category !== undefined ? String(b.category) : String(cur.category),
        source_type: cur.source_type,
        source_policy_id: cur.source_policy_id || null,
        file_name: b.file_name !== undefined ? String(b.file_name) : cur.file_name || null,
        content_text:
          b.content_text !== undefined
            ? String(b.content_text)
            : b.content !== undefined
              ? String(b.content)
              : String(cur.content_text || ''),
        allowed_department_ids: Array.isArray(b.allowed_department_ids)
          ? b.allowed_department_ids.map(String)
          : parseJsonArray<string>(cur.allowed_department_ids),
        is_active: typeof b.is_active === 'boolean' ? b.is_active : Boolean(cur.is_active),
      });
      return { status: 200 as const, doc };
    });

    if (outcome.status === 403) {
      sendApiError(res, 403, 'FORBIDDEN_RBAC_PERMISSION', 'Không có quyền chỉnh sửa tài liệu RAG.');
      return;
    }
    if (outcome.status === 404) {
      sendApiError(res, 404, 'KNOWLEDGE_DOC_NOT_FOUND', 'Không tìm thấy tài liệu tri thức.');
      return;
    }
    res.json({ success: true, data: outcome.doc });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : 'Không thể cập nhật tài liệu tri thức.';
    sendApiError(res, 500, 'UPDATE_KNOWLEDGE_FAILED', msg);
  }
};

domAgentRouter.put('/knowledge/:id', updateKnowledgeHandler);
domAgentRouter.patch('/knowledge/:id', updateKnowledgeHandler);

domAgentRouter.delete('/knowledge/:id', async (req, res) => {
  try {
    if (!isValidUuid(req.params.id)) {
      sendApiError(res, 404, 'KNOWLEDGE_DOC_NOT_FOUND', 'Không tìm thấy tài liệu tri thức.');
      return;
    }
    const ctx = getTenantContext();
    const outcome = await withTenantTransaction(ctx.tenantId, async (client) => {
      const resolved = await resolveUserEffectivePermissions(client, ctx.tenantId, ctx.userId);
      if (!canCallerManageDomAgent(resolved)) {
        return { status: 403 as const };
      }
      const del = await client.query(
        'DELETE FROM tenant_ai_knowledge_docs WHERE tenant_id = $1 AND id = $2',
        [ctx.tenantId, req.params.id]
      );
      if (!del.rowCount) {
        return { status: 404 as const };
      }
      return { status: 200 as const };
    });

    if (outcome.status === 403) {
      sendApiError(res, 403, 'FORBIDDEN_RBAC_PERMISSION', 'Không có quyền xóa tài liệu tri thức.');
      return;
    }
    if (outcome.status === 404) {
      sendApiError(res, 404, 'KNOWLEDGE_DOC_NOT_FOUND', 'Không tìm thấy tài liệu tri thức.');
      return;
    }
    res.json({ success: true, data: { deleted: true, id: req.params.id } });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : 'Không thể xóa tài liệu tri thức.';
    sendApiError(res, 500, 'DELETE_KNOWLEDGE_FAILED', msg);
  }
});

domAgentRouter.post('/knowledge/sync-policies', async (req, res) => {
  try {
    const ctx = getTenantContext();
    const policyIds = Array.isArray(req.body?.policy_ids)
      ? req.body.policy_ids.map(String)
      : undefined;

    const outcome = await withTenantTransaction(ctx.tenantId, async (client) => {
      const resolved = await resolveUserEffectivePermissions(client, ctx.tenantId, ctx.userId);
      if (!canCallerManageDomAgent(resolved)) {
        return { forbidden: true as const };
      }
      const synced = await syncPolicyDocumentsToKnowledgeInTx(client, ctx.tenantId, ctx.userId, {
        policyIds,
      });
      return { forbidden: false as const, synced };
    });

    if (outcome.forbidden) {
      sendApiError(
        res,
        403,
        'FORBIDDEN_RBAC_PERMISSION',
        'Bạn cần quyền Quản trị cấu hình để đồng bộ Văn bản Nội quy sang DOM Agent.'
      );
      return;
    }

    res.json({ success: true, data: outcome.synced });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : 'Không thể đồng bộ văn bản nội quy sang RAG.';
    sendApiError(res, 500, 'SYNC_POLICIES_TO_RAG_FAILED', msg);
  }
});

const queryKnowledgeRagHandler = async (req: any, res: any) => {
  try {
    const ctx = getTenantContext();
    const query = String(req.body?.query ?? req.query?.q ?? req.query?.query ?? '').trim();
    const category = req.body?.category ?? req.query?.category;
    const topK = Number(req.body?.top_k ?? req.query?.top_k ?? 5);

    const ragResult = await withTenantTransaction(ctx.tenantId, async (client) => {
      const resolved = await resolveUserEffectivePermissions(client, ctx.tenantId, ctx.userId);
      return searchKnowledgeRagInTx(client, ctx.tenantId, resolved.userOrg, query, {
        category: category ? String(category) : undefined,
        topK,
      });
    });

    res.json({ success: true, data: ragResult });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : 'Không thể truy vấn kho tri thức RAG.';
    sendApiError(res, 500, 'QUERY_RAG_FAILED', msg);
  }
};

domAgentRouter.post('/knowledge/query', queryKnowledgeRagHandler);
domAgentRouter.get('/knowledge/search', queryKnowledgeRagHandler);
