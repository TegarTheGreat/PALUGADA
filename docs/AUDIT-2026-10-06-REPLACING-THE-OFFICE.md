# Audit 2: can PALUGADA replace an office and its staff?

Written 2026-10-06, before any change it recommends, as the second pass after
[the audit of 3 October](AUDIT-2026-10-03-ONE-MAN-COMPANY.md). Method: ten workers in
parallel. Five researched 2025-2026 practice on the web (harnesses and durable
execution; workspaces, computer use and human-agent work; memory and context
engineering; verification, goal pursuit and multi-agent systems; what evidence exists
for each office function, with an Indonesian slant). Five read the repository at
`b362391` without running anything -- the system as an organisation, the workspace, the
loop to outcomes, memory, and what exists per office function. What decided the plan
was then re-read in the code by the author of this file; those claims are marked
**checked**. A claim marked *audit* rests on a reader's reading of the code only.

Research pages were read through a summariser, so figures are as that summary reported
them; vendor figures are marked *vendor*; what could not be opened is under *Not
verified* at the end and is relied on nowhere. Model names in 2026 sources are as the
sources print them.

The question this time: the owner asked whether PALUGADA can be improved until it
replaces the office and all of its staff, and gave an estimate of how much of each
office function AI could replace. Section 6 tests that table against the evidence and
the code.

---

## 1. Diagnosis

Everything the first audit named as a bug or a missing wire is closed: all eight P0s
(the deadline an approval used to spend, the reviewers that were never asked, memory
that undid an owner's correction, goals closed against a metric that said otherwise,
`task.follow_up`, a resumed run's newest steps), and since then the owner's own list
(a model key refused in words, one code for a few minutes, a CEO that acts and speaks
first, office hours, invoices, budget resume, the language the owner reads). The
platform is now strong where 2026 evidence says it must be: a journal under every call,
a state machine, budgets reserved up a chain, approvals bound to the exact action,
taint that does not depend on the model, and goals no agent can close.

What stands between it and "an owner runs a company and the company keeps working":

1. **Humans are approvers and answerers, never workers.** A task has no assignee; a seat
   is a `viewer` or an `approver`; a question goes to the owner and comes back as a
   string. There is nothing to hand a person -- a brief, a deadline, a deliverable, an
   answer with a file in it. This is the one structural gap, and the one the owner's
   framing (humans as specialists called when needed) depends on.
2. **Nothing chases an outcome.** A goal's measure, due date and unpaid invoice are read
   for display and by nothing that wakes up. The weekly review, the only evaluator, is
   skipped in a quiet week -- which is exactly a stalled company.
3. **A deadline still kills work that waits for people or hours.** A delegated child
   parked for office hours, a coordinator waiting on a specialist who waits on the
   owner, a task the owner continues after a budget stop: each is halted
   `deadline_passed`. This contradicts "deferred, never refused" (2.150) and is the
   prerequisite of item 1.
4. **A stock install has no workspace.** `PALUGADA_FILES_ROOT` is set nowhere, so
   drafting, pictures, speech, vision and `code.compute` are unbound, and no shipped role
   holds the file tools.
5. **Memory has a lifecycle on paper and half of one in code.** A run is told no date,
   so "recorded 2026-03-04" cannot become an age; the pack has no relevance floor or
   horizon, so months of unrelated lessons compete for it and any one of them that came
   from outside content taints the run and sends the owner more approvals.
6. **The business verbs are catalogued and unbound.** Repo, deploy, DNS, payment, signing,
   calendar write, social posting, ads and code execution have names, tiers and tests,
   and nothing bound behind them on a stock install.

None of this needs a framework. Each can be closed with primitives that are there.

**On the owner's table.** Section 6 gives the numbers. The short answer: replacing "the
office and all of its staff" is the wrong target, and the evidence agrees. On the best
2026 measures of whole, real jobs, agents finish 15-21% (Remote Labor Index) and 8-43%
of company tasks by category (TheAgentCompany); on clean, fully specified deliverables
they win 80%+ (GDPval). The right target is a company in which one owner and a handful
of humans called in when needed cover everything, with the platform doing the volume.
For a text-and-knowledge micro-company that is credible for a majority of the volume of
coordination, research, content, support and back-office work; it is not credible for
negotiation, signing, tax filing, calls as the decision-maker, or anything physical --
and for those the answer is not "more AI" but a proper way to hand work to a person and
take the result back.

---

## 2. What is good and should not be changed

Each item is *audit* unless marked **checked**. The first audit's list stands; these
are the additions and the confirmations.

**The architecture is the one the 2026 evidence converges on.** A durable append-only
log, a stateless harness, a disposable sandbox: Anthropic's Managed Agents, OpenAI's
Agents SDK sandboxes and DBOS all describe it, and Temporal, Restate and DBOS all say a
Postgres step journal is credible for agents [H1, H2]. PALUGADA's journal, leases with
reclaim, reservation-before-work and credentials kept out of the runtime are that
design. Do not move to Temporal, and do not make a vendor's session store the system of
record: Managed Agents is beta, not ZDR-eligible, and provider-side compaction is state
no journal can replay [H1].

**The boundary is deterministic, not prompted.** Hard caps, taint, tiers, fingerprint-bound
approvals and the guardian are platform code. The 2026 papers on budget overruns (63
incidents in 21 frameworks), approvals that go stale (207 of 216 invalidated runs still
committed) and resumes that fire a gated effect k times [H3, H4] are about designs
without exactly this. **Checked** that approval resolution and lease reclaim are
single-winner, as the concurrent-resume paper asks.

**Review is a separate task with its own context.** The 2026 consensus is a worker and a
separate evaluator, with deterministic checks first and a model as triage -- never the
worker's "done" [H5]. PALUGADA's reviewer is an ordinary sub-task settled by state, and
a goal cannot be marked met against a measure that says otherwise.

**Depth one, a single writer.** Cognition's 2026 update, Google's scaling study and MAST
all say extra agents help only on decomposable or read-heavy work and that writing swarms
are a distraction [H6]. Hop depth three, fan-out five and the coordinator-and-specialist
shape are right. Do not add roles to add roles.

**Memory is lexical, curated and gated.** Letta's files-and-grep result, a Redis
reproduction (raw hybrid beat extraction-only) and SkillsBench (curated skills +16.6
points, self-written -8 to -11) all support Postgres full-text search, a candidate gate
for procedures and no graph or vector layer [H7]. Business state lives in tables and is
never distilled. **Checked.**

**Owner words are separate and a correction stays made.** GitHub's production memory
verifies a memory against the source at read time; PALUGADA's "memory is a lead, the
record is the truth" is the same principle.

**Credentials never reach a runtime; the browser has its own sealed jar and proxy;
`code.compute` has no network.** Anthropic's own guidance for computer use is exactly
this, and says injection through the screen is "not a complete solution" [H8].

**The owner is the authority and the CEO is a role, not a new abstraction.** The CEO
speaks first, acts on what was asked, and triages (2.144, 2.145, 2.157). Of the options
"new executive agent", "owner presses buttons" and "an existing role the platform pushes
work to", the third is right and is what exists.

---

## 3. What the research says that bears on decisions

Dates are publication dates. The full list is in section 10.

| # | Finding | Consequence for PALUGADA |
|---|---|---|
| H1 | The consensus shape is an append-only session log outside the model, a restartable harness and a disposable sandbox with credentials outside it (Anthropic Managed Agents, Apr 2026; OpenAI Agents SDK, Apr 2026). A Postgres-only step journal is mainstream (DBOS, May 2026), with honest limits: connection exhaustion, queue bloat, partition the journal. | Keep the design. Plan journal retention and size; journal large payloads by reference. |
| H2 | Exactly-once lives in the tool contract: models duplicate writes in 56-74% of redelivery episodes; idempotency keys cut it from 28% to 4% and "the harness barely matters" (LIMBO, Sep 2026). After a restore a model re-synthesises *different* requests (ACRFence, Mar 2026). | Keep deriving keys from (task, step) and journalling the exact request before executing. Never regenerate on reclaim. |
| H3 | Approvals go stale and fatigue: users approve ~93% of prompts (Anthropic auto mode, Mar 2026); a yes must bind to effect, argument hash and precondition version and be re-checked at execution (Jul-Sep 2026). | Already bound by fingerprint and spent before acting. The owner-load fix is fewer asks (deterministic clearance), not softer ones. |
| H4 | Compaction is a safety surface: constraints dropped by a summary rose violations from 0% to 30% (Governance Decay, Jun 2026); pin them outside the summary. | The context builder rebuilds charters, policy and the language rule from source each run. Keep that; never rely on a transcript. |
| H5 | "Done" is the most common false claim: 45-48% of tau2 failures and 75.8% of AppWorld's with self-assessing agents were false success; LLM judges reached 0.54-0.65 AUROC (Jun 2026). A strong judge that could see artifacts accepted 44% of real regressions (Jul 2026). Automated judging overstated frontier results 2.3-2.9x (RLI, Jul 2026). Most "gates" in 69 production loops were vacuous or self-attesting. | Only the platform's verdict moves state. A gate must fail on empty input and read from outside the agent's write scope. Goal progress is the *delta of a measured number*, read by the platform. |
| H6 | Multi-agent helps on parallelisable work (+80.9% finance, -39-70% sequential planning); independent agents amplified errors 17.2x versus 4.4x with an orchestrator; a same-model "CEO" added nothing in Project Vend while a differently scoped agent did; what works is review-in-clean-context, escalation to a stronger model, map-reduce (Cognition, Apr 2026; Google, Jan 2026; Anthropic, Dec 2025). | Roles earn their place by different information, tools or independence. No new executive layer. |
| H7 | Retrieval: lexical and hybrid are competitive; the real failures are temporal, knowledge-update and abstention (best model 55.2% on implicit conflicts, May 2026). Context rot: ~300 focused tokens beat ~113k (Chroma). Recall scores do not predict agent performance (MemoryArena, Feb 2026). Memory benchmarks are weak (6.4% of LoCoMo's key wrong). | Keep FTS, add a relevance floor and a horizon, keep raw text beside distilled facts, and measure memory by task outcome, not recall. |
| H8 | Memory poisoning is real (50 prompts from 31 companies, Microsoft Feb 2026); write-time checks fail on multi-record and dormant attacks; cap confidence by provenance; Anthropic advises read-only stores. | `outside` caps trust end to end already. The fix to the ratchet is relevance, not loosening it. |
| H9 | Human-agent systems that work make the human the *accountable assignee* and the agent a contributor: Linear (assignee human-only, delegate agent-only, states pending/active/awaitingInput/complete/error/stale), GitHub Copilot (the requester's approval does not count), Devin and Magentic-UI (explicit takeover and give-back; informed human help lifted GAIA 30.3% to 51.9%). Handoff by artifacts, not transcript, cuts resume cost 20-59% (Handoff Debt, Jun 2026). | A person is an actor with an addressee, a deadline, a structured answer and a give-back. The state vocabulary already in PALUGADA is enough. |
| H10 | Long-horizon business loops are still brittle: Vending-Bench 2's best run is about a quarter of a good strategy; RetailBench: "only a small subset survives"; Project Vend improved with bureaucracy -- checklists, a CRM, price checks -- and was still socially engineered by helpfulness. Goal drift is inherited from weaker agents' trajectories. | Re-state goal and measure on every run, never hand raw foreign trajectories on, keep checklists in skills and tools, and keep the owner on irreversible actions. |
| H11 | The estimates for real office work: GDPval 84.9% (one-shot, specified); RLI 2.5% at launch to 15.8-20.8% (Jul-Sep 2026) with no deliverable judged accepted as finished; TheAgentCompany 30-43% overall, finance 8%, admin 13%, software 38%, project management 39%; customer support the best evidenced at 40-76% (vendor-defined, and Klarna reversed itself). | Section 6. Quote category-level evidence with dates; never promise a function's percentage. |
| H12 | Computer use: OSWorld-Verified 83-86% but OSWorld 2.0 (long horizon) 44% binary; rerun reliability poor; API/connector first, GUI second, a human last. Prompt injection through the screen is unsolved. | Browser is already behind a proxy and per-act tier 2. Never make it the main path where an API exists. |
| H13 | Waiting is first-class everywhere (Temporal, Cloudflare, Restate, A2A `input-required`): the decision lives in the log, not RAM. Timeouts are durable, and a stall should mean reclaim and resume, never fail. | Same as H2; and see gap S1: a deadline that fires during a legitimate wait is the exception. |
| H14 | Hard caps must be platform-side; a model's budget is "a soft hint". 68 confirmed infinite loops in 47 of 6,549 repos; 63 budget overruns, 11 from delegation fan-out races. | Reserve-before-work with atomic debit is right; add per-step retry caps, repeat-signature loop detection, wall-clock limits and a *tested* kill switch (OpenAI's own sandbox's auto-kill failed for 2.5 hours, Sep 2026). |

---

## 4. Gaps, by area

Ranking inside each area is by leverage for the goal.

### 4.1 System / operating model

**S1. A deadline still kills work that waits for people or hours. NEW, checked.**
Only delegated children and follow-ups carry deadlines (a delegate defaults to 60 minutes,
at most 1,440). `haltPastDeadlines` halts any `pending` or `waiting_window` task past its
deadline (`checkout.ts:549`). The 2.142 give-back shifts the deadline only for a task that
itself waited for an approval or a review (`tasks.ts:863-878`). Three live paths hit it:

- **Office hours (2.150).** A closed-window park (`engine.ts:1666-1670`, `waitReason:
  'window'`) leaves the deadline alone, so a delegated child whose outward action falls
  outside the hours is halted -- a weekend is 65 hours and the delegate cap is 24. This
  contradicts "deferred, never refused", and `office-hours.test.ts` has no deadline case.
- **Ancestors.** A parent awaiting a child parks as `waiting_window`; only the task that
  *itself* waited is given its time back. A specialist waiting on the owner for more than
  an hour halts the coordinator above it; the owner's later yes still runs the action and
  nothing consumes the result.
- **Continue (2.155).** `continueHalted` leaves `deadline_at`, so a delegated child the
  owner raised the ceiling for is halted again by the next sweep.

A person's task is a long wait, so this is also the prerequisite of S4.

**S2. The owner is still the approval clicker. Checked.** Tier 2 in work that read
outside content asks every time (`broker.ts:614, 671`); a standing yes is policy-only,
and `clearsOutside` exists for `chat.send` alone. Approvals go straight to the owner and
expire at 72 hours into a silent `cancelled`, which neither the ended-badly sweep nor the
briefing reports. The fix is deterministic clearance per capability (ledger-grounded
sends, exact figures from the books), not a softer yes.

**S3. Agent questions are owner-only and dead-ended. Checked.** `owner.ask`,
`browser.handover` and key requests share one path; the card has no expiry, a "no" cancels
the task, so the `unanswered` state is dead code, and a cancelled task's question stays
open in the inbox.

**S4. A human worker, not an approver, has nothing today. Checked.** There is no
assignee anywhere in the migrations or `src`; seats are `viewer` or `approver` and see
the whole company with no "my work" view; no adapter is a person; an answer is a bare
string (1,000 characters, three per task); a child's result is cut to 2,000 tokens with a
pointer no agent can read; `artefacts` is declared and read by nothing; external events
cannot wake a waiting task (a customer reply joins only a `pending` one). **The existing
primitive suffices if four things are added** (section 8.2): an addressee on the question,
an answer that can carry a file, expiry that escalates, and a thin `person` adapter. No
new work-item type is needed.

**S5. The owner is still the dispatcher. Checked.** The stock company ships no schedule;
heartbeats only claim tasks that already exist; goals start nothing. Priority is dead
machinery: `/assign` ignores it, `createSubTask` does not inherit it, a ticket's priority
is dropped -- the urgent place can never receive work.

**S6. Escalation is mostly owner-direct. Checked.** Of roughly nine raisers only the
ended-badly sweep asks a coordinator first. Stranded tasks, crash-loops, unreadable
reviews, questions and approvals go to the owner. A coordinator task that merely
*completes* withdraws the card it was asked about.

**S7. The new code has visibility holes. Checked.** A follow-up that halts is silent
(`findEnded` takes root tasks only and a follow-up is always a child). A root task that
asked a question and later failed is never reported. There is no signal for a `pending`
task nothing can claim.

### 4.2 Workspace ("meja kerja")

The first audit's design call holds -- the journal is the truth and the run directory is
disposable; do not add a per-agent persistent desk -- and so does its finding that
linkage, reachability and defaults are open.

**W1. A stock install has no workspace. Checked.** `PALUGADA_FILES_ROOT` appears in no
compose file, Dockerfile, `.env.example`, setup script or installer, so `files.*`,
`doc.draft`, `email.draft`, pictures, speech, vision and `code.compute` are unbound. The
owner cannot fix it from the console, which shows a boolean. Even with a root, no
standard or bundled role holds `files.read` or `files.list`: the 12-tool limit, with five
slots taken by the platform tools, is the cause.

**W2. Files cannot be reached by people and nothing ingests them. Checked.** No owner or
staff route reads, uploads or deletes a file; the gallery SQL needs `path` plus `text`, so
pictures, audio and computed files never appear; inbound mail and chat attachments are
"[sent a photo, which cannot be read here]"; mail is plain text and cannot attach.

**W3. A cross-task successor has no read path. Checked.** `task.await` reads only the
caller's own children; a long result is "kept on task X, where the owner reads it" -- a
pointer no agent can follow; `followUpOf` is written and read by nothing, so a follow-up
woken 30 days later has only its brief text.

**W4. A successor's pack shows results without their questions. Checked.** The working
memory selects `name, output` only; `tasks.plan` is never rendered; for in-process runs
the model turns are listed in the pack *and* replayed by the loop.

**W5. Context exhaustion is unhandled in the default runtime.** No "too long"
classification; the model is never told its turn budget; a failed turn replays the same
journal and fails the same way three times.

**W6. Retention versus continue (inferred).** `scrubExpiredJournal` blanks finished
tasks' model turns at 90 days; `continueHalted` has no age guard, and continue-all makes
the case likelier; replay then reads `undefined`.

**W7-W9.** Files list in `readdir` order with a 500 cap, drafts all flat in one folder,
media names random so a replay re-pays the provider; any file read taints the reader
because "nothing records which" (the journal does); a CLI-to-in-process switch mid-task
halts on divergence; a browser handover keeps the sign-in but not the tabs.

### 4.3 Looping to outcomes

The four levels, as the code has them: **action executed** (a journalled step plus a
read-back at tier 1 and up) is mechanical; **deliverable verified** is the read-back
plus a done-criteria check that passes uncited evidence as "claimed", and review only
where a policy demands it (none ships); **outcome observed** is a metric observation
nothing ties to an action; **goal achieved** is the owner's, and nothing computes it.

**L1. Nothing looks at a goal's number, due date or payment. Checked.** The worker's
tick has no goal or metric stage. `goal_metrics.due_on`, `invoices.due_date` and
`deals.expected_on` are read for display. The one evaluator, the Monday review, is
*skipped* when the week had no work (`weekHadWork`), which is what a stalled company looks
like -- and a measure that is overdue counts for nothing.

**L2. A follow-up that ends badly is silent. Checked.** See S7.

**L3. Most actors cannot ask to look again.** Only the coordinator and the ops division
hold `task.follow_up`; the bookkeeper, marketer and builder are at the 12-tool limit, and
the bookkeeper's prompt never mentions it, so "after `invoice.issue`, look at the due
date" is possible for nobody who issues invoices.

**L4. An escalation closes on action, not outcome. Checked.** The card is withdrawn when
the handling task is merely `completed`, and a withdrawn card counts as "told", so a
still-failed root task is never reported again.

**L5. The closure gate is thin. Checked.** It reads only measures directly on that goal
(an objective whose key results carry the numbers is unguarded), reads only the latest
value and ignores its age, passes a never-read measure, and omits the date from the card.

**L6. `verified` is weak. Checked.** It means any number anywhere in a same-task source
call's output; `metric.record` is not scoped to the goal's chain; `sourceCapability` is
never validated, so a typo means permanent UNVERIFIED. The catalogue has no payment-read.

**L7. Reporting shows effort, not outcome. Checked.** The briefing and the digest have no
measure line; the goal bar is the share of tasks done and turns teal at 100%. The first
hour never asks "what number says this works".

### 4.4 Memory and organisational learning

Closed since the first audit, **checked**: an owner's correction stays made; one task's
near-identical lessons count once and a task cannot reinforce its own; facts carry
`recorded <date>`, the pack says the record wins, and the lesson prompts stopped asking
for prices and balances; contacts, deals, books and invoices are never distilled.

The lifecycle today: *birth* as at most five lessons per completed task (500 characters,
0.5), hourly distilled facts, one episode per task (never in the pack), one decision fact
per review, owner words at 1.0; *use* as the pack's slots (5 owner facts, 10 others, 5
ways, 10 procedures); *reinforcement* by exact normalised text, +0.1 to 0.8, two pieces of
work make a fact "Known"; *decay, expiry, forgetting*: none; *contradiction*: exact text
only; *supersession*: the owner's alone.

**M1. No run is told today's date. Checked.** Neither `renderSystem`, `renderTask` nor
`buildContext` contains one, so "recorded 2026-03-04" cannot be turned into an age and
the one mitigation P0-5 added does little for the in-process runtime.

**M2. The pack has no relevance floor and no horizon. Checked.** `recall(relevantTo)`
only *orders*; there is no match predicate, so the newest unrelated facts fill the
slots, `to_tsvector` is computed for every in-scope row on every build (the index cannot
help; cost grows with months of lessons, *inferred*), confidence is not in the order, and
an eight-month-old unverified lesson that shares two words with the task outranks a newer
one. `last_reinforced_at` is written and never read.

**M3. A taint ratchet inflates the owner's approvals.** Any `outside` memory in the pack
writes `content.read_outside` (`engine.ts:403-407`, **checked**), which taints the whole
run, whose lessons then become `outside`, and the distiller flags every fact in a 500-event
window if any one task in it was tainted; the flag only goes up. In a mail or support
division most unrelated runs end up tainted, so tier-2 actions ask the owner. M2 is what
spreads it. This is the owner's "too many approvals", reached from memory.

**M4. `learn()` can downgrade an owner's fact. Checked.** The match has no `source`
filter. An agent restating an owner's division-scoped "Tell" from tainted work raises
`outside` on the owner's row and bumps its count; the owner's word becomes "from outside
content", wrapped as data, and taints runs. Only a supersede is protected.

**M5. Customer-specific lessons leak across customers.** Both lesson prompts ask for "how
a customer or a supplier likes to be dealt with", and lessons are division-scoped; since
2.138 per-customer facts belong in `crm.note`. Instead they are injected into runs for
every other customer in the division.

**M6. Review-decision facts flood the pack.** One per review, up to 4,000 characters, 0.5,
no dedupe, competing with lessons; `fact_kind='decision'` is shown to no agent.

**M7. Distiller defects. Checked.** `parseFacts` is a bare `JSON.parse`, so a fenced reply
leaves the watermark stuck and the same growing window is sent to the model every hour; a
throw in one division aborts the rest (`worker.ts:1003`), starving later divisions behind
a failing earlier one; the corpus is a deny-list of three event types; distilled rows have
no `source_task_id`, so the same-task echo guard does not apply.

**M8. Procedure candidates.** They count tool calls, not tasks, since the beginning of
time; are written without `outside` although the model read tainted summaries; and the
rejection clock is the candidate's creation, so recurrences during the wait count again.

**M9. A phantom backlog after the 14-day card expiry (2.146's follow-up). Checked.** An
expired card leaves its memory `candidate`; the Memory page and the digest count every
candidate, so they say "waiting for your yes, open the inbox" and the inbox is empty.

**M10. No evaluation of memory or skill quality.** Nothing records which memories a run
was shown, so "memories used, then success" cannot be computed; skills have no retire path
and every active skill's summary ships in every run.

**What is not memory and stays so.** Tables are the source of truth for contacts, deals,
books, invoices, metrics and task state; the only guard against a lesson restating a
price is prompt wording, and a stale lesson is ambient and free while the record costs a
tool call.

### 4.5 Other gaps the brief did not name

**O1. Verbs without bindings.** On a stock install repo, deploy, DNS, payment, signing,
calendar write, social, ads and `code.execute` are catalogued and unbound. Only seven
vendor entries ship (`email.send`, `dns.read/update`, `invoice.issue` as Midtrans,
`social.publish` on Mastodon, `metrics.read` on Plausible, `calendar.read`). Every agent
CLI runtime is stripped to broker tools: no shell, files or web. The shipped
`palugada-dev` engineer's done criterion is "`npm run check` passed" and nothing can run it.

**O2. Two traps in what ships.** The Midtrans example is named `invoice.issue`; the
books-backed `invoice.issue` is a *fallback*, so connecting it silently replaces ledger
invoicing with a QRIS charge that records nothing in the books. The shipped lab analyst
holds `code.execute`, which no capability wraps (the reachability test's comment says it
"needs somebody's account"; the sandbox is local), so it cannot work out of the box.

**O3. Files and money rails.** No attachments in or out of mail or chats; no calendar
write; no bill or payable object, no bank-statement import or reconciliation; `invoice.issue`
only writes a row (never rendered or sent); one invoice tax rate; no input VAT,
withholding, payroll or period close.

**O4. Telephony and meetings.** `speech.*` works on files; nothing joins a call or a
meeting.

**O5. Documentation that is wrong.** `features.md` says code-executing capabilities can
never hold a credential or reach tier 2 (false: `code.compute` is granted beside tier-2
`invoice.issue`), says "every reply is a tier 2 card" (omits the answer-alone path), is
titled "Everything that is built" without saying what is unbound, and files invoices and
office hours under Scheduling. `claude-code.ts` says the adapter "has never been run
against the real binary" (checked-versions says otherwise).

**O6. No second reader.** Nothing makes a person other than the owner a first-class
reader of the platform's notices: seats have no push or Telegram path.

---

## 5. Assumptions in the brief that the evidence does not support

1. **"Replace the office and all of its staff."** The measures of whole real jobs say 15-21%
   (RLI, human-graded, Jul-Sep 2026) and 8-43% of company tasks by category; the high
   numbers are one-shot specified deliverables, which GDPval's own authors say exclude
   iteration and oversight. Support is the best case and is vendor-measured (and Klarna
   reversed). A product that promises a function's percentage will be wrong in the
   direction that costs an owner money. The achievable and valuable target is "volume
   handled, human tail handled well".
2. **"Agents need a durable workspace."** They need a *self-describing task* and a
   *working default*, not a new desk. State lives in the journal; vendors' sandbox lifetimes
   differ (E2B indefinite, Modal 7-30 days, Cloudflare none) and must not be the platform's
   durability layer [H1].
3. **"Separate memory kinds."** The existing kinds are enough; what is missing is dating,
   relevance, expiry and measurement. More categories would add surface without evidence.
4. **"More agents."** Against the evidence [H6]. A second same-model "manager" adds
   nothing; a differently scoped role with its own tools can.
5. **"Computer use as a main path."** API or MCP, then a browser with a persisted profile,
   then pixels, then a person [H12].
6. **"A loop that continues until the goal is met."** The evidence is against an
   autonomous loop on its own say-so (self-reported progress is wrong more often than not,
   [H5]); the stable form is event-driven continuation off *platform-read* state with every
   bound that already exists (hop three, five open follow-ups, budgets, owner cancel).
7. **"Humans are an exception."** Humans are the one actor the system cannot yet model.
   Treating them as approvers is why tax filing, signing, physical work and calls look
   unreachable in the table: they are not "AI-impossible", they are "no handoff object".
8. **"Accounting and tax should be native."** In Indonesia filing goes through Coretax,
   signed with the taxpayer's Kode Otorisasi DJP, and acting as someone's representative
   needs a licensed konsultan pajak. No vendor autonomously signs returns anywhere; all stop
   at draft or review. The right design is bookkeeping and tax *drafts* in the platform,
   signing by the owner, a konsultan when needed.
9. **"Do not add workarounds for today's models."** Right, with a corollary the evidence
   adds: harness assumptions go stale in months (Anthropic's context-reset fix was "dead
   weight" on the next model). Journal the harness, prompt, model and effort version per
   step so a quality change can be traced.

---

## 6. The office table, tested

"Share handled with no human edit, in a one-person company where the owner approves
outward tier-2 actions and a person handles what law or physics requires." The owner's
range is theirs; *evidence* is the research; *code* is what exists today; *mine* is the
author's judgement and is wrong in places -- the point is the reasoning, not the digit.

| Function | Owner's | Evidence | Code today | Mine (today / with the P1s) | Best single addition |
|---|---|---|---|---|---|
| Coordinator / chief of staff | 80-95% | Routing, triage, follow-ups and briefs credible; TheAgentCompany project management 39%; priorities and commitments stay human | CEO that acts and speaks first, delegate/await/follow_up, escalation, cadence, office hours; **no calendar write**; CEO has no mailbox | 55-75 / 70-85 | Calendar write (`calendar.hold`) |
| Research / analyst | 75-95% | 60-80% as a cited draft; 45% of assistant answers had a significant issue (EBU/BBC) | web.fetch, browser.read, files.read, knowledge, image.describe; web.search needs a provider; shipped analysts hold almost nothing | 60-80 / 70-85 | Fix the shipped researcher and analyst's tools |
| Software development | 70-90% | 50-70% of tickets when tests exist; METR's horizon claims flagged unreliable above 16h | repo/deploy catalogued and unbound; runtimes have no shell; the dev engineer's own done criterion is unreachable | 10-30 / 50-70 | GitHub MCP with read-backs + CI webhook under `repo.*` |
| Content / marketing ops | 60-85% | 60-80% production; 30-50% with ad-spend decisions; platform policy and AI-disclosure rules | doc.draft (Markdown only), email.draft, image.generate, speech.synthesize, crm.*, Mastodon, Plausible; **no files root by default** | 50-75 / 60-80 | Files root on by default; PDF/DOCX output |
| Routine back-office | 60-85% | 60-80% when rule-bound with an exception queue; best ROI in MIT NANDA | files, tickets, cron, browser.read/act, mailbox.read; **attachments neither in nor out**, downloads denied | 40-65 / 60-80 | Attachments in and out |
| Text customer support | 60-80% | 50-75% where scoped and escalating; Fin 76% (vendor-defined); Salesforce ~50%; Klarna reversed; WhatsApp bans general assistants since Jan 2026 | Telegram/WhatsApp/IMAP channels, grounded self-answer with a model check and a rate limit; cannot initiate; photos and voice unreadable | 30-50 / 50-65 | Inbound attachments readable (image.describe, speech.transcribe) |
| Finance administration | 35-60% | 60-80% invoicing, reminders, matching; 0-20% unattended payment | books, invoices (gapless, part-payments, void, overdue); **no payables, no bank import**; `invoice.pay` unbound | 35-55 / 60-75 | Payables + CSV bank reconcile; invoice rendering |
| Sales development | 35-60% | 20-40%; 11x "performed significantly worse"; LinkedIn scraping suits | contacts/notes/deals, web.search, email (tier 2, 20/h); every cold mail is an owner card | 20-40 / 30-45 | Calendar booking; grounded clearance for templated sends |
| Account management / negotiation | 20-45% | 10-25%; weaker agents lost up to 14% of profit and one agreed $900 for a $500 phone (Stanford) | responder forbids commitments; no quotes, contracts, e-sign | 10-25 / 15-30 | Quote/contract documents + an e-sign vendor |
| Accounting + tax | 20-40% | Bookkeeping 80-90% for a simple entity; tax computation/draft 60-80%; filing and signing human; no vendor signs returns | generic ledger; one tax rate; nothing in `src` for tax, payroll or assets | Bookkeeping 60-80 (no bank feed); tax 0 / 40-60 for drafts | Bank feed + a real accounting/tax system under `ledger.*` |
| Meetings / phone / synchronous | 10-30% | 40-60% scripted or inbound calls (best voice agent 67% vs ~85% text); ≤10% as decision-maker; consent and disclosure rules | `speech.*` on files only; nothing joins a call | 0-5 / 30-50 scripted | Telephony vendor + recordings uploaded |
| Physical | 0-15% | Deliveries 80-90% through courier APIs (Biteship, GrabExpress); the rest 10-30%; agent-hires-human marketplaces are immature (RentAHuman: 518k humans, ~1,000 tasks) | nothing but `owner.ask`, tickets and email | 0-5 / deliveries 70-90 | A human work item (section 8.2) |

Reading the table: the owner's top three rows are slightly high or right *for the
platform once its defaults work*, and too high for what is bound today; software
development is the largest gap between claim and code; the bottom four rows are low
because of *handoff*, not capability. The single most valuable thing across the table
is not a model or a capability: it is a way to give a person work.

---

## 7. Ranked plan

Ranked by dependency first, then impact, reliability and benefit to the goal. A change is
P0 only if confidence is high and the blast radius small.

### P0 -- bugs and wiring with high confidence (done in this change; section 9)

1. **A deadline is for the work, not for the waiting** (S1, three places): parks for office
   hours and rate limits give back what they waited; a parent awaiting a child is not
   halted before the child's own deadline; a continued task is given back the time it was
   stopped. Prerequisite of every long wait, human or not.
2. **No outcome fails silently**: a follow-up that ends badly is reported (L2); the
   weekly review runs when the company has measures it has not reached (L1, in part).
3. **Memory is dated, bounded and safe**: every run is told today's date and the search
   returns an age (M1); an owner's fact is never touched by an agent restating it (M4); the
   pack takes only what matches the task and is recent, the rest stays searchable (M2, M3);
   the distiller reads fenced replies and one division cannot starve the rest (M7); the
   Memory page and the digest count only what has a card (M9).
4. **A workspace by default** (W1): the Compose deployment sets a files root on its
   persistent volume, and a configured root is created at start.
5. **Documentation that is wrong** (O5).

### P1 -- real design needed; build next, in this order

1. **A person is an actor** (S4, S3, O6; section 8.2). An addressee on a question, an
   answer that carries a file, expiry that escalates, a thin `person` adapter, a seat's
   own-items view. Needs S1 (done) and W2's file route.
2. **Close the loop on outcomes** (L1, L3-L7; section 8.1). A deterministic outcome
   sweep; actors that can look again; the closure gate rolling up and dating; sources
   validated; a measures line in the briefing; the first hour asks for the number.
3. **Workspace linkage** (W1-W5): the file tools on the roles that need them; a task
   brief that says where it stands ("plan, paths made, children, last steps"); `task.await`
   returns the child's files; a follow-up reads its parent; the loop states its turn budget
   and elides old tool results.
4. **Files in and out** (O3, W2): attachments stored in the company's files so the existing
   readers work; SMTP attachments; PDF invoice rendering; an owner download and upload route.
5. **The development loop** (O1): the GitHub MCP preset under `repo.*` names, CI results
   through the existing trigger; fix the dev bundle's unreachable criterion.
6. **Calendar write** and booking links (O1).
7. **Payables and a bank-statement reconcile** (O3), with a disbursement vendor entry at
   tier 2 or 3; Indonesian rails (Xendit, SNAP bank APIs) as vendor entries.
8. **Deterministic clearance beyond chat** (S2): ledger-grounded sends -- reminders,
   statements -- with exact figures, cleared the way a grounded chat reply is. Highest
   leverage on the owner's load and the highest injection risk: last.
9. **Memory measurement** (M10): record which memories a run was shown; one weekly query
   joining them to task outcome; episodes for failed tasks; a retire path for skills;
   `addedOn` on document passages; near-duplicate linking with `pg_trgm`.
10. **Priority plumbing** (S5), **questions that expire or are withdrawn** (S3), **poll
    backoff** for `task.await`, **traps in what ships** (O2).

### P2 -- later, or only if a real need appears

Indonesian tax drafts through a PJAP and Kode Otorisasi DJP by the owner; telephony and
meeting attendance; courier APIs; a human-labour marketplace bus (Upwork's own agent
route still says "not today" for hiring without the owner); a mandate-based approval
gateway; a hash-chained gate ledger; journalling harness/prompt/model/effort version per
step.

---

## 8. The big changes, set out

### 8.1 Close the loop on outcomes (P1.2)

*Problem.* The system can say "action executed" and "deliverable verified"; it cannot say
"the number moved" or "the invoice was paid", and nothing wakes up to look.

*Why today is not enough.* Goals are context; measures are for display; the review is
skipped when quiet; a follow-up is the only time-keyed thing and only some roles can
make one.

*Alternatives.* (a) An autonomous goal loop: refused -- self-reported progress is wrong
more often than not [H5], and it is the unbounded loop the brief rules out. (b) An
LLM outcome judge: refused for the same reason. (c) An expectation ledger or workflow
DSL: no need, the primitives exist. (d) Make the strategist's heartbeat create work:
refused -- heartbeats only claim existing tasks and should stay that.

*Chosen.* The owner's measure (unit, target, `due_on`, `source_capability`) is the
durable reason to look again. The platform computes, in SQL, three states per active
measure: *reached* (the verified latest crosses the target, direction-aware), *overdue*
(`due_on` past and not reached) and *stale* (a source set and the latest older than seven
days or absent). Each *change of state* makes one CEO task through the triage pattern
(keyed `outcome:<hash>`, none when nothing is owed, no model call when idle). The CEO
delegates the re-read to the role that holds the source capability, `metric.record`
verifies against the same-task call, `owner.ask` at *reached* and *overdue*, `follow_up`
for lagged effects. Only the owner closes a goal; closure already pauses schedules and
cancels follow-ups. Stop conditions all exist: goal closed, hop three, five open
follow-ups, budget, `due_on`, owner cancel.

*Risk.* Cost: one CEO run per state change, bounded by the key. Injection: the brief is
platform-written English; readings come through `metric.record`'s verification.

*Migration.* None (a function and a worker stage); the stock company's first hour gains a
sentence.

*Test.* Mirror `ticket-triage.test.ts`: a measure that crosses its target raises one
task; the same state again raises none; a closed goal raises none; an idle company
spends nothing.

### 8.2 A person is an actor (P1.1)

*Problem.* Physical, legal, licensed, relationship and synchronous work has no handoff
object; the owner is the only person the system can address and the answer is a string.

*Why today is not enough.* No assignee; a seat is a viewer or an approver and sees
everything; no adapter is a person; the answer cannot carry a file; a question never
expires; a task parked for a person dies of its deadline (S1).

*Alternatives.* (a) A new "human task" type with its own lifecycle: refused -- it would
duplicate the state machine, approvals, journal and budgets, and the reviewer-as-a-task
design already shows the work shape is neutral. (b) Treat a person as a runtime: this is
the right idea, narrowed -- a `person` adapter that *raises the ask* and maps the answer
to the role's output schema. (c) Email the person: refused as the whole design (Copilot
Studio's first-responder-wins had no identity, claim or SLA).

*Chosen.* Four small changes on the existing question primitive: an **addressee** on the
card (a seat, or the owner); a **seat filter** for "my work" and answer rights limited to
the addressee; an **answer** that can carry a file (stored under the company's files and
named in the output); **expiry that escalates** to another seat and then the owner
instead of cancelling. A role bound to the `person` adapter then *is* a contractor: its
brief is the task's input, its deadline is the task's (given back while it waits, S1),
its deliverable is the answer. Humans stay accountable assignees; the agent that
delegated is the contributor, the way Linear and GitHub model it [H9].

*Risk.* Identity and consent for third parties (a seat needs a TOTP app today); abuse and
payment for marketplace workers, which is why marketplaces are P2.

*Migration.* One migration for the addressee and the answer's files; seats unchanged.

*Test.* A question addressed to a seat is answerable by that seat only, not by another; an
unanswered one escalates once; an answer with a file lands in the company's files and in
the task's output; a task parked for a person is not halted by its deadline.

### 8.3 A deadline is for the work, not for the waiting (P0, done)

See section 9.1.

### 8.4 The pack takes what matches and is recent (P0, done)

*Problem.* The pack is bounded in tokens but not in noise: unrelated and old lessons
fill the slots, any of which taints the run (M2, M3).

*Alternatives.* A vector or graph layer (refused: the evidence does not support it and
the embedding column has no producer); a model consolidator (refused: no evidence it
improves quality, and it adds a cost that scales with history); deletion (refused:
supersession keeps history, and F4.3 wants "true then versus now").

*Chosen.* A relevance predicate and a horizon in `recall` for the pack's non-owner
calls only. A row is in the pack when it matches the task's terms *and* was recorded or
reinforced within 90 days (an owner's word is exempt). Everything else stays searchable
through `memory.search`. It adds a WHERE clause, so it costs nothing when idle, needs no
migration, and finally reads `last_reinforced_at`.

*Risk.* A relevant old lesson drops out of the pack. It is still one search away and the
pack's note says so. The horizon is a constant, not a setting.

*Test.* An unrelated fact and an old unverified one are absent from the pack and present
in a search; an owner fact is exempt; a matching recent lesson is present; the run's
taint is unchanged by an absent `outside` memory.

---

## 9. What was implemented

Only P0 items whose defect was checked in the code, each with its test written first and seen to
fail, each in its own commit with its own STATUS entry. Nothing here adds an abstraction; every one
uses a primitive that was there.

| P0 | Change | STATUS |
|---|---|---|
| 1 | A park for a closed window, a vendor's limit or a replaced key gives the wait back; a parent awaiting a child carries its deadline to the child's, and past a wait for a person; a continued task has its stopped time back (S1) | 2.158 |
| 2 | A follow-up that ends badly is reported like any root task that does; the weekly review runs in a quiet week when a measure has not reached its target (L1, L2) | 2.159 |
| 3 | Every run is told today's date and a search says a fact's age; the pack takes what is recent and an outside lesson only when it is about the task; an owner's fact is never marked outside by an agent restating it; the distiller reads a fenced reply and one division cannot stop the rest; candidate counts follow open cards (M1-M4, M7, M9) | 2.160 |
| 4 | A files root by default in Compose, made at start, said when it cannot be (W1) | 2.161 |
| 5 | `features.md`, `AGENTS.md` and two comments say what is true (O5) | 2.161 |

**Considered and left for P1, on purpose.** The outcome sweep (8.1) and the person-as-actor change
(8.2) are the two largest and need design review with the owner; the file tools on shipped roles
need a decision on the twelve-tool limit; memory measurement needs a place to record what a run was
shown; the priority plumbing and the questions that never expire are bugs of the same class but touch
the claim path and the inbox's lifecycle, and deserve their own change and their own full run.
**Left alone because the evidence says so**: the journal, the state machine, tiers, approvals,
the taint, the owner-only goal closure, lexical memory, the 90-day horizon being a constant, and
every "no new abstraction" in section 5.

## 10. Sources

Grouped by the finding they support. Dates are publication dates.

**[H1] Harness and durable execution.** Anthropic, *Scaling Managed Agents* (2026-04-08,
anthropic.com/engineering/managed-agents); OpenAI, *The next evolution of the Agents SDK*
(2026-04-15); DBOS, *Postgres is all you need for durable execution* (2026-05-20) and
*New in DBOS, July 2026*; InfoQ, *Durable workflows on Postgres* (2026-09-14); Temporal,
*Durable, flexible multi-agent systems* (2026-08-06) and Replit's case (2025-09-15);
Anthropic, *Effective harnesses for long-running agents* (2025-11-26) and *Harness design
for long-running apps* (2026-03-24); Cognition, *Multi-agents working* (2026-04-22);
OpenAI DevDay recap (2026-09-29).

**[H2-H4] Idempotency, resume, approvals, compaction.** arXiv 2609.29095 (LIMBO),
2603.20625 (ACRFence), 2608.03836 (*Resume Means Resume*), 2607.10487 and 2609.31490
(stale approvals), 2606.22528 (*Governance Decay*), 2606.04056 (budget overruns),
2607.01641 (infinite loops); Anthropic, *Claude Code auto mode* (2026-03-25) and *How we
contain Claude* (2026-05-25).

**[H5] Verification.** arXiv 2606.09863 (false success), 2607.25152 (*progress mirage*),
2606.10315 (a production judge), 2609.02246 (PROCTOR), 2609.27871 (vacuous gates);
Anthropic, *Demystifying evals for AI agents* (2026-01-09) and Managed Agents *Outcomes*
docs; METR on reward hacking (2025-06-05); CAIS, *Remote Labor Index* update (2026-07-01).

**[H6, H10] Multi-agent and long horizons.** Anthropic multi-agent research system
(2025-06-13); Google Research, *Towards a science of scaling agent systems*
(2026-01-28; arXiv 2512.08296); MAST (arXiv 2503.13657); Anthropic Project Vend 1 and 2
(2025-06-27, 2025-12-18); Andon Labs Vending-Bench 2; arXiv 2603.16453 (RetailBench),
2603.03258 (inherited goal drift).

**[H7, H8] Memory.** Letta, *Benchmarking AI agent memory* (2025-08-12) and *Context
Repositories* (2026-02-12); Redis agent-memory benchmark report (2026); Chroma, *Context
rot* (2025-07-14); Anthropic, *Effective context engineering* (2025-09-29) and memory-store
docs; GitHub, *Building an agentic memory system for Copilot* (2026-01-15); arXiv
2605.06527 (STALE), 2602.16313 (MemoryArena), 2602.12670 (SkillsBench), 2512.16962
(MemoryGraft), 2607.14651 (MemPoison), 2510.04618 (ACE); Microsoft Security, *AI
recommendation poisoning* (2026-02-10).

**[H9, H12] Workspace, computer use, humans.** Linear, *Agents in Linear* and the agent
interaction docs (SDK launched 2025-07-30); GitHub Copilot coding-agent review docs;
Devin session-tools docs; Microsoft Magentic-UI (2025-05-19; arXiv 2507.22358); Co-Gym
(arXiv 2412.15701); *Intelligent AI delegation* (arXiv 2602.11865); E2B, Modal, Daytona
and Cloudflare sandbox persistence docs; Anthropic computer-use and secure-deployment
docs; OSWorld-Verified and OSWorld 2.0 leaderboards (2026-08, 2026-10-02); Handoff Debt
(arXiv 2606.02875).

**[H11] Office work.** OpenAI GDPval (2025-09-25; arXiv 2510.04374) and the GPT-5.5
announcement (2026-04-23, vendor); Scale/CAIS Remote Labor Index (arXiv 2510.26787);
TheAgentCompany (arXiv 2412.14161); Anthropic Economic Index (2026-01-15); Crisp, *State
of AI support* (2026); Fin benchmarks (vendor); Klarna reversal (Entrepreneur,
2025-05-09; TechCrunch, 2025-06-04); Salesforce (Fox Business, 2025-09-03); EBU/BBC news
integrity study (2025-10-21); Digits' accountant benchmark (2026-06-04, vendor); Pilot and
Basis (CPA Practice Advisor, 2026-02); Sierra tau-voice (2026-05-01); Upwork's MCP page
(2026-08-04); Biteship, GrabExpress and GoSend API pages; Indonesian tax sources
(pajak.go.id on Kode Otorisasi DJP and the konsultan pajak profession; PP 20/2026).

**Not verified, and relied on nowhere.** Gartner's cancellation and workforce
predictions; Intercom and Salesforce resolution ranges beyond Fin's own page; Sierra and
Decagon ranges; the AI-SDR churn figures; Ramp, Puzzle and Rillet accuracy claims; vendor
DSO and ad-performance claims; PMK 55/2026 contents; any Indonesian rule on AI calls (none
found, and the AI presidential regulation is unsigned); the claim that e-Faktur was
retired on 31 December 2025 (one source); the exact release date of GPT-5.5; MCP SEP-1686
and A2A v1.0 dates (snippets); OpenAI's agent-takeover documentation (403); several
2606-2609 preprints read through abstracts only; leaderboard scores that are
self-reported; the Co-Gym situational-awareness figure (40% or 80% by source) and the
OSWorld 2.0 figure (44.33% on the leaderboard row versus about 31% in the page's
description).
