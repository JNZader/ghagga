# Spec: AI SDK v5 Migration

**Change ID:** ai-sdk-v5-migration
**Status:** specified
**Date:** 2026-03-07

## Overview

This spec documents every breaking change from AI SDK v4 → v5 that affects
GHAGGA's codebase, with exact file locations and before/after code examples.

---

## 1. Package Version Requirements

### R-PKG-01: AI SDK core package

The `ai` package MUST be updated from `^4.3.0` to `^5.0.0`.

**File:** `packages/core/package.json:57`

```jsonc
// BEFORE
"ai": "^4.3.0"

// AFTER
"ai": "^5.0.0"
```

### R-PKG-02: Provider packages

All `@ai-sdk/*` provider packages MUST be updated to `^2.0.0`.

**File:** `packages/core/package.json:54-56`

```jsonc
// BEFORE
"@ai-sdk/anthropic": "^1.2.0",
"@ai-sdk/google": "^1.2.0",
"@ai-sdk/openai": "^1.3.0",

// AFTER
"@ai-sdk/anthropic": "^2.0.0",
"@ai-sdk/google": "^2.0.0",
"@ai-sdk/openai": "^2.0.0",
```

### R-PKG-03: Zod peer dependency

`zod` MUST be updated to `^4.1.8` in all packages that use it.

**File:** `packages/core/package.json:60`

```jsonc
// BEFORE
"zod": "^3.24.0"

// AFTER
"zod": "^4.1.8"
```

**File:** `apps/server/package.json:28`

```jsonc
// BEFORE
"zod": "^3.24.0"

// AFTER
"zod": "^4.1.8"
```

---

## 2. Breaking Changes That Affect GHAGGA

### 2.1 `LanguageModel` Type Import

**Impact:** The `LanguageModel` type is still exported from `ai` in v5. No
change required. The import `import type { LanguageModel } from 'ai'` continues
to work.

**Verification needed:** Confirm at typecheck time.

**File:** `packages/core/src/providers/index.ts:23`
```typescript
// NO CHANGE REQUIRED
import type { LanguageModel } from 'ai';
```

### 2.2 `generateText()` API Changes

#### 2.2.1 `maxTokens` → `maxOutputTokens`

**Impact on GHAGGA:** **None.** GHAGGA does not use `maxTokens` in any
`generateText()` call. All calls use only `model`, `system`, `prompt`, and
`temperature`.

Verified in:
- `packages/core/src/agents/simple.ts:175-180` — no `maxTokens`
- `packages/core/src/agents/consensus.ts:220-225` — no `maxTokens`
- `packages/core/src/agents/workflow.ts:113-118` and `178-183` — no `maxTokens`
- `packages/core/src/providers/fallback.ts:109-114` — no `maxTokens`

#### 2.2.2 `result.usage` Property

**Impact on GHAGGA:** **Investigate.** In v5, `result.usage` contains token
usage from the **final step only**, while `result.totalUsage` contains the
aggregate. However, GHAGGA only uses single-step `generateText()` (no tools, no
`maxSteps`/`stopWhen`), so `result.usage` will contain the same values as in v4.

The current access pattern is:

```typescript
// Used in all agents and fallback
const tokensUsed = (result.usage?.promptTokens ?? 0) + (result.usage?.completionTokens ?? 0);
```

**Requirement R-USAGE-01:** This pattern MUST continue to work. Since we use
single-step generation, `result.usage` will contain the step-level usage which
equals the total. No code change required, but this SHOULD be verified in tests.

**Files affected (verification only):**
- `packages/core/src/agents/simple.ts:183`
- `packages/core/src/agents/consensus.ts:227`
- `packages/core/src/agents/workflow.ts:124` and `186`
- `packages/core/src/providers/fallback.ts:117`

#### 2.2.3 `providerMetadata` → `providerOptions` (input parameter)

**Impact on GHAGGA:** **None.** GHAGGA does not use `providerMetadata` or
`providerOptions` in any `generateText()` call.

### 2.3 Provider Factory Functions

#### R-PROV-01: `createAnthropic`, `createGoogleGenerativeAI`, `createOpenAI`

**Impact on GHAGGA:** These factory functions SHOULD still accept the same
configuration objects (`{ apiKey }`, `{ apiKey, baseURL, name }`) in v5.

**File:** `packages/core/src/providers/index.ts:20-22` and `47-78`

```typescript
// NO CODE CHANGE EXPECTED — verify at typecheck
import { createAnthropic } from '@ai-sdk/anthropic';
import { createGoogleGenerativeAI } from '@ai-sdk/google';
import { createOpenAI } from '@ai-sdk/openai';
```

The factory call patterns used:
- `createAnthropic({ apiKey })` — standard
- `createOpenAI({ apiKey })` — standard
- `createGoogleGenerativeAI({ apiKey })` — standard
- `createOpenAI({ apiKey, baseURL, name })` — for GitHub, Ollama, Qwen

These MUST be verified to still work with `@ai-sdk/*@^2.0.0`.

### 2.4 `CoreMessage` → `ModelMessage` Rename

**Impact on GHAGGA:** **None.** GHAGGA does not import or use `CoreMessage`.
All message handling is done via simple `system` + `prompt` strings passed to
`generateText()`, not via message arrays.

### 2.5 Tool Definition Changes (`parameters` → `inputSchema`)

**Impact on GHAGGA:** **None.** GHAGGA does not define any AI SDK tools.

### 2.6 `Message` → `UIMessage`, `useChat` Changes

**Impact on GHAGGA:** **None.** GHAGGA does not use the AI SDK UI layer. No
React hooks, no `useChat`, no `Message` type.

### 2.7 `StreamData` Removal

**Impact on GHAGGA:** **None.** GHAGGA does not use `StreamData`.

### 2.8 `maxSteps` → `stopWhen`

**Impact on GHAGGA:** **None.** GHAGGA does not use `maxSteps`.

---

## 3. Zod v3 → v4 Breaking Changes

### 3.1 Basic Schema API

**Impact on GHAGGA:** Zod v4 is largely backward-compatible for basic usage.
The patterns used in GHAGGA (`z.object()`, `z.boolean()`, `z.string()`,
`z.enum()`, `z.union()`, `z.array()`, `.optional()`, `.strict()`,
`.safeParse()`) are all preserved in Zod v4.

**File:** `apps/server/src/routes/api/settings.ts:17,24-35,143-155`

```typescript
// CURRENT CODE — should work unchanged with Zod v4
import { z } from 'zod';

const RepoSettingsSchema = z
  .object({
    enableSemgrep: z.boolean().optional(),
    enableTrivy: z.boolean().optional(),
    enableCpd: z.boolean().optional(),
    enableMemory: z.boolean().optional(),
    aiReviewEnabled: z.boolean().optional(),
    reviewLevel: z.enum(['soft', 'normal', 'strict']).optional(),
    customRules: z.union([z.string(), z.array(z.string())]).optional(),
    ignorePatterns: z.array(z.string()).optional(),
  })
  .strict();
```

### R-ZOD-01: Error Format Changes

In Zod v4, `ZodError.issues` is renamed to `ZodError.errors`. However, the
`.issues` property MAY still exist as a compatibility alias.

**File:** `apps/server/src/routes/api/settings.ts:148`

```typescript
// BEFORE (may need change)
details: parsed.error.issues.map((i) => ({
  path: i.path.join('.'),
  message: i.message,
})),

// AFTER (if .issues is removed)
details: parsed.error.errors.map((i) => ({
  path: i.path.join('.'),
  message: i.message,
})),
```

**Action:** Check at typecheck time whether `.issues` still works. If not,
change to `.errors`.

### R-ZOD-02: TypeScript `moduleResolution`

Zod v4 may cause TypeScript performance issues if `moduleResolution` is not set
to `"nodenext"`. The AI SDK migration guide recommends using Zod `^4.1.8` to
avoid this.

**Action:** Verify `tsconfig.base.json` has compatible `moduleResolution`. If
TypeScript becomes slow, update to `"nodenext"`.

---

## 4. Test Impact

### 4.1 Mock Compatibility

All test files mock `ai` with:

```typescript
vi.mock('ai', () => ({
  generateText: vi.fn(),
}));
```

This pattern MUST continue to work since `generateText` is still exported from
`ai` in v5. The mock return values use `as any` casts, so type changes in the
return type won't break mocks.

**Files:**
- `packages/core/src/providers/fallback.test.ts:6-8`
- `packages/core/src/agents/workflow.test.ts:5-7`
- `packages/core/src/agents/consensus-review.test.ts:13-15`

### 4.2 Usage Property in Test Assertions

Tests assert on `result.usage.promptTokens` and `result.usage.completionTokens`
via mock return values. Since the mock returns whatever we provide, and our
production code accesses `result.usage?.promptTokens`, this SHOULD continue to
work without changes.

---

## 5. Scenarios

### S-01: Clean Install After Version Bump

**Given** the package.json files have been updated to v5 versions
**When** `pnpm install` is run
**Then** all packages resolve without conflicts
**And** `pnpm-lock.yaml` is updated

### S-02: TypeScript Compilation

**Given** all breaking API changes have been applied
**When** `pnpm typecheck` is run
**Then** zero type errors are reported

### S-03: Unit Tests Pass

**Given** all code and test changes have been applied
**When** `pnpm test` is run
**Then** all existing tests pass with zero failures

### S-04: generateText Single-Call Usage

**Given** a valid provider/model/apiKey configuration
**When** `generateText({ model, system, prompt, temperature })` is called
**Then** the result has `.text` (string) and `.usage` with
`promptTokens` and `completionTokens` (numbers)
**And** behavior is identical to v4

### S-05: Provider Factory Functions

**Given** v5-compatible provider packages are installed
**When** `createAnthropic({ apiKey })` is called
**And** `createOpenAI({ apiKey, baseURL, name })` is called
**And** `createGoogleGenerativeAI({ apiKey })` is called
**Then** each returns a callable that produces a `LanguageModel`

### S-06: Zod Validation

**Given** Zod v4 is installed
**When** `RepoSettingsSchema.safeParse(data)` is called with valid data
**Then** it returns `{ success: true, data: ... }`
**When** called with invalid data
**Then** it returns `{ success: false, error: ... }` with accessible error details

---

## 6. Summary of Required Code Changes

| File                                      | Line(s)   | Change                                  | Risk |
| ----------------------------------------- | --------- | --------------------------------------- | ---- |
| `packages/core/package.json`              | 54-57, 60 | Bump `ai`, `@ai-sdk/*`, `zod` versions  | Low  |
| `apps/server/package.json`                | 28        | Bump `zod` version                      | Low  |
| `packages/core/src/providers/index.ts`    | —         | **None expected** (verify at typecheck) | Low  |
| `packages/core/src/providers/fallback.ts` | —         | **None expected** (verify at typecheck) | Low  |
| `packages/core/src/agents/simple.ts`      | —         | **None expected** (verify at typecheck) | Low  |
| `packages/core/src/agents/consensus.ts`   | —         | **None expected** (verify at typecheck) | Low  |
| `packages/core/src/agents/workflow.ts`    | —         | **None expected** (verify at typecheck) | Low  |
| `apps/server/src/routes/api/settings.ts`  | 148       | Possibly `.issues` → `.errors` (Zod v4) | Low  |
| Test files                                | —         | **None expected** (verify at test run)  | Low  |

**Key insight:** GHAGGA's usage of the AI SDK is minimal and focused —
`generateText()` with `system` + `prompt` strings, no tools, no streaming, no
UI hooks, no message arrays. The majority of v5 breaking changes (UIMessage,
useChat, tools, streaming) do not apply.

The primary risk is in the provider package upgrades (`@ai-sdk/*@^2.0.0`)
potentially changing factory function signatures, which must be verified at
typecheck time.
