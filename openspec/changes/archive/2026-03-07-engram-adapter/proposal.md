# Proposal: Engram Memory Adapter — Shared Memory Across the Developer Ecosystem

> **Priority**: v2.2.0  
> **Status**: Deferred (post v2.1.0 release)

## Intent

GHAGGA has a well-defined `MemoryStorage` interface with two implementations: `SqliteMemoryStorage` for CLI and Action, and `PostgresMemoryStorage` for SaaS. These work well in isolation — CLI reviews build local memory, SaaS reviews build server-side memory — but neither connects to the broader developer tool ecosystem.

Engram is a shared memory system used by Claude Code, OpenCode, Gemini CLI, Codex, GGA, and any MCP-compatible tool. It provides a single knowledge store that all developer tools read from and write to, enabling cross-tool context sharing. By adding an `EngramMemoryStorage` adapter, GHAGGA's review insights become available to every tool in the Engram ecosystem, and context from those tools enriches GHAGGA reviews.

This is a one-way integration: GHAGGA implements an adapter that speaks to Engram's existing HTTP API. No changes to Engram are required.

### The Ecosystem Triangle

```
                    ┌─────────────┐
                    │   Engram    │
                    │ (shared     │
                    │  memory)    │
                    └──────┬──────┘
                           │
              ┌────────────┼────────────┐
              │            │            │
         ┌────┴────┐  ┌───┴────┐  ┌────┴─────┐
         │   GGA   │  │ GHAGGA │  │Claude/   │
         │ (hooks, │  │ (PRs,  │  │OpenCode/ │
         │  local) │  │ SaaS)  │  │Gemini/...│
         └─────────┘  └────────┘  └──────────┘
```

- **GGA** already has an Engram bridge (PR #51 on gentleman-guardian-angel) that consumes context before review and exports insights after
- **Claude Code / OpenCode / Gemini CLI** use Engram via MCP (`mem_search`, `mem_save`)
- **GHAGGA** (after this change) reads/writes Engram directly via HTTP, completing the triangle

## Scope

### In Scope

- **`EngramMemoryStorage` class** in `packages/core/src/memory/engram.ts`: Implements the full `MemoryStorage` interface by mapping each method to Engram HTTP API endpoints
- **HTTP client**: Lightweight HTTP client (Node.js built-in `fetch`) to communicate with Engram's REST API at `localhost:7437` (default)
- **Schema mapping layer**: Translates between GHAGGA's memory model and Engram's observation model (field mapping, structured content encoding)
- **Configuration**: `GHAGGA_MEMORY_BACKEND=engram` environment variable or `--memory-backend engram` CLI flag to select the Engram adapter instead of the default SQLite
- **Engram URL configuration**: `ENGRAM_URL` environment variable (default `http://localhost:7437`) for custom Engram server addresses
- **Graceful degradation**: If Engram is not running or unreachable, fall back to SQLite with a warning — never fail the review
- **CLI integration only**: The Engram adapter is available in CLI mode. SaaS always uses PostgreSQL (unchanged)

### Out of Scope

- **Changes to Engram codebase**: This is a pure consumer — no PRs to Engram needed
- **`engram export --format ghagga`**: GHAGGA reads/writes directly via HTTP; no export command needed
- **Fork of Engram**: The adapter uses the public HTTP API as-is
- **SaaS/Action integration**: Engram is a local developer tool; SaaS uses PostgreSQL, Action uses SQLite with cache. No changes to those paths
- **Engram MCP server integration**: GHAGGA talks HTTP to Engram, not MCP. The MCP integration is for AI coding assistants (Claude, OpenCode, etc.)
- **Bidirectional sync**: GHAGGA writes to Engram and reads from Engram, but there's no background sync process. Operations happen inline during the review pipeline
- **Memory management commands for Engram**: The `ghagga memory list/search/show/delete/stats/clear` commands are SQLite-only. Engram has its own TUI (`engram tui`) and CLI for management

## Approach

### Architecture: Third Adapter for MemoryStorage

```
packages/core/src/types.ts            → MemoryStorage interface (existing)
packages/core/src/memory/sqlite.ts    → SqliteMemoryStorage (existing — CLI/Action default)
apps/server/src/memory/postgres.ts    → PostgresMemoryStorage (existing — SaaS)
packages/core/src/memory/engram.ts    → EngramMemoryStorage (new — CLI opt-in)
```

The adapter selection in CLI mode becomes:

```typescript
// apps/cli/src/commands/review.ts
const backend = opts.memoryBackend || process.env.GHAGGA_MEMORY_BACKEND || 'sqlite';

let memoryStorage: MemoryStorage | undefined;
if (opts.memory) {
  if (backend === 'engram') {
    memoryStorage = await EngramMemoryStorage.create({
      baseUrl: process.env.ENGRAM_URL || 'http://localhost:7437',
      fallbackToSqlite: true,
      sqlitePath: join(getConfigDir(), 'memory.db'),
    });
  } else {
    memoryStorage = await SqliteMemoryStorage.create(join(getConfigDir(), 'memory.db'));
  }
}
```

### API Endpoint Mapping

| MemoryStorage Method                          | Engram HTTP Endpoint                          | Notes                                                                                                                              |
| --------------------------------------------- | --------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| `searchObservations(project, query, options)` | `GET /api/search?query=<query>&limit=<limit>` | Filter results client-side by project. Engram's search is global; GHAGGA scopes by project                                         |
| `saveObservation(data)`                       | `POST /api/save`                              | Body: `{ content, type, topic_key, metadata }`. Encode GHAGGA fields (severity, filePaths) as structured content                   |
| `createSession(data)`                         | `POST /api/sessions`                          | Body: `{ metadata: { source: "ghagga", project, prNumber } }`                                                                      |
| `endSession(sessionId, summary)`              | `POST /api/sessions/:id/summary`              | Body: `{ summary }`                                                                                                                |
| `getObservation(id)`                          | `GET /api/observations/:id`                   | Map Engram observation to `MemoryObservationDetail`                                                                                |
| `deleteObservation(id)`                       | `DELETE /api/observations/:id`                | Direct mapping                                                                                                                     |
| `getStats()`                                  | `GET /api/stats`                              | Map Engram stats to `MemoryStats` format                                                                                           |
| `listObservations(options)`                   | `GET /api/search` with filters                | Use Engram search with metadata filters for project/type                                                                           |
| `clearObservations(options)`                  | Not mapped                                    | Engram has no bulk delete via HTTP. Throw `Error('clearObservations not supported with Engram backend. Use engram CLI directly.')` |
| `close()`                                     | No-op                                         | No resources to release (HTTP is stateless)                                                                                        |

### Schema Mapping

Engram observations have a different field structure than GHAGGA's. The adapter includes a mapping layer:

**GHAGGA → Engram (on save):**

```typescript
{
  // Direct mappings
  type: data.type,                    // "pattern" | "decision" | "bugfix" | "learning"
  topic_key: data.topicKey,           // "pr-42-review" → topic_key

  // Structured content encoding
  content: JSON.stringify({
    source: 'ghagga',
    title: data.title,
    body: data.content,
    severity: data.severity || null,
    filePaths: data.filePaths || [],
    project: data.project,
  }),

  // Engram metadata
  metadata: {
    source: 'ghagga',
    project: data.project,
    severity: data.severity,
    sessionId: data.sessionId,
  },
}
```

**Engram → GHAGGA (on read):**

```typescript
{
  id: engram.id,
  type: engram.type || 'observation',
  title: parsed.title || engram.content.substring(0, 80),   // Extract from structured content
  content: parsed.body || engram.content,                    // Extract from structured content
  filePaths: parsed.filePaths || null,
  severity: parsed.severity || null,
  project: parsed.project || engram.metadata?.project || 'unknown',
  topicKey: engram.topic_key || null,
  revisionCount: 1,                                          // Engram doesn't track revisions
  createdAt: engram.created_at,
  updatedAt: engram.updated_at || engram.created_at,
}
```

The adapter attempts to parse `content` as JSON (GHAGGA-structured). If parsing fails, it treats the content as plain text from another tool (Claude Code, GGA, etc.) and maps it with sensible defaults.

### Graceful Degradation

```typescript
static async create(options: EngramOptions): Promise<MemoryStorage> {
  try {
    // Health check: GET /api/stats (lightweight endpoint)
    const response = await fetch(`${options.baseUrl}/api/stats`);
    if (!response.ok) throw new Error(`Engram returned ${response.status}`);
    return new EngramMemoryStorage(options.baseUrl);
  } catch (error) {
    console.warn(`[ghagga] Engram not available at ${options.baseUrl}: ${error.message}`);
    if (options.fallbackToSqlite && options.sqlitePath) {
      console.warn('[ghagga] Falling back to SQLite memory');
      return SqliteMemoryStorage.create(options.sqlitePath);
    }
    // No fallback — return undefined (memory disabled)
    return undefined as unknown as MemoryStorage; // caller handles undefined
  }
}
```

The health check happens once during initialization. Individual method calls also catch errors and log warnings rather than throwing — a failed Engram write should never block a review.

### What This Enables

Once the adapter is in place:
1. **GHAGGA review insights are available everywhere**: `ghagga review .` saves findings to Engram. Later, `mem_search "auth patterns"` in Claude Code surfaces those findings
2. **Cross-tool context enriches reviews**: Before reviewing, GHAGGA searches Engram for relevant context. If a developer discussed auth patterns with Claude Code earlier, GHAGGA sees that context
3. **GGA and GHAGGA share memory**: GGA's Engram bridge (PR #51) writes to the same Engram store. GHAGGA reads those observations, and vice versa
4. **`engram tui` browses GHAGGA memories**: All GHAGGA observations appear in Engram's TUI with `source: ghagga` metadata
5. **`engram sync` shares across machines**: Engram's git-based sync distributes GHAGGA memories to all developer machines

## Affected Areas

| Area                                       | Impact   | Description                                                                                                               |
| ------------------------------------------ | -------- | ------------------------------------------------------------------------------------------------------------------------- |
| `packages/core/src/memory/engram.ts` (new) | New      | `EngramMemoryStorage` class — HTTP client, schema mapping, graceful degradation                                           |
| `apps/cli/src/commands/review.ts`          | Modified | Add `--memory-backend` option. Backend selection logic: `engram` → `EngramMemoryStorage`, default → `SqliteMemoryStorage` |
| `apps/cli/src/index.ts`                    | Modified | Register `--memory-backend` global option (or per-command option on `review`)                                             |
| `packages/core/src/types.ts`               | None     | No interface changes — `EngramMemoryStorage` implements the existing `MemoryStorage` interface                            |
| `apps/server/`                             | None     | SaaS path unchanged — always PostgreSQL                                                                                   |
| `apps/action/`                             | None     | Action path unchanged — always SQLite with cache                                                                          |
| Existing tests                             | None     | New adapter is additive; existing behavior unchanged                                                                      |
| `packages/core/package.json`               | None     | Uses Node.js built-in `fetch` — no new dependencies                                                                       |

## Risks

| Risk                                           | Likelihood | Impact | Mitigation                                                                                                                                                                                                                                                                                                                                                  |
| ---------------------------------------------- | ---------- | ------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Engram not running locally                     | High       | Medium | Graceful degradation to SQLite is the primary mitigation. The adapter attempts a health check at startup. If Engram is unreachable, it falls back silently with a warning. Developers who don't use Engram are never affected                                                                                                                               |
| Engram API changes between versions            | Medium     | Medium | Pin to a known Engram API version in the health check (e.g., check `GET /api/stats` response format). If the response structure changes, log a version mismatch warning and fall back to SQLite. Document the minimum Engram version in GHAGGA docs                                                                                                         |
| Schema mapping loses information               | Medium     | Low    | GHAGGA fields that don't have native Engram equivalents (severity, filePaths) are encoded as structured JSON in the `content` field. This is lossless for GHAGGA-to-GHAGGA round-trips. For cross-tool reads (Claude Code reading GHAGGA observations), the structured content is human-readable JSON — not ideal but functional                            |
| Performance: HTTP round-trips vs. SQLite       | Medium     | Low    | Each memory operation (search, save) is one HTTP request. For a typical review: 1 search + 3-5 saves = 4-6 HTTP requests to localhost. At localhost latency (~1ms per request), total overhead is < 10ms — negligible compared to LLM review time (10-30s). If Engram is on a remote host, latency increases but is still small relative to LLM time        |
| Project scoping: Engram search is global       | Medium     | Low    | Engram's `GET /api/search` returns results across all sources. The adapter must filter client-side by `project` field (from metadata or structured content). This may return slightly more data than needed from the API, but the client-side filter ensures correctness                                                                                    |
| Content field parsing: non-GHAGGA observations | Low        | Low    | When reading observations from Engram that were written by other tools (Claude Code, GGA), the `content` field won't be GHAGGA-structured JSON. The adapter gracefully handles this: if `JSON.parse` fails, it treats content as plain text and maps with defaults. Cross-tool observations appear in GHAGGA with `type: "observation"` and the raw content |

## Rollback Plan

1. The `EngramMemoryStorage` adapter is a new file (`packages/core/src/memory/engram.ts`) — removing it has zero impact on existing functionality
2. The `--memory-backend` CLI flag defaults to `sqlite` — removing it reverts to current behavior
3. No database migrations, no schema changes, no config file changes
4. `git revert` of the feature branch restores exact prior behavior
5. Developers using `GHAGGA_MEMORY_BACKEND=engram` simply stop setting the env var to revert to SQLite

## Dependencies

- **No new npm dependencies**: Uses Node.js built-in `fetch` (available since Node 18+, which is already GHAGGA's minimum version)
- **Engram server** (`engram serve` or running via MCP): Must be running locally for the adapter to work. Not a build dependency — only a runtime dependency when the Engram backend is selected
- **Existing `MemoryStorage` interface**: The adapter implements the existing interface with no changes

## Precedent

The GGA project (gentleman-guardian-angel) already has a working Engram bridge (PR #51) that demonstrates the bidirectional pattern:
1. **Before review**: Search Engram for relevant context → inject into review prompt
2. **After review**: Export review insights to Engram as observations

GHAGGA's `EngramMemoryStorage` follows the same pattern but through the `MemoryStorage` interface rather than ad-hoc scripting. The pipeline already calls `searchObservations` before review and `saveObservation` after — the adapter simply routes those calls to Engram's HTTP API instead of SQLite.

## Success Criteria

- [ ] `EngramMemoryStorage` implements all `MemoryStorage` interface methods
- [ ] `ghagga review . --memory-backend engram` uses the Engram adapter when Engram is running
- [ ] `ghagga review . --memory-backend engram` falls back to SQLite when Engram is not running, with a warning message
- [ ] `GHAGGA_MEMORY_BACKEND=engram ghagga review .` works via environment variable
- [ ] Observations saved via GHAGGA appear in `engram tui` with `source: ghagga` metadata
- [ ] Observations from Claude Code / GGA in Engram are returned by GHAGGA's memory search
- [ ] Schema mapping correctly encodes/decodes severity, filePaths, and project in structured content
- [ ] Non-GHAGGA observations in Engram (plain text content) are handled gracefully with default mappings
- [ ] Individual Engram API failures log warnings but never block the review
- [ ] Default behavior (`--memory-backend sqlite` or no flag) is completely unchanged
- [ ] No new npm dependencies added
- [ ] All existing tests pass without modification
- [ ] `clearObservations()` throws a descriptive error directing users to Engram CLI
