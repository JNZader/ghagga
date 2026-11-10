---
"ghagga-core": minor
---

Rank graph-neighborhood context by lexical relevance: when the neighborhood section overflows its `graphContextMaxTokens` budget, surviving entries are now chosen by a deterministic lexical+structural score (diff-token overlap with path segments, changed/exported symbols and named imports, importer-degree tiebreak) instead of positional first-fit in diff order. Ranking changes entry ORDER only — rendering, budgets and the fail-closed degradation ladder are untouched, a ranking error degrades to the existing failed-step handling, and reviews without a fresh graph remain byte-identical. Rendered sections report `rankingMode: "lexical"` in the graph-context metadata.
