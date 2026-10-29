# Design: Engram Memory Adapter

## Technical Approach

Implement `EngramMemoryStorage` as a third adapter for the existing `MemoryStorage` interface (`packages/core/src/types.ts:300`), following the same adapter pattern used by `SqliteMemoryStorage` and `PostgresMemoryStorage`. The adapter translates every `MemoryStorage` method into HTTP calls to Engram's REST API (`localhost:7437`), with a JSON-based schema mapping layer to encode GHAGGA-specific fields (severity, filePaths, project) into Engram's content/metadata model.

The adapter lives in `packages/core` alongside the existing SQLite adapter, is selected via `GHAGGA_MEMORY_BACKEND=engram` or `--memory-backend engram` in the CLI, and degrades gracefully to SQLite when Engram is unreachable.

## Architecture Decisions

### Decision: Adapter Location — `packages/core/src/memory/engram.ts`

**Choice**: Place `EngramMemoryStorage` in `packages/core/src/memory/engram.ts`, alongside `sqlite.ts`.
**Alternatives considered**: (b) `apps/cli/src/lib/engram-memory.ts` — CLI-only, since only CLI uses it currently.
**Rationale**: The `MemoryStorage` interface is defined in `packages/core/src/types.ts`. Both existing adapters follow this pattern: SQLite lives in `packages/core/src/memory/sqlite.ts`, PostgreSQL lives in `apps/server/src/memory/postgres.ts`. The PostgreSQL adapter lives in `apps/server` because it depends on `ghagga-db` (Drizzle ORM), which is server-specific. The Engram adapter has no such server-specific dependency — it uses native `fetch()` — so it belongs in core. This also enables future reuse by the Action package or any other consumer of `ghagga-core`.

### Decision: HTTP Client — Native `fetch()` with thin `EngramClient` class

**Choice**: Use Node.js built-in `fetch()` (available since Node 18+), wrapped in a private `EngramClient` helper class inside the same file.
**Alternatives considered**: (a) Direct `fetch()` calls inline in each method; (b) `node-fetch` or `undici` as an explicit dependency; (c) Axios.
**Rationale**: GHAGGA already requires Node 18+ (the SQLite adapter uses `node:fs`, `node:crypto`, etc.). Native `fetch()` adds zero dependencies. A thin wrapper class isolates HTTP concerns (base URL, timeouts, JSON parsing, error handling) from the storage logic, making both testable independently. Inline `fetch()` would duplicate error handling across 10+ methods. External HTTP libraries add unnecessary dependency weight.

### Decision: Schema Mapping — Structured JSON in `content` field

**Choice**: Encode GHAGGA-specific fields as a JSON object in Engram's `content` field. On read, attempt `JSON.parse`; if it fails, treat as plain text from another tool.
**Alternatives considered**: (a) Prepend `[severity:high]` tags and append `\n---\nFiles: ...` to content as plain-text markers; (b) Use only Engram's `metadata` field for all extra data.
**Rationale**: The proposal specifies JSON-based structured content encoding (proposal lines 110-133), and this is the right approach. Plain-text markers (option a) are fragile — parsing `[severity:high]` from arbitrary content is error-prone, and appending file lists with delimiters makes content look wrong in Engram's TUI. Metadata-only (option b) may have size/field constraints and is less portable. JSON in `content` is lossless for GHAGGA round-trips and degrades gracefully when read by other tools (they see valid JSON, which is more informative than tag soup). The adapter parses `content` as JSON on read; if parsing fails, it maps with sensible defaults (type: `"observation"`, severity: `null`, filePaths: `null`).

### Decision: Session Mapping — Synthetic Integer IDs

**Choice**: Engram sessions return string UUIDs. GHAGGA's `MemoryStorage` interface uses `number` IDs (`createSession` returns `{ id: number }`). The adapter maintains an internal `Map<number, string>` to map synthetic integer IDs to Engram session UUIDs, using an auto-incrementing counter.
**Alternatives considered**: (a) Change the `MemoryStorage` interface to use `string | number` IDs; (b) Hash the UUID to a number.
**Rationale**: Changing the interface (option a) would break the SQLite and PostgreSQL adapters and all callers. Hashing (option b) risks collisions and loses the ability to map back to the UUID. The synthetic map is simple, lives only for the duration of a single review session (the adapter is created per `reviewCommand` invocation), and the map never grows beyond a few entries. The `endSession` call needs the real Engram UUID, which the map provides.

### Decision: Backend Selection — Environment Variable + CLI Option

**Choice**: `GHAGGA_MEMORY_BACKEND` env var (values: `sqlite` | `engram`, default: `sqlite`) and `--memory-backend <type>` CLI option on the `review` command.
**Alternatives considered**: (a) Global CLI option on the `ghagga` root command; (b) Config file option in `.ghagga.json`.
**Rationale**: Memory backend is only relevant to `review` (the `memory` subcommand always uses SQLite for management). A per-command option keeps the surface small. Environment variable enables CI/dotfile configuration. Config file support can be added later if needed, but env var + CLI flag covers the primary use case. Priority: CLI flag > env var > default (`sqlite`).

### Decision: Graceful Degradation — Health Check on Init, Silent Fallback

**Choice**: `EngramMemoryStorage.create()` pings `GET /api/stats` as a health check. If unreachable, it logs a warning and returns a `SqliteMemoryStorage` instance as fallback. During operation, individual method calls catch HTTP errors and return safe defaults (empty arrays, `null`, `false`) with logged warnings — never throw.
**Alternatives considered**: (a) Return `undefined` when Engram is down and let the caller handle it; (b) Retry with exponential backoff.
**Rationale**: The proposal explicitly requires "never fail the review" (line 45). Returning `undefined` (option a) changes the contract — the CLI code at `review.ts:155-164` already handles `undefined` as "memory disabled", but the user explicitly asked for Engram and deserves a warning + fallback, not silent disabling. Retries (option b) add latency for a non-critical feature. The existing pattern in `search.ts:89-96` and `persist.ts:116-122` already catches and warns on errors — the Engram adapter follows this pattern at the method level too.

### Decision: Unsupported Operations — Throw with Descriptive Message

**Choice**: `clearObservations()` throws `Error('clearObservations not supported with Engram backend. Use "engram" CLI directly.')`. `deleteObservation()` attempts `DELETE /api/observations/:id`; if Engram doesn't support it, catches the error and returns `false` with a warning.
**Alternatives considered**: (a) Silently return 0 / false for unsupported operations; (b) Implement client-side bulk operations.
**Rationale**: The proposal explicitly specifies throwing for `clearObservations` (line 101). Silent failure (option a) would confuse users who expect data to be deleted. Client-side bulk operations (option b) would require listing all observations and deleting one-by-one, which is fragile and slow. The `memory clear` CLI command is SQLite-only and documented as such.

## Data Flow

### Review with Engram Backend

```
ghagga review . --memory-backend engram
          │
          ▼
  ┌──────────────────┐
  │  CLI: review.ts  │  Reads GHAGGA_MEMORY_BACKEND or --memory-backend
  │  Backend select   │
  └────────┬─────────┘
           │ backend === 'engram'
           ▼
  ┌──────────────────────────────┐
  │ EngramMemoryStorage.create() │  Health check: GET /api/stats
  │                              │  Success → EngramMemoryStorage
  │                              │  Failure → SqliteMemoryStorage (fallback)
  └────────┬─────────────────────┘
           │
           ▼
  ┌──────────────────┐       ┌─────────────────┐
  │  reviewPipeline  │──────▶│  memory/search   │  searchObservations()
  │  (ghagga-core)   │       │  → GET /api/search│
  │                  │       └─────────────────┘
  │                  │       ┌─────────────────┐
  │                  │──────▶│  memory/persist  │  createSession(), saveObservation()
  │                  │       │  → POST /api/*   │  endSession()
  └────────┬─────────┘       └─────────────────┘
           │
           ▼
  ┌──────────────────┐
  │ memoryStorage    │  close() → no-op (HTTP is stateless)
  │   .close()       │
  └──────────────────┘
```

### Schema Mapping Flow

```
  GHAGGA Observation                    Engram Observation
  ┌─────────────────┐                  ┌──────────────────┐
  │ type: "pattern"  │ ──── direct ───▶│ type: "pattern"   │
  │ topicKey: "..."  │ ──── rename ───▶│ topic_key: "..."  │
  │ title: "..."     │ ─┐              │                    │
  │ content: "..."   │  │  JSON.stringify ▶ content: "{...}" │
  │ severity: "high" │  │              │                    │
  │ filePaths: [...]  │ ─┘              │                    │
  │ project: "o/r"   │ ──── meta ────▶│ metadata: {source, │
  │ sessionId: 1     │                 │   project, ...}    │
  └─────────────────┘                  └──────────────────┘

  On read: JSON.parse(content) → extract title, body, severity, filePaths
  On parse failure: treat as plain text, map with defaults
```

## File Changes

| File                                      | Action | Description                                                                                                                                                 |
| ----------------------------------------- | ------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/core/src/memory/engram.ts`      | Create | `EngramMemoryStorage` class: HTTP client, schema mapping, session ID bridging, graceful degradation. ~300 lines.                                            |
| `packages/core/src/memory/engram.test.ts` | Create | Unit tests for `EngramMemoryStorage`: mocked `fetch()`, schema mapping, degradation, all interface methods. ~400 lines.                                     |
| `packages/core/src/index.ts`              | Modify | Add `export { EngramMemoryStorage } from './memory/engram.js';` to the Memory section (line 78).                                                            |
| `apps/cli/src/commands/review.ts`         | Modify | Import `EngramMemoryStorage`. Add `--memory-backend` option. Replace hardcoded `SqliteMemoryStorage.create()` with backend selection logic (lines 155-164). |
| `apps/cli/src/index.ts`                   | Modify | Add `.option('--memory-backend <type>', ...)` to the `review` command definition. Pass `memoryBackend` through to `reviewCommand`.                          |

## Interfaces / Contracts

### EngramMemoryStorage Public API

```typescript
/** Options for creating an EngramMemoryStorage instance. */
interface EngramOptions {
  /** Engram server base URL (default: 'http://localhost:7437') */
  baseUrl: string;
  /** Fall back to SQLite if Engram is unreachable */
  fallbackToSqlite: boolean;
  /** SQLite database path for fallback (required if fallbackToSqlite is true) */
  sqlitePath?: string;
  /** HTTP request timeout in milliseconds (default: 5000) */
  timeoutMs?: number;
}

/**
 * Engram-backed memory storage.
 * Implements MemoryStorage by mapping each method to Engram HTTP API endpoints.
 * Uses native fetch() — no external dependencies.
 */
class EngramMemoryStorage implements MemoryStorage {
  /**
   * Async factory with health check and optional SQLite fallback.
   * Returns EngramMemoryStorage if Engram is reachable, otherwise
   * SqliteMemoryStorage (if fallback enabled) or throws.
   */
  static async create(options: EngramOptions): Promise<MemoryStorage>;

  // All MemoryStorage interface methods implemented:
  searchObservations(project, query, options?): Promise<MemoryObservationRow[]>;
  saveObservation(data): Promise<MemoryObservationRow>;
  createSession(data): Promise<{ id: number }>;
  endSession(sessionId, summary): Promise<void>;
  close(): Promise<void>;
  listObservations(options?): Promise<MemoryObservationDetail[]>;
  getObservation(id): Promise<MemoryObservationDetail | null>;
  deleteObservation(id): Promise<boolean>;
  getStats(): Promise<MemoryStats>;
  clearObservations(options?): Promise<number>;
}
```

### EngramClient (Private, Internal)

```typescript
/**
 * Thin HTTP client wrapping native fetch() for Engram REST API.
 * Not exported — internal implementation detail of EngramMemoryStorage.
 */
class EngramClient {
  constructor(baseUrl: string, timeoutMs: number);

  /** GET request, returns parsed JSON or null on error. */
  get<T>(path: string, params?: Record<string, string>): Promise<T | null>;

  /** POST request, returns parsed JSON or null on error. */
  post<T>(path: string, body: unknown): Promise<T | null>;

  /** DELETE request, returns true if 2xx, false otherwise. */
  delete(path: string): Promise<boolean>;

  /** Health check: GET /api/stats. Returns true if Engram is reachable. */
  isHealthy(): Promise<boolean>;
}
```

### Schema Mapping Functions (Private, Internal)

```typescript
/** GHAGGA observation data → Engram API request body */
function toEngramPayload(data: {
  sessionId?: number;
  project: string;
  type: string;
  title: string;
  content: string;
  topicKey?: string;
  filePaths?: string[];
  severity?: string;
}): {
  content: string; // JSON.stringify({ source, title, body, severity, filePaths, project })
  type: string;
  topic_key?: string;
  metadata: Record<string, unknown>;
};

/** Engram API response → GHAGGA MemoryObservationRow */
function fromEngramObservation(engram: EngramObservation): MemoryObservationRow;

/** Engram API response → GHAGGA MemoryObservationDetail */
function fromEngramObservationDetail(engram: EngramObservation): MemoryObservationDetail;
```

### Engram API Response Types (Private, Internal)

```typescript
/** Shape of an observation returned by Engram's REST API. */
interface EngramObservation {
  id: string; // UUID
  content: string; // May be GHAGGA-structured JSON or plain text
  type?: string;
  topic_key?: string;
  metadata?: Record<string, unknown>;
  revision_count?: number;
  created_at: string; // ISO 8601
  updated_at?: string; // ISO 8601
}

/** Shape of Engram's GET /api/stats response. */
interface EngramStats {
  total_observations: number;
  observations_by_type?: Record<string, number>;
  // Other fields TBD based on actual Engram API
}

/** Shape of Engram's POST /api/sessions response. */
interface EngramSession {
  id: string; // UUID
  metadata?: Record<string, unknown>;
  created_at: string;
}
```

### CLI ReviewOptions Extension

```typescript
// In apps/cli/src/commands/review.ts
export interface ReviewOptions {
  // ... existing fields ...
  /** Memory backend: 'sqlite' (default) or 'engram' */
  memoryBackend?: 'sqlite' | 'engram';
}
```

## Testing Strategy

| Layer | What to Test                                                | Approach                                                                                                                        |
| ----- | ----------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| Unit  | `EngramClient` HTTP methods                                 | Mock `global.fetch` with `vi.fn()`. Verify correct URL construction, headers, timeout handling, error paths.                    |
| Unit  | Schema mapping (`toEngramPayload`, `fromEngramObservation`) | Pure function tests. Verify JSON encoding/decoding, default handling for missing fields, plain-text content fallback.           |
| Unit  | All `MemoryStorage` interface methods                       | Mock `EngramClient`. Verify each method calls the correct endpoint, maps response correctly, handles errors gracefully.         |
| Unit  | Session ID bridging                                         | Verify `createSession` returns synthetic integer ID, `endSession` maps back to Engram UUID.                                     |
| Unit  | Graceful degradation — `create()`                           | Mock `fetch` to fail. Verify `create()` returns `SqliteMemoryStorage` when `fallbackToSqlite: true`, throws when `false`.       |
| Unit  | Graceful degradation — per-method                           | Mock `fetch` to fail on individual calls. Verify methods return safe defaults (empty arrays, `null`, `false`) and log warnings. |
| Unit  | `clearObservations` throws                                  | Verify the descriptive error message.                                                                                           |
| Unit  | Backend selection in CLI                                    | Test the branching logic in `review.ts` with different `memoryBackend` values.                                                  |

All tests use Vitest (the project's existing test runner), mocking `global.fetch` via `vi.stubGlobal('fetch', ...)`. No integration tests against a real Engram server — those would be manual verification during development.

The test file follows the exact pattern of `sqlite.test.ts`: `describe` blocks per method, `beforeEach`/`afterEach` for setup/teardown, explicit `expect` assertions on return shapes.

## Migration / Rollout

No migration required.
- The Engram adapter is additive: new file, new export, new CLI option.
- Default behavior is unchanged: `--memory-backend sqlite` (or no flag) produces identical behavior to current code.
- No database migrations, no schema changes, no config file format changes.
- No breaking changes to the `MemoryStorage` interface or any existing API.
- Rollback: delete `engram.ts`, revert the 3 modified files, done.

## Open Questions

- [x] **Where does EngramMemoryStorage live?** → `packages/core/src/memory/engram.ts` (decided above).
- [x] **HTTP client approach?** → Native `fetch()` with `EngramClient` wrapper (decided above).
- [x] **Schema mapping strategy?** → JSON in `content` field (decided above).
- [ ] **Engram API endpoint verification**: The proposal maps `MemoryStorage` methods to Engram endpoints (lines 91-102), but these are based on documented/expected API. Before implementation, the actual Engram API should be verified by reading Engram's source or running `engram serve` and hitting the endpoints. Key unknowns:
  - Does `DELETE /api/observations/:id` exist?
  - Does `GET /api/search` support `metadata` filters?
  - Does `POST /api/sessions` accept a `metadata` object?
  - Does `POST /api/sessions/:id/summary` exist?
  - What does the `GET /api/stats` response shape look like?
    If any endpoint is missing, the corresponding method becomes a no-op with a warning log (per the graceful degradation design). This does NOT block implementation — the adapter is designed to handle missing endpoints.
- [ ] **Engram observation IDs are UUIDs (strings), but `MemoryStorage` uses `number` IDs**: The session ID bridging is solved (synthetic map), but `getObservation(id: number)` and `deleteObservation(id: number)` also take numeric IDs. Two options: (a) maintain a global `Map<number, string>` for all observation IDs seen (populated on search/list), or (b) store the Engram UUID in the returned `MemoryObservationRow.id` by hashing to a stable integer. Option (a) is chosen for implementation — the map is populated by `searchObservations` and `listObservations`, and `getObservation`/`deleteObservation` look up the real UUID from the map. If the ID isn't in the map, the method returns `null`/`false` with a warning.
