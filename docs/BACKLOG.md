# Backlog

Tracked-but-deferred work. OPEN items at the top.

## OPEN

### BL-SARIF-STDOUT — static-analysis tools write to stdout, corrupting `--output sarif`

The core static-analysis tools (`packages/core/src/tools/{runner,semgrep,cpd}.ts`)
write progress/diagnostic output to stdout. When the CLI is run with
`--quick --output sarif`, that tool stdout INTERLEAVES with the SARIF JSON the
command emits on stdout, so a CI consumer can receive MIXED/corrupt SARIF.

PRE-EXISTING and ORTHOGONAL to the forge work (Fix-Between-SDDs) — it predates
the `--pr` post-back and is not introduced by it. Surfaced during the P3 4vr
review. NOTE: it makes the `--pr` + SARIF CI scenario's MACHINE output (the SARIF
artifact) unreliable until fixed, even though the human-readable post-back is
fine. Fix = route tool stdout to stderr (or a buffer) so stdout carries ONLY the
chosen `--output` payload. Do NOT fix inside a forge diff.

### BL-CLI-FORGE-COMPOSITION — extract a generic forge post-back helper for P4

`resolvePrToken` / `handlePrPostback` (apps/cli) are GitHub-shaped: token
resolution, remote parsing (`parseGitHubRemote`), adapter construction
(`GitHubForgeAdapter`), and ref building all assume GitHub. P4's `--mr` (GitLab)
should NOT duplicate this. Extract a generic
`resolve-token → parse-remote → build-adapter → make-ref → post` helper
parameterized by forge kind, so `--pr` and `--mr` are thin wrappers. The neutral
seam (`postSummaryComment`) is already forge-agnostic (P3 FIX 2); this is the
COMMAND-GLUE layer above it. Defer to P4.

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
