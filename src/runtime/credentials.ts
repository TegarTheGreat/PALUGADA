/**
 * An agent CLI's own credential, from a secret the deployment holds.
 *
 * A CLI was given its key by naming a variable of this process's environment
 * (`apiKeyEnvVar`), which only an operator with a shell can set. A key or a
 * login token the owner saved in the console is sealed in the database
 * (`settings/store.ts`) and reached by reference, so a run resolves it here,
 * under the one variable name the CLI reads.
 *
 * Resolved before the run starts anything. A credential that cannot be
 * opened is `model.unavailable` -- the runtime cannot reach its model -- so
 * the task halts with this message rather than the CLI starting, failing to
 * authenticate, and every attempt failing the same way in the CLI's words.
 */
import { PalugadaError } from '../errors.ts';
import type { SecretManager } from '../secrets/manager.ts';

export async function resolveSecretEnv(
  runtime: string,
  secretEnv: Record<string, string> | undefined,
  secrets: SecretManager | undefined,
): Promise<Record<string, string>> {
  const resolved: Record<string, string> = {};
  for (const [name, reference] of Object.entries(secretEnv ?? {})) {
    try {
      if (!secrets) throw new Error('this deployment was given no secret store');
      resolved[name] = await secrets.resolve(reference);
    } catch (failure) {
      throw new PalugadaError('model.unavailable',
        `${runtime} has no ${name}: ${(failure as Error).message}. Sign it in again in the console, `
          + 'under This deployment, Agents', { runtime, variable: name });
    }
  }
  return resolved;
}
