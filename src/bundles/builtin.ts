/**
 * The bundles that ship with v1 (PRD v2 F16.5).
 *
 * `content-ops`, `web-ops` and `qa-review`. They are deliberately narrow: a
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
  division: string;
  prompt: string;
  tools: string[];
  doneCriteria: string[];
}) {
  return {
    slug: input.slug,
    division: input.division,
    systemPrompt: input.prompt,
    model: 'claude-sonnet-5',
    tools: input.tools,
    inputSchema: WORK_INPUT,
    outputSchema: WORK_OUTPUT,
    maxTokensPerRun: 40_000,
    doneCriteria: input.doneCriteria,
  };
}

export const CONTENT_OPS: Bundle = {
  slug: 'content-ops',
  version: '1.0.0',
  name: 'Content operations',
  description: 'Researches, drafts and publishes written material.',
  body: {
    divisions: [{ slug: 'content', name: 'Content', maxConcurrency: 4 }],
    roles: [
      role({
        slug: 'researcher',
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
        condition: 'tool == "social.publish" or tool == "email.send"',
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
  version: '1.0.0',
  name: 'Web operations',
  description: 'Hosting, domains and deployment, with the tiers the catalogue calibrated.',
  body: {
    divisions: [{ slug: 'web', name: 'Web operations', maxConcurrency: 2 }],
    roles: [
      role({
        slug: 'web-operator',
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
        condition: 'tool == "dns.update" and tier >= 3',
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
  version: '1.0.0',
  name: 'Adversarial review',
  description: 'The reviewer role F7 needs, holding nothing that writes.',
  body: {
    divisions: [{ slug: 'review', name: 'Review', maxConcurrency: 4 }],
    roles: [
      role({
        slug: 'qa-reviewer',
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

export const BUILT_IN_BUNDLES: readonly Bundle[] = [CONTENT_OPS, WEB_OPS, QA_REVIEW];
