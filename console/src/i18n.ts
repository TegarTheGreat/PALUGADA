/**
 * The console in the owner's language.
 *
 * **English is the key.** `t('Needs you')` reads as what it says, so the
 * source stays legible, and a sentence nobody has translated yet falls back to
 * itself rather than to a code. Every other language is a dictionary from the
 * English sentence to its own; `test/documents/console-i18n.test.ts` reads the
 * source for every sentence handed to `t`, `tp` or `N` and fails when a
 * dictionary lacks one, or keeps one nothing asks for.
 *
 * **Changing language redraws the console from the top** (the shell is keyed
 * by it). A module-level `t` is then enough: nothing drawn in the old language
 * survives the switch, and no component has to subscribe to anything.
 *
 * The choice itself is the deployment's, kept by the owner API
 * (`/api/control/languages`), not by the browser: the console stores nothing
 * in the browser at all. Until the owner signs in, the browser's own
 * preference decides.
 */
import { useSyncExternalStore } from 'react';
import { DICTIONARY as ID } from './locales/id.ts';
import { DICTIONARY as MS } from './locales/ms.ts';
import { DICTIONARY as ZH } from './locales/zh.ts';
import { DICTIONARY as HI } from './locales/hi.ts';
import { DICTIONARY as PT_BR } from './locales/pt-BR.ts';
import { DICTIONARY as RU } from './locales/ru.ts';
import { DICTIONARY as JV } from './locales/jv.ts';
import { DICTIONARY as SU } from './locales/su.ts';
import type { Dictionary, Translation } from './locales/types.ts';

/**
 * The languages the console is drawn in: each one's code as the owner API
 * keeps it, its name in itself, and the BCP 47 locale its dates, numbers and
 * plural forms follow.
 */
export const LANGUAGES = [
  { code: 'en', name: 'English', locale: 'en-US' },
  { code: 'id', name: 'Bahasa Indonesia', locale: 'id-ID' },
  { code: 'ms', name: 'Bahasa Melayu', locale: 'ms-MY' },
  { code: 'zh', name: '简体中文', locale: 'zh-CN' },
  { code: 'hi', name: 'हिन्दी', locale: 'hi-IN' },
  { code: 'pt-BR', name: 'Português (Brasil)', locale: 'pt-BR' },
  { code: 'ru', name: 'Русский', locale: 'ru-RU' },
  { code: 'jv', name: 'Basa Jawa', locale: 'jv-ID' },
  { code: 'su', name: 'Basa Sunda', locale: 'su-ID' },
] as const;
export type Language = (typeof LANGUAGES)[number]['code'];

const DICTIONARIES: Record<Language, Dictionary> = {
  en: {},
  id: ID,
  ms: MS,
  zh: ZH,
  hi: HI,
  'pt-BR': PT_BR,
  ru: RU,
  jv: JV,
  su: SU,
};

export function isLanguage(value: unknown): value is Language {
  return typeof value === 'string' && LANGUAGES.some((language) => language.code === value);
}

/**
 * The browser's first preference the console has, matched whole and then by
 * its language alone: `pt-PT` and `pt` get Brazilian Portuguese, `zh-TW`
 * gets simplified Chinese, which a reader of either can read, rather than
 * English, which they may not.
 */
function fromBrowser(): Language {
  const preferred = typeof navigator === 'undefined' ? [] : navigator.languages ?? [navigator.language];
  const primary = (tag: string) => tag.split('-')[0]!.toLowerCase();
  for (const tag of preferred) {
    const whole = LANGUAGES.find((one) => one.code.toLowerCase() === tag.toLowerCase());
    if (whole) return whole.code;
    const same = LANGUAGES.find((one) => primary(one.code) === primary(tag));
    if (same) return same.code;
  }
  return 'en';
}

let current: Language = fromBrowser();
const listeners = new Set<() => void>();

export function language(): Language {
  return current;
}

/**
 * The languages written right to left. The page's `dir` follows the language,
 * and Mantine mirrors its components from it; the console's own styles use
 * logical sides (`inline-start`, not `left`) so they mirror too.
 */
const RIGHT_TO_LEFT: ReadonlySet<string> = new Set(['ar']);

/** Which way the owner's language is written. */
export function direction(): 'ltr' | 'rtl' {
  return RIGHT_TO_LEFT.has(current) ? 'rtl' : 'ltr';
}

/** The BCP 47 locale dates and numbers are written in. */
export function locale(): string {
  return LANGUAGES.find((one) => one.code === current)!.locale;
}

export function setLanguage(next: Language): void {
  if (next === current) return;
  current = next;
  // The locale, not the code: `zh-CN` tells the browser which Han glyphs to draw.
  document.documentElement.lang = locale();
  document.documentElement.dir = direction();
  for (const listener of listeners) listener();
}

export function useLanguage(): Language {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => current,
  );
}

type Values = Record<string, string | number>;

function fill(template: string, values: Values | undefined): string {
  if (!values) return template;
  return template.replace(/\{(\w+)\}/g, (whole, name: string) => (name in values ? String(values[name]) : whole));
}

/** The form of a translation for a plural category; a plain string serves them all. */
function form(translation: Translation, category: Intl.LDMLPluralRule): string {
  return typeof translation === 'string' ? translation : translation[category] ?? translation.other;
}

/** A sentence in the owner's language, with `{name}` filled from `values`. */
export function t(text: string, values?: Values): string {
  const translation = DICTIONARIES[current][text];
  return fill(translation === undefined ? text : form(translation, 'other'), values);
}

/**
 * A sentence that depends on a count: `tp('{count} task', '{count} tasks', n)`.
 *
 * The plural rule is the language's own, which is why both English forms are
 * keys: Indonesian has one form and translates both alike; English has two;
 * Russian has three, and its translation of the second names the forms for
 * the counts that are not "one" (`few` for 2, `many` for 5). The category is
 * the locale's, so 21 is "one" in Russian as 1 is, and 0 is "one" in Hindi.
 */
export function tp(one: string, other: string, count: number, values?: Values): string {
  const category = new Intl.PluralRules(locale()).select(count);
  const text = category === 'one' ? one : other;
  const translation = DICTIONARIES[current][text];
  return fill(translation === undefined ? text : form(translation, category), {
    count: count.toLocaleString(locale()),
    ...values,
  });
}

/**
 * Marks a sentence for translation where it is written, for `t` to translate
 * where it is drawn: a page's label in a table, a status in a map.
 */
export function N(text: string): string {
  return text;
}
