# 0001 — Fork Paperclip, or build and stay adapter-compatible

**Status:** decided — build, and implement Paperclip's adapter protocol
**Date:** 3 September 2026
**Answers:** PRD v2 §2.4 and open question §14.1
**Decided by:** this spike, under the pass criteria the PRD set in advance

## The question, and the test the PRD set for it

§2.4 does not ask which project is better. It asks one narrow question and
fixes the pass mark before the evidence is gathered, which is the only way a
spike can decide anything:

> deploy Paperclip, coba tambahkan RLS, capability broker, dan `verify()`
> sebagai plugin/hook. Jika minimal dua masuk tanpa merombak inti → fork.
> Jika tidak → bangun sendiri dengan protokol adapter kompatibel Paperclip.

Two of three, as a plugin or a hook, without gutting the core.

## What was actually done, and what was not

Paperclip was **not deployed**. This environment's egress proxy blocks a
number of hosts and cannot stand up a full Node plus Postgres product for a
real trial, so the honest description of this spike is: the published plugin
specification and developer documentation were read closely, at
`github.com/paperclipai/paperclip`, and the three requirements were tested
against what that documentation permits.

That is weaker than a deployment in one specific way — documentation can lag
an implementation, and an undocumented extension point may exist. It is
strong enough for this decision because all three answers below fail on
architecture rather than on detail: they are refusals stated in the spec, not
gaps that a closer reading of the code might fill.

If the owner wants the deployment before committing, the three checks are
listed at the end in the form they should be run.

## The three requirements against the plugin system

**Row-level security — does not go in.** Plugins get a fixed set of generic
tables (`plugin_state`, `plugin_entities`, `plugin_config`, and so on) and the
spec closes the door explicitly: *"Arbitrary third-party schema migrations are
out of scope for the first plugin system."* RLS is not a table a plugin adds
alongside its own; it is `ALTER TABLE ... FORCE ROW LEVEL SECURITY` on every
core tenant table, plus a policy on each, plus a database role that holds
`NOBYPASSRLS`. All of that is the core schema. The developer documentation
mentions no row-level security anywhere, and describes company scoping only as
a check in the workspace login path — application-layer, which is the thing
PRD F1.2 exists to stop relying on.

**Capability broker — does not go in.** The broker's whole value is that it
runs *before* the adapter: F8.1 puts every tool call through it, and F2.4's
acceptance criterion is that a refusal produces no downstream call at all. The
plugin RPC surface is `initialize`, `health`, `shutdown`, `onEvent`, `runJob`,
`handleWebhook`, `getData`, `performAction`, `executeTool` — and the spec
describes the direction of `executeTool` plainly: *"When an agent invokes a
plugin tool during a run, the host routes the call to the plugin worker."* The
host decides and then delegates. There is no pre-execution veto, and no hook
or middleware outside the plugin system that offers one. A plugin can
implement its own tools; it cannot stand in front of anyone else's.

**`verify()` — goes in for a plugin's own tools only.** A plugin that
implements a write tool can read back inside its own `executeTool`. What it
cannot do is what F8.4 actually requires: refuse to *register* a tier 1
capability that has no read-back, and impose the read-back on tools the host
or another plugin owns. As a platform-wide guarantee it does not go in; as a
convention each plugin author may follow, it is not a guarantee at all.

Score: zero of three. The criterion asked for two.

## Decision

**Build.** The PRD's own fallback applies, and its second half is not optional:
*"bangun sendiri dengan protokol adapter kompatibel Paperclip"*. Compatibility
with the adapter protocol is what keeps G9 and the community adapter ecosystem
reachable, and it is now a requirement of this codebase rather than an
aspiration — see F13.1–F13.3.

Three things follow, and they are the reason this decision is worth its own
document rather than a line in a status table.

**The differentiators are the reason.** RLS, the broker and mandatory
verification are exactly the three things §2.3 lists as missing from every
reference project, and they are exactly the three that cannot be bolted on.
That is not a coincidence: a boundary that can be added as a plugin is a
boundary a plugin can also remove. Isolation enforced by the database, a
broker no runtime can go around, and a read-back nobody can decline are
load-bearing precisely because they sit under the extension point rather than
inside it.

**Paperclip is still the better system for its own goal.** It is further along
on heartbeats, checkout, dashboards and the adapter ecosystem, and this
document should not be read as a verdict on it. §2.2 already records what is
being adopted from it; that list is long, and it grew after this spike rather
than shrinking.

**What was already built stands.** This codebase was written against v1, which
assumed a build. The spike confirms the assumption rather than invalidating
the work: nothing here needs to be undone, and the adapter protocol (F13) is
the next piece rather than a correction.

## If the owner wants the deployment first

Three checks, in the order that fails fastest:

1. Stand up Paperclip against an external Postgres. Try to add
   `FORCE ROW LEVEL SECURITY` and a tenant policy to its core tables through
   a plugin's own migration path. If the plugin system will not run the
   migration, stop — that is the first failure and it is the one that matters
   most.
2. Write a plugin that must be consulted before *another* plugin's tool runs,
   and have it refuse. If there is no extension point that receives the call
   before the host dispatches it, that is the second failure.
3. Register a write tool with no read-back and confirm whether the host
   accepts it. Acceptance is the third failure.

Any two of the three passing would reopen this decision, and reopening it is
cheaper now than later: the adapter protocol is the seam, and a fork would
attach at the same seam.
