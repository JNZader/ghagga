# Design: Blast-Radius Diagram in Review Comment and Dashboard

## Technical Approach

Approach B per proposal: one pure, deterministic diagram builder in core produces a capped, sanitized mermaid source plus the node/edge lists it was built from. The same object feeds the comment section (core formatter), the persisted metadata jsonb, and — projected through one DTO key — the dashboard detail modal, which lazy-loads mermaid npm only when diagram data exists. `computeBlastRadius` semantics are untouched (0-diff, same discipline as scip-symbol-exclusion, prepare-graph.ts:117-145).

## Architecture Decisions

| # | Decision | Choice and rationale (evidence) | Rejected alternative |
| --- | --- | --- | --- |
| 1 | DTO key shape | Canonical types in core (`packages/core/src/graph/schema.ts`, beside `BlastRadiusMetadata` :192 — the api.ts:3-6 canonical-in-core convention), re-exported from `packages/types/src/api.ts`. Key `blastRadiusDiagram?: BlastRadiusDiagram` on `Review`, right after `coverageComplete?` (api.ts:66). Shape: `{ mermaid: string; nodes: {id,label,role:'changed'\|'dependent'\|'test',cluster}[]; edges: {from,to}[]; meta: {stale, exceededCap, truncated, clusterCounts?} }`. Edge semantic: `from` = importer, `to` = importee (`→` = imports, matching `node.imports` / reverse-index orientation). Carrying `mermaid` AND lists kills the "two render paths" drift (exploration Approach B con): the dashboard renders the persisted string, never re-derives. Wire cost is capped (D2): ~6-8 KB worst case per graph-backed review; `toReviewDto` serves only list routes (reviews.ts:307,:333 — no detail endpoint exists; the modal renders the list row, Reviews.tsx:39), so this is a bounded, known list-payload cost, not a per-row explosion. | Mermaid-string-only DTO (blocks future interactivity without a migration); a new detail endpoint (more surface for one consumer). |
| 2 | Persisted caps | In `graph/schema.ts` beside `MAX_BLAST_RADIUS_FILES`: `MAX_DIAGRAM_NODES = 25`, `MAX_DIAGRAM_EDGES = 40` (≈1.6 edges/node readability target, not blind 2×nodes), `MAX_DIAGRAM_LABEL_CHARS = 80`, and a hard build-time invariant `JSON.stringify(diagram).length ≤ 10_000` (label cap + id scheme makes worst case ~6-8 KB). One cap for render AND persistence (25) — no divergence possible. Enforced at BUILD time inside the diagram builder, before anything is persisted or formatted; `format.ts` and the dashboard are render-only and never truncate. The server persists what core produced (saveReview jsonb, queries.ts:353-370) — no server-side capping layer. | Separate render vs persisted caps (divergence); server-side capping (core owns the artifact). |
| 3 | Placement & collapse | Verified `formatReviewComment` order: Summary (format.ts:493) → semanticDiff (:499) → Findings (:502-569) → Static Analysis (:581-590) → **Files Changed** (`formatFileCategorySummary`, :593-595, header at :191) → cost footer (:600-604). Insert `formatBlastRadiusSection(result.metadata.blastRadius?.diagram)` between :595 and :600 — after Files Changed, before cost footer, exactly as proposed. **Open section, no `<details>`**: GitLab's mermaid renderer checks element visibility — diagrams inside collapsed elements do not render (gitlab-org/gitlab#386219; gitlab-docs#1276 same class for hidden tabs); the fix is on GitLab.com only, and self-hosted GitLab instances (which the forge adapter serves) may lack it. The repo's own mermaid precedent is plain fences (docs/review-modes.md:9,24,63); the only `<details>` in format.ts (:469) wraps a static HTML table, not mermaid. | `<details>` collapsed (blank diagram on unpatched GitLab); placement next to semantic-diff (pushes Findings — the actionable content — further down). |
| 4 | Dashboard mermaid | `const MermaidDiagram = lazy(() => import('./MermaidDiagram'))` — the module statically imports mermaid, so Vite/Rollup emits it as its own chunk; mounted ONLY when `review.blastRadiusDiagram` exists, so reviews without data never fetch the chunk (lazy() loads on first render). No `manualChunks` entry: vite.config.ts:16-30 exists to split STATIC imports; a dynamic-import boundary already isolates the ~1 MB dep, and adding a manualChunks rule risks hoisting it into shared config. Pin `mermaid ^11` (caret, matching `recharts ^3.10.1` convention, apps/dashboard/package.json). Render: `mermaid.initialize({startOnLoad:false})` once, `mermaid.render` in an effect; on throw/reject fall back to a `<pre><code>` block with the mermaid source + "diagram could not be rendered" note (source is already on the DTO — zero extra data needed). | CDN script (supply-chain + offline Pages); manualChunks (unnecessary, riskier); React-flow (out of scope per proposal). |
| 5 | Cluster granularity | **Top-level directory** (first path segment; root files → `'(root)'`). Nearest-common-parent is data-dependent — degenerates to the repo root for cross-cutting changes and has no stable label. Subgraphs `subgraph cK["Dir"]`, clusters sorted asc, nodes path-asc within. No cluster cap needed at ≤25 nodes. "+N more" survivor selection: (1) ALL changed files first (`blastResult.changedFiles`, path-asc), (2) remaining files by (edge degree desc, path asc) — degree computed over the full blast-radius set before selection, tiebreak deterministic. Omitted files surface as `truncated: true` + `meta.clusterCounts` = omitted-per-cluster (legend renders "+N more in src/…"; total omitted = sum of values). | Nearest-common-parent (unstable, unnameable); alphabetical survivor pick (drops the highest-impact hub nodes — the whole point of the diagram). |
| 6 | Sanitization | `sanitizeMermaidLabel(path)`: length cap 80 (`…`), then **allowlist charset** `[A-Za-z0-9._/+ -]`; every other char → `_`. One rule kills the whole vector class: `"`, backtick, `<`, `>`, `\|`, control chars, unicode, newlines cannot appear, so a quoted label cannot be escaped and `-->` cannot become edge syntax (quotes unavailable). Node ids `n0..n24`, cluster ids `c0..cK` — emitted only by the builder's own templates; edge/subgraph lines contain zero untrusted data. Legend text is trusted literals + booleans/numbers. Markdown around the fence needs no extra sanitizer (no untrusted free text outside labels). Test vectors: `"` and `'` paths, backtick, `<script>`/`<img>`, `-->`/`->`/`---`, `\n# heading` (newline header injection), `\|`, unicode/emoji, 300-char path, path equal to `end`/`subgraph`, `.gitignore`-style dotfiles. | Escape-map (per-char enumeration misses vectors; allowlist is provably closed). Reusing `sanitizeMarkdownText` (sanitize.ts:44 — markdown semantics, wrong for mermaid string context; `&lt;`-style escapes are fine but `@`-ZWSP mangles paths). |
| 7 | Determinism | Nodes sorted path-asc; id = index in that order. Edges sorted (from-id asc, to-id asc). NO `Set` iteration in any output path — spread → sort → emit (BFS order stays internal). Mermaid emission order: header → classDef → subgraphs (cluster asc, nodes path-asc inside) → `class` line → edges sorted. Goldens: fixture corpus `packages/core/test/fixtures/blast-radius-diagram/<case>/` mirroring the graph-context corpus: `graph.json`, `changed.json`, `expected-diagram.json` (nodes/edges/meta), `expected-mermaid.txt` (byte-exact). Cases: empty, single-file, hub-and-spoke, cycle, exceededCap, stale, unicode paths, injection corpus, 50-file cap boundary. | Snapshot-repair flow (masks ordering regressions); hashing instead of bytes (less debuggable). |

## Graph single-load (interaction with default-on graph-context)

The graph loads ONCE per review at prepare-graph.ts:82-88 into `loadedGraph`/`loadedGraphMetadata`, carried out via the outcome (:200-201); gather reuses it under the single-load rule (gather-safe.ts:269-271). This change's derivation runs INSIDE step 2.5, same block that builds `blastRadiusMetadata` (:103-165), against the in-hand `loadedGraph` — no new load, nothing added to gather. The diagram builder queries `collectFileNeighborhoods(loadedGraph, survivors, …)` (neighbors.ts:83) over the CAPPED survivor set, keeping only edges with both endpoints in the set; graph-context's gather query over changed files is independent (different node set, prompt-side caps). Cost accepted: `buildReverseIndex` runs once each in `computeBlastRadius` (blast-radius.ts:117) and `collectFileNeighborhoods` (neighbors.ts:93) — O(V+E), pure CPU, no I/O duplication.

## Data Flow

```
graph loaded ONCE (prepare-graph.ts:84)
 │
 ├─ computeBlastRadius (:98) ──→ BlastRadiusResult        [UNTOUCHED, 0-diff]
 │      │
 │      └─ buildBlastRadiusDiagramSummary (NEW, pure)     [slice 2]
 │           ├─ survivor select: changed first → degree → path (D5)
 │           ├─ collectFileNeighborhoods(graph, survivors) [neighbors.ts:83]
 │           ├─ internal-edge filter → sort → n0.. ids    [D7]
 │           ├─ sanitizeMermaidLabel + mermaid builder    [D6, slice 1]
 │           └─ BlastRadiusDiagram {mermaid, nodes, edges, meta}
 │                 │
 │                 └─ BlastRadiusMetadata.diagram? (schema.ts:192, additive optional)
 │                      │
 │                      ├─ enrich.ts:115 → result.metadata
 │                      │     └─ formatReviewComment → formatBlastRadiusSection
 │                      │          (NEW, format.ts between :595 and :600)  [slice 3]
 │                      │          '### Blast Radius' + ```mermaid fence + legend — OPEN, no <details>
 │                      │
 │                      ├─ saveReview jsonb (queries.ts:353)   [caps enforced at build, D2]
 │                      │
 │                      └─ toReviewDto (reviews.ts:158) → Review.blastRadiusDiagram?  [slice 4]
 │                           └─ Reviews.tsx modal → <MermaidDiagram/> lazy chunk
 │                                └─ render failure → <pre><code> source fallback
 └─ gather graph-context reuses SAME loaded graph (single-load rule) — no second load
```

## Interfaces / Contracts

- `buildBlastRadiusDiagramSummary(graph: DependencyGraph, result: BlastRadiusResult, graphStale: boolean): BlastRadiusDiagram | undefined` — pure, synchronous; `undefined` when no changed files are in the graph (section stays `''`, byte-identical comment).
- `BlastRadiusMetadata.diagram?: BlastRadiusDiagram` (schema.ts:192, additive — old readers ignore).
- `Review.blastRadiusDiagram?: BlastRadiusDiagram` (api.ts, after :66); `toReviewDto` projects the key only when present (legacy rows: key omitted, like `coverageComplete`).
- `formatBlastRadiusSection(diagram?: BlastRadiusDiagram): string` — `''` when absent/unpopulated (same contract as `formatSemanticDiffSection`, format.ts:496-499).
- Renderer input is an explicit node/edge list (slice 1 has NO pipeline dependency — testable standalone).

## Degradation

| Condition | Behavior | Visible as |
| --- | --- | --- |
| No graph / blast radius disabled | No diagram | Key absent; comment byte-identical |
| Changed files missing from graph | `undefined` summary | Key absent |
| `exceededCap` (radius > cap, full-diff fallback ran) | Diagram over top-25 survivors anyway | `meta.exceededCap` in legend |
| Stale graph (>7d) | Diagram still rendered (blast radius itself ran) | `meta.stale` legend note |
| >25 nodes / >40 edges | Survivor selection + omission counts | `truncated` + `clusterCounts` ("+N more") |
| Mermaid render failure (dashboard only) | Fenced source block + note | Fallback UI |
| Builder throw | Caught in step 2.5, metadata without `diagram`, review continues | Existing failedStep pattern |

## File Changes

| Files | Action |
| --- | --- |
| packages/core/src/graph/diagram.ts (+test) | Slice 1: sanitizer + pure mermaid renderer |
| packages/core/src/graph/diagram-summary.ts (+test) | Slice 2: survivor selection + edge derivation via neighbors API |
| packages/core/src/graph/schema.ts | Caps constants + `BlastRadiusDiagram` types + `diagram?` field |
| packages/core/src/pipeline/prepare-graph.ts, enrich.ts | Thread `diagram` into `blastRadiusMetadata` |
| packages/core/src/format.ts (+goldens) | Slice 3: `formatBlastRadiusSection` between :595/:600 |
| packages/types/src/api.ts, apps/server/src/routes/api/reviews.ts | Slice 4: DTO key + projection |
| apps/dashboard/src/components/MermaidDiagram.tsx, pages/Reviews.tsx | Slice 4: lazy component + modal embed + fallback |
| apps/dashboard/package.json | `mermaid ^11` (devDeps untouched) |
| packages/core/test/fixtures/blast-radius-diagram/* | Golden corpus (D7) |

## Slices: Size and Risk

| Slice | Lines | Risk | Notes |
| --- | --- | --- | --- |
| 1. Mermaid renderer + sanitizer | 150-250 | Medium | Injection surface; closed allowlist + vector tests |
| 2. Diagram summary + metadata | 150-300 | Medium | Touches prepare-graph; must be 0-diff on `computeBlastRadius`; determinism |
| 3. Comment section + goldens | 150-250 | Medium | Byte-stability across CLI/action/server consumers; pinned position |
| 4. DTO + dashboard lazy embed | 200-350 | Medium | Bundle discipline (chunk isolation), list-payload cost, fallback path |

## Testing Strategy

- **Slice 1**: table-driven over node/edge inputs — empty → `''`, sorting, caps, all D6 vectors, golden mermaid bytes per fixture.
- **Slice 2**: synthetic graphs — survivor determinism (degree ties → path asc), internal-edge filter, `exceededCap`/stale flag propagation, neighbors-cap interaction, 50-file boundary.
- **Slice 3**: data-absent goldens byte-identical to current snapshots (all three consumers); data-present golden with section at pinned position; end-to-end injection vectors through `formatReviewComment`.
- **Slice 4**: `toReviewDto` unit tests (passthrough, absent-key omission for legacy rows); component tests — chunk mounted only when data present, fallback block on mocked render failure; bundle check: `vite build` output shows separate mermaid chunk, main chunk size unchanged.

## Migration / Rollout

Purely additive: optional metadata field, optional DTO key, lazy-only dashboard dep. No DB migration (rides the existing metadata jsonb). Rollback: stop emitting `diagram` — comment, DTO, and dashboard all degrade to today's bytes/shape.

## Open Questions

None.
