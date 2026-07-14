/**
 * parseAction — extracts the next reproduction action the LLM emitted from
 * its raw text reply. LLM replies are not guaranteed to be bare JSON (models
 * sometimes wrap the object in prose despite instruction) — this is a direct
 * generalization of the PoC's `parseAction()` (biogas-repro.mts).
 */

export interface ReproAction {
  action: 'click' | 'fill' | 'done';
  role?: string;
  name?: string;
  value?: string;
  near?: string;
  /** set by the harness when execution of this action threw */
  failed?: boolean;
}

/**
 * Extracts the first `{...}` JSON object found anywhere in `text` and parses
 * it as a `ReproAction`. Returns `null` when no JSON object is present, the
 * JSON is malformed, or the parsed value lacks a valid `action` field.
 */
export function parseAction(text: string): ReproAction | null {
  const match = text.match(/\{[\s\S]*?\}/);
  if (!match) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(match[0]);
  } catch {
    return null;
  }

  if (typeof parsed !== 'object' || parsed === null) return null;
  const candidate = parsed as Record<string, unknown>;
  if (typeof candidate.action !== 'string') return null;

  return candidate as unknown as ReproAction;
}
