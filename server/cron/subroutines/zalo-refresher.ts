import { refreshExpiringZaloTokens } from '../../services/zalo-mail.service.ts';

export async function runZaloTokenRefresher(
  tenantIdFilter?: string
): Promise<{ refreshedCount: number; failedCount: number }> {
  // Proactively refreshes any active token expiring in <= 4 hours
  const result = await refreshExpiringZaloTokens(tenantIdFilter);
  return {
    refreshedCount: result.refreshedCount,
    failedCount: result.failedCount,
  };
}
