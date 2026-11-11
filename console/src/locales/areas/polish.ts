/**
 * The console's sentences for the rooms as people use them (F19.1, F19.2,
 * F19.7, F19.10, F19.11, F19.16; STATUS section 2.218): where a room opens
 * and how much is new in it, a message's link, marking everything read,
 * search narrowed to a room and a person, Activity that says who and what,
 * the edit box, a phone linked, and how long messages are kept, asked first.
 *
 * Keyed by the English, as every dictionary is; `index.ts` spreads each
 * language's into its dictionary, and `test/documents/console-i18n.test.ts`
 * reads the dictionaries whole.
 */
import type { Area } from '../types.ts';

export const POLISH: Area = {
  id: {
    dictionary: {
      "{count} new message": "{count} pesan baru",
      "{count} new messages": "{count} pesan baru",
      "{count} new message since {time}": "{count} pesan baru sejak {time}",
      "{count} new messages since {time}": "{count} pesan baru sejak {time}",
      "Mark as read": "Tandai sudah dibaca",
      "Jump to newest": "Ke pesan terbaru",
      "Later messages": "Pesan berikutnya",
      "Mark all read": "Tandai semua sudah dibaca",
      "Copy link": "Salin tautan",
      "Link copied.": "Tautan disalin.",
      "Edit your message": "Ubah pesan Anda",
      "More actions on the message from {name}": "Tindakan lain untuk pesan dari {name}",
      "React to the message from {name}": "Tanggapi pesan dari {name}",
      "{name} mentioned you in {room}": "{name} menyebut Anda di {room}",
      "{name} replied in a thread you follow, in {room}": "{name} membalas di utas yang Anda ikuti, di {room}",
      "Where to look": "Cari di mana",
      "Every room": "Semua ruang",
      "Said by": "Ditulis oleh",
      "Anyone": "Siapa saja",
      "Linked: {label}": "Tertaut: {label}",
      "That code ran out before a phone used it. Ask for another to link one.": "Kode itu kedaluwarsa sebelum dipakai ponsel. Minta kode baru untuk menautkan ponsel.",
      "From {least} to {most}.": "Dari {least} sampai {most}.",
      "At least {least}.": "Paling sedikit {least}.",
      "At most {most}.": "Paling banyak {most}.",
      "From {least} to {most} days, or empty to keep them for good.": "Dari {least} sampai {most} hari, atau kosongkan untuk menyimpannya selamanya.",
      "Remove older messages for good?": "Hapus pesan lama untuk selamanya?",
      "Keep {days} days": "Simpan {days} hari",
      "{count} message older than {days} days is removed for good at the next pass, in every room, direct messages too. It cannot be undone.": "{count} pesan yang lebih lama dari {days} hari dihapus untuk selamanya pada putaran berikutnya, di semua ruang, termasuk pesan langsung. Ini tidak dapat dibatalkan.",
      "{count} messages older than {days} days are removed for good at the next pass, in every room, direct messages too. It cannot be undone.": "{count} pesan yang lebih lama dari {days} hari dihapus untuk selamanya pada putaran berikutnya, di semua ruang, termasuk pesan langsung. Ini tidak dapat dibatalkan.",
    },
    kept: [],
  },
  ms: {
    dictionary: {
    },
    kept: [],
  },
  jv: {
    dictionary: {
    },
    kept: [],
  },
  su: {
    dictionary: {
    },
    kept: [],
  },
  tl: {
    dictionary: {
    },
    kept: [],
  },
  vi: {
    dictionary: {
    },
    kept: [],
  },
  th: {
    dictionary: {
    },
    kept: [],
  },
  zh: {
    dictionary: {
    },
    kept: [],
  },
  ja: {
    dictionary: {
    },
    kept: [],
  },
  ko: {
    dictionary: {
    },
    kept: [],
  },
  hi: {
    dictionary: {
    },
    kept: [],
  },
  ar: {
    dictionary: {
    },
    kept: [],
  },
  es: {
    dictionary: {
    },
    kept: [],
  },
  'pt-BR': {
    dictionary: {
    },
    kept: [],
  },
  fr: {
    dictionary: {
    },
    kept: [],
  },
  de: {
    dictionary: {
    },
    kept: [],
  },
  nl: {
    dictionary: {
    },
    kept: [],
  },
  it: {
    dictionary: {
    },
    kept: [],
  },
  tr: {
    dictionary: {
    },
    kept: [],
  },
  ru: {
    dictionary: {
    },
    kept: [],
  },
};
