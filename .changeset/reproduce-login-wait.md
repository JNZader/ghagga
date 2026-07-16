---
"ghagga-triage-engine": patch
---

Fix REPRODUCE running unauthenticated due to a login timing race. After a `steps` loginRecipe the harness navigated to the target route immediately, before the app's post-login redirect completed, so the session/JWT wasn't established and the app bounced to the login page. The harness now waits for the app to leave the login page (best-effort, 15s timeout — REPRODUCE proceeds either way and records whether the redirect was observed) before proceeding.
