/**
 * Every area's sentences, joined per language, for each sentence file in `../`
 * to spread. The areas are the people's workspace's features (F19), each in
 * its own file so that features built side by side never write the same lines
 * of twenty files; every area is listed here once, before any of them has
 * sentences, so that a feature adds its sentences to its own file alone.
 */
import { WORDS } from './words.ts';
import { TALK } from './talk.ts';
import { WORKSPACE } from './workspace.ts';
import { RELAY } from './relay.ts';
import { PEOPLE } from './people.ts';
import { LIVE } from './live.ts';
import { MEETINGS } from './meetings.ts';
import { FIND } from './find.ts';
import { NOTICES } from './notices.ts';
import { IMPORT } from './import.ts';
import { MEET } from './meet.ts';

/** The languages the platform speaks beside English: the console's (`say.ts`). */
export type SentenceLanguage =
  | 'id' | 'ms' | 'jv' | 'su' | 'tl' | 'vi' | 'th' | 'zh' | 'ja' | 'ko'
  | 'hi' | 'ar' | 'es' | 'pt-BR' | 'fr' | 'de' | 'nl' | 'it' | 'tr' | 'ru';

/** One feature's sentences in every language, keyed by their English. */
export type SentenceArea = Readonly<Record<SentenceLanguage, Readonly<Record<string, string>>>>;

const AREAS: readonly SentenceArea[] = [
  WORDS, TALK, WORKSPACE, RELAY, PEOPLE, LIVE, MEETINGS, FIND, NOTICES, IMPORT, MEET,
];

/** Every area's sentences in one language. */
export function areaSentences(language: SentenceLanguage): Readonly<Record<string, string>> {
  return Object.assign({}, ...AREAS.map((area) => area[language])) as Record<string, string>;
}
