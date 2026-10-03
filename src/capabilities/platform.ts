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
 * passes neither gets the two web capabilities, which need nothing, and
 * `mailbox.read` and `email.send`, whose mailbox is each division's key.
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
import { webExtract, webSearch, type ExtractProvider, type SearchProvider, type ToolBinding } from './search.ts';
import { imageGenerate, speechSynthesize, type ImageProvider, type MediaBinding, type SpeechProvider } from './media.ts';
import { speechTranscribe, type ListenBinding } from './listen.ts';
import { filesList, filesRead, type FilesOptions } from './files.ts';
import { docDraft, emailDraft, type DraftOptions } from './draft.ts';
import { chatCapabilities, type ChatOptions } from './chat.ts';
import { browserCapabilities, webExtractByBrowser } from './browser.ts';
import { mailboxCapabilities } from './mailbox.ts';
import type { MailOptions } from '../chats/mail.ts';
import type { Browsers } from '../browser/browsers.ts';

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
  /**
   * The search and reading providers the owner chose; omitted, `web.search`
   * stays unbound, and `web.extract` is the browser's when there is one.
   */
  search?: ToolBinding<SearchProvider>;
  extract?: ToolBinding<ExtractProvider>;
  /** Pictures and speech, kept in the company's files. */
  image?: MediaBinding<ImageProvider>;
  speech?: MediaBinding<SpeechProvider>;
  /** Recordings in the company's files, written down. */
  listen?: ListenBinding & { root: string };
  /**
   * Customers' conversations (0111): where each channel's token is sealed.
   * Omitted, `chat.read` and `chat.send` stay unbound.
   */
  chat?: ChatOptions;
  /**
   * The companies' browsers (`src/browser/`): a Chromium this deployment
   * found or was given. Omitted, `browser.read` and `browser.act` stay unbound.
   * Given, it also reads pages for `web.extract` when no provider is chosen.
   */
  browser?: Browsers;
  /**
   * Where to trust a mail server with a private certificate, for
   * `mailbox.read` and `email.send` on a division's own mailbox. They are
   * bound either way: the mailbox is each division's key.
   */
  mail?: MailOptions;
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
    built.push(filesRead(options.files) as unknown as Capability<never, never>);
  }
  if (options.search) built.push(webSearch(options.search) as unknown as Capability<never, never>);
  // A page is read by the provider the owner chose; with none, by this
  // deployment's browser when it has one, which sends the address nowhere.
  if (options.extract) built.push(webExtract(options.extract) as unknown as Capability<never, never>);
  else if (options.browser) built.push(webExtractByBrowser(options.browser) as unknown as Capability<never, never>);
  if (options.image) built.push(imageGenerate(options.image) as unknown as Capability<never, never>);
  if (options.speech) built.push(speechSynthesize(options.speech) as unknown as Capability<never, never>);
  if (options.listen) built.push(speechTranscribe(options.listen) as unknown as Capability<never, never>);
  if (options.chat) built.push(...chatCapabilities(options.chat));
  if (options.browser) built.push(...browserCapabilities(options.browser));
  // A division's own mailbox; a service bound for either name replaces it.
  built.push(...mailboxCapabilities(options.mail ?? {}));

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
