# Core Engine Delta

> **Change**: `blast-radius-diagram`
> **Base spec**: `openspec/specs/core-engine/spec.md`
>
> **Merge seam**: the open change `graph-context-retrieval` also MODIFIES `Requirement: Review Pipeline Execution` (graph-neighborhood context). This delta is written against the current base text (three scenarios below). Whichever change archives second MUST rebase onto the archived result so both scenario sets survive — do not archive blind.

## MODIFIED Requirements

### Requirement: Review Pipeline Execution

The system MUST execute reviews through a layered pipeline: Layer 0 (static analysis), Layer 1 (memory retrieval), Layer 2 (AI agents), Layer 3 (memory persistence).

Additionally, when blast-radius narrowing runs and produces a diagram-eligible node set (cap not exceeded), the pipeline MUST extend `BlastRadiusMetadata` with capped, deterministically sorted node and edge lists for rendering. Rationale: `applyBlastRadius` currently collapses the blast radius into counts only, so no downstream surface (comment, DTO, dashboard) can render what was computed; the lists are the single diagram source for every consumer.

The node/edge derivation MUST satisfy:

- Edges MUST be derived from the merged `collectFileNeighborhoods` neighbors API (`packages/core/src/graph/neighbors.ts`), queried over the changed files' direct neighborhood in **both directions** — importers (via reverse edges) and importees (via `node.imports`) — with only edges internal to the capped node set retained.
- The lists MUST be capped at the render limit (approximately 25 nodes) with directory-clustered truncation, and the caps MUST be enforced on the persisted lists, not only at render time.
- Node and edge ordering MUST be explicitly sorted with stable, generated node ids, so identical inputs produce byte-identical serialized lists across runs.

`computeBlastRadius` semantics MUST remain untouched: same defaults (depth 3, 50 files), same `exceededCap` computation, same fallback behavior. When the blast radius exceeds the cap (`exceededCap` true), the metadata MUST NOT carry node/edge lists — the existing counts-only fallback behavior is preserved unchanged. The new metadata fields are additive; readers that predate this change MUST ignore them without error. Any failure during edge derivation MUST degrade to counts-only metadata and MUST never fail the review.

(Previously: the requirement covered only the four pipeline layers with no blast-radius diagram data.)

#### Scenario: Successful full pipeline review

- GIVEN a valid diff string and a repository configuration with mode "workflow"
- WHEN the review pipeline is executed
- THEN Layer 0 MUST run Semgrep, Trivy, and CPD in parallel
- AND Layer 1 MUST search memory for past observations related to the changed files
- AND Layer 2 MUST run the workflow agents with static analysis findings and memory context injected
- AND Layer 3 MUST save new observations from the review to memory
- AND the pipeline MUST return a structured ReviewResult

#### Scenario: Static analysis failure does not block review

- GIVEN a valid diff and configuration
- WHEN one or more static analysis tools fail (binary not found, timeout, crash)
- THEN the pipeline MUST continue with the remaining tools
- AND the pipeline MUST log a warning for each failed tool
- AND the AI agents MUST still receive whatever findings were collected

#### Scenario: Empty diff

- GIVEN an empty diff string
- WHEN the review pipeline is invoked
- THEN the system MUST return a ReviewResult with status "SKIPPED" and reason "empty diff"
- AND no AI tokens MUST be consumed

#### Scenario: Edges derived in both directions from the neighbors API

- GIVEN a diff changing `src/a.ts` and `src/b.ts`, a fresh loaded graph where `src/a.ts` imports `lib/util.ts` and `src/a.ts` is imported by `src/page.ts`
- WHEN the pipeline runs blast-radius narrowing within the cap
- THEN the metadata node list MUST contain the changed files plus `lib/util.ts` (importee) and `src/page.ts` (importer)
- AND the edge list MUST contain the changed-file-to-`lib/util.ts` edge (upstream) and the `src/page.ts`-to-changed-file edge (downstream)
- AND every edge in the list MUST reference two nodes present in the node list (no dangling edges)
- AND `computeBlastRadius` MUST have been invoked with unchanged semantics (same depth and cap inputs as before this change)

#### Scenario: Render cap enforcement and deterministic output

- GIVEN a diff whose direct blast-radius neighborhood spans 40 eligible nodes and a render cap of 25
- WHEN the pipeline assembles the diagram metadata
- THEN the persisted node list MUST contain at most 25 nodes and the edge list only edges internal to those nodes
- AND the truncation MUST apply directory clustering (grouping same-directory siblings) with the omitted count recorded
- AND running the assembly twice on identical inputs MUST produce byte-identical node and edge lists (explicit sort order, generated stable ids, no `Set` iteration in output)

#### Scenario: Oversize blast radius falls back to counts-only

- GIVEN a diff whose blast radius exceeds `maxFiles` so `exceededCap` is true and the review falls back to the full diff (existing step-2.5 behavior)
- WHEN the pipeline assembles `BlastRadiusMetadata`
- THEN the metadata MUST carry the existing counts and `fallbackReason` exactly as before this change
- AND the metadata MUST NOT carry node or edge lists
- AND any error thrown during edge derivation MUST be swallowed into counts-only metadata with the review completing normally
