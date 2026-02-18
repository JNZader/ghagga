/**
 * Privacy utilities for memory observations
 *
 * Strips sensitive data before persisting observations.
 * Pure functions, no side effects.
 */

/** Patterns for content that should be redacted */
const PRIVATE_TAG_REGEX = /<private>[\s\S]*?<\/private>/gi;
const API_KEY_PATTERNS: RegExp[] = [
  /sk-[a-zA-Z0-9]{20,}/g,       // OpenAI keys
  /ghp_[a-zA-Z0-9]{36,}/g,      // GitHub PATs
  /gho_[a-zA-Z0-9]{36,}/g,      // GitHub OAuth tokens
  /ghs_[a-zA-Z0-9]{36,}/g,      // GitHub App tokens
  /glpat-[a-zA-Z0-9\-_]{20,}/g, // GitLab PATs
  /xoxb-[a-zA-Z0-9\-]+/g,       // Slack bot tokens
  /xoxp-[a-zA-Z0-9\-]+/g,       // Slack user tokens
];
const EMAIL_REGEX = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g;

/**
 * Strip private/sensitive content from text.
 * - Removes <private>...</private> blocks
 * - Redacts API keys (sk-*, ghp_*, etc.)
 * - Redacts email addresses
 */
export function stripPrivacy(content: string): string {
  let stripped = content;

  // Remove <private> tagged content
  stripped = stripped.replace(PRIVATE_TAG_REGEX, '[REDACTED]');

  // Redact API keys
  for (const pattern of API_KEY_PATTERNS) {
    stripped = stripped.replace(pattern, '[REDACTED_KEY]');
  }

  // Redact emails
  stripped = stripped.replace(EMAIL_REGEX, '[REDACTED_EMAIL]');

  return stripped;
}

/**
 * Check if content contains potentially sensitive data.
 */
export function hasPrivateContent(content: string): boolean {
  PRIVATE_TAG_REGEX.lastIndex = 0;
  if (PRIVATE_TAG_REGEX.test(content)) return true;

  for (const pattern of API_KEY_PATTERNS) {
    pattern.lastIndex = 0;
    if (pattern.test(content)) return true;
  }

  EMAIL_REGEX.lastIndex = 0;
  if (EMAIL_REGEX.test(content)) return true;

  return false;
}
