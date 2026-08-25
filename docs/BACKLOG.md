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

### BL-TRIAGE-CODE-FENCE — give issue triage a dedicated fenced source-code input (not the memory channel)

Follow-up surfaced by BOTH adversarial reviews of BL-TRIAGE-SERVER-CODE-BLIND
(now RESOLVED). Code-in-evidence currently folds the fetched source into
`memoryContext` (mirroring the CLI at `packages/triage-engine/src/triage/run.ts:83-84`),
which `runIssueTriage` renders through `buildMemoryContext`
(`packages/core/src/agents/prompts.ts:592`). That wrapper's TRUSTED framing reads:
"observations are background context from **past reviews** … Do NOT use them as
reasons to flag issues. Only flag issues you can justify from the **code diff**
itself." For triage this is doubly wrong: the bytes are the *current source the
issue references* (not past reviews), and the framing tells the model to DISCOUNT
that channel and rely on a "diff" that does not exist in the triage path.

The fence is SECURITY-correct (the code is defanged as untrusted DATA — see the
resolved item), so this is a UTILITY limitation, not a vulnerability. The better
design already exists in the same file: `reproductionEvidence` is a dedicated,
semantically-distinct fenced input (`issue-triage.ts` → `wrapUntrustedReproEvidence`,
`<REPRO_EVIDENCE>`) with no "do not flag" framing. Add an analogous optional
`sourceCode` fenced input to `IssueTriageInput` + `buildIssuePrompt`, then switch
BOTH call sites (the server `collectIssueCodeEvidence` fold in
`apps/server/src/queues/issue-analysis.ts`, and the CLI fold in
`packages/triage-engine/src/triage/run.ts`) off the memory channel. Effort M
(touches the core agent contract + 2 callers + prompt eval). Not a blocker — v1
keeps CLI parity.

Also noted (LOW, same reviews): `discoverSearchTerms` / GitHub code-search
discovery (find code by the identifiers an issue names, not just explicit paths)
is a natural follow-on to `discoverCodePaths` — port ERE's `discoverSearchTerms`
+ a forge `searchCode`/`getTree` capability when path-only discovery proves too
narrow in practice.

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
