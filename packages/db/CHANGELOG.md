# ghagga-db

## 3.8.0

### Minor Changes

- 07a06f8: Add graph-guided context retrieval: reviews now include a budgeted "Graph Neighborhood" section listing each changed file's direct importers, imports and exported symbols, assembled from the dependency graph index. On by default when a graph is available (`ghagga index` or a published `ghagga/graph` branch); disable with `--no-graph-context` or `enableGraphContext: false`. The section degrades fail-closed (missing, stale >7d, or oversized graph → no section, prompts byte-identical to before) and never shrinks the diff budget — it rides a dedicated `graphContextMaxTokens` sidecar (default 1200).
  
  Also persist a measured input/output token split: providers that report usage now feed `reviews.input_tokens` / `reviews.output_tokens` (additive nullable columns, `tokens_used` remains authoritative), and the cost footer shows the measured split, falling back to an "estimated 70/30" label when unmeasured.
- 455967a: Add an opt-in nightly health digest for SaaS/App repositories: set `digestsEnabled` on a repository (or at the installation level for repos using global settings) and the server aggregates the stored review findings in the database — zero LLM calls, zero tokens — and publishes them nightly at 03:00 UTC as ONE `GHAGGA Health Digest` issue per repository, updated in place on every run (per-severity window counts, score trend, top-10 riskiest files by severity weight x recency). Runs with no new findings skip without touching the issue; publication failures (e.g. missing Issues-write permission) are recorded as `FAILED` on the digest history row, never silently dropped, and the next nightly run still fires.
  
  Digest scheduling is a SaaS/App-only capability by design (the CLI's `ghagga health` and the GitHub Action path are unchanged); publication is GitHub-only in v1 (the GitLab port exposes MR notes only). The feature defaults to OFF for every repository.
- 0ebccde: Add output style calibration: every prose review voice (simple, workflow specialists and synthesis, consensus stances, diagnostic, fan-out lenses) now appends a compact OUTPUT_STYLE_CALIBRATION directive — one-line MESSAGE/SUGGESTION, verdict-first bold SUMMARY, file:line references, zero filler — targeting ~30-40% fewer output tokens. On by default; disable with `--no-compress-output` or `.ghagga.json` `"compressOutput": false` to restore byte-identical prompts. Refuter and contrarian voices stay excluded.
  
  Also measure the output-token split for the previously unmeasured modes: simple, diagnostic, and fan-out now report `metadata.outputTokensUsed` (fan-out sums across lenses, contrarians, and refuters), and the cost footer renders the measured split, falling back to the "estimated 70/30" label on providers that report no split (gateway).

### Patch Changes

- d9827d0: Fix wave: 24 backlog items from the day's five SDD 4R reviews. Correctness: spec three-writer reconciliation, extractChangedSymbols tail-fallback reset, staleness NaN fail-closed, per-side token split guards (workflow/consensus/fan-out), watermark clock-skew pin. Resilience: diagram lazy-load error boundary, digest worker lazy forge seam (deleted repo → SKIPPED not 3 attempts), settings scheduler hooks surfaced, reconciler NaN guard. Quality: fixture score-docs, 30-day window cross-refs, GRAPH_STALE_DAYS constant, mermaid-lazy regex tightened, comparePaths deduplicated, double graph load skipped. Investigation: CLI markdown output now renders Blast Radius; GatewayResponse accepts token split (bridge-side pending); semgrep failures surface as errors instead of silent 0-findings; NEEDS_HUMAN_REVIEW added to the reviewer's STATUS menu. Diagram redesigned for legibility: flowchart LR, theme-adaptive palette, 2-segment clusters, test files collapsed into per-cluster summary nodes. Comment format overhauled: top-10 visible findings with the rest collapsed (byte-capped), diagram positioned after Summary, AI summary headings normalized, cost footer honest about partial token measurement.

## 3.7.1

No changes in this release.

## 3.7.0

### Minor Changes

- Add Groq as a direct provider. The CLI and GitHub Action call Groq chat completions at api.groq.com with an API key instead of remapping `groq` to gateway.

## 3.6.1

### Patch Changes

- 48ebc73: Fail CI when OSV reports a lockfile advisory, restore the Test GHAGGA Action workflow, and move the floating major tag when a stable release is published.

## 3.6.0

### Minor Changes

- Lockstep v3.6.0. Dependency ranges since 3.5.0 move forward (Drizzle ORM, pg). No public API change.

## 3.5.0

### Minor Changes

- TypeScript 7, pnpm 12, esbuild Action bundle (ncc removed), public docs aligned with the runtime, and live GitLab `--mr` write-path E2E.

## 3.4.0

### Minor Changes

- bbdd7a4: Add issue_drafts approval-queue table + typed queries.

## 3.3.0

## 3.2.0

### Minor Changes

- 8cc5cdd: Publish semantic-memory retrieval across the CLI, core engine, and storage backends, including configurable embedding providers, hybrid keyword/vector search, safe schema metadata, backfill tooling, and graceful keyword-only fallback.

  Include the post-3.1.0 reliability, security, forge-integration, and distribution corrections, and keep the four published package versions aligned for the coordinated release.

## 3.1.0

## 3.0.0

### Major Changes

- v3.0.0 — coordinated major release. Realigns the published packages onto a single version (core was at 2.9.1, cli/db at 2.8.1) and ships the breaking changes that accumulated since 2.7.0 — several of which were previously MISLABELED as "minor" in the changelog (corrected here after a 3-package breaking-change audit).

  BREAKING CHANGES (verified against the published export surface):
  - **ghagga-core**: `applyVirtualPatches` return type changed from `string` to `VirtualPatchResult` (`{ diff, injectedLineIndices }`). Any caller using the return value as a string breaks at both compile and runtime. (Was mislabeled "semver minor" under `recursive-coordinate-contract`.)

  - **ghagga (CLI)**: legacy `--provider` / `GHAGGA_PROVIDER` values (`github`, `anthropic`, `openai`, `google`, `groq`, `openrouter`, `azure`, `deepseek`, `qwen`, `cerebras`) now exit with code 1 — they previously routed directly. Use `gateway` (the new default). Default model changed `gpt-4o-mini` → `auto`. Stored-config legacy values are silently remapped to `gateway`, so logged-in users without an explicit flag are unaffected.

  - **ghagga-db**: removed the entire delegated-CI surface — 9 query functions (`getDelegatedCiPolicy`, `updateDelegatedCiPolicy`, `createDelegatedCiRun`, …) and 5 schema exports (`delegatedCiRuns` table, `DbDelegatedCiPolicy`, `DbDelegatedCiClassification`, …). `encrypt()` output format changed v1 → v2 (`v2:<iv>:<cipher>:<tag>`); `decrypt()` auto-detects both formats (backward-compatible for reads).

  ADDITIVE / FIXES bundled in this release (non-breaking): `ReviewResult.coverageComplete` and `ReviewResult.semanticDiff` optional fields; unified diff-parser quoted-path + rename + deletion-attribution fixes (CORE-M6/M8/M9); recursive review off-by-N fix; static-analysis findings now scoped to the changed files (reviews stop failing on unrelated repo-wide debt); ghagga's bundled semgrep ruleset now runs in the active pipeline; gitleaks test-fixture allowlist.

  The GitHub Action (`@ghagga/action`) input/output contract is unchanged (its `provider` default tracks the CLI's gateway default, with graceful legacy remapping).
