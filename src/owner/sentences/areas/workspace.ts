/**
 * What the platform says to people outside the console about the rooms (F19.1,
 * F19.3 to F19.8, F19.10).
 *
 * Keyed by the English, as every sentence file is; `index.ts` spreads each
 * language's into its file in `../`, and the sentence test in
 * `test/acceptance/owner-channels.test.ts` reads those whole. A `say()` call
 * that uses one sits in a top-level `src/owner/*.ts` file, where that test
 * finds it.
 */
import type { SentenceArea } from './index.ts';

export const WORKSPACE: SentenceArea = {
  id: {
    "Cancelled by a member of staff who asked for it": "Dibatalkan oleh staf yang memintanya",
  },
  ms: {
    "Cancelled by a member of staff who asked for it": "Dibatalkan oleh kakitangan yang memintanya",
  },
  jv: {
    "Cancelled by a member of staff who asked for it": "Dipunbatalaken dening staf ingkang nyuwun",
  },
  su: {
    "Cancelled by a member of staff who asked for it": "Dibolaykeun ku staf anu nyuhunkeunana",
  },
  tl: {
    "Cancelled by a member of staff who asked for it": "Kinansela ng isang staff na humiling nito",
  },
  vi: {
    "Cancelled by a member of staff who asked for it": "Đã bị hủy bởi một nhân viên đã yêu cầu nó",
  },
  th: {
    "Cancelled by a member of staff who asked for it": "ยกเลิกโดยพนักงานที่ขอไว้",
  },
  zh: {
    "Cancelled by a member of staff who asked for it": "已由提出请求的员工取消",
  },
  ja: {
    "Cancelled by a member of staff who asked for it": "依頼したスタッフが取り消しました",
  },
  ko: {
    "Cancelled by a member of staff who asked for it": "요청한 직원이 취소함",
  },
  hi: {
    "Cancelled by a member of staff who asked for it": "इसे माँगने वाले स्टाफ़ के एक सदस्य ने रद्द किया",
  },
  ar: {
    "Cancelled by a member of staff who asked for it": "ألغاه أحد الموظفين الذي طلبه",
  },
  es: {
    "Cancelled by a member of staff who asked for it": "Cancelado por un miembro del personal que lo pidió",
  },
  'pt-BR': {
    "Cancelled by a member of staff who asked for it": "Cancelado por um membro da equipe que o pediu",
  },
  fr: {
    "Cancelled by a member of staff who asked for it": "Annulé par un membre du personnel qui l'avait demandé",
  },
  de: {
    "Cancelled by a member of staff who asked for it": "Abgebrochen von einer Person aus dem Team, die darum gebeten hatte",
  },
  nl: {
    "Cancelled by a member of staff who asked for it": "Geannuleerd door een medewerker die erom vroeg",
  },
  it: {
    "Cancelled by a member of staff who asked for it": "Annullato da un membro del personale che lo aveva chiesto",
  },
  tr: {
    "Cancelled by a member of staff who asked for it": "İsteyen bir çalışan tarafından iptal edildi",
  },
  ru: {
    "Cancelled by a member of staff who asked for it": "Отменено сотрудником, который об этом просил",
  },
};
