# Changelog

What an owner or an operator would notice, by version. Which version is
running is on `/api/health`, in the metrics as `palugada_build_info`, and at
the foot of the owner's menu in the console. [docs/STATUS.md](docs/STATUS.md)
has each change in detail, with the defects found on the way to it, and
`docs/PRD.md` the requirement each one answers.

Migrations are append-only and run in order; `npm run db:migrate` brings any
earlier database up to the version it is run from, and refuses a migration
whose file changed after it ran.

## 0.1.0 (not yet released)

The first version. What it holds, in the order an owner meets it.

### Running companies

- Companies of AI agents with one human owner: divisions, roles with
  charters, personas and a mandatory CEO the owner talks to, projects,
  measurable goals, tickets, schedules, handoffs and inbound triggers.
- The platform's and each company's charter kept as files in a git
  repository beside the deployment, edited there or in the console
  (STATUS 2.44).
- Every step journalled, so a crash loses nothing; money and tokens reserved
  before work starts; leases, deadlines, per-run length and token ceilings;
  tasks at once per division and calls at once per capability, across every
  worker (STATUS 2.43).
- Any model through an OpenAI-compatible client, and any agent CLI (Claude
  Code, Codex, Gemini CLI, OpenCode, OpenClaw, Hermes), any agent that
  speaks the Agent Client Protocol (STATUS 2.42), a script, an HTTP service
  or a container as a role's runtime. A runtime in another process may call
  only its role's tools (STATUS 2.37).
- Memory that learns from real work and keeps what came from outside as data;
  the company's documents, found by their words and by their meaning
  (STATUS 2.35).
- Capabilities from vendor files, MCP servers (Composio, Pipedream, Arcade,
  Smithery and Zapier by name) and the platform's own, each at a tier.
- Coolify's and Dokploy's MCP servers by name, so a company's roles can see
  what runs there and, as far as the owner allows, deploy it (STATUS 2.54).
- The operating kit (`company-os` 1.4.0): a weekly business review handed
  the week from the company's records -- every goal's numbers and their
  change, the work finished, the spend against the limit, a stage move
  waiting -- goal changes a run proposes and the owner's yes applies, a
  critic that reads every stage proposal before the owner does and holds
  nothing that acts, a wind-down that puts a reply to a customer to the
  owner instead of refusing it, past events a run can search, and skills for
  positioning and market research (STATUS 2.53, 2.57).
- Done criteria whose evidence may cite a tool call by its step: the
  platform checks it against the journal and shows each criterion as
  verified or only claimed (STATUS 2.56).
- A schedule no longer starts a second run beside one still going: it
  skips the occurrence (the default, existing schedules included), waits
  for the last run to finish, or runs both, as the owner chooses; and a
  catch-up window drops an occurrence found too late after downtime. The
  schedules table says which occurrence did not run and why (STATUS 2.59).

- Schedules right on the nights the clock changes: a daily job runs once
  when the clock goes back and once, at the jump, when it goes forward; an
  hourly one keeps to real time; and a work window opens on its own zone's
  hour where that is not an hour of UTC, such as in Kolkata or Adelaide
  (STATUS 2.60).
- The console, and what PALUGADA sends the owner's phone, in 21 languages:
  English, Indonesian, Malay, Javanese, Sundanese, Filipino, Vietnamese,
  Thai, Simplified Chinese, Japanese, Korean, Hindi, Arabic (right to left),
  Spanish, Brazilian Portuguese, French, German, Dutch, Italian, Turkish and
  Russian. Why an approval was withdrawn, or a pressed button found its item
  closed, is said as a sentence in each rather than as a status code
  (STATUS 2.65).
- A new company is asked its languages as it starts: its work and talk
  languages begin in the language the console is in, and either can be
  changed on the form. It used to start in the deployment's default, so a
  company started from an Indonesian console answered in English
  (STATUS 2.74).
- A project may have its own work language, for a company that sells in
  more than one market: runs in a Malaysia project write for customers in
  Malay and drafts there are checked against Malay, while agents still talk
  to the owner in the company's language. Set it when starting or editing a
  project; left unset, the project works in the company's (STATUS 2.63).
- Everything an agent writes to the owner or to another role -- a question,
  the summary of finished work, a brief it hands on, a ticket, a goal or
  stage proposal, a reviewer's reasons -- checked against the company's talk
  language as plans were, Javanese and Sundanese included; a slip is recorded,
  never refused, and the role's next run is told what it slipped in
  (STATUS 2.64).
- The CEO, and any role that hands work on, is told which roles the company
  has. It may name one by title or name ("the CMO", "Laras") as well as by
  slug. A name that fits no role is answered with the roles there are and
  the nearest one, so routing no longer ends in guesses and probe tasks
  (STATUS 2.66).
- Work a role hands back is no longer refused for being long. A finished
  plan or report over what a sub-agent may hand back reaches the role that
  asked for it cut short, with each cut saying where the whole is kept; the
  whole stays on the task that did it. A task shows the work it handed on,
  with what each piece came to and a button to open it, so the plan asked of
  the CEO is one press from the CEO's task (STATUS 2.67).
- An agent's question reaches you unless it plainly asks how to wire in a
  tool nobody connected. A question that only mentions such a tool, or
  that offers answers to choose from, is yours. Before, "whom should I
  email?" in Indonesian, and a decision to delete a customer's record, were
  answered by the platform instead of you (STATUS 2.68).
- Work its budget stopped reaches you. An item in your language says which
  work stopped and which account has no tokens left, and it comes to your
  chat as news with a link; budget alerts reach the chat now too. Raise the
  ceiling on Money, then press **Continue** on the task: the same task goes
  on from where it stopped instead of starting again (STATUS 2.69).
- A model turn the budget cannot pay for is not asked. Each turn is given no
  more room to write than the budget has left, so a reasoning model that
  keeps thinking stops at the ceiling instead of past it (STATUS 2.70).
- A budget account's tokens and money are counted per calendar month (UTC),
  as F1.9 asks: an account that ran out has its allowance again on the
  first, and raising its ceiling gives it more before then. Before, spent
  tokens stayed spent for the account's whole life (STATUS 2.71).
- A task's bar counts the actions of its plan it has taken. It counted
  every step, model turns included, so a task that halted early could
  read "5/5" (STATUS 2.75).
- A waiting task says what it waits for: the role it handed work to, its
  work hours, a model, a vendor, or the next attempt, and in orange when
  something below it waits on your answer. The word "Scheduled" is gone
  (STATUS 2.76).
- Work a run did not do ends as "Not done", with the run's reason on the
  task and in the chat, rather than "Done" in green. It is not tried again
  on the same facts (STATUS 2.77).
- Conversations with a CEO and the distilling of a company's memory are
  counted in its spending and its monthly ceiling; PALUGADA's own
  assistant's cost is shown under **Every company** on **Money**
  (STATUS 2.78).
- A company paused at its monthly ceiling takes work again when the month
  ends, and the card that said it was paused is withdrawn. The pause used
  to last until you lifted it by hand, into the next month and beyond
  (STATUS 2.80).
- A service that is busy or not answering for a moment no longer halts the
  work that needs it for a quarter of an hour: the task waits, looking
  again, and stops with one incident only if the service stays down for
  about half an hour (STATUS 2.83).
- What a run said is in its transcript once. A run resumed after an
  approval or a wait said its earlier lines again, with new times, each
  time it resumed (STATUS 2.88).

### The owner

- One inbox for what cannot be undone: approvals bound to their action, a
  second factor for tier 3 and for every loosening, standing approvals for a
  while (STATUS 2.28), passkeys and recovery codes (STATUS 2.32).
- A guardian a company may turn on: after the work reads something from
  outside, a model looks at each small action and may send it to the owner,
  never let one through (STATUS 2.45).
- Told on Telegram, WhatsApp, a phone push, Slack, Discord or email, and able
  to decide on Telegram and WhatsApp (STATUS 2.31, 2.41).
- A console set up entirely from the panel -- the model, agent CLIs, tools,
  channels, services and MCP servers -- in the owner's language, with every
  message PALUGADA sends the owner in the same language, each language's
  plural forms, and a decision or a task's end said as a sentence rather
  than a code (STATUS 2.62, 2.65).
- Export and import of a whole company, and closing one, which erases every
  row of it after a grace period the owner chooses (STATUS 2.38).
- **Run now** on a schedule: the task its next occurrence would make, at
  once, with that occurrence left where it was; an off schedule can be tried
  this way and stays off, and a second press while the run is still going is
  refused and links to it (STATUS 2.61).
- A schedule can be switched off and on again and removed from its row, and
  a new one is set by days and a time in your own time zone, such as every
  weekday at 07:00 WIB, rather than as cron in UTC. Saving one again no
  longer turns it back on, and a new one cannot overwrite another under the
  same short name (STATUS 2.86).
- The weekly business review no longer runs on a week with nothing in it,
  such as the first week of a new company; the history says it was passed
  over. **Run now** still runs it, and its dialog says the most one run may
  spend, not only the 1,000 tokens it reserves (STATUS 2.97).
- Signing in to an MCP server takes your code, as signing a division in for
  a key does: what the sign-in gives is what a saved server of that name
  uses from then on, and a session alone could change whose account that
  was (STATUS 2.79).
- Each opening of a deployment's claim link is shown a secret of its own,
  and only the page that showed it can make it yours. Everyone who opened
  the link used to be shown the same one, so whoever saw it first kept a
  copy of your authenticator (STATUS 2.82).
- A question you ask on an approval card reaches the agent, and its answer
  appears on the same card for you to decide on. The agent never read it:
  it repeated its request and the card waited again (STATUS 2.89).
- An answer to an agent's question given through the owner's assistant now
  answers it. The question stayed open, so the agent asked it again and
  waited, however often it was answered (STATUS 2.90).
- **Do it again** on work that did not finish carries on from it: the new
  task is told what the stopped one wrote or sent, and a write it repeats
  word for word is answered from the record instead of being sent twice
  (STATUS 2.91).
- An agent CLI or another runtime outside the process, resumed after your
  answer or a restart, carries on in its own order and words. Its first call
  out of the old order was refused, and a later one could overwrite an
  unanswered question, so a task could finish without reading your answer
  (STATUS 2.92).
- Everything on a task's timeline and under **Lately** is said in your
  language, and who did it is "You", "The agent", "A schedule" or "The
  platform". Most events were shown as their codes in English -- "Content
  read outside", "Task running" -- beside "engine" or "broker", and a step
  as "Model:turn 2" (STATUS 2.94).
- An agent's question reaches you headed by the name you gave its role --
  "A question from Sari", and in a chat "Sari bertanya:" -- instead of
  "bookkeeper asks:" in English, and a chat says the question once
  (STATUS 2.95).
- An approval is headed by what the action does -- "Delete a record:
  recordId cust-042" -- and the timeline, the trace and the progress line
  name capabilities the same way, in your language, instead of
  "record.delete". An approval's reason no longer starts with the task's id
  (STATUS 2.96).
- Money says its currency: every amount is US dollars, written the way your
  language writes them ("US$0,75"), the cost chart included, and ceilings
  and the daily-cost alert are typed in dollars rather than cents
  (STATUS 2.98).
- **Replay against the journal** is shown only for a task this deployment
  can replay. It was offered on every task and refused on every task a
  model or an agent CLI ran (STATUS 2.87).

### Operating it

- A refreshed OAuth token, for a vendor key or an MCP server, no longer
  restarts the deployment. Each refresh moved the settings version that
  every replica watches, so a division signed in to Google restarted all of
  them about once an hour (STATUS 2.72).
- The language check on what agents write no longer freezes the worker on
  text full of `@`, such as a list of Instagram handles; four thousand
  characters of it took 6.5 seconds (STATUS 2.73).
- A worker back from a database outage, or a stall of its own, no longer
  takes the running tasks of every other worker as if they had died; it
  gives them the minute to say they are alive first. One outage could halt
  live work as a crash loop (STATUS 2.81).
- A task the worker could not start -- the database refusing a write as it
  began -- goes back on the queue at once with the reason, instead of
  sitting as running for fifteen minutes with none (STATUS 2.84).
- A stray failure nothing handled no longer kills the process outright: a
  promise nothing awaited is written down and the process goes on, and an
  exception nothing caught stops it as a signal would, handing runs back,
  before it exits for the supervisor (STATUS 2.85).
- Retention now removes finished work too, once both the event and trace
  windows have passed it: the task with its journal, runs and cards. Work
  that is still talked about, has a card open in your inbox, or that later
  work came from stays. Until now every task, step and card was kept for
  ever (STATUS 2.93).
- Tenants separated by forced row-level security, composite keys between
  tenant tables, and an application role with only the grants its code uses.
- Health, Prometheus metrics with their own token, and traces to an
  OpenTelemetry collector (STATUS 2.27, 2.40); point-in-time recovery
  documented.
- Readiness for a load balancer (`/api/ready`), which says no the moment a
  stop begins while the console answers a few seconds more; health that asks
  the database once every five seconds however often it is asked; and the
  search across companies served by trigram indexes (STATUS 2.58).
- Docker Compose, a Docker image and a systemd unit; the running platform
  never holds the schema owner's URL; append-only history refuses TRUNCATE.
- The image sets its own database up from a superuser's URL and migrates
  before it starts, so it runs beside a stock pgvector database with nothing
  from the repository; PID 1 is started without any database password
  (STATUS 2.47).
- Compose files for Coolify and Dokploy, which build it from this
  repository and put HTTPS in front (docs/guide/coolify-dokploy.md,
  STATUS 2.49).
- A deployment with no owner prints a link as it starts; whoever opens it
  first adds their authenticator app and is the owner, with no secret in
  the environment (STATUS 2.48).
- CI's actions pinned by commit and the image's base by digest, moved by
  Dependabot's weekly pull requests; CI fails on a high or critical advisory
  in a production dependency (STATUS 2.54).
- Triggers that take their token in the address, for senders that can set
  nothing but a URL, such as Coolify's notifications (STATUS 2.55).
- A threat model ([docs/THREAT-MODEL.md](docs/THREAT-MODEL.md)) naming each
  defence, its test, and what is left.
