/**
 * Secret rotation (PRD F12.3).
 *
 * "Rotation without a restart" is really a statement about caching. The
 * application only ever stores a reference, so rotating the value behind it is
 * the secret manager's business -- but any process that cached the resolved
 * value would keep using the old one until it was restarted, which is a
 * restart in all but name and exactly what F12.3 rules out.
 *
 * So the credential row carries a version, and the version is part of the
 * cache key. Bumping it makes the next resolution a miss. No process has to be
 * notified, no cache has to be flushed, and a worker that was mid-task when
 * the rotation happened picks up the new value on its next call rather than
 * failing with a stale one.
 *
 * A short time-to-live sits underneath as a backstop for rotations that happen
 * in the secret manager without the version being bumped -- which will happen,
 * because the two systems are operated by different hands.
 */
import { withControlPlane, withTenant, type TenantClient } from '../db/tenant.ts';
import { preflightGrants } from '../broker/preflight.ts';
import type { CapabilityRegistry } from '../broker/registry.ts';
import { appendEvent } from '../audit/event-log.ts';
import { PalugadaError } from '../errors.ts';
import { redactor, type SecretManager } from './manager.ts';

export const DEFAULT_CACHE_TTL_MS = 60_000;

interface CacheEntry {
  value: string;
  expiresAt: number;
}

/**
 * Caches resolved secrets, keyed by reference and version.
 *
 * Values are held in a plain Map rather than anywhere durable. A cached secret
 * that outlives the process is a secret at rest in a place nobody audits.
 */
export class CachedSecretManager implements SecretManager {
  readonly #inner: SecretManager;
  readonly #ttlMs: number;
  readonly #cache = new Map<string, CacheEntry>();
  #now: () => number;

  constructor(
    inner: SecretManager,
    options: { ttlMs?: number; now?: () => number } = {},
  ) {
    this.#inner = inner;
    this.#ttlMs = options.ttlMs ?? DEFAULT_CACHE_TTL_MS;
    this.#now = options.now ?? (() => Date.now());
  }

  async resolve(reference: string): Promise<string> {
    return this.resolveVersioned(reference, 1);
  }

  /**
   * Resolves a reference at a specific version.
   *
   * The version is in the key, so a rotation invalidates by construction
   * instead of by remembering to call something.
   */
  async resolveVersioned(reference: string, version: number): Promise<string> {
    const key = `${reference}#${version}`;
    const cached = this.#cache.get(key);
    if (cached && cached.expiresAt > this.#now()) return cached.value;

    const value = await this.#inner.resolve(reference);
    this.#cache.set(key, { value, expiresAt: this.#now() + this.#ttlMs });
    redactor.register(value);
    return value;
  }

  /** Drops everything cached. Used when a process is told to forget. */
  clear(): void {
    this.#cache.clear();
  }

  get size(): number {
    return this.#cache.size;
  }
}

export interface CredentialRef {
  secretRef: string;
  version: number;
}

export async function readCredential(
  tx: TenantClient,
  divisionId: string,
  alias: string,
): Promise<CredentialRef | null> {
  const { rows } = await tx.query<{ secret_ref: string; version: number }>(
    'SELECT secret_ref, version FROM credentials WHERE division_id = $1 AND alias = $2',
    [divisionId, alias],
  );
  const row = rows[0];
  return row ? { secretRef: row.secret_ref, version: row.version } : null;
}

/**
 * Resolves a credential a division is entitled to, at its current version.
 *
 * The version is read on every resolution. That is one small indexed query per
 * external call, and it is what makes rotation take effect immediately rather
 * than within a cache lifetime.
 */
export async function resolveCurrent(
  tx: TenantClient,
  secrets: CachedSecretManager,
  divisionId: string,
  alias: string,
): Promise<string> {
  const credential = await readCredential(tx, divisionId, alias);
  if (!credential) {
    throw new PalugadaError(
      'capability.not_granted',
      `division ${divisionId} has no credential aliased ${alias}`,
      { divisionId, alias },
    );
  }
  return secrets.resolveVersioned(credential.secretRef, credential.version);
}

export interface RotationResult {
  alias: string;
  previousVersion: number;
  version: number;
  secretRef: string;
}

/**
 * Records that a credential has been rotated (F12.3).
 *
 * Optionally repoints it at a new reference, for the case where rotation
 * produced a new path rather than a new value at the same one. Either way the
 * version advances, which is the signal every cache keys on.
 *
 * The new secret value is never passed through here: this function moves a
 * pointer, and the value stays in the secret manager where F12.1 requires it.
 */
export async function rotateCredential(input: {
  companyId: string;
  divisionId: string;
  alias: string;
  newSecretRef?: string;
  /**
   * When given, every capability this division holds is preflighted against
   * the new secret (F12.3, F8.12).
   *
   * Optional rather than required because rotation is also how a credential is
   * retired, and a caller with no registry to hand should still be able to
   * rotate. The check is forced rather than cached: reusing a result from
   * before the rotation would report the state the rotation replaced.
   */
  registry?: CapabilityRegistry;
}): Promise<RotationResult> {
  const result = await withControlPlane(async (tx) => {
    const { rows } = await tx.query<{
      version: number;
      previous_version: number;
      secret_ref: string;
    }>(
      `UPDATE credentials
          SET version = version + 1,
              secret_ref = coalesce($3, secret_ref),
              rotated_at = now()
        WHERE division_id = $1 AND alias = $2
        RETURNING version, version - 1 AS previous_version, secret_ref`,
      [input.divisionId, input.alias, input.newSecretRef ?? null],
    );
    const row = rows[0];
    if (!row) {
      throw new PalugadaError(
        'capability.not_granted',
        `no credential aliased ${input.alias} in division ${input.divisionId}`,
        { divisionId: input.divisionId, alias: input.alias },
      );
    }
    return row;
  });

  await withTenant(input.companyId, async (tx) => {
    await appendEvent(tx, {
      companyId: input.companyId,
      type: 'credential.rotated',
      actor: 'owner',
      payload: {
        alias: input.alias,
        divisionId: input.divisionId,
        version: result.version,
        // The reference is recorded because it is a path, not a secret. The
        // value it points at is never seen by this process.
        secretRef: result.secret_ref,
      },
    });
  });

  if (input.registry) {
    await preflightGrants(input.registry, {
      companyId: input.companyId,
      divisionId: input.divisionId,
    });
  }

  return {
    alias: input.alias,
    previousVersion: result.previous_version,
    version: result.version,
    secretRef: result.secret_ref,
  };
}
