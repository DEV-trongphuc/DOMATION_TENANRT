export function isOutboundSilentMode(): boolean {
  return (
    process.env.OUTBOUND_SILENT_MODE === 'true' ||
    process.env.TELEGRAM_SILENT_MODE === 'true' ||
    process.env.MIGRATION_SILENT_MODE === 'true' ||
    process.env.NODE_ENV === 'test' ||
    process.env.VITEST === 'true'
  );
}

export function isLocalLoopbackUrl(rawUrl: string): boolean {
  try {
    const parsed = new URL(rawUrl);
    const host = parsed.hostname.toLowerCase();
    return host === '127.0.0.1' || host === 'localhost' || host === '::1';
  } catch {
    return false;
  }
}
