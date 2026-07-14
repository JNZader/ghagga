import { describe, expect, it } from 'vitest';
import { expand, GRAPH_RESOLVABLE_LANGUAGES } from './expand.js';

describe('expand', () => {
  it('returns [] for an empty seed set', () => {
    expect(expand([], new Map(), { graphExpand: false, language: 'go' })).toEqual([]);
  });

  it('dir-sibling: expands multi-seed dir-siblings up to the cap', () => {
    const files = new Map<string, string>([
      ['pkg/a/one.go', 'x'],
      ['pkg/a/two.go', 'x'],
      ['pkg/a/three.go', 'x'],
      ['pkg/b/four.go', 'x'],
      ['pkg/b/five.go', 'x'],
      ['pkg/c/unrelated.go', 'x'],
    ]);
    const result = expand(['pkg/a/one.go', 'pkg/b/four.go'], files, {
      graphExpand: false,
      language: 'go',
    });

    expect(result).toContain('pkg/a/one.go');
    expect(result).toContain('pkg/a/two.go');
    expect(result).toContain('pkg/a/three.go');
    expect(result).toContain('pkg/b/four.go');
    expect(result).toContain('pkg/b/five.go');
    expect(result).not.toContain('pkg/c/unrelated.go');
  });

  it('dir-sibling: caps total returned files at maxFiles', () => {
    const files = new Map<string, string>();
    for (let i = 0; i < 20; i++) files.set(`pkg/a/f${i}.go`, 'x');
    const result = expand(
      ['pkg/a/f0.go'],
      files,
      { graphExpand: false, language: 'go' },
      { maxFiles: 5 },
    );
    expect(result.length).toBeLessThanOrEqual(5);
  });

  it('Go: ALWAYS uses dir-sibling, even if graphExpand=true (regression guard)', () => {
    const files = new Map<string, string>([
      ['pkg/seed/seed.go', 'package seed\n\nfunc Seed() int { return 1 }\n'],
      [
        'pkg/dependent/dependent.go',
        'package dependent\n\nimport "example.com/mod/pkg/seed"\n\nfunc Dependent() int { return seed.Seed() }\n',
      ],
      ['pkg/seed/sibling.go', 'package seed\n\nfunc Sibling() int { return 2 }\n'],
    ]);
    const result = expand(['pkg/seed/seed.go'], files, { graphExpand: true, language: 'go' });

    // dir-sibling picks up the same-dir sibling...
    expect(result).toContain('pkg/seed/sibling.go');
    // ...but never the cross-package dependent, because Go isn't graph-resolvable.
    expect(result).not.toContain('pkg/dependent/dependent.go');
  });

  it('TS: graphExpand=true resolves a real dependent via computeBlastRadius', () => {
    const files = new Map<string, string>([
      ['src/seed.ts', 'export function seed(): number { return 1; }\n'],
      ['src/dependent.ts', "import { seed } from './seed';\nexport const x = seed();\n"],
      ['src/other/unrelated.ts', 'export const y = 1;\n'],
    ]);
    const result = expand(['src/seed.ts'], files, { graphExpand: true, language: 'ts' });

    expect(result).toContain('src/dependent.ts');
  });

  it('TS: graphExpand=false stays dir-sibling only (does not pull cross-dir dependents)', () => {
    const files = new Map<string, string>([
      ['src/a/seed.ts', 'export function seed(): number { return 1; }\n'],
      ['src/b/dependent.ts', "import { seed } from '../a/seed';\nexport const x = seed();\n"],
    ]);
    const result = expand(['src/a/seed.ts'], files, { graphExpand: false, language: 'ts' });

    expect(result).not.toContain('src/b/dependent.ts');
  });

  it('GRAPH_RESOLVABLE_LANGUAGES is exactly {ts, js}', () => {
    expect([...GRAPH_RESOLVABLE_LANGUAGES].sort()).toEqual(['js', 'ts']);
  });
});
