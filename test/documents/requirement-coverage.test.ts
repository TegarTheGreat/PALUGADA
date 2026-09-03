/**
 * Every requirement the PRD declares is accounted for in docs/STATUS.md.
 *
 * This is a test about two documents rather than about behaviour, and it earns
 * its place in the suite because of how F12.6 was found. That requirement is a
 * P0 -- "least privilege pada token pihak ketiga" in the PRD's own words -- and
 * it appeared in the status table under no column at all. Not built, not
 * partial, not done: absent. It had been absent long enough that nothing cited
 * it anywhere in the repository, and the only reason it surfaced was somebody
 * asking what was left and the list being checked by hand.
 *
 * A status document that omits a requirement is worse than one that grades it
 * wrong, because a wrong grade is an argument somebody can have and an omission
 * is invisible. One hundred and forty-six requirements is more than anybody
 * re-reads, so the comparison is mechanical and it runs on every push.
 *
 * What this deliberately does not check is whether a grade is *right*. That is
 * what sections 2.2 to 2.10 of the status document are for, and no parser can
 * do it. This checks only that every requirement has been looked at.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

/** Ids the PRD declares, read from the leading cell of its requirement tables. */
function declaredRequirements(prd: string): string[] {
  const ids = new Set<string>();
  for (const line of prd.split('\n')) {
    const match = /^\|\s*(F\d+\.\d+)\s*\|/.exec(line);
    if (match) ids.add(match[1]!);
  }
  return [...ids].sort(byRequirementNumber);
}

/**
 * Ids the status table accounts for, expanding its ranges.
 *
 * The table is written for a reader, so it says `F1.1–F1.9` rather than nine
 * separate ids. Expanding here rather than asking the table to be written
 * longhand: the document's job is to be read, and this file's job is to cope.
 */
function accountedRequirements(status: string): Set<string> {
  const ids = new Set<string>();
  for (const line of status.split('\n')) {
    if (!/^\|\s*F\d+ /.test(line)) continue;

    for (const match of line.matchAll(/F(\d+)\.(\d+)\s*[–-]\s*(?:F\d+\.)?(\d+)/g)) {
      const group = match[1]!;
      for (let n = Number(match[2]); n <= Number(match[3]); n += 1) ids.add(`F${group}.${n}`);
    }
    for (const match of line.matchAll(/F(\d+)\.(\d+)/g)) {
      ids.add(`F${match[1]}.${match[2]}`);
    }
  }
  return ids;
}

function byRequirementNumber(left: string, right: string): number {
  const [leftGroup, leftItem] = left.slice(1).split('.').map(Number) as [number, number];
  const [rightGroup, rightItem] = right.slice(1).split('.').map(Number) as [number, number];
  return leftGroup - rightGroup || leftItem - rightItem;
}

test('docs/STATUS.md grades every requirement the PRD declares', async () => {
  const [prd, status] = await Promise.all([
    readFile(new URL('../../docs/PRD.md', import.meta.url), 'utf8'),
    readFile(new URL('../../docs/STATUS.md', import.meta.url), 'utf8'),
  ]);

  const declared = declaredRequirements(prd);
  const accounted = accountedRequirements(status);

  // A sanity floor. If the PRD's tables are ever reformatted so this parser
  // stops finding them, the test must fail rather than pass over an empty list
  // -- a coverage check that covers nothing is the failure mode to rule out.
  assert.ok(declared.length > 100, `only found ${declared.length} requirements in the PRD`);

  assert.deepEqual(
    declared.filter((id) => !accounted.has(id)),
    [],
    'declared in the PRD and graded nowhere in the status table',
  );

  // And the other direction: a row claiming a requirement the PRD does not
  // have is a citation that will send somebody looking for nothing.
  assert.deepEqual(
    [...accounted].filter((id) => !declared.includes(id)).sort(byRequirementNumber),
    [],
    'graded in the status table and not declared by the PRD',
  );
});
