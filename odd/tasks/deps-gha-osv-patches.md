# GHA setup + OSV + in-range npm patches

## Objective

Align CI composite actions with publish/pages, bump osv-scanner 2.6.0, refresh in-range lockfile patches.

## Out of scope

- TypeScript 7 (ncc issue #1336)
- pnpm 11/12
- dotenv 18
- turbo 2.11
- Action dist rebuild

## Tasks

- [x] T1 `.github/actions/setup/action.yml`: pnpm/action-setup v6.1.0 and setup-node v7.0.0, same SHAs as publish.yml
- [x] T2 `ci.yml` osv-scanner v2.6.0
- [x] T3 `pnpm update` in-range: ai, @ai-sdk/*, hono, bullmq, vite, tsx, jsdom
