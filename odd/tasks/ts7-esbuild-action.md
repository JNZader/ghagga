# TypeScript 7 via esbuild Action bundle

## Objective

Replace ncc with esbuild so the Action bundle no longer uses ts-loader, then bump the workspace to TypeScript 7.0.2.

## Out of scope

- Docker image build
- pnpm major
- Dual typescript versions
- Auto-merge

## Tasks

- [x] T1 Action `build` script: esbuild bundle, external `@xenova/transformers`. Drop ncc. Update `build-config.test.ts`.
- [x] T2 Rebuild `apps/action/dist` with the new bundler.
- [x] T3 `typescript` `^7.0.2` in all workspace package.json. `pnpm -r typecheck` OK.
