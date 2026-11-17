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
          const jsonCols = new Set([
            'settings',
            'custom_fields',
            'metadata',
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
          ]);
          if (jsonCols.has(field.name)) {
            const val = field.string();
            if (!val) return null;
            try {
              return JSON.parse(val);
            } catch {
              return val;
            }
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
        const translated = translatePostgresSqlToMariaDb(sql, params);

        if (translated.isUpdateReturning && translated.updateMeta) {
          const meta = translated.updateMeta;
          const pkCol = meta.pkCol || (meta.table.toLowerCase() === 'platform_settings' ? 'setting_key' : 'id');
          const whereSql = meta.whereClause ? `WHERE ${meta.whereClause}` : '';
          const [preRows] = await conn.query<any[]>(
            `SELECT ${pkCol} FROM ${meta.table} ${whereSql} FOR UPDATE`,
            (meta as any).whereParams || []
          );
          if (!Array.isArray(preRows) || preRows.length === 0) {
            await conn.query(translated.sql, translated.params);
            return { rows: [], rowCount: 0 };
          }
          const ids = preRows.map((r: any) => r[pkCol]);
          await conn.query(translated.sql, translated.params);
          const placeholders = ids.map(() => '?').join(', ');
          const [postRows] = await conn.query<any[]>(
            `SELECT ${meta.returningCols} FROM ${meta.table} WHERE ${pkCol} IN (${placeholders})`,
            ids
          );
          return {
            rows: (Array.isArray(postRows) ? postRows : []) as R[],
            rowCount: ids.length,
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
