/**
 * Files said in a room (F19.4, F19.16; STATUS section 2.212).
 *
 * A message carries up to five files, read only by those who may see its
 * room. They are kept beside the company's files, never under them, so no
 * agent capability lists, reads, describes, computes on or mails one, and the
 * owner's Files page shows none. A file is kept under its own id with the
 * kind its bytes show, never under the name it was sent with; a small picture
 * is drawn, and everything else, an SVG too, is only ever saved. Deleting the
 * message removes its files, and bytes a delete left behind are gone by the
 * next sweep. Closing a company erases its room files with it.
 */
import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { closePools } from '../../src/db/pool.ts';
import { withControlPlane, withPeople } from '../../src/db/tenant.ts';
import { codeCompute } from '../../src/capabilities/compute.ts';
import { filesList, filesRead, readCompanyFile } from '../../src/capabilities/files.ts';
import { imageDescribe, VISION_PROVIDERS } from '../../src/capabilities/vision.ts';
import { isPalugadaError } from '../../src/errors.ts';
import { closeCompany, eraseDueCompanies } from '../../src/governance/closing.ts';
import { peopleFilesFolder } from '../../src/owner/route.ts';
import { runRetention } from '../../src/retention/retention.ts';
import { postMessage } from '../../src/workspace/messages.ts';
import { listRooms } from '../../src/workspace/rooms.ts';
import { createCompany, type Fixture } from '../helpers/fixtures.ts';
import { consoleWithSettings } from '../helpers/owner-console.ts';
import {
  companyRoomOf, ok, personIn, refusedWith, seated, type Console, type PersonIn,
} from '../helpers/rooms.ts';
import { ensureSchema, resetData, closeSetup } from '../helpers/setup.ts';

before(ensureSchema);
beforeEach(resetData);
after(async () => {
  await closePools();
  await closeSetup();
});

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from('a small picture')]);
const PDF = Buffer.from('%PDF-1.4\n1 0 obj << >> endobj\n%%EOF\n');
const SVG = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(document.cookie)</script></svg>');

const sent = (name: string, bytes: Buffer) => ({ name, data: bytes.toString('base64') });

async function workspace(slug: string): Promise<{ fixture: Fixture; api: Console; owner: PersonIn; root: string; folder: string }> {
  const fixture = await createCompany(slug);
  const root = await mkdtemp(join(tmpdir(), 'palugada-room-files-'));
  const api = await consoleWithSettings({ files: { root } });
  const owner = personIn(api, await api.signIn(), fixture.companyId);
  return { fixture, api, owner, root, folder: peopleFilesFolder({ root }, fixture.companyId)! };
}

type FileView = { id: string; name: string; mime: string; bytes: number; inline: boolean };

/** Posts words with files, and answers the message as it is drawn. */
async function carrying(person: PersonIn, roomId: string, files: Array<{ name: string; data: string }>, body = 'Terlampir.') {
  return ok(await person.say(roomId, { body, files }), 'posting with files').message as { id: string; files: FileView[] };
}

/** Every file kept under a folder, as paths relative to it. */
async function filesUnder(folder: string): Promise<string[]> {
  const found: string[] = [];
  const walk = async (at: string, prefix: string) => {
    for (const entry of await readdir(at, { withFileTypes: true }).catch(() => [])) {
      if (entry.isDirectory()) await walk(join(at, entry.name), `${prefix}${entry.name}/`);
      else found.push(`${prefix}${entry.name}`);
    }
  };
  await walk(folder, '');
  return found.sort();
}

test('a message carries up to five files, read only by those who may see the room', async () => {
  const { fixture, api, owner } = await workspace('room-files-read');
  try {
    const sari = await seated(fixture, 'Sari', 'member');
    const budi = await seated(fixture, 'Budi', 'member');
    const sariIn = personIn(api, sari.token, fixture.companyId);
    const budiIn = personIn(api, budi.token, fixture.companyId);
    const room = String(ok(await owner.makeRoom({ name: 'kontrak', private: true, members: [sari.principal] })).room.id);
    const message = await carrying(owner, room, [sent('denah.png', PNG), sent('kontrak.pdf', PDF)]);
    assert.deepEqual(message.files.map((file) => [file.name, file.mime, file.bytes]),
      [['denah.png', 'image/png', PNG.length], ['kontrak.pdf', 'application/pdf', PDF.length]]);

    const page = ok(await sariIn.page(room)).messages as Array<{ id: string; files: FileView[] }>;
    const [picture, contract] = page.find((one) => one.id === message.id)!.files;
    const read = ok(await sariIn.get(`/rooms/${room}/files/${contract!.id}`));
    assert.deepEqual([read.name, read.mime, read.inline, Buffer.from(read.data, 'base64').equals(PDF)], ['kontrak.pdf', 'application/pdf', false, true]);
    assert.ok(Buffer.from(ok(await owner.get(`/rooms/${room}/files/${picture!.id}`)).data, 'base64').equals(PNG));
    refusedWith(await budiIn.get(`/rooms/${room}/files/${contract!.id}`), 404, 'room.not_visible');
    // A file is read in its own room only: named under another, it is no file of that room.
    const open = await companyRoomOf(budiIn);
    refusedWith(await budiIn.get(`/rooms/${open}/files/${contract!.id}`), 400, 'contract.violation');
    // Another company's seat reaches none of it.
    const other = await createCompany('room-files-other');
    const tono = await seated(other, 'Tono', 'approver');
    refusedWith(await api.call('GET', `/api/companies/${fixture.companyId}/rooms/${room}/files/${contract!.id}`, tono.token), 403, 'staff.forbidden');

    // Six is one too many; an empty file and one with no name are refused; nothing is kept of a refused message.
    const six = Array.from({ length: 6 }, (_, n) => sent(`foto-${n}.png`, PNG));
    refusedWith(await owner.say(room, { body: 'Enam.', files: six }), 400, 'message.files');
    refusedWith(await owner.say(room, { body: 'Kosong.', files: [sent('kosong.txt', Buffer.alloc(0))] }), 400, 'contract.violation');
    refusedWith(await owner.say(room, { body: 'Tanpa nama.', files: [{ data: PNG.toString('base64') }] }), 400, 'contract.violation');
    refusedWith(await owner.say(room, { body: 'Bukan base64.', files: [{ name: 'x.png', data: 'not base64!' }] }), 400, 'contract.violation');
    assert.equal((ok(await owner.page(room)).messages as unknown[]).length, 1, 'only the first message was kept');

    // A message of files alone says nothing, and is kept.
    const alone = await carrying(owner, room, [sent('denah-2.png', PNG)], '');
    assert.equal(alone.files.length, 1);
    refusedWith(await owner.say(room, { body: '' }), 400, 'contract.violation');
  } finally {
    await api.close();
  }
});

test('no agent capability lists, reads, describes, computes on or mails a room file', async () => {
  const { fixture, api, owner, root, folder } = await workspace('room-files-agents');
  try {
    const room = await companyRoomOf(owner);
    const message = await carrying(owner, room, [sent('nota.png', PNG), sent('catatan.txt', Buffer.from('rahasia ruangan'))]);
    const kept = await filesUnder(folder);
    assert.equal(kept.length, 2, 'both files are kept, beside the company\'s folder');
    const reaching = [
      ...kept.map((path) => `../${fixture.companyId}.people/${path}`),
      ...kept.map((path) => join(folder, path)),
      `../${fixture.companyId}.people`,
      '..',
    ];
    const ctx = { companyId: fixture.companyId, signal: AbortSignal.timeout(5_000) } as never;
    const refused = (error: unknown) => isPalugadaError(error, 'capability.unreachable') || isPalugadaError(error, 'contract.violation')
      || isPalugadaError(error, 'capability.unknown');
    // Refused, or answered with nothing of the room: an absolute path is read inside the company's own folder.
    const reachesNothing = async (attempt: Promise<unknown>, what: string) => {
      let answer: string;
      try {
        answer = JSON.stringify(await attempt);
      } catch (error) {
        assert.ok(refused(error), `${what}: ${(error as Error).message}`);
        return;
      }
      for (const file of message.files) assert.ok(!answer.includes(file.id), `${what} names a room file`);
      assert.ok(!answer.includes('rahasia ruangan') && !answer.includes(PNG.toString('base64')), `${what} read a room file`);
    };

    // files.list sees the company's own folder, which holds nothing of the room.
    await reachesNothing(filesList({ root }).execute({ path: '.' }, ctx), 'files.list .');
    for (const path of reaching) {
      await reachesNothing(filesList({ root }).execute({ path }, ctx), `files.list ${path}`);
      await assert.rejects(filesRead({ root }).execute({ path }, ctx), refused, `files.read ${path}`);
      // What code.compute and a letter's attachments are read through (compute.ts, mailbox.ts).
      await assert.rejects(readCompanyFile(root, fixture.companyId, path, 1_000_000, 'test'), refused, `read for a run or a letter: ${path}`);
    }
    let looked = 0;
    const describe = imageDescribe({
      provider: VISION_PROVIDERS[0]!, url: null, key: async () => 'k', model: null, root,
      fetch: (async () => { looked += 1; throw new Error('a picture was sent'); }) as typeof fetch,
    });
    for (const path of reaching) await assert.rejects(describe.execute({ path }, ctx), refused, `image.describe ${path}`);
    assert.equal(looked, 0, 'no room picture reached a model');
    // code.compute refuses before any container starts: a docker that would run would fail the test.
    const compute = codeCompute({ root, image: 'palugada/compute:test', docker: '/nonexistent/docker-never-started' });
    for (const path of reaching) {
      await assert.rejects(compute.execute({ code: 'print(1)', files: [path] }, ctx), refused, `code.compute ${path}`);
    }
  } finally {
    await api.close();
  }
});

test("the owner's Files page shows no room file", async () => {
  const { api, owner, folder } = await workspace('room-files-page');
  try {
    const room = await companyRoomOf(owner);
    const message = await carrying(owner, room, [sent('denah.png', PNG)]);
    assert.equal((await filesUnder(folder)).length, 1);
    const page = ok(await owner.get('/files'));
    assert.equal(page.available, true);
    assert.ok(!JSON.stringify(page).includes(message.files[0]!.id));
    assert.ok(!JSON.stringify(page).includes('.people'));
    for (const path of ['..', `../${folder.split('/').at(-1)}`]) {
      assert.notEqual((await owner.get(`/files?path=${encodeURIComponent(path)}`)).status, 200, `listing ${path}`);
    }
    const kept = (await filesUnder(folder))[0]!;
    const down = await owner.get(`/files/download?path=${encodeURIComponent(`../${folder.split('/').at(-1)}/${kept}`)}`);
    assert.notEqual(down.status, 200, 'a room file is not downloaded through the company\'s files');
  } finally {
    await api.close();
  }
});

test('a file is stored under its id with the type its bytes show, never the name it was sent with', async () => {
  const { fixture, api, owner, root, folder } = await workspace('room-files-names');
  try {
    const room = await companyRoomOf(owner);
    const message = await carrying(owner, room, [
      sent('faktur.pdf', PNG),
      sent('foto.png', PDF),
      sent('../../../etc/passwd', Buffer.from('root:x:0:0\n')),
      sent('gambar.svg.png', SVG),
    ]);
    assert.deepEqual(message.files.map((file) => [file.name, file.mime]), [
      ['faktur.pdf', 'image/png'],
      ['foto.png', 'application/pdf'],
      ['passwd', 'text/plain'],
      ['gambar.svg.png', 'image/svg+xml'],
    ], 'the name is what was sent, made plain; the kind is what the bytes are');
    const kept = await filesUnder(folder);
    assert.deepEqual(kept, [
      `rooms/${room}/${message.files[0]!.id}.png`,
      `rooms/${room}/${message.files[1]!.id}.pdf`,
      `rooms/${room}/${message.files[2]!.id}.txt`,
      `rooms/${room}/${message.files[3]!.id}.svg`,
    ].sort(), 'each under its own id, in its room');
    assert.ok((await readFile(join(folder, `rooms/${room}/${message.files[1]!.id}.pdf`))).equals(PDF));
    const paths = await withControlPlane((tx) => tx.query<{ path: string; sha256: string }>(
      'SELECT path, sha256 FROM room_files WHERE company_id = $1 ORDER BY created_at, id', [fixture.companyId]));
    assert.ok(paths.rows.every((row) => !/faktur|foto|passwd|gambar/.test(row.path) && /^[0-9a-f]{64}$/.test(row.sha256)));
    // Nothing was written in the company's own folder, nor anywhere else under the files root.
    assert.deepEqual((await readdir(root)).sort(), [`${fixture.companyId}.people`]);
  } finally {
    await api.close();
  }
});

test('an image up to two megabytes is drawn; every other file, an SVG too, is a download', async () => {
  const { api, owner } = await workspace('room-files-inline');
  try {
    const room = await companyRoomOf(owner);
    const big = Buffer.concat([PNG, Buffer.alloc(2 * 1024 * 1024)]);
    const message = await carrying(owner, room, [sent('kecil.png', PNG), sent('besar.png', big), sent('ikon.svg', SVG), sent('surat.pdf', PDF)]);
    assert.deepEqual(message.files.map((file) => [file.name, file.inline]),
      [['kecil.png', true], ['besar.png', false], ['ikon.svg', false], ['surat.pdf', false]]);
    for (const file of message.files) {
      const read = ok(await owner.get(`/rooms/${room}/files/${file.id}`));
      assert.equal(read.inline, file.inline, `${file.name} is said the same way when it is read`);
    }
    const svg = ok(await owner.get(`/rooms/${room}/files/${message.files[2]!.id}`));
    assert.equal(svg.mime, 'image/svg+xml');
    assert.equal(svg.inline, false, 'an SVG can carry a script: it is saved, never drawn');
  } finally {
    await api.close();
  }
});

test('deleting a message removes its files, and a delete cut off before the bytes went leaves none by the next sweep', async () => {
  const { fixture, api, owner, root, folder } = await workspace('room-files-delete');
  try {
    const room = await companyRoomOf(owner);
    const first = await carrying(owner, room, [sent('satu.png', PNG), sent('dua.pdf', PDF)]);
    const second = await carrying(owner, room, [sent('tiga.png', PNG)]);
    const kept = await carrying(owner, room, [sent('tetap.pdf', PDF)]);
    assert.equal((await filesUnder(folder)).length, 4);

    ok(await owner.on(room, first.id, 'delete'));
    assert.deepEqual((await filesUnder(folder)).sort(), [
      `rooms/${room}/${second.files[0]!.id}.png`, `rooms/${room}/${kept.files[0]!.id}.pdf`,
    ].sort(), 'a delete takes its bytes at once');
    const gone = ok(await owner.page(room)).messages.find((one: { id: string }) => one.id === first.id);
    assert.equal(gone.deleted, true);
    refusedWith(await owner.get(`/rooms/${room}/files/${first.files[0]!.id}`), 404, 'file.not_kept');

    // A delete whose process stopped after its commit, before it removed the bytes: the row says no path.
    await withPeople(fixture.companyId, { principal: 'owner', name: null }, (tx) => tx.query(
      'UPDATE room_messages SET deleted_at = now() WHERE id = $1', [second.id]));
    assert.equal((await filesUnder(folder)).length, 2, 'the bytes are still there');
    // A file just written, perhaps by a post not yet committed, is left for a later sweep.
    await runRetention(fixture.companyId, new Date(), { filesRoot: root });
    assert.equal((await filesUnder(folder)).length, 2);
    await runRetention(fixture.companyId, new Date(Date.now() + 2 * 60 * 60 * 1000), { filesRoot: root });
    assert.deepEqual(await filesUnder(folder), [`rooms/${room}/${kept.files[0]!.id}.pdf`], 'what no row names is swept; what a live message carries stays');
    assert.ok((await stat(join(folder, `rooms/${room}/${kept.files[0]!.id}.pdf`))).isFile());
  } finally {
    await api.close();
  }
});

test('closing a company erases its room files, wherever they are kept', async () => {
  for (const separate of [false, true]) {
    const fixture = await createCompany(`room-files-erase-${separate}`);
    const root = await mkdtemp(join(tmpdir(), 'palugada-room-files-erase-'));
    const peopleRoot = separate ? await mkdtemp(join(tmpdir(), 'palugada-people-erase-')) : undefined;
    const files = { root, ...(peopleRoot ? { peopleRoot } : {}) };
    const folder = peopleFilesFolder(files, fixture.companyId)!;
    // Posted as the post route posts, with this deployment's folder for the company.
    const viewer = { companyId: fixture.companyId, person: { principal: 'owner', name: null }, kind: 'owner' as const, seatId: null };
    const room = (await listRooms(viewer)).find((one) => one.kind === 'company')!.id;
    await postMessage(viewer, room, { body: 'Denah kantor.', clientId: 'erase-1', files: [sent('denah.png', PNG)] }, { peopleFolder: folder });
    assert.equal((await filesUnder(folder)).length, 1);
    await closeCompany(fixture.companyId, 7);
    await withControlPlane((tx) => tx.query(
      "UPDATE companies SET closing_at = now() - interval '8 days', erase_after = now() - interval '1 day' WHERE id = $1", [fixture.companyId]));
    const pass = await eraseDueCompanies({ filesRoot: root, ...(peopleRoot ? { peopleRoot } : {}) });
    assert.deepEqual([pass.erased.length, pass.failed, pass.leftBehind], [1, [], []]);
    await assert.rejects(stat(folder), (error: NodeJS.ErrnoException) => error.code === 'ENOENT', `${folder} is gone`);
  }
});
