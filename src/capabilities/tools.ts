/**
 * The tools the owner chooses a provider for in the console -- searching,
 * reading pages, making pictures, speaking -- and how each is bound at boot.
 *
 * One registry for the four, so the console, the settings overlay and the
 * boot read the same list of variables and cannot disagree about which one
 * configures what.
 */
import {
  extractProvider, searchProvider, type ExtractProvider, type SearchProvider, type ToolBinding,
} from './search.ts';
import { imageProvider, speechProvider, type ImageProvider, type MediaBinding, type SpeechProvider } from './media.ts';
import { listenProvider, type ListenBinding } from './listen.ts';

/** Each kind of tool, the capability it binds, and the variables it is configured by. */
export const TOOL_KINDS = {
  search: { capability: 'web.search', provider: 'PALUGADA_SEARCH_PROVIDER', url: 'PALUGADA_SEARCH_URL', key: 'PALUGADA_SEARCH_KEY_REF' },
  extract: { capability: 'web.extract', provider: 'PALUGADA_EXTRACT_PROVIDER', url: 'PALUGADA_EXTRACT_URL', key: 'PALUGADA_EXTRACT_KEY_REF' },
  image: {
    capability: 'image.generate', provider: 'PALUGADA_IMAGE_PROVIDER', url: 'PALUGADA_IMAGE_URL', key: 'PALUGADA_IMAGE_KEY_REF',
    model: 'PALUGADA_IMAGE_MODEL',
  },
  speech: {
    capability: 'speech.synthesize', provider: 'PALUGADA_SPEECH_PROVIDER', url: 'PALUGADA_SPEECH_URL', key: 'PALUGADA_SPEECH_KEY_REF',
    model: 'PALUGADA_SPEECH_MODEL', voice: 'PALUGADA_SPEECH_VOICE',
  },
  listen: {
    capability: 'speech.transcribe', provider: 'PALUGADA_LISTEN_PROVIDER', url: 'PALUGADA_LISTEN_URL', key: 'PALUGADA_LISTEN_KEY_REF',
    model: 'PALUGADA_LISTEN_MODEL',
  },
} as const;
export type ToolKind = keyof typeof TOOL_KINDS;

interface Described {
  name: string;
  key: 'required' | 'optional' | 'none';
  urlExample?: string;
}

export interface ToolBindings {
  search?: ToolBinding<SearchProvider>;
  extract?: ToolBinding<ExtractProvider>;
  image?: MediaBinding<ImageProvider>;
  speech?: MediaBinding<SpeechProvider>;
  /** A role's `speech.transcribe`, which reads the company's files. */
  listen?: ListenBinding & { root: string };
  /**
   * The owner's own voice with the assistant: what hears them and what
   * answers aloud. Neither needs the company's files, so each is bound
   * whenever its provider is chosen.
   */
  voice: { listen?: ListenBinding; speak?: MediaBinding<SpeechProvider> };
  notes: string[];
}

/**
 * The providers the environment names, bound; and a note for each kind that
 * is not, or cannot be. A setting that names no provider this platform knows
 * is a note rather than a refusal to start: the console is where it is fixed.
 * Pictures and speech are files, so they need the company's files as well.
 */
export function toolBindingsFrom(
  env: NodeJS.ProcessEnv,
  resolve: (reference: string) => Promise<string>,
  filesRoot: string | null = null,
): ToolBindings {
  const notes: string[] = [];
  const bind = <P extends Described>(kind: ToolKind, find: (id: string) => P | undefined) => {
    const names = TOOL_KINDS[kind];
    const id = env[names.provider]?.trim();
    if (!id) {
      notes.push(`${names.capability} is unbound: choose a provider in the console, under This deployment, Tools`);
      return undefined;
    }
    const provider = find(id);
    if (!provider) {
      notes.push(`${names.capability} is unbound: ${names.provider} names ${id}, which is not a provider known here`);
      return undefined;
    }
    const url = env[names.url]?.trim() || null;
    if (provider.urlExample && !url) {
      notes.push(`${names.capability} is unbound: ${provider.name} is your own server, and ${names.url} gives no address`);
      return undefined;
    }
    const reference = env[names.key]?.trim() || null;
    if (provider.key === 'required' && !reference) {
      notes.push(`${names.capability} is unbound: ${provider.name} needs a key, and ${names.key} names none`);
      return undefined;
    }
    return { provider, url, key: async () => (reference ? resolve(reference) : null) };
  };
  const media = <P extends Described>(kind: 'image' | 'speech', find: (id: string) => P | undefined): MediaBinding<P> | undefined => {
    const bound = bind(kind, find);
    if (!bound) return undefined;
    if (!filesRoot) {
      notes.push(`${TOOL_KINDS[kind].capability} is unbound: what it makes is kept in the company's files, and PALUGADA_FILES_ROOT is not set`);
      return undefined;
    }
    const names = TOOL_KINDS[kind];
    return {
      ...bound,
      root: filesRoot,
      model: env[names.model]?.trim() || null,
      voice: 'voice' in names ? env[names.voice]?.trim() || null : null,
    };
  };
  const search = bind('search', searchProvider);
  const extract = bind('extract', extractProvider);
  const image = media('image', imageProvider);
  const speech = media('speech', speechProvider);
  const heard = bind('listen', listenProvider);
  const listening = heard ? { ...heard, model: env[TOOL_KINDS.listen.model]?.trim() || null } : undefined;
  if (listening && !filesRoot) {
    notes.push('speech.transcribe is unbound for roles: the recordings it reads are the company\'s files, and PALUGADA_FILES_ROOT is not set; the owner can still speak to the assistant');
  }
  // Speaking to the owner needs no files: a speech provider the roles cannot
  // use for want of them still answers the owner aloud.
  const speaking = speech ?? (() => {
    const id = env[TOOL_KINDS.speech.provider]?.trim();
    const provider = id ? speechProvider(id) : undefined;
    const reference = env[TOOL_KINDS.speech.key]?.trim() || null;
    const url = env[TOOL_KINDS.speech.url]?.trim() || null;
    if (!provider || (provider.key === 'required' && !reference) || (provider.urlExample && !url)) return undefined;
    return {
      provider, url, root: '', key: async () => (reference ? resolve(reference) : null),
      model: env[TOOL_KINDS.speech.model]?.trim() || null, voice: env[TOOL_KINDS.speech.voice]?.trim() || null,
    };
  })();
  return {
    ...(search ? { search } : {}), ...(extract ? { extract } : {}), ...(image ? { image } : {}), ...(speech ? { speech } : {}),
    ...(listening && filesRoot ? { listen: { ...listening, root: filesRoot } } : {}),
    voice: { ...(listening ? { listen: listening } : {}), ...(speaking ? { speak: speaking } : {}) },
    notes,
  };
}
