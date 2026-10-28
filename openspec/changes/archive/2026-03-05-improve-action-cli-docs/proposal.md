# Proposal: Improve GitHub Action & CLI Documentation

## Intent

The GitHub Action docs (117 lines) and CLI docs (111 lines) are functional reference material but lack the guided onboarding experience established by the SaaS guide (220 lines) and Self-Hosted guide (424 lines). Users landing on these pages get a wall of options tables without prerequisites, step-by-step flow, verification checkpoints, troubleshooting, cost clarity, or example output. Worse, **3 bugs in code examples** will cause copy-paste failures for new users.

This change brings both guides up to the quality standard of the existing SaaS and Self-Hosted guides, fixes all known bugs, and ensures consistency across all 4 distribution modes' documentation.

## Scope

### In Scope

- **P0 Bug Fixes (3 bugs)**:
  1. `apps/cli/README.md`: All `npx @ghagga/cli` -> `npx ghagga` (package name is `ghagga`, not `@ghagga/cli`)
  2. `docs/cli.md` line 104 + `docs/configuration.md` line 107: `--config '{"reviewLevel": "strict"}'` passes JSON string where a file path is expected -> `--config .ghagga.json`
  3. `docs/github-action.md` lines 76-79: Consensus example passes `api-key: ${{ secrets.ANTHROPIC_API_KEY }}` without `provider: anthropic` -> add `provider: anthropic`
- **`docs/github-action.md` major rewrite** (~117 -> ~250-300 lines):
  - Prerequisites section
  - Step-by-step getting started flow (4 steps with verification checkpoints)
  - Mermaid flow diagram (PR opened -> Action triggers -> review posted)
  - Document that FAILED status calls `core.setFailed()` and fails CI; show `continue-on-error: true` workaround
  - Document that `.ghagga.json` is NOT supported in Action mode (inputs only)
  - Troubleshooting section (token permissions, no comment, first-run slowness, wrong triggers, FAILED behavior)
  - Cost clarity (free for public repos, private repos consume Actions minutes)
  - "What to expect" section describing the PR comment format
  - Next Steps links
- **`docs/cli.md` major rewrite** (~111 -> ~250-300 lines):
  - Prerequisites section (Node.js >= 20, Git, GitHub account)
  - Step-by-step getting started flow with verification
  - Document ALL 4 commands: `login`, `logout`, `status`, `review`
  - Document the `[path]` positional argument
  - Document config storage location (`~/.config/ghagga/config.json`)
  - Document `GITHUB_TOKEN` env var fallback
  - Document `--verbose` output behavior
  - Mermaid flow diagram (login -> diff -> analyze -> output)
  - Troubleshooting section (6+ scenarios)
  - Cost clarity (free with GitHub Models, free with Ollama, BYOK for others)
  - Example output (markdown + JSON format)
  - Next Steps links
- **`apps/cli/README.md` fixes + improvements**:
  - Fix all `npx @ghagga/cli` -> `npx ghagga` (7 occurrences)
  - Fix `npm install -g @ghagga/cli` -> `npm install -g ghagga`
  - Add missing providers `ollama` and `qwen` to Options section
- **`README.md` fixes**:
  - Fix the `--config '{"reviewLevel": "strict"}'` example (if present)
  - Verify Action and CLI sections are consistent with updated docs
- **`docs/quick-start.md` fix**:
  - Fix contradictory "Recommended" labels (table says SaaS, section heading says Action)
- **`docs/configuration.md` fix**:
  - Fix `--config '{"reviewLevel": "strict"}'` example

### Out of Scope

- Rewriting the SaaS or Self-Hosted guides (already at quality standard)
- Adding new features to the Action or CLI code
- Creating video tutorials or interactive guides
- Translating documentation to other languages
- Architecture documentation changes (separate concern)
- Landing page updates

## Approach

1. **Fix bugs first** — all 3 P0 bugs are independent and can be fixed in a single pass across all affected files
2. **Rewrite `docs/github-action.md`** using `docs/saas-getting-started.md` as the structural template: Prerequisites -> Step-by-step flow (with verification) -> Reference tables -> Examples -> Troubleshooting -> Next Steps
3. **Rewrite `docs/cli.md`** using the same structural template, adapted for terminal usage: Prerequisites -> Step-by-step flow -> All 4 commands reference -> Config -> Examples -> Troubleshooting -> Next Steps
4. **Update `apps/cli/README.md`** with package name fixes and missing providers
5. **Update `README.md`** to fix broken examples and ensure consistency
6. **Fix `docs/quick-start.md`** contradictory Recommended labels
7. **Fix `docs/configuration.md`** broken `--config` example
8. **Cross-reference pass** — ensure all files link to each other correctly, no contradictions remain

The structural template for both guides:

```
# Title
> One-line value proposition

## Prerequisites
## Step 1: ... (with verification checkpoint)
## Step 2: ... (with verification checkpoint)
## Step 3: ... (with verification checkpoint)
## Step 4: ... (with verification checkpoint)
## How It Works (Mermaid diagram)
## Reference (inputs/options tables)
## Configuration
## Examples
## Troubleshooting
## Cost
## Next Steps
```

## Affected Areas

| Area                    | Impact           | Description                                                           |
| ----------------------- | ---------------- | --------------------------------------------------------------------- |
| `docs/github-action.md` | Modified (major) | Full rewrite with guided onboarding structure, ~2.5x current size     |
| `docs/cli.md`           | Modified (major) | Full rewrite with guided onboarding structure, ~2.5x current size     |
| `apps/cli/README.md`    | Modified         | Fix 8 wrong package name references, add missing providers to Options |
| `README.md`             | Modified         | Fix broken `--config` example if present, consistency updates         |
| `docs/quick-start.md`   | Modified (minor) | Fix contradictory "Recommended" labels                                |
| `docs/configuration.md` | Modified (minor) | Fix broken `--config` inline JSON example                             |

## Risks

| Risk                                              | Likelihood | Mitigation                                                                                                               |
| ------------------------------------------------- | ---------- | ------------------------------------------------------------------------------------------------------------------------ |
| Introducing new inaccuracies while rewriting      | Medium     | Cross-reference every claim against source code (`action.yml`, `apps/cli/src/`, `packages/core/`)                        |
| Documentation drifts from code over time          | Medium     | Include verification steps users can follow to confirm behavior                                                          |
| Mermaid diagrams don't render in all contexts     | Low        | Use simple flowcharts; provide text description as fallback in flow                                                      |
| Breaking existing doc links                       | Low        | Keep same filenames; only change content within files                                                                    |
| Over-documenting — guides become too long to read | Low        | Target 250-300 lines (vs current ~110). SaaS guide at 220 lines is well-received. Self-Hosted at 424 is the upper bound. |

## Rollback Plan

All changes are documentation-only (Markdown files). Rollback is a single `git revert` of the commit(s). No code, configuration, or infrastructure is affected.

## Dependencies

- Access to source code to verify claims:
  - `action.yml` — for Action inputs/outputs truth
  - `apps/action/src/` — for `core.setFailed()` behavior
  - `apps/cli/src/` — for CLI commands, options, config loading
  - `packages/core/` — for pipeline behavior
- The existing quality-standard guides (`docs/saas-getting-started.md`, `docs/self-hosted.md`) as structural templates

## Success Criteria

- [ ] All 3 P0 bugs are fixed (zero broken code examples across all docs)
- [ ] `docs/github-action.md` has: Prerequisites, 4-step flow, verification checkpoints, Mermaid diagram, troubleshooting (4+ scenarios), cost clarity, example output, Next Steps
- [ ] `docs/cli.md` has: Prerequisites, step-by-step flow, verification checkpoints, all 4 commands documented, Mermaid diagram, troubleshooting (6+ scenarios), cost clarity, example output (markdown + JSON), Next Steps
- [ ] `apps/cli/README.md` has zero `@ghagga/cli` references (all `ghagga`)
- [ ] `apps/cli/README.md` Options section lists all 6 providers including `ollama` and `qwen`
- [ ] `docs/quick-start.md` has no contradictory "Recommended" labels
- [ ] `docs/configuration.md` `--config` example uses file path, not inline JSON
- [ ] No broken cross-links between documentation files
- [ ] Each guide is 200-350 lines (matching quality standard range)
- [ ] `README.md` examples are consistent with dedicated guide pages
