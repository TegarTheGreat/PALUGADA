/**
 * Every route the owner's API offers has a way to press it (PRD v2 F10, §10).
 *
 * `reachability.test.ts` catches machinery in `src/` that nothing assembles.
 * It cannot see one storey up: the API is reached from `console/`, which that
 * scan does not read -- so a route could be built, tested, documented and
 * still have no button, which is the same defect wearing a different coat. It
 * had happened: fifty-two of sixty-one routes were unreachable from the page
 * when this test was written.
 *
 * So this reads the route patterns out of `src/owner/api.ts`, reads the paths
 * `console/console.js` fetches, and lists the ones the page never asks for.
 * Like the other guard, the list below is an inventory rather than an
 * exemption: an API-only route is a legitimate thing, and the reason it is one
 * is written next to it.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));

/**
 * Routes the console deliberately does not call, and why.
 *
 * Three reasons:
 *
 * - `machine` -- the caller is a program rather than a person: a device
 *   signing in, a script exporting, another surface entirely.
 * - `flow` -- the page reaches it through another route rather than directly,
 *   so a button would be a second way to do one thing.
 * - `todo` -- it has no button and should have one. Nothing may sit here
 *   without a sentence saying what the button would be.
 */
const API_ONLY: Record<string, string> = {
  'GET /api/auth/challenge':
    'machine: a WebAuthn assertion is built by the browser\'s own credential API, '
    + 'which this page does not use yet -- it signs in with a code',
  'GET /api/mfa/challenge':
    'machine: the same challenge, for the same reason',
  'GET /api/mfa/authenticators':
    'todo: a list of the owner\'s own devices, with a button to revoke one',
  'GET /api/companies/:companyId/retro':
    'todo: F9.4\'s weekly retro, alongside the daily digest',
  'POST /api/control/company/:companyId/freeze':
    'todo: a freeze button per company in the company tabs',
  'POST /api/control/capability/:name/kill':
    'todo: F8.13\'s kill switch, on the health panel next to the capability',
  'POST /api/control/company/:companyId/role/:roleId/resume':
    'todo: a resume button wherever a frozen role is shown',
  'GET /api/companies/:companyId/tasks/:taskId/events':
    'flow: the decisions panel reaches a task\'s history through the trace '
    + 'route, which starts from the item the owner is looking at',
  'POST /api/companies/:companyId/divisions/:divisionId/credentials/:alias/rotate':
    'todo: rotation belongs on a credentials panel, which needs a route that '
    + 'lists a division\'s aliases first',
  'GET /api/companies/:companyId/goals/:goalId':
    'flow: the structure panel edits a goal by id rather than browsing the '
    + 'ladder, which needs a listing route',
  'GET /api/companies/:companyId/roles/:roleId/evals':
    'todo: F17\'s eval set, once there is a roles panel to hang it from',
  'POST /api/companies/:companyId/evals/:caseId/accept':
    'todo: the same panel',
  'POST /api/companies/:companyId/roles/:roleId/change-request':
    'todo: the same panel; the owner changes a role directly today',
};

const PATTERN = /method: '([A-Z]+)',\s*\n\s*pattern: '([^']+)'/g;

/**
 * What the page fetches, as route patterns.
 *
 * `company()` is a helper that builds `/api/companies/${state.companyId}`, so
 * a literal in the source reads `` `${company()}/spend` `` and does not start
 * with `/api/`. Expanded here rather than banned there: a helper that keeps
 * the company id out of forty template strings is the right shape, and a guard
 * that made the code worse to keep itself simple would be the wrong trade.
 */
async function pathsThePageFetches(): Promise<Set<string>> {
  const page = await readFile(new URL('../../console/console.js', import.meta.url), 'utf8');
  const expanded = page.replaceAll('${company()}', '/api/companies/:x');
  const found = new Set<string>();
  // The method travels with the path. Without it a `POST /goals/:id` makes a
  // `GET /goals/:id` look pressed, and the guard reports a button that is not
  // there -- which is the one way this test could be worse than nothing.
  for (const match of expanded.matchAll(/api\(\s*'([A-Z]+)'\s*,\s*['`](\/api\/[^'`]*)['`]/g)) {
    found.add(`${match[1]!} ${normalise(match[2]!)}`);
  }
  return found;
}

/** A path with every id and every `${...}` reduced to the same placeholder. */
function normalise(path: string): string {
  return path.replace(/\$\{[^}]*\}/g, ':x').replace(/:[A-Za-z]\w*/g, ':x');
}

test('every API route is either pressed by the console or recorded as API-only', async () => {
  const api = await readFile(new URL('../../src/owner/api.ts', import.meta.url), 'utf8');
  const routes = [...api.matchAll(PATTERN)].map((match) => [match[1]!, match[2]!] as const);
  assert.ok(routes.length > 40, `only ${routes.length} routes were found; the scan is broken`);

  const fetched = await pathsThePageFetches();
  const unpressed = routes
    .map(([method, pattern]) => [`${method} ${normalise(pattern)}`, `${method} ${pattern}`])
    .filter(([key]) => !fetched.has(key!))
    .map(([, shown]) => shown!);

  const undeclared = unpressed.filter((route) => !(route in API_ONLY));
  assert.deepEqual(
    undeclared, [],
    'built into the API and unreachable from the console. The owner is the only '
      + 'human here, so an operation they cannot press is one this platform does '
      + 'not really have. Give it a button, or record here why it is API-only:\n'
      + undeclared.map((route) => `  ${route}`).join('\n'),
  );

  const stale = Object.keys(API_ONLY).filter((route) => !unpressed.includes(route));
  assert.deepEqual(
    stale, [],
    'recorded as API-only and now pressed by the console, or no longer a route. '
      + 'Strike these off:\n' + stale.map((route) => `  ${route}`).join('\n'),
  );

  void ROOT;
});

test('nothing sits in the API-only list without a reason', () => {
  for (const [route, reason] of Object.entries(API_ONLY)) {
    assert.match(
      reason, /^(machine|flow|todo): ./,
      `${route} has no category; it must say why the page does not call it`,
    );
  }
});
