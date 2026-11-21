#!/usr/bin/env bash
set -euo pipefail
export NODE_ENV=production
APP_DIR="${APP_DIR:-/home/vhvxoigh/data.domation.net}"
cd "$APP_DIR"

read_env_val() {
  local key="$1"
  local file="$2"
  grep -E "^${key}=" "$file" 2>/dev/null \
    | sed -E "s/^${key}=//" \
    | tr -d "\"'\r" \
    | sed -E 's/^[[:space:]]+//; s/[[:space:]]+$//' \
    | grep -E '.+' \
    | head -n 1 || true
}

CRON_TOKEN=""
DB_URL=""
PGLITE_DIR=""
if [ -f "$APP_DIR/.env" ]; then
  CRON_TOKEN="$(read_env_val CRON_SECRET "$APP_DIR/.env")"
  if [ -z "$CRON_TOKEN" ]; then
    CRON_TOKEN="$(read_env_val PLATFORM_JWT_SECRET "$APP_DIR/.env")"
  fi
  DB_URL="$(read_env_val DATABASE_URL "$APP_DIR/.env")"
  PGLITE_DIR="$(read_env_val PGLITE_DATA_DIR "$APP_DIR/.env")"
fi
PGLITE_DIR="${PGLITE_DIR:-$APP_DIR/.autodata-pgdata}"

if [ -n "$CRON_TOKEN" ]; then
  if curl -fsS -m 55 --resolve "data.domation.net:443:103.110.87.26" -X POST \
    -H "X-Cron-Secret: ${CRON_TOKEN}" \
    "https://data.domation.net/api/v1/operations/cron/master" >/dev/null; then
    exit 0
  fi
  echo "[run-master-cron] HTTP master cron request failed; refusing unsafe concurrent PGlite CLI fallback." >&2
  exit 1
fi

if command -v pgrep >/dev/null 2>&1 && pgrep -f lsnode >/dev/null 2>&1; then
  echo "[run-master-cron] CRON_TOKEN missing and Passenger lsnode is running; refusing CLI fallback." >&2
  exit 1
fi

if [ -z "$DB_URL" ]; then
  if [ "${ALLOW_OFFLINE_PGLITE_CRON:-false}" != "true" ] || [ -f "$PGLITE_DIR/postmaster.pid" ] || [ -f "$APP_DIR/.autodata-pgdata/postmaster.pid" ]; then
    echo "[run-master-cron] CRON_TOKEN missing and offline PGlite CLI fallback is locked/disallowed." >&2
    exit 1
  fi
fi

export CRON_CLI=true
/opt/alt/alt-nodejs22/root/usr/bin/node --import tsx server/cron/master-cron.ts
