/**
 * Memory (PRD section 8.4, F4.1-F4.3, F4.6).
 *
 * Four kinds with different lifetimes: working memory belongs to one agent
 * run, episodic memory is the event log, semantic memory holds distilled
 * facts, and procedural memory holds SOPs. This module owns the semantic and
 * procedural kinds, which are the ones a run retrieves rather than produces.
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
}

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

  const { rows } = await tx.query<{ id: string }>(
    `INSERT INTO memories
       (company_id, memory_type, scope_type, scope_id, body, confidence, source,
        shared, source_event_id, embedding, embedding_model, valid_from,
        fact_kind, approval_state)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11, COALESCE($12, now()), $13, $14)
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
    ],
  );
  return rows[0]!.id;
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
  await tx.query('UPDATE memories SET superseded_by = $2 WHERE id = $1', [previousId, replacementId]);
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
            m.approval_state, m.fact_kind, ${distance}
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

export async function rejectCandidate(tx: TenantClient, memoryId: string): Promise<boolean> {
  const { rowCount } = await tx.query(
    `UPDATE memories SET approval_state = 'rejected' WHERE id = $1 AND approval_state = 'candidate'`,
    [memoryId],
  );
  return rowCount === 1;
}
