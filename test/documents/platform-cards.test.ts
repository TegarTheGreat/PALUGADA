/**
 * No card the platform raises is written in English at the place it is raised
 * (the analysis of 3 October, §2.3 item 7).
 *
 * The platform's incidents, escalations, alerts and approvals were literals
 * at each call -- `title: \`Role ${slug} is frozen...\`` -- so they reached the
 * owner in English whatever the owner read. They are composed in the owner's
 * language in `src/owner/platform-cards.ts` and handed to the inbox. This
 * reads every call that raises one and refuses a literal for what the owner
 * reads on the card.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));

/**
 * Calls whose words no owner reads yet, each with why. A card added to one
 * of these files, or one of these made reachable, is composed like the rest.
 */
const NOT_YET_SHOWN: Record<string, string> = {
  // Nothing proposes a structural change outside the tests: the console has
  // no way to (reachability.test.ts, proposeStructuralChange).
  'src/governance/structure.ts': 'proposeStructuralChange is reachable only from tests',
};

async function sources(directory: string): Promise<string[]> {
  const found: string[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) found.push(...await sources(path));
    else if (entry.name.endsWith('.ts')) found.push(path);
  }
  return found;
}

/** The text of a call from its opening parenthesis to the one that closes it. */
function callAt(source: string, open: number): string {
  let depth = 0;
  for (let at = open; at < source.length; at += 1) {
    const char = source[at];
    if (char === '(') depth += 1;
    else if (char === ')' && (depth -= 1) === 0) return source.slice(open, at + 1);
  }
  return source.slice(open);
}

test('every card the platform raises is composed in the owner\'s language, not written in English where it is raised', async () => {
  const raising = /\b(raiseIncident|raiseIncidentWithin|raiseEscalation|raiseEscalationWithin|raiseBudgetAlert|requestApproval)\(/g;
  const owned = /\b(title|detail|rationale|consequenceIfDenied):\s*[`'"]/;
  const literal: string[] = [];
  let calls = 0;
  for (const path of await sources(join(ROOT, 'src'))) {
    const file = relative(ROOT, path);
    if (file in NOT_YET_SHOWN) continue;
    const source = await readFile(path, 'utf8');
    for (const match of source.matchAll(raising)) {
      // The declaration of the function itself is not a call.
      if (/function\s+$/.test(source.slice(Math.max(0, match.index - 20), match.index))) continue;
      calls += 1;
      const call = callAt(source, match.index + match[0].length - 1);
      const found = call.match(owned);
      if (found) literal.push(`${file}:${source.slice(0, match.index).split('\n').length} ${found[1]}`);
    }
  }
  assert.ok(calls >= 20, `only ${calls} calls were found; the scan is broken`);
  assert.deepEqual(literal, [], `cards written in English where they are raised:\n${literal.join('\n')}`);
});
