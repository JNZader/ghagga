# Public docs match the runtime

## Objective

Make the public docs describe the provider modes, review modes, tool registry, and Action install pin that the code actually ships.

## Why

The landing, README, Docsify guides, Action marketplace blurb, and package READMEs disagree with each other and with `ReviewMode`, `LLMProvider`, and `DEFAULT_PLUGINS`.

## Out of scope

- GitHub wiki (leave empty)
- openspec history and archived proposals
- CHANGELOG history
- npm publish and moving the `v3.4.0` tag

## Tasks

- [x] T1 Landing, both READMEs, `action.yml`
- [x] T2 Docsify guides that repeat the false GitHub Models default, the 3-mode list, the 16-tool count, or `ghagga-action@v1`
- [x] T3 Package READMEs that `npm` shows (`apps/cli`, `packages/core`)
- [x] T4 Kill leftover GitHub Models / free-model buyer strings (`Login.tsx`, CLI package description, `login --help`, CLI README requirements, `docs/cli.md` login/defaults) — `dcdba42`
- [x] T5 Operator docs still lying: fake `ghagga --help` dump, `--mode`/`--provider`/`--list-tools` tables, `ghcr.io/jnzader/ghagga-action` docker pin
- [ ] T6 Remaining count/forge lies on public docs: 16 tools, 13 regex patterns, Gitea as a shipped adapter. Do not add dashboard review-mode radios.

Commit `c21a208` landed T1–T3 on `docs/align-public-claims` (unpushed). T4–T6 are leftovers from the same audit.

## Out of scope (still)

- GitHub wiki, openspec history, CHANGELOG history, research/proposals
- npm publish and moving the `v3.4.0` tag
- Dashboard Settings radios (SaaS exposing 3 of 6 modes is a product change)
- Hanging worktrees (`ghagga-inconclusive`, `ghagga-pnpm10`)

## Checks

- No public doc, npm description, CLI `--help`, or dashboard login footer tells a new user that GitHub Models is the default or that `ghagga login` grants free model access.
- Action examples use `JNZader/ghagga@v3.4.0`. No `ghcr.io/jnzader/ghagga-action`.
- Review modes listed as the six values in `packages/core/src/types.ts` where the full engine is described; SaaS UI stays 3 radios (honest, not expanded).
- Tool count 17, with SonarQube called out as MCP and inert unless an MCP server is configured.
- Privacy stripping is 24 patterns, matching `packages/core/src/memory/privacy.ts`.
- Gitea is a forge kind, not a shipped adapter.
