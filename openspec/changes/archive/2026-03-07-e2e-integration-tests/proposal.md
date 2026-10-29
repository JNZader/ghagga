# Proposal: Integration Test Suites

**Change ID:** e2e-integration-tests
**Status:** accepted
**Created:** 2026-03-07

## Intent

Address audit finding #13: "No tests that validate the full flow webhook -> review pipeline -> post comment." The project has 1,967 unit tests with excellent coverage of individual modules, but zero integration tests that validate the wiring between components.

## Problem

Unit tests mock all dependencies, verifying each module in isolation. This leaves blind spots at integration boundaries:
- Webhook handler correctly dispatches to Inngest with the right payload shape
- Auth middleware properly gates API endpoints
- Core review pipeline correctly chains parse -> static analysis -> agent -> memory

These boundaries are where production bugs hide.

## Approach

Create **3 integration test suites** that test multi-component flows with mocked external services (GitHub API, AI providers). No real network calls — all external HTTP is mocked.
1. **Webhook -> Review Dispatch**: Full HTTP request through webhook handler, validating signature verification, event routing, and Inngest event dispatch.
2. **API Endpoints with Auth**: HTTP requests through API routes with simulated auth middleware, testing the auth-gated data flow.
3. **Core Review Pipeline**: Pipeline orchestrator with mocked AI providers and tools, testing the full parse -> analyze -> review -> memory flow.

## Scope

- 3 new test files (2 in `apps/server/src/__integration__/`, 1 in `packages/core/src/__integration__/`)
- No new dependencies — uses existing Vitest, `vi.mock`, and Hono's `app.request()` pattern
- Tests are additive — no changes to production code

## Risks

- **Low**: Integration tests may be slightly slower than unit tests (~100ms vs ~10ms each)
- **Mitigated**: No real network calls, all external services mocked

## Acceptance Criteria

- All 3 integration test suites pass
- Existing 1,967 unit tests still pass (no regressions)
- Each suite tests the happy path and at least 2 error/edge cases
- Tests are filterable by `describe('integration:')` naming convention
