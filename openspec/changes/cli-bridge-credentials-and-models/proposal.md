# Proposal: CLI Bridge Credentials & Model Selection

**Status**: draft-v2  
**Author**: javier  
**Date**: 2026-03-18  

## Intent

Transform the CLI Bridge from a "server-managed, zero-config" integration into a **user-configurable** system where each installation provides its own API credentials and selects which LLM model to use — all from the dashboard. Add **OpenCode** (`opencode-ai`) as the primary CLI tool, giving access to 67+ models across multiple providers through a single binary. Keep Gemini CLI and Copilot CLI as fallback options for users who already rely on them.

### Why Now

The current CLI Bridge works but has two critical limitations:

1. **Shared credentials**: API keys are set as Docker/Coolify env vars on the server. Every installation uses the same keys, meaning the server operator pays for all reviews. Users can't bring their own keys for CLI mode — only for API providers.
2. **No model choice**: The CLI Bridge always uses "auto" (first available CLI). Users who want `anthropic/claude-sonnet-4` via CLI instead of via API have no way to specify that.

OpenCode solves the model problem: it's a single CLI that speaks to 67+ models via `opencode run --model provider/model "prompt"`. Combined with per-installation credentials, this unlocks "BYO-key CLI mode" where users get the cost benefits of CLI tools ($0 platform fees) with the model flexibility of API providers.

## Scope

### In Scope

1. **OpenCode CLI adapter** — New adapter in `cli-bridge.ts` using `opencode run --model <model> "prompt"` with stdin for large prompts
2. **Per-installation credentials for CLI Bridge** — Reuse `encryptedApiKey` in `DbProviderChainEntry`; when `provider === 'cli-bridge'`, the key stores the credential for the underlying provider (e.g., `ANTHROPIC_API_KEY` for `anthropic/claude-sonnet-4-5`)
3. **CLI model selection field** — New optional `cliModel?: string` field in `DbProviderChainEntry` JSONB for the `provider/model` format (e.g., `anthropic/claude-sonnet-4-5`)
4. **Dashboard UI changes** — When CLI Bridge is selected: show CLI tool selector (OpenCode/Gemini/Copilot), model input (for OpenCode), and API key input (per-tool credential)
5. **Credential injection at runtime** — `generateViaCLI()` receives decrypted credentials, sets them as env vars for the subprocess (`ANTHROPIC_API_KEY`, `GEMINI_API_KEY`, etc.)
6. **Credential fallback chain** — Try user's credential first → fall back to server env var → fail with clear error
7. **Remove codex adapter** — Codex CLI is deprecated; remove the dead adapter
8. **Remove `claude` adapter (with runtime alias)** — The `claude` adapter is removed as a first-class CLI tool because OpenCode now covers Anthropic models via `opencode run --model anthropic/...`, making the direct `claude` adapter redundant. Existing `model: 'claude'` entries are handled at runtime as an alias for `opencode` with a default Anthropic model.
9. **Provider validation for CLI Bridge** — Validate endpoint returns available CLIs and, for OpenCode, a curated model list

### Out of Scope

- OpenCode installation automation (users install it on the server manually or via Dockerfile)
- Per-user credentials (scope is per-installation, matching existing pattern)
- Per-repo CLI configuration (inherits from installation, matching existing pattern)
- CLI Bridge support for workflow/consensus modes (remains simple-mode only)
- OpenCode interactive mode or session management (non-interactive `run` only)
- Automatic credential rotation or expiry
- Model pricing/cost estimation in the dashboard

## Approach

### Phase 1: OpenCode Adapter + Credential Plumbing (Backend)

**Goal**: OpenCode works as a CLI adapter with injected credentials, without any dashboard changes.

1. Add `opencode` adapter to `cli-bridge.ts`:
   ```
   opencode run --model <provider/model> --format json "prompt"
   # For large prompts, stdin pipe:
   echo "${prompt}" | opencode run --model <provider/model> --format json
   ```
   - `--format json` produces newline-delimited JSON events that the adapter can parse programmatically
   - Pass prompt via stdin (same pattern as Claude/Gemini) to avoid ARG_MAX
   - Set provider-specific env var (`ANTHROPIC_API_KEY`, etc.) in `execSync` options
   - Parse `cliModel` field to determine which env var to set (e.g., `anthropic/*` → `ANTHROPIC_API_KEY`)

2. Extend `generateViaCLI()` signature to accept credentials and model:
   ```typescript
   generateViaCLI(prompt, systemPrompt, {
     preferredCLI?: string,      // 'opencode' | 'gemini' | 'copilot'
      cliModel?: string,          // 'anthropic/claude-sonnet-4-5' (OpenCode format)
     credentials?: Record<string, string>,  // env vars to inject
   })
   ```

3. Update `runCLIBridgeReview()` in `pipeline.ts` to:
   - Extract `cliModel` and `encryptedApiKey` from the `ProviderChainEntry`
   - Decrypt the API key
   - Map `cliModel` prefix to env var name
   - Pass both to `generateViaCLI()`

4. Remove the `codex` adapter (dead code — Codex CLI is discontinued).

### Phase 2: Schema + API (Data Layer)

**Goal**: Database and API support per-installation CLI credentials and model selection.

1. Add `cliModel?: string` to `DbProviderChainEntry` interface (backward-compatible, JSONB):
   ```typescript
   interface DbProviderChainEntry {
     provider: SaaSProvider;
     model: string;              // 'opencode' | 'gemini' | 'copilot' | 'auto'
     encryptedApiKey: string | null;
      cliModel?: string;          // NEW: 'anthropic/claude-sonnet-4-5' (OpenCode provider/model)
   }
   ```
   No database migration needed — JSONB is schemaless; new field is optional.

2. Update `PUT /api/settings` and `PUT /api/installation-settings`:
   - Accept `cliModel` in the provider chain entries
   - Persist `cliModel` alongside existing fields
   - Key merge logic: when `provider === 'cli-bridge'`, encrypt/resolve `apiKey` the same way as API providers

3. Update `POST /api/providers/validate` for `cli-bridge`:
   - Instead of returning `['auto', 'claude', 'gemini', 'codex', 'copilot']`, return the available CLIs detected on the server
   - For OpenCode, return a curated model catalog (grouped by provider)

4. Update `GET /api/settings` and `GET /api/installation-settings`:
   - Include `cliModel` in the `buildProviderChainView()` output
   - Mask the CLI credential the same way as API keys

### Phase 3: Dashboard UI (Frontend)

**Goal**: Users can configure CLI Bridge with credentials and model selection from the dashboard.

1. Redesign the CLI Bridge section in `ProviderEntry.tsx`:
   - **CLI Tool selector**: dropdown with OpenCode (recommended), Gemini CLI, Copilot CLI
   - **Model input** (OpenCode only): text input with datalist for `provider/model` suggestions (e.g., `anthropic/claude-sonnet-4-5`, `openai/gpt-4o`, `google/gemini-2.5-flash`)
   - **API Key input**: appears when OpenCode or Gemini is selected; label adapts to selected tool ("Anthropic API Key", "Gemini API Key", etc.)
   - **Help text**: per-CLI instructions on which key is needed and how to get it

2. Update `KNOWN_MODELS['cli-bridge']` to include OpenCode model catalog:
   ```typescript
   'cli-bridge': {
      opencode: ['anthropic/claude-sonnet-4-5', 'openai/gpt-4o', 'google/gemini-2.5-flash', ...],
     gemini: ['default'],
     copilot: ['default'],
   }
   ```

3. Remove the "No API key needed" banner — replace with contextual credential UI.

4. Update the validation flow: when CLI Bridge + OpenCode is selected, validate by checking if `opencode` binary exists on the server (via the existing validate endpoint).

### Credential-to-Env-Var Mapping

| CLI Tool | `cliModel` prefix | Env var injected | Example key |
|----------|-------------------|------------------|-------------|
| OpenCode | `anthropic/*` | `ANTHROPIC_API_KEY` | `sk-ant-...` |
| OpenCode | `openai/*` | `OPENAI_API_KEY` | `sk-...` |
| OpenCode | `google/*` | `GEMINI_API_KEY` | `AIza...` |
| OpenCode | `github-copilot/*` | `GITHUB_TOKEN` | `ghp_...` |
| OpenCode | `groq/*` | `GROQ_API_KEY` | `gsk_...` |
| OpenCode | `openrouter/*` | `OPENROUTER_API_KEY` | `sk-or-...` |
| Gemini CLI | — | `GEMINI_API_KEY` | `AIza...` |
| Copilot CLI | — | `COPILOT_GITHUB_TOKEN` | `ghp_...` |

## Affected Modules

| Package | Files | Change Type |
|---------|-------|-------------|
| `packages/core` | `src/providers/cli-bridge.ts` | MODIFY — add OpenCode adapter, remove codex, accept credentials |
| `packages/core` | `src/pipeline.ts` | MODIFY — pass credentials to `generateViaCLI()` |
| `packages/core` | `src/types.ts` | MODIFY — update `DEFAULT_MODELS['cli-bridge']` |
| `packages/db` | `src/schema.ts` | MODIFY — add `cliModel` to `DbProviderChainEntry` |
| `apps/server` | `src/routes/api/settings.ts` | MODIFY — handle `cliModel` in chain, update validate endpoint |
| `apps/server` | `src/routes/api/installations.ts` | MODIFY — handle `cliModel` in chain |
| `apps/server` | `src/routes/api/utils.ts` | MODIFY — include `cliModel` in `buildProviderChainView()` |
| `apps/dashboard` | `src/components/settings/ProviderEntry.tsx` | MODIFY — CLI tool selector, model input, credential UI |
| `apps/dashboard` | `src/lib/types.ts` | MODIFY — add `cliModel` to frontend types |

## Risks

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|------------|
| OpenCode binary not installed on server | High (new dependency) | High (feature unusable) | Detect at startup, warn in logs; validate endpoint reports availability; document Dockerfile addition |
| OpenCode `run` command API changes | Low | Medium | Pin `opencode-ai` version in Dockerfile; adapter wraps invocation so changes are localized |
| Credential env var leaks in error messages | Medium | High (security) | Already truncating stderr in `cli-bridge.ts` (line 169); extend to sanitize known env var patterns |
| `cliModel` format mismatch (user types wrong format) | Medium | Low | Validate format `provider/model` in API; provide datalist suggestions in UI |
| Subprocess inherits all server env vars | Low | Medium (security) | Use `env` option in `execSync` to set a clean environment with only required vars |
| Large prompt exceeds CLI stdin buffer | Low | Low | Already handled by existing adapters (stdin approach); OpenCode supports stdin natively |
| Backward compatibility: existing `model: 'auto'` entries | Low | Low | `cliModel` is optional; when absent, current auto-detect behavior is preserved |
| Existing `model: 'claude'` entries in JSONB break after adapter removal | Medium | High | Treat `claude` as a runtime alias for `opencode` — when `model === 'claude'`, map to `opencode` with `cliModel: 'anthropic/claude-sonnet-4-5'` as default. Existing entries continue working without requiring manual reconfiguration. |
| User enters wrong credential type for selected model | Medium | Low | Map `cliModel` prefix to expected key type; show clear error if validation fails |

## Rollback Plan

Fully reversible:

- `cliModel` is optional in JSONB — old entries without it continue working with current auto-detect behavior
- OpenCode adapter is additive — removing it leaves Gemini/Copilot adapters intact
- Dashboard changes are behind the CLI Bridge radio button — API provider UI is unchanged
- No database migration (JSONB field addition) — no rollback migration needed
- Server env vars continue to work as fallback — removing user credentials degrades to current behavior
- Existing `model: 'claude'` entries are handled via runtime alias mapping to `opencode` with `cliModel: 'anthropic/claude-sonnet-4-5'` as default, so they continue working without manual intervention

## Acceptance Criteria

1. **OpenCode adapter**: `generateViaCLI()` successfully calls `opencode run --model anthropic/claude-sonnet-4` and returns parsed review output
2. **Credential injection**: When a user provides an Anthropic API key via dashboard for CLI Bridge, the OpenCode subprocess receives `ANTHROPIC_API_KEY` in its environment
3. **Credential fallback**: If no user credential is stored, the adapter falls back to server-level env vars (current behavior)
4. **Model selection**: User can select `anthropic/claude-sonnet-4` in the dashboard when CLI Bridge + OpenCode is chosen; the review uses that model
5. **Gemini/Copilot unchanged**: Existing Gemini CLI and Copilot CLI adapters continue working with server env vars and with per-installation credentials
6. **Dashboard UI**: CLI Bridge section shows tool selector, model input (OpenCode), and API key field; help text explains which credential is needed
7. **Backward compatibility**: Installations with `provider: 'cli-bridge', model: 'auto'` and no `cliModel` continue working exactly as before
8. **Codex removed**: The deprecated codex adapter is removed from the codebase
9. **Security**: CLI subprocess does not inherit unnecessary server env vars; error messages do not leak credentials
10. **Validation**: `/api/providers/validate` for `cli-bridge` returns detected CLIs and available models for OpenCode
11. **All existing tests pass** without modification

## Effort Estimate

| Phase | Estimated Effort |
|-------|-----------------|
| Phase 1: OpenCode adapter + credential plumbing | 3-4 hours |
| Phase 2: Schema + API changes | 2-3 hours |
| Phase 3: Dashboard UI | 3-4 hours |
| Testing + integration verification | 2 hours |
| **Total** | **10-13 hours** |

Phases are independent enough to be done in separate sessions. Phase 1 can be tested via CLI without dashboard changes.
