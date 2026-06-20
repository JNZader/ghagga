import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { checkForgeBoundary } from './lint-boundary.js';

/**
 * Runs the boundary checker against the ACTUAL `packages/forge/src` tree (not
 * synthetic strings). This catches a real value-import regression the moment it
 * lands — e.g. someone dropping `import type` for a plain `import` from core.
 */
const SRC_DIR = dirname(fileURLToPath(import.meta.url));

function collectSources(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...collectSources(full));
    } else if (/\.tsx?$/.test(entry.name) && !/\.(test|spec)\.tsx?$/.test(entry.name)) {
      out.push(full);
    }
  }
  return out;
}

describe('forge-boundary against REAL source files (R-AGNOSTIC)', () => {
  const files = collectSources(SRC_DIR);

  it('scans at least the known source files', () => {
    expect(files.length).toBeGreaterThan(0);
  });

  it.each(files.map((f) => [f] as const))('%s has zero boundary violations', (file) => {
    const violations = checkForgeBoundary(readFileSync(file, 'utf8'));
    expect(violations).toEqual([]);
  });
});
