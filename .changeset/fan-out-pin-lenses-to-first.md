---
"ghagga-core": patch
"ghagga": patch
---

Opt-in `pinLensesToFirst` so fan-out lenses all use `generateFns[0]` instead of round-robin. Set `"pinLensesToFirst": true` in `.ghagga.json`; omit to keep current assignment. Non-boolean config fail-closes.
