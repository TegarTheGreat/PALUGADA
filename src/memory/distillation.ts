/**
 * Distillation (PRD F4.4, F4.5, section 6.2 step 7).
 *
 * Two scheduled passes turn raw history into something an agent can use:
 * episodic events become semantic facts, and repeated patterns become
 * candidate SOPs. Both are what "the company learns" means in practice; the
 * event log alone is a transcript, not knowledge.
 *
 * Three properties matter more than the extraction quality itself:
 *
 * Raw events are untrusted input. An event payload can contain an inbound
 * email, a scraped page or a third-party error message, so it is wrapped as
 * data before it reaches a model (F8.9). A distiller that treats its corpus as
 * instructions is a prompt-injection sink with write access to the company's
 * long-term memory -- the worst possible place to put one.
 *
 * Nothing is promoted automatically. A distilled SOP is stored as a candidate
 * and reaches no agent's context until the owner approves it (F4.5). A pattern
 * observed three times is a hypothesis.
 *
 * A pass records how far it consumed, so running twice does not manufacture
 * corroboration by extracting the same fact again.
 *
 * On NG6: this job calls a model directly, and that is not the exception it
 * looks like. NG6 forbids the platform calling a model *to do a task* -- a
 * role's work belongs to a runtime. Distillation is the platform's own
 * housekeeping over its own event log (v2 section 6.2 lists it as a scheduled
 * job rather than a run), so there is no role, no task and no runtime whose
 * work is being taken.
 */
import { withTenant, type TenantClient } from '../db/tenant.ts';
import { appendEvent } from '../audit/event-log.ts';
import { wrapUntrusted } from '../context/builder.ts';
import { remember } from './store.ts';
import * as inbox from '../inbox/inbox.ts';
import type { LlmClient } from '../llm/client.ts';

/** How many times a pattern must recur before it is worth proposing as an SOP. */
export const DEFAULT_MIN_OCCURRENCES = 3;

/**
 * Events this module writes itself, excluded from its own corpus.
 *
 * Without this a distillation run records that it ran, and the next run
 * distils that into a "fact" about distillation. The loop is self-sustaining
 * and self-reinforcing: the memory fills with the system's account of its own
 * housekeeping, and each retelling looks like fresh evidence. A process that
 * reads its own output has no fixed point worth reaching.
 */
const SELF_AUTHORED_EVENT_TYPES = [
  'memory.distilled',
  'memory.distillation_failed',
  'sop.proposed',
] as const;

export interface DistillEpisodicInput {
  companyId: string;
  projectId: string;
  divisionId: string;
  llm: LlmClient;
  model: string;
  /** Defaults to whatever has not been consumed yet. */
  since?: Date | undefined;
  until?: Date;
  maxEvents?: number;
}

export interface DistillEpisodicResult {
  eventsRead: number;
  factsCreated: number;
  /** Set when the model returned something that was not usable. */
  parseFailure?: string;
}

interface ExtractedFact {
  body: string;
  confidence: number;
}

/**
 * Reads the model's reply as a fact list.
 *
 * A model that returns prose, truncated JSON or an apology is an ordinary
 * outcome, not an exception: it must leave the corpus untouched and say so,
 * rather than aborting the nightly job or writing half a fact.
 */
function parseFacts(content: string): { facts: ExtractedFact[] } | { error: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    return { error: 'response was not JSON' };
  }

  const raw = (parsed as { facts?: unknown }).facts;
  if (!Array.isArray(raw)) return { error: 'response had no facts array' };

  const facts: ExtractedFact[] = [];
  for (const entry of raw) {
    const body = (entry as { body?: unknown }).body;
    const confidence = (entry as { confidence?: unknown }).confidence;
    if (typeof body !== 'string' || body.trim() === '') continue;
    facts.push({
      body: body.trim(),
      // An unstated confidence is treated as middling rather than certain. A
      // distiller that reports everything it noticed as certain makes the
      // confidence field useless exactly when it matters.
      confidence: typeof confidence === 'number' && confidence >= 0 && confidence <= 1 ? confidence : 0.5,
    });
  }
  return { facts };
}

/**
 * Advances the watermark to an event's timestamp, without moving it through
 * JavaScript.
 *
 * PostgreSQL keeps timestamps to microseconds; a JavaScript Date holds
 * milliseconds. Reading a watermark out and sending it back therefore rounds
 * it *down* by up to a millisecond, so the last event of the previous run
 * lands after the watermark again and is distilled a second time. The
 * duplicate then reads as independent corroboration of whatever it said.
 *
 * The value is copied inside the database instead, and compared there too, so
 * the precision never has anywhere to go.
 */
async function advanceWatermark(
  tx: TenantClient,
  companyId: string,
  scopeId: string,
  kind: 'episodic_to_semantic' | 'semantic_to_procedural',
  throughEventId: string,
): Promise<void> {
  await tx.query(
    `INSERT INTO distillation_state (company_id, scope_id, kind, through_at)
     SELECT $1, $2, $3, e.occurred_at FROM events e WHERE e.id = $4
     ON CONFLICT (company_id, scope_id, kind)
       DO UPDATE SET through_at = EXCLUDED.through_at, updated_at = now()`,
    [companyId, scopeId, kind, throughEventId],
  );
}

/** Episodic to semantic: extracts durable facts from what happened (F4.4). */
export async function distillEpisodicToSemantic(
  input: DistillEpisodicInput,
): Promise<DistillEpisodicResult> {
  const until = input.until ?? new Date();

  const events = await withTenant(input.companyId, async (tx) => {
    const { rows } = await tx.query<{
      id: string;
      type: string;
      actor: string;
      payload: Record<string, unknown>;
      occurred_at: Date;
    }>(
      // The watermark is compared in SQL against the stored value rather than
      // one shipped in from the caller, so no rounding can reopen a window
      // that was already consumed. An explicit `since` overrides it, for a
      // deliberate re-read.
      `SELECT id, type, actor, payload, occurred_at
         FROM events
        WHERE project_id = $1
          AND occurred_at > COALESCE(
                $2::timestamptz,
                (SELECT through_at FROM distillation_state
                  WHERE company_id = $5 AND scope_id = $1 AND kind = 'episodic_to_semantic'),
                '-infinity'::timestamptz)
          AND occurred_at <= $3
          AND type <> ALL($6::text[])
        ORDER BY occurred_at, id
        LIMIT $4`,
      [
        input.projectId,
        input.since ?? null,
        until,
        input.maxEvents ?? 500,
        input.companyId,
        SELF_AUTHORED_EVENT_TYPES,
      ],
    );
    return rows;
  });

  if (events.length === 0) return { eventsRead: 0, factsCreated: 0 };

  const transcript = events
    .map((event) => `${event.occurred_at.toISOString()} ${event.type} by ${event.actor}: ${JSON.stringify(event.payload)}`)
    .join('\n');

  const response = await input.llm.complete({
    model: input.model,
    system:
      'You distil durable facts from a company event log. Return JSON of the form ' +
      '{"facts":[{"body":"...","confidence":0.0-1.0}]}. State only what the log ' +
      'supports. Prefer few well-supported facts over many speculative ones, and ' +
      'return an empty list when the log establishes nothing durable.',
    messages: [
      {
        role: 'user',
        // The log is evidence to read, never instructions to follow. Some of it
        // originated outside this system.
        content: wrapUntrusted('event-log', transcript),
      },
    ],
  });

  const parsed = parseFacts(response.content);
  const lastEvent = events[events.length - 1]!;

  if ('error' in parsed) {
    await withTenant(input.companyId, async (tx) => {
      await appendEvent(tx, {
        companyId: input.companyId,
        projectId: input.projectId,
        type: 'memory.distillation_failed',
        actor: 'system',
        payload: { kind: 'episodic_to_semantic', reason: parsed.error, eventsRead: events.length },
      });
      // The watermark is deliberately NOT advanced: an unusable reply must not
      // silently consume a night's history.
    });
    return { eventsRead: events.length, factsCreated: 0, parseFailure: parsed.error };
  }

  const factsCreated = await withTenant(input.companyId, async (tx) => {
    for (const fact of parsed.facts) {
      await remember(tx, {
        companyId: input.companyId,
        memoryType: 'semantic',
        scopeType: 'division',
        scopeId: input.divisionId,
        body: fact.body,
        confidence: fact.confidence,
        source: 'distillation',
        factKind: 'observation',
        sourceEventId: lastEvent.id,
      });
    }
    await advanceWatermark(tx, input.companyId, input.projectId, 'episodic_to_semantic', lastEvent.id);
    await appendEvent(tx, {
      companyId: input.companyId,
      projectId: input.projectId,
      type: 'memory.distilled',
      actor: 'system',
      payload: {
        kind: 'episodic_to_semantic',
        eventsRead: events.length,
        factsCreated: parsed.facts.length,
        throughAt: lastEvent.occurred_at.toISOString(),
      },
    });
    return parsed.facts.length;
  });

  return { eventsRead: events.length, factsCreated };
}

export interface DistillProceduralInput {
  companyId: string;
  projectId: string;
  divisionId: string;
  llm: LlmClient;
  model: string;
  minOccurrences?: number;
}

export interface SopCandidate {
  memoryId: string;
  inboxItemId: string;
  pattern: string;
  occurrences: number;
}

/**
 * Semantic to procedural: proposes SOPs for patterns that keep recurring (F4.4).
 *
 * The recurrence signal is deterministic and countable -- how often a division
 * completed tasks that called a given capability -- rather than a model's
 * impression that something "seems common". The model writes the procedure;
 * it does not decide what qualifies as a pattern. That split keeps the
 * question "why was this proposed" answerable with a number.
 */
export async function distillSemanticToProcedural(
  input: DistillProceduralInput,
): Promise<SopCandidate[]> {
  const minOccurrences = input.minOccurrences ?? DEFAULT_MIN_OCCURRENCES;

  const patterns = await withTenant(input.companyId, async (tx) => {
    const { rows } = await tx.query<{ capability: string; occurrences: string }>(
      `SELECT e.payload->>'capability' AS capability, count(*)::text AS occurrences
         FROM events e
         JOIN tasks t ON t.id = e.task_id
        WHERE e.type = 'tool.called'
          AND t.division_id = $1
          AND t.status = 'completed'
          AND e.payload->>'capability' IS NOT NULL
        GROUP BY 1
       HAVING count(*) >= $2
        ORDER BY count(*) DESC`,
      [input.divisionId, minOccurrences],
    );
    return rows.map((row) => ({ capability: row.capability, occurrences: Number(row.occurrences) }));
  });

  const candidates: SopCandidate[] = [];

  for (const pattern of patterns) {
    // A capability that already has a candidate or an approved SOP is not
    // proposed again; the inbox is the scarce resource, not the corpus.
    const existing = await withTenant(input.companyId, async (tx) => {
      const { rows } = await tx.query<{ id: string }>(
        `SELECT id FROM memories
          WHERE memory_type = 'procedural'
            AND scope_id = $1
            AND approval_state IN ('active', 'candidate')
            AND source = $2
          LIMIT 1`,
        [input.divisionId, `pattern:${pattern.capability}`],
      );
      return rows.length > 0;
    });
    if (existing) continue;

    const response = await input.llm.complete({
      model: input.model,
      system:
        'You write a short standard operating procedure for a recurring action. ' +
        'Return plain text: a title line, then numbered steps. Be concrete and brief.',
      messages: [
        {
          role: 'user',
          content:
            `The capability "${pattern.capability}" was used in ${pattern.occurrences} completed ` +
            'tasks by this division. Write the SOP that captures how it should be done.',
        },
      ],
    });

    const created = await withTenant(input.companyId, async (tx) => {
      const memoryId = await remember(tx, {
        companyId: input.companyId,
        memoryType: 'procedural',
        scopeType: 'division',
        scopeId: input.divisionId,
        body: response.content,
        source: `pattern:${pattern.capability}`,
        factKind: 'sop_candidate',
        // F4.5. Not usable until the owner says so.
        approvalState: 'candidate',
        confidence: Math.min(1, pattern.occurrences / 10),
      });

      await appendEvent(tx, {
        companyId: input.companyId,
        projectId: input.projectId,
        type: 'sop.proposed',
        actor: 'system',
        payload: { memoryId, capability: pattern.capability, occurrences: pattern.occurrences },
      });
      return memoryId;
    });

    const inboxItemId = await inbox.proposeSop({
      companyId: input.companyId,
      memoryId: created,
      title: `Proposed SOP for ${pattern.capability}`,
      body: response.content,
      occurrences: pattern.occurrences,
    });

    candidates.push({
      memoryId: created,
      inboxItemId,
      pattern: pattern.capability,
      occurrences: pattern.occurrences,
    });
  }

  return candidates;
}
