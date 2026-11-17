import { getDatabasePool, type DbClient } from '../../core/database/db-adapter.ts';
import { withSystemPrivilege } from '../../core/database/transaction.ts';

export const MARKETING_TABLES = [
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
  'mkt_ai_training_docs',
] as const;

const initializedPools = new WeakSet<object>();
const inFlightInitByPool = new WeakMap<object, Promise<void>>();

const POSTGRES_MARKETING_DDL = `
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
`;

const MARIADB_MARKETING_STATEMENTS: string[] = [
  `CREATE TABLE IF NOT EXISTS mkt_template_groups (
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
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
  `CREATE TABLE IF NOT EXISTS mkt_email_templates (
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
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
  `CREATE TABLE IF NOT EXISTS mkt_forms (
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
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
  `CREATE TABLE IF NOT EXISTS mkt_form_submissions (
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
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
  `CREATE TABLE IF NOT EXISTS mkt_custom_events (
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
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
  `CREATE TABLE IF NOT EXISTS mkt_otp_verifications (
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
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
  `CREATE TABLE IF NOT EXISTS mkt_surveys (
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
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
  `CREATE TABLE IF NOT EXISTS mkt_survey_responses (
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
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
  `CREATE TABLE IF NOT EXISTS mkt_campaigns (
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
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
  `CREATE TABLE IF NOT EXISTS mkt_send_claims (
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
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
  `CREATE TABLE IF NOT EXISTS mkt_suppression_list (
    id VARCHAR(36) NOT NULL PRIMARY KEY,
    tenant_id VARCHAR(36) NOT NULL,
    channel VARCHAR(20) NOT NULL DEFAULT 'email',
    recipient VARCHAR(255) NOT NULL,
    reason VARCHAR(50) NOT NULL DEFAULT 'unsubscribed',
    source_campaign_id VARCHAR(36) NULL,
    created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
    UNIQUE KEY uk_mkt_suppression_list_tenant_id (tenant_id, id),
    UNIQUE KEY uk_mkt_suppression_unique (tenant_id, channel, recipient)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
  `CREATE TABLE IF NOT EXISTS mkt_flows (
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
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
  `CREATE TABLE IF NOT EXISTS mkt_flow_snapshots (
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
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
  `CREATE TABLE IF NOT EXISTS mkt_flow_enrollments (
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
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
  `CREATE TABLE IF NOT EXISTS mkt_voucher_campaigns (
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
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
  `CREATE TABLE IF NOT EXISTS mkt_voucher_codes (
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
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
  `CREATE TABLE IF NOT EXISTS mkt_short_links (
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
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
  `CREATE TABLE IF NOT EXISTS mkt_short_link_clicks (
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
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
  `CREATE TABLE IF NOT EXISTS mkt_web_properties (
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
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
  `CREATE TABLE IF NOT EXISTS mkt_web_sessions (
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
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
  `CREATE TABLE IF NOT EXISTS mkt_web_events (
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
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
  `CREATE TABLE IF NOT EXISTS mkt_ai_bot_configs (
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
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
  `CREATE TABLE IF NOT EXISTS mkt_social_conversations (
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
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
  `CREATE TABLE IF NOT EXISTS mkt_social_messages (
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
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
  `CREATE TABLE IF NOT EXISTS mkt_campaign_reminders (
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
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
  `CREATE TABLE IF NOT EXISTS mkt_web_heatmaps (
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
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
  `CREATE TABLE IF NOT EXISTS mkt_zalo_oa_configs (
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
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
  `CREATE TABLE IF NOT EXISTS mkt_zalo_templates (
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
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
  `CREATE TABLE IF NOT EXISTS mkt_automation_scenarios (
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
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
  `CREATE TABLE IF NOT EXISTS mkt_template_acl (
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
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
  `CREATE TABLE IF NOT EXISTS mkt_media_assets (
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
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
  `CREATE TABLE IF NOT EXISTS mkt_ai_training_docs (
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
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
];

const MARIADB_MARKETING_ALTERS: string[] = [
  "ALTER TABLE mkt_email_templates ADD COLUMN IF NOT EXISTS saved_blocks_json JSON NULL",
  "ALTER TABLE mkt_email_templates ADD COLUMN IF NOT EXISTS thumbnail_url TEXT NULL",
  "ALTER TABLE mkt_campaigns ADD COLUMN IF NOT EXISTS fallback_vars_json JSON NULL",
  "ALTER TABLE mkt_campaigns ADD COLUMN IF NOT EXISTS throttle_per_minute INT NOT NULL DEFAULT 0",
  "ALTER TABLE mkt_campaigns ADD COLUMN IF NOT EXISTS ab_winner_criteria VARCHAR(40) NOT NULL DEFAULT 'open_rate'",
  "ALTER TABLE mkt_campaigns ADD COLUMN IF NOT EXISTS ab_test_hours INT NOT NULL DEFAULT 4",
  "ALTER TABLE mkt_campaigns ADD COLUMN IF NOT EXISTS pre_send_score INT NOT NULL DEFAULT 100",
  "ALTER TABLE mkt_flows ADD COLUMN IF NOT EXISTS settings_json JSON NULL",
  "ALTER TABLE mkt_custom_events ADD COLUMN IF NOT EXISTS webhook_secret VARCHAR(120) NULL",
  "ALTER TABLE mkt_surveys ADD COLUMN IF NOT EXISTS redirect_rules_json JSON NULL",
  "ALTER TABLE mkt_surveys ADD COLUMN IF NOT EXISTS thank_you_json JSON NULL",
  "ALTER TABLE mkt_web_sessions ADD COLUMN IF NOT EXISTS geo_country VARCHAR(60) NOT NULL DEFAULT 'VN'",
  "ALTER TABLE mkt_web_sessions ADD COLUMN IF NOT EXISTS geo_city VARCHAR(100) NULL",
  "ALTER TABLE mkt_web_sessions ADD COLUMN IF NOT EXISTS browser VARCHAR(60) NULL",
  "ALTER TABLE mkt_web_sessions ADD COLUMN IF NOT EXISTS os VARCHAR(60) NULL",
  "ALTER TABLE mkt_web_sessions ADD COLUMN IF NOT EXISTS duration_seconds INT NOT NULL DEFAULT 0",
  "ALTER TABLE mkt_campaign_reminders ADD COLUMN IF NOT EXISTS step_order INT NOT NULL DEFAULT 1",
  "ALTER TABLE mkt_campaign_reminders ADD COLUMN IF NOT EXISTS trigger_condition VARCHAR(40) NOT NULL DEFAULT 'no_open'",
  "ALTER TABLE mkt_campaign_reminders ADD COLUMN IF NOT EXISTS wait_hours INT NOT NULL DEFAULT 24",
  "ALTER TABLE mkt_campaign_reminders ADD COLUMN IF NOT EXISTS subject VARCHAR(255) NOT NULL DEFAULT ''",
  "ALTER TABLE mkt_campaign_reminders ADD COLUMN IF NOT EXISTS template_id VARCHAR(36) NULL",
  "ALTER TABLE mkt_campaign_reminders ADD COLUMN IF NOT EXISTS channel VARCHAR(20) NOT NULL DEFAULT 'email'",
  "ALTER TABLE mkt_campaign_reminders ADD COLUMN IF NOT EXISTS dispatched_count INT NOT NULL DEFAULT 0",
  "ALTER TABLE mkt_campaign_reminders ADD COLUMN IF NOT EXISTS is_active TINYINT(1) NOT NULL DEFAULT 1",
  "ALTER TABLE mkt_web_heatmaps ADD COLUMN IF NOT EXISTS page_url_pattern VARCHAR(500) NOT NULL DEFAULT '/'",
  "ALTER TABLE mkt_web_heatmaps ADD COLUMN IF NOT EXISTS device_filter VARCHAR(30) NOT NULL DEFAULT 'all'",
  "ALTER TABLE mkt_web_heatmaps ADD COLUMN IF NOT EXISTS snapshot_html MEDIUMTEXT NULL",
  "ALTER TABLE mkt_web_heatmaps ADD COLUMN IF NOT EXISTS viewport_width INT NOT NULL DEFAULT 1440",
  "ALTER TABLE mkt_web_heatmaps ADD COLUMN IF NOT EXISTS viewport_height INT NOT NULL DEFAULT 900",
  "ALTER TABLE mkt_web_heatmaps ADD COLUMN IF NOT EXISTS click_count INT NOT NULL DEFAULT 0",
  "ALTER TABLE mkt_web_heatmaps ADD COLUMN IF NOT EXISTS scroll_avg_pct INT NOT NULL DEFAULT 0",
  "ALTER TABLE mkt_web_heatmaps ADD COLUMN IF NOT EXISTS is_active TINYINT(1) NOT NULL DEFAULT 1",
  "ALTER TABLE mkt_web_heatmaps ADD COLUMN IF NOT EXISTS metadata_json JSON NULL",
  "ALTER TABLE mkt_zalo_oa_configs ADD COLUMN IF NOT EXISTS oa_id VARCHAR(100) NOT NULL DEFAULT ''",
  "ALTER TABLE mkt_zalo_oa_configs ADD COLUMN IF NOT EXISTS oa_name VARCHAR(200) NOT NULL DEFAULT 'Zalo Official Account'",
  "ALTER TABLE mkt_zalo_oa_configs ADD COLUMN IF NOT EXISTS app_id VARCHAR(100) NOT NULL DEFAULT ''",
  "ALTER TABLE mkt_zalo_oa_configs ADD COLUMN IF NOT EXISTS status VARCHAR(30) NOT NULL DEFAULT 'connected'",
  "ALTER TABLE mkt_zalo_oa_configs ADD COLUMN IF NOT EXISTS daily_quota INT NOT NULL DEFAULT 1000",
  "ALTER TABLE mkt_zalo_oa_configs ADD COLUMN IF NOT EXISTS sent_today INT NOT NULL DEFAULT 0",
  "ALTER TABLE mkt_zalo_oa_configs ADD COLUMN IF NOT EXISTS quality_rating VARCHAR(30) NOT NULL DEFAULT 'high'",
  "ALTER TABLE mkt_zalo_oa_configs ADD COLUMN IF NOT EXISTS webhook_secret VARCHAR(120) NULL",
  "ALTER TABLE mkt_zalo_oa_configs ADD COLUMN IF NOT EXISTS settings_json JSON NULL",
  "ALTER TABLE mkt_zalo_templates ADD COLUMN IF NOT EXISTS oa_id VARCHAR(100) NULL",
  "ALTER TABLE mkt_zalo_templates ADD COLUMN IF NOT EXISTS template_code VARCHAR(100) NOT NULL DEFAULT ''",
  "ALTER TABLE mkt_zalo_templates ADD COLUMN IF NOT EXISTS template_type VARCHAR(40) NOT NULL DEFAULT 'zns_transaction'",
  "ALTER TABLE mkt_zalo_templates ADD COLUMN IF NOT EXISTS status VARCHAR(30) NOT NULL DEFAULT 'approved'",
  "ALTER TABLE mkt_zalo_templates ADD COLUMN IF NOT EXISTS price_vnd INT NOT NULL DEFAULT 250",
  "ALTER TABLE mkt_zalo_templates ADD COLUMN IF NOT EXISTS content_body TEXT NULL",
  "ALTER TABLE mkt_zalo_templates ADD COLUMN IF NOT EXISTS params_schema_json JSON NULL",
  "ALTER TABLE mkt_zalo_templates ADD COLUMN IF NOT EXISTS buttons_json JSON NULL",
  "ALTER TABLE mkt_zalo_templates ADD COLUMN IF NOT EXISTS preview_url TEXT NULL",
  "ALTER TABLE mkt_zalo_templates ADD COLUMN IF NOT EXISTS sent_count INT NOT NULL DEFAULT 0",
  "ALTER TABLE mkt_zalo_templates ADD COLUMN IF NOT EXISTS delivered_count INT NOT NULL DEFAULT 0",
  "ALTER TABLE mkt_automation_scenarios ADD COLUMN IF NOT EXISTS channel VARCHAR(30) NOT NULL DEFAULT 'messenger'",
  "ALTER TABLE mkt_automation_scenarios ADD COLUMN IF NOT EXISTS trigger_type VARCHAR(50) NOT NULL DEFAULT 'keyword'",
  "ALTER TABLE mkt_automation_scenarios ADD COLUMN IF NOT EXISTS keywords_json JSON NULL",
  "ALTER TABLE mkt_automation_scenarios ADD COLUMN IF NOT EXISTS nodes_json JSON NULL",
  "ALTER TABLE mkt_automation_scenarios ADD COLUMN IF NOT EXISTS edges_json JSON NULL",
  "ALTER TABLE mkt_automation_scenarios ADD COLUMN IF NOT EXISTS settings_json JSON NULL",
  "ALTER TABLE mkt_automation_scenarios ADD COLUMN IF NOT EXISTS is_active TINYINT(1) NOT NULL DEFAULT 1",
  "ALTER TABLE mkt_automation_scenarios ADD COLUMN IF NOT EXISTS matched_count INT NOT NULL DEFAULT 0",
  "ALTER TABLE mkt_automation_scenarios ADD COLUMN IF NOT EXISTS converted_count INT NOT NULL DEFAULT 0",
];

async function runSchemaInitOnClient(client: DbClient, isMariaDb: boolean): Promise<void> {
  if (isMariaDb) {
    for (const stmt of MARIADB_MARKETING_STATEMENTS) {
      await client.query(stmt);
    }
    for (const alter of MARIADB_MARKETING_ALTERS) {
      try {
        await client.query(alter);
      } catch {
        // Column may already exist on non-IF-NOT-EXISTS engines
      }
    }
    return;
  }

  if (client.exec) {
    await client.exec(POSTGRES_MARKETING_DDL);
  } else {
    await client.query(POSTGRES_MARKETING_DDL);
  }
}

export async function ensureMarketingSchema(): Promise<void> {
  const pool = getDatabasePool() as unknown as object & { dialect?: string };
  if (initializedPools.has(pool)) {
    return;
  }

  const existingPromise = inFlightInitByPool.get(pool);
  if (existingPromise) {
    await existingPromise;
    return;
  }

  const initPromise = (async () => {
    try {
      await withSystemPrivilege(async (client) => {
        const isMariaDb = client.dialect === 'mariadb' || pool.dialect === 'mariadb';
        await runSchemaInitOnClient(client, isMariaDb);
      });
      initializedPools.add(pool);
    } finally {
      inFlightInitByPool.delete(pool);
    }
  })();

  inFlightInitByPool.set(pool, initPromise);
  await initPromise;
}
