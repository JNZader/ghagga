# Spec: CLI TUI Presentation Layer

> **Domain**: cli-tui (new)
> **Change**: cli-tui
> **Status**: draft
> **Updated**: 2026-03-08 — Merged delta from `extensible-static-analysis` change (--disable-tool/--enable-tool/--list-tools flags, deprecated aliases, config file extension)

## Overview

The CLI currently outputs all text via raw `console.log`/`console.error` with scattered inline ANSI escape codes, no spinners, and no visual hierarchy. This spec defines a TUI (Terminal User Interface) presentation layer that wraps all CLI output through a thin facade backed by `@clack/prompts`. The layer provides branded headers/footers, animated spinners, structured log methods, and automatic degradation to plain text in non-interactive environments. This is a **presentation-only** change: no command logic, exit codes, argument parsing, or pipeline behavior changes.

## Requirements

---

### R1: TUI Mode Auto-Detection

The system MUST determine the output mode automatically at process startup using a three-signal check:
1. If `--plain` flag is passed, mode MUST be `plain`
2. If `process.stdout.isTTY` is `false` or `undefined`, mode MUST be `plain`
3. If `process.env.CI` is set (any truthy value), mode MUST be `plain`
4. Otherwise, mode MUST be `styled`

The `--plain` flag takes precedence: if set, mode is `plain` regardless of TTY or CI status.

#### Scenario: S1.1 — Auto-detect styled mode in interactive terminal

- GIVEN the process stdout is a TTY (`process.stdout.isTTY === true`)
- AND the `CI` environment variable is NOT set
- AND `--plain` was NOT passed
- WHEN TUI mode is resolved
- THEN the mode MUST be `styled`

#### Scenario: S1.2 — Auto-detect plain mode when piped

- GIVEN the process stdout is NOT a TTY (`process.stdout.isTTY === false`)
- AND `--plain` was NOT passed
- AND the `CI` environment variable is NOT set
- WHEN TUI mode is resolved
- THEN the mode MUST be `plain`

#### Scenario: S1.3 — Auto-detect plain mode in CI environment

- GIVEN the `CI` environment variable is set to `"true"`
- AND the process stdout IS a TTY
- AND `--plain` was NOT passed
- WHEN TUI mode is resolved
- THEN the mode MUST be `plain`

#### Scenario: S1.4 — --plain overrides TTY detection

- GIVEN the process stdout IS a TTY
- AND the `CI` environment variable is NOT set
- AND `--plain` WAS passed
- WHEN TUI mode is resolved
- THEN the mode MUST be `plain`

#### Scenario: S1.5 — stdout.isTTY is undefined (e.g., test runner)

- GIVEN `process.stdout.isTTY` is `undefined`
- AND `--plain` was NOT passed
- AND the `CI` environment variable is NOT set
- WHEN TUI mode is resolved
- THEN the mode MUST be `plain`

---

### R2: TUI Mode Immutability

The TUI mode MUST be determined once during process initialization and MUST NOT change for the lifetime of the process. After initialization, all calls to query the current mode MUST return the same value.

#### Scenario: S2.1 — Mode remains constant after initialization

- GIVEN the TUI was initialized with mode `styled`
- WHEN the mode is queried at the beginning of a command
- AND the mode is queried again at the end of the same command
- THEN both queries MUST return `styled`

#### Scenario: S2.2 — Mode unaffected by environment changes after init

- GIVEN the TUI was initialized with mode `styled` (because TTY was true and CI was unset)
- WHEN `process.env.CI` is set to `"true"` after initialization
- AND the mode is queried
- THEN the mode MUST still be `styled`

---

### R3: --plain Global Flag

The CLI MUST accept a `--plain` global flag on the root command. This flag MUST:
1. Be visible in `ghagga --help` output
2. Apply to ALL subcommands without per-command configuration
3. Force plain mode when present, regardless of terminal capabilities

#### Scenario: S3.1 — --plain appears in help text

- GIVEN the user runs `ghagga --help`
- WHEN the help text is displayed
- THEN the output MUST include a `--plain` option with a description indicating it disables styled terminal output

#### Scenario: S3.2 — --plain applies to subcommands

- GIVEN the user runs `ghagga --plain status`
- WHEN the `status` command executes
- THEN all output MUST use plain mode (no ANSI escape sequences, no spinners)

#### Scenario: S3.3 — --plain position flexibility

- GIVEN the user runs `ghagga status --plain`
- WHEN the command executes
- THEN `--plain` MUST be recognized and plain mode MUST be active

---

### R4: intro() Displays Branded Header Per Command

Each command MUST display a branded intro header at the start of its execution. In styled mode, the header MUST use box-drawing characters and colors. In plain mode, the header MUST use simple text-only delimiters.

The header content SHOULD include context relevant to the specific command (e.g., "Authenticating with GitHub" for login, "Code Review" with mode/provider for review).

> Ref: Design AD7 — intro/outro is per-command, not global.

#### Scenario: S4.1 — Styled intro for review command

- GIVEN the TUI is in `styled` mode
- WHEN the `review` command starts execution
- THEN a branded intro header MUST be displayed
- AND the header MUST include the text "GHAGGA" or the command context

#### Scenario: S4.2 — Plain intro for review command

- GIVEN the TUI is in `plain` mode
- WHEN the `review` command starts execution
- THEN a text-only intro line MUST be displayed (no box-drawing characters, no ANSI escape sequences)

#### Scenario: S4.3 — No intro for --help or --version

- GIVEN the user runs `ghagga --help` or `ghagga --version`
- WHEN the output is displayed
- THEN no branded intro header SHALL be displayed (Commander handles these before any command action runs)

---

### R5: outro() Displays Branded Footer Per Command

Each command MUST display a branded outro footer at the end of its execution. In styled mode, the footer MUST use box-drawing characters and colors. In plain mode, the footer MUST use simple text-only delimiters.

The footer SHOULD include a summary or status message relevant to the command's outcome.

#### Scenario: S5.1 — Styled outro after successful command

- GIVEN the TUI is in `styled` mode
- AND the `review` command has completed successfully
- WHEN the outro is displayed
- THEN a branded footer MUST appear with the command's summary message

#### Scenario: S5.2 — Plain outro after successful command

- GIVEN the TUI is in `plain` mode
- AND the `logout` command has completed successfully
- WHEN the outro is displayed
- THEN a text-only footer line MUST appear with the summary message (no ANSI escape sequences)

#### Scenario: S5.3 — Early exit skips outro

- GIVEN a command encounters a validation error before reaching its main logic
- WHEN the command exits early with an error
- THEN the outro MAY be omitted or replaced with an error-styled message

---

### R6: Structured Log Methods

The TUI facade MUST provide the following log methods: `info`, `success`, `warn`, `error`, `step`, and `message`.

In **styled mode**:
- `info` MUST display with a distinct visual indicator (e.g., blue dot)
- `success` MUST display with a success indicator (e.g., green checkmark)
- `warn` MUST display with a warning indicator (e.g., yellow triangle)
- `error` MUST display with an error indicator (e.g., red X) and MUST write to stderr
- `step` MUST display with a step indicator (used for verbose progress)
- `message` MUST display the raw text with no icon prefix

In **plain mode**:
- All methods except `error` MUST delegate to `console.log`
- `error` MUST delegate to `console.error`
- No ANSI escape sequences SHALL be present in the output

#### Scenario: S6.1 — info() in styled mode produces visual indicator

- GIVEN the TUI is in `styled` mode
- WHEN `tui.log.info("Processing files")` is called
- THEN the output MUST include "Processing files" with a styled visual indicator

#### Scenario: S6.2 — error() writes to stderr in both modes

- GIVEN the TUI is in `plain` mode
- WHEN `tui.log.error("Authentication failed")` is called
- THEN "Authentication failed" MUST be written to stderr (not stdout)

#### Scenario: S6.3 — info() in plain mode produces clean text

- GIVEN the TUI is in `plain` mode
- WHEN `tui.log.info("Processing files")` is called
- THEN the output MUST be written to stdout via `console.log`
- AND the output MUST NOT contain ANSI escape sequences

#### Scenario: S6.4 — message() renders raw text without icon

- GIVEN the TUI is in `styled` mode
- WHEN `tui.log.message(formattedTable)` is called with a multi-line string
- THEN the string MUST be rendered as-is without any prepended icon or indicator

---

### R7: Spinner Creation and Lifecycle

The TUI facade MUST provide a spinner factory function that returns a spinner instance with three methods: `start(message?)`, `message(text)`, and `stop(message?)`.

In **styled mode**:
- `start()` MUST display an animated spinner with the initial message
- `message()` MUST update the spinner's displayed text while it continues spinning
- `stop()` MUST halt the animation and display the final message as a static success indicator

In **plain mode**:
- `start()` MUST be a no-op (produces no output)
- `message()` MUST be a no-op (produces no output)
- `stop()` MUST print the final message as a plain `console.log` line

> Ref: Design AD5 — Spinner integration with review progress callback.

#### Scenario: S7.1 — Spinner lifecycle in styled mode

- GIVEN the TUI is in `styled` mode
- WHEN a spinner is created and `start("Analyzing...")` is called
- AND `message("Running Semgrep...")` is called
- AND `stop("Analysis complete")` is called
- THEN the terminal MUST show an animated indicator during the start-to-stop interval
- AND the final display MUST show "Analysis complete" as a static line

#### Scenario: S7.2 — Spinner in plain mode produces minimal output

- GIVEN the TUI is in `plain` mode
- WHEN a spinner is created and `start("Analyzing...")` is called
- AND `message("Running Semgrep...")` is called
- AND `stop("Analysis complete")` is called
- THEN `start()` and `message()` MUST produce no output
- AND `stop()` MUST produce exactly one line of output containing "Analysis complete"

#### Scenario: S7.3 — Spinner stop without message

- GIVEN the TUI is in `styled` mode
- WHEN a spinner is created, started, and `stop()` is called without a message argument
- THEN the spinner MUST stop without displaying a final message (or display a default)

#### Scenario: S7.4 — Multiple spinners are not concurrent

- GIVEN the TUI is in `styled` mode
- WHEN one spinner is started, then stopped, then a second spinner is started
- THEN each spinner MUST operate independently in sequence
- AND no visual corruption SHALL occur between spinners

---

### R8: Plain Mode Log Delegation

In plain mode, ALL `tui.log.*` calls MUST delegate to the corresponding console method:
- `tui.log.info(msg)` -> `console.log(msg)`
- `tui.log.success(msg)` -> `console.log(msg)`
- `tui.log.warn(msg)` -> `console.log(msg)`
- `tui.log.error(msg)` -> `console.error(msg)`
- `tui.log.step(msg)` -> `console.log(msg)`
- `tui.log.message(msg)` -> `console.log(msg)`

The message content MUST be passed through without modification (no prefixing, no wrapping, no stripping).

#### Scenario: S8.1 — Plain mode log.info delegates to console.log

- GIVEN the TUI is in `plain` mode
- WHEN `tui.log.info("Hello world")` is called
- THEN `console.log` MUST be called with "Hello world" as the argument

#### Scenario: S8.2 — Plain mode log.error delegates to console.error

- GIVEN the TUI is in `plain` mode
- WHEN `tui.log.error("Something broke")` is called
- THEN `console.error` MUST be called with "Something broke" as the argument
- AND `console.log` MUST NOT be called

#### Scenario: S8.3 — Plain mode preserves multi-line message content

- GIVEN the TUI is in `plain` mode
- AND a message contains newlines (e.g., a formatted table string)
- WHEN `tui.log.message(tableString)` is called
- THEN `console.log` MUST be called with the exact table string, preserving newlines

---

### R9: Spinner No-Op in Plain Mode

In plain mode, the spinner's `start()` and `message()` methods MUST be no-ops that produce zero output. Only `stop(message)` MAY produce output (a single `console.log` line).

This ensures piped or CI output contains no spinner artifacts (partial lines, cursor movement sequences, etc.).

#### Scenario: S9.1 — Spinner start is silent in plain mode

- GIVEN the TUI is in `plain` mode
- WHEN a spinner is created and `start("Loading...")` is called
- THEN no output MUST be written to stdout or stderr

#### Scenario: S9.2 — Spinner message updates are silent in plain mode

- GIVEN the TUI is in `plain` mode
- AND a spinner has been started
- WHEN `spinner.message("Step 2...")` is called 5 times
- THEN no output MUST be written to stdout or stderr for any of those calls

#### Scenario: S9.3 — Spinner stop produces exactly one line in plain mode

- GIVEN the TUI is in `plain` mode
- AND a spinner has been started with `start("Loading...")`
- AND `message()` has been called 3 times
- WHEN `stop("Done")` is called
- THEN exactly one line containing "Done" MUST be written to stdout

---

### R10: No ANSI Escape Sequences in Plain Mode

In plain mode, ALL output produced through the TUI facade (log methods, intro, outro, spinner stop) MUST be free of ANSI escape sequences. This includes:
- Color codes (`\x1b[31m`, `\x1b[0m`, etc.)
- Cursor movement sequences (`\x1b[A`, `\r`, etc.)
- Box-drawing characters that depend on terminal capability MAY still be used (they are Unicode, not ANSI escapes)

#### Scenario: S10.1 — Plain mode output contains no ANSI sequences

- GIVEN the TUI is in `plain` mode
- WHEN `tui.intro("Test")`, `tui.log.info("msg")`, `tui.log.success("ok")`, `tui.log.error("err")`, and `tui.outro("done")` are all called
- THEN the combined stdout+stderr output MUST NOT match the pattern `/\x1b\[/` (no ANSI CSI sequences)

#### Scenario: S10.2 — Plain mode output of formatted review results has no ANSI

- GIVEN the TUI is in `plain` mode
- AND a review command completes with findings
- WHEN the formatted results are displayed
- THEN the output MUST NOT contain any ANSI escape sequences

---

### R11: Login Command — Device Code Box and Spinner

The `login` command MUST display:
1. A branded intro header
2. A visually distinct presentation of the device code and verification URL (styled mode: box or highlight; plain mode: clear text labels)
3. A spinner while polling for OAuth authorization completion
4. A success message and outro on successful authentication
5. An error message on authentication failure

#### Scenario: S11.1 — Login shows device code and waits with spinner

- GIVEN the TUI is in `styled` mode
- AND the user runs `ghagga login`
- AND the OAuth device flow returns a device code and verification URL
- WHEN the device code is displayed
- THEN the verification URL and device code MUST be presented in a visually distinct format
- AND a spinner MUST be displayed while waiting for authorization

#### Scenario: S11.2 — Login in plain mode shows device code without styling

- GIVEN the TUI is in `plain` mode
- AND the user runs `ghagga login`
- WHEN the device code is displayed
- THEN the verification URL and device code MUST be clearly labeled in plain text
- AND no spinner animation MUST appear (only the final auth result produces output)

#### Scenario: S11.3 — Login failure displays styled error

- GIVEN the user runs `ghagga login`
- AND the OAuth flow fails (timeout, network error, or user denies)
- WHEN the error is reported
- THEN `tui.log.error()` MUST be used to display the error message
- AND the process MUST exit with the same exit code as before the TUI change

---

### R12: Logout Command — Styled Success/Info Messages

The `logout` command MUST use `tui.log.*` methods for all output instead of raw `console.log`.

#### Scenario: S12.1 — Successful logout with styled output

- GIVEN the user is authenticated
- AND the TUI is in `styled` mode
- WHEN `ghagga logout` is run
- THEN a success message MUST be displayed using `tui.log.success()`

#### Scenario: S12.2 — Logout when not authenticated

- GIVEN the user is NOT authenticated (no stored token)
- WHEN `ghagga logout` is run
- THEN an info message MUST be displayed using `tui.log.info()`
- AND the exit code MUST be unchanged from current behavior

---

### R13: Status Command — Styled Key-Value Display with Colored Badges

The `status` command MUST display configuration and authentication status using structured, styled key-value pairs. In styled mode, status values (e.g., "authenticated", "not authenticated") MUST use colored indicators. In plain mode, the same information MUST be displayed without colors.

#### Scenario: S13.1 — Status shows authenticated state with styled badge

- GIVEN the user is authenticated
- AND the TUI is in `styled` mode
- WHEN `ghagga status` is run
- THEN the authentication status MUST be displayed with a green/success-colored indicator
- AND configuration values (provider, model, mode) MUST be displayed as labeled key-value pairs

#### Scenario: S13.2 — Status shows unauthenticated state with styled badge

- GIVEN the user is NOT authenticated
- AND the TUI is in `styled` mode
- WHEN `ghagga status` is run
- THEN the authentication status MUST be displayed with a red/error-colored indicator

#### Scenario: S13.3 — Status in plain mode has no ANSI color codes

- GIVEN the TUI is in `plain` mode
- WHEN `ghagga status` is run
- THEN all status information MUST be displayed
- AND the output MUST NOT contain ANSI escape sequences (previously, raw `\x1b[31m`/`\x1b[32m` codes were embedded inline)

---

### R14: Review Command — Spinner, Progress, and Styled Results

The `review` command MUST:
1. Display a branded intro with mode, provider, and model information
2. Show a spinner during the review pipeline execution (non-verbose mode)
3. Update the spinner message via the existing `onProgress` callback as each step completes
4. Display styled review results (findings, status, summary)
5. Display a branded outro with the overall result status

> Ref: Design AD5, AD6 — Spinner integration and verbose mode conflict resolution.

#### Scenario: S14.1 — Review with spinner in non-verbose mode

- GIVEN the TUI is in `styled` mode
- AND `--verbose` is NOT set
- WHEN `ghagga review .` is run
- THEN a spinner MUST appear after the intro
- AND the spinner message MUST update as progress events fire (e.g., "Running Semgrep...", "Calling AI agent...")
- AND the spinner MUST stop when the review pipeline completes
- AND the formatted results MUST be displayed after the spinner stops

#### Scenario: S14.2 — Review results display with findings

- GIVEN a review completes with findings
- AND the TUI is in `styled` mode
- WHEN results are displayed
- THEN findings MUST be grouped by source with severity indicators
- AND the overall status MUST use the corresponding status emoji

#### Scenario: S14.3 — Review results display with zero findings

- GIVEN a review completes with status `PASSED` and zero findings
- WHEN results are displayed
- THEN the status MUST show the `PASSED` indicator
- AND no findings table SHALL be displayed

#### Scenario: S14.4 — Review in plain mode shows results without spinner

- GIVEN the TUI is in `plain` mode
- AND `--verbose` is NOT set
- WHEN `ghagga review .` is run
- THEN no spinner animation MUST appear
- AND the review results MUST be displayed as plain text

---

### R15: Memory Commands — Styled Tables and Formatted Output

All memory subcommands (`list`, `search`, `show`, `delete`, `stats`, `clear`) MUST use the TUI facade for all output. Table-formatted data MUST use the centralized `formatTable()` function. Stats and metadata MUST use structured log methods.

#### Scenario: S15.1 — Memory list shows styled table

- GIVEN the memory contains observations
- AND the TUI is in `styled` mode
- WHEN `ghagga memory list` is run
- THEN observations MUST be displayed in a formatted table
- AND the output MUST use `tui.log.*` methods

#### Scenario: S15.2 — Memory list with empty results

- GIVEN the memory contains no observations
- WHEN `ghagga memory list` is run
- THEN an info message MUST be displayed indicating no observations found

#### Scenario: S15.3 — Memory stats uses structured output

- GIVEN the memory contains observations
- WHEN `ghagga memory stats` is run
- THEN statistics MUST be displayed using structured log methods
- AND formatted sizes MUST use human-readable units (bytes, KB, MB)

#### Scenario: S15.4 — Memory commands in plain mode

- GIVEN the TUI is in `plain` mode
- WHEN any memory subcommand is run
- THEN all output MUST be plain text via `console.log`
- AND the content and structure of tables MUST be identical to styled mode (only visual decorations differ)

---

### R16: review --format json Bypasses All TUI Output on stdout

When `--format json` is used with the `review` command, the TUI MUST NOT write any non-JSON content to stdout. The intro, outro, log messages, and spinner output MUST be suppressed or redirected so that stdout contains ONLY the raw JSON result.

> Ref: Design — JSON Format Bypass section and revised decision.

#### Scenario: S16.1 — JSON format produces only JSON on stdout

- GIVEN the user runs `ghagga review . --format json`
- WHEN the review completes
- THEN stdout MUST contain valid JSON (parseable by `JSON.parse()`)
- AND stdout MUST NOT contain any intro/outro text, log messages, or spinner artifacts

#### Scenario: S16.2 — JSON format with --plain

- GIVEN the user runs `ghagga review . --format json --plain`
- WHEN the review completes
- THEN stdout MUST contain only valid JSON
- AND the `--plain` flag MUST NOT affect the JSON output format

#### Scenario: S16.3 — JSON output is pipeable

- GIVEN the user runs `ghagga review . --format json | jq .status`
- WHEN the pipeline completes
- THEN `jq` MUST successfully parse the input
- AND no TUI artifacts SHALL corrupt the JSON stream

---

### R17: Piped stdout Produces Clean Output

When stdout is piped to another process or redirected to a file, the output MUST be free of spinner artifacts, cursor movement sequences, and partial lines. The TUI MUST auto-detect the piped state via TTY detection (R1) and select plain mode.

#### Scenario: S17.1 — Piped output is clean

- GIVEN the user runs `ghagga review . | cat`
- WHEN the output is captured
- THEN stdout MUST NOT contain cursor movement sequences (`\r`, `\x1b[A`, `\x1b[K`)
- AND stdout MUST NOT contain partial/overwritten lines from spinner updates

#### Scenario: S17.2 — Redirected output is clean

- GIVEN the user runs `ghagga status > output.txt`
- WHEN `output.txt` is read
- THEN the file MUST contain clean text lines without ANSI escape sequences
- AND the file MUST NOT contain spinner animation artifacts

---

### R18: CI Environment Auto-Selects Plain Mode

When running in a CI environment (detected via `process.env.CI`), the TUI MUST automatically select plain mode without user intervention. This MUST cover all major CI providers (GitHub Actions, GitLab CI, Jenkins, CircleCI, Travis CI).

#### Scenario: S18.1 — GitHub Actions triggers plain mode

- GIVEN the environment variable `CI` is set to `"true"` (as in GitHub Actions)
- AND `process.stdout.isTTY` is `false`
- WHEN any GHAGGA command is run
- THEN plain mode MUST be active
- AND all output MUST be free of ANSI escape sequences and spinner artifacts

#### Scenario: S18.2 — CI with TTY still selects plain mode

- GIVEN the environment variable `CI` is set to `"true"`
- AND `process.stdout.isTTY` is `true` (some CI systems allocate a PTY)
- WHEN any GHAGGA command is run
- THEN plain mode MUST still be active (CI takes precedence over TTY)

---

### R19: NO_COLOR Environment Variable

The system SHOULD respect the `NO_COLOR` environment variable per the [no-color.org](https://no-color.org) standard. When `NO_COLOR` is set (to any value), colors MUST be disabled, but structural elements (spinners, box-drawing, intro/outro layout) MAY still be used if the terminal is interactive.

Note: `NO_COLOR` disables colors only. `--plain` and CI/pipe detection disable both colors AND structural elements (spinners, etc.).

#### Scenario: S19.1 — NO_COLOR disables colors but allows structure

- GIVEN `NO_COLOR=1` is set
- AND `process.stdout.isTTY` is `true`
- AND `CI` is NOT set
- AND `--plain` is NOT passed
- WHEN any GHAGGA command is run
- THEN colors MUST be disabled (no color ANSI codes)
- BUT structural elements (spinners, box-drawing) MAY still appear

#### Scenario: S19.2 — NO_COLOR combined with --plain

- GIVEN `NO_COLOR=1` is set
- AND `--plain` is passed
- WHEN any GHAGGA command is run
- THEN the output MUST be in plain mode (no colors, no spinners, no structure)

---

### R20: All Existing CLI Flags Continue Working (Modified)

All pre-existing CLI flags and options MUST continue to work identically after the TUI change. This includes but is not limited to: `--no-memory`, `--no-semgrep` (deprecated), `--no-trivy` (deprecated), `--no-cpd` (deprecated), `-v`/`--verbose`, `-m`/`--mode`, `-p`/`--provider`, `--model`, `--api-key`, `-f`/`--format`, `-c`/`--config`, `--disable-tool`, `--enable-tool`, `--list-tools`.

> **Updated by**: `extensible-static-analysis` change (2026-03-08) — `--no-semgrep`/`--no-trivy`/`--no-cpd` deprecated in favor of `--disable-tool`.

#### Scenario: S20.1 — Existing flags unaffected

- GIVEN the user runs `ghagga review . --no-memory --no-semgrep -v -m simple -p openai --model gpt-4o -f markdown`
- WHEN the command executes
- THEN all flags MUST be parsed and applied identically to pre-TUI behavior
- AND the review pipeline MUST receive the same options as before

#### Scenario: S20.2 — --plain does not interfere with other flags

- GIVEN the user runs `ghagga review . --plain --no-memory -v`
- WHEN the command executes
- THEN `--no-memory` and `-v` MUST be applied to the review pipeline
- AND `--plain` MUST only affect output presentation

#### Scenario: S20.3 — review --help shows new hook-related flags

> Added by change: cli-git-hooks
- GIVEN the user runs `ghagga review --help`
- WHEN the help text is displayed
- THEN the output MUST document `--staged`, `--commit-msg <file>`, `--exit-on-issues`, and `--quick` alongside the existing flags
- AND each new flag MUST have a description

#### Scenario: S20.4 — Existing flags still appear in review --help

> Added by change: cli-git-hooks
- GIVEN the user runs `ghagga review --help`
- WHEN the help text is displayed
- THEN all pre-existing flags (`--no-memory`, `--no-semgrep`, `--no-trivy`, `--no-cpd`, `-v`, `-m`, `-p`, `--model`, `--api-key`, `-f`, `-c`) MUST still be listed

---

### R21: Exit Codes Unchanged

All command exit codes MUST remain identical to their pre-TUI values. The TUI layer MUST NOT alter, suppress, or add new exit codes.

#### Scenario: S21.1 — Review PASSED exit code unchanged

- GIVEN a review completes with status `PASSED`
- WHEN the process exits
- THEN the exit code MUST be `0` (same as pre-TUI)

#### Scenario: S21.2 — Review FAILED exit code unchanged

- GIVEN a review completes with status `FAILED`
- WHEN the process exits
- THEN the exit code MUST be the same non-zero value as pre-TUI behavior

#### Scenario: S21.3 — Validation error exit code unchanged

- GIVEN the user provides invalid arguments (e.g., unknown provider)
- WHEN validation fails
- THEN the exit code MUST be the same non-zero value as pre-TUI behavior

#### Scenario: S21.4 — TUI initialization failure does not change exit behavior

- GIVEN the TUI facade is called but an internal error occurs in a styled output method
- WHEN the error propagates
- THEN the command's exit code logic MUST NOT be affected by TUI-layer errors

---

### R22: ncc Bundle Succeeds with @clack/prompts

The CLI MUST continue to bundle successfully with `ncc` after adding `@clack/prompts` as a dependency. The resulting single-file bundle MUST be functional.

#### Scenario: S22.1 — ncc build produces a working bundle

- GIVEN `@clack/prompts` is added to `apps/cli/package.json` dependencies
- WHEN `ncc build` is run
- THEN the build MUST succeed without errors
- AND the output bundle MUST execute correctly (e.g., `node ncc-out/index.js --help` works)

#### Scenario: S22.2 — Bundle size increase is within budget

- GIVEN the pre-TUI bundle size baseline
- WHEN the bundle is rebuilt with `@clack/prompts` included
- THEN the size increase SHOULD be less than 50KB

---

### R23: --verbose Disables Spinner, Uses log.step

When `--verbose` is active, the spinner MUST NOT be used. Instead, each progress event MUST be rendered as an immediate `tui.log.step()` call, providing real-time line-by-line output for every step of the pipeline.

> Ref: Design AD6 — Verbose mode and spinner are mutually exclusive.

#### Scenario: S23.1 — Verbose mode shows step-by-step progress

- GIVEN the TUI is in `styled` mode
- AND `--verbose` is set
- WHEN `ghagga review .` is run
- THEN no spinner MUST appear
- AND each progress event MUST produce a styled log step line immediately
- AND each step line MUST include a step icon and the event message

#### Scenario: S23.2 — Verbose mode in plain mode

- GIVEN the TUI is in `plain` mode
- AND `--verbose` is set
- WHEN `ghagga review .` is run
- THEN no spinner MUST appear
- AND each progress event MUST produce a plain `console.log` line
- AND each line MUST include the event message

#### Scenario: S23.3 — Verbose produces all progress details

- GIVEN `--verbose` is set
- AND the review pipeline emits progress events with `detail` fields
- WHEN the progress events are displayed
- THEN the detail information MUST be included in the output (unlike non-verbose, which suppresses details)

---

### R24: --verbose and Spinner Are Mutually Exclusive

The system MUST enforce that `--verbose` and the spinner never run simultaneously. When `--verbose` is active, the spinner creation MUST be skipped entirely. This prevents visual corruption from interleaving spinner cursor movements with line-based log output.

> Ref: Design AD6.

#### Scenario: S24.1 — Verbose flag prevents spinner creation

- GIVEN the user runs `ghagga review . -v`
- WHEN the review pipeline starts
- THEN no spinner instance MUST be active
- AND progress events MUST use `tui.log.step()` instead

#### Scenario: S24.2 — Non-verbose mode uses spinner

- GIVEN the user runs `ghagga review .` without `-v`
- AND the TUI is in `styled` mode
- WHEN the review pipeline starts
- THEN a spinner MUST be created and started
- AND progress events MUST update the spinner message

---

### R25: Hooks Command Group Help and Output

> Added by change: cli-git-hooks

The `ghagga hooks` command group and its subcommands (`install`, `uninstall`, `status`) MUST use the TUI facade for all output, consistent with existing CLI commands.

#### Scenario: S25.1 — hooks install success output in styled mode

- GIVEN the TUI is in `styled` mode
- WHEN `ghagga hooks install` completes successfully
- THEN a branded intro MUST be displayed
- AND success messages MUST use `tui.log.success()`
- AND a branded outro MUST be displayed

#### Scenario: S25.2 — hooks install output in plain mode

- GIVEN the TUI is in `plain` mode
- WHEN `ghagga hooks install` completes successfully
- THEN all output MUST be plain text via `console.log`
- AND no ANSI escape sequences MUST be present in the output

#### Scenario: S25.3 — hooks status output in styled mode

- GIVEN the TUI is in `styled` mode
- WHEN `ghagga hooks status` is run
- THEN hook status information MUST be displayed using structured `tui.log.*` methods
- AND installed hooks MUST use `tui.log.success()` indicators
- AND missing hooks MUST use `tui.log.info()` indicators

#### Scenario: S25.4 — hooks uninstall warning for non-GHAGGA hooks

- GIVEN a hook exists that was NOT installed by GHAGGA
- AND the TUI is in `styled` mode
- WHEN `ghagga hooks uninstall` encounters this hook
- THEN `tui.log.warn()` MUST be used to display the skip message

---

### R26: hooks --help Documentation

> Added by change: cli-git-hooks

The `ghagga hooks` command group MUST be visible in `ghagga --help` output, and each subcommand MUST provide descriptive help text.

#### Scenario: S26.1 — hooks appears in top-level help

- GIVEN the user runs `ghagga --help`
- WHEN the help text is displayed
- THEN the output MUST include `hooks` as an available command with a description

#### Scenario: S26.2 — hooks install --help shows all options

- GIVEN the user runs `ghagga hooks install --help`
- WHEN the help text is displayed
- THEN the output MUST document `--quick`, `--no-pre-commit`, `--no-commit-msg`, and `--force` options

---

## Cross-Cutting Concerns

### CC1: Facade Encapsulation

No command file SHALL import `@clack/prompts` or `picocolors` directly. All output MUST go through the TUI facade (`ui/tui.ts`) and formatting functions (`ui/format.ts`). This ensures the presentation library is swappable without modifying command files.

> Ref: Design AD1 — TUI Facade Pattern.

### CC2: Formatting Function Purity

All format functions in `ui/format.ts` MUST be pure functions: deterministic output for a given input, no side effects, no I/O. They produce strings; the TUI facade handles where those strings go.

> Ref: Design AD4 — Formatting logic location.

### CC3: Theme Centralization

All visual constants (icons, emojis, colors, labels) MUST be defined in `ui/theme.ts`. Command files MUST NOT define inline emoji/icon maps or ANSI color codes.

### CC4: Backward Compatibility of Format Utilities

Functions moved from `memory/utils.ts` to `ui/format.ts` (`formatTable`, `formatSize`, `formatId`, `truncate`) MUST be re-exported from `memory/utils.ts` to preserve existing import paths. Existing tests that import from `memory/utils.ts` MUST continue to pass without modification.

### CC5: Existing Test Suite Compatibility

All 124 existing tests MUST pass without modification after the TUI change. This is guaranteed by:
1. Tests run in non-TTY mode (test runners don't allocate a real TTY) -> TUI auto-selects plain mode
2. Plain mode delegates to `console.log`/`console.error` -> existing `vi.spyOn(console, 'log')` assertions remain valid
3. Format functions maintain identical signatures and output

## Invariants

- The TUI mode is determined exactly once per process and never changes.
- In plain mode, the TUI facade is a transparent pass-through to `console.log`/`console.error` with zero ANSI escape sequences.
- No command logic, exit code, or argument parsing behavior is altered by the TUI layer. The change is purely presentational.
- `--format json` on the review command always produces raw, parseable JSON on stdout, regardless of TUI mode.
- Commands never import `@clack/prompts` directly; all access is through the `ui/tui.ts` facade.
- Format functions are pure: same input always produces same output, no side effects.

---

## Tool Configuration Flags (Added by `extensible-static-analysis`, 2026-03-08)

### R27: --disable-tool Flag

The `ghagga review` command MUST accept a `--disable-tool <name>` option that disables a specific tool by name. The flag MUST be repeatable to disable multiple tools.

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

- GIVEN the user disables all 7 always-on tools via repeated `--disable-tool` flags
- WHEN the review pipeline executes
- THEN no static analysis tools MUST run
- AND if AI review is enabled, the LLM pipeline MUST still execute without static analysis context

### R28: --enable-tool Flag

The `ghagga review` command MUST accept an `--enable-tool <name>` option that force-enables a specific tool, overriding auto-detect. The flag MUST be repeatable.

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

### R29: --list-tools Flag

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

### R30: Deprecated Tool Flags (Modified)

The existing `--no-semgrep`, `--no-trivy`, `--no-cpd` flags MUST be preserved as deprecated aliases.

> **Previously**: These were the only way to disable individual tools.

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

### R31: ReviewOptions Interface Update (Modified)

The `ReviewOptions` interface MUST include:
- `disableTools: string[]` (from `--disable-tool`)
- `enableTools: string[]` (from `--enable-tool`)

The old `semgrep`, `trivy`, `cpd` boolean fields MUST remain for backward compat.

> **Previously**: `ReviewOptions` had `semgrep: boolean`, `trivy: boolean`, `cpd: boolean`

#### Scenario: mergeSettings uses new fields

- GIVEN `ReviewOptions` with `disableTools: ['gitleaks']`
- WHEN `mergeSettings` constructs `ReviewSettings`
- THEN `ReviewSettings.disabledTools` MUST include `'gitleaks'`
- AND `ReviewSettings.enabledTools` MUST include any `--enable-tool` values

### R32: Config File Extension (Modified)

The `.ghagga.json` config file MUST support the new tool fields.

> **Previously**: Config file supported `enableSemgrep`, `enableTrivy`, `enableCpd` only.

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

### R33: Verbose Output Tool Listing (Modified)

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

### R34: CLI Tool Status Output

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
