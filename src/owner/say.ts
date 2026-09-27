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
  'Done: {goal}': 'Selesai: {goal}',
  'Stopped before finishing: {goal}': 'Berhenti sebelum selesai: {goal}',
  'Why: {reason}': 'Sebabnya: {reason}',
  'a task': 'sebuah tugas',
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
  '[a key, not kept]': '[sebuah kunci, tidak disimpan]',
  'That looks like a key, so I did not keep it or send it anywhere. Keys go in the sealed field on a card, or on their page in This deployment: tell me what it is for and I will put the card in front of you.':
    'Itu tampak seperti kunci, jadi tidak saya simpan dan tidak saya kirim ke mana pun. Kunci diisi di kolom tersegel pada kartu, atau di halamannya di This deployment: katakan untuk apa, lalu saya siapkan kartunya.',
  'No model is set up yet, so I cannot think. Choose one under This deployment, Model; then I can help with everything else.':
    'Belum ada model yang dipasang, jadi saya belum bisa berpikir. Pilih satu di This deployment, Model; setelah itu saya bisa membantu semua yang lain.',
  'The model did not answer: {reason}': 'Model tidak menjawab: {reason}',
  'Here is what I propose.': 'Ini usulan saya.',
  'I have nothing to add.': 'Tidak ada yang perlu saya tambahkan.',
};

/** The sentences each language has, for a test to hold complete. */
export const OWNER_SENTENCES: Readonly<Record<string, Readonly<Record<string, string>>>> = { id: ID };

/** `text` in `language`, with `{name}` filled from `values`; English when there is no translation. */
export function say(language: string | null | undefined, text: string, values: Record<string, string> = {}): string {
  const template = (language && OWNER_SENTENCES[language]?.[text]) || text;
  return template.replace(/\{(\w+)\}/g, (whole, name: string) => values[name] ?? whole);
}
