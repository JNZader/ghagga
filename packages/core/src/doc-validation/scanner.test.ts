import { describe, expect, it } from 'vitest';
import type { DiffFile } from '../utils/diff.js';
import { extractChangedSymbols, isDocFile, scanDocsForSymbols } from './scanner.js';

// ─── extractChangedSymbols ────────────────────────────────────

describe('extractChangedSymbols', () => {
  it('extracts TypeScript function declarations from added lines', () => {
    const diff = [
      'diff --git a/src/pipeline.ts b/src/pipeline.ts',
      '--- a/src/pipeline.ts',
      '+++ b/src/pipeline.ts',
      '@@ -10,5 +10,7 @@',
      '+export function reviewPipeline(input: ReviewInput): Promise<ReviewResult> {',
      '+  const startTime = Date.now();',
      '+}',
    ].join('\n');

    const symbols = extractChangedSymbols(diff);
    expect(symbols).toContain('reviewPipeline');
  });

  it('extracts async function declarations', () => {
    const diff = ['+async function fetchData(url: string) {'].join('\n');

    const symbols = extractChangedSymbols(diff);
    expect(symbols).toContain('fetchData');
  });

  it('extracts class declarations', () => {
    const diff = ['+export class AuthService {', '+  constructor() {}', '+}'].join('\n');

    const symbols = extractChangedSymbols(diff);
    expect(symbols).toContain('AuthService');
  });

  it('extracts interface declarations', () => {
    const diff = ['+export interface ReviewInput {', '+  diff: string;', '+}'].join('\n');

    const symbols = extractChangedSymbols(diff);
    expect(symbols).toContain('ReviewInput');
  });

  it('extracts type alias declarations', () => {
    const diff = ['+export type ReviewMode = "simple" | "workflow";'].join('\n');

    const symbols = extractChangedSymbols(diff);
    expect(symbols).toContain('ReviewMode');
  });

  it('extracts arrow function variables', () => {
    const diff = ['+export const validateInput = (input: ReviewInput) => {'].join('\n');

    const symbols = extractChangedSymbols(diff);
    expect(symbols).toContain('validateInput');
  });

  it('extracts Python function definitions', () => {
    const diff = ['+def process_review(data):', '+    return data'].join('\n');

    const symbols = extractChangedSymbols(diff);
    expect(symbols).toContain('process_review');
  });

  it('extracts Go function declarations', () => {
    const diff = ['+func HandleRequest(w http.ResponseWriter, r *http.Request) {'].join('\n');

    const symbols = extractChangedSymbols(diff);
    expect(symbols).toContain('HandleRequest');
  });

  it('extracts Go method declarations', () => {
    const diff = ['+func (s *Server) ServeHTTP(w http.ResponseWriter, r *http.Request) {'].join(
      '\n',
    );

    const symbols = extractChangedSymbols(diff);
    expect(symbols).toContain('ServeHTTP');
  });

  it('filters symbols shorter than 3 characters', () => {
    const diff = ['+func go() {', '+def fn():'].join('\n');

    const symbols = extractChangedSymbols(diff);
    expect(symbols).not.toContain('go');
    expect(symbols).not.toContain('fn');
  });

  it('deduplicates symbols', () => {
    const diff = ['+function validate() {', '+function validate() {'].join('\n');

    const symbols = extractChangedSymbols(diff);
    expect(symbols.filter((s) => s === 'validate')).toHaveLength(1);
  });

  it('ignores removed lines (starting with -)', () => {
    const diff = ['-function oldFunction() {', '+function newFunction() {'].join('\n');

    const symbols = extractChangedSymbols(diff);
    expect(symbols).not.toContain('oldFunction');
    expect(symbols).toContain('newFunction');
  });

  it('ignores +++ header lines', () => {
    const diff = ['+++ b/src/function.ts'].join('\n');

    const symbols = extractChangedSymbols(diff);
    expect(symbols).toHaveLength(0);
  });

  it('returns empty array for empty diff', () => {
    expect(extractChangedSymbols('')).toEqual([]);
  });

  it('returns empty array for diff with no symbol declarations', () => {
    const diff = ['+  console.log("hello");', '+  const x = 42;'].join('\n');

    // x is only 1 char, filtered out
    const symbols = extractChangedSymbols(diff);
    expect(symbols).toEqual([]);
  });
});

// ─── isDocFile ────────────────────────────────────────────────

describe('isDocFile', () => {
  it('identifies markdown files', () => {
    expect(isDocFile('docs/README.md')).toBe(true);
    expect(isDocFile('CHANGELOG.md')).toBe(true);
  });

  it('identifies mdx files', () => {
    expect(isDocFile('docs/guide.mdx')).toBe(true);
  });

  it('identifies rst files', () => {
    expect(isDocFile('docs/api.rst')).toBe(true);
  });

  it('rejects non-doc files', () => {
    expect(isDocFile('src/pipeline.ts')).toBe(false);
    expect(isDocFile('package.json')).toBe(false);
  });

  it('rejects files without extension', () => {
    expect(isDocFile('Makefile')).toBe(false);
  });
});

// ─── scanDocsForSymbols ──────────────────────────────────────

describe('scanDocsForSymbols', () => {
  const makeDocFile = (path: string, content: string): DiffFile => ({
    path,
    additions: 0,
    deletions: 0,
    content,
  });

  it('detects backtick references to changed symbols', () => {
    const symbols = ['reviewPipeline'];
    const allFiles: DiffFile[] = [
      makeDocFile('docs/architecture.md', 'The `reviewPipeline` function handles reviews.'),
    ];

    const result = scanDocsForSymbols(symbols, allFiles, []);
    expect(result.staleReferences).toHaveLength(1);
    expect(result.staleReferences[0]?.symbol).toBe('reviewPipeline');
    expect(result.staleReferences[0]?.file).toBe('docs/architecture.md');
  });

  it('detects backtick references with parentheses', () => {
    const symbols = ['reviewPipeline'];
    const allFiles: DiffFile[] = [makeDocFile('docs/api.md', 'Call `reviewPipeline()` to start.')];

    const result = scanDocsForSymbols(symbols, allFiles, []);
    expect(result.staleReferences).toHaveLength(1);
  });

  it('does not flag docs that were also changed', () => {
    const symbols = ['reviewPipeline'];
    const allFiles: DiffFile[] = [
      makeDocFile('docs/architecture.md', 'The `reviewPipeline` function handles reviews.'),
    ];
    const changedFiles = ['docs/architecture.md'];

    const result = scanDocsForSymbols(symbols, allFiles, changedFiles);
    expect(result.staleReferences).toHaveLength(0);
  });

  it('returns empty results when no symbols provided', () => {
    const allFiles: DiffFile[] = [
      makeDocFile('docs/readme.md', 'Some content with `reviewPipeline`'),
    ];

    const result = scanDocsForSymbols([], allFiles, []);
    expect(result.changedSymbols).toEqual([]);
    expect(result.staleReferences).toEqual([]);
    expect(result.docsScanned).toBe(0);
  });

  it('skips non-doc files', () => {
    const symbols = ['reviewPipeline'];
    const allFiles: DiffFile[] = [makeDocFile('src/pipeline.ts', 'function reviewPipeline() {}')];

    const result = scanDocsForSymbols(symbols, allFiles, []);
    expect(result.docsScanned).toBe(0);
    expect(result.staleReferences).toHaveLength(0);
  });

  it('detects plain word-boundary references', () => {
    const symbols = ['ReviewInput'];
    const allFiles: DiffFile[] = [
      makeDocFile('docs/types.md', 'The ReviewInput interface defines the contract.'),
    ];

    const result = scanDocsForSymbols(symbols, allFiles, []);
    expect(result.staleReferences).toHaveLength(1);
    expect(result.staleReferences[0]?.symbol).toBe('ReviewInput');
  });

  it('reports correct line numbers', () => {
    const symbols = ['validate'];
    const content = 'line 1\nline 2\nThe validate function\nline 4';
    const allFiles: DiffFile[] = [makeDocFile('docs/api.md', content)];

    const result = scanDocsForSymbols(symbols, allFiles, []);
    expect(result.staleReferences).toHaveLength(1);
    expect(result.staleReferences[0]?.line).toBe(3);
  });

  it('scans external doc contents not in diff', () => {
    const symbols = ['handleAuth'];
    const allFiles: DiffFile[] = []; // no docs in the diff
    const docContents = new Map([['docs/auth.md', 'Use `handleAuth` for authentication.']]);

    const result = scanDocsForSymbols(symbols, allFiles, [], docContents);
    expect(result.staleReferences).toHaveLength(1);
    expect(result.staleReferences[0]?.file).toBe('docs/auth.md');
    expect(result.docsScanned).toBe(1);
  });

  it('counts all scanned doc files', () => {
    const symbols = ['something'];
    const allFiles: DiffFile[] = [
      makeDocFile('docs/a.md', 'no refs here'),
      makeDocFile('docs/b.md', 'no refs here either'),
      makeDocFile('src/code.ts', 'not a doc'),
    ];

    const result = scanDocsForSymbols(symbols, allFiles, []);
    expect(result.docsScanned).toBe(2);
  });

  it('handles multiple symbols and multiple docs', () => {
    const symbols = ['funcA', 'funcB'];
    const allFiles: DiffFile[] = [
      makeDocFile('docs/a.md', 'Uses `funcA` here.'),
      makeDocFile('docs/b.md', 'Uses `funcB` here.'),
    ];

    const result = scanDocsForSymbols(symbols, allFiles, []);
    expect(result.staleReferences).toHaveLength(2);
    expect(result.changedSymbols).toEqual(['funcA', 'funcB']);
  });
});
