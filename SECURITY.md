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

## Provider modes

- The runtime providers are `gateway`, `cli-bridge`, and `ollama`
- `ghagga login` stores a GitHub token and sets the provider to `gateway`. It does not grant a free model
- Legacy names (`github`, `anthropic`, `openai`, and the rest of that list) are remapped to `gateway` when read from saved config. Passing them explicitly fails

## Operational Guidance

- Use HTTPS for webhooks and dashboard callbacks
- Rotate `GITHUB_WEBHOOK_SECRET`, `STATE_SECRET`, and provider credentials if compromise is suspected
- See `docs/security.md` for architecture details and additional rationale
