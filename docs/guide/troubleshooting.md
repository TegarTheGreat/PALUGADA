# Troubleshooting

Symptoms, their causes, and what to do, for the messages PALUGADA actually
prints. Messages from the server are quoted as the code writes them;
`…` stands for the part that names your particular setting or value.
Messages in the console are its English sentences, and so are the cards
PALUGADA raises in your inbox itself ("A task is waiting on nothing"): in
another language the card says the same in your language.

Two places to look first: the lines the platform prints when it starts,
each beginning `palugada:` (the same list is the **Finish setting up** card
in the console), and its JSON log lines on standard error
([operations](operations.md#monitoring)).

## Installing

### `db:setup: database palugada already exists, and this would drop it with everything in it.`

**Cause.** `npm run db:setup` creates the database from nothing, and there
is already one.

**Fix.** To bring an existing database up to date, run `npm run db:migrate`
instead. To throw it away and start again, deliberately:
`PALUGADA_RESET_DATABASE=yes npm run db:setup`. That drops every company.

### `migration … was not applied: it waited 10 seconds for a lock another session holds, …`

**Cause.** The migration changes a table another session is using and has
not finished with: a long transaction, a `pg_dump` in progress, an open
`psql` session. A migration waiting for it would make every query on that
table wait behind the migration, so it gave up instead. Nothing of it was
applied.

**Fix.** Let that session finish, or end it, and run `npm run db:migrate`
again. `SELECT pid, xact_start, query FROM pg_stat_activity WHERE xact_start
< now() - interval '1 minute'` lists the long ones. An image run by itself
exits and runs the migrations again when it is restarted; under Compose,
run `docker compose up -d` again.

### `db:setup: a database password may use letters, digits and _ . ~ - only`

**Cause.** A password in one of the three connection URLs contains a
character the script would have to quote in SQL.

**Fix.** Change it in `.env` (or the environment) to one without it. The
setup's own passwords are hexadecimal and never cause this.

### Compose stops with "run npm run setup and choose Docker Compose"

**Cause.** `docker-compose.yml` reads the database passwords from `.env`,
and they are missing: the setup was not run, or was run choosing "On this
machine".

**Fix.** Run `npm run setup` and choose Docker Compose. If `.env` already
holds settings for this machine, move it aside first; the setup keeps what
it finds.

### The setup says `It did not answer: …`

**Cause.** The model you named refused the request: a wrong key (`the
model API refused the key (401)`), a wrong address, or a model name the API
does not serve.

**Fix.** Choose again; the reason follows the colon. For a model on this
machine, check that it is running and that the address ends in `/v1`.

### The setup warns that the model `did not call the tool it was offered`

**Cause.** The model answers but does not support tool calling (function
calling). A role on it could only answer in words, never act.

**Fix.** Choose a model that calls tools. Small local models often cannot.

## Starting

### `palugada: configuration refused: …` and exit code 78

**Cause.** A setting cannot be used, and starting anyway would only fail
later. The message names it. The common ones:

| The message says | What to do |
|---|---|
| ``the database is … migrations behind this code (…): run `npm run db:migrate`, then start again`` | Run `npm run db:migrate`, then start. Under Docker the image does this itself |
| `PALUGADA_OWNER_TOTP_REF … is not a usable TOTP secret: …` | The reference resolves to something that is not a base32 secret, or cannot be read; see [Secrets](operations.md#secrets) |
| `PALUGADA_MODEL_KEY_REF … could not be read: …` | The key's variable is not set, is not named `PALUGADA_SECRET_…`, or its file is outside `PALUGADA_SECRET_DIRS` |
| `the anthropic provider needs PALUGADA_MODEL_KEY_REF` | Set the key, or `PALUGADA_MODEL_PROVIDER=openai` for an OpenAI-compatible API |
| `… serves the models it serves, so say which one each tier means: …` | An OpenAI-compatible provider has no default models: set `PALUGADA_MODEL`, or name every tier in `PALUGADA_MODEL_ALIASES` |
| `PALUGADA_AGENT_CLIS names …; the ones known here are …` | Use one of the names it lists; any other CLI is described in `PALUGADA_RUNTIME_SPECS` |
| `PALUGADA_RUNTIME_SPECS could not be read: …` | Fix the JSON, or the entry it names; a spec that places no tool bridge is refused |
| A path, then what is wrong with it | The vendor, MCP or price file that path names is malformed; the rest of the message says where |

The systemd unit does not restart on 78; Compose does, so there the same
message repeats until the setting is fixed.

### `palugada: failed to start: …` and exit code 1

**Cause.** Usually the database: it is not running, the URL points at the
wrong place, or a password is wrong (PostgreSQL's own `password
authentication failed for user …`).

**Fix.** Check the three `PALUGADA_…_URL` settings and that PostgreSQL
answers. Under Compose, the `db` service must be healthy before `app`
starts.

### ``no model: run `npm run setup`, or set PALUGADA_MODEL_KEY_REF (Anthropic), …``

**Cause.** No model is configured. The console works, but every role the
templates create runs on the in-process runtime, which needs a model, so no
work can be done. The boot also says `no in-process runtime: …`, and, when
no other runtime is configured either, `no runtime is registered: every task
will halt with runtime_unavailable (F13.1)`.

**Fix.** Run `npm run setup` and choose a model, or put a role on another
runtime ([how-to](how-to.md#put-a-role-on-an-agent-cli)).

### ``the console is not built: run `npm run console:build` (looked in …)``

**Cause.** On this machine, the console has not been built, so the browser
gets the API and a not-found page.

**Fix.** `npm run console:install` once, then `npm run console:build`, and
restart. Run it again after every upgrade.

### `no authenticator is enrolled: no tier 3 action can be approved until one is (F12.5)`

**Cause.** `PALUGADA_OWNER_TOTP_REF` is not set, so nobody can sign in, and
nothing irreversible can be approved.

**Fix.** Run `npm run setup`, which enrols one, or `npm run totp:new` and
set the reference by hand.

### `PALUGADA_OWNER_TOTP_REF … backs an authenticator the owner revoked; it is not enrolled again`

**Cause.** You revoked the authenticator this secret belongs to, and the
setting still points at it. A revoked factor is never brought back.

**Fix.** Make a new secret with `npm run totp:new` and point the setting at
a new reference.

## Signing in

### "That code is not right. Check the time on your phone and try the current one."

**Cause.** The code does not match any enrolled authenticator. Codes are
accepted one 30-second step either side of the server's clock, so a phone
or server whose clock is off by more is refused.

**Fix.** Check both clocks, and that the app shows the PALUGADA entry you
enrolled.

### "That code has already been used. Wait for the next one."

**Cause.** Each code is accepted once.

**Fix.** Wait for the app to show the next code.

### "Too many wrong codes. Wait a few minutes before trying again."

**Cause.** Ten wrong codes in a row lock codes for fifteen minutes (`too
many failed attempts; the second factor is locked for 15 minutes`). The lock
covers signing in and every approval made with a code. A passkey is not
locked by wrong codes.

**Fix.** Use a passkey if you have one; otherwise wait. A correct code
afterwards clears the count.

### `too many wrong codes from this address; try again after …`

**Cause.** Five wrong codes from one address within fifteen minutes. Each
process counts its own. This keeps one caller from spending the ten wrong
codes that would lock the owner out. Behind a reverse proxy every caller has
the proxy's address, so they all share one count, unless
`PALUGADA_BEHIND_PROXY` is set.

**Fix.** Wait until the time it gives. Behind a proxy, set
`PALUGADA_BEHIND_PROXY=1` ([operations](operations.md#https-in-front-of-it)).

### "The authenticator secret cannot be read on this deployment; ask the operator."

**Cause.** The secret behind the enrolled authenticator cannot be resolved:
the variable is gone, or the file moved. The server says `the secret behind
… cannot be read from the secret store, so no code can be checked`.

**Fix.** Restore the secret where the reference points, and restart if it
is an environment variable.

### The browser shows `this console does not answer to …; add the name to PALUGADA_ALLOWED_HOSTS if it is meant to`

**Cause.** Status 421, `owner.wrong_host`. The console answers only to its
own host names, so a page on another site cannot reach it through DNS
rebinding.

**Fix.** Add the name to `PALUGADA_ALLOWED_HOSTS`, or set
`PALUGADA_APP_URL_PUBLIC` to the address you use. Under Compose, set
`PALUGADA_ALLOWED_HOSTS` itself
([operations](operations.md#https-in-front-of-it)).

### "Your session has ended. Sign in again."

**Cause.** Sessions last up to eight hours and live in one tab. It also
happens after **Sign out everywhere**, or when the authenticator that
signed it in was revoked.

**Fix.** Sign in again.

### A lost phone

**Fix.** With recovery codes: on the sign-in page press **Lost your
phone? Use a recovery code** and type one. The console says you signed in
with a recovery code. Under **Settings**, **Security**, add a passkey on the
device you are using, confirming with a second code, then revoke the lost
phone, confirming with the passkey or a third. Each code works once; make a
new set when few are left. A code cannot approve anything, so a tier 3
approval waits for the passkey.

Without recovery codes: if you kept the key the setup showed you, add it
to an authenticator app on the new phone and carry on. If you did not, the
operator makes a new secret with `npm run totp:new` and puts it where
`PALUGADA_OWNER_TOTP_REF` points, replacing the old value, then restarts:
the old phone's codes stop working because the secret behind them has
changed. Then add the new key to your app. If you had revoked that
authenticator, use a new reference instead, as above.

## Work that does not move

### A task shows **No runtime could take it**

**Cause.** The task is halted with `runtime_unavailable`. Either the role
names a runtime the worker that took it does not run, or the model behind
the in-process runtime refused the key.

**Fix.** Open the role on **Team** and read **Who does its work**: it says
whether its runtime runs here and answers, or that "it cannot work until it
is moved to one that does". Configure the runtime, or move
the role to one that runs. For a refused key, run `npm run setup` to check
the model; it prints the provider's refusal. With several worker
processes, every one needs the same runtimes. Then use **Do it again**.

### Tasks stay under **Running** and never start

Look for the cause in this order:

- **The platform is stopped.** The red banner says "Everything is stopped.
  No company is doing any work." Press **Resume**.
- **The company is frozen.** Its badge on **Home** says **Frozen**; unfreeze
  it under **Settings**, **Company**.
- **The runtime is not answering.** The task goes back to the queue rather
  than halting, and the log shows `task.ran` with the status
  `runtime_unavailable`. The role's **Who does its work** says why, for
  example that the CLI `is not runnable`.
- **The budget account has no room.** A task is claimed only when its
  account can cover its reservation on top of what is already running.
  Check **Accounts** on **Money**, and raise the account's **Ceilings** if
  it has spent them: what it spent counts until the month ends (UTC).
- **No worker is running.** `GET /api/health` answers 503 with `no tick has
  finished since …`, or not at all. Check the process and its logs.

### Tasks under **Waiting**

**Cause.** They are waiting for your approval, for another role's review, or
for a time window.

**Fix.** Answer the **Inbox**. An approval left unanswered expires and its
task is cancelled with **Your approval was not given in time**.

### **Out of budget**, and "Monthly budget reached; the company is paused"

**Cause.** The company has spent its monthly ceiling. No new task starts and
no external action runs.

**Fix.** On **Money**, raise the **Monthly ceiling**, **Lift the pause**, or
**Override** it until a time. Each takes a code. Or wait: the pause is the
month's, and it lifts by itself at the start of the next one (UTC). If
spending was not expected, look at **Cost per day** and **Accounts** first.
Tasks it stopped stay stopped; open each and press **Continue**.

If the spending is far above your provider's bill, the model has no price
and is charged at the high fallback. Under **This deployment**, **Model**,
**What it costs**, press **Fill from models.dev** or type your prices, then
**Save prices**.

### "Role … is paused for spending too fast"

**Cause.** The role spent more than three times its seven-day hourly average
in one hour. It was paused while there is still money left.

**Fix.** Find out why from its recent tasks, then **Resume this role**.

### **It kept stopping the worker running it**, and "A task keeps stopping the worker running it"

**Cause.** The task lost its worker three times: each time the worker
stopped answering before the work finished. What it did is kept. It is
halted so it cannot take another worker down.

**Fix.** Look in the logs and on the host for what killed the worker (memory,
a CLI that crashed), fix it, then **Do it again**, or cancel it.

### "A task is waiting on nothing"

**Cause.** A live task has nothing left that would move it.

**Fix.** Approve the item to run it again from where it stopped, or deny it
to cancel it.

### **A capability it needs is down**, and "Capability … failed preflight"

**Cause.** A capability's health check failed for a reason that does not
pass by itself: usually an expired or mis-scoped credential, a quota used
up, or a wrong address. The work that needed it is stopped rather than
started. A service that is only busy, failing on its side or not answering
does not stop work at first: the task shows **Waiting for a service to
answer again** and looks again, longer each time, for about half an hour.

**Fix.** Open the division on **Team**, read **Capability health**, and fix
the credential; **Rotate a credential** repoints it. Then run the stopped
work again.

### "… stayed unreachable, and the work that needs it stopped"

**Cause.** A service was busy or not answering for the whole half hour a
task waited for it.

**Fix.** Check the service's own status page. When it answers again, run
the task again from its page.

### An agent says `… needs a vendor: connect one on This deployment, Services, or bind it in the file PALUGADA_VENDORS names`

**Cause.** The capability is catalogued but nothing is bound to it.

**Fix.** [Connect a vendor](how-to.md#connect-a-vendor), or accept that the
role works without it.

### "Google lets PALUGADA in only through an app you register with it"

**Cause.** The division's key is signed in for, and no app is registered
with that provider for this deployment yet.

**Fix.** Under the division's **Keys for services**, press **Register an
app**, make one with the return address shown, and paste its **Client ID**
and **Client secret**; then sign in. See
[Connect a vendor](how-to.md#connect-a-vendor).

### "The google sign-in behind this key has ended … sign in again"

**Cause.** The provider would not renew the key. It was revoked, its app
was deleted, or a Google consent screen in **Testing** ended it after seven
days.

**Fix.** Press **Sign in again** on the key, under the division's **Keys for
services**.

### **Its result did not check out**, and "External write failed verification"

**Cause.** A write reported success and the read-back said otherwise.

**Fix.** Check the vendor's side before running it again; the action may or
may not have happened.

### A schedule shows **Cannot fire**

**Cause.** The task it would create was refused, and the badge's tooltip
gives the reason as the platform said it: the company's spending is paused,
the role is frozen, or the budget cannot cover the reservation, for
example. The same occurrence is tried again on every pass until it can be.

**Fix.** Deal with the reason the tooltip names.

### A schedule did not run when it should have, or shows **Waiting**

**Cause.** Under **Next**, the table says which occurrence did not run and
why. *The last one was still going*: the schedule skips an occurrence while
a run it started earlier has not finished, which is its default. *Too late
to be worth running*: PALUGADA found the occurrence later than the
schedule's catch-up window, usually after it was down. **Waiting** is a
schedule set to run when the last one finishes, holding for it; a run
waiting for your approval holds it as long as you do.

**Fix.** Finish, decide or stop the run it gave way to, from **Work**. To
have occurrences run beside a live one, or always catch up, save the
schedule again under the same short name with **Run both** or **Always run
it once**.

### **Run now** says the schedule's last run has not ended

**Cause.** A task this schedule made -- by its clock or by an earlier **Run
now** -- is still queued, running or waiting for you. A schedule runs one
task at a time from this button, so a second press does not start the same
work twice.

**Fix.** Open the run in progress from the notification. Let it finish, or
cancel it from its task, and press **Run now** again.

## Models and agent CLIs

### A role on an agent CLI halts at once, saying the CLI does not know a tier

**Cause.** The role names a tier (`standard`), and this CLI's entry does not
say what model the tier means to it. Claude Code and Gemini CLI know; the
others are told in their entry.

**Fix.** Name the models in the CLI's entry in `PALUGADA_RUNTIME_SPECS`, as
the message shows, or give the role a model name the CLI accepts
([how-to](how-to.md#put-a-role-on-an-agent-cli)).

### "Model … failed and the run was not moved"

**Cause.** The provider was down or rate limited after two retries, and
either no fallback model was left, or the role can take irreversible
actions, so its run was not moved to another model.

**Fix.** Wait for the provider to recover, then **Do it again**.

## Notifications

### Telegram buttons do nothing

**Cause.** `telegram can send but not receive: set
PALUGADA_TELEGRAM_WEBHOOK_SECRET, or every button press will be refused`.
Or the webhook was set without the same secret token, or the public host
name is not allowed, so Telegram's calls are refused with 421.

**Fix.** Set the secret, set the webhook with the same secret to
`<PALUGADA_APP_URL_PUBLIC>/api/channels/telegram`, and make sure the public
name is allowed.

### Nothing reaches the phone

**Cause.** `no push channel: set PALUGADA_PUSH_URL (F10.5)` and `no message
channel: set PALUGADA_TELEGRAM_TOKEN and PALUGADA_TELEGRAM_CHAT (F10.9)`
among the boot lines. Also, outside **Your hours** only incidents come
through, and push carries only incidents and tier 3 approvals.

**Fix.** [Set up push or Telegram](how-to.md#push-notifications-telegram-and-whatsapp).

## Console messages

| The console says | Meaning |
|---|---|
| "This needs your authenticator." | The action needs a fresh code; the console asks for it |
| "This has already been decided or has closed." | Decided elsewhere, expired, or withdrawn because its task ended |
| "This company is frozen. Unfreeze it in its settings first." | Nothing starts in a frozen company |
| "Everything is stopped. Resume first." | The platform-wide stop is on |
| "This role is frozen until you resume it." | The role was paused or froze itself |
| "Spending is paused for this company." | The monthly ceiling was reached |
| "That would go over the budget." | The reservation does not fit the account |
| "Pick the goal this work serves." | Every task needs a goal |
| "No capability by that name is bound on this deployment." | A misspelt capability, or one with no vendor bound |
| "That file is not an export from this console." | The restore was given a file that is not an export |
| "Could not reach PALUGADA. Check the connection and try again." | The server is down or the network is |
