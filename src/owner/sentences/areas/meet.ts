/**
 * What the platform says to people outside the console about people's meetings
 * and their reminders (F19.26).
 *
 * Keyed by the English, as every sentence file is; `index.ts` spreads each
 * language's into its file in `../`, and the sentence test in
 * `test/acceptance/owner-channels.test.ts` reads those whole. A `say()` call
 * that uses one sits in a top-level `src/owner/*.ts` file, where that test
 * finds it.
 *
 * Each language names a meeting as `meetings.ts` does and a room as
 * `notices.ts` does: where a case or a suffix would fall on the room's own
 * name, the sentence names it after a word that takes them ("в комнате
 * {room}", "{room} odasında").
 */
import type { SentenceArea } from './index.ts';

export const MEET: SentenceArea = {
  id: {
    'A meeting starts in ten minutes in {room}.': 'Rapat dimulai sepuluh menit lagi di {room}.',
    'A meeting starts in ten minutes.': 'Rapat dimulai sepuluh menit lagi.',
  },
  ms: {
    'A meeting starts in ten minutes in {room}.': 'Mesyuarat bermula sepuluh minit lagi dalam {room}.',
    'A meeting starts in ten minutes.': 'Mesyuarat bermula sepuluh minit lagi.',
  },
  jv: {
    'A meeting starts in ten minutes in {room}.': 'Rapat dipunwiwiti sedasa menit malih ing {room}.',
    'A meeting starts in ten minutes.': 'Rapat dipunwiwiti sedasa menit malih.',
  },
  su: {
    'A meeting starts in ten minutes in {room}.': 'Rapat dimimitian sapuluh menit deui di {room}.',
    'A meeting starts in ten minutes.': 'Rapat dimimitian sapuluh menit deui.',
  },
  tl: {
    'A meeting starts in ten minutes in {room}.': 'Magsisimula ang isang pulong sa loob ng sampung minuto sa {room}.',
    'A meeting starts in ten minutes.': 'Magsisimula ang isang pulong sa loob ng sampung minuto.',
  },
  vi: {
    'A meeting starts in ten minutes in {room}.': 'Một cuộc họp sẽ bắt đầu sau mười phút nữa trong {room}.',
    'A meeting starts in ten minutes.': 'Một cuộc họp sẽ bắt đầu sau mười phút nữa.',
  },
  th: {
    'A meeting starts in ten minutes in {room}.': 'การประชุมใน {room} จะเริ่มในอีกสิบนาที',
    'A meeting starts in ten minutes.': 'การประชุมจะเริ่มในอีกสิบนาที',
  },
  zh: {
    'A meeting starts in ten minutes in {room}.': '{room} 中有会议将在十分钟后开始。',
    'A meeting starts in ten minutes.': '有会议将在十分钟后开始。',
  },
  ja: {
    'A meeting starts in ten minutes in {room}.': '{room} で 10 分後に会議が始まります。',
    'A meeting starts in ten minutes.': '10 分後に会議が始まります。',
  },
  ko: {
    'A meeting starts in ten minutes in {room}.': '{room}에서 10분 후에 회의가 시작돼요.',
    'A meeting starts in ten minutes.': '10분 후에 회의가 시작돼요.',
  },
  hi: {
    'A meeting starts in ten minutes in {room}.': '{room} में दस मिनट में एक बैठक शुरू होगी।',
    'A meeting starts in ten minutes.': 'दस मिनट में एक बैठक शुरू होगी।',
  },
  ar: {
    'A meeting starts in ten minutes in {room}.': 'يبدأ اجتماع بعد عشر دقائق في {room}.',
    'A meeting starts in ten minutes.': 'يبدأ اجتماع بعد عشر دقائق.',
  },
  es: {
    'A meeting starts in ten minutes in {room}.': 'Una reunión empieza en diez minutos en {room}.',
    'A meeting starts in ten minutes.': 'Una reunión empieza en diez minutos.',
  },
  'pt-BR': {
    'A meeting starts in ten minutes in {room}.': 'Uma reunião começa em dez minutos em {room}.',
    'A meeting starts in ten minutes.': 'Uma reunião começa em dez minutos.',
  },
  fr: {
    'A meeting starts in ten minutes in {room}.': 'Une réunion commence dans dix minutes dans {room}.',
    'A meeting starts in ten minutes.': 'Une réunion commence dans dix minutes.',
  },
  de: {
    'A meeting starts in ten minutes in {room}.': 'In {room} beginnt in zehn Minuten ein Meeting.',
    'A meeting starts in ten minutes.': 'In zehn Minuten beginnt ein Meeting.',
  },
  nl: {
    'A meeting starts in ten minutes in {room}.': 'Over tien minuten begint een overleg in {room}.',
    'A meeting starts in ten minutes.': 'Over tien minuten begint een overleg.',
  },
  it: {
    'A meeting starts in ten minutes in {room}.': 'Una riunione inizia tra dieci minuti in {room}.',
    'A meeting starts in ten minutes.': 'Una riunione inizia tra dieci minuti.',
  },
  tr: {
    'A meeting starts in ten minutes in {room}.': '{room} odasında on dakika sonra bir toplantı başlıyor.',
    'A meeting starts in ten minutes.': 'On dakika sonra bir toplantı başlıyor.',
  },
  ru: {
    'A meeting starts in ten minutes in {room}.': 'Через десять минут в комнате {room} начнётся совещание.',
    'A meeting starts in ten minutes.': 'Через десять минут начнётся совещание.',
  },
};
