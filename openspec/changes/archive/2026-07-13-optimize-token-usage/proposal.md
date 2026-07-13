# Proposal: Optimize Token Usage for Free-Tier LLM Providers

**Status**: draft  
**Author**: javier  
**Date**: 2026-03-16  

## Intent

Reduce token consumption and request rate in GHAGGA's workflow (5-specialist) and consensus (3-stance) review modes so they work within free-tier provider limits (Groq 8K-12K TPM, Gemini 20 RPM) without sacrificing review quality.

## Motivation

GHAGGA's multi-agent modes fire all LLM calls simultaneously via `Promise.allSettled`, which causes:

| Problem | Impact | Affected Providers |
|---------|--------|--------------------|
| Peak TPM spike (5x diff duplication) | 413 "Request too large" errors | Groq (8K-12K TPM) |
| RPM burst (6 requests at once) | Rate limit exhaustion | Gemini (20 RPM), Groq |
| No fallback wiring | 413 treated as fatal, not retried | All free-tier providers |
| Shared context duplicated 5x | ~4K tokens wasted per workflow review | All providers |

### Token Math Per Review (2K token diff)

| Mode | Calls | Diff duplicated | Total input tokens |
|------|-------|-----------------|--------------------|
| Simple | 1 | 1x | ~3K |
| Consensus | 3 parallel | 3x | ~9K |
| Workflow | 5+1 | 5x + synthesis | ~18-20K |

A workflow review is currently **unusable** with Groq free tier and burns 3x the rate limit budget with Gemini.

## Scope

### In Scope

1. **Sequential batching with configurable concurrency** for workflow and consensus modes
2. **Inter-call delay** for RPM-limited providers
3. **Compact prompts** — deduplicate shared context across specialist calls
4. **Wire `generateWithFallback`** into workflow and consensus modes
5. **Treat 413 as retryable** in the fallback chain (fall back to next provider)
6. **Configuration types** for `reviewConcurrency` and `reviewDelayMs`
7. **Pipeline pass-through** of new config options

### Out of Scope

- Changes to simple mode (already 1 call, works fine)
- Token counting/metering UI
- Provider-specific rate limit detection or adaptive throttling
- Prompt content changes (specialist instructions unchanged, only context deduplication)

## Approach

### 1. Concurrency Limiter (p-limit pattern)

Replace `Promise.allSettled(allSpecialists)` with a concurrency-limited executor:

```typescript
// Instead of: Promise.allSettled(specialists.map(fn))
// Use: pLimit-style batching
const limit = pLimit(concurrency); // default: 2
const results = await Promise.allSettled(specialists.map(s => limit(() => runSpecialist(s))));
```

- **Workflow default**: `concurrency: 2` (2 specialists at a time, 3 batches → 60% less peak TPM)
- **Consensus default**: `concurrency: 1` (sequential, 3 calls one at a time)
- **Configurable**: `reviewConcurrency: 1 | 2 | 3 | 5` via ReviewSettings

### 2. Inter-Batch Delay

Add `reviewDelayMs` (default: 0) applied between concurrency batches:

```typescript
// Between each batch completion, wait reviewDelayMs
await delay(reviewDelayMs);
```

For Gemini: `reviewDelayMs: 1000` → 1 second between calls → stays within 20 RPM.

### 3. Compact Prompts

Currently each specialist gets the full system prompt:
```
[specialist prompt] + [staticContext] + [memoryContext] + [stackHints] + [reviewLevel] + [REVIEW_CALIBRATION]
```

The shared context (`staticContext`, `memoryContext`, `stackHints`, `REVIEW_CALIBRATION`) is ~800-1000 tokens, duplicated 5x = ~4K wasted tokens.

**Optimization**: Create a "compact" system prompt builder that:
- Keeps the full shared context only for the **first specialist call**
- For subsequent specialists, includes only the specialist-specific prompt + a minimal reference: `"Shared context was provided to the first reviewer. Focus only on your specialty."`
- Synthesis call gets full context (it always did)

**Token savings**: ~3-4K tokens per workflow review (from ~18K to ~14K).

### 4. Wire generateWithFallback

Currently `workflow.ts` and `consensus.ts` call `generateTextWithTimeout` directly. They should use `generateWithFallback` so rate-limited or overloaded providers fall back automatically.

This requires refactoring the agent interfaces to accept a `providerChain` instead of a single provider.

### 5. 413 as Retryable

In `fallback.ts`, `isRetryableError()` currently only retries 5xx, timeout, and 429. Adding 413 recognition:

```typescript
// 413 "Request Entity Too Large" — next provider may have higher limits
if (message.includes('413') || message.includes('too large') || message.includes('payload')) {
  return true;
}
```

## Affected Modules

| Package | Files | Change Type |
|---------|-------|-------------|
| `packages/core` | `agents/workflow.ts` | Sequential batching, fallback wiring, compact prompts |
| `packages/core` | `agents/consensus.ts` | Sequential batching, fallback wiring |
| `packages/core` | `agents/prompts.ts` | Compact prompt builder function |
| `packages/core` | `providers/fallback.ts` | 413 retryable, export for agent use |
| `packages/core` | `types.ts` | Add `reviewConcurrency`, `reviewDelayMs` to `ReviewSettings` |
| `packages/core` | `pipeline.ts` | Pass concurrency config through to agents |
| `packages/core` | `utils/concurrency.ts` | New utility: p-limit-style concurrency limiter |

## Distribution Mode Impact

| Mode | Impact |
|------|--------|
| **SaaS** | Full support — config stored in repo settings |
| **CLI** | Full support — `--concurrency 1 --delay 1000` flags |
| **GitHub Action** | Full support — action inputs map to config |
| **1-click deploy** | Full support — env vars follow existing pattern |

## Risks

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|------------|
| Compact prompts degrade quality | Medium | Medium | First specialist always gets full context; synthesis still gets all findings |
| Sequential mode slower | Certain | Low | Default concurrency: 2 (not fully sequential). Speed is a trade-off for free-tier compat |
| p-limit adds a dependency | Low | Low | Implement minimal concurrency limiter inline (~20 lines) instead of importing p-limit |
| Fallback in workflow changes provider mid-review | Low | Low | Acceptable — each specialist call is independent; synthesis merges all outputs |

## Rollback Plan

Fully reversible:
- Default `concurrency: 2, delay: 0` preserves near-original behavior (batched, not fully parallel)
- Setting `concurrency: 5, delay: 0` restores exact original behavior
- Compact prompts behind a flag if quality concerns arise
- No database migration required (settings are JSONB)

## Acceptance Criteria

1. Workflow mode works with Groq free tier (8K TPM) without 413 errors when `concurrency: 1, delay: 500`
2. Consensus mode works with Gemini free tier (20 RPM) when `concurrency: 1, delay: 1000`
3. Default behavior (`concurrency: 2, delay: 0`) completes reviews with no quality difference
4. 413 errors trigger fallback to next provider in chain
5. Token usage per workflow review reduced by ~20% via compact prompts
6. All existing tests pass after changes
7. Simple mode unchanged
8. New config options are backward compatible (defaults match current behavior minus full parallelism)
