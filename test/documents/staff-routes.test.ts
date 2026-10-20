/**
 * Every read of the owner API is put on one list or the other for a staff
 * seat (src/owner/staff-policy.ts), so a route added tomorrow is a decision
 * somebody made rather than one nobody did.
 *
 * Nothing is reachable by a seat unless it is listed: a route on neither list
 * is refused to staff anyway. What this holds is the other half -- that the
 * lists name real routes, that no read is on both, and that every read was
 * looked at and either given to staff or kept from them with a reason.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { STAFF_DECIDES, STAFF_HIDDEN, STAFF_READS } from '../../src/owner/staff-policy.ts';

const API = fileURLToPath(new URL('../../src/owner/api.ts', import.meta.url));

async function routes(): Promise<Array<{ method: string; pattern: string; open: boolean }>> {
  const source = await readFile(API, 'utf8');
  return [...source.matchAll(/method: '(GET|POST)',\s*\n\s*pattern: '([^']+)',(\s*\n\s*open: true)?/g)]
    .map((match) => ({ method: match[1]!, pattern: match[2]!, open: Boolean(match[3]) }));
}

test('every read of the owner API is given to staff or kept from them, with a reason', async () => {
  const all = await routes();
  assert.ok(all.length > 150, `only ${all.length} routes were found; the scan is broken`);
  const reads = all.filter((route) => route.method === 'GET' && !route.open).map((route) => route.pattern);
  const unlisted = reads.filter((pattern) => !STAFF_READS.includes(pattern) && !(pattern in STAFF_HIDDEN));
  assert.deepEqual(unlisted, [], `reads no list names: put each on STAFF_READS or STAFF_HIDDEN (src/owner/staff-policy.ts)`);
  const both = STAFF_READS.filter((pattern) => pattern in STAFF_HIDDEN);
  assert.deepEqual(both, [], 'a read is given and kept at once');
  const gets = new Set(all.filter((route) => route.method === 'GET').map((route) => route.pattern));
  const posts = new Set(all.filter((route) => route.method === 'POST').map((route) => route.pattern));
  assert.deepEqual([...STAFF_READS, ...Object.keys(STAFF_HIDDEN)].filter((pattern) => !gets.has(pattern)), [], 'the lists name only real reads');
  assert.deepEqual(STAFF_DECIDES.filter((pattern) => !posts.has(pattern)), [], 'and only real actions');
});

test('a seat is given nothing of the deployment, its devices or its keys', () => {
  const owners = STAFF_READS.filter((pattern) =>
    /^\/api\/(control\/(settings|channels|tools|mcp|vendors|agents|setup|tour|cost)|mfa|publishers|erasures|search|runtimes|assistant)/.test(pattern)
    || /credentials|export|conversation|\/staff$/.test(pattern));
  assert.deepEqual(owners, []);
  // An approver's actions are the inbox's, and nothing else.
  assert.ok(STAFF_DECIDES.every((pattern) => pattern.startsWith('/api/companies/:companyId/inbox/')));
});
