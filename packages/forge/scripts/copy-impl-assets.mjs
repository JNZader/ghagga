#!/usr/bin/env node
/**
 * Post-build asset copy.
 *
 * `tsc` does NOT emit plain-JS (`.mjs`) sources unless `allowJs` is on (which we
 * deliberately keep OFF — see lint-boundary.ts / .impl.d.mts). The compiled
 * `dist/lint-boundary.js` re-exports `checkForgeBoundary` from
 * `./lint-boundary.impl.mjs`, so that runtime sibling must exist in dist too.
 * This step copies the hand-authored `.mjs` (and its `.d.mts`) into dist so the
 * built output is self-consistent. Idempotent and dependency-free.
 */
import { copyFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SRC = resolve(__dirname, '..', 'src');
const DIST = resolve(__dirname, '..', 'dist');

const ASSETS = ['lint-boundary.impl.mjs', 'lint-boundary.impl.d.mts'];

for (const asset of ASSETS) {
  const from = join(SRC, asset);
  const to = join(DIST, asset);
  if (!existsSync(from)) {
    console.error(`copy-impl-assets: missing source asset ${from}`);
    process.exit(1);
  }
  mkdirSync(dirname(to), { recursive: true });
  copyFileSync(from, to);
}
console.log(`copy-impl-assets: copied ${ASSETS.length} asset(s) into dist.`);
