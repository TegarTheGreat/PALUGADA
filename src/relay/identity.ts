/**
 * The deployment's identity to relays (F19.19; STATUS section 2.208).
 *
 * One Ed25519 key pair, made the first time anything needs it. It is
 * PALUGADA's first private signing key: what a relay checks every envelope
 * against, and what a person's phone ultimately trusts. So the private half
 * never sits in a table in the clear: its 32-byte seed is sealed under the
 * master key like every secret the owner saves (`putSecret`, AES-256-GCM),
 * and only the public half, its id and the reference to the sealed seed are
 * kept here. A database dump without the master key cannot sign as this
 * deployment. The owner can rotate it; the old key keeps signing beside the
 * new one for a week, and every relay is told, in an envelope both sign.
 */
import { generateKeyPairSync, type KeyObject } from 'node:crypto';
import { withControlPlane, type TenantClient } from '../db/tenant.ts';
import { PalugadaError } from '../errors.ts';
import { deleteSecret, putSecret, DeploymentSecretManager, type MasterKey } from '../settings/store.ts';
import { InMemorySecretManager } from '../secrets/manager.ts';
import { ed25519FromSeed, fingerprint, keyId, rawPublicKey, seedOf } from './signature.ts';

/** How long a rotated-out key keeps signing beside the new one. */
export const PREVIOUS_KEY_DAYS = 7;

export interface DeploymentIdentity {
  /** `platform_control.deployment_id`: what every envelope names as its sender. */
  deployment: string;
  publicKey: Buffer;
  kid: string;
  fingerprint: string;
  previous: { publicKey: Buffer; kid: string; until: Date } | null;
}

interface IdentityRow {
  public_key: Buffer;
  kid: string;
  secret_ref: string;
  previous_key: Buffer | null;
  previous_kid: string | null;
  previous_ref: string | null;
  previous_until: Date | null;
  deployment: string;
}

async function readRow(tx: TenantClient): Promise<IdentityRow | null> {
  const { rows } = await tx.query<IdentityRow>(
    `SELECT i.public_key, i.kid, i.secret_ref, i.previous_key, i.previous_kid, i.previous_ref, i.previous_until,
            (SELECT deployment_id::text FROM platform_control) AS deployment
       FROM relay_identity i`);
  return rows[0] ?? null;
}

function identityOf(row: IdentityRow): DeploymentIdentity {
  return {
    deployment: row.deployment,
    publicKey: row.public_key,
    kid: row.kid,
    fingerprint: fingerprint(row.public_key),
    previous: row.previous_key && row.previous_kid && row.previous_until
      ? { publicKey: row.previous_key, kid: row.previous_kid, until: row.previous_until }
      : null,
  };
}

/** A new key, its seed sealed under the master key by its own id. Answers the key and where its seed is. */
async function sealedKey(master: MasterKey): Promise<{ publicKey: Buffer; kid: string; ref: string }> {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const raw = rawPublicKey(publicKey);
  const kid = keyId(raw);
  const name = `relay-identity-${kid}`;
  await putSecret(name, seedOf(privateKey).toString('base64'), master, { quiet: true });
  return { publicKey: raw, kid, ref: `db://${name}` };
}

/** The deployment's identity, or null before anything has needed one. */
export async function readIdentity(): Promise<DeploymentIdentity | null> {
  const row = await withControlPlane(readRow);
  return row ? identityOf(row) : null;
}

/**
 * The deployment's identity, made now if this is the first time anything
 * needs it. Two replicas making one at once each seal a key under its own
 * name; the first row in wins, and the loser's sealed seed is deleted, so the
 * row and the seed it names are always one pair.
 */
export async function ensureIdentity(master: MasterKey | null): Promise<DeploymentIdentity> {
  const found = await readIdentity();
  if (found) return found;
  if (!master) {
    throw new PalugadaError('config.invalid',
      'the deployment has no master key to seal its relay identity with: set PALUGADA_MASTER_KEY, or let the console make its key file', {});
  }
  const made = await sealedKey(master);
  const won = await withControlPlane(async (tx) => {
    const { rowCount } = await tx.query(
      `INSERT INTO relay_identity (public_key, kid, secret_ref) VALUES ($1, $2, $3) ON CONFLICT (id) DO NOTHING`,
      [made.publicKey, made.kid, made.ref]);
    return rowCount === 1;
  });
  if (!won) await deleteSecret(made.ref.slice('db://'.length));
  return (await readIdentity())!;
}

/**
 * The keys an envelope is signed with now: the current one, and the one it
 * replaced while its week lasts. Opened from their sealed seeds at each call,
 * so a key rotated on another replica is the one used here at its next send.
 */
export async function signingKeys(
  master: MasterKey | null,
  previousMasters: readonly MasterKey[] = [],
  now = new Date(),
): Promise<{ identity: DeploymentIdentity; keys: KeyObject[] }> {
  const identity = await ensureIdentity(master);
  const row = (await withControlPlane(readRow))!;
  // Resolved through the same manager every `db://` reference is, so a key
  // sealed under a master key being rotated out still opens.
  const opener = new DeploymentSecretManager(new InMemorySecretManager(), () => master, () => previousMasters);
  const open = async (ref: string) => ed25519FromSeed(Buffer.from(await opener.resolve(ref), 'base64')).privateKey;
  const keys = [await open(row.secret_ref)];
  if (row.previous_ref && row.previous_until && row.previous_until > now) keys.push(await open(row.previous_ref));
  return { identity, keys };
}

/**
 * A new key for the deployment. The one it replaces signs beside it for a
 * week, so a relay that pinned it verifies the envelope that tells it of the
 * new one; a key rotated out before that is forgotten at once.
 */
export async function rotateIdentity(master: MasterKey | null, now = new Date()): Promise<DeploymentIdentity> {
  await ensureIdentity(master);
  const made = await sealedKey(master!);
  const forgotten = await withControlPlane(async (tx) => {
    const { rows: [current] } = await tx.query<{ previous_ref: string | null }>(
      'SELECT previous_ref FROM relay_identity FOR UPDATE');
    await tx.query(
      `UPDATE relay_identity
          SET previous_key = public_key, previous_kid = kid, previous_ref = secret_ref,
              previous_until = $4::timestamptz + make_interval(days => $5),
              public_key = $1, kid = $2, secret_ref = $3, rotated_at = $4`,
      [made.publicKey, made.kid, made.ref, now, PREVIOUS_KEY_DAYS]);
    return current?.previous_ref ?? null;
  });
  if (forgotten) await deleteSecret(forgotten.slice('db://'.length));
  return (await readIdentity())!;
}

/** Forgets the key rotated out once its week is over. Answers whether there was one to forget. */
export async function forgetPreviousKey(now = new Date()): Promise<boolean> {
  const ref = await withControlPlane(async (tx) => {
    const { rows } = await tx.query<{ previous_ref: string }>(
      'SELECT previous_ref FROM relay_identity WHERE previous_until <= $1 FOR UPDATE', [now]);
    if (!rows[0]) return null;
    await tx.query(
      'UPDATE relay_identity SET previous_key = NULL, previous_kid = NULL, previous_ref = NULL, previous_until = NULL');
    return rows[0].previous_ref;
  });
  if (ref) await deleteSecret(ref.slice('db://'.length));
  return ref !== null;
}

/** What anyone may read of the identity: the open route's answer. */
export function identityView(identity: DeploymentIdentity): Record<string, unknown> {
  return {
    v: 1,
    versions: [1],
    deployment: identity.deployment,
    key: identity.publicKey.toString('base64url'),
    kid: identity.kid,
    fingerprint: identity.fingerprint,
    previous: identity.previous
      ? { key: identity.previous.publicKey.toString('base64url'), kid: identity.previous.kid, until: identity.previous.until.toISOString() }
      : null,
  };
}
