/**
 * The relay protocol is the document a third party builds a relay from
 * (`docs/relay-protocol.md`; F19.19, F19.20; STATUS section 2.208), so the
 * document and the code are held to each other here: every envelope type the
 * code sends or takes is described there, nothing is described that the code
 * does not know, and the test vectors in it verify against the code.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createPrivateKey, createPublicKey, sign, verify } from 'node:crypto';
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

  // A pull, signed over the request line.
  assert.equal(signV1a([key.privateKey], v.pull.id, v.pull.timestamp, v.pull.request), v.pull.signature);

  // A seed is the private key, so a reader can rebuild it with any library: PKCS #8 around the 32 bytes.
  const rebuilt = createPrivateKey({ key: Buffer.concat([Buffer.from('302e020100300506032b657004220420', 'hex'), seed]), format: 'der', type: 'pkcs8' });
  assert.equal(sign(null, content, rebuilt).toString('base64'), v.envelope.signature.slice(4));
});
