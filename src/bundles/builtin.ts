/**
 * The bundles that ship with v1 (PRD v2 F16.5).
 *
 * `content-ops`, `web-ops`, `qa-review`, `palugada-dev` -- PALUGADA's own
 * engineering team -- and `company-os`, the operating kit. They are deliberately narrow: a
 * bundle that tried to be a whole company would be a template, and the point
 * of a bundle is that a company can be assembled from several.
 *
 * The tiers are the interesting part. `web-ops` holds DNS and deployment, which
 * §8.8 puts at tier 2 and 3, so it grants nothing above what the catalogue
 * already calibrated -- a bundle cannot make an irreversible action reversible
 * by declaring a lower tier, because F8.3's trigger refuses a grant that
 * loosens one. What a bundle *can* do is tighten, and `web-ops` does: its
 * writer holds `dns.update` at the catalogued tier and its reviewer holds
 * nothing that writes at all.
 *
 * Each bundle ships its skills with their eval cases, because F15.4 refuses to
 * activate a skill that has none -- a bundle whose skills could never be turned
 * on would be a bundle that quietly did nothing.
 */
import type { Bundle } from './bundle.ts';
import { VERDICT_OUTPUT } from '../review/verdict.ts';

const WORK_INPUT = {
  type: 'object',
  additionalProperties: true,
  required: ['goal'],
  properties: { goal: { type: 'string', minLength: 1 }, context: { type: 'string' } },
};

const WORK_OUTPUT = {
  type: 'object',
  additionalProperties: true,
  required: ['summary'],
  properties: {
    summary: { type: 'string', minLength: 1 },
    artefacts: { type: 'array', items: { type: 'string' } },
  },
};

function role(input: {
  slug: string;
  /**
   * Who the role is, as the template's roles are: a name and a title. The
   * owner chose roles from pickers that listed "strategist" and "critic"
   * beside "Arka · CEO" (the analysis of 3 October, §2.3 item 10).
   */
  name: string;
  title: string;
  division: string;
  prompt: string;
  tools: string[];
  doneCriteria: string[];
  outputSchema?: Record<string, unknown>;
}) {
  return {
    slug: input.slug,
    displayName: input.name,
    title: input.title,
    division: input.division,
    systemPrompt: input.prompt,
    // A tier, which the deployment turns into its own model (F13.6). A model
    // named here was sent as written to whatever provider the deployment
    // speaks, and every bundle role failed on anything but Anthropic's.
    model: 'standard',
    tools: input.tools,
    inputSchema: WORK_INPUT,
    outputSchema: input.outputSchema ?? WORK_OUTPUT,
    maxTokensPerRun: 40_000,
    doneCriteria: input.doneCriteria,
  };
}

export const CONTENT_OPS: Bundle = {
  slug: 'content-ops',
  version: '1.3.0',
  name: 'Content operations',
  description: 'Researches, drafts and publishes written material.',
  body: {
    divisions: [{ slug: 'content', name: 'Content', maxConcurrency: 4 }],
    roles: [
      role({
        slug: 'researcher',
        name: 'Putri',
        title: 'Researcher',
        division: 'content',
        prompt:
          'You gather what is known about a subject and say plainly what you could not ' +
          'establish. An unverified claim reported as a fact is worse than a gap reported ' +
          'as a gap.',
        tools: ['web.fetch', 'memory.search', 'skill.read'],
        doneCriteria: [
          'every claim in the summary names where it came from',
          'anything that could not be established is listed as an open question',
        ],
      }),
      role({
        slug: 'writer',
        name: 'Gilang',
        title: 'Writer',
        division: 'content',
        prompt:
          'You turn research into a draft. You do not publish; a different role reviews ' +
          'first, and publication is the owner\'s call.',
        tools: ['doc.draft', 'memory.search', 'skill.read'],
        doneCriteria: [
          'the draft covers every point in the brief',
          'the draft cites the research it came from',
        ],
      }),
    ],
    grants: [
      { division: 'content', capability: 'web.fetch' },
      { division: 'content', capability: 'memory.search' },
      { division: 'content', capability: 'skill.read' },
      { division: 'content', capability: 'doc.draft' },
    ],
    policies: [
      {
        slug: 'content-external-publish-needs-review',
        scope: 'division',
        division: 'content',
        condition: {
          any: [
            { field: 'tool', op: 'eq', value: 'social.publish' },
            { field: 'tool', op: 'eq', value: 'email.send' },
          ],
        },
        effect: 'require_review',
        params: {
          reviewer_role: 'qa-reviewer',
          criteria:
            'Is every factual claim supported by the research cited? Would this embarrass ' +
            'the company if it were wrong?',
        },
      },
    ],
    skills: [
      {
        slug: 'sourcing',
        scope: 'division',
        division: 'content',
        source: `---
name: sourcing
description: How to cite a claim so a reviewer can check it without repeating the research.
---

# Sourcing

Every factual claim carries the URL or document it came from, inline.

A claim you could not verify is written as an open question, never softened
into a hedge. "Reportedly" and "it seems" are how an unverified claim gets
published.

Prefer a primary source. A secondary source that summarises one is a place to
find the primary source, not a substitute for it.
`,
        evals: [
          {
            name: 'names the open-question rule',
            input: { claim: 'a number nobody could confirm' },
            expectContains: ['open question', 'never softened'],
          },
        ],
      },
    ],
    hooks: [
      {
        name: 'content.no-silent-send',
        on: 'pre_tool',
        division: 'content',
        refuseCapability: 'email.send',
        refuseAtOrAboveTier: 2,
        reason:
          'Content may draft an outbound message but may not send one. Sending belongs to ' +
          'the division that owns the relationship.',
      },
    ],
    schedules: [
      { roleSlug: 'researcher', heartbeatMinutes: 240 },
      { roleSlug: 'writer', heartbeatMinutes: 240 },
    ],
  },
};

export const WEB_OPS: Bundle = {
  slug: 'web-ops',
  version: '1.3.0',
  name: 'Web operations',
  description: 'Hosting, domains and deployment, with the tiers the catalogue calibrated.',
  body: {
    divisions: [{ slug: 'web', name: 'Web operations', maxConcurrency: 2 }],
    roles: [
      role({
        slug: 'web-operator',
        name: 'Wulan',
        title: 'Web Operator',
        division: 'web',
        prompt:
          'You change hosting and DNS. Every change is planned before it is made and read ' +
          'back after. A change that reports success and reads back differently is an ' +
          'incident, not a retry.',
        tools: ['dns.read', 'dns.update', 'uptime.check', 'memory.search', 'skill.read'],
        doneCriteria: [
          'the change was read back and matches what was asked for',
          'the rollback is written down before the change is made',
        ],
      }),
    ],
    grants: [
      { division: 'web', capability: 'dns.read' },
      { division: 'web', capability: 'uptime.check' },
      { division: 'web', capability: 'memory.search' },
      { division: 'web', capability: 'skill.read' },
      // No tier override: the catalogue's calibration stands, and F8.3 refuses
      // a grant that would loosen it anyway.
      { division: 'web', capability: 'dns.update', rateLimitPerHour: 5 },
    ],
    policies: [
      {
        slug: 'web-dns-always-owner',
        scope: 'division',
        division: 'web',
        condition: {
          all: [
            { field: 'tool', op: 'eq', value: 'dns.update' },
            { field: 'tier', op: 'gte', value: 3 },
          ],
        },
        effect: 'require_approval',
      },
    ],
    skills: [
      {
        slug: 'dns-change',
        scope: 'division',
        division: 'web',
        source: `---
name: dns-change
description: How to make a DNS change you can undo.
---

# DNS changes

Write down the current record before you change it. That sentence is the
rollback, and a change without one is a change nobody can reverse at 3am.

Lower the TTL first and wait for the old one to expire. A change made under a
24-hour TTL is a change that takes a day to undo.

Read the record back after the change. A provider that returns 200 has accepted
the request, not applied it.
`,
        evals: [
          {
            name: 'names the rollback and the read-back',
            input: { change: 'point the apex at a new host' },
            expectContains: ['rollback', 'Read the record back', 'TTL'],
          },
        ],
      },
    ],
    hooks: [
      {
        name: 'web.no-code-execution',
        on: 'pre_tool',
        division: 'web',
        refuseCapability: 'code.execute',
        reason:
          'Web operations holds credentials, so it must not also run supplied code. The ' +
          'sandbox does not isolate the network (F8.10).',
      },
    ],
    schedules: [{ roleSlug: 'web-operator', heartbeatMinutes: 120 }],
  },
};

export const QA_REVIEW: Bundle = {
  slug: 'qa-review',
  version: '1.3.0',
  name: 'Adversarial review',
  description: 'The reviewer role F7 needs, holding nothing that writes.',
  body: {
    divisions: [{ slug: 'review', name: 'Review', maxConcurrency: 4 }],
    roles: [
      role({
        slug: 'qa-reviewer',
        name: 'Yoga',
        title: 'Quality Reviewer',
        division: 'review',
        prompt:
          'You judge a proposal against the criteria you were given and nothing else. ' +
          'Your job is to find what is wrong with it; approving something you have not ' +
          'checked is the only way to fail at this.',
        tools: ['memory.search', 'skill.read'],
        doneCriteria: [
          'the verdict names the criterion each finding relates to',
          'an approval says what was checked, not that it looked fine',
        ],
        outputSchema: VERDICT_OUTPUT,
      }),
    ],
    // Read-only, on purpose. F7.3 keeps a reviewer from being the proposer; a
    // reviewer that could act would be able to do the thing it just refused.
    grants: [
      { division: 'review', capability: 'memory.search' },
      { division: 'review', capability: 'skill.read' },
    ],
    policies: [],
    skills: [
      {
        slug: 'reviewing',
        scope: 'division',
        division: 'review',
        source: `---
name: reviewing
description: How to review a proposal so the verdict is worth something.
---

# Reviewing

Read the criteria first, then the proposal. Reading them the other way round
is how a reviewer ends up justifying a decision they already made.

Say which criterion each finding relates to. A finding with no criterion is an
opinion, and the proposer cannot act on it.

Approving is a claim that you checked. "It looks fine" is not a review.
`,
        evals: [
          {
            name: 'names the criteria-first rule',
            input: { proposal: 'anything' },
            expectContains: ['Read the criteria first', 'which criterion'],
          },
        ],
      },
    ],
    hooks: [
      {
        name: 'review.read-only',
        on: 'pre_tool',
        division: 'review',
        refuseAtOrAboveTier: 1,
        reason:
          'A reviewer that could act would be able to do the thing it just refused. Review ' +
          'holds nothing that writes (F7.3).',
      },
    ],
    schedules: [{ roleSlug: 'qa-reviewer', heartbeatMinutes: 240 }],
  },
};

/**
 * PALUGADA developing PALUGADA.
 *
 * A platform engineer that works on this repository through `repo.read` and
 * `repo.branch`, and a reviewer that holds nothing that writes. The engineer's
 * skill is the procedure in `AGENTS.md` -- the same one a person or any other
 * coding agent follows -- so the platform's knowledge of itself lives in one
 * place, read by everyone who changes it, and `test/documents/
 * self-knowledge.test.ts` keeps that place true.
 *
 * Pushing a branch is reversible (the catalogue puts `repo.branch` at tier 1),
 * but a change to a control plane is the change most worth a second reader,
 * so every push waits for the reviewer first. Merging is not a capability here
 * at all: it stays the owner's, on the pull request.
 */
export const PALUGADA_DEV: Bundle = {
  slug: 'palugada-dev',
  version: '1.4.0',
  name: 'Develop PALUGADA',
  description: 'A platform engineer and a reviewer that change PALUGADA itself, by pull request.',
  body: {
    divisions: [
      { slug: 'platform', name: 'Platform engineering', maxConcurrency: 2 },
      { slug: 'platform-review', name: 'Platform review', maxConcurrency: 2 },
    ],
    roles: [
      role({
        slug: 'platform-engineer',
        name: 'Adit',
        title: 'Platform Engineer',
        division: 'platform',
        prompt:
          'You change PALUGADA, the platform you are running on. Read AGENTS.md at the root of ' +
          'the repository before anything else and follow its loop: find what the change is for, ' +
          'write the test that fails without it, make the change, run npm run check, and push a ' +
          'branch with a pull request that says what changed and why. Never edit a migration that ' +
          'has been pushed. You do not merge; the owner does.',
        tools: ['repo.read', 'repo.branch', 'memory.search', 'skill.read'],
        doneCriteria: [
          'the pull request names the requirement or defect it is for',
          'it adds a test that fails without the change',
          'npm run check passed on the pushed branch',
        ],
      }),
      role({
        slug: 'platform-reviewer',
        name: 'Rina',
        title: 'Platform Reviewer',
        division: 'platform-review',
        prompt:
          'You review a change to PALUGADA before its branch is pushed. Read AGENTS.md, then the ' +
          'change, and check it against the rules the suite enforces and the ones it cannot: is the ' +
          'test real, does the change stay inside what the test needs, is a pushed migration ' +
          'untouched. Refuse what you have not checked.',
        tools: ['repo.read', 'memory.search', 'skill.read'],
        doneCriteria: [
          'the verdict names the rule each finding relates to',
          'an approval says what was checked',
        ],
        outputSchema: VERDICT_OUTPUT,
      }),
    ],
    grants: [
      { division: 'platform', capability: 'repo.read' },
      { division: 'platform', capability: 'repo.branch' },
      { division: 'platform', capability: 'memory.search' },
      { division: 'platform', capability: 'skill.read' },
      { division: 'platform-review', capability: 'repo.read' },
      { division: 'platform-review', capability: 'memory.search' },
      { division: 'platform-review', capability: 'skill.read' },
    ],
    policies: [
      {
        slug: 'palugada-dev-push-is-reviewed',
        scope: 'division',
        division: 'platform',
        condition: { field: 'tool', op: 'eq', value: 'repo.branch' },
        effect: 'require_review',
        params: {
          reviewer_role: 'platform-reviewer',
          criteria:
            'Does the change add a test that fails without it? Does it leave every pushed ' +
            'migration untouched? Did npm run check pass? Is it only what the task asked for?',
        },
      },
    ],
    skills: [
      {
        slug: 'changing-palugada',
        scope: 'division',
        division: 'platform',
        source: `---
name: changing-palugada
description: How to change PALUGADA itself so the change is safe to merge.
---

# Changing PALUGADA

AGENTS.md at the root of the repository is the whole procedure. Read it first,
every time: it is kept true by a test, and your memory of it is not.

The loop is: find what the change is for, write the test that fails without
it, make the change, run \`npm run check\`, read the Postgres log, and push a
branch with a pull request.

Never edit a migration that has been pushed; add the next number.

Every sentence the console shows goes through t() and needs its Indonesian in
console/src/locales/id.ts.

You do not merge. The owner does.
`,
        evals: [
          {
            name: 'names the procedure and its non-negotiables',
            input: { task: 'add a column to tasks' },
            expectContains: ['AGENTS.md', 'npm run check', 'Never edit a migration', 'You do not merge'],
          },
        ],
      },
      {
        slug: 'reviewing-palugada',
        scope: 'division',
        division: 'platform-review',
        source: `---
name: reviewing-palugada
description: How to review a change to PALUGADA before it is pushed.
---

# Reviewing a change to PALUGADA

Read AGENTS.md first, then the change. The rules the suite enforces are
listed there; check the ones it cannot.

Ask whether the test fails without the change. A test written after the code
often passes with or without it.

Refuse a change that edits a pushed migration, whatever it fixes.

Approving is a claim that you checked. Say what you checked.
`,
        evals: [
          {
            name: 'names the review rules',
            input: { change: 'a new route' },
            expectContains: ['AGENTS.md', 'fails without the change', 'pushed migration'],
          },
        ],
      },
    ],
    hooks: [
      {
        name: 'platform-review.read-only',
        on: 'pre_tool',
        division: 'platform-review',
        refuseAtOrAboveTier: 1,
        reason: 'The reviewer of a change must not be able to make one (F7.3).',
      },
    ],
    schedules: [
      { roleSlug: 'platform-engineer', heartbeatMinutes: 240 },
      { roleSlug: 'platform-reviewer', heartbeatMinutes: 240 },
    ],
  },
};

/**
 * `company-os`: how a company decides what to do, as knowledge rather than
 * machinery.
 *
 * The rest of the platform keeps a company safe -- tiers, reviews, budgets --
 * and none of it makes the company any good. auto-company's value is mostly in
 * its operating frameworks: validate an idea before building it, run a
 * premortem, price on value, read the unit economics, review the week against
 * the numbers. Those arrive here as skills, which is the platform's channel
 * for knowledge that is not enforcement: a run sees each one's summary and
 * opens the whole with `skill.read`, and each one goes through review and the
 * owner before any agent reads it (F15.3).
 *
 * With them comes a strategist: the role nobody else is, which reads the
 * goals, their numbers and last week's work, and proposes at most three bets
 * -- never applies them. And the one cadence every company needs: the weekly
 * business review, Monday morning in the company's time zone.
 *
 * And the stage gates (0057): the strategist proposes a move with the evidence
 * the stage-gates skill names, the owner decides, and three rules read the
 * stage -- no paid reach before launch, nothing new once the company is
 * winding down, and every other outward action while it winds down put to
 * the owner, who decides what is still owed.
 *
 * And a critic (1.4.0). auto-company asks for a premortem before any GO, from
 * the same model session that wants the GO, and nothing makes it happen. Here
 * every stage proposal is reviewed by a role of its own before the owner is
 * asked: a policy puts `stage.propose` behind its review, it sits in a
 * division of its own so it works under its own grants rather than the
 * strategist's, and it holds reads and nothing else. What it says reaches
 * the owner either way -- on the proposal when it supports it, on an item of
 * its own when it stops it.
 *
 * Written for this platform rather than copied: each skill is short, says what
 * a run must do rather than what an expert believes, and has an eval naming the
 * sentence that must not be lost.
 */
export const COMPANY_OS: Bundle = {
  slug: 'company-os',
  version: '1.5.0',
  name: 'Company operating kit',
  description:
    'A strategist, a critic who reviews every stage move before the owner does, a weekly business ' +
    'review handed the week\'s numbers, stage gates, and the operating skills a company decides with: ' +
    'validating an idea, premortems, pricing, unit economics, customer discovery, positioning, market ' +
    'research, launch readiness, outbound rules and the weekly review.',
  body: {
    divisions: [
      { slug: 'strategy', name: 'Strategy', maxConcurrency: 1 },
      // Its own division, because a review runs in the reviewer's division
      // and under its grants: a critic in Strategy would hold stage.propose.
      { slug: 'strategy-review', name: 'Strategy review', maxConcurrency: 1 },
    ],
    roles: [
      role({
        slug: 'strategist',
        name: 'Bayu',
        title: 'Chief Strategy Officer',
        division: 'strategy',
        prompt:
          'You decide what the company should do next and whether what it is doing is working. ' +
          'Read the goals, their numbers and what was done since the last review. Propose at most ' +
          'three bets, each with the customer it is for, the evidence and how sure you are ' +
          '(confirmed, likely or speculative), what it costs, the number it should move and the ' +
          'result that would make you stop. You propose; you never change a goal, a budget or a ' +
          'grant. When another role holds a number you need, delegate the question with ' +
          'task.delegate and read the answer with task.await. When only the owner can answer ' +
          'something, ask them with owner.ask rather than guessing. When the evidence says the ' +
          'company should move to another stage -- or back -- propose it with stage.propose, ' +
          'following the stage-gates skill. When the evidence says a goal is wrong -- a target ' +
          'nobody can reach, a goal that no longer serves the company, one met or not worth ' +
          'pursuing -- propose the change with goal.propose, naming the goal by its slug. ' +
          'Write for the owner in the company\'s language, briefly.',
        // Twelve, the most a role may hold (F2.6). `metrics.read` made way
        // for `goal.propose`: it needs a vendor bound before it answers
        // anything, and the weekly review's brief already carries every
        // metric, read from the company's own records.
        tools: [
          'memory.search', 'skill.read', 'plan.record', 'metric.record', 'owner.ask',
          'task.delegate', 'task.await', 'stage.propose', 'goal.propose', 'ledger.read', 'web.fetch', 'doc.draft',
        ],
        doneCriteria: [
          'every claim names where it came from and how sure it is: confirmed, likely or speculative',
          'each bet has the number it should move, a target and a date, and the result that would stop it',
          'a change to a goal is proposed to the owner with goal.propose, never applied',
        ],
      }),
      role({
        slug: 'critic',
        name: 'Citra',
        title: 'Strategy Critic',
        division: 'strategy-review',
        prompt:
          'You challenge a proposal to move the company\'s stage before the owner sees it. Assume it ' +
          'failed six months from now and ask how. Give your verdict in one line first: support, oppose ' +
          'or need more. For each risk, write the concrete way it would kill the company. If you support ' +
          'it, say why despite those risks. Answer with "decision": "approve" to support, "reject" to ' +
          'oppose or "revise" to need more, and "reason": your verdict line and the risks, written for ' +
          'the owner in the company\'s language.',
        tools: ['memory.search', 'skill.read', 'metrics.read', 'ledger.read'],
        doneCriteria: [
          'the reason opens with the verdict in one line: support, oppose or need more',
          'each risk says the concrete way it would kill the company',
          'every question in the criteria is answered, and one without an answer is named',
        ],
        outputSchema: VERDICT_OUTPUT,
      }),
    ],
    grants: [
      { division: 'strategy', capability: 'memory.search' },
      { division: 'strategy', capability: 'skill.read' },
      { division: 'strategy', capability: 'plan.record' },
      { division: 'strategy', capability: 'metric.record' },
      { division: 'strategy', capability: 'owner.ask' },
      // To send a question to the role that can answer it -- the analyst for
      // a number, the bookkeeper for the ledger -- rather than guessing.
      { division: 'strategy', capability: 'task.delegate' },
      { division: 'strategy', capability: 'task.await' },
      // To ask the owner for the GO or NO-GO, which only they give (0057).
      { division: 'strategy', capability: 'stage.propose' },
      // To ask the owner to change a goal, which only they do (F3.10).
      { division: 'strategy', capability: 'goal.propose' },
      { division: 'strategy', capability: 'ledger.read' },
      { division: 'strategy', capability: 'web.fetch' },
      { division: 'strategy', capability: 'doc.draft' },
      // The critic reads, to check a proposal's evidence against the company's
      // own numbers and money, and does nothing else: every one is tier 0.
      { division: 'strategy-review', capability: 'memory.search' },
      { division: 'strategy-review', capability: 'skill.read' },
      { division: 'strategy-review', capability: 'metrics.read' },
      { division: 'strategy-review', capability: 'ledger.read' },
    ],
    // The stage gates (0057), as rules. Company-wide, because paid reach and
    // new work are the company's to hold back, whichever division reaches for
    // them. A company with no stage set has proved nothing a stage policy
    // allows, so it is held back too.
    policies: [
      {
        // Company-wide, so whichever role proposes a move -- the strategist,
        // or any the owner later gives stage.propose -- the critic reads it
        // before the owner is asked.
        slug: 'stage-move-needs-the-critic',
        scope: 'company',
        condition: { field: 'tool', op: 'eq', value: 'stage.propose' },
        effect: 'require_review',
        params: {
          reviewer_role: 'critic',
          criteria:
            'Is willingness to pay shown by money or a signed commitment, not interest? Does each piece of ' +
            'evidence say where it came from? Are the three likeliest failures named, each with an early ' +
            'warning? What stops a competitor copying this in two weeks? If any answer is missing, reject ' +
            'and name it.',
        },
      },
      {
        slug: 'no-paid-reach-before-launch',
        scope: 'company',
        condition: {
          all: [
            { field: 'tool', op: 'matches', value: 'ads.*' },
            { not: { field: 'stage', op: 'in', value: ['launch', 'grow'] } },
          ],
        },
        effect: 'deny',
      },
      {
        // Winding down starts nothing: no paid reach and nothing bought,
        // whoever asks. These are new work by what they are, so no answer
        // from the owner could make one part of finishing what is owed.
        slug: 'wind-down-starts-nothing',
        scope: 'company',
        condition: {
          all: [
            { field: 'stage', op: 'eq', value: 'wind_down' },
            { any: [
              { field: 'tool', op: 'matches', value: 'ads.*' },
              { field: 'tool', op: 'matches', value: '*.purchase' },
            ] },
          ],
        },
        effect: 'deny',
      },
      {
        // And what is owed to customers is finished, which the owner judges
        // one action at a time. This was a deny over every tier 2 action
        // outside finance, so Support could not answer a customer owed a
        // refund, and a deny is the one effect the owner cannot answer from
        // the inbox. A tool name cannot tell a reply to a customer from new
        // outreach -- both are `email.send` -- and a division's slug differs
        // from company to company, so the owner is asked instead. Where the
        // work read nothing from outside, they may say yes to a role's
        // replies for a while (0083) rather than card by card. Finance still
        // pays and invoices what is owed without asking.
        slug: 'wind-down-asks-first',
        scope: 'company',
        condition: {
          all: [
            { field: 'stage', op: 'eq', value: 'wind_down' },
            { field: 'tier', op: 'gte', value: 2 },
            { not: { field: 'division', op: 'eq', value: 'finance' } },
          ],
        },
        effect: 'require_approval',
      },
    ],
    skills: [
      {
        slug: 'idea-validation',
        scope: 'company',
        source: `---
name: idea-validation
description: Whether an idea is worth building, answered with evidence before anything is built.
---

# Validating an idea

Before anything is built, answer four questions and write the evidence next to
each one:

1. Is the problem real? Name people who have it and what it costs them now.
2. Will they pay? Evidence of willingness to pay is money or a signed
   commitment. Interest is not evidence; "I would use that" is not payment.
3. Can a first version be built in two weeks with what the company has?
4. Can the company reach these people through a channel it already has?

A "no" or "unknown" on the first two ends the idea for now: say "No market
yet" and what would change your mind. Otherwise write the next experiment:
the cheapest test that could prove the idea wrong, what result would count,
and by when.

Record the problem, the willingness-to-pay evidence and the next experiment in
memory, so the next run does not start again from nothing.
`,
        evals: [
          {
            name: 'separates interest from payment',
            input: { idea: 'a tool people say they would love' },
            expectContains: ['willingness to pay', 'next experiment', 'No market'],
          },
        ],
      },
      {
        slug: 'premortem',
        scope: 'company',
        source: `---
name: premortem
description: Imagine the plan has already failed, find out why before spending on it, and say who watches for each way it could.
---

# Premortem

Before a launch, a large spend or anything that cannot be undone, assume it is
six months from now and the plan has already failed. Write the story of how.

1. List every plausible cause of the failure: the market, the product, the
   money, the people, the law, a supplier, timing.
2. Rank them by likelihood times damage and keep the top 3.
3. For each of the top 3, write:
   - an early warning: the first observable sign it is happening;
   - which role watches it, by the role's name in this company;
   - which number or check it reads -- a goal metric, a ledger figure, a
     count of support messages, a test -- and the value that means act now;
   - what the company will do when it sees it.
4. If one of them has no early warning and would be fatal, stop and tell the
   owner before going on.

End with how sure the company now is that the plan will work -- confirmed,
likely or speculative -- and what would make it surer: the cheapest test, or
the one number that would change your mind.

A premortem that finds nothing was not done. There is always a way to fail.
`,
        evals: [
          {
            name: 'names the three causes with warnings',
            input: { plan: 'launch a paid newsletter' },
            expectContains: ['already failed', 'top 3', 'early warning'],
          },
          {
            name: 'gives every warning a watcher and a number, and ends with how sure',
            input: { plan: 'open a second warehouse' },
            expectContains: ['which role watches it', 'which number or check', 'how sure the company now is'],
          },
        ],
      },
      {
        slug: 'pricing',
        scope: 'company',
        source: `---
name: pricing
description: How to set and change a price: value, not cost; tested, not guessed.
---

# Pricing

Price on the value to the customer, not on the company's cost. Find the
value metric -- the unit the customer gets more value from as they use more of
it (seats, orders, messages) -- and charge along it.

Do not ask customers what they would pay; people answer that question badly.
Use a Van Westendorp survey (too cheap, a bargain, getting expensive, too
expensive) or, better, real offers at different prices.

A first price is usually 20-50% of what the customer's current alternative
costs them. Signs the price is too low: nobody pushes back, conversion is
high and churn is low.

When raising a price, grandfather existing customers for a stated period, say
so plainly, and never change a price without the owner's approval: a price
change is a proposal, not an action.
`,
        evals: [
          {
            name: 'names value metric and grandfathering',
            input: { question: 'should we raise the price?' },
            expectContains: ['value metric', 'Van Westendorp', 'grandfather'],
          },
        ],
      },
      {
        slug: 'unit-economics',
        scope: 'company',
        source: `---
name: unit-economics
description: Whether each customer makes the company money, and how to say so honestly.
---

# Unit economics

Report these, each with where the number came from:

- CAC: what it cost to win one customer, all channels.
- LTV: margin per customer per month times expected months.
- LTV:CAC -- healthy above 3.
- Payback: months to earn back the CAC -- healthy under 12.
- Gross margin -- software should be above 70%.
- Ramen profitability: monthly recurring revenue above fixed monthly costs.

Label every figure as measured or as an estimate. An estimate presented as a
measurement is the most expensive mistake in a financial report, because every
decision after it inherits the error. When a figure comes from the ledger,
record it with metric.record so it is verified.
`,
        evals: [
          {
            name: 'labels estimates',
            input: { question: 'are we profitable per customer?' },
            expectContains: ['LTV:CAC', 'Payback', 'estimate'],
          },
        ],
      },
      {
        slug: 'customer-discovery',
        scope: 'company',
        source: `---
name: customer-discovery
description: Finding out what customers need by talking to them and reading what they say.
---

# Customer discovery

The first ten customers are found by hand, one at a time. Do not wait for a
channel to scale before anyone has asked for the product.

When reading feedback -- support messages, reviews, interviews -- classify
each item as exactly one of: bug, feature request, confusion, praise. Count
them. Confusion is a design problem, not a documentation one.

Look for the same need said three different ways by different people before
calling it a pattern, and triangulate: what people say, what they do in the
product, and what they pay for. When the three disagree, what they pay for
wins.

Write findings with the customer's own words quoted, and without their name
unless they agreed to be named.
`,
        evals: [
          {
            name: 'classifies feedback',
            input: { feedback: 'I could not find the export button' },
            expectContains: ['bug, feature request, confusion, praise', 'triangulate'],
          },
        ],
      },
      {
        slug: 'positioning',
        scope: 'company',
        source: `---
name: positioning
description: Who the product is for, what changes for them, and why one would tell another -- before paying for reach.
---

# Positioning

Name who this is for as narrowly as the evidence allows: the people who have
the problem worst and already spend time or money coping with it, not "small
businesses" or "everyone". Widen it only when the evidence does.

Say what changes for them, in their words: quote what customers said, not
what the company wishes they had said. A feature is not a change; "I stopped
losing orders on Fridays" is.

Say why one would tell another. If nobody would,
fix the product before paying for reach: advertising a product nobody
recommends buys customers who leave, and teaches the company nothing it could
not have learned for free.

Build reach you own before reach you rent. Owned reach -- people who asked to
hear from the company, a community it belongs to, pages people find when they
search -- keeps working. Rented reach -- ads, paid placements -- stops the day
the payments do, and the stage rules hold it back until launch.

Write the positioning as one paragraph: who, the change in their words, why
they would tell someone, and the evidence for each, labelled confirmed, likely
or speculative.
`,
        evals: [
          {
            name: 'narrows the audience and owns its reach',
            input: { product: 'a tool for everyone' },
            expectContains: [
              'as narrowly as the evidence allows', 'in their words',
              'fix the product before paying for reach', 'reach you own before reach you rent',
            ],
          },
        ],
      },
      {
        slug: 'market-research',
        scope: 'company',
        source: `---
name: market-research
description: How customers cope today, what competitors really offer, and how sure each finding is.
---

# Market research

Start with how customers cope today, before competitors: a spreadsheet, a
relative who does it for them, a tool they complain about, or nothing at all.
What they already use is the real competitor, and what it costs them is the
ceiling on the price.

Then, for each competitor, read the
pricing page, the changelog and the worst reviews:

- the pricing page says who they sell to and what they charge along;
- the changelog says what they are building, and how fast;
- the worst reviews say what their customers cannot get from them.

Label every claim confirmed, likely or speculative, and say where it came
from. A competitor's marketing is their claim, not a fact about them.

End with what you could not find out and how the company could: a question
to ask five customers, something to buy and try, a number to ask for. Record
what was found in memory, so the next run does not start again from nothing.
`,
        evals: [
          {
            name: 'starts from how customers cope and labels its claims',
            input: { market: 'invoicing for cafes' },
            expectContains: [
              'how customers cope today, before competitors', 'pricing page, the changelog and the worst reviews',
              'confirmed, likely or speculative', 'what you could not find out',
            ],
          },
        ],
      },
      {
        slug: 'launch-readiness',
        scope: 'company',
        source: `---
name: launch-readiness
description: What must be true before something goes in front of customers.
---

# Launch readiness

Before a launch, check each of these and write the result next to it:

- Payment works end to end with a real card, including a refund.
- Sign-up, sign-in and password reset work from a clean browser.
- The obvious attacks are closed: input is escaped, forms carry CSRF
  protection, secrets are not in the page.
- A backup exists and a restore has been tried.
- There is a rollback: how to put the previous version back, in minutes,
  written down.
- The privacy policy and terms are published, and say what is actually done
  with customer data.
- Someone is watching for errors for the first day.

A launch with an unchecked item goes to the owner with the item named. Launch
where the customers already are, and be a member of a community before posting
in it.
`,
        evals: [
          {
            name: 'covers the non-negotiables',
            input: { launch: 'the new checkout' },
            expectContains: ['rollback', 'privacy', 'Payment'],
          },
        ],
      },
      {
        slug: 'outbound-compliance',
        scope: 'company',
        source: `---
name: outbound-compliance
description: The rules every commercial message to a person outside the company follows.
---

# Outbound messages

Every commercial email or message:

- says who it is from, truthfully, with a way to reach the company;
- carries a working way to unsubscribe, and an unsubscribe is honoured at
  once and for good;
- goes only to people with a lawful basis to receive it -- consent where the
  recipient's law requires it (the EU's GDPR and ePrivacy rules, the UK's
  PECR, Indonesia's personal data protection law, UU PDP 27/2022), and never
  to a bought list;
- has a subject line that says what the message is.

When in doubt about a recipient's jurisdiction, treat it as the strictest one.
A message that breaks these is not sent, whatever the campaign.
`,
        evals: [
          {
            name: 'names unsubscribe and consent',
            input: { campaign: 'cold email to a list' },
            expectContains: ['unsubscribe', 'consent'],
          },
        ],
      },
      {
        slug: 'stage-gates',
        scope: 'company',
        source: `---
name: stage-gates
description: When the company moves from one stage to the next, and what the move must carry.
---

# Stage gates

The company is in one stage at a time: explore, validate, build, launch, grow,
or wind down. Only the owner moves it. Propose a move with stage.propose, with
the evidence, and never act as though it had moved before they approve.

- **Explore to validate:** a problem people have, named, with what it costs
  them now, heard from at least five of them.
- **Validate to build (the GO):** willingness to pay shown by money or a signed
  commitment, the idea-validation memo and a premortem. Interest is not
  evidence. A NO-GO is a result, not a failure: say it plainly.
- **Build to launch:** the launch-readiness checklist, every item checked.
- **Launch to grow:** a number the goals name moving the right way for four
  weeks, and customers who stay.
- **To wind down:** the numbers have not moved for long enough that the
  weekly review keeps saying stop. Propose it; say what is owed to customers.

Going back a stage is allowed and is often right. Propose it the same way.
Each proposal names the evidence, where each piece came from, and what result
would make the owner move the company back.
`,
        evals: [
          {
            name: 'names the GO evidence',
            input: { question: 'are we ready to build?' },
            expectContains: ['willingness to pay', 'premortem', 'NO-GO'],
          },
        ],
      },
      {
        slug: 'weekly-business-review',
        scope: 'company',
        source: `---
name: weekly-business-review
description: The weekly review of the numbers, what changed, and what to continue or stop.
---

# Weekly business review

Start from the week in the task's input (\`week\`): every active goal with its
metrics, the work finished this week, the spend against the monthly limit,
and any stage move waiting for the owner, all read from the company's
records. Where it says something was left out, say so rather than guessing.

One page, for the owner, in this order:

1. The numbers: every goal metric against its target, verified or not, and
   the change since last week. No number without its source.
2. What changed: what shipped, what was learned, what broke.
3. Continue or stop: for each piece of work in flight, one line -- continue,
   change, or stop -- and why, in terms of the numbers.
4. At most three bets for next week, each with the metric it should move.
5. Asks for the owner: only what needs them, each answerable in a sentence.

Weekly growth of 5-7% is a useful heuristic for a young company, not a rule.
Say plainly when a number is flat. A review that only reports good news is not
a review.
`,
        evals: [
          {
            name: 'has the continue-or-stop section',
            input: { week: 'a slow week' },
            expectContains: ['target', 'continue', 'stop'],
          },
        ],
      },
    ],
    hooks: [
      {
        name: 'strategy-review.read-only',
        on: 'pre_tool',
        division: 'strategy-review',
        refuseAtOrAboveTier: 1,
        reason:
          'The critic judges a proposal and holds nothing that acts: a critic that could act could do ' +
          'what it was asked to judge (F7.3). Its grants are reads, and a grant added later is refused here.',
      },
    ],
    schedules: [
      { roleSlug: 'strategist', heartbeatMinutes: 720 },
      { roleSlug: 'critic', heartbeatMinutes: 240 },
    ],
    cadences: [
      {
        slug: 'weekly-business-review',
        roleSlug: 'strategist',
        // Monday, a quarter to eight, in the company's own time zone.
        cron: '45 7 * * 1',
        goal:
          'Weekly business review: follow the weekly-business-review skill, starting from the week in ' +
          'this task\'s input -- every goal and its numbers, the work finished, the spend and what waits ' +
          'for the owner, read from the company\'s records.',
        // Without it the review saw the numbers of its own goal chain -- the
        // mission's -- and none of the week's work.
        facts: 'week',
      },
    ],
  },
};

// In the order they install: qa-review brings the reviewer content-ops names.
export const BUILT_IN_BUNDLES: readonly Bundle[] = [QA_REVIEW, CONTENT_OPS, WEB_OPS, PALUGADA_DEV, COMPANY_OS];
