/**
 * The company's documents (0075): kept whole, found by passage.
 *
 * Memory holds facts of a sentence or two, and a price list, a contract or
 * the brand guide had nowhere to go. A document is stored as the owner gave
 * it and split into passages under the headings they sit beneath, and
 * `memory.search` returns the passages a query's words point at -- so a run
 * reads the three paragraphs about wholesale terms, not the whole contract,
 * and every role that can search the company's memory can search its
 * documents without another tool (F2.4 caps a role's tools).
 *
 * The words are matched by PostgreSQL's own text search, which needs no
 * embedding model: a deployment with none still has a knowledge base.
 */
import { withTenant, type TenantClient } from '../db/tenant.ts';
import { appendEvent } from '../audit/event-log.ts';
import { PalugadaError } from '../errors.ts';
import { searchTerms } from '../memory/store.ts';

/** The longest document, in characters: a long contract, not a data dump. */
export const DOCUMENT_MAX = 1_000_000;
/** Roughly how long a passage is, so a search returns a few paragraphs rather than a page. */
const PASSAGE_TARGET = 1_500;
const PASSAGE_MAX = 3_500;

export interface Passage {
  heading: string | null;
  body: string;
}

/**
 * Splits a document into passages under the headings they sit beneath.
 *
 * Paragraphs are kept together up to a passage's length; a heading starts a
 * new passage and is carried by every passage under it, so a paragraph about
 * "Payment terms" is found by those words even when it never says them.
 * Markdown headings and a line in capitals on its own are headings; a
 * paragraph longer than a passage is cut at sentence ends.
 */
export function passagesOf(text: string): Passage[] {
  const passages: Passage[] = [];
  let heading: string | null = null;
  let current: string[] = [];
  let length = 0;
  const flush = () => {
    const body = current.join('\n\n').trim();
    if (body) passages.push({ heading, body });
    current = [];
    length = 0;
  };
  const paragraphs = text.replace(/\r\n?/g, '\n').split(/\n\s*\n/);
  for (const raw of paragraphs) {
    const paragraph = raw.trim();
    if (!paragraph) continue;
    const lines = paragraph.split('\n');
    const first = lines[0]!.trim();
    const markdown = /^#{1,6}\s+(.+)$/.exec(first);
    const shouting = lines.length === 1 && first.length <= 80 && /\p{L}/u.test(first) && first === first.toUpperCase();
    if (markdown || shouting) {
      flush();
      heading = (markdown ? markdown[1]! : first).trim().slice(0, 200);
      const rest = lines.slice(1).join('\n').trim();
      if (!rest) continue;
      current.push(rest);
      length = rest.length;
      continue;
    }
    for (const piece of cut(paragraph)) {
      if (length > 0 && length + piece.length > PASSAGE_TARGET) flush();
      current.push(piece);
      length += piece.length;
    }
  }
  flush();
  return passages;
}

/** A paragraph longer than a passage, at sentence ends where there are any. */
function cut(paragraph: string): string[] {
  if (paragraph.length <= PASSAGE_MAX) return [paragraph];
  const pieces: string[] = [];
  let rest = paragraph;
  while (rest.length > PASSAGE_MAX) {
    const window = rest.slice(0, PASSAGE_MAX);
    const end = Math.max(window.lastIndexOf('. '), window.lastIndexOf('.\n'), window.lastIndexOf('? '), window.lastIndexOf('! '));
    const at = end > PASSAGE_MAX / 2 ? end + 1 : PASSAGE_MAX;
    pieces.push(rest.slice(0, at).trim());
    rest = rest.slice(at).trim();
  }
  if (rest) pieces.push(rest);
  return pieces;
}

export interface DocumentSummary {
  id: string;
  title: string;
  divisionId: string | null;
  divisionName: string | null;
  fileName: string | null;
  characters: number;
  passages: number;
  createdAt: Date;
  archivedAt: Date | null;
}

/** The owner gives the company a document. */
export async function addDocument(companyId: string, input: {
  title: string;
  body: string;
  divisionId?: string | null;
  fileName?: string | null;
}): Promise<{ documentId: string; passages: number }> {
  const title = input.title.trim();
  const body = input.body.trim();
  if (!title || title.length > 200) {
    throw new PalugadaError('contract.violation', 'a document\'s title is 1 to 200 characters', { field: 'title' });
  }
  if (!body) throw new PalugadaError('contract.violation', 'a document needs its text', { field: 'body' });
  if (body.length > DOCUMENT_MAX) {
    throw new PalugadaError('contract.violation',
      `a document is at most ${DOCUMENT_MAX} characters; split a longer one into parts`, { field: 'body' });
  }
  const passages = passagesOf(body);
  return withTenant(companyId, async (tx) => {
    const { rows } = await tx.query<{ id: string }>(
      `INSERT INTO documents (company_id, division_id, title, body, file_name)
       VALUES ($1, $2, $3, $4, $5) RETURNING id`,
      [companyId, input.divisionId ?? null, title, body, input.fileName?.trim().slice(0, 200) || null]);
    const documentId = rows[0]!.id;
    for (const [index, passage] of passages.entries()) {
      await tx.query(
        'INSERT INTO document_passages (company_id, document_id, seq, heading, body) VALUES ($1, $2, $3, $4, $5)',
        [companyId, documentId, index + 1, passage.heading, passage.body]);
    }
    await appendEvent(tx, {
      companyId, type: 'document.added', actor: 'owner',
      payload: { documentId, title, passages: passages.length, divisionId: input.divisionId ?? null },
    });
    return { documentId, passages: passages.length };
  });
}

export async function listDocuments(companyId: string): Promise<DocumentSummary[]> {
  return withTenant(companyId, async (tx) => {
    const { rows } = await tx.query<{
      id: string; title: string; division_id: string | null; division_name: string | null; file_name: string | null;
      characters: number; passages: number; created_at: Date; archived_at: Date | null;
    }>(
      `SELECT d.id, d.title, d.division_id, v.name AS division_name, d.file_name, length(d.body) AS characters,
              (SELECT count(*)::int FROM document_passages p WHERE p.document_id = d.id) AS passages,
              d.created_at, d.archived_at
         FROM documents d LEFT JOIN divisions v ON v.id = d.division_id
        ORDER BY d.archived_at IS NOT NULL, d.created_at DESC`);
    return rows.map((row) => ({
      id: row.id, title: row.title, divisionId: row.division_id, divisionName: row.division_name,
      fileName: row.file_name, characters: row.characters, passages: row.passages,
      createdAt: row.created_at, archivedAt: row.archived_at,
    }));
  });
}

export async function readDocument(companyId: string, documentId: string): Promise<(DocumentSummary & { body: string }) | null> {
  if (!/^[0-9a-f-]{36}$/.test(documentId)) return null;
  const found = (await listDocuments(companyId)).find((one) => one.id === documentId);
  if (!found) return null;
  const body = await withTenant(companyId, async (tx) =>
    (await tx.query<{ body: string }>('SELECT body FROM documents WHERE id = $1', [documentId])).rows[0]!.body);
  return { ...found, body };
}

/** Takes a document out of what runs find, or puts it back. Its text stays. */
export async function archiveDocument(companyId: string, documentId: string, archived: boolean): Promise<void> {
  await withTenant(companyId, async (tx) => {
    const { rowCount } = await tx.query(
      `UPDATE documents SET archived_at = CASE WHEN $2 THEN coalesce(archived_at, now()) ELSE NULL END WHERE id = $1`,
      [documentId, archived]);
    if (rowCount !== 1) throw new PalugadaError('contract.violation', `no document ${documentId} in this company`, {});
    await appendEvent(tx, {
      companyId, type: archived ? 'document.archived' : 'document.restored', actor: 'owner', payload: { documentId },
    });
  });
}

export interface FoundPassage {
  documentId: string;
  title: string;
  heading: string | null;
  body: string;
}

/**
 * The passages a query's words point at, among the documents a division may
 * read: its own and the company's, not archived. Ranked by how much of the
 * query each passage holds, the heading counting with the text under it.
 */
export async function searchDocuments(tx: TenantClient, options: {
  divisionId: string;
  query: string;
  limit?: number;
}): Promise<FoundPassage[]> {
  const terms = searchTerms(options.query);
  if (!terms) return [];
  const { rows } = await tx.query<{ document_id: string; title: string; heading: string | null; body: string }>(
    `SELECT p.document_id, d.title, p.heading, p.body
       FROM document_passages p JOIN documents d ON d.id = p.document_id
      WHERE d.archived_at IS NULL
        AND (d.division_id IS NULL OR d.division_id = $1)
        AND p.words @@ to_tsquery('simple', $2)
      ORDER BY ts_rank_cd(p.words, to_tsquery('simple', $2)) DESC, d.created_at DESC, p.seq
      LIMIT $3`,
    [options.divisionId, terms, Math.min(Math.max(options.limit ?? 3, 1), 10)]);
  return rows.map((row) => ({ documentId: row.document_id, title: row.title, heading: row.heading, body: row.body }));
}

/** The documents a division may read, for its runs to know they exist. */
export async function documentTitlesFor(tx: TenantClient, divisionId: string, limit = 15): Promise<string[]> {
  const { rows } = await tx.query<{ title: string }>(
    `SELECT title FROM documents WHERE archived_at IS NULL AND (division_id IS NULL OR division_id = $1)
      ORDER BY created_at DESC LIMIT $2`,
    [divisionId, limit]);
  return rows.map((row) => row.title);
}
