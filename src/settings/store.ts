/**
 * What the owner sets for the whole deployment from the console, and the
 * secrets those settings need (0065).
 *
 * The model, the agent CLIs and the channels were environment variables: an
 * operator with a shell set them, and a restart made them count. An owner
 * with only the console could not choose a model, paste a key, or turn on an
 * agent CLI. Settings now live here and are laid over the environment when
 * the deployment starts (`overlay.ts`), and changing one restarts it softly.
 *
 * **Secrets are sealed, and the key is not in the database.** AES-256-GCM
 * under a master key from PALUGADA_MASTER_KEY, or -- when that is not set --
 * from a file beside the deployment that is made on first use, readable by
 * this process alone. A dump of the database, which a backup is, is then not
 * a list of every provider key the company pays for; the key file is backed
 * up on its own, and the guide says so. A setting names its secret the way
 * everything else does, as a reference: `db://<name>`.
 */
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { withControlPlane } from '../db/tenant.ts';
import { PalugadaError } from '../errors.ts';
import { redactor, type SecretManager } from '../secrets/manager.ts';

export interface MasterKey {
  /** A fingerprint of the key, stored beside what it sealed. Not the key. */
  id: string;
  key: Buffer;
  /** Where it came from, for the console: never the key itself. */
  source: string;
}

/** The directory a deployment keeps its own state in: the master key, installed CLIs, their logins. */
export function stateDirFrom(env: NodeJS.ProcessEnv): string {
  return env.PALUGADA_STATE_DIR ?? join(env.HOME ?? homedir(), '.palugada');
}

/**
 * The master key: from PALUGADA_MASTER_KEY (32 bytes, base64 or hex), or the
 * key file in the state directory, made the first time one is needed.
 */
export function masterKeyFrom(env: NodeJS.ProcessEnv, create = true): MasterKey | null {
  const given = env.PALUGADA_MASTER_KEY?.trim();
  if (given) {
    const key = keyFromText(given);
    if (key.length !== 32) {
      throw new PalugadaError('config.invalid',
        'PALUGADA_MASTER_KEY is 32 bytes, as 64 hex characters or base64', { source: 'PALUGADA_MASTER_KEY' });
    }
    return { id: fingerprint(key), key, source: 'PALUGADA_MASTER_KEY' };
  }
  const directory = stateDirFrom(env);
  const path = join(directory, 'master.key');
  if (existsSync(path)) {
    const key = Buffer.from(readFileSync(path, 'utf8').trim(), 'base64');
    if (key.length !== 32) {
      throw new PalugadaError('config.invalid', `${path} does not hold a 32-byte key`, { source: path });
    }
    return { id: fingerprint(key), key, source: path };
  }
  if (!create) return null;
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const key = randomBytes(32);
  writeFileSync(path, `${key.toString('base64')}\n`, { mode: 0o600, flag: 'wx' });
  chmodSync(path, 0o600);
  return { id: fingerprint(key), key, source: path };
}

/**
 * The keys this deployment sealed with before, from
 * PALUGADA_MASTER_KEY_PREVIOUS: comma-separated, each written as
 * PALUGADA_MASTER_KEY is. Named while a key is rotated, so what the old one
 * sealed still opens and is resealed under the new one (`resealSecrets`).
 */
export function previousMasterKeysFrom(env: NodeJS.ProcessEnv): MasterKey[] {
  const given = env.PALUGADA_MASTER_KEY_PREVIOUS?.trim();
  if (!given) return [];
  return given.split(',').map((one) => one.trim()).filter(Boolean).map((one) => {
    const key = keyFromText(one);
    if (key.length !== 32) {
      throw new PalugadaError('config.invalid',
        'PALUGADA_MASTER_KEY_PREVIOUS holds a key that is not 32 bytes; each is written as PALUGADA_MASTER_KEY is, '
          + '64 hex characters or base64, separated by commas', { source: 'PALUGADA_MASTER_KEY_PREVIOUS' });
    }
    return { id: fingerprint(key), key, source: 'PALUGADA_MASTER_KEY_PREVIOUS' };
  });
}

function keyFromText(text: string): Buffer {
  return /^[0-9a-f]{64}$/i.test(text) ? Buffer.from(text, 'hex') : Buffer.from(text, 'base64');
}

function fingerprint(key: Buffer): string {
  return createHash('sha256').update(key).digest('hex').slice(0, 16);
}

const SECRET_NAME = /^[a-z][a-z0-9-]{0,62}$/;

function assertSecretName(name: string): void {
  if (!SECRET_NAME.test(name)) {
    throw new PalugadaError('contract.violation',
      `a secret's name is lower-case letters, digits and hyphens, starting with a letter; got ${name}`, { name });
  }
}

/** Seals a value and keeps it under a name, replacing what was there. */
export async function putSecret(name: string, value: string, master: MasterKey): Promise<void> {
  assertSecretName(name);
  if (value === '') throw new PalugadaError('contract.violation', 'a secret is not empty', { name });
  const { nonce, ciphertext, tag } = seal(name, value, master);
  await withControlPlane((tx) => tx.query(
    `INSERT INTO deployment_secrets (name, nonce, ciphertext, tag, key_id)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (name) DO UPDATE
       SET nonce = EXCLUDED.nonce, ciphertext = EXCLUDED.ciphertext, tag = EXCLUDED.tag,
           key_id = EXCLUDED.key_id, updated_at = now()`,
    [name, nonce, ciphertext, tag, master.id],
  ));
  redactor.register(value);
}

export async function deleteSecret(name: string): Promise<void> {
  await withControlPlane((tx) => tx.query('DELETE FROM deployment_secrets WHERE name = $1', [name]));
}

/** The names that are set, never their values. */
export async function secretNames(): Promise<Array<{ name: string; updatedAt: string }>> {
  return withControlPlane(async (tx) => {
    const { rows } = await tx.query<{ name: string; updated_at: Date }>(
      'SELECT name, updated_at FROM deployment_secrets ORDER BY name');
    return rows.map((row) => ({ name: row.name, updatedAt: row.updated_at.toISOString() }));
  });
}

/**
 * Reseals, under the current key, every secret an older key sealed.
 *
 * Run when the deployment starts with PALUGADA_MASTER_KEY_PREVIOUS set: the
 * rotation is the restart, and nothing has to be typed again. In one
 * transaction, the rows locked, so two replicas starting at once reseal each
 * secret once. A secret sealed with a key that is not named anywhere is left
 * as it is and named in the answer: it can only be set again.
 */
export async function resealSecrets(master: MasterKey, previous: readonly MasterKey[]): Promise<{
  resealed: number; unopened: Array<{ name: string; keyId: string }>;
}> {
  return withControlPlane(async (tx) => {
    const { rows } = await tx.query<{ name: string; nonce: Buffer; ciphertext: Buffer; tag: Buffer; key_id: string }>(
      'SELECT name, nonce, ciphertext, tag, key_id FROM deployment_secrets WHERE key_id <> $1 ORDER BY name FOR UPDATE',
      [master.id]);
    let resealed = 0;
    const unopened: Array<{ name: string; keyId: string }> = [];
    for (const row of rows) {
      const old = previous.find((one) => one.id === row.key_id);
      const value = old ? unsealed(row.name, row, old) : null;
      if (value === null) {
        unopened.push({ name: row.name, keyId: row.key_id });
        continue;
      }
      const { nonce, ciphertext, tag } = seal(row.name, value, master);
      await tx.query(
        'UPDATE deployment_secrets SET nonce = $2, ciphertext = $3, tag = $4, key_id = $5, updated_at = now() WHERE name = $1',
        [row.name, nonce, ciphertext, tag, master.id]);
      resealed += 1;
    }
    return { resealed, unopened };
  });
}

function seal(name: string, value: string, master: MasterKey): { nonce: Buffer; ciphertext: Buffer; tag: Buffer } {
  const nonce = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', master.key, nonce);
  // The name is bound in, so a sealed value moved to another name does not open.
  cipher.setAAD(Buffer.from(name, 'utf8'));
  const ciphertext = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
  return { nonce, ciphertext, tag: cipher.getAuthTag() };
}

/** The value a key opens, or null when it does not open: changed, or another name's. */
function unsealed(name: string, row: { nonce: Buffer; ciphertext: Buffer; tag: Buffer }, key: MasterKey): string | null {
  try {
    const decipher = createDecipheriv('aes-256-gcm', key.key, row.nonce);
    decipher.setAAD(Buffer.from(name, 'utf8'));
    decipher.setAuthTag(row.tag);
    return Buffer.concat([decipher.update(row.ciphertext), decipher.final()]).toString('utf8');
  } catch {
    return null;
  }
}

async function openSecret(name: string, master: MasterKey | null, previous: readonly MasterKey[] = []): Promise<string> {
  const reference = `db://${name}`;
  const { rows } = await withControlPlane((tx) => tx.query<{
    nonce: Buffer; ciphertext: Buffer; tag: Buffer; key_id: string;
  }>('SELECT nonce, ciphertext, tag, key_id FROM deployment_secrets WHERE name = $1', [name]));
  const row = rows[0];
  if (!row) {
    throw new PalugadaError('credential.unavailable', `secret ${reference}: nothing is stored under that name`, { reference });
  }
  // The current key, or one named as a previous key while a rotation is under way.
  const key = [master, ...previous].find((one) => one?.id === row.key_id);
  if (!key) {
    throw new PalugadaError('credential.unavailable',
      `secret ${reference} was sealed with the master key ${row.key_id}, and this deployment has `
        + `${master ? master.id : 'none'}: restore that key (PALUGADA_MASTER_KEY or the key file, or name it in `
        + 'PALUGADA_MASTER_KEY_PREVIOUS), or set the secret again',
      { reference });
  }
  const value = unsealed(name, row, key);
  if (value === null) {
    throw new PalugadaError('credential.unavailable',
      `secret ${reference} does not open with this deployment's key: it was changed outside the console`, { reference });
  }
  return value;
}

/**
 * `db://` in front of whatever else the deployment resolves. Everything that
 * takes a secret reference -- a model key, a vendor credential, a trigger's
 * signing secret -- can then name one the owner set in the console.
 */
export class DeploymentSecretManager implements SecretManager {
  readonly #inner: SecretManager;
  readonly #master: () => MasterKey | null;
  readonly #previous: () => readonly MasterKey[];

  constructor(inner: SecretManager, master: () => MasterKey | null, previous: () => readonly MasterKey[] = () => []) {
    this.#inner = inner;
    this.#master = master;
    this.#previous = previous;
  }

  async resolve(reference: string): Promise<string> {
    if (!reference.startsWith('db://')) return this.#inner.resolve(reference);
    const name = reference.slice('db://'.length);
    assertSecretName(name);
    const value = await openSecret(name, this.#master(), this.#previous());
    redactor.register(value);
    return value;
  }
}

/* ---------------------------------------------------------------- settings --- */

export type Settings = Record<string, object>;

export async function readSettings(): Promise<Settings> {
  return withControlPlane(async (tx) => {
    const { rows } = await tx.query<{ key: string; value: object }>(
      'SELECT key, value FROM deployment_settings');
    return Object.fromEntries(rows.map((row) => [row.key, row.value]));
  });
}

/** Replaces one area's settings; null takes the area back to the environment. */
export async function writeSetting(key: string, value: object | null): Promise<void> {
  await withControlPlane((tx) => (value === null
    ? tx.query('DELETE FROM deployment_settings WHERE key = $1', [key])
    : tx.query(
      `INSERT INTO deployment_settings (key, value) VALUES ($1, $2)
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
      [key, JSON.stringify(value)],
    )));
}

/**
 * When settings or secrets last changed: a replica that booted before it is
 * running on the old ones, and restarts to take the new.
 */
export async function settingsVersion(): Promise<string> {
  return withControlPlane(async (tx) => {
    const { rows } = await tx.query<{ at: Date | null }>(
      `SELECT greatest((SELECT max(updated_at) FROM deployment_settings),
                       (SELECT max(updated_at) FROM deployment_secrets)) AS at`);
    return rows[0]?.at?.toISOString() ?? 'never';
  });
}
