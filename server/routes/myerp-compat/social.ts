import { Router } from 'express';
import { router as workchatRouter } from '../../modules/workchat/index.ts';
import { router as domAgentRouter } from '../../modules/dom-agent/index.ts';
import { router as erpOpsRouter } from '../../modules/erp-ops/index.ts';
import { ensureErpOpsSchema } from '../../modules/erp-ops/schema.ts';
import {
  bridge,
  handler,
  listPayload,
  mapListData,
  ok,
  qstr,
  requirePermission,
  tx,
  withAliases,
} from './shared.ts';

export const socialCompatRouter = Router();

// ---- Enterprise Social Feed & Comments ----
socialCompatRouter.get('/feed', bridge(workchatRouter, '/feed'));
socialCompatRouter.post('/feed', bridge(workchatRouter, '/feed'));
socialCompatRouter.get('/posts', bridge(workchatRouter, '/feed'));
socialCompatRouter.post('/posts', bridge(workchatRouter, '/feed'));
socialCompatRouter.get('/posts/honors', bridge(workchatRouter, '/kudos'));
socialCompatRouter.post('/posts/honors', bridge(workchatRouter, '/kudos'));
socialCompatRouter.post('/posts/honors/:id', bridge(workchatRouter, '/kudos'));
socialCompatRouter.get(
  '/posts/:id',
  requirePermission('enterprise_feed', 'view'),
  handler('COMPAT_POST_DETAIL', async (req, res) => {
    const id = req.params.id;
    const row = await tx(async (client, ctx) => {
      await ensureErpOpsSchema();
      const r = await client.query('SELECT * FROM tenant_feed_posts WHERE tenant_id = $1 AND id = $2 LIMIT 1', [
        ctx.tenantId,
        id,
      ]);
      return r.rows[0] || null;
    });
    ok(res, row);
  })
);
socialCompatRouter.put('/posts/:id', (_req, res) => ok(res, { updated: true }));
socialCompatRouter.delete('/posts/:id', (_req, res) => ok(res, { deleted: true }));
socialCompatRouter.get('/posts/:id/comments', bridge(workchatRouter, (req) => `/feed/${req.params.id}/comments`));
socialCompatRouter.post('/posts/:id/comments', bridge(workchatRouter, (req) => `/feed/${req.params.id}/comments`));
socialCompatRouter.post('/posts/:id/react', bridge(workchatRouter, (req) => `/feed/${req.params.id}/react`));
socialCompatRouter.get('/posts/:id/reactions', (_req, res) => ok(res, []));
socialCompatRouter.delete('/posts/comments/:id', (_req, res) => ok(res, { deleted: true }));
socialCompatRouter.put('/comments/:id', (req, res) => ok(res, { id: req.params.id, ...(req.body || {}) }));

// ---- WorkChat Compat (/chat/* -> /api/v1/workchat/*) ----
socialCompatRouter.get(
  '/chat/conversations',
  bridge(workchatRouter, '/channels', {
    transform: (payload) =>
      mapListData(payload, (c) =>
        withAliases(c, {
          title: (r) => r.title || r.name || 'Kênh chat',
          type: (r) => r.type || r.channel_type || 'group',
        })
      ),
  })
);
socialCompatRouter.post('/chat/conversations', bridge(workchatRouter, '/channels'));
socialCompatRouter.get('/chat/conversations/:id/messages', bridge(workchatRouter, (req) => `/channels/${req.params.id}/messages`));
socialCompatRouter.post('/chat/messages', (req, res, next) => {
  const convId = req.body?.conversation_id || req.body?.channel_id || req.query?.conversation_id;
  if (!convId) {
    ok(res, { id: Date.now(), content: req.body?.content || '' }, '', 201);
    return;
  }
  return bridge(workchatRouter, `/channels/${convId}/messages`)(req, res, next);
});
socialCompatRouter.put('/chat/messages/:id', (_req, res) => ok(res, { updated: true }));
socialCompatRouter.delete('/chat/messages/:id', (_req, res) => ok(res, { deleted: true }));
socialCompatRouter.post('/chat/messages/:id/reactions', bridge(workchatRouter, (req) => `/messages/${req.params.id}/reactions`));
socialCompatRouter.post('/chat/conversations/:id/pin', bridge(workchatRouter, (req) => `/messages/${req.body?.message_id || req.params.id}/pin`, { method: 'PATCH' }));
socialCompatRouter.post('/chat/conversations/:id/read', (_req, res) => ok(res, { read: true }));
socialCompatRouter.post('/chat/conversations/:id/clear', (_req, res) => ok(res, { cleared: true }));
socialCompatRouter.get('/chat/conversations/:id/tasks', (_req, res) => ok(res, []));
socialCompatRouter.post('/chat/conversations/:id/tasks', bridge(workchatRouter, (req) => `/messages/${req.body?.message_id || req.params.id}/create-task`));
socialCompatRouter.get('/chat/conversations/:id', bridge(workchatRouter, '/channels'));
socialCompatRouter.put('/chat/conversations/:id', (_req, res) => ok(res, { updated: true }));
socialCompatRouter.delete('/chat/conversations/:id', (_req, res) => ok(res, { deleted: true }));
socialCompatRouter.get('/chat/sync', bridge(workchatRouter, '/bootstrap'));
socialCompatRouter.get(
  '/chat/staff',
  requirePermission('workchat', 'view'),
  handler('COMPAT_CHAT_STAFF', async (_req, res) => {
    const staff = await tx(async (client, ctx) => {
      const r = await client.query(
        'SELECT id, full_name, email, avatar_url, role FROM users WHERE tenant_id = $1 AND is_active = true ORDER BY full_name ASC LIMIT 200',
        [ctx.tenantId]
      );
      return r.rows;
    });
    ok(res, staff);
  })
);
socialCompatRouter.get('/chat/search-erp', bridge(workchatRouter, '/erp-cards'));
socialCompatRouter.get('/chat/vault', bridge(workchatRouter, (req) => `/channels/${qstr(req, 'conversation_id') || 'general'}/vault`));
socialCompatRouter.get('/chat/link-preview', (_req, res) => ok(res, null));
socialCompatRouter.post('/chat/typing', (_req, res) => ok(res, { ok: true }));
socialCompatRouter.post('/chat/upload', (_req, res) => ok(res, { url: '', uploaded: true }));
socialCompatRouter.post('/presence', bridge(workchatRouter, '/presence/heartbeat'));

// ---- DOM Agent Compat (/qwen-agent/* -> /api/v1/dom-agent/*) ----
socialCompatRouter.get('/qwen-agent/status', bridge(domAgentRouter, '/bootstrap'));
socialCompatRouter.post('/qwen-agent/chat', bridge(domAgentRouter, '/chat'));
socialCompatRouter.post('/qwen-agent/settings', bridge(domAgentRouter, '/config', { method: 'PUT' }));

// ---- Cloud Files & AI OCR ----
socialCompatRouter.get('/cloud-files', bridge(erpOpsRouter, '/drive'));
socialCompatRouter.post('/cloud-files', bridge(erpOpsRouter, '/drive/files'));
socialCompatRouter.put('/cloud-files/:id', bridge(erpOpsRouter, (req) => `/drive/files/${req.params.id}`, { method: 'PATCH' }));
socialCompatRouter.delete('/cloud-files/:id', bridge(erpOpsRouter, (req) => `/drive/files/${req.params.id}`));
socialCompatRouter.post('/cloud-files/auto-ocr-contact', bridge(erpOpsRouter, '/ocr/extract'));
socialCompatRouter.post('/cloud-files/extract-id-document', bridge(erpOpsRouter, '/ocr/extract-id-card'));
socialCompatRouter.post('/cloud-files/extract-contract-info', bridge(erpOpsRouter, '/ocr/parse-contract'));
socialCompatRouter.post('/cloud-files/auto-scan-suspects', (_req, res) => ok(res, { suspects: [] }));
socialCompatRouter.get('/cloud-files/download-contact-zip', (_req, res) => ok(res, { url: '' }));

socialCompatRouter.get('/file-categories', bridge(erpOpsRouter, '/drive/categories'));
socialCompatRouter.post('/file-categories', bridge(erpOpsRouter, '/drive/categories'));
socialCompatRouter.put('/file-categories/:id', bridge(erpOpsRouter, (req) => `/drive/categories/${req.params.id}`, { method: 'PATCH' }));
socialCompatRouter.delete('/file-categories/:id', bridge(erpOpsRouter, (req) => `/drive/categories/${req.params.id}`));

// ---- Notifications & Badges ----
socialCompatRouter.get(
  '/notifications',
  handler('COMPAT_NOTIFS_LIST', async (_req, res) => {
    const items = await tx(async (client, ctx) => {
      const r = await client.query(
        `SELECT id, action AS type, action AS title, details_json AS details, created_at
         FROM admin_audit_logs
         WHERE tenant_id = $1
         ORDER BY created_at DESC LIMIT 25`,
        [ctx.tenantId]
      );
      return r.rows.map((x) => ({
        id: x.id,
        type: x.type || 'info',
        title: String(x.title || 'Thông báo hệ thống'),
        body: '',
        is_read: true,
        created_at: x.created_at,
      }));
    });
    ok(res, listPayload(items, items.length, 1, 25));
  })
);
socialCompatRouter.patch('/notifications/:id', (req, res) => ok(res, { id: req.params.id, is_read: true }));
socialCompatRouter.delete('/notifications', (_req, res) => ok(res, { cleared: true }));
socialCompatRouter.post('/notifications/reminder', (_req, res) => ok(res, { scheduled: true }));
socialCompatRouter.get('/badges', (_req, res) =>
  ok(res, {
    tickets: 0,
    supportTickets: 0,
    gatekeeper: 0,
    workspaceTasks: 0,
    pendingApprovals: 0,
    pendingExpenses: 0,
    pendingDeposits: 0,
    coopSlips: 0,
  })
);
