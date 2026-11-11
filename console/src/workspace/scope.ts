/**
 * What every part of the Rooms page shares while a company's rooms are open
 * (STATUS 2.207): who is reading and what they may do, the room on screen,
 * the company's people, and how to open a thread, ask the team about a
 * message or call a meeting about one (STATUS 2.211). Held in memory by the
 * page, never in the browser's storage.
 *
 * Also the few ways a person is said and written, kept in one place so a
 * message, the mention picker and a room's members never disagree: the
 * owner is the owner, by principal, never by a name (F19.21).
 */
import { createContext, useContext } from 'react';
import type { ConsoleContext } from '../App.tsx';
import { t } from '../i18n.ts';
import type { MessageView, Person, PersonRef, Room, RoomListItem } from './types.ts';

export interface Scope {
  ctx: ConsoleContext;
  companyId: string;
  /** The reader's principal: `'owner'` or `'seat:<id>'`. */
  me: string;
  /** The owner, or the seat's kind (F19.8). */
  kind: 'owner' | 'viewer' | 'member' | 'approver';
  /** The room on screen, once read. */
  room: Room | null;
  /** The company's people, the mention picker's and a new conversation's choice. */
  people: Person[];
  /** On a phone: a thread is a sheet, and a long press opens a message's actions. */
  phone: boolean;
  openThread: (messageId: string) => void;
  /**
   * "Ask the team" about a message: the drawer that gives it as work. With no message (`/task` alone) the drawer
   * opens empty, and what is asked in it is posted to the room as the person's words before it is given as work.
   */
  askWork: (message: MessageView | null) => void;
  /**
   * "Call a meeting about this" (STATUS 2.211): the dialog that calls a meeting of the company's agents about a
   * message already kept. Words from the composer are posted first, as "Ask the team" posts them, so cancelling the
   * meeting never loses them.
   */
  callMeeting: (message: MessageView) => void;
  /** Something changed that the rail and the room should read again. */
  changed: () => void;
  /** Counts the changes: what reads the room reads again when it moves. */
  tick: number;
}

export const ScopeContext = createContext<Scope | null>(null);

export function useScope(): Scope {
  const scope = useContext(ScopeContext);
  if (!scope) throw new Error('the rooms\' parts are drawn inside the Rooms page');
  return scope;
}

/** Whether the reader may ask for work, and steer or stop what they asked for (F19.8). */
export function mayAsk(kind: Scope['kind']): boolean {
  return kind !== 'viewer';
}

/** A person's name as the rooms say it: the owner as the owner, a seat by the name the owner gave it. */
export function nameOf(person: { principal: string; name?: string | null }): string {
  if (person.principal === 'owner') return t('Owner');
  return person.name ?? t('Someone');
}

/**
 * What is typed to mention someone, as the server looks for it in the words
 * (STATUS 2.206): `@owner` for the owner, a seat's `@handle`, or `@Name` for
 * a seat that has no handle yet.
 */
export function tokenOf(person: PersonRef): string {
  if (person.principal === 'owner') return '@owner';
  return `@${person.handle ?? person.name ?? ''}`;
}

/** A room's name in the rail and its header: a direct room is the other people in it. */
export function roomName(room: RoomListItem, me: string): string {
  if (room.kind !== 'direct') return room.name ?? '';
  const others = (room.people ?? []).filter((person) => person.principal !== me);
  return others.map((person) => nameOf(person)).join(', ');
}

/** A retry's identity: the same for every attempt at one message, so the server keeps it once. */
export function newClientId(): string {
  if (typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  // An address the browser does not count as secure has no randomUUID; the bytes are as random.
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}
