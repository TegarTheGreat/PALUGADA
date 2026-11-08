/**
 * The boundary between the people's workspace and everything else (F19; the
 * workspace plan, invariants I1, I8, I10 and I11).
 *
 * The database holds most of it: a room table answers only a transaction that
 * names a reader, and only `src/db/tenant.ts` names one (people-rls.test.ts).
 * What the database cannot see is which code opens such a transaction, which
 * code names a room table at all, and which code could carry a person's words
 * to a model. So the source is read for each of those here.
 *
 * Each scan has a floor: a scan that finds nothing is broken, not clean. A
 * floor is raised by the set that first gives its scan something to find, and
 * never lowered.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { unreadable } from '../../src/owner/assistant-actions.ts';
import { routeFiles } from '../helpers/route-sources.ts';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));

/** Every TypeScript file under `directory`, by its path from the repository's root, with its text. */
async function sources(directory: string): Promise<Map<string, string>> {
  const found = new Map<string, string>();
  const walk = async (at: string): Promise<void> => {
    let entries;
    try {
      entries = await readdir(at, { withFileTypes: true });
    } catch {
      return; // A folder a later set makes (src/relay/) is simply not there yet.
    }
    for (const entry of entries) {
      const path = join(at, entry.name);
      if (entry.isDirectory()) await walk(path);
      else if (/\.tsx?$/.test(entry.name)) found.set(relative(ROOT, path), await readFile(path, 'utf8'));
    }
  };
  await walk(join(ROOT, directory));
  return found;
}

/** The text with its comments taken out, so a sentence about a helper is not a call of it. */
function code(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`\\])\/\/[^\n]*/g, '$1');
}

/**
 * Who may open which reader (the workspace plan, §5.2). Routes get
 * `withPeople` only; delivery reads ids and positions for the hub, the
 * notices and the relay; the platform reader is the card sweep's and the
 * rooms every company has.
 */
const MAY_OPEN: Record<string, readonly string[]> = {
  withPeople: ['src/workspace/', 'src/relay/', 'src/owner/routes/', 'src/owner/people-said.ts', 'src/owner/member-notify.ts'],
  withDelivery: ['src/workspace/hub.ts', 'src/owner/member-notify.ts', 'src/relay/people.ts'],
  withRoomPlatform: ['src/workspace/cards.ts', 'src/workspace/rooms.ts'],
};

/** How many calls of the helpers the people's code makes now. The rooms' server (S3) raises it to 10. */
const HELPER_CALLS_AT_LEAST = 0;

test("only the people's code opens a room transaction, and only tenant.ts names a reader", async () => {
  const all = await sources('src');
  assert.ok(all.size > 200, `only ${all.size} files were read; the scan is broken`);

  // The settings a room table's policies and triggers read, set in one place.
  const settings = ["set_config('app.reader'", "'app.principal'", "'app.principal_name'", "'app.via'", "'app.via_relay'", "'app.importing'"];
  for (const setting of settings) {
    const where = [...all].filter(([, text]) => text.includes(setting)).map(([path]) => path);
    assert.deepEqual(where.filter((path) => path !== 'src/db/tenant.ts'), [], `${setting} is set outside src/db/tenant.ts`);
  }
  const named = (all.get('src/db/tenant.ts') ?? '').split("set_config('app.reader'").length - 1;
  assert.ok(named >= 1, "src/db/tenant.ts no longer names a reader; the scan is broken");

  let calls = 0;
  const strays: string[] = [];
  for (const [path, text] of all) {
    if (path === 'src/db/tenant.ts') continue;
    for (const [helper, allowed] of Object.entries(MAY_OPEN)) {
      const found = (code(text).match(new RegExp(`\\b${helper}\\s*(?:<[^>]*>)?\\(`, 'g')) ?? []).length;
      if (found === 0) continue;
      if (allowed.some((prefix) => path === prefix || (prefix.endsWith('/') && path.startsWith(prefix)))) calls += found;
      else strays.push(`${path} calls ${helper}`);
    }
  }
  assert.deepEqual(strays, [], 'a room transaction opened outside the people\'s code');
  assert.ok(calls >= HELPER_CALLS_AT_LEAST, `the people's code calls the helpers ${calls} times, fewer than ${HELPER_CALLS_AT_LEAST}`);
});

/** The room tables, as the migrations make them: a table a later set adds is held at once. */
async function roomTables(): Promise<string[]> {
  const tables = new Set<string>();
  for (const name of await readdir(join(ROOT, 'db', 'migrations'))) {
    const text = await readFile(join(ROOT, 'db', 'migrations', name), 'utf8');
    for (const match of text.matchAll(/CREATE TABLE (rooms|room_[a-z_]+)\b/g)) tables.add(match[1]!);
  }
  return [...tables].sort();
}

/** Where an agent's work runs: what a run is told, what it calls, and what wakes it. */
const AGENT_PATH = ['src/engine', 'src/broker', 'src/runtime', 'src/context', 'src/capabilities', 'src/scheduler', 'src/inbox'];

test("no code on an agent's path names a room table", async () => {
  const tables = await roomTables();
  assert.ok(tables.length >= 13, `only ${tables.length} room tables were found in the migrations; the scan is broken`);
  // `rooms` is also an English word, so it counts only where SQL names a table.
  const others = tables.filter((table) => table !== 'rooms');
  const named = new RegExp(`\\b(${others.join('|')})\\b|\\b(FROM|JOIN|INTO|UPDATE|TABLE|REFERENCES)\\s+rooms\\b`, 'i');
  let read = 0;
  const found: string[] = [];
  for (const directory of AGENT_PATH) {
    for (const [path, text] of await sources(directory)) {
      read += 1;
      const match = named.exec(text);
      if (match) found.push(`${path}: ${match[0]}`);
    }
  }
  assert.ok(read > 80, `only ${read} files on an agent's path were read; the scan is broken`);
  assert.deepEqual(found, [], 'a room table named where an agent\'s work runs');
});

/**
 * Room activity is never an event (AGENTS.md): every seat reads the journal,
 * and so does the context builder. Only a door that turns a message into work
 * writes one, and only these four.
 */
const DOOR_EVENTS = ['task.given_in_room', 'content.staff_said', 'staff.instructed', 'meeting.called'];
/** How many events the doors write now. The rooms' server (S3) raises it to 4. */
const DOOR_EVENTS_AT_LEAST = 0;

test("appendEvent in the workspace is the doors', with four types", async () => {
  const workspace = await sources('src/workspace');
  assert.ok(workspace.size >= 1, 'src/workspace/ was not read; the scan is broken');
  const strays = [...workspace].filter(([path, text]) => path !== 'src/workspace/doors.ts' && /\bappendEvent\b/.test(code(text)))
    .map(([path]) => path);
  assert.deepEqual(strays, [], 'an event written by the workspace outside its doors');
  const doors = code(workspace.get('src/workspace/doors.ts') ?? '');
  const written = (doors.match(/\bappendEvent\s*\(/g) ?? []).length;
  assert.ok(written >= DOOR_EVENTS_AT_LEAST, `the doors write ${written} events, fewer than ${DOOR_EVENTS_AT_LEAST}`);
  const types = [...doors.matchAll(/\btype:\s*'([a-z_]+\.[a-z_]+)'/g)].map((match) => match[1]!);
  assert.deepEqual(types.filter((type) => !DOOR_EVENTS.includes(type)), [], 'a door writes an event that is not one of its four');
});

test('nothing in the workspace or the relay imports a model client', async () => {
  const files = new Map([...await sources('src/workspace'), ...await sources('src/relay')]);
  assert.ok(files.size >= 1, 'src/workspace/ was not read; the scan is broken');
  const found: string[] = [];
  for (const [path, text] of files) {
    for (const match of text.matchAll(/\bfrom\s+'([^']+)'|\bimport\(\s*'([^']+)'/g)) {
      const from = match[1] ?? match[2]!;
      if (/(^|\/)llm\/|\/owner\/assistant\.ts$|^\.\.\/owner\/assistant/.test(from)) found.push(`${path} imports ${from}`);
    }
  }
  assert.deepEqual(found, [], 'the workspace and the relay call no model: no person\'s words reach one from here');
});

/**
 * A reaction is a person's, and is never read as a decision (I4). Outside the
 * workspace only the control plane's copy of a company -- its export, its
 * restore, its retention -- touches the table, and none of them decides.
 */
const READ_REACTIONS = ['src/workspace/', 'src/audit/export.ts', 'src/audit/import.ts', 'src/retention/'];

test('no file outside the workspace reads reactions', async () => {
  const all = await sources('src');
  const found = [...all].filter(([path, text]) => /\broom_reactions\b/.test(text)
    && !READ_REACTIONS.some((prefix) => path === prefix || (prefix.endsWith('/') && path.startsWith(prefix))))
    .map(([path]) => path);
  assert.deepEqual(found, [], 'reactions read where they could be taken for a decision');
});

/** The route modules whose reads carry people's words, and which the assistant may therefore never read. */
const PEOPLE_MODULES = ['rooms', 'people', 'find', 'relay', 'imports', 'meetings'];

test("every read that reaches people's words is closed to the assistant", async () => {
  const files = await routeFiles();
  for (const area of PEOPLE_MODULES) {
    assert.ok(files.has(`src/owner/routes/${area}.ts`), `src/owner/routes/${area}.ts is not there; the scan is broken`);
  }
  const readable: string[] = [];
  for (const area of PEOPLE_MODULES) {
    const text = files.get(`src/owner/routes/${area}.ts`)!;
    // An open route is not the assistant's to call at all: its dispatch refuses one.
    for (const match of text.matchAll(/method: 'GET',\s*\n\s*pattern: '([^']+)',(\s*\n\s*open: true)?/g)) {
      if (!match[2] && !unreadable(match[1]!)) readable.push(`${area}.ts: GET ${match[1]}`);
    }
  }
  assert.deepEqual(readable, [], 'a read of people\'s words the assistant could make: put it under UNREADABLE_UNDER');

  // No handler of the API's own opens a person's transaction: the people's
  // routes live in their modules, which the line above reads.
  const api = files.get('src/owner/api.ts')!;
  assert.doesNotMatch(code(api), /\bwithPeople\b/, 'src/owner/api.ts opens a person\'s transaction');

  // The assistant's two gates -- the reads its prompt lists, and the read it
  // makes -- ask the same question.
  const assistant = code(await readFile(join(ROOT, 'src', 'owner', 'assistant.ts'), 'utf8'));
  assert.equal((assistant.match(/\bunreadable\(/g) ?? []).length, 2, 'both of the assistant\'s gates ask unreadable()');
  assert.doesNotMatch(assistant, /UNREADABLE\.includes/, 'a gate that reads only the exact list misses a whole area');

  // And whatever the lists say, a route the assistant calls runs inside the
  // scope the people's helpers refuse: a people's route somebody forgot to
  // list still answers the assistant with a refusal.
  const dispatch = api.slice(api.indexOf('async #dispatch('), api.indexOf('async #mcpToken('));
  assert.ok(dispatch.length > 0, 'src/owner/api.ts keeps #dispatch');
  assert.match(code(dispatch), /assistantDispatch\.run\(true,/, "the assistant's dispatch runs outside the scope the people's helpers refuse");
});

test('the console registers no service worker', async () => {
  const files = new Map([...await sources('console/src')]);
  assert.ok(files.size > 20, `only ${files.size} console files were read; the scan is broken`);
  files.set('console/index.html', await readFile(join(ROOT, 'console', 'index.html'), 'utf8'));
  for (const name of await readdir(join(ROOT, 'console', 'public'))) {
    if (/\.(js|mjs|webmanifest|json|html)$/.test(name)) files.set(`console/public/${name}`, await readFile(join(ROOT, 'console', 'public', name), 'utf8'));
  }
  // A worker outlives the tab and keeps what it fetched: the console keeps
  // nothing in the browser, and a closed tab notifies nobody.
  const found = [...files].filter(([, text]) => /serviceWorker|ServiceWorker|importScripts/.test(text)).map(([path]) => path);
  assert.deepEqual(found, []);
  assert.deepEqual((await readdir(join(ROOT, 'console', 'public'))).filter((name) => /^(sw|service-worker|worker)\.m?js$/.test(name)), []);
});
