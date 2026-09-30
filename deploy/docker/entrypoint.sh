#!/bin/sh
# Where PALUGADA's container starts (the Dockerfile's ENTRYPOINT); the
# platform itself is the command it is given, `node src/main.ts`.
#
#   1. Given a superuser (PALUGADA_SUPERUSER_URL), the database is provisioned:
#      roles, database and extensions made or corrected, nothing dropped
#      (scripts/provision-database.ts). This is how a platform that runs the
#      image with a stock database beside it -- Coolify, Dokploy -- sets one
#      up, since it has no repository files to mount into the database.
#   2. Given the schema owner (PALUGADA_OWNER_URL), migrations run, under an
#      advisory lock, so replicas starting together apply each once.
#   3. The platform starts without either, and without any database password
#      it was handed besides its own URLs: the passwords Compose's .env gives
#      every container that reads it, and the variables Coolify generates and
#      gives every container of a resource (SERVICE_*). They are unset first
#      and the init exec'd after, because the platform runs agent CLIs as its
#      own user and those can read /proc/1/environ -- whatever PID 1 was
#      started with was theirs to read, and `env -u` in a child did not
#      change what PID 1 held.
#
# Until the exec, this shell is PID 1: a stop during a migration waits for
# the grace period and is then killed, and the migration rolls back.
set -eu
cd "$(dirname "$0")/../.."

if [ -n "${PALUGADA_SUPERUSER_URL:-}" ]; then
  node scripts/provision-database.ts
fi
if [ -n "${PALUGADA_OWNER_URL:-}" ]; then
  node scripts/migrate.ts
fi

for name in $(env | sed -n 's/^\(SERVICE_[A-Za-z0-9_]*\)=.*/\1/p'); do
  unset "$name"
done
unset PALUGADA_SUPERUSER_URL PALUGADA_OWNER_URL POSTGRES_PASSWORD \
  PALUGADA_DB_SUPERUSER_PASSWORD PALUGADA_DB_OWNER_PASSWORD PALUGADA_DB_APP_PASSWORD PALUGADA_DB_ADMIN_PASSWORD

# tini reaps what agent CLIs leave behind and passes SIGTERM on to the
# platform, so the worker can hand its work back.
init="${PALUGADA_INIT:-/usr/bin/tini}"
unset PALUGADA_INIT
exec "$init" -- "$@"
