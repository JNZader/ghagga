#!/usr/bin/env node
/**
 * Post-build asset copier.
 *
 * `tsc` only emits .js/.d.ts and does NOT copy non-TS assets. The semgrep and
 * gitleaks plugins resolve bundled config files relative to their own dist
 * location (dist/tools/plugins/*.js -> ../<file>), so those configs must live in
 * dist/tools/. This script copies them after compilation.
 *
 * Keep this list in sync with any plugin that resolves a bundled asset.
 */
import { copyFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');

/** [sourceRelativeToPackageRoot, destRelativeToPackageRoot] */
const ASSETS = [
  ['src/tools/semgrep-rules.yml', 'dist/tools/semgrep-rules.yml'],
  ['src/tools/gitleaks-config.toml', 'dist/tools/gitleaks-config.toml'],
];

let copied = 0;
for (const [src, dest] of ASSETS) {
  const srcPath = join(root, src);
  const destPath = join(root, dest);
  if (!existsSync(srcPath)) {
    console.error(`[copy-assets] MISSING source: ${src}`);
    process.exitCode = 1;
    continue;
  }
  mkdirSync(dirname(destPath), { recursive: true });
  copyFileSync(srcPath, destPath);
  console.log(`[copy-assets] ${src} -> ${dest}`);
  copied++;
}

console.log(`[copy-assets] copied ${copied}/${ASSETS.length} asset(s)`);
