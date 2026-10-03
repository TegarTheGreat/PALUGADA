/**
 * Every event the owner can see is said in words (the analysis of
 * 3 October, §2.3 item 7).
 *
 * The task timeline and **Lately** show the company's events, and an event
 * with no sentence was shown as its code made readable -- "Content read
 * outside", "Task running", "Budget halt raised" -- in English whatever the
 * console's language, beside the code of whoever wrote it: "engine",
 * "broker", "agent_run". So the server is read for every event type it
 * writes, and each must have a sentence in `console/src/format.ts`, which the
 * dictionaries translate (`console-i18n.test.ts`); and the timelines say who
 * acted in words.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { TASK_STATUSES } from '../../src/domain/task.ts';

const SERVER = fileURLToPath(new URL('../../src', import.meta.url));
const CONSOLE = fileURLToPath(new URL('../../console/src', import.meta.url));

/** The hook points whose refusals are written as `hook.<point>` (`src/engine/hooks.ts`). */
const HOOK_POINTS = ['pre_run', 'pre_tool', 'post_tool', 'post_run'];

/** What the governance log mirrors as `<subject>.<action>` (`record`, `src/governance/store.ts`). */
const GOVERNED = ['charter', 'policy'].flatMap((subject) => ['created', 'updated', 'deleted'].map((action) => `${subject}.${action}`));

async function files(directory: string, pattern: RegExp): Promise<Map<string, string>> {
  const found = new Map<string, string>();
  const walk = async (at: string): Promise<void> => {
    for (const entry of await readdir(at, { withFileTypes: true })) {
      const path = join(at, entry.name);
      if (entry.isDirectory()) await walk(path);
      else if (pattern.test(entry.name)) found.set(path, await readFile(path, 'utf8'));
    }
  };
  await walk(directory);
  return found;
}

/**
 * The object literal around `at` in `text`, braces counted (well enough for
 * this source, whose strings rarely hold one).
 */
function enclosing(text: string, at: number): string {
  let start = 0;
  for (let i = at - 1, depth = 0; i >= 0; i -= 1) {
    if (text[i] === '}') depth += 1;
    else if (text[i] === '{') {
      if (depth === 0) { start = i; break; }
      depth -= 1;
    }
  }
  let end = text.length;
  for (let i = at, depth = 0; i < text.length; i += 1) {
    if (text[i] === '{') depth += 1;
    else if (text[i] === '}') {
      if (depth === 0) { end = i + 1; break; }
      depth -= 1;
    }
  }
  return text.slice(start, end);
}

/**
 * The event types the server writes: every `word.word` literal given as a
 * `type:` or an `event:`, every one in a statement that inserts into
 * `events` itself, and the families written from a template -- a task's move
 * to each status, a hook's refusal at each point, and the governance log's
 * mirror. An object with a `level:` is a line of the operator's log, which
 * the owner never reads, and is left out.
 */
async function eventTypes(): Promise<Set<string>> {
  const types = new Set<string>();
  for (const text of (await files(SERVER, /\.ts$/)).values()) {
    for (const key of text.matchAll(/\b(?:type|event)\??:([^\n]*)/g)) {
      if (/\blevel:/.test(enclosing(text, key.index))) continue;
      for (const match of key[1]!.matchAll(/'([a-z][a-z_]*\.[a-z][a-z_]*)'/g)) {
        if (/\.(jpg|jpeg|png|svg|json|ts|js|md|html|css|txt|pdf)$/.test(match[1]!)) continue;
        types.add(match[1]!);
      }
    }
  }
  for (const text of (await files(SERVER, /\.ts$/)).values()) {
    for (const insert of text.matchAll(/INSERT INTO events\b[^`]*/g)) {
      for (const match of insert[0].matchAll(/'([a-z][a-z_]*\.[a-z][a-z_]*)'/g)) types.add(match[1]!);
    }
  }
  for (const status of TASK_STATUSES) types.add(`task.${status}`);
  for (const point of HOOK_POINTS) types.add(`hook.${point}`);
  for (const governed of GOVERNED) types.add(governed);
  return types;
}

test('every event the server writes has a sentence for the owner', async () => {
  const format = await readFile(join(CONSOLE, 'format.ts'), 'utf8');
  const table = format.slice(format.indexOf('const EVENT_SENTENCES'), format.indexOf('export function eventSentence'));
  assert.ok(table.length > 0, 'console/src/format.ts keeps EVENT_SENTENCES');
  const said = new Set([...table.matchAll(/^ {2}'([a-z_.]+)': N\(/gm)].map((match) => match[1]!));
  const types = await eventTypes();
  assert.ok(types.size > 100, `found only ${types.size} event types; the scan has stopped finding them`);
  const missing = [...types].filter((type) => !said.has(type)).sort();
  assert.deepEqual(missing, [], `events shown to the owner as code: ${missing.join(', ')}`);
});

test('the timelines say who acted in words, not as the code that wrote it', async () => {
  for (const [path, text] of await files(join(CONSOLE, 'pages'), /\.tsx$/)) {
    assert.doesNotMatch(text, /(?<!\$)\{(event|row)\.actor\}/, `${path} shows who acted as their code`);
    assert.doesNotMatch(text, /(?<!\$)\{row\.action\}/, `${path} shows what was done as its code`);
  }
});

/**
 * A capability is named for what it does (§2.3 item 7): an approval asked
 * the owner to approve "record.delete", and the timeline badged its events
 * "crm.note". Every capability the catalogue knows has a name in
 * `console/src/format.ts`.
 */
test('every capability in the catalogue has a name the owner reads', async () => {
  const catalogue = await readFile(join(SERVER, 'broker', 'catalogue.ts'), 'utf8');
  const names = [...catalogue.matchAll(/^ {4}name: '([a-z][a-z_.]*)',$/gm)].map((match) => match[1]!);
  assert.ok(names.length >= 40, `found only ${names.length} capabilities in the catalogue`);
  const format = await readFile(join(CONSOLE, 'format.ts'), 'utf8');
  const table = format.slice(format.indexOf('const CAPABILITY_NAMES'), format.indexOf('export function capabilitySaid'));
  assert.ok(table.length > 0, 'console/src/format.ts keeps CAPABILITY_NAMES');
  const named = new Set([...table.matchAll(/^ {2}'([a-z_.]+)': N\(/gm)].map((match) => match[1]!));
  const missing = names.filter((name) => !named.has(name)).sort();
  assert.deepEqual(missing, [], `capabilities shown to the owner by their code: ${missing.join(', ')}`);
});
