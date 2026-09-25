# pnpm 10 migration

## Objective

Move the monorepo from `pnpm@9.15.4` to current pnpm 10.x without regressing Node, Biome, Vitest, Changesets, Dependabot groups, or turbo test concurrency.

## Why

pnpm 10 blocks dependency lifecycle scripts by default. The old `chore/pnpm-10` branch encoded that as an empty `onlyBuiltDependencies` allowlist, but it was based on stale main and would have downgraded Node/Vitest.

## Out of scope

- pnpm 11 `allowBuilds`
- Node engine changes
- Dependabot regrouping
- Full `pnpm build` / Action dist rebuild
- npm publish

## Tasks

- [x] T1 Root `package.json`: `packageManager` pnpm@10.34.5, `engines.pnpm` `>=10.0.0`, keep `engines.node` `>=22.22.2`. `pnpm.onlyBuiltDependencies: []`. `pnpm.ignoredBuiltDependencies` for packages that still ship install scripts we refuse to run (start from cpu-features, esbuild, msgpackr-extract, protobufjs, ssh2; add whatever `pnpm install` reports).
- [x] T2 `npx pnpm@10.34.5 install` exit 0 (11.4s). Lockfile already compatible (`lockfileVersion` 9.0); no lockfile delta. No extra ignored-build names.
- [x] T3 `CONTRIBUTING.md` pnpm 9+ → 10+.

## Checks

- `packageManager` is pnpm 10.34.5
- Node floor still 22.22.2
- Frozen install succeeds in the worktree
- Focused typecheck of a leaf package still works (no full turbo build)
