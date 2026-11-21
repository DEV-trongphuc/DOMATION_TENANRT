import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getDatabasePool, type DatabasePool, type DbClient } from './db-adapter.ts';
import { APP_CONFIG } from '../../config.ts';
import { hashPassword } from '../crypto/password.ts';
import { generateObfuscatedSlug } from '../crypto/slug.ts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PG_SCHEMA_SQL_PATH = path.resolve(__dirname, '../../../docs/DATABASE_SCHEMA.sql');
const MARIADB_SCHEMA_SQL_PATH = path.resolve(__dirname, '../../../docs/DATABASE_SCHEMA_MARIADB.sql');

export async function runDatabaseMigrations(options?: { seedSuperAdmin?: boolean }): Promise<void> {
  const pool = getDatabasePool();
  const client = await pool.connect();

  let isMariaDb = false;
  try {
    isMariaDb = client.dialect === 'mariadb' || pool.dialect === 'mariadb';

    if (isMariaDb) {
      await runMariaDbMigrations(client, options);
    } else {
      await runPostgresMigrations(client, pool, options);
    }
  } finally {
    client.release();
  }

  // Idempotently consolidate Wave 2 & Full-Clone Stage 1-4 module schemas right at boot/migration
  const wave2SchemaLoaders: Array<[string, string]> = [
    ['../../modules/hrm/schema.ts', 'ensureHrmApprovalsSchema'],
    ['../../modules/marketing/schema.ts', 'ensureMarketingSchema'],
    ['../../modules/erp-ops/schema.ts', 'ensureErpOpsSchema'],
    ['../../modules/dom-agent/schema.ts', 'ensureDomAgentSchema'],
    ['../../modules/attendance/schema.ts', 'ensureAttendanceWaveASchema'],
    ['../../modules/org-rbac/schema.ts', 'ensureOrgRbacWaveASchema'],
    ['../../modules/crm-360/schema.ts', 'ensureCrm360Schema'],
    ['../../modules/dom-ai-portal/schema.ts', 'runDomAiPortalSchema'],
  ];
  for (const [modPath, fnName] of wave2SchemaLoaders) {
    try {
      const mod = await import(modPath);
      if (typeof mod?.[fnName] === 'function') {
        await mod[fnName]();
      }
    } catch {
      // Optional module schema unavailable in isolated schema tests
    }
  }

  const postClient = await pool.connect();
  try {
    if (isMariaDb) {
      await postClient
        .query('ALTER TABLE tenant_cron_runs MODIFY COLUMN tenant_id VARCHAR(36) NULL')
        .catch(() => {});
      await addMariaDbColumnIfNotExists(postClient, 'tenant_cron_runs', 'run_key', 'VARCHAR(120) NULL');
      await postClient
        .query('CREATE UNIQUE INDEX IF NOT EXISTS uk_cron_runs_tenant_sub_run_key ON tenant_cron_runs(tenant_id, subroutine_key, run_key)')
        .catch(() => {});
      await postClient
        .query('CREATE INDEX IF NOT EXISTS idx_cron_runs_tenant_sub_status ON tenant_cron_runs(tenant_id, subroutine_key, status, started_at DESC)')
        .catch(() => {});
      await postClient
        .query('CREATE INDEX IF NOT EXISTS idx_cron_runs_sub_started ON tenant_cron_runs(subroutine_key, started_at DESC)')
        .catch(() => {});
    } else {
      const postPgSql = `
        ALTER TABLE IF EXISTS tenant_cron_runs ALTER COLUMN tenant_id DROP NOT NULL;
        ALTER TABLE IF EXISTS tenant_cron_runs ADD COLUMN IF NOT EXISTS run_key VARCHAR(120);
        CREATE UNIQUE INDEX IF NOT EXISTS idx_cron_runs_tenant_sub_run_key
          ON tenant_cron_runs(tenant_id, subroutine_key, run_key)
          WHERE tenant_id IS NOT NULL AND run_key IS NOT NULL;
        CREATE INDEX IF NOT EXISTS idx_cron_runs_tenant_sub_status
          ON tenant_cron_runs(tenant_id, subroutine_key, status, started_at DESC);
        CREATE INDEX IF NOT EXISTS idx_cron_runs_sub_started
          ON tenant_cron_runs(subroutine_key, started_at DESC);
        DO $$
        DECLARE
          pol_rec RECORD;
        BEGIN
          FOR pol_rec IN
            SELECT schemaname, tablename, policyname
            FROM pg_policies
            WHERE schemaname = 'public'
              AND policyname LIKE 'tenant_isolation_%'
              AND qual IS NOT NULL
              AND qual NOT LIKE '%NULLIF%'
              AND qual LIKE '%current_setting%app.current_tenant_id%'
          LOOP
            EXECUTE format('DROP POLICY IF EXISTS %I ON %I.%I', pol_rec.policyname, pol_rec.schemaname, pol_rec.tablename);
            EXECUTE format(
              'CREATE POLICY %I ON %I.%I USING (tenant_id = NULLIF(current_setting(''app.current_tenant_id'', true), '''')::uuid) WITH CHECK (tenant_id = NULLIF(current_setting(''app.current_tenant_id'', true), '''')::uuid)',
              pol_rec.policyname, pol_rec.schemaname, pol_rec.tablename
            );
          END LOOP;
          IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'autodata_app') THEN
            GRANT USAGE ON SCHEMA public TO autodata_app;
            GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO autodata_app;
            GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO autodata_app;
          END IF;
        EXCEPTION
          WHEN insufficient_privilege THEN NULL;
        END $$;
      `;
      if (postClient.exec) {
        await postClient.exec(postPgSql).catch(() => {});
      } else {
        await postClient.query(postPgSql).catch(() => {});
      }
    }
  } finally {
    postClient.release();
  }
}

// Canonical alias for backward compatibility across test suites and server boots
export const runMigrations = runDatabaseMigrations;

/**
 * PostgreSQL 16 / Embedded PGlite Migration Routine
 */
async function runPostgresMigrations(
  client: DbClient,
  pool: DatabasePool,
  options?: { seedSuperAdmin?: boolean }
): Promise<void> {
  const checkRes = await client.query<{ exists: string | null }>(
    "SELECT to_regclass('public.tenants')::text AS exists"
  );

  if (!checkRes.rows[0]?.exists) {
    let ddl = fs.readFileSync(PG_SCHEMA_SQL_PATH, 'utf8');
    if (pool.isEmbedded) {
      // PostgreSQL 16 core includes gen_random_uuid() natively; PGlite contrib does not need pgcrypto.control
      ddl = ddl.replace(/CREATE\s+EXTENSION\s+IF\s+NOT\s+EXISTS\s+"pgcrypto"\s*;/gi, '-- pgcrypto native gen_random_uuid() used');
    }
    if (client.exec) {
      await client.exec(ddl);
    } else {
      await client.query(ddl);
    }
  }

  const ddlUpgradeSql = `
    -- 1. Global Accounts Table
    CREATE TABLE IF NOT EXISTS global_accounts (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      email VARCHAR(255) NOT NULL UNIQUE,
      password_hash VARCHAR(255) NOT NULL,
      full_name VARCHAR(150) NOT NULL,
      phone VARCHAR(30),
      avatar_url TEXT,
      is_active BOOLEAN NOT NULL DEFAULT true,
      last_login_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
    );
    ALTER TABLE global_accounts ADD COLUMN IF NOT EXISTS avatar_url TEXT;
    CREATE INDEX IF NOT EXISTS idx_global_accounts_email_lower ON global_accounts(LOWER(email));
    CREATE INDEX IF NOT EXISTS idx_global_accounts_phone ON global_accounts(phone) WHERE phone IS NOT NULL;

    -- 2. Tenants obfuscated_slug
    ALTER TABLE tenants ADD COLUMN IF NOT EXISTS obfuscated_slug VARCHAR(64) UNIQUE;
    CREATE UNIQUE INDEX IF NOT EXISTS idx_tenants_obfuscated_slug ON tenants(obfuscated_slug);

    -- 3. Users account_id reference
    ALTER TABLE users ADD COLUMN IF NOT EXISTS account_id UUID REFERENCES global_accounts(id) ON DELETE CASCADE;
    CREATE INDEX IF NOT EXISTS idx_users_account_id ON users(account_id);

    -- 4. Composite Indexes on leads
    CREATE INDEX IF NOT EXISTS idx_leads_tenant_phone_created ON leads(tenant_id, phone, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_leads_sla_sweep ON leads(tenant_id, is_accepted, sla_breached, stage_id);
    CREATE INDEX IF NOT EXISTS idx_leads_tenant_created_at ON leads(tenant_id, created_at DESC);

    -- 5. Platform settings & platform consultation hub
    CREATE TABLE IF NOT EXISTS platform_settings (
      setting_key VARCHAR(100) PRIMARY KEY,
      setting_value JSONB NOT NULL DEFAULT '{}'::jsonb,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
    );
    CREATE TABLE IF NOT EXISTS platform_consultations (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      lead_code VARCHAR(40) NOT NULL,
      source_form VARCHAR(150) NOT NULL DEFAULT 'domation.net',
      page_path VARCHAR(255),
      page_url TEXT,
      name VARCHAR(150),
      email VARCHAR(255),
      phone VARCHAR(40),
      company VARCHAR(255),
      service VARCHAR(255),
      budget_or_scale VARCHAR(255),
      message TEXT,
      utm_source VARCHAR(120),
      utm_medium VARCHAR(120),
      utm_campaign VARCHAR(120),
      metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
      appscript_status VARCHAR(40) NOT NULL DEFAULT 'pending',
      appscript_response JSONB NOT NULL DEFAULT '{}'::jsonb,
      client_ip VARCHAR(64),
      created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
    );
    CREATE INDEX IF NOT EXISTS idx_platform_consultations_created ON platform_consultations(created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_platform_consultations_email ON platform_consultations(LOWER(email)) WHERE email IS NOT NULL;
    -- Clean any dangling dependencies in pg_depend referencing non-existent relations
    DO $$
    BEGIN
      DELETE FROM pg_depend
      WHERE classid = 'pg_class'::regclass
        AND NOT EXISTS (SELECT 1 FROM pg_class c WHERE c.oid = pg_depend.objid);
      DELETE FROM pg_depend
      WHERE refclassid = 'pg_class'::regclass
        AND NOT EXISTS (SELECT 1 FROM pg_class c WHERE c.oid = pg_depend.refobjid);
    END $$;

    -- Guarded column alterations: only execute if column length is less than 100
    DO $$
    BEGIN
      IF EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'tenant_pipeline_stages'
          AND column_name = 'capi_event_mapping'
          AND character_maximum_length < 100
      ) THEN
        ALTER TABLE tenant_pipeline_stages
          DROP CONSTRAINT IF EXISTS tenant_pipeline_stages_capi_event_mapping_check;
        ALTER TABLE tenant_pipeline_stages
          ALTER COLUMN capi_event_mapping TYPE VARCHAR(100);
      END IF;

      IF EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'lead_timeline_events'
          AND column_name = 'event_type'
          AND character_maximum_length < 100
      ) THEN
        ALTER TABLE lead_timeline_events
          DROP CONSTRAINT IF EXISTS lead_timeline_events_event_type_check;
        DROP INDEX IF EXISTS idx_timeline_tenant_type_created;
        ALTER TABLE lead_timeline_events
          ALTER COLUMN event_type TYPE VARCHAR(100);
        CREATE INDEX IF NOT EXISTS idx_timeline_tenant_type_created
          ON lead_timeline_events(tenant_id, event_type, created_at DESC);
      END IF;
    END $$;
    ALTER TABLE tenant_pipeline_custom_fields
      DROP CONSTRAINT IF EXISTS tenant_pipeline_custom_fields_field_type_check;
    ALTER TABLE tenant_pipeline_custom_fields
      ADD CONSTRAINT tenant_pipeline_custom_fields_field_type_check
      CHECK (field_type IN ('text', 'textarea', 'number', 'currency', 'select', 'multiselect', 'date', 'boolean', 'phone', 'email', 'url'));
    ALTER TABLE tenant_pipeline_custom_fields
      ADD COLUMN IF NOT EXISTS config_json JSONB NOT NULL DEFAULT '{}'::jsonb;
    CREATE INDEX IF NOT EXISTS idx_users_tenant_email_lower ON users(tenant_id, LOWER(email));
    CREATE INDEX IF NOT EXISTS idx_users_email_lower ON users(LOWER(email));
    CREATE INDEX IF NOT EXISTS idx_user_profiles_tenant_zalo_uid ON tenant_user_profiles(tenant_id, zalo_user_id) WHERE zalo_user_id IS NOT NULL;
    CREATE INDEX IF NOT EXISTS idx_leads_tenant_pipeline_created ON leads(tenant_id, pipeline_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_leads_tenant_pipeline_stage ON leads(tenant_id, pipeline_id, stage_id);
    CREATE INDEX IF NOT EXISTS idx_timeline_tenant_type_created ON lead_timeline_events(tenant_id, event_type, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_capi_logs_tenant_status_sent ON capi_logs(tenant_id, response_status, sent_at DESC);
    CREATE INDEX IF NOT EXISTS idx_capi_logs_tenant_sent ON capi_logs(tenant_id, sent_at DESC);
    CREATE INDEX IF NOT EXISTS idx_leads_tenant_assigned_accepted ON leads(tenant_id, assigned_to, is_accepted);
    CREATE INDEX IF NOT EXISTS idx_leads_tenant_status_created ON leads(tenant_id, status, created_at ASC);
    CREATE INDEX IF NOT EXISTS idx_data_reports_tenant_created ON data_reports(tenant_id, created_at DESC);
    ALTER TABLE tenants ADD COLUMN IF NOT EXISTS trial_ends_at TIMESTAMPTZ DEFAULT (clock_timestamp() + INTERVAL '30 days');
    ALTER TABLE tenants ADD COLUMN IF NOT EXISTS subscription_expires_at TIMESTAMPTZ;
    ALTER TABLE tenants ADD COLUMN IF NOT EXISTS grace_ends_at TIMESTAMPTZ;
    ALTER TABLE tenants ADD COLUMN IF NOT EXISTS auto_renew BOOLEAN NOT NULL DEFAULT true;
    ALTER TABLE tenants ADD COLUMN IF NOT EXISTS cancel_at_period_end BOOLEAN NOT NULL DEFAULT false;
    ALTER TABLE tenants ADD COLUMN IF NOT EXISTS cancelled_at TIMESTAMPTZ;
    ALTER TABLE tenants ADD COLUMN IF NOT EXISTS scheduled_plan_code VARCHAR(80);
    ALTER TABLE tenants ADD COLUMN IF NOT EXISTS scheduled_billing_cycle VARCHAR(30);
    ALTER TABLE tenants ADD COLUMN IF NOT EXISTS subscription_plan_code VARCHAR(80) NOT NULL DEFAULT 'trial_1m';
    ALTER TABLE tenants ADD COLUMN IF NOT EXISTS billing_cycle VARCHAR(30) NOT NULL DEFAULT 'trial';
    ALTER TABLE tenants ADD COLUMN IF NOT EXISTS wallet_balance_vnd BIGINT NOT NULL DEFAULT 0;
    ALTER TABLE tenants ADD COLUMN IF NOT EXISTS crm_erp_upgrade_status VARCHAR(50) NOT NULL DEFAULT 'none';
    UPDATE tenants SET trial_ends_at = created_at + INTERVAL '30 days' WHERE trial_ends_at IS NULL;

    ALTER TABLE tenants DROP CONSTRAINT IF EXISTS tenants_status_check;
    ALTER TABLE tenants ADD CONSTRAINT tenants_status_check
      CHECK (status IN ('active', 'suspended', 'trial', 'grace', 'cancelled'));

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
    ALTER TABLE tenant_billing_transactions ADD COLUMN IF NOT EXISTS idempotency_key VARCHAR(120);
    ALTER TABLE tenant_billing_transactions ADD COLUMN IF NOT EXISTS provider VARCHAR(40) NOT NULL DEFAULT 'manual_bank_transfer';
    ALTER TABLE tenant_billing_transactions ADD COLUMN IF NOT EXISTS external_tx_id VARCHAR(160);
    ALTER TABLE tenant_billing_transactions ADD COLUMN IF NOT EXISTS proration_credit_vnd BIGINT NOT NULL DEFAULT 0;

    ALTER TABLE tenant_billing_transactions DROP CONSTRAINT IF EXISTS tenant_billing_transactions_tx_type_check;
    ALTER TABLE tenant_billing_transactions ADD CONSTRAINT tenant_billing_transactions_tx_type_check
      CHECK (tx_type IN ('topup', 'subscription_purchase', 'renewal', 'plan_upgrade', 'plan_downgrade', 'plan_switch', 'package_switch', 'refund', 'cancellation', 'proration_credit', 'reactivation', 'webhook_payment', 'crm_erp_upgrade', 'admin_grant'));

    ALTER TABLE tenant_billing_transactions DROP CONSTRAINT IF EXISTS tenant_billing_transactions_status_check;
    ALTER TABLE tenant_billing_transactions ADD CONSTRAINT tenant_billing_transactions_status_check
      CHECK (status IN ('pending', 'approved', 'rejected', 'completed', 'failed', 'cancelled', 'refunded', 'expired'));

    WITH dup_refs AS (
      SELECT id, reference_code,
             ROW_NUMBER() OVER (PARTITION BY reference_code ORDER BY created_at ASC, id ASC) AS rn
      FROM tenant_billing_transactions
      WHERE reference_code IS NOT NULL
    )
    UPDATE tenant_billing_transactions t
    SET reference_code = LEFT(t.reference_code, 68) || '-' || LEFT(t.id::text, 8)
    FROM dup_refs d
    WHERE t.id = d.id AND d.rn > 1;

    CREATE INDEX IF NOT EXISTS idx_billing_tx_tenant_created ON tenant_billing_transactions(tenant_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_billing_tx_status_created ON tenant_billing_transactions(status, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_billing_tx_tenant_status_created ON tenant_billing_transactions(tenant_id, status, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_billing_tx_tenant_type_created ON tenant_billing_transactions(tenant_id, tx_type, created_at DESC);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_billing_tx_tenant_idempotency ON tenant_billing_transactions(tenant_id, idempotency_key) WHERE idempotency_key IS NOT NULL;
    CREATE UNIQUE INDEX IF NOT EXISTS idx_billing_tx_provider_ext ON tenant_billing_transactions(provider, external_tx_id) WHERE provider IS NOT NULL AND external_tx_id IS NOT NULL;
    CREATE UNIQUE INDEX IF NOT EXISTS idx_billing_tx_reference_code ON tenant_billing_transactions(reference_code) WHERE reference_code IS NOT NULL;
    ALTER TABLE tenant_billing_transactions ENABLE ROW LEVEL SECURITY;
    ALTER TABLE tenant_billing_transactions FORCE ROW LEVEL SECURITY;
    DO $$
    BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'tenant_billing_transactions' AND policyname = 'tenant_isolation_billing_tx'
      ) THEN
        CREATE POLICY tenant_isolation_billing_tx ON tenant_billing_transactions
          USING (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid)
          WITH CHECK (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid);
      END IF;
    END $$;

    -- Phase 2 Normalized Operational Columns & 9 Extension Tables
    ALTER TABLE tenant_onboarding_progress ADD COLUMN IF NOT EXISTS screen_tours JSONB NOT NULL DEFAULT '{}'::jsonb;
    ALTER TABLE tenant_user_profiles ADD COLUMN IF NOT EXISTS is_silent BOOLEAN NOT NULL DEFAULT false;
    ALTER TABLE tenant_user_profiles ADD COLUMN IF NOT EXISTS invite_status VARCHAR(30) NOT NULL DEFAULT 'joined';
    ALTER TABLE tenant_user_profiles ADD COLUMN IF NOT EXISTS sheet_sync_url TEXT;
    ALTER TABLE tenant_user_profiles ADD COLUMN IF NOT EXISTS sheet_tab_name VARCHAR(150);
    ALTER TABLE tenant_user_profiles ADD COLUMN IF NOT EXISTS skip_count INTEGER NOT NULL DEFAULT 0;
    ALTER TABLE tenant_user_profiles ADD COLUMN IF NOT EXISTS current_turn_remaining INTEGER NOT NULL DEFAULT 0;
    ALTER TABLE tenant_user_profiles ADD COLUMN IF NOT EXISTS hourly_leads_count INTEGER NOT NULL DEFAULT 0;
    ALTER TABLE tenant_user_profiles ADD COLUMN IF NOT EXISTS hourly_window_start TIMESTAMPTZ;

    ALTER TABLE distribution_rounds ADD COLUMN IF NOT EXISTS description TEXT;
    ALTER TABLE distribution_rounds ADD COLUMN IF NOT EXISTS cc_emails TEXT;
    ALTER TABLE distribution_rounds ADD COLUMN IF NOT EXISTS last_assigned_consultant_id UUID;

    ALTER TABLE round_consultants ADD COLUMN IF NOT EXISTS is_active BOOLEAN NOT NULL DEFAULT true;
    ALTER TABLE round_consultants ADD COLUMN IF NOT EXISTS current_turn_remaining INTEGER NOT NULL DEFAULT 0;
    ALTER TABLE round_consultants ADD COLUMN IF NOT EXISTS skip_count INTEGER NOT NULL DEFAULT 0;
    ALTER TABLE round_consultants ADD COLUMN IF NOT EXISTS skipped_credit INTEGER NOT NULL DEFAULT 0;

    ALTER TABLE routing_rules ADD COLUMN IF NOT EXISTS condition_branches JSONB NOT NULL DEFAULT '[]'::jsonb;
    ALTER TABLE routing_rules ADD COLUMN IF NOT EXISTS connection_scopes JSONB NOT NULL DEFAULT '["all"]'::jsonb;
    ALTER TABLE routing_rules ADD COLUMN IF NOT EXISTS inject_fields JSONB NOT NULL DEFAULT '{}'::jsonb;

    ALTER TABLE leads ADD COLUMN IF NOT EXISTS round_id UUID;
    ALTER TABLE leads ADD COLUMN IF NOT EXISTS connection_id UUID;
    ALTER TABLE leads ADD COLUMN IF NOT EXISTS product_interest VARCHAR(255);
    ALTER TABLE leads ADD COLUMN IF NOT EXISTS budget_range VARCHAR(120);
    ALTER TABLE leads ADD COLUMN IF NOT EXISTS utm_source VARCHAR(100);
    ALTER TABLE leads ADD COLUMN IF NOT EXISTS ad_id VARCHAR(100);
    ALTER TABLE leads ADD COLUMN IF NOT EXISTS adset_id VARCHAR(100);
    ALTER TABLE leads ADD COLUMN IF NOT EXISTS campaign_id VARCHAR(100);
    ALTER TABLE leads ADD COLUMN IF NOT EXISTS form_id VARCHAR(100);
    ALTER TABLE leads ADD COLUMN IF NOT EXISTS is_duplicated BOOLEAN NOT NULL DEFAULT false;
    ALTER TABLE leads ADD COLUMN IF NOT EXISTS duplicate_of_lead_id UUID;
    ALTER TABLE leads ADD COLUMN IF NOT EXISTS batch_id UUID;
    ALTER TABLE leads ADD COLUMN IF NOT EXISTS is_deleted BOOLEAN NOT NULL DEFAULT false;
    ALTER TABLE leads ADD COLUMN IF NOT EXISTS ai_screener_status VARCHAR(40) NOT NULL DEFAULT 'not_screened';
    ALTER TABLE leads ADD COLUMN IF NOT EXISTS ai_evaluation TEXT;
    ALTER TABLE leads ADD COLUMN IF NOT EXISTS ai_prompt_tokens INTEGER NOT NULL DEFAULT 0;
    ALTER TABLE leads ADD COLUMN IF NOT EXISTS ai_completion_tokens INTEGER NOT NULL DEFAULT 0;
    ALTER TABLE leads ADD COLUMN IF NOT EXISTS zalo_notify_status VARCHAR(40) NOT NULL DEFAULT 'none';
    ALTER TABLE leads ADD COLUMN IF NOT EXISTS email_notify_status VARCHAR(40) NOT NULL DEFAULT 'none';

    ALTER TABLE leads DROP CONSTRAINT IF EXISTS leads_status_check;
    ALTER TABLE leads ADD CONSTRAINT leads_status_check
      CHECK (status IN ('marketing_nurture', 'unassigned_pending', 'assigned', 'recalled', 'archived', 'pending_approval', 'rejected', 'blacklisted'));

    ALTER TABLE tenant_integrations DROP CONSTRAINT IF EXISTS tenant_integrations_integration_type_check;
    ALTER TABLE tenant_integrations ADD CONSTRAINT tenant_integrations_integration_type_check
      CHECK (integration_type IN ('telegram', 'telegram_bot', 'zalo_bot', 'zalo_oa', 'zalo_zns', 'meta_capi', 'meta_messenger', 'facebook_ads', 'google_ads', 'dom_meta_report', 'aws_ses', 'smtp', 'resend', 'sendgrid', 'postmark', 'custom_domain_dkim', 'sms_brandname', 'google_sheets', 'misa_einvoice', 'ai_gemini', 'ai_gemini_byok'));

    CREATE INDEX IF NOT EXISTS idx_leads_tenant_active_created ON leads(tenant_id, created_at DESC) WHERE is_deleted = false;
    CREATE INDEX IF NOT EXISTS idx_leads_tenant_assigned_status_created ON leads(tenant_id, assigned_to, status, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_leads_tenant_round_created ON leads(tenant_id, round_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_leads_tenant_campaign_ad ON leads(tenant_id, campaign_id, ad_id);
    CREATE INDEX IF NOT EXISTS idx_leads_tenant_adset_created ON leads(tenant_id, adset_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_leads_tenant_phone ON leads(tenant_id, phone) WHERE phone IS NOT NULL;
    CREATE INDEX IF NOT EXISTS idx_leads_tenant_updated ON leads(tenant_id, updated_at DESC);

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
      ad_account_id VARCHAR(100),
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

    -- Milestone 1 Optimization: 10 Composite & Partial Indexes
    CREATE INDEX IF NOT EXISTS idx_leads_tenant_quality_created ON leads(tenant_id, quality_status, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_leads_tenant_assigned_active_created ON leads(tenant_id, assigned_to, created_at DESC) WHERE is_deleted = false;
    CREATE INDEX IF NOT EXISTS idx_leads_tenant_active_unarchived_created ON leads(tenant_id, created_at DESC) WHERE is_deleted = false AND status != 'archived';
    CREATE INDEX IF NOT EXISTS idx_leads_sla_master_sweep ON leads(status, is_accepted, sla_breached, created_at ASC) WHERE is_deleted = false AND status = 'assigned';
    CREATE INDEX IF NOT EXISTS idx_leads_drainer_unassigned ON leads(status, assigned_to) WHERE is_deleted = false AND status IN ('unassigned_pending', 'recalled');
    CREATE INDEX IF NOT EXISTS idx_webhook_dlq_retry_sweep ON tenant_webhook_dlq(retry_count, last_attempt_at ASC) WHERE retry_count < 10;
    CREATE INDEX IF NOT EXISTS idx_capi_retry_sweep ON capi_logs(response_status, sent_at ASC) WHERE response_status IN (429, 500, 502, 503, 504);
    ALTER TABLE capi_logs ADD COLUMN IF NOT EXISTS retry_count INTEGER NOT NULL DEFAULT 0;
    ALTER TABLE capi_logs ADD COLUMN IF NOT EXISTS next_retry_at TIMESTAMPTZ;
    CREATE INDEX IF NOT EXISTS idx_capi_logs_lead_event_status ON capi_logs(tenant_id, lead_id, event_name, response_status);
    CREATE INDEX IF NOT EXISTS idx_capi_logs_retry_next ON capi_logs(response_status, next_retry_at, sent_at ASC) WHERE response_status IN (429, 500, 502, 503, 504);
    CREATE INDEX IF NOT EXISTS idx_leads_tenant_ad_id ON leads(tenant_id, ad_id) WHERE is_deleted = false AND ad_id IS NOT NULL;
    CREATE INDEX IF NOT EXISTS idx_leads_tenant_adset_id ON leads(tenant_id, adset_id) WHERE is_deleted = false AND adset_id IS NOT NULL;
    CREATE INDEX IF NOT EXISTS idx_data_reports_tenant_lead_created ON data_reports(tenant_id, lead_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_meta_ads_tenant_ad_stop ON meta_ads_insights(tenant_id, ad_id, date_stop DESC);
    DROP INDEX IF EXISTS idx_tenants_subscription_expiry;
    CREATE INDEX IF NOT EXISTS idx_tenants_subscription_expiry ON tenants(status, subscription_expires_at, trial_ends_at, grace_ends_at) WHERE status IN ('active', 'trial', 'grace');
    CREATE INDEX IF NOT EXISTS idx_audit_logs_actor_created ON admin_audit_logs(tenant_id, actor_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_comp_logs_consultant ON active_compensation_logs(tenant_id, consultant_user_id, created_at DESC);

    ALTER TABLE meta_ads_insights ADD COLUMN IF NOT EXISTS ad_account_id VARCHAR(100);
    CREATE INDEX IF NOT EXISTS idx_meta_ads_tenant_account ON meta_ads_insights(tenant_id, ad_account_id);

    DO $$
    DECLARE
      tbl TEXT;
      pol TEXT;
    BEGIN
      FOREACH tbl IN ARRAY ARRAY[
        'consultant_managers', 'personal_leads', 'ai_screener_configs', 'held_leads',
        'blacklist_entries', 'meta_ads_insights', 'lead_import_batches',
        'admin_audit_logs', 'active_compensation_logs'
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

    -- ========================================================================
    -- Wave 1 Multi-Product SaaS Ecosystem Additive Migration (Idempotent)
    -- ========================================================================
    ALTER TABLE tenants ADD COLUMN IF NOT EXISTS industry_key VARCHAR(64) NOT NULL DEFAULT 'general';
    ALTER TABLE tenants ADD COLUMN IF NOT EXISTS package_code VARCHAR(50) NOT NULL DEFAULT 'autodata_crm';
    ALTER TABLE tenants ADD COLUMN IF NOT EXISTS enabled_modules JSONB NOT NULL DEFAULT '["leads","org_rbac","settings","billing","dashboard_crm","crm_dashboard","pipelines","rounds","fair_share","consultants","routing_rules","gatekeeper","tickets_data","ads_capi","sale_portal","appointments","integrations_crm","integrations_autodata","dom_sales_copilot"]'::jsonb;
    ALTER TABLE tenants ADD COLUMN IF NOT EXISTS entitlements JSONB NOT NULL DEFAULT '{"package_code":"autodata_crm","education_addon":false,"enable_ideas_mascot":false}'::jsonb;

    ALTER TABLE tenants DROP CONSTRAINT IF EXISTS tenants_plan_tier_check;
    ALTER TABLE tenants ADD CONSTRAINT tenants_plan_tier_check
      CHECK (plan_tier IN ('starter', 'growth', 'enterprise', 'autodata_standard', 'autodata_growth', 'domation_crm_erp', 'autodata_crm', 'marketing_standalone', 'growth_combo', 'domation_promax'));

    ALTER TABLE users DROP CONSTRAINT IF EXISTS users_role_check;
    ALTER TABLE users ADD CONSTRAINT users_role_check CHECK (char_length(trim(role)) >= 1);
    ALTER TABLE users ADD COLUMN IF NOT EXISTS role_id UUID;
    ALTER TABLE users ADD COLUMN IF NOT EXISTS branch_id UUID;
    ALTER TABLE users ADD COLUMN IF NOT EXISTS department_id UUID;
    ALTER TABLE users ADD COLUMN IF NOT EXISTS team_id UUID;
    ALTER TABLE users ADD COLUMN IF NOT EXISTS position_id UUID;
    ALTER TABLE users ADD COLUMN IF NOT EXISTS reports_to_user_id UUID;
    ALTER TABLE users ADD COLUMN IF NOT EXISTS is_tenant_owner BOOLEAN NOT NULL DEFAULT false;
    ALTER TABLE users ADD COLUMN IF NOT EXISTS is_system_bot BOOLEAN NOT NULL DEFAULT false;

    ALTER TABLE tenant_pipeline_stages ADD COLUMN IF NOT EXISTS funnel_category VARCHAR(40) NOT NULL DEFAULT 'engaged_qualified';
    ALTER TABLE tenant_pipeline_stages ADD COLUMN IF NOT EXISTS score_delta INTEGER NOT NULL DEFAULT 0;
    ALTER TABLE tenant_pipeline_stages ADD COLUMN IF NOT EXISTS required_fields JSONB NOT NULL DEFAULT '[]'::jsonb;

    -- Upgrade leads into Master Contact 360° (allow NULL pipeline_id, stage_id, phone when email present)
    ALTER TABLE leads ALTER COLUMN pipeline_id DROP NOT NULL;
    ALTER TABLE leads ALTER COLUMN stage_id DROP NOT NULL;
    ALTER TABLE leads ALTER COLUMN phone DROP NOT NULL;
    ALTER TABLE leads ADD COLUMN IF NOT EXISTS lifecycle_stage VARCHAR(40) NOT NULL DEFAULT 'lead';
    ALTER TABLE leads ADD COLUMN IF NOT EXISTS lead_score INTEGER NOT NULL DEFAULT 0;
    ALTER TABLE leads ADD COLUMN IF NOT EXISTS email_consent VARCHAR(30) NOT NULL DEFAULT 'subscribed';
    ALTER TABLE leads ADD COLUMN IF NOT EXISTS zns_consent VARCHAR(30) NOT NULL DEFAULT 'opted_in';
    ALTER TABLE leads ADD COLUMN IF NOT EXISTS total_revenue_vnd BIGINT NOT NULL DEFAULT 0;
    ALTER TABLE leads ADD COLUMN IF NOT EXISTS last_engaged_at TIMESTAMPTZ;
    ALTER TABLE leads DROP CONSTRAINT IF EXISTS chk_leads_phone_or_email;
    ALTER TABLE leads ADD CONSTRAINT chk_leads_phone_or_email
      CHECK ((phone IS NOT NULL AND char_length(trim(phone)) > 0) OR (email IS NOT NULL AND char_length(trim(email)) > 0));

    CREATE INDEX IF NOT EXISTS idx_leads_tenant_email_lower ON leads(tenant_id, LOWER(email)) WHERE email IS NOT NULL;
    CREATE INDEX IF NOT EXISTS idx_leads_tenant_lifecycle ON leads(tenant_id, lifecycle_stage);
    CREATE INDEX IF NOT EXISTS idx_leads_tenant_score ON leads(tenant_id, lead_score DESC);
    CREATE INDEX IF NOT EXISTS idx_leads_tenant_revenue ON leads(tenant_id, total_revenue_vnd DESC);
    CREATE INDEX IF NOT EXISTS idx_users_tenant_dept ON users(tenant_id, department_id);
    CREATE INDEX IF NOT EXISTS idx_users_tenant_branch ON users(tenant_id, branch_id);
    CREATE INDEX IF NOT EXISTS idx_users_tenant_team ON users(tenant_id, team_id);
    CREATE INDEX IF NOT EXISTS idx_users_tenant_role_id ON users(tenant_id, role_id);

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
  `;

  // Ensure non-superuser NOBYPASSRLS role `autodata_app` exists and holds DML privileges
  const roleSql = `
    DO $$
    BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'autodata_app') THEN
        CREATE ROLE autodata_app NOLOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE;
      END IF;
      EXECUTE format('GRANT autodata_app TO %I', current_user);
    EXCEPTION
      WHEN insufficient_privilege THEN
        RAISE NOTICE 'Non-superuser connection detected; using current session role for FORCE RLS.';
    END $$;
    DO $$
    BEGIN
      IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'autodata_app') THEN
        GRANT USAGE ON SCHEMA public TO autodata_app;
        GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO autodata_app;
        GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO autodata_app;
      END IF;
    EXCEPTION
      WHEN insufficient_privilege THEN
        NULL;
    END $$;
  `;

  if (client.exec) {
    await client.exec(ddlUpgradeSql);
    await client.exec(roleSql);
  } else {
    await client.query(ddlUpgradeSql);
    await client.query(roleSql);
  }

  // Backfill existing users and tenant slugs
  await backfillUsersToGlobalAccounts(client);
  await backfillTenantObfuscatedSlugs(client);
  await backfillWave1TenantOwnersAndPackages(client);

  if (options?.seedSuperAdmin !== false) {
    await seedSuperAdmin(client);
  }
}

/**
 * MariaDB 10.6 Migration Routine (AZDIGI vhvxoigh_data)
 */
async function runMariaDbMigrations(client: DbClient, options?: { seedSuperAdmin?: boolean }): Promise<void> {
  const checkRes = await client.query<{ exists_flag: number }>(
    `SELECT COUNT(*) AS exists_flag
     FROM information_schema.tables
     WHERE table_schema = DATABASE() AND table_name = 'tenants'`
  );

  if (Number(checkRes.rows[0]?.exists_flag || 0) === 0) {
    const ddl = fs.readFileSync(MARIADB_SCHEMA_SQL_PATH, 'utf8');
    if (client.exec) {
      await client.exec(ddl);
    } else {
      await client.query(ddl);
    }
  }

  // Ensure global_accounts exists
  await client.query(`
    CREATE TABLE IF NOT EXISTS global_accounts (
      id VARCHAR(36) NOT NULL PRIMARY KEY DEFAULT (UUID()),
      email VARCHAR(255) NOT NULL UNIQUE,
      password_hash VARCHAR(255) NOT NULL,
      full_name VARCHAR(150) NOT NULL,
      phone VARCHAR(30) NULL,
      avatar_url TEXT NULL,
      is_active TINYINT(1) NOT NULL DEFAULT 1,
      last_login_at DATETIME(6) NULL,
      created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
      updated_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
      INDEX idx_global_accounts_email (email),
      INDEX idx_global_accounts_phone (phone)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
  `);
  await addMariaDbColumnIfNotExists(client, 'global_accounts', 'avatar_url', 'TEXT NULL');

  // Safe column additions for existing MariaDB schemas
  await addMariaDbColumnIfNotExists(client, 'tenants', 'obfuscated_slug', 'VARCHAR(64) NULL UNIQUE');
  await addMariaDbColumnIfNotExists(client, 'tenants', 'grace_ends_at', 'DATETIME(6) NULL');
  await addMariaDbColumnIfNotExists(client, 'tenants', 'auto_renew', 'TINYINT(1) NOT NULL DEFAULT 1');
  await addMariaDbColumnIfNotExists(client, 'tenants', 'cancel_at_period_end', 'TINYINT(1) NOT NULL DEFAULT 0');
  await addMariaDbColumnIfNotExists(client, 'tenants', 'cancelled_at', 'DATETIME(6) NULL');
  await addMariaDbColumnIfNotExists(client, 'tenants', 'scheduled_plan_code', 'VARCHAR(80) NULL');
  await addMariaDbColumnIfNotExists(client, 'tenants', 'scheduled_billing_cycle', 'VARCHAR(30) NULL');
  await client.query('CREATE INDEX IF NOT EXISTS idx_tenants_subscription_expiry ON tenants(status, subscription_expires_at, trial_ends_at, grace_ends_at)').catch(() => {});
  await addMariaDbColumnIfNotExists(client, 'users', 'account_id', 'VARCHAR(36) NULL');
  await addMariaDbColumnIfNotExists(client, 'tenant_onboarding_progress', 'screen_tours', 'JSON NOT NULL DEFAULT (JSON_OBJECT())');
  await addMariaDbColumnIfNotExists(client, 'tenant_user_profiles', 'is_silent', 'TINYINT(1) NOT NULL DEFAULT 0');
  await addMariaDbColumnIfNotExists(client, 'tenant_user_profiles', 'invite_status', "VARCHAR(30) NOT NULL DEFAULT 'joined'");
  await addMariaDbColumnIfNotExists(client, 'tenant_user_profiles', 'sheet_sync_url', 'TEXT NULL');
  await addMariaDbColumnIfNotExists(client, 'tenant_user_profiles', 'sheet_tab_name', 'VARCHAR(150) NULL');
  await addMariaDbColumnIfNotExists(client, 'tenant_user_profiles', 'skip_count', 'INT NOT NULL DEFAULT 0');
  await addMariaDbColumnIfNotExists(client, 'tenant_user_profiles', 'current_turn_remaining', 'INT NOT NULL DEFAULT 0');
  await addMariaDbColumnIfNotExists(client, 'tenant_user_profiles', 'hourly_leads_count', 'INT NOT NULL DEFAULT 0');
  await addMariaDbColumnIfNotExists(client, 'tenant_user_profiles', 'hourly_window_start', 'DATETIME(6) NULL');
  await addMariaDbColumnIfNotExists(client, 'distribution_rounds', 'description', 'TEXT NULL');
  await addMariaDbColumnIfNotExists(client, 'distribution_rounds', 'cc_emails', 'TEXT NULL');
  await addMariaDbColumnIfNotExists(client, 'distribution_rounds', 'last_assigned_consultant_id', 'VARCHAR(36) NULL');
  await addMariaDbColumnIfNotExists(client, 'round_consultants', 'is_active', 'TINYINT(1) NOT NULL DEFAULT 1');
  await addMariaDbColumnIfNotExists(client, 'round_consultants', 'current_turn_remaining', 'INT NOT NULL DEFAULT 0');
  await addMariaDbColumnIfNotExists(client, 'round_consultants', 'skip_count', 'INT NOT NULL DEFAULT 0');
  await addMariaDbColumnIfNotExists(client, 'round_consultants', 'skipped_credit', 'INT NOT NULL DEFAULT 0');
  await addMariaDbColumnIfNotExists(client, 'routing_rules', 'condition_branches', 'JSON NULL');
  await addMariaDbColumnIfNotExists(client, 'routing_rules', 'connection_scopes', 'JSON NULL');
  await addMariaDbColumnIfNotExists(client, 'routing_rules', 'inject_fields', 'JSON NULL');
  await addMariaDbColumnIfNotExists(client, 'leads', 'round_id', 'VARCHAR(36) NULL');
  await addMariaDbColumnIfNotExists(client, 'leads', 'connection_id', 'VARCHAR(36) NULL');
  await addMariaDbColumnIfNotExists(client, 'leads', 'product_interest', 'VARCHAR(255) NULL');
  await addMariaDbColumnIfNotExists(client, 'leads', 'budget_range', 'VARCHAR(120) NULL');
  await addMariaDbColumnIfNotExists(client, 'leads', 'utm_source', 'VARCHAR(100) NULL');
  await addMariaDbColumnIfNotExists(client, 'leads', 'ad_id', 'VARCHAR(100) NULL');
  await addMariaDbColumnIfNotExists(client, 'leads', 'adset_id', 'VARCHAR(100) NULL');
  await addMariaDbColumnIfNotExists(client, 'leads', 'campaign_id', 'VARCHAR(100) NULL');
  await addMariaDbColumnIfNotExists(client, 'leads', 'form_id', 'VARCHAR(100) NULL');
  await addMariaDbColumnIfNotExists(client, 'leads', 'is_duplicated', 'TINYINT(1) NOT NULL DEFAULT 0');
  await addMariaDbColumnIfNotExists(client, 'leads', 'duplicate_of_lead_id', 'VARCHAR(36) NULL');
  await addMariaDbColumnIfNotExists(client, 'leads', 'batch_id', 'VARCHAR(36) NULL');
  await addMariaDbColumnIfNotExists(client, 'leads', 'is_deleted', 'TINYINT(1) NOT NULL DEFAULT 0');
  await addMariaDbColumnIfNotExists(client, 'leads', 'ai_screener_status', "VARCHAR(40) NOT NULL DEFAULT 'not_screened'");
  await addMariaDbColumnIfNotExists(client, 'leads', 'ai_evaluation', 'TEXT NULL');
  await addMariaDbColumnIfNotExists(client, 'leads', 'ai_prompt_tokens', 'INT NOT NULL DEFAULT 0');
  await addMariaDbColumnIfNotExists(client, 'leads', 'ai_completion_tokens', 'INT NOT NULL DEFAULT 0');
  await addMariaDbColumnIfNotExists(client, 'leads', 'zalo_notify_status', "VARCHAR(40) NOT NULL DEFAULT 'none'");
  await addMariaDbColumnIfNotExists(client, 'leads', 'email_notify_status', "VARCHAR(40) NOT NULL DEFAULT 'none'");

  // Composite indexes on leads
  await client.query('CREATE INDEX IF NOT EXISTS idx_leads_tenant_phone_created ON leads(tenant_id, phone, created_at DESC)').catch(() => {});
  await client.query('CREATE INDEX IF NOT EXISTS idx_leads_sla_sweep ON leads(tenant_id, is_accepted, sla_breached, stage_id)').catch(() => {});
  await client.query('CREATE INDEX IF NOT EXISTS idx_leads_tenant_created_at ON leads(tenant_id, created_at DESC)').catch(() => {});

  // Ensure billing & Phase 2 extension tables exist on upgraded MariaDB instances
  const mariaExtensionDdl = [
    `CREATE TABLE IF NOT EXISTS tenant_billing_transactions (
      id VARCHAR(36) NOT NULL PRIMARY KEY DEFAULT (UUID()),
      tenant_id VARCHAR(36) NOT NULL,
      tx_type VARCHAR(40) NOT NULL,
      plan_code VARCHAR(80) NULL,
      billing_cycle VARCHAR(30) NULL,
      months_added INT NOT NULL DEFAULT 0,
      amount_vnd BIGINT NOT NULL DEFAULT 0,
      proration_credit_vnd BIGINT NOT NULL DEFAULT 0,
      discount_pct DECIMAL(5,2) NOT NULL DEFAULT 0,
      payment_method VARCHAR(40) NOT NULL DEFAULT 'bank_transfer',
      provider VARCHAR(40) NOT NULL DEFAULT 'manual_bank_transfer',
      external_tx_id VARCHAR(160) NULL,
      idempotency_key VARCHAR(120) NULL,
      status VARCHAR(30) NOT NULL DEFAULT 'pending',
      reference_code VARCHAR(80) NULL,
      note TEXT NULL,
      metadata JSON NOT NULL,
      requested_by VARCHAR(36) NULL,
      processed_by VARCHAR(255) NULL,
      processed_at DATETIME(6) NULL,
      created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
      INDEX idx_billing_tx_tenant_created (tenant_id, created_at DESC),
      INDEX idx_billing_tx_status_created (status, created_at DESC),
      INDEX idx_billing_tx_tenant_status_created (tenant_id, status, created_at DESC)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
    `CREATE TABLE IF NOT EXISTS consultant_managers (
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
      INDEX idx_cm_tenant_consultant (tenant_id, consultant_user_id, status)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
    `CREATE TABLE IF NOT EXISTS personal_leads (
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
      INDEX idx_personal_leads_owner (tenant_id, owner_user_id, created_at DESC)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
    `CREATE TABLE IF NOT EXISTS ai_screener_configs (
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
      updated_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
    `CREATE TABLE IF NOT EXISTS held_leads (
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
      INDEX idx_held_leads_tenant_status (tenant_id, status, created_at DESC)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
    `CREATE TABLE IF NOT EXISTS blacklist_entries (
      id VARCHAR(36) NOT NULL PRIMARY KEY DEFAULT (UUID()),
      tenant_id VARCHAR(36) NOT NULL,
      entry_type VARCHAR(20) NOT NULL,
      value VARCHAR(255) NOT NULL,
      reason TEXT NULL,
      created_by VARCHAR(36) NULL,
      created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
      CONSTRAINT uk_blacklist_tenant_type_val UNIQUE (tenant_id, entry_type, value),
      INDEX idx_blacklist_tenant_type (tenant_id, entry_type)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
    `CREATE TABLE IF NOT EXISTS meta_ads_insights (
      id VARCHAR(36) NOT NULL PRIMARY KEY DEFAULT (UUID()),
      tenant_id VARCHAR(36) NOT NULL,
      ad_account_id VARCHAR(100) NULL,
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
      INDEX idx_meta_ads_tenant_date (tenant_id, date_start DESC)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
    `CREATE TABLE IF NOT EXISTS lead_import_batches (
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
      INDEX idx_import_batches_tenant (tenant_id, created_at DESC)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
    `CREATE TABLE IF NOT EXISTS admin_audit_logs (
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
      INDEX idx_admin_audit_tenant_created (tenant_id, created_at DESC)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
    `CREATE TABLE IF NOT EXISTS active_compensation_logs (
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
      INDEX idx_comp_logs_tenant_created (tenant_id, created_at DESC)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
    `CREATE TABLE IF NOT EXISTS platform_consultations (
      id VARCHAR(36) NOT NULL PRIMARY KEY DEFAULT (UUID()),
      lead_code VARCHAR(40) NOT NULL,
      source_form VARCHAR(150) NOT NULL DEFAULT 'domation.net',
      page_path VARCHAR(255) NULL,
      page_url TEXT NULL,
      name VARCHAR(150) NULL,
      email VARCHAR(255) NULL,
      phone VARCHAR(40) NULL,
      company VARCHAR(255) NULL,
      service VARCHAR(255) NULL,
      budget_or_scale VARCHAR(255) NULL,
      message TEXT NULL,
      utm_source VARCHAR(120) NULL,
      utm_medium VARCHAR(120) NULL,
      utm_campaign VARCHAR(120) NULL,
      metadata JSON NOT NULL,
      appscript_status VARCHAR(40) NOT NULL DEFAULT 'pending',
      appscript_response JSON NOT NULL,
      client_ip VARCHAR(64) NULL,
      created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
      INDEX idx_platform_consultations_created (created_at DESC)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
  ];
  for (const stmt of mariaExtensionDdl) {
    await client.query(stmt);
  }
  await addMariaDbColumnIfNotExists(client, 'tenant_billing_transactions', 'idempotency_key', 'VARCHAR(120) NULL');
  await addMariaDbColumnIfNotExists(client, 'tenant_billing_transactions', 'provider', "VARCHAR(40) NOT NULL DEFAULT 'manual_bank_transfer'");
  await addMariaDbColumnIfNotExists(client, 'tenant_billing_transactions', 'external_tx_id', 'VARCHAR(160) NULL');
  await addMariaDbColumnIfNotExists(client, 'tenant_billing_transactions', 'proration_credit_vnd', 'BIGINT NOT NULL DEFAULT 0');
  await client.query('CREATE UNIQUE INDEX IF NOT EXISTS uk_billing_tx_tenant_idempotency ON tenant_billing_transactions(tenant_id, idempotency_key)').catch(() => {});
  await client.query('CREATE UNIQUE INDEX IF NOT EXISTS uk_billing_tx_provider_ext ON tenant_billing_transactions(provider, external_tx_id)').catch(() => {});
  await client
    .query(
      `UPDATE tenant_billing_transactions t
       INNER JOIN (
         SELECT id,
                ROW_NUMBER() OVER (PARTITION BY reference_code ORDER BY created_at ASC, id ASC) AS rn
         FROM tenant_billing_transactions
         WHERE reference_code IS NOT NULL
       ) d ON t.id = d.id
       SET t.reference_code = CONCAT(LEFT(t.reference_code, 68), '-', LEFT(t.id, 8))
       WHERE d.rn > 1`
    )
    .catch((err) => {
      console.warn('[migrate][mariadb] Pre-dedup reference_code warning:', err?.message || err);
    });
  await client
    .query('CREATE UNIQUE INDEX IF NOT EXISTS uk_billing_tx_reference_code ON tenant_billing_transactions(reference_code)')
    .catch((err) => {
      console.warn('[migrate][mariadb] uk_billing_tx_reference_code warning:', err?.message || err);
    });
  await client.query('CREATE INDEX IF NOT EXISTS idx_billing_tx_tenant_status_created ON tenant_billing_transactions(tenant_id, status, created_at DESC)').catch(() => {});
  await client.query('CREATE INDEX IF NOT EXISTS idx_billing_tx_tenant_type_created ON tenant_billing_transactions(tenant_id, tx_type, created_at DESC)').catch(() => {});
  await addMariaDbColumnIfNotExists(client, 'capi_logs', 'retry_count', 'INT NOT NULL DEFAULT 0');
  await addMariaDbColumnIfNotExists(client, 'capi_logs', 'next_retry_at', 'DATETIME(6) NULL');
  await client.query('CREATE INDEX IF NOT EXISTS idx_capi_logs_lead_event_status ON capi_logs(tenant_id, lead_id, event_name, response_status)').catch(() => {});
  await client.query('CREATE INDEX IF NOT EXISTS idx_capi_logs_retry_next ON capi_logs(response_status, next_retry_at, sent_at ASC)').catch(() => {});
  await client.query('CREATE INDEX IF NOT EXISTS idx_leads_tenant_ad_id ON leads(tenant_id, ad_id)').catch(() => {});
  await client.query('CREATE INDEX IF NOT EXISTS idx_leads_tenant_adset_id ON leads(tenant_id, adset_id)').catch(() => {});
  await client.query('CREATE INDEX IF NOT EXISTS idx_data_reports_tenant_lead_created ON data_reports(tenant_id, lead_id, created_at DESC)').catch(() => {});
  await client.query('CREATE INDEX IF NOT EXISTS idx_meta_ads_tenant_ad_stop ON meta_ads_insights(tenant_id, ad_id, date_stop DESC)').catch(() => {});
  await addMariaDbColumnIfNotExists(client, 'meta_ads_insights', 'ad_account_id', 'VARCHAR(100) NULL');

  // Wave 1 MariaDB Additive Columns & Nullable Master Contact Relaxation
  await addMariaDbColumnIfNotExists(client, 'tenants', 'industry_key', "VARCHAR(64) NOT NULL DEFAULT 'general'");
  await addMariaDbColumnIfNotExists(client, 'tenants', 'package_code', "VARCHAR(50) NOT NULL DEFAULT 'autodata_crm'");
  await addMariaDbColumnIfNotExists(client, 'tenants', 'enabled_modules', 'JSON NULL');
  await addMariaDbColumnIfNotExists(client, 'tenants', 'entitlements', 'JSON NULL');
  await addMariaDbColumnIfNotExists(client, 'users', 'role_id', 'VARCHAR(36) NULL');
  await addMariaDbColumnIfNotExists(client, 'users', 'branch_id', 'VARCHAR(36) NULL');
  await addMariaDbColumnIfNotExists(client, 'users', 'department_id', 'VARCHAR(36) NULL');
  await addMariaDbColumnIfNotExists(client, 'users', 'team_id', 'VARCHAR(36) NULL');
  await addMariaDbColumnIfNotExists(client, 'users', 'position_id', 'VARCHAR(36) NULL');
  await addMariaDbColumnIfNotExists(client, 'users', 'reports_to_user_id', 'VARCHAR(36) NULL');
  await addMariaDbColumnIfNotExists(client, 'users', 'is_tenant_owner', 'TINYINT(1) NOT NULL DEFAULT 0');
  await addMariaDbColumnIfNotExists(client, 'users', 'is_system_bot', 'TINYINT(1) NOT NULL DEFAULT 0');
  await addMariaDbColumnIfNotExists(client, 'tenant_pipeline_stages', 'funnel_category', "VARCHAR(40) NOT NULL DEFAULT 'engaged_qualified'");
  await addMariaDbColumnIfNotExists(client, 'tenant_pipeline_stages', 'score_delta', 'INT NOT NULL DEFAULT 0');
  await addMariaDbColumnIfNotExists(client, 'tenant_pipeline_stages', 'required_fields', 'JSON NULL');
  await addMariaDbColumnIfNotExists(client, 'leads', 'lifecycle_stage', "VARCHAR(40) NOT NULL DEFAULT 'lead'");
  await addMariaDbColumnIfNotExists(client, 'leads', 'lead_score', 'INT NOT NULL DEFAULT 0');
  await addMariaDbColumnIfNotExists(client, 'leads', 'email_consent', "VARCHAR(30) NOT NULL DEFAULT 'subscribed'");
  await addMariaDbColumnIfNotExists(client, 'leads', 'zns_consent', "VARCHAR(30) NOT NULL DEFAULT 'opted_in'");
  await addMariaDbColumnIfNotExists(client, 'leads', 'total_revenue_vnd', 'BIGINT NOT NULL DEFAULT 0');
  await addMariaDbColumnIfNotExists(client, 'leads', 'last_engaged_at', 'DATETIME(6) NULL');
  await client.query('ALTER TABLE leads MODIFY COLUMN pipeline_id VARCHAR(36) NULL').catch(() => {});
  await client.query('ALTER TABLE leads MODIFY COLUMN stage_id VARCHAR(36) NULL').catch(() => {});
  await client.query('ALTER TABLE leads MODIFY COLUMN phone VARCHAR(30) NULL').catch(() => {});

  const mariaWave1Tables = [
    `CREATE TABLE IF NOT EXISTS tenant_branches (
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
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
    `CREATE TABLE IF NOT EXISTS tenant_roles (
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
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
    `CREATE TABLE IF NOT EXISTS tenant_departments (
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
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
    `CREATE TABLE IF NOT EXISTS tenant_teams (
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
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
    `CREATE TABLE IF NOT EXISTS tenant_positions (
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
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
    `CREATE TABLE IF NOT EXISTS tenant_role_permissions (
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
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
    `CREATE TABLE IF NOT EXISTS tenant_department_permissions (
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
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
    `CREATE TABLE IF NOT EXISTS tenant_user_permission_overrides (
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
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
    `CREATE TABLE IF NOT EXISTS tenant_stage_transition_rules (
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
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
    `CREATE TABLE IF NOT EXISTS tenant_custom_kpis (
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
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
    `CREATE TABLE IF NOT EXISTS tenant_policy_documents (
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
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
    `CREATE TABLE IF NOT EXISTS tenant_audiences (
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
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
    `CREATE TABLE IF NOT EXISTS tenant_audience_members (
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
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
    `CREATE TABLE IF NOT EXISTS tenant_audience_exclusions (
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
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
    `CREATE TABLE IF NOT EXISTS tenant_tags (
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
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
    `CREATE TABLE IF NOT EXISTS lead_tags (
      id VARCHAR(36) NOT NULL PRIMARY KEY DEFAULT (UUID()),
      tenant_id VARCHAR(36) NOT NULL,
      lead_id VARCHAR(36) NOT NULL,
      tag_id VARCHAR(36) NOT NULL,
      assigned_by VARCHAR(36) NULL,
      created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
      CONSTRAINT uk_lead_tag UNIQUE (tenant_id, lead_id, tag_id),
      INDEX idx_lead_tags_lead (tenant_id, lead_id),
      INDEX idx_lead_tags_tag (tenant_id, tag_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
  ];
  for (const stmt of mariaWave1Tables) {
    await client.query(stmt);
  }

  // Full-Clone Stage 1-4 MariaDB Additive Columns & 37 Full-Clone Tables
  await addMariaDbColumnIfNotExists(client, 'tenant_roles', 'screen_access', 'JSON NULL');
  await addMariaDbColumnIfNotExists(client, 'tenant_roles', 'quick_actions', 'JSON NULL');
  await addMariaDbColumnIfNotExists(client, 'tenant_roles', 'default_route', 'VARCHAR(120) NULL');
  await addMariaDbColumnIfNotExists(client, 'tenant_role_permissions', 'screen_access', 'JSON NULL');
  await addMariaDbColumnIfNotExists(client, 'tenant_role_permissions', 'quick_actions', 'JSON NULL');
  await addMariaDbColumnIfNotExists(client, 'tenant_role_permissions', 'default_route', 'VARCHAR(120) NULL');
  await addMariaDbColumnIfNotExists(client, 'tenant_branches', 'branch_ip_whitelist', 'JSON NULL');
  await addMariaDbColumnIfNotExists(client, 'tenant_branches', 'manager_user_id', 'VARCHAR(36) NULL');

  const mariaFullCloneTables: string[] = [
    `CREATE TABLE IF NOT EXISTS tenant_domain_events_outbox (
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
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
    `CREATE TABLE IF NOT EXISTS tenant_user_notification_settings (
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
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
    `CREATE TABLE IF NOT EXISTS crm_public_leads_pool (
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
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
    `CREATE TABLE IF NOT EXISTS tenant_geoip_blocks (
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
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
  ];
  for (const stmt of mariaFullCloneTables) {
    await client.query(stmt);
  }

  // Performance composite indexes on leads for MariaDB 10.6 parity with PostgreSQL
  const mariaLeadIndexes = [
    'CREATE INDEX IF NOT EXISTS idx_leads_tenant_adset_created ON leads(tenant_id, adset_id, created_at)',
    'CREATE INDEX IF NOT EXISTS idx_leads_tenant_email ON leads(tenant_id, email)',
    'CREATE INDEX IF NOT EXISTS idx_leads_tenant_phone ON leads(tenant_id, phone)',
    'CREATE INDEX IF NOT EXISTS idx_leads_tenant_updated ON leads(tenant_id, updated_at)',
  ];
  for (const idxStmt of mariaLeadIndexes) {
    await client.query(idxStmt).catch(() => {});
  }

  // Backfills
  await backfillUsersToGlobalAccounts(client);
  await backfillTenantObfuscatedSlugs(client);
  await backfillWave1TenantOwnersAndPackages(client);

  if (options?.seedSuperAdmin !== false) {
    await seedSuperAdmin(client);
  }
}

/**
 * Idempotently backfills Wave 1 `industry_key` and primary `is_tenant_owner = true`
 * for existing tenants across PostgreSQL, PGlite, and MariaDB.
 */
async function backfillWave1TenantOwnersAndPackages(client: DbClient): Promise<void> {
  await client
    .query(
      `UPDATE tenants
       SET industry_key = COALESCE(NULLIF(industry, ''), 'general')
       WHERE industry_key IS NULL OR industry_key = '' OR (industry_key = 'general' AND industry != 'general')`
    )
    .catch(() => {});

  const ownerless = await client.query<{ tenant_id: string }>(
    `SELECT t.id AS tenant_id
     FROM tenants t
     WHERE NOT EXISTS (
       SELECT 1 FROM users u WHERE u.tenant_id = t.id AND u.is_tenant_owner = true
     )`
  );

  for (const row of ownerless.rows) {
    const firstAdmin = await client.query<{ id: string }>(
      `SELECT id FROM users
       WHERE tenant_id = $1 AND role = 'tenant_admin'
       ORDER BY created_at ASC
       LIMIT 1`,
      [row.tenant_id]
    );
    if (firstAdmin.rows[0]?.id) {
      await client.query(
        'UPDATE users SET is_tenant_owner = true WHERE tenant_id = $1 AND id = $2',
        [row.tenant_id, firstAdmin.rows[0].id]
      );
    }
  }
}

/**
 * Backfill existing users into global_accounts idempotently
 */
async function backfillUsersToGlobalAccounts(client: DbClient): Promise<void> {
  const unlinkedUsers = await client.query<{
    id: string;
    email: string;
    password_hash: string;
    full_name: string;
    phone: string | null;
  }>(
    `SELECT u.id, u.email, u.password_hash, u.full_name, u.phone
     FROM users u
     WHERE u.account_id IS NULL`
  );

  if (unlinkedUsers.rows.length === 0) return;

  const emailMap = new Map<string, { email: string; password_hash: string; full_name: string; phone: string | null }>();
  for (const u of unlinkedUsers.rows) {
    const lEmail = u.email.trim().toLowerCase();
    if (!emailMap.has(lEmail)) {
      emailMap.set(lEmail, u);
    }
  }

  for (const [lEmail, u] of emailMap.entries()) {
    const existing = await client.query<{ id: string }>(
      'SELECT id FROM global_accounts WHERE LOWER(email) = $1 LIMIT 1',
      [lEmail]
    );

    let accountId = existing.rows[0]?.id;
    if (!accountId) {
      if (client.dialect === 'mariadb') {
        await client.query(
          `INSERT INTO global_accounts (email, password_hash, full_name, phone)
           VALUES ($1, $2, $3, $4)`,
          [lEmail, u.password_hash, u.full_name, u.phone]
        );
        const insCheck = await client.query<{ id: string }>(
          'SELECT id FROM global_accounts WHERE LOWER(email) = $1 LIMIT 1',
          [lEmail]
        );
        accountId = insCheck.rows[0]?.id;
      } else {
        const insRes = await client.query<{ id: string }>(
          `INSERT INTO global_accounts (email, password_hash, full_name, phone)
           VALUES ($1, $2, $3, $4)
           RETURNING id`,
          [lEmail, u.password_hash, u.full_name, u.phone]
        );
        accountId = insRes.rows[0]?.id;
      }
    }

    if (accountId) {
      await client.query(
        'UPDATE users SET account_id = $1 WHERE LOWER(email) = $2 AND account_id IS NULL',
        [accountId, lEmail]
      );
    }
  }
}

/**
 * Backfill existing tenants with CSPRNG obfuscated_slug
 */
async function backfillTenantObfuscatedSlugs(client: DbClient): Promise<void> {
  const unslugged = await client.query<{ id: string; slug: string }>(
    'SELECT id, slug FROM tenants WHERE obfuscated_slug IS NULL'
  );

  for (const t of unslugged.rows) {
    let success = false;
    let attempts = 0;
    while (!success && attempts < 5) {
      attempts++;
      const obf = generateObfuscatedSlug(t.slug);
      try {
        await client.query(
          'UPDATE tenants SET obfuscated_slug = $1 WHERE id = $2 AND obfuscated_slug IS NULL',
          [obf, t.id]
        );
        success = true;
      } catch (err: any) {
        if (err.code === '23505' || err.code === 'ER_DUP_ENTRY') continue;
        throw err;
      }
    }
  }
}

async function addMariaDbColumnIfNotExists(client: DbClient, table: string, column: string, def: string): Promise<void> {
  const colCheck = await client.query<{ col_count: number }>(
    `SELECT COUNT(*) AS col_count
     FROM information_schema.columns
     WHERE table_schema = DATABASE() AND table_name = '${table}' AND column_name = '${column}'`
  );
  if (Number(colCheck.rows[0]?.col_count || 0) === 0) {
    await client.query(`ALTER TABLE ${table} ADD COLUMN ${column} ${def}`);
  }
}

async function seedSuperAdmin(client: DbClient): Promise<void> {
  const existingAdmin = await client.query(
    'SELECT id FROM platform_superadmins WHERE email = $1 LIMIT 1',
    [APP_CONFIG.superadminEmail.toLowerCase()]
  );
  if (existingAdmin.rows.length === 0) {
    const passwordHash = await hashPassword(APP_CONFIG.superadminPassword, APP_CONFIG.bcryptRounds);
    await client.query(
      `INSERT INTO platform_superadmins (email, password_hash, full_name, role, is_active)
       VALUES ($1, $2, $3, 'super_admin', true)`,
      [APP_CONFIG.superadminEmail.toLowerCase(), passwordHash, 'Platform Operator Root']
    );
  }
}
