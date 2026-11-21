import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export interface SqlDumpMetadata {
  path: string;
  fileSizeBytes: number;
  lineCount: number;
  tableCount: number;
  bakTableCount: number;
  bakTables: string[];
  zaloTables: string[];
  tables: string[];
  insertTables: string[];
  insertStatementCount: number;
  hasAllTables: (required: string[]) => { ok: boolean; missing: string[] };
}

export interface SyntheticMyerpOptions {
  dir?: string;
  fileName?: string;
  includeMultilineStrings?: boolean;
  includeAllZaloTables?: boolean;
  extraContactsCount?: number;
  extraSubscribersCount?: number;
  pendingMailQueueCount?: number;
  waitingFlowStatesCount?: number;
  pollutionWebPropertiesCount?: number;
}

export interface SyntheticMyerpResult {
  sqlPath: string;
  dir: string;
  ownsDir: boolean;
  counts: {
    tenants: number;
    bakTables: number;
    zaloTables: number;
    users: number;
    ideasContacts: number;
    pollutionContacts: number;
    leads: number;
    ideasSubscribers: number;
    pollutionSubscribers: number;
    templates: number;
    campaigns: number;
    flows: number;
    ideasWebProperties: number;
    pollutionWebProperties: number;
    pendingMailQueue: number;
    waitingFlowStates: number;
    verifiedSenders: number;
    legacyUrlCount: number;
  };
  cleanup: () => void;
}

const CREATE_PREFIX = Buffer.from('CREATE TABLE `');
const INSERT_PREFIX = Buffer.from('INSERT INTO `');

/**
 * Constant-memory (<1 MB heap) streaming scanner for MariaDB/mysqldump files.
 * Safe for 632+ MB dumps with 28+ MB single lines and multi-line INSERT statements.
 */
export async function inspectSqlDumpMetadata(dumpPath: string): Promise<SqlDumpMetadata> {
  const stat = await fs.promises.stat(dumpPath);
  const tables: string[] = [];
  const bakTables: string[] = [];
  const zaloTables: string[] = [];
  const insertTableSet = new Set<string>();
  let lineCount = 0;
  let insertStatementCount = 0;

  const headBuf = Buffer.allocUnsafe(160);
  let headLen = 0;
  let atLineStart = true;

  const flushLineHead = () => {
    if (headLen > CREATE_PREFIX.length && headBuf.subarray(0, CREATE_PREFIX.length).equals(CREATE_PREFIX)) {
      const endTick = headBuf.indexOf(0x60 /* '`' */, CREATE_PREFIX.length);
      if (endTick > CREATE_PREFIX.length) {
        const tbl = headBuf.subarray(CREATE_PREFIX.length, endTick).toString('utf8');
        tables.push(tbl);
        if (tbl.startsWith('_bak_')) bakTables.push(tbl);
        if (tbl.startsWith('zalo_')) zaloTables.push(tbl);
      }
    } else if (headLen > INSERT_PREFIX.length && headBuf.subarray(0, INSERT_PREFIX.length).equals(INSERT_PREFIX)) {
      const endTick = headBuf.indexOf(0x60 /* '`' */, INSERT_PREFIX.length);
      if (endTick > INSERT_PREFIX.length) {
        const tbl = headBuf.subarray(INSERT_PREFIX.length, endTick).toString('utf8');
        insertTableSet.add(tbl);
        insertStatementCount += 1;
      }
    }
    headLen = 0;
  };

  await new Promise<void>((resolve, reject) => {
    const stream = fs.createReadStream(dumpPath, { highWaterMark: 256 * 1024 });
    stream.on('data', (chunk: string | Buffer) => {
      const buf = typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : chunk;
      let pos = 0;
      while (pos < buf.length) {
        const nl = buf.indexOf(0x0a /* '\n' */, pos);
        const end = nl === -1 ? buf.length : nl;
        if (atLineStart && headLen < headBuf.length) {
          const take = Math.min(headBuf.length - headLen, end - pos);
          buf.copy(headBuf, headLen, pos, pos + take);
          headLen += take;
          if (headLen === headBuf.length) atLineStart = false;
        }
        if (nl !== -1) {
          lineCount += 1;
          flushLineHead();
          atLineStart = true;
          pos = nl + 1;
        } else {
          break;
        }
      }
    });
    stream.on('end', () => {
      if (headLen > 0) {
        lineCount += 1;
        flushLineHead();
      }
      resolve();
    });
    stream.on('error', reject);
  });

  const tableSet = new Set(tables);
  return {
    path: dumpPath,
    fileSizeBytes: stat.size,
    lineCount,
    tableCount: tables.length,
    bakTableCount: bakTables.length,
    bakTables,
    zaloTables,
    tables,
    insertTables: Array.from(insertTableSet),
    insertStatementCount,
    hasAllTables: (required: string[]) => {
      const missing = required.filter((t) => !tableSet.has(t));
      return { ok: missing.length === 0, missing };
    },
  };
}

function sqlVal(val: unknown): string {
  if (val === null || val === undefined) return 'NULL';
  if (typeof val === 'number') return Number.isFinite(val) ? String(val) : 'NULL';
  if (typeof val === 'boolean') return val ? '1' : '0';
  const raw = typeof val === 'string' ? val : JSON.stringify(val);
  const escaped = raw
    .replace(/\\/g, '\\\\')
    .replace(/'/g, "\\'")
    .replace(/\r/g, '\\r')
    .replace(/\0/g, '\\0');
  return `'${escaped}'`;
}

function buildTuple(columns: readonly string[], overrides: Record<string, unknown>): string {
  const vals = columns.map((col) => sqlVal(col in overrides ? overrides[col] : null));
  return `(${vals.join(',')})`;
}

function emitInsert(table: string, columns: readonly string[], rows: Array<Record<string, unknown>>): string {
  if (rows.length === 0) return '';
  const tuples = rows.map((row) => buildTuple(columns, row));
  return `INSERT INTO \`${table}\` VALUES ${tuples.join(',')};\n`;
}

// ============================================================================
// Exact MariaDB Table Schemas (Column Order Matches myerp_backup_latest.sql)
// ============================================================================

const TENANTS_COLS = [
  'id',
  'name',
  'slug',
  'plan',
  'logo_url',
  'primary_color',
  'currency',
  'timezone',
  'is_active',
  'created_at',
  'updated_at',
] as const;

const BAK_ACTIVITIES_COLS = [
  'id',
  'tenant_id',
  'user_id',
  'task_group_id',
  'created_by',
  'type',
  'subject',
  'body',
  'status',
  'priority',
  'start_date',
  'due_date',
  'done_at',
  'related_type',
  'related_id',
  'contact_id',
  'tags',
  'participant_ids',
  'progress',
  'require_approval',
  'approver_id',
  'approval_status',
  'link',
  'created_at',
  'updated_at',
  'deleted_at',
  'edit_history',
] as const;

const BAK_DEPOSITS_COLS = [
  'id',
  'contact_id',
  'project_id',
  'unit_code',
  'price',
  'expected_commission',
  'status',
  'cancelled_reason',
  'created_by',
  'created_at',
  'updated_at',
  'auto_remind',
  'remind_days_before',
  'remind_at_hour',
  'remind_target',
  'notes',
  'currency',
  'exchange_rate',
  'accountant_id',
  'participant_ids',
  'full_name',
] as const;

const USERS_COLS = [
  'id',
  'tenant_id',
  'username',
  'email',
  'password_hash',
  'full_name',
  'job_title',
  'phone',
  'avatar_url',
  'signature_url',
  'role',
  'department',
  'is_active',
  'two_factor_enabled',
  'two_factor_type',
  'two_factor_secret',
  'two_factor_backup_codes',
  'status',
  'vacation_mode',
  'leave_start',
  'leave_end',
  'work_start_time',
  'work_end_time',
  'work_schedule',
  'zalo_chat_id',
  'telegram_chat_id',
  'is_confirmed',
  'confirm_token',
  'bio',
  'last_login_at',
  'created_at',
  'updated_at',
  'team_id',
  'dob',
  'gender',
  'citizen_id',
  'address',
  'bank_name',
  'bank_account',
  'overtime_mode',
  'permissions_json',
  'extra_fields_json',
  'manager_behavior_mode',
  'use_custom_work_hours',
  'deleted_at',
  'google_id',
] as const;

const CONTACTS_COLS = [
  'id',
  'tenant_id',
  'person_id',
  'duplicate_flag',
  'duplicate_with_id',
  'project_id',
  'company_id',
  'owner_id',
  'collaborator_ids',
  'created_by',
  'full_name',
  'email',
  'phone',
  'avatar_url',
  'mobile',
  'birthday',
  'job_title',
  'department',
  'source',
  'status',
  'pipeline_status',
  'temperature',
  'suggested_temperature',
  'temperature_updated_at',
  'tags',
  'notes',
  'total_spent',
  'order_count',
  'last_order_at',
  'address',
  'city',
  'ward',
  'expected_revenue',
  'win_probability',
  'last_contact',
  'lead_score',
  'stage_id',
  'ttl1_completed',
  'ttl1_data',
  'created_at',
  'updated_at',
  'deleted_at',
  'security_expires_at',
  'parallel_assigned',
  'gender',
  'birth_date',
  'zalo_link',
  'fb_link',
  'customer_type',
  'industry',
  'budget_range',
  'campaign_id',
  'not_lead_proposed',
  'not_lead_proposed_by',
  'not_lead_proposed_at',
  'phone2',
  'dob',
  'citizen_id',
  'passport',
  'district',
  'company',
  'tax_code',
  'budget',
  'demand_type',
  'property_type',
  'bedroom_count',
  'preferred_location',
  'utm_campaign',
  'utm_medium',
  'utm_content',
  'utm_term',
  'platform',
  'form_name',
  'zalo_phone',
  'facebook_link',
  'lead_status',
  'lead_temperature',
  'next_action',
  'next_followup_date',
  'expected_decision_date',
  'expected_intake',
  'program',
  'intake',
  'admission_date',
  'nurture_reason',
  'lost_reason',
  'lost_stage_id',
  'student_id',
  'study_status',
  'major',
  'domation_subscriber_id',
  'marketing_status',
  'engagement_score',
  'stats_email_sent',
  'stats_email_opened',
  'stats_email_clicked',
  'last_email_open_at',
  'last_email_click_at',
  'last_web_visit_at',
  'web_pageviews_count',
  'max_scroll_depth',
  'active_flow_count',
  'active_flow_names',
  'active_voucher_code',
  'survey_completed_count',
  'zalo_user_id',
  'meta_psid',
  'meta_lead_id',
  'meta_ad_id',
  'meta_ad_name',
  'meta_adset_id',
  'meta_adset_name',
  'meta_campaign_id',
  'meta_campaign_name',
  'meta_form_name',
  'meta_platform',
  'meta_degree',
  'meta_consultation_time',
  'assigned_at',
  'is_error_ticket',
] as const;

const LEADS_COLS = [
  'id',
  'person_id',
  'phone',
  'email',
  'name',
  'source',
  'type',
  'note',
  'campaign_id',
  'campaign_name',
  'ad_id',
  'raw_payload',
  'assigned_to',
  'last_assigned_at',
  'target_round_id',
  'is_accepted',
  'accepted_at',
  'status',
  'ai_screener_status',
  'ai_evaluation',
  'ai_attempts',
  'connection_id',
  'last_interaction_date',
  'created_at',
  'zalo_notify_status',
  'email_notify_status',
  'zalo_notify_sent_at',
  'email_notify_sent_at',
  'ai_screening_started_at',
  'ai_prompt_tokens',
  'ai_completion_tokens',
  'ai_total_tokens',
  'telegram_notify_status',
  'telegram_notify_sent_at',
  'phone2',
  'gender',
  'dob',
  'citizen_id',
  'district',
  'company',
  'tax_code',
  'budget',
  'demand_type',
  'property_type',
  'bedroom_count',
  'preferred_location',
  'utm_campaign',
  'utm_medium',
  'utm_content',
  'utm_term',
  'platform',
  'form_name',
  'zalo_phone',
  'facebook_link',
  'next_attempt_date',
  'full_name',
  'program',
  'admission_date',
  'student_id',
  'avatar_url',
  'deleted_at',
] as const;

const PIPELINE_STAGES_COLS = [
  'id',
  'tenant_id',
  'name',
  'color',
  'order_index',
  'is_won',
  'is_lost',
  'created_at',
  'system_slug',
  'definition',
  'target_goal',
  'sales_actions',
  'exit_criteria',
] as const;

const DISTRIBUTION_ROUNDS_COLS = [
  'id',
  'tenant_id',
  'round_name',
  'description',
  'cc_emails',
  'last_assigned_consultant_id',
  'is_active',
  'project_id',
] as const;

const ROUND_CONSULTANTS_COLS = [
  'round_id',
  'consultant_id',
  'is_active',
  'receive_ratio',
  'skip_count',
  'compensation_count',
  'data_per_turn',
  'current_turn_remaining',
  'skipped_credit',
] as const;

const ROUTING_RULES_COLS = [
  'id',
  'connection_id',
  'target_round_id',
  'condition_column',
  'condition_operator',
  'condition_value',
  'priority',
  'conditions_json',
  'logical_operator',
] as const;

const SUBSCRIBERS_COLS = [
  'id',
  'contact_id',
  'person_id',
  'phone_norm9',
  'email_norm',
  'email',
  'first_name',
  'last_name',
  'gender',
  'status',
  'source',
  'salesperson',
  'phone_number',
  'phone',
  'job_title',
  'company_name',
  'country',
  'city',
  'timezone',
  'address',
  'date_of_birth',
  'anniversary_date',
  'notes',
  'last_activity_at',
  'tags',
  'custom_attributes',
  'stats_sent',
  'stats_opened',
  'stats_clicked',
  'last_open_at',
  'last_click_at',
  'joined_at',
  'updated_at',
  'deleted_at',
  'zalo_user_id',
  'is_zalo_follower',
  'meta_psid',
  'lead_score',
  'verified',
  'avatar',
  'last_os',
  'last_device',
  'last_browser',
  'last_city',
  'last_country',
  'property_id',
  'last_ip',
  'workspace_id',
  'created_at',
  'created_by',
  'updated_by',
  'owner_id',
  'program',
  'stage_id',
  'pipeline_status',
  'lead_status',
  'district',
  'ward',
  'temperature',
  'last_send_at',
] as const;

const LISTS_COLS = [
  'id',
  'name',
  'source',
  'type',
  'subscriber_count',
  'phone_count',
  'created_at',
  'updated_at',
  'deleted_at',
  'workspace_id',
  'created_by',
  'updated_by',
] as const;

const SUBSCRIBER_LISTS_COLS = ['subscriber_id', 'list_id', 'workspace_id'] as const;

const SEGMENTS_COLS = [
  'id',
  'tenant_id',
  'created_by',
  'name',
  'entity_type',
  'filters',
  'is_shared',
  'created_at',
  'description',
  'criteria',
  'subscriber_count',
  'phone_count',
  'auto_cleanup_days',
  'updated_at',
  'deleted_at',
  'ai_analysis',
  'ai_analysis_at',
  'synced_at',
  'notify_on_join',
  'notify_subject',
  'notify_email',
  'notify_cc',
  'workspace_id',
  'updated_by',
  'conditions',
] as const;

const TEMPLATES_COLS = [
  'id',
  'name',
  'thumbnail',
  'category',
  'group_id',
  'blocks',
  'body_style',
  'html_content',
  'created_at',
  'updated_at',
  'type',
  'subject',
  'workspace_id',
  'created_by',
  'updated_by',
  'visibility',
  'access_config',
] as const;

const CAMPAIGNS_COLS = [
  'id',
  'name',
  'subject',
  'preheader_text',
  'sender_email',
  'sender_name',
  'reply_to',
  'status',
  'type',
  'config',
  'template_id',
  'content_body',
  'target_config',
  'scheduled_at',
  'timezone',
  'sent_at',
  'tracking_enabled',
  'count_sent',
  'count_opened',
  'count_unique_opened',
  'count_clicked',
  'count_unique_clicked',
  'count_bounced',
  'count_spam',
  'count_unsubscribed',
  'created_at',
  'updated_at',
  'is_deleted',
  'attachments',
  'total_target_audience',
  'stat_opens',
  'stat_clicks',
  'stat_device_mobile',
  'stat_device_desktop',
  'stats',
  'workspace_id',
  'created_by',
  'updated_by',
  'deleted_at',
] as const;

const FLOWS_COLS = [
  'id',
  'name',
  'description',
  'status',
  'steps',
  'config',
  'stat_enrolled',
  'stat_completed',
  'stat_open_rate',
  'stat_click_rate',
  'stat_total_sent',
  'stat_total_opened',
  'stat_unique_opened',
  'stat_total_clicked',
  'stat_unique_clicked',
  'stat_total_zalo_clicked',
  'stat_unique_zalo_clicked',
  'stat_total_failed',
  'stat_total_unsubscribed',
  'archived_at',
  'deleted_at',
  'created_at',
  'updated_at',
  'stat_zns_sent',
  'stat_zns_failed',
  'trigger_type',
  'stat_zalo_sent',
  'workspace_id',
  'stat_meta_sent',
  'created_by',
  'updated_by',
] as const;

const FORMS_COLS = [
  'id',
  'tenant_id',
  'name',
  'schema',
  'mapping',
  'embed_token',
  'is_active',
  'submit_count',
  'created_by',
  'created_at',
  'deleted_at',
  'status',
  'target_list_id',
  'fields_json',
  'notification_enabled',
  'notification_emails',
  'notification_cc_emails',
  'notification_subject',
  'workspace_id',
  'updated_by',
] as const;

const SURVEYS_COLS = [
  'id',
  'workspace_id',
  'name',
  'slug',
  'status',
  'cover_style',
  'blocks_json',
  'settings_json',
  'thank_you_page',
  'target_list_id',
  'flow_trigger_id',
  'response_limit',
  'close_at',
  'require_login',
  'allow_anonymous',
  'one_per_email',
  'created_by',
  'created_at',
  'updated_at',
  'deleted_at',
  'updated_by',
] as const;

const SHORT_LINKS_COLS = [
  'id',
  'workspace_id',
  'name',
  'slug',
  'target_url',
  'is_survey_checkin',
  'survey_id',
  'status',
  'access_pin',
  'submit_count',
  'qr_config_json',
  'created_at',
  'utm_source',
  'utm_medium',
  'utm_campaign',
  'created_by',
  'updated_by',
  'is_deleted',
  'deleted_at',
] as const;

const WEB_PROPERTIES_COLS = [
  'id',
  'workspace_id',
  'name',
  'domain',
  'settings',
  'created_at',
  'status',
  'api_key',
  'created_by',
  'updated_by',
  'is_deleted',
  'deleted_at',
] as const;

const MAIL_QUEUE_COLS = [
  'id',
  'to_email',
  'cc_email',
  'subject',
  'body_html',
  'status',
  'created_at',
  'sent_at',
  'attempts',
  'last_error',
  'lead_id',
  'updated_at',
] as const;

const SUBSCRIBER_FLOW_STATES_COLS = [
  'id',
  'workspace_id',
  'contact_id',
  'subscriber_id',
  'flow_id',
  'step_id',
  'step_type',
  'status',
  'scheduled_at',
  'waiting_until',
  'branch_taken',
  'last_error',
  'created_at',
  'updated_at',
  'last_step_at',
] as const;

const CONTACT_META_ATTRIBUTION_COLS = [
  'id',
  'contact_id',
  'tenant_id',
  'meta_lead_id',
  'ad_id',
  'ad_name',
  'adset_id',
  'adset_name',
  'campaign_id',
  'campaign_name',
  'form_id',
  'form_name',
  'platform',
  'fbc',
  'fbp',
  'client_ip_address',
  'client_user_agent',
  'event_source_url',
  'fb_pixel_id',
  'is_organic',
  'lead_created_time',
  'raw_lead_status',
  'priority',
  'sheet_source',
  'degree',
  'english_work_exp',
  'consultation_time',
  'program_interest',
  'form_answers_json',
  'created_at',
  'updated_at',
  'deleted_at',
] as const;

const CAPI_LOGS_COLS = [
  'id',
  'lead_id',
  'meta_lead_id',
  'contact_id',
  'pixel_id',
  'event_name',
  'action_source',
  'payload_hash',
  'event_id',
  'trigger_stage',
  'trigger_mode',
  'event_value',
  'emq_signals',
  'sent_payload',
  'response_status',
  'response_body',
  'sent_at',
  'full_name',
] as const;

const CAPI_BLOCKED_PHONES_COLS = [
  'id',
  'tenant_id',
  'phone_normalized',
  'source_label',
  'reason',
  'created_by',
  'created_at',
  'deleted_at',
] as const;

const META_APP_CONFIGS_COLS = [
  'id',
  'page_name',
  'page_id',
  'app_id',
  'page_access_token',
  'app_secret',
  'verify_token',
  'avatar_url',
  'status',
  'mode',
  'created_at',
  'updated_at',
  'token_expires_at',
  'workspace_id',
] as const;

const SYSTEM_SETTINGS_COLS = ['setting_key', 'setting_value'] as const;
const MKT_SYSTEM_SETTINGS_COLS = ['workspace_id', 'key', 'value', 'updated_at'] as const;
const VERIFIED_SENDERS_COLS = [
  'id',
  'workspace_id',
  'email',
  'name',
  'reply_to',
  'is_verified',
  'is_default',
  'created_at',
] as const;

const ZALO_OA_CONFIGS_COLS = [
  'id',
  'workspace_id',
  'name',
  'avatar',
  'oa_id',
  'app_id',
  'app_secret',
  'pkce_verifier',
  'access_token',
  'refresh_token',
  'token_expires_at',
  'token_status',
  'last_token_check',
  'daily_quota',
  'quota_used_today',
  'quota_reset_date',
  'status',
  'created_at',
  'updated_at',
  'remaining_quota',
  'quality_48h',
  'quality_7d',
  'updated_at_quota',
  'monthly_promo_quota',
  'remaining_promo_quota',
] as const;

const ZALO_QUEUE_COLS = [
  'id',
  'bot_token',
  'chat_id',
  'body_text',
  'status',
  'created_at',
  'sent_at',
  'attempts',
  'last_error',
  'lead_id',
  'updated_at',
] as const;

const ZALO_SUBSCRIBERS_COLS = [
  'id',
  'contact_id',
  'zalo_list_id',
  'zalo_user_id',
  'oa_id',
  'subscriber_id',
  'display_name',
  'avatar',
  'phone_number',
  'gender',
  'birthday',
  'special_day',
  'manual_email',
  'notes',
  'status',
  'lead_score',
  'is_follower',
  'last_interaction_at',
  'joined_at',
  'updated_at',
  'ai_paused_until',
  'workspace_id',
] as const;

const DDL_BLOCK = `-- MariaDB 10.6.28 Synthetic Dump for E2E IDEAS Migration Testing
SET NAMES utf8mb4;

DROP TABLE IF EXISTS \`tenants\`;
CREATE TABLE \`tenants\` (
  \`id\` int(11) NOT NULL AUTO_INCREMENT,
  \`name\` varchar(255) NOT NULL,
  \`slug\` varchar(100) NOT NULL,
  \`plan\` enum('free','pro','enterprise') NOT NULL DEFAULT 'free',
  \`logo_url\` text DEFAULT NULL,
  \`primary_color\` varchar(20) DEFAULT '#BD1D2D',
  \`currency\` char(3) DEFAULT 'VND',
  \`timezone\` varchar(50) DEFAULT 'Asia/Ho_Chi_Minh',
  \`is_active\` tinyint(1) NOT NULL DEFAULT 1,
  \`created_at\` timestamp NOT NULL DEFAULT current_timestamp(),
  \`updated_at\` timestamp NOT NULL DEFAULT current_timestamp(),
  PRIMARY KEY (\`id\`),
  UNIQUE KEY \`slug\` (\`slug\`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

DROP TABLE IF EXISTS \`_bak_activities_20260913\`;
CREATE TABLE \`_bak_activities_20260913\` (
  \`id\` int(11) NOT NULL AUTO_INCREMENT,
  \`tenant_id\` int(11) NOT NULL DEFAULT 1,
  \`user_id\` int(11) DEFAULT NULL,
  \`task_group_id\` int(11) DEFAULT NULL,
  \`created_by\` int(11) DEFAULT NULL,
  \`type\` varchar(50) DEFAULT NULL,
  \`subject\` varchar(255) DEFAULT NULL,
  \`body\` text DEFAULT NULL,
  \`status\` varchar(50) DEFAULT NULL,
  \`priority\` varchar(30) DEFAULT NULL,
  \`start_date\` datetime DEFAULT NULL,
  \`due_date\` datetime DEFAULT NULL,
  \`done_at\` datetime DEFAULT NULL,
  \`related_type\` varchar(50) DEFAULT NULL,
  \`related_id\` int(11) DEFAULT NULL,
  \`contact_id\` int(11) DEFAULT NULL,
  \`tags\` text DEFAULT NULL,
  \`participant_ids\` text DEFAULT NULL,
  \`progress\` int(11) DEFAULT 0,
  \`require_approval\` tinyint(1) DEFAULT 0,
  \`approver_id\` int(11) DEFAULT NULL,
  \`approval_status\` varchar(50) DEFAULT NULL,
  \`link\` text DEFAULT NULL,
  \`created_at\` timestamp NULL DEFAULT NULL,
  \`updated_at\` timestamp NULL DEFAULT NULL,
  \`deleted_at\` timestamp NULL DEFAULT NULL,
  \`edit_history\` longtext DEFAULT NULL,
  PRIMARY KEY (\`id\`)
) ENGINE=InnoDB DEFAULT CHARSET=latin1;

DROP TABLE IF EXISTS \`_bak_deposits_20260819_103521\`;
CREATE TABLE \`_bak_deposits_20260819_103521\` (
  \`id\` int(11) NOT NULL AUTO_INCREMENT,
  \`contact_id\` int(11) DEFAULT NULL,
  \`project_id\` int(11) DEFAULT NULL,
  \`unit_code\` varchar(100) DEFAULT NULL,
  \`price\` decimal(15,2) DEFAULT NULL,
  \`expected_commission\` decimal(15,2) DEFAULT NULL,
  \`status\` varchar(50) DEFAULT NULL,
  \`cancelled_reason\` text DEFAULT NULL,
  \`created_by\` int(11) DEFAULT NULL,
  \`created_at\` timestamp NULL DEFAULT NULL,
  \`updated_at\` timestamp NULL DEFAULT NULL,
  \`auto_remind\` tinyint(1) DEFAULT 0,
  \`remind_days_before\` int(11) DEFAULT NULL,
  \`remind_at_hour\` int(11) DEFAULT NULL,
  \`remind_target\` int(11) DEFAULT NULL,
  \`notes\` text DEFAULT NULL,
  \`currency\` char(3) DEFAULT 'VND',
  \`exchange_rate\` decimal(10,4) DEFAULT 1.0000,
  \`accountant_id\` int(11) DEFAULT NULL,
  \`participant_ids\` text DEFAULT NULL,
  \`full_name\` varchar(255) DEFAULT NULL,
  PRIMARY KEY (\`id\`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

DROP TABLE IF EXISTS \`users\`;
CREATE TABLE \`users\` (
  \`id\` int(11) NOT NULL AUTO_INCREMENT,
  \`tenant_id\` int(11) NOT NULL DEFAULT 1,
  \`username\` varchar(100) NOT NULL,
  \`email\` varchar(255) NOT NULL,
  \`password_hash\` varchar(255) DEFAULT NULL,
  \`full_name\` varchar(255) NOT NULL,
  \`job_title\` varchar(150) DEFAULT NULL,
  \`phone\` varchar(50) DEFAULT NULL,
  \`avatar_url\` text DEFAULT NULL,
  \`signature_url\` text DEFAULT NULL,
  \`role\` varchar(50) NOT NULL DEFAULT 'sales',
  \`department\` varchar(150) DEFAULT NULL,
  \`is_active\` tinyint(1) NOT NULL DEFAULT 1,
  \`two_factor_enabled\` tinyint(1) NOT NULL DEFAULT 0,
  \`two_factor_type\` varchar(30) DEFAULT 'email',
  \`two_factor_secret\` varchar(255) DEFAULT NULL,
  \`two_factor_backup_codes\` text DEFAULT NULL,
  \`status\` enum('active','inactive','leave') DEFAULT 'active',
  \`vacation_mode\` tinyint(1) NOT NULL DEFAULT 0,
  \`leave_start\` datetime DEFAULT NULL,
  \`leave_end\` datetime DEFAULT NULL,
  \`work_start_time\` varchar(10) DEFAULT '08:00',
  \`work_end_time\` varchar(10) DEFAULT '22:00',
  \`work_schedule\` text DEFAULT NULL,
  \`zalo_chat_id\` varchar(100) DEFAULT NULL,
  \`telegram_chat_id\` varchar(100) DEFAULT NULL,
  \`is_confirmed\` tinyint(1) NOT NULL DEFAULT 1,
  \`confirm_token\` varchar(255) DEFAULT NULL,
  \`bio\` text DEFAULT NULL,
  \`last_login_at\` datetime DEFAULT NULL,
  \`created_at\` timestamp NULL DEFAULT NULL,
  \`updated_at\` timestamp NULL DEFAULT NULL,
  \`team_id\` int(11) DEFAULT NULL,
  \`dob\` date DEFAULT NULL,
  \`gender\` varchar(30) DEFAULT NULL,
  \`citizen_id\` varchar(50) DEFAULT NULL,
  \`address\` text DEFAULT NULL,
  \`bank_name\` varchar(150) DEFAULT NULL,
  \`bank_account\` varchar(100) DEFAULT NULL,
  \`overtime_mode\` tinyint(1) DEFAULT 0,
  \`permissions_json\` longtext DEFAULT NULL,
  \`extra_fields_json\` longtext DEFAULT NULL,
  \`manager_behavior_mode\` varchar(50) DEFAULT 'combined',
  \`use_custom_work_hours\` tinyint(1) DEFAULT 0,
  \`deleted_at\` timestamp NULL DEFAULT NULL,
  \`google_id\` varchar(255) DEFAULT NULL,
  PRIMARY KEY (\`id\`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

DROP TABLE IF EXISTS \`contacts\`;
CREATE TABLE \`contacts\` (
  \`id\` int(11) NOT NULL AUTO_INCREMENT,
  \`tenant_id\` int(11) NOT NULL DEFAULT 1,
  \`person_id\` int(11) DEFAULT NULL,
  \`duplicate_flag\` tinyint(1) DEFAULT 0,
  \`duplicate_with_id\` int(11) DEFAULT NULL,
  \`project_id\` int(11) DEFAULT NULL,
  \`company_id\` int(11) DEFAULT NULL,
  \`owner_id\` int(11) DEFAULT NULL,
  \`collaborator_ids\` text DEFAULT NULL,
  \`created_by\` int(11) DEFAULT NULL,
  \`full_name\` varchar(255) DEFAULT NULL,
  \`email\` varchar(255) DEFAULT NULL,
  \`phone\` varchar(50) DEFAULT NULL,
  \`avatar_url\` text DEFAULT NULL,
  \`mobile\` varchar(50) DEFAULT NULL,
  \`birthday\` date DEFAULT NULL,
  \`job_title\` varchar(150) DEFAULT NULL,
  \`department\` varchar(150) DEFAULT NULL,
  \`source\` varchar(150) DEFAULT NULL,
  \`status\` enum('lead','qualified','customer','churned') DEFAULT 'lead',
  \`pipeline_status\` varchar(100) DEFAULT NULL,
  \`temperature\` enum('hot','warm','neutral','cool','cold') DEFAULT 'warm',
  \`suggested_temperature\` varchar(30) DEFAULT NULL,
  \`temperature_updated_at\` datetime DEFAULT NULL,
  \`tags\` text DEFAULT NULL,
  \`notes\` text DEFAULT NULL,
  \`total_spent\` decimal(15,2) DEFAULT 0.00,
  \`order_count\` int(11) DEFAULT 0,
  \`last_order_at\` datetime DEFAULT NULL,
  \`address\` text DEFAULT NULL,
  \`city\` varchar(100) DEFAULT NULL,
  \`ward\` varchar(100) DEFAULT NULL,
  \`expected_revenue\` decimal(15,2) DEFAULT NULL,
  \`win_probability\` int(11) DEFAULT NULL,
  \`last_contact\` datetime DEFAULT NULL,
  \`lead_score\` int(11) DEFAULT 0,
  \`stage_id\` int(11) DEFAULT NULL,
  \`ttl1_completed\` tinyint(1) DEFAULT 0,
  \`ttl1_data\` text DEFAULT NULL,
  \`created_at\` timestamp NULL DEFAULT NULL,
  \`updated_at\` timestamp NULL DEFAULT NULL,
  \`deleted_at\` timestamp NULL DEFAULT NULL,
  \`security_expires_at\` datetime DEFAULT NULL,
  \`parallel_assigned\` tinyint(1) DEFAULT 0,
  \`gender\` varchar(30) DEFAULT NULL,
  \`birth_date\` date DEFAULT NULL,
  \`zalo_link\` text DEFAULT NULL,
  \`fb_link\` text DEFAULT NULL,
  \`customer_type\` varchar(50) DEFAULT NULL,
  \`industry\` varchar(100) DEFAULT NULL,
  \`budget_range\` varchar(100) DEFAULT NULL,
  \`campaign_id\` varchar(100) DEFAULT NULL,
  \`not_lead_proposed\` tinyint(1) DEFAULT 0,
  \`not_lead_proposed_by\` int(11) DEFAULT NULL,
  \`not_lead_proposed_at\` datetime DEFAULT NULL,
  \`phone2\` varchar(50) DEFAULT NULL,
  \`dob\` date DEFAULT NULL,
  \`citizen_id\` varchar(50) DEFAULT NULL,
  \`passport\` varchar(50) DEFAULT NULL,
  \`district\` varchar(100) DEFAULT NULL,
  \`company\` varchar(255) DEFAULT NULL,
  \`tax_code\` varchar(50) DEFAULT NULL,
  \`budget\` varchar(100) DEFAULT NULL,
  \`demand_type\` varchar(100) DEFAULT NULL,
  \`property_type\` varchar(100) DEFAULT NULL,
  \`bedroom_count\` varchar(50) DEFAULT NULL,
  \`preferred_location\` varchar(255) DEFAULT NULL,
  \`utm_campaign\` varchar(150) DEFAULT NULL,
  \`utm_medium\` varchar(150) DEFAULT NULL,
  \`utm_content\` varchar(150) DEFAULT NULL,
  \`utm_term\` varchar(150) DEFAULT NULL,
  \`platform\` varchar(100) DEFAULT NULL,
  \`form_name\` varchar(255) DEFAULT NULL,
  \`zalo_phone\` varchar(50) DEFAULT NULL,
  \`facebook_link\` text DEFAULT NULL,
  \`lead_status\` enum('active','nurture','lost') DEFAULT 'active',
  \`lead_temperature\` varchar(30) DEFAULT NULL,
  \`next_action\` varchar(255) DEFAULT NULL,
  \`next_followup_date\` datetime DEFAULT NULL,
  \`expected_decision_date\` date DEFAULT NULL,
  \`expected_intake\` varchar(100) DEFAULT NULL,
  \`program\` varchar(255) DEFAULT NULL,
  \`intake\` varchar(100) DEFAULT NULL,
  \`admission_date\` date DEFAULT NULL,
  \`nurture_reason\` text DEFAULT NULL,
  \`lost_reason\` text DEFAULT NULL,
  \`lost_stage_id\` int(11) DEFAULT NULL,
  \`student_id\` varchar(100) DEFAULT NULL,
  \`study_status\` varchar(100) DEFAULT NULL,
  \`major\` varchar(150) DEFAULT NULL,
  \`domation_subscriber_id\` varchar(64) DEFAULT NULL,
  \`marketing_status\` varchar(50) DEFAULT NULL,
  \`engagement_score\` int(11) DEFAULT 0,
  \`stats_email_sent\` int(11) DEFAULT 0,
  \`stats_email_opened\` int(11) DEFAULT 0,
  \`stats_email_clicked\` int(11) DEFAULT 0,
  \`last_email_open_at\` datetime DEFAULT NULL,
  \`last_email_click_at\` datetime DEFAULT NULL,
  \`last_web_visit_at\` datetime DEFAULT NULL,
  \`web_pageviews_count\` int(11) DEFAULT 0,
  \`max_scroll_depth\` int(11) DEFAULT 0,
  \`active_flow_count\` int(11) DEFAULT 0,
  \`active_flow_names\` text DEFAULT NULL,
  \`active_voucher_code\` varchar(100) DEFAULT NULL,
  \`survey_completed_count\` int(11) DEFAULT 0,
  \`zalo_user_id\` varchar(100) DEFAULT NULL,
  \`meta_psid\` varchar(100) DEFAULT NULL,
  \`meta_lead_id\` varchar(100) DEFAULT NULL,
  \`meta_ad_id\` varchar(100) DEFAULT NULL,
  \`meta_ad_name\` varchar(255) DEFAULT NULL,
  \`meta_adset_id\` varchar(100) DEFAULT NULL,
  \`meta_adset_name\` varchar(255) DEFAULT NULL,
  \`meta_campaign_id\` varchar(100) DEFAULT NULL,
  \`meta_campaign_name\` varchar(255) DEFAULT NULL,
  \`meta_form_name\` varchar(255) DEFAULT NULL,
  \`meta_platform\` varchar(50) DEFAULT NULL,
  \`meta_degree\` varchar(100) DEFAULT NULL,
  \`meta_consultation_time\` varchar(150) DEFAULT NULL,
  \`assigned_at\` datetime DEFAULT NULL,
  \`is_error_ticket\` tinyint(1) DEFAULT 0,
  PRIMARY KEY (\`id\`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

DROP TABLE IF EXISTS \`leads\`;
CREATE TABLE \`leads\` (
  \`id\` int(11) NOT NULL AUTO_INCREMENT,
  \`person_id\` int(11) DEFAULT NULL,
  \`phone\` varchar(50) DEFAULT NULL,
  \`email\` varchar(255) DEFAULT NULL,
  \`name\` varchar(255) DEFAULT NULL,
  \`source\` varchar(150) DEFAULT NULL,
  \`type\` varchar(100) DEFAULT NULL,
  \`note\` text DEFAULT NULL,
  \`campaign_id\` varchar(100) DEFAULT NULL,
  \`campaign_name\` varchar(255) DEFAULT NULL,
  \`ad_id\` varchar(100) DEFAULT NULL,
  \`raw_payload\` longtext DEFAULT NULL,
  \`assigned_to\` int(11) DEFAULT NULL,
  \`last_assigned_at\` datetime DEFAULT NULL,
  \`target_round_id\` int(11) DEFAULT NULL,
  \`is_accepted\` tinyint(1) DEFAULT 0,
  \`accepted_at\` datetime DEFAULT NULL,
  \`status\` varchar(50) DEFAULT 'active',
  \`ai_screener_status\` varchar(50) DEFAULT 'not_screened',
  \`ai_evaluation\` text DEFAULT NULL,
  \`ai_attempts\` int(11) DEFAULT 0,
  \`connection_id\` int(11) DEFAULT NULL,
  \`last_interaction_date\` datetime DEFAULT NULL,
  \`created_at\` timestamp NULL DEFAULT NULL,
  \`zalo_notify_status\` varchar(50) DEFAULT 'none',
  \`email_notify_status\` varchar(50) DEFAULT 'none',
  \`zalo_notify_sent_at\` datetime DEFAULT NULL,
  \`email_notify_sent_at\` datetime DEFAULT NULL,
  \`ai_screening_started_at\` datetime DEFAULT NULL,
  \`ai_prompt_tokens\` int(11) DEFAULT 0,
  \`ai_completion_tokens\` int(11) DEFAULT 0,
  \`ai_total_tokens\` int(11) DEFAULT 0,
  \`telegram_notify_status\` varchar(50) DEFAULT 'none',
  \`telegram_notify_sent_at\` datetime DEFAULT NULL,
  \`phone2\` varchar(50) DEFAULT NULL,
  \`gender\` varchar(30) DEFAULT NULL,
  \`dob\` date DEFAULT NULL,
  \`citizen_id\` varchar(50) DEFAULT NULL,
  \`district\` varchar(100) DEFAULT NULL,
  \`company\` varchar(255) DEFAULT NULL,
  \`tax_code\` varchar(50) DEFAULT NULL,
  \`budget\` varchar(100) DEFAULT NULL,
  \`demand_type\` varchar(100) DEFAULT NULL,
  \`property_type\` varchar(100) DEFAULT NULL,
  \`bedroom_count\` varchar(50) DEFAULT NULL,
  \`preferred_location\` varchar(255) DEFAULT NULL,
  \`utm_campaign\` varchar(150) DEFAULT NULL,
  \`utm_medium\` varchar(150) DEFAULT NULL,
  \`utm_content\` varchar(150) DEFAULT NULL,
  \`utm_term\` varchar(150) DEFAULT NULL,
  \`platform\` varchar(100) DEFAULT NULL,
  \`form_name\` varchar(255) DEFAULT NULL,
  \`zalo_phone\` varchar(50) DEFAULT NULL,
  \`facebook_link\` text DEFAULT NULL,
  \`next_attempt_date\` datetime DEFAULT NULL,
  \`full_name\` varchar(255) DEFAULT NULL,
  \`program\` varchar(255) DEFAULT NULL,
  \`admission_date\` date DEFAULT NULL,
  \`student_id\` varchar(100) DEFAULT NULL,
  \`avatar_url\` text DEFAULT NULL,
  \`deleted_at\` timestamp NULL DEFAULT NULL,
  PRIMARY KEY (\`id\`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

DROP TABLE IF EXISTS \`pipeline_stages\`;
CREATE TABLE \`pipeline_stages\` (
  \`id\` int(11) NOT NULL AUTO_INCREMENT,
  \`tenant_id\` int(11) NOT NULL DEFAULT 1,
  \`name\` varchar(255) NOT NULL,
  \`color\` varchar(30) DEFAULT NULL,
  \`order_index\` int(11) NOT NULL DEFAULT 0,
  \`is_won\` tinyint(1) DEFAULT 0,
  \`is_lost\` tinyint(1) DEFAULT 0,
  \`created_at\` timestamp NULL DEFAULT NULL,
  \`system_slug\` varchar(100) DEFAULT NULL,
  \`definition\` text DEFAULT NULL,
  \`target_goal\` text DEFAULT NULL,
  \`sales_actions\` text DEFAULT NULL,
  \`exit_criteria\` text DEFAULT NULL,
  PRIMARY KEY (\`id\`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

DROP TABLE IF EXISTS \`distribution_rounds\`;
CREATE TABLE \`distribution_rounds\` (
  \`id\` int(11) NOT NULL AUTO_INCREMENT,
  \`tenant_id\` int(11) NOT NULL DEFAULT 1,
  \`round_name\` varchar(255) NOT NULL,
  \`description\` text DEFAULT NULL,
  \`cc_emails\` text DEFAULT NULL,
  \`last_assigned_consultant_id\` int(11) DEFAULT NULL,
  \`is_active\` tinyint(1) NOT NULL DEFAULT 1,
  \`project_id\` int(11) DEFAULT NULL,
  PRIMARY KEY (\`id\`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

DROP TABLE IF EXISTS \`round_consultants\`;
CREATE TABLE \`round_consultants\` (
  \`round_id\` int(11) NOT NULL,
  \`consultant_id\` int(11) NOT NULL,
  \`is_active\` tinyint(1) NOT NULL DEFAULT 1,
  \`receive_ratio\` int(11) DEFAULT 1,
  \`skip_count\` int(11) DEFAULT 0,
  \`compensation_count\` int(11) DEFAULT 0,
  \`data_per_turn\` int(11) DEFAULT 1,
  \`current_turn_remaining\` int(11) DEFAULT 0,
  \`skipped_credit\` int(11) DEFAULT 0
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

DROP TABLE IF EXISTS \`routing_rules\`;
CREATE TABLE \`routing_rules\` (
  \`id\` int(11) NOT NULL AUTO_INCREMENT,
  \`connection_id\` varchar(255) DEFAULT NULL,
  \`target_round_id\` int(11) DEFAULT NULL,
  \`condition_column\` varchar(100) DEFAULT NULL,
  \`condition_operator\` varchar(50) DEFAULT NULL,
  \`condition_value\` varchar(255) DEFAULT NULL,
  \`priority\` int(11) DEFAULT 0,
  \`conditions_json\` longtext DEFAULT NULL,
  \`logical_operator\` varchar(10) DEFAULT 'AND',
  PRIMARY KEY (\`id\`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

DROP TABLE IF EXISTS \`subscribers\`;
CREATE TABLE \`subscribers\` (
  \`id\` char(36) NOT NULL,
  \`contact_id\` int(11) DEFAULT NULL,
  \`person_id\` int(11) DEFAULT NULL,
  \`phone_norm9\` varchar(20) DEFAULT NULL,
  \`email_norm\` varchar(255) DEFAULT NULL,
  \`email\` varchar(255) DEFAULT NULL,
  \`first_name\` varchar(150) DEFAULT NULL,
  \`last_name\` varchar(150) DEFAULT NULL,
  \`gender\` varchar(30) DEFAULT NULL,
  \`status\` varchar(50) DEFAULT 'subscribed',
  \`source\` varchar(150) DEFAULT NULL,
  \`salesperson\` varchar(150) DEFAULT NULL,
  \`phone_number\` varchar(50) DEFAULT NULL,
  \`phone\` varchar(50) DEFAULT NULL,
  \`job_title\` varchar(150) DEFAULT NULL,
  \`company_name\` varchar(255) DEFAULT NULL,
  \`country\` varchar(100) DEFAULT NULL,
  \`city\` varchar(100) DEFAULT NULL,
  \`timezone\` varchar(50) DEFAULT NULL,
  \`address\` text DEFAULT NULL,
  \`date_of_birth\` date DEFAULT NULL,
  \`anniversary_date\` date DEFAULT NULL,
  \`notes\` text DEFAULT NULL,
  \`last_activity_at\` datetime DEFAULT NULL,
  \`tags\` text DEFAULT NULL,
  \`custom_attributes\` longtext DEFAULT NULL,
  \`stats_sent\` int(11) DEFAULT 0,
  \`stats_opened\` int(11) DEFAULT 0,
  \`stats_clicked\` int(11) DEFAULT 0,
  \`last_open_at\` datetime DEFAULT NULL,
  \`last_click_at\` datetime DEFAULT NULL,
  \`joined_at\` datetime DEFAULT NULL,
  \`updated_at\` datetime DEFAULT NULL,
  \`deleted_at\` datetime DEFAULT NULL,
  \`zalo_user_id\` varchar(100) DEFAULT NULL,
  \`is_zalo_follower\` tinyint(1) DEFAULT 0,
  \`meta_psid\` varchar(100) DEFAULT NULL,
  \`lead_score\` int(11) DEFAULT 0,
  \`verified\` tinyint(1) DEFAULT 0,
  \`avatar\` text DEFAULT NULL,
  \`last_os\` varchar(50) DEFAULT NULL,
  \`last_device\` varchar(50) DEFAULT NULL,
  \`last_browser\` varchar(50) DEFAULT NULL,
  \`last_city\` varchar(100) DEFAULT NULL,
  \`last_country\` varchar(100) DEFAULT NULL,
  \`property_id\` int(11) DEFAULT NULL,
  \`last_ip\` varchar(64) DEFAULT NULL,
  \`workspace_id\` int(11) DEFAULT 1,
  \`created_at\` datetime DEFAULT NULL,
  \`created_by\` int(11) DEFAULT NULL,
  \`updated_by\` int(11) DEFAULT NULL,
  \`owner_id\` int(11) DEFAULT NULL,
  \`program\` varchar(255) DEFAULT NULL,
  \`stage_id\` int(11) DEFAULT NULL,
  \`pipeline_status\` varchar(100) DEFAULT NULL,
  \`lead_status\` varchar(50) DEFAULT NULL,
  \`district\` varchar(100) DEFAULT NULL,
  \`ward\` varchar(100) DEFAULT NULL,
  \`temperature\` varchar(30) DEFAULT NULL,
  \`last_send_at\` datetime DEFAULT NULL,
  PRIMARY KEY (\`id\`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

DROP TABLE IF EXISTS \`lists\`;
CREATE TABLE \`lists\` (
  \`id\` char(36) NOT NULL,
  \`name\` varchar(255) NOT NULL,
  \`source\` varchar(100) DEFAULT NULL,
  \`type\` enum('static','sync') DEFAULT 'static',
  \`subscriber_count\` int(11) DEFAULT 0,
  \`phone_count\` int(11) DEFAULT 0,
  \`created_at\` datetime DEFAULT NULL,
  \`updated_at\` datetime DEFAULT NULL,
  \`deleted_at\` datetime DEFAULT NULL,
  \`workspace_id\` int(11) DEFAULT 1,
  \`created_by\` int(11) DEFAULT NULL,
  \`updated_by\` int(11) DEFAULT NULL,
  PRIMARY KEY (\`id\`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

DROP TABLE IF EXISTS \`subscriber_lists\`;
CREATE TABLE \`subscriber_lists\` (
  \`subscriber_id\` char(36) NOT NULL,
  \`list_id\` char(36) NOT NULL,
  \`workspace_id\` int(11) DEFAULT 1
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

DROP TABLE IF EXISTS \`segments\`;
CREATE TABLE \`segments\` (
  \`id\` char(36) NOT NULL,
  \`tenant_id\` int(11) DEFAULT 1,
  \`created_by\` int(11) DEFAULT NULL,
  \`name\` varchar(255) NOT NULL,
  \`entity_type\` varchar(50) DEFAULT 'subscriber',
  \`filters\` longtext DEFAULT NULL,
  \`is_shared\` tinyint(1) DEFAULT 0,
  \`created_at\` datetime DEFAULT NULL,
  \`description\` text DEFAULT NULL,
  \`criteria\` longtext DEFAULT NULL,
  \`subscriber_count\` int(11) DEFAULT 0,
  \`phone_count\` int(11) DEFAULT 0,
  \`auto_cleanup_days\` int(11) DEFAULT NULL,
  \`updated_at\` datetime DEFAULT NULL,
  \`deleted_at\` datetime DEFAULT NULL,
  \`ai_analysis\` longtext DEFAULT NULL,
  \`ai_analysis_at\` datetime DEFAULT NULL,
  \`synced_at\` datetime DEFAULT NULL,
  \`notify_on_join\` tinyint(1) DEFAULT 0,
  \`notify_subject\` varchar(255) DEFAULT NULL,
  \`notify_email\` varchar(255) DEFAULT NULL,
  \`notify_cc\` varchar(255) DEFAULT NULL,
  \`workspace_id\` int(11) DEFAULT 1,
  \`updated_by\` int(11) DEFAULT NULL,
  \`conditions\` longtext DEFAULT NULL,
  PRIMARY KEY (\`id\`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

DROP TABLE IF EXISTS \`templates\`;
CREATE TABLE \`templates\` (
  \`id\` char(36) NOT NULL,
  \`name\` varchar(255) NOT NULL,
  \`thumbnail\` text DEFAULT NULL,
  \`category\` varchar(100) DEFAULT NULL,
  \`group_id\` varchar(64) DEFAULT NULL,
  \`blocks\` longtext DEFAULT NULL,
  \`body_style\` longtext DEFAULT NULL,
  \`html_content\` longtext DEFAULT NULL,
  \`created_at\` datetime DEFAULT NULL,
  \`updated_at\` datetime DEFAULT NULL,
  \`type\` varchar(50) DEFAULT 'email',
  \`subject\` varchar(255) DEFAULT NULL,
  \`workspace_id\` int(11) DEFAULT 1,
  \`created_by\` int(11) DEFAULT NULL,
  \`updated_by\` int(11) DEFAULT NULL,
  \`visibility\` varchar(50) DEFAULT 'workspace',
  \`access_config\` longtext DEFAULT NULL,
  PRIMARY KEY (\`id\`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

DROP TABLE IF EXISTS \`campaigns\`;
CREATE TABLE \`campaigns\` (
  \`id\` char(36) NOT NULL,
  \`name\` varchar(255) NOT NULL,
  \`subject\` varchar(255) DEFAULT NULL,
  \`preheader_text\` varchar(255) DEFAULT NULL,
  \`sender_email\` varchar(255) DEFAULT NULL,
  \`sender_name\` varchar(255) DEFAULT NULL,
  \`reply_to\` varchar(255) DEFAULT NULL,
  \`status\` enum('draft','scheduled','sending','sent','archived','waiting_flow','paused') DEFAULT 'draft',
  \`type\` enum('regular','email','zalo_zns','ab_testing','autoresponder') DEFAULT 'regular',
  \`config\` longtext DEFAULT NULL,
  \`template_id\` char(36) DEFAULT NULL,
  \`content_body\` longtext DEFAULT NULL,
  \`target_config\` longtext DEFAULT NULL,
  \`scheduled_at\` datetime DEFAULT NULL,
  \`timezone\` varchar(50) DEFAULT 'Asia/Ho_Chi_Minh',
  \`sent_at\` datetime DEFAULT NULL,
  \`tracking_enabled\` tinyint(1) DEFAULT 1,
  \`count_sent\` int(11) DEFAULT 0,
  \`count_opened\` int(11) DEFAULT 0,
  \`count_unique_opened\` int(11) DEFAULT 0,
  \`count_clicked\` int(11) DEFAULT 0,
  \`count_unique_clicked\` int(11) DEFAULT 0,
  \`count_bounced\` int(11) DEFAULT 0,
  \`count_spam\` int(11) DEFAULT 0,
  \`count_unsubscribed\` int(11) DEFAULT 0,
  \`created_at\` datetime DEFAULT NULL,
  \`updated_at\` datetime DEFAULT NULL,
  \`is_deleted\` tinyint(1) DEFAULT 0,
  \`attachments\` longtext DEFAULT NULL,
  \`total_target_audience\` int(11) DEFAULT 0,
  \`stat_opens\` int(11) DEFAULT 0,
  \`stat_clicks\` int(11) DEFAULT 0,
  \`stat_device_mobile\` int(11) DEFAULT 0,
  \`stat_device_desktop\` int(11) DEFAULT 0,
  \`stats\` longtext DEFAULT NULL,
  \`workspace_id\` int(11) DEFAULT 1,
  \`created_by\` int(11) DEFAULT NULL,
  \`updated_by\` int(11) DEFAULT NULL,
  \`deleted_at\` datetime DEFAULT NULL,
  PRIMARY KEY (\`id\`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

DROP TABLE IF EXISTS \`flows\`;
CREATE TABLE \`flows\` (
  \`id\` char(36) NOT NULL,
  \`name\` varchar(255) NOT NULL,
  \`description\` text DEFAULT NULL,
  \`status\` enum('active','paused','draft','archived') DEFAULT 'draft',
  \`steps\` longtext DEFAULT NULL,
  \`config\` longtext DEFAULT NULL,
  \`stat_enrolled\` int(11) DEFAULT 0,
  \`stat_completed\` int(11) DEFAULT 0,
  \`stat_open_rate\` decimal(5,2) DEFAULT 0.00,
  \`stat_click_rate\` decimal(5,2) DEFAULT 0.00,
  \`stat_total_sent\` int(11) DEFAULT 0,
  \`stat_total_opened\` int(11) DEFAULT 0,
  \`stat_unique_opened\` int(11) DEFAULT 0,
  \`stat_total_clicked\` int(11) DEFAULT 0,
  \`stat_unique_clicked\` int(11) DEFAULT 0,
  \`stat_total_zalo_clicked\` int(11) DEFAULT 0,
  \`stat_unique_zalo_clicked\` int(11) DEFAULT 0,
  \`stat_total_failed\` int(11) DEFAULT 0,
  \`stat_total_unsubscribed\` int(11) DEFAULT 0,
  \`archived_at\` datetime DEFAULT NULL,
  \`deleted_at\` datetime DEFAULT NULL,
  \`created_at\` datetime DEFAULT NULL,
  \`updated_at\` datetime DEFAULT NULL,
  \`stat_zns_sent\` int(11) DEFAULT 0,
  \`stat_zns_failed\` int(11) DEFAULT 0,
  \`trigger_type\` varchar(100) DEFAULT NULL,
  \`stat_zalo_sent\` int(11) DEFAULT 0,
  \`workspace_id\` int(11) DEFAULT 1,
  \`stat_meta_sent\` int(11) DEFAULT 0,
  \`created_by\` int(11) DEFAULT NULL,
  \`updated_by\` int(11) DEFAULT NULL,
  PRIMARY KEY (\`id\`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

DROP TABLE IF EXISTS \`forms\`;
CREATE TABLE \`forms\` (
  \`id\` char(36) NOT NULL,
  \`tenant_id\` int(11) DEFAULT 1,
  \`name\` varchar(255) NOT NULL,
  \`schema\` longtext DEFAULT NULL,
  \`mapping\` longtext DEFAULT NULL,
  \`embed_token\` varchar(100) DEFAULT NULL,
  \`is_active\` tinyint(1) DEFAULT 1,
  \`submit_count\` int(11) DEFAULT 0,
  \`created_by\` int(11) DEFAULT NULL,
  \`created_at\` datetime DEFAULT NULL,
  \`deleted_at\` datetime DEFAULT NULL,
  \`status\` enum('active','inactive') DEFAULT 'active',
  \`target_list_id\` char(36) DEFAULT NULL,
  \`fields_json\` longtext DEFAULT NULL,
  \`notification_enabled\` tinyint(1) DEFAULT 0,
  \`notification_emails\` text DEFAULT NULL,
  \`notification_cc_emails\` text DEFAULT NULL,
  \`notification_subject\` varchar(255) DEFAULT NULL,
  \`workspace_id\` int(11) DEFAULT 1,
  \`updated_by\` int(11) DEFAULT NULL,
  PRIMARY KEY (\`id\`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

DROP TABLE IF EXISTS \`surveys\`;
CREATE TABLE \`surveys\` (
  \`id\` char(36) NOT NULL,
  \`workspace_id\` int(11) DEFAULT 1,
  \`name\` varchar(255) NOT NULL,
  \`slug\` varchar(150) NOT NULL,
  \`status\` enum('draft','active','paused','closed') DEFAULT 'active',
  \`cover_style\` longtext DEFAULT NULL,
  \`blocks_json\` longtext DEFAULT NULL,
  \`settings_json\` longtext DEFAULT NULL,
  \`thank_you_page\` longtext DEFAULT NULL,
  \`target_list_id\` char(36) DEFAULT NULL,
  \`flow_trigger_id\` char(36) DEFAULT NULL,
  \`response_limit\` int(11) DEFAULT NULL,
  \`close_at\` datetime DEFAULT NULL,
  \`require_login\` tinyint(1) DEFAULT 0,
  \`allow_anonymous\` tinyint(1) DEFAULT 1,
  \`one_per_email\` tinyint(1) DEFAULT 0,
  \`created_by\` int(11) DEFAULT NULL,
  \`created_at\` datetime DEFAULT NULL,
  \`updated_at\` datetime DEFAULT NULL,
  \`deleted_at\` datetime DEFAULT NULL,
  \`updated_by\` int(11) DEFAULT NULL,
  PRIMARY KEY (\`id\`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

DROP TABLE IF EXISTS \`short_links\`;
CREATE TABLE \`short_links\` (
  \`id\` varchar(36) NOT NULL,
  \`workspace_id\` varchar(36) DEFAULT '1',
  \`name\` varchar(255) NOT NULL,
  \`slug\` varchar(100) NOT NULL,
  \`target_url\` text NOT NULL,
  \`is_survey_checkin\` tinyint(1) DEFAULT 0,
  \`survey_id\` char(36) DEFAULT NULL,
  \`status\` varchar(30) DEFAULT 'active',
  \`access_pin\` varchar(30) DEFAULT NULL,
  \`submit_count\` int(11) DEFAULT 0,
  \`qr_config_json\` longtext DEFAULT NULL,
  \`created_at\` datetime DEFAULT NULL,
  \`utm_source\` varchar(100) DEFAULT NULL,
  \`utm_medium\` varchar(100) DEFAULT NULL,
  \`utm_campaign\` varchar(100) DEFAULT NULL,
  \`created_by\` int(11) DEFAULT NULL,
  \`updated_by\` int(11) DEFAULT NULL,
  \`is_deleted\` tinyint(1) DEFAULT 0,
  \`deleted_at\` datetime DEFAULT NULL,
  PRIMARY KEY (\`id\`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

DROP TABLE IF EXISTS \`web_properties\`;
CREATE TABLE \`web_properties\` (
  \`id\` int(11) NOT NULL AUTO_INCREMENT,
  \`workspace_id\` int(10) unsigned NOT NULL DEFAULT 1,
  \`name\` varchar(255) NOT NULL,
  \`domain\` varchar(255) NOT NULL,
  \`settings\` longtext DEFAULT NULL,
  \`created_at\` datetime DEFAULT NULL,
  \`status\` varchar(30) DEFAULT 'active',
  \`api_key\` varchar(150) DEFAULT NULL,
  \`created_by\` int(11) DEFAULT NULL,
  \`updated_by\` int(11) DEFAULT NULL,
  \`is_deleted\` tinyint(1) DEFAULT 0,
  \`deleted_at\` datetime DEFAULT NULL,
  PRIMARY KEY (\`id\`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

DROP TABLE IF EXISTS \`mail_queue\`;
CREATE TABLE \`mail_queue\` (
  \`id\` int(11) NOT NULL AUTO_INCREMENT,
  \`to_email\` varchar(255) NOT NULL,
  \`cc_email\` varchar(255) DEFAULT NULL,
  \`subject\` varchar(500) DEFAULT NULL,
  \`body_html\` longtext DEFAULT NULL,
  \`status\` enum('pending','processing','sent','failed') DEFAULT 'pending',
  \`created_at\` datetime DEFAULT NULL,
  \`sent_at\` datetime DEFAULT NULL,
  \`attempts\` int(11) DEFAULT 0,
  \`last_error\` text DEFAULT NULL,
  \`lead_id\` int(11) DEFAULT NULL,
  \`updated_at\` datetime DEFAULT NULL,
  PRIMARY KEY (\`id\`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

DROP TABLE IF EXISTS \`subscriber_flow_states\`;
CREATE TABLE \`subscriber_flow_states\` (
  \`id\` int(11) NOT NULL AUTO_INCREMENT,
  \`workspace_id\` int(11) DEFAULT 1,
  \`contact_id\` int(11) DEFAULT NULL,
  \`subscriber_id\` char(36) DEFAULT NULL,
  \`flow_id\` char(36) DEFAULT NULL,
  \`step_id\` varchar(100) DEFAULT NULL,
  \`step_type\` varchar(50) DEFAULT NULL,
  \`status\` enum('waiting','processing','completed','failed','unsubscribed','cancelled') DEFAULT 'waiting',
  \`scheduled_at\` datetime DEFAULT NULL,
  \`waiting_until\` datetime DEFAULT NULL,
  \`branch_taken\` varchar(100) DEFAULT NULL,
  \`last_error\` text DEFAULT NULL,
  \`created_at\` datetime DEFAULT NULL,
  \`updated_at\` datetime DEFAULT NULL,
  \`last_step_at\` datetime DEFAULT NULL,
  PRIMARY KEY (\`id\`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

DROP TABLE IF EXISTS \`contact_meta_attribution\`;
CREATE TABLE \`contact_meta_attribution\` (
  \`id\` int(11) NOT NULL AUTO_INCREMENT,
  \`contact_id\` int(11) DEFAULT NULL,
  \`tenant_id\` int(11) DEFAULT 1,
  \`meta_lead_id\` varchar(100) DEFAULT NULL,
  \`ad_id\` varchar(100) DEFAULT NULL,
  \`ad_name\` varchar(255) DEFAULT NULL,
  \`adset_id\` varchar(100) DEFAULT NULL,
  \`adset_name\` varchar(255) DEFAULT NULL,
  \`campaign_id\` varchar(100) DEFAULT NULL,
  \`campaign_name\` varchar(255) DEFAULT NULL,
  \`form_id\` varchar(100) DEFAULT NULL,
  \`form_name\` varchar(255) DEFAULT NULL,
  \`platform\` varchar(50) DEFAULT NULL,
  \`fbc\` text DEFAULT NULL,
  \`fbp\` text DEFAULT NULL,
  \`client_ip_address\` varchar(64) DEFAULT NULL,
  \`client_user_agent\` text DEFAULT NULL,
  \`event_source_url\` text DEFAULT NULL,
  \`fb_pixel_id\` varchar(100) DEFAULT NULL,
  \`is_organic\` tinyint(1) DEFAULT 0,
  \`lead_created_time\` datetime DEFAULT NULL,
  \`raw_lead_status\` varchar(50) DEFAULT NULL,
  \`priority\` int(11) DEFAULT 0,
  \`sheet_source\` varchar(255) DEFAULT NULL,
  \`degree\` varchar(100) DEFAULT NULL,
  \`english_work_exp\` varchar(100) DEFAULT NULL,
  \`consultation_time\` varchar(150) DEFAULT NULL,
  \`program_interest\` varchar(255) DEFAULT NULL,
  \`form_answers_json\` longtext DEFAULT NULL,
  \`created_at\` datetime DEFAULT NULL,
  \`updated_at\` datetime DEFAULT NULL,
  \`deleted_at\` datetime DEFAULT NULL,
  PRIMARY KEY (\`id\`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

DROP TABLE IF EXISTS \`capi_logs\`;
CREATE TABLE \`capi_logs\` (
  \`id\` int(11) NOT NULL AUTO_INCREMENT,
  \`lead_id\` int(11) DEFAULT NULL,
  \`meta_lead_id\` varchar(100) DEFAULT NULL,
  \`contact_id\` int(11) DEFAULT NULL,
  \`pixel_id\` varchar(100) DEFAULT NULL,
  \`event_name\` varchar(100) DEFAULT NULL,
  \`action_source\` varchar(50) DEFAULT NULL,
  \`payload_hash\` varchar(128) DEFAULT NULL,
  \`event_id\` varchar(150) DEFAULT NULL,
  \`trigger_stage\` varchar(100) DEFAULT NULL,
  \`trigger_mode\` varchar(50) DEFAULT NULL,
  \`event_value\` decimal(15,2) DEFAULT NULL,
  \`emq_signals\` int(11) DEFAULT 0,
  \`sent_payload\` longtext DEFAULT NULL,
  \`response_status\` int(11) DEFAULT NULL,
  \`response_body\` longtext DEFAULT NULL,
  \`sent_at\` datetime DEFAULT NULL,
  \`full_name\` varchar(255) DEFAULT NULL,
  PRIMARY KEY (\`id\`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

DROP TABLE IF EXISTS \`capi_blocked_phones\`;
CREATE TABLE \`capi_blocked_phones\` (
  \`id\` int(11) NOT NULL AUTO_INCREMENT,
  \`tenant_id\` int(11) DEFAULT 1,
  \`phone_normalized\` varchar(50) NOT NULL,
  \`source_label\` varchar(150) DEFAULT NULL,
  \`reason\` varchar(150) DEFAULT NULL,
  \`created_by\` int(11) DEFAULT NULL,
  \`created_at\` datetime DEFAULT NULL,
  \`deleted_at\` datetime DEFAULT NULL,
  PRIMARY KEY (\`id\`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

DROP TABLE IF EXISTS \`meta_app_configs\`;
CREATE TABLE \`meta_app_configs\` (
  \`id\` int(11) NOT NULL AUTO_INCREMENT,
  \`page_name\` varchar(255) DEFAULT NULL,
  \`page_id\` varchar(100) DEFAULT NULL,
  \`app_id\` varchar(100) DEFAULT NULL,
  \`page_access_token\` text DEFAULT NULL,
  \`app_secret\` varchar(255) DEFAULT NULL,
  \`verify_token\` varchar(255) DEFAULT NULL,
  \`avatar_url\` text DEFAULT NULL,
  \`status\` enum('active','inactive','disconnected') DEFAULT 'active',
  \`mode\` enum('live','dev') DEFAULT 'live',
  \`created_at\` datetime DEFAULT NULL,
  \`updated_at\` datetime DEFAULT NULL,
  \`token_expires_at\` datetime DEFAULT NULL,
  \`workspace_id\` int(11) DEFAULT 1,
  PRIMARY KEY (\`id\`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

DROP TABLE IF EXISTS \`system_settings\`;
CREATE TABLE \`system_settings\` (
  \`setting_key\` varchar(100) NOT NULL,
  \`setting_value\` mediumtext DEFAULT NULL,
  PRIMARY KEY (\`setting_key\`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

DROP TABLE IF EXISTS \`mkt_system_settings\`;
CREATE TABLE \`mkt_system_settings\` (
  \`workspace_id\` int(11) NOT NULL DEFAULT 1,
  \`key\` varchar(100) NOT NULL,
  \`value\` longtext DEFAULT NULL,
  \`updated_at\` datetime DEFAULT NULL,
  PRIMARY KEY (\`workspace_id\`,\`key\`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

DROP TABLE IF EXISTS \`verified_senders\`;
CREATE TABLE \`verified_senders\` (
  \`id\` int(11) NOT NULL AUTO_INCREMENT,
  \`workspace_id\` int(11) DEFAULT 1,
  \`email\` varchar(255) NOT NULL,
  \`name\` varchar(255) DEFAULT NULL,
  \`reply_to\` varchar(255) DEFAULT NULL,
  \`is_verified\` tinyint(1) DEFAULT 1,
  \`is_default\` tinyint(1) DEFAULT 0,
  \`created_at\` datetime DEFAULT NULL,
  PRIMARY KEY (\`id\`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

DROP TABLE IF EXISTS \`zalo_oa_configs\`;
CREATE TABLE \`zalo_oa_configs\` (
  \`id\` int(11) NOT NULL AUTO_INCREMENT,
  \`workspace_id\` int(11) DEFAULT 1,
  \`name\` varchar(255) DEFAULT NULL,
  \`avatar\` text DEFAULT NULL,
  \`oa_id\` varchar(100) DEFAULT NULL,
  \`app_id\` varchar(100) DEFAULT NULL,
  \`app_secret\` varchar(255) DEFAULT NULL,
  \`pkce_verifier\` varchar(255) DEFAULT NULL,
  \`access_token\` text DEFAULT NULL,
  \`refresh_token\` text DEFAULT NULL,
  \`token_expires_at\` datetime DEFAULT NULL,
  \`token_status\` varchar(50) DEFAULT NULL,
  \`last_token_check\` datetime DEFAULT NULL,
  \`daily_quota\` int(11) DEFAULT 0,
  \`quota_used_today\` int(11) DEFAULT 0,
  \`quota_reset_date\` date DEFAULT NULL,
  \`status\` varchar(30) DEFAULT 'active',
  \`created_at\` datetime DEFAULT NULL,
  \`updated_at\` datetime DEFAULT NULL,
  \`remaining_quota\` int(11) DEFAULT 0,
  \`quality_48h\` varchar(50) DEFAULT NULL,
  \`quality_7d\` varchar(50) DEFAULT NULL,
  \`updated_at_quota\` datetime DEFAULT NULL,
  \`monthly_promo_quota\` int(11) DEFAULT 0,
  \`remaining_promo_quota\` int(11) DEFAULT 0,
  PRIMARY KEY (\`id\`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

DROP TABLE IF EXISTS \`zalo_queue\`;
CREATE TABLE \`zalo_queue\` (
  \`id\` int(11) NOT NULL AUTO_INCREMENT,
  \`bot_token\` varchar(255) DEFAULT NULL,
  \`chat_id\` varchar(100) DEFAULT NULL,
  \`body_text\` text DEFAULT NULL,
  \`status\` varchar(30) DEFAULT 'pending',
  \`created_at\` datetime DEFAULT NULL,
  \`sent_at\` datetime DEFAULT NULL,
  \`attempts\` int(11) DEFAULT 0,
  \`last_error\` text DEFAULT NULL,
  \`lead_id\` int(11) DEFAULT NULL,
  \`updated_at\` datetime DEFAULT NULL,
  PRIMARY KEY (\`id\`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

DROP TABLE IF EXISTS \`zalo_subscribers\`;
CREATE TABLE \`zalo_subscribers\` (
  \`id\` char(36) NOT NULL,
  \`contact_id\` int(11) DEFAULT NULL,
  \`zalo_list_id\` char(36) DEFAULT NULL,
  \`zalo_user_id\` varchar(100) DEFAULT NULL,
  \`oa_id\` varchar(100) DEFAULT NULL,
  \`subscriber_id\` char(36) DEFAULT NULL,
  \`display_name\` varchar(255) DEFAULT NULL,
  \`avatar\` text DEFAULT NULL,
  \`phone_number\` varchar(50) DEFAULT NULL,
  \`gender\` varchar(30) DEFAULT NULL,
  \`birthday\` date DEFAULT NULL,
  \`special_day\` date DEFAULT NULL,
  \`manual_email\` varchar(255) DEFAULT NULL,
  \`notes\` text DEFAULT NULL,
  \`status\` varchar(30) DEFAULT 'active',
  \`lead_score\` int(11) DEFAULT 0,
  \`is_follower\` tinyint(1) DEFAULT 1,
  \`last_interaction_at\` datetime DEFAULT NULL,
  \`joined_at\` datetime DEFAULT NULL,
  \`updated_at\` datetime DEFAULT NULL,
  \`ai_paused_until\` datetime DEFAULT NULL,
  \`workspace_id\` int(11) DEFAULT 1,
  PRIMARY KEY (\`id\`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
`;

const EXTRA_ZALO_TABLES_DDL = `
DROP TABLE IF EXISTS \`zalo_activity_buffer\`;
CREATE TABLE \`zalo_activity_buffer\` (
  \`id\` int(11) NOT NULL AUTO_INCREMENT,
  \`workspace_id\` int(11) DEFAULT 1,
  \`payload\` text DEFAULT NULL,
  PRIMARY KEY (\`id\`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

DROP TABLE IF EXISTS \`zalo_automation_scenarios\`;
CREATE TABLE \`zalo_automation_scenarios\` (
  \`id\` char(36) NOT NULL,
  \`workspace_id\` int(11) DEFAULT 1,
  \`name\` varchar(255) DEFAULT NULL,
  \`status\` varchar(30) DEFAULT 'active',
  PRIMARY KEY (\`id\`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

DROP TABLE IF EXISTS \`zalo_broadcast_tracking\`;
CREATE TABLE \`zalo_broadcast_tracking\` (
  \`id\` int(11) NOT NULL AUTO_INCREMENT,
  \`broadcast_id\` char(36) DEFAULT NULL,
  \`zalo_user_id\` varchar(100) DEFAULT NULL,
  PRIMARY KEY (\`id\`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

DROP TABLE IF EXISTS \`zalo_broadcasts\`;
CREATE TABLE \`zalo_broadcasts\` (
  \`id\` char(36) NOT NULL,
  \`workspace_id\` int(11) DEFAULT 1,
  \`name\` varchar(255) DEFAULT NULL,
  PRIMARY KEY (\`id\`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

DROP TABLE IF EXISTS \`zalo_delivery_logs\`;
CREATE TABLE \`zalo_delivery_logs\` (
  \`id\` int(11) NOT NULL AUTO_INCREMENT,
  \`workspace_id\` int(11) DEFAULT 1,
  \`template_id\` varchar(100) DEFAULT NULL,
  \`status\` varchar(50) DEFAULT NULL,
  PRIMARY KEY (\`id\`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

DROP TABLE IF EXISTS \`zalo_lists\`;
CREATE TABLE \`zalo_lists\` (
  \`id\` char(36) NOT NULL,
  \`workspace_id\` int(11) DEFAULT 1,
  \`name\` varchar(255) DEFAULT NULL,
  PRIMARY KEY (\`id\`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

DROP TABLE IF EXISTS \`zalo_message_queue\`;
CREATE TABLE \`zalo_message_queue\` (
  \`id\` int(11) NOT NULL AUTO_INCREMENT,
  \`workspace_id\` int(11) DEFAULT 1,
  \`status\` varchar(30) DEFAULT 'pending',
  \`payload\` text DEFAULT NULL,
  PRIMARY KEY (\`id\`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

DROP TABLE IF EXISTS \`zalo_subscriber_activity\`;
CREATE TABLE \`zalo_subscriber_activity\` (
  \`id\` int(11) NOT NULL AUTO_INCREMENT,
  \`workspace_id\` int(11) DEFAULT 1,
  \`subscriber_id\` char(36) DEFAULT NULL,
  PRIMARY KEY (\`id\`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

DROP TABLE IF EXISTS \`zalo_templates\`;
CREATE TABLE \`zalo_templates\` (
  \`id\` int(11) NOT NULL AUTO_INCREMENT,
  \`workspace_id\` int(11) DEFAULT 1,
  \`template_id\` varchar(100) DEFAULT NULL,
  \`name\` varchar(255) DEFAULT NULL,
  PRIMARY KEY (\`id\`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

DROP TABLE IF EXISTS \`zalo_user_messages\`;
CREATE TABLE \`zalo_user_messages\` (
  \`id\` int(11) NOT NULL AUTO_INCREMENT,
  \`workspace_id\` int(11) DEFAULT 1,
  \`message_text\` text DEFAULT NULL,
  PRIMARY KEY (\`id\`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
`;

export function buildSyntheticMyerpSql(options: SyntheticMyerpOptions = {}): SyntheticMyerpResult {
  const ownsDir = !options.dir;
  const dir = options.dir ? path.resolve(options.dir) : fs.mkdtempSync(path.join(os.tmpdir(), 'e2e-ideas-myerp-'));
  fs.mkdirSync(dir, { recursive: true });
  const sqlPath = path.join(dir, options.fileName || 'synthetic_myerp_backup.sql');

  const nowTs = '2026-11-17 08:30:00';
  const multilineNote = options.includeMultilineStrings !== false ? 'Program: MBA Online\nDegree: Bachelor' : 'Program: MBA Online';

  const tenantsRows: Array<Record<string, unknown>> = [
    {
      id: 1,
      name: 'IDEAS ERP',
      slug: 'ideas',
      plan: 'enterprise',
      logo_url: 'https://automation.ideas.edu.vn/uploadss/ideas-logo.png',
      primary_color: '#BD1D2D',
      currency: 'VND',
      timezone: 'Asia/Ho_Chi_Minh',
      is_active: 1,
      created_at: '2026-07-27 06:34:23',
      updated_at: '2026-07-27 06:34:23',
    },
    {
      id: 99999,
      name: 'Test E2E Tenant 99999',
      slug: 'test-e2e-99999',
      plan: 'free',
      logo_url: null,
      primary_color: '#BD1D2D',
      currency: 'VND',
      timezone: 'Asia/Ho_Chi_Minh',
      is_active: 1,
      created_at: '2026-11-13 19:43:02',
      updated_at: '2026-11-13 19:43:02',
    },
  ];

  const bakActivitiesRows = [
    {
      id: 1,
      tenant_id: 1,
      user_id: 1004,
      created_by: 1001,
      type: 'note',
      subject: 'Backup activity row',
      body: 'Should never be migrated from _bak_activities_20260913',
      status: 'done',
      priority: 'medium',
      related_type: 'contact',
      related_id: 100001,
      contact_id: 100001,
      progress: 0,
      require_approval: 0,
      created_at: '2025-04-11 05:00:00',
      updated_at: '2025-04-11 05:00:00',
    },
  ];

  const bakDepositsRows = [
    {
      id: 1,
      contact_id: 100001,
      project_id: 1,
      unit_code: 'MBA-2026-K18A',
      price: 45000000,
      expected_commission: 4500000,
      status: 'approved',
      created_by: 1001,
      created_at: '2026-08-06 08:00:48',
      updated_at: '2026-08-06 08:37:45',
      auto_remind: 1,
      remind_days_before: 3,
      remind_at_hour: 8,
      remind_target: 1,
      notes: 'Backup deposit row',
      currency: 'VND',
      exchange_rate: 1,
    },
  ];

  const usersRows: Array<Record<string, unknown>> = [
    {
      id: 1001,
      tenant_id: 1,
      username: 'admin_ideas',
      email: 'admin.ideas@test-sink.domation.local',
      password_hash: '$2b$10$syntheticHashValueForMigrationTestsOnly000000000000',
      full_name: 'IDEAS Admin',
      job_title: 'Director',
      phone: '0909111222',
      role: 'admin',
      department: 'Management',
      is_active: 1,
      two_factor_enabled: 0,
      two_factor_type: 'email',
      status: 'active',
      vacation_mode: 0,
      work_start_time: '08:00',
      work_end_time: '22:00',
      is_confirmed: 1,
      created_at: nowTs,
      updated_at: nowTs,
      overtime_mode: 0,
      manager_behavior_mode: 'combined',
      use_custom_work_hours: 0,
    },
    {
      id: 1004,
      tenant_id: 1,
      username: 'sales_ideas',
      email: 'sales.ideas@test-sink.domation.local',
      password_hash: '$2b$10$syntheticHashValueForMigrationTestsOnly000000000000',
      full_name: 'Nguyen Phuong Uyen',
      job_title: 'Admissions Consultant',
      phone: '0909333444',
      role: 'sales',
      department: 'Admissions',
      is_active: 1,
      two_factor_enabled: 0,
      two_factor_type: 'email',
      status: 'active',
      vacation_mode: 0,
      work_start_time: '08:00',
      work_end_time: '22:00',
      is_confirmed: 1,
      created_at: nowTs,
      updated_at: nowTs,
      overtime_mode: 0,
      manager_behavior_mode: 'combined',
      use_custom_work_hours: 0,
    },
    {
      id: 99901,
      tenant_id: 99999,
      username: 'junk_99999',
      email: 'junk99999@test-sink.domation.local',
      full_name: 'Test 99999 User',
      role: 'sales',
      is_active: 1,
      two_factor_enabled: 0,
      status: 'active',
      vacation_mode: 0,
      is_confirmed: 1,
      created_at: nowTs,
      updated_at: nowTs,
      overtime_mode: 0,
      use_custom_work_hours: 0,
    },
  ];

  const contactsRows: Array<Record<string, unknown>> = [
    {
      id: 100001,
      tenant_id: 1,
      owner_id: 1004,
      created_by: 1001,
      full_name: 'Tran Minh Khoa',
      email: 'khoa.mba@test-sink.domation.local',
      phone: '0912000111',
      source: 'Facebook Ads - Form',
      status: 'qualified',
      pipeline_status: 'qualified',
      temperature: 'hot',
      total_spent: 0,
      order_count: 0,
      lead_score: 85,
      stage_id: 31,
      ttl1_completed: 1,
      created_at: nowTs,
      updated_at: nowTs,
      parallel_assigned: 0,
      not_lead_proposed: 0,
      lead_status: 'active',
      program: 'MBA Online',
      domation_subscriber_id: 'sub-ideas-0001',
      marketing_status: 'subscribed',
      engagement_score: 70,
      stats_email_sent: 2,
      stats_email_opened: 1,
      stats_email_clicked: 1,
      web_pageviews_count: 3,
      max_scroll_depth: 80,
      active_flow_count: 1,
      survey_completed_count: 0,
      meta_lead_id: 'meta_lead_100001',
      meta_ad_id: 'ad_55001',
      meta_campaign_id: 'camp_88001',
      meta_platform: 'fb',
      is_error_ticket: 0,
    },
    {
      id: 100002,
      tenant_id: 1,
      owner_id: 1004,
      created_by: 1001,
      full_name: 'Le Thu Ha',
      email: 'ha.dba@test-sink.domation.local',
      phone: '0912000222',
      source: 'Landing Page',
      status: 'lead',
      pipeline_status: 'new_lead',
      temperature: 'warm',
      total_spent: 0,
      order_count: 0,
      lead_score: 45,
      stage_id: 31,
      ttl1_completed: 0,
      created_at: nowTs,
      updated_at: nowTs,
      parallel_assigned: 0,
      not_lead_proposed: 0,
      lead_status: 'active',
      program: 'DBA',
      domation_subscriber_id: 'sub-ideas-0002',
      marketing_status: 'unsubscribed',
      engagement_score: 10,
      stats_email_sent: 1,
      stats_email_opened: 0,
      stats_email_clicked: 0,
      web_pageviews_count: 0,
      max_scroll_depth: 0,
      active_flow_count: 0,
      survey_completed_count: 0,
      is_error_ticket: 0,
    },
    {
      id: 999001,
      tenant_id: 99999,
      owner_id: 99901,
      created_by: 99901,
      full_name: 'Pollution Contact 99999',
      email: 'pollution99999@test-sink.domation.local',
      phone: '0901112222',
      source: 'E2E Pollution',
      status: 'lead',
      temperature: 'cold',
      total_spent: 0,
      order_count: 0,
      lead_score: 0,
      stage_id: 31,
      ttl1_completed: 0,
      created_at: nowTs,
      updated_at: nowTs,
      parallel_assigned: 0,
      not_lead_proposed: 0,
      lead_status: 'active',
      domation_subscriber_id: 'sub-99999-0001',
      marketing_status: 'subscribed',
      engagement_score: 0,
      stats_email_sent: 0,
      stats_email_opened: 0,
      stats_email_clicked: 0,
      web_pageviews_count: 0,
      max_scroll_depth: 0,
      active_flow_count: 0,
      survey_completed_count: 0,
      is_error_ticket: 0,
    },
  ];

  const extraContacts = Math.max(0, options.extraContactsCount ?? 0);
  for (let i = 0; i < extraContacts; i++) {
    const idx = i + 3;
    contactsRows.push({
      id: 100000 + idx,
      tenant_id: 1,
      owner_id: 1004,
      created_by: 1001,
      full_name: `IDEAS Extra Contact ${idx}`,
      email: `extra.contact.${idx}@test-sink.domation.local`,
      phone: `0913${String(idx).padStart(6, '0')}`,
      source: 'Excel Import',
      status: 'lead',
      temperature: 'warm',
      total_spent: 0,
      order_count: 0,
      lead_score: 20,
      stage_id: 31,
      ttl1_completed: 0,
      created_at: nowTs,
      updated_at: nowTs,
      parallel_assigned: 0,
      not_lead_proposed: 0,
      lead_status: 'active',
      marketing_status: 'subscribed',
      engagement_score: 0,
      stats_email_sent: 0,
      stats_email_opened: 0,
      stats_email_clicked: 0,
      web_pageviews_count: 0,
      max_scroll_depth: 0,
      active_flow_count: 0,
      survey_completed_count: 0,
      is_error_ticket: 0,
    });
  }

  const leadsRows = [
    {
      id: 1,
      phone: '0912000111',
      email: 'khoa.mba@test-sink.domation.local',
      name: 'Tran Minh Khoa',
      source: 'Facebook Ads - Form',
      type: 'Webhook',
      note: multilineNote,
      campaign_id: 'camp_88001',
      campaign_name: 'MBA Fall 2026',
      ad_id: 'ad_55001',
      assigned_to: 1004,
      target_round_id: 1,
      is_accepted: 1,
      accepted_at: nowTs,
      status: 'active',
      ai_screener_status: 'passed',
      ai_attempts: 1,
      connection_id: 1,
      last_interaction_date: nowTs,
      created_at: nowTs,
      zalo_notify_status: 'none',
      email_notify_status: 'sent',
      email_notify_sent_at: nowTs,
      ai_prompt_tokens: 120,
      ai_completion_tokens: 45,
      ai_total_tokens: 165,
      telegram_notify_status: 'none',
      full_name: 'Tran Minh Khoa',
      program: 'MBA Online',
    },
    {
      id: 2,
      phone: '0912000222',
      email: 'ha.dba@test-sink.domation.local',
      name: 'Le Thu Ha',
      source: 'Landing Page',
      type: 'Form',
      note: 'Interested in DBA',
      assigned_to: 1004,
      target_round_id: 1,
      is_accepted: 0,
      status: 'active',
      ai_screener_status: 'not_screened',
      ai_attempts: 0,
      connection_id: 1,
      created_at: nowTs,
      zalo_notify_status: 'none',
      email_notify_status: 'none',
      ai_prompt_tokens: 0,
      ai_completion_tokens: 0,
      ai_total_tokens: 0,
      telegram_notify_status: 'none',
      full_name: 'Le Thu Ha',
      program: 'DBA',
    },
  ];

  const pipelineStagesRows = [
    {
      id: 31,
      tenant_id: 1,
      name: '01 - New Lead',
      color: '#f97316',
      order_index: 0,
      is_won: 0,
      is_lost: 0,
      created_at: nowTs,
      system_slug: 'new_lead',
      definition: 'Newly captured lead',
      target_goal: 'First contact within SLA',
      sales_actions: 'Call and send brochure',
      exit_criteria: 'Contacted',
    },
    {
      id: 32,
      tenant_id: 1,
      name: '02 - Enrolled Won',
      color: '#16a34a',
      order_index: 1,
      is_won: 1,
      is_lost: 0,
      created_at: nowTs,
      system_slug: 'won',
      definition: 'Tuition deposit completed',
      target_goal: 'Enrollment finalized',
      sales_actions: 'Handover to academic ops',
      exit_criteria: 'Deposit verified',
    },
  ];

  const distributionRoundsRows = [
    {
      id: 1,
      tenant_id: 1,
      round_name: 'MBA Admissions Round',
      description: 'Primary round for IDEAS MBA leads',
      cc_emails: 'admissions-cc@test-sink.domation.local',
      last_assigned_consultant_id: 1004,
      is_active: 1,
      project_id: null,
    },
  ];

  const roundConsultantsRows = [
    {
      round_id: 1,
      consultant_id: 1004,
      is_active: 1,
      receive_ratio: 1,
      skip_count: 0,
      compensation_count: 0,
      data_per_turn: 1,
      current_turn_remaining: 1,
      skipped_credit: 0,
    },
  ];

  const routingRulesRows = [
    {
      id: 1,
      connection_id: '1,2',
      target_round_id: 1,
      condition_column: 'phone',
      condition_operator: 'is_not_empty',
      condition_value: '',
      priority: 1,
      conditions_json: JSON.stringify([
        {
          conditions: [{ col: 'phone', op: 'is_not_empty', val: '' }],
          inject: { enabled: true, fields: [{ col: 'source', val: 'Facebook Ads - Form', isCustom: false }] },
        },
      ]),
      logical_operator: 'AND',
    },
  ];

  const subscribersRows: Array<Record<string, unknown>> = [
    {
      id: 'sub-ideas-0001',
      contact_id: 100001,
      phone_norm9: '912000111',
      email_norm: 'khoa.mba@test-sink.domation.local',
      email: 'khoa.mba@test-sink.domation.local',
      first_name: 'Khoa',
      last_name: 'Tran Minh',
      status: 'subscribed',
      source: 'Facebook Ads - Form',
      phone_number: '0912000111',
      phone: '0912000111',
      stats_sent: 2,
      stats_opened: 1,
      stats_clicked: 1,
      lead_score: 85,
      verified: 1,
      workspace_id: 1,
      created_at: nowTs,
      updated_at: nowTs,
      program: 'MBA Online',
      stage_id: 31,
      lead_status: 'active',
      temperature: 'hot',
    },
    {
      id: 'sub-ideas-0002',
      contact_id: 100002,
      phone_norm9: '912000222',
      email_norm: 'ha.dba@test-sink.domation.local',
      email: 'ha.dba@test-sink.domation.local',
      first_name: 'Ha',
      last_name: 'Le Thu',
      status: 'unsubscribed',
      source: 'Landing Page',
      phone_number: '0912000222',
      phone: '0912000222',
      stats_sent: 1,
      stats_opened: 0,
      stats_clicked: 0,
      lead_score: 45,
      verified: 1,
      workspace_id: 1,
      created_at: nowTs,
      updated_at: nowTs,
      program: 'DBA',
      stage_id: 31,
      lead_status: 'active',
      temperature: 'warm',
    },
    {
      id: 'sub-ideas-0003',
      contact_id: null,
      phone_norm9: '912000333',
      email_norm: 'bounced.ideas@test-sink.domation.local',
      email: 'bounced.ideas@test-sink.domation.local',
      first_name: 'Bounced',
      last_name: 'User',
      status: 'bounced',
      source: 'Import',
      phone_number: '0912000333',
      phone: '0912000333',
      stats_sent: 1,
      stats_opened: 0,
      stats_clicked: 0,
      lead_score: 0,
      verified: 0,
      workspace_id: 1,
      created_at: nowTs,
      updated_at: nowTs,
      lead_status: 'nurture',
      temperature: 'cold',
    },
    {
      id: 'sub-99999-0001',
      contact_id: 999001,
      phone_norm9: '901112222',
      email_norm: 'pollution99999@test-sink.domation.local',
      email: 'pollution99999@test-sink.domation.local',
      first_name: 'Pollution',
      last_name: 'Tenant99999',
      status: 'subscribed',
      source: 'E2E Pollution',
      phone_number: '0901112222',
      phone: '0901112222',
      workspace_id: 99999,
      created_at: nowTs,
      updated_at: nowTs,
    },
  ];

  const extraSubscribers = Math.max(0, options.extraSubscribersCount ?? 0);
  for (let i = 0; i < extraSubscribers; i++) {
    const idx = i + 4;
    subscribersRows.push({
      id: `sub-ideas-${String(idx).padStart(4, '0')}`,
      email_norm: `extra.sub.${idx}@test-sink.domation.local`,
      email: `extra.sub.${idx}@test-sink.domation.local`,
      first_name: `Extra${idx}`,
      last_name: 'Subscriber',
      status: 'subscribed',
      source: 'Import',
      workspace_id: 1,
      created_at: nowTs,
      updated_at: nowTs,
    });
  }

  const listsRows = [
    {
      id: 'list-ideas-mba-2026',
      name: 'MBA Fall 2026 Leads',
      source: 'Google Sheets',
      type: 'sync',
      subscriber_count: 3,
      phone_count: 3,
      created_at: nowTs,
      updated_at: nowTs,
      workspace_id: 1,
      created_by: 1001,
    },
  ];

  const subscriberListsRows = [
    { subscriber_id: 'sub-ideas-0001', list_id: 'list-ideas-mba-2026', workspace_id: 1 },
    { subscriber_id: 'sub-ideas-0002', list_id: 'list-ideas-mba-2026', workspace_id: 1 },
  ];

  const segmentsRows = [
    {
      id: 'seg-ideas-hot-mba',
      tenant_id: 1,
      created_by: 1001,
      name: 'Hot MBA Prospects',
      entity_type: 'subscriber',
      filters: JSON.stringify([{ field: 'temperature', op: 'eq', value: 'hot' }]),
      is_shared: 1,
      created_at: nowTs,
      subscriber_count: 1,
      phone_count: 1,
      updated_at: nowTs,
      workspace_id: 1,
      conditions: JSON.stringify({ operator: 'AND', rules: [{ field: 'temperature', op: 'eq', value: 'hot' }] }),
    },
  ];

  const templateHtmlLegacy =
    '<div><img src="https://automation.ideas.edu.vn/uploadss/banner-mba.jpg" /><a href="https://myerp.ideas.edu.vn/backend/uploadss/brochure.pdf">Brochure</a><img src="https://automation.ideas.edu.vn/mail_api/timer.php?target=2026-12-01" /></div>';
  const templateBlocksLegacy = JSON.stringify([
    {
      id: 'blk-1',
      type: 'image',
      src: 'https://automation.ideas.edu.vn/uploadss/hero-mba.png',
      link: 'https://myerp.ideas.edu.vn/backend/uploadss/curriculum.pdf',
    },
  ]);

  const templatesRows = [
    {
      id: 'tpl-ideas-mba-welcome',
      name: 'MBA Welcome Brochure',
      thumbnail: 'https://automation.ideas.edu.vn/uploadss/thumb-mba.png',
      category: 'education',
      group_id: 'grp-mba',
      blocks: templateBlocksLegacy,
      body_style: JSON.stringify({ backgroundColor: '#ffffff' }),
      html_content: templateHtmlLegacy,
      created_at: nowTs,
      updated_at: nowTs,
      type: 'email',
      subject: 'Welcome to IDEAS MBA Online',
      workspace_id: 1,
      created_by: 1001,
      visibility: 'workspace',
    },
  ];

  const campaignsRows = [
    {
      id: 'camp-ideas-fall-2026',
      name: 'IDEAS MBA Fall Intake',
      subject: 'MBA Scholarship Deadlines',
      preheader_text: 'Apply before December',
      sender_email: 'tuyensinh@ideas.edu.vn',
      sender_name: 'IDEAS Admissions',
      reply_to: 'tuyensinh@ideas.edu.vn',
      status: 'sent',
      type: 'regular',
      config: JSON.stringify({ listIds: ['list-ideas-mba-2026'] }),
      template_id: 'tpl-ideas-mba-welcome',
      content_body: '<p>Download guide at https://myerp.ideas.edu.vn/backend/uploadss/guide.pdf</p>',
      target_config: JSON.stringify({ list_ids: ['list-ideas-mba-2026'] }),
      timezone: 'Asia/Ho_Chi_Minh',
      sent_at: nowTs,
      tracking_enabled: 1,
      count_sent: 10,
      count_opened: 6,
      count_unique_opened: 5,
      count_clicked: 3,
      count_unique_clicked: 2,
      created_at: nowTs,
      updated_at: nowTs,
      is_deleted: 0,
      total_target_audience: 10,
      workspace_id: 1,
      created_by: 1001,
    },
  ];

  const flowSteps = [
    {
      id: 'node-trigger-1',
      type: 'trigger',
      label: 'Lead Created',
      config: { trigger_type: 'lead_created' },
    },
    {
      id: 'node-email-1',
      type: 'send_email',
      label: 'Send Brochure',
      config: {
        template_id: 'tpl-ideas-mba-welcome',
        subject: 'IDEAS MBA Information',
        html: '<p>See <a href="https://automation.ideas.edu.vn/uploadss/mba-pack.pdf">MBA Pack</a></p>',
      },
    },
    {
      id: 'node-wait-1',
      type: 'wait',
      label: 'Wait 1 Day',
      config: { duration: 1, unit: 'days' },
    },
    {
      id: 'node-zns-1',
      type: 'zalo_zns',
      label: 'Zalo ZNS',
      config: {
        zalo_oa_id: '3857867121882640296',
        template_id: '446723',
        template_data: {
          ngay_dang_ky: '{{today}}',
          ten_chuong_trinh: 'Thac si truc tuyen',
        },
      },
    },
  ];

  const flowsRows = [
    {
      id: 'flow-ideas-mba-nurture',
      name: 'MBA Nurturing Flow (with legacy zalo_zns)',
      description: 'Nurtures MBA prospects with email + legacy ZNS node',
      status: 'active',
      steps: JSON.stringify(flowSteps),
      config: JSON.stringify({ trigger: 'lead_created' }),
      stat_enrolled: 25,
      stat_completed: 10,
      stat_open_rate: 52.5,
      stat_click_rate: 18.0,
      stat_total_sent: 25,
      stat_total_opened: 13,
      stat_unique_opened: 12,
      stat_total_clicked: 5,
      stat_unique_clicked: 4,
      created_at: nowTs,
      updated_at: nowTs,
      trigger_type: 'lead_created',
      workspace_id: 1,
      created_by: 1001,
    },
  ];

  const formsRows = [
    {
      id: 'form-ideas-mba-consult',
      tenant_id: 1,
      name: 'MBA Consultation Form',
      schema: JSON.stringify({ title: 'Register for MBA Consultation' }),
      mapping: JSON.stringify({ full_name: 'name', email: 'email', phone: 'phone' }),
      embed_token: 'ideas-mba-form-token-01',
      is_active: 1,
      submit_count: 14,
      created_by: 1001,
      created_at: nowTs,
      status: 'active',
      target_list_id: 'list-ideas-mba-2026',
      fields_json: JSON.stringify([
        { name: 'name', label: 'Full Name', type: 'text', required: true },
        { name: 'email', label: 'Email', type: 'email', required: true },
        { name: 'phone', label: 'Phone', type: 'tel', required: true },
      ]),
      notification_enabled: 1,
      notification_emails: 'admissions@test-sink.domation.local',
      notification_subject: 'New MBA Consultation Request',
      workspace_id: 1,
    },
  ];

  const surveysRows = [
    {
      id: 'survey-ideas-intake-2026',
      workspace_id: 1,
      name: 'MBA Student Satisfaction Survey',
      slug: 'ideas-mba-satisfaction-2026',
      status: 'active',
      cover_style: JSON.stringify({ themeColor: '#BD1D2D' }),
      blocks_json: JSON.stringify([{ id: 'q1', type: 'rating', question: 'Rate the curriculum' }]),
      settings_json: JSON.stringify({ showProgress: true }),
      thank_you_page: JSON.stringify({ title: 'Thank you!' }),
      target_list_id: 'list-ideas-mba-2026',
      flow_trigger_id: 'flow-ideas-mba-nurture',
      require_login: 0,
      allow_anonymous: 1,
      one_per_email: 0,
      created_by: 1001,
      created_at: nowTs,
      updated_at: nowTs,
    },
  ];

  const shortLinksRows = [
    {
      id: 'sl-ideas-mba-brochure',
      workspace_id: '1',
      name: 'MBA Brochure QR Link',
      slug: 'ideas-mba-pack',
      target_url: 'https://automation.ideas.edu.vn/uploadss/mba-brochure.pdf',
      is_survey_checkin: 0,
      status: 'active',
      submit_count: 42,
      qr_config_json: JSON.stringify({ value: 'https://automation.ideas.edu.vn/go/95c20d1d' }),
      created_at: nowTs,
      utm_source: 'facebook',
      utm_medium: 'cpc',
      utm_campaign: 'mba_fall_2026',
      created_by: 1001,
      is_deleted: 0,
    },
  ];

  const webPropertiesRows: Array<Record<string, unknown>> = [
    {
      id: 1,
      workspace_id: 1,
      name: 'IDEAS Main Website',
      domain: 'ideas.edu.vn',
      settings: JSON.stringify({ trackingEnabled: true }),
      created_at: nowTs,
      status: 'active',
      api_key: 'wp_ideas_live_key_01',
      created_by: 1001,
      is_deleted: 0,
    },
    {
      id: 2,
      workspace_id: 1,
      name: 'Chief AI Officer Site',
      domain: 'chiefaiofficer.vn',
      settings: JSON.stringify({ trackingEnabled: true }),
      created_at: nowTs,
      status: 'active',
      api_key: 'wp_caio_live_key_02',
      created_by: 1001,
      is_deleted: 0,
    },
  ];

  const pollutionWebProps = Math.max(1, options.pollutionWebPropertiesCount ?? 3);
  for (let i = 1; i <= pollutionWebProps; i++) {
    webPropertiesRows.push({
      id: 99000 + i,
      workspace_id: 99999,
      name: `Test Tracking Site ${i}`,
      domain: 'ideas.edu.vn',
      settings: JSON.stringify({ test: true }),
      created_at: nowTs,
      status: 'active',
      api_key: `prop_99999_${i}`,
      created_by: 99901,
      is_deleted: 0,
    });
  }

  const mailQueueRows: Array<Record<string, unknown>> = [
    {
      id: 1,
      to_email: 'sent.historical@test-sink.domation.local',
      cc_email: '',
      subject: '[MYERP] Sent historical notice',
      body_html: '<p>Already sent in MYERP</p>',
      status: 'sent',
      created_at: '2026-11-10 07:00:00',
      sent_at: '2026-11-10 07:00:05',
      attempts: 1,
      lead_id: 1,
      updated_at: '2026-11-10 07:00:05',
    },
  ];
  const pendingCount = Math.max(1, options.pendingMailQueueCount ?? 2);
  for (let i = 1; i <= pendingCount; i++) {
    mailQueueRows.push({
      id: 8800 + i,
      to_email: `stale.pending.${i}@test-sink.domation.local`,
      cc_email: '',
      subject: `[MYERP] Stale pending email #${i}`,
      body_html: '<p>Stale pending queue row that must be purged/gated on migration</p>',
      status: 'pending',
      created_at: '2026-11-17 07:56:42',
      sent_at: null,
      attempts: 0,
      lead_id: 1,
      updated_at: '2026-11-17 07:56:42',
    });
  }

  const subscriberFlowStatesRows: Array<Record<string, unknown>> = [
    {
      id: 84001,
      workspace_id: 1,
      contact_id: 100001,
      subscriber_id: 'sub-ideas-0001',
      flow_id: 'flow-ideas-mba-nurture',
      step_id: 'node-email-1',
      step_type: 'send_email',
      status: 'completed',
      scheduled_at: '2026-11-10 09:00:00',
      created_at: '2026-11-10 09:00:00',
      updated_at: '2026-11-10 09:00:05',
      last_step_at: '2026-11-10 09:00:05',
    },
  ];
  const waitingCount = Math.max(1, options.waitingFlowStatesCount ?? 2);
  for (let i = 1; i <= waitingCount; i++) {
    subscriberFlowStatesRows.push({
      id: 84800 + i,
      workspace_id: 1,
      contact_id: 100001,
      subscriber_id: 'sub-ideas-0001',
      flow_id: 'flow-ideas-mba-nurture',
      step_id: 'node-wait-1',
      step_type: 'wait',
      status: 'waiting',
      scheduled_at: '2026-11-19 09:45:03',
      waiting_until: '2026-11-20 09:45:03',
      created_at: '2026-11-16 09:40:06',
      updated_at: '2026-11-16 09:45:04',
      last_step_at: '2026-11-16 09:45:04',
    });
  }

  const contactMetaAttributionRows = [
    {
      id: 1,
      contact_id: 100001,
      tenant_id: 1,
      meta_lead_id: 'meta_lead_100001',
      ad_id: 'ad_55001',
      ad_name: 'MBA Online Video Ad 01',
      adset_id: 'adset_77001',
      adset_name: 'Executives HCMC 28-45',
      campaign_id: 'camp_88001',
      campaign_name: 'MBA Fall 2026',
      form_id: 'form_99001',
      form_name: 'MBA Lead Form',
      platform: 'fb',
      fbc: 'fb.1.1700000000.AbCdEf',
      fbp: 'fb.1.1700000000.123456789',
      event_source_url: 'https://ideas.edu.vn/mba',
      fb_pixel_id: '583807401361847',
      is_organic: 0,
      lead_created_time: nowTs,
      raw_lead_status: 'qualified',
      priority: 1,
      degree: 'Bachelor',
      english_work_exp: '5+ years',
      consultation_time: 'Evening 19:00',
      program_interest: 'MBA Online',
      created_at: nowTs,
      updated_at: nowTs,
    },
  ];

  const capiLogsRows = [
    {
      id: 1,
      lead_id: 1,
      meta_lead_id: 'meta_lead_100001',
      contact_id: 100001,
      pixel_id: '583807401361847',
      event_name: 'Lead',
      action_source: 'system_generated',
      payload_hash: 'sha256_synthetic_payload_hash_01',
      event_id: 'myerp_lead_c_100001_needed',
      trigger_stage: 'needed',
      trigger_mode: 'backfill',
      event_value: 45000000,
      emq_signals: 6,
      sent_payload: JSON.stringify({ data: [{ event_name: 'Lead', event_id: 'myerp_lead_c_100001_needed' }] }),
      response_status: 200,
      response_body: JSON.stringify({ events_received: 1 }),
      sent_at: nowTs,
      full_name: 'Tran Minh Khoa',
    },
  ];

  const capiBlockedPhonesRows = [
    {
      id: 1,
      tenant_id: 1,
      phone_normalized: '8403481111',
      source_label: 'L1ABC_rac',
      reason: 'phone_farm_fraud',
      created_by: 1001,
      created_at: nowTs,
    },
  ];

  const metaAppConfigsRows = [
    {
      id: 1,
      page_name: 'IDEAS Institute',
      page_id: '104920192837465',
      app_id: '987654321098765',
      page_access_token: 'EAA_SYNTHETIC_PAGE_TOKEN_DO_NOT_USE_LIVE',
      app_secret: 'synthetic_meta_app_secret_01',
      verify_token: 'ideas_meta_verify_token_01',
      status: 'active',
      mode: 'live',
      created_at: nowTs,
      updated_at: nowTs,
      workspace_id: 1,
    },
  ];

  const systemSettingsRows = [
    { setting_key: 'email_provider', setting_value: 'ses' },
    { setting_key: 'ses_host', setting_value: 'email-smtp.ap-southeast-2.amazonaws.com' },
    { setting_key: 'ses_region', setting_value: 'ap-southeast-2' },
    { setting_key: 'ses_username', setting_value: 'AKIATESTSYNTHETIC001' },
    { setting_key: 'ses_password', setting_value: 'SyntheticSesSmtpPasswordValue0000000000000001' },
    { setting_key: 'ses_sender_email', setting_value: 'systemnoti@ideas.edu.vn' },
    { setting_key: 'ses_sender_name', setting_value: 'IDEAS MYERP' },
    { setting_key: 'smtp_port', setting_value: '587' },
    { setting_key: 'meta_access_token', setting_value: 'EAA_SYNTHETIC_META_ADS_TOKEN_01' },
    { setting_key: 'meta_ad_account_id', setting_value: '1852318231510577' },
    { setting_key: 'meta_pixel_id', setting_value: '583807401361847' },
    { setting_key: 'meta_web_pixel_id', setting_value: '661260709828887' },
    { setting_key: 'capi_dual_pixel_enabled', setting_value: '1' },
    { setting_key: 'gemini_api_key', setting_value: 'AIzaSySyntheticGeminiKeyForE2EOnly001' },
    { setting_key: 'gemini_model', setting_value: 'gemini-2.5-flash' },
    { setting_key: 'groq_api_key', setting_value: 'gsk_synthetic_groq_key_01' },
    { setting_key: 'openrouter_api_key', setting_value: 'sk-or-synthetic-key-01' },
    { setting_key: 'frontend_url', setting_value: 'https://myerp.ideas.edu.vn' },
    { setting_key: 'tracking_endpoint_url', setting_value: 'https://crm.ideas.edu.vn/tracker.js' },
    // ZaloBot settings present in MYERP that MUST be excluded during migration (F8):
    { setting_key: 'zalo_bot_token', setting_value: '999999:SYNTHETIC_ZALO_BOT_TOKEN_MUST_EXCLUDE' },
    { setting_key: 'zalo_admin_group_chat_id', setting_value: '-4829104829' },
    { setting_key: 'zalo_daily_report_enabled', setting_value: '1' },
    { setting_key: 'zalo_notify_only_group', setting_value: '1' },
    { setting_key: 'zalo_webhook_secret', setting_value: 'synthetic_zalo_webhook_secret_exclude' },
  ];

  const mktSystemSettingsRows = [
    { workspace_id: 0, key: 'aws_access_key', value: 'AKIATESTSYNTHETIC002', updated_at: nowTs },
    {
      workspace_id: 0,
      key: 'aws_secret_key',
      value: 'SyntheticAwsSecretAccessKeyValue00000002',
      updated_at: nowTs,
    },
    { workspace_id: 1, key: 'smtp_host', value: 'email-smtp.ap-southeast-2.amazonaws.com', updated_at: nowTs },
    { workspace_id: 1, key: 'smtp_port', value: '587', updated_at: nowTs },
    { workspace_id: 1, key: 'smtp_user', value: 'AKIATESTSYNTHETIC001', updated_at: nowTs },
    { workspace_id: 1, key: 'smtp_pass', value: 'SyntheticSesSmtpPasswordValue0000000000000001', updated_at: nowTs },
    { workspace_id: 1, key: 'smtp_from_email', value: 'tuyensinh@ideas.edu.vn', updated_at: nowTs },
    { workspace_id: 1, key: 'smtp_from_name', value: 'IDEAS Admissions', updated_at: nowTs },
    { workspace_id: 1, key: 'smtp_enabled', value: '1', updated_at: nowTs },
    { workspace_id: 1, key: 'gemini_api_key', value: 'AIzaSySyntheticMktGeminiKey002', updated_at: nowTs },
    { workspace_id: 1, key: 'internal_qa_emails', value: 'qa@test-sink.domation.local', updated_at: nowTs },
  ];

  const verifiedSendersRows = [
    {
      id: 1,
      workspace_id: 1,
      email: 'tuyensinh@ideas.edu.vn',
      name: 'IDEAS Admissions',
      reply_to: 'tuyensinh@ideas.edu.vn',
      is_verified: 1,
      is_default: 1,
      created_at: nowTs,
    },
    {
      id: 2,
      workspace_id: 1,
      email: 'cskh@ideas.edu.vn',
      name: 'IDEAS CSKH',
      reply_to: 'cskh@ideas.edu.vn',
      is_verified: 1,
      is_default: 0,
      created_at: nowTs,
    },
    {
      id: 3,
      workspace_id: 1,
      email: 'marketing@ideas.edu.vn',
      name: 'IDEAS Marketing',
      reply_to: 'marketing@ideas.edu.vn',
      is_verified: 1,
      is_default: 0,
      created_at: nowTs,
    },
    {
      id: 4,
      workspace_id: 1,
      email: 'systemnoti@ideas.edu.vn',
      name: 'IDEAS System',
      reply_to: 'systemnoti@ideas.edu.vn',
      is_verified: 1,
      is_default: 0,
      created_at: nowTs,
    },
  ];

  const zaloOaConfigsRows = [
    {
      id: 1,
      workspace_id: 1,
      name: 'IDEAS',
      oa_id: '3857867121882640296',
      app_id: 'synthetic_zalo_app_id',
      app_secret: 'synthetic_zalo_app_secret',
      access_token: 'synthetic_zalo_oa_access_token_must_exclude',
      refresh_token: 'synthetic_zalo_oa_refresh_token_must_exclude',
      token_status: 'valid',
      daily_quota: 500,
      quota_used_today: 0,
      status: 'active',
      created_at: nowTs,
      updated_at: nowTs,
    },
  ];

  const zaloQueueRows = [
    {
      id: 1,
      bot_token: '999999:SYNTHETIC_ZALO_BOT_TOKEN_MUST_EXCLUDE',
      chat_id: '-4829104829',
      body_text: 'Synthetic Zalo queue item that must NOT migrate',
      status: 'pending',
      created_at: nowTs,
      attempts: 0,
      lead_id: 1,
      updated_at: nowTs,
    },
  ];

  const zaloSubscribersRows = [
    {
      id: 'zsub-ideas-0001',
      contact_id: 100001,
      zalo_user_id: 'zalo_uid_100001',
      oa_id: '3857867121882640296',
      subscriber_id: 'sub-ideas-0001',
      display_name: 'Tran Minh Khoa',
      phone_number: '0912000111',
      status: 'active',
      lead_score: 85,
      is_follower: 1,
      joined_at: nowTs,
      updated_at: nowTs,
      workspace_id: 1,
    },
  ];

  const includeAllZalo = options.includeAllZaloTables !== false;
  const parts: string[] = [DDL_BLOCK];
  if (includeAllZalo) parts.push(EXTRA_ZALO_TABLES_DDL);

  parts.push(emitInsert('tenants', TENANTS_COLS, tenantsRows));
  parts.push(emitInsert('_bak_activities_20260913', BAK_ACTIVITIES_COLS, bakActivitiesRows));
  parts.push(emitInsert('_bak_deposits_20260819_103521', BAK_DEPOSITS_COLS, bakDepositsRows));
  parts.push(emitInsert('users', USERS_COLS, usersRows));
  parts.push(emitInsert('contacts', CONTACTS_COLS, contactsRows));
  parts.push(emitInsert('leads', LEADS_COLS, leadsRows));
  parts.push(emitInsert('pipeline_stages', PIPELINE_STAGES_COLS, pipelineStagesRows));
  parts.push(emitInsert('distribution_rounds', DISTRIBUTION_ROUNDS_COLS, distributionRoundsRows));
  parts.push(emitInsert('round_consultants', ROUND_CONSULTANTS_COLS, roundConsultantsRows));
  parts.push(emitInsert('routing_rules', ROUTING_RULES_COLS, routingRulesRows));
  parts.push(emitInsert('subscribers', SUBSCRIBERS_COLS, subscribersRows));
  parts.push(emitInsert('lists', LISTS_COLS, listsRows));
  parts.push(emitInsert('subscriber_lists', SUBSCRIBER_LISTS_COLS, subscriberListsRows));
  parts.push(emitInsert('segments', SEGMENTS_COLS, segmentsRows));
  parts.push(emitInsert('templates', TEMPLATES_COLS, templatesRows));
  parts.push(emitInsert('campaigns', CAMPAIGNS_COLS, campaignsRows));
  parts.push(emitInsert('flows', FLOWS_COLS, flowsRows));
  parts.push(emitInsert('forms', FORMS_COLS, formsRows));
  parts.push(emitInsert('surveys', SURVEYS_COLS, surveysRows));
  parts.push(emitInsert('short_links', SHORT_LINKS_COLS, shortLinksRows));
  parts.push(emitInsert('web_properties', WEB_PROPERTIES_COLS, webPropertiesRows));
  parts.push(emitInsert('mail_queue', MAIL_QUEUE_COLS, mailQueueRows));
  parts.push(emitInsert('subscriber_flow_states', SUBSCRIBER_FLOW_STATES_COLS, subscriberFlowStatesRows));
  parts.push(emitInsert('contact_meta_attribution', CONTACT_META_ATTRIBUTION_COLS, contactMetaAttributionRows));
  parts.push(emitInsert('capi_logs', CAPI_LOGS_COLS, capiLogsRows));
  parts.push(emitInsert('capi_blocked_phones', CAPI_BLOCKED_PHONES_COLS, capiBlockedPhonesRows));
  parts.push(emitInsert('meta_app_configs', META_APP_CONFIGS_COLS, metaAppConfigsRows));
  parts.push(emitInsert('system_settings', SYSTEM_SETTINGS_COLS, systemSettingsRows));
  parts.push(emitInsert('mkt_system_settings', MKT_SYSTEM_SETTINGS_COLS, mktSystemSettingsRows));
  parts.push(emitInsert('verified_senders', VERIFIED_SENDERS_COLS, verifiedSendersRows));
  parts.push(emitInsert('zalo_oa_configs', ZALO_OA_CONFIGS_COLS, zaloOaConfigsRows));
  parts.push(emitInsert('zalo_queue', ZALO_QUEUE_COLS, zaloQueueRows));
  parts.push(emitInsert('zalo_subscribers', ZALO_SUBSCRIBERS_COLS, zaloSubscribersRows));

  const sqlContent = parts.join('');
  fs.writeFileSync(sqlPath, sqlContent, 'utf8');

  const legacyMatches = sqlContent.match(/(?:automation\.ideas\.edu\.vn|myerp\.ideas\.edu\.vn)/g);

  return {
    sqlPath,
    dir,
    ownsDir,
    counts: {
      tenants: tenantsRows.length,
      bakTables: 2,
      zaloTables: includeAllZalo ? 13 : 3,
      users: usersRows.filter((u) => u.tenant_id === 1).length,
      ideasContacts: contactsRows.filter((c) => c.tenant_id === 1).length,
      pollutionContacts: contactsRows.filter((c) => c.tenant_id === 99999).length,
      leads: leadsRows.length,
      ideasSubscribers: subscribersRows.filter((s) => s.workspace_id === 1).length,
      pollutionSubscribers: subscribersRows.filter((s) => s.workspace_id === 99999).length,
      templates: templatesRows.length,
      campaigns: campaignsRows.length,
      flows: flowsRows.length,
      ideasWebProperties: webPropertiesRows.filter((w) => w.workspace_id === 1).length,
      pollutionWebProperties: webPropertiesRows.filter((w) => w.workspace_id === 99999).length,
      pendingMailQueue: pendingCount,
      waitingFlowStates: waitingCount,
      verifiedSenders: verifiedSendersRows.length,
      legacyUrlCount: legacyMatches ? legacyMatches.length : 0,
    },
    cleanup: () => {
      try {
        if (ownsDir) {
          fs.rmSync(dir, { recursive: true, force: true });
        } else {
          fs.rmSync(sqlPath, { force: true });
        }
      } catch {
        // Ignore cleanup race
      }
    },
  };
}
