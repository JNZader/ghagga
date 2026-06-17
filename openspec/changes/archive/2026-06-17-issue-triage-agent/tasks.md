# Tasks: Issue-Triage Agent (v3.1.0, additive / semver MINOR)

**Status**: ALL 7 phases COMPLETE — verified PASS; release HARD-BLOCKED (deploy-gated)  
**Design**: [design.md](./design.md)  
**Author**: javier  
**Date**: 2026-06-16  

> Mirrored from engram (`sdd/issue-triage-agent/tasks`, obs #5288, 8 revisions).

Scope LOCKED: command-gate ONLY (no label-gate/Projects v2/embeddings). Permission delta = `issues` only. All code buildable+testable locally now; release blocked on deploy + PRE-LAUNCH 🔐. Legend: **[TDD]** write failing test first; **[5vr]** highest review tier (security-sensitive); **[3vr]** runtime/cross-pkg.

## Phase 1: Data Model Foundation (no deps)
- [x] 1.1 **[TDD][3vr]** Add `issue_drafts` table to `packages/db/src/schema.ts`. ✅ DONE commit f1e5eca (bigint comment id + status/kind CHECK constraints, 2e72554).

## Phase 2: Core Agent (deps: none from P1)
- [x] 2.1 **[TDD][5vr]** Add `ISSUE_TRIAGE_SYSTEM` to prompts.ts. ✅ DONE commit 68647aa.
- [x] 2.2 **[TDD][5vr]** Create `packages/core/src/agents/issue-triage.ts` `runIssueTriage(input)`. ✅ DONE commit 68647aa (untrusted-input fencing + parse robustness, 2a03ba9).
- [x] 2.3 **[TDD]** Classification (bug|feature|question) + missing-info path. ✅ DONE commit 68647aa.

## Phase 3: Memory Dedup (deps: none)
- [x] 3.1 **[TDD]** Add `buildIssueSearchQuery(title, body)` to search.ts. ✅ DONE commit 3ed7cc0 (relevance-gated dedup 5553242; over-fetch + short-query guard 8c66035).

## Phase 4: Queue + Worker (deps: P1, P2, P3)
- [x] 4.1 **[TDD][3vr]** Create `apps/server/src/queues/issue-analysis.ts`. ✅ DONE f3878bf + cf86367 (SSRF-harden + retry idempotency) + 081c2ab (worker cleanup).
- [x] 4.2 **[TDD][5vr]** Confidence-threshold gate. ✅ DONE commit f3878bf.

## Phase 5: Webhook Routing (deps: P4) — SECURITY GATE
- [x] 5.1 **[TDD][5vr]** webhook.ts routes non-PR `/ghagga triage` → enqueue. ✅ DONE 9d41571 + e31da01 (strict write-only gate + newest-comments + fetch-fail abort) + b136ed5 (newest-window across pages).
- [x] 5.2 **[TDD][5vr]** Regression guard: `/ghagga review` on a PR still runs. ✅ DONE 9d41571.

## Phase 6: Approval API + Dashboard (deps: P1, P4)
- [x] 6.1 **[TDD][3vr]** issue-drafts route + DB helpers. ✅ DONE commit 6a7d84e (exactly-once GitHub post via CAS lock on approve, 9ac1248).
- [x] 6.2 Dashboard IssueTriage page + hooks. ✅ DONE commit 6a7d84e.

## Phase 7: Permission, Changeset, Docs (deps: all) — ✅ DONE
- [x] 7.1 Add `issues:write` to GitHub App permission DECLARATIONS. ✅ DONE. NO app manifest/app.yml exists — permissions are declared ONLY in prose/tables across 3 authoritative docs: `docs/security.md:104` (Best-Practices prose list), `docs/saas-getting-started.md` permissions table, `docs/self-hosted.md` §1.3 permissions table. Added `Issues: Read and write` to all 3 + a re-consent warning callout in each (bundle with pre-launch deploy consent). Commits 2c65713, 21ea031.
- [x] 7.2 Add changeset (semver MINOR). ✅ DONE `.changeset/issue-triage-agent.md`: `ghagga-core: minor` + `ghagga-db: minor` (the packages that actually changed). The `fixed` lockstep group [ghagga-core, ghagga, ghagga-db] in `.changeset/config.json` drags the unchanged CLI `ghagga` to 3.1.0 too (per docs/RELEASING.md — NOT a gratuitous bump). `pnpm changeset status` confirms: minor=ghagga-core/ghagga-db/ghagga; patch=@ghagga/server,@ghagga/dashboard,@ghagga/types,@ghagga/action (private, auto via updateInternalDependencies:patch). All currently 3.0.0 → published go 3.1.0. CHANGELOGs are changeset-generated → NOT hand-edited.
- [x] 7.3 Docs. ✅ DONE. NEW `docs/issue-triage.md` (trigger `/ghagga triage`, write-association gate OWNER/MEMBER/COLLABORATOR per webhook.ts:106 TRIAGE_ALLOWED_ASSOCIATIONS, full flow dedup→analysis→draft→human-approval→post-on-approve, issues permission + re-consent, release-blocker). Added to `docs/_sidebar.md` (Features). Cross-link row + callout in `docs/review-pipeline.md` Trigger Modes. README feature bullet. Accurate: command-gate only, NO label-gate, NO Projects v2 (deferred).

## Apply notes (Phase 7, verified)
- NO GitHub App manifest exists in repo — `fd manifest|app.yml` empty. Permissions live only in docs prose/tables. Updated all 3 authoritative spots.
- `.changeset/config.json` `fixed: [ghagga-core, ghagga, ghagga-db]` = lockstep. Listing ANY published pkg bumps all three. docs/RELEASING.md is the authoritative convention doc.
- biome has NO markdown parser → all 7 touched .md files skipped by `biome check` (not lintable). No code touched → no typecheck needed.

## Status
ALL 7 phases COMPLETE (18 commits on `feat/issue-triage-agent`, HEAD `21ea031`). Verify PASS (4844 tests, 0 fail; 17/17 scenarios COMPLIANT). Release still HARD-BLOCKED on server deploy + PRE-LAUNCH 🔐 + `issues:write` re-consent (documented). Branch NOT merged / NOT pushed.
