/**
 * What waits for the person in each company they may see (F19.10): read
 * from `/api/rooms/unread` on the console's 30-second beat and whenever a
 * room is read, and drawn as the Rooms badge, the company menu's, the
 * phone's tab, the tab's title and, for the owner, the inbox's. Nothing is
 * counted or kept in the browser, so a reload shows what the server says.
 */
import { api } from '../api.ts';
import { useLoad } from '../hooks.ts';
import type { Unread } from './types.ts';

export function useUnread() {
  return useLoad<Unread[]>(async () => {
    const answer: { unread: Unread[] } = await api('GET', '/api/rooms/unread');
    return answer.unread;
  }, [], { every: 30_000 });
}

/**
 * The badge: what is addressed to the person, their unseen mentions and the
 * unread messages of direct rooms they have not muted. Rooms with something
 * new are drawn bold rather than counted.
 */
export function badgeOf(unread: Unread | undefined): number {
  return unread ? unread.mentions + unread.direct : 0;
}
