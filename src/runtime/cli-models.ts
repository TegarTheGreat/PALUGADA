/**
 * What a role's model means to an agent CLI.
 *
 * A role names a tier -- `fast`, `standard`, `deep` -- and the platform's own
 * model clients turn it into a model (src/llm/models.ts). An agent CLI was
 * handed the tier as written, `--model standard`, which no CLI knows: every
 * template role put on one failed at its first run with the CLI's own
 * complaint about a model called "standard". Each CLI has its own names for
 * its models, so each says what the tiers mean to it, and a tier it has no
 * meaning for is refused before anything is spawned, naming the setting --
 * as `model.unavailable`, so the task halts and the owner is told, rather than
 * spending its attempts on a model that will not exist the next time either.
 */
import { PalugadaError } from '../errors.ts';

const TIERS: ReadonlySet<string> = new Set(['fast', 'standard', 'deep']);

export function cliModelFor(runtime: string, asked: string, models: Readonly<Record<string, string>> | undefined): string {
  if (!TIERS.has(asked)) return asked;
  const named = models?.[asked];
  if (named) return named;
  throw new PalugadaError('model.unavailable',
    `runtime ${runtime} does not say what the tier ${asked} means to it: name a model for it in the runtime's `
      + `PALUGADA_RUNTIME_SPECS entry, such as [{"name":"${runtime}","models":{"${asked}":"<a model ${runtime} knows>"}}], `
      + 'or give the role a model name instead of a tier', { model: asked });
}
