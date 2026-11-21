import assert from 'node:assert/strict';
import { apiRequest, registerTenant } from './e2e-harness.ts';

export interface SeededUser {
  id: string;
  email: string;
  role: string;
  token: string;
}

export interface SeededTenantWorkspace {
  tenantId: string;
  tenantSlug: string;
  adminToken: string;
  adminUserId: string;
  users: SeededUser[];
  pipelineId: string;
  stages: Array<{ id: string; stage_key: string; stage_name: string; capi_event_mapping?: string; is_won_stage?: boolean }>;
  defaultRoundId: string;
}

export async function createTenantUserAndLogin(
  baseUrl: string,
  adminToken: string,
  tenantSlug: string,
  user: {
    full_name: string;
    email: string;
    phone?: string;
    password?: string;
    role?: 'sale' | 'manager' | 'tenant_admin';
  }
): Promise<SeededUser> {
  const password = user.password || 'StaffPass123!';
  const createRes = await apiRequest(baseUrl, '/api/v1/users', {
    method: 'POST',
    token: adminToken,
    tenantSlug,
    body: {
      full_name: user.full_name,
      email: user.email,
      phone: user.phone || '0909333444',
      password,
      role: user.role || 'sale',
    },
  });
  assert.equal(createRes.status, 201, `Failed creating user ${user.email}: ${createRes.rawText}`);

  const loginRes = await apiRequest(baseUrl, '/api/v1/auth/login', {
    method: 'POST',
    body: {
      tenant_slug: tenantSlug,
      email: user.email,
      password,
    },
  });
  assert.equal(loginRes.status, 200, `Failed logging in user ${user.email}: ${loginRes.rawText}`);

  return {
    id: createRes.json?.data?.id || loginRes.json?.data?.user?.id,
    email: user.email,
    role: user.role || 'sale',
    token: loginRes.json?.data?.access_token,
  };
}

export async function seedTenantWorkspace(
  baseUrl: string,
  options: {
    companyName: string;
    slug: string;
    salesCount?: number;
    managersCount?: number;
    industry?: string;
    packageCode?: string;
  }
): Promise<SeededTenantWorkspace> {
  const reg = await registerTenant(baseUrl, {
    company_name: options.companyName,
    tenant_slug: options.slug,
    industry: options.industry || 'general',
    package_code: options.packageCode,
    seed_demo_leads: false,
  });
  assert.equal(reg.status, 201, `Tenant register failed (${options.slug}): ${reg.rawText}`);

  const users: SeededUser[] = [];
  const salesCount = options.salesCount ?? 0;
  for (let i = 1; i <= salesCount; i++) {
    users.push(
      await createTenantUserAndLogin(baseUrl, reg.adminToken, reg.tenantSlug, {
        full_name: `Sale ${i} (${options.slug})`,
        email: `sale${i}@${options.slug}.vn`,
        phone: `0901000${String(i).padStart(3, '0')}`,
        role: 'sale',
      })
    );
  }
  const managersCount = options.managersCount ?? 0;
  for (let i = 1; i <= managersCount; i++) {
    users.push(
      await createTenantUserAndLogin(baseUrl, reg.adminToken, reg.tenantSlug, {
        full_name: `Manager ${i} (${options.slug})`,
        email: `manager${i}@${options.slug}.vn`,
        phone: `0902000${String(i).padStart(3, '0')}`,
        role: 'manager',
      })
    );
  }

  const pipeRes = await apiRequest(baseUrl, '/api/v1/pipelines', {
    token: reg.adminToken,
    tenantSlug: reg.tenantSlug,
  });
  assert.equal(pipeRes.status, 200);
  const pipelines = pipeRes.json?.data?.pipelines || pipeRes.json?.data || [];
  const defaultPipe = pipelines[0] || {};
  const stages = (pipeRes.json?.data?.stages || defaultPipe.stages || []) as any[];

  const roundsRes = await apiRequest(baseUrl, '/api/v1/pipelines/rounds/list', {
    token: reg.adminToken,
    tenantSlug: reg.tenantSlug,
  });
  assert.equal(roundsRes.status, 200);
  const rounds = roundsRes.json?.data?.rounds || [];
  const defaultRoundId = rounds[0]?.id || '';

  return {
    tenantId: reg.tenantId,
    tenantSlug: reg.tenantSlug,
    adminToken: reg.adminToken,
    adminUserId: reg.adminUserId,
    users,
    pipelineId: defaultPipe.id || '',
    stages,
    defaultRoundId,
  };
}

export async function configureRoundConsultants(
  baseUrl: string,
  adminToken: string,
  tenantSlug: string,
  roundId: string,
  consultants: Array<{ user_id: string; receive_ratio?: number; data_per_turn?: number; is_active?: boolean }>
): Promise<void> {
  const res = await apiRequest(baseUrl, `/api/v1/pipelines/rounds/${roundId}/consultants`, {
    method: 'PUT',
    token: adminToken,
    tenantSlug,
    body: {
      replace_all: true,
      consultants,
    },
  });
  assert.equal(res.status, 200, `Failed updating round consultants: ${res.rawText}`);
}

export async function createInboundWebhook(
  baseUrl: string,
  adminToken: string,
  tenantSlug: string,
  opts?: {
    name?: string;
    field_mappings?: Record<string, unknown>;
  }
): Promise<{ id: string; token: string; signing_secret: string; urlPath: string }> {
  const res = await apiRequest(baseUrl, '/api/v1/integrations/webhooks', {
    method: 'POST',
    token: adminToken,
    tenantSlug,
    body: {
      name: opts?.name || 'E2E Inbound Meta Webhook',
      webhook_type: 'inbound',
      field_mappings: opts?.field_mappings || {},
      is_active: true,
    },
  });
  assert.equal(res.status, 201, `Failed creating inbound webhook: ${res.rawText}`);
  const row = res.json.data;
  return {
    id: row.id,
    token: row.token,
    signing_secret: row.signing_secret,
    urlPath: `/api/v1/webhooks/${tenantSlug}/${row.token}`,
  };
}

export async function createOutboundWebhook(
  baseUrl: string,
  adminToken: string,
  tenantSlug: string,
  opts: {
    name?: string;
    url: string;
    subscribed_events?: string[];
    max_retries?: number;
  }
): Promise<{ id: string; signing_secret: string }> {
  const res = await apiRequest(baseUrl, '/api/v1/integrations/webhooks', {
    method: 'POST',
    token: adminToken,
    tenantSlug,
    body: {
      name: opts.name || 'E2E Outbound Webhook',
      webhook_type: 'outbound',
      url: opts.url,
      subscribed_events: opts.subscribed_events || ['lead.created', 'lead.stage_changed'],
      field_mappings: opts.max_retries ? { _max_retries: opts.max_retries } : {},
      is_active: true,
    },
  });
  assert.equal(res.status, 201, `Failed creating outbound webhook: ${res.rawText}`);
  return {
    id: res.json.data.id,
    signing_secret: res.json.data.signing_secret,
  };
}

export async function saveVaultIntegration(
  baseUrl: string,
  adminToken: string,
  tenantSlug: string,
  type: string,
  config: Record<string, unknown>
): Promise<void> {
  const res = await apiRequest(baseUrl, `/api/v1/integrations/vault/${encodeURIComponent(type)}`, {
    method: 'PUT',
    token: adminToken,
    tenantSlug,
    body: config,
  });
  assert.equal(res.status, 200, `Failed saving vault integration ${type}: ${res.rawText}`);
}
