#!/usr/bin/env bash
# Apply pending changesets and refresh the lockfile so the Version Packages
# PR still passes `pnpm install --frozen-lockfile` in CI.
set -euo pipefail

pnpm exec changeset version
pnpm install --lockfile-only
