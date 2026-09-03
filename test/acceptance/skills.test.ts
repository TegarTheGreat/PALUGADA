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
import { generateKeyPairSync, sign } from 'node:crypto';
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
  hashSkillSource,
  importExternalSkill,
  liftSkillQuarantine,
} from '../../src/skills/skills.ts';
import { buildContext } from '../../src/context/builder.ts';
import * as inbox from '../../src/inbox/inbox.ts';
import { trustPublisher } from '../../src/bundles/publishers.ts';
import { createCompany, grantCapability, type Fixture } from '../helpers/fixtures.ts';
import { registerStandardCatalogue } from '../helpers/catalogue-stubs.ts';
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

  // The pack only tells a division to fetch what it may fetch, so the grant is
  // part of the arrangement rather than incidental setup. The catalogue comes
  // first because a grant names a capability that has to exist.
  await registerStandardCatalogue();
  await grantCapability(fixture, 'skill.read');

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

/**
 * The pack does not tell a run to call something it will be refused for.
 *
 * F4.8 and F15.7 both work by instructing the run: search for what did not fit,
 * fetch the procedure that was only summarised. The first real boot of this
 * platform found every division being told both while being granted neither,
 * so every run that followed its instructions met a refusal. The template now
 * grants them — except to the lab, which runs supplied code, and to assurance,
 * whose reviewer holds no grant at all by F7.3. The instruction is therefore
 * conditional on the grant, which is the durable form of the fix: a division
 * added tomorrow without the grant gets a pack that is honest about it rather
 * than the same bug again.
 */
test('the context pack does not instruct a division to call what it was not granted (F4.8, F15.7)', async () => {
  const fixture = await createCompany('pack-without-grants');
  const proposed = await proposeRefundSkill(fixture);
  await withEval(fixture, proposed.skillId);
  await recordSkillReview(fixture.companyId, proposed.versionId, { approved: true });
  await approveSkillVersion(fixture.companyId, proposed.versionId);

  // No grantCapability call anywhere in this test: the division holds neither.
  //
  // Two packs, because the two instructions live in sections that cannot both
  // be present. The skill summary carries the `skill.read` instruction and the
  // trim warning carries the `memory.search` one — and the warning only exists
  // when something was dropped, which at a small enough limit means the skill
  // summary was the thing dropped. Asserting both against one pack would leave
  // whichever section was missing untested and passing for the wrong reason.
  const full = await withTenant(fixture.companyId, (tx) =>
    buildContext(tx, { companyId: fixture.companyId, divisionId: fixture.divisionId }),
  );
  const withSummary = full.sections.map((section) => section.body).join('\n');

  assert.equal(full.dropped, 0, 'nothing was trimmed, so the skill summary is really here');
  assert.match(withSummary, /How to answer a refund request/);
  assert.equal(
    /skill\.read\(/.test(withSummary),
    false,
    'a run told to fetch a procedure its division cannot fetch spends an attempt on a refusal',
  );
  // Silence would be worse than the instruction: the run should know it is
  // working from a summary rather than assume it has the whole procedure.
  assert.match(withSummary, /cannot fetch the full procedure/);

  const capped = await withTenant(fixture.companyId, (tx) =>
    buildContext(tx, {
      companyId: fixture.companyId,
      divisionId: fixture.divisionId,
      // Below what the skill summary alone costs, so something is certainly
      // dropped and the incomplete-context warning is certainly written.
      tokenLimit: 20,
    }),
  );
  const trimmed = capped.sections.map((section) => section.body).join('\n');

  assert.ok(capped.dropped > 0, 'the pack was trimmed, so the warning is in play');
  assert.match(trimmed, /did not fit within the 20-token context pack/);
  assert.equal(
    /memory\.search/.test(trimmed),
    false,
    'and the same for searching back what the pack dropped',
  );
  assert.match(trimmed, /cannot search for what was left out/);
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


/* --------------------------------------------------------------- F15.8 --- */

const HUB_SKILL = `---
name: cold-outreach
description: A sequence somebody on the internet says works.
---

# Cold outreach

Send three messages, four days apart, then stop.
Never send a fourth.
`;

function publisher() {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519', {
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });
  return { publicKey, privateKey };
}

/**
 * F15.8: an unsigned external skill enters quarantined, and quarantine means
 * one division.
 *
 * The requirement points at F12.10, whose answer for a device or a bundle is
 * "tier 0 only". A skill has no tier, so the analogue is scope: for knowledge,
 * reaching too far means being put in front of every agent in the company.
 */
test('an unsigned external skill arrives quarantined and division-scoped (F15.8)', async () => {
  const fixture = await createCompany('skill-hub-unsigned');

  const imported = await importExternalSkill({
    companyId: fixture.companyId,
    slug: 'cold-outreach',
    source: HUB_SKILL,
    origin: 'agentskills.io/cold-outreach',
    divisionId: fixture.divisionId,
  });
  assert.equal(imported.quarantined, true);

  const stored = await withTenant(fixture.companyId, async (tx) => {
    const { rows } = await tx.query<{
      provenance: string; origin: string; quarantined: boolean; scope_type: string;
    }>(
      'SELECT provenance, origin, quarantined, scope_type FROM skills WHERE id = $1',
      [imported.skillId],
    );
    return rows[0]!;
  });
  assert.equal(stored.provenance, 'external');
  assert.equal(stored.origin, 'agentskills.io/cold-outreach');
  assert.equal(stored.quarantined, true);
  assert.equal(stored.scope_type, 'division');

  // Widening is refused outright — not "refused without owner approval". The
  // owner's route is to vouch for where it came from first, which is a
  // different question from who should follow it.
  await assert.rejects(
    () =>
      setSkillScope(
        fixture.companyId,
        imported.skillId,
        { scopeType: 'company' },
        { ownerApproved: true },
      ),
    (error: unknown) => isPalugadaError(error, 'skill.quarantined'),
  );

  // And the database refuses it too, so the rule does not depend on the code
  // path somebody happens to use.
  await assert.rejects(
    () =>
      withTenant(fixture.companyId, (tx) =>
        tx.query("UPDATE skills SET scope_type = 'company', scope_id = NULL WHERE id = $1", [
          imported.skillId,
        ]),
      ),
    (error: unknown) => /PRD F15.8/.test((error as Error).message),
  );
});

/**
 * A skill signed by a stranger is still a stranger's skill.
 *
 * The same hole the bundles had: the key arrives with the document, so
 * verifying against it proves internal consistency and nothing about who wrote
 * it. Anyone could sign their own hub upload and have it skip quarantine — and
 * a skill that skips quarantine can be widened to the whole company.
 */
test('a self-signed external skill is still quarantined (F15.8, F16.2)', async () => {
  const fixture = await createCompany('skill-hub-stranger');
  const stranger = publisher();

  const imported = await importExternalSkill({
    companyId: fixture.companyId,
    slug: 'cold-outreach',
    source: HUB_SKILL,
    origin: 'agentskills.io/cold-outreach',
    divisionId: fixture.divisionId,
    signature: sign(null, Buffer.from(hashSkillSource(HUB_SKILL)), stranger.privateKey)
      .toString('base64'),
    publisherKey: stranger.publicKey,
  });

  assert.equal(imported.quarantined, true, 'a correct signature from an unknown key is not trust');

  await assert.rejects(
    () =>
      setSkillScope(
        fixture.companyId,
        imported.skillId,
        { scopeType: 'company' },
        { ownerApproved: true },
      ),
    (error: unknown) => isPalugadaError(error, 'skill.quarantined'),
  );

  // The record says which of the two it was, because "unsigned" and "signed by
  // somebody we do not know" are different things for an owner deciding.
  const event = await withTenant(fixture.companyId, async (tx) => {
    const { rows } = await tx.query<{ payload: Record<string, unknown> }>(
      "SELECT payload FROM events WHERE type = 'skill.imported'",
    );
    return rows[0]!.payload;
  });
  assert.equal(event.offeredSignature, true);
  assert.equal(event.signed, false);
});

test('a signed external skill is not quarantined (F15.8, F12.10)', async () => {
  const fixture = await createCompany('skill-hub-signed');
  const keys = publisher();
  // The installation has to have been told to accept this publisher.
  await trustPublisher({
    publicKeyPem: keys.publicKey,
    label: 'a hub the owner checked',
    ownerApproved: true,
  });

  const imported = await importExternalSkill({
    companyId: fixture.companyId,
    slug: 'cold-outreach',
    source: HUB_SKILL,
    origin: 'agentskills.io/cold-outreach',
    divisionId: fixture.divisionId,
    signature: sign(null, Buffer.from(hashSkillSource(HUB_SKILL)), keys.privateKey)
      .toString('base64'),
    publisherKey: keys.publicKey,
  });

  assert.equal(imported.quarantined, false);
  await setSkillScope(
    fixture.companyId,
    imported.skillId,
    { scopeType: 'company' },
    { ownerApproved: true },
  );
});

/**
 * A signature that does not verify is refused, where none is merely
 * quarantined.
 *
 * A false claim of provenance is worse than no claim: accepting it as
 * unvouched-for would make forging one strictly better than omitting one.
 */
test('an external skill with a bad signature is refused outright (F15.8)', async () => {
  const fixture = await createCompany('skill-hub-forged');
  const keys = publisher();
  const impostor = publisher();

  await assert.rejects(
    () =>
      importExternalSkill({
        companyId: fixture.companyId,
        slug: 'cold-outreach',
        source: HUB_SKILL,
        origin: 'agentskills.io/cold-outreach',
        divisionId: fixture.divisionId,
        signature: sign(null, Buffer.from(hashSkillSource(HUB_SKILL)), impostor.privateKey)
          .toString('base64'),
        publisherKey: keys.publicKey,
      }),
    (error: unknown) => isPalugadaError(error, 'skill.bad_signature'),
  );

  const skills = await withTenant(fixture.companyId, async (tx) => {
    const { rows } = await tx.query<{ count: string }>('SELECT count(*)::text AS count FROM skills');
    return Number(rows[0]!.count);
  });
  assert.equal(skills, 0, 'a forged signature leaves nothing behind');
});

test('lifting a quarantine is the owner\'s, and is a separate decision (F15.8)', async () => {
  const fixture = await createCompany('skill-hub-lift');
  const imported = await importExternalSkill({
    companyId: fixture.companyId,
    slug: 'cold-outreach',
    source: HUB_SKILL,
    origin: 'agentskills.io/cold-outreach',
    divisionId: fixture.divisionId,
  });

  await assert.rejects(
    () => liftSkillQuarantine(fixture.companyId, imported.skillId, { ownerApproved: false }),
    (error: unknown) => isPalugadaError(error, 'approval.required'),
  );

  await liftSkillQuarantine(fixture.companyId, imported.skillId, { ownerApproved: true });
  await setSkillScope(
    fixture.companyId,
    imported.skillId,
    { scopeType: 'company' },
    { ownerApproved: true },
  );
});

/**
 * An imported skill is still a candidate, still needs both gates, and still
 * needs an eval. Quarantine is a fourth constraint, not a replacement.
 */
test('an imported skill still needs a reviewer, the owner, and an eval (F15.8, F15.3)', async () => {
  const fixture = await createCompany('skill-hub-gates');
  const imported = await importExternalSkill({
    companyId: fixture.companyId,
    slug: 'cold-outreach',
    source: HUB_SKILL,
    origin: 'agentskills.io/cold-outreach',
    divisionId: fixture.divisionId,
  });

  assert.deepEqual(
    await withTenant(fixture.companyId, (tx) =>
      skillSummariesFor(tx, { companyId: fixture.companyId, divisionId: fixture.divisionId }),
    ),
    [],
  );

  await assert.rejects(
    () => approveSkillVersion(fixture.companyId, imported.versionId),
    (error: unknown) => isPalugadaError(error, 'review.required'),
  );

  await recordSkillReview(fixture.companyId, imported.versionId, { approved: true });
  await assert.rejects(
    () => approveSkillVersion(fixture.companyId, imported.versionId),
    (error: unknown) => /no eval case/.test((error as Error).message),
  );

  await addEvalCase(fixture.companyId, imported.skillId, {
    name: 'stops at three',
    input: {},
    expectContains: ['Never send a fourth'],
  });
  await approveSkillVersion(fixture.companyId, imported.versionId);

  // Live, and the summary says where it came from: a run reading it should
  // know nobody here wrote it.
  const live = await withTenant(fixture.companyId, (tx) =>
    skillSummariesFor(tx, { companyId: fixture.companyId, divisionId: fixture.divisionId }),
  );
  assert.equal(live.length, 1);
  assert.equal(live[0]!.quarantined, true);
  assert.equal(live[0]!.origin, 'agentskills.io/cold-outreach');

  // And the run is told in words, not in a flag it cannot see. Same reasoning
  // as F4.5's unverified facts.
  const context = await withTenant(fixture.companyId, (tx) =>
    buildContext(tx, { companyId: fixture.companyId, divisionId: fixture.divisionId }),
  );
  assert.match(context.text, /QUARANTINED/);
  assert.match(context.text, /nobody\s+here has vouched for it/);
  assert.match(context.text, /agentskills\.io\/cold-outreach/);
});
