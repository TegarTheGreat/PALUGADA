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

### The owner

- One inbox for what cannot be undone: approvals bound to their action, a
  second factor for tier 3 and for every loosening, standing approvals for a
  while (STATUS 2.28), passkeys and recovery codes (STATUS 2.32).
- Told on Telegram, WhatsApp, a phone push, Slack, Discord or email, and able
  to decide on Telegram and WhatsApp (STATUS 2.31, 2.41).
- A console in English and Indonesian, set up entirely from the panel: the
  model, agent CLIs, tools, channels, services and MCP servers.
- Export and import of a whole company, and closing one, which erases every
  row of it after a grace period the owner chooses (STATUS 2.38).

### Operating it

- Tenants separated by forced row-level security, composite keys between
  tenant tables, and an application role with only the grants its code uses.
- Health, Prometheus metrics with their own token, and traces to an
  OpenTelemetry collector (STATUS 2.27, 2.40); point-in-time recovery
  documented.
- Docker Compose, a Docker image and a systemd unit; the running platform
  never holds the schema owner's URL; append-only history refuses TRUNCATE.
- A threat model ([docs/THREAT-MODEL.md](docs/THREAT-MODEL.md)) naming each
  defence, its test, and what is left.
