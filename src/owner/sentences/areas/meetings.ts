/**
 * What the platform says to people outside the console about agent meetings in
 * the rooms (F19.17, F19.18).
 *
 * Keyed by the English, as every sentence file is; `index.ts` spreads each
 * language's into its file in `../`, and the sentence test in
 * `test/acceptance/owner-channels.test.ts` reads those whole. A `say()` call
 * that uses one sits in a top-level `src/owner/*.ts` file, where that test
 * finds it.
 */
import type { SentenceArea } from './index.ts';

export const MEETINGS: SentenceArea = {
  id: {
    'The meeting went on without an answer.': 'Rapat berlanjut tanpa jawaban.',
  },
  ms: {
    'The meeting went on without an answer.': 'Mesyuarat diteruskan tanpa jawapan.',
  },
  jv: {
    'The meeting went on without an answer.': 'Rapat lajeng tanpa wangsulan.',
  },
  su: {
    'The meeting went on without an answer.': 'Rapat diteraskeun tanpa waleran.',
  },
  tl: {
    'The meeting went on without an answer.': 'Nagpatuloy ang pulong nang walang sagot.',
  },
  vi: {
    'The meeting went on without an answer.': 'Cuộc họp đã tiếp tục mà không có câu trả lời.',
  },
  th: {
    'The meeting went on without an answer.': 'การประชุมดำเนินต่อไปโดยไม่มีคำตอบ',
  },
  zh: {
    'The meeting went on without an answer.': '会议在没有答复的情况下继续进行。',
  },
  ja: {
    'The meeting went on without an answer.': '回答がないまま会議が続行されました。',
  },
  ko: {
    'The meeting went on without an answer.': '답변 없이 회의가 계속 진행되었습니다.',
  },
  hi: {
    'The meeting went on without an answer.': 'बैठक बिना उत्तर के आगे बढ़ गई।',
  },
  ar: {
    'The meeting went on without an answer.': 'استمر الاجتماع دون إجابة.',
  },
  es: {
    'The meeting went on without an answer.': 'La reunión siguió sin una respuesta.',
  },
  'pt-BR': {
    'The meeting went on without an answer.': 'A reunião seguiu sem uma resposta.',
  },
  fr: {
    'The meeting went on without an answer.': 'La réunion a continué sans réponse.',
  },
  de: {
    'The meeting went on without an answer.': 'Das Meeting ging ohne Antwort weiter.',
  },
  nl: {
    'The meeting went on without an answer.': 'Het overleg ging verder zonder antwoord.',
  },
  it: {
    'The meeting went on without an answer.': 'La riunione è andata avanti senza una risposta.',
  },
  tr: {
    'The meeting went on without an answer.': 'Toplantı yanıt olmadan devam etti.',
  },
  ru: {
    'The meeting went on without an answer.': 'Совещание продолжилось без ответа.',
  },
};
