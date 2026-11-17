import { createApp } from './app.ts';
import { APP_CONFIG } from './config.ts';
import { runMigrations } from './core/database/migrate.ts';
import { getDatabasePool } from './core/database/db-adapter.ts';
import { refreshExpiringZaloTokens } from './services/zalo-mail.service.ts';
import { sweepExpiredSlaTimeouts } from './services/distribution.service.ts';

async function bootstrap(): Promise<void> {
  await runMigrations({ seedSuperAdmin: true });
  const app = createApp();

  // Proactive background timers decoupled for production (handled by standalone master-cron)
  let zaloRefreshTimer: NodeJS.Timeout | undefined;
  let slaSweepTimer: NodeJS.Timeout | undefined;

  if (process.env.DISABLE_IN_PROCESS_CRON !== 'true' && APP_CONFIG.nodeEnv === 'development' && !process.env.CRON_CLI) {
    zaloRefreshTimer = setInterval(() => {
      void refreshExpiringZaloTokens().catch(() => {});
    }, 2 * 3600 * 1000);
    zaloRefreshTimer.unref();

    slaSweepTimer = setInterval(() => {
      void sweepExpiredSlaTimeouts().catch(() => {});
    }, 60 * 1000);
    slaSweepTimer.unref();
  }

  const isSocket = typeof APP_CONFIG.port === 'string';
  const isPassenger = Boolean(
    process.env.PASSENGER_PORT ||
      process.env.PASSENGER_BASE_URI ||
      process.env.PASSENGER_APP_ENV ||
      process.env.LSWS_CHILDREN
  );
  const pool = getDatabasePool();
  const dbEngineDesc = (pool as any).dialect === 'mariadb'
    ? 'MariaDB 10.6 InnoDB Pool'
    : pool.isEmbedded
      ? 'Embedded PostgreSQL 16 Kernel RLS'
      : 'PostgreSQL Pool';

  const server =
    isSocket || isPassenger
      ? app.listen(APP_CONFIG.port, () => {
          console.log(`[AutoData SaaS] Multi-Tenant Engine listening on ${APP_CONFIG.port} (DB: ${dbEngineDesc})`);
        })
      : app.listen(APP_CONFIG.port as number, '0.0.0.0', 4096, () => {
          console.log(`[AutoData SaaS] Multi-Tenant Engine listening on http://localhost:${APP_CONFIG.port} (DB: ${dbEngineDesc})`);
        });

  // Tune HTTP keep-alive timeouts above standard 60s reverse-proxy idle timeouts (ALB / Nginx / Cloudflare)
  server.keepAliveTimeout = 65_000;
  server.headersTimeout = 66_000;
  server.maxRequestsPerSocket = 0;

  const shutdown = async () => {
    clearInterval(zaloRefreshTimer);
    clearInterval(slaSweepTimer);
    server.close();
    await getDatabasePool().close();
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

bootstrap().catch((err) => {
  console.error('[AutoData SaaS] Fatal startup error:', err);
  process.exit(1);
});
