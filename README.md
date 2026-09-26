<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="brand/banners/palugada-banner-dark.png">
    <img alt="PALUGADA" src="brand/banners/palugada-banner-light.png" width="860">
  </picture>
</p>

<h3 align="center">Run companies staffed by AI agents.<br>Decide only what cannot be undone.</h3>

<p align="center">
  <a href="#quickstart"><b>Quickstart</b></a> ·
  <a href="#how-it-works"><b>How it works</b></a> ·
  <a href="docs/features.md"><b>All features</b></a> ·
  <a href="docs/configuration.md"><b>Configuration</b></a> ·
  <a href="docs/STATUS.md"><b>Status</b></a> ·
  <a href="CONTRIBUTING.md"><b>Contributing</b></a>
</p>

<p align="center">
  <a href="https://github.com/TegarTheGreat/PALUGADA/actions/workflows/ci.yml"><img alt="CI" src="https://github.com/TegarTheGreat/PALUGADA/actions/workflows/ci.yml/badge.svg"></a>
  <img alt="Node 22.18+" src="https://img.shields.io/badge/Node-22.18%2B-339933?logo=node.js&logoColor=white">
  <img alt="PostgreSQL 16 with pgvector" src="https://img.shields.io/badge/PostgreSQL-16%20%2B%20pgvector-4169E1?logo=postgresql&logoColor=white">
  <img alt="TypeScript" src="https://img.shields.io/badge/TypeScript-strict-3178C6?logo=typescript&logoColor=white">
  <img alt="Console in English and Indonesian" src="https://img.shields.io/badge/console-EN%20%C2%B7%20ID-4f46e5">
</p>

<p align="center">
  <img alt="The owner's home: what needs a decision across every company, and what is being worked on" src="docs/images/home.webp" width="900">
</p>

**PALUGADA** is a self-hosted control plane for companies run by AI agents.
Agents plan, build, market, answer customers and keep the books. You own the
company, and your whole job is one inbox of decisions -- in the console, a push
notification or a Telegram button. Nothing irreversible happens until you say
so, and money is reserved before any work starts.

If an agent CLI is an employee, PALUGADA is the company around it: the org
chart, the budget, the rulebook, the memory and the owner's desk. One
installation runs as many companies as you like, each isolated in the
database.

> *Palugada* is Jakarta slang: *apa lu mau, gua ada* -- whatever you need,
> it's here.

## How it works

<table>
  <tr>
    <td width="33%" valign="top">
      <h3>1. Start a company</h3>
      From the standard template: eight divisions by function -- operations,
      delivery, build, growth, finance, support, assurance, a lab -- a role in
      each with a charter and done criteria, a budget for every division and a
      goal ladder. Tick <i>Let it run itself</i> and a strategist reviews the
      week every Monday.
    </td>
    <td width="33%" valign="top">
      <h3>2. Give it work</h3>
      Tell the coordinator what you want. It hands the work to the role whose
      job it is, and that role runs on the agent you choose: Claude Code,
      Codex, OpenCode, Gemini CLI, Hermes, OpenClaw, an HTTP service or Docker
      with no network. Every action it takes goes through a broker that knows
      its cost and how hard it is to undo.
    </td>
    <td width="33%" valign="top">
      <h3>3. Decide what matters</h3>
      Reading and undoable work simply happens. Spending needs a recorded plan
      and budget. Anything irreversible waits for you, with a second factor.
      A request you never answer cancels itself, so silence never executes
      anything.
    </td>
  </tr>
</table>

| Tier | Effect | For example | What happens |
|---|---|---|---|
| 0 | Reads | a DNS lookup, an uptime check | Runs |
| 1 | Cheap to undo | a draft, a staging deploy | Runs, then is read back to verify it |
| 2 | Costs money or reaches people | an email to a customer, an invoice paid | Needs a plan and a budget check first, verified after |
| 3 | Irreversible | nameservers, deletions, transfers, signatures | Waits for you, in the app, with a second factor |

No template, policy or agent can move a tier 3 action out of your hands.

## Quickstart

You need **Node 22.18+** and **PostgreSQL 16** with
[pgvector](https://github.com/pgvector/pgvector).

```sh
git clone https://github.com/TegarTheGreat/PALUGADA.git && cd PALUGADA
npm install && npm run console:install
npm run db:setup && npm run db:migrate   # once; pgvector needs a Postgres superuser
npm run console:build
npm run totp:new                         # two variables, and a link for your authenticator app
export PALUGADA_SECRET_OWNER_TOTP=<secret> PALUGADA_OWNER_TOTP_REF=env://PALUGADA_SECRET_OWNER_TOTP
export PALUGADA_SECRET_MODEL_KEY=<Anthropic API key> PALUGADA_MODEL_KEY_REF=env://PALUGADA_SECRET_MODEL_KEY
npm start
```

Open **http://127.0.0.1:8787**, sign in with the six-digit code from your
authenticator, and press **Start a company**. The model key is what does the
work: without it a company starts and none of its roles can act. `npm run smoke` checks an
installation end to end. Production, vendor accounts, push, Telegram and
every other setting are in [docs/configuration.md](docs/configuration.md).

## What you get

<table>
  <tr>
    <td width="33%" valign="top"><b>📥 One inbox</b><br>Every decision from every company in one queue, with the goal it serves, what it costs, how reversible it is and what happens if you say no.</td>
    <td width="33%" valign="top"><b>🔐 The irreversible waits for you</b><br>A second factor for tier 3, approvals that expire into a cancellation, and one approval for exactly one action.</td>
    <td width="33%" valign="top"><b>💸 Money cannot run away</b><br>Reserved before work starts, a ceiling per task and per month, a warning at 80%, a pause at 100% and a breaker on the burn rate.</td>
  </tr>
  <tr>
    <td valign="top"><b>🏢 An organisation that moves</b><br>A coordinator routes work, a planner hands the build to the builder, and a stuck division asks the coordinator before it asks you.</td>
    <td valign="top"><b>🤖 Bring any agent</b><br>Agents never see a credential or a database. Each CLI runs in its own home, with only the tools it was granted.</td>
    <td valign="top"><b>♻️ A crash loses nothing</b><br>Every step is journalled, leases stop a task running twice, and hop limits and deadlines end runaway work.</td>
  </tr>
  <tr>
    <td valign="top"><b>🛡️ Isolation in the database</b><br>Row-level security forced on every tenant table: a row cannot even point into another company.</td>
    <td valign="top"><b>🧠 A company that learns</b><br>Versioned facts, procedures distilled from experience, skills with eval cases, and your word on delivered work.</td>
    <td valign="top"><b>🌏 In your language</b><br>The console in English and Indonesian, and each company chooses what its agents write in.</td>
  </tr>
</table>

Everything else -- goals measured by numbers, stage gates, schedules, signed
webhooks, bundles, audit export -- is in [docs/features.md](docs/features.md).

<table>
  <tr>
    <td width="50%"><img alt="The inbox: the queue, and the decision in front of you with its reasons" src="docs/images/inbox.webp"></td>
    <td width="50%"><img alt="The team: divisions and roles as an org chart" src="docs/images/team.webp"></td>
  </tr>
  <tr>
    <td><img alt="Work: every task with how far it has got" src="docs/images/work.webp"></td>
    <td><img alt="A company's overview in the dark theme" src="docs/images/overview-dark.webp"></td>
  </tr>
</table>

## What PALUGADA is not

| | |
|---|---|
| **Not a chat workspace** | You do not manage agents in threads. You answer decisions, and they stay searchable. |
| **Not an agent framework** | It does not build agents. It runs a company of them, whichever ones you bring. |
| **Not a workflow builder** | Work is goals, roles and tasks with contracts, not boxes and arrows. |
| **Not an autopilot without brakes** | What cannot be undone always waits for a person. That is the design, not a setting. |

## How it compares

PALUGADA was read against four systems people use to run agents at work,
looking for what goes wrong in each and whether it goes wrong here.

| | Chat workspaces (Slack, Buzz) | auto-company | Paperclip | **PALUGADA** |
|---|---|---|---|---|
| **An irreversible action** | Buzz approves every tool permission itself | "Do not wait for human approval" | Approvals with no expiry and no second factor | The owner, with a second factor; unanswered means cancelled |
| **Isolation between companies** | — | — | Application code only | Forced row-level security, company-scoped foreign keys |
| **Usage an agent did not price** | — | Paused as "unverifiable" | Recorded at 0¢, so the hard stop never trips | Priced from the operator's list or a high fallback |
| **Agents triggering agents** | Buzz: no hop limit | — | — | Hop limit and cycle detection |
| **Past decisions** | Lost as threads scroll | A file the model rewrites each cycle | — | Records with the outcome and your note, searchable |

Each cell is cited to source code or public documentation in
[docs/RESEARCH-2026-09.md](docs/RESEARCH-2026-09.md).

## Architecture

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

TypeScript on Node 22 with no build step for the server, PostgreSQL 16 with
pgvector, and a React and [Mantine](https://mantine.dev) console served from
the same origin under a strict content security policy. The engine never
calls a model to do a task itself: it lends the runtime tool calls through the
broker, journalled steps, contained sub-tasks and a way to report cost.

## Limits worth knowing

- **Vendor integrations are verified up to the wire.** Push, Telegram, the
  sandbox and the agent CLIs are exercised end to end against local servers,
  not against the vendors themselves.
- **The in-process sandbox does not isolate the network.** Use the Docker
  runtime when that matters; code-executing capabilities never get a
  credential either way.
- **Companies are frozen, exported or retained, never deleted.** The event log
  is append-only by design.
- **A capability that needs somebody's account waits for one.** Sending
  email, paying invoices or changing DNS is bound by a vendor file you
  provide; until then the role is told it needs a vendor.

## Documentation

- [docs/features.md](docs/features.md): the guarantees and everything that is built.
- [docs/configuration.md](docs/configuration.md): installing, production and every setting.
- [docs/STATUS.md](docs/STATUS.md): every requirement graded, with the defects found and fixed.
- [docs/PRD.md](docs/PRD.md): the specification (v2, in Indonesian); `F5.4` in the code refers to it.
- [docs/RESEARCH-2026-09.md](docs/RESEARCH-2026-09.md): the comparison with Slack, Buzz, auto-company and Paperclip.
- [brand/](brand/README.md): the logo, the banners and the console's pictures.

## Contributing

[CONTRIBUTING.md](CONTRIBUTING.md) is for people and [AGENTS.md](AGENTS.md)
for coding agents; both describe the same loop: find the requirement, write
the failing test, change the code, run `npm run check`. PALUGADA can take a
task about its own code too: the built-in `palugada-dev` bundle adds a
platform engineer and a read-only reviewer, and nothing merges without you.

## Security

Please report a vulnerability privately through GitHub's
**Report a vulnerability** on this repository rather than in an issue.

## License

PALUGADA does not carry a license yet. Until the owner chooses one, the code
is visible here but not licensed for reuse.
