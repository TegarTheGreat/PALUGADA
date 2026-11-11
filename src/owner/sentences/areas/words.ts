/**
 * What the platform says to people outside the console about words carry their
 * author: staff words in the work, and the team's items (F19.9).
 *
 * Keyed by the English, as every sentence file is; `index.ts` spreads each
 * language's into its file in `../`, and the sentence test in
 * `test/acceptance/owner-channels.test.ts` reads those whole. A `say()` call
 * that uses one sits in a top-level `src/owner/*.ts` file, where that test
 * finds it.
 */
import type { SentenceArea } from './index.ts';

export const WORDS: SentenceArea = {
  id: {
    "A member of staff asked for this work, so an action like this waits for a person who did not ask for it.": "Seorang staf meminta pekerjaan ini, jadi tindakan seperti ini menunggu orang yang tidak memintanya.",
    "A member of staff, {name}, asked for this work, so an action like this waits for a person who did not ask for it.": "Seorang staf, {name}, meminta pekerjaan ini, jadi tindakan seperti ini menunggu orang yang tidak memintanya.",
    "Members of staff, {names}, asked for this work, so an action like this waits for a person who did not ask for it.": "Beberapa staf, {names}, meminta pekerjaan ini, jadi tindakan seperti ini menunggu orang yang tidak memintanya.",
    "Your team's work: {count} waiting": "Pekerjaan tim Anda: {count} menunggu",
    "A question for {name}": "Pertanyaan untuk {name}",
  },
  ms: {
    "A member of staff asked for this work, so an action like this waits for a person who did not ask for it.": "Seorang kakitangan meminta kerja ini, jadi tindakan seperti ini menunggu orang yang tidak memintanya.",
    "A member of staff, {name}, asked for this work, so an action like this waits for a person who did not ask for it.": "Seorang kakitangan, {name}, meminta kerja ini, jadi tindakan seperti ini menunggu orang yang tidak memintanya.",
    "Members of staff, {names}, asked for this work, so an action like this waits for a person who did not ask for it.": "Beberapa kakitangan, {names}, meminta kerja ini, jadi tindakan seperti ini menunggu orang yang tidak memintanya.",
    "Your team's work: {count} waiting": "Kerja pasukan anda: {count} menunggu",
    "A question for {name}": "Soalan untuk {name}",
  },
  jv: {
    "A member of staff asked for this work, so an action like this waits for a person who did not ask for it.": "Satunggaling staf nyuwun pakaryan menika, dados tumindak kados mekaten nengga tiyang ingkang mboten nyuwun.",
    "A member of staff, {name}, asked for this work, so an action like this waits for a person who did not ask for it.": "Satunggaling staf, {name}, nyuwun pakaryan menika, dados tumindak kados mekaten nengga tiyang ingkang mboten nyuwun.",
    "Members of staff, {names}, asked for this work, so an action like this waits for a person who did not ask for it.": "Sawetawis staf, {names}, nyuwun pakaryan menika, dados tumindak kados mekaten nengga tiyang ingkang mboten nyuwun.",
    "Your team's work: {count} waiting": "Pakaryan tim panjenengan: {count} nengga",
    "A question for {name}": "Pitakènan kangge {name}",
  },
  su: {
    "A member of staff asked for this work, so an action like this waits for a person who did not ask for it.": "Salah saurang staf nyuhunkeun padamelan ieu, janten tindakan sapertos kieu ngantosan jalma anu henteu nyuhunkeun.",
    "A member of staff, {name}, asked for this work, so an action like this waits for a person who did not ask for it.": "Salah saurang staf, {name}, nyuhunkeun padamelan ieu, janten tindakan sapertos kieu ngantosan jalma anu henteu nyuhunkeun.",
    "Members of staff, {names}, asked for this work, so an action like this waits for a person who did not ask for it.": "Sababaraha staf, {names}, nyuhunkeun padamelan ieu, janten tindakan sapertos kieu ngantosan jalma anu henteu nyuhunkeun.",
    "Your team's work: {count} waiting": "Padamelan tim anjeun: {count} ngantosan",
    "A question for {name}": "Patarosan pikeun {name}",
  },
  tl: {
    "A member of staff asked for this work, so an action like this waits for a person who did not ask for it.": "Isang staff ang humingi ng gawaing ito, kaya ang ganitong aksyon ay naghihintay sa taong hindi humingi nito.",
    "A member of staff, {name}, asked for this work, so an action like this waits for a person who did not ask for it.": "Isang staff, si {name}, ang humingi ng gawaing ito, kaya ang ganitong aksyon ay naghihintay sa taong hindi humingi nito.",
    "Members of staff, {names}, asked for this work, so an action like this waits for a person who did not ask for it.": "Mga staff, sina {names}, ang humingi ng gawaing ito, kaya ang ganitong aksyon ay naghihintay sa taong hindi humingi nito.",
    "Your team's work: {count} waiting": "Gawain ng iyong team: {count} naghihintay",
    "A question for {name}": "Isang tanong para kay {name}",
  },
  vi: {
    "A member of staff asked for this work, so an action like this waits for a person who did not ask for it.": "Một nhân viên đã yêu cầu công việc này, nên hành động như thế này chờ một người không yêu cầu nó.",
    "A member of staff, {name}, asked for this work, so an action like this waits for a person who did not ask for it.": "Một nhân viên, {name}, đã yêu cầu công việc này, nên hành động như thế này chờ một người không yêu cầu nó.",
    "Members of staff, {names}, asked for this work, so an action like this waits for a person who did not ask for it.": "Các nhân viên, {names}, đã yêu cầu công việc này, nên hành động như thế này chờ một người không yêu cầu nó.",
    "Your team's work: {count} waiting": "Việc của nhóm bạn: {count} đang chờ",
    "A question for {name}": "Một câu hỏi cho {name}",
  },
  th: {
    "A member of staff asked for this work, so an action like this waits for a person who did not ask for it.": "พนักงานคนหนึ่งขอให้ทำงานนี้ การกระทำแบบนี้จึงรอคนที่ไม่ได้ขอ",
    "A member of staff, {name}, asked for this work, so an action like this waits for a person who did not ask for it.": "{name} ซึ่งเป็นพนักงาน ขอให้ทำงานนี้ การกระทำแบบนี้จึงรอคนที่ไม่ได้ขอ",
    "Members of staff, {names}, asked for this work, so an action like this waits for a person who did not ask for it.": "พนักงาน {names} ขอให้ทำงานนี้ การกระทำแบบนี้จึงรอคนที่ไม่ได้ขอ",
    "Your team's work: {count} waiting": "งานของทีมคุณ: รออยู่ {count}",
    "A question for {name}": "คำถามสำหรับ {name}",
  },
  zh: {
    "A member of staff asked for this work, so an action like this waits for a person who did not ask for it.": "一位员工提出了这项工作，因此这样的操作要等一位没有提出的人来决定。",
    "A member of staff, {name}, asked for this work, so an action like this waits for a person who did not ask for it.": "员工 {name} 提出了这项工作，因此这样的操作要等一位没有提出的人来决定。",
    "Members of staff, {names}, asked for this work, so an action like this waits for a person who did not ask for it.": "员工 {names} 提出了这项工作，因此这样的操作要等一位没有提出的人来决定。",
    "Your team's work: {count} waiting": "你团队的工作：{count} 项待处理",
    "A question for {name}": "给 {name} 的问题",
  },
  ja: {
    "A member of staff asked for this work, so an action like this waits for a person who did not ask for it.": "スタッフがこの仕事を頼んだため、このような操作は頼んでいない人の判断を待ちます。",
    "A member of staff, {name}, asked for this work, so an action like this waits for a person who did not ask for it.": "スタッフの {name} がこの仕事を頼んだため、このような操作は頼んでいない人の判断を待ちます。",
    "Members of staff, {names}, asked for this work, so an action like this waits for a person who did not ask for it.": "スタッフの {names} がこの仕事を頼んだため、このような操作は頼んでいない人の判断を待ちます。",
    "Your team's work: {count} waiting": "チームの仕事：{count} 件が待機中",
    "A question for {name}": "{name} への質問",
  },
  ko: {
    "A member of staff asked for this work, so an action like this waits for a person who did not ask for it.": "직원이 이 업무를 요청했으므로, 이런 작업은 요청하지 않은 사람을 기다립니다.",
    "A member of staff, {name}, asked for this work, so an action like this waits for a person who did not ask for it.": "직원 {name} 님이 이 업무를 요청했으므로, 이런 작업은 요청하지 않은 사람을 기다립니다.",
    "Members of staff, {names}, asked for this work, so an action like this waits for a person who did not ask for it.": "직원 {names} 님이 이 업무를 요청했으므로, 이런 작업은 요청하지 않은 사람을 기다립니다.",
    "Your team's work: {count} waiting": "팀의 업무: {count}건 대기 중",
    "A question for {name}": "{name} 님에게 한 질문",
  },
  hi: {
    "A member of staff asked for this work, so an action like this waits for a person who did not ask for it.": "स्टाफ़ के एक सदस्य ने यह काम माँगा, इसलिए ऐसी कार्रवाई उस व्यक्ति की प्रतीक्षा करती है जिसने इसे नहीं माँगा।",
    "A member of staff, {name}, asked for this work, so an action like this waits for a person who did not ask for it.": "स्टाफ़ के सदस्य {name} ने यह काम माँगा, इसलिए ऐसी कार्रवाई उस व्यक्ति की प्रतीक्षा करती है जिसने इसे नहीं माँगा।",
    "Members of staff, {names}, asked for this work, so an action like this waits for a person who did not ask for it.": "स्टाफ़ के सदस्यों {names} ने यह काम माँगा, इसलिए ऐसी कार्रवाई उस व्यक्ति की प्रतीक्षा करती है जिसने इसे नहीं माँगा।",
    "Your team's work: {count} waiting": "आपकी टीम का काम: {count} प्रतीक्षा में",
    "A question for {name}": "{name} के लिए एक सवाल",
  },
  ar: {
    "A member of staff asked for this work, so an action like this waits for a person who did not ask for it.": "طلب أحد الموظفين هذا العمل، لذا ينتظر إجراء كهذا شخصًا لم يطلبه.",
    "A member of staff, {name}, asked for this work, so an action like this waits for a person who did not ask for it.": "طلب الموظف {name} هذا العمل، لذا ينتظر إجراء كهذا شخصًا لم يطلبه.",
    "Members of staff, {names}, asked for this work, so an action like this waits for a person who did not ask for it.": "طلب الموظفون {names} هذا العمل، لذا ينتظر إجراء كهذا شخصًا لم يطلبه.",
    "Your team's work: {count} waiting": "عمل فريقك: {count} بانتظار القرار",
    "A question for {name}": "سؤال إلى {name}",
  },
  es: {
    "A member of staff asked for this work, so an action like this waits for a person who did not ask for it.": "Un miembro del personal pidió este trabajo, así que una acción así espera a una persona que no lo pidió.",
    "A member of staff, {name}, asked for this work, so an action like this waits for a person who did not ask for it.": "Un miembro del personal, {name}, pidió este trabajo, así que una acción así espera a una persona que no lo pidió.",
    "Members of staff, {names}, asked for this work, so an action like this waits for a person who did not ask for it.": "Miembros del personal, {names}, pidieron este trabajo, así que una acción así espera a una persona que no lo pidió.",
    "Your team's work: {count} waiting": "Trabajo de tu equipo: {count} en espera",
    "A question for {name}": "Una pregunta para {name}",
  },
  'pt-BR': {
    "A member of staff asked for this work, so an action like this waits for a person who did not ask for it.": "Um membro da equipe pediu este trabalho, então uma ação assim aguarda uma pessoa que não o pediu.",
    "A member of staff, {name}, asked for this work, so an action like this waits for a person who did not ask for it.": "Um membro da equipe, {name}, pediu este trabalho, então uma ação assim aguarda uma pessoa que não o pediu.",
    "Members of staff, {names}, asked for this work, so an action like this waits for a person who did not ask for it.": "Membros da equipe, {names}, pediram este trabalho, então uma ação assim aguarda uma pessoa que não o pediu.",
    "Your team's work: {count} waiting": "Trabalho da sua equipe: {count} aguardando",
    "A question for {name}": "Uma pergunta para {name}",
  },
  fr: {
    "A member of staff asked for this work, so an action like this waits for a person who did not ask for it.": "Un membre du personnel a demandé ce travail : une action comme celle-ci attend une personne qui ne l'a pas demandée.",
    "A member of staff, {name}, asked for this work, so an action like this waits for a person who did not ask for it.": "Un membre du personnel, {name}, a demandé ce travail : une action comme celle-ci attend une personne qui ne l'a pas demandée.",
    "Members of staff, {names}, asked for this work, so an action like this waits for a person who did not ask for it.": "Des membres du personnel, {names}, ont demandé ce travail : une action comme celle-ci attend une personne qui ne l'a pas demandée.",
    "Your team's work: {count} waiting": "Le travail de votre équipe : {count} en attente",
    "A question for {name}": "Une question pour {name}",
  },
  de: {
    "A member of staff asked for this work, so an action like this waits for a person who did not ask for it.": "Eine Person aus dem Team hat diese Arbeit erbeten, daher wartet eine solche Aktion auf jemanden, der sie nicht erbeten hat.",
    "A member of staff, {name}, asked for this work, so an action like this waits for a person who did not ask for it.": "{name} aus dem Team hat diese Arbeit erbeten, daher wartet eine solche Aktion auf jemanden, der sie nicht erbeten hat.",
    "Members of staff, {names}, asked for this work, so an action like this waits for a person who did not ask for it.": "{names} aus dem Team haben diese Arbeit erbeten, daher wartet eine solche Aktion auf jemanden, der sie nicht erbeten hat.",
    "Your team's work: {count} waiting": "Arbeit Ihres Teams: {count} wartend",
    "A question for {name}": "Eine Frage an {name}",
  },
  nl: {
    "A member of staff asked for this work, so an action like this waits for a person who did not ask for it.": "Een medewerker vroeg om dit werk, dus wacht een actie als deze op iemand die er niet om vroeg.",
    "A member of staff, {name}, asked for this work, so an action like this waits for a person who did not ask for it.": "Een medewerker, {name}, vroeg om dit werk, dus wacht een actie als deze op iemand die er niet om vroeg.",
    "Members of staff, {names}, asked for this work, so an action like this waits for a person who did not ask for it.": "Medewerkers, {names}, vroegen om dit werk, dus wacht een actie als deze op iemand die er niet om vroeg.",
    "Your team's work: {count} waiting": "Werk van je team: {count} wachtend",
    "A question for {name}": "Een vraag voor {name}",
  },
  it: {
    "A member of staff asked for this work, so an action like this waits for a person who did not ask for it.": "Un membro del personale ha chiesto questo lavoro, quindi un'azione come questa attende una persona che non l'ha chiesto.",
    "A member of staff, {name}, asked for this work, so an action like this waits for a person who did not ask for it.": "Un membro del personale, {name}, ha chiesto questo lavoro, quindi un'azione come questa attende una persona che non l'ha chiesto.",
    "Members of staff, {names}, asked for this work, so an action like this waits for a person who did not ask for it.": "Membri del personale, {names}, hanno chiesto questo lavoro, quindi un'azione come questa attende una persona che non l'ha chiesto.",
    "Your team's work: {count} waiting": "Lavoro del tuo team: {count} in attesa",
    "A question for {name}": "Una domanda per {name}",
  },
  tr: {
    "A member of staff asked for this work, so an action like this waits for a person who did not ask for it.": "Bu işi bir çalışan istedi; bu yüzden böyle bir eylem, onu istemeyen birini bekler.",
    "A member of staff, {name}, asked for this work, so an action like this waits for a person who did not ask for it.": "Bu işi çalışanlardan {name} istedi; bu yüzden böyle bir eylem, onu istemeyen birini bekler.",
    "Members of staff, {names}, asked for this work, so an action like this waits for a person who did not ask for it.": "Bu işi çalışanlardan {names} istedi; bu yüzden böyle bir eylem, onu istemeyen birini bekler.",
    "Your team's work: {count} waiting": "Ekibinizin işi: {count} bekliyor",
    "A question for {name}": "{name} için bir soru",
  },
  ru: {
    "A member of staff asked for this work, so an action like this waits for a person who did not ask for it.": "Эту работу попросил сотрудник, поэтому такое действие ждёт человека, который её не просил.",
    "A member of staff, {name}, asked for this work, so an action like this waits for a person who did not ask for it.": "Эту работу попросил сотрудник {name}, поэтому такое действие ждёт человека, который её не просил.",
    "Members of staff, {names}, asked for this work, so an action like this waits for a person who did not ask for it.": "Эту работу попросили сотрудники {names}, поэтому такое действие ждёт человека, который её не просил.",
    "Your team's work: {count} waiting": "Работа вашей команды: ждут решения — {count}",
    "A question for {name}": "Вопрос для {name}",
  },
};
