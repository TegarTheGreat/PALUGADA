/**
 * What the platform says to people outside the console about people's notices:
 * what a person is told outside the console (F19.13, F19.20).
 *
 * Keyed by the English, as every sentence file is; `index.ts` spreads each
 * language's into its file in `../`, and the sentence test in
 * `test/acceptance/owner-channels.test.ts` reads those whole. A `say()` call
 * that uses one sits in a top-level `src/owner/*.ts` file, where that test
 * finds it.
 */
import type { SentenceArea } from './index.ts';

export const NOTICES: SentenceArea = {
  id: {
    'The owner': 'Pemilik',
    '{name} wrote to you.': '{name} menulis kepada Anda.',
    '{name} mentioned you in {room}.': '{name} menyebut Anda di {room}.',
    '{name} replied in a thread you follow in {room}.': '{name} membalas di utas yang Anda ikuti di {room}.',
    'New in {room}: {count}.': 'Baru di {room}: {count}.',
    'A question for you from {role}.': 'Pertanyaan untuk Anda dari {role}.',
    'An approval waits for you in {room}.': 'Sebuah persetujuan menunggu Anda di {room}.',
    'An approval waits for you.': 'Sebuah persetujuan menunggu Anda.',
    'The work you asked for is done: {title}.': 'Kerja yang Anda minta sudah selesai: {title}.',
    'The work you asked for stopped: {why}.': 'Kerja yang Anda minta berhenti: {why}.',
    'Something new in PALUGADA.': 'Ada yang baru di PALUGADA.',
    'And more yesterday: {count}.': 'Masih ada lagi kemarin: {count}.',
    'Decided through {relay}.': 'Diputuskan lewat {relay}.',
    'Tier 3 is decided in the app, not through {relay}.': 'Tier 3 diputuskan di aplikasi, bukan lewat {relay}.',
    'Reply': 'Balas',
    'Mark read': 'Tandai dibaca',
    'Mute': 'Bisukan',
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
