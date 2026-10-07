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
#
# On a server, the console is first open to the server itself alone, and the
# end of the run says how to reach it from your own computer. To open it to
# others, say what it is opened at:
#
#   PALUGADA_PUBLIC_HOST=console.example.com   a domain name that points here:
#                                              HTTPS, made and renewed by Caddy
#   PALUGADA_PUBLIC_HOST=203.0.113.7           this server's address: plain HTTP
#   PALUGADA_PUBLIC_HOST=private               shut again to this machine alone
#
# What was chosen stays through every later run. PALUGADA_POLL_SECONDS is how
# often the console is asked whether it answers yet (5).

set -eu

# Everything is in one function, called on the last line: under a pipe the
# shell reads the whole script before it runs any of it, so a download cut
# short runs nothing, and no command reading standard input can swallow the
# rest of the script.
main() {
  DIR=${PALUGADA_DIR:-$HOME/palugada}
  PORT=${PALUGADA_PORT:-8787}
  WAIT_SECONDS=${PALUGADA_WAIT_SECONDS:-600}
  POLL=${PALUGADA_POLL_SECONDS:-5}

  say() { printf 'palugada: %s\n' "$*"; }
  fail() { printf 'palugada: %s\n' "$*" >&2; exit 1; }

  command=${1:-install}
  case "$command" in
    install|doctor|rollback) ;;
    *) fail "say install, doctor or rollback, or nothing to install; got $command" ;;
  esac

  # Four dotted numbers, none above 255.
  is_ipv4() {
    case "$1" in ""|*[!0-9.]*) return 1 ;; esac
    old=$IFS; IFS=.; set -- $1; IFS=$old
    [ "$#" -eq 4 ] || return 1
    for octet in "$@"; do
      [ -n "$octet" ] && [ "${#octet}" -le 3 ] && [ "$octet" -le 255 ] || return 1
    done
  }
  # An address no one else can reach: this machine's own, a network's inside, a provider's shared range.
  is_private_ipv4() {
    case "$1" in
      0.*|10.*|127.*|169.254.*|192.168.*|172.1[6-9].*|172.2[0-9].*|172.3[01].*|100.6[4-9].*|100.[7-9][0-9].*|100.1[01][0-9].*|100.12[0-7].*) return 0 ;;
    esac
    return 1
  }
  # A name or an IPv4 address, in the characters of one: it goes into .env, a
  # URL and the proxy's configuration, so nothing else gets through.
  valid_host() {
    case "$1" in
      ""|*[!A-Za-z0-9.-]*|.*|*.|-*|*-|*..*|*.-*|*-.*) return 1 ;;
    esac
    if is_ipv4 "$1"; then
      case "$1" in 0.*|127.*|255.*) return 1 ;; esac
      return 0
    fi
    case "$1" in *.*) ;; *) return 1 ;; esac
    # The last label is a word: 1.2.3 is a mistyped address, not a name.
    case "${1##*.}" in *[!0-9]*) return 0 ;; esac
    return 1
  }

  # What the console is opened at from other machines. Nothing said keeps what
  # .env already holds; `private` shuts it to this machine again.
  MODE=keep
  HOST=
  if [ -n "${PALUGADA_PUBLIC_HOST:-}" ]; then
    HOST=$(printf '%s' "$PALUGADA_PUBLIC_HOST" | tr 'A-Z' 'a-z')
    if [ "$HOST" = private ]; then
      MODE=private
    elif valid_host "$HOST"; then
      if is_ipv4 "$HOST"; then MODE=address; else MODE=domain; fi
    else
      fail "PALUGADA_PUBLIC_HOST is a domain name such as console.example.com, or an IPv4 address that others can reach, or private; got $PALUGADA_PUBLIC_HOST"
    fi
  fi

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
  # The code, with a progress bar where there is a terminal to draw one on.
  download() {
    if [ -t 2 ] && command -v curl >/dev/null 2>&1; then curl -fL# "$1" -o "$2"
    else fetch "$1" "$2"
    fi
  }
  # What this machine's public address is, as services made to say it answer, or nothing.
  public_ip() {
    for url in https://api.ipify.org https://ifconfig.me/ip https://icanhazip.com; do
      if command -v curl >/dev/null 2>&1; then found=$(curl -fsS -m 4 "$url" 2>/dev/null || true)
      else found=$(wget -qO- -T 4 "$url" 2>/dev/null || true)
      fi
      found=$(printf '%s' "$found" | tr -d ' \r\n')
      if is_ipv4 "$found" && ! is_private_ipv4 "$found"; then printf '%s' "$found"; return 0; fi
    done
    return 1
  }
  # One line of .env, whether or not it is there; the values are plain, checked by the caller.
  set_env() {
    { grep -v "^$1=" .env 2>/dev/null || true; echo "$1=$2"; } > .env.new
    chmod 600 .env.new
    mv .env.new .env
  }
  unset_env() {
    { grep -v "^$1=" .env 2>/dev/null || true; } > .env.new
    chmod 600 .env.new
    mv .env.new .env
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

  # What is going on while the console is not answering yet, in a line.
  heartbeat() {
    running=$(compose ps --status running --services 2>/dev/null | tr '\n' ' ' | sed 's/ *$//' || true)
    last=$(compose logs --no-color --tail 1 app 2>/dev/null | tail -n 1 | sed 's/^[^|]*| *//' | cut -c1-100 || true)
    say "still starting, ${waited}s in (running: ${running:-nothing yet})${last:+; the platform says: $last}"
  }

  # Until the console answers, or WAIT_SECONDS have passed; a word every
  # other poll, and an end at once for a platform that has stopped.
  wait_for_console() {
    # $1 what to put before the line, where it is a step.
    say "${1:-}waiting for the console at http://127.0.0.1:$PORT (up to $WAIT_SECONDS seconds)"
    waited=0
    polls=0
    until fetch "http://127.0.0.1:$PORT/api/health" /dev/null 2>/dev/null; do
      stopped=$( { compose ps --status exited --services; compose ps --status restarting --services; } 2>/dev/null || true)
      if printf '%s\n' "$stopped" | grep -qx app; then
        compose logs --no-color --tail 40 app >&2 || true
        fail "the platform stopped while starting; the lines above are its last. More: cd $DIR && docker compose logs --tail 100 app"
      fi
      if [ "$waited" -ge "$WAIT_SECONDS" ]; then
        compose logs --tail 40 app >&2 || true
        fail "the console did not answer within $WAIT_SECONDS seconds; the lines above are the platform's last"
      fi
      sleep "$POLL"
      waited=$((waited + POLL))
      polls=$((polls + 1))
      if [ $((polls % 2)) -eq 0 ]; then heartbeat; fi
    done
    say "the console answers, after ${waited}s"
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
  say "[1/4] fetching PALUGADA from $SOURCE"
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
    download "$SOURCE" "$archive" || fail "PALUGADA could not be downloaded from $SOURCE"
    unpack "$archive"
  fi
  [ -f docker-compose.yml ] || fail "$SOURCE did not contain PALUGADA (no docker-compose.yml)"

  # The database's passwords, made here once: Compose and the platform read
  # them from .env, readable by this user alone. A second run keeps them, or
  # the platform would be locked out of its own database.
  say "[2/4] preparing the settings"
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
  # Who may open the console, and how: the whole of it is these lines of .env,
  # so a later run keeps them, and each choice removes what the one before made.
  case "$MODE" in
    address)
      unset_env COMPOSE_PROFILES; unset_env PALUGADA_DOMAIN; unset_env PALUGADA_BEHIND_PROXY
      set_env PALUGADA_PUBLISH "0.0.0.0:$PORT"
      set_env PALUGADA_ALLOWED_HOSTS "$HOST,localhost"
      set_env PALUGADA_APP_URL_PUBLIC "http://$HOST:$PORT"
      say "the console will be open at http://$HOST:$PORT"
      ;;
    domain)
      set_env COMPOSE_PROFILES https
      set_env PALUGADA_DOMAIN "$HOST"
      set_env PALUGADA_PUBLISH "127.0.0.1:$PORT"
      set_env PALUGADA_ALLOWED_HOSTS "$HOST,localhost"
      set_env PALUGADA_APP_URL_PUBLIC "https://$HOST"
      set_env PALUGADA_BEHIND_PROXY 1
      say "the console will be open at https://$HOST, with HTTPS made by Caddy"
      ;;
    private)
      for name in COMPOSE_PROFILES PALUGADA_DOMAIN PALUGADA_BEHIND_PROXY PALUGADA_ALLOWED_HOSTS PALUGADA_APP_URL_PUBLIC; do unset_env "$name"; done
      set_env PALUGADA_PUBLISH "127.0.0.1:$PORT"
      say "the console will be open to this machine alone"
      ;;
  esac

  say "[3/4] building and starting PALUGADA (the first time it builds the image, which takes a few minutes; Docker's own progress follows)"
  compose up -d --build </dev/null || {
    compose logs --no-color --tail 40 migrate app >&2 || true
    fail "PALUGADA did not start; the lines above are the last of the migration and of the platform. More: cd $DIR && docker compose logs --tail 100"
  }
  wait_for_console "[4/4] "

  # The newest claim link the platform printed, while it has no owner.
  # Printed from inside the container, it names the container's port; the
  # owner opens the one published here, unless it was told its public address.
  claim=$(compose logs --no-color app 2>/dev/null | sed -n 's/.*no owner yet: open \([^ ]*\) .*/\1/p' | tail -n 1 \
    | sed "s#^http://localhost:8787/#http://localhost:$PORT/#")
  opened_at=$(sed -n 's/^PALUGADA_APP_URL_PUBLIC=//p' .env 2>/dev/null | tail -n 1)
  tell_how_to_open "$claim" "$opened_at"
  say "to update later, run this again; to see whether all is well: sh $DIR/install.sh doctor; to stop it: cd $DIR && docker compose down"
}

# What the end of the install says: where to open the console, from where the
# owner is. $1 the claim link, if there is one; $2 the address it is opened at
# when the owner chose one.
tell_how_to_open() {
  claim=$1
  opened_at=$2
  if [ -n "$opened_at" ]; then
    say "PALUGADA is running at $opened_at"
  elif [ -n "${SSH_CONNECTION:-}${SSH_CLIENT:-}" ]; then
    say "PALUGADA is running, and for now only this server itself can open it."
  else
    say "PALUGADA is running."
  fi
  if [ -n "$claim" ]; then
    say "Open this link within a day to become its owner:"
    say ""
    say "  $claim"
    say ""
    say "It asks you to add PALUGADA to your authenticator app; then choose the model under This deployment."
  fi

  case "$opened_at" in
    http://*)
      say "warning: a bare address has no HTTPS, so what you type, your authenticator codes too, travels unencrypted. Use a domain name when you can: PALUGADA_PUBLIC_HOST=console.example.com sh $DIR/install.sh"
      say "If the link does not open, allow port $PORT in this server's firewall (the provider's panel, or: ufw allow $PORT/tcp)."
      ;;
    https://*)
      name=${opened_at#https://}
      say "HTTPS is made the first time $name is opened, and needs $name to point at this server and ports 80 and 443 free and open in its firewall."
      point_check "$name"
      ;;
    *)
      # Reached over SSH, the address on this machine's own screen is of no use to the one reading it.
      if [ -n "${SSH_CONNECTION:-}${SSH_CLIENT:-}" ]; then
        address=$(public_ip || true)
        if [ -z "$address" ]; then
          # The address the client connected to, when it is one the world can reach.
          seen=$(printf '%s' "${SSH_CONNECTION:-}" | awk '{print $3}')
          if is_ipv4 "$seen" && ! is_private_ipv4 "$seen"; then address=$seen; fi
        fi
        sshport=$(printf '%s' "${SSH_CONNECTION:-}" | awk '{print $4}')
        case "$sshport" in ""|22|*[!0-9]*) sshport="" ;; *) sshport=" -p $sshport" ;; esac
        shown=$address
        [ -n "$shown" ] || shown="<this server's address>"
        say ""
        say "To open it from your own computer, either:"
        say ""
        say "  A. At once, with nothing to set up (an SSH tunnel). In a terminal on YOUR computer run"
        say "       ssh -N -L $PORT:127.0.0.1:$PORT$sshport $(id -un)@$shown"
        say "     leave it running, and open the link above on that computer."
        say ""
        say "  B. From any browser, over HTTPS: point a domain name at $shown, then run on this server"
        say "       PALUGADA_PUBLIC_HOST=console.example.com sh $DIR/install.sh"
        say "     or, with no domain: PALUGADA_PUBLIC_HOST=$shown sh $DIR/install.sh   (without encryption)"
        say ""
      fi
      ;;
  esac
}

# Whether a name points at this server, said as a thing to do when it does not.
point_check() {
  # $1 the name.
  there=""
  if command -v getent >/dev/null 2>&1; then there=$(getent hosts "$1" 2>/dev/null | awk '{print $1; exit}' || true); fi
  here=$(public_ip || true)
  if [ -z "$there" ]; then
    say "warning: $1 does not point anywhere yet: make an A record for it with this server's address${here:+ ($here)}; until it does, HTTPS cannot be made, and it is tried again by itself."
  elif [ -n "$here" ] && [ "$there" != "$here" ]; then
    say "warning: $1 points to $there, not to this server ($here): change its A record; until then HTTPS cannot be made, and it is tried again by itself."
  elif [ -n "$here" ]; then
    say "$1 points to this server ($here)."
  else
    say "$1 points to $there."
  fi
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
  # The proxy runs when HTTPS was chosen, and then it is one of what must be up.
  services="db app"
  case ",$(sed -n 's/^COMPOSE_PROFILES=//p' .env 2>/dev/null | tail -n 1)," in *,https,*) services="$services caddy" ;; esac
  for service in $services; do
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
  opened_at=$(sed -n 's/^PALUGADA_APP_URL_PUBLIC=//p' .env 2>/dev/null | tail -n 1)
  if [ -n "$opened_at" ]; then ok "the console is meant to be opened at $opened_at"; else ok "the console is open on this machine alone"; fi

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
