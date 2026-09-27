/**
 * What a run was told (0076): the request as its runtime received it, kept
 * with the run for the owner to read.
 *
 * For every runtime. A run whose model calls this process makes itself left
 * its prompts in the traces; a run handed to an agent CLI, a container or an
 * HTTP runtime left nothing of what it was told, and "why did it do that"
 * had no answer. The wire form is kept -- what a third-party runtime is sent
 * -- because it is already the redacted, field-by-field shape, and it is
 * the same whichever runtime ran.
 */
import { withTenant } from '../db/tenant.ts';
import { toWireRequest } from '../runtime/wire.ts';
import type { RunRequest } from '../runtime/protocol.ts';

/**
 * The most of a briefing kept, in characters of JSON. The pack is bounded by
 * F4.8 already; this is the backstop for a working memory that is not.
 */
export const BRIEFING_LIMIT = 400_000;

/** Kept with the run; a fallback's own request replaces the one its model never ran. */
export async function keepBriefing(companyId: string, agentRunId: string, request: RunRequest): Promise<void> {
  const briefing = toWireRequest(request);
  const text = JSON.stringify(briefing);
  const kept = text.length <= BRIEFING_LIMIT ? text : JSON.stringify({ cut: true, characters: text.length, start: text.slice(0, BRIEFING_LIMIT) });
  await withTenant(companyId, (tx) => tx.query('UPDATE agent_runs SET briefing = $2::jsonb WHERE id = $1', [agentRunId, kept]));
}
