/**
 * Tests for formatGraphNeighborhoodContext — the budgeted, freshness-tiered
 * formatter for file neighborhoods (graph-context-retrieval Slice 2).
 *
 * Budget mechanics mirror the code-intel precedent (code-intel/context.ts):
 * accumulate sections at CHARS_PER_TOKEN=4, truncation notice when the
 * budget is exceeded. Freshness tiers: 'exact' renders symbols, 'file-level'
 * renders paths+counts only with an "older commit" header and NO symbol
 * names.
 */

import { describe, expect, it } from 'vitest';
import {
  DEFAULT_GRAPH_CONTEXT_MAX_TOKENS,
  formatGraphNeighborhoodContext,
} from './neighborhood-format.js';
import type { FileNeighborhood } from './neighbors.js';

// ─── Fixture helpers ────────────────────────────────────────────

function makeHood(overrides: Partial<FileNeighborhood> = {}): FileNeighborhood {
  return {
    file: 'src/a.ts',
    importers: ['src/b.ts'],
    importees: ['src/dep.ts'],
    exportedSymbols: ['alpha', 'beta'],
    importedSymbolEdges: 1,
    isTest: false,
    truncated: false,
    ...overrides,
  };
}

// ─── Tests ──────────────────────────────────────────────────────

describe('formatGraphNeighborhoodContext', () => {
  it('returns empty string for empty input', () => {
    expect(formatGraphNeighborhoodContext([], { maxTokens: 100, freshness: 'exact' })).toBe('');
  });

  describe("freshness: 'exact' renders symbols", () => {
    it('renders importers, importees and exported symbols', () => {
      const out = formatGraphNeighborhoodContext([makeHood()], {
        maxTokens: 500,
        freshness: 'exact',
      });
      expect(out).toContain('src/a.ts');
      expect(out).toContain('src/b.ts');
      expect(out).toContain('src/dep.ts');
      expect(out).toContain('alpha');
      expect(out).toContain('beta');
    });

    it('renders the symbol-named-imports note only for symbol-dense files', () => {
      const dense = formatGraphNeighborhoodContext([makeHood({ importedSymbolEdges: 2 })], {
        maxTokens: 500,
        freshness: 'exact',
      });
      expect(dense).toContain('symbol');

      const sparse = formatGraphNeighborhoodContext([makeHood({ importedSymbolEdges: 0 })], {
        maxTokens: 500,
        freshness: 'exact',
      });
      // Symbol-sparse file: imports and exports only — NO symbol note and
      // NO placeholder symbol text.
      expect(sparse).toContain('src/dep.ts');
      expect(sparse).toContain('alpha');
      expect(sparse).not.toContain('symbol-named');
      expect(sparse).not.toMatch(/symbol[s]?:\s*(none|n\/a|—)/i);
    });

    it('marks test files', () => {
      const out = formatGraphNeighborhoodContext([makeHood({ isTest: true })], {
        maxTokens: 500,
        freshness: 'exact',
      });
      expect(out).toMatch(/test/i);
    });

    it('notes per-file cap truncation', () => {
      const out = formatGraphNeighborhoodContext([makeHood({ truncated: true })], {
        maxTokens: 500,
        freshness: 'exact',
      });
      expect(out).toMatch(/truncated/i);
    });

    it('renders no placeholder text for a file with no neighbors at all', () => {
      const out = formatGraphNeighborhoodContext(
        [makeHood({ importers: [], importees: [], exportedSymbols: [], importedSymbolEdges: 0 })],
        { maxTokens: 500, freshness: 'exact' },
      );
      expect(out).toContain('src/a.ts');
      expect(out).not.toMatch(/none|N\/A/i);
    });
  });

  describe("freshness: 'file-level' renders paths and counts only", () => {
    it('renders file paths and neighbor counts', () => {
      const out = formatGraphNeighborhoodContext(
        [
          makeHood({
            importers: ['src/b.ts', 'src/c.ts'],
            importees: ['src/dep.ts'],
          }),
        ],
        { maxTokens: 500, freshness: 'file-level' },
      );
      expect(out).toContain('src/a.ts');
      expect(out).toMatch(/2 importer/i);
      expect(out).toMatch(/1 import/i);
    });

    it('carries the older-commit header', () => {
      const out = formatGraphNeighborhoodContext([makeHood()], {
        maxTokens: 500,
        freshness: 'file-level',
      });
      expect(out).toMatch(/older commit/i);
    });

    it('contains NO symbol names', () => {
      const out = formatGraphNeighborhoodContext([makeHood()], {
        maxTokens: 500,
        freshness: 'file-level',
      });
      expect(out).not.toContain('alpha');
      expect(out).not.toContain('beta');
    });
  });

  describe('budget boundaries', () => {
    it('fits: no truncation notice when everything is under the cap', () => {
      const out = formatGraphNeighborhoodContext([makeHood()], {
        maxTokens: 500,
        freshness: 'exact',
      });
      expect(out).not.toMatch(/budget/i);
    });

    it('exactly-over: drops the entry that crosses the cap and emits a notice', () => {
      // Derive the exact rendered sizes from an unbudgeted run, then set a
      // budget that fits exactly ONE entry (header + entry1) but not two.
      const one = formatGraphNeighborhoodContext([makeHood({ file: 'src/one.ts' })], {
        maxTokens: 1_000_000,
        freshness: 'exact',
      });
      const two = formatGraphNeighborhoodContext(
        [makeHood({ file: 'src/one.ts' }), makeHood({ file: 'src/two.ts' })],
        { maxTokens: 1_000_000, freshness: 'exact' },
      );
      const entryChars = two.length - one.length - 1; // minus the join '\n'
      const headerChars = one.length - 1 - entryChars; // one = header + '\n' + entry
      const maxTokens = Math.ceil((headerChars + entryChars) / 4);

      const out = formatGraphNeighborhoodContext(
        [makeHood({ file: 'src/one.ts' }), makeHood({ file: 'src/two.ts' })],
        { maxTokens, freshness: 'exact' },
      );
      expect(out).toContain('src/one.ts');
      expect(out).not.toContain('src/two.ts');
      expect(out).toMatch(/truncated/i);
      expect(out).toMatch(/1 of 2/i);
    });

    it('cap-clamp: zero budget renders no entries', () => {
      const out = formatGraphNeighborhoodContext([makeHood()], {
        maxTokens: 0,
        freshness: 'exact',
      });
      expect(out).toBe('');
    });

    it('default cap is 1,200 tokens', () => {
      expect(DEFAULT_GRAPH_CONTEXT_MAX_TOKENS).toBe(1200);
    });

    it('output stays within the char budget (notice aside)', () => {
      const hoods: FileNeighborhood[] = Array.from({ length: 30 }, (_, i) =>
        makeHood({ file: `src/file${i}.ts` }),
      );
      // Derive a budget that fits exactly two entries of thirty: the
      // unbudgeted two-entry rendering length IS the budget need.
      const two = formatGraphNeighborhoodContext(
        [hoods[0] as FileNeighborhood, hoods[1] as FileNeighborhood],
        { maxTokens: 1_000_000, freshness: 'exact' },
      );
      const maxTokens = Math.ceil(two.length / 4);

      const out = formatGraphNeighborhoodContext(hoods, { maxTokens, freshness: 'exact' });
      // The truncation notice is appended after the cut; the rendered
      // entries themselves must fit the budget.
      const noticeMatch = /(_\(graph neighborhood truncated[^\n]*\)_)$/.exec(out);
      expect(noticeMatch).not.toBeNull();
      const renderedChars = out.length - (noticeMatch?.[1]?.length ?? 0);
      expect(renderedChars).toBeLessThanOrEqual(maxTokens * 4);
      expect(out).toMatch(/2 of 30/);
    });
  });
});
