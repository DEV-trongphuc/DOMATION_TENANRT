-- ============================================================================
-- AUTO DATA MULTI-TENANT SAAS - MARIADB 10.6 PRODUCTION DDL (AZDIGI vhvxoigh_data)
-- Engine: MariaDB 10.6.28 (InnoDB, utf8mb4_unicode_ci)
-- ============================================================================

CREATE TABLE IF NOT EXISTS platform_superadmins (
    id VARCHAR(36) NOT NULL PRIMARY KEY DEFAULT (UUID()),
    email VARCHAR(255) NOT NULL UNIQUE,
    password_hash VARCHAR(255) NOT NULL,
    full_name VARCHAR(255) NOT NULL,
    role VARCHAR(31) NOT NULL DEFAULT 'super_admin',
    is_active TINYINT(1) NOT NULL DEFAULT 1,
    created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
    last_login_at DATETIME(6) NULL,
    INDEX idx_platform_superadmins_email (email)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS platform_settings (
    setting_key VARCHAR(100) NOT NULL PRIMARY KEY,
    setting_value JSON NOT NULL,
    updated_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS global_accounts (
    id VARCHAR(36) NOT NULL PRIMARY KEY DEFAULT (UUID()),
    email VARCHAR(255) NOT NULL UNIQUE,
    password_hash VARCHAR(255) NOT NULL,
    full_name VARCHAR(150) NOT NULL,
    phone VARCHAR(30) NULL,
    is_active TINYINT(1) NOT NULL DEFAULT 1,
    last_login_at DATETIME(6) NULL,
    created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
    updated_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
    INDEX idx_global_accounts_email (email),
    INDEX idx_global_accounts_phone (phone)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS tenants (
    id VARCHAR(36) NOT NULL PRIMARY KEY DEFAULT (UUID()),
    slug VARCHAR(63) NOT NULL UNIQUE,
    obfuscated_slug VARCHAR(64) NULL UNIQUE,
    name VARCHAR(255) NOT NULL,
    domain VARCHAR(255) NULL UNIQUE,
    industry VARCHAR(100) NOT NULL DEFAULT 'general',
    industry_key VARCHAR(64) NOT NULL DEFAULT 'general',
    package_code VARCHAR(50) NOT NULL DEFAULT 'autodata_crm',
    plan_tier VARCHAR(50) NOT NULL DEFAULT 'starter',
    enabled_modules JSON NULL,
    entitlements JSON NULL,
    status VARCHAR(50) NOT NULL DEFAULT 'active',
    trial_ends_at DATETIME(6) NULL,
    subscription_expires_at DATETIME(6) NULL,
    subscription_plan_code VARCHAR(80) NOT NULL DEFAULT 'trial_1m',
    billing_cycle VARCHAR(30) NOT NULL DEFAULT 'trial',
    wallet_balance_vnd BIGINT NOT NULL DEFAULT 0,
    crm_erp_upgrade_status VARCHAR(50) NOT NULL DEFAULT 'none',
    settings JSON NOT NULL,
    created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
    updated_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
    INDEX idx_tenants_slug (slug),
    INDEX idx_tenants_obfuscated_slug (obfuscated_slug),
    INDEX idx_tenants_status (status)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS tenant_onboarding_progress (
    id VARCHAR(36) NOT NULL PRIMARY KEY DEFAULT (UUID()),
    tenant_id VARCHAR(36) NOT NULL UNIQUE,
    current_step INT NOT NULL DEFAULT 1,
    completed_steps JSON NOT NULL,
    screen_tours JSON NOT NULL,
    is_completed TINYINT(1) NOT NULL DEFAULT 0,
    dismissed_at DATETIME(6) NULL,
    created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
    updated_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
    CONSTRAINT fk_onboarding_tenant FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS users (
    id VARCHAR(36) NOT NULL PRIMARY KEY DEFAULT (UUID()),
    account_id VARCHAR(36) NULL,
    tenant_id VARCHAR(36) NOT NULL,
    email VARCHAR(255) NOT NULL,
    password_hash VARCHAR(255) NOT NULL,
    full_name VARCHAR(150) NOT NULL,
    phone VARCHAR(30) NULL,
    role VARCHAR(50) NOT NULL,
    role_id VARCHAR(36) NULL,
    branch_id VARCHAR(36) NULL,
    department_id VARCHAR(36) NULL,
    team_id VARCHAR(36) NULL,
    position_id VARCHAR(36) NULL,
    reports_to_user_id VARCHAR(36) NULL,
    is_tenant_owner TINYINT(1) NOT NULL DEFAULT 0,
    is_system_bot TINYINT(1) NOT NULL DEFAULT 0,
    is_external_agency TINYINT(1) NOT NULL DEFAULT 0,
    avatar_url TEXT NULL,
    last_login_at DATETIME(6) NULL,
    created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
    updated_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
    CONSTRAINT uk_users_tenant_email UNIQUE (tenant_id, email),
    CONSTRAINT uk_users_tenant_id UNIQUE (tenant_id, id),
    CONSTRAINT fk_users_tenant FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE,
    CONSTRAINT fk_users_account FOREIGN KEY (account_id) REFERENCES global_accounts(id) ON DELETE CASCADE,
    INDEX idx_users_account_id (account_id),
    INDEX idx_users_tenant_role (tenant_id, role),
    INDEX idx_users_email (email)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS tenant_user_profiles (
    id VARCHAR(36) NOT NULL PRIMARY KEY DEFAULT (UUID()),
    tenant_id VARCHAR(36) NOT NULL,
    user_id VARCHAR(36) NOT NULL,
    status VARCHAR(30) NOT NULL DEFAULT 'active',
    is_available TINYINT(1) NOT NULL DEFAULT 1,
    vacation_mode TINYINT(1) NOT NULL DEFAULT 0,
    skipped_credit INT NOT NULL DEFAULT 0,
    work_schedule JSON NOT NULL,
    zalo_chat_id VARCHAR(100) NULL,
    zalo_user_id VARCHAR(100) NULL,
    is_silent TINYINT(1) NOT NULL DEFAULT 0,
    invite_status VARCHAR(30) NOT NULL DEFAULT 'joined',
    sheet_sync_url TEXT NULL,
    sheet_tab_name VARCHAR(150) NULL,
    skip_count INT NOT NULL DEFAULT 0,
    current_turn_remaining INT NOT NULL DEFAULT 0,
    hourly_leads_count INT NOT NULL DEFAULT 0,
    hourly_window_start DATETIME(6) NULL,
    created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
    updated_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
    CONSTRAINT uk_user_profile UNIQUE (tenant_id, user_id),
    CONSTRAINT fk_user_profile_user FOREIGN KEY (tenant_id, user_id) REFERENCES users(tenant_id, id) ON DELETE CASCADE,
    INDEX idx_user_profiles_dispatch (tenant_id, status, is_available, vacation_mode)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS tenant_pipelines (
    id VARCHAR(36) NOT NULL PRIMARY KEY DEFAULT (UUID()),
    tenant_id VARCHAR(36) NOT NULL,
    name VARCHAR(150) NOT NULL,
    description TEXT NULL,
    is_default TINYINT(1) NOT NULL DEFAULT 0,
    created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
    updated_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
    CONSTRAINT uk_pipelines_tenant_id UNIQUE (tenant_id, id),
    CONSTRAINT fk_pipelines_tenant FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE,
    INDEX idx_pipelines_tenant (tenant_id, is_default)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS tenant_pipeline_stages (
    id VARCHAR(36) NOT NULL PRIMARY KEY DEFAULT (UUID()),
    tenant_id VARCHAR(36) NOT NULL,
    pipeline_id VARCHAR(36) NOT NULL,
    stage_key VARCHAR(63) NOT NULL,
    stage_name VARCHAR(150) NOT NULL,
    stage_order INT NOT NULL DEFAULT 0,
    color_hex VARCHAR(20) NOT NULL DEFAULT '#1E40FF',
    badge_style JSON NOT NULL,
    is_won_stage TINYINT(1) NOT NULL DEFAULT 0,
    is_lost_stage TINYINT(1) NOT NULL DEFAULT 0,
    sla_timeout_minutes INT NOT NULL DEFAULT 0,
    sla_escalation_role VARCHAR(50) NOT NULL DEFAULT 'manager',
    funnel_category VARCHAR(40) NOT NULL DEFAULT 'engaged_qualified',
    score_delta INT NOT NULL DEFAULT 0,
    required_fields JSON NULL,
    capi_event_mapping VARCHAR(100) NOT NULL DEFAULT 'Skip',
    zalo_notify_template_id VARCHAR(36) NULL,
    created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
    updated_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
    CONSTRAINT uk_pipeline_stage_key UNIQUE (tenant_id, pipeline_id, stage_key),
    CONSTRAINT uk_pipeline_stages_tenant_id UNIQUE (tenant_id, id),
    CONSTRAINT fk_stages_pipeline FOREIGN KEY (tenant_id, pipeline_id) REFERENCES tenant_pipelines(tenant_id, id) ON DELETE CASCADE,
    INDEX idx_pipeline_stages_order (tenant_id, pipeline_id, stage_order ASC)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS tenant_pipeline_custom_fields (
    id VARCHAR(36) NOT NULL PRIMARY KEY DEFAULT (UUID()),
    tenant_id VARCHAR(36) NOT NULL,
    pipeline_id VARCHAR(36) NOT NULL,
    field_key VARCHAR(63) NOT NULL,
    field_label VARCHAR(150) NOT NULL,
    field_type VARCHAR(30) NOT NULL,
    is_required TINYINT(1) NOT NULL DEFAULT 0,
    options_json JSON NOT NULL,
    stage_visibility JSON NOT NULL,
    config_json JSON NOT NULL,
    created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
    updated_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
    CONSTRAINT uk_pipeline_field_key UNIQUE (tenant_id, pipeline_id, field_key),
    CONSTRAINT fk_custom_fields_pipeline FOREIGN KEY (tenant_id, pipeline_id) REFERENCES tenant_pipelines(tenant_id, id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS distribution_rounds (
    id VARCHAR(36) NOT NULL PRIMARY KEY DEFAULT (UUID()),
    tenant_id VARCHAR(36) NOT NULL,
    pipeline_id VARCHAR(36) NOT NULL,
    name VARCHAR(150) NOT NULL,
    description TEXT NULL,
    cc_emails TEXT NULL,
    last_assigned_consultant_id VARCHAR(36) NULL,
    priority INT NOT NULL DEFAULT 1,
    is_active TINYINT(1) NOT NULL DEFAULT 1,
    created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
    updated_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
    CONSTRAINT uk_rounds_tenant_id UNIQUE (tenant_id, id),
    CONSTRAINT fk_rounds_pipeline FOREIGN KEY (tenant_id, pipeline_id) REFERENCES tenant_pipelines(tenant_id, id) ON DELETE CASCADE,
    INDEX idx_dist_rounds_tenant (tenant_id, is_active, priority ASC)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS round_consultants (
    id VARCHAR(36) NOT NULL PRIMARY KEY DEFAULT (UUID()),
    tenant_id VARCHAR(36) NOT NULL,
    round_id VARCHAR(36) NOT NULL,
    user_id VARCHAR(36) NOT NULL,
    is_active TINYINT(1) NOT NULL DEFAULT 1,
    receive_ratio INT NOT NULL DEFAULT 1,
    data_per_turn INT NOT NULL DEFAULT 1,
    current_turn_remaining INT NOT NULL DEFAULT 0,
    leads_received_in_round INT NOT NULL DEFAULT 0,
    compensation_count INT NOT NULL DEFAULT 0,
    skip_count INT NOT NULL DEFAULT 0,
    skipped_credit INT NOT NULL DEFAULT 0,
    created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
    updated_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
    CONSTRAINT uk_round_user UNIQUE (tenant_id, round_id, user_id),
    CONSTRAINT fk_round_consultants_round FOREIGN KEY (tenant_id, round_id) REFERENCES distribution_rounds(tenant_id, id) ON DELETE CASCADE,
    CONSTRAINT fk_round_consultants_user FOREIGN KEY (tenant_id, user_id) REFERENCES users(tenant_id, id) ON DELETE CASCADE,
    INDEX idx_round_consultants_weights (tenant_id, round_id, compensation_count DESC, leads_received_in_round ASC)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS routing_rules (
    id VARCHAR(36) NOT NULL PRIMARY KEY DEFAULT (UUID()),
    tenant_id VARCHAR(36) NOT NULL,
    round_id VARCHAR(36) NOT NULL,
    rule_name VARCHAR(150) NOT NULL,
    priority INT NOT NULL DEFAULT 1,
    conditions_json JSON NOT NULL,
    condition_branches JSON NOT NULL,
    connection_scopes JSON NOT NULL,
    inject_fields JSON NOT NULL,
    is_active TINYINT(1) NOT NULL DEFAULT 1,
    created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
    updated_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
    CONSTRAINT fk_routing_rules_round FOREIGN KEY (tenant_id, round_id) REFERENCES distribution_rounds(tenant_id, id) ON DELETE CASCADE,
    INDEX idx_routing_rules_priority (tenant_id, is_active, priority ASC)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS leads (
    id VARCHAR(36) NOT NULL PRIMARY KEY DEFAULT (UUID()),
    tenant_id VARCHAR(36) NOT NULL,
    pipeline_id VARCHAR(36) NULL,
    stage_id VARCHAR(36) NULL,
    assigned_to VARCHAR(36) NULL,
    round_id VARCHAR(36) NULL,
    connection_id VARCHAR(36) NULL,
    status VARCHAR(50) NOT NULL DEFAULT 'unassigned_pending',
    lifecycle_stage VARCHAR(40) NOT NULL DEFAULT 'lead',
    name VARCHAR(150) NOT NULL,
    phone VARCHAR(30) NULL,
    email VARCHAR(255) NULL,
    lead_score INT NOT NULL DEFAULT 0,
    email_consent VARCHAR(30) NOT NULL DEFAULT 'subscribed',
    zns_consent VARCHAR(30) NOT NULL DEFAULT 'opted_in',
    total_revenue_vnd BIGINT NOT NULL DEFAULT 0,
    last_engaged_at DATETIME(6) NULL,
    source VARCHAR(100) NOT NULL DEFAULT 'Webhook',
    campaign VARCHAR(150) NULL,
    product_interest VARCHAR(255) NULL,
    budget_range VARCHAR(120) NULL,
    utm_source VARCHAR(100) NULL,
    utm_medium VARCHAR(100) NULL,
    utm_content VARCHAR(150) NULL,
    ad_id VARCHAR(100) NULL,
    adset_id VARCHAR(100) NULL,
    campaign_id VARCHAR(100) NULL,
    form_id VARCHAR(100) NULL,
    meta_lead_id VARCHAR(100) NULL,
    fbclid VARCHAR(255) NULL,
    fbc VARCHAR(255) NULL,
    fbp VARCHAR(255) NULL,
    custom_fields JSON NOT NULL,
    is_accepted TINYINT(1) NOT NULL DEFAULT 0,
    accepted_at DATETIME(6) NULL,
    sla_breached TINYINT(1) NOT NULL DEFAULT 0,
    is_duplicate_reminder TINYINT(1) NOT NULL DEFAULT 0,
    is_duplicated TINYINT(1) NOT NULL DEFAULT 0,
    duplicate_of_lead_id VARCHAR(36) NULL,
    batch_id VARCHAR(36) NULL,
    is_deleted TINYINT(1) NOT NULL DEFAULT 0,
    ai_screener_status VARCHAR(40) NOT NULL DEFAULT 'not_screened',
    ai_evaluation TEXT NULL,
    ai_prompt_tokens INT NOT NULL DEFAULT 0,
    ai_completion_tokens INT NOT NULL DEFAULT 0,
    zalo_notify_status VARCHAR(40) NOT NULL DEFAULT 'none',
    email_notify_status VARCHAR(40) NOT NULL DEFAULT 'none',
    quality_status VARCHAR(50) NOT NULL DEFAULT 'Pending',
    quality_note TEXT NULL,
    created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
    updated_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
    CONSTRAINT uk_leads_tenant_id UNIQUE (tenant_id, id),
    CONSTRAINT fk_leads_tenant FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE,
    CONSTRAINT fk_leads_pipeline FOREIGN KEY (tenant_id, pipeline_id) REFERENCES tenant_pipelines(tenant_id, id) ON DELETE RESTRICT,
    CONSTRAINT fk_leads_stage FOREIGN KEY (tenant_id, stage_id) REFERENCES tenant_pipeline_stages(tenant_id, id) ON DELETE RESTRICT,
    CONSTRAINT fk_leads_assigned FOREIGN KEY (tenant_id, assigned_to) REFERENCES users(tenant_id, id) ON DELETE SET NULL,
    -- Composite Indexes
    INDEX idx_leads_tenant_phone_created (tenant_id, phone, created_at DESC),
    INDEX idx_leads_sla_sweep (tenant_id, is_accepted, sla_breached, stage_id),
    INDEX idx_leads_tenant_phone (tenant_id, phone),
    INDEX idx_leads_tenant_stage (tenant_id, stage_id),
    INDEX idx_leads_tenant_status (tenant_id, status),
    INDEX idx_leads_tenant_assigned (tenant_id, assigned_to),
    INDEX idx_leads_tenant_created (tenant_id, created_at DESC),
    INDEX idx_leads_tenant_assigned_status_created (tenant_id, assigned_to, status, created_at DESC),
    INDEX idx_leads_tenant_round_created (tenant_id, round_id, created_at DESC),
    INDEX idx_leads_tenant_campaign_ad (tenant_id, campaign_id, ad_id),
    INDEX idx_leads_tenant_pipeline_created (tenant_id, pipeline_id, created_at DESC)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS lead_timeline_events (
    id VARCHAR(36) NOT NULL PRIMARY KEY DEFAULT (UUID()),
    tenant_id VARCHAR(36) NOT NULL,
    lead_id VARCHAR(36) NOT NULL,
    event_type VARCHAR(100) NOT NULL,
    event_category VARCHAR(30) NOT NULL,
    actor_id VARCHAR(36) NULL,
    actor_role VARCHAR(30) NOT NULL,
    actor_name VARCHAR(150) NULL,
    title VARCHAR(255) NOT NULL,
    content TEXT NULL,
    metadata JSON NOT NULL,
    created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
    CONSTRAINT fk_timeline_lead FOREIGN KEY (tenant_id, lead_id) REFERENCES leads(tenant_id, id) ON DELETE CASCADE,
    CONSTRAINT fk_timeline_actor FOREIGN KEY (tenant_id, actor_id) REFERENCES users(tenant_id, id) ON DELETE SET NULL,
    INDEX idx_timeline_events_lookup (tenant_id, lead_id, created_at DESC),
    INDEX idx_timeline_tenant_type_created (tenant_id, event_type, created_at DESC)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS tenant_integrations (
    id VARCHAR(36) NOT NULL PRIMARY KEY DEFAULT (UUID()),
    tenant_id VARCHAR(36) NOT NULL,
    integration_type VARCHAR(50) NOT NULL,
    config_encrypted TEXT NOT NULL,
    iv VARCHAR(64) NOT NULL,
    auth_tag VARCHAR(64) NOT NULL,
    status VARCHAR(30) NOT NULL DEFAULT 'active',
    token_expires_at DATETIME(6) NULL,
    last_synced_at DATETIME(6) NULL,
    created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
    updated_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
    CONSTRAINT uk_tenant_integration UNIQUE (tenant_id, integration_type),
    CONSTRAINT fk_integrations_tenant FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS tenant_webhooks (
    id VARCHAR(36) NOT NULL PRIMARY KEY DEFAULT (UUID()),
    tenant_id VARCHAR(36) NOT NULL,
    name VARCHAR(150) NOT NULL,
    webhook_type VARCHAR(30) NOT NULL,
    url TEXT NULL,
    token VARCHAR(128) NOT NULL UNIQUE,
    signing_secret VARCHAR(255) NOT NULL,
    field_mappings JSON NOT NULL,
    subscribed_events JSON NOT NULL,
    is_active TINYINT(1) NOT NULL DEFAULT 1,
    created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
    updated_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
    CONSTRAINT uk_webhooks_tenant_id UNIQUE (tenant_id, id),
    CONSTRAINT fk_webhooks_tenant FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE,
    INDEX idx_tenant_webhooks (tenant_id, webhook_type, is_active)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS tenant_webhook_dlq (
    id VARCHAR(36) NOT NULL PRIMARY KEY DEFAULT (UUID()),
    tenant_id VARCHAR(36) NOT NULL,
    webhook_id VARCHAR(36) NOT NULL,
    event_type VARCHAR(100) NOT NULL,
    delivery_id VARCHAR(100) NOT NULL,
    payload JSON NOT NULL,
    error_trace TEXT NULL,
    retry_count INT NOT NULL DEFAULT 5,
    last_attempt_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
    created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
    CONSTRAINT fk_webhook_dlq_webhook FOREIGN KEY (tenant_id, webhook_id) REFERENCES tenant_webhooks(tenant_id, id) ON DELETE CASCADE,
    INDEX idx_webhook_dlq_tenant (tenant_id, created_at DESC)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS capi_logs (
    id VARCHAR(36) NOT NULL PRIMARY KEY DEFAULT (UUID()),
    tenant_id VARCHAR(36) NOT NULL,
    lead_id VARCHAR(36) NOT NULL,
    dataset_id VARCHAR(100) NOT NULL,
    event_name VARCHAR(100) NOT NULL,
    event_id VARCHAR(255) NOT NULL,
    action_source VARCHAR(50) NOT NULL,
    match_keys JSON NOT NULL,
    sent_payload JSON NOT NULL,
    response_status INT NOT NULL,
    response_body JSON NULL,
    sent_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
    CONSTRAINT fk_capi_logs_lead FOREIGN KEY (tenant_id, lead_id) REFERENCES leads(tenant_id, id) ON DELETE CASCADE,
    INDEX idx_capi_logs_lookup (tenant_id, lead_id, sent_at DESC),
    INDEX idx_capi_logs_tenant_sent (tenant_id, sent_at DESC)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS data_reports (
    id VARCHAR(36) NOT NULL PRIMARY KEY DEFAULT (UUID()),
    tenant_id VARCHAR(36) NOT NULL,
    lead_id VARCHAR(36) NOT NULL,
    reporter_id VARCHAR(36) NOT NULL,
    reason VARCHAR(100) NOT NULL,
    description TEXT NULL,
    status VARCHAR(30) NOT NULL DEFAULT 'pending',
    resolved_by VARCHAR(36) NULL,
    resolution_note TEXT NULL,
    compensation_granted TINYINT(1) NOT NULL DEFAULT 0,
    created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
    updated_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
    CONSTRAINT fk_data_reports_lead FOREIGN KEY (tenant_id, lead_id) REFERENCES leads(tenant_id, id) ON DELETE CASCADE,
    CONSTRAINT fk_data_reports_reporter FOREIGN KEY (tenant_id, reporter_id) REFERENCES users(tenant_id, id) ON DELETE CASCADE,
    CONSTRAINT fk_data_reports_resolver FOREIGN KEY (tenant_id, resolved_by) REFERENCES users(tenant_id, id) ON DELETE SET NULL,
    INDEX idx_data_reports_tenant (tenant_id, status, created_at DESC),
    INDEX idx_data_reports_tenant_created (tenant_id, created_at DESC)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS tenant_billing_transactions (
    id VARCHAR(36) NOT NULL PRIMARY KEY DEFAULT (UUID()),
    tenant_id VARCHAR(36) NOT NULL,
    tx_type VARCHAR(40) NOT NULL,
    plan_code VARCHAR(80) NULL,
    billing_cycle VARCHAR(30) NULL,
    months_added INT NOT NULL DEFAULT 0,
    amount_vnd BIGINT NOT NULL DEFAULT 0,
    discount_pct DECIMAL(5,2) NOT NULL DEFAULT 0,
    payment_method VARCHAR(40) NOT NULL DEFAULT 'bank_transfer',
    status VARCHAR(30) NOT NULL DEFAULT 'pending',
    reference_code VARCHAR(80) NULL,
    note TEXT NULL,
    metadata JSON NOT NULL,
    requested_by VARCHAR(36) NULL,
    processed_by VARCHAR(255) NULL,
    processed_at DATETIME(6) NULL,
    created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
    CONSTRAINT fk_billing_tenant FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE,
    INDEX idx_billing_tx_tenant_created (tenant_id, created_at DESC),
    INDEX idx_billing_tx_status_created (status, created_at DESC)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS consultant_managers (
    id VARCHAR(36) NOT NULL PRIMARY KEY DEFAULT (UUID()),
    tenant_id VARCHAR(36) NOT NULL,
    consultant_user_id VARCHAR(36) NOT NULL,
    name VARCHAR(150) NOT NULL,
    email VARCHAR(255) NOT NULL,
    phone VARCHAR(30) NULL,
    zalo_chat_id VARCHAR(100) NULL,
    zalo_verified TINYINT(1) NOT NULL DEFAULT 0,
    status VARCHAR(30) NOT NULL DEFAULT 'active',
    created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
    updated_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
    CONSTRAINT fk_cm_consultant FOREIGN KEY (tenant_id, consultant_user_id) REFERENCES users(tenant_id, id) ON DELETE CASCADE,
    INDEX idx_cm_tenant_consultant (tenant_id, consultant_user_id, status)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS personal_leads (
    id VARCHAR(36) NOT NULL PRIMARY KEY DEFAULT (UUID()),
    tenant_id VARCHAR(36) NOT NULL,
    owner_user_id VARCHAR(36) NOT NULL,
    name VARCHAR(150) NOT NULL,
    phone VARCHAR(30) NOT NULL,
    email VARCHAR(255) NULL,
    product_interest VARCHAR(255) NULL,
    note TEXT NULL,
    status VARCHAR(40) NOT NULL DEFAULT 'new',
    sheet_sync_status VARCHAR(255) NOT NULL DEFAULT 'Lưu nội bộ trên Cổng Sale Cá Nhân',
    quota_impact INT NOT NULL DEFAULT 0,
    sla_recall_exempt TINYINT(1) NOT NULL DEFAULT 1,
    custom_fields JSON NOT NULL,
    created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
    updated_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
    CONSTRAINT fk_pl_owner FOREIGN KEY (tenant_id, owner_user_id) REFERENCES users(tenant_id, id) ON DELETE CASCADE,
    INDEX idx_personal_leads_owner (tenant_id, owner_user_id, created_at DESC)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS ai_screener_configs (
    id VARCHAR(36) NOT NULL PRIMARY KEY DEFAULT (UUID()),
    tenant_id VARCHAR(36) NOT NULL UNIQUE,
    mode VARCHAR(20) NOT NULL DEFAULT 'ai',
    is_enabled TINYINT(1) NOT NULL DEFAULT 0,
    model_name VARCHAR(80) NOT NULL DEFAULT 'gemini-2.5-flash',
    prompt_rules TEXT NULL,
    manual_action VARCHAR(30) NOT NULL DEFAULT 'hold',
    manual_rules JSON NOT NULL,
    target_round_ids JSON NOT NULL,
    fallback_enabled TINYINT(1) NOT NULL DEFAULT 0,
    fallback_round_id VARCHAR(36) NULL,
    created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
    updated_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
    CONSTRAINT fk_ai_screener_tenant FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS held_leads (
    id VARCHAR(36) NOT NULL PRIMARY KEY DEFAULT (UUID()),
    tenant_id VARCHAR(36) NOT NULL,
    round_id VARCHAR(36) NULL,
    connection_id VARCHAR(36) NULL,
    name VARCHAR(150) NOT NULL,
    phone VARCHAR(30) NOT NULL,
    email VARCHAR(255) NULL,
    source VARCHAR(100) NOT NULL DEFAULT 'Webhook',
    campaign VARCHAR(150) NULL,
    ai_screener_status VARCHAR(40) NOT NULL DEFAULT 'failed',
    ai_evaluation TEXT NULL,
    hold_reason TEXT NULL,
    status VARCHAR(30) NOT NULL DEFAULT 'held',
    payload_json JSON NOT NULL,
    resolved_by VARCHAR(36) NULL,
    resolved_at DATETIME(6) NULL,
    created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
    updated_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
    CONSTRAINT fk_held_leads_tenant FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE,
    INDEX idx_held_leads_tenant_status (tenant_id, status, created_at DESC)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS blacklist_entries (
    id VARCHAR(36) NOT NULL PRIMARY KEY DEFAULT (UUID()),
    tenant_id VARCHAR(36) NOT NULL,
    entry_type VARCHAR(20) NOT NULL,
    value VARCHAR(255) NOT NULL,
    reason TEXT NULL,
    created_by VARCHAR(36) NULL,
    created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
    CONSTRAINT uk_blacklist_tenant_type_val UNIQUE (tenant_id, entry_type, value),
    CONSTRAINT fk_blacklist_tenant FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE,
    INDEX idx_blacklist_tenant_type (tenant_id, entry_type)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS meta_ads_insights (
    id VARCHAR(36) NOT NULL PRIMARY KEY DEFAULT (UUID()),
    tenant_id VARCHAR(36) NOT NULL,
    date_start DATE NOT NULL,
    date_stop DATE NOT NULL,
    campaign_id VARCHAR(100) NOT NULL,
    campaign_name VARCHAR(255) NULL,
    adset_id VARCHAR(100) NULL,
    adset_name VARCHAR(255) NULL,
    ad_id VARCHAR(100) NOT NULL,
    ad_name VARCHAR(255) NULL,
    spend DECIMAL(16,2) NOT NULL DEFAULT 0,
    impressions INT NOT NULL DEFAULT 0,
    clicks INT NOT NULL DEFAULT 0,
    reach INT NOT NULL DEFAULT 0,
    ctr DECIMAL(8,4) NOT NULL DEFAULT 0,
    cpc DECIMAL(14,2) NOT NULL DEFAULT 0,
    cpm DECIMAL(14,2) NOT NULL DEFAULT 0,
    frequency DECIMAL(8,2) NOT NULL DEFAULT 0,
    meta_leads INT NOT NULL DEFAULT 0,
    thumbnail_url TEXT NULL,
    image_url TEXT NULL,
    creative_title TEXT NULL,
    creative_body TEXT NULL,
    story_id VARCHAR(100) NULL,
    optimization_goal VARCHAR(100) NULL,
    created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
    updated_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
    CONSTRAINT uk_meta_ads_tenant_ad_date UNIQUE (tenant_id, ad_id, date_start, date_stop),
    CONSTRAINT fk_meta_ads_tenant FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE,
    INDEX idx_meta_ads_tenant_date (tenant_id, date_start DESC)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS lead_import_batches (
    id VARCHAR(36) NOT NULL PRIMARY KEY DEFAULT (UUID()),
    tenant_id VARCHAR(36) NOT NULL,
    file_name VARCHAR(255) NOT NULL,
    total_rows INT NOT NULL DEFAULT 0,
    imported_count INT NOT NULL DEFAULT 0,
    duplicate_count INT NOT NULL DEFAULT 0,
    skipped_count INT NOT NULL DEFAULT 0,
    is_silent TINYINT(1) NOT NULL DEFAULT 1,
    status VARCHAR(30) NOT NULL DEFAULT 'completed',
    imported_by VARCHAR(36) NULL,
    created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
    CONSTRAINT fk_import_batches_tenant FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE,
    INDEX idx_import_batches_tenant (tenant_id, created_at DESC)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS admin_audit_logs (
    id VARCHAR(36) NOT NULL PRIMARY KEY DEFAULT (UUID()),
    tenant_id VARCHAR(36) NOT NULL,
    actor_id VARCHAR(36) NULL,
    actor_name VARCHAR(150) NULL,
    action VARCHAR(100) NOT NULL,
    entity_type VARCHAR(60) NOT NULL,
    entity_id VARCHAR(100) NULL,
    before_snapshot JSON NOT NULL,
    after_snapshot JSON NOT NULL,
    details JSON NOT NULL,
    ip_address VARCHAR(64) NULL,
    is_rolled_back TINYINT(1) NOT NULL DEFAULT 0,
    rolled_back_at DATETIME(6) NULL,
    rolled_back_by VARCHAR(36) NULL,
    created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
    CONSTRAINT fk_admin_audit_tenant FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE,
    INDEX idx_admin_audit_tenant_created (tenant_id, created_at DESC)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS active_compensation_logs (
    id VARCHAR(36) NOT NULL PRIMARY KEY DEFAULT (UUID()),
    tenant_id VARCHAR(36) NOT NULL,
    round_id VARCHAR(36) NOT NULL,
    consultant_user_id VARCHAR(36) NOT NULL,
    admin_user_id VARCHAR(36) NULL,
    ticket_id VARCHAR(36) NULL,
    amount INT NOT NULL,
    reason VARCHAR(255) NULL,
    source_type VARCHAR(40) NOT NULL DEFAULT 'manual',
    created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
    CONSTRAINT fk_comp_logs_tenant FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE,
    INDEX idx_comp_logs_tenant_created (tenant_id, created_at DESC)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;


-- ============================================================================
-- WAVE 1 MULTI-PRODUCT SAAS CORE (MARIADB 10.6)
-- ============================================================================

CREATE TABLE IF NOT EXISTS tenant_branches (
    id VARCHAR(36) NOT NULL PRIMARY KEY DEFAULT (UUID()),
    tenant_id VARCHAR(36) NOT NULL,
    code VARCHAR(50) NOT NULL,
    name VARCHAR(150) NOT NULL,
    legal_entity_name VARCHAR(255) NULL,
    tax_code VARCHAR(50) NULL,
    representative_name VARCHAR(150) NULL,
    representative_title VARCHAR(100) NULL,
    address TEXT NULL,
    phone VARCHAR(30) NULL,
    email VARCHAR(255) NULL,
    gps_lat DECIMAL(10,7) NULL,
    gps_lng DECIMAL(10,7) NULL,
    gps_radius_meters INT NOT NULL DEFAULT 150,
    work_schedule JSON NULL,
    is_headquarters TINYINT(1) NOT NULL DEFAULT 0,
    is_active TINYINT(1) NOT NULL DEFAULT 1,
    created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
    updated_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
    CONSTRAINT uk_tenant_branches_tenant_id UNIQUE (tenant_id, id),
    CONSTRAINT uk_tenant_branches_code UNIQUE (tenant_id, code),
    INDEX idx_tenant_branches_tenant (tenant_id, is_active)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS tenant_roles (
    id VARCHAR(36) NOT NULL PRIMARY KEY DEFAULT (UUID()),
    tenant_id VARCHAR(36) NOT NULL,
    role_key VARCHAR(64) NOT NULL,
    name VARCHAR(150) NOT NULL,
    description TEXT NULL,
    default_data_scope VARCHAR(30) NOT NULL DEFAULT 'own',
    is_system TINYINT(1) NOT NULL DEFAULT 0,
    is_active TINYINT(1) NOT NULL DEFAULT 1,
    created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
    updated_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
    CONSTRAINT uk_tenant_roles_tenant_id UNIQUE (tenant_id, id),
    CONSTRAINT uk_tenant_roles_key UNIQUE (tenant_id, role_key),
    INDEX idx_tenant_roles_tenant (tenant_id, is_active)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS tenant_departments (
    id VARCHAR(36) NOT NULL PRIMARY KEY DEFAULT (UUID()),
    tenant_id VARCHAR(36) NOT NULL,
    branch_id VARCHAR(36) NULL,
    parent_department_id VARCHAR(36) NULL,
    code VARCHAR(50) NOT NULL,
    name VARCHAR(150) NOT NULL,
    description TEXT NULL,
    manager_user_id VARCHAR(36) NULL,
    default_role_id VARCHAR(36) NULL,
    sort_order INT NOT NULL DEFAULT 0,
    is_active TINYINT(1) NOT NULL DEFAULT 1,
    created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
    updated_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
    CONSTRAINT uk_tenant_departments_tenant_id UNIQUE (tenant_id, id),
    CONSTRAINT uk_tenant_departments_code UNIQUE (tenant_id, code),
    INDEX idx_tenant_departments_tenant (tenant_id, parent_department_id, sort_order)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS tenant_teams (
    id VARCHAR(36) NOT NULL PRIMARY KEY DEFAULT (UUID()),
    tenant_id VARCHAR(36) NOT NULL,
    department_id VARCHAR(36) NULL,
    branch_id VARCHAR(36) NULL,
    code VARCHAR(50) NOT NULL,
    name VARCHAR(150) NOT NULL,
    description TEXT NULL,
    leader_user_id VARCHAR(36) NULL,
    is_active TINYINT(1) NOT NULL DEFAULT 1,
    created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
    updated_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
    CONSTRAINT uk_tenant_teams_tenant_id UNIQUE (tenant_id, id),
    CONSTRAINT uk_tenant_teams_code UNIQUE (tenant_id, code),
    INDEX idx_tenant_teams_tenant (tenant_id, department_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS tenant_positions (
    id VARCHAR(36) NOT NULL PRIMARY KEY DEFAULT (UUID()),
    tenant_id VARCHAR(36) NOT NULL,
    department_id VARCHAR(36) NULL,
    code VARCHAR(50) NOT NULL,
    name VARCHAR(150) NOT NULL,
    level_rank INT NOT NULL DEFAULT 1,
    description TEXT NULL,
    is_active TINYINT(1) NOT NULL DEFAULT 1,
    created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
    updated_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
    CONSTRAINT uk_tenant_positions_tenant_id UNIQUE (tenant_id, id),
    CONSTRAINT uk_tenant_positions_code UNIQUE (tenant_id, code),
    INDEX idx_tenant_positions_tenant (tenant_id, level_rank DESC)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS tenant_role_permissions (
    id VARCHAR(36) NOT NULL PRIMARY KEY DEFAULT (UUID()),
    tenant_id VARCHAR(36) NOT NULL,
    role_id VARCHAR(36) NOT NULL,
    module_key VARCHAR(64) NOT NULL,
    data_scope VARCHAR(30) NOT NULL DEFAULT 'none',
    actions JSON NOT NULL,
    created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
    updated_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
    CONSTRAINT uk_role_perm_module UNIQUE (tenant_id, role_id, module_key),
    INDEX idx_role_perms_lookup (tenant_id, role_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS tenant_department_permissions (
    id VARCHAR(36) NOT NULL PRIMARY KEY DEFAULT (UUID()),
    tenant_id VARCHAR(36) NOT NULL,
    department_id VARCHAR(36) NOT NULL,
    module_key VARCHAR(64) NOT NULL,
    data_scope VARCHAR(30) NOT NULL DEFAULT 'none',
    actions JSON NOT NULL,
    created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
    updated_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
    CONSTRAINT uk_dept_perm_module UNIQUE (tenant_id, department_id, module_key),
    INDEX idx_dept_perms_lookup (tenant_id, department_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS tenant_user_permission_overrides (
    id VARCHAR(36) NOT NULL PRIMARY KEY DEFAULT (UUID()),
    tenant_id VARCHAR(36) NOT NULL,
    user_id VARCHAR(36) NOT NULL,
    module_key VARCHAR(64) NOT NULL,
    effect VARCHAR(10) NOT NULL DEFAULT 'grant',
    data_scope VARCHAR(30) NULL,
    actions JSON NOT NULL,
    reason TEXT NULL,
    expires_at DATETIME(6) NULL,
    created_by VARCHAR(36) NULL,
    created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
    updated_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
    CONSTRAINT uk_user_perm_override UNIQUE (tenant_id, user_id, module_key, effect),
    INDEX idx_user_overrides_lookup (tenant_id, user_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS tenant_stage_transition_rules (
    id VARCHAR(36) NOT NULL PRIMARY KEY DEFAULT (UUID()),
    tenant_id VARCHAR(36) NOT NULL,
    pipeline_id VARCHAR(36) NOT NULL,
    from_stage_id VARCHAR(36) NULL,
    to_stage_id VARCHAR(36) NOT NULL,
    rule_name VARCHAR(150) NULL,
    required_fields JSON NOT NULL,
    allowed_role_ids JSON NOT NULL,
    allowed_roles JSON NOT NULL,
    require_note TINYINT(1) NOT NULL DEFAULT 0,
    max_sla_hours INT NOT NULL DEFAULT 0,
    score_delta INT NOT NULL DEFAULT 0,
    auto_task_templates JSON NOT NULL,
    notify_role_ids JSON NOT NULL,
    trigger_flow_id VARCHAR(36) NULL,
    capi_event_override VARCHAR(100) NULL,
    is_active TINYINT(1) NOT NULL DEFAULT 1,
    created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
    updated_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
    INDEX idx_stage_rules_lookup (tenant_id, pipeline_id, to_stage_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS tenant_custom_kpis (
    id VARCHAR(36) NOT NULL PRIMARY KEY DEFAULT (UUID()),
    tenant_id VARCHAR(36) NOT NULL,
    kpi_key VARCHAR(64) NOT NULL,
    name VARCHAR(150) NOT NULL,
    description TEXT NULL,
    module_key VARCHAR(64) NOT NULL DEFAULT 'crm',
    source_entity VARCHAR(64) NOT NULL DEFAULT 'leads',
    metric_op VARCHAR(30) NOT NULL DEFAULT 'COUNT',
    target_field VARCHAR(100) NULL,
    filter_branches JSON NOT NULL,
    target_value DECIMAL(18,2) NOT NULL DEFAULT 0,
    unit VARCHAR(30) NOT NULL DEFAULT '',
    color_hex VARCHAR(20) NOT NULL DEFAULT '#1E40FF',
    sort_order INT NOT NULL DEFAULT 0,
    is_active TINYINT(1) NOT NULL DEFAULT 1,
    created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
    updated_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
    CONSTRAINT uk_tenant_custom_kpis_key UNIQUE (tenant_id, kpi_key),
    INDEX idx_custom_kpis_tenant (tenant_id, is_active, sort_order)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS tenant_policy_documents (
    id VARCHAR(36) NOT NULL PRIMARY KEY DEFAULT (UUID()),
    tenant_id VARCHAR(36) NOT NULL,
    doc_key VARCHAR(80) NOT NULL,
    title VARCHAR(255) NOT NULL,
    doc_category VARCHAR(50) NOT NULL DEFAULT 'company_policy',
    content_html TEXT NOT NULL,
    content_markdown TEXT NULL,
    variables_schema JSON NOT NULL,
    version INT NOT NULL DEFAULT 1,
    status VARCHAR(30) NOT NULL DEFAULT 'published',
    sync_to_dom_agent TINYINT(1) NOT NULL DEFAULT 0,
    last_synced_dom_agent_at DATETIME(6) NULL,
    allowed_department_ids JSON NOT NULL,
    updated_by VARCHAR(36) NULL,
    created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
    updated_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
    CONSTRAINT uk_tenant_policy_docs_key UNIQUE (tenant_id, doc_key),
    INDEX idx_policy_docs_tenant (tenant_id, doc_category, status)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS tenant_audiences (
    id VARCHAR(36) NOT NULL PRIMARY KEY DEFAULT (UUID()),
    tenant_id VARCHAR(36) NOT NULL,
    name VARCHAR(200) NOT NULL,
    description TEXT NULL,
    audience_type VARCHAR(30) NOT NULL DEFAULT 'static_data',
    filter_branches JSON NOT NULL,
    sync_config JSON NOT NULL,
    cached_member_count INT NOT NULL DEFAULT 0,
    auto_push_to_sale_round TINYINT(1) NOT NULL DEFAULT 0,
    target_round_id VARCHAR(36) NULL,
    color_hex VARCHAR(20) NOT NULL DEFAULT '#1E40FF',
    is_active TINYINT(1) NOT NULL DEFAULT 1,
    last_evaluated_at DATETIME(6) NULL,
    created_by VARCHAR(36) NULL,
    created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
    updated_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
    CONSTRAINT uk_tenant_audiences_tenant_id UNIQUE (tenant_id, id),
    INDEX idx_audiences_tenant_type (tenant_id, audience_type, is_active)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS tenant_audience_members (
    id VARCHAR(36) NOT NULL PRIMARY KEY DEFAULT (UUID()),
    tenant_id VARCHAR(36) NOT NULL,
    audience_id VARCHAR(36) NOT NULL,
    lead_id VARCHAR(36) NOT NULL,
    source_type VARCHAR(40) NOT NULL DEFAULT 'manual',
    metadata JSON NOT NULL,
    joined_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
    CONSTRAINT uk_audience_member UNIQUE (tenant_id, audience_id, lead_id),
    INDEX idx_aud_members_audience (tenant_id, audience_id, joined_at DESC),
    INDEX idx_aud_members_lead (tenant_id, lead_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS tenant_audience_exclusions (
    id VARCHAR(36) NOT NULL PRIMARY KEY DEFAULT (UUID()),
    tenant_id VARCHAR(36) NOT NULL,
    audience_id VARCHAR(36) NOT NULL,
    lead_id VARCHAR(36) NULL,
    excluded_audience_id VARCHAR(36) NULL,
    email VARCHAR(255) NULL,
    phone VARCHAR(30) NULL,
    reason VARCHAR(255) NULL,
    created_by VARCHAR(36) NULL,
    created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
    INDEX idx_aud_excl_audience (tenant_id, audience_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS tenant_tags (
    id VARCHAR(36) NOT NULL PRIMARY KEY DEFAULT (UUID()),
    tenant_id VARCHAR(36) NOT NULL,
    name VARCHAR(100) NOT NULL,
    slug VARCHAR(100) NOT NULL,
    color_hex VARCHAR(20) NOT NULL DEFAULT '#1E40FF',
    category VARCHAR(50) NOT NULL DEFAULT 'general',
    description TEXT NULL,
    usage_count INT NOT NULL DEFAULT 0,
    created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
    updated_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
    CONSTRAINT uk_tenant_tags_tenant_id UNIQUE (tenant_id, id),
    CONSTRAINT uk_tenant_tags_slug UNIQUE (tenant_id, slug),
    INDEX idx_tenant_tags_tenant (tenant_id, category)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS lead_tags (
    id VARCHAR(36) NOT NULL PRIMARY KEY DEFAULT (UUID()),
    tenant_id VARCHAR(36) NOT NULL,
    lead_id VARCHAR(36) NOT NULL,
    tag_id VARCHAR(36) NOT NULL,
    assigned_by VARCHAR(36) NULL,
    created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
    CONSTRAINT uk_lead_tag UNIQUE (tenant_id, lead_id, tag_id),
    INDEX idx_lead_tags_lead (tenant_id, lead_id),
    INDEX idx_lead_tags_tag (tenant_id, tag_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
