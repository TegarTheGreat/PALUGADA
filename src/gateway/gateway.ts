/**
 * The runtime gateway (PRD v2 F12.7, F12.8, F12.9, F12.10).
 *
 * Every runtime that is not this process reaches PALUGADA through here, and it
 * reaches nothing else. §7.2 puts it plainly: a runtime has no database, no
 * secret manager, and no network but this. What the gateway adds on top of the
 * adapter protocol is identity.
 *
 * **A runtime is a device (F12.7).** It has a name, a public key, and a status.
 * A new one is `pending` and can do nothing until the owner pairs it. That
 * matters because the adapter protocol is deliberately easy to speak: anything
 * that can write JSON to a pipe can be a runtime, which is a feature until it
 * is somebody else's process.
 *
 * **It proves it is itself (F12.7).** The gateway issues a nonce; the device
 * signs it; the gateway verifies against the key it was paired with. A stolen
 * device id is therefore not a working device, and a captured signature is not
 * a reusable one -- the nonce is consumed on first use, and a second attempt is
 * refused with a reason rather than silently accepted.
 *
 * The public key is a *public* key. The gateway stores nothing it could
 * impersonate a device with, so a compromise of this table lets an attacker
 * read who the devices are and not become one.
 *
 * **Side effects carry an idempotency key (F12.8).** The gateway remembers the
 * answer it gave for each one. A retried call receives the first answer rather
 * than causing a second effect, which is what makes an at-least-once transport
 * safe to put in front of an external action.
 *
 * **An unvouched-for device is quarantined (F12.10).** Quarantine means tier 0:
 * it may read and may not change anything. That is the same treatment an
 * unsigned bundle gets, and for the same reason -- the question is not whether
 * the code is malicious, it is whether anybody has said it is not.
 */
import { createHash, createPublicKey, randomBytes, timingSafeEqual, verify } from 'node:crypto';
import { withTenant, type TenantClient } from '../db/tenant.ts';
import { appendEvent } from '../audit/event-log.ts';
import { PalugadaError } from '../errors.ts';
import { TIER, type Tier } from '../domain/tier.ts';

/** How long a challenge is good for. Long enough to sign, short enough to matter. */
export const CHALLENGE_TTL_MS = 2 * 60_000;

export type DeviceStatus = 'pending' | 'paired' | 'revoked';

export interface Device {
  id: string;
  name: string;
  runtime: string;
  status: DeviceStatus;
  quarantined: boolean;
  lastSeenAt: Date | null;
  /**
   * What the owner compares with the fingerprint the machine itself shows
   * before pairing it, and what the pairing then names (see `pairDevice`).
   */
  keyFingerprint: string;
}

/**
 * Registers a runtime. It is `pending` and can do nothing yet (F12.7).
 *
 * Registration is deliberately not approval. A device that could enrol itself
 * into a working state would make pairing a formality, and the owner would
 * discover a new runtime by seeing what it did.
 */
export async function registerDevice(input: {
  companyId: string;
  name: string;
  runtime: string;
  publicKeyPem: string;
}): Promise<Device> {
  // A key nothing can verify with would be paired, and then refuse every
  // connection as a bad signature -- which reads as an attack, not a typo.
  try {
    createPublicKey(input.publicKeyPem);
  } catch {
    throw new PalugadaError(
      'contract.violation',
      'publicKeyPem is not a public key in PEM form',
      { field: 'publicKeyPem' },
    );
  }
  return withTenant(input.companyId, async (tx) => {
    const { rows } = await tx.query<{
      id: string;
      name: string;
      runtime: string;
      status: DeviceStatus;
      quarantined: boolean;
      last_seen_at: Date | null;
    }>(
      `INSERT INTO gateway_devices (company_id, name, runtime, public_key)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (company_id, name) DO UPDATE
         -- A re-registration with a different key is a *new* device wearing an
         -- old name, so it goes back to pending. Letting a key change without
         -- re-pairing would make the pairing meaningless.
         SET public_key = EXCLUDED.public_key,
             status = CASE WHEN gateway_devices.public_key = EXCLUDED.public_key
                           THEN gateway_devices.status ELSE 'pending' END,
             paired_at = CASE WHEN gateway_devices.public_key = EXCLUDED.public_key
                              THEN gateway_devices.paired_at ELSE NULL END,
             quarantined = CASE WHEN gateway_devices.public_key = EXCLUDED.public_key
                                THEN gateway_devices.quarantined ELSE true END
       RETURNING id, name, runtime, status, quarantined, last_seen_at`,
      [input.companyId, input.name, input.runtime, input.publicKeyPem],
    );
    const row = rows[0]!;

    await appendEvent(tx, {
      companyId: input.companyId,
      type: 'gateway.device_registered',
      actor: 'system',
      payload: {
        deviceId: row.id,
        name: row.name,
        runtime: row.runtime,
        status: row.status,
        // The key's fingerprint, so "is this the same device" is answerable
        // from the log without the log carrying the key.
        keyFingerprint: fingerprint(input.publicKeyPem),
      },
    });

    return {
      id: row.id,
      name: row.name,
      runtime: row.runtime,
      status: row.status,
      quarantined: row.quarantined,
      lastSeenAt: row.last_seen_at,
      keyFingerprint: fingerprint(input.publicKeyPem),
    };
  });
}

/**
 * The owner's decision (F12.7). `quarantined` stays true unless lifted.
 *
 * **It names the key.** Pairing says "this key is the machine I mean", and a
 * device id does not say which key: a re-registration under the same name
 * keeps the id and swaps the key. So the owner confirms the fingerprint the
 * machine shows, and a pairing whose fingerprint is not the registered key's
 * is refused -- otherwise whichever key registered last, between the owner
 * looking and the owner pressing, is the one that would be trusted.
 *
 * **A revoked key stays revoked.** Pairing it again would undo the revocation
 * through the door meant for new machines; a machine coming back registers a
 * new key, which is pending like any other.
 */
export async function pairDevice(
  companyId: string,
  deviceId: string,
  options: { keyFingerprint: string; liftQuarantine?: boolean },
): Promise<void> {
  const quarantined = !(options.liftQuarantine ?? false);
  await withTenant(companyId, async (tx) => {
    const { rows } = await tx.query<{ status: DeviceStatus; public_key: string }>(
      'SELECT status, public_key FROM gateway_devices WHERE id = $1 FOR UPDATE',
      [deviceId],
    );
    const device = rows[0];
    if (!device || device.status === 'revoked') {
      throw new PalugadaError(
        'gateway.not_pairable',
        device
          ? `device ${deviceId} was revoked; register the machine with a new key to pair it`
          : `no device ${deviceId}`,
        { deviceId, status: device?.status ?? null },
      );
    }
    let registered: string;
    try {
      registered = fingerprint(device.public_key);
    } catch {
      // Registered before keys were checked at the door: nothing could verify
      // its signatures, so pairing it would trust nothing in particular.
      throw new PalugadaError(
        'gateway.not_pairable',
        `device ${deviceId} is registered with something that is not a public key; register it again`,
        { deviceId, status: device.status },
      );
    }
    if (registered !== typedFingerprint(options.keyFingerprint)) {
      throw new PalugadaError(
        'gateway.key_mismatch',
        `device ${deviceId} is registered with key ${registered}, not the key confirmed; `
          + 'compare again with the fingerprint the machine shows',
        { deviceId, registered, confirmed: options.keyFingerprint },
      );
    }
    await tx.query(
      `UPDATE gateway_devices
          SET status = 'paired', paired_at = now(), quarantined = $2
        WHERE id = $1`,
      [deviceId, quarantined],
    );
    await appendEvent(tx, {
      companyId,
      type: 'gateway.device_paired',
      actor: 'owner',
      payload: { deviceId, keyFingerprint: registered, quarantined },
    });
  });
}

export async function revokeDevice(companyId: string, deviceId: string): Promise<void> {
  await withTenant(companyId, async (tx) => {
    await tx.query(
      `UPDATE gateway_devices SET status = 'revoked', paired_at = NULL, quarantined = true
        WHERE id = $1 AND company_id = $2`,
      [deviceId, companyId],
    );
    await appendEvent(tx, {
      companyId,
      type: 'gateway.device_revoked',
      actor: 'owner',
      payload: { deviceId },
    });
  });
}

/** Issues a nonce for a device to sign (F12.7). */
export async function issueChallenge(companyId: string, deviceId: string): Promise<string> {
  const nonce = randomBytes(32).toString('base64url');
  await withTenant(companyId, async (tx) => {
    await tx.query(
      `INSERT INTO gateway_challenges (nonce, company_id, device_id, expires_at)
       VALUES ($1, $2, $3, now() + make_interval(secs => $4))`,
      [nonce, companyId, deviceId, CHALLENGE_TTL_MS / 1000],
    );
  });
  return nonce;
}

export interface Connection {
  deviceId: string;
  runtime: string;
  /** F12.10: the highest tier this connection may reach. */
  maxTier: Tier;
}

/**
 * Verifies a signed nonce and opens a connection (F12.7, F12.10).
 *
 * Four things have to hold and each failure has its own code, because "the
 * connection was refused" is not an answer anybody can act on: an unpaired
 * device needs the owner, a bad signature needs the operator, a consumed nonce
 * needs a fresh challenge.
 */
export async function connect(input: {
  companyId: string;
  deviceId: string;
  nonce: string;
  signatureBase64: string;
}): Promise<Connection> {
  // The whole decision is taken in one transaction and *returned* rather than
  // thrown from inside it. Throwing there would roll the transaction back and
  // take the security event with it -- a refused connection with no trace,
  // which is the one thing an audit log must never do. It would also un-consume
  // the nonce, so a captured signature could be presented until one attempt
  // happened to succeed.
  const verdict = await withTenant(input.companyId, async (tx): Promise<Connection | Refusal> => {
    const { rows: devices } = await tx.query<{
      runtime: string;
      status: DeviceStatus;
      quarantined: boolean;
      public_key: string;
    }>(
      'SELECT runtime, status, quarantined, public_key FROM gateway_devices WHERE id = $1',
      [input.deviceId],
    );
    const device = devices[0];
    if (!device || device.status !== 'paired') {
      return {
        refused: true,
        code: 'gateway.unpaired',
        message: `device ${input.deviceId} is ${device?.status ?? 'unknown'} and may not connect`,
        details: { deviceId: input.deviceId, status: device?.status ?? null },
      };
    }

    // Consumed in the same statement that reads it, so two connections racing
    // on one captured signature cannot both succeed.
    const { rows: challenges } = await tx.query<{ consumed: boolean; expired: boolean }>(
      `UPDATE gateway_challenges
          SET consumed_at = now()
        WHERE nonce = $1 AND device_id = $2 AND consumed_at IS NULL AND expires_at > now()
        RETURNING true AS consumed, false AS expired`,
      [input.nonce, input.deviceId],
    );
    if (challenges.length === 0) {
      return {
        refused: true,
        code: 'gateway.replayed',
        message: 'that challenge has been used already, or has expired',
        details: { deviceId: input.deviceId },
      };
    }

    if (!verifySignature(device.public_key, input.nonce, input.signatureBase64)) {
      await appendEvent(tx, {
        companyId: input.companyId,
        type: 'security.gateway_bad_signature',
        actor: 'system',
        payload: { deviceId: input.deviceId },
      });
      return {
        refused: true,
        code: 'gateway.bad_signature',
        message: 'the signature does not match the key this device was paired with',
        details: { deviceId: input.deviceId },
      };
    }

    await tx.query('UPDATE gateway_devices SET last_seen_at = now() WHERE id = $1', [
      input.deviceId,
    ]);

    return {
      deviceId: input.deviceId,
      runtime: device.runtime,
      // F12.10: quarantine is tier 0. It may read; it may not change anything.
      maxTier: device.quarantined ? TIER.READ_ONLY : TIER.IRREVERSIBLE,
    };
  });

  if ('refused' in verdict) {
    throw new PalugadaError(verdict.code, verdict.message, verdict.details);
  }
  return verdict;
}

interface Refusal {
  refused: true;
  code: 'gateway.unpaired' | 'gateway.replayed' | 'gateway.bad_signature';
  message: string;
  details: Record<string, unknown>;
}

/**
 * F12.10, applied to one action.
 *
 * Separate from the broker's own tier gate rather than folded into it. The
 * broker asks whether the *division* may take this action; this asks whether
 * the *device* may. Both have to be satisfied and neither can grant what the
 * other refuses, which is the same shape as policy and tier in section 8.8.
 */
export function assertWithinQuarantine(connection: Connection, tier: Tier): void {
  if (tier > connection.maxTier) {
    throw new PalugadaError(
      'gateway.quarantined',
      `device ${connection.deviceId} is quarantined and may not take a tier ${tier} action`,
      { deviceId: connection.deviceId, tier, maxTier: connection.maxTier },
    );
  }
}

/* ------------------------------------------------------------- idempotency --- */

export type DedupeOutcome<T> =
  | { replayed: false; commit(response: T): Promise<void>; fail(): Promise<void> }
  | { replayed: true; response: T | null };

/**
 * F12.8: claims an idempotency key, or hands back what it answered last time.
 *
 * The claim is an insert, so two concurrent calls with one key cannot both win:
 * the loser sees the conflict and is told it is a replay. A claim left
 * `in_flight` -- the process died mid-effect -- replays as `in_flight` with a
 * null response, which is the honest answer. The caller has to decide whether
 * repeating the effect is safe; the gateway must not decide that for it, since
 * only the caller knows whether its effect is repeatable.
 */
export async function claimIdempotencyKey<T>(
  companyId: string,
  deviceId: string,
  key: string,
  method: string,
): Promise<DedupeOutcome<T>> {
  const claimed = await withTenant(companyId, async (tx: TenantClient) => {
    const { rows } = await tx.query<{ claimed: boolean }>(
      `INSERT INTO gateway_dedupe (company_id, device_id, idempotency_key, method)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (device_id, idempotency_key) DO NOTHING
       RETURNING true AS claimed`,
      [companyId, deviceId, key, method],
    );
    return rows.length > 0;
  });

  if (!claimed) {
    const previous = await withTenant(companyId, async (tx) => {
      const { rows } = await tx.query<{ response: T | null; status: string }>(
        `SELECT response, status FROM gateway_dedupe
          WHERE device_id = $1 AND idempotency_key = $2`,
        [deviceId, key],
      );
      return rows[0] ?? null;
    });
    return { replayed: true, response: previous?.response ?? null };
  }

  return {
    replayed: false,
    async commit(response: T) {
      await withTenant(companyId, async (tx) => {
        await tx.query(
          `UPDATE gateway_dedupe SET response = $3, status = 'settled'
            WHERE device_id = $1 AND idempotency_key = $2`,
          [deviceId, key, JSON.stringify(response)],
        );
      });
    },
    async fail() {
      await withTenant(companyId, async (tx) => {
        await tx.query(
          `UPDATE gateway_dedupe SET status = 'failed'
            WHERE device_id = $1 AND idempotency_key = $2`,
          [deviceId, key],
        );
      });
    },
  };
}

/* ------------------------------------------------------------------ crypto --- */

/**
 * Verifies a signature against the key the device was paired with.
 *
 * The digest depends on the key. Ed25519 and Ed448 sign the message itself and
 * refuse to be handed a digest algorithm; RSA and EC need one. Branching on the
 * key type rather than trying one and catching the failure keeps a genuinely
 * bad signature from being retried under a second algorithm and passing.
 */
function verifySignature(publicKeyPem: string, nonce: string, signatureBase64: string): boolean {
  try {
    const key = createPublicKey(publicKeyPem);
    const edwards = key.asymmetricKeyType === 'ed25519' || key.asymmetricKeyType === 'ed448';
    return verify(
      edwards ? null : 'sha256',
      Buffer.from(nonce),
      key,
      Buffer.from(signatureBase64, 'base64'),
    );
  } catch {
    // A malformed key or signature has failed to verify. Reading the throw as
    // anything else would make a broken signature the easiest one to present.
    return false;
  }
}

/**
 * A key's name: the SHA-256 of its DER encoding, in hex.
 *
 * What the owner compares with the machine before pairing it, so it is the
 * whole digest of the key itself rather than of how the PEM happened to be
 * wrapped, and the machine can print it with nothing but OpenSSL:
 * `openssl pkey -pubin -in key.pem -outform DER | sha256sum`. (Events from
 * before pairing named the key carry the first sixteen digits of the PEM
 * text's hash instead.)
 */
export function fingerprint(publicKeyPem: string): string {
  const der = createPublicKey(publicKeyPem).export({ type: 'spki', format: 'der' });
  return createHash('sha256').update(der).digest('hex');
}

/** A fingerprint as the owner typed it: case, spaces and colons ignored. */
function typedFingerprint(value: string): string {
  return value.replace(/[\s:]/g, '').toLowerCase();
}

/** Constant-time comparison, for anywhere a bearer token is checked. */
export function secretsMatch(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}
