# Proposal: Runner Dynamic Tool Resolution

## Intent

The GHAGGA server already dispatches `enabledTools` and `disabledTools` as JSON strings in workflow_dispatch, and the core library has a full tool resolution algorithm (`resolve.ts`) with 15 registered plugins. However, the runner YAML (`ghagga-analysis.yml`) hardcodes only 3 tools (Semgrep, Trivy, CPD) and doesn't even declare `enabledTools`/`disabledTools` as inputs — GitHub silently drops them. This means 80% of the tool ecosystem is dead code on the runner side. This change makes the runner dynamically resolve and execute all 15 tools.

## Scope

### In Scope

- Add `enabledTools` and `disabledTools` as workflow_dispatch string inputs
- Implement a bash-based "Resolve Tools" step replicating `resolve.ts` logic
- Add install/run/parse steps for all 12 new tools (gitleaks, shellcheck, markdownlint, lizard, ruff, bandit, golangci-lint, biome, pmd, psalm, clippy, hadolint)
- File-detection logic for auto-detect tools (check extensions in target-repo)
- Conditional execution: tools not resolved are not installed
- Cache steps for each tool that benefits from caching
- Assemble results for ALL resolved tools into the callback payload
- Backward compatibility: legacy `enableSemgrep`/`enableTrivy`/`enableCpd` booleans still work
- Security: all tool output to files, never printed to logs

### Out of Scope

- Changing the server dispatch logic (already sends `enabledTools`/`disabledTools`)
- Changing the core `resolve.ts` or plugin definitions
- Modifying the callback endpoint or Inngest event handling (already supports `Record<string, ToolResult>`)
- Parallel tool execution in the YAML (keep sequential for simplicity/debugging)
- Custom per-tool timeouts from server (use a uniform 5-min per-tool timeout)

## Approach

**Modular YAML with a resolve-then-execute pattern:**
1. **New inputs**: Add `enabledTools` and `disabledTools` as optional string inputs (JSON arrays)
2. **Resolve step**: A bash step that:
   - Starts with always-on tools: semgrep, trivy, cpd, gitleaks, shellcheck, markdownlint, lizard
   - Detects file extensions in target-repo for auto-detect tools
   - Applies `enabledTools` (force-add) and `disabledTools` (force-remove)
   - Falls back to legacy booleans when `disabledTools` is not provided
   - Outputs a JSON array of resolved tool names to `$GITHUB_OUTPUT`
3. **Per-tool steps**: Each tool has 3 steps (install, run, parse) gated by `if: contains(steps.resolve.outputs.tools, '"toolname"')`
4. **Assemble step**: Reads all `/tmp/{tool}-result.json` files, builds the unified payload, sends callback
5. **Shared binaries**: PMD install is shared between CPD and PMD tools

## Affected Areas

| Area                                        | Impact           | Description                                                        |
| ------------------------------------------- | ---------------- | ------------------------------------------------------------------ |
| `templates/ghagga-analysis.yml`             | Modified (major) | Grows from ~348 lines to ~1200 lines with all 15 tools             |
| `packages/core/src/tools/types.ts`          | None             | Reference only — tool names/tiers used as source of truth          |
| `packages/core/src/tools/resolve.ts`        | None             | Reference only — algorithm replicated in bash                      |
| `packages/core/src/tools/plugins/*.ts`      | None             | Reference only — install/run/parse commands extracted              |
| `apps/server/src/github/runner.ts`          | None             | Already sends enabledTools/disabledTools, no changes needed        |
| `apps/server/src/routes/runner-callback.ts` | None             | Already accepts dynamic tool keys via `Record<string, ToolResult>` |

## Risks

| Risk                                                                | Likelihood | Mitigation                                                                   |
| ------------------------------------------------------------------- | ---------- | ---------------------------------------------------------------------------- |
| YAML exceeds GitHub's 256KB limit                                   | Low        | ~1200 lines of YAML ≈ 40-50KB, well under 256KB                              |
| Tool install failures block subsequent tools                        | Medium     | Every install/run step uses `continue-on-error: true`                        |
| Some tools unavailable on ubuntu-latest                             | Medium     | Each install step checks if binary exists before downloading                 |
| Auto-detect false positives (e.g., detecting .py in vendored files) | Low        | Acceptable — tool will simply find nothing                                   |
| Long execution time with many tools                                 | Medium     | Only install tools that are resolved; cache aggressively; 15-min job timeout |
| Leaking private code in logs                                        | High       | All output redirected to files with `2>/dev/null`; `::add-mask::` for paths  |
| Bash resolve logic drifts from TS resolve.ts                        | Medium     | Document mapping; resolve.ts is stable/simple                                |

## Rollback Plan

Revert to the previous `ghagga-analysis.yml` that only runs Semgrep/Trivy/CPD. The server already handles missing tool keys gracefully (treats them as `skipped`). The legacy boolean inputs remain in the new YAML, so the old server version would also work.

## Dependencies

- The server already dispatches `enabledTools`/`disabledTools` (confirmed in `runner.ts:367-368`)
- The `StaticAnalysisResult` type already supports dynamic tool keys via `Record<string, ToolResult>` (confirmed in `types.ts:241`)
- All 15 plugin definitions exist in `packages/core/src/tools/plugins/` with exact install/run commands

## Success Criteria

- [ ] All 15 tools can be resolved, installed, run, and parsed in the YAML
- [ ] `enabledTools`/`disabledTools` JSON arrays correctly override resolution
- [ ] Legacy `enableSemgrep`/`enableTrivy`/`enableCpd` booleans still work
- [ ] Auto-detect tools only install when relevant files exist
- [ ] No private code appears in workflow logs (verify with a test run)
- [ ] Callback payload includes results for all resolved tools
- [ ] Callback payload always includes `semgrep`/`trivy`/`cpd` keys (backward compat)
- [ ] YAML file is under 256KB
- [ ] Job completes within 15-minute timeout with cached tools
- [ ] Tool installation failures don't block other tools
