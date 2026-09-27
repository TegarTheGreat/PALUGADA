# Concepts

Each section explains one idea the console shows you: what it is, why it is
there, and what it means for you as the owner. The specification behind them
is [docs/PRD.md](../PRD.md) (in Indonesian); [docs/features.md](../features.md)
lists everything that is built.

## The owner

There is one human in PALUGADA, and it is you. There are no user accounts, no
passwords and no staff roles: you sign in with a code from your authenticator
app, and holding that authenticator is what makes you the owner. One
deployment can run many companies, and you own all of them.

Two rules run through the whole console. Anything that tightens a control (a
stop, a freeze, a lower ceiling, a kill switch) takes only your session,
because the moment something looks wrong is not the moment to find your
phone. Anything that loosens one (resuming, unfreezing, raising a ceiling,
approving a tier 3 action) takes a fresh code, so a stolen browser tab cannot
undo what you stopped.

Under **Settings**, **Company**, **Your hours** sets when you may be
disturbed. Outside them nothing reaches you except an incident.

## Company

A company is a set of divisions and roles working towards goals you set,
within a budget you set. Companies are isolated from each other in the
database: row-level security is forced on every tenant table, and a row
cannot even refer to another company's row. Many companies can share one
deployment safely.

A company is never deleted. It can be frozen (under **Settings**,
**Company**: nothing of its starts, and work in progress stops at its next
step), exported, or kept under its retention policy. **Stop everything**, at
the foot of the sidebar, halts every company at once and can be resumed;
**Cancel every task…**, in the menu under **Owner**, ends every task outright
and cannot be undone.

## Division

A division groups roles by function: Operations, Delivery, Growth and so on.
Divisions nest two levels deep at most. A division holds:

- its grants: the capabilities its roles may use, each at the catalogue's
  tier or a stricter one (**Capabilities it may use**);
- how many of its tasks may run at once (**Runs at once, at most**),
  across every worker. A sub-task that its own running parent is driving
  runs inside the parent's place rather than waiting for another;
- who hears about trouble first (**Who hears about trouble first**): a role
  such as the coordinator, for a number of minutes, and then you;
- its credentials, each named by an alias and stored as a reference to a
  secret, never the secret itself;
- a budget account under the company's.

Open a division by pressing its name on **Team**, **Divisions & roles**.

## Role

A role is one job in a division, such as the marketer or the bookkeeper. What
defines it:

- **Its charter:** who it is and how it works. Every run is given the
  platform's charter, the company's, and then the role's, before anything it
  reads, and none of them is ever dropped to fit the context.
- **Its done criteria:** one testable statement per line of what finished
  means. Work is checked against them before it counts as done.
- **Its output schema:** the shape its answer must have. Every role in the
  standard template returns a `summary`, and may return `artefacts`. An
  answer that does not fit is refused and the task tries again, up to its
  number of attempts; an input that does not fit the role's input schema
  stops the task at once.
- **Its tools:** the capabilities it may call, at most twelve, and only those
  its division is granted.
- **Its model:** a tier (`fast`, `standard` or `deep`) rather than a vendor's
  model name, so moving the company to another model is a deployment
  setting, not a change to every role.
- **Its runtime:** what does its work. See [Runtimes](#runtimes).
- **Who it is:** a name, a title such as CTO or Head of Support, and
  optionally a persona -- a way of working taken from someone whose way of
  leading is on the public record, with the owner's own notes. Every run is
  told these first, and that the persona is a way of thinking, never an
  identity: it is not that person and signs everything as itself.

A role sleeps until it is given work, woken by an event, or reached by its
heartbeat; a wake with nothing to do costs nothing. The badge on **Team**
says **Working**, **Asleep**, **Idle** or **Frozen**. A role that keeps being
denied, or spends much faster than usual, freezes itself and stays frozen
until you resume it. Every change to a role, a charter, a policy or a grant
is versioned. A role's earlier versions are under **History** in its
drawer, and a policy's under **Policies in force**; **Put this back** makes
one live again, as a change of its own.

## Project

A project groups work, such as a product line or a client, and grants
nothing, so starting one needs only your session. Every task belongs to one.
The standard template starts with one project, Main. A project can have its
own budget account.

## Task and its states

A task is one piece of work for one role, with an input, an output that must
fit the role's schema, a goal it serves, a priority (P0 first to P3 last), a
budget reservation and, optionally, a deadline. Every step a task takes is
written to its journal before it moves on, so a crash loses nothing: the next
worker replays the committed steps and never repeats an action with an
effect.

| State | Meaning | Shown under |
|---|---|---|
| `pending` | Waiting for a worker | **Running** |
| `checked_out` | A worker has claimed it and not started yet | **Running** |
| `running` | A worker is running it | **Running** |
| `waiting_approval` | Waiting for your decision | **Waiting** |
| `waiting_review` | Waiting for another role's review | **Waiting** |
| `waiting_window` | Allowed, but not at this hour; resumes when the window opens | **Waiting** |
| `completed` | Done, and its output fitted the contract | **Done** |
| `failed` | Ran out of attempts | **Stopped** |
| `halted` | Stopped itself for a reason that another attempt would not fix | **Stopped** |
| `cancelled` | You, an expired approval, or a freeze ended it | **Stopped** |

A halted task is never retried silently. Its reason is one of: a contract
violation, a policy denial, the budget, the hop limit, the deadline, a failed
read-back, an unhealthy capability, no runtime to run it, a cycle between
roles, a journal that no longer matches, or a crash loop (it lost its worker
three times). To try again, use **Do it again**, which starts a new task.

A task can hand part of its work to another role as a sub-task. The sub-task
draws on the parent's budget, has a timeout, and returns a bounded answer and
summary rather than its whole transcript.

## The CEO

Every company that has roles has exactly one CEO, and it is who the owner
talks to about the company: the conversation on the company's pages is with
it, in its name and persona, about its company and nothing else. The
database keeps the rule -- a second CEO is refused, and so is a change that
would leave none -- and the owner moves it by appointing another role,
never by a title. In the standard company the CEO is the coordinator.

## The coordinator

The coordinator is the Operations role in the standard template, and the
company's CEO. It is where work goes when you do not name a role. It decides whose job the work
is, delegates it with a brief that says what done looks like, waits for the
result and reports what came back. It does operations work itself, and it
does not contact anyone outside the company or ship anything.

It is also the first stop for trouble: in the standard template every other
division escalates to the coordinator, which gets an hour to fix the cause or
hand it on before you are told, with what it did.

## Capabilities and the catalogue

A capability is one thing an agent can do in the world, named by what it
does: `email.send`, `dns.update`, `invoice.pay`. The catalogue in
`src/broker/catalogue.ts` lists the capabilities every company has in common
and fixes each one's tier, with the reason it is not the tier above or below.

- The owner's assistant (**Ask PALUGADA**) is not a capability and belongs
  to no company: it reads the owner API and proposes its routes as cards the
  owner applies, so it can do nothing the owner could not do from the page,
  and nothing at all without them.
- The platform implements the ones that need nobody's account: `web.fetch`,
  `uptime.check`, `files.list`, `doc.draft`, `email.draft`, `memory.search`
  and `skill.read`; `web.search` and `web.extract` through the search
  provider you choose; `image.generate` and `speech.synthesize` through the
  picture and voice providers you choose, kept as files; `speech.transcribe`,
which writes down a recording in the company's files; and the tools a run uses to work inside the company:
  `plan.record`, `task.delegate`, `task.await`, `owner.ask`,
  `metric.record` and `stage.propose`.
- The rest need somebody's account and are bound by a vendor file you
  provide, or come from an MCP server you allow-list as
  `mcp.<server>.<tool>`. Until then they are known by name and refused with a
  message that says a vendor is needed.
- Every call goes through the broker, which checks the grant, the tier, the
  policies and the budget; a write is read back afterwards to verify it
  happened. A capability whose health check fails stops the task before it
  starts and raises an incident.
- Work that has read something written outside the company, such as an
  email, a web page or a customer record, carries that fact, and any tier 2
  or higher action in it asks you first.
- You can switch a capability off for every company at once under
  **Settings**, **Safeguards**, **Disable a capability everywhere**.

## The four tiers

Every capability sits at one of four tiers, set by its effect rather than the
tool that performs it. A grant can make a tier stricter and never looser.

| Tier | Effect | What happens | What it means for you |
|---|---|---|---|
| 0 | Reads | Runs | Nothing; it is logged |
| 1 | Cheap to undo | Runs, then is read back | Nothing, unless a policy asks you |
| 2 | Costs money or reaches people | Needs a recorded plan and a budget check, then is read back | You are asked when a policy says so, when the work read outside content, or when a trigger started it; these can be answered from Telegram |
| 3 | Irreversible | Waits for you | Always yours, in the console, with a fresh code. A chat message only links to it |

No template, policy, bundle or agent can move a tier 3 action out of your
hands. An approval covers exactly one action: a different amount or recipient
is a new question. An approval nobody answers expires, after 72 hours by
default, and its task is cancelled: silence never executes anything.

## Policies

Policies are rules written as data, at three scopes: the platform, the
company and a division. The platform's outrank the company's, which outrank
a division's, and a narrower rule may only tighten a broader one. When
several match, the strictest effect wins: **Allow**, **Require a review**,
**Require your approval** or **Deny**. A policy can also be set to be only
logged, to see what it would do.

A condition compares a field with a value. The fields are `tool`, `tier`,
`division`, `money_cents`, `recipient_domain`, `url_host`, `hour_local`,
`calls_in_window` and `stage`, and conditions combine with `all`, `any` and
`not`. With no matching policy, the tiers and grants decide alone. Policies
are on **Team**, **Policies**.

A review sends the action to a different role, with its own memory, before
it may act. After two revisions without agreement, the decision comes to you.

## Budgets and the spend guard

Tokens and money are reserved before a task starts and charged on every call.
Budgets are a tree of accounts: the company's at the root, and accounts for
projects, divisions and roles under it. A task draws on the narrowest account
that covers it, and a spend counts against every account above it, so raising
a division's ceiling cannot raise the company's.

On top of the accounts, each company has a monthly ceiling, USD 200 unless
you change it, counted per calendar month in UTC.

- At 80% you are told once: "Monthly budget is 80% spent".
- At 100% the company pauses: no new task starts and no external action runs
  until you raise the ceiling or override the pause until a time you choose.
- A role that spends more than three times its seven-day hourly average in
  one hour is paused while there is still money left, and you get an
  incident.
- Usage a runtime did not price is charged at a deliberately high rate until
  the deployment's price list (`PALUGADA_MODEL_PRICES`) names the model.

Raising a ceiling takes your code; lowering it does not. All of this is on
the **Money** page. Separate alert thresholds for daily cost, failure rate
and policy denials are under **Settings**, **Company**, **Alert thresholds**.

## The inbox

The inbox is everything waiting on you, most urgent first: tier 3 actions,
then incidents, then the oldest. Each item says what will happen, why, what
happens if you refuse, the goal chain it serves, the tier and the estimated
cost, and opens the step-by-step trace behind it.

| Badge | What it is | What you do |
|---|---|---|
| approval | An action that needs your yes | **Approve**, **Deny**, or **Ask a question** back; the task carries on, is cancelled, or reads your question |
| question | An agent asked you something with `owner.ask`, and its task waits | Pick one of the options it offered, or write **Your answer** and press **Send the answer**; **Stop the task** cancels it |
| question | An escalation: a division is stuck, or a role proposes a goal change or a stage move, or a schedule keeps producing the same result | Approve or deny it, or use **Answer the agent instead** to reply without deciding |
| incident | Something went wrong: a failed read-back, a crash loop, a broken capability, a role spending too fast | Deal with the cause; deciding the item closes it, with your note |
| procedure, skill | Something the company learned, waiting for your yes before any agent uses it | Approve or deny |
| budget | 80% or 100% of the month's ceiling | Raise the ceiling or override the pause on **Money**, or leave it paused |

Items can be put off with **Later** (never past their expiry), and several
drafts can be decided at once with **Choose several**; tier 3 actions,
questions and incidents are always decided one at a time. Decided items move
to **History** with your note, and your notes are searched too.

## Goals and measures

Goals form a ladder: a mission, objectives under it, key results under those.
Every task names the goal it serves, and the chain travels into every
approval so you can see why the work exists. Agents read goals and never
change them; one that thinks a goal is wrong proposes a change in your inbox.

A goal can be measured by a number: a unit (money, a count, a percentage or a
ratio), which way is better, a baseline, a target, a date, and optionally the
capability whose answer is the number. A value an agent records counts as
verified only when the same task read it from that source; otherwise it is
shown as the agent's claim. Until a goal has a measure, progress is counted
in tasks: the ones finished against the ones meant to be done, so a
cancelled task, or one you asked for again, is not left owing.

Closing a goal -- **Met** or **Abandoned** -- stops the work under it. Its
schedules and triggers, and those of every goal beneath it, are paused in
the same step and you are told how many; no new work can be started under it
or under a goal beneath it; and a run already under it is told the goal is
closed, so it can wind down. Reopening a goal lets work start again and
leaves what was paused for you to turn back on.

A measure can be put right -- its name, baseline, target and date -- or
retired, from **Change** beside it; both take a code, because every run on
the goal aims at the target. A retired measure keeps its history, leaves
the runs and the portfolio, and takes no more values.

## Stages

A company has a stage: explore, validate, build, launch, grow or wind down.
You set it on the **Overview**. Every run is told the stage and what it is
for, and policies can read it, so "no paid advertising before launch" is a
rule rather than a hope. Moving forward loosens those rules, so it takes your
code; moving into wind down only closes things. The strategist may propose a
move with the evidence; the move itself is always yours.

## Memory and distillation

The company keeps four kinds of memory: working memory (one task's steps),
episodic memory (the event log), semantic memory (facts) and procedural
memory (ways to work). Memory is scoped to the company, a project or a
division, and a run only sees what its scope allows.

A fact is never overwritten: a correction supersedes it, and the old version
is kept, marked as replaced. Facts the platform is unsure of are flagged to
the agents in plain words. When a model is configured, the worker distils the
event log once an hour into facts, and a pattern seen three times into a
proposed procedure, which reaches no agent until you approve it.

On the **Memory** page you can search what the company knows, confirm a fact
(**It is true**), **Correct** one, or **Tell the company something**, either
**A fact to know** or **A way to work**. Your own word is placed first in
every run it applies to.

## Skills

A skill is a written procedure in the open SKILL.md format: front matter and
a body. A run's context carries each active skill's summary, and the run
reads the whole text with `skill.read` when it needs it. A new version is a
candidate until a different role reviews it and you approve it, and a skill
with no eval case cannot be activated. Skills imported from outside start
quarantined to one division until you lift the quarantine. Skills are
under **Settings**, **Skills**.

## Bundles

A bundle is a package of divisions, roles, grants, policies, skills with
their eval cases, and schedules, installed into a company. The built-in ones
are `company-os`, `content-ops`, `web-ops`, `qa-review` and `palugada-dev`
(PALUGADA's own engineering team; see [AGENTS.md](../../AGENTS.md)). A bundle
signed by a publisher you trust installs as written, and so does a built-in
one that is exactly what this version ships. Any other unsigned bundle,
including a built-in one somebody changed, installs quarantined: only grants
it names at tier 0 are created, its schedules start switched off, and its
policies that allow something are left out. A bundle's skills always arrive as candidates for review and your
approval. Bundles are under **Settings**, **Bundles**.

## Runtimes

A runtime is what does a role's work. The engine never calls a model to do a
task itself; it lends the runtime tool calls through the broker, journalled
steps, sub-tasks and a way to report cost.

| Runtime | What it is |
|---|---|
| `in-process` | The platform's own loop with the configured model. Every role the templates create uses it |
| `claude-code`, and other agent CLIs | A headless agent CLI run as a child process in a private directory of its own, with none of its own tools and the role's granted capabilities as its only tools |
| `http` | A runtime behind a URL, spoken to in turns |
| `docker` | A runtime in a container with no network at all |
| A remote sandbox | A runtime in a sandbox a provider runs |

A runtime never receives a credential or a database connection. A runtime
that fails its health check is given no work, and its task goes back to the
queue. You move a role between runtimes in its **Who does its work**
section. A machine outside the deployment can also run agents as a device:
it registers its public key under **Settings**, **Devices**, does nothing
until you pair it by the fingerprint of its key, and only reads until you
lift its quarantine.

## Schedules, heartbeats, handoffs and triggers

- A *schedule* starts work for a role on a cron expression, in the
  schedule's own time zone, with a priority. A schedule whose last five runs
  produced the same result asks you whether it is still worth running.
- A *heartbeat* wakes a role every so many minutes to look for work.
- A *handoff* starts a role's work when another role finishes, with your
  brief and what the first one produced.
- A *trigger* is a URL another service posts events to, such as a payment
  received or a form filled in. It checks a token, or the sender's own
  signature for Stripe, GitHub, Slack and Standard Webhooks, and allows a
  number of events an hour. Each event becomes one task; what it says is
  treated as data, and the work it starts takes no tier 2 or higher action
  without you.

Schedules, handoffs and triggers are tabs on **Team**; a role's heartbeat is
shown in its drawer there. Cheap hours (under **Settings**, **Company**) hold
non-urgent work that only reads until a window you choose.

## Languages

Each company has two languages. The work language is what it produces for
its customers: documents, emails, content, code comments. The talk language
is what its agents write to you and to each other: approvals, questions,
plans and reports. Either can be left to the deployment's default. Every run
is told its languages right after its charter, and told that nothing it
reads can change them. What agents write is checked: a slip is recorded and
the role's next run is reminded of it. The console's own panel language is a
third, separate setting.

## The audit trail and export

- The event log is append-only: every step, call, cost, decision and
  change, with security events recorded separately.
- The **Governance log** under **Settings**, **Safeguards** lists every
  change to a charter, a policy, a role or a grant, and who made it.
- **History** keeps every decision with your note, and every item that
  closed without one.
- A task's **What it did** and **What it said** show its events and its
  transcript, and **Replay against the journal** runs it again with every
  side effect answered from the record, so nothing leaves.
- Retention is the only thing that deletes, and it records what it removed.
  Events are kept at least a year and prompts at least ninety days
  (**Settings**, **Company**, **Retention**).
- **Download as JSON** under **Settings**, **Company**, **Export** writes
  the whole company to one file that can be restored on another deployment,
  with every reference remapped. Credentials travel as references only.
