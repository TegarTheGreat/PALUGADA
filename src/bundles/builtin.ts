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
  version: '1.6.0',
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
          // F18.11, F18.7: a test or a plan is new goals, which only the
          // owner makes, and its prediction counts only if it was written
          // before the work could colour it.
          'To find the channel that brings customers, run channel tests by the channel-testing ' +
          'skill. Propose each channel test, and any plan of new goals, to the owner with ' +
          'goal.propose, each with its measure and a target set before any work starts; never ' +
          'start one before the owner approves it. ' +
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
      // 1.6.0 (F18.11, F18.15): testing channels, and three documents a
      // company drafts before it spends. Each is written in PALUGADA's words
      // and names the method it follows once, in its description; the
      // method's own name is never the skill's title.
      {
        slug: 'channel-testing',
        scope: 'company',
        source: `---
name: channel-testing
description: Finding the channel that brings the company its customers, by cheap tests with a prediction written first; after the Bullseye framework in Traction by Gabriel Weinberg and Justin Mares.
---

# Channel testing

Start from a traction goal: the customers, users or revenue that would change
what the company can do next -- break even, hire, raise money -- by a date.
Its critical path is the fewest steps that reach it. Work on the first step;
a task that is not on the path is not done.

1. **Possible.** Write one strategy for every one of the 19 channels, the
   unlikely ones too, since the channel a company overlooks is often its
   best. Keep the list as a document, with doc.draft:
   (1) niche blogs its customers read; (2) publicity in newspapers,
   magazines, radio and TV; (3) unconventional publicity: a stunt, or going
   far beyond for customers; (4) search ads; (5) social and display ads;
   (6) offline ads: print, outdoor, flyers; (7) search engine optimisation;
   (8) content: the company's own writing; (9) email; (10) free tools and
   widgets built to attract customers; (11) referrals: customers bringing
   customers; (12) business development: partnerships; (13) direct sales;
   (14) affiliates paid per customer; (15) existing platforms: app stores,
   marketplaces, large networks; (16) trade shows; (17) offline events;
   (18) speaking; (19) community.
2. **Probable.** Promote about three, stopping where the excitement
   clearly drops off. To rank strategies, score each by ICE -- impact,
   confidence and ease, each 1 to 10 -- and take the average of the three
   (the ICE average, not their product), resting each score on evidence.
3. **Test cheaply.** For each one, the smallest test that answers three
   questions: what one customer costs through it, how many customers it can
   reach, and whether they are the customers the company wants now. Write
   the prediction -- the target for cost per customer and customers gained,
   and the most the test may spend -- before any work starts, and propose
   the test to the owner with goal.propose, as a learning priority under
   the traction goal. Start nothing before then: once the owner approves it,
   hand each piece of the test to the role that holds the channel's tool,
   by task.delegate. The test has no account or goal of its own: a piece
   spends from the account of the task that hands it on, is filed under
   that task's goal, and lasts a day at most. So a test is short pieces over
   about a month: record its spend and customers on its measures with
   metric.record, read them against the prediction at each weekly review,
   and stop it when it has spent what it may. Paid ads before launch are
   refused by the stage rules: test the others first.
4. **Working.** When a test meets its prediction, propose that channel as
   the core channel, a committed priority, and put the effort there. Keep
   another only where it feeds the core one: publicity that earns links for
   search, email that spreads referrals.
5. **Again.** When the core channel saturates -- each customer costs more,
   or it stops moving the traction goal -- run all five steps again with
   what the tests taught, and look at the long shots again. If no channel
   works after a few rounds, the product is losing the customers it gets:
   fix that before buying reach.

Report every test as its prediction against its result, each labelled
confirmed, likely or speculative, with where the number came from.
`,
        evals: [
          {
            name: 'names every channel and promotes about three',
            input: { goal: 'the first hundred paying customers' },
            expectContains: ['every one of the 19 channels', 'about three', 'drops off', 'critical path'],
          },
          {
            name: 'tests cheaply, with the prediction written first',
            input: { channel: 'search ads' },
            expectContains: [
              'what one customer costs', 'how many customers', 'customers the company wants now',
              'before any work starts', 'once the owner approves it', 'account of the task that hands it on',
              'a day at most', 'about a month',
            ],
          },
          {
            name: 'ranks by the ICE average and keeps one core channel',
            input: { question: 'which channel next?' },
            expectContains: ['average of the three', 'core channel', 'feeds the core one', 'saturates'],
          },
        ],
      },
      {
        slug: 'one-page-model',
        scope: 'company',
        source: `---
name: one-page-model
description: The business on one page, nine boxes with the riskiest assumption first, drafted for the owner before money is spent; adapted from Lean Canvas by Ash Maurya, CC BY-SA.
---

# One-page business model

Write down how the business is believed to work today, on one page, so the
owner can see which belief to test next. Draft it with doc.draft. It is for
the owner: doc.draft writes in the work language unless it is given a
language, so give it the language you write to the owner in when the two
differ. A box is a line or two -- fewer words, not smaller ones. Every line
is a guess until it is tested, so label each one confirmed, likely or
speculative, and say where it came from.

1. **Customers.** Who pays and who uses, where they differ, and the early
   adopters: the narrow group with the problem worst, who try new answers
   first.
2. **Problem.** Their top one to three problems, and how they cope today:
   the alternatives the product has to beat.
3. **Why it is different.** One sentence, for the early adopters, tied to
   the first problem, saying what changes for them.
4. **Solution.** The smallest thing that answers each problem. Keep it thin
   until the problem is confirmed.
5. **Channels.** How the company reaches the early adopters now. Any channel
   that teaches is enough at first; the channel-testing skill tests them.
6. **Revenue.** What is charged, along what, from when. Do not leave the
   price for later: being paid is the first proof.
7. **Costs.** What the next three to six months cost: building and
   launching the first version, and what goes out every month.
8. **Key numbers.** Three to five that show it working, leading ones before
   lagging ones.
9. **Unfair advantage.** What cannot easily be copied or bought.
   Leave it blank rather than invent one: passion, features and being
   first are not one. It is usually filled last, if at all.

Then name the riskiest assumption: the box that, if wrong, sinks the rest.
Put it first in the document, with the cheapest test of it and the result
that would count. Any box may be filled in any order, or left blank when
nothing is known. Draw the page again after every test: it describes the
present, not a plan to defend.

The nine boxes are adapted from Lean Canvas by Ash Maurya, itself adapted
from the Business Model Canvas by Alexander Osterwalder, and are used under
the Creative Commons Attribution-ShareAlike licence (CC BY-SA 3.0,
https://creativecommons.org/licenses/by-sa/3.0/). This adaptation is shared
under the same licence.
`,
        evals: [
          {
            name: 'puts the riskiest assumption first and leaves the advantage blank',
            input: { idea: 'a booking app for barbers' },
            expectContains: ['riskiest assumption', 'Leave it blank rather than invent one', 'confirmed, likely or'],
          },
          {
            name: 'keeps the share-alike notice',
            input: { question: 'may we reuse this page?' },
            expectContains: ['CC BY-SA', 'same licence', 'Ash Maurya'],
          },
        ],
      },
      {
        slug: 'fit-survey',
        scope: 'company',
        source: `---
name: fit-survey
description: Asking real users whether they would miss the product, to judge whether it fits its market, and counting what they say; after Sean Ellis's product/market fit survey.
---

# Fit survey

Whether the product fits its market is something only its users can say.
Agents draft the survey, have it sent and count the answers. They
never answer in place of a customer, and never invent or tidy a reply.

Who is asked:

- only people who used the product at least twice in the last two weeks,
  read from the company's own records, so every answer comes from real use;
- never ask the same person twice: a second answer skews the count;
- about 40 or more answers before the result is read. With fewer, give the
  count and say it is too few to judge.

The four questions, in the company's own words and in the work language
your run is given, since customers read them -- never assumed to be English:

1. How would you feel if you could no longer use the product? (Very
   disappointed, somewhat disappointed, not disappointed.)
2. What kind of person would get the most from it?
3. What is the main thing it does for you?
4. What would make it better for you?

Sending it is outbound. The role that holds the email or chat tool sends
it, by task.delegate, at tier 2, with whatever approval the policies ask
for, and by the outbound-compliance skill: who it is from, a way to opt
out, and consent where the law needs it.

Reading it:

- The result is the percent of answers that are very disappointed. Record
  it with metric.record on the company's fit measure, a percent. If there
  is none, ask the owner for one with owner.ask: a number written where
  nothing can check it is not a result.
- 40% very disappointed is a heuristic, from Ellis's comparison of about a
  hundred startups, not a law. Above it the product likely fits. Below it,
  read who the very disappointed are (question 2) and what they value
  (question 3), and narrow the product and its customers to them.
- Of the somewhat disappointed, act on those who value what the very
  disappointed value, with question 4. Set the not disappointed aside.

Report to the owner, in the language you write to them: the percent, how
many answered, who was asked and when.
`,
        evals: [
          {
            name: 'asks only real recent users, once each, and never answers for them',
            input: { users: 'everyone on the mailing list' },
            expectContains: [
              'at least twice in the last two weeks', 'never ask the same person twice',
              'about 40 or more answers', 'never answer in place of a customer',
            ],
          },
          {
            name: 'reads 40% as a heuristic and sends at tier 2',
            input: { result: '31% very disappointed from 52 answers' },
            expectContains: ['very disappointed', 'a heuristic', 'tier 2', 'metric.record'],
          },
        ],
      },
      {
        slug: 'press-release-first',
        scope: 'company',
        source: `---
name: press-release-first
description: Writing the announcement and its questions and answers before a new offer is built, so the customer's view decides what is built; after Amazon's working backwards practice.
---

# Press release first

Before the company builds a new offer -- a product, a feature, a service --
write the press release it would publish on the day the offer is ready, and
the questions and answers people would want. If the announcement is not
worth reading, the offer is not worth building yet. It is a document for
deciding, not for sending: nothing in it goes outside the company.

Draft both with doc.draft, in the work language your run is given, as the
customers it is for would read it. Together, a page and a half at most.

The press release, a page or less:

- a headline a customer would understand, and one line on who it is for
  and what changes for them;
- the problem, in customers' own words as the company heard them;
- how the offer solves it, and how a customer starts;
- why the company built it, in a sentence;
- what it costs and how to get it.

A customer quote is a real one, given with consent, or there is none:
never invent a customer's words.

The questions and answers:

- what customers would ask: the price, how it differs from what they use
  now, what happens when it goes wrong, and what it does not do;
- what the owner would ask: what it costs to build and run, how many
  customers it needs to pay back, its riskiest assumption and the cheapest
  test of it, and the result that would make the company stop.

No claim the company cannot back and no number without its source; mark
each confirmed, likely or speculative.

Then hand it to the critic with task.delegate and read the verdict with
task.await. Revise until the critic supports it, or name the critic's
objection for the owner. Only then propose the work: the goal with
goal.propose, or a stage move with stage.propose.
`,
        evals: [
          {
            name: 'writes the release and its questions before building',
            input: { offer: 'a monthly coffee subscription' },
            expectContains: ['Before the company builds a new offer', 'press release', 'questions and answers', 'never invent a customer'],
          },
          {
            name: 'is read by the critic before it is proposed',
            input: { offer: 'a delivery service for the shop' },
            expectContains: ['critic', 'task.delegate', 'goal.propose'],
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
description: When the company moves from one stage to the next, and what the move must carry; pivots and learning priorities after The Lean Startup by Eric Ries.
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

In explore and validate, prefer learning priorities: goals whose result is
what the company learns, each with its measure and a target written before
its first task. The target is the prediction, and the result is read against
it; a missed prediction is something learned, not a failure. The fit-survey
skill gives the GO one more piece of evidence: 40% or more of about 40
recent users very disappointed without the product. That is a heuristic,
never the only evidence and never a stand-in for payment.

When the evidence says the idea is wrong, pivot rather than start again:
keep what was learned and change one thing -- the customer segment (the
same product for other customers), the problem (the same customers, another
problem), or the one feature people use, made the whole product. Watch for
both failure modes: the living dead, a company that never pivots and waits
for the next feature to bring customers; and the compulsive jumper, one that
changes direction before any test could teach it something.

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
          {
            name: 'prefers learning priorities and names both ways a pivot fails',
            input: { question: 'nobody is paying yet; do we change course?' },
            expectContains: ['learning priorities', 'prediction', '40%', 'living dead', 'compulsive jumper', 'customer segment'],
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
