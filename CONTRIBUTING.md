# Contributing to PALUGADA

Thank you for improving PALUGADA. This page is the short version for people;
the whole procedure, with the rules the test suite enforces and why, is
[`AGENTS.md`](AGENTS.md). It is written for coding agents as much as for
people, and it is the same document either way.

## Before you start

- **Node 22.18 or later** and **PostgreSQL 16 with pgvector**.
- Install and prepare the database:

  ```sh
  npm ci
  npm run console:install
  npm run db:setup
  npm run db:migrate
  ```

  The connection settings are in [`.env.example`](.env.example).

## Finding something to do

- [`docs/STATUS.md`](docs/STATUS.md) grades every requirement of the
  specification as built, partial or not built. Anything not built is open.
- [`docs/PRD.md`](docs/PRD.md) is the specification (in Indonesian). Code and
  tests cite it as `F5.4` and so on; cite it the same way in your pull request.
- A defect is a good contribution on its own. Say how to see it.

## Making the change

1. Write the test first, in `test/acceptance/`, and watch it fail.
2. Make the change.
3. Run everything:

   ```sh
   npm run check
   ```

   That is the type check, the console's build and every test. It is what CI
   runs, so a green `check` is a green pull request -- except that CI also
   audits the production dependencies, here and in `console`, with
   `npm audit --omit=dev --audit-level=high`, and an advisory published
   since your last run can turn it red with nothing of yours at fault.
4. Open a pull request. The template asks five questions; answer them.

## Things that surprise people

- **Migrations never change once pushed.** Add the next number instead.
- **The console speaks 21 languages.** Every sentence goes through `t()`
  and needs a translation in every dictionary in `console/src/locales/`
  (twenty of them besides the English in the source), with each plural form
  its language has; Arabic has six. What the platform sends the owner's
  phone has one dictionary per language in `src/owner/sentences/`. The suite
  names any you missed, and any left in English. Arabic is drawn right to
  left, so use logical CSS (`margin-inline-start`, `ms`) rather than left and
  right.
- **Every API route must be usable from the console.** A route nobody can
  press is refused by the suite.
- **Tests share one database** and run one file at a time. Do not start two
  test runs at once.

## Letting PALUGADA do it

PALUGADA can work on PALUGADA. Install the `palugada-dev` bundle into a
company, bind `repo.read` and `repo.branch` to this repository, and give its
platform engineer the task. It follows `AGENTS.md`, a reviewer checks the
change before the branch is pushed, and the pull request waits for you.
