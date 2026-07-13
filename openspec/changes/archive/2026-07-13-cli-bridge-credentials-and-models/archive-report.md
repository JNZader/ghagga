# Archive Report: CLI Bridge Credentials and Models

**Change**: `cli-bridge-credentials-and-models`
**Archive date**: 2026-07-13
**Status**: IMPLEMENTED WITH FOLLOW-UPS

## Outcome

PR #162 (`94f616b`) delivered OpenCode-first CLI Bridge selection, explicit `provider/model` configuration, encrypted credential plumbing, allowlisted subprocess environments, server validation, dashboard UX, Docker installation, and broad test coverage. PRs #163-#169 fixed model compatibility and production installation/diagnostic issues. PR #256 later allowed Gemini/Copilot OAuth operation without requiring an injected API key while preserving OpenCode's explicit credential semantics.

## Evidence

- Main implementation: PR #162
- Production follow-ups: PRs #163-#169
- OAuth/fallback hardening: PR #256 (`0d613c3`)
- Runtime contract: `packages/core/src/providers/cli-bridge.ts`
- Pipeline wiring: `packages/core/src/pipeline/providers.ts`
- API validation: `apps/server/src/routes/api/settings.ts`
- Dashboard fields: `apps/dashboard/src/components/settings/provider-fields/`

## Spec synchronization

`openspec/specs/settings/spec.md` now records the durable tool/model shape, OpenCode validation, encrypted credential handling, allowlisted subprocess injection, and reset-on-tool-change behavior.

## Historical artifact caveat

`tasks.md` was authored as phase prose rather than a completed checkbox ledger. This report does not retrofit it; the merged code and follow-up history are the verification record.
