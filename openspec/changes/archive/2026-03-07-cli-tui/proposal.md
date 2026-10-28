# Proposal: CLI TUI Enhancement

## Intent

The GHAGGA CLI currently uses raw `console.log` with scattered ANSI escape codes, hand-built tables, and no visual structure for long-running operations. Users get a wall of text with no spinners, no progress indicators, and no visual hierarchy. This makes the CLI feel like a prototype rather than a polished developer tool.

Adding a lightweight TUI layer will give GHAGGA a professional, branded terminal experience — spinners during review, structured headers/footers, colored status output, and graceful degradation in CI pipelines — without changing any underlying command behavior.

## Scope

### In Scope

- **Presentation layer (`apps/cli/src/ui/`)**: New module encapsulating all terminal output styling, spinners, and formatting
- **`intro`/`outro` wrappers**: Branded session start/end with version and context info
- **Spinner for review**: Animated spinner during the `review` pipeline with step-by-step messages (replaces raw "Analyzing..." text)
- **Styled output for all commands**: `login` (device code box, waiting spinner), `logout` (confirmation), `status` (structured key-value display), `review` (header, findings table, footer), `memory *` (styled tables and stats)
- **Non-interactive / CI fallback**: Detect `!process.stdout.isTTY` or `CI` env var and fall back to plain text (no spinners, no ANSI) — all existing CI behavior preserved
- **`--plain` global flag**: Allow users to force plain-text output explicitly
- **Progress callback integration**: Wire the `onProgress` callback in `review.ts` to update the spinner message in real-time (verbose mode gets log lines, normal mode gets spinner updates)
- **Error formatting**: Styled error boxes for validation errors, auth failures, and network errors

### Out of Scope

- **New tests for TUI** — deferred to the `test-coverage-audit` change; existing 124 tests must continue passing
- **Interactive prompts** — no new interactive inputs (e.g., provider selection menus); the CLI remains non-interactive by default
- **Structural refactor of commands** — command logic stays in existing files; only the output calls change
- **New commands or flags** (beyond `--plain`)
- **Colors in JSON output** — `--format json` remains raw JSON, unaffected

## Approach

### Library Choice: `@clack/prompts`

After evaluating both candidates:

| Criterion              | Ink (React for CLI)                                                                                                                                                                                                   | @clack/prompts                                                                                                                                 |
| ---------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| **ncc bundling**       | Problematic — Ink depends on React, Yoga (native C++ layout engine via N-API), and react-reconciler. ncc struggles with native bindings and React's complex module graph. Known issues with `yoga-wasm-web` fallback. | Clean — pure JS/TS, zero native deps, no framework runtime. Bundles trivially with ncc, webpack, esbuild.                                      |
| **Bundle size**        | Heavy — Ink + React + Yoga + ink-spinner + ink-table adds ~800KB+ to the bundle                                                                                                                                       | Minimal — `@clack/prompts` + `@clack/core` + `picocolors` adds ~25KB                                                                           |
| **Integration effort** | High — requires rewriting every command as React components, new rendering paradigm, JSX transform setup                                                                                                              | Low — drop-in replacement for `console.log` calls. Each command swaps `console.log(...)` for `p.log.info(...)`, `s.start(...)`, `p.outro(...)` |
| **CI/non-interactive** | Requires custom logic to disable React rendering in non-TTY                                                                                                                                                           | Built-in: spinners degrade to static dots, `isCancel()` for Ctrl+C                                                                             |
| **Learning curve**     | React mental model for CLI (components, hooks, state, effects)                                                                                                                                                        | Imperative API — `spinner()`, `log.info()`, `intro()`, `outro()`                                                                               |
| **Maintenance**        | Ongoing React version coupling, reconciler updates                                                                                                                                                                    | Stable, minimal API surface                                                                                                                    |

**Decision: `@clack/prompts`** — it's the right tool for this job. GHAGGA's CLI is imperative (run command, show output, exit). Ink's component model is designed for persistent, interactive TUI apps (dashboards, long-running processes). Clack aligns perfectly with GHAGGA's execute-and-print pattern while adding polish.

### Integration Strategy

1. **Create `apps/cli/src/ui/` module** with:
   - `tui.ts` — Thin facade over `@clack/prompts` that detects TTY/CI and routes to styled vs. plain output
   - `format.ts` — Extract and improve existing formatting logic (tables, findings, results) from `review.ts` and `memory/utils.ts`
   - `theme.ts` — GHAGGA color palette and icon constants (centralize the scattered emoji/ANSI)

2. **Migrate commands one-by-one** (no behavioral changes):
   - `login.ts`: `intro()` header, styled device-code box, `spinner()` while polling, `outro()` on success
   - `logout.ts`: `log.info()` / `log.success()` instead of `console.log()`
   - `status.ts`: Key-value display with `log.info()`, colored status badges
   - `review.ts`: `intro()` header with mode/provider info, `spinner()` during pipeline (step messages from `onProgress`), styled findings output, `outro()` with summary
   - `memory/*.ts`: Styled tables via `log.info()`, formatted stats

3. **CI detection** in `tui.ts`:

   ```
   isInteractive = process.stdout.isTTY && !process.env.CI && !opts.plain
   ```

   When non-interactive: all `tui.*` calls fall back to plain `console.log` — same output as today.

4. **Preserve exit codes and output contracts**: `--format json` bypasses TUI entirely. Exit codes unchanged. All existing flags work identically.

## Affected Areas

| Area                                    | Impact   | Description                                                                                                          |
| --------------------------------------- | -------- | -------------------------------------------------------------------------------------------------------------------- |
| `apps/cli/src/ui/` (new)                | New      | TUI facade, formatting, theme constants                                                                              |
| `apps/cli/src/commands/login.ts`        | Modified | Replace `console.log` with TUI calls; add spinner for OAuth polling                                                  |
| `apps/cli/src/commands/logout.ts`       | Modified | Replace `console.log` with TUI calls                                                                                 |
| `apps/cli/src/commands/status.ts`       | Modified | Replace `console.log` with styled key-value output                                                                   |
| `apps/cli/src/commands/review.ts`       | Modified | Replace `console.log` with TUI calls; wire spinner to progress callback; extract formatting to `ui/format.ts`        |
| `apps/cli/src/commands/memory/*.ts`     | Modified | Replace `console.log` with TUI calls; use improved table formatting                                                  |
| `apps/cli/src/commands/memory/utils.ts` | Modified | Move `formatTable`, `formatSize`, `truncate` to `ui/format.ts`; keep `openMemoryOrExit` and `confirmOrExit` in place |
| `apps/cli/src/index.ts`                 | Modified | Add `--plain` global option; pass to command context                                                                 |
| `apps/cli/package.json`                 | Modified | Add `@clack/prompts` dependency                                                                                      |
| Existing tests (124)                    | None     | Tests don't exercise `console.log` output directly; no test changes needed                                           |
| ncc bundle (`dist/index.js`)            | Modified | Bundle will include `@clack/prompts` (~25KB increase)                                                                |

## Risks

| Risk                                       | Likelihood | Mitigation                                                                                                                                                                 |
| ------------------------------------------ | ---------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| ncc fails to bundle `@clack/prompts`       | Low        | clack is pure JS with no native deps; pre-validate with `ncc build` before committing. If it fails, vendor the ~25KB source directly.                                      |
| Spinner output corrupts piped stdout       | Medium     | Detect `!process.stdout.isTTY` and disable spinners entirely. Test with `ghagga review . \| cat` and `ghagga review . > file.txt`.                                         |
| ANSI colors in redirected output           | Medium     | Use `picocolors` (auto-detects NO_COLOR, non-TTY). Also respect `--plain` flag and `NO_COLOR` env var per [no-color.org](https://no-color.org) standard.                   |
| Verbose mode (`-v`) conflicts with spinner | Low        | When `--verbose` is active, disable spinner and use `log.step()` for each progress event instead (current behavior but styled).                                            |
| Breaking existing CI integrations          | Medium     | Non-TTY output must be character-identical to current output (or strictly a superset with no ANSI). Integration test: compare `CI=true ghagga status` output before/after. |
| Bundle size regression                     | Low        | @clack/prompts is ~25KB. Set a CI budget check: `dist/index.js` size delta must be < 50KB.                                                                                 |

## Rollback Plan

1. Revert the PR (single-branch change, all modifications in `apps/cli/`)
2. Remove `@clack/prompts` from `package.json`, run `pnpm install`
3. The `ui/` directory is additive — removing it and reverting command files restores exact prior behavior
4. No database migrations, no config changes, no API changes — rollback is clean

## Dependencies

- **`@clack/prompts`** (npm, MIT license) — prompt/spinner/styling primitives
- **`picocolors`** (transitive via clack, MIT) — lightweight terminal colors (replaces raw ANSI escapes)
- No other new dependencies required
- Existing `commander` stays as the arg parser (clack doesn't replace it — they complement each other)

## Success Criteria

- [ ] All 6 commands (`login`, `logout`, `status`, `review`, `memory *`) display branded TUI output with `intro`/`outro` framing
- [ ] `ghagga review .` shows an animated spinner during the review pipeline, with step progress messages
- [ ] `ghagga login` shows a styled device-code box and spinner while waiting for authorization
- [ ] `CI=true ghagga review .` produces clean, non-ANSI output (no spinner artifacts, no broken escape sequences)
- [ ] `ghagga review . --plain` forces plain text output in any environment
- [ ] `ghagga review . --format json` outputs raw JSON with zero TUI formatting
- [ ] `--no-memory`, `--no-semgrep`, `--no-trivy`, `--no-cpd`, `-v`, `-m`, `-p`, `--model`, `--api-key`, `-f`, `-c` all continue working identically
- [ ] `ncc build` succeeds and produces a single-file bundle
- [ ] Bundle size increase is < 50KB over current baseline
- [ ] All 124 existing tests pass without modification
- [ ] `--plain` global flag is documented in `--help` output
