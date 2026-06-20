# Backlog

Tracked-but-deferred work. OPEN items at the top.

## OPEN

### BL-WEBHOOK-401-RETRY — webhook forge calls have no in-request 401 retry

The review worker (`apps/server/src/queues/review.ts`) wires an in-job bounded
401-retry on its postback: on a `ForgeAuthError` (HTTP 401/403) it
`invalidate()`s the credential provider, re-mints a fresh token, rebuilds the
adapter, and retries the postback ONCE (P2 401-recovery — restores P1's in-job
recovery after the P2 token-caching optimization).

The webhook handler (`apps/server/src/routes/webhook.ts`) does NOT do this, by
design: it mints a FRESH installation token per request (`getInstallationToken`,
no caching/TTL provider) and uses it within the SAME short-lived request, so
there is no mid-job window in which a CACHED token could be revoked before its
forge calls. Both webhook forge calls (`addReaction` ack + `fetchChangeRequest`)
are already wrapped in non-critical try/catch.

If the webhook ever adopts a cached `ForgeCredentialProvider` (e.g. shares the
review worker's `GitHubAppCredentialProvider`), mirror the postback's
`invalidate → re-mint → retry-once` block on its forge calls so the same
recovery applies. Until then this is a documented no-op, not a bug.
