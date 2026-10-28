# Proposal: Stateless Callback Secret Verification

## Intent

The runner callback authentication uses an in-memory `Map<string, StoredSecret>` in `apps/server/src/github/runner.ts` (lines 103-197) to store per-dispatch HMAC secrets with an 11-minute TTL. When a workflow is dispatched, a random 32-byte secret is generated, stored in the Map, and sent to the runner. When the runner calls back 2-5 minutes later, the server looks up the secret by `callbackId` and verifies the HMAC signature.

This breaks on Render's free tier: the container redeploys on every `git push` and spins down after 15 minutes of inactivity. If a redeploy occurs during the dispatch-to-callback window, the in-memory Map is wiped, the callback receives 401 Unauthorized, and the review results are permanently lost. The Inngest `waitForEvent` eventually times out and the user gets an LLM-only review with all static analysis marked as "skipped" -- despite the tools having run successfully.

The fix is to replace the stateful secret store with a stateless HMAC derivation, using the same pattern already proven in `apps/server/src/routes/oauth.ts` (`generateState`/`validateState`).

## Scope

### In Scope

- **`apps/server/src/github/runner.ts`**: Remove the in-memory `secretStore` Map, `StoredSecret` interface, `storeCallbackSecret()`, `verifyAndConsumeSecret()`, and the cleanup `setInterval`. Replace with two stateless functions: `deriveCallbackSecret(callbackId)` and `verifyCallbackSignature(callbackId, payload, signatureHeader)`.
- **`apps/server/src/github/runner.ts` `dispatchWorkflow()`**: Change secret generation from `randomBytes(32)` to deterministic `HMAC-SHA256(STATE_SECRET, callbackId)`. Embed a timestamp in the `callbackId` for TTL enforcement.
- **`apps/server/src/routes/runner-callback.ts`**: Update import from `verifyAndConsumeSecret` to the new `verifyCallbackSignature`. No other route logic changes needed.
- **`apps/server/src/github/runner.test.ts`**: Rewrite the `storeCallbackSecret / verifyAndConsumeSecret` test group (~70 test references) to test the new stateless functions.
- **`apps/server/src/routes/runner-callback.test.ts`**: Update the mock from `verifyAndConsumeSecret` to `verifyCallbackSignature`. Mock signature and test behavior are otherwise identical.

### Out of Scope

- **OAuth state helpers** (`oauth.ts`): No changes. These are the precedent, not the target.
- **Runner repo creation** (`createRunnerRepo()`): Unchanged. The `GHAGGA_CALLBACK_SECRET` repo secret set during creation is no longer per-dispatch; it can be removed or repurposed in a follow-up.
- **`apps/action/`**: Self-hosted Action mode is unaffected (different auth path).
- **CLI / 1-click deploy modes**: Unaffected (no callback flow).
- **Dashboard UI**: No changes.
- **Inngest functions**: The `ghagga/runner.completed` event schema and `waitForEvent` correlation are unchanged.

## Approach

### Stateless HMAC Derivation (same pattern as OAuth `generateState`)

The existing `generateState()` in `apps/server/src/routes/oauth.ts` (line 37) already implements exactly this pattern:

```typescript
// oauth.ts — existing, proven pattern
export function generateState(secret: string): string {
  const timestamp = Date.now().toString(36);
  const hmac = createHmac('sha256', secret).update(timestamp).digest('hex');
  return `${timestamp}.${hmac}`;
}
```

We apply the same principle to callback secrets:

**1. Embed timestamp in `callbackId`**

Currently `callbackId` is a plain `randomUUID()` (runner.ts line 321). Change to:

```
callbackId = `${randomUUID()}.${Date.now().toString(36)}`
```

The UUID provides uniqueness; the base36 timestamp enables stateless TTL enforcement.

**2. Derive secret deterministically**

Instead of `randomBytes(32)`, compute:

```typescript
function deriveCallbackSecret(callbackId: string): string {
  const STATE_SECRET = process.env.STATE_SECRET;
  return createHmac('sha256', STATE_SECRET).update(callbackId).digest('hex');
}
```

The derived secret is sent to the runner (via dispatch inputs and GitHub Actions secret) exactly as before. The runner uses it to compute the HMAC signature over its response body. Nothing changes on the runner side.

**3. Verify on callback by recomputing**

```typescript
function verifyCallbackSignature(
  callbackId: string,
  payload: string,
  signatureHeader: string,
): boolean {
  // 1. Extract and validate timestamp from callbackId
  const dotIndex = callbackId.lastIndexOf('.');
  if (dotIndex === -1) return false;
  const timestamp = parseInt(callbackId.slice(dotIndex + 1), 36);
  if (Date.now() - timestamp > CALLBACK_SECRET_TTL_MS) return false;

  // 2. Recompute the same secret
  const secret = deriveCallbackSecret(callbackId);

  // 3. Verify HMAC signature (same logic as current verifyAndConsumeSecret)
  const expectedPrefix = 'sha256=';
  if (!signatureHeader.startsWith(expectedPrefix)) return false;
  const signatureHex = signatureHeader.slice(expectedPrefix.length);
  const computed = createHmac('sha256', secret).update(payload).digest('hex');
  return timingSafeEqual(Buffer.from(signatureHex, 'hex'), Buffer.from(computed, 'hex'));
}
```

**4. Reuse `STATE_SECRET` env var**

The `STATE_SECRET` environment variable already exists and is deployed on Render (used by OAuth web flow). No new secrets to provision.

### Replay Protection

The current in-memory store provides one-time-use semantics by deleting the secret after verification. With the stateless approach, the secret can be recomputed indefinitely within the TTL window.

This is acceptable because Inngest's `waitForEvent` with `callbackId` correlation already provides exactly-once consumption:
1. The Inngest function calls `waitForEvent("ghagga/runner.completed", { match: "data.callbackId" })`.
2. The first matching event resumes the function and the wait step is consumed.
3. Any replayed callback emits a duplicate Inngest event, but there is no waiting step to match -- the event is silently dropped.

A replayed callback would still pass HMAC verification and return `200 OK`, but the Inngest event it emits has no effect. This is the same security posture as any webhook with HMAC auth (e.g., GitHub webhooks themselves are replayable within the secret's lifetime).

## Affected Areas

| File                                             | Change                                                                                                                                                                                                   | Lines Affected                           |
| ------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------- |
| `apps/server/src/github/runner.ts`               | Remove `secretStore` Map, `StoredSecret`, `storeCallbackSecret()`, `verifyAndConsumeSecret()`, cleanup interval. Add `deriveCallbackSecret()`, `verifyCallbackSignature()`. Modify `dispatchWorkflow()`. | Lines 103-197 (delete), 321-325 (modify) |
| `apps/server/src/routes/runner-callback.ts`      | Change import: `verifyAndConsumeSecret` -> `verifyCallbackSignature`                                                                                                                                     | Line 22, 67                              |
| `apps/server/src/github/runner.test.ts`          | Rewrite secret store tests to test stateless functions                                                                                                                                                   | ~60 lines across multiple test cases     |
| `apps/server/src/routes/runner-callback.test.ts` | Update mock name                                                                                                                                                                                         | Line 17                                  |

## Risks

| Risk                                                | Likelihood | Impact | Mitigation                                                                                                                                                                                                                                                                                |
| --------------------------------------------------- | ---------- | ------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Replay attacks within TTL window**                | Low        | Low    | Inngest `waitForEvent` correlation ensures exactly-once processing. Replayed events find no waiting step and are dropped. Same model as GitHub webhooks.                                                                                                                                  |
| **`STATE_SECRET` rotation**                         | Low        | Medium | Rotating `STATE_SECRET` invalidates all in-flight callbacks (same risk as current approach with redeploys). Document that rotation should happen during low-traffic windows. Could add support for accepting both old and new secrets during rotation, but this is out of scope.          |
| **`STATE_SECRET` compromise**                       | Very Low   | High   | If `STATE_SECRET` leaks, an attacker can forge callback signatures. Identical risk profile to the OAuth state flow. Mitigation: standard secret management hygiene, Render env var encryption.                                                                                            |
| **Clock skew on `callbackId` timestamp**            | Very Low   | Low    | Both timestamp creation and validation happen on the same server. Even across redeploys, system clock drift on Render is negligible.                                                                                                                                                      |
| **Old-format `callbackId` in flight during deploy** | Medium     | Low    | During the deploy that ships this change, any callback with an old-format `callbackId` (no embedded timestamp) will fail `verifyCallbackSignature`. This is acceptable: the same scenario (redeploy losing state) already causes failure today, and the window is identical (~5 minutes). |

## Rollback Plan

This change is trivially reversible:
1. **Revert the commit**: Restores the in-memory `secretStore` Map and all associated functions.
2. **Deploy**: No data migration, no schema changes, no env var changes.
3. **In-flight callbacks**: Any callbacks dispatched with the stateless scheme during the brief window will fail verification (the server no longer derives secrets the same way). This is the exact same failure mode the change is designed to fix -- and the Inngest timeout fallback handles it gracefully.

**Rollback time**: < 5 minutes (single revert + deploy).

## Dependencies

- **`STATE_SECRET` env var**: Already provisioned on Render for OAuth web flow. No new configuration needed.
- **No new npm dependencies**: Uses only `node:crypto` (`createHmac`, `timingSafeEqual`), already imported.
- **No infrastructure changes**: No new services, databases, or env vars.

## Success Criteria

- [ ] Server redeploy during an active dispatch-to-callback window does NOT cause 401 on the callback
- [ ] No in-memory state is used for callback secret storage (the `secretStore` Map is fully removed)
- [ ] `verifyCallbackSignature` recomputes the secret from `STATE_SECRET` + `callbackId` and verifies the HMAC
- [ ] Callbacks older than 11 minutes are rejected via the embedded timestamp (TTL enforcement)
- [ ] All existing runner callback tests pass (adapted to new function signatures)
- [ ] The `dispatchWorkflow` function no longer calls `storeCallbackSecret`
- [ ] The `callbackId` format includes an embedded timestamp (e.g., `{uuid}.{timestamp_base36}`)
- [ ] The derived `callbackSecret` sent to the runner produces the same HMAC signature the server expects on callback
- [ ] No changes to the runner workflow YAML or the `ghagga-runner-template` repo are needed

## Distribution Mode Impact

| Mode                     | Impact    | Notes                                               |
| ------------------------ | --------- | --------------------------------------------------- |
| **SaaS** (webhook)       | Fixed     | Callbacks now survive server restarts and redeploys |
| **Action** (self-hosted) | No change | Does not use callback flow                          |
| **CLI**                  | No change | Does not use callback flow                          |
| **1-click deploy**       | No change | Does not use callback flow                          |
