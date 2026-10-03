/**
 * What the owner reads when work stops because its budget ran out
 * (PRD section 6.3: halted, to the inbox, never resumed automatically).
 *
 * Composed here, beside the rest of what the platform says to the owner,
 * because the item is the platform's and not an agent's: it is written in
 * the owner's panel language (src/owner/say.ts), where an agent's words are
 * left in the company's talk language.
 */
import { say } from './say.ts';

export interface BudgetHaltFacts {
  /**
   * The account that has no room left, by what it covers (`ACCOUNT_NAME`):
   * a division's name, the owner's own label, or null for the whole
   * company, which is said in the owner's language rather than as the
   * platform's code for it (§2.3 item 7).
   */
  account: string | null;
  /** What the work was, as one line. */
  work: string;
  spent: number;
  max: number;
}

/** The item's title and its body, in `language`; English when it is unset. */
export function budgetHaltWords(language: string | null, facts: BudgetHaltFacts): { title: string; rationale: string } {
  const number = (value: number) => new Intl.NumberFormat(language ?? 'en').format(value);
  const account = facts.account ?? say(language, 'company');
  return {
    title: say(language, 'Work stopped: the {account} account is out of tokens', { account }),
    rationale: say(language,
      '"{work}" stopped because the {account} account has used {spent} of its {max} tokens. Raise its ceiling under Money, then open the task and press Continue: it carries on from where it stopped.',
      { work: facts.work, account, spent: number(facts.spent), max: number(facts.max) }),
  };
}
