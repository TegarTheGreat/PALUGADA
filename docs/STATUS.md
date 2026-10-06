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
| F10 owner surface | F10.1–F10.4, F10.6–F10.8, F10.10, F10.11 | F10.5, F10.9 (push, Telegram and WhatsApp are written and driven end to end against a local server; no push service, bot account or WhatsApp Business number exists here to point them at) | — |
| F11 observability | F11.1–F11.7 | — | — |
| F12 credentials, gateway | F12.1–F12.10 | — | — |
| F13 runtime adapters | F13.1, F13.2, F13.4–F13.8 | F13.3 (the machinery, the four named specs and the override path are built and driven end to end; `codex`, `gemini-cli` and `opencode` were run against their binaries, `hermes` and `openclaw` checked against their source; compatibility with Paperclip's adapter packages is not offered, by decision -- section 2.12) | — |
| F14 lifecycle hooks | F14.1–F14.4 | — | — |
| F15 skills | F15.1–F15.8 | — | — |
| F16 bundles | F16.1–F16.5 | — | — |
| F17 eval, trajectory | F17.1, F17.2, F17.3, F17.4 | — | — |

Read as a whole: every requirement in v2 section 8 is built, the owner has a
console to run it from (`npm start`), and the two rows still marked partial are
partial in one specific way — a vendor account this repository cannot hold.

That distinction is worth stating precisely, because for a long time this
document ran them together and stopped at the wrong place. There is a
difference between *cannot be written* and *cannot be exercised against the
real thing*, and four requirements had been filed under the first when they
belonged under the second. Section 2.13 is that correction. F12.5's MFA is
arithmetic and is now implemented and checked against RFC 6238's own published
vectors; F10.10's tier 3 gate verifies a real second factor instead of
believing a caller who typed `mfa`; F10.5's push and F10.9's message channel
are written, and both are driven end to end against a server on loopback.

What is left is genuinely unavailable rather than unbuilt: no push service, no
bot token, no sandbox vendor and none of F13.3's four binaries exists in this
environment. Every decision the platform makes before the request leaves is
covered, which is where its own defects live; what nobody here can check is
whether the vendor on the other end agrees about a field name.

F12.9's `remote_sandbox` backend is implemented too, as `RemoteSandboxAdapter`
over a three-method provider interface — create, exec, destroy — with the whole
lifecycle exercised against a provider written for the test, including the
property the backend exists for: the sandbox is destroyed on every path out,
and one that will not delete becomes a failure that names it rather than a
leak nobody hears about. `docker` remains implemented as argv and a health
check, because there is a docker CLI here and no daemon.

F13.3 names four third-party runtimes — `hermes`, `openclaw`, `codex` and
`gemini-cli` — and then names the reason for the list: *so that community
adapters can be used*. That reason is built and section 2.12 says how. The
specs ship in `src/runtime/known-clis.ts`, with `opencode` as a fifth.
`codex` 0.157.1, `gemini-cli` 0.61.0 and `opencode` 1.18.32 -- and Claude Code
2.1.283 for the `claude-code` adapter -- were installed and run with the
shipped entries against a stand-in model and the tool bridge (section 2.22,
"Any agent"). `hermes` and `openclaw` were read from their source at fixed
commits (section 2.18) and read again for the audit of 2026-09-28: every flag
the entries pass exists, including Hermes's `chat --max-turns` and `--source`,
which the audit could not find.

## 2.1 Deliberate deviations from the PRD

Five places where the implementation does not read literally as the PRD does.
All five are choices, and all five are cheap to reverse if the reasoning stops
holding.

**F13.3's Paperclip compatibility is not offered.** The requirement asks that
Paperclip's community adapters can be used. They can be hosted, but the ones
that exist expect the model to have a shell and Paperclip's REST API, which
F13.4 forbids a PALUGADA run; the two that take MCP servers duplicate entries
this repository already runs. Section 2.12 has the evidence, read from
Paperclip's source in September 2026.

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
- `buildDailyDigest` and `buildWeeklyRetro` (F10.6) are reached by the owner's
  console — `/api/companies/:id/digest` and `/retro` — and the console draws
  the digest above the queue. They are still not *delivered* anywhere: nothing
  emails them and nothing pushes them. The obvious fix is
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

## 2.12 The half of F13.3 that was a list, and the half that was a reason

F13.3 reads: *adapters `hermes`, `openclaw`, `codex`, `gemini-cli`;
compatibility with the Paperclip adapter protocol so that community adapters
can be used*. It had been graded partial on the strength of the first clause —
four names, four adapters unwritten — and the second clause had never been
read as a separate thing to build. It is the more important of the two. The
list is four programs that happen to exist in September 2026; the reason is
that this platform employs runtimes it has never heard of.

Four hand-rolled adapters would have satisfied the list and missed the reason,
and would have done it in the worst available way. None of the four is
installed here. Their flags would have been guessed, the tests would have
asserted the guesses, and the suite would have gone green over four programs
that had never been run — the exact trade this document refuses everywhere
else.

What the four actually have in common turns out to be everything that is hard.
Each is a process that takes a prompt, is told where to find an MCP server,
writes a stream to stdout and exits. Keeping the parent's environment away from
the child, standing up a per-run tool bridge, holding the redactor between the
runtime and the wire, translating a stream into §7.5's vocabulary, bounding
stderr, killing the process when the engine withdraws — identical for all of
them, and all of it is what an adapter gets wrong. What differs is a command
name, an argument list, and which of two output dialects the thing speaks.

So `CliAdapter` is the hard part, written once and tested, and a
`CliRuntimeSpec` is the rest: a JSON object naming a command and its arguments,
with `{model}`, `{mcpConfig}`, `{mcpConfigFile}`, `{mcpUrl}`, `{mcpToken}`,
`{allowedTools}` and `{prompt}` substituted per run. `runtimeSpecsFrom` reads
them out of a deployment's configuration, so employing a runtime is an entry in
a settings file rather than a release of this platform — and a CLI that changes
its flags is a corrected entry rather than a patch. That is what "community
adapters can be used" was asking for, and it is stronger than four adapters
would have been, because the fifth runtime is free.

The tests are end-to-end rather than argv assertions, against a stand-in CLI
that behaves the way one of the four would: it reads the MCP configuration out
of its own argv, calls a real capability through the bridge, and answers in
either dialect. So what is checked is not that the adapter builds a plausible
command line — it is that a runtime employed from a configuration entry alone
does a real task, has its tool call resolved by the broker, and is charged for
what it used.

Three refusals are in the adapter rather than in a review:

- **A spec that never places the tool bridge is refused at construction.** An
  agent CLI spawned without one starts, talks to a model, has no tools at all,
  and answers confidently about work it could not do. Nothing throws and
  nothing is logged. It is the same defect class as a role granted no
  capabilities, and section 2.2 is a list of those.
- **The execution backend is not a spec field.** A process spawned here runs
  where this process runs, so the adapter claims `local` and nothing else.
  Letting a spec claim `docker` would make a role's isolation setting a value
  that changed nothing — worse than a missing feature, because it reads like a
  choice somebody made.
- **A non-zero exit is a failure, not a provider failure.** F13.6 lets the
  engine move a run to a fallback model silently when the provider failed. An
  exit code says the process died and nothing about why, so reading it as a
  provider failure would turn every crash into a second billed run.

Two things this does not claim. The four names are still not adapters in this
repository, and the table says so: what an operator gets is the machinery and a
place to put the command line, not a working `codex` entry written by someone
who has never run `codex`. And **Paperclip compatibility is not offered, and
that is a decision rather than a gap.** This section used to say Paperclip's
adapter protocol was not published; it is -- `@paperclipai/adapter-utils` on
npm, MIT, with `packages/adapters/AUTHORING.md` -- and it was read for the
audit of 2026-09-28 (Paperclip at `0f14d26`). A Paperclip adapter is an npm
package exporting `createServerAdapter()`, whose `execute(ctx)` is handed a
prompt, a config with resolved secrets, a Paperclip API token and optionally
MCP servers, and returns usage, cost and a text summary. A host for such a
package is feasible -- in a scrubbed process of its own, about a thousand
lines -- but it would buy almost nothing. The community adapters F13.3 names
as the reason expect the model to use its own shell against Paperclip's REST
API (`PAPERCLIP_API_KEY`, `curl`), which is exactly what a PALUGADA run is
never given (F13.4); only Paperclip's own `claude_local` and `codex_local`
take MCP servers, and both default to skipping every permission and duplicate
the `claude-code` and `codex` entries this repository already runs. So the
clause is recorded as a deviation (section 2.1): what F13.3 was after -- a
runtime nobody here has heard of can be employed without changing this
codebase -- is reached by PALUGADA's own documented protocol and a spec in
`PALUGADA_RUNTIME_SPECS`. The owner can reopen it; the evidence is in
`docs/AUDIT-2026-09-28.md`.

## 2.13 "Cannot be tested" is not "cannot be built"

Four requirements — F10.5, F10.9, F10.10 and F12.5 — spent this whole build in
the partial column under one sentence: *these need the owner's phone, and there
is no phone here*. The sentence was true and it was doing work it had not
earned. It was written once, and every later pass cited the sentence instead of
re-reading the requirement, which is exactly the failure section 2.10 recorded
about F11.2 and then repeated four more times without noticing.

The correction is a distinction. **A vendor account cannot be conjured. Code
can be written.** Those are different problems, and only the first one is a
reason to leave a P0 unbuilt.

### F12.5 was arithmetic filed as an application

"Owner: MFA; mobile biometrik", P0, graded not built because MFA lives in an
app. Half of that is true: the *client* is an app — an authenticator holding a
TOTP secret, a phone holding a passkey behind a fingerprint. But verifying what
those clients produce is arithmetic, and arithmetic is the one thing a control
plane should never take a caller's word for. It had been taking exactly that:
`decide` accepted `assurance: 'mfa'` as a string nothing checked, so F10.10's
"tier 3 only through the app with MFA" was, in practice, "tier 3 for anyone who
types mfa".

`src/owner/mfa.ts` implements both factors and `owner_authenticators` holds
them, out of the application role's reach entirely — an agent that could read a
TOTP secret could mint its own approvals, and one that could insert a row could
enrol itself as the owner's phone.

- **TOTP (RFC 6238)** with a one-step drift window, and the accepted step
  remembered so a code cannot be used twice. A code is valid for thirty
  seconds, which is long enough to be read over a shoulder or replayed out of a
  log. Checked against RFC 6238's own published vectors, so the test proves
  conformance rather than self-consistency.
- **WebAuthn**, which is the "mobile biometrik" half: the phone signs a
  challenge with a key held behind a fingerprint. Six things are checked and
  each is an attack rather than a formality — the signature, the challenge
  (without which the assertion is a fixed string anyone who saw it can resend),
  the origin, the RP id hash the *authenticator* signed, the **user-verified**
  flag, and the signature counter. The last is the difference between a key
  that was touched and a key that was unlocked by a person, which is what
  "biometric" means. Tested against real P-256 signatures made in the test; the
  only difference from a phone is where the private key lives.

**Registration** is the same checks read the other way round (`src/owner/passkey.ts`
reads the `attestationObject` -- CBOR, with the key inside as a COSE key -- and
`enrolPasskey` decides): the ceremony is `webauthn.create`, the challenge is one
this process issued and has not seen used, the origin and the relying party
are this console's, a person verified on the device, and the key is ES256,
EdDSA or RS256 of at least 2048 bits. The attestation statement is not
verified: the console asks for none, because which make of device the owner
chose is not the platform's business, and what is trusted is what a TOTP
enrolment trusts -- the owner, holding a factor already, said this device is
theirs. The relying party defaults to the public URL's host, so a passkey can
be made wherever the console is published.

Every attempt lands in `owner_authentications`, failures included — a burst of
failures against the owner's authenticator is the shape of somebody trying, and
a log that kept only successes would hide precisely that.

`decide` now derives `assurance` from a verification instead of reading it from
its caller, and a deployment with **no** verifier configured cannot approve a
tier 3 action at all. That is deliberate: F12.5 is a P0, and the consequence of
not meeting it should be that irreversible actions wait, not that they proceed.

### F10.5 and F10.9 were a rule with the easy half missing

Both were graded "a rule with no transport", which had the difficulty exactly
backwards. The rules are the hard part and they were built. The transport is an
HTTP call.

`src/owner/push.ts` is a webhook push channel: an HTTPS POST to a URL the
deployment configures, which is how every push service worth using is reached —
a relay in front of FCM or APNs, ntfy, Pushover, an owner's own endpoint — with
a `body` function mapping onto whichever. Binding to FCM directly would have
meant a service account and a hard vendor dependency for a feature whose entire
content is "send four short strings".

`src/owner/telegram.ts` is the message channel, with inline keyboards, which is
what "balasan lewat tombol inline" asks for. Telegram rather than WhatsApp or
Signal because an owner can be running it in five minutes with no business
verification and no per-message cost; the other two are the same shape behind a
different HTTP call.

Three things came out of building them that no amount of rule-writing would
have found:

- **The same incident would have been pushed on every tick.** An inbox item
  stays open until the owner decides, so "open and past its `notify_after`" is
  true for as long as they take to answer — and a worker ticks every few
  seconds. The first real deployment would have woken its owner until they gave
  in. `owner_notifications` is a row per item *per channel*, and the uniqueness
  constraint on that pair is the rule rather than a nicety. Per channel because
  an incident is push-worthy under F10.5 and, being absent from F10.9's list of
  three, also reaches the chat as a link: both are correct for one item, and a
  record keyed on the item alone would have let whichever ran first silence the
  other.
- **A bot is reachable by anyone who learns its name.** "It came from Telegram"
  is not "it came from the owner", so a press is checked against the webhook
  secret in constant time *and* against the configured chat id, and a
  well-formed press from anywhere else is recorded as a security event rather
  than dropped — somebody finding the bot is worth knowing about. F10.10's tier
  3 refusal is deliberately **not** re-implemented in the channel: it lives in
  `decide`, where every channel meets it, because a second implementation of
  "not over chat" is a second thing that can be wrong.
- **An unescaped hyphen would have silently lost an escalation.** Telegram
  rejects a whole message when one MarkdownV2 reserved character in it is
  unescaped, and an item's title is whatever an agent wrote. The message would
  not have rendered oddly — it would have failed to *send*, and the owner would
  never have learned there was an escalation.

A push deliberately carries an alert and not the decision: a lock screen is
rendered by an operating system and copied through a vendor's servers, so it
gets what happened, how bad, and a link, and the substance stays behind the app
where the second factor is.

### And the notifier is actually called

The channels are wired into the worker's tick as a `notify` stage, after
`watch` -- because `watch` is what raises the incidents and budget alerts this
stage delivers, and notifying first would tell the owner about this tick's news
on the next one. A channel that fails is a recorded failure on the
notification row rather than a thrown tick: a vendor is briefly unreachable far
more often than it is broken, and a worker that stopped claiming tasks because
a push relay returned 502 would have turned a notification outage into a
company outage.

`scripts/smoke.ts` boots with a recording channel and fails if the tick never
reaches it. That check exists because the defect this repository has found in
itself more often than any other is machinery that works, is tested in
isolation, and is assembled by nobody -- and a notifier is exactly the shape
that fails that way, since every unit test of it passes whether or not anything
calls it.

The same boot check now enrols a TOTP factor, raises a tier 3 approval, watches
it be refused with no second factor, and approves it with a real code. `OwnerMfa`
has the identical failure mode and a worse consequence: a verifier nobody
constructs is a tier 3 gate that refuses everything, which looks exactly like
the gate working right up until the day the owner needs to approve something.

### What a review of the new code found

Nine defects, from a review over the three commits above. Two are worth
recording here because both are about a rule that was written down and a piece
of code that did something else.

**The push would have rung twice.** `dispatch`'s `try` wrapped the delivery
record and the audit event alongside the transport, so a database failure
*after* the message had gone ran the failure path -- which clears
`delivered_at` -- and the retry in the same tick sent it again. The exact thing
`owner_notifications` exists to prevent, reached through the code that was
supposed to prevent it. Only the transport is inside the `try` now, and the
retry sweep ignores a row with neither a delivery nor an error: that is a row
whose outcome was never learned, and between "possibly sent twice" and
"possibly not sent" a notification should choose the second.

**The retry budget was spent before the outage ended.** The worker runs
`dispatch` and then `retryFailed` in one tick, so two of the three attempts
went milliseconds apart and the third seconds later. A relay restarting behind
a load balancer -- the ordinary failure, not the exotic one -- would have
exhausted the row before it came back, and the owner would never have been
told. `last_attempt_at` (0034) and a doubling wait fix it.

Four more were in the MFA:

- **The origin check failed open.** It was skipped entirely when the option was
  unset, so a deployment that forgot it would accept an assertion the owner's
  phone produced for a different site. `rpId` had always failed closed; the
  origin now does too, defaulting to `https://<rpId>`.
- **Nothing stopped a guesser.** Failures were recorded and never counted, and
  the replay defence only engages on a *correct* code -- so six digits is a few
  hundred thousand unthrottled attempts, which is minutes. Ten consecutive
  failures now lock the factor for fifteen minutes; a success clears the tally,
  so an owner who mistypes has spent nothing.
- **`company_id` on an authenticator was a lie.** The lookup ignored it, so a
  factor enrolled against one company would have approved a tier 3 action in
  another. The owner's own device is platform-scoped and still answers
  everywhere, which is what §5 principle 1 means; a company-scoped one is now
  scoped.
- **A malformed assertion left no trace**, because the parse threw past the
  recorder -- and a stream of malformed assertions is exactly what somebody
  probing the endpoint produces.

And three elsewhere: a shipped runtime spec put the bridge's bearer token on a
command line, where any local process reads it out of `/proc`; the sandbox
provider's `destroy` and `health` had no timeout, so a vendor that accepts a
connection and never answers would hang the worker's tick through the very
check meant to keep it running; and a notification delivered on a retry was
missing from the audit log.

Every one of them is covered by a test that was verified by re-introducing the
defect it claims to catch.

### A green suite that was green for the wrong reason

CI went red on a commit whose only change was documentation, and the test it
failed had been passing for a week. Nothing in the code had moved. What had
moved was the clock: the run happened at 14:32 UTC instead of 05:22.

The test compared two escalations' `notify_after` for equality, to show that a
division which names no escalation role adds nothing to the owner's wait. When
the owner's window is *closed*, `notifyAfterFor` returns the next opening --
one fixed timestamp, so both items get the same value and the assertion holds.
When it is **open** it returns `now`, and the two items were raised a
millisecond apart. The assertion was therefore true or false depending on the
hour of the day, and for a week it had only ever been asked in the closed half.

Two things came out of it, and neither is the test.

The assertion now compares a *difference* rather than an identity: the division
must add nothing, and the defect it guards against added four hours, so a
tolerance of a second catches it either way. An equality assertion on two
timestamps taken at two different moments was never testing what it said.

And `resetData` now restores the owner's window. It lives in
`platform_control`, which is not tenant data and therefore survives the
TRUNCATE -- so the one test that legitimately moves it, to check that a routine
escalation waits for waking hours, left it moved for every file that ran
afterwards. That is a whole class of order-dependence: a suite that passes for
a reason nobody wrote down, until the day the order or the clock changes and a
green test goes red with no code between the two runs.

### A rule applied wider than it was written

F5.8 reads: *"Stop semua: semua task `cancelled` ≤ 5 detik; aksi in-flight
tidak di-commit"*. It is about tasks, and about actions with effects in the
world. The tick implemented it as "do nothing at all" -- which is a broader
rule, and broader in a direction with a cost nobody chose: the owner presses
stop *because* something is wrong, and the platform answers by stopping telling
them what is wrong. An incident raised a second before the stop would have sat
undelivered until the stop was lifted, which could be a weekend.

Telling the owner what already happened is not a task and not an action with
effects: it commits nothing on a company's behalf, spends no budget, and runs
no agent. So a halted tick now runs the notify stage and nothing else. F10.5
already bounds what may reach them to an incident or a tier 3 approval, and
`owner_notifications` bounds it to once each, so what arrives during a halt is
exactly the backlog of things they most need and no more -- a halted worker
ticking every few seconds does not become a phone ringing every few seconds.

Worth recording as a category rather than a fix. A requirement implemented more
strictly than it was written looks like caution and reads like rigour, and the
cost only shows up in the situation the extra strictness was never considered
against.

### The owner surface exists now

Every requirement in F10 was built as a *rule* and had no surface: the inbox
was a table and a set of functions, and the platform whose entire premise is
"one person runs many companies" had no way for that person to say yes. The
sentence that had been standing in for it -- "the owner's phone" -- covered
three real vendor gaps and, underneath them, one thing nobody had written.

`src/owner/api.ts` is the console's API and `console/` is the page. Both are
deliberately small: no framework, no build step, `node:http` and one script.
That is not taste. Every route is a place where an unauthenticated request
could reach a company's data or approve something irreversible, and a surface
small enough to read in one sitting is one whose every entrance can be checked.

**The console holds no rules.** Which items exist, what may be pressed, whether
a tier 3 approval needs a second factor -- all of it is answered by `decide`,
where every surface meets the same gate. That is not a stylistic preference
either, and there is a test for it: mutating the API to claim
`assurance: 'mfa'` changes nothing, because `decide` derives assurance from a
verification rather than reading it from a caller. A console that could talk
its way past F10.10 would be a second implementation of it, and the one that
mattered would be the one nobody re-read.

**Signing in is presenting a second factor.** There are no accounts: PALUGADA
has one human, so an identity system would be a table with one row and a
password to lose. But a session is *not* MFA -- a token minted this morning is
possession of a browser tab -- so a tier 3 approval asks for the factor again,
at the moment of the decision. The page tries without one first and lets the
platform refuse, which is how it stays out of the business of knowing which
tier needs what.

**The one real hole this found.** The static file server's containment check
looked like it stopped path traversal, and it did not: `normalize` flattens
`..` before anything compares, so a path full of dots lands harmlessly inside
the root and misses. What the check actually earns its place against is a
**symbolic link** inside the console directory -- `resolve` does not follow
one, so a link to `/etc` passes every string comparison and reads somebody
else's files. Only `realpath` sees it. Found by mutation testing: removing the
check left the suite green, which meant the test was proving something the
check was not doing.

`src/main.ts` is the assembly -- worker, console, whichever channels the
environment configured -- and it reports what was left unconfigured at boot
rather than at 3am: no authenticator enrolled means no tier 3 approval is
possible, and it says so in those words.

## 2.15 Five capabilities that needed nobody's account

Twenty-five names, nineteen of which need a vendor. Five did not, and they had
been left unbound alongside the nineteen -- which is the same mistake section
2.13 records about MFA, made a second time on a different subject. *A vendor
account cannot be conjured. Code can be written.*

`web.fetch`, `uptime.check`, `files.list`, `doc.draft` and `email.draft` are
now real, in `src/capabilities/`. Two things came out of building them, and
both are worth more than the capabilities.

### The most dangerous thing in the catalogue is the one that looks harmless

`web.fetch` is tier 0 -- it changes nothing -- and the standard template grants
it to four divisions. It is therefore the capability most likely to be granted
without much thought, and it makes an HTTP request *from inside the platform's
own network*. What that reaches by default is everything the orchestrator can
reach: `169.254.169.254`, the cloud metadata service, which hands the machine's
own credentials to anything that asks from the machine; `127.0.0.1:<port>`, the
MCP tool bridge; an internal admin panel on a private address, which is the
ordinary case rather than the exotic one.

None of that is a bug in `web.fetch`. It is what fetching a URL means, which is
why the capability has to decide what "the web" is before it goes anywhere.
`reachable.ts` is that decision, and four things in it are load-bearing enough
to have been checked by removing them:

- **The check is on resolved addresses, not on names.** `localhost` is easy to
  spot. `metadata.google.internal` is a public name with an `A` record pointing
  at the metadata service, and an attacker's own domain resolving to
  `127.0.0.1` costs nothing. A blocklist of names is one somebody registers
  around in an afternoon.
- **Every address a name resolves to, not the first.** Two `A` records -- one
  public, one loopback -- is a documented way past a checker that stops at the
  first, because which one the socket uses is not the checker's choice.
- **Every redirect, re-checked.** A permitted host answering `302 Location:
  http://169.254.169.254/` is the same attack with one extra hop, and
  `redirect: 'follow'` takes it without asking anybody. So redirects are
  followed by hand.
- **`http` and `https` only.** `file:///etc/passwd` is the shortest path from
  "read a web page" to "read the host".

`files.list` needed the same argument about a different resource, and the same
answer the owner console needed: `resolve` flattens `..` but does not follow a
symbolic link, so a link inside the root pointing at `/etc` passes every string
comparison. Only `realpath` sees it.

### The calibration check caught a design mistake, which is what it is for

`doc.draft` and `email.draft` were first written to return text and store
nothing, at tier 0, because that felt safer. `assertCalibrated` refused to
register them: §8.8 puts a draft at **tier 1** because a draft is a *write that
can be undone by rewriting*, and a capability that stores nothing is not that
capability at all. It also has nothing to `verify()`, which tier 1 requires --
and a mandatory read-back with nothing to read back is the shape of a rule
being worked around rather than met.

So they write, into the company's own files directory -- the same root
`files.list` reads -- and verify by reading the file back. The document store is
the part that needs a vendor; the writing is not. A deployment with Google Docs
or a real mailbox binds a different implementation of the same name.

The filename is the platform's and never the caller's: a capability that let a
role name the file is one that lets a role name
`../../etc/cron.d/anything`. The slug is an allow-list rather than a
deny-list, because the input is prose written by an agent, and "which
characters are dangerous in a filename" has a different answer on every
filesystem while "which are safe" has the same short one everywhere.

### And then a review found twelve more

Worth recording as a group rather than a list, because two of them are the same
mistake in two places and one is the mistake this whole document is about.

**A filesystem has no row-level security to inherit.** `files.list` and the
drafting pair shared one directory across every company, so company A could
list company B's drafts. F1.1 is enforced by the database everywhere else in
this platform, and a capability that reaches a filesystem has to do that job by
hand or it undoes it. Each company now has a subdirectory named by its id --
chosen from `ctx.companyId`, never from an argument.

**An IPv6 address has many spellings of the same value, and the first check
read the text.** `fe80` as a string prefix misses `fe90::1`, which is also
link-local: the range is fe80::/10, not those four characters. The dotted
`::ffff:127.0.0.1` has a hex twin, `::ffff:7f00:1`. Both reach inside this
network. The addresses are parsed into their sixteen bytes now, and the tests
name every spelling.

**A deadline that only covers the handshake is not a deadline.** `safeFetch`
cleared its timer when the headers arrived, so a server that sends headers
immediately and then trickles the body forever had no deadline and could not be
cancelled by the engine withdrawing the run. That is cheaper to mount than a
slow handshake, because the connection already looks healthy.

**A dialog that approves what the owner just cancelled.** The console's second
factor prompt removed its listeners by hand in each exit path and missed
Escape, so the listener stayed bound to the *cancelled* item -- and the next
tier 3 confirmation submitted the owner's valid code against the previous one
and approved it. It is now an `AbortController` tied to the dialog's own
`close` event, which fires however the dialog closes. This is the worst failure
that page could have had, and it was three lines.

**And the assembly file had the defect assembly files exist to prevent.**
`src/main.ts` never registered `memory.search` and `skill.read` -- the two tools
every context pack *instructs* every run to call -- so under `npm start` every
role would have been told to use two tools that answer `capability.unknown`.
It also passed `undefined` where the secret manager goes, which makes
`ctx.credential()` throw for every capability that needs one, in the only
assembly a deployment actually runs. Both are the same shape as the notifier
that nothing called, found for the third time.

The rest: `lstat` rather than `stat` in a listing, so a link reports itself
instead of its target's size and modification time; a read-back that used
`includes` and was vacuously true for the empty body `splitEmail` legitimately
produces; a cost held in one closure variable shared by every concurrent call;
`uptime.check` reporting a withdrawn run as "the site is down"; and a stop-all
button with no error path, which is the one button that must never fail
quietly.

### And the twenty are a configuration entry, not four hundred lines each

"We cannot choose the vendor" is not the same as "every deployment writes the
same four hundred lines", and the difference is the split this repository has
now reached for three times. What those twenty have in common is everything
that is hard: resolving a credential without the capability ever holding it,
keeping the request out of this network, carrying an idempotency key on
anything with a side effect, reading the state back afterwards, reporting a
destination a policy can match on, and turning somebody else's error body into
a refusal an agent can act on. What differs is a URL, a header and which field
of the answer matters.

So `httpCapability` is the hard part, written once, and an
`HttpCapabilitySpec` is the rest -- a JSON-shaped object an operator supplies
and can correct when a vendor changes a path, without a release of this
platform.

Three things are refused when the spec is built rather than when an agent hits
them, because each fails silently:

- **A tier 1 capability with no `verify`.** The broker refuses the call anyway;
  the difference is whether an operator finds out when they configure it or an
  agent finds out halfway through sending an invoice.
- **A side-effecting method that places no idempotency key.** A runtime whose
  request timed out does not know whether the email went, and the vendor is the
  only party who can answer that -- but only if it was told which call this is.
- **A credential in a URL.** A URL travels in logs, in redirects and in the
  other end's access log; a header does not. This platform's redactor catches
  the value in its own trace and can do nothing about the vendor's.

Building it turned up a gap in the platform rather than in the configuration.
**F8.12's preflight had no way to resolve a credential** -- `PreflightContext`
was `{ companyId, divisionId }` -- so the check that exists to catch "the
failure no retry fixes" could only ask whether a host answered, which is the
part that was never in doubt. For most of the catalogue that failure *is* the
credential: expired, revoked, rotated to something the vendor no longer
accepts. The context now carries the same division-scoped, version-reading
lookup the execute path uses, the engine supplies it, and F12.6's scope check
runs on it too -- so a credential that does not declare what this capability
requires fails its preflight rather than its first real call.

### What that leaves

Twenty names still need somebody's account, and the boot check prints every one
it does not have. That number is honest in a way it was not: what is left is
what genuinely cannot be built here, rather than what nobody had looked at --
and what remains for an operator is a settings entry per vendor rather than an
integration. The section after this one is about how they hand that entry in,
which turned out to be missing.

### And a review of that turned up a credential leak

Five findings, and the first two are the same mistake made twice: a rule
written down and then applied to one of the three places it holds.

**A credential followed a redirect.** `safeFetch` refuses a redirect that
reaches *inside* this network, which is what it was written for, and does
nothing about a redirect to another perfectly ordinary public host — which
was fine while its callers fetched pages, and stopped being fine the moment
one of them carried a division's bearer token. A vendor answering
`302 Location: https://attacker.example/` would have been handed a live
credential, and the module's own comment said headers do not travel in a
redirect. They did. `authorization`, `cookie` and the four common API-key
spellings are now dropped on any hop that changes origin, the way a browser
and `curl` do it; an ordinary header like `accept` still travels, because
dropping everything would break content negotiation for no gain.

**A side effect could be repeated at an address the caller never named.**
`307` and `308` mean "repeat exactly", so a vendor could turn one POST into a
second real action against a stranger — and the idempotency key that makes a
retry safe means nothing to a party that never issued it. Refused now for
anything but GET and HEAD; `301`/`302`/`303` downgrade to GET with no body,
which is what the status codes actually say.

**The `{credential}`-in-a-URL refusal read one URL of three.** A spec can name
three — the call, the read-back, and the preflight — and only the first was
checked, so the rule the section above describes could be broken by putting the
token in the verify URL instead.

**A truncated answer was returned as a result.** The response cap exists so one
chatty vendor cannot exhaust the orchestrator, and for a page half of it is
still useful. Half of a JSON document is not: it fails to parse, comes back as
a string, `verify` reads `{result.id}` off it, finds nothing, leaves the
placeholder literal, and reports a *successful* write as unverified — which is
wrong in the direction of doing the thing twice. It is a refusal now, and the
cap it names is a per-capability setting rather than a constant only the
transport knows, so the advice in the message is advice somebody can take.

**A read-back was sent as though it were the write.** The verify call reused
the write's headers verbatim, idempotency key included, which tells a vendor
that deduplicates by it that this *is* the write — some answer with the
original response rather than the current state, so the read-back reads back
the request. The same headers on a preflight went out with `{input.x}` still
in them, because a preflight has no input, and a vendor that 400s on that marks
a healthy credential unhealthy and halts every task that needs it.

And one in the platform rather than in the new code: **a successful rotation
filed a false incident.** `rotateCredential` sweeps the division's grants
afterwards, which is the point of F12.3 — but it swept with no way to resolve a
credential, so every capability that needs one answered "no way to resolve one",
the forced sweep wrote `unhealthy`, an incident was raised, and the engine
halted the next task that needed it. The owner would have been woken to be told
that the thing they had just fixed was broken. Seven mutations, one per fix,
each re-introducing the exact defect: all seven are caught.

### The spec was configuration nobody could hand in

The section above says an operator writes a spec rather than an integration,
and the README said so too. Both were one step early. `HttpCapabilitySpec` is
a TypeScript object with four functions in it -- a body builder, a result
mapper, a match predicate and a policy describer -- so the only way to bind
`email.send` was to fork this repository and edit `src/main.ts`. Nothing in the
deployment referenced `httpCapability` at all.

That is the same defect a fourth time: **machinery that works, is tested in
isolation, and is assembled by nobody.** It is worth naming how it recurs,
because the shape is always the same and the fix is always the same size. Each
time, a piece was built and proved correct against a test that constructed its
own caller; each time, the real caller was the file nobody thought of as code.

So the four functions have declarative forms and the whole thing is a JSON
file. `PALUGADA_VENDORS` names it, `config/vendors.example.json` is a working
one, and `src/capabilities/vendors.ts` turns each entry into the spec
`httpCapability` already took:

- a **body** is a JSON template, substituted value by value rather than by
  string -- so a subject line with a quote in it cannot produce invalid JSON,
  and a string that is *exactly* one placeholder keeps the type of the value it
  names, because a vendor that declared an integer rejects `"25"`;
- a **result** is a path into the answer;
- a **match** is a status, a path and a comparison, including `equalsPath`,
  which is the read-back F8.4 actually wants: not "a field came back" but "the
  record now says what I set it to". `VerifySpec.matches` gained the call's
  input so it can make that comparison;
- a **describe** maps F3.4's four fields to input paths, and reads a batch
  properly: recipients that share a domain have one, recipients that do not
  have `null` rather than the first one -- which is the safe answer in both
  directions a policy can be written, since an escalation rule reading
  `not_in [ours]` fires on `null` and an allow rule reading `in [ours]` does
  not match it.

The vocabulary is deliberately small. The alternative to a small vocabulary is
an expression language, and an expression language in a configuration file is a
program nobody reviews inside the one component standing between an agent and
an irreversible action. Paths read own properties only, for the same reason:
`{ "present": "body.constructor" }` would otherwise pass against every object a
vendor can return, including the `{}` it answers when it did nothing.

**A file that cannot be built from stops the boot**, naming the entry and the
field. Every other missing piece leaves a capability unbound, which the
catalogue check and the broker both refuse loudly at the moment of use; a
malformed vendor file is different, because the operator believes they
configured it, and starting anyway is section 2.3's silent misconfiguration
written a second time. `additionalProperties: false` throughout, so
`credential_alias` for `credentialAlias` is a refusal rather than a capability
that sends no token; a duplicate name is a refusal rather than a race between
two entries; an empty `matches` is a refusal rather than a read-back that reads
nothing back. And the file cannot loosen the catalogue: `registry.register`
runs `assertCalibrated`, so an entry binding `email.send` at tier 0 is refused
against the calibration.

**And writing the test for the assembly found a second bug in it.**
`registerPlatformCapabilities` syncs the registry to the `capabilities` table
at the end of its own work, and the vendor file loaded *after* that -- so a
vendor capability lived in memory and never reached the table the broker reads
for the kill switch and the tier, and which every grant is a foreign key into.
The file would have loaded, the boot note would have named it, and it could not
have been granted to anyone. The sync now happens once, after everything is
registered. The boot note also lists what is still unbound by name rather than
by count, because the count on its own has been wrong twice in this document's
history, both times because something was registered and nothing looked.

`npm run smoke` reads the example file, so the number it prints went from
twenty to sixteen: `email.send`, `dns.read`, `dns.update` and `invoice.issue`
are bound by configuration in the boot check itself.

### And a review of the file found seven more

Six in the new code and one in the example, and the pattern in four of them is
the same: **a guard that passes and checks nothing.**

- **A read-back clause that asserts nothing.** An empty `matches` was already
  refused. `{ "path": "body.status" }` was not -- it reads a field and
  discards it -- and neither was `{ "equals": "sent" }`, which names a value
  and never looks for it. Both left a tier 1 write "verified" on any 2xx,
  which is worse than an unverified write because the platform reports it as
  checked. Each now requires the other.
- **And the fix for it was itself a guard that checked nothing.** The first
  version used `dependentRequired`, a 2019-09 keyword; this validator runs
  draft-07 with `strict: false`, where an unrecognised keyword is silently
  ignored. The test caught it. Written as `if`/`then` now, which every draft
  understands.
- **The example's own read-back could never have run.** `"result": "body.id"`
  makes the result a *string*, and a verify URL of `{result.id}` then reads
  `id` off a string, finds nothing, and goes out with the placeholder still in
  it -- so the vendor 404s and a write that succeeded is reported unverified,
  wrong in the direction of sending it twice. `fill` now understands a bare
  `{result}` for the scalar case, the example uses it, and the test asserts
  that no read-back URL in the shipped file survives filling with a `{` in it.
- **A policy fact that was always null.** The example mapped `dns.update`'s
  `urlHost` to a DNS record's *value*, which `new URL()` throws on. A fact
  that is permanently null is worse than an absent one: a policy written
  against it reads as protecting something while the `not_in` direction fires
  on everything and the `in` direction fires on nothing. The test now
  exercises every `describe` in the shipped file against an ordinary input.
- **A nested input path was sent as text.** Body templates read one dotted
  segment, so `{input.customer.email}` reached the vendor literally -- stored,
  and sent to somebody -- while every other path in the file read to any
  depth.
- **A file could take a name the platform already bound.** `register` is a
  `Map.set`, so an entry named `memory.search` would replace the platform's
  binding with a vendor's URL while the boot note still credited the platform.
  Every role's context pack instructs a run to call that tool, so the
  consequence is the whole platform quietly talking to somebody else's server.
  Refused now, naming the adapter that holds it.
- **The smoke run polluted a shared database.** It synced the example vendors
  into the `capabilities` table, and that table is what authorises a grant --
  so a later deployment started *without* a vendor file could grant
  `email.send` and then answer `capability.unknown` at call time. The boot
  check now counts against the registry, which is the truer question anyway:
  a row without an adapter is grantable and unusable, which is the state the
  count exists to report rather than one it should hide.

The seventh is smaller and worth the line: a refusal from the catalogue said
only that `email.send` is tier 2, leaving the operator to work out which of
their files said otherwise. It names the file and the entry now, keeping the
original error code.

### The fifth time, and the last one found by hand

`src/main.ts` passed the engine neither an adapter registry nor an
`llm`/`handlers` pair. So `npm start` booted a worker whose `AdapterRegistry`
was empty, and every task it checked out halted immediately with
`runtime_unavailable`, naming the registered runtimes as "none". **The
platform's whole purpose is to run work, and the deployment could run none of
it.**

That is the same defect a fifth time and much the largest. Nothing caught it
because every other test builds its own `Engine` with its own handlers -- the
assembly was, again, the one caller nobody wrote. `src/runtime/assemble.ts`
now reads the environment and registers what it describes: the in-process
runtime when a deployment supplies a model client and handlers, `claude-code`
when a command is named, an HTTP runtime, a container for F12.9's `docker`
backend, a remote sandbox, and F13.3's community CLI specs as JSON. Each is
conditional because each needs something this process cannot conjure, and a
half-configured one is a note rather than a silent absence. A deployment with
none says so at boot in those words, because a worker that can run nothing
looks, from outside, exactly like a worker with nothing to do.

### And a guard, so there is no sixth

Five times is a pattern, and a pattern found five times by review is a pattern
that will be found a sixth. So it is a test now.

`test/documents/reachability.test.ts` reads every exported value in `src/`,
counts how many times its name appears anywhere in `src/` or `scripts/`, and
lists the ones that appear exactly once -- their own definition. Something no
production code mentions is something only a test calls. The scan is textual
rather than a type-aware graph on purpose: a name in a comment counts as
reachable, so it *under*-reports, and an under-reporting guard that runs in two
seconds and needs no toolchain is worth more than an exact one nobody keeps
working.

It found seventy-six, and **the list is an inventory rather than an
exemption.** Every entry is an operation this platform implements and a running
deployment cannot reach, with the reason next to it, in four categories:
`console` (an owner operation with no route -- by far the largest group),
`worker` (something the tick does not do yet), `entry` (an alternative entry
point a deployment calls) and `helper` (a predicate or constant whose callers
inline the same thing). The test fails in both directions: a new orphan must be
justified before it can be committed, and one that gets wired up must be
struck off.

**What the inventory said was worth stating plainly, because it was the largest
honest gap in this build.** The owner's console had nine routes. Behind it sat
around fifty owner operations with none: the spend ceiling could not be set, a
credential could not be rotated, the goal ladder could not be edited, a skill
could not be approved, a task could not be replayed, retention could not be
configured, a device could not be paired, an agent's question could not be
answered. Each was implemented, tested, and enforced by the database, and none
was reachable by the one human who is supposed to run the company. That is not
a vendor account this repository cannot hold -- it is a surface nobody had
built.

### The first half of that surface

Fifteen of them are reachable now, chosen as the ones an owner touches to run a
company rather than to change how it is built: **money** (the ceiling, what has
been spent against it, lifting a pause and bounding an override), **retention**
(the policy and the log of what it purged), **the windows** (the owner's own
hours and a company's batch window), **observability** (capability health, a
company's cost timeline, the platform's cost by company, the governance log, a
task's events), **F12.3's rotation**, **F10.3's answer** to an agent's
question, and **the harder half of F10.7**.

Three of those are worth their own line.

**A rotation takes the owner's device, not their tab.** Rotating is the answer
to "that token leaked", which makes it as irreversible as anything F10.10
gates, and a session minted eight hours ago is possession of a browser tab. The
gate lives on the console rather than inside `rotateCredential`, because
rotation is also what a scheduled job does and a job has no phone: the surface
with a human in front of it is the surface that can ask for one.

**"Stop everything" and "cancel everything" are two buttons.** The existing
route raises a flag the engine reads at every step, so in-flight work stops
cleanly at its next one and resumes when the flag clears -- which is the button
for "something looks wrong". `stopEverything` is the other one: it cancels
every task outright, losing the journal state that would have let them
continue. It had no caller at all. It has its own route now, and a second
factor, because it is not the same decision.

**A constraint the schema states in words is a refusal, not a crash.** The
first version of the retention route answered `500 internal error` when the
database refused to keep prompts for less than ninety days -- and that sentence
was written for a person to read. Several of this platform's rules live in the
schema and nowhere else, so the API now passes a check constraint, a trigger's
own raise, a uniqueness clash and a malformed value back as a 400 with the
database's words. A permission or RLS denial deliberately stays opaque: that
one means this process asked for something it may not have, which is a bug here
rather than a message for the owner.

### And the second half

Twenty-five more, which is the half that changes how a company is *built*:
**the goal ladder** (F2.7, F3.10), **structural changes** (F2.9, F3.9 -- a
grant, a role, an escalation policy), **policies** (F3.4), **skills** (F15 --
listing, review, approval, scope, quarantine, import), **bundles and their
publishers** (F16 -- trust, revoke, install, verify), **the device gateway**
(F12.7, F12.10 -- register, pair, revoke, challenge), **the eval set** (F17 --
cases, the last score, a change request), and the four that had nowhere to
live: pending reviews, schedules, alert thresholds and the export.

Everything F2.9 calls structural takes `ownerApproved`, and this surface is the
only caller in the codebase that may pass `true`. That makes the second factor
the whole of the check: a route that passed `true` off a session would have
made the flag decorative. So a grant change, a role change, a goal edit, a
skill's scope, lifting a quarantine, trusting a publisher and pairing a device
each take the owner's device. Revoking a publisher or a device does not --
those only ever narrow what this installation accepts, and a revocation
somebody hesitates over happens too late.

**Two things a cast would have hidden, and one the tests found.**

`setSkillScope` takes `{ scopeType }`, and the first version of that route
passed `{ scope, scopeId } as never`. It type-checked. Every call would have
widened the skill to an undefined scope -- which is the shape of bug a cast
exists to create. Built rather than cast now, and a division target without an
id is refused by name.

A policy effect and a role change are likewise checked against their lists
rather than cast. An effect the engine does not know would be stored happily by
`putPolicy`, producing a row that reads as a rule and enforces nothing.

And the test helper was wrong about the platform. It got a fresh TOTP code by
adding one to the step number, which works twice: `TOTP_DRIFT_STEPS` is one, so
step+2 is outside the window and the third code in a test is rejected. The
platform was right and the helper was wrong -- a test that needs four codes
needs four minutes, so it moves the clock the verifier reads instead.

### And a review of that block found ten more

The pattern this time is **a value nobody checked**, five times over, and a
**refusal that arrived as a crash**, three times.

- **A revoke that granted.** The route read `revoke` only when no
  `tierOverride` was sent, so `{ revoke: true, tierOverride: null }` became a
  *change* to an unlimited grant. Nothing downstream would have caught it: the
  database's loosening trigger returns early on NULL, so a request to take a
  capability away would have handed it over with no ceiling.
- **A role field of `null` became the word "null".** `String(null)` is four
  letters, and a role whose `model_primary` is the string `"null"` fails every
  later run. This is exactly the hazard `requireText` was written for two
  paragraphs earlier and then not applied here.
- **A threshold of `null` became a threshold of zero.** `Number(null)`,
  `Number('')` and `Number([])` are all `0`, and a daily cost ceiling of zero
  makes the alert fire every day forever.
- **A skill review with no verdict rejected it, permanently.**
  `approved: body.approved === true` made rejection the default, and
  `approveSkillVersion` refuses a rejected version forever afterwards -- so a
  POST that forgot one field destroyed the skill.
- **An escalation could not be set to nobody.** `null` is a real setting for
  `escalation_role_slug`: it means the division does not hold the item at all.
  `coalesce($2, escalation_role_slug)` cannot express it, so the API answered
  `{ ok: true }`, recorded an event, and left the division escalating where it
  always had. Which fields were *given* decides the update now, not which are
  non-null.

Three refusals reached the owner as `500 internal error`, because
`assertValidCondition`, `assertValidCron` and `putPolicy`'s division check all
threw a plain `Error`. A typo in a cron expression looked like a broken
console. They are `PalugadaError`s now, fixed at the source rather than in this
surface, so the chat channel and an operator's script get the same sentence.

And two of the owner's own actions were wrong in different directions.
**Installing a bundle asked only for a session** -- an install writes divisions,
roles and capability grants including tier 3 ones, which is a structural change
by every measure F2.9 uses, so a route without the factor made the gate next to
it decorative. And **an empty goal edit spent a code**: a TOTP code is one-shot,
so an edit with no fields would consume it, write a `goal.changed` event, change
nothing, and leave the owner needing a fresh code for the real attempt. The
emptiness check runs before the factor now.

The tenth was the README, which claimed every one of those routes takes a
second factor. Nine of them do not, deliberately: revoking a publisher or a
device only ever narrows what this installation accepts, and a revocation
somebody hesitates over happens too late. `docs/STATUS.md` had the narrower
list right, so the two documents disagreed -- which is the failure section 2.10
records about F11.2, arriving a second time.

### The same defect one storey up

`reachability.test.ts` reads `src/` and `scripts/`. It cannot see the console,
which is a *page* -- so a route could be built, tested, documented, and still
have no button, which is the same defect wearing a different coat. It had
happened while nobody was looking: **fifty-two of sixty-one routes were
unreachable from the page.** Every operation the two sections above added was
in the API and nowhere a person could press it.

So the console has the rest of what an owner does, behind tabs: **Money** (the
ceiling, what has been spent, lifting a pause or bounding an override, the cost
timeline and every company's cost), **Health** (capability readings, waiting
reviews, the governance log), **Settings** (the owner's hours, a company's
cheap hours, retention and what it purged, alert thresholds, the export),
**Structure** (the goal ladder, grants, roles, escalation, policies,
schedules), **Skills**, **Bundles** and **Devices**. The queue stays first,
because it is the only tab with a person waiting on it.

Two things were generalised rather than duplicated. The factor dialog now takes
*what to attempt* rather than an inbox item, and returns once the thing has
either happened or the owner has backed out -- written that way because a TOTP
code is single-use, and handing one back for a caller to spend later is how one
gets spent on a request that was never sent, locking the owner out of the thing
they meant to do. And the panels are built from a small set of `textContent`
builders -- a table, a fact list, a form -- so twenty forms are twenty
declarations rather than twenty hand-written handlers.

**And a guard, so this does not need finding again.**
`test/documents/console-routes.test.ts` reads the route patterns out of
`api.ts`, reads the paths `console.js` fetches, and lists the ones no button
presses. The list is an inventory in the same shape as the other one:
`machine` (a program is the caller), `flow` (the page reaches it through
another route) or `todo` (it should have a button, and here is what it would
be). Thirteen entries, every one with a sentence.

Its own first version was wrong in the direction that matters. It matched on
paths alone, so a `POST /goals/:id` made a `GET /goals/:id` look pressed -- a
guard reporting a button that is not there is worse than no guard, because it
is believed. The method travels with the path now.

`console-page.test.ts` covers the rest of what nothing else would notice: no
browser runs here, so it checks that every id the script reaches for exists on
the page (a renamed id makes `getElementById` answer null, the next line throw,
and a panel silently never draw -- which looks exactly like a company with
nothing in it), that every tab has a panel and names a function that exists,
and that the script never uses `innerHTML`. That last one is the page's oldest
rule: every title, rationale and consequence on it came from an agent, and
`textContent` makes that structurally impossible to exploit.

What is left on the inventory is nine `console` entries, and they are honest
ones rather than a backlog: **replay** needs `ReplayContext` to carry `signal`
and `awaitChild` before a deployment's own handlers can be replayed through it,
which is engine work rather than a route; `proposeStructuralChange` and
`assertApproved` are the *agent's* path to the same changes the owner now makes
directly; `claimIdempotencyKey` and `assertWithinQuarantine` wait on a device
actually speaking to this deployment; and a budget account, an account chain
and superseding a memory all take a transaction rather than a company id.

### A test that raced the platform and lost, once in seven

CI went red on a commit that had been green locally, and the same tree ran
green here 598 out of 598. So it was a flake, and a flake found once and shrugged
at is a flake that comes back on the commit you actually need to ship. Fifteen
repeats of the file found it: `the deployment can actually run a task` failed
one run in seven with `not_claimed`.

**The platform was right and the test was wrong.** `start()` boots a *worker*,
and the test then called `engine.runTask` on the same row. Two claimants, one
task: F5.11's `FOR UPDATE SKIP LOCKED` means exactly one of them gets it, and
one run in seven the worker was faster. The test was also wrong about the
interesting part -- "the deployment can run a task" is a claim about the
worker, so watching the worker do it is both correct and stronger. It waits for
the task to reach a terminal status now, raced against a ten-second clock so a
regression is one red line rather than a suite that hangs until CI times out.

Fifteen consecutive runs since, and the two mutations that test exists for -- an
engine with no adapters, an in-process runtime never built -- are both still
caught.

### Replay, and the last of the buttons

F11.4's replay was on the inventory with a reason that turned out to be the
finding: `ReplayContext` was a *narrower* interface than `TaskContext`, so a
`TaskHandler` -- the thing a deployment writes and the engine runs -- did not
fit it. The only thing that could be replayed was a handler written for the
replayer. F11.4 is about replaying the platform's own work, and a replay that
can only replay a test fixture is not that.

`ReplayContext` is now `TaskContext`, imported as a *type* so nothing in the
runtime reaches that module -- the guarantee in its own comment, no broker, no
model client, no adapter wired in at all, still holds exactly. It gained a
`signal` that is live and never aborted (an already-aborted one would send
every handler down its cancellation path, which is not the path the recorded
run took) and an `awaitChild` that serves `await:<role>` from the journal.

**That last one was the hole worth finding.** `awaitChild` is the only thing a
handler can do that creates another *task*: the child spends budget and can
call a capability, so a replay that spawned one would be a dry run in name
only. The first version of the test did not cover it -- the mutation that made
`awaitChild` throw passed every test -- so there is one now that runs a real
parent and child, replays the parent, and asserts the child handler ran exactly
once.

The route is `POST /api/companies/:id/tasks/:id/replay`, and it uses the
deployment's *own* handlers rather than a copy. A deployment whose runtime is a
container or a CLI has none this process could call, and a task whose role this
deployment does not carry is a different problem again -- both are named
refusals rather than an empty report.

The nine `todo` buttons are built too: the capability kill switch, resuming a
frozen role, a task's events, the replay itself, the owner's own
authenticators, the weekly retro, freezing a company, rotating a credential,
reading a goal, and a role's eval set with its last score and a change request.

**Two entries stay on that list, and the honest thing was to recategorise
them.** The first version called the WebAuthn challenge routes `machine` --
"the browser's credential API is the caller" -- which was flattering, because
the browser in question is this page. They are `todo`: the platform verifies a
passkey and the console cannot present one. They were not written blind either:
`navigator.credentials.get` needs a secure context and an `rpId` matching where
the console is served, no browser runs in this environment, and code written
here would be an unverified claim in the one place this repository has been
most careful not to make them.

**Both are pressed now** (audit of 2026-09-28, item 24). The registration
ceremony that was missing -- nothing could make a passkey, so the only one a
deployment ever held was one a test inserted -- is `OwnerMfa.enrolPasskey`,
behind a factor the owner already holds; the console signs in with a passkey,
offers one in every confirm dialog, and adds one under Settings, Security. It
was watched working rather than written blind: Chromium with a virtual
authenticator made a passkey, signed in with it, and revoked the authenticator
code with it, in English and Indonesian.

### The boot check found two of its own, and one of the platform's

`npm run smoke` failed twice in a row for two different reasons, which is what
a boot check is for.

**Two authenticators may not share a secret.** The smoke enrolled
`vault://smoke/totp` on every run and left the row behind --
`owner_authenticators` is control-plane data and survives -- so the second run
added a *second* row against the same reference, which resolves to whichever
secret the current process holds. Both rows matched the code, the older was
tried first, and its step was already claimed: the check failed with "that code
has already been used".

That is a platform fault, not just a dirty database. Two rows on one secret are
not two factors; they are one factor counted twice, and the replay defence
turns that into a fault, because `last_step` is per authenticator. In a real
deployment -- an owner re-enrolling the same seed after a reinstall, say -- the
owner would press the right button, type the right code off the right phone,
and be told it is a replay. `enrolTotp` refuses a reference a live
authenticator already holds. A *revoked* one does not block, because replacing
a lost phone is the ordinary case and a guard that forbade it would be worse
than the bug.

The smoke's own half is fixed too: a unique reference per run, and the row
revoked whatever the verdict, so a failing boot check does not leave one that
breaks the next.

**And the new guard immediately found a third thing, in the suite.**
`resetData` truncates `companies` and `capabilities` and lets the cascade do
the rest -- but `owner_authenticators` is platform-scoped, `company_id` is null
for the owner's own phone, and the cascade never reached it. Every test that
enrolled one left it behind. That had been true for as long as the table has
existed and was invisible, because nothing cared about a second row until
`enrolTotp` started refusing one. It is truncated between tests now, through
the *owner* pool rather than the control plane: `owner_authentications` is
append-only to `palugada_admin`, which is the right rule -- a record of every
second-factor attempt that the console's own role could delete would not be
much of a record.

**And it stopped the worker before the thing it was about to assert on.** The
task usually finishes on the first tick and the notification is a later stage
of that same tick, so aborting as soon as the task was terminal cut the tick
before the channel was reached -- "the tick never reached the owner channel",
perhaps one run in three. It waits for both now. A check that fails for its own
reasons is a check people learn to re-run rather than read, which is worse than
not having it.

### Work deferred to cheap hours never ran

The severest thing on the `worker` half of the inventory, and it reads as a
one-line bug: `claimTask` selected `WHERE t.status = 'pending'`, and nothing
anywhere else moved a task out of `waiting_window`. The engine parked a
batchable task with a `wait_until`, the claim could not see it, and there it
stayed -- **for ever, for every batchable task**, which is most non-urgent
work. F9.6's whole purpose.

The index built for the drain, `tasks_waiting_window_ready`, had been created
in migration 0011 and used by nothing. `claimReadyWindowTasks` existed and was
called only by its own tests, which asserted that it *returned the row* -- a
read that proved nothing about whether a worker would ever ask.

Fixed at the claim rather than by a second query: that one already holds the
lane check, the budget check, the priority order and `FOR UPDATE SKIP LOCKED`,
and a separate drain would have been a second, weaker claim -- and the weaker
one is the one that eventually runs two workers on one task.
`claimReadyWindowTasks` is deleted, and its tests now assert through the claim.

The transition map needed the same correction and needed a test to notice.
`waiting_window` did not list `checked_out`, so the map said the claim was
illegal while the claim did it -- `claimTask` writes its UPDATE directly, in
one statement, because the point of that query is that the check and the write
are one operation. The map does not stop it; it only describes it, and a map
that describes the code wrongly is worse than none. The first attempt at the
fix changed the map with nothing asserting on it: the mutation that reverted
the map passed every test. There is one now.

### And the tick did not learn anything

F4.5's distillation and F15.3's screening were implemented, tested in
isolation, and called by nobody. Memory grew without ever becoming knowledge --
episodic events never became semantic facts, repeated facts never became a
procedure worth writing down -- and a skill candidate sat at `candidate` for
ever, because the thing that screens one against its own eval cases ran
nowhere. Neither has a button, and neither should: "the platform learns" is not
a chore for the one human here.

Both need a model, so both are a `learning` option on the worker and absent by
default; a deployment with no model client is told at boot that it will do
neither. Hourly rather than per tick, because distillation reads a window of
events and costs a model call, and every tick would be paying for the same
reading over and over. After retention in the tick, so a sweep that has just
removed expired events is not then read as though they were still there.

The interval guard also needed a better test than the first one. Asserting an
unchanged model-call count over an unchanged event log proved only that the
watermark works -- the mutation that removed the guard passed. New events are
seeded between the two ticks now, and a third worker with the interval set to
zero reads them, so the guard is shown to be a delay rather than a stop.

### The owner could not ask a company for anything

The largest thing left, and it had been invisible because everything around it
worked. The console could approve, configure and inspect. It could not create a
task. Every task in this platform came from a schedule, an event or another
agent -- which is not one human running many companies, it is one human
watching them. F10.11's `assignTask` existed, tested, called by nobody.

It is not just "create a task", either: the role's dormancy is cleared and the
wake is queued as an *assignment*, which is exempt from coalescing and outranks
a schedule. The owner asking for something now and the system answering in four
hours is exactly what F9.8 exists to rule out.

The route requires the goal rather than defaulting it. F2.7 makes every task
hang from one, and a route that picked -- the company's mission, the first row
-- would attach the owner's work to whatever happened to be there rather than
to what they meant. The database refused the first version for exactly that
reason, which is the constraint doing its job.

Three more went with it. **F1.6's budget tree** could not be read or extended:
which account funds a role, the chain above it that a spend also counts
against, and opening a new one -- with the account above it named, because a
ceiling nothing rolls up to is not part of a tree. **F4.6's supersede**: a fact
that turned out to be wrong is replaced rather than deleted, and the old row
keeps pointing at what replaced it, because an agent that read it yesterday and
a person asking why it did are both better served by a chain than by a hole.

### And two things that happened silently

**F1.3: a denial that leaves no trace.** The database refuses a capability that
reaches past its own company -- that has been true and tested for a long time
-- but `reportRlsDenial` existed and nothing called it. The refusal was a
failed tool call and nothing more, so repeated probing looked exactly like a
flaky adapter. Recorded in the broker rather than swept later, because that is
the only place that knows which capability, task and division tried it. The
error still propagates: this adds a record, it does not swallow anything.

**F10.6: a digest nobody received.** `renderDailyDigest` turned a digest into
text and nothing sent it. The console draws its own, so an owner looking at the
console saw one and an owner who was not looking never did -- and the
requirement asks for a digest, not for a panel.

A digest is not an inbox item: it has no id and nothing decides it, so
`OwnerChannel` gained an optional `deliverDigest` and `owner_notifications`
gained a `digest_day` with a check constraint that a row is exactly one of the
two. Once a day per company per channel, enforced by the uniqueness rather than
by a read followed by a write, so a worker restarted twice in an afternoon
sends one. *Yesterday's*, not today's: a digest of a day still in progress is a
partial count that changes if you read it twice. Redacted like everything else
that leaves this process, because a digest is assembled from what agents did
and an agent can put anything in a title.

### And a review of that found nine, two of them made by the fixes themselves

**A fix that created a hot loop.** Widening the claim to `waiting_window` made
a task parked with a *null* `wait_until` claimable immediately and repeatedly:
claim, run, re-park, claim, up to the whole tick budget, paying for an agent
run each time round -- with `madeProgress` suppressing the sleep because runs
kept happening. The engine parks that way when the window it is waiting for
has no next opening, which is a misconfiguration the platform has to survive
rather than spin on. A parked task with no wake-up time stays parked now; a
*pending* one with no `wait_until`, which is most of them, stays claimable.

**A fix that gave one division another's memory.** The learning stage loops
divisions, and distillation's watermark was keyed on the *project* while the
memory it writes is scoped to a *division* -- and a company has one project and
several divisions, which the standard template says outright. So the first
division by slug consumed the whole event window, every other division read
zero events for ever, and everyone's work became the first one's private
knowledge.

That is a mismatch in `distillEpisodicToSemantic` rather than in its caller,
and the fix is that both ends now agree what a scope is: the read joins tasks
and filters on the division, and the watermark is keyed on it. An event with no
task belongs to no division and is skipped -- it is the company's, and there is
no division-scoped fact to draw from it. Every test in that file had been
seeding task-less events, which is exactly why one division was enough to hide
this.

Seven more:

- **Screening did not need a model and was gated behind one.**
  `runSkillEvals` is substring matching against the cases the skill declares.
  A deployment with no model client never screened a candidate, and the boot
  note blamed the missing model for something that never needed one. It runs
  first now, and the distillation half returns early.
- **A failing digest lost the day.** The claim is written before the transport
  is called -- right, and what every item delivery here does -- but
  `retryFailed` inner-joins `inbox_items`, so a digest row is invisible to it.
  One restarting relay lost that day for ever, and aborted every later channel
  in the array. The failure is recorded on the row now (`DELETE` is not the
  tenant role's to make, and a log of what the owner was told is not something
  the console's own role should be able to erase) and `retryDigests` comes back
  to it with the same backoff and budget.
- **The digest was built before the once-a-day check.** Several aggregates over
  a day of events, run every tick and thrown away on a uniqueness conflict --
  a query a minute, all day, for one message. `digestOwed` is asked first.
- **Supersede hardcoded `semantic`/`company`.** Correcting a division's
  procedure superseded the old one and wrote something that was not a
  procedure, so `recall` found neither and the SOP vanished from every agent's
  context. A correction that deletes what it corrects is the worst possible
  shape for this. The replacement takes the original's type and scope.
- **And supersede never checked that it matched a row.** A wrong id left the
  replacement in place as a second, unlinked fact while the stale one stayed
  active: the platform believed both, and the caller was told it was fixed.
- **The budget lookup omitted the project** while `createRootTask` passes it,
  so with a project-scoped account the console named the company account
  rather than the one the work is charged to -- the one thing an owner reads
  that route to find out.
- **Opening a budget account took no second factor.** It sets a ceiling, which
  is money: the same decision as the spend limit, and a session is a browser
  tab.

### F8.11 was enforced against agents that could not comply

The broker refuses a tier 2 action on a task with no plan. The only way a plan
reached a task was `recordPlan` -- called by a test fixture and nothing else.
The wire protocol between the engine and a runtime carries tool calls; **there
was no tool.** So every real runtime -- `claude-code`, a CLI, a container --
would have hit `plan.required` on its first tier 2 action with no move that
could satisfy it. A requirement enforced against agents with no way to obey it,
and the suite never saw it because the fixture wrote the plan directly.

`plan.record` is a platform capability now, beside `memory.search` and
`skill.read`, for the same reason they are: the platform is the thing that has
the task. Tier 0, because recording an intention changes nothing outside this
database -- it is the *statement* the tier 2 gate then holds the run to. It
goes through the broker like everything else, and `recordPlan` still refuses a
second plan, so a run cannot rewrite its intentions after seeing how the first
step went. That is the whole value of F8.11: a commitment made before the
actions, not a description written after them.

### One rule, two implementations

`applyRoleChange` opened with an inline `throw` saying, in different words,
what `assertApproved` says -- and `assertApproved`, written for exactly this,
had no caller. Two statements of one rule is how they drift, and the one that
matters is always the one nobody re-read. It calls it now.

### And the owner could not start a company

"One human runs many companies" is what this platform is for, and the console
could not make one. A company arrived through the seed script or the boot
check, so the owner's second company needed a terminal.
`createCompanyFromTemplate` was called by those two and nothing else.

A structural change if anything is -- divisions, roles, grants and a budget
tree in one transaction -- so it takes the owner's device, like every other
one.

Building it surfaced something worth stating: **the standard template cannot be
instantiated by a deployment that has not bound its capabilities.**
`createCompanyFromTemplate` refuses to grant a capability the broker cannot
run, which is right -- a company whose agents are refused the moment they try
to work is worse than no company -- but the standard template grants
twenty-five, sixteen of which need somebody's account. That refusal was a plain
`Error`, so it reached the owner as `500 internal error`; it is a typed refusal
now, and it names exactly which capabilities to bind first, which is the
sentence somebody acts on.

### What is actually left

No push service, no bot token, no sandbox vendor, and none of F13.3's four
binaries exists in this environment. That is the whole of the remaining gap and
it is a fact about this machine rather than about the code. What the suite
covers is every decision the platform makes before a request leaves — which
items may ring a phone, what a chat may offer a button for, which second
factors verify, whether a sandbox is destroyed on every path out. What nobody
here can check is whether the vendor on the other end agrees about a field
name, and no amount of writing would change that.

## 2.16 Other systems' failures, looked for here

Every audit before this one asked a question about this code. This one asked
four other systems what went wrong for them -- Slack, Buzz, auto-company and
Paperclip, read at fixed revisions -- and then looked for each failure here.
[`RESEARCH-2026-09.md`](RESEARCH-2026-09.md) has the full table with a file
and line for every piece of evidence. Ten of the failures were here too, and
looking for them turned up two more of this repository's own. None had been
found by §2.2–2.15.

### A decision and the task it releases were two transactions

Buzz commits an approval and then resumes the workflow from a detached task,
so a crash between the two leaves the run waiting for ever
(`command_executor.rs:1100-1116`). `inbox.decide` did the same thing: the
item's UPDATE committed, then `transition()` opened a second transaction. A
crash between them recorded the owner's answer against a task that stayed in
`waiting_approval` — with nothing open in the inbox to say so, because the item
was already decided. `requestApproval` and `expireOverdue` had the same split
the other way round.

All three are one transaction now, through `transitionWithin`, and all three
take the task row before the inbox row — the order the stop button's trigger
takes them in — so a decision racing a stop waits for it instead of
deadlocking. The property the test pins is the one that was missing: when the
state machine refuses the move, the decision is rolled back with it, and the
item is still the owner's to answer.

### `transition()` could overwrite a stop

It read the status, checked the edge, and wrote — two statements, no lock. A
cancellation that committed between them was simply written over: the check
had seen `running`, so `completed` went on top of `cancelled`. The row is
locked before it is read now. The test holds a cancellation open, lets a
transition start, and commits; before the fix the task ended `completed`.

### Approvals outlived their tasks, and the stop button missed two statuses

An approval exists to unblock one task. When that task ended another way, the
approval stayed open — in the inbox, and in every chat it had been sent to —
asking consent for something that could no longer happen. A trigger now
withdraws it (`status = 'withdrawn'`, `closed_reason = 'task_cancelled'`) on
every edge into a terminal status. A trigger rather than code in
`transition()`, because the stop button is a bulk UPDATE that never calls it;
only approvals, because an escalation or incident is usually *why* the task
ended.

The stop button itself cancelled `pending`, `running`, `waiting_approval` and
`waiting_review`. The state machine has six live statuses: a claimed task and
a task parked on a window survived, held only by the flag and back to work the
moment it was cleared. And every task it did cancel kept its token reservation
and its lease, because the bulk path skips `transition()` — after a stop, every
reservation in the platform was budget no task could use again. It is the
complement of the terminal set now, and it does in bulk what `transition()`
does one task at a time.

### A decided item kept its buttons

Slack's best-known human-in-the-loop defect: a message with Approve on it that
nobody updated after the decision. Migration 0032 stored `external_ref` "so a
later edit or deletion can find it", and nothing edited. `retractClosed`
rewrites every delivered chat message whose item has closed, with the same
exactly-once record, attempt bound and backoff as the send. Telegram's
`editMessageText` without a keyboard removes the buttons in the same call; a
deleted message counts as done, not as a failure to retry. A press that still
reaches a closed item is told what happened to it — "already decided (deny)"
— instead of "could not be recorded". Push has no buttons and no `retract`:
a second notification to say the first no longer matters is the notification
overload the rest of F10 exists to prevent.

### A runtime was a process, not a process tree

auto-company runs its agent under a supervisor that takes the whole process
tree, escalates SIGTERM to SIGKILL, confirms the tree is empty, and refuses the
next cycle when it cannot (`process-supervisor-linux.py`). All three spawning
adapters here sent SIGTERM to the direct child — and only if that child was
still alive, so a CLI that finished and left a dev server behind was never
cleaned up at all. `src/runtime/process-tree.ts` puts the child in its own
process group, signals the group, waits, kills, and checks `/proc` so that a
zombie reparented to a PID 1 that never reaps does not read as alive. A group
that survives SIGKILL is remembered, and the adapter's health check reports it
until it is gone — F13.8's existing refusal is the fail-closed half. What it
does not catch is a grandchild that calls `setsid()` to leave the group;
auto-company catches that with `PR_SET_CHILD_SUBREAPER`, which needs native
code this runtime does not have.

### Cancellation and deadlines never reached a quiet runtime

The engine withdraws a run by aborting a signal, and the CLI adapters'
response to that was nothing: "a cancellation reaches it as the killed process
below", and the kill was in `close()`, which runs when the output stream ends.
A runtime that had gone quiet was waited on for as long as it chose. The same
was true of time: `limits.wallClockMs` was computed from the task's deadline
and sent to every runtime, and enforced by none — the engine checks the
deadline before each step, which does nothing against a runtime taking no
steps. Abort now ends the tree at once (a script gets a grace period to act on
`cancel` first), and `driveRun` holds a timer for the task deadline that tells
the runtime and then ends it. The engine is told `deadline.exceeded` even when
the runtime died mid-line and left garbage, so the task halts as
`deadline_passed` rather than spending an attempt overrunning again.

### "Not now" was read as "no"

A vendor's 429 became `contract.violation`, the engine retried it on its next
tick a few seconds later, and three ticks spent the task against a limit that
had not lifted. Slack has allowed most apps one history call a minute since
May 2025; a platform that cannot wait a minute cannot use it. `rateLimit()`
reads `Retry-After` (seconds or an HTTP date), `RateLimit-Reset` and
`X-RateLimit-Reset` (as an epoch when it is one — read as seconds, an epoch is
fifty-six years), and a 503 only counts when it says when. The engine parks the
task in F9.2's `waiting_window` until then, spending no attempt, bounded at six
hours and five parks so a vendor cannot hold a task for ever. The division's
own hourly allowance was the same case from the inside and now names the
moment its oldest call ages out. A read-back waits a short limit out in place
instead: parking after the write would leave it unjournalled and the resumed
task would write again, and giving up reported a successful write as a failed
one, which halts the task and raises an incident.

### An estimate of nothing

F13.7's estimate for a runtime that reports no price was `usage.costCents ??
0`, marked as an estimate. Every agent CLI reports tokens and no price, so the
money half of F1.7 never moved in the configuration that runs in production,
and the test counted the mark rather than the amount. Paperclip has the same
defect by design; auto-company refuses to count unknown cost as zero. The
engine now prices unpriced usage from the operator's list
(`PALUGADA_MODEL_PRICES`), and anything the list does not name at a fallback
chosen to be the most expensive rate on the market, so the error is always in
the direction of stopping early. The deployment test runs a task through the
worker `npm start` builds and checks the company's money moved by exactly what
the example file says, because a price list the engine never receives would
be the sixth piece of machinery here that worked and was assembled by nobody.

The estimates are what let a budget stop a run while it is still running, so
they stay; the bill replaces them when it arrives. Claude Code's final
`result` line carries the provider's own total (`total_cost_usd`), the adapter
reports it as a usage marked `runTotal`, and the engine settles the difference
between what the run was charged and what it cost, in either direction, and
records `cost.settled`. The test runs a CLI that bills 42 cents after being
estimated at one and expects 42 on the account, not 43.

### A usage report was cast, and it is the one that moves money

`parseRunEvent` read a runtime's `usage` with `as never`. Every runtime that
is not this process arrives through it, and `budget_spend` adds what it is
given: a report of minus forty dollars took forty dollars off the company's
recorded spend and the run completed normally, and negative tokens did the
same to the token ceiling. A third party's output is parsed everywhere else in
that function; this one message was not, and it is the one with a price on
it. It is checked at the wire now, and again in the engine, which is the
accounting authority whichever runtime reported -- the in-process one never
crosses the wire at all. Each layer has a test that fails with the other one
still in place.

### A settlement reached one account of the chain

Found while wiring the estimate, and older than this round. 0024 made spending
inheritable: `budget_spend` charges an account and every ancestor. The broker
refunds a failed action's estimate, and settles an actual cost against it,
through `budget_settle` -- written in 0009, before accounts had parents, and
never updated. So a refund came back to the division and stayed charged to the
company, and every failed action left phantom spend on every account above the
one that paid; an overrun reached the division and not the company, which
undercounted exactly the spend it most needed to see. Migration 0037 settles
the chain, under the same lock order as the charge.

And under that, a second: 0009 says an overrun "becomes a visible overspend
rather than a quiet understatement", and 0003's CHECK forbade any spend above
the ceiling, so the settlement meant to record it raised a constraint
violation instead -- after the vendor call, as an error from an action that
had happened, which the engine would then have retried. The CHECK is gone;
admission is enforced where it can still change the outcome, in
`budget_spend`, and the test shows both halves: the overrun is recorded above
the ceiling, and the next charge is still refused.

### And a net under all of them

Paperclip states a contract its code enforces with a sweep: every task that
is not finished has a typed "next mover" -- a worker, an open decision, a
reviewer, a clock -- and a task found without one is put to a human rather
than silently reassigned (`doc/execution-semantics.md` §8-9). This round
found three separate ways of losing the mover here, and each was fixed where
it happened; `src/engine/liveness.ts` is for the ones not found yet. A task in
`waiting_approval` with no approval or escalation open, in `waiting_review`
with no review pending, or in `waiting_window` with no time to wake at -- the
last is a state a test in this repository asserts "stays parked however long
anyone waits", correctly, and nothing ever told the owner it was there -- is
put to the owner once, as an escalation. The answer is the repair: `decide`
already moves an escalation's task to `running` on approve and `cancelled` on
deny, and all three statuses have both edges. An escalation rather than an
incident because nothing is on fire, and an open escalation is itself a mover,
so the task is not reported again while the owner thinks about it. Two workers
that find the same task raise one escalation between them: the record is
written under the task's advisory lock, and the test holds that lock in a
second transaction to prove it.

### A schedule that could not fire said so every five seconds

`runDueSchedules` leaves a schedule it could not fund where it is, so the
occurrence fires the moment the owner raises the budget -- right -- and it
recorded the failure on every pass, which the worker makes every few seconds:
about seventeen thousand `schedule.fire_failed` events a day, per schedule,
into a log retention keeps for a year. A log that repeats itself every five
seconds is one nobody reads, which is Slack's notification lesson applied to
an audit trail. Migration 0038 lets the schedule remember which occurrence
last failed and why; the event is written when that changes, the retry still
happens every pass, and a successful fire clears it.

### A decision left the only screen the owner has

Slack's most repeated complaint is not about sending a message; it is that a
decision made in a thread cannot be found a month later. This platform
avoided the first half by design -- a decision is a structured row, not a
message -- and reproduced the second: the console drew open items and nothing
else, so an answered one disappeared, and the record lived in the event log,
which is an audit trail rather than something a person searches. The History
tab lists what closed, newest first, with the outcome, the surface the answer
came from (`decided_via`, migration 0039, which was in the event payload and
nowhere a list could read), and the owner's own note -- and searches that
note, because it is where the reason was written and the reason is what gets
looked for. A search for "50%" means fifty percent, not every item with a 50
in it. It pages by `(created_at, id)` rather than by offset, the way Buzz
pages its threads (NIP-CW), so a page boundary holds still while new items
close; the page marker is the owner's input on the way back and is refused
when it is not one the history issued.

### `npm start` started nothing, and the owner could not have signed in

Found by looking for auto-company's "a config error must not crash-loop the
daemon" and running the command to see what it did. `package.json` has run
`node src/main.ts` since the deployment file was written, and the README says
it serves the worker and the console on :8787. The module exported `start()`
and called nothing: the command loaded it and exited 0. Every test calls
`start()` itself and the smoke check builds its own assembly, so the one
caller nobody wrote was the process -- the sixth time this repository has
found machinery that works, is tested, and is assembled by nobody, and the
first time the nobody was the entry point.

Fixing it showed the next thing a real start would have hit. The only
`SecretManager` was the in-memory one, "for development and test", and
`start()` fell back to it: empty, and forgotten on restart. So no vendor
credential could resolve, and the owner's own factor -- a secret reference
like any other -- had nowhere to live; with no enrolled factor the console,
which takes a code to sign in, could not be entered at all.
`src/secrets/local.ts` resolves `env://` (only `PALUGADA_SECRET_*`, so a
credential reference can never read the platform's own `DATABASE_URL`) and
`file://` (only under the secret directories, after symlinks). Boot enrols
`PALUGADA_OWNER_TOTP_REF` once; `npm run totp:new` prints a secret and the
link for an authenticator app. A configuration the deployment cannot use
exits 78, which `deploy/palugada.service` tells systemd not to restart, and
SIGTERM stops it the way `stop()` does.

The test runs the file as an operator would: a child process with its own
environment, a TOTP code computed from the secret it was given, a sign-in that
has to succeed, and a SIGTERM that has to end in exit 0. Five configurations
that cannot be used have to end in 78, each saying which.

### A gate that opened when it could not read its own rules

Paperclip's code has 318 empty or swallowing `catch` blocks, and the audit
report's point was not the count but that a few of them sit on paths that
decide things. This repository has 47, so each was read. Forty-six are what
they say: a line that does not parse, a signature that does not verify, a
cleanup that is best-effort. One was a gate. When a company's bundle hooks
could not be read, the hook pipeline fell back to the built-ins alone -- and
its comment called that "the safe direction", because the built-ins are the
ones a company cannot remove. It was the other direction: a bundle hook can
only tighten, so losing one loses a *restriction*, and a company that
installed "never email outside our domain" had that rule silently absent for
as long as its bundles could not be read. The empty list was also cached, so
one failed query switched the rule off for a minute. The pipeline already
treats a hook that throws as a refusal, "because otherwise the easiest way
past a gate is to break it"; hooks that could not be loaded are treated the
same way now, and the failure is not cached, so the gate stays closed exactly
as long as the fault does.

### A failure CI saw and this machine did not

The commit that added the liveness sweep failed on the CI runner in two
distillation tests it did not touch, and passed here and on the next push.
Neither was re-run until green: a failure that comes and goes is a failure
with a cause. The distiller bounded its window with `new Date()` -- this
process's clock, in milliseconds -- against `occurred_at`, the database's, in
microseconds, so an event written in the same millisecond the pass began and
a few hundred microseconds later fell outside it. Not lost: the next pass
read it, which is exactly what the watermark test then saw. On a fast runner
the seed and the pass land in one millisecond often enough to fail one run in
a few. The window is bounded by the database's own `now()` when the caller
gives no bound, and a test pins the process clock to the event's millisecond
with Node's mock timers, which fails every time against the old code. The
trajectory export had the same shape one step removed -- `finished_at` read
into a Date and sent back as the bound, so a run's last event, in its last
microsecond, was not in its own trajectory -- and bounds against the row in
SQL now.

### Two replicas were one worker

Paperclip keys run ownership on a per-boot id rather than a PID, because a PID
is reused (`legacy-controller-lease.ts`). The deployment here named its worker
`worker-${pid}` -- and every replica of a container image is usually PID 1, so
two replicas had one identity, and each could renew and run the other's
claim, which is the one thing F5.11's lease exists to prevent. The engine's
own default was already a random id; the deployment replaced it with a worse
one. It is `worker-<host>-<pid>-<boot id>` now. Two deployments in one process
share a PID as well, which makes the collision reproducible: the test claims a
task as one and has the other try to run it, and the old name lets it.

### A schedule does not notice when it has stopped being useful

auto-company stops a loop whose "next action" is the same two cycles running;
Paperclip throttles an agent whose runs leave no visible trace. Both are the
same observation -- work that repeats itself exactly has usually stopped
earning its cost -- and PRD §2.3 lists Paperclip's surprise bills from
aggressive heartbeats as a defect this platform answers. A schedule here fired
for ever whatever it produced. When a schedule's last five runs all completed
with byte-identical output, the owner is asked once, as an escalation about
the schedule: deny turns it off in the same transaction as the decision, and
approve keeps it and is not asked about that same result again. It asks after
the occurrence has fired, never instead of it -- whether a schedule is worth
paying for is the owner's question, and one that stopped itself on a guess
would be the platform deciding it.

Writing its test found one more of today's precision defects. The scheduler
advanced a schedule with `WHERE next_run_at = $2`, where `$2` was the column
read out through a JavaScript Date. A `next_run_at` with microseconds in it
-- set by hand, or by anything but `nextOccurrence` -- never equalled its own
rounded copy, so the schedule never advanced and fired its occurrence on every
tick. It is compared at the millisecond now.

## 2.17 This platform's own defects, looked for on purpose

After the comparison with other systems, the same scrutiny was turned on this
repository: three independent reviews -- the execution core, the data layer,
and the owner's surface -- each told to find what would fail under a second
replica, a crash, or somebody hostile. Every finding below was reproduced
before it was fixed, and each fix is held by a test that fails without it
(checked by reverting the fix, not by reading the test).

### An approved action never ran

The broker never asked whether the owner had already said yes. An approved
task resumed, reached the same capability, found its item closed, raised
another and parked again -- so an irreversible action the owner approved
never happened, and every approval produced another request for one. An
approval now carries the fingerprint of the action it describes (0041); the
broker lets a decided, unconsumed approval for this task, capability and
fingerprint through, and marks it consumed once the action has executed. A
changed proposal supersedes the open item instead of hiding behind it.

### Two workers could run one task

Four ways, which combined: a tick claimed with the clock it read at its
start, so a late claim's lease was already over; the lease was renewed only
when a step committed, and a failed renewal was ignored; a resumed attempt
kept its first start time and was swept as orphaned; and a task past
`pending` ran without being claimed at all. Leases now run from the wall
clock, a `LeaseKeeper` renews them while a run is in flight -- bounded by the
run's own limits, so a hung handler still loses its task -- every step
confirms the lease before its side effect and before its commit, and
`runTask` adopts a lease in one conditional write. A worker that lost its
task commits nothing more and does not classify the task.

### Replay trusted position alone

A committed step was handed back to whatever asked at its index. A handler
that branched differently on a retry got another call's answer, and a model
fallback carried on counting steps from where the failed run stopped. A
mismatched step now halts the task (`journal_divergence`); the fallback
restarts the count, so identical steps replay and the rest run in place.

### Delegation could not survive a retry

A parent retried or resumed asked for the same child again and failed on its
key every time; a child's first retryable failure was treated as final and
halted with the reason "deadline passed". The parent now picks its child back
up and drives it to its end, bounded by the child's own recorded deadline.

### The owner's second factor

A success anywhere in the lockout window reset the count of failed guesses,
so the quarter hour after the owner signed in was unlimited guessing; and a
burst of guesses all read "no failures yet" at once. Each verification is now
one transaction under a lock, failures count from the last success, and a
refusal that compared nothing does not count. A revoked factor was enrolled
again by the next boot; a secret can back only one live factor; a device can
be revoked from the console, ending its sessions; loosening a control --
lifting a stop, unfreezing, reviving, raising a ceiling, writing a policy --
takes the factor, while tightening one takes only the session.

### Money read from the wrong place

A CLI's own total settled the budget accounts and nothing else, while every
spend guard and report read `llm_traces`; the settlement is a trace now
(0043). A fallback's total erased the failed attempt's bill; each model call
drew the task's whole reservation from the chain; a fraction of a cent
failed the run on a bigint cast. All fixed where the money moves.

### Time

`setTimeout` fires at once past about twenty-five days, so a task due in a
month was cancelled as overdue when it started. The decision history's page
marker dropped microseconds, so items fell between pages. A zone `Intl` does
not know was stored, and broke every notification afterwards.

### The data layer

Every tick scanned whole tables for spend, orphans and metrics (0042 adds the
indexes). Handoffs re-read every completion ever and repeated a final
refusal every tick (a ledger, 0042). A company-wide policy "updated" by
inserting a second row, because its unique key treated NULLs as distinct
(0044). An archive with a corrected fact or a withdrawn approval could not be
restored, and a failed import left half a company behind; import is one
transaction now (0045). Retention reaches the journal's copies of model
replies and the bookkeeping tables (0046). An archive left columns behind --
a credential's scopes, a goal's status, a division's escalation policy, the
charters, the distillation watermark -- and is now compared column by column
with the database, so a column added later travels or is named as staying
behind.

The application role could do anything to anything inside its own company:
clear its freeze, raise its own ceilings, rewrite the traces its spend is
summed from, delete history. Its grants are now what the code writes,
established by logging every statement it ran across the suite (0047). Row
security never kept a row from *pointing* into another company, because a
foreign key is checked past it; every reference between tenant tables is on
`(company_id, id)` now (0048). A schedule's priority reached nothing, and a
task knew its schedule only by the text of its key (0049).

### The owner's surface

Sessions were held in each process's memory, so a second console replica
answered "sign in first" to a token the first had issued, and a device revoked
through one process stayed signed in on the other. They are rows now, stored
as the token's hash (0050), and a revoked device is checked on every request
rather than remembered by whoever revoked it. The console answered to any
`Host`, so a page on a name rebound to 127.0.0.1 reached a loopback console as
same-origin; it answers only to its own names now. Pairing a runtime device
named an id, and a re-registration keeps the id and swaps the key -- so the
key trusted was whichever registered last. A pairing now carries the key's
fingerprint as the owner compared it with the machine, a full SHA-256 of the
key that OpenSSL can reproduce, and a revoked device is not paired back.

### Not changed, and why

References into `events` keep their single-column foreign keys: they record
where a memory or a decision came from, no request supplies them, and a second
unique key on the largest table is the wrong trade for that. Events written
before pairing named the key carry the older, shorter fingerprint of the PEM
text; they are history, and are left as written.


## 2.18 The first two CLI entries were wrong in every flag

The `hermes` and `openclaw` entries were written from what the two CLIs say
they do, and section 2.12 said so. Reading their source (Hermes Agent at
d0288be, OpenClaw 2026.9.6 at 6209f31) found that neither would have started:

- Hermes has no `run` subcommand and none of `--headless`, `--max-steps`,
  `--mcp-config`, `--tools` or `--output`; argparse exits 2 on the first. Its
  one-shot is `chat --oneshot --query-file -`, and it takes MCP servers only
  from `$HERMES_HOME/config.yaml`.
- Worse, its `stream-json` is its own: the final line has no `subtype`, the
  answer is in `text`, the tokens in `tokens`. Read as Claude Code's, every
  Hermes run would have ended "as unknown" — a failure — however well it went.
- OpenClaw's root command has no `--mcp-config`, `--no-builtin-tools` or
  `--prompt`. Its headless form is `agent exec`, which by default turns on a
  shell and file tools: F13.4 needs a pinned configuration that narrows it to
  the MCP bundle.

All three CLIs read MCP servers from their own configuration format, so the
adapter could not have placed the bridge for any of them. `CliRuntimeSpec`
therefore gained `files`, written 0600 into a private run directory, and
placeholders in `env`; the bridge may be placed in arguments, environment or
files. The token lives only in the child's environment and each configuration
names it through the CLI's own substitution. `HOME` is the run directory,
because a child with only `PATH` falls back to the operator's home and its
stored credentials. Three output dialects were added
(`src/runtime/cli-dialects.ts`), and each spec is driven end to end against a
stand-in that reads its bridge from the spec's own files in the CLI's own
format and answers in the CLI's own output. What remains is to run each once
against the real binary.

## 2.19 Goals were measured in effort

Reading auto-company's source next to this one made a gap plain. There, every
cycle starts from numbers: revenue, customers, what a price change did. Here,
a key result's progress was the share of the tasks under it that had finished.
That measures effort, and it does not compare: ten tasks done in a company that
is losing money is not ahead of two done in one that is growing, and comparing
companies is what one owner with several of them has to do.

Migration 0053 adds `goal_metrics` and `metric_observations`
(`src/domain/metrics.ts`):

- **The owner sets the measure**: a unit, which way is better, a baseline, a
  target, a date, and optionally the capability whose answer is the number.
  The application role can read a metric and cannot insert or change one, nor
  change or delete a recorded value.
- **A run records a value with `metric.record`**, a tier 0 platform capability,
  and the value is **verified** only when the same task has a committed call to
  the metric's source capability whose result contains that number. Otherwise
  it is kept and shown as the agent's claim. This is the read-back rule of F8.4
  applied to results instead of writes.
- **Every run under the goal is told** the measure it serves, where it stands,
  and whether that standing is verified (`src/context/builder.ts`).
- **The owner sees it** in three places: under each goal on the goal ladder,
  where a value can be recorded; on a company's overview; and on the portfolio,
  where each company shows the first measure on its highest active goal. A
  company with nothing measured shows nothing there rather than being ranked
  on effort.
- Both tables travel with the company in the export and the import.

The same work found a defect. The standard template granted `memory.search`
and `skill.read` to every division but not `plan.record`, which a tier 2 grant
requires a run to have called first. So every tier 2 grant in a company made
from the template was unusable. `plan.record` and `metric.record` are now in
the template and in the catalogue.

## 2.20 Read against Buzz, Paperclip and auto-company

Their source was read next to this one, feature by feature, and each gap was
checked by grepping this repository before it was called one. The ones that
mattered most to one owner running several companies are closed here; the
rest are listed at the end.

**Defects**

- *Telegram's Ask button asked the agent "via chat".* The press decided the
  item at once with that note, and the next run was told the owner had asked
  it "via chat". The press now asks the owner for the question with a reply
  box, and the reply is what is recorded.
- *A runtime in another process could not be told to wait.* A tier 3 call, a
  review or a closed window is a throw that ends an in-process run. An agent
  CLI was told it as a refused tool call, carried on, and said `done`; the
  engine tried to complete a task waiting for the owner and threw out of
  `runTask` with the approval open. The engine now keeps the first "wait",
  withdraws the run and parks the task on it.
- *A parked task kept its worker's lease.* A task waiting for an approval, a
  review or a window still named the worker that parked it, so once the owner
  approved, no other worker could resume it until the lease ran out. Parking
  now clears the lease.
- *Company restore could not be reached.* `importCompany` was called only by
  tests while the README promised a restore.
- *F3.9's rollback was half built.* Every change to a charter, a policy or a
  role was recorded as a version, and `history` and `restore` had no caller;
  `restore` returned a snapshot for a caller that did not exist, so nothing
  was ever put back. `src/governance/rollback.ts` now makes a version live
  through the write path a change takes, so the rollback is a version and an
  event of its own. The console shows a role's history in its drawer and the
  company's policies -- which it could write and not list -- each with theirs,
  and putting one back takes the owner's device.

**What the owner can now do**

- See what a task produced: a one-line result on the work list, and the whole
  output and every committed draft, redacted, on the task
  (`GET /tasks/:taskId`); Home lists what was just delivered.
- Cancel one task and what it started; do ended work again with a note;
  tell a live task something its next run reads; pause one role
  (`src/engine/owner-control.ts`).
- Restore a company from the console's export, with a preview first and the
  owner's device to apply, or with `npm run company:import`.
- Be asked. `owner.ask` lets any runtime put a question to the owner and park
  until it is answered, from the console or a Telegram reply. A question may
  offer two to six answers, and the owner answers with one press on either
  surface; the text is read from the item, never from the button.
- Read what a run is saying as it works. An agent CLI's narration was thrown
  away by the wire; it is now kept per run (0055, `src/engine/transcript.ts`),
  redacted before it is stored -- including a secret the runtime assembled
  itself -- each line bounded and each run's narration capped, and the task's
  drawer shows it, refreshing while the task is live.
- Have work split by whatever runtime does it. `task.delegate` hands part of a
  task to another role as a sub-task with a deadline, under the hop limit, the
  fan-out cap and the parent's budget; `task.await` reads its contained result,
  and while the child works the parent parks and looks again every few minutes,
  holding no worker. `awaitChild` had done this for in-process handlers only.
- Install the operating kit (`company-os` in `src/bundles/builtin.ts`): a
  strategist that proposes at most three bets and applies none, eight
  operating skills with evals that go through review and the owner like any
  other, and the weekly business review as a schedule on the company's own
  clock -- bundles can now bring recurring work (`cadences`), made switched
  off when the bundle is quarantined.
- Let another service start work (0054, `src/scheduler/triggers.ts`): a
  trigger URL the owner opens with their device, a bearer token stored only
  as its hash, one task per delivery however often it is retried, an hourly
  limit, and the event handed to the run as untrusted data. A restored
  trigger arrives closed, at a new address, with no token.
- Let the senders that sign start work (0056): a trigger's `scheme` is a
  bearer token or the signature of GitHub (`X-Hub-Signature-256`), Stripe
  (`Stripe-Signature`, several `v1` while a secret rolls), Slack (`v0`) or
  Standard Webhooks (`webhook-*`, and Svix's `svix-*`), each an HMAC over
  the bytes that arrived, with the secret read from the deployment's secret
  store by reference -- the same rule as every other credential. The signed
  time is held to five minutes either way. The delivery key is taken only
  from what the proof covers: GitHub, Stripe and Slack do not sign a
  delivery id, so a replayed body under a new id is still the same delivery.
  Slack's URL check and GitHub's ping are answered and start nothing. A body
  may be JSON, a form or text; anything else is refused with 415. A secret
  the deployment cannot read answers 503 and tells the owner, rather than
  letting a delivery in unchecked. Found on the way: a bearer delivery took
  `X-Request-Id` as its delivery id, which a proxy stamps fresh on every
  request, so a sender's retry started the same work twice; it is no longer
  read.
- Decide several items in one press (`decideMany` in `src/inbox/inbox.ts`,
  "Choose several" in the inbox): approve or deny up to fifty, each through
  the same `decide` an item gets alone, with a shared batch id on every
  decision's record and one `owner.decided_batch` event. A tier 3 action, a
  run's question and an incident are never approved in a batch -- they come
  back unapproved with the reason and stay in the inbox -- and any of them may
  be denied, because no is never the dangerous direction.
- Stage gates (0057, `src/domain/stage.ts`): a company is in explore,
  validate, build, launch, grow or wind down, set by the owner and by no
  run (the application role cannot write `companies`). Policies read it as
  the `stage` fact, every run is told it with what the stage is for, and a
  run proposes a move with `stage.propose` -- an escalation the owner
  answers, raised at tier 3 when the move loosens, so the GO takes their
  device and never happens in a batch or over chat. Approving moves the
  company in the same transaction as the answer, and only from the stage
  the proposal was made in; a proposal the owner overtakes is withdrawn.
  `company-os` 1.1.0 brings the rules (no paid reach before launch; nothing
  new while winding down), a `stage-gates` skill naming the evidence each
  gate needs, and `stage.propose` for the strategist. The console shows the
  stage on the company's overview.
- A defect found building that: `installBundle` never installed a bundle's
  policies, and their conditions were text nothing parsed. Every review and
  approval a built-in bundle promised -- content-ops' review before
  publishing, web-ops' owner approval for DNS, palugada-dev's review before
  a push -- was a promise in a file. Conditions are now data in the policy
  engine's form, checked when a bundle is published, and installed through
  `putPolicy`; a quarantined bundle brings its restrictions and none of its
  `allow`s, and a review naming a reviewer the company does not have
  refuses the install before anything is written. The changed built-ins are
  version 1.1.0, and qa-review installs first because it brings the reviewer
  content-ops names.
- Grow the company from the console (`addRole`, `addDivision`, `addProject`
  in `src/governance/structure.ts`; Team, "Hire a role"). The owner could
  change a role and could not hire one, open a division or start a
  project: every one came from a template or a bundle. Hiring and opening a
  division are tier 3 (F2.9) and take the device; a project grants nothing
  and takes the session. A hire is complete enough to be given work at once
  (F2.8: the standard contracts and the owner's done criteria), runs where
  the company's other roles run, may name only capabilities the platform
  has and at most twelve (F2.6), and is versioned from its first state
  (F3.9); tools its division has no grant for are reported, not refused. A
  new division is granted the platform's tier 0 tools, as every template
  division is, so its roles can read their own memory and skills.
- A defect the demo server's log showed: the company's structure (the Team
  page) was read with six queries at once on one transaction's connection.
  `pg` 8 queues them and warns; `pg` 9 refuses, so the page would have
  stopped working on the next upgrade. They run in order now, and the test
  setup turns that warning into a failure for whichever file causes it.
- Chain roles (0058, `src/engine/handoff-rules.ts`, Team, "Handoffs"): the
  owner says "when this role finishes, that one takes over, with this
  brief", and the worker runs it every tick beside any rules in code. A
  deployment started from the README had no handoff rules at all, so no
  work followed on from other work unless an agent delegated it. The
  successor is a sub-task of the finished work (hop limit, fan-out bound,
  budget chain and F8.9's "begun outside" all carry), handed the
  predecessor's output as context beside the brief and never as the brief.
  Making a chain and switching one back on take the device.
- A defect found building that: the handoff engine filed each successor
  under its predecessor's division, which is the division whose grants and
  policies the broker reads -- so a reviewer handed work from content would
  have acted with content's grants, against F7.3. It uses the successor
  role's division, and the database now refuses any task whose division is
  not its role's (`tasks_role_in_its_division`).
- The owner's word on finished work (`giveFeedback` in
  `src/engine/owner-control.ts`; the task drawer's "Your word on it"). Buzz
  lets a person react to what an agent posted; here a reaction is worth
  something only if the company learns from it. "Needs work" takes a reason
  and "good" invites one; a reason is written as the owner's own way to
  work for the division that did the task, at full confidence, so its next
  run reads it beside its procedures. A second word on the same task
  supersedes the first, and praise with no reason is recorded and teaches
  nothing.
- Tell the owner when work they gave has finished (0059,
  `dispatchDoneNotices` in `src/owner/notify.ts`). Nothing did: the owner
  learned a task was done by opening the console. Buzz calls it the
  callback mention. A root task the owner assigned that completes, fails or
  halts becomes one message on each channel that takes news (Telegram does;
  push does not, because F10.5 keeps the ringing phone for an incident and
  a tier 3 approval), in the owner's window and language, with a link that
  opens the task. A schedule's routine run and a step an agent delegated
  are not news. A notice whose send failed is tried again a few minutes
  later, a few times, by the same claim-first row every notification keeps.
- One search across every company (`src/owner/search.ts`, the console's
  search box). The owner could search one company's decisions and one
  company's memory and nothing else. The box now finds the work, what it
  produced, the decisions and what the companies know, in every company,
  newest first and capped per kind, and opens what it found. A defect found
  on the way: the memory page's search did not escape `%` and `_`, so a
  search for "40%" matched every fact with a 40 in it; both searches take
  the query literally now.
- Put an item off (0060, `snooze` in `src/inbox/inbox.ts`; the inbox's
  "Later"). The inbox had one state for "not decided yet", so an item meant
  for Monday sat at the top all weekend. A put-off item leaves the queue and
  its count and is not sent to a channel until then; it is listed apart,
  where "Now" brings it back. Never past the item's own expiry, since
  silence still refuses (F10.4), and at most thirty days.
- Pictures instead of initials, and a logo (`brand/`, `console/src/images.ts`).
  The console drew each company as the first letter of its name, each role as
  the first two of its slug and itself as a gradient "P", so two companies
  that start alike looked the same and nothing said what a role did. A
  company is now drawn as what its name says it sells (Kopi Nusantara as
  coffee), or by an emblem chosen from its id when the name says nothing; a
  role is drawn doing the job its slug names, or as a plain agent when it
  names none; the owner is one person. The logo is a vector kit in every
  shape a place asks for -- mark, wordmark, lockups, one-colour, app icons,
  favicons, and a web manifest so the console can sit on a phone's home
  screen -- with banners for the README and for link previews, all made with
  fal and described in `brand/README.md`. Three defects found on the way:
  the server sent `.ico` and the manifest as `application/octet-stream`,
  which a browser ignores under `nosniff`; three sentences reached the page
  without the dictionary, which the stray-English scan now catches; and
  Mantine kept the colour scheme in localStorage, against the console's rule
  of storing nothing in the browser, while the theme menu read "auto" as
  light and offered the dark theme to an owner already looking at it. The
  scheme is held for the life of the tab now, and the menu reads what is
  on the screen.
- The organisation moves between the owner's decisions. Asked "is the
  structure right, mature and automatic", the answer was right and mature,
  and still: the owner had to pick a role for every piece of work, because
  no role in the standard company could hand anything on -- the
  coordinator's charter said "hand it off" and it held no way to. The
  coordinator now routes what arrives without a role (the console picks it
  by default when the owner gives work), and the planner hands a finished
  plan to the builder, both with `task.delegate` and `task.await` inside
  F2.4's twelve tools. Starting a company offers "Let it run itself", which
  installs `company-os` with the same factor: a strategist, a weekly review
  and the operating skills.
- An escalation reaches the role its division names (F2.1,
  `handEscalations` in `src/inbox/inbox.ts`). A defect: the item told the
  owner "ops-lead was asked first and has had 45 minutes" and nothing asked
  ops-lead -- the grace period was a delay with nobody in it. The named role
  now gets a task carrying the escalation, serving the goal the stuck work
  served, and its account of what it did is written under the item the
  owner reads; the item stays the owner's to decide. A named role that is
  not in the company, or cannot take work, sends the escalation to the owner
  at once, saying why. Every division of the standard company but the
  coordinator's own asks the coordinator first, for an hour.
- A fresh installation can start a company. A defect: `npm start` on an
  empty database saved no template and published no bundle -- `src/seed.ts`
  said it ran on every deploy and only the smoke script called it -- and
  the capabilities the template grants that wait for a vendor were written
  nowhere, so the owner's first "Start a company" failed. The boot now seeds
  (leaving a bundle an operator already published, perhaps signed, as it
  is), and records each catalogued capability by name (0061): it can be
  granted, and a call to it is refused saying it needs a vendor.
- Measure goals by numbers (section 2.19).

**F8.9, enforced where it does not depend on the model.** The untrusted
envelope was the only part of F8.9 that existed; nothing held a run begun by
outside text back from a tier 2 action. The broker now asks the owner before
any tier 2 or higher action in work an inbound trigger began, or work that
work delegated (`begunOutside` in `src/engine/tasks.ts`).

**Still open, in the order they would be taken**

- A strategy role in the standard template itself. Starting a company
  offers the company-os bundle, which brings one, and ticks it by default.
- Per-company connections to outside accounts from the console, and coding
  workspaces.

## 2.21 Read against its own claims, again

Four audits read the code against what the README and this file say: how
memory is shared, how reliable a deployment is, what it can reach, and what
the systems it is compared with actually do. Each finding below was
reproduced by a failing test before it was fixed.

### The owner's word reached the builder and no agent

The context builder assembled the company's languages, its stage, how the
goal is measured, the owner's question, their answers and their
instructions; the engine then built the runtime's request from four of the
pack's sections and dropped the rest. An owner who answered a task's
question, told it "lead with the price change", or reran it with a note was
heard by nothing that did the work, and the reminder after a language slip
never reached a CLI either. The request now carries the pack's notes
(`ContextPack.notes`, and on the wire), and every agent CLI reads them in
the prompt after the charter and before the task (`renderPrompt` in
`src/runtime/wire.ts`).

Working memory was re-read after the context cap, whole, and travels in
every run of a task. One large fetched page rode along in every later run,
and a task waiting on its sub-tasks is run every few minutes, so its cost
grew with the square of its steps. Each step's result is now bounded to
4,000 characters, and the runtime is handed exactly the steps the cap kept.

### A stock deployment could run no work at all

Every role a template creates names the in-process runtime. The in-process
runtime ran handlers, a deployment had none, and the only model client in
the repository was the test double, so `npm start` registered no runtime
and every task halted with `runtime_unavailable`. Drafting, distillation
and skill screening were off for the same reason. And nothing the owner
could reach changed a role's runtime: moving one onto Claude Code took SQL.

- A model client for Anthropic's Messages API over `fetch`
  (`src/llm/anthropic.ts`), configured by `PALUGADA_MODEL_KEY_REF`. A role
  names a tier -- `fast`, `standard`, `deep` -- and the client resolves it
  (`PALUGADA_MODEL_ALIASES`). Overloaded and rate-limited answers are retried
  with the provider's `Retry-After`, then handed to the fallback model
  (F13.6); a wrong key is said plainly and not retried. The system prompt is
  marked for the provider's cache, since it is the same on every turn. Each
  call is priced from the deployment's price list, cached input at the full
  rate.
- A role with no handler of its own is run by the model
  (`src/runtime/agent-loop.ts`): it reads the charter and the notes as its
  system prompt, calls the role's tools through the broker, and finishes
  with the task's output. Every turn is a journalled step whose input is
  its position, so a restart resumes at the turn it reached without paying
  for the earlier ones or calling their tools again, and a fallback model
  continues the conversation. A refusal comes back to the model as a failed
  call it can work around; an approval, a question to the owner, a vendor's
  "not now", the budget or a freeze ends the run and parks or halts the task.
  Tool results reach the model inside the untrusted envelope (F8.9).
- The owner sees each runtime this deployment runs, whether it answers, and
  moves a role onto one from the role's page (`GET /api/runtimes`, and
  `runtime` on a role change). The change is versioned like a prompt or a
  model and rolled back the same way; a runtime nothing here runs is refused.
- Without a key, the boot says what is missing, and a task that halts for
  want of the in-process runtime names the setting.

### What an operator met at 3am

- A worker's failures went nowhere. A stage that failed went into the tick's
  report and `start()` never read it; there was no logging anywhere in
  `src/`. The worker now writes a JSON line for a failed tick, a failed
  stage and every task it ran, and remembers when it last finished a tick.
- A Postgres restart took the process down. pg-pool emits `error` when an
  idle connection is closed under it, and nothing listened, so the throw
  bypassed the worker's own sleep-and-retry. The pools now listen, and bound
  a statement to two minutes and an idle transaction to ten.
- Nothing could tell a supervisor whether the process could work.
  `GET /api/health` answers without a session: 200 when the database answers
  and the loop has gone round lately, 503 and the reason when not.
- An answer after the deadline was honoured. Expiry was a sweep once a
  tick, and an approval landing between the deadline and the sweep went
  through: the owner's silence had already said no, and a late yes
  overturned it. The item now expires at the answer, and the work is
  cancelled as silence would have had it.
- One yes could carry an irreversible action twice. The approval was spent
  after the vendor answered; a worker that died in between left it unspent,
  and the next worker resumed the step and acted again. It is now spent
  immediately before the call, given back when the vendor refuses, and a
  step that spent one and never said how it went asks the owner again,
  telling them the first attempt may already have happened.
- A task whose work kills its worker went back to the queue for ever. After
  three lost workers -- leases that ran out or runs that stopped reporting
  -- it is halted and raised to the owner as an incident.
- `npm run db:setup`, the quickstart's second line, dropped the database
  without asking. It now refuses one that exists unless told
  `PALUGADA_RESET_DATABASE=yes`.

### Tools, as a model sees them

- Every tool was offered as "any object": the registry never wrote a
  capability's input schema, so a model guessed its arguments and a wrong
  guess reached the capability (`memory.search` without a query threw a
  TypeError from inside the platform). Each capability the platform
  implements now declares what it takes, with a sentence per argument; a
  vendor file may declare it (`input`), and otherwise every field its
  templates read is required. The broker holds every call to it before
  anything reads the input, and says what was wrong.
- Every tool's name had a dot in it, which the model providers refuse, so
  through Claude Code, any other agent CLI and the platform's own loop a
  role's tools were refused before the model saw them. All three now show
  `email__send` and map it back (`src/runtime/tool-names.ts`).
- What a tool returned reached an agent CLI as bare text; it now arrives in
  the untrusted envelope, as it does for the platform's own loop.
- The bridge's token was on Claude Code's command line, readable by anything
  that can list processes, and Claude Code also loaded whatever MCP servers
  the operator's own configuration named. The configuration is a 0600 file
  in a private directory, and `--strict-mcp-config` loads only the bridge.
- F8.9 was held only for work an inbound trigger began. Work that has read
  something written outside the company -- an email, a web page, a
  customer's record, a calendar invitation, a pull request -- now carries
  that provenance too (`readsOutside` in the catalogue, recorded as
  `content.read_outside`), and the owner is asked before any tier 2 or
  higher action in it or in work it delegated. The PRD says such an action
  is denied; asking the owner is the stricter reading this platform already
  took for triggers, since a denial the owner cannot overrule would make a
  support role that reads mail unable ever to answer it.

### Finding what the company knows

Retrieval was by age alone. `memory.search` read the eighty newest facts
and kept those containing the whole query as written, so a fact older than
eighty others could not be found by any words, and "refund approval" found
nothing in "Refunds need the owner's approval". The context pack took the
ten newest facts and the ten newest procedures, so the owner's own word on
delivered work aged out of every run behind ten distilled procedures. Both
now rank in the database (0062, full text in the `simple` configuration so
Indonesian and English are treated alike, each word a prefix): a search
returns the facts sharing the most words with the query, and the pack puts
the owner's word first, then what shares the most words with the task, then
the newest.

### Reaching what already exists: MCP servers

The platform served MCP to its own agent CLIs and could use none, so the
integrations that exist as MCP servers were out of reach unless rewritten as
vendor files (`src/capabilities/mcp.ts`, `PALUGADA_MCP_SERVERS`).

- Only the tools the file names are bound, as `mcp.<server>.<tool>`, and
  granted like any capability. A tool the server offers and the file does
  not name does not exist here.
- The file states each tier and the server may only raise it: a tool the
  server marks destructive must be tier 3, and a tier 0 tool must be one the
  server says only reads (or, when it will not list its tools without a
  credential, one the file says so of).
- A tool at tier 1 or above must be pinned -- a SHA-256 of its name,
  description and arguments -- and must name a read-back on the same server
  (F8.4). A tool that changed since it was pinned is refused at boot, at the
  call, and by the preflight: the "rug pull" MCP is known for.
- The calling division's credential is sent as a bearer token, resolved per
  call; a session is opened per call, so one division's authority is never
  carried into another's. The server is offered no sampling, elicitation or
  roots.
- Everything a server returns is outside content (F8.9), and the step's
  idempotency key travels in the call's `_meta`, where a server that
  honours it can recognise a retry; MCP has no key of its own, which is why
  the approval and the journal are spent before the call.
- Streamable HTTP only. A stdio server is a process the platform would run
  with its own environment, which F13.4 keeps runtimes from.
- **Added from the console.** The owner gives a server's address and token,
  sees every tool with what it does and what the server says of it, ticks
  the ones roles may use, and chooses each tier and read-back; the tiers the
  rules forbid are not offered. The pins are taken from the server when it
  is saved rather than copied from a boot note, the whole server is held to
  the same check the next start makes, and saving takes the owner's device.
  The token is sealed, sent only while the address stays on the host it was
  given for, and a server may carry its own token (`tokenRef`) instead of a
  division's credential. A console server that no longer passes is left out
  at the next start with a note; a file's refusal still stops it.
- **A task keeps its session.** Tried against Playwright's own MCP server,
  the client opened a session for every call and never ended one, and the
  second call was refused the browser the first still held -- so a server
  that keeps state between calls could not be used at all. A task's calls
  to a server now share one session, its write and the read-back that checks
  it included, keyed by the task and the authority the calls carry; it is
  ended with the protocol's DELETE after five quiet minutes, at shutdown, and
  after the boot's and the console's looks at the tools; and a session the
  server has forgotten (a 404) is started again and the request sent once
  more, as the protocol says. Checked end to end: a navigation in Chromium,
  read back in the same session.
- **Servers offered by name.** GitHub, Linear, Stripe, Atlassian, Sentry,
  Cloudflare, Neon, Zapier, Apify, Hugging Face, Context7, Firecrawl, Tavily,
  Exa, Browserbase and Playwright fill in their address and where their
  token goes, from each vendor's documentation (September 2026; none was
  called with a live key). A token may go in another header, another scheme
  or the address (`tokenIn`). Services that take only OAuth, such as Notion
  and Vercel, are not offered: this client runs no sign-in flow.

### Three more from the reliability and security audits

- A run that showed no progress for a whole lease kept running: the keeper
  stopped renewing and said nothing, the lease lapsed, and the next worker
  ran the task beside it. And a handler stuck on a promise that never
  settles held the worker, and every company's sweeps with it. The run is
  now stopped when its cover ends, while this worker still holds the lease,
  the engine stops waiting for it, and the task goes back to the queue as
  a lost worker would: no attempt charged, and counted towards `crash_loop`.
- A vendor file could bind a POST at tier 0 under a name the catalogue does
  not know -- a payout that runs at once with nobody asked. A method that
  changes something is now refused at tier 0 unless the file says the
  vendor only reads (a search that takes a POST).
- `web.fetch` and every vendor call checked the address a name resolved to,
  and then let the request resolve it again: DNS rebinding answers the
  check with a public address and the request with `169.254.169.254`. Each
  request now connects to the address its own check passed.

**Still open from these audits, in the order they would be taken**

- Resuming an agent CLI's run is by position: a CLI that re-issues an
  earlier call after a restart is told the journal diverged. The platform's
  own loop replays exactly; a CLI does not.
- No tracing endpoint: a run's model calls, tool calls and briefing are
  kept on the task and shown in the console, not exported as spans.

(A shutdown that handed nothing back, sign-in with no per-address throttle,
and no container image were on this list; section 2.22 closes them. So
were a worker that ran one task at a time, closed in 2.26; no connector
catalogue and no OAuth flow, closed in 2.23 and 2.25; no metrics endpoint,
closed in 2.27; and no way for a run to write down what it learned, which
a run now does as `learned` in its output, without a thirteenth tool
(2.23).)

## 2.22 Any model, and a company that runs itself

Read against the owner's question: can a company be started, left alone and
found working, on whatever model and agent the owner already has? A scripted
model was put behind the standard company's coordinator and asked to route
one piece of work (`test/acceptance/any-model.test.ts`). It could not.

### A role was a name: its charter reached no run

A role's system prompt, its done criteria and its output schema were
written for every template role, stored, versioned, shown to the owner --
and handed to no run. The context pack carried the platform's charter and
the company's, so every role was told the same thing: the coordinator never
read "route it with task.delegate", the marketer never learned it was the
marketer, and a run was told its output "is validated against the role's
output schema" without being shown the schema, so it passed by luck.

The role now travels in every run, after the two charters that outrank it
(F3.2): who it is and what done means, in the charter a runtime receives,
and the schema its answer is held to, as a note of its own. Neither is ever
dropped to fit the context budget; a run without its role is not doing that
role's work.

### Every hand-off cost two minutes

A parent that awaited its child was parked and looked at again every two
minutes. A company routes everything through its coordinator, so each piece
of work waited two minutes at each hand-off for nothing. A child that ends
now wakes the parent waiting on it, in a transaction of its own after the
child's, so the two rows are never locked in the opposite order to a
cancellation's. The two-minute look remains for the paths that end a task
without passing through `transition` (an owner's cancel, a crash loop), and
as the floor under this one.

### Any model

The platform's own loop spoke one API. It now speaks two, which between
them reach almost every model a company would choose (F13.6):

- Anthropic's Messages API (`src/llm/anthropic.ts`), as before.
- The OpenAI-compatible Chat Completions API (`src/llm/openai.ts`): OpenAI,
  OpenRouter, Groq, Together, DeepSeek, Mistral, Gemini's compatible
  endpoint, and the servers a company runs itself -- Ollama, vLLM, LM Studio,
  llama.cpp. Tools go as functions and come back as `tool_calls`; a key is
  optional, because a model on the company's own machine has none; arguments
  that are not JSON reach the broker under a name no schema accepts, so the
  model is told what was wrong rather than the tool being called with
  nothing.

Both share one transport (`src/llm/transport.ts`), so what counts as the
provider being down is decided once. `PALUGADA_MODEL_PROVIDER` chooses,
`PALUGADA_MODEL` puts every tier on one model, and an OpenAI-compatible
endpoint whose tiers are not all named stops the boot and says which,
rather than failing the first task that names it.

**Proved by** the scripted model above: a standard company on a keyless
OpenAI-compatible endpoint, where the coordinator delegates, awaits and
reports what the marketer returned, with no handler anywhere.

**Not proved.** Whether a given model calls tools well enough to do a
role's work is the model's matter; small local models often cannot call
tools at all, and the documentation says so.

### Ready to use

The quickstart was eight commands, two of them `export` lines holding the
owner's second factor and a model key in a shell that forgot both, and the
first sign of a wrong key or address was a halted task.

- `npm run setup` (`scripts/setup.ts`) asks where PALUGADA runs, enrols the
  owner's authenticator -- a QR code drawn in the terminal, and a code from
  the phone checked before it leaves -- and which model does the work, and
  sends that model one request offering one tool, so a wrong key, a wrong
  address or a model that cannot call tools is found while the operator is
  still there. It writes `.env`, readable by its owner alone, keeps what is
  already in it, and gives each database role a password of its own instead
  of the development ones, unless a database already answers with those.
  `npm start` and the other scripts read `.env` through Node's own
  `--env-file-if-exists`; `db:setup` takes each role's password from the URL
  the platform will connect with, so the two cannot disagree.
- The QR encoder is the standard's arithmetic, about three hundred lines,
  rather than a dependency: byte mode and level M are all it needs. It was
  checked module for module against an independent encoder and read back by
  a decoder; the test holds the first.
- A `Dockerfile` and `docker-compose.yml`: PostgreSQL with pgvector, created
  on first start with the passwords setup made, and the platform, which
  migrates under an advisory lock before it serves. Built and run here:
  healthy, the console served, the owner signed in with the code setup
  enrolled, the smoke check completed a task inside the container, and
  `docker compose stop` ended it with 0 in a second.
- Running it found two defects. The console's host allowlist, when named
  outright, did not include loopback, so the image's own health check was
  refused and a healthy deployment would have been restarted for ever;
  loopback is now always allowed, which no page elsewhere can make a browser
  send. And code ahead of its database -- an upgrade whose migrations were
  not run -- failed at the first query naming a new column, in a task, hours
  later. The boot now refuses with exit 78 and names `npm run db:migrate`.

### Any agent: what the CLIs did when they were run

Codex 0.157.1, Gemini CLI 0.61.0, OpenCode 1.18.32 and Claude Code 2.1.283
were installed and run against a stand-in model and the tool bridge.

- **Codex and Gemini CLI failed at once.** Neither has the `--mcp-config`
  flag their entries passed. Both are rewritten from what they did: Codex
  reads its servers from `$CODEX_HOME/config.toml`, needs a switch before
  exec mode may call an MCP tool at all, and offers the model a shell until
  five features are turned off; Gemini reads its servers from a settings
  file, needs `--skip-trust`, and offers its own file, shell and web tools
  until `tools.core` names only the bridge's. Each has a dialect of its own
  now, since neither prints Claude Code's stream.
- **Claude Code gave the model seventeen tools of its own** beside the
  bridge -- sub-agents, scheduled tasks, worktrees -- because the entry named
  the tools to disallow rather than allowing none. And it read the
  operator's own settings: a hook in `~/.claude/settings.json` ran a shell
  command on every run of every role, and `~/.claude/CLAUDE.md` was read into
  every prompt. `--tools ""` and `--setting-sources ""` end all three; each
  was checked against the binary.
- **OpenCode's entry was right**, and Hermes (from v2026.9.24, installed from
  its repository; the PyPI release lacks the flags) and OpenClaw 2026.9.6
  match their source.
- **None of the known entries could be turned on.** They lived in
  `known-clis.ts` and nothing read them; a deployment had to copy one into
  `PALUGADA_RUNTIME_SPECS` by hand. `PALUGADA_AGENT_CLIS=codex,gemini-cli`
  now registers them by name, an entry in `PALUGADA_RUNTIME_SPECS` that names
  one corrects only the fields it gives, and a misspelt dialect is refused
  instead of being read as Claude Code's.

### Stopping, and signing in

- **A deployment being stopped cut its runs off.** On SIGTERM the worker
  waited for the run in flight with no bound, the supervisor killed it a
  minute later, the lease lapsed, and the reclaim counted towards
  `crash_loop`: three upgrades during one long task halted it. `stop()` now
  gives a run twenty seconds to finish and then has it hand its task back --
  on the queue at once, no attempt charged, not counted against it, resumed
  at the step it reached by whichever worker comes up next.
- **Anyone who could reach the console could keep the owner out.** The
  second factor's lockout is global -- ten wrong codes from anywhere and
  nobody signs in for fifteen minutes -- so ten requests a quarter hour were
  enough. One address is now refused after five wrong codes, before its
  guesses reach the factor, so one caller cannot spend the owner's ten.
  Behind a reverse proxy the address is the one the proxy vouches for
  (`PALUGADA_BEHIND_PROXY`); without one, the forwarded header is ignored,
  since the caller wrote it.

### A console that explains itself

A new owner met a sidebar of nouns. The console now walks them through
itself on first sign-in: eight stops -- Home, the inbox, giving work, a
company's pages, settings and what is left to set up, the brake, and the
first company -- each moving the console to the page it describes and
pointing at its place in the sidebar. Finished or skipped, the deployment
remembers (0064), because the console stores nothing in the browser and a
tour that came back on every new phone would be one the owner dismisses
unread; it is in the owner's menu to take again. Checked in a browser, on a
desktop and a phone, in English and Indonesian.

### F5.7 was graded built and was not

The user guide's page on scale was written from the code, and it found
that a division's **Runs at once, at most** -- stored since the second
migration, shown on the division's page, changed by the owner -- was read by
no claim: a division set to one ran as many tasks at once as there were
workers. The claim now counts a division's tasks in flight under the same
per-company lock that makes the lane and the budget exact. A child its own
running parent drives is inside the parent's place, or a full division
would leave the parent waiting on a child nothing could start.

The requirement's other half, a limit per capability, was not built then:
a vendor's own limits were met by its 429s and `Retry-After` (F9.2), and a
count shared by every replica needed a table of places. It has one now
(section 2.43), and F5.7 is graded built.

### Three more the guide found

Writing the owner's guide from the code, rather than from what the code was
meant to do, found three things a company that runs itself needs and did
not have:

- **"Let it run itself" did nothing on a stock deployment.** The built-in
  bundles are published unsigned, so every one installed quarantined: the
  strategist got no grants and its weekly review was created switched off.
  A bundle whose stored content still hashes to the one this code ships is
  now first-party and installs as written; a changed copy, or anyone else's
  bundle, is quarantined as before. The built-in versions are bumped, so an
  upgraded deployment publishes the content that qualifies.
- **The built-in bundles' roles named `claude-sonnet-5`.** Sent as written
  to any other provider, and to agent CLIs, which know their own names.
  They name the `standard` tier now, and a tier reaching an agent CLI
  becomes that CLI's own model: Claude Code's aliases, Gemini CLI's flash
  and pro, or the `models` in an entry. A tier a CLI has no model for halts
  the task with the setting named, instead of failing every attempt with the
  CLI's complaint about a model called "standard" -- and is refused before
  the tool bridge starts, which the first version of this did not do, so a
  halted run left a server listening.
- **A schedule made in the console could never fire.** The form sent no
  goal and no brief, and every task names the goal it serves (F2.7), so the
  first occurrence was refused and the schedule sat at **Cannot fire**. The
  form asks for both now.

**Still open.** Claude Code's run is not given a home of its own, because its
login lives in the operator's; its settings and memory are shut out by flag
instead. The container image carries no agent CLI: one is added by extending
it.

## 2.23 Set up from the panel

Read against Hermes Agent's and OpenClaw's setup, which walk an operator
through a provider, a model from the provider's own list, tools and chat
platforms, the owner could do none of it without a shell: the model was
four environment variables and a restart. Buzz, which does all of it from a
window, can because its window is a desktop app on the owner's own machine;
PALUGADA's console is a web page in front of a server, so what Buzz does with
a local browser and an OS terminal has to be done here with what a server
has.

- **The model is chosen in the console.** A provider from a list (with its
  address and the page for making a key), the key pasted, the model picked
  from the list the provider itself serves (`GET /models`), one request to
  prove it answers and calls a tool, then the owner's authenticator to save.
  It is stored in the database and laid over the environment at each start
  (`src/settings/`); an area set in the console replaces that area of the
  environment rather than merging with it, so what the owner sees is what
  runs.
- **A key typed in the console is sealed.** AES-256-GCM under a master key
  the database does not hold (`PALUGADA_MASTER_KEY`, or a file the platform
  makes, readable by its user alone), with the secret's name bound in, so a
  dump is not the company's keys and a sealed value copied under another
  name does not open. A restored database with the wrong key says so, with
  both keys' fingerprints. The key never comes back out of the API.
- **Saving restarts the platform in its own process.** The first version
  took a setting "at the next start", which for an owner without a shell is
  never. `runFromCommandLine` now stops and starts the deployment in place:
  work in flight is handed back and resumed, the session survives because
  sessions live in the database, and another replica sees the change within
  thirty seconds. The acceptance test runs the real `src/main.ts`, saves a
  model through the API, and watches it come back on the new one.
- **A saved setting that would stop the boot is set aside with a note.** The
  console is the only place an owner can undo it, so the console must always
  come back.

- **Eighty-nine providers, by name.** The catalogue was rebuilt from
  Hermes' and OpenClaw's registries and checked against each provider's own
  documentation, and each route was asked for its models without a key to
  see that it exists. It found that Hermes still offers a Qwen login whose
  free tier ended, that GitHub Models is retired, and that several "plan"
  keys are sold for coding tools only: those are grouped apart, with a
  warning. `npm run setup` offers the catalogue's six featured entries.
- **Agent CLIs are installed and signed in from the console.** Claude Code,
  Codex, Gemini CLI and OpenCode from their publishers' npm packages at the
  versions the specs were checked against, into the deployment's own
  directory, with the owner's device first because installing is running
  code on the host. A CLI is signed in with a key, sealed and handed to each
  run under the one variable it reads -- or, for Claude Code on a Claude
  plan, from the console itself: `claude setup-token` runs under a terminal
  (`script`), the owner opens the page it prints and pastes back the code,
  and the token it prints is sealed without ever reaching the log. Every
  flow was checked against the real binaries first.
- **Codex was given no key.** `codex exec` 0.157.1 reads `CODEX_API_KEY` and
  ignores `OPENAI_API_KEY`, which is what its entry named; found by running
  it with `env -i` against a server that logged the header.
- **A halted task now says why.** The halt carried a code and nothing else,
  so a task stopped for want of a key read "runtime unavailable". The
  message travels with the halt and the task shows it.

- **Roles can search the web.** There was `web.fetch`, which reads a page
  a role already knows, and nothing to find one. `web.search` and
  `web.extract` go to the provider the owner chooses in the console: twelve
  for search and six for reading, each held to the request its own
  documentation describes -- where its key goes above all -- and tried from
  the console before it is saved. Three answer without a key at a free tier.
  Both are tier 0 and marked as reading outside the company (F8.9). The
  standard template grants them to Delivery and Growth, and the planner
  searches in place of `files.list`, which its division still holds.
  DuckDuckGo is not offered: it has no web-results API, and the package
  other agents use scrapes it. Edge TTS, which Hermes offers for speech, is
  the same kind of thing.

- **Roles can make pictures and speak.** `image.generate` goes to OpenAI,
  fal, OpenRouter, DeepInfra, xAI or Gemini, and `speech.synthesize` to
  OpenAI, ElevenLabs, xAI, Gemini, DeepInfra or a Piper of the owner's own,
  each asked the way its own reference describes and read in whatever shape
  it answers -- raw audio, base64 in JSON, or a picture's address fetched at
  once because it expires. What comes back is a file under the company's
  `generated/`, so both are tier 1 like a draft, read back by its hash after
  it is written (F8.4), with the provider's price reserved. The owner
  chooses the provider, the model and the default voice in the console, and
  sees the picture or hears the clip before saving; the console's policy
  lets an image or a sound come from the answer itself and nothing else.

- **The owner's channels are set up from the console.** Telegram took a
  token, a chat id and a webhook secret typed into the environment, and the
  chat id is a number nobody knows. Now the owner pastes the token
  @BotFather gave them, presses Start in the bot, and their chat is found
  from the bot's updates; the secret Telegram must send back is made here,
  both are sealed, the webhook is set when the deployment has a public
  address, and a test message proves the path. Push speaks ntfy's own
  publishing format as well as a plain webhook -- with an incident at the
  priority that breaks through a phone's quiet mode and the digest quiet --
  and Slack and Discord are told what needs the owner, with a link, through
  their incoming webhooks. A channel whose sealed credential will not open
  is left out with a note, and the rest start.
- **A push provider with its own shape got the digest in the default one.**
  The digest bypassed the format mapping, so ntfy would have refused it for
  want of a topic; every push now goes through one path.

- **The owner can say what they want.** The owner asked whether everything
  could be set up by telling an AI, and it could not: every setting was a
  form. **Ask PALUGADA** is a conversation with the deployment's own model,
  which reads any GET route of the owner API (except a company's whole
  export), may call the three checks that change nothing, and proposes any
  of the POST routes it is allowed -- every one of which is either listed
  with what it does and takes, or kept from it with a reason, and a test
  fails on a route in neither list. A proposal is a card; nothing changes
  until the owner applies it, through the same route and its checks, with
  their device where that route takes one. A key goes from a sealed field
  on the card to the route and never through the model, whose provider
  would otherwise hold a copy; a key typed into the conversation is refused
  and not kept. What the assistant reads is marked as data, so an agent's
  words can at most put a card in front of the owner. The conversation is
  kept by the deployment (0066), so it survives the restart a saved setting
  causes.

- **The owner can speak to it, and hear it.** Listening is a fifth tool
  chosen under Tools -- OpenAI, Groq, Deepgram, ElevenLabs, Gemini,
  DeepInfra, or a speaches or whisper.cpp server of the owner's own, each
  sent the recording the way its reference describes (a form, raw audio, or
  base64 in JSON) and read where it puts the words. The console records the
  owner, the words are written down in the console's language and sent to
  the assistant as if typed, and past the same check for a key; an answer
  can be read aloud by the speech provider. Neither needs the company's
  files, so both work before any company exists. For roles the same provider
  is `speech.transcribe`, a tier 0 read of a recording in the company's
  files -- through its real path, so a link cannot lead out -- whose words
  are outside content (F8.9). Mistral's Voxtral is not offered: Indonesian is
  not among its languages.

- **Each agent is someone, and the company has a CEO who talks to the
  owner.** The owner asked whether every agent has a persona of its own,
  whether the assistant could name a team, whether there are a CEO and a
  CTO taking after people who lead well -- and then who it is that talks to
  them, and whether the CEO should not be required. A role now has a name,
  a title and a persona (0067): twenty-five ways of working across twelve
  titles, each taken from a way of leading on the public record -- a CEO
  can work like Jobs, Bezos, Nadella, Jensen Huang, Ciputra or William
  Tanuwijaya -- with the owner's own notes. Every run is told who it is
  before its charter, and told it is not that person, never to speak as
  them or use their name, and to sign as itself. The standard company is a
  named team, with no persona until the owner chooses one; the persona
  texts are shown in English in the console, where the owner picks them.
  Every company that has roles has exactly one CEO (0068): a unique index
  refuses a second and a trigger checked at commit refuses none, so the
  title moves only by an appointment the owner makes with their device;
  a restored version never changes who the CEO is, and a template, bundle
  or old archive without one has its coordinator or oldest role appointed.
  The conversation on a company's pages is with its CEO -- the assistant's
  reads and cards, held to that company and nothing outside it, in the
  CEO's name and persona -- and work the owner wants done is a card that
  gives it to the CEO's own role, as work given without a role now is.
  Team is drawn as the owner, the CEO and the divisions hanging from one
  spine, rather than a grid.

- **Read again against what an owner would expect of a company's memory,
  goals, tickets, execution and transparency.** Three audits of the source,
  each finding checked in the code before it was acted on. The worst was
  execution: a task the owner approved, answered or had reviewed was never
  run again under the worker. A parked task gives up its lease, the owner's
  decision moved it to running with no worker, and the claim, the lease
  sweep and the orphan sweep each looked elsewhere -- so the approved action
  never happened, and the task went on holding its division's concurrency.
  The tests drove the engine by hand after approving; the claim now takes a
  running task nobody holds, and a test approves and answers through a real
  worker tick. Closing a goal now stops the work under it (its schedules
  and triggers paused, no new work under it or beneath it, runs told it is
  closed); a measure can be put right or retired (0069), and the database
  refuses a value for a retired one after its retirement; progress no
  longer counts cancelled or rerun tasks as owed; and the assistant was told
  a goal status, a unit and optional schedule fields the API refuses.

- **Tickets are the company's own backlog (0070).** `ticket.create` named an
  adapter nothing provided, so the planner told to leave tickets behind its
  plan and the support responder told to open one for a customer were
  refused every time, and nobody saw what they meant to file. A ticket is
  now a row in the company, filed by a run or the owner (the same title
  still open in the division is the same ticket), read by the CEO with
  `ticket.list` (outside content, since a run wrote it), handed on with
  `task.delegate` and its `ticketId` or given to a role from Work, Tickets;
  it closes when the task working it completes and opens again, with the
  reason, when that task ends any other way. It is closed, never deleted,
  and travels in the export. A vendor file that binds an outside tracker
  still replaces it.

- **The company learns from its work, and trusts what it learns as far as
  it has earned (0071).** The events of finished work carried nothing but
  their type, so the distiller guessed facts from metadata, stored them
  active at whatever confidence the model named, and every run read them as
  known facts -- even when the work had read a customer's email. A finished
  task's event now carries its goal and summary; a run may end with up to
  five lessons of its own; and the distiller reads the work itself, trusting
  its reading no more than a lesson (half confidence), with housekeeping
  capabilities left out of the patterns it proposes and a rejected pattern
  proposed again only on evidence newer than the refusal. The same lesson,
  whatever its case and punctuation, is one row made surer (to 0.8 at most
  without the owner), not a second row. A lesson from work that read outside
  content is marked `outside` and reaches runs, and `memory.search`, as the
  untrusted data it came from, however often it is learned (F8.9). The
  owner's notes have five places of their own in a run, so ten of them no
  longer push every approved procedure out. **Memory** shows where a fact
  came from and the work that taught it, reads one division at a time and
  pages, and can take a fact back; a memory is at most 4,000 characters.
  The `memory.note` above is `learned` in a run's output instead: no
  thirteenth tool.

- **A skill reaches the runs through a reviewer and the owner, and the owner
  can see and write skills (0072).** Approving a skill candidate in the inbox
  recorded the decision and changed nothing; no role ever reviewed a
  candidate, so the only way one went live was the owner marking it reviewed
  on a form that asked them to paste its id -- the owner being the review F7
  exists to avoid; the Skills page listed only active skills that were not
  scoped to a division, and never showed a skill's text; `skill.read` opened
  any skill in the company by name, another division's and a quarantined
  one included; and the summary every run was given stayed the first
  version's. Now each tick of the worker screens a new version against its
  checks and gives one that passes to the company's reviewer, or its CEO,
  as a task whose input carries the document as untrusted data. The
  reviewer's approval asks the owner, with what it said; its rejection, or
  a review that ends without a verdict, turns the version down with the
  reason. The owner's yes in the inbox activates it, and the summary becomes
  the live version's description. Owner questions raised the old way, before
  any review, are withdrawn by the migration. The owner reads every skill at
  every stage with its text, versions and checks, writes a skill or a new
  version with its checks, adds checks, and turns a candidate down; they can
  no longer mark one reviewed. `skill.read` follows the division rule the
  pack does, and returns an outside document wrapped as data.

- **Work that goes wrong stops where it should, and says why.** A write
  whose read-back failed was handed to the run as an ordinary refused call,
  and a model's answer to "the write did not stick" is to write again: a
  second payment or email, with no incident and the task completing. The
  first failed read-back now ends the run -- the run takes no further step,
  in any runtime -- and the task halts with the incident even if the run
  returned output. The claim skips a task past its deadline, and nothing
  else settled one that missed it while queued, so it stayed live for ever
  and a parent awaiting it asked again every second; the worker now halts
  such tasks, and `task.await` answers for a child past its deadline instead
  of parking until a time already gone. A retry is told why the attempts
  before it failed, as data. A role's tokens-per-run ceiling, handed to every
  runtime and enforced by none, now ends the run that writes past it -- in
  output tokens, because each turn resends the conversation as input and a
  total would halt ordinary runs at the ceilings roles carry. A
  delegation refused for fan-out is `fan_out_limit`, not a cycle. A task's
  cost, in Work and in a parent's report of its child, counts what vendors
  charged as well as the model, and a child is no longer reported free. What
  a run says after it resumes is kept: the resumed run is the same agent run,
  its narration numbering restarted at one, and every line after the wait
  was refused by the database without a word.

- **The owner can see how a piece of work was done (0073).** The Work page
  reached a task's events and its narration, not the steps behind them, and
  the journal kept a step's output and only a hash of what it was asked --
  so a trace showed that a message went out, not to whom. Tool and internal
  steps now keep their input, bounded; a task has its own trace, the one an
  inbox item already had, with each call's capability, tier, policies and
  approver, what it was asked and what came back, the model calls and their
  cost, and where content from outside came in; the task's timeline names
  the capability on each event; and the steps read as sentences, with the
  data a click away.

- **A project is more than a label, and Work finds any task (0074).** A
  project could only be started: not renamed, described or closed, and
  nothing a run was given said which project its work was for. Work showed
  the newest hundred tasks with no filter and nothing past them, and a link
  to a task that was not among them opened nothing. A project now has what
  it is for, told to every run in it; it can be renamed and closed to new
  work (a company keeps one open), and shows its open and finished work and
  its cost. Work narrows to a project, role or goal, pages by the same
  microsecond cursor as decision history, and opens any task by its id.
  Checking that a runtime receives what the pack says found that notes of
  a kind the engine did not list never reached it: the project, and the
  "earlier attempts failed" note added the batch before, reached no run.
  Both are handed over now, and procedures travel with their titles, so
  "How the owner wants it done" arrives as the owner's word.

- **The company has a knowledge base (0075).** Memory held facts of a
  sentence or two, so a price list, a contract or the brand guide had
  nowhere to go and no run could look anything up in one. The owner now
  gives the company documents under **Memory**, **Documents** -- typed,
  pasted, or read from a text or Markdown file in the browser -- for the
  whole company or one division. Each is kept whole and in passages under
  the headings they sit beneath; `memory.search`, which every role already
  holds, returns the passages a query's words point at, wrapped as data, so
  there is no thirteenth tool (F2.4); every run is told which documents
  exist. A document is archived, not deleted, and travels in the export.
  Matching is PostgreSQL's own text search: no embedding model is needed,
  and pgvector remains unused.
- **The owner talks to the CEO from Telegram.** The bot took button presses
  and answers to its own questions, and anything else the owner wrote went
  nowhere. A message the owner types, or a voice note they send, now goes
  to the conversation the chat is in -- the only company's CEO, a company
  chosen with `/ceo`, or PALUGADA's assistant with `/palugada` -- and the
  answer comes back in the chat, with the words heard shown so a mishearing
  is caught, and said aloud when a speech provider is chosen. It is the
  console's conversation, marked as Telegram's. A card the chat may apply
  (giving work, a ticket, telling or cancelling a task, a fact, a measured
  value, a snooze: `chat` in `assistant-actions.ts`) is one press; anything
  that takes the device or decides an inbox item opens the conversation in
  the console. Only the owner, in their own chat with the bot, is heard;
  the answer comes after the webhook is answered, one message at a time,
  and an update Telegram sends twice is answered once.
- **Done criteria are checked, and a rejected answer is asked for again.**
  Every role has criteria (F2.8) and every run was shown them, and then any
  JSON counted as done. A run a model writes now answers each criterion in
  its output under `done` -- met, and what shows it -- and one that leaves
  a criterion out, says one is not met, or claims one without evidence is
  a failed attempt whose reason the retry is told (`engine/done.ts`, at the
  `post_run` point). Handler code is exempt, and a schema that forbids the
  field is neither asked nor checked. Checking this found that a retry of a
  rejected answer never worked for a model's run: replay is by position and
  a model turn's journal input is only its number, so the retry was handed
  its own rejected answer back -- schema violations included -- until the
  attempts ran out. The turns after the run's last tool step are reopened
  now, so the model is asked again, told why, and nothing it did in the
  world is done twice. The report is shown on the task, under **Done
  means**.
- **Documents from Word and PDF files.** The knowledge base took only text,
  and an owner's price list and contracts are PDFs and Word documents. The
  console reads them in the owner's browser and sends the text, so the
  server never parses a file: a Word document by `console/src/docx.ts`,
  which unzips it with the browser's own inflater and keeps its headings as
  headings (by the style's outline level or English name, so a Word in
  Indonesian is read the same), and a PDF by pdf.js (`console/src/pdf.ts`),
  Mozilla's reader, loaded only when a PDF is chosen and kept out of the
  chunk every page loads. Checking it in a browser found the server had no
  type for `.mjs`, so pdf.js's worker would have been refused under
  `nosniff`; and that the form's "Title" shared a translation with a role's
  title. The Word reader is tested by the suite with a document built in the
  test; the PDF reader runs only where a bundler has loaded pdf.js, so it was
  checked in a browser against a PDF written for it, not by the suite.
- **What every run was told is kept.** A run's context was kept only where
  its model calls' prompts were, which is for runs this process drives; a
  run handed to an agent CLI, a container or an HTTP runtime left nothing of
  what it was told. 0076 keeps each run's briefing -- the request as its
  runtime received it, in the redacted wire form a third-party runtime is
  sent -- bounded, and scrubbed with the prompts past the prompt window.
  Every run in a task's trace has **What it was told**, section by section.
- **Telegram's newer Bot API.** Read against Bot API 10.x: an answer is a
  rich message, Markdown the model wrote, less every HTML tag -- rich
  Markdown takes HTML, and Telegram's HTML has buttons, so a model that
  read something planted could have put a button that approves an item
  under words that say something else -- and less every picture, whose
  address Telegram would fetch. A plain answer, for a Bot API without rich
  messages, is sent with no link preview for the same reason. While an
  answer is made the chat shows a "Thinking…" draft with a stop button;
  the stop reaches `converse` as an abort, no further turn is asked, and
  nothing proposed is shown. Approve and Deny carry Telegram's green and
  red, an item's expiry is Telegram's date entity (the owner's own zone
  and words), and saving the bot sets its command menu in the owner's
  chat. A Bot API that answers "Not Found" for a method is remembered as
  not having it, and gets the older way.
- **A Telegram topic for each company.** With topic mode on for the bot
  (Bot API 9.3), each company has its own topic in the owner's chat, made
  the first time it has something to say and kept in 0077, since Telegram
  gives a bot no way to list the topics it made: what the company raises,
  its finished work, its digest and the prompt for a question arrive there,
  and what the owner writes there goes to its CEO whatever the chat was last
  on. A topic the owner deleted is forgotten and made again, and the message
  on its way still arrives; two processes that make one at once keep one and
  delete the other. The bot can be given PALUGADA's picture from the console
  (`setMyProfilePhoto`, a JPEG the console ships).

**Still open, next.** From the same audits, in order: the done report is
the run's own account -- the engine holds it to answering every criterion
with evidence, and nothing yet judges whether the evidence holds; a run had
no wall-clock ceiling of its own beyond its deadline and its lease (closed
in 2.30); documents
are matched by their meaning only when the owner chooses a provider (2.35)
-- and a scanned PDF, or any file but Word, PDF and text, reaches them
only as text the owner pastes. Signal and email as owner channels are not
built (WhatsApp is, in 2.31); Slack and Discord cannot carry buttons, so
Telegram and WhatsApp are the chats that decide. Subscription
logins whose tokens rotate (ChatGPT, Hermes' Nous and Codex logins) are not
offered: every run would hold a copy and the first to refresh would sign
the rest out. Hermes' entry still gives each run its own `HERMES_HOME`,
which the research predicts puts its packages in a throwaway directory for
a source install; a key reaches it now, and the directory is the next fix.
Claude Code reads a host-wide credential outside `HOME` when one exists
(a managed settings directory, a remote session's token), which only a
mount namespace could hide.

## 2.24 Read against a live run on a real model

`docs/COMPETITIVE-ANALYSIS-2026-09-28.md` gave a fresh deployment one task
on DeepSeek through the standard template, and graded what happened. The
suite was green; the task did not finish. What it found, and what has been
done:

- **A reasoning model's empty turn was kept (L4).** DeepSeek spent the
  per-call allowance thinking and answered nothing with
  `finish_reason: length`; the loop pushed the empty turn and the next call
  was refused. A turn that says nothing is never kept now: one cut off by
  the allowance is asked again with twice the room, up to a ceiling, and an
  empty `end_turn` is nudged once and then fails with why. The owner's
  assistant does the same with its answer.
- **A company that spent its lifetime tokens could not be given more (L11).**
  The engine refused every task with a message that pointed nowhere. The
  ceilings are raised on **Money**, **Ceilings** (raising asks for the
  authenticator, lowering does not), and the refusal says where.
- **A delete could not be verified (L10).** Every read-back answering 400
  or more counted as failed, so a rule that proves a delete by a 404 could
  never pass. A status the vendor file names in `matches.status` is now an
  answer, not a failure.
- **A saved model key followed the address (security #1).** Checking a
  model with a new address and no key sent the saved key to the new
  address, and the assistant could ask for such a check. The key is reused
  only for the same provider at the same origin, and the assistant may
  check only the saved model.
- **No charter ever reached a run (L8).** Charters were written only by the
  file import, which the boot never ran, so F3.1, F3.2 and F3.6 described
  tested code no deployment used, and a reviewer told to check a skill
  "against the company's charter and policies" turned five of the nine
  built-in skills down for want of either. A deployment now starts with a
  short platform charter and a company from a template with one naming it
  and its mission; each is published only where there is none, so the
  owner's word is never overwritten, and replicas booting together publish
  one (0078 gives the platform's versions the uniqueness `UNIQUE
  (company_id, version)` never gave a null company). The owner reads and
  rewrites both on **Team**, **Charter**, with the authenticator, and puts
  the company's back from its history. The skill reviewer's task carries
  the policies in force, since no run is otherwise told them.

- **The marketer could not finish anything (L5).** Its second criterion
  was "the customer record says what was sent and to whom", which only
  `crm.note` can make true, and a deployment with no vendor file binds no
  CRM: the run wrote its drafts, said honestly the criterion was not met,
  and failed three times alike. The responder, the bookkeeper and the
  builder had one each of the same kind. Each now says what counts where
  its vendor is not connected, and `company-template.test.ts` holds every
  criterion of the template to a written list of what it needs, so the
  next one added has to say. A role's tools that nothing is bound to are
  no longer offered to its runs, and every runtime is told their names --
  a run found them unusable only by calling them. The owner changes what
  done means for a role from its drawer; it is recorded with the role's
  version and put back with it, which is how a company made before this
  gets the new criteria.

**Still open, next.** F3.11's files are read only when the boot is given a
directory, and it is not given one. (Closed in section 2.44.)

## 2.25 Chaos, and every connector

The owner asked two things of the platform: whether it is safe when things
break, and whether everything that connects it to other services -- OAuth,
connectors, keys -- is there and easy. Both were answered by running things
rather than by reading them.

### Faults injected into a running deployment

A harness ran PALUGADA as its own OS process (`node src/main.ts`), with a
fake OpenAI-compatible model and a fake CRM in another process that outlive
it. The CRM deduplicates on `idempotency-key`, can hold a request open, and
can answer 5xx. Each scenario created tasks for a role that writes a
`crm.note`, injected one fault, and then read the books: task outcomes,
CRM posts per key, tokens still reserved, leases held, runs, incidents and
events.

| Fault | Before | After |
|---|---|---|
| SIGKILL while a `crm.note` call is in flight, restart at once | exactly one note per task (the retried step went out under its first key, and the CRM deduplicated it); no reservation or lease leaked; **recovery 908 s**, the killed worker's task leased to a dead process until its lease ran out | the same books; **recovery 62 s**: workers write `worker_heartbeats` (0079) every 15 s, and the sweep returns the tasks of a holder quiet for 60 s |
| The model's connections dropped for 20 s | both tasks **halted**, `runtime_unavailable`, **2 incidents** for the owner to resume by hand; a dropped connection was not even retried | both **completed** in 46 s, **0 incidents**: a dropped connection is retried like a 503, then the task waits for the same model -- 30 s, doubling, five times -- and only a model that stays down halts it |
| The CRM refused the note, and the model said it was done | the task **completed** with a summary saying the note was written | refused: a write above tier 0 that failed and was not put right later must be named under `failed`, with why the work is done anyway |
| The model tried a write again after its answer never came | the second try carried a **new key**, so the vendor could not tell it was the same write | tool calls are keyed by the task, the capability and the input, so the same write asked twice is sent under one key |
| The CRM answered 503 to everything for 20 s | both tasks **failed**: a failed attempt went straight back on the queue, and three were spent in seconds | both **completed** in 56 s: a failed attempt waits 10 s, then 40 s, then 160 s before the next is claimed; the same key on every try, one note each |
| SIGTERM while a call is in flight | -- | the run finished its step and handed the task back; both completed in 19 s, one note each, nothing leaked |
| SIGKILL as the CRM's answer arrives | -- | the step was repeated under its first key; both completed in 62 s, one note each |
| PostgreSQL restarted while a call is in flight | -- | the process logged the lost connections and carried on; both completed in 12 s, one note each, nothing leaked |
| Two replicas share the queue; one is SIGKILLed while a call is in flight and stays down | -- | the other finished all six tasks in 62 s: one note each (the killed call was repeated under its first key and deduplicated), one run per task, no two runs of a task at once, nothing leaked |

A separate review reported more, and four of its findings are handled:

- A SIGTERM mid-run, reproduced above.
- `agent_runs.tokens_used` was written by nothing, so every run and every
  export said a run had used no tokens. A run now counts what its traces
  count.
- A runtime that wrote without ending a line was held whole in the worker's
  memory. That covers every reader: Claude Code's stream-json, the other
  CLIs' lines, and a script's or sandbox's protocol. Reproduced with a
  runtime that writes for ever, it ran to its deadline. Every reader now
  stops the run at 16 MiB of one line, says so in the failure, and ends the
  process.
- A container whose runtime ignored SIGTERM outlived the docker client that
  the tree keeper killed. Each run's container now has a name
  (`palugada-run-<run id>`), runs under `--init` so the runtime is not
  PID 1, and is removed by that name when the run ends, however it ended.

Two are not changed:

- A preflight that fails once for a network blip halts the task with an
  incident, which is what F8.12 asks.
- A container whose worker was itself killed with SIGKILL is not swept at
  the next boot: the removal above runs in the worker that started it.

### Connectors, keys and OAuth

Every path by which a key reaches something outside was read, and the ones
that sent a key somewhere the owner never chose were closed:

- **A division's credential could name one of the deployment's own sealed
  secrets** -- `db://model-key` -- and the broker would send the model
  provider's key to whatever vendor the capability called. Division
  credentials now resolve only `env://`, `file://` and
  `db://credential-*` (`DivisionSecrets`), and a rotation refuses anything
  else before it moves.
- **The owner's assistant could check an MCP server at an address of its
  own with a saved server's token.** Its check is `{ name }` only, looked
  up at the saved address.
- **An MCP server could be reached over plain http anywhere, and redirects
  were followed with its token.** Plain http is accepted only on this
  network, and a redirect is refused with where it pointed.
- **A tool's saved key was sent to a different address when a tool was
  tried there**, and a try needs no second factor. It now stays with its
  address, as the model's does.
- **Disconnecting Telegram left the webhook set at Telegram**, which kept
  retrying the chat's messages against an address that refused them; it is
  now deleted. **The assistant proposed agent-CLI keys with a kind no CLI
  takes**; it is told the catalogue's own kinds.

And what made connecting a service hard:

- **A vendor was a JSON file an operator wrote, and a division's key was a
  row inserted with SQL** beside an environment variable and a restart.
  **This deployment, Services** now connects the shipped presets, or any
  entry of the file's shape, checked against every rule the file is held
  to; and a division's **Keys for services** says which of its capabilities
  need a key, takes the key pasted, seals it as `db://credential-…`,
  declares it with the scopes those capabilities need (F12.6), replaces it
  as a rotation and deletes the old one. Each change asks for the owner's
  authenticator; a key is never shown again.
- Approval cards now say what the action would do, with every argument
  (L9), and the owner's answer to an escalation reaches the task and puts
  it back to work (L18). A run's own question answered this way stayed
  open, and the run asked it again, until 2.90.

- **There was no OAuth anywhere, so no hosted MCP server that signs in with
  it could be connected.** Linear's, Notion's, Sentry's, Atlassian's and
  Stripe's all answer 401 and name an authorization server. PALUGADA is now
  a client of the MCP authorization spec (revision 2026-07-28):
  - it discovers the resource's and the authorization server's metadata
    (RFC 9728, RFC 8414 and OpenID, in the spec's order), and checks that
    each is who it says it is and that PKCE with S256 is offered;
  - it registers a client (RFC 7591), or uses one the owner registered, kept
    per authorization server;
  - the owner signs in in their own browser, with PKCE, a single-use state
    kept by its hash (0080), and the server as the token's `resource`
    (RFC 8707);
  - the callback checks the issuer (RFC 9207) before the code is redeemed;
  - the tokens are sealed, and refreshed once across every worker when the
    server says they have run out.

  A server's name with `_` in it could not keep a token at all, since a
  sealed secret's name cannot hold one; it now can.
- **The servers offered by name still said sign-in did not exist.** Their
  list left out Notion "because this client runs no sign-in flow", and
  offered Linear, Atlassian and Stripe only with a pasted key. The list was
  checked again against each vendor's documentation and public OAuth
  metadata; none was signed in to. It now has twenty-eight servers, each
  marked with how it lets PALUGADA in:
  - Notion, Webflow and Square are signed in to with nothing to copy.
    Choosing one asks the server, and the sign-in is offered at once.
  - Twelve take a key or a sign-in.
  - GitHub, Asana, Slack, HubSpot and Box let PALUGADA in only through an
    app the owner registers. The console links to where one is made, and
    shows the return address to give it, which it did not show before.

  Choosing Notion and HubSpot in the console reached their real servers,
  and both answered with their authorization servers. Vercel, Figma and
  Canva are left out: they register only clients they have approved.
  Google Workspace's servers are left out too, because they are a
  developer preview.

  A sign-in's token was also sent the way the preset sends a pasted key:
  Sentry's `Sentry-Bearer` scheme, for a token that OAuth issues as a bearer
  token. It is now always sent, and saved, as a bearer token.

- **A vendor bound by an entry could not sign in, so Google Calendar and
  Gmail could not be bound at all.** Their keys are not pasted: a person
  signs in, and the token runs out within the hour. Google's own MCP
  servers are a developer preview. An entry may now say how its key is
  signed in for (`signIn`): `google` or `microsoft` by name, or any
  provider by its two addresses, with the scopes its call needs.
  - The owner signs a division in from its keys, with the device, in their
    own browser: the authorization code grant with PKCE and a single-use
    state (0081).
  - The app registered with the provider is asked for once per deployment,
    with the return address to give it, and its secret is sealed.
  - What the sign-in leaves is the division's credential, as a pasted key
    is: sealed under a name only a division's credential may use, scoped to
    what its capabilities need, rotated by signing in again, and never shown.
  - Wherever a credential is resolved, it becomes the access token. It is
    refreshed first when it has five minutes or less to run: once across
    every worker, and only at the endpoint the app was registered for.
  - A sign-in's record cannot be pasted in as a key, since it would choose
    where the app's secret is sent.

  The example file offers `calendar.read` on Google Calendar. Gmail's calls
  do not fit an entry: listing gives ids only, and sending takes an encoded
  message.

**Still open, next.** Client ID Metadata Documents and re-authorizing for
more scope on a 403 are not built. (The runtimes' HTTP and sandbox tokens, which
came from the environment into a header without the redactor being told
them, are now registered with it.) The master key
cannot be rotated from the console, and the authenticator has no recovery
codes. The second-factor lockout is global, so anyone who can reach the
sign-in page can still lock the owner's *codes* for its window; it no longer
locks a passkey, which cannot be guessed, so an owner with one is never
kept out by somebody else's wrong codes.


## 2.26 The rest of the analysis of 2026-09-28

The last four findings of `docs/COMPETITIVE-ANALYSIS-2026-09-28.md` that
this file had not yet answered. Each was reproduced by a test first.

- **The owner's urgent task waited behind a long run (L3).** A process ran
  one task at a time and did everything else between runs. A P0 task the
  owner gave waited behind whatever automatic work had started first. An
  approval past its expiry stayed open, and its task still waiting, for as
  long as that run took; notices and the budget watch waited as well.
  - A process now runs `PALUGADA_WORKER_CONCURRENCY` tasks at once (four
    by default). One place is kept for P0 work, so an urgent task starts
    even while the others are busy.
  - The housekeeping runs on its own five-second clock.
  - A division's limit, its budget and the claim's lock still bound what
    runs, across every process.

  Reproduced with a run held open: the owner's task and the expiry both
  waited for it; now both finish while it is still going.
- **A rerun of a rerun forgot what the owner said (L6).** The third attempt
  at a launch post still wrote "[TBD: price]" after the owner had given
  the price twice: once as an answer to the first attempt, once in a note.
  A run read only what was said to its own task. Every attempt at the same
  work now reads the owner's notes and answers to all the attempts before
  it, oldest first, under its own.
- **A run asked the owner which CRM to bind (L7).** It is a question the
  owner cannot answer from the inbox: a service is connected on This
  deployment, Services, and an answer typed into an item connects nothing.
  - `owner.ask` now answers such a question itself. A question naming a
    tool of the role's that nothing is bound to, in words about setting it
    up, gets that answer at once, the event
    `task.question_answered_by_platform`, and no inbox item.
  - A question about the work, even one naming the tool, still goes to the
    owner.
  - Runs are also told, with the names of their unconnected tools, not to
    ask.
- **Every call was priced at the top of the market (L12).** With no price
  list, a model is charged $15 in and $75 out per million tokens, on
  purpose. A company on DeepSeek was charged about 58 times its bill, and
  its $200 ceiling stopped work worth $3.40. Nothing offered to say what a
  model costs. There are now three places, laid over each other in this
  order:
  1. `npm run setup` prices a model on this machine at zero. For a hosted
     model it offers what [models.dev](https://models.dev) says.
  2. The console's **What it costs**, on the Model page, shows each
     model's price and who set it. It fills itself from models.dev, using
     the provider the model is reached at.
  3. The console saves prices with the owner's device, since a lower price
     loosens every budget.

  models.dev is read live and only offered; nothing it says is saved
  without the owner. `pricing.ts` still compiles in no price list. The
  console's fill was run against the real catalogue: DeepSeek V4 Flash
  came back at $0.15 and $0.60 per million tokens, where the fallback had
  charged $15 and $75.

## 2.27 Operating it: metrics, point-in-time recovery, and the schema owner

Read against what an operator has at three in the morning, and against the
competitors checked again on 2026-09-30: Multica serves Prometheus metrics,
Paperclip exports traces, and PALUGADA had a health check and log lines.

- **Nothing showed the load over time.** `/api/health` says whether the
  process can work; the console is the owner's. A queue growing behind one
  role, every place of a worker taken, or a company's spend climbing toward
  its ceiling was visible to no graph and no alert. `GET /api/metrics` now
  serves them in the Prometheus text format:
  - live tasks by company and status, and the age of the oldest pending one;
  - running runs and how long the quietest has shown no progress;
  - what waits for the owner, by kind;
  - each company's spend against its ceiling;
  - workers alive across replicas, this worker's places and how many are
    busy, and its runs and failures as counters;
  - the database pools and the process itself.

  A scrape reads live work over the partial indexes the worker already
  keeps, so it stays cheap however much history there is. The numbers are
  about every company, so they are served only with
  `PALUGADA_METRICS_TOKEN`, a token of at least 32 characters, and the
  route answers 404 until one is set. The operations guide has the scrape
  configuration and rules to alert on.
- **A backup lost the day.** The guide had `pg_dump` only. It now has
  point-in-time recovery from an archived write-ahead log, drilled on
  PostgreSQL 16: rows written after the base backup and before the target
  came back, and a delete after it did not. It says what a recovery cannot
  undo -- effects in the world after the target -- and how the idempotency
  keys bound it.
- **TRUNCATE went round the append-only rule (0082).** `events`,
  `governance_log` and `retention_log` refuse UPDATE and DELETE through a
  row trigger, and TRUNCATE fires no row trigger. OpenBot found the same
  hole in its own audit log. Only the schema owner holds TRUNCATE, and its
  TRUNCATE emptied the history without a word, directly or through
  `TRUNCATE companies CASCADE`. A statement trigger now refuses it unless
  the session sets `app.allow_truncate`, which only the test suite's reset
  does. An owner who means it can still drop the trigger; this stops the
  mistake, not the owner.
- **The running platform held the schema owner's password.** Under Docker
  Compose the app container was given all three database URLs, so that it
  could migrate before it started, and kept them for its whole life. The
  systemd guide said to copy `.env`, which has all three, into the
  service's file. That role can alter and empty any table.
  - Compose now migrates in a `migrate` service of its own, and `app`
    starts after it with only the application and control-plane URLs.
  - The image migrates only when it is given the owner URL, and starts the
    platform without it.
  - The unit removes it with `UnsetEnvironment=`.

  Run with Docker Compose from a clean volume: `migrate` applied every
  migration and exited 0, and `app` then started healthy. No process in the
  app container had `PALUGADA_OWNER_URL` in its environment, tini's
  included. A `TRUNCATE events CASCADE` as the owner role was refused.

## 2.28 Fewer cards for the owner: a yes for a while

Read against the competitors checked on 2026-09-30. Copilot Studio offers
"approve for this session" and OpenAI's Dots lets a person write rules per
action; both answer the complaint that too many approvals is how one person
loses control of a queue. PALUGADA asked about every action a policy
covered, one card each, for as long as the policy stood.

- **A yes for a while (0083).** On a card a policy raised, the owner may
  approve and allow the same capability to the same role for an hour,
  eight hours, a day or a week. It takes their second factor, because it
  loosens a rule, like a policy made looser. Each action it lets through is
  counted and written on the task as `approval.standing_used`, naming the
  yes. It is listed in the inbox and taken back with one press.
- **What it never covers.**
  - A tier 3 action: approved one at a time, with the factor (F10.10).
  - Work that read content from outside: asked about every time (F8.9),
    since that content may be what is asking.
  - Another role or another capability.
  - Anything past a week: the database refuses one longer.

  The broker now writes on each card why it asked (the tier, content from
  outside, or a policy), so which cards are eligible is decided by the
  server, not by a card's wording. A card from before this knows no reason
  and is not eligible.
- **Written by the owner alone.** The application role can read a standing
  yes and count its uses; it cannot make one or extend one. Only the
  control plane writes the table, in the same transaction as the decision
  it came with.

Reproduced by tests first:
- a second send on a new task, to another recipient, went without a card;
- another role still asked;
- a send after the yes was taken back asked again;
- a task that had read a customer's email asked, and its card could not be
  answered for a while;
- tier 3, 169 hours, and an insert as the application role were each
  refused.

## 2.29 Agent CLIs held to the versions their containment was checked on

Read against OtoDock, which pins and freezes the Claude Code and Codex it
runs, and against this platform's own history: what keeps an agent CLI to
the tool bridge is its own flags and settings, and a Claude Code release
once offered seventeen tools the old deny list did not name.

- **A CLI at another version ran as if nothing had changed.** The console
  installed the checked version, but nothing looked again: an update from
  outside, or the CLI's own updater, left a version nobody had checked
  running every role on it. The Claude Code on the machine this was written
  on was 2.1.285, two releases past the checked 2.1.283.
  - Each known CLI now names the version it was checked on
    (`src/runtime/checked-versions.ts`, one list the installer uses too).
  - Its health check reads `--version`. At any other version it answers
    not healthy with the reason, so its tasks wait on the queue (F13.8).
  - The owner installs the checked version, or accepts the one installed,
    from **Agent CLIs** with their device. Updating to the newest from the
    console accepts that version as it installs it.
  - An accepted version covers that version and no later one.
- **Each CLI could update itself between runs.** Each run now turns its
  updater off, under the names each CLI's own settings use:
  - Claude Code: `DISABLE_AUTOUPDATER`, which 2.1.285 reads.
  - Codex: `check_for_update_on_startup = false`, which 0.157.1 accepts
    under `--strict-config` (that mode refuses a key it does not know).
  - Gemini CLI: `general.enableAutoUpdate` and
    `enableAutoUpdateNotification`, from 0.61.0's settings schema.
  - OpenCode: `autoupdate`, which was already off.

  Codex and Gemini CLI were run with the new settings at their checked
  versions.

Hermes installs from its own script at no version the console can choose,
and is held to none; it is on this list's open side.

## 2.30 How long a role's run may take (#102)

- **A run that kept going was bounded by nothing the owner set.** The run
  was held to its task's deadline, and most tasks have none. The lease
  keeper renews a lease for as long as a run shows progress, so an agent
  CLI working an hour on a ten-minute job spent an hour of tokens before
  anything looked at the clock.
- **The owner now sets a length per role (0084).** It is under **Change
  its charter, done criteria, model or run length**, in minutes, up to a
  day; 0 is no limit.
- **What happens at the limit.** The run is stopped and what it committed
  is kept. The task halts as `run_limit` with the length in words, as a
  run that outgrows its token ceiling does, because it would outgrow the
  length again. The owner reruns it with a note or gives the role longer.
- **Where else the length shows.**
  - It is sent to every runtime as the run's wall clock, with the
    deadline, whichever is sooner.
  - It is kept in the role's history, so a rollback restores it.
  - It travels with the company's export.

Reproduced first: a role limited to one second, with a run that never
finished, was halted after about one second rather than at the lease.

## 2.31 WhatsApp as the owner's channel (F10.9)

- **An owner in Indonesia reads WhatsApp, not Telegram.** Meta's own Business
  AI answers a company's customers there since August 2026, and Manor, the
  one competitor with a WhatsApp channel, builds it on the Cloud API with
  receipts that survive a duplicate. The channel is built the same way here,
  from the design, not the code.
- **What it carries.** Everything Telegram carries, with the same rules:
  - Approve, Deny and Ask buttons up to tier 2; a question's choices as a
    list; a tier 3 approval or an incident as a link (F10.10).
  - The daily digest and a message when work the owner gave has finished.
  - The owner's own words go to the CEO, as in the console; `/ceo` and
    `/palugada` choose whom they talk to, and a card the chat may apply
    comes with its button.
- **What stands between a delivery and a decision.**
  - Meta's signature over the bytes (`X-Hub-Signature-256`), checked in
    constant time before anything is parsed.
  - The owner's number: a press from any other is recorded as
    `security.chat_stranger_refused` in the item's company, and not answered.
  - Each message id, claimed in the database before it is acted on (0085),
    so a delivery Meta sends again -- for days, and across a restart -- is
    acted on once.
  - `decide` over `chat`, which refuses tier 3 whatever arrives.
- **WhatsApp's 24-hour window.** A business may write first only within a
  day of the owner's last message. The send is accepted and reported failed
  later, in a status delivery. The item then goes as the approved template
  (`PALUGADA_WHATSAPP_TEMPLATE`), and its buttons follow when the owner
  replies. Without a template, the company's record says why it was not sent.
- **A reply names only its message.** The item an "Ask" prompt is about is
  kept against the prompt's message id, in the database, so the owner's
  question reaches the task after a restart too.
- **Set up from the console.** Under **Channels**: the number is checked with
  Meta, three secrets are sealed with the owner's factor, and the card shows
  the callback address and verify token to paste into Meta's app.

Not built: a voice note on WhatsApp (it says so, and points to Telegram and
the console), and retracting a message once its item closes, since the Cloud
API cannot edit a message; a press on a closed item is answered "Already
closed". Signal and email as owner channels are still open.

## 2.32 Recovery codes: back in without the phone (F12.5)

- **A lost phone locked the owner out of the console.** The only way back
  was an operator at the server's shell making a new secret. An owner
  travelling with a laptop has no shell.
- **Ten codes, each good once (0086).** Made under **Settings**,
  **Security** with the owner's factor, shown once, and kept only as their
  SHA-256: eighty random bits are beyond guessing from a backup, as a
  session token's are. A new set ends the old one and every session it
  signed in.
- **What a code can do.** Sign in, add a passkey, revoke a device, and make
  new codes. Nothing else:
  - `decide` refuses one before it is spent, so a tier 3 approval waits for
    a device (F10.10);
  - every other action that takes a factor refuses one;
  - the codes do not count as the owner's last device, so the phone cannot
    be revoked while codes are all that would be left.
- **The console.** **Lost your phone? Use a recovery code** on the sign-in
  page and in every confirm dialog. After a sign-in with a code, a banner
  asks for a new device. Every attempt is recorded with the others, as kind
  `recovery`.

## 2.33 Rotating the master key

- **A master key could not be changed.** Every key the owner typed into the
  console is sealed under it, and a new `PALUGADA_MASTER_KEY` left all of
  them unopenable. The only way forward was typing each one again.
- **Now the old key is named beside the new one**
  (`PALUGADA_MASTER_KEY_PREVIOUS`). What it sealed still opens, and the
  deployment reseals each secret under the new key when it starts, in one
  transaction with the rows locked, so two replicas reseal each once.
- **What the operator sees.** The start says how many were resealed. A
  secret sealed with a key named nowhere is left as it is and named, since
  it can only be set again. A malformed old key stops the start with the
  variable named.

## 2.34 Containers a killed worker left running

- **`--rm` and the adapter's `finally` both depend on the worker.** A worker
  killed outright (SIGKILL, the out-of-memory killer) reaches neither, and
  the runtime inside its container keeps its memory and CPU until it
  chooses to stop.
- **Each run's container now carries its worker** as the label
  `palugada.worker`. At most once a minute, a worker lists the containers
  with that label and removes those whose worker has not beaten lately. Its
  own runs, and those of every worker still beating, are runs in flight
  and are left alone. A daemon that is not there has nothing to sweep.
- **Checked against a real daemon** (Docker 29.3.1), not only against the
  fake client the suite uses. Two workers each started a container with
  the adapter's own argv and were killed with SIGKILL, and both containers
  kept running. A third process swept with only one of the two workers
  alive, and removed only the dead worker's container.

## 2.35 Documents found by meaning (F4.2)

- **A search matched words only.** A role asking about the refund policy
  found nothing in "Returns and money back", and pgvector sat installed and
  unused.
- **Meaning is a tool the owner chooses** under **Tools**: OpenAI, Gemini,
  Mistral, Voyage, Jina, Ollama or any OpenAI-compatible server, all through
  OpenAI's `/embeddings` request as each one documents it. None was called
  with a live key here; a local server answering as they do was.
- **How passages get their meaning (0087).**
  - The worker gives each company's passages their vectors, one batch a
    tick, in the background, never while the owner waits for an upload.
  - Each vector is kept with the model that made it. A search compares
    only vectors of the model in use, since two models' vectors are not
    comparable, and a new model means every passage is embedded again.
- **How a search ranks.** `memory.search` ranks by words and by meaning,
  fused by reciprocal rank. A passage is found by meaning alone only above a
  similarity floor, so none is found for merely being the least unlike.
  A provider that is down leaves the search to words.
- **Not carried by an export.** A vector is made again by the receiving
  deployment's provider.
- **Not yet by meaning.** Memories (their column is fixed at 1536
  dimensions, from before a provider could be chosen) and the owner's
  search across companies.

## 2.36 Aggregators among the MCP servers offered by name

- **One server that reaches many apps.** Composio, Pipedream, Arcade and
  Smithery join Zapier among the servers the console offers by name.
- **Checked before they were offered.** Each was checked against its own
  reference and, without credentials, against its 401 and its OAuth
  metadata. All four register PALUGADA as a client when the owner signs
  in; Smithery also takes a key.
- **Breadth, not trust.** Every tool an aggregator lists is still allowed
  one at a time, with its tier, like any other server's.
- **Addresses the owner completes.** Arcade's address ends in the owner's
  gateway, and Smithery's in their namespace. The console neither asks the
  server nor saves while the part in braces is still there. Seen in a
  screenshot, the first version asked Arcade for the gateway `{gateway}`.

## 2.37 What the threat model found, and what changed

`docs/THREAT-MODEL.md` names, for each kind of attacker, the defences in the
order they apply, the file and the test for each, and what is left. Reading
the code against it found these, and each is now closed with a test.

- **A role's tools were a list only the tool bridge read (F2.4).** An agent
  CLI saw only its role's tools; a runtime that speaks the wire itself -- a
  script, an HTTP service, a container -- could name any tool its division
  holds, and the broker, which checks the division, let it through. The
  engine now refuses any other name from a runtime in another process,
  before the broker is asked, and records it as `policy.denied`.
- **Taint flowed down and not up (F8.9).** A run could hand the reading of
  an email to a sub-task, take its answer back and send at tier 2 with
  nobody asked. A read anywhere below a task now counts for it. So does a
  lesson learned from outside content: found through `memory.search`, or
  told in the run's briefing, which the engine records as it builds the
  run's request.
- **A division's credential could name the deployment's own secrets** that
  are not sealed in the console: the owner's second factor as setup writes
  it, `env://PALUGADA_SECRET_OWNER_TOTP`, or an MCP server's token file. An
  imported archive keeps references as they were. The broker now refuses
  any reference the deployment's configuration names, and anything that
  resolves to the same value under another name.
- **`/api/health` told anyone why the database could not be reached**: a
  host, a port, a role's name. It says `unreachable` now, and the log keeps
  the driver's words.
- **An edited migration was skipped where it had run.** `scripts/migrate.ts`
  recorded names only. It keeps each migration's checksum now and refuses,
  by name and before anything runs, one whose file changed; line endings do
  not count. A database migrated before this takes its files as they are on
  the next run.
- **`npm start` held the schema owner's URL**, read from the `.env` setup
  writes. It drops it before it boots; nothing in the platform used it.
- **Left as stated in the threat model.** Telegram's update ids are kept in
  memory; the TOTP lockout can be held by anyone who can reach the sign-in
  page; a tainted run can still put company data in a tier 0 `web.fetch`;
  the event log is not hash-chained.

## 2.38 Closing a company, and erasing it (UU PDP)

- **A company could be frozen and exported, never erased.** Every table
  cascades from the company except its history, which refuses deletion,
  so the one delete that would have erased a company failed on its first
  event. The people in a company's records have the right to have them
  erased (UU 27/2022), and an owner ending a business has to be able to.
- **Closing** takes the owner's device and the company's name typed out,
  both checked before a code is spent. The company is frozen at once and
  given a day 7 to 90 days away; until then **Keep this company** takes it
  back, and it stays frozen until the owner unfreezes it. A closing company
  cannot be unfrozen.
- **Erasing** is the worker's, when the day comes: every row of the company
  in one transaction, the append-only history included, the keys its
  divisions held in the deployment's sealed store, and a vendor sign-in
  that was under way. One line is left in `company_erasures`: the name,
  when it was closed and erased, and how many rows of what went.
- **The database holds the rule, not the caller (0088).** The history's
  triggers let a delete through only in a session erasing that very
  company, after its line exists, and the line cannot be written until the
  company was closed and its grace is over. At least seven days of grace is
  a constraint on the table. A delete of a company that was never closed
  still fails on its first event.
- **What it cannot reach**, and the guide says so: backups taken before the
  day, what model providers and vendors were sent, and the owner's own chat
  history.

## 2.39 Telegram updates taken in once, whichever process gets them

- **The channel remembered update ids in its own memory.** An update
  Telegram sent again after a restart, or to another replica behind the same
  address, was handled again: not a decision, whose item was closed, but the
  owner's words to the CEO, said and answered twice. The threat model named
  it (2.37).
- **Claimed in the database now (0089)**, keyed by the bot and the update
  id, as WhatsApp's messages are (0085), and kept two weeks: Telegram gives
  up on an update after a day.

## 2.40 Traces for an OpenTelemetry collector

- **Traces lived only in the console.** An operator with Jaeger, Tempo,
  Honeycomb or Datadog could not see a company's runs beside the rest of
  their services. Row 13 of the competitive analysis of 2026-09-30.
- **Each finished run is sent as a span** over OTLP/HTTP in JSON, with its
  steps and its model calls under it and one trace per task, to the
  collector the standard `OTEL_EXPORTER_OTLP_*` variables name. Model calls
  carry the GenAI semantic conventions: model, input and output tokens.
- **Nothing that was said.** Prompts, responses and tool inputs and outputs
  stay in the console; a collector is often a vendor's.
- **Once, and nothing lost.** Where it had got to is kept in the database
  (0090) under a lease, so replicas do not send a run twice and a restart
  does not skip one; the cursor moves only when the collector has answered
  2xx, from the row's own timestamp so a microsecond is not lost. Tested
  against a collector's HTTP port that fails and comes back.
- **Checked against a real collector** (OpenTelemetry Collector 0.114.0,
  OTLP receiver on HTTP, debug exporter): a run's four spans arrived in one
  trace, the task's id as its trace id, the steps and the model call under
  the run, and the token counts read as integers.
- **One format.** OTLP over HTTP in JSON, which every collector accepts on
  its HTTP port. `grpc` or `http/protobuf` is refused at the start by name.

## 2.41 Email as a place the owner is told things

- **An owner who lives in their inbox was told nothing there.** Row 10 of
  the competitive analysis of 2026-09-30, its owner half.
- **Through a sending service**, chosen under **Channels**: Resend,
  Postmark or SendGrid, each in its own request shape. One HTTPS request
  with a key, where SMTP would be a conversation and a dependency. Each
  service's address and key header were confirmed by the 401 it answers a
  key that is not one; no real message was sent from here. Brevo is not
  offered: its reference could not be read to check the body it takes.
- **Told, never asked.** What needs the owner, the daily digest and
  finished work, each with a link to decide or read it in the console. An
  email is forwarded, previewed and scanned by filters, so it carries no
  button that decides anything.
- **Set like the other channels**: a test before saving, the key sealed,
  saving with a factor, a half-set environment named at the start.
- **Not yet**: a mailbox for agents to receive email.

## 2.42 Any agent that speaks ACP, from one entry

- **Each agent needed a dialect written for it.** Row 14 of the
  competitive analysis of 2026-09-30: Paperclip and Multica run agents
  through the Agent Client Protocol, which some forty agents speak.
- **`"dialect": "acp"`** in a `PALUGADA_RUNTIME_SPECS` entry
  (`src/runtime/acp.ts`): version 1, JSON-RPC on the agent's stdin and
  stdout. `initialize`, then `session/new` with the tool bridge as an MCP
  server over HTTP and the run's own token in its header, then the prompt.
- **PALUGADA is a client with nothing to lend.** It advertises no file
  system and no terminal and answers "method not found" if asked anyway.
  A permission question is answered once, never "always": yes only when
  the call is named exactly as a role tool on the bridge, and never for a
  shell, edit, delete or move, however it is named -- an agent titles a
  shell call with its command, and one ending in a bridge tool's name is
  tested. The no is in the run's transcript.
- **Stopped in the protocol first.** A withdrawn run sends
  `session/cancel`; the process is ended five seconds later whatever it
  did.
- **Charged what it says.** `usage_update` carries the session's cost in
  US dollars, which is what the run is charged; version 1 reports no
  tokens.
- **Halted with the reason**, as `runtime_unavailable`, when the agent
  cannot reach an MCP server over HTTP, answers with another version, or
  refuses the session as not signed in: another attempt would meet the
  same agent.
- **Unverified**: no real ACP agent ran here, since each needs a
  provider's key. The tests run a stand-in written to the version 1
  schema; what they prove is what PALUGADA says and answers.

- **Found in review, and closed.**
  - *A run that failed cost nothing.* The session's cost was reported only
    after a successful turn, so an agent that spent and then errored,
    crashed or was killed was free, and so was every retry. It is reported
    as the run goes and before any failure.
  - *A line nobody could read left the run waiting.* A failure while
    reading was swallowed and the adapter waited on an agent that no
    longer had a reader; one that survived the broken pipe held the run
    until its deadline, or for ever. The agent is stopped and the run
    fails with the reason. A line that is not a message, and an odd
    option in a permission request, are skipped rather than fatal.
  - *A run withdrawn before its session opened did its whole turn*, since
    `session/cancel` is for a turn in progress. The prompt is not sent.
  - *Not signed in* halts the task from any request, not only
    `session/new`; an id echoed as a string is answered; a permission
    request naming only its tool call is judged by what the agent said of
    that call as it began it, and a kind of its own there still refuses it.
  - *Dollars to cents overcharged.* $0.07 is 7.000000000000001 cents in
    floating point, charged as eight; the engine now ignores what lies
    below a millionth of a cent, for every runtime, the price table's
    estimates and the guardian's looks.
  - *A second review:* an agent started through a shim shares its pipes
    with the shim, so the whole process group is stopped; a cost reported
    before the prompt is charged; and the cost is reported every thirty
    seconds rather than five, each report being a settlement.

## 2.43 Calls at once, per capability (F5.7)

- **Half of a P0 requirement was missing.** F5.7 asks for a concurrency
  limit per division and per capability; the division's was kept by the
  claim, and a capability had only its rate per hour, which says nothing
  about overlap. A vendor that takes one request at a time, or production
  deploys that must not run side by side -- the PRD's own example -- had
  nothing to hold them.
- **A grant says how many** (`max_in_flight`, 0091), set by the owner with
  **Change a grant**, by a template or by a bundle. The standard company's
  production deploys are held to one.
- **Places are rows**, one per call the grant allows, so every worker
  counts the same calls. A call takes a free place before anything is
  recorded or charged and gives it back once the vendor has answered, or
  as soon as anything on the way fails. Two workers after the last place
  take it once (`FOR UPDATE SKIP LOCKED`). The application role writes
  places and never deletes them (0047).
- **A dead worker gives its place back** when its lease lapses, without
  anyone noticing it died: a place counts only while its holder still holds
  the task's lease. A call made outside any lease holds one fifteen minutes
  at most.
- **Waiting is not failing.** A call waits up to thirty seconds for a place;
  past that the task is parked (`task.waiting_slot`) and picked up fifteen
  seconds later, spending no attempt. Unlike a vendor's rate limit, it is
  not counted against the five parks a task gets: the calls ahead end or
  their leases lapse. A runtime in another process is parked the same way.
- **Tested** with two brokers standing in for two replicas: never two
  calls at once, a waiting call taking the place the moment it frees, a
  lapsed lease freeing a place, and six parks in a row without a failure.
- **Found in review, and closed.**
  - *Two replicas could both take the last place.* A place taken and
    committed between a second taker's snapshot and its row lock was
    re-checked by PostgreSQL against the new row but the old join, read as
    free, and taken again. Takers of one capability in one division now
    take turns on an advisory lock; twelve takers at once, five rounds,
    get exactly the two places there are. The race was reasoned from how
    PostgreSQL re-checks, not reproduced.
  - *A runtime in another process was not parked.* `capability.busy` and
    `capability.rate_limited` reached it as tool errors, the run went on,
    each try held it thirty seconds, and a write refused every time spent
    an attempt. Both park the task now, as they do in-process.
  - *A limit had no ceiling.* A place is a row made the first time it is
    wanted, and 2,147,483,647 passed. A grant allows at most 100, in the
    console, in a bundle (refused with the bundle's name) and in the
    database (0093, not validated against grants already above it, which
    the broker holds to 100).
  - *A lowered limit waited for running calls to end.* Every live holder
    counts now, whichever place it holds.
  - *A place could be kept by a call that never ran* when spending the
    owner's yes failed; it is given back first.
  - *A call that waited for a place was judged, and counted a yes for a
    while as used, on every try*, since both came before the place was
    taken: each try was another look the company paid for. The place is
    taken first now, and given back when the owner is asked or anything on
    the way fails.

## 2.44 Charters as files, in a git repository (F3.11)

- **The requirement's direction was not the deployment's.** F3.11 has the
  charters as `SOUL.md` and `PLATFORM.md` in an internal git repository,
  edited as files. The code that reads and writes them was tested, and no
  boot gave it a directory: in a stock deployment a charter lived only in
  the database.
- **Every deployment keeps a repository now**, `charters` beside its state
  (`PALUGADA_CHARTERS_DIR` to put it elsewhere), made on the first boot.
  It is brought level with the database at boot, as the owner saves or
  puts back a charter in the console, and every minute for what a template
  or a bundle published (`src/governance/charter-repository.ts`).
- **Both ways.** A file edited in the repository is published as the
  charter's next version and committed; a charter published anywhere else
  is written to its file and committed as PALUGADA. Which one a difference
  is, is decided by what PALUGADA last wrote to each file, kept beside them
  and ignored by git: a file still holding what PALUGADA wrote is the
  database's to change. Without that, a tree left from an earlier database
  -- a restored backup, a reinstall -- would overwrite the charter the owner
  has now; the test puts a charter back in the console after a file edit
  and the file does not win.
- **A directory for a company the deployment does not have** is left alone
  and named at boot: a file is not authorisation to create a tenant.
- **git is the history, not a condition.** Without it the files are kept
  and read, and the boot says there is no history; a failed commit never
  fails a charter. The Docker image installs it.
- **Found in review, and closed.** The directory is written to by whoever
  can push to it, and was trusted further than a charter the owner types:
  - *A link was followed both ways.* A `SOUL.md` pointing at the master
    key was published as the company's charter, into every run's context,
    and the owner's next save overwrote the key through it. A link, a
    directory or a device where a charter should be is refused now, and so
    is a company directory that leads out of the repository.
  - *A directory inside another repository committed that repository.*
    `rev-parse` succeeded from the parent, and `add --all` took in its
    `.env` and master key. The directory is made a repository of its own
    unless it is already its repository's top level, and the repository's
    own hooks run on a commit.
  - *A merge in progress was published*, conflict markers and all, and the
    commit concluded it. A merge, a rebase, a cherry-pick or a revert holds
    the whole sync; a file holding conflict markers is refused.
  - *One unreadable file froze the record of what was written*, and every
    later save the owner made was then taken back from its file as if it
    were an edit. Each file is brought level on its own, recorded as it is
    done, and one that cannot be is reported and left.
  - *A file skipped the console's limits and was credited to the owner.*
    It is held to the same 20,000 characters, refused with a NUL in it, and
    a version taken from it is the repository's in the history. A file left
    for a company that did not exist yet is recorded as seen, not taken as
    that company's charter when it does.
  - *Git's reason was cut to its first line*, which is "Command failed";
    what git said is reported now, and a failed or held repository is
    named at boot.
- **A second review found the repository's own files still open.**
  - *Its record and its `.gitignore` followed links*: a pushed
    `.palugada-written.json` linking to the master key was overwritten
    with JSON, and a linked `.gitignore` was appended to. Both are refused
    as links; the record is written beside itself and renamed over, and a
    record that is not a record of files holds the sync.
  - *A failed publish was recorded as written*, so the next sync wrote the
    database's charter over the edit it never took. It is recorded once
    published.
  - *`add --all` committed refused files*, and concluded a conflicted
    `stash pop`, which leaves no MERGE_HEAD. Only the charters brought
    level are committed, and unmerged index entries, a bisect, a sequence
    of cherry-picks and a detached HEAD hold the sync.
  - *A file where `companies` should be stopped every charter*; it now
    refuses the companies' and keeps the platform's.
  - *The owner was not told when a save did not reach its file*, only the
    boot was. A save now answers with why its file was not written, and
    the console keeps that on screen: the charter is saved and runs are
    told it, and the file is what the next edit there starts from.

## 2.45 A guardian that may only tighten

- **The gap F8.9 leaves.** After the work reads content from outside the
  company, a tier 2 action asks the owner; a tier 0 or 1 action -- a fetch
  whose address carries the customer list, a note that plants an
  instruction in memory -- runs on whatever the content persuaded the run
  to do. Row 7 of the competitive analysis of 2026-09-30: Claude's auto
  mode, OpenAI's Dots and Google's semantic policies put a model in front
  of such actions.
- **Here it has one power and not the other** (`src/broker/guardian.ts`,
  0092). A company that turns it on has each tier 0 or 1 call in such work,
  that no policy already sends to the owner, judged by a model first. It
  may send the call to the owner, with its reason on the card; nothing it
  answers lets through a call a tier, a policy or F8.9 would have asked
  about, and a standing approval never covers one it asked about.
- **It is not shown the outside text**, only the owner's request and the
  call as the approval card describes it, the arguments fenced as data. A
  guardian talked into "no doubt" leaves the call where it was without one.
- **It fails closed.** No model, a provider down, an answer that is not a
  verdict: the owner is asked, and the card says why.
- **Paid for and visible.** Each look is a model call charged to the work's
  budget account, traced, and recorded as `guardian.judged`. A card the
  owner approved is not judged again.
- **Off by default**, because it costs a call per small action in such
  work and asks the owner more. On with the session; off with the owner's
  device, since that loosens.
- **Unverified:** how often a real model doubts a harmless call. The tests
  script the model's answers.
- **Found in review, and closed.** The guardian could not be made to let a
  call through, but work could get past it and past F8.9 itself:
  - *A rerun dropped the taint.* "Do it again" makes a new root task from
    the old one's input -- a webhook's event, a brief written after an
    email -- and the new task's chain said nothing of how the old one
    began, so a tier 2 send the owner had refused went unasked. A rerun
    now carries what the task it reruns carried.
  - *A sub-task briefed after a sibling's read was clean.* A parent carries
    what its sub-tasks read, since it comes back to it; a child's chain sees
    only reads above it. A child is now made carrying its parent's taint.
  - *A standing yes covered tainted tier 0 and 1 calls.* `outside` was
    looked up for tier 2 only, so a policy's yes for a while, given for
    clean work, reached a call the guardian would have judged. It is looked
    up at every tier now.
  - *An agent's brief was shown as the owner's request*, unfenced, and the
    call's description, built from the arguments, sat outside the fence.
    The guardian is shown the nearest request the owner, a schedule or a
    trigger made, and a delegated, handed-off or rerun brief is fenced as
    an agent's words; so is the description.
  - *A look the budget refused was dropped, and the call went ahead.* It
    stops the call now, as `budget.exceeded`, and is traced at its cost. A
    provider that does not answer in thirty seconds is a doubt, and a call
    withdrawn while it was judged is not made.
- **A second review, and what it closed.**
  - *A task the owner handed a ticket a run filed was clean*, though a
    ticket's words may be a customer's (`ticket.list` reads as outside
    content). It carries them now, and the guardian fences its goal.
  - *The rerun's taint was written after the task was made*, in a second
    transaction a worker could claim the task before. It is written with
    the task.
  - *Out of process, a budget refusal was a tool error*: the run went on,
    and each try could be another paid look by the guardian. It halts the
    task, as it does in-process.
  - *A rerun of the owner's own work was shown as an agent's*; the rerun
    is followed to the task it reruns. The timed-out model request is
    withdrawn, not left running.

## 2.46 A whole run in a real container

- **Section 3 said it had never happened.** The `docker` backend's flags
  were tested as an argv, and the sweep once against a daemon; no run had
  gone through a real container, so that the flags do what they say was a
  belief.
- **`npm run container:check`** (scripts/container-check.ts) builds a small
  image (deploy/container-check) whose runtime tries what a compromised one
  would, runs one run through `ContainerAdapter` with the same command line
  every run gets, and checks the runtime's own report. On Docker 29.3.1 here:
  it ran as 65534:65534; writing its image failed with EROFS and its scratch
  space took a write; a name did not resolve (EAI_AGAIN); the internet and
  the host's database port were unreachable (ENETUNREACH); it had no
  interface but loopback, no capability, no-new-privileges set, and 512 MiB;
  it saw none of the orchestrator's environment; its one tool call reached
  the engine over stdio; and no container was left.
- **The check can fail.** The same image run without the adapter's flags
  reported root, a writable image, a resolver, the internet, an interface
  besides loopback, capabilities and no memory limit.
- **CI's docker job runs it**, and an operator runs it on the machine that
  will run the containers: podman, rootless Docker and a remote DOCKER_HOST
  each decide some of these for themselves.

## 2.47 The image sets its database up, and PID 1 holds no password

Read against what Coolify and Dokploy give a container they run, on
2026-09-30.

- **2.27 was true of one variable and not of the container.** It found no
  process with `PALUGADA_OWNER_URL`. Compose's `app` service also reads
  `.env` whole (`env_file`), and `npm run setup` writes the superuser's and
  every role's database password there (`PALUGADA_DB_*_PASSWORD`): tini and
  the platform were started with all four. Run alone with the owner's URL,
  tini -- PID 1 -- was started with it, and `env -u` took it from the
  platform's process only. Agent CLIs run as the platform's user, and a
  process can read the environment another process of its user was started
  with in `/proc/<pid>/environ`, so each of these was theirs to read.
- **The entrypoint (`deploy/docker/entrypoint.sh`)** now provisions, then
  migrates, then unsets both URLs, `POSTGRES_PASSWORD`, every
  `PALUGADA_DB_*_PASSWORD` and every `SERVICE_*` variable (Coolify gives
  every container of a resource all of them), and only then execs tini. The
  test runs it with all of these set and a program in tini's place: the
  program saw none of them, and saw the application's and control plane's
  URLs and a model key. On the real image, with Compose from a clean volume:
  `migrate` applied 0001 to 0093, `app` came up healthy, `/api/health`
  answered 200, PID 1 was `/usr/bin/tini -- node src/main.ts`, and no
  process in the container held a password variable.
- **A database without the repository.** Compose's `db` service mounts
  `setup-database.sh` and `initdb.sh` from the checkout; a platform that runs
  images has no checkout to mount, and runs its setup step on every deploy.
  `scripts/provision-database.ts` takes a superuser's URL and the three
  roles' URLs, makes what is missing, corrects a role whose attributes are
  wrong, sets each password to the one in its URL, and drops nothing; the
  image runs it when given `PALUGADA_SUPERUSER_URL`. The test provisions a
  new database, finds only `palugada_admin` bypassing row level security and
  no superuser, has the owner write a row, runs again and finds nothing
  changed and the row kept, loosens `palugada_app` by hand and finds it put
  back, and refuses a URL for the wrong role, one without a password, and a
  superuser URL that is not a superuser's.
- **Not closed.** The platform still holds what it needs -- the application
  and control-plane URLs, and any key given as an `env://` reference -- in
  its own environment, readable by an agent CLI that escapes its flags
  (THREAT-MODEL 2.3). Running agent CLIs as a user of their own, or in the
  container backend, is what closes it.

## 2.48 The first owner, without a secret in the environment (F12.5)

- **A deployment on a platform could not be entered.** Signing in takes the
  owner's authenticator, and the first one came only from
  `PALUGADA_OWNER_TOTP_REF`: a base32 secret `npm run setup` or
  `npm run totp:new` made in a terminal. Coolify and Dokploy offer no
  terminal before the first deploy and generate passwords, not base32, and
  the console had no route that adds a TOTP authenticator at all. A
  deployment started without the variable said "no authenticator is
  enrolled" and could be entered by nobody.
- **A claim link (`src/owner/claim.ts`, 0094).** A start with no live
  authenticator of the owner's makes a claim and prints
  `no owner yet: open <address>/#/claim/<code>`. The code is 160 random bits
  kept as their SHA-256, good for a day, in the fragment so neither the
  server nor a proxy logs it. Opening it shows a secret as a QR code and as a
  key; the code the app then shows enrols it, sealed under the master key, as
  the one authenticator, spends every claim, and signs the owner in. The
  secret is derived from the master key and the claim rather than kept, so
  the laptop and then the phone see the same one, and the code left in the
  log does not give it.
- **Nothing is claimed once there is an owner.** `enrolTotp` takes a lock
  and refuses in the transaction that would enrol, so two claims confirmed
  at once make one owner, and a claim opened before the operator enrolled a
  phone from the environment is refused with 409. A wrong code is counted by
  the sign-in throttle like a wrong sign-in code.
- **Tested.** `owner-claim.test.ts`: a guess refused; the same secret twice;
  nothing kept before the code is confirmed; a code from another secret
  refused and nothing enrolled; the right one signs in and signs in again
  later; the link spent afterwards and no new one made; a link a day old
  refused; two links from two starts; neither honoured once a phone was
  enrolled from the environment. `process.test.ts`: `npm start` with no
  owner prints the link, the link makes the owner, and the next start prints
  none.
- **Seen in a browser.** The sign-in page says the deployment has no owner
  yet; the claim page's QR code decoded, with jsQR, to the `otpauth://` link
  holding the key shown beside it; typing the code from that key landed on
  **Home** signed in; the spent link says so. Opening the link in a tab
  already on the console changed only the fragment and showed nothing new --
  the page now follows the address. Both pages overflowed a 390-pixel phone:
  six large code boxes are wider than the card, on the sign-in page too
  since it was written; they are the medium size on a narrow screen now.

## 2.49 Coolify and Dokploy

Read from the source of both on 2026-09-30 (Coolify 4.3.23 and main,
Dokploy 0.30.8 and canary) for how each runs a compose file, and each
verified here by running Compose the way the platform does. Installing
either platform in this environment was not allowed, so neither ran it.

- **Coolify (`deploy/coolify/docker-compose.yml`).** A Git application with
  the Docker Compose build pack. Coolify runs Compose with the repository as
  the project directory, keeps `${VAR:?message}`'s message as the variable's
  value, gives every service of the resource every variable as `.env`, and
  generates `SERVICE_PASSWORD_*` (32 letters and digits) and
  `SERVICE_HEX_64_*` the first time it reads the file. The file uses those
  for the superuser, the three roles and the master key, takes the public
  address from `SERVICE_URL_APP` (the domain given in the UI, without the
  port `SERVICE_URL_APP_8787` routes to), publishes no port and mounts
  nothing from the repository, which Coolify does not keep after the build.
- **Dokploy (`deploy/dokploy/docker-compose.yml`).** A Compose service in
  Docker Compose mode: a stack cannot build and ignores the database's
  health. Dokploy writes the Environment tab to `.env` beside the file and
  runs Compose from there unless a File Mount is set, so the build context
  is two directories up; a missing password stops the deploy with the
  message after `:?`. It generates nothing for a repository's compose file,
  so the guide says how to make the four passwords.
- **Simulated.** Each file run as its platform runs it -- Coolify's
  project directory and `.env` added to every service; Dokploy's working
  directory, `--env-file` and `env -i` -- with the image built from this
  tree and a fresh volume: the database was provisioned and migrated
  (0001 to 0093), the app came up healthy, `/api/health` answered 200 for
  the public name and the console 421 for another, and PID 1
  (`/usr/bin/tini -- node src/main.ts`) and the platform held no
  `SERVICE_*`, `POSTGRES_PASSWORD` or `PALUGADA_DB_*` variable. A restart
  said the database was already as PALUGADA needs it and the schema already
  up to date. A Dokploy file with the passwords missing refused before
  anything ran, naming the variable.
- **Backups.** Dokploy backs up a PostgreSQL service inside a compose stack
  on a schedule; Coolify's scheduled backups are for databases it runs as
  such, not one inside a compose application, which its parser does not
  treat as a database. The guide says so and gives a `pg_dump` for Coolify.
- **Not done.** No published image, so neither platform's one-click
  template catalogue can list PALUGADA: both take an image, not a build.
  Coolify's official templates also need a thousand GitHub stars.

## 2.50 Found by reading Buzz: a lease with a deadline, a worker that never ticked, migrations that wait

Read against the source of Block's Buzz, on 2026-09-30.

- **A worker cut off from its database kept its run.** The lease keeper
  (`src/engine/lease-keeper.ts`) gave a run up only when a renewal said the
  lease was someone else's. Any other failure -- a connection dropped, a
  pool with nothing to lend -- was left to the next tick without limit, and
  a renewal that never answered left every later tick returning at once,
  because one was still in flight. The worker went on running the task
  while its lease lapsed in the database, and the worker that took it next
  made the same side effects beside it. The keeper now remembers when the
  last renewal that succeeded began -- the database sets the lease to run
  out one lease after that -- and, on every tick and before any step,
  gives the run up once a whole lease has passed since, whether or not a
  renewal is in flight. The run is aborted as for a lost lease, and
  `confirm()` refuses with `task.lease_lost`: no renewal succeeded for a
  whole lease, so another worker may hold the task. A run that showed no
  progress is still let go as quiet and handed back while this worker
  holds it; the deadline is for renewals the keeper wanted and did not
  get. `lease-keeper.test.ts` holds it without a database, with a lease of
  240 ms: renewals that always fail with a connection error, and one that
  never answers, each give the run up within a tick of the lease running
  out, and `confirm()` then refuses without renewing; one failure followed
  by successes keeps the run; a lost lease is still given up on the first
  renewal; and a quiet run is let go as quiet, not as lost.
- **A worker that never finished a tick was healthy.** `/api/health`
  measured a stalled loop from `worker.lastTickAt`, which is set only when
  a tick finishes, and a worker that had never finished one had nothing to
  measure from: a first tick that hung, or failed every time while the
  database answered `SELECT 1`, was reported able to work for as long as
  the process lived. The worker now records when it started
  (`Worker.startedAt`), and `workerHealth` (`src/main.ts`) measures from
  the later of that and the last finished tick. Half an hour after the
  start with no tick finished, the page answers 503 with `no tick has
  finished since the worker started at …`. `operability.test.ts` starts a
  worker whose every tick throws, and finds it able to work a minute after
  its start and unable to work thirty-one minutes after, with that
  problem; a worker that has ticked is still measured from its last tick.
- **A migration waited on a lock without limit.** A statement that alters
  a table waits for every transaction that is reading it, and every later
  query on that table waits behind the statement: behind one long
  transaction, `scripts/migrate.ts` stopped the running platform for as
  long as that transaction lasted. Once it holds the advisory lock that
  lets one replica migrate while the others wait -- a wait still as long
  as it needs to be -- it sets `lock_timeout` to ten seconds. A migration
  that cannot get its lock in that time is rolled back, and fails naming
  itself: it waited for a lock another session holds, and is to be run
  again once that session is done. The image's entrypoint then exits, and
  its restart runs the migrations again. `process.test.ts` holds a lock on
  `companies` from another session and migrates a copy of the migrations
  with one more that alters it: it fails in about ten seconds with that
  message, and the migration is neither recorded nor applied.

## 2.51 Found by reading Buzz: erasure one company at a time, and the files too

Found by reading the source of Block's Buzz against 2.38, on 2026-09-30.

- **One company that could not be erased stopped every one after it.**
  `eraseDueCompanies` went through the due companies oldest first with no
  catch of its own, and the worker's stage caught what it threw. A trigger
  refusing, or a statement timing out on a large company, was every later
  company's failure too, on every tick, and all that showed was a count of
  stage failures. Each company is now erased on its own. One that fails
  keeps the failure on its row (0096: how many tries, what the last one
  said, when the next is), is named with its reason on the tick and in the
  log, and waits a minute, then two, doubling up to six hours, rather than
  failing every few seconds; the companies after it are erased in the same
  pass. **Keep this company** clears the failure with the closing, and a
  table constraint holds that a company that is not closing carries none.
  **This deployment**, **Erased companies** lists the companies not erased
  yet above the ones that were. The test puts a trigger on `companies` that
  refuses one company's delete: the worker's tick erases the next company,
  names the first with the trigger's words, the console lists it with one
  try and a minute to wait, the next pass leaves it alone, and the try
  after its time fails again and waits two minutes.
- **Erasure deleted rows and left the files.** A company's drafts,
  generated pictures and recordings live in its directory under
  `PALUGADA_FILES_ROOT`, named by its id, and its charter in the charter
  repository's `companies/<slug>/`; both outlived it. After its rows, never
  before, the worker now removes the directory and the folder, and commits
  the folder's removal in the charter repository as PALUGADA, as it commits
  every charter. A link is removed as a link and never followed, and a
  charter folder that leads out of the repository is refused. What cannot
  be removed is named on the tick with its path and why, and the rows stay
  erased: they are most of what the right to erasure is about. On its first
  tick a worker removes what earlier erasures left -- one from before this
  change, one whose process stopped between the rows and the files, a
  removal that failed -- skipping a slug a live company has taken since.
  The deployment hands the worker the files root and the charter repository
  it was started with (`src/main.ts`). Tested with two companies, each with
  a committed charter and a draft on disk: the erased one's are gone, the
  removal is committed with nothing left uncommitted, and the other's are
  as they were; a charter folder replaced by a link is reported and not
  followed while the rows stay erased; and a company erased by its rows
  alone has its files and charter removed on a worker's first tick.
- **A table added without a cascade would have been erased only by
  accident**, or not at all. An erasure is one delete of the company, and
  the cascade from `companies` reaches everything else. A test now reads
  the catalogue: every table with a `company_id` has a foreign key to
  `companies` that cascades, or is named with how it goes --
  `company_erasures`, the line that outlives the company on purpose, and
  `credential_authorizations`, which the erasure deletes by the company.
  It found no table missed today, and fails on one made without a cascade
  (checked by adding one).
- **Closing and keeping wrote their event in a second transaction.** A
  process that stopped between the two closed or kept a company with
  nothing in its history to say so. Each is now one transaction on the
  control plane, the way a rollback records itself. Tested with a trigger
  that refuses the event: the company is then neither closing nor frozen,
  and a keeping refused the same way leaves it closing.
- **Still not erased**, and the guide says so: the charter repository's
  history, whose commits before the removal hold every charter the company
  had (rewriting a repository an operator may have cloned is theirs to do,
  and the guide says how); backups taken before the day, until they age
  out; files under a root the deployment is no longer started with; what
  model providers and vendors were sent; and the owner's own chat history.

## 2.52 Found by reading Paperclip: agent CLIs a killed worker left running

- **The cleanup ran in the process that was killed.** A run ends its agent
  CLI's process group, and a worker exiting kills every group it still
  holds (`src/runtime/process-tree.ts`). A worker killed with SIGKILL or by
  the out-of-memory killer does neither: the exit hook never runs. Under the
  systemd unit the service's control group is killed with it, and in the
  image tini's exit takes the container's processes down; under `npm start`
  on a bare machine nothing did, and the CLI and everything it had started
  kept running on the owner's key with nothing counting it. `agent_runs`
  held no pid, so no later worker could have found them. Paperclip keeps
  each run's pid, process group and start time, and kills a lost run's
  group after a restart.
- **Each group is written down as it starts** (0095, `run_processes`): the
  pid, the group, the leader's start time from `/proc/<pid>/stat` (field 22,
  clock ticks since boot), the worker's id, the worker's own pid and start
  time, and the machine -- the kernel's boot id and the pid namespace, since
  a pid means nothing outside the two. The CLI, Claude Code and script
  adapters write through the run's services (`processes`), and the row is
  closed when the adapter finds the group empty. The application role may
  add a row and change only `ended_at`.
- **The next worker on the machine ends them**
  (`src/engine/process-ledger.ts`). In the worker's leftovers stage, beside
  the container sweep (2.34) -- on its first tick and once a minute after --
  a worker reads the open rows written on its own machine and ends a group
  whose worker's process is gone (its pid no longer has the start time
  beside it), whose worker has not beaten for a minute, or whose run is no
  longer `running`: SIGTERM, SIGKILL after three seconds, then a check that
  the group is empty, as the adapters end their own. The process is asked
  as well as the heartbeat because a worker restarted at once finds its
  predecessor's last beat still fresh, and a `PALUGADA_WORKER_ID` fixed by
  the operator is the same id after a restart. Each group ended is recorded
  on its run's task (`agent_run.leftover_ended`, with the reason and whether
  SIGKILL was needed), and a worker kept to one company sweeps only that
  company's.
- **A pid is checked before it is signalled.** A group is signalled only
  while its leader's pid still has the start time written down; one that
  now has another belongs to somebody else, and its row is closed without a
  signal. On the machine these tests ran on pids stop at 32768, so a reused
  pid is an ordinary day rather than a curiosity.
- **Tested** (test/acceptance/orphan-processes.test.ts), with real
  processes throughout. A stand-in CLI with a child of its own, written down
  the way a runtime writes it and belonging to a worker that never beat, is
  ended with its child and the task says so; a row whose start time is one
  tick off the process now holding that pid leaves it running; a live run's
  group is left alone until the run is taken back as an orphan, then ended;
  a row from another machine is neither signalled nor closed; a CLI run
  through the engine writes its row and closes it. And with nothing played:
  a separate worker process runs a task on the CLI adapter and is killed
  with SIGKILL mid-run; the CLI and its child are still running afterwards,
  and a new worker's first tick ends both, although the dead worker's
  heartbeat was a moment old -- its process was gone, and `/proc` said so.
- **What is left.**
  - Another machine's leftovers wait for a worker on that machine, and a
    machine that never runs a worker again keeps them.
  - A group whose leader has exited is not signalled, though its other
    members may be the run's: the kernel keeps a pid out of use while a
    live group bears it, but once that group has emptied, the number can
    name a new group whose own leader has exited, and nothing left in
    `/proc` tells the two apart. The CLI, which is what spends, is the
    leader.
  - A worker killed between starting a CLI and committing its row -- a few
    milliseconds -- leaves a group nobody wrote down.
  - Linux only. Where there is no `/proc`, nothing is written down and
    nothing is swept, and the exit hook is all there is.
  - A process that leaves its group with `setsid()` is still out of reach,
    as `process-tree.ts` says.
  - While the platform stop is pressed a tick does nothing but tell the
    owner (F5.8), so neither this sweep nor the container sweep runs until
    it is lifted.

## 2.53 Found by reading Auto-Company: a review that sees the week, proposals that are real

Read against Auto-Company's source on 2026-09-30, for what it does that
PALUGADA said it did. Five findings; each claim was checked in the code
before anything changed, and each change began as a failing test.

- **Past events were offered and never kept (F4.6, F4.8).** `memory.search`
  offered `episodic` memory as "past events", and nothing wrote a row of
  that kind -- only 0004's CHECK named it -- so every run that asked what
  the company had already done was told nothing. And `recall`'s project
  branch, F4.6's "episodic memory is shared per project", was reached by one
  test and no caller, because the capability never passed a project. Not
  offering it would have been fewer lines, and would have left F4.6's half
  about episodic memory a rule about rows that never exist; every task
  already has a project and finishes in one transaction, so the row costs
  one insert. A completed task now leaves one line for its project -- what
  it was for and what it reported (`keepEpisode`, `src/engine/tasks.ts`) --
  marked as outside content when the work read any, and not reinforced like
  a lesson: two runs that reported the same thing are two events.
  `memory.search` with `memoryType: 'episodic'` searches the project of the
  work asking, read from its task. `memory-learning.test.ts`: the line, its
  scope and task, the outside mark; a search that finds it, one from
  outside handed back as data, and a run in another project finding
  nothing. The owner's search across companies leaves episodes out of what
  the companies know: the finished task is already a hit there, with its
  goal and result, and `search.test.ts` found it listed twice.
- **Winding down refused what it was for.** `wind-down-starts-nothing`
  denied every tier 2 action outside finance, while the stage's purpose is
  "finish what is owed to customers": Support could not answer a customer
  owed a refund, and a deny is the one effect the owner cannot answer from
  the inbox. Exempting Support by name would have been a guess -- a tool
  name cannot tell a reply from new outreach, both are `email.send`, and a
  division's slug differs between companies. So the rule is two
  (`company-os` 1.3.0). `wind-down-starts-nothing` denies what is new by
  what it is: `ads.*` and `*.purchase`, whoever asks, finance now included.
  `wind-down-asks-first` makes every other action at tier 2 or above outside
  finance `require_approval`: each reaches the owner, who judges what is
  still owed, and may allow a role's replies for a while (0083) where the
  work read nothing from outside. `stages.test.ts`: winding down, a reply
  becomes a card naming the rule and goes once approved; an ad campaign and
  a domain purchase are refused and put nothing in the inbox; in grow
  neither rule reads anything.
- **The weekly review could not see what it must report.** The
  weekly-business-review skill asks for every goal metric against its
  target, the change since last week, and what shipped; the cadence gave its
  task one sentence. A run sees the measures of its own goal chain, and the
  review's chain is the mission, so every number set on an objective or a
  key result was out of its sight, and so was the week's work;
  `buildWeeklyRetro` had the week, and only the owner's API called it. A
  cadence may now say `facts: 'week'` (`BundleCadence`, refused at publish
  for anything else), installed into the schedule's input, and the
  scheduler hands a schedule that asks the week as it fires
  (`src/reporting/week.ts`): the retro; every active goal by the slug
  `goal.propose` takes, with its unretired measures -- the latest value,
  whether verified, the value a week before and the change; the work the
  company was given and finished that week, one line each (what it was
  for, what it reported); the spend this week, this month and the monthly
  limit; the stage and any stage move waiting for the owner. Read from rows,
  never written by a model. Bounded: at most 25 goals, 40 measures and 20
  tasks, each list saying how many it left out, and every line cut to one.
  A result from work that read outside content is wrapped as data, and the
  review carries that provenance from its first step (F8.9). The weekly
  review's cadence asks for it and its skill starts from it.
  `bundles.test.ts`: a company from the bundle, a measure with values a
  week apart and a retired one, work finished this week -- once after
  reading an email -- and last month, spend, and an open stage proposal; the
  cadence fired, its task's input holds each of them and not the retired
  measure or the old work, and the review carries outside content; with 22
  pieces of finished work the list is 20 and says 2 were left out, in under
  16,000 characters.
- **Goal proposals had no caller, and approving one changed nothing
  (F3.10).** `proposeGoalChange` was documented as the agent's path and no
  agent could take it; the strategist's done criterion said a goal change
  is "written as a proposal", with nothing to write one with. Two defects
  under it: the item said "Nothing changes unless you apply it", so an
  owner who approved then made the same edit again by hand; and the item
  was tied to the proposing task, so a no cancelled that task if it was
  still running. `goal.propose` is a tier 0 platform capability now,
  catalogued, proposing new words, a close (met or abandoned) or a reopen,
  one open proposal per goal. The owner's yes, at tier 3 with their device
  as their own edit of the ladder takes, applies it in the same transaction
  as the answer, and only to the goal as it stood when proposed: one the
  owner has changed since is refused. The item is not tied to the task, as
  a stage proposal is not. The strategist holds it in place of
  `metrics.read`: a role holds at most twelve tools (F2.6), `metrics.read`
  answers nothing until a vendor is bound, and the review is now handed
  every measure. `goals.test.ts`.
- **Premortems nobody watches, and two frameworks missing.** The premortem
  now names, for each of its three risks, the early warning, the role that
  watches it, the number or check it reads and the value that means act
  now, and ends with how sure the company is and what would make it surer.
  `positioning` (as narrow an audience as the evidence allows, the change
  in the customer's words, why one would tell another -- and fixing the
  product before paying for reach -- and reach owned before reach rented)
  and `market-research` (how customers cope today before competitors; each
  competitor's pricing page, changelog and worst reviews; every claim
  confirmed, likely or speculative; what could not be found out and how)
  are new, each with an eval. `bundles.test.ts` holds every eval's phrases
  to the skill's text and every skill under sixty lines.
- **Upgrading.** A company on `company-os` 1.2.0 keeps its rules until the
  owner installs 1.3.0, which updates the role, the rules, the cadence and
  the skills in place (the skills as candidates, as always). Installing
  takes no grant away, so 1.2.0's grant of `metrics.read` stays until the
  owner revokes it.

## 2.54 Coolify's and Dokploy's MCP servers, and a pinned supply chain

Read on 2026-09-30: Coolify's source and the `@dokploy/mcp` package for the
first half. The second follows Paperclip's and Buzz's workflows, which pin
each action to a commit with its tag in a comment; Paperclip also has
Dependabot.

- **Coolify by name.** Coolify serves MCP itself. In its source (main at
  284aded), `routes/ai.php` mounts its server at `/mcp` behind
  `auth:sanctum`, a bearer token. The preset's address is
  `https://{coolify-host}/mcp`, which the owner completes as they complete
  Arcade's gateway (2.36), and its key hint names the token's permissions:
  `read`, and `deploy` only if roles should deploy. Also read there: an
  administrator turns the server on under Settings, Advanced, where it is
  off on a new instance and the address answers 404 until then; a team can
  turn it off for its tokens (403); a token without `deploy` is refused
  `deploy`, `cancel_deployment` and `control`. It lists 45 tools, and
  nothing among them creates or deletes. None of the 45 carries an
  annotation (laravel/mcp sends `{}` for a tool with none), so none says it
  only reads, and here none can be tier 0: a reading tool is allowed at
  tier 1 with a read-back. Coolify Cloud, asked with a made-up token,
  answered 401 with `WWW-Authenticate: Bearer realm="mcp"`, and PALUGADA's
  own client reported that 401: the path and the scheme, on a real
  instance.
- **Dokploy by name, run by the owner.** Its server is the npm package
  `@dokploy/mcp` (Apache-2.0). Version 0.30.7 was read, then run here with
  `DOKPLOY_URL=http://127.0.0.1:9` and a made-up key. Without `--http` it
  speaks stdio, which PALUGADA does not run (F13.4); with it, it served
  streamable HTTP at `/mcp` on port 3000, which is fixed in its code. It
  passes no host to `listen`, and answered on the machine's other
  addresses too; it asked for no token, and accepted an `initialize` sent
  with a foreign Host and Origin. So the preset is one the owner runs, and
  presets gained `runHint`, which the console shows in orange under the
  command: it lets in whoever reaches it, acting with the Dokploy key, and
  must run where only this deployment can reach it. The guide gives a
  Compose service with no published port, whose command was run here in
  `node:22-bookworm-slim` and answered `initialize`.
- **Its tools, through PALUGADA's own client.** `offeredTools`, which the
  console's "Look at its tools" calls, listed 604 tools: 226 that only read,
  52 destructive. `DOKPLOY_TOOL_PRESET=deploy` narrowed them to 119 (47
  and 7), and `minimal` to 43 (11 and 2); the package's README says 508. The
  whole list was 319 KB, well under the client's 2 MiB. The preset's
  command sets `deploy` and names its version, which a new check now asks
  of every preset the owner runs.
- **Deploys wait for the owner.** The guide (coolify-dokploy.md) says to
  allow deploy, restart and stop at tier 3, or at tier 2 with a policy that
  asks: each changes something people are using.
- **Not verified.** No Coolify or Dokploy account was used. No tool of
  either was called with a real token, and nothing was deployed through
  either. That Coolify's tools behave as its source reads, and that a
  Dokploy key made by a restricted user is held to that user's
  permissions, are unchecked.
- **CI's actions by commit.** `actions/checkout` and `actions/setup-node`
  were used as `@v4`, a tag whoever controls the action can move to other
  code, in a job that holds the repository's token. Each is now pinned to
  the commit of the latest v4 release, v4.4.0 for both, which is where
  `v4` pointed on 2026-09-30, so CI runs the code it ran before. Each SHA
  came from `git ls-remote`; neither tag is annotated, so the SHA is the
  commit.
- **The image's base by digest.** Both stages of the Dockerfile start from
  `node:22-bookworm-slim@sha256:43ac6c60…`, the multi-platform index that
  `docker buildx imagetools`, Docker Hub's registry and mirror.gcr.io each
  gave, and whose body hashes to that digest; it holds Node 22.23.3. The
  image built from it here, through this machine's proxy, and its Node,
  tini and console build were there.
- **Dependabot** (`.github/dependabot.yml`), weekly, for npm at the root
  and in `console`, GitHub Actions and Docker: minor and patch updates as
  one pull request per ecosystem, at most three open, and no new Node major
  for the image, which is a decision rather than an update.
- **An audit job in CI.** `npm audit --omit=dev --audit-level=high`, at the
  root and in `console`, in a job of its own, so that an advisory published
  overnight does not also hide what the tests say. Both passed here. The
  root has one moderate advisory, `fast-uri` 3.0.0 to 3.1.7
  (GHSA-hrr3-gc8f-f4qj), below the level that fails, left for Dependabot.
- **Still by tag.** `pgvector/pgvector:pg16` in the compose files and
  `deploy/container-check`'s `node:22-alpine`; THREAT-MODEL 2.8 says so.

## 2.55 A trigger for a sender that can set nothing but a URL

- **Coolify could not start work in PALUGADA.** Its outgoing webhook is an
  address and nothing else: no header, no signature. Every trigger scheme
  wanted either an `Authorization` header or a sender's signature, so a
  failed deployment or a missed backup could not become a task.
- **`url` (0097).** A trigger like `bearer` -- the platform makes the token
  and keeps its hash -- whose delivery carries it as `?token=`. The console
  shows the one address to paste, and says that anyone who sees it can start
  the work. A `bearer` trigger refuses a token in the address even when it is
  right, because a bearer token found there has been in a URL.
- **Tested** (`triggers.test.ts`): no token, a wrong one and a bearer header
  are refused by a `url` door; the right one starts a task, and the same
  event again is the same delivery; a bearer door refuses its own token in
  the address; rotating closes the old address; and the console's route
  takes the token from the query.

## 2.56 Evidence the platform can check (from Auto-Company)

Read from Auto-Company's source on 2026-09-30: its check runner is the
program's, so a test's exit status, counts and hashes are recorded by the
program and a report cannot invent them.

- **Here, the evidence was the run's word.** `checkDone` read only the
  output: a criterion was met when the run said `"met": true` and wrote
  anything at all as evidence. Its own comment said so ("what this checks is
  the run's own account, not the world"), and nothing in it opened the
  journal. The journal already held what Auto-Company's runner records:
  every tool call a run makes is a step, committed with its output or
  failed with its error.
- **Evidence may cite a step, `step:<n>`, and `checkDone` holds it to the
  journal** (`engine/done.ts`, `weighEvidence`; the journal read is
  `journalOf` in `engine/journal.ts`). A citation of a tool call this task
  made that committed makes the criterion **verified**. A citation of a
  step that failed, never finished, or that this task's journal does not
  have -- another task's step of the same number included, since the
  journal read is this task's alone -- fails the criterion like one not
  met, and the retry is told which step and why. Evidence that cites
  nothing, or only the model's own turn, is **claimed**: it passes as it
  always did. Failing rather than leaving a false citation claimed is the
  point: a run that names the CRM write that failed as proof the note was
  written (the chaos run of 2026-09-29) would otherwise reach the owner
  looking like any honest claim.
- **A run is told which step each call is.** The step index is handed back
  as the call is placed (`callTool`'s `journalled`), and written after each
  result, outside the fence around what the tool returned: by the agent
  loop, by the tool bridge an agent CLI reaches, and as `step` on the
  wire's `tool_result`. A failed call is shown as refused, with no step to
  cite. The done instruction says evidence may cite `step:<n>` and that the
  platform checks it.
- **The owner sees which.** The task detail (`taskDetailOf`) carries the
  report weighed against the journal when it is read, rather than a copy
  kept at completion: tool steps keep their name and status as long as the
  task is kept (retention scrubs only a model's replies), so the answer is
  the one the engine gave. **Work**, a task, **Done means** shows a
  **Verified** or **Claimed** badge beside each met criterion, with a
  tooltip saying what each means and which steps were checked.
- **The platform charter says it too.** A new rule 3: a summary says what
  was done and what is still unproven; "ready for review" is not
  "accepted"; a test result, a number or a date is given as a finding only
  if a tool call in this task produced it. The default is published only
  where there is none, so an owner's charter is never replaced; a platform
  charter still word for word the earlier default, as the platform wrote
  it, is given the new one as its next version (`EARLIER_PLATFORM_CHARTERS`).
  The same words put back by the owner, or taken from a file, are theirs.
- **Tested.** `done-criteria.test.ts`: a run through the agent loop cites
  the dns.read it made, is shown `step:1` after the result, completes, and
  the owner's task detail has that criterion verified with its step and the
  other claimed; a run whose call failed cites it, then a step only another
  task of the company has, then one no task has, and each attempt fails
  with the step and the reason, the retry told why; and directly, a model
  turn alone is claimed, a step that never finished and one missing beside
  one that holds are refused. `charter-context.test.ts`: the rule is in the
  default, an earlier default is brought up once, and the owner's copy of
  the same words is left alone.
- **Not done.** A verified criterion shows that a call succeeded, not that
  it shows what the criterion asks: a run can cite a dns.read for "the
  invoice was sent". Judging that is still the reviewer's or the owner's.
  And the platform does not yet run checks of its own, as Auto-Company's
  runner does; a role whose criteria need a test run cites the tool call
  that ran it.

## 2.57 A critic before every stage move (from Auto-Company)

Auto-Company asks for a "Munger" premortem before any GO, written by the
same model session that wants the GO. Nothing makes it happen, and nothing
puts it in front of whoever decides. The operating kit (`company-os` 1.4.0,
`src/bundles/builtin.ts`) makes it a rule.

- **The critic.** A role in a `strategy-review` division of its own, whose
  charter is to assume the move failed six months from now and say how:
  its verdict in one line first -- support, oppose or need more -- then, for
  each risk, the way it would kill the company, and why it supports the
  move despite them when it does. Its output schema is the verdict a review
  reads (`decision`, `reason`), so a run is shown what to return.
- **It holds nothing that acts.** Its grants are four reads, each tier 0 in
  the catalogue -- memory, skills, metrics and the ledger -- to check the
  evidence against the company's own numbers and money. The kit's hook
  `strategy-review.read-only` refuses its division anything at tier 1 or
  above, so a grant somebody adds later changes nothing. It does not hold
  `stage.propose`.
- **Every stage proposal goes to it first.** `stage-move-needs-the-critic`,
  company-wide, puts `stage.propose` behind the critic's review, against
  these criteria: willingness to pay shown by money or a signed commitment,
  not interest; where each piece of evidence came from; the three likeliest
  failures, each with an early warning; what stops a competitor copying it
  in two weeks. A missing answer is a rejection that names it.
- **The owner reads what the critic said, either way.** When it supports a
  move, the proposal reaches the owner as before, with "Reviewed by critic
  before you:" and the verdict on the card, and the review in its payload.
  When it opposes one, nothing the owner could approve into a move is
  raised; an item says what was proposed, on what evidence, and why the
  critic stopped it. Answering it moves nothing, and the owner can still
  set the stage on the Overview. "Need more" sends the proposal back to the
  strategist, and two revisions without agreement reach the owner as any
  review deadlock does (F7.2).
- **A no to a stage move does not stop the work that proposed it.** A
  rejected review fails the task that proposed the action (F7.1). The
  owner's own no to a stage proposal never did, and the critic's would have
  failed a weekly business review for one line in it. For `stage.propose`
  the proposer goes back to work, and asking again is refused with the
  critic's reasons. Every refusal after a rejected review now carries the
  reviewer's reasons; it said only "review rejected".
- **Found on the way, and closed: a reviewer from another division could
  never be given a review.** `openReview` made the review task in the
  proposer's division, so a reviewer ran under the grants of the role it
  was judging. Since 0058, a task's role must also belong to its division,
  so a reviewer in another division could not be given a review at all:
  `qa-review`'s for `content-ops`, `palugada-dev`'s, and now the critic. The
  review task also had no goal, and a bundle role's input schema requires
  one, so a bundle reviewer halted on its input before reading the
  proposal. It is now made in the reviewer's division, with a goal. Every
  existing review test put the reviewer in the proposer's division, which
  is why none of them saw this.
- **Installing 1.4.0 over an earlier version** adds the division, the
  critic, its grants, hook and heartbeat, and the rule. Everything else
  stays as it was: the same role rows, the same weekly review schedule,
  still on, every grant, and work in flight
  (`test/acceptance/bundles.test.ts`). As with any reinstall, the kit's
  skills are proposed again as candidates.
- **Tests.** `test/acceptance/stages.test.ts`: with the shipped kit
  installed, no stage proposal exists until the critic's verdict is
  recorded; a supported proposal carries the verdict; an opposed one is
  never raised, its reasons reach the owner, and the strategist finishes;
  the critic's grants are tier 0, and a tier 1 call is refused by the hook
  even with a grant.
- **Unverified, and not done.**
  - How a real model does as the critic. The tests script its verdicts.
  - The criteria are written for a move forward. A proposal to go back, or
    to wind down, is judged by the same questions, and a critic that
    follows "if any answer is missing, reject" will stop it. The owner is
    then told, with the reasons, and can move the company themselves.
  - `qa-reviewer` and `platform-reviewer` still return the ordinary work
    output, which has no `decision`, so a model's review by either still
    goes to the owner as unreadable. The critic's output schema shows the
    fix; applying it is a new version of their bundles.
  - The verdict is in the item's rationale, which the console shows under
    "Why". A Telegram or WhatsApp card shows an escalation's title and
    what a no means, not its rationale, so the verdict, like the
    strategist's evidence, is read in the app. A move forward is tier 3
    and is decided there anyway. A move back is tier 2 and can be
    answered from the chat without either.

## 2.58 Found by reading Buzz: readiness while stopping, a probe that costs one query, a search with an index

Read against the source of Block's Buzz, on 2026-09-30.

- **A stopping process shut its door on a load balancer that had not been
  told.** `stop()` closed the console's listener first thing, and cut every
  connection with it, including requests half answered. A balancer that
  asks every few seconds went on sending requests into a port that refused
  them until it next asked and gave up on the process. Buzz answers
  readiness 503 before its listener closes. `GET /api/ready` is new, open
  like `/api/health` and saying as little: what `/api/health` says, with
  `"stopping": false`, and from the moment `stop()` begins, 503 with
  `{"ok":false,"stopping":true,"version":…}` without asking the database.
  From then every answer carries `Connection: close`, so a client holding a
  connection makes its next one elsewhere. If anything has asked
  `/api/ready` since the listener opened, the console goes on answering
  everything for five seconds (`drainMs`, never longer than the stop's
  grace) before the listener closes; with nothing asking there is no
  balancer to tell, and it does not wait, so a settings restart and a
  deployment nobody balances stop as quickly as before. The listener then
  takes no new connection, and an answer already being written is given the
  grace to finish rather than cut off, while the worker stops as before.
  `/api/health` keeps its meaning: whether the process works, which a
  stopping process still does, and which is what a supervisor that restarts
  it should ask; the image's own check stays on it. `operability.test.ts`
  starts a deployment, finds it ready, begins the stop, and is told 503
  with `stopping: true` and `Connection: close` at once, while `/api/health`
  still answers 200; the stop takes the 800 ms drain it was given, and the
  port then refuses. A deployment never asked stops in well under the
  twenty seconds of drain it was given. A console closed with a request in
  flight refuses a new connection and answers the one it had, with 200.
- **Every probe cost a query on the application's pool, and a database that
  hung held every probe.** `/api/health` is open to anyone and ran
  `SELECT 1` on the shared pool each time it was asked. A flood of probes --
  balancers, monitors, anyone -- took a pool slot each, and a database that
  did not answer held each probe and its slot until the checker gave up.
  Buzz samples its database every thirty seconds. `databaseSample`
  (`src/main.ts`) takes one sample for every health and readiness answer in
  a five-second window: callers who arrive while one is being taken wait for
  the same one, a sample that has not answered within two seconds is
  `"unreachable"` -- inside the five seconds the image's own check waits --
  with `did not answer within 2000 ms` in the log, and a probe past its
  deadline is not joined by a second. The query carries its own two-second
  timeout, so a connection whose database never answers is dropped by the
  pool rather than held. The test counts the probe's queries on the pool:
  forty health and readiness requests at once cost one, and twenty more in
  the window none; with a database that never answers, the page says 503
  and `unreachable` in about two seconds, and ten more asks cost no second
  query. A test with its own clock holds the window and the one probe at a
  time.
- **The search across companies read every row.** `searchEverywhere`
  (`src/owner/search.ts`) looks for a phrase anywhere in a task's goal and
  result, a decision's title, summary and note, and a fact:
  `ILIKE '%…%'`, which no btree serves, so each search read all three
  tables for every company. Migration 0098 makes a `pg_trgm` GIN index on
  exactly those six columns, spelled as the search spells them; the note is
  now searched as the column rather than `coalesce(owner_note, '')`, which
  matched nothing more and no index could serve. `pg_trgm` is installed
  with `pgcrypto` and `vector` by `provision-database.ts` and
  `setup-database.sh`; it is a trusted extension, so the migration installs
  it as the database's owner where a database was provisioned before, and
  stops with what to do where the server lacks it. The indexes are made
  with a plain `CREATE INDEX`: every migration runs in one transaction with
  its record, which `CONCURRENTLY` cannot, and the build holds writes to
  each table for the seconds one owner's rows take, once, in the upgrade's
  migrate step. The test records the three statements the search sends as
  it sends them, and explains each on the control plane with sequential and
  plain index scans priced out: each table is read by a bitmap heap scan,
  over every one of the six indexes, and no table is read row by row. With
  a handful of facts and no statistics the planner rightly prefers walking
  the partial index of live facts whole, so the test adds four hundred and
  counts them first, as autovacuum would in a deployment. The existing
  search tests pass unchanged.
- **Not done.** A proxy that routes by the container's state and asks
  nothing -- the Traefik in front of Coolify and Dokploy -- is not told by
  the drain, and, routing to the containers that are running, still sends
  requests to a stopping one until it has stopped (read in how its Docker
  provider works, not tried here); the listener closes before the worker's
  grace, so for a run that takes the whole grace, requests routed there in
  that time are refused. Keeping the listener open until the worker has
  stopped would close that window, and changes the order `stop()` keeps:
  the console before the worker. The drain's five seconds are not a setting an operator
  can change. The migration's refusal where the server lacks `pg_trgm` was
  read, not run: every server here has it.

## 2.59 A schedule's overlap policy and catch-up window (F9.1)

- **An occurrence fired beside a run that was still going.**
  `runDueSchedules` created an occurrence's task whether or not the task
  the previous occurrence made had ended, so an hourly job whose work took
  seventy minutes, or a daily one whose task waited two days for the
  owner's approval, got a second task beside the first: twice the spend,
  and two runs doing the same work. Migration 0099 gives every schedule an
  `overlap` policy, checked by the database: `skip`, the default for new
  schedules and for every existing one, lets the occurrence pass, moves the
  schedule to its next future occurrence and writes `schedule.skipped`
  once, naming the live task and its status; `queue` leaves the schedule
  where it is until that task ends, then fires once, the backlog behind it
  collapsing as any backlog does; `allow` is how every schedule behaved
  before. "Live" is any status not in `TERMINAL_STATUSES`, so a task
  waiting for approval, review or a window holds its schedule.
  `liveTaskOf` (`src/scheduler/scheduler.ts`) finds the task, from a
  partial index of live scheduled tasks (`tasks_schedule_live_idx`), whose
  predicate the statement spells so the planner uses it (checked with
  `EXPLAIN`). It leaves out the task the occurrence's own key names: a
  crash between creating an occurrence's task and advancing the schedule
  leaves that task live and the occurrence still due, and the next pass
  must finish firing it rather than skip it on its own account.
  Once is kept the way 0038 keeps it. A skip moves the schedule on under
  the guard a fire uses, so of two workers only one writes it, and the next
  pass finds nothing due. A hold does not move the schedule, so the row
  remembers the run it waits for (`held_by_task_id`) and `schedule.held` is
  written only when that changes; any advance clears it.
- **After downtime, one catch-up ran however late.** A 07:00 briefing came
  back at 19:00. `catch_up_minutes`, unset by default and so today's
  behaviour, is how late an occurrence may be and still run. Past it the
  occurrence and the backlog behind it are dropped, the schedule moves on,
  and `schedule.missed` is written once with `droppedOccurrences`. Late is
  measured from the most recent occurrence that has fallen due, not the
  oldest: an hourly job with a thirty-minute window, back from three hours
  down at ten past, runs the occurrence from ten minutes ago. The window
  is asked before the overlap, so a queued occurrence that has waited past
  it is dropped rather than run hours after it was meant for. The floor is
  fifteen minutes (`MIN_CATCH_UP_MINUTES`, whose comment gives the reason:
  a pass shares its tick with the rest of the housekeeping, a worker with
  one place runs up to eight tasks between two passes, and a restart adds
  its minute, so several minutes late is a working deployment and not
  downtime); a year is the ceiling. Both are CHECK constraints too.
- **What the owner sees, and where the settings travel.** The schedule
  remembers its last occurrence that did not run -- when, why (`overlap` or
  `late`), how many that pass dropped, the run it gave way to -- and keeps
  it after later runs, so a skipped night still says so the next day.
  `schedulesOf` returns `overlap`, `catchUpMinutes`, `waitingFor` and
  `lastSkipped`; the console's schedule form asks "If the last run is still
  going" and "If missed while PALUGADA was down" in plain choices, and its
  table shows the policy, the window, **Waiting**, and under **Next** which
  run was skipped or missed and why; the activity feed names the three new
  events. `POST /api/companies/:id/schedules` takes `overlap` and
  `catchUpMinutes` (`null` for always once) and refuses anything else by
  naming what it accepts; a bundle's cadence may carry both, checked at
  publish by the same `assertScheduleTiming` the route and `upsertSchedule`
  use. The export carries the two settings and the import restores them;
  the remembered skip and hold stay behind with their reasons, like
  `fire_failed_for`, and could not come across in any case, since the
  schedules are imported before the tasks they name. 0047's grants are per
  table, so the application role needed nothing new (checked).
  `schedule-overlap.test.ts`, on explicit clocks: skip creates no second
  task while the first waits for approval, writes one event over five
  passes naming it, and fires again once it has ended; queue holds through
  five passes with one event and fires once after, with the 09:00
  occurrence counted into it; allow runs two side by side; a half-fired
  occurrence is finished, not skipped for its own task; a briefing twelve
  hours late is dropped with one event over three passes, three days of
  them are counted as three, and one twenty minutes late runs; the window
  measured from the latest occurrence runs a short outage's catch-up; with
  no window one catch-up runs twelve hours late; a queued run past its
  window is dropped; bad values are refused by the code and by the
  database, and saving again without them restores the defaults; the API
  refuses and stores them and its list shows the missed occurrence and the
  run a held one waits for; a cadence brings them and a bad one is refused
  at publish; an archive round-trip keeps them. The weekly review's test in
  `bundles.test.ts` fired its schedule twice with the first review still
  pending; it is about what the second is handed, so it sets `allow` for
  that fire rather than the default being weakened.
- **Not done.** Existing schedules become `skip` when 0099 runs: a
  deployment that relied on overlapping runs must set `allow`. The console
  has no form to edit a schedule; changing either choice is saving it again
  under the same short name, which replaces every field, as it did before.
  A skip or a miss is in the activity feed and on the table, and nobody is
  told of one on a channel. A skipped occurrence is written once per
  occurrence, so a schedule every minute behind a run stuck for a day
  writes one a minute -- as many as its `schedule.fired` would have been,
  not one a pass. The built-in weekly review keeps the defaults. How late an
  occurrence is comes from `nextOccurrence`, so across a daylight-saving
  change it is exactly as right as that function is.

## 2.60 Schedules and work windows on the nights the clock changes (F9.1, F9.2)

Found by running cron-parser 4.9 across the 2026 changes, on 2026-09-30.
Nothing tested a schedule or a window at a daylight saving change.

- **A daily job in the hour the clock repeats ran twice.**
  `runDueSchedules` works out the next run from the time of the pass, not
  from the run that fired, and cron-parser, asked from inside a repeated
  hour, answers with a time it has already given. A `30 1 * * *` schedule in
  America/New_York whose 01:30 EDT (05:30Z on 2026-11-01) was fired by a
  pass at 01:05 EST (06:05Z) -- a worker that had been down, a busy queue --
  was given 01:30 EST (06:30Z) as its next run and made a second task that
  night, and one saved during that hour was given the same double. London,
  Sydney and Santiago did the same on their nights back; at Lord Howe, which
  goes back half an hour, cron-parser gave both 01:45s even to a pass on
  time.
- **A job in the hour the clock skips could be lost.** Asked from just after
  New York's jump (03:00 to 03:29 EDT on 2026-03-08), cron-parser gave the
  next day for a `30 2` schedule, so a pass that fired the previous day's
  run late there dropped that day's run, neither run nor counted. At
  Santiago, whose clock skips from midnight to 01:00, and at Lord Howe's
  half-hour jump, it dropped the day's run even when asked days ahead.
- **What changed.** One rule, Vixie cron's, written above `nextOccurrence`
  (`src/scheduler/scheduler.ts`). A schedule with fixed hours runs once for
  each time the clock shows it: at the first pass of a repeated time, and at
  the instant of the jump for a skipped one -- 02:30 in New York runs at
  03:00 EDT, every time inside the jump is that one run, and a day's runs
  keep their order. A schedule whose hour field is every hour runs by real
  time: at both 01:00s, with nothing owed for an hour that did not pass.
  cron-parser is now asked only in UTC, where it lists wall-clock readings
  with no change to get wrong, and `instantsShowing`
  (`src/scheduler/windows.ts`) places each reading in the zone: the one or
  two instants that show it, or the instant the clock jumped over it. The
  rule names a fixed set of instants, so the next run no longer depends on
  where the search starts, and `runDueSchedules` and `upsertSchedule` go on
  asking from `now`. `countOccurrences`, the `skippedOccurrences` of
  `schedule.fired`, walks the same runs, so a run a late pass folded in is
  counted once, not twice or not at all. Checked outside the suite against a
  minute-by-minute walk of real time around each of the 260 changes in the
  130 zones that change in 2026, for twelve schedules each: no difference.
  A daily schedule's next run now takes about 0.4 ms here, where cron-parser
  asked in the zone took 1.4 ms.
- **A work window opened late wherever its hour is not an hour of UTC.**
  `nextOpening` looked for the opening on the hours of UTC, so in a zone
  half an hour or three quarters off UTC -- Kolkata, Kathmandu, Adelaide,
  Newfoundland, Lord Howe in winter -- every window opened thirty or
  forty-five minutes late, and a window from 02:00 at Lord Howe opened at
  03:00 on the night its clock jumps from 02:00 to 02:30. It now steps by
  quarter hours: every offset is a whole number of them, and every change
  from 2026 to 2040, in every zone, falls on one. Windows on the nights the
  clock changes were otherwise right, and are now pinned: open while the
  clock shows their hours (three real hours for 01:00-03:00 on the night
  back), opening at the jump when their start is skipped, and, wrapping
  midnight, belonging to the day that opened them through either change.
  Reading the clock reuses one formatter per zone instead of building one
  each time.
- **Tests.** In `test/acceptance/scheduling-windows.test.ts`, with fixed
  instants: `a daily time in the hour the clock repeats runs once, on its
  first pass (F9.1)` and `a daily time in the hour the clock skips runs
  once, when the clock jumps (F9.1)`, each in New York, London, Sydney,
  Santiago and Lord Howe; `a schedule that runs every hour keeps to real
  time through both changes (F9.1)`; `a zone without daylight saving is
  unaffected (F9.1)` (Jakarta); `where the search starts never changes the
  next run (F9.1)`, from every twenty minutes around each change and a
  second either side of every run. Through `runDueSchedules` and the
  database: `a daily run in the hour the clock repeats fires once, even from
  a pass that runs late (F9.1)` -- passes at 06:05Z, 06:30Z and 06:31Z make
  one task, the next run is 2026-11-02T06:30Z, and a save at 06:10Z says the
  same -- `a daily run in the hour the clock skips fires once, when the clock
  jumps (F9.1)`, and `a pass that runs late across a change counts the run
  it folded in (F9.1)`. For windows: `a window opens on its own zone's hour
  where that is not an hour of UTC (F9.2)`, `a window on the night the clock
  goes back is open while the clock shows its hours (F9.2)`, `a window whose
  start the clock skips opens when the clock jumps (F9.2)` and `a window
  that wraps midnight holds across a change (F9.2)`.
- **Not done.** A job at a skipped time now runs at the jump, 03:00, where
  cron-parser asked ahead of time put it as long after the jump as it was
  after the skipped hour began, 03:30; such a run comes earlier, by less than
  the length of the jump, once a year. `instantsShowing` assumes a zone changes its offset at
  most once in two days (the closest two changes from 2026 to 2040 are
  Casablanca's, 35 days apart), and `nextOpening` that changes fall on a
  quarter hour of UTC; a zone that broke either would be wrong near that
  change, not everywhere. A window made only of hours the clock skips does
  not open that night -- 02:00-03:00 in New York on 2026-03-08 -- which is
  what its hours say, and may not be what an owner who put cheap hours there
  expects. cron-parser stays at 4.9: it is asked nothing it gets wrong.

## 2.61 Run a schedule now (F9.1)

Asked for on 2026-09-30: a schedule could be created, changed, and turned on
or off, and an owner who wanted to see what one does waited for its next
occurrence -- for the weekly business review, a week.

- **A schedule could only be waited for.**
  `POST /api/companies/:companyId/schedules/:scheduleId/run`
  (`runScheduleNow`, `src/scheduler/scheduler.ts`) makes the task an
  occurrence would make, by the same function: `createScheduledTask` was
  taken out of `runDueSchedules`, which calls it for every occurrence, so the
  two cannot drift apart. The same division, role, project, budget account,
  input -- with the week read from the company's records for a schedule
  whose input asks for it, and the outside-content carry that comes with it
  (F8.9) -- priority, batching and goal, and `schedule_id`, which puts the
  run in the schedule's history. The task is created by `owner`, and
  `next_run_at` and `last_run_at` are not touched: an extra run is not an
  occurrence, and an owner who tries the weekly review on a Thursday still
  gets Monday's. A `schedule.run_by_owner` event names the task, and the
  answer is the task, which the console links to. A schedule that is off may
  be run -- trying one before turning it on is most of what this is for, and
  a bundle installs its schedules off -- and stays off.
- **Twice is refused, and so is at once.** While a task the schedule made has
  not ended (any status outside `TERMINAL_STATUSES`), whether the clock or an
  earlier press made it, the route answers 409 with a new code,
  `schedule.still_running`, naming the task and its status in the message and
  the task in `details.taskId`; the console explains it and links to that
  task. Two presses at once are serialized on the schedule by a
  transaction-level advisory lock taken on the control plane and held from
  the check until the new task has committed, so the second waits and then
  finds the first one's task live. Why a lock rather than `FOR UPDATE` on the
  schedule row or a key that hands the second press the first one's task is
  written at the function. Every press gives its task a key of its own:
  left to derive one, the engine keys a task by its role and input, which two
  runs of a schedule not handed the week share, so the second run after the
  first had ended would have been refused as a duplicate of it.
- **Refused where new work is refused.** A frozen company answers
  `company.frozen`, the code the engine and the hooks give a freeze; a
  schedule whose goal is closed, or under a closed one, answers `goal.closed`
  from `createRootTask`, as the clock's own firing meets it; a paused spend,
  a frozen role and an account that cannot cover the reservation are refused
  by the checks an occurrence meets. A schedule of another company is not
  found.
- **The console and the assistant.** On **Team**, **Schedules**, every row
  has **Run now**. Every run reserves (`reserve_tokens` is at least one), so
  the press asks first and says how many tokens the run reserves from the
  schedule's budget account -- the schedules list now carries
  `reserveTokens` -- and whether an off schedule stays off; the notification
  links to the new task. The owner's assistant may propose it, and its card
  may be applied from a chat, as giving work may: it takes no device, and it
  spends from the schedule's own account under grants its role already has.
- **Tested.** `schedule-run-now.test.ts`, against the database: the task
  carries the schedule's settings and is the owner's, `next_run_at` is
  unchanged to the millisecond and `last_run_at` stays empty, the event is
  written, an occurrence that falls due while the owner's run is live gives
  way to it under the default overlap policy (2.59) and names it, and once it
  has ended the next occurrence fires; an off schedule
  runs and stays off; a second press is answered 409 naming the task while it
  is pending and while it is running, a press after it failed works, and a
  live task the clock made refuses a press the same way; six presses at once
  make one task and five refusals that name it, with only its reservation
  held (with the lock taken out, the same test made six tasks, every time it
  was run); a frozen company and a closed goal are refused and reserve
  nothing; another company's schedule and one that does not exist are not
  found, and a press without a session is 401; a schedule that asks for the
  week is handed it, with the outside-content carry.
- **The clock and the owner.** The clock's own firing takes no lock, but it
  looks for a live task of the schedule before an occurrence fires (2.59),
  and the owner's run is one: under the default `skip` an occurrence gives
  way to it, under `queue` waits for it, and only under `allow` runs beside
  it, as the owner chose.
- **Not done.** The console learns that a run is live only by pressing: the
  schedules list does not say so, and the button is not greyed out while one
  is.

## 2.62 Seven languages, each held whole

The console and everything PALUGADA says to the owner outside it were in
English and Indonesian. They are now also in Malay (Malaysia), Simplified
Chinese, Hindi, Brazilian Portuguese and Russian. What two languages never
showed, seven did:

- **Plural forms.** `tp` knew "one" and "other"; Russian has one, few and
  many ("1 задача, 2 задачи, 5 задач"), and a language's "one" is not the
  number 1 -- Russian says it for 21, Hindi and Portuguese for 0. A
  translation of a plural sentence can now name each CLDR form, `tp` picks
  the form `Intl.PluralRules` answers for the locale, and a test requires
  every form a language's whole counts fall in and a `{count}` in every
  "one" sentence (the skipped-run sentence said "the run" for 21 runs, and
  now says one run apart through `t`).
- **Completeness in every language.** The test that held the Indonesian
  dictionary complete now holds every dictionary in `console/src/locales/`
  to every sentence and the same placeholders; for Chinese, Hindi and
  Russian every translation must be in its own script; and a translation
  equal to its English must be a name listed in the dictionary's `KEPT`, at
  most 3% of it. The server's sentences moved to one file per language in
  `src/owner/sentences/`, held to the same placeholders and scripts, and a
  language the console offers without them fails.
- **Codes inside sentences.** "Recorded: {decision}." and "the task it was
  asking about is {state}" were filled with `deny` and `cancelled`, English
  inside every translation. Each decision and each way a task ends is its own
  sentence now (`recordedText`, `closureText`).
- **One English word, two meanings.** Translators found labels that one
  language cannot translate once for all their uses: "To" for an email's
  recipient and an hours window's end, "Open" for a status and a button,
  "Now" for a memory's current text and un-snoozing an item, "Next" and
  "Done" for the tour and a column or status. Each use has its own sentence.
- **Around the words.** The browser's `pt-PT` or `zh-TW` now finds a
  language by its first part; the sign-in page lists languages by name
  rather than seven codes that did not fit a phone; the page's `lang` is the
  locale (`zh-CN`), and the console names Han and Devanagari fonts after
  Inter, so Chinese is not drawn with Japanese glyphs; the OAuth result page
  is said through `say`; speech providers are sent `pt`, not `pt-BR`, which
  Whisper refuses; agents are told "Simplified Chinese" rather than
  "Chinese", and Brazilian Portuguese is a language a company can write in.
- **Seen, at a phone's width.** Home, the deployment, and a company's
  overview, team, languages, work and money, in each language at 390 pixels,
  with no page wider than the screen. Looking found what no test had: the
  date was capitalised word by word ("Quarta-Feira, 30 De Setembro",
  "Среда, 30 Сентября"), now only its first letter; the setup banner's button
  lost its label to a long sentence, and now wraps below it; the
  second-factor dialog opened beneath the dialog that asked for it, so
  starting a company from the console did nothing the owner could see, and
  it now stacks above every dialog; and a short name another company had
  came back as the database's "duplicate key value violates unique
  constraint", in English, where it is now refused as
  `company.slug_taken` (409) and explained in the owner's language, whether
  the company is started or restored from an export.
- **Tested.** `console-i18n.test.ts` (every dictionary, script, KEPT, plural
  forms, a `{count}` in every "one"); the owner-sentences test in
  `owner-channels.test.ts` (every language the console offers, placeholders,
  scripts) and one for decisions and task ends said as sentences;
  `languages.test.ts` (the languages agents are told, precisely named, and
  Brazilian Portuguese not drift from Portuguese); `listen.test.ts` (every
  speech provider sent the language without its region); `owner-api.test.ts`
  and `audit-export.test.ts` (a taken short name refused by name, starting
  and restoring).
- **Not verified.** Each translation was written and read through by one
  translator per language against the English with a glossary kept in its
  file's header, and spot-checked; none has been read by a native-speaking
  owner using the product. Chinese is simplified only; a reader of
  traditional Chinese gets simplified. The documentation is in English.

## 2.63 A project's own work language

Asked for on 2026-10-01: a company had two languages, work and talk (0052),
and one company often sells in more than one market. A project for Malaysia
has to write its customers' copy in Malay and a project for Brazil in
Brazilian Portuguese, while the company's agents still talk to its one owner
in one language.

- **One work language for every market.** Migration 0100 adds
  `projects.work_language`, nullable, with the check `companies` has on the
  shape of a language tag (`projects_work_language_tag`). NULL, the case for
  every existing project, means the company's work language. Talk has no
  per-project setting: there is one owner to talk to. No grant was needed:
  the application role writes `projects` with the table's own SELECT, INSERT
  and UPDATE (`enable_tenant_rls`), which 0047 left alone and which cover a
  new column.
- **Which language a run works in.** `languagesForTask`
  (`src/domain/language.ts`) reads the task's project with its company:
  work is the project's, else the company's, else the deployment's default,
  and `workFrom` says which (`project`, `company` or `deployment`;
  `workIsDefault` keeps its meaning, the last alone). Talk is the company's,
  else the deployment's. `languagesFor` reads the same statement without a
  task and keeps its shape, so the company's languages route answers as
  before. The two places that decide a run's work language use it: the
  language rule every run is told (`src/context/builder.ts`), which also
  says when the language is the project's own, because the company's
  memories, skills and earlier work are shared across its projects and may
  be in another; and `doc.draft` and `email.draft`
  (`src/capabilities/draft.ts`), which tell the drafting model the
  project's language, ask again once when the draft comes back in another,
  and record drift against it -- so in the Brazil project a draft in the
  company's own Indonesian is a slip like any other. A plan is talk, and is
  still held to the company's talk language (`src/engine/plan.ts`
  unchanged).
- **The owner sets it.** `POST /api/companies/:companyId/projects` and
  `POST /api/companies/:companyId/projects/:projectId` take `workLanguage`:
  a code from `LANGUAGES`, refused otherwise by `languageCode` with every
  accepted code named, or null for the company's; left out on an edit, it
  is left as it was. The project's `project.created` and `project.changed`
  events carry it, and the structure read model lists it for every project.
  On **Team**, both **New project** forms and **Edit** on **Projects** have
  a **Work language** select of the languages agents can be told, first
  among them "The company's (…)" with the language that is, and a project
  with its own shows it on its card. The owner's assistant may propose it
  on either route; its description of the company's languages route, which
  called talk "a list of language codes it talks to customers in", now says
  what the route takes: a code or null for each.
- **Export and import** carry `projects.work_language`; the generic
  importer restores it, and an archive from before 0100 restores its
  projects without one.
- **Tested.** `languages.test.ts`, against the database: a run in a project
  with its own work language is told it for work, the company's for talk,
  and that it is the project's own; a project without one falls back to
  the company's and then the deployment's, and a project's own outlasts a
  change to the company's; a plan in that project is still held to the
  company's talk language; a draft there is asked for in Brazilian
  Portuguese, asked again when it comes back in Indonesian, and recorded as
  drift from Brazilian Portuguese when it stays there, while the company's
  other project drafts in Indonesian; the API starts a project with one,
  refuses an unknown code by name on starting and on an edit, changes
  nothing on a refusal, leaves it alone on a rename, takes null, and
  records each change; export and import round-trip it; the database
  refuses what is not a tag. `audit-export.test.ts` failed on the new
  column until the export carried it.
- **Not done.** A schedule, trigger or ticket has no language of its own:
  its work is in its project's. The console's three new sentences are in
  every dictionary the console has.

## 2.64 Everything an agent writes to the owner, checked for its language

A company talks in one language and works in another (`src/domain/language.ts`),
and what its agents write was checked in two places: the plan, against the
talk language, and a draft, against the work language. Everything else went
unchecked, so an agent that read an English web page and then asked the
owner a question in English was never noticed. And two of the languages a
company can choose, Javanese and Sundanese, could not be checked at all.

- **Every text, once, where it is first kept.** `noteTalkDrift` checks a text
  against the talk language and records a slip as `language.drifted` with
  its `where`; it is recorded and never refused, as the plan's always was.
  Each caller checks where the text is first kept, so a run that resumes and
  makes the same call again is not a second slip:
  - `question`: what `owner.ask` puts on the owner's card -- the question,
    what depends on it, the answers it offers -- when the item opens
    (`askOwner`), and not when the resumed run asks it again to read the
    answer.
  - `summary`: the summary of finished work, which the done notice and the
    Work page show the owner, when the task completes (`transitionWithin`).
    Only a model's: a handler the deployment registered writes its author's
    words and has no next run to remind, so the engine says which wrote it
    (`writtenByModel`), as it already did for done criteria.
  - `handoff`: the brief `task.delegate` hands another role, when the child
    is new; a delegation replayed returns its child and is not checked again.
    Its context is not checked: it is where material goes -- the customer's
    email, the page that was read -- and material is in whatever language it
    came.
  - `ticket`: the title and body of a ticket a run files, when it is new; the
    same title still open is the ticket already there, with its own words.
  - `goal_proposal` and `stage_proposal`: the new words and the reason of
    `goal.propose`, the evidence and the why of `stage.propose`, when the
    item opens. A second proposal while one waits opens nothing, and is not
    checked. Neither item is tied to the proposing task, but the slip is, so
    the proposing role is the one reminded.
  - `review`: a reviewer's reasons, which the proposing role reads and, on a
    stage proposal's card, the owner; on the review's own task, so it is the
    reviewer's role that is reminded.

  Drafts stay held to the work language, and their slips stay the drafting
  model's rather than the role's. What the agent quotes -- code, links,
  anything in quotation marks or after `>` -- is still left out of every
  check (`ownWords`).
- **Escalations and incidents.** An agent raises an escalation only through
  `owner.ask`, `goal.propose` and `stage.propose`, all checked. Every other
  escalation and every incident is a sentence of the platform's (a halted
  task, a write that did not read back, a schedule that repeats itself),
  not an agent's. The account a division's role adds to an escalation it was
  handed is that role's summary, checked when its task completed.
- **Javanese and Sundanese.** Both now have words the detector counts,
  chosen as the others were: frequent function words, rare in the other
  languages. Each has an everyday and a polite register (ngoko and krama;
  loma and lemes), and the polite ones borrowed from each other, so the lists
  leave out every word two of Javanese, Sundanese and Indonesian share --
  kedah, sareng, nanging, kanggo, manawi, sanes, teras, upami, kudu, wae,
  kabeh, and yen, which is Sundanese's "that" written without its accent --
  and words Indonesian uses for something else: aku, banget, teh (tea),
  saking. Malay stays Indonesian's family. Text is composed (NFC) before its
  words are read, so an é written as two code points is still found. Every
  language a company can choose can now be checked; the detector still
  answers "not sure" rather than guess, for short text and for a mixture.
- **The reminder says where.** The next run of a role that slipped was told
  "this role wrote once in English where the rule above asked for another",
  and left to guess which of the many things it writes to look at. It is now
  told what in, too: "... asked for another: in a plan and in a question to
  the owner." (`slipReminder`, read by the context builder).
- **The console.** `language.drifted` is drawn as "Wrote in the wrong
  language" without its `where`, so no new sentence was needed.
- **Tested.** `languages.test.ts`: realistic sentences in Javanese (ngoko and
  krama), Sundanese (loma and lemes), Indonesian and Malay each read as their
  own language, a company that talks in any of them held to it, Indonesian
  that writes "teh", "ETA" or a Javanese town never taken for either, and
  short text and three mixtures (Javanese and Indonesian, Sundanese and
  Indonesian, Javanese and Sundanese) "not sure" for every expected
  language; for the question, the summary (a model's, and a handler's that
  is not checked), the brief, the ticket, both proposals and a reviewer's
  reasons, English for a company that talks in Indonesian is one slip naming
  where, the same call again is still one, and Indonesian is none; the
  reviewer's slip is on the reviewer's task; and the reminder after a plan
  and a question names both.
- **Not checked, on purpose.** A run's narration (`run_notes`): it is many
  short lines, and checking each would fill the activity with one run's
  thinking aloud. The guardian's one-sentence reason: it is a platform
  model's, not a role's, and there is no role to remind. The owner's
  conversation with the CEO on the console and in chat: it answers in the
  console's language, which is the owner's own setting, and is not a role's
  run. An output that reports in a field other than `summary` (`answer`,
  `result`) is not checked: `summary` is what every template asks for and
  what the done notice reads. The sentence `metric.record` keeps beside a
  number says where it came from, mostly the source's own name, and is too
  short to judge; the lessons a run leaves (`learned`) are memory, read by
  later runs as material rather than said to anybody.
- **Not verified.** The word lists were chosen from the languages' grammar
  and tried on the sentences in the test and a few dozen more, not on a
  corpus, and no native speaker of Javanese or Sundanese has read them.
  Javanese and Sundanese written in a dialect (Surabaya's, Banyumas'), or
  mixed with Indonesian as chats are, will mostly read as "not sure", which
  records nothing -- the bias the detector is meant to have.

## 2.65 Twenty-one languages, and no code inside any of them

Asked for on 2026-10-01: a company could tell its agents to write in 22
languages, and the console was drawn in seven. It is now drawn in every one
of them but European Portuguese, which reads the Brazilian: Javanese,
Sundanese, Filipino, Vietnamese, Thai, Japanese, Korean, Arabic, Spanish,
French, German, Dutch, Italian and Turkish join English, Indonesian, Malay,
Simplified Chinese, Hindi, Brazilian Portuguese and Russian. What PALUGADA
sends the owner's phone -- Telegram, WhatsApp, email, push -- is in each of
them too.

- **Translated whole, in one voice per language.** Seven translators, two
  languages each, wrote every sentence the console draws (1,899) and every
  sentence the platform sends (89), each with a glossary in its file's
  header and a register chosen once: Javanese krama and Sundanese lemes;
  Spanish "usted", French "vous", German "Sie", Turkish "siz"; Dutch,
  Italian, Filipino, Vietnamese and Thai the friendly form; Korean 해요체
  without 당신; Japanese です・ます; Arabic gender-neutral, never an
  imperative to the owner. The sentences that landed while they worked --
  a project's own work language (2.63) and the closed-item sentences below
  -- were written by the same translator in the same terms.
- **Plural forms as each language has them.** Arabic has six (zero, one,
  two, few, many, other) and every count sentence names all of them;
  Japanese, Korean, Thai, Vietnamese, Javanese and Sundanese have only
  "other", so a sentence shown for one item is worded to read right for one;
  French counts 0 as "one", Filipino 1, 2, 3, 5 and more. The test that held
  seven languages to their forms holds twenty-one.
- **Right to left.** Arabic sets the page's `dir`, and the console's own
  styles and spacing use logical sides, so the layout mirrors and not only
  the text (prepared in the commit before the translations).
- **No status code inside a sentence.** A translator found the owner's
  phone told "Withdrawn (stage_changed)." and, for a button pressed after
  its item closed, "Already closed: it was already decided (deny)." -- the
  English text of the refusal -- in every language; the History page showed
  "withdrawn · task cancelled", and a task's trace a step's raw state. Every
  reason an item is withdrawn for is now a sentence of its own on the phone
  and in the console (`closureText`, `notOpenText`), a press that finds its
  item closed is told the sentence the retracted message shows, from the
  refusal's details rather than its message, and a reason nothing writes yet
  is said without its code. The owner's first authenticator was enrolled as
  "owner (claimed in the console)" and shown under Owner in every language;
  the console now names it in the owner's.
- **Seen, at a phone's width.** Home, the deployment, and a company's
  overview, team, languages, work and money in every new language at 390
  pixels, Arabic right to left. Two places widened the page in Javanese and
  are fixed: a figure that is a word ("Dipunparengaken", allowed) drawn at a
  number's size, and the chip on the owner's line to the CEO, which had no
  limit on its width.
- **Tested.** `console-i18n.test.ts` (twenty dictionaries, each script,
  KEPT, every plural form); the owner-sentences test in
  `owner-channels.test.ts` (twenty languages); a test that every withdrawal
  reason, an unknown one, and a press on a closed or missing item are said
  without a code; `owner-claim.test.ts` (the authenticator named as the
  console asks); `languages.test.ts` now reads the languages the console
  offers from its dictionaries rather than a list that had fallen behind.
- **Not verified.** Each language was written and read through by one
  translator against the English and spot-checked against forty random
  entries; none has been read by a native speaker using the product.
  Javanese and Sundanese have few software conventions to follow, and some
  terms were coined ("pangolah" for runtime). Labels such as "Model" or
  "Status" that a language writes as English does are listed in that
  dictionary's `KEPT`, under its 3% cap. The documentation is in English.

## 2.66 A role that hands work on is told which roles there are (F6.4)

Found on a live run on 2026-10-02 (the gap analysis of 3 October, N1). The
owner asked the CEO of a standard company for a seven-day Instagram plan. The
coordinator's charter says "decide which role's job it is, hand it over with
task.delegate", and no run was ever told which roles the company has. It
guessed nineteen names -- "marketing", "cmo", "barista" -- each refused as
"no role X in this company", created four sub-tasks asking whether a role
existed, and spent 96% of its division's tokens before anything was handed
to the marketer.

- **The roles, in every run of a role that can hand work on.** A role whose
  tools include `task.delegate` gets a section, "The roles you can hand work
  to" (`teamSections`, `src/context/builder.ts`). It lists every other role
  of the company by slug, then its name, title and division, then the first
  sentence of its charter, which in every template says what the role does.
  A frozen role is marked as frozen and taking no work, which is what
  delegating to it meets: `createSubTask` refuses it. The list
  stops at sixty roles and says how many more there are. It follows the
  role's contract and is never dropped to fit: without it the role cannot do
  the one thing it is for. A runtime is handed it among its notes
  (`NOTE_KINDS`, `src/engine/engine.ts`). A run is given sections by kind, so
  a kind missing from that set would have been built and never reached the
  model.
- **A role named the way people name it.** `task.delegate` takes a slug, and
  now also a title or a name that is one role's alone, in any case: "cmo"
  and "Laras" both reach the marketer, and the answer says which slug that
  was (`resolveRole`, `src/broker/platform-capabilities.ts`). A title or name
  that two roles share is refused, with both slugs, rather than guessed
  between. Any other name is refused with the list of the company's roles,
  leaving out the asking one, and with the nearest one when it is within a
  few edits or shares its first five letters: "no role "marketing" in this
  company; did you mean marketer (Laras, CMO)?". The old answer said only
  what was wrong, never what would be accepted.
- **Tested.** `org-automation.test.ts`:
  - The coordinator's pack lists every other role and not itself.
  - The marketer, which cannot hand work on, gets no list.
  - A frozen role is marked, and delegating to it is refused, as the mark
    says.
  - A runtime running the coordinator is handed the list among its notes.
    This assertion failed until `team` was added to `NOTE_KINDS`.
  - A delegation by title and by name reaches the marketer.
  - "marketing" is answered with the suggestion and the roles.
  - "barista" gets the roles and no guess.
  - A shared title is refused with both slugs.
- **Not done.** The owner's assistant, which proposes work by role from its
  own reading of the company, is unchanged.

## 2.67 A finished deliverable is handed back, cut short where it is long (F6.7)

Found on the same live run (N2). The marketer finished the seven-day plan the
owner had asked the CEO for. `task.await` refused it: "child marketer
returned about 2597 tokens, over the 2000 a sub-agent may hand back (F6.7)".
The CEO could not report it, the rerun the CEO proposed could not read it
("not one this task delegated"), and the owner never received the work.

- **Cut short, never refused.** `containChildResult`
  (`src/engine/containment.ts`) still holds what enters the parent's context
  to `CHILD_OUTPUT_TOKEN_LIMIT`. It now meets the limit by cutting instead of
  refusing:
  - It halves, pass by pass, how long a string and how many items a list may
    keep. Short fields such as a verdict, a status or a summary line come
    through whole; only the long ones are cut.
  - Every cut says so where it was made: "… [cut here: 2000 of 12250
    characters. The whole is kept on task X, where the owner reads it.]". A
    list ends with the same note, counted in items.
  - The result carries `abbreviated` with the task that keeps the whole and
    how long it was. The summary says the same, and tells the parent to point
    to it rather than retype it.
  - What nothing makes fit is replaced by its keys and where the whole is.
- **Why the decision changed.** Refusing rested on the view that half a JSON
  document that still parses looks like an answer and is not one. On a live
  run the refusal lost the work outright. A finished deliverable is the work,
  not a transcript, and a cut that names itself cannot be taken for the
  whole. The child's own record keeps its output whole, as before.
- **Both paths.** `task.await` (`src/broker/platform-capabilities.ts`), for
  runtimes in another process, returns `abbreviated` beside the output. The
  in-process `awaitChild` (`src/engine/engine.ts`) uses the same function.
- **Tested.**
  - `control-plane.test.ts`: an output over the limit fits under it; its short
    field is whole; the long one carries the note; `abbreviated` is set and
    the summary says so; a list of 3,000 short items is cut by items; an
    output under the limit is not marked.
  - `out-of-process-runtimes.test.ts`: a child finishing a 12,000-character
    plan is read by its parent through `task.await` as `completed`, under the
    limit, with the note naming the child. The child still holds the whole
    plan.
- **The owner reaches it from the task they asked for.** The CEO's task was
  the one the owner opened, and it said "nothing yet" while the plan sat on a
  sub-task found only by scrolling the work list. The task detail
  (`taskDetailOf`, `src/owner/views.ts`) now carries:
  - `handedOn`: the work the task handed to other roles, oldest first, up to
    fifty, each with its role, the role's name, its status and what it came
    to in a line, redacted;
  - `handedBy`: the task that handed this one on.
  The console's task drawer shows them as "Work it handed on", each with an
  "Open the task" button, and "Handed on by …" with the same button. Tested
  in `deliverables.test.ts`: a parent lists a finished piece with its result
  and an unfinished one without; the piece names its parent; a task the
  owner gave names none.

## 2.68 Only a plain question about wiring a tool in is answered for the owner (F10.3)

Found on the same live run (N3, and B2 of the recheck of 30 September).
`owner.ask` answers some questions itself (L7, 2.26): one about setting up a
tool nothing is bound to, which the owner cannot answer from the inbox. The
test for "about setting it up" was a list of words, and it caught two
questions only the owner could answer:

- "Siapa pelanggan yang harus saya hubungi lewat email?", whom to contact,
  matched "hubung…" and "email". The customer was never written to.
- A responder's "Should I delete cust-042's record now?", offered with four
  answers, matched because it said three other tools "are not connected".
  The record the owner had asked to be deleted was not, and the task showed
  as done.

What changed (`setupAsked`, `src/broker/platform-capabilities.ts`):

- **Only words that mean wiring a service in.** Kept: bind, configure,
  integrate, install, API key, credential, and in Indonesian hubungkan,
  sambungkan, konfigurasi, integrasi, kredensial, kunci API.
  - Dropped: states ("connected", "bound"), which a question about something
    else mentions in passing.
  - Also dropped: everyday words, because each has a work meaning. "hubungi"
    is to contact, "pasang" to put a price on a post, "set up" a call, and a
    "vendor" sells coffee beans. "provider" and "connect" went with them.
- **Never a question with answers to choose from.** Offering choices is
  asking the owner to decide, whatever else the question mentions.
- **Why the balance moved.** A setup question that reaches the owner costs
  them a card they cannot answer from the inbox. A decision answered for
  them costs the work, and on a live run it cost a deletion the owner asked
  for. So anything short of a plain question about wiring a tool in is now
  put to the owner.
- **Tested.** `control-plane.test.ts`:
  - L7's own question is still answered. So are an Indonesian setup question
    and one naming the tool by its full name.
  - Five questions reach the owner, none recorded as answered by the
    platform: the two from the live run, word for word; a price to put on a
    post; a call to set up; and a setup question offered with answers to
    choose from.
  - The new test failed against the old list.

## 2.69 Work its budget stopped reaches the owner, and goes on where it stopped (section 6.3, F5.4)

Found on the same live run (B1 of the recheck of 30 September, still open).
Two of the CEO's tasks halted `budget_exhausted` ("shared budget
exhausted"). Section 6.3 sends such a task to the inbox, and nothing did: no
item, no incident, no message, only a red bar on Money. The owner raised the
ceiling, with their factor, and still could not go on. The only way on was
**Do it again**, a new task from nothing, which would have thrown away the
CEO's 292,000 tokens of work for want of a few thousand more. The code's own
comment said a halted task "becomes an owner inbox item instead".

- **An item, in the owner's language.** When the engine halts a task because
  an account cannot pay (`budget.exceeded`, `budget.reservation_refused`),
  `raiseBudgetHalt` (`src/inbox/inbox.ts`) puts a `budget_alert` in the inbox,
  tied to the task.
  - It names the work and the account with no room left: the one in the
    task's chain nearest its ceiling, which is not always the task's own.
  - It says how many tokens that account used of how many, and what to do:
    raise its ceiling on Money, then open the task and press Continue.
  - It is written in the panel's language (`budgetHaltWords`,
    `src/owner/budget-halt.ts`, in all twenty dictionaries), because the
    platform is speaking. An agent's words stay in the company's language.
  - It is raised once per task.
  - A month's money running out (`spend.paused`) halts the same way and
    already has the spend guard's own item, so it is not raised twice.
- **Carried to the chat as news.** `channelDelivery` answered `none` for every
  `budget_alert`, so neither this item nor the month's 80% and 100% items
  reached an owner who was not looking at the app.
  - A budget alert is now `link_only`, within the owner's window: Telegram
    and WhatsApp carry it with a link and nothing to press. Raising a ceiling
    loosens a control and takes the owner's device.
  - The chat shows the item's rationale under its title (`CHANNEL_SUMMARY`,
    `src/owner/notify.ts`), since its summary only repeats the title.
  - Push is unchanged. F10.5 keeps push for incidents and tier 3 approvals.
  - This reverses a decision that kept every kind F10.9 does not name off the
    chat. A budget alert is read the way an incident already was: news, not
    something to act on from the chat.
- **Continue, from where it stopped.** `continueHalted`
  (`src/engine/owner-control.ts`), at
  `POST /api/companies/:companyId/tasks/:taskId/continue` and as **Continue**
  on the task, takes a task its budget stopped back to `pending`:
  - It is the same task with the same journal, so committed steps are
    answered from the record and nothing that happened happens again (F5.1),
    as after a crash.
  - It reserves the default allowance again. It is refused, saying what to
    do, while the account still cannot fund that, while the month is paused,
    or while the role is frozen.
  - It closes the item as `task_continued`, with a sentence for chats in
    every language.
  - A ticket the halt put back on the board, if nobody took it since, is the
    task's again.
  - A second press, a live task, and any other halt reason are refused with
    `task.not_continuable` (409). A hop limit, a deadline or a failed
    read-back are answers about the work, not about money, and going on would
    meet them again.
  - `halted` still has no way out through `transition`. This is the one door,
    opened by the owner.
- **How this reads section 6.3.** "Tidak pernah dilanjutkan otomatis": never
  resumed *automatically*. The platform still never does; the owner may. The
  history stays true, with `task.halted` then `task.continued` on the task.
- **The console.** The task drawer of a budget halt says what to do and
  offers **Continue**. Two refusals are explained as sentences:
  `budget.reservation_refused`, which other routes also answer, and
  `task.not_continuable`.
- **Tested.**
  - `budget-halt.test.ts`:
    - A run whose model call the account cannot pay halts and raises one
      item, in Indonesian, naming the work and the account, and no second
      one on a second look. Without the engine change there was none.
    - A paused month raises nothing beside its own item.
    - Continuing is refused while the account is spent, and the card stays.
      Once raised, the task is pending with a reservation and its card is
      withdrawn as `task_continued`. It then completes without repeating its
      journalled draft, and its events read halted, continued, completed.
      A second press is refused.
    - A deadline halt and a live task are refused.
  - `owner-channels.test.ts`: a budget alert is queued for the chat,
    `link_only`, with its rationale as the body, and an uncarried kind is
    still not queued. `owner-inbox.test.ts` reads `budget_alert` as
    `link_only`.
- **Not done.** The token ceiling is still lifetime (L11), and a
  reasoning model's retries are not yet bounded by what is left (B1). Both
  come next; the second is 2.70.

## 2.70 A model turn is asked only when the budget can pay for it (F5.4, B1)

Found on the live run of 30 September (B1) and seen again on 2 October.
Each empty turn of a reasoning model was asked again with twice the room:
8,192, then 16,384, then about 20,000. Every turn sent the whole
conversation again, about 20,000 tokens of input. One marketing task counted
325,000 tokens and spent a division's lifetime allowance. The budget found
out only after each call, when the engine charged it. The provider bills a
call whether or not the budget then refuses to record it, so finding out
after the call was finding out after paying.

- **Asked first.** A runtime may now ask `tokensLeft()` (`RunServices`,
  `src/runtime/protocol.ts`). The engine answers with the task's own
  reservation plus the least that any account in its chain has free, which is
  what `budget_spend` would allow.
- **Before every turn** (`runAgentLoop`, `src/runtime/agent-loop.ts`), the
  in-process loop estimates what the turn sends, at four characters a token
  of its system prompt, messages and tools.
  - If what is left, less that, is under 512 tokens, the turn is not asked.
    The run ends `budget.exceeded`, so the task halts `budget_exhausted` and
    reaches the owner (2.69).
  - Otherwise the turn may write no more than what is left. The doubling for
    an empty turn still applies, but never past the budget.
- **Only when it calls.** The check runs inside the journalled step, so a
  turn replayed from the journal, which calls nothing, is never refused. A
  task the owner continued after raising its ceiling replays its earlier
  turns for free.
- **The silence check names the room the turn had.** It now names the room
  the turn was actually given. Before, it named the allowance, which the
  budget may since have cut.
- **Tested.** `budget-halt.test.ts`, with a model that only thinks:
  - A task whose first turn would send about ten thousand tokens, with six
    thousand left, halts without the model being asked once, and the owner
    is told.
  - With fifteen thousand left, the first turn may write less than its usual
    8,192 and at least 512.
  - Both failed before: the model was asked, and given 8,192.
- **Not done.** Agent CLIs and other runtimes in another process call their
  models themselves and cannot be asked first; for them the charge after the
  call is still the limit.

## 2.71 An account's tokens and money are counted per month (F1.9, L11)

Found on the live run of 2026-09-28 (L11), partly fixed by 2.26, and still
open on 2 October. An account's counts were for its whole life: spent once,
spent for ever. F1.9 sets a budget per period, monthly, beside the per-task
one, and a division that used its allowance in October was still out in
December until the owner raised it. On 2 October one request spent 96% of a
division's allowance, which would never have come back on its own. The
ceiling dialog said so: "Spent tokens stay spent".

- **Per calendar month, in UTC** (`0101_budget_periods.sql`), like the
  company's monthly ceiling.
  - `budget_accounts.period_start` is the month the counts belong to.
  - `app.budget_new_period(chain)` starts a passed month again: tokens and
    money spent go back to zero. What is reserved is not touched, because
    work still running holds it and will release it or spend it.
  - `budget_reserve` and `budget_spend` call it right after taking the
    chain's locks, before they check anything, so admission counts this
    month exactly. Both are 0024's functions with that one line added.
- **Started again for the owner, too.** On the first of the month, before
  anything has run, the Money page would show last month's total as this
  one's. The worker's watch stage calls `startNewPeriods`
  (`src/engine/budget.ts`) for each company.
  - It locks the accounts in id order, the order every budget function uses
    (0040), so it cannot deadlock against a charge.
  - It locks nothing in a month with no passed period, which is most ticks.
- **Existing accounts** are counted from this month: what they spent stays
  spent until it ends.
- **The application role** may move `period_start`, a running total like the
  ones 0047 lets it move.
- **Exported.** The column is in the audit export, and an archive from before
  this migration is restored with this month as its period.
- **What the owner reads.**
  - The Money page says "spent this month".
  - The ceiling dialog says the count starts again on the first of each
    month in UTC, and that raising is how an account gets more before then.
  - The guide's budget section says the same.
- **Also monthly now.** The Prometheus gauge of tokens spent per company
  (`src/reporting/metrics.ts`), which sums the accounts' counts, counts this
  month.
- **Tested.** `budget-period.test.ts`:
  - A division and the company above it, both spent to their ceilings last
    month, take a reservation this month, and both count from zero.
  - Spent to the ceiling this month, an account refuses.
  - A charge on an account last spent last month counts from zero.
  - `startNewPeriods` starts the passed month once and then finds nothing.
  - All three failed before the migration.

## 2.72 A token refresh restarts nothing (N4)

Found by the code audit of 2 October (N4), read in the code and not yet run
against a live sign-in. Every replica polls `settingsVersion()` every 30
seconds and starts again when it moves (`src/main.ts`). The version is the
latest `updated_at` of the deployment's settings and of its secrets.

The automatic token refreshes wrote both:

- A vendor's OAuth grant renewed before it runs out (`vendor-oauth.ts`) was
  sealed again with `putSecret`, which set `updated_at = now()`.
- An MCP server's token renewed on a 401 (`mcp-oauth.ts`) did the same, and
  also rewrote the `mcp_oauth` setting with its new `refreshedAt`.

So one division signed in to Google restarted the whole deployment about
once an hour. Each restart stopped the console and handed back runs in
flight. A run on a CLI role risks a `journal_divergence` halt when it comes
back.

- **A renewal is not a change of settings.** `putSecret` and `writeSetting`
  (`src/settings/store.ts`) take `{ renewal: true }`.
  - A renewal replaces the value and leaves `updated_at` as the owner last
    set it, so the version does not move.
  - A renewal of something that is not there yet is written as new, and
    does move the version.
- **Who renews.** Vendor grant refreshes, and MCP refreshes (`keepTokens`
  from `refreshMcpAccess`), renew. An MCP *sign-in* is still the owner's
  change, because a replica binds the server's tools when it starts.
- **Why nothing goes stale.** Both readers resolve the token at each use:
  - MCP through the deployment's secret manager, which reads the database
    every time.
  - Vendor credentials through a cache of 60 seconds, while a grant is
    renewed 5 minutes before it runs out, so a replica's cached old token is
    still good until it is next read.
  The restart used to flush those caches by accident; nothing relied on it.
- **Tested.**
  - `vendor-oauth.test.ts`: the settings version is the same before and after
    the refresh two calls share.
  - `mcp-oauth.test.ts`: the version moves on the sign-in and stays put
    across a refresh on a 401.
  - Both refresh assertions failed before.
- **Not done.** Pasting or rotating a division's key in the console is the
  owner's change and still moves the version, so replicas start again,
  though division keys are read at each use too. That is rare and the
  owner's own doing; the restart on every refresh was neither.

## 2.73 The language check reads a bounded sample, with a pattern that cannot backtrack (N5)

Found by the code audit of 2 October (N5) and measured.
- **The pattern.** The detector takes e-mail addresses out of what it judges
  (`ownWords`, `src/domain/language.ts`) with `\S+@\S+\.\S+`. On text with
  many `@` and no dot that backtracks in cubic time:

  | Input | Time |
  |---|---|
  | 4,000 characters of `a@a@` | 6.5 s |
  | 10,000 characters of `a@a@` | 99 s |
  | 600 Instagram handles joined by commas | 8.1 s |
- **What passes through it.** Since 2.64, ticket bodies of up to 8 KB, briefs
  handed on, stage evidence, reviewers' reasons and plans all do; drafts did
  already, at any length.
- **What it cost.** While it ran, the worker's heartbeat stalled, and another
  replica could take its runs as dead (B5).

What changed:

- **A pattern that cannot backtrack.** An address is now a run without `@`
  or space, an `@`, and a run with a dot in it: `[^\s@]+@[^\s@]+\.[^\s@]+`.
- **A bounded sample.** The detector reads the first 6,000 characters. A
  language shows itself well within that, and every pattern is cheaper on a
  bounded text. A single 50,000-character word with an `@` and no dot was
  still quadratic under the new pattern alone (1.8 s); with the sample it
  takes milliseconds.
- **Tested.** `languages.test.ts`:
  - The three inputs above, and that long word, each judged in under a
    second. The first took 6,424 ms before the change.
  - An Indonesian sentence around an address still reads as Indonesian.

## 2.74 A company starts in its owner's language (N7)

Found on the live run of 2 October (N7). The owner read the console in
Indonesian and started a company; its CEO and every agent wrote English.
Creation left the company's work and talk languages unset, so they followed
the deployment's agent language, which was English, and nothing on the way
asked. The only place to change them was **Settings**, **Languages**, which
an owner finds after the first English reply rather than before it.

What changed:

- **Asked on the form.** **Start a company** shows **Work language** and
  **Talk language**, both set to the language the console is in, and sends
  them. An owner who changes nothing gets a company in the language they are
  reading; one who sells in English and wants reports in Indonesian picks
  each.
- **Defaulted on the server too.** `POST /api/companies` takes
  `workLanguage` and `talkLanguage`, checked like every other language
  before the second factor is spent, so a wrong one costs no code and makes
  nothing. Left out, each is the panel language the owner chose in
  **Settings**. A panel that still follows the browser has no language on
  the server, and then the deployment's default stands, as before: the
  server does not guess a language it was never told.
- **Tested.** `owner-api.test.ts`: a company started with nothing said takes
  the panel's language; one started with two different languages keeps
  each; an unknown language is refused by name with no company made; with no
  panel language, both stay unset.

## 2.75 A task's progress counts the actions of its plan (N9)

Found on the live run of 2 October (N9). A task that had halted for its
budget showed a full bar, "5/5", beside "Out of budget". The bar divided
two different counts: every step the journal had committed -- each model
turn and each tool call -- over the actions the task's plan named. A run that
had thought five times had "done" a five-step plan whether or not it had
taken one of its actions.

What changed:

- **The plan's own actions.** The work view counts, for each capability the
  plan names and as often as it names it, the calls of it that succeeded
  (`planDone`). The bar is that over the plan's steps. A capability the plan
  names once and the run calls three times is one action of the plan; a
  call that failed, and `plan.record` itself, are none.
- **Finished, the bar is full** and the count still says how much of the
  plan it took; stopped, it says where.
- **The journal's count stays**, as steps, for a task with no plan.
- **Tested.** `work-status.test.ts`: a plan of three with five model turns,
  one unplanned read, two planned reads and a draft that failed reads 2/3,
  running and halted; one capability called three times for a plan that
  names it once reads 1/1; no plan, no count.

## 2.76 A waiting task says what it waits for (N9)

Found on the live run of 2 October (N9). The CEO's task, whose sub-task had
a sub-task of its own waiting on the owner's answer, read "Scheduled" with a
full bar. `waiting_window` is seven different waits -- work handed on, the
hours a role may work, the cheaper hours batchable work waits for, a
vendor's "not now", a turn at a busy capability, a model that did not
answer, the next attempt -- and the console called them all one word, the
one that suggests a plan rather than a wait.

What changed:

- **The reason is kept.** The engine records which wait it is on the
  `task.waiting_window` event that parks the task (`WaitReason`,
  `src/engine/tasks.ts`).
- **And what is open below it.** The work view sends, for a waiting task,
  the oldest work it handed on that is still open, and the nearest work at
  any depth that waits on the owner: a question or an approval two levels
  down is what the whole chain is waiting for.
- **The console says so.** The status reads "Waiting", and under the
  progress, on Work, Overview and Home: "Waiting until you answer Nadia" in
  orange when the chain waits on the owner, "Waiting for Nadia" when it
  waits on a role, or the kind of wait. The Overview's bucket is "Waiting"
  too.
- **Tested.** `work-status.test.ts` holds the three-level chain from the
  live run, the answer clearing it, a window wait, and a wait recorded
  before the reason was kept. `out-of-process-runtimes.test.ts` holds that
  the engine records `child` for a real hand-off, `model` for a model that
  did not answer and `slot` for a busy capability.

## 2.77 Work its run did not do ends as not done (N9)

Found on the live run of 2 October (N9). The owner asked for customer
cust-042's data to be deleted. The run deleted nothing -- the platform had
swallowed its question to the owner (N3, section 2.68), and without an
answer it judged it had no authority -- and said so in its summary: "cust-042's
data was NOT deleted". The task showed "Done" in green. The role's criteria
were about answering customers, and a ticket met them; whether what was
asked happened was nobody's question.

What changed:

- **A run may say so.** It is told: if what the task asked for was not done,
  add `"notDone"` with why, for the owner; ask the owner first when their
  answer would let it do the work.
- **The task ends there.** `failed`, with the reason `not_done` and the
  run's words on the event and in the output. Its report is not held to
  criteria it is not claiming, and it is not tried again: another attempt
  on the same facts reaches the same answer at the same price. A blank
  `notDone` says nothing; `true` with no reason is still not done.
- **The owner reads it.** The console shows "Not done" and, on the task,
  "Why it was not done" with the run's words. The chat notice for work the
  owner gave reads "Not done: …" with the run's reason, where it used to
  read the halt code aloud. The reason is held to the company's talk
  language, as a summary is.
- **Tested.** `done-criteria.test.ts`: a run that says it did not delete is
  failed with `not_done` after one request, with no attempt spent, its
  reason on the event, the output and the work view; a blank `notDone`
  completes as before. `owner-channels.test.ts`: the Indonesian notice reads
  "Tidak dikerjakan: …" with the run's reason.

## 2.78 Every model call is counted in what is spent (N8)

Found on the live run of 2 October (N8) and in the code. Three conversations
with a company's CEO, one of them thirty-nine seconds of several turns, left
no row in `llm_traces`, and neither did memory distillation
(`src/memory/distillation.ts`). The engine traces the calls of tasks, and
these are not tasks -- while the month's ceiling, the daily cost alert, the
digest and the Money page all sum `llm_traces`. Each of them was short by
what the owner's conversations and the company's learning cost.

What changed:

- **A CEO's turns are its company's calls.** Each turn is a trace of the
  company, outside any task, written as the answer arrives: a turn that led
  to no answer, a reasoning turn asked again, a conversation the owner
  stopped, all cost what they cost.
- **So is distillation.** Each call, facts and procedures alike, is traced
  when it answers, before the answer is judged.
- **Neither draws on an account.** They are not work an account was
  reserved for, and the owner's conversation is never refused for money.
  The month's ceiling counts them, and a company paused at it stops
  distilling until it is resumed; the watermark keeps its place.
- **PALUGADA's own assistant** belongs to no company, and `llm_traces` is a
  tenant table. An answer keeps what it cost (0102), and `GET
  /api/control/cost` adds it up beside the companies; the Money page shows
  it on its own line under **Every company**.
- **Not changed:** the weekly digest's per-division breakdown joins traces
  to tasks, so its divisions add up to less than the company's total by what
  was spent outside tasks.
- **Tested.** `metering.test.ts`: a CEO conversation of two turns is two
  traces at what the model charged, rounded up, in that company and no
  other; a turn before a failure still counts; the spend guard and the cost
  timeline read the sum. PALUGADA's assistant charges no company and shows
  in the deployment's figure. Distillation's calls are traced. A paused
  company's worker distils nothing until resumed.

## 2.79 Signing in to an MCP server takes the owner's device (B4)

Found by the audit of 30 September and still open on 2 October (B4).
`POST /api/control/mcp/oauth/start` asked for no second factor, while the
same sign-in for a division's key does (section 2.25). The tokens a sign-in
leaves are kept under the server's name when the owner's browser comes back
(`keepTokens`, `src/capabilities/mcp-oauth.ts`), and a saved server of that
name signs in with them from then on, replacing what it had. Anyone holding
the owner's session -- a console left open, a stolen session token -- could
sign a saved server in as an account of their own, and every role using its
tools would then read and write there, with no code asked and nothing in
the inbox.

What changed:

- **The device says yes.** The start asks for the owner's factor, after the
  server is found and a client is registered and before the page to sign in
  on is handed over. A server that cannot be signed in to -- one that names
  another resource, offers no PKCE, calls itself something else, or
  registers no client -- is refused first, so no code is spent on it. A
  refused start leaves a sign-in no one holds the state of, which expires
  in minutes.
- **The console asks** with the dialog it uses everywhere else, titled
  "Sign in to tracker"; what a server needs, a client ID for one, is still
  shown on the form rather than in the dialog.
- **The assistant** still cannot propose it, and now says why in the same
  words as the division's sign-in: the owner's, with their device and in
  their own browser.
- **Tested.** `mcp-oauth.test.ts`: with the server signed in as the owner,
  a start with no code and one with a wrong code are refused with no page
  to sign in on, the saved grant is unchanged and nothing more is redeemed;
  the refusals for a server that does not say who it is still come before
  any code.

## 2.80 A month's pause ends with its month (F1.7, M6)

Found by the audit of 30 September and still open on 2 October (M6). The
spend guard pauses a company when a month's spending reaches its ceiling
(`evaluateSpendLimit`, `src/governance/spend-guard.ts`), and nothing lifted
the pause when the month ended: in the new month the guard found spending
under the ceiling and returned without touching `paused_at`. A company that
ran out in October was still paused in November, every task it was given
refused as `spend.paused`, until the owner found **Money** and lifted it by
hand with a code. Its card, "Monthly budget reached; the company is
paused", stayed open after any lift.

What changed:

- **The pause is the month's.** At the first look in a new month -- the
  worker's watch stage, every tick -- a pause set in an earlier month is
  lifted with any override it had, and `budget.period_resumed` says when it
  was set and which month began. Spending already at the new month's
  ceiling pauses the company again, for this month.
- **Its card goes with it.** The pause's card now carries what it is about
  (`spendPause`), and is withdrawn when the pause ends: `period_started` at
  a new month, `spend_resumed` when the owner lifts it. One raised before
  the payload was kept is found by its title.
- **Not changed:** tasks the pause stopped stay stopped, as section 6.3
  asks; each is continued from its page (section 2.69).
- **Tested.** `spend-guard.test.ts`: paused last month, the company takes
  work again at the first look this month, its card withdrawn and the event
  written; a pause of this month survives the next look; the owner's lift
  withdraws its card.

## 2.81 A worker that was away judges nobody quiet (F5.12, B5)

Found by the audit of 30 September and still open on 2 October (B5). A
worker takes back the running tasks of one that has stopped saying it is
alive (0079): quiet for a minute, on the database's clock. The asker left
itself out, "it is alive, whatever its last beat says" -- and that was the
defect. A worker that had been away itself, the database gone for a minute
or its own loop stalled (the language check of section 2.73 stalled one for
a minute and a half), came back to find every other worker's last word as
old as its own, and took back their running tasks. Each live run lost its
lease and stopped, and each loss counted towards the three that halt a task
as a crash loop: one outage, three times over, could halt work that was
never in danger.

What changed:

- **Since when, without a break** (0103). A heartbeat row keeps when its
  worker began beating without a gap longer than two intervals. A gap that
  long is the worker having been away, and the run starts again.
- **Only an unbroken worker judges.** `silentHolders` answers only for a
  worker whose own word is fresh and has been unbroken for as long as a
  holder may be quiet. Back from an outage, every worker waits that minute,
  in which the live ones write again; then only the one that never came
  back is quiet. A worker that never wrote, or whose own word is stale,
  judges nobody.
- **Not changed:** a loss to a holder that really went quiet still counts
  towards the crash loop, since a task that takes its worker down with it
  is what the limit is for. A worker that dies is still found within about
  a minute of its last word, and the lease stays the backstop.
- **Tested.** `checkout-lease-lane.test.ts`: after five minutes with the
  database away, the first worker back judges nobody and reclaims nothing;
  a minute on, with the live worker having written again, only the dead one
  is quiet; a worker with a stale word, or none, judges nobody. The test of
  a quiet holder's tasks returned at once now has the asker unbroken, where
  it had it five minutes stale -- the very state it should not judge from.

## 2.82 Each opening of a claim link is shown its own secret (F12.5, B3)

Found by the audit of 30 September and still open on 2 October (B3); a
change to the label of the authenticator (f71d508) had not touched it. A
deployment with no owner prints a claim link, and opening it shows the
secret the owner adds to an authenticator app (section 2.48, 0094). The
secret was derived from the master key and the claim alone, so that a
laptop and then a phone would be shown the same one -- and so was everyone
else who opened the link. Whoever saw it before the owner did, in a log
shipped to a third party or over a shoulder, and opened it, kept a copy of
what became the owner's one authenticator: they could sign in and approve
tier 3 actions as the owner for as long as it stood, and nothing would show
that anyone had.

What changed:

- **An opening's own secret.** Each opening is given a random value, 128
  bits, and its secret is derived from the master key, the claim and that
  value; nothing new is kept. The page sends the value back with the code
  its app shows, and only the opening whose secret the app holds can make it
  the owner's. A reload, or anyone else, is shown another.
- **What does not change:** the claim is still whoever confirms first, as
  the log's reader already holds the machine; what they can no longer do is
  keep a copy of the owner's factor. The code in the log still gives no
  secret by itself. A page from before this change sends no value and is
  told to open the link again.
- **Tested.** `owner-claim.test.ts`: two openings are shown different
  secrets; a code from one does not confirm the other's, nor does a page
  naming no opening or one made up; once the owner confirms theirs, the
  earlier opener's secret signs nobody in. `process.test.ts` claims a
  deployment started by `npm start` the same way.

## 2.83 A vendor's bad moment is waited through, not halted on (F8.12, H2)

Found by the audit of 30 September and still open on 2 October (H2). A
capability's preflight (F8.12) failed on any answer of 400 or more and on
any dropped connection (`src/capabilities/http.ts`, and the same in
`mcp.ts`); the reading stood for fifteen minutes, and every task that needed
the capability in that time was halted with `capability_unhealthy`, which is
terminal -- each one to be run again by hand. One 503 from a vendor could
stop a quarter of an hour of a company's work. The incident told the owner
that "no task that needs it will start until it passes", as if they were
waiting; they were not.

F8.12 is about the failure no retry fixes, and a vendor answering 503 is
not that failure.

What changed:

- **A preflight says which failures pass.** A capability's preflight may
  mark a failure `transient`. The HTTP capability does so for 429, any 5xx
  and a connection refused or timed out; MCP does so for the same, but not
  for a 401 or anything the server said in its own protocol. A credential
  that could not be resolved, or an address this platform refused, is not
  transient.
- **Kept for a minute** (0104). A passing failure's reading stands for one
  minute, not fifteen, and raises no incident by itself.
- **The task waits.** When every failure is passing, the task parks
  ("Waiting for a service to answer again") and looks again after a minute,
  then two, four, eight and sixteen -- about half an hour. If the service is
  still not answering, the task halts as before and the owner gets one
  incident saying what the service answered and that the work stopped.
  Any lasting failure among them halts at once.
- **The incident for a lasting failure says what happens**: the work is
  stopped rather than started, and has to be run again once the cause is
  fixed.
- **Tested.** `preflight.test.ts`: a 503 parks the task with no incident,
  and it runs once the vendor answers; down for good, it waits five times
  and halts with one incident. `http-capability.test.ts` and
  `mcp-client.test.ts` hold which answers pass and which do not.

## 2.84 A task the worker could not start goes back at once (F5.12, M1)

Found by the audit of 30 September and still open on 2 October (M1). A
worker claims a task and hands it to the engine (`#runClaimed`,
`src/worker.ts`). Anything the engine threw before the run's own handling
began -- the database refusing a write while the contract was read, the
task moved, or preflight recorded -- went past the worker, whose loop logged
`place.failed` and went on. The task stayed checked out to a worker that was
not running it, its lease unrenewed, for the fifteen minutes of a lease,
with no reason in the console; then it came back as a lost worker.

What changed:

- **Given back with why.** The worker catches what the engine throws,
  records it on the tick as a `run` failure, and gives the task back at once
  (`giveBack`): pending again, the lease cleared, and `task.lease_expired`
  saying "the worker could not start it" and what was thrown.
- **Counted as a loss.** A task that can never start halts as a crash loop
  after three, with an incident, rather than taking every worker's place in
  turn. A database that is still away cannot take the task back either, and
  the lease stays the backstop it always was.
- **Not claimed again in the same tick.** The worker stops claiming for that
  company until the next tick, as it does when a runtime is down; a place
  sleeps before it looks again.
- **Tested.** `worker.test.ts`: an engine that throws as it starts leaves
  the task pending with no holder after one tick, one `run` error and the
  reason on the event; it runs once the engine can; one that can never
  start halts with `crash_loop` after three ticks.

## 2.85 A failure nothing handled is said, not fatal by accident (L2)

Found by the audit of 30 September and still open on 2 October (L2).
Nothing in `src/` or `scripts/` listened for `unhandledRejection` or
`uncaughtException`, so Node's default applied to both and the process died
where it stood. One promise nobody awaited -- a notice to a chat, a sweep
that lost the database for a moment -- took the console and the worker down
together: every run cut off rather than handed back, each to come back only
when its lease ran out, counted as a lost worker, and the only trace a
stack on standard error.

What changed (`src/process-guard.ts`, installed by `runFromCommandLine`):

- **A rejection nothing awaited is said, and the process goes on.** It is
  work whose failure nobody was waiting to hear; the rest of the process is
  as sound as it was. The line names it as a bug, with its stack.
- **An exception nothing caught stops the process the way a signal does**:
  readiness says no, the console closes, the worker hands its runs back
  (section 2.22), and the process exits 1 for the supervisor to start a
  clean one. A throw that unwound a stack nobody expected leaves state
  nobody can vouch for. A stop that does not finish in thirty seconds, or a
  second exception while stopping, ends the process anyway.
- **Redacted**: a failure's message can carry a credential, and every secret
  the process has registered is masked in what is written.
- **Tested.** `process-guard.test.ts`, in a process of its own: a rejection
  is written, redacted, and the process carries on; a later exception stops
  it, the stop runs, and it exits 1; a stop that never finishes still ends
  the process.

## 2.86 A schedule is turned off, on and removed, and set by day and time (F9.1, N11)

Found by the audit of 30 September (T2-3) and in the code on 2 October
(N11). A schedule had two routes, save and run now. The console showed
"Off" with nothing to turn it on; a schedule turned off -- by denying the
escalation that asks whether a repetitive one is still worth running, or by
closing its goal -- could be revived only by typing it again under the same
short name, which overwrote its brief, kept its old role, and turned it on,
since saving said `enabled ?? true`. Nothing removed one. And a new one was
asked for as cron, in UTC unless the owner found the zone list: an owner in
Jakarta who wanted seven in the morning had to type `0 0 * * *`, or know to
pick Asia/Jakarta and type `0 7 * * *`.

What changed:

- **Off and on** (`POST …/schedules/:id/enabled`). Turned on, its next run
  is its next time from now: what it would have run while off is not owed,
  and a week off is not a week of runs at once. `schedule.turned` records
  it.
- **Removed** (`POST …/schedules/:id/remove`). The work it made stays, as
  work the owner can open, without its link to the schedule (0049).
  `schedule.removed` records it.
- **Saving again keeps it off.** Without `enabled`, a schedule saved again
  keeps what it was; a new one is on.
- **A new one cannot take a taken name.** "New schedule" sends `create`, and
  a short name in use is refused with 409, naming it, rather than that
  schedule overwritten.
- **Days and a time, not cron.** The form asks how often it repeats --
  every day, every weekday, one day of the week, every hour -- and at what
  time, in half hours, and builds the cron; **Custom, as cron** remains for
  anything else. The time zone starts as the browser's own, and each zone is
  labelled with what its clock is called there ("Asia/Jakarta · WIB"). The
  table says a schedule's time in words, "Every weekday at 07:00", with the
  cron in its tooltip.
- **Each row** has a switch for off and on, and a button to remove it after
  asking. The assistant may propose either.
- **Tested.** `schedule-control.test.ts`: off, a week passing runs nothing;
  on again, the next run is ahead and nothing is caught up; saved again it
  stays off; a new one under a taken name is refused and the old brief
  kept; removed, its run is still there with no schedule.

## 2.87 Replay is offered only where it can run (F11.4)

Found by the audit of 30 September (Task 4, item 7). Every task's drawer
offered **Replay against the journal**, and on a deployment started by
`npm start` every press was refused: the route replays a role's in-process
handler, `npm start` registers none, and a role run by a model, an agent
CLI or a container is not replayed by this deployment at all (F5.9, F13).
A button that can only be refused teaches the owner to stop pressing
buttons.

What changed:

- **Said with the task.** `GET /api/companies/:id/tasks/:taskId` answers
  `replayable`: true only when the task's role is one this deployment runs
  as a handler in its own process.
- **Shown only then.** The drawer offers the replay when it can run, and
  not otherwise. The route still refuses by name, for a caller that asks
  anyway.
- **Tested.** `owner-api.test.ts`: a task whose role the deployment runs is
  replayable and replays; one whose role it does not run is not, and its
  replay is refused with why.

## 2.88 What a run said is in its transcript once (N13)

Found on the live run of 2 October (N13). "What it said" repeated the same
lines with new times at every resume -- after an approval, a window, a
handed-back run -- until the CEO itself wrote that it had "repeated its
orientation eight times". The agent loop narrated every turn it went
through, and a resumed run goes through its earlier turns again, replayed
from the journal rather than asked of the model.

What changed:

- **Said once.** A turn is narrated only when the model wrote it now; one
  the journal replays is not said again (`src/runtime/agent-loop.ts`).
- **Not changed:** a tool call that failed is not committed, so a resumed
  run makes it again, and a refused hand-off is refused again. It has no
  effect beyond its own refusal, and section 2.66 removed the cause of the
  twenty refusals on the live run; a call journalled as its refusal is a
  change to what the journal promises, and is left for its own decision.
- **Tested.** `model-runtime.test.ts`: a run stopped after its first turn
  and resumed has that turn's words in its transcript once.

## 2.89 A question on an approval card reaches the model, and its answer the card (F10.3, N6)

Found by the audit of 30 September (Task 4, item 1) and still open on
2 October (N6). The owner asked a question on an approval card; the console
said "Question sent to the agent", and no model read it. The task went back
to work, the agent loop replayed from its journal the turn that had asked
for the action -- a model's turn is journalled by its number, and replayed
without asking the model -- made the same call, met the same open card
(`requestApproval` keeps one card per task and capability) and waited
again. The question was in a context no model was given. And the run was
told to "record your answer against inbox item …", with nothing to record
it with. Only a role run by code in this process ever read a question,
which is what the old tests covered.

What changed:

- **Asking reopens the turn** (`reopenForQuestionWithin`,
  `src/engine/journal.ts`), in the transaction that records the question:
  the model's turns after the last thing the run did in the world are asked
  again. Tool steps before them stay committed, so nothing done is done
  twice; the call waiting on the card was never committed.
- **The run answers in its own words.** It is told to answer first, in a
  sentence or two for the owner, then to ask for the action again if it
  still stands, changed if it should be, or to say why not.
- **The answer is kept on the card.** When the run asks for the action
  again, what it said since the question is recorded with it on the card
  (`asked`), and the card waits for the owner's decision again. If the
  action changed, the new card carries the exchange; a run that said nothing
  leaves the answer empty. The card shows **You asked** and **The agent
  answered**, or that the agent is still reading.
- **Tested.** `model-runtime.test.ts`: a run asks for a tier 3 transfer;
  the owner asks why; the model is asked again with the question in its
  context, answers and asks again; the same card holds the question and the
  answer and is undecided.

## 2.90 An answer to a run's question closes it, through every route (F10.3, B6)

Found by the audit of 30 September (B6, L18) and still open on 3 October,
by the API: a run's own question (`owner.ask`) answered through
`POST /api/companies/:companyId/inbox/:itemId/answer` -- the route the
owner's assistant uses -- was never answered. The route gives an
escalation the owner's word without deciding it, which is right for an
escalation about work: the words went to the task as an instruction and
the task went back to work. But a run reads the answer to its question
from the decided item (`askOwner`, `answersFor`). The item stayed open, the
run that resumed asked the same question, found it open and parked again:
`owner.answered`, then `task.waiting_approval` 2.6 seconds later, as often
as it was answered. The console's and the chats' answer buttons decide the
item, and were not affected.

What changed:

- **An answer to a run's own question decides it** (`answerEscalation`,
  `src/inbox/inbox.ts`): approved, with the answer as the owner's note,
  through `decide` -- the same record, the same channel on it, and the same
  refusal when the item has expired or closed. Every other escalation is
  answered as before and stays open.
- **Said once.** The answer is not also written to the task as an
  instruction, so the run does not read it twice, once as an answer and
  once as an order.
- **The assistant is told** that answering a run's question closes it.
- **Tested.** `control-plane.test.ts`: a run asks; the owner answers through
  `answerEscalation`; the item is decided with the answer, the task is
  running, the run that asks again is given the answer and does not park,
  and a second answer is refused as already decided.

## 2.91 Doing unfinished work again does not do again what it already did (F5.2, N12)

Found by the analysis of 3 October (N12), from the code. **Do it again**
makes a new task, so every write the new task made carried a key of its
own (`callKey` is made from the task) and its journal was empty. The run
was told only that the attempt before it "ended halted" -- not that it had
written the note, sent the email or posted the update. A rerun after a
deadline, a hop limit or a stop could therefore make every write again,
and tier 1 and 2 writes are not put to the owner on the way.

What changed:

- **Which attempts count** (`unfinishedAttempts`,
  `src/engine/owner-control.ts`): the attempts before this one, back to
  the last that finished. Work that finished, asked for again, is new work:
  the owner saw it done, and asking again means doing it again -- the
  report written afresh, the newsletter sent once more.
- **The run is told what they wrote.** Among its notes, and never dropped
  for room: each write those attempts committed -- a call the broker made at
  tier 1 or above -- with what it was given and what it returned, as data,
  the last twenty of them. A read is not listed: it changed nothing, and
  what it read may have changed since.
- **The same write is answered from their record** (`writtenBefore`,
  `src/engine/journal.ts`; the engine's `callTool`). A call with the same
  capability and the same input as a write they committed returns what it
  returned then, is journalled in this task, and is recorded as
  `tool.not_repeated`, which the task's history shows as "not done again:
  an earlier attempt had already done it". Nothing reaches the vendor, and
  nothing is charged. A read is made again.
- **A write whose answer never came goes under the key it was first sent
  with.** A tool call's key is now made from the first of the unfinished
  attempts rather than from the rerun, so a vendor that acted on a call
  whose answer was lost when the attempt stopped can tell the second for
  the same write.
- **Not changed:** a call worded differently is a different call. The run
  is told not to reword a call to do the same thing twice; it is not
  prevented from writing something new.
- **Not covered:** what an earlier attempt handed to another role. A child
  task is a task of its own, and the rerun's children start fresh: a
  coordinator's rerun can still have a child do again what the earlier
  attempt's child did. Open.
- **Tested.** `model-runtime.test.ts`: an attempt reads, writes a note,
  sends a second note whose answer is lost, and is stopped; done again, the
  run is told of the first note, makes the same three calls, and the read
  is made again, the first note is answered from the record, and the
  second goes to the vendor under its first key. Done again once more after
  finishing, the same note is written again under a key of its own.

## 2.92 An agent resumed in its own order and words carries on (F5.1, N14)

Found by the audit of 30 September (H4) and still open on 3 October (N14),
from the code; the test written for it found it worse than described. A
runtime in another process -- an agent CLI, an ACP agent, a container, an
HTTP service, a script -- was replayed by the place of its steps, as a
handler in this process is. But such a runtime is not replayed: resumed
after the owner's answer or an approval, or after a restart, it starts
again from what it is told and goes on in its own order and its own words.
Its first call that did not match the step recorded at its place was
refused as `journal.divergence` -- told to the agent as a failed tool call,
which it worked around -- and a call that landed on the place of an
unfinished step was written over it. In the test, the agent asked its
question again first, was refused, wrote its answer over the question's
step and finished: the task was shown as done, and the owner's answer was
never read.

What changed:

- **Its steps are found by what they are** (`place`, in the engine's run).
  For a runtime that is not `in-process`, each call is matched to the
  journal as it stood when the run began: a call with the same name and
  input as a step there is given that step -- a finished one first, each
  step to one call -- and is answered from it if it finished, or made again
  under its own key if it did not. Anything else goes after the last step,
  and nothing is written over. A fallback to another model starts the
  matching again, with what the failed attempt journalled.
- **Unchanged for code in this process and the model loop.** A handler and
  the model loop, which journals its own turns, make the same steps in the
  same order when they run again; their steps are still their places, and a
  handler that takes other steps still halts as `journal_divergence`.
- **Not changed:** a call worded differently is a different call. A read
  worded differently is read again; the same write worded differently would
  be made again, which is why a resumed run is told what it already did
  (F4.7) and, after a stop, what the attempt before it wrote (2.91).
- **Tested.** `out-of-process-runtimes.test.ts`: a script runtime records a
  plan, makes a tier 2 write and asks the owner; answered, it runs again,
  asking first, writing again and reading a zone it names differently. It
  is given the answer, the write is answered from the record and not made
  again, the read runs, the task completes, and the journal holds each call
  once, where it was first made.

## 2.93 Retention reaches the work itself (F11.5, M10)

Found by the audit of 30 September (M10) and still open on 3 October.
Retention scrubbed prompts and replies at the prompt window and purged
events, traces and the platform's bookkeeping at the company's windows
(migrations 0007 and 0046). The work those records were about was never removed: every
task, every journal step with what it was given and what it returned,
every run and every card stayed for ever, past the windows that had removed
everything said about them.

What changed:

- **Finished work goes past both windows** (`purgeExpiredWork`,
  `src/retention/retention.ts`, run by every retention pass): a task
  finished before the later of the event and trace windows, with what hangs
  from it -- its steps, runs, cards, notes and the events and traces still
  about it, which the database removes with it. The later window, because a
  task takes its events and traces with it. A card that belonged to no task
  goes at the event window once it is closed; an open one stays.
- **Work something still points at stays,** however old, and what it points
  at in turn:
  - anything said about it since the cutoff, such as the owner's word on it
    or a rerun asked for;
  - a card about it still open in the owner's inbox;
  - a parent of work that stays, since removing a task removes the tasks
    under it;
  - work that a task that stays was asked for again in place of, whose
    answers and notes that task still reads (L6);
  - work that handed on to a task that stays.
- **Checked by the database too.** The purge runs under the same flag as an
  event purge, and the database refuses to remove any event inside the
  window, so a mistake in what is kept fails the pass rather than removing
  recent history. What a memory, a measure, a ticket or a schedule
  remembered of a task is kept, without the link.
- **On the record** as `work_purged` (migration 0105).
- **Indexes for the removal** (0105): removing a task makes the database
  find every row that points at it, and nine tables that grow with the work
  -- among them `inbox_items`, `llm_traces` by run, `owner_notifications`,
  `task_handoffs` by successor and `memories` by source -- had no index on
  the column it searches.
- **Tested.** `retention-rotation.test.ts`: of twelve tasks finished 500 or
  3 days ago, the three old ones nothing points at go with their steps,
  runs, cards and events, and a parent of live work, work talked about
  since, work with an open card, work done again since and work that handed
  on since all stay; an old closed card with no task goes, and an old open
  one stays; the purge is in the retention log.

## 2.94 Every event and step on the owner's timelines is said in words (F11.2, §2.3 item 7)

Found by the live run of the analysis of 3 October (§2.3, item 7: internal
words shown to the owner). The task timeline (**What it did**) and
**Lately** show the company's events, and 95 of the event types the server
writes had no sentence: each was shown as its code made readable --
"Content read outside", "Task running", "Budget halt raised" -- in English
whatever the console's language. Beside each stood the code of whoever
wrote it: "engine", "broker", "agent_run". The progress line and the trace
named a task's steps the way the journal does: "Model:turn 2".

What changed:

- **A sentence for every event** (`EVENT_SENTENCES`,
  `console/src/format.ts`), in all twenty languages: a task's moves ("Working
  on it", "Back in the queue", "Task stopped"), the owner's own actions ("You
  put an item off", "You gave your word on the result"), what the platform
  checked ("Read back, and it matched", "The guardian checked an action"),
  and what it refused ("An attempt to read another company's data was
  refused"). A hook's refusal is said as a check's ("A check refused a tool
  call"): the console never names hooks to the owner.
- **Held by a test** (`test/documents/console-events.test.ts`): the server is
  read for every event type it writes -- each `type:` or `event:` it gives,
  a task's move to each status and a hook's refusal at each point, leaving
  out the operator's log -- and each must have a sentence.
- **Who acted, in words** (`actorSaid`): "You", "The agent", "A schedule" or
  "The platform", on both timelines; the test refuses an actor shown as its
  code.
- **A step, in words** (`stepSaid`): "Thinking, turn 2", "Using crm.note",
  "Waiting for writer", or the event's sentence, on the progress line and
  in the trace.
- **Still open in this item:** a card's title for a run's question uses the
  role's short name ("bookkeeper asks:"), an approval names the capability
  ("record.delete") and the account its path ("ops/growth"), and a halt's
  detail is the engine's English. Each is its own change.

## 2.95 A run's question is headed by who asks, by name, in the owner's language (F10.3, §2.3 item 7)

Found by the live run of the analysis of 3 October (§2.3, item 7). A run's
question (`owner.ask`) reached the owner as "bookkeeper asks: ...": the
role's short name, which is the platform's, and English whatever the owner
reads. The inbox named the asker by the same short name ("Asked by
bookkeeper"), and a chat said the question twice, as the card's title and
again as its summary.

What changed:

- **By the name the owner gave the role** (`roleName` on an inbox item; the
  stored title, in `askOwner`), wherever the inbox names who asks, including
  the "allow for a while" choices; the short name only where a role has no
  name.
- **The question is the card.** The inbox lists a run's question by the
  question itself, and its card is headed "A question from Sari", in the
  console's language.
- **In the chats, in the owner's language** (`askerOf`, `src/owner/notify.ts`;
  Telegram and WhatsApp): "*Sari bertanya:*" over the question, said once.
  "{role} asks:" is in every dictionary in `src/owner/sentences/`.
- **Tested.** `owner-channels.test.ts`: a role named Sari asks; the inbox
  item names Sari, its record is titled by her name, and the Telegram card
  is headed "Sari asks:" in English and "Sari bertanya:" in Indonesian, with
  the question once and no English in the Indonesian.
- **Still open in this item:** capability names ("record.delete") and the
  account's path ("ops/growth"), and a role's short name elsewhere in the
  console (Home, the schedule list, standing approvals).

## 2.96 A capability is named for what it does, and an approval says why without the platform's words (F10.2, §2.3 item 7)

Found by the live run of the analysis of 3 October (§2.3, item 7). An
approval card was headed "record.delete: recordId cust-042", the timeline
badged events "crm.note", the trace said "dns.update done", and the progress
line "Using email.send": capabilities by their codes. The reason on every
approval the broker raised began "Task 6f1c…-… requested record.delete at
tier 3", and one about outside content ended with a requirement's number,
"(F8.9)".

What changed:

- **A name for every capability in the catalogue** (`CAPABILITY_NAMES`,
  `console/src/format.ts`), in all twenty languages: "Delete a record",
  "Send an email", "Release to the live site", "Read the books". Held by
  `test/documents/console-events.test.ts`, which reads the catalogue. A
  capability from outside it -- a vendor's, an MCP server's tool -- keeps its
  own name.
- **Used wherever the owner reads one**: an approval card is headed by what
  the action does, followed by its arguments ("Delete a record: recordId
  cust-042"), and the line of arguments is not repeated above the full list
  of them; the timeline's badges, the trace, the progress line ("Now: Send an
  email"), the "allow for a while" choices and the standing approvals.
- **The reason is said to the owner** (`src/broker/broker.ts`): "This work
  asked for it at tier 3, which cannot be reversed." The card names the
  action and links the work; the task's id and the capability's code are not
  in it, nor the requirement's number.
- **Tested.** `capability-broker.test.ts`: a tier 3 approval's reason is the
  sentence above, without the task's id or the capability's code;
  `triggers.test.ts`, without "(F8.9)"; and the documents test above.
- **Still open in this item:** a chat's card is headed by the broker's title,
  which names the capability by its code -- the chats' dictionaries do not
  name capabilities yet -- and an account by its path ("ops/growth").

## 2.97 No weekly review of an empty week, and "Run now" says what a run may spend (F9.1, N10)

Found by the live run of the analysis of 3 October (N10). **Let it run
itself**, on by default when a company is created, adds a strategist who
reviews the week every Monday. On a company that had done nothing yet, the
review read an empty week, went looking for something to say, and spent
770 thousand tokens in three and a half minutes; the dialog in front of
**Run now** had said it "reserves 1,000 tokens", which the owner read as
what it would cost.

What changed:

- **An empty week is passed over** (`weekHadWork`, `src/reporting/week.ts`;
  `passOver`, `src/scheduler/scheduler.ts`). When the clock fires a schedule
  that asks for the week and nothing happened in it but the schedule's own
  runs -- no task started or finished other than one of them or work under
  one, no measure recorded -- no task is made, the schedule moves to its
  next occurrence, and `schedule.nothing_to_review` says so once ("Schedule
  skipped a run: nothing happened that week to review"). The owner's **Run
  now** is not asked: it runs whatever the week holds.
- **The dialog says the ceiling** (`runCeilingTokens` on a schedule; the
  console's **Run now**): beside what a run reserves to start, the most one
  run may spend -- its role's ceiling for a run -- and that work it hands to
  other roles spends more.
- **Unchanged:** **Let it run itself** stays on by default; on a company
  with nothing done yet it now costs nothing until there is a week to
  review.
- **Tested.** `schedule-quiet-week.test.ts`: an empty week is passed over,
  said once, and the schedule moves on; the schedule's own finished run
  does not make a week worth reviewing; a week with finished work is
  reviewed; the owner can run a review of an empty week; and a schedule
  reports its role's ceiling for a run beside its reservation.

## 2.98 Money says its currency (F11.3, §2.3 item 3)

Found by the live run of the analysis of 3 October (§2.3, item 3). Every
amount PALUGADA keeps is in US cents -- providers price models in dollars per
million tokens, runtimes report dollars, the catalogue estimates in cents --
and the console printed amounts with no currency: an Indonesian owner read
"Batas 200,00" and "Terpakai 0,75" as rupiah. The cost chart beside them wrote
"0.20" the English way, and an account's ceiling and the daily-cost alert
were typed in cents.

What changed:

- **Every amount is written as US dollars**, the way the console's language
  writes them (`money`, `console/src/format.ts`): "$0.75" in English,
  "US$0,75" in Indonesian, "0,75 $" in German.
- **The chart writes them the same way**, not with `toFixed`.
- **Typed in dollars.** Opening an account takes its **Money ceiling** in
  dollars, as the existing ceiling dialogs did, and the daily-cost alert its
  **Daily cost**; each money input shows the currency where the language puts
  it (`currencyAffix`, and a `money` field in `ActionForm`). They are kept in
  cents, as before.
- **Tested.** `test/documents/console-money.test.ts`: the console's own
  formatting, in English, Indonesian and German; and the Money page writes no
  figure with `toFixed` and asks for nothing in cents.
- **Still open:** showing amounts in the owner's own currency too, at a rate
  they set, and the daily digest in the chats, which is in English and writes
  its spend without a currency.

## 2.99 A budget account is named for what it covers (F1.6, §2.3 item 7)

Found by the live run of the analysis of 3 October (§2.3, item 7). The
accounts a template makes are labelled with the platform's codes -- the
company's "company", each division's by its short name, "ops" -- and the
**Money** page used those labels as the accounts' names. A role's budget
said what it rolls up through as the first eight characters of each
account's id, in a fixed-width font; and a budget halt told the owner "token
akun company habis", an English code inside an Indonesian sentence.

What changed:

- **Named for what it covers** (`ACCOUNT_NAME`, `src/engine/budget.ts`): an
  account a template labelled with a division's short name is called by the
  division's name, the whole company's by nothing the platform writes -- the
  reader says "The whole company" in their own language -- and one the owner
  labelled keeps its label. Budget accounts carry it as `name`.
- **The chain by name.** A role's budget returns `chainNames` beside `chain`,
  and the console shows "Ramadan promotion → Operations → The whole company".
- **The halt card in one language** (`budgetHaltWords`): "token akun
  perusahaan habis". "company" is in every dictionary in
  `src/owner/sentences/`.
- **Tested.** `budget-names.test.ts`: on a company made from the standard
  template, the company's account is unnamed, a division's is its division's
  name, the owner's keeps its label, and a role's chain is named in order;
  `budget-halt.test.ts`: a halt on the whole company's account says
  "perusahaan" in Indonesian.

## 2.100 The change log and the retention log say what happened, in the owner's language (§2.3 item 7)

Found by the live run of the analysis of 3 October (§2.3, item 7), after
2.94 put every event in words. Two lists were left that print codes. The
change log on **Health** headed each entry with its subject -- "charter",
"policy" -- badged it "updated", and said "by template" or "by owner" in
English whatever the console's language. The retention log under a
company's settings named each pass by its code: "prompts_scrubbed",
"journal_scrubbed", "bookkeeping_purged". The events the governance log
mirrors -- `charter.created`, `policy.deleted` and the rest, written from a
template in `record` -- and the `company.created` a template writes by a
raw insert were not found by the event scan, so the timeline showed them as
their codes too.

What changed:

- **The change log in words.** An entry is headed by the sentence its event
  has on the timeline -- "Charter changed", "Policy removed" -- and says who
  did it as the timelines do: "You", "The company template", "The charter
  repository" (`actorSaid`, `console/src/format.ts`).
- **The retention log in words** (`retentionSaid`): "Old prompts cleared",
  "Old model replies cleared from finished work", "Old finished work
  removed". "Cleared" and "removed" are different words in every dictionary:
  a cleared row is kept with its text blanked.
- **Tested.** `console-events.test.ts` now finds the event types a statement
  inserts into `events` itself and the governance log's mirror, and refuses
  a page that shows `row.action` as its code; every new sentence is in the
  20 dictionaries (`console-i18n.test.ts`).

## 2.101 The chats' daily digest and why work stopped, in the owner's language (F10.6, §2.3 items 3 and 7)

Found by the live run of the analysis of 3 October (§2.3, items 3 and 7).
What PALUGADA says in a chat is in the owner's language (`say`,
`src/owner/say.ts`), except two things it said every day. The daily digest
was English whatever the owner read -- "Digest for", "Spend: 0.75", "Tasks:
... halted" -- its money a bare figure an Indonesian owner reads as rupiah,
and what stopped was the halt's code: "1 task(s) stopped: budget_exhausted".
The notice that work the owner gave has stopped said why as the code read
aloud: "Sebabnya: budget exhausted".

What changed:

- **Why, in words** (`haltSaid`, `src/owner/halt-said.ts`): every halt reason
  has the sentence the console gives it on the task ("Out of budget",
  "Kehabisan anggaran"), held as a record of every `HaltReason`, so a new
  reason does not compile without one. A failure with no reason is "Task
  failed".
- **The digest in the owner's language** (`renderDailyDigest`,
  `src/owner/digest-said.ts`). `buildDailyDigest` returns what stopped as
  data (`stopped`, by reason and count) rather than English lines, and the
  owner module says it: the spend in US dollars written the way the
  language writes them ("US$2,15"), as the console does since 2.98, and
  each halt by its sentence. A count stands after a label, because `say`
  has no plural forms. The worker's digest and its retry both use the
  panel's language.
- **Tested.** `reporting.test.ts`: the digest says "Spent: $2.15" and
  "Stopped (1): Out of budget" in English, and in Indonesian "US$2,15" and
  "Kehabisan anggaran" with no English and no code; `owner-channels.test.ts`:
  the stopped notice says "Kehabisan anggaran", not "budget exhausted"; every
  new sentence is in the 20 dictionaries in `src/owner/sentences/`.

## 2.102 Of two budget accounts on one scope, the same one pays every time (F1.6)

Found while checking 2.99: its test failed on one full run in several. The
owner may open a budget account on a division, project or role that already
has one -- "Ramadan promotion" under the division's Operations account --
and work there is charged to the narrowest account that covers it
(`accountFor`, `src/engine/budget.ts`). Narrowest was decided by the kind of
scope alone, so two accounts on one division tied, and the one charged was
whichever row the database read first. Every charge writes its account's
row again elsewhere in the table, so the same role's work could be charged
to one account and then the other, and a schedule could draw on either.

What changed:

- **The tree decides a tie.** Of two accounts on the same scope, the deeper
  in the tree is the narrower and pays; between two as deep, the older; and
  the id last, so there is always one answer. Task creation, schedules and
  the budget a role's page shows all ask `accountFor`, so all three agree.
- **Tested.** `budget-inheritance.test.ts` opens two accounts beside each
  other on one division and a third under one of them, rewrites each row in
  turn, and asks which pays after every move: always the same, and a task
  is charged to it. Before the change it gave the other account on some
  runs.

## 2.103 Why a task stopped is said in the owner's language, with what to do (§2.3 item 7)

Found by the live run of the analysis of 3 October (§2.3, item 7): a task
its budget stopped said, under **Why it stopped**, "shared budget exhausted"
-- the platform's own record of the halt, in English whatever the console's
language -- and the timeline printed it again, in red, under the event. Every
halt did the same: "delegation depth 4 exceeds hop_max 3", "an ancestor task
already runs this role with this input".

What changed:

- **What it means first** (`whyStopped`, `console/src/format.ts`). Every
  reason a task can stop has a sentence that says what happened and, where
  the owner can do something, what: "A service it needs failed its check,
  usually because a credential expired or a quota ran out. Fix it under the
  division's Capability health on Team, then do it again." The screens and
  buttons are named as each dictionary already names them. The platform's
  record is kept under **What the platform recorded**, closed. Work its run
  did not do still says the run's own reason (N9), and a task stopped by its
  budget keeps the card that says how to continue it rather than a second
  box saying the same.
- **A cancelled task says why too**: your approval not given in time, or the
  work it was started for cancelled.
- **The timeline** says a halt by its reason ("Out of budget") and keeps
  what a service or a check refused with as it put it, since that is the
  next thing to fix and cannot be translated (`eventDetail`).
- **Tested.** `console-halts.test.ts` reads every `HaltReason` in
  `src/domain/task.ts` and refuses one without an explanation, runs the
  console's formatting in Indonesian to see the record kept apart from what
  is said, and refuses a timeline that prints the record; every sentence is
  in the 20 dictionaries (`console-i18n.test.ts`).

## 2.104 A role is shown by its name and title, never by its code (§2.3 items 7 and 10)

Found by the live run of the analysis of 3 October (§2.3, items 7 and 10).
The template's roles are people -- "Arka, CEO", "Sari, Head of Data" -- but
the console showed the platform's short name for a role wherever a view
carried nothing else: "coordinator" on the work list, a task and **Lately**,
"strategist" on a schedule, the role's code on triggers, handoffs, frozen
roles, reviews waiting, standing approvals and the trace. The pickers the
owner chose a role from -- a schedule's, a trigger's, a handoff's, an
account's, a division's escalation, the work filter -- listed codes too, and
the kit's strategist and critic had nothing else: a bundle's roles were
installed with no name and no title. The money page listed every company by
its short name.

What changed:

- **A bundle's roles arrive as people** (`src/bundles/bundle.ts`): a bundle
  role's name and title are installed with it, as a template's are, and one
  the owner gave stays when the bundle is installed again. Every built-in
  role has both -- Bayu, Chief Strategy Officer; Citra, Strategy Critic;
  Putri, Researcher; and the rest -- so the built-in bundles move to new
  versions (company-os 1.5.0, content-ops 1.3.0, web-ops 1.3.0, qa-review
  1.2.0, palugada-dev 1.3.0), which a deployment publishes when it starts.
- **Every view names the role**: the work, schedules, triggers, handoffs,
  reviews waiting, standing approvals, frozen roles and a task's trace carry
  the name the owner gave the role beside its code, and the console shows
  the name. A picker lists "name · title" (`roleLabel`,
  `console/src/format.ts`), and a role's code only when it has neither.
- **A company by its name** on the money page.
- **Tested.** `role-names.test.ts` names a role and reads it back from each
  of those views over the owner API; `bundles.test.ts` holds that every
  built-in role has a name and a title, that installing the kit gives them,
  and that installing it again keeps the owner's; `console-role-names.test.ts`
  reads the console for a role's code put on the screen, in text, in a
  sentence or in a picker.

## 2.105 An approval in a chat names its action for what it does (§2.3 item 7)

Found by the live run of the analysis of 3 October (§2.3, item 7), after
2.96 named every capability in the console. An action the broker asks the
owner about is titled with the capability's code and its arguments --
"record.delete: recordId cust-042" -- and the console says "Delete a record:
recordId cust-042" in the owner's language; but Telegram, WhatsApp, push,
e-mail and the webhook chat sent the title as it was stored, so the phone
said the code, in English, and the reply prompt asked "What do you want to
ask about "record.delete: …"?".

What changed:

- **Named as the console names it** (`actionSaid`,
  `src/owner/capability-said.ts`). Where the platform builds a card for any
  channel -- a first delivery, a retry, the edit when an item closes -- a
  title or summary written as `capability: arguments` has its capability
  named in words in the owner's language; the arguments are the agent's
  and stay as they are. The Telegram and WhatsApp prompts for a question or
  an answer name it the same way. A capability the platform has no name for
  keeps its code: nothing is guessed.
- **One set of names.** The names are the console's, and
  `console-events.test.ts` holds the two the same; each dictionary in
  `src/owner/sentences/` has them as its console dictionary does. The test
  that reads `say(...)` calls now reads a literal as JavaScript does, so
  "a domain\'s records" is the sentence it names.
- **Tested.** `owner-channels.test.ts`: an approval to delete a record
  reaches Telegram and push as "Hapus data: recordId cust-042" for an
  Indonesian owner, with no `record.delete` in it, and one for a
  capability with no name keeps its code.

## 2.106 The owner reads money in their own currency, at a rate they set (F11.3, §2.3 item 3, §9 P1 item 13)

Recommended by the analysis of 3 October (§9, P1 item 13: "USD, with an
option to show rupiah"). 2.98 made every amount say it is in US dollars,
which ended the misreading of "0,75" as rupiah; but an owner who thinks in
rupiah still converted every amount in their head, and typed every ceiling
in a currency they do not think in.

What changed:

- **A currency to read money in** (0106, `src/domain/money-display.ts`): the
  owner chooses a currency and the rate to read it at, under **Settings**,
  **Languages**, **How you read money**. It is kept on `platform_control`
  beside the panel's language and follows them to every device. Both or
  neither; the currency must be one the platform knows and not the dollar,
  the rate a positive number. `GET` and `POST /api/control/money-display`.
- **Shown and typed in it.** Every amount the console writes is in that
  currency at that rate (`money`, `console/src/format.ts`), whole units once
  there are a hundred of them ("Rp12.375"); a ceiling and the daily-cost
  alert are typed in it and kept in cents (`centsFrom`, `typedFrom`); the
  cost chart is drawn in it. The **Money** page says which currency and
  rate it is reading, and that PALUGADA counts in dollars.
- **The chat's digest gives both**: "Terpakai: Rp35.475 (US$2,15)", since
  the rate is only the owner's.
- **Nothing is charged or stored in it**, and no rate is fetched: what the
  owner reads depends on no service the platform does not run, and keeping
  the rate current is the owner's.
- **The owner's assistant may propose it**, as it proposes the panel's
  language, for the owner to apply; no factor, since nothing is loosened.
- **Tested.** `money-display.test.ts`: the choice is stored and read back,
  an unknown currency, the dollar and a rate that is not above zero are
  refused and leave the choice as it was, and the digest says rupiah and
  dollars; `console-money.test.ts`: an amount is shown and typed in rupiah
  at the rate and kept in cents, and the money and settings pages turn what
  is typed into cents only through the rate.

## 2.107 The work, the money and the overview fit a phone (§2.3 item 8, §9 P1 item 13)

Found by the live run of the analysis of 3 October (§2.3, item 8), and
measured again in Chromium at 390 pixels before the change. Most owners of a
small business read PALUGADA on a phone. There, the work list showed 356 of
its 820 pixels: what a task serves, its progress and its cost were off to
the right in a box that scrolled sideways, which nobody discovers on a
phone, and the task's name was cut to fifteen letters; the five filters
above it ran off the screen, "Stopped" the one out of sight; the accounts
on **Money** showed 316 of 640, their money and the **Ceilings** button
hidden; the status of what is running on the overview was cut to
"BERJA..."; and a figure on the money page broke inside the number,
"US$200,0" over "0" -- "Rp3.300.0" over "00" for an owner reading rupiah.

What changed:

- **The work list on a phone** is one task to a row, with its name over two
  lines and its status, cost, progress, role and time under it; the filters
  are a list to choose from. The table stays on a wider screen.
- **The accounts on a phone** are one to a block, the **Ceilings** button
  beside the name and the tokens and the money under it, drawn by the same
  meters as the table (`TokenMeter`, `MoneyMeter`).
- **What is running** on the overview puts its progress under the task on
  a phone, so the status beside the role is never cut.
- **A figure is never broken.** On a phone a number in the strip of figures
  stays on one line and is drawn as large as its card allows, from the
  card's width and the number's length (`.kpi-value[data-figure]`); a figure
  that is a word still wraps.
- **Tested in a browser.** `console-phone.test.ts` signs in to the built
  console in Chromium at 390 pixels, in Indonesian with amounts in rupiah,
  and finds on the work, the money and the overview nothing wider than the
  screen, nothing scrolling sideways, no badge cut and no figure broken.
  Before the change it found the work table at 820 pixels, the accounts at
  640, the filters scrolling and "Rp 3.300.000" on two lines. Chromium is
  driven over its DevTools protocol with Node's own WebSocket
  (`test/helpers/browser.ts`), so nothing is added to the dependencies; the
  test skips where no Chromium is installed, and `PALUGADA_CHROMIUM` names
  one.

## 2.108 A number being typed is written the way the owner's language writes one (§2.3 item 3)

Found by the phone check of 2.107. Every figure on the money page was
written the owner's way -- "Rp 3.300.000" -- but the ceiling being typed
beside it read "Rp 3,300,000": every number input grouped thousands with a
comma and pointed decimals with a full stop, the English way, whatever the
owner reads. An Indonesian owner reads "3,300" as three and three tenths.

What changed:

- **Grouped and pointed as the language does** (`numberSeparators`,
  `console/src/format.ts`): every number input that groups thousands -- the
  monthly ceiling, an account's ceilings, the daily-cost alert, the rate of
  the currency the owner reads money in, a measure's start, target and
  value -- takes the language's own separators.
- **Tested.** `console-money.test.ts`: Indonesian groups with a full stop and
  points with a comma, English the other way, and no page or component
  groups a number by itself.

## 2.109 The team page gives a role its title, not its code beside it (§2.3 item 7)

Found by the phone check of 2.107, after 2.104. A role on **Team**, and its
drawer, was subtitled with its title and its code -- "Head of Quality ·
reviewer" -- and a role with no title by its model's tier. The subtitle is
the title, and nothing when there is none. `console-role-names.test.ts`
now also refuses a role's code put beside its name.

## 2.110 A gallery of everything the company produced (§9 P1 item 12)

Recommended by the analysis of 3 October (§9, P1 item 12; Paperclip keeps
every artifact in one gallery). A document a role wrote or an email it sent
was kept -- in the journal, as the step that committed it -- and shown on the
task that made it, but nowhere else: finding last week's newsletter meant
knowing which task wrote it.

What changed:

- **The gallery** (`galleryOf`, `src/owner/views.ts`; `GET
  /api/companies/:companyId/gallery`): every draft and email the company's
  tasks committed, newest first and thirty to a page, each with its title,
  the start of what it says without its heading, its words or its
  recipient, who wrote it by name, and what its task was asked. It is what a
  task's deliverables are, read across every task, redacted on the way out.
  The page marker is the owner's input on the way back, so it is read, not
  trusted.
- **Its own index** (0107): the steps a gallery shows, in its order, so a
  page of it does not walk every step the company ever took.
- **Results on Work**: a tab beside **Tasks** and **Tickets**, a card to a
  piece, one to a row on a phone; pressing one reads the whole of it, with
  **Copy the text** and **Open the task**.
- **Tested.** `gallery.test.ts`: what two tasks committed comes back newest
  first with who wrote it and its task; a draft that did not commit, a step
  with no document and another company's work are not in it; it pages from
  the last one shown; and a page marker it did not issue is refused.

## 2.111 The owner watches the work as it happens, and stops it where they see it (§9 P1 item 11)

Recommended by the analysis of 3 October (§9, P1 item 11; Paperclip and
Buzz both show work live). The console asked again every five to fifteen
seconds: a task finished, or waiting on the owner, sat as it was for as long
before the screen said so, and what was running had no way to stop it
except from inside its task.

What changed:

- **A live stream per company** (`GET /api/companies/:companyId/live`,
  `text/event-stream`): from the moment the owner looks, each event of the
  company is sent as it is written -- what happened and to which task,
  never what it carried, which is read the ordinary way and redacted. Each
  look reads a while back again and skips what it sent, since a transaction
  that began earlier can commit its events after later ones; a quiet stream
  says it is still there inside a proxy's idle limit; the API ends every
  stream when it closes rather than waiting for them.
- **The console reads it** with fetch, since an EventSource cannot carry the
  session's token (`live`, `console/src/api.ts`): one stream per company,
  shared by every panel, opened again after a drop, a little later each
  time. A panel reloads what an event touches (`useLivePulse`,
  `console/src/hooks.ts`), once for a burst: the overview, the work list,
  the inbox, and a task's timeline, transcript and output for its own
  events. The polling stays underneath, for a stream a proxy will not carry.
- **Stop on what is running now**: each task under **Running now** on the
  overview has a stop button that asks once -- "Cancel this task and
  everything it started?" -- and cancels it.
- **Tested.** `live.test.ts`: the stream refuses an owner not signed in,
  sends a task's moves as they happen and each once, sends nothing of
  another company and nothing an event carried, and ends when the API
  closes. `console-live.test.ts`: in Chromium, a task finished in the
  database moves under **Done** on the work list within four seconds,
  sooner than the list asks again; with the stream turned off it does not.

## 2.112 The platform's own inbox cards are said in the owner's language (§2.3 item 7)

Recommended by the analysis of 3 October (§2.3, item 7). The cards the
platform raises itself -- incidents, escalations, alerts, its approvals --
were literals in English at each place they were raised, with the
platform's codes inside them: "Role ops-coordinator is paused for spending
too fast", "spent 3120 of 20000 cents in the period beginning 2026-10-01",
"Task 9f3c... has been waiting_approval since 2026-10-02T03:14:00.000Z",
"Move the company from validate to build?". An owner reading the console in
Indonesian got English on the cards that matter most.

What changed:

- **Composed when raised, in the owner's language** (`src/owner/platform-cards.ts`):
  the month's pause and its 80% warning, a role spending too fast or frozen
  after refusals, a task waiting on nothing or taking its worker down, a
  service or a model that stayed down, a write that read back differently,
  a review that deadlocked or gave no verdict, a stage move proposed or
  stopped by a reviewer, a goal change, a schedule repeating itself, a
  capability failing its check, the batch guard, a run's question, and the
  reason on the broker's and the role eval's approvals. Each reads the
  owner's language, currency and clock from `platform_control` in the
  transaction that raises it.
- **Names, not codes**: a role by the name the owner gave it, a task by what
  it was asked, a capability as the console names it, a stage as the
  console names it, money in the owner's currency with the dollars after
  it, a moment on the owner's clock and the month's first day as the
  ceiling counts it. What a vendor, a check or another agent wrote -- an
  error, a reviewer's note, the evidence of a proposal -- stays as written,
  after the platform's own sentences.
- **An escalation's notes too**: who was asked first and for how long, why
  the role it was meant for could not be given it, and what that role did,
  said by the role's name. The note is kept on the item as the owner read
  it, so it can be taken off again in any language.
- **The push digest** is headed by the digest's own first line, which is in
  the owner's language, rather than "Digest for".
- **Tested.** `platform-cards.test.ts` (acceptance): with the console in
  Indonesian, rupiah at 16,500 and Jakarta's clock, the pause says "Rp
  3.300.000 (US$200,00)" and no cents or ISO date; the rate card names the
  role "Sari" and never its code; a stranded task is named by its goal at
  10.14 Jakarta time, without its id or status code; a run's question and a
  goal change are headed in Indonesian. `platform-cards.test.ts`
  (documents): every call in `src/` that raises a card passes no literal
  title, detail, rationale or consequence -- it named all twenty sites
  before the change -- except `proposeStructuralChange`, which nothing
  outside the tests reaches. The sentence scan in `owner-channels.test.ts`
  now reads a sentence ending in a question mark as a sentence, not as a
  ternary's condition.

## 2.113 A bundle's skills are reviewed once and asked about on one card (B9)

Found by the analysis of 3 October (step 4 of the first hour, defect B9). A
company made from company-os opened with eleven skill cards in the owner's
inbox, in English, before they had asked for anything, each after a
reviewer run of its own -- about 198 thousand tokens on the first day's
paperwork. The owner chose (3 October): one review of a bundle's skills
together and one card for the bundle, with nothing switched on without their
yes.

What changed:

- **One batch per install** (0108): the skills a bundle brings, their checks
  and their quarantine marks are written in one transaction, each version
  carrying the install's `batch` and the bundle's name, so a worker finds the
  whole batch or none of it.
- **One review**: each is still screened against its own checks (F15.5);
  those that pass go to the reviewer as one task that reads every document
  as data and answers for each by its slug (`SKILL_BATCH_REVIEW_CRITERIA`).
  A skill the review gives no verdict on is turned down, as a review that
  ends without one always was. A version proposed on its own is reviewed on
  its own, as before.
- **One card**, in the owner's language: "Skills the bundle "…" brings: 10",
  each skill with what it is for and what the reviewer said of it, and the
  ones it turned down with why. Approve switches on every one still waiting;
  deny turns them all down with the owner's note. Any of them can be decided
  on the Skills page instead; the card stays while one is undecided and goes
  when none is. A single skill's card is said in the owner's language too.
- **The console** links a bundle's card to **Read the skills**.
- **Tested.** `skill-batches.test.ts`: company-os's eleven skills are
  screened and given to one review; one card asks about the ten it approved,
  in Indonesian, naming the eleventh and why; the owner's yes switches on
  the ten except one turned down on the Skills page first; their no turns all
  down with their note; and approving each on the Skills page withdraws the
  card after the last.

## 2.114 The owner's first hour with a new company is guided (§9 P1 item 10)

Recommended by the analysis of 3 October (§9, P1 item 10; Paperclip walks a
new owner from an interview to a plan to a first task). A company started
from the console opened on an Overview of zeros: no conversation, no first
piece of work, nothing that said what to do next, and a CEO that could not
speak until spoken to. Its schedules ran on UTC, so the Monday review came
at 07:45 UTC.

What changed:

- **The CEO speaks first.** Starting a company records the CEO's opening
  message in the language the owner reads (`firstHourOpener`,
  `src/owner/first-hour.ts`): what it sells and to whom, how much it may
  spend in a month, and what its first piece of work should be. The
  console opens the conversation once the company is in the list. The
  model is told what it asked, since a conversation sent to it still
  starts with the owner.
- **It interviews, then proposes.** While the first hour lasts, the CEO is
  told to get those answers in at most three questions and then propose
  together, as cards: the mission reworded in the owner's words, the
  monthly ceiling, and one first piece of work that gives the owner
  something real to read within the hour.
- **Four steps on the Overview** (`GET /api/companies/:companyId/first-hour`,
  0109): tell the CEO what it sells, set the monthly ceiling, give it its
  first piece of work, read its first result -- each ticked off by what the
  owner has done (a message to the CEO, a ceiling set, a task they gave,
  one of theirs completed), each with the button that does it. It goes
  when all four are done or the owner closes it
  (`POST .../first-hour/close`), which also ends the interview. Every
  company that existed before, and every restored one, is past its first
  hour.
- **A ceiling records when it was set** (`spend_limits.set_at`), so "set
  the ceiling" is a choice somebody made, not the row a pause leaves.
- **The owner's clock**: the console sends its browser's time zone when it
  starts a company.
- **Tested.** `first-hour.test.ts`: a company started through the API opens
  with the CEO's message in Indonesian and four undone steps; a message, a
  lowered ceiling, a task and its completion tick them off one by one and
  close the list; closing another ticks nothing off; the CEO's model is
  spoken to first by the owner, is told what it asked, interviews while
  the first hour lasts and stops once it is closed.

## 2.115 PALUGADA installs, and updates, in one command (§9 P2)

Recommended by the analysis of 3 October (§5.2 item 1, §9 P2; the owner
chose it first among P2 on 3 October). Installing took git, Node,
`npm install`, an interactive `npm run setup` and Docker; Paperclip installs
with one command, with update and rollback, and Buzz offers a hosted one.

What changed:

- **`install.sh`**, run as `curl -fsSL …/install.sh | sh`, needs Docker
  alone. It fetches PALUGADA into `~/palugada`, writes `.env` once with a
  new password for each database role (readable by its user alone), runs
  `docker compose up -d --build`, waits until `/api/health` answers, and
  prints the claim link the platform prints while it has no owner, on the
  port published here. The owner adds the authenticator app there and
  chooses the model in the console, which `npm run setup` would have asked.
- **Run again, it updates**: the same `.env`, the same volumes, and a copy
  of the database in `backups/` before anything changes; if the copy
  fails, nothing is updated.
- **Safe under a pipe**: the script is one function called on its last line,
  so the shell has read all of it before anything runs, and a command that
  reads standard input cannot read the rest of the script.
- **Tested.** `install.test.ts`, with Docker and curl as stand-ins that
  record what they were asked: a first run writes four 36-character
  passwords to a file of mode 600, builds, waits for the console and
  prints the claim link on the published port; a second keeps the
  passwords and copies the database before it builds; fed through a pipe
  slowly, as a download arrives, it still runs to the end (the same test
  fails against the script before it was one function); with a Docker
  that does not answer it says so and writes nothing. The containers it
  starts are what `npm run container:check` runs in CI.
- **Not done**: a `doctor` that repairs, release channels and a rollback
  command. A failed update is rolled back by hand from the copy
  (`gzip -dc backups/… | docker compose exec -T db psql -U postgres palugada`
  on an emptied database), which [operations](guide/operations.md) covers.

## 2.116 Staff seats beside the one owner: a viewer, and an approver for tier 2 and below (§9 P2)

Recommended by the analysis of 3 October (§9 P2 item 18: "viewer, and an
approver for tier ≤2; tier 3 stays the owner's"), and chosen by the owner
on 3 October. PALUGADA had one human, and a session could not tell people
apart: any enrolled authenticator passed the owner's second factor and the
tier 3 gate as the owner's. Paperclip and Buzz both have roles and invites.

What changed:

- **A seat is kept apart from the owner's factors** (0110,
  `src/owner/staff.ts`). It has its own authenticator (its TOTP secret
  sealed by reference, its steps used once) and its own sessions, in tables
  only the control plane reads, and nothing that verifies the owner --
  sign-in's second half, every `#requireFactor`, the tier 3 gate -- reads
  them. A staff member's code offered as the owner's is refused as a wrong
  code; at sign-in a seat's code is tried first, so a staff member signing
  in never counts against the owner's lockout.
- **A seat is one company's**, made by the owner with their device under
  **Settings**, **People**, with an invite good for a week and spent by
  joining. Like the owner's own claim, each opening of the invite is shown
  a secret derived from the master key, the seat and a random value the
  page carries, kept nowhere until a code from it is confirmed.
- **Everything not listed is refused** (`src/owner/staff-policy.ts`): both
  kinds read their company's pages and nothing of another company or of
  the deployment; an approver also decides, answers and batch-decides the
  inbox. `decide` refuses a seat any tier 3 item, yes or no, and any yes
  for a while; the item records `decided_by_seat`, and its events are the
  actor `staff` with the person's name. Ending a seat signs it out at once
  and withdraws an unused invite.
- **The console** asks `GET /api/me` who signed in, and for a seat leaves
  out the owner's controls -- New, Talk to the CEO, Ask PALUGADA, Stop
  everything, Settings, This deployment, the tour, the cross-company
  search, and starting or restoring a company on Home -- and on a card it
  may not decide, says why instead of drawing buttons. A seat's actions read as "A staff member" on the timelines.
- **Tested.** `staff.test.ts`: a viewer joins, reads its company and no
  other, and is refused the owner's routes; an approver decides tier 2 and
  is refused tier 3 either way and a yes for a while, and the record names
  them; a staff code is refused as the owner's factor and at the tier 3
  gate inside the owner's session; ending a seat signs it out and spends an
  unused invite. `console-staff.test.ts`: in Chromium, an approver joins
  from the invite, sees one company without the owner's controls, approves
  a tier 2 card and is shown that tier 3 is the owner's, where it lands and
  on Home (with the shell's staff mode turned off, the console cannot even
  load for the seat). The suite found Home still offering a seat **Start a
  company** and **Restore from an export**, whichever page the seat landed
  on first; the test now opens Home itself.
  `staff-routes.test.ts`: every read is given to staff or kept from them
  with a reason, and the approver's actions are the inbox's alone.
- **Not done**: a seat in the Telegram or WhatsApp chats, a passkey for a
  seat, and a seat over several companies.

## 2.117 Customers write to the company on Telegram, and every reply waits for the owner (§9 P2)

Recommended by the analysis of 3 October (§9 P2 item 19: "a mailbox and the
customers' WhatsApp/Telegram, with a reply as a tier 2 action"), and chosen
by the owner on 3 October. A company could answer its owner on Telegram and
WhatsApp and could not answer a customer anywhere: `email.send` waited for
a vendor, `mailbox.read` had no adapter, and nothing heard what a customer
wrote.

What changed:

- **A conversation, whatever carries it** (0111, `src/chats/`): a
  channel, one customer's chat on it, and what was said both ways. Telegram
  is the first transport; WhatsApp and a mailbox are further kinds of the
  same channel.
- **The owner connects a bot of the company's own**, with their device, on
  **Customers** (`POST /api/companies/:companyId/chat-channels`). The token
  is checked with Telegram's `getMe` before anything is kept, then sealed
  under a name of its own (`db://chat-…`, which a division's credential may
  not name), and the secret Telegram is given with `setWebhook` is kept only
  as its SHA-256. A bot answers for one company at a time; connecting it
  again reopens the same channel at a new address with a new secret, and
  the token it replaces is deleted. The role that answers gets `chat.read`
  and `chat.send`, as grants on its division and as tools, each recorded as
  a structural change the owner made.
- **Only Telegram, and only a customer, is heard**
  (`/api/chat-hooks/:publicId`): a delivery without the secret is refused
  and recorded as `security.chat_refused`; a group the bot was added to and
  another bot start nothing. A message is claimed by its id before anything
  else, so Telegram sending it again starts nothing more; one written while
  the conversation's work is still waiting for a worker joins that work;
  past the channel's hour a message is kept and starts no work
  (`chat.rate_limited`).
- **What a customer writes is data, and every reply is the owner's.** The
  message reaches the run in the untrusted envelope and the work is begun
  from outside (F8.9), so `chat.send` (tier 2) asks the owner -- or an
  approver seat -- each time, and a standing yes does not cover it. The run
  is told to read the whole conversation with `chat.read` first and to
  answer in the language the customer writes in, the company's when it
  cannot tell. Both capabilities name the conversation the work began with
  by themselves, and answer only a conversation a customer started.
- **A reply is sent once.** `chat.send` keeps the reply under the broker's
  key before it is sent, so a step resumed after its worker stopped finds
  the reply it already sent (the owner is asked again, as for any yes a
  stopped step spent, and nothing is sent twice). It is read back as
  Telegram answered it, since a bot cannot fetch what it sent.
- **The console**: **Customers** lists the conversations, latest first, with
  those waiting for an answer marked, and each one whole; the channels,
  with **Connect a Telegram bot** and **Close**. A card asking to send a
  reply shows the conversation beside it. A seat reads both pages.
- **Closing** takes the webhook off, deletes the token and leaves the
  conversations. A closed company's erasure deletes its bots' tokens with
  its divisions' keys. An export carries channels without their address,
  secret or token, and their conversations whole; a restored channel waits
  closed for the owner to connect the bot again.
- **Tested.** `customer-chats.test.ts`, against a stub of the Bot API: a
  connection needs the device and seals the token; a customer's message
  starts work begun from outside, a resent one starts nothing, a second
  joins the waiting work, a forged one is refused and recorded, a group is
  ignored; the run reads the conversation, its reply waits for the owner
  and is sent once, also when the step is done again; the owner reads it
  all; closing lets the bot go; a token Telegram does not know, a role of
  another company and a second company for the same bot are refused with
  nothing kept; past the hour a message is kept without work; without a
  public address the owner is told; a restore is closed, at a new address,
  with its conversations. `company-closing.test.ts`: erasing a company
  deletes its bot's token and only its.
- **Not done**: WhatsApp and a mailbox (the next transports), pictures and
  voice notes read by the run (they are kept as what they were, and the run
  is told it cannot read them), and retention for conversations, which are
  kept as long as the company is.

## 2.118 Customers write on WhatsApp too (§9 P2)

The second transport of 2.117, for the channel most Indonesian shops' customers
use. A company's WhatsApp Business number, through Meta's Cloud API, keeps
every rule of the Telegram bot and adds WhatsApp's own.

What changed:

- **A number is connected with its keys** (0112,
  `POST /api/companies/:companyId/chat-channels` with `kind: whatsapp`): the
  phone number ID, a system user's token and the Meta app's secret, checked
  with Meta (the number's name and digits) before anything is kept, both
  keys sealed under names of their own. Meta's webhook is set in the app,
  not by an API call, so the answer is the callback address and a verify
  token -- shown once, kept as its hash -- to paste there; Meta's check of
  the subscription is answered on `GET /api/chat-hooks/:publicId`. Refused,
  before anything is kept, when the deployment has no public address.
- **Only Meta, and only this number, is heard** (`src/chats/whatsapp.ts`):
  a delivery is checked against the app secret's HMAC over the bytes that
  arrived; one for another number of the same app, a reaction, a status or
  a type the platform does not know starts nothing. A picture, a voice note,
  a video, a file, a sticker, a location or a contact is kept as the same
  kind of thing Telegram's would be, with its caption. Several messages in
  one delivery are taken in the order they came, so the second joins the
  work the first started.
- **A reply goes from the number, within WhatsApp's window**: `chat.send`
  posts plain text with no link preview, and refuses a reply more than 24
  hours after the customer's last message before anything is sent, since
  WhatsApp accepts that call and reports the failure later in a status.
- **The console** asks Telegram or WhatsApp when connecting, shows the
  callback address and verify token to copy once, and shows a number as
  customers dial it (`+62…`) and its `wa.me` link, where a bot is `@name`.
- **Closing** deletes the token and the app secret; erasing a company
  deletes both; an export carries the number's ID, never its keys.
- **Tested.** `customer-whatsapp.test.ts`, against a stub of the Graph API: a
  token Meta refuses is refused; a connection seals both keys and keeps the
  verify token only as its hash; Meta's subscription check is answered for
  the verify token alone; an unsigned or wrongly signed delivery is refused
  and recorded; a message starts work begun from outside, a resend starts
  nothing, a picture joins the waiting work, another number and a reaction
  start nothing; the run reads both; the reply waits for the owner and goes
  to the customer's number; a day after the customer last wrote, a reply is
  refused before anything is sent; closing forgets both keys; without a
  public address the connection is refused with nothing kept.
  `console-customers.test.ts`: the number is shown as `+62…` with its link,
  and the form asks for what Meta gives. `company-closing.test.ts`: erasing
  a company deletes its number's token and app secret, and only its.
- **Not done**: the mailbox (the next transport), a failure WhatsApp reports
  later in a status (it is not yet shown on the reply), and a template to
  write first after the window.

## 2.119 Customers write to the company's own mailbox too (§9 P2)

The third transport of 2.117, and the last item 19 names: "a mailbox". Every
small business has one, and it is where a supplier, a bank and most
customers outside chat write. `mailbox.read` has been catalogued with no
adapter since the start, and still is: what customers write reaches the
work through the channel and `chat.read`, as the other transports' does.

What changed:

- **A mailbox is connected with its servers and password** (0113,
  `kind: email`): the address, the IMAP and SMTP hosts and ports, and the
  password -- or the app password Gmail asks for -- which is sealed. Both
  servers are signed in to before anything is kept, so a wrong password is
  said while the owner is at the form, and the reading starts after the
  inbox's last message: the mail the mailbox already holds is never taken
  for work.
- **The workers read it** (`src/chats/mail.ts`, the `mailboxes` stage of the
  tick): each open mailbox about once a minute, claimed in the database so
  two workers never read one at once, the new messages oldest first, twenty
  at most a reading. A server that renumbers its messages (a new
  UIDVALIDITY) is read from the start of now again. A reading that fails is
  kept on the channel for the owner -- **Could not read the mailbox** -- and
  said once as `chat.mailbox_failed`; the mail waits on the server.
- **IMAP and SMTP, written here** (`imap.ts`, `smtp.ts`), like the other
  transports, and over TLS only: IMAP on its TLS port, SMTP on 465 or
  upgraded with STARTTLS, and refused when a server offers neither. A
  message is fetched with `BODY.PEEK` (left unread in the owner's own
  mail app) and only its first 256 KB.
- **A message is read as a person reads it** (`mime.ts`): its sender's name
  and address, its subject and text through encoded words, quoted-printable,
  base64, charsets and multipart (plain text before HTML), what was attached
  as the kinds the other transports use -- and without the history a reply
  quotes ("On ... wrote:", Gmail's Indonesian "Pada ... menulis:", lines
  quoted with ">"). An auto-reply, a bounce, a list and the mailbox's own
  mail are not a customer and start nothing (RFC 3834's Auto-Submitted,
  Precedence, List-Id, MAILER-DAEMON and no-reply addresses).
- **A reply is a reply**: `chat.send` sends plain text from the mailbox's
  address with "Re:" the customer's subject, In-Reply-To and References
  naming their message, so it lands in their thread; its Message-ID is the
  one their answer will name. The run sees each message's subject.
- **Kept and carried** like the other channels: closing deletes the sealed
  password; an export carries where the mailbox is and every message's
  subject, never the password or the reading's position.
- **Tested.** `customer-mail.test.ts`, against an IMAP server over TLS and an
  SMTP server that requires STARTTLS, both written for the test with a
  certificate made by openssl: a message is read with its sender, subject,
  ISO-8859-1 quoted-printable text, attachment and without its quoted
  history, an HTML-only one as its text, and an auto-reply, a bounce and a
  list as no customer; a wrong password is refused with nothing kept; the
  mailbox's history is left alone; a customer's mail starts work and the
  others nothing; a mailbox is not read twice in a minute; the reply waits
  for the owner and goes over STARTTLS as a reply in the thread; the answer
  to it, quoting it, is read as what was written; a password changed at the
  provider is shown on the channel and said once, and the mail that waited
  is read once it is mended; export and restore; closing stops the reading.
  A worker reads the mailboxes in its tick, and one kept to another
  company does not.
- **Not done**: OAuth sign-in for Gmail and Microsoft 365 (an app password
  for now), an attachment's contents, and IMAP IDLE (a minute's delay).

## 2.120 Releases are tagged, and a merge queue keeps main green (§9 P2)

Recommended by the analysis of 3 October (§9 P2 item 21, "tagged releases
and a merge queue"; the owner chose releases with the live browser). There
had never been a release: `0.1.0 (not yet released)` since the first
commit, an install that could only follow main, and no image anyone could
pull. And nothing stopped two pull requests that each passed against an
older main from breaking it together, which is how Buzz's main went red
(#8036).

What changed:

- **A version is one number in three places**: `package.json` (with the
  lockfile), which a running deployment reports; the newest CHANGELOG
  section; and the tag. `release.test.ts` fails the suite when the first
  two disagree, when a section other than the newest is undated, or when
  the sections are out of order.
- **`scripts/release.ts`** moves them together. `prepare <version>` dates the
  unreleased section, sets both files and commits `Release <version>`, to be
  merged like any change; `tag <version>`, on main afterwards, makes the
  annotated tag, refusing a working tree with changes or a commit that does
  not agree. Two steps because a pull request merged through a queue lands
  as another commit, and a tag made before would name one main never held.
- **A pushed tag is a release** (`.github/workflows/release.yml`): the tag,
  both files and a dated section agree and the commit is on main; the whole
  of CI runs on it, as a called workflow; then the image is pushed to
  `ghcr.io/<owner>/palugada:<version>` and `:latest` with the docker CLI,
  and the GitHub release is made with the CHANGELOG section as its notes.
  Its only write permissions are in that last job, and every action is
  pinned to a commit.
- **The merge queue**: CI runs for `merge_group`, the candidate main would
  become, and no longer twice for the queue's own branches. Turning the
  queue on is a repository setting, which
  [docs/RELEASING.md](RELEASING.md) gives with the required checks.
- **The installer installs a release**: `PALUGADA_VERSION=v0.2.0` fetches
  that tag instead of main, to update to it or to go back to it, and
  anything that is not a tag's shape is refused before a download, since it
  becomes part of a URL. Going back works because the platform starts on a
  database a later version migrated (migrations only add).
- **Tested.** `release.test.ts`: the repository's own version and sections
  agree; `prepare` on a copy dates the section and moves both files, and
  refuses a version that is not three numbers, one not after the last
  release and a CHANGELOG with nothing unreleased; `check` refuses an
  unreleased section and a tag that names another version; the notes are
  the section; in a real git repository, `prepare` commits and tags nothing
  (the test fails against a `prepare` that tagged), `tag` refuses a
  changed tree and a version the commit does not hold, and makes an
  annotated tag on the commit checked out; the workflows hold the triggers,
  the checks and the pins. `install.test.ts`: a version fetches its tag's
  tarball, and `main; touch pwned` is refused with nothing downloaded. Both workflows pass actionlint 1.7.12; neither has run on
  GitHub yet.
- **Not done**: the first release itself, which is the owner's to cut, and
  the queue's repository setting, which is the owner's to turn on. The
  release workflow has not run on GitHub, so the first tag is also its
  first test.

## 2.121 Each company has a browser of its own (§9 P2)

Recommended by the analysis of 3 October (§9 P2 item 20, "a live browser
that can be taken over, for marketplace seller centres and government
portals") and the tools research of the same day (§6 item 2:
`browser.read` at tier 0 and `browser.act` at tier 2, on Chromium); the
owner chose it with releases. A small company in Indonesia runs on sites
with no API it can get -- Shopee's and Tokopedia's seller centres, Coretax,
OSS -- and a role could reach a browser only through an MCP server whose
every click was tier 3, set by hand. This is the first half: the browser
and what a role does with it. Watching it live and taking it over is the
next.

What changed:

- **`browser.read`** (tier 0, outside content) opens a page, or follows a
  link from the last reading in the same tab, and returns it as a person
  sees it: its text without what is hidden (cut at 12,000 characters, and
  saying so), and up to 150 links, buttons, fields, lists and boxes, each
  with a ref, its kind, its name as a screen reader would give it, a
  field's value (never a password's), a list's options, a box's state.
- **`browser.act`** (tier 2, calibrated like `email.send`) does steps on
  that page -- type, choose, tick, untick, click, press -- and reads it
  again. Each act is a card: the work read a page, so F8.9 asks the owner,
  and the card says each step in symbols that read the same in every
  language, `Nama: "Sari"; Kota → Bandung; ☑ Setuju; ▸ Kirim`, from a new
  `summarize()` a capability may give the broker where its arguments
  listed one by one would not say it. Before anything is done, the tab
  must still be on the page the steps were written for and each element
  must be the one the step names; a step refused after others were done
  stops there and the read-back counts the act as not done (F8.4). A
  dialog is answered no unless the card said yes (`✓ OK`), a page's window
  is closed, nothing is downloaded or uploaded, and a role never types a
  password.
- **One Chromium, on a pipe** (`src/browser/cdp.ts`): started when a role
  first needs it and closed after ten minutes unused, driven over
  `--remote-debugging-pipe` so no other process on the machine can reach
  it, with Chromium's background calls switched off -- updates, Google's
  suggestions, Chromium 141's check of its AI search mode, each seen
  through the proxy until it was. Its sandbox is on unless the deployment
  says `PALUGADA_BROWSER_SANDBOX=off`, which every boot repeats.
- **Every request through the platform's proxy** (`egress.ts`), under the
  rules `web.fetch` is held to (F12.9): a page's pictures, scripts,
  fetches and redirects, not only the address a role named, with no
  exception for loopback and with Chromium resolving no name itself, so a
  name is checked where it is resolved and connected to as checked. A page
  refused is said with its reason, not Chromium's error.
- **One context per company** -- cookies, storage and cache of its own --
  with a tab for each piece of work, four companies open at once and the
  least lately used closed for a fifth; a page's script runs in a world of
  its own, so the page cannot change what it reads.
- **Sign-ins kept sealed** (`cookies.ts`): a company's cookies are sealed
  under the master key after each use, as `browser-<company>`, which no
  division's credential may name; they come back for the next task, after
  a restart, on any replica, session cookies included. Not handed to the
  redactor, which would hold every version for the life of the process;
  written only while the company is there and not closing, so a browser
  closing after an erasure cannot seal them again; and erased with the
  company.
- **The company's language and time zone** are what sites are told:
  `Accept-Language`, the locale and the clock.
- **Tested.** `browser.test.ts`, against a real Chromium and a seller centre
  written for the test on 127.0.0.1 beside a secret on 127.0.0.2: a page is
  read with its links and refs and without its hidden text, and the read
  taints the work; a link that asks for a new tab is followed in the same
  one, and a ref from an earlier page is refused; the page's picture and
  fetch to the secret, the metadata address, `file:` and a redirect inside
  are all refused, and the secret is never reached (the test fails with
  loopback left to Chromium's own exception); a long page is cut and says
  so. A form's act asks the owner with its steps on the card, sends
  nothing before the yes, then types over what was in the field, chooses,
  ticks and submits, reads the answer and is verified; acting again on the
  answer page, on another page, with a name that is not the element's or
  an option it does not have is refused with nothing sent; a confirm is
  answered no, and yes when the act said so. A sign-in survives the
  browser closing, is another company's in no way, is sealed without its
  value in the clear, comes back after its company's browser was closed
  for another's, and is not kept for a company that is closing.
  `company-closing.test.ts`: an erasure deletes the company's cookies and
  no other's (it fails without that line).
- **Not done**: the owner watching the browser and taking it over to sign
  in, which is the next section; frames, and lists a page draws itself
  rather than as a `<select>` (clicked open instead); a page's local
  storage, which a few sites keep a sign-in in; a browser shared between
  replicas, which each have their own Chromium and the same sealed cookies.

## 2.122 The owner watches the company's browser, and takes it over (§9 P2)

The second half of 2.121, and what item 20 names: "a live browser that can
be taken over". A seller centre and a tax portal want a person: a password,
a code sent to the owner's phone, a puzzle. A role never types a password,
so until now a role that met a sign-in could only stop.

What changed:

- **Browser**, a page of each company in the console, the owner's alone:
  each piece of work's tab, named by the work, shown as a picture of the
  page taken again about once a second while it is in front, at any width
  down to a phone's.
- **Taking it over** takes the owner's device (`/browser/take-over`): a
  signed-in browser is the company's accounts. While the owner holds it,
  the company's work waits -- `browser.read` and `browser.act` park as busy
  and come back a minute later -- on every replica, because the hold is a
  row (0114) rather than a flag in one process. What the owner presses on
  the picture is pressed on the page at that point, a wheel scrolls it,
  what they type is typed into the field the page selected, and Enter, Tab,
  Backspace, Escape and the arrows are buttons. They can open an address in
  the work's tab, under the same rules as any page. A hold nobody touches
  for fifteen minutes lapses, so a console left open does not stop the
  company.
- **What the owner types goes to the page and nowhere else**: not an
  event, not the journal, not a log. That they took the browser over and
  gave it back is recorded (`browser.taken_over`, `browser.given_back`).
- **Giving it back** seals what they signed in to for the company's work
  (2.121), closes their own tab, and answers every role that asked.
- **`browser.handover`** (tier 0) is how a role asks: a question, as
  `owner.ask` is, whose card says what to do -- "Masuk ke seller centre:
  kodenya dikirim ke HP Anda" -- and opens the browser on that work's page.
  The work waits; giving the browser back answers it, and the role reads
  the page again, signed in.
- **Owner only**: a staff seat neither sees the page nor its pictures, and
  the assistant neither takes the browser over nor reads its pictures.
- **Tested.** `browser-live.test.ts`, against a real Chromium: a role finds
  it is not signed in and asks; the owner sees the work's tab with its
  title and work and a JPEG of 1280 by 800; input before a take-over is
  refused (409), a take-over without the device too (403); while held the
  role's read parks with a time to come back; the owner cannot open the
  metadata address, opens the sign-in in the work's tab, types the address,
  Tab, the password and Enter, and the site receives them; a click lands
  where it was pressed and one off the page is refused; given back, the
  role's question is answered and its next read is signed in; the password
  is in no event and no card. A hold left alone fifteen minutes lapses and
  the work goes on, and a hand-over needs a reason.
  `console-browser.test.ts`, in the built console at a phone's width: the
  card opens the browser on that work, whose picture is drawn within the
  screen; the owner takes it over with a code and gives it back, which
  answers the role.
- **Not done**: the live view is the tabs of the process the console's
  request reached, so with more than one replica the console needs to
  reach the one the work ran on (sticky sessions); pictures, not a video
  stream; a page's files neither uploaded nor downloaded.

## 2.123 The image runs the browser, with Chromium's sandbox (§9 P2)

2.121 and 2.122 needed a Chromium on the machine, and the image -- what the
one-command install, Compose, Coolify and Dokploy all run -- had none. And
a browser that reads strangers' pages is the one part of the platform most
likely to meet an exploit, so it should run with the sandbox Chromium keeps
each rendered page in; without it, a page that breaks out of its renderer
runs as the platform's user, beside the master key.

What changed:

- **The image has Chromium**, Debian's (154, with Debian's security
  updates), and `fonts-liberation`, whose letters are as wide as the ones
  pages ask for: about 270 MB more. `--build-arg PALUGADA_BROWSER=0` leaves
  them out, and the browser is unbound and the boot says so.
- **It runs sandboxed.** Under Docker's default seccomp profile, Chromium
  cannot make the user, PID and network namespaces its renderers go in,
  and will not start without `--no-sandbox` -- tried here with Docker 29 as
  the `node` user; Debian's setuid helper (`chromium-sandbox`) fails the same
  way, since even root in a container cannot make them without
  CAP_SYS_ADMIN. So the compose files give the container
  `deploy/docker/seccomp-chromium.json`: Docker's own profile, from
  moby/profiles at a pinned commit whose hash `scripts/seccomp-chromium.ts`
  checks before it writes the file, with `clone` and `unshare` allowed --
  what the kernel allows any unprivileged user outside a container.
  `browser-sandbox.test.ts` holds the profile to that: the default refuses,
  one rule is the platform's and it is the last, and Docker's refusals of
  mount, setns, bpf, module loading and the rest stand.
- **CI checks it where it runs**: the docker job starts the stack with the
  profile and runs `scripts/browser-check.ts` inside the container, which
  passes only when a page has rendered in a process in a user namespace of
  its own -- not merely when a browser started. Run here against the image
  built from this commit: four renderers, four in namespaces of their own;
  the same check without the profile refuses with what to do.
- **A refusal says what to do**: Chromium's own first sentence, then either
  the profile to give the container, or, as root, to run the platform as
  another user, or `PALUGADA_BROWSER_SANDBOX=off` where that is understood.
- **Not done**: Coolify's path to the profile is the repository's, as its
  build context is, and has not been tried on Coolify; a host whose
  AppArmor forbids user namespaces (Ubuntu 23.10 and later, by default)
  may still refuse them to the container, and the browser then says so on
  the first page; CJK and other scripts DejaVu and Liberation do not cover
  draw as boxes.

## 2.124 The installer checks an install, mends it, and goes back a version (§9 P2)

The rest of item 17: "a `doctor` and an `update` that can be rolled
back". 2.115 left both out, and 2.120 gave releases a version to go back
to; what an owner without a terminal habit needs is one command that says
what is wrong, and one that undoes the last update.

What changed:

- **`install.sh doctor`**, from the copy the installer keeps beside what it
  installed: Docker answers; `.env` is there and the owner's alone; the
  database and the platform run; the console answers, with its version, and
  says its worker goes round (`/api/health`, read even when it says no, for
  what it says); the browser starts sandboxed (`browser-check.ts`, in the
  container); the disk has 2 GB free; and which copy of the database is
  newest. It mends only what cannot lose anything -- `.env` made the
  owner's again, a stopped container started without a rebuild, then
  waited for -- names the rest with what to do, and exits with an error
  while anything is wrong. The published port is read from `.env`.
- **An update keeps the code it replaces** as well as the database, both
  under one moment's name in `backups/`, without `.env` or the copies
  themselves; two in one second wait for the next rather than writing over
  each other.
- **`install.sh rollback`** takes a copy first, puts back the code of the
  newest copy, rebuilds and waits for the console. The data stays: the
  earlier version runs on a database a later one migrated, and taking it
  back too loses what was done since, so the command for that is printed,
  naming the copy from the same moment, not run. Run again, it undoes
  itself.
- **Tested.** `install.test.ts`, with Docker and curl as stand-ins: an
  update keeps the code (with what was there, without `.env` or `backups/`)
  and the database at one moment; rollback restores the earlier file,
  keeps `.env`, rebuilds once, takes one more copy of the database, restores
  none, and names the right copy to restore (it named the newest until the
  moment's name stopped being shared between the two); rollback with
  nothing to go back to changes nothing; an unknown word is refused; doctor
  mends a loosened `.env` and a stopped platform, and names a console that
  does not answer and a browser that cannot sandbox. Run here against a real
  stack built from this branch: all well, a loosened `.env` mended, and a
  stopped platform started and found answering.
- **Not done**: installing without Docker, and a hosted instance.

## 2.125 With no reader chosen, the deployment's browser reads pages (tools research, recommendation 4)

`docs/RESEARCH-TOOLS-2026-10-03.md` found that every `web.extract` went to
a third party that saw the address, and recommended a local reader and a
self-hosted Firecrawl. A deployment with a Chromium (2.121, 2.123) already
has the local reader: it reads a page as a person sees it, scripts and
all, which a library parsing the HTML does not, and adds no dependency.

What changed:

- **`web.extract` is the browser's** when no provider is bound and the
  deployment has a Chromium (`webExtractByBrowser`,
  `src/capabilities/browser.ts`): same name, schema and output, adapter
  `extract:browser`, tier 0, `readsOutside`. A provider the owner chose is
  used instead, and one chosen but not usable (no key, no address) leaves
  the browser reading and says why at boot, where the note used to say the
  capability was unbound.
- **What a page says, without what is around it.** `__palugada.article`
  (`src/browser/page.ts`) reads the one `article`, else `main`, else the
  body, as `innerText`, with menus, asides, forms, dialogs and anything
  hidden from a screen reader left out -- and the header and footer too
  when it reads the whole body -- by hiding them for the moment of the
  reading and putting each element's own style back. At most 60,000
  characters, as with a provider, and `truncated` says when there were
  more.
- **Nobody's browser.** `Browsers.extract` makes a context for the one
  reading, through the same proxy and under the same address rules, and
  disposes of it after: no company's sign-ins are sent, nothing the page
  sets is sealed, nothing reaches the next reading, and no tab is left
  for the owner's **Browser**. The site is told the company's language
  and time zone, as the company's browser tells it. Four read at once;
  a fifth waits as a busy capability does.
- **A Firecrawl you run** reads pages too (`firecrawl-self-hosted`, with
  `PALUGADA_EXTRACT_URL`), as it already searched.
- **The console** says under **Tools**, **Reading pages**, that with no
  provider the deployment's own browser reads pages when it has one.
- **Tested.** `browser.test.ts`: bound to the browser with no provider and
  to Jina with one; an article page read without its menu, footer and
  aside, with what its script wrote; read twice for a company signed in
  elsewhere, and sent no cookie either time; a metadata address refused as
  inside this network; the company's sealed sign-in unchanged and its tabs
  as they were. `web-search.test.ts`: the self-hosted Firecrawl goes to the
  owner's server; boot with the browser off says `web.extract` is unbound,
  and with a Chromium says the browser reads pages and binds it.
- **Not done**: the research's Readability provider, which the browser
  makes unnecessary where there is a Chromium. A deployment with neither a
  Chromium nor a provider still has no `web.extract`, and says so at boot.

## 2.126 A mail server's private authority is trusted besides the system's

`PALUGADA_MAIL_CA` (2.119) is documented as an authority to trust
"besides the system's", for a company's mailbox on a server with a private
certificate. It was trusted instead of them: Node's `tls.connect` replaces
its own authorities with a `ca` it is given, so with the setting made, every
mailbox on a public certificate -- Gmail, a hosting provider's -- failed to
connect with "self-signed certificate" or "unable to get local issuer".
Found while reading the transport for 2.127.

What changed: `secureSocket` (`src/chats/imap.ts`) names Node's default
authorities (`getCACertificates('default')`, which also holds any the
machine adds with `NODE_EXTRA_CA_CERTS`) together with the private one.
Tested in `customer-mail.test.ts` in a child process, where one authority
is the machine's and another is given as the private one: the server the
machine's authority signed was refused before and is reached now.

## 2.127 A division reads and sends mail from its own mailbox (tools research, recommendation 1)

The research ranked mail first: every company does it, and two of the
three mail capabilities had nothing behind them while the third needed a
sending service's account and a domain set up with it. `mailbox.read` had
been catalogued without an adapter since the start (2.119 said so), and
`email.send` waited for a vendor entry.

What changed:

- **`mailbox.read` and `email.send` are bound by the platform**
  (`src/capabilities/mailbox.ts`), over IMAP and SMTP, signed in with the
  division's `mailbox` key -- so Sales can hold sales@ and Support support@.
  The key is sealed and rotated like any (F12.3), declared with the scopes
  `mail:read` and `mail:send` its capabilities need (F12.6), and resolved
  at each call, so a password changed in the console is used at the next.
- **The key is a form, not a paste.** A capability may now say its key is
  given in a form (`credentialForm`): the console shows the mailbox's
  address, password and two servers -- the same form, moved into
  `MailboxFields.tsx`, that connects a customers' mailbox -- and the owner
  API holds the value to its shape before the device is asked for, then
  signs in to both servers before anything is sealed. A wrong password is
  said there and then, and nothing is kept. A held mailbox is changed in
  the same form.
- **Reading leaves the mailbox as it was.** A folder is opened with
  EXAMINE, read-only, and each message fetched with BODY.PEEK and its
  flags, so a role can list the newest mail -- sender, subject, date,
  unread or not, how it begins, what is attached -- search it by sender,
  subject, day and unread, and read one whole, and the owner's own mail
  app still shows it unread. No command a role can cause moves, flags or
  deletes anything. A word to search for goes quoted when it is ASCII and
  as a counted UTF-8 literal when it is not, so a subject in Indonesian is
  found; a line break in one is refused, since it would end the search and
  start a command of the role's choosing. What it reads is from outside
  (F8.9).
- **Sending is tier 2.** The letter is plain text from the mailbox's own
  address, named for the company, to at most ten people and ten more on
  Cc, as a reply in a thread when it names the message it answers. Work
  that read the mailbox asks the owner first, with a card that says who it
  is to and what it is about; recipients count as a batch (F8.13); a policy
  can match the recipients' domain. Its read-back is the one SMTP has, the
  server's `250` for those recipients. Its Message-ID is made from the
  call's idempotency key, so a call made again after a crash is the same
  letter to a mail client.
- **A preflight that does not hold up work.** With a key, each checks
  that its server takes it (F8.12), so a password the provider stopped
  taking halts work with a reason the owner can act on, and a server not
  answering waits rather than halts (H2). Without one it passes: the
  standard Support and Growth roles carry these tools, and their other
  work is not stopped for a mailbox nobody has given yet; the call says
  the division has none.
- **A binding that gives way.** A capability may now be bound only until
  something else binds its name (`fallback`). A vendor file, a service
  connected in the console and the console's check before saving one all
  refused a second binding of a name, so a deployment whose vendor file
  binds `email.send` to Resend would no longer have started; it starts,
  and Resend is used. The browser's `web.extract` (2.125) is the same, and
  had the same flaw in its unpushed form. **Services** no longer says
  either name is bound by something else, and the boot's "bound by the
  platform" is written after the services, naming only what the platform
  still binds.
- **`readMail` reads a message's date** as an instant, and the SMTP client
  takes several recipients and returns the server's acceptance.
- **Tested.** `mailbox.test.ts`, against the IMAP and SMTP test servers
  (which learned EXAMINE, search keys, UTF-8 literals and flags): the key
  asked for as a form by both capabilities with both scopes; a pasted
  string and a bad host refused before the device; a refused password
  sealing nothing; the sealed shape; the preflight passing, failing on a
  refused password and not on its own, and passing a division with none.
  Reading: newest first with sender, subject, date, unread and attachment;
  a limit with how many more; by sender, by a subject outside ASCII, by
  day and unread; one message whole; an unknown uid and folder said in the
  server's words; nothing marked read; no SELECT, STORE, EXPUNGE, COPY or
  MOVE sent; the task marked as having read from outside; a line break in a
  search word or a folder refused before the server is asked anything.
  Sending, after reading a customer's order: a header injection, an
  address with a name, eleven recipients refused before any card; the card
  naming recipients and subject; nothing sent before the owner's yes; the
  letter's From, To, Cc, In-Reply-To, Message-ID, subject and text as
  asked, and no Bcc. And a vendor file, a console service and the
  console's check each taking `email.send` and `web.extract` from the
  platform, while `web.fetch` stays its own. `console-mailbox.test.ts`
  gives a division its mailbox on **Team** in a browser at a phone's
  width, with the device, and finds it sealed with its scopes.
- **Not done.** `email.draft` still writes a draft into the company's
  files with a model (2.15); a draft in the mailbox's own Drafts folder
  (IMAP APPEND) would be a second meaning for one name, and is left until
  it is decided which the name means. Attachments are named, not read or
  sent. A folder name outside ASCII (IMAP's modified UTF-7) cannot be
  opened yet. OAuth sign-in to Gmail and Microsoft 365, rather than an app
  password, is the customers' mailbox's gap too.

## 2.128 A role reads a file in the company's files (tools research, recommendation 3)

Roles could list the company's files and not read one: a reviewer could
see that a draft was there and not what it said, and a price list the owner
left in the folder was a name. The research put `files.read` third.

What changed:

- **`files.read`, catalogued** at tier 0 and as a read of outside content
  (F8.9): what a file says may have come from a customer or a stranger's
  page by way of a draft, and nothing records which. Named "Read a file"
  for the owner in every language.
- **Bound beside `files.list`** when the deployment has a files root
  (`src/capabilities/files.ts`), and granted with it to Operations and
  Delivery in the standard template -- to the divisions, not to the roles'
  tools, which F2.4 keeps to twelve.
- **The same containment as `files.list`**: the path is resolved with
  `realpath`, and anything that ends outside this company's directory --
  `..`, a link to another company's file or to `/etc` -- is refused as
  outside. The file is then opened without following a link and checked as
  opened, so a link put where the file was after the path was resolved is
  not read through.
- **Text, read strictly.** UTF-8, its byte-order mark dropped; a file that
  is not -- a picture, a recording, a PDF -- is said to be not text rather
  than returned as noise. Up to 10 MB, 60,000 characters at a reading, and
  `next` says where the following one begins.
- **Tested.** `files-read.test.ts`: a draft and a CSV read as written; a
  long file read in pages that join up; a parent directory, a link to
  another company's file and one to `/etc/hostname`, and a path that climbs
  out through a folder, all refused as outside; a missing file, a folder, a
  picture and a start past the end each said; the catalogue's tier and
  `readsOutside`; bound only with a root; granted where `files.list` is.
- **Not done, next**: PDF, Word and Excel, which the research would convert
  in the network-less container. They are to be read in the deployment's
  sandboxed Chromium instead (2.123), so the platform's process still
  parses no untrusted binary.

## 2.129 A role reads a PDF, a Word document or a workbook, in the sandboxed browser

What 2.128 left: the documents a small company keeps -- a supplier's
invoice as a PDF, an offer in Word, the month's orders in Excel. The
research would parse them in the `--network none` container; that needs
Docker inside the deployment, and the deployment already has a better
boundary for a hostile file: Chromium's sandbox (2.123), which renders
strangers' pages all day.

What changed:

- **`Browsers.convert`** reads one document in a page of a context made
  for it, set offline as well as behind the proxy, and disposed of after;
  two at a time, a minute each (`src/browser/browsers.ts`). The parsing is
  `src/browser/documents.ts`, which runs only in that page: a document
  that breaks it has broken into a sandboxed renderer with no files, no
  network and nothing of the platform's.
- **A PDF** is read with pdf.js -- the console's own dependency, copied by
  its build into `console/dist/reader` (`console/vite.config.ts`), so the
  server adds none; the build config reading the files from disk gave the
  console `@types/node` as a dev dependency, which the image's console
  stage, with no repository root above it, did not otherwise have --
  imported into the page as `data:` modules and run on
  the page's own thread, so nothing is fetched; lines as lines, pages as
  paragraphs, as the console reads one. A locked one and a scan say so.
- **A Word document** is its paragraphs, tabs and breaks kept, deleted text
  and field codes left out, and its tables row by row with cells by tabs.
  **A workbook** is each sheet under its name, its cells by tabs where they
  stand, shared and inline strings, booleans, and dates as dates: Excel's
  own date formats and any of the workbook's whose code has a day, month,
  year or hour, in the 1900 or the 1904 system.
- **A ZIP is read with what the browser has**: the central directory by
  hand and each entry inflated with `DecompressionStream`, counted as it
  comes, so a file that claims or turns out to unpack past 32 MB is refused
  rather than believed; an encrypted entry is said to be locked. At most 5
  million characters of text, and 2,000 pages.
- **`files.read`** tells a document by its bytes before it reads anything
  as text -- a PDF may be ASCII throughout -- and Word from Excel by the
  name; it keeps a document's text ten minutes, so its next page is not
  another conversion, and says `kind`. Without a browser a document is
  said to need one.
- **The image's check reads a PDF** (`scripts/browser-check.ts`, which CI's
  docker job and `install.sh doctor` run), so a build that left out the
  reader, or a sandbox that stops pdf.js, fails there.
- **Tested.** `files-read.test.ts`, with documents written byte by byte
  (`test/helpers/documents.ts`): a two-page PDF with an accented word read
  line by line; a Word document's paragraphs, a tab and a table; a
  workbook's two sheets with dates, numbers, a blank and a name with an
  ampersand; the second reading not converted again; a ZIP that unpacks to
  64 MB, a broken PDF, a page with no text and a ZIP that is not a
  workbook each refused with what it was; a PDF with no browser said to
  need one.
- **Not done.** PowerPoint, OpenDocument and the old binary `.doc` and
  `.xls`; text in a picture or a scanned page, which is `image.describe`'s
  (recommendation 5); a workbook's formulas are read as the values Excel
  last saved, and one never saved by Excel has none.

## 2.130 A role reads a picture, through a vision model the owner chooses (tools research, recommendation 5)

A receipt a customer photographed, a supplier's invoice sent as a picture,
a screenshot, a scan: none could be read, and 2.129 had to say that a scan
has no text to give. The research put `image.describe` fifth: both
projects it studied ship one, and it can run on a local model.

What changed:

- **`image.describe`, catalogued** at tier 0 and as a read of outside
  content (F8.9), and named "Describe a picture" for the owner in every
  language.
- **A Tools kind of its own, Reading pictures** (`src/capabilities/vision.ts`,
  `PALUGADA_VISION_*`), like Listening: OpenAI, Google Gemini, Anthropic,
  OpenRouter, Groq, Mistral, and a vision model of the owner's own behind
  OpenAI's interface -- Ollama, llama.cpp, vLLM -- so a picture need not
  leave the owner's machine. Each request is its reference's, checked in
  October 2026 (the docs read for Groq's and Mistral's, whose picture is a
  string where the others' is an object; OpenRouter's list of models read
  for the default), the key where the reference puts it. The picture goes
  inside the request as a `data:` address, never as a link a provider would
  fetch.
- **Read as `files.read` reads a file.** The containment moved into one
  function both use (`readCompanyFile`), so they cannot drift apart; a
  PNG, JPEG, WebP or GIF is told by its bytes, whatever it is called; up
  to 5 MB, Anthropic's limit for one picture; nothing is sent for a path
  outside the company's files or a file that is not a picture.
- **Asked nothing, it is asked for what a business needs**: what the
  picture shows, and every word and number in it, laid out as on the
  receipt or the table. A role may ask its own question, in any language.
- **The console's card** has a model, and a try on a picture the owner
  chooses with a question, sent once and kept nowhere; without a files
  root it says the pictures are the company's files. Saving a model is now
  read from which kinds have one, so a new kind cannot be left out of it
  again, as this one first was.
- **The template grants it to Finance and Support**, unbound until a
  provider is chosen.
- **Tested.** `vision.test.ts`: every provider sent the picture, its kind,
  the question and its model where its reference says, with the key where
  it reads it and never in the address, over HTTPS or to the owner's own
  server; Mistral's picture a string; a JPEG, a WebP and a GIF told by
  their bytes; a link to another company's file, a parent directory and a
  climb out refused as outside, a text file as not a picture, 6 MB as too
  large, and nothing sent for any of them; the catalogue's tier and
  `readsOutside`; the boot's notes without a provider, without a key and
  without files; and the owner trying a server of their own on a picture,
  a file that is not a picture refused, and the choice saved with the
  device and bound.
- **Not done.** A picture inside a PDF or a Word document is not read; a
  scanned PDF is still said to have no text (2.129), and is read by saving
  its pages as pictures. The provider is paid per picture at its own price;
  each call reserves a cent before it runs, and nothing for a model of the
  owner's own.

## 2.131 A role asks the owner for a key, and never sees it (tools research, recommendation 7)

A capability whose key the division did not hold failed with "division
<id> has no credential aliased crm", and the run could only tell the owner
so in words, which the owner then had to act on somewhere else. The
research proposed `credential.request`, after OpenClaw's `secrets`: a
masked field in the inbox, and an alias for the role.

What changed:

- **`owner.ask` takes a `key`** (`src/broker/platform-capabilities.ts`)
  rather than a capability of its own: every role has `owner.ask`, and a new
  tool would have cost each role one of the twelve F2.4 allows. The
  research's "masked field" is the one the console already has: the card
  leads to it.
- **Only a key the division needs.** The name is checked against what its
  granted capabilities sign in with -- the same answer the console gives
  under the division's keys (`keysAskedFor`, moved to `src/broker/keys.ts`
  for both) -- so a run talked into asking for "the AWS key" is refused
  before the owner sees a card, and told which keys its capabilities do
  ask for. A key the division holds is not asked for again.
- **The card leads to where keys are given.** It says **Give the crm key**
  and opens the division on **Team** with its keys showing (the page now
  opens a division named in its address); the value is sealed as any key
  is, declared with what its capabilities need. Saving it -- pasted or
  signed in -- answers every open question that asked for that key in that
  division, and the work goes on. The role is told it is there, never what
  it is.
- **The failure says how to ask.** A capability with no key now says
  `this division holds no crm key: ask the owner for it with owner.ask,
  naming key "crm"`, and so does a mailbox not yet given (2.127).
- **Tested.** `key-request.test.ts`: the capability's failure says how to
  ask; the card opened with the key, its division and the capabilities
  that need it; the key given through the console's route answering the
  question without its value; the run told it is there and the capability
  signing in with it; a held key not asked for; a key nothing in the
  division uses, and a name that is not one, refused with nothing reaching
  the owner; and in a browser at a phone's width, the card's button
  opening the division's keys, the key given with the device, and the
  question answered.
- **Not done.** A key whose capability signs in with OAuth is signed in
  for from the same place, which the card leads to, but the card does not
  start the sign-in itself.

## 2.132 A role works figures out in Python, where its code reaches nothing (tools research, recommendation 6)

A month's sales from a spreadsheet, a cash-flow forecast, a chart for the
owner: arithmetic a model gets wrong in its head and a few lines of pandas
get right. The only code a role could run was `code.execute`, in the
sandbox, which does not isolate the network -- so F8.10 keeps it out of any
division with a key or a tier 2 grant, which is every division with figures
worth working out. The research put a contained one sixth.

What changed:

- **`code.compute`, catalogued** at tier 1 as code supplied at call time that
  reaches no network, and as a read of outside content: the files it reads
  may have come from anyone. Named "Calculate in Python" for the owner in
  every language.
- **Run in a container with no network** (`src/capabilities/compute.ts`), the
  flags of the `docker` backend's (2.46) and for the same reason:
  `--network none`, a read-only image with a 256 MB scratch, no
  capabilities, no new privileges, nobody's user, 1 GB of memory, one CPU
  and 128 processes; nothing mounted, no credential, none of this process's
  environment, `--pull never` so nothing is fetched mid-run, and
  `--log-driver none` so a company's figures are not copied into the
  daemon's logs. The files the role names are read with `files.read`'s
  containment and handed over stdin under `in/`; what the code writes to
  `out/` comes back the same way and is kept under
  `computed/<date>-<id>/`, never over anything, each file read back by its
  digest (F8.4). The program that runs the code
  (`src/capabilities/compute-runner.py`) is handed over with each call, so
  the image (`deploy/compute`: Python 3.13, pandas, numpy, openpyxl,
  matplotlib, pinned) is only libraries, and upgrading PALUGADA does not
  mean rebuilding it.
- **Its own time, then removal.** The code runs for the seconds it asked
  for, 60 unless it said, five minutes at most, and is stopped inside the
  container, which still answers. A container that has not answered by its
  grace, or whose run was stopped, is removed by name at once: ending the
  docker client does not end its container, and whatever the client left
  running may hold its pipes open, which is how the first version of the
  test hung.
- **Nothing half-kept, and said.** Code that fails, runs past its time or
  runs out of memory keeps nothing it wrote, and the role is told which,
  with what it printed. So does a link in `out/` (which would hand back
  what it pointed at), a name with a control character or a leading dot,
  more than 20 files or more than 16 MB. What the container hands back is
  checked again here, since code running as the same user could have
  replaced the program that hands it back.
- **F8.10 for code that reaches nothing** (0115). The refusal exists because
  the sandbox cannot stop code posting a key or reaching a tier 2 effect
  somewhere; code with no network can post nothing anywhere. So
  `capabilities.network_isolated` records the claim beside the flag it
  qualifies -- a check makes it impossible without that flag -- and the two
  functions 0008 wrote now ask about untrusted code that can reach the
  network. The registry refuses a binding whose claim differs from the
  catalogue's, so only the platform's container can make it; a vendor
  entry or an MCP server cannot. `code.execute` is refused beside a key or a
  tier 2 grant exactly as before.
- **Bound by the operator**: `PALUGADA_COMPUTE_IMAGE`, with the company's
  files, on a machine whose docker or podman this process can run
  (`PALUGADA_COMPUTE_DOCKER`, else `PALUGADA_RUNTIME_DOCKER`). The boot says
  which is missing. The image PALUGADA ships in has no docker, so in the
  Compose deployments it stays unbound; `docs/configuration.md` says to
  prefer rootless podman or a docker host of its own, since whatever can use
  the system's Docker daemon can become root on the machine.
- **The template grants it to Finance**, beside its keys and invoices, and
  the bookkeeper has it in its tools, with `image.describe` for receipts --
  which 2.130 granted to Finance and left off the bookkeeper's tools, where
  there was room for both. Never in the lab, whose code reaches the network:
  what this one reads, that one could post.
- **Tested.** `code-compute.test.ts`, against a docker client that logs what
  it is asked and plays the container with this machine's Python: a sum of
  a CSV printed and two files kept, nested, 0600, read back, and a changed
  one failing the read-back; the argv, flag by flag, with nothing mounted,
  no `--env`, and the client handed none of this process's environment; a
  traceback, a loop stopped at one second, and nothing kept from either; a
  link, a newline in a name, a hidden file, 21 files and 17 MB, each said
  and nothing kept; an answer forged in the runner's place -- a parent
  directory, an absolute path, a file that is also a folder, a name twice,
  21 files -- refused the same way; another company's file by a link, a parent directory
  and a climb out, a missing file and 21 files named, refused before any
  container starts; a container that never answers removed by its name
  after its grace, a stopped run's removed too, a missing image and a
  missing docker said plainly; the catalogue, a vendor binding refused, the
  boot's notes; the database letting it beside a key and a tier 2 grant in
  either order while still refusing `code.execute` there, and refusing
  isolation claimed for something that is not code; the template.
  `npm run compute:check`, in CI's docker job and run here against Docker
  29: as nobody, a read-only image, no name resolved, no internet, nothing
  on the host, only `lo`, no capabilities in its bounding set, no new
  privileges, 1 GiB and 128 processes, none of the orchestrator's
  environment, pandas summing the spreadsheet, a chart drawn and kept and
  read back, an endless loop stopped at two seconds, and no container left.
  Also run here: a missing image says how to build it, and a gigabyte array
  is ended by the memory limit and said so.
- **Not done.** The code cannot install a library: what the image has is
  what there is, and a company that needs another builds its own image on
  this one. Two runs go at once in a process and more wait their turn;
  nothing is kept between runs but the files they wrote.

## 2.133 Outside text cannot forge a turn, or close its envelope with a look-alike (tools research, §5 idea 10)

Everything from outside -- a page, a mail, a tool's answer, a customer's
message, a webhook, a document's passage -- reaches a model inside the
envelope `wrapUntrusted` draws (F8.9), which says it is data and escapes a
copy of its own fence. Two ways round it were open, both named by the
research from OpenClaw's prompt-injection notes:

- **Chat-template tokens written as text.** A model of the owner's own
  behind an OpenAI-compatible server -- Ollama, vLLM, llama.cpp, which
  PALUGADA speaks to -- may tokenize `<|im_start|>` in a page as the real
  token, and the page then ends the user's turn and opens a system one of
  its own, inside the envelope. Hosted providers escape them; a self-hosted
  stack may not. Now removed, each replaced by `[REMOVED_SPECIAL_TOKEN]`:
  every `<|word|>` (ChatML and Qwen, Llama 3 and 4, Phi, GPT-OSS), DeepSeek's
  full-width `<｜…｜>`, Llama 2's and Mistral's bracketed ones, Gemma's turn
  markers, and `<s>`/`</s>` -- OpenClaw's list, widened to the families'
  whole spelling rather than a list of their tokens. In the source's name
  too, since a document's title is outside content.
- **A fence spelled in look-alikes.** Only an exact copy was escaped; one in
  full-width letters or brackets, with a zero-width character inside,
  spaced, or in lower case, read the same to a model and went through. Now
  folded before it is looked for, and escaped like the exact one.
- **The one outside text that reached a model unwrapped.** What a role hands
  `doc.draft` and `email.draft` to draw on is often what it read -- a
  customer's mail, a page -- and it went to the drafting model as it was.
  It is in the envelope now, and the tokens are removed from the brief, the
  kind, the subject and the address too, which a role may have copied from
  what it read.

Text that only looks like either is left: spaced pipes, a pipe, an HTML tag,
a comparison, a bracketed note. The fold is native regular expressions, one
character for one, so a page of 2.4 MB is wrapped in about 25 ms, and text
built to make the match backtrack costs it one pass. Tested in
`charter-context.test.ts`: forty-one tokens across seven families removed with
the words around them kept and the removal said, a token in a source's name,
ordinary text untouched, and seven look-alike fences escaped with only the
two real ones left; `platform-capabilities.test.ts`, a draft's material sent
to the model framed as data and without the tokens a mail carried.

**Not done.** A model's own reply is not scrubbed of scaffolding it leaked
before the owner reads it, which OpenClaw also does; what reaches the owner
here is the run's structured output, not its raw text.

## 2.134 Pictures on the owner's own GPU, through ComfyUI (tools research, gap #10)

Every `image.generate` provider was a hosted one, paid per picture and sent
every prompt. The research named ComfyUI, which OpenClaw drives locally,
as the one to add for a company with a GPU of its own.

- **`comfyui`, under Tools, in "Your own server"**: an address and,
  optionally, a checkpoint as the model (`sd_xl_base_1.0.safetensors`
  unless given). No key: ComfyUI has none, so it belongs on a private
  network. Nothing is reserved for a picture.
- **Spoken to as its own server says** (`server.py`, read in October 2026):
  ComfyUI's default workflow posted to `/prompt` in the API's form -- the
  checkpoint, the prompt and a negative, a canvas of the shape asked for
  sized for SDXL, twenty steps of Euler, a random seed -- then
  `/history/<id>` looked at each second until the picture is there, then
  the picture fetched from `/view` and kept in the company's files, read
  back like any other. The workflow ends in `PreviewImage`, not
  `SaveImage`, so nothing piles up in the owner's output folder. A provider
  can now wait for a picture made later, ending early when the run is
  stopped and after three minutes in any case.
- **Its refusals in words**: a workflow refused before it ran says what
  ComfyUI said -- most often a checkpoint it does not have, and then to set
  the model under Tools to one it has -- and a run that failed says its
  exception, such as running out of GPU memory.
- **Licence.** ComfyUI is GPL-3.0, which the research had not checked;
  PALUGADA only speaks to it over HTTP and ships none of it.
- **Tested** in `media.test.ts`, against a ComfyUI that answers as its routes
  do: the workflow's checkpoint, prompt, size, seed and preview, the history
  polled until the picture, the picture fetched where the history says and
  kept, the owner's own checkpoint used when named, a missing checkpoint and
  a failed run said in words.
- **Not done.** A workflow of the owner's own (FLUX's needs other nodes and
  settings) is not taken; the default one serves SD 1.5 and SDXL
  checkpoints, which are most of what is shared.

## 2.135 A yes for exactly what a schedule does, every time it does it (tools research, §5 idea 3)

A schedule that reads the suppliers' mailbox each morning and sends the same
confirmation to the same supplier asked the owner every morning. Its work
read content from outside, so F8.9 asks before a tier 2 action, and the yes
for a while (0083) never reaches such work, because what was read could have
shaped the action. The research borrowed OpenClaw's standing grants for
automations: bound to the exact job and the exact operation, failing closed
when either changes by a byte.

What changed:

- **"Every time this schedule does it", on the card** (0116). An approval at
  tier 2 or below, in work a schedule made -- the task it started, or one
  that task handed on -- offers it in the approve menu beside "for a while",
  whyever the card was raised: a policy, the guardian, or content from
  outside. With the owner's device, in the app; never from a seat beside
  the owner; never with "for a while" in the same answer.
- **Narrower than the taint it covers.** The yes is for one schedule as it is
  defined when it is given -- a digest of its role, division, project, goal,
  account, instruction and timing -- one capability, and one action to the
  byte, the fingerprint every card already has. An action every byte of
  which the owner approved was not shaped by what was read; another
  recipient, another word, an edited schedule, or work no schedule made, and
  the owner is asked. Put back as it was, a schedule is the one the yes was
  for again. The threat model says so (5c).
- **Bounded.** Never tier 3 (F10.10). Ninety days at most, then the owner
  is asked again; the database refuses longer. Only the owner's console
  writes one, on the control plane; the application role reads it and
  counts its uses. Each use is recorded with the yes it ran on, and the
  call's record names it.
- **Listed and taken back** beside the yeses for a while, under "Allowed for
  a schedule": what, which schedule, the action as the card said it, until
  when, how often used, and **Take back**, a tightening with no device.
- **In every language**, the menu, the list and the three events.
- **Tested.** `schedule-approvals.test.ts`: the offer on a card from tainted
  scheduled work that 0083 refuses; the device asked for, and the chat
  channel refused; the next run's identical send, and a sub-task's, without
  a card, recorded with the yes it ran on; another recipient, a changed
  word and unscheduled work asked; an edited schedule asked and the same
  schedule put back not; taken back and asked again; tier 3, unscheduled
  work, a seat, a no, both kinds at once, past ninety days and an agent
  writing one, each refused; the console's routes; and on a phone, the menu,
  the device, the list and taking it back.
- **Not done.** Mining the history of the owner's answers for rules to
  propose (§5 idea 4) is not built.

## 2.136 A role proposes a schedule, and the owner's yes makes it (tools research, gap #12)

A role that saw the same work owed again and again -- Monday's sales asked
for three Mondays running -- could only say so in prose, which the owner
then turned into a schedule by hand on Team. Hermes has `cronjob_manage`
and OpenClaw `cron`; the research put the agent's half of that here, as a
proposal like `goal.propose`.

- **`schedule.propose`, tier 0** (`src/scheduler/proposals.ts`): a short
  name, a cron, a zone (the owner's when not given), the role that does it
  (the proposer when not named), what each run does, and why. Named
  "Propose a schedule" for the owner in every language.
- **Checked as the owner's own schedule would be, before the owner sees
  it**: a cron that parses in a zone that exists, a role of this company
  (the refusal names the slugs), a name of lower-case letters, digits and
  dashes that no schedule has, an instruction and a reason. And from a run,
  nothing more often than hourly: a schedule spends on its own, and a
  minute's is the owner's to make. One card per name; asked again, the run
  is told it is waiting.
- **The card, in the owner's language**: who proposes it, what each run
  does, who does it, the cron as written with its zone, the next three runs
  in the owner's own time, and the reason given. Not tied to the task, as a
  goal proposal is not: a no costs the company none of the work that
  proposed it.
- **The owner's yes is the schedule**, made in the same transaction as the
  decision -- on, its first run its next time -- under the proposing task's
  goal and project and the named role's division. A name taken since, by
  the owner or another proposal, refuses the yes and leaves the card to
  deny or to approve once the name is free; the owner's schedule is never
  overwritten. A no makes nothing. A seat beside the owner, which reads
  schedules and makes none, may say no and not yes.
- **The coordinator holds it** in the standard company, in place of
  `metrics.read`, as the strategist's `goal.propose` replaced it: it answers
  nothing until a vendor is bound, and Operations still holds the grant to
  trade back on Team. Its charter says when to use it.
- **Translations made consistent**: the Dutch and Chinese words for
  "schedule" in 2.135's menu and list are now the console's own.
- **Tested** in `schedule-proposals.test.ts`: proposing makes nothing; the
  card in Indonesian with the times in the owner's zone; one card per name;
  the yes makes the schedule with the role, goal, cron, zone and
  instruction, on and next in the future, recorded, and the proposer still
  running; an invalid cron, every fifteen minutes, an unknown zone, a bad
  name, an unknown role, a blank instruction or reason, and a taken name,
  each refused with nothing reaching the owner; another role named; a no
  making nothing; a name taken since refusing the yes without touching the
  owner's schedule, and the yes going through once it is free; a seat's
  yes refused; the catalogue and the template.

## 2.137 A customer channel answers on its own, from what the owner published for customers

Chosen by the owner on 3 October, as the first step to a company that does
an office's work ("support first, then the business records"), with
"answers from approved knowledge" as the bound. Until now every reply to a
customer waited for the owner (2.117): the work began with a stranger's
words, so `chat.send` in it asked whatever policy said (F8.9). A shop that
is asked the price of a coffee forty times a day had to say yes forty
times.

- **Two marks, both the owner's** (0117). A channel's `answers_alone`, off
  until the owner turns it on with their device on **Customers** (off again
  with the session), written on the control plane as the rest of a channel
  is. A document's `for_customers`, set on **Documents** with the session --
  what a marked document lets go, the session could already approve card
  by card -- and, like the switch, not writable by the application role:
  migration 0117 takes its `UPDATE` on `documents` back to `archived_at`.
  Turning a channel on gives its role `memory.search`, granted and among its
  tools, so it can find what to answer from.
- **A capability's own check, asked by the broker** (`clearsOutside` in
  `src/broker/registry.ts`). Only at tier 2, only where the work's reading
  from outside is all that asks -- no policy, no guardian, no tier 3 -- and
  only after every yes the owner gave has been looked for. Cleared, the call
  goes without a card, recorded as `approval.cleared_by_check` and on its
  `tool.called`; not cleared, the owner's card says why
  ("Not sent on its own: ..."), in their language.
- **`chat.send`'s check** (`src/capabilities/chat.ts`), in order, each a no
  that names itself on the card: the channel answers on its own; the reply
  goes to the conversation the work began with; it names (new `sources`,
  at most five) passages of documents marked for customers, read again
  here, unarchived and the division's, every one found; each figure in it
  -- digits alone, so "Rp 18.000" and "18000" are one -- and each mail
  address and link, a bare `bit.ly/...` among them, is in those passages or
  in the customer's last ten messages; fewer than six replies on their own in that conversation in
  the hour. Then the model.
- **The model's check** (`src/chats/answer-check.ts`, the standard tier). It
  is shown the passages as the company keeps them, the customer's words and
  the reply, both fenced as data, and answers with a verdict: send only with
  `supported`; `refund`, `price`, `complaint`, `legal`, `personal_data`,
  `commitment` and `unsupported` are the owner's. No answer in thirty
  seconds, a provider error, or an answer that is not a verdict is a no;
  with no model configured nothing goes on its own. Each check is charged
  to the work's budget account, traced in `llm_traces`, and recorded as
  `chat.answer_checked` with its category and reason.
- **The owner sees what went alone.** A reply that went on its own keeps its
  grounds (`chat_messages.grounds`: each document, its title and the
  passage), and the conversation shows "Sent on its own, from" and the
  documents. `memory.search`'s document results now carry the document,
  its place and whether it is for customers, which is what `sources`
  names. The run is told how a reply goes on its own where it reads its
  work, only when its channel does.
- **The owner's assistant** may propose both: marking a document, and
  turning a channel on, which takes the device when applied.
- **Export**: a document's mark and a message's grounds travel; whether a
  channel answers on its own does not -- a restored channel arrives closed
  and waits for the owner.
- **The threat model** says what this lets through and what it cannot (5d):
  an injection in a customer's message can choose among, and word, what the
  owner published, and cannot add a figure, an address or a link, or reach
  anyone else. A false statement in plain words that the model misses goes
  out; that is the bound the owner accepts by turning a channel on, and
  why it is per channel and off by default. Its duplicated 5b is now 5b and
  5c.
- **Tested** in `answers-alone.test.ts`, against a fake Bot API: the switch
  refused without the device and taken with it; the role given
  `memory.search`; the marks listed; the run told; `memory.search` giving
  what to cite; a grounded reply sent without a card, the check shown the
  published passage and the customer's words fenced and nothing of an
  unmarked document, `chat.answer_checked` then `approval.cleared_by_check`,
  and the thread marking it with the document's title; off again with the
  session and an ordinary card. Then each bound, each a card with its
  reason: no sources, an unmarked document, a figure of its own (15.000), an
  address and a bare link of its own, a refund found by the check, a check that answered
  with no verdict, another conversation, the seventh in an hour, and a
  policy that asks; six sent in all. And no model: nothing on its own.
  `tenant-isolation.test.ts` holds the application role from both marks.

## 2.138 The company keeps its own customer records

The second step the owner chose on 3 October ("support first, then the
business records"). `crm.read` and `crm.note` were catalogued from the start
and bound to nothing: the responder and the marketer were told to keep the
customer record, and there was none, so what a customer was told lived in a
run's output and went with it. Every customer conversation was a stranger
the first time, every time. The PRD names no CRM; this answers the owner's
request to do an office's work, as 2.137 did.

- **Contacts, notes and deals** (0118, `src/records/contacts.ts`). A
  contact is a name, an organisation, a mail address and a number, made by
  the owner, a run, or a customer's first message. Notes are kept as
  written: the application role may add one and may not update one. A deal
  is a title, a stage -- lead, qualified, proposal, won, lost; won or lost is
  closed, moved back is open again -- a value in the smallest unit of any
  currency, and the date it is expected to close. Each table is the
  company's, with row security forced and references carrying the company.
  A change keeps on the owner's timeline what each field was.
- **A conversation knows its customer.** A customer's first message on a
  channel files them under the contact the owner keeps with that address
  (whatever its case) or that number, or a new one named as they named
  themselves (`chats.contact_id`). A number written with its country code
  must match in every digit; one written for its own country matches
  without its leading zero on the end of the number written from, and only
  when what is left is a country code of one to three digits. A Telegram
  customer is new for each bot: Telegram gives nothing the owner would have
  written down. A name the customer changes later does not rename the
  record. The work a message starts is told the contact.
- **`crm.read`, `crm.note` and `crm.record`, bound by the platform**
  (`src/capabilities/crm.ts`, adapter `platform:records`) as a fallback: a
  CRM the owner connects takes the names over (2.127's `fallback`). With
  nothing named, each works on the customer the work answers. `crm.read` is
  tier 0 and reads outside content, as the catalogue always said: one
  contact whole -- details, the last ten notes, the deals, the
  conversations -- or up to ten found by words in a name, an organisation,
  an address or a number. `crm.note` and `crm.record` are tier 1, each read
  back; `crm.record` is new in the catalogue, and keeps details, someone new
  (`contact: "new"` with a name) or a deal. A malformed address, number,
  stage, value or date is refused with what is accepted; another company's
  contact is not found.
- **The responder holds `crm.record`** (twelve tools), and its charter says
  to keep details and what customers want to buy on the record; Support and
  Growth are granted it.
- **On Customers, Contacts**: find by name, organisation, address or
  number; add a person; open one to change their details, archive or put
  them back, note something, open a deal or move one's stage, and open their
  conversations. A conversation is named by its record. A seat reads the
  records and changes none. The owner's assistant may propose each change.
- **Export**: contacts, notes, deals and each conversation's contact
  travel, the records imported before the conversations that name them.
  Documents are now imported before the conversations too, so the grounds
  of a reply that went on its own (2.137) name the restored documents.
- **The threat model** says what a forged mail's From can do (5e): file a
  stranger under a kept customer, whose record the work then reads, while
  the reply goes to the address forged.
- **Counts**: the catalogue holds fifty-seven, and a bare boot leaves
  thirty-six unbound (section 3).
- **Tested** in `customer-records.test.ts`: a Telegram customer becoming a
  contact once, the work told it, a later name not renaming it, another
  customer and a nameless one; a mail found by its address in another case,
  a WhatsApp number found from a national number the owner wrote, a number
  that only ends the same not found, and a stranger kept with their number;
  the owner seeing both conversations on the record. A run reading the
  customer it answers as outside content, recording details and a deal,
  noting, closing the deal won, finding by words, keeping someone new, and
  refused a bad address, number, value, stage, nameless newcomer, unknown
  contact and another company's contact. The owner's routes: a blank name
  and a bad address refused, details, a note, a deal opened and lost, the
  search, archiving, the application role refused rewriting a note, and an
  export restored with its notes and deals. The binding, the tiers and the
  template.

## 2.139 The company keeps its own books, by double entry

The third step of the owner's choice of 3 October ("support first, then the
business records"). `ledger.read` was catalogued and bound to nothing, and
the bookkeeper's done criteria said the ledger balances against what was
issued and paid "where ledger.read is connected", which on every
deployment it was not.

- **A chart of accounts and entries that balance** (0119,
  `src/records/books.ts`). The books open the first time they are looked
  at, with cash and bank, accounts receivable, accounts payable, taxes owed,
  owner's equity, sales and expenses under the codes 1100 to 5100, each
  known to the platform by a key, so it finds them whatever the owner calls
  them; the owner adds their own. An entry is a day, a memo, one currency
  and two to forty lines, each a debit or a credit of whole cents on an
  account. It is refused, with what is wrong, when it does not balance,
  names an account the books do not have (the refusal lists them), puts a
  debit and a credit on one line, or names a day the calendar has not.
- **The database holds the rule, whatever wrote the entry.** A constraint
  trigger checks at commit that an entry has two lines and its debits equal
  its credits; the application role inserts entries and lines and updates
  neither, and a line it writes must belong to an entry of the same
  transaction, so nothing is added to an entry once kept. A restore, on the
  control plane, writes entries as they were.
- **A mistake is reversed, not rewritten.** A reversing entry, dated the day
  it is made, carries the lines the other way round and names what it
  undoes; an entry is reversed once, and a reversal is not reversed.
- **Balances on their natural side**, per currency: an asset or an expense
  by its debits, a liability, equity or income by its credits. Profit
  between two days is income less expenses, per currency.
- **`ledger.read` and `ledger.record`, bound by the platform**
  (`src/capabilities/books.ts`, adapter `platform:books`) as a fallback an
  accounting service takes over. `ledger.read` is tier 0, as the catalogue
  made it so that checking the books before paying is free: balances as of
  a day, the latest entries (within days, on an account), or profit.
  `ledger.record` is new in the catalogue, tier 1 and read back. An entry
  written by work that had read outside content is kept `outside`, and
  `ledger.read` returns its memo fenced as data and marks the work reading
  it (F8.9), as `memory.search` does a lesson.
- **The bookkeeper holds `ledger.record`** (twelve tools), its charter says
  to record what came in and went out with it, and Finance is granted it.
- **Books, a page of its own** beside Customers: this month's income,
  expenses and profit, the accounts with their balances, the latest
  entries with their lines, marked when reversed, a reversal, or written by
  an agent; the owner adds an account, records an entry with a running
  check that the debits equal the credits, and reverses one. A seat reads
  the books. The owner's assistant may propose each change.
- **Export**: the accounts, the entries and their lines travel, and are
  restored in one transaction, which is when they balance.
- **The threat model** says what the books hold to (5f).
- **Tested** in `books.test.ts`: the chart opened; capital, a purchase and
  a cash sale recorded, the balances on their sides, and the month's profit
  and an empty month; an unbalanced entry, an unknown account, a line both
  ways, 30 February and a single line refused with their reasons; an
  unbalanced entry written straight to the database refused at commit; the
  application role refused rewriting an entry or a line and adding lines to
  a kept entry. An entry recorded by work begun from outside read back as
  data by other work, which is then marked. The owner's routes: the books
  opened on a first look, an account added and a taken code, a bad code and
  an unknown kind refused, an entry, a mistake reversed once and a reversal
  not reversed, the balances and the entries in order; an export restored
  balancing. The binding, the tiers and the template.

## 2.140 A refused model key is said in words, told once, and waited out

The owner's complaint of 6 October: an OpenRouter key that answered `401
User not found.` reached the owner, in the assistant's chat, as
`The model did not answer: the model API refused the key (401); check
PALUGADA_MODEL_KEY_REF: {"error":{...}}` -- English, raw JSON, the name of a
variable the console owner never set -- and every task that met it halted
with "No runtime could take it" and **nothing in the inbox**. The owner had
to find the cause, fix it, and resume each task by hand.

- **The transport says facts, not a sentence about a variable.** A 401 or
  403 throws `model.unavailable` carrying `keyRefused`, the status, the
  host and what the provider said, taken out of its JSON (`error.message`,
  as OpenAI, Anthropic and OpenRouter send it). The message names the host
  and the status; the setting's name stays in the details, for an operator
  reading the record. A 400-class refusal is read the same way.
- **The owner reads one composed sentence**, in their language: which host
  refused, and "Open Settings, This deployment, Model, paste a key that
  works, test it and save", then the provider's own words as they were. The
  assistant answers with it instead of the raw error.
- **One card for the company.** The first refusal raises an incident --
  deduplicated by a name on the item (`once`), so ten tasks meeting it raise
  one card, and a new one only after the owner has answered it.
- **The work waits and carries on.** A task that meets a refused key goes to
  `waiting_window` for the new reason `model_key` ("Waiting for a model key
  that works", shown as waiting on the owner), looks again after a minute,
  two, five, fifteen, an hour, three, six, and halts only when those are
  spent (about ten hours) -- by then the card is long in the inbox. A refused
  call costs nothing, and it is not the task failing: no attempt is spent.
  The model-outage waits (F13.6) count their own events and are unchanged.
- **Not done:** a saved key takes effect at the next start, and the waiting
  task looks again at its own time, so after the owner fixes the key the work
  resumes within the step it was in, not at once. Waking the parked tasks
  when the key is saved is the next step if that is felt.
- **Also fixed on the way:** the card for a review whose verdict could not be
  recorded wrote the platform's error into its detail in English where it is
  raised; it is now the card's record, composed like the others.
- **Tested** in `out-of-process-runtimes.test.ts` (one card for two tasks, the
  waits growing, the work finishing when the key works with no attempt spent;
  the waits spent, no second card, and a new card after the first is
  answered), `model-runtime.test.ts` (the transport's facts, no variable in
  the message, not retried) and `assistant.test.ts` (the sentence in
  Indonesian, no raw JSON).

## 2.141 The shipped reviewers are asked for a verdict, and one that cannot be recorded stops nothing (audit of 3 October, P0-2 and P0-3)

The audit of `docs/AUDIT-2026-10-03-ONE-MAN-COMPANY.md` checked, in code, two
defects in the adversarial review (F7.1) that cost the owner work.

- **The reviewers a company is given were never asked for the verdict.** Only
  the `critic` carried the output schema that names `decision` and `reason`;
  the standard `reviewer`, `qa-reviewer` and `platform-reviewer` answered in
  whatever shape the model chose, and a review with no readable verdict goes
  to the owner as undecided. Every review by them was therefore the owner's
  to settle by hand. They now carry one schema (`src/review/verdict.ts`),
  with `decision` one of approve, revise, reject and `reason` required;
  `qa-review` is 1.3.0 and `palugada-dev` 1.4.0 for it, so an installed copy
  is offered the change.
- **A long reason jammed the review queue.** The decision fact written to
  memory carried the reviewer's whole reason; a memory holds 4,000
  characters; the insert refused a longer one, the transaction rolled the
  whole verdict back, and `settleCompletedReviews` threw out of its loop --
  every tick again, behind the same review, for ever. The fact now carries
  the criteria (to 600 characters) and the reason clipped with a mark that
  says so, and the decision record keeps the reviewer's words whole. A
  verdict that cannot be recorded for any reason is escalated once, with the
  platform's error as the card's record, and the reviews behind it are
  settled.
- **A reviewer's reasons about work that read outside content are remembered
  as outside**, as every other lesson from such work is (F8.9).
- **Tested** in `review-verdict-schema.test.ts` (every shipped reviewer
  requires `decision` and `reason`, and the versions moved) and
  `adversarial-review.test.ts` (a long reason kept whole in the record and
  clipped in memory; a decision about outside-begun work remembered
  `outside`; a verdict provoked into being unrecordable escalates once and
  the next review is still settled -- with the guard removed, it was not).

## 2.142 An approved task is not halted by the time the owner took (audit of 3 October, P0-1)

`task.delegate` gives a child a deadline, an hour unless the delegator says
otherwise. A child that asked for an approval parked in `waiting_approval`,
which the deadline sweep leaves alone -- and when the owner said yes, the task
went back to `running` with no lease, and the next sweep, or the claim itself,
took a running task whose deadline had passed. The owner had approved and
the work was halted `deadline_passed` for the hour the approval took. It is
the ordinary path whenever a coordinator's specialist reaches a tier 2 action
and the owner answers later than the hour.

- **A deadline is for the work, not for whoever decides.** When a task is let
  go from `waiting_approval` or `waiting_review` back to `running`, whichever
  way -- a yes, a question answered, a review settled, the stranded-task
  repair -- its deadline moves by the time it spent parked, read from the
  event that parked it. A task with no deadline has none after. The same
  statement that changes the status moves the deadline, so no sweep can see
  the one without the other.
- **Not changed:** a task parked for its window, a vendor or its model keeps
  the deadline it had; those waits are the platform's, and a deadline is how
  a run that waits on them for ever is ended.
- **Tested** in `approval-deadline.test.ts`: a task approved after waiting is
  past its original deadline and is neither halted by the sweep nor refused by
  the claim, while a task that never waited, with the same deadline, is
  halted; the review's wait is given back too; no deadline stays none.

## 2.143 One code opens a short window for what builds the company

The owner's complaint of 6 October: "dikit dikit autentikator ... bolak balik
hp". A second factor is single use, and every change to the structure asked
for a fresh one, so setting up a company -- a division, its roles, its grants,
its goals -- was the phone out for each, and up to thirty seconds' wait for the
next code. The assistant's cards for the same changes asked it too.

- **A session remembers when its owner last proved themselves.** Sign-in is a
  proof, and so is each code or passkey shown for an action
  (`owner_sessions.proved_at`, 0120). A recovery code proves less than a device
  and opens no window.
- **What builds the company is covered for a few minutes after.** Twelve
  actions are marked (`WITHIN_THE_WINDOW`, `src/owner/api.ts`): start a company,
  open a division, hire a role, change a role, appoint a CEO, change a grant,
  change a goal, change a measure, let one role start work for another,
  activate a skill, change a skill's scope, install a bundle. They need no new
  code inside the window; they still need the session. The window is not
  extended by what it covers -- only a fresh proof moves it.
- **Everything else always asks.** The model and its key, what a model costs,
  tools, vendors, MCP servers, agent CLIs and their sign-ins, every channel,
  money (the spend ceiling, budget accounts, resuming spend), freezing and its
  undoing, closing and restoring a company, devices and recovery codes, the
  browser, what lets outsiders in (triggers, customer channels), every
  credential, policies, rollbacks, publishers, and **every tier 3 decision**
  (F10.10). Marking is by opting in: a route that says nothing asks.
- **The owner chooses the length**: ask every time, 5, 10 (the default), 30
  minutes or an hour, under Settings, Security, "How long a code counts".
  Raising it loosens, so it takes a code; lowering or turning it off does not.
  It is not something the assistant may propose. `GET /api/me` says until when
  the session is covered.
- **The console tries first.** Inside the window an action is sent without a
  code, and the dialog opens only when the server refuses for want of one --
  which it does before doing anything. A failure that is not that refusal is
  shown in the dialog, where it always was.
- **Deviation, said plainly.** F2.9 makes structural changes tier 3 and F10.10
  asks tier 3 approvals "with MFA". Both still hold -- the owner proved with a
  device, a few minutes ago, in the same session -- but a stolen tab used inside
  that window can build structure without a code. The window is short, off at
  one setting, and does not reach money, keys, the model, channels or devices;
  and a decision about a tier 3 *item* is never covered. The test harness
  resets the window to none (`test/helpers/setup.ts`), so the tests of what asks
  for a factor are unchanged.
- **Tested** in `step-up.test.ts`: a division, then another, with no code after
  signing in; the model and letting spending resume still refused; the window
  run out and asked again, and a code reopening it; none, the default of ten,
  the choices, raising needing a code and lowering not, an unlisted length
  refused; a session signed in by a recovery code opening none.

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

**A model that does not answer is waited for before it halts a task.**
F13.6 says a tier 2 role does not fall back silently: "halted + insiden".
It still never falls back. What changed is when it halts: every role's task
now waits for the same model -- half a minute, doubling, five times, about
a quarter of an hour -- and halts with one incident only when the model is
still down. Waiting is not a substitution, since the model the owner chose
does the work when it answers, and halting on the first dropped connection
turned every provider blip into an inbox full of tasks to resume by hand
(section 2.25).

**Two things a green suite does not prove**, and both are named in the code as
well as here.

`ContainerAdapter` implements F12.9's `docker` backend, and its
`--network none` is the guarantee the in-process sandbox has never been able to
make: a runtime started there reaches the engine over stdio and nothing else.
What the suite tests is the argv — the flags *are* the security property —
and the health check's refusal. A whole run in a real container is checked by
`npm run container:check` on a real daemon, in CI's docker job (section 2.46).
`remote_sandbox` is `RemoteSandboxAdapter` over a three-method provider --
create, exec, destroy -- and its lifecycle runs end to end against a provider
written for the test, including the sandbox being destroyed on every path out
of a run. No sandbox vendor is reachable from here, so what has never happened
is a real Daytona or Modal machine answering; the `http` runtime also reports
this backend, because "somewhere else, not ours" is what it means in F13.5's
vocabulary, and it cannot verify the claim.

**Thirty-five of the fifty-eight catalogued capabilities are unbound on a bare
boot -- thirty-one on a machine with a Chromium -- and that is the design
rather than a gap.** The boot names every one. Fourteen need configuration, not
an account: `files.list` and `files.read` a files root, `doc.draft` and
`email.draft` a files root and a model; `web.search`, `image.generate`, `speech.synthesize`,
`speech.transcribe` and `image.describe` a provider chosen under **Tools**; `web.extract` one of
those or a Chromium; `browser.read`, `browser.act` and
`browser.handover` a Chromium; and `code.compute` a files root and an image
built from `deploy/compute`, with a docker to run it. The other twenty-one need a deployment's own vendor entry,
six of which `config/vendors.example.json` shows. `dns.read`, `invoice.pay`
and the rest are *names* in the catalogue: a tier, a schema, the scopes a
credential must declare, and a `verify()` contract. What executes them is a
deployment's own adapter, because `invoice.pay` against one bank and against
another are different programs and choosing one for every company that ever
uses this platform is not a decision a control plane gets to make.
`mailbox.read` and `email.send` are the exception that proves it: a mailbox
is one protocol whoever runs it, so the platform binds them to each
division's own (2.127), and a vendor entry for either still takes the name.
So is the customer record: `crm.read`, `crm.note` and `crm.record` are the
company's own tables until a CRM is connected (2.138), and the books:
`ledger.read` and `ledger.record` (2.139).
These counts were brought up to date when 2.139 was written, from the
catalogue and what the platform binds, after a boot read them for 2.136; until 2.127 the
paragraph said thirty-nine, still counting `chat.read` and `chat.send`, which
the platform has bound since 2.117.

It was twenty-five, and five of those were unbound for the wrong reason -- the
same one this repository already got wrong about MFA. `web.fetch`,
`uptime.check`, `files.list`, `doc.draft` and `email.draft` need nobody's
account, and `src/capabilities/` implements them. Section 2.15 has what that
cost and what it found.

What the platform owes in exchange is not letting that be quiet, and
`scripts/smoke.ts` names every unbound one on every boot. A company granted a
capability with nothing behind it is a company whose agents will be refused at
the moment they try to work, and finding that out at boot is the difference
between a configuration error and an incident.

**The `claude-code` adapter was run against the real binary, not against
Anthropic.** Claude Code 2.1.283 was installed and run with the shipped
arguments against a stand-in model and the tool bridge (section 2.22, "Any
agent"), which is what found the seventeen tools of its own and the operator's
settings it read. Anthropic's API is not reachable from the test environment,
so a run against the real provider -- its prompt caching, its rate limits, its
own cost report -- is still unverified, and is written down here rather than
left for a green suite to imply.

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
before committing. The second half of the PRD's fallback -- that the adapter
protocol stay Paperclip-compatible -- is not met, by decision: section 2.12
says why, after reading that protocol in September 2026.

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
