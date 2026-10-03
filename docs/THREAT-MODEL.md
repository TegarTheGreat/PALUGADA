# Threat model

Of 2026-09-30. Read against the code at `f870596`, then revised the same day
for the fixes that review led to (the role's tools for every runtime, taint
through sub-tasks and lessons, the deployment's own secrets, the health page,
migration checksums). Each defence names the file that implements it and,
where one exists, the test that fails without it. Where a defence was looked
for and not found, this says it is not enforced. Identifiers such as `F8.9`
refer to `docs/PRD.md`.

## 1. What is protected

- **Each company's data**: tasks, the journal, memories, documents, model
  traces, credential references. One PostgreSQL database, separated by row
  level security.
- **The owner's authority**: tier 3 approvals (irreversible effects,
  `src/domain/tier.ts`) and every change that loosens a control -- lifting a
  stop, raising a ceiling, writing a policy, installing a bundle, trusting a
  publisher, a standing approval.
- **Money**: budget accounts and their ceilings, the reservation taken before
  work starts, and the traces spend is summed from.
- **Credentials**: keys typed into the console, sealed in `deployment_secrets`
  (`src/settings/store.ts`); a division's credential, stored as a reference and
  resolved only inside the broker (`src/secrets/manager.ts`,
  `src/secrets/local.ts`).
- **The audit record**: `events`, `governance_log`, `retention_log`, which
  refuse change (migrations 0004, 0007, 0082).
- **The owner's factors and sessions**: the TOTP secret, passkeys, recovery
  codes, session tokens.

## 2. Who attacks, and what stops each

### 2.1 Someone on the internet

**Reach.** One port. Without a session only the open routes: `/api/auth/challenge`,
`/api/auth/sign-in`, `/api/auth/claim`, `/api/auth/claim/confirm`, `/api/hooks/:publicId`, `/api/channels/telegram`,
`/api/channels/whatsapp`, `/api/oauth/callback`, `/api/health`,
`/api/ready`, `/api/metrics`, and the console's static files.

**Defences, in order.**

1. The listener binds `127.0.0.1` unless `PALUGADA_HOST` says otherwise
   (`src/main.ts`). Compose publishes on loopback and defaults
   `PALUGADA_ALLOWED_HOSTS` to `localhost` (`docker-compose.yml`).
2. The `Host` header is checked before routing, the page included; an unknown
   name gets 421 (`OwnerApi.#handle` in `src/owner/api.ts`, list from
   `allowedHostsFrom` in `src/main.ts`). This closes DNS rebinding.
3. Every other route needs a session token (`OwnerSessions.verify`,
   `src/owner/session.ts`). It is a bearer header, not a cookie, and CORS
   answers only a configured origin, so another site cannot ride it.
4. Sign-in is a second factor and nothing else. Five wrong codes per address
   per 15 minutes (`SignInThrottle`, `src/owner/api.ts`); `X-Forwarded-For`
   is believed only with `PALUGADA_BEHIND_PROXY`. Behind that, ten TOTP
   failures since the last success lock the factor for 15 minutes, judged one
   attempt at a time under an advisory lock (`OwnerMfa.#attempt`,
   `src/owner/mfa.ts`). A TOTP step is claimed on use (`#claimStep`). A
   passkey needs a single-use challenge and user verification.
5. Each open route has its own secret. Hooks: a public id from a random UUID,
   then a bearer token stored as its SHA-256 or an HMAC over the raw bytes,
   with a five-minute window for Stripe, Slack and Standard Webhooks
   (`receiveHook`, `verify` in `src/scheduler/triggers.ts`). Telegram: the
   webhook secret header (`authenticWebhook`, `src/owner/telegram.ts`).
   WhatsApp: `X-Hub-Signature-256` over the raw bytes and the verify token
   (`src/owner/whatsapp.ts`). OAuth callback: a single-use state stored as its
   hash, with PKCE (`src/capabilities/mcp-oauth.ts`,
   `src/capabilities/vendor-oauth.ts`). Metrics: 404 until
   `PALUGADA_METRICS_TOKEN` of at least 32 characters is set.
6. `/api/health` and `/api/ready` say whether the database answers, not why
   it does not: the driver's words go to the log (`databaseHealth`,
   `src/main.ts`). Both are told one sample of the database, taken at most
   once every five seconds and given two to answer (`databaseSample`), so a
   flood of them costs one query and holds no more than one pool connection.
7. Secrets compared in the process use `timingSafeEqual` (`sameSecret` in
   `api.ts`, `same` in `triggers.ts` and `whatsapp.ts`); a session token or an
   OAuth state is looked up by its hash.
8. The page is served with a content security policy that allows only its own
   scripts and forbids framing, and a path resolving outside the build is
   refused (`#serveConsole`).
9. A deployment with no owner is claimed with a link its start prints: 160
   random bits kept as their SHA-256, good for a day, in the URL's fragment so
   no proxy logs it, and a wrong one counted by the sign-in throttle. It is
   refused while any live authenticator of the owner's exists, checked under
   a lock in the transaction that enrols the claimed one, and the secret it
   offers is derived from the master key and the claim, not kept, until it is
   enrolled and sealed (`src/owner/claim.ts`, 0094, `owner-claim.test.ts`).

**Residual risk.**

- The throttle lives in each process's memory. Two addresses or two replicas
  get ten guesses in 15 minutes, which trips the lockout: anyone who reaches
  the sign-in page can keep the owner's TOTP locked. Passkeys and recovery
  codes are not locked.
- With `PALUGADA_BEHIND_PROXY` set and the port also reachable directly, a
  caller writes its own `X-Forwarded-For` and gets a fresh count per value.
- Bound to every interface with no names given -- the image sets
  `PALUGADA_HOST=0.0.0.0` -- the console answers any `Host`. The boot writes a
  note; it does not refuse. No test holds the note.
- A GitHub hook carries no timestamp; a replay is stopped only because an
  identical body is deduplicated.
- A trigger whose token is in the address (0097) is as secret as the places
  that address is kept: the sender's settings, a proxy's access log. It is
  for senders that can set nothing else; a bearer trigger refuses a token in
  the address, and rotating makes the old address fail.
- The platform serves HTTP. TLS is a proxy's job.
- Until the owner claims it, whoever reads the deployment's log can become
  the owner. That is someone who holds the machine already, and the claim
  closes the moment an authenticator exists; a log shipped somewhere wider
  than the machine widens who that is.

### 2.2 Content an agent reads

**Reach.** What a `readsOutside` capability returns (`src/broker/catalogue.ts`:
`web.fetch`, `web.search`, `web.extract`, `repo.read`, `mailbox.read`,
`calendar.read`, `crm.read`, `speech.transcribe`, `chat.read`,
`browser.read`, `browser.act`; every MCP tool, `src/capabilities/mcp.ts`;
`ticket.list`), and any task a hook starts.

**Defences, in order.**

1. `wrapUntrusted` (`src/context/builder.ts`) fences outside text as data, on
   tool results (`src/runtime/agent-loop.ts`, `src/runtime/tool-bridge.ts`),
   hook events (`triggers.ts`), documents and outside memories
   (`src/broker/platform-capabilities.ts`). Its comment says no delimiter is a
   guarantee.
2. Taint: the broker writes `content.read_outside` after such a read
   (`src/broker/broker.ts`); `outsideContentIn` (`src/engine/tasks.ts`) finds
   it on the task, any ancestor or any descendant -- what a sub-task read
   comes back to the task that asked -- or a hook as the origin. A lesson
   learned from outside content taints the work that finds it through
   `memory.search` (its `readsOutside` asks the answer) or is told it in its
   briefing (the engine records it as it builds the run's request).
3. A tainted task's action at tier 2 or above asks the owner whatever policy
   says. Tier 3 always asks, with a fresh factor (`requiresOwnerApproval`,
   `decide` in `src/inbox/inbox.ts`).
4. An approval covers one action: its fingerprint is capability and input
   (0041).
5. A standing approval (0083) never covers tainted work, tier 3, another role
   or another capability: the broker requires no taint, and `decide` accepts
   one only on a card a policy raised.
5a. A company that turns the guardian on (0092, `src/broker/guardian.ts`) has
   each tier 0 or 1 call in tainted work judged by a model first, which may
   send it to the owner and cannot let anything through. It is shown the
   owner's request and the redacted call, not the outside text; an agent's
   brief and the call's description are fenced as data. A failure to judge,
   a provider that does not answer, asks the owner, and a look the budget
   cannot pay for stops the call.
5b. Taint follows the work to new tasks, in the transaction that makes
   them: a rerun carries what the task it reruns carried, a sub-task its
   parent's, including what the parent's other sub-tasks read, and a task
   the owner makes from a ticket a run filed carries the ticket's words. A
   yes for a while never covers a call in tainted work, at any tier.
6. A lesson from tainted work is stored `outside` and shown later as data
   (0071, `keepLessons` in `src/engine/tasks.ts`).
7. `web.fetch`, vendor and MCP calls refuse private and metadata addresses,
   re-check redirects, and connect to the address they checked
   (`src/capabilities/reachable.ts`). A company's browser does the same for
   every request a page makes -- pictures, scripts, redirects -- through the
   platform's proxy (`src/browser/egress.ts`), with Chromium resolving no
   name itself and no exception for loopback. `web.extract` with no
   provider chosen reads in that browser too, under the same proxy, in a
   context made for the one reading and thrown away after it: no company's
   sign-ins go with it, and nothing a page leaves reaches the next.
   A division's mailbox (`src/capabilities/mailbox.ts`) connects only to
   the servers the owner gave in its key; a role chooses folders and words
   to search for, never a host. Those words reach the server quoted or as
   counted literals, and a line break in one is refused, so a role cannot
   add an IMAP command; the folder is opened read-only.
7b. The owner's own hand in the browser takes their device, holds the
   company's work off the browser while it lasts, and lapses when left; what
   they type goes to the page and to no event, journal or log
   (`src/browser/holds.ts`, the `/browser` routes). A staff seat neither sees
   nor takes the browser, and the assistant does not take it over.
7a. A browser act does only what its card shows: on the page the role read,
   to the elements it named, each checked by its name before anything is
   done; a dialog is answered no unless the card said yes; a role never
   types a password (`src/browser/browsers.ts`). The page script runs in a
   world of its own, so a page's scripts cannot change what it reads.
8. The console renders agent text as text. The owner's assistant only proposes
   cards the owner applies (`src/owner/assistant.ts`).

**Residual risk.**

- Tier 0 and 1 actions run on tainted work without asking unless the company
  turned the guardian on, which is off by default because each look costs a
  model call. `web.fetch` is tier 0, so a persuaded run can put company data
  in a URL it fetches. A policy can deny by host; none does by default. With
  the guardian on, what is left is a call the guardian judged harmless and
  was not.
- A document the owner uploaded is the company's own: wrapped as data where
  it is shown, it does not taint the task that reads it.
- Taint through a descendant counts a read the parent may not have taken back
  yet, so a parent asks a little more often than it strictly must.
- Tier 1 actions can combine into a larger effect; the PRD names this, and the
  per-effect tier is the only answer.
- A page can label its own buttons as it likes: a button that says "Batal"
  and submits is clicked as "Batal". The card shows the page's own words.
- A company's browser holds its sign-ins. A role with `browser.read` can open
  any page those sign-ins reach, at tier 0; what it may change there is
  `browser.act`, at tier 2.
- A division's mailbox key reaches every message in the mailbox, and
  `mailbox.read` is tier 0: a role granted it can read any of them, codes
  a site sent included. What it may send is `email.send`, at tier 2.

### 2.3 A compromised or misbehaving runtime

**Reach.** Tool names and schemas, never credentials. It acts through
`services.callTool`, which is the broker (`src/engine/engine.ts`).

**Defences, in order.**

1. A runtime in another process -- a CLI, a script, an HTTP service, a
   container -- may call only its role's tools (F2.4): any other name is
   refused in the engine, recorded as `policy.denied` with `not_a_role_tool`,
   before the broker is asked (`callTool`, `src/engine/engine.ts`). The
   in-process model loop offers only the role's tools and answers any other
   name with "there is no tool named" (`src/runtime/agent-loop.ts`).
2. The broker checks kill switch, role freeze, the division's grant, rate
   limit, tier, policy, plan and window in one transaction
   (`CapabilityBroker.invoke`). Repeated denials freeze the role (F3.7).
3. A spawned runtime does not inherit the orchestrator's environment: a CLI
   gets `PATH`, its own key and its spec's variables (`src/runtime/cli.ts`,
   `src/runtime/claude-code.ts`).
4. A CLI reaches tools only through the tool bridge: loopback, a per-run
   32-byte token compared in constant time, only the role's tools. The token is
   in a 0600 file, not on the command line. Claude Code runs with `--tools ''`,
   `--strict-mcp-config` and `--setting-sources ''`.
5. A CLI at a version other than the checked one gets no work until the owner
   accepts it (`src/runtime/checked-versions.ts`); each run turns its updater
   off.
6. A container runs with `--network none`, `--read-only`, `--cap-drop ALL`,
   `no-new-privileges`, memory and CPU limits and user 65534
   (`ContainerAdapter.argv`, `src/runtime/container.ts`); a dead worker's
   containers are swept by label.
7. A CLI's process group is signalled, killed, and checked empty
   (`src/runtime/process-tree.ts`). Each group is written down as it starts
   (`run_processes`, 0095), and one a worker killed outright left running is
   ended by the next worker on the same machine, once `/proc` shows its
   leader still has the start time written down
   (`src/engine/process-ledger.ts`).
8. Tokens per run, the role's run length (0084; off unless the owner sets
   it), the deadline, and a lease that lapses without progress. A run whose
   lease its worker could not renew for a whole lease is stopped by that
   worker, so one cut off from the database does not act beside the worker
   that took its task (`LeaseKeeper`, `src/engine/lease-keeper.ts`).
9. Tokens are reserved across the account chain before a task exists
   (`app.budget_reserve`, 0024, from `createRootTask`); a capability's
   estimate is charged before it runs (`chargeEstimate`,
   `src/broker/cost.ts`).

**Residual risk.**

- A handler registered in the process (`handlers`) is the deployment's own
  code and is held to the division's grants, not the role's list.
- An agent CLI runs as the platform's OS user with the network open. Its
  containment is its own flags; if they fail it reads what that user reads,
  `.env` in a checkout included, and the environment the platform was
  started with in `/proc/<pid>/environ`: the application and control-plane
  URLs, and any key given as an `env://` reference. What the platform does
  not need is gone before it starts (section 2.9); what it needs is not.
- The version check believes `--version`. Hermes is held to none, and
  neither is an agent run over ACP.
- An ACP agent is refused its own tools only when it asks: permission
  goes to a call named exactly as a role tool on the bridge, never to a
  shell, edit, delete or move (`ours`, `src/runtime/acp.ts`). One that runs
  its tools without asking is held by its own containment, as a CLI is;
  the refusal is the protocol's, not a sandbox.
- A process that leaves its group with `setsid()` survives (stated in
  `process-tree.ts`).
- A group a killed worker left is ended only by a worker on the same
  machine and only while its leader lives: once the CLI has exited, what it
  started keeps running, since its group's number could by then be another
  group's. A worker killed in the milliseconds between starting a CLI and
  writing its row leaves one nobody knows of. None of it is written down
  where there is no `/proc`.
- The suite tests the container argv and the sweep; a whole run on a real
  daemon is checked by `npm run container:check`, in CI and wherever an
  operator runs it, not by the suite. Nothing requires the image pinned by
  digest.
- A cost above the estimate is recorded as overspend, not refused, so one call
  can pass a ceiling.

### 2.4 Another company on the same deployment

**Defences, in order.**

1. Every tenant table has row level security, forced, with a policy on
   `company_id = app.current_company_id()`, which raises when unset (0001).
2. `withTenant` sets the company per transaction, bound as a parameter;
   `withControlPlane` uses another pool and a `BYPASSRLS` role
   (`src/db/tenant.ts`, `src/db/pool.ts`). The broker takes the company from
   the task, not the run.
3. The application role holds only the grants its code uses (0047).
4. References between tenant tables are keys on `(company_id, id)` (0048).
5. A factor enrolled for one company answers only there (`OwnerMfa.enrolled`).
6. Each company's browser is a context of its own in Chromium -- its own
   cookies, storage and cache -- and its cookies are sealed under a name made
   from its id (`src/browser/`). One company's work never has a tab in
   another's.

**Residual risk.** The company is a setting the application role can set for
itself: row level security stops a wrong query in platform code, not someone
running SQL as `palugada_app`. The composite-key rule is tested on three
references, not by sweeping the catalogue. Companies share the model key,
providers and worker slots.

### 2.5 Someone holding a stolen database backup

**What they get.** Every company's data in clear, including prompts and
responses in `llm_traces`, less the secrets the redactor knew
(`src/secrets/manager.ts`).

**What they do not.** Sessions and recovery codes, kept as SHA-256 of 32 bytes
and 80 bits of randomness (0050, 0086); hook tokens, as SHA-256; console
secrets, AES-256-GCM with the name bound in (`seal`, `src/settings/store.ts`).
The master key is `PALUGADA_MASTER_KEY` or `master.key` in the state
directory, never the database, and rotates with `PALUGADA_MASTER_KEY_PREVIOUS`
(`resealSecrets`). The owner's TOTP secret and `env://`/`file://` credentials
appear only as references.

**Residual risk.** A backup of the host has `.env` -- database passwords,
`PALUGADA_SECRET_OWNER_TOTP` as `npm run setup` writes it, often the model key
-- and the key file. With those, the owner's authority is the attacker's.

### 2.6 Someone at the owner's unlocked laptop

**What a session alone does.** Reads everything, exports any company with its
prompts, decides items below tier 3, assigns work, tightens any control.

**What it cannot.** Every loosening takes a fresh factor: tier 3, policies,
ceilings, unfreezing, bundles, publishers, credentials, the model, channels,
passkeys, recovery codes (`#requireFactor`, `src/owner/api.ts`). A session is
`assurance: 'session'`, never `mfa`. A recovery code signs in and restores a
device and is refused for anything else (`RECOVERY_PURPOSES`,
`src/owner/mfa.ts`). The token lives in page memory and expires after eight
hours.

**Residual risk.** Eight hours with no idle timeout, in which approving tier 2
cards (email, purchases) and exporting all data need nothing more.

### 2.7 A stranger on the owner's chat channels

**Defences.** The webhook secret or Meta's signature first; then the sender
must be the configured owner, and anyone else is recorded as
`security.chat_stranger_refused` and not answered. Decisions go through
`decide` with `channel: 'chat'`, which refuses tier 3 whatever arrives; tier 3
reaches a chat only as a link. The assistant applies only cards marked
`chat: true` there (`src/owner/assistant-actions.ts`). WhatsApp claims each
message id in the database before acting (0085).

Telegram claims each update id, with its bot, the same way (0089), so a
redelivery after a restart or at another replica is taken in once.

**Residual risk.** Whoever holds the owner's chat account has session-level
authority below tier 3.

### 2.8 Supply chain

- **Bundles and skills.** A signature that does not verify is refused; one from
  a key the owner has not trusted counts as unsigned (`src/bundles/publishers.ts`).
  An unsigned bundle installs with tier 0 grants only (`installBundle`,
  `src/bundles/bundle.ts`); its skills arrive as candidates for review and the
  owner. Imported external skills return quarantined. Installing takes a
  factor. Residual: a quarantined bundle's roles and prompts install as
  written.
- **Agent CLIs.** Installed from npm at the checked version into their own
  directory with a minimal environment (`installAgent`,
  `src/settings/agents.ts`). Residual: no integrity pin beyond the version,
  install scripts run, dependencies float. Hermes installs from a shell script.
- **npm.** Three runtime dependencies (`ajv`, `cron-parser`, `pg`) from the
  lockfile with `npm ci`. CI audits the platform's and the console's
  production dependencies and fails on a high or critical advisory
  (`.github/workflows/ci.yml`, job `audit`).
- **The image and CI.** The Dockerfile's base is pinned by digest, and CI's
  actions by commit; Dependabot proposes the next of each, and of the npm
  lockfiles, weekly (`.github/dependabot.yml`). Residual: a moderate
  advisory passes the audit; `pgvector/pgvector:pg16` in the compose files
  and `deploy/container-check`'s base are still by tag; and a pin is only as
  good as the review of the pull request that moves it.

### 2.9 The operator's own mistakes

- `TRUNCATE` on an append-only table is refused, the schema owner included,
  unless the session sets `app.allow_truncate` (0082). `events` rows are
  deleted only in a retention purge, outside the window, failing closed with no
  policy (0007).
- Compose, the image and the systemd unit (`UnsetEnvironment=`) keep the
  schema owner URL from the running platform, and `npm start`, which reads a
  `.env` that setup writes with all three URLs, drops it from its own
  environment before it boots (`src/main.ts`). The image's entrypoint
  provisions and migrates, then unsets the superuser's and schema owner's
  URLs, every database password Compose's `.env` or Coolify's `SERVICE_*`
  variables handed the container, and only then execs tini, so PID 1 holds
  none of them (`deploy/docker/entrypoint.sh`, `process.test.ts`). The unit
  and `npm start` are not tested.
- Migrations: `scripts/migrate.ts` keeps each one's checksum and refuses, by
  name and before anything runs, one whose file changed after it ran; one
  recorded before checksums were kept is taken as it is on the next run. The
  boot refuses to start behind the schema.
- Half-configured features are boot notes shown to the owner.
- Erasing a company deletes its history, and only for a company the owner
  closed with a factor whose grace (at least seven days, a table constraint)
  is over: the append-only triggers check a session setting naming the
  company and its line in `company_erasures`, which cannot be written
  earlier (0088, `company-closing.test.ts`). Each company is erased on its
  own, so one whose erasure fails cannot hold back another's; its failure
  is kept on its row and it is tried again less often each time (0096).
  After the rows, its directory under the files root and its charter's
  folder are removed; a link there is removed or refused, never followed,
  so an erasure cannot be pointed at files outside them. The charter
  repository's history still holds the company's charters: it is not
  rewritten, and the guide tells the operator how.
- A division's credential may not name a sealed secret of the deployment's,
  any reference the deployment's configuration names (the owner's TOTP secret
  as setup writes it included), or anything that resolves to the same value
  (`DivisionSecrets`, `deploymentReferences` in `src/secrets/manager.ts`).
  Only the owner, with a factor, sets one; an imported archive carries its
  references as they were, and they are checked where they are resolved.

## 3. Out of scope, or not defended

- Chromium itself. Its sandbox is on unless the operator turns it off
  (`PALUGADA_BROWSER_SANDBOX=off`, said at every boot); with it off, a page
  that breaks out of the renderer runs as the platform's user, with what
  that user can read. In the image it is on: the compose files give the
  container Docker's own seccomp profile with user namespaces allowed
  (`deploy/docker/seccomp-chromium.json`), and CI checks that a page renders
  in a namespace of its own. The cost is that any process in that container
  -- an agent CLI among them -- may make a user namespace too, which is
  more of the kernel to reach than Docker's default allows.

- A compromised host, kernel, container runtime or Node process.
- An operator with the database superuser or schema owner: they can drop the
  triggers, and the event log is not hash-chained, so a rewrite leaves no mark.
- The model provider, which sees every prompt and tool result.
- Denial of service at scale: no global rate limit and Node's default timeouts.
- The owner's own phone and chat accounts.
- A vendor that misreports what happened, beyond the read-back `verify()`
  (F8.4).

## 4. Defences and their tests

All under `test/acceptance/` unless named.

| Defence | Test file |
|---|---|
| Host allowlist; traversal; CSP; CORS; session on every route | `owner-api.test.ts` |
| Sign-in throttle, forwarded address | `owner-api.test.ts` |
| TOTP lockout, replay, tier 3 factor, no tier 3 over chat | `owner-mfa.test.ts` |
| First owner's claim: single use, a day, none once owned, sealed secret | `owner-claim.test.ts`, `process.test.ts` |
| Session is not a factor; tighten with session, loosen with factor | `owner-api.test.ts` |
| Recovery codes hashed and limited | `recovery-codes.test.ts` |
| Hook tokens and signatures | `triggers.test.ts` |
| Telegram and WhatsApp: secret, stranger, duplicate (across processes), tier 3 | `owner-channels.test.ts`, `whatsapp.test.ts`, `telegram-conversation.test.ts` |
| Metrics token | `operability.test.ts` |
| OAuth state and PKCE | `mcp-oauth.test.ts`, `vendor-oauth.test.ts` |
| Taint asks at tier 2 | `tool-io.test.ts`, `triggers.test.ts`, `mcp-client.test.ts`, `web-search.test.ts` |
| Standing approvals' limits | `standing-approvals.test.ts` |
| Approval bound to its action | `owner-inbox.test.ts` |
| Outside lessons as data | `memory-learning.test.ts` |
| Address checks | `platform-capabilities.test.ts` |
| Environment, bridge, argv, versions, process tree, container sweep | `out-of-process-runtimes.test.ts` |
| A killed worker's CLIs ended by the next worker; a reused pid, a live run's group and another machine's never signalled | `orphan-processes.test.ts` |
| Run length; tokens per run | `operability.test.ts`, `execution-hardening.test.ts` |
| A run stopped when its lease could not be renewed for a whole lease | `lease-keeper.test.ts` |
| Reservations, charges, overspend | `budget-inheritance.test.ts`, `cost-control.test.ts`, `spend-guard.test.ts` |
| Role freeze | `role-freeze.test.ts` |
| RLS forced, grants, composite keys | `tenant-isolation.test.ts` |
| Sealing, master key file, rotation | `panel-settings.test.ts`, `master-key-rotation.test.ts` |
| References and redaction | `credentials.test.ts` |
| Signatures, publishers, quarantine | `bundles.test.ts` |
| TRUNCATE refused | `retention-rotation.test.ts` |
| Text rendering; token in memory | `test/documents/console-page.test.ts` |
| Schema owner URL and database passwords absent from PID 1 in the image; provisioning corrects loosened roles | `process.test.ts` (the systemd unit and `npm start`: none) |
| Migration contents unchanged | `process.test.ts` |
| A role's tools, for every runtime in another process | `out-of-process-runtimes.test.ts` |
| The guardian: judged only after outside content, only tightens, fails closed | `guardian.test.ts` |
| Taint through sub-tasks, searches and briefings | `tool-io.test.ts` |
| A division's credential is not the deployment's secret | `credentials.test.ts` |
| The browser: every request through the proxy, one context per company, cookies sealed and erased, acts only as approved | `browser.test.ts`, `company-closing.test.ts` |
| The owner at the browser: device to take it over, work held off, input kept nowhere, hold lapses | `browser-live.test.ts`, `console-browser.test.ts` |
| Health page says whether, not why | `operability.test.ts` |
