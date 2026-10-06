/**
 * The language a company's CEO talks to its owner in.
 *
 * The company's talk language -- the one every other agent writes to the owner
 * in, which is the owner's panel language unless the owner said otherwise
 * (src/domain/language.ts). The panel's alone is not it: an owner who had
 * chosen Indonesian for the company was greeted in English because the *panel*
 * had never been told.
 */
import { withTenant } from '../db/tenant.ts';
import { deploymentLanguages, languagesFor } from '../domain/language.ts';
import { canSay } from './say.ts';

/** What the company's agents write to its owner in. */
export async function talkLanguageOf(companyId: string): Promise<string> {
  return (await withTenant(companyId, (tx) => languagesFor(tx, companyId))).talk;
}

/**
 * The language the platform can say its own sentences to the owner in, for a
 * CEO that speaks first: the company's talk language where the platform has
 * sentences of its own in it, and the panel's where it has not (Portuguese,
 * which agents are told, and the platform says only in Brazil's).
 */
export async function ceoSaysIn(companyId: string): Promise<string> {
  const talk = await talkLanguageOf(companyId);
  return canSay(talk) ? talk : (await deploymentLanguages()).console ?? 'en';
}
