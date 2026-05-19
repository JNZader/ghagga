# Security Policy

If you discover a security vulnerability, please do not open a public issue with exploit details.

## Reporting

- Open a private GitHub security advisory if you can
- Otherwise contact the maintainer through GitHub and include reproduction details, impact, and suggested remediation
- Please give reasonable time for triage and a fix before public disclosure

## Current Security Model

| Measure | Implementation |
|---------|----------------|
| API key encryption | AES-256-GCM at rest; keys are never stored in plaintext |
| Webhook verification | HMAC-SHA256 with `crypto.timingSafeEqual` |
| Installation scoping | API data is scoped by GitHub installation membership |
| Runner callback verification | HMAC-signed callbacks derived from `STATE_SECRET` |
| Privacy stripping | Secret-like values are redacted before memory persistence |
| No secret logging | Sensitive values are intentionally excluded from logs and error output |

## Authentication Notes

- Dashboard auth uses GitHub OAuth Web Flow
- CLI auth uses GitHub Device Flow via `ghagga login`
- Self-hosted/server dashboard auth requires `GITHUB_CLIENT_SECRET` and `STATE_SECRET`
- PAT fallback remains available when the dashboard cannot complete server-backed OAuth

## GitHub Models Notes

- In SaaS/server mode, GitHub Models requires a PAT with `models:read`
- GitHub App installation tokens do not have `models:read`, so a `github` provider entry without an explicit PAT is skipped at review time
- CLI and GitHub Action modes can use a GitHub token already controlled by the user or workflow

## Operational Guidance

- Use HTTPS for webhooks and dashboard callbacks
- Rotate `GITHUB_WEBHOOK_SECRET`, `STATE_SECRET`, and provider credentials if compromise is suspected
- See `docs/security.md` for architecture details and additional rationale
