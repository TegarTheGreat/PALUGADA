/**
 * Every area's sentences, joined per language, for each dictionary in `../` to
 * spread. The areas are the people's workspace's features (F19), each in its
 * own file so that features built side by side never write the same lines;
 * every area is listed here once, before any of them has sentences, so that a
 * feature adds its sentences to its own file and to nothing else.
 */
import type { Area, Dictionary, LanguageCode } from '../types.ts';
import { GROUND } from './ground.ts';
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
import { POLISH } from './polish.ts';

/** Every area, by its file's name: `console-i18n.test.ts` checks the list against the folder. */
export const AREAS: Readonly<Record<string, Area>> = {
  ground: GROUND,
  words: WORDS,
  talk: TALK,
  workspace: WORKSPACE,
  relay: RELAY,
  people: PEOPLE,
  live: LIVE,
  meetings: MEETINGS,
  find: FIND,
  notices: NOTICES,
  import: IMPORT,
  meet: MEET,
  polish: POLISH,
};

/** Every area's sentences in one language. */
export function areaSentences(code: LanguageCode): Dictionary {
  return Object.assign({}, ...Object.values(AREAS).map((area) => area[code].dictionary)) as Dictionary;
}

/** What every area keeps in English in one language: names, as each dictionary's `KEPT`. */
export function areaKept(code: LanguageCode): readonly string[] {
  return Object.values(AREAS).flatMap((area) => area[code].kept);
}
