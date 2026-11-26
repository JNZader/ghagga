---
"ghagga-core": minor
"ghagga": minor
"ghagga-db": minor
"ghagga-forge": minor
---

Security findings must include SOURCE, PATH, MISSING_GUARD, and SINK, each as a file and a line, before they are published as open. Critical and high findings also pass a refuter checklist (duplicate, mitigated, speculative, test-only, dead code, unreachable). Refuted findings stay in the review comment inside a collapsed block with the reason. A refuter failure does not block the review.
