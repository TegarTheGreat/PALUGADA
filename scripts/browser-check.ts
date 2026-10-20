/**
 * The companies' browser started as the platform starts it -- with its
 * sandbox -- where it will run: in CI's docker job, inside the image, under
 * the profile docker-compose.yml gives it (deploy/docker/seccomp-chromium.json).
 *
 * A browser that starts proves little: Chromium told to go without its
 * sandbox starts too. So this passes only when a page has rendered in a
 * process in a user namespace other than this one's, which is the sandbox
 * Chromium puts its renderers in, and fails, saying what it saw, otherwise.
 * Then it reads a PDF the way `files.read` does (`Browsers.convert`), which
 * needs pdf.js where the console's build put it.
 *
 *   node scripts/browser-check.ts
 */
import { readdirSync, readFileSync, readlinkSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Browsers } from '../src/browser/browsers.ts';
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

/** One page saying PALUGADA, its offsets counted. */
function onePagePdf(): Buffer {
  const stream = 'BT /F1 18 Tf 20 150 Td (PALUGADA) Tj ET';
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 200] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];
  let pdf = '%PDF-1.4\n';
  const offsets = objects.map((body, i) => {
    const at = pdf.length;
    pdf += `${i + 1} 0 obj\n${body}\nendobj\n`;
    return at;
  });
  const xref = pdf.length;
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map((at) => `${String(at).padStart(10, '0')} 00000 n \n`).join('')}`;
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(pdf, 'latin1');
}

const reader = fileURLToPath(new URL('../console/dist/reader', import.meta.url));
const browsers = new Browsers({ executable, sandbox: true, reader, cookies: { load: async () => [], save: async () => false } });
try {
  const read = await browsers.convert('pdf', onePagePdf());
  const said = 'text' in read ? read.text : read.failure;
  console.log(`a PDF read in it: ${said === 'PALUGADA' ? 'yes' : `no (${said})`}`);
  if (said !== 'PALUGADA') process.exitCode = 1;
} finally {
  await browsers.close();
}
