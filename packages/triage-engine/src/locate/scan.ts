/**
 * Candidate scoring (LOCATE stage 1) — walk the code scope, tf-idf score by
 * keyword hits, with a filename-match boost (a file NAMED after a keyword
 * ranks far higher than one that merely mentions it in the body). Direct
 * generalization of the biogas PoC's `walkGo`/scoring loop — see
 * biogas-triage.mts — made language-agnostic via a configurable extension set.
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

/** Directories always excluded from the LOCATE scan, mirroring the PoC. */
const EXCLUDED_DIRS = new Set([
  'node_modules',
  '.git',
  'testdata',
  'dist',
  'build',
  '.turbo',
  '.next',
  'vendor',
]);

/** Extensions scanned per language. Test files are excluded via TEST_FILE_SUFFIXES. */
const LANGUAGE_EXTENSIONS: Record<string, string[]> = {
  go: ['.go'],
  ts: ['.ts', '.tsx'],
  js: ['.js', '.jsx'],
  py: ['.py'],
  rust: ['.rs'],
  java: ['.java'],
};

const TEST_FILE_SUFFIXES = [
  '_test.go',
  '.test.ts',
  '.test.tsx',
  '.test.js',
  '.test.jsx',
  '.spec.ts',
  '.spec.js',
];

function isTestFile(fileName: string): boolean {
  return (
    TEST_FILE_SUFFIXES.some((suffix) => fileName.endsWith(suffix)) || fileName.startsWith('test_')
  );
}

/**
 * Walk `dirs` (relative to `codeRoot`) and read all source files matching
 * `language`'s extensions, excluding tests and common noise directories.
 * Returns a Map of codeRoot-relative path -> file content.
 */
export function walkCodeScope(
  codeRoot: string,
  dirs: string[],
  language: string,
  cap = 1500,
): Map<string, string> {
  const extensions = LANGUAGE_EXTENSIONS[language] ?? [];
  const acc = new Map<string, string>();
  for (const dir of dirs) {
    walkDir(path.join(codeRoot, dir), codeRoot, extensions, acc, cap);
  }
  return acc;
}

function walkDir(
  dir: string,
  base: string,
  extensions: string[],
  acc: Map<string, string>,
  cap: number,
): void {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }
  for (const entry of entries) {
    if (acc.size >= cap) return;
    const full = path.join(dir, entry);
    let st: ReturnType<typeof statSync>;
    try {
      st = statSync(full);
    } catch {
      continue;
    }
    if (st.isDirectory()) {
      if (EXCLUDED_DIRS.has(entry)) continue;
      walkDir(full, base, extensions, acc, cap);
    } else if (extensions.some((ext) => entry.endsWith(ext)) && !isTestFile(entry)) {
      try {
        acc.set(path.relative(base, full), readFileSync(full, 'utf8'));
      } catch {
        // unreadable file — skip
      }
    }
  }
}

export interface ScoredCandidate {
  path: string;
  score: number;
}

/**
 * tf-idf score `files` against `keywords`, with a filename-match boost
 * (25x the idf weight, matching the PoC's tuned constant — a file whose
 * basename contains a keyword is a MUCH stronger relevance signal than a
 * body mention). Returns the top `limit` candidates, highest score first.
 * Files with zero score are excluded entirely.
 */
export function scoreCandidates(
  files: Map<string, string>,
  keywords: string[],
  limit = 12,
): ScoredCandidate[] {
  if (files.size === 0 || keywords.length === 0) return [];

  const documentFrequency = new Map<string, number>();
  for (const [, content] of files) {
    const lc = content.toLowerCase();
    for (const k of keywords) {
      if (lc.includes(k)) documentFrequency.set(k, (documentFrequency.get(k) ?? 0) + 1);
    }
  }

  const scored: ScoredCandidate[] = [];
  for (const [rel, content] of files) {
    const lc = content.toLowerCase();
    const name = path.basename(rel, path.extname(rel)).toLowerCase();
    let score = 0;
    for (const k of keywords) {
      const idf = Math.log(1 + files.size / (documentFrequency.get(k) ?? 1));
      const hits = lc.split(k).length - 1;
      if (hits > 0) score += hits * idf;
      if (name.includes(k)) score += 25 * idf;
    }
    if (score > 0) scored.push({ path: rel, score });
  }

  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, limit);
}
