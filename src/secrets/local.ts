/**
 * The secret store a deployment actually has (PRD v2 F12.1, §10).
 *
 * The only implementation of `SecretManager` in this repository was the
 * in-memory one, documented as "for development and test", and `start()`
 * fell back to it. So a deployment started the way the README says -- `npm
 * start`, no code -- had an empty secret store that forgot everything on
 * restart: no vendor credential could resolve, and the owner's own second
 * factor, which is a secret reference like any other, had nowhere to live. An
 * owner with no enrolled factor cannot sign in to the console at all.
 *
 * This resolves the two stores every deployment already has, without adding a
 * dependency or a service:
 *
 *   - `env://NAME` -- an environment variable. Only names beginning with
 *     `PALUGADA_SECRET_` (the prefix is configurable). The process's
 *     environment also holds `DATABASE_URL` and whatever else the operator
 *     runs it with, and a credential row is a reference an owner types into a
 *     form; a reference to `env://DATABASE_URL` would hand the platform's own
 *     database password to whichever capability used it. The prefix makes
 *     "this variable is a secret for the platform to hand out" a decision the
 *     operator makes by naming it, rather than true of everything by default.
 *   - `file:///run/secrets/NAME` -- a file, which is how Docker and
 *     Kubernetes mount secrets. Only under the configured directories, and
 *     checked after resolving symlinks, because a reference is a path and a
 *     path with `..` in it, or a link out of the directory, is the oldest way
 *     to read `/etc/shadow`.
 *
 * Anything else -- `vault://`, `aws-sm://` -- is refused with the scheme named,
 * so an operator who stored a reference for a store this deployment does not
 * have is told which one, rather than that the credential "is not available".
 */
import { readFile, realpath, stat } from 'node:fs/promises';
import { isAbsolute, resolve, sep } from 'node:path';
import { PalugadaError } from '../errors.ts';
import { redactor, type SecretManager } from './manager.ts';

export const DEFAULT_ENV_PREFIX = 'PALUGADA_SECRET_';
export const DEFAULT_SECRET_DIRS = ['/run/secrets'];

/** A secret is a token or a key, not a document. */
const MAX_SECRET_BYTES = 64 * 1024;

export interface LocalSecretOptions {
  env?: NodeJS.ProcessEnv;
  envPrefix?: string;
  /** Directories `file://` references may point inside. */
  directories?: readonly string[];
}

export class LocalSecretManager implements SecretManager {
  readonly #env: NodeJS.ProcessEnv;
  readonly #prefix: string;
  readonly #directories: readonly string[];

  constructor(options: LocalSecretOptions = {}) {
    this.#env = options.env ?? process.env;
    this.#prefix = options.envPrefix ?? DEFAULT_ENV_PREFIX;
    this.#directories = options.directories ?? DEFAULT_SECRET_DIRS;
  }

  async resolve(reference: string): Promise<string> {
    const value = reference.startsWith('env://')
      ? this.#fromEnv(reference.slice('env://'.length), reference)
      : reference.startsWith('file://')
        ? await this.#fromFile(reference.slice('file://'.length), reference)
        : this.#unsupported(reference);
    redactor.register(value);
    return value;
  }

  #fromEnv(name: string, reference: string): string {
    if (!/^[A-Z_][A-Z0-9_]*$/.test(name)) {
      throw refusal(reference, 'an env:// reference names one variable in capitals');
    }
    if (!name.startsWith(this.#prefix)) {
      throw refusal(
        reference,
        `only variables named ${this.#prefix}* may be handed out as secrets; `
          + 'the rest of this process\'s environment is the platform\'s own',
      );
    }
    const value = this.#env[name];
    if (value === undefined || value === '') {
      throw refusal(reference, `${name} is not set`);
    }
    return value;
  }

  async #fromFile(path: string, reference: string): Promise<string> {
    if (!isAbsolute(path)) throw refusal(reference, 'a file:// reference is an absolute path');
    let real: string;
    try {
      real = await realpath(path);
    } catch {
      throw refusal(reference, 'no such file');
    }
    // After symlinks, not before: a link inside the directory that points
    // outside it is outside it.
    const inside = await Promise.all(this.#directories.map(async (directory) => {
      const root = await realpath(resolve(directory)).catch(() => resolve(directory));
      return real === root || real.startsWith(root.endsWith(sep) ? root : root + sep);
    }));
    if (!inside.some(Boolean)) {
      throw refusal(
        reference,
        `secrets are read only from ${this.#directories.join(', ')}; set PALUGADA_SECRET_DIRS `
          + 'to add a directory',
      );
    }
    const info = await stat(real);
    if (!info.isFile() || info.size > MAX_SECRET_BYTES) {
      throw refusal(reference, 'not a file of secret size');
    }
    // One trailing newline is the editor's, not the secret's.
    const value = (await readFile(real, 'utf8')).replace(/\r?\n$/, '');
    if (value === '') throw refusal(reference, 'the file is empty');
    return value;
  }

  #unsupported(reference: string): never {
    const scheme = /^([a-z0-9-]+):\/\//.exec(reference)?.[1];
    throw refusal(
      reference,
      scheme
        ? `this deployment has no ${scheme}:// store; it resolves env:// and file://`
        : 'a secret reference is scheme://location',
    );
  }
}

function refusal(reference: string, why: string): PalugadaError {
  return new PalugadaError('credential.unavailable', `secret ${reference}: ${why}`, { reference });
}
