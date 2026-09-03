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
| F1 tenancy, budget | F1.1–F1.4, F1.7, F1.8, F1.9 | F1.5 (no skills or config in the archive), F1.6 (one account per company; not per project/division/role) | — |
| F2 organisation | F2.2, F2.3, F2.4, F2.5, F2.7, F2.8 | F2.1 (no per-division escalation policy) | F2.6, F2.9 |
| F3 charter, policy | F3.1–F3.8, F3.10, F3.12 | F3.9 (versioned with a diff, but no rollback) | F3.11 |
| F4 memory | F4.1–F4.7 | — | F4.8 |
| F5 engine | F5.1–F5.9, F5.11–F5.14 | — | F5.10 |
| F6 agent communication | F6.1–F6.6 | — | F6.7 |
| F7 adversarial review | F7.1–F7.6 | — | F7.7 |
| F8 broker, tiers | F8.1–F8.13 | — | — |
| F9 scheduler | F9.1–F9.10 | — | — |
| F10 owner surface | F10.1, F10.2, F10.4, F10.6, F10.7, F10.8, F10.11 | F10.5 (the rule is enforced; there is no push channel) | F10.3, F10.9, F10.10 |
| F11 observability | F11.1, F11.3, F11.5, F11.6, F11.7 | F11.4 (no preflight or orphan alerts) | F11.2 |
| F12 credentials, gateway | F12.1–F12.4 (F12.3 now also triggers preflight) | — | F12.5, F12.7, F12.8, F12.9, F12.10 |
| F13 runtime adapters | F13.1, F13.2, F13.4, F13.5, F13.6, F13.7, F13.8 | F13.3 (the wire protocol is open and documented; no `hermes`, `codex` or `gemini-cli` adapter is written) | — |
| F14 lifecycle hooks | F14.1, F14.2, F14.3 | — | F14.4 (a bundle may not yet carry a hook) |
| F15 skills | F15.1–F15.7 | — | F15.8 (needs the quarantine mode of F12.10) |
| F16 bundles | — | F16.3 (company templates exist; unsigned, unversioned, not bundles) | F16.1, F16.2, F16.4, F16.5 |
| F17 eval, trajectory | F17.1, F17.2, F17.3, F17.4 | — | — |

Read as a whole: v1's scope is finished and holds up, and v2 adds a control
plane layer around it that is mostly not built. The exception is the broker,
which is PALUGADA's own layer under every possible answer to the questions in
section 3 below, so it was built out first: F8 is now complete. The additions are not
decoration — the heartbeat model (F9.7–F9.10), atomic checkout (F5.11), leases
(F5.12) and lanes (F5.13) are what make the engine safe for more than one
worker, and none of them exist yet.

## 2.1 Deliberate deviations from the PRD

Two places where the implementation does not read literally as the PRD does.
Both are choices, and both are cheap to reverse if the reasoning stops holding.

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

## 3. What has to be decided before building further

**A role eval is structural, not a replay.** F17.2 asks that a change to a
role's charter, skills or model routing runs its eval set. Scoring by
re-executing five reference trajectories against a live provider would cost
real money and give a different answer each time, and F17.3 needs the number
*before* the owner clicks rather than an hour afterwards. So the score asks
whether the change keeps what the references depended on and keeps the negative
cases' failure modes closed. That is weaker than replaying the work, and it is
the check that can run in the second before a decision.

**The `claude-code` adapter has not been run against the real binary.** It is
not installed here and the provider is not reachable from the test environment,
so what the suite covers is the argv it builds, the translation of the CLI's
stream-json into §7.5's vocabulary, and the MCP bridge its tool calls go
through — driven directly, as a client would. The end-to-end path is unverified
and is written down here rather than left for a green suite to imply.

**NG6 is resolved.** The engine no longer calls a model to do a task: it
assembles a `RunRequest`, lends the runtime four services, and does the
accounting. The handler model is now the in-process runtime — a genuine adapter
that the engine talks to through the same protocol it would use for
`claude-code`. What remains of F13 is the out-of-process adapters themselves
(F13.2, F13.3) and automatic model fallback (F13.6).

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

**The state machine gains a status.** v2 section 8.5 adds
`pending → checked_out → running`, which the current implementation does not
have — it goes `pending → running`. Adding `checked_out` is a schema change and
a change to every transition guard, so it belongs with F5.11 rather than on its
own.

Three smaller notes, recorded so they are not rediscovered:

- v2's `checked_out` status is implemented, and `pending -> running` is kept
  alongside it: a worker that claims and starts in one breath passes through
  `checked_out`, but the engine also runs tasks that were never queued, and
  forbidding the direct move would mean inventing a checkout for them.
- v2 keeps `waiting_window` in the diagram, which resolves one of the two
  deviations recorded against v1. It now returns to `pending` rather than to
  `running`, which is what the implementation already does.
- v2 still does not draw `pending → halted`, and F5.6 still requires it. The
  deviation stands.
- v2 F1.5 and F16.4 both ask for a full company archive, and the existing
  export covers state, events and memory but not skills or configuration,
  neither of which exists yet in the form v2 describes.
- F1.6's per-scope budget accounts are still missing, and that shows through
  into the standard template: it creates one account, which is therefore
  company-lifetime rather than per-tree. Its money ceiling is set to a year of
  the monthly figure so it stays out of the way and the monthly ceiling does
  the work. Once accounts exist per project, division and role, that number
  should become a real per-tree allowance.
