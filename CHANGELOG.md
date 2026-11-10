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
- Of two budget accounts on one division, project or role, the same one
  pays every time: the one under the other, or else the older. Work was
  charged to whichever the database read first, which changed as accounts
  were charged (STATUS 2.102).
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
  again (STATUS 2.83); one that stays down is one card while the work goes
  on waiting (STATUS 2.186).
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
- Budget accounts are named for what they cover -- a division's name, the
  name you gave one, or the whole company in your language -- instead of
  "company" and "ops"; a role's budget says what it rolls up through by
  name rather than by account ids (STATUS 2.99).
- The change log on **Health** and the retention log in a company's
  settings say what happened in your language -- "Charter changed" by "The
  company template", "Old prompts cleared" -- instead of "charter",
  "updated", "by template" and "prompts_scrubbed" (STATUS 2.100).
- The daily digest in a chat is in your language, its spend in US dollars
  the way your language writes them, and what stopped is said by what it
  means -- "Kehabisan anggaran" -- instead of "budget_exhausted"; a notice
  that work stopped says why the same way (STATUS 2.101).
- A stopped task says why in your language and what you can do -- "A
  service it needs failed its check ... Fix it under the division's
  Capability health on Team, then do it again" -- instead of the platform's
  record, "shared budget exhausted", which is kept closed beneath it; the
  timeline says a halt by its reason (STATUS 2.103).
- Roles are shown by the name and title they have -- "Bayu · Chief Strategy
  Officer" -- on the work list, a task, the team page, schedules,
  triggers, handoffs, reviews, standing approvals, frozen roles, the trace
  and every picker, instead of "coordinator" or "strategist"; the built-in
  bundles' roles now
  arrive with names and titles, and a name you gave one stays when its
  bundle is installed again. The money page lists companies by name
  (STATUS 2.104, 2.109).
- An approval in a chat, a push or an e-mail names its action as the
  console does -- "Hapus data: recordId cust-042" -- in your language,
  instead of "record.delete: recordId cust-042" (STATUS 2.105).
- You can read money in your own currency: choose it and the rate under
  **Settings**, **Languages**, **How you read money**, and every amount is
  shown and typed in it, with the daily digest giving both. PALUGADA still
  counts in US dollars and fetches no rate (STATUS 2.106).
- On a phone, the work list, the accounts on **Money** and what is running
  on the overview fit the screen: nothing is off to the side in a box that
  scrolls sideways, no status is cut, and a figure is never broken inside
  the number (STATUS 2.107).
- A number you type is grouped and pointed the way your language writes
  one -- "Rp 3.300.000" in Indonesian, not "Rp 3,300,000" (STATUS 2.108).
- **Work**, **Results** shows every draft and email the company produced,
  newest first, with who wrote it, each a press away from its whole text
  and its task. They could be found only on the task that made them
  (STATUS 2.110).
- The console shows work moving the moment it moves -- the overview, the
  work list, the inbox and a task's timeline -- from a live stream instead
  of asking again every few seconds, and each task under **Running now**
  has a button to stop it (STATUS 2.111).
- The cards PALUGADA raises itself -- the month's budget pause, a role
  spending too fast or frozen, a task waiting on nothing, a service or a
  model that stayed down, a review that deadlocked, a stage or goal
  proposal, a run's question, why an approval was asked -- are in your
  language, name roles, tasks and capabilities as you know them, give money
  in your currency and times on your clock. They were in English with the
  platform's codes, cents and UTC (STATUS 2.112).
- Installing a bundle -- or starting a company from company-os -- asks you
  about its skills once: one review reads them all and one card lists them,
  each with what the reviewer said, to switch on together or one by one on
  **Skills**. It was a card and a reviewer run for every skill, eleven of
  each before you had asked for anything (STATUS 2.113).
- A new company starts with its CEO asking what it sells, what it may
  spend in a month and what its first work should be, then proposing the
  mission, the ceiling and that work as cards; the Overview lists four
  steps to a first result and ticks each off as you do it. The company's
  schedules run on your time zone (STATUS 2.114).
- PALUGADA installs with one command and nothing but Docker:
  `curl -fsSL https://raw.githubusercontent.com/TegarTheGreat/PALUGADA/main/install.sh | sh`.
  It prints the link that makes you the owner. Run it again to update; the
  database is copied to `~/palugada/backups` first (STATUS 2.115).
- You can seat other people for a company under **Settings**, **People**: a
  viewer follows its work, an approver also approves or denies what waits
  at tier 2 and below. They join from a link with their own authenticator
  app, never yours; tier 3, settings, keys and devices stay yours, the
  record names who decided, and ending a seat signs them out at once
  (STATUS 2.116).
- A role can put a question to a person by name, not only to you: the
  bookkeeper asks Budi, and only Budi and you see the question and can
  answer it. The card says who it is for, and a seat's inbox has a "For me"
  list. You are not pinged about a question that is for someone else until
  it has gone a day unanswered; then you are told once, and it can be
  answered by them or by you. An answer can carry up to five files (an
  invoice, a price list, a photo): they are kept in the company's files, a
  program is not, and the role that asked is told where each one is and who
  answered. A role can be a person: hire it with the name of someone you
  have seated and its work is put to them as a question, and their answer
  is what it produced. If they leave, the work stops and you are told; it is
  never given to an agent unasked (STATUS 2.173).
- A company starts with its CEO and nothing else: no division, role or goal
  you did not ask for. The first screen is a name and what the company is
  for, in your own words, and the CEO's first message says that sentence
  back, asks only what it cannot know, and offers to suggest the first piece
  of work and the team it would take. The built-in team template is gone;
  an operator who stores a template of their own can still start a company
  from it by name. Six boxes of the authenticator's code no longer spill out
  of their dialog on a phone (STATUS 2.174).
- **The authenticator is for signing in, and nothing else.** Once you have signed in
  with its code or a passkey, a division, a role, a grant, a goal, the spend
  ceiling, the model and its key, a channel and every approval of something
  that cannot be undone need no new code. What still asks, each time: revoking
  an authenticator, making new recovery codes, adding a passkey, pairing a
  device, and anything in a session you signed in to with a recovery code until
  you show a device's code in it. A chat and a staff seat still cannot approve
  what cannot be undone. The "how long a code counts" setting is gone. A
  stolen, signed-in tab is now worth more, for the eight hours a session lives;
  signing out and freezing the company are what you have against it (STATUS 2.175).
- Your CEO now builds the company when you tell it to: it opens a division, a
  project and a goal, hires a role with its tools, and grants it, and says what it
  did, instead of putting a card in front of you to press. After it has read
  what agents wrote in the same turn, or in a session signed in with a recovery
  code, the same change is still a card for you (STATUS 2.175).
- A role that goes round in circles -- the same tool with the same input and the same answer four
  times, a refusal three times, two calls taking turns -- is told so, and if it goes on it is given no tools and
  asked to finish saying what is done and what stopped it, instead of spending forty turns and your budget.
  A conversation that grows past what the model reads is written down by the model and the work carries on, where
  it used to fail "too long" with the work half done (STATUS 2.176).
- The money is counted as the provider counts it. A call is priced to the fraction of a cent, no longer rounded up
  to a whole one (a call worth a tenth of a cent was charged a cent), and what is below a cent is carried to the
  next call so the total is right. Cached tokens are priced at the cache's own rates. The platform reads models.dev
  every day for the models you use and keeps their prices current; a price you typed in the console still wins, and
  the Model page says whose price each one is, when it was last read and what changed (STATUS 2.177).
- When the budget runs out, the company handles it. Once your own ceiling has room -- a new month, a raised
  ceiling -- the month's pause lifts and the work the budget stopped goes on by itself, oldest first, as far as the
  room goes, with its card withdrawn; you no longer raise the ceiling and then press Continue on each account. A
  role the breaker stopped for a burst of spending goes back to work when the burst has passed, and the work that
  waited for it is called back; only the third stop in a day is put to you. Work waits for a paused role and does
  not fail (STATUS 2.177).
- The company collects what it is owed, without being asked. An invoice past its due date is reminded three days
  late, then ten, then twenty-four, by a letter written from the books -- the customer, the amount, the date, in
  Indonesian or English, and your own words on how to pay -- so there is no card for you to press and no model to
  get it wrong. It stops when the invoice is paid, never writes twice in a week, and tells you once, in your
  language, about an invoice a letter did not mend. Switch it on under Books, Invoices (it gives the job to the
  roles that bill customers, or hires a bookkeeper); leave one invoice alone with a press (STATUS 2.178).
- An entry, an invoice, a customer, a deal or a note is never made twice because the platform stopped between making
  it and hearing that it had. A reminder is never sent twice: if the mail server hangs up before it says it took a
  letter, the invoice shows the letter as not confirmed and you are told once, instead of the customer being written
  to again (STATUS 2.180).
- Every model call is paid for: a picture read (`image.describe`) and the company's documents being searched by
  meaning were charged nothing and are now on the Money page at the provider's price. A month whose money is spent
  asks the model nothing more, and a call the budget refused after it was made is still counted (STATUS 2.180).
- A goal nobody has worked on for three days wakes your CEO, at most once a week for each goal: it hands the next
  piece of work to the role whose job it is, proposes a schedule, or says the goal is waiting on you, instead of the
  company sitting still until you write. Only where the deployment has a model (STATUS 2.181).
- When the company lacks a role, the CEO proposes the hire, and you see it at once as a card. *Hire it with the
  CEO* opens your conversation with the proposal ready to send; *Not needed now* closes it. The board marks a
  proposed hire, and it is never handed out as ordinary work (STATUS 2.181).
- Work its budget stopped goes on by itself only when somebody still waits for it: not after you pressed *Run
  again* (no more work done twice), not for a child whose parent failed, and never past the room of a company
  account two divisions share. A role you pause stays paused, even one the spending breaker had stopped first
  (STATUS 2.182).
- Seating a person, and connecting Telegram, WhatsApp, push, Slack, Discord or email, now asks for your
  authenticator code at that moment, as adding a device does; nothing else does (STATUS 2.182).
- Calls are charged at the price you see: a model a provider answers under a dated name (OpenAI's "gpt-5-2025-08-07")
  was charged the highest rate; fractions of a cent stay with the division that spent them (STATUS 2.182).
- Reminders for overdue invoices run as the platform's own procedure whatever the sending role runs on, never hire a
  second bookkeeper, count days in the company's time zone, go to the address you add to a customer, and never write
  "How to pay: undefined". A sender you paused no longer holds up the others, and saving only the days never asks
  for your device (STATUS 2.182).
- You can remove files customers sent (under Files, received), which frees the room they take; invoice PDFs print
  after the 500th; mail attachments arrive whole from servers that only estimate a message's size (STATUS 2.182).
- A photo, voice note or document a customer sends on Telegram or WhatsApp is kept under Files, received, as a
  mailed one is, and the role answering reads it, instead of being told it cannot (STATUS 2.183).
- Telling the CEO "remember this", or giving it a figure, is done at once as your own word, with no card to press.
  Telegram and WhatsApp show the words or the number kept under the answer, and the same thing said again is kept
  once. A reviewer stopped by its budget waits while the budget card is open instead of raising a second card, and
  goes to you once no card covers it. Other work a budget stopped is not put to your CEO while its budget card is
  open, and going on with the work that card is about raises it again, for the same account, for the work it still
  stops that you have not already run again. You are no longer offered procedures for the platform's own tools or
  for its duties (STATUS 2.184).
- Cards that only told you something now close themselves once it is handled. A day's spending, failure-rate or
  refusal card closes a whole day after it reached you, and its Telegram message keeps the figure. Last month's 80%
  warning closes in the new month, or when the "paused" card takes its place. A stopped task's own cards close when
  you press *Run again*. A run whose worker stopped is now a line of the daily digest, not an urgent card. A failed
  read-back or a capability that stopped working raises only its own card, and a failed read-back's card is never
  lost if the worker stops. Such cards left open by the upgrade, or in a company restored from an older archive,
  close the same way, and a card's Telegram message and its line in History say why it closed. The alert thresholds
  no longer take `verificationFailuresPerDay` (STATUS 2.185).
- A model or a service that stays down, or a capability whose check fails for good (a refused credential), no longer
  halts every task in flight with a card of its own. The work waits, looking again up to an hour apart for up to a
  day. There is one card for the cause while work waits on it, raised again if the cause comes back. The card closes
  itself and the waiting work goes on by itself when the cause passes. Work still waiting after a day stops and is
  listed on the card, to open and run again; the card stays for that work once the cause passes or, for a model or a
  service, no work waits on it any more, and the next work to meet the cause has a card of its own, beside the first
  if the cause is still down. Saving a model key now calls back the work waiting for it (STATUS 2.186).
- A task of a role you hired that ends without being done now goes to your CEO first, for an hour, in every
  division where you have not named someone else or nobody under Who hears about trouble first. The CEO is told of
  every task on the card. A fix closes the card, which stays readable; when the CEO cannot fix it, it says why and
  the card is yours. Running the work on it again, or going on with it, stops the CEO once nothing on the card is
  left, and tells it what was taken up while some is still stopped. Naming the CEO there follows the title when you
  appoint another. A company restored from an archive still knows which of its work was run again and which card
  the CEO was handling. A CEO stopped because its work was taken up, by your press on the work or by the
  platform, says so, rather than "Cancelled by you" (STATUS 2.187).
- Work handed out from your own backlog no longer asks you before every letter or payment just because a run wrote
  the ticket. This holds whether the CEO's triage or you on the board hands it out. Only a ticket filed by work
  that had read something from outside (a customer's message, a web page, a mailbox) makes the work it leads to
  ask, and it asks the same way whoever hands it out. The board shows which tickets those are, a ticket never
  becomes clean once filed, and an archive from an older version restores every ticket as from outside. When you
  come back, the CEO names only work you wrote yourself; work from a ticket a run filed, a schedule's run you
  started, or a run again of either is counted, not quoted (STATUS 2.188).
- Money is written with two decimal places everywhere it is read -- invoices, reminders, cards, the console -- so the
  same invoice reads the same after a Node upgrade. A deployment's first browser start on a fresh server is waited
  for a minute instead of failing at fifteen seconds (STATUS 2.179).
- Customers can write to a company on a Telegram bot of its own, connected
  on **Customers** with your device. Each message starts work for the role
  you chose; every reply is a card showing the conversation beside it,
  which you or an approver say yes to; and **Customers** lists every
  conversation. Closing a channel forgets the bot's token and keeps what
  was said (STATUS 2.117).
- Customers can also write to a company's WhatsApp Business number,
  connected on **Customers** with Meta's keys: only what Meta signed is
  heard, replies go from the number after your yes, and a reply past
  WhatsApp's 24-hour window is refused with the reason before it is sent
  (STATUS 2.118).
- And to the company's own mailbox, connected on **Customers** with its
  servers and password: new mail is read about once a minute, auto-replies,
  bounces and lists start nothing, and a reply goes out from the same
  address in the customer's thread after your yes (STATUS 2.119).
- Each company has a browser of its own, for the sites with no API: a
  role granted **Read a page in the browser** reads pages as a person sees
  them, and **Fill in a page in the browser** fills in a form after your
  yes, with each field, choice and button on the card. Sign-ins are kept
  sealed for later work, every request goes through PALUGADA's own checks,
  and a role never types a password. It needs a Chromium on the machine
  (STATUS 2.121).
- **Browser** shows each piece of work's page as it is, and you can take
  it over with your device to sign in somewhere, type a code a site sent to
  your phone, or answer a puzzle; the company's work waits while you hold
  it. A role that needs this asks with a card that opens the browser, and
  giving it back answers it (STATUS 2.122).
- The image includes Chromium, so the browser works with the one-command
  install and Compose, and runs it with Chromium's own sandbox: the compose
  files give the container a seccomp profile that allows it. CI checks in
  the image that pages render sandboxed (STATUS 2.123).
- `sh ~/palugada/install.sh doctor` says what is well and what is not with
  your install, mends what is safe to mend, and says what to do about the
  rest; `sh ~/palugada/install.sh rollback` goes back to the code the last
  update replaced, which each update now keeps (STATUS 2.124).
- With no provider chosen under **Tools** for **Reading pages**, a role
  reads a page in the deployment's own browser, without any company's
  sign-ins, and the address goes to nobody else; a Firecrawl you run can
  be chosen there too (STATUS 2.125).
- A division reads and sends mail from its own mailbox -- Gmail with an app
  password, a hosting provider's, your own server -- given on **Team** in
  the division's keys. Reading leaves mail unread in your own mail app;
  sending is tier 2, so a reply to mail a role read waits for your yes. A
  service bound for `email.send`, such as Resend, is still the one used
  (STATUS 2.127).
- A role granted **Read a file** reads a file in the company's files -- a
  draft, a CSV, a PDF, a Word document, an Excel workbook -- as text, a page
  at a time, and nothing outside them. Documents are read in the
  deployment's own sandboxed browser, never by the server itself
  (STATUS 2.128, 2.129).
- **Reading pictures**, under **Tools**: a role granted **Describe a
  picture** reads a receipt, an invoice or a screenshot in the company's
  files and copies its words, through OpenAI, Gemini, Claude, OpenRouter,
  Groq, Mistral or a vision model of your own (STATUS 2.130).
- A role that needs a key its division does not hold asks you for it: the
  card's **Give the … key** opens the division's keys on **Team**, and
  saving it there answers the role, which is never shown the key. A role
  can ask only for a key its own division's capabilities use (STATUS 2.131).
- A role granted **Calculate in Python** works figures out on the company's
  files it names -- a month's sales from a spreadsheet, a chart -- in a
  container with no network, and what it writes is kept under `computed/`.
  Set `PALUGADA_COMPUTE_IMAGE` to an image built from `deploy/compute` on a
  machine with docker or podman; `npm run compute:check` proves the
  container there. Because its code can reach nothing, it may sit beside
  Finance's keys and invoices, and the bookkeeper has it, with **Describe a
  picture** for receipts (STATUS 2.132).
- Outside text -- a page, a mail, a customer's message -- can no longer
  forge a turn for a model you run yourself (Ollama, vLLM, llama.cpp) with
  chat-template tokens such as `<|im_start|>`, nor close the untrusted
  envelope with a look-alike of its fence: both are removed before any
  model reads it (STATUS 2.133).
- **ComfyUI** is a picture provider under **Tools**, for a company with a
  GPU of its own: its address, and a checkpoint it has as the model. No key,
  nothing paid per picture, and nothing left in ComfyUI's output folder
  (STATUS 2.134).
- An approval in work a schedule made can be given for **every time that
  schedule does exactly this**, for ninety days, with your device: the same
  action to the byte, from the same schedule unchanged, runs without a card,
  even when the work read outside mail. Listed under **Allowed for a
  schedule**, and taken back with one press (STATUS 2.135).
- A role that sees the same work owed again and again **proposes a
  schedule**: what each run does, which role, when, and why, with the next
  runs in your time. Your yes makes it and starts it; nothing more often than
  hourly. The CEO of a new company has it (STATUS 2.136).
- A customer channel can **answer on its own** from the documents you mark
  **for customers** -- a menu, prices, opening hours -- once you turn it on
  with your device. A reply goes without a card only to the customer who
  wrote, naming the passages it answers from, with no figure, address or
  link they do not give, six an hour per conversation at most, and after a
  model finds every statement in them and nothing that is yours: a refund,
  a price of its own, a complaint, the law, personal data, a promise.
  Anything else is your card, saying why it did not go; the conversation
  marks what went on its own and from what (STATUS 2.137).
- The company keeps its own **customer records**: on **Customers**,
  **Contacts**, everyone it deals with, what was noted about them and the
  deals with them, by stage and worth. A customer who writes is filed under
  the person you keep with that address or number, or kept as someone new;
  agents read the record of the customer they answer, note what they told
  them and record details and deals. A CRM you connect takes over
  (STATUS 2.138).
- The company keeps its own **books**, by double entry, on a page of their
  own: a chart of accounts, entries that must balance -- the database
  refuses one that does not -- and a reversal for a mistake rather than an
  edit; balances per currency and this month's profit. The bookkeeper reads
  and records the same books. An accounting service you connect takes over
  (STATUS 2.139).
- A model key the provider refuses (a wrong or revoked key, a 401) is said
  in your language with where to put one that works, and the inbox holds one
  card for the company instead of every task halting silently. The work
  waits, longer each time, up to ten hours, and carries on by itself when a
  key that works is in use, rather than waiting for you to resume each task
  (STATUS 2.140).
- The reviewers a company is given (`reviewer`, `qa-reviewer`,
  `platform-reviewer`) are now asked for a verdict a reading can use, so a
  review is no longer sent to you as "undecided" for want of one; and a
  reviewer's long reason can no longer stop every review behind it
  (STATUS 2.141).
- Work you approved after the hour it was given is no longer halted for the
  time you took: a task's deadline is for the work, and the time it spent
  waiting for your answer, or for a review, is given back (STATUS 2.142).
- One authenticator code covered what builds the company for ten minutes,
  instead of a code for each (STATUS 2.143); the authenticator is now asked
  for at sign-in only, so there is no window to set (STATUS 2.175).
- A task that ends without being done no longer ends in silence: it is put to
  your CEO first -- or to whoever you named for the division, or straight to
  you if you said so -- and to you only if it could not handle it, with what
  it did (STATUS 2.187). Tickets the company owes
  -- filed by a role, or by you -- are handed on by the CEO on its own, a batch
  at a time, and cost nothing while there are none (STATUS 2.144).
- A company's CEO now does what you ask in the conversation -- gives the team
  work, files or hands on a ticket, tells a task something, stops it, runs it
  again -- instead of putting a card in front of you to press, unless in that
  answer it read what agents or customers wrote, when it is a card as before.
  When several cards are waiting, **Apply all** presses them in order (STATUS
  2.145).
- What you correct in the company's memory stays corrected: a sentence you took
  back, or replaced with your own words, is not learned again from the next run
  that writes it, and a lesson no longer becomes a "known fact" by being said
  five times by the same piece of work. A remembered fact shows the day it was
  recorded, runs are told memory is a lead and the company's records win, and a
  procedure nobody answers leaves your inbox after two weeks (STATUS 2.146).
- An agent can no longer ask you to mark a goal met while its checked measure is
  short of target, and every proposal to close or give up a goal shows where its
  measures stand, as the platform reads them. A run that resumes keeps its
  newest steps when its context is too long (STATUS 2.147).
- A role can ask to be woken later about what its own work did -- an invoice
  sent, a campaign launched, a deploy -- with `task.follow_up`: a task made now
  that starts at its time, carrying the work's goal, budget and what it had read
  from outside, cancelled if the goal closes. The coordinator holds it (STATUS
  2.148).
- What a role writes is shown formatted: the CEO's answers in the chat, a task's
  answer and what it said, and a draft or deliverable in the gallery -- headings,
  lists, bold, code and tables, where the console had shown every asterisk and
  pound sign as typed. It is read into a tree and drawn, never turned into
  markup: no image is fetched, no HTML runs, and a link opens only if it is
  http, https or mail (STATUS 2.149).
- A company can keep office hours (**Settings**, **Company**): the days and hours
  in which an email, a post, a reply to a customer or any other action that
  reaches the outside world may go out. Outside them it waits for the opening
  instead of failing, while reading, drafting and planning go on at any hour;
  replies to customers can be left open at any hour. Until you say, a company
  runs round the clock as before (STATUS 2.150).
- Each page in the sidebar says what it is for under its name, and the two
  buttons that open a conversation say how they differ: the CEO is for one
  company and has things done; Ask PALUGADA is for the model, the channels and
  new companies (STATUS 2.151). The sidebar no longer hides most of its pages
  below the fold, and before there is a company it shows only Home and This
  deployment.
- A deployment with no model says so first, in red, on Home, with the button
  that sets one; the rest of what it reported at start is a count and a way to
  the checklist, not the same "Set the model" button for each (STATUS 2.152).
- Hiring a role also grants its division the tools the role names and the
  division lacks -- you no longer open the division and grant them one at a
  time -- except tools whose use cannot be undone, which stay a grant of their
  own. Your CEO does the same when you ask it to hire (STATUS 2.153).
- The company keeps its invoices in the books (**Books**, **Invoices**): numbered
  without gaps, written with the entry that puts what is owed in them, paid in
  part or in full, voided by a reversal, never edited. The bookkeeper issues
  them with `invoice.issue`, reads them with `ledger.read`, and records a payment
  against one with `ledger.record`. What is owed and what is late shows at the
  top (STATUS 2.154).
- When an account's tokens run out, one card in the inbox stands for the account
  and its **Raise it and continue** raises the ceiling and goes on with every task
  it stopped, instead of a card and a Continue for each. The Work page says the
  tokens ran out, not a bare "out of budget" beside a cost of nothing, and new
  companies' token ceilings are sized against their money so tokens do not run
  out a hundred times first (STATUS 2.155).
- The language you read is the language your team writes in. A console drawn in
  your browser's language tells PALUGADA so at your first sign-in, your CEO opens
  and answers in the language its company talks in, a new company's mission is
  written in it, and agents that were never given a language follow the console's
  instead of English. Choose one for them under **Settings**, **Languages**; clear
  it to follow the console again. Before, an Indonesian console had a CEO and a
  team that greeted in English (STATUS 2.156). An 'English' that was only the
  default is cleared by the upgrade: if you chose English for your team on
  purpose, choose it again there.
- Your CEO speaks first when you come back. Open the conversation after being away
  and, if something happened -- work you gave finished, work stopped, something waits
  for you -- it says so in one message, in your language: what finished, why work stopped,
  how many things wait. Nothing happened, nothing is said (STATUS 2.157).
- A deadline is for the work, not for the waiting. Work you delegate no longer halts as
  "missed its deadline" while it waits for office hours to reopen, for a vendor's limit, for
  your yes, or while you raise a budget and continue it (STATUS 2.158).
- A role's "look again later" that fails is reported to you like any work that ends badly,
  and the weekly review runs in a quiet week when a number you set has not been reached,
  instead of passing over the one week that most needed it (STATUS 2.159).
- What your company remembers is dated and bounded. Every run is told today's date, a
  memory search says how old each fact is, the context a run starts from takes what the company
  learned recently (or saw again lately) instead of every lesson ever, and a lesson from an email
  reaches a run only when it is about the task -- so fewer runs ask you about everything. The words
  you wrote yourself are never changed by an agent repeating them. A fenced reply from the
  learning step is read, one failing division no longer stops the others, and the Memory page no
  longer says something waits for your yes when its card has expired (STATUS 2.160).
- A company keeps what it makes. The Compose deployment now gives every company a folder for its
  files, on the volume that survives an upgrade, so drafts, pictures, speech and computed files are
  stored instead of being switched off; `docs/features.md` now also says what is built but
  not bound on a fresh install (STATUS 2.161).
- Urgent work stays urgent: a priority you give (or a ticket carries) reaches the task and
  everything it hands on. A question a role asked leaves your inbox when its task is cancelled
  or ends, instead of waiting for ever; and a task whose record the ninety-day clean-up has
  cleared is not "continued" into a failure but told to run again (STATUS 2.162).
- What your company learns is a rule for the next customer, not a note about one: lessons no longer
  carry what one named customer liked into every other customer's work, and a suggested procedure
  is counted in tasks and answered from when you said no. A fresh install also says, at start, when a
  connected service has taken over a name the platform keeps (such as invoicing in the books) and
  that the lab analyst's code tool is not connected to anything (STATUS 2.163).
- The company looks at its numbers. When a measure you set reaches its target, passes its
  due date short of it, or has a source nobody has read for a week, the CEO is given a task for
  it -- once for each target or date you set, not every time a figure crosses; a source nobody has read
  is read again about every week while those reads succeed -- asks you where it stands in your
  language, and has the source read again by a role that can. Only a figure
  you entered or a run read from the source counts, and nothing runs while nothing changed. On
  upgrade, every measure already in one of those states gets one look, at most one every ten
  minutes, and each reached or overdue one puts a question in your inbox. Handing on the tickets the
  company owes, which the CEO does by itself, now also happens in the default deployment, where
  four places at once had kept it from ever starting (STATUS 2.164).
- A run knows where its task stands. A runtime that starts again from what it is told is given the plan
  the task recorded and how far it got, the files its writes made, and the work it handed on; a role woken
  to look again at what it did is given that work (what it was asked, what it returned, how it ended), and a
  role that awaits a sub-task is told the files it made. A long run is told its forty turns and no longer
  sent every page it ever read on every turn, and one whose conversation is too long for its model fails
  once with the reason instead of three times. The gallery and a task's page no longer list as produced a
  file that was only read (STATUS 2.165).
- You can hand the company a file and take one out. **Memory**, **Files** lists the company's folders,
  uploads a file of up to 10 MB (a contract, a price list, a photo) under a plain name in `uploads`, saves any
  file to your device, and removes what you put in. A role that can read files can read what you uploaded,
  as outside content; what the company's roles made is listed beside it. `files.list` now gives folders
  first and each in name order (STATUS 2.166).
- A letter can carry files. `email.send` takes up to five files of the company's own -- what a role
  drafted, made or was given, ten megabytes together -- and the owner's card names every one; what a stranger
  sent and another company's files cannot be sent. A mail server that says how large a message it takes is not
  sent a larger one (STATUS 2.167).
- The installer shows it is working and says where to open the console. It numbers its steps, says every
  ten seconds how long the wait has been, what is running and what the platform last printed, and stops
  at once with the platform's last lines when the platform stops, instead of waiting ten minutes. Over SSH
  it prints the tunnel command with the server's own public address instead of only `localhost`, and
  `PALUGADA_PUBLIC_HOST=console.example.com` puts HTTPS (Caddy) in front of the console, or
  `PALUGADA_PUBLIC_HOST=<address>` opens it on the address over plain HTTP, with a warning; `private`
  shuts it again, and `doctor` says where it is meant to be opened (STATUS 2.168).
- A task's page lists the files it made -- a picture, a computed spreadsheet, a draft -- and you can download
  each; the gallery showed only what has text (STATUS 2.169).
- An invoice can be downloaded as a PDF: drawn offline by the deployment's own Chromium from the invoice as
  it was issued, kept in the Files tab as `invoices/inv-0001.pdf` so a role can attach it to a letter (STATUS
  2.170).
- What a customer attaches to a mail is kept in the company's files (up to five files, ten megabytes each),
  shown in the conversation with a Download button, and read for the role that answers: `chat.read` gives
  its path and what a PDF, Word or Excel document or a text file says. Programs, scripts, archives, SVGs and
  old or macro Office files are not kept, and the conversation says why (STATUS 2.171).
- The installer says where to open the console on any server, also under `sudo` or in a provider's web
  console (it printed `localhost` there), stops Caddy when HTTPS is given up, checks its numbers before it
  writes or waits, and keeps `.env` private as it is made. A letter's approval card names every file even when
  it has many recipients, a large letter is given its minute after STARTTLS too, a company's id in capitals no
  longer makes a second folder, a named pipe in the files no longer hangs a read, and concurrent uploads
  respect the count (STATUS 2.172).
- `PALUGADA_MAIL_CA` is trusted besides the system's authorities, as
  documented: set, it had stopped mailboxes on public certificates from
  connecting (STATUS 2.126).
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
- Releases: `node scripts/release.ts` prepares one as a commit and tags it
  on main, and a pushed tag becomes, once CI passes on it, an image at
  `ghcr.io/<owner>/palugada` and a GitHub release with this file's section
  as its notes. `PALUGADA_VERSION=v0.2.0` makes the installer install,
  update to or go back to that release, and CI runs for a merge queue
  ([docs/RELEASING.md](docs/RELEASING.md), STATUS 2.120).

### Operating rhythm (F18)

- A goal has a period, one owning seat, a commitment (committed,
  aspirational or learning), a sentence saying when it is done, and the
  traction channel it tests. A key result of a quarter or less is a
  quarterly priority, and the database refuses one without a seat, or
  without words or a measure for done; an objective of a year is one of
  this year's goals (STATUS 2.190).
- A new quarterly priority is given its finish line in words; once a
  measure is defined they may be cleared, and that measure, while it is the
  last, cannot be retired until the words are back. A met or abandoned
  priority is not held to the rule, so any company the console reaches can
  be restored from its archive (STATUS 2.190).
- More than 7 quarterly priorities at once, more than 5 for one seat or
  under one objective, or more than 5 of this year's goals is said on the
  goal's card and in the answer, and refuses nothing (STATUS 2.190).
- Every run under such a goal is told its period, commitment, seat, finish
  line and channel, and the archive carries them (STATUS 2.190).

- **The weekly scorecard** (F18.2). A measure can be reviewed every week:
  its target is then the weekly goal, a seat answers for it, and Team shows
  thirteen weeks of it, on track, off track, claimed or not reported,
  counted in the company's time zone. An agent's number nobody read from its
  source is shown as claimed and judged neither way. The owner is warned
  below 5 lines or above 15 (STATUS 2.191).
- **Paired measures.** A measure can be watched with the one that would
  suffer if it were pushed. The two are shown together on the scorecard and
  in every run's context, the database refuses half a pair, and a key
  result counted in units or money with no pair says so. A new measure
  pairs only with one that has no pair; re-pairing is a change, under the
  second factor, and a change form sends only what was changed in it
  (STATUS 2.191).
- A weekly goal met is not a milestone: it starts no outcome task, a
  short week does not stop a goal being proposed met, and a weekly line is
  never the portfolio's headline (STATUS 2.191).

- Seats and accountabilities: each role says, in at most five lines, what
  its seat answers for. The owner sets them from the role, or when hiring,
  and each change is versioned like the charter. Every run of the seat is
  told them, and the CEO's list of the roles it can hand work to shows every
  seat's, so work about a result goes to the seat accountable for it. The
  Team page shows them on the chart and warns of a seat with none and of an
  accountability two seats both claim. It never refuses either (F18.3,
  STATUS 2.192).

- The operating kit (`company-os` 1.6.0) tests channels: the strategist
  writes one strategy for each of the 19 channels, promotes about three,
  ranks them by the ICE average, and proposes a cheap test of each to you
  with its prediction and the most it may spend written before any work
  starts. Nothing of a test starts before you approve it. It has no
  account of its own: the work it hands to the role holding the channel's
  tool is charged to the account the strategist's task is charged to, a
  day at a time, and the test is read against its prediction at every
  weekly review for about a month. The channel that meets its prediction
  is proposed as the core one, and the round runs again when it
  saturates. Paid ads before launch are still refused (STATUS 2.198).
- Three skills for drafting before spending: a one-page business model
  (nine boxes, the riskiest assumption first, adapted from Lean Canvas
  under CC BY-SA), a fit survey that asks only recent users, once each, and
  reads 40% very disappointed as a heuristic, and a press release with its
  questions and answers written before a new offer is built and read by
  the critic. The stage gates prefer learning priorities in explore and
  validate and name the two ways a pivot goes wrong. Installing 1.6.0 over
  an earlier kit brings them as candidates for review and your approval,
  and the skills you approved stay live until you approve their new
  versions (STATUS 2.198).

- An issues list on the Tickets board. An issue is a problem the company solves rather than work it hands out:
  file one yourself (New ticket, An issue to solve), on this week's list or the long-term one, and the CEO solves
  it by naming its root cause and the decision taken and filing the to-dos that carry the decision out. An issue
  cannot be marked solved without both, and it is never handed to a role as work. Its page shows the root cause,
  the decision and every to-do with its seat, its due date and how it went. Each decision is kept in the company's
  memory, so the division's runs are told what was decided and why (STATUS 2.193).
- To-dos: each goes to one seat, is due seven days out unless the CEO says otherwise, and is handed to that seat
  straight away instead of waiting for the CEO's triage. A to-do whose work ends unfinished opens again with the
  reason and is then the CEO's to hand on, not handed to the same seat again (STATUS 2.193).
- Postmortems: when a task keeps stopping its worker, a write does not read back as written, a budget account runs
  out, or root work ends badly, the platform files an issue beside the card it shows you. The issue is a short
  postmortem (what happened, impact, trigger, detection, what was done) in your language, with no customer's name
  in it. While it is open, the same failure in the same seat, or the same account running out again, is recorded
  against it instead of filing a second issue (STATUS 2.193).
- The board's Issues and To-dos filters, and "filed by PALUGADA" on what the platform filed. Archives carry issues
  and to-dos whole, with the card each came from and the seat each names mapped to the restored company
  (STATUS 2.193).
- An issue you open again on the board is not solved any more: it no longer shows the old root cause as if it were
  current, and its page keeps each earlier root cause and decision as what was tried before. The CEO reading the
  board sees the same (STATUS 2.193).
- A to-do whose seat will not take it (a frozen seat, an archived project, or a paused month or spent budget three
  times running) goes to the CEO to hand on, saying why, instead of being asked of the seat every ten minutes with
  nobody told (STATUS 2.193).
- A decision the CEO reaches on an issue of the whole company is kept for the CEO's own division, not for every
  division: only what you decide is kept company-wide (STATUS 2.193).

- **The weekly operating meeting** (F18.6). Once a week, on the day and at the hour you choose under Settings,
  Company, in the company's time zone, the CEO holds it: the platform reads the records and hands it the
  scorecard line by line, the quarterly priorities on or off pace, the week's headlines as counts, the to-dos done
  and not done with the week's completion rate, the issues ranked with any older than eight weeks flagged, and the
  operating kit's weekly business review. No model writes a figure. The CEO solves the top three issues with a root
  cause, a decision and to-dos, takes the decisions that can be undone, brings you the ones that cannot, and ends
  the record with what you need to know, in your language. A week with nothing on its agenda (an issue on the
  long-term list or a to-do due later is not), a company winding down, a meeting you turned off and a deployment
  with no model make no task and cost nothing. The CEO you appointed last is the one who holds it (STATUS 2.194).
- A line off track last week, and a to-do not done at two meetings in a row, are on the issues list before the
  meeting starts, each once while it is open (F18.4, F18.5; STATUS 2.194).
- Every run of a seat is told its own lines on the scorecard and where each stands this week, its quarterly
  priorities and its open to-dos, beside what it is accountable for; a to-do filed by work that had read outside
  content is named there without its words. The chart's **Seats to look at** also names a line on the scorecard or
  a key result no seat answers for (F18.3; STATUS 2.194).
- The company's card on Home and its meeting settings link to the last meeting's task, which is its record, and
  the daily digest the day after a meeting was held points to it, and says nothing of one cancelled or stopped.
  Archives carry when the meeting is held (STATUS 2.194).

- **A plan of new goals in one card.** The CEO, or any role holding
  `goal.propose`, can propose up to twenty new goals at once: this year's
  goals and the quarterly priorities under them, each with the goal it hangs
  from, its period, its seat, its commitment, when it is done, the channel
  it tests and a measure with its pair. A learning goal carries a measure
  whose target, set in the proposal, is its prediction. Each line is checked
  when it is proposed, and the run is told what to fix by the line's number
  (STATUS 2.195).
- You approve the plan line by line. The card shows every line, with the
  soft limits it would pass, and you untick the ones you refuse. Your yes,
  with your device, makes the lines you kept, with their measures and pairs,
  in one step. It is refused if anything you set on a goal a line hangs
  from (its words, status, period, seat, commitment, finish line or channel)
  has changed since the proposal, and a line cannot be kept without the line
  it hangs from. One plan waits at a time, even when two runs propose at
  once, and agents still cannot write a goal (STATUS 2.195).
- A plan line cannot pair its measure with an earlier line's measure that is
  already paired, nor take a retired measure's slug: both are refused when
  the plan is proposed, rather than refusing your yes after your device's
  code is spent (STATUS 2.195).
- The CEO now holds `goal.propose` in place of `doc.draft`, so it still has
  twelve tools. Its division keeps the draft's grant, so you can trade it
  back on Team. An existing CEO whose tools were still the founding ones is
  traded the same way on upgrade, with a version to roll back to (STATUS
  2.195).

- **Grades at a period's end** (F18.8). Once a goal's due date has passed
  in the company's time zone, PALUGADA grades it, once: from its measures,
  each by its last checked reading of the period, clamped from 0 to 1 and
  averaged (an objective with none of its own, from its key results'), or,
  with no number, 1 if you marked it met and 0 if not. A committed goal is
  done or missed, 1 or 0. A learning goal keeps its prediction beside what
  happened. The goal ladder shows each goal's latest grade, and no agent can
  write one (STATUS 2.196).
- A committed goal that was missed is a postmortem on this week's issues
  list, filed once, saying how far its numbers came and which seat answers
  for it (STATUS 2.196).
- **Off pace.** A committed quarterly priority whose numbers are behind the
  share of its quarter that has gone, once a quarter of it has, comes to you
  as one card a quarter, straight to you and not to an agent: a committed
  number behind its time invites a riskier road to make it up, and that risk
  is yours to take or refuse. Nothing is stopped either way (STATUS 2.196).
- **Quarterly planning** (F18.9). Ten days before each quarter of the
  company's fiscal year ends, the CEO is handed the quarter's facts --
  grades, priorities done against 80%, the committed pass rate, the
  aspirational average against 0.6 to 0.7, to-dos finished within seven
  days, this year's goals, the long-term issues, thirteen weeks of the
  scorecard, the vision from the charter and the core processes not changed
  in ninety days -- and plans the next quarter, ending in one plan of new
  goals for you to approve line by line. In the year's last quarter it plans
  next year's goals too. Choose the month the fiscal year starts in under
  Settings, Company, **Fiscal year**; January by default. A company winding
  down, with nothing to plan, with its weekly operating meeting off, or on a
  deployment with no model makes none. Archives carry the grades and the
  fiscal year (STATUS 2.196).
- A goal with measures that you marked met is graded met whatever its
  readings say, with no postmortem, and the quarter's share of priorities
  done reads a graded priority by its grade, as the committed pass rate
  does. A to-do still inside its week is left out of the share finished
  within seven days until its week is over or it is finished (STATUS 2.196).
- Each quarterly planning belongs to its quarter's dates rather than its
  name, so moving the start of the fiscal year cannot skip a quarter; and
  every committed priority is judged for pace, however many priorities a
  company holds (STATUS 2.196).
- The stage gates in the operating kit (`company-os` 1.7.0) decide a pivot
  from the grade of a learning priority, its prediction beside what
  happened (STATUS 2.196).

- **A monthly money review** in the operating kit (`company-os` 1.6.0): on the
  first of each month the strategist reviews the last whole month from the
  company's own books -- profit beside the month before, cash at its start
  and end, every invoice owed and late, spend against the monthly ceiling,
  each measure's month, and what one per cent on price, volume, cost of goods
  and overhead, or one day of receivables, stock and payables, is worth on
  them. The figures are read from the books as the review starts, not worked
  out by a model; a lever whose account the books do not keep says so. A
  month with nothing in the books and nothing late is passed over, and says
  so. Until now nothing looked at a month of money, although the monthly
  budget review was graded built; it is graded partial now, because a
  company without the operating kit still has none (F18.12, F9.4; STATUS
  2.199).
- **The month's books go only to a role that may read them.** A bundle whose
  cadence is handed the month is refused unless its role holds `ledger.read`
  and the bundle grants it to the role's division, and the review is refused
  as it fires when the owner has since taken either away (F18.12, F8.1;
  STATUS 2.199).
- **How work came to carry outside content is said in your language**: "the
  week it was handed", "the month it was handed" and "the tickets it was
  given" reached the trace's warning in English (F8.9; STATUS 2.199).

- **The headline metric is yours to choose.** On Team, Goals, choose the
  one number the company is judged by. The portfolio shows it on the
  company's card instead of the first measure on the highest goal, and
  every run is told it, with its pair. A measure aimed at a target can be
  chosen, but a weekly scorecard line or a retired measure cannot. Retiring
  the measure, putting it on the scorecard or deleting it lets go of the
  choice. A headline with nothing paired to it is accepted with a warning,
  and its card says it is not paired (F18.13, STATUS 2.200).
- **A dropped headline is in the history, and a race cannot keep one.**
  When retiring a measure, or putting it on the scorecard, lets go of the
  headline, the company's history says so and why. A choice made while the
  measure is being retired waits for the retirement and is then refused.
  Before, it could be saved and point at a retired number. The chooser on
  Team, Goals starts again from the saved choice when a change elsewhere on
  the page lets go of it (F18.13, STATUS 2.200).
- **Funnel steps on measures.** A measure can name the step of the funnel
  it counts: acquisition, activation, retention, referral or revenue. The
  weekly scorecard groups its lines by step, from acquisition to revenue,
  keeping a pair together, and runs are told the step with the measure.
  Archives carry the steps and the headline (F18.13, STATUS 2.200).

- **Core processes** (F18.14). A switched-on skill can be named one of the
  company's core processes, with the one seat that keeps it current: from
  the skill's **Core process** tab on **Skills**. Every run of that seat is
  told which it owns and to read them before that work. The Team chart lists
  each with its seat, when it last changed (marked once a quarter has gone
  by), and the share of its seat's division's runs that read it over the
  last thirty days. Fewer than five, more than twelve, or one longer than
  sixty lines is warned of and refuses nothing. The database holds a core
  process to one seat of its own company, only the owner may name one, and
  the archive carries both (STATUS 2.201).
- A core process whose seat's division cannot open it with **skill.read**,
  or that is not in force (quarantined, or brought back by an import waiting
  for its gates), shows no share and says why, rather than a share of none;
  and a seat is only told to follow a process in force (STATUS 2.201).
- Every `skill.read` a run makes is now recorded on its task, naming the
  skill, so the company can see which procedures its work follows
  (STATUS 2.201).

- **Vision and plan** (F18.10). A new **Plan** page puts the vision beside
  the plan that serves it: the vision from the company charter, this year's
  goals, this quarter's priorities on or off pace by the rule the weekly
  operating meeting uses, each goal and priority with its latest grade, the
  fiscal quarter's numbers (priorities done against 80%, the committed pass
  rate, the aspirational average and what it says, to-dos finished within a
  week), the weekly scorecard as it stood last week, the
  headline, the long-term issues, the core processes, and the last weekly
  operating meeting with the record of the last one that finished. Each part links to where it is changed: the
  charter, the goals, the scorecard and the issues list. Nothing is stored
  for it; it is read from what the company already keeps (STATUS 2.197).
- **Start from the vision outline.** The company charter's editor offers six
  headings in your language -- our values, purpose and niche, the
  long-range target, who we serve and what makes us different, where we
  will be in three years, and our promise -- added at the end for you to
  fill in, only those the charter does not have yet in any language, with what goes under each said beside the editor and never
  written into the charter. The Plan page shows those sections as the
  vision, found in any of the company's languages, and the whole charter
  when it has none of them. An existing charter, and the one a new company
  starts with, are unchanged (STATUS 2.197).
- **Channels by ring** (F18.11). The Plan page groups the channels the
  company tests: probable while a learning priority tests one, working
  (the core channel) once a committed priority does, and possible, the
  list of a strategy for every channel: the newest document a run following
  channel testing wrote as a list of most of the nineteen, so a later report
  of one test does not replace it. The rings are read from the goals and
  never stored (STATUS 2.197).

### The workspace (F19)

- The ground for rooms where you and the staff you seat talk to each other
  and ask the company for work. Upgrading gives every company its own room
  and a room per division, nobody in them yet and nothing showing them yet.
  The database holds the rooms to people: no agent can read or write a word
  in them, even in its own company, each person sees only the rooms they
  may, and only people write, each as themselves. An archive keeps the mark
  that a member of staff's words are in a piece of work. A seat can now be a
  member, between a viewer and an approver. Work, instructions and answers
  record which member of staff gave them rather than putting them in your
  name, though no member of staff can ask for work or instruct it until it
  is held apart from yours. In the inbox a viewer answers nothing, a member
  answers only a question put to them and decides nothing, and nobody but
  you answers what you alone are asked. Revoking a seat also takes the
  person out of every room and frees their handle (STATUS 2.202).
- Signing out, signing out everywhere, ending a seat, revoking an
  authenticator or making new recovery codes now ends the live views those
  sessions had open at once, rather than when the tab was closed. Your
  assistant and the CEO can neither read nor write anything people say to
  each other: every room, profile, relay and import route is closed to them
  by its address, and refused inside their conversation whatever its
  address (STATUS 2.203).
- A member of staff's words are never read as yours. A run is told what a
  seat said in the seat's name, as a colleague's request that approves
  nothing; work a seat asked for or steered never goes on a yes you gave for
  your own work, and every action of it at tier 2 or above is a card that
  names who asked, which another approver sees first and you a day later
  (at once if nobody else can decide it), folded into one entry and one
  notice a day. Nobody decides a card about work their words are in. The
  mark follows the work into reruns, follow-ups, tickets and to-dos, triage,
  handed escalations and the weekly, quarterly and monthly reviews. You may
  allow one action to one role for a while for staff work too, with a code
  given then, and another seat cannot read a question put to someone else
  (STATUS 2.204).
- Talking to a company's CEO is now paid for before each turn, from the
  CEO's own budget. While everything is stopped, the company is frozen or
  its spending is paused at the ceiling, or its budget has no room, the CEO
  answers with one line from the platform and no model is called; the inbox
  works as before. A reservation a crash interrupted is given back within
  the hour, and only the newest part of a long conversation is sent each
  turn. PALUGADA's own assistant stops at a monthly allowance, USD 20 until
  you change it under This deployment, Model (STATUS 2.205).
- People: you name everyone you seat, and a name that looks like a
  colleague's, yours, PALUGADA's, the CEO's or a role's is refused, in
  look-alike letters too. Seat a member, who asks for work and answers what
  is put to them, or up to thirty people at once with one code, and change
  what each may do (letting someone do more takes your code). Staff choose
  a handle, a picture, their language and quiet hours as they join, sign in
  with their handle and code, and are locked out of a handle after five
  wrong codes; everyone has a profile in the menu (STATUS 2.209).
- The rooms' server: you and your staff can make topic rooms, open or
  private, and direct conversations of two to eight people, talk in threads,
  mention one another, react, pin, edit within a day and take words back,
  and see what is unread and what is addressed to you. A message becomes
  work only when someone who may ask presses for it, with the money held
  first and the message marked in the same step; a reply becomes an
  instruction only when whoever asked for the work tells it, and a member of
  staff stops only work they asked for, recorded under their name. Your own
  words typed here are your work; a member of staff's are always staff work.
  The company's work appears in rooms only as cards that hold no words, and
  a tier 3 approval there is a link to your inbox. Nothing people say in
  rooms is written into the work's record (STATUS 2.206).
- A relay can tell your phone what PALUGADA has for you. Under This
  deployment, Relays, add one by its address and pair it by typing at least
  sixteen characters of the fingerprint its operator shows, naming the
  companies it may hear about, with a code given then. It is told only that
  something happened until you let it say more, and only an incident or a
  tier 3 approval asks your phone to ring. Link your phone there with a code
  or a QR; with presses turned on, a phone that linked with its own key can
  approve or deny at tier 2 and below and answer questions, once per button,
  recorded as a decision from a chat. A relay can never assign, instruct,
  call a meeting or change a setting. Every envelope is signed with this
  deployment's own key, sealed like your other secrets, which you can give a
  new one. `npm run relay:reference` starts a small relay that forwards to
  ntfy, and `docs/relay-protocol.md` is the protocol for anyone building one
  (STATUS 2.208).
- Rooms in the console: the first page of every company, and where a member
  of staff lands. Talk in rooms, threads and direct conversations, mention
  people with @ (never an agent: "Ask the team" asks for work), marked where
  they are named, react, pin, edit and remove; Activity opens the thread a
  reply or a card is in, and archiving a room is asked about first. Your
  conversations with the CEO and PALUGADA sit among the direct messages.
  "Ask the team", or /task, turns a message into work in a drawer
  that says whose budget holds the money, the work's state and result appear
  under the message as it moves, and a work's thread can tell it something.
  Approvals in a room use the inbox's own buttons, and tier 3 sends you to
  the inbox. The Rooms badge counts what is addressed to you, on the tab's
  title too. On a phone, Rooms is a tab, a room fills the screen above the
  keyboard, a thread is a sheet, and a long press or a message's one button
  opens what you may do with it; Money moves into More (STATUS 2.207).
- Rooms are live: a colleague's words, a card moving and the badges change
  on screen as they happen, on one connection per tab that also carries
  the company's work, and a tab that comes back hears what it missed. A
  hidden tab can tell you of a direct message or a mention, once you allow
  it under Your profile, Notify me in this browser. Signing out or ending a
  seat ends its views on every replica, and within thirty seconds at most;
  a member of staff's console shows what they may do as soon as you change
  it. Serve the console over HTTP/2 if you keep many tabs open, and set
  `PALUGADA_LISTEN_DATABASE_URL` if your database URL goes through
  PgBouncer (STATUS 2.210).
