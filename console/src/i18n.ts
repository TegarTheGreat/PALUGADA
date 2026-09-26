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
import { ID } from './locales/id.ts';

export const LANGUAGES = [
  { code: 'en', name: 'English', locale: 'en-US' },
  { code: 'id', name: 'Bahasa Indonesia', locale: 'id-ID' },
] as const;
export type Language = (typeof LANGUAGES)[number]['code'];

const DICTIONARIES: Record<Language, Readonly<Record<string, string>>> = { en: {}, id: ID };

export function isLanguage(value: unknown): value is Language {
  return typeof value === 'string' && LANGUAGES.some((language) => language.code === value);
}

function fromBrowser(): Language {
  const preferred = typeof navigator === 'undefined' ? [] : navigator.languages ?? [navigator.language];
  for (const tag of preferred) {
    const code = tag.slice(0, 2).toLowerCase();
    if (isLanguage(code)) return code;
  }
  return 'en';
}

let current: Language = fromBrowser();
const listeners = new Set<() => void>();

export function language(): Language {
  return current;
}

/** The BCP 47 locale dates and numbers are written in. */
export function locale(): string {
  return LANGUAGES.find((one) => one.code === current)!.locale;
}

export function setLanguage(next: Language): void {
  if (next === current) return;
  current = next;
  document.documentElement.lang = next;
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

/** A sentence in the owner's language, with `{name}` filled from `values`. */
export function t(text: string, values?: Values): string {
  return fill(DICTIONARIES[current][text] ?? text, values);
}

/**
 * A sentence that depends on a count: `tp('{count} task', '{count} tasks', n)`.
 *
 * The plural rule is the language's own (Indonesian has one form, English
 * two), which is why both English forms are keys: a language chooses which it
 * needs.
 */
export function tp(one: string, other: string, count: number, values?: Values): string {
  const form = new Intl.PluralRules(locale()).select(count) === 'one' ? one : other;
  return t(form, { count: count.toLocaleString(locale()), ...values });
}

/**
 * Marks a sentence for translation where it is written, for `t` to translate
 * where it is drawn: a page's label in a table, a status in a map.
 */
export function N(text: string): string {
  return text;
}
