-- ============================================================================
-- AUTO DATA MULTI-TENANT (SAAS) PLATFORM - PRODUCTION DATABASE DDL
-- Database Engine: PostgreSQL 15+ (with native Row-Level Security)
-- Security Standard: Multi-Tenant Pool Model with FORCE ROW LEVEL SECURITY
-- Document ID: SPEC-DB-004
-- ============================================================================

-- 1. EXTENSIONS & PREREQUISITES
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS "pgcrypto";
CREATE EXTENSION IF NOT EXISTS "btree_gin";

-- ============================================================================
-- 2. PLATFORM GOVERNANCE & SUPER ADMIN SCHEMA (SEGREGATED)
-- ============================================================================

-- Table: platform_superadmins (Global Platform Operators - completely segregated from tenant space)
CREATE TABLE IF NOT EXISTS platform_superadmins (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    email VARCHAR(255) NOT NULL UNIQUE,
    password_hash VARCHAR(255) NOT NULL,
    full_name VARCHAR(255) NOT NULL,
    role VARCHAR(31) NOT NULL DEFAULT 'super_admin',
    is_active BOOLEAN NOT NULL DEFAULT true,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    last_login_at TIMESTAMPTZ
);

CREATE INDEX idx_platform_superadmins_email ON platform_superadmins(email);

-- Table: platform_settings (Segregated Platform-Wide Default Configurations & Presets)
CREATE TABLE IF NOT EXISTS platform_settings (
    setting_key VARCHAR(100) PRIMARY KEY,
    setting_value JSONB NOT NULL DEFAULT '{}'::jsonb,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);

-- ============================================================================
-- 3. CORE TENANCY REGISTRY SCHEMA
-- ============================================================================

-- Table: global_accounts (Unified Multi-Tenant Identity Registry)
CREATE TABLE IF NOT EXISTS global_accounts (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    email VARCHAR(255) NOT NULL UNIQUE,
    password_hash VARCHAR(255) NOT NULL,
    full_name VARCHAR(150) NOT NULL,
    phone VARCHAR(30),
    is_active BOOLEAN NOT NULL DEFAULT true,
    last_login_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);

CREATE INDEX IF NOT EXISTS idx_global_accounts_email_lower ON global_accounts(LOWER(email));
CREATE INDEX IF NOT EXISTS idx_global_accounts_phone ON global_accounts(phone) WHERE phone IS NOT NULL;

-- Table: tenants (Platform master organization registry)
CREATE TABLE IF NOT EXISTS tenants (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    slug VARCHAR(63) NOT NULL UNIQUE,
    obfuscated_slug VARCHAR(64) UNIQUE,
    name VARCHAR(255) NOT NULL,
    domain VARCHAR(255) UNIQUE,
    industry VARCHAR(100) NOT NULL DEFAULT 'general',
    industry_key VARCHAR(64) NOT NULL DEFAULT 'general',
    package_code VARCHAR(50) NOT NULL DEFAULT 'autodata_crm',
    plan_tier VARCHAR(50) NOT NULL DEFAULT 'starter' CHECK (plan_tier IN ('starter', 'growth', 'enterprise', 'autodata_crm', 'marketing_standalone', 'growth_combo', 'domation_promax')),
    enabled_modules JSONB NOT NULL DEFAULT '["leads","org_rbac","settings","billing","dashboard_crm","crm_dashboard","pipelines","rounds","fair_share","consultants","routing_rules","gatekeeper","tickets_data","ads_capi","sale_portal","appointments","integrations_crm","integrations_autodata","dom_sales_copilot"]'::jsonb,
    entitlements JSONB NOT NULL DEFAULT '{"package_code":"autodata_crm","education_addon":false,"enable_ideas_mascot":false}'::jsonb,
    status VARCHAR(50) NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'suspended', 'trial', 'cancelled')),
    trial_ends_at TIMESTAMPTZ DEFAULT (clock_timestamp() + INTERVAL '30 days'),
    subscription_expires_at TIMESTAMPTZ,
    subscription_plan_code VARCHAR(80) NOT NULL DEFAULT 'trial_1m',
    billing_cycle VARCHAR(30) NOT NULL DEFAULT 'trial',
    wallet_balance_vnd BIGINT NOT NULL DEFAULT 0,
    crm_erp_upgrade_status VARCHAR(50) NOT NULL DEFAULT 'none',
    settings JSONB NOT NULL DEFAULT '{
        "duplicate_threshold_days": 90,
        "default_sla_minutes": 15,
        "pii_masking_enabled": true,
        "dual_capi_enabled": false,
        "enable_ideas_mascot": false,
        "education_addon": false,
        "revenue_source": "deals_won"
    }'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);

CREATE INDEX idx_tenants_slug ON tenants(slug);
CREATE INDEX idx_tenants_obfuscated_slug ON tenants(obfuscated_slug);
CREATE INDEX idx_tenants_domain ON tenants(domain) WHERE domain IS NOT NULL;
CREATE INDEX idx_tenants_status ON tenants(status);
CREATE INDEX idx_tenants_subscription_expiry ON tenants(status, subscription_expires_at, trial_ends_at) WHERE status IN ('active', 'trial');

-- Table: tenant_onboarding_progress (Onboarding Tour & Step Tracking)
CREATE TABLE IF NOT EXISTS tenant_onboarding_progress (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    current_step INTEGER NOT NULL DEFAULT 1,
    completed_steps JSONB NOT NULL DEFAULT '[]'::jsonb,
    screen_tours JSONB NOT NULL DEFAULT '{}'::jsonb,
    is_completed BOOLEAN NOT NULL DEFAULT false,
    dismissed_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    CONSTRAINT uk_tenant_onboarding UNIQUE (tenant_id)
);

-- ============================================================================
-- 4. IDENTITY, USERS & PERSONNEL SCHEMA
-- ============================================================================

-- Table: users (Staff, Tenant Admins, Managers, Sales, Agency Brokers & Custom Roles)
CREATE TABLE IF NOT EXISTS users (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    account_id UUID REFERENCES global_accounts(id) ON DELETE CASCADE,
    tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    email VARCHAR(255) NOT NULL,
    password_hash VARCHAR(255) NOT NULL,
    full_name VARCHAR(150) NOT NULL,
    phone VARCHAR(30),
    role VARCHAR(50) NOT NULL CHECK (char_length(trim(role)) >= 1),
    role_id UUID,
    branch_id UUID,
    department_id UUID,
    team_id UUID,
    position_id UUID,
    reports_to_user_id UUID,
    is_tenant_owner BOOLEAN NOT NULL DEFAULT false,
    is_system_bot BOOLEAN NOT NULL DEFAULT false,
    is_external_agency BOOLEAN NOT NULL DEFAULT false,
    avatar_url TEXT,
    last_login_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    CONSTRAINT uk_users_tenant_email UNIQUE (tenant_id, email),
    CONSTRAINT uk_users_tenant_id UNIQUE (tenant_id, id)
);

CREATE INDEX idx_users_account_id ON users(account_id);
CREATE INDEX idx_users_tenant_role ON users(tenant_id, role);
CREATE INDEX idx_users_tenant_email_lower ON users(tenant_id, LOWER(email));
CREATE INDEX idx_users_email_lower ON users(LOWER(email));

-- Table: tenant_user_profiles (Sale & Consultant Operational Profiles & Toggles)
CREATE TABLE IF NOT EXISTS tenant_user_profiles (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    user_id UUID NOT NULL,
    status VARCHAR(30) NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'inactive', 'suspended', 'terminated')),
    is_available BOOLEAN NOT NULL DEFAULT true,
    vacation_mode BOOLEAN NOT NULL DEFAULT false,
    skipped_credit INTEGER NOT NULL DEFAULT 0,
    work_schedule JSONB NOT NULL DEFAULT '{
        "monday":    {"active": true, "start": "08:30", "end": "18:00"},
        "tuesday":   {"active": true, "start": "08:30", "end": "18:00"},
        "wednesday": {"active": true, "start": "08:30", "end": "18:00"},
        "thursday":  {"active": true, "start": "08:30", "end": "18:00"},
        "friday":    {"active": true, "start": "08:30", "end": "18:00"},
        "saturday":  {"active": true, "start": "08:30", "end": "12:00"},
        "sunday":    {"active": false, "start": "08:30", "end": "12:00"}
    }'::jsonb,
    zalo_chat_id VARCHAR(100),
    zalo_user_id VARCHAR(100),
    is_silent BOOLEAN NOT NULL DEFAULT false,
    invite_status VARCHAR(30) NOT NULL DEFAULT 'joined',
    sheet_sync_url TEXT,
    sheet_tab_name VARCHAR(150),
    skip_count INTEGER NOT NULL DEFAULT 0,
    current_turn_remaining INTEGER NOT NULL DEFAULT 0,
    hourly_leads_count INTEGER NOT NULL DEFAULT 0,
    hourly_window_start TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    CONSTRAINT uk_user_profile UNIQUE (tenant_id, user_id),
    CONSTRAINT fk_user_profile_tenant_user FOREIGN KEY (tenant_id, user_id) REFERENCES users(tenant_id, id) ON DELETE CASCADE
);

CREATE INDEX idx_user_profiles_dispatch ON tenant_user_profiles(tenant_id, status, is_available, vacation_mode);
CREATE INDEX idx_user_profiles_tenant_zalo_uid ON tenant_user_profiles(tenant_id, zalo_user_id) WHERE zalo_user_id IS NOT NULL;

-- ============================================================================
-- 4. DYNAMIC PIPELINE ENGINE SCHEMA
-- ============================================================================

-- Table: tenant_pipelines (Sales Funnels)
CREATE TABLE IF NOT EXISTS tenant_pipelines (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    name VARCHAR(150) NOT NULL,
    description TEXT,
    is_default BOOLEAN NOT NULL DEFAULT false,
    created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    CONSTRAINT uk_pipelines_tenant_id UNIQUE (tenant_id, id)
);

CREATE INDEX idx_pipelines_tenant ON tenant_pipelines(tenant_id, is_default);

-- Table: tenant_pipeline_stages (Configurable Stages within Pipeline)
CREATE TABLE IF NOT EXISTS tenant_pipeline_stages (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    pipeline_id UUID NOT NULL,
    stage_key VARCHAR(63) NOT NULL,
    stage_name VARCHAR(150) NOT NULL,
    stage_order INTEGER NOT NULL DEFAULT 0,
    color_hex VARCHAR(20) NOT NULL DEFAULT '#1E40FF',
    badge_style JSONB NOT NULL DEFAULT '{"bg": "bg-blue-50", "border": "border-blue-200", "text": "text-blue-700"}'::jsonb,
    is_won_stage BOOLEAN NOT NULL DEFAULT false,
    is_lost_stage BOOLEAN NOT NULL DEFAULT false,
    sla_timeout_minutes INTEGER NOT NULL DEFAULT 0,
    sla_escalation_role VARCHAR(50) NOT NULL DEFAULT 'manager',
    funnel_category VARCHAR(40) NOT NULL DEFAULT 'engaged_qualified',
    score_delta INTEGER NOT NULL DEFAULT 0,
    required_fields JSONB NOT NULL DEFAULT '[]'::jsonb,
    capi_event_mapping VARCHAR(100) NOT NULL DEFAULT 'Skip' CHECK (char_length(trim(capi_event_mapping)) >= 1),
    zalo_notify_template_id UUID,
    created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    CONSTRAINT uk_pipeline_stage_key UNIQUE (tenant_id, pipeline_id, stage_key),
    CONSTRAINT uk_pipeline_stages_tenant_id UNIQUE (tenant_id, id),
    CONSTRAINT fk_pipeline_stages_pipeline FOREIGN KEY (tenant_id, pipeline_id) REFERENCES tenant_pipelines(tenant_id, id) ON DELETE CASCADE
);

CREATE INDEX idx_pipeline_stages_order ON tenant_pipeline_stages(tenant_id, pipeline_id, stage_order ASC);

-- Table: tenant_pipeline_custom_fields (Metadata-driven Custom Attributes)
CREATE TABLE IF NOT EXISTS tenant_pipeline_custom_fields (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    pipeline_id UUID NOT NULL,
    field_key VARCHAR(63) NOT NULL,
    field_label VARCHAR(150) NOT NULL,
    field_type VARCHAR(30) NOT NULL CHECK (field_type IN ('text', 'textarea', 'number', 'currency', 'select', 'multiselect', 'date', 'boolean', 'phone', 'email', 'url')),
    is_required BOOLEAN NOT NULL DEFAULT false,
    options_json JSONB NOT NULL DEFAULT '[]'::jsonb,
    stage_visibility JSONB NOT NULL DEFAULT '[]'::jsonb,
    config_json JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    CONSTRAINT uk_pipeline_field_key UNIQUE (tenant_id, pipeline_id, field_key),
    CONSTRAINT fk_pipeline_custom_fields_pipeline FOREIGN KEY (tenant_id, pipeline_id) REFERENCES tenant_pipelines(tenant_id, id) ON DELETE CASCADE
);

-- ============================================================================
-- 5. FAIR-SHARE LEAD DISTRIBUTION ENGINE SCHEMA
-- ============================================================================

-- Table: distribution_rounds (Distribution Rounds / Shifts / Campaigns)
CREATE TABLE IF NOT EXISTS distribution_rounds (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    pipeline_id UUID NOT NULL,
    name VARCHAR(150) NOT NULL,
    description TEXT,
    cc_emails TEXT,
    last_assigned_consultant_id UUID,
    priority INTEGER NOT NULL DEFAULT 1,
    is_active BOOLEAN NOT NULL DEFAULT true,
    created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    CONSTRAINT uk_rounds_tenant_id UNIQUE (tenant_id, id),
    CONSTRAINT fk_rounds_pipeline FOREIGN KEY (tenant_id, pipeline_id) REFERENCES tenant_pipelines(tenant_id, id) ON DELETE CASCADE
);

CREATE INDEX idx_dist_rounds_tenant ON distribution_rounds(tenant_id, is_active, priority ASC);

-- Table: round_consultants (Agent Weights & Quotas in Round)
CREATE TABLE IF NOT EXISTS round_consultants (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    round_id UUID NOT NULL,
    user_id UUID NOT NULL,
    is_active BOOLEAN NOT NULL DEFAULT true,
    receive_ratio INTEGER NOT NULL DEFAULT 1 CHECK (receive_ratio >= 1),
    data_per_turn INTEGER NOT NULL DEFAULT 1 CHECK (data_per_turn >= 1),
    current_turn_remaining INTEGER NOT NULL DEFAULT 0,
    leads_received_in_round INTEGER NOT NULL DEFAULT 0,
    compensation_count INTEGER NOT NULL DEFAULT 0,
    skip_count INTEGER NOT NULL DEFAULT 0,
    skipped_credit INTEGER NOT NULL DEFAULT 0,
    created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    CONSTRAINT uk_round_user UNIQUE (tenant_id, round_id, user_id),
    CONSTRAINT fk_round_consultants_round FOREIGN KEY (tenant_id, round_id) REFERENCES distribution_rounds(tenant_id, id) ON DELETE CASCADE,
    CONSTRAINT fk_round_consultants_user FOREIGN KEY (tenant_id, user_id) REFERENCES users(tenant_id, id) ON DELETE CASCADE
);

CREATE INDEX idx_round_consultants_weights ON round_consultants(tenant_id, round_id, compensation_count DESC, leads_received_in_round ASC);

-- Table: routing_rules (Conditional Lead Intake Routing Rules)
CREATE TABLE IF NOT EXISTS routing_rules (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    round_id UUID NOT NULL,
    rule_name VARCHAR(150) NOT NULL,
    priority INTEGER NOT NULL DEFAULT 1,
    conditions_json JSONB NOT NULL DEFAULT '[]'::jsonb, -- e.g. [{"field": "source", "op": "equals", "val": "Facebook Ads"}]
    condition_branches JSONB NOT NULL DEFAULT '[]'::jsonb, -- OR-of-AND branches
    connection_scopes JSONB NOT NULL DEFAULT '["all"]'::jsonb, -- ["all"] | [-1] | [-2] | [-3] | [id...]
    inject_fields JSONB NOT NULL DEFAULT '{}'::jsonb,
    is_active BOOLEAN NOT NULL DEFAULT true,
    created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    CONSTRAINT fk_routing_rules_round FOREIGN KEY (tenant_id, round_id) REFERENCES distribution_rounds(tenant_id, id) ON DELETE CASCADE
);

CREATE INDEX idx_routing_rules_priority ON routing_rules(tenant_id, is_active, priority ASC);

-- ============================================================================
-- 6. CORE CRM LEADS & INTERACTION TIMELINE SCHEMA
-- ============================================================================

-- Table: leads (Master Contact 360° — Shared Customer & Marketing Profile)
CREATE TABLE IF NOT EXISTS leads (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    pipeline_id UUID,
    stage_id UUID,
    assigned_to UUID,
    round_id UUID,
    connection_id UUID,
    status VARCHAR(50) NOT NULL DEFAULT 'unassigned_pending' CHECK (status IN ('marketing_nurture', 'unassigned_pending', 'assigned', 'recalled', 'archived', 'pending_approval', 'rejected', 'blacklisted')),
    lifecycle_stage VARCHAR(40) NOT NULL DEFAULT 'lead' CHECK (lifecycle_stage IN ('subscriber', 'lead', 'mql', 'sql', 'opportunity', 'customer', 'evangelist', 'disqualified')),
    name VARCHAR(150) NOT NULL,
    phone VARCHAR(30),
    email VARCHAR(255),
    lead_score INTEGER NOT NULL DEFAULT 0,
    email_consent VARCHAR(30) NOT NULL DEFAULT 'subscribed' CHECK (email_consent IN ('subscribed', 'unsubscribed', 'bounced', 'complained')),
    zns_consent VARCHAR(30) NOT NULL DEFAULT 'opted_in' CHECK (zns_consent IN ('opted_in', 'opted_out')),
    total_revenue_vnd BIGINT NOT NULL DEFAULT 0,
    last_engaged_at TIMESTAMPTZ,
    source VARCHAR(100) NOT NULL DEFAULT 'Webhook',
    campaign VARCHAR(150),
    product_interest VARCHAR(255),
    budget_range VARCHAR(120),
    utm_source VARCHAR(100),
    utm_medium VARCHAR(100),
    utm_content VARCHAR(150),
    ad_id VARCHAR(100),
    adset_id VARCHAR(100),
    campaign_id VARCHAR(100),
    form_id VARCHAR(100),
    meta_lead_id VARCHAR(100),
    fbclid VARCHAR(255),
    fbc VARCHAR(255),
    fbp VARCHAR(255),
    custom_fields JSONB NOT NULL DEFAULT '{}'::jsonb,
    is_accepted BOOLEAN NOT NULL DEFAULT false,
    accepted_at TIMESTAMPTZ,
    sla_breached BOOLEAN NOT NULL DEFAULT false,
    is_duplicate_reminder BOOLEAN NOT NULL DEFAULT false,
    is_duplicated BOOLEAN NOT NULL DEFAULT false,
    duplicate_of_lead_id UUID,
    batch_id UUID,
    is_deleted BOOLEAN NOT NULL DEFAULT false,
    ai_screener_status VARCHAR(40) NOT NULL DEFAULT 'not_screened',
    ai_evaluation TEXT,
    ai_prompt_tokens INTEGER NOT NULL DEFAULT 0,
    ai_completion_tokens INTEGER NOT NULL DEFAULT 0,
    zalo_notify_status VARCHAR(40) NOT NULL DEFAULT 'none',
    email_notify_status VARCHAR(40) NOT NULL DEFAULT 'none',
    quality_status VARCHAR(50) NOT NULL DEFAULT 'Pending',
    quality_note TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    CONSTRAINT uk_leads_tenant_id UNIQUE (tenant_id, id),
    CONSTRAINT chk_leads_phone_or_email CHECK ((phone IS NOT NULL AND char_length(trim(phone)) > 0) OR (email IS NOT NULL AND char_length(trim(email)) > 0)),
    CONSTRAINT fk_leads_pipeline FOREIGN KEY (tenant_id, pipeline_id) REFERENCES tenant_pipelines(tenant_id, id) ON DELETE RESTRICT,
    CONSTRAINT fk_leads_stage FOREIGN KEY (tenant_id, stage_id) REFERENCES tenant_pipeline_stages(tenant_id, id) ON DELETE RESTRICT,
    CONSTRAINT fk_leads_assigned_user FOREIGN KEY (tenant_id, assigned_to) REFERENCES users(tenant_id, id) ON DELETE SET NULL
);

-- Compound unique constraint: Duplicate phone check is strictly scoped per tenant
CREATE INDEX idx_leads_tenant_phone_created ON leads(tenant_id, phone, created_at DESC);
CREATE INDEX idx_leads_sla_sweep ON leads(tenant_id, is_accepted, sla_breached, stage_id);
CREATE INDEX idx_leads_tenant_phone ON leads(tenant_id, phone);
CREATE INDEX idx_leads_tenant_stage ON leads(tenant_id, stage_id);
CREATE INDEX idx_leads_tenant_status ON leads(tenant_id, status);
CREATE INDEX idx_leads_tenant_assigned ON leads(tenant_id, assigned_to);
CREATE INDEX idx_leads_tenant_created ON leads(tenant_id, created_at DESC);
CREATE INDEX idx_leads_tenant_active_created ON leads(tenant_id, created_at DESC) WHERE is_deleted = false;
CREATE INDEX idx_leads_tenant_assigned_status_created ON leads(tenant_id, assigned_to, status, created_at DESC);
CREATE INDEX idx_leads_tenant_round_created ON leads(tenant_id, round_id, created_at DESC);
CREATE INDEX idx_leads_tenant_campaign_ad ON leads(tenant_id, campaign_id, ad_id);
CREATE INDEX idx_leads_tenant_pipeline_created ON leads(tenant_id, pipeline_id, created_at DESC);
CREATE INDEX idx_leads_tenant_pipeline_stage ON leads(tenant_id, pipeline_id, stage_id);
CREATE INDEX idx_leads_tenant_assigned_accepted ON leads(tenant_id, assigned_to, is_accepted);
CREATE INDEX idx_leads_tenant_status_created ON leads(tenant_id, status, created_at ASC);
CREATE INDEX idx_leads_tenant_custom_fields ON leads USING gin (tenant_id, custom_fields);
CREATE INDEX idx_leads_tenant_quality_created ON leads(tenant_id, quality_status, created_at DESC);
CREATE INDEX idx_leads_tenant_assigned_active_created ON leads(tenant_id, assigned_to, created_at DESC) WHERE is_deleted = false;
CREATE INDEX idx_leads_tenant_active_unarchived_created ON leads(tenant_id, created_at DESC) WHERE is_deleted = false AND status != 'archived';
CREATE INDEX idx_leads_sla_master_sweep ON leads(status, is_accepted, sla_breached, created_at ASC) WHERE is_deleted = false AND status = 'assigned';
CREATE INDEX idx_leads_drainer_unassigned ON leads(status, assigned_to) WHERE is_deleted = false AND status IN ('unassigned_pending', 'recalled');

-- Table: lead_timeline_events (Event-Sourced Append-Only Audit Stream)
CREATE TABLE IF NOT EXISTS lead_timeline_events (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    lead_id UUID NOT NULL,
    event_type VARCHAR(100) NOT NULL, -- 'stage_transition', 'call_log', 'note', 'sla_breach', 'capi_dispatch', 'ticket_raised', or custom note types
    event_category VARCHAR(30) NOT NULL, -- 'pipeline', 'communication', 'note', 'system', 'ticket', 'capi'
    actor_id UUID,
    actor_role VARCHAR(30) NOT NULL,
    actor_name VARCHAR(150),
    title VARCHAR(255) NOT NULL,
    content TEXT,
    metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    CONSTRAINT fk_timeline_lead FOREIGN KEY (tenant_id, lead_id) REFERENCES leads(tenant_id, id) ON DELETE CASCADE,
    CONSTRAINT fk_timeline_actor FOREIGN KEY (tenant_id, actor_id) REFERENCES users(tenant_id, id) ON DELETE SET NULL
);

CREATE INDEX idx_timeline_events_lookup ON lead_timeline_events(tenant_id, lead_id, created_at DESC);
CREATE INDEX idx_timeline_tenant_type_created ON lead_timeline_events(tenant_id, event_type, created_at DESC);
CREATE INDEX idx_timeline_tenant_metadata ON lead_timeline_events USING gin (tenant_id, metadata);

-- ============================================================================
-- 7. INTEGRATIONS, WEBHOOKS & AUDIT LOGS SCHEMA
-- ============================================================================

-- Table: tenant_integrations (AES-256 Encrypted Credential Vault)
CREATE TABLE IF NOT EXISTS tenant_integrations (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    integration_type VARCHAR(50) NOT NULL CHECK (integration_type IN ('telegram', 'telegram_bot', 'zalo_bot', 'zalo_oa', 'zalo_zns', 'meta_capi', 'facebook_ads', 'aws_ses', 'smtp', 'custom_domain_dkim', 'sms_brandname', 'google_sheets', 'misa_einvoice', 'ai_gemini', 'ai_gemini_byok')),
    config_encrypted TEXT NOT NULL, -- AES-256-GCM cipher payload
    iv VARCHAR(64) NOT NULL,
    auth_tag VARCHAR(64) NOT NULL,
    status VARCHAR(30) NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disconnected', 'error', 'refresh_required')),
    token_expires_at TIMESTAMPTZ,
    last_synced_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    CONSTRAINT uk_tenant_integration UNIQUE (tenant_id, integration_type)
);

-- Table: tenant_webhooks (Inbound & Outbound Webhook Registry)
CREATE TABLE IF NOT EXISTS tenant_webhooks (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    name VARCHAR(150) NOT NULL,
    webhook_type VARCHAR(30) NOT NULL CHECK (webhook_type IN ('inbound', 'outbound')),
    url TEXT, -- Destination URL for outbound webhooks
    token VARCHAR(128) NOT NULL, -- Identifier token for inbound URL routing
    signing_secret VARCHAR(255) NOT NULL, -- HMAC-SHA256 signature secret
    field_mappings JSONB NOT NULL DEFAULT '{}'::jsonb,
    subscribed_events JSONB NOT NULL DEFAULT '[]'::jsonb, -- Outbound only
    is_active BOOLEAN NOT NULL DEFAULT true,
    created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    CONSTRAINT uk_webhook_token UNIQUE (token),
    CONSTRAINT uk_webhooks_tenant_id UNIQUE (tenant_id, id)
);

CREATE INDEX idx_tenant_webhooks ON tenant_webhooks(tenant_id, webhook_type, is_active);

-- Table: tenant_webhook_dlq (Dead Letter Queue for Failed Outbound Deliveries)
CREATE TABLE IF NOT EXISTS tenant_webhook_dlq (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    webhook_id UUID NOT NULL,
    event_type VARCHAR(100) NOT NULL,
    delivery_id VARCHAR(100) NOT NULL,
    payload JSONB NOT NULL,
    error_trace TEXT,
    retry_count INTEGER NOT NULL DEFAULT 5,
    last_attempt_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    CONSTRAINT fk_webhook_dlq_webhook FOREIGN KEY (tenant_id, webhook_id) REFERENCES tenant_webhooks(tenant_id, id) ON DELETE CASCADE
);

CREATE INDEX idx_webhook_dlq_tenant ON tenant_webhook_dlq(tenant_id, created_at DESC);
CREATE INDEX idx_webhook_dlq_retry_sweep ON tenant_webhook_dlq(retry_count, last_attempt_at ASC) WHERE retry_count < 10;

-- Table: capi_logs (Audit Trail for Meta Conversions API Dispatches)
CREATE TABLE IF NOT EXISTS capi_logs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    lead_id UUID NOT NULL,
    dataset_id VARCHAR(100) NOT NULL,
    event_name VARCHAR(100) NOT NULL,
    event_id VARCHAR(255) NOT NULL,
    action_source VARCHAR(50) NOT NULL,
    match_keys JSONB NOT NULL DEFAULT '{}'::jsonb, -- records which keys were present (ph, em, fn, etc.)
    sent_payload JSONB NOT NULL,
    response_status INTEGER NOT NULL,
    response_body JSONB,
    sent_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    CONSTRAINT fk_capi_logs_lead FOREIGN KEY (tenant_id, lead_id) REFERENCES leads(tenant_id, id) ON DELETE CASCADE
);

CREATE INDEX idx_capi_logs_lookup ON capi_logs(tenant_id, lead_id, sent_at DESC);
CREATE INDEX idx_capi_logs_tenant_status_sent ON capi_logs(tenant_id, response_status, sent_at DESC);
CREATE INDEX idx_capi_logs_tenant_sent ON capi_logs(tenant_id, sent_at DESC);
CREATE INDEX idx_capi_retry_sweep ON capi_logs(response_status, sent_at ASC) WHERE response_status IN (429, 500, 502, 503, 504);

-- Table: data_reports (Error Tickets, Bogus Number Reports & Replacement Quotas)
CREATE TABLE IF NOT EXISTS data_reports (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    lead_id UUID NOT NULL,
    reporter_id UUID NOT NULL,
    reason VARCHAR(100) NOT NULL,
    description TEXT,
    status VARCHAR(30) NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected')),
    resolved_by UUID,
    resolution_note TEXT,
    compensation_granted BOOLEAN NOT NULL DEFAULT false,
    created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    CONSTRAINT fk_data_reports_lead FOREIGN KEY (tenant_id, lead_id) REFERENCES leads(tenant_id, id) ON DELETE CASCADE,
    CONSTRAINT fk_data_reports_reporter FOREIGN KEY (tenant_id, reporter_id) REFERENCES users(tenant_id, id) ON DELETE CASCADE,
    CONSTRAINT fk_data_reports_resolver FOREIGN KEY (tenant_id, resolved_by) REFERENCES users(tenant_id, id) ON DELETE SET NULL
);

CREATE INDEX idx_data_reports_tenant ON data_reports(tenant_id, status, created_at DESC);
CREATE INDEX idx_data_reports_tenant_created ON data_reports(tenant_id, created_at DESC);

-- ============================================================================
-- 8. KERNEL ROW-LEVEL SECURITY (RLS) POLICIES & ENFORCEMENT
-- ============================================================================

-- Function: Trigger to automatically enforce update timestamps
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = clock_timestamp();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Apply update triggers across tables
DO $$
DECLARE
    t text;
BEGIN
    FOR t IN 
        SELECT table_name 
        FROM information_schema.columns 
        WHERE column_name = 'updated_at' 
          AND table_schema = 'public' 
          AND table_name NOT IN ('tenants')
    LOOP
        EXECUTE format('DROP TRIGGER IF EXISTS trigger_updated_at_%I ON %I;', t, t);
        EXECUTE format('CREATE TRIGGER trigger_updated_at_%I BEFORE UPDATE ON %I FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();', t, t);
    END LOOP;
END;
$$;

-- Function: Immutability trigger on lead_timeline_events (Blocks UPDATE and DELETE)
CREATE OR REPLACE FUNCTION trg_prevent_timeline_mutation()
RETURNS TRIGGER AS $$
BEGIN
    RAISE EXCEPTION 'Security Violation: lead_timeline_events is an immutable append-only audit stream. UPDATE and DELETE operations are strictly forbidden.';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trigger_immutable_lead_timeline ON lead_timeline_events;
CREATE TRIGGER trigger_immutable_lead_timeline
    BEFORE UPDATE OR DELETE ON lead_timeline_events
    FOR EACH ROW
    EXECUTE FUNCTION trg_prevent_timeline_mutation();

-- Enable and FORCE Row-Level Security on all tenant-partitioned tables
ALTER TABLE tenants ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenants FORCE ROW LEVEL SECURITY;

ALTER TABLE tenant_onboarding_progress ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenant_onboarding_progress FORCE ROW LEVEL SECURITY;

ALTER TABLE users ENABLE ROW LEVEL SECURITY;
ALTER TABLE users FORCE ROW LEVEL SECURITY;

ALTER TABLE tenant_user_profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenant_user_profiles FORCE ROW LEVEL SECURITY;

ALTER TABLE tenant_pipelines ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenant_pipelines FORCE ROW LEVEL SECURITY;

ALTER TABLE tenant_pipeline_stages ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenant_pipeline_stages FORCE ROW LEVEL SECURITY;

ALTER TABLE tenant_pipeline_custom_fields ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenant_pipeline_custom_fields FORCE ROW LEVEL SECURITY;

ALTER TABLE distribution_rounds ENABLE ROW LEVEL SECURITY;
ALTER TABLE distribution_rounds FORCE ROW LEVEL SECURITY;

ALTER TABLE round_consultants ENABLE ROW LEVEL SECURITY;
ALTER TABLE round_consultants FORCE ROW LEVEL SECURITY;

ALTER TABLE routing_rules ENABLE ROW LEVEL SECURITY;
ALTER TABLE routing_rules FORCE ROW LEVEL SECURITY;

ALTER TABLE leads ENABLE ROW LEVEL SECURITY;
ALTER TABLE leads FORCE ROW LEVEL SECURITY;

ALTER TABLE lead_timeline_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE lead_timeline_events FORCE ROW LEVEL SECURITY;

ALTER TABLE tenant_integrations ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenant_integrations FORCE ROW LEVEL SECURITY;

ALTER TABLE tenant_webhooks ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenant_webhooks FORCE ROW LEVEL SECURITY;

ALTER TABLE tenant_webhook_dlq ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenant_webhook_dlq FORCE ROW LEVEL SECURITY;

ALTER TABLE capi_logs ENABLE ROW LEVEL SECURITY;
ALTER TABLE capi_logs FORCE ROW LEVEL SECURITY;

ALTER TABLE data_reports ENABLE ROW LEVEL SECURITY;
ALTER TABLE data_reports FORCE ROW LEVEL SECURITY;

-- Define Uniform Tenant RLS Isolation Policies
CREATE POLICY tenant_isolation_tenants ON tenants
    USING (id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid);

CREATE POLICY tenant_isolation_onboarding ON tenant_onboarding_progress
    USING (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid);

CREATE POLICY tenant_isolation_users ON users
    USING (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid);

CREATE POLICY tenant_isolation_user_profiles ON tenant_user_profiles
    USING (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid);

CREATE POLICY tenant_isolation_pipelines ON tenant_pipelines
    USING (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid);

CREATE POLICY tenant_isolation_pipeline_stages ON tenant_pipeline_stages
    USING (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid);

CREATE POLICY tenant_isolation_custom_fields ON tenant_pipeline_custom_fields
    USING (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid);

CREATE POLICY tenant_isolation_distribution_rounds ON distribution_rounds
    USING (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid);

CREATE POLICY tenant_isolation_round_consultants ON round_consultants
    USING (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid);

CREATE POLICY tenant_isolation_routing_rules ON routing_rules
    USING (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid);

CREATE POLICY tenant_isolation_leads ON leads
    USING (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid);

CREATE POLICY tenant_isolation_timeline_events ON lead_timeline_events
    USING (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid);

CREATE POLICY tenant_isolation_integrations ON tenant_integrations
    USING (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid);

CREATE POLICY tenant_isolation_webhooks ON tenant_webhooks
    USING (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid);

CREATE POLICY tenant_isolation_webhook_dlq ON tenant_webhook_dlq
    USING (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid);

CREATE POLICY tenant_isolation_capi_logs ON capi_logs
    USING (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid);

CREATE POLICY tenant_isolation_data_reports ON data_reports
    USING (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid);

-- Table: tenant_billing_transactions (Subscription, Step Renewal, Wallet Topup & CRM/ERP Upgrade Ledger)
CREATE TABLE IF NOT EXISTS tenant_billing_transactions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    tx_type VARCHAR(40) NOT NULL CHECK (tx_type IN ('topup', 'subscription_purchase', 'renewal', 'plan_upgrade', 'crm_erp_upgrade', 'admin_grant')),
    plan_code VARCHAR(80),
    billing_cycle VARCHAR(30),
    months_added INTEGER NOT NULL DEFAULT 0,
    amount_vnd BIGINT NOT NULL DEFAULT 0,
    discount_pct NUMERIC(5,2) NOT NULL DEFAULT 0,
    payment_method VARCHAR(40) NOT NULL DEFAULT 'bank_transfer',
    status VARCHAR(30) NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected', 'completed')),
    reference_code VARCHAR(80),
    note TEXT,
    metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
    requested_by UUID,
    processed_by VARCHAR(255),
    processed_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);

CREATE INDEX IF NOT EXISTS idx_billing_tx_tenant_created ON tenant_billing_transactions(tenant_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_billing_tx_status_created ON tenant_billing_transactions(status, created_at DESC);

ALTER TABLE tenant_billing_transactions ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenant_billing_transactions FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation_billing_tx ON tenant_billing_transactions
    USING (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid);

-- ============================================================================
-- 9. OPERATIONAL EXTENSIONS (CO-MANAGERS, PERSONAL LEADS, AI GATEKEEPER, BLACKLIST, META ADS, AUDIT, COMPENSATION)
-- ============================================================================

CREATE TABLE IF NOT EXISTS consultant_managers (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    consultant_user_id UUID NOT NULL,
    name VARCHAR(150) NOT NULL,
    email VARCHAR(255) NOT NULL,
    phone VARCHAR(30),
    zalo_chat_id VARCHAR(100),
    zalo_verified BOOLEAN NOT NULL DEFAULT false,
    status VARCHAR(30) NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'inactive')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    CONSTRAINT fk_cm_consultant FOREIGN KEY (tenant_id, consultant_user_id) REFERENCES users(tenant_id, id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_cm_tenant_consultant ON consultant_managers(tenant_id, consultant_user_id, status);

CREATE TABLE IF NOT EXISTS personal_leads (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    owner_user_id UUID NOT NULL,
    name VARCHAR(150) NOT NULL,
    phone VARCHAR(30) NOT NULL,
    email VARCHAR(255),
    product_interest VARCHAR(255),
    note TEXT,
    status VARCHAR(40) NOT NULL DEFAULT 'new',
    sheet_sync_status VARCHAR(255) NOT NULL DEFAULT 'Lưu nội bộ trên Cổng Sale Cá Nhân',
    quota_impact INTEGER NOT NULL DEFAULT 0,
    sla_recall_exempt BOOLEAN NOT NULL DEFAULT true,
    custom_fields JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    CONSTRAINT fk_pl_owner FOREIGN KEY (tenant_id, owner_user_id) REFERENCES users(tenant_id, id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_personal_leads_owner ON personal_leads(tenant_id, owner_user_id, created_at DESC);

CREATE TABLE IF NOT EXISTS ai_screener_configs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    mode VARCHAR(20) NOT NULL DEFAULT 'ai' CHECK (mode IN ('ai', 'manual', 'hybrid')),
    is_enabled BOOLEAN NOT NULL DEFAULT false,
    model_name VARCHAR(80) NOT NULL DEFAULT 'gemini-2.5-flash',
    prompt_rules TEXT,
    manual_action VARCHAR(30) NOT NULL DEFAULT 'hold',
    manual_rules JSONB NOT NULL DEFAULT '[]'::jsonb,
    target_round_ids JSONB NOT NULL DEFAULT '[]'::jsonb,
    fallback_enabled BOOLEAN NOT NULL DEFAULT false,
    fallback_round_id UUID,
    created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    CONSTRAINT uk_ai_screener_tenant UNIQUE (tenant_id)
);

CREATE TABLE IF NOT EXISTS held_leads (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    round_id UUID,
    connection_id UUID,
    name VARCHAR(150) NOT NULL,
    phone VARCHAR(30) NOT NULL,
    email VARCHAR(255),
    source VARCHAR(100) NOT NULL DEFAULT 'Webhook',
    campaign VARCHAR(150),
    ai_screener_status VARCHAR(40) NOT NULL DEFAULT 'failed',
    ai_evaluation TEXT,
    hold_reason TEXT,
    status VARCHAR(30) NOT NULL DEFAULT 'held' CHECK (status IN ('held', 'approved', 'rejected', 'blacklisted')),
    payload_json JSONB NOT NULL DEFAULT '{}'::jsonb,
    resolved_by UUID,
    resolved_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX IF NOT EXISTS idx_held_leads_tenant_status ON held_leads(tenant_id, status, created_at DESC);

CREATE TABLE IF NOT EXISTS blacklist_entries (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    entry_type VARCHAR(20) NOT NULL CHECK (entry_type IN ('phone', 'email', 'ip', 'keyword')),
    value VARCHAR(255) NOT NULL,
    reason TEXT,
    created_by UUID,
    created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    CONSTRAINT uk_blacklist_tenant_type_val UNIQUE (tenant_id, entry_type, value)
);
CREATE INDEX IF NOT EXISTS idx_blacklist_tenant_type ON blacklist_entries(tenant_id, entry_type);

CREATE TABLE IF NOT EXISTS meta_ads_insights (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    date_start DATE NOT NULL,
    date_stop DATE NOT NULL,
    campaign_id VARCHAR(100) NOT NULL,
    campaign_name VARCHAR(255),
    adset_id VARCHAR(100),
    adset_name VARCHAR(255),
    ad_id VARCHAR(100) NOT NULL,
    ad_name VARCHAR(255),
    spend NUMERIC(16,2) NOT NULL DEFAULT 0,
    impressions INTEGER NOT NULL DEFAULT 0,
    clicks INTEGER NOT NULL DEFAULT 0,
    reach INTEGER NOT NULL DEFAULT 0,
    ctr NUMERIC(8,4) NOT NULL DEFAULT 0,
    cpc NUMERIC(14,2) NOT NULL DEFAULT 0,
    cpm NUMERIC(14,2) NOT NULL DEFAULT 0,
    frequency NUMERIC(8,2) NOT NULL DEFAULT 0,
    meta_leads INTEGER NOT NULL DEFAULT 0,
    thumbnail_url TEXT,
    image_url TEXT,
    creative_title TEXT,
    creative_body TEXT,
    story_id VARCHAR(100),
    optimization_goal VARCHAR(100),
    created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    CONSTRAINT uk_meta_ads_tenant_ad_date UNIQUE (tenant_id, ad_id, date_start, date_stop)
);
CREATE INDEX IF NOT EXISTS idx_meta_ads_tenant_date ON meta_ads_insights(tenant_id, date_start DESC);

CREATE TABLE IF NOT EXISTS lead_import_batches (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    file_name VARCHAR(255) NOT NULL,
    total_rows INTEGER NOT NULL DEFAULT 0,
    imported_count INTEGER NOT NULL DEFAULT 0,
    duplicate_count INTEGER NOT NULL DEFAULT 0,
    skipped_count INTEGER NOT NULL DEFAULT 0,
    is_silent BOOLEAN NOT NULL DEFAULT true,
    status VARCHAR(30) NOT NULL DEFAULT 'completed' CHECK (status IN ('completed', 'rolled_back')),
    imported_by UUID,
    created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX IF NOT EXISTS idx_import_batches_tenant ON lead_import_batches(tenant_id, created_at DESC);

CREATE TABLE IF NOT EXISTS admin_audit_logs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    actor_id UUID,
    actor_name VARCHAR(150),
    action VARCHAR(100) NOT NULL,
    entity_type VARCHAR(60) NOT NULL,
    entity_id VARCHAR(100),
    before_snapshot JSONB NOT NULL DEFAULT '{}'::jsonb,
    after_snapshot JSONB NOT NULL DEFAULT '{}'::jsonb,
    details JSONB NOT NULL DEFAULT '{}'::jsonb,
    ip_address VARCHAR(64),
    is_rolled_back BOOLEAN NOT NULL DEFAULT false,
    rolled_back_at TIMESTAMPTZ,
    rolled_back_by UUID,
    created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX IF NOT EXISTS idx_admin_audit_tenant_created ON admin_audit_logs(tenant_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_logs_actor_created ON admin_audit_logs(tenant_id, actor_id, created_at DESC);

CREATE TABLE IF NOT EXISTS active_compensation_logs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    round_id UUID NOT NULL,
    consultant_user_id UUID NOT NULL,
    admin_user_id UUID,
    ticket_id UUID,
    amount INTEGER NOT NULL,
    reason VARCHAR(255),
    source_type VARCHAR(40) NOT NULL DEFAULT 'manual',
    created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX IF NOT EXISTS idx_comp_logs_tenant_created ON active_compensation_logs(tenant_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_comp_logs_consultant ON active_compensation_logs(tenant_id, consultant_user_id, created_at DESC);

ALTER TABLE consultant_managers ENABLE ROW LEVEL SECURITY;
ALTER TABLE consultant_managers FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation_consultant_managers ON consultant_managers
    USING (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid);

ALTER TABLE personal_leads ENABLE ROW LEVEL SECURITY;
ALTER TABLE personal_leads FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation_personal_leads ON personal_leads
    USING (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid);

ALTER TABLE ai_screener_configs ENABLE ROW LEVEL SECURITY;
ALTER TABLE ai_screener_configs FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation_ai_screener_configs ON ai_screener_configs
    USING (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid);

ALTER TABLE held_leads ENABLE ROW LEVEL SECURITY;
ALTER TABLE held_leads FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation_held_leads ON held_leads
    USING (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid);

ALTER TABLE blacklist_entries ENABLE ROW LEVEL SECURITY;
ALTER TABLE blacklist_entries FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation_blacklist_entries ON blacklist_entries
    USING (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid);

ALTER TABLE meta_ads_insights ENABLE ROW LEVEL SECURITY;
ALTER TABLE meta_ads_insights FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation_meta_ads_insights ON meta_ads_insights
    USING (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid);

ALTER TABLE lead_import_batches ENABLE ROW LEVEL SECURITY;
ALTER TABLE lead_import_batches FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation_lead_import_batches ON lead_import_batches
    USING (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid);

ALTER TABLE admin_audit_logs ENABLE ROW LEVEL SECURITY;
ALTER TABLE admin_audit_logs FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation_admin_audit_logs ON admin_audit_logs
    USING (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid);

ALTER TABLE active_compensation_logs ENABLE ROW LEVEL SECURITY;
ALTER TABLE active_compensation_logs FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation_active_compensation_logs ON active_compensation_logs
    USING (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid);


-- ============================================================================
-- 10. WAVE 1 MULTI-PRODUCT SAAS CORE: ORG, GRANULAR RBAC, POLICIES & AUDIENCES
-- ============================================================================

CREATE INDEX IF NOT EXISTS idx_leads_tenant_email_lower ON leads(tenant_id, LOWER(email)) WHERE email IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_leads_tenant_lifecycle ON leads(tenant_id, lifecycle_stage);
CREATE INDEX IF NOT EXISTS idx_leads_tenant_score ON leads(tenant_id, lead_score DESC);
CREATE INDEX IF NOT EXISTS idx_leads_tenant_revenue ON leads(tenant_id, total_revenue_vnd DESC);
CREATE INDEX IF NOT EXISTS idx_users_tenant_dept ON users(tenant_id, department_id);
CREATE INDEX IF NOT EXISTS idx_users_tenant_branch ON users(tenant_id, branch_id);
CREATE INDEX IF NOT EXISTS idx_users_tenant_team ON users(tenant_id, team_id);
CREATE INDEX IF NOT EXISTS idx_users_tenant_role_id ON users(tenant_id, role_id);

-- 10.1 Dynamic Organization Structure
CREATE TABLE IF NOT EXISTS tenant_branches (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    code VARCHAR(50) NOT NULL,
    name VARCHAR(150) NOT NULL,
    legal_entity_name VARCHAR(255),
    tax_code VARCHAR(50),
    representative_name VARCHAR(150),
    representative_title VARCHAR(100),
    address TEXT,
    phone VARCHAR(30),
    email VARCHAR(255),
    gps_lat NUMERIC(10,7),
    gps_lng NUMERIC(10,7),
    gps_radius_meters INTEGER NOT NULL DEFAULT 150,
    work_schedule JSONB NOT NULL DEFAULT '{}'::jsonb,
    is_headquarters BOOLEAN NOT NULL DEFAULT false,
    is_active BOOLEAN NOT NULL DEFAULT true,
    created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    CONSTRAINT uk_tenant_branches_tenant_id UNIQUE (tenant_id, id),
    CONSTRAINT uk_tenant_branches_code UNIQUE (tenant_id, code)
);
CREATE INDEX IF NOT EXISTS idx_tenant_branches_tenant ON tenant_branches(tenant_id, is_active);

CREATE TABLE IF NOT EXISTS tenant_roles (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    role_key VARCHAR(64) NOT NULL,
    name VARCHAR(150) NOT NULL,
    description TEXT,
    default_data_scope VARCHAR(30) NOT NULL DEFAULT 'own' CHECK (default_data_scope IN ('none', 'own', 'team', 'department', 'sub_departments', 'branch', 'company')),
    is_system BOOLEAN NOT NULL DEFAULT false,
    is_active BOOLEAN NOT NULL DEFAULT true,
    created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    CONSTRAINT uk_tenant_roles_tenant_id UNIQUE (tenant_id, id),
    CONSTRAINT uk_tenant_roles_key UNIQUE (tenant_id, role_key)
);
CREATE INDEX IF NOT EXISTS idx_tenant_roles_tenant ON tenant_roles(tenant_id, is_active);

CREATE TABLE IF NOT EXISTS tenant_departments (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    branch_id UUID,
    parent_department_id UUID,
    code VARCHAR(50) NOT NULL,
    name VARCHAR(150) NOT NULL,
    description TEXT,
    manager_user_id UUID,
    default_role_id UUID,
    sort_order INTEGER NOT NULL DEFAULT 0,
    is_active BOOLEAN NOT NULL DEFAULT true,
    created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    CONSTRAINT uk_tenant_departments_tenant_id UNIQUE (tenant_id, id),
    CONSTRAINT uk_tenant_departments_code UNIQUE (tenant_id, code),
    CONSTRAINT fk_dept_branch FOREIGN KEY (tenant_id, branch_id) REFERENCES tenant_branches(tenant_id, id) ON DELETE SET NULL,
    CONSTRAINT fk_dept_parent FOREIGN KEY (tenant_id, parent_department_id) REFERENCES tenant_departments(tenant_id, id) ON DELETE SET NULL,
    CONSTRAINT fk_dept_manager FOREIGN KEY (tenant_id, manager_user_id) REFERENCES users(tenant_id, id) ON DELETE SET NULL,
    CONSTRAINT fk_dept_default_role FOREIGN KEY (tenant_id, default_role_id) REFERENCES tenant_roles(tenant_id, id) ON DELETE SET NULL
);
CREATE INDEX IF NOT EXISTS idx_tenant_departments_tenant ON tenant_departments(tenant_id, parent_department_id, sort_order);

CREATE TABLE IF NOT EXISTS tenant_teams (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    department_id UUID,
    branch_id UUID,
    code VARCHAR(50) NOT NULL,
    name VARCHAR(150) NOT NULL,
    description TEXT,
    leader_user_id UUID,
    is_active BOOLEAN NOT NULL DEFAULT true,
    created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    CONSTRAINT uk_tenant_teams_tenant_id UNIQUE (tenant_id, id),
    CONSTRAINT uk_tenant_teams_code UNIQUE (tenant_id, code),
    CONSTRAINT fk_team_dept FOREIGN KEY (tenant_id, department_id) REFERENCES tenant_departments(tenant_id, id) ON DELETE SET NULL,
    CONSTRAINT fk_team_branch FOREIGN KEY (tenant_id, branch_id) REFERENCES tenant_branches(tenant_id, id) ON DELETE SET NULL,
    CONSTRAINT fk_team_leader FOREIGN KEY (tenant_id, leader_user_id) REFERENCES users(tenant_id, id) ON DELETE SET NULL
);
CREATE INDEX IF NOT EXISTS idx_tenant_teams_tenant ON tenant_teams(tenant_id, department_id);

CREATE TABLE IF NOT EXISTS tenant_positions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    department_id UUID,
    code VARCHAR(50) NOT NULL,
    name VARCHAR(150) NOT NULL,
    level_rank INTEGER NOT NULL DEFAULT 1,
    description TEXT,
    is_active BOOLEAN NOT NULL DEFAULT true,
    created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    CONSTRAINT uk_tenant_positions_tenant_id UNIQUE (tenant_id, id),
    CONSTRAINT uk_tenant_positions_code UNIQUE (tenant_id, code),
    CONSTRAINT fk_pos_dept FOREIGN KEY (tenant_id, department_id) REFERENCES tenant_departments(tenant_id, id) ON DELETE SET NULL
);
CREATE INDEX IF NOT EXISTS idx_tenant_positions_tenant ON tenant_positions(tenant_id, level_rank DESC);

-- 10.2 Granular RBAC Permission Matrices (7 Scopes × 11 Actions)
CREATE TABLE IF NOT EXISTS tenant_role_permissions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    role_id UUID NOT NULL,
    module_key VARCHAR(64) NOT NULL,
    data_scope VARCHAR(30) NOT NULL DEFAULT 'none' CHECK (data_scope IN ('none', 'own', 'team', 'department', 'sub_departments', 'branch', 'company')),
    actions JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    CONSTRAINT uk_role_perm_module UNIQUE (tenant_id, role_id, module_key),
    CONSTRAINT fk_role_perm_role FOREIGN KEY (tenant_id, role_id) REFERENCES tenant_roles(tenant_id, id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_role_perms_lookup ON tenant_role_permissions(tenant_id, role_id);

CREATE TABLE IF NOT EXISTS tenant_department_permissions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    department_id UUID NOT NULL,
    module_key VARCHAR(64) NOT NULL,
    data_scope VARCHAR(30) NOT NULL DEFAULT 'none' CHECK (data_scope IN ('none', 'own', 'team', 'department', 'sub_departments', 'branch', 'company')),
    actions JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    CONSTRAINT uk_dept_perm_module UNIQUE (tenant_id, department_id, module_key),
    CONSTRAINT fk_dept_perm_dept FOREIGN KEY (tenant_id, department_id) REFERENCES tenant_departments(tenant_id, id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_dept_perms_lookup ON tenant_department_permissions(tenant_id, department_id);

CREATE TABLE IF NOT EXISTS tenant_user_permission_overrides (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    user_id UUID NOT NULL,
    module_key VARCHAR(64) NOT NULL,
    effect VARCHAR(10) NOT NULL DEFAULT 'grant' CHECK (effect IN ('grant', 'deny')),
    data_scope VARCHAR(30) CHECK (data_scope IS NULL OR data_scope IN ('none', 'own', 'team', 'department', 'sub_departments', 'branch', 'company')),
    actions JSONB NOT NULL DEFAULT '{}'::jsonb,
    reason TEXT,
    expires_at TIMESTAMPTZ,
    created_by UUID,
    created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    CONSTRAINT uk_user_perm_override UNIQUE (tenant_id, user_id, module_key, effect),
    CONSTRAINT fk_user_override_user FOREIGN KEY (tenant_id, user_id) REFERENCES users(tenant_id, id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_user_overrides_lookup ON tenant_user_permission_overrides(tenant_id, user_id);

-- 10.3 Dynamic Stage Transition Rules, Custom KPIs & Company Policy Documents
CREATE TABLE IF NOT EXISTS tenant_stage_transition_rules (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    pipeline_id UUID NOT NULL,
    from_stage_id UUID,
    to_stage_id UUID NOT NULL,
    rule_name VARCHAR(150),
    required_fields JSONB NOT NULL DEFAULT '[]'::jsonb,
    allowed_role_ids JSONB NOT NULL DEFAULT '[]'::jsonb,
    allowed_roles JSONB NOT NULL DEFAULT '[]'::jsonb,
    require_note BOOLEAN NOT NULL DEFAULT false,
    max_sla_hours INTEGER NOT NULL DEFAULT 0,
    score_delta INTEGER NOT NULL DEFAULT 0,
    auto_task_templates JSONB NOT NULL DEFAULT '[]'::jsonb,
    notify_role_ids JSONB NOT NULL DEFAULT '[]'::jsonb,
    trigger_flow_id UUID,
    capi_event_override VARCHAR(100),
    is_active BOOLEAN NOT NULL DEFAULT true,
    created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    CONSTRAINT fk_stage_rule_pipeline FOREIGN KEY (tenant_id, pipeline_id) REFERENCES tenant_pipelines(tenant_id, id) ON DELETE CASCADE,
    CONSTRAINT fk_stage_rule_to_stage FOREIGN KEY (tenant_id, to_stage_id) REFERENCES tenant_pipeline_stages(tenant_id, id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_stage_rules_lookup ON tenant_stage_transition_rules(tenant_id, pipeline_id, to_stage_id);

CREATE TABLE IF NOT EXISTS tenant_custom_kpis (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    kpi_key VARCHAR(64) NOT NULL,
    name VARCHAR(150) NOT NULL,
    description TEXT,
    module_key VARCHAR(64) NOT NULL DEFAULT 'crm',
    source_entity VARCHAR(64) NOT NULL DEFAULT 'leads',
    metric_op VARCHAR(30) NOT NULL DEFAULT 'COUNT' CHECK (metric_op IN ('COUNT', 'SUM', 'AVG', 'MIN', 'MAX', 'CONVERSION_RATE')),
    target_field VARCHAR(100),
    filter_branches JSONB NOT NULL DEFAULT '[]'::jsonb,
    target_value NUMERIC(18,2) NOT NULL DEFAULT 0,
    unit VARCHAR(30) NOT NULL DEFAULT '',
    color_hex VARCHAR(20) NOT NULL DEFAULT '#1E40FF',
    sort_order INTEGER NOT NULL DEFAULT 0,
    is_active BOOLEAN NOT NULL DEFAULT true,
    created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    CONSTRAINT uk_tenant_custom_kpis_key UNIQUE (tenant_id, kpi_key)
);
CREATE INDEX IF NOT EXISTS idx_custom_kpis_tenant ON tenant_custom_kpis(tenant_id, is_active, sort_order);

CREATE TABLE IF NOT EXISTS tenant_policy_documents (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    doc_key VARCHAR(80) NOT NULL,
    title VARCHAR(255) NOT NULL,
    doc_category VARCHAR(50) NOT NULL DEFAULT 'company_policy',
    content_html TEXT NOT NULL DEFAULT '',
    content_markdown TEXT,
    variables_schema JSONB NOT NULL DEFAULT '[]'::jsonb,
    version INTEGER NOT NULL DEFAULT 1,
    status VARCHAR(30) NOT NULL DEFAULT 'published' CHECK (status IN ('draft', 'published', 'archived')),
    sync_to_dom_agent BOOLEAN NOT NULL DEFAULT false,
    last_synced_dom_agent_at TIMESTAMPTZ,
    allowed_department_ids JSONB NOT NULL DEFAULT '[]'::jsonb,
    updated_by UUID,
    created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    CONSTRAINT uk_tenant_policy_docs_key UNIQUE (tenant_id, doc_key)
);
CREATE INDEX IF NOT EXISTS idx_policy_docs_tenant ON tenant_policy_documents(tenant_id, doc_category, status);

-- 10.4 Master Contact Audiences ("Tệp Data" & "Tệp Logic") & Tags
CREATE TABLE IF NOT EXISTS tenant_audiences (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    name VARCHAR(200) NOT NULL,
    description TEXT,
    audience_type VARCHAR(30) NOT NULL DEFAULT 'static_data' CHECK (audience_type IN ('static_data', 'sync_data', 'dynamic_logic')),
    filter_branches JSONB NOT NULL DEFAULT '[]'::jsonb,
    sync_config JSONB NOT NULL DEFAULT '{}'::jsonb,
    cached_member_count INTEGER NOT NULL DEFAULT 0,
    auto_push_to_sale_round BOOLEAN NOT NULL DEFAULT false,
    target_round_id UUID,
    color_hex VARCHAR(20) NOT NULL DEFAULT '#1E40FF',
    is_active BOOLEAN NOT NULL DEFAULT true,
    last_evaluated_at TIMESTAMPTZ,
    created_by UUID,
    created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    CONSTRAINT uk_tenant_audiences_tenant_id UNIQUE (tenant_id, id),
    CONSTRAINT fk_audience_target_round FOREIGN KEY (tenant_id, target_round_id) REFERENCES distribution_rounds(tenant_id, id) ON DELETE SET NULL
);
CREATE INDEX IF NOT EXISTS idx_audiences_tenant_type ON tenant_audiences(tenant_id, audience_type, is_active);

CREATE TABLE IF NOT EXISTS tenant_audience_members (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    audience_id UUID NOT NULL,
    lead_id UUID NOT NULL,
    source_type VARCHAR(40) NOT NULL DEFAULT 'manual',
    metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
    joined_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    CONSTRAINT uk_audience_member UNIQUE (tenant_id, audience_id, lead_id),
    CONSTRAINT fk_aud_member_audience FOREIGN KEY (tenant_id, audience_id) REFERENCES tenant_audiences(tenant_id, id) ON DELETE CASCADE,
    CONSTRAINT fk_aud_member_lead FOREIGN KEY (tenant_id, lead_id) REFERENCES leads(tenant_id, id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_aud_members_audience ON tenant_audience_members(tenant_id, audience_id, joined_at DESC);
CREATE INDEX IF NOT EXISTS idx_aud_members_lead ON tenant_audience_members(tenant_id, lead_id);

CREATE TABLE IF NOT EXISTS tenant_audience_exclusions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    audience_id UUID NOT NULL,
    lead_id UUID,
    excluded_audience_id UUID,
    email VARCHAR(255),
    phone VARCHAR(30),
    reason VARCHAR(255),
    created_by UUID,
    created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    CONSTRAINT fk_aud_excl_audience FOREIGN KEY (tenant_id, audience_id) REFERENCES tenant_audiences(tenant_id, id) ON DELETE CASCADE,
    CONSTRAINT fk_aud_excl_lead FOREIGN KEY (tenant_id, lead_id) REFERENCES leads(tenant_id, id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_aud_excl_audience ON tenant_audience_exclusions(tenant_id, audience_id);

CREATE TABLE IF NOT EXISTS tenant_tags (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    name VARCHAR(100) NOT NULL,
    slug VARCHAR(100) NOT NULL,
    color_hex VARCHAR(20) NOT NULL DEFAULT '#1E40FF',
    category VARCHAR(50) NOT NULL DEFAULT 'general',
    description TEXT,
    usage_count INTEGER NOT NULL DEFAULT 0,
    created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    CONSTRAINT uk_tenant_tags_tenant_id UNIQUE (tenant_id, id),
    CONSTRAINT uk_tenant_tags_slug UNIQUE (tenant_id, slug)
);
CREATE INDEX IF NOT EXISTS idx_tenant_tags_tenant ON tenant_tags(tenant_id, category);

CREATE TABLE IF NOT EXISTS lead_tags (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    lead_id UUID NOT NULL,
    tag_id UUID NOT NULL,
    assigned_by UUID,
    created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    CONSTRAINT uk_lead_tag UNIQUE (tenant_id, lead_id, tag_id),
    CONSTRAINT fk_lead_tag_lead FOREIGN KEY (tenant_id, lead_id) REFERENCES leads(tenant_id, id) ON DELETE CASCADE,
    CONSTRAINT fk_lead_tag_tag FOREIGN KEY (tenant_id, tag_id) REFERENCES tenant_tags(tenant_id, id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_lead_tags_lead ON lead_tags(tenant_id, lead_id);
CREATE INDEX IF NOT EXISTS idx_lead_tags_tag ON lead_tags(tenant_id, tag_id);

-- 10.5 Enforce Kernel Row-Level Security (FORCE RLS) on All Wave 1 Tables
DO $$
DECLARE
    tbl TEXT;
    pol TEXT;
BEGIN
    FOREACH tbl IN ARRAY ARRAY[
        'tenant_branches', 'tenant_roles', 'tenant_departments', 'tenant_teams',
        'tenant_positions', 'tenant_role_permissions', 'tenant_department_permissions',
        'tenant_user_permission_overrides', 'tenant_stage_transition_rules',
        'tenant_custom_kpis', 'tenant_policy_documents', 'tenant_audiences',
        'tenant_audience_members', 'tenant_audience_exclusions', 'tenant_tags', 'lead_tags'
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
