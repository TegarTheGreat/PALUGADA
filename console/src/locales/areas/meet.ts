/**
 * The console's sentences for people's meetings: a time, the people asked and
 * a call link (F19.26).
 *
 * Keyed by the English, as every dictionary is; `index.ts` spreads each
 * language's into its dictionary, and `test/documents/console-i18n.test.ts`
 * reads the dictionaries whole.
 */
import type { Area } from '../types.ts';

export const MEET: Area = {
  id: {
    dictionary: {
      "Set a meeting": "Jadwalkan rapat",
      "Set a meeting about this": "Jadwalkan rapat tentang ini",
      "Change the meeting": "Ubah rapat",
      "Set the meeting": "Jadwalkan rapat",
      "Its title and agenda are the message, and its thread is the notes. The people asked are reminded ten minutes before it starts.": "Judul dan agendanya adalah pesan itu, dan utasnya menjadi catatan. Orang yang diundang diingatkan sepuluh menit sebelum rapat dimulai.",
      "Title and agenda": "Judul dan agenda",
      "How long, in minutes": "Berapa lama, dalam menit",
      "Who is asked": "Siapa yang diundang",
      "Only people who can see this room can be asked.": "Hanya orang yang bisa melihat ruang ini yang bisa diundang.",
      "Call link": "Tautan panggilan",
      "Optional. Paste a link that starts with https://. PALUGADA never opens it.": "Opsional. Tempel tautan yang diawali https://. PALUGADA tidak pernah membukanya.",
      "A call link starts with https://, has no spaces and is at most 2,000 characters.": "Tautan panggilan diawali https://, tanpa spasi, dan paling panjang 2.000 karakter.",
      "The meeting is set. The people asked are reminded ten minutes before it starts.": "Rapat sudah dijadwalkan. Orang yang diundang diingatkan sepuluh menit sebelum rapat dimulai.",
      "The meeting is changed. The people asked are reminded ten minutes before it starts.": "Rapat sudah diubah. Orang yang diundang diingatkan sepuluh menit sebelum rapat dimulai.",
      "Meeting, {time}": "Rapat, {time}",
      "Asked: {people}": "Diundang: {people}",
      "Set by {name}": "Dijadwalkan oleh {name}",
      "Cancelled by {name}": "Dibatalkan oleh {name}",
      "Join call": "Gabung panggilan",
      "Cancel the meeting": "Batalkan rapat",
      "Cancel this meeting?": "Batalkan rapat ini?",
      "Nobody asked is reminded of it, and it cannot be set again. The message and its notes stay.": "Tidak ada orang yang diundang yang diingatkan, dan rapat ini tidak bisa dijadwalkan lagi. Pesan dan catatannya tetap ada.",
      "The meeting is cancelled. Nobody is reminded of it.": "Rapat dibatalkan. Tidak ada yang diingatkan tentangnya.",
      "The meeting starts in ten minutes, at {time}.": "Rapat dimulai sepuluh menit lagi, pada {time}.",
      "A meeting starts soon, in {room}": "Rapat segera dimulai, di {room}",
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
