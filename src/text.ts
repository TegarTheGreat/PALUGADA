/**
 * Text that is cut short: where it is cut matters.
 *
 * `slice` counts UTF-16 units, so a cut can fall between the two halves of one
 * character (an emoji, a rare ideograph) and leave half of it. A lone half is
 * not text: PostgreSQL refuses it in a `jsonb` column, a model provider may
 * refuse the request that holds it, and a task that cannot be stored is looked
 * for again on every tick.
 */

/** A lone surrogate: a high half with no low half after it, or a low half with no high half before it. */
const LONE_SURROGATE = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/g;

/** `text` with each lone half of a surrogate pair replaced by U+FFFD, as `String.prototype.toWellFormed` does. */
export function wellFormed(text: string): string {
  return text.replace(LONE_SURROGATE, '�');
}
