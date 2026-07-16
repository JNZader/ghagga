# Issue Triage

**Issue triage** is an opt-in agent that analyzes a GitHub **issue** on demand and
drafts a response for a human to approve before anything is posted. It is the
issue-side counterpart to PR review: where review reads a diff, triage reads an
issue (title, body, and recent comments), dedupes it against review memory,
classifies it, and produces a **draft** — never an auto-posted comment.

> **Availability**: shipped in `3.1.0`. The feature is **release-blocked** until
> the server is deployed and the pre-launch 🔐 security list is closed. The code
> is built and tested, but the hosted App does not act on `/ghagga triage` until
> that deploy lands (and the new `issues` permission is granted — see below).

## How to trigger

A **maintainer** comments the exact command on a plain GitHub issue:

```
/ghagga triage
```

| Constraint | Detail |
|-----------|--------|
| **Target** | A plain issue only. On a pull request, `triage` is a no-op (use the `review` commands for PR diffs). |
| **Who can trigger** | Write-association maintainers only: `OWNER`, `MEMBER`, or `COLLABORATOR`. This is **stricter** than `/ghagga review` (which also accepts `CONTRIBUTOR` / `FIRST_TIME_CONTRIBUTOR`), because issues are openable by anyone and triage feeds untrusted text to an LLM. A `CONTRIBUTOR` can request a review but **cannot** trigger a triage. |
| **Command-gate only** | v1 is triggered by the comment command alone. There is **no** label-gate and **no** GitHub Projects v2 integration — both are deferred to a later release. |

The author-association gate is enforced **server-side, before any issue fetch or
LLM call**, so unauthorized or non-command comments cost zero tokens.

## Flow

```
/ghagga triage (maintainer, plain issue)
        │
        ▼
1. Server gate     write-association check BEFORE any fetch/LLM
        │
        ▼
2. Fetch + fence   read issue title/body + most-recent comments (size/count bounded);
                   untrusted text is wrapped so it cannot alter agent instructions
        │
        ▼
3. Dedup           keyword search over the issue text against review memory
        │
        ▼
4. Analyze         LLM classifies (bug / feature / question), or flags missing info;
                   low-confidence results degrade to a "needs info" draft
        │
        ▼
5. Draft           result is persisted as a DRAFT — nothing is posted to GitHub yet
        │
        ▼
6. Human approval  a maintainer reviews/edits the draft in the Dashboard
                   (Issue Triage page) and clicks Approve or Reject
        │
        ▼
7. Post on approve ONLY on approve does the server post the comment on the issue
                   (exactly-once, idempotency-guarded). Reject posts nothing.
```

Nothing is ever auto-posted. The human-approval step is mandatory and is the
core safety property of the feature.

## Required permission

Issue triage needs the **`Issues: Read and write`** GitHub App permission:

- **Read** — fetch the issue body and its comments.
- **Write** — post the approved draft comment back on the issue.

> **Re-consent**: adding `Issues` to the App triggers a GitHub-mandated
> re-consent prompt for **every existing installation** — admins must approve the
> new scope before the App keeps working. This is bundled with the pre-launch
> deploy consent so installations are re-prompted only once. See the
> [Security Policy](security.md) and the permission tables in the
> [SaaS Guide](saas-getting-started.md) and [Self-Hosted Guide](self-hosted.md).

## Scope (v1, 3.1.0)

In scope:

- `/ghagga triage` command-gated triggering on plain issues.
- Untrusted-input fencing on all issue/comment text.
- Keyword dedup against review memory.
- Draft persistence + Dashboard approval page + post-on-approve.

Deferred (later release):

- Label-gate triggering.
- GitHub Projects v2 integration.
- Embedding / vector dedup (keyword dedup only in v1).
