# Delta for Server

> **Change**: server-hardening
> **Base spec**: `openspec/specs/server/spec.md`

## ADDED Requirements

### Requirement: CORS Origin Restriction

The system MUST restrict Cross-Origin Resource Sharing to an explicit allowlist of origins. Requests from origins not on the allowlist MUST NOT receive CORS headers (the browser will block the request).

The default allowed origins MUST be:
- `https://jnzader.github.io` (dashboard)
- `https://ghagga.onrender.com` (same-origin API)

When `NODE_ENV` is `development`, the system MUST additionally allow:
- `http://localhost:3000`
- `http://localhost:5173`

The allowlist MUST be configurable via the `ALLOWED_ORIGINS` environment variable (comma-separated). When `ALLOWED_ORIGINS` is set, its value MUST replace the default origins entirely.

The CORS middleware MUST set `credentials: true` to allow cookies and authorization headers.

#### Scenario: Request from allowed origin

- GIVEN the server is running with default configuration
- WHEN a request arrives with `Origin: https://jnzader.github.io`
- THEN the response MUST include `Access-Control-Allow-Origin: https://jnzader.github.io`
- AND the response MUST include `Access-Control-Allow-Credentials: true`

#### Scenario: Request from non-allowed origin

- GIVEN the server is running with default configuration
- WHEN a request arrives with `Origin: https://evil.example.com`
- THEN the response MUST NOT include any `Access-Control-Allow-Origin` header
- AND the browser MUST block the cross-origin response

#### Scenario: Preflight OPTIONS request from allowed origin

- GIVEN the server is running with default configuration
- WHEN an OPTIONS preflight request arrives with `Origin: https://jnzader.github.io`
- THEN the response MUST return HTTP 204
- AND the response MUST include `Access-Control-Allow-Origin: https://jnzader.github.io`
- AND the response MUST include `Access-Control-Allow-Methods` with the allowed methods
- AND the response MUST include `Access-Control-Allow-Credentials: true`

#### Scenario: ALLOWED_ORIGINS env var overrides defaults

- GIVEN the environment variable `ALLOWED_ORIGINS` is set to `https://custom.example.com,https://other.example.com`
- WHEN a request arrives with `Origin: https://custom.example.com`
- THEN the response MUST include `Access-Control-Allow-Origin: https://custom.example.com`
- AND a request with `Origin: https://jnzader.github.io` MUST NOT receive CORS headers (default replaced)

#### Scenario: Dev mode allows localhost origins

- GIVEN `NODE_ENV` is `development` and `ALLOWED_ORIGINS` is not set
- WHEN a request arrives with `Origin: http://localhost:5173`
- THEN the response MUST include `Access-Control-Allow-Origin: http://localhost:5173`

---

### Requirement: Rate Limiting

The system MUST enforce per-IP rate limits on all route groups to prevent abuse and denial-of-service attacks.

Rate limits per route group:
- `/api/*` endpoints: 100 requests per minute per IP
- `/auth/*` endpoints (OAuth): 10 requests per minute per IP
- `/webhook` endpoint: 200 requests per minute per IP

The rate limiter MUST use the `x-forwarded-for` header to identify the client IP (the server runs behind a reverse proxy on Render).

When a client exceeds the rate limit, the system MUST respond with HTTP 429 Too Many Requests and MUST include a `Retry-After` header indicating seconds until the limit resets.

The rate limiter MAY use an in-memory store. In-memory state resets on server restart; this is acceptable for a single-instance deployment.

#### Scenario: Request under rate limit passes through

- GIVEN a client IP has made fewer than 100 requests to `/api/*` in the current minute
- WHEN the client sends another request to `/api/reviews`
- THEN the request MUST be processed normally
- AND the response status MUST NOT be 429

#### Scenario: Request exceeding rate limit returns 429

- GIVEN a client IP has made 100 requests to `/api/*` within the current minute
- WHEN the client sends the 101st request to `/api/reviews`
- THEN the response MUST be HTTP 429 Too Many Requests
- AND the response MUST include a `Retry-After` header with the number of seconds until the limit resets

#### Scenario: Different IPs tracked separately

- GIVEN client IP `1.2.3.4` has made 100 requests to `/api/*` (limit reached)
- AND client IP `5.6.7.8` has made 0 requests to `/api/*`
- WHEN client `5.6.7.8` sends a request to `/api/reviews`
- THEN the request MUST be processed normally (not blocked by the other IP's limit)

#### Scenario: Webhook endpoint has higher rate limit

- GIVEN a client IP has made 150 requests to `/webhook` within the current minute
- WHEN the client sends the 151st request to `/webhook`
- THEN the request MUST be processed normally (under 200 limit)

#### Scenario: Retry-After header is present on 429 responses

- GIVEN a client IP has exceeded the rate limit for any route group
- WHEN the next request from that IP arrives
- THEN the response MUST be HTTP 429
- AND the response MUST include a `Retry-After` header with a value greater than 0

---

### Requirement: Security Headers

The system MUST include standard security headers in all HTTP responses using Hono's built-in `secureHeaders` middleware.

The following headers MUST be present:
- `X-Frame-Options: DENY`
- `X-Content-Type-Options: nosniff`
- `Strict-Transport-Security` with `includeSubDomains` directive
- `Content-Security-Policy: default-src 'self'`
- `Referrer-Policy: strict-origin-when-cross-origin`

These headers MUST be applied to all responses, including error responses and non-JSON responses.

#### Scenario: API response includes security headers

- GIVEN the server is running
- WHEN a request to `GET /api/reviews?repo=owner/repo` returns a response
- THEN the response MUST include `X-Frame-Options: DENY`
- AND the response MUST include `X-Content-Type-Options: nosniff`
- AND the response MUST include a `Strict-Transport-Security` header with `includeSubDomains`
- AND the response MUST include `Content-Security-Policy: default-src 'self'`
- AND the response MUST include `Referrer-Policy: strict-origin-when-cross-origin`

#### Scenario: Webhook response includes security headers

- GIVEN the server is running
- WHEN a valid webhook POST to `/webhook` returns a response
- THEN the response MUST include all security headers (`X-Frame-Options`, `X-Content-Type-Options`, `Strict-Transport-Security`, `Content-Security-Policy`, `Referrer-Policy`)

#### Scenario: Error response includes security headers

- GIVEN the server is running
- WHEN a request triggers an error (e.g., HTTP 500 from the global error handler)
- THEN the error response MUST still include all security headers

---

### Requirement: Request Body Size Limit

The system MUST enforce a maximum request body size to prevent denial-of-service via oversized payloads.

The default body size limit MUST be 1 MB for all endpoints.

The webhook endpoint (`/webhook`) MUST allow a higher limit of 5 MB, because GitHub payloads for large pull requests can exceed 1 MB.

When a request body exceeds the configured limit, the system MUST respond with HTTP 413 Payload Too Large. The `Content-Length` header SHOULD be checked before reading the full body.

#### Scenario: Normal-sized API payload passes through

- GIVEN a client sends a PUT request to `/api/settings` with a 10 KB JSON body
- WHEN the body limit middleware processes the request
- THEN the request MUST be processed normally

#### Scenario: Oversized API payload is rejected

- GIVEN a client sends a POST request to `/api/providers/validate` with a 2 MB body
- WHEN the body limit middleware processes the request
- THEN the response MUST be HTTP 413 Payload Too Large
- AND the request handler MUST NOT receive the oversized body

#### Scenario: Webhook payload up to 5 MB passes through

- GIVEN GitHub sends a webhook POST to `/webhook` with a 3 MB payload (large PR diff)
- WHEN the body limit middleware processes the request
- THEN the request MUST be processed normally (under the 5 MB webhook limit)

#### Scenario: Webhook payload over 5 MB is rejected

- GIVEN a client sends a POST to `/webhook` with a 6 MB body
- WHEN the body limit middleware processes the request
- THEN the response MUST be HTTP 413 Payload Too Large

---

## MODIFIED Requirements

### Requirement: Middleware Execution Order

The middleware stack in `index.ts` MUST execute in the following order to ensure correct security behavior:
1. Global error handler (`app.onError`) — unchanged
2. Request logging middleware — unchanged
3. `secureHeaders` — **new** (MUST be first middleware so all responses, including early rejections, include security headers)
4. `bodyLimit` (1 MB default) — **new** (MUST reject oversized payloads before any further processing)
5. `cors` (restricted origins) — **modified** (MUST run before route handlers to handle preflight requests)
6. Per-route rate limiters — **new** (MUST run before route handlers but after CORS to ensure preflight requests are not rate-limited)
7. Existing route mounts — unchanged

(Previously: the only middleware between logging and routes was an unrestricted `app.use('*', cors())` at line 74.)

#### Scenario: Oversized payload rejected before CORS processing

- GIVEN a request with `Origin: https://jnzader.github.io` and a 2 MB body to a non-webhook endpoint
- WHEN the middleware stack processes the request
- THEN the body limit middleware MUST reject it with HTTP 413
- AND the response MUST still include security headers (secureHeaders ran first)

#### Scenario: Rate-limited request still has security headers and CORS

- GIVEN a client that has exceeded the rate limit
- WHEN the next request arrives
- THEN the 429 response MUST include security headers
- AND the 429 response MUST include appropriate CORS headers (if the origin is allowed)
