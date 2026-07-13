# Static Analysis Specification

> **Origin**: Archived from `ghagga-v2-rewrite` change, domain `static-analysis` (2026-03-07)
> **Updated**: 2026-03-08 — Merged delta from `extensible-static-analysis` change (core types refactor)

## Purpose

Static analysis (Layer 0) runs deterministic security and quality checks BEFORE the LLM agents, consuming zero AI tokens. Findings are injected into agent prompts as pre-confirmed issues, preventing the AI from wasting tokens rediscovering known problems.

## Requirements

### Requirement: Semgrep Security Scanning

The system MUST run Semgrep to detect security vulnerabilities and dangerous code patterns across 15+ programming languages.

#### Scenario: Semgrep finds SQL injection pattern

- GIVEN a diff containing a Python file with string concatenation in a SQL query
- WHEN Semgrep analysis runs
- THEN the result MUST include a finding with category "security", rule "sql-injection", file path, and line number
- AND the finding severity MUST match the Semgrep rule severity

#### Scenario: Semgrep with custom rules

- GIVEN a repository configured with custom Semgrep rules in the settings
- WHEN Semgrep analysis runs
- THEN the system MUST apply both the default GHAGGA rules AND the custom rules
- AND custom rule findings MUST be clearly labeled as "custom"

#### Scenario: Semgrep binary not available

- GIVEN the Semgrep binary is not installed in the environment
- WHEN static analysis runs
- THEN the system MUST log a warning "Semgrep not available, skipping security scan"
- AND the analysis MUST continue with remaining tools
- AND the result MUST indicate Semgrep was skipped

### Requirement: Trivy Dependency Scanning

The system MUST run Trivy to detect known CVEs (Common Vulnerabilities and Exposures) in project dependencies.

#### Scenario: Trivy detects critical CVE

- GIVEN a diff that modifies `package.json` adding a dependency with a known critical CVE
- WHEN Trivy analysis runs
- THEN the result MUST include the CVE ID, affected package, installed version, fixed version (if available), and severity
- AND critical CVEs MUST be flagged as severity "critical"

#### Scenario: Trivy scans lock files

- GIVEN a diff containing changes to `package-lock.json`, `yarn.lock`, `pnpm-lock.yaml`, `go.sum`, `Cargo.lock`, `requirements.txt`, or `Pipfile.lock`
- WHEN Trivy analysis runs
- THEN Trivy MUST scan the appropriate lock file for the ecosystem

#### Scenario: No dependency files in diff

- GIVEN a diff that contains only `.ts` source files with no dependency manifests
- WHEN Trivy analysis runs
- THEN Trivy SHOULD still run against the repository root if available
- AND if no dependency files are found, Trivy MUST return an empty result (not an error)

#### Scenario: Trivy binary not available

- GIVEN the Trivy binary is not installed in the environment
- WHEN static analysis runs
- THEN the system MUST log a warning "Trivy not available, skipping dependency scan"
- AND the analysis MUST continue with remaining tools

### Requirement: PMD/CPD Duplicate Code Detection

The system MUST run PMD's CPD (Copy-Paste Detector) to find duplicated code blocks across files in the diff.

#### Scenario: CPD detects duplicated block

- GIVEN a diff where the same 15-line function appears in two different files
- WHEN CPD analysis runs
- THEN the result MUST include both file paths, line ranges, and the number of duplicated tokens
- AND the minimum token threshold MUST be configurable (default: 100 tokens)

#### Scenario: CPD across multiple languages

- GIVEN a diff containing both Java and TypeScript files with duplicated logic
- WHEN CPD analysis runs
- THEN CPD MUST analyze each supported language independently
- AND duplicates MUST only be reported within the same language

#### Scenario: CPD binary not available

- GIVEN the CPD/PMD binary is not installed in the environment
- WHEN static analysis runs
- THEN the system MUST log a warning "CPD not available, skipping duplicate detection"
- AND the analysis MUST continue with remaining tools

### Requirement: Sequential Execution (Updated)

The system MUST run static analysis tools sequentially (one at a time) to stay within memory constraints of the target runner environment (7GB RAM, 2 CPUs). This replaces the previous parallel execution model.

> **Updated by**: `extensible-static-analysis` change (2026-03-08) — sequential execution preserves memory safety with 15 tools.

#### Scenario: Sequential execution order

- GIVEN 10 tools are activated
- WHEN the runner executes
- THEN each tool MUST complete (or timeout) before the next tool begins
- AND tools MUST NOT run concurrently

#### Scenario: Partial tool failure

- GIVEN Semgrep succeeds, Trivy times out, and CPD crashes
- WHEN static analysis completes
- THEN the result MUST include Semgrep findings
- AND the result MUST include warnings for Trivy (timeout) and CPD (crash)
- AND the pipeline MUST NOT fail entirely

### Requirement: Output Format for LLM Injection

The system MUST format static analysis findings into a structured context block suitable for LLM prompt injection.

#### Scenario: Findings formatted for agent prompt

- GIVEN Semgrep found 2 issues and Trivy found 1 CVE
- WHEN the findings are formatted for prompt injection
- THEN the output MUST be a markdown block titled "Pre-Review Static Analysis (confirmed issues)"
- AND each finding MUST include tool name, severity, file, line (if applicable), and description
- AND the block MUST end with the instruction "Do NOT repeat these findings in your review"

### Requirement: AI-Generated Code Attribution

The system MUST detect common patterns indicating AI-generated code in the diff.

#### Scenario: AI attribution markers detected

- GIVEN a diff containing comments like "Generated by GitHub Copilot" or "// AI-generated"
- WHEN AI attribution analysis runs
- THEN the result MUST flag the file as potentially AI-generated
- AND this information MUST be included in the agent prompt context

### Requirement: Commit Message Validation

The system SHOULD validate commit messages against conventional commit format.

#### Scenario: Non-conventional commit message

- GIVEN a PR with commits that don't follow conventional commits (feat:, fix:, chore:, etc.)
- WHEN commit validation runs
- THEN the result SHOULD include a suggestion to use conventional commits
- AND this SHOULD be a "low" severity finding

---

## Extensible Tool Registry (Added by `extensible-static-analysis`, 2026-03-08)

### Requirement: ToolDefinition Interface

The system MUST define a `ToolDefinition` interface that fully describes a static analysis tool as a self-contained plugin.

A `ToolDefinition` MUST include:
- `name`: a unique `ToolName` string identifier (lowercase, kebab-case)
- `displayName`: a human-readable label for UI display
- `category`: a `ToolCategory` value
- `tier`: `'always-on' | 'auto-detect'`
- `detect`: a function `(files: string[]) => boolean` (REQUIRED for `auto-detect` tier, OPTIONAL for `always-on`)
- `install`: a function `(cacheDir: string) => Promise<void>` that installs the tool binary
- `run`: a function `(repoDir: string, files: string[], timeout: number) => Promise<RawToolOutput>` that executes the tool
- `parse`: a function `(raw: RawToolOutput) => ReviewFinding[]` that normalizes output into findings
- `version`: a pinned version string
- `outputFormat`: `'json' | 'sarif' | 'xml' | 'text'`

#### Scenario: ToolDefinition is self-contained

- GIVEN a tool plugin file implementing `ToolDefinition`
- WHEN the plugin is registered with the registry
- THEN no other file in the codebase needs modification to activate the tool
- AND the registry MUST be the single point of tool discovery

#### Scenario: Auto-detect tool requires detect function

- GIVEN a `ToolDefinition` with `tier: 'auto-detect'`
- WHEN the definition is validated at registration time
- THEN the `detect` field MUST be a function (not undefined)
- AND if `detect` is undefined, registration MUST throw a descriptive error

#### Scenario: Always-on tool detect is optional

- GIVEN a `ToolDefinition` with `tier: 'always-on'`
- WHEN the definition is validated at registration time
- THEN the `detect` field MAY be undefined
- AND the tool MUST be activated for every review regardless

### Requirement: ToolCategory Type

The system MUST define a `ToolCategory` union type categorizing tool purposes.

`ToolCategory` MUST include at minimum: `'security' | 'quality' | 'secrets' | 'complexity' | 'duplication' | 'sca' | 'docs' | 'linting'`.

#### Scenario: Each tool maps to exactly one category

- GIVEN a `ToolDefinition` for Semgrep
- WHEN inspecting its `category` field
- THEN it MUST be exactly one value from `ToolCategory` (e.g., `'security'`)

### Requirement: ToolName Type

The system MUST define a `ToolName` type as a string union derived from the registry's registered tool names.

`ToolName` MUST include at minimum: `'semgrep' | 'trivy' | 'cpd' | 'gitleaks' | 'shellcheck' | 'markdownlint' | 'lizard' | 'ruff' | 'bandit' | 'golangci-lint' | 'biome' | 'pmd' | 'psalm' | 'clippy' | 'hadolint' | 'zizmor'`.

#### Scenario: ToolName used as Record key

- GIVEN a `StaticAnalysisResult` object
- WHEN accessing a tool result by name
- THEN the key MUST be a valid `ToolName` value
- AND TypeScript MUST provide autocomplete for known tool names

### Requirement: RawToolOutput Type

The system MUST define a `RawToolOutput` type representing the raw output from a tool execution.

`RawToolOutput` MUST contain:
- `stdout`: string (the tool's standard output)
- `stderr`: string (the tool's standard error)
- `exitCode`: number
- `timedOut`: boolean (true if the tool was killed due to timeout)

#### Scenario: Tool produces valid raw output

- GIVEN Semgrep executes successfully
- WHEN the `run` function returns
- THEN `RawToolOutput.stdout` MUST contain the JSON output
- AND `RawToolOutput.exitCode` MUST be 0
- AND `RawToolOutput.timedOut` MUST be false

#### Scenario: Tool times out

- GIVEN a tool exceeds its allocated time budget
- WHEN the tool process is killed
- THEN `RawToolOutput.timedOut` MUST be true
- AND `RawToolOutput.exitCode` SHOULD be non-zero
- AND `RawToolOutput.stdout` MAY contain partial output

### Requirement: FindingSource Extension (Modified)

The `FindingSource` type MUST include all registered tool names in addition to `'ai'`.

`FindingSource` MUST be: `'ai' | ToolName`.

> **Previously**: `FindingSource` was `'ai' | 'semgrep' | 'trivy' | 'cpd'`

#### Scenario: New tool findings have correct source

- GIVEN Gitleaks produces a finding for a leaked API key
- WHEN the finding is created as a `ReviewFinding`
- THEN `finding.source` MUST be `'gitleaks'`
- AND TypeScript MUST accept `'gitleaks'` as a valid `FindingSource`

#### Scenario: Existing AI findings unchanged

- GIVEN the AI agent produces a code quality finding
- WHEN the finding is created
- THEN `finding.source` MUST remain `'ai'`

### Requirement: StaticAnalysisResult — Extensible (Modified)

`StaticAnalysisResult` MUST be `Record<ToolName, ToolResult>` with legacy keys (`semgrep`, `trivy`, `cpd`) guaranteed present for backward compatibility.

> **Previously**: `StaticAnalysisResult` was `{ semgrep: ToolResult; trivy: ToolResult; cpd: ToolResult }`

#### Scenario: Backward-compatible access to semgrep

- GIVEN a `StaticAnalysisResult` produced by the new registry-driven runner
- WHEN existing code accesses `result.semgrep`
- THEN the access MUST succeed without type errors
- AND the value MUST be a valid `ToolResult`
- AND if Semgrep was disabled, the value MUST be `{ status: 'skipped', findings: [], executionTimeMs: 0 }`

#### Scenario: Dynamic access to new tools

- GIVEN a `StaticAnalysisResult` with Gitleaks results
- WHEN code accesses `result.gitleaks`
- THEN the access MUST return a `ToolResult | undefined`
- AND TypeScript MUST NOT require a type assertion

#### Scenario: Iterating over all tool results

- GIVEN a `StaticAnalysisResult` with 7 tools
- WHEN code iterates via `Object.entries(result)`
- THEN all 7 tool results MUST be yielded
- AND each value MUST be typed as `ToolResult`

### Requirement: Finding Count Cap

The system MUST cap the total number of static analysis findings injected into LLM agent context.

#### Scenario: Findings exceed cap

- GIVEN 15 tools produce a combined 350 findings
- WHEN findings are formatted for LLM prompt injection
- THEN only the top 200 findings MUST be included
- AND findings MUST be sorted by severity (critical > high > medium > low > info)
- AND a summary line MUST indicate "Showing 200 of 350 findings"

#### Scenario: Findings below cap

- GIVEN 15 tools produce a combined 50 findings
- WHEN findings are formatted for LLM prompt injection
- THEN all 50 findings MUST be included
- AND no truncation message MUST appear


### Requirement: Zizmor GitHub Actions Security Analysis

The registry MUST provide an opt-in/auto-detected `zizmor` tool for changed
files under `.github/workflows/`. The tool MUST execute with SARIF output,
normalize SARIF locations and severity into review findings, elevate designated
high-impact GitHub Actions rules to critical, and degrade to a non-blocking tool
error when the binary is unavailable or output cannot be parsed.

#### Scenario: Workflow findings are normalized

- GIVEN one or more changed GitHub Actions workflow files
- AND the zizmor binary is available
- WHEN static analysis runs
- THEN zizmor executes once for the relevant workflow paths
- AND each SARIF result is converted into a review finding with rule, message, file, line, and mapped severity

#### Scenario: No workflow files changed

- GIVEN the diff contains no files under `.github/workflows/`
- WHEN tool auto-detection runs
- THEN zizmor is skipped
