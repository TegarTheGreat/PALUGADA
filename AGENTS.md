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
| `src/runtime/` | the runtime protocol and the runtimes (in-process, CLI agents, containers, HTTP, and a person: `person.ts`) |
| `src/owner/` | the owner API (`api.ts`), its read models (`views.ts`), sign-in, second factor, push, Telegram, the owner's assistant (`assistant.ts`) |
| `src/settings/` | what the owner sets for the whole deployment in the console, the secrets it seals, and how both are laid over the environment |
| `src/context/builder.ts` | what every run is told, in order: charters, language, skills, memory, goals, where the task stands, working memory |
| `src/domain/` | goals, languages, the task state machine |
| `src/inbox/` | approvals, incidents, escalations |
| `src/chats/` | customers' conversations: the channels they write on, what arrives, and the Telegram, WhatsApp and mailbox transports |
| `src/browser/` | each company's browser: Chromium on a pipe, the proxy every request goes through, its sealed cookies, the owner's hold on it, and what runs in a page |
| `src/memory/` | scoped memory and distillation |
| `src/knowledge/` | the company's documents, kept whole and searched by passage |
| `src/workspace/` | the people's workspace: rooms, messages, people, cards, doors, the live hub, search, files; `principal.ts` is who a person is |
| `src/workspace/contract.ts` | the shapes the workspace's routes answer with, written again for the console in `console/src/workspace/types.ts` |
| `src/owner/route.ts` | the route types and `RouteKit`, what a route module may reach of the owner API |
| `src/owner/routes/` | the people's workspace's routes, one module per area, served beside `api.ts`'s own |
| `src/owner/conversation-money.ts` | what the owner's conversations may spend: each CEO turn reserved and held in a row before the call, the sweep of holds a crash left, PALUGADA's own monthly allowance |
| `src/owner/confusables.ts` | the look-alike letters people's names and handles are compared on, generated from Unicode's data by `scripts/confusables.ts` |
| `src/owner/sentences/areas/` | one feature's server sentences in every language, spread into each file of `src/owner/sentences/` |
| `src/relay/` | relay protocol v1: the deployment's identity, canonical JSON and signatures, pairing, links, offers, the outbox and its loop, what a relay sends back, and a person's own notices as envelopes (`people.ts`) |
| `docs/relay-protocol.md` | the relay protocol, for whoever builds a relay, with its test vectors; `scripts/relay-reference.ts` is the reference relay (`npm run relay:reference`) |
| `src/owner/member-notify.ts` | people's notices: who is told of what and when, planned under the delivery reader and read again as the person before it is sent; the sentences are `src/owner/people-said.ts` |
| `docs/phones.md` | how the owner puts people's notices on their staff's phones: the reference relay, a private ntfy, one topic a person, Link a phone |
| `src/records/` | the company's own records: the people it deals with (contacts, notes, deals), its books and the invoices kept in them |
| `src/duties/` | office work the platform does itself, with no model, from what the company's records say: a task whose key starts `duty:` runs a procedure here under a role's grants (collections: overdue invoices are reminded) |
| `src/bundles/` | bundles, including the built-in ones in `builtin.ts` |
| `src/templates/` | what a company starts from: `founding.ts`, the CEO and nothing else; `work.ts`, what every role is built from. A team is the CEO's to build, and `test/helpers/standard-team.ts` is the full company the tests that need one use |
| `console/src/` | the owner's console: React and Mantine, built by Vite into `console/dist` |
| `console/src/locales/` | the console's translations, keyed by the English sentence |
| `console/src/locales/areas/` | one feature's sentences in every language, spread into each dictionary |
| `console/src/workspace/` | the people's workspace in the console: the Rooms page's rail, timeline, threads, composer, mention picker and cards (drawn by `console/src/pages/Rooms.tsx`), the shapes the server answers with (`types.ts`) and a person's profile (`Profile.tsx`) |
| `console/public/` | the console's icons, manifest and pictures; `console/src/images.ts` picks a company's emblem, a role's picture and a person's |
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
- **Room tables are opened only to a transaction that names its reader**,
  as `withPeople`, `withDelivery` and `withRoomPlatform` do; no code on an
  agent's path names a room table, and only `src/db/tenant.ts` sets
  `app.reader` or `app.principal`. An agent's transaction (`withTenant`)
  names no reader, so it sees and writes nothing in a room table, even in
  its own company; a person sees only the rooms they may see, whatever the
  query, and is told nothing about anyone else's.
  `test/acceptance/people-rls.test.ts`,
  `test/documents/people-boundary.test.ts`.
- **Room activity writes no `events` row.** People's words, even a private
  room's name or that it exists, stay out of the work's journal, which every
  seat and the context builder read: only a door that turns a message into
  work writes an event, and it names a private or direct room only as
  `room: 'private'`. `test/acceptance/rooms-write-no-events.test.ts`,
  `test/acceptance/room-doors.test.ts`.
- **No route that reads people's words is readable by the assistant.** Every
  GET of a people's route module is under `UNREADABLE_UNDER`, both of the
  assistant's gates ask `unreadable()`, and the people's helpers throw inside
  the assistant's dispatch. `test/documents/people-boundary.test.ts`.
- **References between tenant tables carry the company**: composite keys on
  `(company_id, id)`, so a row cannot point into another company.
- **The application role has only the grants it needs** (migration 0047).
  Owner actions run on the control plane through `withControlPlane`; agent
  work runs through `withTenant`.
- **Every API route is pressed from the console**, written as
  `api('METHOD', '/api/...')` with the path spelled out.
  `test/documents/console-routes.test.ts`.
- **Routes live in `src/owner/api.ts` and the modules of `src/owner/routes/`**,
  the route tests read both through `test/helpers/route-sources.ts`, and no
  two routes of one method match the same path.
  `test/documents/console-routes.test.ts`.
- **Every POST a seat may make is on one list: talk, ask or decide**, in
  its area's block of `src/owner/staff-policy.ts`.
  `test/documents/staff-routes.test.ts`.
- **Every place that carries outside words into derived work carries staff
  words too**: a call that passes `carriesOutside`, or reads
  `carriesOutsideFrom`, passes `carriesStaff` or `carriesStaffFrom`, so a
  member of staff's words held at tier 2 in one task are held in the work
  made from it. `test/documents/provenance-sites.test.ts`.
- **The relay protocol is one document and the code that speaks it.** Every
  envelope type in `src/relay/` is described in `docs/relay-protocol.md`, the
  document describes none the code does not know, and its test vectors
  verify. A type is only ever added within v1.
  `test/documents/relay-protocol.test.ts`.
- **A person's notice is never an inbox item, and never words a link's share
  does not allow.** People's notices are planned only under the delivery
  reader, which sees no words, and read again as the person told before they
  are sent; the owner hears people only when they turned it on.
  `test/acceptance/people-notify.test.ts`.
- **The workspace's shapes are written twice and held together**:
  `src/workspace/contract.ts` and `console/src/workspace/types.ts`, type by
  type and field by field. `test/documents/workspace-contract.test.ts`.
- **Every sentence the console shows goes through `t()`** and has a
  translation in every dictionary in `console/src/locales/` (Indonesian in
  `console/src/locales/id.ts`, and one file for each other language). Write
  the English in the source; add each language's to its dictionary, with every
  plural form the language has. `test/documents/console-i18n.test.ts` names
  anything missing, left in English, or short of a form. What the server says
  to the owner (`src/owner/say.ts`) has one dictionary per language in
  `src/owner/sentences/`, held the same way, and is said from a file directly
  in `src/owner/`, the only level `test/acceptance/owner-channels.test.ts`
  reads. The people's workspace keeps its sentences by feature, in
  `console/src/locales/areas/` and `src/owner/sentences/areas/`.
- **Nothing is drawn from the letters of a name.** A company, a role and the
  owner are pictures (`console/src/images.ts`), and every image the console
  names ships in `console/public`. `test/documents/console-images.test.ts`.
- **The console stores nothing in the browser.** The session lives in memory;
  preferences live in the owner API.
- **The console fits a phone.** Drawn in Chromium at 390 pixels, the work,
  the money, the overview, the rooms' rail and an open room have nothing
  wider than the screen, nothing that scrolls sideways, no badge cut and no
  figure broken; an open room is the whole screen, its composer above the
  keyboard. `test/acceptance/console-phone.test.ts` and
  `test/acceptance/console-rooms.test.ts`, which skip where no Chromium is
  installed; `PALUGADA_CHROMIUM` names one.
- **A decision is pressed, and pressed the same way everywhere.** The inbox
  and a room's approval card draw `console/src/components/DecisionButtons.tsx`:
  Approve is an outline after a plain Deny, and nothing approves, decides,
  asks for work or sends it from the keyboard. What an agent wrote is drawn
  in a room with `Prose`, never as raw text.
  `test/documents/console-page.test.ts`,
  `test/documents/console-workspace.test.ts`.
- **Every column of an exported table is exported**, or listed with a reason
  in `test/acceptance/audit-export.test.ts`. A change that adds a column to
  an exported table exports it, or lists it there, in the same commit.
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
4. It works on a branch and opens a pull request. It cannot run `npm run check`
   itself -- its runtime has no shell, only the platform's tools -- so CI does,
   and the pull request is held to it. The platform reviewer reads it against
   the criteria in its skill before the branch is pushed. Nothing reaches the
   main branch without you merging it.
