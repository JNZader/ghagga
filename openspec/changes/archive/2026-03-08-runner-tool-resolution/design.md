# Design: Runner Dynamic Tool Resolution

## Technical Approach

Transform `templates/ghagga-analysis.yml` from a 3-tool hardcoded workflow into a 15-tool dynamic workflow. The YAML receives `enabledTools`/`disabledTools` JSON arrays from the server, runs a bash-based resolve step that mirrors `packages/core/src/tools/resolve.ts`, and conditionally installs/runs/parses each tool based on the resolution output.

No server-side or core library changes are needed — the server already dispatches these fields and the `StaticAnalysisResult` type already supports dynamic tool keys.

## Architecture Decisions

### Decision: Single-file YAML with conditional steps (not reusable workflows)

**Choice**: Keep all 15 tools in one workflow file using `if:` conditions.
**Alternatives considered**: (a) Reusable workflows per tool, (b) composite actions, (c) external script.
**Rationale**: Reusable workflows can't access secrets from the calling workflow's `workflow_dispatch` inputs without explicitly passing them. Composite actions add complexity for no benefit. External scripts would need to be committed to the runner repo, which we don't control (user might tamper). A single file with clear sections is auditable and matches the existing pattern.

### Decision: Bash resolve step (not jq or Python)

**Choice**: Pure bash with `find` for file detection, jq for JSON manipulation.
**Alternatives considered**: (a) Python script, (b) Node.js script.
**Rationale**: bash + jq are pre-installed on `ubuntu-latest`. Python would work but adds a step. The resolve logic is simple enough for bash: build an array, run `find` for auto-detect, apply overrides with jq.

### Decision: `contains()` with quoted tool names for step conditions

**Choice**: Gate each tool's steps with `if: contains(steps.resolve.outputs.tools, '"toolname"')` (note the inner quotes).
**Alternatives considered**: (a) Individual boolean outputs per tool, (b) `fromJSON()` with a matrix.
**Rationale**: `contains('"toolname"')` with inner quotes prevents false matches (e.g., `"pmd"` won't match `"cpd"` substring). Individual booleans would require 15 output variables. Matrix strategy would parallelize but loses the ability to share installed binaries (PMD/CPD) and makes the assemble step harder.

### Decision: Inline jq/python parsing (not external scripts)

**Choice**: Each tool's parse logic is inline bash/jq/python in the YAML.
**Alternatives considered**: Importing parsers from `packages/core`.
**Rationale**: The YAML runs on the user's runner repo, which only has the workflow file. We can't import from `packages/core`. The parse logic for each tool is 5-20 lines of jq or python and is directly adapted from the TypeScript plugin `parse` functions.

### Decision: Sequential tool execution

**Choice**: Tools run sequentially (install A → run A → install B → run B → ...).
**Alternatives considered**: Parallel execution via matrix or background processes.
**Rationale**: Sequential is simpler, more debuggable, and stays within the 15-min timeout. Parallel execution with matrix would require each matrix job to clone the repo again and assemble results across jobs — significantly more complex. With caching, cold start is ~3 min and warm start is ~30s per tool.

### Decision: PMD binary shared between CPD (always-on) and PMD (auto-detect)

**Choice**: CPD's install step installs PMD to `/opt/pmd`; PMD's install step checks if it's already there.
**Alternatives considered**: Separate installations.
**Rationale**: They use the exact same binary. Double-installing would waste ~300MB and 30s. The CPD install step runs first (always-on tools are resolved before auto-detect), so PMD's install is a no-op.

## Data Flow

```
Server dispatch                  Runner YAML
─────────────                    ──────────
                                 
enabledTools: '["ruff"]'    ──→  workflow_dispatch inputs
disabledTools: '["cpd"]'   ──→  
enableSemgrep: 'true'      ──→  (legacy compat)
                                 
                                 ┌───────────────────────┐
                                 │  1. Mask sensitive     │
                                 │  2. Clone target-repo  │
                                 └──────────┬────────────┘
                                            │
                                 ┌──────────▼────────────┐
                                 │  3. Resolve Tools      │
                                 │  - always-on base set  │
                                 │  - find for auto-detect│
                                 │  - apply overrides     │
                                 │  OUTPUT: tools JSON    │
                                 │  e.g. '["semgrep",     │
                                 │   "trivy","gitleaks",  │
                                 │   "ruff",...]'         │
                                 └──────────┬────────────┘
                                            │
                        ┌───────────────────┼───────────────────┐
                        │                   │                   │
                  if "semgrep"        if "gitleaks"        if "ruff"
                  ┌─────▼─────┐      ┌─────▼─────┐      ┌─────▼─────┐
                  │ cache     │      │ cache     │      │ cache     │
                  │ install   │      │ install   │      │ install   │
                  │ run       │      │ run       │      │ run       │
                  │ parse     │      │ parse     │      │ parse     │
                  │ → /tmp/   │      │ → /tmp/   │      │ → /tmp/   │
                  │ semgrep-  │      │ gitleaks- │      │ ruff-     │
                  │ result.json      │ result.json      │ result.json
                  └─────┬─────┘      └─────┬─────┘      └─────┬─────┘
                        │                   │                   │
                        └───────────────────┼───────────────────┘
                                            │
                                 ┌──────────▼────────────┐
                                 │  Assemble + Callback   │
                                 │  - read all result.json│
                                 │  - ensure semgrep/     │
                                 │    trivy/cpd present   │
                                 │  - HMAC sign           │
                                 │  - POST to callbackUrl │
                                 └──────────┬────────────┘
                                            │
                                 ┌──────────▼────────────┐
                                 │  Cleanup               │
                                 │  - delete logs         │
                                 │  - rm target-repo      │
                                 └───────────────────────┘
```

## File Changes

| File                            | Action | Description                                                                                                 |
| ------------------------------- | ------ | ----------------------------------------------------------------------------------------------------------- |
| `templates/ghagga-analysis.yml` | Modify | Add 2 new inputs, resolve step, 12 new tool blocks, extended assemble step. Grows from ~350 to ~1200 lines. |

No other files change. The server and core library already support the full 15-tool ecosystem.

## Tool Catalog: Install/Run/Parse Reference

Each tool block in the YAML follows this structure:

```yaml
# ── Cache: {Tool} ───────────────────────────────────
- name: Cache {Tool}
  if: contains(steps.resolve.outputs.tools, '"toolname"') && steps.clone.outcome == 'success'
  uses: actions/cache@v4
  with:
    path: {cache_path}
    key: {tool}-{version}-${{ runner.os }}

# ── Install {Tool} ─────────────────────────────────
- name: Install {Tool}
  if: contains(steps.resolve.outputs.tools, '"toolname"') && steps.clone.outcome == 'success'
  continue-on-error: true
  run: |
    {install_commands} 2>/dev/null

# ── Run {Tool} ─────────────────────────────────────
- name: Run {Tool}
  if: contains(steps.resolve.outputs.tools, '"toolname"') && steps.clone.outcome == 'success'
  id: {toolid}
  continue-on-error: true
  run: |
    START_MS=$(($(date +%s%N)/1000000))
    set +e
    {run_command} > /tmp/{tool}-raw.json 2>/dev/null
    EXIT=$?
    END_MS=$(($(date +%s%N)/1000000))
    ELAPSED=$((END_MS - START_MS))
    {parse_logic_producing /tmp/{tool}-result.json}
```

### Always-On Tools

| Tool         | Version | Install                                       | Run                                                                                                                     | Parse                                                                                                   | Cache                     |
| ------------ | ------- | --------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- | ------------------------- |
| semgrep      | 1.90.0  | `pip install semgrep==1.90.0`                 | `semgrep --json --config auto --quiet target-repo`                                                                      | jq: `.results[]` → severity mapping (ERROR→high, WARNING→medium, INFO→info)                             | `~/.cache/pip`            |
| trivy        | 0.69.3  | `curl install.sh \| sh -s -- v0.69.3`         | `trivy fs --format json --scanners vuln,license --quiet target-repo`                                                    | jq: `.Results[].Vulnerabilities[]` severity mapping                                                     | `~/.cache/trivy`          |
| cpd          | 7.8.0   | PMD zip extract to `/opt/pmd`                 | `pmd cpd --format xml --minimum-tokens 100 --dir target-repo --skip-lexical-errors`                                     | python3: XML parse `<duplication>` elements                                                             | `/opt/pmd`                |
| gitleaks     | 8.21.2  | `curl tar.gz → /usr/local/bin/gitleaks`       | `gitleaks detect --source target-repo --report-format json --report-path /tmp/gitleaks-raw.json --no-git --exit-code 0` | jq: `.[]` → `severity: "critical"`, `category: "secrets"`                                               | `/usr/local/bin/gitleaks` |
| shellcheck   | 0.10.0  | Verify pre-installed; fallback: `curl tar.xz` | `shellcheck --format=json $(find target-repo -name '*.sh' -o -name '*.bash')`                                           | jq: `.[]` → level mapping (error→high, warning→medium)                                                  | none (pre-installed)      |
| markdownlint | 0.17.1  | `npm install -g markdownlint-cli2@0.17.1`     | `markdownlint-cli2 "target-repo/**/*.md"`                                                                               | jq: parse output → `severity: "info"`, `category: "docs"`                                               | none (fast npm)           |
| lizard       | 1.17.13 | `pip install lizard==1.17.13`                 | `lizard --json target-repo`                                                                                             | python3: `.function_list[].cyclomatic_complexity` → severity thresholds (>20→high, >15→medium, >10→low) | `~/.cache/pip`            |

### Auto-Detect Tools

| Tool          | Version   | Detect                                                       | Install                                     | Run                                                                                 | Parse                                                               | Cache                          |
| ------------- | --------- | ------------------------------------------------------------ | ------------------------------------------- | ----------------------------------------------------------------------------------- | ------------------------------------------------------------------- | ------------------------------ |
| ruff          | 0.9.7     | `.py`, `.pyi`                                                | `pip install ruff==0.9.7`                   | `ruff check --output-format json target-repo`                                       | jq: code prefix mapping (F→high, E→medium, W→low)                   | `~/.cache/pip`                 |
| bandit        | 1.8.3     | `.py`                                                        | `pip install bandit==1.8.3`                 | `bandit -r target-repo -f json --quiet`                                             | jq: `.results[]` → severity mapping (HIGH→high, MEDIUM→medium)      | `~/.cache/pip`                 |
| golangci-lint | 1.63.4    | `go.mod`, `.go`                                              | `curl install.sh → /usr/local/bin`          | `golangci-lint run --out-format json` (cwd=target-repo)                             | jq: `.Issues[]` → FromLinter-based mapping                          | `/usr/local/bin/golangci-lint` |
| biome         | 1.9.4     | `.ts`, `.tsx`, `.js`, `.jsx`, `.mts`, `.mjs`, `.cts`, `.cjs` | `npm install -g @biomejs/biome@1.9.4`       | `biome lint --reporter json target-repo`                                            | jq: `.diagnostics[]` → severity mapping                             | none (fast npm)                |
| pmd           | 7.8.0     | `.java`, `.kt`                                               | Shared with CPD (check `/opt/pmd/bin/pmd`)  | `pmd check --format json --dir target-repo --rulesets rulesets/java/quickstart.xml` | jq: `.files[].violations[]` → priority mapping (1→critical..5→info) | `/opt/pmd` (shared)            |
| psalm         | 6.5.1     | `.php`, `composer.json`                                      | `composer global require vimeo/psalm:6.5.1` | `psalm --output-format=json --no-cache` (cwd=target-repo)                           | none (small PHAR)                                                   |
| clippy        | toolchain | `Cargo.toml`, `.rs`                                          | Verify `cargo` exists                       | `cargo clippy --message-format=json -- -W clippy::all` (cwd=target-repo)            | none (uses project toolchain)                                       |
| hadolint      | 2.12.0    | `Dockerfile*`                                                | `curl binary → /usr/local/bin/hadolint`     | `hadolint --format json $(find target-repo -name 'Dockerfile*')`                    | jq: `.[]` → level mapping                                           | `/usr/local/bin/hadolint`      |

## Resolve Step Algorithm (Bash)

```bash
# Step 1: Always-on tools
TOOLS='["semgrep","trivy","cpd","gitleaks","shellcheck","markdownlint","lizard"]'

# Step 2: Auto-detect via find
if find target-repo -name '*.py' -o -name '*.pyi' | head -1 | grep -q .; then
  TOOLS=$(echo "$TOOLS" | jq '. + ["ruff","bandit"]')
fi
if [ -f target-repo/go.mod ] || find target-repo -name '*.go' | head -1 | grep -q .; then
  TOOLS=$(echo "$TOOLS" | jq '. + ["golangci-lint"]')
fi
if find target-repo -name '*.ts' -o -name '*.tsx' -o -name '*.js' -o -name '*.jsx' \
   -o -name '*.mts' -o -name '*.mjs' -o -name '*.cts' -o -name '*.cjs' | head -1 | grep -q .; then
  TOOLS=$(echo "$TOOLS" | jq '. + ["biome"]')
fi
if find target-repo -name '*.java' -o -name '*.kt' | head -1 | grep -q .; then
  TOOLS=$(echo "$TOOLS" | jq '. + ["pmd"]')
fi
if find target-repo -name '*.php' -o -name 'composer.json' | head -1 | grep -q .; then
  TOOLS=$(echo "$TOOLS" | jq '. + ["psalm"]')
fi
if [ -f target-repo/Cargo.toml ] || find target-repo -name '*.rs' | head -1 | grep -q .; then
  TOOLS=$(echo "$TOOLS" | jq '. + ["clippy"]')
fi
if find target-repo -name 'Dockerfile*' | head -1 | grep -q .; then
  TOOLS=$(echo "$TOOLS" | jq '. + ["hadolint"]')
fi

# Step 3: Force-enable from enabledTools
ENABLED='${{ github.event.inputs.enabledTools }}'
ENABLED=$(echo "$ENABLED" | jq -r '.[]' 2>/dev/null || true)
for tool in $ENABLED; do
  TOOLS=$(echo "$TOOLS" | jq --arg t "$tool" 'if index($t) then . else . + [$t] end')
done

# Step 4: Force-disable from disabledTools (takes precedence)
DISABLED='${{ github.event.inputs.disabledTools }}'
DISABLED_ARRAY=$(echo "$DISABLED" | jq -r '.[]' 2>/dev/null || true)
for tool in $DISABLED_ARRAY; do
  TOOLS=$(echo "$TOOLS" | jq --arg t "$tool" 'map(select(. != $t))')
done

# Step 5: Legacy boolean fallback (only when disabledTools is empty)
DISABLED_LEN=$(echo "$DISABLED" | jq 'length' 2>/dev/null || echo "0")
if [ "$DISABLED_LEN" = "0" ]; then
  if [ "${{ github.event.inputs.enableSemgrep }}" = "false" ]; then
    TOOLS=$(echo "$TOOLS" | jq 'map(select(. != "semgrep"))')
  fi
  # ... same for enableTrivy, enableCpd
fi

# De-duplicate and output
TOOLS=$(echo "$TOOLS" | jq -c 'unique')
echo "tools=$TOOLS" >> "$GITHUB_OUTPUT"
```

## Assemble Step Design

The assemble step reads all `/tmp/{tool}-result.json` files and constructs the callback payload:

```bash
SKIPPED='{"status":"skipped","findings":[],"executionTimeMs":0}'
RESOLVED_TOOLS='${{ steps.resolve.outputs.tools }}'

# Build staticAnalysis object dynamically
SA='{}'

# Always ensure legacy keys
for legacy in semgrep trivy cpd; do
  RESULT=$(cat "/tmp/${legacy}-result.json" 2>/dev/null || echo "$SKIPPED")
  SA=$(echo "$SA" | jq --arg k "$legacy" --argjson v "$RESULT" '.[$k] = $v')
done

# Add all other resolved tools
for tool in $(echo "$RESOLVED_TOOLS" | jq -r '.[]'); do
  if [ "$tool" != "semgrep" ] && [ "$tool" != "trivy" ] && [ "$tool" != "cpd" ]; then
    RESULT=$(cat "/tmp/${tool}-result.json" 2>/dev/null || echo "$SKIPPED")
    SA=$(echo "$SA" | jq --arg k "$tool" --argjson v "$RESULT" '.[$k] = $v')
  fi
done

# Build full payload
PAYLOAD=$(jq -n \
  --arg cid "$CALLBACK_ID" \
  --arg repo "$REPO_FULL_NAME" \
  --arg pr "$PR_NUMBER" \
  --arg sha "$HEAD_SHA" \
  --argjson sa "$SA" \
  '{ callbackId: $cid, repoFullName: $repo, prNumber: ($pr|tonumber), headSha: $sha, staticAnalysis: $sa }')
```

## Interfaces / Contracts

### Workflow Dispatch Inputs (new fields)

```yaml
enabledTools:
  description: "JSON array of force-enabled tool names"
  required: false
  type: string
  default: "[]"
disabledTools:
  description: "JSON array of force-disabled tool names"
  required: false
  type: string
  default: "[]"
```

### Resolve Step Output

```
steps.resolve.outputs.tools = '["semgrep","trivy","cpd","gitleaks","shellcheck","markdownlint","lizard","ruff","bandit"]'
```

### Callback Payload (extended)

```json
{
  "callbackId": "...",
  "repoFullName": "...",
  "prNumber": 42,
  "headSha": "...",
  "staticAnalysis": {
    "semgrep": { "status": "success", "findings": [...], "executionTimeMs": 5200 },
    "trivy": { "status": "success", "findings": [...], "executionTimeMs": 8100 },
    "cpd": { "status": "skipped", "findings": [], "executionTimeMs": 0 },
    "gitleaks": { "status": "success", "findings": [...], "executionTimeMs": 1200 },
    "shellcheck": { "status": "success", "findings": [], "executionTimeMs": 300 },
    "markdownlint": { "status": "success", "findings": [...], "executionTimeMs": 500 },
    "lizard": { "status": "success", "findings": [...], "executionTimeMs": 2300 },
    "ruff": { "status": "success", "findings": [...], "executionTimeMs": 1100 },
    "bandit": { "status": "success", "findings": [...], "executionTimeMs": 1800 }
  }
}
```

## Testing Strategy

| Layer       | What to Test    | Approach                                                                                                                   |
| ----------- | --------------- | -------------------------------------------------------------------------------------------------------------------------- |
| Unit        | Resolve logic   | Create a shell script that replicates resolve, test with different file trees and input combos. Run locally via docker.    |
| Integration | Full YAML       | Manually dispatch to a test runner repo with a known target repo. Verify callback payload contains all expected tool keys. |
| Regression  | Backward compat | Dispatch with ONLY legacy booleans (no enabledTools/disabledTools). Verify payload has exactly semgrep/trivy/cpd.          |
| Security    | Log inspection  | Run against a private repo, download workflow logs before deletion, grep for any target-repo content.                      |

## Migration / Rollout

No migration required. The change is a single YAML template file update:
1. Update `templates/ghagga-analysis.yml` locally
2. The server's `verifyWorkflowFile()` computes a SHA-256 hash of the template — after this change, any existing runner repos will have a stale hash
3. On next dispatch, the server detects the hash mismatch, re-commits the new template to the user's runner repo, and proceeds
4. Rollback: revert the template file; same re-commit flow will push the old version

## Open Questions

- [x] Does the callback endpoint validate tool keys? → No, it accepts any `Record<string, ToolResult>` and passes to Inngest
- [x] Can `contains()` match substrings incorrectly? → No, using `'"toolname"'` with inner quotes prevents this (e.g., `"pmd"` won't match in `"cpd"`)
- [ ] Should `clippy` and `psalm` require their runtimes (Rust, PHP) to be pre-installed on ubuntu-latest? → ubuntu-latest includes Rust but NOT PHP. Psalm will need `apt-get install php-cli` as a prerequisite. This should be handled in the install step.
