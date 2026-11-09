/**
 * The owner names the people in their companies, and no two of them look
 * alike (F19.21; STATUS 2.209).
 *
 * In a room a person is drawn as the name the owner gave them, with their
 * handle beside it, and what they write is read as theirs. A name is the
 * owner's to give, so a member of staff cannot call themselves "Siti
 * (Finance)" and speak as a colleague; and the owner is not let give one that
 * reads as a colleague's, as the owner, PALUGADA, the CEO, the system or one
 * of the company's roles, in look-alike letters from another alphabet
 * either, or one with a character that turns the text around it.
 */
import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { closePools } from '../../src/db/pool.ts';
import { withControlPlane, withTenant } from '../../src/db/tenant.ts';
import { decodeBase32, stepFor, totpCode } from '../../src/owner/mfa.ts';
import { StaffSeats } from '../../src/owner/staff.ts';
import { createCompany, type Fixture } from '../helpers/fixtures.ts';
import { ensureSchema, resetData, closeSetup } from '../helpers/setup.ts';
import { consoleWithSettings } from '../helpers/owner-console.ts';

before(ensureSchema);
beforeEach(resetData);
after(async () => {
  await closePools();
  await closeSetup();
});

type Console = Awaited<ReturnType<typeof consoleWithSettings>>;

function app(secret: string) {
  let step = 0;
  return () => {
    // The earliest step the window still takes, a step ahead of the last each time, up to the latest it takes.
    const now = stepFor(new Date());
    step = Math.max(step + 1, now - 1);
    return totpCode(decodeBase32(secret), Math.min(step, now + 1));
  };
}

async function seat(api: Console, owner: string, fixture: Fixture, name: string, kind = 'viewer', chosen: Record<string, unknown> = {}) {
  const made = await api.call('POST', `/api/companies/${fixture.companyId}/staff`, owner, { name, kind, proof: { totp: api.code() } });
  assert.equal(made.status, 200, JSON.stringify(made.body));
  const opened = await api.call('POST', '/api/auth/join', '', { code: made.body.invite });
  const code = app(String(opened.body.secret));
  const joined = await api.call('POST', '/api/auth/join/confirm', '', { code: made.body.invite, offer: opened.body.offer, totp: code(), ...chosen });
  assert.equal(joined.status, 200, JSON.stringify(joined.body));
  return { seatId: String(made.body.seatId), token: String(joined.body.token) };
}

const seated = async (api: Console, owner: string, fixture: Fixture) =>
  ((await api.call('GET', `/api/companies/${fixture.companyId}/staff`, owner)).body.seats as Array<{ name: string; sharesName: boolean }>)
    .map((one) => one.name).sort();

test('the owner names people; a seat cannot rename itself', async () => {
  const fixture = await createCompany('names-owner');
  const api = await consoleWithSettings();
  try {
    const owner = await api.signIn();
    const siti = await seat(api, owner, fixture, 'Siti Rahayu');

    // Renaming is the owner's, in the session: it lets nobody do more.
    const renamed = await api.call('POST', `/api/companies/${fixture.companyId}/staff/${siti.seatId}/change`, owner, { name: 'Siti R.' });
    assert.equal(renamed.status, 200, JSON.stringify(renamed.body));
    assert.deepEqual(await seated(api, owner, fixture), ['Siti R.']);
    assert.equal((await api.call('GET', '/api/me', siti.token)).body.staff.name, 'Siti R.', 'her own session reads the new name at once');
    assert.equal((await api.call('GET', '/api/me/profile', siti.token)).body.name, 'Siti R.');

    const herself = await api.call('POST', '/api/me/profile', siti.token, { name: 'Siti (Finance)' });
    assert.deepEqual([herself.status, herself.body.code], [403, 'name.owner_sets']);
    const throughTheOwners = await api.call('POST', `/api/companies/${fixture.companyId}/staff/${siti.seatId}/change`, siti.token, { name: 'Boss' });
    assert.deepEqual([throughTheOwners.status, throughTheOwners.body.code], [403, 'staff.forbidden']);
    // Nor does any field of a person's own say who is writing.
    for (const field of ['author', 'as', 'by', 'principal', 'via']) {
      const claimed = await api.call('POST', '/api/me/profile', siti.token, { [field]: 'owner', language: 'id' });
      assert.deepEqual([claimed.status, claimed.body.code], [400, 'contract.violation'], field);
    }
    assert.deepEqual(await seated(api, owner, fixture), ['Siti R.']);
  } finally {
    await api.close();
  }
});

test('a seat named like the owner, PALUGADA, the CEO, the system or a role is refused, in look-alike letters too', async () => {
  const fixture = await createCompany('names-reserved');
  await withTenant(fixture.companyId, (tx) => tx.query(
    `INSERT INTO roles (company_id, division_id, slug, system_prompt, model, output_schema, done_criteria, title)
     VALUES ($1, $2, 'sales-lead', 'You sell.', 'test-model', '{"type":"object"}'::jsonb, ARRAY['a sale'], 'Head of Sales')`,
    [fixture.companyId, fixture.divisionId]));
  const api = await consoleWithSettings();
  try {
    const owner = await api.signIn();
    const reserved = [
      'Owner', 'The Owner', 'the-owner', '0wner', 'Pemilik', 'PALUGADA', 'Palug\u0430da', 'C.E.O.', 'ceo',
      '\u0405ystem', 'Sistem', 'ADM1N', '\u0391DMIN', 'Platform',
      // The fixture's CEO is the role `worker`, titled CEO; and the role added above.
      'Worker', 'W\u043erker', 'Head of Sales', 'Sales Lead', 'sales_lead',
    ];
    for (const name of reserved) {
      const refused = await api.call('POST', `/api/companies/${fixture.companyId}/staff`, owner, { name, kind: 'viewer', proof: { totp: api.code() } });
      assert.deepEqual([refused.status, refused.body.code], [400, 'name.reserved'], JSON.stringify(name));
    }
    const batch = await api.call('POST', `/api/companies/${fixture.companyId}/staff-batch`, owner, {
      people: [{ name: 'Rina', kind: 'viewer' }, { name: 'PALUGADA Bot', kind: 'viewer' }, { name: 'C E O', kind: 'member' }],
      proof: { totp: api.code() },
    });
    assert.deepEqual([batch.status, batch.body.code], [400, 'name.reserved'], 'one reserved name refuses the batch');
    assert.deepEqual(batch.body.details, { field: 'name', index: 2, name: 'C E O' }, 'and says which of the list it is, as the owner wrote it');
    assert.match(batch.body.error, /C E O/);
    const unknownKind = await api.call('POST', `/api/companies/${fixture.companyId}/staff-batch`, owner, {
      people: [{ name: 'Rina', kind: 'viewer' }, { name: 'Budi', kind: 'boss' }], proof: { totp: api.code() },
    });
    assert.deepEqual([unknownKind.status, unknownKind.body.code, unknownKind.body.details], [400, 'contract.violation', { field: 'kind', index: 1 }],
      'so does a kind the ladder does not know');
    assert.deepEqual(await seated(api, owner, fixture), [], 'and nobody is seated by any of it');

    // A name that only contains one of them is a name.
    const budi = await seat(api, owner, fixture, 'Budi Owner-Santoso');
    const renamed = await api.call('POST', `/api/companies/${fixture.companyId}/staff/${budi.seatId}/change`, owner, { name: 'P\u0430lugada' });
    assert.deepEqual([renamed.status, renamed.body.code], [400, 'name.reserved'], 'nor is a seat renamed into one');
    assert.deepEqual(await seated(api, owner, fixture), ['Budi Owner-Santoso']);
  } finally {
    await api.close();
  }
});

test("a name that looks like a colleague's is refused", async () => {
  const fixture = await createCompany('names-taken');
  const other = await createCompany('names-elsewhere');
  const api = await consoleWithSettings();
  try {
    const owner = await api.signIn();
    await seat(api, owner, fixture, 'Siti Rahayu');
    const rima = await seat(api, owner, fixture, 'Rima');
    // Written with letters that carry their marks: a Cyrillic letter with the same mark is the same name.
    for (const name of ['Zo\u00eb', '\u00cfvan', '\u00c8va']) await seat(api, owner, fixture, name);
    const alike = [
      'Siti Rahayu', 'SITI RAHAYU', 'siti rahayu', 'Siti  Rahayu', 'Siti-Rahayu', 'SitiRahayu',
      'S\u0456ti Rahayu', '\u0405iti Rahayu', 'Siti R\u0430hayu', 'S1ti Rahayu', '5iti Rahayu', 'Siti\u200bRahayu',
      'Zo\u0451', 'Zoe\u0308', '\u0407van', '\u0400va', '\u0415\u0300va',
    ];
    for (const name of alike) {
      const refused = await api.call('POST', `/api/companies/${fixture.companyId}/staff`, owner, { name, kind: 'viewer', proof: { totp: api.code() } });
      assert.deepEqual([refused.status, refused.body.code], [409, 'name.taken'], JSON.stringify(name));
      // The refusal names the name the owner gave, never the colleague's it looks like.
      assert.deepEqual(refused.body.details, { field: 'name', name }, JSON.stringify(name));
    }
    assert.doesNotMatch(JSON.stringify((await api.call('POST', `/api/companies/${fixture.companyId}/staff`, owner,
      { name: 'S1ti Rahayu', kind: 'viewer', proof: { totp: api.code() } })).body), /Siti Rahayu/);
    // Nor is a name given that reads as a colleague's handle, so a mention list cannot hold two Rinas.
    const budi = await seat(api, owner, fixture, 'Budi', 'viewer', { handle: 'rina' });
    const asHandle = await api.call('POST', `/api/companies/${fixture.companyId}/staff`, owner, { name: 'Rina', kind: 'viewer', proof: { totp: api.code() } });
    assert.deepEqual([asHandle.status, asHandle.body.code], [409, 'name.taken'], "a name that reads as Budi's @rina");
    assert.equal((await api.call('POST', `/api/companies/${fixture.companyId}/staff/${budi.seatId}/change`, owner, { name: 'Rina Budiman' })).status, 200,
      'though Budi may be named after his own handle');
    // An m is an r and an n in a small font, and Unicode says so.
    const rirna = await api.call('POST', `/api/companies/${fixture.companyId}/staff`, owner, { name: 'Rirna', kind: 'viewer', proof: { totp: api.code() } });
    assert.deepEqual([rirna.status, rirna.body.code], [409, 'name.taken']);
    const renamed = await api.call('POST', `/api/companies/${fixture.companyId}/staff/${rima.seatId}/change`, owner, { name: 'Siti Rahayu' });
    assert.deepEqual([renamed.status, renamed.body.code], [409, 'name.taken'], 'nor is a colleague renamed into her');
    const twice = await api.call('POST', `/api/companies/${fixture.companyId}/staff-batch`, owner, {
      people: [{ name: 'Dewi', kind: 'viewer' }, { name: 'DEWI', kind: 'member' }], proof: { totp: api.code() },
    });
    assert.deepEqual([twice.status, twice.body.code], [409, 'name.taken'], 'nor two of one batch');
    assert.deepEqual(twice.body.details, { field: 'name', index: 1, name: 'DEWI' }, 'and the refusal says which of the list to change');

    // A different name, the same name in another company, and the name of someone who left are all free.
    assert.equal((await api.call('POST', `/api/companies/${fixture.companyId}/staff`, owner,
      { name: 'Siti Rahayu Putri', kind: 'viewer', proof: { totp: api.code() } })).status, 200);
    assert.equal((await api.call('POST', `/api/companies/${other.companyId}/staff`, owner,
      { name: 'Siti Rahayu', kind: 'viewer', proof: { totp: api.code() } })).status, 200);
    assert.equal((await api.call('POST', `/api/companies/${fixture.companyId}/staff/${rima.seatId}/revoke`, owner, {})).status, 200);
    assert.equal((await api.call('POST', `/api/companies/${fixture.companyId}/staff`, owner,
      { name: 'Rima', kind: 'viewer', proof: { totp: api.code() } })).status, 200);
    // Renaming a person to their own name, written another way, is theirs to keep.
    const own = (await api.call('GET', `/api/companies/${fixture.companyId}/staff`, owner)).body.seats
      .find((one: { name: string }) => one.name === 'Rima') as { id: string };
    assert.equal((await api.call('POST', `/api/companies/${fixture.companyId}/staff/${own.id}/change`, owner, { name: 'RIMA' })).status, 200);
  } finally {
    await api.close();
  }
});

test('two look-alike names given at once seat only one of them', async () => {
  const fixture = await createCompany('names-at-once');
  const api = await consoleWithSettings();
  try {
    // "SITI" and "Siti" are kept under different skeletons, since Unicode
    // reads a capital I as an l, so the unique index alone would let both
    // in when they are written at the same moment.
    const seats = new StaffSeats({ master: () => api.master, secrets: () => api.secrets });
    for (const surname of ['Rahayu', 'Lestari', 'Wulandari', 'Pratiwi', 'Kusuma']) {
      const both = await Promise.allSettled([
        seats.create(fixture.companyId, { name: `SITI ${surname.toUpperCase()}`, kind: 'viewer' }),
        seats.create(fixture.companyId, { name: `Siti ${surname}`, kind: 'viewer' }),
      ]);
      assert.deepEqual(both.map((one) => one.status).sort(), ['fulfilled', 'rejected'], surname);
      const refused = both.find((one) => one.status === 'rejected') as PromiseRejectedResult;
      assert.equal((refused.reason as { code?: string }).code, 'name.taken', surname);
    }
    assert.equal((await seats.list(fixture.companyId)).filter((one) => one.sharesName).length, 0, 'and nobody is left sharing a name');
  } finally {
    await api.close();
  }
});

test('two people seated before names were kept apart are told apart, and the owner is asked to rename one', async () => {
  const fixture = await createCompany('names-legacy');
  const api = await consoleWithSettings();
  try {
    const owner = await api.signIn();
    // As 0110 seated them, before the skeleton: two Budis, and a Sari.
    await withControlPlane(async (tx) => {
      for (const [name, at] of [['Budi', '2026-01-01'], ['BUDI', '2026-02-01'], ['Sari', '2026-03-01']]) {
        await tx.query("INSERT INTO staff_seats (company_id, name, kind, created_at) VALUES ($1, $2, 'viewer', $3)", [fixture.companyId, name, at]);
      }
    });
    const listed = await api.call('GET', `/api/companies/${fixture.companyId}/staff`, owner);
    assert.equal(listed.status, 200, JSON.stringify(listed.body));
    assert.deepEqual(listed.body.seats.map((one: { name: string; sharesName: boolean }) => [one.name, one.sharesName]),
      [['Budi', true], ['BUDI', true], ['Sari', false]]);
    const kept = await withControlPlane((tx) => tx.query<{ name: string; name_skeleton: string | null }>(
      'SELECT name, name_skeleton FROM staff_seats WHERE company_id = $1 ORDER BY created_at', [fixture.companyId]));
    assert.deepEqual(kept.rows.map((row) => [row.name, row.name_skeleton !== null]), [['Budi', true], ['BUDI', false], ['Sari', true]],
      'the first keeps the name; the later is to be renamed');

    const later = listed.body.seats[1] as { id: string };
    assert.equal((await api.call('POST', `/api/companies/${fixture.companyId}/staff/${later.id}/change`, owner, { name: 'Budi Santoso' })).status, 200);
    const after = await api.call('GET', `/api/companies/${fixture.companyId}/staff`, owner);
    assert.deepEqual(after.body.seats.map((one: { name: string; sharesName: boolean }) => [one.name, one.sharesName]),
      [['Budi', false], ['Budi Santoso', false], ['Sari', false]]);
  } finally {
    await api.close();
  }
});

test('a name with a direction override is refused', async () => {
  const fixture = await createCompany('names-direction');
  const api = await consoleWithSettings();
  try {
    const owner = await api.signIn();
    const budi = await seat(api, owner, fixture, 'Budi');
    for (const name of ['Siti\u202eayahaR', '\u2066Siti\u2069', 'Siti\u202aRahayu', 'Siti\nRahayu']) {
      const refused = await api.call('POST', `/api/companies/${fixture.companyId}/staff`, owner, { name, kind: 'viewer', proof: { totp: api.code() } });
      assert.deepEqual([refused.status, refused.body.code], [400, 'contract.violation'], JSON.stringify(name));
      assert.equal(refused.body.details?.field ?? 'name', 'name');
      const renamed = await api.call('POST', `/api/companies/${fixture.companyId}/staff/${budi.seatId}/change`, owner, { name });
      assert.deepEqual([renamed.status, renamed.body.code], [400, 'contract.violation'], `renamed to ${JSON.stringify(name)}`);
    }
    for (const name of ['\u{1F680}', ' . ']) {
      const refused = await api.call('POST', `/api/companies/${fixture.companyId}/staff`, owner, { name, kind: 'viewer', proof: { totp: api.code() } });
      assert.deepEqual([refused.status, refused.body.code], [400, 'contract.violation'], `${JSON.stringify(name)} has no letter in it`);
    }
    assert.deepEqual(await seated(api, owner, fixture), ['Budi']);
  } finally {
    await api.close();
  }
});
