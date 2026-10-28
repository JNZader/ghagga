# Proposal: Server Hardening

## Intent

Harden the Hono server against common web security vulnerabilities identified in the v2.2.0 audit. The server currently runs with permissive defaults — open CORS, no rate limiting, no security headers, no body size limits — exposing it to abuse, CSRF, clickjacking, and denial-of-service attacks. This change bundles four related security fixes that should ship together as a single hardening pass.

## Scope

### In Scope

1. **CORS restriction (CRITICAL)** — Replace the permissive `cors()` call in `apps/server/src/index.ts:74` with an origin allowlist. Currently `app.use('*', cors())` accepts requests from any origin. Restrict to known origins (`https://jnzader.github.io` for the dashboard, `https://ghagga.onrender.com` for same-origin, plus `localhost` variants in development). Use an `ALLOWED_ORIGINS` environment variable (comma-separated) for deployment flexibility, with sensible production defaults hardcoded as fallback.

2. **Rate limiting (CRITICAL)** — Add rate limiting middleware to all route groups. Currently there is zero rate limiting across `apps/server/src/routes/api.ts`, `apps/server/src/routes/oauth.ts`, and `apps/server/src/routes/webhook.ts`. Apply per-IP limits:
   - API endpoints (`/api/*`): 100 requests/minute
   - OAuth endpoints (`/auth/*`): 10 requests/minute
   - Webhook endpoint (`/webhook`): 200 requests/minute (GitHub sends bursts during CI)
   - Use `x-forwarded-for` as the key generator (Render deploys behind a reverse proxy)
   - New dependency: `hono-rate-limiter`

3. **Security headers (MEDIUM)** — Add Hono's built-in `secureHeaders` middleware in `apps/server/src/index.ts`. This adds Content-Security-Policy, X-Frame-Options (DENY), X-Content-Type-Options (nosniff), Strict-Transport-Security (HSTS), and other standard headers. Currently no security headers are set.

4. **Body size limit (MEDIUM)** — Add Hono's built-in `bodyLimit` middleware in `apps/server/src/index.ts`. Default limit: 1 MB for all routes. The webhook endpoint needs a larger limit (5 MB) because GitHub payloads for large PRs can exceed 1 MB. Currently there is no body size validation — an attacker could send arbitrarily large payloads.

### Out of Scope

- PEM key cleanup from git history (separate sensitive-data remediation)
- Linting/formatting setup (separate DX change)
- CI security scanning integration (separate change)
- `console.error` to logger migration in `oauth.ts:207-208,221` (trivial, can be done inline)
- OAuth `GITHUB_CLIENT_ID` to env var (trivial, can be done inline)
- Redis-backed rate limiting store (future enhancement — in-memory is acceptable for current scale)

## Approach

All changes are confined to `apps/server/` — no modifications to `ghagga-core`, `ghagga-db`, `ghagga-cli`, the GitHub Action, or the dashboard.

**Middleware stack order** in `apps/server/src/index.ts` (top to bottom):
1. Global error handler (`app.onError`) — already exists
2. Request logging middleware — already exists
3. `secureHeaders()` — **new** (Hono built-in)
4. `bodyLimit({ maxSize: 1 * 1024 * 1024 })` — **new** (Hono built-in, default)
5. `cors({ origin: [...] })` — **modified** (restrict origins)
6. Rate limiting — **new** (applied per-route-group, not globally)
7. Existing route mounts (webhook, oauth, inngest, runner-callback, api)

**Per-route rate limiting** is applied as middleware on each route group rather than globally, because limits differ by endpoint type.

**Implementation details:**
- Use Hono's built-in `cors()` with the `origin` option set to a function that checks against the allowlist
- Use Hono's built-in `secureHeaders()` with default settings (CSP, X-Frame-Options DENY, nosniff, HSTS)
- Use Hono's built-in `bodyLimit()` — global 1 MB default, override to 5 MB on the webhook route
- Use `hono-rate-limiter` for rate limiting with in-memory store
- Parse `ALLOWED_ORIGINS` env var at startup, fall back to hardcoded production origins
- Return standard HTTP status codes: 429 for rate limit exceeded, 413 for body too large

## Affected Areas

| Area                                | Impact   | Description                                                                  |
| ----------------------------------- | -------- | ---------------------------------------------------------------------------- |
| `apps/server/src/index.ts`          | Modified | Add `secureHeaders`, `bodyLimit`, modify `cors()` config, wire rate limiters |
| `apps/server/src/routes/api.ts`     | Modified | Add rate limiting middleware (100 req/min)                                   |
| `apps/server/src/routes/oauth.ts`   | Modified | Add rate limiting middleware (10 req/min)                                    |
| `apps/server/src/routes/webhook.ts` | Modified | Add rate limiting middleware (200 req/min), override body limit to 5 MB      |
| `apps/server/package.json`          | Modified | Add `hono-rate-limiter` dependency                                           |
| `apps/server/src/__tests__/`        | New      | Tests for CORS, rate limiting, security headers, body limit                  |
| `.env.example`                      | Modified | Document `ALLOWED_ORIGINS` env var                                           |

## Risks

| Risk                                                              | Likelihood | Mitigation                                                                                                                                 |
| ----------------------------------------------------------------- | ---------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| In-memory rate limit store resets on Render deploy/restart        | High       | Acceptable for current scale. Attacker window is brief (cold start). Document Redis upgrade path for future.                               |
| Webhook rate limit too aggressive blocks legitimate GitHub bursts | Medium     | Use generous limit (200/min). GitHub webhook delivery retries on failure. Monitor after deploy.                                            |
| CORS restriction breaks dashboard if URL changes                  | Low        | `ALLOWED_ORIGINS` env var allows runtime override without code change.                                                                     |
| `bodyLimit` rejects legitimate large webhook payloads             | Low        | 5 MB limit for `/webhook` is generous. GitHub's max payload is ~25 MB but typical PR payloads are well under 5 MB. Can increase if needed. |
| `secureHeaders` CSP breaks Inngest dashboard UI                   | Low        | Inngest serves its own UI — its endpoint at `/api/inngest` returns JSON, not HTML. CSP only affects browser rendering.                     |

## Rollback Plan

All changes are additive middleware in `apps/server/`. To rollback:
1. Revert `apps/server/src/index.ts` to restore `app.use('*', cors())` and remove `secureHeaders`/`bodyLimit` imports
2. Revert route files to remove rate limiting middleware
3. Remove `hono-rate-limiter` from `apps/server/package.json`
4. Remove `ALLOWED_ORIGINS` from `.env` / environment config
5. Redeploy

Partial rollback is also possible: each of the 4 fixes is independent middleware that can be removed without affecting the others.

## Dependencies

- `hono-rate-limiter` — npm package for Hono-compatible rate limiting middleware (new dependency)
- Hono built-in middlewares: `secureHeaders`, `bodyLimit` — already available in `hono ^4.7.0` (current dependency)

## Success Criteria

- [ ] CORS only allows configured origins — `curl` from an unlisted origin receives no `Access-Control-Allow-Origin` header
- [ ] Rate limiting returns HTTP 429 with `Retry-After` header when limits are exceeded
- [ ] Security headers (`X-Frame-Options`, `X-Content-Type-Options`, `Strict-Transport-Security`, `Content-Security-Policy`) are present in all responses
- [ ] Body payloads over the configured limit return HTTP 413
- [ ] Webhook endpoint accepts payloads up to 5 MB
- [ ] `ALLOWED_ORIGINS` env var is respected at startup (comma-separated list)
- [ ] All existing tests pass (`pnpm --filter @ghagga/server test`)
- [ ] New tests cover each middleware: CORS blocking, rate limit 429, security header presence, body limit 413
- [ ] Dashboard (`https://jnzader.github.io`) can still make API calls after CORS restriction
- [ ] GitHub webhook delivery continues to work after rate limit + body limit are applied
