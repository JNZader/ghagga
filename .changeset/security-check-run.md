---
"ghagga-core": minor
"ghagga": minor
"ghagga-db": minor
"ghagga-forge": minor
"@ghagga/server": minor
---

The GitHub App publishes a `ghagga/security` check run. It fails when a security finding is at or above a configurable threshold (default: critical) and stays failed on that commit until a later review no longer contains the finding. The App also uploads a SARIF report to GitHub code scanning. `checks: write` and `security_events: write` are required, and adding them asks existing installations to re-consent.
