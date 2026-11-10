---
"ghagga-core": minor
"ghagga-db": minor
"ghagga-forge": minor
---

Add an opt-in nightly health digest for SaaS/App repositories: set `digestsEnabled` on a repository (or at the installation level for repos using global settings) and the server aggregates the stored review findings in the database — zero LLM calls, zero tokens — and publishes them nightly at 03:00 UTC as ONE `GHAGGA Health Digest` issue per repository, updated in place on every run (per-severity window counts, score trend, top-10 riskiest files by severity weight x recency). Runs with no new findings skip without touching the issue; publication failures (e.g. missing Issues-write permission) are recorded as `FAILED` on the digest history row, never silently dropped, and the next nightly run still fires.

Digest scheduling is a SaaS/App-only capability by design (the CLI's `ghagga health` and the GitHub Action path are unchanged); publication is GitHub-only in v1 (the GitLab port exposes MR notes only). The feature defaults to OFF for every repository.
