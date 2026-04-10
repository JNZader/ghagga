import { describe, expect, it } from 'vitest';
import { buildReverseDependencyMap, findDependents } from './reverse-deps.js';

// ─── Fixtures ────────────────────────────────────────────────────

const FILES = {
  'src/utils.ts': `export function helper(): void {}`,
  'src/service.ts': `import { helper } from "./utils";\nexport function doWork(): void {}`,
  'src/controller.ts': `import { doWork } from "./service";\nexport function handle(): void {}`,
  'src/middleware.ts': `import { helper } from "./utils";\nexport function mid(): void {}`,
  'src/standalone.ts': `export function alone(): void {}`,
  'src/deep.ts': `import { handle } from "./controller";\nexport function deep(): void {}`,
};

function makeContents(files: Record<string, string>): Map<string, string> {
  return new Map(Object.entries(files));
}

// ─── Tests ───────────────────────────────────────────────────────

describe('buildReverseDependencyMap', () => {
  const filePaths = Object.keys(FILES);
  const fileContents = makeContents(FILES);

  it('maps files that import utils.ts', () => {
    const depMap = buildReverseDependencyMap(filePaths, fileContents);

    expect(depMap['src/utils.ts']).toContain('src/service.ts');
    expect(depMap['src/utils.ts']).toContain('src/middleware.ts');
  });

  it('maps files that import service.ts', () => {
    const depMap = buildReverseDependencyMap(filePaths, fileContents);

    expect(depMap['src/service.ts']).toContain('src/controller.ts');
  });

  it('standalone file has no dependents', () => {
    const depMap = buildReverseDependencyMap(filePaths, fileContents);

    expect(depMap['src/standalone.ts']).toHaveLength(0);
  });

  it('handles require() imports', () => {
    const files = {
      'lib/util.js': `module.exports = { fn: () => {} }`,
      'lib/app.js': `const { fn } = require("./util");\nfn();`,
    };
    const depMap = buildReverseDependencyMap(Object.keys(files), makeContents(files));

    expect(depMap['lib/util.js']).toContain('lib/app.js');
  });

  it('handles dynamic import()', () => {
    const files = {
      'src/mod.ts': `export const x = 1`,
      'src/loader.ts': `const m = await import("./mod");`,
    };
    const depMap = buildReverseDependencyMap(Object.keys(files), makeContents(files));

    expect(depMap['src/mod.ts']).toContain('src/loader.ts');
  });

  it('does not include self-imports', () => {
    const depMap = buildReverseDependencyMap(filePaths, fileContents);

    for (const [file, deps] of Object.entries(depMap)) {
      expect(deps).not.toContain(file);
    }
  });

  it('handles empty fileContents', () => {
    const depMap = buildReverseDependencyMap(filePaths, new Map());

    for (const deps of Object.values(depMap)) {
      expect(deps).toHaveLength(0);
    }
  });
});

describe('findDependents', () => {
  const filePaths = Object.keys(FILES);
  const fileContents = makeContents(FILES);

  it('finds direct dependents of utils.ts', () => {
    const depMap = buildReverseDependencyMap(filePaths, fileContents);
    const result = findDependents('src/utils.ts', depMap, 1);

    expect(result.target).toBe('src/utils.ts');
    expect(result.dependents).toContain('src/service.ts');
    expect(result.dependents).toContain('src/middleware.ts');
  });

  it('finds transitive dependents with maxDepth=2', () => {
    const depMap = buildReverseDependencyMap(filePaths, fileContents);
    const result = findDependents('src/utils.ts', depMap, 2);

    // service.ts imports utils, and controller.ts imports service.ts
    expect(result.dependents).toContain('src/controller.ts');
  });

  it('finds transitive dependents with maxDepth=3', () => {
    const depMap = buildReverseDependencyMap(filePaths, fileContents);
    const result = findDependents('src/utils.ts', depMap, 3);

    // deep.ts imports controller.ts which imports service.ts which imports utils.ts
    expect(result.dependents).toContain('src/deep.ts');
  });

  it('returns empty for standalone file', () => {
    const depMap = buildReverseDependencyMap(filePaths, fileContents);
    const result = findDependents('src/standalone.ts', depMap);

    expect(result.dependents).toHaveLength(0);
    expect(result.transitiveCount).toBe(0);
  });

  it('respects maxDepth=1', () => {
    const depMap = buildReverseDependencyMap(filePaths, fileContents);
    const result = findDependents('src/utils.ts', depMap, 1);

    // controller.ts is 2 levels away — should NOT appear at depth 1
    expect(result.dependents).not.toContain('src/controller.ts');
  });

  it('transitiveCount matches dependents length', () => {
    const depMap = buildReverseDependencyMap(filePaths, fileContents);
    const result = findDependents('src/utils.ts', depMap, 3);

    expect(result.transitiveCount).toBe(result.dependents.length);
  });

  it('handles unknown target gracefully', () => {
    const depMap = buildReverseDependencyMap(filePaths, fileContents);
    const result = findDependents('src/nonexistent.ts', depMap);

    expect(result.dependents).toHaveLength(0);
    expect(result.target).toBe('src/nonexistent.ts');
  });
});
