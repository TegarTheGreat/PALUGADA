#!/usr/bin/env bash
# Provisions the PALUGADA database and its three roles.
#
# The role split is a security boundary, not bookkeeping:
#
#   palugada_owner  owns the schema objects and runs migrations.
#   palugada_app    is used by every agent run, the execution engine and the
#                   capability broker. NOBYPASSRLS, so tenant isolation is
#                   enforced by the database rather than by application code.
#   palugada_admin  is the control plane (creating companies, cross-tenant
#                   digests). BYPASSRLS, and never reachable from agent code.
#
# Connects as a superuser. Set PALUGADA_SUPERUSER_URL to point at one (this is
# what CI does); with no URL it falls back to a local peer-authenticated
# `postgres` account. Development passwords only -- production provisioning
# belongs to infrastructure tooling.
set -euo pipefail

DB_NAME="${PALUGADA_DB_NAME:-palugada}"
SUPERUSER_URL="${PALUGADA_SUPERUSER_URL:-}"

run_sql() {
  if [ -n "$SUPERUSER_URL" ]; then
    psql "$SUPERUSER_URL" -v ON_ERROR_STOP=1 -q -c "$1"
  else
    su postgres -c "psql -v ON_ERROR_STOP=1 -q -c \"$1\""
  fi
}

query() {
  if [ -n "$SUPERUSER_URL" ]; then
    psql "$SUPERUSER_URL" -tAc "$1"
  else
    su postgres -c "psql -tAc \"$1\""
  fi
}

echo "==> Dropping existing database and roles (development only)"
run_sql "DROP DATABASE IF EXISTS ${DB_NAME}"
run_sql "DROP ROLE IF EXISTS palugada_app"
run_sql "DROP ROLE IF EXISTS palugada_admin"
run_sql "DROP ROLE IF EXISTS palugada_owner"

echo "==> Creating roles"
run_sql "CREATE ROLE palugada_owner LOGIN PASSWORD 'dev_owner' NOSUPERUSER NOCREATEDB NOBYPASSRLS"
run_sql "CREATE ROLE palugada_app   LOGIN PASSWORD 'dev_app'   NOSUPERUSER NOCREATEDB NOBYPASSRLS"
run_sql "CREATE ROLE palugada_admin LOGIN PASSWORD 'dev_admin' NOSUPERUSER NOCREATEDB BYPASSRLS"

echo "==> Creating database ${DB_NAME}"
run_sql "CREATE DATABASE ${DB_NAME} OWNER palugada_owner"

echo "==> Role attributes"
query "SELECT rolname || ' super=' || rolsuper || ' bypassrls=' || rolbypassrls FROM pg_roles WHERE rolname LIKE 'palugada%' ORDER BY rolname"

echo "==> Done. Run 'npm run db:migrate' next."
