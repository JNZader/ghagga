---
"ghagga-core": minor
"ghagga": minor
---

Add a blast-radius diagram to review comments and the dashboard: graph-backed reviews now render a sanitized, deterministic mermaid flowchart of the narrowed blast radius (changed files, their dependents, tests, and import edges in both directions, capped at 25 nodes / 40 edges with directory clustering) in an open `### Blast Radius` section between Files Changed and the cost footer. On by default wherever blast radius runs; reviews without a graph, without diagram data, or with an oversize blast radius keep byte-identical comments (counts-only fallback, no section).

The capped node/edge lists and legend flags (`stale`, `truncated`, omitted-per-cluster counts) persist inside the existing review metadata, are projected through a single optional `blastRadiusDiagram` DTO key on `GET /api/reviews`, and the dashboard detail modal renders the same pre-rendered mermaid source via a lazily loaded mermaid chunk — no bundle cost for reviews without diagram data, with a read-only source fallback when rendering fails.
