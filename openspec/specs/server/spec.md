# Server Specification

> **Origin**: Archived from `ghagga-v2-rewrite` change, domain `server` (2026-03-07)
> **Last synced**: `reviews-by-day` change (2026-03-07) — added reviewsByDay daily aggregation requirement to /api/stats

## Purpose

The server is the Hono-based API backend that handles GitHub webhooks, serves the dashboard API, and orchestrates reviews via Inngest. It is one of four distribution adapters (server, CLI, Action, 1-click) that wrap the core review engine.

## Requirements

### Requirement: GitHub Webhook Reception

The system MUST receive and validate GitHub App webhook events.

#### Scenario: Valid pull_request.opened event

- GIVEN a properly signed webhook payload for event "pull_request" with action "opened"
- WHEN the webhook endpoint receives the request
- THEN the system MUST verify the HMAC-SHA256 signature using constant-time comparison
- AND the system MUST respond with HTTP 200 within 5 seconds
- AND the system MUST dispatch the review to Inngest for async processing

#### Scenario: Invalid webhook signature

- GIVEN a webhook payload with an incorrect or missing X-Hub-Signature-256 header
- WHEN the webhook endpoint receives the request
- THEN the system MUST respond with HTTP 401 Unauthorized
- AND the system MUST NOT process the event
- AND the system MUST log the rejected attempt

#### Scenario: Unsupported event type

- GIVEN a valid webhook for event "issues" (not pull_request)
- WHEN the webhook endpoint receives the request
- THEN the system MUST respond with HTTP 200 (acknowledge receipt)
- AND the system MUST NOT dispatch any review task

#### Scenario: PR only modifies ignored files

- GIVEN a PR that only changes files matching ignore patterns (e.g., `*.md`, `.gitignore`)
- WHEN the webhook is processed
- THEN the system MUST skip the review
- AND the system MUST respond with HTTP 200
- AND no Inngest event MUST be emitted

### Requirement: Installation Management

The system MUST handle GitHub App installation and uninstallation events.

#### Scenario: New installation

- GIVEN a webhook event "installation" with action "created"
- WHEN the event is processed
- THEN the system MUST save the installation record (installation_id, account_login, account_type)
- AND the system MUST create default repository configurations for all included repositories

#### Scenario: Installation deleted

- GIVEN a webhook event "installation" with action "deleted"
- WHEN the event is processed
- THEN the system MUST mark the installation as inactive
- AND the system MUST NOT delete existing review data (audit trail)

### Requirement: Async Review Processing via Inngest

The system MUST use Inngest for durable, async execution of the review pipeline.

#### Scenario: Review dispatched to Inngest

- GIVEN a valid PR webhook event
- WHEN the webhook handler dispatches the review
- THEN the system MUST emit an Inngest event with the PR data (owner, repo, PR number, diff URL, installation_id)
- AND the Inngest function MUST execute the core review pipeline
- AND each pipeline layer (static analysis, memory, agents, persistence) MUST be a separate Inngest step for checkpointing

#### Scenario: Inngest quota exceeded

- GIVEN the Inngest free tier limit (50k events) has been reached
- WHEN a new PR webhook arrives
- THEN the system MUST detect the quota error
- AND the system MUST fall back to a synchronous static-analysis-only review
- AND the PR comment MUST note "AI review unavailable (quota exceeded), showing static analysis results only"

#### Scenario: Inngest step retry on LLM failure

- GIVEN the agent LLM call fails with a 5xx error
- WHEN Inngest processes the retry
- THEN only the failed step MUST be retried (not the entire pipeline)
- AND the retry MUST use exponential backoff (max 3 retries)

### Requirement: Dashboard REST API

The system MUST expose REST endpoints for the dashboard frontend.

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
- AND the original plaintext key MUST NOT be stored or logged
- AND subsequent GET requests MUST NOT return the decrypted key (only a masked indicator like "sk-...xxxx")

### Requirement: Authentication

The system MUST authenticate dashboard API requests using GitHub OAuth tokens.

#### Scenario: Valid GitHub token

- GIVEN a request with a valid Bearer token in the Authorization header
- WHEN the auth middleware processes the request
- THEN the system MUST verify the token against GitHub's API
- AND extract the user's GitHub ID and installation access
- AND attach the user context to the request

#### Scenario: Missing or invalid token

- GIVEN a request without a Bearer token or with an expired token
- WHEN the auth middleware processes the request
- THEN the system MUST respond with HTTP 401 Unauthorized

### Requirement: GitHub PR Comment Posting

The system MUST post review results as comments on the GitHub Pull Request.

#### Scenario: Successful review comment

- GIVEN a completed review with status "FAILED" and 5 findings
- WHEN the comment is posted to GitHub
- THEN the comment MUST include: status badge, summary, findings table with severity/file/line/message
- AND static analysis findings MUST be in a separate section from AI findings
- AND the comment MUST be formatted as GitHub-flavored markdown

#### Scenario: Review passed with no findings

- GIVEN a completed review with status "PASSED" and 0 findings
- WHEN the comment is posted to GitHub
- THEN the comment MUST include a positive summary
- AND the comment SHOULD be concise (no empty findings table)

### Requirement: CORS Origin Restriction

The system MUST restrict Cross-Origin Resource Sharing to an explicit allowlist of origins. Requests from origins not on the allowlist MUST NOT receive CORS headers (the browser will block the request).

The default allowed origins MUST be:
- `https://jnzader.github.io` (dashboard)
- `https://api.javierzader.com` (same-origin API)

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

### Requirement: Middleware Execution Order

The middleware stack in `index.ts` MUST execute in the following order to ensure correct security behavior:

1. Global error handler (`app.onError`)
2. Request logging middleware
3. `secureHeaders` (MUST be first middleware so all responses, including early rejections, include security headers)
4. `bodyLimit` (1 MB default) (MUST reject oversized payloads before any further processing)
5. `cors` (restricted origins) (MUST run before route handlers to handle preflight requests)
6. Per-route rate limiters (MUST run before route handlers but after CORS to ensure preflight requests are not rate-limited)
7. Existing route mounts

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

### Requirement: Health Check

The system MUST expose a health check endpoint.

#### Scenario: Health check

- GIVEN the server is running
- WHEN GET /health is called
- THEN the response MUST return HTTP 200 with { "status": "ok" }
- AND the response SHOULD include database connectivity status

### Requirement: Reviews By Day Aggregation

> **Added by**: `reviews-by-day` change (2026-03-07)

The system MUST provide daily review aggregation data via the `/api/stats` endpoint.

A `getReviewsByDay` query function MUST:
- Query the `reviews` table grouped by `DATE(created_at)`
- Return entries for the last 30 days only
- Filter by `repository_id`
- Return shape: `{ date: string (YYYY-MM-DD), total: number, passed: number, failed: number }`
- Results MUST be sorted by date ascending (oldest first)
- Days with zero reviews SHOULD be omitted (sparse array)

The `GET /api/stats` endpoint MUST:
- Call `getReviewsByDay` with the resolved `repo.id`
- Return the result as `reviewsByDay` in the response data
- NOT modify any other fields in the stats response
- Match the dashboard's `DayStats` type exactly

#### Scenario: Repository with reviews in last 30 days

- GIVEN a repository with reviews on 2026-02-10 (2 PASSED, 1 FAILED) and 2026-02-12 (1 PASSED)
- WHEN `GET /api/stats?repo=owner/repo` is called
- THEN `reviewsByDay` contains entries for those dates with correct totals and breakdowns

#### Scenario: Repository with no reviews

- GIVEN a repository with zero reviews
- WHEN `GET /api/stats?repo=owner/repo` is called
- THEN `reviewsByDay` is `[]`

#### Scenario: Reviews older than 30 days excluded

- GIVEN a repository with reviews only from 60 days ago
- WHEN `GET /api/stats?repo=owner/repo` is called
- THEN `reviewsByDay` is `[]`

#### Scenario: Multiple reviews same day

- GIVEN 5 reviews on the same day (3 PASSED, 1 FAILED, 1 SKIPPED)
- WHEN `GET /api/stats?repo=owner/repo` is called
- THEN the day entry shows `total: 5, passed: 3, failed: 1`

#### Scenario: Ordering

- GIVEN reviews on dates 2026-03-05, 2026-03-01, 2026-03-03
- WHEN `GET /api/stats?repo=owner/repo` is called
- THEN `reviewsByDay` is ordered: 2026-03-01, 2026-03-03, 2026-03-05
