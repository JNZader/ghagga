# ghagga

## 3.3.0

### Minor Changes

- SCIP-based multi-language code intelligence for the dependency graph and review blast-radius.

  **`ghagga index` — multi-language SCIP graph**

  - Registry-driven multi-language SCIP indexer: Go, TypeScript/JavaScript, Python, Rust, Java, Kotlin, C#, PHP — each via its native SCIP indexer, merged into one graph, with per-language graceful degradation (a missing/failing indexer warns and skips, never aborts the run).
  - Nested-monorepo detection: language markers are found at any depth (bounded, exclusion-aware) and each indexer runs per marker-directory, so a language living only in a subpackage is no longer silently lost.
  - New `--marker-depth <n>` flag to control the nested-detection depth (default 4).

  **Blast-radius consumes the SCIP graph**

  - `ghagga review` (opt-in, `--blast-radius`) loads the SCIP-built `.ghagga/graph.json` via a new `FilesystemGraphLoader`, with exact-commit staleness detection and per-file coverage warnings. `computeBlastRadius` is unchanged.
  - Symbol-precise import context: the graph records which symbols a file imports from each dependency and each symbol's source range, surfacing a `## Symbol Impact` review section that correctly attributes body-only changes.
  - Re-export barrel edges (`export {X} from`, `export *`, `export type`) are now captured — fixing a pre-existing blast-radius false-negative — and Python `__init__.py` / Rust `pub use` re-exports resolve.
  - Opt-in **symbol-precise blast-radius narrowing** (`enableSymbolExclusion`, default off, CLI-only): a transitive dependent that uses none of a changed file's changed symbols is excluded from review context — behind three fail-closed safety gates (exact-commit freshness, per-file completeness, and a language/builder whitelist), so it only ever narrows on provably-safe edges.

  **LOCATE (triage-engine)**

  - The issue→code `locate` pipeline's graph-expand now consumes the SCIP multi-language graph when a `.ghagga/graph.json` is present, resolving dependents across all indexed languages instead of just regex TS/JS, and falling back to the regex graph otherwise.

- 8989e0d: Add `ghagga-triage-engine`, a self-contained, forge-agnostic (GitHub + GitLab) package for config-driven, code-aware issue triage with Playwright-based reproduction (keywords -> scan -> rerank -> expand -> locate, plus reproduce/triage/queue stages), and wire a `ghagga triage` CLI command on top of it. Export the `issue-triage` agent (`runIssueTriage`, `ISSUE_TRIAGE_SYSTEM`) and its supporting prompt-injection defenses (full boundary-marker defanging, `sanitizeLabel`) from `ghagga-core`.

### Patch Changes

- Updated dependencies
- Updated dependencies [8989e0d]
  - ghagga-core@3.3.0
  - ghagga-triage-engine@0.2.0
  - ghagga-forge@3.3.0

## 3.2.0

### Minor Changes

- 8cc5cdd: Publish semantic-memory retrieval across the CLI, core engine, and storage backends, including configurable embedding providers, hybrid keyword/vector search, safe schema metadata, backfill tooling, and graceful keyword-only fallback.

  Include the post-3.1.0 reliability, security, forge-integration, and distribution corrections, and keep the four published package versions aligned for the coordinated release.

### Patch Changes

- Updated dependencies [8cc5cdd]
  - ghagga-core@3.2.0
  - ghagga-forge@3.2.0

## 3.1.0

### Minor Changes

- a2a537e: forge-agnostic: GitHub/GitLab forge abstraction + CLI review post-back

  **New `ghagga-forge` package** (first publish) — a forge-agnostic adapter layer that decouples ghagga from any single git host:

  - `ForgeAdapter` port + canonical domain model (RepoRef, ChangeRequestRef, CommentId, UnifiedDiff, …) and a `ForgeCredentialProvider` seam.
  - `GitHubForgeAdapter` and `GitLabForgeAdapter` (summary-comment post-back; GitLab supports self-hosted via host-derived API base + `GITLAB_HOST` / `GITLAB_API_BASE`).
  - `GitHubAppCredentialProvider` (TTL cache + singleflight + in-job 401/403 recovery) and `StaticTokenProvider` (PAT).

  **CLI — post review findings back to a PR/MR:**

  - `ghagga review --pr <n>` → posts the summary to a GitHub PR (`GITHUB_TOKEN` / `GH_TOKEN`). Unlocks the Jenkins+GitHub / CI use case.
  - `ghagga review --mr <n>` → posts to a GitLab MR (`GITLAB_TOKEN` / `GL_TOKEN`), incl. self-hosted instances.
  - Post-back is blocking by default when explicitly requested (non-zero exit on failure; `--pr-soft-fail` to opt out); discloses the target host on stderr before posting.

  **Server (`ghagga-core` / review worker):**

  - Review worker and webhook `issue_comment` handler routed through the forge adapter (behavior-identical), via a single `makeGitHubAdapter` composition root.
  - Static-analysis tool diagnostics moved to stderr so `--output sarif` / `--output json` stdout stays clean for CI consumers.
  - Comment/note listing paginates fully (no more duplicate review comments on large PRs), bounded by a wall-clock budget.

### Patch Changes

- Updated dependencies [a2a537e]
  - ghagga-forge@3.1.0
  - ghagga-core@3.1.0

## 3.0.0

### Major Changes

- v3.0.0 — coordinated major release. Realigns the published packages onto a single version (core was at 2.9.1, cli/db at 2.8.1) and ships the breaking changes that accumulated since 2.7.0 — several of which were previously MISLABELED as "minor" in the changelog (corrected here after a 3-package breaking-change audit).

  BREAKING CHANGES (verified against the published export surface):

  - **ghagga-core**: `applyVirtualPatches` return type changed from `string` to `VirtualPatchResult` (`{ diff, injectedLineIndices }`). Any caller using the return value as a string breaks at both compile and runtime. (Was mislabeled "semver minor" under `recursive-coordinate-contract`.)

  - **ghagga (CLI)**: legacy `--provider` / `GHAGGA_PROVIDER` values (`github`, `anthropic`, `openai`, `google`, `groq`, `openrouter`, `azure`, `deepseek`, `qwen`, `cerebras`) now exit with code 1 — they previously routed directly. Use `gateway` (the new default). Default model changed `gpt-4o-mini` → `auto`. Stored-config legacy values are silently remapped to `gateway`, so logged-in users without an explicit flag are unaffected.

  - **ghagga-db**: removed the entire delegated-CI surface — 9 query functions (`getDelegatedCiPolicy`, `updateDelegatedCiPolicy`, `createDelegatedCiRun`, …) and 5 schema exports (`delegatedCiRuns` table, `DbDelegatedCiPolicy`, `DbDelegatedCiClassification`, …). `encrypt()` output format changed v1 → v2 (`v2:<iv>:<cipher>:<tag>`); `decrypt()` auto-detects both formats (backward-compatible for reads).

  ADDITIVE / FIXES bundled in this release (non-breaking): `ReviewResult.coverageComplete` and `ReviewResult.semanticDiff` optional fields; unified diff-parser quoted-path + rename + deletion-attribution fixes (CORE-M6/M8/M9); recursive review off-by-N fix; static-analysis findings now scoped to the changed files (reviews stop failing on unrelated repo-wide debt); ghagga's bundled semgrep ruleset now runs in the active pipeline; gitleaks test-fixture allowlist.

  The GitHub Action (`@ghagga/action`) input/output contract is unchanged (its `provider` default tracks the CLI's gateway default, with graceful legacy remapping).

### Patch Changes

- Updated dependencies [2c4480b]
- Updated dependencies [e1fbfad]
- Updated dependencies
  - ghagga-core@3.0.0
