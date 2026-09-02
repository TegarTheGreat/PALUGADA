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

Phases 0 and 1 of the roadmap (PRD section 13) are implemented and tested.
Phase 0 covers tenant isolation, the durable execution engine, the capability
broker, the event log and the owner's emergency controls. Phase 1 adds the
charter and policy engine, scoped memory, typed contracts and handoff, durable
scheduling with external and owner windows, and credentials. There is no agent
runtime and no owner UI yet — see [Not built yet](#not-built-yet).

Seven questions in [PRD section 14](docs/PRD.md#14-pertanyaan-terbuka) are still
open. Two of them (the monthly cost ceiling, and which durable engine to adopt)
set defaults across the whole system.

## Quick start

Requires Node 22.18+ (for native TypeScript execution) and PostgreSQL 16 with
[pgvector](https://github.com/pgvector/pgvector).

```bash
npm install
npm run db:setup      # creates the database and its three roles
npm run db:migrate
npm test
```

`db:setup` connects as a superuser, because it installs pgvector — which is not
a trusted extension — alongside the roles and the database. Set
`PALUGADA_SUPERUSER_URL` to point at a superuser, or leave it unset to use a
local peer-authenticated `postgres` account. Connection settings are listed in
[`.env.example`](.env.example).

## Layout

```
db/migrations/     schema and row-level security policies
scripts/           database provisioning and the migration runner
src/
  config.ts        connection strings, one per role
  db/              connection pools and tenant-scoped access
  domain/          task state machine, reversibility tiers
  engine/          step journal, budgets, task admission, contracts, handoff
  broker/          capability registry and the broker
  policy/          declarative conditions and the policy engine
  governance/      charter and policy administration, audited
  memory/          the four memory kinds and scoped retrieval
  context/         prompt assembly, charter first
  scheduler/       durable cron, capability windows, the owner window
  secrets/         secret references and redaction
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

## What Phase 1 adds

| Requirement | Where | Verified by |
|---|---|---|
| F3.1, F3.2 charter, injected first | `src/context/builder.ts` | `charter-context.test.ts` |
| F3.3, F3.4 declarative policy | `src/policy/` | `policy-engine.test.ts` |
| F3.5 lower scopes may only tighten | `db/migrations/0005_*.sql`, `src/policy/engine.ts` | `policy-engine.test.ts` |
| F3.6 charter and policy edits audited with a diff | `src/governance/store.ts` | `policy-engine.test.ts`, `charter-context.test.ts` |
| F3.8 audit-mode policies | `src/policy/engine.ts` | `policy-engine.test.ts` |
| F4.1, F4.3 versioned facts, superseded not deleted | `src/memory/store.ts` | `memory-scope.test.ts` |
| F4.2 scope filtered before similarity | `src/memory/store.ts` | `memory-scope.test.ts` (1,000 facts) |
| F4.6 memory scoping per project and division | `src/memory/store.ts` | `memory-scope.test.ts` |
| F6.1, F6.2 typed contracts both ways | `src/engine/contracts.ts` | `contracts-handoff.test.ts` |
| F6.3 handoff triggered by completion | `src/engine/handoff.ts` | `contracts-handoff.test.ts` |
| F6.4 `awaitChild` with a mandatory timeout | `src/engine/engine.ts` | `contracts-handoff.test.ts` |
| F8.9 external content marked as data | `src/context/builder.ts` | `charter-context.test.ts` |
| F9.1 durable cron | `src/scheduler/scheduler.ts` | `scheduling-windows.test.ts` |
| F9.2 external windows, deferring not failing | `src/scheduler/windows.ts`, `src/broker/broker.ts` | `scheduling-windows.test.ts` |
| F9.3 owner window, incidents excepted | `src/scheduler/windows.ts` | `scheduling-windows.test.ts` |
| F12.1, F12.2, F12.4 secret references, scope, redaction | `src/secrets/manager.ts` | `credentials.test.ts` |

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

**Policy is a second gate, not the first.** Capability grants and reversibility
tiers run before it, so an unmatched action is allowed rather than denied. The
strictest match wins across scopes, and a policy can never lower a tier 3
action below owner approval.

**A required review fails closed.** Adversarial reviewer roles arrive in Phase
2, so until then a `require_review` policy escalates to the owner. A policy
author who asked for a second pair of eyes did not ask for none.

**A closed window defers, it does not fail.** The action is permitted, just not
at this hour, so the task parks in `waiting_window` with a wake-up time instead
of burning an attempt.

**A schedule backlog collapses, and says so.** After a day of downtime an
hourly schedule owes twenty-four runs; executing them would spend a day of
budget in a minute. One catch-up run happens and the count of dropped
occurrences goes into the event, because a silently skipped night looks
identical to a quiet one.

**Embeddings carry the model that produced them.** Vectors from different
models are not comparable, and mixing them yields confident nonsense rather
than an error, so retrieval filters on the model.

**An aborted transaction never reports success.** PostgreSQL turns a COMMIT
after an error into a rollback and says nothing; `withTenant` detects that and
throws, so a caller that swallows an error inside a transaction cannot lose
every write believing it succeeded.

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

Phase 2 and beyond, in PRD order: memory distillation and candidate SOPs
(F4.4, F4.5), adversarial review and decision records (F7), company templates
(F2.5), the daily digest and weekly retro (F9.4, F10.6), the cost dashboard and
alerts (F11.3, F11.4), and the owner UI. LLM traces are stored (F11.1) but
nothing reads them yet.

Until F7 lands, a `require_review` policy escalates to the owner rather than
routing to a reviewer role.

`src/llm/client.ts` deliberately ships only an interface and a test double. The
PRD leaves model-per-tier calibration open (section 14.4) and asks for
per-role model abstraction so one provider outage cannot stop the platform, so
binding to a vendor now would pre-empt a decision the owner has not made.
