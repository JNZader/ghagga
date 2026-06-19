#!/usr/bin/env node
/**
 * lint:boundary runner.
 *
 * Globs the REAL `packages/forge/src/**\/*.ts(x)` files (dependency-free,
 * recursive `fs.readdirSync` — no glob package needed, matching the
 * "dependency-free scanner" spirit of lint-boundary.ts), runs
 * {@link checkForgeBoundary} on each file's contents, prints any violations, and
 * exits non-zero if ANY file violates the R-AGNOSTIC import boundary.
 *
 * This is what turns the boundary checker from a unit-tested pure function into
 * a REAL gate that runs against the actual source tree (P0 fix F2).
 */
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
// Import the TS source directly — Node 23+ strips types at runtime, so no build
// step is required for the gate to run (keeps lint:boundary build-independent).
import { checkForgeBoundary } from '../src/lint-boundary.ts';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SRC_DIR = resolve(__dirname, '..', 'src');

/** Recursively collect `.ts`/`.tsx` files under `dir` (excludes test files). */
function collectSources(dir) {
  const out = [];
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

let total = 0;
for (const file of collectSources(SRC_DIR)) {
  const violations = checkForgeBoundary(readFileSync(file, 'utf8'));
  for (const v of violations) {
    total += 1;
    console.error(`${file}: ${v.module} — ${v.reason}`);
  }
}

if (total > 0) {
  console.error(`\nlint:boundary FAILED — ${total} R-AGNOSTIC violation(s).`);
  process.exit(1);
}
console.log('lint:boundary OK — no R-AGNOSTIC violations.');
