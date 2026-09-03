# PALUGADA

Orchestration platform for running one or more companies whose work is carried
out entirely by AI agents, with exactly one human as owner. The owner is not a
daily operator: they are the legal entity, the approver for irreversible
actions, and the recipient of escalations.

This is not a collaboration workspace and not a multi-agent chat. It is a
**durable workflow engine + state store + policy engine + capability broker**,
with a single human interface: a decision inbox.

The product specification is [`docs/PRD.md`](docs/PRD.md) — **v2.0**,
Indonesian. Code and comments are English; requirement identifiers such as
`F5.4` refer to sections of that document.

v2 replaces v1, which is kept at [`docs/PRD-v1.md`](docs/PRD-v1.md) because
most of this codebase was built against it and cites its numbering. Three
identifiers changed meaning between the two, and
[`docs/STATUS.md`](docs/STATUS.md) is the map: it lists those, and grades every
v2 requirement as built, partial or not built.

## Status

**Everything the v1 specification asked for is implemented and tested**, with
204 acceptance tests running against a real PostgreSQL 16 with pgvector:
tenant isolation and the durable engine, the charter and policy engine, scoped
memory with distillation, typed contracts and handoff, adversarial review,
the capability broker with tier calibration and cost control, durable
scheduling, credentials and rotation, retention, replay, a code sandbox, and
audit export. On top of that, **the standard company** — a calibrated
capability catalogue and a template of function-based divisions that fit any
line of business, which is the owner's answer to PRD section 14.2.

**v2 is a larger specification, and much of it is not built.** It makes
PALUGADA explicitly a control plane that employs third-party runtimes
(Claude Code, Hermes, OpenClaw, HTTP, scripts) through an adapter protocol,
and adds heartbeats and a wake queue, atomic checkout with leases and lanes,
lifecycle hooks, plan steps, preflight, batch guards, a curated skill loop,
signed bundles, and trajectory evaluation. See
[`docs/STATUS.md`](docs/STATUS.md) for the requirement-by-requirement grading
and for the three decisions that gate the rest — the largest being that v2's
NG6 forbids the platform from calling an LLM itself, which the current engine
does.

Nine questions in [PRD section 14](docs/PRD.md#14-pertanyaan-terbuka) remain
open. Three of them (fork versus build, the monthly cost ceiling, and which
durable engine to adopt) set defaults across the whole system.

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
  broker/          capability registry, the standard catalogue, and the broker
  policy/          declarative conditions and the policy engine
  governance/      charter and policy administration, audited
  review/          adversarial review and decision records
  memory/          the four memory kinds, scoped retrieval, distillation
  templates/       building a company from a stored shape, and the standard one
  reporting/       cost, alerts, daily digest, weekly retro
  context/         prompt assembly, charter first
  scheduler/       durable cron, capability windows, the owner window
  secrets/         secret references, redaction, rotation
  retention/       the only code that deletes anything durable
  sandbox/         constrained execution for code-running capabilities
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

## What Phase 2 adds

| Requirement | Where | Verified by |
|---|---|---|
| F1.1, F2.5 a company from a template, no deploy | `src/templates/company.ts` | `company-template.test.ts` |
| F4.4 episodic → semantic, semantic → procedural | `src/memory/distillation.ts` | `distillation.test.ts` |
| F4.5 candidate SOPs need the owner | `src/memory/store.ts`, `src/inbox/inbox.ts` | `distillation.test.ts` |
| F7.1 review gates the action | `src/review/review.ts`, `src/broker/broker.ts` | `adversarial-review.test.ts` |
| F7.2 two revisions, then the owner | `src/review/review.ts` | `adversarial-review.test.ts` |
| F7.3 a different role, its own working memory | `db/migrations/0006_*.sql`, `src/review/review.ts` | `adversarial-review.test.ts` |
| F7.4, F7.5 decision records, remembered as decisions | `src/review/review.ts` | `adversarial-review.test.ts` |
| F7.6 no scheduled reviews | — (asserted absent) | `adversarial-review.test.ts` |
| F9.4, F10.6 daily digest, weekly retro | `src/reporting/digest.ts` | `reporting.test.ts` |
| F11.3 cost per project, division, role, capability | `src/reporting/cost.ts` | `reporting.test.ts` |
| F11.4 alerts on cost, failure rate, denials, verification | `src/reporting/alerts.ts` | `reporting.test.ts` |
| Phase 2 exit: two companies in parallel, isolation green | — | `company-template.test.ts` |

## What Phase 3 adds

| Requirement | Where | Verified by |
|---|---|---|
| Section 9 durability under chaos | — | `chaos-durability.test.ts` |
| F5.9 dry-run replay | `src/engine/replay.ts` | `replay.test.ts` |
| F8.10 sandbox for code execution | `src/sandbox/sandbox.ts` | `sandbox.test.ts` |
| F11.5 retention, with an archival path | `src/retention/retention.ts`, `db/migrations/0007_*.sql` | `retention-rotation.test.ts` |
| F11.6, F1.5 audit and company export | `src/audit/export.ts` | `audit-export.test.ts` |
| F12.3 secret rotation without a restart | `src/secrets/rotation.ts` | `retention-rotation.test.ts` |

## What the standard company adds

Section 14.2 asked which line of business the first company would be in,
because that fixes the initial capabilities, the tier calibration and the
division template. The owner's answer was that there is no single one: the
platform runs companies of every kind. So the catalogue holds what *every*
company does — correspond, keep records, publish, deploy, invoice, pay — and
the template is organised by function rather than by industry.

| Requirement | Where | Verified by |
|---|---|---|
| 14.2 capability catalogue and tier calibration | `src/broker/catalogue.ts` | `capability-catalogue.test.ts` |
| F8.3 a binding may tighten the catalogue, never loosen it | `src/broker/registry.ts` | `capability-catalogue.test.ts` |
| F8.10 untrusted code kept away from credentials and tier 2 | `db/migrations/0008_*.sql` | `capability-catalogue.test.ts` |
| F1.1, F2.5 a general-purpose company template | `src/templates/standard.ts` | `capability-catalogue.test.ts` |
| F2.3 a role's tools are a subset of its division's grants | `src/templates/company.ts` | `capability-catalogue.test.ts` |
| Section 8.8 tier 2 is checked against the budget before the call | `src/broker/cost.ts` | `cost-control.test.ts` |
| F8.5 estimate before, actual after, `cost.drift` past half | `src/broker/cost.ts` | `cost-control.test.ts` |
| F11.3 per-capability cost from measured spend | `src/reporting/cost.ts` | `reporting.test.ts` |
| F3.7 denials counted per role, the role frozen past the limit | `src/governance/role-freeze.ts` | `role-freeze.test.ts` |
| F4.7 the run is told when it is leaning on an unverified fact | `src/context/builder.ts` | `charter-context.test.ts` |
| F9.5 non-urgent, read-only work waits for cheap hours | `src/scheduler/windows.ts`, `src/engine/engine.ts` | `scheduling-windows.test.ts` |
| v2 F8.11 a tier 2 action needs a recorded plan first | `src/engine/plan.ts` | `plan-and-batch.test.ts` |
| v2 F8.13 batch guard: the call is held to the plan's count | `src/engine/plan.ts`, `src/broker/broker.ts` | `plan-and-batch.test.ts` |

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

**An approval covers one action, not a mood.** A review is granted against a
fingerprint of the capability and its input, so a proposer that comes back with
a different amount or recipient is asking a new question.

**The distiller never reads its own output.** A run records that it ran; without
excluding those events the next run would distil its own housekeeping into
"facts", and each retelling would look like fresh corroboration.

**Watermarks are compared inside the database.** PostgreSQL timestamps hold
microseconds and a JavaScript Date holds milliseconds, so a watermark that
round-trips through the application is rounded down and reopens a window that
was already consumed.

**An unreadable verdict is not consent.** A reviewer that crashes or answers in
prose escalates to the owner; treating it as approval would make the gate
decorative in exactly the case it exists for.

**Alerts fire once per condition per day.** A sweep every minute against a
standing overspend would fill the inbox, and an owner who has learned to scroll
past the inbox is worse off than one with no alerts.

**Deleting history is one narrow, recorded exception.** Retention is the only
code that removes anything durable. It works only inside an explicit purge
marked by a transaction-local flag, only on rows the database re-checks as past
the window, and it writes what it removed — so "there are no events from March"
and "March was quiet" stay distinguishable. A missing retention policy forbids
deletion rather than permitting it.

**A crashed worker is not a failed task.** A handler that throws consumes a
retry attempt; a process that is killed never reached the engine's error
handling, so resuming it consumes none. Without that distinction a bad deploy
restarting every process would exhaust `attempt_max` and fail every in-flight
task.

**A replay cannot reach the world.** The replay module imports no broker, no
adapter and no model client — not disabled ones, none at all. A step the
recorded run never took is reported as a divergence rather than invented.

**The catalogue is the calibration, and it only tightens.** A capability the
catalogue names cannot be registered below its catalogued tier. That is F8.3
one level up: the same rule that stops a grant loosening the registry stops a
registry entry loosening the catalogue. A registration is the last moment
anyone reads a tier on purpose; afterwards the number is simply believed. It
caught five miscalibrated bindings the day it was added.

**The catalogue does not publish itself.** A row in `capabilities` means the
broker can run the thing, and the table requires a read-back above tier 0
(F8.4). Writing declarations into it would mean claiming a `verify()` that does
not exist, so capabilities arrive there only through `registry.sync()`, when a
real adapter is bound.

**Untrusted code lives alone.** The sandbox does not isolate the network, so
`src/sandbox` names the consequence: a code-executing capability must not also
hold a credential or reach a tier 2 action. That was a comment, and a comment
does not stop a grant. Two database triggers now enforce it from both sides, so
the order in which somebody configures a division cannot decide whether the
rule applies.

**A reviewer holds nothing.** In the standard template the assurance division
has no capability grants at all. A reviewer that can also execute is not a
second pair of eyes, it is a second pair of hands.

**The standard company's money ceiling is zero.** Section 14.3 is open, and
inventing a number would settle it by default. Zero is the fail-closed reading:
the company works from the first minute and every declared cost lands over
budget in the cost report until the owner sets a ceiling.

**Models are named by role, not by vendor.** The standard template asks for
`fast`, `standard` or `deep`. Section 14.5 leaves the mapping open and F6 wants
per-role model abstraction, so binding a vendor name into a stored template
would pre-empt both.

**The estimate is charged before the call, the actual after it.** A ceiling can
only change the outcome while the money is unspent, so the budget is debited
first and a refusal produces no downstream call — the rule F2.4 states for
grants. Settlement afterwards is unconditional: the provider has already
billed, and refusing the adjustment would leave the account claiming an amount
the company does not owe. An overrun becomes a visible overspend rather than a
quiet understatement.

**"Cost nothing" and "nobody measured" are different facts.** A capability that
reports no actual cost produces no drift event and no measured figure. Reading
the second as the first would raise a 100% drift on every unmeasured capability
and bury the real ones, and would print a guess on the dashboard next to a
measurement without saying which is which.

**A repeated denial is a role's problem, not a task's.** One task being denied
is one task going wrong; a role being denied over and over is a prompt or a
grant that is wrong, and it will be just as wrong for the next task that runs
it. So F3.7 freezes the role — the smallest cut that actually stops the
repetition — and the freeze covers admission as well as capability calls, or
the role would keep starting tasks that cannot finish their work.

**Nothing thaws on a timer.** A frozen role waits for the owner. The condition
that caused the freeze does not fix itself overnight, and a role that unfroze
by itself would spend tomorrow's allowance the same way.

**Bookkeeping never changes the answer.** If the freeze counter fails, the
caller still gets the denial it asked about, with the code the engine branches
on. The counter's failure is recorded rather than swallowed, because a control
that has quietly stopped working is worse than one that was never there.

**A plan is a number, not a paragraph.** v2 records an outreach agent that
contacted 23 leads when it should have contacted 3; nothing in the system knew
what "3" was, so nothing could notice. A plan step names the capability, what
it expects to be true afterwards, and — where the call is a batch — how many
items it covers. Free text would be readable and uncheckable, which is the
state that produced the 23.

**A plan cannot be rewritten.** Recording one twice is refused. A plan that can
be edited mid-task is a description rather than a commitment, and the failure
it exists to prevent is precisely an agent finding itself with 23 recipients
and deciding that was the plan all along. Changing course is a new task or an
escalation, not an edit.

**The batch size comes from the capability, not from the arguments.** The
broker never guesses which parameter is the list. A guess breaks silently the
day a field is renamed, and a guard that has quietly stopped guarding is worse
than none.

**Deferral is opt-in, and eligibility is not taken on trust.** F9.5's batching
runs non-urgent work in cheap hours. A task waits only if it was marked
non-urgent — defaulting to "wait until tonight" would make a forgotten flag the
difference between a company that answers and one that does not — and only if
its role holds no capability above tier 0, checked against the registry rather
than against a claim in the request. A caller that could declare its own work
read-only could park a production deploy until 02:00, by which time the world
it was going to write to has moved.

**No cheap hours means no waiting.** A company that has declared no batch
window runs its batchable work immediately. Reading an absent window as "any
hour will do" would park every such task for ever in the ordinary case of a
company that never configured one.

**Telling the agent means telling it, in words.** Memory confidence (v2 F4.1,
F4.5) used to be a decimal in a heading, which is easy to skim and assumes the reader knows
where the line is. A context carrying an unverified fact now opens with a
warning that says how many and what to do about them, and each such fact is
titled UNVERIFIED. The warning comes before the facts, for the same reason the
charter does.

## Deviations from the PRD found while building

1. **`pending -> halted` is still missing from the section 8.5 diagram.** A
   task can be admitted and then miss its deadline before a worker picks it up.
   F5.6 requires that to halt, but the diagram offers a pending task only
   `running` and `cancelled`. The transition was added; see
   `src/domain/task.ts`. v2 redrew the diagram and did not add it, so the
   deviation stands.

2. **The append-only log makes company deletion impossible.** The trigger on
   `events` rejects `DELETE`, including through a cascade, so a company row
   cannot be removed once it has any event. This is consistent with section 7.4
   and with F1.4/F1.5 offering freeze and export rather than deletion, but it
   means retention (F11.5) will need an explicit archival path rather than a
   delete.

A third deviation recorded against v1 — `waiting_window` being absent from the
state diagram although F9.2 named it — is resolved: v2 draws it.

## Not built yet

Most of what v2 added. [`docs/STATUS.md`](docs/STATUS.md) grades it requirement
by requirement; the short version is that the runtime adapter protocol (F13),
lifecycle hooks (F14), the skill loop (F15), bundles (F16) and trajectory
evaluation (F17) do not exist, and neither do heartbeats and the wake queue
(F9.7–F9.10), atomic checkout, leases, lanes and orphan recovery
(F5.11–F5.14), preflight (F8.12), the spending circuit breaker (F1.7–F1.9), or
goal ancestry (F2.7).

There is also no owner UI, which several v2 requirements assume (F10.9–F10.10,
F11.2, F12.5).

Section 13 still ends with "evaluate migrating the engine or the vector store
based on real data". That is not something to write ahead of the data: there is
no production workload to measure yet, so the evaluation is deliberately not
attempted rather than guessed at.

## Limits worth knowing before you rely on them

- **The sandbox does not isolate the network.** Node's permission model covers
  the filesystem, child processes, workers and native addons, but not sockets.
  Real network isolation needs a container or a namespace below the process.
  The consequence is concrete: a capability that executes untrusted code must
  not also hold a credential or reach a tier 2 action. `SANDBOX_GUARANTEES`
  states this in code so it cannot drift out of the comment.
- **Per-capability cost is measured where the capability measures it.** A
  capability that reports what it was billed is counted at that figure; one
  that reports nothing falls back to the estimate it was charged, and the row
  is flagged `estimated`. The flag is pessimistic on purpose: one unmeasured
  call marks the whole row.
- **Semantic retrieval uses exact search.** That is correct at these volumes
  and is what makes F4.2's "filter before similarity" literally true, but the
  scale in section 9 will need pgvector's iterative scans or per-scope partial
  indexes — not an ANN index bolted on, which would silently invert the filter
  order.
- **Deleting a company is still impossible**, by design: the append-only event
  log has no cascade path. Freeze, export and retention are the supported
  operations.

`src/llm/client.ts` deliberately ships only an interface and a test double. The
PRD leaves model-per-tier calibration open (section 14.5) and asks for
per-role model abstraction so one provider outage cannot stop the platform, so
binding to a vendor now would pre-empt a decision the owner has not made.
