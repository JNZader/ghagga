# Runner Callback Authentication Specification

The runner callback system authenticates static-analysis results posted back by the in-repo GHAGGA inline workflow. The GHAGGA server injects `.github/workflows/ghagga.yml` (built from `templates/ghagga-inline.yml`) into the target repository, then triggers a `workflow_dispatch` whose inputs include a derived callback secret. The runner uses that secret to sign its callback body with HMAC-SHA256, and the server verifies the signature when the runner POSTs results to `POST /runner/callback`.

This spec defines the **stateless** callback authentication model: secrets are derived deterministically via HMAC over `STATE_SECRET + callbackId` rather than stored in an in-memory map. This ensures callbacks survive server restarts, container redeploys, and horizontal scaling.

---

## Requirements

### R1 (P0): Stateless Secret Derivation

The server MUST derive callback secrets deterministically using HMAC-SHA256 instead of generating and storing random secrets. The derivation function MUST compute:

```
callbackSecret = HMAC-SHA256(key=STATE_SECRET, data=callbackId)
```

where `STATE_SECRET` is the `process.env.STATE_SECRET` environment variable and `callbackId` is the full callback identifier (including embedded timestamp). The output MUST be a hex-encoded string (64 hex characters representing 32 bytes).

The server MUST export a `deriveCallbackSecret(callbackId: string): string` function that performs this derivation (see `apps/server/src/github/runner.ts`).

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

The caller that dispatches the inline workflow MUST generate callbackIds in this format. Callbacks whose `callbackId` does not include a `.timestamp_base36` suffix MUST be rejected.

#### Scenario: S-R2.1 — CallbackId format is uuid.timestamp

- GIVEN a workflow dispatch is triggered
- WHEN the server generates a `callbackId`
- THEN the `callbackId` MUST match the pattern `^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.[0-9a-z]+$`
- AND the portion after the last `.` MUST be a valid base-36 encoded integer
- AND `parseInt(timestampPart, 36)` MUST produce a value within 1 second of the current `Date.now()`

#### Scenario: S-R2.2 — Timestamp is extractable from callbackId

- GIVEN a `callbackId` of `"550e8400-e29b-41d4-a716-446655440000.m1abc"`
- WHEN the timestamp portion is extracted (everything after the last `.`)
- AND parsed with `parseInt("m1abc", 36)`
- THEN the result MUST be a valid Unix epoch millisecond value

#### Scenario: S-R2.3 — UUID portion provides uniqueness

- GIVEN two dispatches occur within the same millisecond
- WHEN both callbackIds are generated
- THEN the callbackIds MUST be different (the UUID portion ensures uniqueness)

---

### R3 (P0): TTL Enforcement

The server MUST reject callbacks older than the configured TTL based on the timestamp embedded in the `callbackId`. The TTL is controlled by `CALLBACK_TTL_MINUTES` (default `11`, minimum `1`) and exposed via `getCallbackTtlMs()`. The TTL check MUST occur before HMAC verification to avoid unnecessary computation on stale requests.

#### Scenario: S-R3.1 — Callback within TTL is accepted

- GIVEN a `callbackId` with a timestamp from 5 minutes ago
- AND a valid HMAC signature over the payload
- WHEN `verifyCallbackSignature(callbackId, payload, signatureHeader)` is called
- THEN the function MUST return `true`

#### Scenario: S-R3.2 — Callback at exactly the TTL boundary is rejected

- GIVEN a `callbackId` with a timestamp from exactly `getCallbackTtlMs()` milliseconds ago
- AND a valid HMAC signature
- WHEN `verifyCallbackSignature(callbackId, payload, signatureHeader)` is called
- THEN the function MUST return `false`

#### Scenario: S-R3.3 — Callback at TTL minus 1ms is accepted

- GIVEN a `callbackId` with a timestamp from `getCallbackTtlMs() - 1` ms ago
- AND a valid HMAC signature
- WHEN `verifyCallbackSignature(callbackId, payload, signatureHeader)` is called
- THEN the function MUST return `true`

#### Scenario: S-R3.4 — Callback older than the TTL is rejected and logged

- GIVEN a `callbackId` with a timestamp from `getCallbackTtlMs() + 60_000` ms ago
- AND a valid HMAC signature
- WHEN `verifyCallbackSignature(callbackId, payload, signatureHeader)` is called
- THEN the function MUST return `false`
- AND the server SHOULD log a warning indicating the callback expired

---

### R4 (P0): HMAC Verification on Callback

The server MUST export a `verifyCallbackSignature(callbackId: string, payload: string, signatureHeader: string): boolean` function (see `apps/server/src/github/runner.ts`) that verifies the runner's callback signature. The verification MUST follow this exact sequence:

1. **Extract timestamp**: Parse the timestamp from the `callbackId` (everything after the last `.`). If no `.` exists, return `false`.
2. **Check TTL**: If `Date.now() - timestamp >= getCallbackTtlMs()`, return `false`.
3. **Derive secret**: Compute `deriveCallbackSecret(callbackId)`.
4. **Validate prefix**: The `signatureHeader` MUST start with `sha256=`. If not, return `false`.
5. **Compute expected**: Calculate `HMAC-SHA256(key=derivedSecret, data=payload)` and hex-encode.
6. **Compare**: Use `crypto.timingSafeEqual()` to compare the provided signature hex with the computed hex. Return the result.

The function MUST use timing-safe comparison to prevent timing attacks and MUST NOT throw on malformed input (invalid hex, mismatched lengths, etc.) — it MUST return `false`.

#### Scenario: S-R4.1 — Happy path: valid callbackId, valid signature

- GIVEN a `callbackId` with a recent timestamp
- AND `STATE_SECRET="my-server-secret"`
- AND the runner computed `callbackSecret = HMAC-SHA256("my-server-secret", callbackId)` (hex)
- AND the runner computed `signature = "sha256=" + HMAC-SHA256(callbackSecret, rawBody)` (hex)
- WHEN `verifyCallbackSignature(callbackId, rawBody, signature)` is called
- THEN the function MUST return `true`

#### Scenario: S-R4.2 — Tampered callbackId is rejected

- GIVEN a legitimate `callbackId` and its derived secret were used to sign a payload
- WHEN the `callbackId` is modified (e.g., UUID portion changed) before calling `verifyCallbackSignature`
- THEN the function MUST return `false` (the re-derived secret no longer matches what the runner used)

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

#### Scenario: S-R4.6 — Signature with wrong byte length is rejected

- GIVEN a valid `callbackId` and payload
- AND the signature is `"sha256=aabbccdd"` (only 4 bytes, not 32)
- WHEN `verifyCallbackSignature(callbackId, payload, signatureHeader)` is called
- THEN the function MUST return `false`

#### Scenario: S-R4.7 — Invalid hex in signature is rejected without throwing

- GIVEN a valid `callbackId` and payload
- AND the signature is `"sha256=zzzzzz"` (not valid hex)
- WHEN `verifyCallbackSignature(callbackId, payload, signatureHeader)` is called
- THEN the function MUST return `false`
- AND the function MUST NOT throw an exception

---

### R5 (P0): Callback Endpoint Contract — POST /runner/callback

The server MUST expose `POST /runner/callback` (see `apps/server/src/routes/runner-callback.ts`). The handler MUST:

1. Read the request body as text (preserved for HMAC verification of the exact bytes).
2. Parse the body as JSON. Malformed JSON MUST return HTTP 400 `{ "error": "Invalid JSON body" }`.
3. Validate the payload shape against `StaticAnalysisCallbackPayload`:
   - `callbackId: string`
   - `repoFullName: string`
   - `prNumber: number`
   - `headSha: string`
   - `staticAnalysis: StaticAnalysisResult`
4. Any missing field MUST return HTTP 400 `{ "error": "Missing required fields" }`.
5. Verify the `x-ghagga-signature` request header. A missing signature MUST return HTTP 401 `{ "error": "Missing signature" }`. A signature that fails `verifyCallbackSignature(...)` MUST return HTTP 401 `{ "error": "Invalid signature" }`.
6. On success, the handler MUST persist the static-analysis payload to Redis under `callbackResultKey(callbackId)` with TTL `CALLBACK_RESULT_TTL`, and return HTTP 200 `{ "ok": true }`.

The route MUST NOT log secrets, signatures, or full payload bodies. Only `callbackId`, `repoFullName`, `prNumber`, and the resolved tool key list are eligible for logging.

#### Scenario: S-R5.1 — Valid callback is stored and acknowledged

- GIVEN a runner dispatch with a recent `callbackId` and matching `STATE_SECRET`
- AND the runner POSTs a valid JSON payload to `/runner/callback`
- AND the runner sets `x-ghagga-signature: sha256=<valid-hmac>`
- WHEN the server processes the request
- THEN the server MUST write the static-analysis payload to Redis at `callbackResultKey(callbackId)`
- AND the response MUST be HTTP 200 `{ "ok": true }`

#### Scenario: S-R5.2 — Missing signature header returns 401

- GIVEN a valid JSON payload
- AND no `x-ghagga-signature` header
- WHEN the server processes the request
- THEN the response MUST be HTTP 401 `{ "error": "Missing signature" }`
- AND no Redis write MUST occur

#### Scenario: S-R5.3 — Missing required fields returns 400

- GIVEN a JSON payload missing `headSha`
- WHEN the server processes the request
- THEN the response MUST be HTTP 400 `{ "error": "Missing required fields" }`
- AND no signature verification MUST run for that request

#### Scenario: S-R5.4 — Malformed JSON returns 400

- GIVEN a request body that is not valid JSON
- WHEN the server processes the request
- THEN the response MUST be HTTP 400 `{ "error": "Invalid JSON body" }`

---

### R6 (P0): Replay Safety

A callback with a valid signature received more than once within the TTL window MUST be accepted by HTTP-layer verification (no one-time-use semantics are required at this layer). Downstream consumers (the BullMQ review worker) deduplicate via the Redis result key — the second write idempotently overwrites the same key, and the worker only consumes the result once.

After the TTL window elapses, replays MUST be rejected by the TTL check in R3.

#### Scenario: S-R6.1 — Replayed callback within TTL is accepted at HTTP layer

- GIVEN a callback was successfully processed and stored in Redis
- WHEN an attacker replays the identical request (same body, same signature) within the TTL
- THEN the server MUST return HTTP 200 `{ "ok": true }` (signature is still valid)
- AND the Redis write MUST be idempotent (same key, same value)

#### Scenario: S-R6.2 — Replayed callback after TTL is rejected

- GIVEN a callback was successfully processed
- WHEN the identical request is replayed after the TTL has expired
- THEN the server MUST return HTTP 401 `{ "error": "Invalid signature" }` (TTL check fails inside `verifyCallbackSignature`)

---

### R7 (P0): No In-Memory State

The system MUST NOT use any in-memory `Map`, `Set`, or similar data structure for callback secret storage. The runner module MUST NOT keep per-dispatch state at module scope.

`deriveCallbackSecret` and `verifyCallbackSignature` MUST be pure with respect to module-level state — they MUST derive every value they need from their arguments plus `process.env.STATE_SECRET` (and `process.env.CALLBACK_TTL_MINUTES` for the TTL).

#### Scenario: S-R7.1 — No Map or interval in module scope

- GIVEN the runner module source
- WHEN the module is loaded
- THEN there MUST be no `new Map()` call at module scope for callback state
- AND there MUST be no `setInterval` call at module scope for callback expiration

#### Scenario: S-R7.2 — Server restart does not affect callback verification

- GIVEN the server dispatched a workflow with a new-format `callbackId`
- AND the server process is restarted (or the container is redeployed)
- AND the same `STATE_SECRET` env var is configured
- WHEN the runner calls back within the TTL window
- THEN `verifyCallbackSignature` MUST return `true` and the callback MUST be processed normally

#### Scenario: S-R7.3 — Multiple server instances produce consistent verification

- GIVEN two server instances behind a load balancer share the same `STATE_SECRET`
- AND instance A dispatched a workflow
- WHEN the callback arrives at instance B
- THEN instance B's `verifyCallbackSignature` MUST return `true`
- AND the reason is that both instances derive the same secret from the same `STATE_SECRET` and `callbackId`

---

## Cross-Cutting Concerns

### CC1: Reuse of STATE_SECRET Environment Variable

The system MUST reuse the existing `STATE_SECRET` environment variable (already provisioned for the OAuth web flow). No new environment variables related to callback authentication are introduced.

1. `deriveCallbackSecret()` MUST read `process.env.STATE_SECRET` as its HMAC key.
2. The `STATE_SECRET` variable is shared with `generateState()` / `validateState()` in `apps/server/src/routes/oauth.ts`.
3. If `STATE_SECRET` is not defined, `deriveCallbackSecret()` MUST throw an error rather than silently producing an insecure derivation.

#### Scenario: S-CC1.1 — STATE_SECRET undefined causes a clear error

- GIVEN `process.env.STATE_SECRET` is `undefined`
- WHEN the server attempts to dispatch (which internally calls `deriveCallbackSecret`)
- THEN the function MUST throw an error with a message indicating `STATE_SECRET` is not configured
- AND the error MUST NOT be silently swallowed

#### Scenario: S-CC1.2 — STATE_SECRET undefined causes verification failure

- GIVEN `process.env.STATE_SECRET` is `undefined`
- WHEN `verifyCallbackSignature()` is called
- THEN the function MUST throw or return `false` (it MUST NOT accept the callback)

#### Scenario: S-CC1.3 — No new env vars are introduced for callback secrets

- GIVEN this spec is implemented
- WHEN the repository is inspected
- THEN there MUST be no new environment variable entries related to per-dispatch callback secrets in `.env.example`, documentation, or deployment configuration
- AND the existing `STATE_SECRET` entry MUST remain unchanged

---

## Integration Scenario

### Scenario: S-INT.1 — Full end-to-end inline-callback flow

- GIVEN `STATE_SECRET = "prod-secret-xyz"`
- AND a review pipeline dispatches the injected `ghagga.yml` workflow for `alice/my-repo` PR #42
- WHEN the server generates `callbackId = "<uuid>.<ts_base36>"`
- AND computes `callbackSecret = HMAC-SHA256("prod-secret-xyz", callbackId)`
- AND dispatches the workflow with `callbackUrl`, `callbackSecret`, `callbackId` as inputs
- AND the runner executes static analysis for 3 minutes
- AND the runner computes `signature = "sha256=" + HMAC-SHA256(callbackSecret, responseBody)`
- AND POSTs `/runner/callback` with header `x-ghagga-signature: <signature>` and body containing `callbackId`
- THEN the server extracts `callbackId` from the parsed body
- AND calls `verifyCallbackSignature(callbackId, rawBody, signature)`
- AND `verifyCallbackSignature` extracts the timestamp, confirms TTL (3 min < TTL)
- AND re-derives the secret: `HMAC-SHA256("prod-secret-xyz", callbackId)` — equal to the dispatch secret
- AND computes the expected signature `HMAC-SHA256(derivedSecret, rawBody)`
- AND `timingSafeEqual` confirms a match
- AND the function returns `true`
- AND the server writes the static-analysis payload to Redis at `callbackResultKey(callbackId)`
- AND the server returns HTTP 200 `{ "ok": true }`

---

## Acceptance Criteria Summary

| ID  | Priority | Requirement | Acceptance Criteria |
|-----|----------|-------------|---------------------|
| R1  | P0 | Stateless Secret Derivation | `deriveCallbackSecret` computes `HMAC-SHA256(STATE_SECRET, callbackId)` deterministically; 64-char hex output |
| R2  | P0 | CallbackId with Embedded Timestamp | Format `{uuid}.{timestamp_base36}`; dispatch generates this format |
| R3  | P0 | TTL Enforcement | Callbacks older than `getCallbackTtlMs()` rejected; boundary at exactly TTL rejects |
| R4  | P0 | HMAC Verification on Callback | `verifyCallbackSignature` re-derives, validates `sha256=` prefix, uses `timingSafeEqual`; never throws on malformed input |
| R5  | P0 | Callback Endpoint Contract | `POST /runner/callback` validates JSON + required fields + signature; persists to Redis; standard HTTP responses |
| R6  | P0 | Replay Safety | Replays within TTL idempotent at HTTP layer; replays after TTL return 401 |
| R7  | P0 | No In-Memory State | No `Map`/`setInterval` for callback state; pure derivation; survives restarts and scales horizontally |
| CC1 | P0 | Reuse STATE_SECRET | No new env vars; throws when `STATE_SECRET` is undefined |
