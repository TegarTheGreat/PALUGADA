/**
 * What the workspace's routes answer with, as the server writes it and as the
 * console reads it (F19; STATUS 2.203).
 *
 * The rooms' server and the rooms' console are built side by side, against
 * `src/workspace/contract.ts` and its mirror `console/src/workspace/types.ts`.
 * The console cannot import from `src/` (it is built by Vite from its own
 * folder), so the two are written twice, and this holds them to one shape:
 * the same types, the same fields, field by field. A field added on one side
 * only is a page that draws nothing, or a server that sends what nobody reads.
 *
 * And the refusals the workspace answers with: each has its status in the
 * owner API, and its sentence in the console, so the owner never reads the
 * server's English.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));

/** Each exported type of a file, by name, as its text with comments and spacing taken out. */
function typesIn(source: string): Map<string, string> {
  const bare = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
  const types = new Map<string, string>();
  const starts = [...bare.matchAll(/^export type (\w+)\s*=/gm)];
  for (const [index, start] of starts.entries()) {
    const end = starts[index + 1]?.index ?? bare.length;
    types.set(start[1]!, bare.slice(start.index + start[0].length, end).replace(/\s+/g, ''));
  }
  return types;
}

/** The fields a type names, in order: what a reader of a mismatch wants to see first. */
function fieldsOf(body: string): string[] {
  return [...body.matchAll(/(\w+)\??:/g)].map((match) => match[1]!);
}

test("the console's workspace types mirror the server's, field by field", async () => {
  const server = typesIn(await readFile(`${ROOT}src/workspace/contract.ts`, 'utf8'));
  const console_ = typesIn(await readFile(`${ROOT}console/src/workspace/types.ts`, 'utf8'));
  assert.ok(server.size >= 14, `only ${server.size} types were found in src/workspace/contract.ts; the scan is broken`);
  assert.deepEqual([...console_.keys()].sort(), [...server.keys()].sort(), 'the two files name different types');
  for (const [name, body] of server) {
    assert.deepEqual(fieldsOf(console_.get(name)!), fieldsOf(body), `${name}: the console reads other fields than the server sends`);
    assert.equal(console_.get(name), body, `${name}: the same fields, typed differently`);
  }

  // The server's side is types alone: it imports nothing and makes nothing,
  // so the rooms' console can be written against it before the server exists.
  const module = await import('../../src/workspace/contract.ts');
  assert.deepEqual(Object.keys(module), [], 'src/workspace/contract.ts exports a value');
  assert.doesNotMatch(await readFile(`${ROOT}src/workspace/contract.ts`, 'utf8'), /^import /m, 'src/workspace/contract.ts imports');
});

test('every refusal the workspace answers with has a status, and a sentence for the owner', async () => {
  const api = await readFile(`${ROOT}src/owner/api.ts`, 'utf8');
  const start = api.indexOf('const PEOPLE_REFUSALS');
  assert.ok(start > 0, 'src/owner/api.ts keeps PEOPLE_REFUSALS');
  const refusals = [...api.slice(start, api.indexOf('};', start)).matchAll(/^ {2}'([a-z_]+\.[a-z_]+)': (\d{3}),$/gm)]
    .map((match) => [match[1]!, Number(match[2])] as const);
  assert.ok(refusals.length >= 39, `only ${refusals.length} refusals were found; the scan is broken`);
  for (const [code, status] of refusals) assert.ok(status >= 400 && status < 600, `${code} answers ${status}`);

  const explained = await readFile(`${ROOT}console/src/api.ts`, 'utf8');
  const table = explained.slice(explained.indexOf('const EXPLAINED'), explained.indexOf('export function explain'));
  const said = new Set([...table.matchAll(/^ {2}'([a-z_.]+)': N\(/gm)].map((match) => match[1]!));
  assert.deepEqual(refusals.map(([code]) => code).filter((code) => !said.has(code)), [], 'refusals the owner would read in the server\'s English');

  // Each is a code a refusal can be thrown with (`ErrorCode`, src/errors.ts),
  // written there now, so no part built later edits that union for its own.
  const errors = await readFile(`${ROOT}src/errors.ts`, 'utf8');
  const union = errors.slice(errors.indexOf('export type ErrorCode'), errors.indexOf('export class PalugadaError'));
  const codes = new Set([...union.matchAll(/^\s*\| '([a-z_.]+)'/gm)].map((match) => match[1]!));
  assert.ok(codes.size > 100, `only ${codes.size} error codes were found in src/errors.ts; the scan is broken`);
  assert.deepEqual(refusals.map(([code]) => code).filter((code) => !codes.has(code)), [], 'refusals no PalugadaError can be thrown with');
});
