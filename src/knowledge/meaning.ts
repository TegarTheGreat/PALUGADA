/**
 * The meaning of the company's documents, as vectors (0087), for a search to
 * find a passage that says what a question asks in other words.
 *
 * The provider is the deployment's, chosen under Tools, and one for every
 * company: `useMeaning` is set when the deployment starts, as the redactor
 * is, because the search is reached from inside a run's capability and the
 * binding is the deployment's, not the run's. Unset, search is by words.
 *
 * Passages are given their vectors by the worker, a batch at a time
 * (`embedBacklog`), never while the owner waits for an upload: a provider
 * that is slow or down delays meaning, and nothing else. Each vector is kept
 * with the model that made it, and a search compares only vectors of the
 * model in use, since two models' vectors are not comparable: a search
 * across them answers with confident nonsense rather than an error.
 */
import { withTenant } from '../db/tenant.ts';
import { EMBED_BATCH, embed, embedModel, type EmbedBinding } from '../capabilities/embed.ts';

let meaning: EmbedBinding | null = null;

/** The deployment's provider of meaning, or none. */
export function useMeaning(binding: EmbedBinding | null): void {
  meaning = binding;
}

/**
 * Gives a company's passages their vectors: those that have none, and those
 * made with another model. One batch a call; answers how many it did, so a
 * caller can come back for the rest.
 */
export async function embedBacklog(companyId: string, binding: EmbedBinding, signal?: AbortSignal): Promise<number> {
  const model = embedModel(binding);
  const due = await withTenant(companyId, (tx) => tx.query<{ document_id: string; seq: number; heading: string | null; body: string }>(
    `SELECT p.document_id, p.seq, p.heading, p.body
       FROM document_passages p JOIN documents d ON d.id = p.document_id
      WHERE d.archived_at IS NULL AND (p.embedding_model IS DISTINCT FROM $1)
      ORDER BY d.created_at, p.document_id, p.seq
      LIMIT $2`,
    [model, EMBED_BATCH]));
  if (due.rows.length === 0) return 0;
  // Outside the transaction: a provider call is a network hop, and a
  // transaction held open across one holds its connection with it.
  const vectors = await embed(binding, due.rows.map((row) => (row.heading ? `${row.heading}\n\n${row.body}` : row.body)), signal);
  await withTenant(companyId, async (tx) => {
    for (const [index, row] of due.rows.entries()) {
      await tx.query(
        'UPDATE document_passages SET embedding = $3::vector, embedding_model = $4 WHERE document_id = $1 AND seq = $2',
        [row.document_id, row.seq, vectorLiteral(vectors[index]!), model]);
    }
  });
  return due.rows.length;
}

/** A query's vector, and the model it was made with, when the deployment has a provider. */
export async function queryMeaning(query: string, signal?: AbortSignal): Promise<{ vector: string; model: string } | null> {
  const binding = meaning;
  if (!binding || !query.trim()) return null;
  try {
    const [vector] = await embed(binding, [query.slice(0, 2_000)], signal);
    return { vector: vectorLiteral(vector!), model: embedModel(binding) };
  } catch {
    // A provider that is down leaves the search to words, which is what it
    // was before there was a provider: better an answer by words than none.
    return null;
  }
}

function vectorLiteral(vector: number[]): string {
  return `[${vector.join(',')}]`;
}

