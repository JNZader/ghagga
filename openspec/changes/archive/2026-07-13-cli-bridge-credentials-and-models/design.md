# Design: CLI Bridge Credentials and Model Selection

**Status**: draft-v2  
**Proposal**: [proposal.md](./proposal.md)  
**Spec**: [spec.md](./spec.md)  
**Date**: 2026-03-18  

## 1. Architecture Overview

This change keeps the existing provider-chain architecture intact and extends the `cli-bridge` branch of that flow with two new concepts:

1. a persisted CLI tool choice stored in the existing `model` field (`auto`, `opencode`, `gemini`, `copilot`)
2. an optional persisted OpenCode model stored in a new `cliModel` field (`provider/model`)

The implementation spans four layers:

- **DB layer**: `DbProviderChainEntry` gains optional `cliModel?: string`; `encryptedApiKey` continues to store the installation-scoped secret for `cli-bridge` entries.
- **Server/API layer**: settings endpoints read and write `cliModel`, reuse existing encryption/masking logic, and return richer CLI validation metadata for the dashboard.
- **Core pipeline**: `reviewPipeline()` and `runCLIBridgeReview()` resolve the selected CLI tool, decrypt the stored credential, map OpenCode provider prefixes to env vars, and launch a subprocess with a minimal environment.
- **Dashboard**: `ProviderEntry.tsx` splits "CLI tool selection" from "model selection" so OpenCode gets an explicit `provider/model` input while Gemini and Copilot remain simple fallback options.

The execution path remains intentionally narrow:

```text
dashboard settings
  -> PUT settings/installations
  -> provider_chain JSONB persists model + cliModel + encryptedApiKey
  -> review pipeline loads first cli-bridge entry
  -> decrypt credential only for that run
  -> generateViaCLI({ preferredCLI, cliModel, credentials })
  -> OpenCode/Gemini/Copilot subprocess executes
```

The design preserves the current `model: 'auto'` behavior as the compatibility baseline. If no `cliModel` is present, the runtime keeps using the current auto-detect / tool-default path.

## 2. Data Model

### DB JSONB shape

`packages/db/src/schema.ts`

```typescript
export interface DbProviderChainEntry {
  provider: SaaSProvider;
  model: string;
  encryptedApiKey: string | null;
  cliModel?: string;
}
```

Notes:

- `cliModel` is optional and only meaningful when `provider === 'cli-bridge'`.
- No SQL migration is required because `provider_chain` is already JSONB.
- Existing rows remain valid because missing `cliModel` means "legacy behavior".

### Runtime / shared API types

These interfaces should be updated consistently:

- `packages/core/src/types.ts` - add `cliModel?: string` to `ProviderChainEntry`
- `packages/types/src/api.ts` - add `cliModel?: string` to `ProviderChainView` and `ProviderChainUpdate`
- `apps/dashboard/src/components/settings/ProviderEntry.tsx` - add `cliModel?: string` to local component state

### Semantics of stored fields for `cli-bridge`

| Field | Meaning |
|-------|---------|
| `provider` | Always `cli-bridge` |
| `model` | CLI tool selector: `auto`, `opencode`, `gemini`, `copilot` |
| `cliModel` | OpenCode-only explicit model in `provider/model` format |
| `encryptedApiKey` | Encrypted installation credential for the selected CLI tool or OpenCode provider |

`encryptedApiKey` is reused rather than introducing a separate CLI-secret column. This keeps the encryption, masking, copy-to-global, and key-preservation behavior aligned with the rest of the settings system.

## 3. Backend/API Flow

### Request/response contract changes

`apps/server/src/routes/api/settings.ts`, `apps/server/src/routes/api/installations.ts`, and `apps/server/src/routes/api/utils.ts` should treat `cli-bridge` entries like any other provider-chain entry, with two additions:

- accept `cliModel` on `PUT`
- include `cliModel` on `GET`

`buildProviderChainView()` should return:

```typescript
{
  provider,
  model,
  cliModel,
  hasApiKey,
  maskedApiKey,
}
```

### Save flow

For both repo and installation settings:

1. parse `providerChain` entries including optional `cliModel`
2. validate `cliModel` only when `provider === 'cli-bridge' && model === 'opencode'`
3. encrypt `apiKey` when present
4. preserve existing encrypted key when a new key is not supplied
5. persist `cliModel` alongside `provider`, `model`, and `encryptedApiKey`

Key merge logic should remain provider-entry based, but for `cli-bridge` it must preserve the entry-level secret regardless of the underlying OpenCode provider prefix. In other words, the lookup key remains `cli-bridge`, not `anthropic` or `google`.

### Validation endpoint

`POST /api/providers/validate` for `cli-bridge` should stop returning a flat legacy models list and instead return structured metadata the dashboard can render directly.

> **IMPORTANT**: The current implementation has TWO code paths — a short-circuit in `apps/server/src/routes/api/settings.ts` (around line ~610-614) AND the `validateProviderKey` call in `apps/server/src/lib/provider-models.ts` (around line ~94-96). Both must be updated to return the new structured response, or the short-circuit in `settings.ts` must be removed so it falls through to the updated `provider-models` logic.

Recommended response shape:

```typescript
interface ValidationResponse {
  valid: boolean;
  models: string[];
  error?: string;
  detectedCliTools?: Array<'opencode' | 'gemini' | 'copilot'>;
  cliModelSuggestions?: string[];
}
// Note: `supportsExplicitModel` and credential hints can be hardcoded client-side
// since they are static per tool (opencode = true, gemini/copilot = false).
```

Behavior:

- `detectedCliTools` comes from `getAvailableCLIs()` after the adapter list is updated.
- `models` remains populated for backward compatibility; for `cli-bridge` it should contain the detected tool ids plus `auto`.
- `cliModelSuggestions` contains a curated OpenCode list, not a runtime shell-out to `opencode`.
- Tool-specific metadata like `supportsExplicitModel` and `credentialEnvHints` should be hardcoded on the client side since they are static per tool, avoiding over-engineering the validation response.

Curated OpenCode suggestions should live server-side near `CURATED_MODELS` so the dashboard is not the source of truth.

### Validation rules

- `cliModel` required only when the user selects `opencode` and wants explicit model selection.
- Accepted shape: `/^[^/]+\/.+$/`.
- Prefix must map to a supported env var before save or execution.
- Gemini and Copilot reject OpenCode-style `cliModel` input or ignore it on write.

## 4. Core CLI Bridge Flow

### Adapter set

`packages/core/src/providers/cli-bridge.ts` should move from the current `claude/gemini/codex/copilot` list to:

- `opencode`
- `gemini`
- `copilot`

`codex` is removed. `claude` is removed as a first-class adapter but recognized as a **legacy alias**. In `generateViaCLI()`, if `preferredCLI === 'claude'`, map it to `opencode` with default `cliModel: 'anthropic/claude-sonnet-4'` (unless `cliModel` is already explicitly set). This ensures existing `model: 'claude'` entries in JSONB continue working without manual intervention.

### `generateViaCLI()` contract

Replace the positional `preferredCLI` argument with an options object:

```typescript
generateViaCLI(prompt, systemPrompt, {
  preferredCLI?: 'opencode' | 'gemini' | 'copilot';
  cliModel?: string;
  credentials?: Record<string, string>;
})
```

This keeps future CLI-bridge growth manageable and avoids overloading the `model` field with two meanings.

### OpenCode execution

**Verified locally against OpenCode v1.2.27.** Two invocation forms are supported:

Inline message (for short prompts):
```bash
opencode run --model provider/model --format json "Your prompt here"
```

Stdin pipe (for large prompts):
```bash
echo "${prompt}" | opencode run --model provider/model --format json
```

OpenCode auto-detects piped stdin — no trailing `-` is needed.

The `--format json` flag is **required** for GHAGGA to parse the output programmatically. Without it, OpenCode emits formatted terminal output. With `--format json`, the response is newline-delimited JSON where each line is an object with a `type` field:

- `step_start` — marks the beginning of a reasoning step
- `text` — contains the actual LLM response text in `part.text`
- `step_finish` — contains token usage in `part.tokens` and cost in `part.cost`

The adapter should collect all `text` events and concatenate their `part.text` values to reconstruct the full response.

**Model name validation**: Model names must be exact versions, not aliases. For example, `anthropic/claude-sonnet-4-5` works, but `anthropic/claude-sonnet-4` does NOT. On mismatch, OpenCode returns a `ProviderModelNotFoundError` with a helpful `suggestions` array that can be surfaced in GHAGGA's error messages.

Implementation details:

- pass the combined system + user prompt through stdin, matching the large-prompt protection used for Gemini
- always include `--format json` so the adapter can parse structured events
- always prefer explicit `--model ${cliModel}` when `cliModel` is present
- if `preferredCLI === 'opencode'` and no `cliModel` is present, let OpenCode run with its default behavior only for compatibility or manual fallback cases
- inject the API key as an environment variable (e.g., `ANTHROPIC_API_KEY`) rather than managing OpenCode's `~/.local/share/opencode/auth.json` — this is simpler for subprocess invocation

### Credential resolution

`packages/core/src/pipeline.ts` should resolve the selected CLI bridge entry before calling `runCLIBridgeReview()`:

1. read the active `ProviderChainEntry`
2. if `provider !== 'cli-bridge'`, use existing logic unchanged
3. if `provider === 'cli-bridge'`:
   - set `preferredCLI = entry.model !== 'auto' ? entry.model : undefined`
   - read `cliModel = entry.cliModel`
   - decrypt `apiKey` if present
   - derive the credential env var from `preferredCLI` + `cliModel`
   - pass `{ preferredCLI, cliModel, credentials }` into `runCLIBridgeReview()`

### Env-var mapping

The mapping should be explicit and centralized in `cli-bridge.ts`:

```typescript
const OPENCODE_ENV_BY_PREFIX = {
  anthropic: 'ANTHROPIC_API_KEY',
  openai: 'OPENAI_API_KEY',
  google: 'GEMINI_API_KEY',
  'github-copilot': 'GITHUB_TOKEN',
  groq: 'GROQ_API_KEY',
  openrouter: 'OPENROUTER_API_KEY',
};
```

Tool-specific resolution:

- `opencode` -> derive env var from `cliModel` prefix
- `gemini` -> `GEMINI_API_KEY`
- `copilot` -> prefer `COPILOT_GITHUB_TOKEN`, optionally tolerate `GH_TOKEN` as server fallback only

### Fallback behavior

- `model: 'auto'` retries detected CLIs in the order `opencode → copilot → gemini`. OpenCode is tried first because it is the most capable and recommended tool, Copilot second, Gemini last.
- explicit `model: 'opencode' | 'gemini' | 'copilot'` should try that CLI first, then fall back to the remaining detected tools **only for transient/API failures**.

**Configuration failures = hard fail (no fallback)**:
- CLI binary not found on the server
- Malformed `cliModel` (does not match `provider/model` shape)
- Unsupported OpenCode provider prefix (no env-var mapping exists)
- Missing required credential for the selected tool (neither installation nor server env)

**Transient/API failures = may retry other tools**:
- API timeout or rate limit from the upstream provider
- Temporary network errors
- Unexpected CLI exit codes that don't indicate misconfiguration

This distinction prevents misconfiguration from being hidden by silent fallback. If a user explicitly selects OpenCode and their config is wrong, they get an actionable error instead of a surprise fallback to Gemini.

### Subprocess environment

`execSync` should no longer inherit the full server environment by default. Instead of building the env from scratch (which risks breaking CLIs that need `HTTP_PROXY`, `SSL_CERT_FILE`, `NODE_TLS_REJECT_UNAUTHORIZED`, etc.), use a **subtraction approach**:

1. Start with a copy of `process.env`
2. **Remove** known sensitive env vars that belong to other providers: `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `GEMINI_API_KEY`, `GITHUB_TOKEN`, `GH_TOKEN`, `GROQ_API_KEY`, `OPENROUTER_API_KEY`, `COPILOT_GITHUB_TOKEN`, and any other provider-specific secrets
3. **Add** only the single credential env var required for the chosen tool (e.g., `ANTHROPIC_API_KEY` for `opencode` with `anthropic/*` model)

This approach is more robust than an allowlist because CLIs may depend on environment variables for proxy configuration, TLS settings, locale, or other system-level concerns that are difficult to enumerate upfront. The security goal — not leaking other provider secrets to the subprocess — is still met by the explicit removal step.

## 5. Dashboard UX Flow

### State model

`ProviderEntry.tsx` currently uses `entry.model` as the only CLI-bridge control. That is no longer sufficient. The local state should separate:

- `model`: CLI tool selector (`auto`, `opencode`, `gemini`, `copilot`)
- `cliModel`: OpenCode `provider/model` string
- `apiKey`: optional new credential value being typed

### UI behavior

When `provider === 'cli-bridge'`:

1. show **CLI tool** select first
2. if tool is `opencode`, show **Model** text input with datalist suggestions
3. if tool is `opencode`, `gemini`, or `copilot`, show **Credential** input using masked-key reuse behavior
4. show contextual help text describing which secret is expected

**On tool change**: When the user changes the CLI tool selector (e.g., from `opencode` to `gemini`), the component should reset the credential field and clear any previously entered API key from the UI state, since credentials are tool/provider-specific. This prevents accidental reuse of an incompatible credential.

Suggested labels:

- `opencode` + `anthropic/...` -> "Anthropic API Key"
- `opencode` + `google/...` -> "Gemini API Key"
- `gemini` -> "Gemini API Key"
- `copilot` -> "Copilot GitHub Token"

If the OpenCode provider prefix is not yet known because the user has not entered a complete `provider/model`, the UI should show a generic label such as "Provider API Key" and a helper explaining the expected `provider/model` format.

### Validation UX

The validate action should call `POST /api/providers/validate` with `provider: 'cli-bridge'` and optional `apiKey` only when the user typed a new credential.

On success the component should update:

- `availableModels` for the CLI tool selector from `detectedCliTools`
- OpenCode datalist suggestions from `cliModelSuggestions`
- validation status and warnings when OpenCode is unavailable

`KNOWN_MODELS['cli-bridge']` should stop pretending CLI tool ids are model ids. Instead, keep local fallback constants split into:

- `KNOWN_CLI_TOOLS`
- `KNOWN_OPENCODE_MODELS`

This avoids conflating tool choice with model choice.

### Page save/load wiring

`apps/dashboard/src/pages/Settings.tsx` and `apps/dashboard/src/pages/GlobalSettings.tsx` should:

- read `cliModel` from `ProviderChainView`
- initialize local provider-chain state with it
- include `cliModel` in `ProviderChainUpdate` on save

This ensures repo-level and installation-level flows stay symmetric.

## 6. Validation Strategy

Validation is split into three layers.

### API request validation

- reject unknown CLI tool values in `model`
- reject `cliModel` when `provider !== 'cli-bridge'`
- reject malformed OpenCode model strings before persistence
- reject unsupported OpenCode provider prefixes

### Runtime validation

- if selected CLI binary is not installed, fail with `CLI '<name>' is not available on this server`
- if `opencode` is selected without a usable `cliModel` for explicit-model mode, fail clearly
- if no user credential exists and no compatible server env var exists, fail with the required env var name

### Test coverage

Key tests should cover:

- `DbProviderChainEntry` round-trip with and without `cliModel`
- `buildProviderChainView()` exposes `cliModel` but never raw credentials
- settings/installations `PUT` preserve existing encrypted CLI keys while updating `cliModel`
- `POST /api/providers/validate` returns detected CLIs and curated OpenCode suggestions
- `generateViaCLI()` injects the right env var for `anthropic/*`, `openai/*`, and `google/*`
- legacy `model: 'auto'` + no `cliModel` path still uses current auto behavior
- explicit Gemini and Copilot configurations still execute without OpenCode installed

## 7. Security Considerations

- **Encryption at rest**: CLI credentials continue to use existing `encrypt()` / `decrypt()` flows through `encryptedApiKey`.
- **Least-privilege env injection**: only the one required credential env var is passed to the child process.
- **No secret logging**: error truncation in `cli-bridge.ts` remains, but add redaction for known token patterns and avoid logging the child env object.
- **No secret echo in validation**: validation responses return only availability metadata, curated suggestions, and masked-key state.
- **No unnecessary persistence**: decrypted credentials exist only in request memory during execution.
- **Controlled fallback**: server env fallback remains supported, but only for the matching env var for the chosen CLI/tool combination.

For OpenCode specifically, do not inject multiple possible provider env vars "just in case". The selected `cliModel` determines the only provider secret exposed to the subprocess.

## 8. Backward Compatibility

Compatibility is preserved by keeping current meanings intact where already deployed:

- existing `provider: 'cli-bridge', model: 'auto'` entries with no `cliModel` continue unchanged
- existing `provider: 'cli-bridge', model: 'claude'` entries are treated as `opencode` at runtime with default `cliModel: 'anthropic/claude-sonnet-4'`, so they continue working without manual reconfiguration
- missing `cliModel` remains valid in DB, API, and dashboard state
- GET endpoints can omit `cliModel` for old rows without breaking clients
- PUT endpoints accept payloads without `cliModel`
- server env credentials still work for Gemini and Copilot, and for OpenCode when the mapped env var exists

The only intentional behavior change is that newly validated CLI metadata surfaces `opencode` as the primary recommended tool and stops advertising deprecated `codex`.

## 9. Migration / Rollout Plan

### Phase A: Core and server support

1. add `cliModel` to DB/core/shared types
2. update settings/installations GET and PUT flows
3. add structured CLI validation response
4. add OpenCode adapter and remove codex

At the end of this phase, existing installs still work and the API is ready for the new dashboard.

### Phase B: Dashboard support

1. update `ProviderEntry.tsx` state and rendering
2. update settings pages to persist `cliModel`
3. replace the old "No API key needed" CLI Bridge banner with contextual credential guidance

### Phase C: Operational rollout

1. install `opencode` in deployment images / docs
2. verify `POST /api/providers/validate` reports it in production
3. monitor logs for CLI availability and unsupported-provider errors

No data migration or backfill is required. Rollback is also simple: old rows still deserialize because `cliModel` is optional.

## 10. Open Questions / Assumptions

### Assumptions

- OpenCode supports non-interactive stdin-driven `run` invocations with `--model provider/model` in the deployed version.
- The first provider-chain entry remains the only CLI-bridge entry used in simple mode, matching current pipeline behavior.
- `copilot` continues to work with a token passed through environment variables and does not require interactive device login in the server environment.

### Open questions

1. **OpenCode command shape** — **RESOLVED**. Verified locally against OpenCode v1.2.27. Both inline (`opencode run --model provider/model --format json "prompt"`) and stdin pipe (`echo "prompt" | opencode run --model provider/model --format json`) work. Stdin is auto-detected — no trailing `-` needed. The `--format json` flag produces newline-delimited JSON events (`step_start`, `text`, `step_finish`); the `text` events contain the LLM response in `part.text`. Model names must be exact (e.g., `anthropic/claude-sonnet-4-5`, not `anthropic/claude-sonnet-4`).
2. **Copilot env name**: standardize whether GHAGGA should inject `COPILOT_GITHUB_TOKEN`, `GH_TOKEN`, or both; the proposal prefers `COPILOT_GITHUB_TOKEN`, but the current ecosystem often uses `GH_TOKEN`.
3. **OpenCode curated catalog size**: decide the initial approved list so validation stays useful without becoming a full provider mirror. Verified providers from `opencode models` (68 models total): `opencode/*` (free tier), `opencode-go/*` (subscription), `anthropic/*` (claude-sonnet-4-5, claude-opus-4-6, etc.), `github-copilot/*` (claude-sonnet-4, gpt-5, gemini-2.5-pro, etc.), `openai/*` (gpt-5-codex, codex-mini-latest, etc.). Additional providers may be available via `opencode auth login`. The curated catalog should start with `anthropic/*`, `openai/*`, and `github-copilot/*` as the most relevant for GHAGGA's code review use case.
4. **Auto fallback ordering** — **RESOLVED**. When `model: 'auto'`, the fallback order is `opencode → copilot → gemini`. OpenCode is tried first because it is the most capable and recommended tool. Copilot second. Gemini last. OpenCode can detect its own available models at runtime via `opencode models` (or `opencode models <provider>` to filter by provider), so the auto-detect flow could query this to determine model availability before attempting a review.
5. **UI save rule** — **RESOLVED**. `cliModel` is REQUIRED when the user selects `opencode` as the CLI tool. The dashboard must not allow saving an OpenCode configuration without specifying a model. This ensures explicit model control and avoids ambiguity. If `cliModel` is absent, existing `auto` behavior or tool-default behavior remains unchanged for backward compatibility.
