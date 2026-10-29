# Tasks: Biome Linting & Formatting

> **Change**: biome-linting
> **Spec**: `openspec/changes/biome-linting/spec.md`
> **Design**: Skipped — straightforward tooling setup, no architectural decisions needed.

---

## Phase 1: Setup

- [x] **1.1** Install `@biomejs/biome` as root dev dependency
  - Run `pnpm add -D -w @biomejs/biome`
  - Verify it appears in root `package.json` under `devDependencies`
  - **Satisfies**: R1 prerequisite
  - **Files**: `package.json`, `pnpm-lock.yaml`
  - **Effort**: 5 min
  - **Dependencies**: None

- [x] **1.2** Create `biome.json` at repository root with recommended config
  - Run `pnpm biome init` to scaffold, then edit to match spec:
    - Linter: `recommended` rules enabled
    - Rules: `noUnusedVariables` → `warn`, `noUnusedImports` → `warn`, `noExplicitAny` → `warn`
    - Formatter: `indentStyle: "space"`, `indentWidth: 2`, `lineWidth: 100`
    - JavaScript: `quoteStyle: "single"`, `semicolons: "always"`
    - Files ignore: `["node_modules", "dist", "coverage", ".turbo", ".next", "pnpm-lock.yaml"]`
  - **Satisfies**: R1 (Biome Configuration) — all sub-requirements
  - **Files**: `biome.json` (new)
  - **Effort**: 10 min
  - **Dependencies**: 1.1

- [x] **1.3** Add `lint` and `lint:fix` scripts to root `package.json`
  - Change existing `"lint": "turbo run lint"` to `"lint": "biome check ."`
  - Add `"lint:fix": "biome check --write ."`
  - Keep `"lint:ci"` as an alias if needed for CI, or just use `pnpm lint`
  - **Satisfies**: R2 (Monorepo Lint Scripts) — both scripts
  - **Files**: `package.json`
  - **Effort**: 5 min
  - **Dependencies**: 1.2

- [x] **1.4** Update `turbo.json` pipeline for lint task
  - Modify the existing `lint` task to remove `dependsOn: ["^build"]` (Biome works on source files, no build needed)
  - Set `"cache": false` since biome check is fast and should always run fresh
  - Alternatively: remove `lint` from turbo tasks entirely since `biome check .` at root covers all packages
  - **Satisfies**: R3 (CI Integration) — lint MUST NOT depend on build
  - **Files**: `turbo.json`
  - **Effort**: 5 min
  - **Dependencies**: 1.3

---

## Phase 2: Initial Fix

- [x] **2.1** Run `pnpm lint` to see initial errors and warnings
  - Execute `pnpm lint` and capture the output
  - Categorize issues: formatting vs lint errors vs lint warnings
  - Note how many are auto-fixable vs manual
  - **Satisfies**: R4 prerequisite — assess current state
  - **Files**: None (read-only)
  - **Effort**: 5 min
  - **Dependencies**: 1.4

- [x] **2.2** Run `pnpm lint:fix` to auto-fix all auto-fixable issues
  - Execute `pnpm lint:fix`
  - Review the diff to ensure auto-fixes are sensible (formatting, unused imports removal, etc.)
  - Stage all changes
  - **Satisfies**: R4 (Clean Codebase) — auto-fixable issues
  - **Files**: All `.ts`, `.tsx`, `.json` files across the workspace
  - **Effort**: 10 min
  - **Dependencies**: 2.1

- [x] **2.3** Manually fix remaining lint errors that can't be auto-fixed
  - Run `pnpm lint` again after auto-fix
  - For each remaining error/warning:
    - Fix the code if straightforward
    - Add `// biome-ignore <rule>: <reason>` if suppression is justified
  - Goal: `pnpm lint` exits 0
  - **Satisfies**: R4 (Clean Codebase) — all issues resolved, biome-ignore with justification
  - **Files**: Various source files
  - **Effort**: 30 min
  - **Dependencies**: 2.2

---

## Phase 3: Audit Quick Fixes

- [x] **3.1** Replace `console.error` with `pino` logger in `apps/server/src/routes/oauth.ts`
  - Import the existing `pino` logger (check how other route files import it)
  - Create a child logger: `const logger = parentLogger.child({ module: 'oauth' })`
  - Replace all `console.error(...)` calls with `logger.error(...)` preserving the error context
  - Verify: `grep -r 'console.error' apps/server/src/routes/oauth.ts` returns nothing
  - **Satisfies**: R5a (Logger Instead of console.error) — both scenarios
  - **Files**: `apps/server/src/routes/oauth.ts`
  - **Effort**: 10 min
  - **Dependencies**: None (can run in parallel with Phase 1-2)

- [x] **3.2** Move OAuth Client ID to env var in server
  - Find the hardcoded GitHub Client ID in `apps/server/src/routes/oauth.ts`
  - Replace with `process.env.GITHUB_CLIENT_ID ?? '<current-hardcoded-value>'`
  - Document `GITHUB_CLIENT_ID` in `.env.example` if it exists
  - **Satisfies**: R5b — server reads from env, falls back to hardcoded
  - **Files**: `apps/server/src/routes/oauth.ts`, `.env.example` (if exists)
  - **Effort**: 10 min
  - **Dependencies**: None

- [x] **3.3** Move OAuth Client ID to env var in dashboard
  - Find the hardcoded GitHub Client ID in dashboard source (likely in an auth/login component)
  - Replace with `import.meta.env.VITE_GITHUB_CLIENT_ID ?? '<current-hardcoded-value>'`
  - Document `VITE_GITHUB_CLIENT_ID` in dashboard's `.env.example` if it exists
  - **Satisfies**: R5b — dashboard reads from env, falls back to hardcoded
  - **Files**: `apps/dashboard/src/**/*.ts` or `*.tsx` (auth-related component)
  - **Effort**: 10 min
  - **Dependencies**: None

---

## Phase 4: CI Integration

- [x] **4.1** Add lint step to `.github/workflows/ci.yml`
  - Add a new `lint` job that runs BEFORE the `test` job:

    ```yaml
    lint:
      name: Lint
      runs-on: ubuntu-latest
      steps:
        - uses: actions/checkout@v4
        - uses: actions/setup-node@v4
          with:
            node-version: 22
        - uses: pnpm/action-setup@v4
        - run: pnpm install --frozen-lockfile
        - run: pnpm lint
    ```
  - Add `needs: [check, lint]` to the `test` job (so lint runs in parallel with typecheck/build, and both must pass before tests)
  - **Satisfies**: R3 (CI Integration) — lint before tests, failure blocks merge
  - **Files**: `.github/workflows/ci.yml`
  - **Effort**: 10 min
  - **Dependencies**: 1.3 (lint script must exist)

---

## Phase 5: Verification

- [x] **5.1** Run full lint — must exit 0
  - Execute `pnpm lint`
  - Verify exit code is 0
  - Verify no errors reported (warnings acceptable)
  - **Satisfies**: R4 scenario "Full lint passes on current codebase"
  - **Files**: None (read-only)
  - **Effort**: 5 min
  - **Dependencies**: 2.3, 3.1, 3.2, 3.3

- [x] **5.2** Run full test suite — no regressions
  - Execute `pnpm test`
  - Verify all tests pass
  - Pay attention to OAuth-related tests after the logger and env var changes
  - **Satisfies**: Success criteria — all existing tests pass
  - **Files**: None (read-only)
  - **Effort**: 10 min
  - **Dependencies**: 5.1

- [x] **5.3** Verify CI config is valid
  - Review `.github/workflows/ci.yml` for YAML syntax
  - Verify the `needs` dependency graph is correct (lint and check run in parallel, test depends on both)
  - Optionally run `actionlint` if available
  - **Satisfies**: R3 scenario "CI includes lint step"
  - **Files**: `.github/workflows/ci.yml` (review only)
  - **Effort**: 5 min
  - **Dependencies**: 4.1

---

## Summary

| Phase     | Tasks  | Focus                                      | Spec Requirements |
| --------- | ------ | ------------------------------------------ | ----------------- |
| Phase 1   | 4      | Setup (install, config, scripts, turbo)    | R1, R2            |
| Phase 2   | 3      | Initial Fix (assess, auto-fix, manual fix) | R4                |
| Phase 3   | 3      | Audit Quick Fixes (logger, env vars)       | R5a, R5b          |
| Phase 4   | 1      | CI Integration                             | R3                |
| Phase 5   | 3      | Verification (lint, tests, CI config)      | R4, R3            |
| **Total** | **14** |                                            |                   |

## Dependency Graph

```
1.1 (install biome)
  │
  ▼
1.2 (biome.json) ──────────────────────────────────┐
  │                                                 │
  ▼                                                 │
1.3 (lint scripts)                           3.1 (logger fix)
  │                                          3.2 (env var server)
  ▼                                          3.3 (env var dashboard)
1.4 (turbo.json)                                    │
  │                                                 │
  ▼                                                 │
2.1 (assess) → 2.2 (auto-fix) → 2.3 (manual fix)  │
  │                                      │          │
  │                                      ▼          ▼
  │                                   5.1 (full lint ✓)
  │                                      │
  │                                      ▼
  │                                   5.2 (full test suite ✓)
  │
  ▼
4.1 (CI lint step)
  │
  ▼
5.3 (verify CI config ✓)
```

## Estimated Total Effort

~2-3 hours (suitable for a single implementation session)
