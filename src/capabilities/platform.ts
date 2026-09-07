/**
 * The capabilities a deployment gets for free (PRD v2 F8).
 *
 * The standard company template grants twenty-five capability names. Twenty
 * of them need somebody's account -- a DNS provider, a mail provider, a
 * ledger -- and choosing one for every company that will ever use this
 * platform is not a decision a control plane gets to make. Five do not, and
 * this is where they are bound.
 *
 * Registering them is opt-in and takes an argument for each thing that cannot
 * be defaulted: `files.list` needs to be told which directory is the company's
 * (the default would be this process's working directory, which is the
 * repository), and the drafting pair needs a model client. A deployment that
 * passes neither gets the two web capabilities, which need nothing.
 *
 * `unbound()` is the other half and is what `scripts/smoke.ts` prints: the
 * names a template grants that nothing implements. A company granted a
 * capability with nothing behind it is one whose agents are refused at the
 * moment they try to work, and learning that at boot is the difference between
 * a configuration error and an incident.
 */
import type { Capability, CapabilityRegistry } from '../broker/registry.ts';
import type { LlmClient } from '../llm/client.ts';
import { uptimeCheck, webFetch, type WebOptions } from './web.ts';
import { filesList, type FilesOptions } from './files.ts';
import { docDraft, emailDraft, type DraftOptions } from './draft.ts';

export interface PlatformCapabilityOptions {
  /** Reachability rules for the two that make requests. */
  web?: WebOptions;
  /**
   * The company's files.
   *
   * Omitted means `files.list` *and* the drafting pair stay unbound: there is
   * no safe default root -- the default would be this process's working
   * directory, which is the platform's own source -- and a draft the owner
   * cannot find is a draft that was not written.
   */
  files?: FilesOptions;
  /** Omitted means the drafting pair stays unbound. */
  llm?: LlmClient;
  draftModel?: string;
}

/**
 * Every capability this platform implements itself, given what it was told.
 *
 * Returns them rather than registering them, so a deployment can see the list,
 * add to it, or leave one out -- and so this function has no side effect worth
 * being surprised by.
 */
export function platformCapabilities(
  options: PlatformCapabilityOptions = {},
): Array<Capability<never, never>> {
  const built: Array<Capability<never, never>> = [
    webFetch(options.web ?? {}) as unknown as Capability<never, never>,
    uptimeCheck(options.web ?? {}) as unknown as Capability<never, never>,
  ];

  if (options.files) {
    built.push(filesList(options.files) as unknown as Capability<never, never>);
  }

  // The drafting pair needs both: a model to compose with and a place to put
  // the result. §8.8 calibrates them at tier 1 because a draft is a write, and
  // a tier 1 capability with nowhere to write has nothing to `verify()` --
  // which is the shape of a rule being worked around rather than met.
  if (options.llm && options.files) {
    const draft: DraftOptions = {
      llm: options.llm,
      root: options.files.root,
      ...(options.draftModel ? { model: options.draftModel } : {}),
    };
    built.push(docDraft(draft) as unknown as Capability<never, never>);
    built.push(emailDraft(draft) as unknown as Capability<never, never>);
  }

  return built;
}

/** Registers them, and answers with what it registered. */
export async function registerPlatformCapabilities(
  registry: CapabilityRegistry,
  options: PlatformCapabilityOptions = {},
): Promise<string[]> {
  const built = platformCapabilities(options);
  for (const capability of built) registry.register(capability);
  await registry.sync();
  return built.map((capability) => capability.name);
}
