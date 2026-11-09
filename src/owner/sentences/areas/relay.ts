/**
 * What the platform says to people outside the console about the relay: what a
 * paired relay and a linked phone are told (F19.19, F19.20).
 *
 * Keyed by the English, as every sentence file is; `index.ts` spreads each
 * language's into its file in `../`, and the sentence test in
 * `test/acceptance/owner-channels.test.ts` reads those whole. A `say()` call
 * that uses one sits in a top-level `src/owner/*.ts` file, where that test
 * finds it.
 */
import type { SentenceArea } from './index.ts';

export const RELAY: SentenceArea = {
  id: {
    'Something urgent needs you in PALUGADA.': 'Ada hal mendesak yang menunggu Anda di PALUGADA.',
    'Something new needs you in PALUGADA.': 'Ada hal baru yang menunggu Anda di PALUGADA.',
    'This no longer needs you.': 'Hal ini tidak lagi menunggu Anda.',
    'Work you gave has finished.': 'Pekerjaan yang Anda berikan sudah selesai.',
    'Your daily digest from PALUGADA is ready.': 'Ringkasan harian Anda dari PALUGADA sudah siap.',
    'Daily digest for {company}': 'Ringkasan harian untuk {company}',
    'A test from PALUGADA: this relay is paired and hears this deployment.': 'Uji dari PALUGADA: relay ini sudah dipasangkan dan mendengar deployment ini.',
    'This phone is linked to PALUGADA.': 'Ponsel ini sudah ditautkan ke PALUGADA.',
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
