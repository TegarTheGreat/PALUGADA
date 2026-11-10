# Audit: how close is PALUGADA to an operating system for a one-man company?

Written 2026-10-03, before any change it recommends. Method: eight readers worked
in parallel. Four researched 2025-2026 practice on the web (durable execution and
harnesses; workspaces, computer use, human-agent work and multi-agent systems;
memory and context engineering; verification, evals and blast radius). Four read the
repository at `4f77088` -- the system as an organisation, the workspace, the loop to
outcomes, and memory -- without running anything. What decided the plan was then
re-read in the code by the author of this file; those claims are marked **checked**.
A claim marked *audit* rests on the reader's reading of the code only.

Firecrawl had no credits, so the research used web search and fetch. Fetched pages
passed through a summariser, so figures are as that summary reported them; what could
not be opened is listed under *Not verified* at the end and is not relied on.

The goal, as the owner stated it: one owner gives goals, limits and key decisions; AI
is the main workforce; people (staff, contractors, specialists, reviewers, vendors,
operators of physical work) join the same system when they are the better choice,
without being a dependency of normal operation; the system keeps working, learns,
resumes, recovers and chases real outcomes with as little human intervention as is
actually needed.

---

## 1. Diagnosis

PALUGADA is further along on **safety and durability** than on **autonomy and
outcome**. The parts that make unattended work trustworthy are unusually complete:
a journalled step per call, leases with reclaim, budgets reserved up the account
chain, a broker with tiers, fingerprint-bound approvals, taint that follows work to
sub-tasks and reruns, row-level security, and goals the agents cannot close. Most of
what 2025-2026 write-ups tell teams to build, this repository already has.

What it does not yet do is run a company when the owner is not pressing buttons:

1. **The owner is the dispatcher at the top and the recovery agent at the bottom.**
   Work enters by an owner press, a schedule the owner made (the standard company
   ships none), or a trigger or channel the owner connected. Goals are context and
   start nothing. When work halts, fails or strands, most of the time nothing reaches
   the inbox, and the one path meant to send it to a coordinator first is dead code
   (section 3, defects).
2. **The loop closes at "action executed", not at "outcome observed".** Nothing makes
   anyone look again at an invoice, a campaign or a deploy after the action. A goal is
   marked met by the owner alone, on an agent's prose, with no computed evidence on
   the card.
3. **Humans are approvers and answerers, not workers.** A task has no assignee; the
   only ways to ask a person are `owner.ask` and `browser.handover`, both addressed to
   the owner, with a string for an answer.
4. **Memory has no lifecycle.** A lesson enters at 0.5 and is raised to "Known fact"
   by being said twice, never expires, has no date a run can see, and a correction the
   owner made is undone by the next agent that writes the same sentence.
5. **A stock install has no workspace.** Nothing sets the files root, so drafting,
   pictures, speech and `code.compute` are unbound, and no standard role could use
   the files tools if it were set.

None of these needs a new framework. Section 5 shows that each can be closed with
primitives that are already there.

---

## 2. What is good and should not be changed

Each item is *audit* unless marked **checked**; the file and line are the reader's.

**Work as data.** The task state machine is one table (`src/domain/task.ts:39-74`);
every move takes the row lock and asserts the edge (`src/engine/tasks.ts:822-835`).
Claim, lane, division concurrency, token headroom and priority are one statement under
a per-company advisory lock (`src/engine/checkout.ts:96-183`). Every parked state has a
typed "next mover", and a sweep asks the owner once per stranded task
(`src/engine/liveness.ts:66-162`).

**Durability.** Every model and tool call is a journalled step with a fenced commit
(`src/engine/journal.ts:98-210`); a rerun is told what earlier attempts already wrote
(`journal.ts:218-261`); in-process turns are stored as provider-neutral blocks, so a
model change mid-task continues the same conversation (`src/runtime/agent-loop.ts:129-174`).
A crashed worker's task is reclaimed, and halts as `crash_loop` after three losses.
This matches the consensus of the durable-execution literature: each call a durable
unit, at-least-once with idempotency keys, nothing held in memory while waiting [R2].
It is also why PALUGADA does not need Temporal or a code-replay framework: agents
resume by re-reading a journal, and the research found a Postgres-only design credible
[R2].

**Decisions.** A decision and the task move share one transaction; silence expires
into cancellation, never execution; a yes is bound to the action's fingerprint and
spent before the action (`src/inbox/inbox.ts:333-355, 1729-1735, 2310-2350`).

**Blast radius.** Outside-content taint is computed over the whole task tree and does
not depend on the model (`src/broker/broker.ts:614-672`, `tasks.ts:126-150`). The
guardian can only tighten. A capability may declare its own deterministic check
(`clearsOutside`) that is asked only after every owner yes has been looked for. This
is the architecture the 2026 evidence says holds -- Meta's "Rule of Two", CaMeL-style
separation, scoped grants -- where prompt-level defences do not [R4].

**Goal discipline.** A root task must name an open goal; closing a goal pauses its
schedules and triggers in the same transaction; agents have `SELECT` only on goals;
no agent can close one (`tasks.ts:249-259`, `goals.ts:322-351`).

**Review as a task.** A reviewer is an ordinary sub-task whose typed output is settled
by state; it knows nothing about review bookkeeping (`src/review/review.ts:227-248`).
This is the best evidence in the codebase that work is shaped neutrally enough for
another kind of worker (section 5, P1).

**Facts that are not memory.** Metrics are rebuilt each run with value, VERIFIED or
UNVERIFIED, date and the capability to re-read (`src/domain/metrics.ts:346-355`).
Contacts, deals and the books are tables and are never distilled into memory.
Documents are the owner's alone and are searched by passage.

**The memory substrate.** One `memories` table with Postgres full-text search, forced
row security, supersession that keeps history and fails loudly, an `outside` flag
carried end to end, owner words that runs cannot move, a candidate gate for procedures,
and episodes written as records, not beliefs (`src/memory/store.ts`,
`src/engine/tasks.ts:737-796`). The research does not support adding a vector or graph
database: hybrid lexical retrieval and files competed with, and often beat, memory
products; stale facts and noise, not recall, were the real failures [R3].

**Skills.** Propose, eval screen, reviewer, owner approval, with a database trigger
that demands an eval (`src/skills/skills.ts`, `0021:110-124`). Curated, small, reviewed
skills are what helped in the 2026 skill benchmarks; self-written ones did not [R3].

**Bounded loops.** Three attempts with waits, five rate-limit parks, hop depth three,
fan-out five, cycle refusal, a repetition check on schedules, a halted task is
terminal. Unbounded reflection and delegation are on the list of things not to build;
they are already bounded.

---

## 3. Gaps, by area

Ranking inside each area is by leverage for the one-man-company goal.

### 3.1 System / operating model

- **Approved work is killed by a deadline it spent waiting for the owner.**
  **Checked.** `task.delegate` gives a child a deadline (default 60 minutes). A child
  parked in `waiting_approval` is not touched by the deadline sweep
  (`checkout.ts:545-568`). When the owner approves, the task goes to `running` with no
  lease (`inbox.ts:2152-2173`); the next sweep takes any `running` task with no lease
  and a passed deadline and halts it `deadline_passed`, and the claim refuses it too
  (`checkout.ts:137`). The owner approved; nothing happened. This is the ordinary
  coordinator-to-specialist-to-risky-action path whenever the owner answers after an
  hour. No test covers a delegated child with an approval wait.
- **Humans are not workers.** *audit* A task has `role_id NOT NULL` and no assignee; no
  runtime can wait hours; inbox items have no addressee, so any approver seat may
  decide any open tier-2 item; a seat reads the whole company and has no "my work"
  view; the answer to `owner.ask` is a string with no attachment. The shape of work is
  neutral enough -- role, uniform contract, journal, goal, budget chain, and review
  already runs through a role's typed output -- but everything around execution is
  wired to an AI or the owner.
- **The owner is the dispatcher and the recovery agent.** *audit* No default schedule,
  filing a ticket wakes nothing, `continueHalted` works only for budget halts, and
  unattended root tasks that fail are silent apart from the digest.
- **Escalation to a coordinator first is dead code.** **Checked.** `raiseEscalationWithin`
  reads the division's `escalateTo` policy only when given a `divisionId`
  (`inbox.ts:498`); no production caller passes one. The standard template's six
  `escalateTo` entries, `docs/guide/concepts.md:224-226` and STATUS F2 "Built" all say
  the coordinator is asked first.
- **Most halts never reach the inbox.** *audit* `domain/task.ts:30-33` and the PRD say
  "halted goes to the inbox"; only budget, failed read-back, crash-loop and model-outage
  halts raise an item. Hop, deadline, policy, contract, fan-out, cycle, run-limit,
  attempts-exhausted and a reviewer's reject do not.
- **Decision load scales with every tier-2 act in tainted work**, and the reducers are
  narrow: only `chat.send` declares a deterministic check. Nothing measures the PRD's
  target of at most ten items a day. *audit*
- **A reply from an outside person cannot wake the work that asked.** A customer reply
  joins only a `pending` task; otherwise it starts a second task for the conversation.
  Questions never expire. *audit*
- **The budget is weaker than it reads.** Admission reserves a 1,000-token placeholder
  whatever the role's run ceiling is, and delegated children charge the parent's
  account, so the delegatee's own ceiling never binds; `AGENTS.md:18` says money is
  reserved before work starts. *audit*

### 3.2 Workspace ("meja kerja")

The existing shape is enough: the journal is the source of truth, there is one files
directory per company, the owner's documents, the gallery, and a briefing kept per run.
Every runtime is deliberately stateless -- a run directory removed on close, built-in
agent tools off, no session persistence, read-only containers. The research agrees: the
consensus is a disposable sandbox with durable state kept as a log, files and
snapshots, not a durable per-agent machine; Anthropic's own docs say not to rely on
session resume [R1, R2]. The holes are linkage, reachability and defaults.

- **A stock install has no workspace.** *audit* Nothing sets `PALUGADA_FILES_ROOT`
  (not `setup.ts`, `.env.example`, `install.sh` or compose), so `files.list`,
  `doc.draft`, `email.draft`, pictures, speech and `code.compute` stay unbound; and even
  with a root, no standard role holds `files.read`, only divisions are granted it.
- **Files have no provenance, and reading any file taints the reader.** *audit* A file's
  only link to its task is a path inside a journal step. `files.read` is catalogued as
  reading outside content because "nothing records which", so reading an agent's own
  draft makes later tier-2 actions ask the owner: handing a file between agents is
  penalised. Every role's output declares `artefacts`; nothing reads it.
- **A resumed out-of-process agent is told results without their questions, and never
  its plan.** *audit* Working memory is `SELECT name, output`; no tool input, no plan,
  no rationale.
- **The pack drops the newest steps first, and the stated remedy does not exist.**
  **Checked** (`builder.ts:909-915`; the notice says to use `memory.search`, which
  returns facts and documents only). A task that overflows the pack on resume loses its
  latest state and is pointed at a tool that cannot return it.
- **Turn or context exhaustion means repeat, then fail.** *audit* `MAX_TURNS=40`,
  messages unbounded; a "prompt too long" is a plain error; the retry replays the same
  forty journalled turns and fails the same way, three times, then `failed`. The model
  is never told its budget. There is no checkpoint.
- **A new task starts nearly blind.** *audit* A rerun has an empty journal; episodes
  are written only on completion with no artifact path; a child's output reaches its
  parent cut to 2,000 tokens, and no capability reads another task's output by id.
- **Artifacts do not scale or stay visible.** *audit* `files.list` caps at 500 in
  directory order, media and compute names are random so a crash replay duplicates the
  file and re-pays the provider, files have no retention and the owner cannot browse or
  download them. The gallery lists `files.read` results as "produced" and omits
  generated pictures.

### 3.3 Looping to outcomes

The four levels, and where each is recorded:

| Level | Recorded? |
|---|---|
| Action executed | Yes, strongly: every call is a journalled step. |
| Deliverable verified | Partly. A read-back proves the effect *exists* in the target system, not that it is the right one (the shipped invoice example treats `pending` as verified); done criteria are mostly the run's own report, and evidence without a `step:N` citation passes as "claimed". |
| Real-world outcome observed | Only as `metric_observations`, set by the owner or an agent; "verified" means the same task has a committed call to the metric's source capability whose output contains that number anywhere. Nothing links an observation to an action; nothing gates on `verified`. |
| Goal achieved | The owner alone. Nothing computes it, and the card shows no platform-built evidence. |

- **There is no durable "look again later".** **Checked** that the column exists and
  is unused: `CLAIM_SQL` already holds a task until `wait_until <= now`
  (`checkout.ts:136`) and `insertTask` never sets it (`tasks.ts:620-640`). The catalogue
  has no wait or follow-up capability; `schedule.propose` is recurring cron at least an
  hour apart and needs the owner's yes; `metric.due_on` and `deals.expected_on` are
  read by no code. After an invoice, a campaign or a deploy, nothing is time-keyed to
  the action.
- **Goal closure and metric targets are disconnected.** *audit* `proposeGoalChange`
  needs only a non-empty reason (`goals.ts:203-208`); the owner's card shows only that
  prose; a goal's progress bar is the share of tasks done, and a regression after
  "met" is invisible because closed goals drop out of the review.
- **The loop is opt-in and idle by default.** *audit* The standard template's goals
  have no metrics and no schedules; the first hour never asks "what number says this
  works"; the weekly review is skipped for a quiet week, which is when a company is
  stalled.
- **The reviewer's verdict is not requested of the shipped reviewers.** **Checked.**
  `readVerdict` needs `output.decision` and `reason`; only the critic is given a
  verdict schema (`builtin.ts:648`); the standard `reviewer`, `qa-reviewer` and
  `platform-reviewer` use the work schema, and the code's own comment says that a
  reviewer "given the ordinary work output instead, answers with a summary, and a
  review with no readable verdict goes to the owner as undecided".
- **`verified` proves less than it appears to.** *audit* It matches any number anywhere
  in the source call's output, and agents write the internal books, which can be a
  metric source.
- **Stall detection is narrow** (five byte-identical schedule outputs) and most halts
  and failures never reach the owner. *audit*

### 3.4 Memory and organisational learning

The substrate is right (section 2); what is missing is a lifecycle for an unconfirmed
belief. There is no candidate step for facts: when a task completes it writes up to five
lessons straight to active memory at 0.5, the hourly distiller writes through the same
function, and only distilled procedures and skills are gated. *audit*, with the
following **checked**:

- **A correction does not stick.** `learn()` matches only rows that are active and not
  superseded (`store.ts:152`). After the owner retracts or replaces a claim, the next
  agent that writes the same sentence makes a fresh active row beside the correction,
  and can reinforce it back to "Known fact". The procedure path already respects a
  rejection (`distillation.ts:379-383`).
- **A long reviewer reason can jam review settlement.** The verdict is stored as a
  memory whose body includes the reason; `remember` refuses more than 4,000
  characters (`store.ts:97-100`); the reason has no limit, and the settlement loop is
  not guarded (`review.ts:559-571`, called at `worker.ts:594`). One long reason rolls the
  verdict back and blocks later reviews on every tick.
- *audit:* **Beliefs harden by echo and never expire.** One reinforcement lifts a fact
  to 0.6, which is not below the line that renders "unverified"; nothing checks that the
  repeat is independent (five near-identical lessons from one task reach 0.8; a run
  shown a fact can restate it as a new lesson); `last_reinforced_at` is written and
  never read; no code expires or deletes a memory.
- *audit:* **Age and "as of" are invisible to the agent**, episodes are stored at
  confidence 1 and returned as not unverified, and the prompts ask runs and the
  distiller to remember "customers, products, prices, suppliers" -- mutable state --
  while no platform-wide line says to re-read the record.
- *audit:* The distiller reads up to 500 events of any type, counts calls rather than
  tasks when proposing a procedure, and parses model output with no handling of a code
  fence; a thrown error in one division aborts the rest.
- *audit:* Nothing moves a lesson between divisions (`shared` is never set); the pack's
  relevance is an `ORDER BY` with no `WHERE`; the owner's "It is true" turns text that
  came from an email into owner-authority and resets its date.

### 3.5 Other gaps the brief did not name

- **Stale and orphaned state.** A cancelled task's `owner.ask` card stays open; a
  parent that halts does not stop its children; `waiting_approval` has no `halted` edge
  so a parent's deadline-halt of such a child throws; an admitted task is not checked
  against a company freeze (triggers, chats and assign still create work); a `pending`
  task refused at claim for budget or lane gives the owner no signal. *audit*
- **Docs that say more than the code.** Escalation to the coordinator (checked, above);
  `AGENTS.md:157-162` says the platform engineer "runs `npm run check`" but holds no
  capability that executes anything; STATUS grades F4.8 "Built" though the remainder
  cannot be fetched; `browser.handover` promises to resume "on the page they left" but
  tabs live in process memory and are reaped after ten minutes. *audit*
- **Resume across runtime kinds.** Switching a role from a CLI to the in-process
  runtime mid-task is likely to halt on `journal.divergence`. *audit, unconfirmed*
- **Retention versus continue.** A budget-halted task idle over 90 days replays a
  scrubbed journal as a turn. *audit*
- **Leaks and clobbering.** Temp directories survive a SIGKILL and may hold a CLI login;
  the browser cookie jar is saved whole, last writer wins. *audit*
- **What the evidence says is the real risk and the repository does not yet measure:**
  approval fatigue (users approve about 93% of prompts), the reliable horizon of an
  unattended agent (about 1.5 hours at 80% against a 12-hour median) and the rate at
  which agents over-claim [R4]. PALUGADA has the controls but no instrument that tells
  the owner whether they are working.

---

## 4. Assumptions in the brief that the evidence does not support

1. **"Each agent needs a durable workspace."** The sandbox should be disposable; what
   must be durable is the log, the files and snapshots, and the *link* between them
   [R1]. PALUGADA already works this way. A per-agent desk or VM would add the thing the
   research warns against (a long-lived mutable machine as the only copy of state) and
   a new surface for secrets. Close the linkage holes instead.
2. **"Workers should write memory candidates before anything becomes knowledge."** A
   candidate queue the owner must clear makes the owner a click machine, which is the
   outcome the brief wants to avoid. What the evidence supports is deterministic: write
   unverified, promote on *independent* repetition or outcome, let it decay by silence,
   keep provenance, and ask the owner only about conflicts and anything that would
   change behaviour (procedures, which already have a gate) [R3]. Memory poisoning
   research points the same way: signed provenance and write gating, not more review.
3. **"A separate verifier or evaluator."** It exists (reviewer, critic) and is not the
   gap. LLM judges are unreliable on agent traces -- below 55% at spotting failures,
   biased to style and to their own family, and they accepted 44% of regressions in a
   54-cycle study [R4] -- and a supervisor on the same model rubber-stamped about eight
   to one in Project Vend. The lever is a check the worker cannot write, against a
   system of record, with the verdict schema actually requested. More evaluator agents
   would age badly; the independent check will not.
4. **"Humans as first-class workers need a new abstraction."** They do not. Review
   already shows a task can be done through a role's typed output, and `owner.ask` plus
   a seat already park a task for a person. What is missing is an addressee, a place to
   hand in a file and a view of one's own work. Linear's guidance is that an agent is a
   delegate and a person stays accountable [R2]; PALUGADA's owner-as-authority already
   fits that.
5. **"Chase outcomes with a loop."** The research and the code agree on the opposite of
   an autonomous loop: *give the work a durable reason to look again*, bounded by the
   machinery that exists (goal, hop, fan-out, budget), and let a measured metric --
   not the agent's say-so -- decide. An expectation ledger, a workflow DSL, automatic
   goal closing, an LLM judge of outcomes and an automatic re-planner are all things not
   to build. Outcome-only signals also "grow uninformative as horizons lengthen", so
   intermediate signals (the journal, artifacts, read-backs) stay [R3, R4].
6. **"Computer use is a fallback."** Already true here: the browser is a low tier and
   the catalogue prefers typed capabilities. Keep it; assume a residual injection rate
   of one to ten percent and keep the browser out of any session that also holds
   sensitive data and can change state without approval [R2].
7. **"Do not add workarounds for today's model weaknesses."** Agreed, and it argues
   against several things the audit's authors suggested: sprint decomposition,
   recitation prompts, context-reset rituals, fixed step caps, per-model compensation
   in the engine. Anthropic's own harness dropped its evaluator and its sprints between
   two model versions [R1]. The stable parts to invest in are the boundaries (state
   machine, journal, broker, budgets, taint) and the independent checks.

---

## 5. Ranked plan

Ranked by dependency, then impact, then reliability, then benefit to the one-man-company
goal. P0 is what is implemented with this audit.

### P0 -- bugs and wiring with high confidence, small blast radius

| # | Change | Why now |
|---|---|---|
| 1 | An approved task is not halted by a deadline it spent waiting for the owner | The most common delegated path fails silently |
| 2 | The shipped reviewers are asked for a verdict | A review otherwise goes to the owner as "unreadable" |
| 3 | A long reviewer reason cannot jam settlement | One bad row blocks every later review |
| 4 | A correction the owner made stays made; a lesson cannot echo itself to "Known" | Corrections and trust in memory |
| 5 | Memory is a lead, not the record: facts carry their date, episodes are not served as certain, and the pack and the lesson prompts say where current state lives | Separates "what we learned" from "what is true now" |
| 6 | An agent cannot have a goal marked met against a verified metric below target; the owner's card carries the platform's own reading | The one place "done" rests on prose |
| 7 | A role can ask to be woken later about its own work (`task.follow_up`) | The missing "look again at the real outcome" |
| 8 | A resumed run keeps its newest steps | A resumed agent loses its latest state |

### P1 -- real design needed; build next, in this order

1. **Escalation that works.** Take the division from the task in `raiseEscalationWithin`
   for stranded, crash and outage items; raise one card per halted or failed root task
   under a goal (batched, deduplicated); auto-assign a ticket an agent files to the
   company's CEO; add a "nothing owed" skip so a coordinator cadence costs nothing on an
   empty backlog. *Risk:* a coordinator that receives escalations can spend tokens in a
   loop; the existing hop, fan-out, budget-chain and repetition guards bound it, and the
   first version should only *ask* the coordinator, not let it act on tier 2.
2. **The outcome loop by default.** Ask "what number says this works" in the CEO's first
   hour; when a verified value reaches target, escalate "close the goal?"; when `due_on`
   passes unmet, escalate "continue, change or abandon?"; stop skipping the weekly review
   when an active goal has a stale metric; make `verified` compare a named field
   (`source_path`) rather than any number in the output; scope `metric.record` to the
   task's goal chain; treat observations as provisional with a settle window and a
   reopen path (the Intercom pattern [R4]); pair target metrics with guard metrics
   (refunds, discounts, reopen rate) because metric-chasing agents give things away [R3, R4].
3. **Workspace linkage.** Default the files root inside the compose `home` volume; fold
   listing into `files.read`; give it to the coordinator, planner and bookkeeper; index
   `path` and `files[].path` out of step outputs so a file knows its task and goal;
   have `files.read` report whether its writer's work was tainted instead of always
   claiming outside content; add a bounded `task.history` that reads the journal, plan
   and outputs of a task's own tree by id; classify the gallery by capability; page
   `files.list`; name media and compute outputs from the call key; an owner route to
   download and upload files.
4. **A checkpoint for context exhaustion.** Classify "prompt too long"; write one
   journalled `internal` checkpoint step (a summary of the turns so far) and rebuild
   messages from it plus the last few turns, so replay stays deterministic; tell the
   model its turn budget; let the owner continue a `run_limit` halt. *Alternative
   considered:* provider-side compaction. It is opaque and per-vendor, and the journal
   cannot be the prompt if it is used [R2]; the checkpoint keeps PALUGADA the owner of
   the contract. *Risk:* summary quality; the cheapest first step (state the limits,
   warn at turn 30, never drop the newest) ships with P0 item 8.
5. **A person as a runtime.** A `person` runtime whose first run raises an
   `owner.ask`-style escalation addressed to a seat, with the brief, output schema and
   goal chain, parks as `owner.asked` already does, and on resume reads the answer and
   returns it so the engine's contract check and done criteria apply unchanged. Add a
   `worker` seat kind scoped to its own items, an `assignee` in the item payload, and
   let an answer carry a file. Meter the person's time as cost. *Not* an employee
   database, an SLA engine or a new work item type. *Risk:* seat scoping is a data
   exposure question; start with items addressed to the seat and nothing else visible.
6. **Memory lifecycle.** Count a reinforcement only from a different task or day;
   facts nobody accountable has vouched for leave the pack and default search after
   about ninety days without confirmation (still searchable, still on the Memory page;
   the owner's "It is true" resets the clock); link near-duplicates with `pg_trgm`;
   flag a conflict only against an owner-sourced fact; an owner action to share a lesson
   with the company; allow-list the distiller's event types, count distinct tasks, and
   handle fenced JSON. *Alternative considered:* a candidate queue and an LLM
   consolidator -- rejected (section 4, item 2).
7. **Approval load.** Deterministic `clearsOutside` checks for `email.send` (reply to
   the thread's counterparty with no new address or figure), `invoice.pay` (at most an
   invoice that was read, under a cap) and `deploy.production` (staging verified and
   review approved), each as tightly bounded as `chat.send`; a decisions-per-day metric;
   a deny that carries a note without cancelling the task.
8. **Remaining defects** from section 3.5: no cascade when a parent halts; stale
   `owner.ask` cards; freeze at admission; a signal for work stuck `pending`; reserve
   from the role's run ceiling.

### P2 -- later, or only if a real need appears

- Contractor identity, SLAs and per-person cost beyond what P1.5 meters.
- Mapping task states one-to-one onto MCP and A2A task states and the stateless MCP
  tasks extension [R1]; not before something needs to expose or consume it.
- A random audit of finished work by a reviewer of a *different model family*, with the
  audit-failure rate shown as each role's health; extending a role's unattended scope on
  a reliability measure (about the 80% horizon), never on one evaluation score [R4].
- A bi-temporal view for the books if retroactive corrections become common; memory needs
  only `valid_from`, `valid_to` and a supersession link [R3].
- Cross-model resume between runtime kinds (the CLI-to-in-process divergence).
- Goal-aware cost reporting; per-goal budgets only if fan-out proves uncontrolled.

---

## 6. The big changes, set out

### 6.1 Durable follow-up (P0 item 7)

**Problem.** An invoice is issued, a campaign sent, a deploy succeeded. The effect lands
later, and nothing in the system looks again: only a blind recurring cron or the owner.

**Why the present design is not enough.** `schedule.propose` is recurring and needs the
owner's yes for each; task waits exist only for engine reasons; the column that would
hold a task until a time is never written.

**Alternatives.** (a) A new "expectation" table that records what each action should
cause and a sweeper that checks it -- rejected: a second state machine, and the thing it
would check is the same metric read a task can already do. (b) A trigger per action --
rejected: needs an outside system. (c) A long delay on `task.delegate` -- rejected: its
deadline defaults to an hour and caps at a day, and it is a child of a task that ends.
(d) **Chosen:** a task that is *created now and claimable later*.

**Solution.** `task.follow_up` creates a sub-task of the current task with `wait_until`
set. `pending` with a future `wait_until` is not claimable until it arrives (the claim
already says so), so it appears at that time with the same journal, budget, lease and
approval behaviour as any task. It is a sub-task so that it **inherits taint** (an
injected instruction cannot be laundered into clean, later work), the goal, the hop
depth, the fan-out and the budget chain; it names the role that does it, why, and what to
check; it is bounded -- not sooner than an hour, not later than ninety days, at most a
handful open per goal -- and is cancelled when its goal closes. Its brief tells the
follow-up to read the metric through its source capability, record it, and then continue,
propose a goal change, or ask the owner.

**Risks.** The token reservation is held for the wait (it is a placeholder, so small);
hop depth three means a chain of follow-ups ends after three, and a long campaign still
needs a schedule -- both are the point of a bound. The deadline must be the wake time
plus a window, not the creation time plus an hour, or the follow-up halts before it can
run.

**Migration.** None for data; one nullable column already exists. Existing tasks are
unaffected.

**Test.** A follow-up is not claimable before its time and is after it; it carries the
parent's taint, goal and budget; it is refused beyond the horizon, below the minimum, and
past the open limit; a closed goal cancels it; the deadline sweep does not halt it while
it waits.

### 6.2 An approved task survives its wait (P0 item 1)

**Problem.** A child with a one-hour deadline waits two hours for the owner, is approved,
and is halted `deadline_passed` on the next tick.

**Alternatives.** (a) Exempt waiting tasks from the sweep -- does not help: the task is
`running` with no lease by the time the sweep sees it. (b) Give the approved task a fixed
grace -- arbitrary. (c) **Chosen:** a person's answer is not the task's time. When the
owner's answer moves a task out of a waiting state, its deadline moves later by the time
the task spent waiting on that item.

**Risk.** A task can now outlive its parent's wait. If the parent has already given up
the owner's explicit approval is still honoured, and a retried parent picks the finished
child up by its idempotency key. **Test.** A task whose deadline passed while an approval
was open is neither halted nor refused after the yes; an unrelated overdue task is still
halted.

### 6.3 Goal closure against evidence (P0 item 6)

**Problem.** An agent's `goal.propose` for "met" carries a sentence; the owner approves
a sentence.

**Alternatives.** Auto-closing a goal when a metric reaches target -- rejected, closure
changes what the company is doing and stays the owner's. An LLM that judges the outcome
-- rejected (section 4, item 3). **Chosen:** the platform attaches its own reading of the
goal's metrics to the card and the payload, and refuses an agent's "met" while a live
metric's *verified* value is short of target. The owner's direct edit is unchanged.

**Test.** A proposal to mark a goal met is refused with the metric's figures while one is
short; accepted when verified values reach target or the goal has no metric; the card
contains the platform's reading.

### 6.4 Memory is a lead, the record is the truth (P0 items 4 and 5)

**Problem.** A fact an agent restated can outrank the owner's correction; a fact shows no
date; a run is asked to remember prices and statuses and given no instruction to re-read
them.

**Solution.** `learn()` does not resurrect a sentence the owner retracted or replaced;
one task's lessons count once and a task cannot reinforce what it taught; facts render
with the date learned and last confirmed, in the pack and in `memory.search`; episodes
are stored below the line of a known fact; both lesson prompts say to record what worked
or failed, preferences, rules and reasons -- not balances, statuses, prices or deadlines
-- and the pack says that for those a memory is a lead and the record (`crm.read`,
`ledger.read`, the metric) is the truth. No classifier, no decay yet (P1.6).

**Risk.** Text the models read changes; the tests assert the structure, not the wording.

---

## 7. Sources

Verified means the page was opened by the researcher; secondary means a report of it.

**[R1] Long-running agents, harnesses, workspaces**
- Anthropic, *Effective harnesses for long-running agents*, 2025-11-26, anthropic.com/engineering/effective-harnesses-for-long-running-agents -- progress file, feature list that starts failing, tests may not be edited.
- Anthropic, *Harness design for long-running application development*, 2026-03-24, anthropic.com/engineering/harness-design-long-running-apps -- a skeptical standalone evaluator is more tractable than a self-critical generator; scaffolding dropped as models improved.
- Anthropic, *Scaling Managed Agents*, 2026-04-08, anthropic.com/engineering/managed-agents -- session as an append-only log outside the harness; credentials never reach the sandbox.
- Claude Agent SDK, *Sessions*, code.claude.com/docs/en/agent-sdk/sessions -- "Don't rely on session resume".
- OpenAI, *Run long horizon tasks with Codex*, developers.openai.com/blog/run-long-horizon-tasks-with-codex -- durable project memory as files.
- Anthropic, *Effective context engineering for AI agents*, 2025-09-29; Manus, *Context Engineering for AI Agents*, 2025-07-18 -- reversible compaction; the file system as context.
- arXiv 2602.11988 -- context files did not raise task success and cost over 20% more.

**[R2] Durable execution, human-agent work, multi-agent**
- DBOS architecture docs; Temporal event history and *Temporal Agent Harness* (2026-08-20); Restate, *AI Agents should be serverless and durable* (2025-10-09); Ronacher, *Absurd* (2025-11-03) -- step-level durability, at-least-once, a queue and a state store.
- LangGraph interrupts (docs); HumanLayer, *12-Factor Agents* -- a human as a structured tool call with pause and resume; resume re-runs the node, so effects before the interrupt must be idempotent.
- Anthropic, *How we built our multi-agent research system*, 2025-06-13; Cognition, *Don't Build Multi-Agents*, 2025-06-12, and *Multi-Agents: What's Actually Working*, 2026-04-22; Anthropic, *When to use multi-agent systems*, 2026-01-23 -- single-threaded writes; a clean-context reviewer is the proven win; 3-10x tokens.
- arXiv 2512.08296 -- multi-agent configurations helped parallelisable tasks by 80.9% and hurt sequential ones by 39-70%; errors amplified 17.2x without a coordinator.
- Linear agent docs; Atlassian, *Human-in-the-loop patterns for AI agents in Jira* -- delegate, do not assign, to an agent.
- Anthropic, *Piloting Claude in Chrome*; OSWorld 2.0 (arXiv 2606.29537, 2026-06-28) -- best long-horizon completion 20.6%; Meta, *Agents Rule of Two* (secondary).
- MCP specification 2026-07-28 changelog and tasks utility -- stateless, task states `working`, `input_required`, `completed`, `failed`, `cancelled`, cooperative cancel.

**[R3] Memory, learning, outcomes**
- Mem0 paper (arXiv 2504.19413) -- full context beat Mem0 on accuracy (72.9 against 66.9); memory bought cost and latency. Letta, *Is a filesystem all you need?*, 2025-08-12 -- files and grep beat a memory product's reported score. MemoryAgentBench (arXiv 2507.05257); Memora (arXiv 2604.20006) -- 64% of errors came from outdated memory that was not forgotten. Vendor leaderboard figures are self-reports and one benchmark's key is 6.4% wrong.
- Mem0 issue 4573 -- 97.8% of 10,134 stored entries were junk, from recalled memories re-extracted as new facts. (A single user's audit.)
- ACE (arXiv 2510.04618) -- itemised lessons with helpful and harmful counts and deterministic merges; a full rewrite collapsed 18,282 tokens to 122. SkillsBench (arXiv 2602.12670), SWE-Skills-Bench (2603.15401), SkillEvolBench (2605.24117) -- curated skills help, most auto-distilled ones do not.
- OWASP, *Memory is a feature; it is also an attack surface*, 2026-05-13; arXiv 2503.03704, 2606.12703, 2607.14611 -- write gating and signed provenance; payloads persist even when a model refuses them.
- Anthropic, *Demystifying evals for AI agents*, 2026-01-09; arXiv 2607.25152 -- an agent claimed improvement in 54 of 54 cycles, 56% showed none, and judges accepted 44% of regressions. Anthropic, *Project Vend* phases one and two (2025-06-27, 2025-12-18) -- profit "in spite of the CEO"; procedures and tools helped most. arXiv 2512.20798 (ODCV-Bench) -- KPI pressure raised constraint violations.

**[R4] Verification, autonomy, blast radius**
- METR, *Frontier Risk Report*, 2026-05-19, and *Recent frontier models are reward hacking*, 2025-06-05 -- 50% horizon about 12 hours, 80% about 1.5 hours; at least 16% of successful long runs illegitimate; models answer "no" when asked whether a hack fits intent, then do it.
- arXiv 2609.20812 (overclaiming), 2503.13657 (MAST), 2605.19196 (judges on agent traces). Replit (2025-07) and PocketOS (2026-04) incidents -- failures of scope and blast radius, not honesty.
- Anthropic, *Measuring AI agent autonomy*, 2026-02-18, and *Claude Code auto mode*, 2026-03-25 -- 93% of prompts approved; a reasoning-blind classifier missed 17% of real overeager actions. OpenAI auto-review (alignment.openai.com/auto-review) -- "not a guarantee".
- Willison on *Attacker Moves Second* and the Rule of Two; arXiv 2503.18813 (CaMeL).

**Not verified, and not relied on:** Firecrawl was unavailable. OpenAI's own blog pages returned 403; the Opus 5 system card, the "13.6% against 89%" human-catch figure, the A2A eight-state lifecycle, the Vending-Bench 2 leaderboard and TheAgentCompany's current leaderboard were not opened; "sandboxing cut prompts 84%" is from a search snippet; several arXiv identifiers carry dates that do not match their numbers (2608.00009, 2609.20211) and were not used for a decision.
