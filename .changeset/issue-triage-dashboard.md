---
'@ghagga/dashboard': minor
---

Add the Issue Triage approval page to the dashboard.

Maintainers can now review, edit, approve, or reject AI-drafted issue-triage
replies from the dashboard before any comment is posted to GitHub. The page
lists pending drafts, shows the (editable) draft body, dedup matches, and
sources, and drives the PR2 approval API (`/api/issue-drafts`). Untrusted issue
text is always rendered as plain text — never as HTML — and the transient
`APPROVED` posting lock surfaces as "POSTING…" rather than an actionable draft.
