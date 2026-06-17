---
"ghagga-core": minor
"ghagga-db": minor
---

feat: issue-triage agent (`/ghagga triage`)

Adds an opt-in issue-triage flow. When a maintainer (write association: OWNER,
MEMBER, or COLLABORATOR) comments `/ghagga triage` on a plain GitHub issue, the
server dedupes the issue against review memory, runs an LLM analysis with
untrusted-input fencing, and persists a **draft** that a human approves in the
dashboard before any comment is posted — nothing is ever auto-posted to the issue.

- `ghagga-core`: new `issue-triage` agent (`runIssueTriage`) with hostile-input
  fencing + classification (bug / feature / question), a keyword dedup query
  builder for issue title/body, and the supporting exports/prompts.
- `ghagga-db`: new `issue_drafts` table and helpers (`saveIssueDraft`,
  `claimIssueDraftForPosting`, `listIssueDrafts`, `markIssueDraftPosted`, etc.).

All-additive — the PR review path is unchanged. Lockstep `fixed` group bumps
`ghagga-core`, `ghagga` (CLI, unchanged in this feature), and `ghagga-db`
together to the same MINOR version.

> **Ships with a new `issues: write` App permission** → existing installations
> must re-consent. Bundle with the pre-launch deploy consent. The feature is
> release-blocked until the server is deployed and the PRE-LAUNCH 🔐 list is closed.
