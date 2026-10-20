/**
 * The keys a division's capabilities sign in with (F12.3, F12.6): what the
 * console asks the owner for under a division's keys, and what a role may
 * ask the owner for with `owner.ask` -- the same answer in both places, so
 * a role cannot ask for a key the console would not.
 */
import type { Capability } from './registry.ts';
import type { CredentialSignIn } from '../capabilities/vendor-oauth.ts';

/**
 * The keys a division's granted capabilities ask for, by alias: which
 * capabilities use each, and the scopes they need of it (F12.6).
 */
export type KeyAsked = { capabilities: string[]; scopes: string[]; signIn?: CredentialSignIn; form?: NonNullable<Capability['credentialForm']> };

export function keysAskedFor(
  registry: { get(name: string): Capability<never, never> | undefined } | undefined,
  granted: readonly string[],
): Map<string, KeyAsked> {
  const asked = new Map<string, KeyAsked>();
  for (const name of [...granted].sort()) {
    const capability = registry?.get(name);
    if (!capability?.credentialAlias) continue;
    const entry: KeyAsked = asked.get(capability.credentialAlias) ?? { capabilities: [], scopes: [] };
    // A key given in a form is given in the first form asked for it.
    if (capability.credentialForm && !entry.form) entry.form = capability.credentialForm;
    entry.capabilities.push(name);
    for (const scope of capability.requiredScopes ?? []) if (!entry.scopes.includes(scope)) entry.scopes.push(scope);
    // One sign-in for the key, asking for every scope its capabilities need
    // of the same provider.
    if (capability.signIn && (!entry.signIn || entry.signIn.provider === capability.signIn.provider)) {
      entry.signIn = entry.signIn
        ? { ...entry.signIn, scopes: [...new Set([...entry.signIn.scopes, ...capability.signIn.scopes])] }
        : capability.signIn;
    }
    asked.set(capability.credentialAlias, entry);
  }
  return asked;
}
