# How-to

Recipes for the things an owner does, each with the console place or the
setting it takes. A step that says "confirm with a code" opens
**Confirm with your authenticator**; type the six-digit code and press
**Confirm**. Settings named `PALUGADA_…` go in `.env` (or the environment
file of a systemd unit) and take effect when the platform restarts: run
`npm start` again, restart the service, or run `docker compose up -d` so
Compose recreates the app container with them. Every variable is listed in
[docs/configuration.md](../configuration.md).

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

- **Hire a role**: choose the **Division**, a **Short name**, write
  **What the role is for** (its charter), list its **Tools** (capabilities,
  separated by commas, at most twelve) and **How to know it is done** (one
  criterion per line). Press **Hire** and confirm with a code. If its
  division is not granted a tool yet, you are told which; grant it next.
- **New division**: a **Name**, a **Short name**, optionally the division it
  sits **Inside** (two levels deep at most), and **Runs at once, at most**.
  Press **Open it** and confirm with a code. A new division can read its own
  memory and skills and nothing else until you grant it more.
- **New project**: a **Name** and **Short name**, then **Start it**.

To grant a capability, open the division and use **Change a grant**: the
**Capability** name and its **Tier**, then **Apply** with a code. The tier
may be the catalogue's or stricter; a looser one is refused. Leaving
**Tier** blank revokes the grant.

A hired role runs on the company's most common runtime and the `standard`
model tier. The role's **Change its charter or model** section changes its
charter and its **Primary model**; the console does not change a role's
tools after it is hired.

## Connect a vendor

Capabilities that need somebody's account, such as `email.send`,
`invoice.issue` or `dns.update`, are bound by a JSON file you write. The file
holds no code: each entry is a method, a URL, headers and a body template,
where the result is found, how to read it back, and which credential it
uses. [config/vendors.example.json](../../config/vendors.example.json) binds
`email.send` to Resend, `dns.read` and `dns.update` to Cloudflare, and
`invoice.issue` to Stripe.

1. Copy the example and change it for your vendor. The platform refuses a
   file that writes without a read-back, has a side effect without an
   idempotency key, or sets a tier looser than the catalogue's, and it stops
   at boot with the reason rather than starting half-configured.
2. Set `PALUGADA_VENDORS` to the file's path. With Docker Compose, put the
   file in `config/` and rebuild with `docker compose up -d --build`: the
   image copies that directory, and a relative path is read from the app's
   directory, so the setting is `config/` followed by the file's name.
3. Put each vendor's API key where a secret reference can reach it: an
   environment variable whose name starts with `PALUGADA_SECRET_`
   (referenced as `env://` followed by the variable's name), or a file under
   one of the `PALUGADA_SECRET_DIRS` directories, `/run/secrets` by default
   (referenced as `file://` followed by its absolute path). Only those two
   are read; see [operations](operations.md#secrets).
4. Restart. The boot lists `bound by <file>: …` and what is still unbound.
5. Make sure the division is granted the capability (**Change a grant**) and
   the role lists it among its tools. The standard template already grants
   `email.send` to Growth and Support, for example.
6. Give the division a credential with the entry's `credentialAlias` (for
   Resend, `email`) pointing at the secret, and declaring the scopes the
   entry's `requiredScopes` names. There is no console form for adding one
   yet, so the operator adds the row as the control-plane role, after step 4
   so the platform already knows what the capability needs:

   ```sh
   psql "<PALUGADA_ADMIN_URL from .env>" -c "
     INSERT INTO credentials (company_id, division_id, alias, secret_ref, scopes)
     SELECT d.company_id, d.id, 'email', 'env://PALUGADA_SECRET_<NAME>', '{email:send}'
       FROM divisions d JOIN companies c ON c.id = d.company_id
      WHERE c.slug = 'kopi-nusantara' AND d.slug = 'growth'"
   ```

   With Docker Compose, run the same statement with
   `docker compose exec db psql -U postgres -d palugada -c "…"`. The database
   refuses a scope no capability of the division needs, and a secret written
   into the reference column instead of a reference. This row does not pass
   through the governance log. Once it exists, **Rotate a credential** in
   the division repoints or rotates it from the console with a code.

## Add MCP servers

Tools on an MCP server (streamable HTTP) can be used as capabilities, but
only the ones a file you write names. See
[config/mcp.example.json](../../config/mcp.example.json) and the
"MCP servers" paragraph of [docs/configuration.md](../configuration.md).

1. For each server, give its `name`, `url`, optionally the `credentialAlias`
   whose credential is sent as a bearer token, and under `tools` each tool
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

## Choose or change the model

Run `npm run setup` again and answer yes to "Change it?". It proves the new
model answers and calls tools before it writes `.env`. Then restart.

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
- `PALUGADA_DRAFT_MODEL` chooses the tier or model for drafting, distilling
  memory and screening skills (default `standard`).

## Put a role on an agent CLI

A role can be done by an agent CLI instead of the platform's own loop:
Claude Code, Codex, Gemini CLI, OpenCode, Hermes or OpenClaw, or any other
you describe. Each run gets a directory of its own, none of the CLI's own
shell, file or web tools, and the role's granted capabilities as its only
tools, through a bridge that exists for that run. It sees nothing of the
platform's environment except `PATH` and the one variable named for its key.

1. Install the CLI where PALUGADA runs, on the `PATH` of the PALUGADA
   process. The container image has none; under Docker, build an image from
   it that adds one.
2. Name it in `PALUGADA_AGENT_CLIS`, for example `claude-code` or
   `claude-code,codex`, and make its provider key available as the table in
   the "Agent CLIs" paragraph of [docs/configuration.md](../configuration.md)
   says. For Claude Code, `PALUGADA_CLAUDE_CODE_KEY_VAR` names the variable
   it is given, and `PALUGADA_CLAUDE_CODE_COMMAND` says where the binary is
   when it is not `claude` on the `PATH`.
3. Restart. The boot line `runtimes: …` lists it.
4. On **Team**, open the role, open **Who does its work**, choose the CLI
   under **Move it to**, press **Move it** and confirm with a code. A runtime
   that is not answering is marked so in the list; a role on it gets no work
   until it answers.
5. Under **Change its charter or model**, set **Primary model** to a model
   name the CLI accepts. The CLI is started with the role's model as its
   model, and the tiers `fast`, `standard` and `deep` are translated only by
   the platform's own loop.

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
**Project**, a **Short name**, the **Cron** expression (minute, hour, day,
month, weekday), the **Time zone** and the **Priority**, and press
**Schedule it**. Each occurrence creates one task, in the schedule's own
time zone. A schedule whose last five runs said the same thing asks you
whether it is still worth running.

At the time of writing this form sends neither the goal the work serves nor
a brief, and every task must name its goal, so a schedule made here shows
**Cannot fire** with the reason. Until the form asks for them, create the
schedule through the owner API, which takes `goalId` and `input` (for the
standard roles, `{"goal": "…"}`) on `POST /api/companies/<id>/schedules`,
with the session token that `POST /api/auth/sign-in` returns for a code.
The weekly business review that `company-os` installs is not affected.

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

An unsigned bundle, which the built-in ones are unless the operator signs
them, installs quarantined: only the grants it names at tier 0 are created
(the built-in bundles name none), its schedules start switched off, and its
policies that allow something are left out. Grant what its roles need
yourself with **Change a grant** in each of its divisions; each role's
drawer lists its **Tools**. Its skills arrive as candidates under
**Settings**, **Skills**, for a reviewer and you to approve.

## Set the company's languages

Under **Settings**, **Languages**:

- **Panel language** is what the console is drawn in, on every device.
- **Agents, by default** is the language every company's agents use unless
  the company sets its own. Press **Save**.
- Under the company's own section, **Work language** is what it produces for
  customers and **Talk language** is what its agents write to you and to
  each other. Empty means the default. Press **Save**; agents follow it from
  their next run.

## Set budgets and alert thresholds

- On **Money**, set the **Monthly ceiling** and press **Set**. Raising it
  takes a code; lowering it does not.
- When the company is paused at 100%, **Lift the pause**, or give a time
  under **Or override until** and press **Override**. Both take a code.
- **Open an account** adds a budget account for a project, a division or a
  role: a **Name**, a **Token ceiling**, optionally a
  **Money ceiling (cents)**, what it is **For**, **Which one**, and
  **The account above it**. It takes a code.
- Under **Settings**, **Company**, **Alert thresholds** sets when you are
  told something is going wrong: **Daily cost, cents**,
  **Failure rate, 0 to 1** and **Policy denials a day**. Each fires once per
  condition per day.

## Push notifications and Telegram

Both need the console reachable from your phone, so set
`PALUGADA_APP_URL_PUBLIC` to its HTTPS address first; notifications link
there.

**Push.** Set `PALUGADA_PUSH_URL` to an HTTPS endpoint that accepts a JSON
POST, such as a relay in front of a phone push service, and
`PALUGADA_PUSH_TOKEN` to the value of its `Authorization` header if it needs
one. The body carries `title`, `body`, `priority` (`high` for an incident),
`tag` and `url`. Push carries only incidents and tier 3 approvals, which is
what may interrupt you, and the daily digest.

**Telegram.**

1. Create a bot with Telegram's BotFather and note its token. Send the bot a
   message from your own account, and note your user id; the chat with the
   bot is the only one allowed to press anything.
2. Set `PALUGADA_TELEGRAM_TOKEN`, `PALUGADA_TELEGRAM_CHAT` (your id) and
   `PALUGADA_TELEGRAM_WEBHOOK_SECRET` (a random string you choose), and
   restart.
3. Point the bot's webhook at `<PALUGADA_APP_URL_PUBLIC>/api/channels/telegram`
   with Telegram's `setWebhook`, giving the same string as its secret token.
   Without the secret every button press is refused, and the boot says so.

Telegram gets buttons for questions, proposed procedures and skills, and
approvals up to tier 2; a tier 3 approval or an incident arrives as a link.
It also gets the daily digest and a message when work you gave has
finished. Buttons are removed once an item is decided elsewhere, and a press
from anyone else is recorded as a security event.

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
