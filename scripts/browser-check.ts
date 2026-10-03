/**
 * The companies' browser started as the platform starts it -- with its
 * sandbox -- where it will run: in CI's docker job, inside the image, under
 * the profile docker-compose.yml gives it (deploy/docker/seccomp-chromium.json).
 *
 * A browser that starts proves little: Chromium told to go without its
 * sandbox starts too. So this passes only when a page has rendered in a
 * process in a user namespace other than this one's, which is the sandbox
 * Chromium puts its renderers in, and fails, saying what it saw, otherwise.
 *
 *   node scripts/browser-check.ts
 */
import { readdirSync, readFileSync, readlinkSync } from 'node:fs';
import { Cdp } from '../src/browser/cdp.ts';
import { findChromium } from '../src/browser/chromium.ts';

const executable = findChromium(process.env);
if (!executable) {
  console.error('no Chromium here: the image was built without it (PALUGADA_BROWSER=0), or PALUGADA_CHROMIUM names none');
  process.exit(1);
}

const cdp = await Cdp.launch(executable, { sandbox: true });
try {
  const { targetId } = await cdp.send<{ targetId: string }>('Target.createTarget', {
    url: 'data:text/html,<title>sandboxed</title><p>PALUGADA</p>',
  });
  const { sessionId } = await cdp.send<{ sessionId: string }>('Target.attachToTarget', { targetId, flatten: true });
  let title = '';
  for (let tries = 0; tries < 50 && title !== 'sandboxed'; tries += 1) {
    const answer = await cdp.send<{ result: { value?: string } }>('Runtime.evaluate',
      { expression: 'document.title', returnByValue: true }, sessionId);
    title = answer.result.value ?? '';
    if (title !== 'sandboxed') await new Promise((resolve) => setTimeout(resolve, 100));
  }
  const own = readlinkSync('/proc/self/ns/user');
  const renderers = readdirSync('/proc').filter((name) => /^\d+$/.test(name)).filter((pid) => {
    try {
      return readFileSync(`/proc/${pid}/cmdline`, 'utf8').includes('--type=renderer');
    } catch {
      return false;
    }
  });
  const apart = renderers.filter((pid) => {
    try {
      return readlinkSync(`/proc/${pid}/ns/user`) !== own;
    } catch {
      return false;
    }
  });
  console.log(`${executable}: the page rendered ${title === 'sandboxed' ? 'yes' : 'no'}; `
    + `${renderers.length} renderer${renderers.length === 1 ? '' : 's'}, ${apart.length} in a user namespace of its own`);
  if (title !== 'sandboxed' || apart.length === 0) process.exitCode = 1;
} finally {
  await cdp.close();
}
