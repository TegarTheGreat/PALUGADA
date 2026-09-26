# Running PALUGADA

The [README](../README.md#quickstart) has the quickstart. This page is the
rest: checking an installation, running it in production, and every setting.

## Installing

Requires **Node 22.18+**, which runs TypeScript directly with no build step,
and **PostgreSQL 16** with [pgvector](https://github.com/pgvector/pgvector).

```sh
npm install
npm run db:setup         # database and its three roles (needs a superuser for pgvector); refuses an existing one
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
enrols it. Connection settings are in [`.env.example`](../.env.example).

Check an installation end to end:

```sh
npm run smoke
```

The smoke check builds a company and runs a task through the whole pipeline.
It fails if the tier 3 gate does not refuse without a second factor, if no
owner channel is reached, or if a built-in capability is missing.

`db:setup` creates the database from nothing, and refuses when one already
exists, because it would drop it: bring an existing database up to date with
`npm run db:migrate`, or start again deliberately with
`PALUGADA_RESET_DATABASE=yes npm run db:setup`.

**Watching it run.** The worker writes one JSON line to standard error for
each task it runs and for anything that failed: a whole tick
(`tick.failed`), one stage of it (`stage.failed`), or a database connection
dropped under it (`db.connection_lost`). `GET /api/health` needs no session
and answers 200 when the database answers and the worker's loop has gone
round in the last half hour, and 503 with the reason when not. A task that
loses its worker three times is halted and raised to the owner as an
incident rather than put back again.

For production, [`deploy/palugada.service`](../deploy/palugada.service) is a
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
| `PALUGADA_MODEL_PROVIDER` | Which API the model speaks: `anthropic` (the default when a key is set) or `openai` for any OpenAI-compatible API: OpenAI, OpenRouter, Groq, Together, DeepSeek, Mistral, Gemini's compatible endpoint, and Ollama, vLLM, LM Studio or llama.cpp on your own machine. See **Models** below |
| `PALUGADA_MODEL_KEY_REF` | The model's key, as a secret reference (`env://PALUGADA_SECRET_MODEL_KEY`). Needed for `anthropic`; optional for `openai`, since a model on your own machine has none. Without a model, no role on the in-process runtime can work, and every role a template creates is on it |
| `PALUGADA_MODEL_URL` | Where the model API is. Defaults: `https://api.anthropic.com`, or `https://api.openai.com/v1` for `openai` |
| `PALUGADA_MODEL` | One model for every tier, such as `llama3.3` on Ollama. The simplest way to run on one model |
| `PALUGADA_MODEL_ALIASES` | Which model each tier a role names stands for, as JSON, laid over `PALUGADA_MODEL`. Anthropic defaults: `fast` = `claude-haiku-4-5-20251001`, `standard` = `claude-sonnet-5`, `deep` = `claude-opus-5-5`. An `openai` provider has no defaults: every tier must be named, or the boot stops and says which is missing |
| `PALUGADA_SECRET_DIRS` | Where `file://` secrets may be read from (default `/run/secrets`) |
| `PALUGADA_VENDORS` | Vendor capabilities from a JSON spec file (see [`config/vendors.example.json`](../config/vendors.example.json)) |
| `PALUGADA_MCP_SERVERS` | Tools from MCP servers, only those the file names (see [`config/mcp.example.json`](../config/mcp.example.json) and below) |
| `PALUGADA_MODEL_PRICES` | Model prices for runtimes that report tokens but no price (see [`config/prices.example.json`](../config/prices.example.json)) |
| `PALUGADA_DRAFT_MODEL` | The tier or model used for drafting, memory distillation and skill screening (default `standard`) |
| `PALUGADA_AGENT_CLIS` | Agent CLIs this platform knows, by name, found on `PATH`: `claude-code`, `codex`, `gemini-cli`, `opencode`, `hermes`, `openclaw`. See **Agent CLIs** below |
| `PALUGADA_CLAUDE_CODE_COMMAND` | Where the Claude Code binary is, when it is not `claude` on `PATH` |
| `PALUGADA_CLAUDE_CODE_KEY_VAR` | The one variable of this process's environment Claude Code is given, such as `ANTHROPIC_API_KEY` |
| `PALUGADA_RUNTIME_SPECS` | Any other agent CLI, as JSON; or a correction to a known one, such as `[{"name":"codex","command":"/opt/codex/bin/codex"}]` |
| `PALUGADA_RUNTIME_HTTP_URL` | A runtime that answers over HTTP |
| `PALUGADA_RUNTIME_IMAGE` | The Docker runtime, with no network |
| `PALUGADA_SANDBOX_URL`, `_IMAGE` | A remote sandbox runtime |
| `PALUGADA_FILES_ROOT` | The company's files, for `files.list` and drafting |
| `PALUGADA_PUSH_URL` | Push notifications for incidents and tier 3 approvals |
| `PALUGADA_TELEGRAM_TOKEN`, `_CHAT`, `_WEBHOOK_SECRET` | Telegram with decision buttons. Point the bot's webhook at `<PALUGADA_APP_URL_PUBLIC>/api/channels/telegram` |
| `PALUGADA_APP_URL_PUBLIC` | Where the console is reached from the owner's phone. Notifications link there |
| `PALUGADA_ALLOWED_HOSTS` | The host names the console answers to, comma-separated. Defaults to the hosts of the public URL and origins. Loopback is always allowed |
| `PALUGADA_BEHIND_PROXY` | `1` when the console is reached through a reverse proxy: the caller's address, which the sign-in throttle counts by, is then the last one the proxy added to `X-Forwarded-For`. Leave it unset otherwise, since without a proxy that header is whatever the caller wrote |
| `PALUGADA_RP_ID`, `PALUGADA_ORIGIN` | Where a passkey would be verified. The platform verifies a passkey assertion, but the console cannot present one yet, so the owner signs in and approves with an authenticator code |
| `PALUGADA_ALLOW_PRIVATE_HOSTS` | An internal host that `web.fetch` may reach |

**Runtimes.** A role's work is done by the runtime it names. With a model
key, the in-process runtime runs every role that has no handler of its own:
the model reads the role's charter and the owner's notes, calls the role's
tools through the broker, and finishes with the task's output. Each turn is
a journalled step, so a restart resumes at the turn it reached. Any other
runtime configured below can be chosen per role in the console (the role's
*Who does its work*), and only one this deployment runs is accepted.

**Models.** A role names a tier (`fast`, `standard`, `deep`), never a
model, so a company moves to another model by changing the deployment, not
its roles. Two wire formats cover almost every model there is:

```sh
# Anthropic
PALUGADA_SECRET_MODEL_KEY=sk-ant-...  PALUGADA_MODEL_KEY_REF=env://PALUGADA_SECRET_MODEL_KEY

# OpenAI
PALUGADA_MODEL_PROVIDER=openai  PALUGADA_MODEL_KEY_REF=env://PALUGADA_SECRET_MODEL_KEY \
  PALUGADA_MODEL_ALIASES='{"fast":"gpt-5-mini","standard":"gpt-5","deep":"gpt-5"}'

# OpenRouter: hundreds of models from every lab behind one key
PALUGADA_MODEL_PROVIDER=openai  PALUGADA_MODEL_URL=https://openrouter.ai/api/v1 \
  PALUGADA_MODEL_KEY_REF=env://PALUGADA_SECRET_MODEL_KEY  PALUGADA_MODEL=deepseek/deepseek-chat

# Gemini, through Google's OpenAI-compatible endpoint
PALUGADA_MODEL_PROVIDER=openai  PALUGADA_MODEL_URL=https://generativelanguage.googleapis.com/v1beta/openai \
  PALUGADA_MODEL_KEY_REF=env://PALUGADA_SECRET_MODEL_KEY  PALUGADA_MODEL=gemini-2.5-flash

# A model on your own machine: Ollama (vLLM, LM Studio and llama.cpp are the same, at their own port)
PALUGADA_MODEL_PROVIDER=openai  PALUGADA_MODEL_URL=http://localhost:11434/v1  PALUGADA_MODEL=qwen3:32b
```

The model must be able to call tools (function calling): the platform's own
loop offers each role its granted capabilities as tools, and a role that
cannot call them can only answer in words. Small local models often cannot.
A provider that is overloaded or rate limited is retried twice, honouring
`Retry-After`, and then the task falls back or waits; a refused key stops
every task the same way, so it is said once, naming the setting to check.
A model the price list does not name is charged at a conservative fallback
rate, so a budget is never understated; `PALUGADA_MODEL_PRICES` gives it its
real price, which for a model on your own machine is zero.

**Agent CLIs.** A role can be done by an agent CLI instead of the
platform's own loop: set `PALUGADA_AGENT_CLIS=codex` (or several, comma
separated), and choose the runtime on the role's page in the console. Each
runs in a directory of its own that is removed afterwards, with `HOME` set
there, none of its own shell, file or web tools, and the role's granted
capabilities as its only tools, through a bridge that exists for that run.
It sees nothing of this process's environment except `PATH` and the one
variable its entry names for its provider key:

| Name | Binary | Its key, from this process's environment | Checked |
|---|---|---|---|
| `claude-code` | `claude` | `PALUGADA_CLAUDE_CODE_KEY_VAR` names it, such as `ANTHROPIC_API_KEY` | Run, 2.1.283 |
| `codex` | `codex` | `OPENAI_API_KEY` | Run, 0.157.1 |
| `gemini-cli` | `gemini` | `GEMINI_API_KEY` | Run, 0.61.0 |
| `opencode` | `opencode` | none by default: name one with `apiKeyEnvVar` | Run, 1.18.32 |
| `hermes` | `hermes` | none by default | From source, v2026.9.24 or later |
| `openclaw` | `openclaw` | none by default | From source, 2026.9.6 |

Any field of an entry can be corrected in `PALUGADA_RUNTIME_SPECS` by
naming the CLI and the field, for example
`[{"name":"opencode","apiKeyEnvVar":"ANTHROPIC_API_KEY"}]`, and a CLI this
list does not name is described there in full: `command`, `args` with the
placeholders `{model}`, `{maxTurns}`, `{mcpConfigFile}`, `{mcpUrl}`,
`{mcpToken}`, `{allowedTools}`, `{prompt}` and `{runDir}`, `promptVia`,
`dialect` (`stream-json`, `text`, `hermes-stream-json`, `openclaw-json`,
`opencode-json`, `codex-jsonl` or `gemini-stream-json`), `env`, `files`,
`cwd`, `apiKeyEnvVar` and `maxTurns`. A spec that never hands its CLI the
bridge is refused at boot, because the CLI would run with no tools and
answer as though it had them.

**MCP servers.** `PALUGADA_MCP_SERVERS` names a file listing servers
(streamable HTTP) and, under each, the tools this deployment may use: each
becomes the capability `mcp.<server>.<tool>`, granted to divisions like any
other. A tool the file does not name does not exist here. The file states
each tool's tier, and the server can only raise it: a tool the server marks
destructive must be tier 3, and a tool at tier 0 must be one the server says
only reads. A tool at tier 1 or above must be pinned -- the boot prints the
pin of an unpinned tool -- and must name a read-back: another tool on the
same server and what its answer must say. A tool whose description or
arguments changed since it was pinned is refused. `credentialAlias` sends
the calling division's credential as a bearer token. Everything a server
returns counts as content from outside the company, so work that used it
asks the owner before its next tier 2 action.

**Capabilities.** PALUGADA implements the ones that need no vendor account:
`web.fetch`, `uptime.check`, `files.list`, `doc.draft`, `email.draft`,
`memory.search` and `skill.read`. Capabilities that need somebody's account,
such as `email.send`, `invoice.issue` or `dns.update`, are bound by a vendor
file. The file carries no code, and PALUGADA refuses one that writes without
verifying, has a side effect without an idempotency key, or tries to loosen
the catalogue's tier.
