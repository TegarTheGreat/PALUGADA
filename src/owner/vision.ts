/**
 * The vision half of the vision and plan page (F18.10): which paragraphs of
 * the company's charter are its vision.
 *
 * There is no table for a vision. The company charter (SOUL.md) is already
 * what the owner writes about what the company is for, and every run reads it
 * first, so a vision kept anywhere else would be a second text that runs never
 * see. The console's charter editor offers an outline of six headings, after
 * the vision half of the one-page plan the operating methods share (STATUS
 * 2.189), in plain names: our values, purpose and niche, the long-range
 * target, who we serve and what makes us different, where we will be in three
 * years, and our promise. The owner fills them in their own words. This reads
 * the published charter back by those headings.
 *
 * The headings are words, and the owner writes them in the language the
 * console is drawn in, so they are found in every language the company uses
 * (`languagesFor`), the console's, and English. The console writes the same
 * words this file says (console/src/vision.ts, held to these translations by
 * test/acceptance/plan.test.ts), so an outline inserted in any language is
 * read back.
 */
import { say } from './say.ts';

/** The outline's parts, in its order. */
export const VISION_PARTS = ['values', 'purpose_and_niche', 'long_range_target', 'who_we_serve', 'three_years', 'promise'] as const;
export type VisionPart = (typeof VISION_PARTS)[number];

/** A part's heading in a language, English where the platform has none. */
export function visionHeading(language: string | null, part: VisionPart): string {
  switch (part) {
    case 'values': return say(language, 'Our values');
    case 'purpose_and_niche': return say(language, 'Purpose and niche');
    case 'long_range_target': return say(language, 'Long-range target');
    case 'who_we_serve': return say(language, 'Who we serve and what makes us different');
    case 'three_years': return say(language, 'Where we will be in three years');
    case 'promise': return say(language, 'Our promise');
  }
}

export interface VisionSection {
  part: VisionPart;
  /** The heading as the owner wrote it. */
  heading: string;
  /** What is under it, up to the next heading of its level or above; empty while the owner has not filled it in. */
  text: string;
}

/**
 * A heading as it is compared: case, spacing and a closing colon are the
 * owner's typing, not a different heading. Turkish's dotless i folds to i, so
 * a heading typed in capitals there still reads as the same words.
 */
function comparable(heading: string): string {
  return heading.normalize('NFKC').toLowerCase().replace(/ı/g, 'i').replace(/\s+/g, ' ').replace(/\s*[:：]$/, '').trim();
}

/**
 * The charter's vision sections, in the charter's order: each Markdown
 * heading that is one of the outline's, in English or one of `languages`,
 * with what is under it. A heading inside a fenced block is the charter
 * quoting something, not a heading. Empty when the charter has none of them.
 */
export function visionSectionsOf(charter: string, languages: readonly string[]): VisionSection[] {
  const parts = new Map<string, VisionPart>();
  for (const language of ['en', ...languages]) {
    for (const part of VISION_PARTS) parts.set(comparable(visionHeading(language, part)), part);
  }
  const lines = charter.replace(/\r\n?/g, '\n').split('\n');
  const headings: Array<{ line: number; level: number; text: string }> = [];
  let fenced = false;
  lines.forEach((line, index) => {
    if (/^\s{0,3}(```|~~~)/.test(line)) fenced = !fenced;
    if (fenced) return;
    const match = /^\s{0,3}(#{1,6})[ \t]+(.+?)[ \t]*#*[ \t]*$/.exec(line);
    if (match) headings.push({ line: index, level: match[1]!.length, text: match[2]!.trim() });
  });
  const sections: VisionSection[] = [];
  headings.forEach((heading, index) => {
    const part = parts.get(comparable(heading.text));
    if (!part) return;
    // Up to the next heading of its level or above, so the owner's own
    // subheadings under a part stay with it.
    const end = headings.slice(index + 1).find((next) => next.level <= heading.level)?.line ?? lines.length;
    sections.push({ part, heading: heading.text, text: lines.slice(heading.line + 1, end).join('\n').trim() });
  });
  return sections;
}
