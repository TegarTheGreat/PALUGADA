/**
 * A JSON object out of a model's words.
 *
 * A model asked for JSON writes a sentence before it, or fences it, or both.
 * The agent loop reads its output this way and so does the distiller: a reply
 * refused for being dressed leaves the work where it was, and the same
 * growing window is sent to the model again at the next pass (the audit of 6
 * October, M7). Null when there is no object in it, so a caller can ask once
 * more rather than fail the work over a model that wrote a sentence first.
 */
export function outputFrom(text: string): Record<string, unknown> | null {
  const candidates = [text.trim()];
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(text);
  if (fenced) candidates.push(fenced[1]!.trim());
  const first = text.indexOf('{');
  const last = text.lastIndexOf('}');
  if (first !== -1 && last > first) candidates.push(text.slice(first, last + 1));
  for (const candidate of candidates) {
    try {
      const value: unknown = JSON.parse(candidate);
      if (value && typeof value === 'object' && !Array.isArray(value)) return value as Record<string, unknown>;
    } catch {
      // The next candidate.
    }
  }
  return null;
}

