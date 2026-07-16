/**
 * Candidate scoring (LOCATE stage 1) — walk the code scope, tf-idf score by
 * keyword hits, with a filename-match boost (a file NAMED after a keyword
 * ranks far higher than one that merely mentions it in the body). Direct
 * generalization of the biogas PoC's `walkGo`/scoring loop — see
 * biogas-triage.mts — made language-agnostic via a configurable extension set.
 */

import * as nodeFs from 'node:fs';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

/**
 * `fs.globSync` only exists on Node ≥22. We access it lazily off the `nodeFs`
 * namespace (NOT a top-level named `import { globSync }`, which would throw
 * `SyntaxError: does not provide an export named 'globSync'` at MODULE LOAD on
 * Node 20/21, hard-crashing every import of this file before any code runs).
 * Reading it at call time lets the module load everywhere and degrade
 * gracefully: dir/file entries keep working, glob entries are skipped.
 */
type GlobSyncFn = (pattern: string, options: { cwd: string }) => string[];

function getGlobSync(): GlobSyncFn | undefined {
  const fn = (nodeFs as { globSync?: unknown }).globSync;
  return typeof fn === 'function' ? (fn as GlobSyncFn) : undefined;
}

/** Emit the "glob needs Node ≥22" warning at most once per process. */
let warnedGlobUnavailable = false;
function warnGlobUnavailableOnce(): void {
  if (warnedGlobUnavailable) return;
  warnedGlobUnavailable = true;
  console.warn(
    '[triage-engine] fs.globSync is unavailable (requires Node ≥22); ' +
      'glob moduleMap entries are skipped. Directory and file entries still work.',
  );
}

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

/** Glob magic characters that mark a moduleMap entry as a pattern (vs a plain dir/file path). */
const GLOB_MAGIC = /[*?[\]{}]/;

/**
 * Shared inclusion filter for a single file: its extension must match the
 * language and it must not be a test file. Applied IDENTICALLY across the
 * dir-walk, glob, and single-file resolution paths so every entry kind gets
 * the same filtering.
 */
function shouldIncludeFile(fileName: string, extensions: string[]): boolean {
  return extensions.some((ext) => fileName.endsWith(ext)) && !isTestFile(fileName);
}

/**
 * True when any segment of a codeRoot-relative path is an excluded noise dir
 * (node_modules, vendor, .git, …). Used to keep `**` globs from pulling in
 * dependency trees — `walkDir` already skips these via directory recursion.
 */
function hasExcludedSegment(relPath: string): boolean {
  return relPath.split(/[/\\]/).some((seg) => EXCLUDED_DIRS.has(seg));
}

/**
 * Walk `dirs` (relative to `codeRoot`) and read all source files matching
 * `language`'s extensions, excluding tests and common noise directories.
 * Returns a Map of codeRoot-relative path -> file content.
 *
 * Each entry may be:
 *  - a **glob pattern** (contains `* ? [ ] { }`) → resolved with `globSync`
 *    relative to `codeRoot`; matched files get the same extension/test/noise
 *    filtering as the dir walk;
 *  - a **directory** → walked recursively (unchanged legacy behavior);
 *  - a **single file path** → read directly if it passes the filter.
 * Nonexistent, non-glob entries are skipped silently. The `cap` is honored
 * across ALL entries and match kinds.
 */
export function walkCodeScope(
  codeRoot: string,
  dirs: string[],
  language: string,
  cap = 1500,
): Map<string, string> {
  const extensions = LANGUAGE_EXTENSIONS[language] ?? [];
  const acc = new Map<string, string>();
  for (const entry of dirs) {
    if (acc.size >= cap) break;
    if (GLOB_MAGIC.test(entry)) {
      walkGlob(entry, codeRoot, extensions, acc, cap);
    } else {
      const full = path.join(codeRoot, entry);
      let st: ReturnType<typeof statSync>;
      try {
        st = statSync(full);
      } catch {
        continue; // nonexistent entry — skip silently (legacy behavior)
      }
      if (st.isDirectory()) {
        walkDir(full, codeRoot, extensions, acc, cap);
      } else if (shouldIncludeFile(path.basename(full), extensions)) {
        readInto(full, codeRoot, acc);
      }
    }
  }
  return acc;
}

/**
 * Resolve a glob `pattern` against `codeRoot`. `globSync` with `cwd` set
 * returns codeRoot-relative paths (verified: same shape as
 * `path.relative(base, full)`), which become the acc keys directly.
 */
function walkGlob(
  pattern: string,
  codeRoot: string,
  extensions: string[],
  acc: Map<string, string>,
  cap: number,
): void {
  const globSync = getGlobSync();
  if (!globSync) {
    warnGlobUnavailableOnce();
    return; // Node <22: degrade gracefully — skip glob, keep dir/file entries working
  }
  let matches: string[];
  try {
    matches = globSync(pattern, { cwd: codeRoot });
  } catch {
    return;
  }
  for (const rel of matches) {
    if (acc.size >= cap) return;
    if (hasExcludedSegment(rel)) continue;
    if (!shouldIncludeFile(path.basename(rel), extensions)) continue;
    const full = path.join(codeRoot, rel);
    let st: ReturnType<typeof statSync>;
    try {
      st = statSync(full);
    } catch {
      continue;
    }
    if (st.isDirectory()) continue; // glob can match dirs; only ingest files
    readInto(full, codeRoot, acc);
  }
}

/**
 * True when `fullPath` resolves inside `codeRoot`. Enforces the documented
 * "relative to codeRoot" contract: a glob like `../shared/**` or a file entry
 * `../secret.go` resolves OUTSIDE the root and must never be read. If the
 * codeRoot-relative path starts with `..` or is absolute, it escaped.
 */
function isInsideCodeRoot(fullPath: string, codeRoot: string): boolean {
  const rel = path.relative(codeRoot, fullPath);
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
}

/**
 * Read `full` into `acc` under its codeRoot-relative key. Enforces codeRoot
 * containment (paths escaping via `..` are silently skipped, consistent with
 * other skip behavior); unreadable files are skipped.
 */
function readInto(full: string, base: string, acc: Map<string, string>): void {
  if (!isInsideCodeRoot(full, base)) return; // escapes codeRoot — skip
  try {
    acc.set(path.relative(base, full), readFileSync(full, 'utf8'));
  } catch {
    // unreadable file — skip
  }
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
    } else if (shouldIncludeFile(entry, extensions)) {
      readInto(full, base, acc);
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
