# Memory System

GHAGGA learns from past reviews using full-text search. Design patterns inspired by [Engram](https://github.com/Gentleman-Programming/engram) (session model, topic-key upserts, deduplication, privacy stripping) -- implemented directly in PostgreSQL for multi-tenancy and scalability.

## Storage Backends

All three backends implement the same `MemoryStorage` interface, ensuring consistent behavior regardless of distribution mode:

| Backend | Used By | Search Engine |
|---------|---------|---------------|
| **PostgreSQL** | Server (SaaS/self-hosted) | `tsvector` + GIN index, ranked by `ts_rank` |
| **SQLite** (sql.js WASM) | CLI, GitHub Action | FTS5 virtual table, BM25 ranking |
| **Engram** | CLI (optional, `--memory-backend engram`) | Delegated to Engram server |

## Pipeline Integration Lifecycle

Memory participates in two pipeline steps -- search (before the review) and persist (after the review).

```mermaid
flowchart TB
  subgraph Pipeline["Review Pipeline"]
    direction TB
    S5["Step 5: Parallel Analysis"]
    S6["Step 6: Agent Execution"]
    S8["Step 8: Memory Persistence"]
  end

  subgraph Search["Memory Search (Step 5)"]
    direction TB
    BuildQ["buildSearchQuery()<br/>extract terms from file paths"]
    FTS["Full-text search<br/>max 3 past observations"]
    Format["formatMemoryContext()<br/>inject as '## Past Review Memory'"]
  end

  subgraph Persist["Memory Persist (Step 8)"]
    direction TB
    Filter["Significance filter<br/>critical/high/medium only"]
    Strip["stripPrivateData()<br/>13 regex patterns"]
    Session["Create session"]
    Obs["Save observations"]
    Summary["Save PR summary<br/>topic-key upsert"]
  end

  S5 --> BuildQ --> FTS --> Format --> S6
  S6 --> S8 --> Filter --> Strip --> Session --> Obs --> Summary
```

### Search Phase (Step 5)

Memory search runs **in parallel** with static analysis (Step 5):

1. **`buildSearchQuery()`** extracts meaningful terms from file paths in the diff:
   - Strips noise directories: `src/`, `lib/`, `dist/`, `test/`, and similar
   - Removes file extensions
   - Caps the query at **10 terms** to avoid overly broad searches
2. Retrieves a maximum of **3 past observations** via full-text search
3. **`formatMemoryContext()`** formats matched observations as markdown and injects them into the LLM prompt under a `## Past Review Memory` section

All 3 review modes (simple, workflow, consensus) receive the same `memoryContext` in their system prompts.

### Persist Phase (Step 8)

After the review completes, observations are extracted and stored (fire-and-forget -- this step never blocks the response):

1. **Significance filter**: Only findings with **critical**, **high**, or **medium** severity are saved. Low and informational findings are discarded.
2. **`stripPrivateData()`**: Applies 13 regex patterns to redact secrets before storage (see [Privacy Stripping](#privacy-stripping)).
3. **Create session**: A new memory session is created, scoped to the repository and PR number.
4. **Save observations**: Extracted observations are saved with content deduplication:
   - **Content hash**: SHA-256 of `type:title:content`
   - **Dedup window**: 15-minute rolling window -- observations with the same hash within 15 minutes are skipped
5. **Save PR summary**: Uses **topic-key upsert** -- re-reviews of the same PR update the existing summary instead of duplicating it.

## Observation Types

7 observation types, derived from finding categories:

| Type | Description | Example |
|------|-------------|---------|
| `decision` | Architecture and design choices | "Team decided to use Zustand over Redux for state management" |
| `pattern` | Code patterns and conventions | "All API routes use zod validation middleware" |
| `bugfix` | Common errors and their fixes | "React useEffect cleanup missing causes memory leak in Dashboard" |
| `learning` | General project knowledge | "The billing module uses Stripe webhooks for payment confirmation" |
| `architecture` | System design decisions | "Microservices communicate via event bus, not direct HTTP" |
| `config` | Configuration patterns | "Environment-specific configs are in /config/{env}.ts" |
| `discovery` | Codebase discoveries | "Legacy auth module in /lib/auth is deprecated, use /modules/auth" |

### Category to Type Mapping

Finding categories from the review are mapped to observation types:

| Finding Category | Observation Type |
|-----------------|-----------------|
| `security` | `discovery` |
| `bug` | `bugfix` |
| `performance` | `pattern` |
| `style` | `pattern` |
| `maintainability` | `pattern` |
| `error-handling` | `learning` |
| _(default)_ | `learning` |

## Session Model

Each review creates a **memory session** scoped to the repository. Observations within a session share context (PR number, timestamp, related files).

```mermaid
graph TB
  Project["owner/repo"] --> Session["Session: PR #42"]
  Session --> D["decision -- Added retry logic to payment service"]
  Session --> P["pattern -- Error boundaries wrap all route components"]
  Session --> B["bugfix -- Race condition in concurrent cache writes"]
```

## Semantic Memory Search

Memory search is **hybrid** when an embedding provider is configured: a bounded cosine-similarity candidate set (JS-computed, symmetric on both PostgreSQL and SQLite) is UNIONed with the keyword candidates, deduped by observation `id`, then re-ranked with `finalScore = 0.7 * cosineSimilarity + 0.3 * normalizedKeywordScore` before the existing decay filter and result limit apply. This closes **MEM-HYBRID-006**: previously, semantic scoring only re-ranked the keyword candidate set, so a lexically-disjoint query (e.g. "secret leakage") could never surface a relevant observation whose text used different words (e.g. "credential exposure"). Now a lexically-disjoint but semantically-close observation can be retrieved through the cosine union path even with zero keyword overlap.

With **no provider configured** (`EMBEDDING_PROVIDER=none`, the default), search stays keyword-only -- output, ordering, and `last_accessed_at` updates are byte-for-byte identical to the pre-existing behavior. The union logic is entirely inert without a provider.

### How the candidate union works

1. **Keyword candidates**: the existing FTS5 (SQLite) / `tsvector` (PostgreSQL) search, capped at `limit * 5`.
2. **Cosine candidates**: a bounded, project- (and type-, when filtered) scoped query over rows with a non-NULL embedding, `ORDER BY last_accessed_at DESC LIMIT EMBEDDING_CANDIDATE_K` (default 200) -- cosine similarity is computed in JS over that bounded set, top `limit * 5` kept. Rows whose stored `embedding_model`/`embedding_dim` don't match the active provider are excluded from this set (dimension-consistency guard), not errored on.
3. **Union + dedup**: the two candidate sets are merged by `id`. An observation that matched both keyword and cosine search is scored once, with its real keyword score. A vector-only match (no lexical hit) gets keyword-score `0` -- mirroring the pre-existing "no embedding -> cosine 0" convention symmetrically.
4. **Rank + decay + limit**: the unchanged `0.7 * cosine + 0.3 * keywordScore` re-rank, decay filter, and result cap apply to the unioned set exactly as before.

See [Configuration -- Semantic Memory Search](configuration.md#semantic-memory-search-embedding-provider) for how to enable a provider per context (server env, CLI config, GitHub Action inputs), the recommended local/API setups, and the dimension-consistency contract.

### Backfill (re-embedding)

Observations saved before an embedding provider was configured -- or under a different provider/model -- have `embedding_model`/`embedding_dim` set to `NULL` (or mismatched) and are excluded from the cosine candidate set until backfilled.

Run the backfill after enabling or swapping a provider:

```bash
# CLI
ghagga memory backfill [--batch <n>] [--limit <n>] [--re-embed] [--delay <ms>]

# Server (self-hosted / SaaS worker box)
pnpm --filter @ghagga/server memory:backfill -- [--batch <n>] [--limit <n>] [--re-embed] [--delay <ms>]
```

| Flag | Default | Description |
|------|---------|--------------|
| `--batch` | `100` | Rows per `embedBatch()` call |
| `--limit` | unlimited | Maximum total rows to process in this run |
| `--re-embed` | `false` | Also re-embed rows whose stored `embedding_model`/`embedding_dim` mismatches the active provider (not just `NULL` rows) -- use this after a provider or model swap |
| `--delay` | `0` (ms) | Delay between batches, for rate/cost control against paid embedding APIs |

Both entry points call the same shared backfill routine, so CLI and server behave identically. The backfill is **not available in the GitHub Action** -- the Action's per-run SQLite database is ephemeral (persisted only via `@actions/cache` between runs of the same repo/workflow), so there's no long-lived history to backfill.

**Idempotent and resumable**: each batch is selected fresh from storage, matching only `NULL`-embedding rows (plus model/dimension-mismatched rows when `--re-embed` is set). A row already embedded with a matching model/dimension is never re-selected, so re-running the command after a partial run or a mid-batch failure (network error, process crash) picks up exactly where it left off with no duplicate work.

### Rollback

To disable semantic search and instantly return to keyword-only behavior, set:

```bash
EMBEDDING_PROVIDER=none
```

No migration reversal is needed -- the `embedding`, `embedding_model`, and `embedding_dim` columns stay in place as harmless, unused data. The cosine union code path is inert whenever no provider is configured, so this is a pure config change with immediate effect on the next process restart.

## Full-Text Search

### PostgreSQL (Server Mode)

Observations are indexed using a `tsvector` column with a **GIN index**, added via raw SQL migration (`packages/db/drizzle/_custom_tsvector.sql` -- the underscore prefix keeps drizzle-kit from clobbering it on future `generate` runs, since drizzle-kit only manages numerically-prefixed files). A database trigger automatically updates the `tsvector` column (`search_observations`) when observation content changes. Results are ranked using `ts_rank`.

### SQLite (CLI and Action Modes)

Full-text search uses SQLite's **FTS5** extension with **BM25** ranking. The FTS5 virtual table indexes observation titles, content, and tags for fast keyword matching. Search queries are constructed using the same strategy as the PostgreSQL backend -- extracted from file paths, tech stacks, and diff keywords.

## Privacy Stripping

Before any observation is stored, `stripPrivateData()` applies **13 regex patterns** to remove sensitive data:

| Pattern | Example | Redacted As |
|---------|---------|-------------|
| Anthropic API keys | `sk-ant-api03-...` | `[REDACTED_ANTHROPIC_KEY]` |
| OpenAI API keys | `sk-proj-...` | `[REDACTED_OPENAI_KEY]` |
| AWS Access Key IDs | `AKIA...` | `[REDACTED_AWS_KEY]` |
| GitHub tokens | `ghp_...`, `gho_...`, `ghs_...`, `ghr_...`, `github_pat_...` | `[REDACTED_GITHUB_*]` |
| Google API keys | `AIza...` | `[REDACTED_GOOGLE_KEY]` |
| Slack tokens | `xoxb-...`, `xoxp-...` | `[REDACTED_SLACK_TOKEN]` |
| Bearer tokens | `Bearer eyJ...` | `Bearer [REDACTED_TOKEN]` |
| JWT tokens | `eyJ...eyJ...xxx` | `[REDACTED_JWT]` |
| PEM private keys | `-----BEGIN PRIVATE KEY-----` | `[REDACTED_PRIVATE_KEY]` |
| Password/secret assignments | `password = "..."` | `[REDACTED]` |
| Base64 credentials | `SECRET=aGVsbG8...` | `[REDACTED_BASE64]` |

## Content Deduplication

Two mechanisms prevent duplicate observations:

1. **Content hash dedup**: Each observation's content is hashed as `SHA-256(type:title:content)`. If an observation with the same hash exists within the **15-minute dedup window**, the new observation is skipped.

2. **Topic-key upsert**: When re-reviewing the same PR, the PR summary observation uses a topic key (e.g., `pr-summary:owner/repo#42`). Instead of creating a new row, the existing summary is **updated in place** with the `revision_count` incremented. This ensures re-reviews evolve knowledge rather than duplicate it.

## Availability

Memory is available in **all 3 distribution modes**:

| Distribution | Storage Backend | Search Engine | Persistence |
|-------------|-----------------|---------------|-------------|
| Server (SaaS) | PostgreSQL | tsvector + GIN index | Database |
| CLI | SQLite (sql.js WASM) | FTS5 + BM25 | `~/.config/ghagga/memory.db` |
| CLI + Engram | Engram HTTP API | Delegated to Engram | Engram server |
| GitHub Action | SQLite (sql.js WASM) | FTS5 + BM25 | Persisted via `@actions/cache` |

The pipeline degrades gracefully -- if the memory database is inaccessible for any reason, reviews still work using only the current diff and static analysis.

## CLI Memory Integration

Memory in the CLI is **transparent** -- the CLI creates a SQLite (or Engram) storage instance and passes it to the pipeline. There are no dedicated memory commands that affect the review flow; memory search and persist happen automatically as part of the pipeline.

The `ghagga memory` command group provides manual inspection and management:

```bash
ghagga memory list                     # List stored observations
ghagga memory search "error handling"  # Full-text search
ghagga memory show 42                  # View observation detail
ghagga memory stats                    # Database statistics
ghagga memory delete 42                # Delete an observation
ghagga memory clear --repo owner/repo  # Clear repo observations
```

Use `--no-memory` to disable memory for a single review, or `--memory-backend engram` to use the Engram backend.

## Engram Integration

The CLI supports [Engram](https://github.com/Gentleman-Programming/engram) as an alternative memory backend. Engram is a cross-tool memory system that enables memory sharing between GHAGGA, Claude Code, OpenCode, Gemini CLI, GGA, and other compatible tools.

### Configuration

Enable the Engram backend via CLI flag or environment variable:

```bash
# Via CLI flag
ghagga review --memory-backend engram

# Via environment variables
export GHAGGA_MEMORY_BACKEND=engram
export GHAGGA_ENGRAM_HOST=http://localhost:7437   # default
export GHAGGA_ENGRAM_TIMEOUT=5                     # seconds, default
```

### Schema Mapping

GHAGGA observations are mapped to Engram memories as follows:

| GHAGGA Field | Engram Field | Format |
|-------------|-------------|--------|
| `severity` | content tag | `[severity:xxx]` tag in content |
| `filePaths` | content footer | `Files: ...` appended to content |
| `topicKey` | `topic_key` | Direct mapping |
| Source | content tag | Tagged as `Source: ghagga` |

### What Engram Enables

- **Cross-tool context**: Review insights from GHAGGA are available to Claude Code, OpenCode, Gemini CLI, GGA, and any Engram-compatible tool
- **`engram tui`**: Browse GHAGGA review memories from the Engram terminal UI
- **`engram sync`**: Share memories across machines via git
- **Bidirectional learning**: What Claude Code learns about your codebase enriches GHAGGA reviews, and vice versa

### Graceful Degradation

If the Engram server is unreachable (connection refused, timeout, or error), the CLI automatically falls back to the local SQLite backend. A warning is logged, but the review continues without interruption.

## Dashboard Memory Management

The Dashboard's Memory page provides a full-featured React UI for browsing, inspecting, and managing stored observations and sessions.

### Features

- **Session list** with observation counts and severity chips
- **Search** (debounced 300ms) across titles, content, types, and file paths
- **Filters**: severity (all/critical/high/medium/low/info), sort (newest/oldest/severity/most revised)
- **Virtualization** for 20+ observations (prevents DOM bloat)
- **ObservationDetailModal** showing full observation content, PR links, file paths, revision count, and relative timestamps
- **StatsBar** with aggregated counts by observation type and project

### 5-Tier Progressive Deletion Confirmation

Destructive actions use a progressive confirmation system to prevent accidental data loss:

| Tier | Action | Confirmation |
|------|--------|-------------|
| **Tier 1** | Delete single observation | Simple confirm modal |
| **Tier 2** | Delete batch of observations | Confirm with count display |
| **Tier 3** | Clear all observations for a repo | Type the repo name to confirm |
| **Tier 4** | Purge ALL observations | Type "DELETE ALL" + 5-second countdown |
| **Tier 5** | Delete sessions | Confirm with session detail |

Additional management actions:
- **Delete sessions** -- remove individual memory sessions
- **Clean up empty sessions** -- remove sessions with no remaining observations

All destructive actions trigger **Toast notifications** confirming success or reporting errors.

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `GHAGGA_MEMORY_BACKEND` | `sqlite` | Memory backend for CLI: `sqlite` or `engram` |
| `GHAGGA_ENGRAM_HOST` | `http://localhost:7437` | Engram server URL |
| `GHAGGA_ENGRAM_TIMEOUT` | `5` (seconds) | Engram connection timeout |
