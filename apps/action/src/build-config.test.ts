/**
 * Build-config assertions for the Action's `ncc` bundle (design D7, task 7.3).
 *
 * `@xenova/transformers` is an UNDECLARED optional peer of `ghagga-core`,
 * installed by the user (`pnpm add @xenova/transformers`) only when they opt
 * into the local embedding provider (packages/core/src/embed.ts) — it is NOT a
 * declared dependency, so it never ships (or its vulnerable transitive
 * protobufjs) to installs that don't use local embeddings. The
 * Action must never bundle it: `resolveActionEmbeddingConfig` (index.ts)
 * already coerces `embedding-provider: local` to `none` before the factory
 * runs, so at RUNTIME the import is never attempted (covered by
 * index.test.ts's "coerces embedding-provider local to none" case). This
 * file additionally asserts the BUILD-TIME contract that would otherwise
 * silently regress: the `ncc build` script must externalize/exclude the
 * package so it can never end up embedded in `dist/index.js`.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const actionPackageJsonPath = fileURLToPath(new URL('../package.json', import.meta.url));
const corePackageJsonPath = fileURLToPath(
  new URL('../../../packages/core/package.json', import.meta.url),
);

describe('Action ncc build excludes @xenova/transformers', () => {
  it('the "build" script passes -e @xenova/transformers to ncc', () => {
    const pkg = JSON.parse(readFileSync(actionPackageJsonPath, 'utf-8')) as {
      scripts: Record<string, string>;
    };
    const buildScript = pkg.scripts.build;
    expect(buildScript).toContain('ncc build');
    expect(buildScript).toContain('-e @xenova/transformers');
  });

  it('the Action package.json does NOT declare @xenova/transformers as a direct/dev dependency', () => {
    const pkg = JSON.parse(readFileSync(actionPackageJsonPath, 'utf-8')) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
      optionalDependencies?: Record<string, string>;
    };
    expect(pkg.dependencies ?? {}).not.toHaveProperty('@xenova/transformers');
    expect(pkg.devDependencies ?? {}).not.toHaveProperty('@xenova/transformers');
    expect(pkg.optionalDependencies ?? {}).not.toHaveProperty('@xenova/transformers');
  });

  it('ghagga-core does NOT declare @xenova/transformers — it is a user-installed optional peer', () => {
    const pkg = JSON.parse(readFileSync(corePackageJsonPath, 'utf-8')) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
      optionalDependencies?: Record<string, string>;
    };
    // Undeclared on purpose: an optionalDependency would be installed by default
    // (pnpm installs optional deps), pulling a heavy ML lib + its vulnerable
    // transitive protobufjs into every ghagga install. Users opt in explicitly.
    expect(pkg.dependencies ?? {}).not.toHaveProperty('@xenova/transformers');
    expect(pkg.devDependencies ?? {}).not.toHaveProperty('@xenova/transformers');
    expect(pkg.optionalDependencies ?? {}).not.toHaveProperty('@xenova/transformers');
  });
});
