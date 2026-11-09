/**
 * What a relay is given to show a person, in that person's language (F19.19,
 * F19.20; STATUS section 2.208).
 *
 * A relay that renders nothing of its own -- ntfy, a plain push -- shows the
 * envelope's `text`, so every envelope carries a platform sentence. At the
 * `signal` share it says only that something happened; above it, the same
 * headings the owner's push and chat already use. The buttons' words are
 * the chat's own. Kept here, a top-level `src/owner/` file, where the
 * sentence test finds every `say()` (test/acceptance/owner-channels.test.ts).
 */
import { say } from './say.ts';

/** The words on an offer's button. */
export function offerLabel(language: string | null, act: 'approve' | 'deny' | 'answer'): string {
  if (act === 'approve') return say(language, 'Approve');
  if (act === 'deny') return say(language, 'Deny');
  return say(language, 'Answer');
}

/** What an item's notice says, at the share it is sent at. */
export function itemSaid(
  language: string | null,
  share: 'signal' | 'summary' | 'content',
  item: { kind: string; title: string; urgent: boolean },
): string {
  if (share === 'signal') {
    return item.urgent ? say(language, 'Something urgent needs you in PALUGADA.') : say(language, 'Something new needs you in PALUGADA.');
  }
  if (item.kind === 'incident') return say(language, 'Incident: {title}', { title: item.title });
  if (item.kind === 'approval') return say(language, 'Approval needed: {title}', { title: item.title });
  return item.title;
}

/** What a closed item's notice says at `signal`, where why it closed is not told. */
export function closedSaid(language: string | null): string {
  return say(language, 'This no longer needs you.');
}

/** Work the owner gave has finished, at `signal`. */
export function doneSaid(language: string | null): string {
  return say(language, 'Work you gave has finished.');
}

/** A day's digest, at `signal` and at `summary`. */
export function digestSaid(language: string | null, company: string | null): string {
  return company === null
    ? say(language, 'Your daily digest from PALUGADA is ready.')
    : say(language, 'Daily digest for {company}', { company });
}

/** A relay's test, which the owner presses to see the relay hears this deployment. */
export function pingSaid(language: string | null): string {
  return say(language, 'A test from PALUGADA: this relay is paired and hears this deployment.');
}

/** A phone just linked. */
export function linkedSaid(language: string | null): string {
  return say(language, 'This phone is linked to PALUGADA.');
}
