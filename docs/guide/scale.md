# Small, medium, large and enterprise

What to set up, configure and watch at each size, and what PALUGADA does not
do yet. The limits are taken from the code and from
[docs/STATUS.md](../STATUS.md), sections 2.21 and 2.22, which record what
audits of the platform found and what is still open.

## What is the same at every size

- **One human owner, by design.** There are no user accounts, no single
  sign-on, no staff accounts and no roles or permissions for people. Whoever
  holds the enrolled authenticator is the owner, with the whole of the
  owner's power, and the history cannot tell two people using it apart. If
  several people are each accountable for their own companies, give each of
  them a deployment of their own rather than sharing one authenticator.
- **Companies are isolated in the database.** Row-level security is forced
  on every tenant table, references between tenant tables carry the
  company, and the role agents run as cannot bypass either. Many companies
  can safely share one deployment and one database.
- **Irreversible actions are always yours.** Tier 3 waits for you and a
  fresh code at every size; nothing can be configured to approve it for you.
- **Money is reserved before work starts.** Each company has a monthly
  ceiling and a breaker on the spending rate.
- **Replicas share the work through leases.** More processes means more
  tasks at once; see [operations](operations.md#running-more-than-one-worker).

## Small: one owner, a few companies

A person running one to a few companies from a laptop or a small server.

**Set up.** Docker Compose, or `npm start` on a machine with PostgreSQL.
One process is enough. Run `npm run setup` and choose one model that calls
tools; a hosted model's fast or standard tier, or a capable local model.

**Configure.**
- The monthly ceiling on **Money** for each company. USD 200 is the default.
- Telegram or push, so the inbox reaches you. Both need the console
  reachable over HTTPS from your phone
  ([how-to](how-to.md#push-notifications-and-telegram)).
- The company's languages, if its customers or you work in something other
  than the default.
- A price list (`PALUGADA_MODEL_PRICES`) if your model is not priced by
  default; unpriced usage is charged at a deliberately high rate, which makes
  the ceiling bite early.
- A daily `pg_dump`, and a safe copy of `.env`: it holds the authenticator
  secret ([operations](operations.md#backups)).

**Watch.** The inbox, once or twice a day. **Money** for the month's spend.
The **Finish setting up** card at the foot of the sidebar for anything still
switched off.

## Medium: a business, always on

A business running several companies around the clock, where a stopped
worker or a lost database would cost something.

**Set up.** A Linux server running the systemd unit or Compose, behind a
reverse proxy with HTTPS ([operations](operations.md#https-in-front-of-it)).
PostgreSQL on the same server or a managed one with pgvector. One or two
worker processes.

**Configure.**
- `PALUGADA_APP_URL_PUBLIC` and `PALUGADA_ALLOWED_HOSTS` (and, under Compose,
  `PALUGADA_PUBLISH`).
- Secrets as files rather than environment variables where you can: systemd
  credentials, or mounted secrets under `PALUGADA_SECRET_DIRS`.
- A vendor file for the capabilities the companies need, such as email,
  invoices and DNS, and the MCP servers you trust
  ([how-to](how-to.md#connect-a-vendor)).
- Budget accounts for the divisions that spend, and alert thresholds under
  **Settings**, **Company**.
- Triggers for events other services send, handoffs between roles, and
  schedules for recurring work (for now created through the owner API; see
  [how-to](how-to.md#schedule-recurring-work)).
- Retention windows that match what you are obliged to keep.
- Monitoring on `GET /api/health`, and the JSON log lines collected
  somewhere you will read them.

**Watch.** The health check; `stage.failed` and `tick.failed` in the logs;
halted tasks on **Work** and incidents in the inbox; spend per company, side
by side, under **Every company** on **Money**; the size of the database.

## Large: many companies, many tasks at once

Dozens of companies, long-running agent CLIs, and more work at any moment
than one worker can run.

**Set up.**
- Several worker processes, one for each task you want running at the same
  moment: a worker runs one task at a time. Put them on one or more hosts
  behind the proxy or a load balancer; console sessions are shared through
  the database, so any process can serve you.
- Give every process the same configuration: the same model, runtimes,
  vendor file, MCP servers and price list. Any worker can claim any task, and
  a task whose role names a runtime that worker does not have is halted with
  `runtime_unavailable`. Install the same agent CLIs, at the same versions, on
  every host that runs a worker.
- PostgreSQL on its own host, with connections for about twenty a process,
  and the storage and backups a growing event log needs.
- The Docker runtime for work that should have no network at all.

**Configure.** Everything under medium, and: `PALUGADA_WORKER_ID` only if you
can keep it unique per process; division budget accounts, so one division
cannot spend a company's month; retention set per company; a provider rate
limit that fits the number of workers, since a rate-limited model call is
retried twice and then falls back or waits.

**Watch.** Tasks halted as crash loops (an incident each), leases that expire
(`task.lease_expired` in a task's events), `db.connection_lost`, the
database's connection count and statement times, the event log's growth, and
roles paused for spending too fast.

**Know.** A long agent CLI run holds its worker for as long as it takes, so
count long runs when you count processes. A division's
**Runs at once, at most** holds across every worker, so a division set to
two runs two tasks at a time however many workers you add; raise it for the
divisions that should use them. There is no limit per capability yet, beyond
each grant's rate per hour. Memory search is exact rather than approximate,
which keeps scope filters correct and gets slower as a company's memory
grows.

## Enterprise

PALUGADA can be run inside a larger organisation, but it is built around one
accountable human per deployment, and several things an enterprise usually
expects are not there. Be clear about both before you commit.

**What it gives you.**
- Isolation between companies enforced by the database, with separate
  database roles for agents, the control plane and migrations
  ([operations](operations.md#the-database-roles)).
- Agents and runtimes that never hold a credential or a database connection;
  agent CLIs with none of their own tools; a Docker runtime with no network;
  code-executing capabilities that cannot share a division with a
  credential or a tier 2 grant.
- Secrets held by reference, resolvable from files an external secret
  manager writes.
- An append-only event log, separate security events, a governance log of
  every change to charters, policies, roles and grants, the decision history
  with the owner's reasons, and a per-company export for audit.
- Retention as the only thing that deletes, recording what it removed.

**What it does not have yet.**
- Single sign-on, staff accounts, roles for people, delegated approval, or a
  second human approver. The second pair of eyes on an action is a reviewer
  role, which is an agent.
- A metrics endpoint or tracing. There are JSON log lines and a health
  check.
- A connector catalogue or an OAuth flow for connecting accounts.
  Integrations are the built-in capabilities, vendor files and allow-listed
  MCP servers you bind.
- High availability for PostgreSQL. Replication, failover and backups are
  yours; the platform reconnects after a database restart.
- Protection against guessing from many addresses at once. Five wrong codes
  from one address hold that address back for fifteen minutes, but ten wrong
  codes from any mix of addresses lock the second factor for fifteen
  minutes, for you as well. Limit who can reach the console.
- Passkeys in the console. The API verifies a passkey assertion, but the
  console signs in and approves with an authenticator code only.
- Platforms other than Linux, and an image with agent CLIs in it.
- Proof against the vendors themselves: push, Telegram, the model APIs and
  MCP servers are exercised against local servers. The
  [configuration page](../configuration.md) says how far each agent CLI's
  command line has been checked.

**How to fit it in today.**
- One deployment, with its own database, per accountable owner: a business
  unit, a venture, a client engagement.
- Limit who can reach the console at the network or proxy layer, leaving
  `/api/hooks/<id>` and `/api/channels/telegram` open to the services that
  call them.
- Send the JSON log lines and company exports to the systems you already
  keep records in.
- Control outbound traffic at the network layer as well. `web.fetch` and
  vendor calls already refuse private addresses; `PALUGADA_ALLOW_PRIVATE_HOSTS`
  lets `web.fetch` reach an internal host you name.
- Read [docs/STATUS.md](../STATUS.md): it grades every requirement of the
  specification as built, partial or not built, and records the defects
  found and fixed.
