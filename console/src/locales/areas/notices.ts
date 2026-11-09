/**
 * The console's sentences for people's notices: what a person is told, where
 * and when (F19.13, F19.20).
 *
 * Keyed by the English, as every dictionary is; `index.ts` spreads each
 * language's into its dictionary, and `test/documents/console-i18n.test.ts`
 * reads the dictionaries whole.
 */
import type { Area } from '../types.ts';

export const NOTICES: Area = {
  id: { dictionary: {}, kept: [] },
  ms: { dictionary: {}, kept: [] },
  jv: { dictionary: {}, kept: [] },
  su: { dictionary: {}, kept: [] },
  tl: { dictionary: {}, kept: [] },
  vi: { dictionary: {}, kept: [] },
  th: { dictionary: {}, kept: [] },
  zh: { dictionary: {}, kept: [] },
  ja: { dictionary: {}, kept: [] },
  ko: { dictionary: {}, kept: [] },
  hi: { dictionary: {}, kept: [] },
  ar: { dictionary: {}, kept: [] },
  es: { dictionary: {}, kept: [] },
  'pt-BR': { dictionary: {}, kept: [] },
  fr: { dictionary: {}, kept: [] },
  de: { dictionary: {}, kept: [] },
  nl: { dictionary: {}, kept: [] },
  it: { dictionary: {}, kept: [] },
  tr: { dictionary: {}, kept: [] },
  ru: { dictionary: {}, kept: [] },
};
