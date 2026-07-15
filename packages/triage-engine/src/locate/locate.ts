/**
 * LOCATE — orchestrates keywords -> scan -> rerank -> expand into a bounded
 * code-context file pool for the TRIAGE stage. Ties together the pure
 * stages from keywords.ts/scan.ts/rerank.ts/expand.ts per design.md's
 * `locate/` module.
 */

import type { GenerateTextFn } from 'ghagga-core';
import type { TriageConfig } from '../config/schema.js';
import { expand } from './expand.js';
import { extractKeywords } from './keywords.js';
import { rerankSeed } from './rerank.js';
import { scoreCandidates, walkCodeScope } from './scan.js';

export interface LocateIssueInput {
  title: string;
  body: string;
  labels: string[];
}

export interface LocateResult {
  keywords: string[];
  candidates: string[];
  seeds: string[];
  contextFiles: string[];
  files: Map<string, string>;
}

/** Extract the módulo/module label from GitLab-style `módulo::x` / `modulo::x` labels. */
function moduleFromLabels(labels: string[]): string {
  const match = labels.find(
    (l) => l.startsWith('módulo::') || l.startsWith('modulo::') || l.startsWith('module::'),
  );
  return match ? (match.split('::')[1] ?? '') : '';
}

/**
 * Run the full LOCATE pipeline for one issue.
 *
 * @param issue - normalized issue fields (title/body/labels)
 * @param config - resolved TriageConfig (moduleMap, codeRoot, language, synonyms, stopwords, graphExpand)
 * @param rerankFn - GenerateTextFn used ONLY for stage 1.5 (candidate rerank)
 */
export async function locate(
  issue: LocateIssueInput,
  config: TriageConfig,
  rerankFn: GenerateTextFn,
): Promise<LocateResult> {
  const mod = moduleFromLabels(issue.labels);
  const keywords = extractKeywords({
    title: issue.title,
    body: issue.body,
    moduleLabel: mod,
    stopwords: config.stopwords,
    synonyms: config.synonyms,
  });

  const dirs =
    (config.moduleMap?.[mod]?.length ? config.moduleMap[mod] : undefined) ??
    defaultScopeDirs(config);
  const files = walkCodeScope(config.codeRoot, dirs, config.language);

  const scored = scoreCandidates(files, keywords, 12);
  const candidates = scored.map((c) => c.path);

  const seeds = await rerankSeed(issue, candidates, files, keywords, rerankFn);

  const contextFiles = await expand(seeds, files, config, { maxFiles: 10 });

  return { keywords, candidates, seeds, contextFiles, files };
}

/** Fallback scope when no moduleMap entry matches: scan every dir in moduleMap plus codeRoot itself. */
function defaultScopeDirs(config: TriageConfig): string[] {
  const allMapped = Object.values(config.moduleMap ?? {}).flat();
  return allMapped.length ? [...new Set(allMapped)] : ['.'];
}
