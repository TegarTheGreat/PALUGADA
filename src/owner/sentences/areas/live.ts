/**
 * What the platform says to people outside the console about live delivery
 * (F19.11).
 *
 * Keyed by the English, as every sentence file is; `index.ts` spreads each
 * language's into its file in `../`, and the sentence test in
 * `test/acceptance/owner-channels.test.ts` reads those whole. A `say()` call
 * that uses one sits in a top-level `src/owner/*.ts` file, where that test
 * finds it.
 */
import type { SentenceArea } from './index.ts';

export const LIVE: SentenceArea = {
  id: {},
  ms: {},
  jv: {},
  su: {},
  tl: {},
  vi: {},
  th: {},
  zh: {},
  ja: {},
  ko: {},
  hi: {},
  ar: {},
  es: {},
  'pt-BR': {},
  fr: {},
  de: {},
  nl: {},
  it: {},
  tr: {},
  ru: {},
};
