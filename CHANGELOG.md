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
- One authenticator code now covers what builds the company -- a division, a
  role, a grant, a goal, a skill, a bundle -- for ten minutes, instead of a
  code for each. Money, keys, the model, channels, devices and every approval
  of something that cannot be undone still ask every time. Set the length, or
  turn it off, under Settings, Security (STATUS 2.143).
- A task that ends without being done no longer ends in silence: it is put to
  the coordinator your division names first, and to you only if the
  coordinator could not handle it, with what it did. Tickets the company owes
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
