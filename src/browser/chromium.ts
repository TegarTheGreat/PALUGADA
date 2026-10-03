/**
 * Where this machine's Chromium is: the one `PALUGADA_CHROMIUM` names, else
 * the first of the places a package manager or Playwright puts one. Chrome
 * does as well; it is the same browser.
 */
import { existsSync } from 'node:fs';

const PLACES = [
  '/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/lib/chromium/chromium', '/snap/bin/chromium',
  '/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/opt/pw-browsers/chromium',
  '/Applications/Chromium.app/Contents/MacOS/Chromium', '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
];

/** The executable, or null; a name in `PALUGADA_CHROMIUM` that is not there is null too, not a guess elsewhere. */
export function findChromium(env: NodeJS.ProcessEnv): string | null {
  const named = env.PALUGADA_CHROMIUM?.trim();
  if (named) return existsSync(named) ? named : null;
  return PLACES.find((place) => existsSync(place)) ?? null;
}
