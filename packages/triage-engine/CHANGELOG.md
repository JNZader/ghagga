# ghagga-triage-engine

## 0.3.1

### Patch Changes

- Updated dependencies
  - ghagga-core@3.5.0

## 0.3.0

### Minor Changes

- fefa99e: Add `codex` and `claude` CLI adapters to the cli-bridge (selectable via a new optional `cli` config field on the triage config; default stays `opencode`), giving triage/review a reliable gpt-5.x (codex) or Claude (claude CLI) backend instead of the flaky opencode-go path.

  SECURITY: while adding them, fixed a command-injection RCE that affected ALL cli-bridge adapters (opencode/copilot/gemini too): commands were built as shell strings with `JSON.stringify`-quoted args and run via `execSync` → `/bin/sh -c`. `JSON.stringify` does not escape `$`/backtick, so an untrusted issue body containing `$(...)` or backticks executed on the host. All adapters now use `execFileSync(command, argsArray)` with no shell — the prompt is an inert argv element. Verified with a security regression test.

- 26d43fd: Add memory-backed issue dedup to the local `ghagga triage` command. Before running the LLM analysis, an incoming issue is checked against previously-triaged issues (stored locally under `~/.config/ghagga/memory.db`, scoped per repo) via the backend-agnostic keyword-overlap dedup engine; a likely duplicate short-circuits to a DUPLICATE draft (no LLM spend) citing the matched issues, and non-duplicates are persisted for future matching. Opt-out via `"dedup": { "enabled": false }` in the triage config. Self-identity is keyed on the stable repo+iid (robust to title edits), stored content is length-bounded, and a broken/corrupt memory DB degrades gracefully to running without dedup.
- 832af1b: `moduleMap` scope entries now accept **glob patterns** and **file paths**, not just directories — so a config can point a module at exact files (e.g. `internal/**/checklist*.go`) for precise, fast LOCATE instead of scanning a broad directory. Globs resolve via `node:fs` `globSync` (Node ≥22.22.2; the package's engines floor is bumped accordingly, and the access is crash-safe so glob entries degrade gracefully on older runtimes while dir/file entries keep working). Directory entries behave exactly as before (fully backward compatible). All entries are confined to `codeRoot` — a `..`-escaping glob/file is skipped. Test files, `node_modules`/vendor, and the scan cap are all honored identically across dir/glob/file entries.
- de3689d: REPRODUCE can now deduce the app route from an issue's `módulo::X` label when the body has no `Ruta:` line (e.g. issues created from meeting notes rather than the in-app feedback widget). It uses the `/app/<module>` heuristic, overridable per-module via a new optional `moduleRoutes` config map (e.g. `{ "equipos": "/app/tanques" }`). A `Ruta:` line in the body still takes precedence.

### Patch Changes

- 5789cde: Fix the GitLab forge adapter's `listIssues` (used by `ghagga triage --new`): it passed `-F json` to `glab issue list`, but `-F/--output-format` is a different flag (details/ids/urls) that silently falls back to glab's human text table, so `JSON.parse` threw `Unexpected token 'S', "Showing …"`. `glab issue list` needs `-O/--output json`. The whole `--new` / list-all path was broken for GitLab (the feature's primary forge); single-issue `triage <iid>` was unaffected (`issue view` correctly uses `-F json`). Verified end-to-end against a real GitLab repo.
- 862923f: Fix REPRODUCE failing at login with "Cannot navigate to invalid URL". The Playwright browser context was created without a `baseURL`, so the login recipe's relative `goto` step (e.g. `/login`) had no base to resolve against. The context now sets `baseURL` from `config.app.baseURL`, so relative login navigation works (the post-login route navigation already used an absolute URL and was unaffected).
- 6e1b3a6: Fix REPRODUCE running unauthenticated due to a login timing race. After a `steps` loginRecipe the harness navigated to the target route immediately, before the app's post-login redirect completed, so the session/JWT wasn't established and the app bounced to the login page. The harness now waits for the app to leave the login page (best-effort, 15s timeout — REPRODUCE proceeds either way and records whether the redirect was observed) before proceeding.
- 80cf082: Fix REPRODUCE never firing on GitLab feedback issues. The route to navigate is extracted from the widget's `Ruta: /app/x` line, but the GitLab adapter strips that (`---`-delimited) trailer from `description` before route extraction ran — so the route was always null and REPRODUCE silently skipped every issue. `ForgeIssue` now carries a `rawDescription` (un-stripped body); route extraction reads from it while the LLM/analysis still receives the stripped `description` (widget metadata never reaches the model).
- Updated dependencies [fefa99e]
- Updated dependencies [56dca64]
- Updated dependencies [8411136]
- Updated dependencies [a1239d3]
- Updated dependencies [fdfacff]
- Updated dependencies [089a5b6]
- Updated dependencies [91930f4]
- Updated dependencies [8f11441]
- Updated dependencies [a86a886]
- Updated dependencies [3a25d6f]
  - ghagga-core@3.4.0

## 0.2.0

### Minor Changes

- 8989e0d: Add `ghagga-triage-engine`, a self-contained, forge-agnostic (GitHub + GitLab) package for config-driven, code-aware issue triage with Playwright-based reproduction (keywords -> scan -> rerank -> expand -> locate, plus reproduce/triage/queue stages), and wire a `ghagga triage` CLI command on top of it. Export the `issue-triage` agent (`runIssueTriage`, `ISSUE_TRIAGE_SYSTEM`) and its supporting prompt-injection defenses (full boundary-marker defanging, `sanitizeLabel`) from `ghagga-core`.

### Patch Changes

- Updated dependencies
- Updated dependencies [8989e0d]
  - ghagga-core@3.3.0
