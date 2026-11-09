/**
 * What the platform says to people outside the console about what the owner's
 * conversations may spend, said when a turn is not taken (F19.12).
 *
 * Keyed by the English, as every sentence file is; `index.ts` spreads each
 * language's into its file in `../`, and the sentence test in
 * `test/acceptance/owner-channels.test.ts` reads those whole. A `say()` call
 * that uses one sits in a top-level `src/owner/*.ts` file, where that test
 * finds it.
 */
import type { SentenceArea } from './index.ts';

export const TALK: SentenceArea = {
  id: {
    "I cannot answer now: everything is stopped. Resume it from the console first.":
      "Saya tidak bisa menjawab sekarang: semuanya sedang dihentikan. Lanjutkan dulu dari konsol.",
    "I cannot answer now: {company} is frozen.":
      "Saya tidak bisa menjawab sekarang: {company} sedang dibekukan.",
    "I cannot answer now: {company}'s spending is paused at its ceiling. Open Money to raise it.":
      "Saya tidak bisa menjawab sekarang: pengeluaran {company} dijeda di plafonnya. Buka Keuangan untuk menaikkannya.",
    "I stopped here: the CEO's budget has no room for the next step.":
      "Saya berhenti di sini: anggaran CEO tidak cukup untuk langkah berikutnya.",
    "PALUGADA's own conversation has spent this month's allowance. Raise it under This deployment, Model, or ask again next month.":
      "Percakapan PALUGADA sendiri sudah menghabiskan jatah bulan ini. Naikkan di Deployment ini, Model, atau tanya lagi bulan depan.",
  },
  ms: {
    "I cannot answer now: everything is stopped. Resume it from the console first.":
      "Saya tidak dapat menjawab sekarang: semuanya dihentikan. Sambung semula dari konsol dahulu.",
    "I cannot answer now: {company} is frozen.":
      "Saya tidak dapat menjawab sekarang: {company} dibekukan.",
    "I cannot answer now: {company}'s spending is paused at its ceiling. Open Money to raise it.":
      "Saya tidak dapat menjawab sekarang: perbelanjaan {company} dijeda pada hadnya. Buka Wang untuk menaikkannya.",
    "I stopped here: the CEO's budget has no room for the next step.":
      "Saya berhenti di sini: bajet CEO tidak cukup untuk langkah seterusnya.",
    "PALUGADA's own conversation has spent this month's allowance. Raise it under This deployment, Model, or ask again next month.":
      "Perbualan PALUGADA sendiri telah menghabiskan peruntukan bulan ini. Naikkan di bawah Pemasangan ini, Model, atau tanya lagi bulan hadapan.",
  },
  jv: {
    "I cannot answer now: everything is stopped. Resume it from the console first.":
      "Kula boten saged mangsuli sakmenika: sedayanipun saweg kendel. Lajengaken rumiyin saking konsol.",
    "I cannot answer now: {company} is frozen.":
      "Kula boten saged mangsuli sakmenika: {company} saweg beku.",
    "I cannot answer now: {company}'s spending is paused at its ceiling. Open Money to raise it.":
      "Kula boten saged mangsuli sakmenika: wragad {company} saweg dipunendheg wonten ing watesipun. Bikak Arta kangge ngunggahaken.",
    "I stopped here: the CEO's budget has no room for the next step.":
      "Kula kendel ing ngriki: anggaran CEO boten nyekapi kangge langkah salajengipun.",
    "PALUGADA's own conversation has spent this month's allowance. Raise it under This deployment, Model, or ask again next month.":
      "Pirembagan PALUGADA piyambak sampun nelasaken jatah wulan punika. Unggahaken ing Pamasangan punika, Model AI, utawi taken malih wulan ngajeng.",
  },
  su: {
    "I cannot answer now: everything is stopped. Resume it from the console first.":
      "Abdi teu tiasa ngawaler ayeuna: sadayana nuju eureun. Teraskeun heula tina konsol.",
    "I cannot answer now: {company} is frozen.":
      "Abdi teu tiasa ngawaler ayeuna: {company} nuju beku.",
    "I cannot answer now: {company}'s spending is paused at its ceiling. Open Money to raise it.":
      "Abdi teu tiasa ngawaler ayeuna: waragad {company} nuju direureuhkeun dina watesna. Buka Artos pikeun naékkeunana.",
    "I stopped here: the CEO's budget has no room for the next step.":
      "Abdi eureun di dieu: anggaran CEO teu cekap kanggo léngkah salajengna.",
    "PALUGADA's own conversation has spent this month's allowance. Raise it under This deployment, Model, or ask again next month.":
      "Paguneman PALUGADA nyalira parantos nyéépkeun jatah bulan ieu. Naékkeun di Pamasangan ieu, Modél AI, atanapi naroskeun deui bulan payun.",
  },
  tl: {
    "I cannot answer now: everything is stopped. Resume it from the console first.":
      "Hindi ako makasagot ngayon: nakahinto ang lahat. Ituloy muna ito mula sa console.",
    "I cannot answer now: {company} is frozen.":
      "Hindi ako makasagot ngayon: naka-freeze ang {company}.",
    "I cannot answer now: {company}'s spending is paused at its ceiling. Open Money to raise it.":
      "Hindi ako makasagot ngayon: naka-pause ang paggastos ng {company} sa limit nito. Buksan ang Pera para itaas ito.",
    "I stopped here: the CEO's budget has no room for the next step.":
      "Dito na ako huminto: walang puwang ang budget ng CEO para sa susunod na hakbang.",
    "PALUGADA's own conversation has spent this month's allowance. Raise it under This deployment, Model, or ask again next month.":
      "Naubos na ng sariling usapan ng PALUGADA ang allowance ngayong buwan. Itaas ito sa “Deployment na ito”, “Modelo”, o magtanong ulit sa susunod na buwan.",
  },
  vi: {
    "I cannot answer now: everything is stopped. Resume it from the console first.":
      "Tôi chưa thể trả lời lúc này: mọi thứ đang dừng. Hãy tiếp tục từ bảng điều khiển trước.",
    "I cannot answer now: {company} is frozen.":
      "Tôi chưa thể trả lời lúc này: {company} đang bị đóng băng.",
    "I cannot answer now: {company}'s spending is paused at its ceiling. Open Money to raise it.":
      "Tôi chưa thể trả lời lúc này: chi tiêu của {company} đang tạm dừng ở hạn mức. Mở Tài chính để nâng hạn mức.",
    "I stopped here: the CEO's budget has no room for the next step.":
      "Tôi dừng ở đây: ngân sách của CEO không còn đủ cho bước tiếp theo.",
    "PALUGADA's own conversation has spent this month's allowance. Raise it under This deployment, Model, or ask again next month.":
      "Cuộc trò chuyện riêng của PALUGADA đã dùng hết hạn mức tháng này. Hãy nâng hạn mức tại Hệ thống này > Mô hình, hoặc hỏi lại vào tháng sau.",
  },
  th: {
    "I cannot answer now: everything is stopped. Resume it from the console first.":
      "ตอนนี้ฉันตอบไม่ได้ ทุกอย่างหยุดอยู่ ให้กลับมาทำงานจากคอนโซลก่อน",
    "I cannot answer now: {company} is frozen.":
      "ตอนนี้ฉันตอบไม่ได้ {company} ถูกแช่แข็งอยู่",
    "I cannot answer now: {company}'s spending is paused at its ceiling. Open Money to raise it.":
      "ตอนนี้ฉันตอบไม่ได้ การใช้จ่ายของ {company} หยุดชั่วคราวเพราะถึงเพดานแล้ว เปิดหน้าการเงินเพื่อเพิ่มเพดาน",
    "I stopped here: the CEO's budget has no room for the next step.":
      "ฉันหยุดตรงนี้ งบประมาณของ CEO ไม่พอสำหรับขั้นต่อไป",
    "PALUGADA's own conversation has spent this month's allowance. Raise it under This deployment, Model, or ask again next month.":
      "การสนทนาของ PALUGADA เองใช้วงเงินของเดือนนี้หมดแล้ว เพิ่มได้ที่ ระบบนี้ > โมเดล หรือถามใหม่เดือนหน้า",
  },
  zh: {
    "I cannot answer now: everything is stopped. Resume it from the console first.":
      "我现在无法回答：一切已停止。请先在控制台中恢复。",
    "I cannot answer now: {company} is frozen.":
      "我现在无法回答：{company} 已被冻结。",
    "I cannot answer now: {company}'s spending is paused at its ceiling. Open Money to raise it.":
      "我现在无法回答：{company} 的支出已在上限处暂停。请打开“资金”提高上限。",
    "I stopped here: the CEO's budget has no room for the next step.":
      "我就停在这里：CEO 的预算不够下一步使用。",
    "PALUGADA's own conversation has spent this month's allowance. Raise it under This deployment, Model, or ask again next month.":
      "PALUGADA 自己的对话已用完本月额度。请在“本部署 > 模型”中提高额度，或下个月再问。",
  },
  ja: {
    "I cannot answer now: everything is stopped. Resume it from the console first.":
      "今はお答えできません。すべて停止しています。先にコンソールから再開してください。",
    "I cannot answer now: {company} is frozen.":
      "今はお答えできません。{company} は凍結されています。",
    "I cannot answer now: {company}'s spending is paused at its ceiling. Open Money to raise it.":
      "今はお答えできません。{company} の支出は上限に達して一時停止中です。「お金」を開いて上限を上げてください。",
    "I stopped here: the CEO's budget has no room for the next step.":
      "ここで止めます。CEO の予算に次の手順の余裕がありません。",
    "PALUGADA's own conversation has spent this month's allowance. Raise it under This deployment, Model, or ask again next month.":
      "PALUGADA 自身との会話は今月の上限を使い切りました。「このインスタンス > モデル」で上限を上げるか、来月もう一度お尋ねください。",
  },
  ko: {
    "I cannot answer now: everything is stopped. Resume it from the console first.":
      "지금은 답할 수 없어요. 모두 중지된 상태예요. 먼저 콘솔에서 재개하세요.",
    "I cannot answer now: {company} is frozen.":
      "지금은 답할 수 없어요. {company}이(가) 동결됐어요.",
    "I cannot answer now: {company}'s spending is paused at its ceiling. Open Money to raise it.":
      "지금은 답할 수 없어요. {company}의 지출이 한도에 도달해 일시 중지됐어요. '금액' 페이지를 열어 한도를 올리세요.",
    "I stopped here: the CEO's budget has no room for the next step.":
      "여기서 멈출게요. CEO 예산에 다음 단계를 위한 여유가 없어요.",
    "PALUGADA's own conversation has spent this month's allowance. Raise it under This deployment, Model, or ask again next month.":
      "PALUGADA 자체 대화가 이번 달 한도를 모두 썼어요. '이 인스턴스 > 모델'에서 한도를 올리거나 다음 달에 다시 물어보세요.",
  },
  hi: {
    "I cannot answer now: everything is stopped. Resume it from the console first.":
      "अभी जवाब देना संभव नहीं है: सब कुछ रुका हुआ है। पहले कंसोल से फिर से शुरू करें।",
    "I cannot answer now: {company} is frozen.":
      "अभी जवाब देना संभव नहीं है: {company} फ़्रीज़ है।",
    "I cannot answer now: {company}'s spending is paused at its ceiling. Open Money to raise it.":
      "अभी जवाब देना संभव नहीं है: {company} का खर्च अपनी सीमा पर रोका गया है। सीमा बढ़ाने के लिए पैसा पेज खोलें।",
    "I stopped here: the CEO's budget has no room for the next step.":
      "यहीं रुकना पड़ रहा है: CEO के बजट में अगले कदम की गुंजाइश नहीं है।",
    "PALUGADA's own conversation has spent this month's allowance. Raise it under This deployment, Model, or ask again next month.":
      "PALUGADA की अपनी बातचीत इस महीने का भत्ता खर्च कर चुकी है। इसे “यह डिप्लॉयमेंट, मॉडल” में बढ़ाएँ, या अगले महीने फिर पूछें।",
  },
  ar: {
    "I cannot answer now: everything is stopped. Resume it from the console first.":
      "لا أستطيع الإجابة الآن: كل شيء متوقف. يجب الاستئناف من وحدة التحكم أولًا.",
    "I cannot answer now: {company} is frozen.":
      "لا أستطيع الإجابة الآن: {company} مجمّدة.",
    "I cannot answer now: {company}'s spending is paused at its ceiling. Open Money to raise it.":
      "لا أستطيع الإجابة الآن: إنفاق {company} متوقف مؤقتًا عند سقفه. يمكن فتح «المال» لرفعه.",
    "I stopped here: the CEO's budget has no room for the next step.":
      "توقفت هنا: ميزانية الرئيس التنفيذي لا تتسع للخطوة التالية.",
    "PALUGADA's own conversation has spent this month's allowance. Raise it under This deployment, Model, or ask again next month.":
      "استنفدت محادثة PALUGADA الخاصة مخصص هذا الشهر. يمكن رفعه من «هذه المنصة»، «النموذج»، أو السؤال مجددًا الشهر القادم.",
  },
  es: {
    "I cannot answer now: everything is stopped. Resume it from the console first.":
      "No puedo responder ahora: todo está detenido. Reanúdelo primero desde la consola.",
    "I cannot answer now: {company} is frozen.":
      "No puedo responder ahora: {company} está congelada.",
    "I cannot answer now: {company}'s spending is paused at its ceiling. Open Money to raise it.":
      "No puedo responder ahora: el gasto de {company} está en pausa en su tope. Abra Dinero para subirlo.",
    "I stopped here: the CEO's budget has no room for the next step.":
      "Me detengo aquí: el presupuesto del CEO no alcanza para el siguiente paso.",
    "PALUGADA's own conversation has spent this month's allowance. Raise it under This deployment, Model, or ask again next month.":
      "La conversación propia de PALUGADA ya gastó la asignación de este mes. Súbala en Esta instancia, Modelo, o vuelva a preguntar el mes que viene.",
  },
  'pt-BR': {
    "I cannot answer now: everything is stopped. Resume it from the console first.":
      "Não posso responder agora: tudo está parado. Retome primeiro pelo console.",
    "I cannot answer now: {company} is frozen.":
      "Não posso responder agora: {company} está congelada.",
    "I cannot answer now: {company}'s spending is paused at its ceiling. Open Money to raise it.":
      "Não posso responder agora: os gastos de {company} estão pausados no teto. Abra Finanças para aumentá-lo.",
    "I stopped here: the CEO's budget has no room for the next step.":
      "Parei aqui: o orçamento do CEO não tem espaço para o próximo passo.",
    "PALUGADA's own conversation has spent this month's allowance. Raise it under This deployment, Model, or ask again next month.":
      "A conversa da própria PALUGADA já gastou a cota deste mês. Aumente-a em Esta instância, Modelo, ou pergunte de novo no mês que vem.",
  },
  fr: {
    "I cannot answer now: everything is stopped. Resume it from the console first.":
      "Je ne peux pas répondre pour l’instant : tout est à l’arrêt. Reprenez d’abord depuis la console.",
    "I cannot answer now: {company} is frozen.":
      "Je ne peux pas répondre pour l’instant : {company} est gelée.",
    "I cannot answer now: {company}'s spending is paused at its ceiling. Open Money to raise it.":
      "Je ne peux pas répondre pour l’instant : les dépenses de {company} sont en pause à leur plafond. Ouvrez « Argent » pour le relever.",
    "I stopped here: the CEO's budget has no room for the next step.":
      "Je m’arrête ici : le budget du CEO n’a plus de place pour l’étape suivante.",
    "PALUGADA's own conversation has spent this month's allowance. Raise it under This deployment, Model, or ask again next month.":
      "La conversation propre à PALUGADA a dépensé l’allocation de ce mois. Relevez-la dans Cette instance, Modèle, ou redemandez le mois prochain.",
  },
  de: {
    "I cannot answer now: everything is stopped. Resume it from the console first.":
      "Ich kann gerade nicht antworten: Alles ist angehalten. Setzen Sie es zuerst in der Konsole fort.",
    "I cannot answer now: {company} is frozen.":
      "Ich kann gerade nicht antworten: {company} ist eingefroren.",
    "I cannot answer now: {company}'s spending is paused at its ceiling. Open Money to raise it.":
      "Ich kann gerade nicht antworten: Die Ausgaben von {company} sind an ihrer Obergrenze pausiert. Öffnen Sie „Finanzen“, um sie anzuheben.",
    "I stopped here: the CEO's budget has no room for the next step.":
      "Ich höre hier auf: Das Budget des CEO reicht nicht für den nächsten Schritt.",
    "PALUGADA's own conversation has spent this month's allowance. Raise it under This deployment, Model, or ask again next month.":
      "PALUGADAs eigenes Gespräch hat das Kontingent dieses Monats aufgebraucht. Erhöhen Sie es unter „Diese Instanz, Modell“, oder fragen Sie nächsten Monat wieder.",
  },
  nl: {
    "I cannot answer now: everything is stopped. Resume it from the console first.":
      "Ik kan nu niet antwoorden: alles is gestopt. Hervat het eerst vanuit de console.",
    "I cannot answer now: {company} is frozen.":
      "Ik kan nu niet antwoorden: {company} is bevroren.",
    "I cannot answer now: {company}'s spending is paused at its ceiling. Open Money to raise it.":
      "Ik kan nu niet antwoorden: de uitgaven van {company} zijn gepauzeerd op het plafond. Open Financiën om het te verhogen.",
    "I stopped here: the CEO's budget has no room for the next step.":
      "Ik stop hier: het budget van de CEO heeft geen ruimte voor de volgende stap.",
    "PALUGADA's own conversation has spent this month's allowance. Raise it under This deployment, Model, or ask again next month.":
      "Het eigen gesprek van PALUGADA heeft het budget van deze maand opgebruikt. Verhoog het onder “Deze installatie, Model”, of vraag het volgende maand opnieuw.",
  },
  it: {
    "I cannot answer now: everything is stopped. Resume it from the console first.":
      "Non posso rispondere ora: è tutto fermo. Riprendi prima dalla console.",
    "I cannot answer now: {company} is frozen.":
      "Non posso rispondere ora: {company} è congelata.",
    "I cannot answer now: {company}'s spending is paused at its ceiling. Open Money to raise it.":
      "Non posso rispondere ora: le spese di {company} sono in pausa al tetto. Apri Denaro per alzarlo.",
    "I stopped here: the CEO's budget has no room for the next step.":
      "Mi fermo qui: il budget del CEO non ha spazio per il passo successivo.",
    "PALUGADA's own conversation has spent this month's allowance. Raise it under This deployment, Model, or ask again next month.":
      "La conversazione di PALUGADA ha esaurito il budget di questo mese. Alzalo in Questa istanza, Modello, oppure chiedi di nuovo il mese prossimo.",
  },
  tr: {
    "I cannot answer now: everything is stopped. Resume it from the console first.":
      "Şu anda yanıt veremiyorum: her şey durduruldu. Önce konsoldan sürdürün.",
    "I cannot answer now: {company} is frozen.":
      "Şu anda yanıt veremiyorum: {company} şirketi donduruldu.",
    "I cannot answer now: {company}'s spending is paused at its ceiling. Open Money to raise it.":
      "Şu anda yanıt veremiyorum: {company} şirketinin harcamaları tavanında duraklatıldı. Yükseltmek için Para sayfasını açın.",
    "I stopped here: the CEO's budget has no room for the next step.":
      "Burada duruyorum: CEO bütçesinde bir sonraki adım için yer yok.",
    "PALUGADA's own conversation has spent this month's allowance. Raise it under This deployment, Model, or ask again next month.":
      "PALUGADA'nın kendi sohbeti bu ayın ödeneğini harcadı. Bu kurulum, Yapay zekâ modeli bölümünden artırın ya da gelecek ay yeniden sorun.",
  },
  ru: {
    "I cannot answer now: everything is stopped. Resume it from the console first.":
      "Сейчас я не могу ответить: всё остановлено. Сначала возобновите работу в консоли.",
    "I cannot answer now: {company} is frozen.":
      "Сейчас я не могу ответить: компания {company} заморожена.",
    "I cannot answer now: {company}'s spending is paused at its ceiling. Open Money to raise it.":
      "Сейчас я не могу ответить: расходы компании {company} приостановлены на лимите. Откройте «Деньги», чтобы его поднять.",
    "I stopped here: the CEO's budget has no room for the next step.":
      "Я остановлюсь здесь: в бюджете CEO нет места для следующего шага.",
    "PALUGADA's own conversation has spent this month's allowance. Raise it under This deployment, Model, or ask again next month.":
      "Собственный разговор PALUGADA израсходовал лимит этого месяца. Поднимите его в разделе «Эта установка» → «Модель» или спросите снова в следующем месяце.",
  },
};
