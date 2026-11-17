#!/usr/bin/env bash
set -euo pipefail
export NODE_ENV=production
APP_DIR="/home/vhvxoigh/data.domation.net"
cd "$APP_DIR"

CRON_TOKEN=""
if [ -f "$APP_DIR/.env" ]; then
  CRON_TOKEN="$(grep -E '^(CRON_SECRET|PLATFORM_JWT_SECRET)=' "$APP_DIR/.env" | head -n 1 | cut -d= -f2- | tr -d "\"'\r\n")"
fi

if [ -n "$CRON_TOKEN" ]; then
  curl -fsS -m 55 --resolve "data.domation.net:443:103.110.87.26" -X POST \
    -H "X-Cron-Secret: ${CRON_TOKEN}" \
    "https://data.domation.net/api/v1/operations/cron/master" >/dev/null
  exit 0
fi

export CRON_CLI=true
/opt/alt/alt-nodejs22/root/usr/bin/node --import tsx server/cron/master-cron.ts
