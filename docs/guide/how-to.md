# How-to

Recipes for the things an owner does, each with the console place or the
setting it takes. A step that says "confirm with a code" opens
**Confirm with your authenticator**; type the six-digit code and press
**Confirm**. Settings named `PALUGADA_…` go in `.env` (or the environment
file of a systemd unit) and take effect when the platform restarts: run
`npm start` again, restart the service, or run `docker compose up -d` so
Compose recreates the app container with them. Every variable is listed in
[docs/configuration.md](../configuration.md).

## Ask PALUGADA

Press **Ask PALUGADA** at the top of the sidebar (on a phone, the sparkle at
the top) and say what you want in your own words: "what is left to set
up?", "use Claude for every role and search the web with Brave", "start a
company that sells coffee online and let it run itself", "what is waiting
for me?".

The assistant thinks with this deployment's own model, so choose one first
(**This deployment**, **Model**). It reads what the console can read, and
puts every change in front of you as a card: what it does, the route it
calls, and the values it sends. Nothing changes until you press **Apply**;
a change that takes your authenticator on its own page takes it on the card
too (**Apply with a code**). A key goes in the sealed field on the card and
from there straight to where it is kept: the assistant never sees it, and a
key typed into the conversation is refused, not kept, and not sent to the
model. **Dismiss** a card you do not want; **Start again** forgets the
conversation.

**Speak to it.** Choose what hears you under **This deployment**, **Tools**,
**Listening** (OpenAI, Groq, Deepgram, ElevenLabs, Gemini, DeepInfra, or a
Whisper server of your own), and the microphone next to the text box is on:
tap it, speak, tap again, and what you said is written down and sent. With a
provider under **Speaking**, the speaker button reads each answer aloud. The
recording is heard once and kept nowhere; what it says passes the same check
for a key as anything typed.

A few things are done on their own pages, and the assistant says so:
connecting a Telegram bot, signing an agent CLI in with a Claude plan,
pairing a device, importing a company.

## Talk to a company's CEO

Every company has one CEO, and it is who you talk to about that company.
Press **Talk to Arka, CEO** under **New** in the sidebar (on a phone, the
CEO's picture at the top), or **Talk to Arka** on its card on **Team**. Ask
how the company is doing, what the team is working on, or tell it what you
want done: "sales need to go up next month, what is your plan?".

The CEO answers in its own name and in the persona you chose for it, from
what it reads about its own company and nothing else; for models, keys,
channels or other companies it sends you to **Ask PALUGADA**. Work you want
done comes back as a card that gives it to the CEO's own role, which hands
it to the right people when it runs. As everywhere, nothing changes until
you press **Apply**. **Show what it sends** on a card shows the route and
every value it sends, ids included. Each company's conversation is its own,
and **Start again** forgets only that one.

The CEO thinks with the deployment's model, like **Ask PALUGADA**; it works
on its tasks with its own role's model and runtime.

## Name the team and choose personas

The standard company arrives as a team of named people with titles: Arka the
CEO, Sinta the CPO, Bima the CTO, Laras the CMO, Dimas the CFO, Nadia (Head
of Support), Raka (Head of Quality) and Sari (Head of Data). Open a role on
**Team** and use **Name and persona**:

- **Name** and **Title**: what you call it, and its place in the company.
- **Persona**: a way of working taken from someone whose way of leading is
  on the public record -- for a CEO, Steve Jobs' focus, Jeff Bezos' customer
  obsession, Satya Nadella's growth mindset, Ciputra's building from nothing,
  and more; for a CTO, CFO, CMO and the other titles, their own list. The
  card shows the principles it will work by before you save.
- **In your own words**: anything else about its tone, habits or what it
  cares about.

Press **Save** and confirm with a code. From its next run the role is told
who it is, in that order: its name and title, the persona's principles, your
words, and then its charter. A persona is a way of thinking, never an
identity: every run is told it is not that person, never to speak as them or
use their name, and to sign everything as itself. **History** in the drawer
puts an earlier version back.

**Ask PALUGADA** or the CEO can propose a whole team at once, names, titles
and personas included; each hire is still a card you apply.

### Make another role the CEO

A company always has exactly one CEO: the database refuses a second and
refuses none. A title does not make or unmake one; open the role that should
lead and press **Make … the CEO**, then confirm with a code. The role that
was CEO keeps its name and persona and loses the title, which you can give
it anew. Putting back an earlier version of a role never changes who the CEO
is. A company made from a template that names no CEO, or restored from an
archive made before there were titles, has its coordinator (or its oldest
role) appointed.

## Give work

1. Press **Give work** on **Work** or **Team**, or **New** then
   **Give a role work** in the sidebar. To give it to one role directly,
   open the role on **Team** and use **Give it something to do**.
2. Choose the **Role**. Leave the coordinator to let it decide whose job it
   is.
3. Choose the **Project** and the goal it **Serves**.
4. Write **What to do**. Say what done looks like; the role's own done
   criteria are applied as well.
5. Optionally set **Tokens to reserve**; blank uses the role's default.
6. Press **Assign it**. The role wakes now.

## Tickets: what is owed and not yet anyone's

**Work**, **Tickets** is the company's backlog. The roles file tickets as
they work -- the planner leaves the build behind its plan, the support
responder files the customer who needs somebody else's answer -- and you
can file your own with **New ticket**: what needs doing, the detail and
what done looks like, a priority (P0 first to P3 when there is time), and
the division it belongs to.

A ticket becomes work when somebody is given it. The CEO reads the backlog
and hands a ticket on to the role whose job it is; or press **Give to a
role** and choose the role and the goal it serves. The ticket then shows as
**Being worked**, with **See the work** to open the task, and it closes by
itself when that task finishes. If the task ends any other way -- stopped,
failed, halted -- the ticket opens again and says why. **Close** one nobody
should do, with the reason if you like; **Why it exists** opens the run
that filed it. A deployment that binds `ticket.create` to an outside tracker
in its vendor file sends tickets there instead.

## Check what the company has learned

**Memory** shows what the company knows, one division at a time if you
choose one, newest first, with **Show older** for the rest. Each fact says
where it came from -- you, a template, a run's own lesson, or the hourly
distillation -- and a fact a run learned says **Unverified** until you
confirm it with **It is true**. **From outside content** marks a fact that
came from work which read an email, a web page or a customer's message:
every run is shown it as the data it came from, not as something known,
until you confirm it. **learned 3 more times** means the same lesson came
back from later work. **The work that taught it** opens that task.
**Episodes** holds a line for each piece of finished work -- what it was for
and what it reported -- which runs in the same project find when they search
for past events.

A fact that is wrong: **Correct** it when you know the right one, or
**Take back** when there is nothing to put in its place. Either way it
reaches no run again, and the history keeps what it said.

## Give the company its documents

**Memory**, **Documents** keeps what is longer than a fact: a price list,
the wholesale terms, a supplier contract, the brand guide. **Add a document**
takes a title, who may read it (the whole company, or one division), and the
text -- **Read a file** fills it from a Word document (`.docx`), a PDF, or a
`.txt`, `.md` or `.csv` file, or paste it. Headings (`# Payment`, or a line
in capitals) keep each passage with what it is about; a Word document's
headings are kept as headings, and a PDF's paragraphs as paragraphs. Read
what came out before you add it: the file is read in your browser, the
text is what is kept, and a scanned PDF has no text to read. An old `.doc`
file is saved as `.docx` in Word first.

Every run is told which documents exist, and `memory.search` -- the search
every role already has -- returns the passages its question points at, so a
run quoting a cafe reads the payment terms rather than guessing them. What
it reads there is shown to it as data, never as instructions. **Archive**
takes a document out of every search and keeps its text; **Put it back**
returns it.

**Found by meaning, too.** By default a passage is found by the words it
shares with the question: "refund policy" does not find a document that
says "returns and money back". Under **This deployment**, **Tools**,
**Meaning**, choose a provider (OpenAI, Gemini, Mistral, Voyage, Jina, or
Ollama on your own machine), press **Test it**, and **Save**. The worker then
sends each passage to the provider once, in the background, a batch at a
time; a search then ranks passages by words and meaning together. Choosing
another model gives every passage its new vector the same way, and until
then those passages are found by their words. Each passage's text goes to
the provider you chose, so choose one you would trust with the documents.

## Write, review and switch on skills

A skill is a written procedure the roles follow: how to answer a refund,
what goes in the weekly report. **Settings**, **Skills** lists every one the
company has, whatever stage it is at -- **Being checked**, **With the
reviewer**, **Waiting for you**, **Active**, or **Turned down** with the
reason -- and opening one shows its text, every version with who wrote it
and why, and its checks.

**Write a skill** takes a short name, where it applies, the SKILL.md itself
(front matter with a name and a description, then the procedure) and one
check: phrases every version must contain, such as the ceiling above which
the owner is asked. A skill with no check can never be switched on. **Change
it** proposes a new version of an existing skill from its current text.

Each new version -- yours, a bundle's, an import, or one the company
proposes itself -- goes the same way. Within a minute it is checked against
its phrases, and one that has dropped a phrase is turned down before anyone
reads it. It then goes to the company's reviewer (its CEO, if it has no
reviewer role) as a piece of work, with the document as something to judge,
never as instructions. When the reviewer approves it, you are asked in
**Inbox** with what the reviewer said: approve there, or **Switch it on**
from the skill itself, and every run it applies to reads it from its next
run. **Turn it down** at any stage, with the reason. You cannot approve a
version the reviewer has not read; the review is another role's, so you are
never asked to be it.

## Approve or refuse

1. Open **Inbox**. Items are ordered tier 3 first, then incidents, then the
   oldest. Use the arrow keys, or `j` and `k`, to move between them.
2. Read **What will happen**, **Why** and **If you refuse**, the goal chain
   under **Serves**, the **Capability** and the **Estimated cost**. Press
   **What happened** for the trace of the run that asked.
3. Write **Your note** if you want a reason on the record; it is kept in
   **History** and searched with it.
4. Press **Approve** or **Deny**. To send a question back instead, write it
   in the note and press **Ask a question**. The item stays open, and the
   agent is asked again with your question in front of it. Its answer
   appears on the same card under **The agent answered**, beside **You
   asked**, and the card waits for your decision again; if the question
   changed what it proposes, the card is replaced by one for the new
   action, carrying the question and answer with it.

A tier 3 action asks for a code after you press **Approve**, every time. The
code covers that one action: if the agent comes back with a different amount
or recipient, that is a new item. From Telegram, a tier 3 item is only a link
to this page.

To decide several drafts you have already read, press **Choose several**,
tick them, and press **Approve** or **Deny**. Tier 3 actions, questions and
incidents stay behind and are decided one at a time. **Later** puts an item
out of the queue for an hour, until tomorrow morning, three days or a week,
but never past its expiry.

### Approve for a while

When one of your policies asks before a role does something, for example
before the marketing lead sends email, the same card comes back for every
email. On such a card the **Approve** button has an hourglass beside it:
press it and choose an hour, eight hours, a day or a week. Your code is
asked for, because this loosens a rule. The action on the card runs, and
the same capability by the same role runs without a card until the time
ends. Each use is written in the task's timeline, with the yes it ran on.

It is offered only where a policy is what asked, at tier 2 or below. A tier
3 action is approved one at a time. Work that read something from outside
the company, such as a customer's email or a webhook, is asked about every
time, whatever you allowed: that text may be trying to talk the role into
it. Another role, or another capability, is not covered.

What you allowed is listed at the top of **Inbox** under **Allowed for a
while**, with when it ends and how often it was used. **Take back** ends it
at once, without a code. From Telegram and in a batch, a card is approved
once only.

### Have a model look first: the guardian

Once a role has read something from outside the company, anything it does
at tier 2 or above waits for you. What it does at tier 0 or 1 does not: a
web fetch, a note to memory. A message written to steer it could have it
fetch an address with your customer list in it. On **Settings**,
**Company**, **The guardian**, press **Turn it on**. From then on, in such
work, a model looks at each of those small actions first -- what you asked
for, and the action as your card would describe it, never the outside text
itself -- and sends you the doubtful ones as a card saying why.

It can only ask you more. It never lets through anything a tier, a policy or
outside content would have asked about, and when it cannot judge -- no
model, a provider down, an answer that is not a verdict -- it asks you. A
card you approve is not judged again. Each look is a model call charged to
the work, shown in its timeline. Turning it off takes your code.

## Answer a question from an agent

A role that needs something only you know asks with `owner.ask`, and its
task waits. The item shows **The agent asks** and, when the agent offered
some, a button for each answer.

1. Press one of the offered answers, or write **Your answer** and press
   **Send the answer**. The task carries on with it.
2. Press **Stop the task** to refuse; the task is cancelled.

For an escalation that is not a question, such as a stuck division,
**Answer the agent instead** sends your reply and puts the task back on the
queue without deciding the item.

## Steer, stop or rerun a task

Open the task from **Work** (or **Open the task** on an inbox item).

- While it runs, write a note under **Steer it** and press **Tell it**. Its
  next run reads the note. A note changes nothing the task is allowed to do
  or spend.
- **Stop and redo with this note** cancels it and starts it again with the
  note.
- **Cancel this task** cancels it and everything it started.
- Stopped because its budget ran out, it shows **Continue**: raise the
  account's ceiling on **Money** first, and the same task goes on from where
  it stopped, without doing again what it already did.
- Once it has ended, **Do it again** starts a new task with the same work
  and your optional note. A halted task is never retried by itself; this is
  how you retry it. The new task is told everything you said to the tasks
  it replaces: your notes, and your answers to their questions, however
  many times the work was done again. When the task it replaces did not
  finish, the new one carries on from it: it is told what that one wrote
  or sent, and the same write is answered from that record rather than
  made twice. Work that finished, done again, is done again in full.
- **Replay against the journal** runs the handler again with every side
  effect answered from the record. Nothing leaves. It is offered only for a
  role this deployment runs as code in its own process; a role run by a
  model, an agent CLI or a container is not replayed here, and the button
  is not shown for it.

To see how it was done, open **Every step**: each capability it called, by
name, with its tier, the policies that applied and who approved it; **What
it was asked** and **What came back** for each; the model calls and what
they cost; and, at the top, whether it read content from outside -- an
email, a web page, the backlog -- and through what. **What it did** names
the capability on each event, and **Why it stopped** says what stopped a
halted task. **Cost so far** includes what vendors charged. **What it was
told**, on each run, is everything the run was given before it started --
the charters and its role, the task, its goals, the notes on language,
project and what to return, the skills and what the company knows that
were chosen for it, the steps it had already done, its tools and its model
-- whichever runtime ran it, with any key taken out. It is kept as long as
the prompts are, under **Settings**, **Retention**.

To stop everything at once, press **Stop everything** at the foot of the
sidebar. Work in every company stops at its next step and nothing new
starts; **Resume everything** takes a code. To stop one company, use
**Freeze** under **Settings**, **Company**; **Unfreeze** takes a code.

## Pause or resume a role

1. On **Team**, open the role and press **Pause this role**. Nothing new
   starts for it; this needs only your session.
2. To resume, press **Resume this role** in the same place, or **Resume**
   under **Settings**, **Safeguards**, **Frozen roles**, and confirm with a
   code. A role the platform froze itself, for repeated denials or for
   spending too fast, is resumed the same way.

## Hire a role, open a division, start a project

All three are on **Team**, **Divisions & roles**.

- **Hire a role**: choose the **Division**, a **Short name**, optionally a
  **Name** and **Title**, write **What the role is for** (its charter), list
  its **Tools** (capabilities, separated by commas, at most twelve) and
  **How to know it is done** (one criterion per line). Press **Hire** and
  confirm with a code. If its division is not granted a tool yet, you are
  told which; grant it next. A hire is never titled CEO while the company
  has one; the first role of a company with none becomes its CEO.
- **New division**: a **Name**, a **Short name**, optionally the division it
  sits **Inside** (two levels deep at most), and **Runs at once, at most**.
  Press **Open it** and confirm with a code. A new division can read its own
  memory and skills and nothing else until you grant it more.
- **New project**: a **Name** and **Short name**, optionally its own
  **Work language** (see "Set the company's languages"), then **Start it**.

To grant a capability, open the division and use **Change a grant**: the
**Capability** name and its **Tier**, then **Apply** with a code. The tier
may be the catalogue's or stricter; a looser one is refused. Leaving
**Tier** blank revokes the grant. **Calls at once, at most** says how many
calls to it the division may have under way at the same moment, across
every worker -- one for production deploys, or for a vendor that refuses a
second request while the first runs. Blank keeps what it was, and 0 takes
the limit away. A call that finds every place taken waits up to half a
minute; past that its task is parked and picked up again, spending no
attempt.

**Team**, **Projects** lists every project with what it is for, how much
work is under way and done in it, and what it has cost. **Edit** renames it
and says what it is for -- every run in the project is told, so a run for the
wholesale side knows it is writing to cafes. **Archive** closes a project to
new work; what is under way finishes, its history stays, and **Open again**
reopens it. A company keeps at least one open project. In **Work**, narrow
the list to one project, role or goal, and **Show older** pages back past
the newest hundred.

A hired role runs on the company's most common runtime and the `standard`
model tier. The role's **Change its charter, done criteria, model or run length**
section changes its charter, what done means for it (**Done means**, one
criterion per line) and its **Primary model**; the console does not change a
role's tools after it is hired. A criterion that needs a vendor should say
what counts when that vendor is not connected: a run is told which of its
role's tools are not connected, and cannot meet a criterion that only one of
them could.

## Give a division its mailbox

A division reads its mail with `mailbox.read` and sends with `email.send`
from a mailbox it is given: Gmail, Google Workspace, Microsoft 365, the one
that came with a website, or your own server. Each division has its own, so
Growth can send from sales@ and Support read support@.

1. Where the provider asks for one, make an app password: in Gmail, turn
   on 2-Step Verification, then Security, App passwords.
2. Open the division on **Team**. Under **Keys for services**, the
   capabilities that need it say they need the `mailbox` key.
3. Give **The mailbox's address**, **The mailbox's password**, the **IMAP
   server** and the **SMTP server** with their ports (Gmail:
   `imap.gmail.com` 993 and `smtp.gmail.com` 587), press **Save** and
   confirm with a code. Both servers are signed in to first, so a wrong
   password is said there and then; nothing is kept until they take it.
   **Change the mailbox** gives it another, the same way.

Reading a message does not mark it read in your own mail app, and nothing
a role does can move, flag or delete one. A letter is sent from the
mailbox's address, named for the company; one that answers mail a role read
waits for your yes, with who it is to and what it is about on the card. A
copy in Sent is the provider's to keep: Gmail keeps one, many hosts do not.
The standard template grants both to Support, and `email.send` to Growth.
A vendor entry for `email.send`, below, is used instead of the mailbox.

## Connect a vendor

Capabilities that need somebody's account, such as `email.send` on a
sending service, `invoice.issue` or `dns.update`, are bound to a vendor by an entry: a
method, a URL, headers and a body template, where the result is found, how
to read it back, and which credential it uses. No code. The entries in
[config/vendors.example.json](../../config/vendors.example.json) are offered
as presets: `email.send` on Resend, `dns.read` and `dns.update` on
Cloudflare, `invoice.issue` as a QRIS payment through Midtrans,
`social.publish` on a Mastodon account, `metrics.read` on Plausible and
`calendar.read` on Google Calendar. Each was written from the vendor's own
documentation; none has been run against the vendor from here. The Midtrans entry points at Midtrans' sandbox, so it
charges nobody: change `api.sandbox.midtrans.com` to `api.midtrans.com`, and
use the production server key, when it is right. The Mastodon entry names
`mastodon.social`; change it to your instance.

### From the console

1. Open **This deployment**, **Services**, and press **Connect** on the
   service. Change its address if yours lives elsewhere; **Change the whole
   entry** edits all of it, in the file's shape, for a service that is not a
   preset. The entry is checked against every rule the file is held to
   before your authenticator is asked for, and the deployment starts again
   to bind it.
2. Make sure the division is granted the capability (**Change a grant**) and
   the role lists it among its tools. The standard template already grants
   `email.send` to Growth and Support, for example.
3. Open the division on **Team**. Under **Keys for services** it says which
   of its capabilities need a key, by the name the entry gives it (for
   Resend, `email`), and what the key must be issued with. Paste the key the
   service gave you and confirm with your authenticator. It is sealed in the
   deployment's store, declared with those scopes, and never shown again.
   Paste another under the same name to replace it: the next call uses the
   new one, and the old one is deleted. **Remove** takes it away.

   A key that is signed in for rather than pasted -- Google Calendar's,
   named `google` -- shows **Sign in with Google** instead. The first time,
   register an app with the provider for this deployment:
   - **Register an app** opens the page where one is made. For Google, make
     an OAuth client of type **Web application**, with the consent screen set
     to **Internal** if your account is Google Workspace.
   - Give the app the return address the console shows.
   - Paste its **Client ID** and **Client secret**.

   Press **Sign in with Google**, confirm with your authenticator, then
   **Open the sign-in page** and sign in there in the new tab. The key is
   held when the tab says so. It is sealed like a pasted one, renewed before
   it runs out, and never shown. **Sign in again** replaces it. A Google
   consent screen left in **Testing** ends its sign-ins after seven days;
   publish it, or keep it **Internal**.

A division's key can only name its own sealed secrets, an environment
variable or a mounted file: never one of the deployment's own keys -- the
model's, a channel's, an MCP server's -- which would otherwise be sent, in
a header, to whatever the capability calls.

### From a file

Some vendors cannot be written as one entry, and the example leaves them
out rather than shipping an entry that looks right and is not:

- **Stripe invoices** take two or three calls (an invoice item, the invoice,
  then finalising it), and an entry is one request.
- **Xendit invoices** carry no idempotency key and do not refuse a repeated
  `external_id`, so a retry after a lost answer would bill twice. Xendit
  also calls that API legacy. Midtrans refuses an `order_id` it has seen,
  which is why the example uses it.
- **GitHub branches, Hetzner, Cloudflare record deletion, HubSpot notes and
  Vercel deployments** document no idempotency key either.
- **Gmail** lists messages by id only, so reading one is a second call per
  message, and sending takes the whole message encoded, which a template
  cannot do. Its sign-in works like Google Calendar's; the calls do not fit
  an entry.

An operator can bind vendors in a file instead, which the console cannot
change and whose names it cannot take:

1. Copy the example and change it for your vendor. The platform refuses a
   file that writes without a read-back, has a side effect without an
   idempotency key, or sets a tier looser than the catalogue's, and it stops
   at boot with the reason rather than starting half-configured. Two things
   vary between vendors. A vendor that takes a form rather than JSON, such
   as Stripe or Twilio, needs `"bodyEncoding": "form"`; nested fields are
   sent as `metadata[order]`, the way those vendors read them. A vendor that
   takes the key as an HTTP Basic user name, such as Xendit or Midtrans,
   gets the header `"authorization": "Basic {credentialBasic}"`: the
   platform encodes the key, or a `user:password` pair as it is, and keeps
   the encoded form out of its logs like the key itself. An amount in whole
   units, as Midtrans and Xendit take rupiah, is described with
   `"describe": { "moneyUnits": "amount" }` rather than `moneyCents`, so a
   policy threshold written in cents compares the same money. The
   idempotency key may also travel in the body, as the vendor's own unique
   id for what the call makes -- Midtrans' `order_id` -- when the vendor
   refuses one it has seen.
2. Set `PALUGADA_VENDORS` to the file's path. With Docker Compose, put the
   file in `config/` and rebuild with `docker compose up -d --build`: the
   image copies that directory, and a relative path is read from the app's
   directory, so the setting is `config/` followed by the file's name.
3. Restart. The boot lists `bound by <file>: …` and what is still unbound.
4. Give each division its key as above, under **Keys for services**. A key
   the operator keeps outside the console instead goes where a secret
   reference can reach it: an environment variable whose name starts with
   `PALUGADA_SECRET_` (referenced as `env://` followed by the variable's
   name), or a file under one of the `PALUGADA_SECRET_DIRS` directories,
   `/run/secrets` by default (referenced as `file://` followed by its
   absolute path); see [operations](operations.md#secrets). **Rotate a
   credential** in the division points an existing key at such a reference.

## Add MCP servers

Tools on an MCP server (streamable HTTP) can be used as capabilities, but
only the ones you allow, at the tier you choose.

### From the console

1. Open **This deployment**, **MCP servers**, and press **Add an MCP server**.
2. Under **Start from**, pick a service, and its name, address and how it
   lets PALUGADA in are filled in. There are three kinds:
   - **Signed in to, with nothing to copy:** Notion, Webflow, Square,
     Composio, Pipedream and Arcade. Choosing one asks the server at once,
     and **It asks you to sign in** appears (step 3). Arcade's address ends
     in `{gateway}`: replace it with your gateway's slug from Arcade's
     dashboard.
   - **A key, or a sign-in:** Linear, Atlassian, Airtable, monday.com,
     Intercom, Stripe, Resend, Sentry, Cloudflare, Supabase, Neon, Zapier
     and Smithery (whose address ends in your `{namespace}`). Paste a key (**Get a key** opens the page where the service
     makes one), or leave the **Token** empty and sign in.
   - **Through an app you register first:** GitHub, Asana, Slack, HubSpot
     and Box let an outside tool in only as an app registered with them.
     **Register an app** opens the page where you make one; give it the
     return address the console shows, and paste its **Client ID** and
     **Client secret** when you sign in. GitHub also takes a key.

   Composio, Pipedream, Zapier, Arcade and Smithery each reach many apps
   through one server. What you connect there is what the server lists
   here, and every tool it lists is still allowed one at a time with its
   tier, like any other server's: breadth, not trust.

   Apify, Hugging Face, Context7, Firecrawl, Tavily, Exa and Browserbase take
   a key; Playwright is run on a machine of yours. Coolify takes a token, at
   your own instance's address in place of `{coolify-host}`; Dokploy's
   server is run by you, and lets in whoever reaches it, so it goes where
   only this deployment can. Both let roles see and deploy what runs there:
   [Coolify and Dokploy](coolify-dokploy.md#letting-a-company-see-and-deploy-what-runs-there)
   says how, and why a deploy should wait for you. For any other server,
   leave **Start from** empty and give a **Name** -- lowercase, such as
   `payments`; each tool becomes `mcp.payments.<tool>` -- and its
   **Address**. Paste the **Token** if the server asks for one: it is sealed
   here, and sent where the server reads it.
3. Press **Look at its tools**. Each tool is shown with what it says it does,
   what it takes, and whether the server says it only reads or is
   destructive. Nothing is saved yet.

   A server that signs in with OAuth says **It asks you to sign in**
   instead.
   Give it a **Name**, press **Sign in**, confirm with a code, then **Open
   the sign-in page**, and sign in there in the new tab; the tab says when it
   is done, and the
   console lists the server's tools with what the sign-in gave. The code is
   asked because a saved server of that name signs in with what this sign-in
   gives from then on; a server that cannot be signed in to says so first,
   and no code is spent on it. PALUGADA
   registers itself with the server's authorization server when it allows
   that. One that does not, such as GitHub's, asks for the **Client ID** (and
   **Client secret**) of an app you register with it, coming back to the
   return address shown above them. A sign-in's token is always sent as a
   bearer token, whatever the service's pasted key would have been sent as. The sign-in comes back only to an https
   address or to the machine the console runs on, so on a server reached by
   another address, set `PALUGADA_APP_URL_PUBLIC` to its https address
   first. What the sign-in gives is sealed and never shown, sent only to the
   server it was issued for, and refreshed when the server says it has run
   out; one that can no longer be refreshed makes its tools say to sign in
   again.
4. Tick the tools roles may use and choose each one's **Tier**. Tier 0 is
   offered only for a tool the server says only reads; a tool it calls
   destructive can only be tier 3.
5. A tool at tier 1 or above writes, so it is read back after each call:
   choose another of the server's tools under **Read back with**, its
   arguments (such as `{"id": "{result.id}"}`, filled from what the write
   returned), and what its answer must show -- **In its answer** `amount`
   **Equals** `input.amount` means the amount the role asked for.
6. Press **Allow 2 and save** (the number is how many you ticked) and confirm
   with a code. Each tool is pinned to what the server offers now: if the
   server later rewrites a tool, the tool is refused until you look at it
   again and save.
7. Grant a tool to a division with **Change a grant**, and give it to a role
   on **Team**.

The token is kept while the address stays on the same host; a server moved
to another host needs its token typed again, so it is never handed to a
server it was not given for. A server that no longer passes at the next
start -- it changed a pinned tool, or its token will not open -- is left out
with a note, and everything else starts.

### From a file

An operator can list servers in a file instead. See
[config/mcp.example.json](../../config/mcp.example.json) and the
"MCP servers" paragraph of [docs/configuration.md](../configuration.md).
The file's servers are bound next to the console's, and are changed only in
the file.

1. For each server, give its `name`, `url`, optionally the `credentialAlias`
   whose credential is sent as a bearer token -- or a `tokenRef`, a secret
   reference to the server's own token -- and under `tools` each tool
   you allow with its `tier`. The server can only raise a tier: a tool it
   marks destructive must be tier 3, and a tier 0 tool must be one it says
   only reads.
2. A tool at tier 1 or above needs a `verify` block naming another tool on
   the same server whose answer proves the write happened, and a `pin`.
   Leave the pin out at first: the boot refuses the tool and prints the pin
   it has now. Read what the tool does, copy the pin in, and start again. A
   tool that changes after it was pinned is refused.
3. Set `PALUGADA_MCP_SERVERS` to the file and restart. Each tool becomes the
   capability `mcp.<server>.<tool>`.
4. Grant it to a division with **Change a grant**, and hire a role that
   lists it, as for any capability.

What a server returns counts as content from outside the company, so work
that used it asks you before its next tier 2 action.

## Give roles a browser

A role that must use a website with no API you can get -- a marketplace's
seller centre, a tax or licensing portal, a supplier's ordering page --
needs a browser, not a page reader. Each company has one of its own.

1. **A Chromium.** The image has one, and the compose files give it what
   it needs to run sandboxed. Running PALUGADA on a machine without
   Docker, it finds one where a package manager puts it
   (`apt install chromium` on Debian and Ubuntu), or uses the one
   `PALUGADA_CHROMIUM` names. The boot says which, or that there is none
   ([configuration](../configuration.md)).
2. **Grant it.** On **Team**, **Divisions & roles**, open the division and
   use **Change a grant**: `browser.read` at tier 0, and `browser.act` at
   tier 2 if its roles should fill in forms. Add both to the role's
   **Tools**.
3. **Give it work** that names the site: "Check today's orders on the
   seller centre at https://seller.example.co.id and list the unpaid ones".

What the role does, you can follow:

- **Reading a page** (*Read a page in the browser*) opens it, or follows a
  link from the last page, and reads its text and every link, button,
  field, list and box on it. Nothing it reads is acted on without you: a
  page is somebody else's words.
- **Filling in a page** (*Fill in a page in the browser*) is a card in your
  inbox for every form, with each step on it: `Nama: "Sari"` is what goes
  in the field called Nama, `Kota → Bandung` a choice, `☑ Setuju` a box
  ticked, `▸ Kirim` the button pressed, and `✓ OK` that the page's "Are you
  sure?" is answered yes. Approve, and the steps are done on the page the
  role read -- if it has changed, or an element is not the one named,
  nothing is done.
- **Signing in** is yours: a role never types a password. A role that
  meets a sign-in asks you with a card -- *Ask you to take over the
  browser* -- saying what to do. **Open the browser** on it shows that
  work's page on **Browser**; **Take it over** with a code, and the
  company's work waits while you hold it. Press on the picture to click,
  type into the field the page selected, use the buttons for Enter, Tab
  and the arrows, or open an address. **Give it back** when you are done:
  the role goes on, signed in. What you type goes to the site and is kept
  nowhere else; a hold you forget lapses after fifteen minutes.
- The company's browser keeps what a site sets when you sign in (its
  cookies), sealed like any secret, for every later task, across
  restarts. Closing the company deletes them.
- **Browser** also shows each piece of work's page while it runs, so you
  can watch what a role is doing. It is yours alone: a staff seat does not
  see it.

Every request the browser makes goes through PALUGADA, under the same rules
as `web.fetch`: nothing on this machine's network or the cloud's metadata
service is reached, whatever a page links to or a role names. An internal
site you want reachable is named in `PALUGADA_ALLOW_PRIVATE_HOSTS`.

**Or a browser from an MCP server**, where the platform's is not wanted:

- **Playwright**, on a machine of yours. Run
  `npx @playwright/mcp@0.0.82 --port 8931 --headless` where this deployment
  can reach it (in a container, add `--host 0.0.0.0 --allowed-hosts '*'`),
  then add the **Playwright** server under **MCP servers**. It takes no
  token, so whoever reaches its port drives the browser: keep it on a
  network only this deployment is on.
- **Browserbase**, a browser in the cloud: add the **Browserbase** server
  with its key.

Each of a task's calls to the server share one session, so the page a role
opened is still open for its next step, and for the read-back that checks
it. The session ends when the task has been quiet for five minutes.
Playwright says that navigating, clicking and typing are destructive, so
each is tier 3 and asks you every time; reading the page
(`browser_snapshot`) only reads, and can be tier 0.

## Let roles search the web

A role finds pages with `web.search` and reads one as clean text with
`web.extract`. Both go to a provider you choose: its index, its price, and
where the queries go. Until you choose one for reading pages, a deployment
with a Chromium reads them in its own browser, and the address goes to
nobody else.

1. Open **This deployment**, **Tools**.
2. Under **Web search**, choose a **Provider**. Those under **Free to start,
   no key needed** (Tavily, Firecrawl, Keenable) answer without a key at a
   rate-limited free tier; add a key later for more. The others need one:
   **Get a key** opens the provider's page. SearXNG, or a Firecrawl of your
   own, is **Your own server**: give its address.
3. Type a search under **Try a search** and press **Test it**: the results
   it would give a role are shown, and nothing is saved.
4. Press **Save** and confirm with a code. PALUGADA starts itself again, and
   `web.search` is bound.
5. Do the same under **Reading pages** for `web.extract`, or leave it for
   the deployment's browser to read them. Jina Reader reads twenty pages a
   minute without a key; a Firecrawl of your own is **Your own server**.

The standard template grants both to Delivery and Growth, and the planner
searches before it plans; give them to another role on **Team**. What a
search or a page returns is written outside the company, so work that read
it asks you before its next action at tier 2 or above.

## Let roles make pictures and speak

A role draws a picture from a description with `image.generate`, and turns
text into a voice recording with `speech.synthesize`. Each is a file kept
in the company's files, under `generated/`, like a draft: the deployment
needs `PALUGADA_FILES_ROOT`, and the card says so when it has none.

1. Open **This deployment**, **Tools**.
2. Under **Making pictures**, choose a **Provider** -- OpenAI, fal, OpenRouter,
   DeepInfra, xAI or Google Gemini -- and paste its **API key**. **Model** is
   empty for the one it suggests.
3. Describe a picture under **Try a picture of** and press **Test it**. The
   picture is shown on the page and kept nowhere.
4. Press **Save** and confirm with a code.
5. Under **Speaking**, choose a provider the same way, and a **Voice** if you
   want another than the one it suggests; a role may still ask for another.
   Piper is a speech server of your own, free: run
   `python3 -m piper.http_server -m en_US-lessac-medium` and give its
   address. **Try saying** plays what it made.

**Listening** writes down speech: what you say to the assistant, and, for a
role granted `speech.transcribe`, a recording in the company's files -- a
call, an interview. **Try it: say a few words** records you and shows what
it heard.

The standard template grants both to Growth. Its marketer's twelve tools
are full, so add `image.generate` or `speech.synthesize` to a role on
**Team** in place of one it uses less. Each call reserves the provider's
price for one picture or one clip before it runs.

## Choose or change the model

In the console, open **This deployment** at the foot of the sidebar (on a
phone, under **More**). The page says which model every role runs on now,
per tier, and whether the console or the environment set it.

1. Choose the **Provider**: Anthropic, OpenAI, Google Gemini, OpenRouter, a
   model on this machine (Ollama), or another OpenAI-compatible API. Its
   address comes with it; for your own server, type the address up to `/v1`.
2. Paste the **API key**, if it takes one. **Get a key** opens the
   provider's own page for making one. The key is sealed before it is
   stored and is never shown again; leave the field empty later to keep it.
3. Once the address and key are there, the page asks the provider which
   models it serves. Pick **The model every role runs on** from that list,
   or type a name. For Anthropic you may leave it empty to use Claude's own
   model for each tier. **A different model for each tier** puts the fast,
   standard or deep tier on a cheaper or stronger model.
4. Press **Test it**. The page sends the model one request offering one
   tool, and says whether it answered and called it, answered without
   calling it (a role on it could only answer in words), or did not answer,
   and why.
5. Press **Save** and type a code from your authenticator. PALUGADA starts
   itself again on the new model; tasks in flight carry on from where they
   were, and you stay signed in.

**Go back to the environment's model** removes the console's choice and its
key. Back up the master key the page names: it is what opens the saved keys
([operations](operations.md#backups)).

From the terminal, run `npm run setup` again and answer yes to "Change
it?". It proves the new model answers and calls tools before it writes
`.env`. Then restart. A model chosen in the console takes precedence over
`.env` until you go back to the environment's.

To set it by hand, the variables are `PALUGADA_MODEL_PROVIDER`
(`anthropic` or `openai` for any OpenAI-compatible API),
`PALUGADA_MODEL_KEY_REF`, `PALUGADA_MODEL_URL`, and either `PALUGADA_MODEL`
for one model on every tier or `PALUGADA_MODEL_ALIASES` for one per tier.
The "Models" paragraph of [docs/configuration.md](../configuration.md) has
examples for Anthropic, OpenAI, OpenRouter, Gemini and a model on your own
machine. An OpenAI-compatible provider must have every tier named, or the
boot stops and says which is missing.

- Roles name a tier (`fast`, `standard`, `deep`), so changing the model
  changes it for every role at once. A role's **Primary model** can also
  name a model directly.
- Say what each model costs under **What it costs**, on the same page.
  An unpriced model is charged at a deliberately high rate, $15 in and $75
  out per million tokens, so a budget is never understated. For most
  models that is many times the bill, and a budget stops long before the
  money it names is spent. To price your models:
  1. **Fill from models.dev** fills in the prices the open catalogue at
     [models.dev](https://models.dev) gives. It uses the provider you reach
     the model at, when two list the same model.
  2. Check them against your bill, or type your own, in dollars per
     million tokens.
  3. Press **Save prices** and type a code. A lower price loosens every
     budget, which is why it asks.

  `npm run setup` offers the same prices when it chooses a model, and
  prices a model on your own machine at zero. The file
  `PALUGADA_MODEL_PRICES` names
  ([config/prices.example.json](../../config/prices.example.json)) is laid
  under both.
- `PALUGADA_DRAFT_MODEL` chooses the tier or model for drafting and
  distilling memory (default `standard`).

## Put a role on an agent CLI

A role can be done by an agent CLI instead of the platform's own loop:
Claude Code, Codex, Gemini CLI, OpenCode, Hermes or OpenClaw, or any other
you describe. Each run gets a directory of its own, none of the CLI's own
shell, file or web tools, and the role's granted capabilities as its only
tools, through a bridge that exists for that run. It sees nothing of the
platform's environment except `PATH` and the one variable named for its key.

From the console, open **This deployment**, **Agent CLIs**. Each CLI shows
whether it is installed (and which version, and where), whether it is signed
in, and whether roles can use it now.

1. **Install it.** Press **Install Claude Code** (or Codex, Gemini CLI,
   OpenCode) and confirm with a code. It is installed from its publisher's
   npm package, at the version PALUGADA was checked against, into this
   deployment's own directory (`tools/` in `PALUGADA_STATE_DIR`), and the
   card follows the install as it runs. **Update to the newest** installs
   the latest version instead. A CLI already on the `PATH` of the PALUGADA
   process is found and shown; Hermes, which installs with its own script
   and Python, is installed that way and then found. OpenClaw needs Node 24.
2. **Sign it in.** Paste its API key and press **Save and sign in**, or,
   for Claude Code on a Claude plan, press **Sign in with your Claude plan**:
   the card shows a sign-in page to open in your own browser, and a field
   for the code that page shows you. The credential is sealed like the
   model's key and given to each run under the one variable the CLI reads
   (`CLAUDE_CODE_OAUTH_TOKEN`, `ANTHROPIC_API_KEY`, `CODEX_API_KEY`,
   `GEMINI_API_KEY`, and for Hermes the provider's key with the provider
   named). A Claude Code run signed in this way also gets a home directory
   of its own instead of the operator's.
3. **Turn it on.** Switch on **Roles may run on it**, name what each tier
   means to it if you want to, press **Save** and confirm. PALUGADA starts
   itself again, and the CLI is offered to roles.

A CLI at a version other than the one PALUGADA checked shows **Not the
version PALUGADA checked** on its card, and its roles get no work until you
press **Install** for the checked version or **Accept** for the one you
have, with a code. What keeps a CLI to PALUGADA's tools, and none of its
own, is its flags, and another version may read them differently. Updating
to the newest from the console accepts that version as it installs it.

A ChatGPT or other subscription login whose tokens rotate is not offered:
every run would hold a copy, and the first to refresh would sign the rest
out. Use an API key for those.

From the environment instead:

1. Install the CLI where PALUGADA runs, on the `PATH` of the PALUGADA
   process. The container image has none; under Docker, install it from
   the console into the state volume, or build an image that adds one.
2. Name it in `PALUGADA_AGENT_CLIS`, for example `claude-code` or
   `claude-code,codex`, and make its provider key available as the table in
   the "Agent CLIs" paragraph of [docs/configuration.md](../configuration.md)
   says. For Claude Code, `PALUGADA_CLAUDE_CODE_KEY_VAR` names the variable
   it is given, and `PALUGADA_CLAUDE_CODE_COMMAND` says where the binary is
   when it is not `claude` on the `PATH`. Once the owner has changed a CLI
   in the console, the console's list is the one that counts; the CLIs the
   environment turned on are carried into it the first time.
3. Restart. The boot line `runtimes: …` lists it.

Then, however it was set up:

4. On **Team**, open the role, open **Who does its work**, choose the CLI
   under **Move it to**, press **Move it** and confirm with a code. A runtime
   that is not answering is marked so in the list; a role on it gets no work
   until it answers.
5. A role names a tier -- `fast`, `standard`, `deep` -- and each CLI is
   told what the tier means to it. Claude Code uses its own aliases
   (`haiku`, `sonnet`, `opus`) and Gemini CLI its flash and pro models; for
   the others, name the models in the CLI's entry, for example
   `PALUGADA_RUNTIME_SPECS=[{"name":"codex","models":{"fast":"…","standard":"…","deep":"…"}}]`.
   A tier the CLI has no model for halts the task with a message that says
   so, rather than failing every attempt. A role whose **Primary model** is
   a model name, under **Change its charter, done criteria, model or run length**, is passed
   as it is.

Any other CLI, or a correction to a known one, goes in
`PALUGADA_RUNTIME_SPECS` as JSON: its `command`, its `args` with
placeholders such as `{model}` and `{mcpConfigFile}`, how it takes the
prompt and which output dialect it speaks. The configuration page lists the
fields. A spec that never hands its CLI the bridge is refused at boot,
because the CLI would run with no tools and answer as though it had them.

An agent that speaks the Agent Client Protocol -- Gemini CLI with `--acp`,
Claude or Codex through their ACP adapters, Goose, OpenCode and many more --
needs no dialect of its own: give its entry `"dialect": "acp"` and the
command that starts it in ACP mode, for example
`{"name":"goose-acp","command":"goose","args":["acp"],"dialect":"acp","env":{"GOOSE_PROVIDER":"anthropic","GOOSE_MODEL":"{model}"},"apiKeyEnvVar":"ANTHROPIC_API_KEY"}`
for Goose on Anthropic's models, with the role's model a model name.
PALUGADA hands it the role's tools in the protocol, says yes to those and
no to its own shell and files, and charges what it reports the session
cost. The configuration page has the whole entry for Gemini CLI.

## Use an HTTP runtime

For a runtime that lives behind a URL, such as a hosted agent or a service
in another language:

1. Set `PALUGADA_RUNTIME_HTTP_URL` to where runs are posted, optionally
   `PALUGADA_RUNTIME_HTTP_NAME` (default `http`) and
   `PALUGADA_RUNTIME_HTTP_TOKEN`, sent as a bearer token.
2. The service answers health at the same URL followed by `/health`, and
   speaks the platform's turn protocol: the engine posts the request and
   the answers it owes, and the service replies with the events it has
   produced. `src/runtime/http.ts` and `src/runtime/wire.ts` define it.
3. Restart, and move a role onto it under **Who does its work**.

## Use the Docker runtime

The Docker runtime runs a role's runtime inside a container with no network
at all (`--network none`), read-only, with memory and CPU limits, as a
non-root user. It is the only runtime with network isolation. Each run's
container is named `palugada-run-<run id>` and is removed when the run ends,
even when the runtime inside ignored its stop.

1. Build an image whose entry point speaks the platform's stdio protocol:
   one JSON request in, one event per line out, and tool calls as events on
   standard output (`src/runtime/script.ts`, `src/runtime/wire.ts`). With no
   network, it cannot reach a model provider either; what it can do is what
   its tools and its input allow.
2. Set `PALUGADA_RUNTIME_IMAGE` to the image, and optionally
   `PALUGADA_RUNTIME_CONTAINER_NAME` (default `docker`) and
   `PALUGADA_RUNTIME_DOCKER` for another CLI such as podman. The docker CLI
   must be on the platform's `PATH` and able to reach a daemon.
3. Restart, and move a role onto it under **Who does its work**.

Each run's container is labelled with the worker that started it
(`palugada.worker`). If a worker is killed outright, its containers keep
running; within a minute, a live worker that shares the daemon removes them.

A remote sandbox is the same idea on a provider's machines:
`PALUGADA_SANDBOX_URL` and `PALUGADA_SANDBOX_IMAGE` together, with
`PALUGADA_SANDBOX_TOKEN` and `PALUGADA_SANDBOX_PROVIDER` as needed.

## Schedule recurring work

On **Team**, **Schedules**, press **New schedule**, choose the **Role** and
**Project**, the goal it **Serves**, **What each run is asked to do**, a
**Short name**, how often it **Repeats** -- every day, every weekday, one
day of the week, or every hour -- and **At** what time, the **Time zone**
(the one your browser is in to begin with, such as Asia/Jakarta, shown as
WIB) and the **Priority**, and press **Schedule it**. For anything those
cannot say, choose **Custom, as cron** and type the cron expression (minute,
hour, day, month, weekday). A short name another schedule has is refused,
rather than that schedule overwritten. The table says when each runs in
words, such as "Every weekday at 07:00", with the cron in its tooltip.
Each occurrence creates one task, in the schedule's own time zone. On the
nights the clock changes, a schedule at fixed hours still runs once: at the
first 01:30 when the clock goes back and shows 01:30 twice, and at the moment
the clock jumps (03:00) for a time it skips, such as 02:30. One that runs
every hour keeps to real time, so it runs at both 01:00s. A schedule whose
last five runs said the same thing asks you whether it is still worth
running, and one that cannot fire shows **Cannot fire** with the reason.

Two more choices say what happens when a run cannot go at its time:

- **If the last run is still going**: **Skip this one** (the default) lets
  the occurrence pass and waits for the next; **Run it when the last one
  finishes** holds it, and the table shows **Waiting** until the last run
  ends, then it runs once; **Run both** starts a second run beside the
  first. Skip suits most work: an hourly report whose run takes seventy
  minutes, or a daily one whose task is waiting for your approval, would
  otherwise pay twice for the same work.
- **If missed while PALUGADA was down**: **Always run it once** (the
  default) runs one catch-up however late PALUGADA comes back; **Skip it if
  more than … late** drops an occurrence found later than that, so a 07:00
  briefing does not arrive at 19:00. Late is measured from the most recent
  occurrence that fell due, so an hourly job back from three hours down at
  ten past still runs the one from ten minutes ago. The shortest choice is
  fifteen minutes: a busy deployment can find an occurrence a few minutes
  after its time, and that is not a missed run. A run held by **Run it when
  the last one finishes** that waits past this is dropped too.

Under **Next**, the table says when the last run did not happen and why,
and how many were dropped. Through the API these two choices are `overlap`
(`skip`, `queue` or `allow`) and `catchUpMinutes` (15 to 525600, or `null`);
saving a schedule again under its short name, without `create`, edits it,
and leaves it off if it was off.

The switch on a schedule's row turns it off and on again. Turned on, its
next run is its next time: the runs it would have made while off are not
made all at once. The bin icon removes it, after asking; the work it
already made stays, as work you can open.

To see what a schedule does without waiting for its next occurrence, press
**Run now** on its row. The dialog says how many tokens the run reserves from
the schedule's budget account, and the most one run may spend -- its role's
ceiling for a run, and more for work it hands to other roles; **Run it now** makes the same task an
occurrence would -- the same role, project, goal, brief, priority and budget
account, and for the weekly business review the week read from the company's
records -- and the notification links to it. The schedule's **Next** does not
move: the run is extra, not the next occurrence brought forward. A schedule
that is **Off** can be run this way to try it before you turn it on, and
stays off. Run now is refused while a task the schedule made has not ended
(the notification links to that task), in a frozen company, and when the
goal the schedule serves is closed.

## Let other services start work: triggers

1. On **Team**, **Triggers**, press **New trigger**.
2. Choose the **Role** that does the work, the goal it **Serves**, a
   **Short name**, **At most, per hour**, and **Who calls it**: a token from
   any service, a token in the address for a service that takes only a URL
   (Coolify's notifications, many form builders), or Stripe, GitHub, Slack
   or Standard Webhooks, which sign their deliveries.
3. For a signing sender, give **Where the signing secret is kept**: a
   secret reference such as `env://PALUGADA_SECRET_STRIPE_HOOK`, never the
   secret itself.
4. Write **What to do with each event**, press **Open it** and confirm with
   a code.
5. **Give these to the other service** shows the URL
   (`/api/hooks/<id>`) and, for a token, the token once. Copy it now; if it is
   lost, make a new one. The dialog says where each sender takes them and,
   for a token, shows a `curl` line to test with. For a token in the address
   it shows one URL ending in `?token=`: anyone who sees that address can
   start the work, so keep it out of anything shared, and make a new token if
   it leaks. A trigger that takes a bearer token refuses a token in the
   address, even the right one.

Each delivery becomes one task, and a retried delivery returns the task the
first one started. What the event says reaches the role as data, and the
work takes no tier 2 or higher action without you. **Close** refuses further
events; opening it again takes a code. The trigger URL must be reachable by
the sender, so it needs the HTTPS set-up in [operations](operations.md).

## Let customers write to the company: Telegram

A company can have a Telegram bot of its own that customers write to. Each
message starts work for the role you choose, and every reply waits for your
yes.

1. In Telegram, open @BotFather, send `/newbot`, choose the bot's name and
   username, and copy the token it gives you.
2. On **Customers**, under **Connect a Telegram bot**, paste **The bot's
   token**, choose **Who answers** and the goal it **Serves**, write **What
   to do with each message**, and set **New conversations, at most, per
   hour**.
3. Press **Connect** and confirm with a code. The token is checked with
   Telegram, sealed, and never shown again. The role is given what it needs
   to read a conversation and reply: `chat.read` and `chat.send` on its
   division, and both among its tools.
4. Share the bot's link, `t.me/<username>`, with your customers.

Telegram sends what customers write to `/api/chat-hooks/<id>` at this
deployment's public address (`PALUGADA_APP_URL_PUBLIC`, with the HTTPS
set-up in [operations](operations.md)), with a secret only it was given.
Without a public address the bot is kept and cannot hear; set one and connect
the bot again. Only a customer in their own chat with the bot is heard: a
group the bot was added to, and other bots, start nothing.

A message starts one piece of work, however often Telegram sends it, and a
message written before anyone picked that work up joins it, so a customer
who says hello and then asks in a second message gets one answer. Past the
hour's limit a message is kept, shown with **Past the hour's limit**, and
starts no work. What a customer writes reaches the role as data. The work
began with a stranger's words, so each `chat.send` is a card in your inbox
showing the conversation beside the reply; an approver seat can decide it
too. A standing yes does not cover it.

**Customers** lists the conversations, latest first, marked **Waiting for an
answer** when the customer spoke last; open one to read it. **Close** takes
the bot's webhook off and forgets its token, and what was said stays.
Connecting the same bot again opens the same channel at a new address. A
bot answers for one company at a time.

## Let customers write to the company: WhatsApp

A company's WhatsApp Business number can take customers' messages the same
way, through Meta's Cloud API. It needs this deployment's public address
(`PALUGADA_APP_URL_PUBLIC`), since Meta delivers there.

1. In Meta for Developers, make an app with WhatsApp, add the business
   number, and make a system user with a permanent token that may send for
   it. Use an app of the company's own: Meta sends every number of an app to
   one address, so the number PALUGADA reaches you on needs another app.
2. On **Customers**, choose **WhatsApp**, and give the **Phone number ID**
   (under WhatsApp, API Setup; not the number itself), the **Access token**
   and the **App secret** (App settings, Basic), then who answers, the goal,
   what to do with each message and the hour's limit.
3. Press **Connect** and confirm with a code. The number is checked with
   Meta, and the token and the app secret are sealed.
4. Copy the **Callback URL** and the **Verify token** that appear -- the
   verify token is shown only then -- into the app's WhatsApp,
   Configuration, webhook, and subscribe to `messages`.
5. Share the number's link, `wa.me/<number>`, with your customers.

Only what Meta signed with the app secret is heard, and only messages to this
number; a reaction or a status starts nothing. A picture, a voice note or a
file is kept as what it was, with its caption. WhatsApp lets a business reply
only within 24 hours of the customer's last message: a reply approved after
that is refused, with the reason, before anything is sent, and waits for the
customer to write again. **Close** forgets the token and the app secret;
remove the webhook in the Meta app too.

## Let customers write to the company: its mailbox

The company's own mailbox -- Gmail, Google Workspace, Microsoft 365, or the
one that came with a website -- can take customers' mail the same way. A
worker reads it about once a minute over IMAP, and a reply goes out over
SMTP from the same address, in the customer's thread and in the mailbox's
own Sent mail.

1. Where the provider asks for one, make an app password: in Gmail, turn
   on 2-Step Verification, then Security, App passwords.
2. On **Customers**, choose **Email**, and give **The mailbox's address**,
   **The mailbox's password**, the **IMAP server** and the **SMTP server**
   with their ports (Gmail: `imap.gmail.com` 993 and `smtp.gmail.com` 587),
   then who answers, the goal, what to do with each message and the hour's
   limit.
3. Press **Connect** and confirm with a code. Both servers are signed in to
   first, so a wrong password is said there and then; the password is
   sealed.

Only TLS is used: IMAP on its TLS port, SMTP on 465 or upgraded with
STARTTLS (587), and a server that offers neither is refused. The mailbox is
read from the moment it is connected: the mail it already holds is never
taken for work. An auto-reply, a bounce, a mailing list and the mailbox's
own mail start nothing, and a reply's quoted history is left out of what
the role reads. Reading a message does not mark it read in your own mail
app. When the mailbox cannot be read -- the password changed, the server is
down -- **Customers** says why under the channel, and the mail waits on the
server until it can be. A server with a private certificate is trusted with
`PALUGADA_MAIL_CA`.

## Install a bundle

1. Under **Settings**, **Bundles**, **Install a bundle**, type the
   **Bundle** name and its **Version**, press **Install** and confirm with a
   code.
2. The built-in bundles, with their versions in `src/bundles/builtin.ts`,
   are `company-os` (the operating kit), `content-ops` (a researcher and a
   writer; install `qa-review` first, which brings the reviewer it names),
   `web-ops` (DNS and deployment), `qa-review` and `palugada-dev`.
3. **Is it still what was signed?** checks an installed bundle against the
   hash recorded at install. **Trust a publisher** adds a publisher's public
   key; bundles it signs install as written.

`company-os` brings the weekly business review, run by the strategist on
Monday at 07:45 in the company's time zone. Each week's task is handed the
week in its input, read from the company's records: every active goal with
its numbers and their change over the week, the work finished, the spend
against the monthly limit, and any stage move waiting for you. A goal the
strategist thinks is wrong arrives in your inbox as a proposal; approve it
with your code and the goal changes. Installing a newer `company-os` over an
older one updates its role, rules, cadence and skills in place; it adds
grants and takes none away, so a grant the new version no longer names
(1.3.0 no longer names `metrics.read`) stays until you revoke it.

To bring an installed bundle up to date, install the version this deployment
ships over it. For `company-os`, 1.4.0 adds a critic in its own Strategy
review division: it reads every stage proposal before you do, holds nothing
that acts, and what it said reaches you whether it supports the move or
stops it. 1.5.0 gives the strategist and the critic a name and a title,
Bayu, Chief Strategy Officer, and Citra, Strategy Critic, as every built-in
bundle now does for its roles. What the bundle brings is updated or added
in place. Roles, schedules, work in flight, and any grant an earlier
version made stay, and so does a name or title you gave a role; its skills
arrive again as candidates.

The built-in bundles install as written when they are exactly what this
version of PALUGADA ships: they are part of the platform, as trusted as its
code. Any other unsigned bundle -- including a built-in one somebody changed
-- installs quarantined: only the grants it names at tier 0 are created, its
schedules start switched off, and its policies that allow something are
left out. Grant what its roles need yourself with **Change a grant** in each
of its divisions; each role's drawer lists its **Tools**. A bundle's skills
always arrive as candidates under **Settings**, **Skills**, for a reviewer
and you to approve.

## Set the company's languages

Under **Settings**, **Languages**:

- **Panel language** is what the console is drawn in, on every device, and
  what PALUGADA's own messages to you are written in: Telegram, WhatsApp,
  email and push. Any of 21: English, Indonesian, Malay, Javanese,
  Sundanese, Filipino, Vietnamese, Thai, Simplified Chinese, Japanese,
  Korean, Hindi, Arabic (the console turns right to left), Spanish,
  Brazilian Portuguese, French, German, Dutch, Italian, Turkish or Russian.
- **Agents, by default** is the language every company's agents use unless
  the company sets its own. Press **Save**.
- Under the company's own section, **Work language** is what it produces for
  customers and **Talk language** is what its agents write to you and to
  each other. Empty means the default. Press **Save**; agents follow it from
  their next run.

A project that sells in another market can work in its own language. On
**Team**, **Projects**, press **Edit** on the project (or start one with
**New project**) and choose its **Work language**; **The company's** keeps
it on the company's. Runs in that project write for customers in its
language, and their drafts are checked against it, while every agent still
writes to you in the company's talk language. A project with its own shows
it on its card.

## Rewrite a charter

On **Team**, **Charter**, the company's charter sits above the platform's.
Edit either and press **Save the charter**; your authenticator is asked
for, and the next run of every role is told the new text. **History** lists
the company charter's versions, each with **Put this back**. A charter
travels whole in every run, so it is limited to 20,000 characters and is
best kept to what holds for every piece of work.

The charters are also files, in a git repository beside the deployment's
state (`charters` in `PALUGADA_STATE_DIR`, or `PALUGADA_CHARTERS_DIR`):
`PLATFORM.md`, and `companies/<slug>/SOUL.md` for each company. Every
version saved in the console is written there and committed. Edit a file
there instead -- in an editor, or by pulling from a repository of your own
-- and within a minute it is the charter's next version, recorded in its
history like any other. A file PALUGADA wrote and nobody changed never
overrides the charter in the database.

The directory is a repository of its own, even inside another one. A file
is taken only when it is a plain file within the directory (a link is
never followed), holds no conflict markers and is within the 20,000
characters; anything else is left as it is and named at boot, and the
other charters carry on. While a merge or a rebase is in progress there,
nothing is read, written or committed until you finish it. A version taken
from a file shows in **History** as from the charter repository, not as
yours. When you save a charter whose file cannot be written, the save still
counts, and the console says **Saved, but its file was not written** with
the reason.

## Set budgets and alert thresholds

- On **Money**, set the **Monthly ceiling** and press **Set**. Raising it
  takes a code; lowering it does not.
- When the company is paused at 100%, **Lift the pause**, or give a time
  under **Or override until** and press **Override**. Both take a code.
- **Open an account** adds a budget account for a project, a division or a
  role: a **Name**, a **Token ceiling**, optionally a **Money ceiling** in
  US dollars (or the currency you read money in), what it is **For**,
  **Which one**, and **The account above it**. It takes a code.
- An account's ceilings are for a calendar month in UTC: on the first, what
  it has spent starts again from nothing. When one runs out before then --
  its bar turns red and work is refused with "raise its ceiling under
  Money" -- press **Ceilings** on its row and raise the **Token ceiling** or
  the **Money ceiling**. Raising takes a code; lowering does not.
- Under **Settings**, **Company**, **Alert thresholds** sets when you are
  told something is going wrong: **Daily cost** in US dollars (or the
  currency you read money in), **Failure rate, 0 to 1** and **Policy denials
  a day**. Each fires once per condition per day.

## Push notifications, Telegram, WhatsApp and email

Open **This deployment**, **Channels**. For the chat buttons and the
links in every notification to work, the console must be reachable from your
phone: set `PALUGADA_APP_URL_PUBLIC` to its HTTPS address first.

**Telegram.**

1. In Telegram, open @BotFather, send `/newbot`, and paste the token it
   gives you. Press **Check**: the card shows the bot's name and a link to
   it.
2. Open your bot and press **Start**, then press **Find my chat**. Your chat
   is found, not typed; only private chats are offered, and only the chat
   you choose may press anything.
3. Press **Send a test**, and **Save** with a code from your authenticator.
   The token is sealed; the secret Telegram must send back is made for you,
   sealed too, and the webhook is set to
   `<PALUGADA_APP_URL_PUBLIC>/api/channels/telegram`. Without a public
   address it is saved to send, and the card says its buttons cannot reach
   the console yet.

Telegram gets buttons for questions, proposed procedures and skills, and
approvals up to tier 2; a tier 3 approval or an incident arrives as a link.
Approve is green and Deny red, and an item that waits only so long says
when it expires, in your own time zone ("in 3 hours"). It also gets the
daily digest and a message when work you gave has finished. Buttons are
removed once an item is decided elsewhere, and a press from anyone else is
recorded as a security event. Saving also sets the bot's menu (the `/`
button in your chat) to `/ceo`, `/palugada` and `/help`, in the console's
language. **Use this picture** gives the bot PALUGADA's logo as its profile
photo; you can still choose your own in @BotFather.

**One topic per company.** With several companies, open @BotFather, choose
your bot, and turn on topics (threaded mode) for it. Each company then gets
its own topic in your chat, named after it, the first time it has something
for you: its approvals, questions, finished work and digest arrive there, and
what you write in it goes to that company's CEO -- no `/ceo` needed.
Choosing PALUGADA with `/palugada` opens a topic for PALUGADA's assistant.
Delete a topic and the next message makes it again. Without topics,
everything arrives in the one chat, as before.

**Talking to your CEO in Telegram.** Write to the bot, or send it a voice
note, and your CEO answers there -- the same conversation as **Talk to …,
CEO** in the console. With several companies, send `/ceo` and choose whom
you talk to; `/palugada` talks to PALUGADA's assistant about the whole
deployment. A voice note needs a provider under **Tools**, **Listening**;
the answer shows what was heard, and is also said aloud when one is chosen
under **Speaking**. What the CEO proposes arrives as cards: giving work,
filing a ticket, telling or cancelling a task, a fact to remember or a
measured value is one press in the chat; anything that takes your device,
such as a spending limit, has a button that opens the conversation in the
console. Only you, in your own chat with the bot, are heard; what you say
in a group is not sent to anyone.

While the CEO thinks, the chat shows "Thinking…" with a stop button;
pressing it stops the answer, and nothing it had proposed is put in front
of you. The answer arrives formatted -- bold, lists, links -- as a rich
message. The CEO cannot put a button or a picture in it: every HTML tag is
taken out before it is sent, and a picture becomes a link you see before
opening. A local Bot API server too old for rich messages or drafts gets
plain text and "typing…" instead.

**WhatsApp.** The same as Telegram, on a WhatsApp Business number through
Meta's Cloud API. It needs a Meta app, which takes longer to set up than a
Telegram bot, and Meta charges for a conversation the business starts.

1. In Meta for Developers, make an app with the WhatsApp product and add
   your business number. Under **Business settings**, **System users**,
   make a system user, give it the app and the number, and generate a
   token that does not expire, with `whatsapp_business_messaging`.
2. In the card, fill in the **Phone number ID** (under WhatsApp, **API
   Setup**; it is not the number), **Your WhatsApp number** with its
   country code, the **Access token**, and the **App secret** (the app's
   **Basic** settings). Press **Save** with a code from your
   authenticator. The number is checked with Meta first, and the three
   secrets are sealed.
3. The card then shows a **Callback URL** and a **Verify token**. In the
   app's WhatsApp **Configuration**, paste both as the webhook and
   subscribe to `messages`.
4. Send the number any message from your WhatsApp. That opens the
   conversation, and your CEO answers.

WhatsApp lets a business write first only within 24 hours of your last
message. Past that, a message is refused, and PALUGADA can only send an
approved template in its place. Make a **utility** template with one body
parameter (for example `PALUGADA: {{1}}. Reply to see the buttons.`),
and put its name and language in **Template**, as `palugada_notice:id`.
The item's summary goes in the parameter, and its buttons follow as soon
as you reply. Without a template, the message is not sent, and the
company's record says why.

What arrives, and what a press can do, is what Telegram gets: buttons for
questions, proposed procedures and skills, and approvals up to tier 2; a
tier 3 approval or an incident is a link. A question with choices is a
list. **Ask** sends a message you answer by replying to it (swipe it), and
the task reads your words. Write anything else and your CEO answers;
`/ceo` lists whom you can talk to, and `/palugada` talks to PALUGADA's
assistant. A card the chat may apply comes with an **Apply** button.
WhatsApp reads text here; a voice note is for Telegram or the console.

Only your number is heard. A press from any other number is recorded as a
security event in the item's company and is not answered. Every delivery
is checked against Meta's signature, and each message is acted on once,
even when Meta sends it again after a restart.

**Your phone (push).** Push carries only incidents and tier 3 approvals,
which is what may interrupt you outside your hours, and the daily digest,
quietly.

- **ntfy** is the simplest: install the ntfy app, subscribe to the topic the
  card suggests, and press **Send a test**. Anyone who knows a topic on
  ntfy.sh can read it, so keep the long random one, or run an ntfy of your
  own and give its token. An incident arrives at ntfy's highest priority,
  which breaks through the phone's quiet mode.
- **Your own webhook** is sent a JSON body with `title`, `body`, `priority`
  (`high` for an incident), `tag` and `url`, and the token as its
  `Authorization` header.

**Slack and Discord.** Add an incoming webhook to a channel (Slack: an
incoming webhook app; Discord: the channel's settings, Integrations,
Webhooks), paste its address, press **Send a test**, and **Save**. They are
told what needs you, with a link to decide it in the console: a webhook
message cannot carry buttons. The address is sealed, since anyone holding
it can post to that channel.

**Email.** Choose Resend, Postmark or SendGrid, type an address the service
lets your account send from (one on a domain you verified there) and your
own, paste an API key, press **Send a test**, and **Save** with a code. You
are emailed what needs you, the daily digest and finished work, each with a
link to decide or read it in the console: an email is forwarded, previewed
and scanned by filters, so it carries no buttons. The key is sealed.

**From the environment instead.** `PALUGADA_TELEGRAM_TOKEN`,
`PALUGADA_TELEGRAM_CHAT` (your user id) and
`PALUGADA_TELEGRAM_WEBHOOK_SECRET` (a random string you then give
Telegram's `setWebhook` as its secret token, with `allowed_updates` of
`message`, `callback_query` and `stopped_message_generation`, the last for
the stop button); `PALUGADA_PUSH_URL`, with
`PALUGADA_PUSH_FORMAT=ntfy` and `PALUGADA_PUSH_TOPIC` for ntfy and
`PALUGADA_PUSH_TOKEN`; `PALUGADA_SLACK_WEBHOOK` and
`PALUGADA_DISCORD_WEBHOOK`; `PALUGADA_WHATSAPP_PHONE_ID`,
`PALUGADA_WHATSAPP_TOKEN`, `PALUGADA_WHATSAPP_APP_SECRET`,
`PALUGADA_WHATSAPP_VERIFY_TOKEN` (a random string you give Meta as the
webhook's verify token), `PALUGADA_WHATSAPP_OWNER` and, optionally,
`PALUGADA_WHATSAPP_TEMPLATE`; `PALUGADA_EMAIL_PROVIDER` (`resend`,
`postmark` or `sendgrid`), `PALUGADA_EMAIL_KEY`, `PALUGADA_EMAIL_FROM` and
`PALUGADA_EMAIL_TO`. Each credential can instead be a secret
reference in the variable of the same name ending `_REF`. A channel set in
the console replaces that channel's variables.

## Export and import a company

- **Export**: under **Settings**, **Company**, **Export**, press
  **Download as JSON**. The file holds the whole company: structure,
  tasks, events, memory, skills and every configuration version. Prompt and
  response bodies are left out, and credentials are references only.
- **Import in the console:** on **Home**, press **Restore from an export**,
  choose the **Export file**, read the preview of what comes back and what
  does not, set the **Name** and **Short name**, press **Restore it** and
  confirm with a code. It arrives as a new company beside any that exist.
- **Import from a terminal:** for an operator moving a deployment or a file
  too large for a browser:
  `npm run company:import -- <archive> <slug> [name]`.

Every reference is remapped on the way in. Credentials must be set up again
behind their references, skills from outside come back quarantined, and
bundle installs, model traces, retention records and devices are not
restored.

## Close a company

For a business that is over, or whose records the people in them have asked
you to erase (UU 27/2022 on personal data).

1. Export it first if you want a copy: **Settings**, **Company**, **Export**.
2. In the same place, under **Close this company**, choose how many days
   it has before it is erased, from 7 to 90, type its name exactly as it is
   shown, press **Close the company** and confirm with a code.
3. It is frozen at once: nothing of it starts, and what is running stops at
   its next step. The sidebar marks it **closing**, and its settings say the
   day.
4. Until that day, **Keep this company** takes the closing back. It stays
   frozen; unfreeze it when you want it working again.
5. On the day, the worker erases it: every row of it -- work, history,
   memory, documents, model traces, conversations -- and the keys its
   divisions held. Then what it kept on disk: its directory under the files
   root (`PALUGADA_FILES_ROOT`), with the drafts, pictures and recordings its
   roles made, and its folder in the charter repository, whose removal is
   committed there. **This deployment**, **Erased companies** keeps one
   line: its name, when it was closed and erased, and how much went.
6. If erasing it fails, it is listed on the same page under **Not erased
   yet**, with what went wrong and when it is tried next. It is tried again
   a minute later, then less often each time, up to every six hours; the
   other companies whose day has come are erased meanwhile, and everything
   of this one stays until a try succeeds. **Keep this company** still
   takes it back. A file or folder that could not be removed after the rows
   went is named in the worker's log with its path; the rows stay erased,
   and the next worker to start tries again.

What erasing cannot reach: backups taken before the day, until they age out
(see [Backups](operations.md#backups)); the charter repository's history,
whose earlier commits still hold every charter the company had; files under
a files root the deployment is no longer started with; what the model
provider and the vendors were sent while it worked; and your own chat
history on Telegram or WhatsApp.

To take a company's charters out of the repository's history as well,
rewrite it yourself once the company is erased, for example with
`git filter-repo --invert-paths --path companies/<slug>` in the charters
directory (`PALUGADA_CHARTERS_DIR`, or `charters` in the state directory),
and do the same to every clone of it. PALUGADA does not rewrite a history
someone may have pulled.

## Search

Press `⌘K` (or `Ctrl+K`), or `/`, anywhere in the console. The same box
jumps to pages and commands and, after two characters, finds tasks,
decisions and memory across every company. **History** has its own search
over titles, summaries and your notes, and **Memory** searches what one
company knows.
