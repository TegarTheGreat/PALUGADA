/**
 * What the platform itself says to the owner outside the console -- a push
 * notification, a Telegram message and its buttons -- in the owner's language.
 *
 * The console has its own dictionary (console/src/locales); these are the few
 * sentences the server composes, so they live here, keyed by their English
 * the same way. The language is the panel's (`platform_control.
 * console_language`): the owner chose it for reading PALUGADA, and a phone
 * buzzing in another language than the app it opens is the same owner being
 * spoken to by two different products. Unset, it is English.
 *
 * What an agent wrote -- an item's title, its summary -- is passed through as
 * it is. Its language is the company's talk language, which is a rule for the
 * agent (src/domain/language.ts), not something to translate after the fact.
 */
import { SENTENCES as ID } from './sentences/id.ts';
import { SENTENCES as MS } from './sentences/ms.ts';
import { SENTENCES as JV } from './sentences/jv.ts';
import { SENTENCES as SU } from './sentences/su.ts';
import { SENTENCES as TL } from './sentences/tl.ts';
import { SENTENCES as VI } from './sentences/vi.ts';
import { SENTENCES as TH } from './sentences/th.ts';
import { SENTENCES as ZH } from './sentences/zh.ts';
import { SENTENCES as JA } from './sentences/ja.ts';
import { SENTENCES as KO } from './sentences/ko.ts';
import { SENTENCES as HI } from './sentences/hi.ts';
import { SENTENCES as AR } from './sentences/ar.ts';
import { SENTENCES as ES } from './sentences/es.ts';
import { SENTENCES as PT_BR } from './sentences/pt-BR.ts';
import { SENTENCES as FR } from './sentences/fr.ts';
import { SENTENCES as DE } from './sentences/de.ts';
import { SENTENCES as NL } from './sentences/nl.ts';
import { SENTENCES as IT } from './sentences/it.ts';
import { SENTENCES as TR } from './sentences/tr.ts';
import { SENTENCES as RU } from './sentences/ru.ts';

/**
 * The sentences each language has, one file each in `sentences/`. Every
 * language the console is drawn in has one, since the panel's language is
 * what picks it, and a test holds each complete.
 */
export const OWNER_SENTENCES: Readonly<Record<string, Readonly<Record<string, string>>>> = {
  id: ID,
  ms: MS,
  jv: JV,
  su: SU,
  tl: TL,
  vi: VI,
  th: TH,
  zh: ZH,
  ja: JA,
  ko: KO,
  hi: HI,
  ar: AR,
  es: ES,
  'pt-BR': PT_BR,
  fr: FR,
  de: DE,
  nl: NL,
  it: IT,
  tr: TR,
  ru: RU,
};

/** Whether the platform has its own sentences in `language`: English, or one the console is drawn in. */
export function canSay(language: string): boolean {
  return language === 'en' || language in OWNER_SENTENCES;
}

/** `text` in `language`, with `{name}` filled from `values`; English when there is no translation. */
export function say(language: string | null | undefined, text: string, values: Record<string, string> = {}): string {
  const template = (language && OWNER_SENTENCES[language]?.[text]) || text;
  return template.replace(/\{(\w+)\}/g, (whole, name: string) => values[name] ?? whole);
}
