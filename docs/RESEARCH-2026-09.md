# Four systems' shortcomings, checked against this one (September 2026)

The question for this round was not "what do Slack, Buzz, auto-company and
Paperclip have that PALUGADA lacks" — a feature list comparison produces
features. It was: **what went wrong in each of them, and is the same thing
wrong here?** Every defect found in the others was looked for in this
repository before anything was written. Most of what was fixed this round was
found that way, and none of it had been found by the audits in
[`STATUS.md`](STATUS.md) §2.2–2.15, because each of those asked a question
about this code and these came from somebody else's failures.

Sources were read at a fixed revision:

| System | Revision | What it is |
|---|---|---|
| [block/buzz](https://github.com/block/buzz) | `02c6309` | Slack-shaped workspace for humans and agents, Rust relay over Nostr events, Postgres + Redis |
| [maxmiksa/auto-company](https://github.com/maxmiksa/auto-company) | `beb22a1` | A bash loop that runs one headless agent CLI per cycle with a model-rewritten consensus file |
| [paperclipai/paperclip](https://github.com/paperclipai/paperclip) | `4ca404b` | The direct competitor: agent companies with issues, heartbeats, budgets, approvals |
| Slack | public docs and changelog | The incumbent, and the surface most agent integrations are built on |

## 1. What went wrong elsewhere, and whether it was wrong here

Each row is a failure observed in one of the four, the evidence, and what this
repository turned out to have. "Was here" means the same defect existed in
PALUGADA when this round started.

| Failure elsewhere | Evidence | Here | What was done |
|---|---|---|---|
| Stale approval buttons: a chat message keeps Approve/Deny after the decision was made elsewhere | Slack HITL integrations cannot update the message after interaction (n8n community thread 119544); Slack's 3-second acknowledgement rule | **Was here.** `owner_notifications.external_ref` was stored "so a later edit can find it" and nothing ever edited | `retractClosed` rewrites every delivered chat message whose item closed; Telegram removes the keyboard in the same call. Exactly once, bounded, backed off (migration 0036) |
| An approval committed, then the run resumed from a detached task; a crash between leaves the run waiting for ever | Buzz `crates/buzz-relay/src/handlers/command_executor.rs:1100-1116` | **Was here, three times.** `requestApproval`, `decide` and `expireOverdue` each changed the inbox item and the task in two transactions | One transaction each, task row locked first. A decision the state machine refuses is rolled back with it |
| `approve()` flips status then creates the agent outside a transaction; a retry returns `applied=false` and nothing repairs it | Paperclip `server/src/services/approvals.ts:143-212` | Same class as the row above | As above |
| Check-then-update with no status guard in the WHERE clause | Paperclip `approvals.ts:224-265`, checkout TOCTOU at `issues.ts:11319-11366` | **Was here.** `transition()` read the status, checked the edge and wrote, unlocked: a cancellation committed between was overwritten | `transitionWithin` locks the row before reading it. A race test holds the cancellation open across the transition |
| An approval for work that no longer exists stays open | Buzz workflow approvals are unimplemented (`crates/buzz-workflow/src/executor.rs:738`) | **Was here.** Nothing closed an approval when its task ended another way | A trigger withdraws it (`status = 'withdrawn'`) on every path into a terminal status, including the bulk stop |
| "Stop" that does not stop everything | auto-company's circuit breaker sleeps and resets for ever (`scripts/core/auto-loop.sh:934-940`) | **Was here.** `stopEverything` cancelled four of six live statuses, released no reservation and cleared no lease | Complement of the terminal set; reservations returned, leases cleared, in one statement |
| The runtime is killed, its children are not | auto-company's supervisor exists because of this (`scripts/core/process-supervisor-linux.py:61-158`) | **Was here.** Three adapters sent SIGTERM to the direct child, and only if it was still alive | `src/runtime/process-tree.ts`: own process group, SIGTERM, grace, SIGKILL, confirm empty ignoring zombies; fail closed on survivors |
| A withdrawn or overdue run keeps running | Buzz: `!cancel` "unreachable from every product surface" (`docs/welcome-kickoff-silent-failures.md:408`) | **Was here.** Cancellation reached a CLI only when it next printed something; `limits.wallClockMs` was sent to every runtime and enforced by none | Abort ends the tree now; the task deadline is a timer in `driveRun` and halts as `deadline_passed` |
| Rate limits read as failures; retries burn the budget | auto-company greps output for `429\|quota` and sleeps a fixed hour (`auto-loop.sh:151`); Slack's history API is 1 request/minute for unlisted apps since 2025-05-29 | **Was here.** A vendor 429 was `contract.violation`; three ticks spent the task | `rateLimit()` reads `Retry-After` (seconds or date), `RateLimit-Reset`, `X-RateLimit-Reset` (epoch or seconds); the engine parks the task until then without spending an attempt, bounded at 6 h and 5 parks |
| Unknown cost counted as zero | Paperclip records unpriced usage at 0 cents so the hard stop never trips (`heartbeat.ts:5208-5229`); auto-company treats it as "unverifiable" and pauses (`scripts/core/usage_lib.py:412-483`) | **Was here.** `usage.costCents ?? 0` — every CLI adapter reports no price | An operator price list, and a deliberately high fallback (§3) |
| A daemon restarted into the same configuration error for ever | auto-company exits 78 and its units set `RestartPreventExitStatus=78` (`scripts/wsl/install-wsl-daemon.sh:50-52`) | **Was here, and worse.** `npm start` did not start: `src/main.ts` exported `start()` and called nothing. Once it did, the only secret store was in-memory, so the owner could never have signed in | An entry point that exits 78 on configuration and stops on SIGTERM; an env/file secret store; the owner's factor enrolled from configuration; `deploy/palugada.service` |
| Errors swallowed on paths that decide | Paperclip: 318 `.catch(() => {})` or empty catches, e.g. run-event appends that leave transcript gaps (`heartbeat.ts:22192`) | **Was here, once in 47.** Unreadable bundle hooks fell back to none, and the empty list was cached for a minute | The gate refuses while the hooks cannot be read, and the failure is not cached |
| Tenant isolation in application code only | Paperclip: zero RLS policies in 283 migrations | Not here: FORCE RLS on every tenant table since 0001 | — |
| Approvals with no expiry | Paperclip `approvals` has no `expires_at` | Not here: F10.4, silence cancels | — |
| No second factor for irreversible actions | Paperclip has no TOTP or WebAuthn | Not here: F10.10, F12.5 | — |
| Agent-to-agent loops with no hop limit | Buzz `docs/welcome-kickoff-silent-failures.md:225-230` | Not here: hop limit and cycle detection (F5) | — |
| Every tool permission auto-approved | Buzz `crates/buzz-acp/src/acp.rs:1981-2030` | Not here: every action goes through the broker's tier and policy | — |
| Autonomy as a principle | auto-company `CLAUDE.md:11-15`: "Do not wait for human approval" | Not here: tier 3 is the owner's, over the app, with a second factor | — |
| Model-written state fed back verbatim every cycle | auto-company `auto-loop.sh:708,756-758` | Not here: external content is data (F8.9); memory is scoped and distilled with a curation gate | — |
| Decisions lost once the conversation scrolls away | "Slack is amazing for speed, but terrible for long-term memory" (Medium, "Stop Losing Decisions in Slack Threads", 2025); Buzz pages threads by keyset (`docs/nips/NIP-CW.md`) | **Was here, half.** Decisions are rows, not messages, but the console showed open items only, so an answered one left the only screen the owner has | A History tab: closed items with outcome, surface and the owner's note, searched including the note, paged by keyset (migration 0039) |
| A retried failure logged on every retry | auto-company's breaker loop (`auto-loop.sh:934-940`); Slack's notification overload, applied to an audit trail | **Was here.** A schedule that could not be funded wrote `schedule.fire_failed` every worker tick, ~17,000 times a day | The schedule remembers the failed occurrence and reason; the event is written when either changes (migration 0038) |
| Run ownership keyed on a reusable id | Paperclip notes PID recycling and keys ownership on a boot id (`heartbeat.ts:8841`, `legacy-controller-lease.ts`) | **Was here.** The deployment named its worker `worker-${pid}`; container replicas are PID 1, so two replicas shared one lease identity | `worker-<host>-<pid>-<boot id>` |
| Work that repeats itself, paid for indefinitely | auto-company's "same Next Action for 2 consecutive cycles → stuck" (`i18n/en/PROMPT.md:72-76`); Paperclip's no-progress throttle (`issue-rewake-throttle.ts:28-40`) | **Was here.** A schedule fired for ever whatever it produced | Five identical results ask the owner once; deny turns the schedule off |
| Money only as a post-hoc sum | Paperclip `budgets.ts:143-166`, checked only at claim | Not here: reservation at admission and a spend per call | — |

## 2. What was adopted, and what was not

Adopted, because it answered a defect this repository had:

- **auto-company's fail-closed process supervisor.** Not the subreaper, which
  needs native code; the rest of it. A runtime with a surviving tree reports
  itself unhealthy, which is F13.8's existing refusal.
- **Buzz's approval-and-resume in one step**, done the way Buzz's own code
  comment says it should be and does not do.
- **Paperclip's `retryNotBefore`** (`packages/adapter-utils/src/types.ts:69-91`),
  as `notBefore` on `capability.rate_limited`, parking on F9.2's existing
  `waiting_window` rather than a new status.
- **Paperclip's boot-id run ownership** (`legacy-controller-lease.ts`): a
  worker is named for its boot, not its PID, since every container replica is
  PID 1.
- **Paperclip's liveness contract** (`doc/execution-semantics.md` §8-9): every
  live task has a next mover, and a sweep finds the ones that do not. Here the
  owner's escalation is the recovery action, rather than a second table, and
  their answer moves the task.

Considered and left:

- **Buzz's "steer instead of queue"** (a message mid-turn cancels and re-runs
  with both). The owner's surface here is an inbox of decisions, not a
  conversation, and F10.3's question-on-an-approval already covers the case
  that matters: the owner asking before saying yes.
- **Paperclip's plan-only continuation** (`run-liveness.ts:297-357`). It
  answers a run that ends in prose about future work; here a run ends only
  with `done`, and an output checked against the role's schema. Its sibling,
  the no-progress throttle (`issue-rewake-throttle.ts`), *was* adopted in the
  shape this platform needs: a schedule whose last five runs produced the
  same result asks the owner whether it is still worth running.
- **auto-company's persona roster.** F2 makes roles functional scopes with an
  output contract on purpose (PRD §2.3); a persona is a prompt, and a prompt
  is the role's own business.
- **Read-state sync across devices** (Buzz NIP-RS). Worth doing once there is
  more than one owner surface that shows items as unread; today the chat
  message's retraction is that signal.

## 3. Unknown cost

F13.7 says a runtime that cannot price a call gets an estimate, "marked as
one". The mark was implemented and the estimate was `?? 0`. Every agent CLI
this platform employs reports tokens per message and no price, so in the
configuration that matters in production a company's money ceiling never
moved — F1.7's warning at 80% and pause at 100% were enforced against a
counter that stayed at zero. The test for it counted the mark and never the
amount, which is how an estimate of nothing passed.

The two systems disagree about what to do, and the disagreement is the
design question. Paperclip prices unknown usage at zero and records it as
`unpriced`, so its hard stop cannot trip on an unpriced adapter. auto-company
calls the same state "unverifiable" and pauses the company. This takes
auto-company's side, without the pause: `src/engine/pricing.ts` prices a call
from the operator's own list (`PALUGADA_MODEL_PRICES`, exact names or
prefixes, most specific wins), and a model the list does not know is charged
at a fallback set to the top of the market — $15 in and $75 out per million
tokens. An estimate that is too high stops a company a little early and says
so on the event (`basis: "fallback"`); one that is too low spends money
nobody agreed to. A call that used tokens is never charged nothing, and a
price file whose fallback is free is refused, because that is the one value
that restores the defect.

There is no built-in vendor price list, on purpose: prices change several
times a year, and a table compiled into a control plane is wrong by the next
release without anything failing to say so.

The estimate is not the last word. A CLI that states its run's bill at the end
(Claude Code's `total_cost_usd`) has it settled against what the estimates
charged, in either direction — which is what Paperclip does with a run's
reported cost, minus its lost-update: `spent_monthly_cents` there is a
recompute-then-write (`costs.ts:81-100`), and here the settlement is one
locked statement over the account chain (migration 0037, which also fixed a
settlement that had been reaching only the leaf account since 0024).

And a usage report is read, not cast. It is the one message a runtime sends
that moves money, and until this round a runtime reporting a negative cost
would have erased its company's recorded spend.

## 4. What it came to

Twenty-three rows above are failures somewhere else. Fifteen of them were,
in some form, failures here too; eight were not, and the table says why.
Looking for them turned up five more that were this repository's own (a settlement reaching one account of a chain, an
unvalidated usage report, two clock-precision windows, a schedule that could
not advance). Every one is fixed with a test that fails against the old code,
checked by re-introducing the defect. The per-defect account is in
[`STATUS.md`](STATUS.md) §2.16.

## 5. What this does not cover

The comparison was against source at the revisions above and against public
documentation. None of the four was run, and no claim here depends on having
run one; every "evidence" cell is a file and line that can be read.
