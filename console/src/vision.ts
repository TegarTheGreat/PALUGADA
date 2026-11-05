/**
 * The vision outline the charter editor offers (F18.10): six headings the
 * owner fills in their own words, after the vision half of the one-page plan
 * the operating methods share, under plain names (STATUS 2.189).
 *
 * The Plan page reads the vision back from the published charter by these
 * headings (src/owner/vision.ts), in the company's languages and the
 * console's. So the headings are the server's parts, in its order, and each
 * dictionary writes them exactly as the server's dictionary does, which
 * test/acceptance/plan.test.ts holds. The hints are said beside the editor and
 * never written into the charter: every run reads the charter, and a hint
 * left in it would be an instruction to every agent.
 */
import { N, t } from './i18n.ts';

export const VISION_OUTLINE: ReadonlyArray<{ part: string; heading: string; hint: string }> = [
  { part: 'values', heading: N('Our values'), hint: N('Three to seven behaviours the company keeps, even when they cost it something.') },
  { part: 'purpose_and_niche', heading: N('Purpose and niche'), hint: N('Why the company exists, and the one thing it means to be the best at.') },
  { part: 'long_range_target', heading: N('Long-range target'), hint: N('Where the company means to be in ten to twenty-five years, in one sentence.') },
  { part: 'who_we_serve', heading: N('Who we serve and what makes us different'), hint: N('The customers it serves, and the few things that make it different for them.') },
  { part: 'three_years', heading: N('Where we will be in three years'), hint: N('A date three years from now, the revenue and profit by then, three to five measures, and what is true then, written in the present tense.') },
  { part: 'promise', heading: N('Our promise'), hint: N('What every customer can count on.') },
];

/** The outline as the charter gets it: each heading in the owner's language, with room under it. */
export function outlineText(): string {
  return VISION_OUTLINE.map((one) => `## ${t(one.heading)}\n\n`).join('');
}

/** Whether a charter already has every heading of the outline, in the language the console is drawn in. */
export function hasOutline(charter: string): boolean {
  const headings = new Set(charter.split('\n')
    .map((line) => /^\s{0,3}#{1,6}[ \t]+(.+?)[ \t]*#*[ \t]*$/.exec(line)?.[1]?.trim().toLowerCase())
    .filter(Boolean));
  return VISION_OUTLINE.every((one) => headings.has(t(one.heading).toLowerCase()));
}
