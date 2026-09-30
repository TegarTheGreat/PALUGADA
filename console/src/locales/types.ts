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
