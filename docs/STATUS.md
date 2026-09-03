# Status against PRD v2.0

PRD v2 replaces v1. The previous document is kept at
[`PRD-v1.md`](PRD-v1.md) because roughly two hundred tests and most code
comments cite its numbering, and a reader following a citation needs to be able
to resolve it.

This file says three things: which identifiers changed meaning, what is built
against v2, and what has to be decided before the v2 roadmap can proceed.

## 1. Identifiers that changed meaning

Most numbers are stable between v1 and v2, or v2 is a superset. Three are not,
and a citation left alone would now point at a different requirement.

| Citation | v1 meaning | Where that requirement lives in v2 | What the number means in v2 |
|---|---|---|---|
| `F2.5` | Organisation template: create a company from a template | `F16.3` (a company from bundles), with `F1.1` for "without a redeploy" | No built-in C-level titles; templates provide functional roles |
| `F2.6` | A role sees at most 12 tools | `F2.4` (tool subset ⊆ division grants, ≤ 12 per run) | A role can be created from a Bundle |
| `F4.7` | Memory confidence surfaced to the agent | `F4.1` (every item carries `confidence`) and `F4.5` (low-confidence facts are flagged) | Working memory survives across heartbeats and restarts |

The citations in the code have been updated to v2. Nothing about the behaviour
changed — the work those numbers described is still there, and still tested.

One of them is worth noticing rather than filing away: v1's `F4.7` was
implemented and v2's `F4.7` is a different, unbuilt requirement, so the same
number now reads as done and is not.

## 2. What is built

Assessed requirement by requirement against v2 section 8. "Partial" always says
what is missing rather than leaving the reader to guess.

| Group | Built | Partial | Not built |
|---|---|---|---|
| F1 tenancy, budget | F1.1–F1.9 | — | — |
| F2 organisation | F2.1–F2.9 | — | — |
| F3 charter, policy | F3.1–F3.12 | — | — |
| F4 memory | F4.1–F4.8 | — | — |
| F5 engine | F5.1–F5.14 | — | — |
| F6 agent communication | F6.1–F6.7 | — | — |
| F7 adversarial review | F7.1–F7.7 | — | — |
| F8 broker, tiers | F8.1–F8.13 | — | — |
| F9 scheduler | F9.1–F9.10 | — | — |
| F10 owner surface | F10.1–F10.4, F10.6–F10.8, F10.11 | F10.5 (the rule is enforced; there is no push channel), F10.10 (a tier 3 approval is refused over a chat channel; MFA needs an app) | F10.9 |
| F11 observability | F11.1, F11.3–F11.7 | — | F11.2 (no owner PWA, so no live run view) |
| F12 credentials, gateway | F12.1–F12.4, F12.7–F12.10 | — | F12.5 |
| F13 runtime adapters | F13.1, F13.2, F13.4–F13.8 | F13.3 (the wire protocol is open and documented; no `hermes`, `codex` or `gemini-cli` adapter is written) | — |
| F14 lifecycle hooks | F14.1–F14.4 | — | — |
| F15 skills | F15.1–F15.8 | — | — |
| F16 bundles | F16.1–F16.5 | — | — |
| F17 eval, trajectory | F17.1, F17.2, F17.3, F17.4 | — | — |

Read as a whole: every P0 and P1 requirement in v2 section 8 is now built,
except where the row above says otherwise. What is left is concentrated in one
place and is honest about why — F10.9, F10.10, F11.2 and F12.5 are the owner's
phone. A PWA, push notifications, Telegram and WhatsApp are a client
application and a set of vendor integrations, and none of them can be tested
here: there is no device, no store, and no messaging account. Building them
blind would produce code that compiles and has never worked. They are named as
not built rather than half-written.

The rest of the "partial" column is the same kind of honesty at smaller scale.
F12.9's `docker` and `remote_sandbox` backends are declared in the protocol and
selected per role; what is implemented is `local`, where a spawned runtime
inherits no environment and reaches nothing but the broker. F13.3 asks for
adapters to four named third-party runtimes; the wire protocol they would speak
is written, documented and tested, and none of the four is installed here to
write an adapter against.

## 2.1 Deliberate deviations from the PRD

Four places where the implementation does not read literally as the PRD does.
All four are choices, and all four are cheap to reverse if the reasoning stops
holding.

**F15.8's quarantine is scope, not tier.** The requirement says an external
skill enters only through quarantine and points at F12.10, whose answer for a
device or a bundle is "tier 0 only". A skill has no tier — it is a document —
so the analogue had to be chosen rather than copied. It is scope: an
unvouched-for thing may not reach past a read, and for knowledge, reaching too
far means being put in front of every agent in the company. A quarantined skill
applies to one division and the database refuses anything wider. What is not
built is a client for any particular hub; `importExternalSkill` takes the
document, wherever it came from.

**F10.10 is enforced in half, and it is the half that matters.** The
requirement is "tier 3 approval only through the app with MFA; the message
channel shows a link and nothing more". There is no app and no MFA here, so
what is implemented is the prohibition: `decide` takes the channel it arrived
on, and a tier 3 approval over `chat` is refused and recorded as a security
event. Written now rather than alongside the chat integration, because a rule
added at the same time as the surface it constrains is a rule somebody has to
remember.

**F14.3 records refusals, not permissions.** The requirement reads "every hook
records an event with its decision and reason". Denials do. Allows do not:
section 9 budgets a company a million events a month, and an event per hook per
tool call would spend most of that recording that nothing happened. The tool
call's own `tool.called` event is the record that the gates let it through, and
the hook names consulted at a point are readable from the pipeline at any time.

**The broker's gate chain is inline rather than registered as hooks.** Section
8.14 lists policy, tier, budget, plan check and batch guard under `pre_tool`.
They run at exactly that point and they are deterministic engine code a runtime
cannot reach — which is what F14.1 asks for — but they are one ordered read
inside a single transaction, where the grant decides the tier, the tier decides
the facts, and the facts decide the policy. Splitting them into independent
hooks would buy names at the price of that atomic read. The three conditions
that depend on nothing else — platform stop, company freeze, spend ceiling —
*are* registered hooks, because those are the ones a second caller would
otherwise have to remember to copy.

## 2.2 What an audit of these claims turned up

The table above was written as each group landed, and re-reading it against the
code found four requirements marked built whose modules nothing called:
`recordVersion` was wired to grants and not to charters, policies or roles
(F3.9); `escalationPolicyFor` was stored and never read (F2.1);
`memory.search` and `skill.read` were catalogued, promised to every run in its
context pack, and bound to no implementation (F4.8, F15.7); and the preflight
and orphan alerts had no test at all (F11.4). All four are fixed rather than
downgraded, and each now has a test that would have caught it.

The common cause was worth more than the four fixes: there was no composition
root. Every module was exercised by the suite and nothing assembled them into
a process, so "nothing calls this" was invisible — the tests called everything.
`src/worker.ts` is the loop and `src/seed.ts` is what a fresh installation
needs, and with them the built-in bundles (F16.5) and the charter files (F3.11)
are reachable from `src/` rather than only from `test/`.

Writing the loop turned up two defects that only a composition root could have
exposed. A worker pinned to one company did not apply F1.4's freeze filter, so
it would have claimed a frozen company's task, taken a lease, been refused by
the engine's guards, and left the task checked out until the lease expired — a
freeze that parks work for the length of a lease is not a freeze. And a tick
that failed outside any stage, which is what a database blip looks like, ended
the loop: a daemon that exits on a transient failure, invisibly, to whoever was
relying on it. Both are fixed and both have tests.

## 2.3 What a security review turned up

A second pass, with a different question: not "what does nothing call" but
"what does this claim to prevent, and does it".

**A signature was being verified against a key carried in the same payload.**
`publishBundle` and `importExternalSkill` both took a signature and a public
key together and checked one against the other, which proves the payload is
internally consistent and nothing whatever about who produced it. Anyone could
generate a keypair, sign their own bundle, and have it install unquarantined
with whatever grants it asked for — `web-ops` includes `dns.update` at tier 2.
The quarantine F12.10 and F15.8 exist to impose was one `generateKeyPair` away
from being skipped, in both places.

The fix is a trusted-publisher list the owner adds to (`src/bundles/publishers.ts`),
and a third outcome where there were two. A signature that does not verify is
still refused outright — a false claim of provenance is worse than no claim.
One that verifies against a key this installation was never told to accept is
now treated as *unsigned*: quarantined, because an unknown publisher is exactly
what quarantine is for. Trust is checked at install rather than baked in at
publish, so an owner who decides to trust a vendor does not have to go back to
the vendor for a new artefact. It is keyed on a fingerprint of the key's DER
rather than its PEM text, because a list you could bypass with a trailing
newline is a list in name only.

**The tenant boundary holds on every table v2 added.** `every table holding
tenant data is protected` only asserts a policy exists — a predicate on the
wrong column passes it. So there is now a test that drives the same path an
agent would: ordinary queries in company B's scope asking for company A's
skills, versions, eval cases, gateway devices, challenges, dedupe entries and
config versions, by sweep and by id. It lists every v2 table rather than a
sample, because a sample means the next table is protected by whoever
remembers to extend it.

**An archive was carrying a trust decision made somewhere else, and losing
the fact that there was one.** Two halves of the same bug. The export never
wrote a skill's `provenance`, `origin` or `quarantined`, so a restored company
treated a document from a hub as its own work; and the import took whatever the
archive said, so an external skill somebody un-quarantined on the source
instance arrived un-quarantined here. Handing an owner an archive was a way
past the one gate external knowledge has. The archive now carries all three,
and the import forces `quarantined` back on regardless of what it says: an
archive is not a chain of custody, and F16.4 says a company moves between
instances, not that the destination inherits the source's judgement.

**`config_versions` is append-only for agents.** The paths that apply an
owner-approved grant or role change run in tenant scope and the version has to
commit in the same transaction, so the application role needs INSERT. It has
that and nothing else: no UPDATE, no DELETE, and a `WITH CHECK` that refuses a
platform-scoped row. An agent that could rewrite a version could manufacture
one to roll back to.

## 2.4 Whether the suite would notice

Both audits above were, in the end, the same sentence: the tests did not catch
it. So the third pass asked that directly — break a load-bearing invariant and
see whether the suite turns red. Nine of them, each mutated in `src/`, the
relevant file run, the mutation reverted:

| Invariant broken | Tests that failed |
|---|---|
| Tier 3 no longer needs the owner (F8.8) | 1 |
| A hook denial no longer short-circuits (F14.2) | 6 |
| Checkout drops its advisory lock (F5.11) | 1 |
| An untrusted bundle installs unquarantined (F12.10) | 4 |
| A skill activates without a reviewer (F15.3) | 2 |
| The plan and batch guard stops checking (F8.11, F8.13) | 4 |
| Every publisher counts as trusted (F16.2) | 4 |
| The worker ignores a company freeze (F1.4) | 1 |
| An import inherits foreign trust (F16.4, F15.8) | 1 |

All nine were caught. The suite was also checked for the shapes that pass
without testing anything — an `assert.rejects` with no matcher, which accepts
any error including a typo in the test; a `.every()` over an array that could
be empty; a test with no assertion at all; an assertion comparing a value to
itself — and has none.

That is not proof the suite is complete. It is evidence that the entries in
the table above mean what they say, which is the property those two audits
found missing in four places and one hole.

## 2.5 What booting it found

Three audits, and then the obvious thing nobody had done: start the platform
and watch a company do one piece of work. `scripts/smoke.ts` seeds the
installation, builds a company, starts a worker, puts a task in front of it and
waits. Each of its first three runs failed, in ways no test had caught because
no test did what a real run does.

**A retryable failure left the task in `running`.** `#classifyFailure`
incremented the attempt, wrote `task.attempt_failed`, and returned — without
moving the task or dropping its lease. `claimTask` only claims `pending`, so
nothing picked it up again until the lease expired. `attempt_max` of three
meant three attempts spread over an hour and a half. It now returns the task to
`pending` and clears the lease, which is the same edge F5.12 uses to reclaim
one.

**No role in the standard company could call the tools its own context pack
tells it to use.** F4.8 caps the pack and instructs the run to use
`memory.search` for whatever did not fit; F15.7 does the same for `skill.read`.
The template granted neither, to anybody. Every run in a standard company that
followed its instructions was refused. Both are now granted to every division
except two, and both exceptions are decisions rather than oversights.

The lab holds `code.execute`, and `SANDBOX_GUARANTEES` records that the sandbox
does not isolate the network — which is why F8.10 already refuses it a
credential or a tier 2 grant. Everything the company knows is the same category
of thing, so `memory.search` there would be a search interface over the
company's knowledge handed to supplied code. The lab reads its own inputs and
nothing else.

Assurance is excluded from the other end. F7.3 says the reviewer approves and
cannot act, and the way that is guaranteed is that its division holds no grant
at all — an invariant one query can check. A read is not an action, so the
first version of this fix made an exception for these two capabilities and
broke that check; the exception was refused rather than the check weakened,
because "no grants" is checkable and "only harmless grants" is an argument to
be had again with every capability anybody adds. The reviewer judges the
proposal it was handed, which is what its own prompt already told it.

The `qa-review` bundle reaches the same rule by the other route, and the
difference is deliberate rather than an inconsistency: its division does hold
the two read grants, and F7.3 is enforced there by the `review.read-only` hook
it ships, which refuses the division any write. An empty grant list and a hook
that cannot be removed are both real enforcement; what would not be real is a
list of grants somebody has judged harmless with nothing checking the judgement
afterwards. The template has no hooks of its own, so it uses the list.

Which leaves two divisions still being told to call something they cannot, so
the grant was only half the fix. The pack now asks whether the division holds
the capability before it writes the instruction, and says the honest thing
instead when it does not: that this is a summary and the rest cannot be
fetched, or that what was dropped cannot be searched back. That is the durable
form — a division added tomorrow without the grant gets a pack that is honest
about it, rather than a second hard-coded exception list and the same bug
waiting for whoever forgets to extend it.

Those fixes have regression tests, and each was checked by re-introducing the
bug. The template one did not catch it at first: it created its company from
whatever `company_templates` row happened to be in the database, so it was
testing the last thing that wrote one rather than the source. It now saves the
template from the source constant first.

**And then the check itself turned out not to be hermetic, the same way.** It
built its company from the standard template, which grants twenty-seven
capabilities. Twenty-five of those are catalogue *declarations*:
`src/broker/catalogue.ts` is a tier calibration and deliberately does not write
itself into the `capabilities` table, because a row there means the broker can
run the thing and F8.4 wants a read-back for anything above tier 0. So a freshly
seeded installation cannot build a standard company until an operator binds real
adapters — which is correct, and is the design saying so.

Which made the standard template the wrong one for a boot check. The first two
runs passed on catalogue rows the *test suite* had left behind: the check was
testing the last thing that wrote one, which is the identical mistake its own
regression test had made a few hours earlier and which I did not think to look
for here. It now saves and builds its own one-division template, granting only
what the platform implements itself, so it runs on an installation that has been
migrated and seeded and nothing else. What the standard template would still
need is reported rather than hidden — the third run printed all twenty-five
names, which is the list an operator actually wants.

The fourth run is the first that means anything: seed, company, worker, task,
`completed` in 0.2s, funded by the `ops` account rather than the company's.

## 3. Decisions, deviations, and what is unverified

Nothing here is blocking any more. What follows is the reasoning behind the
choices that are not obvious from the code, and the two places where a green
suite proves less than it looks like it does.

**A role eval is structural, not a replay.** F17.2 asks that a change to a
role's charter, skills or model routing runs its eval set. Scoring by
re-executing five reference trajectories against a live provider would cost
real money and give a different answer each time, and F17.3 needs the number
*before* the owner clicks rather than an hour afterwards. So the score asks
whether the change keeps what the references depended on and keeps the negative
cases' failure modes closed. That is weaker than replaying the work, and it is
the check that can run in the second before a decision.

**Two things a green suite does not prove**, and both are named in the code as
well as here.

`ContainerAdapter` implements F12.9's `docker` backend, and its
`--network none` is the guarantee the in-process sandbox has never been able to
make: a runtime started there reaches the engine over stdio and nothing else.
There is a docker CLI in this environment and no daemon, so what is tested is
the argv — the flags *are* the security property — and the health check's
refusal. A real container against a real image has never run here.
`remote_sandbox` remains a declared backend with no adapter behind it; the
`http` runtime reports it because "somewhere else, not ours" is what it means
in F13.5's vocabulary, and it cannot verify the claim.

**The `claude-code` adapter has not been run against the real binary.** It is
not installed here and the provider is not reachable from the test environment,
so what the suite covers is the argv it builds, the translation of the CLI's
stream-json into §7.5's vocabulary, and the MCP bridge its tool calls go
through — driven directly, as a client would. The end-to-end path is unverified
and is written down here rather than left for a green suite to imply.

**NG6 is resolved.** The engine no longer calls a model to do a task: it
assembles a `RunRequest`, lends the runtime four services, and does the
accounting. The handler model is now the in-process runtime — a genuine adapter
that the engine talks to through the same protocol it uses for `script`, `http`
and `claude-code`, all three of which are now written.

The paragraph below is kept because it records why this mattered.

~~**NG6 contradicts the engine as it stands.**~~ v2 states plainly that PALUGADA is
not an agent runtime and does not call an LLM to do a task; a runtime does,
through the adapter protocol in section 7.5. The current engine calls
`LlmClient.complete()` directly from inside a task handler, and the whole
handler model — a TypeScript function that the engine runs — is a runtime, not
a control plane. This is the largest single change in v2 and everything in F13,
F14 and F17 sits on top of it. Nothing new should be built on the handler model
until this is resolved, because each addition makes the eventual move more
expensive.

**Section 14.1 is decided: build.** The spike ran against the pass criteria
the PRD set in advance and scored zero of three — row-level security, the
capability broker and mandatory verification all fail to go in as a Paperclip
plugin, and the criterion asked for two. See
[`decisions/0001-fork-versus-build.md`](decisions/0001-fork-versus-build.md)
for the evidence and for the deployment checks to run if the owner wants them
before committing. The second half of the PRD's fallback binds: the adapter
protocol must stay Paperclip-compatible (F13.1–F13.3).

**The state machine gained its status.** v2 section 8.5's
`pending → checked_out → running` is implemented, and the note below records
what was kept alongside it.

Smaller notes, recorded so they are not rediscovered:

- v2's `checked_out` status is implemented, and `pending -> running` is kept
  alongside it: a worker that claims and starts in one breath passes through
  `checked_out`, but the engine also runs tasks that were never queued, and
  forbidding the direct move would mean inventing a checkout for them.
- v2 keeps `waiting_window` in the diagram, which resolves one of the two
  deviations recorded against v1. It now returns to `pending` rather than to
  `running`, which is what the implementation already does.
- v2 still does not draw `pending → halted`, and F5.6 still requires it. The
  deviation stands.
- v2 F1.5 and F16.4 both ask for a full company archive. The export now carries
  skills, skill versions, eval cases and every configuration version, and
  `src/audit/import.ts` reads one back on another instance with every
  identifier remapped. `bundle_installs` is deliberately not restored: an
  install points at a bundle in the *platform's* catalogue, which the
  destination may not have, so bundles are reinstalled rather than restored
  into a dangling reference.
- F1.6 is wired end to end. The accounts and their inheritance existed and were
  tested; `budget.accountFor` picked the narrowest one and *nothing in `src/`
  called it*, so every task in every company drew on the company account and a
  division ceiling was a row in a table. This is the same shape as the four
  over-claims the wiring audit found — machinery that works, tested in
  isolation, assembled by nobody — which is why the section above is not a
  closed chapter but a habit. `createRootTask` now looks the account up from
  the task's role, division and project unless the caller names one;
  `createSubTask` still passes the parent's, because F5.4 says a sub-task
  shares its parent's counter and that is not a thing to be clever about.
  The standard template gives every division a ceiling under the company's,
  with Build's hanging from Delivery's rather than the company's, and
  `assertTemplateIsCoherent` refuses a narrower account declared above the one
  it hangs from — a limit that could never bind is worse than no limit, because
  it reads as enforced. `upsertSchedule` defaults the same way, which matters
  more than it looks: `schedules.budget_account_id` is NOT NULL, so a schedule's
  account is chosen once and then held, and defaulting it to the company's would
  have put every recurring job in the company outside its division's ceiling.
  Recurring work is most of what a company does, so that would have been most
  of F1.6 back where it started.
