/**
 * Where the owner API's routes are written: `src/owner/api.ts`, and the route
 * modules in `src/owner/routes/`, one per area of the people's workspace, which
 * `#buildRoutes` spreads beside the API's own. The tests that read routes out
 * of the source -- which the console presses, which a seat may reach, which the
 * assistant may propose -- read them all through here, so a route written in a
 * module is held to every rule a route in `api.ts` is.
 *
 * A route is written as `method: 'X',` with `pattern: '…',` on the next line,
 * and an open route says `open: true,` on the line after that: the form every
 * one of those tests reads.
 */
import { readdir, readFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const ROUTE_MODULES = join(ROOT, 'src', 'owner', 'routes');

/** Every file routes are written in, by its path from the repository's root, with its text. */
export async function routeFiles(): Promise<Map<string, string>> {
  const files = new Map<string, string>();
  files.set('src/owner/api.ts', await readFile(join(ROOT, 'src', 'owner', 'api.ts'), 'utf8'));
  for (const name of (await readdir(ROUTE_MODULES)).sort()) {
    if (!name.endsWith('.ts')) continue;
    files.set(relative(ROOT, join(ROUTE_MODULES, name)), await readFile(join(ROUTE_MODULES, name), 'utf8'));
  }
  return files;
}

/** The text of every file routes are written in, joined: what a route test reads with its own pattern. */
export async function routeSource(): Promise<string> {
  return [...(await routeFiles()).values()].join('\n');
}
