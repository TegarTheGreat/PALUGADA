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
| F1 tenancy, budget | F1.1–F1.4 | F1.5 (no skills or config in the archive), F1.6 (one account per company; not per project/division/role) | F1.7, F1.8, F1.9 |
| F2 organisation | F2.2, F2.4, F2.5 | F2.1 (no per-division escalation policy), F2.3 (no done_criteria, runtime, model routing, heartbeat) | F2.6, F2.7, F2.8, F2.9 |
| F3 charter, policy | F3.1–F3.8 | F3.9 (versioned with a diff, but no rollback), F3.12 (policy is code rather than prompt text, but there is no hook framework) | F3.10, F3.11 |
| F4 memory | F4.1–F4.4, F4.6 | F4.5 (low-confidence facts flagged; skill candidates need F15), F4.7 (the journal survives a restart, but there is no heartbeat and no working-memory object) | F4.8 |
| F5 engine | F5.1–F5.9 | — | F5.10, F5.11, F5.12, F5.13, F5.14 |
| F6 agent communication | F6.1–F6.6 | — | F6.7 |
| F7 adversarial review | F7.1–F7.6 | — | F7.7 |
| F8 broker, tiers | F8.1–F8.13 | — | — |
| F9 scheduler | F9.1–F9.6 | — | F9.7, F9.8, F9.9, F9.10 |
| F10 owner surface | F10.4, F10.6, F10.7, F10.8 | F10.1 (no `skill_candidate`), F10.2 (no goal ancestry, no plan), F10.5 (the rule is enforced; there is no push channel) | F10.3, F10.9, F10.10, F10.11 |
| F11 observability | F11.3, F11.5, F11.6 | F11.1 (traced, but by the engine rather than through an adapter), F11.4 (no preflight or orphan alerts) | F11.2, F11.7 |
| F12 credentials, gateway | F12.1–F12.4 (F12.3 now also triggers preflight) | — | F12.5, F12.7, F12.8, F12.9, F12.10 |
| F13 runtime adapters | — | — | all of F13 |
| F14 lifecycle hooks | — | F14.1 (enforcement is deterministic engine code, but not named hooks) | F14.2, F14.3, F14.4 |
| F15 skills | — | F15.3 (candidate SOPs need owner approval; not in skill format, unversioned, no eval) | F15.1, F15.2, F15.4–F15.8 |
| F16 bundles | — | F16.3 (company templates exist; unsigned, unversioned, not bundles) | F16.1, F16.2, F16.4, F16.5 |
| F17 eval, trajectory | — | — | all of F17 |

Read as a whole: v1's scope is finished and holds up, and v2 adds a control
plane layer around it that is mostly not built. The exception is the broker,
which is PALUGADA's own layer under every possible answer to the questions in
section 3 below, so it was built out first: F8 is now complete. The additions are not
decoration — the heartbeat model (F9.7–F9.10), atomic checkout (F5.11), leases
(F5.12) and lanes (F5.13) are what make the engine safe for more than one
worker, and none of them exist yet.

## 3. What has to be decided before building further

**NG6 contradicts the engine as it stands.** v2 states plainly that PALUGADA is
not an agent runtime and does not call an LLM to do a task; a runtime does,
through the adapter protocol in section 7.5. The current engine calls
`LlmClient.complete()` directly from inside a task handler, and the whole
handler model — a TypeScript function that the engine runs — is a runtime, not
a control plane. This is the largest single change in v2 and everything in F13,
F14 and F17 sits on top of it. Nothing new should be built on the handler model
until this is resolved, because each addition makes the eventual move more
expensive.

**Section 14.1 is open again, and it gates the rest.** v2 reopens the
fork-versus-build decision with an explicit one-week spike and pass criteria.
The answer changes what "implement F5.11" means: a fork inherits Paperclip's
checkout, a rebuild writes one. Building the v2 engine before that decision
risks writing the half that gets thrown away.

**The state machine gains a status.** v2 section 8.5 adds
`pending → checked_out → running`, which the current implementation does not
have — it goes `pending → running`. Adding `checked_out` is a schema change and
a change to every transition guard, so it belongs with F5.11 rather than on its
own.

Three smaller notes, recorded so they are not rediscovered:

- v2 keeps `waiting_window` in the diagram, which resolves one of the two
  deviations recorded against v1. It now returns to `pending` rather than to
  `running`, which is what the implementation already does.
- v2 still does not draw `pending → halted`, and F5.6 still requires it. The
  deviation stands.
- v2 F1.5 and F16.4 both ask for a full company archive, and the existing
  export covers state, events and memory but not skills or configuration,
  neither of which exists yet in the form v2 describes.
