/**
 * Restores a company from an archive, from a terminal (F16.4).
 *
 *   npm run company:import -- <archive> <slug> [name]
 *
 * The console does the same with the owner's device; this is for the
 * operator moving a deployment, or for an archive too large to send from a
 * browser. The archive is the file the console's export downloads, or one
 * `{ section, row }` per line. The slug is required because two instances can
 * each hold a company called the same thing, and choosing a name for the
 * restored one is the operator's decision, not the archive's.
 *
 * Credentials come across as references only, and a skill trusted on the
 * other instance comes back quarantined: what `importCompany` says it does
 * not restore, this does not either.
 */
import { readFile } from 'node:fs/promises';
import { importCompany, parseArchive } from '../src/audit/import.ts';
import { closePools } from '../src/db/pool.ts';
import { isPalugadaError } from '../src/errors.ts';

const [file, slug, ...name] = process.argv.slice(2);
if (!file || !slug) {
  process.stderr.write('usage: npm run company:import -- <archive.json> <slug> [name]\n');
  process.exit(64);
}

try {
  const summary = await importCompany(parseArchive(await readFile(file, 'utf8')), {
    slug,
    ...(name.length > 0 ? { name: name.join(' ') } : {}),
  });
  const rows = Object.values(summary.sections).reduce((total, count) => total + count, 0);
  process.stdout.write(
    `restored ${summary.slug} as company ${summary.companyId}: ${rows} rows in ` +
    `${Object.keys(summary.sections).length} sections` +
    (summary.skipped.length > 0 ? `; not restored: ${summary.skipped.join(', ')}` : '') + '\n',
  );
} catch (error) {
  // An archive the operator can fix is said plainly; anything else is a fault
  // and keeps its stack.
  process.stderr.write(isPalugadaError(error) ? `${(error as Error).message}\n` : `${(error as Error).stack}\n`);
  process.exitCode = 1;
} finally {
  await closePools();
}
