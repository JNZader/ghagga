# Delta for Server

> **Change**: `batch-delete-reviews-memory`
> **Base spec**: `openspec/specs/server/spec.md`

## ADDED Requirements

### Requirement: Single Review Delete Endpoint

The system MUST expose `DELETE /api/reviews/:reviewId` to delete a single review by its numeric ID.

The `:reviewId` parameter MUST be validated as a positive integer. If the parameter is not a valid positive integer, the system MUST return HTTP 400 with error code `VALIDATION_ERROR`.

Authorization MUST verify that the review belongs to a repository owned by one of the authenticated user's installations. The system MUST resolve the review's `repositoryId` to the repository's `installationId` and confirm it exists in `user.installationIds`.

The response envelope MUST be `{ data: { deleted: true } }` on success.

If the review does not exist, the system MUST return HTTP 404 with error code `NOT_FOUND`.

If the review exists but belongs to a repository not owned by the user's installations, the system MUST return HTTP 404 (not 403) to avoid leaking the existence of other users' reviews.

Route registration: This route MUST be registered AFTER `DELETE /api/reviews/batch` (literal routes before parameterized) to avoid the literal "batch" being captured as a `:reviewId` param. It MUST also coexist with the existing `DELETE /api/reviews/:repoFullName` route; numeric-only validation on `:reviewId` disambiguates from `repoFullName` which always contains a `/` character.

#### Scenario: Delete an existing review owned by the user

- GIVEN an authenticated user with installation ID 1
- AND a review with ID 42 exists, belonging to a repository owned by installation 1
- WHEN `DELETE /api/reviews/42` is called
- THEN the response MUST be HTTP 200 with body `{ data: { deleted: true } }`
- AND the review MUST be permanently deleted from the database

#### Scenario: Delete a review that does not exist

- GIVEN an authenticated user
- AND no review with ID 9999 exists
- WHEN `DELETE /api/reviews/9999` is called
- THEN the response MUST be HTTP 404 with error code `NOT_FOUND`

#### Scenario: Delete a review owned by another installation

- GIVEN an authenticated user with installation ID 1
- AND a review with ID 42 exists, belonging to a repository owned by installation 2
- WHEN `DELETE /api/reviews/42` is called
- THEN the response MUST be HTTP 404 with error code `NOT_FOUND`
- AND the review MUST NOT be deleted

#### Scenario: Non-numeric reviewId parameter

- GIVEN an authenticated user
- WHEN `DELETE /api/reviews/abc` is called
- THEN the response MUST be HTTP 400 with error code `VALIDATION_ERROR`

#### Scenario: Unauthenticated request

- GIVEN a request without a valid Bearer token
- WHEN `DELETE /api/reviews/42` is called
- THEN the response MUST be HTTP 401

#### Scenario: Server error during delete

- GIVEN a database error occurs during the delete operation
- WHEN `DELETE /api/reviews/42` is called
- THEN the response MUST be HTTP 500 with error code `DELETE_FAILED`
- AND the response MUST include an `errorId` for correlation
- AND the error MUST be logged with the errorId

### Requirement: Batch Review Delete Endpoint

The system MUST expose `DELETE /api/reviews/batch` to delete multiple reviews by their IDs in a single request.

The request body MUST be validated with Zod against the schema `{ ids: number[] }` where:
- `ids` MUST be a non-empty array (minimum 1 element)
- `ids` MUST contain at most 100 elements
- Each element MUST be a positive integer

If validation fails, the system MUST return HTTP 400 with error code `VALIDATION_ERROR` and a message describing the constraint violation.

Authorization MUST scope the delete to repositories owned by the user's installations. IDs that do not exist or do not belong to the user's installations MUST be silently skipped (no per-item 403). The response returns the count of actually deleted items.

The response envelope MUST be `{ data: { deletedCount: number } }`.

Route registration: This route MUST be registered BEFORE `DELETE /api/reviews/:reviewId` and `DELETE /api/reviews/:repoFullName` to ensure the literal path `/api/reviews/batch` matches first.

#### Scenario: Batch delete reviews all owned by the user

- GIVEN an authenticated user with installation ID 1
- AND reviews with IDs [10, 20, 30] exist, all belonging to repositories owned by installation 1
- WHEN `DELETE /api/reviews/batch` is called with body `{ "ids": [10, 20, 30] }`
- THEN the response MUST be HTTP 200 with body `{ data: { deletedCount: 3 } }`
- AND all three reviews MUST be permanently deleted

#### Scenario: Batch delete with some IDs not owned by user

- GIVEN an authenticated user with installation ID 1
- AND reviews 10, 20 belong to installation 1 and review 30 belongs to installation 2
- WHEN `DELETE /api/reviews/batch` is called with body `{ "ids": [10, 20, 30] }`
- THEN the response MUST be HTTP 200 with body `{ data: { deletedCount: 2 } }`
- AND only reviews 10 and 20 MUST be deleted
- AND review 30 MUST NOT be deleted

#### Scenario: Batch delete with some IDs that do not exist

- GIVEN an authenticated user with installation ID 1
- AND review 10 exists (owned by installation 1) but review 9999 does not exist
- WHEN `DELETE /api/reviews/batch` is called with body `{ "ids": [10, 9999] }`
- THEN the response MUST be HTTP 200 with body `{ data: { deletedCount: 1 } }`

#### Scenario: Batch delete with none of the IDs owned by user

- GIVEN an authenticated user with installation ID 1
- AND reviews [10, 20] belong to installation 2
- WHEN `DELETE /api/reviews/batch` is called with body `{ "ids": [10, 20] }`
- THEN the response MUST be HTTP 200 with body `{ data: { deletedCount: 0 } }`

#### Scenario: Empty ids array

- GIVEN an authenticated user
- WHEN `DELETE /api/reviews/batch` is called with body `{ "ids": [] }`
- THEN the response MUST be HTTP 400 with error code `VALIDATION_ERROR`

#### Scenario: ids array exceeds 100 elements

- GIVEN an authenticated user
- WHEN `DELETE /api/reviews/batch` is called with body `{ "ids": [1, 2, ..., 101] }` (101 elements)
- THEN the response MUST be HTTP 400 with error code `VALIDATION_ERROR`

#### Scenario: ids contains non-integer values

- GIVEN an authenticated user
- WHEN `DELETE /api/reviews/batch` is called with body `{ "ids": [1, "abc", 3] }`
- THEN the response MUST be HTTP 400 with error code `VALIDATION_ERROR`

#### Scenario: Missing ids field

- GIVEN an authenticated user
- WHEN `DELETE /api/reviews/batch` is called with body `{}`
- THEN the response MUST be HTTP 400 with error code `VALIDATION_ERROR`

#### Scenario: Unauthenticated request

- GIVEN a request without a valid Bearer token
- WHEN `DELETE /api/reviews/batch` is called
- THEN the response MUST be HTTP 401

#### Scenario: Server error during batch delete

- GIVEN a database error occurs during the batch delete operation
- WHEN `DELETE /api/reviews/batch` is called with a valid body
- THEN the response MUST be HTTP 500 with error code `DELETE_FAILED`
- AND the response MUST include an `errorId` for correlation

### Requirement: Batch Memory Observation Delete Endpoint

The system MUST expose `DELETE /api/memory/observations/batch` to delete multiple memory observations by their IDs in a single request.

The request body MUST be validated with Zod against the schema `{ ids: number[] }` where:
- `ids` MUST be a non-empty array (minimum 1 element)
- `ids` MUST contain at most 100 elements
- Each element MUST be a positive integer

If validation fails, the system MUST return HTTP 400 with error code `VALIDATION_ERROR`.

Authorization MUST scope the delete to observations whose `project` field matches a repository owned by the user's installations (same pattern as `deleteMemoryObservation`). IDs that do not exist or do not belong to the user's installations MUST be silently skipped.

The response envelope MUST be `{ data: { deletedCount: number } }`.

Route registration: This route MUST be registered AFTER `DELETE /api/memory/observations` (the purge-all route) and BEFORE `DELETE /api/memory/observations/:id` to ensure correct matching. The literal path `batch` MUST match before the `:id` parameter.

#### Scenario: Batch delete observations all owned by the user

- GIVEN an authenticated user with installation ID 1
- AND observations with IDs [5, 10, 15] exist, all belonging to projects of repositories owned by installation 1
- WHEN `DELETE /api/memory/observations/batch` is called with body `{ "ids": [5, 10, 15] }`
- THEN the response MUST be HTTP 200 with body `{ data: { deletedCount: 3 } }`
- AND all three observations MUST be permanently deleted

#### Scenario: Batch delete with some IDs not owned by user

- GIVEN an authenticated user with installation ID 1
- AND observations 5, 10 belong to installation 1's projects and observation 15 belongs to installation 2's projects
- WHEN `DELETE /api/memory/observations/batch` is called with body `{ "ids": [5, 10, 15] }`
- THEN the response MUST be HTTP 200 with body `{ data: { deletedCount: 2 } }`
- AND only observations 5 and 10 MUST be deleted

#### Scenario: Batch delete with some non-existent IDs

- GIVEN an authenticated user with installation ID 1
- AND observation 5 exists (owned) but 9999 does not
- WHEN `DELETE /api/memory/observations/batch` is called with body `{ "ids": [5, 9999] }`
- THEN the response MUST be HTTP 200 with body `{ data: { deletedCount: 1 } }`

#### Scenario: Empty ids array

- GIVEN an authenticated user
- WHEN `DELETE /api/memory/observations/batch` is called with body `{ "ids": [] }`
- THEN the response MUST be HTTP 400 with error code `VALIDATION_ERROR`

#### Scenario: ids array exceeds 100 elements

- GIVEN an authenticated user
- WHEN `DELETE /api/memory/observations/batch` is called with 101 IDs
- THEN the response MUST be HTTP 400 with error code `VALIDATION_ERROR`

#### Scenario: ids contains non-integer values

- GIVEN an authenticated user
- WHEN `DELETE /api/memory/observations/batch` is called with body `{ "ids": [1, "x"] }`
- THEN the response MUST be HTTP 400 with error code `VALIDATION_ERROR`

#### Scenario: Missing ids field

- GIVEN an authenticated user
- WHEN `DELETE /api/memory/observations/batch` is called with body `{}`
- THEN the response MUST be HTTP 400 with error code `VALIDATION_ERROR`

#### Scenario: Unauthenticated request

- GIVEN a request without a valid Bearer token
- WHEN `DELETE /api/memory/observations/batch` is called
- THEN the response MUST be HTTP 401

#### Scenario: Server error during batch delete

- GIVEN a database error occurs during the batch delete operation
- WHEN `DELETE /api/memory/observations/batch` is called with a valid body
- THEN the response MUST be HTTP 500 with error code `DELETE_FAILED`
- AND the response MUST include an `errorId` for correlation

### Requirement: Database Query Functions for Granular and Batch Deletes

The `packages/db/src/queries.ts` module MUST export three new functions:
1. `deleteReviewById(db, installationId, reviewId)` — Deletes a single review by its numeric ID, scoped to the given installation. MUST join through the `repositories` table to verify the review's repository belongs to the installation. MUST return `true` if a row was deleted, `false` otherwise.

2. `deleteReviewsByIds(db, installationId, reviewIds)` — Deletes multiple reviews by their IDs, scoped to the given installation. MUST use Drizzle's `inArray` with installation scoping via a subquery on `repositories`. MUST return the count of actually deleted rows. MUST be a no-op (return 0) if `reviewIds` is empty.

3. `deleteMemoryObservationsByIds(db, installationId, observationIds)` — Deletes multiple memory observations by their IDs, scoped to the given installation. MUST use the same installation-scoping pattern as the existing `deleteMemoryObservation` (subquery on `repositories.fullName` matching `memoryObservations.project`). MUST return the count of actually deleted rows. MUST be a no-op (return 0) if `observationIds` is empty.

#### Scenario: deleteReviewById deletes an owned review

- GIVEN a review with ID 42 belongs to repository R1, which is owned by installation 1
- WHEN `deleteReviewById(db, 1, 42)` is called
- THEN the function MUST return `true`
- AND the review row MUST be deleted from the database

#### Scenario: deleteReviewById returns false for unowned review

- GIVEN a review with ID 42 belongs to a repository owned by installation 2
- WHEN `deleteReviewById(db, 1, 42)` is called
- THEN the function MUST return `false`
- AND the review MUST NOT be deleted

#### Scenario: deleteReviewsByIds deletes only owned reviews

- GIVEN reviews [10, 20] owned by installation 1, review 30 owned by installation 2
- WHEN `deleteReviewsByIds(db, 1, [10, 20, 30])` is called
- THEN the function MUST return `2`
- AND only reviews 10 and 20 MUST be deleted

#### Scenario: deleteReviewsByIds with empty array

- GIVEN an empty array of IDs
- WHEN `deleteReviewsByIds(db, 1, [])` is called
- THEN the function MUST return `0`
- AND no database DELETE query SHOULD be executed

#### Scenario: deleteMemoryObservationsByIds deletes only owned observations

- GIVEN observations [5, 10] belong to projects owned by installation 1
- AND observation 15 belongs to a project owned by installation 2
- WHEN `deleteMemoryObservationsByIds(db, 1, [5, 10, 15])` is called
- THEN the function MUST return `2`
- AND only observations 5 and 10 MUST be deleted

#### Scenario: deleteMemoryObservationsByIds with empty array

- GIVEN an empty array of IDs
- WHEN `deleteMemoryObservationsByIds(db, 1, [])` is called
- THEN the function MUST return `0`
- AND no database DELETE query SHOULD be executed

## MODIFIED Requirements

_(No existing server requirements are modified by this change.)_

## REMOVED Requirements

_(No existing server requirements are removed by this change.)_
