# Backlog

Tracked-but-deferred work. OPEN items at the top.

## OPEN

### BL-HYBRID-4R-MODE — `hybrid-4r` review mode: lens depth × engine-family diversity, cleanly separated

Hybrid of the 4R lens protocol (risk/reliability/resilience/readability with
precision gate, batched refutation, ledger, scoped re-review) and the Nvr
cross-family pattern. The two diversify **orthogonal axes** — 4R by lens (deep,
single family), Nvr by training distribution (broad, no lens) — and today ghagga
can't express the combination without confounding them: `fan-out --lenses`
assigns engines to lenses round-robin from the chain, so if the security lens
lands on one family and misses, you can't attribute the miss (lens or family?).

Motivating incident (biogas-platform, 2026-07-28): a full 4R ran with 4 lenses
+ 3 refuters, all one family — the protocol's depth worked (2 CRITICALs found,
confirmed 3-0), but a prior precedent in the same codebase (biogas-v2) had the
inverse failure: 3 same-family voices returned CLEAN and a different-family
contrarian caught a HIGH in the same INSERT/UPSERT bug-class. Finder-level
family blind spots are real and no refutation stage can kill a finding nobody
found.

**Four features:**

1. **Explicit lens→engine pinning.** Declare "all 4R lenses go to family X"
   plus "contrarian voices (no lens, whole diff) go to families Y, Z". Kills
   the round-robin confound; every miss becomes attributable to exactly one
   axis.
2. **Refutation stage.** Two-phase pipeline: merge lens+contrarian ledgers →
   filter BLOCKER/CRITICAL → dispatch the **complete** candidate list to K
   refuters (one per family, batched — never one task per finding) → per-finding
   2-of-K vote; malformed/missing verdict defaults to `stands`.
3. **Ledger as a first-class structured contract** (id/lens/location/severity/
   status/evidence), schema-validated per voice, so merge, refutation and
   scoped re-review (fix diff + ledger only, max 2 rounds) are mechanical.
   Persisted ledgers also yield **per-family metrics** (hit rate, FP rate by
   voice/lens) — turning engine selection into data instead of intuition.
4. **Enforced anchoring.** `--anchor <sha>`: checkout/worktree the exact commit
   before any engine sees the diff; refuse the review if an engine can't see
   that tree. Hard-codes the rule "couldn't grep it is NEVER refutation"
   (learned the hard way: refuters once graded a stale ancestor tree and
   declared real code fictional).

**Sketch:**

```json
{ "mode": "hybrid-4r",
  "lensFamily": "claude-cli",
  "contrarians": ["codex-cli:gpt-5.5", "opencode-cli:kimi-k2.7-code"],
  "refuters": ["claude-cli", "codex-cli", "opencode-cli:kimi-k2.7-code"],
  "refuteRule": "2-of-3", "anchor": "auto" }
```

**Lensed contrarians (operator-validated variant).** The operator's lived
evidence from the manual Nvr era is that family diversity paid off at the
*finder* level — "what one family didn't see, another did". So contrarians
should support carrying the **full 4R lens prompt-pack in a single pass**
(`"contrarians": [{"engine": "codex-cli:gpt-5.5", "lenses": "4r-pack"}]`):
family B reads the diff through the same four lenses as family A, in one call
instead of four deep reviews. This captures cross-family finder coverage at
1-2 calls; the full 4-lenses×2-families matrix stays reserved for the top
tier, where same-lens×2-families duplication is the highest-confidence signal.

**Scaling doctrine (tiers, cheapest-independent axis first):** scale
contrarians first (1 call each, near-orthogonal coverage), then refuter
*diversity* (3 distinct families beats 5 voices — a refuter grades a closed
list; the 5th opinion duplicates one of the first 3), and only at the top
duplicate the expensive correlated axis (a 2nd full lens-family) for
money/RLS/auth pre-prod gates, where same-lens×2-families duplication becomes a
high-confidence auto-fix signal. 3 lens-families: reserved for irreversible
changes (destructive migrations, crypto); otherwise that budget pays more as a
3rd contrarian.

Validation plan agreed with the operator: run the hybrid once **manually**
(orchestrator-driven, cross-family voices via the bridge) on the next real
pre-prod review of biogas-platform; codify as a ghagga mode with what that run
teaches. (Filed 2026-07-28 from the biogas demo-plant 4R session.)

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

## RESOLVED

### BL-ACTION-BUNDLE-REBUILD — rebuild `apps/action/dist` before the next release

**Status: RESOLVED** on `chore/release-readiness-closeout` by running
`pnpm --filter @ghagga/action build` with TypeScript 6.0.3 and
`@vercel/ncc` 0.44.1.

The committed Action bundle already contained the SARIF stdout fix from
`fa934d8`, but it had not been rebuilt after the semantic-memory series
(#293-#300, planned in #291). The regenerated `apps/action/dist/index.js` now
contains both contracts:

- static-analysis progress and diagnostics are routed to stderr, preserving
  machine-readable SARIF/JSON on stdout; and
- the Action includes the current semantic-memory provider/configuration and
  storage code while continuing to exclude the optional local
  `@xenova/transformers` dependency.

`action.yml` still intentionally consumes the committed pre-built bundle. The
release workflow builds packages for publication but does not commit generated
artifacts, so future source changes that affect the Action still require an
explicit bundle rebuild before release.

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
