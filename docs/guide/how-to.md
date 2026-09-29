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
   task reads your question on its next run before it proposes again.

A tier 3 action asks for a code after you press **Approve**, every time. The
code covers that one action: if the agent comes back with a different amount
or recipient, that is a new item. From Telegram, a tier 3 item is only a link
to this page.

To decide several drafts you have already read, press **Choose several**,
tick them, and press **Approve** or **Deny**. Tier 3 actions, questions and
incidents stay behind and are decided one at a time. **Later** puts an item
out of the queue for an hour, until tomorrow morning, three days or a week,
but never past its expiry.

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
- Once it has ended, **Do it again** starts a new task with the same work
  and your optional note. A halted task is never retried by itself; this is
  how you retry it.
- **Replay against the journal** runs the handler again with every side
  effect answered from the record. Nothing leaves.

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
- **New project**: a **Name** and **Short name**, then **Start it**.

To grant a capability, open the division and use **Change a grant**: the
**Capability** name and its **Tier**, then **Apply** with a code. The tier
may be the catalogue's or stricter; a looser one is refused. Leaving
**Tier** blank revokes the grant.

**Team**, **Projects** lists every project with what it is for, how much
work is under way and done in it, and what it has cost. **Edit** renames it
and says what it is for -- every run in the project is told, so a run for the
wholesale side knows it is writing to cafes. **Archive** closes a project to
new work; what is under way finishes, its history stays, and **Open again**
reopens it. A company keeps at least one open project. In **Work**, narrow
the list to one project, role or goal, and **Show older** pages back past
the newest hundred.

A hired role runs on the company's most common runtime and the `standard`
model tier. The role's **Change its charter, done criteria or model**
section changes its charter, what done means for it (**Done means**, one
criterion per line) and its **Primary model**; the console does not change a
role's tools after it is hired. A criterion that needs a vendor should say
what counts when that vendor is not connected: a run is told which of its
role's tools are not connected, and cannot meet a criterion that only one of
them could.

## Connect a vendor

Capabilities that need somebody's account, such as `email.send`,
`invoice.issue` or `dns.update`, are bound to a vendor by an entry: a
method, a URL, headers and a body template, where the result is found, how
to read it back, and which credential it uses. No code. The entries in
[config/vendors.example.json](../../config/vendors.example.json) are offered
as presets: `email.send` on Resend, `dns.read` and `dns.update` on
Cloudflare, `invoice.issue` as a QRIS payment through Midtrans,
`social.publish` on a Mastodon account and `metrics.read` on Plausible. Each
was written from the vendor's own documentation; none has been run against
the vendor from here. The Midtrans entry points at Midtrans' sandbox, so it
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
- **Google Calendar and Gmail** take OAuth access tokens that expire within
  the hour. PALUGADA signs in with OAuth to MCP servers, not yet to a vendor
  bound by an entry.

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
2. Under **Start from**, pick a service -- GitHub, Linear, Stripe,
   Atlassian, Sentry, Cloudflare, Neon, Zapier, Apify, Hugging Face,
   Context7, Firecrawl, Tavily, Exa, Browserbase, or Playwright, which you
   run yourself -- and its name, address and where its token goes are
   filled in; **Get a key** opens the page where the service makes one.
   For any other server, leave it empty and give a **Name** -- lowercase,
   such as `payments`; each tool becomes `mcp.payments.<tool>` -- and its
   **Address**. Paste the **Token** if the server asks for one: it is sealed
   here, and sent where the server reads it.
3. Press **Look at its tools**. Each tool is shown with what it says it does,
   what it takes, and whether the server says it only reads or is
   destructive. Nothing is saved yet.

   A server that signs in with OAuth -- Linear, Notion, Sentry, Atlassian and
   Stripe's hosted servers do -- says **It asks you to sign in** instead.
   Give it a **Name**, press **Sign in**, then **Open the sign-in page**, and
   sign in there in the new tab; the tab says when it is done, and the
   console lists the server's tools with what the sign-in gave. PALUGADA
   registers itself with the server's authorization server when it allows
   that. One that does not, such as GitHub's, asks for the **Client ID** (and
   **Client secret**) of an app you register with it, coming back to the
   address the message names. The sign-in comes back only to an https
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

A role that must use a website -- sign in to a supplier's portal, fill a
form -- needs a browser, not a page reader. It comes from an MCP server:

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
(`browser_snapshot`) only reads, and can be tier 0. That is the price of a
browser that can do anything a person can. To read pages without asking,
use **Reading pages** under **Tools** instead.

## Let roles search the web

A role finds pages with `web.search` and reads one as clean text with
`web.extract`. Both go to a provider you choose: its index, its price, and
where the queries go.

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
5. Do the same under **Reading pages** for `web.extract`. Jina Reader reads
   twenty pages a minute without a key.

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
- Give a model its real price in the file `PALUGADA_MODEL_PRICES` names
  (see [config/prices.example.json](../../config/prices.example.json)); a
  model on your own machine costs zero. Unpriced models are charged at a
  deliberately high rate so a budget is never understated.
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
   a model name, under **Change its charter, done criteria or model**, is passed
   as it is.

Any other CLI, or a correction to a known one, goes in
`PALUGADA_RUNTIME_SPECS` as JSON: its `command`, its `args` with
placeholders such as `{model}` and `{mcpConfigFile}`, how it takes the
prompt and which output dialect it speaks. The configuration page lists the
fields. A spec that never hands its CLI the bridge is refused at boot,
because the CLI would run with no tools and answer as though it had them.

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
non-root user. It is the only runtime with network isolation.

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

A remote sandbox is the same idea on a provider's machines:
`PALUGADA_SANDBOX_URL` and `PALUGADA_SANDBOX_IMAGE` together, with
`PALUGADA_SANDBOX_TOKEN` and `PALUGADA_SANDBOX_PROVIDER` as needed.

## Schedule recurring work

On **Team**, **Schedules**, press **New schedule**, choose the **Role** and
**Project**, the goal it **Serves**, **What each run is asked to do**, a
**Short name**, the **Cron** expression (minute, hour, day, month,
weekday), the **Time zone** and the **Priority**, and press **Schedule it**.
Each occurrence creates one task, in the schedule's own time zone. A
schedule whose last five runs said the same thing asks you whether it is
still worth running, and one that cannot fire shows **Cannot fire** with the
reason.

## Let other services start work: triggers

1. On **Team**, **Triggers**, press **New trigger**.
2. Choose the **Role** that does the work, the goal it **Serves**, a
   **Short name**, **At most, per hour**, and **Who calls it**: a token from
   any service, or Stripe, GitHub, Slack or Standard Webhooks, which sign
   their deliveries.
3. For a signing sender, give **Where the signing secret is kept**: a
   secret reference such as `env://PALUGADA_SECRET_STRIPE_HOOK`, never the
   secret itself.
4. Write **What to do with each event**, press **Open it** and confirm with
   a code.
5. **Give these to the other service** shows the URL
   (`/api/hooks/<id>`) and, for a token, the token once. Copy it now; if it is
   lost, make a new one. The dialog says where each sender takes them and,
   for a token, shows a `curl` line to test with.

Each delivery becomes one task, and a retried delivery returns the task the
first one started. What the event says reaches the role as data, and the
work takes no tier 2 or higher action without you. **Close** refuses further
events; opening it again takes a code. The trigger URL must be reachable by
the sender, so it needs the HTTPS set-up in [operations](operations.md).

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

- **Panel language** is what the console is drawn in, on every device.
- **Agents, by default** is the language every company's agents use unless
  the company sets its own. Press **Save**.
- Under the company's own section, **Work language** is what it produces for
  customers and **Talk language** is what its agents write to you and to
  each other. Empty means the default. Press **Save**; agents follow it from
  their next run.

## Rewrite a charter

On **Team**, **Charter**, the company's charter sits above the platform's.
Edit either and press **Save the charter**; your authenticator is asked
for, and the next run of every role is told the new text. **History** lists
the company charter's versions, each with **Put this back**. A charter
travels whole in every run, so it is limited to 20,000 characters and is
best kept to what holds for every piece of work.

## Set budgets and alert thresholds

- On **Money**, set the **Monthly ceiling** and press **Set**. Raising it
  takes a code; lowering it does not.
- When the company is paused at 100%, **Lift the pause**, or give a time
  under **Or override until** and press **Override**. Both take a code.
- **Open an account** adds a budget account for a project, a division or a
  role: a **Name**, a **Token ceiling**, optionally a
  **Money ceiling (cents)**, what it is **For**, **Which one**, and
  **The account above it**. It takes a code.
- An account's ceilings are for its whole life: tokens spent stay spent.
  When one runs out -- its bar turns red and work is refused with "raise its
  ceiling under Money" -- press **Ceilings** on its row and raise the
  **Token ceiling** or the **Money ceiling**. Raising takes a code; lowering
  does not.
- Under **Settings**, **Company**, **Alert thresholds** sets when you are
  told something is going wrong: **Daily cost, cents**,
  **Failure rate, 0 to 1** and **Policy denials a day**. Each fires once per
  condition per day.

## Push notifications and Telegram

Open **This deployment**, **Channels**. For Telegram's buttons and the
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

**From the environment instead.** `PALUGADA_TELEGRAM_TOKEN`,
`PALUGADA_TELEGRAM_CHAT` (your user id) and
`PALUGADA_TELEGRAM_WEBHOOK_SECRET` (a random string you then give
Telegram's `setWebhook` as its secret token, with `allowed_updates` of
`message`, `callback_query` and `stopped_message_generation`, the last for
the stop button); `PALUGADA_PUSH_URL`, with
`PALUGADA_PUSH_FORMAT=ntfy` and `PALUGADA_PUSH_TOPIC` for ntfy and
`PALUGADA_PUSH_TOKEN`; `PALUGADA_SLACK_WEBHOOK` and
`PALUGADA_DISCORD_WEBHOOK`. Each credential can instead be a secret
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

## Search

Press `⌘K` (or `Ctrl+K`), or `/`, anywhere in the console. The same box
jumps to pages and commands and, after two characters, finds tasks,
decisions and memory across every company. **History** has its own search
over titles, summaries and your notes, and **Memory** searches what one
company knows.
