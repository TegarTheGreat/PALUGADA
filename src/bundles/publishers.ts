/**
 * Who this installation trusts to sign things (PRD v2 F16.2, F12.10, F15.8).
 *
 * The rule this module exists to enforce is one sentence: **a signature is
 * only evidence when the verifier already knows the key.** Verifying a
 * signature against a key carried in the same payload proves the payload is
 * internally consistent and nothing at all about who produced it — anyone can
 * generate a keypair. A bundle checked that way would install unquarantined
 * with whatever grants it asked for, which is exactly what F12.10 exists to
 * prevent.
 *
 * So there are three outcomes, not two, and the middle one is the useful part:
 *
 *   - The signature does not verify against the key offered → **refused**. A
 *     false claim of provenance is worse than no claim, because accepting it
 *     as merely unvouched-for would make forging one strictly better than
 *     omitting one.
 *   - It verifies, but the key is not on this installation's list →
 *     **quarantine**. This is the honest reading of an unknown publisher: not
 *     a liar, not vouched for. It is the same answer F12.10 gives an unpaired
 *     device.
 *   - It verifies against a key the owner added → **trusted**.
 *
 * Trust is keyed on a fingerprint rather than the PEM text, because the same
 * key can be serialised more than one way and a list somebody could bypass by
 * re-encoding a key would be a list in name only.
 */
import { createHash, createPublicKey } from 'node:crypto';
import { withControlPlane } from '../db/tenant.ts';
import { PalugadaError } from '../errors.ts';

export interface TrustedPublisher {
  fingerprint: string;
  label: string;
  addedAt: Date;
  revokedAt: Date | null;
}

/**
 * A stable name for a key.
 *
 * Taken over the key's DER encoding rather than the PEM string: PEM differs by
 * line wrapping and trailing newlines, and two spellings of one key must not
 * be two fingerprints. A key that cannot be parsed has no fingerprint, which
 * is the correct answer — an unparseable key is not a publisher.
 */
export function keyFingerprint(publicKeyPem: string): string | null {
  try {
    const der = createPublicKey(publicKeyPem).export({ type: 'spki', format: 'der' });
    return createHash('sha256').update(der).digest('hex').slice(0, 32);
  } catch {
    return null;
  }
}

/**
 * Adds a publisher the installation will accept signatures from.
 *
 * The owner's decision, and it takes the boolean rather than deriving it:
 * trusting a publisher is exactly the judgement that cannot be made by the
 * code asking for it.
 */
export async function trustPublisher(input: {
  publicKeyPem: string;
  label: string;
  ownerApproved: boolean;
  addedBy?: string;
}): Promise<string> {
  if (!input.ownerApproved) {
    throw new PalugadaError(
      'approval.required',
      'trusting a publisher is vouching for everything it will ever sign, which is the owner\'s',
      { label: input.label },
    );
  }

  const fingerprint = keyFingerprint(input.publicKeyPem);
  if (!fingerprint) {
    throw new PalugadaError(
      'publisher.invalid_key',
      `${input.label} did not supply a readable public key`,
      { label: input.label },
    );
  }

  await withControlPlane(async (tx) => {
    await tx.query(
      `INSERT INTO trusted_publishers (fingerprint, label, public_key, added_by)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (fingerprint) DO UPDATE
         SET label = EXCLUDED.label,
             -- Re-adding a revoked publisher is how an owner reverses a
             -- revocation, and it should be one action rather than a delete
             -- and an insert.
             revoked_at = NULL`,
      [fingerprint, input.label, input.publicKeyPem, input.addedBy ?? 'owner'],
    );
  });

  return fingerprint;
}

/**
 * Stops accepting a publisher's signatures.
 *
 * Revoked rather than deleted, so the record of having trusted them survives.
 * What is already installed is not reached into: an install records the
 * fingerprint it trusted at the time, and rewriting that would hide the
 * window in which the compromised key was live — which is the first thing
 * anybody investigating would want to see.
 */
export async function revokePublisher(fingerprint: string): Promise<void> {
  await withControlPlane(async (tx) => {
    await tx.query(
      'UPDATE trusted_publishers SET revoked_at = now() WHERE fingerprint = $1',
      [fingerprint],
    );
  });
}

/** True when this installation accepts signatures from the key, right now. */
export async function isTrustedPublisher(publicKeyPem: string | null): Promise<boolean> {
  if (!publicKeyPem) return false;
  const fingerprint = keyFingerprint(publicKeyPem);
  if (!fingerprint) return false;

  return withControlPlane(async (tx) => {
    const { rows } = await tx.query<{ ok: boolean }>(
      `SELECT true AS ok FROM trusted_publishers
        WHERE fingerprint = $1 AND revoked_at IS NULL`,
      [fingerprint],
    );
    return rows.length > 0;
  });
}

export async function listTrustedPublishers(): Promise<TrustedPublisher[]> {
  return withControlPlane(async (tx) => {
    const { rows } = await tx.query<{
      fingerprint: string; label: string; added_at: Date; revoked_at: Date | null;
    }>(
      'SELECT fingerprint, label, added_at, revoked_at FROM trusted_publishers ORDER BY added_at',
    );
    return rows.map((row) => ({
      fingerprint: row.fingerprint,
      label: row.label,
      addedAt: row.added_at,
      revokedAt: row.revoked_at,
    }));
  });
}
