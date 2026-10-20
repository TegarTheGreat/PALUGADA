# Agent tools in OpenClaw and Hermes Agent, compared with PALUGADA's catalogue

Researched 2026-10-03. Both projects' docs were read from source at `main`:
Hermes Agent `eb7e862`, OpenClaw `cec6d9d`. Both are MIT-licensed [H18][O21].
PALUGADA was read at `4d1de44` (`src/broker/catalogue.ts`, `src/capabilities/*`,
`config/vendors.example.json`). Firecrawl search was not available (out of credits), so pages came
from GitHub. Citations such as [H3] point to the source list at the end. Anything
marked *unverified* was not confirmed in a primary source.

Tier key (PALUGADA, `src/domain/tier.ts`): 0 read-only · 1 cheap reversible write ·
2 costly, slow to undo or external · 3 irreversible, always the owner's decision.

---

## 1. OpenClaw: built-in tools, plugins and skills

OpenClaw is a self-hosted gateway that receives messages from more than 20 channels
and runs agent turns with tools [O21]. Tools come from four places: core, plugins
(installable from ClawHub, npm or git), MCP servers, and `SKILL.md` instruction packs [O1].

| Tool | What it does | Backend (OSS / self-host / key) | How it is permissioned |
|---|---|---|---|
| `exec`, `process` | Runs shell commands and background processes [O1][O2] | Runs on the host or in a sandbox: Docker, Podman, SSH, OpenShell or Crabbox [O5]. No key | Tool policy, then the sandbox, then exec approvals (`deny`/`allowlist`/`ask`/`auto`/`full`) [O4]. `elevated` is an exec-only way out of the sandbox [O6] |
| `read`, `write`, `edit`, `apply_patch` | Read and change workspace files [O2] | Local | `group:fs`. The sandbox's `workspaceAccess` is `none`, `ro` or `rw` [O6] |
| `code_execution` | Runs Python remotely [O17] | **Paid**: xAI Responses API, $5 per 1,000 calls [O17] | `group:runtime` |
| `web_search` | Normalised search results, cached for 15 minutes [O7] | 15 providers. Key-free ones: **SearXNG** (self-hosted), DuckDuckGo (an "unofficial" HTML scrape), Ollama (local signed-in host), Parallel free tier [O7][O9] | `group:web` |
| `web_fetch` | HTTP GET, then **local Readability** extraction to markdown. Falls back to Firecrawl when that fails [O8] | Local, no key. Firecrawl is an optional fallback | Blocks private hosts and re-checks every redirect [O8] |
| `browser` | One tool: status, tabs, open, navigate, snapshot (ARIA tree with refs), act (click/type/drag/select), screenshot, text, requests, errors, emulate, PDF [O10] | A managed, isolated Chromium/Brave/Edge profile over CDP and **Playwright** (Apache-2.0); **Lightpanda** as an opt-in engine; remote CDP [O10]. No key locally | `ssrfPolicy`: private network off by default, `allowedHostnames` lets named hosts through; `target` is sandbox, host or node; host control from a sandbox needs `allowHostControl` [O10] |
| `view_image` | Inspects images with a vision model [O1] | The configured model | `group:media` |
| `pdf` | Analyses PDFs: native input on Anthropic and Google models, otherwise text and image extraction via `clawpdf` (PDFium WASM) [O15] | Local extraction, no key | `group:media` |
| `image_generate`, `video_generate`, `music_generate` | Media generation, asynchronous [O11] | Mostly paid. **ComfyUI runs locally** (`127.0.0.1:8188`, no key) for image, video and music [O11][O12] | `group:media` |
| `tts` | Speaks replies [O13] | 16 providers. Key-free: Microsoft Edge ("Best-effort, no SLA") and "Local CLI". The skill `sherpa-onnx-tts` is offline [O13][O20] | Not in any restricted profile; enable it with `alsoAllow` [O2] |
| Speech-to-text (inbound audio, not a tool) | Transcribes voice messages [O14] | Providers first, then local **whisper.cpp** (`whisper-cli`), **sherpa-onnx-offline**, or the Python `whisper` CLI [O14] | A configured API key wins over a local binary [O14] |
| `message` | Sends replies and channel actions [O1] | Channel adapters | `group:messaging`; `toolsBySender` restricts by who sent the message [O2] |
| `ask_user` | Asks the user for a structured decision [O1] | — | `group:agents` |
| `secrets` | Asks the human for a credential in a masked prompt. The agent receives only a SecretRef, can propose `allowedHosts`, and the wait times out after 15 minutes [O16] | Local secret store | On by default; deny it like any tool; absent in subagents [O16] |
| `cron`, `heartbeat_respond` | Schedules work [O1] | Local | `group:automation`. Automation approvals can become *standing grants* [O3] |
| `sessions_*`, `subagents`, `agents_wait` | Delegates and coordinates work [O1] | Local | `group:sessions` |
| `memory_search`, `memory_get` | Searches memory [O2] | Local | `group:memory` |
| MCP servers (`bundle-mcp`) | Exposes external tools [O2] | Any MCP server | The sandbox needs a separate allow entry, `tools.sandbox.tools` [O2]. Codex "allow always" stores a grant for one tool on one server [O3] |
| Lobster | A typed pipeline run as one tool call, with approval and input checkpoints and resume tokens [O18] | Local | Side effects stop the pipeline until approved [O18] |

**Bundled skills that need no paid vendor** [O20]: `himalaya` (any mailbox over IMAP/SMTP),
`openai-whisper` (local speech-to-text), `sherpa-onnx-tts` (offline speech), `github` (gh CLI),
`blogwatcher` (RSS/Atom), `nano-pdf`, `summarize`, `diagram-maker`, `tmux`, `obsidian`,
`weather` (wttr.in), `camsnap` (RTSP/ONVIF cameras).
**Bundled skills tied to a vendor** [O20]: `gog` (Google Workspace), `notion`, `trello`, `goplaces`,
`xurl` (X), `sag` (ElevenLabs), `openai-whisper-api`, `1password`.

## 2. Hermes Agent (Nous Research): toolsets

Hermes registers about 100 tools, grouped into toolsets that can be turned on per platform
[H1][H2]. Its default `hermes-cli` set covers file, terminal, web, browser, memory, skills,
vision, image generation, todo, TTS, delegation, code execution, cron, session search and
clarify [H2].

| Toolset: tools | What it does | Backend (OSS / self-host / key) | How it is permissioned |
|---|---|---|---|
| `terminal`: `terminal`, `process_manage` | Shell with persistent state, plus background processes [H1] | Backends: local, ssh, **docker**, singularity, modal, daytona, vercel_sandbox [H3] | Dangerous-command approval on local and ssh. The check is skipped in containers because "the container itself is the security boundary". A hardline blocklist, deny globs and Tirith scanning also apply [H3] |
| `file`: `read_file`, `write_file`, `patch`, `search_files` | Reads, writes and patches files; search is backed by ripgrep [H1] | `read_file` converts docx, xlsx, ipynb and SQLite with the standard library, and PDF, legacy Office, ODF, RTF and EPUB with `firecrawl-anydoc`. It warns about scanned PDFs [H9] | Protected paths are always blocked; `HERMES_WRITE_SAFE_ROOT` is an optional sandbox; `write_file` refuses until the file has been fully read [H1][H3] |
| `code_execution`: `execute_code` | Python that calls other tools over a Unix-socket RPC; only its `print` output reaches the context [H7] | A local child process | The environment is scrubbed of names containing KEY/TOKEN/SECRET/…; no recursion, delegation or MCP inside; 300 s, 50 tool calls, 50 KB stdout [H7] |
| `web`: `web_search`, `web_extract` | Search and clean extraction, PDF URLs included [H1][H4] | Firecrawl by default. **SearXNG** (self-hosted), **DDGS** (the `ddgs` package, no key), Brave free tier, a keyless rotation across free tiers (Exa, Parallel, Firecrawl, Keenable), and a self-hosted Firecrawl [H4] | SSRF guard re-checked at every redirect; a website blocklist covers every URL tool [H3] |
| `browser`: `browser_navigate/snapshot/click/type/press/scroll/back/console/get_images/vision`, CDP tools, `browser_vault_*`, `browser_exec` [H1][H2] | Browser automation over an accessibility tree with refs [H5] | Local: **agent-browser + Chromium**, the Browser Use CLI (the default driver), **Camofox** (a local Firefox fork against fingerprinting, run in Docker), **Lightpanda**, or CDP to your own Chrome. Paid: Browserbase, Browser Use Cloud, Firecrawl [H5] | SSRF and the blocklist [H3]. The credential vault fills passwords into the page without the model seeing them [H10] |
| `vision`: `vision_analyze` | Analyses images; uses an auxiliary vision model when the main model is text-only [H1] | The configured model | — |
| `image_gen`: `image_generate` | Text-to-image and editing [H1] | **Paid only**: FAL (default), OpenAI, xAI, Krea [H1][H8] | The user chooses the model; the agent cannot [H1] |
| `video_gen` (opt-in) | Text-to-video and image-to-video [H1] | Paid: xAI, FAL, OpenRouter, DeepInfra [H1] | Off by default |
| `tts`: `text_to_speech` | Speech audio, delivered as a voice message [H1] | 11 providers. Free: Edge TTS (the default), **NeuTTS**, **KittenTTS**, **Piper** (local, 44 languages); custom command providers [H6] | The command template is trusted local input [H6] |
| Speech-to-text (voice messages) | Transcribes before the agent reads [H6] | **Local faster-whisper by default** (free), the `whisper` CLI, or a custom command; Groq, OpenAI, Mistral, xAI, ElevenLabs and DeepInfra are paid [H6] | — |
| `memory`, `session_search`, `todo`, `clarify`, `delegation` | Persistent memory, search of past sessions (SQLite FTS5), a task list, questions to the user, subagents [H1] | Local | `clarify` times out and is fail-safe [H1] |
| `skills`: `skills_list`, `skill_view`, `skill_manage` | Procedural memory that the agent can create and edit, following the agentskills.io format [H1][H12] | Local plus a hub | Skills Guard scans skills on install [H3] |
| `cronjob`: `cronjob_manage` | The agent creates, pauses, runs and removes scheduled jobs, including script-only jobs [H11] | Local | `approvals.cron_mode: deny` by default [H3] |
| `kanban_*` | Multi-agent board work: complete, block, review, attach [H1] | Local | Opt-in; `all` does not enable it [H2] |
| MCP (`mcp__<server>__*`) | External tools over stdio or HTTP [H13] | Any server; a catalogue reviewed by PR | `include`/`exclude` globs per server; stdio servers get a filtered environment; credentials are redacted from errors [H13][H3] |
| `computer_use` | Background desktop control through `cua-driver` [H1] | A local binary (license *unverified*) | Gated on capability |
| Platform tools | Discord, Feishu, Home Assistant, Spotify, Yuanbao [H1] | Vendor APIs | Per-platform toolsets |
| Messaging gateway | Telegram, Discord, Slack, WhatsApp, Signal, Matrix, Mattermost, email, SMS, ntfy and more [H2] | **Email uses standard IMAP/SMTP from Python's standard library**; no extra service [H17] | User allowlists and DM pairing [H3] |

## 3. What PALUGADA already binds to self-hosted or keyless backends

| Capability | Backends today (`src/capabilities/*`) | Self-hosted option? |
|---|---|---|
| `web.search` | Brave, Tavily, Exa, Firecrawl, Perplexity, Parallel, Keenable, Jina, SerpApi, Serper, **SearXNG**, **Firecrawl (self-hosted)** | Yes |
| `web.extract` | Jina, Firecrawl, Tavily, Exa, Parallel, Keenable | **No**: every option is hosted |
| `web.fetch` | PALUGADA's own fetcher (SSRF-guarded); returns the raw body, with no readability step | Local, but no clean text |
| `image.generate` | OpenAI, fal, OpenRouter, DeepInfra, xAI, Gemini | **No** |
| `speech.synthesize` | OpenAI, ElevenLabs, xAI, Gemini, DeepInfra, **Piper** | Yes |
| `speech.transcribe` | OpenAI, Groq, Deepgram, ElevenLabs, Gemini, DeepInfra, **speaches**, **whisper.cpp** | Yes |
| embeddings (for `memory.search`) | 5 hosted, plus **Ollama** and any OpenAI-compatible server | Yes |
| `email.send` / `mailbox.read` / `email.draft` | One preset, Resend (`config/vendors.example.json`); none for reading a mailbox or saving a draft | **No** |
| browser | Only through MCP presets: `@playwright/mcp` on localhost, or Browserbase. Tiers are set per tool by the operator (`mcp-presets.ts`) | Partly: there is no catalogue calibration |
| `code.execute` | Node's permission-model sandbox, with the network **not** isolated, so it sits at tier 2 and may not share a division with a credential (`sandbox/sandbox.ts`) | Local. `runtime/container.ts` already runs with `--network none`, but only for runtimes |
| `files.list` | Lists names, sizes and times only; reading contents is explicitly out of scope | — |

PDFs and Word files the owner uploads are parsed **in the owner's browser** with pdf.js. The
server "never parses an untrusted binary" (`console/src/pdf.ts`). Any server-side document tool
must keep that promise.

## 4. Gaps: tools agents commonly need that PALUGADA lacks or reaches only through a paid vendor

| # | Need | PALUGADA today | Open-source backend these projects use | Proposed capability | Tier | Notes |
|---|---|---|---|---|---|---|
| 1 | Read, draft and send mail on any mailbox, including a self-hosted one | Only `email.send` via Resend; no binding for `mailbox.read` or `email.draft` | Standard **IMAP/SMTP**: Hermes's email gateway uses Python's standard library [H17]; OpenClaw's `himalaya` skill [O20] | Bind the existing `mailbox.read` (0), `email.draft` (1, IMAP APPEND to Drafts) and `email.send` (2, SMTP) | 0 / 1 / 2 (unchanged) | Needs a native `mail` adapter, because vendor files are HTTP-only. The read-back is IMAP SEARCH on Drafts or Sent |
| 2 | Read pages that need JavaScript to render | MCP Playwright preset, tiers set by hand | **Playwright + Chromium** [O10]; agent-browser + Chromium, Camofox, Lightpanda [H5] | `browser.read`: navigate, snapshot, text, screenshot | 0, `readsOutside` | Apply the same `reachable.ts` SSRF rules to every navigation and redirect, as OpenClaw and Hermes do [O10][H3] |
| 3 | Act on a web page: fill in or submit a form | None | Same as #2 | `browser.act`: click, type, select, submit | 2 | A submitted form cannot be recalled, like `email.send`. The read-back is a snapshot after acting. Policy can raise checkout hosts to 3 through `describe()` (urlHost) |
| 4 | Read the company's own files, including PDF, DOCX and XLSX | `files.list` gives names only | Hermes `read_file` with standard-library converters and `anydoc` [H9]; OpenClaw `pdf` with PDFium WASM [O15]; pdf.js is already a PALUGADA dependency | `files.read` | 0 (`readsOutside` when the file came from outside) | Parse inside the `--network none` container so the server never parses an untrusted binary |
| 5 | Clean page text without sending the URL to a third party | `web.extract` is hosted-only; `web.fetch` returns raw HTML | **Readability** run locally in `web_fetch` [O8]; self-hosted **Firecrawl** for extraction [H4] | Two new `web.extract` providers: `readability` (local, no key) and `firecrawl-self-hosted` | 0 (unchanged) | No new capability. Readability's license was not checked here |
| 6 | Understand an image: a screenshot, a scan, a receipt | None | `vision_analyze` [H1], `view_image` [O1]: the configured vision model, which can be local over an OpenAI-compatible endpoint (Hermes names LAN Ollama and llama.cpp [H3]) | `image.describe` | 0, `readsOutside` | Hermes and OpenClaw both turn scanned PDF pages into images for vision [H9][O15] |
| 7 | Data analysis in Python with the network cut off | `code.execute`: Node only, network open, tier 2 | Hermes docker backend: `--cap-drop ALL`, `--pids-limit 256`, tmpfs, Docker egress isolation [H3][H15]; OpenClaw sandbox refuses `network: host` [O5] | `code.compute`, bound **only** to the container backend with `--network none`; Python plus data libraries | 1 (writes results to company files) | The catalogue may only tighten a tier, so this needs a new name rather than re-tiering `code.execute`. With no socket it can share a division with credentials |
| 8 | An agent obtains a missing credential without ever seeing it | Only the owner can set one, in the console | OpenClaw `secrets`: masked prompt, SecretRef, `allowedHosts` [O16]; Hermes credential vault [H10] | `credential.request` | 0 | Opens an inbox item with a masked field. The value is sealed and scoped to the division, and the role gets an alias |
| 9 | Talk to customers on chat channels | `email.send` and `social.publish` only; Telegram is for the owner only | Gateways in both projects: Telegram, Matrix, Mattermost, Signal, ntfy, WhatsApp [H2][O21] | `chat.read` and `chat.send` | 0 (`readsOutside`) / 2 | Matrix, Mattermost and ntfy can be self-hosted; the Telegram Bot API is free with a token. Inbound messages can use PALUGADA's existing triggers |
| 10 | Generate images on the company's own GPU | Hosted providers only | **ComfyUI** locally at `127.0.0.1:8188`, no key [O12] | A `comfyui` provider for `image.generate` | 1 (unchanged) | Needs a GPU host. ComfyUI's license was not checked here |
| 11 | Video and music | None | ComfyUI locally [O11]; everything else is paid [H1][O11] | `video.generate`, `music.generate` | 1 | Low priority |
| 12 | An agent proposes a recurring job | Schedules are made by the owner (`owner/api.ts`) | `cronjob_manage` [H11], `cron` [O1] | `schedule.propose`: an inbox item, like `goal.propose` | 0 | Pairs with standing grants (§5, idea 3) |
| 13 | Watch RSS and Atom feeds | Possible through `web.fetch` | OpenClaw `blogwatcher` skill [O20] | `feed.read`, or a skill over `web.fetch` | 0, `readsOutside` | Low priority |
| 14 | More local voices | Piper | NeuTTS, KittenTTS, custom command providers [H6]; sherpa-onnx [O20] | An "OpenAI-compatible speech server" provider for `speech.synthesize` | 1 (unchanged) | Low priority. Whether particular servers support it was not verified |

**Deliberately not recommended.**
- **DuckDuckGo scraping and Edge TTS.** PALUGADA excluded both already (`search.ts`, `media.ts`). OpenClaw itself calls DuckDuckGo "unofficial" and Edge "no SLA" [O9][O13].
- **A host shell (`exec`/`terminal`) as a broker capability.** The CLI runtimes already have a shell inside their own workspace or container.
- **`computer_use`, and browsing with the owner's real profile.**

## 5. Permissioning ideas worth borrowing

| # | Idea (source) | How it maps onto PALUGADA | Verdict |
|---|---|---|---|
| 1 | A **hardline floor** below YOLO that no flag or "always allow" can bypass [H3] | Already true: `requiresOwnerApproval(tier >= 3)` has no waiver, and the policy `deny` is strictest-wins | Confirms the design |
| 2 | **Unattended means deny.** `cron_mode`/`unattended_mode: deny`, a fail-closed timeout [H3], `askFallback: deny` [O3] | Already F10.4: an unanswered approval expires into a cancellation | Confirms the design |
| 3 | **Standing grants for automations** [O3]. "Always allow" on a scheduled job's approval mints a grant bound to the exact agent, job definition and operation. It fails closed when the job definition changes or the operation differs by one byte, can expire, and is listed in a revocable ledger | When the owner approves a **tier 2** action of a scheduled task, offer "every time this schedule does exactly this". Key it on (schedule id, hash of the schedule definition, capability, `fingerprintAction(input)`). Never offer it for tier 3. Show a ledger in the console. Revocation takes effect at the next call | **Borrow.** It cuts repeat approvals without touching tier 3 |
| 4 | **Mining approval history** (`hermes approvals suggest`). Read-only; never proposes destructive classes; masks credentials [H3] | Propose `policy` rules from repeated, identical tier 2 approvals. Never for tier 3. Applying one is a loosening, so it needs the owner's device | Borrow |
| 5 | **An automatic reviewer** with allow/deny/ask verdicts, which escalates to a human after three denials [O4]; Hermes "smart" mode [H3] | `src/review` plus the `require_review` effect: an LLM reviewer may *deny* or *escalate* a tier 2 action, never approve a tier 3 one. Three denials open an incident | Borrow cautiously |
| 6 | **Approval bound to the exact operation.** argv, cwd, env and the executable's content hash; any drift denies [O3] | `fingerprintAction` and MCP pins already do this. Extend it so a `code.execute` approval binds the snippet's hash | Mostly present |
| 7 | **Credentials the model never sees.** The `secrets` tool [O16], the browser credential vault [H10] | `credential.request` (gap #8). The http adapter enforces `allowedHosts` for each alias | Borrow |
| 8 | **Egress credential injection** (iron-proxy). The sandbox holds opaque tokens and the proxy swaps in the real key for allowlisted hosts [H16] | The broker already resolves credentials per call (`http.ts`). This becomes relevant only if a containerised runtime ever needs provider APIs directly | Note for later |
| 9 | **Restricted toolset for webhook-started runs** (`hermes-webhook`: only search, extract, vision and clarify) [H2]; `toolsBySender` [O2] | Tasks started by a trigger get only tier 0 and `owner.ask` by default; the owner widens that per trigger. This complements F8.9's provenance rule | Borrow |
| 10 | **Strip chat-template special tokens** (`<\|im_start\|>`, `<\|start_header_id\|>` and similar) from untrusted content before it reaches the model [O19] | PALUGADA supports Ollama and OpenAI-compatible models but does not strip these tokens (`grep` found none). Add the step to the untrusted envelope | **Borrow, cheaply** |
| 11 | **Checkpoint before destructive writes.** A shadow git repository snapshots files before `write_file`/`patch` [H14] | Makes tier 1 file writes (`doc.draft`, a future file write) actually reversible, with a stored previous version as the read-back | Borrow |
| 12 | **The container is the boundary.** Hermes skips the command check inside containers [H3] | The reasoning behind `code.compute` (gap #7): with `--network none`, the only effect code can reach is inside the company | Basis for gap #7 |
| 13 | MCP `include`/`exclude` globs and a filtered stdio environment [H13][H3] | PALUGADA's allow-list with SHA-256 pins is already stricter | Already stricter |

## 6. Top 8 recommendations, most valuable first

1. **An IMAP/SMTP mail adapter for `mailbox.read`, `email.draft` and `email.send`.**
   Mail is the one thing every company does. Today two of the three capabilities have no
   binding at all, and the third is tied to Resend. A standard protocol reaches any mailbox,
   including a self-hosted one, with no new tiers to calibrate [H17][O20].
2. **`browser.read` (tier 0) and `browser.act` (tier 2), bound to Playwright and Chromium.**
   Both projects treat the browser as a first-class tool [O10][H5]. PALUGADA reaches one only
   through an MCP preset whose tiers the operator sets by hand. Putting it in the catalogue
   fixes the calibration, and submitting a form is then judged like sending an email.
3. **`files.read` with PDF, DOCX and XLSX converted to text, run in the `--network none` container.**
   Roles can list the company's files but cannot read them. Reading documents is basic in both
   projects [H9][O15], and the container keeps PALUGADA's promise never to parse an untrusted
   binary on the server.
4. **A local Readability provider, and a self-hosted Firecrawl, for `web.extract`.**
   This is the cheapest gap to close. Every extraction today goes through a third party that
   sees the URL. OpenClaw extracts locally with no key [O8], and Hermes accepts a self-hosted
   Firecrawl [H4].
5. **`image.describe` (tier 0, `readsOutside`).**
   Screenshots from `browser.read`, scanned PDFs, receipts and product photos are unreadable
   without it. Both projects ship one [H1][O1]. It can run on a local vision model behind the
   OpenAI-compatible interface PALUGADA already speaks.
6. **`code.compute`: Python bound only to the existing `--network none` container backend, at tier 1.**
   It gives data analysis the isolation `sandbox.ts` says it lacks. Because nothing can leave
   the container, it no longer needs to be kept out of divisions that hold credentials
   [H3][O5]. `container.ts` already does most of the work.
7. **`credential.request` (tier 0), on the pattern of OpenClaw's `secrets`.**
   A role can ask the owner for a missing key through the inbox, with a masked field and the
   hosts it may be sent to, and receive only an alias. Setup becomes self-service without a
   secret ever entering the model's context [O16].
8. **`chat.read` (tier 0) and `chat.send` (tier 2) for customer channels.**
   Both projects are built around messaging gateways [H2][O21]. A company run by agents needs
   to answer customers where they are. Matrix, Mattermost and ntfy can be self-hosted, and the
   Telegram Bot API is free.

Next after these: a ComfyUI provider for `image.generate` (gap #10), standing grants for
scheduled tier 2 actions (§5, idea 3), and stripping chat-template tokens from untrusted
content (§5, idea 10). The last is a small change with a security payoff.

## 7. Not verified

- The licenses of Readability, ComfyUI, Lightpanda, Camofox and `cua-driver`; the project docs read here do not state them.
- Which OpenAI-compatible local servers support `/audio/speech` (gap #14).
- Per-tool argument schemas beyond what the reference pages print.

## Sources

Hermes Agent (`https://github.com/NousResearch/hermes-agent/blob/main/website/docs/…`; also published at hermes-agent.nousresearch.com/docs):
- [H1] `reference/tools-reference.md`
- [H2] `reference/toolsets-reference.md`
- [H3] `user-guide/security.md`
- [H4] `user-guide/features/web-search.md`
- [H5] `user-guide/features/browser.md`
- [H6] `user-guide/features/tts.md`
- [H7] `user-guide/features/code-execution.md`
- [H8] `user-guide/features/image-generation.md`
- [H9] `user-guide/features/document-extraction.md`
- [H10] `user-guide/features/credential-vault.md`
- [H11] `user-guide/features/cron.md`
- [H12] `user-guide/features/skills.md`
- [H13] `user-guide/features/mcp.md`
- [H14] `user-guide/checkpoints-and-rollback.md`
- [H15] `user-guide/egress/network-isolation.md`
- [H16] `user-guide/egress/iron-proxy.md`
- [H17] `user-guide/messaging/email.md`
- [H18] https://github.com/NousResearch/hermes-agent/blob/main/LICENSE

OpenClaw (`https://github.com/openclaw/openclaw/blob/main/docs/…`; also published at docs.openclaw.ai):
- [O1] `tools/index.md`
- [O2] `gateway/config-tools/tool-policy.md`
- [O3] `tools/exec-approvals.md`
- [O4] `tools/permission-modes.md`
- [O5] `gateway/sandboxing.md` and `gateway/sandboxing/images-and-setup.md`
- [O6] `gateway/sandbox-vs-tool-policy-vs-elevated.md`
- [O7] `tools/web.md`
- [O8] `tools/web-fetch.md`
- [O9] `tools/searxng-search.md` and `tools/duckduckgo-search.md`
- [O10] `tools/browser.md`, `tools/browser/agent-tools.md`, `tools/browser/configuration.md` and `tools/browser/lightweight.md`
- [O11] `tools/media-overview.md`
- [O12] `tools/image-generation.md` and `providers/comfy.md`
- [O13] `tools/tts/quickstart.md`
- [O14] `nodes/audio.md`
- [O15] `tools/pdf.md`
- [O16] `tools/secrets.md`
- [O17] `tools/code-execution.md`
- [O18] `tools/lobster.md`
- [O19] `gateway/security/prompt-injection.md`
- [O20] https://github.com/openclaw/openclaw/tree/main/skills (each `SKILL.md` description)
- [O21] https://github.com/openclaw/openclaw/blob/main/README.md (MIT badge, channel list)
