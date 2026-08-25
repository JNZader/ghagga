# Backlog

Tracked-but-deferred work. OPEN items at the top.

## OPEN

### BL-ERE-TRANSFER — import ERE's evidence discipline into the triage path (provenance + strategic frame)

Umbrella entry for a small family of transfers from the **evidence-review-engine**
(ERE, `~/programacion/ere-reviewer-authority-hardening-v2`) — a sibling project
that is a content-addressed *verification kernel* for auditing an issue backlog
against real code. This entry records where the sub-items came from, the
strategic call, and what NOT to port. Sub-items: BL-TRIAGE-QUEUE-ATOMIC,
BL-TRIAGE-CITED-VERDICT, BL-TRIAGE-SERVER-CODE-BLIND.

**Provenance (2026-08-25):** three blind agents (fable/opus/sonnet), each reading
BOTH codebases independently with no shared context, then cross-checked. Only
findings that survived the cross-check (or were verified by hand) are recorded
here — single-voice claims were re-read against the source before filing.

**Strategic call — different centers of gravity, transfer discipline not
machinery.** ghagga is a *delivery* product: three surfaces (Server/Action/CLI),
BullMQ workers, a human-approval dashboard, an injection-defense layer, and a
trust model that is *human-in-the-loop* (nothing auto-posts —
`packages/triage-engine/src/engine.ts`). ERE is a *verification kernel*: its
trust model is *cryptographic* (a verdict is invalid unless it cites
content-addressed frozen evidence, and a baseline is invalid unless the real
verifier re-derives every digest). Merging them wholesale would bolt a
manifest-verifying lifecycle onto a system whose actual guarantee is "a human
read the draft". The right relationship: ERE stays the R&D bench where the
verification *contracts* get proven; ghagga imports the contracts (fail-closed
verdict schema, cite-or-abstain gate, atomic persistence, revision pinning) as
ordinary TypeScript — without the manifest/promote kernel.

**Note this cuts toward what ghagga already wants:** BL-HYBRID-4R-MODE
independently specifies a schema-validated ledger (feature 3) and `--anchor
<sha>` frozen-tree anchoring (feature 4) as *unbuilt* future work — ERE ships
tested implementations of both ideas. These triage transfers are the same
discipline arriving on the triage path first, where the gap is widest.

**Anti-recommendations (do NOT do these):**

1. **Do not port ERE's 8-stage lifecycle** (`collect→freeze→diff→impact→assess→
   adjudicate→verify→promote`) into triage. Triage's unit of work is one issue →
   one human-approved draft; a per-draft promoted baseline verifies nothing a
   human isn't already gating.
2. **Do not sandbox** (ERE's bwrap template) ghagga's static-analysis tools yet.
   ghagga runs them directly *by design* (`docs/architecture.md` — "no separate
   microservices … no SSRF concerns"); there is no untrusted-local-compute threat
   today, and the real injection surface (untrusted issue text) is already fenced
   in `packages/core/src/agents/issue-triage.ts`. Revisit only if ghagga starts
   running tools against fully untrusted third-party repos.
3. **Do not replace dedup** with an ERE `duplicate` disposition — ghagga's
   memory-backed `findIssueDuplicates` (pre-LLM short-circuit) is strictly
   stronger.
4. **Do not chase ERE's determinism for *verdicts*.** ghagga's consensus/critique
   modes treat LLM non-determinism as signal (voting). Determinism matters only
   for *evidence identity* (revision pinning, staleness hashing), not verdict
   identity. NOTE: ghagga's *review* verdicts are already mechanical
   (`ReviewStatus` from severities, consensus 60/30 thresholds) — the prose/lenient
   gap is the *triage* path only.

**Deferred architectural bet (not yet filed as its own item):** a
content-addressed baseline + carry-forward for triage/audit (re-triage only what
changed, carry the rest — ERE's `classifyImpact`). No content-addressing exists
anywhere in `packages/core` today. Effort L; it only pays for itself once
re-triage-from-zero is an LLM-cost pain, which the current OPEN priorities
(review-mode depth, GitLab parity) say it is not yet. Revisit when triage volume
makes it hurt.

### BL-TRIAGE-QUEUE-ATOMIC — `queue.json`: non-atomic write + silent corrupt-swallow → draft loss / double-post

**Bug, not a feature.** `packages/triage-engine/src/queue/store.ts` persists the
triage draft queue with a bare, non-atomic `writeFileSync` (`saveQueue`, ~line
43-46): a crash or a full disk mid-write leaves a truncated `queue.json`. Worse,
`loadQueue` (~line 34-40) **swallows corrupt JSON and returns `{}`** — the
behavior is even documented as intentional ("Missing file or corrupt JSON ->
empty queue (never throws)"). Together: one interrupted write silently drops the
**entire** draft queue, including any `POSTED` idempotency state. The plausible
worst case is a **double-post** — a later re-triage no longer sees the POSTED
guard and can re-emit a draft that was already published. (The data-loss path is
confirmed by hand; the double-post is the plausible consequence — it depends on
the POSTED guard living only in this queue file.)

**Fix (from ERE `collectors/baseline-store.ts:39-55`):** write to a temp file
then `renameSync` over the target (atomic on POSIX), and make `loadQueue`
distinguish "missing file → empty queue" from "corrupt file → loud error", never
silently returning `{}` over a corrupt-but-present file. Same non-atomic pattern
also lives in the audit history writer (`apps/cli/src/commands/audit.ts`,
`audit-history.json`) — fix both. Effort S, value HIGH, risk none.

### BL-TRIAGE-CITED-VERDICT — fail-closed triage verdict with a cite-or-abstain gate

The triage output contract is parsed **leniently with silent defaults**: a
garbled `CLASSIFICATION` line falls back to `'question'`
(`packages/core/src/agents/issue-triage.ts`, `parseClassification`), a missing
`CONFIDENCE` becomes `0`, and `parseSources` accepts a `- title | type | ref`
line **without checking the `ref` points at anything real** — a hallucinated
source is accepted verbatim. There is no fail-closed rejection and no "a
confident answer must cite something real" gate; the pipeline cannot distinguish
"the model abstained" from "the model malfunctioned".

**Fix (from ERE `collectors/issue-verdict-pack.ts:57-80`, the `UNCITED_OUTCOME`
gate + `issue-llm-reviewer.ts:54-82` balanced-JSON parse):** add a structural
validator after `parseSources`/`parseClassification` inside `runIssueTriage`. If
a confident, actionable classification (`bug`/`feature`) cites zero sources — or
cites a path that is not in LOCATE's file pool (`contextFiles`) — degrade the
result to the existing safe path (`question` / the Phase-4 worker's
`needs-human` confidence hook) instead of surfacing a silently-defaulted draft.
The citation *plumbing already exists* — `parseSources → IssueTriageSource →` the
DB's `IssueDraftSource {title,type,ref}` — so the transfer is narrow: validate
`ref` against real evidence and persist the classification/confidence that are
currently dropped, so the dashboard can sort the queue by merit. Effort S,
value HIGH, risk LOW (parse-layer only, never touches the posting path). This is
also the schema groundwork BL-HYBRID-4R-MODE's structured ledger wants on the
review side.

### BL-TRIAGE-SERVER-CODE-BLIND — server-side triage has no code access; add remote code-fetch

The CLI/local triage path locates code via a real 3-stage pipeline
(`packages/triage-engine/src/locate/locate.ts`) — but it **requires a local
filesystem checkout** (`config.codeRoot`). The **server-side** (webhook-triggered
SaaS) triage path in `apps/server/src/queues/issue-analysis.ts` has **no code
access at all** (a grep for `locate|codeRoot|checkout` there returns zero hits) —
it is pure text classification against the issue body/comments.

**Fix (from ERE `collectors/github-code.ts`):** a remote code-fetch collector
that reads file bytes from the GitHub Contents/Trees API at a **pinned ref**,
needing no local clone, over an SSRF/DNS-rebind-hardened read-only HTTPS port
(ERE's `HttpsReadOnlyHttpPort`). Pair it with ERE's deterministic path/identifier
extraction (`discoverCodePaths`/`discoverSearchTerms`, ReDoS-hardened) to seed
what to fetch from the issue text alone, and adopt ERE's honesty check
("discovered N, fetched 0 → warn loudly"). This is the ONE place ERE's design is
strictly more capable than anything ghagga has in either mode. Effort M, value
HIGH, risk MEDIUM (new GitHub API surface + rate limits — ERE already solved the
hardening).

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
