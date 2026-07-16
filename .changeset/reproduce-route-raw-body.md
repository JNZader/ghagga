---
"ghagga-triage-engine": patch
---

Fix REPRODUCE never firing on GitLab feedback issues. The route to navigate is extracted from the widget's `Ruta: /app/x` line, but the GitLab adapter strips that (`---`-delimited) trailer from `description` before route extraction ran — so the route was always null and REPRODUCE silently skipped every issue. `ForgeIssue` now carries a `rawDescription` (un-stripped body); route extraction reads from it while the LLM/analysis still receives the stripped `description` (widget metadata never reaches the model).
