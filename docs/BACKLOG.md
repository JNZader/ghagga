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

## RESOLVED

### BL-ERE-TRANSFER — import ERE's evidence discipline into the triage path

**Status: RESOLVED** as an umbrella. Sub-items already shipped:
BL-TRIAGE-QUEUE-ATOMIC, BL-TRIAGE-CITED-VERDICT, BL-TRIAGE-SERVER-CODE-BLIND
(plus follow-ons code-fence / search-discovery). Hybrid-4r ledger + `--anchor`
landed on the review path separately (#408, #410).

Still policy, not OPEN work: do not port ERE's 8-stage lifecycle, bwrap sandbox,
`duplicate` disposition, or verdict determinism. The content-addressed
re-triage baseline stays unfiled until re-triage-from-zero is an LLM-cost pain.

### BL-HYBRID-4R-MODE — `hybrid-4r` review mode: lens depth × engine-family diversity

**Status: RESOLVED** as composable fan-out, not a second engine. Shipped:

- `pinLensesToFirst` (#406) — all lenses use `generateFns[0]`
- `contrarianCount` (#407) — unlensed voices on `generateFns[1..N]`
- finding ledger stamp (#408) — `id`/`lens`/`location`/`ledgerStatus`/`evidence`
- batched `refuterCount` 2-of-K (#409) — critical findings only
- fail-closed `--anchor <sha>` (#410) — HEAD must match; **no** checkout/worktree
- `mode: hybrid-4r` — sugar: fan-out + pin forced on; metadata.mode stays `fan-out`

Not in this BL (follow-ups): 4R-pack lensed contrarians, scoped re-review,
persisted per-family metrics, dashboard mode list, Action dist rebuild.

### BL-TRIAGE-SEARCH-DISCOVERY — find referenced code by identifier, not just explicit path

**Status: RESOLVED** in current `main` (worker + forge + core already shipped;
this entry was stale OPEN copy). Path discovery remains `discoverCodePaths`;
when it finds fewer than 2 paths, `discoverSearchTerms` (backtick identifiers,
ReDoS-hardened) drives sequential `adapter.searchCode` (`issue-code-evidence.ts`,
`client.searchCode`, capability-gated). Faults degrade, never abort triage.
`getTree` was listed in the original sketch and was **not** implemented — search
by identifier does not need a git tree walk. No extra slice here.

### BL-TRIAGE-CODE-FENCE — give issue triage a dedicated fenced source-code input (not the memory channel)

**Status: RESOLVED** by commit `e0cf70e`. Fetched source no longer rides the
`memoryContext` channel (whose framing tells the model to discount it for
flagging and cites a nonexistent "diff"). It now has its own optional
`sourceCode` fenced input on `runIssueTriage`, mirroring `reproductionEvidence`:

- `prompts.ts`: `SOURCE_CODE` added to `BOUNDARY_MARKERS`; `wrapUntrustedSourceCode`
  (`<SOURCE_CODE>`, tag boundary, no inner code fence); `UNTRUSTED_CONTENT_POLICY`
  + `ISSUE_TRIAGE_SYSTEM` declare the channel and instruct the model to USE the
  code to VERIFY the claim while treating instruction-like text in it as DATA; the
  SOURCES contract now admits a source file/line as a citable source.
- `issue-triage.ts`: optional `sourceCode?: string|null` + `buildIssuePrompt`
  emits the block. Both call sites (server `issue-analysis.ts`, CLI `run.ts`) pass
  `sourceCode` instead of folding into `memoryContext` (now pure dedup context).

Two blind adversarial reviews (security + correctness) confirmed byte-parity with
`<REPRO_EVIDENCE>` (forged own-tag AND cross-marker boundaries defanged) and that
moving attacker bytes out of the system prompt into the user prompt IMPROVES
injection posture. Corrections folded: SOURCES-contract update (so "cite the code"
is representable), stale comments corrected, cross-marker-defang +
system-declaration + CLI memory-passthrough tests added. Verified: core 3885,
triage-engine 240, server 784, cli 578 — monorepo green.

### BL-TRIAGE-SERVER-CODE-BLIND — server-side triage has no code access; add remote code-fetch

**Status: RESOLVED** — the checkout-less webhook triage worker now reads the code
an issue references. Shipped as a 4-part slice, each part its own adversarially-
reviewed commit:

- **Part 1 (`9246edb`) — the forge file-read capability (security foundation).**
  Optional `FileReadCapable.fetchFileContents(repo, path, ref?)` on the forge
  adapter (method-presence narrowed); real HTTP is `client.fetchFileContents`
  (GitHub Contents API, JSON+base64), ported from ERE `github-code.ts` with the
  full hardening (owner/repo/ref validated, path traversal-guarded + double-
  encoded, file-vs-dir → null, 512KiB cap, 404 → null, faults → GitHubApiError),
  locked `@internal` in the forge-boundary lint. Two blind reviews confirmed the
  path/URL-injection defense airtight.
- **Part 2 (`edb9bed`) — `discoverCodePaths`** in `ghagga-core` (deterministic,
  ReDoS-hardened path-token extraction from issue text).
- **Parts 3-4 (`a310779`) — the formatter + wiring.** `collectIssueCodeEvidence`
  (`apps/server/src/queues/issue-code-evidence.ts`) discovers paths → mints an
  installation token → fetches concurrently at the default branch (empty ref) →
  assembles within a char budget → the worker folds it into `memoryContext`.
  Best-effort: every failure (no paths / no creds / mint fail / per-file fault)
  degrades to text-only; never blocks or crashes triage.

SECURITY (confirmed by review): the fetched bytes are attacker-influenceable but
fold into `memoryContext`, fenced as untrusted DATA via `buildMemoryContext` /
`wrapUntrusted` (defangs forged boundary markers) — no fence break-out; token/key
never logged; ≤6 files + exactly 1 mint per triage. Review corrections folded in:
concurrent fetch (job-lock safety), honest char/file budget + logging (no silent
truncation / over-reporting). Follow-up tracked as **BL-TRIAGE-CODE-FENCE** (a
dedicated `sourceCode` fenced input beats the memory channel). Verified: server
784/784, forge + core green, monorepo typecheck.

### BL-TRIAGE-QUEUE-ATOMIC — `queue.json`: non-atomic write + silent corrupt-swallow → draft loss / double-post

**Status: RESOLVED** by commit `06215f2`. `saveQueue`
(`packages/triage-engine/src/queue/store.ts`) now writes to a temp file then
`renameSync`s over the target (atomic on POSIX), and `loadQueue` distinguishes a
missing file (fresh `{}`) from a corrupt-but-present one (throws loudly, naming
the risk of dropping POSTED state) instead of silently returning `{}` over any
read/parse error. The parallel CLI audit-history writer
(`apps/cli/src/commands/audit.ts`) got the same atomic write; its corrupt-read
path now WARNS and resets rather than silently wiping (non-critical trend data,
so it doesn't abort the save). Its store test that encoded the old bug as
expected behavior ("corrupt JSON → empty object") was flipped to assert the loud
throw; +2 atomicity tests. Verified: triage-engine 239/239, monorepo typecheck
green.

### BL-TRIAGE-CITED-VERDICT — fail-closed triage verdict with a cite-or-abstain gate

**Status: RESOLVED** by commit `d5a4950`. `runIssueTriage`
(`packages/core/src/agents/issue-triage.ts`) now runs a fail-closed citation
gate: an actionable classification (`bug`/`feature`) that cites NO source has its
confidence withheld (→ 0) so the Phase-4 threshold routes the draft to the
hold-for-human channel (NEEDS_INFO), with a transparent note appended to the
report. Modeled on ERE's `UNCITED_OUTCOME`.

Two blind adversarial reviews (opus) reshaped the first cut — recorded here
because both corrections matter:
- **It is a PRESENCE check, not a ref/evidence check.** The first cut required a
  non-empty `ref`, which would have wrongly held a legitimately-cited first-report
  bug: the prompt (`prompts.ts:342/365`) accepts an *issue excerpt* (which has no
  natural `ref`) as a valid citation. And there is no evidence corpus at this seam
  to validate that a ref resolves. So the gate only catches a verdict that cites
  literally nothing — the honest limit of a presence check, and the comments say
  so rather than overselling the ERE analogy.
- **The classification is PRESERVED, not rewritten to `question`.** The hold is
  carried entirely by the zeroed confidence; flipping the class bought no routing
  change (the server routes on confidence, the CLI drops the class) and would have
  corrupted the dedup/telemetry signal.
- The reviews also caught that the gate was silently masking four `parseConfidence`
  regression tests (uncited-bug fixtures); those now cite a source so they isolate
  the parser again, and the out-of-range clamp assertion was tightened to the exact
  value.

Known scope (accepted, LOW): a fabricated/self-referential source line still
passes the presence check (can't be validated here); the report note flows into
the client-reply generator, but that path is draft-only and human-gated. NOT
done here (a separate, larger change): persisting classification/confidence into
the DB draft so the dashboard can sort by merit. Verified: issue-triage 49/49,
core 3870/3871, triage-engine 239/239, server issue-analysis 22/22, typecheck
green.

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
