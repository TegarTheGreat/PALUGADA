/**
 * The console's sentences for finding and keeping: searching the rooms, files,
 * and how long messages are kept (F19.4, F19.14, F19.15).
 *
 * Keyed by the English, as every dictionary is; `index.ts` spreads each
 * language's into its dictionary, and `test/documents/console-i18n.test.ts`
 * reads the dictionaries whole.
 */
import type { Area } from '../types.ts';

export const FIND: Area = {
  id: {
    dictionary: {
      "Search messages": "Cari pesan",
      "Files' names too": "Termasuk nama berkas",
      "Type two letters or more, then press Enter.": "Ketik dua huruf atau lebih, lalu tekan Enter.",
      "Nothing said here matches.": "Tidak ada pesan di sini yang cocok.",
      "A room": "Sebuah ruang",
      "Take a picture": "Ambil foto",
      "Save {name}": "Simpan {name}",
      "Removed when its time was up.": "Dihapus karena sudah lewat waktunya.",
      "Messages, days": "Pesan, hari",
      "Empty keeps what people say in the rooms for good. A window is 30 days at least; each message goes by its own age.": "Kosongkan untuk menyimpan selamanya apa yang dikatakan orang di ruang. Batas waktunya paling sedikit 30 hari; setiap pesan dihapus menurut umurnya sendiri.",
      "Kept for good": "Disimpan selamanya",
      "Messages are kept for good.": "Pesan disimpan selamanya.",
      "Old messages removed from the rooms": "Pesan lama dihapus dari ruang",
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
