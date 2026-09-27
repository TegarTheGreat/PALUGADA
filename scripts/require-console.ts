/**
 * Run by npm before `npm test`: the suite serves the built console, and
 * without it three tests fail on their own terms -- a 404, a boot that finds
 * no page, a path the guide names -- which say nothing of the one step
 * missing. `npm run check` builds the console first, so it never stops here.
 */
import { existsSync } from 'node:fs';

if (!existsSync(new URL('../console/dist/index.html', import.meta.url))) {
  process.stderr.write(
    'palugada: the console is not built, and the suite serves it: run `npm run console:build` first, '
      + 'or `npm run check`, which builds it and runs everything.\n',
  );
  process.exit(1);
}
