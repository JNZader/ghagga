---
"ghagga-core": minor
"ghagga": minor
"ghagga-db": minor
"ghagga-forge": minor
"@ghagga/server": minor
---

Config, lenses, and the dependency graph are read only from the default branch or a protected branch. `ghagga/graph` was an unprotected orphan branch; it is used only when that branch is protected, and a graph file on the default branch is preferred. `ghagga review --pr` and `--mr` do not load `.ghagga.json`, `.ghagga/lenses`, or `.ghagga/graph.json` from the pull request head. A fork or an author without write permission cannot supply those inputs.
