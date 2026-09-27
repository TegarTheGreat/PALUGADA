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
database you are setting up rather than one the business already uses.

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
| `PALUGADA_STATE_DIR` | Where the platform keeps its own state: the master key file, and the agent CLIs the console installs (`tools/`). Default `~/.palugada`; under Docker Compose, the `home` volume |

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
| `PALUGADA_MCP_SETTINGS` | The MCP servers the owner added in the console, as JSON in the file's shape; the console writes it, next to the file rather than in place of it |
| `PALUGADA_MODEL_PRICES` | Model prices for runtimes that report tokens but no price (see [`config/prices.example.json`](../config/prices.example.json)) |
| `PALUGADA_DRAFT_MODEL` | The tier or model used for drafting, memory distillation and skill screening (default `standard`) |
| `PALUGADA_AGENT_CLIS` | Agent CLIs this platform knows, by name, found on `PATH`: `claude-code`, `codex`, `gemini-cli`, `opencode`, `hermes`, `openclaw`. See **Agent CLIs** below |
| `PALUGADA_AGENT_SETTINGS` | Per agent CLI, where its binary is, its tiers, and its credential by reference, as JSON; written by the console. See **Agent CLIs** below |
| `PALUGADA_CLAUDE_CODE_COMMAND` | Where the Claude Code binary is, when it is not `claude` on `PATH` |
| `PALUGADA_CLAUDE_CODE_KEY_VAR` | The one variable of this process's environment Claude Code is given, such as `ANTHROPIC_API_KEY` |
| `PALUGADA_RUNTIME_SPECS` | Any other agent CLI, as JSON; or a correction to a known one, such as `[{"name":"codex","command":"/opt/codex/bin/codex"}]` |
| `PALUGADA_RUNTIME_HTTP_URL` | A runtime that answers over HTTP |
| `PALUGADA_RUNTIME_IMAGE` | The Docker runtime, with no network |
| `PALUGADA_SANDBOX_URL`, `_IMAGE` | A remote sandbox runtime |
| `PALUGADA_FILES_ROOT` | The company's files, for `files.list` and drafting |
| `PALUGADA_PUSH_URL` | Push notifications for incidents and tier 3 approvals. `PALUGADA_PUSH_FORMAT=ntfy` with `PALUGADA_PUSH_TOPIC` posts in ntfy's shape; `PALUGADA_PUSH_TOKEN` (or `_TOKEN_REF`) is its token |
| `PALUGADA_TELEGRAM_TOKEN`, `_CHAT`, `_WEBHOOK_SECRET` | Telegram with decision buttons. Point the bot's webhook at `<PALUGADA_APP_URL_PUBLIC>/api/channels/telegram`. The token and secret may be references instead, in `_TOKEN_REF` and `_WEBHOOK_SECRET_REF`; the console connects a bot for you. `PALUGADA_TELEGRAM_API` names a local Bot API server |
| `PALUGADA_SLACK_WEBHOOK`, `PALUGADA_DISCORD_WEBHOOK` | A Slack or Discord incoming webhook the owner is told things on, or a reference to one in `_WEBHOOK_REF` |
| `PALUGADA_APP_URL_PUBLIC` | Where the console is reached from the owner's phone. Notifications link there |
| `PALUGADA_ALLOWED_HOSTS` | The host names the console answers to, comma-separated. Defaults to the hosts of the public URL and origins. Loopback is always allowed |
| `PALUGADA_BEHIND_PROXY` | `1` when the console is reached through a reverse proxy: the caller's address, which the sign-in throttle counts by, is then the last one the proxy added to `X-Forwarded-For`. Leave it unset otherwise, since without a proxy that header is whatever the caller wrote |
| `PALUGADA_RP_ID`, `PALUGADA_ORIGIN` | Where passkeys are made and used: the relying party a device signs for, and the address the console is opened at. Each defaults to `PALUGADA_APP_URL_PUBLIC` (its host name, and its origin); set one only when it differs, such as `PALUGADA_RP_ID=example.com` for a passkey that works across a domain. Without either and without a public URL, passkeys cannot be made, and the owner signs in and approves with an authenticator code. A browser offers passkeys only over HTTPS, or on `localhost` |
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
`HERMES_INFERENCE_PROVIDER`). The console installs into `tools/<name>` in
`PALUGADA_STATE_DIR` with `npm install --prefix`, at the version in the
table below; that directory belongs to the machine it is on, so a
deployment with several replicas installs on each, or bakes the CLI into its
image.

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
`opencode-json`, `codex-jsonl` or `gemini-stream-json`), `env`, `files`,
`cwd`, `models`, `apiKeyEnvVar`, `maxTurns` (a whole number of at least 1:
Hermes reads 0 as no limit) and `hostSignInModels` (model name prefixes the
CLI would sign in to with the machine's own identity, which are refused;
OpenClaw's entry names `amazon-bedrock/` and `claude-cli/`), and `costArgs`
(a second call, same command, that reads what the run cost when the CLI's
stream does not say; `{sessionId}` is the id its result line gave -- Hermes's
entry reads its own ledger with `sessions export`). A spec that
never hands its CLI the bridge is refused at boot, because the CLI would run
with no tools and answer as though it had them.

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
`web.fetch`, `uptime.check`, `files.list`, `doc.draft`, `email.draft`,
`memory.search` and `skill.read`. `web.search` and `web.extract` go to the
provider the owner chooses in the console (**This deployment**, **Tools**),
or the one these name:

| Variable | What it is |
|---|---|
| `PALUGADA_SEARCH_PROVIDER` | Where `web.search` goes: `brave`, `tavily`, `exa`, `firecrawl`, `perplexity`, `parallel`, `keenable`, `jina`, `serpapi`, `serper`, or your own `searxng` or `firecrawl-self-hosted` |
| `PALUGADA_SEARCH_URL` | Your own server's address, for `searxng` and `firecrawl-self-hosted` |
| `PALUGADA_SEARCH_KEY_REF` | The provider's key, as a secret reference. `tavily`, `firecrawl` and `keenable` answer without one, at a rate-limited free tier |
| `PALUGADA_EXTRACT_PROVIDER` | Where `web.extract` goes: `jina`, `firecrawl`, `tavily`, `exa`, `parallel` or `keenable` |
| `PALUGADA_EXTRACT_KEY_REF` | Its key. `jina` (20 pages a minute), `firecrawl`, `tavily` and `keenable` answer without one |

`image.generate`, `speech.synthesize` and `speech.transcribe` are chosen the same way; the last two also let the owner speak to the assistant and hear it, which needs no files. What they
make is a file, written under the company's own directory in
`PALUGADA_FILES_ROOT`, in `generated/`, so both need that set:

| Variable | What it is |
|---|---|
| `PALUGADA_IMAGE_PROVIDER` | Where `image.generate` goes: `openai`, `fal`, `openrouter`, `deepinfra`, `xai` or `gemini` |
| `PALUGADA_IMAGE_KEY_REF` | Its key, as a secret reference; each of them needs one |
| `PALUGADA_IMAGE_MODEL` | A model other than the one each suggests, such as `fal-ai/flux-2/klein/9b` for `fal` |
| `PALUGADA_SPEECH_PROVIDER` | Where `speech.synthesize` goes: `openai`, `elevenlabs`, `xai`, `gemini`, `deepinfra`, or your own `piper` |
| `PALUGADA_SPEECH_URL` | Your Piper server's address (`python3 -m piper.http_server`) |
| `PALUGADA_SPEECH_KEY_REF` | Its key; `piper` takes none |
| `PALUGADA_SPEECH_MODEL` | A model other than the one each suggests |
| `PALUGADA_SPEECH_VOICE` | The voice a role gets when it names none, such as `marin` for `openai` or `Kore` for `gemini`; a role may ask for another |
| `PALUGADA_LISTEN_PROVIDER` | What writes down speech -- the owner's voice to the assistant, and `speech.transcribe` for roles: `openai`, `groq`, `deepgram`, `elevenlabs`, `gemini`, `deepinfra`, or your own `speaches` or `whisper-cpp` |
| `PALUGADA_LISTEN_URL` | Your own server's address, for `speaches` and `whisper-cpp` (start whisper.cpp's server with `--convert`, so it takes the browser's WebM) |
| `PALUGADA_LISTEN_KEY_REF` | Its key; `speaches` takes one only if yours asks, `whisper-cpp` none |
| `PALUGADA_LISTEN_MODEL` | A model other than the one each suggests |

Each call reserves the provider's price for one call before it runs.
DuckDuckGo is not offered: it has no web-results API, and what other agents
use for it scrapes several engines. Edge TTS is not offered either: it is a
browser's read-aloud endpoint, not an API anyone was given. Until a provider is chosen, both are
known by name and say where to choose one. Capabilities that need somebody's account,
such as `email.send`, `invoice.issue` or `dns.update`, are bound by a vendor
file. The file carries no code, and PALUGADA refuses one that writes without
verifying, has a side effect without an idempotency key, or tries to loosen
the catalogue's tier.
