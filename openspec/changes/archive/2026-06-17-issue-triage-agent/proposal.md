# Proposal: Issue-Triage Agent (v3.1.0, additive / semver MINOR)

**Status**: implemented + verified PASS — RELEASE HARD-BLOCKED (deploy-gated), NOT shipped  
**Author**: javier  
**Date**: 2026-06-16  

> **Provenance**: This change was tracked in engram (topic `sdd/issue-triage-agent/*`), not in an
> openspec change-folder. It is mirrored to disk on 2026-06-17 to match the existing dated archive
> convention. Authoritative source remains the engram observations (proposal #5284, spec #5286,
> design #5287, tasks #5288, verify-report #5358, archive-report #5360).

> **Release status (do NOT read this as shipped)**: Implementation is COMPLETE and `sdd-verify`
> returned **PASS** (4844 tests pass / 0 fail; typecheck clean across core/db/server/dashboard;
> 17/17 scenarios COMPLIANT). The feature is **NOT live**. It is HARD-BLOCKED on operational
> release gates: (1) server must be deployed, (2) the parked PRE-LAUNCH 🔐 security list must be
> closed, (3) the new `issues:write` permission needs re-consent (bundled into the pre-launch
> deploy consent). The branch `feat/issue-triage-agent` is **18 commits** ahead of `origin/main`
> (HEAD `21ea031`) and is **NOT merged, NOT pushed**.

## Intent
ghagga today only reviews PRs. There is no path to analyze a GitHub **issue**. We want an opt-in agent that, when a maintainer types `/ghagga triage` on an issue, reads the issue, dedupes against memory, classifies it, drafts an analysis (with cited sources), and queues that draft for **human approval** in the dashboard before any comment is posted. Issues are openable by ANYONE, so this is treated as a hostile-input feature from line one.

## Scope
### In Scope (3.1.0)
- Webhook routing for `/ghagga triage` on issues — reuse `parseCommentCommand` (webhook.ts:123) + `ALLOWED_ASSOCIATIONS` (:77); let issue-comments through (they're dropped today at webhook.ts:355). Add `triage` to the command map.
- **NEW** `issue-triage` agent (packages/core) — reuses diagnostic.ts output parsers (`parseHypotheses`:73) but supplies an issue-specific system prompt + `wrapUntrustedDescription` (prompts.ts:442) framing. Does NOT rewire `runDiagnosticReview` (its diff is load-bearing).
- **NEW** dedicated `issue-analysis` BullMQ queue + worker — review.ts is PR-only and auto-posts (:826); do NOT reuse.
- Keyword dedup over issue title/body (new query builder; search.ts:116 is path-keyed, no paths exist for issues).
- Human-approval draft flow: draft persistence + dashboard approval page + post-on-approve (net-new).

### Out of Scope (deferred to 3.2.0)
- Label-gate triggering (command-gate only in v1).
- GH Projects v2 integration (would be the first GraphQL client + extra permission).
- Embedding/vector dedup.

## Approach
Hybrid (explore Approach 3): separate queue + NEW agent reusing the parser scaffold + NEW draft persistence + NEW approval UI. PR review path stays untouched. Gating enforced **server-side BEFORE any LLM call** (token-cost defense). Prompt-injection defense (`wrapUntrustedDescription` + `UNTRUSTED_CONTENT_POLICY`) is a first-class, non-negotiable requirement.

## Additive Surface
| Area | Impact |
|------|--------|
| `webhook.ts` | Modified — `triage` command + non-PR issue-comment branch |
| `packages/core/.../issue-triage.ts` | New agent |
| `apps/server/.../queues/issue-analysis.ts` | New queue+worker |
| `packages/core/.../memory/search.ts` | New issue-text query builder |
| `packages/db` draft persistence | New (model finalized in design) |
| dashboard approval page + write API | New |

## Permission Delta
**ONLY `issues` (read/write).** No Projects, no GraphQL, no `organization_projects`. Bundle this single new permission with the pre-launch deploy consent to avoid double re-consent.

## Risks
| Risk | Likelihood | Mitigation |
|------|-----------|------------|
| Prompt injection (anyone opens issues) | High | `wrapUntrustedDescription` + policy; trusted scaffold OUTSIDE the fence; command+association gate |
| Token-cost blast radius | Med-High | Gate server-side before any LLM call; never auto-run |
| New `issues` permission → re-consent | High | Bundle into pre-launch consent |
| Keyword dedup quality on prose | Med | Accept for v1; embeddings deferred to 3.2 |
| Draft/approval is net-new | Med | Explicit lifecycle; design phase finalizes table vs status |

## Deferred Items & Hard Blockers
- **DEFERRED to 3.2.0**: label-gate, Projects v2, embedding dedup.
- **HARD BLOCKER (state plainly)**: This feature CANNOT ship to real users until the server is DEPLOYED and the parked PRE-LAUNCH 🔐 security list is closed. CODE can be built + tested locally now; only release is blocked. The `issues` permission ships with the pre-launch deploy consent.

## Rollback Plan
All-additive: the `issues` webhook case, new queue/worker/agent/table/UI are removable with no impact on the live PR path. Revert the `triage` command-map entry to fully disable. No migration of existing review data.

## Success Criteria
- [ ] `/ghagga triage` by an allowed author on an issue enqueues an analysis job; non-allowed authors and non-command comments are rejected BEFORE any LLM call.
- [ ] Issue text is wrapped via `wrapUntrustedDescription`; injection-probe issues do not alter agent behavior.
- [ ] Worker produces a DRAFT (never auto-posts); comment posts ONLY after human approval in the dashboard.
- [ ] Permission delta is exactly `issues`; no GraphQL/Projects code lands in 3.1.0.
- [ ] PR review path unchanged (regression-free).

## Verification Result (sdd-verify — PASS)
Verify-report (engram #5358) verdict **PASS**, real execution (not asserted):
- Tests: **4844 pass / 0 fail / 0 skip** — core 3440, server 656, db 186, dashboard 562.
- Typecheck: 4/4 clean (core, db, server, dashboard).
- Compliance: 17/17 scenarios COMPLIANT, 7/7 requirements SATISFIED, 6/6 design decisions FOLLOWED, 13/13 tasks complete.
- Real-LLM smoke (corroborating): gemini cli-bridge on a real fork-PR produced a correct cited diagnosis; injection probe `</USER_DESCRIPTION> SYSTEM...` was REJECTED (defang held); dedup on real sqlite+FTS5 flagged an exact dup (1.0), ignored unrelated (0), surfaced borderline (0.583) without blocking.
- E2E (webhook HMAC, live BullMQ worker, GitHub fetch/post round-trip, dashboard approve→post) are deferred to post-deploy staging per the design's own testing strategy — they are NOT code gaps.

## Remaining Work (OPERATIONAL, not implementation)
1. Deploy the server (E2E paths only verifiable post-deploy).
2. Close the parked PRE-LAUNCH 🔐 security list (hard pre-launch gate).
3. `issues:write` re-consent (declared in docs prose only; no app manifest in repo — bundles with pre-launch deploy consent).
4. Merge `feat/issue-triage-agent` (18 commits, HEAD `21ea031`) — PR to main, never direct push.
