# Spec: CLI Bridge Credentials and Model Selection

**Status**: draft-v2  
**Proposal**: [proposal.md](./proposal.md)  
**Date**: 2026-03-18  

## Overview

This change defines a user-configurable CLI Bridge where each installation can choose which CLI tool to use, optionally provide its own encrypted CLI credential, and select a model when the selected tool supports it.

OpenCode becomes the primary CLI bridge because it supports explicit `provider/model` selection through `opencode run --model provider/model`. Gemini CLI and Copilot CLI remain supported as fallback tools for users who prefer their existing workflows.

The feature must preserve current behavior for existing CLI Bridge configurations. Installations with `provider: 'cli-bridge'`, `model: 'auto'`, and no `cliModel` must continue to work without reconfiguration.

## Requirements

### R1: CLI Tool Selection

The dashboard MUST let the user select the CLI Bridge tool from the detected tools supported by the system.

- Supported tool identifiers: `opencode`, `gemini`, `copilot`
- The selected CLI tool MUST be stored in the existing CLI Bridge entry's `model` field
- Validation responses for `cli-bridge` MUST surface which CLI tools are currently available on the server
- Existing entries with `model: 'auto'` MUST remain valid and continue to use current auto-selection behavior
- When `model: 'auto'`, the auto-detect ordering is `opencode → copilot → gemini`

### R2: OpenCode as Primary Explicit-Model CLI

When the selected CLI tool is `opencode`, the system MUST support explicit model selection using the format `provider/model`.

- The dashboard MUST allow entry or selection of an OpenCode model string
- The backend MUST pass the configured model to OpenCode as `opencode run --model provider/model`
- The prompt MUST be provided through subprocess stdin or an equivalent non-argument mechanism suitable for large prompts
- `cliModel` MUST be optional and MUST only be meaningful when `provider === 'cli-bridge'`
- `cliModel` is REQUIRED when `model === 'opencode'` — the dashboard and API MUST reject saves without it
- If `cliModel` is absent, existing `auto` behavior or tool-default behavior MUST remain unchanged

### R3: CLI Credential Storage and Encryption

Per-installation CLI credentials MUST reuse the existing `encryptedApiKey` field.

- When `provider === 'cli-bridge'`, `encryptedApiKey` MUST store the credential required by the selected CLI tool or selected OpenCode provider
- The credential MUST remain encrypted at rest using the same encryption flow already used for API-provider keys
- The dashboard MUST allow users to create, replace, and clear the CLI credential using the same masked-key pattern used elsewhere in settings
- The system MUST NOT require a new database migration solely for adding CLI credential support

### R3b: Credential Reset on Tool Change

When the user changes the CLI tool selection (e.g., from `opencode` to `gemini`), the dashboard SHOULD prompt to clear or replace the stored credential, since the existing key may not be compatible with the new tool.

- The credential field SHOULD be reset when the CLI tool selector changes
- Previously entered API keys SHOULD be cleared from the UI state when switching tools, since credentials are tool/provider-specific
- The system SHOULD NOT silently reuse a credential from one tool context in a different tool context

### R4: Runtime Credential Injection

CLI credentials MUST be injected only at subprocess runtime.

- The server MUST decrypt the stored CLI credential before launching the CLI subprocess
- The subprocess environment MUST receive only the credential env var(s) needed for the selected CLI invocation plus required baseline process env values
- OpenCode MUST map the `cliModel` provider prefix to the correct env var name before execution
- Example mappings MUST include at least: `anthropic/* -> ANTHROPIC_API_KEY`, `openai/* -> OPENAI_API_KEY`, `google/* -> GEMINI_API_KEY`
- The system MUST avoid exposing decrypted credentials in logs, validation output, or error messages

### R5: Credential Fallback Behavior

The CLI Bridge MUST support a credential fallback chain.

- The runtime MUST first use the per-installation credential when present
- If no per-installation credential is stored, the runtime MAY use server environment credentials for the selected CLI tool
- If neither user credential nor compatible server credential is available, the run MUST fail with a clear, actionable error
- This fallback behavior MUST preserve current Gemini CLI and Copilot CLI server-managed flows

### R5b: Tool-Specific Failure Semantics

When a user explicitly selects a CLI tool (e.g., `opencode`) and it fails due to a **configuration error** (missing binary, malformed model, unsupported prefix, missing credentials), the system MUST fail with an actionable error. It MUST NOT silently fall through to another CLI tool.

- Configuration errors include: CLI binary not found, malformed `cliModel`, unsupported provider prefix, missing required credential
- For **non-configuration failures** (e.g., API timeout, rate limit, transient network error), the system MAY fall through to other available CLI tools
- This distinction prevents misconfiguration from being hidden by silent fallback to a different tool

### R6: CLI Model Validation

The system MUST validate CLI Bridge configuration according to the selected tool.

- `cliModel` for OpenCode MUST be validated against the `provider/model` shape
- Validation for `cli-bridge` MUST return model suggestions for OpenCode
- Validation SHOULD return a curated, implementation-approved OpenCode model catalog rather than requiring the dashboard to guess valid values
- Validation for Gemini CLI and Copilot CLI MUST reflect their more limited model-selection capabilities
- Invalid OpenCode model strings MUST be rejected before save or execution with a clear explanation

### R7: Dashboard Configuration UX

The dashboard MUST adapt CLI Bridge configuration fields based on the selected tool.

- When `opencode` is selected, the dashboard MUST show a model field and credential field
- When `gemini` or `copilot` is selected, the dashboard MUST show only the fields relevant to those tools
- The dashboard MUST explain which credential is expected for the selected tool or selected OpenCode provider
- The dashboard MUST NOT present `cliModel` as a required field for existing `auto`, Gemini CLI, or Copilot CLI flows unless explicitly needed

### R8: Backward Compatibility

The change MUST preserve all existing valid CLI Bridge configurations.

- Existing entries with `provider: 'cli-bridge'`, `model: 'auto'`, and no `cliModel` MUST continue to execute unchanged
- Existing Gemini CLI and Copilot CLI usage MUST continue to work if the server already provides their credentials through environment variables
- Saved provider chains without `cliModel` MUST remain readable and writable
- The addition of `cliModel` MUST be backward compatible because it is optional

### R9: Fallback Tool Support

Gemini CLI and Copilot CLI MUST remain supported as CLI Bridge tools after OpenCode is added.

- They MUST still be surfaced by validation when installed
- They MUST continue to be selectable in the dashboard
- Their execution path MUST remain available even if OpenCode is missing from the server
- Their limited model-selection behavior MUST remain explicit in the UI and validation results

### R10: Claude Adapter Migration

Existing `model: 'claude'` entries MUST continue to work after the `claude` adapter is removed.

- The system MUST recognize `claude` as a legacy alias and map it to `opencode` at runtime
- When `model === 'claude'` is encountered, the system MUST treat it as `opencode` with `cliModel: 'anthropic/claude-sonnet-4'` as the default model (unless `cliModel` is already set)
- The system MUST NOT silently break existing configurations that reference `model: 'claude'`
- The dashboard SHOULD display these entries as OpenCode with the mapped Anthropic model
- No automated data migration is required — the mapping is handled at runtime

## User Scenarios

### S1: New installation configures OpenCode with Anthropic model

**Given** the server has `opencode` installed  
**And** the user opens installation settings  
**When** they choose `cli-bridge` with CLI tool `opencode`  
**And** they enter `anthropic/claude-sonnet-4` as the model  
**And** they save an Anthropic API key  
**Then** the key is stored in `encryptedApiKey`  
**And** a later review runs `opencode run --model anthropic/claude-sonnet-4`  
**And** the subprocess receives `ANTHROPIC_API_KEY` at runtime  

### S2: Existing auto-configured CLI Bridge continues unchanged

**Given** an installation already has `provider: 'cli-bridge'` and `model: 'auto'`  
**And** no `cliModel` is stored  
**When** the feature is deployed  
**Then** the installation does not require migration or resave  
**And** reviews continue to use the existing auto CLI selection behavior  

### S3: User relies on server credential fallback

**Given** the user selects OpenCode with model `google/gemini-2.5-flash`  
**And** no per-installation credential is stored  
**And** the server has a compatible `GEMINI_API_KEY` configured  
**When** a review runs  
**Then** the review succeeds using the server credential fallback  

### S4: Server lacks OpenCode but has Gemini CLI

**Given** the validation endpoint detects `gemini` but not `opencode`  
**When** the user opens CLI Bridge settings  
**Then** the dashboard shows Gemini CLI as available and OpenCode as unavailable  
**And** the user can still select Gemini CLI and save a working CLI Bridge configuration  

### S5: User enters malformed OpenCode model

**Given** the user selects `opencode`  
**When** they enter `claude-sonnet-4` instead of `provider/model`  
**Then** validation rejects the value  
**And** the UI explains that OpenCode models must use the `provider/model` format  

### S6: Copilot remains available with limited model behavior

**Given** the server has Copilot CLI installed  
**When** the user selects `copilot` in CLI Bridge settings  
**Then** the dashboard does not require an OpenCode-style `cliModel`  
**And** the review executes through the Copilot CLI path if credentials are available

### S7: Existing `model: 'claude'` entry continues working after migration

**Given** an installation has `provider: 'cli-bridge'` and `model: 'claude'` in its provider chain  
**When** the feature is deployed (removing the `claude` adapter)  
**Then** reviews still run successfully using OpenCode with `anthropic/claude-sonnet-4` as the default model  
**And** the dashboard shows the entry as OpenCode with the mapped Anthropic model  
**And** no manual reconfiguration is required by the user  

## Acceptance Criteria

- `GET` responses for installation or settings views include `cliModel` when present and omit or return null-equivalent behavior when absent
- `PUT` settings endpoints accept and persist optional `cliModel` on CLI Bridge entries without breaking older entries
- `POST /api/providers/validate` for `cli-bridge` returns detected CLI tools and OpenCode model suggestions when OpenCode is available
- OpenCode execution uses `opencode run --model provider/model` and injects provider-specific credentials at subprocess runtime
- `encryptedApiKey` is reused for CLI credentials and remains encrypted at rest
- Reviews still succeed for existing CLI Bridge entries configured with `model: 'auto'` and no `cliModel`
- If a per-installation CLI credential is missing but a compatible server env var exists, the run succeeds using the server env var
- If required credentials are missing from both installation settings and server env, the system returns a clear failure indicating what credential is required
- Gemini CLI and Copilot CLI remain selectable and executable when installed, even if OpenCode is unavailable
- Invalid OpenCode model input that does not match `provider/model` is rejected before execution

## Edge Cases

- **Backward compatibility**: Older CLI Bridge entries with no `cliModel` and `model: 'auto'` continue to work exactly as before
- **Missing CLI binary**: Validation reports the tool as unavailable; users can still configure another detected CLI tool
- **Missing credentials**: Execution falls back from installation credential to server env var; if neither exists, execution fails with a tool-specific credential error
- **Wrong model format**: OpenCode rejects values not shaped like `provider/model`; Gemini CLI and Copilot CLI do not require OpenCode-style model strings
- **Unsupported OpenCode provider prefix**: If the `cliModel` prefix cannot be mapped to a known env var, validation or execution fails with an explicit unsupported-provider error
- **OpenCode unavailable but fallback tools installed**: The dashboard still offers Gemini CLI and Copilot CLI based on detected availability
- **Gemini/Copilot limited model support**: The UI must not imply that Gemini CLI or Copilot CLI support the same model catalog flexibility as OpenCode
- **Cleared credential with existing saved config**: Saving a blank CLI credential does not corrupt the provider chain entry; subsequent runs use server fallback if available

## Non-Goals

- Automatically installing OpenCode, Gemini CLI, or Copilot CLI on the server
- Adding per-user CLI credentials; credential scope remains per installation
- Adding per-repository CLI credentials or per-repository CLI model overrides
- Supporting CLI Bridge in workflow or consensus review modes
- Implementing interactive OpenCode sessions or persistent CLI sessions
- Providing pricing, quota, or cost-estimation UX for CLI-selected models
- Expanding Gemini CLI or Copilot CLI to full OpenCode-style `provider/model` model catalogs
