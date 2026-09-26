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

# Refused over a database that already exists, unless asked for by name.
# This drops everything, and it is the second line of the quickstart: an
# operator who runs it again to "set up" a deployment that holds companies
# would lose all of them to a command that says nothing about deleting.
if [ "$(query "SELECT 1 FROM pg_database WHERE datname = '${DB_NAME}'")" = "1" ] \
   && [ "${PALUGADA_RESET_DATABASE:-}" != "yes" ]; then
  echo "db:setup: database ${DB_NAME} already exists, and this would drop it with everything in it." >&2
  echo "  To bring it up to date instead:  npm run db:migrate" >&2
  echo "  To start again from nothing:     PALUGADA_RESET_DATABASE=yes npm run db:setup" >&2
  exit 1
fi

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

echo "==> Installing extensions"
# Extensions are an infrastructure concern, not a migration one: pgvector is
# not a trusted extension, so only a superuser may install it. Migrations run
# as palugada_owner and merely assert that it is present.
run_db_sql() {
  if [ -n "$SUPERUSER_URL" ]; then
    psql "${SUPERUSER_URL%/*}/${DB_NAME}" -v ON_ERROR_STOP=1 -q -c "$1"
  else
    su postgres -c "psql -d ${DB_NAME} -v ON_ERROR_STOP=1 -q -c \"$1\""
  fi
}
run_db_sql "CREATE EXTENSION IF NOT EXISTS pgcrypto"
run_db_sql "CREATE EXTENSION IF NOT EXISTS vector"

echo "==> Role attributes"
query "SELECT rolname || ' super=' || rolsuper || ' bypassrls=' || rolbypassrls FROM pg_roles WHERE rolname LIKE 'palugada%' ORDER BY rolname"

echo "==> Done. Run 'npm run db:migrate' next."
