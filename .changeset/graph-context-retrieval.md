---
"ghagga-core": minor
"ghagga": minor
"ghagga-db": minor
---

Add graph-guided context retrieval: reviews now include a budgeted "Graph Neighborhood" section listing each changed file's direct importers, imports and exported symbols, assembled from the dependency graph index. On by default when a graph is available (`ghagga index` or a published `ghagga/graph` branch); disable with `--no-graph-context` or `enableGraphContext: false`. The section degrades fail-closed (missing, stale >7d, or oversized graph → no section, prompts byte-identical to before) and never shrinks the diff budget — it rides a dedicated `graphContextMaxTokens` sidecar (default 1200).

Also persist a measured input/output token split: providers that report usage now feed `reviews.input_tokens` / `reviews.output_tokens` (additive nullable columns, `tokens_used` remains authoritative), and the cost footer shows the measured split, falling back to an "estimated 70/30" label when unmeasured.
