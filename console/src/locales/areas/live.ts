/**
 * The console's sentences for live delivery: the room stream and a hidden
 * tab's notification (F19.11).
 *
 * Keyed by the English, as every dictionary is; `index.ts` spreads each
 * language's into its dictionary, and `test/documents/console-i18n.test.ts`
 * reads the dictionaries whole.
 */
import type { Area } from '../types.ts';

export const LIVE: Area = {
  id: {
    dictionary: {
      'Allow in this browser': 'Izinkan di browser ini',
      'This browser blocks notifications from this console. Allow them in its site settings.':
        'Browser ini memblokir notifikasi dari konsol ini. Izinkan di pengaturan situsnya.',
      'This browser cannot show notifications.': 'Browser ini tidak bisa menampilkan notifikasi.',
      '{name} in {room}': '{name} di {room}',
    },
    kept: [],
  },
  ms: {
    dictionary: {
      'Allow in this browser': 'Benarkan dalam pelayar ini',
      'This browser blocks notifications from this console. Allow them in its site settings.':
        'Pelayar ini menyekat pemberitahuan daripada konsol ini. Benarkannya dalam tetapan tapak pelayar itu.',
      'This browser cannot show notifications.': 'Pelayar ini tidak boleh memaparkan pemberitahuan.',
      '{name} in {room}': '{name} dalam {room}',
    },
    kept: [],
  },
  jv: {
    dictionary: {
      'Allow in this browser': 'Parengaken wonten ing browser punika',
      'This browser blocks notifications from this console. Allow them in its site settings.':
        'Browser punika mblokir notifikasi saking konsol punika. Parengaken wonten ing setelan situsipun.',
      'This browser cannot show notifications.': 'Browser punika mboten saged nampilaken notifikasi.',
      '{name} in {room}': '{name} ing {room}',
    },
    kept: [],
  },
  su: {
    dictionary: {
      'Allow in this browser': 'Idinan di browser ieu',
      'This browser blocks notifications from this console. Allow them in its site settings.':
        'Browser ieu meungpeuk bewara ti konsol ieu. Idinan dina setélan situsna.',
      'This browser cannot show notifications.': 'Browser ieu henteu tiasa nampilkeun bewara.',
      '{name} in {room}': '{name} di {room}',
    },
    kept: [],
  },
  tl: {
    dictionary: {
      'Allow in this browser': 'Payagan sa browser na ito',
      'This browser blocks notifications from this console. Allow them in its site settings.':
        'Bina-block ng browser na ito ang mga notification mula sa console na ito. Payagan ang mga ito sa mga setting ng site nito.',
      'This browser cannot show notifications.': 'Hindi makapagpakita ng mga notification ang browser na ito.',
      '{name} in {room}': '{name} sa {room}',
    },
    kept: [],
  },
  vi: {
    dictionary: {
      'Allow in this browser': 'Cho phép trên trình duyệt này',
      'This browser blocks notifications from this console. Allow them in its site settings.':
        'Trình duyệt này đang chặn thông báo từ bảng điều khiển này. Hãy cho phép trong phần cài đặt trang web của trình duyệt.',
      'This browser cannot show notifications.': 'Trình duyệt này không hiển thị được thông báo.',
      '{name} in {room}': '{name} trong {room}',
    },
    kept: [],
  },
  th: {
    dictionary: {
      'Allow in this browser': 'อนุญาตในเบราว์เซอร์นี้',
      'This browser blocks notifications from this console. Allow them in its site settings.':
        'เบราว์เซอร์นี้บล็อกการแจ้งเตือนจากคอนโซลนี้ อนุญาตการแจ้งเตือนได้ในการตั้งค่าเว็บไซต์ของเบราว์เซอร์',
      'This browser cannot show notifications.': 'เบราว์เซอร์นี้แสดงการแจ้งเตือนไม่ได้',
      '{name} in {room}': '{name} ใน {room}',
    },
    kept: [],
  },
  zh: {
    dictionary: {
      'Allow in this browser': '在此浏览器中允许',
      'This browser blocks notifications from this console. Allow them in its site settings.':
        '此浏览器已阻止来自此控制台的通知。请在浏览器的网站设置中允许通知。',
      'This browser cannot show notifications.': '此浏览器无法显示通知。',
      '{name} in {room}': '{room} 中的 {name}',
    },
    kept: [],
  },
  ja: {
    dictionary: {
      'Allow in this browser': 'このブラウザーで許可',
      'This browser blocks notifications from this console. Allow them in its site settings.':
        'このブラウザーは、このコンソールからの通知をブロックしています。ブラウザーのサイト設定で許可してください。',
      'This browser cannot show notifications.': 'このブラウザーでは通知を表示できません。',
      '{name} in {room}': '{room} の {name}',
    },
    kept: [],
  },
  ko: {
    dictionary: {
      'Allow in this browser': '이 브라우저에서 허용',
      'This browser blocks notifications from this console. Allow them in its site settings.':
        '이 브라우저가 이 콘솔의 알림을 차단하고 있어요. 브라우저의 사이트 설정에서 허용하세요.',
      'This browser cannot show notifications.': '이 브라우저는 알림을 표시할 수 없어요.',
      '{name} in {room}': '{room}의 {name}',
    },
    kept: [],
  },
  hi: {
    dictionary: {
      'Allow in this browser': 'इस ब्राउज़र में अनुमति दें',
      'This browser blocks notifications from this console. Allow them in its site settings.':
        'यह ब्राउज़र इस कंसोल की सूचनाएँ ब्लॉक कर रहा है। ब्राउज़र की साइट सेटिंग्स में इनकी अनुमति दें।',
      'This browser cannot show notifications.': 'यह ब्राउज़र सूचनाएँ नहीं दिखा सकता।',
      '{name} in {room}': '{room} में {name}',
    },
    kept: [],
  },
  ar: {
    dictionary: {
      'Allow in this browser': 'السماح في هذا المتصفح',
      'This browser blocks notifications from this console. Allow them in its site settings.':
        'يحظر هذا المتصفح الإشعارات من هذه اللوحة. يجب السماح بها من إعدادات الموقع في المتصفح.',
      'This browser cannot show notifications.': 'لا يستطيع هذا المتصفح عرض الإشعارات.',
      '{name} in {room}': '{name} في {room}',
    },
    kept: [],
  },
  es: {
    dictionary: {
      'Allow in this browser': 'Permitir en este navegador',
      'This browser blocks notifications from this console. Allow them in its site settings.':
        'Este navegador bloquea las notificaciones de esta consola. Permítalas en la configuración del sitio del navegador.',
      'This browser cannot show notifications.': 'Este navegador no puede mostrar notificaciones.',
      '{name} in {room}': '{name} en {room}',
    },
    kept: [],
  },
  'pt-BR': {
    dictionary: {
      'Allow in this browser': 'Permitir neste navegador',
      'This browser blocks notifications from this console. Allow them in its site settings.':
        'Este navegador está bloqueando as notificações deste console. Permita-as nas configurações do site do navegador.',
      'This browser cannot show notifications.': 'Este navegador não consegue mostrar notificações.',
      '{name} in {room}': '{name} em {room}',
    },
    kept: [],
  },
  fr: {
    dictionary: {
      'Allow in this browser': 'Autoriser dans ce navigateur',
      'This browser blocks notifications from this console. Allow them in its site settings.':
        'Ce navigateur bloque les notifications de cette console. Autorisez-les dans les paramètres du site du navigateur.',
      'This browser cannot show notifications.': 'Ce navigateur ne peut pas afficher de notifications.',
      '{name} in {room}': '{name} dans {room}',
    },
    kept: [],
  },
  de: {
    dictionary: {
      'Allow in this browser': 'In diesem Browser erlauben',
      'This browser blocks notifications from this console. Allow them in its site settings.':
        'Dieser Browser blockiert Benachrichtigungen von dieser Konsole. Erlauben Sie sie in den Website-Einstellungen des Browsers.',
      'This browser cannot show notifications.': 'Dieser Browser kann keine Benachrichtigungen anzeigen.',
      '{name} in {room}': '{name} in {room}',
    },
    kept: ['{name} in {room}'],
  },
  nl: {
    dictionary: {
      'Allow in this browser': 'In deze browser toestaan',
      'This browser blocks notifications from this console. Allow them in its site settings.':
        'Deze browser blokkeert meldingen van deze console. Sta ze toe in de site-instellingen van de browser.',
      'This browser cannot show notifications.': 'Deze browser kan geen meldingen tonen.',
      '{name} in {room}': '{name} in {room}',
    },
    kept: ['{name} in {room}'],
  },
  it: {
    dictionary: {
      'Allow in this browser': 'Consenti in questo browser',
      'This browser blocks notifications from this console. Allow them in its site settings.':
        'Questo browser blocca le notifiche di questa console. Consentile nelle impostazioni del sito del browser.',
      'This browser cannot show notifications.': 'Questo browser non può mostrare notifiche.',
      '{name} in {room}': '{name} in {room}',
    },
    kept: ['{name} in {room}'],
  },
  tr: {
    dictionary: {
      'Allow in this browser': 'Bu tarayıcıda izin ver',
      'This browser blocks notifications from this console. Allow them in its site settings.':
        'Bu tarayıcı, bu konsolun bildirimlerini engelliyor. Tarayıcının site ayarlarından bildirimlere izin verin.',
      'This browser cannot show notifications.': 'Bu tarayıcı bildirim gösteremiyor.',
      '{name} in {room}': '{name}, {room} odasında',
    },
    kept: [],
  },
  ru: {
    dictionary: {
      'Allow in this browser': 'Разрешить в этом браузере',
      'This browser blocks notifications from this console. Allow them in its site settings.':
        'Этот браузер блокирует уведомления от этой консоли. Разрешите их в настройках сайта в браузере.',
      'This browser cannot show notifications.': 'Этот браузер не может показывать уведомления.',
      '{name} in {room}': '{name} в комнате {room}',
    },
    kept: [],
  },
};
