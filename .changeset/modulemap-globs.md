---
"ghagga-triage-engine": minor
---

`moduleMap` scope entries now accept **glob patterns** and **file paths**, not just directories — so a config can point a module at exact files (e.g. `internal/**/checklist*.go`) for precise, fast LOCATE instead of scanning a broad directory. Globs resolve via `node:fs` `globSync` (Node ≥22; the package's engines floor is bumped accordingly, and the access is crash-safe so glob entries degrade gracefully on older runtimes while dir/file entries keep working). Directory entries behave exactly as before (fully backward compatible). All entries are confined to `codeRoot` — a `..`-escaping glob/file is skipped. Test files, `node_modules`/vendor, and the scan cap are all honored identically across dir/glob/file entries.
