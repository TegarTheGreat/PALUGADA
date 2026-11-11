/**
 * What the platform says to people outside the console about people's meetings
 * and their reminders (F19.26).
 *
 * Keyed by the English, as every sentence file is; `index.ts` spreads each
 * language's into its file in `../`, and the sentence test in
 * `test/acceptance/owner-channels.test.ts` reads those whole. A `say()` call
 * that uses one sits in a top-level `src/owner/*.ts` file, where that test
 * finds it.
 */
import type { SentenceArea } from './index.ts';

export const MEET: SentenceArea = {
  id: {
    'A meeting starts in ten minutes in {room}.': 'Rapat dimulai sepuluh menit lagi di {room}.',
    'A meeting starts in ten minutes.': 'Rapat dimulai sepuluh menit lagi.',
  },
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
