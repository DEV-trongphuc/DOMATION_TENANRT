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
    plan_tier VARCHAR(50) NOT NULL DEFAULT 'starter' CHECK (plan_tier IN ('starter', 'growth', 'enterprise', 'autodata_standard', 'autodata_growth', 'domation_crm_erp', 'autodata_crm', 'marketing_standalone', 'growth_combo', 'domation_promax')),
    enabled_modules JSONB NOT NULL DEFAULT '["leads","org_rbac","settings","billing","dashboard_crm","crm_dashboard","pipelines","rounds","fair_share","consultants","routing_rules","gatekeeper","tickets_data","ads_capi","sale_portal","appointments","integrations_crm","integrations_autodata","dom_sales_copilot"]'::jsonb,
    entitlements JSONB NOT NULL DEFAULT '{"package_code":"autodata_crm","education_addon":false,"enable_ideas_mascot":false}'::jsonb,
    status VARCHAR(50) NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'suspended', 'trial', 'grace', 'cancelled')),
    trial_ends_at TIMESTAMPTZ DEFAULT (clock_timestamp() + INTERVAL '30 days'),
    subscription_expires_at TIMESTAMPTZ,
    grace_ends_at TIMESTAMPTZ,
    auto_renew BOOLEAN NOT NULL DEFAULT true,
    cancel_at_period_end BOOLEAN NOT NULL DEFAULT false,
    cancelled_at TIMESTAMPTZ,
    scheduled_plan_code VARCHAR(80),
    scheduled_billing_cycle VARCHAR(30),
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
CREATE INDEX idx_tenants_subscription_expiry ON tenants(status, subscription_expires_at, trial_ends_at, grace_ends_at) WHERE status IN ('active', 'trial', 'grace');

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
CREATE INDEX IF NOT EXISTS idx_leads_tenant_created_at ON leads(tenant_id, created_at DESC);
CREATE INDEX idx_leads_tenant_active_created ON leads(tenant_id, created_at DESC) WHERE is_deleted = false;
CREATE INDEX idx_leads_tenant_assigned_status_created ON leads(tenant_id, assigned_to, status, created_at DESC);
CREATE INDEX idx_leads_tenant_round_created ON leads(tenant_id, round_id, created_at DESC);
CREATE INDEX idx_leads_tenant_campaign_ad ON leads(tenant_id, campaign_id, ad_id);
CREATE INDEX idx_leads_tenant_ad_id ON leads(tenant_id, ad_id) WHERE is_deleted = false AND ad_id IS NOT NULL;
CREATE INDEX idx_leads_tenant_adset_id ON leads(tenant_id, adset_id) WHERE is_deleted = false AND adset_id IS NOT NULL;
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
    integration_type VARCHAR(50) NOT NULL CHECK (integration_type IN ('telegram', 'telegram_bot', 'zalo_bot', 'zalo_oa', 'zalo_zns', 'meta_capi', 'meta_messenger', 'facebook_ads', 'google_ads', 'dom_meta_report', 'aws_ses', 'smtp', 'custom_domain_dkim', 'sms_brandname', 'google_sheets', 'misa_einvoice', 'ai_gemini', 'ai_gemini_byok')),
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
    retry_count INTEGER NOT NULL DEFAULT 0,
    next_retry_at TIMESTAMPTZ,
    sent_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    CONSTRAINT fk_capi_logs_lead FOREIGN KEY (tenant_id, lead_id) REFERENCES leads(tenant_id, id) ON DELETE CASCADE
);

CREATE INDEX idx_capi_logs_lookup ON capi_logs(tenant_id, lead_id, sent_at DESC);
CREATE INDEX idx_capi_logs_tenant_status_sent ON capi_logs(tenant_id, response_status, sent_at DESC);
CREATE INDEX idx_capi_logs_tenant_sent ON capi_logs(tenant_id, sent_at DESC);
CREATE INDEX idx_capi_logs_lead_event_status ON capi_logs(tenant_id, lead_id, event_name, response_status);
CREATE INDEX idx_capi_retry_sweep ON capi_logs(response_status, sent_at ASC) WHERE response_status IN (429, 500, 502, 503, 504);
CREATE INDEX idx_capi_logs_retry_next ON capi_logs(response_status, next_retry_at, sent_at ASC) WHERE response_status IN (429, 500, 502, 503, 504);

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
CREATE INDEX idx_data_reports_tenant_lead_created ON data_reports(tenant_id, lead_id, created_at DESC);

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
    tx_type VARCHAR(40) NOT NULL CHECK (tx_type IN ('topup', 'subscription_purchase', 'renewal', 'plan_upgrade', 'plan_downgrade', 'plan_switch', 'package_switch', 'refund', 'cancellation', 'proration_credit', 'reactivation', 'webhook_payment', 'crm_erp_upgrade', 'admin_grant')),
    plan_code VARCHAR(80),
    billing_cycle VARCHAR(30),
    months_added INTEGER NOT NULL DEFAULT 0,
    amount_vnd BIGINT NOT NULL DEFAULT 0,
    proration_credit_vnd BIGINT NOT NULL DEFAULT 0,
    discount_pct NUMERIC(5,2) NOT NULL DEFAULT 0,
    payment_method VARCHAR(40) NOT NULL DEFAULT 'bank_transfer',
    provider VARCHAR(40) NOT NULL DEFAULT 'manual_bank_transfer',
    external_tx_id VARCHAR(160),
    idempotency_key VARCHAR(120),
    status VARCHAR(30) NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected', 'completed', 'failed', 'cancelled', 'refunded', 'expired')),
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
CREATE INDEX IF NOT EXISTS idx_billing_tx_tenant_status_created ON tenant_billing_transactions(tenant_id, status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_billing_tx_tenant_type_created ON tenant_billing_transactions(tenant_id, tx_type, created_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS idx_billing_tx_tenant_idempotency ON tenant_billing_transactions(tenant_id, idempotency_key) WHERE idempotency_key IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_billing_tx_provider_ext ON tenant_billing_transactions(provider, external_tx_id) WHERE provider IS NOT NULL AND external_tx_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_billing_tx_reference_code ON tenant_billing_transactions(reference_code) WHERE reference_code IS NOT NULL;

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
CREATE INDEX IF NOT EXISTS idx_meta_ads_tenant_ad_stop ON meta_ads_insights(tenant_id, ad_id, date_stop DESC);

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

-- =============================================================================

-- SECTION 11: WAVE 2 & FULL-CLONE MODULE SCHEMAS (HRM, MARKETING, ERP OPS, DOM AGENT, ATTENDANCE, ORG-RBAC, CRM-360)

-- =============================================================================


DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'autodata_app') THEN
    CREATE ROLE autodata_app NOLOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE;
  END IF;
EXCEPTION WHEN insufficient_privilege THEN NULL;
END $$;

ALTER TABLE tenant_branches ADD COLUMN IF NOT EXISTS manager_user_id UUID;

    -- ========================================================================
    -- 1. DYNAMIC N-STEP APPROVAL ENGINE TABLES
    -- ========================================================================
    CREATE TABLE IF NOT EXISTS tenant_approval_workflows (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
      code VARCHAR(80) NOT NULL,
      name VARCHAR(200) NOT NULL,
      description TEXT,
      category VARCHAR(40) NOT NULL DEFAULT 'leave'
        CHECK (category IN ('leave', 'overtime', 'cash_advance', 'expense', 'purchase_order', 'sales_order', 'contract', 'custom_form', 'attendance_explanation')),
      form_schema JSONB NOT NULL DEFAULT '[]'::jsonb,
      icon_name VARCHAR(60) NOT NULL DEFAULT 'FileCheck',
      color_hex VARCHAR(20) NOT NULL DEFAULT '#1E40FF',
      require_attachment BOOLEAN NOT NULL DEFAULT false,
      auto_approve_if_creator_is_approver BOOLEAN NOT NULL DEFAULT true,
      is_active BOOLEAN NOT NULL DEFAULT true,
      created_by UUID,
      created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
      CONSTRAINT uk_tenant_approval_workflows_tenant_id UNIQUE (tenant_id, id),
      CONSTRAINT uk_tenant_approval_workflows_code UNIQUE (tenant_id, code)
    );
    CREATE INDEX IF NOT EXISTS idx_appr_wf_tenant_cat ON tenant_approval_workflows(tenant_id, category, is_active);

    CREATE TABLE IF NOT EXISTS tenant_approval_workflow_steps (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
      workflow_id UUID NOT NULL,
      step_order INTEGER NOT NULL DEFAULT 1,
      step_name VARCHAR(160) NOT NULL,
      approver_type VARCHAR(40) NOT NULL DEFAULT 'direct_manager'
        CHECK (approver_type IN ('direct_manager', 'team_leader', 'department_head', 'parent_department_head', 'branch_director', 'specific_role', 'specific_user')),
      approver_role_id UUID,
      approver_user_id UUID,
      min_amount_threshold NUMERIC(18,2) NOT NULL DEFAULT 0,
      max_amount_threshold NUMERIC(18,2),
      approval_mode VARCHAR(30) NOT NULL DEFAULT 'any_one'
        CHECK (approval_mode IN ('any_one', 'all_must_approve')),
      fallback_strategy VARCHAR(40) NOT NULL DEFAULT 'tenant_admin'
        CHECK (fallback_strategy IN ('escalate_parent_dept', 'tenant_admin')),
      sla_hours INTEGER NOT NULL DEFAULT 24,
      require_signature BOOLEAN NOT NULL DEFAULT false,
      created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
      CONSTRAINT uk_tenant_approval_workflow_steps_tenant_id UNIQUE (tenant_id, id),
      CONSTRAINT fk_appr_step_workflow FOREIGN KEY (tenant_id, workflow_id)
        REFERENCES tenant_approval_workflows(tenant_id, id) ON DELETE CASCADE,
      CONSTRAINT fk_appr_step_role FOREIGN KEY (tenant_id, approver_role_id)
        REFERENCES tenant_roles(tenant_id, id) ON DELETE SET NULL,
      CONSTRAINT fk_appr_step_user FOREIGN KEY (tenant_id, approver_user_id)
        REFERENCES users(tenant_id, id) ON DELETE SET NULL
    );
    CREATE INDEX IF NOT EXISTS idx_appr_steps_wf_order ON tenant_approval_workflow_steps(tenant_id, workflow_id, step_order ASC);

    CREATE TABLE IF NOT EXISTS tenant_approval_delegations (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
      delegator_user_id UUID NOT NULL,
      delegate_user_id UUID NOT NULL,
      categories JSONB NOT NULL DEFAULT '[]'::jsonb,
      valid_from TIMESTAMPTZ NOT NULL,
      valid_until TIMESTAMPTZ NOT NULL,
      reason TEXT,
      is_active BOOLEAN NOT NULL DEFAULT true,
      created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
      CONSTRAINT uk_tenant_approval_delegations_tenant_id UNIQUE (tenant_id, id),
      CONSTRAINT fk_appr_delegator FOREIGN KEY (tenant_id, delegator_user_id)
        REFERENCES users(tenant_id, id) ON DELETE CASCADE,
      CONSTRAINT fk_appr_delegate FOREIGN KEY (tenant_id, delegate_user_id)
        REFERENCES users(tenant_id, id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_appr_delegations_lookup ON tenant_approval_delegations(tenant_id, delegator_user_id, is_active);

    CREATE TABLE IF NOT EXISTS tenant_approval_requests (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
      request_code VARCHAR(50) NOT NULL,
      workflow_id UUID NOT NULL,
      category VARCHAR(40) NOT NULL,
      title VARCHAR(255) NOT NULL,
      description TEXT,
      requester_user_id UUID NOT NULL,
      amount_vnd NUMERIC(18,2) NOT NULL DEFAULT 0,
      currency VARCHAR(10) NOT NULL DEFAULT 'VND',
      start_date TIMESTAMPTZ,
      end_date TIMESTAMPTZ,
      form_data JSONB NOT NULL DEFAULT '{}'::jsonb,
      attachments JSONB NOT NULL DEFAULT '[]'::jsonb,
      status VARCHAR(30) NOT NULL DEFAULT 'pending'
        CHECK (status IN ('draft', 'pending', 'approved', 'rejected', 'returned', 'cancelled')),
      current_step_order INTEGER NOT NULL DEFAULT 1,
      total_steps INTEGER NOT NULL DEFAULT 1,
      resolved_steps_snapshot JSONB NOT NULL DEFAULT '[]'::jsonb,
      linked_entity_type VARCHAR(60),
      linked_entity_id UUID,
      submitted_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
      completed_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
      CONSTRAINT uk_tenant_approval_requests_tenant_id UNIQUE (tenant_id, id),
      CONSTRAINT uk_tenant_approval_requests_code UNIQUE (tenant_id, request_code),
      CONSTRAINT fk_appr_req_workflow FOREIGN KEY (tenant_id, workflow_id)
        REFERENCES tenant_approval_workflows(tenant_id, id) ON DELETE RESTRICT,
      CONSTRAINT fk_appr_req_requester FOREIGN KEY (tenant_id, requester_user_id)
        REFERENCES users(tenant_id, id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_appr_req_tenant_status ON tenant_approval_requests(tenant_id, status, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_appr_req_requester ON tenant_approval_requests(tenant_id, requester_user_id, created_at DESC);

    CREATE TABLE IF NOT EXISTS tenant_approval_step_logs (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
      request_id UUID NOT NULL,
      step_id UUID,
      step_order INTEGER NOT NULL,
      step_name VARCHAR(160) NOT NULL,
      approval_mode VARCHAR(30) NOT NULL DEFAULT 'any_one',
      assigned_user_id UUID NOT NULL,
      original_approver_user_id UUID,
      delegated_from_user_id UUID,
      status VARCHAR(30) NOT NULL DEFAULT 'pending'
        CHECK (status IN ('pending', 'waiting', 'approved', 'rejected', 'returned', 'skipped')),
      action_comment TEXT,
      signature_data_url TEXT,
      due_at TIMESTAMPTZ,
      acted_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
      CONSTRAINT uk_tenant_approval_step_logs_tenant_id UNIQUE (tenant_id, id),
      CONSTRAINT fk_appr_log_request FOREIGN KEY (tenant_id, request_id)
        REFERENCES tenant_approval_requests(tenant_id, id) ON DELETE CASCADE,
      CONSTRAINT fk_appr_log_assigned_user FOREIGN KEY (tenant_id, assigned_user_id)
        REFERENCES users(tenant_id, id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_appr_step_logs_inbox ON tenant_approval_step_logs(tenant_id, assigned_user_id, status);
    CREATE INDEX IF NOT EXISTS idx_appr_step_logs_req ON tenant_approval_step_logs(tenant_id, request_id, step_order ASC);

    -- ========================================================================
    -- 2. HRM 360°, LABOR CONTRACTS, ASSETS & SMART 1-ON-1 BOOKING TABLES
    -- ========================================================================
    CREATE TABLE IF NOT EXISTS tenant_hr_employees (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
      user_id UUID,
      employee_code VARCHAR(50) NOT NULL,
      full_name VARCHAR(160) NOT NULL,
      work_email VARCHAR(255),
      phone VARCHAR(40),
      gender VARCHAR(20),
      date_of_birth DATE,
      nationality VARCHAR(80) NOT NULL DEFAULT 'Việt Nam',
      id_card_number VARCHAR(50),
      address TEXT,
      branch_id UUID,
      department_id UUID,
      team_id UUID,
      position_id UUID,
      manager_user_id UUID,
      employment_status VARCHAR(30) NOT NULL DEFAULT 'active'
        CHECK (employment_status IN ('probation', 'active', 'on_leave', 'resigned', 'terminated')),
      employment_type VARCHAR(30) NOT NULL DEFAULT 'full_time'
        CHECK (employment_type IN ('full_time', 'part_time', 'contractor', 'intern')),
      join_date DATE,
      resign_date DATE,
      base_salary_vnd NUMERIC(18,2) NOT NULL DEFAULT 0,
      insurance_salary_vnd NUMERIC(18,2) NOT NULL DEFAULT 0,
      insurance_enrolled BOOLEAN NOT NULL DEFAULT true,
      social_insurance_number VARCHAR(50),
      is_resident BOOLEAN NOT NULL DEFAULT true,
      tax_code VARCHAR(50),
      dependents_count INTEGER NOT NULL DEFAULT 0,
      union_member BOOLEAN NOT NULL DEFAULT false,
      allowances_json JSONB NOT NULL DEFAULT '{}'::jsonb,
      bank_name VARCHAR(120),
      bank_account_number VARCHAR(60),
      bank_account_holder VARCHAR(160),
      bank_branch VARCHAR(160),
      annual_leave_quota NUMERIC(6,2) NOT NULL DEFAULT 12,
      annual_leave_used NUMERIC(6,2) NOT NULL DEFAULT 0,
      compensatory_leave_balance NUMERIC(6,2) NOT NULL DEFAULT 0,
      digital_signature_data_url TEXT,
      metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
      created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
      CONSTRAINT uk_tenant_hr_employees_tenant_id UNIQUE (tenant_id, id),
      CONSTRAINT uk_tenant_hr_employees_code UNIQUE (tenant_id, employee_code),
      CONSTRAINT fk_hr_emp_user FOREIGN KEY (tenant_id, user_id)
        REFERENCES users(tenant_id, id) ON DELETE SET NULL,
      CONSTRAINT fk_hr_emp_branch FOREIGN KEY (tenant_id, branch_id)
        REFERENCES tenant_branches(tenant_id, id) ON DELETE SET NULL,
      CONSTRAINT fk_hr_emp_dept FOREIGN KEY (tenant_id, department_id)
        REFERENCES tenant_departments(tenant_id, id) ON DELETE SET NULL,
      CONSTRAINT fk_hr_emp_team FOREIGN KEY (tenant_id, team_id)
        REFERENCES tenant_teams(tenant_id, id) ON DELETE SET NULL,
      CONSTRAINT fk_hr_emp_pos FOREIGN KEY (tenant_id, position_id)
        REFERENCES tenant_positions(tenant_id, id) ON DELETE SET NULL,
      CONSTRAINT fk_hr_emp_mgr FOREIGN KEY (tenant_id, manager_user_id)
        REFERENCES users(tenant_id, id) ON DELETE SET NULL
    );
    CREATE INDEX IF NOT EXISTS idx_hr_emp_tenant_status ON tenant_hr_employees(tenant_id, employment_status);
    CREATE INDEX IF NOT EXISTS idx_hr_emp_user ON tenant_hr_employees(tenant_id, user_id);

    CREATE TABLE IF NOT EXISTS tenant_hr_contracts (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
      employee_id UUID NOT NULL,
      contract_number VARCHAR(80) NOT NULL,
      contract_type VARCHAR(30) NOT NULL DEFAULT 'fixed_term'
        CHECK (contract_type IN ('probation', 'fixed_term', 'indefinite', 'addendum', 'service')),
      status VARCHAR(30) NOT NULL DEFAULT 'active'
        CHECK (status IN ('draft', 'active', 'expired', 'terminated', 'superseded')),
      start_date DATE NOT NULL,
      end_date DATE,
      base_salary_vnd NUMERIC(18,2) NOT NULL DEFAULT 0,
      insurance_salary_vnd NUMERIC(18,2) NOT NULL DEFAULT 0,
      allowances_json JSONB NOT NULL DEFAULT '{}'::jsonb,
      working_schedule_note VARCHAR(255),
      signed_by_employee BOOLEAN NOT NULL DEFAULT false,
      employee_signature_url TEXT,
      signed_by_employer BOOLEAN NOT NULL DEFAULT false,
      employer_signer_name VARCHAR(160),
      signed_at TIMESTAMPTZ,
      notes TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
      CONSTRAINT uk_tenant_hr_contracts_tenant_id UNIQUE (tenant_id, id),
      CONSTRAINT uk_tenant_hr_contracts_number UNIQUE (tenant_id, contract_number),
      CONSTRAINT fk_hr_contract_emp FOREIGN KEY (tenant_id, employee_id)
        REFERENCES tenant_hr_employees(tenant_id, id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_hr_contracts_emp ON tenant_hr_contracts(tenant_id, employee_id, start_date DESC);

    CREATE TABLE IF NOT EXISTS tenant_hr_handover_assets (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
      employee_id UUID NOT NULL,
      asset_code VARCHAR(80) NOT NULL,
      asset_name VARCHAR(200) NOT NULL,
      category VARCHAR(60) NOT NULL DEFAULT 'laptop',
      serial_number VARCHAR(120),
      asset_value_vnd NUMERIC(18,2) NOT NULL DEFAULT 0,
      condition_on_handover VARCHAR(120) NOT NULL DEFAULT 'Mới 100%',
      status VARCHAR(30) NOT NULL DEFAULT 'assigned'
        CHECK (status IN ('assigned', 'returned', 'damaged', 'lost')),
      handed_over_at DATE NOT NULL DEFAULT CURRENT_DATE,
      returned_at DATE,
      acknowledged_by_employee BOOLEAN NOT NULL DEFAULT false,
      notes TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
      CONSTRAINT uk_tenant_hr_handover_assets_tenant_id UNIQUE (tenant_id, id),
      CONSTRAINT fk_hr_asset_emp FOREIGN KEY (tenant_id, employee_id)
        REFERENCES tenant_hr_employees(tenant_id, id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_hr_assets_emp ON tenant_hr_handover_assets(tenant_id, employee_id, status);

    CREATE TABLE IF NOT EXISTS tenant_booking_links (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
      host_user_id UUID,
      host_employee_id UUID,
      slug VARCHAR(120) NOT NULL,
      public_token VARCHAR(80) NOT NULL,
      title VARCHAR(200) NOT NULL,
      subtitle VARCHAR(255),
      description TEXT,
      meeting_purpose VARCHAR(60) NOT NULL DEFAULT 'consultation',
      duration_minutes INTEGER NOT NULL DEFAULT 30,
      buffer_minutes INTEGER NOT NULL DEFAULT 10,
      timezone VARCHAR(60) NOT NULL DEFAULT 'Asia/Ho_Chi_Minh',
      location_type VARCHAR(40) NOT NULL DEFAULT 'video_link',
      location_value VARCHAR(255),
      availability_rules JSONB NOT NULL DEFAULT '[]'::jsonb,
      custom_questions JSONB NOT NULL DEFAULT '[]'::jsonb,
      is_active BOOLEAN NOT NULL DEFAULT true,
      created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
      CONSTRAINT uk_tenant_booking_links_tenant_id UNIQUE (tenant_id, id),
      CONSTRAINT uk_tenant_booking_links_slug UNIQUE (slug),
      CONSTRAINT uk_tenant_booking_links_token UNIQUE (public_token),
      CONSTRAINT fk_booking_host_user FOREIGN KEY (tenant_id, host_user_id)
        REFERENCES users(tenant_id, id) ON DELETE SET NULL,
      CONSTRAINT fk_booking_host_emp FOREIGN KEY (tenant_id, host_employee_id)
        REFERENCES tenant_hr_employees(tenant_id, id) ON DELETE SET NULL
    );
    CREATE INDEX IF NOT EXISTS idx_booking_links_tenant ON tenant_booking_links(tenant_id, is_active);

    CREATE TABLE IF NOT EXISTS tenant_booking_appointments (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
      booking_link_id UUID NOT NULL,
      guest_name VARCHAR(160) NOT NULL,
      guest_email VARCHAR(255),
      guest_phone VARCHAR(40),
      guest_company VARCHAR(200),
      topic TEXT,
      answers_json JSONB NOT NULL DEFAULT '{}'::jsonb,
      booking_date DATE NOT NULL,
      start_time VARCHAR(10) NOT NULL,
      end_time VARCHAR(10) NOT NULL,
      status VARCHAR(30) NOT NULL DEFAULT 'confirmed'
        CHECK (status IN ('confirmed', 'completed', 'cancelled', 'no_show')),
      lead_id UUID,
      ics_uid VARCHAR(120),
      cancel_reason TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
      CONSTRAINT uk_tenant_booking_appointments_tenant_id UNIQUE (tenant_id, id),
      CONSTRAINT fk_booking_appt_link FOREIGN KEY (tenant_id, booking_link_id)
        REFERENCES tenant_booking_links(tenant_id, id) ON DELETE CASCADE,
      CONSTRAINT fk_booking_appt_lead FOREIGN KEY (tenant_id, lead_id)
        REFERENCES leads(tenant_id, id) ON DELETE SET NULL
    );
    CREATE INDEX IF NOT EXISTS idx_booking_appts_slot ON tenant_booking_appointments(tenant_id, booking_link_id, booking_date, start_time);

    -- ========================================================================
    -- 3. MULTI-TIER GPS + SELFIE ATTENDANCE & DYNAMIC SHIFTS TABLES
    -- ========================================================================
    CREATE TABLE IF NOT EXISTS tenant_hr_shifts (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
      code VARCHAR(50) NOT NULL,
      name VARCHAR(150) NOT NULL,
      start_time VARCHAR(10) NOT NULL DEFAULT '08:30',
      end_time VARCHAR(10) NOT NULL DEFAULT '17:30',
      break_start_time VARCHAR(10) DEFAULT '12:00',
      break_end_time VARCHAR(10) DEFAULT '13:00',
      break_minutes INTEGER NOT NULL DEFAULT 60,
      grace_late_minutes INTEGER NOT NULL DEFAULT 15,
      grace_early_leave_minutes INTEGER NOT NULL DEFAULT 15,
      min_half_day_hours NUMERIC(5,2) NOT NULL DEFAULT 4,
      standard_work_hours NUMERIC(5,2) NOT NULL DEFAULT 8,
      work_unit_value NUMERIC(5,2) NOT NULL DEFAULT 1,
      night_shift_multiplier NUMERIC(5,2) NOT NULL DEFAULT 1.3,
      overtime_multiplier NUMERIC(5,2) NOT NULL DEFAULT 1.5,
      weekend_overtime_multiplier NUMERIC(5,2) NOT NULL DEFAULT 2.0,
      holiday_overtime_multiplier NUMERIC(5,2) NOT NULL DEFAULT 3.0,
      require_gps BOOLEAN NOT NULL DEFAULT true,
      require_selfie BOOLEAN NOT NULL DEFAULT true,
      allow_out_of_geofence_with_explanation BOOLEAN NOT NULL DEFAULT true,
      working_days JSONB NOT NULL DEFAULT '[1,2,3,4,5]'::jsonb,
      is_default BOOLEAN NOT NULL DEFAULT false,
      is_active BOOLEAN NOT NULL DEFAULT true,
      created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
      CONSTRAINT uk_tenant_hr_shifts_tenant_id UNIQUE (tenant_id, id),
      CONSTRAINT uk_tenant_hr_shifts_code UNIQUE (tenant_id, code)
    );
    CREATE INDEX IF NOT EXISTS idx_hr_shifts_tenant ON tenant_hr_shifts(tenant_id, is_active);

    CREATE TABLE IF NOT EXISTS tenant_hr_shift_assignments (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
      shift_id UUID NOT NULL,
      employee_id UUID,
      user_id UUID,
      department_id UUID,
      branch_id UUID,
      effective_from DATE NOT NULL DEFAULT CURRENT_DATE,
      effective_to DATE,
      is_active BOOLEAN NOT NULL DEFAULT true,
      created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
      CONSTRAINT uk_tenant_hr_shift_assignments_tenant_id UNIQUE (tenant_id, id),
      CONSTRAINT fk_shift_assign_shift FOREIGN KEY (tenant_id, shift_id)
        REFERENCES tenant_hr_shifts(tenant_id, id) ON DELETE CASCADE,
      CONSTRAINT fk_shift_assign_emp FOREIGN KEY (tenant_id, employee_id)
        REFERENCES tenant_hr_employees(tenant_id, id) ON DELETE CASCADE,
      CONSTRAINT fk_shift_assign_user FOREIGN KEY (tenant_id, user_id)
        REFERENCES users(tenant_id, id) ON DELETE CASCADE,
      CONSTRAINT fk_shift_assign_dept FOREIGN KEY (tenant_id, department_id)
        REFERENCES tenant_departments(tenant_id, id) ON DELETE CASCADE,
      CONSTRAINT fk_shift_assign_branch FOREIGN KEY (tenant_id, branch_id)
        REFERENCES tenant_branches(tenant_id, id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_shift_assign_lookup ON tenant_hr_shift_assignments(tenant_id, user_id, employee_id, is_active);

    CREATE TABLE IF NOT EXISTS tenant_hr_attendance_logs (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
      user_id UUID NOT NULL,
      employee_id UUID,
      branch_id UUID,
      shift_id UUID,
      work_date DATE NOT NULL,
      attendance_code VARCHAR(10) NOT NULL DEFAULT 'X',
      check_in_at TIMESTAMPTZ,
      check_out_at TIMESTAMPTZ,
      latitude NUMERIC(10,7),
      longitude NUMERIC(10,7),
      checkout_latitude NUMERIC(10,7),
      checkout_longitude NUMERIC(10,7),
      distance_meters NUMERIC(12,2),
      checkout_distance_meters NUMERIC(12,2),
      within_geofence BOOLEAN NOT NULL DEFAULT true,
      selfie_data_url TEXT,
      checkout_selfie_data_url TEXT,
      device_info VARCHAR(255),
      late_minutes INTEGER NOT NULL DEFAULT 0,
      early_leave_minutes INTEGER NOT NULL DEFAULT 0,
      worked_hours NUMERIC(6,2) NOT NULL DEFAULT 0,
      overtime_hours NUMERIC(6,2) NOT NULL DEFAULT 0,
      work_units NUMERIC(5,2) NOT NULL DEFAULT 1,
      status VARCHAR(30) NOT NULL DEFAULT 'valid'
        CHECK (status IN ('valid', 'late', 'out_of_geofence', 'missing_checkout', 'explained', 'leave')),
      note TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
      CONSTRAINT uk_tenant_hr_attendance_logs_tenant_id UNIQUE (tenant_id, id),
      CONSTRAINT uk_hr_att_user_date UNIQUE (tenant_id, user_id, work_date),
      CONSTRAINT fk_att_log_user FOREIGN KEY (tenant_id, user_id)
        REFERENCES users(tenant_id, id) ON DELETE CASCADE,
      CONSTRAINT fk_att_log_emp FOREIGN KEY (tenant_id, employee_id)
        REFERENCES tenant_hr_employees(tenant_id, id) ON DELETE SET NULL,
      CONSTRAINT fk_att_log_branch FOREIGN KEY (tenant_id, branch_id)
        REFERENCES tenant_branches(tenant_id, id) ON DELETE SET NULL,
      CONSTRAINT fk_att_log_shift FOREIGN KEY (tenant_id, shift_id)
        REFERENCES tenant_hr_shifts(tenant_id, id) ON DELETE SET NULL
    );
    CREATE INDEX IF NOT EXISTS idx_hr_att_logs_month ON tenant_hr_attendance_logs(tenant_id, work_date DESC, user_id);

    CREATE TABLE IF NOT EXISTS tenant_hr_attendance_explanations (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
      attendance_log_id UUID,
      user_id UUID NOT NULL,
      employee_id UUID,
      work_date DATE NOT NULL,
      explanation_type VARCHAR(40) NOT NULL DEFAULT 'late_arrival'
        CHECK (explanation_type IN ('late_arrival', 'early_leave', 'forgot_checkin', 'forgot_checkout', 'out_of_geofence', 'business_trip')),
      requested_check_in VARCHAR(10),
      requested_check_out VARCHAR(10),
      requested_work_units NUMERIC(5,2) NOT NULL DEFAULT 1,
      reason TEXT NOT NULL,
      evidence_url TEXT,
      status VARCHAR(30) NOT NULL DEFAULT 'pending'
        CHECK (status IN ('pending', 'approved', 'rejected')),
      approval_request_id UUID,
      reviewed_by UUID,
      reviewed_at TIMESTAMPTZ,
      review_comment TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
      CONSTRAINT uk_tenant_hr_attendance_explanations_tenant_id UNIQUE (tenant_id, id),
      CONSTRAINT fk_att_exp_log FOREIGN KEY (tenant_id, attendance_log_id)
        REFERENCES tenant_hr_attendance_logs(tenant_id, id) ON DELETE SET NULL,
      CONSTRAINT fk_att_exp_user FOREIGN KEY (tenant_id, user_id)
        REFERENCES users(tenant_id, id) ON DELETE CASCADE,
      CONSTRAINT fk_att_exp_appr FOREIGN KEY (tenant_id, approval_request_id)
        REFERENCES tenant_approval_requests(tenant_id, id) ON DELETE SET NULL
    );
    CREATE INDEX IF NOT EXISTS idx_hr_att_exp_tenant ON tenant_hr_attendance_explanations(tenant_id, status, work_date DESC);

    -- ========================================================================
    -- 4. DYNAMIC PAYROLL, COMMISSIONS, PIT TAX, BHXH & HTKK ENGINE TABLES
    -- ========================================================================
    CREATE TABLE IF NOT EXISTS tenant_payroll_configs (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
      currency VARCHAR(10) NOT NULL DEFAULT 'VND',
      standard_workdays_mode VARCHAR(20) NOT NULL DEFAULT 'calendar',
      fixed_standard_workdays NUMERIC(5,2) NOT NULL DEFAULT 22,
      saturday_work_mode VARCHAR(20) NOT NULL DEFAULT 'off'
        CHECK (saturday_work_mode IN ('off', 'half', 'full')),
      emp_bhxh_rate NUMERIC(6,4) NOT NULL DEFAULT 0.0800,
      emp_bhyt_rate NUMERIC(6,4) NOT NULL DEFAULT 0.0150,
      emp_bhtn_rate NUMERIC(6,4) NOT NULL DEFAULT 0.0100,
      er_bhxh_rate NUMERIC(6,4) NOT NULL DEFAULT 0.1750,
      er_bhyt_rate NUMERIC(6,4) NOT NULL DEFAULT 0.0300,
      er_bhtn_rate NUMERIC(6,4) NOT NULL DEFAULT 0.0100,
      er_union_rate NUMERIC(6,4) NOT NULL DEFAULT 0.0200,
      emp_union_rate NUMERIC(6,4) NOT NULL DEFAULT 0.0100,
      bhxh_salary_cap_vnd NUMERIC(18,2) NOT NULL DEFAULT 46800000,
      bhtn_salary_cap_vnd NUMERIC(18,2) NOT NULL DEFAULT 99200000,
      personal_deduction_vnd NUMERIC(18,2) NOT NULL DEFAULT 11000000,
      dependent_deduction_vnd NUMERIC(18,2) NOT NULL DEFAULT 4400000,
      meal_allowance_exempt_cap_vnd NUMERIC(18,2) NOT NULL DEFAULT 730000,
      non_resident_flat_tax_rate NUMERIC(6,4) NOT NULL DEFAULT 0.2000,
      casual_withholding_threshold_vnd NUMERIC(18,2) NOT NULL DEFAULT 2000000,
      casual_flat_tax_rate NUMERIC(6,4) NOT NULL DEFAULT 0.1000,
      pit_brackets JSONB NOT NULL DEFAULT '[{"up_to":5000000,"rate":0.05},{"up_to":10000000,"rate":0.10},{"up_to":18000000,"rate":0.15},{"up_to":32000000,"rate":0.20},{"up_to":52000000,"rate":0.25},{"up_to":80000000,"rate":0.30},{"up_to":null,"rate":0.35}]'::jsonb,
      allowance_definitions JSONB NOT NULL DEFAULT '[{"key":"meal","name":"Phụ cấp ăn trưa","tax_mode":"meal_cap","prorate":true,"include_insurance":false},{"key":"responsibility","name":"Phụ cấp trách nhiệm","tax_mode":"taxable","prorate":true,"include_insurance":true},{"key":"transport","name":"Phụ cấp xăng xe & điện thoại","tax_mode":"taxable","prorate":true,"include_insurance":false}]'::jsonb,
      tax_authority_code VARCHAR(40),
      tax_authority_name VARCHAR(200),
      updated_by UUID,
      created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
      CONSTRAINT uk_tenant_payroll_configs_tenant_id UNIQUE (tenant_id, id),
      CONSTRAINT uk_tenant_payroll_configs_one UNIQUE (tenant_id)
    );

    CREATE TABLE IF NOT EXISTS tenant_payroll_periods (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
      period_key VARCHAR(10) NOT NULL,
      year INTEGER NOT NULL,
      month INTEGER NOT NULL,
      title VARCHAR(200) NOT NULL,
      branch_id UUID,
      standard_workdays NUMERIC(5,2) NOT NULL DEFAULT 22,
      status VARCHAR(30) NOT NULL DEFAULT 'draft'
        CHECK (status IN ('draft', 'calculated', 'pending_approval', 'approved', 'paid', 'locked')),
      employee_count INTEGER NOT NULL DEFAULT 0,
      total_gross_vnd NUMERIC(18,2) NOT NULL DEFAULT 0,
      total_emp_insurance_vnd NUMERIC(18,2) NOT NULL DEFAULT 0,
      total_er_insurance_vnd NUMERIC(18,2) NOT NULL DEFAULT 0,
      total_pit_tax_vnd NUMERIC(18,2) NOT NULL DEFAULT 0,
      total_commission_vnd NUMERIC(18,2) NOT NULL DEFAULT 0,
      total_net_vnd NUMERIC(18,2) NOT NULL DEFAULT 0,
      approval_request_id UUID,
      approved_by UUID,
      approved_at TIMESTAMPTZ,
      created_by UUID,
      created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
      CONSTRAINT uk_tenant_payroll_periods_tenant_id UNIQUE (tenant_id, id),
      CONSTRAINT uk_tenant_payroll_periods_ym UNIQUE (tenant_id, period_key),
      CONSTRAINT fk_payroll_period_branch FOREIGN KEY (tenant_id, branch_id)
        REFERENCES tenant_branches(tenant_id, id) ON DELETE SET NULL
    );
    CREATE INDEX IF NOT EXISTS idx_payroll_periods_tenant ON tenant_payroll_periods(tenant_id, year DESC, month DESC);

    CREATE TABLE IF NOT EXISTS tenant_payroll_slips (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
      period_id UUID NOT NULL,
      employee_id UUID NOT NULL,
      user_id UUID,
      standard_workdays NUMERIC(5,2) NOT NULL DEFAULT 22,
      actual_workdays NUMERIC(5,2) NOT NULL DEFAULT 22,
      paid_leave_days NUMERIC(5,2) NOT NULL DEFAULT 0,
      unpaid_leave_days NUMERIC(5,2) NOT NULL DEFAULT 0,
      overtime_hours NUMERIC(6,2) NOT NULL DEFAULT 0,
      base_salary_vnd NUMERIC(18,2) NOT NULL DEFAULT 0,
      prorated_base_pay_vnd NUMERIC(18,2) NOT NULL DEFAULT 0,
      allowances_vnd NUMERIC(18,2) NOT NULL DEFAULT 0,
      tax_exempt_vnd NUMERIC(18,2) NOT NULL DEFAULT 0,
      overtime_pay_vnd NUMERIC(18,2) NOT NULL DEFAULT 0,
      commission_pay_vnd NUMERIC(18,2) NOT NULL DEFAULT 0,
      bonus_vnd NUMERIC(18,2) NOT NULL DEFAULT 0,
      gross_pay_vnd NUMERIC(18,2) NOT NULL DEFAULT 0,
      insurance_salary_base_vnd NUMERIC(18,2) NOT NULL DEFAULT 0,
      emp_bhxh_vnd NUMERIC(18,2) NOT NULL DEFAULT 0,
      emp_bhyt_vnd NUMERIC(18,2) NOT NULL DEFAULT 0,
      emp_bhtn_vnd NUMERIC(18,2) NOT NULL DEFAULT 0,
      emp_union_vnd NUMERIC(18,2) NOT NULL DEFAULT 0,
      er_insurance_total_vnd NUMERIC(18,2) NOT NULL DEFAULT 0,
      dependents_count INTEGER NOT NULL DEFAULT 0,
      family_deduction_vnd NUMERIC(18,2) NOT NULL DEFAULT 0,
      taxable_income_vnd NUMERIC(18,2) NOT NULL DEFAULT 0,
      assessable_income_vnd NUMERIC(18,2) NOT NULL DEFAULT 0,
      pit_tax_vnd NUMERIC(18,2) NOT NULL DEFAULT 0,
      advance_deduction_vnd NUMERIC(18,2) NOT NULL DEFAULT 0,
      other_deduction_vnd NUMERIC(18,2) NOT NULL DEFAULT 0,
      net_pay_vnd NUMERIC(18,2) NOT NULL DEFAULT 0,
      tax_method VARCHAR(40) NOT NULL DEFAULT 'progressive',
      payment_status VARCHAR(30) NOT NULL DEFAULT 'unpaid'
        CHECK (payment_status IN ('unpaid', 'paid')),
      breakdown JSONB NOT NULL DEFAULT '{}'::jsonb,
      created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
      CONSTRAINT uk_tenant_payroll_slips_tenant_id UNIQUE (tenant_id, id),
      CONSTRAINT uk_payroll_slip_period_emp UNIQUE (tenant_id, period_id, employee_id),
      CONSTRAINT fk_payroll_slip_period FOREIGN KEY (tenant_id, period_id)
        REFERENCES tenant_payroll_periods(tenant_id, id) ON DELETE CASCADE,
      CONSTRAINT fk_payroll_slip_emp FOREIGN KEY (tenant_id, employee_id)
        REFERENCES tenant_hr_employees(tenant_id, id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_payroll_slips_period ON tenant_payroll_slips(tenant_id, period_id);
    CREATE INDEX IF NOT EXISTS idx_payroll_slips_user ON tenant_payroll_slips(tenant_id, user_id);

    CREATE TABLE IF NOT EXISTS tenant_commission_rules (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
      name VARCHAR(160) NOT NULL,
      description TEXT,
      applies_to_role_id UUID,
      applies_to_department_id UUID,
      rule_type VARCHAR(30) NOT NULL DEFAULT 'percentage_revenue'
        CHECK (rule_type IN ('percentage_revenue', 'tiered_revenue', 'fixed_per_won_lead')),
      flat_rate_pct NUMERIC(7,4) NOT NULL DEFAULT 3.0000,
      fixed_amount_vnd NUMERIC(18,2) NOT NULL DEFAULT 0,
      tiers_json JSONB NOT NULL DEFAULT '[]'::jsonb,
      min_revenue_threshold_vnd NUMERIC(18,2) NOT NULL DEFAULT 0,
      is_active BOOLEAN NOT NULL DEFAULT true,
      created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
      CONSTRAINT uk_tenant_commission_rules_tenant_id UNIQUE (tenant_id, id),
      CONSTRAINT fk_comm_rule_role FOREIGN KEY (tenant_id, applies_to_role_id)
        REFERENCES tenant_roles(tenant_id, id) ON DELETE SET NULL,
      CONSTRAINT fk_comm_rule_dept FOREIGN KEY (tenant_id, applies_to_department_id)
        REFERENCES tenant_departments(tenant_id, id) ON DELETE SET NULL
    );
    CREATE INDEX IF NOT EXISTS idx_comm_rules_tenant ON tenant_commission_rules(tenant_id, is_active);

    CREATE TABLE IF NOT EXISTS tenant_commission_ledgers (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
      period_key VARCHAR(10) NOT NULL,
      employee_id UUID,
      user_id UUID NOT NULL,
      rule_id UUID,
      lead_id UUID,
      source_title VARCHAR(255) NOT NULL,
      revenue_base_vnd NUMERIC(18,2) NOT NULL DEFAULT 0,
      commission_amount_vnd NUMERIC(18,2) NOT NULL DEFAULT 0,
      status VARCHAR(30) NOT NULL DEFAULT 'approved'
        CHECK (status IN ('pending', 'approved', 'paid', 'cancelled')),
      notes TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
      CONSTRAINT uk_tenant_commission_ledgers_tenant_id UNIQUE (tenant_id, id),
      CONSTRAINT fk_comm_ledger_emp FOREIGN KEY (tenant_id, employee_id)
        REFERENCES tenant_hr_employees(tenant_id, id) ON DELETE SET NULL,
      CONSTRAINT fk_comm_ledger_user FOREIGN KEY (tenant_id, user_id)
        REFERENCES users(tenant_id, id) ON DELETE CASCADE,
      CONSTRAINT fk_comm_ledger_rule FOREIGN KEY (tenant_id, rule_id)
        REFERENCES tenant_commission_rules(tenant_id, id) ON DELETE SET NULL,
      CONSTRAINT fk_comm_ledger_lead FOREIGN KEY (tenant_id, lead_id)
        REFERENCES leads(tenant_id, id) ON DELETE SET NULL
    );
    CREATE INDEX IF NOT EXISTS idx_comm_ledgers_period ON tenant_commission_ledgers(tenant_id, period_key, user_id);

    ALTER TABLE tenant_payroll_slips ADD COLUMN IF NOT EXISTS signed_by_employee BOOLEAN NOT NULL DEFAULT false;
    ALTER TABLE tenant_payroll_slips ADD COLUMN IF NOT EXISTS employee_signature_url TEXT;
    ALTER TABLE tenant_payroll_slips ADD COLUMN IF NOT EXISTS employee_signed_at TIMESTAMPTZ;
    ALTER TABLE tenant_payroll_slips ADD COLUMN IF NOT EXISTS dispute_status VARCHAR(30);
    ALTER TABLE tenant_payroll_slips ADD COLUMN IF NOT EXISTS dispute_note TEXT;
    ALTER TABLE tenant_payroll_slips ADD COLUMN IF NOT EXISTS disputed_at TIMESTAMPTZ;

    CREATE TABLE IF NOT EXISTS tenant_cooperation_slips (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
      slip_code VARCHAR(80),
      title VARCHAR(255) NOT NULL,
      lead_id UUID,
      deal_id UUID,
      partner_name VARCHAR(255),
      partner_contact VARCHAR(120),
      commission_pct NUMERIC(5,2) NOT NULL DEFAULT 0,
      estimated_value_vnd NUMERIC(18,2) NOT NULL DEFAULT 0,
      status VARCHAR(30) NOT NULL DEFAULT 'pending_signatures',
      terms_text TEXT,
      line_items_json JSONB NOT NULL DEFAULT '[]'::jsonb,
      owner_user_id UUID,
      approved_by UUID,
      unit_code VARCHAR(80),
      project_name VARCHAR(200),
      expected_commission_vnd NUMERIC(18,2) NOT NULL DEFAULT 0,
      total_percentage NUMERIC(6,2) NOT NULL DEFAULT 100,
      dispute_details TEXT,
      approved_at TIMESTAMPTZ,
      metadata_json JSONB NOT NULL DEFAULT '{}'::jsonb,
      created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
    );
    ALTER TABLE tenant_cooperation_slips ADD COLUMN IF NOT EXISTS unit_code VARCHAR(80);
    ALTER TABLE tenant_cooperation_slips ADD COLUMN IF NOT EXISTS project_name VARCHAR(200);
    ALTER TABLE tenant_cooperation_slips ADD COLUMN IF NOT EXISTS expected_commission_vnd NUMERIC(18,2) NOT NULL DEFAULT 0;
    ALTER TABLE tenant_cooperation_slips ADD COLUMN IF NOT EXISTS total_percentage NUMERIC(6,2) NOT NULL DEFAULT 100;
    ALTER TABLE tenant_cooperation_slips ADD COLUMN IF NOT EXISTS dispute_details TEXT;
    ALTER TABLE tenant_cooperation_slips ADD COLUMN IF NOT EXISTS approved_at TIMESTAMPTZ;
    ALTER TABLE tenant_cooperation_slips ADD COLUMN IF NOT EXISTS metadata_json JSONB NOT NULL DEFAULT '{}'::jsonb;
    CREATE INDEX IF NOT EXISTS idx_coop_slips_status ON tenant_cooperation_slips(tenant_id, status);

    CREATE TABLE IF NOT EXISTS tenant_accounting_az_workspace (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
      fiscal_period VARCHAR(20) NOT NULL,
      account_code VARCHAR(40) NOT NULL DEFAULT '111',
      account_name VARCHAR(200) NOT NULL DEFAULT 'Tiền mặt',
      voucher_no VARCHAR(80),
      entry_type VARCHAR(30) NOT NULL DEFAULT 'journal',
      debit_vnd NUMERIC(18,2) NOT NULL DEFAULT 0,
      credit_vnd NUMERIC(18,2) NOT NULL DEFAULT 0,
      balance_vnd NUMERIC(18,2) NOT NULL DEFAULT 0,
      tax_period VARCHAR(20),
      analytics_json JSONB NOT NULL DEFAULT '{}'::jsonb,
      extra_json JSONB NOT NULL DEFAULT '{}'::jsonb,
      created_by UUID,
      created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
    );
    CREATE INDEX IF NOT EXISTS idx_acc_az_period ON tenant_accounting_az_workspace(tenant_id, fiscal_period, account_code);

    -- ========================================================================
    -- 5. FORCE ROW LEVEL SECURITY + POLICIES + GRANTS ON ALL 21 TABLES
    -- ========================================================================
    DO $$
    DECLARE
      tbl TEXT;
      pol TEXT;
    BEGIN
      FOREACH tbl IN ARRAY ARRAY[
        'tenant_approval_workflows',
        'tenant_approval_workflow_steps',
        'tenant_approval_delegations',
        'tenant_approval_requests',
        'tenant_approval_step_logs',
        'tenant_hr_employees',
        'tenant_hr_contracts',
        'tenant_hr_handover_assets',
        'tenant_booking_links',
        'tenant_booking_appointments',
        'tenant_hr_shifts',
        'tenant_hr_shift_assignments',
        'tenant_hr_attendance_logs',
        'tenant_hr_attendance_explanations',
        'tenant_payroll_configs',
        'tenant_payroll_periods',
        'tenant_payroll_slips',
        'tenant_commission_rules',
        'tenant_commission_ledgers',
        'tenant_cooperation_slips',
        'tenant_accounting_az_workspace'
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
          'tenant_approval_workflows',
          'tenant_approval_workflow_steps',
          'tenant_approval_delegations',
          'tenant_approval_requests',
          'tenant_approval_step_logs',
          'tenant_hr_employees',
          'tenant_hr_contracts',
          'tenant_hr_handover_assets',
          'tenant_booking_links',
          'tenant_booking_appointments',
          'tenant_hr_shifts',
          'tenant_hr_shift_assignments',
          'tenant_hr_attendance_logs',
          'tenant_hr_attendance_explanations',
          'tenant_payroll_configs',
          'tenant_payroll_periods',
          'tenant_payroll_slips',
          'tenant_commission_rules',
          'tenant_commission_ledgers',
          'tenant_cooperation_slips',
          'tenant_accounting_az_workspace'
        ]
        LOOP
          EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON %I TO autodata_app', tbl);
        END LOOP;
      END IF;
    EXCEPTION
      WHEN insufficient_privilege THEN
        NULL;
    END $$;

CREATE TABLE IF NOT EXISTS mkt_template_groups (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    name VARCHAR(150) NOT NULL,
    description TEXT,
    color_hex VARCHAR(20) NOT NULL DEFAULT '#1E40FF',
    created_by UUID,
    created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    CONSTRAINT uk_mkt_template_groups_tenant_id UNIQUE (tenant_id, id)
  );
  CREATE INDEX IF NOT EXISTS idx_mkt_tpl_groups_tenant ON mkt_template_groups(tenant_id, created_at DESC);

  CREATE TABLE IF NOT EXISTS mkt_email_templates (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    group_id UUID,
    name VARCHAR(200) NOT NULL,
    subject VARCHAR(255) NOT NULL DEFAULT '',
    preheader VARCHAR(255) NOT NULL DEFAULT '',
    category VARCHAR(60) NOT NULL DEFAULT 'general',
    blocks_json JSONB NOT NULL DEFAULT '[]'::jsonb,
    body_style JSONB NOT NULL DEFAULT '{}'::jsonb,
    compiled_html TEXT NOT NULL DEFAULT '',
    spam_score INTEGER NOT NULL DEFAULT 0,
    merge_tags JSONB NOT NULL DEFAULT '[]'::jsonb,
    visibility VARCHAR(30) NOT NULL DEFAULT 'company',
    status VARCHAR(30) NOT NULL DEFAULT 'active',
    created_by UUID,
    created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    CONSTRAINT uk_mkt_email_templates_tenant_id UNIQUE (tenant_id, id),
    CONSTRAINT fk_mkt_tpl_group FOREIGN KEY (tenant_id, group_id) REFERENCES mkt_template_groups(tenant_id, id) ON DELETE SET NULL
  );
  CREATE INDEX IF NOT EXISTS idx_mkt_email_templates_tenant ON mkt_email_templates(tenant_id, status, updated_at DESC);

  CREATE TABLE IF NOT EXISTS mkt_forms (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    name VARCHAR(200) NOT NULL,
    description TEXT,
    public_token VARCHAR(80) NOT NULL UNIQUE,
    status VARCHAR(30) NOT NULL DEFAULT 'active',
    routing_mode VARCHAR(40) NOT NULL DEFAULT 'marketing_nurture' CHECK (routing_mode IN ('marketing_nurture', 'sale_round')),
    target_audience_id UUID,
    distribution_round_id UUID,
    require_otp BOOLEAN NOT NULL DEFAULT false,
    otp_channel VARCHAR(20) NOT NULL DEFAULT 'email',
    fields_json JSONB NOT NULL DEFAULT '[]'::jsonb,
    theme_json JSONB NOT NULL DEFAULT '{}'::jsonb,
    thank_you_json JSONB NOT NULL DEFAULT '{}'::jsonb,
    submission_count INTEGER NOT NULL DEFAULT 0,
    created_by UUID,
    created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    CONSTRAINT uk_mkt_forms_tenant_id UNIQUE (tenant_id, id),
    CONSTRAINT fk_mkt_forms_audience FOREIGN KEY (tenant_id, target_audience_id) REFERENCES tenant_audiences(tenant_id, id) ON DELETE SET NULL,
    CONSTRAINT fk_mkt_forms_round FOREIGN KEY (tenant_id, distribution_round_id) REFERENCES distribution_rounds(tenant_id, id) ON DELETE SET NULL
  );
  CREATE INDEX IF NOT EXISTS idx_mkt_forms_tenant ON mkt_forms(tenant_id, status, created_at DESC);

  CREATE TABLE IF NOT EXISTS mkt_form_submissions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    form_id UUID NOT NULL,
    lead_id UUID,
    routing_mode VARCHAR(40) NOT NULL DEFAULT 'marketing_nurture',
    submitted_data JSONB NOT NULL DEFAULT '{}'::jsonb,
    utm_data JSONB NOT NULL DEFAULT '{}'::jsonb,
    otp_verified BOOLEAN NOT NULL DEFAULT false,
    client_ip VARCHAR(64),
    created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    CONSTRAINT uk_mkt_form_submissions_tenant_id UNIQUE (tenant_id, id),
    CONSTRAINT fk_mkt_sub_form FOREIGN KEY (tenant_id, form_id) REFERENCES mkt_forms(tenant_id, id) ON DELETE CASCADE,
    CONSTRAINT fk_mkt_sub_lead FOREIGN KEY (tenant_id, lead_id) REFERENCES leads(tenant_id, id) ON DELETE SET NULL
  );
  CREATE INDEX IF NOT EXISTS idx_mkt_form_sub_lookup ON mkt_form_submissions(tenant_id, form_id, created_at DESC);

  CREATE TABLE IF NOT EXISTS mkt_custom_events (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    event_key VARCHAR(100) NOT NULL,
    event_name VARCHAR(200) NOT NULL,
    event_category VARCHAR(30) NOT NULL DEFAULT 'custom' CHECK (event_category IN ('custom', 'purchase', 'otp')),
    description TEXT,
    schema_json JSONB NOT NULL DEFAULT '{}'::jsonb,
    trigger_count INTEGER NOT NULL DEFAULT 0,
    total_revenue_vnd BIGINT NOT NULL DEFAULT 0,
    is_active BOOLEAN NOT NULL DEFAULT true,
    created_by UUID,
    created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    CONSTRAINT uk_mkt_custom_events_tenant_id UNIQUE (tenant_id, id),
    CONSTRAINT uk_mkt_custom_events_key UNIQUE (tenant_id, event_key)
  );
  CREATE INDEX IF NOT EXISTS idx_mkt_custom_events_tenant ON mkt_custom_events(tenant_id, event_category);

  CREATE TABLE IF NOT EXISTS mkt_otp_verifications (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    channel VARCHAR(20) NOT NULL DEFAULT 'email',
    recipient VARCHAR(255) NOT NULL,
    purpose VARCHAR(80) NOT NULL DEFAULT 'form_submit',
    code_hash VARCHAR(128) NOT NULL,
    attempts INTEGER NOT NULL DEFAULT 0,
    verified BOOLEAN NOT NULL DEFAULT false,
    expires_at TIMESTAMPTZ NOT NULL,
    verified_at TIMESTAMPTZ,
    consumed_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    CONSTRAINT uk_mkt_otp_verifications_tenant_id UNIQUE (tenant_id, id)
  );
  CREATE INDEX IF NOT EXISTS idx_mkt_otp_lookup ON mkt_otp_verifications(tenant_id, recipient, created_at DESC);

  CREATE TABLE IF NOT EXISTS mkt_surveys (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    title VARCHAR(255) NOT NULL,
    slug VARCHAR(120) NOT NULL,
    description TEXT,
    survey_type VARCHAR(30) NOT NULL DEFAULT 'survey' CHECK (survey_type IN ('survey', 'quiz', 'nps')),
    status VARCHAR(30) NOT NULL DEFAULT 'active',
    blocks_json JSONB NOT NULL DEFAULT '[]'::jsonb,
    theme_json JSONB NOT NULL DEFAULT '{}'::jsonb,
    settings_json JSONB NOT NULL DEFAULT '{}'::jsonb,
    response_count INTEGER NOT NULL DEFAULT 0,
    avg_score NUMERIC(6,2) NOT NULL DEFAULT 0,
    created_by UUID,
    created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    CONSTRAINT uk_mkt_surveys_tenant_id UNIQUE (tenant_id, id),
    CONSTRAINT uk_mkt_surveys_slug UNIQUE (tenant_id, slug)
  );
  CREATE INDEX IF NOT EXISTS idx_mkt_surveys_tenant ON mkt_surveys(tenant_id, status, created_at DESC);

  CREATE TABLE IF NOT EXISTS mkt_survey_responses (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    survey_id UUID NOT NULL,
    lead_id UUID,
    answers_json JSONB NOT NULL DEFAULT '{}'::jsonb,
    quiz_score INTEGER NOT NULL DEFAULT 0,
    nps_score INTEGER,
    tags_applied JSONB NOT NULL DEFAULT '[]'::jsonb,
    client_ip VARCHAR(64),
    created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    CONSTRAINT uk_mkt_survey_responses_tenant_id UNIQUE (tenant_id, id),
    CONSTRAINT fk_mkt_srv_resp_survey FOREIGN KEY (tenant_id, survey_id) REFERENCES mkt_surveys(tenant_id, id) ON DELETE CASCADE,
    CONSTRAINT fk_mkt_srv_resp_lead FOREIGN KEY (tenant_id, lead_id) REFERENCES leads(tenant_id, id) ON DELETE SET NULL
  );
  CREATE INDEX IF NOT EXISTS idx_mkt_srv_resp_lookup ON mkt_survey_responses(tenant_id, survey_id, created_at DESC);

  CREATE TABLE IF NOT EXISTS mkt_campaigns (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    name VARCHAR(255) NOT NULL,
    channel VARCHAR(30) NOT NULL DEFAULT 'email' CHECK (channel IN ('email', 'zns', 'multi')),
    status VARCHAR(30) NOT NULL DEFAULT 'draft',
    audience_id UUID,
    exclude_audience_ids JSONB NOT NULL DEFAULT '[]'::jsonb,
    template_id UUID,
    subject_a VARCHAR(255) NOT NULL DEFAULT '',
    subject_b VARCHAR(255) NOT NULL DEFAULT '',
    ab_split_ratio INTEGER NOT NULL DEFAULT 100,
    zns_template_id VARCHAR(120),
    sender_name VARCHAR(150),
    sender_email VARCHAR(255),
    reminder_config JSONB NOT NULL DEFAULT '{}'::jsonb,
    scheduled_at TIMESTAMPTZ,
    sent_at TIMESTAMPTZ,
    total_targeted INTEGER NOT NULL DEFAULT 0,
    sent_count INTEGER NOT NULL DEFAULT 0,
    opened_count INTEGER NOT NULL DEFAULT 0,
    clicked_count INTEGER NOT NULL DEFAULT 0,
    bounced_count INTEGER NOT NULL DEFAULT 0,
    unsubscribed_count INTEGER NOT NULL DEFAULT 0,
    cost_vnd BIGINT NOT NULL DEFAULT 0,
    attributed_revenue_vnd BIGINT NOT NULL DEFAULT 0,
    created_by UUID,
    created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    CONSTRAINT uk_mkt_campaigns_tenant_id UNIQUE (tenant_id, id),
    CONSTRAINT fk_mkt_camp_audience FOREIGN KEY (tenant_id, audience_id) REFERENCES tenant_audiences(tenant_id, id) ON DELETE SET NULL,
    CONSTRAINT fk_mkt_camp_template FOREIGN KEY (tenant_id, template_id) REFERENCES mkt_email_templates(tenant_id, id) ON DELETE SET NULL
  );
  CREATE INDEX IF NOT EXISTS idx_mkt_campaigns_tenant ON mkt_campaigns(tenant_id, status, created_at DESC);

  CREATE TABLE IF NOT EXISTS mkt_send_claims (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    campaign_id UUID NOT NULL,
    lead_id UUID NOT NULL,
    channel VARCHAR(20) NOT NULL DEFAULT 'email',
    variant VARCHAR(10) NOT NULL DEFAULT 'A',
    status VARCHAR(30) NOT NULL DEFAULT 'claimed',
    reminder_sent BOOLEAN NOT NULL DEFAULT false,
    claimed_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    sent_at TIMESTAMPTZ,
    opened_at TIMESTAMPTZ,
    clicked_at TIMESTAMPTZ,
    error_message TEXT,
    metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
    CONSTRAINT uk_mkt_send_claims_tenant_id UNIQUE (tenant_id, id),
    CONSTRAINT uk_mkt_send_claim_unique UNIQUE (tenant_id, campaign_id, lead_id, channel),
    CONSTRAINT fk_mkt_claim_campaign FOREIGN KEY (tenant_id, campaign_id) REFERENCES mkt_campaigns(tenant_id, id) ON DELETE CASCADE,
    CONSTRAINT fk_mkt_claim_lead FOREIGN KEY (tenant_id, lead_id) REFERENCES leads(tenant_id, id) ON DELETE CASCADE
  );
  CREATE INDEX IF NOT EXISTS idx_mkt_send_claims_campaign ON mkt_send_claims(tenant_id, campaign_id, status);

  CREATE TABLE IF NOT EXISTS mkt_suppression_list (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    channel VARCHAR(20) NOT NULL DEFAULT 'email',
    recipient VARCHAR(255) NOT NULL,
    reason VARCHAR(50) NOT NULL DEFAULT 'unsubscribed',
    source_campaign_id UUID,
    created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    CONSTRAINT uk_mkt_suppression_list_tenant_id UNIQUE (tenant_id, id),
    CONSTRAINT uk_mkt_suppression_unique UNIQUE (tenant_id, channel, recipient)
  );
  CREATE INDEX IF NOT EXISTS idx_mkt_suppression_tenant ON mkt_suppression_list(tenant_id, channel, created_at DESC);

  CREATE TABLE IF NOT EXISTS mkt_flows (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    name VARCHAR(255) NOT NULL,
    description TEXT,
    status VARCHAR(30) NOT NULL DEFAULT 'draft',
    trigger_type VARCHAR(60) NOT NULL DEFAULT 'form_submitted',
    trigger_config JSONB NOT NULL DEFAULT '{}'::jsonb,
    steps_json JSONB NOT NULL DEFAULT '[]'::jsonb,
    version INTEGER NOT NULL DEFAULT 1,
    enrolled_count INTEGER NOT NULL DEFAULT 0,
    completed_count INTEGER NOT NULL DEFAULT 0,
    pushed_to_sale_count INTEGER NOT NULL DEFAULT 0,
    attributed_revenue_vnd BIGINT NOT NULL DEFAULT 0,
    created_by UUID,
    created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    CONSTRAINT uk_mkt_flows_tenant_id UNIQUE (tenant_id, id)
  );
  CREATE INDEX IF NOT EXISTS idx_mkt_flows_tenant_trigger ON mkt_flows(tenant_id, status, trigger_type);

  CREATE TABLE IF NOT EXISTS mkt_flow_snapshots (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    flow_id UUID NOT NULL,
    version INTEGER NOT NULL,
    trigger_type VARCHAR(60) NOT NULL,
    trigger_config JSONB NOT NULL DEFAULT '{}'::jsonb,
    steps_json JSONB NOT NULL DEFAULT '[]'::jsonb,
    review_score INTEGER NOT NULL DEFAULT 100,
    published_by UUID,
    created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    CONSTRAINT uk_mkt_flow_snapshots_tenant_id UNIQUE (tenant_id, id),
    CONSTRAINT fk_mkt_snap_flow FOREIGN KEY (tenant_id, flow_id) REFERENCES mkt_flows(tenant_id, id) ON DELETE CASCADE
  );
  CREATE INDEX IF NOT EXISTS idx_mkt_flow_snap_lookup ON mkt_flow_snapshots(tenant_id, flow_id, version DESC);

  CREATE TABLE IF NOT EXISTS mkt_flow_enrollments (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    flow_id UUID NOT NULL,
    snapshot_version INTEGER NOT NULL DEFAULT 1,
    lead_id UUID NOT NULL,
    current_step_id VARCHAR(120),
    status VARCHAR(30) NOT NULL DEFAULT 'active',
    next_run_at TIMESTAMPTZ,
    execution_trace JSONB NOT NULL DEFAULT '[]'::jsonb,
    enrolled_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    completed_at TIMESTAMPTZ,
    CONSTRAINT uk_mkt_flow_enrollments_tenant_id UNIQUE (tenant_id, id),
    CONSTRAINT fk_mkt_enroll_flow FOREIGN KEY (tenant_id, flow_id) REFERENCES mkt_flows(tenant_id, id) ON DELETE CASCADE,
    CONSTRAINT fk_mkt_enroll_lead FOREIGN KEY (tenant_id, lead_id) REFERENCES leads(tenant_id, id) ON DELETE CASCADE
  );
  CREATE INDEX IF NOT EXISTS idx_mkt_flow_enroll_lookup ON mkt_flow_enrollments(tenant_id, flow_id, status);

  CREATE TABLE IF NOT EXISTS mkt_voucher_campaigns (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    name VARCHAR(255) NOT NULL,
    slug VARCHAR(120) NOT NULL,
    description TEXT,
    code_prefix VARCHAR(30) NOT NULL DEFAULT 'DOM',
    discount_type VARCHAR(30) NOT NULL DEFAULT 'percentage' CHECK (discount_type IN ('percentage', 'fixed_vnd', 'gift')),
    discount_value BIGINT NOT NULL DEFAULT 10,
    min_order_vnd BIGINT NOT NULL DEFAULT 0,
    max_uses_per_code INTEGER NOT NULL DEFAULT 1,
    expires_at TIMESTAMPTZ,
    status VARCHAR(30) NOT NULL DEFAULT 'active',
    total_codes INTEGER NOT NULL DEFAULT 0,
    claimed_codes INTEGER NOT NULL DEFAULT 0,
    redeemed_codes INTEGER NOT NULL DEFAULT 0,
    qr_design_json JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_by UUID,
    created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    CONSTRAINT uk_mkt_voucher_campaigns_tenant_id UNIQUE (tenant_id, id),
    CONSTRAINT uk_mkt_voucher_campaigns_slug UNIQUE (tenant_id, slug)
  );
  CREATE INDEX IF NOT EXISTS idx_mkt_voucher_camp_tenant ON mkt_voucher_campaigns(tenant_id, status, created_at DESC);

  CREATE TABLE IF NOT EXISTS mkt_voucher_codes (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    voucher_campaign_id UUID NOT NULL,
    code VARCHAR(80) NOT NULL,
    status VARCHAR(30) NOT NULL DEFAULT 'available',
    lead_id UUID,
    claimed_at TIMESTAMPTZ,
    redeemed_at TIMESTAMPTZ,
    redeemed_order_vnd BIGINT NOT NULL DEFAULT 0,
    redeemed_by_note VARCHAR(255),
    created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    CONSTRAINT uk_mkt_voucher_codes_tenant_id UNIQUE (tenant_id, id),
    CONSTRAINT uk_mkt_voucher_code_unique UNIQUE (tenant_id, code),
    CONSTRAINT fk_mkt_vcode_campaign FOREIGN KEY (tenant_id, voucher_campaign_id) REFERENCES mkt_voucher_campaigns(tenant_id, id) ON DELETE CASCADE,
    CONSTRAINT fk_mkt_vcode_lead FOREIGN KEY (tenant_id, lead_id) REFERENCES leads(tenant_id, id) ON DELETE SET NULL
  );
  CREATE INDEX IF NOT EXISTS idx_mkt_vcode_lookup ON mkt_voucher_codes(tenant_id, voucher_campaign_id, status);

  CREATE TABLE IF NOT EXISTS mkt_short_links (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    title VARCHAR(255) NOT NULL,
    short_code VARCHAR(60) NOT NULL UNIQUE,
    target_url TEXT NOT NULL,
    custom_domain VARCHAR(150),
    utm_source VARCHAR(100),
    utm_medium VARCHAR(100),
    utm_campaign VARCHAR(150),
    qr_design_json JSONB NOT NULL DEFAULT '{}'::jsonb,
    click_count INTEGER NOT NULL DEFAULT 0,
    unique_click_count INTEGER NOT NULL DEFAULT 0,
    is_active BOOLEAN NOT NULL DEFAULT true,
    created_by UUID,
    created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    CONSTRAINT uk_mkt_short_links_tenant_id UNIQUE (tenant_id, id)
  );
  CREATE INDEX IF NOT EXISTS idx_mkt_short_links_tenant ON mkt_short_links(tenant_id, created_at DESC);

  CREATE TABLE IF NOT EXISTS mkt_short_link_clicks (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    short_link_id UUID NOT NULL,
    lead_id UUID,
    referrer TEXT,
    device_type VARCHAR(30) NOT NULL DEFAULT 'desktop',
    client_ip VARCHAR(64),
    utm_json JSONB NOT NULL DEFAULT '{}'::jsonb,
    clicked_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    CONSTRAINT uk_mkt_short_link_clicks_tenant_id UNIQUE (tenant_id, id),
    CONSTRAINT fk_mkt_slclick_link FOREIGN KEY (tenant_id, short_link_id) REFERENCES mkt_short_links(tenant_id, id) ON DELETE CASCADE,
    CONSTRAINT fk_mkt_slclick_lead FOREIGN KEY (tenant_id, lead_id) REFERENCES leads(tenant_id, id) ON DELETE SET NULL
  );
  CREATE INDEX IF NOT EXISTS idx_mkt_slclicks_lookup ON mkt_short_link_clicks(tenant_id, short_link_id, clicked_at DESC);

  CREATE TABLE IF NOT EXISTS mkt_web_properties (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    name VARCHAR(200) NOT NULL,
    domain VARCHAR(255) NOT NULL,
    site_key VARCHAR(80) NOT NULL UNIQUE,
    pricing_url_pattern VARCHAR(255) NOT NULL DEFAULT '/pricing,/bang-gia',
    target_audience_id UUID,
    auto_alert_pricing BOOLEAN NOT NULL DEFAULT true,
    is_active BOOLEAN NOT NULL DEFAULT true,
    created_by UUID,
    created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    CONSTRAINT uk_mkt_web_properties_tenant_id UNIQUE (tenant_id, id),
    CONSTRAINT fk_mkt_webprop_audience FOREIGN KEY (tenant_id, target_audience_id) REFERENCES tenant_audiences(tenant_id, id) ON DELETE SET NULL
  );
  CREATE INDEX IF NOT EXISTS idx_mkt_webprop_tenant ON mkt_web_properties(tenant_id, is_active);

  CREATE TABLE IF NOT EXISTS mkt_web_sessions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    property_id UUID NOT NULL,
    visitor_token VARCHAR(120) NOT NULL,
    lead_id UUID,
    entry_url TEXT,
    last_url TEXT,
    referrer TEXT,
    utm_source VARCHAR(100),
    utm_medium VARCHAR(100),
    utm_campaign VARCHAR(150),
    device_type VARCHAR(30) NOT NULL DEFAULT 'desktop',
    pageviews_count INTEGER NOT NULL DEFAULT 1,
    pricing_intent_detected BOOLEAN NOT NULL DEFAULT false,
    started_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    last_seen_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    CONSTRAINT uk_mkt_web_sessions_tenant_id UNIQUE (tenant_id, id),
    CONSTRAINT uk_mkt_web_visitor_prop UNIQUE (tenant_id, property_id, visitor_token),
    CONSTRAINT fk_mkt_websess_prop FOREIGN KEY (tenant_id, property_id) REFERENCES mkt_web_properties(tenant_id, id) ON DELETE CASCADE,
    CONSTRAINT fk_mkt_websess_lead FOREIGN KEY (tenant_id, lead_id) REFERENCES leads(tenant_id, id) ON DELETE SET NULL
  );
  CREATE INDEX IF NOT EXISTS idx_mkt_websess_lookup ON mkt_web_sessions(tenant_id, property_id, last_seen_at DESC);

  CREATE TABLE IF NOT EXISTS mkt_web_events (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    property_id UUID NOT NULL,
    session_id UUID NOT NULL,
    lead_id UUID,
    event_type VARCHAR(40) NOT NULL DEFAULT 'pageview',
    page_url TEXT NOT NULL,
    element_selector VARCHAR(255),
    x_pct NUMERIC(5,2),
    y_pct NUMERIC(5,2),
    scroll_depth_pct INTEGER,
    metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    CONSTRAINT uk_mkt_web_events_tenant_id UNIQUE (tenant_id, id),
    CONSTRAINT fk_mkt_webevt_prop FOREIGN KEY (tenant_id, property_id) REFERENCES mkt_web_properties(tenant_id, id) ON DELETE CASCADE,
    CONSTRAINT fk_mkt_webevt_sess FOREIGN KEY (tenant_id, session_id) REFERENCES mkt_web_sessions(tenant_id, id) ON DELETE CASCADE,
    CONSTRAINT fk_mkt_webevt_lead FOREIGN KEY (tenant_id, lead_id) REFERENCES leads(tenant_id, id) ON DELETE SET NULL
  );
  CREATE INDEX IF NOT EXISTS idx_mkt_webevt_heatmap ON mkt_web_events(tenant_id, property_id, event_type, created_at DESC);

  CREATE TABLE IF NOT EXISTS mkt_ai_bot_configs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    bot_name VARCHAR(150) NOT NULL DEFAULT 'DOM Agent CSKH',
    brand_persona TEXT,
    welcome_message TEXT,
    channels_json JSONB NOT NULL DEFAULT '["messenger","zalo_oa","web_chat"]'::jsonb,
    faq_rules_json JSONB NOT NULL DEFAULT '[]'::jsonb,
    auto_extract_contact BOOLEAN NOT NULL DEFAULT true,
    routing_mode VARCHAR(30) NOT NULL DEFAULT 'audience',
    target_audience_id UUID,
    distribution_round_id UUID,
    is_active BOOLEAN NOT NULL DEFAULT true,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    CONSTRAINT uk_mkt_ai_bot_configs_tenant_id UNIQUE (tenant_id, id),
    CONSTRAINT uk_mkt_ai_bot_per_tenant UNIQUE (tenant_id),
    CONSTRAINT fk_mkt_aibot_audience FOREIGN KEY (tenant_id, target_audience_id) REFERENCES tenant_audiences(tenant_id, id) ON DELETE SET NULL,
    CONSTRAINT fk_mkt_aibot_round FOREIGN KEY (tenant_id, distribution_round_id) REFERENCES distribution_rounds(tenant_id, id) ON DELETE SET NULL
  );

  CREATE TABLE IF NOT EXISTS mkt_social_conversations (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    channel VARCHAR(30) NOT NULL DEFAULT 'messenger' CHECK (channel IN ('messenger', 'zalo_oa', 'web_chat')),
    external_thread_id VARCHAR(150) NOT NULL,
    customer_name VARCHAR(150) NOT NULL DEFAULT 'Khách hàng Chat',
    customer_avatar TEXT,
    extracted_phone VARCHAR(30),
    extracted_email VARCHAR(255),
    lead_id UUID,
    bot_paused BOOLEAN NOT NULL DEFAULT false,
    unread_count INTEGER NOT NULL DEFAULT 0,
    status VARCHAR(30) NOT NULL DEFAULT 'open',
    last_message_preview TEXT,
    last_message_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    CONSTRAINT uk_mkt_social_conversations_tenant_id UNIQUE (tenant_id, id),
    CONSTRAINT uk_mkt_social_conv_ext UNIQUE (tenant_id, channel, external_thread_id),
    CONSTRAINT fk_mkt_socconv_lead FOREIGN KEY (tenant_id, lead_id) REFERENCES leads(tenant_id, id) ON DELETE SET NULL
  );
  CREATE INDEX IF NOT EXISTS idx_mkt_socconv_tenant ON mkt_social_conversations(tenant_id, channel, last_message_at DESC);

  CREATE TABLE IF NOT EXISTS mkt_social_messages (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    conversation_id UUID NOT NULL,
    sender_type VARCHAR(20) NOT NULL DEFAULT 'customer' CHECK (sender_type IN ('customer', 'bot', 'agent')),
    sender_name VARCHAR(150),
    content TEXT NOT NULL,
    extracted_entities JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    CONSTRAINT uk_mkt_social_messages_tenant_id UNIQUE (tenant_id, id),
    CONSTRAINT fk_mkt_socmsg_conv FOREIGN KEY (tenant_id, conversation_id) REFERENCES mkt_social_conversations(tenant_id, id) ON DELETE CASCADE
  );
  CREATE INDEX IF NOT EXISTS idx_mkt_socmsg_lookup ON mkt_social_messages(tenant_id, conversation_id, created_at ASC);

  CREATE TABLE IF NOT EXISTS mkt_campaign_reminders (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    campaign_id UUID NOT NULL,
    step_order INTEGER NOT NULL DEFAULT 1,
    trigger_condition VARCHAR(40) NOT NULL DEFAULT 'no_open',
    wait_hours INTEGER NOT NULL DEFAULT 24,
    subject VARCHAR(255) NOT NULL DEFAULT '',
    template_id UUID,
    channel VARCHAR(20) NOT NULL DEFAULT 'email',
    dispatched_count INTEGER NOT NULL DEFAULT 0,
    is_active BOOLEAN NOT NULL DEFAULT true,
    created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    CONSTRAINT uk_mkt_campaign_reminders_tenant_id UNIQUE (tenant_id, id),
    CONSTRAINT fk_mkt_camp_rem_campaign FOREIGN KEY (tenant_id, campaign_id) REFERENCES mkt_campaigns(tenant_id, id) ON DELETE CASCADE
  );
  CREATE INDEX IF NOT EXISTS idx_mkt_camp_rem_lookup ON mkt_campaign_reminders(tenant_id, campaign_id, step_order ASC);

  CREATE TABLE IF NOT EXISTS mkt_web_heatmaps (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    property_id UUID NOT NULL,
    name VARCHAR(200) NOT NULL,
    page_url_pattern VARCHAR(500) NOT NULL DEFAULT '/',
    device_filter VARCHAR(30) NOT NULL DEFAULT 'all',
    snapshot_html TEXT,
    viewport_width INTEGER NOT NULL DEFAULT 1440,
    viewport_height INTEGER NOT NULL DEFAULT 900,
    click_count INTEGER NOT NULL DEFAULT 0,
    scroll_avg_pct INTEGER NOT NULL DEFAULT 0,
    is_active BOOLEAN NOT NULL DEFAULT true,
    metadata_json JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    CONSTRAINT uk_mkt_web_heatmaps_tenant_id UNIQUE (tenant_id, id),
    CONSTRAINT fk_mkt_webhm_prop FOREIGN KEY (tenant_id, property_id) REFERENCES mkt_web_properties(tenant_id, id) ON DELETE CASCADE
  );
  CREATE INDEX IF NOT EXISTS idx_mkt_webhm_lookup ON mkt_web_heatmaps(tenant_id, property_id, created_at DESC);

  CREATE TABLE IF NOT EXISTS mkt_zalo_oa_configs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    oa_id VARCHAR(100) NOT NULL DEFAULT '',
    oa_name VARCHAR(200) NOT NULL DEFAULT 'Zalo Official Account',
    app_id VARCHAR(100) NOT NULL DEFAULT '',
    status VARCHAR(30) NOT NULL DEFAULT 'connected',
    daily_quota INTEGER NOT NULL DEFAULT 1000,
    sent_today INTEGER NOT NULL DEFAULT 0,
    quality_rating VARCHAR(30) NOT NULL DEFAULT 'high',
    webhook_secret VARCHAR(120),
    settings_json JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    CONSTRAINT uk_mkt_zalo_oa_configs_tenant_id UNIQUE (tenant_id, id),
    CONSTRAINT uk_mkt_zalo_oa_per_tenant UNIQUE (tenant_id)
  );

  CREATE TABLE IF NOT EXISTS mkt_zalo_templates (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    oa_id VARCHAR(100),
    template_code VARCHAR(100) NOT NULL,
    name VARCHAR(200) NOT NULL,
    template_type VARCHAR(40) NOT NULL DEFAULT 'zns_transaction',
    status VARCHAR(30) NOT NULL DEFAULT 'approved',
    price_vnd INTEGER NOT NULL DEFAULT 250,
    content_body TEXT NOT NULL DEFAULT '',
    params_schema_json JSONB NOT NULL DEFAULT '[]'::jsonb,
    buttons_json JSONB NOT NULL DEFAULT '[]'::jsonb,
    preview_url TEXT,
    sent_count INTEGER NOT NULL DEFAULT 0,
    delivered_count INTEGER NOT NULL DEFAULT 0,
    created_by UUID,
    created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    CONSTRAINT uk_mkt_zalo_templates_tenant_id UNIQUE (tenant_id, id)
  );
  CREATE INDEX IF NOT EXISTS idx_mkt_zalo_tpl_tenant ON mkt_zalo_templates(tenant_id, status, created_at DESC);

  CREATE TABLE IF NOT EXISTS mkt_automation_scenarios (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    name VARCHAR(200) NOT NULL,
    channel VARCHAR(30) NOT NULL DEFAULT 'messenger',
    trigger_type VARCHAR(50) NOT NULL DEFAULT 'keyword',
    keywords_json JSONB NOT NULL DEFAULT '[]'::jsonb,
    nodes_json JSONB NOT NULL DEFAULT '[]'::jsonb,
    edges_json JSONB NOT NULL DEFAULT '[]'::jsonb,
    settings_json JSONB NOT NULL DEFAULT '{}'::jsonb,
    is_active BOOLEAN NOT NULL DEFAULT true,
    matched_count INTEGER NOT NULL DEFAULT 0,
    converted_count INTEGER NOT NULL DEFAULT 0,
    created_by UUID,
    created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    CONSTRAINT uk_mkt_automation_scenarios_tenant_id UNIQUE (tenant_id, id)
  );
  CREATE INDEX IF NOT EXISTS idx_mkt_auto_scen_tenant ON mkt_automation_scenarios(tenant_id, channel, is_active);

  CREATE TABLE IF NOT EXISTS mkt_template_acl (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    template_id UUID NOT NULL,
    scope_type VARCHAR(30) NOT NULL DEFAULT 'role',
    scope_target_id VARCHAR(120) NOT NULL,
    scope_label VARCHAR(150),
    permission_level VARCHAR(20) NOT NULL DEFAULT 'view',
    created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    CONSTRAINT uk_mkt_template_acl_tenant_id UNIQUE (tenant_id, id),
    CONSTRAINT uk_mkt_template_acl_target UNIQUE (tenant_id, template_id, scope_type, scope_target_id),
    CONSTRAINT fk_mkt_tpl_acl_template FOREIGN KEY (tenant_id, template_id) REFERENCES mkt_email_templates(tenant_id, id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS mkt_media_assets (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    folder_name VARCHAR(100) NOT NULL DEFAULT 'Chung',
    file_name VARCHAR(255) NOT NULL,
    mime_type VARCHAR(80) NOT NULL DEFAULT 'image/png',
    url TEXT NOT NULL,
    size_bytes INTEGER NOT NULL DEFAULT 0,
    width_px INTEGER,
    height_px INTEGER,
    alt_text VARCHAR(255),
    tags_json JSONB NOT NULL DEFAULT '[]'::jsonb,
    created_by UUID,
    created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    CONSTRAINT uk_mkt_media_assets_tenant_id UNIQUE (tenant_id, id)
  );
  CREATE INDEX IF NOT EXISTS idx_mkt_media_assets_tenant ON mkt_media_assets(tenant_id, folder_name, created_at DESC);

  CREATE TABLE IF NOT EXISTS mkt_ai_training_docs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    title VARCHAR(255) NOT NULL,
    doc_type VARCHAR(40) NOT NULL DEFAULT 'faq',
    source_url TEXT,
    content_text TEXT NOT NULL DEFAULT '',
    chunk_count INTEGER NOT NULL DEFAULT 1,
    token_count INTEGER NOT NULL DEFAULT 0,
    status VARCHAR(30) NOT NULL DEFAULT 'indexed',
    metadata_json JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_by UUID,
    created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    CONSTRAINT uk_mkt_ai_training_docs_tenant_id UNIQUE (tenant_id, id)
  );
  CREATE INDEX IF NOT EXISTS idx_mkt_ai_docs_tenant ON mkt_ai_training_docs(tenant_id, status, updated_at DESC);

  ALTER TABLE mkt_email_templates ADD COLUMN IF NOT EXISTS saved_blocks_json JSONB NOT NULL DEFAULT '[]'::jsonb;
  ALTER TABLE mkt_email_templates ADD COLUMN IF NOT EXISTS thumbnail_url TEXT;
  ALTER TABLE mkt_campaigns ADD COLUMN IF NOT EXISTS fallback_vars_json JSONB NOT NULL DEFAULT '{}'::jsonb;
  ALTER TABLE mkt_campaigns ADD COLUMN IF NOT EXISTS throttle_per_minute INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE mkt_campaigns ADD COLUMN IF NOT EXISTS ab_winner_criteria VARCHAR(40) NOT NULL DEFAULT 'open_rate';
  ALTER TABLE mkt_campaigns ADD COLUMN IF NOT EXISTS ab_test_hours INTEGER NOT NULL DEFAULT 4;
  ALTER TABLE mkt_campaigns ADD COLUMN IF NOT EXISTS pre_send_score INTEGER NOT NULL DEFAULT 100;
  ALTER TABLE mkt_flows ADD COLUMN IF NOT EXISTS settings_json JSONB NOT NULL DEFAULT '{}'::jsonb;
  ALTER TABLE mkt_custom_events ADD COLUMN IF NOT EXISTS webhook_secret VARCHAR(120);
  ALTER TABLE mkt_surveys ADD COLUMN IF NOT EXISTS redirect_rules_json JSONB NOT NULL DEFAULT '[]'::jsonb;
  ALTER TABLE mkt_surveys ADD COLUMN IF NOT EXISTS thank_you_json JSONB NOT NULL DEFAULT '{}'::jsonb;
  ALTER TABLE mkt_web_sessions ADD COLUMN IF NOT EXISTS geo_country VARCHAR(60) NOT NULL DEFAULT 'VN';
  ALTER TABLE mkt_web_sessions ADD COLUMN IF NOT EXISTS geo_city VARCHAR(100);
  ALTER TABLE mkt_web_sessions ADD COLUMN IF NOT EXISTS browser VARCHAR(60);
  ALTER TABLE mkt_web_sessions ADD COLUMN IF NOT EXISTS os VARCHAR(60);
  ALTER TABLE mkt_web_sessions ADD COLUMN IF NOT EXISTS duration_seconds INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE mkt_campaign_reminders ADD COLUMN IF NOT EXISTS step_order INTEGER NOT NULL DEFAULT 1;
  ALTER TABLE mkt_campaign_reminders ADD COLUMN IF NOT EXISTS trigger_condition VARCHAR(40) NOT NULL DEFAULT 'no_open';
  ALTER TABLE mkt_campaign_reminders ADD COLUMN IF NOT EXISTS wait_hours INTEGER NOT NULL DEFAULT 24;
  ALTER TABLE mkt_campaign_reminders ADD COLUMN IF NOT EXISTS subject VARCHAR(255) NOT NULL DEFAULT '';
  ALTER TABLE mkt_campaign_reminders ADD COLUMN IF NOT EXISTS template_id UUID;
  ALTER TABLE mkt_campaign_reminders ADD COLUMN IF NOT EXISTS channel VARCHAR(20) NOT NULL DEFAULT 'email';
  ALTER TABLE mkt_campaign_reminders ADD COLUMN IF NOT EXISTS dispatched_count INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE mkt_campaign_reminders ADD COLUMN IF NOT EXISTS is_active BOOLEAN NOT NULL DEFAULT true;
  ALTER TABLE mkt_web_heatmaps ADD COLUMN IF NOT EXISTS page_url_pattern VARCHAR(500) NOT NULL DEFAULT '/';
  ALTER TABLE mkt_web_heatmaps ADD COLUMN IF NOT EXISTS device_filter VARCHAR(30) NOT NULL DEFAULT 'all';
  ALTER TABLE mkt_web_heatmaps ADD COLUMN IF NOT EXISTS snapshot_html TEXT;
  ALTER TABLE mkt_web_heatmaps ADD COLUMN IF NOT EXISTS viewport_width INTEGER NOT NULL DEFAULT 1440;
  ALTER TABLE mkt_web_heatmaps ADD COLUMN IF NOT EXISTS viewport_height INTEGER NOT NULL DEFAULT 900;
  ALTER TABLE mkt_web_heatmaps ADD COLUMN IF NOT EXISTS click_count INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE mkt_web_heatmaps ADD COLUMN IF NOT EXISTS scroll_avg_pct INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE mkt_web_heatmaps ADD COLUMN IF NOT EXISTS is_active BOOLEAN NOT NULL DEFAULT true;
  ALTER TABLE mkt_web_heatmaps ADD COLUMN IF NOT EXISTS metadata_json JSONB NOT NULL DEFAULT '{}'::jsonb;
  ALTER TABLE mkt_zalo_oa_configs ADD COLUMN IF NOT EXISTS oa_id VARCHAR(100) NOT NULL DEFAULT '';
  ALTER TABLE mkt_zalo_oa_configs ADD COLUMN IF NOT EXISTS oa_name VARCHAR(200) NOT NULL DEFAULT 'Zalo Official Account';
  ALTER TABLE mkt_zalo_oa_configs ADD COLUMN IF NOT EXISTS app_id VARCHAR(100) NOT NULL DEFAULT '';
  ALTER TABLE mkt_zalo_oa_configs ADD COLUMN IF NOT EXISTS status VARCHAR(30) NOT NULL DEFAULT 'connected';
  ALTER TABLE mkt_zalo_oa_configs ADD COLUMN IF NOT EXISTS daily_quota INTEGER NOT NULL DEFAULT 1000;
  ALTER TABLE mkt_zalo_oa_configs ADD COLUMN IF NOT EXISTS sent_today INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE mkt_zalo_oa_configs ADD COLUMN IF NOT EXISTS quality_rating VARCHAR(30) NOT NULL DEFAULT 'high';
  ALTER TABLE mkt_zalo_oa_configs ADD COLUMN IF NOT EXISTS webhook_secret VARCHAR(120);
  ALTER TABLE mkt_zalo_oa_configs ADD COLUMN IF NOT EXISTS settings_json JSONB NOT NULL DEFAULT '{}'::jsonb;
  ALTER TABLE mkt_zalo_templates ADD COLUMN IF NOT EXISTS oa_id VARCHAR(100);
  ALTER TABLE mkt_zalo_templates ADD COLUMN IF NOT EXISTS template_code VARCHAR(100) NOT NULL DEFAULT '';
  ALTER TABLE mkt_zalo_templates ADD COLUMN IF NOT EXISTS template_type VARCHAR(40) NOT NULL DEFAULT 'zns_transaction';
  ALTER TABLE mkt_zalo_templates ADD COLUMN IF NOT EXISTS status VARCHAR(30) NOT NULL DEFAULT 'approved';
  ALTER TABLE mkt_zalo_templates ADD COLUMN IF NOT EXISTS price_vnd INTEGER NOT NULL DEFAULT 250;
  ALTER TABLE mkt_zalo_templates ADD COLUMN IF NOT EXISTS content_body TEXT NOT NULL DEFAULT '';
  ALTER TABLE mkt_zalo_templates ADD COLUMN IF NOT EXISTS params_schema_json JSONB NOT NULL DEFAULT '[]'::jsonb;
  ALTER TABLE mkt_zalo_templates ADD COLUMN IF NOT EXISTS buttons_json JSONB NOT NULL DEFAULT '[]'::jsonb;
  ALTER TABLE mkt_zalo_templates ADD COLUMN IF NOT EXISTS preview_url TEXT;
  ALTER TABLE mkt_zalo_templates ADD COLUMN IF NOT EXISTS sent_count INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE mkt_zalo_templates ADD COLUMN IF NOT EXISTS delivered_count INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE mkt_automation_scenarios ADD COLUMN IF NOT EXISTS channel VARCHAR(30) NOT NULL DEFAULT 'messenger';
  ALTER TABLE mkt_automation_scenarios ADD COLUMN IF NOT EXISTS trigger_type VARCHAR(50) NOT NULL DEFAULT 'keyword';
  ALTER TABLE mkt_automation_scenarios ADD COLUMN IF NOT EXISTS keywords_json JSONB NOT NULL DEFAULT '[]'::jsonb;
  ALTER TABLE mkt_automation_scenarios ADD COLUMN IF NOT EXISTS nodes_json JSONB NOT NULL DEFAULT '[]'::jsonb;
  ALTER TABLE mkt_automation_scenarios ADD COLUMN IF NOT EXISTS edges_json JSONB NOT NULL DEFAULT '[]'::jsonb;
  ALTER TABLE mkt_automation_scenarios ADD COLUMN IF NOT EXISTS settings_json JSONB NOT NULL DEFAULT '{}'::jsonb;
  ALTER TABLE mkt_automation_scenarios ADD COLUMN IF NOT EXISTS is_active BOOLEAN NOT NULL DEFAULT true;
  ALTER TABLE mkt_automation_scenarios ADD COLUMN IF NOT EXISTS matched_count INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE mkt_automation_scenarios ADD COLUMN IF NOT EXISTS converted_count INTEGER NOT NULL DEFAULT 0;

  DO $$
  DECLARE
    tbl TEXT;
    pol TEXT;
  BEGIN
    FOREACH tbl IN ARRAY ARRAY[
      'mkt_template_groups',
      'mkt_email_templates',
      'mkt_forms',
      'mkt_form_submissions',
      'mkt_custom_events',
      'mkt_otp_verifications',
      'mkt_surveys',
      'mkt_survey_responses',
      'mkt_campaigns',
      'mkt_send_claims',
      'mkt_suppression_list',
      'mkt_flows',
      'mkt_flow_snapshots',
      'mkt_flow_enrollments',
      'mkt_voucher_campaigns',
      'mkt_voucher_codes',
      'mkt_short_links',
      'mkt_short_link_clicks',
      'mkt_web_properties',
      'mkt_web_sessions',
      'mkt_web_events',
      'mkt_ai_bot_configs',
      'mkt_social_conversations',
      'mkt_social_messages',
      'mkt_campaign_reminders',
      'mkt_web_heatmaps',
      'mkt_zalo_oa_configs',
      'mkt_zalo_templates',
      'mkt_automation_scenarios',
      'mkt_template_acl',
      'mkt_media_assets',
      'mkt_ai_training_docs'
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
      IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'autodata_app') THEN
        BEGIN
          EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE %I TO autodata_app', tbl);
        EXCEPTION
          WHEN insufficient_privilege THEN
            NULL;
        END;
      END IF;
    END LOOP;
  END $$;

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
    CREATE INDEX IF NOT EXISTS idx_crm360_invoices_lead ON tenant_invoices(tenant_id, lead_id, created_at DESC);

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

CREATE TABLE IF NOT EXISTS tenant_ai_agent_configs (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
      agent_name VARCHAR(120) NOT NULL DEFAULT 'DOM Agent',
      avatar_url TEXT NOT NULL DEFAULT '/imgs/autodata/ICON.png',
      greeting_message TEXT NOT NULL DEFAULT 'Xin chào! Tôi là DOM Agent — Trợ lý AI điều hành doanh nghiệp thông minh, tuân thủ nghiêm ngặt phân quyền RBAC và kho tri thức nội bộ của tổ chức bạn.',
      persona_tone VARCHAR(50) NOT NULL DEFAULT 'executive_concise',
      preferred_model VARCHAR(80) NOT NULL DEFAULT 'gemini-2.5-flash',
      temperature NUMERIC(4,2) NOT NULL DEFAULT 0.25,
      enable_morning_briefing BOOLEAN NOT NULL DEFAULT true,
      guardrail_rules JSONB NOT NULL DEFAULT '[]'::jsonb,
      updated_by UUID,
      created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
      CONSTRAINT uk_tenant_ai_agent_configs_tenant_id UNIQUE (tenant_id, id),
      CONSTRAINT uk_tenant_ai_agent_configs_tenant_only UNIQUE (tenant_id)
    );

    CREATE TABLE IF NOT EXISTS tenant_ai_knowledge_docs (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
      title VARCHAR(255) NOT NULL,
      category VARCHAR(60) NOT NULL DEFAULT 'company_policy',
      source_type VARCHAR(30) NOT NULL DEFAULT 'manual' CHECK (source_type IN ('manual', 'policy_sync', 'file_upload')),
      source_policy_id UUID,
      file_name VARCHAR(255),
      content_text TEXT NOT NULL DEFAULT '',
      allowed_department_ids JSONB NOT NULL DEFAULT '[]'::jsonb,
      chunk_count INTEGER NOT NULL DEFAULT 0,
      is_active BOOLEAN NOT NULL DEFAULT true,
      created_by UUID,
      created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
      CONSTRAINT uk_tenant_ai_knowledge_docs_tenant_id UNIQUE (tenant_id, id)
    );
    CREATE INDEX IF NOT EXISTS idx_ai_kdocs_tenant_active ON tenant_ai_knowledge_docs(tenant_id, is_active, updated_at DESC);
    CREATE INDEX IF NOT EXISTS idx_ai_kdocs_policy_sync ON tenant_ai_knowledge_docs(tenant_id, source_policy_id);

    CREATE TABLE IF NOT EXISTS tenant_ai_knowledge_chunks (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
      doc_id UUID NOT NULL,
      chunk_index INTEGER NOT NULL DEFAULT 0,
      chunk_text TEXT NOT NULL,
      keywords_text TEXT NOT NULL DEFAULT '',
      token_estimate INTEGER NOT NULL DEFAULT 0,
      created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
      CONSTRAINT uk_tenant_ai_knowledge_chunks_tenant_id UNIQUE (tenant_id, id),
      CONSTRAINT uk_tenant_ai_knowledge_chunks_doc_idx UNIQUE (tenant_id, doc_id, chunk_index),
      CONSTRAINT fk_ai_kchunks_doc FOREIGN KEY (tenant_id, doc_id) REFERENCES tenant_ai_knowledge_docs(tenant_id, id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_ai_kchunks_tenant_doc ON tenant_ai_knowledge_chunks(tenant_id, doc_id, chunk_index ASC);

    CREATE TABLE IF NOT EXISTS tenant_ai_threads (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
      user_id UUID NOT NULL,
      specialist_key VARCHAR(50) NOT NULL DEFAULT 'orchestrator',
      title VARCHAR(255) NOT NULL DEFAULT 'Cuộc hội thoại mới',
      is_pinned BOOLEAN NOT NULL DEFAULT false,
      last_message_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
      created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
      CONSTRAINT uk_tenant_ai_threads_tenant_id UNIQUE (tenant_id, id),
      CONSTRAINT fk_ai_threads_user FOREIGN KEY (tenant_id, user_id) REFERENCES users(tenant_id, id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_ai_threads_tenant_user ON tenant_ai_threads(tenant_id, user_id, is_pinned DESC, last_message_at DESC);

    CREATE TABLE IF NOT EXISTS tenant_ai_messages (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
      thread_id UUID NOT NULL,
      role VARCHAR(20) NOT NULL CHECK (role IN ('user', 'assistant', 'tool')),
      content TEXT NOT NULL DEFAULT '',
      tool_calls JSONB NOT NULL DEFAULT '[]'::jsonb,
      citations JSONB NOT NULL DEFAULT '[]'::jsonb,
      latency_ms INTEGER NOT NULL DEFAULT 0,
      model_used VARCHAR(80),
      created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
      CONSTRAINT uk_tenant_ai_messages_tenant_id UNIQUE (tenant_id, id),
      CONSTRAINT fk_ai_messages_thread FOREIGN KEY (tenant_id, thread_id) REFERENCES tenant_ai_threads(tenant_id, id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_ai_messages_thread_created ON tenant_ai_messages(tenant_id, thread_id, created_at ASC);

    CREATE TABLE IF NOT EXISTS tenant_ai_tool_audit_logs (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
      user_id UUID NOT NULL,
      tool_name VARCHAR(100) NOT NULL,
      module_key VARCHAR(64) NOT NULL,
      required_action VARCHAR(40) NOT NULL,
      data_scope VARCHAR(30) NOT NULL DEFAULT 'none',
      allowed BOOLEAN NOT NULL DEFAULT false,
      denial_reason TEXT,
      args_summary JSONB NOT NULL DEFAULT '{}'::jsonb,
      latency_ms INTEGER NOT NULL DEFAULT 0,
      created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
      CONSTRAINT uk_tenant_ai_tool_audit_logs_tenant_id UNIQUE (tenant_id, id),
      CONSTRAINT fk_ai_tool_audit_user FOREIGN KEY (tenant_id, user_id) REFERENCES users(tenant_id, id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_ai_tool_audit_tenant_created ON tenant_ai_tool_audit_logs(tenant_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_ai_tool_audit_user_created ON tenant_ai_tool_audit_logs(tenant_id, user_id, created_at DESC);

    DO $$
    DECLARE
      tbl TEXT;
      pol TEXT;
    BEGIN
      FOREACH tbl IN ARRAY ARRAY[
        'tenant_ai_agent_configs',
        'tenant_ai_knowledge_docs',
        'tenant_ai_knowledge_chunks',
        'tenant_ai_threads',
        'tenant_ai_messages',
        'tenant_ai_tool_audit_logs'
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
        IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'autodata_app') THEN
          EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON %I TO autodata_app', tbl);
        END IF;
      END LOOP;
    EXCEPTION
      WHEN insufficient_privilege THEN
        NULL;
    END $$;

ALTER TABLE tenant_branches
      ADD COLUMN IF NOT EXISTS branch_ip_whitelist JSONB NOT NULL DEFAULT '[]'::jsonb;

ALTER TABLE tenant_hr_attendance_logs
      ADD COLUMN IF NOT EXISTS accuracy_meters NUMERIC(10,2),
      ADD COLUMN IF NOT EXISTS checkout_accuracy_meters NUMERIC(10,2),
      ADD COLUMN IF NOT EXISTS checkin_ip VARCHAR(64),
      ADD COLUMN IF NOT EXISTS checkout_ip VARCHAR(64),
      ADD COLUMN IF NOT EXISTS verification_method VARCHAR(40) NOT NULL DEFAULT 'standard',
      ADD COLUMN IF NOT EXISTS geofence_mode_applied VARCHAR(30) NOT NULL DEFAULT 'flexible',
      ADD COLUMN IF NOT EXISTS exemption_applied BOOLEAN NOT NULL DEFAULT false;

CREATE TABLE IF NOT EXISTS tenant_attendance_policies (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
      geofence_mode VARCHAR(30) NOT NULL DEFAULT 'flexible'
        CHECK (geofence_mode IN ('flexible', 'warn_with_explanation', 'strict_radius')),
      require_gps BOOLEAN NOT NULL DEFAULT false,
      require_selfie BOOLEAN NOT NULL DEFAULT false,
      max_gps_accuracy_meters INTEGER NOT NULL DEFAULT 150,
      grace_late_minutes INTEGER NOT NULL DEFAULT 15,
      grace_early_minutes INTEGER NOT NULL DEFAULT 15,
      allow_any_branch_checkin BOOLEAN NOT NULL DEFAULT false,
      allow_remote_with_approved_leave BOOLEAN NOT NULL DEFAULT true,
      allow_ip_whitelist_bypass BOOLEAN NOT NULL DEFAULT true,
      require_checkout BOOLEAN NOT NULL DEFAULT true,
      enable_night_shift BOOLEAN NOT NULL DEFAULT true,
      enable_weekend_shift BOOLEAN NOT NULL DEFAULT true,
      holiday_schedules_json JSONB NOT NULL DEFAULT '[]'::jsonb,
      created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
      CONSTRAINT uk_att_policy_tenant_id UNIQUE (tenant_id, id),
      CONSTRAINT uk_att_policy_unique_tenant UNIQUE (tenant_id)
    );

CREATE TABLE IF NOT EXISTS tenant_attendance_exemption_rules (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
      name VARCHAR(160) NOT NULL,
      scope_type VARCHAR(30) NOT NULL DEFAULT 'user'
        CHECK (scope_type IN ('role', 'department', 'team', 'position', 'user')),
      target_id VARCHAR(64) NOT NULL,
      exempt_checkin BOOLEAN NOT NULL DEFAULT false,
      exempt_gps BOOLEAN NOT NULL DEFAULT false,
      exempt_selfie BOOLEAN NOT NULL DEFAULT false,
      custom_grace_late_minutes INTEGER,
      exclude_from_absent_report BOOLEAN NOT NULL DEFAULT false,
      effective_from DATE,
      effective_to DATE,
      reason TEXT,
      is_active BOOLEAN NOT NULL DEFAULT true,
      created_by UUID,
      created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
      CONSTRAINT uk_att_exemption_tenant_id UNIQUE (tenant_id, id)
    );

CREATE TABLE IF NOT EXISTS tenant_attendance_confirmation_batches (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
      title VARCHAR(200) NOT NULL,
      period_month VARCHAR(10) NOT NULL,
      from_date VARCHAR(10) NOT NULL,
      to_date VARCHAR(10) NOT NULL,
      deadline_at TIMESTAMPTZ,
      status VARCHAR(20) NOT NULL DEFAULT 'open'
        CHECK (status IN ('draft', 'open', 'closed')),
      created_by UUID,
      created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
      CONSTRAINT uk_att_conf_batch_tenant_id UNIQUE (tenant_id, id)
    );

CREATE TABLE IF NOT EXISTS tenant_attendance_confirmations (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
      batch_id UUID NOT NULL,
      user_id UUID NOT NULL,
      employee_id UUID,
      total_work_units NUMERIC(8,2) NOT NULL DEFAULT 0,
      late_count INTEGER NOT NULL DEFAULT 0,
      early_count INTEGER NOT NULL DEFAULT 0,
      overtime_hours NUMERIC(8,2) NOT NULL DEFAULT 0,
      status VARCHAR(20) NOT NULL DEFAULT 'pending'
        CHECK (status IN ('pending', 'confirmed', 'disputed', 'auto_confirmed')),
      dispute_reason TEXT,
      confirmed_at TIMESTAMPTZ,
      confirmed_by_type VARCHAR(20),
      details_json JSONB NOT NULL DEFAULT '{}'::jsonb,
      created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
      CONSTRAINT uk_att_conf_tenant_id UNIQUE (tenant_id, id),
      CONSTRAINT uk_att_conf_batch_user UNIQUE (tenant_id, batch_id, user_id)
    );

CREATE TABLE IF NOT EXISTS tenant_attendance_bulk_requests (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
      user_id UUID NOT NULL,
      employee_id UUID,
      month_period VARCHAR(10) NOT NULL,
      status VARCHAR(30) NOT NULL DEFAULT 'pending_manager'
        CHECK (status IN ('draft', 'pending_manager', 'approved', 'rejected')),
      approver_id UUID,
      approved_by UUID,
      approved_at TIMESTAMPTZ,
      admin_note TEXT,
      details_json JSONB NOT NULL DEFAULT '[]'::jsonb,
      approval_request_id UUID,
      created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
      CONSTRAINT uk_att_bulk_req_tenant_id UNIQUE (tenant_id, id)
    );

CREATE INDEX IF NOT EXISTS idx_att_exemption_tenant_scope
      ON tenant_attendance_exemption_rules (tenant_id, is_active, scope_type, target_id);

CREATE INDEX IF NOT EXISTS idx_att_conf_batch_tenant
      ON tenant_attendance_confirmations (tenant_id, batch_id, status);

CREATE INDEX IF NOT EXISTS idx_att_bulk_req_tenant_user
      ON tenant_attendance_bulk_requests (tenant_id, user_id, month_period);


DO $$
DECLARE tbl TEXT; pol TEXT;
BEGIN
  FOREACH tbl IN ARRAY ARRAY['tenant_attendance_policies', 'tenant_attendance_exemption_rules', 'tenant_attendance_confirmation_batches', 'tenant_attendance_confirmations', 'tenant_attendance_bulk_requests']
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', tbl);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', tbl);
    pol := 'tenant_isolation_' || tbl;
    EXECUTE format('DROP POLICY IF EXISTS %I ON %I', pol, tbl);
    EXECUTE format('CREATE POLICY %I ON %I USING (tenant_id = NULLIF(current_setting(''app.current_tenant_id'', true), '''')::uuid) WITH CHECK (tenant_id = NULLIF(current_setting(''app.current_tenant_id'', true), '''')::uuid)', pol, tbl);
  END LOOP;
END $$;

ALTER TABLE tenant_branches
      ADD COLUMN IF NOT EXISTS branch_ip_whitelist JSONB NOT NULL DEFAULT '[]'::jsonb;

CREATE TABLE IF NOT EXISTS tenant_custom_fields (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
      entity_type VARCHAR(40) NOT NULL DEFAULT 'lead',
      field_key VARCHAR(80) NOT NULL,
      field_label VARCHAR(160) NOT NULL,
      field_type VARCHAR(30) NOT NULL DEFAULT 'text',
      options_json JSONB NOT NULL DEFAULT '[]'::jsonb,
      is_required BOOLEAN NOT NULL DEFAULT false,
      is_filterable BOOLEAN NOT NULL DEFAULT true,
      show_in_table BOOLEAN NOT NULL DEFAULT true,
      default_value TEXT,
      validation_regex TEXT,
      placeholder VARCHAR(255),
      sort_order INTEGER NOT NULL DEFAULT 0,
      is_active BOOLEAN NOT NULL DEFAULT true,
      created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
      CONSTRAINT uk_tenant_custom_fields_tenant_id UNIQUE (tenant_id, id),
      CONSTRAINT uk_tenant_custom_fields_key UNIQUE (tenant_id, entity_type, field_key)
    );

CREATE TABLE IF NOT EXISTS tenant_lead_scoring_rules (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
      name VARCHAR(160) NOT NULL,
      description TEXT,
      trigger_type VARCHAR(40) NOT NULL DEFAULT 'field_match',
      condition_json JSONB NOT NULL DEFAULT '{}'::jsonb,
      score_delta INTEGER NOT NULL DEFAULT 10,
      max_applications INTEGER NOT NULL DEFAULT 1,
      priority INTEGER NOT NULL DEFAULT 100,
      is_active BOOLEAN NOT NULL DEFAULT true,
      created_by UUID,
      created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
      CONSTRAINT uk_tenant_lead_scoring_rules_tenant_id UNIQUE (tenant_id, id)
    );

CREATE TABLE IF NOT EXISTS tenant_notification_rules (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
      event_key VARCHAR(80) NOT NULL,
      name VARCHAR(160) NOT NULL,
      description TEXT,
      recipient_strategy VARCHAR(40) NOT NULL DEFAULT 'assigned_and_managers',
      target_roles_json JSONB NOT NULL DEFAULT '[]'::jsonb,
      target_departments_json JSONB NOT NULL DEFAULT '[]'::jsonb,
      target_user_ids_json JSONB NOT NULL DEFAULT '[]'::jsonb,
      include_owner BOOLEAN NOT NULL DEFAULT true,
      include_team_leader BOOLEAN NOT NULL DEFAULT false,
      cc_emails JSONB NOT NULL DEFAULT '[]'::jsonb,
      channels_json JSONB NOT NULL DEFAULT '{"in_app":true,"email":false,"zalo":false,"telegram":false}'::jsonb,
      is_active BOOLEAN NOT NULL DEFAULT true,
      created_by UUID,
      created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
      CONSTRAINT uk_tenant_notification_rules_tenant_id UNIQUE (tenant_id, id)
    );

CREATE TABLE IF NOT EXISTS tenant_email_templates (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
      template_key VARCHAR(100) NOT NULL,
      name VARCHAR(180) NOT NULL,
      category VARCHAR(40) NOT NULL DEFAULT 'notification',
      subject_template TEXT NOT NULL,
      body_html TEXT NOT NULL,
      body_text TEXT,
      variables_json JSONB NOT NULL DEFAULT '[]'::jsonb,
      is_system BOOLEAN NOT NULL DEFAULT false,
      is_active BOOLEAN NOT NULL DEFAULT true,
      created_by UUID,
      created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
      CONSTRAINT uk_tenant_email_templates_tenant_id UNIQUE (tenant_id, id),
      CONSTRAINT uk_tenant_email_templates_key UNIQUE (tenant_id, template_key)
    );

CREATE TABLE IF NOT EXISTS tenant_entity_tabs (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
      entity_type VARCHAR(40) NOT NULL DEFAULT 'lead',
      tab_key VARCHAR(80) NOT NULL,
      label VARCHAR(140) NOT NULL DEFAULT '',
      tab_label VARCHAR(150) NOT NULL DEFAULT '',
      icon_name VARCHAR(60) NOT NULL DEFAULT 'Layers',
      tab_type VARCHAR(30) NOT NULL DEFAULT 'fields',
      config_json JSONB NOT NULL DEFAULT '{}'::jsonb,
      fields_json JSONB NOT NULL DEFAULT '[]'::jsonb,
      allowed_role_ids JSONB NOT NULL DEFAULT '[]'::jsonb,
      allowed_roles JSONB NOT NULL DEFAULT '[]'::jsonb,
      sort_order INTEGER NOT NULL DEFAULT 0,
      is_active BOOLEAN NOT NULL DEFAULT true,
      created_by UUID,
      created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
      CONSTRAINT uk_tenant_entity_tabs_tenant_id UNIQUE (tenant_id, id),
      CONSTRAINT uk_tenant_entity_tabs_key UNIQUE (tenant_id, entity_type, tab_key)
    );

CREATE TABLE IF NOT EXISTS tenant_cron_runs (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      tenant_id UUID REFERENCES tenants(id) ON DELETE CASCADE,
      subroutine_key VARCHAR(80) NOT NULL,
      run_key VARCHAR(120),
      status VARCHAR(20) NOT NULL DEFAULT 'success',
      items_processed INTEGER NOT NULL DEFAULT 0,
      duration_ms INTEGER NOT NULL DEFAULT 0,
      error_message TEXT,
      details_json JSONB NOT NULL DEFAULT '{}'::jsonb,
      triggered_by VARCHAR(40) NOT NULL DEFAULT 'scheduler',
      started_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
      finished_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
      CONSTRAINT uk_tenant_cron_runs_tenant_id UNIQUE (tenant_id, id)
    );

CREATE INDEX IF NOT EXISTS idx_custom_fields_tenant_entity
      ON tenant_custom_fields (tenant_id, entity_type, sort_order);

CREATE INDEX IF NOT EXISTS idx_custom_fields_lookup
      ON tenant_custom_fields (tenant_id, entity_type, is_active, sort_order ASC);

CREATE INDEX IF NOT EXISTS idx_lead_scoring_tenant_active
      ON tenant_lead_scoring_rules (tenant_id, is_active, priority);

CREATE INDEX IF NOT EXISTS idx_notification_rules_tenant_event
      ON tenant_notification_rules (tenant_id, event_key, is_active);

CREATE INDEX IF NOT EXISTS idx_email_templates_tenant_cat
      ON tenant_email_templates (tenant_id, category, is_active);

CREATE INDEX IF NOT EXISTS idx_entity_tabs_tenant_entity
      ON tenant_entity_tabs (tenant_id, entity_type, sort_order);

CREATE INDEX IF NOT EXISTS idx_entity_tabs_lookup
      ON tenant_entity_tabs (tenant_id, entity_type, is_active, sort_order ASC);

CREATE INDEX IF NOT EXISTS idx_cron_runs_tenant_sub
      ON tenant_cron_runs (tenant_id, subroutine_key, started_at DESC);

CREATE UNIQUE INDEX IF NOT EXISTS idx_cron_runs_tenant_sub_run_key
      ON tenant_cron_runs (tenant_id, subroutine_key, run_key)
      WHERE tenant_id IS NOT NULL AND run_key IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_cron_runs_tenant_sub_status
      ON tenant_cron_runs (tenant_id, subroutine_key, status, started_at DESC);

CREATE INDEX IF NOT EXISTS idx_cron_runs_sub_started
      ON tenant_cron_runs (subroutine_key, started_at DESC);


DO $$
DECLARE tbl TEXT; pol TEXT;
BEGIN
  FOREACH tbl IN ARRAY ARRAY['tenant_custom_fields', 'tenant_lead_scoring_rules', 'tenant_notification_rules', 'tenant_email_templates', 'tenant_entity_tabs', 'tenant_cron_runs']
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', tbl);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', tbl);
    pol := 'tenant_isolation_' || tbl;
    EXECUTE format('DROP POLICY IF EXISTS %I ON %I', pol, tbl);
    EXECUTE format('CREATE POLICY %I ON %I USING (tenant_id = NULLIF(current_setting(''app.current_tenant_id'', true), '''')::uuid) WITH CHECK (tenant_id = NULLIF(current_setting(''app.current_tenant_id'', true), '''')::uuid)', pol, tbl);
  END LOOP;
END $$;

-- Additive columns on Master Contact, B2B Companies, Deals & Workspace Tasks
    ALTER TABLE leads ADD COLUMN IF NOT EXISTS company_id UUID;
    ALTER TABLE leads ADD COLUMN IF NOT EXISTS job_title VARCHAR(150);
    ALTER TABLE leads ADD COLUMN IF NOT EXISTS address TEXT;

    ALTER TABLE tenant_b2b_companies ADD COLUMN IF NOT EXISTS parent_company_id UUID;
    ALTER TABLE tenant_b2b_companies ADD COLUMN IF NOT EXISTS status VARCHAR(30) NOT NULL DEFAULT 'active';
    ALTER TABLE tenant_b2b_companies ADD COLUMN IF NOT EXISTS sla_tier VARCHAR(30) NOT NULL DEFAULT 'standard';
    ALTER TABLE tenant_b2b_companies ADD COLUMN IF NOT EXISTS tags_json JSONB NOT NULL DEFAULT '[]'::jsonb;
    ALTER TABLE tenant_b2b_companies ADD COLUMN IF NOT EXISTS custom_fields JSONB NOT NULL DEFAULT '{}'::jsonb;

    ALTER TABLE tenant_deals ADD COLUMN IF NOT EXISTS pipeline_id UUID;
    ALTER TABLE tenant_deals ADD COLUMN IF NOT EXISTS stage_id UUID;
    ALTER TABLE tenant_deals ADD COLUMN IF NOT EXISTS tags_json JSONB NOT NULL DEFAULT '[]'::jsonb;
    ALTER TABLE tenant_deals ADD COLUMN IF NOT EXISTS custom_fields JSONB NOT NULL DEFAULT '{}'::jsonb;

    ALTER TABLE tenant_tasks ADD COLUMN IF NOT EXISTS group_id UUID;
    ALTER TABLE tenant_tasks ADD COLUMN IF NOT EXISTS deal_id UUID;
    ALTER TABLE tenant_tasks ADD COLUMN IF NOT EXISTS company_id UUID;
    ALTER TABLE tenant_tasks ADD COLUMN IF NOT EXISTS category VARCHAR(40) NOT NULL DEFAULT 'personal';
    ALTER TABLE tenant_tasks ADD COLUMN IF NOT EXISTS is_muted BOOLEAN NOT NULL DEFAULT false;
    ALTER TABLE tenant_tasks ADD COLUMN IF NOT EXISTS is_hidden BOOLEAN NOT NULL DEFAULT false;
    ALTER TABLE tenant_tasks ADD COLUMN IF NOT EXISTS participant_ids_json JSONB NOT NULL DEFAULT '[]'::jsonb;
    ALTER TABLE tenant_tasks ADD COLUMN IF NOT EXISTS tags_json JSONB NOT NULL DEFAULT '[]'::jsonb;

    -- 1. Deal Stage Transition History
    CREATE TABLE IF NOT EXISTS tenant_deal_stage_history (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
      deal_id UUID NOT NULL,
      pipeline_id UUID,
      from_stage VARCHAR(80),
      to_stage VARCHAR(80) NOT NULL,
      from_stage_id UUID,
      to_stage_id UUID,
      probability INTEGER NOT NULL DEFAULT 30,
      amount_vnd BIGINT NOT NULL DEFAULT 0,
      duration_seconds INTEGER NOT NULL DEFAULT 0,
      note TEXT,
      changed_by UUID,
      changed_by_name VARCHAR(150),
      metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
      created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
      CONSTRAINT uk_tenant_deal_stage_history_tenant_id UNIQUE (tenant_id, id)
    );
    ALTER TABLE tenant_deal_stage_history ADD COLUMN IF NOT EXISTS pipeline_id UUID;
    ALTER TABLE tenant_deal_stage_history ADD COLUMN IF NOT EXISTS from_stage VARCHAR(80);
    ALTER TABLE tenant_deal_stage_history ADD COLUMN IF NOT EXISTS to_stage VARCHAR(80) DEFAULT 'qualification';
    ALTER TABLE tenant_deal_stage_history ADD COLUMN IF NOT EXISTS from_stage_id UUID;
    ALTER TABLE tenant_deal_stage_history ADD COLUMN IF NOT EXISTS to_stage_id UUID;
    ALTER TABLE tenant_deal_stage_history ADD COLUMN IF NOT EXISTS probability INTEGER NOT NULL DEFAULT 30;
    ALTER TABLE tenant_deal_stage_history ADD COLUMN IF NOT EXISTS amount_vnd BIGINT NOT NULL DEFAULT 0;
    ALTER TABLE tenant_deal_stage_history ADD COLUMN IF NOT EXISTS duration_seconds INTEGER NOT NULL DEFAULT 0;
    ALTER TABLE tenant_deal_stage_history ADD COLUMN IF NOT EXISTS note TEXT;
    ALTER TABLE tenant_deal_stage_history ADD COLUMN IF NOT EXISTS changed_by UUID;
    ALTER TABLE tenant_deal_stage_history ADD COLUMN IF NOT EXISTS changed_by_name VARCHAR(150);
    ALTER TABLE tenant_deal_stage_history ADD COLUMN IF NOT EXISTS metadata JSONB NOT NULL DEFAULT '{}'::jsonb;
    CREATE INDEX IF NOT EXISTS idx_deal_stage_hist_lookup ON tenant_deal_stage_history(tenant_id, deal_id, created_at DESC);

    -- 2. Dynamic Entity Tabs (Canonical definition merged into SECTION 11 above; retain additive columns & lookup index)
    ALTER TABLE tenant_entity_tabs ADD COLUMN IF NOT EXISTS entity_type VARCHAR(40) NOT NULL DEFAULT 'contact';
    ALTER TABLE tenant_entity_tabs ADD COLUMN IF NOT EXISTS tab_key VARCHAR(80);
    ALTER TABLE tenant_entity_tabs ADD COLUMN IF NOT EXISTS label VARCHAR(150) NOT NULL DEFAULT '';
    ALTER TABLE tenant_entity_tabs ADD COLUMN IF NOT EXISTS tab_label VARCHAR(150);
    ALTER TABLE tenant_entity_tabs ADD COLUMN IF NOT EXISTS icon_name VARCHAR(60) NOT NULL DEFAULT 'Layers';
    ALTER TABLE tenant_entity_tabs ADD COLUMN IF NOT EXISTS tab_type VARCHAR(30) NOT NULL DEFAULT 'fields';
    ALTER TABLE tenant_entity_tabs ADD COLUMN IF NOT EXISTS config_json JSONB NOT NULL DEFAULT '{}'::jsonb;
    ALTER TABLE tenant_entity_tabs ADD COLUMN IF NOT EXISTS allowed_role_ids JSONB NOT NULL DEFAULT '[]'::jsonb;
    ALTER TABLE tenant_entity_tabs ADD COLUMN IF NOT EXISTS sort_order INTEGER NOT NULL DEFAULT 0;
    ALTER TABLE tenant_entity_tabs ADD COLUMN IF NOT EXISTS fields_json JSONB NOT NULL DEFAULT '[]'::jsonb;
    ALTER TABLE tenant_entity_tabs ADD COLUMN IF NOT EXISTS allowed_roles JSONB NOT NULL DEFAULT '[]'::jsonb;
    ALTER TABLE tenant_entity_tabs ADD COLUMN IF NOT EXISTS is_active BOOLEAN NOT NULL DEFAULT true;
    ALTER TABLE tenant_entity_tabs ADD COLUMN IF NOT EXISTS created_by UUID;
    CREATE INDEX IF NOT EXISTS idx_entity_tabs_lookup ON tenant_entity_tabs(tenant_id, entity_type, is_active, sort_order ASC);

    -- 3. Global Custom Fields Studio (Canonical definition merged into SECTION 11 above; retain additive columns & lookup index)
    ALTER TABLE tenant_custom_fields ADD COLUMN IF NOT EXISTS entity_type VARCHAR(40) NOT NULL DEFAULT 'contact';
    ALTER TABLE tenant_custom_fields ADD COLUMN IF NOT EXISTS field_key VARCHAR(64);
    ALTER TABLE tenant_custom_fields ADD COLUMN IF NOT EXISTS field_label VARCHAR(150);
    ALTER TABLE tenant_custom_fields ADD COLUMN IF NOT EXISTS field_type VARCHAR(30) NOT NULL DEFAULT 'text';
    ALTER TABLE tenant_custom_fields ADD COLUMN IF NOT EXISTS is_required BOOLEAN NOT NULL DEFAULT false;
    ALTER TABLE tenant_custom_fields ADD COLUMN IF NOT EXISTS options_json JSONB NOT NULL DEFAULT '[]'::jsonb;
    ALTER TABLE tenant_custom_fields ADD COLUMN IF NOT EXISTS sort_order INTEGER NOT NULL DEFAULT 0;
    ALTER TABLE tenant_custom_fields ADD COLUMN IF NOT EXISTS is_active BOOLEAN NOT NULL DEFAULT true;
    CREATE INDEX IF NOT EXISTS idx_custom_fields_lookup ON tenant_custom_fields(tenant_id, entity_type, is_active, sort_order ASC);

    -- 4. Unified Omnichannel CRM Activities
    CREATE TABLE IF NOT EXISTS tenant_crm_activities (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
      activity_type VARCHAR(40) NOT NULL DEFAULT 'note',
      subject VARCHAR(255) NOT NULL,
      body TEXT,
      status VARCHAR(30) NOT NULL DEFAULT 'planned',
      priority VARCHAR(20) NOT NULL DEFAULT 'medium',
      due_date TIMESTAMPTZ,
      completed_at TIMESTAMPTZ,
      duration_minutes INTEGER NOT NULL DEFAULT 15,
      lead_id UUID,
      company_id UUID,
      deal_id UUID,
      task_id UUID,
      owner_user_id UUID,
      owner_name VARCHAR(150),
      mentions_json JSONB NOT NULL DEFAULT '[]'::jsonb,
      edit_history_json JSONB NOT NULL DEFAULT '[]'::jsonb,
      metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
      created_by UUID,
      created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
      CONSTRAINT uk_tenant_crm_activities_tenant_id UNIQUE (tenant_id, id)
    );
    CREATE INDEX IF NOT EXISTS idx_crm_act_tenant_created ON tenant_crm_activities(tenant_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_crm_act_lead ON tenant_crm_activities(tenant_id, lead_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_crm_act_deal ON tenant_crm_activities(tenant_id, deal_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_crm_act_company ON tenant_crm_activities(tenant_id, company_id, created_at DESC);

    -- 5. Task Dependencies (Canonical definition merged into ERP-Ops section above; retain additive columns & lookup index)
    ALTER TABLE tenant_task_dependencies ADD COLUMN IF NOT EXISTS project_id UUID;
    ALTER TABLE tenant_task_dependencies ADD COLUMN IF NOT EXISTS predecessor_task_id UUID;
    ALTER TABLE tenant_task_dependencies ADD COLUMN IF NOT EXISTS depends_on_task_id UUID;
    ALTER TABLE tenant_task_dependencies ADD COLUMN IF NOT EXISTS dependency_type VARCHAR(30) NOT NULL DEFAULT 'blocked_by';
    ALTER TABLE tenant_task_dependencies ADD COLUMN IF NOT EXISTS note TEXT;
    ALTER TABLE tenant_task_dependencies ADD COLUMN IF NOT EXISTS created_by UUID;
    CREATE INDEX IF NOT EXISTS idx_task_deps_lookup ON tenant_task_dependencies(tenant_id, task_id);

    -- 6. Task @Mention Comments (Canonical definition merged into ERP-Ops section above; retain additive columns & lookup index)
    ALTER TABLE tenant_task_comments ADD COLUMN IF NOT EXISTS author_user_id UUID;
    ALTER TABLE tenant_task_comments ADD COLUMN IF NOT EXISTS author_name VARCHAR(150) NOT NULL DEFAULT 'Thành viên';
    ALTER TABLE tenant_task_comments ADD COLUMN IF NOT EXISTS mentions_json JSONB NOT NULL DEFAULT '[]'::jsonb;
    ALTER TABLE tenant_task_comments ADD COLUMN IF NOT EXISTS attachments_json JSONB NOT NULL DEFAULT '[]'::jsonb;
    ALTER TABLE tenant_task_comments ADD COLUMN IF NOT EXISTS edit_history_json JSONB NOT NULL DEFAULT '[]'::jsonb;
    CREATE INDEX IF NOT EXISTS idx_task_comments_lookup ON tenant_task_comments(tenant_id, task_id, created_at ASC);

    -- 7. Task Attachments (Canonical definition merged into ERP-Ops section above; retain additive columns & lookup index)
    ALTER TABLE tenant_task_attachments ADD COLUMN IF NOT EXISTS file_name VARCHAR(255) DEFAULT 'attachment';
    ALTER TABLE tenant_task_attachments ADD COLUMN IF NOT EXISTS file_url TEXT DEFAULT '';
    ALTER TABLE tenant_task_attachments ADD COLUMN IF NOT EXISTS mime_type VARCHAR(120) NOT NULL DEFAULT 'application/octet-stream';
    ALTER TABLE tenant_task_attachments ADD COLUMN IF NOT EXISTS size_bytes BIGINT NOT NULL DEFAULT 0;
    ALTER TABLE tenant_task_attachments ADD COLUMN IF NOT EXISTS cloud_file_id UUID;
    ALTER TABLE tenant_task_attachments ADD COLUMN IF NOT EXISTS uploaded_by UUID;
    ALTER TABLE tenant_task_attachments ADD COLUMN IF NOT EXISTS uploaded_by_name VARCHAR(150);
    CREATE INDEX IF NOT EXISTS idx_task_attachments_lookup ON tenant_task_attachments(tenant_id, task_id, created_at DESC);

    -- 8. Personal Workspace Task Groups & Preferences
    CREATE TABLE IF NOT EXISTS tenant_workspace_task_groups (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
      user_id UUID NOT NULL,
      name VARCHAR(120) NOT NULL,
      color_hex VARCHAR(20) NOT NULL DEFAULT '#1E40FF',
      icon_name VARCHAR(50) NOT NULL DEFAULT 'Folder',
      sort_order INTEGER NOT NULL DEFAULT 0,
      is_pinned BOOLEAN NOT NULL DEFAULT false,
      created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
      CONSTRAINT uk_tenant_ws_task_groups_tenant_id UNIQUE (tenant_id, id)
    );
    CREATE INDEX IF NOT EXISTS idx_ws_task_groups_user ON tenant_workspace_task_groups(tenant_id, user_id, is_pinned DESC, sort_order ASC);

    CREATE TABLE IF NOT EXISTS tenant_workspace_preferences (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
      user_id UUID NOT NULL,
      wallpaper_url TEXT NOT NULL DEFAULT '',
      grid_columns INTEGER NOT NULL DEFAULT 3,
      overlay_opacity INTEGER NOT NULL DEFAULT 15,
      hide_completed BOOLEAN NOT NULL DEFAULT false,
      settings_json JSONB NOT NULL DEFAULT '{}'::jsonb,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
      CONSTRAINT uk_tenant_ws_prefs_user UNIQUE (tenant_id, user_id)
    );

    -- 9. Entity Cloud Files Linker (Contact / Company / Deal)
    CREATE TABLE IF NOT EXISTS tenant_contact_files (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
      entity_type VARCHAR(30) NOT NULL DEFAULT 'contact',
      entity_id UUID NOT NULL,
      cloud_file_id UUID,
      file_name VARCHAR(255) NOT NULL,
      file_url TEXT NOT NULL,
      mime_type VARCHAR(120) NOT NULL DEFAULT 'application/octet-stream',
      size_bytes BIGINT NOT NULL DEFAULT 0,
      category VARCHAR(80) NOT NULL DEFAULT 'general',
      uploaded_by UUID,
      uploaded_by_name VARCHAR(150),
      created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
      CONSTRAINT uk_tenant_contact_files_tenant_id UNIQUE (tenant_id, id)
    );
    CREATE INDEX IF NOT EXISTS idx_contact_files_entity ON tenant_contact_files(tenant_id, entity_type, entity_id, created_at DESC);

    -- 10. Invoices (Canonical definition merged into ERP-Ops section above; retain additive columns & lead index)
    ALTER TABLE tenant_invoices ADD COLUMN IF NOT EXISTS deal_id UUID;
    ALTER TABLE tenant_invoices ADD COLUMN IF NOT EXISTS lead_id UUID;
    ALTER TABLE tenant_invoices ADD COLUMN IF NOT EXISTS company_id UUID;
    ALTER TABLE tenant_invoices ADD COLUMN IF NOT EXISTS tax_code VARCHAR(50);
    ALTER TABLE tenant_invoices ADD COLUMN IF NOT EXISTS issued_at TIMESTAMPTZ DEFAULT clock_timestamp();
    ALTER TABLE tenant_invoices ADD COLUMN IF NOT EXISTS items_json JSONB NOT NULL DEFAULT '[]'::jsonb;
    CREATE INDEX IF NOT EXISTS idx_crm360_invoices_lead ON tenant_invoices(tenant_id, lead_id, created_at DESC);

    -- ENABLE & FORCE ROW LEVEL SECURITY + autodata_app GRANTS
    DO $$
    DECLARE
      tbl TEXT;
      pol TEXT;
    BEGIN
      FOREACH tbl IN ARRAY ARRAY[
        'tenant_deal_stage_history',
        'tenant_entity_tabs',
        'tenant_custom_fields',
        'tenant_crm_activities',
        'tenant_task_dependencies',
        'tenant_task_comments',
        'tenant_task_attachments',
        'tenant_workspace_task_groups',
        'tenant_workspace_preferences',
        'tenant_contact_files',
        'tenant_invoices'
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
          'tenant_deal_stage_history',
          'tenant_entity_tabs',
          'tenant_custom_fields',
          'tenant_crm_activities',
          'tenant_task_dependencies',
          'tenant_task_comments',
          'tenant_task_attachments',
          'tenant_workspace_task_groups',
          'tenant_workspace_preferences',
          'tenant_contact_files',
          'tenant_invoices'
        ]
        LOOP
          EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON %I TO autodata_app', tbl);
        END LOOP;
      END IF;
    EXCEPTION
      WHEN insufficient_privilege THEN
        NULL;
    END $$;

ALTER TABLE IF EXISTS tenant_cron_runs ALTER COLUMN tenant_id DROP NOT NULL;

-- =============================================================================

-- SECTION 12: FULL-CLONE STAGE 1-4 KERNEL ALTERATIONS, INFRA TABLES & RLS

-- =============================================================================

-- Full-Clone Stage 1-4 Alterations (RBAC Screen Access + Branch Whitelist & Manager)
ALTER TABLE tenant_roles ADD COLUMN IF NOT EXISTS screen_access JSONB NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE tenant_roles ADD COLUMN IF NOT EXISTS quick_actions JSONB NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE tenant_roles ADD COLUMN IF NOT EXISTS default_route VARCHAR(120);

ALTER TABLE tenant_role_permissions ADD COLUMN IF NOT EXISTS screen_access JSONB NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE tenant_role_permissions ADD COLUMN IF NOT EXISTS quick_actions JSONB NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE tenant_role_permissions ADD COLUMN IF NOT EXISTS default_route VARCHAR(120);

ALTER TABLE tenant_branches ADD COLUMN IF NOT EXISTS branch_ip_whitelist JSONB NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE tenant_branches ADD COLUMN IF NOT EXISTS manager_user_id UUID;

-- Note: Attendance Wave A tables, Org-RBAC Settings + tenant_cron_runs, CRM-360 tenant_deal_stage_history,
-- HRM cooperation/accounting, ERP-Ops item/invoice/pos/task tables, and Marketing tables are created canonically
-- by their respective ensure*Schema() module initializers at the end of runDatabaseMigrations().

CREATE TABLE IF NOT EXISTS tenant_domain_events_outbox (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  event_type VARCHAR(120) NOT NULL,
  aggregate_type VARCHAR(80) NOT NULL DEFAULT 'system',
  aggregate_id VARCHAR(120),
  payload_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  status VARCHAR(30) NOT NULL DEFAULT 'pending',
  retry_count INTEGER NOT NULL DEFAULT 0,
  max_retries INTEGER NOT NULL DEFAULT 5,
  next_retry_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  processed_at TIMESTAMPTZ,
  last_error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX IF NOT EXISTS idx_outbox_pending ON tenant_domain_events_outbox(tenant_id, status, next_retry_at);

CREATE TABLE IF NOT EXISTS tenant_user_notification_settings (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  user_id UUID NOT NULL,
  channels_json JSONB NOT NULL DEFAULT '{"in_app":true,"email":true,"zalo":true}'::jsonb,
  events_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  quiet_hours_start VARCHAR(10),
  quiet_hours_end VARCHAR(10),
  mute_all BOOLEAN NOT NULL DEFAULT false,
  settings_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT uk_user_notif_settings UNIQUE (tenant_id, user_id)
);

CREATE TABLE IF NOT EXISTS crm_public_leads_pool (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  lead_id UUID NOT NULL,
  branch_id UUID,
  released_by UUID,
  release_reason TEXT,
  pool_status VARCHAR(30) NOT NULL DEFAULT 'available',
  claimed_by UUID,
  claimed_at TIMESTAMPTZ,
  expires_at TIMESTAMPTZ,
  metadata_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT uk_public_pool_lead UNIQUE (tenant_id, lead_id)
);
CREATE INDEX IF NOT EXISTS idx_public_pool_status ON crm_public_leads_pool(tenant_id, pool_status, created_at DESC);

CREATE TABLE IF NOT EXISTS tenant_geoip_blocks (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  rule_type VARCHAR(30) NOT NULL DEFAULT 'country',
  target_value VARCHAR(120) NOT NULL,
  action_mode VARCHAR(30) NOT NULL DEFAULT 'block',
  reason TEXT,
  is_active BOOLEAN NOT NULL DEFAULT true,
  hit_count INTEGER NOT NULL DEFAULT 0,
  created_by UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX IF NOT EXISTS idx_geoip_blocks_active ON tenant_geoip_blocks(tenant_id, is_active, rule_type);

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
    'tenant_audience_members', 'tenant_audience_exclusions', 'tenant_tags', 'lead_tags',
    'tenant_domain_events_outbox', 'tenant_user_notification_settings',
    'crm_public_leads_pool', 'tenant_geoip_blocks'
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
