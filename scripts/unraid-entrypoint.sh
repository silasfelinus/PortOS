#!/usr/bin/env bash
set -euo pipefail

cd /app

export NODE_ENV="${NODE_ENV:-production}"
export HOST="${HOST:-0.0.0.0}"
export PORT="${PORT:-5555}"
export PGMODE="${PGMODE:-native}"
export PGHOST="${PGHOST:-db}"
export PGPORT="${PGPORT:-5432}"
export PGUSER="${PGUSER:-portos}"
export PGDATABASE="${PGDATABASE:-portos}"
export PGPASSWORD="${PGPASSWORD:-portos}"
export PORTOS_SERVER_MAX_MEMORY="${PORTOS_SERVER_MAX_MEMORY:-4G}"

echo "🧭 PortOS Unraid startup"
echo "   app:      http://0.0.0.0:${PORT}"
echo "   postgres: ${PGUSER}@${PGHOST}:${PGPORT}/${PGDATABASE}"

node scripts/setup-data.js

echo "⏳ Waiting for PostgreSQL..."
until PGPASSWORD="${PGPASSWORD}" pg_isready -h "${PGHOST}" -p "${PGPORT}" -U "${PGUSER}" -d "${PGDATABASE}" >/dev/null 2>&1; do
  sleep 2
done

echo "✅ PostgreSQL is reachable"

exec "$@"