/**
 * The owner's second factor (PRD v2 F12.5, F10.10).
 *
 * F12.5 is a P0 that spent this whole build graded "needs an application
 * PALUGADA does not have". Half of that was true and the wrong half was acted
 * on: the client is an application, but *verifying* a second factor is
 * arithmetic, and arithmetic is the one thing a control plane should never be
 * taking a caller's word for. `decide` used to accept `assurance: 'mfa'` as a
 * string, so F10.10's "tier 3 only through the app with MFA" was, in practice,
 * "tier 3 for anyone who types mfa".
 *
 * These tests run the real thing. TOTP is checked against RFC 6238's own
 * published vectors, so what is being tested is conformance rather than
 * self-consistency; WebAuthn is checked against signatures made here by a real
 * P-256 key, which is exactly what a phone produces and differs from one only
 * in where the private key lives.
 */
import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, createSign, generateKeyPairSync, randomUUID } from 'node:crypto';
import { closePools } from '../../src/db/pool.ts';
import { withTenant } from '../../src/db/tenant.ts';
import { InMemorySecretManager } from '../../src/secrets/manager.ts';
import {
  ChallengeStore,
  OwnerMfa,
  decodeBase32,
  encodeBase32,
  newTotpSecret,
  stepFor,
  totpCode,
  type WebAuthnAssertion,
} from '../../src/owner/mfa.ts';
import { isPalugadaError } from '../../src/errors.ts';
import * as inbox from '../../src/inbox/inbox.ts';
import { createCompany, type Fixture } from '../helpers/fixtures.ts';
import { ensureSchema, resetData, closeSetup } from '../helpers/setup.ts';

before(ensureSchema);
beforeEach(resetData);
after(async () => {
  await closePools();
  await closeSetup();
});

const RP_ID = 'palugada.local';
const ORIGIN = 'https://palugada.local';

/**
 * RFC 6238 Appendix B, the SHA-1 rows.
 *
 * The seed is the ASCII string "12345678901234567890"; the published codes are
 * eight digits and this implementation produces six, so the assertion is on the
 * last six — which is what a six-digit authenticator shows for the same seed
 * and the same second.
 */
const RFC6238_SECRET = encodeBase32(Buffer.from('12345678901234567890', 'ascii'));
const RFC6238_VECTORS: Array<{ unixTime: number; eightDigits: string }> = [
  { unixTime: 59, eightDigits: '94287082' },
  { unixTime: 1_111_111_109, eightDigits: '07081804' },
  { unixTime: 1_111_111_111, eightDigits: '14050471' },
  { unixTime: 1_234_567_890, eightDigits: '89005924' },
  { unixTime: 2_000_000_000, eightDigits: '69279037' },
];

function mfaWith(options: { secrets?: InMemorySecretManager; now?: () => Date } = {}) {
  const secrets = options.secrets ?? new InMemorySecretManager();
  const challenges = new ChallengeStore();
  const mfa = new OwnerMfa({
    secrets,
    challenges,
    rpId: RP_ID,
    origin: ORIGIN,
    ...(options.now ? { now: options.now } : {}),
  });
  return { mfa, secrets, challenges };
}

/* ------------------------------------------------------------------ TOTP --- */

test('TOTP matches RFC 6238\'s published vectors (F12.5)', () => {
  const secret = decodeBase32(RFC6238_SECRET);
  for (const vector of RFC6238_VECTORS) {
    const step = Math.floor(vector.unixTime / 30);
    assert.equal(
      totpCode(secret, step),
      vector.eightDigits.slice(-6),
      `RFC 6238 at T=${vector.unixTime}`,
    );
  }
});

test('base32 round-trips the alphabet authenticator apps use (F12.5)', () => {
  for (const length of [1, 2, 5, 10, 20, 32]) {
    const bytes = Buffer.from(Array.from({ length }, (_, i) => (i * 37 + 11) & 0xff));
    assert.deepEqual(decodeBase32(encodeBase32(bytes)), bytes);
  }
  // A secret pasted with the padding and spacing an app displays still decodes.
  assert.deepEqual(decodeBase32('gezd gnbv gy3t qojq===='), decodeBase32('GEZDGNBVGY3TQOJQ'));
});

test('an enrolled TOTP authenticator accepts the right code and nothing else (F12.5)', async () => {
  const at = new Date('2026-09-07T05:00:00Z');
  const { mfa, secrets } = mfaWith({ now: () => at });
  const { secret } = newTotpSecret('owner phone');
  secrets.set('vault://owner/totp', secret);
  await mfa.enrolTotp({ label: 'owner phone', secretRef: 'vault://owner/totp' });

  const verified = await mfa.verifyTotp(totpCode(decodeBase32(secret), stepFor(at)));
  assert.equal(verified.kind, 'totp');
  assert.equal(verified.label, 'owner phone');

  await assert.rejects(
    () => mfa.verifyTotp('000000'),
    (error: unknown) => isPalugadaError(error, 'mfa.code_invalid'),
  );
});

/**
 * A code is good for thirty seconds, and thirty seconds is long enough to be
 * read over a shoulder, forwarded, or replayed out of a log. So the step that
 * produced an accepted code is remembered, and the same code presented twice
 * is refused the second time — with a different error, because "that has been
 * used" and "that is wrong" are different stories and only one is somebody
 * trying.
 */
test('a TOTP code cannot be used twice (F12.5)', async () => {
  const at = new Date('2026-09-07T05:00:00Z');
  const { mfa, secrets } = mfaWith({ now: () => at });
  const { secret } = newTotpSecret('owner phone');
  secrets.set('vault://owner/totp', secret);
  await mfa.enrolTotp({ label: 'owner phone', secretRef: 'vault://owner/totp' });

  const code = totpCode(decodeBase32(secret), stepFor(at));
  await mfa.verifyTotp(code);
  await assert.rejects(
    () => mfa.verifyTotp(code),
    (error: unknown) => isPalugadaError(error, 'mfa.replayed'),
  );
});

/**
 * A phone's clock drifts. One step either side is accepted, because an owner
 * who has to retype a code they read correctly stops using the feature — and
 * two steps would double the window an intercepted code stays usable in.
 */
test('a TOTP code from one step either side is accepted, and two is not (F12.5)', async () => {
  const at = new Date('2026-09-07T05:00:00Z');
  const { mfa, secrets } = mfaWith({ now: () => at });
  const { secret } = newTotpSecret('owner phone');
  secrets.set('vault://owner/totp', secret);
  await mfa.enrolTotp({ label: 'owner phone', secretRef: 'vault://owner/totp' });

  const now = stepFor(at);
  await mfa.verifyTotp(totpCode(decodeBase32(secret), now - 1));
  await assert.rejects(
    () => mfa.verifyTotp(totpCode(decodeBase32(secret), now + 2)),
    (error: unknown) => isPalugadaError(error, 'mfa.code_invalid'),
  );
});

test('a deployment with no authenticator refuses rather than allows (F12.5)', async () => {
  const { mfa } = mfaWith();
  await assert.rejects(
    () => mfa.verifyTotp('123456'),
    (error: unknown) => isPalugadaError(error, 'mfa.not_enrolled'),
  );
});

/**
 * Every attempt is on the record, including the ones that failed.
 *
 * A burst of failures against the owner's authenticator is the shape of
 * somebody trying, and a log that only kept successes would hide exactly that.
 */
test('every attempt is recorded, successful or not (F12.5)', async () => {
  const at = new Date('2026-09-07T05:00:00Z');
  const { mfa, secrets } = mfaWith({ now: () => at });
  const { secret } = newTotpSecret('owner phone');
  secrets.set('vault://owner/totp', secret);
  await mfa.enrolTotp({ label: 'owner phone', secretRef: 'vault://owner/totp' });

  await mfa.verifyTotp(totpCode(decodeBase32(secret), stepFor(at)));
  await assert.rejects(() => mfa.verifyTotp('000000'));

  const attempts = await attemptLog();
  assert.deepEqual(
    attempts.map((row) => [row.succeeded, row.reason]),
    [[true, null], [false, 'mfa.code_invalid']],
  );
});

/* -------------------------------------------------------------- WebAuthn --- */

/**
 * A stand-in for the owner's phone.
 *
 * The only difference from a real one is where the private key lives. It
 * produces the same three fields a browser hands back — `authenticatorData`,
 * `clientDataJSON` and an ES256 signature over their concatenation — so
 * everything the verifier checks is being checked against the real shape.
 */
function phone(options: { rpId?: string; signCount?: number } = {}) {
  const { publicKey, privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const credentialId = Buffer.from(randomUUID()).toString('base64url');
  let counter = options.signCount ?? 0;

  return {
    credentialId,
    publicKeyPem: publicKey.export({ type: 'spki', format: 'pem' }).toString(),
    assert(input: {
      challenge: string;
      origin?: string;
      type?: string;
      userVerified?: boolean;
      userPresent?: boolean;
      signCount?: number;
      tamper?: boolean;
    }): WebAuthnAssertion {
      const clientDataJSON = Buffer.from(
        JSON.stringify({
          type: input.type ?? 'webauthn.get',
          challenge: input.challenge,
          origin: input.origin ?? ORIGIN,
        }),
        'utf8',
      );

      counter = input.signCount ?? counter + 1;
      const flags =
        (input.userPresent === false ? 0 : 0x01) | (input.userVerified === false ? 0 : 0x04);
      const authenticatorData = Buffer.concat([
        createHash('sha256').update(options.rpId ?? RP_ID).digest(),
        Buffer.from([flags]),
        (() => {
          const c = Buffer.alloc(4);
          c.writeUInt32BE(counter);
          return c;
        })(),
      ]);

      const signed = Buffer.concat([
        authenticatorData,
        createHash('sha256').update(clientDataJSON).digest(),
      ]);
      const signature = createSign('SHA256').update(signed).sign(privateKey);
      if (input.tamper) signature[signature.length - 1] = signature[signature.length - 1]! ^ 0xff;

      return {
        credentialId,
        authenticatorData: authenticatorData.toString('base64url'),
        clientDataJSON: clientDataJSON.toString('base64url'),
        signature: signature.toString('base64url'),
      };
    },
  };
}

test('a passkey signature from the enrolled phone is accepted (F12.5)', async () => {
  const { mfa } = mfaWith();
  const device = phone();
  await mfa.enrolWebAuthn({
    label: 'owner iPhone',
    credentialId: device.credentialId,
    publicKeyPem: device.publicKeyPem,
  });

  const verified = await mfa.verifyWebAuthn(device.assert({ challenge: mfa.challenge() }));
  assert.equal(verified.kind, 'webauthn');
  assert.equal(verified.label, 'owner iPhone');
});

/**
 * Every refusal below is a real attack rather than a formality, which is why
 * each is asserted separately: a test that only checked "a bad assertion is
 * rejected" would pass with five of the six checks deleted.
 */
test('a passkey assertion is refused for each thing that makes it not one (F12.5)', async () => {
  const { mfa } = mfaWith();
  const device = phone();
  await mfa.enrolWebAuthn({
    label: 'owner iPhone',
    credentialId: device.credentialId,
    publicKeyPem: device.publicKeyPem,
  });

  // A signature captured once and sent again. Without the challenge check the
  // whole ceremony is a fixed string anybody who saw it can resend for ever.
  const used = device.assert({ challenge: mfa.challenge() });
  await mfa.verifyWebAuthn(used);
  await assert.rejects(
    () => mfa.verifyWebAuthn(used),
    (error: unknown) => isPalugadaError(error, 'mfa.challenge_unknown'),
  );

  // A challenge this process never issued.
  await assert.rejects(
    () => mfa.verifyWebAuthn(device.assert({ challenge: 'a challenge nobody issued' })),
    (error: unknown) => isPalugadaError(error, 'mfa.challenge_unknown'),
  );

  // Collected by another site the owner uses the same phone with.
  await assert.rejects(
    () => mfa.verifyWebAuthn(device.assert({ challenge: mfa.challenge(), origin: 'https://elsewhere.example' })),
    (error: unknown) => isPalugadaError(error, 'mfa.wrong_origin'),
  );

  // A registration ceremony replayed as an authentication.
  await assert.rejects(
    () => mfa.verifyWebAuthn(device.assert({ challenge: mfa.challenge(), type: 'webauthn.create' })),
    (error: unknown) => isPalugadaError(error, 'mfa.wrong_ceremony'),
  );

  // F12.5 says *biometric*. A key that was merely touched is a phone in
  // somebody else's hand; a key that was user-verified was unlocked by a
  // person.
  await assert.rejects(
    () => mfa.verifyWebAuthn(device.assert({ challenge: mfa.challenge(), userVerified: false })),
    (error: unknown) => isPalugadaError(error, 'mfa.not_user_verified'),
  );

  // The arithmetic itself.
  await assert.rejects(
    () => mfa.verifyWebAuthn(device.assert({ challenge: mfa.challenge(), tamper: true })),
    (error: unknown) => isPalugadaError(error, 'mfa.signature_invalid'),
  );

  // A device that is not enrolled at all.
  const stranger = phone();
  await assert.rejects(
    () => mfa.verifyWebAuthn(stranger.assert({ challenge: mfa.challenge() })),
    (error: unknown) => isPalugadaError(error, 'mfa.unknown_credential'),
  );
});

/**
 * A phone signed for a different relying party.
 *
 * The origin check is the browser's word; this one is the *authenticator's*,
 * and it is not forgeable by a page. Both are needed: a page can lie about
 * where it is, and a hardware key cannot.
 */
test('a passkey signed for another relying party is refused (F12.5)', async () => {
  const { mfa } = mfaWith();
  const device = phone({ rpId: 'attacker.example' });
  await mfa.enrolWebAuthn({
    label: 'owner iPhone',
    credentialId: device.credentialId,
    publicKeyPem: device.publicKeyPem,
  });

  await assert.rejects(
    () => mfa.verifyWebAuthn(device.assert({ challenge: mfa.challenge() })),
    (error: unknown) => isPalugadaError(error, 'mfa.wrong_relying_party'),
  );
});

/**
 * An authenticator counts its own signatures. A counter that fails to advance
 * means the assertion was replayed or the key was cloned, and both have the
 * same answer.
 */
test('a signature counter that does not advance is refused (F12.5)', async () => {
  const { mfa } = mfaWith();
  const device = phone({ signCount: 10 });
  await mfa.enrolWebAuthn({
    label: 'owner iPhone',
    credentialId: device.credentialId,
    publicKeyPem: device.publicKeyPem,
  });

  await mfa.verifyWebAuthn(device.assert({ challenge: mfa.challenge(), signCount: 11 }));
  await assert.rejects(
    () => mfa.verifyWebAuthn(device.assert({ challenge: mfa.challenge(), signCount: 11 })),
    (error: unknown) => isPalugadaError(error, 'mfa.counter_did_not_advance'),
  );
});

/* --------------------------------------------------------------- F10.10 --- */

async function tier3Item(fixture: Fixture): Promise<string> {
  return inbox.requestApproval({
    companyId: fixture.companyId,
    capabilityName: 'database.drop',
    actionSummary: 'drop the production database',
    rationale: 'the owner asked',
    consequenceIfDenied: 'nothing happens',
    tier: 3,
  });
}

/**
 * The point of all of the above: F10.10 is now enforced rather than asserted.
 *
 * The old rule asked the caller how the owner had been authenticated and
 * believed the answer. The new one asks for the second factor and checks it,
 * so approving a tier 3 action requires possession of an enrolled device
 * rather than a string.
 */
test('a tier 3 approval needs a real second factor, not a claim (F10.10, F12.5)', async () => {
  const fixture = await createCompany('mfa-tier3');
  const at = new Date('2026-09-07T05:00:00Z');
  const { mfa, secrets } = mfaWith({ now: () => at });
  const { secret } = newTotpSecret('owner phone');
  secrets.set('vault://owner/totp', secret);
  await mfa.enrolTotp({ label: 'owner phone', secretRef: 'vault://owner/totp' });

  // What used to be enough, and is now not: the caller's word.
  const claimed = await tier3Item(fixture);
  await assert.rejects(
    () => inbox.decide(fixture.companyId, claimed, 'approve', '', {
      channel: 'app',
      assurance: 'mfa',
    }),
    (error: unknown) => isPalugadaError(error, 'approval.channel_forbidden'),
  );

  // A proof that does not verify is refused with the reason it failed, not
  // flattened into "forbidden".
  await assert.rejects(
    () => inbox.decide(fixture.companyId, claimed, 'approve', '', {
      channel: 'app',
      proof: { totp: '000000' },
      mfa,
    }),
    (error: unknown) => isPalugadaError(error, 'mfa.code_invalid'),
  );

  // And the real thing works.
  await inbox.decide(fixture.companyId, claimed, 'approve', '', {
    channel: 'app',
    proof: { totp: totpCode(decodeBase32(secret), stepFor(at)) },
    mfa,
  });

  const decided = await withTenant(fixture.companyId, async (tx) => {
    const { rows } = await tx.query<{ payload: Record<string, unknown> }>(
      "SELECT payload FROM events WHERE type = 'owner.decided'",
    );
    return rows[0]!.payload;
  });
  assert.equal(decided.assurance, 'mfa');
  // F10.8 and F12.5's audit half: which device approved it, so the decision
  // can be matched to the authentication that authorised it.
  assert.equal(decided.factor, 'totp');
  assert.equal(decided.device, 'owner phone');
});

/**
 * A deployment that never set MFA up cannot approve a tier 3 action at all.
 *
 * F12.5 is a P0. The consequence of not meeting it should be that irreversible
 * actions wait, not that they proceed — so the absence of a verifier is a
 * refusal rather than a bypass.
 */
test('a deployment with no MFA configured cannot approve tier 3 (F10.10, F12.5)', async () => {
  const fixture = await createCompany('mfa-absent');
  const item = await tier3Item(fixture);

  await assert.rejects(
    () => inbox.decide(fixture.companyId, item, 'approve', '', { channel: 'app' }),
    (error: unknown) =>
      isPalugadaError(error, 'approval.channel_forbidden')
      && /no MFA verifier configured/.test((error as Error).message),
  );

  const refusals = await withTenant(fixture.companyId, async (tx) => {
    const { rows } = await tx.query<{ payload: { reason?: string } }>(
      "SELECT payload FROM events WHERE type = 'security.tier3_channel_refused'",
    );
    return rows;
  });
  assert.equal(refusals[0]!.payload.reason, 'no_verifier');
});

/**
 * The chat rule still comes first, and a real second factor does not lift it.
 *
 * F10.10 bars tier 3 from a message channel outright — not "unless the owner
 * proves who they are". A forwarded message and a real one look alike, and the
 * second factor proves possession of a device, not that the request came from
 * the surface the owner meant to use.
 */
test('a second factor does not buy a tier 3 approval over chat (F10.10)', async () => {
  const fixture = await createCompany('mfa-chat');
  const at = new Date('2026-09-07T05:00:00Z');
  const { mfa, secrets } = mfaWith({ now: () => at });
  const { secret } = newTotpSecret('owner phone');
  secrets.set('vault://owner/totp', secret);
  await mfa.enrolTotp({ label: 'owner phone', secretRef: 'vault://owner/totp' });

  const item = await tier3Item(fixture);
  await assert.rejects(
    () => inbox.decide(fixture.companyId, item, 'approve', '', {
      channel: 'chat',
      proof: { totp: totpCode(decodeBase32(secret), stepFor(at)) },
      mfa,
    }),
    (error: unknown) => isPalugadaError(error, 'approval.channel_forbidden'),
  );

  // Refused before the factor was spent: an owner who is told "not over chat"
  // must still be able to use that code in the app.
  assert.deepEqual(await attemptLog(), []);
});

async function attemptLog(): Promise<Array<{ succeeded: boolean; reason: string | null }>> {
  const { withControlPlane } = await import('../../src/db/tenant.ts');
  return withControlPlane(async (tx) => {
    const { rows } = await tx.query<{ succeeded: boolean; reason: string | null }>(
      'SELECT succeeded, reason FROM owner_authentications ORDER BY occurred_at, succeeded DESC',
    );
    return rows;
  });
}
