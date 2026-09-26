# PALUGADA

**Run companies staffed by AI agents, with one human who makes only the
decisions that matter.**

PALUGADA is the control plane for an AI-run company. Agents plan, build,
market, support customers and keep the books. Every action they take goes
through a broker that knows what it costs, how hard it is to undo, and who has
to approve it. The owner does not manage agents. They answer an inbox of
decisions from the console, a push notification or a Telegram button, and
nothing irreversible happens until they do.

One installation runs any number of companies. Each one is isolated in the
database and has its own structure, budget, memory and history.

```
             owner  ── console · push · Telegram ──►  decisions inbox
                                                           │
  ┌─────────────────────────────── PALUGADA ───────────────┼──────────────┐
  │  companies → divisions → roles → tasks           approvals, incidents │
  │                                                                       │
  │  durable engine ─► capability broker ─► tiers · policies · budgets    │
  │        │                  │                                           │
  │   journal, leases     read-back, plans, review, audit log             │
  └────────┼──────────────────┼───────────────────────────────────────────┘
           ▼                  ▼
   agent runtimes        the outside world
   (Claude Code, CLIs,   (email, DNS, invoices, deploys …)
    HTTP, Docker, sandbox)
```

## Why PALUGADA

### One human, one inbox

PALUGADA is not a chat workspace or a multi-agent conversation. The owner's
whole job is a queue of decisions, and every card carries what a decision
needs: what the agent wants to do, which goal it serves (mission → objective →
key result), how reversible it is, what it costs, what happens if it is
refused, and the full trace behind it. The owner can approve, deny, or ask a
question without leaving the task. Decided items move to a searchable history
that includes the owner's own notes, so a decision never scrolls away.

### The owner decides what cannot be undone

Every capability is classified by its effect, not by the tool that performs
it:

| Tier | Effect | Examples | What PALUGADA does |
|---|---|---|---|
| 0 | Read only | DNS lookup, uptime check, listing files | Runs it |
| 1 | Cheap to undo | A draft, a staging deploy | Runs it, then reads back to verify |
| 2 | Costly or spends money | An external email, a purchase | Needs a recorded plan and a budget check first, verified after |
| 3 | Irreversible | Nameservers, deletions, transfers, signatures | Waits for the owner, in the app, with a second factor |

No policy, template or agent can move a tier 3 action out of the owner's
hands. An approval nobody answers expires into a cancellation, so silence
never executes anything. An approval covers exactly one action: if the agent
comes back with a different amount or recipient, that is a new question.

### Money cannot run away

- Tokens and money are **reserved before a task starts**, charged on every
  call, and settled against the runtime's own bill when it reports one.
- **Two ceilings, each enforced on its own**: one per task, and one per
  company per month (USD 200 by default), with division, project and role
  accounts underneath.
- **Warns at 80%, pauses at 100%.** An owner override always carries a
  deadline.
- **A circuit breaker watches the rate.** A role that spends more than three
  times its seven-day average in an hour is stopped while there is still money
  left.
- **Usage the runtime did not price is never counted as free.** Until the
  operator's price list covers the model, it is charged at a deliberately high
  fallback.
- **An idle agent costs nothing.** Roles sleep by default. A wake with no work
  assembles no context and calls no model.

### A crash loses nothing

- Every step is journaled. A resumed run replays committed steps and never
  repeats a side effect.
- Atomic checkout with leases means two workers can never run the same task.
  A dead worker's lease expires and its task resumes with the journal intact.
- Deadlines, hop limits and cycle detection end runaway work. A halted task
  goes to the owner and is never retried silently.
- A vendor that answers "not now" (429 or `Retry-After`) parks the task until
  the time the vendor gave, without spending any of the task's retries.

### Bring any agent

PALUGADA orchestrates; the agent runtime does the thinking. The engine never
calls a model to do a task itself. It lends the runtime four things: tool
calls through the broker, journaled steps, contained sub-tasks, and a way to
report cost. A runtime never gets credentials or a database connection.

Supported runtimes: in-process, a spawned script, HTTP, **Claude Code**,
other agent CLIs added from configuration (`hermes`, `openclaw` and `opencode`,
whose entries were read from their source, plus `codex` and `gemini-cli`),
**Docker with no network**, and a remote sandbox. Each CLI gets its own home
and configuration per run, only the bridge's tools, and no way to skip an
approval. Each spawned
runtime is killed as a whole process tree. An external runtime is a device:
it proves who it is by signing a challenge, it is paired by the fingerprint
of its key, and it stays read-only until the owner vouches for it.

### Isolation lives in the database

Row-level security is forced on every tenant table, and the agents' database
role cannot bypass it. A row cannot even reference another company's row,
because foreign keys are scoped to the company. Inside its own company, the
agents' role can only write what the platform writes. It cannot lift a
freeze, raise a ceiling, rewrite what a model call cost, or delete history.

## How it compares

PALUGADA was checked against four systems people use to run agents at work.
The comparison looked for what goes wrong in each of them, and whether the
same thing goes wrong here.

| | Chat workspaces (Slack, Buzz) | auto-company | Paperclip | **PALUGADA** |
|---|---|---|---|---|
| **Who approves an irreversible action** | Buzz auto-approves every tool permission | Nobody: "do not wait for human approval" | An approval with no expiry and no second factor | The owner, in the app, with a second factor. An unanswered approval cancels |
| **Isolation between companies** | — | — | Application code only (no row-level security policies) | Forced row-level security and company-scoped foreign keys |
| **Usage an agent did not price** | — | Pauses as "unverifiable" | Recorded at 0¢, so the hard stop never trips | Priced from the operator's list or a high fallback, settled against the runtime's own bill when it reports one |
| **Budget enforcement** | — | — | Checked at claim, summed afterwards | Reserved at admission, charged per call, rate circuit breaker |
| **Agents triggering agents** | Buzz: no hop limit | — | — | Hop limit and cycle detection |
| **Past decisions** | Lost as threads scroll | A consensus file the model rewrites every cycle | — | Stored as records with outcome and owner's note, searchable |

— means not applicable, or not established by the review. Each cell comes
from the source code at a fixed revision (file and line) or from public
documentation, cited in
[`docs/RESEARCH-2026-09.md`](docs/RESEARCH-2026-09.md).

## What's inside

**Companies and structure**
- Start a company from a template, with no deploy. The standard template is
  organised by function (Operations, Delivery and Build, Growth, Finance,
  Support, Assurance, Lab) and has eight roles, so it fits any line of
  business.
- Divisions nest two levels deep. A role gets work only when it has an output
  schema and at least one testable completion criterion.
- A goal ladder (mission → objective → key result). Every task names the goal
  it serves, agents can read the strategy but not change it, and the goal
  chain travels into every approval.
- Charters are files. Every change to a charter, policy, role or grant is
  versioned and can be restored.

**Work engine**
- Durable tasks with journaled steps, atomic checkout, leases, and lanes for
  work that must not overlap (one repository, one domain).
- Typed contracts between tasks, handoff on completion, sub-tasks with a
  mandatory timeout, and fan-out caps.
- Dry-run replay of any past run, which cannot reach the outside world.

**Capabilities and guardrails**
- A calibrated capability catalogue. A binding can tighten a tier but never
  loosen it.
- Mandatory read-back verification for writes. Plans record a count
  (contact 3 leads, not 23), and a batch guard holds each call to that count.
- Preflight: a task whose capability is broken does not start. It raises an
  incident instead.
- Declarative policies, where lower scopes can only tighten. Lifecycle hooks
  can refuse an action and never widen one.
- Adversarial review by a different role with its own memory. After two
  revisions, the decision goes to the owner.
- A role that keeps being denied is frozen until the owner looks.
- Code-executing capabilities can never also hold a credential or reach
  tier 2. Capabilities cannot reach the private network.
- A vendor integration is a JSON spec, not code: method, URL, body template,
  read-back, idempotency key.

**Scheduling**
- Durable cron in each schedule's own time zone, with a priority.
- Vendor windows that defer work instead of failing it. Owner hours that hold
  non-urgent escalations until the owner is available, while incidents still
  come through.
- Cheap hours for batchable, read-only work.
- A wake queue: roles sleep, wake on assignment or events, and nearby wakes
  are merged into one run.
- A schedule whose last five runs produced the same result asks the owner
  whether it is still worth running.

**Memory and learning**
- Four kinds of memory (working, episodic, semantic, procedural), scoped per
  company, project and division, and filtered before any similarity search.
- Facts are versioned and superseded, never overwritten. Episodes are
  distilled into facts, and facts into procedures, with the owner approving
  new procedures.
- Unverified facts are flagged to the agent in plain words.
- Skills in an open document format. A candidate skill needs an eval case, a
  reviewer and the owner before it goes live, and skills from outside start
  quarantined.
- Runs export as trajectories. A role eval scores a proposed change before
  the owner decides on it.

**The owner's console**
- A React and Mantine app in **English and Indonesian**, with light and dark
  themes, that works on a phone. The language is the owner's choice, kept by
  the deployment rather than the browser, so it follows them to every device.
- **Home** shows every company at once: what needs the owner across all of
  them, what is running with how far it has got, and each company's budget.
  Pages refresh themselves while open and say when they last did.
- For each company:
  - **Inbox**: the queue on one side and the chosen item on the other, with
    its goal chain, the requesting role, an expiry countdown and a
    step-by-step trace. The next item opens after each decision.
  - **Overview**: where the work is by stage, what is running now, progress
    on each objective, the budget, cost per day and recent activity.
  - **Work**: every task with its progress from its own journal (steps done
    against its plan, the step it is on, when its worker last checked in),
    its event timeline and a dry replay.
  - **Team**: an org chart where each role opens its charter (who it is and
    how it works), its done criteria and its controls; the goal ladder with
    progress, schedules and policies.
  - **Memory**: what the company knows and will tell its agents, with the
    unverified facts marked. The owner corrects a fact, confirms one, or tells
    the company something new.
  - **Money** and **History**, and one **Settings** page for the rest:
    company, languages, safeguards, skills, bundles, devices and security.
- Everything is picked from the company's own shape, never typed in as ids.
- Push for incidents and tier 3 approvals. Telegram buttons for the decisions
  a chat is allowed to make, and those buttons are removed once the item is
  decided elsewhere.
- Sign-in and approvals with a TOTP code. The API also verifies passkeys,
  though the console page cannot present one yet. Loosening a control needs a
  second factor; tightening one needs only the session.
- Stop everything, freeze a company, or kill one capability. A daily digest,
  a weekly retro, and alerts that fire once per condition per day.

**Languages**
- Each company has a work language (what it produces for its customers) and
  a talk language (what its agents write to the owner and to each other),
  with a deployment-wide default for both.
- Every run is told its languages right after its charter, where nothing is
  dropped, and told that nothing it reads can change them: not an email, not a
  web page, not a message asking it to switch. A task may still ask for a
  deliverable in another language on purpose.
- What agents write is checked. A plan in the wrong language is recorded and
  the role's next run is reminded of its own slip; a draft in the wrong
  language is asked for again before it is kept.

**PALUGADA develops PALUGADA**
- [`AGENTS.md`](AGENTS.md) is the guide for changing this repository, read by
  coding agents by convention and by `CLAUDE.md` through an import. A test
  keeps every command and path in it true.
- The built-in `palugada-dev` bundle adds a platform engineer that follows
  that guide and a read-only reviewer that checks each change before its
  branch is pushed. Nothing merges without the owner.
- `npm run check` is the whole definition of done, the same steps CI runs.

**Security and audit**
- An append-only event log with separate security events.
- Secrets are references (`env://`, `file://`), redacted from anything on its
  way to a durable record, and can be rotated without a restart.
- Retention is the only code that deletes anything, and it records what it
  removed.
- A whole company can be exported and restored on another instance, with every
  reference remapped.
- Signed bundles and trusted publishers. An unsigned bundle installs with
  read-only grants.
- Console sessions are shared by every replica and stored hashed. They end
  everywhere when their device is revoked. The console answers only to its
  own host names, which blocks DNS rebinding.

## Get started

Requires **Node 22.18+**, which runs TypeScript directly with no build step,
and **PostgreSQL 16** with [pgvector](https://github.com/pgvector/pgvector).

```sh
npm install
npm run db:setup         # database and its three roles (needs a superuser for pgvector)
npm run db:migrate
npm run console:install  # the owner's console: React, Mantine, Vite
npm run console:build    # built into console/dist, which the server serves
npm run totp:new         # the owner's first factor: add it to an authenticator app
npm start                # worker + owner console on http://127.0.0.1:8787
```

While working on the console itself, `npm --prefix console run dev` serves it
with hot reload and proxies `/api` to a running deployment on :8787.

`npm run totp:new` prints a secret and an `otpauth://` link. Point
`PALUGADA_OWNER_TOTP_REF` at where you keep the secret, and the first boot
enrols it. Connection settings are in [`.env.example`](.env.example).

Check an installation end to end:

```sh
npm run smoke
```

The smoke check builds a company and runs a task through the whole pipeline.
It fails if the tier 3 gate does not refuse without a second factor, if no
owner channel is reached, or if a built-in capability is missing.

For production, [`deploy/palugada.service`](deploy/palugada.service) is a
systemd unit. It runs as an unprivileged dynamic user and holds the owner's
secret as a systemd credential. A configuration error exits with code 78, so
the supervisor stops instead of restart-looping. SIGTERM closes the console
first and lets the worker finish its step.

## Configuration

Everything optional needs something outside this process, such as a vendor
account, a CLI or a URL. Each one reports at boot what is missing, so you
find out at startup rather than at 3am.

| Variable | What it turns on |
|---|---|
| `PALUGADA_OWNER_TOTP_REF` | The owner's first factor, enrolled at boot |
| `PALUGADA_SECRET_DIRS` | Where `file://` secrets may be read from (default `/run/secrets`) |
| `PALUGADA_VENDORS` | Vendor capabilities from a JSON spec file (see [`config/vendors.example.json`](config/vendors.example.json)) |
| `PALUGADA_MODEL_PRICES` | Model prices for runtimes that report tokens but no price (see [`config/prices.example.json`](config/prices.example.json)) |
| `PALUGADA_DRAFT_MODEL` | The model used for drafting, memory distillation and skill screening |
| `PALUGADA_CLAUDE_CODE_COMMAND` | The Claude Code runtime |
| `PALUGADA_RUNTIME_SPECS` | Other agent CLIs, as JSON |
| `PALUGADA_RUNTIME_HTTP_URL` | A runtime that answers over HTTP |
| `PALUGADA_RUNTIME_IMAGE` | The Docker runtime, with no network |
| `PALUGADA_SANDBOX_URL`, `_IMAGE` | A remote sandbox runtime |
| `PALUGADA_FILES_ROOT` | The company's files, for `files.list` and drafting |
| `PALUGADA_PUSH_URL` | Push notifications for incidents and tier 3 approvals |
| `PALUGADA_TELEGRAM_TOKEN`, `_CHAT`, `_WEBHOOK_SECRET` | Telegram with decision buttons. Point the bot's webhook at `<PALUGADA_APP_URL_PUBLIC>/api/channels/telegram` |
| `PALUGADA_APP_URL_PUBLIC` | Where the console is reached from the owner's phone. Notifications link there |
| `PALUGADA_ALLOWED_HOSTS` | The host names the console answers to. Defaults to the hosts of the public URL and origins, plus loopback |
| `PALUGADA_RP_ID`, `PALUGADA_ORIGIN` | Passkeys for the console's domain |
| `PALUGADA_ALLOW_PRIVATE_HOSTS` | An internal host that `web.fetch` may reach |

**Capabilities.** PALUGADA implements the ones that need no vendor account:
`web.fetch`, `uptime.check`, `files.list`, `doc.draft`, `email.draft`,
`memory.search` and `skill.read`. Capabilities that need somebody's account,
such as `email.send`, `invoice.issue` or `dns.update`, are bound by a vendor
file. The file carries no code, and PALUGADA refuses one that writes without
verifying, has a side effect without an idempotency key, or tries to loosen
the catalogue's tier.

## Under the hood

- **Stack**: TypeScript on Node 22 with no build step for the server, and
  PostgreSQL 16 with pgvector. Three database roles: agents (row-level
  security enforced), the control plane, and the schema owner. The console is
  React with [Mantine](https://mantine.dev), built by Vite and served from the
  same origin under a strict content security policy.
- **Tests**: acceptance tests grouped by requirement, run against a real
  PostgreSQL. CI runs the type check, every migration and the whole suite on
  each push, plus a nightly soak of twenty workers racing over a thousand
  claims.

```
src/
  engine/       tasks, journal, checkout and leases, budgets, contracts, handoff
  broker/       capability registry, catalogue, tiers, preflight, cost
  runtime/      the adapter protocol and the runtimes
  owner/        console API, sign-in, second factor, push, Telegram
  inbox/        approvals, incidents, escalations
  scheduler/    cron, windows, wake queue
  memory/       scoped memory and distillation
  skills/  eval/  bundles/  gateway/  governance/  policy/  review/
  secrets/  retention/  audit/  reporting/  templates/  capabilities/
console/        the owner's console: React + Mantine (src/), built to dist/
db/migrations/  schema and row-level security
test/           acceptance tests, one file per area of the specification
```

## Limits worth knowing

- **Vendor integrations are verified up to the wire, not against the vendors
  themselves.** Push, Telegram, the remote sandbox and the agent CLIs are
  exercised end to end against local servers. The Claude Code and Docker
  runtimes are verified up to the command line.
- **The in-process sandbox does not isolate the network.** Use the Docker
  runtime when that matters. The platform never gives code-executing
  capabilities a credential, whichever runtime you use.
- **Companies are frozen, exported or retained, never deleted.** The event log
  is append-only by design.
- **Vector search is exact.** That is correct at current volumes and keeps
  "filter by scope before similarity" literally true. Very large memories
  will need pgvector's iterative scans.

## Documentation

- [`docs/PRD.md`](docs/PRD.md): the product specification (v2, in
  Indonesian). Identifiers such as `F5.4` in the code refer to it.
- [`docs/STATUS.md`](docs/STATUS.md): every requirement graded as built,
  partial or not built, the design decisions, and the defects found and fixed.
- [`docs/RESEARCH-2026-09.md`](docs/RESEARCH-2026-09.md): the comparison with
  Slack, Buzz, auto-company and Paperclip.
- [`docs/decisions/`](docs/decisions/): decision records, including why
  PALUGADA was built rather than forked.
- [`AGENTS.md`](AGENTS.md) and [`CONTRIBUTING.md`](CONTRIBUTING.md): how to
  change PALUGADA, for agents and for people.
