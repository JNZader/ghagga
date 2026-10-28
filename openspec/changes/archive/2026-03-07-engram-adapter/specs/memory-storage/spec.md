# Delta for Memory Storage

> **Change**: `engram-adapter`
> **Domain**: memory-storage
> **Type**: Delta (extends existing spec R1–R25)
> **Status**: Draft

---

## ADDED Requirements

### Requirement: R26 — EngramMemoryStorage Implementation

The system MUST provide an `EngramMemoryStorage` class in `packages/core/src/memory/engram.ts` that implements the `MemoryStorage` interface by communicating with Engram's HTTP API.

The class MUST use Node.js built-in `fetch` (no new dependencies). It MUST NOT require any changes to the `MemoryStorage` interface — it implements the existing contract as-is.

#### Scenario: Instantiation with healthy Engram server

- GIVEN Engram is running at `http://localhost:7437`
- AND `GET /api/stats` returns a 200 response
- WHEN `EngramMemoryStorage.create({ baseUrl: 'http://localhost:7437', fallbackToSqlite: true, sqlitePath: '/path/to/memory.db' })` is called
- THEN it MUST return an `EngramMemoryStorage` instance
- AND the instance MUST be ready for all `MemoryStorage` operations

#### Scenario: Instantiation with unreachable Engram server and fallback enabled

- GIVEN Engram is not running (connection refused on `http://localhost:7437`)
- AND `fallbackToSqlite` is `true`
- AND `sqlitePath` is provided
- WHEN `EngramMemoryStorage.create(...)` is called
- THEN a warning MUST be logged: `[ghagga] Engram not available at <baseUrl>: <error message>`
- AND a second warning MUST be logged: `[ghagga] Falling back to SQLite memory`
- AND the method MUST return a `SqliteMemoryStorage` instance (not `EngramMemoryStorage`)

#### Scenario: Instantiation with unreachable Engram server and fallback disabled

- GIVEN Engram is not running
- AND `fallbackToSqlite` is `false`
- WHEN `EngramMemoryStorage.create(...)` is called
- THEN a warning MUST be logged
- AND the method MUST return `undefined` (memory disabled)

#### Scenario: Instantiation with Engram returning non-200 on health check

- GIVEN Engram is running but `GET /api/stats` returns HTTP 500
- WHEN `EngramMemoryStorage.create(...)` is called
- THEN it MUST treat this as Engram unavailable
- AND follow the fallback logic (same as unreachable server)

---

### Requirement: R27 — Engram HTTP API Mapping

Each `MemoryStorage` method MUST map to the corresponding Engram HTTP endpoint as specified below. All HTTP calls MUST include a configurable timeout (default: 5 seconds).

#### R27.1: searchObservations

`searchObservations(project, query, options?)` MUST send `GET /api/search` with query parameters `q=<query>&limit=<limit>`.

Results MUST be filtered client-side to include only observations where `project` matches the provided project parameter (extracted from structured content metadata or Engram's `project` field).

When `options.type` is provided, results MUST be further filtered client-side by observation type.

#### Scenario: Search with results from mixed sources

- GIVEN Engram contains 5 observations: 3 saved by GHAGGA for project "acme/widgets", 1 saved by Claude Code for project "acme/widgets", 1 saved by GHAGGA for project "acme/gadgets"
- WHEN `searchObservations("acme/widgets", "auth", { limit: 10 })` is called
- THEN Engram's `/api/search?q=auth&limit=10` MUST be called
- AND results MUST be filtered to include only observations where project = "acme/widgets"
- AND both GHAGGA-origin and Claude Code-origin observations MUST be included (4 max)
- AND the "acme/gadgets" observation MUST NOT be included
- AND each returned row MUST conform to the `MemoryObservationRow` interface

#### Scenario: Search with type filter

- GIVEN Engram contains observations of types "pattern", "bugfix", "learning" for project "acme/widgets"
- WHEN `searchObservations("acme/widgets", "auth", { limit: 10, type: "pattern" })` is called
- THEN only observations where `type = "pattern"` MUST be returned

#### Scenario: Search returns empty results

- GIVEN Engram has no observations matching the query
- WHEN `searchObservations("acme/widgets", "xyznonexistent")` is called
- THEN an empty array MUST be returned

#### Scenario: Search with Engram HTTP error

- GIVEN Engram returns HTTP 500 on the search request
- WHEN `searchObservations(...)` is called
- THEN a warning MUST be logged
- AND an empty array MUST be returned (graceful degradation)
- AND the review MUST NOT be blocked

---

#### R27.2: saveObservation

`saveObservation(data)` MUST send `POST /api/save` with the mapped body.

The request body MUST include:
- `type`: mapped directly from `data.type`
- `title`: mapped directly from `data.title`
- `content`: mapped directly from `data.content`
- `topic_key`: mapped from `data.topicKey` (field rename)
- `project`: mapped directly from `data.project`
- `scope`: set to `data.project` (reuse project as scope)

Fields without native Engram equivalents MUST be encoded in a structured metadata section appended to the `content` field or passed through Engram's metadata capability:
- `severity`: MUST be preserved (via metadata or structured content)
- `filePaths`: MUST be preserved (via metadata or structured content)
- `sessionId`: MUST be preserved (via metadata)

The response MUST be mapped back to a `MemoryObservationRow`.

#### Scenario: Save a GHAGGA observation to Engram

- GIVEN Engram is running and healthy
- WHEN `saveObservation({ project: "acme/widgets", type: "pattern", title: "Auth config", content: "OAuth patterns observed", topicKey: "pr-42-review", filePaths: ["src/auth.ts"], severity: "medium" })` is called
- THEN `POST /api/save` MUST be called with a body containing `type: "pattern"`, `title: "Auth config"`, `content` containing "OAuth patterns observed", and `topic_key: "pr-42-review"`
- AND `severity` and `filePaths` MUST be preserved in the saved data
- AND `project` MUST be set to "acme/widgets"
- AND the returned `MemoryObservationRow` MUST have `id`, `type`, `title`, `content`, `filePaths`, and `severity` populated

#### Scenario: Save with Engram HTTP error

- GIVEN Engram returns HTTP 500 on the save request
- WHEN `saveObservation(...)` is called
- THEN a warning MUST be logged with the error details
- AND the method MUST return a synthetic `MemoryObservationRow` with `id: -1` (indicating failure)
- AND the review MUST NOT be blocked

#### Scenario: Save observation without optional fields

- GIVEN `topicKey`, `filePaths`, `severity`, and `sessionId` are all omitted
- WHEN `saveObservation({ project: "acme/widgets", type: "learning", title: "TIL", content: "Today I learned..." })` is called
- THEN the request MUST succeed with only the required fields
- AND optional metadata fields MUST be absent or null in the request

---

#### R27.3: createSession

`createSession(data)` MUST send `POST /api/sessions` with body `{ project: data.project }`.

The GHAGGA `prNumber` field SHOULD be included in the session metadata if Engram supports metadata on sessions.

The response MUST return `{ id: number }` mapped from Engram's session ID.

#### Scenario: Create a review session

- GIVEN Engram is running
- WHEN `createSession({ project: "acme/widgets", prNumber: 42 })` is called
- THEN `POST /api/sessions` MUST be called with `{ project: "acme/widgets" }`
- AND the response MUST include a numeric session ID
- AND `{ id: <sessionId> }` MUST be returned

#### Scenario: Create session with Engram error

- GIVEN Engram returns HTTP 500
- WHEN `createSession(...)` is called
- THEN a warning MUST be logged
- AND `{ id: -1 }` MUST be returned (indicating failure)

---

#### R27.4: endSession

`endSession(sessionId, summary)` MUST send `POST /api/sessions/<sessionId>/summary` with body `{ summary }`.

#### Scenario: End a review session

- GIVEN a session with ID 7 was previously created
- WHEN `endSession(7, "Review complete: 3 patterns, 1 bugfix")` is called
- THEN `POST /api/sessions/7/summary` MUST be called with body `{ summary: "Review complete: 3 patterns, 1 bugfix" }`

#### Scenario: End session with invalid session ID

- GIVEN the session ID -1 was returned from a failed createSession
- WHEN `endSession(-1, "...")` is called
- THEN the call MUST be a no-op (skip the HTTP request)
- AND no error MUST be thrown

#### Scenario: End session with Engram error

- GIVEN Engram returns HTTP 404 for the session ID
- WHEN `endSession(sessionId, summary)` is called
- THEN a warning MUST be logged
- AND no error MUST be thrown

---

#### R27.5: getObservation

`getObservation(id)` MUST send `GET /api/observations/<id>`.

The Engram response MUST be mapped to `MemoryObservationDetail`.

#### Scenario: Get existing observation

- GIVEN Engram has observation ID 42 saved by GHAGGA with structured content
- WHEN `getObservation(42)` is called
- THEN `GET /api/observations/42` MUST be called
- AND the response MUST be mapped to a `MemoryObservationDetail` with all fields populated
- AND `filePaths` and `severity` MUST be extracted from structured content

#### Scenario: Get non-GHAGGA observation

- GIVEN Engram has observation ID 99 saved by Claude Code with plain text content
- WHEN `getObservation(99)` is called
- THEN the content MUST be treated as plain text (JSON parse fails gracefully)
- AND `type` MUST default to the Engram observation's type or `"observation"`
- AND `filePaths` MUST be `null`
- AND `severity` MUST be `null`
- AND `revisionCount` MUST be `1`

#### Scenario: Get non-existent observation

- GIVEN Engram returns HTTP 404 for observation ID 999
- WHEN `getObservation(999)` is called
- THEN `null` MUST be returned

---

#### R27.6: deleteObservation

`deleteObservation(id)` MUST send `DELETE /api/observations/<id>`.

#### Scenario: Delete existing observation

- GIVEN Engram has observation ID 42
- WHEN `deleteObservation(42)` is called
- THEN `DELETE /api/observations/42` MUST be called
- AND `true` MUST be returned

#### Scenario: Delete non-existent observation

- GIVEN Engram returns HTTP 404 for observation ID 999
- WHEN `deleteObservation(999)` is called
- THEN `false` MUST be returned

---

#### R27.7: listObservations

`listObservations(options?)` MUST send `GET /api/search` with appropriate filters to retrieve observations.

Results MUST be filtered client-side by `project` and `type` when those options are provided. Pagination (`limit`, `offset`) MUST be applied client-side if Engram's search API does not support offset natively.

#### Scenario: List all observations

- GIVEN Engram contains 30 observations across multiple projects
- WHEN `listObservations({ limit: 20, offset: 0 })` is called
- THEN at most 20 `MemoryObservationDetail` records MUST be returned
- AND results MUST be ordered newest first

#### Scenario: List with project filter

- GIVEN Engram contains observations for "acme/widgets" and "acme/gadgets"
- WHEN `listObservations({ project: "acme/widgets", limit: 10 })` is called
- THEN only observations for "acme/widgets" MUST be returned

---

#### R27.8: getStats

`getStats()` MUST send `GET /api/stats` and map the response to `MemoryStats`.

The Engram stats response MUST be transformed to include `totalObservations`, `byType`, `byProject`, `oldestObservation`, and `newestObservation`.

If Engram's stats endpoint does not provide all fields natively, the adapter MAY make additional requests or return partial data with sensible defaults.

#### Scenario: Get stats from populated Engram

- GIVEN Engram has 150 observations across 3 projects and 4 types
- WHEN `getStats()` is called
- THEN `GET /api/stats` MUST be called
- AND the returned `MemoryStats` MUST have `totalObservations >= 150`
- AND `byType` and `byProject` MUST be populated

#### Scenario: Get stats from empty Engram

- GIVEN Engram has no observations
- WHEN `getStats()` is called
- THEN `totalObservations` MUST be `0`
- AND `byType` and `byProject` MUST be empty objects
- AND `oldestObservation` and `newestObservation` MUST be `null`

---

#### R27.9: clearObservations

`clearObservations(options?)` MUST throw an `Error` with message: `'clearObservations not supported with Engram backend. Use engram CLI directly.'`

Engram's HTTP API does not provide a bulk delete endpoint. Users MUST use `engram tui` or `engram` CLI for bulk management.

#### Scenario: Attempt to clear observations

- GIVEN the Engram adapter is active
- WHEN `clearObservations()` is called
- THEN an `Error` MUST be thrown with message `'clearObservations not supported with Engram backend. Use engram CLI directly.'`

#### Scenario: Attempt to clear observations scoped to project

- GIVEN the Engram adapter is active
- WHEN `clearObservations({ project: "acme/widgets" })` is called
- THEN the same `Error` MUST be thrown (no support regardless of options)

---

#### R27.10: close

`close()` MUST be a no-op. HTTP is stateless; there are no resources to release.

#### Scenario: Close the adapter

- GIVEN an active `EngramMemoryStorage` instance
- WHEN `close()` is called
- THEN no error MUST be thrown
- AND no HTTP request MUST be made

---

### Requirement: R28 — Schema Mapping Layer

The adapter MUST include a bidirectional mapping layer that translates between GHAGGA's memory model and Engram's observation model.

#### R28.1: GHAGGA-to-Engram Mapping (on save)

When saving, the adapter MUST map GHAGGA fields to Engram fields:

| GHAGGA Field | Engram Field | Mapping                                                                                  |
| ------------ | ------------ | ---------------------------------------------------------------------------------------- |
| `type`       | `type`       | Direct                                                                                   |
| `title`      | `title`      | Direct                                                                                   |
| `content`    | `content`    | Wrapped in structured JSON with `source`, `body`, `severity`, `filePaths`, and `project` |
| `topicKey`   | `topic_key`  | Rename                                                                                   |
| `project`    | `project`    | Direct                                                                                   |
| `filePaths`  | (in content) | Encoded in structured content JSON                                                       |
| `severity`   | (in content) | Encoded in structured content JSON                                                       |

The structured content JSON MUST follow the format:

```json
{
  "source": "ghagga",
  "title": "<title>",
  "body": "<original content>",
  "severity": "<severity or null>",
  "filePaths": ["<paths>"],
  "project": "<project>"
}
```

#### R28.2: Engram-to-GHAGGA Mapping (on read)

When reading, the adapter MUST attempt to parse the `content` field as JSON. If parsing succeeds and the JSON has `source: "ghagga"`, the adapter MUST extract `title`, `body`, `severity`, `filePaths`, and `project` from the structured content.

If JSON parsing fails (content from another tool like Claude Code or GGA), the adapter MUST:
- Use the raw content as-is for `content`
- Extract `title` from the Engram observation's title field, or fall back to the first 80 characters of content
- Set `filePaths` to `null`
- Set `severity` to `null`
- Set `revisionCount` to `1` (Engram does not track revisions)
- Derive `project` from Engram's `project` field or metadata, defaulting to `"unknown"`

#### Scenario: Round-trip GHAGGA observation through Engram

- GIVEN a GHAGGA observation is saved with `severity: "high"`, `filePaths: ["src/auth.ts", "lib/pool.ts"]`, and `content: "OAuth refresh token not rotated"`
- WHEN the same observation is read back from Engram
- THEN `severity` MUST be `"high"`
- AND `filePaths` MUST be `["src/auth.ts", "lib/pool.ts"]`
- AND `content` MUST be `"OAuth refresh token not rotated"`

#### Scenario: Read non-GHAGGA observation from Engram

- GIVEN an observation in Engram was saved by Claude Code with plain text content "Always use parameterized queries for SQL"
- WHEN the adapter reads this observation
- THEN `content` MUST be `"Always use parameterized queries for SQL"`
- AND `type` MUST be the Engram observation's type or `"observation"`
- AND `filePaths` MUST be `null`
- AND `severity` MUST be `null`

#### Scenario: Read observation with malformed JSON content

- GIVEN an observation in Engram has content `"{ invalid json"`
- WHEN the adapter reads this observation
- THEN the adapter MUST NOT throw
- AND the raw content MUST be used as-is
- AND default mappings MUST be applied for `filePaths`, `severity`, etc.

---

### Requirement: R29 — HTTP Timeout and Error Resilience

All HTTP requests to Engram MUST use a configurable timeout. Individual method failures MUST NOT propagate as thrown exceptions (except `clearObservations` which intentionally throws).

#### R29.1: Timeout Configuration

The timeout MUST default to 5 seconds. It MUST be configurable via `GHAGGA_ENGRAM_TIMEOUT` environment variable (value in seconds).

#### R29.2: Error Handling Policy

Every HTTP request MUST be wrapped in error handling. On any HTTP or network error:
- A warning MUST be logged with the method name, URL, and error message
- The method MUST return a safe default value:
  - `searchObservations` → `[]`
  - `saveObservation` → synthetic row with `id: -1`
  - `createSession` → `{ id: -1 }`
  - `endSession` → void (no-op)
  - `getObservation` → `null`
  - `deleteObservation` → `false`
  - `listObservations` → `[]`
  - `getStats` → `{ totalObservations: 0, byType: {}, byProject: {}, oldestObservation: null, newestObservation: null }`

#### Scenario: HTTP timeout on save

- GIVEN Engram takes longer than 5 seconds to respond to `POST /api/save`
- WHEN `saveObservation(...)` is called
- THEN the request MUST be aborted after the timeout
- AND a warning MUST be logged: `[ghagga] Engram saveObservation timed out after 5s`
- AND a synthetic row with `id: -1` MUST be returned
- AND the review MUST continue normally

#### Scenario: Network error on search

- GIVEN Engram's host is unreachable (DNS resolution failure)
- WHEN `searchObservations(...)` is called
- THEN a warning MUST be logged
- AND an empty array MUST be returned
- AND the review MUST continue without memory context

#### Scenario: Custom timeout via environment variable

- GIVEN `GHAGGA_ENGRAM_TIMEOUT=10` is set
- WHEN any HTTP request is made to Engram
- THEN the timeout MUST be 10 seconds (not the default 5)

---

### Requirement: R30 — Engram Source Tagging

All observations saved by GHAGGA to Engram MUST be identifiable as originating from GHAGGA.

The structured content JSON MUST include `"source": "ghagga"`. This enables other tools (Engram TUI, Claude Code, GGA) to identify and filter GHAGGA-origin observations.

#### Scenario: GHAGGA observation visible in Engram TUI

- GIVEN a review is run with `--memory-backend engram`
- AND the review produces 3 observations
- WHEN the user opens `engram tui`
- THEN all 3 observations MUST be visible
- AND each MUST be identifiable as from GHAGGA (via structured content with `source: "ghagga"`)

#### Scenario: Filter GHAGGA observations in Engram search

- GIVEN Engram contains observations from GHAGGA, Claude Code, and GGA
- WHEN `GET /api/search?q=ghagga` is called
- THEN GHAGGA observations MUST match (the content contains `"source": "ghagga"`)

---

## MODIFIED Requirements

### Requirement: R6 — CLI Memory Integration (Modified)

The CLI memory initialization logic MUST be extended to support backend selection.

(Previously: The CLI always used `SqliteMemoryStorage` when memory was enabled.)

#### R6.6: Memory Backend Selection

The CLI MUST support selecting the memory backend via:
1. `--memory-backend <backend>` CLI option on the `review` command
2. `GHAGGA_MEMORY_BACKEND` environment variable

Priority: CLI flag > environment variable > default (`sqlite`).

Valid values MUST be: `sqlite` (default), `engram`.

Invalid values MUST cause the CLI to exit with an error message listing valid backends.

#### Scenario: Select Engram backend via CLI flag

- GIVEN the user runs `ghagga review . --memory-backend engram`
- AND Engram is running at `http://localhost:7437`
- WHEN the review command initializes memory
- THEN `EngramMemoryStorage.create(...)` MUST be called
- AND the review MUST use the Engram adapter for all memory operations

#### Scenario: Select Engram backend via environment variable

- GIVEN `GHAGGA_MEMORY_BACKEND=engram` is set
- AND the user runs `ghagga review .` (no CLI flag)
- WHEN the review command initializes memory
- THEN `EngramMemoryStorage.create(...)` MUST be called

#### Scenario: CLI flag overrides environment variable

- GIVEN `GHAGGA_MEMORY_BACKEND=engram` is set
- AND the user runs `ghagga review . --memory-backend sqlite`
- WHEN the review command initializes memory
- THEN `SqliteMemoryStorage.create(...)` MUST be called (CLI flag wins)

#### Scenario: Invalid backend value

- GIVEN the user runs `ghagga review . --memory-backend redis`
- THEN the CLI MUST exit with code 1
- AND the error message MUST include the valid backends: `sqlite`, `engram`

#### Scenario: Default backend unchanged

- GIVEN no `--memory-backend` flag and no `GHAGGA_MEMORY_BACKEND` env var
- WHEN the review command initializes memory
- THEN `SqliteMemoryStorage.create(...)` MUST be called (existing behavior preserved)

---

#### R6.7: Engram Host Configuration

When the Engram backend is selected, the Engram server URL MUST be configurable via:
- `GHAGGA_ENGRAM_HOST` environment variable (default: `http://localhost:7437`)

#### Scenario: Custom Engram host

- GIVEN `GHAGGA_ENGRAM_HOST=http://192.168.1.100:7437` is set
- AND `--memory-backend engram` is used
- WHEN `EngramMemoryStorage.create(...)` is called
- THEN `baseUrl` MUST be `http://192.168.1.100:7437`

#### Scenario: Default Engram host

- GIVEN `GHAGGA_ENGRAM_HOST` is not set
- WHEN `EngramMemoryStorage.create(...)` is called
- THEN `baseUrl` MUST be `http://localhost:7437`

---

#### R6.8: Graceful Fallback to SQLite

When the Engram backend is selected but Engram is not running, the CLI MUST fall back to SQLite automatically.

The fallback MUST:
1. Log a warning about Engram unavailability
2. Log a message about falling back to SQLite
3. Create a `SqliteMemoryStorage` instance at the standard path
4. Proceed with the review using SQLite

The review MUST NOT fail due to Engram being unavailable.

#### Scenario: Engram selected but not running

- GIVEN `--memory-backend engram` is used
- AND Engram is not running (connection refused)
- WHEN the review command initializes memory
- THEN a warning MUST be logged: `[ghagga] Engram not available at http://localhost:7437: <error>`
- AND a message MUST be logged: `[ghagga] Falling back to SQLite memory`
- AND `SqliteMemoryStorage.create(...)` MUST be called
- AND the review MUST complete successfully using SQLite

#### Scenario: Engram selected but not running, --no-memory also set

- GIVEN `--memory-backend engram` and `--no-memory` are both used
- WHEN the review command processes options
- THEN `--no-memory` MUST take precedence
- AND no memory storage MUST be initialized (neither Engram nor SQLite)

---

## REMOVED Requirements

(No requirements are removed by this change.)

---

## Cross-Cutting Concerns

### CC9: CLI-Only Availability

The Engram adapter MUST only be available in CLI mode. The SaaS server (`apps/server/`) MUST always use `PostgresMemoryStorage`. The GitHub Action (`apps/action/`) MUST always use `SqliteMemoryStorage`. The Engram backend option MUST NOT be exposed in server or action configuration.

### CC10: No New Dependencies

The `EngramMemoryStorage` class MUST use Node.js built-in `fetch` for HTTP communication. No new npm dependencies MUST be added to `packages/core` or `apps/cli`.

### CC11: Runtime-Only Dependency

Engram is a runtime dependency only when `--memory-backend engram` is selected. It MUST NOT be required at build time, install time, or test time. The adapter class MUST be importable and type-checkable without Engram running.

### CC12: Memory Management Commands

The existing `ghagga memory list/search/show/delete/stats/clear` commands (R16–R22) are scoped to SQLite only. When the Engram backend is selected for reviews, memory management MUST still use the local SQLite database. Users MUST use `engram tui` or `engram` CLI for managing Engram observations directly. This separation is intentional: management commands operate on the local cache, reviews can optionally use the shared Engram store.
