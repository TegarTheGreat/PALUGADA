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
 * So this reads the route patterns out of `src/owner/api.ts` and the route
 * modules beside it (`test/helpers/route-sources.ts`), reads the paths the
 * console fetches, and lists the ones the page never asks for.
 * Like the other guard, the list below is an inventory rather than an
 * exemption: an API-only route is a legitimate thing, and the reason it is one
 * is written next to it.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { routeFiles, routeSource } from '../helpers/route-sources.ts';

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
  // Not a page's at all: Telegram posts button presses here.
  'POST /api/channels/telegram':
    'machine: Telegram posts the owner\'s button presses here, authenticated by the webhook secret',
  'GET /api/channels/whatsapp':
    'machine: Meta checks the webhook subscription here, with the verify token',
  'POST /api/channels/whatsapp':
    'machine: Meta posts what the owner sends on WhatsApp here, signed with the app secret',
  'POST /api/hooks/:publicId':
    'machine: another service posts its events here, authenticated by the trigger\'s token',
  'POST /api/chat-hooks/:publicId':
    'machine: Telegram or Meta posts what a customer writes to the company here, authenticated by the channel\'s secret or Meta\'s signature',
  'GET /api/chat-hooks/:publicId':
    'machine: Meta checks a customer number\'s webhook subscription here, with the channel\'s verify token',
  'GET /api/oauth/callback':
    'machine: an authorization server sends the owner\'s browser back here with a code, checked against the state the console began',
  'GET /api/health':
    'machine: a supervisor or a load balancer asks whether this process can work',
  'GET /api/ready':
    'machine: a load balancer asks whether to send this process requests, which it is told not to from the moment the process begins to stop',
  'GET /api/metrics':
    'machine: a Prometheus scraper reads what the deployment is doing, with a token of its own',
};

const PATTERN = /method: '([A-Z]+)',\s*\n\s*pattern: '([^']+)'/g;

/**
 * What the page fetches, as route patterns.
 *
 * Read from every `api('METHOD', '/api/...')` call in `console/src`, and
 * every `live('GET', '/api/...')` that listens to a stream. The
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
  // `live(...)` is the same call for a stream of events (console/src/api.ts).
  for (const match of expanded.matchAll(/\b(?:api|live)\(\s*'([A-Z]+)'\s*,\s*['`](\/api\/[^'`]*)['`]/g)) {
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
  const routes = [...(await routeSource()).matchAll(PATTERN)].map((match) => [match[1]!, match[2]!] as const);
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

/**
 * The scans above read routes where they are written. A route module that
 * `#buildRoutes` does not spread serves nothing however well it is tested, and
 * a route written anywhere else is one no scan reads -- not the console's, not
 * a seat's list, not the assistant's.
 */
test('the route scan reads every route module', async () => {
  const files = await routeFiles();
  const modules = [...files.keys()].filter((path) => path.startsWith('src/owner/routes/'));
  assert.ok(modules.length >= 7, `only ${modules.length} route modules were found; the scan is broken`);
  const api = files.get('src/owner/api.ts')!;
  const build = api.slice(api.indexOf('#buildRoutes(): Route[]'), api.indexOf('#kit(): RouteKit'));
  assert.ok(build.length > 0, 'src/owner/api.ts keeps #buildRoutes, then #kit');
  for (const path of modules) {
    const made = [...files.get(path)!.matchAll(/^export function (\w+Routes)\(/gm)].map((match) => match[1]!);
    assert.equal(made.length, 1, `${path} exports one function that makes its routes, named for its area`);
    assert.match(build, new RegExp(`\\.\\.\\.${made[0]}\\(kit\\)`), `${path}: #buildRoutes does not serve ${made[0]}`);
  }

  // Every route in those files is written in the one form the scans read:
  // `method: 'X',` with `pattern: '…',` on the next line, in single quotes.
  // `#match` serves a route however it is spelt, so one written otherwise --
  // a comment between the two lines, a pattern in backticks, a route on one
  // line -- would be served and read by no scan: not pressed, on no seat's
  // list, never kept from the assistant. So in these files `pattern:` is a
  // route's, and every one is read.
  for (const [path, text] of files) {
    const written = (text.match(/\bpattern\s*:/g) ?? []).length;
    const read = [...text.matchAll(PATTERN)].length;
    assert.equal(read, written, `${path}: ${written - read} of its ${written} routes are not written as \`method: 'X',\` with \`pattern: '…',\` on the next line`);
  }

  // No route is written outside the files the scans read.
  const elsewhere: string[] = [];
  const walk = async (directory: string): Promise<void> => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) await walk(path);
      else if (entry.name.endsWith('.ts')) {
        const name = path.slice(ROOT.length).replace(/^\//, '');
        if (!files.has(name) && /method: '[A-Z]+',\s*\n\s*pattern: '/.test(await readFile(path, 'utf8'))) elsewhere.push(name);
      }
    }
  };
  await walk(join(ROOT, 'src'));
  assert.deepEqual(elsewhere, [], 'routes written where no route test reads them');
});

/**
 * Pairs of routes that one path matches, each with why the path both match
 * is not a request anybody makes. `#match` takes the first route that fits, so
 * any other such pair is a route that can never be reached by the path it was
 * written for.
 */
const SHARED_PATHS: Record<string, string> = {
  'POST /api/control/channels/chat/:kind ~ /api/control/channels/:name/clear':
    'the one path both match, /api/control/channels/chat/clear, is neither: no chat kind is called clear, and no channel is called chat',
};

/**
 * New routes avoid one another by name -- `room-stream`, `direct-rooms`,
 * `staff-batch` -- rather than by their order in the file, because `#match`
 * takes the first route that fits and a parameter takes any literal. So for
 * each pair of one method and one length, some position must hold two
 * different literals.
 */
test('no two routes of one method match the same path', async () => {
  const routes = [...(await routeSource()).matchAll(PATTERN)].map((match) => [match[1]!, match[2]!] as const);
  assert.ok(routes.length > 200, `only ${routes.length} routes were found; the scan is broken`);
  const shared: string[] = [];
  for (const [index, [method, pattern]] of routes.entries()) {
    const segments = pattern.split('/').filter(Boolean);
    for (const [otherMethod, other] of routes.slice(index + 1)) {
      const others = other.split('/').filter(Boolean);
      if (otherMethod !== method || others.length !== segments.length) continue;
      const apart = segments.some((segment, at) => !segment.startsWith(':') && !others[at]!.startsWith(':') && segment !== others[at]);
      if (!apart) shared.push(`${method} ${pattern} ~ ${other}`);
    }
  }
  assert.deepEqual(shared.filter((pair) => !(pair in SHARED_PATHS)), [],
    'two routes one path reaches: name the new one apart, with a literal where the other has a different one');
  assert.deepEqual(Object.keys(SHARED_PATHS).filter((pair) => !shared.includes(pair)), [],
    'recorded as sharing a path and no longer do: strike these off');
});
