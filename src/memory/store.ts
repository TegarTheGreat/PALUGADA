/**
 * Memory (PRD section 8.4, F4.1-F4.3, F4.6).
 *
 * Four kinds with different lifetimes: working memory belongs to one agent
 * run, episodic memory is what finished work did -- one line a task, kept for
 * its project when the task completes (engine/tasks.ts) -- semantic memory
 * holds distilled facts, and procedural memory holds SOPs. This module stores
 * and retrieves the last three; a run produces working memory itself.
 *
 * Two rules shape every query here:
 *
 *   F4.2 -- the scope filter runs BEFORE the similarity search, not after.
 *   With exact search the predicate simply lives in the WHERE clause, which is
 *   what makes that literally true. An approximate index would invert it: the
 *   planner would walk the index for the nearest K and filter afterwards,
 *   silently dropping in-scope results. That is why no ANN index exists yet.
 *
 *   F4.3 -- a fact is never deleted. A newer fact supersedes an older one, so
 *   "what did we believe then" and "what do we believe now" stay separately
 *   answerable. Deleting would collapse both into the latter.
 */
import { PalugadaError } from '../errors.ts';

import type { TenantClient } from '../db/tenant.ts';

export type MemoryType = 'working' | 'episodic' | 'semantic' | 'procedural';
export type ScopeType = 'agent_run' | 'task' | 'project' | 'division' | 'company' | 'platform';
export type FactKind = 'observation' | 'decision' | 'sop_candidate';

/**
 * Whether an item may be relied upon (F4.5).
 *
 * A distilled SOP starts as `candidate` and stays out of every agent's context
 * until the owner approves it. A pattern the system noticed three times is a
 * hypothesis, and a company that promotes its own hypotheses to procedure is
 * one that teaches itself its mistakes.
 */
export type ApprovalState = 'active' | 'candidate' | 'rejected';

export interface MemoryItem {
  id: string;
  body: string;
  memoryType: MemoryType;
  scopeType: ScopeType;
  scopeId: string | null;
  confidence: number;
  source: string;
  shared: boolean;
  validFrom: Date;
  supersededBy: string | null;
  approvalState: ApprovalState;
  factKind: FactKind | null;
  /** It came, however indirectly, from content the company did not write (F8.9, 0071). */
  outside: boolean;
  /** The finished work that taught it, when one did. */
  sourceTaskId: string | null;
  /** How many more times the same lesson has been learned since. */
  reinforcedCount: number;
  distance?: number;
}

export interface RememberInput {
  companyId: string;
  memoryType: MemoryType;
  scopeType: ScopeType;
  scopeId?: string | undefined;
  body: string;
  confidence?: number;
  source?: string;
  shared?: boolean;
  sourceEventId?: string | undefined;
  embedding?: number[] | undefined;
  embeddingModel?: string | undefined;
  validFrom?: Date | undefined;
  factKind?: FactKind | undefined;
  approvalState?: ApprovalState | undefined;
  outside?: boolean | undefined;
  sourceTaskId?: string | undefined;
}

/** The longest memory: a fact or a way to work, not a document (0071). */
export const MEMORY_BODY_MAX = 4_000;

/** pgvector accepts a bracketed list; sending an array literal would not parse. */
function toVectorLiteral(embedding: number[]): string {
  return `[${embedding.join(',')}]`;
}

export async function remember(tx: TenantClient, input: RememberInput): Promise<string> {
  if (input.embedding && !input.embeddingModel) {
    // Vectors from different models are not comparable, and mixing them
    // produces confident nonsense rather than an error. The database enforces
    // this too; failing here gives the caller a better message.
    throw new Error('an embedding must be stored with the model that produced it');
  }

  if (input.body.length > MEMORY_BODY_MAX) {
    throw new PalugadaError('contract.violation',
      `a memory is at most ${MEMORY_BODY_MAX} characters: a fact or a way to work, not a document`, { field: 'body' });
  }
  const { rows } = await tx.query<{ id: string }>(
    `INSERT INTO memories
       (company_id, memory_type, scope_type, scope_id, body, confidence, source,
        shared, source_event_id, embedding, embedding_model, valid_from,
        fact_kind, approval_state, outside, source_task_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11, COALESCE($12, now()), $13, $14, $15, $16)
     RETURNING id`,
    [
      input.companyId,
      input.memoryType,
      input.scopeType,
      input.scopeId ?? null,
      input.body,
      input.confidence ?? 1,
      input.source ?? 'unspecified',
      input.shared ?? false,
      input.sourceEventId ?? null,
      input.embedding ? toVectorLiteral(input.embedding) : null,
      input.embeddingModel ?? null,
      input.validFrom ?? null,
      input.factKind ?? null,
      input.approvalState ?? 'active',
      input.outside ?? false,
      input.sourceTaskId ?? null,
    ],
  );
  return rows[0]!.id;
}

/**
 * The most a lesson the company taught itself is believed: below the line
 * the pack draws between known and unverified (context/builder.ts), until it
 * is learned again from other work, and never as surely as the owner's word.
 */
export const LEARNED_CONFIDENCE = { first: 0.5, step: 0.1, most: 0.8 } as const;

/**
 * Learns something from the company's own work: a lesson a run declared, or
 * a fact distilled from what happened.
 *
 * The same lesson already held in the same place strengthens that row --
 * a little more believed, counted once more -- instead of becoming a second
 * fact, so a company that keeps seeing the same thing grows surer of it
 * rather than repeating it. Compared on letters and digits only, so case and
 * punctuation do not make a lesson new. Something learned from outside
 * content stays marked so, whichever path taught it.
 */
export async function learn(tx: TenantClient, input: RememberInput): Promise<{ id: string; reinforced: boolean }> {
  const where = [input.memoryType, input.scopeType, input.scopeId ?? null, input.body];
  // A correction the owner made stays made. A sentence they took back (it was
  // never true), or replaced with their own word, is not learned again by the
  // next run that writes it: that made a fresh active row beside the
  // correction, which repetition could raise to "Known". Only the owner's
  // replacement counts -- one an agent made is one agent's word against another's.
  const { rows: corrected } = await tx.query<{ id: string }>(
    `SELECT m.id FROM memories m
      WHERE m.memory_type = $1 AND m.scope_type = $2 AND m.scope_id IS NOT DISTINCT FROM $3
        AND btrim(regexp_replace(lower(m.body), '[^[:alnum:]]+', ' ', 'g'))
          = btrim(regexp_replace(lower($4), '[^[:alnum:]]+', ' ', 'g'))
        AND (m.approval_state = 'rejected'
             OR EXISTS (SELECT 1 FROM memories r WHERE r.id = m.superseded_by AND r.source = 'owner'))
      LIMIT 1`,
    where);
  if (corrected[0]) return { id: corrected[0].id, reinforced: false };

  const { rows } = await tx.query<{ id: string; source_task_id: string | null }>(
    `SELECT id, source_task_id FROM memories
      WHERE memory_type = $1 AND scope_type = $2 AND scope_id IS NOT DISTINCT FROM $3
        AND approval_state = 'active' AND superseded_by IS NULL
        AND btrim(regexp_replace(lower(body), '[^[:alnum:]]+', ' ', 'g'))
          = btrim(regexp_replace(lower($4), '[^[:alnum:]]+', ' ', 'g'))
      ORDER BY valid_from LIMIT 1`,
    where);
  const found = rows[0];
  // A piece of work saying again what it taught is not corroboration: only
  // other work makes a lesson surer.
  if (found && input.sourceTaskId && found.source_task_id === input.sourceTaskId) {
    return { id: found.id, reinforced: false };
  }
  if (found) {
    await tx.query(
      `UPDATE memories
          SET reinforced_count = reinforced_count + 1,
              last_reinforced_at = now(),
              -- The owner's word is not raised or lowered by a run agreeing with it.
              confidence = CASE WHEN source = 'owner' THEN confidence
                                ELSE LEAST($2::float8, GREATEST(confidence, $3::float8) + $4::float8) END,
              -- Nor is it made "from outside content" by an agent that had read an
              -- email saying it again: that turned the owner's own sentence into
              -- data wrapped as someone else's, and tainted every run told it (the
              -- audit of 6 October, M4). Said again, it is only counted.
              outside = CASE WHEN source = 'owner' THEN outside ELSE outside OR $5 END
        WHERE id = $1`,
      [found.id, LEARNED_CONFIDENCE.most, input.confidence ?? LEARNED_CONFIDENCE.first, LEARNED_CONFIDENCE.step, input.outside ?? false]);
    return { id: found.id, reinforced: true };
  }
  return {
    id: await remember(tx, { ...input, confidence: Math.min(input.confidence ?? LEARNED_CONFIDENCE.first, LEARNED_CONFIDENCE.most) }),
    reinforced: false,
  };
}

/**
 * Records that a newer fact replaces an older one (F4.3).
 *
 * The old row stays exactly as it was; only its forward pointer is set. An
 * agent can therefore still ask what was believed before the correction, which
 * is the difference between a system that learns and one that merely changes
 * its mind without remembering that it did.
 */
export async function supersede(
  tx: TenantClient,
  previousId: string,
  replacement: RememberInput,
): Promise<string> {
  const replacementId = await remember(tx, replacement);
  const { rowCount } = await tx.query(
    'UPDATE memories SET superseded_by = $2 WHERE id = $1 AND superseded_by IS NULL',
    [previousId, replacementId],
  );
  // A correction that corrected nothing is a fault, not a no-op. Without this
  // a wrong id left the replacement in place as a second, unlinked fact while
  // the stale one stayed active -- so the platform believed both, and the
  // caller was told it had been fixed.
  if (rowCount !== 1) {
    throw new PalugadaError(
      'contract.violation',
      `memory ${previousId} cannot be superseded: it does not exist here, or already was`,
      { memoryId: previousId },
    );
  }
  return replacementId;
}

export interface RecallOptions {
  memoryType: MemoryType;
  /** Division asking. Semantic memory is siloed per division unless shared (F4.6). */
  divisionId?: string | undefined;
  /** Episodic memory is shared per project (F4.6). */
  projectId?: string | undefined;
  embedding?: number[] | undefined;
  embeddingModel?: string | undefined;
  limit?: number;
  /**
   * Answers "what was true at this instant" instead of "what is true now"
   * (F4.3). A fact counts as current at T when it was valid by then and
   * whatever superseded it only became valid afterwards.
   */
  asOf?: Date | undefined;
  /**
   * Defaults to 'active'. Candidates are only ever fetched deliberately, by
   * the code that shows them to the owner -- never by context assembly.
   */
  approvalState?: ApprovalState | undefined;
  factKind?: FactKind | undefined;
  /**
   * Leaves out what was recorded, and last reinforced, longer ago than this
   * many days: for the context pack, whose slots a company's months of
   * lessons would otherwise fill with what nothing has confirmed since.
   * Applies to facts that are not the owner's; the owner's word has no horizon.
   */
  horizonDays?: number | undefined;
  /**
   * A fact learned from outside content is returned only when it shares a word
   * with `relevantTo` -- and, with nothing to compare it to, not at all. Each
   * one a run is told taints the run (F8.9), so one about something else is
   * cost without use.
   */
  outsideNeedsMatch?: boolean | undefined;
  /**
   * Only facts sharing a word with this, the most words first (F4.8's
   * `memory.search`). Any word counts, and each as a prefix: "refund"
   * finds "refunds".
   */
  text?: string | undefined;
  /**
   * Every fact the scope allows, the owner's word first, then those sharing
   * the most words with this -- the task, for the context pack -- then the
   * newest. Ordering only: a pack with nothing about the task still gets the
   * newest facts, as before.
   */
  relevantTo?: string | undefined;
  /** Only the owner's own word, or only everything else (the pack keeps the two in separate slots). */
  source?: 'owner' | 'others' | undefined;
}

/** Words that say nothing about what a fact is about, in the two languages the platform ships. */
const STOP_WORDS = new Set([
  'the', 'and', 'for', 'with', 'that', 'this', 'from', 'are', 'was', 'were', 'has', 'have', 'its', 'our', 'your',
  'yang', 'dan', 'untuk', 'dengan', 'ini', 'itu', 'dari', 'pada', 'atau', 'akan', 'ke', 'di', 'kita', 'kami',
]);

/**
 * A full-text query from somebody's words: any of them, each as a prefix.
 * Null when nothing is left to look for. Only letters and digits reach the
 * query, so nothing a model writes can be read as query syntax.
 */
export function searchTerms(text: string): string | null {
  const words = [...new Set(
    (text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []).filter((word) => word.length >= 2 && !STOP_WORDS.has(word)),
  )].slice(0, 24);
  return words.length > 0 ? words.map((word) => `${word}:*`).join(' | ') : null;
}

interface RawMemory {
  id: string;
  body: string;
  memory_type: MemoryType;
  scope_type: ScopeType;
  scope_id: string | null;
  confidence: number;
  source: string;
  shared: boolean;
  valid_from: Date;
  superseded_by: string | null;
  approval_state: ApprovalState;
  fact_kind: FactKind | null;
  outside: boolean;
  source_task_id: string | null;
  reinforced_count: number;
  distance: number | null;
}

/**
 * Retrieves memory for one division.
 *
 * The scope predicate and the freshness predicate are both part of the WHERE
 * clause. When an embedding is supplied the result is ordered by cosine
 * distance, but ordering happens over the already-filtered set: scope decides
 * what is visible, similarity only decides what comes first.
 */
export async function recall(
  tx: TenantClient,
  companyId: string,
  options: RecallOptions,
): Promise<MemoryItem[]> {
  if (options.embedding && !options.embeddingModel) {
    throw new Error('an embedding query must name the model that produced it');
  }

  const params: unknown[] = [companyId, options.memoryType, options.approvalState ?? 'active'];
  const where: string[] = ['m.company_id = $1', 'm.memory_type = $2', 'm.approval_state = $3'];

  if (options.factKind) {
    params.push(options.factKind);
    where.push(`m.fact_kind = $${params.length}`);
  }
  if (options.source === 'owner') where.push("m.source = 'owner'");
  if (options.source === 'others') where.push("m.source <> 'owner'");

  if (options.asOf) {
    params.push(options.asOf);
    const asOf = `$${params.length}`;
    where.push(`m.valid_from <= ${asOf}`);
    where.push(
      `(m.superseded_by IS NULL OR NOT EXISTS (
          SELECT 1 FROM memories later
           WHERE later.id = m.superseded_by AND later.valid_from <= ${asOf}))`,
    );
  } else {
    where.push('m.superseded_by IS NULL');
  }

  // F4.6. Episodic memory is shared across a project; semantic and procedural
  // memory is walled off per division unless the row is company-scoped or
  // explicitly marked shared.
  if (options.memoryType === 'episodic' && options.projectId) {
    params.push(options.projectId);
    where.push(`(m.scope_type = 'project' AND m.scope_id = $${params.length})`);
  } else if (options.divisionId) {
    params.push(options.divisionId);
    const division = `$${params.length}`;
    where.push(
      `((m.scope_type = 'division' AND (m.scope_id = ${division} OR m.shared))
        OR m.scope_type IN ('company', 'platform'))`,
    );
  }

  let distance = 'NULL::float8 AS distance';
  let orderBy = 'm.valid_from DESC, m.id';

  if (options.text !== undefined) {
    const terms = searchTerms(options.text);
    if (!terms) return [];
    params.push(terms);
    const query = `to_tsquery('simple', $${params.length})`;
    where.push(`to_tsvector('simple', m.body) @@ ${query}`);
    orderBy = `ts_rank_cd(to_tsvector('simple', m.body), ${query}) DESC, m.confidence DESC, m.valid_from DESC, m.id`;
  } else if (options.relevantTo !== undefined) {
    const terms = searchTerms(options.relevantTo);
    if (terms) {
      params.push(terms);
      if (options.outsideNeedsMatch) {
        where.push(`(NOT m.outside OR to_tsvector('simple', m.body) @@ to_tsquery('simple', $${params.length}))`);
      }
      orderBy = `(m.source = 'owner') DESC, `
        + `ts_rank_cd(to_tsvector('simple', m.body), to_tsquery('simple', $${params.length})) DESC, m.valid_from DESC, m.id`;
    } else {
      if (options.outsideNeedsMatch) where.push('NOT m.outside');
      orderBy = `(m.source = 'owner') DESC, m.valid_from DESC, m.id`;
    }
  }
  if (options.horizonDays !== undefined) {
    params.push(options.horizonDays);
    where.push(
      `(m.source = 'owner' OR greatest(m.valid_from, coalesce(m.last_reinforced_at, m.valid_from))`
        + ` > now() - make_interval(days => $${params.length}::int))`,
    );
  }

  if (options.embedding) {
    params.push(options.embeddingModel);
    where.push(`m.embedding_model = $${params.length}`);
    where.push('m.embedding IS NOT NULL');

    params.push(`[${options.embedding.join(',')}]`);
    const vector = `$${params.length}::vector`;
    distance = `(m.embedding <=> ${vector})::float8 AS distance`;
    orderBy = `m.embedding <=> ${vector}`;
  }

  params.push(options.limit ?? 20);

  const { rows } = await tx.query<RawMemory>(
    `SELECT m.id, m.body, m.memory_type, m.scope_type, m.scope_id, m.confidence,
            m.source, m.shared, m.valid_from, m.superseded_by,
            m.approval_state, m.fact_kind, m.outside, m.source_task_id, m.reinforced_count, ${distance}
       FROM memories m
      WHERE ${where.join(' AND ')}
      ORDER BY ${orderBy}
      LIMIT $${params.length}`,
    params,
  );

  return rows.map((row) => ({
    id: row.id,
    body: row.body,
    memoryType: row.memory_type,
    scopeType: row.scope_type,
    scopeId: row.scope_id,
    confidence: row.confidence,
    source: row.source,
    shared: row.shared,
    validFrom: row.valid_from,
    supersededBy: row.superseded_by,
    approvalState: row.approval_state,
    factKind: row.fact_kind,
    outside: row.outside,
    sourceTaskId: row.source_task_id,
    reinforcedCount: row.reinforced_count,
    ...(row.distance === null ? {} : { distance: row.distance }),
  }));
}

/**
 * Activates a candidate the owner approved (F4.5).
 *
 * Only a candidate can be activated. Re-approving something already active, or
 * resurrecting a rejection, would let the inbox quietly rewrite standing
 * procedure.
 */
export async function approveCandidate(tx: TenantClient, memoryId: string): Promise<boolean> {
  const { rowCount } = await tx.query(
    `UPDATE memories SET approval_state = 'active', approved_at = now()
      WHERE id = $1 AND approval_state = 'candidate'`,
    [memoryId],
  );
  return rowCount === 1;
}

/**
 * The owner takes back something the company believed (0071): it leaves every
 * run's context and stays in the record, marked rejected, like a candidate
 * the owner turned down. A correction is `supersede`; this is for what should
 * not be believed at all.
 */
export async function retract(tx: TenantClient, memoryId: string): Promise<boolean> {
  const { rowCount } = await tx.query(
    `UPDATE memories SET approval_state = 'rejected' WHERE id = $1 AND approval_state = 'active' AND superseded_by IS NULL`,
    [memoryId],
  );
  return rowCount === 1;
}

export async function rejectCandidate(tx: TenantClient, memoryId: string): Promise<boolean> {
  const { rowCount } = await tx.query(
    `UPDATE memories SET approval_state = 'rejected' WHERE id = $1 AND approval_state = 'candidate'`,
    [memoryId],
  );
  return rowCount === 1;
}
