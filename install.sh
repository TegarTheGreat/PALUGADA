#!/bin/sh
# PALUGADA in one command, with nothing on the machine but Docker:
#
#   curl -fsSL https://raw.githubusercontent.com/TegarTheGreat/PALUGADA/main/install.sh | sh
#
# It fetches PALUGADA into ~/palugada (PALUGADA_DIR), writes the database
# passwords to its .env the first time, starts the database, the migrations
# and the platform with Docker Compose, waits until the console answers, and
# prints the link that makes whoever opens it first the owner: the
# authenticator app is added there, and the model is chosen in the console.
#
# Run again, it updates: the newest PALUGADA, the same .env, the same data,
# with a copy of the database taken first into backups/. Nothing here asks a
# question, so it runs the same under a pipe.
#
# PALUGADA_SOURCE is where the code comes from: a tarball's URL (the main
# branch by default), a local tarball, or a directory. PALUGADA_PORT is the
# console's port on this machine's loopback address (8787).

set -eu

# Everything is in one function, called on the last line: under a pipe the
# shell reads the whole script before it runs any of it, so a download cut
# short runs nothing, and no command reading standard input can swallow the
# rest of the script.
main() {
  DIR=${PALUGADA_DIR:-$HOME/palugada}
  SOURCE=${PALUGADA_SOURCE:-https://codeload.github.com/TegarTheGreat/PALUGADA/tar.gz/refs/heads/main}
  PORT=${PALUGADA_PORT:-8787}
  WAIT_SECONDS=${PALUGADA_WAIT_SECONDS:-600}

  say() { printf 'palugada: %s\n' "$*"; }
  fail() { printf 'palugada: %s\n' "$*" >&2; exit 1; }

  # Docker, with Compose v2 or the older standalone command.
  command -v docker >/dev/null 2>&1 || fail "Docker is needed and was not found: install Docker (https://docs.docker.com/get-docker/), then run this again"
  docker info >/dev/null 2>&1 || fail "Docker is installed but not answering: start Docker (or add this user to the docker group), then run this again"
  if docker compose version >/dev/null 2>&1; then
    compose() { docker compose "$@"; }
  elif command -v docker-compose >/dev/null 2>&1; then
    compose() { docker-compose "$@"; }
  else
    fail "Docker Compose is needed and was not found: install the Compose plugin, then run this again"
  fi

  fetch() {
    # $1 the URL, $2 the file.
    if command -v curl >/dev/null 2>&1; then curl -fsSL "$1" -o "$2"
    elif command -v wget >/dev/null 2>&1; then wget -qO "$2" "$1"
    else fail "curl or wget is needed to download PALUGADA"
    fi
  }

  updating=false
  [ -f "$DIR/docker-compose.yml" ] && updating=true
  mkdir -p "$DIR"
  cd "$DIR"

  # Before anything changes, a copy of the database, while it still runs the
  # version that wrote it. Kept in backups/, newest last.
  if $updating && [ -n "$(compose ps -q db 2>/dev/null || true)" ]; then
    mkdir -p backups
    copy="backups/palugada-$(date -u +%Y%m%dT%H%M%SZ).sql.gz"
    say "copying the database to $copy before updating"
    compose exec -T db pg_dump -U postgres -d palugada </dev/null | gzip > "$copy" \
      || fail "the database could not be copied, so nothing was updated; $copy may be incomplete"
  fi

  # The code, over what is there. .env and backups/ are not in it, so they stay.
  say "fetching PALUGADA from $SOURCE"
  unpack() {
    # $1 a tarball whose files are under one top directory.
    tar -xzf "$1" --strip-components=1 -C "$DIR"
  }
  if [ -d "$SOURCE" ]; then
    (cd "$SOURCE" && tar -cf - --exclude=.git --exclude=node_modules --exclude=.env .) | tar -xf - -C "$DIR"
  elif [ -f "$SOURCE" ]; then
    unpack "$SOURCE"
  else
    archive=$(mktemp)
    trap 'rm -f "$archive"' EXIT
    fetch "$SOURCE" "$archive" || fail "PALUGADA could not be downloaded from $SOURCE"
    unpack "$archive"
  fi
  [ -f docker-compose.yml ] || fail "$SOURCE did not contain PALUGADA (no docker-compose.yml)"

  # The database's passwords, made here once: Compose and the platform read
  # them from .env, readable by this user alone. A second run keeps them, or
  # the platform would be locked out of its own database.
  secret() { od -An -tx1 -N18 /dev/urandom | tr -d ' \n'; }
  if [ ! -f .env ]; then
    umask 077
    {
      echo "# Written by install.sh. The database's passwords: keep this file."
      for role in SUPERUSER OWNER APP ADMIN; do
        echo "PALUGADA_DB_${role}_PASSWORD=$(secret)"
      done
      [ "$PORT" = 8787 ] || echo "PALUGADA_PUBLISH=127.0.0.1:$PORT"
    } > .env
    chmod 600 .env
    say "wrote .env with new database passwords"
  fi

  say "building and starting PALUGADA (the first build takes a few minutes)"
  compose up -d --build </dev/null

  say "waiting for the console at http://127.0.0.1:$PORT"
  waited=0
  until fetch "http://127.0.0.1:$PORT/api/health" /dev/null 2>/dev/null; do
    waited=$((waited + 5))
    if [ "$waited" -ge "$WAIT_SECONDS" ]; then
      compose logs --tail 40 app >&2 || true
      fail "the console did not answer within $WAIT_SECONDS seconds; the lines above are the platform's last"
    fi
    sleep 5
  done

  # The newest claim link the platform printed, while it has no owner.
  # Printed from inside the container, it names the container's port; the
  # owner opens the one published here.
  claim=$(compose logs --no-color app 2>/dev/null | sed -n 's/.*no owner yet: open \([^ ]*\) .*/\1/p' | tail -n 1 \
    | sed "s#^http://localhost:8787/#http://localhost:$PORT/#")
  if [ -n "$claim" ]; then
    say "PALUGADA is running. Open this link within a day to become its owner:"
    say ""
    say "  $claim"
    say ""
    say "It asks you to add PALUGADA to your authenticator app; then choose the model under This deployment."
  else
    say "PALUGADA is running at http://127.0.0.1:$PORT"
  fi
  say "to update later, run this again; to stop it: cd $DIR && docker compose down"
}

main "$@"
