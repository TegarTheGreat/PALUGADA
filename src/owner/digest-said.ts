/**
 * The daily digest as the owner reads it in a chat (F10.6), in their
 * language (the analysis of 3 October, §2.3 items 3 and 7).
 *
 * It was English whatever the owner read, its spend a bare "0.00" that an
 * Indonesian owner reads as rupiah, and what stopped was the halt's code
 * ("1 task(s) stopped: budget_exhausted"). Amounts are US dollars, written
 * the way the owner's language writes them, as the console writes them. A
 * count stands after a label rather than before a noun, because `say` has no
 * plural forms and "1 of them incidents" is wrong in most languages.
 */
import type { DailyDigest } from '../reporting/digest.ts';
import type { MoneyDisplay } from '../domain/money-display.ts';
import { haltSaid } from './halt-said.ts';
import { say } from './say.ts';

/**
 * Renders the digest as the one screen F10.6 asks for, in `language`. With a
 * currency the owner reads money in (0106), the spend is said in it first and
 * in the dollars it was counted in after, since the rate is only theirs.
 */
export function renderDailyDigest(
  digest: DailyDigest,
  language: string | null | undefined,
  display: MoneyDisplay | null = null,
): string {
  const dollars = (digest.moneySpentCents / 100).toLocaleString(language ?? 'en', { style: 'currency', currency: 'USD' });
  const amount = display ? `${converted(digest.moneySpentCents, language, display)} (${dollars})` : dollars;
  const lines = [
    say(language, 'Digest for {day}', { day: digest.day }),
    say(language, 'Spent: {amount}', { amount }),
    say(language, 'Work: {done} done, {failed} failed, {stopped} stopped', {
      done: String(digest.tasksCompleted), failed: String(digest.tasksFailed), stopped: String(digest.tasksHalted),
    }),
    say(language, 'Inbox: {open} waiting (incidents: {incidents})', {
      open: String(digest.openInboxItems), incidents: String(digest.openIncidents),
    }),
    ...digest.stopped.map((one) => say(language, 'Stopped ({count}): {reason}', {
      count: String(one.count), reason: haltSaid(language, one.reason),
    })),
  ];
  return lines.join('\n');
}

/** An amount in the owner's currency: whole units once it is a hundred of them or more. */
function converted(cents: number, language: string | null | undefined, display: MoneyDisplay): string {
  const value = (cents / 100) * display.rate;
  return value.toLocaleString(language ?? 'en', {
    style: 'currency', currency: display.currency, minimumFractionDigits: 0, maximumFractionDigits: value >= 100 ? 0 : 2,
  });
}
