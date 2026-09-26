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
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
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
  // Recategorised, because the first version of this list called them
  // `machine` and that was flattering. A WebAuthn assertion *is* built by the
  // browser's credential API -- but the browser in question is this page, so
  // "a program is the caller" was describing the page as though it were
  // somebody else. They are `todo`: the platform verifies a passkey and the
  // console cannot present one.
  //
  // Not written blind, either. `navigator.credentials.get` needs a secure
  // context and an `rpId` that matches where the console is served from, and
  // no browser runs in this environment -- so code written here would be an
  // unverified claim in the one place this repository has been most careful
  // not to make them. It is a `todo` until somebody can watch it work.
  'GET /api/auth/challenge':
    'todo: signing in with a passkey rather than a code; the platform verifies '
    + 'one and the page cannot present one',
  'GET /api/mfa/challenge':
    'todo: the same, for a second factor at the moment of a decision',
  // Not a page's at all: Telegram posts button presses here.
  'POST /api/channels/telegram':
    'machine: Telegram posts the owner\'s button presses here, authenticated by the webhook secret',
  'POST /api/hooks/:publicId':
    'machine: another service posts its events here, authenticated by the trigger\'s token',
};

const PATTERN = /method: '([A-Z]+)',\s*\n\s*pattern: '([^']+)'/g;

/**
 * What the page fetches, as route patterns.
 *
 * Read from every `api('METHOD', '/api/...')` call in `console/src`. The
 * console writes each path out in full at the call, never in a variable, so
 * that this reading is complete (see `console/src/api.ts`).
 */
async function pathsThePageFetches(): Promise<Set<string>> {
  // Every source file of the console, read as one: a route pressed from any
  // page is pressed.
  const page = (await Promise.all(
    (await readdir(join(ROOT, 'console', 'src'), { recursive: true }))
      .filter((file) => /\.(ts|tsx)$/.test(file))
      .map((file) => readFile(join(ROOT, 'console', 'src', file), 'utf8')),
  )).join('\n');
  assert.ok(page.length > 10_000, 'the console source was not found; the scan is broken');
  const expanded = page;
  const found = new Set<string>();
  // The method travels with the path. Without it a `POST /goals/:id` makes a
  // `GET /goals/:id` look pressed, and the guard reports a button that is not
  // there -- which is the one way this test could be worse than nothing.
  for (const match of expanded.matchAll(/api\(\s*'([A-Z]+)'\s*,\s*['`](\/api\/[^'`]*)['`]/g)) {
    found.add(`${match[1]!} ${normalise(match[2]!)}`);
  }
  return found;
}

/**
 * A path with every id and every `${...}` reduced to the same placeholder,
 * and without its query: `/work?group=done` presses `/work`.
 */
function normalise(path: string): string {
  return path.split('?')[0]!.replace(/\$\{[^}]*\}/g, ':x').replace(/:[A-Za-z]\w*/g, ':x');
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
