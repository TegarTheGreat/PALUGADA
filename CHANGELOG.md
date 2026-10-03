# Changelog

What an owner or an operator would notice, by version. Which version is
running is on `/api/health`, in the metrics as `palugada_build_info`, and at
the foot of the owner's menu in the console. [docs/STATUS.md](docs/STATUS.md)
has each change in detail, with the defects found on the way to it, and
`docs/PRD.md` the requirement each one answers.

Migrations are append-only and run in order; `npm run db:migrate` brings any
earlier database up to the version it is run from, and refuses a migration
whose file changed after it ran.

## 0.1.0 (not yet released)

The first version. What it holds, in the order an owner meets it.

### Running companies

- Companies of AI agents with one human owner: divisions, roles with
  charters, personas and a mandatory CEO the owner talks to, projects,
  measurable goals, tickets, schedules, handoffs and inbound triggers.
- The platform's and each company's charter kept as files in a git
  repository beside the deployment, edited there or in the console
  (STATUS 2.44).
- Every step journalled, so a crash loses nothing; money and tokens reserved
  before work starts; leases, deadlines, per-run length and token ceilings;
  tasks at once per division and calls at once per capability, across every
  worker (STATUS 2.43).
- Any model through an OpenAI-compatible client, and any agent CLI (Claude
  Code, Codex, Gemini CLI, OpenCode, OpenClaw, Hermes), any agent that
  speaks the Agent Client Protocol (STATUS 2.42), a script, an HTTP service
  or a container as a role's runtime. A runtime in another process may call
  only its role's tools (STATUS 2.37).
- Memory that learns from real work and keeps what came from outside as data;
  the company's documents, found by their words and by their meaning
  (STATUS 2.35).
- Capabilities from vendor files, MCP servers (Composio, Pipedream, Arcade,
  Smithery and Zapier by name) and the platform's own, each at a tier.
- Coolify's and Dokploy's MCP servers by name, so a company's roles can see
  what runs there and, as far as the owner allows, deploy it (STATUS 2.54).
- The operating kit (`company-os` 1.4.0): a weekly business review handed
  the week from the company's records -- every goal's numbers and their
  change, the work finished, the spend against the limit, a stage move
  waiting -- goal changes a run proposes and the owner's yes applies, a
  critic that reads every stage proposal before the owner does and holds
  nothing that acts, a wind-down that puts a reply to a customer to the
  owner instead of refusing it, past events a run can search, and skills for
  positioning and market research (STATUS 2.53, 2.57).
- Done criteria whose evidence may cite a tool call by its step: the
  platform checks it against the journal and shows each criterion as
  verified or only claimed (STATUS 2.56).
- A schedule no longer starts a second run beside one still going: it
  skips the occurrence (the default, existing schedules included), waits
  for the last run to finish, or runs both, as the owner chooses; and a
  catch-up window drops an occurrence found too late after downtime. The
  schedules table says which occurrence did not run and why (STATUS 2.59).

- Schedules right on the nights the clock changes: a daily job runs once
  when the clock goes back and once, at the jump, when it goes forward; an
  hourly one keeps to real time; and a work window opens on its own zone's
  hour where that is not an hour of UTC, such as in Kolkata or Adelaide
  (STATUS 2.60).
- The console, and what PALUGADA sends the owner's phone, in 21 languages:
  English, Indonesian, Malay, Javanese, Sundanese, Filipino, Vietnamese,
  Thai, Simplified Chinese, Japanese, Korean, Hindi, Arabic (right to left),
  Spanish, Brazilian Portuguese, French, German, Dutch, Italian, Turkish and
  Russian. Why an approval was withdrawn, or a pressed button found its item
  closed, is said as a sentence in each rather than as a status code
  (STATUS 2.65).
- A project may have its own work language, for a company that sells in
  more than one market: runs in a Malaysia project write for customers in
  Malay and drafts there are checked against Malay, while agents still talk
  to the owner in the company's language. Set it when starting or editing a
  project; left unset, the project works in the company's (STATUS 2.63).
- Everything an agent writes to the owner or to another role -- a question,
  the summary of finished work, a brief it hands on, a ticket, a goal or
  stage proposal, a reviewer's reasons -- checked against the company's talk
  language as plans were, Javanese and Sundanese included; a slip is recorded,
  never refused, and the role's next run is told what it slipped in
  (STATUS 2.64).
- The CEO, and any role that hands work on, is told which roles the company
  has. It may name one by title or name ("the CMO", "Laras") as well as by
  slug. A name that fits no role is answered with the roles there are and
  the nearest one, so routing no longer ends in guesses and probe tasks
  (STATUS 2.66).
- Work a role hands back is no longer refused for being long. A finished
  plan or report over what a sub-agent may hand back reaches the role that
  asked for it cut short, with each cut saying where the whole is kept; the
  whole stays on the task that did it (STATUS 2.67).

### The owner

- One inbox for what cannot be undone: approvals bound to their action, a
  second factor for tier 3 and for every loosening, standing approvals for a
  while (STATUS 2.28), passkeys and recovery codes (STATUS 2.32).
- A guardian a company may turn on: after the work reads something from
  outside, a model looks at each small action and may send it to the owner,
  never let one through (STATUS 2.45).
- Told on Telegram, WhatsApp, a phone push, Slack, Discord or email, and able
  to decide on Telegram and WhatsApp (STATUS 2.31, 2.41).
- A console set up entirely from the panel -- the model, agent CLIs, tools,
  channels, services and MCP servers -- in the owner's language, with every
  message PALUGADA sends the owner in the same language, each language's
  plural forms, and a decision or a task's end said as a sentence rather
  than a code (STATUS 2.62, 2.65).
- Export and import of a whole company, and closing one, which erases every
  row of it after a grace period the owner chooses (STATUS 2.38).
- **Run now** on a schedule: the task its next occurrence would make, at
  once, with that occurrence left where it was; an off schedule can be tried
  this way and stays off, and a second press while the run is still going is
  refused and links to it (STATUS 2.61).

### Operating it

- Tenants separated by forced row-level security, composite keys between
  tenant tables, and an application role with only the grants its code uses.
- Health, Prometheus metrics with their own token, and traces to an
  OpenTelemetry collector (STATUS 2.27, 2.40); point-in-time recovery
  documented.
- Readiness for a load balancer (`/api/ready`), which says no the moment a
  stop begins while the console answers a few seconds more; health that asks
  the database once every five seconds however often it is asked; and the
  search across companies served by trigram indexes (STATUS 2.58).
- Docker Compose, a Docker image and a systemd unit; the running platform
  never holds the schema owner's URL; append-only history refuses TRUNCATE.
- The image sets its own database up from a superuser's URL and migrates
  before it starts, so it runs beside a stock pgvector database with nothing
  from the repository; PID 1 is started without any database password
  (STATUS 2.47).
- Compose files for Coolify and Dokploy, which build it from this
  repository and put HTTPS in front (docs/guide/coolify-dokploy.md,
  STATUS 2.49).
- A deployment with no owner prints a link as it starts; whoever opens it
  first adds their authenticator app and is the owner, with no secret in
  the environment (STATUS 2.48).
- CI's actions pinned by commit and the image's base by digest, moved by
  Dependabot's weekly pull requests; CI fails on a high or critical advisory
  in a production dependency (STATUS 2.54).
- Triggers that take their token in the address, for senders that can set
  nothing but a URL, such as Coolify's notifications (STATUS 2.55).
- A threat model ([docs/THREAT-MODEL.md](docs/THREAT-MODEL.md)) naming each
  defence, its test, and what is left.
