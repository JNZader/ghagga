---
"ghagga-core": patch
"ghagga": patch
---

Opt-in `refuterCount` (integer >= 2) for fan-out: one batched generateFn per refuter over the closed critical ledger. 2-of-K `refute` votes set `ledgerStatus` to `refuted`. Requires `pinLensesToFirst`. Invalid `.ghagga.json` values fail closed.
