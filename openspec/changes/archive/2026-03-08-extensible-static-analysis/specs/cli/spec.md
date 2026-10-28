# Delta for CLI

> **Change**: extensible-static-analysis
> **Existing spec**: `openspec/specs/cli-tui/spec.md`

## ADDED Requirements

### Requirement: --disable-tool Flag

The `ghagga review` command MUST accept a `--disable-tool <name>` option that disables a specific tool by name.

The flag MUST be repeatable to disable multiple tools.

#### Scenario: Disable a single tool

- GIVEN the user runs `ghagga review --disable-tool gitleaks`
- WHEN the review pipeline executes
- THEN Gitleaks MUST NOT run
- AND all other tools MUST run as normal

#### Scenario: Disable multiple tools

- GIVEN the user runs `ghagga review --disable-tool gitleaks --disable-tool shellcheck --disable-tool cpd`
- WHEN the review pipeline executes
- THEN Gitleaks, ShellCheck, and CPD MUST NOT run
- AND all other tools MUST run as normal

#### Scenario: Disable unknown tool name

- GIVEN the user runs `ghagga review --disable-tool nonexistent`
- WHEN the CLI validates the tool name
- THEN the CLI MUST print a warning: `Warning: Unknown tool "nonexistent". Known tools: semgrep, trivy, cpd, gitleaks, ...`
- AND the review MUST proceed (non-blocking warning, not a fatal error)

#### Scenario: Disable all tools

- GIVEN the user runs `ghagga review --disable-tool semgrep --disable-tool trivy --disable-tool cpd --disable-tool gitleaks --disable-tool shellcheck --disable-tool markdownlint --disable-tool lizard`
- WHEN the review pipeline executes
- THEN no static analysis tools MUST run
- AND if AI review is enabled, the LLM pipeline MUST still execute without static analysis context

### Requirement: --enable-tool Flag

The `ghagga review` command MUST accept an `--enable-tool <name>` option that force-enables a specific tool, overriding auto-detect.

The flag MUST be repeatable.

#### Scenario: Force-enable an auto-detect tool

- GIVEN a repository with no Python files
- AND the user runs `ghagga review --enable-tool ruff`
- WHEN the review pipeline executes
- THEN Ruff MUST be activated (force-enabled despite auto-detect not triggering)

#### Scenario: Enable unknown tool

- GIVEN the user runs `ghagga review --enable-tool nonexistent`
- WHEN the CLI validates the tool name
- THEN the CLI MUST print a warning: `Warning: Unknown tool "nonexistent". Known tools: ...`
- AND the review MUST proceed

#### Scenario: Both enable and disable the same tool

- GIVEN the user runs `ghagga review --enable-tool semgrep --disable-tool semgrep`
- WHEN the CLI resolves tools
- THEN `--disable-tool` MUST take precedence
- AND Semgrep MUST NOT run

### Requirement: --list-tools Flag

The `ghagga review` command MUST accept a `--list-tools` flag that prints all registered tools and exits.

#### Scenario: List all tools

- GIVEN the user runs `ghagga review --list-tools`
- WHEN the CLI processes the flag
- THEN it MUST print a table with columns: Name, Category, Tier, Version
- AND it MUST list all 15 registered tools
- AND the process MUST exit with code 0 without running a review

#### Scenario: List tools in JSON format

- GIVEN the user runs `ghagga review --list-tools --format json`
- WHEN the CLI processes the flags
- THEN it MUST print a JSON array of tool objects
- AND each object MUST include `name`, `displayName`, `category`, `tier`, `version`

## MODIFIED Requirements

### Requirement: Deprecated Tool Flags

The existing `--no-semgrep`, `--no-trivy`, `--no-cpd` flags MUST be preserved as deprecated aliases.

(Previously: These were the only way to disable individual tools)

#### Scenario: --no-semgrep still works

- GIVEN the user runs `ghagga review --no-semgrep`
- WHEN the CLI processes options
- THEN it MUST translate `--no-semgrep` to `--disable-tool semgrep` internally
- AND Semgrep MUST NOT run
- AND a deprecation warning MUST be printed: `Warning: --no-semgrep is deprecated. Use --disable-tool semgrep instead.`

#### Scenario: --no-trivy still works

- GIVEN the user runs `ghagga review --no-trivy`
- WHEN the CLI processes options
- THEN it MUST translate `--no-trivy` to `--disable-tool trivy` internally
- AND a deprecation warning MUST be printed

#### Scenario: --no-cpd still works

- GIVEN the user runs `ghagga review --no-cpd`
- WHEN the CLI processes options
- THEN it MUST translate `--no-cpd` to `--disable-tool cpd` internally
- AND a deprecation warning MUST be printed

#### Scenario: Mix old and new flags

- GIVEN the user runs `ghagga review --no-semgrep --disable-tool gitleaks`
- WHEN the CLI processes options
- THEN both Semgrep AND Gitleaks MUST be disabled
- AND the deprecation warning for `--no-semgrep` MUST be printed

### Requirement: ReviewOptions Interface Update

The `ReviewOptions` interface MUST be updated to support the new tool flags.

(Previously: `ReviewOptions` had `semgrep: boolean`, `trivy: boolean`, `cpd: boolean`)

#### Scenario: ReviewOptions includes new fields

- GIVEN the new `ReviewOptions` interface
- WHEN inspected
- THEN it MUST include:
  - `disableTools: string[]` (from `--disable-tool`)
  - `enableTools: string[]` (from `--enable-tool`)
- AND the old `semgrep`, `trivy`, `cpd` boolean fields MUST remain for backward compat

#### Scenario: mergeSettings uses new fields

- GIVEN `ReviewOptions` with `disableTools: ['gitleaks']`
- WHEN `mergeSettings` constructs `ReviewSettings`
- THEN `ReviewSettings.disabledTools` MUST include `'gitleaks'`
- AND `ReviewSettings.enabledTools` MUST include any `--enable-tool` values

### Requirement: Config File Extension

The `.ghagga.json` config file MUST support the new tool fields.

(Previously: Config file supported `enableSemgrep`, `enableTrivy`, `enableCpd`)

#### Scenario: Config file with new fields

- GIVEN a `.ghagga.json` with:

  ```json
  {
    "disabledTools": ["cpd", "markdownlint"],
    "enabledTools": ["ruff"]
  }
  ```
- WHEN the CLI loads the config
- THEN it MUST merge these values with CLI flags
- AND CLI flags MUST take precedence over config file

#### Scenario: Config file with old fields

- GIVEN a `.ghagga.json` with `{ "enableCpd": false }`
- WHEN the CLI loads the config
- THEN it MUST still work (backward compat)
- AND CPD MUST be disabled

### Requirement: Verbose Output Tool Listing

In `--verbose` mode, the CLI MUST log which tools are activated and why.

#### Scenario: Verbose shows tool activation reasons

- GIVEN the user runs `ghagga review --verbose` on a Python project
- WHEN the verbose progress handler runs
- THEN it MUST log lines like:

  ```
  [tools] Activated: semgrep (always-on), trivy (always-on), cpd (always-on),
          gitleaks (always-on), shellcheck (always-on), markdownlint (always-on),
          lizard (always-on), ruff (auto-detect: *.py), bandit (auto-detect: *.py)
  [tools] Skipped: golangci-lint, biome, pmd, psalm, clippy, hadolint
  ```

### Requirement: CLI Tool Status Output

The CLI's review output MUST include a summary of which tools ran and their status.

#### Scenario: Tool status in markdown output

- GIVEN the review completes with 10 tools
- WHEN the CLI renders the markdown output
- THEN it MUST include a section showing tool statuses
- AND the section MUST list: tool name, status (success/error/skipped), finding count, execution time

#### Scenario: Tool status in JSON output

- GIVEN the review completes with `--format json`
- WHEN the JSON output is generated
- THEN `staticAnalysis` MUST contain entries for all activated tools
- AND each entry MUST include `status`, `findings`, `executionTimeMs`

## REMOVED Requirements

(None — old flags are preserved as deprecated aliases)
