# Operations

Running PALUGADA for real: as a service, behind HTTPS, with its secrets kept
properly, backed up, upgraded, watched, and on more than one process. Every
setting named here is listed in [docs/configuration.md](../configuration.md).

## Running it under systemd

`deploy/palugada.service` is a systemd unit for one deployment on one
machine. Read its comments before you install it; the short version:

- It runs `/usr/bin/node src/main.ts` from `/opt/palugada`, with its settings
  from `/etc/palugada/palugada.env`.
- It runs as an unprivileged dynamic user with no login, because the platform
  starts agent CLIs and runs code on a company's behalf. `/opt/palugada` must
  be readable by others; it is code, not configuration.
- Its only writable place is `/var/lib/palugada`, which is also `HOME`, where
  agent CLIs keep their own settings. Set `PALUGADA_FILES_ROOT` to a
  directory below it if roles should list and draft files.
- The owner's authenticator secret is a systemd credential, loaded from
  `/etc/palugada/owner-totp` and readable only by this service at
  `/run/credentials/palugada.service/owner-totp`. The unit sets
  `PALUGADA_SECRET_DIRS` and `PALUGADA_OWNER_TOTP_REF` to match.
- `Restart=on-failure` with `RestartPreventExitStatus=78`: a configuration
  error exits 78 and is not restarted into the same refusal every ten
  seconds.
- `KillMode=mixed` and `TimeoutStopSec=60`: see
  [Stopping and restarting](#stopping-and-restarting).

To move a deployment set up with `npm run setup` onto the unit, copy the
settings from `.env` into `/etc/palugada/palugada.env`, and put the value of
`PALUGADA_SECRET_OWNER_TOTP` alone into `/etc/palugada/owner-totp` rather than
into the environment file. Because the unit points `PALUGADA_OWNER_TOTP_REF`
at a new place, the first boot enrols it as an authenticator of its own. It
holds the same secret, so your app's codes keep working; the old entry can no
longer be read and is skipped, and you can revoke it under **Settings**,
**Security**. Build the console (`npm run console:build`) in `/opt/palugada`
before the first start, and run `npm run db:migrate` there with the same
database settings the unit uses.

The platform's boot lines go to standard output and its JSON log lines to
standard error, so both are in the journal.

## HTTPS in front of it

The console and the API listen on `PALUGADA_HOST` (default `127.0.0.1`) and
`PALUGADA_PORT` (default `8787`), in plain HTTP. Keep them on the loopback
address and put a reverse proxy that terminates TLS in front, on the same
machine or network. Then:

1. Set `PALUGADA_APP_URL_PUBLIC` to the HTTPS address you open the console
   at, such as `https://palugada.example.com`. Notifications link there, and
   the console answers to its host name.
2. If the console is reached under other names too, list them all in
   `PALUGADA_ALLOWED_HOSTS`, comma-separated. The loopback names are always
   allowed.
3. Have the proxy pass the original `Host` header through, or the loopback
   address. A request for any other name is refused with status 421 and
   `owner.wrong_host`. This is deliberate: a console that answered to any
   name could be reached through DNS rebinding from a page in your own
   browser.
4. Set `PALUGADA_BEHIND_PROXY=1`, and have the proxy add the caller's address
   to `X-Forwarded-For`. Sign-in refuses an address after five wrong codes,
   and without this setting every caller has the proxy's address. Leave it
   unset when there is no proxy, because the header is then whatever the
   caller wrote.

If you bind the console to every interface (`PALUGADA_HOST=0.0.0.0`) with
neither setting, the boot warns that it "listens on every interface and
answers to any Host".

**With Docker Compose.** The container listens on every interface inside the
container, and Compose publishes it at `PALUGADA_PUBLISH`, by default
`127.0.0.1:8787`, so only this machine reaches it. Set `PALUGADA_PUBLISH`
to the address and port your proxy connects to. The compose file sets
`PALUGADA_ALLOWED_HOSTS` itself, to `localhost` unless `.env` says
otherwise, so under Compose put your public name in `PALUGADA_ALLOWED_HOSTS`
explicitly: `PALUGADA_APP_URL_PUBLIC` alone does not add it there.

Some paths must be reachable from the internet, not only from your browser:
`/api/hooks/<id>` for [triggers](how-to.md#let-other-services-start-work-triggers)
and `/api/channels/telegram` for Telegram's button presses. Both check their
own token or signature. Apart from those, signing in and the health check,
every route needs a signed-in session.

## Secrets

The database never holds a secret it can open by itself. The settings and
credentials that need one hold a reference to it, resolved when it is used,
and the value is redacted from anything written down afterwards. This
deployment resolves three kinds of reference:

| Reference | Where the value is | Rule |
|---|---|---|
| `env://NAME` | An environment variable of the platform's process | Only names starting with `PALUGADA_SECRET_`, so a reference cannot hand out the database URL or anything else in the environment |
| `file:///path` | A file | Only under the directories in `PALUGADA_SECRET_DIRS` (colon-separated, default `/run/secrets`), checked after following links; at most 64 KB; one trailing newline is ignored |
| `db://name` | A key the owner typed in the console, sealed in the database | Sealed with AES-256-GCM under the master key, with its name bound in, so it opens only with that key and under that name |

Anything else, such as `vault://`, is refused with the scheme named.

The master key is `PALUGADA_MASTER_KEY` when it is set, and otherwise the
file `master.key` in `PALUGADA_STATE_DIR` (default `~/.palugada`; under
Docker Compose, in the `home` volume), made the first time the owner saves a
key, readable by the platform's user alone. **This deployment** in the
console names which one is in use.
References are used for the owner's authenticator
(`PALUGADA_OWNER_TOTP_REF`), the model key (`PALUGADA_MODEL_KEY_REF`), every
division's credentials, and the signing secrets of triggers.

Which to use:

- `env://` is what `npm run setup` writes, and what Docker Compose passes
  from `.env`. It is simple, and the value is in a file on disk: the setup
  writes `.env` readable by its owner alone; keep it that way.
- `file://` suits systemd credentials (as `deploy/palugada.service` does for
  the authenticator), Docker or Kubernetes secrets mounted under
  `/run/secrets`, and an external secret manager that writes files. A
  changed file is read again within a minute, and at once after
  **Rotate a credential**, without a restart. A changed `env://` value needs
  a restart.

Some settings are plain values rather than references and belong in the
same protected file: the three database URLs, `PALUGADA_TELEGRAM_TOKEN`,
`PALUGADA_PUSH_TOKEN`, `PALUGADA_RUNTIME_HTTP_TOKEN`,
`PALUGADA_SANDBOX_TOKEN`, and the variable an agent CLI's key is in.

## Backups

The database holds everything PALUGADA knows: every company's structure,
tasks and their journals, the event log, memory, skills, decisions and your
notes, budgets and spending, configuration versions, the owner's sessions
(hashed) and authenticators (as references), credentials (as references),
and the record of applied migrations.

It does not hold the secrets themselves, the vendor, MCP and price files,
the built console, or the agent CLIs' home directory. Back those up
separately: above all `.env` or the environment file and the authenticator
secret, without which you cannot sign in, and the master key
(`PALUGADA_MASTER_KEY`, or `master.key` in the state directory). The keys
the owner saved in the console are in the database, sealed; a restored
database opens them only with the same master key. Keep the two apart, so
that one stolen backup is not both the lock and the key.

Dump the database as a PostgreSQL superuser. Row-level security is forced on
every tenant table, even for the role that owns the schema, and a superuser
is the one role certain to read every row of every table.

```sh
# On this machine, as the postgres account
pg_dump -Fc -d palugada -f palugada.dump

# With Docker Compose
docker compose exec -T db pg_dump -U postgres -Fc palugada > palugada.dump
```

To restore, prepare a server with PostgreSQL 16 and pgvector, create the
three roles and an empty database with `npm run db:setup` (it reads the
passwords from `.env`, so use the same one), restore the dump into it as a
superuser, keeping the dump's object ownership, and start the platform.
Practise this on a spare machine before you need it.

A company's export (**Download as JSON** under **Settings**, **Company**) is
a useful second copy of one company that can be restored on any deployment,
but it is not a backup of the deployment: it leaves out prompt bodies,
sessions, authenticators, platform-wide policies and the other companies.

## Upgrades

Migrations only ever add, so the database can be ahead of the code (after
rolling code back) but must never be behind it. The boot checks: code that
finds migrations it expects and the database has not run refuses to start,
exits 78, and names the command:

```
palugada: configuration refused: the database is 2 migrations behind this code (…): run `npm run db:migrate`, then start again
```

On this machine, take a backup, then:

```sh
git pull
npm install && npm run console:install
npm run console:build
npm run db:migrate
```

and restart the platform (`npm start` again, or restart the service).

With Docker Compose, take a backup, then `git pull` and
`docker compose up -d --build`. The image applies pending migrations when it
starts, under a database lock, so several containers starting at once apply
each migration once.

With more than one process, migrate once, then restart the processes one at
a time.

### Stopping and restarting

On SIGTERM or SIGINT the console closes first, then the worker. A run in
flight is given about twenty seconds to finish its step, and then hands its
task back to the queue with its journal, well inside the minute the systemd
unit and the compose file wait before they kill. The task's timeline says it
was handed back; no attempt is charged, it does not count as a lost worker,
and the next worker to come up resumes it at the step it reached.

A process killed outright loses no work either, but it is slower. Every
worker writes to `worker_heartbeats` every fifteen seconds; when a worker
has been quiet for a minute, the next sweep by any other worker -- or by the
same process restarted -- returns its tasks to the queue, and they resume
from the last committed step. Each counts as a lost worker towards the
crash-loop limit of three. The lease of fifteen minutes stays the backstop
for a holder that never wrote there. A write that was in flight when the
process died is sent again under the key it first had, so a vendor that
honours the key makes it once.

When the model does not answer -- a provider's outage, a local model
restarting -- a call is tried three times, and then the role's fallback
models if it has any and may use them. A task whose models are all down
waits for them: half a minute, then twice as long each time, five times.
Only a model still down after about a quarter of an hour halts the task,
with one incident.

## Monitoring

**The health check.** `GET /api/health` needs no session and says nothing
about any company. It answers 200 when the database answers and the
worker's loop has finished a tick in the last half hour, and 503 with the
reason otherwise:

```json
{ "ok": true, "database": "ok", "worker": { "lastTickAt": "2026-09-26T08:15:02.114Z" } }
```

The Docker image's own health check calls it. Point your monitor at it
through the loopback address or an allowed host name.

**Log lines.** At boot the platform prints one line per fact to standard
output, each starting `palugada:`: what it enrolled and bound, which model
and runtimes it has, and each thing left unconfigured. The same list is the
**Finish setting up** checklist in the console. While running, it writes one
JSON object per line to standard error:

| `event` | `level` | Means |
|---|---|---|
| `task.ran` | `info`, or `warn` when the status is `failed` or `halted` | A task ran, with its `taskId` and `status` |
| `stage.failed` | `error` | One stage of a tick failed (`stage` names it: `reclaim`, `schedules`, `claim`, `settle`, `watch`, `notify`, `retention`, `learn` and others); the rest of the tick carried on |
| `tick.failed` | `error` | A whole tick failed, usually the database; the worker sleeps and tries again |
| `db.connection_lost` | `warn` | The database closed a connection under the platform, for example on a restart; the next query opens another |

Alert on a 503 from the health check, on `tick.failed` that repeats, and on
the same `stage.failed` again and again. Halted tasks and incidents also
reach you in the inbox.

**Exit codes.** 78 means the configuration was refused and restarting will
not help; the message says which setting. 1 means it failed to start for
another reason. 0 is a clean stop. The systemd unit does not restart on 78.
Compose restarts the container whatever the code, so under Compose a
configuration error repeats until you fix it; `docker compose logs app`
shows the message.

There is no metrics endpoint and no tracing yet.

## Running more than one worker

Every `npm start` is a worker and a console. Several can run against one
database, on one machine or several, and they coordinate only through the
database:

- A task is claimed in one statement that locks it and skips rows another
  worker holds, so two workers never take the same task. The same statement
  checks that the task's budget still has room for what is already running,
  and that its division is under its **Runs at once, at most**, counted
  across every worker.
- Each process names itself for its leases with its host, its process id and
  a random part, so two containers that are both process 1 are still two
  workers. `PALUGADA_WORKER_ID` overrides it; if you set it, keep it unique.
- A claim is a lease of fifteen minutes. The worker renews it every five
  minutes while the run shows progress. A run that shows none for a whole
  lease is stopped and its task handed back.
- If a worker dies, its tasks return to the queue once it has been quiet
  for a minute (`worker_heartbeats`), or when their leases run out if it
  never wrote there; the next worker resumes from the last committed step
  and repeats no action. The heartbeat is compared on the database's clock,
  so machines whose clocks disagree cannot make a live worker look dead. A task that loses its worker three times is halted
  as a crash loop and raised to you as an incident, rather than taking a
  third worker down.
- A schedule's occurrence creates one task however many workers see it, and
  each item reaches you once, whichever worker sends it.
- Console sessions are stored in the database, hashed, so a load balancer
  can send you to any process. **Sign out everywhere**, or revoking an
  authenticator, ends its sessions on every process.

A worker runs one task at a time. Each tick it claims up to eight, one after
another, starting from a different company each time so none is starved.
Tasks that wait, for you, a review or a sub-task, hold no worker. To run
several tasks at the same moment, run several processes. Each also serves
the console, so each needs its own `PALUGADA_PORT` on a shared machine. The
compose file as shipped runs one app container on one published port.

## Sizing

- **Processes.** One per task you want running at the same moment. A single
  process suits a handful of companies whose work is mostly model calls. A
  long agent CLI run occupies its worker for as long as it takes.
- **Database connections.** Each process keeps up to ten connections as the
  application role and ten as the control plane, and migrations open one
  more. Size PostgreSQL's connection limit for about twenty a process.
- **Database size.** The event log grows with the work and is kept at least
  a year; prompts at least ninety days. Set the windows under **Settings**,
  **Company**, **Retention**.
- **Agent CLIs.** Each run is a separate process tree with a directory of
  its own on the machine that runs it. Size that machine's memory for the
  number of runs it may have at once.
- **Timeouts.** A single database statement is ended after two minutes and a
  transaction left idle after ten, so a stuck query cannot hold its locks
  indefinitely.

## The database roles

`scripts/setup-database.sh` creates the database and three roles. The split
is a security boundary, not bookkeeping:

| Role | Used by | Attributes |
|---|---|---|
| `palugada_owner` | Migrations; owns the schema objects | `NOSUPERUSER NOCREATEDB NOBYPASSRLS` |
| `palugada_app` | Every agent run, the engine and the broker (`PALUGADA_APP_URL`) | `NOSUPERUSER NOCREATEDB NOBYPASSRLS`: row-level security always applies |
| `palugada_admin` | The control plane: creating companies, the owner's views across companies (`PALUGADA_ADMIN_URL`) | `NOSUPERUSER NOCREATEDB BYPASSRLS`, and never reachable from agent code |

The script connects as a superuser only to create these and to install the
`pgcrypto` and `vector` extensions, which a superuser must install. It takes
each role's password from `PALUGADA_OWNER_URL`, `PALUGADA_APP_URL` and
`PALUGADA_ADMIN_URL` (from the environment or `.env`); passwords may use
letters, digits and `_ . ~ -`. `PALUGADA_DB_NAME` names the database
(default `palugada`; the connection URLs must name the same one), and
`PALUGADA_SUPERUSER_URL` the superuser connection.
It refuses to run over an existing database; `PALUGADA_RESET_DATABASE=yes`
drops and recreates it, with everything in it.

A managed PostgreSQL service works if it offers PostgreSQL 16 with pgvector
and lets you create a role with `BYPASSRLS`; check both before you choose
one. Keeping the database available, replicated and backed up is yours: the
platform reconnects after a database restart, but it does not manage
failover.
