/**
 * The company every owner starts with: a CEO, and nothing else.
 *
 * It used to start with a team -- seven divisions, a role in each, the grants
 * and ceilings of every one -- and the owner's first hour was spent reading
 * what a bookkeeper and a lab were for before the company had sold anything.
 * That team was somebody's guess at their business. The company that starts
 * here has one division, one role and one goal, and the rest is built as it is
 * needed, by the CEO the owner talks to: a division when there is work of its
 * kind, a role when there is a job for it, a tool when a role needs it.
 *
 * What is here is only what a company cannot do without. The CEO is a role
 * like any other -- it is hired, held to its tools and its ceilings -- and it
 * routes: work that no one was named for arrives with it, and it hands it to
 * the role whose job it is, once there is one. Until there is, it does the
 * work itself as far as its own tools reach and says what is missing, so that
 * the owner learns what to hire from work that was really asked for.
 *
 * `work.ts` holds what every role of every team is built from.
 */
import { saveTemplate, type CompanyTemplate } from './company.ts';
import { PLATFORM_TOOLS, WORK_INPUT, WORK_OUTPUT } from './work.ts';

export const FOUNDING_TEMPLATE_SLUG = 'founding-company';

/**
 * What the company is for until its owner says: the statement the console
 * replaces with the owner's own words (`mission` when it is started). Kept as
 * the sentence the dictionaries already carry, so that a company started
 * without one still reads it in the owner's language.
 */
export const DEFAULT_MISSION = 'Deliver what this company sells, reliably and without surprising its owner.';

/**
 * What the CEO may do beyond the platform's tools: hand work on and wait for
 * it, look again later, propose a schedule, keep the backlog, and write a
 * draft. Twelve with them, the most a role may hold (F2.6).
 */
const CEO_TOOLS = [
  ...PLATFORM_TOOLS, 'task.delegate', 'task.await', 'schedule.propose', 'ticket.create', 'ticket.list', 'task.follow_up', 'doc.draft',
] as const;

export const FOUNDING_TEMPLATE: CompanyTemplate = {
  projects: [{ slug: 'main', name: 'Main' }],

  goals: [{ slug: 'mission', kind: 'mission', statement: DEFAULT_MISSION }],

  divisions: [{ slug: 'management', name: 'Management', maxConcurrency: 4 }],

  grants: [
    // The division holds the CEO's tools, and the reading a role hired into it
    // may be given: what the owner trades in on Team needs no new grant.
    ...CEO_TOOLS.map((capability) => ({ division: 'management', capability })),
    { division: 'management', capability: 'web.fetch' },
    { division: 'management', capability: 'web.search' },
    { division: 'management', capability: 'web.extract' },
    { division: 'management', capability: 'files.list' },
    { division: 'management', capability: 'files.read' },
  ],

  roles: [
    {
      slug: 'coordinator',
      displayName: 'Arka',
      title: 'CEO',
      division: 'management',
      model: 'standard',
      maxTokensPerRun: 60_000,
      doneCriteria: [
        'the owner can read what was done and what comes next',
        'work that another role is for was handed to it rather than attempted',
      ],
      systemPrompt:
        'You are the CEO: you run this company for its owner. Work arrives with you when the owner did not ' +
        'say whose it is. When a role exists whose job it is -- the roles you can hand work to are listed in ' +
        'your brief whenever there are any -- route it: hand it over with task.delegate and a brief that says ' +
        'what done looks like, wait for the result with task.await, and report what came back. When there is no ' +
        'such role, do the work yourself as far as your own tools reach: read, research, and write a draft with ' +
        'doc.draft. When the work needs a skill the company does not have yet -- a bookkeeper, a marketer, someone ' +
        'for customers -- say so in your report, and file a ticket for it with ticket.create that begins "Hire:" ' +
        'and says which role and what work it would take over, so that the owner, who builds the team with you in ' +
        'conversation, sees what is missing from work that was really asked for. The other roles file what is ' +
        'owed and not yet anyone\'s as tickets: read them with ticket.list, and hand one on with task.delegate ' +
        'and its ticketId, so it closes when the work is done. When an action\'s effect lands later -- an invoice ' +
        'sent, a campaign launched -- ask to look again with task.follow_up: name the role, what to check it ' +
        'against and what to do about what it finds, and do not wait on it. When the same work is owed again and ' +
        'again, propose a schedule for it with schedule.propose -- which role, when, what each run does, and the ' +
        'evidence -- rather than waiting to be asked each time; the owner\'s yes makes it. When a division ' +
        'escalates something to you, fix the cause or hand it to the role that can; you cannot decide for the ' +
        'owner. You do not contact anyone outside the company and you do not ship anything.',
      tools: [...CEO_TOOLS],
      inputSchema: WORK_INPUT,
      outputSchema: WORK_OUTPUT,
    },
  ],

  sops: [
    {
      division: 'management',
      body:
        'Hand work on with a brief that says what done looks like; a brief that only says what to do is one the ' +
        'next role will read three ways. When the company has no role for the work, say which role it needs and ' +
        'why, rather than doing something lesser and calling it done.',
    },
  ],

  budget: {
    // The same ceilings as any company's: the monthly money limit in
    // `spend_limits` is what paces it, and these are containment.
    tokensMax: 100_000_000,
    moneyMaxCents: 240_000,
    divisions: [{ division: 'management', tokensMax: 60_000_000, moneyMaxCents: 144_000 }],
  },
};

/**
 * Stores the founding template, so a company can be started from it. In code
 * rather than in a migration so that it is reviewed as code and can be stored
 * again after an edit; `saveTemplate` upserts on the slug.
 */
export async function installFoundingTemplate(): Promise<void> {
  await saveTemplate({
    slug: FOUNDING_TEMPLATE_SLUG,
    name: 'Founding company',
    description: 'A CEO and nothing else: the team is built as it is needed.',
    body: FOUNDING_TEMPLATE,
  });
}
