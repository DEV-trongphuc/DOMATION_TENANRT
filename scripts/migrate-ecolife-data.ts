/**
 * EcoLife Signature (Capital House) — Real Production SQL Dump Migration
 *
 * Parses the read-only cPanel MySQL dump (`yinpzoab_data.sql`) into tenant `ecolife`
 * in AUTO_DATA_TENANRT PostgreSQL storage:
 * - Admin: turniodev@gmail.com / 123456 (+ real accounts ecolifesignature, thanhchinh1401, tinhthuc1107, camtupham)
 * - 3 Real F1 Agencies: Địa Ốc Tùng Long (7), Bất Động Sản Hợp Nhất (8), Tập đoàn IHD (9)
 * - Real consultant_managers, distribution_rounds, round_consultants, routing_rules, sheet_connections
 * - All 631 real leads (195 active/assigned + 434 archived/silent + 1 held rejected + 1 blacklisted)
 * - 5 real data_reports (tickets), admin_logs -> admin_audit_logs, meta_ads_daily_insights + meta_ads_cache -> meta_ads_insights
 * - Non-secret system_settings (explicitly stripping live API tokens/passwords/webhooks)
 *
 * Strict Silent & Privacy Guarantee:
 * - OUTBOUND_SILENT_MODE=true, TELEGRAM_SILENT_MODE=true
 * - Never replays mail_queue / zalo_queue / capi_logs / communication_logs
 */

import fs from 'node:fs';
import crypto from 'node:crypto';
import { getDatabasePool } from '../server/core/database/db-adapter.ts';
import { runDatabaseMigrations } from '../server/core/database/migrate.ts';
import { hashPassword, verifyPassword } from '../server/core/crypto/password.ts';

process.env.OUTBOUND_SILENT_MODE = 'true';
process.env.TELEGRAM_NOTIFY_ENABLED = 'false';
process.env.TELEGRAM_SILENT_MODE = 'true';
process.env.MIGRATION_SILENT_MODE = 'true';
process.env.NODE_ENV = 'test';

export const DEFAULT_ECOLIFE_SQL_PATH =
  process.env.ECOLIFE_DUMP_PATH ||
  'C:/Users/LENOVO/.gemini/antigravity/brain/9fac1a2b-cfab-4d7e-9a4a-148ac3707abc/scratch/yinpzoab_data.sql';

export const ECOLIFE_SLUG = 'ecolife';
export const ECOLIFE_NAME = 'EcoLife Signature - Capital House';
export const ECOLIFE_ADMIN_EMAIL = 'turniodev@gmail.com';
export const ECOLIFE_ADMIN_PASSWORD = '123456';

const SECRET_SETTING_KEYS = new Set([
  'gemini_api_key',
  'meta_ads_access_token',
  'capi_access_token',
  'ses_password',
  'ses_username',
  'zalo_bot_token',
  'zalo_webhook_secret',
  'appscript_webhook_url',
  'master_google_script_url',
]);

function deterministicUuid(seed: string): string {
  const hash = crypto.createHash('sha256').update(seed).digest('hex');
  return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-4${hash.slice(13, 16)}-a${hash.slice(17, 20)}-${hash.slice(20, 32)}`;
}

function normalizePhone(raw: unknown, fallbackId: number): string {
  if (raw === null || raw === undefined) {
    return `NOPHONE_${String(fallbackId).padStart(5, '0')}`;
  }
  const s = String(raw).trim();
  if (!s) return `NOPHONE_${String(fallbackId).padStart(5, '0')}`;
  const digits = s.replace(/\D/g, '');
  if (digits.length < 7) return `NOPHONE_${String(fallbackId).padStart(5, '0')}`;
  if (digits.startsWith('84') && digits.length >= 11) return digits.slice(0, 30);
  if (digits.startsWith('0') && (digits.length === 10 || digits.length === 11)) {
    return ('84' + digits.slice(1)).slice(0, 30);
  }
  if (digits.length === 9 && /^[35789]/.test(digits)) {
    return ('84' + digits).slice(0, 30);
  }
  return digits.slice(0, 30);
}

function parseSqlDate(raw: unknown): string {
  if (typeof raw === 'string' && /^\d{4}-\d{2}-\d{2}/.test(raw)) {
    const iso = raw.replace(' ', 'T') + (raw.includes('+') || raw.endsWith('Z') ? '' : '+07:00');
    const d = new Date(iso);
    if (!Number.isNaN(d.getTime())) return d.toISOString();
  }
  return new Date().toISOString();
}

function extractMysqlRows<T extends Record<string, any>>(sql: string, table: string): T[] {
  const re = new RegExp('INSERT INTO `' + table + '` \\(([^)]+)\\) VALUES\\s*([\\s\\S]*?);\\r?\\n', 'g');
  const out: T[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(sql)) !== null) {
    const cols = m[1].replace(/`/g, '').split(',').map((s) => s.trim());
    const valuesStr = m[2];
    let i = 0;
    const len = valuesStr.length;
    while (i < len) {
      while (i < len && valuesStr[i] !== '(') i++;
      if (i >= len) break;
      i++;
      const row: any[] = [];
      while (i < len) {
        while (i < len && /\s/.test(valuesStr[i])) i++;
        if (valuesStr[i] === ')') {
          i++;
          break;
        }
        if (valuesStr[i] === "'") {
          i++;
          let val = '';
          while (i < len) {
            if (valuesStr[i] === '\\') {
              i++;
              const ch = valuesStr[i];
              if (ch === 'n') val += '\n';
              else if (ch === 'r') val += '\r';
              else if (ch === 't') val += '\t';
              else val += ch;
              i++;
            } else if (valuesStr[i] === "'" && valuesStr[i + 1] === "'") {
              val += "'";
              i += 2;
            } else if (valuesStr[i] === "'") {
              i++;
              break;
            } else {
              val += valuesStr[i++];
            }
          }
          row.push(val);
        } else {
          let tok = '';
          while (i < len && valuesStr[i] !== ',' && valuesStr[i] !== ')') {
            tok += valuesStr[i++];
          }
          tok = tok.trim();
          row.push(tok === 'NULL' ? null : (Number.isNaN(Number(tok)) ? tok : Number(tok)));
        }
        while (i < len && /\s/.test(valuesStr[i])) i++;
        if (valuesStr[i] === ',') i++;
      }
      const obj: Record<string, any> = {};
      for (let cIdx = 0; cIdx < cols.length; cIdx++) {
        obj[cols[cIdx]] = row[cIdx];
      }
      out.push(obj as T);
    }
  }
  return out;
}

export async function migrateEcoLifeData(sqlPath: string = DEFAULT_ECOLIFE_SQL_PATH) {
  if (!fs.existsSync(sqlPath)) {
    throw new Error(`EcoLife SQL dump not found at ${sqlPath}`);
  }

  console.log('===============================================================');
  console.log('  ECOLIFE REAL PRODUCTION DUMP MIGRATION (yinpzoab_data.sql)');
  console.log('  Strict Silent Mode: OUTBOUND_SILENT_MODE=true');
  console.log('===============================================================');

  const rawSql = fs.readFileSync(sqlPath, 'utf8');
  const dumpAccounts = extractMysqlRows<any>(rawSql, 'accounts');
  const dumpConsultants = extractMysqlRows<any>(rawSql, 'consultants');
  const dumpManagers = extractMysqlRows<any>(rawSql, 'consultant_managers');
  const dumpRounds = extractMysqlRows<any>(rawSql, 'distribution_rounds');
  const dumpRoundConsultants = extractMysqlRows<any>(rawSql, 'round_consultants');
  const dumpRoutingRules = extractMysqlRows<any>(rawSql, 'routing_rules');
  const dumpConnections = extractMysqlRows<any>(rawSql, 'sheet_connections');
  const dumpFieldMappings = extractMysqlRows<any>(rawSql, 'field_mappings');
  const dumpLeads = extractMysqlRows<any>(rawSql, 'leads');
  const dumpReports = extractMysqlRows<any>(rawSql, 'data_reports');
  const dumpDistLogs = extractMysqlRows<any>(rawSql, 'distribution_logs');
  const dumpAdminLogs = extractMysqlRows<any>(rawSql, 'admin_logs');
  const dumpMetaCache = extractMysqlRows<any>(rawSql, 'meta_ads_cache');
  const dumpMetaDaily = extractMysqlRows<any>(rawSql, 'meta_ads_daily_insights');
  const dumpSettings = extractMysqlRows<{ setting_key: string; setting_value: string }>(rawSql, 'system_settings');

  const safeSettingsMap: Record<string, string> = {};
  for (const s of dumpSettings) {
    if (!SECRET_SETTING_KEYS.has(s.setting_key)) {
      safeSettingsMap[s.setting_key] = s.setting_value;
    }
  }

  await runDatabaseMigrations();
  const pool = getDatabasePool();
  const client = await pool.connect();

  try {
    const devPasswordHash = await hashPassword(ECOLIFE_ADMIN_PASSWORD);

    const tenantSettings = {
      duplicate_threshold_days: Number(safeSettingsMap.duplicate_check_months || 3) * 30,
      default_sla_minutes: 15,
      pii_masking_enabled: true,
      dual_capi_enabled: safeSettingsMap.capi_dual_send === '1',
      session_ttl_minutes: 1440,
      refresh_token_ttl_days: 30,
      allow_international_phones: true,
      allow_landline_phones: true,
      starvation_prevention_enabled: safeSettingsMap.starvation_prevention_enabled === '1',
      starvation_max_leads_per_hour: Number(safeSettingsMap.starvation_max_leads_per_hour || 10),
      auto_accept_on_assign: false,
      fallback_mode: safeSettingsMap.fallback_type || 'round_robin_next',
      ticket_auto_approve_enabled: safeSettingsMap.ticket_auto_approve_enabled === '1',
      reassign_if_owner_inactive: safeSettingsMap.reassign_if_owner_inactive === '1',
      zalo_notify_only_group: safeSettingsMap.zalo_notify_only_group === '1',
      report_error_reasons: (() => {
        try {
          return JSON.parse(safeSettingsMap.report_error_reasons_v2 || '[]');
        } catch {
          return [];
        }
      })(),
      brand_primary_color: '#1E40FF',
    };

    // 1. Upsert Tenant 'ecolife'
    const existingTenant = await client.query<{ id: string }>(
      'SELECT id FROM tenants WHERE slug = $1 LIMIT 1',
      [ECOLIFE_SLUG]
    );
    let tenantId: string;
    if (existingTenant.rows.length === 0) {
      tenantId = deterministicUuid('ecolife:tenant');
      await client.query(
        `INSERT INTO tenants (
          id, slug, obfuscated_slug, name, plan_tier, status, industry,
          subscription_plan_code, billing_cycle, crm_erp_upgrade_status,
          wallet_balance_vnd, trial_ends_at, subscription_expires_at, settings
        ) VALUES (
          $1, $2, 'eco-signature-f1', $3, 'enterprise', 'active', 'real_estate',
          'enterprise_yearly', 'annual', 'completed',
          25000000, clock_timestamp() + interval '30 days', clock_timestamp() + interval '365 days',
          $4::jsonb
        )`,
        [tenantId, ECOLIFE_SLUG, ECOLIFE_NAME, JSON.stringify(tenantSettings)]
      );
    } else {
      tenantId = existingTenant.rows[0].id;
      await client.query(
        `UPDATE tenants SET
          name = $1, plan_tier = 'enterprise', status = 'active', industry = 'real_estate',
          subscription_plan_code = 'enterprise_yearly', crm_erp_upgrade_status = 'completed',
          settings = $2::jsonb, updated_at = clock_timestamp()
        WHERE id = $3`,
        [ECOLIFE_NAME, JSON.stringify(tenantSettings), tenantId]
      );
    }

    // Wipe previous ecolife operational tables for deterministic re-runs
    await client.query(`DELETE FROM active_compensation_logs WHERE tenant_id = $1`, [tenantId]);
    await client.query(`DELETE FROM data_reports WHERE tenant_id = $1`, [tenantId]);
    await client.query(`DELETE FROM lead_timeline_events WHERE tenant_id = $1`, [tenantId]);
    await client.query(`DELETE FROM capi_logs WHERE tenant_id = $1`, [tenantId]);
    await client.query(`DELETE FROM tenant_webhook_dlq WHERE tenant_id = $1`, [tenantId]);
    await client.query(`DELETE FROM personal_leads WHERE tenant_id = $1`, [tenantId]);
    await client.query(`DELETE FROM lead_import_batches WHERE tenant_id = $1`, [tenantId]);
    await client.query(`DELETE FROM held_leads WHERE tenant_id = $1`, [tenantId]);
    await client.query(`DELETE FROM blacklist_entries WHERE tenant_id = $1`, [tenantId]);
    await client.query(`DELETE FROM leads WHERE tenant_id = $1`, [tenantId]);
    await client.query(`DELETE FROM meta_ads_insights WHERE tenant_id = $1`, [tenantId]);
    await client.query(`DELETE FROM routing_rules WHERE tenant_id = $1`, [tenantId]);
    await client.query(`DELETE FROM round_consultants WHERE tenant_id = $1`, [tenantId]);
    await client.query(`DELETE FROM distribution_rounds WHERE tenant_id = $1`, [tenantId]);
    await client.query(`DELETE FROM tenant_webhooks WHERE tenant_id = $1`, [tenantId]);
    await client.query(`DELETE FROM consultant_managers WHERE tenant_id = $1`, [tenantId]);
    await client.query(`DELETE FROM admin_audit_logs WHERE tenant_id = $1`, [tenantId]);

    // 2. Onboarding progress
    await client.query(
      `INSERT INTO tenant_onboarding_progress (
        tenant_id, current_step, completed_steps, is_completed, dismissed_at, screen_tours
      ) VALUES ($1, 4, '[1,2,3,4]'::jsonb, true, clock_timestamp(), '{}'::jsonb)
      ON CONFLICT (tenant_id) DO UPDATE SET
        current_step = 4, completed_steps = '[1,2,3,4]'::jsonb, is_completed = true, dismissed_at = clock_timestamp()`,
      [tenantId]
    );

    // 3. Provision turniodev@gmail.com admin + real accounts
    const upsertTenantAccountUser = async (opts: {
      seed: string;
      email: string;
      fullName: string;
      role: 'tenant_admin' | 'manager' | 'sale';
      isExternalAgency?: boolean;
      zaloChatId?: string | null;
      workSchedule?: Record<string, unknown>;
    }) => {
      const emailLower = opts.email.trim().toLowerCase();
      const gRes = await client.query<{ id: string }>(
        `INSERT INTO global_accounts (email, password_hash, full_name, is_active)
         VALUES ($1, $2, $3, true)
         ON CONFLICT (email) DO UPDATE SET
           password_hash = $2, full_name = $3, is_active = true, updated_at = clock_timestamp()
         RETURNING id`,
        [emailLower, devPasswordHash, opts.fullName]
      );
      const existingU = await client.query<{ id: string }>(
        `SELECT id FROM users WHERE tenant_id = $1 AND LOWER(email) = $2 LIMIT 1`,
        [tenantId, emailLower]
      );
      const uid = existingU.rows[0]?.id || deterministicUuid(opts.seed);
      if (existingU.rows.length === 0) {
        await client.query(
          `INSERT INTO users (id, tenant_id, account_id, email, password_hash, full_name, role, is_external_agency)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
          [uid, tenantId, gRes.rows[0].id, emailLower, devPasswordHash, opts.fullName, opts.role, Boolean(opts.isExternalAgency)]
        );
      } else {
        await client.query(
          `UPDATE users SET account_id = $1, password_hash = $2, full_name = $3, role = $4, is_external_agency = $5
           WHERE id = $6`,
          [gRes.rows[0].id, devPasswordHash, opts.fullName, opts.role, Boolean(opts.isExternalAgency), uid]
        );
      }
      await client.query(
        `INSERT INTO tenant_user_profiles (tenant_id, user_id, status, is_available, vacation_mode, zalo_chat_id, work_schedule, invite_status)
         VALUES ($1, $2, 'active', true, false, $3, $4::jsonb, 'joined')
         ON CONFLICT (tenant_id, user_id) DO UPDATE SET
           status = 'active', is_available = true, zalo_chat_id = COALESCE($3, tenant_user_profiles.zalo_chat_id)`,
        [tenantId, uid, opts.zaloChatId || null, JSON.stringify(opts.workSchedule || { start: '00:00', end: '23:59' })]
      );
      return uid;
    };

    const primaryAdminId = await upsertTenantAccountUser({
      seed: 'ecolife:admin:turniodev',
      email: ECOLIFE_ADMIN_EMAIL,
      fullName: 'EcoLife Capital House Admin',
      role: 'tenant_admin',
    });

    await client.query(
      `INSERT INTO platform_superadmins (email, password_hash, full_name, role, is_active)
       VALUES ($1, $2, 'EcoLife Capital House Admin', 'super_admin', true)
       ON CONFLICT (email) DO UPDATE SET
         password_hash = $2, full_name = 'EcoLife Capital House Admin', role = 'super_admin', is_active = true`,
      [ECOLIFE_ADMIN_EMAIL, devPasswordHash]
    );

    const accountUuidMap = new Map<number, string>();
    for (const acc of dumpAccounts) {
      const email = acc.email || `${acc.username}@ecolifesignature.vn`;
      const uid = await upsertTenantAccountUser({
        seed: `ecolife:account:${acc.id}`,
        email,
        fullName: acc.name || acc.username,
        role: acc.role === 'superadmin' || acc.role === 'admin' ? 'tenant_admin' : 'manager',
        zaloChatId: acc.zalo_chat_id || null,
      });
      accountUuidMap.set(Number(acc.id), uid);
    }

    // 4. Provision real consultants (7, 8, 9 — skip test consultant 10 because turniodev@gmail.com is admin)
    const consultantUuidMap = new Map<number, string>();
    for (const c of dumpConsultants) {
      const cid = Number(c.id);
      if (!c.email || c.email.toLowerCase() === ECOLIFE_ADMIN_EMAIL) continue;
      const uid = await upsertTenantAccountUser({
        seed: `ecolife:consultant:${cid}`,
        email: c.email,
        fullName: c.name,
        role: 'sale',
        isExternalAgency: true,
        zaloChatId: c.zalo_chat_id || null,
        workSchedule: {
          start: c.work_start_time || '00:00',
          end: c.work_end_time || '23:59',
        },
      });
      consultantUuidMap.set(cid, uid);
    }

    // Real consultant_managers
    for (const cm of dumpManagers) {
      const targetUid = consultantUuidMap.get(Number(cm.consultant_id));
      if (!targetUid) continue;
      await client.query(
        `INSERT INTO consultant_managers (id, tenant_id, consultant_user_id, name, email, phone, zalo_chat_id, status, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
        [
          deterministicUuid(`ecolife:cm:${cm.id}`),
          tenantId,
          targetUid,
          cm.name,
          cm.email || `cm_${cm.id}@ecolife.vn`,
          cm.phone || null,
          cm.zalo_chat_id || null,
          cm.status === 'active' ? 'active' : 'inactive',
          parseSqlDate(cm.created_at),
        ]
      );
    }

    // 5. Pipeline & Stages
    const existingPipeline = await client.query<{ id: string }>(
      `SELECT id FROM tenant_pipelines WHERE tenant_id = $1 AND is_default = true LIMIT 1`,
      [tenantId]
    );
    const pipelineId = existingPipeline.rows[0]?.id || deterministicUuid('ecolife:pipeline:default');
    if (existingPipeline.rows.length === 0) {
      await client.query(
        `INSERT INTO tenant_pipelines (id, tenant_id, name, is_default)
         VALUES ($1, $2, 'EcoLife Signature BĐS Đà Nẵng', true)`,
        [pipelineId, tenantId]
      );
    }
    const stageDefs = [
      { key: 'new', name: 'Mới tiếp nhận', order: 1, color: '#1E40FF', capi: 'Lead', won: false, lost: false },
      { key: 'good', name: 'Tiềm năng / Đang tư vấn', order: 2, color: '#0284C7', capi: 'Contact', won: false, lost: false },
      { key: 'booked', name: 'Hẹn xem nhà mẫu', order: 3, color: '#F59E0B', capi: 'Schedule', won: false, lost: false },
      { key: 'closed', name: 'Đặt cọc / Giao dịch', order: 4, color: '#10B981', capi: 'Purchase', won: true, lost: false },
      { key: 'notlead', name: 'Không nhu cầu / Sai số', order: 5, color: '#EF4444', capi: '', won: false, lost: true },
    ];
    const stageIds: Record<string, string> = {};
    for (const s of stageDefs) {
      const existingStage = await client.query<{ id: string }>(
        `SELECT id FROM tenant_pipeline_stages WHERE tenant_id = $1 AND pipeline_id = $2 AND stage_name = $3 LIMIT 1`,
        [tenantId, pipelineId, s.name]
      );
      const sid = existingStage.rows[0]?.id || deterministicUuid(`ecolife:stage:${s.key}`);
      if (existingStage.rows.length === 0) {
        await client.query(
          `INSERT INTO tenant_pipeline_stages (id, tenant_id, pipeline_id, stage_key, stage_name, stage_order, color_hex, capi_event_mapping, is_won_stage, is_lost_stage)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
          [sid, tenantId, pipelineId, s.key, s.name, s.order, s.color, s.capi || 'Skip', s.won, s.lost]
        );
      }
      stageIds[s.key] = sid;
    }

    // 6. Connections (sheet_connections + field_mappings -> tenant_webhooks)
    const connUuidMap = new Map<number, string>();
    for (const sc of dumpConnections) {
      const scId = Number(sc.id);
      const wid = deterministicUuid(`ecolife:webhook:${scId}`);
      connUuidMap.set(scId, wid);
      const mappings = dumpFieldMappings
        .filter((f) => Number(f.connection_id) === scId)
        .map((f) => ({
          sheet_column: f.sheet_column,
          system_field: f.system_field,
          custom_label: f.custom_label || null,
        }));
      const sourceLabel = scId === 2 ? 'Facebook Ads' : scId === 3 ? 'Website ecolifesignature.vn' : 'Google Sheet';
      await client.query(
        `INSERT INTO tenant_webhooks (
          id, tenant_id, name, webhook_type, token, signing_secret, field_mappings, is_active, created_at
        ) VALUES ($1, $2, $3, 'inbound', $4, $5, $6::jsonb, $7, $8)`,
        [
          wid,
          tenantId,
          sc.sheet_name,
          `ecolife-conn-${scId}`,
          deterministicUuid(`ecolife:whsec:${scId}`),
          JSON.stringify({ source_label: sourceLabel, mappings }),
          Number(sc.is_active) === 1,
          parseSqlDate(sc.created_at),
        ]
      );
    }

    // 7. Distribution Rounds & Round Consultants & Routing Rules
    const roundUuidMap = new Map<number, string>();
    for (let idx = 0; idx < dumpRounds.length; idx++) {
      const r = dumpRounds[idx];
      const rid = deterministicUuid(`ecolife:round:${r.id}`);
      roundUuidMap.set(Number(r.id), rid);
      const lastUid = r.last_assigned_consultant_id ? consultantUuidMap.get(Number(r.last_assigned_consultant_id)) || null : null;
      await client.query(
        `INSERT INTO distribution_rounds (id, tenant_id, pipeline_id, name, description, cc_emails, last_assigned_consultant_id, priority, is_active)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
        [
          rid,
          tenantId,
          pipelineId,
          r.round_name,
          r.description || null,
          r.cc_emails || null,
          lastUid,
          idx + 1,
          Number(r.is_active) === 1,
        ]
      );
    }

    for (const rc of dumpRoundConsultants) {
      const rid = roundUuidMap.get(Number(rc.round_id));
      const uid = consultantUuidMap.get(Number(rc.consultant_id));
      if (!rid || !uid) continue;
      await client.query(
        `INSERT INTO round_consultants (
          id, tenant_id, round_id, user_id, receive_ratio, data_per_turn,
          current_turn_remaining, leads_received_in_round, compensation_count,
          skip_count, skipped_credit, is_active
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, 0, $8, $9, $10, $11)`,
        [
          deterministicUuid(`ecolife:rc:${rc.round_id}:${rc.consultant_id}`),
          tenantId,
          rid,
          uid,
          Math.max(1, Number(rc.receive_ratio || 1)),
          Math.max(1, Number(rc.data_per_turn || 1)),
          Number(rc.current_turn_remaining || 0),
          Number(rc.compensation_count || 0),
          Number(rc.skip_count || 0),
          Number(rc.skipped_credit || 0),
          Number(rc.is_active) === 1,
        ]
      );
    }

    for (const rr of dumpRoutingRules) {
      const rid = roundUuidMap.get(Number(rr.target_round_id));
      if (!rid) continue;
      let parsedBranches: any[] = [];
      let injectFields: Record<string, string> = {};
      try {
        const raw = JSON.parse(rr.conditions_json || '[]');
        if (Array.isArray(raw)) {
          parsedBranches = raw.map((branch: any) =>
            (branch.conditions || []).map((c: any) => ({
              field: c.col || 'source',
              op: c.op || 'equals',
              val: c.val || '',
            }))
          );
          const firstInject = raw.find((b: any) => b?.inject?.enabled && Array.isArray(b.inject.fields));
          if (firstInject) {
            for (const f of firstInject.inject.fields) {
              if (f.col) injectFields[f.col] = f.val || '';
            }
          }
        }
      } catch {}
      const scopes = String(rr.connection_id || 'all')
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
      await client.query(
        `INSERT INTO routing_rules (
          id, tenant_id, round_id, rule_name, priority, conditions_json,
          condition_branches, connection_scopes, inject_fields, is_active
        ) VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7::jsonb, $8::jsonb, $9::jsonb, true)`,
        [
          deterministicUuid(`ecolife:rule:${rr.id}`),
          tenantId,
          rid,
          `Rule #${rr.id} -> ${rr.target_round_id === 2 ? 'Meta Form' : 'Website'}`,
          Number(rr.priority || 0),
          JSON.stringify(parsedBranches[0] || []),
          JSON.stringify(parsedBranches),
          JSON.stringify(scopes),
          JSON.stringify(injectFields),
        ]
      );
    }

    // 8. AI Screener Config
    await client.query(
      `INSERT INTO ai_screener_configs (
        tenant_id, is_enabled, mode, model_name, prompt_rules, manual_action, manual_rules, updated_at
      ) VALUES (
        $1, $2, $3, $4, $5, $6, $7::jsonb, clock_timestamp()
      )
      ON CONFLICT (tenant_id) DO UPDATE SET
        is_enabled = $2, mode = $3, model_name = $4, prompt_rules = $5, manual_action = $6, updated_at = clock_timestamp()`,
      [
        tenantId,
        safeSettingsMap.ai_screener_enabled === '1',
        safeSettingsMap.ai_screener_mode || 'hybrid',
        safeSettingsMap.ai_screener_model || 'gemini-2.5-flash',
        safeSettingsMap.ai_screener_rules || 'Lọc lead EcoLife Signature đạt chuẩn SĐT và nhu cầu thực.',
        safeSettingsMap.ai_screener_manual_action || 'hold',
        safeSettingsMap.ai_screener_manual_rules || '[]',
      ]
    );

    // Build lookup from distribution_logs for round_id and duplicate reminders
    const leadRoundMap = new Map<number, string>();
    const reminderLeadIds = new Set<number>();
    const errorLeadIds = new Set<number>();
    for (const dl of dumpDistLogs) {
      const lid = Number(dl.lead_id);
      if (!lid) continue;
      if (dl.round_id && roundUuidMap.has(Number(dl.round_id))) {
        leadRoundMap.set(lid, roundUuidMap.get(Number(dl.round_id))!);
      }
      if (dl.status === 'reminder') reminderLeadIds.add(lid);
      if (dl.status === 'error') errorLeadIds.add(lid);
    }

    // 9. Migrate all 631 real leads
    const leadUuidMap = new Map<number, string>();
    const leadCountsByRoundConsultant: Record<string, { roundId: string; uid: string; count: number }> = {};
    let activeAssignedCount = 0;
    let archivedSilentCount = 0;
    let heldRejectedCount = 0;
    let blacklistedCount = 0;

    for (const l of dumpLeads) {
      const lid = Number(l.id);
      const createdAt = parseSqlDate(l.created_at);
      const phone = normalizePhone(l.phone, lid);
      const connId = l.connection_id ? connUuidMap.get(Number(l.connection_id)) || null : null;
      const roundId =
        (l.target_round_id ? roundUuidMap.get(Number(l.target_round_id)) : null) ||
        leadRoundMap.get(lid) ||
        (Number(l.connection_id) === 3 ? roundUuidMap.get(3) : roundUuidMap.get(2)) ||
        null;

      if (l.status === 'blacklisted') {
        blacklistedCount++;
        await client.query(
          `INSERT INTO blacklist_entries (id, tenant_id, entry_type, value, reason, created_by, created_at)
           VALUES ($1, $2, 'phone', $3, $4, $5, $6)`,
          [
            deterministicUuid(`ecolife:bl:${lid}`),
            tenantId,
            phone,
            l.ai_evaluation || 'Lead nằm trong danh sách đen (EcoLife)',
            primaryAdminId,
            createdAt,
          ]
        );
        await client.query(
          `INSERT INTO held_leads (
            id, tenant_id, round_id, connection_id, name, phone, email, source, campaign,
            ai_screener_status, ai_evaluation, hold_reason, status, payload_json, created_at
          ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'failed', $10, $10, 'blacklisted', $11::jsonb, $12)`,
          [
            deterministicUuid(`ecolife:held:bl:${lid}`),
            tenantId,
            roundId,
            connId,
            l.name || 'Không rõ tên',
            phone,
            l.email || null,
            l.source || 'Webhook',
            l.campaign_name || null,
            'Danh sách đen (Blacklisted)',
            JSON.stringify({ original_lead_id: lid, note: l.note }),
            createdAt,
          ]
        );
        continue;
      }

      if (l.status === 'rejected') {
        heldRejectedCount++;
        await client.query(
          `INSERT INTO held_leads (
            id, tenant_id, round_id, connection_id, name, phone, email, source, campaign,
            ai_screener_status, ai_evaluation, hold_reason, status, payload_json, created_at
          ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'failed', $10, $10, 'held', $11::jsonb, $12)`,
          [
            deterministicUuid(`ecolife:held:rej:${lid}`),
            tenantId,
            roundId,
            connId,
            l.name || 'Thiếu thông tin',
            phone,
            l.email || null,
            l.source || 'Webhook',
            l.campaign_name || null,
            l.ai_evaluation || 'Dưới chuẩn / bị từ chối bởi Gatekeeper',
            JSON.stringify({ original_lead_id: lid, note: l.note }),
            createdAt,
          ]
        );
        continue;
      }

      const assignedUid = l.assigned_to ? consultantUuidMap.get(Number(l.assigned_to)) || null : null;
      const isSilent = l.status === 'silent';
      const leadUuid = deterministicUuid(`ecolife:lead:${lid}`);
      leadUuidMap.set(lid, leadUuid);

      let stageId = stageIds.new;
      const q = String(l.quality_status || '').toLowerCase();
      if (q === 'closed' || q === 'won') stageId = stageIds.closed;
      else if (q === 'notlead') stageId = stageIds.notlead;
      else if (q === 'good' || q === 'qualified') stageId = stageIds.good;
      else if (Number(l.is_accepted) === 1) stageId = stageIds.good;

      const pgStatus = isSilent ? 'archived' : assignedUid ? 'assigned' : 'unassigned_pending';
      if (pgStatus === 'assigned') {
        activeAssignedCount++;
        if (assignedUid && roundId) {
          const k = `${roundId}:${assignedUid}`;
          if (!leadCountsByRoundConsultant[k]) {
            leadCountsByRoundConsultant[k] = { roundId, uid: assignedUid, count: 0 };
          }
          leadCountsByRoundConsultant[k].count += 1;
        }
      } else if (isSilent) {
        archivedSilentCount++;
      }

      const isDupRem = reminderLeadIds.has(lid);
      await client.query(
        `INSERT INTO leads (
          id, tenant_id, pipeline_id, stage_id, assigned_to, round_id, connection_id,
          status, name, phone, email, source, campaign,
          ad_id, adset_id, campaign_id, form_id, meta_lead_id, fbclid,
          custom_fields, is_accepted, accepted_at, is_duplicate_reminder, is_duplicated,
          ai_screener_status, ai_evaluation, ai_prompt_tokens, ai_completion_tokens,
          zalo_notify_status, email_notify_status, quality_status, quality_note,
          created_at, updated_at
        ) VALUES (
          $1, $2, $3, $4, $5, $6, $7,
          $8, $9, $10, $11, $12, $13,
          $14, $15, $16, $17, $18, $19,
          $20::jsonb, $21, $22, $23, $23,
          $24, $25, $26, $27,
          $28, $29, $30, $31,
          $32, $32
        )`,
        [
          leadUuid,
          tenantId,
          pipelineId,
          stageId,
          assignedUid,
          roundId,
          connId,
          pgStatus,
          (l.name || 'Khách hàng EcoLife').slice(0, 150),
          phone,
          l.email ? String(l.email).slice(0, 255) : null,
          String(l.source || 'Webhook').slice(0, 100),
          l.campaign_name ? String(l.campaign_name).slice(0, 150) : null,
          l.ad_id || null,
          l.adset_id || null,
          l.campaign_id || null,
          l.form_id || null,
          l.meta_lead_id || null,
          l.fbclid || null,
          JSON.stringify({
            original_mysql_id: lid,
            original_status: l.status,
            note: l.note || '',
            ad_name: l.ad_name || null,
            adset_name: l.adset_name || null,
            form_name: l.form_name || null,
            ad_platform: l.ad_platform || null,
          }),
          Number(l.is_accepted) === 1,
          l.accepted_at ? parseSqlDate(l.accepted_at) : null,
          isDupRem,
          l.ai_screener_status || 'not_screened',
          l.ai_evaluation || null,
          Number(l.ai_prompt_tokens || 0),
          Number(l.ai_completion_tokens || 0),
          l.zalo_notify_status || 'none',
          l.email_notify_status || 'none',
          (l.quality_status || 'Pending').slice(0, 50),
          l.quality_note || null,
          createdAt,
        ]
      );
    }

    // Update leads_received_in_round from actual migrated assigned leads per round & consultant
    for (const entry of Object.values(leadCountsByRoundConsultant)) {
      await client.query(
        `UPDATE round_consultants SET leads_received_in_round = $1 WHERE tenant_id = $2 AND user_id = $3 AND round_id = $4`,
        [entry.count, tenantId, entry.uid, entry.roundId]
      );
    }

    // 10. Migrate 5 real data_reports tickets
    for (const rep of dumpReports) {
      const leadUuid = leadUuidMap.get(Number(rep.lead_id));
      const uid = consultantUuidMap.get(Number(rep.consultant_id));
      if (!leadUuid || !uid) continue;
      await client.query(
        `INSERT INTO data_reports (
          id, tenant_id, lead_id, reporter_id, reason, description, status, resolved_by, resolution_note, compensation_granted, created_at, updated_at
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $11)`,
        [
          deterministicUuid(`ecolife:report:${rep.id}`),
          tenantId,
          leadUuid,
          uid,
          String(rep.reason || 'Số sai định dạng').slice(0, 100),
          rep.reason || null,
          rep.status === 'approved' ? 'approved' : rep.status === 'rejected' ? 'rejected' : 'pending',
          rep.status === 'approved' ? primaryAdminId : null,
          rep.approval_reason || rep.reject_reason || null,
          rep.status === 'approved',
          parseSqlDate(rep.created_at),
        ]
      );
    }

    // 11. Migrate Meta Ads Insights (aggregated from real meta_ads_cache + meta_ads_daily_insights)
    const cacheByAd = new Map<string, any>();
    for (const mc of dumpMetaCache) {
      cacheByAd.set(String(mc.ad_id), mc);
    }
    const dailyAggByAd = new Map<
      string,
      { spend: number; impressions: number; clicks: number; leads: number; minDate: string; maxDate: string }
    >();
    for (const d of dumpMetaDaily) {
      const adId = String(d.ad_id);
      const cur = dailyAggByAd.get(adId) || {
        spend: 0,
        impressions: 0,
        clicks: 0,
        leads: 0,
        minDate: String(d.date_start),
        maxDate: String(d.date_start),
      };
      cur.spend += Number(d.spend || 0);
      cur.impressions += Number(d.impressions || 0);
      cur.clicks += Number(d.clicks || 0);
      cur.leads += Number(d.meta_leads || 0);
      if (String(d.date_start) < cur.minDate) cur.minDate = String(d.date_start);
      if (String(d.date_start) > cur.maxDate) cur.maxDate = String(d.date_start);
      dailyAggByAd.set(adId, cur);
    }

    for (const [adId, mc] of cacheByAd.entries()) {
      const agg = dailyAggByAd.get(adId);
      const spend = Math.round(agg?.spend || Number(mc.spend || 0));
      const impressions = agg?.impressions || Number(mc.impressions || 0);
      const clicks = agg?.clicks || Number(mc.clicks || 0);
      const leadsCnt = agg?.leads || Number(mc.meta_leads || 0);
      if (spend === 0 && impressions === 0 && leadsCnt === 0) continue;
      const ctr = impressions > 0 ? Number(((clicks / impressions) * 100).toFixed(4)) : Number(mc.ctr || 0);
      const cpc = clicks > 0 ? Number((spend / clicks).toFixed(2)) : Number(mc.cpc || 0);
      const cpm = impressions > 0 ? Number(((spend / impressions) * 1000).toFixed(2)) : Number(mc.cpm || 0);
      await client.query(
        `INSERT INTO meta_ads_insights (
          id, tenant_id, date_start, date_stop, campaign_id, campaign_name, adset_id, adset_name,
          ad_id, ad_name, spend, impressions, clicks, reach, ctr, cpc, cpm, frequency, meta_leads,
          thumbnail_url, image_url, creative_title, creative_body, story_id, optimization_goal
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22, $23, $24, $25)`,
        [
          deterministicUuid(`ecolife:meta_ad:${adId}`),
          tenantId,
          agg?.minDate || '2026-10-01',
          agg?.maxDate || '2026-11-16',
          mc.campaign_id || adId,
          (mc.campaign_name || 'EcoLife Signature').slice(0, 255),
          mc.adset_id || null,
          (mc.adset_name || '').slice(0, 255),
          adId,
          (mc.ad_name || adId).slice(0, 255),
          spend,
          impressions,
          clicks,
          Number(mc.reach || 0),
          ctr,
          cpc,
          cpm,
          Number(mc.frequency || 1),
          leadsCnt,
          mc.thumbnail_url || null,
          mc.image_url || null,
          mc.creative_title || null,
          mc.creative_body || null,
          mc.effective_object_story_id || null,
          mc.optimization_goal || null,
        ]
      );
    }

    // 12. Migrate latest admin_logs -> admin_audit_logs (last 60 entries)
    for (const al of dumpAdminLogs.slice(-60)) {
      let parsedDetails: Record<string, unknown> = {};
      try {
        parsedDetails = al.details ? JSON.parse(al.details) : {};
      } catch {
        parsedDetails = { raw: String(al.details || '') };
      }
      await client.query(
        `INSERT INTO admin_audit_logs (id, tenant_id, actor_id, actor_name, action, entity_type, details, is_rolled_back, created_at)
         VALUES ($1, $2, $3, 'EcoLife Admin', $4, $5, $6::jsonb, $7, $8)`,
        [
          deterministicUuid(`ecolife:audit:${al.id}`),
          tenantId,
          accountUuidMap.get(Number(al.account_id)) || primaryAdminId,
          String(al.action || 'ADMIN_ACTION').slice(0, 100),
          String(al.log_type || 'system').slice(0, 60),
          JSON.stringify(parsedDetails),
          Number(al.is_rolled_back) === 1,
          parseSqlDate(al.created_at),
        ]
      );
    }

    // Verification checks
    const adminCheck = await client.query<{ password_hash: string }>(
      `SELECT password_hash FROM users WHERE tenant_id = $1 AND LOWER(email) = $2 LIMIT 1`,
      [tenantId, ECOLIFE_ADMIN_EMAIL]
    );
    if (!adminCheck.rows[0] || !(await verifyPassword(ECOLIFE_ADMIN_PASSWORD, adminCheck.rows[0].password_hash))) {
      throw new Error('Admin turniodev@gmail.com verification failed!');
    }
    const capiRes = await client.query<{ cnt: number }>(
      `SELECT COUNT(*)::int AS cnt FROM capi_logs WHERE tenant_id = $1`,
      [tenantId]
    );
    if (capiRes.rows[0].cnt !== 0) {
      throw new Error('Silent mode violation: capi_logs was generated during migration!');
    }

    const totalMigrated = activeAssignedCount + archivedSilentCount + heldRejectedCount + blacklistedCount;
    console.log(
      `Migrated EcoLife dump: ${totalMigrated} leads (active_assigned=${activeAssignedCount}, archived_silent=${archivedSilentCount}, held=${heldRejectedCount}, blacklisted=${blacklistedCount}), ${dumpReports.length} tickets, ${dumpManagers.length} co-managers.`
    );

    return {
      success: true,
      tenantId,
      totalSourceLeads: dumpLeads.length,
      totalMigrated,
      activeAssignedCount,
      archivedSilentCount,
      heldRejectedCount,
      blacklistedCount,
      ticketsCount: dumpReports.length,
      duplicateRemindersCount: reminderLeadIds.size,
      consultantsCount: consultantUuidMap.size,
    };
  } finally {
    client.release();
  }
}

if (import.meta.url === `file:///${process.argv[1]?.replace(/\\/g, '/')}` || process.argv[1]?.endsWith('migrate-ecolife-data.ts')) {
  migrateEcoLifeData()
    .then(async () => {
      const pool = getDatabasePool();
      await pool.close();
      process.exit(0);
    })
    .catch(async (err) => {
      console.error('❌ ECOLIFE REAL DUMP MIGRATION FAILED:', err);
      try {
        const pool = getDatabasePool();
        await pool.close();
      } catch {}
      process.exit(1);
    });
}
