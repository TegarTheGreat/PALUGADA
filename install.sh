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
# with a copy of the database and of the code it replaces taken first into
# backups/. Nothing here asks a question, so it runs the same under a pipe.
#
#   sh ~/palugada/install.sh doctor     says what is well and what is not,
#                                       and mends what is safe to mend
#   sh ~/palugada/install.sh rollback   goes back to the code the last
#                                       update replaced; the data stays
#
# PALUGADA_VERSION installs a release, by its tag (v0.2.0); without it, the
# main branch. PALUGADA_SOURCE, when set, is used instead of either: a
# tarball's URL, a local tarball, or a directory. PALUGADA_PORT is the
# console's port on this machine's loopback address (8787).

set -eu

# Everything is in one function, called on the last line: under a pipe the
# shell reads the whole script before it runs any of it, so a download cut
# short runs nothing, and no command reading standard input can swallow the
# rest of the script.
main() {
  DIR=${PALUGADA_DIR:-$HOME/palugada}
  PORT=${PALUGADA_PORT:-8787}
  WAIT_SECONDS=${PALUGADA_WAIT_SECONDS:-600}

  say() { printf 'palugada: %s\n' "$*"; }
  fail() { printf 'palugada: %s\n' "$*" >&2; exit 1; }

  command=${1:-install}
  case "$command" in
    install|doctor|rollback) ;;
    *) fail "say install, doctor or rollback, or nothing to install; got $command" ;;
  esac

  REF=refs/heads/main
  if [ -n "${PALUGADA_VERSION:-}" ]; then
    # Only a tag's shape, v and three numbers: it goes into a URL.
    case "$PALUGADA_VERSION" in
      *[!v0-9.]*) fail "PALUGADA_VERSION is a release's tag, as v0.2.0; got $PALUGADA_VERSION" ;;
      v[0-9]*.[0-9]*.[0-9]*) REF="refs/tags/$PALUGADA_VERSION" ;;
      *) fail "PALUGADA_VERSION is a release's tag, as v0.2.0; got $PALUGADA_VERSION" ;;
    esac
  fi
  SOURCE=${PALUGADA_SOURCE:-https://codeload.github.com/TegarTheGreat/PALUGADA/tar.gz/$REF}

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
  # $1 the URL; what it answers, whatever its status.
  fetch_text() {
    if command -v curl >/dev/null 2>&1; then curl -sS "$1"
    else wget -qO- --content-on-error "$1"
    fi
  }

  # Before anything changes, a copy of the database, while it still runs the
  # version that wrote it, and of the code about to be replaced, under one
  # moment's name. Kept in backups/, newest last; what rollback goes back to.
  keep_copies() {
    # $1 what is about to happen, for the message.
    stamp=$(date -u +%Y%m%dT%H%M%SZ)
    # A moment of its own: two in one second would write over each other.
    while [ -e "backups/palugada-$stamp.code.tar.gz" ] || [ -e "backups/palugada-$stamp.sql.gz" ]; do
      sleep 1
      stamp=$(date -u +%Y%m%dT%H%M%SZ)
    done
    mkdir -p backups
    if [ -n "$(compose ps -q db 2>/dev/null || true)" ]; then
      copy="backups/palugada-$stamp.sql.gz"
      say "copying the database to $copy before $1"
      compose exec -T db pg_dump -U postgres -d palugada </dev/null | gzip > "$copy" \
        || fail "the database could not be copied, so nothing was changed; $copy may be incomplete"
    fi
    # Not the passwords, and not the copies themselves.
    tar -czf "backups/palugada-$stamp.code.tar.gz" --exclude=./.env --exclude=./backups . \
      || fail "the code could not be copied, so nothing was changed"
  }

  # Until the console answers, or WAIT_SECONDS have passed.
  wait_for_console() {
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
  }

  case "$command" in
    doctor) doctor; return ;;
    rollback) rollback; return ;;
  esac

  updating=false
  [ -f "$DIR/docker-compose.yml" ] && updating=true
  mkdir -p "$DIR"
  cd "$DIR"
  if $updating; then keep_copies updating; fi

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
  wait_for_console

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
  say "to update later, run this again; to see whether all is well: sh $DIR/install.sh doctor; to stop it: cd $DIR && docker compose down"
}

# Back to the code the last update replaced, rebuilt and started. Its data
# stays as it is: migrations only add, so the earlier version runs on a
# database a later one migrated; taking the data back too loses what was
# done since, so that is said, not done.
rollback() {
  [ -f "$DIR/docker-compose.yml" ] || fail "PALUGADA is not installed in $DIR"
  cd "$DIR"
  previous=$(ls backups/palugada-*.code.tar.gz 2>/dev/null | sort | tail -n 1 || true)
  [ -n "$previous" ] || fail "there is no earlier version to go back to: each update keeps the one it replaced, and none has run here yet"
  # Its own name: keep_copies sets stamp to the moment it copies at.
  before=${previous#backups/palugada-}
  before=${before%.code.tar.gz}
  keep_copies "going back"
  say "going back to the version kept before the update of $before"
  tar -xzf "$previous" -C "$DIR" || fail "$previous could not be unpacked; the code may be half one version and half the other: run rollback again"
  compose up -d --build </dev/null
  wait_for_console
  say "PALUGADA runs the version it ran before $before, on the same data."
  if [ -f "backups/palugada-$before.sql.gz" ]; then
    say "to take the data back to that moment too, losing what was done since, see Backups in docs/guide/operations.md:"
    say "  gzip -dc backups/palugada-$before.sql.gz | docker compose exec -T db psql -U postgres palugada   (on an emptied database)"
  fi
  say "to undo this, run rollback again"
}

# What is well, what was mended, and what is not well and what to do about
# it. Mends only what cannot lose anything: .env made the owner's alone
# again, and stopped containers started without a rebuild.
doctor() {
  [ -f "$DIR/docker-compose.yml" ] || fail "PALUGADA is not installed in $DIR: run this without doctor to install it"
  cd "$DIR"
  published=$(sed -n 's/^PALUGADA_PUBLISH=.*:\([0-9][0-9]*\)$/\1/p' .env 2>/dev/null | tail -n 1)
  [ -n "${PALUGADA_PORT:-}" ] || PORT=${published:-$PORT}
  problems=0
  ok() { say "ok: $*"; }
  mended() { say "mended: $*"; }
  problem() { say "problem: $*"; problems=$((problems + 1)); }

  ok "Docker answers"
  if [ ! -f .env ]; then
    problem ".env is missing: it holds the database's passwords, and without it the platform cannot reach its own database; put back your copy of it"
  elif [ "$(ls -l .env | cut -c1-10)" != "-rw-------" ]; then
    chmod 600 .env
    mended ".env holds the database's passwords and others could read it; it is yours alone again"
  else
    ok ".env is yours alone"
  fi

  running=$(compose ps --status running --services 2>/dev/null || true)
  stopped=""
  for service in db app; do
    printf '%s\n' "$running" | grep -qx "$service" || stopped="$stopped $service"
  done
  started=false
  if [ -n "$stopped" ]; then
    compose up -d </dev/null || true
    mended "started$stopped, which had stopped"
    started=true
  else
    ok "the database and the platform are running"
  fi

  # Health as the platform judges it: the database answers, and the worker
  # has gone round lately. Read even when it says no, for what it says.
  health=""
  waited=0
  while :; do
    health=$(fetch_text "http://127.0.0.1:$PORT/api/health" 2>/dev/null || true)
    if [ -n "$health" ] || ! $started || [ "$waited" -ge "$WAIT_SECONDS" ]; then break; fi
    waited=$((waited + 5))
    sleep 5
  done
  if printf '%s' "$health" | grep -q '"ok":true'; then
    version=$(printf '%s' "$health" | sed -n 's/.*"version":"\([^"]*\)".*/\1/p')
    ok "the console answers, version ${version:-unknown}, and its worker is going round"
  elif [ -n "$health" ]; then
    problem "the platform answers that it is not well: $(printf '%s' "$health" | cut -c1-300); its last lines: cd $DIR && docker compose logs --tail 40 app"
  else
    problem "the console does not answer at http://127.0.0.1:$PORT; its last lines: cd $DIR && docker compose logs --tail 40 app"
  fi

  checked=$(compose exec -T app node scripts/browser-check.ts </dev/null 2>&1) && browser=well || browser=sick
  if [ "$browser" = well ]; then
    ok "the browser runs sandboxed"
  elif printf '%s' "$checked" | grep -q 'no Chromium here'; then
    say "note: this image has no browser, so roles cannot use one"
  else
    problem "the browser does not start sandboxed ($(printf '%s' "$checked" | tail -n 1 | cut -c1-200)): see Running the image by itself in docs/guide/operations.md"
  fi

  free=$(df -Pk . 2>/dev/null | awk 'NR == 2 { print int($4 / 1048576) }')
  if [ -n "$free" ] && [ "$free" -lt 2 ]; then
    problem "only ${free} GB free on the disk PALUGADA is on: 'docker system prune' removes images nothing uses"
  elif [ -n "$free" ]; then
    ok "${free} GB free on the disk PALUGADA is on"
  fi

  newest=$(ls backups/palugada-*.sql.gz 2>/dev/null | sort | tail -n 1 || true)
  if [ -n "$newest" ]; then
    ok "the newest copy of the database is $newest"
  else
    say "note: no copy of the database yet; each update takes one, and Backups in docs/guide/operations.md says how to take them every day"
  fi

  if [ "$problems" -gt 0 ]; then
    fail "$problems problem$( [ "$problems" = 1 ] || echo s ) above"
  fi
  say "all well"
}

main "$@"
