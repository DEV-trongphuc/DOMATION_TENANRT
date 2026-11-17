import fs from 'node:fs';
import path from 'node:path';
import pg from 'pg';
import mysql, { type Pool, type PoolConnection } from 'mysql2/promise';
import { PGlite } from '@electric-sql/pglite';
import { uuid_ossp } from '@electric-sql/pglite/contrib/uuid_ossp';
import { btree_gin } from '@electric-sql/pglite/contrib/btree_gin';
import { APP_CONFIG } from '../../config.ts';
import { translatePostgresSqlToMariaDb } from './sql-translator.ts';

export type DatabaseDialect = 'postgres' | 'mariadb';

export interface QueryResultRow {
  [column: string]: any;
}

export interface DbQueryResult<R extends QueryResultRow = any> {
  rows: R[];
  rowCount: number;
}

export interface DbClient {
  dialect: DatabaseDialect;
  query<R extends QueryResultRow = any>(sql: string, params?: any[]): Promise<DbQueryResult<R>>;
  exec?(sql: string): Promise<void>;
  release(): void;
}

export interface DatabasePool {
  dialect: DatabaseDialect;
  isEmbedded: boolean;
  connect(): Promise<DbClient>;
  close(): Promise<void>;
}

/**
 * Detects whether a parameterless SQL string contains more than one top-level SQL statement
 * (ignoring semicolons inside single quotes, double quotes, line comments, or $$ dollar-quoted blocks).
 */
function hasMultipleTopLevelStatements(sql: string): boolean {
  let statementCount = 0;
  let hasContent = false;
  let i = 0;
  const len = sql.length;

  while (i < len) {
    const ch = sql[i];
    if (/\s/.test(ch)) {
      i++;
      continue;
    }
    if (ch === '-' && sql[i + 1] === '-') {
      while (i < len && sql[i] !== '\n') i++;
      continue;
    }
    if (ch === '/' && sql[i + 1] === '*') {
      i += 2;
      while (i < len && !(sql[i] === '*' && sql[i + 1] === '/')) i++;
      i += 2;
      continue;
    }
    if (ch === "'" || ch === '"') {
      hasContent = true;
      const q = ch;
      i++;
      while (i < len) {
        if (sql[i] === q) {
          if (sql[i + 1] === q) {
            i += 2;
            continue;
          }
          i++;
          break;
        }
        if (q === "'" && sql[i] === '\\') i++;
        i++;
      }
      continue;
    }
    if (ch === '$') {
      const tagMatch = sql.slice(i).match(/^\$[A-Za-z0-9_]*\$/);
      if (tagMatch) {
        hasContent = true;
        const tag = tagMatch[0];
        const endIdx = sql.indexOf(tag, i + tag.length);
        i = endIdx === -1 ? len : endIdx + tag.length;
        continue;
      }
    }
    if (ch === ';') {
      if (hasContent) {
        statementCount++;
        hasContent = false;
        if (statementCount > 1) return true;
      }
      i++;
      continue;
    }
    hasContent = true;
    i++;
  }
  if (hasContent) statementCount++;
  return statementCount > 1;
}

export class PGlitePoolAdapter {
  private pglitePromise: Promise<PGlite> | null = null;
  private checkoutChain: Promise<void> = Promise.resolve();
  private dataDir?: string;
  public readonly dialect: DatabaseDialect = 'postgres';

  constructor(dataDir?: string) {
    this.dataDir = dataDir;
  }

  async getInstance(): Promise<PGlite> {
    if (!this.pglitePromise) {
      if (this.dataDir) {
        try {
          const pidPath = path.join(this.dataDir, 'postmaster.pid');
          if (fs.existsSync(pidPath)) {
            console.log(`[db-adapter] Removing stale postmaster.pid at: ${pidPath}`);
            fs.unlinkSync(pidPath);
          }
        } catch (err) {
          console.warn('[db-adapter] Warning removing stale postmaster.pid:', err);
        }
      }
      this.pglitePromise = PGlite.create({
        dataDir: this.dataDir || undefined,
        extensions: {
          uuid_ossp,
          btree_gin,
        },
      });
    }
    return this.pglitePromise;
  }

  async connect(): Promise<DbClient> {
    const db = await this.getInstance();
    const prev = this.checkoutChain;
    let releaseMutex!: () => void;
    const current = new Promise<void>((resolve) => {
      releaseMutex = resolve;
    });
    const nextChain = prev.then(() => current);
    this.checkoutChain = nextChain;

    await prev;

    let released = false;

    return {
      dialect: 'postgres',
      async query<R extends QueryResultRow = any>(sql: string, params?: any[]): Promise<DbQueryResult<R>> {
        if ((!params || params.length === 0) && hasMultipleTopLevelStatements(sql)) {
          const results = await db.exec(sql);
          const last = Array.isArray(results) && results.length > 0 ? results[results.length - 1] : undefined;
          return {
            rows: (last?.rows ?? []) as R[],
            rowCount: last?.affectedRows ?? (Array.isArray(last?.rows) ? last.rows.length : 0),
          };
        }
        const res = await db.query<R>(sql, params);
        return {
          rows: res.rows,
          rowCount: res.affectedRows ?? res.rows.length,
        };
      },
      async exec(sql: string): Promise<void> {
        await db.exec(sql);
      },
      release() {
        if (!released) {
          released = true;
          releaseMutex();
        }
      },
    };
  }

  async close(): Promise<void> {
    if (this.pglitePromise) {
      await this.checkoutChain.catch(() => {});
      // Allow WASM memory and microtasks to settle before triggering shutdown
      await new Promise((resolve) => setTimeout(resolve, 150));
      const db = await this.pglitePromise;
      try {
        await db.close();
      } catch (err: any) {
        if (!err?.message?.includes('Aborted')) {
          console.warn('[db-adapter] Warning during PGlite close:', err);
        }
      } finally {
        this.pglitePromise = null;
      }
    }
  }
}

export class NodePgPoolAdapter {
  private pool: pg.Pool;
  public readonly dialect: DatabaseDialect = 'postgres';

  constructor(connectionString: string) {
    this.pool = new pg.Pool({
      connectionString,
      max: APP_CONFIG.dbPoolMax,
      idleTimeoutMillis: APP_CONFIG.dbIdleTimeoutMs,
      connectionTimeoutMillis: APP_CONFIG.dbConnectionTimeoutMs,
      keepAlive: true,
      statement_timeout: 30000,
    });

    this.pool.on('error', (err) => {
      console.error('[DB] Unexpected idle client error', { err });
    });
  }

  async connect(): Promise<DbClient> {
    const client = await this.pool.connect();
    return {
      dialect: 'postgres',
      async query<R extends QueryResultRow = any>(sql: string, params?: any[]): Promise<DbQueryResult<R>> {
        const res = await client.query<R>(sql, params);
        return {
          rows: res.rows,
          rowCount: res.rowCount ?? res.rows.length,
        };
      },
      async exec(sql: string): Promise<void> {
        await client.query(sql);
      },
      release() {
        client.release();
      },
    };
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}

export const MARIADB_JSON_COLS = new Set([
  // Core / Wave 1 JSON columns
  'settings',
  'custom_fields',
  'metadata',
  'payload',
  'config_json',
  'completed_steps',
  'options_json',
  'stage_visibility',
  'conditions_json',
  'setting_value',
  'field_mappings',
  'subscribed_events',
  'work_schedule',
  'match_keys',
  'sent_payload',
  'response_body',
  'badge_style',
  'screen_tours',
  'condition_branches',
  'connection_scopes',
  'inject_fields',
  'manual_rules',
  'target_round_ids',
  'payload_json',
  'before_snapshot',
  'after_snapshot',
  'details',
  'enabled_modules',
  'entitlements',
  'actions',
  'required_fields',
  'allowed_role_ids',
  'allowed_roles',
  'auto_task_templates',
  'notify_role_ids',
  'filter_branches',
  'variables_schema',
  'allowed_department_ids',
  'sync_config',
  // Wave 2 + Full-Clone Stage 1-4 JSON columns
  'items_json',
  'form_schema',
  'pit_brackets',
  'allowance_definitions',
  'tiers_json',
  'breakdown',
  'allowances_json',
  'working_days',
  'availability_rules',
  'custom_questions',
  'blocks_json',
  'channels_json',
  'checklist_json',
  'qr_design_json',
  'steps_json',
  'trigger_config',
  'whiteboard_json',
  'task_columns_json',
  'whiteboard_elements',
  'settings_json',
  'fields_json',
  'targets_json',
  'faq_rules',
  'guardrail_rules',
  'tool_calls',
  'citations',
  'args_summary',
  'reminder_config',
  'merge_tags',
  'tags_applied',
  'answers_json',
  'analytics_json',
  'metadata_json',
  'extra_json',
  'form_data',
  'categories_json',
  'history_json',
  'attachments_json',
  'reactions_json',
  'line_items_json',
  'branch_ip_whitelist',
  'screen_access',
  'quick_actions',
  'holiday_schedules_json',
  'audit_payload',
  'snapshot_json',
  'ab_variants_json',
  'utm_params',
  'extracted_data',
  // Additional Wave 2 schema JSON columns
  'appscript_response',
  'attachments',
  'body_style',
  'branch_verification_json',
  'categories',
  'contacts_json',
  'dependencies_json',
  'exclude_audience_ids',
  'execution_trace',
  'extracted_entities',
  'extracted_fields_json',
  'faq_rules_json',
  'resolved_steps_snapshot',
  'schema_json',
  'submitted_data',
  'thank_you_json',
  'theme_json',
  'utm_data',
  'utm_json',
  'points_json',
  'heatmap_data',
  'keywords_json',
  'nodes_json',
  'edges_json',
  'params_schema_json',
  'saved_blocks_json',
  'redirect_rules_json',
  'fallback_vars_json',
  'mentions_json',
  'watchers_json',
  'cc_emails',
  'condition_json',
  'details_json',
  'edit_history_json',
  'participant_ids_json',
  'tags_json',
  'target_departments_json',
  'target_roles_json',
  'target_user_ids_json',
  'variables_json',
]);

/**
 * Safely parses JSON values returned by MariaDB for explicit JSON columns
 * or arbitrary `*_json` columns when they contain valid JSON objects/arrays.
 */
export function parseMariaDbJsonFieldValue(colName: string, raw: string | null): unknown {
  if (raw === null || raw === undefined) return null;
  if (MARIADB_JSON_COLS.has(colName)) {
    if (!raw) return null;
    try {
      return JSON.parse(raw);
    } catch {
      return raw;
    }
  }
  if (colName.endsWith('_json')) {
    const trimmed = raw.trim();
    if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
      try {
        const parsed = JSON.parse(trimmed);
        if (parsed !== null && typeof parsed === 'object') {
          return parsed;
        }
      } catch {
        return raw;
      }
    }
  }
  return raw;
}

export interface MinimalMariaDbConnection {
  query<T = any>(sql: string, params?: any[]): Promise<[T, any]>;
}

/**
 * Executes a translated PostgreSQL query on a MariaDB connection, polyfilling
 * UPDATE/DELETE/INSERT ... RETURNING cleanly.
 */
export async function executeMariaDbQueryWithPolyfill<R extends QueryResultRow = any>(
  conn: MinimalMariaDbConnection,
  sql: string,
  params?: any[]
): Promise<DbQueryResult<R>> {
  const translated = translatePostgresSqlToMariaDb(sql, params);

  if (translated.isUpdateReturning && translated.updateMeta) {
    const meta = translated.updateMeta;
    const pkCol = meta.pkCol || (meta.table.toLowerCase() === 'platform_settings' ? 'setting_key' : 'id');
    const aliasSql = meta.alias ? ` ${meta.alias}` : '';
    const pkQualified = meta.alias ? `${meta.alias}.${pkCol}` : pkCol;
    const whereSql = meta.whereClause ? `WHERE ${meta.whereClause}` : '';
    const [preRows] = await conn.query<any[]>(
      `SELECT ${pkQualified} FROM ${meta.table}${aliasSql} ${whereSql} FOR UPDATE`,
      meta.whereParams || []
    );
    if (!Array.isArray(preRows) || preRows.length === 0) {
      await conn.query(translated.sql, translated.params);
      return { rows: [], rowCount: 0 };
    }
    const ids = preRows.map((r: any) => r[pkCol]);
    await conn.query(translated.sql, translated.params);
    const placeholders = ids.map(() => '?').join(', ');
    const [postRows] = await conn.query<any[]>(
      `SELECT ${meta.returningCols} FROM ${meta.table}${aliasSql} WHERE ${pkQualified} IN (${placeholders})`,
      ids
    );
    return {
      rows: (Array.isArray(postRows) ? postRows : []) as R[],
      rowCount: ids.length,
    };
  }

  if (translated.isDeleteReturning && translated.deleteMeta) {
    const meta = translated.deleteMeta;
    const aliasSql = meta.alias ? ` ${meta.alias}` : '';
    const whereSql = meta.whereClause ? `WHERE ${meta.whereClause}` : '';
    const [preRows] = await conn.query<any[]>(
      `SELECT ${meta.returningCols} FROM ${meta.table}${aliasSql} ${whereSql} FOR UPDATE`,
      meta.whereParams || []
    );
    if (!Array.isArray(preRows) || preRows.length === 0) {
      await conn.query(translated.sql, translated.params);
      return { rows: [], rowCount: 0 };
    }
    await conn.query(translated.sql, translated.params);
    return {
      rows: preRows as R[],
      rowCount: preRows.length,
    };
  }

  if (translated.isInsertReturning && translated.insertMeta) {
    const meta = translated.insertMeta;
    const [res] = await conn.query<any>(translated.sql, translated.params);
    if (Array.isArray(res)) {
      return {
        rows: res as R[],
        rowCount: res.length,
      };
    }
    const header = res as mysql.ResultSetHeader;
    if (meta.hasOnConflict && /\bINSERT\s+IGNORE\b/i.test(translated.sql) && (header?.affectedRows ?? 0) === 0) {
      return { rows: [] as R[], rowCount: 0 };
    }
    if (meta.keyWhereClause) {
      const [postRows] = await conn.query<any[]>(
        `SELECT ${meta.returningCols} FROM ${meta.table} WHERE ${meta.keyWhereClause}`,
        meta.keyParams || []
      );
      const rowsArr = Array.isArray(postRows) ? postRows : [];
      return {
        rows: rowsArr as R[],
        rowCount: rowsArr.length,
      };
    }
    if (header?.insertId && Number(header.insertId) > 0) {
      const [postRows] = await conn.query<any[]>(
        `SELECT ${meta.returningCols} FROM ${meta.table} WHERE ${meta.pkCol} = ?`,
        [header.insertId]
      );
      const rowsArr = Array.isArray(postRows) ? postRows : [];
      return {
        rows: rowsArr as R[],
        rowCount: rowsArr.length,
      };
    }
    return {
      rows: [] as R[],
      rowCount: header?.affectedRows ?? 0,
    };
  }

  const [res] = await conn.query(translated.sql, translated.params);
  if (Array.isArray(res)) {
    return {
      rows: res as R[],
      rowCount: res.length,
    };
  }
  const header = res as mysql.ResultSetHeader;
  return {
    rows: [] as R[],
    rowCount: header?.affectedRows ?? 0,
  };
}

export class MariaDbPoolAdapter {
  private pool: Pool;
  public readonly dialect: DatabaseDialect = 'mariadb';

  constructor(options: {
    connectionString?: string;
    host?: string;
    port?: number;
    user?: string;
    password?: string;
    database?: string;
  }) {
    const poolConfig: mysql.PoolOptions = {
      waitForConnections: true,
      connectionLimit: APP_CONFIG.dbPoolMax,
      idleTimeout: APP_CONFIG.dbIdleTimeoutMs,
      queueLimit: 0,
      enableKeepAlive: true,
      keepAliveInitialDelay: 10000,
      multipleStatements: true,
      charset: 'utf8mb4',
      typeCast: (field, next) => {
        if (field.type === 'JSON') {
          const val = field.string();
          return val ? JSON.parse(val) : null;
        }
        if (field.type === 'BLOB' || field.type === 'VAR_STRING' || field.type === 'STRING') {
          if (MARIADB_JSON_COLS.has(field.name) || field.name.endsWith('_json')) {
            return parseMariaDbJsonFieldValue(field.name, field.string());
          }
        }
        if (field.type === 'TINY' && field.length === 1) {
          const val = field.string();
          return val === null ? null : val === '1';
        }
        return next();
      },
    };

    if (options.connectionString && (options.connectionString.startsWith('mysql') || options.connectionString.startsWith('mariadb'))) {
      poolConfig.uri = options.connectionString;
    } else {
      poolConfig.host = options.host || '127.0.0.1';
      poolConfig.port = options.port || 3306;
      poolConfig.user = options.user;
      poolConfig.password = options.password;
      poolConfig.database = options.database;
    }

    this.pool = mysql.createPool(poolConfig);
  }

  async connect(): Promise<DbClient> {
    const conn: PoolConnection = await this.pool.getConnection();
    await conn.query("SET sql_mode = CONCAT(@@sql_mode, ',PIPES_AS_CONCAT,ANSI_QUOTES')");
    let released = false;

    return {
      dialect: 'mariadb',
      async query<R extends QueryResultRow = any>(sql: string, params?: any[]): Promise<DbQueryResult<R>> {
        return executeMariaDbQueryWithPolyfill<R>(conn as unknown as MinimalMariaDbConnection, sql, params);
      },

      async exec(sql: string): Promise<void> {
        await conn.query(sql);
      },

      release() {
        if (!released) {
          released = true;
          conn.query('SELECT RELEASE_ALL_LOCKS()').catch(() => {}).finally(() => {
            conn.release();
          });
        }
      },
    };
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}

let activePool: DatabasePool | null = null;

export function createDatabasePool(options?: {
  inMemory?: boolean;
  databaseUrl?: string;
  dataDir?: string;
  dialect?: DatabaseDialect;
}): DatabasePool {
  const isMaria =
    options?.dialect === 'mariadb' ||
    APP_CONFIG.dbDialect === 'mariadb' ||
    Boolean(options?.databaseUrl?.startsWith('mysql')) ||
    Boolean(options?.databaseUrl?.startsWith('mariadb')) ||
    Boolean(APP_CONFIG.databaseUrl?.startsWith('mysql')) ||
    Boolean(APP_CONFIG.databaseUrl?.startsWith('mariadb'));

  if (isMaria) {
    const mariaAdapter = new MariaDbPoolAdapter({
      connectionString: options?.databaseUrl ?? APP_CONFIG.databaseUrl,
      host: APP_CONFIG.dbHost,
      port: APP_CONFIG.dbPort,
      user: APP_CONFIG.dbUser,
      password: APP_CONFIG.dbPassword,
      database: APP_CONFIG.dbName,
    });
    const poolInstance: DatabasePool = {
      dialect: 'mariadb',
      isEmbedded: false,
      connect: () => mariaAdapter.connect(),
      close: async () => {
        await mariaAdapter.close();
        if (activePool === poolInstance) {
          activePool = null;
        }
      },
    };
    return poolInstance;
  }

  const dbUrl = options?.databaseUrl ?? APP_CONFIG.databaseUrl;
  if (dbUrl) {
    const pgAdapter = new NodePgPoolAdapter(dbUrl);
    const poolInstance: DatabasePool = {
      dialect: 'postgres',
      isEmbedded: false,
      connect: () => pgAdapter.connect(),
      close: async () => {
        await pgAdapter.close();
        if (activePool === poolInstance) {
          activePool = null;
        }
      },
    };
    return poolInstance;
  }

  const targetDir = options?.inMemory ? undefined : (options?.dataDir ?? APP_CONFIG.pgliteDataDir);
  const pgliteAdapter = new PGlitePoolAdapter(targetDir);
  const poolInstance: DatabasePool = {
    dialect: 'postgres',
    isEmbedded: true,
    connect: () => pgliteAdapter.connect(),
    close: async () => {
      await pgliteAdapter.close();
      if (activePool === poolInstance) {
        activePool = null;
      }
    },
  };
  return poolInstance;
}

export function getDatabasePool(): DatabasePool {
  if (!activePool) {
    activePool = createDatabasePool();
  }
  return activePool;
}

export function setDatabasePool(pool: DatabasePool | null): void {
  activePool = pool;
}

export function resetDatabasePool(): void {
  activePool = null;
}
