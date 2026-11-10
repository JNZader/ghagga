# ghagga-core

## 3.8.0

### Minor Changes

- 97ee9af: Add a blast-radius diagram to review comments and the dashboard: graph-backed reviews now render a sanitized, deterministic mermaid flowchart of the narrowed blast radius (changed files, their dependents, tests, and import edges in both directions, capped at 25 nodes / 40 edges with directory clustering) in an open `### Blast Radius` section between Files Changed and the cost footer. On by default wherever blast radius runs; reviews without a graph, without diagram data, or with an oversize blast radius keep byte-identical comments (counts-only fallback, no section).
  
  The capped node/edge lists and legend flags (`stale`, `truncated`, omitted-per-cluster counts) persist inside the existing review metadata, are projected through a single optional `blastRadiusDiagram` DTO key on `GET /api/reviews`, and the dashboard detail modal renders the same pre-rendered mermaid source via a lazily loaded mermaid chunk — no bundle cost for reviews without diagram data, with a read-only source fallback when rendering fails.
- 97a5c74: Rank graph-neighborhood context by lexical relevance: when the neighborhood section overflows its `graphContextMaxTokens` budget, surviving entries are now chosen by a deterministic lexical+structural score (diff-token overlap with path segments, changed/exported symbols and named imports, importer-degree tiebreak) instead of positional first-fit in diff order. Ranking changes entry ORDER only — rendering, budgets and the fail-closed degradation ladder are untouched, a ranking error degrades to the existing failed-step handling, and reviews without a fresh graph remain byte-identical. Rendered sections report `rankingMode: "lexical"` in the graph-context metadata.
- 07a06f8: Add graph-guided context retrieval: reviews now include a budgeted "Graph Neighborhood" section listing each changed file's direct importers, imports and exported symbols, assembled from the dependency graph index. On by default when a graph is available (`ghagga index` or a published `ghagga/graph` branch); disable with `--no-graph-context` or `enableGraphContext: false`. The section degrades fail-closed (missing, stale >7d, or oversized graph → no section, prompts byte-identical to before) and never shrinks the diff budget — it rides a dedicated `graphContextMaxTokens` sidecar (default 1200).
  
  Also persist a measured input/output token split: providers that report usage now feed `reviews.input_tokens` / `reviews.output_tokens` (additive nullable columns, `tokens_used` remains authoritative), and the cost footer shows the measured split, falling back to an "estimated 70/30" label when unmeasured.
- 455967a: Add an opt-in nightly health digest for SaaS/App repositories: set `digestsEnabled` on a repository (or at the installation level for repos using global settings) and the server aggregates the stored review findings in the database — zero LLM calls, zero tokens — and publishes them nightly at 03:00 UTC as ONE `GHAGGA Health Digest` issue per repository, updated in place on every run (per-severity window counts, score trend, top-10 riskiest files by severity weight x recency). Runs with no new findings skip without touching the issue; publication failures (e.g. missing Issues-write permission) are recorded as `FAILED` on the digest history row, never silently dropped, and the next nightly run still fires.
  
  Digest scheduling is a SaaS/App-only capability by design (the CLI's `ghagga health` and the GitHub Action path are unchanged); publication is GitHub-only in v1 (the GitLab port exposes MR notes only). The feature defaults to OFF for every repository.
- 0ebccde: Add output style calibration: every prose review voice (simple, workflow specialists and synthesis, consensus stances, diagnostic, fan-out lenses) now appends a compact OUTPUT_STYLE_CALIBRATION directive — one-line MESSAGE/SUGGESTION, verdict-first bold SUMMARY, file:line references, zero filler — targeting ~30-40% fewer output tokens. On by default; disable with `--no-compress-output` or `.ghagga.json` `"compressOutput": false` to restore byte-identical prompts. Refuter and contrarian voices stay excluded.
  
  Also measure the output-token split for the previously unmeasured modes: simple, diagnostic, and fan-out now report `metadata.outputTokensUsed` (fan-out sums across lenses, contrarians, and refuters), and the cost footer renders the measured split, falling back to the "estimated 70/30" label on providers that report no split (gateway).

### Patch Changes

- d9827d0: Fix wave: 24 backlog items from the day's five SDD 4R reviews. Correctness: spec three-writer reconciliation, extractChangedSymbols tail-fallback reset, staleness NaN fail-closed, per-side token split guards (workflow/consensus/fan-out), watermark clock-skew pin. Resilience: diagram lazy-load error boundary, digest worker lazy forge seam (deleted repo → SKIPPED not 3 attempts), settings scheduler hooks surfaced, reconciler NaN guard. Quality: fixture score-docs, 30-day window cross-refs, GRAPH_STALE_DAYS constant, mermaid-lazy regex tightened, comparePaths deduplicated, double graph load skipped. Investigation: CLI markdown output now renders Blast Radius; GatewayResponse accepts token split (bridge-side pending); semgrep failures surface as errors instead of silent 0-findings; NEEDS_HUMAN_REVIEW added to the reviewer's STATUS menu. Diagram redesigned for legibility: flowchart LR, theme-adaptive palette, 2-segment clusters, test files collapsed into per-cluster summary nodes. Comment format overhauled: top-10 visible findings with the rest collapsed (byte-capped), diagram positioned after Summary, AI summary headings normalized, cost footer honest about partial token measurement.

## 3.7.1

### Patch Changes

- 870b616: Scope Gitleaks to files and lines added by the review diff, and honor a repository `.gitleaks.toml` or `.gitleaksignore` when one is present.

## 3.7.0

### Minor Changes

- Add Groq as a direct provider. The CLI and GitHub Action call Groq chat completions at api.groq.com with an API key instead of remapping `groq` to gateway.

## 3.6.1

### Patch Changes

- 48ebc73: Fail CI when OSV reports a lockfile advisory, restore the Test GHAGGA Action workflow, and move the floating major tag when a stable release is published.

## 3.6.0

### Minor Changes

- Lockstep v3.6.0. Dependency ranges since 3.5.0 move forward (AI SDK, Zod, protobuf, tree-sitter WASMs). No public API change.

## 3.5.0

### Minor Changes

- TypeScript 7, pnpm 12, esbuild Action bundle (ncc removed), public docs aligned with the runtime, and live GitLab `--mr` write-path E2E.

## 3.4.0

### Minor Changes

- fefa99e: Add `codex` and `claude` CLI adapters to the cli-bridge (selectable via a new optional `cli` config field on the triage config; default stays `opencode`), giving triage/review a reliable gpt-5.x (codex) or Claude (claude CLI) backend instead of the flaky opencode-go path.

  SECURITY: while adding them, fixed a command-injection RCE that affected ALL cli-bridge adapters (opencode/copilot/gemini too): commands were built as shell strings with `JSON.stringify`-quoted args and run via `execSync` → `/bin/sh -c`. `JSON.stringify` does not escape `$`/backtick, so an untrusted issue body containing `$(...)` or backticks executed on the host. All adapters now use `execFileSync(command, argsArray)` with no shell — the prompt is an inert argv element. Verified with a security regression test.

- 56dca64: Consensus now persists `INCONCLUSIVE` when votes do not decide (gap, abstain/empty/zero confidence, or no 60% threshold).
- a86a886: Add first-class `INCONCLUSIVE` review ledger status to `ReviewStatus` and the exhaustive compile/API surfaces (filter, format, CLI exit code, dashboard badge). Consensus vote summaries remain `NEEDS_HUMAN_REVIEW`; this does not remap them.
- 3a25d6f: LLM STATUS parsers in simple, fan-out, and critique now accept `INCONCLUSIVE` instead of coercing it to `NEEDS_HUMAN_REVIEW`.

### Patch Changes

- 8411136: Multi-voice review modes (workflow, consensus, fan-out) now validate FULFILLED voice responses before counting them as successes. A voice whose generateFn resolves with empty/whitespace-only text, or whose entire body is a JSON error envelope (`is_error: true`, or Claude CLI's `{"type":"result","subtype":"error_*"}` shape), is routed into the existing failure path (✗ progress event, `[FAILED]` synthesis note, `[FAILED:reason]` modelsUsed tag, tokens not counted) instead of polluting the synthesis/vote/merge step. Previously a gateway returning HTTP 200 with a raw CLI error envelope was logged as `✓ — 0 tokens` and a 5-voice review silently ran with 4 voices. The heuristic is narrow: only the whole trimmed text parsing as such a JSON object counts, so legitimate reviews that merely contain the word "error" (or embed an error JSON snippet in prose) are never rejected.
- a1239d3: Opt-in `contrarianCount` for fan-out: N unlensed whole-diff voices on `generateFns[1..N]` after `pinLensesToFirst`. Requires integer >= 1, pin true, and a long enough provider chain. Invalid `.ghagga.json` values fail closed.
- fdfacff: Fan-out stamps a per-finding ledger after merge: `id`, `lens`, `location`, `ledgerStatus` (`open`), and `evidence`. Fields are optional on `ReviewFinding` so other modes stay compatible. No persistence or refuters yet.
- 089a5b6: Opt-in `pinLensesToFirst` so fan-out lenses all use `generateFns[0]` instead of round-robin. Set `"pinLensesToFirst": true` in `.ghagga.json`; omit to keep current assignment. Non-boolean config fail-closes.
- 91930f4: Opt-in `refuterCount` (integer >= 2) for fan-out: one batched generateFn per refuter over the closed critical ledger. 2-of-K `refute` votes set `ledgerStatus` to `refuted`. Requires `pinLensesToFirst`. Invalid `.ghagga.json` values fail closed.
- 8f11441: Add `hybrid-4r` review mode as sugar over fan-out with `pinLensesToFirst` forced on. Contrarian, refuter, and anchor settings stay opt-in.

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
