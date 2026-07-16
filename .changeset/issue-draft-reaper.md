---
"@ghagga/server": minor
---

Add a reaper that recovers issue-triage drafts stuck in `APPROVED` after a poster process crashed between posting the GitHub comment and recording it. A per-draft HTML marker (`<!-- ghagga-issue-draft:{id} -->`) is embedded in the posted comment so the reaper can correlate exactly; on each tick it lists the issue's comments and, if the draft's marker is found on an app-bot-authored comment, records it as `POSTED` (never re-posting), otherwise releases the claim back to `DRAFT` for a human to retry. Read failures skip (never act on an ambiguous read). Runs as a self-guarded `setInterval` in the issue-analysis worker; tunable via `ISSUE_DRAFT_REAPER_ENABLED` / `ISSUE_DRAFT_REAPER_INTERVAL_MS` / `ISSUE_DRAFT_REAPER_STALE_MS`, and `GITHUB_APP_SLUG` for exact bot-author verification.
