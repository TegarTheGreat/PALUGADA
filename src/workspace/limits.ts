/**
 * How often one person may write in the rooms, and what a reaction may be
 * (F19.4, F19.5, F19.14; STATUS section 2.217).
 *
 * Posting a message had its rate (`room.too_fast`, thirty a minute, in
 * `messages.ts`); every other write of the workspace had none, so one seat --
 * a viewer too -- could make forty rooms that sat joined in colleagues'
 * rails, pin three hundred "reactions" under a message, or keep a revision a
 * second; and joining and leaving a room, which take the company's room
 * clock and tell every console, could be sent without end, keeping every
 * post of the company waiting behind them. Each write is held here to a
 * number a minute for each person, as a message is, and refused by name
 * (`workspace.too_fast`) past it.
 *
 * Counted in this process, like a message's rate: a person spreading their
 * writes over replicas reaches a few times the limit, not a flood, and no
 * row is written to count it.
 */
import { PalugadaError } from '../errors.ts';

/** Each write, and how many of it one person makes a minute. */
export const WRITES_PER_MINUTE = {
  /** A topic room made. */
  room: 5,
  /** A direct conversation opened. */
  direct: 10,
  /** Someone added to or taken out of a private room. */
  members: 10,
  /** A reaction put on or taken off. */
  react: 30,
  /** A message pinned or unpinned. */
  pin: 10,
  /** A message edited, each edit keeping the words before it for a day, or removed. */
  edit: 20,
  /** A room joined or left. */
  join: 20,
  /** A room's name, what it is about or the work it shows changed, or the room archived. */
  change: 10,
  /** How a room tells the person (its notices, or quiet until a time), or a thread followed or not. */
  place: 60,
  /** A room or a thread read up to a message: sent as the person reads, a second after the newest is in view. */
  read: 120,
  /** The person's own profile: handle, picture, language, quiet hours, notices a day. */
  profile: 10,
  /** A search of the rooms, which reads what the person may see until it has a page. */
  search: 30,
  /** A people's meeting set, moved, changed or cancelled. */
  meeting: 20,
  /** An import begun, or an old author linked or unlinked. */
  import: 10,
} as const;

export type Write = keyof typeof WRITES_PER_MINUTE;

/**
 * The owner is held to ten times a seat's number: the owner sets a company's
 * rooms up, imports its history and links its people at their own pace, and
 * a runaway script in the owner's tab is still stopped.
 */
const OWNER_TIMES = 10;

/** What each write is called in a refusal. */
const SAID: Readonly<Record<Write, string>> = {
  room: 'rooms made',
  direct: 'direct conversations opened',
  members: 'changes to who is in a room',
  react: 'reactions',
  pin: 'pins',
  edit: 'edits and removals',
  join: 'rooms joined or left',
  change: 'changes to a room',
  place: 'changes to how a room or a thread tells you',
  read: 'read marks',
  profile: 'changes to a profile',
  search: 'searches',
  meeting: 'meetings set or changed',
  import: 'import steps',
};

const recent = new Map<string, number[]>();

/**
 * Counts one write of `who`'s, or refuses it when they have made the
 * minute's number already. A refused write is not counted. Each caller asks
 * once the request is whole and before the database is, so a malformed
 * request spends nothing.
 */
export function holdToMinute(who: { companyId: string; person: { principal: string } }, write: Write, now = Date.now()): void {
  const most = WRITES_PER_MINUTE[write] * (who.person.principal === 'owner' ? OWNER_TIMES : 1);
  const key = `${who.companyId}:${who.person.principal}:${write}`;
  const kept = (recent.get(key) ?? []).filter((at) => now - at < 60_000);
  if (kept.length >= most) {
    recent.set(key, kept);
    throw new PalugadaError('workspace.too_fast', `slow down: at most ${most} ${SAID[write]} a minute`, { write, perMinute: most });
  }
  kept.push(now);
  recent.set(key, kept);
  // Forgotten once quiet, so the map holds only who wrote in the last minute.
  if (recent.size > 10_000) {
    for (const [counted, times] of recent) if (now - (times.at(-1) ?? 0) >= 60_000) recent.delete(counted);
  }
}

/**
 * One emoji, as Unicode lists them (`\p{RGI_Emoji}`), in its emoji form: a
 * symbol sent in its text form (❤ for ❤️) is taken as the emoji it is.
 * Anything else -- a word, a tag, two emoji, a direction override, nothing
 * visible -- is refused (`reaction.not_emoji`): a reaction is never words,
 * and words pinned under a colleague's message as one read as a verdict on
 * it. The database holds the same shape (0161).
 */
export function reactionOf(value: unknown): string {
  const emoji = typeof value === 'string' ? value : '';
  if (emoji.length >= 1 && emoji.length <= 32) {
    if (RGI_EMOJI.test(emoji)) return emoji;
    if (RGI_EMOJI.test(`${emoji}️`)) return `${emoji}️`;
  }
  throw new PalugadaError('reaction.not_emoji', 'a reaction is one emoji', { field: 'emoji' });
}

// Built at run time: the `v` flag is newer than the type checker's target, and every Node this runs on reads it.
const RGI_EMOJI = new RegExp('^\\p{RGI_Emoji}$', 'v');

/**
 * Whether a reaction already written -- in an archive, or by an import --
 * is one the database keeps (0161): one emoji, in either form, or for an
 * old Slack author the name of a custom emoji, which no Unicode emoji draws.
 * A restore leaves out the rest rather than fail on them.
 */
export function keptReaction(emoji: unknown, principal: unknown): boolean {
  if (typeof emoji !== 'string') return false;
  if (typeof principal === 'string' && principal.startsWith('former:') && SHORTCODE.test(emoji)) return true;
  try {
    reactionOf(emoji);
    return true;
  } catch {
    return false;
  }
}

/** A custom emoji's name as Slack writes it, between colons. */
export const SHORTCODE = /^:[a-z0-9_+'-]{1,30}:$/;

/** How many different reactions one person puts on one message, at most. */
export const REACTIONS_PER_PERSON = 10;
