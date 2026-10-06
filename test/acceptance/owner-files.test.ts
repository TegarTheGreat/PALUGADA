/**
 * The owner hands the company a file and takes one out (the audit of 6
 * October, O3 and W2; STATUS 2.166).
 *
 * The company's files folder was something roles wrote into and the owner could
 * not see: a contract, a price list or a photo could reach a role only if a
 * person with a shell put it there, and a draft a role wrote could be read only
 * as text on a task page. The owner now puts a file in, lists the folders,
 * takes any file out and removes what they put in -- in the console, on a phone.
 *
 * What an uploaded file is, to the platform, is bytes the owner chose: kept
 * under a plain name in `uploads/`, never opened, run or unpacked here, and
 * downloaded as an octet stream. What reads it later (`files.read`) is a read
 * of outside content, as it is for every file, whoever put it there.
 */
import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { lstat, mkdir, mkdtemp, readdir, readFile, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { withTenant } from '../../src/db/tenant.ts';
import { closePools } from '../../src/db/pool.ts';
import { declarationFor } from '../../src/broker/catalogue.ts';
import { filesList, filesRead, plainFileName, UPLOAD_MAX_BYTES, UPLOAD_MAX_FILES } from '../../src/capabilities/files.ts';
import { createCompany, type Fixture } from '../helpers/fixtures.ts';
import { ensureSchema, resetData, closeSetup } from '../helpers/setup.ts';
import { consoleWithSettings } from '../helpers/owner-console.ts';
import { decodeBase32, stepFor, totpCode } from '../../src/owner/mfa.ts';

before(ensureSchema);
beforeEach(resetData);
after(async () => {
  await closePools();
  await closeSetup();
});

async function owned(options: { files?: boolean } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'palugada-owner-files-'));
  const fixture = await createCompany('owner-files');
  const api = await consoleWithSettings(options.files === false ? {} : { files: { root } });
  const owner = await api.signIn();
  const base = `/api/companies/${fixture.companyId}`;
  const put = (name: string, bytes: Buffer | string, extra: Record<string, unknown> = {}) =>
    api.call('POST', `${base}/files`, owner, { name, data: Buffer.from(bytes).toString('base64'), ...extra });
  const list = (path?: string) => api.call('GET', `${base}/files${path === undefined ? '' : `?path=${encodeURIComponent(path)}`}`, owner);
  const take = (path: string) => api.call('GET', `${base}/files/download?path=${encodeURIComponent(path)}`, owner);
  const remove = (path: string) => api.call('POST', `${base}/files/delete`, owner, { path });
  const mine = join(root, fixture.companyId);
  return { root, fixture, api, owner, base, put, list, take, remove, mine };
}

/** Every path under a folder, to see that nothing was written where it should not be. */
async function walk(directory: string): Promise<string[]> {
  const found: string[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true }).catch(() => [])) {
    const path = join(directory, entry.name);
    found.push(path);
    if (entry.isDirectory()) found.push(...await walk(path));
  }
  return found;
}

const uploadedEvents = (fixture: Fixture) => withTenant(fixture.companyId, (tx) => tx.query<{ type: string; actor: string; payload: Record<string, unknown> }>(
  "SELECT type, actor, payload FROM events WHERE type IN ('file.uploaded', 'file.deleted') ORDER BY occurred_at, id")).then((result) => result.rows);

test('the owner hands the company a file and takes it back, byte for byte, and a role that may read files can read it', async () => {
  const { api, fixture, root, put, list, take } = await owned();
  try {
    const bytes = randomBytes(5_000);
    const made = await put('Price List (final).xlsx', bytes);
    assert.equal(made.status, 200, JSON.stringify(made.body));
    assert.match(made.body.path, /^uploads\/[^/\\]+\.xlsx$/, 'a plain name in the folder for what the owner hands over');
    assert.equal(made.body.bytes, 5_000);
    assert.equal(made.body.sha256, createHash('sha256').update(bytes).digest('hex'));

    const top = await list();
    assert.equal(top.status, 200);
    assert.equal(top.body.available, true);
    assert.deepEqual(top.body.entries.map((entry: { name: string; kind: string }) => [entry.name, entry.kind]), [['uploads', 'directory']]);
    const inside = await list('uploads');
    assert.deepEqual(inside.body.entries.map((entry: { name: string; bytes: number }) => [`uploads/${entry.name}`, entry.bytes]), [[made.body.path, 5_000]]);

    const back = await take(made.body.path);
    assert.equal(back.status, 200, JSON.stringify(back.body));
    assert.deepEqual(Buffer.from(back.body.data, 'base64'), bytes, 'the same bytes');
    assert.equal(back.body.sha256, made.body.sha256);
    assert.equal(back.body.mime, 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');

    assert.deepEqual((await uploadedEvents(fixture)).map((event) => [event.type, event.actor, event.payload.path, event.payload.sha256]),
      [['file.uploaded', 'owner', made.body.path, made.body.sha256]], 'what was done is on the record, by path and hash and never by the raw name');

    // A role that is granted the two capabilities sees it, and reading it is a read of outside content, as it is for every file.
    const ctx = { companyId: fixture.companyId } as never;
    const seen = await filesList({ root }).execute({ path: 'uploads' }, ctx);
    assert.deepEqual(seen.entries.map((entry) => entry.name), [made.body.path.split('/')[1]]);
    await put('terms.txt', 'Payment within 30 days.\n');
    const read = await filesRead({ root }).execute({ path: 'uploads/terms.txt' }, ctx);
    assert.equal(read.text, 'Payment within 30 days.\n');
    assert.equal(declarationFor('files.read')?.readsOutside, true, 'and an uploaded contract is the classic carrier of an injection: nothing is trusted for being the owner\'s');
  } finally {
    await api.close();
  }
});

test('a name cannot choose where a file goes', async () => {
  const { api, put, mine, root, fixture } = await owned();
  try {
    const names = [
      '../../etc/x', 'a/b/c.txt', '..\\..\\windows\\x.txt', '.env', 'x‮gnp.exe', 'zero​width.txt', 'CON', 'nul.txt',
      'a\u0000b.txt', `${'n'.repeat(300)}.txt`, '...', '  ', 'Café.txt', 'Café.txt', 'x.<script>.html', 'file?.txt',
    ];
    const kept: string[] = [];
    for (const name of names) {
      const made = await put(name, `body of ${JSON.stringify(name)}`);
      if (made.status === 200) {
        assert.match(made.body.path, /^uploads\/[^/\\]+$/, `${JSON.stringify(name)} is kept directly in uploads`);
        assert.doesNotMatch(made.body.path, /[\u0000-\u001f\u007f‮​<>:"|?*\\]/, 'under a plain name');
        kept.push(made.body.path);
      } else {
        assert.equal(made.status, 400, `${JSON.stringify(name)}: ${JSON.stringify(made.body)}`);
      }
    }
    assert.ok(kept.length >= 8, 'most of them are kept, under plain names');
    // Everything written is under <root>/<company>/uploads, and nothing beside it.
    const written = (await walk(root)).map((path) => path.slice(root.length + 1));
    assert.ok(written.every((path) => path === fixture.companyId || path === `${fixture.companyId}/uploads` || path.startsWith(`${fixture.companyId}/uploads/`)),
      `outside the company's uploads: ${written.filter((path) => !path.startsWith(`${fixture.companyId}/uploads`)).join(', ')}`);
    assert.equal(plainFileName('NFD-Café.txt'), plainFileName('NFD-Café.txt'), 'the two spellings of one name are one name');
    assert.equal(plainFileName('CON'), '_CON');
    assert.equal(plainFileName('.env'), 'env');
    assert.ok(Buffer.byteLength(plainFileName(`${'é'.repeat(250)}.txt`)) <= 125, 'a long name is cut to 120 bytes of stem, between characters');
    assert.ok(mine.length > 0);
  } finally {
    await api.close();
  }
});

test('a second file of the same name is kept beside the first, and a planted link is never written through', async () => {
  const { api, put, mine, take } = await owned();
  try {
    const first = await put('notes.txt', 'first');
    const second = await put('notes.txt', 'second');
    assert.equal(first.body.path, 'uploads/notes.txt');
    assert.equal(second.body.path, 'uploads/notes-2.txt');
    assert.equal(Buffer.from((await take('uploads/notes.txt')).body.data, 'base64').toString(), 'first', 'the first is unchanged');

    // A link somebody left where the next name would go.
    const outside = join(await mkdtemp(join(tmpdir(), 'palugada-outside-')), 'target.txt');
    await writeFile(outside, 'not the company\'s');
    await symlink(outside, join(mine, 'uploads', 'planted.txt'));
    const third = await put('planted.txt', 'must not land in the target');
    assert.equal(third.status, 200, JSON.stringify(third.body));
    assert.equal(third.body.path, 'uploads/planted-2.txt', 'a link in the way is taken for a file that is there');
    assert.equal(await readFile(outside, 'utf8'), 'not the company\'s', 'and nothing was written through it');
  } finally {
    await api.close();
  }
});

test('a link cannot carry a write or a read out of the company\'s files, and one company cannot reach another\'s', async () => {
  const { api, owner, put, list, take, remove, root, mine, fixture } = await owned();
  try {
    await put('mine.txt', 'mine');
    // Another company's uploads, in the same root.
    const other = await createCompany('owner-files-other');
    const theirs = join(root, other.companyId, 'uploads');
    await mkdir(theirs, { recursive: true });
    await writeFile(join(theirs, 'secret.txt'), 'theirs');
    for (const path of [`../${other.companyId}/uploads/secret.txt`, `uploads/../../${other.companyId}/uploads/secret.txt`]) {
      assert.notEqual((await take(path)).status, 200, `${path} cannot be taken out`);
      assert.notEqual((await remove(path)).status, 200, `${path} cannot be removed`);
    }
    assert.notEqual((await list(`../${other.companyId}/uploads`)).status, 200);
    assert.equal(await readFile(join(theirs, 'secret.txt'), 'utf8'), 'theirs');
    // And the other company's own routes do not see ours.
    const asOther = await api.call('GET', `/api/companies/${other.companyId}/files/download?path=${encodeURIComponent(`../${fixture.companyId}/uploads/mine.txt`)}`, owner);
    assert.notEqual(asOther.status, 200);

    // A file that is a link to something outside the root cannot be downloaded or removed.
    const outside = join(await mkdtemp(join(tmpdir(), 'palugada-outside-')), 'secret.txt');
    await writeFile(outside, 'outside');
    await symlink(outside, join(mine, 'uploads', 'pointer.txt'));
    assert.notEqual((await take('uploads/pointer.txt')).status, 200);
    assert.notEqual((await remove('uploads/pointer.txt')).status, 200);
    assert.ok((await lstat(join(mine, 'uploads', 'pointer.txt'))).isSymbolicLink(), 'the link is as it was');
    assert.equal(await readFile(outside, 'utf8'), 'outside');

    // The folder itself replaced by a link to a folder outside the root: an upload is refused and writes nothing there.
    const elsewhere = await mkdtemp(join(tmpdir(), 'palugada-elsewhere-'));
    const third = await createCompany('owner-files-linked');
    await mkdir(join(root, third.companyId), { recursive: true });
    await symlink(elsewhere, join(root, third.companyId, 'uploads'));
    const refused = await api.call('POST', `/api/companies/${third.companyId}/files`, owner, { name: 'x.txt', data: Buffer.from('x').toString('base64') });
    assert.notEqual(refused.status, 200, JSON.stringify(refused.body));
    assert.deepEqual(await readdir(elsewhere), [], 'nothing was written outside the company\'s files');
  } finally {
    await api.close();
  }
});

test('the limits are held, and said', async () => {
  const { api, put, owner, base, mine } = await owned();
  try {
    const tooBig = await put('big.bin', Buffer.alloc(UPLOAD_MAX_BYTES + 1));
    assert.equal(tooBig.status, 400);
    assert.match(String(tooBig.body.error), /at most 10 MB/);
    assert.match(String((await put('empty.txt', '')).body.error), /empty file is not kept/);
    for (const data of ['not base64!!', 'AAAA=BBB', 'QQ=', '%%%%']) {
      const refused = await api.call('POST', `${base}/files`, owner, { name: 'x.txt', data });
      assert.equal(refused.status, 400, data);
    }
    assert.equal((await api.call('POST', `${base}/files`, owner, { name: 'x.txt', data: `data:text/plain;base64,${Buffer.from('hi').toString('base64')}` })).status, 200, 'a data: URL as the page reads one');
    assert.equal((await api.call('POST', `${base}/files`, owner, { name: 'y.txt', data: 'data:text/plain,hello' })).status, 400, 'one that is not base64');
    assert.equal((await api.call('POST', `${base}/files`, owner, { data: 'QQ==' })).status, 400, 'no name');
    assert.equal((await api.call('POST', `${base}/files`, owner, { name: 'x.txt' })).status, 400, 'no data');

    // The file count: the 501st is refused.
    await mkdir(join(mine, 'uploads'), { recursive: true });
    for (let i = 0; i < UPLOAD_MAX_FILES - 1; i += 1) await writeFile(join(mine, 'uploads', `f${i}.txt`), 'x');
    const kept = (await readdir(join(mine, 'uploads'))).length;
    assert.equal(kept, UPLOAD_MAX_FILES, 'the folder holds as many as are allowed (one was kept above)');
    const over = await put('one-more.txt', 'x');
    assert.equal(over.status, 400);
    assert.match(String(over.body.error), /uploads holds at most 500 files and 512 MB: take some out first/);

    // A body past the request ceiling is refused before it is read.
    const huge = await api.call('POST', `${base}/files`, owner, { name: 'huge.bin', data: 'A'.repeat(17 * 1024 * 1024) });
    assert.ok([400, 413].includes(huge.status), `a body past the ceiling is refused: ${huge.status}`);
  } finally {
    await api.close();
  }
});

test('with no files root, the routes say so', async () => {
  const { api, put, list, take, remove } = await owned({ files: false });
  try {
    const top = await list();
    assert.equal(top.status, 200);
    assert.equal(top.body.available, false);
    for (const answer of [await put('x.txt', 'x'), await take('uploads/x.txt'), await remove('uploads/x.txt')]) {
      assert.equal(answer.status, 400, JSON.stringify(answer.body));
      assert.match(String(answer.body.error), /PALUGADA_FILES_ROOT/);
    }
  } finally {
    await api.close();
  }
});

test('a company that does not exist makes no folder', async () => {
  const { api, owner, root } = await owned();
  try {
    const stranger = randomUUID();
    for (const [method, path] of [['GET', `/api/companies/${stranger}/files`], ['GET', `/api/companies/${stranger}/files/download?path=x`]] as const) {
      const answer = await api.call(method, path, owner);
      assert.notEqual(answer.status, 200, path);
    }
    assert.equal((await api.call('POST', `/api/companies/${stranger}/files`, owner, { name: 'x.txt', data: 'QQ==' })).status === 200, false);
    assert.equal((await readdir(root)).includes(stranger), false, 'a made-up id has no folder');
  } finally {
    await api.close();
  }
});

test('only what was uploaded can be removed here', async () => {
  const { api, put, remove, take, mine, fixture } = await owned();
  try {
    const made = await put('old.txt', 'x');
    await mkdir(join(mine, 'drafts'), { recursive: true });
    await writeFile(join(mine, 'drafts', 'letter.md'), '# Letter');
    await mkdir(join(mine, 'uploads', 'folder'), { recursive: true });

    for (const path of ['drafts/letter.md', 'uploads/../drafts/letter.md', 'uploads/folder', 'uploads/missing.txt', 'uploads', '']) {
      assert.equal((await remove(path)).status, 400, JSON.stringify(path));
    }
    assert.equal((await take('drafts/letter.md')).status, 200, 'what a role drafted can be taken out');
    assert.equal(await readFile(join(mine, 'drafts', 'letter.md'), 'utf8'), '# Letter', 'and is still there');

    const gone = await remove(made.body.path);
    assert.equal(gone.status, 200, JSON.stringify(gone.body));
    assert.equal((await take(made.body.path)).status === 200, false);
    assert.deepEqual((await uploadedEvents(fixture)).map((event) => [event.type, event.payload.path]),
      [['file.uploaded', made.body.path], ['file.deleted', made.body.path]]);
  } finally {
    await api.close();
  }
});

test('a staff seat is given no files', async () => {
  const { api, owner, fixture, base, put } = await owned();
  try {
    const made = await put('x.txt', 'x');
    const invited = await api.call('POST', `${base}/staff`, owner, { name: 'Rina', kind: 'approver', proof: { totp: api.code() } });
    assert.equal(invited.status, 200, JSON.stringify(invited.body));
    const invite = String(invited.body.invite);
    const opened = await api.call('POST', '/api/auth/join', '', { code: invite });
    const joined = await api.call('POST', '/api/auth/join/confirm', '', {
      code: invite, offer: opened.body.offer, totp: totpCode(decodeBase32(String(opened.body.secret)), stepFor(new Date())),
    });
    assert.equal(joined.status, 200, JSON.stringify(joined.body));
    const seat = String(joined.body.token);
    assert.ok(seat && fixture.companyId);
    for (const [method, path, body] of [
      ['GET', `${base}/files`, undefined],
      ['GET', `${base}/files/download?path=${encodeURIComponent(made.body.path)}`, undefined],
      ['POST', `${base}/files`, { name: 'y.txt', data: 'QQ==' }],
      ['POST', `${base}/files/delete`, { path: made.body.path }],
    ] as const) {
      const refused = await api.call(method, path, seat, body);
      assert.equal(refused.status, 403, `${method} ${path}: ${JSON.stringify(refused.body)}`);
    }
  } finally {
    await api.close();
  }
});

test('a listing is sorted, folders first, and says when it is cut', async () => {
  const { api, root, mine } = await owned();
  try {
    const names = ['b.txt', 'a.txt', 'Z.txt'];
    await mkdir(join(mine, 'zeta'), { recursive: true });
    await mkdir(join(mine, 'alpha'), { recursive: true });
    for (const name of names) await writeFile(join(mine, name), 'x');
    const ctx = { companyId: mine.split('/').at(-1) } as never;
    const all = await filesList({ root }).execute({}, ctx);
    assert.deepEqual(all.entries.map((entry) => entry.name), ['alpha', 'zeta', 'a.txt', 'b.txt', 'Z.txt'], 'folders first, then by name, as they are read at every place');
    const cut = await filesList({ root, maxEntries: 3 }).execute({}, ctx);
    assert.equal(cut.entries.length, 3);
    assert.equal(cut.truncated, true);
    assert.deepEqual(cut.entries.map((entry) => entry.name), ['alpha', 'zeta', 'a.txt'], 'the cut is of the sorted list, not of whatever the disk gave first');
  } finally {
    await api.close();
  }
});
