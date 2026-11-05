/**
 * The vision outline the charter editor offers (F18.10): six headings the
 * owner fills in their own words, after the vision half of the one-page plan
 * the operating methods share, under plain names (STATUS 2.189).
 *
 * The Plan page reads the vision back from the published charter by these
 * headings (src/owner/vision.ts), in every language the console is drawn in,
 * as missingParts below counts them. So the headings are the server's parts, in its order, and each
 * dictionary writes them exactly as the server's dictionary does, which
 * test/acceptance/plan.test.ts holds. The hints are said beside the editor and
 * never written into the charter: every run reads the charter, and a hint
 * left in it would be an instruction to every agent.
 */
import { everyTranslation, N, t } from './i18n.ts';

export interface VisionOutlinePart { part: string; heading: string; hint: string }

export const VISION_OUTLINE: readonly VisionOutlinePart[] = [
  { part: 'values', heading: N('Our values'), hint: N('Three to seven behaviours the company keeps, even when they cost it something.') },
  { part: 'purpose_and_niche', heading: N('Purpose and niche'), hint: N('Why the company exists, and the one thing it means to be the best at.') },
  { part: 'long_range_target', heading: N('Long-range target'), hint: N('Where the company means to be in ten to twenty-five years, in one sentence.') },
  { part: 'who_we_serve', heading: N('Who we serve and what makes us different'), hint: N('The customers it serves, and the few things that make it different for them.') },
  { part: 'three_years', heading: N('Where we will be in three years'), hint: N('A date three years from now, the revenue and profit by then, three to five measures, and what is true then, written in the present tense.') },
  { part: 'promise', heading: N('Our promise'), hint: N('What every customer can count on.') },
];

/** The outline as the charter gets it: each heading in the owner's language, with room under it. */
export function outlineText(parts: readonly VisionOutlinePart[] = VISION_OUTLINE): string {
  return parts.map((one) => `## ${t(one.heading)}\n\n`).join('');
}

/**
 * A heading as it is compared, by the server's rule (comparable() in
 * src/owner/vision.ts): case, spacing, a closing colon and Turkish's two i's
 * are the owner's typing, not a different heading.
 */
function comparable(heading: string): string {
  return heading.normalize('NFKC').toLowerCase().replace(/\u0307/g, '').replace(/ı/g, 'i')
    .replace(/\s+/g, ' ').replace(/\s*[:：]$/, '').trim();
}

/**
 * The outline's parts a charter has no heading for, in the outline's order.
 * A heading counts in any language the console is drawn in, not only the one
 * it is drawn in now: an outline filled in while the console was in
 * Indonesian is not missing because the owner has since switched to English.
 * A heading inside a fenced block is the charter quoting something, as the
 * server reads it, so it does not count.
 */
export function missingParts(charter: string): VisionOutlinePart[] {
  const written = new Set<string>();
  let fenced = false;
  for (const line of charter.replace(/\r\n?/g, '\n').split('\n')) {
    if (/^\s{0,3}(```|~~~)/.test(line)) fenced = !fenced;
    if (fenced) continue;
    const heading = /^\s{0,3}#{1,6}[ \t]+(.+?)[ \t]*#*[ \t]*$/.exec(line)?.[1];
    if (heading) written.add(comparable(heading));
  }
  return VISION_OUTLINE.filter((one) => !everyTranslation(one.heading).some((heading) => written.has(comparable(heading))));
}
