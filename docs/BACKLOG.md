# Backlog

Tracked-but-deferred work. OPEN items at the top.

## OPEN

### BL-GITLAB-MR-WRITE-E2E — run the GitLab `--mr` write-path live, against a real instance

The `--mr` (GitLab MR post-back) path is fully unit/contract-tested
(fetch-mocked) and was validated **read-only** against live gitlab.com on
2026-06-20 (real auth handshake + typed-error surfacing; the deploy-token in use
had no `api` scope, so it returned a typed `GitLabApiError(status:403)` as
expected). The **write path** (resolve project id → upsert a summary note on a
real MR) has **never run against a live GitLab instance** — it is the only real
verification gap remaining on v3.1.0.

The live gate is the `skipIf(!GITLAB_PAT)` manual test
`apps/cli/src/lib/gitlab-e2e.manual.test.ts`. As of PR #273 it is hardened
(4vr-gated): `afterAll` best-effort cleanup, self-hosted wiring via the
production `resolveGitLabApiBase` helper, a marker assertion **anchored to the
note production created** (the prior `.some(...)` was circular — the marker is
caller-owned, the adapter only uses it to FILTER the sweep at
`gitlab-forge-adapter.ts:182`), and an idempotency-fold assertion against real MR
state (exactly one marker note remains after the repost). `typecheck` passes.

FIX (needs operator inputs, not a code change): a PAT with the `api` scope + an
OPEN, throwaway MR, then run:

```bash
GITLAB_PAT=… GITLAB_E2E_PROJECT=group/proj GITLAB_E2E_MR=<open iid> \
  pnpm --filter ghagga exec vitest run src/lib/gitlab-e2e.manual.test.ts
```

If it fails against real GitLab → patch 3.1.1 (the code is already 4vr-hardened,
so the risk is low). (Deferred here pending the PAT + throwaway MR.)

### BL-ACTION-BUNDLE-REBUILD — rebuild `apps/action/dist` to pick up the SARIF-stdout fix (#4)

The GitHub Action consumes a **manually-committed** pre-built bundle:
`action.yml` (`runs.main: 'apps/action/dist/index.js'`) points at the committed
`apps/action/dist/index.js`, and `apps/action/.gitignore` deliberately
un-ignores `dist/` ("GitHub Actions requires dist/ to be committed"). The bundle
inlines `ghagga-core` via `ncc`, so it still carries the OLD core static-analysis
diagnostics (`console.log`) that the #4 fix (BL-SARIF-STDOUT, commit `fa934d8`)
moved to stderr. **The Action consumer therefore still pollutes stdout** despite
the source fix.

This is the manually-committed-stale-artifact case, NOT auto-rebuilt:
`publish.yml` (`on: release`) runs `pnpm turbo build` (which DOES regenerate
`dist` via the action's `ncc build` script) but ONLY to publish the npm packages
— it does **not commit the rebuilt `dist` back to the repo**, and no other
workflow re-commits it. So the bundle the Action runs (`JNZader/ghagga@v…` →
committed `dist`) stays stale until someone rebuilds and commits it.

FIX: before the next Action release, run `pnpm --filter @ghagga/action build`
(`ncc build src/index.ts -o dist …`) and commit the regenerated
`apps/action/dist/`. (Deferred here per the no-build rule.) Optionally, codify a
release step that rebuilds + commits `dist` so it can't drift again.

## RESOLVED

### BL-SARIF-STDOUT — static-analysis tools write to stdout, corrupting `--output sarif`

**Status: RESOLVED** by commit `fa934d8` — core static-analysis tool
diagnostics (`execution.ts` default logger + `runner`/`semgrep`/`cpd`) routed
stdout→stderr so `--output sarif` stdout is clean. Verified real-usage
(jq-clean before/after). Server unaffected (uses `pino`, not core's default
logger).

The core static-analysis tools (`packages/core/src/tools/{runner,semgrep,cpd}.ts`)
wrote progress/diagnostic output to stdout. When the CLI is run with
`--quick --output sarif`, that tool stdout INTERLEAVED with the SARIF JSON the
command emits on stdout, so a CI consumer could receive MIXED/corrupt SARIF.

PRE-EXISTING and ORTHOGONAL to the forge work (Fix-Between-SDDs) — it predated
the `--pr` post-back and was not introduced by it. Surfaced during the P3 4vr
review. NOTE: it made the `--pr` + SARIF CI scenario's MACHINE output (the SARIF
artifact) unreliable until fixed, even though the human-readable post-back is
fine. Fix = route tool stdout to stderr (or a buffer) so stdout carries ONLY the
chosen `--output` payload.

### BL-WEBHOOK-401-RETRY — webhook forge calls have no in-request 401 retry

**Status: RESOLVED (by-design / won't-fix) — a bounded 401-retry adds no real
value for the webhook; closed with a diagnostic-logging improvement instead.**

The review worker (`apps/server/src/queues/review.ts`) wires an in-job bounded
401-retry on its postback BECAUSE it CACHES the installation token across a
long-running poll: a cached token can go stale mid-job, so on a `ForgeAuthError`
(HTTP 401/403) it `invalidate()`s the provider, re-mints, and retries ONCE.

The webhook handler (`apps/server/src/routes/webhook.ts` issue_comment) is
structurally different: it mints a FRESH installation token PER REQUEST
(`getInstallationToken`, no caching/TTL provider) and uses it within the SAME
short-lived request. A 401/403 on a token minted milliseconds ago is therefore a
GENUINE revocation/suspension/permission change — re-minting another fresh token
and retrying would MOSTLY fail the SAME way. The only window an in-request
re-mint could recover is a permission/token change racing BETWEEN the two forge
calls of a single request (astronomically rare). So a bounded re-mint+retry here
is pure scope with effectively no window to protect — NOT worth the code.

The proportionate fix shipped instead (commit on `feat/forge-backlog-cleanup`):
both webhook forge calls (`addReaction` ack + `fetchChangeRequest`) stay
NON-CRITICAL (a failure never fails the review), AND a `ForgeAuthError` (401/403)
is now SURFACED as a CLEAR, diagnosable `logger.error` ("installation token
rejected; check the GitHub App installation/permissions for this repo") via an
`isForgeAuthError(error)` branch — instead of being lumped into a generic
"failed" warn. A test (`handles a forge 401 on a freshly-minted token
gracefully`) confirms a 401 on both calls does not crash the webhook and the
review still dispatches (202).

RE-OPEN ONLY IF the webhook ever adopts a cached `ForgeCredentialProvider`
(e.g. shares the review worker's `GitHubAppCredentialProvider`). Then a CACHED
token COULD go stale mid-request and the worker's `invalidate → re-mint →
retry-once` block would have a real window to protect — mirror it on the webhook
forge calls at that point.

### BL-CLI-FORGE-COMPOSITION — extract a generic forge post-back helper for P4

**Status: RESOLVED** by P4 (commit `558c21e`, "feat(cli): add ghagga review
--mr (GitLab) via shared composition helper (P4)").

`resolvePrToken` / `handlePrPostback` (apps/cli) were GitHub-shaped: token
resolution, remote parsing (`parseGitHubRemote`), adapter construction
(`GitHubForgeAdapter`), and ref building all assumed GitHub. P4's `--mr` (GitLab)
should NOT duplicate this. The fix extracted a generic
`resolve-token → build-adapter+ref → post` helper parameterized by forge kind,
so `--pr` and `--mr` are thin wrappers.

Resolved by `composeForgePostback` in `apps/cli/src/lib/forge-postback.ts`: it
captures the SHARED pipeline once (`resolveToken → buildComposition → post`
via the forge-neutral `postSummaryComment`), with the forge-specific steps
(token env vars, remote→`RepoRef` parsing, adapter construction, project-id
resolution) injected through a `ForgeCompositionBuilder`. Both the `--pr`
(GitHub) and `--mr` (GitLab) command glue now route through it instead of each
hand-rolling the composition. Adding a third forge (Gitea) is a new builder, not
a new branch.
