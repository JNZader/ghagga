# Delta for Server

> **Change**: `blast-radius-diagram`
> **Base spec**: `openspec/specs/server/spec.md`

## MODIFIED Requirements

### Requirement: Dashboard REST API

The system MUST expose REST endpoints for the dashboard frontend.

The review DTO returned by `GET /api/reviews` MUST add exactly one new optional key — `blastRadiusDiagram` — carrying the blast-radius diagram data (capped node/edge lists plus legend flags) projected from the persisted `metadata` jsonb blob, with its shared shape declared in `packages/types/src/api.ts` (the server capability owns the API surface). Rationale: the diagram data already survives persistence inside the metadata blob; a single projected key makes it consumable by the dashboard without widening the DTO's trust surface or exposing raw metadata.

The key MUST be present only when the stored metadata contains diagram data (node/edge lists); when it does not, the key MUST be absent from the DTO (not `null`, not an empty object). No other DTO key, and no other endpoint, MAY change in this change.

#### Scenario: List reviews for a repository

- GIVEN an authenticated user with access to installation "org-123"
- WHEN GET /api/reviews?repo=owner/repo is called
- THEN the response MUST return paginated reviews for that repository
- AND results MUST be scoped to the user's installations only

#### Scenario: Update repository settings

- GIVEN an authenticated user who owns installation "org-123"
- WHEN PUT /api/repositories/:id/settings is called with valid settings
- THEN the repository settings MUST be updated in the database
- AND the response MUST return the updated settings

#### Scenario: Manage API keys

- GIVEN an authenticated user
- WHEN POST /api/repositories/:id/api-key is called with a provider and key
- THEN the key MUST be encrypted with AES-256-GCM before storage
- AND the original plaintext MUST NOT be stored or logged
- AND subsequent GET requests MUST NOT return the decrypted key (only a masked indicator like "sk-...xxxx")

#### Scenario: Review with diagram data returns the key

- GIVEN a persisted review whose `metadata.blastRadius` contains capped node/edge lists (5 nodes, 4 edges, `graphStale: false`, `exceededCap: false`)
- WHEN GET /api/reviews returns that review's DTO
- THEN the DTO MUST contain a `blastRadiusDiagram` key whose value carries the node list, edge list, and legend flags
- AND the projected values MUST match the persisted metadata without transformation loss (same node/edge counts, same flags)

#### Scenario: Review without diagram data omits the key

- GIVEN a persisted review whose `metadata.blastRadius` contains counts only (no node/edge lists — pre-change shape or oversize fallback)
- WHEN GET /api/reviews returns that review's DTO
- THEN the DTO MUST NOT contain the `blastRadiusDiagram` key
- AND the response MUST NOT contain `null` or empty-object placeholders for it
- AND every other DTO key MUST be identical to the pre-change DTO shape

#### Scenario: Backward compatibility for old clients

- GIVEN a dashboard client built before this change (no knowledge of `blastRadiusDiagram`) and a review list mixing reviews with and without diagram data
- WHEN the client consumes the GET /api/reviews response
- THEN the client MUST behave exactly as before this change (unknown optional key ignored, no shape validation failure)
- AND pre-existing reviews (rows persisted before this change) MUST never produce the key, because their metadata predates diagram lists
