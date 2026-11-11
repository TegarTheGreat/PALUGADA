/**
 * The relay protocol is the document a third party builds a relay from
 * (`docs/relay-protocol.md`; F19.19, F19.20; STATUS section 2.208), so the
 * document and the code are held to each other here: every envelope type the
 * code sends or takes is described there, nothing is described that the code
 * does not know, and the test vectors in it verify against the code.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, createHmac, createPrivateKey, createPublicKey, sign, verify } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { jcs } from '../../src/relay/canonical.ts';
import { OUTBOUND_TYPES, companyRef, envelopeId, recipientId } from '../../src/relay/envelope.ts';
import { INBOUND_TYPES } from '../../src/relay/inbound.ts';
import { ed25519FromSeed, fingerprint, keyId, signV1a, verifyV1a } from '../../src/relay/signature.ts';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));

async function protocol(): Promise<string> {
  return readFile(join(ROOT, 'docs', 'relay-protocol.md'), 'utf8');
}

test('every envelope type in src/relay is described in docs/relay-protocol.md, and the reverse', async () => {
  const text = await protocol();
  const described = new Set([...text.matchAll(/^#### `([a-z_]+)`/gm)].map((match) => match[1]!));
  assert.ok(described.size >= 10, `only ${described.size} types are described; the scan is broken`);
  const known = new Set<string>([...OUTBOUND_TYPES, ...INBOUND_TYPES]);
  assert.deepEqual([...known].filter((type) => !described.has(type)).sort(), [], 'a type the code knows and the document does not describe');
  assert.deepEqual([...described].filter((type) => !known.has(type)).sort(), [], 'a type the document describes and the code does not know');

  // And the code names no type outside its two lists: an envelope built with
  // a type written in place would reach a relay undescribed.
  const folder = join(ROOT, 'src', 'relay');
  const written = new Set<string>();
  for (const name of (await readdir(folder)).filter((file) => file.endsWith('.ts'))) {
    const source = await readFile(join(folder, name), 'utf8');
    for (const match of source.matchAll(/\btype: '([a-z_]+)'/g)) written.add(match[1]!);
  }
  // Not envelopes: the DER form a key is read in, as node:crypto names it.
  for (const notAnEnvelope of ['spki', 'pkcs8']) written.delete(notAnEnvelope);
  assert.ok(written.size >= 5, `only ${written.size} types are written in src/relay; the scan is broken`);
  assert.deepEqual([...written].filter((type) => !known.has(type)).sort(), []);
});

interface Vectors {
  key: { seed: string; publicKey: string; kid: string; fingerprint: string };
  canonical: Array<{ value: unknown; canonical: string }>;
  envelope: { value: Record<string, unknown>; canonical: string; id: string; timestamp: string; signature: string };
  envelopeId: { deployment: string; relay: string; link: string | null; type: string; subject: string; version: number; id: string };
  pseudonyms: { salt: string; principal: string; recipient: string; companyId: string; companyRef: string };
  device: { seed: string; publicKey: string; fields: Record<string, unknown>; message: string; signature: string };
  pull: { id: string; timestamp: string; request: string; signature: string };
  roomActivity: { value: Record<string, unknown>; canonical: string; id: string; timestamp: string; signature: string; subject: string; link: string };
  reply: { body: string; fields: Record<string, unknown>; message: string; signature: string };
  meetingSoon: { value: Record<string, unknown>; canonical: string; id: string; timestamp: string; signature: string; subject: string; link: string };
}

async function vectors(): Promise<Vectors> {
  const text = await protocol();
  const start = text.indexOf('<!-- test vectors -->');
  assert.ok(start > 0, 'the document marks its test vectors');
  const block = /```json\n([\s\S]*?)\n```/.exec(text.slice(start));
  assert.ok(block, 'the vectors are a JSON block after the mark');
  return JSON.parse(block[1]!) as Vectors;
}

test("the document's test vectors verify", async () => {
  const v = await vectors();

  // The key: its public half, its id and its fingerprint, from the seed.
  const seed = Buffer.from(v.key.seed, 'hex');
  const key = ed25519FromSeed(seed);
  assert.equal(key.publicKey.toString('base64url'), v.key.publicKey);
  assert.equal(keyId(key.publicKey), v.key.kid);
  assert.equal(fingerprint(key.publicKey), v.key.fingerprint);
  const published = createPublicKey({ key: { kty: 'OKP', crv: 'Ed25519', x: v.key.publicKey }, format: 'jwk' });

  // Canonical JSON.
  assert.ok(v.canonical.length >= 3);
  for (const one of v.canonical) assert.equal(jcs(one.value), one.canonical);

  // An envelope: its canonical form, and its signature in the Standard Webhooks v1a form.
  assert.equal(jcs(v.envelope.value), v.envelope.canonical);
  assert.equal(v.envelope.value.id, v.envelope.id);
  const content = Buffer.from(`${v.envelope.id}.${v.envelope.timestamp}.${v.envelope.canonical}`, 'utf8');
  assert.match(v.envelope.signature, /^v1a,/);
  assert.ok(verify(null, content, published, Buffer.from(v.envelope.signature.slice(4), 'base64')), 'the signature verifies with the published key');
  assert.equal(signV1a([key.privateKey], v.envelope.id, v.envelope.timestamp, v.envelope.canonical), v.envelope.signature,
    'Ed25519 is deterministic: the same key and message give the same signature');
  assert.ok(verifyV1a(v.envelope.signature, [key.publicKey], v.envelope.id, v.envelope.timestamp, v.envelope.canonical));

  // The envelope id, from what it is about.
  const parts = v.envelopeId;
  assert.equal(envelopeId(parts), parts.id);

  // A person and a company, as a relay sees them.
  const salt = Buffer.from(v.pseudonyms.salt, 'hex');
  assert.equal(recipientId(salt, v.pseudonyms.principal), v.pseudonyms.recipient);
  assert.equal(companyRef(salt, v.pseudonyms.companyId), v.pseudonyms.companyRef);

  // A device's signature on an act.
  const device = ed25519FromSeed(Buffer.from(v.device.seed, 'hex'));
  assert.equal(device.publicKey.toString('base64url'), v.device.publicKey);
  assert.equal(`palugada-device/v1\n${jcs(v.device.fields)}`, v.device.message);
  assert.equal(sign(null, Buffer.from(v.device.message, 'utf8'), device.privateKey).toString('base64url'), v.device.signature);

  // A pull, signed over the request line and the relay it is for (STATUS section 2.216).
  assert.equal(v.pull.request, `GET /v1/inbox?after=7&wait=25\n${v.envelope.value.relay}`);
  assert.equal(signV1a([key.privateKey], v.pull.id, v.pull.timestamp, v.pull.request), v.pull.signature);

  // A person's notice about a room (STATUS section 2.213): canonical, signed,
  // and its id made from the notice it tells of.
  const room = v.roomActivity;
  assert.equal(room.value.type, 'room_activity');
  assert.equal(jcs(room.value), room.canonical);
  assert.equal(signV1a([key.privateKey], room.id, room.timestamp, room.canonical), room.signature);
  assert.equal(envelopeId({
    deployment: String(room.value.deployment), relay: String(room.value.relay), link: room.link, type: 'room_activity', subject: room.subject,
  }), room.id);
  // A reply from the person's device: its words hashed, its client id -- a
  // fresh UUID for each reply, unique for the person for all time -- signed
  // beside them.
  assert.equal(v.reply.fields.type, 'reply');
  assert.match(String(v.reply.fields.clientId), /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  assert.equal(v.reply.fields.sha256, createHash('sha256').update(v.reply.body, 'utf8').digest('hex'));
  assert.equal(`palugada-device/v1\n${jcs(v.reply.fields)}`, v.reply.message);
  assert.equal(sign(null, Buffer.from(v.reply.message, 'utf8'), device.privateKey).toString('base64url'), v.reply.signature);

  // A people's meeting about to start (STATUS section 2.215): canonical,
  // signed, and its id made from the notice it tells of.
  const meeting = v.meetingSoon;
  assert.equal(meeting.value.type, 'meeting_soon');
  assert.equal(jcs(meeting.value), meeting.canonical);
  assert.equal(signV1a([key.privateKey], meeting.id, meeting.timestamp, meeting.canonical), meeting.signature);
  assert.equal(envelopeId({
    deployment: String(meeting.value.deployment), relay: String(meeting.value.relay), link: meeting.link, type: 'meeting_soon', subject: meeting.subject,
  }), meeting.id);
  assert.deepEqual(meeting.value.offers, [], 'a reminder offers nothing to press');

  // A seed is the private key, so a reader can rebuild it with any library: PKCS #8 around the 32 bytes.
  const rebuilt = createPrivateKey({ key: Buffer.concat([Buffer.from('302e020100300506032b657004220420', 'hex'), seed]), format: 'der', type: 'pkcs8' });
  assert.equal(sign(null, content, rebuilt).toString('base64'), v.envelope.signature.slice(4));
});

test('a relay built from the document alone checks every vector, with nothing of PALUGADA but its published keys', async () => {
  // Written from the document's own words, with node:crypto and nothing from
  // src/: if the code and its vectors moved together and the prose did not,
  // an independent relay would no longer verify, and this says so.
  const v = await vectors();
  const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  const base32 = (bytes: Buffer) => {
    let bits = 0;
    let value = 0;
    let out = '';
    for (const byte of bytes) {
      value = (value << 8) | byte;
      bits += 8;
      while (bits >= 5) {
        out += ALPHABET[(value >>> (bits - 5)) & 31];
        bits -= 5;
      }
    }
    return bits > 0 ? out + ALPHABET[(value << (5 - bits)) & 31] : out;
  };
  const published = (raw: string) => createPublicKey({ key: { kty: 'OKP', crv: 'Ed25519', x: raw }, format: 'jwk' });
  // Section 4: `v1a,` and standard base64; any one signature that verifies is enough.
  const v1a = (header: string, id: string, timestamp: string, payload: string, raw: string) => header.split(' ').some((one) =>
    one.startsWith('v1a,') && verify(null, Buffer.from(`${id}.${timestamp}.${payload}`, 'utf8'), published(raw), Buffer.from(one.slice(4), 'base64')));

  // Section 2.1: the key id and the fingerprint, from the raw public key.
  const raw = Buffer.from(v.key.publicKey, 'base64url');
  assert.equal(raw.length, 32);
  const hash = createHash('sha256').update(raw).digest();
  assert.equal(hash.toString('hex').slice(0, 16), v.key.kid);
  assert.equal(base32(hash).slice(0, 24), v.key.fingerprint);

  // Sections 3 and 4: the body is the canonical form as sent, and the signature is over it.
  assert.deepEqual(JSON.parse(v.envelope.canonical), v.envelope.value);
  assert.ok(v1a(v.envelope.signature, v.envelope.id, v.envelope.timestamp, v.envelope.canonical, v.key.publicKey));
  assert.ok(!v1a(v.envelope.signature, v.envelope.id, v.envelope.timestamp, `${v.envelope.canonical} `, v.key.publicKey), 'one byte more and it fails');
  assert.ok(v1a(v.pull.signature, v.pull.id, v.pull.timestamp, v.pull.request, v.key.publicKey), 'a pull, over its request line');

  // Section 2.2: the pseudonyms, an HMAC keyed with the salt's bytes over the text.
  const salt = Buffer.from(v.pseudonyms.salt, 'hex');
  const hmac = (text: string) => createHmac('sha256', salt).update(text, 'utf8').digest();
  assert.equal(base32(hmac(v.pseudonyms.principal)).slice(0, 26), v.pseudonyms.recipient);
  assert.equal(`co_${base32(hmac(v.pseudonyms.companyId)).slice(0, 16)}`, v.pseudonyms.companyRef);

  // Section 7: the envelope id, byte by byte.
  const parts = v.envelopeId;
  const bytes = createHash('sha256')
    .update([parts.deployment, parts.relay, parts.link ?? '', parts.type, parts.subject, String(parts.version)].join('\n'), 'utf8')
    .digest().subarray(0, 16);
  bytes[6] = (bytes[6]! & 0x0f) | 0x80;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  assert.equal(`${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`, parts.id);

  // Section 8: the device form, one line feed and the canonical fields, signed in base64url.
  assert.equal(v.device.message, `palugada-device/v1\n${v.device.message.split('\n')[1]}`);
  assert.deepEqual(JSON.parse(v.device.message.split('\n')[1]!), v.device.fields);
  assert.ok(verify(null, Buffer.from(v.device.message, 'utf8'), published(v.device.publicKey), Buffer.from(v.device.signature, 'base64url')));

  // Section 6.3: a person's notice about a room, signed as every envelope is;
  // and a reply's device form, its words hashed as section 8 says.
  assert.deepEqual(JSON.parse(v.roomActivity.canonical), v.roomActivity.value);
  assert.ok(v1a(v.roomActivity.signature, v.roomActivity.id, v.roomActivity.timestamp, v.roomActivity.canonical, v.key.publicKey));
  assert.equal(JSON.parse(v.reply.message.split('\n')[1]!).sha256, createHash('sha256').update(v.reply.body, 'utf8').digest('hex'));
  assert.ok(verify(null, Buffer.from(v.reply.message, 'utf8'), published(v.device.publicKey), Buffer.from(v.reply.signature, 'base64url')));

  // Section 6.3 again: a people's meeting about to start, signed as every envelope is.
  assert.deepEqual(JSON.parse(v.meetingSoon.canonical), v.meetingSoon.value);
  assert.ok(v1a(v.meetingSoon.signature, v.meetingSoon.id, v.meetingSoon.timestamp, v.meetingSoon.canonical, v.key.publicKey));
});
