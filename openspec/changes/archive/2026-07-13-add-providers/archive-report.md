# Archive Report: Add Providers

**Change**: `add-providers`
**Archive date**: 2026-07-13
**Status**: IMPLEMENTED, THEN SUPERSEDED

## Outcome

Groq, Cerebras, DeepSeek, and OpenRouter were implemented as direct OpenAI-compatible SaaS providers in PR #120 (`27c1c9e`) and documented in PR #121 (`288b33a`). Follow-up fixes refined compatibility and provider/model behavior through PRs #131-#150.

The direct SaaS-provider architecture was later superseded by the centralized Gateway migration (#170) and legacy-provider cleanup (#183-#184). Historical provider names remain only where compatibility, CLI validation, token budgeting, or Gateway routing requires them; they are no longer a durable server-side direct-provider capability.

## Evidence

- Merge: PR #120, `feat(providers): add Groq, Cerebras, DeepSeek, and OpenRouter`
- Documentation: PR #121
- Supersession: Gateway integration PR #170; legacy cleanup PRs #183-#184
- Current code still recognizes the names in compatibility and routing surfaces, but the direct provider factory described by this change is not the current architecture.

## Spec synchronization

No canonical requirement was added. Synchronizing the original direct-provider requirements would make `openspec/specs` contradict the current Gateway-first architecture.

## Historical artifact caveat

`tasks.md` retains unchecked boxes even though the original implementation merged. The archive preserves that historical planning state rather than rewriting it as execution evidence; this report and the cited commits are the closure evidence.
