# Working on PALUGADA

This file is for whoever changes this repository next: a person, a coding
agent (Claude Code reads it through `CLAUDE.md`; OpenCode, Codex, OpenClaw and
Hermes read `AGENTS.md` directly), or PALUGADA itself. The built-in bundle
`palugada-dev` gives a company a platform engineer and a reviewer whose skill
is the procedure below, so PALUGADA can take a task about its own code, do it
on a branch, and hand the owner a pull request.

`test/documents/self-knowledge.test.ts` checks that every command, path and
script named here exists. If you change one, change this file in the same
commit; the suite will not let the two disagree.

## What PALUGADA is

A control plane for companies run by AI agents with one human owner. Agents do
the work through capabilities the platform brokers; the owner decides what
cannot be undone, from one inbox. Money is reserved before work starts, every
step is journalled so a crash loses nothing, and tenants are isolated by row
level security in PostgreSQL rather than by application code. The
specification is `docs/PRD.md` (v2, in Indonesian); identifiers such as `F5.4`
in code and tests refer to it. `docs/STATUS.md` grades every requirement.

## The map

| Path | What is there |
|---|---|
| `src/engine/` | tasks and their state machine, the journal, checkout and leases, budgets, contracts, handoffs |
| `src/broker/` | the capability registry, the catalogue and its tiers, preflight, cost |
| `src/runtime/` | the runtime protocol and the runtimes (in-process, CLI agents, containers, HTTP) |
| `src/owner/` | the owner API (`api.ts`), its read models (`views.ts`), sign-in, second factor, push, Telegram, the owner's assistant (`assistant.ts`) |
| `src/settings/` | what the owner sets for the whole deployment in the console, the secrets it seals, and how both are laid over the environment |
| `src/context/builder.ts` | what every run is told, in order: charters, language, skills, memory, goals, working memory |
| `src/domain/` | goals, languages, the task state machine |
| `src/inbox/` | approvals, incidents, escalations |
| `src/chats/` | customers' conversations: the channels they write on, what arrives, and the Telegram, WhatsApp and mailbox transports |
| `src/memory/` | scoped memory and distillation |
| `src/knowledge/` | the company's documents, kept whole and searched by passage |
| `src/bundles/` | bundles, including the built-in ones in `builtin.ts` |
| `console/src/` | the owner's console: React and Mantine, built by Vite into `console/dist` |
| `console/src/locales/` | the console's translations, keyed by the English sentence |
| `console/public/` | the console's icons, manifest and pictures; `console/src/images.ts` picks a company's emblem and a role's picture |
| `brand/` | the logo in every shape, the banners, and how they were made (`brand/README.md`) |
| `db/migrations/` | the schema, numbered, append-only |
| `test/acceptance/` | behaviour, one file per area of the specification, against a real database |
| `test/documents/` | tests about the source and the documents: routes, translations, requirements, this file |
| `test/helpers/` | fixtures and the per-test reset |

## Setting up

Node 22.18 or later runs the TypeScript directly; there is no server build.
PostgreSQL 16 with pgvector. The four connection URLs are in `.env.example`
and in `.github/workflows/ci.yml`.

```sh
npm ci
npm run console:install
npm run db:setup
npm run db:migrate
```

`npm test` runs the suite alone and needs the console built first
(`npm run console:build`); it stops and says so when it is not. CI runs
`npm run test:coverage`, the same suite with coverage, whose report names the
functions no test calls.

`npm run setup` is for running PALUGADA, not for working on it. The suite
connects with the development URLs and reads nothing from `.env`, while
`db:setup` takes its passwords from `.env` when one exists: in a checkout
you test in, leave `.env` out, or point it at the development database.

## The loop for one change

1. **Find what it is for.** A requirement in `docs/PRD.md`, a gap in
   `docs/STATUS.md`, or the task you were given. Say which in the commit.
2. **Write the test first**, in `test/acceptance/`, and watch it fail. A test
   that passes before the change proves nothing about the change.
3. **Change the code.** Keep the change to what the test needs.
4. **Run `npm run check`.** It is the whole definition of done: the type
   check, the console's type check and build, and every test. Nothing is
   finished while it is red.
5. **Read the Postgres log** for errors your change caused. The suite passing
   is not the same as the database being quiet: a refused statement that a
   test tolerated still shows there.
6. **Commit** with a subject line that says what changed and a body that says
   why. English, like everything in the repository except the PRDs.

## Rules the suite enforces

Each of these is a test, and each exists because the mistake was made once.

- **Migrations are append-only.** Never edit one that has been pushed; add the
  next number. A deployed database has already run the old text, and
  `npm run db:migrate` refuses, by name, a migration whose file changed after
  it ran. `test/acceptance/process.test.ts`.
- **Every tenant table has row level security, forced, with a policy.**
  `test/acceptance/tenant-isolation.test.ts`.
- **References between tenant tables carry the company**: composite keys on
  `(company_id, id)`, so a row cannot point into another company.
- **The application role has only the grants it needs** (migration 0047).
  Owner actions run on the control plane through `withControlPlane`; agent
  work runs through `withTenant`.
- **Every API route is pressed from the console**, written as
  `api('METHOD', '/api/...')` with the path spelled out.
  `test/documents/console-routes.test.ts`.
- **Every sentence the console shows goes through `t()`** and has a
  translation in every dictionary in `console/src/locales/` (Indonesian in
  `console/src/locales/id.ts`, and one file for each other language). Write
  the English in the source; add each language's to its dictionary, with every
  plural form the language has. `test/documents/console-i18n.test.ts` names
  anything missing, left in English, or short of a form. What the server says
  to the owner (`src/owner/say.ts`) has one dictionary per language in
  `src/owner/sentences/`, held the same way.
- **Nothing is drawn from the letters of a name.** A company, a role and the
  owner are pictures (`console/src/images.ts`), and every image the console
  names ships in `console/public`. `test/documents/console-images.test.ts`.
- **The console stores nothing in the browser.** The session lives in memory;
  preferences live in the owner API.
- **The console fits a phone.** Drawn in Chromium at 390 pixels, the work,
  the money and the overview have nothing wider than the screen, nothing
  that scrolls sideways, no badge cut and no figure broken.
  `test/acceptance/console-phone.test.ts`, which skips where no Chromium is
  installed; `PALUGADA_CHROMIUM` names one.
- **Every column of an exported table is exported**, or listed with a reason
  in `test/acceptance/audit-export.test.ts`.
- **Every requirement in the PRD appears in `docs/STATUS.md`.**
- **A version is one number everywhere**: `package.json`, its lockfile and
  the newest section of `CHANGELOG.md`. A change an owner or an operator
  would notice adds its line to that section; releasing it is
  `node scripts/release.ts`, as `docs/RELEASING.md` says.
  `test/documents/release.test.ts`.
- **Nothing in `src/` is exported and reachable only from tests.**
  `test/documents/reachability.test.ts` keeps an inventory.
- **Tests run one file at a time** (`--test-concurrency=1`): they share one
  database and each file resets it.
- **A test that changes deployment-wide state** (`platform_control`) resets it
  in `test/helpers/setup.ts`, or every later file inherits it.
- **A transaction runs its queries one at a time.** No `Promise.all` over one
  `tx`: `pg` queues the second query and warns, and its next major version
  refuses. `test/helpers/setup.ts` turns the warning into a failure.

## Style

- Comments say why, in full sentences. The code says what.
- An error names what was wrong and what is accepted; the owner reads them.
- No dependency without a reason written next to it.
- Anything an agent writes for people -- prompts that produce owner-facing or
  customer-facing text -- names its language from `src/domain/language.ts`
  rather than assuming English.

## Developing PALUGADA with PALUGADA

1. Install the `palugada-dev` bundle into a company (Settings, Bundles).
2. Bind `repo.read` and `repo.branch` to this repository with a token that can
   push branches and open pull requests, and nothing more.
3. Give the platform engineer a task: a requirement, a defect, a gap from
   `docs/STATUS.md`.
4. It works on a branch, runs `npm run check`, and opens a pull request. The
   platform reviewer reads it against the criteria in its skill before the
   branch is pushed. Nothing reaches the main branch without you merging it.
