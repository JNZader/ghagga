/**
 * LLM-rerank (LOCATE stage 1.5) — given the issue and a noisy tf-idf candidate
 * pool, ask an LLM which ~3 files are truly relevant, using only the filename
 * and a first-matching-line snippet per candidate (cheap, no full-file
 * context needed for this decision). Direct generalization of the biogas
 * PoC's `rerankSeed()` — see biogas-triage.mts. `generateFn` is injected so
 * tests can mock it without a real CLI/LLM call.
 */

import type { GenerateTextFn } from 'ghagga-core';

const RERANK_SYSTEM_PROMPT =
  'You rank source files by relevance to a software issue. Reply with ONLY the numbers of the ' +
  'up-to-3 most relevant files, comma-separated, most relevant first. No prose, no explanation.';

export interface RerankIssueInput {
  title: string;
  body: string;
}

/**
 * Find the first line of `content` matching any keyword (case-insensitive);
 * falls back to the first function-looking line, then to the first line.
 */
export function firstHitLine(content: string, keywords: string[]): string {
  for (const raw of content.split('\n')) {
    const lc = raw.toLowerCase();
    if (keywords.some((k) => lc.includes(k))) return raw.trim().slice(0, 100);
  }
  const funcLine = content.split('\n').find((r) => r.trim().startsWith('func'));
  if (funcLine) return funcLine.trim().slice(0, 100);
  return (content.split('\n')[0] ?? '').trim().slice(0, 100);
}

/**
 * Rerank `pool` (already-scored candidate paths) down to the ~3 most
 * relevant, via `generateFn`. Falls back to the top-3 of `pool` (unchanged
 * order) if the pool is already <=3, the call throws, or the model's reply
 * cannot be parsed into any valid picks.
 */
export async function rerankSeed(
  issue: RerankIssueInput,
  pool: string[],
  files: Map<string, string>,
  keywords: string[],
  generateFn: GenerateTextFn,
): Promise<string[]> {
  if (pool.length <= 3) return pool;

  const list = pool
    .map((f, i) => `${i + 1}. ${f}\n     ${firstHitLine(files.get(f) ?? '', keywords)}`)
    .join('\n');

  let text = '';
  try {
    const result = await generateFn(
      RERANK_SYSTEM_PROMPT,
      `Issue: "${issue.title}"\n${issue.body}\n\nCandidate files (filename + a matching line):\n${list}\n\nWhich file numbers are most relevant?`,
    );
    text = result.text;
  } catch {
    return pool.slice(0, 3);
  }

  const picked = (text.match(/\d+/g) ?? [])
    .map((n) => pool[Number(n) - 1])
    .filter((f): f is string => Boolean(f));
  const seed = [...new Set(picked)].slice(0, 3);
  return seed.length ? seed : pool.slice(0, 3);
}
