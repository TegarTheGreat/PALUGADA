/**
 * Who can read a room, said where it is read (F19.15; STATUS 2.207): one
 * sentence in the header of a private room and of a direct conversation,
 * and in its details. The server names which (`Room.disclosure`); the words
 * are the console's, in the reader's language.
 */
import { N, t } from '../i18n.ts';
import type { Room } from './types.ts';

const SAID: Record<string, string> = {
  open: N('Everyone in the company can read this room.'),
  private: N('Private: its members and the owner can read it.'),
  direct: N('Direct messages are part of the company\'s records; the owner\'s export includes them, and the owner keeps earlier words of an edited message. Messages to someone who linked a phone also go to that phone\'s relay.'),
};

export function disclosureOf(room: Pick<Room, 'disclosure'>): string {
  return t(SAID[room.disclosure] ?? SAID.open!);
}
