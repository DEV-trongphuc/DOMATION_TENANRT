import fs from 'node:fs';
import path from 'node:path';

if (!process.execArgv.includes('--test') && !process.argv.includes('--test')) {
  try {
    const envPath = path.resolve(process.cwd(), '.env');
    if (fs.existsSync(envPath)) {
      const content = fs.readFileSync(envPath, 'utf8');
      for (const rawLine of content.split(/\r?\n/)) {
        const line = rawLine.trim();
        if (!line || line.startsWith('#')) continue;
        const eqIdx = line.indexOf('=');
        if (eqIdx <= 0) continue;
        const key = line.slice(0, eqIdx).trim();
        let val = line.slice(eqIdx + 1).trim();
        if (
          (val.startsWith('"') && val.endsWith('"')) ||
          (val.startsWith("'") && val.endsWith("'"))
        ) {
          val = val.slice(1, -1);
        }
        if (val !== '' && !process.env[key]) {
          process.env[key] = val;
        }
      }
    }
  } catch {
    // Ignore optional .env load failure
  }
}

const rawPort = process.env.PORT || '3100';

export const APP_CONFIG = {
  port: (isNaN(Number(rawPort)) ? rawPort : Number(rawPort)) as number | string,
  nodeEnv: process.env.NODE_ENV || 'development',
  appPublicUrl:
    (process.env.APP_PUBLIC_URL || '').trim().replace(/\/+$/, '') ||
    (process.env.NODE_ENV === 'production' ? 'https://data.domation.net' : ''),
  dbDialect: (process.env.DB_DIALECT ||
    (process.env.DATABASE_URL?.startsWith('mysql') || process.env.DATABASE_URL?.startsWith('mariadb')
      ? 'mariadb'
      : 'postgres')) as 'postgres' | 'mariadb',
  databaseUrl: process.env.DATABASE_URL || '',
  dbHost: process.env.DB_HOST || '127.0.0.1',
  dbPort: Number(process.env.DB_PORT || (process.env.DB_DIALECT === 'mariadb' ? 3306 : 5432)),
  dbUser: process.env.DB_USER || '',
  dbPassword: process.env.DB_PASSWORD || '',
  dbName: process.env.DB_NAME || '',
  pgliteDataDir: process.env.PGLITE_DATA_DIR || './.autodata-pgdata',
  jwtSecret: process.env.JWT_SECRET || 'autodata-enterprise-tenant-jwt-secret-2026',
  platformJwtSecret: process.env.PLATFORM_JWT_SECRET || 'autodata-platform-superadmin-jwt-secret-2026',
  cronSecret: process.env.CRON_SECRET || '',
  vaultMasterSecret: process.env.VAULT_MASTER_SECRET || 'autodata-aes256gcm-master-vault-secret-2026',
  superadminEmail: process.env.SUPERADMIN_EMAIL || 'ops-admin@autodata.vn',
  superadminPassword: process.env.SUPERADMIN_PASSWORD || 'SuperAdminMasterPassword999!',
  dbPoolMax: Math.max(5, Number(process.env.DB_POOL_MAX || 50)),
  dbIdleTimeoutMs: Math.max(1000, Number(process.env.DB_IDLE_TIMEOUT_MS || 30_000)),
  dbConnectionTimeoutMs: Math.max(1000, Number(process.env.DB_CONNECTION_TIMEOUT_MS || 10_000)),
  bcryptRounds: Math.min(14, Math.max(8, Number(process.env.BCRYPT_ROUNDS || 10))),
  queueConcurrency: Math.max(4, Number(process.env.QUEUE_CONCURRENCY || 64)),
  queuePerTenantConcurrency: Math.max(1, Number(process.env.QUEUE_PER_TENANT_CONCURRENCY || 8)),
  tenantCacheTtlSeconds: Math.max(5, Number(process.env.TENANT_CACHE_TTL_SECONDS || 60)),
  telegramBotToken: process.env.TELEGRAM_BOT_TOKEN || '',
  telegramChatId: process.env.TELEGRAM_CHAT_ID || '',
  telegramSilentMode:
    process.env.TELEGRAM_SILENT_MODE !== undefined
      ? process.env.TELEGRAM_SILENT_MODE === 'true'
      : (process.env.NODE_ENV || 'development') !== 'production',
  telegramNotifyEnabled:
    process.env.TELEGRAM_NOTIFY_ENABLED !== undefined
      ? process.env.TELEGRAM_NOTIFY_ENABLED === 'true'
      : true,
  TELEGRAM_BOT_TOKEN: process.env.TELEGRAM_BOT_TOKEN || '',
  TELEGRAM_CHAT_ID: process.env.TELEGRAM_CHAT_ID || '',
  TELEGRAM_SILENT_MODE:
    process.env.TELEGRAM_SILENT_MODE !== undefined
      ? process.env.TELEGRAM_SILENT_MODE === 'true'
      : (process.env.NODE_ENV || 'development') !== 'production',
  TELEGRAM_NOTIFY_ENABLED:
    process.env.TELEGRAM_NOTIFY_ENABLED !== undefined
      ? process.env.TELEGRAM_NOTIFY_ENABLED === 'true'
      : true,
  googleClientId:
    (process.env.GOOGLE_CLIENT_ID || process.env.VITE_GOOGLE_CLIENT_ID || '').trim() ||
    '641158233158-nsg8a8tdsj3fdgb34dc9tugm8god7tho.apps.googleusercontent.com',
};
