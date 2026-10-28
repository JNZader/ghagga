# Proposal: AI SDK v5 Migration

**Change ID:** ai-sdk-v5-migration
**Status:** proposed
**Date:** 2026-03-07

## Intent

Migrate GHAGGA from AI SDK v4 (`ai@^4.3.0`) to AI SDK v5 (`ai@5.x`), which also
enables upgrading all `@ai-sdk/*` provider packages to their v5-compatible
versions and `zod` from v3 to v4.

## Why

1. **Unblock provider upgrades**: `@ai-sdk/google` v3 (needed for Gemini 2.5
   models and latest features) requires AI SDK v5. Same for `@ai-sdk/anthropic`
   and `@ai-sdk/openai` v2.
2. **Zod 4 is now a peer dependency**: AI SDK v5 requires `zod@^4.1.8`. This
   is a hard requirement, not optional.
3. **Stay on supported versions**: AI SDK v4 is no longer the current stable
   release. v5 is the current stable (v6 is beta). Staying on v4 means
   accumulating migration debt.
4. **Access latest model support**: Newer provider packages include support for
   the latest models and features from each provider.

## Scope

### In Scope

- **`packages/core/package.json`**: Update `ai`, `@ai-sdk/anthropic`,
  `@ai-sdk/google`, `@ai-sdk/openai`, and `zod` versions.
- **`apps/server/package.json`**: Update `zod` version.
- **`packages/core/src/providers/index.ts`**: Fix any breaking changes to
  provider factory functions and the `LanguageModel` type import.
- **`packages/core/src/providers/fallback.ts`**: Fix `generateText()` API
  changes (usage property changes).
- **`packages/core/src/agents/simple.ts`**: Fix `generateText()` API changes.
- **`packages/core/src/agents/consensus.ts`**: Fix `generateText()` API changes.
- **`packages/core/src/agents/workflow.ts`**: Fix `generateText()` API changes.
- **`packages/core/src/providers/fallback.test.ts`**: Update mocks/assertions
  for any changed APIs.
- **`packages/core/src/agents/workflow.test.ts`**: Update mocks/assertions.
- **`packages/core/src/agents/consensus-review.test.ts`**: Update mocks/assertions.
- **`apps/server/src/routes/api/settings.ts`**: Adapt zod usage if v4 has
  breaking changes.
- **`pnpm-lock.yaml`**: Regenerate after dependency updates.

### Out of Scope

- UI/frontend changes (GHAGGA does not use `useChat` or any AI SDK UI hooks).
- AI SDK RSC or streaming UI features (not used).
- Tool definitions (GHAGGA does not define any AI SDK tools).
- `streamText()` (not used — only `generateText()`).
- Migration to AI SDK v6 (currently beta, not targeted).

## Approach

This is a dependency upgrade, not an architecture change. The approach is:
1. Update `package.json` files with new version constraints.
2. Run `pnpm install` to resolve and lock new versions.
3. Apply breaking API changes file by file (see spec for details).
4. Run `pnpm typecheck` to catch remaining type errors.
5. Run `pnpm test` to verify behavior is preserved.
6. Manual smoke test with a real API call if feasible.

## Risk Assessment

| Risk                                                   | Likelihood           | Impact | Mitigation                                                                                   |
| ------------------------------------------------------ | -------------------- | ------ | -------------------------------------------------------------------------------------------- |
| `generateText()` API breakage                          | **High** (confirmed) | Low    | Well-documented migration path; our usage is simple                                          |
| `LanguageModel` type rename/move                       | **Medium**           | Low    | Check if type still exists or was renamed                                                    |
| Provider factory API changes (`createAnthropic`, etc.) | **Low**              | Medium | v5 docs show same factory pattern still works                                                |
| `result.usage` property changes                        | **High** (confirmed) | Low    | `usage` now has `totalUsage` vs per-step `usage`; our single-call usage should be unaffected |
| Zod v4 breaking changes                                | **Low**              | Low    | Our zod usage is basic (simple object schemas with `.safeParse()`)                           |
| Test mocks breaking                                    | **Medium**           | Low    | Mocks use `as any` casts; may need minor adjustments                                         |
| Model behavior changes                                 | **None**             | N/A    | API calls are identical; models are server-side                                              |

## Affected Modules

- `packages/core` — All AI SDK usage (providers, agents, fallback)
- `apps/server` — Zod usage only

## Distribution Mode Impact

- **SaaS**: No impact beyond the code changes — same API surface.
- **GitHub Action**: No impact — uses `packages/core` as a dependency.
- **CLI**: No impact — uses `packages/core` as a dependency.
- **1-click deploy**: No impact — uses Docker image which will rebuild.

## Rollback Plan

1. Revert the version changes in `package.json` files.
2. Run `pnpm install` to restore the lockfile.
3. No data migration is involved, so rollback is clean.

## Acceptance Criteria

- [ ] `ai` package is at `^5.0.0`
- [ ] `@ai-sdk/anthropic` is at `^2.0.0`
- [ ] `@ai-sdk/google` is at `^2.0.0`
- [ ] `@ai-sdk/openai` is at `^2.0.0`
- [ ] `zod` is at `^4.1.8` in both `packages/core` and `apps/server`
- [ ] `pnpm typecheck` passes with zero errors
- [ ] `pnpm test` passes with zero failures
- [ ] No runtime regressions in `generateText()` calls
