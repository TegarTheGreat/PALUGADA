# Running PALUGADA

The [README](../README.md#quickstart) has the quickstart. This page is the
rest: checking an installation, running it in production, and every setting.

## Installing

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
enrols it. Connection settings are in [`.env.example`](../.env.example).

Check an installation end to end:

```sh
npm run smoke
```

The smoke check builds a company and runs a task through the whole pipeline.
It fails if the tier 3 gate does not refuse without a second factor, if no
owner channel is reached, or if a built-in capability is missing.

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
| `PALUGADA_MODEL_KEY_REF` | The model the platform runs on, as a secret reference (`env://PALUGADA_SECRET_MODEL_KEY`). Without it, no role on the in-process runtime can work, and every role a template creates is on it |
| `PALUGADA_MODEL_URL` | Where the model API is (default `https://api.anthropic.com`), for a gateway that speaks the same API |
| `PALUGADA_MODEL_ALIASES` | Which model each tier a role names stands for, as JSON. Defaults: `fast` = `claude-haiku-4-5-20251001`, `standard` = `claude-sonnet-5`, `deep` = `claude-opus-5-5` |
| `PALUGADA_SECRET_DIRS` | Where `file://` secrets may be read from (default `/run/secrets`) |
| `PALUGADA_VENDORS` | Vendor capabilities from a JSON spec file (see [`config/vendors.example.json`](../config/vendors.example.json)) |
| `PALUGADA_MODEL_PRICES` | Model prices for runtimes that report tokens but no price (see [`config/prices.example.json`](../config/prices.example.json)) |
| `PALUGADA_DRAFT_MODEL` | The tier or model used for drafting, memory distillation and skill screening (default `standard`) |
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

**Runtimes.** A role's work is done by the runtime it names. With a model
key, the in-process runtime runs every role that has no handler of its own:
the model reads the role's charter and the owner's notes, calls the role's
tools through the broker, and finishes with the task's output. Each turn is
a journalled step, so a restart resumes at the turn it reached. Any other
runtime configured below can be chosen per role in the console (the role's
*Who does its work*), and only one this deployment runs is accepted.

**Capabilities.** PALUGADA implements the ones that need no vendor account:
`web.fetch`, `uptime.check`, `files.list`, `doc.draft`, `email.draft`,
`memory.search` and `skill.read`. Capabilities that need somebody's account,
such as `email.send`, `invoice.issue` or `dns.update`, are bound by a vendor
file. The file carries no code, and PALUGADA refuses one that writes without
verifying, has a side effect without an idempotency key, or tries to loosen
the catalogue's tier.
