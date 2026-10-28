# Runner Callback Authentication Specification

The runner callback system authenticates results from GitHub Actions workflow dispatches. When the GHAGGA server dispatches a `ghagga-analysis.yml` workflow to a user's `ghagga-runner` repo, it generates a per-dispatch secret. The runner uses that secret to compute an HMAC-SHA256 signature over its response body. The server verifies this signature when the runner calls back with static analysis results via `POST /runner/callback`.

This spec defines the **stateless** callback authentication model, where secrets are derived deterministically via HMAC rather than stored in an in-memory Map. This ensures callbacks survive server restarts and container redeploys.

---

## Requirements

### R1 (P0): Stateless Secret Derivation

The server MUST derive callback secrets deterministically using HMAC-SHA256 instead of generating and storing random secrets. The derivation function MUST compute:

```
callbackSecret = HMAC-SHA256(key=STATE_SECRET, data=callbackId)
```

where `STATE_SECRET` is the `process.env.STATE_SECRET` environment variable and `callbackId` is the full callback identifier (including embedded timestamp). The output MUST be a hex-encoded string (64 hex characters representing 32 bytes).

The server MUST export a `deriveCallbackSecret(callbackId: string): string` function that performs this derivation.

#### Scenario: S-R1.1 — Deterministic derivation produces consistent output

- GIVEN a `STATE_SECRET` of `"test-secret-key"`
- AND a `callbackId` of `"550e8400-e29b-41d4-a716-446655440000.m1abc"`
- WHEN `deriveCallbackSecret(callbackId)` is called twice
- THEN both calls MUST return the identical hex string
- AND the result MUST be exactly 64 hexadecimal characters

#### Scenario: S-R1.2 — Different callbackIds produce different secrets

- GIVEN the same `STATE_SECRET`
- WHEN `deriveCallbackSecret("id-a.ts1")` and `deriveCallbackSecret("id-b.ts2")` are called
- THEN the returned secrets MUST be different

#### Scenario: S-R1.3 — Different STATE_SECRETs produce different secrets

- GIVEN the same `callbackId`
- WHEN the server derives a secret with `STATE_SECRET="key-1"` and then with `STATE_SECRET="key-2"`
- THEN the returned secrets MUST be different

---

### R2 (P0): Callback ID with Embedded Timestamp

The `callbackId` MUST embed a creation timestamp for stateless TTL enforcement. The format MUST be:

```
callbackId = "{uuid}.{timestamp_base36}"
```

where `{uuid}` is a `crypto.randomUUID()` and `{timestamp_base36}` is `Date.now().toString(36)`.

The `dispatchWorkflow()` function MUST generate callbackIds in this format instead of a plain UUID.

#### Scenario: S-R2.1 — CallbackId format is uuid.timestamp

- GIVEN a workflow dispatch is triggered
- WHEN `dispatchWorkflow()` generates a `callbackId`
- THEN the `callbackId` MUST match the pattern `^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.[0-9a-z]+$`
- AND the portion after the last `.` MUST be a valid base-36 encoded integer
- AND `parseInt(timestampPart, 36)` MUST produce a value within 1 second of the current `Date.now()`

#### Scenario: S-R2.2 — Timestamp is extractable from callbackId

- GIVEN a `callbackId` of `"550e8400-e29b-41d4-a716-446655440000.m1abc"`
- WHEN the timestamp portion is extracted (everything after the last `.`)
- AND parsed with `parseInt("m1abc", 36)`
- THEN the result MUST be a valid Unix epoch millisecond value

#### Scenario: S-R2.3 — UUID portion provides uniqueness

- GIVEN two calls to `dispatchWorkflow()` occur within the same millisecond
- WHEN both callbackIds are generated
- THEN the callbackIds MUST be different (the UUID portion ensures uniqueness)

---

### R3 (P0): TTL Enforcement

The server MUST reject callbacks older than `CALLBACK_SECRET_TTL_MS` (11 minutes = 660,000 ms) based on the timestamp embedded in the `callbackId`. The TTL check MUST occur before HMAC verification to avoid unnecessary computation.

#### Scenario: S-R3.1 — Callback within TTL is accepted

- GIVEN a `callbackId` with a timestamp from 5 minutes ago
- AND a valid HMAC signature over the payload
- WHEN `verifyCallbackSignature(callbackId, payload, signatureHeader)` is called
- THEN the function MUST return `true`

#### Scenario: S-R3.2 — Callback at exactly 11 minutes is rejected

- GIVEN a `callbackId` with a timestamp from exactly 11 minutes ago (`Date.now() - timestamp === 660000`)
- AND a valid HMAC signature
- WHEN `verifyCallbackSignature(callbackId, payload, signatureHeader)` is called
- THEN the function MUST return `false`

#### Scenario: S-R3.3 — Callback at 11 minutes minus 1ms is accepted

- GIVEN a `callbackId` with a timestamp from `660000 - 1` ms ago
- AND a valid HMAC signature
- WHEN `verifyCallbackSignature(callbackId, payload, signatureHeader)` is called
- THEN the function MUST return `true`

#### Scenario: S-R3.4 — Callback older than 11 minutes is rejected

- GIVEN a `callbackId` with a timestamp from 12 minutes ago
- AND a valid HMAC signature
- WHEN `verifyCallbackSignature(callbackId, payload, signatureHeader)` is called
- THEN the function MUST return `false`
- AND the server SHOULD log a warning indicating the callback expired

---

### R4 (P0): HMAC Verification on Callback

The server MUST export a `verifyCallbackSignature(callbackId: string, payload: string, signatureHeader: string): boolean` function that verifies the runner's callback signature. The verification MUST follow this sequence:
1. **Extract timestamp**: Parse the timestamp from the `callbackId` (everything after the last `.`). If no `.` exists, return `false`.
2. **Check TTL**: If `Date.now() - timestamp > CALLBACK_SECRET_TTL_MS`, return `false`.
3. **Derive secret**: Compute `deriveCallbackSecret(callbackId)`.
4. **Validate format**: The `signatureHeader` MUST start with `sha256=`. If not, return `false`.
5. **Compute expected**: Calculate `HMAC-SHA256(key=derivedSecret, data=payload)` and hex-encode.
6. **Compare**: Use `crypto.timingSafeEqual()` to compare the provided signature hex with the computed hex. Return the result.

The function MUST use timing-safe comparison to prevent timing attacks.

#### Scenario: S-R4.1 — Happy path: valid callbackId, valid signature

- GIVEN a `callbackId` with a recent timestamp
- AND the `STATE_SECRET` is `"my-server-secret"`
- AND the runner computed `callbackSecret = HMAC-SHA256("my-server-secret", callbackId)` (hex)
- AND the runner computed `signature = "sha256=" + HMAC-SHA256(callbackSecret, rawBody)` (hex)
- WHEN `verifyCallbackSignature(callbackId, rawBody, signature)` is called
- THEN the function MUST return `true`

#### Scenario: S-R4.2 — Tampered callbackId is rejected

- GIVEN a legitimate `callbackId` and its derived secret were used to sign a payload
- WHEN the `callbackId` is modified (e.g., UUID portion changed) before calling `verifyCallbackSignature`
- THEN the function MUST return `false`
- AND the reason is that `deriveCallbackSecret(tamperedCallbackId)` produces a different secret

#### Scenario: S-R4.3 — Tampered signature is rejected

- GIVEN a valid `callbackId` and payload
- WHEN the `signatureHeader` contains an incorrect hex value (e.g., bits flipped)
- THEN `verifyCallbackSignature` MUST return `false`

#### Scenario: S-R4.4 — Missing sha256= prefix is rejected

- GIVEN a valid `callbackId` and payload
- AND the signature is a valid hex HMAC but without the `sha256=` prefix
- WHEN `verifyCallbackSignature(callbackId, payload, hexWithoutPrefix)` is called
- THEN the function MUST return `false`

#### Scenario: S-R4.5 — CallbackId without dot separator is rejected

- GIVEN a `callbackId` of `"plain-uuid-no-timestamp"` (no `.` character)
- WHEN `verifyCallbackSignature(callbackId, payload, signatureHeader)` is called
- THEN the function MUST return `false`

#### Scenario: S-R4.6 — Signature with wrong length hex is rejected

- GIVEN a valid `callbackId` and payload
- AND the signature is `"sha256=aabbccdd"` (only 4 bytes, not 32)
- WHEN `verifyCallbackSignature(callbackId, payload, signatureHeader)` is called
- THEN the function MUST return `false`

#### Scenario: S-R4.7 — Invalid hex in signature is rejected

- GIVEN a valid `callbackId` and payload
- AND the signature is `"sha256=zzzzzz"` (not valid hex)
- WHEN `verifyCallbackSignature(callbackId, payload, signatureHeader)` is called
- THEN the function MUST return `false`
- AND the function MUST NOT throw an exception

---

### R5 (P0): Secret Transmission via Workflow Dispatch

The derived secret MUST be transmitted to the runner via the existing workflow dispatch mechanism. Specifically:
1. `dispatchWorkflow()` MUST generate the `callbackId` with embedded timestamp (R2).
2. `dispatchWorkflow()` MUST derive the secret using `deriveCallbackSecret(callbackId)` (R1).
3. The derived secret MUST be included in the `WorkflowDispatchInputs.callbackSecret` field.
4. The derived secret MUST also be set as the `GHAGGA_CALLBACK_SECRET` GitHub Actions secret on the runner repo (via `setRunnerSecret()`).
5. The `dispatchWorkflow()` function MUST NOT call `storeCallbackSecret()` or interact with any in-memory store.

#### Scenario: S-R5.1 — Dispatch sends derived secret to runner

- GIVEN a workflow dispatch is triggered for `alice/my-repo` PR #7
- WHEN `dispatchWorkflow()` executes
- THEN the `callbackId` in the dispatch inputs MUST contain an embedded timestamp
- AND the `callbackSecret` in the dispatch inputs MUST equal `HMAC-SHA256(STATE_SECRET, callbackId)` (hex)
- AND `setRunnerSecret("alice/ghagga-runner", "GHAGGA_CALLBACK_SECRET", callbackSecret, token)` MUST be called with the same derived secret

#### Scenario: S-R5.2 — Runner can use dispatched secret to produce valid signature

- GIVEN the server dispatched a workflow with `callbackId="abc-uuid.ts123"` and `callbackSecret="<derived_hex>"`
- AND the runner receives these inputs
- WHEN the runner computes `signature = "sha256=" + HMAC-SHA256(callbackSecret, responseBody)`
- AND sends `POST /runner/callback` with header `x-ghagga-signature: {signature}`
- THEN the server's `verifyCallbackSignature(callbackId, responseBody, signature)` MUST return `true`

#### Scenario: S-R5.3 — Dispatch failure cleans up gracefully (no state to clean)

- GIVEN the GitHub workflow dispatch API returns HTTP 422
- WHEN `dispatchWorkflow()` catches the error
- THEN the function MUST throw an error with the API response details
- AND no in-memory cleanup is needed (there is no in-memory store)

---

### R6 (P0): Replay Protection

Replayed callbacks MUST be handled safely. The stateless design means the server can re-derive the secret and verify the HMAC for any callback within the TTL window. Replay protection is provided by the downstream Inngest `waitForEvent` correlation mechanism.
1. The server MUST NOT provide one-time-use semantics for callback verification itself.
2. A replayed callback with a valid signature within the TTL window MUST receive HTTP 200 from the callback endpoint.
3. The Inngest `waitForEvent` with `match: "data.callbackId"` MUST ensure the replayed event has no effect — the waiting step was already consumed by the first callback.

#### Scenario: S-R6.1 — First callback resumes Inngest function

- GIVEN a dispatched workflow with `callbackId="cb-001.ts1"`
- AND the Inngest function is waiting on `waitForEvent("ghagga/runner.completed", { match: "data.callbackId" })`
- WHEN the runner sends the first callback with valid signature
- THEN the server returns HTTP 200
- AND the server sends an Inngest event `ghagga/runner.completed` with `data.callbackId="cb-001.ts1"`
- AND the Inngest `waitForEvent` step is consumed

#### Scenario: S-R6.2 — Replayed callback is accepted but has no downstream effect

- GIVEN the first callback for `callbackId="cb-001.ts1"` was already processed
- AND the Inngest `waitForEvent` step was already consumed
- WHEN an attacker replays the exact same callback (same body, same signature)
- THEN the server MUST return HTTP 200 (signature is still valid within TTL)
- AND the server MUST send another Inngest event
- AND the Inngest event MUST have no effect (no waiting step matches)

#### Scenario: S-R6.3 — Replayed callback after TTL is rejected

- GIVEN a callback was successfully processed
- WHEN the same callback is replayed more than 11 minutes after the original dispatch
- THEN the server MUST return HTTP 401 (TTL expired)

---

### R7 (P1): Backward Compatibility During Deployment

During the deployment transition, callbacks with old-format `callbackId`s (plain UUID without embedded timestamp) will be in flight. The server SHOULD handle this gracefully.
1. If a `callbackId` contains no `.` separator, `verifyCallbackSignature()` MUST return `false`.
2. This is acceptable because: (a) the same scenario (redeploy losing in-memory state) already causes callback failure today, and (b) the window is identical (~5 minutes of in-flight callbacks).
3. The system SHOULD NOT maintain dual-mode verification (checking both old and new formats) because the old format requires in-memory state that no longer exists after the deploy.

#### Scenario: S-R7.1 — Old-format callbackId fails verification

- GIVEN a callback dispatched before the deploy with `callbackId="550e8400-e29b-41d4-a716-446655440000"` (plain UUID, no timestamp)
- AND the server has been redeployed with the new stateless verification code
- WHEN the runner calls back with this old-format `callbackId`
- THEN `verifyCallbackSignature` MUST return `false` (no `.` separator means no extractable timestamp)
- AND the callback receives HTTP 401
- AND the Inngest `waitForEvent` eventually times out and the review falls back to LLM-only mode

#### Scenario: S-R7.2 — New-format callbackId works after deploy

- GIVEN a callback dispatched after the deploy with `callbackId="550e8400-e29b-41d4-a716-446655440000.m1abc"` (new format)
- WHEN the runner calls back within 11 minutes
- THEN `verifyCallbackSignature` MUST return `true`
- AND the callback is processed normally

---

### R8 (P0): No In-Memory State

The system MUST NOT use any in-memory `Map`, `Set`, or similar data structure for callback secret storage. All the following MUST be removed from `apps/server/src/github/runner.ts`:
1. The `secretStore` Map (`Map<string, StoredSecret>`).
2. The `StoredSecret` interface.
3. The `storeCallbackSecret()` function.
4. The `verifyAndConsumeSecret()` function.
5. The cleanup `setInterval` and `cleanupInterval.unref()`.

The replacement functions (`deriveCallbackSecret`, `verifyCallbackSignature`) MUST be pure in the sense that they derive all needed values from their arguments plus `STATE_SECRET` and produce no side effects on module-level state.

#### Scenario: S-R8.1 — No Map in module scope

- GIVEN the updated `runner.ts` source code
- WHEN the module is loaded
- THEN there MUST be no `new Map()` call at module scope
- AND there MUST be no `setInterval` call at module scope

#### Scenario: S-R8.2 — Server restart does not affect callback verification

- GIVEN the server dispatched a workflow with a new-format `callbackId`
- AND the server process is restarted (or the container is redeployed)
- AND the same `STATE_SECRET` env var is configured
- WHEN the runner calls back within 11 minutes
- THEN `verifyCallbackSignature` MUST return `true`
- AND the callback is processed normally

#### Scenario: S-R8.3 — Multiple server instances produce consistent verification

- GIVEN two server instances (e.g., in a horizontally scaled deployment) sharing the same `STATE_SECRET`
- AND instance A dispatched a workflow
- WHEN the callback arrives at instance B
- THEN instance B's `verifyCallbackSignature` MUST return `true`
- AND the reason is that both instances derive the same secret from the same `STATE_SECRET` and `callbackId`

---

## Cross-Cutting Concerns

### CC1: Reuse of STATE_SECRET Environment Variable

The system MUST reuse the existing `STATE_SECRET` environment variable (already provisioned on Render for the OAuth web flow). No new environment variables MUST be introduced.
1. `deriveCallbackSecret()` MUST read `process.env.STATE_SECRET` as its HMAC key.
2. The `STATE_SECRET` variable is already used by `generateState()` and `validateState()` in `apps/server/src/routes/oauth.ts`.
3. If `STATE_SECRET` is not defined, `deriveCallbackSecret()` MUST throw an error rather than silently producing an insecure derivation.

#### Scenario: S-CC1.1 — STATE_SECRET undefined causes a clear error

- GIVEN `process.env.STATE_SECRET` is `undefined`
- WHEN `dispatchWorkflow()` is called (which internally calls `deriveCallbackSecret`)
- THEN the function MUST throw an error with a message indicating `STATE_SECRET` is not configured
- AND the error MUST NOT be silently swallowed

#### Scenario: S-CC1.2 — STATE_SECRET undefined causes verification failure

- GIVEN `process.env.STATE_SECRET` is `undefined`
- WHEN `verifyCallbackSignature()` is called
- THEN the function MUST throw an error (or return `false`) with a message indicating `STATE_SECRET` is not configured

#### Scenario: S-CC1.3 — No new env vars in .env.example or documentation

- GIVEN this change is complete
- WHEN the repository is inspected
- THEN no new environment variable entries related to callback secrets MUST appear in `.env.example`, documentation, or Render configuration
- AND the existing `STATE_SECRET` entry MUST remain unchanged

---

### CC2: Cleanup of In-Memory Store Code

All in-memory store code MUST be removed from `apps/server/src/github/runner.ts`. This is a hard removal, not a deprecation.

The following MUST be deleted:

| Code Element                                                        | Current Location                                                                 |
| ------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| `const CALLBACK_SECRET_TTL_MS = 11 * 60 * 1000;`                    | Line 108 — MUST be **retained** (used by TTL check in `verifyCallbackSignature`) |
| `interface StoredSecret`                                            | Lines 110-113 — MUST be deleted                                                  |
| `const secretStore = new Map<string, StoredSecret>()`               | Line 115 — MUST be deleted                                                       |
| `const cleanupInterval = setInterval(...)`                          | Lines 118-125 — MUST be deleted                                                  |
| `cleanupInterval.unref()`                                           | Line 128 — MUST be deleted                                                       |
| `storeCallbackSecret()`                                             | Lines 130-138 — MUST be deleted                                                  |
| `verifyAndConsumeSecret()`                                          | Lines 140-197 — MUST be deleted                                                  |
| `secretStore.delete(callbackId)` in `dispatchWorkflow()` error path | Line 364 — MUST be deleted                                                       |

The following MUST be added or retained:

| Code Element                                                                                     | Purpose                                                    |
| ------------------------------------------------------------------------------------------------ | ---------------------------------------------------------- |
| `const CALLBACK_SECRET_TTL_MS = 11 * 60 * 1000;`                                                 | Retained — used by `verifyCallbackSignature` for TTL check |
| `deriveCallbackSecret(callbackId: string): string`                                               | New — deterministic secret derivation                      |
| `verifyCallbackSignature(callbackId: string, payload: string, signatureHeader: string): boolean` | New — stateless verification                               |

#### Scenario: S-CC2.1 — Import update in runner-callback route

- GIVEN `apps/server/src/routes/runner-callback.ts` currently imports `verifyAndConsumeSecret`
- WHEN this change is applied
- THEN the import MUST change to `verifyCallbackSignature`
- AND the call site MUST use `verifyCallbackSignature(callbackId, rawBody, signature)` with identical argument semantics

#### Scenario: S-CC2.2 — randomBytes import removed

- GIVEN the current code imports `randomBytes` from `node:crypto` (used to generate random secrets)
- WHEN this change is applied
- THEN the `randomBytes` import MUST be removed (no longer needed)
- AND the `randomUUID` import MUST be retained (still used for the UUID portion of callbackId)

---

## Integration Scenarios

### Scenario: S-INT.1 — Full end-to-end: dispatch, callback, verify

- GIVEN the `STATE_SECRET` is `"prod-secret-xyz"`
- AND a review pipeline dispatches a workflow for `alice/my-repo` PR #42
- WHEN `dispatchWorkflow()` generates `callbackId="<uuid>.<ts_base36>"`
- AND computes `callbackSecret = HMAC-SHA256("prod-secret-xyz", callbackId)`
- AND dispatches the workflow with these inputs
- AND the runner completes analysis after 3 minutes
- AND the runner computes `signature = "sha256=" + HMAC-SHA256(callbackSecret, responseBody)`
- AND the runner sends `POST /runner/callback` with `x-ghagga-signature: {signature}` and body containing `callbackId`
- THEN the server extracts `callbackId` from the body
- AND the server calls `verifyCallbackSignature(callbackId, rawBody, signature)`
- AND `verifyCallbackSignature` extracts the timestamp, confirms TTL (3 min < 11 min)
- AND re-derives the secret: `HMAC-SHA256("prod-secret-xyz", callbackId)` — same as dispatch
- AND computes expected signature: `HMAC-SHA256(derivedSecret, rawBody)`
- AND `timingSafeEqual` confirms the signatures match
- AND the function returns `true`
- AND the server sends `ghagga/runner.completed` Inngest event
- AND the server returns HTTP 200 `{ ok: true }`

### Scenario: S-INT.2 — Server restart between dispatch and callback

- GIVEN a workflow was dispatched with `callbackId="<uuid>.<ts_base36>"` and `callbackSecret="<derived>"`
- AND the server restarts (container redeploy on Render)
- AND the same `STATE_SECRET` env var is loaded by the new process
- WHEN the runner calls back 4 minutes after dispatch
- THEN the server has no in-memory state but can re-derive the secret from `STATE_SECRET` + `callbackId`
- AND the TTL check passes (4 min < 11 min)
- AND the HMAC verification passes
- AND the callback is processed successfully

### Scenario: S-INT.3 — Concurrent dispatches produce unique callbackIds

- GIVEN two PRs (#10 and #11) trigger workflow dispatches simultaneously
- WHEN `dispatchWorkflow()` is called for each
- THEN each dispatch MUST produce a unique `callbackId` (the UUID portion differs even if the timestamp is the same)
- AND each dispatch MUST produce a different `callbackSecret` (because the `callbackId` inputs to HMAC differ)
- AND when both runners call back, each callback is verified independently

### Scenario: S-INT.4 — Missing STATE_SECRET at server startup

- GIVEN `STATE_SECRET` is not set in the environment
- WHEN the server starts and a review triggers `dispatchWorkflow()`
- THEN `deriveCallbackSecret` MUST throw an error
- AND `dispatchWorkflow` MUST propagate the error
- AND the review pipeline MUST handle the error (fall back to LLM-only review or report the configuration error)
- AND the server itself MUST NOT crash on startup (the error occurs on first dispatch, not at module load time)

---

## Acceptance Criteria Summary

| ID  | Priority | Requirement                        | Acceptance Criteria                                                                                                            |
| --- | -------- | ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| R1  | P0       | Stateless Secret Derivation        | `deriveCallbackSecret` computes `HMAC-SHA256(STATE_SECRET, callbackId)` deterministically; output is 64-char hex               |
| R2  | P0       | CallbackId with Embedded Timestamp | Format is `{uuid}.{timestamp_base36}`; `dispatchWorkflow` generates this format                                                |
| R3  | P0       | TTL Enforcement                    | Callbacks >11 minutes are rejected based on embedded timestamp; boundary at exactly 11 min rejects                             |
| R4  | P0       | HMAC Verification on Callback      | `verifyCallbackSignature` re-derives secret, validates sha256= prefix, uses timingSafeEqual; replaces `verifyAndConsumeSecret` |
| R5  | P0       | Secret Transmission                | Derived secret sent via dispatch inputs and `setRunnerSecret`; no `storeCallbackSecret` call                                   |
| R6  | P0       | Replay Protection                  | Replayed callbacks pass HMAC within TTL; Inngest `waitForEvent` deduplicates downstream; after TTL, 401                        |
| R7  | P1       | Backward Compatibility             | Old-format callbackIds (no timestamp) return `false`; same failure mode as current redeploy scenario                           |
| R8  | P0       | No In-Memory State                 | `secretStore` Map, `StoredSecret`, `storeCallbackSecret`, `verifyAndConsumeSecret`, cleanup interval all removed               |
| CC1 | P0       | Reuse STATE_SECRET                 | No new env vars; `STATE_SECRET` used for both OAuth state and callback derivation; throws if undefined                         |
| CC2 | P0       | Cleanup                            | All in-memory store code deleted; imports updated in `runner-callback.ts`; `randomBytes` import removed                        |
