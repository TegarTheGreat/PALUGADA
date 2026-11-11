/**
 * The console's sentences for what people may do in the rooms and how much
 * the rooms keep (F19.4, F19.5, F19.22; STATUS 2.217): the refusals a person
 * meets past a minute's number of writes, a reaction that is not one emoji
 * or one too many, a full company's room files and a retry key used for
 * other words; the owner's room files limit in Settings; and giving a seat
 * a new authenticator in People.
 *
 * Keyed by the English, as every dictionary is; `index.ts` spreads each
 * language's into its dictionary, and `test/documents/console-i18n.test.ts`
 * reads the dictionaries whole. Each language names a room and a message as
 * `workspace.ts` does, a file as `find.ts` does, and a seat, a person and an
 * authenticator as `people.ts` does.
 */
import type { Area } from '../types.ts';

export const HARDENING: Area = {
  id: {
    dictionary: {
      "You are doing that too often. Wait a minute, then try again.": "Anda terlalu sering melakukannya. Tunggu satu menit, lalu coba lagi.",
      "A reaction is one emoji.": "Reaksi adalah satu emoji.",
      "You have put ten reactions on this message. Take one back first.": "Anda sudah memberi sepuluh reaksi pada pesan ini. Tarik salah satunya dulu.",
      "This company's room files have reached their limit. The owner can raise it in Settings, or remove some files.": "Berkas ruang perusahaan ini sudah mencapai batasnya. Pemilik bisa menaikkannya di Pengaturan, atau menghapus sebagian berkas.",
      "That message was already sent elsewhere. Send it again as a new message.": "Pesan itu sudah terkirim di tempat lain. Kirim lagi sebagai pesan baru.",
      "Room files": "Berkas ruang",
      "How much the files people attach in the rooms may take. A message whose files would go past it is refused, and says so.": "Seberapa besar ruang yang boleh dipakai berkas yang dilampirkan orang di ruang-ruang. Pesan yang berkasnya akan melewati batas ini ditolak, disertai alasannya.",
      "{used} MB of {limit} MB kept": "{used} MB dari {limit} MB tersimpan",
      "Room files kept": "Berkas ruang yang tersimpan",
      "Limit, megabytes": "Batas, megabyte",
      "From 1 to 1,048,576. Lowering it removes nothing already kept.": "Dari 1 sampai 1.048.576. Menurunkannya tidak menghapus apa pun yang sudah tersimpan.",
      "Give {name} a new authenticator": "Beri {name} autentikator baru",
      "{name} is signed out everywhere, and their phone is unlinked.": "Sesi {name} sudah diakhiri di mana pun, dan tautan ponselnya diputus.",
      "It works once, for a week, and is shown only now. It asks {name} only for the code of a new authenticator app: their name, handle, rooms and conversations stay theirs.": "Tautan ini berlaku sekali, selama seminggu, dan hanya ditampilkan sekarang. Tautan ini hanya meminta {name} memasukkan kode dari aplikasi autentikator baru: nama, handle, ruang, dan percakapannya tetap miliknya.",
      "New authenticator": "Autentikator baru",
      "New invite": "Undangan baru",
      "A new authenticator for {name}": "Autentikator baru untuk {name}",
      "You stay @{handle}, in the same rooms and conversations. Add PALUGADA to the authenticator app on your new phone; the old one no longer signs you in.": "Anda tetap @{handle}, di ruang dan percakapan yang sama. Tambahkan PALUGADA ke aplikasi autentikator di ponsel baru Anda; yang lama tidak bisa lagi dipakai untuk masuk.",
      "You stay in the same rooms and conversations. Add PALUGADA to the authenticator app on your new phone; the old one no longer signs you in.": "Anda tetap di ruang dan percakapan yang sama. Tambahkan PALUGADA ke aplikasi autentikator di ponsel baru Anda; yang lama tidak bisa lagi dipakai untuk masuk.",
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
  "pt-BR": { dictionary: {}, kept: [] },
  fr: { dictionary: {}, kept: [] },
  de: { dictionary: {}, kept: [] },
  nl: { dictionary: {}, kept: [] },
  it: { dictionary: {}, kept: [] },
  tr: { dictionary: {}, kept: [] },
  ru: { dictionary: {}, kept: [] },
};
