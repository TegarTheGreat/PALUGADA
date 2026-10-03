# Concepts

Each section explains one idea the console shows you: what it is, why it is
there, and what it means for you as the owner. The specification behind them
is [docs/PRD.md](../PRD.md) (in Indonesian); [docs/features.md](../features.md)
lists everything that is built.

## The owner

There is one owner in PALUGADA, and it is you. There are no user accounts
and no passwords: you sign in with a code from your authenticator app, and
holding that authenticator is what makes you the owner. One deployment can
run many companies, and you own all of them.

You can seat other people beside you, each for one company, under
**Settings**, **People**. A **viewer** follows the company's work; an
**approver** also approves or denies what waits at tier 2 and below. You
make an invite with your device and send them the link; opening it, they
add PALUGADA to their own authenticator app and sign in with its codes.
Their code is never yours: tier 3, settings, keys, devices and anything
that loosens a control stay yours, and **End the seat** signs them out at
once.

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

A company is never deleted piece by piece. It can be frozen (under
**Settings**, **Company**: nothing of its starts, and work in progress stops
at its next step), exported, or kept under its retention policy; or it can be
closed, which freezes it at once and erases every row of it when the grace
period you chose, from 7 to 90 days, ends (see Close a company in the
how-to). **Stop everything**, at
the foot of the sidebar, halts every company at once and can be resumed;
**Cancel every task…**, in the menu under **Owner**, ends every task outright
and cannot be undone.

## Division

A division groups roles by function: Operations, Delivery, Growth and so on.
Divisions nest two levels deep at most. A division holds:

- its grants: the capabilities its roles may use, each at the catalogue's
  tier or a stricter one (**Capabilities it may use**), and for any of them,
  how many calls may be under way at once, up to 100;
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
  means. A run answers each of them in its output -- met or not, and what
  in its work shows it -- and work that leaves one out, says one is not
  met, or shows nothing for one does not count as done: the task tries
  again, told why. The answers are shown with the work, under **Done
  means**. Evidence may cite a tool call by its step in the task's journal
  (`step:3`): the platform checks that this task made the call and that it
  succeeded, and shows the criterion as **Verified**. Evidence that cites
  nothing is the run's own account, shown as **Claimed**; one that cites a
  step that failed, or that the task never took, does not count as met.
  Verified means the call succeeded, not that it proves the criterion:
  whether the evidence holds is yours, or a reviewer's, to judge. Code a
  deployment registers as a role's handler is checked by its own tests
  instead. You change them
  from the role; a criterion that needs a vendor says what counts when it
  is not connected, and a run is told which of its tools are not.
- **Its tools:** what it may call, within its division's grants. A tool
  nothing in the deployment is bound to yet -- a CRM, a mail provider -- is
  not offered to a run, and the run is told so.
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
own budget account, and its own work language (see Languages).

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
| `waiting_window` | Waiting for something other than your decision: work it handed on, its work hours, cheaper hours, a service that said not now, its turn at a busy tool, the model, or its next attempt. The line under its progress says which | **Waiting** |
| `completed` | Done, and its output fitted the contract | **Done** |
| `failed` | Ran out of attempts, or its run said it did not do what was asked (**Not done**) | **Stopped** |
| `halted` | Stopped itself for a reason that another attempt would not fix | **Stopped** |
| `cancelled` | You, an expired approval, or a freeze ended it | **Stopped** |

Under a task, the bar counts the actions its plan named that it has taken:
a plan of five actions with two done reads 2/5, wherever it stopped. A task
waiting on work it handed on names the role it is waiting for, and when
something below it, at any depth, is waiting for your answer, it says so in
orange: "Waiting until you answer Nadia".

A run that did not do what it was asked -- it could not, or it needed a
decision it could not get -- says so, and the task ends as **Not done** with
the run's reason, shown on the task and sent to your chat for work you gave.
It is not tried again, since another attempt on the same facts would reach
the same answer. Answer what it needed, then use **Do it again**.

A halted task is never retried silently. Its reason is one of: a contract
violation, a policy denial, the budget, the hop limit, the deadline, a failed
read-back, an unhealthy capability, no runtime to run it, a cycle between
roles, splitting into more sub-tasks than it may have, one run writing more
tokens than its role allows a run, a journal that no longer matches (a role
run as code in this process that took other steps when it ran again), or a
crash loop (it lost its worker three times). To try again, use **Do it
again**, which starts a new task. What the stopped task already wrote or
sent is not done a second time: the new task is told it, and a write it
repeats word for word is answered from the old task's record.

A task its budget stopped is the exception. It puts an item in your inbox
naming the work and the account that has no tokens left, and it reaches your
chat as news with a link (never a push, which is kept for incidents and tier 3
approvals). Raise that account's ceiling on **Money**, then open the task and
press **Continue**. It goes on from where it stopped, as the same task: what
it already did is answered from its journal and not done again. It is never
continued by itself.

A task past its deadline is halted even if no worker ever picked it up. A
write whose read-back fails ends the run there: the run cannot write again,
you get an incident, and nothing is retried, because a second attempt could
pay or send twice. A task that fails and is tried again is told why the
attempts before it failed. A role's **tokens per run** is enforced on every
run, counted in what the run writes: each turn of a conversation sends the
whole of it again, so counting that too would stop ordinary runs, while a
run that loops is one that keeps writing. The budget bounds the rest.

A task can hand part of its work to another role as a sub-task. The sub-task
draws on the parent's budget, has a timeout, and returns a bounded answer and
summary, with what it cost, rather than its whole transcript. A task's cost
is its model calls and what the vendors it used charged.

## The CEO

Every company that has roles has exactly one CEO, and it is who the owner
talks to about the company: the conversation on the company's pages is with
it, in its name and persona, about its company and nothing else. The
database keeps the rule -- a second CEO is refused, and so is a change that
would leave none -- and the owner moves it by appointing another role,
never by a title. In the standard company the CEO is the coordinator.

## Tickets

A ticket is work that is owed and not yet anyone's: filed by a role with
`ticket.create` or by you, read by the CEO with `ticket.list`, and handed
on with `task.delegate` or from **Work**, **Tickets**. A ticket being worked
names the task working it and closes when that task completes; if the task
ends any other way, the ticket opens again with the reason. Tickets are
closed, never deleted, and travel in a company's export.

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
  `uptime.check`, `files.list`, `files.read`, `doc.draft`, `email.draft`, `memory.search`
  and `skill.read`; `mailbox.read` and `email.send` with a division's own
  mailbox; `web.search` and `web.extract` through the search
  provider you choose, and `web.extract` in the deployment's own browser
  until you choose one; `image.generate` and `speech.synthesize` through the
  picture and voice providers you choose, kept as files; `speech.transcribe`,
which writes down a recording in the company's files; and the tools a run uses to work inside the company:
  `plan.record`, `task.delegate`, `task.await`, `owner.ask`,
  `metric.record`, `stage.propose` and `goal.propose`.
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

## Charters

A charter is what every run is told before anything else. There are three,
read in this order and never dropped to fit the context: the platform's,
which every company on the deployment works under and none can set aside;
the company's, which says what it is for and how it works; and the role's.

A new deployment starts with a short platform charter, and a company made
from a template with one that names it and its mission. Both are yours to
rewrite on **Team**, **Charter**: each change asks for your authenticator,
and every version of the company's is kept and can be put back. A platform
charter still word for word the default an earlier version started with is
given the current default, as a new version, when the platform next starts;
one you have written, or put back, is never replaced. A reviewer
reading a proposed skill judges it against the charters and the policies.

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
a division's ceiling cannot raise the company's. An account's tokens and money
are counted per calendar month in UTC: on the first of each month the count
starts again, and raising a ceiling is how an account that ran out gets more
before then.

Money is in US dollars everywhere: providers price their models in dollars,
and every amount the console shows, and every ceiling you type, is in
dollars, written the way your language writes them ("US$1.234,50" in
Indonesian). If you think in another currency, choose it under **Settings**,
**Languages**, **How you read money**, with the rate to read amounts at:
every amount is then shown and typed in it, and the daily digest in your
chat gives both. PALUGADA still counts in dollars, and never fetches a rate:
it is yours to keep up to date.

On top of the accounts, each company has a monthly ceiling, USD 200 unless
you change it, counted per calendar month in UTC. It counts every model call
the company makes, not only its tasks': your conversations with its CEO and
the nightly distilling of its memory are its spending too. Those two draw on
no account, since they are not work an account was reserved for, and your
conversation is never refused for money; a company paused at its ceiling
stops distilling until it is resumed. PALUGADA's own assistant belongs to no
company, and what it costs is shown on its own line under **Every company**
on **Money**.

- At 80% you are told once: "Monthly budget is 80% spent".
- At 100% the company pauses: no new task starts and no external action runs
  until you raise the ceiling or override the pause until a time you choose,
  or the month ends. The pause is the month's: the first check of the next
  month lifts it, and its card is withdrawn.
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
| question | An escalation: a division is stuck, or a role proposes a goal change or a stage move, or the critic stopped a stage move, or a schedule keeps producing the same result | Approve or deny it, or use **Answer the agent instead** to reply without deciding |
| incident | Something went wrong: a failed read-back, a crash loop, a broken capability, a role spending too fast | Deal with the cause; deciding the item closes it, with your note |
| procedure, skill | Something the company learned, waiting for your yes before any agent uses it | Approve or deny |
| budget | 80% or 100% of the month's ceiling | Raise the ceiling or override the pause on **Money**, or leave it paused |
| budget | A task stopped because an account has no tokens left | Raise that account's ceiling on **Money**, then open the task and press **Continue** |

Items can be put off with **Later** (never past their expiry), and several
drafts can be decided at once with **Choose several**; tier 3 actions,
questions and incidents are always decided one at a time. Decided items move
to **History** with your note, and your notes are searched too.

## Goals and measures

Goals form a ladder: a mission, objectives under it, key results under those.
Every task names the goal it serves, and the chain travels into every
approval so you can see why the work exists. Agents read goals and never
change them; one that thinks a goal is wrong proposes a change in your inbox
with `goal.propose` -- new words, or closing it as met or abandoned -- with
its evidence. Approving it, with your code, makes the change; a proposal
about a goal you have changed since is refused, and saying no leaves the
work that proposed it running.

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

With the operating kit (`company-os`), a company winding down starts nothing
new -- no advertising and nothing bought, whoever asks -- and every other
action at tier 2 or above outside the finance division comes to you to
approve, so a reply to a customer who is owed one is yours to let through
rather than refused. You may allow a role's replies for a while instead of
one by one, where the work read nothing from outside.

With `company-os`, a critic reads every stage proposal before you do. It is
in a division of its own, and it cannot change anything. When it supports a
move, its verdict is on the card you answer. When it opposes one, you are not
asked to approve the move; an item tells you what was proposed, on what
evidence, and why the critic stopped it. You can still set the stage
yourself.

## Memory and distillation

The company keeps four kinds of memory: working memory (one task's steps),
episodic memory (a line for each piece of finished work: what it was for and
what it reported), semantic memory (facts) and procedural memory (ways to
work). Memory is scoped to the company, a project or a division, and a run
only sees what its scope allows: facts and ways to work belong to a division
unless shared, and past events to a project, so `memory.search` asked for
past events searches the finished work of the run's own project. An event
from work that read outside content comes back as data, like such a fact.

A fact is never overwritten: a correction supersedes it, and the old version
is kept, marked as replaced. Facts the platform is unsure of are flagged to
the agents in plain words.

The company learns from its work in two ways. A run may end with up to five
short lessons ("Cafes in Bandung reply fastest on WhatsApp"), and when a
model is configured the worker reads the goals and summaries of finished work
once an hour for facts, and turns a pattern seen three times into a proposed
procedure, which reaches no agent until you approve it. Either way a lesson
starts unverified, at half confidence, and the same lesson learned again,
whatever its case and punctuation, is the same fact made a little surer --
never surer than 0.8 without you. A lesson from work that read outside
content (an email, a web page, a customer's message) is marked as such and is
shown to every run as the data it came from, never as a known fact, however
often it is learned: that is how an instruction hidden in an email would
otherwise become the company's belief.

The company also keeps **documents**: anything longer than a fact, kept
whole and split into passages under their headings. `memory.search` returns
the passages a question's words point at, from the documents a division may
read; runs are told which documents exist. They are matched by their words,
with no embedding model needed.

On the **Memory** page you can search what the company knows, one division at
a time, see where each fact came from and open the work that taught it,
confirm a fact (**It is true**), **Correct** one, **Take back** one that is
wrong, or **Tell the company something**, either **A fact to know** or **A
way to work**. Your own word is placed first in every run it applies to, in
five places of its own, so your notes never push the company's approved
procedures out of a run.

## Skills

A skill is a written procedure in the open SKILL.md format: front matter and
a body. A run's context carries each active skill's summary -- the live
version's own description -- and the run reads the whole text with
`skill.read` when it needs it, for a skill its division may use. A new
version is a candidate: checked against the phrases its checks name, given
to the company's reviewer as a piece of work, and switched on only when you
say yes after the reviewer has. A skill with no check cannot be activated.
Skills imported from outside start quarantined to one division until you
lift the quarantine, and a run that reads one is given it as data from
outside. Skills are under **Settings**, **Skills**.

## Bundles

A bundle is a package of divisions, roles, grants, policies, skills with
their eval cases, and schedules, installed into a company. The built-in ones
are `company-os`, `content-ops`, `web-ops`, `qa-review` and `palugada-dev`
(PALUGADA's own engineering team; see [AGENTS.md](../../AGENTS.md)).
`company-os` is the operating kit: a strategist that proposes bets, stage
moves and goal changes and applies none; the stage rules; skills for
validating an idea, premortems, pricing, unit economics, customer discovery,
positioning, market research, launch readiness, outbound messages and the
weekly review; and the weekly business review itself, on Monday morning in
the company's time zone. That review is handed the week from the company's
records, not from a model: every active goal with its numbers -- the latest,
whether it was verified, and the change over the week -- the work finished,
the spend against the monthly limit, and any stage move waiting for you.
A week with nothing in it -- no work started or finished other than the
review's own, no measure recorded -- is not reviewed: the clock passes it
over and the company's history says so. **Run now** runs it anyway.

A bundle signed by a publisher you trust installs as written, and so does a built-in
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
  While its last run is still going, it skips the next occurrence, waits
  for the run to finish, or runs beside it, as you choose; skipping is the
  default. After downtime it runs one catch-up, or, with a catch-up window,
  drops an occurrence too late to be worth running. Either way the table
  says which occurrence did not run and why. You can also run one now,
  once, without moving its next occurrence; not while a task it made is
  still under way.
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
plans and reports. Either can be left to the deployment's default. A
project may have its own work language, for a company that sells in more
than one market: a project for Malaysia writes its customers' copy in Malay
and one for Brazil in Brazilian Portuguese, while the agents in both still
talk to you in the company's talk language. A project without one works in
the company's. Every run is told its languages right after its charter --
the work language of its own project -- and told that nothing it reads can
change them. What agents write is checked, Javanese and Sundanese included:
everything they write to you or to another role -- plans, questions, the
summary of finished work, briefs, tickets, proposals and reviews -- against
the talk language, and drafts against the work language of their project. A
slip is recorded, never refused, and the role's next run is reminded of it
and told what it slipped in. The console's own panel language is a
third, separate setting: what the console and PALUGADA's own messages to you
are written in. A company can write in more languages than the console is
drawn in, since a model writes many more than anyone has translated the
console into.

## The audit trail and export

- The event log is append-only: every step, call, cost, decision and
  change, with security events recorded separately.
- The **Governance log** under **Settings**, **Safeguards** lists every
  change to a charter, a policy, a role or a grant, and who made it.
- **History** keeps every decision with your note, and every item that
  closed without one.
- A task's **What it did** and **What it said** show its events and its
  transcript, and **Replay against the journal** -- for a role this
  deployment runs as code in its own process -- runs it again with every
  side effect answered from the record, so nothing leaves.
- Retention is the only thing that deletes, and it records what it removed.
  Events are kept at least a year and prompts at least ninety days
  (**Settings**, **Company**, **Retention**). Finished work goes once both
  the event and the trace windows have passed it, with its steps, runs and
  cards; work that is still talked about, has a card still open in your
  inbox, or that later work was done again in place of or handed on from,
  stays.
- **Download as JSON** under **Settings**, **Company**, **Export** writes
  the whole company to one file that can be restored on another deployment,
  with every reference remapped. Credentials travel as references only.
