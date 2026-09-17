---
"ghagga": patch
---

Add fail-closed `--anchor <sha>` (and `.ghagga.json` `anchor`). HEAD must resolve to that commit or the review exits 1 before the pipeline. `"auto"` skips the check. Does not checkout or add a worktree.
