/**
 * Credentials (PRD F12.1, F12.2, F12.4, F8.7).
 *
 * The database stores a reference such as `vault://acme/dns-token`, never a
 * secret. Resolution happens at the moment of execution, inside the broker,
 * and the value is handed to the adapter and to nothing else. It does not
 * enter a prompt, a task input, a step journal entry, an event payload or an
 * LLM trace.
 *
 * That last part cannot rest on discipline alone -- a secret reaches a log the
 * first time somebody writes an error message containing a request body. So
 * every value this module hands out is also registered with a redactor, and
 * the redactor runs over anything on its way to a durable record.
 */
import { PalugadaError } from '../errors.ts';
import type { TenantClient } from '../db/tenant.ts';

export interface SecretManager {
  /** Resolves a reference such as "vault://path/to/secret". */
  resolve(reference: string): Promise<string>;
}

/**
 * Redacts known secret values from any text leaving the system.
 *
 * Values are matched literally rather than by pattern. Pattern matching would
 * be guesswork -- a token has no reliable shape -- and would either miss
 * secrets or mangle innocent text. Anything shorter than the minimum length is
 * refused registration, because redacting a short common string would corrupt
 * every message that happened to contain it.
 */
export class Redactor {
  static readonly MIN_SECRET_LENGTH = 8;
  readonly #secrets = new Set<string>();

  register(value: string): void {
    if (value.length < Redactor.MIN_SECRET_LENGTH) return;
    this.#secrets.add(value);
  }

  /** Replaces every registered secret in a string with a marker. */
  redact(text: string): string {
    let result = text;
    for (const secret of this.#secrets) {
      if (result.includes(secret)) {
        result = result.split(secret).join('[redacted]');
      }
    }
    return result;
  }

  /** Recursively redacts strings inside an arbitrary JSON-shaped value. */
  redactDeep<T>(value: T): T {
    if (typeof value === 'string') return this.redact(value) as unknown as T;
    if (Array.isArray(value)) return value.map((item) => this.redactDeep(item)) as unknown as T;
    if (value && typeof value === 'object') {
      const output: Record<string, unknown> = {};
      for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
        output[key] = this.redactDeep(nested);
      }
      return output as unknown as T;
    }
    return value;
  }

  get size(): number {
    return this.#secrets.size;
  }
}

/** Process-wide redactor. Everything durable passes through it. */
export const redactor = new Redactor();

/**
 * Development and test secret manager.
 *
 * Production should point at a managed store (PRD section 10). The interface
 * is deliberately one method wide so swapping the implementation touches
 * nothing else.
 */
export class InMemorySecretManager implements SecretManager {
  readonly #values: Map<string, string>;

  constructor(values: Record<string, string> = {}) {
    this.#values = new Map(Object.entries(values));
  }

  set(reference: string, value: string): void {
    this.#values.set(reference, value);
  }

  async resolve(reference: string): Promise<string> {
    const value = this.#values.get(reference);
    if (value === undefined) {
      throw new PalugadaError('capability.unknown', `secret ${reference} is not available`, {
        reference,
      });
    }
    redactor.register(value);
    return value;
  }
}

/**
 * Resolves a credential a division is entitled to (F12.2).
 *
 * The division is part of the lookup rather than a check performed afterwards,
 * so a role in another division cannot name someone else's alias and receive
 * their secret. Row-level security already confines the row to its tenant;
 * this narrows it to the division within that tenant.
 */
export async function resolveForDivision(
  tx: TenantClient,
  secrets: SecretManager,
  divisionId: string,
  alias: string,
): Promise<string> {
  const { rows } = await tx.query<{ secret_ref: string }>(
    'SELECT secret_ref FROM credentials WHERE division_id = $1 AND alias = $2',
    [divisionId, alias],
  );
  const row = rows[0];
  if (!row) {
    throw new PalugadaError(
      'capability.not_granted',
      `division ${divisionId} has no credential aliased ${alias}`,
      { divisionId, alias },
    );
  }
  return secrets.resolve(row.secret_ref);
}
