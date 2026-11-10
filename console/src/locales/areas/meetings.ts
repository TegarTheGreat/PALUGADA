/**
 * The console's sentences for agent meetings in the rooms: the weekly
 * meeting's card, joining it, and a meeting called about a message (F19.17,
 * F19.18).
 *
 * Keyed by the English, as every dictionary is; `index.ts` spreads each
 * language's into its dictionary, and `test/documents/console-i18n.test.ts`
 * reads the dictionaries whole.
 */
import type { Area } from '../types.ts';

export const MEETINGS: Area = {
  id: {
    dictionary: {
      "You joined. From its next step, its questions come to you, here and in your inbox.": "Anda sudah bergabung. Mulai langkah berikutnya, pertanyaannya datang kepada Anda, di sini dan di kotak masuk Anda.",
      "Scorecard": "Scorecard",
      "A meeting about this message": "Rapat tentang pesan ini",
      "Weekly operating meeting, {week}": "Rapat operasi mingguan, {week}",
      "called by {name}": "dipanggil oleh {name}",
      "Agenda": "Agenda",
      "You attend: its questions come to you, and each waits {minutes} minutes before the meeting goes on without your answer.": "Anda hadir: pertanyaannya datang kepada Anda, dan masing-masing menunggu {minutes} menit sebelum rapat berlanjut tanpa jawaban Anda.",
      "The owner attends this meeting.": "Pemilik menghadiri rapat ini.",
      "To-dos it filed": "Tindakan yang dicatatnya",
      "The meeting is called. It shows under the message, and its record will be there when it ends.": "Rapat sudah dipanggil. Rapat tampil di bawah pesan itu, dan catatannya ada di sana setelah selesai.",
      "Call a meeting about this": "Panggil rapat tentang ini",
      "The CEO holds a meeting of the company's agents about it, against the scorecard, the priorities, the to-dos and the issues, and files what follows. It reserves money from the CEO's budget, and a company calls at most three a day.": "CEO mengadakan rapat para agen perusahaan tentang hal ini, berdasarkan scorecard, prioritas, tindakan, dan isu, lalu mencatat tindak lanjutnya. Rapat ini memesan dana dari anggaran CEO, dan satu perusahaan memanggil paling banyak tiga rapat sehari.",
      "What the meeting is about": "Pokok bahasan rapat",
      "You attend it: its questions come to you, and each waits {minutes} minutes before it goes on without your answer.": "Anda menghadirinya: pertanyaannya datang kepada Anda, dan masing-masing menunggu {minutes} menit sebelum rapat berlanjut tanpa jawaban Anda.",
      "Call the meeting": "Panggil rapat",
      "You attend": "Anda hadir",
      "Every week": "Setiap minggu",
      "Only when you press Join": "Hanya saat Anda menekan Bergabung",
      "Minutes each question waits for you": "Menit setiap pertanyaan menunggu Anda",
      "withdrawn · the meeting went on without an answer": "ditarik · rapat berlanjut tanpa jawaban",
    },
    // A loanword the Indonesian dictionary already writes as English does: "Scorecard mingguan".
    kept: ['Scorecard', 'Agenda'],
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
