/**
 * Charters as files (PRD v2 F3.11).
 *
 * "Charter disimpan sebagai `SOUL.md` per company dan `PLATFORM.md` di repo git
 * internal; UI mengedit file, bukan sebaliknya."
 *
 * The direction is the whole requirement. A charter that lives in a database
 * and is exported to a file for convenience has its history in the database; a
 * charter that lives in a file has its history in git, where it can be
 * reviewed, blamed, diffed and reverted by every tool anybody already has. The
 * database copy is a cache the runtime reads, and this module is the only thing
 * that writes it.
 *
 * What follows from that, and is easy to get backwards: `importFromDisk` is the
 * normal path and `exportToDisk` exists for a company whose charter was created
 * through the API before anybody wrote a file. Editing the database copy
 * directly is not an error the code can prevent, but it is a change the next
 * import will overwrite, which is the correct outcome and is worth knowing
 * before it happens.
 *
 * Committing is left to the operator. Shelling out to `git` from inside the
 * orchestrator would put a working tree, a merge conflict and an authentication
 * failure on the path of a charter read, and none of those are things a run
 * should be able to hit. The files are written; the repository is somebody's
 * to manage.
 */
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { withControlPlane } from '../db/tenant.ts';
import { publishCharter } from './store.ts';

/** The platform charter's filename. It outranks every company's (F3.1). */
export const PLATFORM_CHARTER_FILE = 'PLATFORM.md';
/** A company's charter, in that company's directory. */
export const COMPANY_CHARTER_FILE = 'SOUL.md';

export interface CharterTree {
  /** Where the files live. A git repository, in a deployment that follows F3.11. */
  root: string;
}

function companyDir(tree: CharterTree, slug: string): string {
  return join(tree.root, 'companies', slug);
}

/**
 * Reads the files and publishes what changed (F3.11).
 *
 * Idempotent by content: a file whose text already matches the current version
 * publishes nothing. Without that, every deploy would produce a new charter
 * version and "which charter was this run subject to" would become a question
 * about deploy timing rather than about the charter.
 */
export async function importFromDisk(
  tree: CharterTree,
): Promise<Array<{ scope: string; version: number | null }>> {
  const results: Array<{ scope: string; version: number | null }> = [];

  const platform = await readIfPresent(join(tree.root, PLATFORM_CHARTER_FILE));
  if (platform !== null) {
    results.push({ scope: 'platform', version: await publishIfChanged(null, platform) });
  }

  const companiesRoot = join(tree.root, 'companies');
  for (const slug of await listDirectories(companiesRoot)) {
    const body = await readIfPresent(join(companiesRoot, slug, COMPANY_CHARTER_FILE));
    if (body === null) continue;

    const companyId = await companyIdFor(slug);
    if (!companyId) {
      // A directory for a company this instance does not have. Reported rather
      // than created: a charter file is not authorisation to create a tenant.
      results.push({ scope: slug, version: null });
      continue;
    }
    results.push({ scope: slug, version: await publishIfChanged(companyId, body) });
  }

  return results;
}

/** Writes the current charters out, for a deployment adopting F3.11 late. */
export async function exportToDisk(tree: CharterTree): Promise<string[]> {
  const written: string[] = [];

  const charters = await withControlPlane(async (tx) => {
    const { rows } = await tx.query<{ slug: string | null; body: string }>(
      `SELECT c.slug, ch.body
         FROM charters ch
         LEFT JOIN companies c ON c.id = ch.company_id
        WHERE ch.version = (
          SELECT max(version) FROM charters inner_ch
           WHERE inner_ch.company_id IS NOT DISTINCT FROM ch.company_id)`,
    );
    return rows;
  });

  await mkdir(tree.root, { recursive: true });
  for (const charter of charters) {
    if (charter.slug === null) {
      const path = join(tree.root, PLATFORM_CHARTER_FILE);
      await writeFile(path, ensureTrailingNewline(charter.body), 'utf8');
      written.push(path);
      continue;
    }
    const dir = companyDir(tree, charter.slug);
    await mkdir(dir, { recursive: true });
    const path = join(dir, COMPANY_CHARTER_FILE);
    await writeFile(path, ensureTrailingNewline(charter.body), 'utf8');
    written.push(path);
  }

  return written;
}

async function publishIfChanged(
  companyId: string | null,
  body: string,
): Promise<number | null> {
  const trimmed = body.trim();
  const current = await withControlPlane(async (tx) => {
    const { rows } = await tx.query<{ version: number; body: string }>(
      `SELECT version, body FROM charters
        WHERE company_id IS NOT DISTINCT FROM $1
        ORDER BY version DESC LIMIT 1`,
      [companyId],
    );
    return rows[0] ?? null;
  });

  if (current && current.body.trim() === trimmed) return current.version;

  const published = await publishCharter({
    ...(companyId === null ? {} : { companyId }),
    body: trimmed,
  });
  return published.version;
}

async function companyIdFor(slug: string): Promise<string | null> {
  return withControlPlane(async (tx) => {
    const { rows } = await tx.query<{ id: string }>(
      'SELECT id FROM companies WHERE slug = $1',
      [slug],
    );
    return rows[0]?.id ?? null;
  });
}

async function readIfPresent(path: string): Promise<string | null> {
  try {
    return await readFile(path, 'utf8');
  } catch {
    // A charter that is not there is not an error: PLATFORM.md is optional in a
    // deployment that has not adopted F3.11, and a company may not have one.
    return null;
  }
}

async function listDirectories(path: string): Promise<string[]> {
  try {
    const entries = await readdir(path, { withFileTypes: true });
    return entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name);
  } catch {
    return [];
  }
}

function ensureTrailingNewline(body: string): string {
  return body.endsWith('\n') ? body : `${body}\n`;
}
