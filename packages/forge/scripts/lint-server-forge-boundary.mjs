#!/usr/bin/env node
/**
 * lint:server-forge-boundary runner (SDD forge-agnostic 1.6+).
 *
 * Closes the NAMESPACE-IMPORT BYPASS that Biome's `noRestrictedImports` cannot
 * see (P1 4vr Codex contrarian finding). Biome only blocks NAMED imports of the
 * 11 @internal client.ts forge-adapter fns. A file doing
 *   `import * as gh from '../github/client.js'; gh.fetchPRDiff(...)`
 * sails right past Biome — making the factory's "sole sanctioned consumer"
 * guarantee theater. This runner globs the REAL `apps/server/src/**\/*.ts(x)`
 * tree and runs {@link checkServerForgeClientBoundary} on each file, catching
 * BOTH named imports AND namespace-alias member access of the banned fns.
 *
 * Dependency-free (recursive `fs.readdirSync`, same spirit as the sibling
 * lint-boundary.mjs runner). Exits non-zero if ANY non-sanctioned file touches a
 * banned fn.
 *
 * SANCTIONED CONSUMERS (excluded by path):
 *   - apps/server/src/github/forge-adapter-factory.ts  (the composition root)
 *   - test files (`*.test.ts`, `*.spec.ts`) and `__integration__/**`
 *   - client.ts itself (it DEFINES the fns)
 */
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkServerForgeClientBoundary } from '../src/lint-boundary.impl.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
// packages/forge/scripts → repo root → apps/server/src
const SERVER_SRC_DIR = resolve(__dirname, '..', '..', '..', 'apps', 'server', 'src');

/** Path fragments (POSIX-normalized) that mark a SANCTIONED / excluded file. */
function isExcluded(posixPath) {
  return (
    posixPath.endsWith('/github/forge-adapter-factory.ts') ||
    posixPath.endsWith('/github/client.ts') ||
    posixPath.includes('/__integration__/') ||
    /\.(test|spec)\.tsx?$/.test(posixPath)
  );
}

/** Recursively collect non-excluded `.ts`/`.tsx` files under `dir`. */
function collectSources(dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...collectSources(full));
    } else if (/\.tsx?$/.test(entry.name)) {
      out.push(full);
    }
  }
  return out;
}

let total = 0;
for (const file of collectSources(SERVER_SRC_DIR)) {
  const posixPath = file.split('\\').join('/');
  if (isExcluded(posixPath)) {
    continue;
  }
  const violations = checkServerForgeClientBoundary(posixPath, readFileSync(file, 'utf8'));
  for (const v of violations) {
    total += 1;
    console.error(`${v.module} — ${v.reason}`);
  }
}

if (total > 0) {
  console.error(
    `\nlint:server-forge-boundary FAILED — ${total} forge-adapter boundary violation(s).`,
  );
  process.exit(1);
}
console.log('lint:server-forge-boundary OK — no forge-adapter boundary bypasses.');
