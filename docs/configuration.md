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
owner channel is reached, or if a built-in capability is missing. It leaves
that company behind, and companies are not deleted, so run it against a
database you are setting up rather than one the business already uses. Run it
with PALUGADA stopped: it starts a worker of its own, and a running
deployment's worker may claim its task first -- and halt it, when that
deployment has no model for the runtime the check uses.

`db:setup` creates the database from nothing, and refuses when one already
exists, because it would drop it: bring an existing database up to date with
`npm run db:migrate`, or start again deliberately with
`PALUGADA_RESET_DATABASE=yes npm run db:setup`.

**Watching it run.** The worker writes one JSON line to standard error for
each task it runs and for anything that failed: a whole tick
(`tick.failed`), one stage of it (`stage.failed`), or a database connection
dropped under it (`db.connection_lost`). `GET /api/health` needs no session
and answers 200 when the database answers and the worker's loop has gone
round in the last half hour, and 503 with the reason when not.
`GET /api/ready` answers the same for a load balancer, and 503 from the
moment the process begins to stop
([operations](guide/operations.md#readiness-for-a-load-balancer)).
`GET /api/metrics` serves the same and much more to a Prometheus scraper
once `PALUGADA_METRICS_TOKEN` is set ([operations](guide/operations.md#metrics)). A task that
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

**Set in the console, or here.** The model can be chosen in the console, on
the **This deployment** page, by an owner who has no shell: they pick a
provider from a list, paste its key, pick the model from the list the
provider serves, test it, and confirm with their authenticator. What they
save is kept in the database and laid over this environment each time the
platform starts; an area set in the console replaces that whole area of the
environment (a model chosen there does not inherit `PALUGADA_MODEL_ALIASES`
from here), and **Go back to the environment's model** hands it back. A save
restarts the platform in its own process, so work in flight is handed back
and resumed and the owner stays signed in; another replica notices within
thirty seconds and restarts too. A saved setting that would stop the boot is
set aside with a note, so the console always comes back.

Keys typed in the console are sealed with AES-256-GCM before they are
stored, under a master key the database never holds: `PALUGADA_MASTER_KEY`
when it is set, or else a key file the platform makes the first time it
needs one, `master.key` in `PALUGADA_STATE_DIR`, readable by its own user
alone. A backup of the database alone is then not a list of every key the
company pays for. **Back the master key up apart from the database**: a
restored database with a different key cannot open the keys it holds, says
so, and names both keys' fingerprints; the owner then types the keys again.
A secret the owner saved is named like any other, as a reference:
`db://<name>` (the model's key is `db://model-key`).

| Variable | What it is for |
|---|---|
| `PALUGADA_MASTER_KEY` | The key that seals secrets set in the console: 32 bytes, as 64 hex characters or base64 (`openssl rand -hex 32`). Without it, the key file below is used |
| `PALUGADA_MASTER_KEY_PREVIOUS` | While the master key is rotated: the old key, or several separated by commas. What it sealed still opens, and each start reseals it under the current key and says how many. Remove it once every process has the new key |
| `PALUGADA_STATE_DIR` | Where the platform keeps its own state: the master key file, the agent CLIs the console installs (`tools/`), and the charters' repository (`charters/`). Default `~/.palugada`; under Docker Compose, the `home` volume |
| `PALUGADA_CHARTERS_DIR` | The git repository the charters are kept in as files, `PLATFORM.md` and `companies/<slug>/SOUL.md` (F3.11). Default `charters` in `PALUGADA_STATE_DIR`. A file edited there is the charter's next version within a minute; anything published elsewhere is written and committed. Without `git` on the machine the files are kept with no history |
| `PALUGADA_WORKER_CONCURRENCY` | How many tasks this process runs at once, from 1 to 16 (default 4). One place is kept for P0 work, so an urgent task starts even while the others are busy |
| `PALUGADA_METRICS_TOKEN` | Turns on `GET /api/metrics` for a scraper that sends it as a bearer token: a secret of at least 32 characters (`openssl rand -hex 32`). Unset, the route answers 404; the numbers are about every company, so nothing serves them without it |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | Sends each finished run to this OpenTelemetry collector as spans, over OTLP/HTTP in JSON (`…/v1/traces` is added). `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT` names the traces address itself; `OTEL_EXPORTER_OTLP_HEADERS` carries a backend's key; `OTEL_SERVICE_NAME` defaults to `palugada`. No prompt or response is sent ([operations](guide/operations.md#traces)) |

| Variable | What it turns on |
|---|---|
| `PALUGADA_OWNER_TOTP_REF` | The owner's first factor, enrolled at boot. Without it, a deployment with no owner prints a link as it starts that makes whoever opens it first the owner ([getting started](guide/getting-started.md#sign-in-for-the-first-time)) |
| `PALUGADA_MODEL_PROVIDER` | Which API the model speaks: `anthropic` (the default when a key is set) or `openai` for any OpenAI-compatible API: OpenAI, OpenRouter, Groq, Together, DeepSeek, Mistral, Gemini's compatible endpoint, and Ollama, vLLM, LM Studio or llama.cpp on your own machine. See **Models** below |
| `PALUGADA_MODEL_KEY_REF` | The model's key, as a secret reference (`env://PALUGADA_SECRET_MODEL_KEY`). Needed for `anthropic`; optional for `openai`, since a model on your own machine has none. Without a model, no role on the in-process runtime can work, and every role a template creates is on it |
| `PALUGADA_MODEL_URL` | Where the model API is. Defaults: `https://api.anthropic.com`, or `https://api.openai.com/v1` for `openai` |
| `PALUGADA_MODEL` | One model for every tier, such as `llama3.3` on Ollama. The simplest way to run on one model |
| `PALUGADA_MODEL_ALIASES` | Which model each tier a role names stands for, as JSON, laid over `PALUGADA_MODEL`. Anthropic defaults: `fast` = `claude-haiku-4-5-20251001`, `standard` = `claude-sonnet-5`, `deep` = `claude-opus-5-5`. An `openai` provider has no defaults: every tier must be named, or the boot stops and says which is missing |
| `PALUGADA_SECRET_DIRS` | Where `file://` secrets may be read from (default `/run/secrets`) |
| `PALUGADA_VENDORS` | Vendor capabilities from a JSON spec file (see [`config/vendors.example.json`](../config/vendors.example.json)) |
| `PALUGADA_MCP_SERVERS` | Tools from MCP servers, only those the file names (see [`config/mcp.example.json`](../config/mcp.example.json) and below) |
| `PALUGADA_MCP_SETTINGS` | The MCP servers the owner added in the console, as JSON in the file's shape; the console writes it, next to the file rather than in place of it |
| `PALUGADA_MODEL_PRICES` | Model prices for runtimes that report tokens but no price (see [`config/prices.example.json`](../config/prices.example.json)) |
| `PALUGADA_MODEL_PRICE_SETTINGS` | Prices laid over that file, as JSON `{ "models": { "<model>": { "input": <cents>, "output": <cents> } } }` per million tokens. `npm run setup` writes it; prices saved in the console are laid over it |
| `PALUGADA_MODELS_DEV_URL` | Where the console reads models.dev's catalogue for **Fill from models.dev** (default `https://models.dev/api.json`); a mirror for a deployment without the internet |
| `PALUGADA_DRAFT_MODEL` | The tier or model used for drafting, memory distillation and skill screening (default `standard`) |
| `PALUGADA_AGENT_CLIS` | Agent CLIs this platform knows, by name, found on `PATH`: `claude-code`, `codex`, `gemini-cli`, `opencode`, `hermes`, `openclaw`. See **Agent CLIs** below |
| `PALUGADA_AGENT_SETTINGS` | Per agent CLI, where its binary is, its tiers, and its credential by reference, as JSON; written by the console. See **Agent CLIs** below |
| `PALUGADA_CLAUDE_CODE_COMMAND` | Where the Claude Code binary is, when it is not `claude` on `PATH` |
| `PALUGADA_CLAUDE_CODE_KEY_VAR` | The one variable of this process's environment Claude Code is given, such as `ANTHROPIC_API_KEY` |
| `PALUGADA_RUNTIME_SPECS` | Any other agent CLI, as JSON; or a correction to a known one, such as `[{"name":"codex","command":"/opt/codex/bin/codex"}]` |
| `PALUGADA_RUNTIME_HTTP_URL` | A runtime that answers over HTTP |
| `PALUGADA_RUNTIME_IMAGE` | The Docker runtime, with no network |
| `PALUGADA_SANDBOX_URL`, `_IMAGE` | A remote sandbox runtime |
| `PALUGADA_FILES_ROOT` | The company's files, for `files.list`, `files.read`, drafting, `code.compute` and the files a letter carries (`email.send`'s `attachments`). Each company's are in a folder of their own beneath it, named by its id. The Compose deployment sets it to `/home/node/files`, on the volume that survives an upgrade, unless you set another; a root that is set and not there yet is made when the deployment starts, and one that cannot be made is said in the start-up notes. Without it drafting, pictures, speech, vision and `code.compute` are unbound, the console's Files tab says there are none to keep, and what a customer attaches to a mail is not kept (its message says so). Every process that serves the console or runs a worker must see the same root (a shared volume), or an upload made through one is not seen by the other |
| `PALUGADA_COMPUTE_IMAGE` | Python for `code.compute`: an image built from `deploy/compute` (`docker build --tag palugada/compute:1 deploy/compute`). A role's code runs in a container of it with no network, as nobody, on a read-only root, with the company's files it names copied in, and what it writes is kept under `computed/`. It needs `PALUGADA_FILES_ROOT`, and a docker this process can run: the image PALUGADA ships in has none, so in the Compose deployments it stays unbound. Prefer rootless podman or rootless Docker, or a docker host of its own reached through `DOCKER_HOST`: whatever can use the system's Docker daemon can become root on the machine. `npm run compute:check` proves the container where it will run |
| `PALUGADA_COMPUTE_DOCKER` | The docker client for `code.compute`, when it is not `docker` on `PATH` (`podman` works); `PALUGADA_RUNTIME_DOCKER` when unset |
| `PALUGADA_PUSH_URL` | Push notifications for incidents and tier 3 approvals. `PALUGADA_PUSH_FORMAT=ntfy` with `PALUGADA_PUSH_TOPIC` posts in ntfy's shape; `PALUGADA_PUSH_TOKEN` (or `_TOKEN_REF`) is its token |
| `PALUGADA_TELEGRAM_TOKEN`, `_CHAT`, `_WEBHOOK_SECRET` | Telegram with decision buttons. Point the bot's webhook at `<PALUGADA_APP_URL_PUBLIC>/api/channels/telegram`. The token and secret may be references instead, in `_TOKEN_REF` and `_WEBHOOK_SECRET_REF`; the console connects a bot for you. `PALUGADA_TELEGRAM_API` names a local Bot API server, for the owner's bot and every company's customer bot alike |
| `PALUGADA_WHATSAPP_PHONE_ID`, `_TOKEN`, `_APP_SECRET`, `_VERIFY_TOKEN`, `_OWNER` | WhatsApp with decision buttons, through Meta's Cloud API: the business number's ID, a system user's token, the app secret that signs deliveries, the verify token the webhook is subscribed with, and the owner's number with its country code. Point the app's webhook at `<PALUGADA_APP_URL_PUBLIC>/api/channels/whatsapp`. `PALUGADA_WHATSAPP_TEMPLATE` (`name:language`) names an approved template for writing first after 24 hours of silence. The three secrets may be references instead, in `_REF`; the console connects a number for you. `PALUGADA_WHATSAPP_API` names another Graph API address, for the owner's number and every company's customer number alike |
| `PALUGADA_SLACK_WEBHOOK`, `PALUGADA_DISCORD_WEBHOOK` | A Slack or Discord incoming webhook the owner is told things on, or a reference to one in `_WEBHOOK_REF` |
| `PALUGADA_EMAIL_PROVIDER`, `PALUGADA_EMAIL_KEY`, `PALUGADA_EMAIL_FROM`, `PALUGADA_EMAIL_TO` | Email to the owner through `resend`, `postmark` or `sendgrid`: its API key (or a reference in `PALUGADA_EMAIL_KEY_REF`), an address the service lets the account send from, and the owner's |
| `PALUGADA_APP_URL_PUBLIC` | Where the console is reached from the owner's phone. Notifications link there, and a sign-in to an MCP server that uses OAuth comes back to `<PALUGADA_APP_URL_PUBLIC>/api/oauth/callback`; without it, the sign-in works only from a console opened on this machine at `localhost`. A company's customer bot is told to send what customers write to `<PALUGADA_APP_URL_PUBLIC>/api/chat-hooks/<id>`; without it the bot is kept and cannot hear |
| `PALUGADA_MAIL_CA` | A PEM file of a certificate authority to trust, besides the system's, for a mailbox on a server with a private certificate: the one customers write to, and the ones divisions read and send from. A mailbox is read and answered only over TLS |
| `PALUGADA_ALLOWED_HOSTS` | The host names the console answers to, comma-separated. Defaults to the hosts of the public URL and origins. Loopback is always allowed |
| `PALUGADA_BEHIND_PROXY` | `1` when the console is reached through a reverse proxy: the caller's address, which the sign-in throttle counts by, is then the last one the proxy added to `X-Forwarded-For`. Leave it unset otherwise, since without a proxy that header is whatever the caller wrote |
| `PALUGADA_RP_ID`, `PALUGADA_ORIGIN` | Where passkeys are made and used: the relying party a device signs for, and the address the console is opened at. Each defaults to `PALUGADA_APP_URL_PUBLIC` (its host name, and its origin); set one only when it differs, such as `PALUGADA_RP_ID=example.com` for a passkey that works across a domain. Without either and without a public URL, passkeys cannot be made, and the owner signs in and approves with an authenticator code. A browser offers passkeys only over HTTPS, or on `localhost` |
| `PALUGADA_ALLOW_PRIVATE_HOSTS` | An internal host that `web.fetch` and the companies' browsers may reach |
| `PALUGADA_CHROMIUM` | The Chromium (or Chrome) the companies' browsers run on, for `browser.read` and `browser.act`, and the one `web.extract` and `files.read` read pages and documents in. Without it, one is looked for where a package manager or Playwright puts it; with none, both are unbound and the boot says so. `PALUGADA_BROWSER=off` leaves them unbound however one is found |
| `PALUGADA_BROWSER_SANDBOX` | `off` runs Chromium without its own sandbox, which needs user namespaces: as root, or in a container that is not given them, it will not start otherwise. The image's container is given them by `deploy/docker/seccomp-chromium.json`, which every compose file names. Off, a page that breaks out of Chromium's renderer reaches this process's user, so it is said at every boot |

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
rate, so a budget is never understated. Its real price comes from the
console (**This deployment**, **Model**, **What it costs**, which can fill
itself from [models.dev](https://models.dev)), from `npm run setup`, or from
the file `PALUGADA_MODEL_PRICES` names; for a model on your own machine it
is zero.

**Agent CLIs.** A role can be done by an agent CLI instead of the
platform's own loop. The console installs, signs in and turns on the known
ones (**This deployment**, **Agent CLIs**; see the
[how-to](guide/how-to.md#put-a-role-on-an-agent-cli)); from the environment,
set `PALUGADA_AGENT_CLIS=codex` (or several, comma separated). Either way,
choose the runtime on the role's page in the console. Each runs in a
directory of its own that is removed afterwards, with `HOME` set there, none
of its own shell, file or web tools, and the role's granted capabilities as
its only tools, through a bridge that exists for that run. Claude Code keeps
the operator's home only when its key comes from this process's environment,
since then its login may live there; it is shut out of the operator's
settings, hooks and memory by flag. None sees anything of this process's
environment except `PATH` and the one variable its entry names for its
provider key, or the credential the owner saved in the console.

What the console saves reaches the platform as `PALUGADA_AGENT_CLIS` and
`PALUGADA_AGENT_SETTINGS`, which can also be written by hand: a JSON object
by CLI name, each with any of `command` (where the binary is), `models`
(what each tier means to it), `secretEnv` (a variable the CLI reads, and the
secret reference to fill it from, such as
`{"CLAUDE_CODE_OAUTH_TOKEN":"db://agent-claude-code"}`) and `env` (anything
else it reads, never a secret: Hermes is told its provider with
`HERMES_INFERENCE_PROVIDER`), and `acceptVersion` (a version other than the
checked one that the owner accepted). The console installs into `tools/<name>` in
`PALUGADA_STATE_DIR` with `npm install --prefix`, at the version in the
table below; that directory belongs to the machine it is on, so a
deployment with several replicas installs on each, or bakes the CLI into its
image.

What keeps each CLI to PALUGADA's tools is its own flags and settings, and
those were checked against one version of each: Claude Code 2.1.283, Codex
0.157.1, Gemini CLI 0.61.0, OpenCode 1.18.32 and OpenClaw 2026.9.6
(`src/runtime/checked-versions.ts`). A CLI that answers `--version` with
another gets no work -- its roles' tasks wait on the queue, and the runtime
shows as not answering with the reason -- until the owner installs the
checked version or accepts the one installed, from **Agent CLIs**, with
their device. By hand, that is `acceptVersion` in its entry. Each run also
turns the CLI's own updater off, so it is not replaced between runs: Claude
Code by `DISABLE_AUTOUPDATER`, Codex by `check_for_update_on_startup`,
Gemini CLI by `general.enableAutoUpdate`, OpenCode by `autoupdate`. Hermes
installs from its own script at no version the console can choose, and is
held to none.

A host-wide Claude Code credential outside `HOME` -- a managed settings
file in `/etc/claude-code`, or a remote session's token in a fixed path --
is read by Claude Code whatever its environment says. PALUGADA cannot hide a
file from a process without a mount namespace, so do not run PALUGADA on a
machine that holds one you do not want its roles to use.

A role names a tier, and each CLI is told what the tier means to it:
Claude Code by its own aliases (`haiku`, `sonnet`, `opus`), Gemini CLI by
its flash and pro models, and the others by a `models` field in their entry,
such as `[{"name":"codex","models":{"fast":"…","standard":"…","deep":"…"}}]`.
A tier a CLI has no model for halts the task, and the message names this
setting:

| Name | Binary | Its key, from this process's environment | Checked |
|---|---|---|---|
| `claude-code` | `claude` | `PALUGADA_CLAUDE_CODE_KEY_VAR` names it, such as `ANTHROPIC_API_KEY` | Run, 2.1.283 |
| `codex` | `codex` | `CODEX_API_KEY` (`codex exec` ignores `OPENAI_API_KEY`) | Run, 0.157.1 |
| `gemini-cli` | `gemini` | `GEMINI_API_KEY` | Run, 0.61.0 |
| `opencode` | `opencode` | none by default: name one with `apiKeyEnvVar` | Run, 1.18.32 |
| `hermes` | `hermes` | none by default | From source, v2026.9.24 or later |
| `openclaw` | `openclaw` | none by default | From source, 2026.9.6 |

Any field of an entry can be corrected in `PALUGADA_RUNTIME_SPECS` by
naming the CLI and the field, for example
`[{"name":"opencode","apiKeyEnvVar":"ANTHROPIC_API_KEY"}]`, and a CLI this
list does not name is described there in full: `command`, `args` with the
placeholders `{model}`, `{maxTurns}`, `{wallClockSeconds}` (the run's
deadline in seconds, or the lease when the task has none: for a CLI with a
timeout of its own), `{mcpConfigFile}`, `{mcpUrl}`, `{mcpToken}`,
`{allowedTools}`, `{prompt}` and `{runDir}`, `promptVia`, `dialect`
(`stream-json`, `text`, `hermes-stream-json`, `openclaw-json`,
`opencode-json`, `codex-jsonl`, `gemini-stream-json` or `acp`), `env`, `files`,
`cwd`, `models`, `apiKeyEnvVar`, `maxTurns` (a whole number of at least 1:
Hermes reads 0 as no limit) and `hostSignInModels` (model name prefixes the
CLI would sign in to with the machine's own identity, which are refused;
OpenClaw's entry names `amazon-bedrock/` and `claude-cli/`), and `costArgs`
(a second call, same command, that reads what the run cost when the CLI's
stream does not say; `{sessionId}` is the id its result line gave -- Hermes's
entry reads its own ledger with `sessions export`). A spec that
never hands its CLI the bridge is refused at boot, because the CLI would run
with no tools and answer as though it had them.

**Agents that speak ACP.** An agent that speaks the Agent Client Protocol,
version 1, is a runtime from one entry with `"dialect": "acp"`: Gemini CLI
with `--acp`, Claude through `npx @agentclientprotocol/claude-agent-acp`,
Codex through `npx @agentclientprotocol/codex-acp`, `goose acp`,
`opencode acp`, and the others in the protocol's registry. For Gemini CLI,
signed in with its key as its own entry is:

```json
[{"name": "gemini-acp", "command": "gemini", "args": ["--acp", "--model", "{model}"], "dialect": "acp",
  "models": {"fast": "gemini-2.5-flash", "standard": "gemini-2.5-pro", "deep": "gemini-2.5-pro"},
  "env": {"HOME": "{runDir}"}, "apiKeyEnvVar": "GEMINI_API_KEY",
  "files": {".gemini/settings.json": "{"security": {"auth": {"selectedType": "gemini-api-key"}}}"}}]
```

The protocol hands the agent the tool bridge itself, as an MCP server over
HTTP named `palugada`, so an ACP entry needs no bridge placeholder. An
agent that cannot reach an MCP server over HTTP, speaks another version,
or says it is not signed in halts its task with that reason, once, rather
than spending the task's attempts on the same answer. PALUGADA offers
it no file system and no terminal, answers its permission questions --
once, never "always" -- yes for the role's own tools and no for anything
else, and sends `session/cancel` to a withdrawn run five seconds before
the process is ended. What the agent says the session cost, in US
dollars, is what the run is charged. The model is chosen in `args`, as
the agent reads it: version 1 has no message for it. The version check
does not hold these entries: they are not ones PALUGADA installs.

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
the calling division's credential as a bearer token; `tokenRef`, a secret
reference, sends the server's own token instead. `tokenIn` says where a
server reads its token when that is not `Authorization: Bearer`: another
`header` (Exa's `x-api-key`), another `scheme` (Sentry's `Sentry-Bearer`),
or a `query` parameter (Browserbase's `browserbaseApiKey`). A task's calls
to a server share one session, ended after five quiet minutes and at
shutdown, so a server that keeps state between calls -- a browser -- keeps
it for the task. Everything a server
returns counts as content from outside the company, so work that used it
asks the owner before its next tier 2 action. Servers the owner adds in
the console (**This deployment**, **MCP servers**) reach the platform as
`PALUGADA_MCP_SETTINGS`, the same shape with each token sealed, and are
bound next to the file's; one that no longer passes is left out with a
note rather than stopping the start.

**Capabilities.** PALUGADA implements the ones that need no vendor account:
`web.fetch`, `uptime.check`, `files.list`, `files.read`, `doc.draft`, `email.draft`,
`memory.search` and `skill.read`, and `mailbox.read` and `email.send` with
the mailbox each division is given on **Team** (a vendor entry for either
is used instead). `web.search` and `web.extract` go to the
provider the owner chooses in the console (**This deployment**, **Tools**),
or the one these name:

| Variable | What it is |
|---|---|
| `PALUGADA_SEARCH_PROVIDER` | Where `web.search` goes: `brave`, `tavily`, `exa`, `firecrawl`, `perplexity`, `parallel`, `keenable`, `jina`, `serpapi`, `serper`, or your own `searxng` or `firecrawl-self-hosted` |
| `PALUGADA_SEARCH_URL` | Your own server's address, for `searxng` and `firecrawl-self-hosted` |
| `PALUGADA_SEARCH_KEY_REF` | The provider's key, as a secret reference. `tavily`, `firecrawl` and `keenable` answer without one, at a rate-limited free tier |
| `PALUGADA_EXTRACT_PROVIDER` | Where `web.extract` goes: `jina`, `firecrawl`, `tavily`, `exa`, `parallel`, `keenable`, or your own `firecrawl-self-hosted`. Unset, a deployment with a Chromium reads pages in its own browser |
| `PALUGADA_EXTRACT_URL` | Your own server's address, for `firecrawl-self-hosted` |
| `PALUGADA_EXTRACT_KEY_REF` | Its key. `jina` (20 pages a minute), `firecrawl`, `tavily` and `keenable` answer without one |

`image.generate`, `speech.synthesize` and `speech.transcribe` are chosen the same way; the last two also let the owner speak to the assistant and hear it, which needs no files. What they
make is a file, written under the company's own directory in
`PALUGADA_FILES_ROOT`, in `generated/`, so both need that set:

| Variable | What it is |
|---|---|
| `PALUGADA_IMAGE_PROVIDER` | Where `image.generate` goes: `openai`, `fal`, `openrouter`, `deepinfra`, `xai`, `gemini`, or your own `comfyui` |
| `PALUGADA_IMAGE_URL` | Your ComfyUI's address, such as `http://127.0.0.1:8188`. It takes no key, so keep it on a private network |
| `PALUGADA_IMAGE_KEY_REF` | Its key, as a secret reference; each of the hosted ones needs one |
| `PALUGADA_IMAGE_MODEL` | A model other than the one each suggests, such as `fal-ai/flux-2/klein/9b` for `fal`; for `comfyui`, a checkpoint it has (`sd_xl_base_1.0.safetensors` unless given). ComfyUI is sent its own default workflow, sized for SDXL, and the picture is previewed there rather than saved in its output folder |
| `PALUGADA_SPEECH_PROVIDER` | Where `speech.synthesize` goes: `openai`, `elevenlabs`, `xai`, `gemini`, `deepinfra`, or your own `piper` |
| `PALUGADA_SPEECH_URL` | Your Piper server's address (`python3 -m piper.http_server`) |
| `PALUGADA_SPEECH_KEY_REF` | Its key; `piper` takes none |
| `PALUGADA_SPEECH_MODEL` | A model other than the one each suggests |
| `PALUGADA_SPEECH_VOICE` | The voice a role gets when it names none, such as `marin` for `openai` or `Kore` for `gemini`; a role may ask for another |
| `PALUGADA_LISTEN_PROVIDER` | What writes down speech -- the owner's voice to the assistant, and `speech.transcribe` for roles: `openai`, `groq`, `deepgram`, `elevenlabs`, `gemini`, `deepinfra`, or your own `speaches` or `whisper-cpp` |
| `PALUGADA_LISTEN_URL` | Your own server's address, for `speaches` and `whisper-cpp` (start whisper.cpp's server with `--convert`, so it takes the browser's WebM) |
| `PALUGADA_LISTEN_KEY_REF` | Its key; `speaches` takes one only if yours asks, `whisper-cpp` none |
| `PALUGADA_LISTEN_MODEL` | A model other than the one each suggests |
| `PALUGADA_VISION_PROVIDER` | What reads a picture for `image.describe`: `openai`, `gemini`, `anthropic`, `openrouter`, `groq`, `mistral`, or your own `openai-compatible` server (Ollama, llama.cpp, vLLM). The pictures are the company's files, so it needs `PALUGADA_FILES_ROOT` |
| `PALUGADA_VISION_URL` | Your own server's address, for `openai-compatible`, such as `http://localhost:11434/v1` |
| `PALUGADA_VISION_KEY_REF` | Its key; your own server takes one only if it asks |
| `PALUGADA_VISION_MODEL` | A model other than the one each suggests; for your own server, the one it serves (`qwen2.5vl` unless given) |
| `PALUGADA_EMBED_PROVIDER` | What finds the company's documents by meaning as well as by words: `openai`, `gemini`, `mistral`, `voyage`, `jina`, or your own `ollama` or `openai-compatible` server |
| `PALUGADA_EMBED_URL` | Your own server's address, for `ollama` (`http://localhost:11434/v1`) and `openai-compatible` |
| `PALUGADA_EMBED_KEY_REF` | Its key; `ollama` takes none |
| `PALUGADA_EMBED_MODEL` | A model other than the one each suggests. Changing it gives every passage a new vector, a batch at a time |

Each call reserves the provider's price for one call before it runs.
DuckDuckGo is not offered: it has no web-results API, and what other agents
use for it scrapes several engines. Edge TTS is not offered either: it is a
browser's read-aloud endpoint, not an API anyone was given. Until a provider is chosen, both are
known by name and say where to choose one. Capabilities that need somebody's account,
such as `email.send`, `invoice.issue` or `dns.update`, are bound by a vendor
file. The file carries no code, and PALUGADA refuses one that writes without
verifying, has a side effect without an idempotency key, or tries to loosen
the catalogue's tier. An entry whose key is signed in for rather than pasted
says so under `signIn`: a `provider` and the `scopes` its call needs.
`google` and `microsoft` are known by name. For any other provider, also
give its `authorizeUrl` and `tokenUrl`, both https. `params` adds to the
authorization request, and `clientUrl` is where the owner registers the app.
Such an entry must name its `credentialAlias`, and it sends the key as
`Bearer {credential}`, like any other. The owner registers one app with the
provider for the deployment, and the sign-in comes back to the address in
`PALUGADA_APP_URL_PUBLIC`, as an MCP server's does.
