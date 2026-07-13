# Tasks: CLI Bridge Credentials and Model Selection

**Status**: draft-v2  
**Design**: [design.md](./design.md)  
**Date**: 2026-03-18

## Phase 1 — Core CLI bridge support

1. **Replace legacy CLI adapters with OpenCode-first support**
- Update `packages/core/src/providers/cli-bridge.ts` to remove `codex`, stop advertising direct `claude`, and support only `opencode`, `gemini`, and `copilot`.
- Implement the `claude` → `opencode` runtime alias mapping: when `preferredCLI === 'claude'`, treat it as `opencode` with default `cliModel: 'anthropic/claude-sonnet-4-5'` (unless `cliModel` is already set). This ensures existing `model: 'claude'` entries in JSONB continue working without manual reconfiguration.
- Add the OpenCode command builder and stdin-based execution path for `opencode run --model <provider/model> --format json` while preserving legacy `auto` retry behavior.
  - Parse the `--format json` output: newline-delimited JSON events. Extract `text` events for the LLM response content, and `step_finish` events for token usage metadata.
- Centralize CLI availability detection and fallback ordering so later validation and pipeline work reuse the same tool list. The auto-detect order is `opencode → copilot → gemini` (OpenCode first as the most capable tool, Copilot second, Gemini last).

2. **Extend CLI bridge runtime contract for explicit models and credentials**
- Change `generateViaCLI()` in `packages/core/src/providers/cli-bridge.ts` to accept an options object with `preferredCLI`, optional `cliModel`, and optional injected credentials.
- Add explicit env-var mapping helpers for OpenCode provider prefixes such as `anthropic`, `openai`, `google`, `github-copilot`, `groq`, and `openrouter`.
- Make configuration failures actionable by distinguishing malformed `cliModel`, unsupported prefixes, and missing credentials from retryable CLI failures.

3. **Pass decrypted CLI credentials into the review pipeline safely**
- Update `packages/core/src/pipeline.ts` to read `cliModel` and `encryptedApiKey` from the selected `cli-bridge` entry, decrypt when needed, and pass only the required credential env var into `generateViaCLI()`.
- Build a minimal child-process environment in `packages/core/src/providers/cli-bridge.ts` so subprocesses receive only baseline runtime vars plus the single selected secret.
- Preserve server-env fallback for Gemini, Copilot, and OpenCode when no installation credential is stored.

## Phase 2 — Data and API wiring

4. **Add optional `cliModel` across persisted and shared provider-chain types**
- Update `packages/db/src/schema.ts` to add `cliModel?: string` to `DbProviderChainEntry`.
- Update `packages/core/src/types.ts` to add `cliModel?: string` to `ProviderChainEntry`.
- Update `packages/types/src/api.ts` to add `cliModel?: string` to **both** `ProviderChainView` AND `ProviderChainUpdate` interfaces. Both must be updated for the dashboard to read and write `cliModel` correctly.
- Keep `encryptedApiKey` semantics unchanged so CLI Bridge still uses the entry-level secret slot rather than introducing a new column or provider-specific storage key.
- Note dependency: complete before route handlers and dashboard save/load work.

5. **Wire `cliModel` through settings and installations read/write flows**
- Update `apps/server/src/routes/api/settings.ts` and `apps/server/src/routes/api/installations.ts` to accept, preserve, clear, and persist `cliModel` on `cli-bridge` entries.
- Reuse existing encryption and merge logic so CLI Bridge keys survive partial updates and blank saves the same way API-provider keys do.
- Preserve backward compatibility for legacy entries with `model: 'auto'` and no `cliModel` during both GET and PUT flows.

6. **Expose `cliModel` and masked CLI credentials in API views**
- Update `apps/server/src/routes/api/utils.ts` so `buildProviderChainView()` includes `cliModel` while continuing to expose only `hasApiKey` and `maskedApiKey` for secrets.
- Ensure repo settings and installation settings responses stay symmetric for CLI Bridge entries.
- Verify older rows without `cliModel` serialize cleanly with null-equivalent behavior.

7. **Upgrade CLI Bridge validation metadata for the dashboard**
- Update BOTH `apps/server/src/routes/api/settings.ts` (the short-circuit at line ~610-614) AND `apps/server/src/lib/provider-models.ts` (line ~94-96) so `POST /api/providers/validate` returns detected CLI tools, curated OpenCode model suggestions, and tool metadata alongside backward-compatible `models` output. The short-circuit in `settings.ts` must either be removed (so it falls through to the updated `provider-models` logic) or must be updated to return the new structured response.
- Validate OpenCode `cliModel` strings against `provider/model` format and reject unsupported provider prefixes before save or execution.
- Keep Gemini and Copilot validation explicit about their limited model behavior and availability when OpenCode is missing.

## Phase 3 — Dashboard UX

8. **Extend settings-page state for `cliModel` loading and saving**
- If `apps/dashboard/src/lib/types.ts` simply re-exports from `@ghagga/types`, no change is needed there — the actual type change is in `packages/types/src/api.ts` (covered by Task 4).
- Focus on settings page state initializers: update `apps/dashboard/src/pages/Settings.tsx` and `apps/dashboard/src/pages/GlobalSettings.tsx` to load `cliModel` from `ProviderChainView` API responses and include it in `ProviderChainUpdate` on save.
- Ensure the local provider-chain state in both pages correctly initializes and persists `cliModel` for CLI Bridge entries.
- Note dependency: requires Phase 2 API contracts to be defined first.

9. **Redesign `ProviderEntry.tsx` for CLI tool and model selection**
- Update `apps/dashboard/src/components/settings/ProviderEntry.tsx` so CLI Bridge shows a CLI tool selector (`auto`, `opencode`, `gemini`, `copilot`) separate from the OpenCode `cliModel` input.
- Add OpenCode model suggestions and contextual help text without conflating CLI tool ids with actual model ids.
- Remove the old “No API key needed” banner and replace it with tool-aware credential guidance.
  - The dashboard MUST require `cliModel` when `opencode` is selected as the CLI tool and MUST NOT allow saving an OpenCode configuration without specifying a model.

10. **Add CLI credential inputs and adaptive UX rules**
- In `apps/dashboard/src/components/settings/ProviderEntry.tsx`, show masked credential input for OpenCode, Gemini, and Copilot using the same create/replace/clear pattern as other providers.
- Derive the credential label from the selected tool and OpenCode provider prefix when possible, falling back to a generic provider-key label until the model is specific enough.
- Keep `cliModel` optional for legacy `auto` flows and avoid requiring OpenCode-specific fields for Gemini or Copilot selections.

## Phase 4 — Validation and hardening

11. **Add targeted tests for core and server compatibility rules**
- Add or update tests around `packages/core/src/providers/cli-bridge.ts`, `packages/core/src/pipeline.ts`, `apps/server/src/routes/api/settings.ts`, `apps/server/src/routes/api/installations.ts`, and `apps/server/src/routes/api/utils.ts`.
- Cover OpenCode env-var injection, `cliModel` round-tripping, encrypted-key preservation, legacy `auto` entries, and Gemini/Copilot fallback when OpenCode is unavailable.
- Include negative cases for malformed `cliModel`, unsupported provider prefixes, and missing user/server credentials.

12. **Harden credential handling and log redaction**
- Audit `packages/core/src/providers/cli-bridge.ts` and related server logging paths to ensure decrypted credentials are never emitted in stderr summaries, validation responses, or debug logs.
- Add redaction or sanitization for known token patterns and avoid logging child-process env objects.
- Confirm the minimal subprocess environment still preserves required baseline vars such as `PATH` while withholding unrelated secrets.

## Phase 5 — Verification

13. **Run automated verification for affected packages**
- Run the relevant `pnpm` test, typecheck, and lint targets for `packages/core`, `packages/db`, `packages/types`, `apps/server`, and `apps/dashboard` after implementation completes.
- Verify the updated validation contract and dashboard compile cleanly against the shared `cliModel` types.
- Record any remaining operational follow-up needed for OpenCode installation assumptions.

14. **Perform manual CLI Bridge regression checks**
- Verify a new OpenCode configuration can save `cliModel`, mask its credential, and execute with the correct runtime env var mapping.
- Verify legacy `cli-bridge` entries with `model: 'auto'` still run unchanged and that Gemini/Copilot remain selectable and functional as fallback tools.
  - Verify model name tests use exact model versions (e.g., `anthropic/claude-sonnet-4-5`, not `anthropic/claude-sonnet-4`) since OpenCode requires exact names from its model registry.
- Verify failure paths are actionable and that logs, validation responses, and UI status messages do not leak credentials.
