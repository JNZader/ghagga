---
"ghagga-core": patch
"ghagga": patch
"ghagga-db": patch
"ghagga-forge": patch
---

Fix wave: 24 backlog items from the day's five SDD 4R reviews. Correctness: spec three-writer reconciliation, extractChangedSymbols tail-fallback reset, staleness NaN fail-closed, per-side token split guards (workflow/consensus/fan-out), watermark clock-skew pin. Resilience: diagram lazy-load error boundary, digest worker lazy forge seam (deleted repo → SKIPPED not 3 attempts), settings scheduler hooks surfaced, reconciler NaN guard. Quality: fixture score-docs, 30-day window cross-refs, GRAPH_STALE_DAYS constant, mermaid-lazy regex tightened, comparePaths deduplicated, double graph load skipped. Investigation: CLI markdown output now renders Blast Radius; GatewayResponse accepts token split (bridge-side pending); semgrep failures surface as errors instead of silent 0-findings; NEEDS_HUMAN_REVIEW added to the reviewer's STATUS menu. Diagram redesigned for legibility: flowchart LR, theme-adaptive palette, 2-segment clusters, test files collapsed into per-cluster summary nodes. Comment format overhauled: top-10 visible findings with the rest collapsed (byte-capped), diagram positioned after Summary, AI summary headings normalized, cost footer honest about partial token measurement.
