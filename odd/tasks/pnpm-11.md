# pnpm 11.27.1

## Objective

Move from pnpm 10.34.5 to 11.27.1: allowBuilds, overrides in workspace yaml, Docker/corepack pins.

## Out of scope

- pnpm 12
- TypeScript 7
- docker build locally
- auto-merge

## Tasks

- [x] T1 packageManager 11.27.1, engines.pnpm >=11, allowBuilds all false, overrides in pnpm-workspace.yaml
- [x] T2 Dockerfiles + CONTRIBUTING
- [x] T3 CI=true pnpm@11.27.1 install + ghagga-core typecheck
