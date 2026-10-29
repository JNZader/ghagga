# Tool Definitions Specification

> **Change**: extensible-static-analysis
> **Type**: New (no existing spec for individual tool definitions)

## Purpose

This spec defines the contract for each static analysis tool plugin in the GHAGGA registry. Each tool is a self-contained plugin that implements the `ToolDefinition` interface. Tools are grouped into two tiers: **always-on** (runs on every PR) and **auto-detect** (activated only when relevant files are present).

---

## Section 1: Always-On Tools (Existing — Adapted)

### Requirement: Semgrep Plugin (adapted)

The Semgrep plugin MUST be adapted from the current hardcoded implementation to conform to the `ToolDefinition` interface.
- **Name**: `semgrep`
- **Display Name**: `Semgrep`
- **Category**: `security`
- **Tier**: `always-on`
- **Version**: `1.90.0` (current pinned version)
- **Output Format**: `json`
- **Install**: `pip install semgrep=={version}`
- **Run**: `semgrep --json --config auto --quiet {repoDir}`
- **Parse**: Map `results[].extra.severity` → `FindingSeverity` (ERROR→high, WARNING→medium, INFO→info, default→low)

#### Scenario: Semgrep adapted to ToolDefinition

- GIVEN the Semgrep plugin is registered via ToolDefinition
- WHEN it runs on a repository with a Python SQL injection pattern
- THEN findings MUST have `source: 'semgrep'` and `category: 'security'`
- AND the output MUST be identical to the current hardcoded Semgrep implementation

#### Scenario: Semgrep install uses cache

- GIVEN Semgrep was previously installed and cached
- WHEN the install function runs
- THEN it MUST restore from cache instead of re-downloading
- AND it MUST verify the binary works after cache restore

### Requirement: Trivy Plugin (adapted + enhanced)

The Trivy plugin MUST be adapted from the current implementation AND enhanced to include license scanning.
- **Name**: `trivy`
- **Display Name**: `Trivy`
- **Category**: `sca`
- **Tier**: `always-on`
- **Version**: `0.69.3` (current pinned version)
- **Output Format**: `json`
- **Install**: Official install script (`curl | sh`)
- **Run**: `trivy fs --format json --scanners vuln,license --quiet {repoDir}`
- **Parse**: Map `Results[].Vulnerabilities[]` severity (CRITICAL→critical, HIGH→high, MEDIUM→medium, LOW→low, default→info); additionally parse `Results[].Licenses[]` as info-severity findings

(Previously: Trivy ran with `--scanners vuln` only)

#### Scenario: Trivy scans vulnerabilities (existing behavior preserved)

- GIVEN a repository with a `package.json` containing a dependency with known CVE
- WHEN Trivy runs
- THEN it MUST produce findings with `category: 'dependency-vulnerability'`
- AND findings MUST include CVE ID, package name, installed version, fixed version

#### Scenario: Trivy scans licenses (new enhancement)

- GIVEN a repository with dependencies using GPL-3.0 licenses
- WHEN Trivy runs with `--scanners vuln,license`
- THEN it MUST produce additional findings with `category: 'license'`
- AND license findings MUST have severity `info`
- AND each finding MUST include the package name and license type

#### Scenario: License scanning does not break existing behavior

- GIVEN Trivy runs with `--scanners vuln,license`
- WHEN the repository has no license issues
- THEN vulnerability scanning MUST still produce findings as before
- AND the total result MUST include zero license findings (not an error)

### Requirement: CPD Plugin (adapted)

The CPD plugin MUST be adapted from the current hardcoded implementation to conform to the `ToolDefinition` interface.
- **Name**: `cpd`
- **Display Name**: `PMD/CPD`
- **Category**: `duplication`
- **Tier**: `always-on`
- **Version**: `7.8.0` (current pinned version, shared with PMD)
- **Output Format**: `xml`
- **Install**: Download PMD zip from GitHub Releases, extract to `/opt/pmd`
- **Run**: `pmd cpd --format xml --minimum-tokens 100 --dir {repoDir} --skip-lexical-errors`
- **Parse**: XML regex parsing for `<duplication>` elements (existing `parseCpdXml` logic)

#### Scenario: CPD adapted to ToolDefinition

- GIVEN the CPD plugin is registered via ToolDefinition
- WHEN it runs on a repository with duplicated code blocks
- THEN findings MUST have `source: 'cpd'` and `category: 'duplication'`
- AND the output MUST be identical to the current hardcoded CPD implementation

#### Scenario: CPD exit code 4 is not an error

- GIVEN CPD finds code duplications
- WHEN CPD exits with code 4
- THEN the run function MUST treat this as a successful execution (not an error)
- AND findings MUST be parsed from the output normally

---

## Section 2: Always-On Tools (New)

### Requirement: Gitleaks Plugin

The system MUST include a Gitleaks plugin for secret detection.
- **Name**: `gitleaks`
- **Display Name**: `Gitleaks`
- **Category**: `secrets`
- **Tier**: `always-on`
- **Version**: `8.21.2`
- **Output Format**: `json`
- **Install**: Download binary from GitHub Releases for the runner's platform (`linux/amd64`)
- **Run**: `gitleaks detect --source {repoDir} --report-format json --report-path /tmp/gitleaks.json --no-git --exit-code 0`
- **Parse**: Map each finding to `ReviewFinding` with severity `critical`, category `secrets`

#### Scenario: Gitleaks detects a leaked API key

- GIVEN a diff containing a file with `AKIA...` (AWS access key pattern)
- WHEN Gitleaks runs
- THEN it MUST produce a finding with `severity: 'critical'`, `category: 'secrets'`, `source: 'gitleaks'`
- AND the finding MUST include the file path and line number
- AND the finding message MUST identify the secret type (e.g., "AWS Access Key")

#### Scenario: Gitleaks finds no secrets

- GIVEN a diff with no hardcoded secrets
- WHEN Gitleaks runs
- THEN it MUST return `status: 'success'` with an empty findings array

#### Scenario: Gitleaks install from GitHub Releases

- GIVEN Gitleaks is not cached
- WHEN the install function runs
- THEN it MUST download the `linux-amd64` binary from `github.com/gitleaks/gitleaks/releases`
- AND make it executable
- AND verify it runs with `gitleaks version`

### Requirement: ShellCheck Plugin

The system MUST include a ShellCheck plugin for shell script linting.
- **Name**: `shellcheck`
- **Display Name**: `ShellCheck`
- **Category**: `linting`
- **Tier**: `always-on`
- **Version**: `0.10.0`
- **Output Format**: `json`
- **Install**: Download binary from GitHub Releases (pre-installed on GitHub Actions runners — install is a verification step)
- **Run**: `shellcheck --format=json {shell_files}` where `{shell_files}` are `*.sh`, `*.bash` files in the repo
- **Parse**: Map each finding's `level` to severity (error→high, warning→medium, info→info, style→low)

#### Scenario: ShellCheck lints shell scripts

- GIVEN a diff containing a `deploy.sh` with `#!/bin/bash` and an unquoted variable `$FOO`
- WHEN ShellCheck runs
- THEN it MUST produce a finding with `severity: 'medium'`, `source: 'shellcheck'`
- AND the finding message MUST reference the ShellCheck rule code (e.g., SC2086)

#### Scenario: ShellCheck skips non-shell files

- GIVEN a repository with no `.sh` or `.bash` files
- WHEN ShellCheck runs
- THEN it MUST return `status: 'success'` with an empty findings array
- AND it MUST NOT return an error

#### Scenario: ShellCheck pre-installed on GitHub Actions

- GIVEN the runner is a GitHub Actions environment
- WHEN the install function runs
- THEN it SHOULD verify ShellCheck is already available via `shellcheck --version`
- AND skip the download if the installed version is compatible

### Requirement: markdownlint-cli2 Plugin

The system MUST include a markdownlint-cli2 plugin for Markdown quality checks.
- **Name**: `markdownlint`
- **Display Name**: `markdownlint-cli2`
- **Category**: `docs`
- **Tier**: `always-on`
- **Version**: `0.17.1`
- **Output Format**: `json`
- **Install**: `npm install -g markdownlint-cli2@{version}`
- **Run**: `markdownlint-cli2 --config /dev/null "**/*.md" --output-file /tmp/mdlint.json` scoped to changed files
- **Parse**: Map each finding to `ReviewFinding` with severity `low`, category `docs`

#### Scenario: markdownlint detects broken heading structure

- GIVEN a diff containing a `README.md` with heading level jump (h1 → h3)
- WHEN markdownlint runs
- THEN it MUST produce a finding with `source: 'markdownlint'`, `category: 'docs'`
- AND the finding MUST reference the rule (e.g., MD001)

#### Scenario: No Markdown files in diff

- GIVEN a diff with only `.ts` and `.json` files
- WHEN markdownlint runs
- THEN it MUST return `status: 'success'` with an empty findings array

#### Scenario: markdownlint scoped to changed files only

- GIVEN a repository with 200 Markdown files but only 2 changed in the PR
- WHEN markdownlint runs
- THEN it MUST only lint the 2 changed files (not all 200)
- AND this scoping MUST prevent false positives on pre-existing issues

### Requirement: Lizard Plugin

The system MUST include a Lizard plugin for cyclomatic complexity analysis.
- **Name**: `lizard`
- **Display Name**: `Lizard`
- **Category**: `complexity`
- **Tier**: `always-on`
- **Version**: `1.17.13`
- **Output Format**: `json`
- **Install**: `pip install lizard=={version}`
- **Run**: `lizard --json {repoDir}` or scoped to changed files
- **Parse**: Flag functions with cyclomatic complexity > 15 as `medium`, > 25 as `high`

#### Scenario: Lizard flags high complexity function

- GIVEN a diff containing a function with cyclomatic complexity of 20
- WHEN Lizard runs
- THEN it MUST produce a finding with `severity: 'medium'`, `category: 'complexity'`, `source: 'lizard'`
- AND the finding message MUST include the function name and complexity score

#### Scenario: Lizard flags extreme complexity

- GIVEN a function with cyclomatic complexity of 30
- WHEN Lizard runs
- THEN it MUST produce a finding with `severity: 'high'`

#### Scenario: All functions within threshold

- GIVEN all functions have complexity <= 15
- WHEN Lizard runs
- THEN it MUST return `status: 'success'` with an empty findings array

---

## Section 3: Auto-Detect Tools

### Requirement: Auto-Detect Activation Contract

Each auto-detect tool MUST define a `detect` function that receives the list of changed file paths and returns `true` if the tool should activate.

#### Scenario: Tool activates on matching file extension

- GIVEN the file list contains `src/main.py` and `tests/test_main.py`
- WHEN the Ruff plugin's `detect` function is called
- THEN it MUST return `true`

#### Scenario: Tool does not activate on non-matching files

- GIVEN the file list contains only `src/app.ts` and `package.json`
- WHEN the Ruff plugin's `detect` function is called
- THEN it MUST return `false`

### Requirement: Ruff Plugin (Python)

The system MUST include a Ruff plugin for Python linting.
- **Name**: `ruff`
- **Display Name**: `Ruff`
- **Category**: `linting`
- **Tier**: `auto-detect`
- **Detect**: `files.some(f => f.endsWith('.py') || f.endsWith('.pyi'))`
- **Version**: `0.9.7`
- **Output Format**: `json`
- **Install**: `pip install ruff=={version}`
- **Run**: `ruff check --output-format json {repoDir}` scoped to changed Python files
- **Parse**: Map `code` prefix to severity (E→high for errors, W→medium for warnings, C/R/I→low)

#### Scenario: Ruff detects Python lint issues

- GIVEN a Python file with unused imports and line length violations
- WHEN Ruff runs
- THEN it MUST produce findings with `source: 'ruff'`, `category: 'linting'`

#### Scenario: Ruff activates only for Python repos

- GIVEN a PR with only `.go` files
- WHEN auto-detect runs
- THEN Ruff MUST NOT be activated

### Requirement: Bandit Plugin (Python Security)

The system MUST include a Bandit plugin for Python-specific security analysis.
- **Name**: `bandit`
- **Display Name**: `Bandit`
- **Category**: `security`
- **Tier**: `auto-detect`
- **Detect**: `files.some(f => f.endsWith('.py'))`
- **Version**: `1.8.3`
- **Output Format**: `json`
- **Install**: `pip install bandit=={version}`
- **Run**: `bandit -r {repoDir} -f json --quiet` scoped to changed Python files
- **Parse**: Map severity (HIGH→high, MEDIUM→medium, LOW→low) and confidence

#### Scenario: Bandit detects Python security issue

- GIVEN a Python file using `eval()` on user input
- WHEN Bandit runs
- THEN it MUST produce a finding with `severity: 'high'`, `source: 'bandit'`, `category: 'security'`

#### Scenario: Bandit and Ruff co-activate on Python

- GIVEN a PR with Python files
- WHEN auto-detect runs
- THEN both Ruff AND Bandit MUST be activated
- AND their findings MUST be independently identified by `source`

### Requirement: golangci-lint Plugin (Go)

The system MUST include a golangci-lint plugin for Go code analysis.
- **Name**: `golangci-lint`
- **Display Name**: `golangci-lint`
- **Category**: `linting`
- **Tier**: `auto-detect`
- **Detect**: `files.some(f => f === 'go.mod' || f.endsWith('.go'))`
- **Version**: `1.63.4`
- **Output Format**: `json`
- **Install**: Download binary from GitHub Releases (`linux-amd64`)
- **Run**: `golangci-lint run --out-format json --timeout {timeout}s {repoDir}`
- **Parse**: Map `Issues[].Severity` to FindingSeverity

#### Scenario: golangci-lint detects Go issues

- GIVEN a Go file with unused variables and error handling issues
- WHEN golangci-lint runs
- THEN it MUST produce findings with `source: 'golangci-lint'`, `category: 'linting'`

#### Scenario: golangci-lint activates on go.mod presence

- GIVEN a PR modifying `go.mod` but no `.go` files
- WHEN auto-detect runs
- THEN golangci-lint MUST be activated (go.mod change implies Go project)

#### Scenario: golangci-lint respects repo .golangci.yml

- GIVEN a repository with a `.golangci.yml` configuration
- WHEN golangci-lint runs
- THEN it MUST use the repository's configuration (not a GHAGGA default)

### Requirement: Biome Plugin (JavaScript/TypeScript)

The system MUST include a Biome plugin for JavaScript and TypeScript linting.
- **Name**: `biome`
- **Display Name**: `Biome`
- **Category**: `linting`
- **Tier**: `auto-detect`
- **Detect**: `files.some(f => /\.(ts|tsx|js|jsx|mts|mjs|cts|cjs)$/.test(f))`
- **Version**: `1.9.4`
- **Output Format**: `json`
- **Install**: Download binary from GitHub Releases (`biome-linux-x64`)
- **Run**: `biome lint --reporter json {repoDir}` scoped to changed JS/TS files
- **Parse**: Map diagnostic severity to FindingSeverity

#### Scenario: Biome detects TypeScript issues

- GIVEN a `.tsx` file with unused variables and suspicious comparisons
- WHEN Biome runs
- THEN it MUST produce findings with `source: 'biome'`, `category: 'linting'`

#### Scenario: Biome activates on JS/TS files

- GIVEN a PR with `.ts` and `.tsx` files
- WHEN auto-detect runs
- THEN Biome MUST be activated

#### Scenario: Biome respects repo biome.json

- GIVEN a repository with a `biome.json` configuration
- WHEN Biome runs
- THEN it MUST use the repository's configuration

### Requirement: PMD Full Plugin (Java)

The system MUST include a PMD plugin (full ruleset) for Java code analysis, separate from the CPD duplication tool.
- **Name**: `pmd`
- **Display Name**: `PMD`
- **Category**: `quality`
- **Tier**: `auto-detect`
- **Detect**: `files.some(f => f.endsWith('.java'))`
- **Version**: `7.8.0` (shared installation with CPD)
- **Output Format**: `xml`
- **Install**: Shared with CPD — PMD binary at `/opt/pmd/bin/pmd`
- **Run**: `pmd check --format xml --dir {repoDir} --rulesets rulesets/java/quickstart.xml`
- **Parse**: Map violation `priority` to severity (1→critical, 2→high, 3→medium, 4→low, 5→info)

#### Scenario: PMD detects Java code quality issues

- GIVEN a Java file with empty catch blocks and unused variables
- WHEN PMD runs
- THEN it MUST produce findings with `source: 'pmd'`, `category: 'quality'`

#### Scenario: PMD shares install with CPD

- GIVEN CPD (always-on) has already installed PMD
- WHEN PMD (auto-detect) install function runs
- THEN it MUST detect the existing installation and skip re-download
- AND both CPD and PMD MUST use the same PMD binary

### Requirement: Psalm Plugin (PHP)

The system MUST include a Psalm plugin for PHP static analysis.
- **Name**: `psalm`
- **Display Name**: `Psalm`
- **Category**: `quality`
- **Tier**: `auto-detect`
- **Detect**: `files.some(f => f.endsWith('.php'))`
- **Version**: `6.5.1`
- **Output Format**: `json`
- **Install**: Download Psalm PHAR from GitHub Releases
- **Run**: `php psalm.phar --output-format=json --no-cache {repoDir}`
- **Parse**: Map `severity` field to FindingSeverity (error→high, info→info)

#### Scenario: Psalm detects PHP type errors

- GIVEN a PHP file with type mismatches
- WHEN Psalm runs
- THEN it MUST produce findings with `source: 'psalm'`, `category: 'quality'`

#### Scenario: Psalm requires PHP runtime

- GIVEN the runner does not have PHP installed
- WHEN Psalm's install function runs
- THEN it MUST check for `php` binary availability
- AND if PHP is not available, the tool MUST return `status: 'error'` with a descriptive message

### Requirement: clippy Plugin (Rust)

The system MUST include a clippy plugin for Rust linting.
- **Name**: `clippy`
- **Display Name**: `Clippy`
- **Category**: `linting`
- **Tier**: `auto-detect`
- **Detect**: `files.some(f => f === 'Cargo.toml' || f.endsWith('.rs'))`
- **Version**: (uses the project's installed Rust toolchain)
- **Output Format**: `json`
- **Install**: Verify `cargo` is available (clippy comes with rustup)
- **Run**: `cargo clippy --message-format json -- -W clippy::all` with timeout
- **Parse**: Map compiler message `level` to severity (error→high, warning→medium, note→info, help→info)

#### Scenario: clippy detects Rust lint issues

- GIVEN a Rust file with unnecessary clones and unused must-use values
- WHEN clippy runs
- THEN it MUST produce findings with `source: 'clippy'`, `category: 'linting'`

#### Scenario: clippy compilation required

- GIVEN a Rust project that needs compilation for clippy to run
- WHEN clippy runs
- THEN it MUST account for compilation time within its time budget
- AND if compilation fails, the tool MUST return `status: 'error'` with the compiler error

#### Scenario: clippy requires Cargo.toml

- GIVEN a PR modifying `.rs` files in a repo without `Cargo.toml`
- WHEN auto-detect runs
- THEN clippy SHOULD still activate (`.rs` files detected)
- AND if `cargo clippy` fails due to missing manifest, it MUST return `status: 'error'`

### Requirement: Hadolint Plugin (Dockerfile)

The system MUST include a Hadolint plugin for Dockerfile linting.
- **Name**: `hadolint`
- **Display Name**: `Hadolint`
- **Category**: `linting`
- **Tier**: `auto-detect`
- **Detect**: `files.some(f => /Dockerfile/.test(f.split('/').pop() ?? ''))`
- **Version**: `2.12.0`
- **Output Format**: `json`
- **Install**: Download binary from GitHub Releases (`Linux-x86_64`)
- **Run**: `hadolint --format json {dockerfiles}` where `{dockerfiles}` are the changed Dockerfiles
- **Parse**: Map `level` to severity (error→high, warning→medium, info→info, style→low)

#### Scenario: Hadolint detects Dockerfile issues

- GIVEN a `Dockerfile` using `latest` tag and running as root
- WHEN Hadolint runs
- THEN it MUST produce findings with `source: 'hadolint'`, `category: 'linting'`
- AND findings MUST reference the Hadolint rule (e.g., DL3007 for latest tag)

#### Scenario: Hadolint matches Dockerfile variants

- GIVEN a PR with files `Dockerfile`, `Dockerfile.prod`, `docker/Dockerfile.api`
- WHEN auto-detect runs
- THEN Hadolint MUST activate
- AND it MUST lint all Dockerfile-matching files

#### Scenario: No Dockerfiles in diff

- GIVEN a PR with only source code files
- WHEN auto-detect runs
- THEN Hadolint MUST NOT activate

---

## Section 4: Cross-Cutting Tool Requirements

### Requirement: Tool Output Normalization

Every tool plugin's `parse` function MUST normalize output into `ReviewFinding[]` conforming to the existing `ReviewFinding` interface.

#### Scenario: Finding has all required fields

- GIVEN any tool produces a finding
- WHEN the `parse` function creates a `ReviewFinding`
- THEN it MUST include: `severity`, `category`, `file`, `message`, `source`
- AND `line` SHOULD be included when the tool provides line information
- AND `suggestion` MAY be included when the tool provides fix recommendations

### Requirement: Tool Binary Verification

Every tool's `install` function MUST verify the binary works after installation.

#### Scenario: Binary verification after install

- GIVEN a tool was just installed
- WHEN the install function completes
- THEN it MUST run a version check command (e.g., `tool --version`)
- AND if the version check fails, install MUST be retried once
- AND if retry fails, the install function MUST throw with a descriptive error

### Requirement: Tool Scoping to Changed Files

Tools that support file-level scoping SHOULD be scoped to only the files changed in the PR/diff, not the entire repository.

#### Scenario: Tool scoped to changed files

- GIVEN a PR changes 3 files out of 500 in the repository
- WHEN a scopeable tool (ShellCheck, markdownlint, Biome) runs
- THEN it MUST only analyze the 3 changed files
- AND findings MUST NOT include issues from unchanged files

#### Scenario: Tool requires full repo scan

- GIVEN a tool like Trivy that needs full dependency tree context
- WHEN Trivy runs
- THEN it MUST scan the entire repository (not just changed files)
- AND this is the expected behavior for SCA tools
