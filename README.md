# PALUGADA

Orchestration platform for running one or more companies whose work is carried
out entirely by AI agents, with exactly one human as owner. The owner is not a
daily operator: they are the legal entity, the approver for irreversible
actions, and the recipient of escalations.

This is not a collaboration workspace and not a multi-agent chat. It is a
**durable workflow engine + state store + policy engine + capability broker**,
with a single human interface: a decision inbox.

The product specification is [`docs/PRD.md`](docs/PRD.md) (Indonesian). Code and
comments are English; requirement identifiers such as `F5.4` refer to sections
of that document.

## Status

Phase 0 of the roadmap (PRD section 13) is implemented and tested: tenant
isolation, the durable execution engine, the capability broker, the event log
and the owner's emergency controls. There is no agent runtime, no scheduler and
no owner UI yet — see [Not built yet](#not-built-yet).

Seven questions in [PRD section 14](docs/PRD.md#14-pertanyaan-terbuka) are still
open. Two of them (the monthly cost ceiling, and which durable engine to adopt)
set defaults across the whole system.

## Quick start

Requires Node 22.18+ (for native TypeScript execution) and PostgreSQL 16.

```bash
npm install
npm run db:setup      # creates the database and its three roles
npm run db:migrate
npm test
```

`db:setup` connects as a superuser. Set `PALUGADA_SUPERUSER_URL` to point at
one, or leave it unset to use a local peer-authenticated `postgres` account.
Connection settings are listed in [`.env.example`](.env.example).

## Layout

```
db/migrations/     schema and row-level security policies
scripts/           database provisioning and the migration runner
src/
  config.ts        connection strings, one per role
  db/              connection pools and tenant-scoped access
  domain/          task state machine, reversibility tiers
  engine/          step journal, budgets, task admission, the runner
  broker/          capability registry and the broker
  inbox/           owner inbox: approvals, incidents, emergency controls
  audit/           append-only event log, security events
  llm/             model interface and a recording test double
test/acceptance/   one file per PRD acceptance criterion
```

## What Phase 0 covers

| Requirement | Where | Verified by |
|---|---|---|
| F1.2, F1.3 tenant isolation via RLS | `db/migrations/0001_tenancy.sql`, `src/db/tenant.ts` | `tenant-isolation.test.ts` |
| F1.4 company freeze | `src/engine/control.ts` | `owner-inbox.test.ts` |
| F1.6, F5.4 inherited budget, one shared counter | `db/migrations/0003_execution.sql`, `src/engine/budget.ts` | `budget-inheritance.test.ts` |
| F2.2 division depth, F2.6 tool ceiling | `db/migrations/0002_organization.sql` | `task-guards.test.ts` |
| F2.4 capability grants enforced in the broker | `src/broker/broker.ts` | `capability-broker.test.ts` |
| F5.1 durable resume after a crash | `src/engine/journal.ts` | `durable-resume.test.ts` |
| F5.2 deterministic idempotency keys | `src/engine/hash.ts` | `durable-resume.test.ts` |
| F5.5 hop limit, F5.6 deadline | `src/engine/tasks.ts`, `src/engine/engine.ts` | `task-guards.test.ts` |
| F5.8, F10.7 stop everything | `src/inbox/inbox.ts` | `owner-inbox.test.ts` |
| F6.5 fan-out cap, F6.6 cycle detection | `src/engine/tasks.ts` | `task-guards.test.ts` |
| F8.1–F8.4 broker, registry, tiers, mandatory read-back | `src/broker/` | `capability-broker.test.ts` |
| F8.6 rate limits, F8.8 kill switch | `src/broker/broker.ts`, `src/engine/control.ts` | `capability-broker.test.ts` |
| F10.1–F10.4, F10.8 owner inbox | `src/inbox/inbox.ts` | `owner-inbox.test.ts` |
| Section 7.4 append-only event log | `db/migrations/0004_audit_and_governance.sql` | `tenant-isolation.test.ts` |

## Decisions worth knowing

**Isolation is a database boundary, not an application one.** Three roles
exist. `palugada_app` is used by every agent run and holds `NOBYPASSRLS`;
`palugada_admin` holds `BYPASSRLS` and is reachable only from the control
plane; `palugada_owner` owns the schema and runs migrations. Every tenant table
is `FORCE ROW LEVEL SECURITY`, so even the table owner is subject to the policy.

**A query with no tenant context fails loudly.** `app.current_company_id()`
raises rather than returning NULL. A NULL would make `company_id = NULL` filter
every row away, which looks like an empty company instead of a bug.

**Tenant scope is transaction-local.** It is set with
`set_config(..., is_local => true)` inside an explicit transaction, so a pooled
connection cannot carry one tenant's scope into the next borrower's request.

**Step indices restart at zero on every run.** A step's identity is its
position in the handler's call sequence. Handlers must therefore issue the same
steps in the same order for the same input; branching on wall-clock time or
randomness inside a handler is a defect.

**`halted` is terminal, `cancelled` is the owner's.** A task stopped by budget,
hop, deadline or a failed read-back never resumes automatically (PRD section
6.3) and becomes an inbox item. Cancellation means a human stopped it.

**Silence is safe.** An unanswered approval expires into a cancellation, never
into an execution.

## Deviations from the PRD found while building

Both are marked in the code and are worth reconciling in the document.

1. **`pending -> halted` is missing from the section 8.5 diagram.** A task can
   be admitted and then miss its deadline before a worker picks it up. F5.6
   requires that to halt, but the diagram offers a pending task only `running`
   and `cancelled`. The transition was added; see `src/domain/task.ts`.

2. **The append-only log makes company deletion impossible.** The trigger on
   `events` rejects `DELETE`, including through a cascade, so a company row
   cannot be removed once it has any event. This is consistent with section 7.4
   and with F1.4/F1.5 offering freeze and export rather than deletion, but it
   means retention (F11.5) will need an explicit archival path rather than a
   delete.

## Not built yet

Phase 1 and beyond, in PRD order: the charter and policy engine (F3), the four
memory types and semantic retrieval (F4, which needs pgvector), the scheduler
and external/owner windows (F9), adversarial review and decision records (F7),
LLM tracing to a collector (F11.1 stores traces but nothing reads them yet),
secret manager integration (F12), and the owner UI.

`src/llm/client.ts` deliberately ships only an interface and a test double. The
PRD leaves model-per-tier calibration open (section 14.4) and asks for
per-role model abstraction so one provider outage cannot stop the platform, so
binding to a vendor now would pre-empt a decision the owner has not made.
