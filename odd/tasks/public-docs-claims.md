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

Edits are in the working tree. Branch and commit were not created: the shell could not start in this checkout.

## Checks

- No public doc tells a new user that GitHub Models is the default or that `ghagga login` grants free model access.
- Action examples use `JNZader/ghagga@v3.4.0`.
- Review modes listed as the six values in `packages/core/src/types.ts`.
- Tool count 17, with SonarQube called out as MCP and inert unless an MCP server is configured.
