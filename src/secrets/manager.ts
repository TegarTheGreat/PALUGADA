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

  /**
   * True when a registered secret appears verbatim anywhere in a value.
   *
   * `redactDeep` is the remedy; this is the alarm. They are separate because a
   * value that had to be redacted on its way to a log is a leak that already
   * happened somewhere upstream, and the post_tool hook (F14) needs to be able
   * to refuse rather than quietly clean up after it.
   */
  leaks(value: unknown): boolean {
    if (typeof value === 'string') {
      for (const secret of this.#secrets) {
        if (value.includes(secret)) return true;
      }
      return false;
    }
    if (Array.isArray(value)) return value.some((item) => this.leaks(item));
    if (value && typeof value === 'object') {
      return Object.values(value as Record<string, unknown>).some((nested) => this.leaks(nested));
    }
    return false;
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

/*
 * There was a `resolveForDivision` here, and `resolveCurrent` in
 * secrets/rotation.ts replaced it. Both did the same division-scoped lookup
 * and only one read the version, so keeping the unversioned one meant a second
 * way to resolve a credential that would quietly ignore a rotation. The broker
 * calls `resolveCurrent`; there is now no other way in.
 */
