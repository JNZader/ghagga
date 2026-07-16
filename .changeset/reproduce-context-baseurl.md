---
"ghagga-triage-engine": patch
---

Fix REPRODUCE failing at login with "Cannot navigate to invalid URL". The Playwright browser context was created without a `baseURL`, so the login recipe's relative `goto` step (e.g. `/login`) had no base to resolve against. The context now sets `baseURL` from `config.app.baseURL`, so relative login navigation works (the post-login route navigation already used an absolute URL and was unaffected).
