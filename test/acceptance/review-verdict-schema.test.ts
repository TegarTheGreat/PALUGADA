/**
 * The reviewers PALUGADA ships are asked for a verdict (the one-man-company
 * audit of 3 October, docs/AUDIT-2026-10-03-ONE-MAN-COMPANY.md, 3.3).
 *
 * `settleCompletedReviews` reads `output.decision` and `output.reason`; a
 * review with no readable verdict goes to the owner as "undecided". A role is
 * shown its output schema before it answers, so the schema is where it learns
 * that a verdict is those two fields. Only the strategy critic was given the
 * schema: the standard company's reviewer and the two reviewers of the
 * built-in bundles answered with a summary, and every review they did was an
 * owner's card saying nothing could be read.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BUILT_IN_BUNDLES } from '../../src/bundles/builtin.ts';
import { STANDARD_COMPANY_TEMPLATE } from '../helpers/standard-team.ts';

/** Every role a review can be given to: by the slug the policies and templates name as a reviewer. */
const REVIEWERS = ['reviewer', 'qa-reviewer', 'platform-reviewer', 'critic'];

function shipped(): Array<{ where: string; slug: string; outputSchema: Record<string, unknown> }> {
  const found: Array<{ where: string; slug: string; outputSchema: Record<string, unknown> }> = [];
  for (const role of STANDARD_COMPANY_TEMPLATE.roles) {
    if (REVIEWERS.includes(role.slug)) found.push({ where: 'the standard company', slug: role.slug, outputSchema: role.outputSchema as Record<string, unknown> });
  }
  for (const bundle of BUILT_IN_BUNDLES) {
    for (const role of bundle.body.roles ?? []) {
      if (REVIEWERS.includes(role.slug)) found.push({ where: `the ${bundle.slug} bundle`, slug: role.slug, outputSchema: role.outputSchema as Record<string, unknown> });
    }
  }
  return found;
}

test('every reviewer that ships is asked for a decision and a reason', () => {
  const roles = shipped();
  // The scan must be finding them: one in the template and three in bundles.
  assert.deepEqual(roles.map((one) => one.slug).sort(), ['critic', 'platform-reviewer', 'qa-reviewer', 'reviewer']);
  for (const { where, slug, outputSchema } of roles) {
    const schema = outputSchema as { required?: string[]; properties?: Record<string, { enum?: string[] }> };
    assert.deepEqual([...(schema.required ?? [])].sort(), ['decision', 'reason'], `${slug} in ${where} is not asked for a verdict`);
    assert.deepEqual(schema.properties?.decision?.enum, ['approve', 'revise', 'reject'], `${slug} in ${where} does not say what a decision is`);
  }
});

test('a bundle whose role changed says so in its version', () => {
  // A changed role is installed again only when the bundle's version moves.
  const versions = Object.fromEntries(BUILT_IN_BUNDLES.map((one) => [one.slug, one.version]));
  assert.notEqual(versions['qa-review'], '1.2.0', 'qa-reviewer changed');
  assert.notEqual(versions['palugada-dev'], '1.3.0', 'platform-reviewer changed');
});
