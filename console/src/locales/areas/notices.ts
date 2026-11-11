/**
 * The console's sentences for people's notices: what a person is told, where
 * and when (F19.13, F19.20).
 *
 * Keyed by the English, as every dictionary is; `index.ts` spreads each
 * language's into its dictionary, and `test/documents/console-i18n.test.ts`
 * reads the dictionaries whole.
 *
 * The words are each dictionary's own, as `relay.ts` gives them: its word for
 * a phone and for linking one, for pairing a relay, and the screens the owner
 * pairs one on ("This deployment, Relays"), written as that language writes a
 * screen's path.
 */
import type { Area } from '../types.ts';

export const NOTICES: Area = {
  id: {
    dictionary: {
      'Phones': 'Ponsel',
      'A phone you link is told who wrote to you or mentioned you, and what waits for you. Nothing is sent to it until you link it.':
        'Ponsel yang Anda tautkan diberi tahu siapa yang mengirim pesan kepada Anda atau menyebut Anda, dan apa yang menunggu Anda. Tidak ada yang dikirim ke ponsel itu sebelum Anda menautkannya.',
      'No relay is paired for this company yet: the owner pairs one in This deployment, Relays.':
        'Belum ada relay yang dipasangkan untuk perusahaan ini: pemilik memasangkannya di Deployment ini, Relay.',
    },
    kept: [],
  },
  ms: {
    dictionary: {
      'Phones': 'Telefon',
      'A phone you link is told who wrote to you or mentioned you, and what waits for you. Nothing is sent to it until you link it.':
        'Telefon yang anda pautkan dimaklumkan siapa yang menghantar mesej kepada anda atau menyebut anda, dan apa yang menanti anda. Tiada apa-apa dihantar kepadanya sebelum anda memautkannya.',
      'No relay is paired for this company yet: the owner pairs one in This deployment, Relays.':
        'Belum ada relay yang digandingkan untuk syarikat ini: pemilik menggandingkan satu di bawah Pemasangan ini, Relay.',
    },
    kept: [],
  },
  jv: {
    dictionary: {
      'Phones': 'HP',
      'A phone you link is told who wrote to you or mentioned you, and what waits for you. Nothing is sent to it until you link it.':
        'HP ingkang panjenengan tautaken dipunwartosi sinten ingkang ngintun pesen dhateng panjenengan utawi nyebat panjenengan, saha punapa ingkang nengga panjenengan. Mboten wonten ingkang dipunkintun dhateng HP punika ngantos panjenengan nautaken.',
      'No relay is paired for this company yet: the owner pairs one in This deployment, Relays.':
        'Dereng wonten relay ingkang dipungandhengaken kangge perusahaan punika: pamilik nggandhengaken setunggal wonten ing Pamasangan punika, Relay.',
    },
    kept: [],
  },
  su: {
    dictionary: {
      'Phones': 'HP',
      'A phone you link is told who wrote to you or mentioned you, and what waits for you. Nothing is sent to it until you link it.':
        'HP anu ku anjeun ditautkeun dibéjaan saha anu ngintunkeun pesen ka anjeun atanapi nyebat anjeun, sareng naon anu ngantosan anjeun. Teu aya anu dikirim ka dinya dugi ka anjeun nautkeunana.',
      'No relay is paired for this company yet: the owner pairs one in This deployment, Relays.':
        'Teu acan aya relay anu digandengkeun pikeun pausahaan ieu: pamilik ngagandengkeun hiji di Pamasangan ieu, Relay.',
    },
    kept: [],
  },
  tl: {
    dictionary: {
      'Phones': 'Mga phone',
      'A phone you link is told who wrote to you or mentioned you, and what waits for you. Nothing is sent to it until you link it.':
        "Sinasabihan ang phone na ili-link mo kung sino ang nagpadala ng mensahe o bumanggit sa iyo, at kung ano ang naghihintay sa iyo. Walang ipapadala rito hangga't hindi mo pa ito nali-link.",
      'No relay is paired for this company yet: the owner pairs one in This deployment, Relays.':
        'Wala pang naka-pair na relay para sa kumpanyang ito: ang may-ari ang nagpe-pair ng isa sa “Deployment na ito”, “Mga relay”.',
    },
    kept: [],
  },
  vi: {
    dictionary: {
      'Phones': 'Điện thoại',
      'A phone you link is told who wrote to you or mentioned you, and what waits for you. Nothing is sent to it until you link it.':
        'Điện thoại bạn liên kết sẽ được báo ai đã nhắn tin hoặc nhắc đến bạn, và việc gì đang chờ bạn. Không có gì được gửi đến điện thoại cho đến khi bạn liên kết nó.',
      'No relay is paired for this company yet: the owner pairs one in This deployment, Relays.':
        'Công ty này chưa có relay nào được ghép nối: chủ sở hữu ghép nối relay tại Hệ thống này > Relay.',
    },
    kept: [],
  },
  th: {
    dictionary: {
      'Phones': 'โทรศัพท์',
      'A phone you link is told who wrote to you or mentioned you, and what waits for you. Nothing is sent to it until you link it.':
        'โทรศัพท์ที่คุณลิงก์ไว้จะได้รับแจ้งว่าใครส่งข้อความถึงคุณหรือกล่าวถึงคุณ และมีอะไรรอคุณอยู่ จะไม่มีการส่งสิ่งใดไปยังโทรศัพท์จนกว่าคุณจะลิงก์',
      'No relay is paired for this company yet: the owner pairs one in This deployment, Relays.':
        'บริษัทนี้ยังไม่มีรีเลย์ที่จับคู่ไว้ เจ้าของจับคู่รีเลย์ได้ที่ ระบบนี้ > รีเลย์',
    },
    kept: [],
  },
  zh: {
    dictionary: {
      'Phones': '手机',
      'A phone you link is told who wrote to you or mentioned you, and what waits for you. Nothing is sent to it until you link it.':
        '关联的手机会收到通知：谁给您发了消息或提及了您，以及有什么在等您处理。关联之前，不会向它发送任何内容。',
      'No relay is paired for this company yet: the owner pairs one in This deployment, Relays.':
        '这家公司还没有配对的中继：所有者可在“本部署 > 中继”中配对。',
    },
    kept: [],
  },
  ja: {
    dictionary: {
      'Phones': 'スマートフォン',
      'A phone you link is told who wrote to you or mentioned you, and what waits for you. Nothing is sent to it until you link it.':
        'リンクしたスマートフォンには、誰からメッセージやメンションが届いたか、何があなたを待っているかが通知されます。リンクするまで、何も送られません。',
      'No relay is paired for this company yet: the owner pairs one in This deployment, Relays.':
        'この会社にはまだペアリングされたリレーがありません。オーナーが「このインスタンス > リレー」でペアリングします。',
    },
    kept: [],
  },
  ko: {
    dictionary: {
      'Phones': '휴대폰',
      'A phone you link is told who wrote to you or mentioned you, and what waits for you. Nothing is sent to it until you link it.':
        '연결한 휴대폰에는 누가 메시지를 보내거나 나를 멘션했는지, 무엇이 나를 기다리고 있는지 알려 드려요. 연결하기 전에는 아무것도 보내지 않아요.',
      'No relay is paired for this company yet: the owner pairs one in This deployment, Relays.':
        "이 회사에는 아직 페어링된 릴레이가 없어요. 소유자가 '이 인스턴스 > 릴레이'에서 페어링해요.",
    },
    kept: [],
  },
  hi: {
    dictionary: {
      'Phones': 'फ़ोन',
      'A phone you link is told who wrote to you or mentioned you, and what waits for you. Nothing is sent to it until you link it.':
        'आप जो फ़ोन लिंक करते हैं, उसे बताया जाता है कि किसने आपको संदेश भेजा या आपका ज़िक्र किया, और क्या आपका इंतज़ार कर रहा है। जब तक आप उसे लिंक नहीं करते, उसे कुछ नहीं भेजा जाता।',
      'No relay is paired for this company yet: the owner pairs one in This deployment, Relays.':
        'इस कंपनी के लिए अभी कोई रिले पेयर नहीं है। स्वामी इसे यहाँ पेयर करते हैं: यह डिप्लॉयमेंट, रिले।',
    },
    kept: [],
  },
  ar: {
    dictionary: {
      'Phones': 'الهواتف',
      'A phone you link is told who wrote to you or mentioned you, and what waits for you. Nothing is sent to it until you link it.':
        'يُبلَّغ الهاتف الذي تربطه بمن راسلك أو أشار إليك، وبما ينتظرك. لا يُرسل إليه شيء قبل أن تربطه.',
      'No relay is paired for this company yet: the owner pairs one in This deployment, Relays.':
        'لا يوجد بعد مُرحِّل مقترن لهذه الشركة: يقرن المالك مُرحِّلًا من «هذه المنصة»، «المُرحِّلات».',
    },
    kept: [],
  },
  es: {
    dictionary: {
      'Phones': 'Teléfonos',
      'A phone you link is told who wrote to you or mentioned you, and what waits for you. Nothing is sent to it until you link it.':
        'El teléfono que vincule recibe avisos de quién le escribe o le hace una mención, y de lo que le espera. No se le envía nada hasta que lo vincule.',
      'No relay is paired for this company yet: the owner pairs one in This deployment, Relays.':
        'Aún no hay ningún relé vinculado para esta empresa: el propietario vincula uno en Esta instancia, Relés.',
    },
    kept: [],
  },
  'pt-BR': {
    dictionary: {
      'Phones': 'Celulares',
      'A phone you link is told who wrote to you or mentioned you, and what waits for you. Nothing is sent to it until you link it.':
        'O celular que você vincular é avisado de quem escreveu para você ou mencionou você, e do que espera por você. Nada é enviado a ele até você vinculá-lo.',
      'No relay is paired for this company yet: the owner pairs one in This deployment, Relays.':
        'Ainda não há nenhum relay pareado para esta empresa: o proprietário pareia um em Esta instância, Relays.',
    },
    kept: [],
  },
  fr: {
    dictionary: {
      'Phones': 'Téléphones',
      'A phone you link is told who wrote to you or mentioned you, and what waits for you. Nothing is sent to it until you link it.':
        'Le téléphone que vous liez apprend qui vous écrit ou vous mentionne, et ce qui vous attend. Rien ne lui est envoyé tant que vous ne l’avez pas lié.',
      'No relay is paired for this company yet: the owner pairs one in This deployment, Relays.':
        'Aucun relais n’est encore appairé pour cette entreprise : le propriétaire en appaire un dans Cette instance, Relais.',
    },
    kept: [],
  },
  de: {
    dictionary: {
      'Phones': 'Handys',
      'A phone you link is told who wrote to you or mentioned you, and what waits for you. Nothing is sent to it until you link it.':
        'Ein Handy, das Sie verknüpfen, erfährt, wer Ihnen geschrieben oder Sie erwähnt hat und was auf Sie wartet. Bevor Sie es verknüpfen, wird ihm nichts geschickt.',
      'No relay is paired for this company yet: the owner pairs one in This deployment, Relays.':
        'Für dieses Unternehmen ist noch kein Relay gekoppelt: Der Inhaber koppelt eines unter „Diese Instanz, Relays“.',
    },
    kept: [],
  },
  nl: {
    dictionary: {
      'Phones': 'Telefoons',
      'A phone you link is told who wrote to you or mentioned you, and what waits for you. Nothing is sent to it until you link it.':
        'Een telefoon die je koppelt, krijgt te horen wie je een bericht stuurde of je noemde, en wat er op je wacht. Er wordt niets naartoe gestuurd tot je hem koppelt.',
      'No relay is paired for this company yet: the owner pairs one in This deployment, Relays.':
        'Voor dit bedrijf is nog geen relay gekoppeld: de eigenaar koppelt er een onder “Deze installatie, Relays”.',
    },
    kept: [],
  },
  it: {
    dictionary: {
      'Phones': 'Telefoni',
      'A phone you link is told who wrote to you or mentioned you, and what waits for you. Nothing is sent to it until you link it.':
        'Il telefono che colleghi viene avvisato di chi ti ha scritto o ti ha menzionato e di cosa ti aspetta. Non gli viene inviato nulla finché non lo colleghi.',
      'No relay is paired for this company yet: the owner pairs one in This deployment, Relays.':
        'Per questa azienda non è ancora associato nessun relay: il proprietario ne associa uno in Questa istanza, Relay.',
    },
    kept: [],
  },
  tr: {
    dictionary: {
      'Phones': 'Telefonlar',
      'A phone you link is told who wrote to you or mentioned you, and what waits for you. Nothing is sent to it until you link it.':
        'Bağladığınız telefona size kimin mesaj gönderdiği veya sizden kimin bahsettiği ve sizi neyin beklediği bildirilir. Siz bağlayana kadar ona hiçbir şey gönderilmez.',
      'No relay is paired for this company yet: the owner pairs one in This deployment, Relays.':
        'Bu şirket için henüz eşleştirilmiş bir aktarıcı yok. Sahip bir aktarıcıyı şurada eşleştirir: Bu kurulum, Aktarıcılar.',
    },
    kept: [],
  },
  ru: {
    dictionary: {
      'Phones': 'Телефоны',
      'A phone you link is told who wrote to you or mentioned you, and what waits for you. Nothing is sent to it until you link it.':
        'Привязанный вами телефон получает уведомления о том, кто вам написал или упомянул вас и что вас ждёт. Пока вы его не привяжете, ему ничего не отправляется.',
      'No relay is paired for this company yet: the owner pairs one in This deployment, Relays.':
        'Для этой компании ещё не привязан ни один ретранслятор: владелец привязывает его в разделе «Эта установка» → «Ретрансляторы».',
    },
    kept: [],
  },
};
