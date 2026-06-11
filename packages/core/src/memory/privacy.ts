/**
 * Privacy-safe text sanitization.
 *
 * Strips sensitive data (API keys, tokens, passwords) from text
 * before it gets persisted to memory. This ensures that even if
 * a diff contains credentials, they won't be stored in the database.
 */

// ─── Patterns ───────────────────────────────────────────────────

/**
 * Regex patterns for common secret formats.
 * Each pattern is paired with a human-readable replacement label.
 */
const SENSITIVE_PATTERNS: Array<{ pattern: RegExp; replacement: string }> = [
  // Anthropic API keys
  { pattern: /sk-ant-[a-zA-Z0-9_-]{20,}/g, replacement: '[REDACTED_ANTHROPIC_KEY]' },

  // OpenAI API keys (classic sk-... and newer sk-proj-... with internal hyphens)
  { pattern: /sk-[a-zA-Z0-9_-]{20,}/g, replacement: '[REDACTED_OPENAI_KEY]' },

  // AWS Access Key IDs
  { pattern: /AKIA[0-9A-Z]{16}/g, replacement: '[REDACTED_AWS_KEY]' },

  // AWS Secret Access Keys (typically 40 chars, base64-ish).
  // Supports `=` and `:` separators (env files vs YAML) and an optional
  // opening quote — the previous lookbehind broke on quoted values.
  {
    pattern: /(?<=AWS_SECRET_ACCESS_KEY\s*[:=]\s*['"]?)[A-Za-z0-9/+=]{40}/g,
    replacement: '[REDACTED_AWS_SECRET]',
  },

  // GitHub tokens (classic and fine-grained)
  { pattern: /ghp_[a-zA-Z0-9]{36,}/g, replacement: '[REDACTED_GITHUB_PAT]' },
  { pattern: /gho_[a-zA-Z0-9]{36,}/g, replacement: '[REDACTED_GITHUB_OAUTH]' },
  { pattern: /ghs_[a-zA-Z0-9]{36,}/g, replacement: '[REDACTED_GITHUB_APP]' },
  { pattern: /ghr_[a-zA-Z0-9]{36,}/g, replacement: '[REDACTED_GITHUB_REFRESH]' },
  { pattern: /github_pat_[a-zA-Z0-9_]{22,}/g, replacement: '[REDACTED_GITHUB_FINE_PAT]' },

  // GitLab personal access tokens
  { pattern: /glpat-[A-Za-z0-9_-]{20,}/g, replacement: '[REDACTED_GITLAB_PAT]' },

  // npm tokens
  { pattern: /npm_[A-Za-z0-9]{36,}/g, replacement: '[REDACTED_NPM_TOKEN]' },

  // Stripe secret/restricted keys (sk_live_, sk_test_, rk_live_, rk_test_)
  { pattern: /(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{16,}/g, replacement: '[REDACTED_STRIPE_KEY]' },

  // Stripe webhook signing secrets
  { pattern: /whsec_[A-Za-z0-9]{16,}/g, replacement: '[REDACTED_STRIPE_WEBHOOK_SECRET]' },

  // Hugging Face tokens
  { pattern: /hf_[A-Za-z0-9]{30,}/g, replacement: '[REDACTED_HF_TOKEN]' },

  // SendGrid API keys (SG.<id>.<secret>)
  {
    pattern: /SG\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}/g,
    replacement: '[REDACTED_SENDGRID_KEY]',
  },

  // Google API keys
  { pattern: /AIza[0-9A-Za-z_-]{35}/g, replacement: '[REDACTED_GOOGLE_KEY]' },

  // Slack tokens (bot/user/app-level: xoxb-, xoxp-, xoxa-, xapp-, etc.)
  { pattern: /(?:xox[abpors]|xapp)-[0-9a-zA-Z-]{10,}/g, replacement: '[REDACTED_SLACK_TOKEN]' },

  // Generic Bearer tokens in headers
  { pattern: /Bearer\s+[a-zA-Z0-9._-]{20,}/gi, replacement: 'Bearer [REDACTED_TOKEN]' },

  // Generic "password" / "secret" / "token" assignments
  // Matches: password = "...", PASSWORD: "...", secret: '...', token='...'
  {
    pattern: /(?<=(password|secret|token|api_key|apikey|api-key)\s*[:=]\s*['"])[^'"]{8,}(?=['"])/gi,
    replacement: '[REDACTED]',
  },

  // Base64-encoded strings that look like they could be secrets (64+ chars)
  // Only match when preceded by common secret-related variable names
  {
    pattern:
      /(?<=(SECRET|KEY|TOKEN|CREDENTIAL|PASSWORD)\s*[:=]\s*['"]?)[A-Za-z0-9+/]{64,}={0,2}(?=['"]?)/gi,
    replacement: '[REDACTED_BASE64]',
  },

  // Private keys (PEM format). Broad label match covers RSA/EC/DSA as well as
  // OPENSSH, PKCS8 ("PRIVATE KEY"), ENCRYPTED, and PGP ("PRIVATE KEY BLOCK")
  // variants — the previous allowlist (RSA|EC|DSA) let modern formats through.
  //
  // The between-markers span is BOUNDED to {0,8192} (was an unbounded
  // `[\s\S]*?`). A real PEM body is a few KB at most; an UNTERMINATED header
  // in a large diff would otherwise make the lazy match scan all the way to
  // EOF before failing. The bound makes an unterminated header fail fast while
  // still covering every legitimate key. (4096-bit RSA PEM ≈ 3.2KB.)
  {
    pattern:
      /-----BEGIN [A-Z0-9 ]*PRIVATE KEY(?: BLOCK)?-----[\s\S]{0,8192}?-----END [A-Z0-9 ]*PRIVATE KEY(?: BLOCK)?-----/g,
    replacement: '[REDACTED_PRIVATE_KEY]',
  },

  // JWT tokens (three base64url segments separated by dots)
  {
    pattern: /eyJ[a-zA-Z0-9_-]{10,}\.eyJ[a-zA-Z0-9_-]{10,}\.[a-zA-Z0-9_-]{10,}/g,
    replacement: '[REDACTED_JWT]',
  },

  // Unquoted `.env`-style assignments: SECRET=..., DB_PASSWORD: ..., MY_API_KEY=...
  // Key part is case-insensitive; only the value is redacted. The 8-char floor
  // and the (?!\[REDACTED) guard (don't re-redact labels already inserted by
  // earlier, more specific patterns) keep false positives down.
  {
    pattern:
      /(?<=(?:SECRET|TOKEN|PASSWORD|API_?KEY|CREDENTIAL)[A-Z0-9_]*\s*[:=]\s*['"]?)(?!\[REDACTED)[^\s'"]{8,}/gi,
    replacement: '[REDACTED]',
  },

  // Passwords embedded in URL userinfo: https://user:pass@host/...
  // Redacts only the password portion, preserving scheme, user, and host.
  {
    pattern: /(?<=:\/\/[^:/\s]+:)[^@\s]+(?=@)/g,
    replacement: '[REDACTED_URL_PASSWORD]',
  },
];

// ─── Main Function ──────────────────────────────────────────────

/**
 * Strip sensitive data from text before persisting to memory.
 *
 * Applies all known secret patterns and replaces matches with
 * human-readable redaction labels. The patterns are applied in
 * order, so more specific patterns take precedence.
 *
 * @param text - The text to sanitize
 * @returns Sanitized text with secrets replaced by redaction labels
 */
export function stripPrivateData(text: string): string {
  let sanitized = text;

  for (const { pattern, replacement } of SENSITIVE_PATTERNS) {
    // Reset regex lastIndex for each application (since we use /g flag)
    pattern.lastIndex = 0;
    sanitized = sanitized.replace(pattern, replacement);
  }

  return sanitized;
}
