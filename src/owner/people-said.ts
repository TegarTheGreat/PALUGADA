/**
 * What a person is told outside the console about their people's notices
 * (F19.13, F19.20; STATUS section 2.213), in their own language.
 *
 * A notice says who and where: a colleague's name with their handle beside
 * it, and the room, never the words -- an excerpt is added beside the
 * sentence only where a link's share is `content`, by whoever builds the
 * notice. Kept here, a top-level `src/owner/` file, where the sentence test
 * finds every `say()` (test/acceptance/owner-channels.test.ts).
 */
import { say } from './say.ts';

/** Who wrote: the owner, drawn as the owner, or a colleague by the name the owner gave them and their handle. */
export function whoSaid(language: string | null, author: { principal: string; name: string | null; handle: string | null }): string {
  if (author.principal === 'owner') return say(language, 'The owner');
  const name = author.name ?? '';
  return author.handle ? `${name} (@${author.handle})` : name;
}

/**
 * A notice about words in a room. A direct conversation has no name, so it
 * is said as words to the person; several in one room in ten minutes are
 * said as how many.
 */
export function roomNoticeSaid(
  language: string | null,
  notice: { reason: 'direct' | 'mention' | 'reply'; who: string; room: string | null; count: number },
): string {
  if (notice.room === null) return say(language, '{name} wrote to you.', { name: notice.who });
  if (notice.count > 1) return say(language, 'New in {room}: {count}.', { room: notice.room, count: String(notice.count) });
  if (notice.reason === 'mention') return say(language, '{name} mentioned you in {room}.', { name: notice.who, room: notice.room });
  if (notice.reason === 'reply') return say(language, '{name} replied in a thread you follow in {room}.', { name: notice.who, room: notice.room });
  return say(language, '{name} wrote to you.', { name: notice.who });
}

/** A run's question put to the person. */
export function questionSaid(language: string | null, role: string): string {
  return say(language, 'A question for you from {role}.', { role });
}

/** An approval the person may decide: its room named only to someone who can see the room. */
export function approvalSaid(language: string | null, room: string | null): string {
  return room === null
    ? say(language, 'An approval waits for you.')
    : say(language, 'An approval waits for you in {room}.', { room });
}

/** Work the person asked for, ended: done, or stopped and why. */
export function workSaid(language: string | null, work: { done: boolean; title: string; why: string }): string {
  return work.done
    ? say(language, 'The work you asked for is done: {title}.', { title: work.title })
    : say(language, 'The work you asked for stopped: {why}.', { why: work.why });
}

/** Any notice at the `signal` share, which says only that something happened. */
export function somethingNewSaid(language: string | null): string {
  return say(language, 'Something new in PALUGADA.');
}

/** The day's first notice, when the day before went past the person's daily number. */
export function moreYesterdaySaid(language: string | null, count: number): string {
  return say(language, 'And more yesterday: {count}.', { count: String(count) });
}

/** What a relay is answered when a press it carried decided an item. */
export function decidedThroughSaid(language: string | null, relay: string): string {
  return say(language, 'Decided through {relay}.', { relay });
}

/** What a relay is answered for a press at tier 3, which no relay decides (F10.10). */
export function tierThreeSaid(language: string | null, relay: string): string {
  return say(language, 'Tier 3 is decided in the app, not through {relay}.', { relay });
}

/** The words on a button a notice about a room carries. */
export function roomOfferLabel(language: string | null, act: 'reply' | 'read' | 'mute'): string {
  if (act === 'reply') return say(language, 'Reply');
  if (act === 'read') return say(language, 'Mark read');
  return say(language, 'Mute');
}
