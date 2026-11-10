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
  id: {
    dictionary: {
      'Phones': 'Ponsel',
      'A phone you link is told who wrote to you or mentioned you, and what waits for you. Nothing is sent to it until you link it.':
        'Ponsel yang Anda tautkan diberi tahu siapa yang menulis kepada Anda atau menyebut Anda, dan apa yang menunggu Anda. Tidak ada yang dikirim kepadanya sampai Anda menautkannya.',
      'No relay is paired for this company yet: the owner pairs one in This deployment, Relays.':
        'Belum ada relay yang dipasangkan untuk perusahaan ini: pemilik memasangkannya di Deployment ini, Relay.',
    },
    kept: [],
  },
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
