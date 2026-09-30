/**
 * One search across every company (Buzz's search, Paperclip's).
 *
 * The owner could search one company's decisions and one company's memory,
 * and nothing else. "Where did we decide the price?" and "which task wrote
 * the wholesale email?" meant opening each company and scrolling. This looks
 * in the four places an answer is -- what was asked for, what it produced,
 * what was decided, what the companies know -- in every company at once,
 * because the owner is one person with many.
 *
 * On the control plane, as the owner's console reads across companies. The
 * query is taken literally: `%` and `_` are characters, not wildcards. Each
 * kind is capped and newest first, so a common word answers quickly with the
 * most recent and does not return the company's history.
 *
 * A phrase anywhere in a text is a pattern no ordinary index serves, so every
 * column searched here has a trigram index (0098), and each is written here
 * exactly as its index is: a column spelled differently is one the planner
 * cannot match to its index, and the search reads the table whole again.
 */
import { withControlPlane } from '../db/tenant.ts';
import { PalugadaError } from '../errors.ts';
import { redactor } from '../secrets/manager.ts';

export interface SearchHit {
  kind: 'task' | 'decision' | 'memory';
  id: string;
  companyId: string;
  company: string;
  title: string;
  detail: string | null;
  status: string | null;
  at: Date;
}

/** Per kind; the console shows these, not a page of them. */
const PER_KIND = 8;

/**
 * A search as an ILIKE pattern, taken literally.
 *
 * `%` and `_` are ILIKE's own wildcards and `\` its escape; a search for
 * "50%" is a search for fifty per cent, not for anything with a 50 in it.
 */
export function likePattern(text: string): string {
  return `%${text.replace(/[\\%_]/g, (char) => `\\${char}`)}%`;
}

export async function searchEverywhere(query: string): Promise<SearchHit[]> {
  const text = String(query ?? '').trim().slice(0, 200);
  if (text.length < 2) {
    throw new PalugadaError('contract.violation', 'search for at least 2 characters', { field: 'q' });
  }
  const pattern = likePattern(text);
  const hits = await withControlPlane(async (tx) => {
    const tasks = await tx.query<{
      id: string; company_id: string; company: string; title: string | null; detail: string | null;
      status: string; at: Date;
    }>(
      `SELECT t.id, t.company_id, c.name AS company, t.input->>'goal' AS title, t.output->>'summary' AS detail,
              t.status, t.created_at AS at
         FROM tasks t JOIN companies c ON c.id = t.company_id
        WHERE (t.input->>'goal') ILIKE $1 ESCAPE '\\' OR (t.output->>'summary') ILIKE $1 ESCAPE '\\'
        ORDER BY t.created_at DESC LIMIT $2`,
      [pattern, PER_KIND],
    );
    // The note as it is, not coalesced to '': a decision without one matched
    // nothing either way, and its index is on the column.
    const decisions = await tx.query<{
      id: string; company_id: string; company: string; title: string; detail: string | null; status: string; at: Date;
    }>(
      `SELECT i.id, i.company_id, c.name AS company, i.title, coalesce(i.owner_note, i.action_summary) AS detail,
              i.status, i.created_at AS at
         FROM inbox_items i JOIN companies c ON c.id = i.company_id
        WHERE i.title ILIKE $1 ESCAPE '\\' OR i.action_summary ILIKE $1 ESCAPE '\\'
           OR i.owner_note ILIKE $1 ESCAPE '\\'
        ORDER BY i.created_at DESC LIMIT $2`,
      [pattern, PER_KIND],
    );
    // What the companies know, not what they did: an episode is one line of
    // a finished task, and that task is already a hit above with its goal and
    // result, so counting it again would spend the memory hits on the work.
    const memories = await tx.query<{
      id: string; company_id: string; company: string; title: string; detail: string; at: Date;
    }>(
      `SELECT m.id, m.company_id, c.name AS company, m.body AS title, m.memory_type AS detail, m.created_at AS at
         FROM memories m JOIN companies c ON c.id = m.company_id
        WHERE m.superseded_by IS NULL AND m.approval_state = 'active' AND m.memory_type <> 'episodic'
          AND m.body ILIKE $1 ESCAPE '\\'
        ORDER BY m.created_at DESC LIMIT $2`,
      [pattern, PER_KIND],
    );
    return [
      ...tasks.rows.map((row) => ({ kind: 'task' as const, ...row })),
      ...decisions.rows.map((row) => ({ kind: 'decision' as const, ...row })),
      ...memories.rows.map((row) => ({ kind: 'memory' as const, ...row, status: null })),
    ];
  });
  // What agents wrote goes through the redactor on its way out, as every
  // read model's text does.
  return hits.map((hit) => ({
    kind: hit.kind,
    id: hit.id,
    companyId: hit.company_id,
    company: hit.company,
    title: redactor.redact(hit.title ?? '').slice(0, 300),
    detail: hit.detail === null ? null : redactor.redact(hit.detail).slice(0, 300),
    status: hit.status,
    at: hit.at,
  }));
}
