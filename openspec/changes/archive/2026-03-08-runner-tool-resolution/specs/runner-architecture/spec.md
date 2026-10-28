# Delta for Runner Architecture

> **Change**: `runner-tool-resolution`
> **Affects**: `openspec/specs/runner-architecture/spec.md` — Tool Execution in Runner section

---

## ADDED Requirements

### Requirement: Workflow Dispatch Accepts Tool Resolution Inputs

The runner workflow MUST accept `enabledTools` and `disabledTools` as optional string-type `workflow_dispatch` inputs. Each input SHALL contain a JSON-encoded array of tool name strings (e.g., `'["ruff","bandit"]'`). If omitted, both MUST default to `'[]'` (empty JSON array).

#### Scenario: Server sends enabledTools and disabledTools

- GIVEN the server dispatches a workflow with `enabledTools: '["ruff","bandit"]'` and `disabledTools: '["cpd"]'`
- WHEN the runner workflow starts
- THEN `github.event.inputs.enabledTools` MUST equal `'["ruff","bandit"]'`
- AND `github.event.inputs.disabledTools` MUST equal `'["cpd"]'`

#### Scenario: Server sends empty arrays (default behavior)

- GIVEN the server dispatches without specifying enabledTools/disabledTools
- WHEN the runner workflow starts
- THEN `github.event.inputs.enabledTools` MUST equal `'[]'`
- AND `github.event.inputs.disabledTools` MUST equal `'[]'`

#### Scenario: Invalid JSON in enabledTools is treated as empty

- GIVEN the server dispatches with `enabledTools: 'not-json'`
- WHEN the resolve step parses the input
- THEN the resolve step MUST treat enabledTools as an empty array
- AND the workflow MUST NOT fail

---

### Requirement: Tool Resolution Step

The runner workflow MUST include a "Resolve Tools" step that determines which tools to execute. The resolution algorithm MUST mirror the logic in `packages/core/src/tools/resolve.ts`.

The resolution order MUST be:
1. Start with all always-on tools: `semgrep`, `trivy`, `cpd`, `gitleaks`, `shellcheck`, `markdownlint`, `lizard`
2. For each auto-detect tool, check if relevant files exist in `target-repo/`:
   - `ruff`: any `.py` or `.pyi` file exists
   - `bandit`: any `.py` file exists
   - `golangci-lint`: `go.mod` exists OR any `.go` file exists
   - `biome`: any `.ts`, `.tsx`, `.js`, `.jsx`, `.mts`, `.mjs`, `.cts`, `.cjs` file exists
   - `pmd`: any `.java` file exists
   - `psalm`: any `.php` file exists
   - `clippy`: `Cargo.toml` exists OR any `.rs` file exists
   - `hadolint`: any file matching `Dockerfile*` exists
3. Add any tools listed in `enabledTools` (force-enable override)
4. Remove any tools listed in `disabledTools` (force-disable override, takes precedence over everything)
5. If `disabledTools` is empty AND legacy boolean flags are present, apply them as fallback:
   - `enableSemgrep == 'false'` → remove `semgrep`
   - `enableTrivy == 'false'` → remove `trivy`
   - `enableCpd == 'false'` → remove `cpd`

The step MUST output the resolved tool list as a JSON array string to `$GITHUB_OUTPUT` with key `tools`.

#### Scenario: Python repository with default settings

- GIVEN a target-repo containing `.py` files and no `go.mod`
- AND `enabledTools: '[]'` and `disabledTools: '[]'`
- WHEN the resolve step runs
- THEN the output MUST include all 7 always-on tools
- AND the output MUST include `ruff` and `bandit` (auto-detected via `.py`)
- AND the output MUST NOT include `golangci-lint`, `biome`, `pmd`, `psalm`, `clippy`, or `hadolint`

#### Scenario: Force-enable a tool that would not auto-detect

- GIVEN a target-repo containing only `.ts` files
- AND `enabledTools: '["ruff"]'`
- WHEN the resolve step runs
- THEN the output MUST include `ruff` (force-enabled despite no `.py` files)
- AND the output MUST include `biome` (auto-detected via `.ts`)

#### Scenario: Force-disable an always-on tool

- GIVEN `disabledTools: '["semgrep","gitleaks"]'`
- WHEN the resolve step runs
- THEN the output MUST NOT include `semgrep` or `gitleaks`
- AND the output MUST include the remaining 5 always-on tools

#### Scenario: disabledTools takes precedence over enabledTools

- GIVEN `enabledTools: '["ruff"]'` and `disabledTools: '["ruff"]'`
- WHEN the resolve step runs
- THEN the output MUST NOT include `ruff` (disabled takes precedence)

#### Scenario: Legacy boolean fallback when disabledTools is empty

- GIVEN `disabledTools: '[]'` and `enableSemgrep: 'false'`
- WHEN the resolve step runs
- THEN the output MUST NOT include `semgrep`

#### Scenario: Legacy booleans ignored when disabledTools is non-empty

- GIVEN `disabledTools: '["cpd"]'` and `enableSemgrep: 'false'`
- WHEN the resolve step runs
- THEN the output MUST NOT include `cpd` (from disabledTools)
- AND the output MUST include `semgrep` (legacy boolean ignored because disabledTools is non-empty)

#### Scenario: Clone failure skips resolution

- GIVEN the clone step failed (`steps.clone.outcome == 'failure'`)
- WHEN the resolve step evaluates its `if` condition
- THEN the resolve step MUST be skipped
- AND no tools MUST be installed or run

---

### Requirement: Conditional Tool Install/Run/Parse Steps

Each of the 15 tools MUST have three conditional steps: install, run, and parse. Each step MUST be gated on:
1. The tool being present in the resolved tools list: `contains(steps.resolve.outputs.tools, '"toolname"')`
2. The clone having succeeded: `steps.clone.outcome == 'success'`

Each install and run step MUST use `continue-on-error: true` so that a failure in one tool does not block subsequent tools.

#### Scenario: Tool is resolved and succeeds

- GIVEN `ruff` is in the resolved tools list
- WHEN the ruff-install, ruff-run, and ruff-parse steps execute
- THEN `/tmp/ruff-result.json` MUST contain `{"status":"success","findings":[...],"executionTimeMs":N}`

#### Scenario: Tool is not resolved

- GIVEN `ruff` is NOT in the resolved tools list
- WHEN the workflow evaluates the ruff-install step's `if` condition
- THEN the ruff-install, ruff-run, and ruff-parse steps MUST all be skipped

#### Scenario: Tool install fails

- GIVEN `gitleaks` is in the resolved tools list
- AND the gitleaks binary download fails (network error)
- WHEN the gitleaks-install step fails
- THEN the step MUST NOT fail the job (continue-on-error)
- AND the gitleaks-run step SHOULD detect the missing binary and produce an error result
- AND subsequent tool steps MUST still execute

#### Scenario: Tool run crashes

- GIVEN `bandit` is installed and running
- AND bandit crashes with a non-zero exit code and no JSON output
- WHEN the bandit-parse step runs
- THEN `/tmp/bandit-result.json` MUST contain `{"status":"error","findings":[],"error":"bandit: execution failed","executionTimeMs":N}`

---

### Requirement: Per-Tool Caching

Each tool that benefits from caching MUST have a cache step gated on the tool being resolved. Cache keys MUST include the tool version and runner OS.

The following tools MUST have dedicated cache steps:
- `semgrep`: pip cache (`~/.cache/pip`), key `semgrep-{version}-{os}`
- `trivy`: DB cache (`~/.cache/trivy`), key with dependency file hash
- `cpd`/`pmd`: shared PMD binary (`/opt/pmd`), key `pmd-{version}-{os}`
- `gitleaks`: binary (`/usr/local/bin/gitleaks`), key `gitleaks-{version}-{os}`
- `golangci-lint`: binary, key `golangci-lint-{version}-{os}`
- `lizard`: pip cache, key `lizard-{version}-{os}`
- `ruff`: pip cache, key `ruff-{version}-{os}`
- `bandit`: pip cache, key `bandit-{version}-{os}`
- `biome`: binary, key `biome-{version}-{os}`
- `hadolint`: binary, key `hadolint-{version}-{os}`

Tools that MAY skip dedicated caching (minimal install overhead):
- `shellcheck` (pre-installed on ubuntu-latest)
- `markdownlint` (npm global, fast install)
- `psalm` (PHAR download, small)
- `clippy` (uses project's Rust toolchain)

#### Scenario: Cache hit skips installation

- GIVEN the `semgrep` cache key matches a previous run
- WHEN the semgrep-install step runs
- THEN it MUST detect the existing binary and skip re-downloading
- AND installation time MUST be under 10 seconds

#### Scenario: Cache miss triggers fresh install

- GIVEN no cache entry exists for `gitleaks-8.21.2`
- WHEN the gitleaks-install step runs
- THEN it MUST download the binary from GitHub Releases
- AND save it to the cache path for future runs

---

### Requirement: Security — Silent Tool Execution

All 15 tools MUST follow the same security contract as the existing 3 tools:
1. All tool stdout and stderr MUST be redirected to files (e.g., `/tmp/{tool}-raw.json`), NEVER printed to workflow logs
2. All `echo` or `jq` processing MUST redirect stderr to `/dev/null`
3. Tool error messages in result JSON MUST be generic (e.g., `"{tool}: execution failed"`), MUST NOT contain file paths or code content from the target repository

#### Scenario: Tool output not visible in logs

- GIVEN a tool runs on a private repository
- WHEN the workflow logs are inspected (before deletion)
- THEN the logs MUST NOT contain any file paths, code snippets, or finding messages from the target repository
- AND the logs MUST only show step names, timing, and generic status messages

#### Scenario: Parse failure produces safe error

- GIVEN semgrep produces malformed JSON output
- WHEN the parse step attempts to process it
- THEN the result file MUST contain `"error":"semgrep: parse failed"`
- AND the error MUST NOT include any content from the malformed output

---

## MODIFIED Requirements

### Requirement: Callback Payload Schema (Extended)

The callback payload MUST include results for ALL resolved tools, not just `semgrep`/`trivy`/`cpd`.

(Previously: The callback payload contained only `staticAnalysis: { semgrep, trivy, cpd }`)

The `staticAnalysis` object MUST:
1. ALWAYS include `semgrep`, `trivy`, and `cpd` keys (backward compatibility)
2. Include a key for each additional tool that was resolved, regardless of whether it succeeded or failed
3. Tools that were not resolved MUST NOT appear in the payload (they are simply absent)
4. Non-resolved legacy tools (semgrep/trivy/cpd) MUST have `status: "skipped"` with empty findings

#### Scenario: Full payload with 10 tools resolved

- GIVEN 10 tools were resolved (7 always-on + ruff, bandit, biome)
- WHEN the assemble step builds the payload
- THEN the `staticAnalysis` object MUST have exactly 10 keys
- AND each key MUST map to a valid `ToolResult` with `status`, `findings`, and `executionTimeMs`

#### Scenario: Backward compatible payload with only 3 tools

- GIVEN only semgrep, trivy, and cpd were resolved (all auto-detect tools disabled)
- WHEN the assemble step builds the payload
- THEN the `staticAnalysis` object MUST have exactly 3 keys: `semgrep`, `trivy`, `cpd`
- AND the payload MUST be structurally identical to the current format

#### Scenario: Legacy tool disabled but key still present

- GIVEN `disabledTools: '["semgrep"]'`
- WHEN the assemble step builds the payload
- THEN `staticAnalysis.semgrep` MUST be `{"status":"skipped","findings":[],"executionTimeMs":0}`
- AND `staticAnalysis.trivy` and `staticAnalysis.cpd` MUST have their actual results

#### Scenario: Clone failure callback includes all legacy keys

- GIVEN the clone step failed
- WHEN the clone failure handler sends the callback
- THEN the payload MUST include `semgrep`, `trivy`, and `cpd` keys all with `status: "error"`
- AND the payload SHOULD also include error results for any other tools that would have been resolved

---

### Requirement: Tool Execution Timing

Each tool's execution time MUST be measured independently and reported in `executionTimeMs`.

(Previously: Only semgrep, trivy, and cpd had individual timing)

#### Scenario: All tools report execution time

- GIVEN 10 tools are resolved and run
- WHEN the callback payload is assembled
- THEN each of the 10 tool results MUST have an `executionTimeMs` value > 0

#### Scenario: Skipped tools report zero time

- GIVEN a tool was not resolved (skipped)
- WHEN its result is included in the payload
- THEN `executionTimeMs` MUST be 0

---

## REMOVED Requirements

(None — this change is purely additive to the runner architecture)
