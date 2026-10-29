# Spec: CLI Enhancements — TUI Polish, Output Formats, AI Enhance, Health Command, Issue Export

> **Domain**: cli-enhancements
> **Change**: v2.5.0-tui-health-enhance
> **Status**: draft

## Overview

GHAGGA's CLI output is functional but lacks visual hierarchy, structured export formats, intelligent post-processing, local health assessment, and GitHub issue integration. This spec defines five cohesive enhancements to the CLI: (1) TUI polish with colored severity, box-drawing summaries, progress indicators, and section dividers; (2) `--output` flag supporting JSON, SARIF v2.1.0, and Markdown with automatic plain-mode enforcement; (3) AI-powered post-analysis enhancement for grouping, prioritization, fix suggestions, and false-positive filtering; (4) a `ghagga health` command producing scored project assessments with trend tracking; and (5) an `--issue` flag for creating GitHub issues from review results.

All features extend the existing TUI facade pattern — commands never import `chalk` or output libraries directly. Core modules (AI Enhance, health scoring, SARIF builder) live in `packages/core/` for cross-distribution reuse.

---

## Requirements

---

### R1: Severity-Colored Text — `tui.severity()`

The TUI facade MUST provide a `tui.severity(text, level)` method that returns text colored by finding severity.

The color mapping MUST be:
- `critical` — red
- `high` — orange (or closest ANSI equivalent, e.g., `chalk.rgb(255,165,0)` or `chalk.hex('#FFA500')`)
- `medium` — yellow
- `low` — blue
- `info` — gray

In plain mode, `tui.severity()` MUST return the text prefixed with `[LEVEL]` (e.g., `[CRITICAL] SQL injection found`) with no ANSI escape sequences.

Commands MUST use `tui.severity()` for all severity-colored output; direct `chalk` calls for severity coloring are prohibited.

#### Scenario: S1.1 — Severity coloring in styled TTY mode

- GIVEN the TUI is in `styled` mode
- WHEN `tui.severity("SQL injection found", "critical")` is called
- THEN the returned string MUST contain ANSI escape codes for red coloring
- AND the text "SQL injection found" MUST be present in the output

#### Scenario: S1.2 — Severity coloring in plain mode

- GIVEN the TUI is in `plain` mode
- WHEN `tui.severity("Outdated dependency", "low")` is called
- THEN the returned string MUST be `[LOW] Outdated dependency`
- AND the string MUST NOT contain any ANSI escape sequences

#### Scenario: S1.3 — All severity levels produce distinct output in styled mode

- GIVEN the TUI is in `styled` mode
- WHEN `tui.severity()` is called for each of `critical`, `high`, `medium`, `low`, `info`
- THEN each call MUST return a string with a distinct ANSI color code
- AND no two severity levels SHALL share the same color

#### Scenario: S1.4 — Unknown severity level fallback

- GIVEN the TUI is in `styled` mode
- WHEN `tui.severity("Some text", "unknown")` is called with a severity not in the defined map
- THEN the method MUST return the text without coloring (passthrough)
- AND no error SHALL be thrown

#### Edge Cases:

- Empty string input: MUST return empty string (no prefix in plain mode if text is empty)
- `NO_COLOR` set: MUST strip ANSI codes but MAY still use `[LEVEL]` prefix format if in otherwise-styled mode

---

### R2: Box-Drawing Summary — `tui.box()`

The TUI facade MUST provide a `tui.box(title, content)` method that renders a bordered frame using Unicode box-drawing characters (`U+2500` block: `┌─┐│└─┘`).

The box MUST:
1. Have a top border with the title centered or left-aligned within the border
2. Render each content line within vertical borders
3. Have a bottom border closing the frame
4. Auto-size width to fit the longest content line plus padding (minimum 40 characters)

In plain mode, the box MUST fall back to simple text delimiters:
```
--- title ---
content line 1
content line 2
---
```

#### Scenario: S2.1 — Box rendering in styled mode

- GIVEN the TUI is in `styled` mode
- WHEN `tui.box("Review Summary", ["Status: PASSED", "Findings: 3", "Time: 12s"])` is called
- THEN the output MUST include Unicode box-drawing characters (`┌`, `─`, `┐`, `│`, `└`, `┘`)
- AND the title "Review Summary" MUST appear within the top border
- AND each content line MUST be enclosed between `│` characters

#### Scenario: S2.2 — Box rendering in plain mode

- GIVEN the TUI is in `plain` mode
- WHEN `tui.box("Review Summary", ["Status: PASSED", "Findings: 3"])` is called
- THEN the output MUST use `---` delimiters instead of box-drawing characters
- AND the title MUST appear on the first delimiter line
- AND no ANSI escape sequences SHALL be present

#### Scenario: S2.3 — Box with empty content

- GIVEN the TUI is in `styled` mode
- WHEN `tui.box("Empty", [])` is called
- THEN the box MUST render with only the top and bottom borders (no content lines)
- AND no error SHALL be thrown

#### Scenario: S2.4 — Box with long content lines

- GIVEN a content line exceeds 120 characters
- WHEN `tui.box("Title", [longLine])` is called
- THEN the box width MUST expand to accommodate the longest line
- OR the long line MAY be truncated with an ellipsis at a reasonable terminal width

#### Edge Cases:

- Content containing box-drawing characters: MUST render correctly without visual corruption
- Content with ANSI codes in styled mode: box width calculation MUST use visible character length, not raw string length

---

### R3: Section Divider — `tui.divider()`

The TUI facade MUST provide a `tui.divider(label?)` method that renders a horizontal rule separating sections.

In styled mode:
- Without label: a horizontal line spanning a reasonable width (e.g., 60 chars of `─`)
- With label: the label centered within the line (e.g., `──── Semgrep Results ────`)

In plain mode:
- Without label: `---`
- With label: `--- label ---`

#### Scenario: S3.1 — Divider with label in styled mode

- GIVEN the TUI is in `styled` mode
- WHEN `tui.divider("Semgrep Results")` is called
- THEN the output MUST include a horizontal line using `─` characters
- AND the text "Semgrep Results" MUST appear centered or embedded within the line

#### Scenario: S3.2 — Divider without label in styled mode

- GIVEN the TUI is in `styled` mode
- WHEN `tui.divider()` is called with no arguments
- THEN the output MUST be a horizontal line of `─` characters

#### Scenario: S3.3 — Divider in plain mode

- GIVEN the TUI is in `plain` mode
- WHEN `tui.divider("Trivy Results")` is called
- THEN the output MUST be `--- Trivy Results ---`
- AND no ANSI escape sequences SHALL be present

#### Scenario: S3.4 — Divider between tool result sections in review output

- GIVEN a review produces findings from Semgrep and Trivy
- WHEN the results are rendered
- THEN a divider with the tool name MUST appear between each tool's finding group

#### Edge Cases:

- Very long label (>50 chars): MUST truncate or wrap gracefully without breaking the divider format

---

### R4: Step Progress Indicator — `tui.progress()`

The TUI facade MUST provide a `tui.progress(current, total, label)` method that renders a numbered step indicator in the format `[current/total] label` (e.g., `[3/7] Running semgrep...`).

In styled mode, the progress indicator MAY include color highlighting for the step counter.

In plain mode, the same `[current/total] label` text format MUST be used, without ANSI escape sequences.

The step count MUST be derived from the tool registry's active tool count plus fixed pipeline steps (validate, parse-diff, detect-stacks, agent, memory).

#### Scenario: S4.1 — Progress indicator during review pipeline

- GIVEN a review is running with 5 tools active and 2 fixed steps (total = 7)
- WHEN the pipeline reaches the 3rd step (Semgrep)
- THEN `tui.progress(3, 7, "Running Semgrep...")` MUST produce output containing `[3/7] Running Semgrep...`

#### Scenario: S4.2 — Progress replaces generic spinner message

- GIVEN the TUI is in `styled` mode and `--verbose` is NOT set
- WHEN the review pipeline runs
- THEN the spinner message MUST be updated using `tui.progress()` at each step
- AND the generic "Analyzing..." message MUST be replaced with numbered step indicators

#### Scenario: S4.3 — Progress in plain mode

- GIVEN the TUI is in `plain` mode
- WHEN `tui.progress(1, 7, "Validating input...")` is called
- THEN the output MUST be `[1/7] Validating input...` with no ANSI escape sequences

#### Scenario: S4.4 — Progress in verbose mode

- GIVEN `--verbose` is set
- WHEN pipeline steps execute
- THEN each step MUST be rendered via `tui.log.step()` using the progress format
- AND the spinner MUST NOT be active (per existing R24 mutual exclusivity)

#### Scenario: S4.5 — Progress with zero total

- GIVEN `tui.progress(0, 0, "No tools")` is called
- THEN the output MUST be `[0/0] No tools` without error
- AND no division-by-zero or rendering error SHALL occur

#### Edge Cases:

- `current > total`: MUST render without error (e.g., `[8/7]` if an unexpected extra step occurs)
- Negative values: MUST clamp to 0 or render without error

---

### R5: Plain Mode Detection and Fallback

Plain mode MUST be activated when ANY of the following conditions is true:
1. `--plain` flag is passed
2. `process.stdout.isTTY` is `false` or `undefined`
3. `process.env.CI` is set (any truthy value)
4. `--output` flag is specified (any value)
5. `NO_COLOR` environment variable is set (for color stripping only — structural elements MAY remain if TTY is true)

When plain mode is active:
- `tui.severity()` MUST use `[LEVEL]` text prefix instead of ANSI colors
- `tui.box()` MUST use `---` text delimiters instead of Unicode box-drawing
- `tui.divider()` MUST use `---` instead of `─` characters
- `tui.progress()` MUST output plain text `[n/m] label`
- Zero ANSI escape sequences SHALL appear in any output

The detection MUST occur once at process initialization and MUST NOT change for the process lifetime (consistent with existing R2 from cli-tui spec).

#### Scenario: S5.1 — --output triggers plain mode

- GIVEN the user runs `ghagga review --output json`
- WHEN TUI mode is resolved
- THEN plain mode MUST be active
- AND no TUI decorations (spinners, colors, box-drawing) SHALL appear on stdout

#### Scenario: S5.2 — Piped output triggers plain mode

- GIVEN `process.stdout.isTTY` is `false` (piped to another process)
- WHEN TUI mode is resolved
- THEN plain mode MUST be active

#### Scenario: S5.3 — NO_COLOR disables colors but allows structure

- GIVEN `NO_COLOR=1` is set
- AND `process.stdout.isTTY` is `true`
- AND `--plain` is NOT passed and `CI` is NOT set
- WHEN TUI mode is resolved
- THEN colors MUST be disabled
- BUT structural elements (box-drawing, dividers) MAY still render

#### Scenario: S5.4 — All new TUI methods degrade gracefully

- GIVEN plain mode is active
- WHEN `tui.severity()`, `tui.box()`, `tui.divider()`, and `tui.progress()` are all called
- THEN all output MUST be plain text
- AND the combined output MUST NOT match the pattern `/\x1b\[/`

---

### R6: `--output` Flag — Structured Output Formats

The `ghagga review` command MUST accept an `--output <format>` flag with values: `json`, `sarif`, `markdown`.

Behavior:
- `--output json` — produces structured JSON to stdout (identical to current `--format json` behavior)
- `--output sarif` — produces SARIF v2.1.0 compliant JSON to stdout
- `--output markdown` — produces formatted Markdown to stdout (no ANSI codes)
- Default (no `--output`): styled TUI output to TTY, or plain markdown if not TTY

When `--output` is specified:
- TUI decorations MUST be completely suppressed (equivalent to `--plain`)
- No intro, outro, spinners, or progress indicators SHALL appear on stdout
- Only the raw formatted output SHALL be written to stdout
- Diagnostic messages (warnings, errors) MAY be written to stderr

The `--format` flag MUST remain as a deprecated alias for `--output`. When `--format` is used, a deprecation warning MUST be printed to stderr.

#### Scenario: S6.1 — JSON output is parseable

- GIVEN the user runs `ghagga review --output json`
- WHEN the review completes
- THEN stdout MUST contain valid JSON parseable by `JSON.parse()`
- AND stdout MUST NOT contain any non-JSON content (no intro/outro, no spinners)

#### Scenario: S6.2 — JSON output backward compatibility

- GIVEN the user runs `ghagga review --output json`
- WHEN the JSON is parsed
- THEN the schema MUST be identical to the existing `--format json` output
- AND existing consumers MUST NOT break

#### Scenario: S6.3 — Markdown output is clean

- GIVEN the user runs `ghagga review --output markdown`
- WHEN the output is captured
- THEN it MUST be valid Markdown
- AND it MUST NOT contain ANSI escape sequences
- AND it MUST NOT contain TUI decorations (box-drawing, spinners)

#### Scenario: S6.4 — --format deprecated alias works

- GIVEN the user runs `ghagga review --format json`
- WHEN the command executes
- THEN the output MUST be identical to `--output json`
- AND a deprecation warning MUST be printed to stderr: `Warning: --format is deprecated. Use --output instead.`

#### Scenario: S6.5 — --output suppresses all TUI output

- GIVEN the user runs `ghagga review --output sarif`
- WHEN the review pipeline runs
- THEN no spinner, intro, outro, progress indicators, or colored text SHALL appear on stdout
- AND only the SARIF JSON document SHALL be on stdout

#### Scenario: S6.6 — --output with -o writes to file

- GIVEN the user runs `ghagga review --output sarif -o results.sarif`
- WHEN the review completes
- THEN the SARIF output MUST be written to `results.sarif`
- AND stdout MAY contain a confirmation message or be empty

#### Scenario: S6.7 — Invalid --output value

- GIVEN the user runs `ghagga review --output pdf`
- WHEN the CLI parses arguments
- THEN the CLI MUST exit with a non-zero code
- AND an error message MUST indicate valid values: `json`, `sarif`, `markdown`

#### Scenario: S6.8 — --output json piped to jq

- GIVEN the user runs `ghagga review --output json | jq .status`
- WHEN the pipeline completes
- THEN `jq` MUST successfully parse the JSON input
- AND no TUI artifacts SHALL corrupt the JSON stream

#### Edge Cases:

- `--output json --plain`: MUST work without conflict (both suppress TUI)
- `--output markdown` in TTY: MUST suppress TUI decorations even though TTY is available
- `--output` with `--verbose`: verbose diagnostics MUST go to stderr, formatted output to stdout

---

### R7: SARIF v2.1.0 Output

When `--output sarif` is specified, the CLI MUST produce a valid SARIF v2.1.0 JSON document.

The SARIF document MUST conform to the OASIS SARIF v2.1.0 schema (`https://raw.githubusercontent.com/oasis-tcs/sarif-spec/main/sarif-2.1/schema/sarif-schema-2.1.0.json`).

Mapping rules:
- `$.version` MUST be `"2.1.0"`
- `$.schema` MUST reference the official SARIF schema URI
- `$.runs[0].tool.driver.name` MUST be `"ghagga"`
- `$.runs[0].tool.driver.version` MUST match the CLI package version
- Each unique `(source, ruleId)` pair MUST map to a `reportingDescriptor` in `tool.driver.rules[]`
- Each finding MUST map to a `result` in `runs[0].results[]` with:
  - `ruleId`: the finding's rule identifier
  - `message.text`: the finding description
  - `level`: mapped from severity — `critical`/`high` → `"error"`, `medium` → `"warning"`, `low`/`info` → `"note"`
  - `locations[0].physicalLocation.artifactLocation.uri`: relative file path
  - `locations[0].physicalLocation.region.startLine`: line number (when available)

The SARIF builder MUST be a pure function in `packages/core/` (or `apps/cli/src/ui/sarif.ts`) with no side effects.

#### Scenario: S7.1 — SARIF document structure

- GIVEN a review produces 5 findings from 2 tools
- WHEN `--output sarif` is used
- THEN the output MUST be valid JSON conforming to SARIF v2.1.0
- AND `$.runs[0].results` MUST contain exactly 5 result objects
- AND `$.runs[0].tool.driver.rules` MUST contain distinct rules for each unique rule ID

#### Scenario: S7.2 — SARIF severity mapping

- GIVEN a finding with severity `critical`
- WHEN the SARIF result is generated
- THEN `result.level` MUST be `"error"`

- GIVEN a finding with severity `medium`
- WHEN the SARIF result is generated
- THEN `result.level` MUST be `"warning"`

- GIVEN a finding with severity `info`
- WHEN the SARIF result is generated
- THEN `result.level` MUST be `"note"`

#### Scenario: S7.3 — SARIF with file locations

- GIVEN a finding at file `src/auth.ts`, line 42
- WHEN the SARIF result is generated
- THEN `locations[0].physicalLocation.artifactLocation.uri` MUST be `"src/auth.ts"`
- AND `locations[0].physicalLocation.region.startLine` MUST be `42`

#### Scenario: S7.4 — SARIF with finding missing line number

- GIVEN a finding with no line number (e.g., a dependency vulnerability from Trivy)
- WHEN the SARIF result is generated
- THEN the `region` property MAY be omitted
- AND the `artifactLocation.uri` MUST still be present (file path or package name)

#### Scenario: S7.5 — SARIF uploadable to GitHub Code Scanning

- GIVEN the SARIF output from `ghagga review --output sarif`
- WHEN uploaded via `gh sarif upload results.sarif`
- THEN GitHub MUST accept the upload without schema validation errors

#### Scenario: S7.6 — SARIF with zero findings

- GIVEN a review produces zero findings
- WHEN `--output sarif` is used
- THEN the SARIF document MUST still be valid
- AND `$.runs[0].results` MUST be an empty array `[]`

#### Edge Cases:

- Findings with Unicode characters in messages: MUST be properly JSON-escaped
- Findings with very long messages (>1000 chars): MUST be included in full (no truncation in SARIF)
- Multiple runs from different tools: MUST be consolidated into a single SARIF run with `tool.driver.name: "ghagga"`

---

### R8: AI Enhance — Post-Analysis Intelligence

The CLI MUST support an `--enhance` flag (alias: `--ai`) that triggers an AI-powered post-analysis pass after static analysis completes but before final result assembly.

The enhance module MUST:
1. **Group** related findings across tools — findings about the same root cause or code location MUST be assigned a shared `groupId`
2. **Prioritize** findings by estimated real-world impact — each finding MUST receive an `aiPriority` score (1-10, where 10 is highest impact)
3. **Generate fix suggestions** — the top findings MUST include concrete code snippets or actionable fix descriptions
4. **Filter false positives** — low-confidence findings MUST be marked `aiFiltered: true` with a `filterReason` string, but MUST NOT be removed from results

The feature MUST be opt-in: default is OFF in v2.5.0. `--enhance` enables it, `--no-enhance` explicitly disables it.

The model MUST be `gpt-4o-mini` (free via GitHub Models). Token budget: input capped at 4K tokens per enhance call.

#### Scenario: S8.1 — Enhance groups related findings

- GIVEN a review produces a Semgrep finding for "hardcoded password in auth.ts:15" and a Gitleaks finding for "API key detected in auth.ts:15"
- AND `--enhance` is specified
- WHEN the AI enhance pass runs
- THEN both findings MUST share the same `groupId`
- AND the group MUST have a descriptive label (e.g., "Credential exposure in auth.ts")

#### Scenario: S8.2 — Enhance prioritizes by impact

- GIVEN findings include a critical SQL injection and a low-severity missing alt attribute
- AND `--enhance` is specified
- WHEN the AI enhance pass runs
- THEN the SQL injection MUST have a higher `aiPriority` score than the missing alt attribute
- AND the `aiPriority` MUST be an integer from 1-10

#### Scenario: S8.3 — Enhance generates fix suggestions

- GIVEN a finding for "Unescaped user input in query at db.ts:30"
- AND `--enhance` is specified
- WHEN the AI enhance pass runs
- THEN the finding SHOULD include a `suggestion` field with a concrete fix (e.g., code snippet using parameterized queries)

#### Scenario: S8.4 — Enhance filters false positives

- GIVEN a finding that is a likely false positive (e.g., test file flagged for hardcoded test credentials)
- AND `--enhance` is specified
- WHEN the AI enhance pass runs
- THEN the finding MUST have `aiFiltered: true` and a `filterReason` explaining why
- AND the finding MUST still be present in the results (not deleted)
- AND the finding MUST be visible with `--verbose`

#### Scenario: S8.5 — Enhance failure is non-blocking

- GIVEN `--enhance` is specified
- AND the AI API call fails (network error, timeout, rate limit)
- WHEN the enhance pass is attempted
- THEN the review MUST complete successfully with unenhanced results
- AND a warning MUST be displayed: e.g., "AI enhance failed: {reason}. Showing unenhanced results."
- AND the `enhanced` field in `ReviewResult` MUST be `false`

#### Scenario: S8.6 — Enhance respects token budget

- GIVEN a review produces 500 findings
- AND `--enhance` is specified
- WHEN the findings are serialized for the AI call
- THEN the input MUST be capped at 4K tokens
- AND findings MUST be truncated by severity (lowest-severity findings dropped first)
- AND all findings (including those dropped from the AI input) MUST appear in the final result

#### Scenario: S8.7 — --no-enhance explicitly disables

- GIVEN the user runs `ghagga review --no-enhance`
- WHEN the review pipeline executes
- THEN the AI enhance pass MUST NOT run
- AND no AI API calls SHALL be made

#### Scenario: S8.8 — Enhance metadata in ReviewResult

- GIVEN `--enhance` is specified and the enhance pass succeeds
- WHEN the `ReviewResult` is assembled
- THEN `result.enhanced` MUST be `true`
- AND `result.enhanceMetadata` MUST contain `{ model, tokenUsage, groupCount, filteredCount }`

#### Scenario: S8.9 — Enhance without API credentials

- GIVEN `--enhance` is specified
- AND no LLM provider API key is configured
- WHEN the enhance pass is attempted
- THEN the review MUST complete with unenhanced results
- AND a clear warning MUST indicate that authentication is needed for AI enhance

#### Edge Cases:

- Zero findings with `--enhance`: MUST skip the AI call entirely (no point enhancing empty results) and set `enhanced: false`
- `--enhance --output json`: enhanced metadata MUST be included in the JSON output
- `--enhance --output sarif`: AI-enhanced fields (groupId, aiPriority) are NOT part of SARIF schema — SARIF output MUST be valid regardless of enhance state

---

### R9: Health Command — `ghagga health`

The CLI MUST provide a `ghagga health [path]` command that runs a subset of static analysis tools and produces a project health assessment.

Default `path` is the current working directory (`.`).

The health command MUST:
1. Run a subset of static analysis tools: at minimum Semgrep, Trivy, Gitleaks, ShellCheck, and Lizard (always-on tools from the registry)
2. Compute a health score from 0-100
3. Display the score with color coding: green (80-100), yellow (50-79), red (0-49)
4. Show top N issues sorted by severity (default N=5, configurable)
5. Show trend data when previous runs exist
6. Show actionable recommendations (top 3-5 areas to improve)
7. Support `--output json` for CI consumption
8. Stay under 1,500 lines of implementation total

The health command MUST NOT require authentication — it runs entirely locally.

#### Scenario: S9.1 — Basic health check

- GIVEN the user runs `ghagga health` in a project directory
- WHEN the health check completes
- THEN a health score (0-100) MUST be displayed
- AND the score MUST be color-coded: green for 80+, yellow for 50-79, red for 0-49
- AND the top 5 issues MUST be listed sorted by severity (critical first)

#### Scenario: S9.2 — Health score computation

- GIVEN findings from static analysis tools
- WHEN the health score is computed
- THEN the scoring MUST use weighted severity: critical=-20, high=-10, medium=-3, low=-1, info=0
- AND the base score MUST be 100
- AND the final score MUST be `max(0, 100 + sum(weights))`
- AND the score MUST be clamped to the range [0, 100]

#### Scenario: S9.3 — Perfect health score

- GIVEN static analysis produces zero findings
- WHEN the health score is computed
- THEN the score MUST be 100
- AND the display MUST use green color coding

#### Scenario: S9.4 — Minimum health score clamping

- GIVEN static analysis produces 10 critical findings (10 * -20 = -200)
- WHEN the health score is computed
- THEN the score MUST be 0 (not -100)
- AND the display MUST use red color coding

#### Scenario: S9.5 — Health with custom path

- GIVEN the user runs `ghagga health ./src`
- WHEN the health check runs
- THEN static analysis MUST be scoped to the `./src` directory
- AND the score MUST reflect only findings within that path

#### Scenario: S9.6 — Health with --output json

- GIVEN the user runs `ghagga health --output json`
- WHEN the health check completes
- THEN stdout MUST contain valid JSON with the schema:

  ```json
  {
    "score": 85,
    "grade": "A",
    "findings": { "critical": 0, "high": 1, "medium": 3, "low": 5, "info": 2 },
    "topIssues": [...],
    "recommendations": [...],
    "trend": { "previous": 80, "delta": 5, "direction": "up" },
    "toolsRun": ["semgrep", "trivy", "gitleaks", "shellcheck", "lizard"],
    "timestamp": "2026-03-08T12:00:00Z"
  }
  ```
- AND no TUI decorations SHALL appear on stdout

#### Scenario: S9.7 — Health in plain mode

- GIVEN the user runs `ghagga health --plain`
- WHEN the health check completes
- THEN the output MUST be clean text with no ANSI escape sequences
- AND the score, issues, and recommendations MUST still be displayed

#### Scenario: S9.8 — Health does not require authentication

- GIVEN the user has NOT run `ghagga login`
- WHEN `ghagga health` is run
- THEN the command MUST succeed without authentication errors
- AND all local static analysis tools MUST run

#### Edge Cases:

- Empty directory with no source files: MUST produce score 100 with a note "No source files found"
- Tools not installed (e.g., Semgrep not in PATH): MUST skip unavailable tools with a warning and score based on available tools only
- `ghagga health --output sarif`: MUST work (SARIF of health findings) or produce a clear error if health-specific SARIF is not supported

---

### R10: Health Trend Tracking

The health command MUST store health run results locally and display trend comparisons.

Storage:
- Health history MUST be stored in `~/.config/ghagga/health-history.json`
- Each entry MUST contain: `{ timestamp, score, findingCounts, toolsRun, projectPath }`
- The last 10 runs per project MUST be kept; older entries MUST be pruned

Display:
- When a previous run exists for the same project, the trend MUST show: current score, previous score, delta, and direction arrow (up/down/unchanged)
- Direction indicators: `+5` with up arrow for improvement, `-3` with down arrow for regression, `=` for unchanged

#### Scenario: S10.1 — First health run (no history)

- GIVEN no health history exists for the current project
- WHEN `ghagga health` completes
- THEN the score MUST be displayed without trend data
- AND the result MUST be stored in the history file
- AND a message like "First health check — run again later to see trends" SHOULD appear

#### Scenario: S10.2 — Subsequent run shows trend

- GIVEN a previous health run exists with score 75
- AND the current run produces score 82
- WHEN the health results are displayed
- THEN the trend MUST show: score 82, delta +7, direction "improved"

#### Scenario: S10.3 — Score regression

- GIVEN a previous health run exists with score 90
- AND the current run produces score 72
- WHEN the health results are displayed
- THEN the trend MUST show: score 72, delta -18, direction "regressed"

#### Scenario: S10.4 — History pruning

- GIVEN the history file contains 10 entries for the current project
- WHEN a new health run completes
- THEN the oldest entry MUST be removed
- AND the file MUST contain exactly 10 entries (the 9 previous + 1 new)

#### Scenario: S10.5 — History file corruption

- GIVEN the history file contains invalid JSON
- WHEN `ghagga health` reads the history
- THEN the command MUST NOT crash
- AND it MUST treat the history as empty (first run behavior)
- AND the corrupted file MUST be overwritten with the new entry

#### Scenario: S10.6 — Multiple projects in history

- GIVEN health history exists for projects `/home/user/projectA` and `/home/user/projectB`
- WHEN `ghagga health` is run in `/home/user/projectA`
- THEN the trend MUST compare against the last run for `/home/user/projectA` only
- AND `/home/user/projectB` history MUST NOT be affected

#### Edge Cases:

- History file does not exist: MUST be created on first run
- History directory does not exist (`~/.config/ghagga/`): MUST create the directory
- Permission denied writing history: MUST warn but not fail the health check

---

### R11: Health Recommendations

The health command MUST display actionable recommendations derived from finding categories.

Recommendations MUST:
1. Be limited to top 3-5 items (default 5 per proposal, configurable)
2. Be sorted by potential impact (highest impact first)
3. Include a concrete action the user can take (e.g., "Run `npm audit fix` to address 3 dependency vulnerabilities")
4. Be derived from the category distribution of findings (security, quality, dependencies, complexity, secrets)

#### Scenario: S11.1 — Recommendations from findings

- GIVEN the health check finds 5 dependency vulnerabilities (Trivy), 2 secret leaks (Gitleaks), and 1 complexity warning (Lizard)
- WHEN recommendations are generated
- THEN the top recommendation MUST address secret leaks (highest severity category)
- AND recommendations MUST include actionable text for each category

#### Scenario: S11.2 — No recommendations when score is perfect

- GIVEN the health check produces score 100 (zero findings)
- WHEN recommendations are generated
- THEN the output MUST indicate no issues found (e.g., "No recommendations — project is clean!")

#### Scenario: S11.3 — Recommendations in JSON output

- GIVEN the user runs `ghagga health --output json`
- WHEN the JSON is generated
- THEN `recommendations` MUST be an array of objects with `{ category, action, impact, findingCount }`

#### Edge Cases:

- All findings in one category: MUST still produce meaningful recommendations (not just "fix security issues" repeated)
- Categories with only `info` findings: MAY be omitted from recommendations

---

### R12: Health Command Line Budget

The `ghagga health` implementation MUST NOT exceed 1,500 lines total across all files specific to the health feature.

This includes:
- `apps/cli/src/commands/health.ts` (~300 lines)
- `packages/core/src/health/score.ts` (~400 lines)
- `packages/core/src/health/trends.ts` (~200 lines)
- `packages/core/src/health/recommendations.ts` (~300 lines)

Test files are NOT counted against this budget.

#### Scenario: S12.1 — Line count verification

- GIVEN the health feature implementation is complete
- WHEN the lines of code are counted (excluding tests, blank lines, and comments)
- THEN the total MUST be ≤ 1,500 lines

---

### R13: `--issue` Flag — GitHub Issue Creation

The `ghagga review` command MUST accept an `--issue <target>` flag that creates or updates a GitHub issue with the review results.

Target values:
- `--issue new` — creates a new issue, prints the issue URL
- `--issue <number>` — posts a comment on existing issue #number, prints the comment URL

Requirements:
- The issue body MUST contain the review summary in formatted Markdown, wrapped in a collapsible `<details>` section with summary stats
- Issue title MUST follow the format: `GHAGGA Review: {repo}@{short-sha} — {status}`
- The issue/comment MUST be labeled with `ghagga-review` (label created if missing)
- Authentication MUST use the stored GitHub token from `ghagga login`
- The GitHub API client MUST use `fetch` (Node 20+ built-in) — no new dependencies

#### Scenario: S13.1 — Create new issue

- GIVEN the user runs `ghagga review --issue new`
- AND a valid GitHub token is stored from `ghagga login`
- AND the current directory is a git repository with a GitHub remote
- WHEN the review completes
- THEN a new GitHub issue MUST be created in the repository
- AND the issue title MUST match `GHAGGA Review: {owner/repo}@{short-sha} — {status}`
- AND the issue body MUST contain the review results in Markdown
- AND the issue MUST have the `ghagga-review` label
- AND the issue URL MUST be printed to the console

#### Scenario: S13.2 — Comment on existing issue

- GIVEN the user runs `ghagga review --issue 42`
- AND a valid GitHub token is stored
- AND issue #42 exists in the repository
- WHEN the review completes
- THEN a comment MUST be posted on issue #42 with the review results
- AND the comment URL MUST be printed to the console

#### Scenario: S13.3 — Issue body format

- GIVEN a review completes with findings
- WHEN the issue body is generated
- THEN it MUST include:
  - A summary section with status, finding counts by severity, and execution time
  - A collapsible `<details>` section containing the full review Markdown
  - The GHAGGA version used

#### Scenario: S13.4 — Label creation

- GIVEN the `ghagga-review` label does not exist in the repository
- WHEN `--issue new` is used
- THEN the CLI MUST attempt to create the label
- AND if label creation fails (e.g., insufficient permissions), the issue MUST still be created without the label
- AND a warning MUST be displayed about the missing label

#### Scenario: S13.5 — No authentication error

- GIVEN no GitHub token is stored (user has not run `ghagga login`)
- WHEN the user runs `ghagga review --issue new`
- THEN the CLI MUST exit with a non-zero code
- AND the error message MUST suggest running `ghagga login` first
- AND the review itself MUST still run and display results normally (only the issue creation fails)

#### Scenario: S13.6 — Repository detection

- GIVEN the current directory is a git repo with remote `https://github.com/owner/repo.git`
- WHEN `--issue` is used
- THEN the CLI MUST correctly parse `owner` and `repo` from the git remote URL

- GIVEN the current directory is a git repo with remote `git@github.com:owner/repo.git`
- WHEN `--issue` is used
- THEN the CLI MUST correctly parse `owner` and `repo` from the SSH remote URL

#### Scenario: S13.7 — Non-GitHub remote

- GIVEN the current directory is a git repo with a GitLab or Bitbucket remote
- WHEN the user runs `ghagga review --issue new`
- THEN the CLI MUST exit with an error: "GitHub remote not found. --issue requires a GitHub repository."

#### Scenario: S13.8 — Issue creation with --output

- GIVEN the user runs `ghagga review --issue new --output json`
- WHEN the review completes
- THEN the JSON output MUST be written to stdout
- AND the issue MUST still be created
- AND the issue URL MUST be printed to stderr (since stdout is reserved for the format output)

#### Scenario: S13.9 — Rate limiting

- GIVEN the GitHub API returns HTTP 429 (rate limited)
- WHEN issue creation is attempted
- THEN the CLI MUST display a warning with the rate limit reset time
- AND the review results MUST still be displayed normally

#### Scenario: S13.10 — Repository with issues disabled

- GIVEN the target repository has issues disabled
- WHEN issue creation is attempted
- THEN the CLI MUST display a clear error: "Issues are disabled for this repository."
- AND the exit code MUST be non-zero

#### Edge Cases:

- `--issue 0` or `--issue -1`: MUST produce a validation error
- `--issue new` on a repository with thousands of issues: MUST still create successfully (no list queries needed)
- `--issue 999999` on a non-existent issue: MUST display "Issue #999999 not found" error from the API
- `--issue` without `ghagga review` (e.g., `ghagga health --issue new`): MUST produce an error — `--issue` is only valid on the `review` command

---

### R14: Chalk Adapter — `ui/chalk.ts`

A new `ui/chalk.ts` module MUST wrap `chalk` and handle `NO_COLOR`/non-TTY fallback.

Requirements:
- The module MUST re-export chalk color functions for use by `ui/tui.ts` and `ui/theme.ts`
- Commands MUST NOT import `chalk` directly — only through `ui/chalk.ts` or `ui/tui.ts`
- The adapter MUST respect `NO_COLOR`, `FORCE_COLOR`, and non-TTY detection (chalk v5 handles this natively)
- The adapter MUST export a `SEVERITY_COLORS` map from `ui/theme.ts` mapping severity levels to chalk color functions

#### Scenario: S14.1 — Chalk adapter re-exports work

- GIVEN a command needs to color text
- WHEN it imports from `ui/tui.ts` (which delegates to `ui/chalk.ts`)
- THEN coloring functions MUST be available and functional

#### Scenario: S14.2 — No direct chalk imports in commands

- GIVEN the codebase is searched for `import.*chalk` or `require.*chalk`
- WHEN checking files in `commands/` and `lib/`
- THEN zero matches MUST be found — only `ui/chalk.ts` and `ui/tui.ts` MAY import chalk

#### Scenario: S14.3 — Chalk bundles with ncc

- GIVEN `chalk` v5 is added to `apps/cli/package.json`
- WHEN `ncc build` is run
- THEN the build MUST succeed
- AND the bundle size increase MUST be < 30KB

#### Edge Cases:

- chalk v5 ESM-only: the project build must handle ESM imports correctly
- If chalk bundling fails with ncc: fallback plan is to vendor chalk's core color functions (~50 lines) directly

---

### R15: Review Output Integration

The `review` command output MUST integrate all new TUI features:
1. Step progress `[1/7] Running Semgrep...` during the pipeline
2. Section dividers between tool finding groups using `tui.divider(toolName)`
3. Colored severity for each finding using `tui.severity()`
4. Box-drawing summary at end of review using `tui.box()` showing: status, finding counts by severity, execution time, tools run

#### Scenario: S15.1 — Full styled review output

- GIVEN the TUI is in `styled` mode
- AND a review completes with findings from Semgrep and Trivy
- WHEN the results are rendered
- THEN step progress indicators MUST have appeared during the pipeline
- AND a divider MUST separate Semgrep findings from Trivy findings
- AND each finding's severity MUST be colored
- AND a box summary MUST appear at the end with status, counts, and time

#### Scenario: S15.2 — Full plain review output

- GIVEN the TUI is in `plain` mode
- AND a review completes with findings
- WHEN the results are rendered
- THEN progress steps MUST appear as `[n/m] label` text
- AND dividers MUST appear as `--- ToolName ---`
- AND severity MUST appear as `[LEVEL]` prefix
- AND the summary MUST appear between `---` delimiters
- AND zero ANSI escape sequences SHALL be present

#### Scenario: S15.3 — Review with --enhance and --issue

- GIVEN the user runs `ghagga review --enhance --issue new`
- WHEN the review completes
- THEN enhanced results (grouped, prioritized) MUST appear in the output
- AND a GitHub issue MUST be created with the enhanced results
- AND the issue URL MUST be printed

#### Edge Cases:

- Review with zero findings: summary box MUST still appear with "0 findings" and PASSED status
- Review with only one tool producing findings: dividers MUST NOT appear for tools with zero findings (or appear with "0 findings" note)

---

## Cross-Cutting Concerns

### CC1: TUI Facade Encapsulation (Extended)

All new output methods (`severity()`, `box()`, `divider()`, `progress()`) MUST be accessed exclusively through the `ui/tui.ts` facade. No command file SHALL import `chalk`, color functions, or box-drawing utilities directly. This extends the existing CC1 from the cli-tui spec.

### CC2: Format Function Purity (Extended)

New format functions (`formatBoxSummary()`, `formatSeverityLine()`, `formatDivider()`) MUST be pure functions in `ui/format.ts`: deterministic output for given input, no side effects, no I/O. SARIF builder (`buildSarif()`) MUST also be a pure function.

### CC3: Theme Centralization (Extended)

`SEVERITY_COLORS` map, box-drawing character constants, and divider styling MUST be defined in `ui/theme.ts`. No inline color codes or Unicode constants in command files.

### CC4: Backward Compatibility

- `--format` MUST remain as a deprecated alias for `--output`
- JSON output schema from `--output json` MUST be identical to existing `--format json`
- All existing CLI flags MUST continue working
- `ReviewResult` type additions (`enhanced`, `enhanceMetadata`) MUST be optional fields (backward-compatible)

### CC5: Existing Test Compatibility

All existing tests MUST pass without modification. New features MUST NOT alter the behavior of existing commands when the new flags are not used.

### CC6: Bundle Size Budget

The total bundle size increase from all v2.5.0 changes MUST be < 30KB over the v2.4.2 baseline. Primary new dependency is `chalk` (~7KB).

### CC7: No Paid API Calls

All AI features MUST use `gpt-4o-mini` (free via GitHub Models) or local tools. No feature in this spec SHALL require a paid API subscription.

---

## Invariants

- The TUI mode is determined exactly once per process and never changes (carried from cli-tui spec).
- When `--output` is specified, stdout contains ONLY the formatted output (JSON/SARIF/Markdown) with zero TUI decorations.
- AI Enhance failures MUST NOT block or fail the review — the result degrades gracefully to unenhanced output.
- Health score is always in the range [0, 100], computed deterministically from findings and severity weights.
- Health history is append-only (new entries added, oldest pruned) — never bulk-deleted or modified in place.
- `--issue` operates independently of review logic — a review always completes and displays results regardless of issue creation success or failure.
- Commands never import `chalk` or `@clack/prompts` directly; all access through the TUI facade.
- SARIF output MUST validate against the official SARIF v2.1.0 JSON schema.
- Format functions are pure: same input always produces same output, no side effects.
