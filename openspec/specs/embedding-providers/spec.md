# Embedding Providers Specification

## Purpose

Defines a provider-agnostic embedding subsystem: config/env-driven selection of a concrete `EmbeddingProvider`, an optional local provider that never breaks the Action bundle, and dimension-safe storage/read metadata so mixed-provider history never corrupts retrieval.

## Requirements

### Requirement: Provider Selection via Registry/Factory

The system MUST resolve a concrete `EmbeddingProvider` (implementing `embed`, `embedBatch`, `dimension` from `packages/core/src/embed.ts`) through a registry/factory keyed by a config/env value. The factory MUST support at minimum: `none` (no provider), one API-based provider, and one local provider identifier.

#### Scenario: Default is none

- GIVEN no embedding-provider config/env value is set in any context (server, CLI, Action)
- WHEN the factory resolves a provider
- THEN it MUST return no provider (`undefined`/`null`)
- AND `searchObservations` MUST take the keyword-only path

#### Scenario: Explicit provider selected

- GIVEN config/env specifies a known API provider id and valid credentials
- WHEN the factory resolves a provider
- THEN it MUST return a concrete `EmbeddingProvider` instance implementing `embed`/`embedBatch`/`dimension`

#### Scenario: Unknown provider id

- GIVEN config/env specifies a provider id not registered in the factory
- WHEN the factory resolves a provider
- THEN it MUST fall back to `none` and log a warning
- AND MUST NOT throw or crash the caller

### Requirement: Local Provider is an Optional Dependency

A local/embedded provider (e.g. Transformers.js) MUST be loaded lazily only when selected and MUST NOT be a hard dependency of `packages/core`. It MUST NOT be a declared dependency at all (not even `optionalDependencies`) — pnpm installs optional dependencies by default, which would force the heavy ML library and its vulnerable transitive `protobufjs` onto every install, including those that never use local embeddings. Instead it is an undeclared, user-installed optional peer (`pnpm add @xenova/transformers`); when absent or failing to initialize, the provider MUST degrade to keyword-only without throwing.

#### Scenario: Local provider selected and installed

- GIVEN config/env selects the local provider id
- AND the optional local embedding package is installed
- WHEN the factory resolves a provider
- THEN it MUST lazily import the package and return a working `EmbeddingProvider`

#### Scenario: Local provider selected but not installed

- GIVEN config/env selects the local provider id
- AND the optional local embedding package is NOT installed (import fails)
- WHEN the factory resolves a provider
- THEN the load failure MUST be caught
- AND the factory MUST degrade to `none`
- AND a warning MUST be logged
- AND the caller MUST NOT throw or crash

#### Scenario: Local provider load throws at runtime

- GIVEN the local provider package is installed but throws during model init (e.g. missing model files, unsupported platform)
- WHEN the factory attempts to construct the provider
- THEN the error MUST be caught
- AND the factory MUST degrade to `none`
- AND the caller MUST proceed with keyword-only search

### Requirement: Action Bundle Excludes Local Provider

The GitHub Action's `@vercel/ncc` bundle MUST NOT include the local embedding provider's dependency tree. The Action MUST only be able to resolve `none` or an API-based provider.

#### Scenario: ncc build excludes local provider

- GIVEN the Action is built via `@vercel/ncc`
- WHEN the bundle is produced
- THEN the local provider's package MUST NOT appear in the bundled output
- AND selecting the local provider id in Action config MUST resolve to `none` (or a documented error), never attempt to load the excluded package

### Requirement: Batched Embedding Calls

When embedding multiple observations (e.g. backfill), the system MUST use `embedBatch` rather than issuing one `embed` call per item, subject to the provider's supported batch size.

#### Scenario: Backfill uses batching

- GIVEN N NULL-embedding observations to backfill with N > 1
- WHEN the backfill job embeds them
- THEN it MUST call `embedBatch` with groups of observations rather than N sequential `embed` calls
- AND MUST NOT exceed the provider's maximum batch size per call

### Requirement: Graceful Degradation on Provider/API Failure

If a configured provider's `embed`/`embedBatch` call fails (network error, rate limit, invalid credentials) at query time or during persistence, the system MUST catch the failure and continue without semantic ranking rather than throwing.

#### Scenario: Embed call fails during search

- GIVEN a provider is configured and active
- AND the query-time `embed` call throws or rejects
- WHEN `searchObservations` executes
- THEN the error MUST be caught
- AND the search MUST fall back to the keyword-only candidate set and ranking
- AND no error MUST propagate to the caller

#### Scenario: Embed call fails during observation save

- GIVEN a provider is configured and active
- AND the `embed` call for a new observation fails
- WHEN `saveObservation` executes
- THEN the observation MUST still be saved with a NULL embedding
- AND a warning MUST be logged
- AND the save MUST NOT throw

### Requirement: Stored Embedding Metadata

Every stored embedding MUST be associated with the provider id and dimension used to produce it, in addition to the embedding vector.

#### Scenario: New embedding stores provider and dimension

- GIVEN a provider with `dimension = D` and id `P` embeds an observation
- WHEN the embedding is persisted
- THEN the stored row MUST record provider id `P` and dimension `D` alongside the vector

### Requirement: Dimension-Mismatch Read Guard

Reads MUST ignore (exclude from the candidate set) any embedding row whose stored dimension does not match the active provider's current `dimension`. Rows with mismatched or missing provider/dimension metadata MUST NOT be treated as vector candidates and MUST NOT cause an error.

#### Scenario: Mixed-dimension rows present

- GIVEN the active provider has `dimension = 768`
- AND the observations table contains some rows embedded with a prior provider at `dimension = 384`
- WHEN a semantic search executes
- THEN rows with `dimension = 384` MUST be excluded from the cosine candidate set
- AND rows with `dimension = 768` MUST be eligible candidates
- AND excluded rows MAY still be returned via the keyword-only candidate path
- AND no error MUST be raised

#### Scenario: Provider changed since last backfill

- GIVEN the active provider id changes (e.g. `provider-a` to `provider-b`) with a different dimension
- WHEN search executes before re-backfill
- THEN all `provider-a` rows MUST be excluded from cosine candidates due to dimension mismatch
- AND search MUST still return results via the keyword-only candidate path
