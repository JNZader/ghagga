---
"ghagga-core": patch
"ghagga": patch
---

Opt-in `contrarianCount` for fan-out: N unlensed whole-diff voices on `generateFns[1..N]` after `pinLensesToFirst`. Requires integer >= 1, pin true, and a long enough provider chain. Invalid `.ghagga.json` values fail closed.
