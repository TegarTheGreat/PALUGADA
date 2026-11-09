/**
 * The shape every dictionary in this folder has.
 *
 * A sentence is translated by a string, except a sentence that depends on a
 * count (`tp`) in a language with more forms than English's two. Russian
 * says 1 задача, 2 задачи, 5 задач: three forms for what English says with
 * two, so its translation of the plural sentence names each form by its
 * CLDR category, the one `Intl.PluralRules` answers for the count.
 */
export type PluralForms = Readonly<Partial<Record<Intl.LDMLPluralRule, string>> & { other: string }>;

export type Translation = string | PluralForms;

export type Dictionary = Readonly<Record<string, Translation>>;

/** The languages the console offers beside English, each with a dictionary in this folder. */
export type LanguageCode =
  | 'id' | 'ms' | 'jv' | 'su' | 'tl' | 'vi' | 'th' | 'zh' | 'ja' | 'ko'
  | 'hi' | 'ar' | 'es' | 'pt-BR' | 'fr' | 'de' | 'nl' | 'it' | 'tr' | 'ru';

/**
 * One feature's sentences in every language, kept in `areas/` and spread into
 * each dictionary through `areas/index.ts`. A feature built beside others
 * writes its own file, rather than lines in twenty dictionaries every other
 * feature is also writing; `KEPT` is the same per language.
 */
export type Area = Readonly<Record<LanguageCode, { readonly dictionary: Dictionary; readonly kept: readonly string[] }>>;
