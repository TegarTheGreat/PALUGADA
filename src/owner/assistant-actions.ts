/**
 * What the owner's assistant may do, route by route.
 *
 * The assistant reaches the platform only through the owner API the console
 * uses, and only in three ways:
 *
 * - **read** any GET route, except the few below that hand over more than a
 *   conversation should hold;
 * - **check** through the few POST routes that change nothing -- which models
 *   a provider serves, whether the model answers, what an MCP server offers;
 * - **propose** any of the POST routes listed in `ASSISTANT_ACTIONS`. A
 *   proposal is a card in front of the owner; nothing changes until they apply
 *   it, and a route that takes the owner's device takes it then, as it would
 *   from the page. A key the route needs is typed by the owner into a sealed
 *   field on the card and goes from the browser to the route: never through
 *   the model, which would otherwise send it to its provider.
 *
 * Every POST route is in one of the lists, and `test/acceptance/assistant.test.ts`
 * fails on one that is in neither, so a route added to the API is a decision
 * about the assistant as well.
 */
import { AGENT_CATALOGUE } from '../settings/agents.ts';

/**
 * The kinds of key an agent CLI signs in with, from the catalogue itself: a
 * card the assistant wrote with `api_key`, a kind no CLI takes, was refused
 * by the route every time the owner applied it.
 */
const AGENT_KEY_KINDS = [...new Set(AGENT_CATALOGUE.flatMap((entry) => entry.credentials.map((kind) => kind.id)))].join(', ');

export interface AssistantAction {
  pattern: string;
  /** What it does, for the model. */
  what: string;
  /** The body's fields and what each takes. */
  fields?: Readonly<Record<string, string>>;
  /** Fields the owner types into a sealed field on the card, never the model. */
  secrets?: Readonly<Record<string, string>>;
  /**
   * Whether the route takes the owner's device: always, or only for some
   * requests (a tier 3 decision), when the card asks for it after a refusal.
   */
  factor: 'always' | 'sometimes' | 'never';
  /**
   * Whether a card for it may be applied with one press in a chat (F10.9):
   * the everyday things an owner says to their CEO from a phone -- give this
   * work, file this, tell that task, cancel it, remember this, this is the
   * number. Only an action that takes no device and no key; anything that
   * decides an inbox item, loosens money or changes the deployment is
   * applied in the app, where the owner's device is.
   */
  chat?: true;
}

const COMPANY = 'companyId comes from GET /api/companies.';

export const ASSISTANT_ACTIONS: readonly AssistantAction[] = [
  /* ------------------------------------------------ the whole deployment --- */
  {
    pattern: '/api/control/settings/model',
    what: 'Choose the model every role runs on. The providers and their ids are in GET /api/control/settings.',
    fields: {
      provider: 'a provider id from GET /api/control/settings (providers[].id)',
      url: 'the provider\'s address; its usual one when left out',
      model: 'the model every role runs on; left out, the provider\'s own per tier where it has them',
      aliases: 'optional { fast, standard, deep } -> model, for a different model per tier',
    },
    secrets: { key: 'API key' },
    factor: 'always',
  },
  { pattern: '/api/control/settings/model/clear', what: 'Go back to the model the environment names.', factor: 'always' },
  {
    pattern: '/api/control/settings/model/prices',
    what: 'Say what a model costs, so calls are priced by it rather than at the high fallback. The models in use and their prices are in GET /api/control/settings (prices).',
    fields: { prices: '{ model name: { input, output } } in cents per million tokens, from the provider\'s price list; null takes a price back' },
    factor: 'always',
  },
  {
    pattern: '/api/control/tools/:kind',
    what: 'Choose the provider a tool goes to. kind is search, extract, image or speech; the providers are in GET /api/control/tools.',
    fields: {
      provider: 'a provider id from GET /api/control/tools (providers[kind][].id)',
      url: 'the owner\'s own server, for a provider that is one',
      model: 'for image and speech: a model other than the one the provider suggests',
      voice: 'for speech: the voice a role gets when it names none',
    },
    secrets: { key: 'API key' },
    factor: 'always',
  },
  {
    pattern: '/api/control/tools/:kind/test',
    what: 'Try a tool once with a provider, saving nothing: a search, a page, a picture or a clip. It costs one call.',
    fields: {
      provider: 'a provider id', url: 'the owner\'s own server, if it is one',
      query: 'for search', prompt: 'for image', text: 'for speech', model: 'optional', voice: 'optional',
    },
    secrets: { key: 'API key (left empty, the saved one)' },
    factor: 'never',
  },
  { pattern: '/api/control/tools/:kind/clear', what: 'Go back to the environment\'s choice for a tool.', factor: 'always' },
  {
    pattern: '/api/control/channels/push',
    what: 'Send urgent alerts to the owner\'s phone through ntfy or a webhook.',
    fields: { format: 'ntfy or webhook', url: 'the server, such as https://ntfy.sh', topic: 'for ntfy: the topic the phone subscribes to' },
    secrets: { token: 'Access token, if the server needs one' },
    factor: 'always',
  },
  {
    pattern: '/api/control/channels/push/test',
    what: 'Send one test push through the push settings saved.',
    fields: { title: 'optional', text: 'optional' },
    factor: 'never',
  },
  {
    pattern: '/api/control/channels/chat/:kind',
    what: 'Tell the owner in Slack or Discord (kind) through an incoming webhook.',
    secrets: { url: 'Incoming webhook address' },
    factor: 'always',
  },
  {
    pattern: '/api/control/channels/email',
    what: 'Email the owner what needs them, through Resend, Postmark or SendGrid.',
    fields: { provider: 'resend, postmark or sendgrid', from: 'an address the service may send from', to: 'the owner\'s address' },
    secrets: { key: 'API key' },
    factor: 'always',
  },
  {
    pattern: '/api/control/channels/email/test',
    what: 'Send one test email through the email settings saved.',
    fields: { provider: 'as saved', from: 'as saved', to: 'as saved', text: 'optional' },
    factor: 'never',
  },
  {
    pattern: '/api/control/channels/chat/:kind/test',
    what: 'Send one test message to the Slack or Discord webhook saved.',
    fields: { text: 'optional' },
    factor: 'never',
  },
  {
    pattern: '/api/control/channels/telegram/test',
    what: 'Send one test message through the Telegram bot saved.',
    fields: { text: 'optional' },
    factor: 'never',
  },
  {
    pattern: '/api/control/channels/telegram/photo',
    what: 'Give the Telegram bot saved PALUGADA\'s picture as its profile photo.',
    factor: 'never',
  },
  { pattern: '/api/control/channels/:name/clear', what: 'Disconnect a channel: telegram, push, slack or discord.', factor: 'always' },
  {
    pattern: '/api/control/vendors',
    what: 'Connect a service a capability calls, from a preset (GET /api/control/vendors) or an entry of the vendor file\'s shape. '
      + 'The division then needs the key the entry\'s credentialAlias names.',
    fields: { entry: 'a preset from GET /api/control/vendors, whole, with its url changed only if the owner\'s service lives elsewhere' },
    factor: 'always',
  },
  { pattern: '/api/control/vendors/:name/remove', what: 'Disconnect a service connected in the console.', factor: 'always' },
  {
    pattern: '/api/control/mcp/servers',
    what: 'Add or change an MCP server and the tools roles may use from it. Look first with the mcp/inspect check.',
    fields: {
      name: 'lowercase letters, digits, - and _; a preset\'s id from GET /api/control/mcp',
      url: 'the server\'s streamable HTTP address',
      tokenIn: 'optional { header } or { scheme } or { query }, as the preset says',
      tools: '{ toolName: { tier: 0-3, verify?: { tool, arguments?, matches } } }. Tier 0 only for a tool the server says only reads; '
        + 'a destructive one only tier 3; tier 1 and above needs verify, a read-back with another of its tools, '
        + 'matches being { present: "body.x" } or { path: "body.x", equalsPath: "input.y" }',
    },
    secrets: { token: 'The server\'s token, if it needs one' },
    factor: 'always',
  },
  { pattern: '/api/control/mcp/servers/:name/remove', what: 'Stop roles using an MCP server\'s tools.', factor: 'always' },
  {
    pattern: '/api/control/agents/:name/install',
    what: 'Install an agent CLI (claude-code, codex, gemini-cli, opencode) at the version PALUGADA was checked with.',
    fields: { version: 'optional; the checked version when left out' },
    factor: 'always',
  },
  {
    pattern: '/api/control/agents/:name/credential',
    what: 'Sign an agent CLI in with an API key.',
    fields: { kind: `whose key it is -- ${AGENT_KEY_KINDS} -- one the CLI takes` },
    secrets: { value: 'API key' },
    factor: 'always',
  },
  { pattern: '/api/control/agents/:name/credential/clear', what: 'Forget an agent CLI\'s key.', factor: 'always' },
  {
    pattern: '/api/control/agents/:name/settings',
    what: 'Let roles run on an agent CLI, or not, and which model each tier uses on it.',
    fields: { enabled: 'true or false', models: 'optional { fast, standard, deep } -> the CLI\'s own model names' },
    factor: 'always',
  },
  {
    pattern: '/api/control/owner-window',
    what: 'The hours the owner may be told things that can wait.',
    fields: { startHour: '0-23', endHour: '0-23', timezone: 'an IANA zone such as Asia/Jakarta' },
    factor: 'never',
  },
  {
    pattern: '/api/control/languages',
    what: 'The console\'s language and the agents\' default language.',
    fields: { console: 'a language code such as id or en', agents: 'a language code' },
    factor: 'never',
  },
  {
    // How amounts are read, as the panel's language is: nothing is charged in it (0106).
    pattern: '/api/control/money-display',
    what: 'The currency the owner reads money in, and the rate to read it at. PALUGADA still counts in US dollars.',
    fields: { currency: 'a three-letter code such as IDR, or null to read US dollars', rate: 'how many of it one US dollar buys' },
    factor: 'never',
  },
  { pattern: '/api/control/stop-all', what: 'Stop, or resume, all work in every company.', fields: { on: 'true to stop, false to resume' }, factor: 'always' },
  { pattern: '/api/control/cancel-everything', what: 'Cancel every task that is not finished, in every company.', factor: 'always' },
  {
    pattern: '/api/control/company/:companyId/freeze',
    what: 'Stop, or resume, all work in one company.',
    fields: { on: 'true to freeze, false to resume' },
    factor: 'always',
  },
  {
    pattern: '/api/control/capability/:name/kill',
    what: 'Switch a capability off, or on again, everywhere.',
    fields: { on: 'true to switch off, false to allow again' },
    factor: 'always',
  },
  {
    pattern: '/api/control/company/:companyId/role/:roleId/pause',
    what: 'Pause one role.', fields: { reason: 'why' }, factor: 'never',
  },
  { pattern: '/api/control/company/:companyId/role/:roleId/resume', what: 'Resume a paused role.', factor: 'always' },

  /* --------------------------------------------------------- companies --- */
  {
    pattern: '/api/companies',
    what: 'Start a company.',
    fields: {
      name: 'its name', companySlug: 'lowercase letters, digits and -', templateSlug: 'standard-company',
      timezone: 'an IANA zone', bundles: 'optional list of bundle slugs, such as ["company-os"] for a company that runs itself',
    },
    factor: 'always',
  },
  {
    pattern: '/api/companies/:companyId/tickets',
    what: 'File a ticket: something that needs doing and is not given to anyone yet. The CEO hands tickets on.',
    fields: { title: 'what needs doing, in a line', body: 'optional detail and what done looks like', priority: 'optional 0 (first) to 3 (last)', divisionId: 'optional division it belongs to' },
    factor: 'never', chat: true,
  },
  {
    pattern: '/api/companies/:companyId/tickets/:ticketId',
    what: 'Close a ticket nobody should do, or open one again.', fields: { status: 'open or closed', reason: 'optional, why', priority: 'optional 0-3' }, factor: 'never', chat: true,
  },
  {
    pattern: '/api/companies/:companyId/tickets/:ticketId/assign',
    what: 'Give a ticket to a role: it becomes that role\'s task, and closes when the task finishes.',
    fields: { roleId: 'the role that does it', goalId: 'the goal it serves' },
    factor: 'never', chat: true,
  },
  {
    pattern: '/api/companies/:companyId/assign',
    what: `Give a company work. ${COMPANY} The roles and goals are in GET /api/companies/:companyId/structure.`,
    fields: {
      roleId: 'the role that does it', divisionId: 'the role\'s division', projectId: 'the project it belongs to',
      goalId: 'the goal it serves', goal: 'what is wanted, in the owner\'s words', detail: 'optional detail',
    },
    factor: 'never', chat: true,
  },
  {
    pattern: '/api/companies/:companyId/inbox/:itemId/decide',
    what: `Approve, deny or ask about an item in the inbox (GET /api/companies/:companyId/inbox). ${COMPANY}`,
    fields: {
      decision: 'approve, deny or ask', note: 'why, or the question',
      allowForHours: 'optional, with approve: allow the same capability to the same role for this many hours (1 to 168), only where the item says allowFor',
    },
    factor: 'sometimes',
  },
  {
    pattern: '/api/companies/:companyId/standing-approvals/:standingId/revoke',
    what: 'Take back a yes the owner gave for a while (GET /api/companies/:companyId/standing-approvals), so the next such action asks again.',
    factor: 'never', chat: true,
  },
  {
    pattern: '/api/companies/:companyId/inbox/:itemId/answer',
    what: 'Tell the task behind an escalation something, without deciding the item; a task waiting on the owner goes back to work. A question a run asked the owner is answered by it, and closes.',
    fields: { answer: 'the answer' },
    factor: 'never',
  },
  {
    pattern: '/api/companies/:companyId/inbox/:itemId/snooze',
    what: 'Put an inbox item away until later.', fields: { until: 'an ISO time' }, factor: 'never', chat: true,
  },
  {
    pattern: '/api/companies/:companyId/inbox/batch',
    what: 'The same decision on several inbox items.',
    fields: { itemIds: 'list of item ids', decision: 'approve or deny', note: 'why' },
    factor: 'sometimes',
  },
  { pattern: '/api/companies/:companyId/tasks/:taskId/instruct', what: 'Tell a running task something.', fields: { text: 'the instruction' }, factor: 'never', chat: true },
  { pattern: '/api/companies/:companyId/tasks/:taskId/cancel', what: 'Cancel a task.', fields: { reason: 'why' }, factor: 'never', chat: true },
  { pattern: '/api/companies/:companyId/tasks/:taskId/rerun', what: 'Run a finished or failed task again.', fields: { note: 'what to do differently' }, factor: 'never', chat: true },
  { pattern: '/api/companies/:companyId/tasks/:taskId/continue', what: 'Go on with a task its budget stopped, from where it stopped, once the owner has raised the ceiling of its account.', fields: {}, factor: 'never', chat: true },
  {
    pattern: '/api/companies/:companyId/tasks/:taskId/feedback',
    what: 'Tell a company what the owner thought of delivered work; it becomes what the division remembers.',
    fields: { verdict: 'good or needs_work', note: 'what was right or wrong' },
    factor: 'never', chat: true,
  },
  { pattern: '/api/companies/:companyId/tasks/:taskId/replay', what: 'Replay a task\'s handler against its journal, to see a failure again.', factor: 'never' },
  {
    pattern: '/api/companies/:companyId/languages',
    what: 'The languages a company works in (what it produces for customers) and talks in (what its agents write to the owner and to each other). Both are sent every time. A project with customers in another market sets its own work language on the project instead.',
    fields: {
      work: 'a language code, or null for the deployment\'s default',
      talk: 'a language code, or null for the deployment\'s default',
    },
    factor: 'never',
  },
  {
    pattern: '/api/companies/:companyId/stage',
    what: 'Move a company to another stage; moving it on takes the owner\'s device.', fields: { stage: 'explore, validate, build, launch, grow or wind_down', note: 'why' }, factor: 'sometimes',
  },
  {
    pattern: '/api/companies/:companyId/batch-window',
    what: 'When work that can wait is done.',
    fields: { startHour: '0-23', endHour: '0-23', timezone: 'an IANA zone', daysOfWeek: 'list of 0-6, Sunday 0' },
    factor: 'never',
  },
  {
    pattern: '/api/companies/:companyId/spend/limit',
    what: 'The most a company may spend.', fields: { moneyMaxCents: 'in cents' }, factor: 'always',
  },
  {
    pattern: '/api/companies/:companyId/spend/resume',
    what: 'Let a company spend again after it hit its limit.', fields: { until: 'optional ISO time' }, factor: 'always',
  },
  {
    pattern: '/api/companies/:companyId/retention',
    what: 'How long a company keeps its records.',
    fields: { eventDays: 'whole days', traceDays: 'whole days', promptDays: 'whole days' },
    factor: 'never',
  },
  {
    pattern: '/api/companies/:companyId/alert-thresholds',
    what: 'When the owner is alerted.',
    fields: {
      dailyCostCents: 'number', taskFailureRate: '0-1', policyDenialsPerDay: 'number', verificationFailuresPerDay: 'number',
      roleFreezeDenialsPerDay: 'number', spendRateMultiple: 'number', spendRateFloorCents: 'number',
    },
    factor: 'never',
  },
  {
    pattern: '/api/companies/:companyId/goals',
    what: 'Add a goal.',
    fields: { kind: 'mission, objective or key_result', slug: 'short id', statement: 'the goal', parentGoalId: 'the goal above it' },
    factor: 'never',
  },
  {
    pattern: '/api/companies/:companyId/goals/:goalId',
    what: 'Reword a goal, or close it. Closing one pauses the schedules and triggers under it.',
    fields: { statement: 'optional', status: 'optional: active, met or abandoned' }, factor: 'always',
  },
  {
    pattern: '/api/companies/:companyId/metrics/:metricId',
    what: 'Put a measure right, or retire it; a retired measure keeps its history and takes no more values.',
    fields: {
      name: 'optional', unit: 'optional, only before any value is recorded: currency, count, ratio or percent', direction: 'optional: up or down',
      baseline: 'optional number', target: 'optional number', dueOn: 'optional date, or null', sourceCapability: 'optional, or null',
      retired: 'true to retire it',
    },
    factor: 'always',
  },
  {
    pattern: '/api/companies/:companyId/goals/:goalId/metrics',
    what: 'Measure a goal by a number.',
    fields: {
      name: 'what is counted, such as revenue in IDR or signups', slug: 'short id', unit: 'currency, count, ratio or percent', direction: 'up or down',
      baseline: 'number now', target: 'number wanted', dueOn: 'optional date', sourceCapability: 'optional capability that reads it',
    },
    factor: 'never',
  },
  {
    pattern: '/api/companies/:companyId/metrics/:metricId/observations',
    what: 'Record a measured value.', fields: { value: 'number', note: 'optional' }, factor: 'never', chat: true,
  },
  {
    pattern: '/api/companies/:companyId/memories',
    what: 'Tell a company something to remember.',
    fields: { body: 'the fact, or the way to work', kind: 'semantic (a fact) or procedural (a way to work)', divisionId: 'optional; company-wide when left out' },
    factor: 'never', chat: true,
  },
  {
    pattern: '/api/companies/:companyId/memories/:memoryId/retract',
    what: 'Take back something the company should not believe at all; it leaves every run and stays in the record.', factor: 'never',
  },
  {
    pattern: '/api/companies/:companyId/memories/:memoryId/supersede',
    what: 'Replace a remembered fact that turned out wrong.', fields: { body: 'the right one', confidence: 'optional 0-1' }, factor: 'never',
  },
  {
    pattern: '/api/companies/:companyId/divisions',
    what: 'Open a division.',
    fields: { name: 'its name', slug: 'short id', parentDivisionId: 'optional', maxConcurrency: 'optional number' },
    factor: 'always',
  },
  {
    pattern: '/api/companies/:companyId/projects',
    what: 'Start a project.',
    fields: {
      name: 'its name',
      slug: 'short id',
      workLanguage: 'optional: a language code from GET /api/control/languages (supported[].code) for a project that sells in another market than the company; left out, the company\'s work language',
    },
    factor: 'never',
  },
  {
    pattern: '/api/companies/:companyId/documents',
    what: 'Give the company a document as text -- a price list, a policy, a contract -- which runs find with memory.search.',
    fields: { title: 'its title', text: 'the whole text', divisionId: 'optional: one division\'s only' },
    factor: 'never',
  },
  {
    pattern: '/api/companies/:companyId/documents/:documentId/archive',
    what: 'Take a document out of what runs find (archived: true), or put it back (false). Its text is kept.',
    fields: { archived: 'true or false' }, factor: 'never',
  },
  {
    pattern: '/api/companies/:companyId/projects/:projectId',
    what: 'Rename a project, say what it is for (every run in it is told), close it to new work (archived: true) or open it again, or give it its own work language -- what its work for customers is written in, while agents still talk to the owner in the company\'s talk language.',
    fields: {
      name: 'optional new name',
      description: 'optional: what the project is for',
      archived: 'optional true or false',
      workLanguage: 'optional: a language code from GET /api/control/languages (supported[].code), or null for the company\'s work language',
    },
    factor: 'never',
  },
  {
    pattern: '/api/companies/:companyId/roles',
    what: 'Hire a role, with a name, a title and a persona the owner chose or you suggest from GET /api/personas. A company has one CEO: a hire is never titled CEO while it has one.',
    fields: {
      divisionId: 'its division', slug: 'short id', systemPrompt: 'what it does and how',
      tools: 'list of capability names, at most twelve', model: 'fast, standard or deep', doneCriteria: 'list of what done means',
      displayName: 'the name the owner calls it, such as Arka; give every role one', title: 'its title, such as CEO, CTO or Head of Support (GET /api/personas lists them)',
      persona: '{ preset: a persona id from GET /api/personas, notes: optional traits in the owner\'s words }',
    },
    factor: 'always',
  },
  {
    pattern: '/api/companies/:companyId/roles/:roleId',
    what: 'Change a role: its charter, what done means, tools or model, how long one run may take, or who it is -- its name, title or persona.',
    fields: {
      summary: 'what changed, for the history', systemPrompt: 'optional', tools: 'optional list',
      doneCriteria: 'optional list, one testable sentence each, at most 12; replaces the role\'s',
      modelPrimary: 'optional tier', modelFallback: 'optional tier', runtime: 'optional runtime name from GET /api/runtimes',
      maxRunMinutes: 'optional, the longest one run may take, 1 to 1440 minutes; 0 is no limit but the task\'s deadline',
      displayName: 'optional name', title: 'optional title, but not to or from CEO: that is the appoint action', persona: 'optional { preset, notes }; null takes it away',
    },
    factor: 'always',
  },
  {
    pattern: '/api/companies/:companyId/ceo',
    what: 'Make a role the company\'s CEO, the one the owner talks to; the role that was CEO keeps its name and loses the title. A company always has exactly one.',
    fields: { roleId: 'the role to appoint', summary: 'optional, for the history' },
    factor: 'always',
  },
  {
    pattern: '/api/companies/:companyId/roles/:roleId/change-request',
    what: 'Ask for a change to a role through its review.', fields: { summary: 'what and why', change: 'charter, skills or model_routing', tools: 'optional list' }, factor: 'never',
  },
  {
    pattern: '/api/companies/:companyId/structure/grant',
    what: 'Let a division use a capability, at a tier, or take it away.',
    fields: { divisionId: 'the division', capabilityName: 'such as web.search', tierOverride: 'optional 0-3', revoke: 'true to take it away' },
    factor: 'always',
  },
  {
    pattern: '/api/companies/:companyId/divisions/:divisionId/escalation',
    what: 'Who a division\'s stuck work goes to, and after how long.', fields: { roleSlug: 'the role', afterMinutes: 'number' }, factor: 'never',
  },
  {
    pattern: '/api/companies/:companyId/handoffs',
    what: 'When one role finishes, hand the result to another.',
    fields: { fromRoleId: 'the role that finishes', toRoleId: 'the role that carries on', brief: 'what the second does with it' },
    factor: 'always',
  },
  { pattern: '/api/companies/:companyId/handoffs/:ruleId', what: 'Switch a handoff on or off.', fields: { enabled: 'true or false' }, factor: 'always' },
  {
    pattern: '/api/companies/:companyId/schedules',
    what: 'Recurring work.',
    fields: {
      slug: 'short id', cronExpression: 'five-field cron', timezone: 'an IANA zone', roleId: 'who does it', goalId: 'the goal it serves',
      input: '{ goal: "what to do each time" }', enabled: 'true or false; left out, a schedule saved again keeps what it was',
      divisionId: 'the role\'s division', projectId: 'the project the work goes in',
      create: 'true for a new schedule, so a short name in use is refused rather than that schedule overwritten',
    },
    factor: 'never',
  },
  {
    // "Run the weekly review now" is something an owner says to their CEO
    // from a phone, like giving work: it spends from the schedule's own
    // account under its role's grants, and the owner still applies the card.
    pattern: '/api/companies/:companyId/schedules/:scheduleId/run',
    what: 'Run a schedule once now, as its next occurrence would, without moving its next run; one that is off may be tried this way and stays off. '
      + 'Refused while a task it made has not ended. The schedules are in GET /api/companies/:companyId/schedules.',
    factor: 'never', chat: true,
  },
  {
    pattern: '/api/companies/:companyId/schedules/:scheduleId/enabled',
    what: 'Turn a schedule off, or on again; on again, its next run is its next time, not the runs it missed while off.',
    fields: { enabled: 'true or false' },
    factor: 'never', chat: true,
  },
  {
    pattern: '/api/companies/:companyId/schedules/:scheduleId/remove',
    what: 'Remove a schedule. The work it already made stays.',
    factor: 'never',
  },
  {
    pattern: '/api/companies/:companyId/triggers',
    what: 'Let another service start work by posting to an address.',
    fields: {
      slug: 'short id', roleId: 'who does it', goalId: 'the goal', instruction: 'what to do with what arrives',
      scheme: 'bearer, url (token in the address, for a sender that takes only a URL), github, stripe, slack or standard', secretRef: 'a secret reference for the signature', maxPerHour: 'number',
    },
    factor: 'always',
  },
  {
    pattern: '/api/companies/:companyId/triggers/:triggerId/rotate',
    what: 'Point a trigger at a new signing secret.', fields: { secretRef: 'the new reference' }, factor: 'never',
  },
  { pattern: '/api/companies/:companyId/triggers/:triggerId', what: 'Switch a trigger on or off.', fields: { enabled: 'true or false' }, factor: 'always' },
  {
    pattern: '/api/companies/:companyId/budget-accounts/:accountId/limit',
    what: 'Change a budget account\'s ceilings; raising one takes the owner\'s device.',
    fields: { tokensMax: 'whole tokens', moneyMaxCents: 'optional, in cents' },
    factor: 'sometimes',
  },
  {
    pattern: '/api/companies/:companyId/budget-accounts',
    what: 'Open a budget account under another.',
    fields: {
      label: 'its name', parentAccountId: 'the account above', scopeType: 'division, project or role', scopeId: 'which',
      moneyMaxCents: 'in cents', tokensMax: 'optional',
    },
    factor: 'always',
  },
  {
    pattern: '/api/companies/:companyId/divisions/:divisionId/credentials',
    what: 'Give a division the key a service asks for (GET .../credentials names what it needs); pasted again, it replaces the old one.',
    fields: { alias: 'the name the service asks for, such as email or crm' },
    secrets: { value: 'The key the service gave you' },
    factor: 'always',
  },
  {
    pattern: '/api/companies/:companyId/divisions/:divisionId/credentials/:alias/remove',
    what: 'Take a key away from a division; its calls to that service stop.', factor: 'always',
  },
  {
    pattern: '/api/companies/:companyId/divisions/:divisionId/credentials/:alias/rotate',
    what: 'Point a division\'s credential at a new secret reference.', fields: { newSecretRef: 'the new reference' }, factor: 'always',
  },
  {
    pattern: '/api/companies/:companyId/config/:kind/rollback',
    what: 'Put a charter, policy or role back to an earlier version (GET .../config/:kind/history).',
    fields: { subjectId: 'which one', version: 'the version' },
    factor: 'always',
  },
  {
    pattern: '/api/companies/:companyId/charter',
    what: 'Rewrite the company\'s charter, which every run of the company is told first (read it with GET .../charter).',
    fields: { body: 'the whole new charter, in Markdown; the same words again change nothing' },
    factor: 'always',
  },
  {
    pattern: '/api/control/charter',
    what: 'Rewrite the platform charter, which every run of every company is told above its company\'s.',
    fields: { body: 'the whole new charter, in Markdown; the same words again change nothing' },
    factor: 'always',
  },
  {
    pattern: '/api/policies',
    what: 'Add or change a policy.',
    fields: {
      companyId: 'the company', slug: 'short id', effect: 'allow, require_review, require_approval or deny', mode: 'enforce or log_only',
      condition: 'the condition, as the Governance page shows them', params: 'optional', divisionId: 'optional',
    },
    factor: 'always',
  },
  {
    pattern: '/api/companies/:companyId/bundles',
    what: 'Install a bundle into a company (the bundles are in GET /api/companies/:companyId/structure).',
    fields: { slug: 'the bundle', version: 'optional' },
    factor: 'always',
  },
  {
    pattern: '/api/companies/:companyId/skills',
    what: 'Write a skill, or a new version of one, as a SKILL.md. It is a candidate: checked, read by a reviewer role, then '
      + 'back to the owner to switch on. Give it at least one check, or it can never be switched on.',
    fields: {
      slug: 'short name, lowercase with dashes', scopeType: 'division, company or platform', divisionId: 'for a division skill',
      source: 'the SKILL.md: front matter with name and description, then the procedure',
      changelog: 'what changed and why', checks: 'optional list of { name, expectContains: phrases every version must contain }',
    },
    factor: 'never',
  },
  {
    pattern: '/api/companies/:companyId/skills/:skillId/checks',
    what: 'Add a check a skill must pass: phrases every version of it must contain.',
    fields: { name: 'what the check is for', expectContains: 'list of phrases' }, factor: 'never',
  },
  {
    pattern: '/api/companies/:companyId/skills/versions/:versionId/review',
    what: 'Turn down a skill\'s candidate version. Approving is not this route: the reviewer role approves, then the owner.',
    fields: { approved: 'false', reason: 'why' }, factor: 'never',
  },
  { pattern: '/api/companies/:companyId/skills/versions/:versionId/approve', what: 'Switch on a skill version the reviewer approved.', factor: 'always' },
  {
    pattern: '/api/companies/:companyId/skills/:skillId/scope',
    what: 'Where a skill applies.', fields: { scopeType: 'division, company or platform', scopeId: 'the division, for a division scope' }, factor: 'always',
  },
  { pattern: '/api/companies/:companyId/skills/:skillId/quarantine/lift', what: 'Let a quarantined skill be used.', factor: 'always' },
  { pattern: '/api/companies/:companyId/evals/:caseId/accept', what: 'Accept a proposed evaluation case.', factor: 'never' },
  { pattern: '/api/companies/:companyId/devices/:deviceId/revoke', what: 'Stop a device from running work.', factor: 'never' },
  { pattern: '/api/publishers/:fingerprint/revoke', what: 'Stop trusting a bundle publisher.', factor: 'never' },
];

/** POST routes that change nothing, which the assistant may call itself. Secrets are never sent through them. */
export const ASSISTANT_CHECKS: Readonly<Record<string, string>> = {
  '/api/control/settings/model/models': 'Which models the saved provider serves: {}.',
  '/api/control/settings/model/test': 'Whether the model saved answers and can call a tool: {}.',
  '/api/control/settings/model/prices/lookup': 'What models.dev says each model in use costs, to propose saving: {}.',
  '/api/control/mcp/inspect': 'What a saved MCP server offers now: { name }.',
};

/** POST routes the assistant neither proposes nor calls, and why. */
export const NOT_FOR_THE_ASSISTANT: Readonly<Record<string, string>> = {
  '/api/auth/sign-in': 'signing in is the owner\'s',
  '/api/auth/claim': 'claiming a deployment with no owner is done from the link its start printed, before there is anyone to assist',
  '/api/auth/claim/confirm': 'the same claim, confirmed with the owner\'s new authenticator',
  '/api/auth/sign-out': 'signing out is the owner\'s',
  '/api/auth/sign-out-everywhere': 'signing out is the owner\'s',
  '/api/mfa/authenticators/:authenticatorId/revoke': 'the owner\'s own second factor is changed only by hand',
  '/api/mfa/passkeys': 'the owner\'s own second factor is changed only by hand',
  '/api/mfa/recovery-codes': 'recovery codes are shown to the owner once, in Security, and are theirs to write down',
  '/api/companies/:companyId/first-hour/close': 'the list on the owner\'s own Overview is closed by the owner, who is looking at it',
  '/api/channels/telegram': 'Telegram posts here, not a person',
  '/api/channels/whatsapp': 'Meta posts here, not a person',
  '/api/control/mcp/oauth/start': 'signing in to a service is the owner\'s, with their device and in their own browser',
  '/api/companies/:companyId/divisions/:divisionId/credentials/:alias/oauth/start': 'signing a division in for a key is the owner\'s, with their device and in their own browser',
  '/api/hooks/:publicId': 'other services post here, not a person',
  '/api/control/tour': 'the tour\'s own buttons',
  '/api/companies/:companyId/close': 'erasing a company is decided on its own settings page, with its name typed out, never on a card a model wrote',
  '/api/companies/:companyId/close/keep': 'taken back where it was decided, on the company\'s settings page',
  '/api/companies/:companyId/guardian': 'the owner\'s own judgement of how much a model may stop, turned off only with their device',
  '/api/control/channels/telegram/bot': 'Channels walks through it: the token is pasted there',
  '/api/control/channels/telegram/chats': 'Channels walks through it: the chat is found once the owner presses Start in the bot',
  '/api/control/channels/telegram': 'Channels walks through it, with the token and the chat found there',
  '/api/control/channels/whatsapp': 'Channels walks through it: the token and the app secret are pasted there, from Meta\'s own pages',
  '/api/control/agents/:name/accept': 'running a CLI at a version nobody checked is the owner\'s call, made in Agent CLIs with their device',
  '/api/control/agents/:name/login': 'a plan sign-in is a page the owner opens and a code they paste back, in Agent CLIs',
  '/api/control/agents/:name/login/code': 'the code from the sign-in page is pasted in Agent CLIs',
  '/api/control/agents/:name/login/cancel': 'part of the sign-in in Agent CLIs',
  '/api/companies/:companyId/skills/import': 'a skill arrives with its publisher\'s signature, which the assistant cannot make',
  '/api/publishers': 'trusting a publisher is a key the owner checks with the publisher',
  '/api/companies/:companyId/devices': 'a device registers itself',
  '/api/companies/:companyId/devices/:deviceId/pair': 'pairing compares a fingerprint on the device itself, in Devices',
  '/api/companies/:companyId/devices/:deviceId/challenge': 'a device asks for its own challenge',
  '/api/companies/import': 'an archive is a file the owner uploads',
  '/api/assistant/messages': 'the conversation itself',
  '/api/assistant/proposals/:proposalId/apply': 'only the owner applies a proposal',
  '/api/assistant/proposals/:proposalId/dismiss': 'only the owner dismisses a proposal',
  '/api/assistant/clear': 'only the owner starts the conversation again',
  '/api/companies/:companyId/conversation/messages': 'the conversation with a company\'s CEO itself',
  '/api/companies/:companyId/conversation/clear': 'only the owner starts a conversation again',
  '/api/assistant/listen': 'the owner\'s own voice, written down',
  '/api/assistant/speak': 'an answer said aloud to the owner',
};

/** GET routes the assistant does not read: they hand over a whole company, or issue a challenge. */
export const UNREADABLE: readonly string[] = [
  '/api/companies/:companyId/export',
  '/api/auth/challenge',
  '/api/mfa/challenge',
  '/api/mfa/passkeys/options',
  '/api/assistant',
  '/api/companies/:companyId/conversation',
];
