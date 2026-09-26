/**
 * What the platform itself says to the owner outside the console -- a push
 * notification, a Telegram message and its buttons -- in the owner's language.
 *
 * The console has its own dictionary (console/src/locales); these are the few
 * sentences the server composes, so they live here, keyed by their English
 * the same way. The language is the panel's (`platform_control.
 * console_language`): the owner chose it for reading PALUGADA, and a phone
 * buzzing in another language than the app it opens is the same owner being
 * spoken to by two different products. Unset, it is English.
 *
 * What an agent wrote -- an item's title, its summary -- is passed through as
 * it is. Its language is the company's talk language, which is a rule for the
 * agent (src/domain/language.ts), not something to translate after the fact.
 */
const ID: Readonly<Record<string, string>> = {
  'Incident: {title}': 'Insiden: {title}',
  'Approval needed: {title}': 'Perlu persetujuan: {title}',
  '{summary} — if denied: {consequence}': '{summary} — jika ditolak: {consequence}',
  'If denied:': 'Jika ditolak:',
  'This one is decided in the app.': 'Yang ini diputuskan di aplikasi.',
  'Open in PALUGADA': 'Buka di PALUGADA',
  'Approve': 'Setujui',
  'Deny': 'Tolak',
  'Ask': 'Tanya',
  'Approved. Nothing left to press here.': 'Disetujui. Tidak ada lagi yang perlu ditekan di sini.',
  'Denied. Nothing left to press here.': 'Ditolak. Tidak ada lagi yang perlu ditekan di sini.',
  'Decided ({decision}). Nothing left to press here.': 'Diputuskan ({decision}). Tidak ada lagi yang perlu ditekan di sini.',
  'Expired unanswered. Silence is a refusal, so nothing was done.':
    'Kedaluwarsa tanpa jawaban. Diam berarti menolak, jadi tidak ada yang dijalankan.',
  'Withdrawn: the task it was asking about is {state}.': 'Ditarik: tugas yang ditanyakan sudah {state}.',
  'Withdrawn ({reason}).': 'Ditarik ({reason}).',
  'no reason recorded': 'tanpa alasan tercatat',
  'This bot only answers to its owner.': 'Bot ini hanya menjawab pemiliknya.',
  'Recorded: {decision}.': 'Tercatat: {decision}.',
  'That one has to be approved in the app.': 'Yang itu harus disetujui di aplikasi.',
  'Already closed: {reason}.': 'Sudah ditutup: {reason}.',
  'That could not be recorded.': 'Itu tidak bisa dicatat.',
  'That item no longer exists.': 'Item itu sudah tidak ada.',
  'What do you want to ask about "{title}"? Reply to this message.':
    'Apa yang ingin Anda tanyakan tentang "{title}"? Balas pesan ini.',
  'Your question': 'Pertanyaan Anda',
  'Type your question as a reply.': 'Ketik pertanyaan Anda sebagai balasan.',
  'Asked. The answer will be on the item in the app.': 'Sudah ditanyakan. Jawabannya akan muncul di item itu di aplikasi.',
  'Answer': 'Jawab',
  'Answer in words': 'Jawab dengan kata-kata',
  'That choice is not on this question.': 'Pilihan itu tidak ada di pertanyaan ini.',
  'Chosen: {choice}.': 'Dipilih: {choice}.',
  'Stop the task': 'Hentikan tugas',
  'Your answer to "{question}"? Reply to this message.': 'Jawaban Anda untuk "{question}"? Balas pesan ini.',
  'Your answer': 'Jawaban Anda',
  'Type your answer as a reply.': 'Ketik jawaban Anda sebagai balasan.',
  'Answered. The task carries on with it.': 'Terjawab. Tugas dilanjutkan dengan jawaban itu.',
  'That is too long for one question; keep it under {max} characters.':
    'Terlalu panjang untuk satu pertanyaan; buat di bawah {max} karakter.',
};

/** The sentences each language has, for a test to hold complete. */
export const OWNER_SENTENCES: Readonly<Record<string, Readonly<Record<string, string>>>> = { id: ID };

/** `text` in `language`, with `{name}` filled from `values`; English when there is no translation. */
export function say(language: string | null | undefined, text: string, values: Record<string, string> = {}): string {
  const template = (language && OWNER_SENTENCES[language]?.[text]) || text;
  return template.replace(/\{(\w+)\}/g, (whole, name: string) => values[name] ?? whole);
}
