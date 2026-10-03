/**
 * Türkçe: what the platform itself says to the owner outside the console
 * (src/owner/say.ts), keyed by its English.
 *
 * The words are the console's (console/src/locales/tr.ts): Onayla, Reddet and
 * Sor on the buttons, "Bu kurulum, Araçlar, Dinleme" for the screens it
 * points at, and "siz" for the owner. No case suffix touches a placeholder:
 * a value stands after a colon, beside its noun, or next to a postposition
 * written apart ("{name} ile"). WhatsApp cuts a reply button's title at 20
 * characters and a list row's at 24, so those stay short.
 */
export const SENTENCES: Readonly<Record<string, string>> = {
  'Incident: {title}': 'Aksaklık: {title}',
  'Done: {goal}': 'Tamamlandı: {goal}',
  'Stopped before finishing: {goal}': 'Bitmeden durdu: {goal}',
  'Not done: {goal}': 'Yapılmadı: {goal}',
  'Why: {reason}': 'Neden: {reason}',
  'a task': 'bir görev',
  'Approval needed: {title}': 'Onay gerekiyor: {title}',
  '{summary} — if denied: {consequence}': '{summary} — reddedilirse: {consequence}',
  'If denied:': 'Reddedilirse:',
  'Expires:': 'Sona erme:',
  'This one is decided in the app.': 'Bu, uygulamada karara bağlanır.',
  'Open in PALUGADA': "PALUGADA'da aç",
  'Approve': 'Onayla',
  'Deny': 'Reddet',
  'Ask': 'Sor',
  'Approved. Nothing left to press here.': 'Onaylandı. Burada basılacak başka bir şey yok.',
  'Denied. Nothing left to press here.': 'Reddedildi. Burada basılacak başka bir şey yok.',
  'Expired unanswered. Silence is a refusal, so nothing was done.':
    'Yanıtlanmadan süresi doldu. Sessizlik ret sayılır; bu yüzden hiçbir şey yapılmadı.',
  'This bot only answers to its owner.': 'Bu bot yalnızca sahibine yanıt verir.',
  'That one has to be approved in the app.': 'Bunun uygulamada onaylanması gerekiyor.',
  'That could not be recorded.': 'Bu kaydedilemedi.',
  'That item no longer exists.': 'Bu öğe artık yok.',
  'What do you want to ask about "{title}"? Reply to this message.':
    '“{title}” hakkında ne sormak istiyorsunuz? Bu mesajı yanıtlayın.',
  'Your question': 'Sorunuz',
  'Type your question as a reply.': 'Sorunuzu bu mesaja yanıt olarak yazın.',
  'Asked. The answer will be on the item in the app.': 'Soruldu. Yanıt, uygulamadaki öğede görünecek.',
  'Answer': 'Yanıtla',
  'Answer in words': 'Sözle yanıtla',
  'That choice is not on this question.': 'Bu seçenek bu soruda yok.',
  'Chosen: {choice}.': 'Seçildi: {choice}.',
  'Stop the task': 'Görevi durdur',
  'Your answer to "{question}"? Reply to this message.': '“{question}” sorusuna yanıtınız nedir? Bu mesajı yanıtlayın.',
  'Your answer': 'Yanıtınız',
  'Type your answer as a reply.': 'Yanıtınızı bu mesaja yanıt olarak yazın.',
  'Answered. The task carries on with it.': 'Yanıtlandı. Görev bu yanıtla devam ediyor.',
  'That is too long for one question; keep it under {max} characters.':
    'Tek bir soru için çok uzun; {max} karakterin altında tutun.',
  '[a key, not kept]': '[bir anahtar, saklanmadı]',
  'That looks like a key, so I did not keep it or send it anywhere. Keys go in the sealed field on a card, or on their page in This deployment: tell me what it is for and I will put the card in front of you.':
    'Bu bir anahtara benziyor; bu yüzden onu saklamadım ve hiçbir yere göndermedim. Anahtarlar bir kartın mühürlü alanına ya da Bu kurulum altındaki kendi sayfalarına girilir: ne için olduğunu söyleyin, kartı önünüze koyayım.',
  'No model is set up yet, so I cannot think. Choose one under This deployment, Model; then I can help with everything else.':
    'Henüz bir model ayarlanmadı; bu yüzden düşünemiyorum. Şuradan bir tane seçin: Bu kurulum, Yapay zekâ modeli. Sonra diğer her konuda yardımcı olabilirim.',
  'The model did not answer: {reason}': 'Model yanıt vermedi: {reason}',
  'Here is what I propose.': 'Önerim şu.',
  'I have nothing to add.': 'Ekleyecek bir şeyim yok.',
  '{name}, CEO of {company}': "{name}, {company} şirketinin CEO'su",
  'That could not be answered: {reason}': 'Bu yanıtlanamadı: {reason}',
  'I read text and voice notes.': 'Metin ve sesli mesajları okurum.',
  'Now talking to {name}.': 'Şu anda konuştuğunuz: {name}.',
  'Choose whom to talk to.': 'Kiminle konuşacağınızı seçin.',
  'Choose whom to talk to': 'Kiminle konuşacağınızı seçin',
  'Talk to PALUGADA about the whole deployment': 'Kurulumun tamamı hakkında PALUGADA ile konuşun',
  'Who you are talking to, and how': 'Kiminle ve nasıl konuştuğunuz',
  'Stopped.': 'Durduruldu.',
  'Write here to talk to {name}.': '{name} ile konuşmak için buraya yazın.',
  'You are talking to {name}. Write, or send a voice note. /ceo chooses whom you talk to; /palugada talks to PALUGADA about the whole deployment.':
    'Şu anda {name} ile konuşuyorsunuz. Yazın ya da sesli mesaj gönderin. /ceo kiminle konuşacağınızı seçer; /palugada sizi kurulumun tamamı hakkında PALUGADA ile konuşturur.',
  'You said: "{words}"': 'Söylediğiniz: “{words}”',
  'in the app': 'uygulamada',
  'Apply: {summary}': 'Uygula: {summary}',
  'Nothing hears speech yet: choose a provider in the app, under This deployment, Tools, Listening.':
    'Henüz konuşmayı dinleyen bir şey yok: uygulamada şuradan bir sağlayıcı seçin: Bu kurulum, Araçlar, Dinleme.',
  'That recording is too long; keep a voice note under {max} MB.': 'Bu kayıt çok uzun; sesli mesajı {max} MB altında tutun.',
  'I could not make out any words in that.': 'Bu kayıtta tek bir kelime bile anlayamadım.',
  'Done: {summary}': 'Yapıldı: {summary}',
  'That one is applied in the app.': 'Bu kart uygulamada uygulanır.',
  'That card no longer exists.': 'Bu kart artık yok.',
  'That card was already applied.': 'Bu kart zaten uygulandı.',
  'That card was dismissed.': 'Bu kart yok sayıldı.',
  'That card failed when it was applied.': 'Bu kart uygulanırken başarısız oldu.',
  'That could not be done: {reason}': 'Bu yapılamadı: {reason}',
  'Choose': 'Seç',
  'What do you want to ask about "{title}"? Reply to this message with your question.':
    '“{title}” hakkında ne sormak istiyorsunuz? Sorunuzu bu mesaja yanıt olarak yazın.',
  'Your answer to "{question}"? Reply to this message with your answer.':
    '“{question}” sorusuna yanıtınız nedir? Yanıtınızı bu mesaja yanıt olarak yazın.',
  'I read text messages here.': 'Burada metin mesajlarını okurum.',
  'Apply one of these here:': 'Bunlardan birini buradan uygulayın:',
  'Apply {number}': 'Uygula: {number}',
  'Signed in to {provider} for the {alias} key': '{alias} anahtarı için {provider} hizmetinde oturum açıldı',
  'Go back to PALUGADA: the division holds this key now, and it is renewed before it runs out. This tab can be closed.':
    "PALUGADA'ya dönün: bu anahtar artık departmanda tutuluyor ve süresi dolmadan yenileniyor. Bu sekmeyi kapatabilirsiniz.",
  'Signed in to {name}': '{name} hizmetinde oturum açıldı',
  'Go back to PALUGADA to choose which of its tools roles may use. This tab can be closed.':
    "Rollerin hangi araçlarını kullanabileceğini seçmek için PALUGADA'ya dönün. Bu sekmeyi kapatabilirsiniz.",
  'Not signed in': 'Oturum açılmadı',
  'Recorded: approved.': 'Kaydedildi: onaylandı.',
  'Recorded: denied.': 'Kaydedildi: reddedildi.',
  'Recorded: asked.': 'Kaydedildi: soruldu.',
  'Asked. Nothing left to press here.': 'Soruldu. Burada basılacak başka bir şey yok.',
  'Withdrawn: the task it was asking about has finished.': 'Geri çekildi: ilgili görev tamamlandı.',
  'Withdrawn: the task it was asking about has failed.': 'Geri çekildi: ilgili görev başarısız oldu.',
  'Withdrawn: the task it was asking about was stopped.': 'Geri çekildi: ilgili görev durduruldu.',
  'Withdrawn: the task it was asking about was cancelled.': 'Geri çekildi: ilgili görev iptal edildi.',
  'Decided. Nothing left to press here.': 'Karara bağlandı. Burada basılacak başka bir şey yok.',
  'Withdrawn: the agent changed what it proposes and asked again about the new one.': 'Geri çekildi: ajan önerisini değiştirdi ve yenisi için yeniden sordu.',
  'Withdrawn: the company is no longer at the stage this proposal would move it from.': 'Geri çekildi: bu öneri şirketi bulunduğu aşamadan taşıyacaktı, ama şirket artık o aşamada değil.',
  'Withdrawn: it was already decided in the app.': 'Geri çekildi: uygulamada zaten karara bağlanmıştı.',
  'Withdrawn. Nothing left to press here.': 'Geri çekildi. Burada basılacak başka bir şey yok.',
  'Work stopped: the {account} account is out of tokens': 'İş durdu: {account} hesabının token’ları bitti',
  '"{work}" stopped because the {account} account has used {spent} of its {max} tokens. Raise its ceiling under Money, then open the task and press Continue: it carries on from where it stopped.': '“{work}” durdu çünkü {account} hesabı {max} token’ının {spent} tanesini kullandı. Para bölümünde tavanını yükseltin, sonra görevi açıp Devam et’e basın: kaldığı yerden sürer.',
  'Withdrawn: you continued the task it was about.': 'Geri çekildi: ilgili görevi sürdürdünüz.',
};
