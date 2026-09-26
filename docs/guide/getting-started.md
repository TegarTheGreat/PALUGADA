# Getting started

This page takes you from nothing to a company doing its first piece of work.
It follows the [README quickstart](../../README.md#quickstart) and explains
each step. The settings it mentions are listed in full in
[docs/configuration.md](../configuration.md).

## What you need

PALUGADA runs on Linux: its process handling reads `/proc`. Either way you
install it, you need Node 22.18 or later on the machine where you run the
setup, because `npm run setup` is a Node script. Node 22.18 runs the
server's TypeScript directly, so there is no build step for the server.

| | With Docker Compose | On this machine |
|---|---|---|
| Also needs | Docker with Compose | PostgreSQL 16 with [pgvector](https://github.com/pgvector/pgvector), and a superuser to install pgvector once |
| The database | Comes with it, in a volume | Yours |
| Good for | Trying it, a small always-on server | A server you already run PostgreSQL on, or one managed by systemd |

You also need a model that can call tools (function calling), or a plan to
use an agent CLI instead. The platform's own loop offers each role its
capabilities as tools; a model that cannot call them can only answer in
words. See [Choose or change the model](how-to.md#choose-or-change-the-model).

## Install with Docker Compose

```sh
git clone https://github.com/TegarTheGreat/PALUGADA.git && cd PALUGADA
npm install
npm run setup                  # choose "With Docker Compose"
docker compose up -d --build
```

`npm install` is only there so that `npm run setup` can run. The setup writes
`.env`, and both Compose and the platform read it. `docker compose up` then
starts two services from `docker-compose.yml`:

- `db`, PostgreSQL 16 with pgvector. The first time it starts on an empty
  volume it runs `scripts/setup-database.sh` (through
  `deploy/docker/initdb.sh`), which creates the `palugada` database and its
  three roles with the passwords the setup wrote.
- `app`, built from the `Dockerfile`. It applies any pending migrations under
  a lock, so replicas starting together apply each one once, and then starts
  the worker and the console as an unprivileged user.

The console is published on this machine's loopback address only, at
`http://127.0.0.1:8787`. To reach it from anywhere else, put it behind HTTPS
first: [operations](operations.md#https-in-front-of-it) explains
`PALUGADA_PUBLISH`, `PALUGADA_ALLOWED_HOSTS` and `PALUGADA_APP_URL_PUBLIC`.

A model served on this machine, such as Ollama, is reached from inside the
container at `host.docker.internal`; the setup writes that address for you
when you choose Docker Compose and a local model. The container image runs no
agent CLI of its own. To put roles on Claude Code or another CLI under Docker,
the CLI has to be added to an image built from this one.

## Install on this machine

```sh
git clone https://github.com/TegarTheGreat/PALUGADA.git && cd PALUGADA
npm install && npm run console:install
npm run setup                  # choose "On this machine"
npm run db:setup && npm run db:migrate   # once; pgvector needs a Postgres superuser
npm run console:build
npm start
```

What each step does:

- `npm run console:install` installs the owner console's own dependencies
  (React, Mantine, Vite) under `console/`.
- `npm run setup` writes `.env`; see the next section.
- `npm run db:setup` runs `scripts/setup-database.sh`. It creates the
  `palugada` database, the three roles the platform connects as, and the
  `pgcrypto` and `vector` extensions. Installing `vector` needs a superuser,
  so the script connects as one: set `PALUGADA_SUPERUSER_URL` to a superuser
  connection URL, or run it as a user that can become the local `postgres`
  account. It reads each role's password from the connection URLs in `.env`,
  so the database and the platform cannot disagree. It refuses to run when
  the database already exists, because it would drop it.
- `npm run db:migrate` applies the schema in `db/migrations/`, one numbered
  file at a time, each in its own transaction.
- `npm run console:build` builds the console into `console/dist`, which the
  server serves. Without it the server answers the API and nothing else, and
  says so when it starts.
- `npm start` reads `.env` and starts the worker and the console together on
  `http://127.0.0.1:8787`. It prints what it configured and what it did not,
  one line each starting with `palugada:`, and ends with
  `palugada: console at http://127.0.0.1:8787`.

For a server that should keep running, use the systemd unit in
`deploy/palugada.service` instead of a terminal; see
[operations](operations.md#running-it-under-systemd).

## What `npm run setup` asks

The setup asks three things, checks each while you are still at the keyboard,
and writes the answers to `.env`, readable by your user alone. Press Enter to
take the answer in brackets.

1. **Where will PALUGADA run?** Asked only when `.env` does not already say.
   - *On this machine, with PostgreSQL installed here.* If a PALUGADA database
     already answers with the settings it would use, those are kept.
     Otherwise it writes `PALUGADA_APP_URL`, `PALUGADA_ADMIN_URL` and
     `PALUGADA_OWNER_URL` with a new random password for each role, which
     `npm run db:setup` then uses.
   - *With Docker Compose: PostgreSQL comes with it.* It writes four random
     database passwords (`PALUGADA_DB_SUPERUSER_PASSWORD` and one for each
     role), which Compose reads.

2. **Your authenticator.** You sign in, and approve what cannot be undone,
   with a six-digit code from an authenticator app such as Google
   Authenticator, Microsoft Authenticator, 1Password, Authy or Bitwarden. The
   setup makes a new secret, shows it as a QR code in the terminal and as a
   key in groups of four letters, and asks for the code your app now shows.
   A wrong code means the app does not hold this key; try the next code, or
   press Enter to skip the check. It writes the secret as
   `PALUGADA_SECRET_OWNER_TOTP` and points `PALUGADA_OWNER_TOTP_REF` at it.
   Keep the key somewhere safe, or add it to a second app now: it is how you
   get back in if you lose your phone
   ([troubleshooting](troubleshooting.md#a-lost-phone)).

3. **Which model does the work?** The choices are Anthropic (Claude), OpenAI,
   OpenRouter, Google Gemini, a model on this machine (Ollama, vLLM, LM Studio
   or llama.cpp), another OpenAI-compatible API, or deciding later. Depending
   on the choice it asks for the address, the API key (not shown as you
   type), and the model. For Anthropic you may press Enter to use Claude's
   own models by tier; for anything else you name the model every role runs
   on. It then sends that model one request offering one tool:
   - *It answered, and called the tool it was offered* means you are ready.
   - *It answered, but did not call the tool* means a role on it can only
     answer in words. Choose a model that supports tool calling.
   - *It did not answer* is followed by the reason: a refused key, a wrong
     address, or a model name the API does not know.

   If you choose to decide later, the console still starts, and no role can
   work until a model is set.

Run `npm run setup` again at any time. It keeps what `.env` holds, asks only
what is missing, and offers to change the model. The only request it sends
anywhere is the one to the model you named.

If you would rather write `.env` by hand, [docs/configuration.md](../configuration.md)
lists every variable, and `npm run totp:new` prints a new authenticator
secret and the `otpauth://` link to add to your app.

## Sign in for the first time

Open `http://127.0.0.1:8787`. On its first start the platform enrols the
authenticator `PALUGADA_OWNER_TOTP_REF` points at, and says
`enrolled the owner's authenticator from env://PALUGADA_SECRET_OWNER_TOTP`
among its boot lines.

The page says **Welcome back** and asks for the six-digit code from your
authenticator app. Type it and press **Sign in**. A few things to know:

- There is no user name. PALUGADA has one human, and holding the enrolled
  authenticator is what makes you the owner.
- The session lives in this browser tab only and lasts up to eight hours.
  Closing the tab signs you out. Nothing is stored in the browser.
- Ten wrong codes in a row lock the second factor for fifteen minutes, and
  five from one address hold that address back for fifteen minutes.
- A tier 3 approval, and anything that loosens a control, asks for a fresh
  code every time, however recently you signed in.
- The first time you sign in, the console offers a tour of itself. You can
  skip it and take it later from the menu under **Owner**.
- The language switch on the sign-in page (EN or ID) applies to this visit.
  Once you are in, choose the panel language from the menu under **Owner**
  at the foot of the sidebar; it is kept by the deployment and follows you
  to every device.

## Start a company

A fresh deployment has no companies, so **Home** offers
**Start your first company**. Press **Start a company**, or
**Restore from an export** if you have a company file from another
deployment ([how-to](how-to.md#export-and-import-a-company)).

1. Type a **Name**. The **Short name** fills itself in from it; it is used in
   links and exports, and is lower-case letters, digits and hyphens.
2. Decide on **Let it run itself** (on by default). It installs the
   `company-os` bundle: a Strategy division with a strategist who reviews the
   week every Monday morning in the company's time zone, proposes at most
   three bets, and never applies them; the operating skills (validating an
   idea, premortems, pricing, unit economics, customer discovery, launch
   readiness, outbound rules, stage gates, the weekly review); and two
   company policies: no paid advertising before the launch stage, and nothing
   new started while winding down.
3. Press **Start it**, then type a code in
   **Confirm with your authenticator** and press **Confirm**.

The company is built from the standard template in one transaction:

| Division | Role | What the role does |
|---|---|---|
| Operations | `coordinator` | Where work arrives when you name no role; routes it to the right role, and does operations work itself |
| Delivery | `planner` | Turns a goal into a plan and tickets, then hands the build to the builder |
| Build (inside Delivery) | `builder` | Builds, deploys to staging, and deploys to production at a limited rate |
| Growth | `marketer` | Drafts and sends outreach and posts |
| Finance | `bookkeeper` | Reads the ledger, issues and pays invoices |
| Support | `responder` | Reads the mailbox and answers customers |
| Assurance | `reviewer` | Reviews other roles' work; holds no capability at all |
| Lab | `analyst` | Runs code in the sandbox; holds nothing else |

It also has one project (Main), a goal ladder with a mission and two
objectives for you to replace with your own, a budget account for every
division under the company's, and a monthly ceiling of USD 200. You land on
the company's **Overview**.

Many of the capabilities the template grants, such as sending email, paying
an invoice or changing DNS, need an account with a vendor. Until you bind
one, a role that tries is told `<capability> needs a vendor: bind it in the
file PALUGADA_VENDORS names`, and works around it or asks you. See
[Connect a vendor](how-to.md#connect-a-vendor).

## Give it its first piece of work

1. On the **Work** page press **Give work**, or in the sidebar press **New**
   and choose **Give a role work**.
2. Leave **Role** on the coordinator. Its description says it hands the work
   to whoever should do it.
3. Choose the **Project** (Main) and the goal the work **Serves**. Every task
   hangs from a goal, and the goal travels with every approval it causes.
4. Write **What to do** in plain words. For a first task, choose something
   whose result is text and needs no vendor account, for example "List the
   ten questions we should ask our first customers, and why each matters".
5. Leave **Tokens to reserve** blank to use the role's default, and press
   **Assign it**.

The role is woken now rather than at its next heartbeat.

## What happens next

- **The coordinator routes it.** Its run reads the platform's charter, the
  company's, and its own, and decides whose job the work is. It hands the
  work over as a sub-task with a brief, waits for the result, and reports
  what came back. The sub-task shares the parent's budget, so delegation
  cannot mint money, and hop limits and cycle detection stop work that
  bounces between roles.
- **The role does the work.** It runs on the runtime it names: with a model
  configured, the platform's own loop. Each turn is a journalled step, so a
  restart resumes at the turn it reached. Every tool call goes through the
  broker, which checks the grant, the tier, the policies and the budget.
- **What is cheap happens; what is not waits.** Reads run. Undoable writes
  run and are read back to verify them. Anything that costs money or reaches
  people needs a recorded plan and a budget check first. Anything
  irreversible stops and waits for you in the **Inbox**.
- **The inbox asks you when something needs you.** An approval, a question
  an agent asked with `owner.ask` (its task waits for your answer), an
  incident, or a budget alert. A division that is stuck asks the coordinator
  first and reaches you after an hour if the coordinator could not fix it.
- **You hear that it finished.** The task moves to **Done**, and when
  Telegram is set up, a message tells you that work you gave has finished.

Next: [the concepts](concepts.md) behind what you just saw, or
[the how-to recipes](how-to.md) for the next things to set up.
