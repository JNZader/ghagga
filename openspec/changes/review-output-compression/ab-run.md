# A/B Run — review-output-compression

> STATUS: **PENDING — TEMPLATE ONLY.** The run executes OUT-OF-BAND after
> Slice 2 merges (graph-context-retrieval scoping precedent); it is NEVER
> part of CI. Until the results section below is filled in and the gate is
> recorded as PASSED, the default-ON claim is UNVERIFIED.

## Protocol

| Parameter | Value | Why |
| --- | --- | --- |
| Provider | `cli-bridge` | Already parses the input/output split (`packages/core/src/providers/cli-bridge.ts` — opencode `step_finish` usage events) |
| Mode | `simple` | One prose voice, cleanest reduction measurement |
| Diff | `packages/core/test/fixtures/graph-context/fresh-exact-multi-file/diff.patch` | Known two-file TS backdrop used by the corpus |
| Model | one codex-cli-family model from the user's review chain (`Codex-sonnet-4-6` or `gpt-5.5` via codex-cli) | The surface the flag will actually run on |

### Blind spots (accepted, documented)

- **Gateway reports `tokensUsed` total only** (`gateway.ts` — gateway protocol carries no split). The A/B run therefore does NOT use the gateway; `metadata.outputTokensUsed` would be absent there and the reduction % unevaluable.

### Procedure

1. Run A (control): `compressOutput: false` (`.ghagga.json` `"compressOutput": false` or `--no-compress-output`) on the pinned diff.
2. Run B (treatment): default ON (no flag, no config key) on the same diff.
3. Record per run in the table below: date, model, provider, `metadata.outputTokensUsed`, `metadata.tokensUsed`, findings count, findings diff (file:line + severity of anything present in only one run), output reduction % = `1 − outputTokensUsed_B / outputTokensUsed_A`.

### Gate (proposal metrics — both MUST hold before the default-ON claim is treated as verified)

- [ ] Output reduction ≥ 30%
- [ ] 0 findings lost (every Run A finding present in Run B with same file:line and severity)

Rollback if the gate fails: flip the default via one setting (`.ghagga.json "compressOutput": false` / `--no-compress-output`) — prompts return byte-identical to baseline; no code change.

## Results

### Run A — compressOutput: false

| Field | Value |
| --- | --- |
| Date | _PENDING_ |
| Model / provider | _PENDING_ |
| `metadata.tokensUsed` | _PENDING_ |
| `metadata.outputTokensUsed` | _PENDING_ |
| Findings count | _PENDING_ |
| Findings (file:line:severity) | _PENDING_ |

### Run B — compressOutput: default ON

| Field | Value |
| --- | --- |
| Date | _PENDING_ |
| Model / provider | _PENDING_ |
| `metadata.tokensUsed` | _PENDING_ |
| `metadata.outputTokensUsed` | _PENDING_ |
| Findings count | _PENDING_ |
| Findings (file:line:severity) | _PENDING_ |

### Gate evaluation

| Check | Result |
| --- | --- |
| Output reduction % (≥30%) | _PENDING_ |
| Findings lost (must be 0) | _PENDING_ |
| Verdict | _PENDING_ |
