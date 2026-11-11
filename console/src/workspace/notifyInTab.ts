/**
 * A hidden tab tells its person of a direct message or a mention (F19.11;
 * STATUS 2.210), when they asked for it in their profile and the browser
 * allows it.
 *
 * The room stream says only that a message was written, where, and whether
 * it named the person: no word. The words are fetched here, as the person,
 * through the same routes the room reads them by, so what the notification
 * says is exactly what the person may read, and nothing reaches a browser's
 * notification that its person could not open. There is no service worker:
 * a closed tab tells nobody anything, and the browser's permission is asked
 * only when the person presses for it, never on load.
 *
 * Some browsers have notifications and will not make one from a page:
 * Chrome on Android has the constructor, and says permission may be granted,
 * then refuses with a TypeError that a service worker must show it. Such a
 * browser is found before permission is asked, when a notification made to
 * find out shows nothing, or else the first time one is refused, and is said
 * to be unable to show one for the tab's life (STATUS 2.218); a phone is told
 * through a relay its person links instead (STATUS 2.213).
 */
import { useRef } from 'react';
import { api } from '../api.ts';
import { t } from '../i18n.ts';
import { go } from '../router.ts';
import { nameOf, roomName } from './scope.ts';
import type { ActivityItem, MessagePage, MessageView, Room, RoomFrame, ThreadView } from './types.ts';
import { useRoomStream } from './useRoomStream.ts';

/** What the browser says of notifications from this console: allowed, refused, not asked yet, or none to show. */
export type BrowserPermission = 'granted' | 'denied' | 'default' | 'unsupported';

/** Whether this browser refused to make a notification from the page: kept in memory for the tab's life. */
let refused = false;

export function browserPermission(): BrowserPermission {
  return refused || typeof Notification === 'undefined' ? 'unsupported' : Notification.permission;
}

/**
 * Whether the browser refuses to make a notification from a page. Asked only
 * while permission is not granted, when the notification made to find out
 * cannot be shown: once granted, asking would show one.
 */
function refusesPages(): boolean {
  if (Notification.permission === 'granted') return false;
  try {
    new Notification('', { silent: true }).close();
    return false;
  } catch (error) {
    return error instanceof TypeError;
  }
}

/** Asks the browser, from a press: it allows a question only in answer to one. */
export async function askBrowser(): Promise<BrowserPermission> {
  if (typeof Notification === 'undefined' || refused) return 'unsupported';
  if (refusesPages()) {
    refused = true;
    return 'unsupported';
  }
  return Notification.requestPermission();
}

/** The most of a message a notification shows. */
const MOST = 140;

/** A frame about a room's change: the kind that names a message. */
type Change = Extract<RoomFrame, { position: number }>;
/** The rooms a tab has read, by id. */
type Known = Map<string, Room>;
/** The message a frame names, and the thread it is in. */
type Found = { message: MessageView; threadOf: string | null };

/**
 * Listens to the company's room stream while a person is signed in to it,
 * and shows a notification for a direct message or a mention from someone
 * else while the tab is hidden.
 */
export function useTabNotices(companyId: string | null, me: { principal: string; notifyInTab: boolean } | null): void {
  // The rooms' kinds and names, as the person last read them, for the tab's life: never kept in the browser.
  const rooms = useRef<Known>(new Map());
  const who = useRef(me);
  who.current = me;
  useRoomStream(companyId, (frame) => {
    const person = who.current;
    if (!companyId || !person?.notifyInTab || frame.kind !== 'message' || !frame.ref) return;
    if (document.visibilityState !== 'hidden' || browserPermission() !== 'granted') return;
    void tell(companyId, person.principal, frame, rooms.current).catch(() => undefined);
  });
}

async function tell(companyId: string, me: string, frame: Change, rooms: Known): Promise<void> {
  let room = rooms.get(frame.room);
  if (!room) {
    room = ((await api('GET', `/api/companies/${companyId}/rooms/${frame.room}`)) as { room: Room }).room;
    rooms.set(frame.room, room);
  }
  if (!frame.mentioned && room.kind !== 'direct') return;
  const found = await messageOf(companyId, frame);
  if (!found || found.message.author.principal === me || !found.message.body) return;
  const author = found.message.author;
  const words = found.message.body.replace(/\s+/g, ' ').trim();
  let notice: Notification;
  try {
    notice = new Notification(
      t('{name} in {room}', { name: 'former' in author ? author.name : nameOf(author as { principal: string; name?: string | null }), room: roomName(room, me) }),
      { body: words.length > MOST ? `${words.slice(0, MOST - 1)}…` : words, tag: frame.room },
    );
  } catch (error) {
    // Refused from a page (Chrome on Android): said in the profile from now on, rather than failing silently.
    if (error instanceof TypeError) refused = true;
    return;
  }
  notice.onclick = () => {
    window.focus();
    go({ kind: 'company', companyId, page: 'rooms', section: 'company', item: found.threadOf ? `${frame.room}~${found.threadOf}` : frame.room });
    notice.close();
  };
}

/**
 * The message a frame names, read as the person: from the room, where it is
 * shown there, or else from the thread it was written in, which the person's
 * own Activity names when the message named them.
 */
async function messageOf(companyId: string, frame: Change): Promise<Found | null> {
  const page: MessagePage = await api('GET', `/api/companies/${companyId}/rooms/${frame.room}/messages?around=${frame.position}&limit=1`);
  const inRoom = page.messages.find((one) => one.id === frame.ref);
  if (inRoom) return { message: inRoom, threadOf: inRoom.threadOf };
  const { items }: { items: ActivityItem[] } = await api('GET', `/api/companies/${companyId}/me/activity`);
  const named = items.find((item) => 'messageId' in item && item.messageId === frame.ref);
  if (!named || !('threadOf' in named) || !named.threadOf) return null;
  const thread: ThreadView = await api('GET', `/api/companies/${companyId}/rooms/${frame.room}/threads/${named.threadOf}`);
  const reply = thread.replies.find((one) => one.id === frame.ref);
  return reply ? { message: reply, threadOf: named.threadOf } : null;
}
