# Docker pnpm 10 prune

## Objective

Make server and action Dockerfiles install the same pnpm as `packageManager` and prune without a TTY.

## Why

#420 Docker failed: `ERR_PNPM_ABORTED_REMOVE_MODULES_DIR_NO_TTY` on `pnpm prune --prod` after Corepack fetched 10.34.5 despite `corepack prepare pnpm@9.15.4`.

## Out of scope

- Local `docker build` / image push
- Auto-merge

## Tasks

- [x] T1 `apps/server/Dockerfile`: pin `pnpm@10.34.5` (builder + runner), `ENV CI=true` on builder, keep `pnpm prune --prod`.
- [x] T2 `apps/action/Dockerfile`: same pin and `ENV CI=true` on builder.
