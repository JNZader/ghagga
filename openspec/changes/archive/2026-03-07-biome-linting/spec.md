# Biome Linting & Formatting — Specification

> **Change**: biome-linting
> **Affected domains**: tooling (new), server, dashboard

---

## ADDED Requirements

### Requirement: R1 — Biome Configuration

The project MUST have a `biome.json` configuration file at the repository root that applies to all workspace packages and apps.

The configuration MUST enable Biome's `recommended` linter ruleset.

The following rules MUST be set to `warn` severity (not `error`):
- `noUnusedVariables`
- `noUnusedImports`
- `noExplicitAny`

The formatter MUST be configured with:
- 2-space indentation
- 100-character line width
- Single quotes for strings
- Semicolons always required

The configuration MUST ignore the following directories:
- `node_modules`
- `dist`
- `coverage`
- `.turbo`
- `.next`

The configuration MUST apply to `.ts`, `.tsx`, `.js`, `.jsx`, and `.json` files.

#### Scenario: Biome config exists and is valid

- GIVEN the repository has been set up with Biome
- WHEN a developer runs `npx @biomejs/biome check biome.json`
- THEN the command MUST succeed without configuration errors

#### Scenario: Lint rules apply to TypeScript files

- GIVEN a `.ts` file in `packages/core/src/` contains an unused import
- WHEN the developer runs `pnpm lint`
- THEN Biome MUST report a warning for `noUnusedImports` on that file
- AND the exit code MUST be 0 (warnings don't fail the check)

#### Scenario: Lint rules apply to React TSX files

- GIVEN a `.tsx` file in `apps/dashboard/src/` contains an unused variable
- WHEN the developer runs `pnpm lint`
- THEN Biome MUST report a warning for `noUnusedVariables` on that file

#### Scenario: Ignored directories are not checked

- GIVEN files exist in `packages/core/dist/` and `node_modules/`
- WHEN the developer runs `pnpm lint`
- THEN Biome MUST NOT report any diagnostics for files in those directories

#### Scenario: Formatter enforces configured style

- GIVEN a `.ts` file uses double quotes, 4-space indentation, and lines exceeding 100 characters
- WHEN the developer runs `pnpm lint`
- THEN Biome MUST report formatting diagnostics for quote style, indentation, and line width

---

### Requirement: R2 — Monorepo Lint Scripts

The root `package.json` MUST include a `lint` script that runs Biome's `check` command across the entire workspace.

The root `package.json` MUST include a `lint:fix` script that runs Biome's `check --write` command to auto-fix formatting and auto-fixable lint issues.

The `lint` script MUST exit with a non-zero exit code when lint errors are present.

The `lint` script MUST exit with code 0 when only warnings are present (no errors).

#### Scenario: Lint command works on clean codebase

- GIVEN the codebase has been cleaned up and passes all lint checks
- WHEN the developer runs `pnpm lint`
- THEN the command MUST exit with code 0
- AND the output MUST indicate no errors found

#### Scenario: Lint:fix auto-fixes formatting issues

- GIVEN a file has incorrect formatting (e.g., double quotes instead of single quotes)
- WHEN the developer runs `pnpm lint:fix`
- THEN the file MUST be modified in place with correct formatting
- AND the command MUST exit with code 0

#### Scenario: Lint exits non-zero on errors

- GIVEN a file contains a lint error (not a warning)
- WHEN the developer runs `pnpm lint`
- THEN the command MUST exit with a non-zero exit code
- AND the output MUST list the error with file path and line number

---

### Requirement: R3 — CI Integration

The CI workflow (`.github/workflows/ci.yml`) MUST include a lint step that runs `pnpm lint`.

The lint step MUST run BEFORE the test step in the pipeline so that style issues are caught early (fail-fast).

The lint step MUST NOT depend on the `build` task (Biome works on source files directly).

A lint failure MUST block the PR from merging (same as typecheck and test failures).

#### Scenario: CI includes lint step

- GIVEN a pull request is opened against `main`
- WHEN the CI pipeline runs
- THEN a lint job MUST execute `pnpm lint`
- AND the lint job MUST complete before the test job starts

#### Scenario: Lint failure blocks merge

- GIVEN a pull request introduces a file with lint errors
- WHEN the CI pipeline runs
- THEN the lint job MUST fail
- AND the overall CI status MUST be "failed"
- AND the PR MUST NOT be mergeable (if branch protection is enabled)

#### Scenario: Lint passes on clean code

- GIVEN a pull request with properly formatted and lint-clean code
- WHEN the CI pipeline runs
- THEN the lint job MUST pass
- AND the pipeline MUST proceed to the test step

---

### Requirement: R4 — Clean Codebase

After the initial setup and cleanup, the entire codebase MUST pass `pnpm lint` with exit code 0.

All auto-fixable issues MUST be resolved by running `pnpm lint:fix`.

Any remaining issues that cannot be auto-fixed MUST be manually resolved or suppressed with inline `biome-ignore` comments (with justification).

#### Scenario: Full lint passes on current codebase

- GIVEN the Biome setup and initial cleanup have been completed
- WHEN the developer runs `pnpm lint`
- THEN the command MUST exit with code 0
- AND no lint errors MUST be reported (warnings are acceptable)

#### Scenario: No biome-ignore comments without justification

- GIVEN the codebase contains `biome-ignore` suppression comments
- WHEN reviewing the comments
- THEN each comment MUST include a justification explaining why the rule is suppressed
- AND the format MUST be `// biome-ignore <rule>: <reason>`

---

### Requirement: R5 — Audit Quick Fixes (Bundled)

#### R5a: Logger Instead of console.error in OAuth Route

The `console.error` calls in `apps/server/src/routes/oauth.ts` MUST be replaced with the project's `pino` logger.

The logger instance MUST use a child logger with `{ module: 'oauth' }` context for traceability.

The log level MUST be `error` for error conditions (matching the original `console.error` intent).

#### Scenario: No console.error in oauth.ts

- GIVEN the oauth.ts file has been updated
- WHEN searching for `console.error` in `apps/server/src/routes/oauth.ts`
- THEN zero occurrences MUST be found

#### Scenario: Errors logged with structured logger

- GIVEN an OAuth callback fails (e.g., token exchange error)
- WHEN the error handler executes
- THEN the error MUST be logged via `pino` logger with level `error`
- AND the log entry MUST include the `module: 'oauth'` context

#### R5b: OAuth Client ID from Environment Variable

The GitHub OAuth Client ID in the server MUST be read from the `GITHUB_CLIENT_ID` environment variable.

The GitHub OAuth Client ID in the dashboard MUST be read from the `VITE_GITHUB_CLIENT_ID` environment variable (Vite convention for client-exposed env vars).

Both MUST fall back to the current hardcoded value if the environment variable is not set, ensuring backward compatibility.

#### Scenario: Server reads Client ID from env

- GIVEN the `GITHUB_CLIENT_ID` environment variable is set to `test-client-id`
- WHEN the OAuth flow initiates in the server
- THEN the OAuth authorization URL MUST use `client_id=test-client-id`

#### Scenario: Server falls back to hardcoded Client ID

- GIVEN the `GITHUB_CLIENT_ID` environment variable is NOT set
- WHEN the OAuth flow initiates in the server
- THEN the OAuth authorization URL MUST use the current hardcoded Client ID value

#### Scenario: Dashboard reads Client ID from env

- GIVEN the `VITE_GITHUB_CLIENT_ID` environment variable is set at build time
- WHEN the dashboard renders the GitHub login button
- THEN the OAuth URL MUST use the value from `import.meta.env.VITE_GITHUB_CLIENT_ID`

#### Scenario: Dashboard falls back to hardcoded Client ID

- GIVEN the `VITE_GITHUB_CLIENT_ID` environment variable is NOT set at build time
- WHEN the dashboard renders the GitHub login button
- THEN the OAuth URL MUST use the current hardcoded Client ID value as fallback

---

## Coverage Summary

| Requirement             | Happy Paths                           | Edge Cases                      | Error States                  |
| ----------------------- | ------------------------------------- | ------------------------------- | ----------------------------- |
| R1: Biome Configuration | Config valid, rules apply to .ts/.tsx | Ignored dirs not checked        | Formatter flags violations    |
| R2: Monorepo Scripts    | lint exits 0, lint:fix works          | —                               | lint exits non-zero on errors |
| R3: CI Integration      | lint in CI, passes clean code         | —                               | lint failure blocks merge     |
| R4: Clean Codebase      | Full lint passes                      | biome-ignore with justification | —                             |
| R5a: Logger in OAuth    | Errors logged via pino                | —                               | No console.error remains      |
| R5b: Client ID from env | Reads from env var                    | Falls back to hardcoded value   | —                             |
