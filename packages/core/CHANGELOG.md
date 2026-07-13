# ghagga-core

## 3.2.0

### Minor Changes

- 8cc5cdd: Publish semantic-memory retrieval across the CLI, core engine, and storage backends, including configurable embedding providers, hybrid keyword/vector search, safe schema metadata, backfill tooling, and graceful keyword-only fallback.

  Include the post-3.1.0 reliability, security, forge-integration, and distribution corrections, and keep the four published package versions aligned for the coordinated release.

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

- 2c4480b: Run ghagga's bundled semgrep ruleset in the active pipeline + add gitleaks allowlist for test fixtures.

  The active `semgrepPlugin` previously ran only `--config auto`, so ghagga's own curated rules (`semgrep-rules.yml`: command-injection, eval usage, SQL string concat, etc.) never executed. It now passes both `--config auto` and `--config <bundled semgrep-rules.yml>` (semgrep unions multiple configs), so the curated rules always run, even offline.

  The `gitleaksPlugin` previously ran with no config or allowlist, so fake tokens in test fixtures were flagged as real secrets. It now passes `--config=<bundled gitleaks-config.toml>` which extends the default ruleset (`[extend] useDefault = true`) and adds a conservative `[allowlist]` of test/fixture path patterns. Tradeoff: a real secret hardcoded inside a test file may be missed.

  Both bundled config files are copied into `dist/tools/` by a post-build step and resolved relative to the plugin's own location, so they work in dev and in the published package. Both plugins degrade gracefully (default behavior) if the bundled file is missing at runtime.

  Tuned two bundled rules for precision after a dogfood showed the ruleset tripled findings (49 → 149), driven by noise:

  - `hardcoded-secret-generic` no longer matches arbitrary `$VAR = "..."` string constants. It now fires only when EITHER the assigned name matches a secret-ish keyword (`secret|token|api_key|password|credential|private_key|...`) OR the string value matches a high-signal secret shape (`AKIA…`, `sk-…`, `ghp_…`, a JWT, or a ≥32-char base64/hex blob). On `packages/core/src` this cut a fully-unfiltered `$VAR="..."` from 455 matches to 6 — all real secret-shaped test fixtures (~98.7% fewer). The JSON-object-key form was dropped because it is unparseable in java/kotlin/python/go/rust and a single parse failure disables the whole rule.
  - `command-injection-node` now also catches destructured/aliased child_process usage: `import { exec } from 'node:child_process'; exec(x)`, `import cp from 'child_process'; cp.exec(x)`, and the `require()` namespace/destructure equivalents. The bare/aliased branches are scoped with `pattern-inside` to files that actually import child_process so unrelated `.exec()` calls (RegExp/Mongoose) are not flagged.

- e1fbfad: Scope static-analysis findings to the changed files (Trivy/SCA exempt) so reviews no longer fail on unrelated repo-wide pre-existing findings.

  Static tools (Semgrep, CPD, …) scan the whole repo, so reviewing a 1-file change could surface — and FAIL on — pre-existing findings from unrelated files. The static-only verdict now only counts findings located in the changed files (the diff set, after blast-radius filtering; out-of-diff dependents are intentionally NOT included — a static finding in an unchanged file is pre-existing and must not fail the change). Dependency/SCA findings (Trivy, `dependency-vulnerability`) are exempt: they live in lockfiles/manifests that are usually not in the diff but still represent real risk for the change. Out-of-scope non-SCA findings remain visible in the report but no longer drive the verdict to FAILED.
