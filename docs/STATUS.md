# Status against PRD v2.0

PRD v2 replaces v1. The previous document is kept at
[`PRD-v1.md`](PRD-v1.md) because roughly two hundred tests and most code
comments cite its numbering, and a reader following a citation needs to be able
to resolve it.

This file says three things: which identifiers changed meaning, what is built
against v2, and what has to be decided before the v2 roadmap can proceed.

Sections 2.2 to 2.11 are the same exercise asked ten different ways — what
does nothing call, what does this claim to prevent, would the suite notice,
what happens if you actually start it, which exports only tests reach, what one
worker never races, do the PRD's own numbered criteria run as written, does the
archive carry what it says it carries, does this document describe the
requirement or a summary of it, and — last, and the one that should have been
first — is every requirement in this table at all. Each found something, which
is why they are separate rather than folded into a single "audited" note: the
useful part is the question, not the answer. The last two were about this
document rather than the code, and they were the two that found a P0.

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

Read this table knowing what sections 2.2 to 2.11 found: ten audits, and every
one found something — usually in a row that already said "built", once in a row
that said "not built" and should not have, and once in a requirement that had no
row at all. F1.6 had its
accounts and its inheritance and nothing looked them up. F12.1–F12.4 scoped
credentials the database enforced and no capability could obtain one. F1.5
exported a company's rules as history and not as rules. None of those rows was
a lie when it was written — each described real, tested code — and each was
still wrong about what the platform did. "Built" here means the requirement is
implemented, assembled, and has a test that fails when it is broken; where it
means less than that, the row says so.

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
| F10 owner surface | F10.1–F10.4, F10.6–F10.8, F10.11 | F10.5 (the rule is enforced; there is no push channel), F10.9 (the delivery rule is enforced; there is no messaging account), F10.10 (both halves refused in code; nothing here can *perform* MFA) | — |
| F11 observability | F11.1–F11.7 | — | — |
| F12 credentials, gateway | F12.1–F12.4, F12.6–F12.10 | — | F12.5 |
| F13 runtime adapters | F13.1, F13.2, F13.4–F13.8 | F13.3 (the wire protocol is open and documented; none of the four adapters it names — `hermes`, `openclaw`, `codex`, `gemini-cli` — is written) | — |
| F14 lifecycle hooks | F14.1–F14.4 | — | — |
| F15 skills | F15.1–F15.8 | — | — |
| F16 bundles | F16.1–F16.5 | — | — |
| F17 eval, trajectory | F17.1, F17.2, F17.3, F17.4 | — | — |

Read as a whole: every P0 and P1 requirement in v2 section 8 is now built or
enforced as far as this environment allows, and the "partial" column says
exactly how far in each case. What is left is one thing wearing three numbers —
the owner's phone. F10.5 has no push transport, F10.9 no messaging account,
F10.10 and F12.5 no application that can perform MFA. Push notifications,
Telegram and WhatsApp are vendor integrations and MFA is a client application;
none can be exercised here, and writing them blind would produce code that
compiles and has never worked.

What *is* built for all four is the half that is a rule rather than a
transport, and that is deliberate: a rule written alongside the integration it
constrains is a rule the integration's author gets to decide. Only an incident
or a tier 3 approval escapes the owner's window (F10.5). A message channel may
act on an escalation, a skill candidate or a review at tier 2 and below, and
carries tier 3 as a link with nothing to press (F10.9, F10.10). A tier 3
approval needs the app and an asserted second factor (F10.10). Each of those is
true today, against a surface that does not exist yet.

The rest of the "partial" column is the same kind of honesty at smaller scale.
F12.9's `docker` and `remote_sandbox` backends are declared in the protocol and
selected per role; what is implemented is `local`, where a spawned runtime
inherits no environment and reaches nothing but the broker. F13.3 asks for
adapters to four named third-party runtimes — `hermes`, `openclaw`, `codex`
and `gemini-cli`; the wire protocol they would speak is written, documented and
tested, and none of the four is installed here to write an adapter against. An
adapter is an argv and a translation of somebody else's output format, and
writing one against a CLI whose interface cannot be observed would produce
exactly the thing this document keeps refusing: code that compiles and has
never run.

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

**F10.10 is enforced as a refusal, because a refusal is what this side can
make true.** The requirement is "tier 3 approval only through the app with MFA;
the message channel shows a link and nothing more". Both halves now refuse:
`decide` takes the channel it arrived on *and* how the owner was
authenticated, and a tier 3 approval is refused unless it is the app and the
caller asserts a second factor. Only the channel half was checked for a while,
which meant an integration naming the wrong channel got a tier 3 approval with
no MFA at all.

Neither assertion can be verified here and the code says so instead of dressing
it up: PALUGADA performs no authentication, which is F12.5 and needs an
application that does not exist. What the check buys is that approving a tier 3
action without a second factor requires the caller to state something false,
and the statement lands on the `security.tier3_channel_refused` event. The same
trade as F12.6's scopes — an accident becomes a lie, and the lie is recorded.

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

## 2.6 What "nothing calls this" looks like when you go looking for it

Three separate times now the same defect has surfaced: a module that works,
has tests, and is assembled by nobody. The wiring audit found four. The F1.6
account lookup was a fifth. So rather than wait for a sixth, the question was
asked mechanically — which exported names in `src/` appear nowhere in `src/`
or `scripts/`, only in `test/`?

The list is long and most of it is fine, because most of it is the **owner
surface**. `freezeCompany`, `requestStopAll`, `setRetention`, `rotateCredential`,
`approveSkillVersion`, `pairDevice` and their neighbours have no caller in
`src/` because their caller is a person, through a console nothing here
builds — see F10.9 and F12.5, and section 2.10 on what F11.2 turned out to
actually ask for. An entry point waiting for its client is not the same defect as
an internal dependency nothing depends on.

Two were the real thing.

**No credential ever reached a capability.** `CapabilityContext` carried no
credential and neither `resolveForDivision` nor `resolveCurrent` was called
from `src/` at all. The database enforced F12's scoping — a credential cannot
be scoped to a division that runs untrusted code, and the tests proved the
lookup was division-scoped — and an adapter bound to a real provider had no way
to obtain the secret it would need. F12.1–F12.4 read as built. The context now
carries `credential(alias)`, resolved against the *calling* division so an
adapter can name an alias but not a division, through `resolveCurrent` so
F12.3's rotation takes effect on the next call rather than when a cache expires.

`resolveForDivision` is deleted rather than left beside it. It did the same
division-scoped lookup without reading the version, so keeping it meant a
second way in that would quietly ignore a rotation.

Writing the tests found something smaller and worth recording, because it is
the same mistake in miniature. The first version registered the resolved secret
with the redactor *in the broker*, with a comment explaining why that was the
line that made section 12.4 hold. Deleting the line left the whole suite green:
`CachedSecretManager` already registers, and the broker's parameter is that
type rather than the bare `SecretManager` interface, so the guarantee was
already made by what the broker will accept. The comment described a line that
had never been the thing that ran. It is gone, and the real registration now
carries the explanation and a test that fails without it.

**Retention was scheduled by nothing.** `runRetention` applies every window in
section 12.3 and nothing called it, so a company's expired prompts, traces and
events were kept indefinitely — a promise about data the platform deletes, that
nothing deleted. It is a worker stage now, at most once every six hours per
company rather than per tick, because it is three deletes and the windows it
enforces are measured in days. It sits last in the tick: it removes, and
everything above may still want to read what it is about to remove. The clock
is in memory, so a restarted worker sweeps once more than it needed to, which
costs three indexed deletes that delete nothing.

Two remain unwired on purpose, and are named here rather than left to be found:

- `processHandoffs` (F6.1, F6.3) is now a worker stage, and its rules stay
  code rather than rows: a rule carries a `mapInput` function, so it is
  supplied by whatever composes the process — the same arrangement as the
  capability registry, where `baseRegistry()` binds what the platform
  implements and a deployment binds the rest. `Worker` takes them as an option
  and runs them in its settle stage, after the runs, because a run in the same
  tick may have completed the task a handoff follows. Omitting them means no
  handoffs, which is the honest default: a template that invented a process
  would be deciding a company's workflow for it. F6.3 asks for handoff *via
  the completed event rather than a direct call*, and that is what is built and
  tested; a stored rule table is not something the PRD asks for, and saying so
  is more useful than implying a gap.
- `buildDailyDigest` and `buildWeeklyRetro` (F10.6) render for a channel that
  does not exist yet — the same gap as the rest of the owner surface. They
  are called by whatever delivers them, and nothing delivers. The obvious fix is
  to deliver them into the owner inbox, which does exist and is tested, and it
  is deliberately not done: the inbox is the list of things the owner has to
  *decide*, and a digest needs no decision. Filling it with items that need no
  answer is how a queue of decisions becomes a feed somebody skims — the same
  argument F14.3 makes about an event per hook, and the same one
  `charter-context.test.ts` makes about a confidence warning printed over facts
  that are all established. The digest is built when something asks for it,
  which is honest, and the owner surface is where the asking will come from.

## 2.7 What one worker never tests

The claim path is raced hard: `checkout-lease-lane.test.ts` sends twenty
workers at `claimTask` sixty times over and checks that exactly one wins, that
a lane admits one task, and that five claimable tasks against an account with
room for three produce three checkouts. Removing the per-company advisory lock
fails it immediately, which is the right answer — that lock is what makes the
lane and budget predicates hold under `READ COMMITTED`.

What no test ran was two *workers*. The whole tick — reclaim, schedules,
wakes, claim, run, settle, retention — over the same rows at the same time,
which is the shape a deployment has. There is one now, and writing it turned up
a predicate with no coverage: `claimTask` claims only `pending`, and letting it
claim `running` as well left the entire suite green. The lease/lane test races
the claim itself, where nothing has started yet, so "a task already being run
cannot be claimed again" was an assumption rather than a tested property.

The first version of the new test did not catch it either. Its handler returned
immediately, so one worker's tasks reached `completed` before the other's claim
ran and the overlap the test was named for never happened. The handler now
sleeps long enough that it does, and the sleep is the mechanism rather than
latency-tolerance — which is worth saying in the test, because the next person
to see a `setTimeout` in a test will reasonably want to delete it.

## 2.8 The four acceptance criteria the PRD spells out

Most requirements are a line in a table. Four have an explicit
**Kriteria penerimaan** attached, which makes them checkable literally rather
than by judgement, so they were checked literally.

**F1.3** — an injection prompt asking for another company's data is refused at
the database and recorded as `security.rls_denied`. Both halves are asserted,
the event included. Met.

**F8.13** — a plan naming 3 recipients against a call carrying 23 is refused
before the MCP call and raises an incident. The test uses those numbers, checks
the adapter was never reached, and reads the incident's rationale. Met.

**F1.8** — a role burning ten times its usual rate is paused within five
minutes without the company touching 100% of its budget. The rate half was
covered: ten times the hourly baseline trips the breaker, the role is frozen,
an incident is raised, and the period is well under its ceiling. The *timing*
half was not. It rests on the worker's watch stage running, and no test
asserted that the tick watches anything — the tick's own docstring said it did.
There is one now: a spiked role is frozen by `worker.tick()` with nobody
calling the breaker, and the interval that makes five minutes generous
(`DEFAULT_IDLE_MS`, five seconds) is asserted beside it. Met, and it was half
met before.

**F5.11** — twenty workers, five tasks, budget for three, and *zero
double-checkouts in a thousand iterations*. The test raced twenty workers sixty
times, with a comment arguing that sixty was well past where a broken
implementation would show. That argument is true and it is not the criterion.
A thousand rounds takes about seventy seconds, which is most of a suite that
runs in ninety, so it is not something to pay on every push forever — but "we
judged the number unnecessary" is exactly the shape of claim these sections
exist to catch. `PALUGADA_SOAK=1` now runs the thousand, and CI runs it on a nightly
schedule and on `workflow_dispatch` — the schedule fires on the default branch
only, which is why the manual trigger exists rather than being an afterthought.
Executed at the stated scale twice: locally in 69 seconds, and in CI through a
manual dispatch in 66, both with zero double-checkouts across 1,000 iterations
of twenty workers. The CI half matters on its own — a conditional step nobody
has ever seen run is a claim, not a check, and the push runs show it correctly
`skipped` while the dispatch run shows it `success`. Met.

## 2.9 What the archive did not carry

F1.5 asks for a company's full state, events, memory, skills and config as an
archive; F16.4 says a company moves between PALUGADA instances on it. The
export was checked the way the sections above were checked — mechanically, by
comparing what it reads against what the schema declares, and then what the
*import* reads against what the export writes. Both comparisons found things.

**The rules in force were not in the archive.** `config_versions` carried the
history of every policy, charter and role; the live `policies` rows were not
exported and not imported, and neither were the spending ceiling, the retention
policy, the alert thresholds, the batch window or the capability windows. A
company restored from an archive came up with a complete record of what its
rules had been and *nothing requiring approval of anything*. That is the worst
shape a gap can take: silently permissive, on an archive that reported itself
complete, with the evidence of what was lost sitting right beside it in the
same file.

**Four more sections were exported and never imported.** Credentials — so a
restored company had no aliases and every credentialled capability failed with
a reason the archive could not explain. Review requests, decision records and
the governance log — the record of who approved what. The review-request one
was worse than an omission: `skill_versions` remapped a `review_request_id`
against a section the import did not have, so it resolved to null and a
restored skill version pointed at no review, which is precisely the evidence
F15.3's "the owner cannot approve a version no reviewer has seen" rests on.

**And the round trip had never worked for a company that had done any work.**
`tasks.input_hash` and `task_steps.input_hash` are NOT NULL and were not
exported, so importing a company with a single task failed on the constraint.
`review_requests.project_id` and `schedules.budget_account_id` were missing the
same way — the second meaning a restored schedule would have had no account to
draw on even if the insert had succeeded. The existing round-trip test imported
a company with no tasks, which is why none of this had ever been seen.

Fixing it turned up one more, in the import rather than the export. `normalise`
stringified objects and left arrays alone, which is a guess about the *value*
where the question is about the *column*: `pg` returns a `jsonb` column and a
`text[]` column both as JavaScript arrays, and they have to go back as
different things. It worked until the first `jsonb` column holding an array.
The import now asks `information_schema` which columns are JSON, once per
table — the schema is the authority on its own types.

Three sections stay out of a restore on purpose, and they are now a named
constant rather than the difference between two lists: `bundle_installs`
(an install points into the platform's catalogue, which the destination may not
have), `retention_log` (it records what *this* instance deleted) and
`llm_traces` (a trace is a charge already billed elsewhere, and restoring one
would put it inside the destination's monthly period and its seven-day
circuit-breaker baseline — a genuine migration wants that and a clone does not,
and nothing in an archive says which). All three stay *in* the archive, because
an auditor is exactly who should see them.

The test that would have caught all of it compares the two section lists
directly and fails if a name is in neither the restored set nor the deliberate
list. It is four lines and it is total, where reading two files and hoping is
neither.

One last note, because it cuts the other way. The first version of the policy
test asserted with a regex condition and failed, and the temptation was to
treat that as a bug. It was not: `matches` takes a glob and escapes every
character but `*`, deliberately, so that a rule in a configuration row cannot
cause catastrophic backtracking. The test was wrong and the code was right.

## 2.10 A requirement that was written off for the wrong reason

The eight audits above all asked the same kind of question about the code. This
one asks it about this document.

**F11.2 was recorded as not built, in four places, on a misreading.** The entry
here said "no owner PWA, so no live run view", and F11.2 says nothing about a
PWA or a live view. It says *"trace dari item inbox ≤ 2 klik"*: the trace behind
an inbox item must be reachable from it, in at most two hops. That is a claim
about the shape of the data, not about a screen — and the reason it kept being
grouped with the owner's phone is that once one sentence in a status document is
wrong, everything downstream cites the sentence rather than the requirement.

It was genuinely unbuilt, for a different reason. `inbox_items.task_id` and
`llm_traces.task_id` had been one join apart since the schema was written,
`trajectoriesForTask` already assembled a task's runs with their steps and goal
ancestry, and nothing joined an item to either. An owner looking at an approval
could not reach what the model had been asked, which is most of what "why is
this being proposed" means. `traceFromInboxItem` is that join. It composes the
existing trajectory reader rather than copying its queries, and it reads the
calls from the *task* rather than by walking the runs: `agent_run_id` is
nullable, so walking the runs drops the calls made outside one — which are
exactly the calls somebody wants when a task went wrong, which is when they
open the item.

Prompts are excluded unless asked for, the same rule the archive follows and for
the same reason: F11.5 keeps a trace for a year and a prompt for ninety days, so
the smaller answer is the one to hand over by default. And the type keeps
"you did not ask" and "retention took it" apart — absent versus null — because
an owner reading a trace with no prompt should be able to tell which happened.

What the test asserts is the reachability: the item id alone, one call, and the
model call comes back. Nobody can count clicks from a test and pretending to
would be the same over-claim pointing the other way, so the test says what it
checks and this section says the rest.

Of the owner surface, three remain: F10.9 (a Telegram or WhatsApp channel),
F10.10's second half (MFA) and F12.5 (owner MFA and mobile biometrics). Those
need a messaging account and a device, and neither is here. F13.3's three
missing runtime adapters are the other outstanding item and are the same kind
of thing — the binaries are not installed. So four in total, where the list
said five this morning, because one of them was never on it.

The other claims on that list were checked the same way while I was here, and
they hold. F10.5 reads as a restriction rather than a feature — push reaches the
owner only for an incident or a tier 3 approval — and `notifyAfterFor` enforces
exactly that: everything else waits for the owner's window. F10.10's third
clause, no tier 3 approval over chat, is refused and recorded. Both are real
rules with no transport behind them, which is what the "partial" column says.

## 2.11 A requirement that was graded nowhere at all

Section 2.10 turned the audit on this document and found F11.2 filed under the
wrong heading. Asked once more — this time mechanically, by diffing every
requirement id the PRD declares against every id this table accounts for — it
found something worse.

**F12.6 was in no column.** Not built, not partial, not done: absent. One
hundred and forty-five of the PRD's hundred and forty-six requirements were
graded and this one had never been looked at, which is why nothing in the
repository cited it — there was nothing to cite. A wrong grade is an argument
somebody can have. An omission is invisible, and it survived nine audits
because every one of them started from this table.

The check is now `test/documents/requirement-coverage.test.ts` and it runs on
every push. It compares the two documents and fails when a requirement is
declared and ungraded, or graded and undeclared. It deliberately does not check
whether a grade is *right* — no parser can, and sections 2.2 to 2.10 are what
that costs. It checks only that every requirement has been looked at, which is
the part a machine can do and a person demonstrably does not.

The same pass found one smaller thing: the F13 row named three of the four
adapters F13.3 asks for. `openclaw` had gone missing from the list while the
README carried all four, so the two documents disagreed about the size of the
same gap.

### What F12.6 turned out to be

*"Least privilege pada token pihak ketiga"* — P0. PALUGADA cannot enforce all
of it and the part it cannot is worth stating first: the platform holds a
reference and never a value (F12.1), so it cannot ask a provider what a token
really carries. Only the issuer knows.

What it can enforce is the *declaration*, and it is enforced from both ends at
once so that the declaration cannot be gamed:

- A credential may not declare a scope that no capability its division holds
  actually needs. An organisation-admin token in a division that only reads DNS
  is refused by the database, with the excess named.
- A capability may not run against a credential whose declared scopes do not
  cover its own `requiredScopes`. That refusal happens in the broker with a
  reason, rather than at the provider with an opaque 403.

Over-declaring is refused by the first, under-declaring by the second, so the
only declaration that lets work happen is the true one. That is not the same as
verifying the token and the code says so; what it does is turn an over-scoped
token from something an operator creates by accident into something they have
to lie about, which is how over-scoped tokens are actually created.

There is a third check, because a rule that holds only at insert time is a rule
that decays: revoking the grant that justified a scope is refused while a
credential still declares it. Same reasoning as F3.5 refusing a policy scope
that loosens a broader one — a rule you can escape by changing something else
is not a rule.

Empty stays legal. Everything the platform implements itself reads the
company's own store and talks to no provider, and demanding a declaration there
would be ceremony — which is what makes people declare something untrue.

### And two more halves, once the same question was asked of F10

Reading F11.2 and F12.6 properly made it worth re-reading the rest of the
"needs the owner's phone" group rather than trusting the summary that had been
written about them. Two had a buildable half that was not built.

**F10.10 was enforced in one of its two clauses.** "Approval tier 3 only
through the app **with MFA**" — the channel was checked and the second factor
was not, so an integration naming `channel: 'app'` got a tier 3 approval with
no MFA at all. `decide` now takes how the owner was authenticated alongside
which pipe the request came down, and refuses tier 3 without both. Neither is
verifiable here and the code says so: PALUGADA performs no authentication, and
that is F12.5, which needs an application. What the check buys is that the
wrong thing now requires stating something false, on an event an auditor can
read.

**F10.9's delivery rule did not exist.** The requirement names three things a
message channel is an *action* surface for — an escalation, a skill candidate,
a review at tier 2 or below — and F10.10 carves tier 3 down to a link. No
channel exists here and none can without a messaging account, but the rule that
would govern one is testable today, and it is written now for the same reason
F10.10's prohibition was: a rule that arrives with the integration is a rule the
integration's author gets to decide.

One judgement call is flagged rather than buried. An incident is push-worthy
under F10.5 and is not among the three F10.9 lists, so it is delivered as a
link with nothing to press. That is a reading of two requirements together
rather than a quotation of either, and it is the kind of thing to be told about
rather than to discover.

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
