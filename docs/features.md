# What PALUGADA does

The [README](../README.md) is the short version. This page is the whole list:
what PALUGADA guarantees, and everything that is built. `docs/STATUS.md`
grades each requirement of the specification as built, partial or not built.

## The guarantees

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

## Everything that is built

**Companies and structure**
- Start a company from a template, with no deploy. The standard template is
  organised by function (Operations, Delivery and Build, Growth, Finance,
  Support, Assurance, Lab) and has eight roles, so it fits any line of
  business.
- The organisation moves on its own. The coordinator is where work arrives
  when the owner names no role, and it hands the work to the role whose job
  it is; the planner hands a finished plan to the builder. Both delegate as
  sub-tasks, bounded by hop limits, fan-out caps and the parent's budget.
- A stuck division asks the coordinator first. The coordinator gets a task
  carrying the escalation and an hour; then the owner is told, with what the
  coordinator did. A division that names nobody goes straight to the owner.
- "Let it run itself" when starting a company installs the `company-os`
  bundle: a strategist, a weekly business review and the operating skills.
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
- No second run beside a live one unless the schedule allows it: an
  occurrence skips, or waits for the last run to finish. A catch-up window
  drops an occurrence found too late after downtime, and the schedule says
  which occurrence did not run and why.
- Vendor windows that defer work instead of failing it. Owner hours that hold
  non-urgent escalations until the owner is available, while incidents still
  come through.
- Cheap hours for batchable, read-only work.
- Invoices kept in the books: numbered without gaps, written with the entry that
  puts what is owed in them, paid in part or in full, voided by a reversal; what
  is owed and what is late read from the books.
- Office hours for a company that wants a working day: what reaches the
  outside world -- an email, a post, a reply -- waits for the opening, while
  reading, drafting and planning go on at any hour.
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
- A React and Mantine app in **21 languages**: English, Indonesian, Malay,
  Javanese, Sundanese, Filipino, Vietnamese, Thai, Simplified Chinese,
  Japanese, Korean, Hindi, Arabic (drawn right to left), Spanish, Brazilian
  Portuguese, French, German, Dutch, Italian, Turkish and Russian, with light and dark
  themes, that works on a phone. The language is the owner's choice, kept by
  the deployment rather than the browser, so it follows them to every device,
  and it is also the language of every message PALUGADA itself sends them:
  Telegram, WhatsApp, email and push. Each dictionary is held complete by a
  test, with every plural form its language has (Russian's three) and nothing
  left in English but names.
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
- Sign-in and approvals with a TOTP code or a passkey. A passkey is added in
  Settings, Security, with a factor you already hold, and is then offered at
  sign-in and in every confirm dialog. Loosening a control needs a second
  factor; tightening one needs only the session.
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
- What agents write is checked, Javanese and Sundanese included. A plan, a
  question to the owner, the summary of finished work, a brief to another
  role, a ticket, a proposal or a reviewer's reasons in the wrong language is
  recorded, and the role's next run is reminded of its own slip and told what
  it was in; a draft in the wrong language is asked for again before it is
  kept.

**Running a company well, not only safely**
- Goals are measured by numbers with targets, and an agent's number counts as
  verified only when it read that number from its source.
- The built-in `company-os` bundle adds a strategist that proposes at most
  three bets and never applies them, a critic that reads every stage
  proposal before the owner does and whose verdict the owner sees, a weekly
  business review every Monday morning in the company's time zone, and
  operating skills -- validating an idea, premortems, pricing, unit
  economics, customer discovery, launch readiness, outbound rules -- that
  still go through review and the owner.
- Other services can start work through a trigger URL the owner opens, with a
  token or with the sender's own signature -- Stripe, GitHub, Slack and
  Standard Webhooks are checked exactly as they sign; what they send (JSON, a
  form or text) is data, and work that began outside takes no tier 2 action
  without the owner.
- Customers can write to a company on a Telegram bot, a WhatsApp Business
  number or its own mailbox (read over IMAP, answered over SMTP), which the
  owner connects with their device: each message starts work for the role
  they chose (a second, written before anyone picked the first up, joins
  it), what the customer wrote is data, and every reply is a tier 2 card
  the owner -- or an approver -- answers with the conversation beside it.
- Each company has a browser of its own, for sites with no API: a role reads
  pages as a person sees them and fills in a form only after the owner's
  yes, with every field and button on the card; sign-ins are sealed between
  uses, and every request the browser makes goes through the platform's own
  address checks. The owner watches each work's page live and takes the
  browser over with their device to sign in, which a role may ask for and
  never does itself.
- A company has a stage -- explore, validate, build, launch, grow, wind down
  -- that the owner sets and policies read: no paid reach before launch is a
  rule, not a hope. The strategist proposes a move with the evidence; the
  GO takes the owner's device.
- The owner hires a role, opens a division or starts a project from the
  console; hiring and opening a division take the owner's device.
- An agent that needs the owner asks, and its task waits for the answer.

**PALUGADA develops PALUGADA**
- [`AGENTS.md`](../AGENTS.md) is the guide for changing this repository, read by
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
  reference remapped: from the console's Home, or with
  `npm run company:import -- <archive> <slug>`.
- Signed bundles and trusted publishers. The built-in bundles install as
  written when they are exactly what this version ships; any other unsigned
  bundle installs quarantined, with read-only grants and its schedules off.
- Console sessions are shared by every replica and stored hashed. They end
  everywhere when their device is revoked. The console answers only to its
  own host names, which blocks DNS rebinding.

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
  chats/        customers' conversations, and the Telegram, WhatsApp and mailbox transports
  browser/      each company's browser: Chromium on a pipe, its proxy, its sealed cookies
  scheduler/    cron, windows, wake queue
  memory/       scoped memory and distillation
  skills/  eval/  bundles/  gateway/  governance/  policy/  review/
  secrets/  retention/  audit/  reporting/  templates/  capabilities/
console/        the owner's console: React + Mantine (src/), built to dist/
db/migrations/  schema and row-level security
test/           acceptance tests, one file per area of the specification
```
