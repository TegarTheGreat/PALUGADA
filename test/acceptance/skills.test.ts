/**
 * PRD v2 F15 -- skills and the curated learning loop.
 *
 * Principle 12 divides what an agent is given in two, and this is the half
 * that is not enforcement. A hook is a rule a runtime cannot get past; a skill
 * is knowledge it can read, ignore, or get wrong. What these tests hold is the
 * curation: nothing an agent proposes reaches another agent without a
 * different role having examined it and the owner having said yes.
 */
import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { withTenant } from '../../src/db/tenant.ts';
import { closePools } from '../../src/db/pool.ts';
import { isPalugadaError } from '../../src/errors.ts';
import {
  addEvalCase,
  approveSkillVersion,
  isPromotion,
  parseSkillDocument,
  setSkillScope,
  proposeSkillVersion,
  readSkill,
  recordSkillReview,
  renderSkillDocument,
  runSkillEvals,
  screenCandidate,
  skillSummariesFor,
} from '../../src/skills/skills.ts';
import { buildContext } from '../../src/context/builder.ts';
import * as inbox from '../../src/inbox/inbox.ts';
import { createCompany, type Fixture } from '../helpers/fixtures.ts';
import { ensureSchema, resetData, closeSetup } from '../helpers/setup.ts';

before(ensureSchema);
beforeEach(resetData);
after(async () => {
  await closePools();
  await closeSetup();
});

const REFUND_SKILL = `---
name: refund-policy
description: How to answer a refund request without escalating it.
owner: support
---

# Refunds

Refund within 30 days of purchase, no questions asked.
Above USD 200, ask the owner first.
Never promise a date the finance calendar cannot meet.
`;

async function proposeRefundSkill(fixture: Fixture, source = REFUND_SKILL) {
  return proposeSkillVersion({
    companyId: fixture.companyId,
    slug: 'refund-policy',
    scopeType: 'division',
    scopeId: fixture.divisionId,
    source,
    author: 'distillation',
    changelog: 'Observed in six completed support tasks.',
  });
}

async function withEval(fixture: Fixture, skillId: string) {
  await addEvalCase(fixture.companyId, skillId, {
    name: 'names the ceiling',
    input: { question: 'customer wants USD 400 back' },
    expectContains: ['USD 200', 'ask the owner'],
  });
}

/* --------------------------------------------------------------- format --- */

test('a skill is an open-format document and a round trip is lossless (F15.1)', () => {
  const parsed = parseSkillDocument(REFUND_SKILL);
  assert.equal(parsed.name, 'refund-policy');
  assert.equal(parsed.description, 'How to answer a refund request without escalating it.');
  assert.equal(parsed.metadata.owner, 'support');
  assert.match(parsed.body, /Refund within 30 days/);

  const reparsed = parseSkillDocument(renderSkillDocument(parsed));
  assert.deepEqual(reparsed, parsed);
});

/**
 * The parser accepts flat key/value front matter and nothing else.
 *
 * That is the point rather than a limitation: anchors, references and nested
 * maps are the parts of YAML that turn a document into a program, and a skill
 * is a document.
 */
test('a skill without front matter, or with nested front matter, is refused', () => {
  assert.throws(
    () => parseSkillDocument('# Refunds\n\nJust do it.'),
    (error: unknown) => isPalugadaError(error, 'skill.invalid'),
  );
  assert.throws(
    () => parseSkillDocument('---\nname: x\nmeta:\n  nested: true\n---\n\nbody\n'),
    (error: unknown) => isPalugadaError(error, 'skill.invalid'),
  );
  assert.throws(
    () => parseSkillDocument('---\nname: x\n---\n\nbody\n'),
    (error: unknown) => isPalugadaError(error, 'skill.invalid'),
  );
});

/* ----------------------------------------------------------------- loop --- */

test('a proposed skill is a candidate and reaches no context (F15.3)', async () => {
  const fixture = await createCompany('skill-candidate');
  const proposed = await proposeRefundSkill(fixture);

  const summaries = await withTenant(fixture.companyId, (tx) =>
    skillSummariesFor(tx, { companyId: fixture.companyId, divisionId: fixture.divisionId }),
  );
  assert.deepEqual(summaries, [], 'a candidate is not in anybody\'s context');

  // F10.1: and the owner is told one exists, in the right queue.
  const open = await inbox.listOpen(fixture.companyId);
  const item = open.find((entry) => entry.id === proposed.inboxItemId);
  assert.ok(item);
  assert.equal(item.kind, 'skill_candidate');
});

/**
 * F15.3 is two gates, and the owner is the second one.
 *
 * An owner asked to approve something no other role has examined is being
 * asked to *be* the review, which is the arrangement F7 exists to avoid.
 */
test('the owner cannot approve a version no reviewer has seen (F15.3)', async () => {
  const fixture = await createCompany('skill-order');
  const proposed = await proposeRefundSkill(fixture);
  await withEval(fixture, proposed.skillId);

  await assert.rejects(
    () => approveSkillVersion(fixture.companyId, proposed.versionId),
    (error: unknown) => isPalugadaError(error, 'review.required'),
  );
});

test('review and owner approval together make a skill live (F15.3)', async () => {
  const fixture = await createCompany('skill-live');
  const proposed = await proposeRefundSkill(fixture);
  await withEval(fixture, proposed.skillId);

  await recordSkillReview(fixture.companyId, proposed.versionId, { approved: true });
  const activated = await approveSkillVersion(fixture.companyId, proposed.versionId);
  assert.equal(activated.activated, true);
  assert.equal(activated.version, 1);

  const summaries = await withTenant(fixture.companyId, (tx) =>
    skillSummariesFor(tx, { companyId: fixture.companyId, divisionId: fixture.divisionId }),
  );
  assert.equal(summaries.length, 1);
  assert.equal(summaries[0]!.slug, 'refund-policy');
  assert.equal(summaries[0]!.activeVersion, 1);
});

test('a rejected version never becomes live', async () => {
  const fixture = await createCompany('skill-rejected');
  const proposed = await proposeRefundSkill(fixture);
  await withEval(fixture, proposed.skillId);

  await recordSkillReview(fixture.companyId, proposed.versionId, {
    approved: false,
    reason: 'it contradicts the finance calendar',
  });

  await assert.rejects(
    () => approveSkillVersion(fixture.companyId, proposed.versionId),
    (error: unknown) => isPalugadaError(error, 'skill.invalid'),
  );
});

/**
 * F15.4, enforced by the database rather than by a code path.
 *
 * A skill with no eval is a claim nobody has ever checked. The rule lives in a
 * trigger because a check that lives in one code path stops being a check the
 * day somebody adds a second one -- so the test goes around the module
 * entirely and writes the row itself.
 */
test('a version cannot be activated for a skill with no eval case (F15.4)', async () => {
  const fixture = await createCompany('skill-no-eval');
  const proposed = await proposeRefundSkill(fixture);
  await recordSkillReview(fixture.companyId, proposed.versionId, { approved: true });

  await assert.rejects(
    () => approveSkillVersion(fixture.companyId, proposed.versionId),
    (error: unknown) => /no eval case/.test((error as Error).message),
  );

  // And directly, so the guarantee is shown to be the database's.
  await assert.rejects(
    () =>
      withTenant(fixture.companyId, (tx) =>
        tx.query(
          `UPDATE skill_versions SET state = 'active', reviewed_at = now(), approved_at = now()
            WHERE id = $1`,
          [proposed.versionId],
        ),
      ),
    (error: unknown) => /PRD F15.4/.test((error as Error).message),
  );
});

test('a candidate whose evals fail is rejected without asking anybody (F15.5)', async () => {
  const fixture = await createCompany('skill-eval-fail');
  const first = await proposeRefundSkill(fixture);
  await withEval(fixture, first.skillId);

  // A rewrite that quietly drops the ceiling everybody relied on -- the
  // failure an eval on a document is actually good at catching.
  const rewritten = REFUND_SKILL.replace('Above USD 200, ask the owner first.\n', '');
  const second = await proposeSkillVersion({
    companyId: fixture.companyId,
    slug: 'refund-policy',
    scopeType: 'division',
    scopeId: fixture.divisionId,
    source: rewritten,
    author: 'agent',
    changelog: 'Simplified the wording.',
  });

  const screened = await screenCandidate(fixture.companyId, second.versionId);
  assert.equal(screened.rejected, true);
  assert.deepEqual(screened.cases[0]!.missing, ['USD 200', 'ask the owner']);

  const state = await withTenant(fixture.companyId, async (tx) => {
    const { rows } = await tx.query<{ state: string; rejected_reason: string }>(
      'SELECT state, rejected_reason FROM skill_versions WHERE id = $1',
      [second.versionId],
    );
    return rows[0]!;
  });
  assert.equal(state.state, 'rejected');
  assert.match(state.rejected_reason, /eval failed/);

  // The first version, which still says what it said, passes.
  assert.equal((await runSkillEvals(fixture.companyId, first.versionId)).passed, true);
});

test('a skill with no eval case does not pass its evals by having none', async () => {
  const fixture = await createCompany('skill-empty-eval');
  const proposed = await proposeRefundSkill(fixture);
  const result = await runSkillEvals(fixture.companyId, proposed.versionId);
  assert.equal(result.passed, false);
  assert.deepEqual(result.cases, []);
});

test('activating a new version supersedes the old one (F15.2)', async () => {
  const fixture = await createCompany('skill-versions');
  const first = await proposeRefundSkill(fixture);
  await withEval(fixture, first.skillId);
  await recordSkillReview(fixture.companyId, first.versionId, { approved: true });
  await approveSkillVersion(fixture.companyId, first.versionId);

  const second = await proposeSkillVersion({
    companyId: fixture.companyId,
    slug: 'refund-policy',
    scopeType: 'division',
    scopeId: fixture.divisionId,
    source: REFUND_SKILL.replace('30 days', '45 days'),
    author: 'owner',
    changelog: 'Finance extended the window to 45 days.',
  });
  await recordSkillReview(fixture.companyId, second.versionId, { approved: true });
  await approveSkillVersion(fixture.companyId, second.versionId);

  const states = await withTenant(fixture.companyId, async (tx) => {
    const { rows } = await tx.query<{ version: number; state: string; author: string }>(
      `SELECT version, state, author FROM skill_versions
        WHERE skill_id = $1 ORDER BY version`,
      [first.skillId],
    );
    return rows;
  });
  assert.deepEqual(states, [
    { version: 1, state: 'superseded', author: 'distillation' },
    { version: 2, state: 'active', author: 'owner' },
  ]);

  const live = await readSkill(fixture.companyId, 'refund-policy');
  assert.equal(live!.version, 2);
  assert.match(live!.source, /45 days/);
});

/* ---------------------------------------------------------------- scope --- */

test('widening a skill\'s reach is a tier 3 action (F15.6)', async () => {
  const fixture = await createCompany('skill-scope');
  const proposed = await proposeRefundSkill(fixture);

  assert.equal(isPromotion('division', 'company'), true);
  assert.equal(isPromotion('company', 'division'), false);

  await assert.rejects(
    () =>
      setSkillScope(
        fixture.companyId,
        proposed.skillId,
        { scopeType: 'company' },
        { ownerApproved: false },
      ),
    (error: unknown) => isPalugadaError(error, 'approval.required'),
  );

  // Narrowing needs no approval: a rule that only tightens is the same shape
  // as F3.5 and F14.2, and refusing it would make caution expensive. It does
  // have to say which division, because a company-wide skill has no obvious
  // home to fall back to.
  await setSkillScope(
    fixture.companyId,
    proposed.skillId,
    { scopeType: 'company' },
    { ownerApproved: true },
  );
  await setSkillScope(
    fixture.companyId,
    proposed.skillId,
    { scopeType: 'division', scopeId: fixture.divisionId },
    { ownerApproved: false },
  );
});

test('a new version may not quietly change a skill\'s scope (F15.6)', async () => {
  const fixture = await createCompany('skill-scope-drift');
  await proposeRefundSkill(fixture);

  await assert.rejects(
    () =>
      proposeSkillVersion({
        companyId: fixture.companyId,
        slug: 'refund-policy',
        scopeType: 'company',
        source: REFUND_SKILL,
        author: 'agent',
        changelog: 'Everyone should follow this.',
      }),
    (error: unknown) => isPalugadaError(error, 'skill.scope_change'),
  );
});

/* ------------------------------------------------- progressive disclosure --- */

/**
 * F15.7: the context pack names the skill and says what it is for. It does not
 * carry the document.
 */
test('a run\'s context carries a skill summary, not the skill (F15.7)', async () => {
  const fixture = await createCompany('skill-disclosure');
  const proposed = await proposeRefundSkill(fixture);
  await withEval(fixture, proposed.skillId);
  await recordSkillReview(fixture.companyId, proposed.versionId, { approved: true });
  await approveSkillVersion(fixture.companyId, proposed.versionId);

  const context = await withTenant(fixture.companyId, (tx) =>
    buildContext(tx, { companyId: fixture.companyId, divisionId: fixture.divisionId }),
  );
  const rendered = context.sections.map((section) => section.body).join('\n');

  assert.match(rendered, /How to answer a refund request/);
  assert.match(rendered, /skill\.read\("refund-policy"\)/);
  assert.equal(
    /Refund within 30 days/.test(rendered),
    false,
    'the body stays out of the pack until it is asked for',
  );

  // And `skill.read` is what fetches it.
  const full = await readSkill(fixture.companyId, 'refund-policy');
  assert.match(full!.source, /Refund within 30 days/);
});

test('a division does not see another division\'s skill (F15.6)', async () => {
  const fixture = await createCompany('skill-scoped');
  const proposed = await proposeRefundSkill(fixture);
  await withEval(fixture, proposed.skillId);
  await recordSkillReview(fixture.companyId, proposed.versionId, { approved: true });
  await approveSkillVersion(fixture.companyId, proposed.versionId);

  const otherDivision = await withTenant(fixture.companyId, async (tx) => {
    const { rows } = await tx.query<{ id: string }>(
      'INSERT INTO divisions (company_id, slug, name) VALUES ($1, $2, $3) RETURNING id',
      [fixture.companyId, 'lab', 'Lab'],
    );
    return rows[0]!.id;
  });

  const seen = await withTenant(fixture.companyId, (tx) =>
    skillSummariesFor(tx, { companyId: fixture.companyId, divisionId: otherDivision }),
  );
  assert.deepEqual(seen, []);
});
