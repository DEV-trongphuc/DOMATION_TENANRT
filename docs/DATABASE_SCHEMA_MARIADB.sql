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

-- =============================================================================

-- SECTION 11: WAVE 2 & FULL-CLONE MODULE SCHEMAS (HRM, MARKETING, ERP OPS, DOM AGENT, ATTENDANCE, ORG-RBAC, CRM-360)

-- =============================================================================

CREATE TABLE IF NOT EXISTS tenant_approval_workflows (
      id VARCHAR(36) NOT NULL PRIMARY KEY DEFAULT (UUID()),
      tenant_id VARCHAR(36) NOT NULL,
      code VARCHAR(80) NOT NULL,
      name VARCHAR(200) NOT NULL,
      description TEXT NULL,
      category VARCHAR(40) NOT NULL DEFAULT 'leave',
      form_schema JSON NOT NULL,
      icon_name VARCHAR(60) NOT NULL DEFAULT 'FileCheck',
      color_hex VARCHAR(20) NOT NULL DEFAULT '#1E40FF',
      require_attachment TINYINT(1) NOT NULL DEFAULT 0,
      auto_approve_if_creator_is_approver TINYINT(1) NOT NULL DEFAULT 1,
      is_active TINYINT(1) NOT NULL DEFAULT 1,
      created_by VARCHAR(36) NULL,
      created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
      updated_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
      CONSTRAINT uk_tenant_approval_workflows_tenant_id UNIQUE (tenant_id, id),
      CONSTRAINT uk_tenant_approval_workflows_code UNIQUE (tenant_id, code),
      INDEX idx_appr_wf_tenant_cat (tenant_id, category, is_active)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS tenant_approval_workflow_steps (
      id VARCHAR(36) NOT NULL PRIMARY KEY DEFAULT (UUID()),
      tenant_id VARCHAR(36) NOT NULL,
      workflow_id VARCHAR(36) NOT NULL,
      step_order INT NOT NULL DEFAULT 1,
      step_name VARCHAR(160) NOT NULL,
      approver_type VARCHAR(40) NOT NULL DEFAULT 'direct_manager',
      approver_role_id VARCHAR(36) NULL,
      approver_user_id VARCHAR(36) NULL,
      min_amount_threshold DECIMAL(18,2) NOT NULL DEFAULT 0,
      max_amount_threshold DECIMAL(18,2) NULL,
      approval_mode VARCHAR(30) NOT NULL DEFAULT 'any_one',
      fallback_strategy VARCHAR(40) NOT NULL DEFAULT 'tenant_admin',
      sla_hours INT NOT NULL DEFAULT 24,
      require_signature TINYINT(1) NOT NULL DEFAULT 0,
      created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
      updated_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
      CONSTRAINT uk_tenant_approval_workflow_steps_tenant_id UNIQUE (tenant_id, id),
      INDEX idx_appr_steps_wf_order (tenant_id, workflow_id, step_order)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS tenant_approval_delegations (
      id VARCHAR(36) NOT NULL PRIMARY KEY DEFAULT (UUID()),
      tenant_id VARCHAR(36) NOT NULL,
      delegator_user_id VARCHAR(36) NOT NULL,
      delegate_user_id VARCHAR(36) NOT NULL,
      categories JSON NOT NULL,
      valid_from DATETIME(6) NOT NULL,
      valid_until DATETIME(6) NOT NULL,
      reason TEXT NULL,
      is_active TINYINT(1) NOT NULL DEFAULT 1,
      created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
      updated_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
      CONSTRAINT uk_tenant_approval_delegations_tenant_id UNIQUE (tenant_id, id),
      INDEX idx_appr_delegations_lookup (tenant_id, delegator_user_id, is_active)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS tenant_approval_requests (
      id VARCHAR(36) NOT NULL PRIMARY KEY DEFAULT (UUID()),
      tenant_id VARCHAR(36) NOT NULL,
      request_code VARCHAR(50) NOT NULL,
      workflow_id VARCHAR(36) NOT NULL,
      category VARCHAR(40) NOT NULL,
      title VARCHAR(255) NOT NULL,
      description TEXT NULL,
      requester_user_id VARCHAR(36) NOT NULL,
      amount_vnd DECIMAL(18,2) NOT NULL DEFAULT 0,
      currency VARCHAR(10) NOT NULL DEFAULT 'VND',
      start_date DATETIME(6) NULL,
      end_date DATETIME(6) NULL,
      form_data JSON NOT NULL,
      attachments JSON NOT NULL,
      status VARCHAR(30) NOT NULL DEFAULT 'pending',
      current_step_order INT NOT NULL DEFAULT 1,
      total_steps INT NOT NULL DEFAULT 1,
      resolved_steps_snapshot JSON NOT NULL,
      linked_entity_type VARCHAR(60) NULL,
      linked_entity_id VARCHAR(36) NULL,
      submitted_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
      completed_at DATETIME(6) NULL,
      created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
      updated_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
      CONSTRAINT uk_tenant_approval_requests_tenant_id UNIQUE (tenant_id, id),
      CONSTRAINT uk_tenant_approval_requests_code UNIQUE (tenant_id, request_code),
      INDEX idx_appr_req_tenant_status (tenant_id, status, created_at),
      INDEX idx_appr_req_requester (tenant_id, requester_user_id, created_at)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS tenant_approval_step_logs (
      id VARCHAR(36) NOT NULL PRIMARY KEY DEFAULT (UUID()),
      tenant_id VARCHAR(36) NOT NULL,
      request_id VARCHAR(36) NOT NULL,
      step_id VARCHAR(36) NULL,
      step_order INT NOT NULL,
      step_name VARCHAR(160) NOT NULL,
      approval_mode VARCHAR(30) NOT NULL DEFAULT 'any_one',
      assigned_user_id VARCHAR(36) NOT NULL,
      original_approver_user_id VARCHAR(36) NULL,
      delegated_from_user_id VARCHAR(36) NULL,
      status VARCHAR(30) NOT NULL DEFAULT 'pending',
      action_comment TEXT NULL,
      signature_data_url LONGTEXT NULL,
      due_at DATETIME(6) NULL,
      acted_at DATETIME(6) NULL,
      created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
      updated_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
      CONSTRAINT uk_tenant_approval_step_logs_tenant_id UNIQUE (tenant_id, id),
      INDEX idx_appr_step_logs_inbox (tenant_id, assigned_user_id, status),
      INDEX idx_appr_step_logs_req (tenant_id, request_id, step_order)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS tenant_hr_employees (
      id VARCHAR(36) NOT NULL PRIMARY KEY DEFAULT (UUID()),
      tenant_id VARCHAR(36) NOT NULL,
      user_id VARCHAR(36) NULL,
      employee_code VARCHAR(50) NOT NULL,
      full_name VARCHAR(160) NOT NULL,
      work_email VARCHAR(255) NULL,
      phone VARCHAR(40) NULL,
      gender VARCHAR(20) NULL,
      date_of_birth DATE NULL,
      nationality VARCHAR(80) NOT NULL DEFAULT 'Việt Nam',
      id_card_number VARCHAR(50) NULL,
      address TEXT NULL,
      branch_id VARCHAR(36) NULL,
      department_id VARCHAR(36) NULL,
      team_id VARCHAR(36) NULL,
      position_id VARCHAR(36) NULL,
      manager_user_id VARCHAR(36) NULL,
      employment_status VARCHAR(30) NOT NULL DEFAULT 'active',
      employment_type VARCHAR(30) NOT NULL DEFAULT 'full_time',
      join_date DATE NULL,
      resign_date DATE NULL,
      base_salary_vnd DECIMAL(18,2) NOT NULL DEFAULT 0,
      insurance_salary_vnd DECIMAL(18,2) NOT NULL DEFAULT 0,
      insurance_enrolled TINYINT(1) NOT NULL DEFAULT 1,
      social_insurance_number VARCHAR(50) NULL,
      is_resident TINYINT(1) NOT NULL DEFAULT 1,
      tax_code VARCHAR(50) NULL,
      dependents_count INT NOT NULL DEFAULT 0,
      union_member TINYINT(1) NOT NULL DEFAULT 0,
      allowances_json JSON NOT NULL,
      bank_name VARCHAR(120) NULL,
      bank_account_number VARCHAR(60) NULL,
      bank_account_holder VARCHAR(160) NULL,
      bank_branch VARCHAR(160) NULL,
      annual_leave_quota DECIMAL(6,2) NOT NULL DEFAULT 12,
      annual_leave_used DECIMAL(6,2) NOT NULL DEFAULT 0,
      compensatory_leave_balance DECIMAL(6,2) NOT NULL DEFAULT 0,
      digital_signature_data_url LONGTEXT NULL,
      metadata JSON NOT NULL,
      created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
      updated_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
      CONSTRAINT uk_tenant_hr_employees_tenant_id UNIQUE (tenant_id, id),
      CONSTRAINT uk_tenant_hr_employees_code UNIQUE (tenant_id, employee_code),
      INDEX idx_hr_emp_tenant_status (tenant_id, employment_status),
      INDEX idx_hr_emp_user (tenant_id, user_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS tenant_hr_contracts (
      id VARCHAR(36) NOT NULL PRIMARY KEY DEFAULT (UUID()),
      tenant_id VARCHAR(36) NOT NULL,
      employee_id VARCHAR(36) NOT NULL,
      contract_number VARCHAR(80) NOT NULL,
      contract_type VARCHAR(30) NOT NULL DEFAULT 'fixed_term',
      status VARCHAR(30) NOT NULL DEFAULT 'active',
      start_date DATE NOT NULL,
      end_date DATE NULL,
      base_salary_vnd DECIMAL(18,2) NOT NULL DEFAULT 0,
      insurance_salary_vnd DECIMAL(18,2) NOT NULL DEFAULT 0,
      allowances_json JSON NOT NULL,
      working_schedule_note VARCHAR(255) NULL,
      signed_by_employee TINYINT(1) NOT NULL DEFAULT 0,
      employee_signature_url LONGTEXT NULL,
      signed_by_employer TINYINT(1) NOT NULL DEFAULT 0,
      employer_signer_name VARCHAR(160) NULL,
      signed_at DATETIME(6) NULL,
      notes TEXT NULL,
      created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
      updated_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
      CONSTRAINT uk_tenant_hr_contracts_tenant_id UNIQUE (tenant_id, id),
      CONSTRAINT uk_tenant_hr_contracts_number UNIQUE (tenant_id, contract_number),
      INDEX idx_hr_contracts_emp (tenant_id, employee_id, start_date)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS tenant_hr_handover_assets (
      id VARCHAR(36) NOT NULL PRIMARY KEY DEFAULT (UUID()),
      tenant_id VARCHAR(36) NOT NULL,
      employee_id VARCHAR(36) NOT NULL,
      asset_code VARCHAR(80) NOT NULL,
      asset_name VARCHAR(200) NOT NULL,
      category VARCHAR(60) NOT NULL DEFAULT 'laptop',
      serial_number VARCHAR(120) NULL,
      asset_value_vnd DECIMAL(18,2) NOT NULL DEFAULT 0,
      condition_on_handover VARCHAR(120) NOT NULL DEFAULT 'Mới 100%',
      status VARCHAR(30) NOT NULL DEFAULT 'assigned',
      handed_over_at DATE NOT NULL,
      returned_at DATE NULL,
      acknowledged_by_employee TINYINT(1) NOT NULL DEFAULT 0,
      notes TEXT NULL,
      created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
      updated_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
      CONSTRAINT uk_tenant_hr_handover_assets_tenant_id UNIQUE (tenant_id, id),
      INDEX idx_hr_assets_emp (tenant_id, employee_id, status)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS tenant_booking_links (
      id VARCHAR(36) NOT NULL PRIMARY KEY DEFAULT (UUID()),
      tenant_id VARCHAR(36) NOT NULL,
      host_user_id VARCHAR(36) NULL,
      host_employee_id VARCHAR(36) NULL,
      slug VARCHAR(120) NOT NULL,
      public_token VARCHAR(80) NOT NULL,
      title VARCHAR(200) NOT NULL,
      subtitle VARCHAR(255) NULL,
      description TEXT NULL,
      meeting_purpose VARCHAR(60) NOT NULL DEFAULT 'consultation',
      duration_minutes INT NOT NULL DEFAULT 30,
      buffer_minutes INT NOT NULL DEFAULT 10,
      timezone VARCHAR(60) NOT NULL DEFAULT 'Asia/Ho_Chi_Minh',
      location_type VARCHAR(40) NOT NULL DEFAULT 'video_link',
      location_value VARCHAR(255) NULL,
      availability_rules JSON NOT NULL,
      custom_questions JSON NOT NULL,
      is_active TINYINT(1) NOT NULL DEFAULT 1,
      created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
      updated_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
      CONSTRAINT uk_tenant_booking_links_tenant_id UNIQUE (tenant_id, id),
      CONSTRAINT uk_tenant_booking_links_slug UNIQUE (slug),
      CONSTRAINT uk_tenant_booking_links_token UNIQUE (public_token),
      INDEX idx_booking_links_tenant (tenant_id, is_active)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS tenant_booking_appointments (
      id VARCHAR(36) NOT NULL PRIMARY KEY DEFAULT (UUID()),
      tenant_id VARCHAR(36) NOT NULL,
      booking_link_id VARCHAR(36) NOT NULL,
      guest_name VARCHAR(160) NOT NULL,
      guest_email VARCHAR(255) NULL,
      guest_phone VARCHAR(40) NULL,
      guest_company VARCHAR(200) NULL,
      topic TEXT NULL,
      answers_json JSON NOT NULL,
      booking_date DATE NOT NULL,
      start_time VARCHAR(10) NOT NULL,
      end_time VARCHAR(10) NOT NULL,
      status VARCHAR(30) NOT NULL DEFAULT 'confirmed',
      lead_id VARCHAR(36) NULL,
      ics_uid VARCHAR(120) NULL,
      cancel_reason TEXT NULL,
      created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
      updated_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
      CONSTRAINT uk_tenant_booking_appointments_tenant_id UNIQUE (tenant_id, id),
      INDEX idx_booking_appts_slot (tenant_id, booking_link_id, booking_date, start_time)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS tenant_hr_shifts (
      id VARCHAR(36) NOT NULL PRIMARY KEY DEFAULT (UUID()),
      tenant_id VARCHAR(36) NOT NULL,
      code VARCHAR(50) NOT NULL,
      name VARCHAR(150) NOT NULL,
      start_time VARCHAR(10) NOT NULL DEFAULT '08:30',
      end_time VARCHAR(10) NOT NULL DEFAULT '17:30',
      break_start_time VARCHAR(10) NULL DEFAULT '12:00',
      break_end_time VARCHAR(10) NULL DEFAULT '13:00',
      break_minutes INT NOT NULL DEFAULT 60,
      grace_late_minutes INT NOT NULL DEFAULT 15,
      grace_early_leave_minutes INT NOT NULL DEFAULT 15,
      min_half_day_hours DECIMAL(5,2) NOT NULL DEFAULT 4,
      standard_work_hours DECIMAL(5,2) NOT NULL DEFAULT 8,
      work_unit_value DECIMAL(5,2) NOT NULL DEFAULT 1,
      night_shift_multiplier DECIMAL(5,2) NOT NULL DEFAULT 1.3,
      overtime_multiplier DECIMAL(5,2) NOT NULL DEFAULT 1.5,
      weekend_overtime_multiplier DECIMAL(5,2) NOT NULL DEFAULT 2.0,
      holiday_overtime_multiplier DECIMAL(5,2) NOT NULL DEFAULT 3.0,
      require_gps TINYINT(1) NOT NULL DEFAULT 1,
      require_selfie TINYINT(1) NOT NULL DEFAULT 1,
      allow_out_of_geofence_with_explanation TINYINT(1) NOT NULL DEFAULT 1,
      working_days JSON NOT NULL,
      is_default TINYINT(1) NOT NULL DEFAULT 0,
      is_active TINYINT(1) NOT NULL DEFAULT 1,
      created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
      updated_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
      CONSTRAINT uk_tenant_hr_shifts_tenant_id UNIQUE (tenant_id, id),
      CONSTRAINT uk_tenant_hr_shifts_code UNIQUE (tenant_id, code),
      INDEX idx_hr_shifts_tenant (tenant_id, is_active)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS tenant_hr_shift_assignments (
      id VARCHAR(36) NOT NULL PRIMARY KEY DEFAULT (UUID()),
      tenant_id VARCHAR(36) NOT NULL,
      shift_id VARCHAR(36) NOT NULL,
      employee_id VARCHAR(36) NULL,
      user_id VARCHAR(36) NULL,
      department_id VARCHAR(36) NULL,
      branch_id VARCHAR(36) NULL,
      effective_from DATE NOT NULL,
      effective_to DATE NULL,
      is_active TINYINT(1) NOT NULL DEFAULT 1,
      created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
      updated_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
      CONSTRAINT uk_tenant_hr_shift_assignments_tenant_id UNIQUE (tenant_id, id),
      INDEX idx_shift_assign_lookup (tenant_id, user_id, employee_id, is_active)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS tenant_hr_attendance_logs (
      id VARCHAR(36) NOT NULL PRIMARY KEY DEFAULT (UUID()),
      tenant_id VARCHAR(36) NOT NULL,
      user_id VARCHAR(36) NOT NULL,
      employee_id VARCHAR(36) NULL,
      branch_id VARCHAR(36) NULL,
      shift_id VARCHAR(36) NULL,
      work_date DATE NOT NULL,
      attendance_code VARCHAR(10) NOT NULL DEFAULT 'X',
      check_in_at DATETIME(6) NULL,
      check_out_at DATETIME(6) NULL,
      latitude DECIMAL(10,7) NULL,
      longitude DECIMAL(10,7) NULL,
      checkout_latitude DECIMAL(10,7) NULL,
      checkout_longitude DECIMAL(10,7) NULL,
      distance_meters DECIMAL(12,2) NULL,
      checkout_distance_meters DECIMAL(12,2) NULL,
      within_geofence TINYINT(1) NOT NULL DEFAULT 1,
      selfie_data_url LONGTEXT NULL,
      checkout_selfie_data_url LONGTEXT NULL,
      device_info VARCHAR(255) NULL,
      late_minutes INT NOT NULL DEFAULT 0,
      early_leave_minutes INT NOT NULL DEFAULT 0,
      worked_hours DECIMAL(6,2) NOT NULL DEFAULT 0,
      overtime_hours DECIMAL(6,2) NOT NULL DEFAULT 0,
      work_units DECIMAL(5,2) NOT NULL DEFAULT 1,
      status VARCHAR(30) NOT NULL DEFAULT 'valid',
      note TEXT NULL,
      created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
      updated_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
      CONSTRAINT uk_tenant_hr_attendance_logs_tenant_id UNIQUE (tenant_id, id),
      CONSTRAINT uk_hr_att_user_date UNIQUE (tenant_id, user_id, work_date),
      INDEX idx_hr_att_logs_month (tenant_id, work_date, user_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS tenant_hr_attendance_explanations (
      id VARCHAR(36) NOT NULL PRIMARY KEY DEFAULT (UUID()),
      tenant_id VARCHAR(36) NOT NULL,
      attendance_log_id VARCHAR(36) NULL,
      user_id VARCHAR(36) NOT NULL,
      employee_id VARCHAR(36) NULL,
      work_date DATE NOT NULL,
      explanation_type VARCHAR(40) NOT NULL DEFAULT 'late_arrival',
      requested_check_in VARCHAR(10) NULL,
      requested_check_out VARCHAR(10) NULL,
      requested_work_units DECIMAL(5,2) NOT NULL DEFAULT 1,
      reason TEXT NOT NULL,
      evidence_url TEXT NULL,
      status VARCHAR(30) NOT NULL DEFAULT 'pending',
      approval_request_id VARCHAR(36) NULL,
      reviewed_by VARCHAR(36) NULL,
      reviewed_at DATETIME(6) NULL,
      review_comment TEXT NULL,
      created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
      updated_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
      CONSTRAINT uk_tenant_hr_attendance_explanations_tenant_id UNIQUE (tenant_id, id),
      INDEX idx_hr_att_exp_tenant (tenant_id, status, work_date)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS tenant_payroll_configs (
      id VARCHAR(36) NOT NULL PRIMARY KEY DEFAULT (UUID()),
      tenant_id VARCHAR(36) NOT NULL,
      currency VARCHAR(10) NOT NULL DEFAULT 'VND',
      standard_workdays_mode VARCHAR(20) NOT NULL DEFAULT 'calendar',
      fixed_standard_workdays DECIMAL(5,2) NOT NULL DEFAULT 22,
      saturday_work_mode VARCHAR(20) NOT NULL DEFAULT 'off',
      emp_bhxh_rate DECIMAL(6,4) NOT NULL DEFAULT 0.0800,
      emp_bhyt_rate DECIMAL(6,4) NOT NULL DEFAULT 0.0150,
      emp_bhtn_rate DECIMAL(6,4) NOT NULL DEFAULT 0.0100,
      er_bhxh_rate DECIMAL(6,4) NOT NULL DEFAULT 0.1750,
      er_bhyt_rate DECIMAL(6,4) NOT NULL DEFAULT 0.0300,
      er_bhtn_rate DECIMAL(6,4) NOT NULL DEFAULT 0.0100,
      er_union_rate DECIMAL(6,4) NOT NULL DEFAULT 0.0200,
      emp_union_rate DECIMAL(6,4) NOT NULL DEFAULT 0.0100,
      bhxh_salary_cap_vnd DECIMAL(18,2) NOT NULL DEFAULT 46800000,
      bhtn_salary_cap_vnd DECIMAL(18,2) NOT NULL DEFAULT 99200000,
      personal_deduction_vnd DECIMAL(18,2) NOT NULL DEFAULT 11000000,
      dependent_deduction_vnd DECIMAL(18,2) NOT NULL DEFAULT 4400000,
      meal_allowance_exempt_cap_vnd DECIMAL(18,2) NOT NULL DEFAULT 730000,
      non_resident_flat_tax_rate DECIMAL(6,4) NOT NULL DEFAULT 0.2000,
      casual_withholding_threshold_vnd DECIMAL(18,2) NOT NULL DEFAULT 2000000,
      casual_flat_tax_rate DECIMAL(6,4) NOT NULL DEFAULT 0.1000,
      pit_brackets JSON NOT NULL,
      allowance_definitions JSON NOT NULL,
      tax_authority_code VARCHAR(40) NULL,
      tax_authority_name VARCHAR(200) NULL,
      updated_by VARCHAR(36) NULL,
      created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
      updated_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
      CONSTRAINT uk_tenant_payroll_configs_tenant_id UNIQUE (tenant_id, id),
      CONSTRAINT uk_tenant_payroll_configs_one UNIQUE (tenant_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS tenant_payroll_periods (
      id VARCHAR(36) NOT NULL PRIMARY KEY DEFAULT (UUID()),
      tenant_id VARCHAR(36) NOT NULL,
      period_key VARCHAR(10) NOT NULL,
      year INT NOT NULL,
      month INT NOT NULL,
      title VARCHAR(200) NOT NULL,
      branch_id VARCHAR(36) NULL,
      standard_workdays DECIMAL(5,2) NOT NULL DEFAULT 22,
      status VARCHAR(30) NOT NULL DEFAULT 'draft',
      employee_count INT NOT NULL DEFAULT 0,
      total_gross_vnd DECIMAL(18,2) NOT NULL DEFAULT 0,
      total_emp_insurance_vnd DECIMAL(18,2) NOT NULL DEFAULT 0,
      total_er_insurance_vnd DECIMAL(18,2) NOT NULL DEFAULT 0,
      total_pit_tax_vnd DECIMAL(18,2) NOT NULL DEFAULT 0,
      total_commission_vnd DECIMAL(18,2) NOT NULL DEFAULT 0,
      total_net_vnd DECIMAL(18,2) NOT NULL DEFAULT 0,
      approval_request_id VARCHAR(36) NULL,
      approved_by VARCHAR(36) NULL,
      approved_at DATETIME(6) NULL,
      created_by VARCHAR(36) NULL,
      created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
      updated_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
      CONSTRAINT uk_tenant_payroll_periods_tenant_id UNIQUE (tenant_id, id),
      CONSTRAINT uk_tenant_payroll_periods_ym UNIQUE (tenant_id, period_key),
      INDEX idx_payroll_periods_tenant (tenant_id, year, month)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS tenant_payroll_slips (
      id VARCHAR(36) NOT NULL PRIMARY KEY DEFAULT (UUID()),
      tenant_id VARCHAR(36) NOT NULL,
      period_id VARCHAR(36) NOT NULL,
      employee_id VARCHAR(36) NOT NULL,
      user_id VARCHAR(36) NULL,
      standard_workdays DECIMAL(5,2) NOT NULL DEFAULT 22,
      actual_workdays DECIMAL(5,2) NOT NULL DEFAULT 22,
      paid_leave_days DECIMAL(5,2) NOT NULL DEFAULT 0,
      unpaid_leave_days DECIMAL(5,2) NOT NULL DEFAULT 0,
      overtime_hours DECIMAL(6,2) NOT NULL DEFAULT 0,
      base_salary_vnd DECIMAL(18,2) NOT NULL DEFAULT 0,
      prorated_base_pay_vnd DECIMAL(18,2) NOT NULL DEFAULT 0,
      allowances_vnd DECIMAL(18,2) NOT NULL DEFAULT 0,
      tax_exempt_vnd DECIMAL(18,2) NOT NULL DEFAULT 0,
      overtime_pay_vnd DECIMAL(18,2) NOT NULL DEFAULT 0,
      commission_pay_vnd DECIMAL(18,2) NOT NULL DEFAULT 0,
      bonus_vnd DECIMAL(18,2) NOT NULL DEFAULT 0,
      gross_pay_vnd DECIMAL(18,2) NOT NULL DEFAULT 0,
      insurance_salary_base_vnd DECIMAL(18,2) NOT NULL DEFAULT 0,
      emp_bhxh_vnd DECIMAL(18,2) NOT NULL DEFAULT 0,
      emp_bhyt_vnd DECIMAL(18,2) NOT NULL DEFAULT 0,
      emp_bhtn_vnd DECIMAL(18,2) NOT NULL DEFAULT 0,
      emp_union_vnd DECIMAL(18,2) NOT NULL DEFAULT 0,
      er_insurance_total_vnd DECIMAL(18,2) NOT NULL DEFAULT 0,
      dependents_count INT NOT NULL DEFAULT 0,
      family_deduction_vnd DECIMAL(18,2) NOT NULL DEFAULT 0,
      taxable_income_vnd DECIMAL(18,2) NOT NULL DEFAULT 0,
      assessable_income_vnd DECIMAL(18,2) NOT NULL DEFAULT 0,
      pit_tax_vnd DECIMAL(18,2) NOT NULL DEFAULT 0,
      advance_deduction_vnd DECIMAL(18,2) NOT NULL DEFAULT 0,
      other_deduction_vnd DECIMAL(18,2) NOT NULL DEFAULT 0,
      net_pay_vnd DECIMAL(18,2) NOT NULL DEFAULT 0,
      tax_method VARCHAR(40) NOT NULL DEFAULT 'progressive',
      payment_status VARCHAR(30) NOT NULL DEFAULT 'unpaid',
      breakdown JSON NOT NULL,
      created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
      updated_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
      CONSTRAINT uk_tenant_payroll_slips_tenant_id UNIQUE (tenant_id, id),
      CONSTRAINT uk_payroll_slip_period_emp UNIQUE (tenant_id, period_id, employee_id),
      INDEX idx_payroll_slips_period (tenant_id, period_id),
      INDEX idx_payroll_slips_user (tenant_id, user_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS tenant_commission_rules (
      id VARCHAR(36) NOT NULL PRIMARY KEY DEFAULT (UUID()),
      tenant_id VARCHAR(36) NOT NULL,
      name VARCHAR(160) NOT NULL,
      description TEXT NULL,
      applies_to_role_id VARCHAR(36) NULL,
      applies_to_department_id VARCHAR(36) NULL,
      rule_type VARCHAR(30) NOT NULL DEFAULT 'percentage_revenue',
      flat_rate_pct DECIMAL(7,4) NOT NULL DEFAULT 3.0000,
      fixed_amount_vnd DECIMAL(18,2) NOT NULL DEFAULT 0,
      tiers_json JSON NOT NULL,
      min_revenue_threshold_vnd DECIMAL(18,2) NOT NULL DEFAULT 0,
      is_active TINYINT(1) NOT NULL DEFAULT 1,
      created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
      updated_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
      CONSTRAINT uk_tenant_commission_rules_tenant_id UNIQUE (tenant_id, id),
      INDEX idx_comm_rules_tenant (tenant_id, is_active)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS tenant_commission_ledgers (
      id VARCHAR(36) NOT NULL PRIMARY KEY DEFAULT (UUID()),
      tenant_id VARCHAR(36) NOT NULL,
      period_key VARCHAR(10) NOT NULL,
      employee_id VARCHAR(36) NULL,
      user_id VARCHAR(36) NOT NULL,
      rule_id VARCHAR(36) NULL,
      lead_id VARCHAR(36) NULL,
      source_title VARCHAR(255) NOT NULL,
      revenue_base_vnd DECIMAL(18,2) NOT NULL DEFAULT 0,
      commission_amount_vnd DECIMAL(18,2) NOT NULL DEFAULT 0,
      status VARCHAR(30) NOT NULL DEFAULT 'approved',
      notes TEXT NULL,
      created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
      updated_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
      CONSTRAINT uk_tenant_commission_ledgers_tenant_id UNIQUE (tenant_id, id),
      INDEX idx_comm_ledgers_period (tenant_id, period_key, user_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS tenant_cooperation_slips (
      id VARCHAR(36) NOT NULL PRIMARY KEY DEFAULT (UUID()),
      tenant_id VARCHAR(36) NOT NULL,
      slip_code VARCHAR(80) NULL,
      title VARCHAR(255) NOT NULL,
      lead_id VARCHAR(36) NULL,
      deal_id VARCHAR(36) NULL,
      partner_name VARCHAR(255) NULL,
      partner_contact VARCHAR(120) NULL,
      commission_pct DECIMAL(5,2) NOT NULL DEFAULT 0,
      estimated_value_vnd DECIMAL(18,2) NOT NULL DEFAULT 0,
      status VARCHAR(30) NOT NULL DEFAULT 'pending_signatures',
      terms_text TEXT NULL,
      line_items_json JSON NOT NULL,
      owner_user_id VARCHAR(36) NULL,
      approved_by VARCHAR(36) NULL,
      unit_code VARCHAR(80) NULL,
      project_name VARCHAR(200) NULL,
      expected_commission_vnd DECIMAL(18,2) NOT NULL DEFAULT 0,
      total_percentage DECIMAL(6,2) NOT NULL DEFAULT 100,
      dispute_details TEXT NULL,
      approved_at DATETIME(6) NULL,
      metadata_json JSON NOT NULL,
      created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
      updated_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
      INDEX idx_coop_slips_status (tenant_id, status)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS tenant_accounting_az_workspace (
      id VARCHAR(36) NOT NULL PRIMARY KEY DEFAULT (UUID()),
      tenant_id VARCHAR(36) NOT NULL,
      fiscal_period VARCHAR(20) NOT NULL,
      account_code VARCHAR(40) NOT NULL DEFAULT '111',
      account_name VARCHAR(200) NOT NULL DEFAULT 'Tiền mặt',
      voucher_no VARCHAR(80) NULL,
      entry_type VARCHAR(30) NOT NULL DEFAULT 'journal',
      debit_vnd DECIMAL(18,2) NOT NULL DEFAULT 0,
      credit_vnd DECIMAL(18,2) NOT NULL DEFAULT 0,
      balance_vnd DECIMAL(18,2) NOT NULL DEFAULT 0,
      tax_period VARCHAR(20) NULL,
      analytics_json JSON NOT NULL,
      extra_json JSON NOT NULL,
      created_by VARCHAR(36) NULL,
      created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
      updated_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
      INDEX idx_acc_az_period (tenant_id, fiscal_period, account_code)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

ALTER TABLE tenant_branches ADD COLUMN IF NOT EXISTS manager_user_id VARCHAR(36) NULL;

ALTER TABLE tenant_payroll_slips ADD COLUMN IF NOT EXISTS signed_by_employee TINYINT(1) NOT NULL DEFAULT 0;

ALTER TABLE tenant_payroll_slips ADD COLUMN IF NOT EXISTS employee_signature_url TEXT NULL;

ALTER TABLE tenant_payroll_slips ADD COLUMN IF NOT EXISTS employee_signed_at DATETIME(6) NULL;

ALTER TABLE tenant_payroll_slips ADD COLUMN IF NOT EXISTS dispute_status VARCHAR(30) NULL;

ALTER TABLE tenant_payroll_slips ADD COLUMN IF NOT EXISTS dispute_note TEXT NULL;

ALTER TABLE tenant_payroll_slips ADD COLUMN IF NOT EXISTS disputed_at DATETIME(6) NULL;

ALTER TABLE tenant_cooperation_slips ADD COLUMN IF NOT EXISTS unit_code VARCHAR(80) NULL;

ALTER TABLE tenant_cooperation_slips ADD COLUMN IF NOT EXISTS project_name VARCHAR(200) NULL;

ALTER TABLE tenant_cooperation_slips ADD COLUMN IF NOT EXISTS expected_commission_vnd DECIMAL(18,2) NOT NULL DEFAULT 0;

ALTER TABLE tenant_cooperation_slips ADD COLUMN IF NOT EXISTS total_percentage DECIMAL(6,2) NOT NULL DEFAULT 100;

ALTER TABLE tenant_cooperation_slips ADD COLUMN IF NOT EXISTS dispute_details TEXT NULL;

ALTER TABLE tenant_cooperation_slips ADD COLUMN IF NOT EXISTS approved_at DATETIME(6) NULL;

ALTER TABLE tenant_cooperation_slips ADD COLUMN IF NOT EXISTS metadata_json JSON NULL;

CREATE TABLE IF NOT EXISTS mkt_template_groups (
    id VARCHAR(36) NOT NULL PRIMARY KEY,
    tenant_id VARCHAR(36) NOT NULL,
    name VARCHAR(150) NOT NULL,
    description TEXT NULL,
    color_hex VARCHAR(20) NOT NULL DEFAULT '#1E40FF',
    created_by VARCHAR(36) NULL,
    created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
    updated_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
    UNIQUE KEY uk_mkt_template_groups_tenant_id (tenant_id, id),
    INDEX idx_mkt_tpl_groups_tenant (tenant_id, created_at)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS mkt_email_templates (
    id VARCHAR(36) NOT NULL PRIMARY KEY,
    tenant_id VARCHAR(36) NOT NULL,
    group_id VARCHAR(36) NULL,
    name VARCHAR(200) NOT NULL,
    subject VARCHAR(255) NOT NULL DEFAULT '',
    preheader VARCHAR(255) NOT NULL DEFAULT '',
    category VARCHAR(60) NOT NULL DEFAULT 'general',
    blocks_json JSON NOT NULL,
    body_style JSON NOT NULL,
    compiled_html MEDIUMTEXT NOT NULL,
    spam_score INT NOT NULL DEFAULT 0,
    merge_tags JSON NOT NULL,
    visibility VARCHAR(30) NOT NULL DEFAULT 'company',
    status VARCHAR(30) NOT NULL DEFAULT 'active',
    created_by VARCHAR(36) NULL,
    created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
    updated_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
    UNIQUE KEY uk_mkt_email_templates_tenant_id (tenant_id, id),
    INDEX idx_mkt_email_templates_tenant (tenant_id, status, updated_at)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS mkt_forms (
    id VARCHAR(36) NOT NULL PRIMARY KEY,
    tenant_id VARCHAR(36) NOT NULL,
    name VARCHAR(200) NOT NULL,
    description TEXT NULL,
    public_token VARCHAR(80) NOT NULL UNIQUE,
    status VARCHAR(30) NOT NULL DEFAULT 'active',
    routing_mode VARCHAR(40) NOT NULL DEFAULT 'marketing_nurture',
    target_audience_id VARCHAR(36) NULL,
    distribution_round_id VARCHAR(36) NULL,
    require_otp TINYINT(1) NOT NULL DEFAULT 0,
    otp_channel VARCHAR(20) NOT NULL DEFAULT 'email',
    fields_json JSON NOT NULL,
    theme_json JSON NOT NULL,
    thank_you_json JSON NOT NULL,
    submission_count INT NOT NULL DEFAULT 0,
    created_by VARCHAR(36) NULL,
    created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
    updated_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
    UNIQUE KEY uk_mkt_forms_tenant_id (tenant_id, id),
    INDEX idx_mkt_forms_tenant (tenant_id, status, created_at)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS mkt_form_submissions (
    id VARCHAR(36) NOT NULL PRIMARY KEY,
    tenant_id VARCHAR(36) NOT NULL,
    form_id VARCHAR(36) NOT NULL,
    lead_id VARCHAR(36) NULL,
    routing_mode VARCHAR(40) NOT NULL DEFAULT 'marketing_nurture',
    submitted_data JSON NOT NULL,
    utm_data JSON NOT NULL,
    otp_verified TINYINT(1) NOT NULL DEFAULT 0,
    client_ip VARCHAR(64) NULL,
    created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
    UNIQUE KEY uk_mkt_form_submissions_tenant_id (tenant_id, id),
    INDEX idx_mkt_form_sub_lookup (tenant_id, form_id, created_at)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS mkt_custom_events (
    id VARCHAR(36) NOT NULL PRIMARY KEY,
    tenant_id VARCHAR(36) NOT NULL,
    event_key VARCHAR(100) NOT NULL,
    event_name VARCHAR(200) NOT NULL,
    event_category VARCHAR(30) NOT NULL DEFAULT 'custom',
    description TEXT NULL,
    schema_json JSON NOT NULL,
    trigger_count INT NOT NULL DEFAULT 0,
    total_revenue_vnd BIGINT NOT NULL DEFAULT 0,
    is_active TINYINT(1) NOT NULL DEFAULT 1,
    created_by VARCHAR(36) NULL,
    created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
    updated_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
    UNIQUE KEY uk_mkt_custom_events_tenant_id (tenant_id, id),
    UNIQUE KEY uk_mkt_custom_events_key (tenant_id, event_key)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS mkt_otp_verifications (
    id VARCHAR(36) NOT NULL PRIMARY KEY,
    tenant_id VARCHAR(36) NOT NULL,
    channel VARCHAR(20) NOT NULL DEFAULT 'email',
    recipient VARCHAR(255) NOT NULL,
    purpose VARCHAR(80) NOT NULL DEFAULT 'form_submit',
    code_hash VARCHAR(128) NOT NULL,
    attempts INT NOT NULL DEFAULT 0,
    verified TINYINT(1) NOT NULL DEFAULT 0,
    expires_at DATETIME(6) NOT NULL,
    verified_at DATETIME(6) NULL,
    created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
    UNIQUE KEY uk_mkt_otp_verifications_tenant_id (tenant_id, id),
    INDEX idx_mkt_otp_lookup (tenant_id, recipient, created_at)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS mkt_surveys (
    id VARCHAR(36) NOT NULL PRIMARY KEY,
    tenant_id VARCHAR(36) NOT NULL,
    title VARCHAR(255) NOT NULL,
    slug VARCHAR(120) NOT NULL,
    description TEXT NULL,
    survey_type VARCHAR(30) NOT NULL DEFAULT 'survey',
    status VARCHAR(30) NOT NULL DEFAULT 'active',
    blocks_json JSON NOT NULL,
    theme_json JSON NOT NULL,
    settings_json JSON NOT NULL,
    response_count INT NOT NULL DEFAULT 0,
    avg_score DECIMAL(6,2) NOT NULL DEFAULT 0,
    created_by VARCHAR(36) NULL,
    created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
    updated_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
    UNIQUE KEY uk_mkt_surveys_tenant_id (tenant_id, id),
    UNIQUE KEY uk_mkt_surveys_slug (tenant_id, slug)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS mkt_survey_responses (
    id VARCHAR(36) NOT NULL PRIMARY KEY,
    tenant_id VARCHAR(36) NOT NULL,
    survey_id VARCHAR(36) NOT NULL,
    lead_id VARCHAR(36) NULL,
    answers_json JSON NOT NULL,
    quiz_score INT NOT NULL DEFAULT 0,
    nps_score INT NULL,
    tags_applied JSON NOT NULL,
    client_ip VARCHAR(64) NULL,
    created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
    UNIQUE KEY uk_mkt_survey_responses_tenant_id (tenant_id, id),
    INDEX idx_mkt_srv_resp_lookup (tenant_id, survey_id, created_at)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS mkt_campaigns (
    id VARCHAR(36) NOT NULL PRIMARY KEY,
    tenant_id VARCHAR(36) NOT NULL,
    name VARCHAR(255) NOT NULL,
    channel VARCHAR(30) NOT NULL DEFAULT 'email',
    status VARCHAR(30) NOT NULL DEFAULT 'draft',
    audience_id VARCHAR(36) NULL,
    exclude_audience_ids JSON NOT NULL,
    template_id VARCHAR(36) NULL,
    subject_a VARCHAR(255) NOT NULL DEFAULT '',
    subject_b VARCHAR(255) NOT NULL DEFAULT '',
    ab_split_ratio INT NOT NULL DEFAULT 100,
    zns_template_id VARCHAR(120) NULL,
    sender_name VARCHAR(150) NULL,
    sender_email VARCHAR(255) NULL,
    reminder_config JSON NOT NULL,
    scheduled_at DATETIME(6) NULL,
    sent_at DATETIME(6) NULL,
    total_targeted INT NOT NULL DEFAULT 0,
    sent_count INT NOT NULL DEFAULT 0,
    opened_count INT NOT NULL DEFAULT 0,
    clicked_count INT NOT NULL DEFAULT 0,
    bounced_count INT NOT NULL DEFAULT 0,
    unsubscribed_count INT NOT NULL DEFAULT 0,
    cost_vnd BIGINT NOT NULL DEFAULT 0,
    attributed_revenue_vnd BIGINT NOT NULL DEFAULT 0,
    created_by VARCHAR(36) NULL,
    created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
    updated_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
    UNIQUE KEY uk_mkt_campaigns_tenant_id (tenant_id, id),
    INDEX idx_mkt_campaigns_tenant (tenant_id, status, created_at)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS mkt_send_claims (
    id VARCHAR(36) NOT NULL PRIMARY KEY,
    tenant_id VARCHAR(36) NOT NULL,
    campaign_id VARCHAR(36) NOT NULL,
    lead_id VARCHAR(36) NOT NULL,
    channel VARCHAR(20) NOT NULL DEFAULT 'email',
    variant VARCHAR(10) NOT NULL DEFAULT 'A',
    status VARCHAR(30) NOT NULL DEFAULT 'claimed',
    reminder_sent TINYINT(1) NOT NULL DEFAULT 0,
    claimed_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
    sent_at DATETIME(6) NULL,
    opened_at DATETIME(6) NULL,
    clicked_at DATETIME(6) NULL,
    error_message TEXT NULL,
    metadata JSON NOT NULL,
    UNIQUE KEY uk_mkt_send_claims_tenant_id (tenant_id, id),
    UNIQUE KEY uk_mkt_send_claim_unique (tenant_id, campaign_id, lead_id, channel),
    INDEX idx_mkt_send_claims_campaign (tenant_id, campaign_id, status)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS mkt_suppression_list (
    id VARCHAR(36) NOT NULL PRIMARY KEY,
    tenant_id VARCHAR(36) NOT NULL,
    channel VARCHAR(20) NOT NULL DEFAULT 'email',
    recipient VARCHAR(255) NOT NULL,
    reason VARCHAR(50) NOT NULL DEFAULT 'unsubscribed',
    source_campaign_id VARCHAR(36) NULL,
    created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
    UNIQUE KEY uk_mkt_suppression_list_tenant_id (tenant_id, id),
    UNIQUE KEY uk_mkt_suppression_unique (tenant_id, channel, recipient)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS mkt_flows (
    id VARCHAR(36) NOT NULL PRIMARY KEY,
    tenant_id VARCHAR(36) NOT NULL,
    name VARCHAR(255) NOT NULL,
    description TEXT NULL,
    status VARCHAR(30) NOT NULL DEFAULT 'draft',
    trigger_type VARCHAR(60) NOT NULL DEFAULT 'form_submitted',
    trigger_config JSON NOT NULL,
    steps_json JSON NOT NULL,
    version INT NOT NULL DEFAULT 1,
    enrolled_count INT NOT NULL DEFAULT 0,
    completed_count INT NOT NULL DEFAULT 0,
    pushed_to_sale_count INT NOT NULL DEFAULT 0,
    attributed_revenue_vnd BIGINT NOT NULL DEFAULT 0,
    created_by VARCHAR(36) NULL,
    created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
    updated_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
    UNIQUE KEY uk_mkt_flows_tenant_id (tenant_id, id),
    INDEX idx_mkt_flows_tenant_trigger (tenant_id, status, trigger_type)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS mkt_flow_snapshots (
    id VARCHAR(36) NOT NULL PRIMARY KEY,
    tenant_id VARCHAR(36) NOT NULL,
    flow_id VARCHAR(36) NOT NULL,
    version INT NOT NULL,
    trigger_type VARCHAR(60) NOT NULL,
    trigger_config JSON NOT NULL,
    steps_json JSON NOT NULL,
    review_score INT NOT NULL DEFAULT 100,
    published_by VARCHAR(36) NULL,
    created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
    UNIQUE KEY uk_mkt_flow_snapshots_tenant_id (tenant_id, id),
    INDEX idx_mkt_flow_snap_lookup (tenant_id, flow_id, version)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS mkt_flow_enrollments (
    id VARCHAR(36) NOT NULL PRIMARY KEY,
    tenant_id VARCHAR(36) NOT NULL,
    flow_id VARCHAR(36) NOT NULL,
    snapshot_version INT NOT NULL DEFAULT 1,
    lead_id VARCHAR(36) NOT NULL,
    current_step_id VARCHAR(120) NULL,
    status VARCHAR(30) NOT NULL DEFAULT 'active',
    next_run_at DATETIME(6) NULL,
    execution_trace JSON NOT NULL,
    enrolled_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
    completed_at DATETIME(6) NULL,
    UNIQUE KEY uk_mkt_flow_enrollments_tenant_id (tenant_id, id),
    INDEX idx_mkt_flow_enroll_lookup (tenant_id, flow_id, status)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS mkt_voucher_campaigns (
    id VARCHAR(36) NOT NULL PRIMARY KEY,
    tenant_id VARCHAR(36) NOT NULL,
    name VARCHAR(255) NOT NULL,
    slug VARCHAR(120) NOT NULL,
    description TEXT NULL,
    code_prefix VARCHAR(30) NOT NULL DEFAULT 'DOM',
    discount_type VARCHAR(30) NOT NULL DEFAULT 'percentage',
    discount_value BIGINT NOT NULL DEFAULT 10,
    min_order_vnd BIGINT NOT NULL DEFAULT 0,
    max_uses_per_code INT NOT NULL DEFAULT 1,
    expires_at DATETIME(6) NULL,
    status VARCHAR(30) NOT NULL DEFAULT 'active',
    total_codes INT NOT NULL DEFAULT 0,
    claimed_codes INT NOT NULL DEFAULT 0,
    redeemed_codes INT NOT NULL DEFAULT 0,
    qr_design_json JSON NOT NULL,
    created_by VARCHAR(36) NULL,
    created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
    updated_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
    UNIQUE KEY uk_mkt_voucher_campaigns_tenant_id (tenant_id, id),
    UNIQUE KEY uk_mkt_voucher_campaigns_slug (tenant_id, slug)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS mkt_voucher_codes (
    id VARCHAR(36) NOT NULL PRIMARY KEY,
    tenant_id VARCHAR(36) NOT NULL,
    voucher_campaign_id VARCHAR(36) NOT NULL,
    code VARCHAR(80) NOT NULL,
    status VARCHAR(30) NOT NULL DEFAULT 'available',
    lead_id VARCHAR(36) NULL,
    claimed_at DATETIME(6) NULL,
    redeemed_at DATETIME(6) NULL,
    redeemed_order_vnd BIGINT NOT NULL DEFAULT 0,
    redeemed_by_note VARCHAR(255) NULL,
    created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
    UNIQUE KEY uk_mkt_voucher_codes_tenant_id (tenant_id, id),
    UNIQUE KEY uk_mkt_voucher_code_unique (tenant_id, code),
    INDEX idx_mkt_vcode_lookup (tenant_id, voucher_campaign_id, status)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS mkt_short_links (
    id VARCHAR(36) NOT NULL PRIMARY KEY,
    tenant_id VARCHAR(36) NOT NULL,
    title VARCHAR(255) NOT NULL,
    short_code VARCHAR(60) NOT NULL UNIQUE,
    target_url TEXT NOT NULL,
    custom_domain VARCHAR(150) NULL,
    utm_source VARCHAR(100) NULL,
    utm_medium VARCHAR(100) NULL,
    utm_campaign VARCHAR(150) NULL,
    qr_design_json JSON NOT NULL,
    click_count INT NOT NULL DEFAULT 0,
    unique_click_count INT NOT NULL DEFAULT 0,
    is_active TINYINT(1) NOT NULL DEFAULT 1,
    created_by VARCHAR(36) NULL,
    created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
    updated_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
    UNIQUE KEY uk_mkt_short_links_tenant_id (tenant_id, id)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS mkt_short_link_clicks (
    id VARCHAR(36) NOT NULL PRIMARY KEY,
    tenant_id VARCHAR(36) NOT NULL,
    short_link_id VARCHAR(36) NOT NULL,
    lead_id VARCHAR(36) NULL,
    referrer TEXT NULL,
    device_type VARCHAR(30) NOT NULL DEFAULT 'desktop',
    client_ip VARCHAR(64) NULL,
    utm_json JSON NOT NULL,
    clicked_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
    UNIQUE KEY uk_mkt_short_link_clicks_tenant_id (tenant_id, id),
    INDEX idx_mkt_slclicks_lookup (tenant_id, short_link_id, clicked_at)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS mkt_web_properties (
    id VARCHAR(36) NOT NULL PRIMARY KEY,
    tenant_id VARCHAR(36) NOT NULL,
    name VARCHAR(200) NOT NULL,
    domain VARCHAR(255) NOT NULL,
    site_key VARCHAR(80) NOT NULL UNIQUE,
    pricing_url_pattern VARCHAR(255) NOT NULL DEFAULT '/pricing,/bang-gia',
    target_audience_id VARCHAR(36) NULL,
    auto_alert_pricing TINYINT(1) NOT NULL DEFAULT 1,
    is_active TINYINT(1) NOT NULL DEFAULT 1,
    created_by VARCHAR(36) NULL,
    created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
    updated_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
    UNIQUE KEY uk_mkt_web_properties_tenant_id (tenant_id, id)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS mkt_web_sessions (
    id VARCHAR(36) NOT NULL PRIMARY KEY,
    tenant_id VARCHAR(36) NOT NULL,
    property_id VARCHAR(36) NOT NULL,
    visitor_token VARCHAR(120) NOT NULL,
    lead_id VARCHAR(36) NULL,
    entry_url TEXT NULL,
    last_url TEXT NULL,
    referrer TEXT NULL,
    utm_source VARCHAR(100) NULL,
    utm_medium VARCHAR(100) NULL,
    utm_campaign VARCHAR(150) NULL,
    device_type VARCHAR(30) NOT NULL DEFAULT 'desktop',
    pageviews_count INT NOT NULL DEFAULT 1,
    pricing_intent_detected TINYINT(1) NOT NULL DEFAULT 0,
    started_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
    last_seen_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
    UNIQUE KEY uk_mkt_web_sessions_tenant_id (tenant_id, id),
    UNIQUE KEY uk_mkt_web_visitor_prop (tenant_id, property_id, visitor_token),
    INDEX idx_mkt_websess_lookup (tenant_id, property_id, last_seen_at)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS mkt_web_events (
    id VARCHAR(36) NOT NULL PRIMARY KEY,
    tenant_id VARCHAR(36) NOT NULL,
    property_id VARCHAR(36) NOT NULL,
    session_id VARCHAR(36) NOT NULL,
    lead_id VARCHAR(36) NULL,
    event_type VARCHAR(40) NOT NULL DEFAULT 'pageview',
    page_url TEXT NOT NULL,
    element_selector VARCHAR(255) NULL,
    x_pct DECIMAL(5,2) NULL,
    y_pct DECIMAL(5,2) NULL,
    scroll_depth_pct INT NULL,
    metadata JSON NOT NULL,
    created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
    UNIQUE KEY uk_mkt_web_events_tenant_id (tenant_id, id),
    INDEX idx_mkt_webevt_heatmap (tenant_id, property_id, event_type, created_at)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS mkt_ai_bot_configs (
    id VARCHAR(36) NOT NULL PRIMARY KEY,
    tenant_id VARCHAR(36) NOT NULL,
    bot_name VARCHAR(150) NOT NULL DEFAULT 'DOM Agent CSKH',
    brand_persona TEXT NULL,
    welcome_message TEXT NULL,
    channels_json JSON NOT NULL,
    faq_rules_json JSON NOT NULL,
    auto_extract_contact TINYINT(1) NOT NULL DEFAULT 1,
    routing_mode VARCHAR(30) NOT NULL DEFAULT 'audience',
    target_audience_id VARCHAR(36) NULL,
    distribution_round_id VARCHAR(36) NULL,
    is_active TINYINT(1) NOT NULL DEFAULT 1,
    updated_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
    UNIQUE KEY uk_mkt_ai_bot_configs_tenant_id (tenant_id, id),
    UNIQUE KEY uk_mkt_ai_bot_per_tenant (tenant_id)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS mkt_social_conversations (
    id VARCHAR(36) NOT NULL PRIMARY KEY,
    tenant_id VARCHAR(36) NOT NULL,
    channel VARCHAR(30) NOT NULL DEFAULT 'messenger',
    external_thread_id VARCHAR(150) NOT NULL,
    customer_name VARCHAR(150) NOT NULL DEFAULT 'Khách hàng Chat',
    customer_avatar TEXT NULL,
    extracted_phone VARCHAR(30) NULL,
    extracted_email VARCHAR(255) NULL,
    lead_id VARCHAR(36) NULL,
    bot_paused TINYINT(1) NOT NULL DEFAULT 0,
    unread_count INT NOT NULL DEFAULT 0,
    status VARCHAR(30) NOT NULL DEFAULT 'open',
    last_message_preview TEXT NULL,
    last_message_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
    created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
    UNIQUE KEY uk_mkt_social_conversations_tenant_id (tenant_id, id),
    UNIQUE KEY uk_mkt_social_conv_ext (tenant_id, channel, external_thread_id),
    INDEX idx_mkt_socconv_tenant (tenant_id, channel, last_message_at)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS mkt_social_messages (
    id VARCHAR(36) NOT NULL PRIMARY KEY,
    tenant_id VARCHAR(36) NOT NULL,
    conversation_id VARCHAR(36) NOT NULL,
    sender_type VARCHAR(20) NOT NULL DEFAULT 'customer',
    sender_name VARCHAR(150) NULL,
    content TEXT NOT NULL,
    extracted_entities JSON NOT NULL,
    created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
    UNIQUE KEY uk_mkt_social_messages_tenant_id (tenant_id, id),
    INDEX idx_mkt_socmsg_lookup (tenant_id, conversation_id, created_at)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS mkt_campaign_reminders (
    id VARCHAR(36) NOT NULL PRIMARY KEY,
    tenant_id VARCHAR(36) NOT NULL,
    campaign_id VARCHAR(36) NOT NULL,
    step_order INT NOT NULL DEFAULT 1,
    trigger_condition VARCHAR(40) NOT NULL DEFAULT 'no_open',
    wait_hours INT NOT NULL DEFAULT 24,
    subject VARCHAR(255) NOT NULL DEFAULT '',
    template_id VARCHAR(36) NULL,
    channel VARCHAR(20) NOT NULL DEFAULT 'email',
    dispatched_count INT NOT NULL DEFAULT 0,
    is_active TINYINT(1) NOT NULL DEFAULT 1,
    created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
    updated_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
    UNIQUE KEY uk_mkt_campaign_reminders_tenant_id (tenant_id, id),
    INDEX idx_mkt_camp_rem_lookup (tenant_id, campaign_id, step_order)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS mkt_web_heatmaps (
    id VARCHAR(36) NOT NULL PRIMARY KEY,
    tenant_id VARCHAR(36) NOT NULL,
    property_id VARCHAR(36) NOT NULL,
    name VARCHAR(200) NOT NULL,
    page_url_pattern VARCHAR(500) NOT NULL DEFAULT '/',
    device_filter VARCHAR(30) NOT NULL DEFAULT 'all',
    snapshot_html MEDIUMTEXT NULL,
    viewport_width INT NOT NULL DEFAULT 1440,
    viewport_height INT NOT NULL DEFAULT 900,
    click_count INT NOT NULL DEFAULT 0,
    scroll_avg_pct INT NOT NULL DEFAULT 0,
    is_active TINYINT(1) NOT NULL DEFAULT 1,
    metadata_json JSON NULL,
    created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
    updated_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
    UNIQUE KEY uk_mkt_web_heatmaps_tenant_id (tenant_id, id),
    INDEX idx_mkt_webhm_lookup (tenant_id, property_id, created_at)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS mkt_zalo_oa_configs (
    id VARCHAR(36) NOT NULL PRIMARY KEY,
    tenant_id VARCHAR(36) NOT NULL,
    oa_id VARCHAR(100) NOT NULL DEFAULT '',
    oa_name VARCHAR(200) NOT NULL DEFAULT 'Zalo Official Account',
    app_id VARCHAR(100) NOT NULL DEFAULT '',
    status VARCHAR(30) NOT NULL DEFAULT 'connected',
    daily_quota INT NOT NULL DEFAULT 1000,
    sent_today INT NOT NULL DEFAULT 0,
    quality_rating VARCHAR(30) NOT NULL DEFAULT 'high',
    webhook_secret VARCHAR(120) NULL,
    settings_json JSON NULL,
    created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
    updated_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
    UNIQUE KEY uk_mkt_zalo_oa_configs_tenant_id (tenant_id, id),
    UNIQUE KEY uk_mkt_zalo_oa_per_tenant (tenant_id)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS mkt_zalo_templates (
    id VARCHAR(36) NOT NULL PRIMARY KEY,
    tenant_id VARCHAR(36) NOT NULL,
    oa_id VARCHAR(100) NULL,
    template_code VARCHAR(100) NOT NULL DEFAULT '',
    name VARCHAR(200) NOT NULL,
    template_type VARCHAR(40) NOT NULL DEFAULT 'zns_transaction',
    status VARCHAR(30) NOT NULL DEFAULT 'approved',
    price_vnd INT NOT NULL DEFAULT 250,
    content_body TEXT NULL,
    params_schema_json JSON NULL,
    buttons_json JSON NULL,
    preview_url TEXT NULL,
    sent_count INT NOT NULL DEFAULT 0,
    delivered_count INT NOT NULL DEFAULT 0,
    created_by VARCHAR(36) NULL,
    created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
    updated_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
    UNIQUE KEY uk_mkt_zalo_templates_tenant_id (tenant_id, id),
    INDEX idx_mkt_zalo_tpl_tenant (tenant_id, status, created_at)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS mkt_automation_scenarios (
    id VARCHAR(36) NOT NULL PRIMARY KEY,
    tenant_id VARCHAR(36) NOT NULL,
    name VARCHAR(200) NOT NULL,
    channel VARCHAR(30) NOT NULL DEFAULT 'messenger',
    trigger_type VARCHAR(50) NOT NULL DEFAULT 'keyword',
    keywords_json JSON NULL,
    nodes_json JSON NULL,
    edges_json JSON NULL,
    settings_json JSON NULL,
    is_active TINYINT(1) NOT NULL DEFAULT 1,
    matched_count INT NOT NULL DEFAULT 0,
    converted_count INT NOT NULL DEFAULT 0,
    created_by VARCHAR(36) NULL,
    created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
    updated_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
    UNIQUE KEY uk_mkt_automation_scenarios_tenant_id (tenant_id, id),
    INDEX idx_mkt_auto_scen_tenant (tenant_id, channel, is_active)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS mkt_template_acl (
    id VARCHAR(36) NOT NULL PRIMARY KEY,
    tenant_id VARCHAR(36) NOT NULL,
    template_id VARCHAR(36) NOT NULL,
    scope_type VARCHAR(30) NOT NULL DEFAULT 'role',
    scope_target_id VARCHAR(120) NOT NULL,
    scope_label VARCHAR(150) NULL,
    permission_level VARCHAR(20) NOT NULL DEFAULT 'view',
    created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
    UNIQUE KEY uk_mkt_template_acl_tenant_id (tenant_id, id),
    UNIQUE KEY uk_mkt_template_acl_target (tenant_id, template_id, scope_type, scope_target_id)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS mkt_media_assets (
    id VARCHAR(36) NOT NULL PRIMARY KEY,
    tenant_id VARCHAR(36) NOT NULL,
    folder_name VARCHAR(100) NOT NULL DEFAULT 'Chung',
    file_name VARCHAR(255) NOT NULL,
    mime_type VARCHAR(80) NOT NULL DEFAULT 'image/png',
    url MEDIUMTEXT NOT NULL,
    size_bytes INT NOT NULL DEFAULT 0,
    width_px INT NULL,
    height_px INT NULL,
    alt_text VARCHAR(255) NULL,
    tags_json JSON NULL,
    created_by VARCHAR(36) NULL,
    created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
    UNIQUE KEY uk_mkt_media_assets_tenant_id (tenant_id, id),
    INDEX idx_mkt_media_assets_tenant (tenant_id, folder_name, created_at)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS mkt_ai_training_docs (
    id VARCHAR(36) NOT NULL PRIMARY KEY,
    tenant_id VARCHAR(36) NOT NULL,
    title VARCHAR(255) NOT NULL,
    doc_type VARCHAR(40) NOT NULL DEFAULT 'faq',
    source_url TEXT NULL,
    content_text MEDIUMTEXT NULL,
    chunk_count INT NOT NULL DEFAULT 1,
    token_count INT NOT NULL DEFAULT 0,
    status VARCHAR(30) NOT NULL DEFAULT 'indexed',
    metadata_json JSON NULL,
    created_by VARCHAR(36) NULL,
    created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
    updated_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
    UNIQUE KEY uk_mkt_ai_training_docs_tenant_id (tenant_id, id),
    INDEX idx_mkt_ai_docs_tenant (tenant_id, status, updated_at)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS tenant_projects (
      id VARCHAR(36) NOT NULL PRIMARY KEY DEFAULT (UUID()),
      tenant_id VARCHAR(36) NOT NULL,
      code VARCHAR(50) NOT NULL,
      name VARCHAR(200) NOT NULL,
      description TEXT NULL,
      status VARCHAR(30) NOT NULL DEFAULT 'active',
      priority VARCHAR(20) NOT NULL DEFAULT 'medium',
      owner_user_id VARCHAR(36) NULL,
      department_id VARCHAR(36) NULL,
      branch_id VARCHAR(36) NULL,
      start_date DATE NULL,
      due_date DATE NULL,
      budget_vnd BIGINT NOT NULL DEFAULT 0,
      progress_pct INT NOT NULL DEFAULT 0,
      task_columns_json JSON NULL,
      whiteboard_json JSON NULL,
      metadata JSON NULL,
      created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
      updated_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
      CONSTRAINT uk_tenant_projects_tenant_id UNIQUE (tenant_id, id),
      CONSTRAINT uk_tenant_projects_code UNIQUE (tenant_id, code)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS tenant_workflow_task_templates (
      id VARCHAR(36) NOT NULL PRIMARY KEY DEFAULT (UUID()),
      tenant_id VARCHAR(36) NOT NULL,
      pipeline_id VARCHAR(36) NULL,
      stage_id VARCHAR(36) NULL,
      stage_key VARCHAR(64) NULL,
      project_id VARCHAR(36) NULL,
      title_template VARCHAR(255) NOT NULL,
      description_template TEXT NULL,
      priority VARCHAR(20) NOT NULL DEFAULT 'medium',
      due_offset_hours INT NOT NULL DEFAULT 24,
      default_assignee_id VARCHAR(36) NULL,
      checklist_json JSON NULL,
      sort_order INT NOT NULL DEFAULT 0,
      is_active TINYINT(1) NOT NULL DEFAULT 1,
      created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
      updated_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
      CONSTRAINT uk_tenant_workflow_task_templates_tenant_id UNIQUE (tenant_id, id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS tenant_tasks (
      id VARCHAR(36) NOT NULL PRIMARY KEY DEFAULT (UUID()),
      tenant_id VARCHAR(36) NOT NULL,
      project_id VARCHAR(36) NULL,
      lead_id VARCHAR(36) NULL,
      title VARCHAR(255) NOT NULL,
      description TEXT NULL,
      status_key VARCHAR(50) NOT NULL DEFAULT 'todo',
      priority VARCHAR(20) NOT NULL DEFAULT 'medium',
      assignee_user_id VARCHAR(36) NULL,
      reporter_user_id VARCHAR(36) NULL,
      start_date DATETIME(6) NULL,
      due_date DATETIME(6) NULL,
      estimated_minutes INT NOT NULL DEFAULT 60,
      logged_minutes INT NOT NULL DEFAULT 0,
      progress_pct INT NOT NULL DEFAULT 0,
      sort_order INT NOT NULL DEFAULT 0,
      checklist_json JSON NULL,
      dependencies_json JSON NULL,
      source_template_id VARCHAR(36) NULL,
      trigger_stage_id VARCHAR(36) NULL,
      completed_at DATETIME(6) NULL,
      created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
      updated_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
      CONSTRAINT uk_tenant_tasks_tenant_id UNIQUE (tenant_id, id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS tenant_pomodoro_sessions (
      id VARCHAR(36) NOT NULL PRIMARY KEY DEFAULT (UUID()),
      tenant_id VARCHAR(36) NOT NULL,
      task_id VARCHAR(36) NULL,
      user_id VARCHAR(36) NOT NULL,
      duration_minutes INT NOT NULL DEFAULT 25,
      mode VARCHAR(20) NOT NULL DEFAULT 'focus',
      note TEXT NULL,
      started_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
      completed_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
      created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
      CONSTRAINT uk_tenant_pomodoro_sessions_tenant_id UNIQUE (tenant_id, id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS tenant_helpdesk_tickets (
      id VARCHAR(36) NOT NULL PRIMARY KEY DEFAULT (UUID()),
      tenant_id VARCHAR(36) NOT NULL,
      ticket_code VARCHAR(40) NOT NULL,
      subject VARCHAR(255) NOT NULL,
      description TEXT NULL,
      category VARCHAR(60) NOT NULL DEFAULT 'customer_support',
      priority VARCHAR(20) NOT NULL DEFAULT 'medium',
      status VARCHAR(30) NOT NULL DEFAULT 'open',
      lead_id VARCHAR(36) NULL,
      customer_name VARCHAR(150) NULL,
      customer_contact VARCHAR(150) NULL,
      assignee_user_id VARCHAR(36) NULL,
      created_by_user_id VARCHAR(36) NULL,
      sla_response_hours DECIMAL(8,2) NOT NULL DEFAULT 2,
      sla_resolution_hours DECIMAL(8,2) NOT NULL DEFAULT 24,
      response_due_at DATETIME(6) NOT NULL,
      resolution_due_at DATETIME(6) NOT NULL,
      first_responded_at DATETIME(6) NULL,
      resolved_at DATETIME(6) NULL,
      sla_breached TINYINT(1) NOT NULL DEFAULT 0,
      attachments_json JSON NULL,
      created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
      updated_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
      CONSTRAINT uk_tenant_helpdesk_tickets_tenant_id UNIQUE (tenant_id, id),
      CONSTRAINT uk_tenant_helpdesk_code UNIQUE (tenant_id, ticket_code)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS tenant_helpdesk_comments (
      id VARCHAR(36) NOT NULL PRIMARY KEY DEFAULT (UUID()),
      tenant_id VARCHAR(36) NOT NULL,
      ticket_id VARCHAR(36) NOT NULL,
      author_user_id VARCHAR(36) NULL,
      author_name VARCHAR(150) NOT NULL,
      content TEXT NOT NULL,
      is_internal_note TINYINT(1) NOT NULL DEFAULT 0,
      created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
      CONSTRAINT uk_tenant_helpdesk_comments_tenant_id UNIQUE (tenant_id, id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS tenant_workchat_channels (
      id VARCHAR(36) NOT NULL PRIMARY KEY DEFAULT (UUID()),
      tenant_id VARCHAR(36) NOT NULL,
      name VARCHAR(150) NOT NULL,
      channel_type VARCHAR(30) NOT NULL DEFAULT 'group',
      topic TEXT NULL,
      department_id VARCHAR(36) NULL,
      project_id VARCHAR(36) NULL,
      created_by VARCHAR(36) NULL,
      is_archived TINYINT(1) NOT NULL DEFAULT 0,
      last_message_at DATETIME(6) NULL,
      last_message_preview VARCHAR(255) NULL,
      created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
      updated_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
      CONSTRAINT uk_tenant_workchat_channels_tenant_id UNIQUE (tenant_id, id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS tenant_workchat_members (
      id VARCHAR(36) NOT NULL PRIMARY KEY DEFAULT (UUID()),
      tenant_id VARCHAR(36) NOT NULL,
      channel_id VARCHAR(36) NOT NULL,
      user_id VARCHAR(36) NOT NULL,
      member_role VARCHAR(20) NOT NULL DEFAULT 'member',
      last_read_at DATETIME(6) NULL,
      joined_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
      CONSTRAINT uk_tenant_workchat_members_tenant_id UNIQUE (tenant_id, id),
      CONSTRAINT uk_workchat_channel_member UNIQUE (tenant_id, channel_id, user_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS tenant_workchat_messages (
      id VARCHAR(36) NOT NULL PRIMARY KEY DEFAULT (UUID()),
      tenant_id VARCHAR(36) NOT NULL,
      channel_id VARCHAR(36) NOT NULL,
      sender_user_id VARCHAR(36) NULL,
      sender_name VARCHAR(150) NOT NULL,
      parent_message_id VARCHAR(36) NULL,
      message_type VARCHAR(30) NOT NULL DEFAULT 'text',
      content TEXT NOT NULL,
      sticker_pack_id VARCHAR(50) NULL,
      sticker_id VARCHAR(100) NULL,
      attachments_json JSON NULL,
      reactions_json JSON NULL,
      is_pinned TINYINT(1) NOT NULL DEFAULT 0,
      is_deleted TINYINT(1) NOT NULL DEFAULT 0,
      created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
      updated_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
      CONSTRAINT uk_tenant_workchat_messages_tenant_id UNIQUE (tenant_id, id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS tenant_workchat_presence (
      id VARCHAR(36) NOT NULL PRIMARY KEY DEFAULT (UUID()),
      tenant_id VARCHAR(36) NOT NULL,
      user_id VARCHAR(36) NOT NULL,
      status VARCHAR(20) NOT NULL DEFAULT 'online',
      status_text VARCHAR(120) NULL,
      last_seen_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
      updated_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
      CONSTRAINT uk_tenant_workchat_presence_tenant_id UNIQUE (tenant_id, id),
      CONSTRAINT uk_workchat_presence_user UNIQUE (tenant_id, user_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS tenant_feed_posts (
      id VARCHAR(36) NOT NULL PRIMARY KEY DEFAULT (UUID()),
      tenant_id VARCHAR(36) NOT NULL,
      author_user_id VARCHAR(36) NULL,
      author_name VARCHAR(150) NOT NULL,
      title VARCHAR(255) NULL,
      content TEXT NOT NULL,
      post_type VARCHAR(30) NOT NULL DEFAULT 'announcement',
      branch_id VARCHAR(36) NULL,
      department_id VARCHAR(36) NULL,
      is_pinned TINYINT(1) NOT NULL DEFAULT 0,
      attachments_json JSON NULL,
      reactions_json JSON NULL,
      likes_count INT NOT NULL DEFAULT 0,
      comments_count INT NOT NULL DEFAULT 0,
      created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
      updated_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
      CONSTRAINT uk_tenant_feed_posts_tenant_id UNIQUE (tenant_id, id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS tenant_feed_comments (
      id VARCHAR(36) NOT NULL PRIMARY KEY DEFAULT (UUID()),
      tenant_id VARCHAR(36) NOT NULL,
      post_id VARCHAR(36) NOT NULL,
      author_user_id VARCHAR(36) NULL,
      author_name VARCHAR(150) NOT NULL,
      content TEXT NOT NULL,
      created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
      CONSTRAINT uk_tenant_feed_comments_tenant_id UNIQUE (tenant_id, id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS tenant_kudos_recognitions (
      id VARCHAR(36) NOT NULL PRIMARY KEY DEFAULT (UUID()),
      tenant_id VARCHAR(36) NOT NULL,
      sender_user_id VARCHAR(36) NULL,
      sender_name VARCHAR(150) NOT NULL,
      recipient_user_id VARCHAR(36) NOT NULL,
      recipient_name VARCHAR(150) NOT NULL,
      badge_key VARCHAR(50) NOT NULL DEFAULT 'top_performer',
      badge_title VARCHAR(120) NOT NULL DEFAULT 'Chiến binh Xuất sắc',
      points INT NOT NULL DEFAULT 10,
      message TEXT NOT NULL,
      created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
      CONSTRAINT uk_tenant_kudos_recognitions_tenant_id UNIQUE (tenant_id, id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS tenant_b2b_companies (
      id VARCHAR(36) NOT NULL PRIMARY KEY DEFAULT (UUID()),
      tenant_id VARCHAR(36) NOT NULL,
      code VARCHAR(50) NOT NULL,
      name VARCHAR(255) NOT NULL,
      tax_code VARCHAR(50) NULL,
      industry VARCHAR(100) NULL,
      company_size VARCHAR(50) NULL,
      website VARCHAR(255) NULL,
      billing_address TEXT NULL,
      phone VARCHAR(40) NULL,
      email VARCHAR(255) NULL,
      representative_name VARCHAR(150) NULL,
      owner_user_id VARCHAR(36) NULL,
      primary_lead_id VARCHAR(36) NULL,
      contacts_json JSON NULL,
      tier VARCHAR(30) NOT NULL DEFAULT 'standard',
      notes TEXT NULL,
      created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
      updated_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
      CONSTRAINT uk_tenant_b2b_companies_tenant_id UNIQUE (tenant_id, id),
      CONSTRAINT uk_tenant_b2b_companies_code UNIQUE (tenant_id, code)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS tenant_deals (
      id VARCHAR(36) NOT NULL PRIMARY KEY DEFAULT (UUID()),
      tenant_id VARCHAR(36) NOT NULL,
      deal_code VARCHAR(50) NOT NULL,
      title VARCHAR(255) NOT NULL,
      company_id VARCHAR(36) NULL,
      lead_id VARCHAR(36) NULL,
      owner_user_id VARCHAR(36) NULL,
      stage VARCHAR(40) NOT NULL DEFAULT 'qualification',
      amount_vnd BIGINT NOT NULL DEFAULT 0,
      probability INT NOT NULL DEFAULT 30,
      expected_close_date DATE NULL,
      actual_close_date DATE NULL,
      lost_reason TEXT NULL,
      notes TEXT NULL,
      metadata JSON NULL,
      created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
      updated_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
      CONSTRAINT uk_tenant_deals_tenant_id UNIQUE (tenant_id, id),
      CONSTRAINT uk_tenant_deals_code UNIQUE (tenant_id, deal_code)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS tenant_suppliers (
      id VARCHAR(36) NOT NULL PRIMARY KEY DEFAULT (UUID()),
      tenant_id VARCHAR(36) NOT NULL,
      code VARCHAR(50) NOT NULL,
      name VARCHAR(255) NOT NULL,
      tax_code VARCHAR(50) NULL,
      contact_name VARCHAR(150) NULL,
      phone VARCHAR(40) NULL,
      email VARCHAR(255) NULL,
      address TEXT NULL,
      payment_terms VARCHAR(100) NULL,
      rating INT NOT NULL DEFAULT 5,
      is_active TINYINT(1) NOT NULL DEFAULT 1,
      created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
      updated_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
      CONSTRAINT uk_tenant_suppliers_tenant_id UNIQUE (tenant_id, id),
      CONSTRAINT uk_tenant_suppliers_code UNIQUE (tenant_id, code)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS tenant_warehouses (
      id VARCHAR(36) NOT NULL PRIMARY KEY DEFAULT (UUID()),
      tenant_id VARCHAR(36) NOT NULL,
      code VARCHAR(50) NOT NULL,
      name VARCHAR(150) NOT NULL,
      branch_id VARCHAR(36) NULL,
      address TEXT NULL,
      manager_user_id VARCHAR(36) NULL,
      is_default TINYINT(1) NOT NULL DEFAULT 0,
      is_active TINYINT(1) NOT NULL DEFAULT 1,
      created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
      updated_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
      CONSTRAINT uk_tenant_warehouses_tenant_id UNIQUE (tenant_id, id),
      CONSTRAINT uk_tenant_warehouses_code UNIQUE (tenant_id, code)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS tenant_products (
      id VARCHAR(36) NOT NULL PRIMARY KEY DEFAULT (UUID()),
      tenant_id VARCHAR(36) NOT NULL,
      sku VARCHAR(80) NOT NULL,
      barcode VARCHAR(80) NULL,
      name VARCHAR(255) NOT NULL,
      category VARCHAR(100) NOT NULL DEFAULT 'general',
      unit VARCHAR(40) NOT NULL DEFAULT 'Cái',
      product_type VARCHAR(20) NOT NULL DEFAULT 'goods',
      sale_price_vnd BIGINT NOT NULL DEFAULT 0,
      default_cost_vnd BIGINT NOT NULL DEFAULT 0,
      tax_rate_pct DECIMAL(5,2) NOT NULL DEFAULT 0,
      min_stock_alert INT NOT NULL DEFAULT 5,
      cached_stock_qty INT NOT NULL DEFAULT 0,
      is_active TINYINT(1) NOT NULL DEFAULT 1,
      metadata JSON NULL,
      created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
      updated_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
      CONSTRAINT uk_tenant_products_tenant_id UNIQUE (tenant_id, id),
      CONSTRAINT uk_tenant_products_sku UNIQUE (tenant_id, sku)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS tenant_quotes (
      id VARCHAR(36) NOT NULL PRIMARY KEY DEFAULT (UUID()),
      tenant_id VARCHAR(36) NOT NULL,
      quote_code VARCHAR(50) NOT NULL,
      title VARCHAR(255) NOT NULL,
      company_id VARCHAR(36) NULL,
      lead_id VARCHAR(36) NULL,
      deal_id VARCHAR(36) NULL,
      branch_id VARCHAR(36) NULL,
      status VARCHAR(30) NOT NULL DEFAULT 'draft',
      items_json JSON NULL,
      subtotal_vnd BIGINT NOT NULL DEFAULT 0,
      discount_vnd BIGINT NOT NULL DEFAULT 0,
      tax_vnd BIGINT NOT NULL DEFAULT 0,
      total_vnd BIGINT NOT NULL DEFAULT 0,
      valid_until DATE NULL,
      terms_text TEXT NULL,
      converted_order_id VARCHAR(36) NULL,
      created_by VARCHAR(36) NULL,
      created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
      updated_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
      CONSTRAINT uk_tenant_quotes_tenant_id UNIQUE (tenant_id, id),
      CONSTRAINT uk_tenant_quotes_code UNIQUE (tenant_id, quote_code)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS tenant_sales_orders (
      id VARCHAR(36) NOT NULL PRIMARY KEY DEFAULT (UUID()),
      tenant_id VARCHAR(36) NOT NULL,
      order_code VARCHAR(50) NOT NULL,
      quote_id VARCHAR(36) NULL,
      company_id VARCHAR(36) NULL,
      lead_id VARCHAR(36) NULL,
      deal_id VARCHAR(36) NULL,
      branch_id VARCHAR(36) NULL,
      warehouse_id VARCHAR(36) NULL,
      sales_rep_id VARCHAR(36) NULL,
      customer_name VARCHAR(200) NOT NULL,
      status VARCHAR(30) NOT NULL DEFAULT 'confirmed',
      payment_status VARCHAR(30) NOT NULL DEFAULT 'unpaid',
      fulfillment_status VARCHAR(30) NOT NULL DEFAULT 'pending',
      items_json JSON NULL,
      subtotal_vnd BIGINT NOT NULL DEFAULT 0,
      discount_vnd BIGINT NOT NULL DEFAULT 0,
      tax_vnd BIGINT NOT NULL DEFAULT 0,
      total_vnd BIGINT NOT NULL DEFAULT 0,
      paid_vnd BIGINT NOT NULL DEFAULT 0,
      attributed_revenue_vnd BIGINT NOT NULL DEFAULT 0,
      cogs_vnd BIGINT NOT NULL DEFAULT 0,
      notes TEXT NULL,
      completed_at DATETIME(6) NULL,
      created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
      updated_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
      CONSTRAINT uk_tenant_sales_orders_tenant_id UNIQUE (tenant_id, id),
      CONSTRAINT uk_tenant_sales_orders_code UNIQUE (tenant_id, order_code)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS tenant_deposits (
      id VARCHAR(36) NOT NULL PRIMARY KEY DEFAULT (UUID()),
      tenant_id VARCHAR(36) NOT NULL,
      deposit_code VARCHAR(50) NOT NULL,
      lead_id VARCHAR(36) NULL,
      company_id VARCHAR(36) NULL,
      deal_id VARCHAR(36) NULL,
      sales_order_id VARCHAR(36) NULL,
      customer_name VARCHAR(200) NOT NULL,
      amount_vnd BIGINT NOT NULL DEFAULT 0,
      payment_method VARCHAR(40) NOT NULL DEFAULT 'bank_transfer',
      status VARCHAR(30) NOT NULL DEFAULT 'received',
      reference_no VARCHAR(100) NULL,
      notes TEXT NULL,
      received_by VARCHAR(36) NULL,
      received_at DATETIME(6) NULL,
      created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
      updated_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
      CONSTRAINT uk_tenant_deposits_tenant_id UNIQUE (tenant_id, id),
      CONSTRAINT uk_tenant_deposits_code UNIQUE (tenant_id, deposit_code)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS tenant_purchase_orders (
      id VARCHAR(36) NOT NULL PRIMARY KEY DEFAULT (UUID()),
      tenant_id VARCHAR(36) NOT NULL,
      po_code VARCHAR(50) NOT NULL,
      supplier_id VARCHAR(36) NULL,
      warehouse_id VARCHAR(36) NULL,
      supplier_name VARCHAR(200) NOT NULL,
      status VARCHAR(30) NOT NULL DEFAULT 'draft',
      items_json JSON NULL,
      total_vnd BIGINT NOT NULL DEFAULT 0,
      expected_date DATE NULL,
      received_at DATETIME(6) NULL,
      notes TEXT NULL,
      created_by VARCHAR(36) NULL,
      created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
      updated_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
      CONSTRAINT uk_tenant_purchase_orders_tenant_id UNIQUE (tenant_id, id),
      CONSTRAINT uk_tenant_po_code UNIQUE (tenant_id, po_code)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS tenant_finance_transactions (
      id VARCHAR(36) NOT NULL PRIMARY KEY DEFAULT (UUID()),
      tenant_id VARCHAR(36) NOT NULL,
      tx_code VARCHAR(50) NOT NULL,
      tx_type VARCHAR(20) NOT NULL,
      category VARCHAR(80) NOT NULL DEFAULT 'sales_revenue',
      amount_vnd BIGINT NOT NULL DEFAULT 0,
      payment_method VARCHAR(40) NOT NULL DEFAULT 'bank_transfer',
      status VARCHAR(30) NOT NULL DEFAULT 'completed',
      counterparty_name VARCHAR(200) NULL,
      counterparty_tax_code VARCHAR(50) NULL,
      branch_id VARCHAR(36) NULL,
      lead_id VARCHAR(36) NULL,
      company_id VARCHAR(36) NULL,
      sales_order_id VARCHAR(36) NULL,
      purchase_order_id VARCHAR(36) NULL,
      deposit_id VARCHAR(36) NULL,
      tx_date DATE NOT NULL,
      description TEXT NULL,
      created_by VARCHAR(36) NULL,
      created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
      updated_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
      CONSTRAINT uk_tenant_finance_transactions_tenant_id UNIQUE (tenant_id, id),
      CONSTRAINT uk_tenant_fin_tx_code UNIQUE (tenant_id, tx_code)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS tenant_inventory_batches (
      id VARCHAR(36) NOT NULL PRIMARY KEY DEFAULT (UUID()),
      tenant_id VARCHAR(36) NOT NULL,
      product_id VARCHAR(36) NOT NULL,
      warehouse_id VARCHAR(36) NULL,
      supplier_id VARCHAR(36) NULL,
      purchase_order_id VARCHAR(36) NULL,
      batch_code VARCHAR(80) NOT NULL,
      initial_qty INT NOT NULL,
      remaining_qty INT NOT NULL,
      unit_cost_vnd BIGINT NOT NULL DEFAULT 0,
      received_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
      expiry_date DATE NULL,
      status VARCHAR(20) NOT NULL DEFAULT 'active',
      notes TEXT NULL,
      created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
      updated_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
      CONSTRAINT uk_tenant_inventory_batches_tenant_id UNIQUE (tenant_id, id),
      CONSTRAINT uk_tenant_inv_batch_code UNIQUE (tenant_id, batch_code)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS tenant_stock_movements (
      id VARCHAR(36) NOT NULL PRIMARY KEY DEFAULT (UUID()),
      tenant_id VARCHAR(36) NOT NULL,
      product_id VARCHAR(36) NOT NULL,
      batch_id VARCHAR(36) NULL,
      warehouse_id VARCHAR(36) NULL,
      movement_type VARCHAR(30) NOT NULL,
      qty_delta INT NOT NULL,
      unit_cost_vnd BIGINT NOT NULL DEFAULT 0,
      total_cost_vnd BIGINT NOT NULL DEFAULT 0,
      reference_type VARCHAR(40) NULL,
      reference_id VARCHAR(80) NULL,
      note TEXT NULL,
      created_by VARCHAR(36) NULL,
      created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
      CONSTRAINT uk_tenant_stock_movements_tenant_id UNIQUE (tenant_id, id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS tenant_fixed_assets (
      id VARCHAR(36) NOT NULL PRIMARY KEY DEFAULT (UUID()),
      tenant_id VARCHAR(36) NOT NULL,
      asset_code VARCHAR(60) NOT NULL,
      name VARCHAR(255) NOT NULL,
      category VARCHAR(80) NOT NULL DEFAULT 'IT Equipment',
      serial_number VARCHAR(100) NULL,
      branch_id VARCHAR(36) NULL,
      department_id VARCHAR(36) NULL,
      assigned_user_id VARCHAR(36) NULL,
      purchase_date DATE NOT NULL,
      purchase_cost_vnd BIGINT NOT NULL DEFAULT 0,
      salvage_value_vnd BIGINT NOT NULL DEFAULT 0,
      useful_life_months INT NOT NULL DEFAULT 36,
      status VARCHAR(30) NOT NULL DEFAULT 'in_use',
      notes TEXT NULL,
      created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
      updated_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
      CONSTRAINT uk_tenant_fixed_assets_tenant_id UNIQUE (tenant_id, id),
      CONSTRAINT uk_tenant_fixed_asset_code UNIQUE (tenant_id, asset_code)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS tenant_cloud_folders (
      id VARCHAR(36) NOT NULL PRIMARY KEY DEFAULT (UUID()),
      tenant_id VARCHAR(36) NOT NULL,
      parent_folder_id VARCHAR(36) NULL,
      name VARCHAR(200) NOT NULL,
      storage_prefix VARCHAR(500) NOT NULL,
      visibility VARCHAR(30) NOT NULL DEFAULT 'company',
      allowed_department_ids JSON NULL,
      created_by VARCHAR(36) NULL,
      created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
      updated_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
      CONSTRAINT uk_tenant_cloud_folders_tenant_id UNIQUE (tenant_id, id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS tenant_cloud_files (
      id VARCHAR(36) NOT NULL PRIMARY KEY DEFAULT (UUID()),
      tenant_id VARCHAR(36) NOT NULL,
      folder_id VARCHAR(36) NULL,
      project_id VARCHAR(36) NULL,
      name VARCHAR(255) NOT NULL,
      storage_key VARCHAR(600) NOT NULL,
      mime_type VARCHAR(120) NOT NULL DEFAULT 'application/octet-stream',
      size_bytes BIGINT NOT NULL DEFAULT 0,
      version_tag VARCHAR(40) NOT NULL DEFAULT 'v1.0',
      visibility VARCHAR(30) NOT NULL DEFAULT 'company',
      allowed_department_ids JSON NULL,
      checksum_sha256 VARCHAR(80) NULL,
      content_preview TEXT NULL,
      uploaded_by VARCHAR(36) NULL,
      uploaded_by_name VARCHAR(150) NULL,
      created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
      updated_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
      CONSTRAINT uk_tenant_cloud_files_tenant_id UNIQUE (tenant_id, id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS tenant_ocr_extractions (
      id VARCHAR(36) NOT NULL PRIMARY KEY DEFAULT (UUID()),
      tenant_id VARCHAR(36) NOT NULL,
      doc_type VARCHAR(40) NOT NULL DEFAULT 'contract',
      source_file_id VARCHAR(36) NULL,
      source_title VARCHAR(255) NOT NULL,
      raw_text TEXT NOT NULL,
      extracted_party_name VARCHAR(255) NULL,
      extracted_tax_code VARCHAR(60) NULL,
      extracted_id_number VARCHAR(60) NULL,
      extracted_representative VARCHAR(150) NULL,
      extracted_address TEXT NULL,
      contract_value_vnd BIGINT NOT NULL DEFAULT 0,
      effective_date DATE NULL,
      expiry_date DATE NULL,
      branch_verification_json JSON NULL,
      extracted_fields_json JSON NULL,
      saved_company_id VARCHAR(36) NULL,
      saved_transaction_id VARCHAR(36) NULL,
      created_by VARCHAR(36) NULL,
      created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
      CONSTRAINT uk_tenant_ocr_extractions_tenant_id UNIQUE (tenant_id, id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS tenant_edu_courses (
      id VARCHAR(36) NOT NULL PRIMARY KEY DEFAULT (UUID()),
      tenant_id VARCHAR(36) NOT NULL,
      code VARCHAR(50) NOT NULL,
      name VARCHAR(255) NOT NULL,
      category VARCHAR(100) NOT NULL DEFAULT 'Program',
      duration_sessions INT NOT NULL DEFAULT 12,
      tuition_fee_vnd BIGINT NOT NULL DEFAULT 0,
      description TEXT NULL,
      is_active TINYINT(1) NOT NULL DEFAULT 1,
      created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
      updated_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
      CONSTRAINT uk_tenant_edu_courses_tenant_id UNIQUE (tenant_id, id),
      CONSTRAINT uk_tenant_edu_courses_code UNIQUE (tenant_id, code)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS tenant_edu_classes (
      id VARCHAR(36) NOT NULL PRIMARY KEY DEFAULT (UUID()),
      tenant_id VARCHAR(36) NOT NULL,
      course_id VARCHAR(36) NOT NULL,
      code VARCHAR(50) NOT NULL,
      name VARCHAR(200) NOT NULL,
      instructor_user_id VARCHAR(36) NULL,
      instructor_name VARCHAR(150) NULL,
      branch_id VARCHAR(36) NULL,
      room_name VARCHAR(100) NULL,
      max_capacity INT NOT NULL DEFAULT 30,
      start_date DATE NULL,
      end_date DATE NULL,
      status VARCHAR(30) NOT NULL DEFAULT 'enrolling',
      created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
      updated_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
      CONSTRAINT uk_tenant_edu_classes_tenant_id UNIQUE (tenant_id, id),
      CONSTRAINT uk_tenant_edu_classes_code UNIQUE (tenant_id, code)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS tenant_edu_schedules (
      id VARCHAR(36) NOT NULL PRIMARY KEY DEFAULT (UUID()),
      tenant_id VARCHAR(36) NOT NULL,
      class_id VARCHAR(36) NOT NULL,
      day_of_week INT NOT NULL,
      start_time VARCHAR(10) NOT NULL,
      end_time VARCHAR(10) NOT NULL,
      room_name VARCHAR(100) NOT NULL,
      instructor_user_id VARCHAR(36) NULL,
      instructor_name VARCHAR(150) NULL,
      topic VARCHAR(255) NULL,
      created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
      CONSTRAINT uk_tenant_edu_schedules_tenant_id UNIQUE (tenant_id, id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS tenant_edu_enrollments (
      id VARCHAR(36) NOT NULL PRIMARY KEY DEFAULT (UUID()),
      tenant_id VARCHAR(36) NOT NULL,
      class_id VARCHAR(36) NOT NULL,
      lead_id VARCHAR(36) NULL,
      student_name VARCHAR(150) NOT NULL,
      student_phone VARCHAR(40) NULL,
      student_email VARCHAR(255) NULL,
      status VARCHAR(30) NOT NULL DEFAULT 'active',
      tuition_paid_vnd BIGINT NOT NULL DEFAULT 0,
      enrolled_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
      updated_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
      CONSTRAINT uk_tenant_edu_enrollments_tenant_id UNIQUE (tenant_id, id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS tenant_edu_attendance_grades (
      id VARCHAR(36) NOT NULL PRIMARY KEY DEFAULT (UUID()),
      tenant_id VARCHAR(36) NOT NULL,
      enrollment_id VARCHAR(36) NOT NULL,
      class_id VARCHAR(36) NOT NULL,
      session_date DATE NOT NULL,
      attendance_status VARCHAR(20) NOT NULL DEFAULT 'present',
      midterm_score DECIMAL(5,2) NULL,
      final_score DECIMAL(5,2) NULL,
      gpa_score DECIMAL(5,2) NULL,
      feedback TEXT NULL,
      recorded_by VARCHAR(36) NULL,
      created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
      updated_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
      CONSTRAINT uk_tenant_edu_attendance_grades_tenant_id UNIQUE (tenant_id, id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS tenant_quote_items (
      id VARCHAR(36) NOT NULL PRIMARY KEY DEFAULT (UUID()),
      tenant_id VARCHAR(36) NOT NULL,
      quote_id VARCHAR(36) NOT NULL,
      product_id VARCHAR(36) NULL,
      sku VARCHAR(80) NOT NULL DEFAULT '',
      name VARCHAR(255) NOT NULL,
      description TEXT NULL,
      unit VARCHAR(40) NOT NULL DEFAULT 'Cái',
      qty DECIMAL(12,2) NOT NULL DEFAULT 1,
      unit_price_vnd BIGINT NOT NULL DEFAULT 0,
      discount_pct DECIMAL(5,2) NOT NULL DEFAULT 0,
      tax_pct DECIMAL(5,2) NOT NULL DEFAULT 0,
      line_subtotal_vnd BIGINT NOT NULL DEFAULT 0,
      line_discount_vnd BIGINT NOT NULL DEFAULT 0,
      line_tax_vnd BIGINT NOT NULL DEFAULT 0,
      line_total_vnd BIGINT NOT NULL DEFAULT 0,
      sort_order INT NOT NULL DEFAULT 0,
      created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
      CONSTRAINT uk_tenant_quote_items_tenant_id UNIQUE (tenant_id, id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS tenant_sales_order_items (
      id VARCHAR(36) NOT NULL PRIMARY KEY DEFAULT (UUID()),
      tenant_id VARCHAR(36) NOT NULL,
      sales_order_id VARCHAR(36) NOT NULL,
      product_id VARCHAR(36) NULL,
      sku VARCHAR(80) NOT NULL DEFAULT '',
      name VARCHAR(255) NOT NULL,
      description TEXT NULL,
      unit VARCHAR(40) NOT NULL DEFAULT 'Cái',
      qty DECIMAL(12,2) NOT NULL DEFAULT 1,
      fulfilled_qty DECIMAL(12,2) NOT NULL DEFAULT 0,
      unit_price_vnd BIGINT NOT NULL DEFAULT 0,
      discount_pct DECIMAL(5,2) NOT NULL DEFAULT 0,
      tax_pct DECIMAL(5,2) NOT NULL DEFAULT 0,
      line_subtotal_vnd BIGINT NOT NULL DEFAULT 0,
      line_discount_vnd BIGINT NOT NULL DEFAULT 0,
      line_tax_vnd BIGINT NOT NULL DEFAULT 0,
      line_total_vnd BIGINT NOT NULL DEFAULT 0,
      sort_order INT NOT NULL DEFAULT 0,
      created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
      CONSTRAINT uk_tenant_so_items_tenant_id UNIQUE (tenant_id, id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS tenant_purchase_order_items (
      id VARCHAR(36) NOT NULL PRIMARY KEY DEFAULT (UUID()),
      tenant_id VARCHAR(36) NOT NULL,
      purchase_order_id VARCHAR(36) NOT NULL,
      product_id VARCHAR(36) NULL,
      sku VARCHAR(80) NOT NULL DEFAULT '',
      name VARCHAR(255) NOT NULL,
      unit VARCHAR(40) NOT NULL DEFAULT 'Cái',
      ordered_qty DECIMAL(12,2) NOT NULL DEFAULT 1,
      received_qty DECIMAL(12,2) NOT NULL DEFAULT 0,
      invoiced_qty DECIMAL(12,2) NOT NULL DEFAULT 0,
      unit_price_vnd BIGINT NOT NULL DEFAULT 0,
      discount_pct DECIMAL(5,2) NOT NULL DEFAULT 0,
      tax_pct DECIMAL(5,2) NOT NULL DEFAULT 0,
      line_total_vnd BIGINT NOT NULL DEFAULT 0,
      match_note TEXT NULL,
      sort_order INT NOT NULL DEFAULT 0,
      created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
      CONSTRAINT uk_tenant_po_items_tenant_id UNIQUE (tenant_id, id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS tenant_invoices (
      id VARCHAR(36) NOT NULL PRIMARY KEY DEFAULT (UUID()),
      tenant_id VARCHAR(36) NOT NULL,
      invoice_code VARCHAR(60) NOT NULL,
      invoice_type VARCHAR(20) NOT NULL DEFAULT 'sales',
      sales_order_id VARCHAR(36) NULL,
      purchase_order_id VARCHAR(36) NULL,
      quote_id VARCHAR(36) NULL,
      deposit_id VARCHAR(36) NULL,
      company_id VARCHAR(36) NULL,
      lead_id VARCHAR(36) NULL,
      supplier_id VARCHAR(36) NULL,
      branch_id VARCHAR(36) NULL,
      customer_name VARCHAR(200) NOT NULL,
      customer_tax_code VARCHAR(60) NULL,
      customer_address TEXT NULL,
      customer_email VARCHAR(255) NULL,
      status VARCHAR(30) NOT NULL DEFAULT 'issued',
      issue_date DATE NOT NULL,
      due_date DATE NULL,
      items_json JSON NULL,
      subtotal_vnd BIGINT NOT NULL DEFAULT 0,
      discount_vnd BIGINT NOT NULL DEFAULT 0,
      tax_vnd BIGINT NOT NULL DEFAULT 0,
      shipping_fee_vnd BIGINT NOT NULL DEFAULT 0,
      total_vnd BIGINT NOT NULL DEFAULT 0,
      paid_vnd BIGINT NOT NULL DEFAULT 0,
      payment_method VARCHAR(40) NOT NULL DEFAULT 'bank_transfer',
      vat_invoice_no VARCHAR(80) NULL,
      vat_serial VARCHAR(40) NULL,
      notes TEXT NULL,
      created_by VARCHAR(36) NULL,
      created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
      updated_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
      CONSTRAINT uk_tenant_invoices_tenant_id UNIQUE (tenant_id, id),
      CONSTRAINT uk_tenant_invoices_code UNIQUE (tenant_id, invoice_code)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS tenant_invoice_items (
      id VARCHAR(36) NOT NULL PRIMARY KEY DEFAULT (UUID()),
      tenant_id VARCHAR(36) NOT NULL,
      invoice_id VARCHAR(36) NOT NULL,
      product_id VARCHAR(36) NULL,
      sku VARCHAR(80) NOT NULL DEFAULT '',
      name VARCHAR(255) NOT NULL,
      description TEXT NULL,
      unit VARCHAR(40) NOT NULL DEFAULT 'Cái',
      qty DECIMAL(12,2) NOT NULL DEFAULT 1,
      unit_price_vnd BIGINT NOT NULL DEFAULT 0,
      discount_pct DECIMAL(5,2) NOT NULL DEFAULT 0,
      tax_pct DECIMAL(5,2) NOT NULL DEFAULT 0,
      line_total_vnd BIGINT NOT NULL DEFAULT 0,
      sort_order INT NOT NULL DEFAULT 0,
      created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
      CONSTRAINT uk_tenant_invoice_items_tenant_id UNIQUE (tenant_id, id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS tenant_deposit_milestones (
      id VARCHAR(36) NOT NULL PRIMARY KEY DEFAULT (UUID()),
      tenant_id VARCHAR(36) NOT NULL,
      deposit_id VARCHAR(36) NOT NULL,
      tranche_no INT NOT NULL DEFAULT 1,
      name VARCHAR(200) NOT NULL,
      amount_vnd BIGINT NOT NULL DEFAULT 0,
      expected_pay_date DATE NULL,
      paid_at DATETIME(6) NULL,
      status VARCHAR(30) NOT NULL DEFAULT 'pending',
      payment_method VARCHAR(40) NOT NULL DEFAULT 'bank_transfer',
      unc_url TEXT NULL,
      reference_no VARCHAR(100) NULL,
      confirmed_by VARCHAR(36) NULL,
      confirmed_by_name VARCHAR(150) NULL,
      note TEXT NULL,
      created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
      updated_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
      CONSTRAINT uk_tenant_dep_milestones_tenant_id UNIQUE (tenant_id, id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS tenant_expenses (
      id VARCHAR(36) NOT NULL PRIMARY KEY DEFAULT (UUID()),
      tenant_id VARCHAR(36) NOT NULL,
      expense_code VARCHAR(60) NOT NULL,
      title VARCHAR(255) NOT NULL,
      category VARCHAR(80) NOT NULL DEFAULT 'operating_expense',
      branch_id VARCHAR(36) NULL,
      department_id VARCHAR(36) NULL,
      project_id VARCHAR(36) NULL,
      supplier_id VARCHAR(36) NULL,
      vendor_name VARCHAR(200) NULL,
      vendor_tax_code VARCHAR(60) NULL,
      requester_user_id VARCHAR(36) NULL,
      requester_name VARCHAR(150) NULL,
      approver_user_id VARCHAR(36) NULL,
      approval_request_id VARCHAR(36) NULL,
      approval_status VARCHAR(40) NOT NULL DEFAULT 'pending_approval',
      has_vat_invoice TINYINT(1) NOT NULL DEFAULT 0,
      is_vat_inclusive TINYINT(1) NOT NULL DEFAULT 1,
      vat_invoice_no VARCHAR(80) NULL,
      currency VARCHAR(10) NOT NULL DEFAULT 'VND',
      subtotal_vnd BIGINT NOT NULL DEFAULT 0,
      vat_amount_vnd BIGINT NOT NULL DEFAULT 0,
      total_amount_vnd BIGINT NOT NULL DEFAULT 0,
      payment_method VARCHAR(40) NOT NULL DEFAULT 'bank_transfer',
      bank_name VARCHAR(120) NULL,
      bank_bin VARCHAR(30) NULL,
      bank_account_no VARCHAR(80) NULL,
      bank_account_holder VARCHAR(150) NULL,
      expense_date DATE NOT NULL,
      due_date DATE NULL,
      paid_at DATETIME(6) NULL,
      refund_status VARCHAR(30) NOT NULL DEFAULT 'none',
      refund_amount_vnd BIGINT NOT NULL DEFAULT 0,
      refund_attachment_url TEXT NULL,
      refunded_at DATETIME(6) NULL,
      line_items_json JSON NULL,
      attachments_json JSON NULL,
      watchers_json JSON NULL,
      history_json JSON NULL,
      notes TEXT NULL,
      created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
      updated_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
      CONSTRAINT uk_tenant_expenses_tenant_id UNIQUE (tenant_id, id),
      CONSTRAINT uk_tenant_expenses_code UNIQUE (tenant_id, expense_code)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS tenant_pos_sessions (
      id VARCHAR(36) NOT NULL PRIMARY KEY DEFAULT (UUID()),
      tenant_id VARCHAR(36) NOT NULL,
      session_code VARCHAR(60) NOT NULL,
      branch_id VARCHAR(36) NULL,
      warehouse_id VARCHAR(36) NULL,
      cashier_user_id VARCHAR(36) NULL,
      cashier_name VARCHAR(150) NULL,
      status VARCHAR(20) NOT NULL DEFAULT 'open',
      opening_cash_vnd BIGINT NOT NULL DEFAULT 0,
      cash_sales_vnd BIGINT NOT NULL DEFAULT 0,
      bank_sales_vnd BIGINT NOT NULL DEFAULT 0,
      card_sales_vnd BIGINT NOT NULL DEFAULT 0,
      expected_closing_cash_vnd BIGINT NOT NULL DEFAULT 0,
      actual_closing_cash_vnd BIGINT NOT NULL DEFAULT 0,
      variance_vnd BIGINT NOT NULL DEFAULT 0,
      orders_count INT NOT NULL DEFAULT 0,
      opened_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
      closed_at DATETIME(6) NULL,
      closing_note TEXT NULL,
      created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
      updated_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
      CONSTRAINT uk_tenant_pos_sessions_tenant_id UNIQUE (tenant_id, id),
      CONSTRAINT uk_tenant_pos_sessions_code UNIQUE (tenant_id, session_code)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS tenant_pos_orders (
      id VARCHAR(36) NOT NULL PRIMARY KEY DEFAULT (UUID()),
      tenant_id VARCHAR(36) NOT NULL,
      pos_order_code VARCHAR(60) NOT NULL,
      session_id VARCHAR(36) NULL,
      sales_order_id VARCHAR(36) NULL,
      lead_id VARCHAR(36) NULL,
      branch_id VARCHAR(36) NULL,
      warehouse_id VARCHAR(36) NULL,
      cashier_user_id VARCHAR(36) NULL,
      customer_name VARCHAR(200) NOT NULL DEFAULT 'Khách lẻ POS',
      customer_phone VARCHAR(40) NULL,
      items_json JSON NULL,
      subtotal_vnd BIGINT NOT NULL DEFAULT 0,
      discount_vnd BIGINT NOT NULL DEFAULT 0,
      voucher_code VARCHAR(80) NULL,
      voucher_discount_vnd BIGINT NOT NULL DEFAULT 0,
      shipping_fee_vnd BIGINT NOT NULL DEFAULT 0,
      tax_vnd BIGINT NOT NULL DEFAULT 0,
      total_vnd BIGINT NOT NULL DEFAULT 0,
      cash_paid_vnd BIGINT NOT NULL DEFAULT 0,
      bank_paid_vnd BIGINT NOT NULL DEFAULT 0,
      payment_method VARCHAR(40) NOT NULL DEFAULT 'cash',
      cogs_vnd BIGINT NOT NULL DEFAULT 0,
      status VARCHAR(30) NOT NULL DEFAULT 'completed',
      notes TEXT NULL,
      created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
      CONSTRAINT uk_tenant_pos_orders_tenant_id UNIQUE (tenant_id, id),
      CONSTRAINT uk_tenant_pos_orders_code UNIQUE (tenant_id, pos_order_code)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS tenant_inventory_sync_sheets (
      id VARCHAR(36) NOT NULL PRIMARY KEY DEFAULT (UUID()),
      tenant_id VARCHAR(36) NOT NULL,
      sheet_name VARCHAR(150) NOT NULL DEFAULT 'Sheet1',
      spreadsheet_id VARCHAR(255) NOT NULL,
      webhook_token VARCHAR(120) NOT NULL,
      warehouse_id VARCHAR(36) NULL,
      sync_interval_minutes INT NOT NULL DEFAULT 15,
      is_active TINYINT(1) NOT NULL DEFAULT 1,
      sync_status VARCHAR(30) NOT NULL DEFAULT 'idle',
      last_sync_at DATETIME(6) NULL,
      last_error TEXT NULL,
      mappings_json JSON NULL,
      history_json JSON NULL,
      created_by VARCHAR(36) NULL,
      created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
      updated_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
      CONSTRAINT uk_tenant_inv_sync_sheets_tenant_id UNIQUE (tenant_id, id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS tenant_project_roster (
      id VARCHAR(36) NOT NULL PRIMARY KEY DEFAULT (UUID()),
      tenant_id VARCHAR(36) NOT NULL,
      project_id VARCHAR(36) NOT NULL,
      user_id VARCHAR(36) NOT NULL,
      user_name VARCHAR(150) NOT NULL,
      role_in_project VARCHAR(30) NOT NULL DEFAULT 'member',
      can_edit_tasks TINYINT(1) NOT NULL DEFAULT 1,
      can_manage_roster TINYINT(1) NOT NULL DEFAULT 0,
      can_edit_whiteboard TINYINT(1) NOT NULL DEFAULT 1,
      allocation_pct INT NOT NULL DEFAULT 100,
      added_by VARCHAR(36) NULL,
      created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
      updated_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
      CONSTRAINT uk_tenant_project_roster_tenant_id UNIQUE (tenant_id, id),
      CONSTRAINT uk_project_roster_member UNIQUE (tenant_id, project_id, user_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS tenant_task_dependencies (
      id VARCHAR(36) NOT NULL PRIMARY KEY DEFAULT (UUID()),
      tenant_id VARCHAR(36) NOT NULL,
      project_id VARCHAR(36) NULL,
      task_id VARCHAR(36) NOT NULL,
      predecessor_task_id VARCHAR(36) NOT NULL,
      dependency_type VARCHAR(10) NOT NULL DEFAULT 'FS',
      lag_days INT NOT NULL DEFAULT 0,
      created_by VARCHAR(36) NULL,
      created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
      CONSTRAINT uk_tenant_task_deps_tenant_id UNIQUE (tenant_id, id),
      CONSTRAINT uk_task_dep_pair UNIQUE (tenant_id, task_id, predecessor_task_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS tenant_task_comments (
      id VARCHAR(36) NOT NULL PRIMARY KEY DEFAULT (UUID()),
      tenant_id VARCHAR(36) NOT NULL,
      task_id VARCHAR(36) NOT NULL,
      author_user_id VARCHAR(36) NULL,
      author_name VARCHAR(150) NOT NULL,
      content TEXT NOT NULL,
      mentions_json JSON NULL,
      attachments_json JSON NULL,
      created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
      updated_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
      CONSTRAINT uk_tenant_task_comments_tenant_id UNIQUE (tenant_id, id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS tenant_task_attachments (
      id VARCHAR(36) NOT NULL PRIMARY KEY DEFAULT (UUID()),
      tenant_id VARCHAR(36) NOT NULL,
      task_id VARCHAR(36) NOT NULL,
      file_name VARCHAR(255) NOT NULL,
      file_url TEXT NOT NULL,
      mime_type VARCHAR(120) NOT NULL DEFAULT 'application/octet-stream',
      size_bytes BIGINT NOT NULL DEFAULT 0,
      uploaded_by VARCHAR(36) NULL,
      uploaded_by_name VARCHAR(150) NULL,
      created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
      CONSTRAINT uk_tenant_task_attachments_tenant_id UNIQUE (tenant_id, id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS tenant_task_whiteboard_snapshots (
      id VARCHAR(36) NOT NULL PRIMARY KEY DEFAULT (UUID()),
      tenant_id VARCHAR(36) NOT NULL,
      project_id VARCHAR(36) NOT NULL,
      snapshot_name VARCHAR(200) NOT NULL,
      version_no INT NOT NULL DEFAULT 1,
      snapshot_json JSON NULL,
      thumbnail_note TEXT NULL,
      created_by VARCHAR(36) NULL,
      created_by_name VARCHAR(150) NULL,
      created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
      CONSTRAINT uk_tenant_wb_snapshots_tenant_id UNIQUE (tenant_id, id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS tenant_cloud_file_categories (
      id VARCHAR(36) NOT NULL PRIMARY KEY DEFAULT (UUID()),
      tenant_id VARCHAR(36) NOT NULL,
      category_key VARCHAR(80) NOT NULL,
      label VARCHAR(150) NOT NULL,
      icon_type VARCHAR(40) NOT NULL DEFAULT 'folder',
      visibility VARCHAR(30) NOT NULL DEFAULT 'company',
      allowed_department_ids JSON NULL,
      allowed_role_ids JSON NULL,
      sort_order INT NOT NULL DEFAULT 0,
      created_by VARCHAR(36) NULL,
      created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
      updated_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
      CONSTRAINT uk_tenant_cloud_cats_tenant_id UNIQUE (tenant_id, id),
      CONSTRAINT uk_tenant_cloud_cat_key UNIQUE (tenant_id, category_key)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS tenant_edu_announcements (
      id VARCHAR(36) NOT NULL PRIMARY KEY DEFAULT (UUID()),
      tenant_id VARCHAR(36) NOT NULL,
      announcement_type VARCHAR(40) NOT NULL DEFAULT 'subject_announcement',
      course_id VARCHAR(36) NULL,
      class_id VARCHAR(36) NULL,
      subject_key VARCHAR(80) NULL,
      title VARCHAR(255) NOT NULL,
      content_html TEXT NOT NULL,
      channels_json JSON NULL,
      recipients_json JSON NULL,
      sent_count INT NOT NULL DEFAULT 0,
      status VARCHAR(30) NOT NULL DEFAULT 'sent',
      created_by VARCHAR(36) NULL,
      created_by_name VARCHAR(150) NULL,
      created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
      CONSTRAINT uk_tenant_edu_announcements_tenant_id UNIQUE (tenant_id, id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS tenant_ai_agent_configs (
      id VARCHAR(36) NOT NULL PRIMARY KEY DEFAULT (UUID()),
      tenant_id VARCHAR(36) NOT NULL,
      agent_name VARCHAR(120) NOT NULL DEFAULT 'DOM Agent',
      avatar_url TEXT NOT NULL,
      greeting_message TEXT NOT NULL,
      persona_tone VARCHAR(50) NOT NULL DEFAULT 'executive_concise',
      preferred_model VARCHAR(80) NOT NULL DEFAULT 'gemini-2.5-flash',
      temperature DECIMAL(4,2) NOT NULL DEFAULT 0.25,
      enable_morning_briefing TINYINT(1) NOT NULL DEFAULT 1,
      guardrail_rules JSON NOT NULL,
      updated_by VARCHAR(36) NULL,
      created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
      updated_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
      CONSTRAINT uk_tenant_ai_agent_configs_tenant_id UNIQUE (tenant_id, id),
      CONSTRAINT uk_tenant_ai_agent_configs_tenant_only UNIQUE (tenant_id),
      CONSTRAINT fk_ai_cfg_tenant FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS tenant_ai_knowledge_docs (
      id VARCHAR(36) NOT NULL PRIMARY KEY DEFAULT (UUID()),
      tenant_id VARCHAR(36) NOT NULL,
      title VARCHAR(255) NOT NULL,
      category VARCHAR(60) NOT NULL DEFAULT 'company_policy',
      source_type VARCHAR(30) NOT NULL DEFAULT 'manual',
      source_policy_id VARCHAR(36) NULL,
      file_name VARCHAR(255) NULL,
      content_text LONGTEXT NOT NULL,
      allowed_department_ids JSON NOT NULL,
      chunk_count INT NOT NULL DEFAULT 0,
      is_active TINYINT(1) NOT NULL DEFAULT 1,
      created_by VARCHAR(36) NULL,
      created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
      updated_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
      CONSTRAINT uk_tenant_ai_knowledge_docs_tenant_id UNIQUE (tenant_id, id),
      CONSTRAINT fk_ai_kdocs_tenant FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE,
      INDEX idx_ai_kdocs_tenant_active (tenant_id, is_active, updated_at DESC),
      INDEX idx_ai_kdocs_policy_sync (tenant_id, source_policy_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS tenant_ai_knowledge_chunks (
      id VARCHAR(36) NOT NULL PRIMARY KEY DEFAULT (UUID()),
      tenant_id VARCHAR(36) NOT NULL,
      doc_id VARCHAR(36) NOT NULL,
      chunk_index INT NOT NULL DEFAULT 0,
      chunk_text LONGTEXT NOT NULL,
      keywords_text TEXT NOT NULL,
      token_estimate INT NOT NULL DEFAULT 0,
      created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
      CONSTRAINT uk_tenant_ai_knowledge_chunks_tenant_id UNIQUE (tenant_id, id),
      CONSTRAINT uk_tenant_ai_knowledge_chunks_doc_idx UNIQUE (tenant_id, doc_id, chunk_index),
      CONSTRAINT fk_ai_kchunks_tenant FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE,
      CONSTRAINT fk_ai_kchunks_doc FOREIGN KEY (tenant_id, doc_id) REFERENCES tenant_ai_knowledge_docs(tenant_id, id) ON DELETE CASCADE,
      INDEX idx_ai_kchunks_tenant_doc (tenant_id, doc_id, chunk_index ASC)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS tenant_ai_threads (
      id VARCHAR(36) NOT NULL PRIMARY KEY DEFAULT (UUID()),
      tenant_id VARCHAR(36) NOT NULL,
      user_id VARCHAR(36) NOT NULL,
      specialist_key VARCHAR(50) NOT NULL DEFAULT 'orchestrator',
      title VARCHAR(255) NOT NULL DEFAULT 'Cuộc hội thoại mới',
      is_pinned TINYINT(1) NOT NULL DEFAULT 0,
      last_message_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
      created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
      updated_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
      CONSTRAINT uk_tenant_ai_threads_tenant_id UNIQUE (tenant_id, id),
      CONSTRAINT fk_ai_threads_tenant FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE,
      CONSTRAINT fk_ai_threads_user FOREIGN KEY (tenant_id, user_id) REFERENCES users(tenant_id, id) ON DELETE CASCADE,
      INDEX idx_ai_threads_tenant_user (tenant_id, user_id, is_pinned DESC, last_message_at DESC)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS tenant_ai_messages (
      id VARCHAR(36) NOT NULL PRIMARY KEY DEFAULT (UUID()),
      tenant_id VARCHAR(36) NOT NULL,
      thread_id VARCHAR(36) NOT NULL,
      role VARCHAR(20) NOT NULL,
      content LONGTEXT NOT NULL,
      tool_calls JSON NOT NULL,
      citations JSON NOT NULL,
      latency_ms INT NOT NULL DEFAULT 0,
      model_used VARCHAR(80) NULL,
      created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
      CONSTRAINT uk_tenant_ai_messages_tenant_id UNIQUE (tenant_id, id),
      CONSTRAINT fk_ai_messages_tenant FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE,
      CONSTRAINT fk_ai_messages_thread FOREIGN KEY (tenant_id, thread_id) REFERENCES tenant_ai_threads(tenant_id, id) ON DELETE CASCADE,
      INDEX idx_ai_messages_thread_created (tenant_id, thread_id, created_at ASC)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS tenant_ai_tool_audit_logs (
      id VARCHAR(36) NOT NULL PRIMARY KEY DEFAULT (UUID()),
      tenant_id VARCHAR(36) NOT NULL,
      user_id VARCHAR(36) NOT NULL,
      tool_name VARCHAR(100) NOT NULL,
      module_key VARCHAR(64) NOT NULL,
      required_action VARCHAR(40) NOT NULL,
      data_scope VARCHAR(30) NOT NULL DEFAULT 'none',
      allowed TINYINT(1) NOT NULL DEFAULT 0,
      denial_reason TEXT NULL,
      args_summary JSON NOT NULL,
      latency_ms INT NOT NULL DEFAULT 0,
      created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
      CONSTRAINT uk_tenant_ai_tool_audit_logs_tenant_id UNIQUE (tenant_id, id),
      CONSTRAINT fk_ai_tool_audit_tenant FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE,
      CONSTRAINT fk_ai_tool_audit_user FOREIGN KEY (tenant_id, user_id) REFERENCES users(tenant_id, id) ON DELETE CASCADE,
      INDEX idx_ai_tool_audit_tenant_created (tenant_id, created_at DESC),
      INDEX idx_ai_tool_audit_user_created (tenant_id, user_id, created_at DESC)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS tenant_attendance_policies (
      id VARCHAR(36) NOT NULL PRIMARY KEY DEFAULT (UUID()),
      tenant_id VARCHAR(36) NOT NULL,
      geofence_mode VARCHAR(30) NOT NULL DEFAULT 'flexible',
      require_gps TINYINT(1) NOT NULL DEFAULT 0,
      require_selfie TINYINT(1) NOT NULL DEFAULT 0,
      max_gps_accuracy_meters INT NOT NULL DEFAULT 150,
      grace_late_minutes INT NOT NULL DEFAULT 15,
      grace_early_minutes INT NOT NULL DEFAULT 15,
      allow_any_branch_checkin TINYINT(1) NOT NULL DEFAULT 0,
      allow_remote_with_approved_leave TINYINT(1) NOT NULL DEFAULT 1,
      allow_ip_whitelist_bypass TINYINT(1) NOT NULL DEFAULT 1,
      require_checkout TINYINT(1) NOT NULL DEFAULT 1,
      enable_night_shift TINYINT(1) NOT NULL DEFAULT 1,
      enable_weekend_shift TINYINT(1) NOT NULL DEFAULT 1,
      holiday_schedules_json JSON NOT NULL,
      created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
      updated_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
      CONSTRAINT uk_att_policy_tenant_id UNIQUE (tenant_id, id),
      CONSTRAINT uk_att_policy_unique_tenant UNIQUE (tenant_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS tenant_attendance_exemption_rules (
      id VARCHAR(36) NOT NULL PRIMARY KEY DEFAULT (UUID()),
      tenant_id VARCHAR(36) NOT NULL,
      name VARCHAR(160) NOT NULL,
      scope_type VARCHAR(30) NOT NULL DEFAULT 'user',
      target_id VARCHAR(64) NOT NULL,
      exempt_checkin TINYINT(1) NOT NULL DEFAULT 0,
      exempt_gps TINYINT(1) NOT NULL DEFAULT 0,
      exempt_selfie TINYINT(1) NOT NULL DEFAULT 0,
      custom_grace_late_minutes INT NULL,
      exclude_from_absent_report TINYINT(1) NOT NULL DEFAULT 0,
      effective_from VARCHAR(10) NULL,
      effective_to VARCHAR(10) NULL,
      reason TEXT NULL,
      is_active TINYINT(1) NOT NULL DEFAULT 1,
      created_by VARCHAR(36) NULL,
      created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
      updated_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
      CONSTRAINT uk_att_exemption_tenant_id UNIQUE (tenant_id, id),
      INDEX idx_att_exemption_tenant_scope (tenant_id, is_active, scope_type, target_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS tenant_attendance_confirmation_batches (
      id VARCHAR(36) NOT NULL PRIMARY KEY DEFAULT (UUID()),
      tenant_id VARCHAR(36) NOT NULL,
      title VARCHAR(200) NOT NULL,
      period_month VARCHAR(10) NOT NULL,
      from_date VARCHAR(10) NOT NULL,
      to_date VARCHAR(10) NOT NULL,
      deadline_at DATETIME(6) NULL,
      status VARCHAR(20) NOT NULL DEFAULT 'open',
      created_by VARCHAR(36) NULL,
      created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
      updated_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
      CONSTRAINT uk_att_conf_batch_tenant_id UNIQUE (tenant_id, id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS tenant_attendance_confirmations (
      id VARCHAR(36) NOT NULL PRIMARY KEY DEFAULT (UUID()),
      tenant_id VARCHAR(36) NOT NULL,
      batch_id VARCHAR(36) NOT NULL,
      user_id VARCHAR(36) NOT NULL,
      employee_id VARCHAR(36) NULL,
      total_work_units DECIMAL(8,2) NOT NULL DEFAULT 0,
      late_count INT NOT NULL DEFAULT 0,
      early_count INT NOT NULL DEFAULT 0,
      overtime_hours DECIMAL(8,2) NOT NULL DEFAULT 0,
      status VARCHAR(20) NOT NULL DEFAULT 'pending',
      dispute_reason TEXT NULL,
      confirmed_at DATETIME(6) NULL,
      confirmed_by_type VARCHAR(20) NULL,
      details_json JSON NOT NULL,
      created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
      updated_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
      CONSTRAINT uk_att_conf_tenant_id UNIQUE (tenant_id, id),
      CONSTRAINT uk_att_conf_batch_user UNIQUE (tenant_id, batch_id, user_id),
      INDEX idx_att_conf_batch_tenant (tenant_id, batch_id, status)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS tenant_attendance_bulk_requests (
      id VARCHAR(36) NOT NULL PRIMARY KEY DEFAULT (UUID()),
      tenant_id VARCHAR(36) NOT NULL,
      user_id VARCHAR(36) NOT NULL,
      employee_id VARCHAR(36) NULL,
      month_period VARCHAR(10) NOT NULL,
      status VARCHAR(30) NOT NULL DEFAULT 'pending_manager',
      approver_id VARCHAR(36) NULL,
      approved_by VARCHAR(36) NULL,
      approved_at DATETIME(6) NULL,
      admin_note TEXT NULL,
      details_json JSON NOT NULL,
      approval_request_id VARCHAR(36) NULL,
      created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
      updated_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
      CONSTRAINT uk_att_bulk_req_tenant_id UNIQUE (tenant_id, id),
      INDEX idx_att_bulk_req_tenant_user (tenant_id, user_id, month_period)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

ALTER TABLE tenant_branches ADD COLUMN IF NOT EXISTS branch_ip_whitelist JSON NULL;

ALTER TABLE tenant_hr_attendance_logs ADD COLUMN IF NOT EXISTS accuracy_meters DECIMAL(10,2) NULL;

ALTER TABLE tenant_hr_attendance_logs ADD COLUMN IF NOT EXISTS checkout_accuracy_meters DECIMAL(10,2) NULL;

ALTER TABLE tenant_hr_attendance_logs ADD COLUMN IF NOT EXISTS checkin_ip VARCHAR(64) NULL;

ALTER TABLE tenant_hr_attendance_logs ADD COLUMN IF NOT EXISTS checkout_ip VARCHAR(64) NULL;

ALTER TABLE tenant_hr_attendance_logs ADD COLUMN IF NOT EXISTS verification_method VARCHAR(40) NOT NULL DEFAULT 'standard';

ALTER TABLE tenant_hr_attendance_logs ADD COLUMN IF NOT EXISTS geofence_mode_applied VARCHAR(30) NOT NULL DEFAULT 'flexible';

ALTER TABLE tenant_hr_attendance_logs ADD COLUMN IF NOT EXISTS exemption_applied TINYINT(1) NOT NULL DEFAULT 0;

CREATE TABLE IF NOT EXISTS tenant_custom_fields (
      id VARCHAR(36) NOT NULL PRIMARY KEY DEFAULT (UUID()),
      tenant_id VARCHAR(36) NOT NULL,
      entity_type VARCHAR(40) NOT NULL DEFAULT 'lead',
      field_key VARCHAR(80) NOT NULL,
      field_label VARCHAR(160) NOT NULL,
      field_type VARCHAR(30) NOT NULL DEFAULT 'text',
      options_json JSON NOT NULL,
      is_required TINYINT(1) NOT NULL DEFAULT 0,
      is_filterable TINYINT(1) NOT NULL DEFAULT 1,
      show_in_table TINYINT(1) NOT NULL DEFAULT 1,
      default_value TEXT NULL,
      validation_regex TEXT NULL,
      placeholder VARCHAR(255) NULL,
      sort_order INT NOT NULL DEFAULT 0,
      is_active TINYINT(1) NOT NULL DEFAULT 1,
      created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
      updated_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
      CONSTRAINT uk_tenant_custom_fields_tenant_id UNIQUE (tenant_id, id),
      CONSTRAINT uk_tenant_custom_fields_key UNIQUE (tenant_id, entity_type, field_key),
      INDEX idx_custom_fields_tenant_entity (tenant_id, entity_type, sort_order)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS tenant_lead_scoring_rules (
      id VARCHAR(36) NOT NULL PRIMARY KEY DEFAULT (UUID()),
      tenant_id VARCHAR(36) NOT NULL,
      name VARCHAR(160) NOT NULL,
      description TEXT NULL,
      trigger_type VARCHAR(40) NOT NULL DEFAULT 'field_match',
      condition_json JSON NOT NULL,
      score_delta INT NOT NULL DEFAULT 10,
      max_applications INT NOT NULL DEFAULT 1,
      priority INT NOT NULL DEFAULT 100,
      is_active TINYINT(1) NOT NULL DEFAULT 1,
      created_by VARCHAR(36) NULL,
      created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
      updated_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
      CONSTRAINT uk_tenant_lead_scoring_rules_tenant_id UNIQUE (tenant_id, id),
      INDEX idx_lead_scoring_tenant_active (tenant_id, is_active, priority)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS tenant_notification_rules (
      id VARCHAR(36) NOT NULL PRIMARY KEY DEFAULT (UUID()),
      tenant_id VARCHAR(36) NOT NULL,
      event_key VARCHAR(80) NOT NULL,
      name VARCHAR(160) NOT NULL,
      description TEXT NULL,
      recipient_strategy VARCHAR(40) NOT NULL DEFAULT 'assigned_and_managers',
      target_roles_json JSON NOT NULL,
      target_departments_json JSON NOT NULL,
      target_user_ids_json JSON NOT NULL,
      include_owner TINYINT(1) NOT NULL DEFAULT 1,
      include_team_leader TINYINT(1) NOT NULL DEFAULT 0,
      cc_emails JSON NOT NULL,
      channels_json JSON NOT NULL,
      is_active TINYINT(1) NOT NULL DEFAULT 1,
      created_by VARCHAR(36) NULL,
      created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
      updated_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
      CONSTRAINT uk_tenant_notification_rules_tenant_id UNIQUE (tenant_id, id),
      INDEX idx_notification_rules_tenant_event (tenant_id, event_key, is_active)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS tenant_email_templates (
      id VARCHAR(36) NOT NULL PRIMARY KEY DEFAULT (UUID()),
      tenant_id VARCHAR(36) NOT NULL,
      template_key VARCHAR(100) NOT NULL,
      name VARCHAR(180) NOT NULL,
      category VARCHAR(40) NOT NULL DEFAULT 'notification',
      subject_template TEXT NOT NULL,
      body_html LONGTEXT NOT NULL,
      body_text LONGTEXT NULL,
      variables_json JSON NOT NULL,
      is_system TINYINT(1) NOT NULL DEFAULT 0,
      is_active TINYINT(1) NOT NULL DEFAULT 1,
      created_by VARCHAR(36) NULL,
      created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
      updated_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
      CONSTRAINT uk_tenant_email_templates_tenant_id UNIQUE (tenant_id, id),
      CONSTRAINT uk_tenant_email_templates_key UNIQUE (tenant_id, template_key),
      INDEX idx_email_templates_tenant_cat (tenant_id, category, is_active)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS tenant_entity_tabs (
      id VARCHAR(36) NOT NULL PRIMARY KEY DEFAULT (UUID()),
      tenant_id VARCHAR(36) NOT NULL,
      entity_type VARCHAR(40) NOT NULL DEFAULT 'lead',
      tab_key VARCHAR(80) NOT NULL,
      label VARCHAR(140) NOT NULL,
      icon_name VARCHAR(60) NOT NULL DEFAULT 'Layers',
      tab_type VARCHAR(30) NOT NULL DEFAULT 'fields',
      config_json JSON NOT NULL,
      allowed_role_ids JSON NOT NULL,
      sort_order INT NOT NULL DEFAULT 0,
      is_active TINYINT(1) NOT NULL DEFAULT 1,
      created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
      updated_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
      CONSTRAINT uk_tenant_entity_tabs_tenant_id UNIQUE (tenant_id, id),
      CONSTRAINT uk_tenant_entity_tabs_key UNIQUE (tenant_id, entity_type, tab_key),
      INDEX idx_entity_tabs_tenant_entity (tenant_id, entity_type, sort_order)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS tenant_cron_runs (
      id VARCHAR(36) NOT NULL PRIMARY KEY DEFAULT (UUID()),
      tenant_id VARCHAR(36) NOT NULL,
      subroutine_key VARCHAR(80) NOT NULL,
      status VARCHAR(20) NOT NULL DEFAULT 'success',
      items_processed INT NOT NULL DEFAULT 0,
      duration_ms INT NOT NULL DEFAULT 0,
      error_message TEXT NULL,
      details_json JSON NOT NULL,
      triggered_by VARCHAR(40) NOT NULL DEFAULT 'scheduler',
      started_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
      finished_at DATETIME(6) NULL,
      created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
      CONSTRAINT uk_tenant_cron_runs_tenant_id UNIQUE (tenant_id, id),
      INDEX idx_cron_runs_tenant_sub (tenant_id, subroutine_key, started_at)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS tenant_deal_stage_history (
      id VARCHAR(36) NOT NULL PRIMARY KEY DEFAULT (UUID()),
      tenant_id VARCHAR(36) NOT NULL,
      deal_id VARCHAR(36) NOT NULL,
      pipeline_id VARCHAR(36) NULL,
      from_stage VARCHAR(80) NULL,
      to_stage VARCHAR(80) NOT NULL,
      from_stage_id VARCHAR(36) NULL,
      to_stage_id VARCHAR(36) NULL,
      probability INT NOT NULL DEFAULT 30,
      amount_vnd BIGINT NOT NULL DEFAULT 0,
      duration_seconds INT NOT NULL DEFAULT 0,
      note TEXT NULL,
      changed_by VARCHAR(36) NULL,
      changed_by_name VARCHAR(150) NULL,
      metadata JSON NULL,
      created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
      CONSTRAINT uk_tenant_deal_stage_history_tenant_id UNIQUE (tenant_id, id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS tenant_entity_tabs (
      id VARCHAR(36) NOT NULL PRIMARY KEY DEFAULT (UUID()),
      tenant_id VARCHAR(36) NOT NULL,
      entity_type VARCHAR(40) NOT NULL DEFAULT 'contact',
      tab_key VARCHAR(64) NOT NULL,
      tab_label VARCHAR(150) NOT NULL,
      icon_name VARCHAR(50) NOT NULL DEFAULT 'Layers',
      sort_order INT NOT NULL DEFAULT 0,
      fields_json JSON NULL,
      allowed_roles JSON NULL,
      is_active TINYINT(1) NOT NULL DEFAULT 1,
      created_by VARCHAR(36) NULL,
      created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
      updated_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
      CONSTRAINT uk_tenant_entity_tabs_tenant_id UNIQUE (tenant_id, id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS tenant_custom_fields (
      id VARCHAR(36) NOT NULL PRIMARY KEY DEFAULT (UUID()),
      tenant_id VARCHAR(36) NOT NULL,
      entity_type VARCHAR(40) NOT NULL DEFAULT 'contact',
      field_key VARCHAR(64) NOT NULL,
      field_label VARCHAR(150) NOT NULL,
      field_type VARCHAR(30) NOT NULL DEFAULT 'text',
      is_required TINYINT(1) NOT NULL DEFAULT 0,
      options_json JSON NULL,
      sort_order INT NOT NULL DEFAULT 0,
      is_active TINYINT(1) NOT NULL DEFAULT 1,
      created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
      updated_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
      CONSTRAINT uk_tenant_custom_fields_tenant_id UNIQUE (tenant_id, id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS tenant_crm_activities (
      id VARCHAR(36) NOT NULL PRIMARY KEY DEFAULT (UUID()),
      tenant_id VARCHAR(36) NOT NULL,
      activity_type VARCHAR(40) NOT NULL DEFAULT 'note',
      subject VARCHAR(255) NOT NULL,
      body TEXT NULL,
      status VARCHAR(30) NOT NULL DEFAULT 'planned',
      priority VARCHAR(20) NOT NULL DEFAULT 'medium',
      due_date DATETIME(6) NULL,
      completed_at DATETIME(6) NULL,
      duration_minutes INT NOT NULL DEFAULT 15,
      lead_id VARCHAR(36) NULL,
      company_id VARCHAR(36) NULL,
      deal_id VARCHAR(36) NULL,
      task_id VARCHAR(36) NULL,
      owner_user_id VARCHAR(36) NULL,
      owner_name VARCHAR(150) NULL,
      mentions_json JSON NULL,
      edit_history_json JSON NULL,
      metadata JSON NULL,
      created_by VARCHAR(36) NULL,
      created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
      updated_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
      CONSTRAINT uk_tenant_crm_activities_tenant_id UNIQUE (tenant_id, id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS tenant_task_dependencies (
      id VARCHAR(36) NOT NULL PRIMARY KEY DEFAULT (UUID()),
      tenant_id VARCHAR(36) NOT NULL,
      task_id VARCHAR(36) NOT NULL,
      depends_on_task_id VARCHAR(36) NOT NULL,
      dependency_type VARCHAR(30) NOT NULL DEFAULT 'blocked_by',
      note TEXT NULL,
      created_by VARCHAR(36) NULL,
      created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
      CONSTRAINT uk_tenant_task_dependencies_tenant_id UNIQUE (tenant_id, id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS tenant_task_comments (
      id VARCHAR(36) NOT NULL PRIMARY KEY DEFAULT (UUID()),
      tenant_id VARCHAR(36) NOT NULL,
      task_id VARCHAR(36) NOT NULL,
      author_user_id VARCHAR(36) NULL,
      author_name VARCHAR(150) NOT NULL DEFAULT 'Thành viên',
      content TEXT NOT NULL,
      mentions_json JSON NULL,
      attachments_json JSON NULL,
      edit_history_json JSON NULL,
      created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
      updated_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
      CONSTRAINT uk_tenant_task_comments_tenant_id UNIQUE (tenant_id, id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS tenant_task_attachments (
      id VARCHAR(36) NOT NULL PRIMARY KEY DEFAULT (UUID()),
      tenant_id VARCHAR(36) NOT NULL,
      task_id VARCHAR(36) NOT NULL,
      file_name VARCHAR(255) NOT NULL,
      file_url TEXT NOT NULL,
      mime_type VARCHAR(120) NOT NULL DEFAULT 'application/octet-stream',
      size_bytes BIGINT NOT NULL DEFAULT 0,
      cloud_file_id VARCHAR(36) NULL,
      uploaded_by VARCHAR(36) NULL,
      uploaded_by_name VARCHAR(150) NULL,
      created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
      CONSTRAINT uk_tenant_task_attachments_tenant_id UNIQUE (tenant_id, id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS tenant_workspace_task_groups (
      id VARCHAR(36) NOT NULL PRIMARY KEY DEFAULT (UUID()),
      tenant_id VARCHAR(36) NOT NULL,
      user_id VARCHAR(36) NOT NULL,
      name VARCHAR(120) NOT NULL,
      color_hex VARCHAR(20) NOT NULL DEFAULT '#1E40FF',
      icon_name VARCHAR(50) NOT NULL DEFAULT 'Folder',
      sort_order INT NOT NULL DEFAULT 0,
      is_pinned TINYINT(1) NOT NULL DEFAULT 0,
      created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
      updated_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
      CONSTRAINT uk_tenant_ws_task_groups_tenant_id UNIQUE (tenant_id, id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS tenant_workspace_preferences (
      id VARCHAR(36) NOT NULL PRIMARY KEY DEFAULT (UUID()),
      tenant_id VARCHAR(36) NOT NULL,
      user_id VARCHAR(36) NOT NULL,
      wallpaper_url TEXT NULL,
      grid_columns INT NOT NULL DEFAULT 3,
      overlay_opacity INT NOT NULL DEFAULT 15,
      hide_completed TINYINT(1) NOT NULL DEFAULT 0,
      settings_json JSON NULL,
      updated_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
      CONSTRAINT uk_tenant_ws_prefs_user UNIQUE (tenant_id, user_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS tenant_contact_files (
      id VARCHAR(36) NOT NULL PRIMARY KEY DEFAULT (UUID()),
      tenant_id VARCHAR(36) NOT NULL,
      entity_type VARCHAR(30) NOT NULL DEFAULT 'contact',
      entity_id VARCHAR(36) NOT NULL,
      cloud_file_id VARCHAR(36) NULL,
      file_name VARCHAR(255) NOT NULL,
      file_url TEXT NOT NULL,
      mime_type VARCHAR(120) NOT NULL DEFAULT 'application/octet-stream',
      size_bytes BIGINT NOT NULL DEFAULT 0,
      category VARCHAR(80) NOT NULL DEFAULT 'general',
      uploaded_by VARCHAR(36) NULL,
      uploaded_by_name VARCHAR(150) NULL,
      created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
      CONSTRAINT uk_tenant_contact_files_tenant_id UNIQUE (tenant_id, id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS tenant_invoices (
      id VARCHAR(36) NOT NULL PRIMARY KEY DEFAULT (UUID()),
      tenant_id VARCHAR(36) NOT NULL,
      invoice_code VARCHAR(50) NOT NULL,
      sales_order_id VARCHAR(36) NULL,
      quote_id VARCHAR(36) NULL,
      lead_id VARCHAR(36) NULL,
      company_id VARCHAR(36) NULL,
      deal_id VARCHAR(36) NULL,
      customer_name VARCHAR(200) NOT NULL DEFAULT '',
      tax_code VARCHAR(50) NULL,
      status VARCHAR(30) NOT NULL DEFAULT 'issued',
      subtotal_vnd BIGINT NOT NULL DEFAULT 0,
      discount_vnd BIGINT NOT NULL DEFAULT 0,
      tax_vnd BIGINT NOT NULL DEFAULT 0,
      total_vnd BIGINT NOT NULL DEFAULT 0,
      paid_vnd BIGINT NOT NULL DEFAULT 0,
      due_date DATE NULL,
      issued_at DATETIME(6) NULL,
      items_json JSON NULL,
      notes TEXT NULL,
      created_by VARCHAR(36) NULL,
      created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
      updated_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
      CONSTRAINT uk_tenant_invoices_tenant_id UNIQUE (tenant_id, id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

ALTER TABLE tenant_cron_runs MODIFY COLUMN tenant_id VARCHAR(36) NULL;

-- =============================================================================

-- SECTION 12: FULL-CLONE STAGE 1-4 KERNEL ALTERATIONS & INFRA TABLES

-- =============================================================================

ALTER TABLE tenant_roles ADD COLUMN IF NOT EXISTS screen_access JSON NULL;

ALTER TABLE tenant_roles ADD COLUMN IF NOT EXISTS quick_actions JSON NULL;

ALTER TABLE tenant_roles ADD COLUMN IF NOT EXISTS default_route VARCHAR(120) NULL;

ALTER TABLE tenant_role_permissions ADD COLUMN IF NOT EXISTS screen_access JSON NULL;

ALTER TABLE tenant_role_permissions ADD COLUMN IF NOT EXISTS quick_actions JSON NULL;

ALTER TABLE tenant_role_permissions ADD COLUMN IF NOT EXISTS default_route VARCHAR(120) NULL;

ALTER TABLE tenant_branches ADD COLUMN IF NOT EXISTS branch_ip_whitelist JSON NULL;

ALTER TABLE tenant_branches ADD COLUMN IF NOT EXISTS manager_user_id VARCHAR(36) NULL;

CREATE TABLE IF NOT EXISTS tenant_domain_events_outbox (
  id VARCHAR(36) NOT NULL PRIMARY KEY DEFAULT (UUID()),
  tenant_id VARCHAR(36) NOT NULL,
  event_type VARCHAR(120) NOT NULL,
  aggregate_type VARCHAR(80) NOT NULL DEFAULT 'system',
  aggregate_id VARCHAR(120) NULL,
  payload_json JSON NULL,
  status VARCHAR(30) NOT NULL DEFAULT 'pending',
  retry_count INT NOT NULL DEFAULT 0,
  max_retries INT NOT NULL DEFAULT 5,
  next_retry_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  processed_at DATETIME(6) NULL,
  last_error TEXT NULL,
  created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  updated_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
  INDEX idx_outbox_pending (tenant_id, status, next_retry_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS tenant_user_notification_settings (
  id VARCHAR(36) NOT NULL PRIMARY KEY DEFAULT (UUID()),
  tenant_id VARCHAR(36) NOT NULL,
  user_id VARCHAR(36) NOT NULL,
  channels_json JSON NULL,
  events_json JSON NULL,
  quiet_hours_start VARCHAR(10) NULL,
  quiet_hours_end VARCHAR(10) NULL,
  mute_all TINYINT(1) NOT NULL DEFAULT 0,
  settings_json JSON NULL,
  created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  updated_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
  CONSTRAINT uk_user_notif_settings UNIQUE (tenant_id, user_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS crm_public_leads_pool (
  id VARCHAR(36) NOT NULL PRIMARY KEY DEFAULT (UUID()),
  tenant_id VARCHAR(36) NOT NULL,
  lead_id VARCHAR(36) NOT NULL,
  branch_id VARCHAR(36) NULL,
  released_by VARCHAR(36) NULL,
  release_reason TEXT NULL,
  pool_status VARCHAR(30) NOT NULL DEFAULT 'available',
  claimed_by VARCHAR(36) NULL,
  claimed_at DATETIME(6) NULL,
  expires_at DATETIME(6) NULL,
  metadata_json JSON NULL,
  created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  updated_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
  CONSTRAINT uk_public_pool_lead UNIQUE (tenant_id, lead_id),
  INDEX idx_public_pool_status (tenant_id, pool_status, created_at DESC)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS tenant_geoip_blocks (
  id VARCHAR(36) NOT NULL PRIMARY KEY DEFAULT (UUID()),
  tenant_id VARCHAR(36) NOT NULL,
  rule_type VARCHAR(30) NOT NULL DEFAULT 'country',
  target_value VARCHAR(120) NOT NULL,
  action_mode VARCHAR(30) NOT NULL DEFAULT 'block',
  reason TEXT NULL,
  is_active TINYINT(1) NOT NULL DEFAULT 1,
  hit_count INT NOT NULL DEFAULT 0,
  created_by VARCHAR(36) NULL,
  created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  updated_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
  INDEX idx_geoip_blocks_active (tenant_id, is_active, rule_type)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
