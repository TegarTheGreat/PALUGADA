/**
 * The standard company (PRD F1.1, F2.5, F16.3, goal G7, open question 14.2).
 *
 * Section 14.2 asked which line of business the first company would be in,
 * because that would fix the initial capabilities, the tier calibration and
 * the division template. The owner's answer is that there is no single one:
 * PALUGADA runs companies of every kind. So this template is organised by the
 * functions a company has regardless of what it sells -- it runs itself,
 * delivers something, finds demand, handles money, answers customers, and
 * checks its own work -- and a company in a particular trade adds divisions on
 * top rather than replacing these.
 *
 * Five things are deliberate.
 *
 * **Assurance holds no capability at all.** The reviewer division exists to
 * satisfy F7.3 with a role that is structurally incapable of acting on what it
 * approves. A reviewer that can also execute is not a second pair of eyes, it
 * is a second pair of hands.
 *
 * **The lab holds exactly one.** `code.execute` runs code the company did not
 * write, and the sandbox does not isolate the network (F8.10). The database
 * refuses to put a credential or a tier 2 grant in the same division, so the
 * lab is its own division precisely so that refusal never has to fire in
 * anger.
 *
 * **The money ceilings are two, and they are not the same instrument.**
 * Section 14.3 is answered: USD 200 per company per month, which lives in
 * `spend_limits` and is enforced per calendar month (F1.7, F1.9). The figure
 * here is the other ceiling -- the lifetime allowance of the budget account a
 * delegation tree shares (F5.4) -- set to a year of the monthly one.
 *
 * That multiple is deliberate: setting the lifetime figure to the monthly one
 * would make it bind in the second month, and the monthly ceiling would never
 * get to do its job. It is set high enough to stay out of the way, and F1.6's
 * narrower accounts are what actually contain a division.
 *
 * **Every division has its own ceiling, under the company's (F1.6).** The
 * budget block at the bottom of this file gives each one an account whose
 * parent is the company's, so a reservation is checked against the whole chain
 * and a division cannot spend the company's month by itself. Build's account
 * hangs from Delivery's rather than the company's, because Build is Delivery's
 * sub-division and its spending is Delivery's spending. The shares add up to
 * more than the company's total on purpose -- they are containment, not an
 * allocation, and a quiet division does not lend its share to a busy one.
 *
 * **Models are named by role, not by vendor.** `fast`, `standard` and `deep`
 * are the three shapes of work here. Section 14.5 leaves the mapping to real
 * models open, and F6 asks for per-role model abstraction so one provider's
 * outage cannot stop the platform, so binding a vendor name into a stored
 * template would pre-empt both.
 */
import { saveTemplate, type CompanyTemplate } from './company.ts';
import { VERDICT_OUTPUT } from '../review/verdict.ts';

export const STANDARD_TEMPLATE_SLUG = 'standard-company';

/** The shape of a task handed to any role in this template. */
export const WORK_INPUT = {
  type: 'object',
  additionalProperties: true,
  required: ['goal'],
  properties: {
    goal: { type: 'string', minLength: 1 },
    context: { type: 'string' },
  },
} as const;

/**
 * The shape every role returns.
 *
 * `summary` is required because a run that produces no account of itself
 * cannot be reviewed, digested or distilled -- and those three are most of
 * what makes the company improve.
 */
export const WORK_OUTPUT = {
  type: 'object',
  additionalProperties: true,
  required: ['summary'],
  properties: {
    summary: { type: 'string', minLength: 1 },
    // What the work taught that the company should remember (0071); kept
    // for the role's division as unverified lessons.
    learned: { type: 'array', maxItems: 5, items: { type: 'string', maxLength: 500 } },
  },
} as const;

/**
 * The two capabilities almost every role holds.
 *
 * They are not a convenience. F4.8 caps the context pack and tells the run to
 * use `memory.search` for whatever did not fit; F15.7 puts a skill's summary in
 * the pack and tells it to use `skill.read` for the document. A company whose
 * roles are not granted them is one where every run is instructed to call
 * something it will be refused for — which is what the first real boot of this
 * platform found, and which no test had caught because no test followed the
 * instruction.
 *
 * Both are tier 0 reads of the company's own store, scoped to the asking
 * division by the same rules the pack uses, so granting them widens nothing.
 *
 * `plan.record` and `metric.record` join them. The first was missing, and
 * with it every tier 2 grant in this template was one its holder could never
 * use: F8.11 refuses a tier 2 action on a task with no plan, and the only way
 * a run records one is this capability. The second is how a run says where a
 * key result stands (0053). Both write only to the company's own records,
 * which is why they are tier 0. The third, `owner.ask`, is how a run that
 * needs the owner asks rather than guesses; it opens an item and parks the
 * task, and nothing leaves the company.
 */
export const PLATFORM_TOOLS = ['memory.search', 'skill.read', 'plan.record', 'metric.record', 'owner.ask'] as const;

/**
 * The two divisions that do not get them, and why.
 *
 * The lab holds `code.execute`, and `SANDBOX_GUARANTEES` records that the
 * sandbox does not isolate the network. F8.10 already refuses that division a
 * credential or a tier 2 grant, because untrusted code could post either one
 * somewhere. Everything the company knows is the same category of thing:
 * granting `memory.search` here would hand supplied code a search interface
 * over the company's accumulated knowledge, and `skill.read` its approved
 * procedures. The lab reads its own inputs and nothing else.
 *
 * Assurance is excluded for the opposite reason. F7.3 says the reviewer
 * approves and cannot act, and the way that is guaranteed is that its division
 * holds no grant at all -- an invariant one query can check, which
 * capability-catalogue.test.ts does. A read is not an action, so the
 * temptation is to make an exception for these two; the exception is refused
 * anyway, because "no grants" is checkable and "only harmless grants" is an
 * argument to be had again with every capability anybody adds. The reviewer
 * judges the proposal it was handed, which is what its own prompt tells it.
 */
const NO_PLATFORM_TOOLS = new Set(['lab', 'assurance']);

/**
 * The company's shape, lifted out so the platform grants below derive from it
 * rather than repeating it. A division added here is granted the platform
 * tools automatically, which is the difference between a rule and a list
 * somebody has to remember to extend.
 */
/**
 * F2.1: when something in a division is stuck, the coordinator is asked first
 * and has an hour before the owner is told, with the coordinator's account of
 * what it did. The coordinator's own division goes straight to the owner:
 * there is nobody above it to ask.
 */
const TO_THE_COORDINATOR = { role: 'coordinator', afterMinutes: 60 } as const;

const DIVISIONS = [
  { slug: 'ops', name: 'Operations', maxConcurrency: 4 },
  { slug: 'delivery', name: 'Delivery', maxConcurrency: 4, escalateTo: TO_THE_COORDINATOR },
  // The one sub-division. Depth is capped at two (F2.2), and the split earns
  // its place: planning and building fail differently and deserve different
  // concurrency and different grants.
  { slug: 'build', name: 'Build', parent: 'delivery', maxConcurrency: 6, escalateTo: TO_THE_COORDINATOR },
  { slug: 'growth', name: 'Growth', maxConcurrency: 3, escalateTo: TO_THE_COORDINATOR },
  { slug: 'finance', name: 'Finance', maxConcurrency: 2, escalateTo: TO_THE_COORDINATOR },
  { slug: 'support', name: 'Support', maxConcurrency: 6, escalateTo: TO_THE_COORDINATOR },
  { slug: 'assurance', name: 'Assurance', maxConcurrency: 2, escalateTo: TO_THE_COORDINATOR },
  { slug: 'lab', name: 'Lab', maxConcurrency: 2, escalateTo: TO_THE_COORDINATOR },
] as const;

/**
 * Handing work on: a sub-task to another role, and its result back.
 *
 * Two divisions hold them. Operations, because the coordinator is where work
 * arrives when nobody said who should do it, and routing it is the job.
 * Delivery, because a plan the planner cannot hand to the builder is a plan
 * the owner has to carry across by hand. Both are tier 0 and write only the
 * company's own tasks; the hop limit, the fan-out cap and the parent's budget
 * chain bound what a delegation can start (F5.4, F6.4).
 */
const HAND_ON = ['task.delegate', 'task.await'] as const;

export const STANDARD_COMPANY_TEMPLATE: CompanyTemplate = {
  projects: [{ slug: 'main', name: 'Main' }],

  // F2.7. Deliberately general, because the template is: a company in any line
  // of business can say this much about itself on day one, and the owner
  // replaces the statements with its own once there are any.
  goals: [
    {
      slug: 'mission',
      kind: 'mission',
      statement: 'Deliver what this company sells, reliably and without surprising its owner.',
    },
    {
      slug: 'deliver',
      kind: 'objective',
      parent: 'mission',
      statement: 'Ship the work the company has promised, on time and verified.',
    },
    {
      slug: 'sustain',
      kind: 'objective',
      parent: 'mission',
      statement: 'Keep the company solvent, answerable and running without daily attention.',
    },
  ],

  divisions: [...DIVISIONS],

  grants: [
    // F4.8, F15.7: every division outside NO_PLATFORM_TOOLS may read its own
    // memory and its own skills. The context pack instructs every run to do
    // both, so a division without the grants is one where following that
    // instruction is a refusal.
    ...DIVISIONS
      .filter((division) => !NO_PLATFORM_TOOLS.has(division.slug))
      .flatMap((division) =>
        PLATFORM_TOOLS.map((capability) => ({ division: division.slug, capability }))),

    // Operations: watches the company and writes things down. Nothing here
    // reaches a customer.
    { division: 'ops', capability: 'uptime.check' },
    { division: 'ops', capability: 'metrics.read' },
    { division: 'ops', capability: 'files.list' },
    { division: 'ops', capability: 'files.read' },
    { division: 'ops', capability: 'calendar.read' },
    { division: 'ops', capability: 'calendar.hold' },
    { division: 'ops', capability: 'doc.draft' },
    { division: 'ops', capability: 'ticket.create' },
    // The backlog the CEO hands on: tickets the planner and support file.
    { division: 'ops', capability: 'ticket.list' },
    // Looking again, later, at what the company's own work did.
    { division: 'ops', capability: 'task.follow_up' },
    // Work owed again and again, proposed as a schedule the owner says yes
    // to rather than asked for by hand each time.
    { division: 'ops', capability: 'schedule.propose' },
    ...HAND_ON.map((capability) => ({ division: 'ops', capability })),

    // Delivery plans; it does not deploy. The separation is what makes the
    // build division's tier 2 grant reviewable rather than routine.
    { division: 'delivery', capability: 'repo.read' },
    { division: 'delivery', capability: 'web.fetch' },
    // Finding what exists before planning around it: bound once the owner
    // chooses a search provider, and a note until then.
    { division: 'delivery', capability: 'web.search' },
    { division: 'delivery', capability: 'web.extract' },
    { division: 'delivery', capability: 'files.list' },
    { division: 'delivery', capability: 'files.read' },
    { division: 'delivery', capability: 'doc.draft' },
    { division: 'delivery', capability: 'ticket.create' },
    ...HAND_ON.map((capability) => ({ division: 'delivery', capability })),

    // Build ships. It holds the only production deploy in the company, rate
    // limited because a deploy loop is the cheapest way to spend an afternoon
    // of budget on nothing.
    { division: 'build', capability: 'repo.read' },
    { division: 'build', capability: 'repo.branch' },
    { division: 'build', capability: 'deploy.staging' },
    { division: 'build', capability: 'uptime.check' },
    { division: 'build', capability: 'dns.read' },
    { division: 'build', capability: 'dns.update' },
    { division: 'build', capability: 'deploy.production', rateLimitPerHour: 4, maxInFlight: 1 },

    // Growth speaks in public. Every tier 2 grant here is rate limited: the
    // damage from these is volume, not any single call.
    { division: 'growth', capability: 'web.fetch' },
    { division: 'growth', capability: 'web.search' },
    { division: 'growth', capability: 'web.extract' },
    // Pictures and voice-overs for what it publishes: drafts in the company's
    // files, bound once the owner chooses a provider, and a note until then.
    // The marketer's twelve tools are full; the owner trades one on Team.
    { division: 'growth', capability: 'image.generate' },
    { division: 'growth', capability: 'speech.synthesize' },
    { division: 'growth', capability: 'crm.read' },
    { division: 'growth', capability: 'crm.note' },
    { division: 'growth', capability: 'crm.record' },
    { division: 'growth', capability: 'doc.draft' },
    { division: 'growth', capability: 'email.draft' },
    { division: 'growth', capability: 'email.send', rateLimitPerHour: 20 },
    { division: 'growth', capability: 'social.publish', rateLimitPerHour: 4 },
    // Not `ads.campaign.start`. Paid reach is the fastest way for a company
    // with nothing proven to spend its budget, and a standing grant for it
    // made every new company one prompt away from buying ads. The owner adds
    // it -- the grant here and the tool on the marketer -- once there is
    // something worth advertising.


    // Finance. Deliberately no `funds.transfer`: a transfer with no invoice to
    // check the amount and the recipient against is tier 3, and a template
    // should not hand any division a standing grant for one.
    { division: 'finance', capability: 'ledger.read' },
    { division: 'finance', capability: 'ledger.record' },
    { division: 'finance', capability: 'doc.draft' },
    // A receipt or a supplier's invoice as a picture, read once a vision
    // provider is chosen under Tools; until then the grant waits unbound.
    { division: 'finance', capability: 'image.describe' },
    // Figures worked out in Python on the company's files, in a container
    // that reaches no network: F8.10 lets it sit beside Finance's keys and
    // its invoices for that reason (0115). Unbound until the operator gives
    // it an image. Never in the lab, whose code reaches the network: what
    // this one reads, that one could post.
    { division: 'finance', capability: 'code.compute' },
    { division: 'finance', capability: 'invoice.issue', rateLimitPerHour: 10 },
    { division: 'finance', capability: 'invoice.pay', rateLimitPerHour: 5 },

    // Support answers people who are already customers, so its send limit is
    // higher than Growth's and its reach is narrower.
    { division: 'support', capability: 'mailbox.read' },
    { division: 'support', capability: 'image.describe' },
    { division: 'support', capability: 'crm.read' },
    { division: 'support', capability: 'crm.note' },
    { division: 'support', capability: 'crm.record' },
    { division: 'support', capability: 'ticket.create' },
    { division: 'support', capability: 'email.draft' },
    { division: 'support', capability: 'email.send', rateLimitPerHour: 60 },

    // Assurance: nothing. See the module comment.

    // Lab: one capability, and the database will refuse to let anything else
    // that matters join it.
    { division: 'lab', capability: 'code.execute', rateLimitPerHour: 30 },
  ],

  // Each role has a name and a title, so the company reads as a team of
  // people rather than a list of functions; no persona is set, so each
  // works as its charter says until the owner chooses one (domain/personas.ts).
  roles: [
    {
      slug: 'coordinator',
      displayName: 'Arka',
      title: 'CEO',
      doneCriteria: [
        'the state of every service checked is recorded',
        'anything that needs another division is handed off rather than attempted',
      ],
      division: 'ops',
      model: 'standard',
      maxTokensPerRun: 60_000,
      systemPrompt:
        'You run the company\'s own operations, and you are where work arrives when the owner ' +
        'did not say who should do it. Route it: decide which role\'s job it is, hand it over ' +
        'with task.delegate and a brief that says what done looks like, wait for the result ' +
        'with task.await, and report what came back. The other roles file what is owed and not yet ' +
        'anyone\'s as tickets: read them with ticket.list, and hand one on with task.delegate and its ' +
        'ticketId, so it closes when the work is done. Do the work yourself only when it is ' +
        'operations: checking that services are up and writing things down. When an action\'s ' +
        'effect lands later -- an invoice sent, a campaign launched, a deploy -- ask to look again ' +
        'with task.follow_up: name the role, what to check it against (the ledger, the page, the ' +
        'figure) and what to do about what it finds, and do not wait on it. When the same work ' +
        'is owed again and again, propose a schedule for it with schedule.propose -- which role, ' +
        'when, what each run does, and the evidence -- rather than waiting to be asked each time; ' +
        'the owner\'s yes makes it. When a division escalates something to you, fix the cause ' +
        'or hand it to the role that can; you cannot decide for the owner. You do not contact ' +
        'anyone outside the company and you do not ship anything.',
      tools: [
        ...PLATFORM_TOOLS,
        ...HAND_ON,
        'uptime.check',
        // `metrics.read` made way for `schedule.propose`, as it did for the
        // strategist's `goal.propose`: it answers nothing until a vendor is
        // bound, and the division still holds it to trade back on Team.
        'schedule.propose',
        // Not `web.fetch`, `files.list`, `calendar.read` or `calendar.hold`:
        // F2.4's twelve is a budget, and routing work is worth more places
        // than those -- the backlog the other roles file first of all. The
        // division still holds them, for a role hired to use them.
        'ticket.list',
        // In place of `doc.draft`, which answers nothing until the deployment
        // has a files root, and which the division still holds: the one role
        // that routes work is the one that can say "look at this again in two
        // days", and nothing else in the company is time-keyed to an outcome.
        'task.follow_up',
        'ticket.create',
      ],
      inputSchema: WORK_INPUT,
      outputSchema: WORK_OUTPUT,
    },
    {
      slug: 'planner',
      displayName: 'Sinta',
      title: 'CPO',
      doneCriteria: [
        'the plan names what will change, how it will be checked, and what undoing it would take',
        'the tickets that follow from it exist',
      ],
      division: 'delivery',
      model: 'deep',
      maxTokensPerRun: 120_000,
      systemPrompt:
        'You turn a goal into a plan the build division can execute. You read the ' +
        'repository, the existing documents and public sources, and you produce a written ' +
        'plan and the tickets that follow from it. You have no deploy capability, by ' +
        'design: deciding what to ship and shipping it are separate jobs here. When the plan ' +
        'is ready, hand the build to the builder with task.delegate, the plan as its brief, ' +
        'and wait for the result with task.await.',
      // `web.search` rather than `files.list`: F2.4's twelve is a budget, and a
      // plan that has not looked at what already exists is a guess. The
      // division still holds `files.list`, for a role hired to use it.
      tools: [...PLATFORM_TOOLS, ...HAND_ON, 'repo.read', 'web.search', 'web.fetch', 'doc.draft', 'ticket.create'],
      inputSchema: WORK_INPUT,
      outputSchema: WORK_OUTPUT,
    },
    {
      slug: 'builder',
      displayName: 'Bima',
      title: 'CTO',
      doneCriteria: [
        'staging shows the service answering after the change; where deploy.staging is not connected, ' +
          'the output says so and how the change is to be checked',
        'production carries the same build, or the reason it does not is written down',
      ],
      division: 'build',
      model: 'deep',
      maxTokensPerRun: 150_000,
      systemPrompt:
        'You implement and ship. Work on a branch, deploy to staging, check that the ' +
        'service still answers, and only then deploy to production. A production deploy is ' +
        'a tier 2 action: it is checked against budget and policy and may be sent for ' +
        'review, so propose it with the evidence from staging attached rather than as a ' +
        'bare request.',
      tools: [
        ...PLATFORM_TOOLS,
        'repo.read',
        'repo.branch',
        'deploy.staging',
        'uptime.check',
        'dns.read',
        'dns.update',
        'deploy.production',
      ],
      inputSchema: WORK_INPUT,
      outputSchema: WORK_OUTPUT,
    },
    {
      slug: 'marketer',
      displayName: 'Laras',
      title: 'CMO',
      doneCriteria: [
        'every message sent was drafted first',
        'what was sent, and to whom, is on the customer record; where crm.note is not connected, it is ' +
          'in the output',
      ],
      division: 'growth',
      model: 'standard',
      maxTokensPerRun: 80_000,
      systemPrompt:
        'You find and keep demand. Draft first and send second: a draft is reversible and ' +
        'a sent message is not. Anything you publish or spend on is a tier 2 action and is ' +
        'rate limited, so treat the limit as the plan rather than as an obstacle.',
      tools: [
        ...PLATFORM_TOOLS,
        'web.fetch',
        'crm.read',
        'crm.note',
        'doc.draft',
        'email.draft',
        'email.send',
        'social.publish',
      ],
      inputSchema: WORK_INPUT,
      outputSchema: WORK_OUTPUT,
    },
    {
      slug: 'bookkeeper',
      displayName: 'Dimas',
      title: 'CFO',
      doneCriteria: [
        'every payment is matched to an invoice that was read',
        'the ledger balances against what was issued and paid; where ledger.read is not connected, the ' +
          'output lists what was issued and paid for the owner to check',
      ],
      division: 'finance',
      model: 'standard',
      maxTokensPerRun: 60_000,
      systemPrompt:
        'You keep the money straight: read the ledger, record what came in and went out in ' +
        'it with ledger.record, issue invoices, and pay invoices the ' +
        'company owes. Every payment must be matched to an invoice you have read. You ' +
        'cannot transfer money that is not settling one, and you should not ask for that ' +
        'capability; that transfer is the owner\'s to make. Work figures out with code.compute ' +
        'rather than in your head, and read a receipt or an invoice that came as a picture with ' +
        'image.describe.',
      tools: [...PLATFORM_TOOLS, 'ledger.read', 'ledger.record', 'doc.draft', 'image.describe', 'code.compute', 'invoice.issue', 'invoice.pay'],
      inputSchema: WORK_INPUT,
      outputSchema: WORK_OUTPUT,
    },
    {
      slug: 'responder',
      displayName: 'Nadia',
      title: 'Head of Support',
      doneCriteria: [
        'the customer has an answer, or a ticket exists saying who owes them one',
        'what the customer was told is on the customer record; where crm.note is not connected, it is in ' +
          'the output',
      ],
      division: 'support',
      model: 'fast',
      maxTokensPerRun: 40_000,
      systemPrompt:
        'You answer customers who have already written in. Read the mailbox and the ' +
        'customer record before replying, record what you told them, and open a ticket ' +
        'when the answer needs somebody else. Keep their details and what they want to buy ' +
        'on the record with crm.record. If a reply would commit the company to ' +
        'anything -- a refund, a date, a discount -- do not send it: hand it off.',
      tools: [
        ...PLATFORM_TOOLS,
        'mailbox.read',
        'crm.read',
        'crm.note',
        'crm.record',
        'ticket.create',
        'email.draft',
        'email.send',
      ],
      inputSchema: WORK_INPUT,
      outputSchema: WORK_OUTPUT,
    },
    {
      slug: 'reviewer',
      displayName: 'Raka',
      title: 'Head of Quality',
      doneCriteria: [
        'the verdict names the criterion that decided it',
        'a proposal that could not be judged was rejected for that reason rather than approved',
      ],
      division: 'assurance',
      model: 'deep',
      maxTokensPerRun: 80_000,
      systemPrompt:
        'You review proposals from other divisions against the charter, the policies and ' +
        'the stated criteria. You hold no capability of your own and cannot carry out what ' +
        'you approve, which is the point. Answer with a verdict and the reason for it. If ' +
        'you cannot judge the proposal on what you were given, say so plainly: an unclear ' +
        'answer is escalated to the owner, and that is the correct outcome, not a failure.',
      // Empty, and F7.3 is why. NO_PLATFORM_TOOLS above has the argument.
      tools: [],
      inputSchema: WORK_INPUT,
      // The verdict `settleCompletedReviews` reads, not a summary: asked for a
      // summary, a reviewer's review went to the owner as unreadable.
      outputSchema: VERDICT_OUTPUT,
    },
    {
      slug: 'analyst',
      displayName: 'Sari',
      title: 'Head of Data',
      doneCriteria: [
        'the question has a numeric answer, or a statement of why the data cannot give one',
        'the snippet that produced it is recorded with the result',
      ],
      division: 'lab',
      model: 'standard',
      maxTokensPerRun: 60_000,
      systemPrompt:
        'You answer questions by running code in the sandbox. The sandbox has no ' +
        'filesystem, no subprocesses and no credentials, and your division holds nothing ' +
        'else on purpose. Pass the data you need in as input and return the result; do not ' +
        'try to reach the network from inside the snippet, and do not ask for a credential.',
      tools: ['code.execute'],
      inputSchema: WORK_INPUT,
      outputSchema: WORK_OUTPUT,
    },
  ],

  sops: [
    {
      division: 'ops',
      body:
        'Before reporting a service as down, check it twice with a gap between the checks. ' +
        'A single failed check is a network event more often than it is an outage, and an ' +
        'incident raised on one sample teaches the owner to distrust incidents.',
    },
    {
      division: 'delivery',
      body:
        'A plan names what will change, how it will be checked, and what undoing it would ' +
        'take. A plan without the third part is a plan that has not been thought through, ' +
        'because the build division will be asked for exactly that at review.',
    },
    {
      division: 'build',
      body:
        'Deploy to staging and confirm the service answers before proposing a production ' +
        'deploy. Attach the staging evidence to the proposal. A production deploy proposed ' +
        'without it will be sent back, and the round trip costs more than the check did.',
    },
    {
      division: 'growth',
      body:
        'Draft, then send. Anything addressed to a person outside the company is read once ' +
        'and cannot be recalled, so the draft is where the mistakes are supposed to happen.',
    },
    {
      division: 'finance',
      body:
        'Match every payment to an invoice you have read in the ledger, and check the ' +
        'amount and the recipient against it. A payment that cannot be matched is not a ' +
        'payment to make carefully; it is one to escalate.',
    },
    {
      division: 'support',
      body:
        'Read the customer record before replying. If the reply would commit the company ' +
        'to a refund, a date or a discount, hand it off instead of sending it: those are ' +
        'promises, and a promise made by mistake is not withdrawn by correcting it.',
    },
    {
      division: 'assurance',
      body:
        'Judge the proposal on the criteria you were given and say which criterion decided ' +
        'it. "Looks fine" is not a verdict. If the proposal is missing what you need to ' +
        'judge it, reject it for that reason rather than approving it on the assumption ' +
        'that the missing part is fine.',
    },
    {
      division: 'lab',
      body:
        'Pass data into the snippet as input rather than fetching it from inside. Code in ' +
        'the sandbox has no credentials and its network access is not something to rely ' +
        'on; a snippet that reaches out is a snippet that will fail in a way nobody can ' +
        'reproduce.',
    },
  ],

  budget: {
    // The tokens a month, and they are sized against the money, not the other
    // way round. At a middling $5 a million tokens the first version's 300,000
    // for Growth came to a dollar and a half against a ceiling of hundreds, so
    // the tokens ran out a hundred times before the dollars could and a
    // company of agents stopped "out of budget" at a cost of US$0.00 (the
    // owner's complaint of 6 October). Money is what an owner means by a
    // budget; the token ceilings stay as containment for a loop that costs
    // nothing a token -- a free model -- and are high enough not to bind first.
    tokensMax: 100_000_000,
    // A year of the monthly ceiling. See the module comment: this is the
    // company-wide lifetime ceiling, not the monthly one, and it is set out of
    // the way so that the monthly limit in `spend_limits` is what actually
    // paces the company.
    moneyMaxCents: 240_000,

    // F1.6's narrower ceilings, and the point of them is containment rather
    // than accounting. Every one of these rolls up into the company account
    // above, so the company's total is unchanged; what changes is that one
    // division cannot spend the whole of it. A build loop that goes wrong stops
    // when Build's share is gone, while support is still answering customers.
    //
    // The shares deliberately sum to more than the company's ceiling. They are
    // not an allocation of it -- a division that is quiet does not lend its
    // share to one that is busy, and sizing them to add up exactly would mean
    // the company ceiling could never be the thing that binds. Each number is
    // "the most this division should ever be able to spend on its own",
    // measured against what its work costs: ops and support run many short
    // tasks, assurance reviews what others produced, and the lab runs code that
    // is supposed to be cheap and occasionally is not, which is exactly why it
    // is capped hardest.
    //
    // Build hangs from Delivery rather than from the company, because it is
    // Delivery's sub-division: its spending is Delivery's spending, and
    // Delivery's ceiling has to be the larger of the two or it would be a
    // number that could never bind. `assertTemplateIsCoherent` refuses the
    // other way round rather than storing a limit that looks enforced.
    divisions: [
      { division: 'ops', tokensMax: 20_000_000, moneyMaxCents: 48_000 },
      { division: 'delivery', tokensMax: 45_000_000, moneyMaxCents: 108_000 },
      { division: 'build', tokensMax: 35_000_000, moneyMaxCents: 84_000 },
      { division: 'growth', tokensMax: 15_000_000, moneyMaxCents: 36_000 },
      { division: 'finance', tokensMax: 10_000_000, moneyMaxCents: 24_000 },
      { division: 'support', tokensMax: 20_000_000, moneyMaxCents: 48_000 },
      { division: 'assurance', tokensMax: 15_000_000, moneyMaxCents: 36_000 },
      { division: 'lab', tokensMax: 7_500_000, moneyMaxCents: 18_000 },
    ],
  },
};

/**
 * Stores the standard template.
 *
 * It lives in code rather than in a migration so it is reviewed as code and
 * can be re-installed after an edit; `saveTemplate` upserts on the slug. It
 * validates on the way in, so a change that breaks the tools-are-a-subset rule
 * is caught here rather than at the next company creation.
 */
export async function installStandardTemplate(): Promise<void> {
  await saveTemplate({
    slug: STANDARD_TEMPLATE_SLUG,
    name: 'Standard company',
    description:
      'Function-based divisions that apply to a company in any line of business: ' +
      'operations, delivery and build, growth, finance, support, assurance and lab.',
    body: STANDARD_COMPANY_TEMPLATE,
  });
}
