# Tasks: Server Hardening

> **Change**: server-hardening
> **Spec**: `openspec/changes/server-hardening/spec.md`
> **Design**: Skipped — standard Hono middleware, no architectural decisions needed.

All work is in `apps/server/`. Tests are co-located (`*.test.ts` beside source files).

---

## Phase 1: Dependencies & Setup

- [x] **1.1** Install `hono-rate-limiter` dependency
  - Run `pnpm --filter @ghagga/server add hono-rate-limiter`
  - Verify it appears in `apps/server/package.json` under `dependencies`
  - **Satisfies**: R2 (Rate Limiting) — prerequisite
  - **Files**: `apps/server/package.json`, `pnpm-lock.yaml`
  - **Effort**: 5 min
  - **Dependencies**: None

---

## Phase 2: Security Headers Middleware

- [x] **2.1** Add `secureHeaders` middleware to `apps/server/src/index.ts`
  - Import `secureHeaders` from `hono/secure-headers`
  - Add `app.use('*', secureHeaders())` immediately after the request logging middleware (before `cors()`)
  - This is a Hono built-in — no new dependency required
  - **Satisfies**: R3 (Security Headers) — `X-Frame-Options: DENY`, `X-Content-Type-Options: nosniff`, `Strict-Transport-Security`, `Content-Security-Policy: default-src 'self'`, `Referrer-Policy`
  - **Files**: `apps/server/src/index.ts`
  - **Effort**: 10 min
  - **Dependencies**: None

- [x] **2.2** Write tests for security headers
  - Create `apps/server/src/middleware/secure-headers.test.ts`
  - Test scenarios from spec:
    - API response includes all 5 security headers (spec: "API response includes security headers")
    - Webhook response includes all security headers (spec: "Webhook response includes security headers")
    - Error response (500) still includes all security headers (spec: "Error response includes security headers")
  - Create a minimal Hono app with `secureHeaders()` + test routes to verify header presence
  - **Satisfies**: R3 (Security Headers) — all 3 scenarios
  - **Files**: `apps/server/src/middleware/secure-headers.test.ts` (new)
  - **Effort**: 20 min
  - **Dependencies**: 2.1

---

## Phase 3: Body Size Limit

- [x] **3.1** Add `bodyLimit` middleware to `apps/server/src/index.ts`
  - Import `bodyLimit` from `hono/body-limit`
  - Add global `app.use('*', bodyLimit({ maxSize: 1 * 1024 * 1024 }))` after `secureHeaders()`, before `cors()`
  - Add route-specific override: `app.use('/webhook', bodyLimit({ maxSize: 5 * 1024 * 1024 }))` before the webhook route mount — or apply directly in the webhook router
  - Verify that Hono returns HTTP 413 when the limit is exceeded
  - **Satisfies**: R4 (Body Size Limit) — 1 MB default, 5 MB webhook override
  - **Files**: `apps/server/src/index.ts`
  - **Effort**: 15 min
  - **Dependencies**: 2.1 (secureHeaders must be placed first to establish correct middleware order)

- [x] **3.2** Write tests for body size limit
  - Create `apps/server/src/middleware/body-limit.test.ts`
  - Test scenarios from spec:
    - Normal-sized API payload (10 KB) passes through (spec: "Normal-sized API payload passes through")
    - Oversized API payload (2 MB) returns HTTP 413 (spec: "Oversized API payload is rejected")
    - Webhook payload up to 5 MB passes through (spec: "Webhook payload up to 5 MB passes through")
    - Webhook payload over 5 MB returns HTTP 413 (spec: "Webhook payload over 5 MB is rejected")
  - Create a minimal Hono app with `bodyLimit()` + test routes with different limits
  - **Satisfies**: R4 (Body Size Limit) — all 4 scenarios
  - **Files**: `apps/server/src/middleware/body-limit.test.ts` (new)
  - **Effort**: 25 min
  - **Dependencies**: 3.1

---

## Phase 4: CORS Restriction

- [x] **4.1** Replace open `cors()` with restricted CORS configuration in `apps/server/src/index.ts`
  - Parse `ALLOWED_ORIGINS` env var (comma-separated) at startup
  - Define default origins: `https://jnzader.github.io`, `https://ghagga.onrender.com`
  - When `NODE_ENV === 'development'`, add `http://localhost:3000` and `http://localhost:5173` to defaults
  - When `ALLOWED_ORIGINS` is set, use those values instead of defaults (full replacement)
  - Replace `app.use('*', cors())` at line 74 with `app.use('*', cors({ origin: (origin) => { ... }, credentials: true }))`
  - The origin function returns the origin if it's in the allowlist, or `null`/`undefined` to deny
  - **Satisfies**: R1 (CORS Origin Restriction) — all origin logic + credentials
  - **Files**: `apps/server/src/index.ts`
  - **Effort**: 20 min
  - **Dependencies**: 3.1 (bodyLimit must be placed before cors in middleware order)

- [x] **4.2** Write tests for CORS restriction
  - Create `apps/server/src/middleware/cors.test.ts`
  - Test scenarios from spec:
    - Request from allowed origin gets `Access-Control-Allow-Origin` + `Access-Control-Allow-Credentials: true` (spec: "Request from allowed origin")
    - Request from non-allowed origin gets no `Access-Control-Allow-Origin` header (spec: "Request from non-allowed origin")
    - Preflight OPTIONS request from allowed origin returns 204 with correct headers (spec: "Preflight OPTIONS request from allowed origin")
    - `ALLOWED_ORIGINS` env var overrides defaults — custom origin allowed, default origin blocked (spec: "ALLOWED_ORIGINS env var overrides defaults")
    - Dev mode (`NODE_ENV=development`) allows localhost origins (spec: "Dev mode allows localhost origins")
  - **Satisfies**: R1 (CORS Origin Restriction) — all 5 scenarios
  - **Files**: `apps/server/src/middleware/cors.test.ts` (new)
  - **Effort**: 30 min
  - **Dependencies**: 4.1

---

## Phase 5: Rate Limiting

- [x] **5.1** Create rate limiter middleware configuration
  - Create `apps/server/src/middleware/rate-limit.ts` with factory functions for each route group:
    - `apiRateLimiter` — 100 requests/min per IP for `/api/*`
    - `oauthRateLimiter` — 10 requests/min per IP for `/auth/*`
    - `webhookRateLimiter` — 200 requests/min per IP for `/webhook`
  - Use `hono-rate-limiter` with in-memory store
  - Configure key generator to use `x-forwarded-for` header (Render reverse proxy)
  - Configure 429 response to include `Retry-After` header with seconds until reset
  - Apply rate limiters in `apps/server/src/index.ts` per-route-group (after CORS, before route handlers):
    - `app.use('/api/*', apiRateLimiter)` — before authMiddleware
    - `app.use('/auth/*', oauthRateLimiter)` — before oauth routes
    - `app.use('/webhook', webhookRateLimiter)` — before webhook routes
  - **Satisfies**: R2 (Rate Limiting) — all limits, x-forwarded-for, 429 + Retry-After
  - **Files**: `apps/server/src/middleware/rate-limit.ts` (new), `apps/server/src/index.ts`
  - **Effort**: 30 min
  - **Dependencies**: 1.1, 4.1 (rate limiters go after CORS in middleware order)

- [x] **5.2** Write tests for rate limiting
  - Create `apps/server/src/middleware/rate-limit.test.ts`
  - Test scenarios from spec:
    - Request under rate limit passes through normally (spec: "Request under rate limit passes through")
    - 101st request to `/api/*` within 1 minute returns 429 (spec: "Request exceeding rate limit returns 429")
    - Different IPs tracked separately — one IP at limit doesn't block another (spec: "Different IPs tracked separately")
    - Webhook endpoint allows 200 req/min — 151st request still passes (spec: "Webhook endpoint has higher rate limit")
    - 429 response includes `Retry-After` header with value > 0 (spec: "Retry-After header is present on 429 responses")
  - Use a test Hono app with rate limiter middleware to fire rapid requests
  - **Satisfies**: R2 (Rate Limiting) — all 5 scenarios
  - **Files**: `apps/server/src/middleware/rate-limit.test.ts` (new)
  - **Effort**: 35 min
  - **Dependencies**: 5.1

---

## Phase 6: Integration & Verification

- [x] **6.1** Verify middleware order in `apps/server/src/index.ts`
  - Review the final state of `index.ts` and confirm middleware is registered in the correct order:
    1. `app.onError(...)` — global error handler (existing)
    2. `app.use('*', ...)` — request logging (existing)
    3. `app.use('*', secureHeaders())` — security headers (new)
    4. `app.use('*', bodyLimit({ maxSize: 1MB }))` — body limit default (new)
    5. `app.use('*', cors({ origin: ..., credentials: true }))` — restricted CORS (modified)
    6. Per-route rate limiters (new)
    7. Route mounts (existing)
  - Verify spec scenario: "Oversized payload rejected before CORS processing" — 413 response must still include security headers
  - Verify spec scenario: "Rate-limited request still has security headers and CORS" — 429 response must include both
  - **Satisfies**: R5 (Middleware Execution Order) — both cross-cutting scenarios
  - **Files**: `apps/server/src/index.ts` (review/adjust only)
  - **Effort**: 15 min
  - **Dependencies**: 5.1 (all middleware must be in place)

- [x] **6.2** Run full test suite, fix any regressions
  - Run `pnpm --filter @ghagga/server test` to execute all existing + new tests
  - Fix any regressions caused by the new middleware (likely: existing tests that don't set `Origin` headers may fail CORS checks — update test helpers if needed)
  - Ensure all tests pass cleanly
  - **Satisfies**: All requirements — regression check
  - **Files**: Any test file that needs updates for CORS compatibility
  - **Effort**: 20 min
  - **Dependencies**: 6.1

- [x] **6.3** Run Stryker mutation tests on new middleware code
  - Run `pnpm --filter @ghagga/server test:mutate` targeting new files:
    - `apps/server/src/middleware/rate-limit.ts`
    - CORS logic in `apps/server/src/index.ts`
  - Target mutation score > 80% for new code
  - If score is below 80%, add missing test cases to kill surviving mutants
  - **Satisfies**: Quality gate — mutation testing
  - **Files**: Stryker config (if scope needs adjusting), test files (if gaps found)
  - **Effort**: 25 min
  - **Dependencies**: 6.2

---

## Summary

| Phase     | Tasks  | Focus                      | Spec Requirements |
| --------- | ------ | -------------------------- | ----------------- |
| Phase 1   | 1      | Dependencies & Setup       | R2 (prerequisite) |
| Phase 2   | 2      | Security Headers           | R3                |
| Phase 3   | 2      | Body Size Limit            | R4                |
| Phase 4   | 2      | CORS Restriction           | R1                |
| Phase 5   | 2      | Rate Limiting              | R2                |
| Phase 6   | 3      | Integration & Verification | R5, all           |
| **Total** | **12** |                            |                   |

## Dependency Graph

```
1.1 (install dep) ─────────────────────────────┐
                                                ▼
2.1 (secureHeaders) → 2.2 (tests)         5.1 (rate-limit) → 5.2 (tests)
        │                                       ▲
        ▼                                       │
3.1 (bodyLimit) → 3.2 (tests)                   │
        │                                       │
        ▼                                       │
4.1 (cors) → 4.2 (tests) ──────────────────────┘
                                                │
                                                ▼
                                    6.1 (verify order)
                                                │
                                                ▼
                                    6.2 (full test suite)
                                                │
                                                ▼
                                    6.3 (mutation tests)
```

## Estimated Total Effort

~4 hours (suitable for 1–2 implementation sessions)
