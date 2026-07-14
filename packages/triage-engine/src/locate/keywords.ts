/**
 * Keyword extraction (LOCATE stage 0) — pure function.
 *
 * Tokenizes issue title + body + module label, drops stopwords (config or a
 * default Spanish set — the PoC's proven starting point), normalizes accents,
 * and applies an ES→EN synonym bridge so a Spanish-language issue matches
 * English-named source code. Direct generalization of the biogas PoC's
 * `keywords()` — see biogas-triage.mts.
 */

/** Default stopword set (Spanish + a handful of English function words), from the PoC. */
export const DEFAULT_STOPWORDS: readonly string[] = [
  'quise',
  'cambiar',
  'sale',
  'que',
  'con',
  'los',
  'las',
  'una',
  'para',
  'pero',
  'por',
  'del',
  'the',
  'and',
  'me',
  'a',
  'y',
  'de',
  'el',
  'en',
  'un',
  'se',
  'si',
  'ruta',
  'modulo',
  'módulo',
  'viewport',
  'app',
  'esta',
  'este',
  'como',
  'hay',
];

export interface KeywordExtractionInput {
  title: string;
  body: string;
  moduleLabel?: string;
  stopwords?: readonly string[];
  synonyms?: Record<string, readonly string[]>;
}

/** Strip diacritics for stopword/synonym matching (á→a, ñ stays distinguishable via `ph` special-case in the PoC, kept here). */
function normalize(token: string): string {
  return token.normalize('NFD').replace(/[̀-ͯ]/g, '');
}

/**
 * Extract a deduplicated keyword set from issue title/body + a module label.
 *
 * Rules (matching the PoC):
 * - tokenize on `[a-záéíóúñ0-9_]+` (case-insensitive)
 * - drop tokens in the stopword set (checked both raw and accent-normalized)
 * - the module name/label is always kept even if short
 * - tokens shorter than 4 chars are dropped UNLESS they are the module label
 *   or the special-cased 'ph' token (PoC keeps 'ph' as a real domain keyword)
 * - synonyms are expanded: each matched keyword also adds its configured
 *   English synonyms to the result set
 */
export function extractKeywords(input: KeywordExtractionInput): string[] {
  const stopwords = new Set((input.stopwords ?? DEFAULT_STOPWORDS).map((w) => w.toLowerCase()));
  const synonyms = input.synonyms ?? {};
  const moduleLabel = (input.moduleLabel ?? '').toLowerCase().trim();

  const text = `${input.title} ${input.body} ${moduleLabel}`.toLowerCase();
  const set = new Set<string>();

  for (const raw of text.match(/[a-záéíóúñ0-9_]+/gi) ?? []) {
    const clean = normalize(raw);
    if (stopwords.has(clean) || stopwords.has(raw)) continue;
    const isModuleToken = moduleLabel.length > 0 && (raw === moduleLabel || clean === moduleLabel);
    if (clean === 'ph') {
      set.add('ph');
      continue;
    }
    if (clean.length < 4 && !isModuleToken) continue;
    set.add(clean);
    for (const syn of synonyms[clean] ?? []) set.add(syn);
  }

  if (moduleLabel && !stopwords.has(moduleLabel)) {
    set.add(moduleLabel);
  }

  return [...set];
}
