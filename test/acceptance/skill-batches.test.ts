/**
 * A bundle's skills reach the owner as one question, after one review (B9;
 * the analysis of 3 October, step 4 of the first hour).
 *
 * A company made from company-os opened with eleven skill cards in the
 * owner's inbox, in English, before they had asked for anything, each after
 * a reviewer run of its own: about 198 thousand tokens spent on the first
 * day's paperwork. The owner chose one review of a bundle's skills together
 * and one card for the bundle: approve them all, turn them all down, or
 * decide each on the Skills page. Nothing is switched on without that yes.
 */
import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { closePools } from '../../src/db/pool.ts';
import { withTenant } from '../../src/db/tenant.ts';
import { getTask, transition } from '../../src/engine/tasks.ts';
import * as inbox from '../../src/inbox/inbox.ts';
import { installBundle, publishBundle } from '../../src/bundles/bundle.ts';
import { COMPANY_OS } from '../../src/bundles/builtin.ts';
import {
  advanceSkillCandidates,
  approveSkillVersion,
  rejectSkillVersion,
  settleSkillReviews,
} from '../../src/skills/skills.ts';
import { setDeploymentLanguages } from '../../src/domain/language.ts';
import { say } from '../../src/owner/say.ts';
import { registerStandardCatalogue } from '../helpers/catalogue-stubs.ts';
import { createCompany, type Fixture } from '../helpers/fixtures.ts';
import { ensureSchema, resetData, closeSetup } from '../helpers/setup.ts';

before(ensureSchema);
beforeEach(resetData);
after(async () => {
  await closePools();
  await closeSetup();
});

interface Version { id: string; slug: string; state: string; review_task_id: string | null; rejected_reason: string | null }

async function versions(fixture: Fixture): Promise<Version[]> {
  const { rows } = await withTenant(fixture.companyId, (tx) => tx.query<Version>(
    `SELECT v.id, s.slug, v.state, v.review_task_id, v.rejected_reason
       FROM skill_versions v JOIN skills s ON s.id = v.skill_id ORDER BY s.slug`));
  return rows;
}

const skillItems = async (fixture: Fixture) =>
  (await inbox.listOpen(fixture.companyId)).filter((item) => item.kind === 'skill_candidate');

/**
 * Installs company-os, has its skills reviewed in one run -- every one
 * approved but `turned` -- and returns the versions as they then stand.
 */
async function reviewed(fixture: Fixture, turned: string): Promise<{ all: Version[]; reviewTaskId: string }> {
  await registerStandardCatalogue();
  await publishBundle(COMPANY_OS);
  await installBundle({ companyId: fixture.companyId, slug: COMPANY_OS.slug, version: COMPANY_OS.version });
  const count = COMPANY_OS.body.skills.length;

  assert.deepEqual(await advanceSkillCandidates(fixture.companyId), { screened: count, sentForReview: 1 },
    'every skill screened, and one review for the lot');
  const sent = await versions(fixture);
  const tasks = new Set(sent.map((one) => one.review_task_id));
  assert.equal(tasks.size, 1, 'all of them given to the same review');
  const reviewTaskId = [...tasks][0]!;
  assert.ok(reviewTaskId);
  assert.deepEqual(await advanceSkillCandidates(fixture.companyId), { screened: 0, sentForReview: 0 }, 'and given once');

  const task = await withTenant(fixture.companyId, (tx) => getTask(tx, reviewTaskId));
  const asked = task!.input.skills as Array<{ slug: string; document: string }>;
  assert.deepEqual(asked.map((one) => one.slug).sort(), sent.map((one) => one.slug).sort(), 'the review is given every skill');
  assert.ok(asked.every((one) => one.document.startsWith('<<<UNTRUSTED_CONTENT>>>')), 'each as data, never as instructions');
  assert.deepEqual(await skillItems(fixture), [], 'nothing for the owner before the reviewer has read them');

  await transition(fixture.companyId, reviewTaskId, 'running');
  await transition(fixture.companyId, reviewTaskId, 'completed', {
    output: {
      summary: 'Read all of them.',
      skills: sent.map((one) => one.slug === turned
        ? { slug: one.slug, decision: 'reject', reason: 'It tells a run to skip the approval the policies require.' }
        : { slug: one.slug, decision: 'approve', reason: `${one.slug} agrees with the charters.` }),
    },
  });
  assert.equal(await settleSkillReviews(fixture.companyId), count);
  return { all: await versions(fixture), reviewTaskId };
}

test('a bundle\'s skills are reviewed in one run and put to the owner as one card, in the owner\'s language', async () => {
  const fixture = await createCompany('skills-batch');
  await setDeploymentLanguages({ console: 'id' });
  const turned = COMPANY_OS.body.skills[0]!.slug;
  const { all } = await reviewed(fixture, turned);

  const refused = all.find((one) => one.slug === turned)!;
  assert.equal(refused.state, 'rejected');
  assert.match(refused.rejected_reason ?? '', /skip the approval the policies require/);

  const cards = await skillItems(fixture);
  assert.equal(cards.length, 1, 'one card for the bundle, not one per skill');
  const [card] = cards;
  const count = String(COMPANY_OS.body.skills.length - 1);
  assert.equal(card!.skillCount, COMPANY_OS.body.skills.length - 1, 'the console is told how many it asks about');
  assert.equal(card!.title, say('id', 'Skills the bundle "{bundle}" brings: {count}', { bundle: COMPANY_OS.name, count }));
  assert.notEqual(card!.title, say(null, 'Skills the bundle "{bundle}" brings: {count}', { bundle: COMPANY_OS.name, count }),
    'in Indonesian, not English');
  for (const one of all.filter((each) => each.slug !== turned)) {
    assert.ok(card!.actionSummary.includes(one.slug), `${one.slug} is listed on the card`);
    assert.ok(card!.rationale.includes(`${one.slug} agrees with the charters.`), 'with what the reviewer said of it');
  }
  assert.ok(card!.rationale.includes(turned) && card!.rationale.includes('skip the approval the policies require'),
    'and the one it turned down, with why');
});

test('the owner\'s yes switches on every skill the reviewer approved, leaving one decided on the Skills page as decided', async () => {
  const fixture = await createCompany('skills-batch-yes');
  const turned = COMPANY_OS.body.skills[0]!.slug;
  const { all } = await reviewed(fixture, turned);
  const approvable = all.filter((one) => one.state === 'candidate');
  const [early, refusedEarly] = approvable;

  // Decided one at a time on the Skills page first: the card stays for the rest.
  await approveSkillVersion(fixture.companyId, early!.id);
  await rejectSkillVersion(fixture.companyId, refusedEarly!.id, 'Not for us.');
  const [card] = await skillItems(fixture);
  assert.ok(card, 'the card stays while some of its skills are undecided');

  await inbox.decide(fixture.companyId, card!.id, 'approve');
  const after = new Map((await versions(fixture)).map((one) => [one.slug, one]));
  assert.equal(after.get(refusedEarly!.slug)!.state, 'rejected', 'a skill turned down on the page stays turned down');
  assert.equal(after.get(turned)!.state, 'rejected', 'and the reviewer\'s no stands');
  for (const one of approvable.filter((each) => each.id !== refusedEarly!.id)) {
    assert.equal(after.get(one.slug)!.state, 'active', `${one.slug} is switched on`);
  }
  assert.deepEqual(await skillItems(fixture), []);
});

test('the owner\'s no turns down every skill on the card; deciding the last one on the Skills page withdraws it', async () => {
  const declined = await createCompany('skills-batch-no');
  const turned = COMPANY_OS.body.skills[0]!.slug;
  await reviewed(declined, turned);
  const [card] = await skillItems(declined);
  await inbox.decide(declined.companyId, card!.id, 'deny', 'Not this month.');
  const after = await versions(declined);
  assert.ok(after.every((one) => one.state === 'rejected'), 'none switched on');
  assert.ok(after.filter((one) => one.slug !== turned).every((one) => one.rejected_reason === 'Not this month.'),
    'with the owner\'s note as the reason');

  await resetData();
  const page = await createCompany('skills-batch-page');
  const { all } = await reviewed(page, turned);
  const waiting = all.filter((one) => one.state === 'candidate');
  for (const [index, one] of waiting.entries()) {
    assert.equal((await skillItems(page)).length, 1, `the card is open before skill ${index + 1} of ${waiting.length}`);
    await approveSkillVersion(page.companyId, one.id);
  }
  assert.deepEqual(await skillItems(page), [], 'nothing left on the card to decide, so it is withdrawn');
});
